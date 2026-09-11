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
