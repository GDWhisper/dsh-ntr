import { describe, expect, it, vi } from 'vitest'
import {
  AcpDelegateService,
  acpDelegateToolDefinition,
  type AcpDelegateExecute,
  type AcpDelegateHost,
  type AcpDelegatePolicy,
} from '../src/bridge/delegate-service.ts'
import { AcpDelegateRegistration, type DelegateRegistrationCtx } from '../src/bridge/delegate-registration.ts'
import type { AcpDelegateForceMask } from '../src/bridge/delegate-force-mask.ts'
import type { AcpEvent, AcpStartSessionOpts, DelegateGuidance } from '../src/protocol.ts'

/**
 * The delegation core (docs/plan/acp-delegate-subagent.md §7.1): one fake
 * in-memory host with a programmable prompt hook drives every runtime branch —
 * no child process, millisecond-scale.
 */

function chunk(text: string, meta?: Record<string, unknown>) {
  return { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text }, ...(meta === undefined ? {} : { _meta: meta }) }
}
const tick = () => new Promise(resolve => setTimeout(resolve, 10))
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

function makeHost() {
  const sinks = new Set<(event: AcpEvent) => void>()
  const emit = (event: AcpEvent) => { for (const sink of [...sinks]) sink(event) }
  const order: string[] = []
  const calls = {
    startSession: [] as Array<{ agentId: string; cwd?: string; opts?: AcpStartSessionOpts }>,
    policy: [] as Array<{ sessionId: string; policy: AcpDelegatePolicy }>,
    prompt: [] as Array<{ sessionId: string; text: string }>,
    cancel: [] as string[],
    close: [] as string[],
    respond: [] as Array<{ requestId: string; optionId?: string }>,
    transcript: [] as Array<{ sessionId: string; afterSeq?: number }>,
  }
  const config = { guidance: 'on' as DelegateGuidance, timeoutMs: 600_000 }
  const agents = [{ id: 'alpha', title: 'Alpha' }, { id: 'beta', title: 'Beta' }, { id: 'codebuddy', title: 'CodeBuddy' }]
  let defaultAgentId: string | undefined = 'alpha'
  let nextSession = 0
  const transcripts = new Map<string, Array<{ seq: number; update: unknown }>>()
  let onStart: ((agentId: string, cwd?: string, opts?: AcpStartSessionOpts) => Promise<{ sessionId: string; cwd: string }>) | undefined
  let onPrompt: ((sessionId: string, text: string) => Promise<{ turnId: string }>) | undefined
  const host: AcpDelegateHost = {
    hub: { subscribe(sink) { sinks.add(sink); return () => { sinks.delete(sink) } } },
    agents: () => agents,
    defaultAgent: () => defaultAgentId,
    delegateConfig: () => ({ ...config }),
    async startSession(agentId, cwd, opts) {
      order.push('start')
      calls.startSession.push({ agentId, ...(cwd === undefined ? {} : { cwd }), ...(opts === undefined ? {} : { opts }) })
      if (onStart !== undefined) return onStart(agentId, cwd, opts)
      const sessionId = `session-${String(++nextSession)}`
      if (!transcripts.has(sessionId)) transcripts.set(sessionId, [])
      // The real host answers with the RESOLVED cwd; the fake echoes the
      // request, falling back to the agent default the way resolveSessionCwd does.
      return { sessionId, cwd: cwd ?? '/agent-default' }
    },
    setPermissionPolicy(sessionId, policy) { order.push('policy'); calls.policy.push({ sessionId, policy }) },
    async prompt(sessionId, text) {
      order.push('prompt')
      calls.prompt.push({ sessionId, text })
      if (onPrompt !== undefined) return onPrompt(sessionId, text)
      return { turnId: `turn-${sessionId}` }
    },
    async cancel(sessionId) { order.push('cancel'); calls.cancel.push(sessionId) },
    async closeSession(sessionId) { order.push('close'); calls.close.push(sessionId) },
    transcript(sessionId, afterSeq) {
      order.push('transcript')
      calls.transcript.push({ sessionId, afterSeq })
      const entries = transcripts.get(sessionId) ?? []
      return { session: {}, entries: entries.filter(entry => entry.seq > (afterSeq ?? 0)) }
    },
  }
  return {
    host, emit, calls, order, config, transcripts,
    sinkCount: () => sinks.size,
    setDefault: (id: string | undefined) => { defaultAgentId = id },
    onStart: (fn: typeof onStart) => { onStart = fn },
    onPrompt: (fn: typeof onPrompt) => { onPrompt = fn },
  }
}
type Fake = ReturnType<typeof makeHost>

/** The standard happy path: chunks fold incrementally, close exactly once. */
function happyPrompt(f: Fake, answer = 'the answer') {
  f.onPrompt(async (sessionId) => {
    f.emit({ type: 'session/update', sessionId, seq: 1, update: chunk(answer) })
    f.emit({ type: 'turn/end', sessionId, turnId: 'turn-1', stopReason: 'end_turn' })
    return { turnId: 'turn-1' }
  })
}

