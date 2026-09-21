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

  it('reports access mode routing only when sandboxPolicy, sessions and approval are all reachable', async () => {
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

    const services: Record<string, unknown> = {
      approval: { request: vi.fn(), config: { policy: 'ask' } },
      agents: { get: vi.fn() },
      sandboxPolicy: { resolve: vi.fn(() => ({ mode: 'read-only', workspaceRoot: '/tmp/ws' })) },
      sessions: { get: vi.fn(() => ({ events: [] })) },
    }
    const routed = await listWith(key => services[key])
    expect(routed).toMatchObject({ ok: true, value: { accessModeRouted: true } })

    // Any collaborator missing → the agent's own `permission` field stays in
    // charge and the panel keeps saying so.
    for (const missing of ['sandboxPolicy', 'sessions', 'approval']) {
      const partial = await listWith(key => (key === missing ? undefined : services[key]))
      expect(partial).toMatchObject({ ok: true, value: { accessModeRouted: false } })
    }
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

  it('wires agentDefaultModel hooks when service is available', async () => {
    const ctx = fakeCtx()
    let rpcHandler: ((endpoint: string, payload: unknown, signal: AbortSignal) => Promise<unknown>) | undefined
    ctx.connection.rpc.handle = vi.fn((_channel: string, handler: unknown) => {
      rpcHandler = handler as typeof rpcHandler
      return () => Promise.resolve()
    })
    const saveSelection = vi.fn(async () => {})
    const currentSelection = vi.fn(() => ({ provider: 'deepseek', model: 'deepseek-v4' }))
    const get = vi.fn((key: string) => {
      if (key === 'agentDefaultModel') return { currentSelection, saveSelection }
      return undefined
    })
    ;(ctx as unknown as { get: typeof get }).get = get
    apply(ctx as never, { agents: [{ id: 'agent-1', command: 'run' }] })

    expect(rpcHandler).toBeDefined()
    const dummySignal = new AbortController().signal

    const getRes = await rpcHandler!('model/get-default', {}, dummySignal)
    expect(getRes).toEqual({ ok: true, value: { provider: 'deepseek', model: 'deepseek-v4' } })

    const setRes = await rpcHandler!('model/set-default', { agentId: 'agent-1' }, dummySignal)
    expect(setRes).toEqual({ ok: true, value: { done: true } })
    expect(saveSelection).toHaveBeenCalledWith({ provider: 'acp', model: 'agent-1' })
  })
})
