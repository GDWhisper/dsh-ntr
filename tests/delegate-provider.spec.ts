/**
 * The `acp` SubagentProvider (docs/plan/acp-delegate-native-subagent.md §4):
 * every settlement outcome, dispose idempotence, signal abort, the built-in
 * silence window and 24h absolute backstop, clean start failures, and the
 * never-reject / never-dangle result contract — all on the shared in-memory
 * fake host (no child process).
 */
import { describe, expect, it, vi } from 'vitest'
import type { ResolvedSubagentStartRequest, SubagentResult } from '@deepseek-ai/dsh-subagent'
import { ACP_SUBAGENT_PROVIDER, AcpSubagentProvider } from '../src/bridge/delegate-provider.ts'
import { AcpDelegateService, type AcpDelegateRunHandle } from '../src/bridge/delegate-service.ts'
import { MAX_DELEGATE_DIAGNOSTIC_BYTES, delegateLabel } from '../src/impl.ts'
import { DELEGATE_TIMEOUT_MAX_MS } from '../src/protocol.ts'
import { chunk, configOptionsOf, happyPrompt, makeHost, modesOf, tick } from './delegate-harness.ts'

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

function makeProvider() {
  const f = makeHost()
  const provider = new AcpSubagentProvider({ service: new AcpDelegateService(f.host) })
  return { f, provider }
}

/** The host-shaped resolved request: a fresh controller signal, absolute cwd. */
function makeRequest(overrides?: { label?: string; cwd?: string; prompt?: Array<{ type: 'text'; text: string }>; parentCwd?: string }) {
  const controller = new AbortController()
  const request = {
    cwd: overrides?.cwd ?? '/work',
    prompt: overrides?.prompt ?? [{ type: 'text', text: 'do it' }],
    parent: { session: { header: { cwd: overrides?.parentCwd ?? '/parent-ws' } } },
    signal: controller.signal,
    // An EXPLICIT undefined label must stay undefined (the ?? default would
    // hide the missing-label failure case).
    label: overrides !== undefined && 'label' in overrides ? overrides.label : 'alpha: do it',
  } as unknown as ResolvedSubagentStartRequest
  return { request, controller }
}

describe('AcpSubagentProvider descriptor', () => {
  it('is the one-shot acp leaf: start only, frozen all-false capabilities, no parent context', () => {
    const { provider } = makeProvider()
    expect(provider.name).toBe(ACP_SUBAGENT_PROVIDER)
    expect(provider.name).toBe('acp')
    expect(provider.capabilities).toEqual({ agentOptions: false, agentPreset: false, outputSchema: false, depthLimit: false })
    expect(Object.isFrozen(provider.capabilities)).toBe(true)
    expect(provider.inheritsParentContext).toBe(false)
    expect(typeof provider.start).toBe('function')
    // No prepareContinuable: the host rejects send_message (NOT_CONTINUABLE)
    // and filters the leaf out of list_agents — by design, not by accident.
    expect((provider as { prepareContinuable?: unknown }).prepareContinuable).toBeUndefined()
  })
})