describe('acp_delegate execute semantics', () => {
  it('runs one delegation: session → policy → prompt(task) → fold → close once', async () => {
    const f = makeHost()
    happyPrompt(f, 'Hello world')
    const result = await new AcpDelegateService(f.host).execute({ task: 'do it', agent: 'alpha' }, {})
    expect(f.calls.startSession).toEqual([{ agentId: 'alpha', opts: { extraRoots: [], alignSpawnCwd: true } }])
    expect(f.order.indexOf('policy')).toBeLessThan(f.order.indexOf('prompt'))
    expect(f.calls.prompt).toEqual([{ sessionId: 'session-1', text: 'do it' }])
    expect(result.text).toContain('Hello world')
    expect(result.text).toContain('— acp_delegate · alpha · cwd=/agent-default · end_turn')
    expect(result.agent).toBe('alpha')
    expect(result.stopReason).toBe('end_turn')
    expect(result.error).toBeUndefined()
    expect(f.calls.close).toEqual(['session-1'])
    expect(f.sinkCount()).toBe(0)
  })

  it('auto: policy {auto,0,preferOnce} and counts permission/expired outcomes', async () => {
    const f = makeHost()
    f.onPrompt(async (sessionId) => {
      f.emit({ type: 'permission/expired', sessionId, toolCall: {}, timeoutMs: 0, outcome: { outcome: 'selected', optionId: 'allow_once' }, optionName: 'Allow once' })
      f.emit({ type: 'permission/expired', sessionId, toolCall: {}, timeoutMs: 0, outcome: { outcome: 'cancelled' } })
      f.emit({ type: 'turn/end', sessionId, turnId: 't', stopReason: 'end_turn' })
      return { turnId: 't' }
    })
    const result = await new AcpDelegateService(f.host).execute({ task: 'x', agent: 'alpha' }, {})
    expect(f.calls.policy[0].policy).toEqual({ mode: 'auto', windowMs: 0, preferOnce: true })
    expect(f.calls.respond).toHaveLength(0) // auto+0 never broadcasts a request frame
    expect(result.text).toContain('拒绝 1 个审批')
    expect(result.text).toContain('自动代答 1 个')
  })

  it('auto on A1 (codebuddy): preferOnce false — the ephemeral process cannot leak', async () => {
    const f = makeHost()
    happyPrompt(f)
    await new AcpDelegateService(f.host).execute({ task: 'x', agent: 'codebuddy' }, {})
    expect(f.calls.policy[0].policy).toEqual({ mode: 'auto', windowMs: 0, preferOnce: false })
  })

  it('policy is always auto: the service never answers a request frame itself', async () => {
    const f = makeHost()
    f.onPrompt(async (sessionId) => {
      // The permission-mode axis is retired: even if a request frame somehow
      // arrives, the service does not answer it — the policy is auto+0 and the
      // bridge settles every ask in place (no frame is broadcast in practice).
      f.emit({ type: 'permission/request', requestId: 'req-1', sessionId, toolCall: {}, toolName: 'fs/write', options: [], timeoutMode: 'auto' })
      f.emit({ type: 'turn/end', sessionId, turnId: 't', stopReason: 'end_turn' })
      return { turnId: 't' }
    })
    const result = await new AcpDelegateService(f.host).execute({ task: 'x', agent: 'alpha' }, {})
    expect(f.calls.policy[0].policy).toEqual({ mode: 'auto', windowMs: 0, preferOnce: true })
    expect(f.calls.respond).toHaveLength(0)
    expect(result.text).not.toContain('拒绝')
  })

  it('rejects an unknown agent without creating a session, listing configured ids', async () => {
    const f = makeHost()
    const service = new AcpDelegateService(f.host)
    await expect(service.execute({ task: 'x', agent: 'nope' }, {})).rejects.toThrow('acp_delegate: unknown agent "nope" (configured: alpha, beta, codebuddy)')
    expect(f.calls.startSession).toHaveLength(0)
  })

  it('rejects a missing/empty/non-string task before any session', async () => {
    const f = makeHost()
    const service = new AcpDelegateService(f.host)
    for (const args of [{}, { task: '' }, { task: '   ' }, { task: 42 }]) {
      await expect(service.execute(args, {})).rejects.toThrow('acp_delegate: task must be a non-empty string')
    }
    expect(f.calls.startSession).toHaveLength(0)
  })

  it('silence timeout: no events after the prompt → throws "of silence", cancel + close called, self-settles', async () => {
    const f = makeHost()
    f.config.timeoutMs = 40
    f.onPrompt(() => new Promise(() => {})) // the prompt never answers, no turn/end ever
    const started = Date.now()
    await expect(new AcpDelegateService(f.host).execute({ task: 'x', agent: 'alpha' }, {})).rejects.toThrow('acp_delegate: timed out after 40ms of silence')
    expect(Date.now() - started).toBeLessThan(2_000) // settled without waiting for a turn/end after close
    expect(f.calls.cancel).toEqual(['session-1'])
    expect(f.calls.close).toEqual(['session-1'])
    expect(f.order.indexOf('cancel')).toBeLessThan(f.order.indexOf('close'))
    expect(f.sinkCount()).toBe(0)
  })

  it('exec.signal abort mid-turn: cancel + close, prompt settle', async () => {
    const f = makeHost()
    f.onPrompt(() => new Promise(() => {}))
    const controller = new AbortController()
    const promise = new AcpDelegateService(f.host).execute({ task: 'x', agent: 'alpha' }, { signal: controller.signal })
    await tick()
    controller.abort()
    await expect(promise).rejects.toThrow('acp_delegate: aborted')
    expect(f.calls.cancel).toEqual(['session-1'])
    expect(f.calls.close).toEqual(['session-1'])
    expect(f.sinkCount()).toBe(0)
  })

  it('watchdog error-only turn/end (turnId ""): error in footer and result, no hang', async () => {
    const f = makeHost()
    f.onPrompt(async (sessionId) => {
      f.emit({ type: 'turn/end', sessionId, turnId: '', error: 'agent went silent (inactivity timeout)' })
      return { turnId: 'real-turn' }
    })
    const result = await new AcpDelegateService(f.host).execute({ task: 'x', agent: 'alpha' }, {})
    expect(result.error).toBe('agent went silent (inactivity timeout)')
    expect(result.stopReason).toBeUndefined()
    expect(result.text).toContain('(the agent returned no text)')
    expect(result.text).toContain('agent went silent (inactivity timeout)')
    expect(f.calls.close).toEqual(['session-1'])
  })

  it('folds >600 updates incrementally: early chunks survive the ring eviction', async () => {
    const f = makeHost()
    f.onPrompt(async (sessionId) => {
      for (let i = 0; i < 700; i += 1) f.emit({ type: 'session/update', sessionId, seq: i + 1, update: chunk(`c${String(i)};`) })
      // The transcript ring only keeps the LAST 600 entries — a transcript-only
      // fold would lose c0…c99.
      f.transcripts.set(sessionId, Array.from({ length: 700 }, (_, i) => ({ seq: i + 1, update: chunk(`c${String(i)};`) })).slice(-600))
      f.emit({ type: 'turn/end', sessionId, turnId: 't', stopReason: 'end_turn' })
      return { turnId: 't' }
    })
    const result = await new AcpDelegateService(f.host).execute({ task: 'x', agent: 'alpha' }, {})
    expect(result.text).toContain('c0;')
    expect(result.text).toContain('c699;')
    expect(f.calls.transcript).toHaveLength(0) // the fallback never ran
  })

  it('skips parentToolCallId chunks and dedupes by seq', async () => {
    const f = makeHost()
    f.onPrompt(async (sessionId) => {
      f.emit({ type: 'session/update', sessionId, seq: 1, update: chunk('mine') })
      f.emit({ type: 'session/update', sessionId, seq: 2, update: chunk('worker prose', { 'codebuddy.ai/parentToolCallId': 'call-9' }) })
      f.emit({ type: 'session/update', sessionId, seq: 1, update: chunk('DUPLICATE') })
      f.emit({ type: 'session/update', sessionId, seq: 3, update: chunk(' tail') })
      f.emit({ type: 'turn/end', sessionId, turnId: 't', stopReason: 'end_turn' })
      return { turnId: 't' }
    })
    const result = await new AcpDelegateService(f.host).execute({ task: 'x', agent: 'alpha' }, {})
    expect(result.text).toContain('mine tail')
    expect(result.text).not.toContain('worker prose')
    expect(result.text).not.toContain('DUPLICATE')
  })

  it('returns an over-cap answer in full: no truncation, no marker (regression guard)', async () => {
    const f = makeHost()
    // 240k chars — far beyond the retired 200000-char cap: every chunk must survive.
    const head = 'H'.repeat(120_000)
    const tail = 'T'.repeat(120_000)
    f.onPrompt(async (sessionId) => {
      f.emit({ type: 'session/update', sessionId, seq: 1, update: chunk(head) })
      f.emit({ type: 'session/update', sessionId, seq: 2, update: chunk(tail) })
      f.emit({ type: 'turn/end', sessionId, turnId: 't', stopReason: 'end_turn' })
      return { turnId: 't' }
    })
    const result = await new AcpDelegateService(f.host).execute({ task: 'x', agent: 'alpha' }, {})
    const body = result.text.split('\n\n— acp_delegate')[0]
    expect(body).toBe(head + tail)
    expect(result.text).not.toContain('truncated')
  })

  it('empty live text: reads the transcript ONCE before close, same extraction rules', async () => {
    const f = makeHost()
    f.onPrompt(async (sessionId) => {
      f.emit({ type: 'turn/end', sessionId, turnId: 't', stopReason: 'end_turn' })
      return { turnId: 't' }
    })
    f.transcripts.set('session-1', [
      { seq: 1, update: chunk('from transcript') },
      { seq: 2, update: chunk(' worker', { 'codebuddy.ai/parentToolCallId': 'call-1' }) },
    ])
    const result = await new AcpDelegateService(f.host).execute({ task: 'x', agent: 'alpha' }, {})
    expect(result.text).toContain('from transcript')
    expect(result.text).not.toContain('worker')
    expect(f.calls.transcript).toEqual([{ sessionId: 'session-1', afterSeq: 0 }])
    expect(f.order.indexOf('transcript')).toBeLessThan(f.order.indexOf('close'))
  })

  it('empty everywhere: the placeholder answer, still a normal return', async () => {
    const f = makeHost()
    happyPrompt(f, '')
    const result = await new AcpDelegateService(f.host).execute({ task: 'x', agent: 'alpha' }, {})
    expect(result.text).toContain('(the agent returned no text)')
    expect(result.text).toContain('end_turn')
  })

  it('serializes two delegations to the same non-A1 agent without error', async () => {
    const f = makeHost()
    let releaseFirst!: () => void
    const gate = new Promise<void>(resolve => { releaseFirst = resolve })
    let count = 0
    f.onPrompt(async (sessionId) => {
      count += 1
      if (count === 1) await gate
      f.emit({ type: 'turn/end', sessionId, turnId: `t${String(count)}`, stopReason: 'end_turn' })
      return { turnId: `t${String(count)}` }
    })
    const service = new AcpDelegateService(f.host)
    const first = service.execute({ task: 'one', agent: 'alpha' }, {})
    await tick()
    const second = service.execute({ task: 'two', agent: 'alpha' }, {})
    await tick()
    expect(f.calls.startSession).toHaveLength(1) // the second waits in the queue
    releaseFirst()
    await Promise.all([first, second])
    expect(f.calls.startSession).toHaveLength(2)
    expect(f.calls.prompt.map(call => call.text)).toEqual(['one', 'two'])
  })

  it('runs different agents (and A1 delegations) in parallel', async () => {
    const f = makeHost()
    const gates: Record<string, () => void> = {}
    f.onPrompt(sessionId => new Promise<{ turnId: string }>(resolve => {
      gates[sessionId] = () => {
        f.emit({ type: 'turn/end', sessionId, turnId: 't', stopReason: 'end_turn' })
        resolve({ turnId: 't' })
      }
    }))
    const service = new AcpDelegateService(f.host)
    const a = service.execute({ task: 'a', agent: 'alpha' }, {})
    const b = service.execute({ task: 'b', agent: 'beta' }, {})
    const c1 = service.execute({ task: 'c1', agent: 'codebuddy' }, {})
    const c2 = service.execute({ task: 'c2', agent: 'codebuddy' }, {})
    await tick()
    expect(f.calls.startSession).toHaveLength(4) // nothing queued
    for (const gate of Object.values(gates)) gate()
    await Promise.all([a, b, c1, c2])
  })

  it('a queued delegation leaves the queue when exec.signal aborts', async () => {
    const f = makeHost()
    let releaseFirst!: () => void
    const gate = new Promise<void>(resolve => { releaseFirst = resolve })
    let count = 0
    f.onPrompt(async (sessionId) => {
      count += 1
      if (count === 1) await gate
      f.emit({ type: 'turn/end', sessionId, turnId: 't', stopReason: 'end_turn' })
      return { turnId: 't' }
    })
    const service = new AcpDelegateService(f.host)
    const first = service.execute({ task: 'one', agent: 'alpha' }, {})
    await tick()
    const controller = new AbortController()
    const second = service.execute({ task: 'two', agent: 'alpha' }, { signal: controller.signal })
    await tick()
    controller.abort()
    await expect(second).rejects.toThrow('acp_delegate: aborted while queued')
    expect(f.calls.startSession).toHaveLength(1) // the queued one never started a session
    releaseFirst()
    await first // the running delegation is unaffected
    expect(f.calls.startSession).toHaveLength(1)
  })

  it('passes cwd_denied / bad_cwd / no_cwd through with the agent id', async () => {
    for (const code of ['cwd_denied', 'bad_cwd', 'no_cwd']) {
      const f = makeHost()
      f.onStart(async () => { throw new Error(`${code}: the workspace fence refused`) })
      await expect(new AcpDelegateService(f.host).execute({ task: 'x', agent: 'alpha', cwd: '/outside' }, {}))
        .rejects.toThrow(`acp_delegate: ${code}: the workspace fence refused (agent alpha)`)
      expect(f.calls.policy).toHaveLength(0)
      expect(f.calls.prompt).toHaveLength(0)
    }
  })

  it('omitted agent uses defaultAgent(); no default with several agents demands a name', async () => {
    const f = makeHost()
    happyPrompt(f)
    await new AcpDelegateService(f.host).execute({ task: 'x' }, {})
    expect(f.calls.startSession[0].agentId).toBe('alpha')
    f.setDefault(undefined)
    await expect(new AcpDelegateService(f.host).execute({ task: 'x' }, {}))
      .rejects.toThrow('acp_delegate: no default agent configured; name one explicitly (configured: alpha, beta, codebuddy)')
  })

  it('a rejected prompt surfaces as an acp_delegate error after cleanup', async () => {
    const f = makeHost()
    f.onPrompt(async () => { throw new Error('turn_in_flight') })
    await expect(new AcpDelegateService(f.host).execute({ task: 'x', agent: 'alpha' }, {}))
      .rejects.toThrow('acp_delegate: turn_in_flight')
    expect(f.calls.close).toEqual(['session-1'])
    expect(f.sinkCount()).toBe(0)
  })
})

