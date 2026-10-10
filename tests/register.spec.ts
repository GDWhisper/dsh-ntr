import { describe, expect, it, vi } from 'vitest'
import { apply, inject, name } from '../src/index.ts'

function fakeCtx() {
  return {
    webServer: {},
    connection: {
      rpc: { handle: vi.fn(() => () => Promise.resolve()) },
      fetch: { register: vi.fn(() => () => Promise.resolve()) },
    },
    effect: vi.fn((fn: unknown) => {
      if (typeof fn === 'function') (fn as () => unknown)()
      return fn
    }),
  } as unknown as {
    webServer: object
    connection: { rpc: { handle: ReturnType<typeof vi.fn> }; fetch: { register: ReturnType<typeof vi.fn> } }
    effect: ReturnType<typeof vi.fn>
  }
}

describe('host plugin contract', () => {
  it('exports Cordis loader metadata', () => {
    expect(name).toBe('dsh-ntr')
    expect(inject).toEqual(['webServer', 'connection'])
    expect(typeof apply).toBe('function')
  })

  it('mounts the /acp rpc channel and the SSE fetch route from valid config', () => {
    const ctx = fakeCtx()
    apply(ctx as never, { agents: [{ id: 'a', command: 'x' }] })
    expect(ctx.connection.rpc.handle).toHaveBeenCalledWith('/acp', expect.any(Function))
    expect(ctx.connection.fetch.register).toHaveBeenCalledWith(expect.objectContaining({
      path: '/api/acp/stream',
      methods: ['GET'],
    }))
    expect(ctx.effect).toHaveBeenCalled()
  })

  it('prefers the owner-explicit channel register when the runtime Connection service exposes it', () => {
    // rc.2 runtimes: `rpc.handle` re-roots service lookups at the Connection
    // service's own scope (no `webServer` injected there) and the registration
    // dies with `cannot get property "webServer" without inject`. The private
    // `register(owner, channel, handler)` takes the owner explicitly instead.
    const ctx = fakeCtx() as unknown as {
      connection: { register: ReturnType<typeof vi.fn>; rpc: { handle: ReturnType<typeof vi.fn> } }
    }
    ctx.connection.register = vi.fn(() => () => Promise.resolve())
    apply(ctx as never, { agents: [{ id: 'a', command: 'x' }] })
    expect(ctx.connection.register).toHaveBeenCalledWith(ctx, '/acp', expect.any(Function))
    expect(ctx.connection.rpc.handle).not.toHaveBeenCalled()
  })

  it('falls back to rpc.handle when the private register throws', () => {
    // Presence-only probe: a `register` that cannot take (owner, channel, handler)
    // must leave the plugin on the documented path instead of failing the boot.
    const ctx = fakeCtx() as unknown as {
      connection: { register: ReturnType<typeof vi.fn>; rpc: { handle: ReturnType<typeof vi.fn> } }
    }
    ctx.connection.register = vi.fn(() => { throw new Error('cannot get property "webServer" without inject') })
    apply(ctx as never, { agents: [{ id: 'a', command: 'x' }] })
    expect(ctx.connection.rpc.handle).toHaveBeenCalledWith('/acp', expect.any(Function))
  })

  it('keeps the channel registered when register returns no disposer, without registering twice', () => {
    // An unexpected return shape means "this runtime's register is not the one we
    // know": keep the working channel and hand the effect a no-op disposer rather
    // than re-registering the same prefix through rpc.handle.
    const ctx = fakeCtx() as unknown as {
      connection: { register: ReturnType<typeof vi.fn>; rpc: { handle: ReturnType<typeof vi.fn> } }
      effect: { mock: { calls: unknown[][] } }
    }
    ctx.connection.register = vi.fn(() => ({ dispose: () => Promise.resolve() }))
    apply(ctx as never, { agents: [{ id: 'a', command: 'x' }] })
    expect(ctx.connection.register).toHaveBeenCalledWith(ctx, '/acp', expect.any(Function))
    expect(ctx.connection.rpc.handle).not.toHaveBeenCalled()
    const channel = ctx.effect.mock.calls.find(call => call[1] === 'dsh-ntr: /acp rpc channel') as [() => unknown] | undefined
    // The effect contract wants a disposer back: an unexpected shape must still
    // hand one over instead of letting activation/disposal fail.
    expect(channel).toBeDefined()
    expect(typeof channel![0]()).toBe('function')
  })

  it('fails the boot loudly on invalid agent config', () => {
    const ctx = fakeCtx()
    expect(() => apply(ctx as never, { agents: [{ id: 'BAD ID', command: 'x' }] })).toThrow(/acp/)
    expect(() => apply(ctx as never, { agents: [{ command: 'x' }] })).toThrow(/id/)
  })

  it('registers the AcpLlmAdapter when llm service is available', () => {
    const ctx = fakeCtx()
    const registerAdapter = vi.fn()
    const get = vi.fn((key: string) => {
      if (key === 'llm') return { registerAdapter }
      return undefined
    })
    ;(ctx as unknown as { get: typeof get }).get = get
    apply(ctx as never, { agents: [{ id: 'a', command: 'x' }] })
    expect(registerAdapter).toHaveBeenCalledWith(['acp'], expect.objectContaining({
      providerInfo: expect.any(Function),
      providerRetryPolicy: expect.any(Function),
      imageRequestPricing: expect.any(Function),
      listModels: expect.any(Function),
      resolveModel: expect.any(Function),
      prepareCall: expect.any(Function),
      stream: expect.any(Function),
    }))
  })

  it('reports approval routing only when the approval and agents services are both reachable', async () => {
    async function listWith(get: (key: string) => unknown): Promise<unknown> {
      const ctx = fakeCtx()
      let rpcHandler: ((endpoint: string, payload: unknown, signal: AbortSignal) => Promise<unknown>) | undefined
      ctx.connection.rpc.handle = vi.fn((_channel: string, handler: unknown) => {
        rpcHandler = handler as typeof rpcHandler
        return () => Promise.resolve()
      })
      ;(ctx as unknown as { get: unknown }).get = get
      apply(ctx as never, { agents: [{ id: 'agent-1', command: 'run' }] })
      return rpcHandler!('agents/list', {}, new AbortController().signal)
    }

    const routed = await listWith(key => {
      if (key === 'approval') return { request: vi.fn() }
      if (key === 'agents') return { get: vi.fn() }
      return undefined
    })
    expect(routed).toMatchObject({ ok: true, value: { approvalRouted: true } })

    // Either service missing → the settings-panel ledger stays authoritative.
    const noApproval = await listWith(key => (key === 'agents' ? { get: vi.fn() } : undefined))
    expect(noApproval).toMatchObject({ ok: true, value: { approvalRouted: false } })
    const noAgents = await listWith(key => (key === 'approval' ? { request: vi.fn() } : undefined))
    expect(noAgents).toMatchObject({ ok: true, value: { approvalRouted: false } })
  })

  it('reports nothing about access-mode routing — the axis is retired', async () => {
    // `accessModeRouted` used to be part of `agents/list`. The whole mapping it
    // reported on (DSH's access mode arbitrating an ACP agent's permissions) is
    // retired: the agent decides its own approvals and the host maps the ask
    // through unchanged. The field is gone; nothing may resurrect it.
    async function listWith(get: (key: string) => unknown): Promise<Record<string, unknown>> {
      const ctx = fakeCtx()
      let rpcHandler: ((endpoint: string, payload: unknown, signal: AbortSignal) => Promise<unknown>) | undefined
      ctx.connection.rpc.handle = vi.fn((_channel: string, handler: unknown) => {
        rpcHandler = handler as typeof rpcHandler
        return () => Promise.resolve()
      })
      ;(ctx as unknown as { get: unknown }).get = get
      apply(ctx as never, { agents: [{ id: 'agent-1', command: 'run' }] })
      const answer = await rpcHandler!('agents/list', {}, new AbortController().signal)
      return (answer as { value: Record<string, unknown> }).value
    }

    const answer = await listWith(key => {
      if (key === 'approval') return { request: vi.fn(), config: { policy: 'ask' } }
      if (key === 'agents') return { get: vi.fn() }
      if (key === 'sandboxPolicy') return { resolve: vi.fn(() => ({ mode: 'read-only', workspaceRoot: '/tmp/ws' })) }
      if (key === 'sessions') return { get: vi.fn(() => ({ events: [] })) }
      return undefined
    })
    expect(answer).toMatchObject({ approvalRouted: true })
    expect(answer).not.toHaveProperty('accessModeRouted')
    // Nothing else the retired axis reported may come back either.
    expect(Object.keys(answer).sort()).toEqual(['agents', 'approvalRouted'])
  })

  it('answers the seat gate for a COLD session through the persistence store, without the access-mode knobs', async () => {
    // One plugin instance answers repeated asks: the browser's gate asks again
    // on every store tick, and the cached verdict is what makes that cheap.
    const readHandle = {
      header: { agentPreset: 'standard' },
      read: vi.fn(async () => ({ events: [{ type: 'agent-preset/selected', data: { agentPreset: 'acp' } }] })),
      close: vi.fn(async () => {}),
    }
    const persistence = { open: vi.fn(async () => readHandle) }
    const ctx = fakeCtx()
    let rpcHandler: ((endpoint: string, payload: unknown, signal: AbortSignal) => Promise<unknown>) | undefined
    ctx.connection.rpc.handle = vi.fn((_channel: string, handler: unknown) => {
      rpcHandler = handler as typeof rpcHandler
      return () => Promise.resolve()
    })
    // Deliberately NO sandboxPolicy and NO approval: the seat gate's verdict
    // depends on neither — a deployment without them must still take the seat.
    const services: Record<string, unknown> = {
      sessions: { get: vi.fn(() => undefined) },
      sessionPersistence: persistence,
    }
    ;(ctx as unknown as { get: unknown }).get = (key: string) => services[key]
    apply(ctx as never, { agents: [{ id: 'agent-1', command: 'run' }] })
    const ask = async (dshSessionId: string): Promise<Record<string, unknown>> => {
      const answer = await rpcHandler!('session/chat-list', { dshSessionId }, new AbortController().signal)
      return (answer as { value: Record<string, unknown> }).value
    }

    // First ask: the RPC WAITS for the persistence read, so the settled
    // verdict arrives on the very first response — the browser's one-shot
    // fallback must not be told "not ACP" while the read is still in flight.
    const first = await ask('session-cold')
    expect(first.acpMode).toBe(true)
    expect(persistence.open).toHaveBeenCalledWith('session-cold', 'read')
    expect(readHandle.close).toHaveBeenCalled()
    // Second ask: the settled verdict is cached; the store is opened once.
    const second = await ask('session-cold')
    expect(second.acpMode).toBe(true)
    expect(persistence.open).toHaveBeenCalledTimes(1)

    // A stored log whose newest selection is another preset stays native.
    const otherHandle = {
      header: { agentPreset: 'standard' },
      read: async () => ({ events: [{ type: 'agent-preset/selected', data: { agentPreset: 'standard' } }] }),
      close: vi.fn(async () => {}),
    }
    services.sessionPersistence = { open: vi.fn(async () => otherHandle) }
    const other = await ask('session-other')
    expect(other.acpMode).toBe(false)

    // No persistence service: `false`, never a throw — and the access-mode
    // knobs' absence changes nothing about that.
    services.sessionPersistence = undefined
    const bare = await ask('session-unknown')
    expect(bare.acpMode).toBe(false)
  })

  it('never touches the host model layer at all — no route, no default, no guard', async () => {
    const ctx = fakeCtx()
    let rpcHandler: ((endpoint: string, payload: unknown, signal: AbortSignal) => Promise<unknown>) | undefined
    ctx.connection.rpc.handle = vi.fn((_channel: string, handler: unknown) => {
      rpcHandler = handler as typeof rpcHandler
      return () => Promise.resolve()
    })
    // Every service the retired provider axis consumed. Present on purpose: the
    // new shape must not need ANY of them, so a deployment with them all wired
    // behaves exactly like one with none.
    const saveSelection = vi.fn(async () => {})
    const currentSelection = vi.fn(() => ({ provider: 'deepseek', model: 'deepseek-v4' }))
    const get = vi.fn((key: string) => {
      if (key === 'agentDefaultModel') return { currentSelection, saveSelection }
      if (key === 'sandboxPolicy') return { resolve: vi.fn(() => ({ mode: 'read-only', workspaceRoot: '/tmp/ws' })) }
      if (key === 'sessions') return { get: vi.fn(() => ({ events: [] })) }
      return undefined
    })
    ;(ctx as unknown as { get: typeof get }).get = get
    apply(ctx as never, { agents: [{ id: 'agent-1', command: 'run' }] })

    expect(rpcHandler).toBeDefined()
    const dummySignal = new AbortController().signal

    // The plugin's OWN default agent is its private state, answered by its own
    // endpoint — nothing here is shaped like a model route.
    expect(await rpcHandler!('default/agent', {}, dummySignal)).toEqual({ ok: true, value: { agentId: undefined } })
    expect(await rpcHandler!('default/agent-set', { agentId: 'agent-1' }, dummySignal)).toEqual({ ok: true, value: { done: true } })
    expect(await rpcHandler!('default/agent', {}, dummySignal)).toEqual({ ok: true, value: { agentId: 'agent-1' } })
    // …and the binding for one conversation goes to the plugin's own RPC.
    expect(await rpcHandler!('session/chat-bind', { dshSessionId: 'chat-1', agentId: 'agent-1' }, dummySignal))
      .toEqual({ ok: true, value: { done: true } })

    // The host's model layer was never read, never written, never guarded.
    expect(saveSelection).not.toHaveBeenCalled()
    expect(currentSelection).not.toHaveBeenCalled()

    // The retired endpoints are gone: they exist only to be refused now.
    for (const endpoint of ['model/get-default', 'model/set-default', 'model/reconcile-default']) {
      expect(await rpcHandler!(endpoint, {}, dummySignal)).toMatchObject({ ok: false, error: { code: 'unknown_endpoint' } })
    }
  })
})