describe('AcpSubagentProvider settlement outcomes', () => {
  it('completed: the folded answer as ONE text block, no plugin footer, close once', async () => {
    const { f, provider } = makeProvider()
    happyPrompt(f, 'Hello native')
    const run = await provider.start(makeRequest().request)
    expect(run.id).toMatch(UUID_SHAPE)
    const result = await run.result
    expect(result).toEqual({ output: [{ type: 'text', text: 'Hello native' }], stopReason: 'completed' })
    expect(JSON.stringify(result)).not.toContain('— acp_delegate') // the host owns the summary
    expect(f.calls.close).toEqual(['session-1'])
    expect(f.sinkCount()).toBe(0)
  })

  it('routes the agent id from the label and the cwd/extra roots from the request', async () => {
    const { f, provider } = makeProvider()
    happyPrompt(f)
    const { request } = makeRequest({ label: 'beta: first line\nrest', cwd: '/work/sub', parentCwd: '/parent-ws' })
    await (await provider.start(request)).result
    expect(f.calls.startSession).toEqual([{ agentId: 'beta', cwd: '/work/sub', opts: { extraRoots: ['/parent-ws'], alignSpawnCwd: true } }])
    expect(f.calls.prompt).toEqual([{ sessionId: 'session-1', text: 'do it' }])
  })

  it('empty answer: the placeholder survives so the notification carries a fact', async () => {
    const { f, provider } = makeProvider()
    happyPrompt(f, '')
    const result = await (await provider.start(makeRequest().request)).result
    expect(result.stopReason).toBe('completed')
    expect(result.output).toEqual([{ type: 'text', text: '(the agent returned no text)' }])
  })

  it('watchdog error-only turn/end: error, with the agent failure detail as diagnostic', async () => {
    const { f, provider } = makeProvider()
    f.onPrompt(async (sessionId) => {
      f.emit({ type: 'turn/end', sessionId, turnId: '', error: 'agent went silent (inactivity timeout)' })
      return { turnId: 'real' }
    })
    const result = await (await provider.start(makeRequest().request)).result
    // The failure outranks "finished": the host's own failure path says the
    // same thing for a child that never ended its turn.
    expect(result.stopReason).toBe('error')
    expect(result.diagnostic).toBe('agent went silent (inactivity timeout)')
  })

  it('the ACP turn\'s own ending is mapped, never flattened into completed', async () => {
    // The host's vocabulary already names these endings in the settlement
    // summary; reporting "finished" for a refusal is the opposite of the fact.
    for (const [acpStopReason, hostStopReason] of [
      ['refusal', 'refusal'],
      ['max_tokens', 'max-tokens'],
      ['cancelled', 'aborted'],
    ] as const) {
      const { f, provider } = makeProvider()
      f.onPrompt(async (sessionId) => {
        f.emit({ type: 'turn/end', sessionId, turnId: 't', stopReason: acpStopReason })
        return { turnId: 't' }
      })
      const result = await (await provider.start(makeRequest().request)).result
      expect(result.stopReason).toBe(hostStopReason)
      expect(result.diagnostic).toBeUndefined() // the host summary names it
    }
  })

  it('max_turn_requests has no host twin: completed stops being silent about it', async () => {
    const { f, provider } = makeProvider()
    f.onPrompt(async (sessionId) => {
      f.emit({ type: 'session/update', sessionId, seq: 1, update: chunk('cut short') })
      f.emit({ type: 'turn/end', sessionId, turnId: 't', stopReason: 'max_turn_requests' })
      return { turnId: 't' }
    })
    const result = await (await provider.start(makeRequest().request)).result
    expect(result.stopReason).toBe('completed')
    expect(result.output).toEqual([{ type: 'text', text: 'cut short' }])
    expect(result.diagnostic).toBe('ACP 停因 max_turn_requests：这一回合不是正常结束，答复可能不完整')
  })

  it('auto-answered / refused asks reach the parent as ONE diagnostic line', async () => {
    const { f, provider } = makeProvider()
    f.onPrompt(async (sessionId) => {
      // The delegation's own policy answers these, so this settlement is the
      // only place the parent ever learns the child hit them.
      f.emit({ type: 'permission/expired', sessionId, toolCall: {}, timeoutMs: 0, outcome: { outcome: 'selected', optionId: 'yes' } })
      f.emit({ type: 'permission/expired', sessionId, toolCall: {}, timeoutMs: 0, outcome: { outcome: 'cancelled' } })
      f.emit({ type: 'session/update', sessionId, seq: 1, update: chunk('done') })
      f.emit({ type: 'turn/end', sessionId, turnId: 't', stopReason: 'end_turn' })
      return { turnId: 't' }
    })
    const result = await (await provider.start(makeRequest().request)).result
    expect(result.stopReason).toBe('completed')
    expect(result.diagnostic).toBe('委派会话的审批：自动代答 1 个、拒绝 1 个')
  })

  it('a quiet child with no asks keeps the diagnostic absent', async () => {
    const { f, provider } = makeProvider()
    happyPrompt(f, 'clean')
    const result = await (await provider.start(makeRequest().request)).result
    expect(result).toEqual({ output: [{ type: 'text', text: 'clean' }], stopReason: 'completed' })
  })

  it('failure + unnameable ending + counts + notes merge into ONE diagnostic, in that order', async () => {
    const { f, provider } = makeProvider()
    f.config.agentDefaults = { alpha: { mode: 'ghost-o' } }
    f.liveOptions.set('session-1', { modes: modesOf('default') })
    f.onPrompt(async (sessionId) => {
      f.emit({ type: 'permission/expired', sessionId, toolCall: {}, timeoutMs: 0, outcome: { outcome: 'selected', optionId: 'yes' } })
      f.emit({ type: 'turn/end', sessionId, turnId: 't', stopReason: 'max_turn_requests', error: 'turn budget spent' })
      return { turnId: 't' }
    })
    const result = await (await provider.start(makeRequest().request)).result
    // The failure outranks the mapped "completed"...
    expect(result.stopReason).toBe('error')
    // ...and all four facts survive in their fixed slots.
    expect(result.diagnostic).toBe(
      'turn budget spent\nACP 停因 max_turn_requests：这一回合不是正常结束，答复可能不完整\nagent「alpha」不再提供默认模式「ghost-o」，本次使用启动模式；委派会话的审批：自动代答 1 个',
    )
  })

  it('an extreme failure text cannot truncate the ask counts away', async () => {
    const { f, provider } = makeProvider()
    f.onPrompt(async (sessionId) => {
      f.emit({ type: 'permission/expired', sessionId, toolCall: {}, timeoutMs: 0, outcome: { outcome: 'selected', optionId: 'yes' } })
      f.emit({ type: 'turn/end', sessionId, turnId: '', error: 'x'.repeat(20_000) })
      return { turnId: 'real' }
    })
    const result = await (await provider.start(makeRequest().request)).result
    // The counts ride the RESERVED side of the merge, so the 20k failure text
    // is the part that gets truncated.
    expect(result.diagnostic?.endsWith('委派会话的审批：自动代答 1 个')).toBe(true)
    expect(result.diagnostic).toContain('[diagnostic truncated]')
    expect(new TextEncoder().encode(result.diagnostic ?? '').byteLength).toBeLessThanOrEqual(MAX_DELEGATE_DIAGNOSTIC_BYTES)
  })

  it('an aborted run reports the notes first and the ask counts after', async () => {
    const { f, provider } = makeProvider()
    f.config.agentDefaults = { alpha: { effort: 'ghost-e' } }
    f.liveOptions.set('session-1', { configOptions: configOptionsOf(['m1'], ['high']) })
    f.onPrompt(async (sessionId) => {
      f.emit({ type: 'permission/expired', sessionId, toolCall: {}, timeoutMs: 0, outcome: { outcome: 'selected', optionId: 'yes' } })
      return { turnId: 't' } // never ends: the parent aborts
    })
    const { request, controller } = makeRequest()
    const run = await provider.start(request)
    await tick()
    controller.abort()
    const result = await run.result
    expect(result.stopReason).toBe('aborted')
    expect(result.diagnostic).toBe('agent「alpha」的默认思考等级「ghost-e」不受当前模型支持，本次不设置；委派会话的审批：自动代答 1 个')
  })

  it('a prompt error keeps the ask counts too', async () => {
    const { f, provider } = makeProvider()
    f.onPrompt(async (sessionId) => {
      f.emit({ type: 'permission/expired', sessionId, toolCall: {}, timeoutMs: 0, outcome: { outcome: 'cancelled' } })
      throw new Error('turn_in_flight')
    })
    const result = await (await provider.start(makeRequest().request)).result
    expect(result.stopReason).toBe('error')
    expect(result.diagnostic).toBe('acp_delegate: turn_in_flight\n委派会话的审批：拒绝 1 个')
  })

  it('silence window: error + bounded diagnostic, cancel then close, partial text kept', async () => {
    const { f, provider } = makeProvider()
    f.config.timeoutMs = 40
    f.onPrompt(async (sessionId) => {
      f.emit({ type: 'session/update', sessionId, seq: 1, update: chunk('partial work') })
      return { turnId: 't' } // no turn/end ever
    })
    const result = await (await provider.start(makeRequest().request)).result
    expect(result.stopReason).toBe('error')
    expect(result.diagnostic).toContain('timed out after 40ms of silence')
    expect(result.output).toEqual([{ type: 'text', text: 'partial work' }])
    expect(f.calls.cancel).toEqual(['session-1'])
    expect(f.calls.close).toEqual(['session-1'])
    expect(f.order.indexOf('cancel')).toBeLessThan(f.order.indexOf('close'))
    expect(f.sinkCount()).toBe(0)
  })

  it('prompt rejection: error + diagnostic after cleanup', async () => {
    const { f, provider } = makeProvider()
    f.onPrompt(async () => { throw new Error('turn_in_flight') })
    const result = await (await provider.start(makeRequest().request)).result
    expect(result.stopReason).toBe('error')
    expect(result.diagnostic).toBe('acp_delegate: turn_in_flight')
    expect(f.calls.close).toEqual(['session-1'])
    expect(f.sinkCount()).toBe(0)
  })

  it('request.signal abort: aborted, cancel + close, result never dangles', async () => {
    const { f, provider } = makeProvider()
    f.onPrompt(() => new Promise(() => {}))
    const { request, controller } = makeRequest()
    const run = await provider.start(request)
    await tick()
    controller.abort()
    const result = await run.result
    expect(result.stopReason).toBe('aborted')
    expect(f.calls.cancel).toEqual(['session-1'])
    expect(f.calls.close).toEqual(['session-1'])
    expect(f.sinkCount()).toBe(0)
  })

  it('dispose: aborted and idempotent — one cancel, one close, stable result', async () => {
    const { f, provider } = makeProvider()
    f.onPrompt(() => new Promise(() => {}))
    const run = await provider.start(makeRequest().request)
    await tick()
    await run.dispose()
    await run.dispose()
    await run.dispose()
    const result = await run.result
    expect(result.stopReason).toBe('aborted')
    expect(f.calls.cancel).toEqual(['session-1'])
    expect(f.calls.close).toEqual(['session-1'])
    expect(f.sinkCount()).toBe(0)
  })

  it('dispose after a normal end is a no-op: the completed result stands', async () => {
    const { f, provider } = makeProvider()
    happyPrompt(f, 'done')
    const run = await provider.start(makeRequest().request)
    const first = await run.result
    await run.dispose()
    expect(await run.result).toEqual(first)
    expect(f.calls.cancel).toEqual([])
    expect(f.calls.close).toEqual(['session-1'])
  })

  it('dispose while queued: aborted without ever starting a session', async () => {
    const { f, provider } = makeProvider()
    let releaseFirst!: () => void
    const gate = new Promise<void>(resolve => { releaseFirst = resolve })
    let count = 0
    f.onPrompt(async (sessionId) => {
      count += 1
      if (count === 1) await gate
      f.emit({ type: 'turn/end', sessionId, turnId: 't', stopReason: 'end_turn' })
      return { turnId: 't' }
    })
    const first = await provider.start(makeRequest({ label: 'alpha: one' }).request)
    await tick()
    const second = await provider.start(makeRequest({ label: 'alpha: two' }).request)
    await tick()
    expect(f.calls.startSession).toHaveLength(1) // the second waits in the queue
    await second.dispose()
    expect((await second.result).stopReason).toBe('aborted')
    expect(f.calls.startSession).toHaveLength(1)
    releaseFirst()
    expect((await first.result).stopReason).toBe('completed')
    // The disposed delegation LEFT the queue: it never starts, even after the
    // predecessor finishes (the legacy queue-abort semantics, unchanged).
    expect(f.calls.startSession).toHaveLength(1)
  })

  it('the built-in 24h absolute backstop fires even while activity keeps renewing the silence window', async () => {
    vi.useFakeTimers()
    try {
      const { f, provider } = makeProvider()
      // Silence window at the same 24h bound: the absolute timer is armed
      // FIRST (at begin), so it wins the tie — and only it names the budget.
      f.config.timeoutMs = DELEGATE_TIMEOUT_MAX_MS
      f.onPrompt(async () => ({ turnId: 't' })) // no turn/end: the run stays open
      const run = await provider.start(makeRequest().request)
      await vi.advanceTimersByTimeAsync(DELEGATE_TIMEOUT_MAX_MS)
      const result = await run.result
      expect(result.stopReason).toBe('error')
      expect(result.diagnostic).toContain('absolute budget')
      expect(result.diagnostic).not.toContain('of silence')
      expect(f.calls.cancel).toEqual(['session-1'])
      expect(f.calls.close).toEqual(['session-1'])
      expect(vi.getTimerCount()).toBe(0) // no dangling watchdog after settlement
    } finally {
      vi.useRealTimers()
    }
  })

  it('24h expiry while queued: the buffered timed-out cause outranks the queue abort', async () => {
    vi.useFakeTimers()
    try {
      const f = makeHost()
      const service = new AcpDelegateService(f.host)
      const provider = new AcpSubagentProvider({ service })
      f.config.timeoutMs = DELEGATE_TIMEOUT_MAX_MS
      let releaseFirst!: () => void
      const gate = new Promise<void>(resolve => { releaseFirst = resolve })
      f.onPrompt(async (sessionId) => {
        await gate
        f.emit({ type: 'turn/end', sessionId, turnId: 't', stopReason: 'end_turn' })
        return { turnId: 't' }
      })
      // The predecessor holds the queue as a LEGACY-shape run (no absolute
      // timer of its own); its silence window is renewed mid-wait so it is
      // still alive when the queued native run's budget expires.
      const first = service.begin({ task: 'one', agent: 'alpha' }, {})
      await vi.advanceTimersByTimeAsync(1)
      const second = await provider.start(makeRequest({ label: 'alpha: two' }).request)
      await vi.advanceTimersByTimeAsync(1)
      expect(f.calls.startSession).toHaveLength(1) // the second waits in the queue
      await vi.advanceTimersByTimeAsync(DELEGATE_TIMEOUT_MAX_MS / 2)
      f.emit({ type: 'session/update', sessionId: 'session-1', seq: 1, update: chunk('still working') })
      await vi.advanceTimersByTimeAsync(DELEGATE_TIMEOUT_MAX_MS / 2 + 10)
      // The budget fired BEFORE the run installed its settle: the cause was
      // buffered, the queue wait aborted — the buffered cause must win.
      const result = await second.result
      expect(result.stopReason).toBe('error') // timed-out, NOT aborted
      expect(result.diagnostic).toContain('absolute budget')
      expect(result.diagnostic).not.toContain('aborted while queued')
      expect(f.calls.startSession).toHaveLength(1) // it never started a session
      releaseFirst()
      expect((await first.result).outcome).toBe('ended')
      // The expired delegation LEFT the queue: it never starts, even after the
      // predecessor finishes.
      expect(f.calls.startSession).toHaveLength(1)
      expect(vi.getTimerCount()).toBe(0) // no dangling timer after either settlement
    } finally {
      vi.useRealTimers()
    }
  })

  it('a normal end clears the absolute timer (nothing dangles)', async () => {
    vi.useFakeTimers()
    try {
      const { f, provider } = makeProvider()
      happyPrompt(f, 'done')
      const run = await provider.start(makeRequest().request)
      await run.result
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('an infrastructure rejection still settles: error + diagnostic, never a rejected result', async () => {
    const broken = {
      begin: (): AcpDelegateRunHandle => ({
        agentId: 'alpha',
        result: Promise.reject(new Error('core infrastructure fault')),
        dispose: async () => {},
      }),
    }
    const provider = new AcpSubagentProvider({ service: broken as unknown as AcpDelegateService })
    const run = await provider.start(makeRequest().request)
    const result: SubagentResult = await run.result
    expect(result.stopReason).toBe('error')
    expect(result.diagnostic).toBe('core infrastructure fault')
  })
})

describe('AcpSubagentProvider clean start failures (no catalog row, slot released)', () => {
  it('rejects a label without a legal agent id, an empty prompt, and an unknown agent — before any session', async () => {
    const { f, provider } = makeProvider()
    await expect(provider.start(makeRequest({ label: undefined as unknown as string }).request)).rejects.toThrow('label carries no agent id')
    await expect(provider.start(makeRequest({ label: 'not an id: task' }).request)).rejects.toThrow('label carries no agent id')
    await expect(provider.start(makeRequest({ prompt: [] }).request)).rejects.toThrow('prompt carries no text')
    await expect(provider.start(makeRequest({ label: 'nope: task' }).request)).rejects.toThrow('acp_delegate: unknown agent "nope"')
    expect(f.calls.startSession).toHaveLength(0)
    expect(f.sinkCount()).toBe(0)
  })

  it('a cwd fence refusal settles through result (the session never spawned)', async () => {
    const { f, provider } = makeProvider()
    f.onStart(async () => { throw new Error('cwd_denied: outside the fence') })
    const run = await provider.start(makeRequest().request)
    const result = await run.result
    expect(result.stopReason).toBe('error')
    expect(result.diagnostic).toContain('cwd_denied')
    expect(result.diagnostic).toContain('(agent alpha)')
    expect(f.calls.prompt).toHaveLength(0)
  })
})

// ---- four-axis customization: notes in the diagnostic, label carrier (T2) ----

describe('AcpSubagentProvider degradation notes', () => {
  it('a completed run with stale configured defaults carries the notes as diagnostic', async () => {
    const { f, provider } = makeProvider()
    f.config.agentDefaults = { alpha: { model: 'ghost-m' } }
    f.liveOptions.set('session-1', { configOptions: configOptionsOf(['m1']) })
    happyPrompt(f, 'answer with a note')
    const result = await (await provider.start(makeRequest().request)).result
    expect(result.stopReason).toBe('completed')
    expect(result.output).toEqual([{ type: 'text', text: 'answer with a note' }])
    expect(result.diagnostic).toBe('agent「alpha」不再提供默认模型「ghost-m」，本次使用 agent 自身默认模型')
    expect(f.notices).toHaveLength(1)
  })

  it('turnError and notes merge into ONE bounded diagnostic', async () => {
    const { f, provider } = makeProvider()
    f.config.agentDefaults = { alpha: { mode: 'ghost-o' } }
    f.liveOptions.set('session-1', { modes: modesOf('default') })
    f.onPrompt(async (sessionId) => {
      f.emit({ type: 'turn/end', sessionId, turnId: '', error: 'agent went silent (inactivity timeout)' })
      return { turnId: 'real' }
    })
    const result = await (await provider.start(makeRequest().request)).result
    expect(result.stopReason).toBe('error')
    expect(result.diagnostic).toBe('agent went silent (inactivity timeout)\nagent「alpha」不再提供默认模式「ghost-o」，本次使用启动模式')
  })

  it('an error outcome keeps BOTH the failure and the notes', async () => {
    const { f, provider } = makeProvider()
    f.config.agentDefaults = { alpha: { mode: 'ghost-o' } }
    f.liveOptions.set('session-1', { configOptions: configOptionsOf(['m1']), modes: modesOf('default') })
    const { request } = makeRequest({ label: delegateLabel('alpha', 'do it', { model: 'ghost-m' }) })
    const result = await (await provider.start(request)).result
    expect(result.stopReason).toBe('error')
    expect(result.diagnostic).toBe('acp_delegate: agent "alpha" does not offer model "ghost-m" (available: m1)\nagent「alpha」不再提供默认模式「ghost-o」，本次使用启动模式')
    expect(f.calls.prompt).toHaveLength(0)
  })

  it('an aborted run still reports its degradation notes', async () => {
    const { f, provider } = makeProvider()
    f.config.agentDefaults = { alpha: { effort: 'ghost-e' } }
    f.liveOptions.set('session-1', { configOptions: configOptionsOf(['m1'], ['high']) })
    f.onPrompt(() => new Promise(() => {}))
    const { request, controller } = makeRequest()
    const run = await provider.start(request)
    await tick()
    controller.abort()
    const result = await run.result
    expect(result.stopReason).toBe('aborted')
    expect(result.diagnostic).toBe('agent「alpha」的默认思考等级「ghost-e」不受当前模型支持，本次不设置')
  })

  it('a long turnError cannot eat the notes: they survive whole inside the bounded diagnostic', async () => {
    const { f, provider } = makeProvider()
    f.config.agentDefaults = { alpha: { mode: 'ghost-o' } }
    f.liveOptions.set('session-1', { modes: modesOf('default') })
    f.onPrompt(async (sessionId) => {
      f.emit({ type: 'turn/end', sessionId, turnId: '', error: 'x'.repeat(20_000) })
      return { turnId: 'real' }
    })
    const result = await (await provider.start(makeRequest().request)).result
    expect(result.stopReason).toBe('error')
    const notes = 'agent「alpha」不再提供默认模式「ghost-o」，本次使用启动模式'
    expect(result.diagnostic?.endsWith(`\n${notes}`)).toBe(true)
    expect(result.diagnostic).toContain('[diagnostic truncated]')
    expect(new TextEncoder().encode(result.diagnostic ?? '').byteLength).toBeLessThanOrEqual(MAX_DELEGATE_DIAGNOSTIC_BYTES)
  })

  it('a long prompt failure also keeps the notes whole', async () => {
    const { f, provider } = makeProvider()
    f.config.agentDefaults = { alpha: { mode: 'ghost-o' } }
    f.liveOptions.set('session-1', { modes: modesOf('default') })
    f.onPrompt(async () => { throw new Error('y'.repeat(20_000)) })
    const result = await (await provider.start(makeRequest().request)).result
    expect(result.stopReason).toBe('error')
    const notes = 'agent「alpha」不再提供默认模式「ghost-o」，本次使用启动模式'
    expect(result.diagnostic?.endsWith(`\n${notes}`)).toBe(true)
    expect(result.diagnostic).toContain('[diagnostic truncated]')
    expect(new TextEncoder().encode(result.diagnostic ?? '').byteLength).toBeLessThanOrEqual(MAX_DELEGATE_DIAGNOSTIC_BYTES)
  })
})

describe('AcpSubagentProvider label choice carrier', () => {
  it('explicit choices ride the label into begin losslessly (encode → decode → write)', async () => {
    const { f, provider } = makeProvider()
    f.liveOptions.set('session-1', { configOptions: configOptionsOf(['m1', 'a b&c=d'], ['high', 'low']), modes: modesOf('default', 'strict') })
    happyPrompt(f)
    // Values that NEED encodeURIComponent: the carrier must round-trip them.
    const choices = { model: 'a b&c=d', effort: 'low', mode: 'strict' }
    const { request } = makeRequest({ label: delegateLabel('alpha', 'do it', choices) })
    const result = await (await provider.start(request)).result
    expect(result.stopReason).toBe('completed')
    expect(f.calls.setMode).toEqual([{ sessionId: 'session-1', modeId: 'strict' }])
    expect(f.calls.setConfig).toEqual([
      { sessionId: 'session-1', configId: 'model', value: 'a b&c=d' },
      { sessionId: 'session-1', configId: 'thought', value: 'low' },
    ])
  })

  it('a partial carrier carries only its own axes', async () => {
    const { f, provider } = makeProvider()
    f.liveOptions.set('session-1', { configOptions: configOptionsOf(['m1', 'm2']) })
    happyPrompt(f)
    const { request } = makeRequest({ label: delegateLabel('alpha', 'do it', { model: 'm2' }) })
    await (await provider.start(request)).result
    expect(f.calls.setMode).toEqual([])
    expect(f.calls.setConfig).toEqual([{ sessionId: 'session-1', configId: 'model', value: 'm2' }])
  })

  it('a malformed carrier fails the start cleanly — no agent guess, no choices', async () => {
    const { f, provider } = makeProvider()
    for (const label of [
      'alpha ⟦m=x&bad=1⟧: task', // illegal key
      'alpha ⟦e=low&m=x⟧: task', // out-of-order keys
      'alpha ⟦m=%ZZ⟧: task', // broken encoding
      'alpha ⟦m=x⟧ extra: task', // carrier not the whole prefix
    ]) {
      await expect(provider.start(makeRequest({ label }).request)).rejects.toThrow('label carries no agent id')
    }
    expect(f.calls.startSession).toHaveLength(0)
  })
})