/**
 * The rolling silence window: only silence counts, activity of THIS session
 * renews it (any session/update kind, permission settlements), and settlement
 * disarms it for good. Same short-real-window timing as the rest of this file
 * (generous margins); fake timers only where the assertion must inspect the
 * timer queue itself (no re-arm after settle).
 */
describe('acp_delegate silence window', () => {
  /** Run one open turn (prompt answers, no turn/end) and capture its outcome. */
  function openTurn(f: Fake) {
    f.onPrompt(async () => ({ turnId: 't' }))
    let finished = false
    const outcome = new AcpDelegateService(f.host).execute({ task: 'x', agent: 'alpha' }, {}).then(
      () => { finished = true; return '' },
      (error: unknown) => { finished = true; return error instanceof Error ? error.message : String(error) },
    )
    return { outcome, stillPending: () => !finished }
  }

  it('activity renews: an agent_message_chunk keeps it alive past the original deadline, silence then fires', async () => {
    const f = makeHost()
    f.config.timeoutMs = 150
    const { outcome, stillPending } = openTurn(f)
    await wait(80)
    f.emit({ type: 'session/update', sessionId: 'session-1', seq: 1, update: chunk('still working') })
    await wait(80) // t≈160 — past the ORIGINAL 150ms deadline; the renewal kept it alive
    expect(stillPending()).toBe(true)
    expect(await outcome).toBe('acp_delegate: timed out after 150ms of silence') // silence from t≈80 fires at ≈230
    expect(f.calls.cancel).toEqual(['session-1'])
    expect(f.calls.close).toEqual(['session-1'])
    expect(f.sinkCount()).toBe(0)
  })

  it('activity renews: a tool_call_update progress frame is activity too, not just message chunks', async () => {
    const f = makeHost()
    f.config.timeoutMs = 150
    const { outcome, stillPending } = openTurn(f)
    await wait(80)
    f.emit({ type: 'session/update', sessionId: 'session-1', seq: 1, update: { sessionUpdate: 'tool_call_update', toolCallId: 'call-1', status: 'in_progress' } })
    await wait(80) // past the original deadline again — the tool frame renewed it
    expect(stillPending()).toBe(true)
    expect(await outcome).toBe('acp_delegate: timed out after 150ms of silence')
  })

  it('activity renews: a permission/expired settlement of this session', async () => {
    const f = makeHost()
    f.config.timeoutMs = 150
    const { outcome, stillPending } = openTurn(f)
    await wait(80)
    f.emit({ type: 'permission/expired', sessionId: 'session-1', toolCall: {}, timeoutMs: 0, outcome: { outcome: 'selected', optionId: 'allow_once' } })
    await wait(80)
    expect(stillPending()).toBe(true)
    expect(await outcome).toBe('acp_delegate: timed out after 150ms of silence')
  })

  it('another session\'s events never renew this window', async () => {
    const f = makeHost()
    f.config.timeoutMs = 150
    const started = Date.now()
    const { outcome } = openTurn(f)
    await wait(60)
    f.emit({ type: 'session/update', sessionId: 'session-other', seq: 1, update: chunk('noise') })
    await wait(60) // t≈120
    f.emit({ type: 'permission/expired', sessionId: 'session-other', toolCall: {}, timeoutMs: 0, outcome: { outcome: 'selected', optionId: 'allow_once' } })
    expect(await outcome).toBe('acp_delegate: timed out after 150ms of silence')
    // A foreign renewal at t≈120 would have pushed the deadline to ≈270ms.
    expect(Date.now() - started).toBeLessThan(225)
  })

  it('late events after settlement never re-arm: no dangling timer, no second settle', async () => {
    vi.useFakeTimers()
    try {
      const f = makeHost()
      f.config.timeoutMs = 1_000
      // Park the cleanup at cancel so late events arrive BEFORE the finally
      // unsubscribe: they reach the live sink, and the outcome guard — not the
      // unsubscribe — must be what refuses the re-arm.
      let releaseCancel!: () => void
      const gate = new Promise<void>(resolve => { releaseCancel = resolve })
      const originalCancel = f.host.cancel
      f.host.cancel = async (sessionId) => { await gate; await originalCancel(sessionId) }
      const outcome = new AcpDelegateService(f.host).execute({ task: 'x', agent: 'alpha' }, {}).then(
        () => 'resolved',
        (error: unknown) => (error instanceof Error ? error.message : String(error)),
      )
      await vi.advanceTimersByTimeAsync(1_000) // silence fires; cleanup parks at the gate
      expect(f.sinkCount()).toBe(1) // still subscribed mid-cleanup
      expect(f.calls.cancel).toHaveLength(0) // parked inside cancel, before it records
      f.emit({ type: 'session/update', sessionId: 'session-1', seq: 9, update: chunk('late') })
      f.emit({ type: 'permission/expired', sessionId: 'session-1', toolCall: {}, timeoutMs: 0, outcome: { outcome: 'cancelled' } })
      expect(vi.getTimerCount()).toBe(0) // the guard refused to re-arm after settle
      releaseCancel()
      expect(await outcome).toBe('acp_delegate: timed out after 1000ms of silence')
      expect(vi.getTimerCount()).toBe(0) // nothing dangling after the run either
      expect(f.calls.cancel).toEqual(['session-1'])
      expect(f.calls.close).toEqual(['session-1'])
      expect(f.sinkCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
})

/**
 * Workspace inheritance (plan §3, user ruling): an omitted cwd inherits the
 * CALLING DSH session's workspace (`exec.agent.session.header.cwd` — the same
 * root the chat path trusts); an explicit cwd is validated against the agent's
 * roots PLUS that workspace. No usable header cwd degrades to the old
 * behaviour without an error. The fence itself stays the bridge's pipeline.
 */
describe('acp_delegate workspace inheritance', () => {
  const WS = 'M:/Coding/main-project'
  const execWithWs = { agent: { session: { header: { cwd: WS } } } }

  it('omitted cwd inherits the session workspace: cwd + extraRoots + alignSpawnCwd, footer reports it', async () => {
    const f = makeHost()
    happyPrompt(f, 'done')
    const result = await new AcpDelegateService(f.host).execute({ task: 'x', agent: 'alpha' }, execWithWs)
    expect(f.calls.startSession).toEqual([{ agentId: 'alpha', cwd: WS, opts: { extraRoots: [WS], alignSpawnCwd: true } }])
    expect(result.text).toContain(`— acp_delegate · alpha · cwd=${WS} · end_turn`)
  })

  it('explicit cwd keeps its own directory and carries the session workspace as the ONE extra root', async () => {
    const f = makeHost()
    happyPrompt(f)
    const sub = `${WS}/packages/sub`
    const result = await new AcpDelegateService(f.host).execute({ task: 'x', agent: 'alpha', cwd: sub }, execWithWs)
    expect(f.calls.startSession).toEqual([{ agentId: 'alpha', cwd: sub, opts: { extraRoots: [WS], alignSpawnCwd: true } }])
    expect(result.text).toContain(`cwd=${sub}`)
  })

  it('A1 (codebuddy) inherits the same way, straight through without a queue', async () => {
    const f = makeHost()
    happyPrompt(f)
    await new AcpDelegateService(f.host).execute({ task: 'x', agent: 'codebuddy' }, execWithWs)
    expect(f.calls.startSession).toEqual([{ agentId: 'codebuddy', cwd: WS, opts: { extraRoots: [WS], alignSpawnCwd: true } }])
  })

  it('the footer reports the RESOLVED cwd the host answered, not the requested spelling', async () => {
    const f = makeHost()
    happyPrompt(f)
    f.onStart(async () => ({ sessionId: 'session-resolved', cwd: 'M:/Coding/main-project-canonical' }))
    const result = await new AcpDelegateService(f.host).execute({ task: 'x', agent: 'alpha' }, { agent: { session: { header: { cwd: 'M:\\Coding\\main-project' } } } })
    expect(f.calls.startSession[0].cwd).toBe('M:\\Coding\\main-project')
    expect(result.text).toContain('— acp_delegate · alpha · cwd=M:/Coding/main-project-canonical · end_turn')
  })

  it('degrades without a usable header cwd: missing/odd shapes never throw, extraRoots stay empty', async () => {
    const execs = [
      {},
      { agent: {} },
      { agent: { session: {} } },
      { agent: { session: { header: {} } } },
      { agent: { session: { header: { cwd: 'relative/path' } } } },
      { agent: { session: { header: { cwd: '' } } } },
      { agent: { session: { header: { cwd: 42 } } } },
      { agent: 'primitive' },
      { agent: { session: null } },
    ]
    for (const exec of execs) {
      const f = makeHost()
      happyPrompt(f)
      const result = await new AcpDelegateService(f.host).execute({ task: 'x', agent: 'alpha' }, exec as never)
      expect(f.calls.startSession).toEqual([{ agentId: 'alpha', opts: { extraRoots: [], alignSpawnCwd: true } }])
      expect(result.text).toContain('cwd=/agent-default')
    }
  })

  it('a degraded explicit cwd still passes through with an empty extra-root list', async () => {
    const f = makeHost()
    happyPrompt(f)
    await new AcpDelegateService(f.host).execute({ task: 'x', agent: 'alpha', cwd: '/some/other/dir' }, {})
    expect(f.calls.startSession).toEqual([{ agentId: 'alpha', cwd: '/some/other/dir', opts: { extraRoots: [], alignSpawnCwd: true } }])
  })

  it('the cwd parameter description states inheritance and the fence', () => {
    const definition = acpDelegateToolDefinition({ guidance: 'on', execute: async () => ({ text: '', agent: '' }) })
    const cwd = (definition.parameters.properties as Record<string, { description: string }>).cwd
    expect(cwd.description).toContain('省略 = 继承调用会话工作区')
    expect(cwd.description).toContain('allowedCwdRoots')
  })
})

describe('acp_delegate tool definition (register-ready)', () => {
  const execute: AcpDelegateExecute = async () => ({ text: 'ok', agent: 'a' })

  it('has the fixed shape: name, required task, render, fixed 24h backstop budget, lossless JSON', () => {
    const definition = acpDelegateToolDefinition({ guidance: 'on', execute })
    expect(definition.name).toBe('acp_delegate')
    expect(definition.parameters.required).toEqual(['task'])
    expect(Object.keys(definition.parameters.properties as Record<string, unknown>)).toEqual(['task', 'agent', 'cwd'])
    expect(typeof definition.output.render).toBe('function')
    expect(definition.output.render({}, { text: 'hi' })).toEqual([{ type: 'text', text: 'hi' }])
    expect(definition.output.render({}, undefined)).toEqual([{ type: 'text', text: '' }])
    expect(definition.output.schema.required).toEqual(['text'])
    // The host budget is the FIXED 24h absolute backstop — never the configured
    // silence window plus a grace (the window is read live per execute).
    expect(definition.timeoutMs).toBe(86_400_000)
    expect(definition.execute).toBe(execute)
    expect(JSON.parse(JSON.stringify(definition.parameters))).toEqual(definition.parameters)
    expect(JSON.parse(JSON.stringify(definition.output.schema))).toEqual(definition.output.schema)
  })

  it('composes the description by guidance rung', () => {
    for (const guidance of ['off', 'on'] as const) {
      const definition = acpDelegateToolDefinition({ guidance, execute })
      expect(definition.description).toContain('把一件自成一体的任务交给一个已配置的外部 ACP agent')
      expect(definition.description).not.toContain('必须使用本工具')
      expect(definition.timeoutMs).toBe(86_400_000) // the backstop is rung-independent too
    }
    for (const guidance of ['enhanced', 'force'] as const) {
      const definition = acpDelegateToolDefinition({ guidance, execute })
      expect(definition.description).toContain('需要派发子代理时，必须使用本工具，优先于任何原生子代理/委派工具。')
      expect(definition.timeoutMs).toBe(86_400_000)
    }
  })

  it('execute returns the report text with the footer', async () => {
    const f = makeHost()
    happyPrompt(f, 'done')
    const definition = acpDelegateToolDefinition({ guidance: 'on', execute: new AcpDelegateService(f.host).execute })
    const value = await definition.execute({ task: 'x', agent: 'alpha' }, {})
    expect(value.text).toContain('done')
    expect(value.text).toContain('— acp_delegate · alpha · cwd=/agent-default · end_turn')
    expect(definition.output.render({}, value)).toEqual([{ type: 'text', text: value.text }])
  })
})

// ---- registration (§5.3) ----

function fakeMask() {
  return { apply: vi.fn(), clear: vi.fn(), available: true } as unknown as AcpDelegateForceMask & { apply: ReturnType<typeof vi.fn>; clear: ReturnType<typeof vi.fn> }
}

function fakeToolsCtx(mode: 'disposer' | 'none' | 'throw' = 'disposer') {
  const registered: Array<{ definition: { name: string; description: string; timeoutMs: number; execute: AcpDelegateExecute }; options?: { when?: (ctx: { agent?: unknown }) => boolean } }> = []
  let disposerCalls = 0
  let injectCallback: (() => void) | undefined
  let tools: unknown
  let liveMode = mode
  const install = () => {
    tools = {
      get: (name: string) => registered.find(row => row.definition.name === name)?.definition,
      register: (definition: { name: string; description: string; timeoutMs: number; execute: AcpDelegateExecute }, options?: { when?: (ctx: { agent?: unknown }) => boolean }) => {
        if (liveMode === 'throw') throw new TypeError('output.render is required')
        registered.push({ definition, options })
        if (liveMode === 'none') return undefined
        return () => {
          disposerCalls += 1
          const index = registered.findIndex(row => row.definition === definition)
          if (index >= 0) registered.splice(index, 1)
        }
      },
    }
  }
  const ctx: DelegateRegistrationCtx = {
    get: (name: string) => (name === 'tools' ? tools : undefined),
    inject: (_names: string[], callback: () => void) => { injectCallback = callback },
  }
  return { ctx, registered, install, setMode: (next: 'disposer' | 'none' | 'throw') => { liveMode = next }, disposerCalls: () => disposerCalls, fireInject: () => { injectCallback?.() }, injectArmed: () => injectCallback !== undefined }
}

function makeRegistration(ctx: DelegateRegistrationCtx) {
  const f = makeHost()
  const config = { guidance: 'off' as DelegateGuidance, timeoutMs: 600_000 }
  const mask = fakeMask()
  const notices: string[] = []
  const registration = new AcpDelegateRegistration({
    ctx,
    service: new AcpDelegateService(f.host),
    config: () => ({ ...config }),
    forceMask: mask,
    notify: text => { notices.push(text) },
  })
  return { registration, config, mask, notices, f }
}

describe('acp_delegate registration sync', () => {
  it('off registers nothing; on/enhanced/force register once and stay idempotent', () => {
    const tools = fakeToolsCtx()
    tools.install()
    const { registration, config, mask } = makeRegistration(tools.ctx)
    registration.sync()
    expect(tools.registered).toHaveLength(0)
    // Capable host: off must not claim a missing tool service.
    expect(registration.toolAvailable).toBe(true)
    for (const guidance of ['on', 'enhanced', 'force'] as const) {
      config.guidance = guidance
      registration.sync()
      registration.sync() // idempotent
      expect(tools.registered).toHaveLength(1)
      expect(tools.registered[0].definition.name).toBe('acp_delegate')
      expect(registration.toolAvailable).toBe(true)
      if (guidance === 'force') expect(mask.apply).toHaveBeenCalled()
      else expect(mask.clear).toHaveBeenCalled()
      config.guidance = 'off'
      registration.sync()
      expect(tools.registered).toHaveLength(0)
    }
  })

  it('off calls the disposer exactly once and clears the mask', () => {
    const tools = fakeToolsCtx()
    tools.install()
    const { registration, config, mask } = makeRegistration(tools.ctx)
    config.guidance = 'force'
    registration.sync()
    config.guidance = 'off'
    registration.sync()
    registration.sync()
    expect(tools.disposerCalls()).toBe(1)
    expect(registration.toolAvailable).toBe(true) // service offered; off is a user choice, not a host gap
    expect(mask.clear).toHaveBeenCalled()
  })

  it('re-registers on guidance or timeoutMs change; the budget stays the fixed 24h backstop', () => {
    const tools = fakeToolsCtx()
    tools.install()
    const { registration, config } = makeRegistration(tools.ctx)
    config.guidance = 'on'
    registration.sync()
    expect(tools.registered[0].definition.description).not.toContain('必须使用本工具')
    config.guidance = 'enhanced'
    registration.sync()
    expect(tools.disposerCalls()).toBe(1)
    expect(tools.registered).toHaveLength(1)
    expect(tools.registered[0].definition.description).toContain('必须使用本工具')
    config.timeoutMs = 300_000
    registration.sync()
    expect(tools.disposerCalls()).toBe(2) // the settings signature still re-registers on a window change
    // The configured silence window never bakes into the host budget.
    expect(tools.registered[0].definition.timeoutMs).toBe(86_400_000)
  })

  it('when excludes NTR sessions and never throws on odd shapes', () => {
    const tools = fakeToolsCtx()
    tools.install()
    const { registration, config } = makeRegistration(tools.ctx)
    config.guidance = 'on'
    registration.sync()
    const when = tools.registered[0].options?.when
    expect(when).toBeDefined()
    expect(when!({ agent: { session: { header: { agentPreset: 'acp' } } } })).toBe(false)
    expect(when!({ agent: { session: { header: { agentPreset: 'standard' } } } })).toBe(true)
    expect(when!({})).toBe(true)
    expect(when!({ agent: undefined })).toBe(true)
    expect(when!({ agent: 'primitive' })).toBe(true)
    expect(() => when!(undefined as never)).not.toThrow()
  })

  it('a late tools service registers through the inject seam', () => {
    const tools = fakeToolsCtx() // not installed yet
    const { registration, config } = makeRegistration(tools.ctx)
    config.guidance = 'on'
    registration.sync()
    expect(tools.registered).toHaveLength(0)
    expect(tools.injectArmed()).toBe(true)
    tools.install()
    tools.fireInject()
    expect(tools.registered).toHaveLength(1)
    expect(registration.toolAvailable).toBe(true)
  })

  it('a throwing register reports toolAvailable=false with the reason', () => {
    const tools = fakeToolsCtx('throw')
    tools.install()
    const { registration, config, notices } = makeRegistration(tools.ctx)
    config.guidance = 'on'
    registration.sync()
    expect(registration.toolAvailable).toBe(false)
    expect(notices).toHaveLength(1)
    expect(notices[0]).toContain('output.render is required')
  })

  it('no disposer (old host): permanent registration, off answers the disabled text', async () => {
    const tools = fakeToolsCtx('none')
    tools.install()
    const { registration, config, f } = makeRegistration(tools.ctx)
    config.guidance = 'on'
    registration.sync()
    expect(registration.toolAvailable).toBe(true) // the tool IS still registered
    const definition = tools.registered[0].definition
    config.guidance = 'off'
    registration.sync() // cannot remove; the wrapper must intercept
    expect(tools.registered).toHaveLength(1)
    await expect(definition.execute({ task: 'x' }, {})).resolves.toEqual({ text: 'acp_delegate is disabled', agent: '' })
    expect(f.calls.startSession).toHaveLength(0)
    // Back on: the wrapper delegates to the live service again.
    config.guidance = 'on'
    happyPrompt(f, 'alive')
    const value = await definition.execute({ task: 'x', agent: 'alpha' }, {})
    expect(value.text).toContain('alive')
  })

  it('dispose removes only this insertion and is idempotent', () => {
    const tools = fakeToolsCtx()
    tools.install()
    const { registration, config, mask } = makeRegistration(tools.ctx)
    config.guidance = 'on'
    registration.sync()
    registration.dispose()
    registration.dispose()
    expect(tools.disposerCalls()).toBe(1)
    expect(registration.toolAvailable).toBe(true) // availability is host capability, not registration
    expect(mask.clear).toHaveBeenCalled()
  })

  it('off without a tools service still reports toolAvailable=false', () => {
    const tools = fakeToolsCtx() // never installed
    const { registration } = makeRegistration(tools.ctx)
    registration.sync()
    expect(registration.toolAvailable).toBe(false)
  })

  it('a failed register recovers on the next sync once the host heals', () => {
    const tools = fakeToolsCtx('throw')
    tools.install()
    const { registration, config } = makeRegistration(tools.ctx)
    config.guidance = 'on'
    registration.sync()
    expect(registration.toolAvailable).toBe(false)
    tools.setMode('disposer')
    registration.sync()
    expect(tools.registered).toHaveLength(1)
    expect(registration.toolAvailable).toBe(true)
  })

  it('restrictAvailable mirrors the force mask probe', () => {
    const tools = fakeToolsCtx()
    tools.install()
    const { registration } = makeRegistration(tools.ctx)
    expect(registration.restrictAvailable).toBe(true)
  })
})