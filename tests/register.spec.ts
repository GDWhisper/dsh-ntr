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

  it('emits the pending-permission replay on a fresh SSE connection', async () => {
    // The `permission/request` frame is broadcast ONCE, when the ask is created.
    // A client that connects later — page reload, second tab, stream outage —
    // never receives it, and for a ledger ask the settings card is the only
    // answer entry. The route must therefore emit the replay right after
    // `stream/open`; the empty case still has to terminate with the live set, or
    // a reconnecting client keeps whatever card it held from before.
    //
    // Only the WIRING is asserted here (the loop runs, in order, on this route):
    // a non-empty replay needs a live ask, which needs a spawned child — the
    // frame content itself is covered by `permissionReplayFrames`
    // (tests/impl.spec.ts) and `pendingPermissionViews` (tests/bridge.spec.ts).
    const ctx = fakeCtx()
    apply(ctx as never, { agents: [{ id: 'a', command: 'x' }] })
    const descriptor = ctx.connection.fetch.register.mock.calls.at(-1)?.[0] as {
      fetch: (request: { signal: AbortSignal }) => Promise<Response>
    } | undefined
    expect(descriptor).toBeDefined()

    const controller = new AbortController()
    const response = await descriptor!.fetch({ signal: controller.signal })
    expect(response.headers.get('content-type')).toContain('text/event-stream')
    const reader = (response.body as ReadableStream<Uint8Array>).getReader()
    const decoder = new TextDecoder()
    const frames: unknown[] = []
    try {
      while (frames.length < 2) {
        const { value, done } = await reader.read()
        if (done) break
        const text = decoder.decode(value)
        const payload = /^data: (.*)\n\n$/s.exec(text)?.[1]
        if (payload !== undefined) frames.push(JSON.parse(payload))
      }
    } finally {
      controller.abort()
      await reader.cancel().catch(() => { /* the abort already closed it */ })
    }

    expect(frames[0]).toEqual({ type: 'stream/open' })
    // Nothing is outstanding (no child was ever spawned), and the terminator
    // still rides along: an empty live set is what clears a stale card.
    expect(frames[1]).toEqual({ type: 'permission/synced', requestIds: [] })
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

describe('acp-guard preset row', () => {
  /**
   * The guard registers its listeners on whatever ctx the Loader hands the
   * preset row. This fake records the registrations so the tests can fire the
   * listeners directly — the real dispatch (`dispatch.waterfall`) is a runtime
   * concern these tests stand in for.
   */
  function guardCtx(services: Record<string, unknown> = {}) {
    const listeners = new Map<string, { listener: (payload: unknown, next: () => Promise<unknown>) => Promise<unknown>; options?: unknown }>()
    return {
      listeners,
      on: vi.fn((name: string, listener: (payload: unknown, next: () => Promise<unknown>) => Promise<unknown>, options?: unknown) => {
        listeners.set(name, { listener, options })
        return () => {}
      }),
      get: vi.fn((service: string) => services[service]),
    }
  }

  /** A fake `tools` service: a scoped `get` view plus a `register` spy. */
  function toolsServiceOf(existing: Record<string, unknown> = {}) {
    const registered = new Map<string, unknown>()
    return {
      registered,
      get: vi.fn((name: string) => existing[name] ?? registered.get(name)),
      register: vi.fn((definition: { name: string }) => { registered.set(definition.name, definition) }),
    }
  }

  it('registers the route rewrite outermost so the binding outranks the harness selection', async () => {
    const ctx = guardCtx()
    await import('../presets/acp/acp-guard.mjs').then(({ apply }) => apply(ctx as never, undefined))
    // `installModelSelection`'s own agent/request rewrite registers BEFORE the
    // preset rows mount; waterfall listeners run outermost-first, so only the
    // outermost slot lets the binding's rewrite land last (and win).
    expect(ctx.on).toHaveBeenCalledWith('agent/request', expect.any(Function), { prepend: true })
    expect(ctx.on).toHaveBeenCalledWith('agent/pre-step', expect.any(Function))
  })

  it('rewrites the resolved request to the conversation binding, dropping the inherited effort', async () => {
    const ctx = guardCtx()
    await import('../presets/acp/acp-guard.mjs').then(({ apply }) => apply(ctx as never, undefined))
    const request = ctx.listeners.get('agent/request')
    if (request === undefined) throw new Error('guard registered no agent/request listener')

    // The plugin records the binding on `session/chat-bind`; the registry is
    // the SAME object bridge.ts installs on globalThis (cross-instance share).
    const { ACP_ROUTE_BINDING_KEY, routeBindingRegistry } = await import('../src/bridge.ts')
    expect((globalThis as Record<symbol, unknown>)[ACP_ROUTE_BINDING_KEY as symbol]).toBe(routeBindingRegistry())
    routeBindingRegistry().conversations.set('dsh-guard-1', 'beta@mock-model-b')
    try {
      // What the harness's own chain resolves for a never-ACP session: the
      // deployment default, with its materialized effort.
      const resolved = await request.listener(
        { agent: { session: { id: 'dsh-guard-1' } } },
        async () => ({ provider: 'deepseek', model: 'deepseek-v4', reasoningEffort: 'high' }),
      )
      expect(resolved).toEqual({ provider: 'acp', model: 'beta@mock-model-b' })
    } finally {
      routeBindingRegistry().conversations.delete('dsh-guard-1')
    }
  })

  it('falls back to the plugin default agent for a conversation nobody bound', async () => {
    const ctx = guardCtx()
    await import('../presets/acp/acp-guard.mjs').then(({ apply }) => apply(ctx as never, undefined))
    const request = ctx.listeners.get('agent/request')
    if (request === undefined) throw new Error('guard registered no agent/request listener')

    const { routeBindingRegistry } = await import('../src/bridge.ts')
    const registry = routeBindingRegistry()
    const previousDefault = registry.defaultModel
    registry.defaultModel = 'fallback-agent'
    try {
      const resolved = await request.listener(
        { agent: { session: { id: 'dsh-guard-unbound' } } },
        async () => ({ provider: 'deepseek', model: 'deepseek-v4' }),
      )
      expect(resolved).toEqual({ provider: 'acp', model: 'fallback-agent' })
    } finally {
      registry.defaultModel = previousDefault
    }
  })

  it('leaves the resolved route untouched when nothing is bound (and never throws)', async () => {
    const ctx = guardCtx()
    await import('../presets/acp/acp-guard.mjs').then(({ apply }) => apply(ctx as never, undefined))
    const request = ctx.listeners.get('agent/request')
    if (request === undefined) throw new Error('guard registered no agent/request listener')

    const { routeBindingRegistry } = await import('../src/bridge.ts')
    const registry = routeBindingRegistry()
    const previousDefault = registry.defaultModel
    registry.defaultModel = undefined
    try {
      const seed = { provider: 'deepseek', model: 'deepseek-v4', reasoningEffort: 'high' }
      const untouched = await request.listener({ agent: { session: { id: 'dsh-guard-none' } } }, async () => seed)
      expect(untouched).toBe(seed)
      // A payload without a session id must not rewrite either.
      const anonymous = await request.listener({ agent: {} }, async () => seed)
      expect(anonymous).toBe(seed)
    } finally {
      registry.defaultModel = previousDefault
    }
  })

  it('registers the tools/execute listener: cards execute as real results again', async () => {
    // The fourth duty is back, upgraded: under the segmented turn shape the
    // host loop executes a card the moment its segment settles — often before
    // the agent reports the output — so the virtual tool's body parks on the
    // registry's `waitForToolOutput` instead of answering instantly.
    const ctx = guardCtx()
    await import('../presets/acp/acp-guard.mjs').then(({ apply }) => apply(ctx as never, undefined))
    expect(ctx.listeners.has('tools/execute')).toBe(true)
    expect(ctx.listeners.has('agent/pre-step')).toBe(true)
    expect(ctx.listeners.has('agent/request')).toBe(true)
  })

  it('answers a card execution from the registry, and waits when the output has not landed yet', async () => {
    const { routeBindingRegistry, recordAcpToolOutput, releaseAllToolOutputWaiters } = await import('../src/bridge.ts')
    // A name that resolves to a REAL tool passes untouched (this row must
    // never shadow the host's own tools).
    const realTool = { name: 'real', execute: () => ({ text: 'real' }) }
    const toolsWithReal = toolsServiceOf({ real: realTool })
    const ctxReal = guardCtx({ tools: toolsWithReal })
    await import('../presets/acp/acp-guard.mjs').then(({ apply }) => apply(ctxReal as never, undefined))
    const execReal = ctxReal.listeners.get('tools/execute')
    if (execReal === undefined) throw new Error('no tools/execute listener')
    const downstream = vi.fn(async () => ({ text: 'downstream' }))
    await execReal.listener({ name: 'real', agent: {}, exec: { callId: 'r1' } }, downstream)
    expect(toolsWithReal.register).not.toHaveBeenCalled()
    expect(downstream).toHaveBeenCalledTimes(1)

    // An unknown name registers a scoped virtual tool whose body first answers
    // from the registry when the output already landed…
    recordAcpToolOutput('wait-1', 'REAL OUTPUT')
    try {
      const unknown = toolsServiceOf()
      const ctxCard = guardCtx({ tools: unknown })
      await import('../presets/acp/acp-guard.mjs').then(({ apply }) => apply(ctxCard as never, undefined))
      const execCard = ctxCard.listeners.get('tools/execute')
      if (execCard === undefined) throw new Error('no tools/execute listener')
      const next = vi.fn(async () => ({ text: 'would-execute' }))
      await execCard.listener({ name: 'Bash', agent: {}, exec: { callId: 'wait-1' } }, next)
      expect(unknown.register).toHaveBeenCalledTimes(1)
      expect(unknown.register.mock.calls[0][0]).toMatchObject({ name: 'Bash' })
      const definition = unknown.register.mock.calls[0][0] as { execute: (args: unknown, exec: { callId: string }) => Promise<{ text: string }> }
      expect(await definition.execute(undefined, { callId: 'wait-1' })).toEqual({ text: 'REAL OUTPUT' })

      // …and parks on `waitForToolOutput` when it has not, released by the
      // record itself (the guard must not answer with a pointer while the
      // agent is still running the tool).
      const parking = definition.execute(undefined, { callId: 'wait-2' })
      let settled = false
      void parking.then(() => { settled = true })
      await new Promise(resolve => setTimeout(resolve, 20))
      expect(settled).toBe(false)
      recordAcpToolOutput('wait-2', 'LATE OUTPUT')
      expect(await parking).toEqual({ text: 'LATE OUTPUT' })

      // A turn's settlement releases every parked waiter with the pointer.
      const parked = definition.execute(undefined, { callId: 'wait-3' })
      releaseAllToolOutputWaiters()
      expect(await parked).toMatchObject({ text: expect.stringContaining('ACP transcript view') })
    } finally {
      releaseAllToolOutputWaiters()
      routeBindingRegistry().toolResults.clear()
    }
  })

  it('lets its own continuation steps through, and still refuses a foreign staged batch', async () => {
    // The third duty's exception is back with the fourth: a staged batch whose
    // every call id the bridge recorded is the continuation of OUR cards (the
    // adapter resumes the same in-flight prompt for it). One unknown id makes
    // the batch foreign — forwarding it would re-send the person's last words.
    const { routeBindingRegistry } = await import('../src/bridge.ts')
    routeBindingRegistry().toolResults.set('own-1', 'output')
    try {
      const ctx = guardCtx()
      await import('../presets/acp/acp-guard.mjs').then(({ apply }) => apply(ctx as never, undefined))
      const step = ctx.listeners.get('agent/pre-step')
      if (step === undefined) throw new Error('guard registered no pre-step listener')

      const own = {
        messages: [
          { role: 'tool', source: { kind: 'tool', callId: 'own-1' }, content: [{ type: 'text', text: 'output' }] },
        ],
      }
      expect(await step.listener(own, async () => ({ kind: 'enter', messages: own.messages })))
        .toEqual({ kind: 'enter', messages: own.messages })

      const foreign = {
        messages: [
          { role: 'tool', source: { kind: 'tool', callId: 'own-1' }, content: [{ type: 'text', text: 'output' }] },
          { role: 'tool', source: { kind: 'tool', callId: 'never-seen' }, content: [{ type: 'text', text: '?' }] },
        ],
      }
      expect(await step.listener(foreign, async () => ({ kind: 'enter', messages: foreign.messages })))
        .toEqual({ kind: 'reject' })
    } finally {
      routeBindingRegistry().toolResults.clear()
    }
  })

  it('rejects a continuation step fed with nothing the person said', async () => {
    // The oml session bug: the host loop re-runs whenever the settled
    // assistant message carries tool-call blocks — which is what the ACP
    // agent's display-only tool cards are. The next step's batch is the
    // staged tool results, and forwarding it re-sent the person's last words
    // to the agent on every step. `reject` ends the turn instead.
    const ctx = guardCtx()
    await import('../presets/acp/acp-guard.mjs').then(({ apply }) => apply(ctx as never, undefined))
    const preStep = ctx.listeners.get('agent/pre-step')
    if (preStep === undefined) throw new Error('guard registered no agent/pre-step listener')

    const toolResult = { role: 'user', source: { kind: 'tool', callId: 'c1' }, content: [{ type: 'text', text: 'Error: unknown tool "Bash"' }] }
    const context = { role: 'user', source: { kind: 'runtime-context', form: 'snapshot' }, content: [{ type: 'text', text: 'Current runtime context.' }] }
    const decision = await preStep.listener({ messages: [toolResult, context], turn: 2, step: 2 }, async () => ({
      kind: 'enter',
      messages: [toolResult, context],
    }))
    expect(decision).toEqual({ kind: 'reject' })
  })

  it('keeps a batch that carries the person\'s words and still strips the injections', async () => {
    const ctx = guardCtx()
    await import('../presets/acp/acp-guard.mjs').then(({ apply }) => apply(ctx as never, undefined))
    const preStep = ctx.listeners.get('agent/pre-step')
    if (preStep === undefined) throw new Error('guard registered no agent/pre-step listener')

    const user = { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '你好' }] }
    const injected = { role: 'user', source: { kind: 'skill-catalog' }, content: [{ type: 'text', text: '<available_skills>…' }] }
    const decision = await preStep.listener({ messages: [user, injected], turn: 1, step: 1 }, async () => ({
      kind: 'enter',
      messages: [user, injected],
    }))
    expect(decision).toEqual({ kind: 'enter', messages: [user] })
  })

  it('ends an injected-only wake as the plain no-op it always was', async () => {
    // A batch the strip empties completely carries no continuation fuel: the
    // loop itself ends a first step with zero messages as `completed`, so the
    // gate must not dress it up as a rejection.
    const ctx = guardCtx()
    await import('../presets/acp/acp-guard.mjs').then(({ apply }) => apply(ctx as never, undefined))
    const preStep = ctx.listeners.get('agent/pre-step')
    if (preStep === undefined) throw new Error('guard registered no agent/pre-step listener')

    const injected = { role: 'user', source: { kind: 'plugin' }, content: [{ type: 'text', text: 'goal material' }] }
    const decision = await preStep.listener({ messages: [injected], turn: 3, step: 1 }, async () => ({
      kind: 'enter',
      messages: [injected],
    }))
    expect(decision).toEqual({ kind: 'enter', messages: [] })
  })

  it('never eats a source-less batch: hand-assembled messages count as the person', async () => {
    const ctx = guardCtx()
    await import('../presets/acp/acp-guard.mjs').then(({ apply }) => apply(ctx as never, undefined))
    const preStep = ctx.listeners.get('agent/pre-step')
    if (preStep === undefined) throw new Error('guard registered no agent/pre-step listener')

    const handBuilt = { role: 'user', content: [{ type: 'text', text: 'headless prompt' }] }
    const decision = await preStep.listener({ messages: [handBuilt] }, async () => ({
      kind: 'enter',
      messages: [handBuilt],
    }))
    expect(decision).toEqual({ kind: 'enter', messages: [handBuilt] })
  })
})
