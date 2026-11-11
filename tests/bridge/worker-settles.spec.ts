import { tmpdir } from 'node:os'
import { mkdirSync } from 'node:fs'
import { afterAll, describe, expect, it } from 'vitest'
import { AcpLlmAdapter, BACKGROUND_REPORT_FORM, BACKGROUND_REPORT_LOST_TEXT, BACKGROUND_REPORT_SOURCE, backgroundReportOf, type BackgroundWake, BridgeManager, type BridgeTuning } from '../../src/bridge.ts'
import { type AcpEvent, type StreamChunk, type SubagentRecord } from '../../src/protocol.ts'
import { EventHub } from '../../src/impl.ts'
import { def, hostLoopTurn, until } from './harness.ts'

/**
 * The DEFAULT detached-worker behaviour: the prompt response closes the turn,
 * so the composer is free while the worker runs. The worker's own record still
 * moves (it belongs to the SESSION), and its report lands in the transcript /
 * NTR view instead of being folded into the closed bubble.
 *
 * The idle clock must see that pending work: releasing the agent here would
 * kill the worker before it can report.
 */
describe('a detached worker settles the turn at the response (isolated manager)', () => {
  const settleWorkspace = `${tmpdir()}/dsh-ntr-settle-workspace`
  mkdirSync(settleWorkspace, { recursive: true })
  const settleHub = new EventHub()
  const settleEvents: AcpEvent[] = []
  settleHub.subscribe(event => { settleEvents.push(event) })
  const settleManager = new BridgeManager(
    [{ ...def, id: 'settle', cwd: settleWorkspace, allowedCwdRoots: [settleWorkspace] }],
    settleHub,
    500,
    undefined,
    undefined,
    false,
    {
      startupTimeoutMs: 3_000,
      cancelFallbackMs: 100,
      ambientQuietMs: 250,
      idleTimeoutMs: 400,
      ambientStaleMs: 2_000,
    },
  )
  const settleAdapter = new AcpLlmAdapter(settleManager)

  afterAll(async () => {
    await settleManager.shutdownAll()
  })

  function settleText(chunks: StreamChunk[]): string {
    return chunks
      .filter((chunk): chunk is Extract<StreamChunk, { type: 'text-delta' }> => chunk.type === 'text-delta')
      .map(chunk => chunk.text)
      .join('')
  }

  function settleRecords(since: number): SubagentRecord[] {
    return settleEvents
      .slice(since)
      .filter((event): event is Extract<AcpEvent, { type: 'subagents/record' }> => event.type === 'subagents/record')
      .map(event => event.record)
      .filter(record => record.childId === 'acp:agent_dispatch')
  }

  /** A manager of its own, so a previous case's ambient record cannot mask the idle clock. */
  function idleHarness(tuning: BridgeTuning = {}): { manager: BridgeManager; events: AcpEvent[]; adapter: AcpLlmAdapter } {
    const hub = new EventHub()
    const events: AcpEvent[] = []
    hub.subscribe(event => { events.push(event) })
    const manager = new BridgeManager(
      [{ ...def, id: 'settle', cwd: settleWorkspace, allowedCwdRoots: [settleWorkspace] }],
      hub,
      500,
      undefined,
      undefined,
      false,
      {
        startupTimeoutMs: 3_000,
        cancelFallbackMs: 100,
        ambientQuietMs: 250,
        idleTimeoutMs: 400,
        ambientStaleMs: 2_000,
        ...tuning,
      },
    )
    return { manager, events, adapter: new AcpLlmAdapter(manager) }
  }

  function recordStatus(events: AcpEvent[], since: number): string[] {
    return events
      .slice(since)
      .filter((event): event is Extract<AcpEvent, { type: 'subagents/record' }> => event.type === 'subagents/record')
      .map(event => event.record)
      .filter(record => record.childId === 'acp:agent_dispatch')
      .map(record => record.status)
  }

  it('closes at the response, then finishes the worker record from the session', async () => {
    const dshSessionId = 'dsh-settle-default'
    const since = settleEvents.length
    const { chunks } = await hostLoopTurn(settleAdapter, {
      provider: 'acp',
      model: 'settle',
      sessionId: dshSessionId,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'DISPATCH please' }] }],
    })
    const text = settleText(chunks)

    // The coordinator's ack is the whole answer of this turn: the drain's
    // final answer is NOT folded into a bubble that already closed.
    expect(text).toContain('DISPATCH-ACK')
    expect(text).not.toContain('DISPATCH-FINAL-ANSWER')
    expect(text).not.toContain('WORKER-REPORT-TEXT')

    // A `turn/end` fired at the response: this mock's worker reports on its
    // own clock, so the record may finish before or after this assertion.
    const ends = settleEvents.slice(since).filter(event => event.type === 'turn/end')
    expect(ends).toHaveLength(1)

    // The record still moves after the turn closed: the SESSION owns it.
    await until(() => settleRecords(since).some(record => record.status === 'completed'), 10_000)
  }, 30_000)

  it('wakes the chat with an idle drain report and replays it without a second prompt', async () => {
    const { manager, events, adapter } = idleHarness({})
    const dshSessionId = 'dsh-settle-wake'
    const wakes: Array<{
      role?: string
      content?: Array<{ type?: string; text?: string }>
      source?: { kind?: string; form?: string; summary?: string; report?: string }
    }> = []
    manager.setDshAgentResolver(id => id === dshSessionId
      ? { session: { id: dshSessionId }, followup: message => { wakes.push(message as (typeof wakes)[number]) } }
      : undefined)
    try {
      const { chunks } = await hostLoopTurn(adapter, {
        provider: 'acp',
        model: 'settle',
        sessionId: dshSessionId,
        messages: [{ role: 'user', content: [{ type: 'text', text: 'DISPATCH please' }] }],
      })
      expect(settleText(chunks)).toContain('DISPATCH-ACK')

      // The worker reports off-turn; the drain goes quiet and the manager
      // hands its prose to the host as ONE hidden wake message.
      await until(() => wakes.length > 0, 10_000)
      expect(wakes).toHaveLength(1)
      const wake = wakes[0]
      expect(wake.role).toBe('user')
      expect(wake.source?.kind).toBe(BACKGROUND_REPORT_SOURCE)
      // Producer-owned kind, NOT the retired V4 `plugin` wrapper.
      expect(wake.source?.kind).not.toBe('plugin')
      expect(wake.source?.form).toBe(BACKGROUND_REPORT_FORM)
      // A `notice` without `summary` renders as the opaque source-field list.
      expect(wake.source?.summary).toBe('Background task completed.')
      expect(wake.source?.report).toContain('DISPATCH-FINAL-ANSWER')
      expect(wake.source?.report).not.toContain('WORKER-REPORT-TEXT')
      expect(wake.content?.[0]?.text).toBe('Background task completed.')

      // The wake is answered LOCALLY: the report becomes this turn's assistant
      // text, and no second ACP prompt reaches the agent.
      const replay = await hostLoopTurn(adapter, {
        provider: 'acp',
        model: 'settle',
        sessionId: dshSessionId,
        messages: [{ role: 'user', content: wake.content, source: wake.source }],
      })
      expect(settleText(replay.chunks)).toBe(wake.source?.report)
      expect(events.filter(event => event.type === 'turn/start')).toHaveLength(1)
    } finally {
      await manager.shutdownAll()
    }
  }, 30_000)


  it('does not crash the host when the wake is rejected', async () => {
    // The idle window outlives the run's late frame: without it the process
    // would be released before the frame arrived and the "no re-delivery"
    // assertions below would pass vacuously.
    const { manager, events, adapter } = idleHarness({ idleTimeoutMs: 8_000 })
    const dshSessionId = 'dsh-settle-wake-rejected'
    let attempts = 0
    manager.setDshAgentResolver(id => id === dshSessionId
      ? {
          session: { id: dshSessionId },
          followup: () => {
            attempts += 1
            return Promise.reject(new Error('host is gone'))
          },
        }
      : undefined)
    try {
      await hostLoopTurn(adapter, {
        provider: 'acp',
        model: 'settle',
        sessionId: dshSessionId,
        messages: [{ role: 'user', content: [{ type: 'text', text: 'DISPATCHLATE please' }] }],
      })
      // The rejection is drained, not left unhandled (Node would exit), and the
      // loss is reported through the settings-page log.
      await until(() => events.some(event => event.type === 'agent/notice'
        && (event as { text?: string }).text?.includes('could not wake') === true), 10_000)
      // F6: a rejected wake and a throwing wake are OBSERVABLY the same — one
      // attempt, one notice, and the consumed id keeps the run's late frame
      // (~700ms after the drain) from ever opening a second delivery.
      await new Promise(resolve => setTimeout(resolve, 1_200))
      // Evidence the late frame really ARRIVED (it reached the transcript):
      // "no second attempt" is suppression, not a missing frame.
      expect(sawAgentText(events, 'DISPATCH-LATE-LINE')).toBe(true)
      expect(attempts).toBe(1)
      expect(events.filter(event => event.type === 'agent/notice'
        && (event as { text?: string }).text?.includes('could not wake') === true)).toHaveLength(1)
    } finally {
      await manager.shutdownAll()
    }
  }, 30_000)

  it('does not crash the host when the wake throws synchronously', async () => {
    // Same idle window as the rejection case: the late frame must really land.
    const { manager, events, adapter } = idleHarness({ idleTimeoutMs: 8_000 })
    const dshSessionId = 'dsh-settle-wake-thrown'
    let attempts = 0
    manager.setDshAgentResolver(id => id === dshSessionId
      ? {
          session: { id: dshSessionId },
          followup: () => {
            attempts += 1
            throw new Error('host is gone')
          },
        }
      : undefined)
    try {
      await hostLoopTurn(adapter, {
        provider: 'acp',
        model: 'settle',
        sessionId: dshSessionId,
        messages: [{ role: 'user', content: [{ type: 'text', text: 'DISPATCHLATE please' }] }],
      })
      await until(() => events.some(event => event.type === 'agent/notice'
        && (event as { text?: string }).text?.includes('could not wake') === true), 10_000)
      // Identical to the async rejection above: one attempt, one notice, and
      // the consumed id blocks the run's late frame from re-waking.
      await new Promise(resolve => setTimeout(resolve, 1_200))
      // Evidence: the late frame arrived and stayed transcript-only.
      expect(sawAgentText(events, 'DISPATCH-LATE-LINE')).toBe(true)
      expect(attempts).toBe(1)
      expect(events.filter(event => event.type === 'agent/notice'
        && (event as { text?: string }).text?.includes('could not wake') === true)).toHaveLength(1)
    } finally {
      await manager.shutdownAll()
    }
  }, 30_000)

  it('does not wake twice when a consumed drain speaks again', async () => {
    // The idle window outlives the late frame (see the two failure cases).
    const { manager, events, adapter } = idleHarness({ idleTimeoutMs: 8_000 })
    const dshSessionId = 'dsh-settle-wake-consumed'
    const wakes: Array<{ source?: { report?: string } }> = []
    manager.setDshAgentResolver(id => id === dshSessionId
      ? { session: { id: dshSessionId }, followup: message => { wakes.push(message as (typeof wakes)[number]) } }
      : undefined)
    try {
      await hostLoopTurn(adapter, {
        provider: 'acp',
        model: 'settle',
        sessionId: dshSessionId,
        messages: [{ role: 'user', content: [{ type: 'text', text: 'DISPATCHLATE please' }] }],
      })
      await until(() => wakes.length >= 1, 10_000)
      // The run speaks once more ~700ms after the drain; the quiet window is
      // 250ms, so a collector without the consumed-id table would wake again.
      await new Promise(resolve => setTimeout(resolve, 1_200))
      // Evidence the late frame arrived (it reached the transcript): the
      // single wake is suppression, not a frame that never came.
      expect(sawAgentText(events, 'DISPATCH-LATE-LINE')).toBe(true)
      expect(wakes).toHaveLength(1)
      expect(wakes[0]?.source?.report).toContain('DISPATCH-FINAL-ANSWER')
      expect(wakes[0]?.source?.report).not.toContain('DISPATCH-LATE-LINE')
    } finally {
      await manager.shutdownAll()
    }
  }, 30_000)

  it('reads the OLDEST unanswered wake (FIFO), and calls a report-less one lost', () => {
    const wake = (report: string | undefined, form: string | null = BACKGROUND_REPORT_FORM) => ({
      role: 'user',
      source: { kind: BACKGROUND_REPORT_SOURCE, ...(form === null ? {} : { form }), ...(report === undefined ? {} : { report }) },
      content: [],
    })
    expect(backgroundReportOf([wake('REPORT')])).toEqual({ kind: 'report', text: 'REPORT' })
    // The host's context projection follows the wake in the derived history.
    expect(backgroundReportOf([wake('REPORT'), { role: 'user', source: { kind: 'runtime-context' }, content: [] }])).toEqual({ kind: 'report', text: 'REPORT' })
    expect(backgroundReportOf([wake('REPORT'), { role: 'system', source: { kind: 'system-prompt' }, content: [] }])).toEqual({ kind: 'report', text: 'REPORT' })
    // A person message or a consumed turn outranks the older wake.
    expect(backgroundReportOf([wake('REPORT'), { role: 'user', source: { kind: 'user' }, content: [] }])).toBeUndefined()
    expect(backgroundReportOf([wake('REPORT'), { role: 'assistant', source: { kind: 'model' }, content: [] }])).toBeUndefined()
    expect(backgroundReportOf([wake('REPORT'), { role: 'tool', source: { kind: 'tool' }, content: [] }])).toBeUndefined()
    // Only THIS plugin's own kind in the `notice` form counts; a borrowed
    // kind (another producer using `notice`) or our kind without the wake
    // form never matches.
    expect(backgroundReportOf([{ role: 'user', source: { kind: 'plugin:other', form: BACKGROUND_REPORT_FORM, report: 'X' } }])).toBeUndefined()
    expect(backgroundReportOf([wake('X', null)])).toBeUndefined()
    expect(backgroundReportOf([wake('X', 'other-form')])).toBeUndefined()
    // Wake shape, but the host pipeline stripped (or blanked) the report:
    // the step must close locally as LOST, never fall through to the forward
    // picker (a duplicated prompt).
    expect(backgroundReportOf([wake(undefined)])).toEqual({ kind: 'lost' })
    expect(backgroundReportOf([wake('  ')])).toEqual({ kind: 'lost' })
    // TWO queued wakes: the OLDEST unanswered one wins each step. After the
    // first is answered (an assistant reply follows it), the second step finds
    // the next one — a newest-first scan would replay them out of order and
    // leave the last step nothing to answer.
    const first = wake('FIRST-REPORT')
    const second = wake('SECOND-REPORT')
    expect(backgroundReportOf([first, second])).toEqual({ kind: 'report', text: 'FIRST-REPORT' })
    expect(backgroundReportOf([first, { role: 'assistant', content: [] }, second])).toEqual({ kind: 'report', text: 'SECOND-REPORT' })
    expect(backgroundReportOf([first, { role: 'assistant', content: [] }, second, { role: 'assistant', content: [] }])).toBeUndefined()
    // The person speaking in between outranks BOTH queued wakes.
    expect(backgroundReportOf([first, second, { role: 'user', source: { kind: 'user' }, content: [] }])).toBeUndefined()
  })

  /** Whether a `session/update` carried this run's message text. */
  function sawAgentText(events: AcpEvent[], text: string): boolean {
    return events.some(event => event.type === 'session/update'
      && event.update.sessionUpdate === 'agent_message_chunk'
      && String((event.update.content as { text?: string }).text ?? '').includes(text))
  }

  it('drops a queued report the user\'s turn already answered (no double wake)', async () => {
    // F1: the drain answers in TWO waves; the person interjects in the gap and
    // their turn folds the tail into its own bubble. That quiet close CONSUMES
    // the drain id — the report timer still armed on the first wave must then
    // drop instead of waking the chat with the same answer twice.
    const { manager, events, adapter } = idleHarness({ ambientQuietMs: 800 })
    const dshSessionId = 'dsh-settle-interject'
    const wakes: Array<{ source?: { report?: string } }> = []
    manager.setDshAgentResolver(id => id === dshSessionId
      ? { session: { id: dshSessionId }, followup: message => { wakes.push(message as (typeof wakes)[number]) } }
      : undefined)
    try {
      await hostLoopTurn(adapter, {
        provider: 'acp',
        model: 'settle',
        sessionId: dshSessionId,
        messages: [{ role: 'user', content: [{ type: 'text', text: 'DISPATCHSPLIT please' }] }],
      })
      // Interject the moment the FIRST wave lands.
      await until(() => sawAgentText(events, 'DISPATCH-INT-HEAD'), 10_000)
      // `EMPTY` answers with no conversation id and no prose of its own: the
      // turn is held for the drain and folds the tail when it arrives.
      const interjection = await hostLoopTurn(adapter, {
        provider: 'acp',
        model: 'settle',
        sessionId: dshSessionId,
        messages: [{ role: 'user', content: [{ type: 'text', text: 'EMPTY please' }] }],
      })
      // F1 evidence: the drain's body REALLY arrived — the first wave reached
      // the client (it is in the transcript events) and the tail folded into
      // the user turn's own bubble. The zero wake below is suppression at the
      // delivery check (the id is consumed), not a collector that never saw
      // the frames.
      expect(sawAgentText(events, 'DISPATCH-INT-HEAD')).toBe(true)
      expect(settleText(interjection.chunks)).toContain('DISPATCH-INT-TAIL')
      // The turn closed on the tail's quiet (800ms) and consumed the id; the
      // first wave's pending report must NOT wake afterwards.
      await new Promise(resolve => setTimeout(resolve, 1_500))
      expect(wakes).toHaveLength(0)
    } finally {
      await manager.shutdownAll()
    }
  }, 30_000)

  it('splits two interleaved drain runs into two clean reports, never one mixed', async () => {
    // F2: run A is mid-collection when run B's announcement hands the ambient
    // record over. A's report closes out on the spot (its collection is over),
    // B gets a fresh record — and a late line from the consumed run A can
    // never open a third wake.
    const { manager, adapter } = idleHarness({})
    const dshSessionId = 'dsh-settle-two-runs'
    const wakes: Array<{ source?: { report?: string } }> = []
    manager.setDshAgentResolver(id => id === dshSessionId
      ? { session: { id: dshSessionId }, followup: message => { wakes.push(message as (typeof wakes)[number]) } }
      : undefined)
    try {
      await hostLoopTurn(adapter, {
        provider: 'acp',
        model: 'settle',
        sessionId: dshSessionId,
        messages: [{ role: 'user', content: [{ type: 'text', text: 'DISPATCHSWITCH please' }] }],
      })
      await until(() => wakes.length >= 2, 10_000)
      expect(wakes[0]?.source?.report).toContain('DISPATCH-RUN-A-TEXT')
      expect(wakes[0]?.source?.report).not.toContain('DISPATCH-RUN-B-TEXT')
      expect(wakes[1]?.source?.report).toContain('DISPATCH-RUN-B-TEXT')
      expect(wakes[1]?.source?.report).not.toContain('DISPATCH-RUN-A-TEXT')
      // Both ids are consumed on their own delivery: A's late line (~700ms
      // after B's text) is transcript-only and no third wake appears.
      await new Promise(resolve => setTimeout(resolve, 1_200))
      expect(wakes).toHaveLength(2)
      for (const wake of wakes) expect(wake.source?.report ?? '').not.toContain('DISPATCH-RUN-A-LATE')
    } finally {
      await manager.shutdownAll()
    }
  }, 30_000)

  it('waits out a drain tool that outlives the quiet window, then wakes once with the whole answer', async () => {
    // F3: the drain's tool call runs 700ms — longer than the 250ms quiet
    // window. The wake must not fire mid-tool (half a report, the tail then
    // eaten by the consumed-id table): it fires after the close frame (a bare
    // one, no `_meta`, matched by call id) and carries BOTH halves.
    const { manager, adapter } = idleHarness({})
    const dshSessionId = 'dsh-settle-drain-tool'
    const wakes: Array<{ source?: { report?: string } }> = []
    manager.setDshAgentResolver(id => id === dshSessionId
      ? { session: { id: dshSessionId }, followup: message => { wakes.push(message as (typeof wakes)[number]) } }
      : undefined)
    try {
      await hostLoopTurn(adapter, {
        provider: 'acp',
        model: 'settle',
        sessionId: dshSessionId,
        messages: [{ role: 'user', content: [{ type: 'text', text: 'DISPATCHTOOL please' }] }],
      })
      await until(() => wakes.length > 0, 10_000)
      await new Promise(resolve => setTimeout(resolve, 800))
      expect(wakes).toHaveLength(1)
      expect(wakes[0]?.source?.report).toContain('DISPATCH-TOOL-HEAD')
      expect(wakes[0]?.source?.report).toContain('DISPATCH-TOOL-TAIL')
    } finally {
      await manager.shutdownAll()
    }
  }, 30_000)

  it('closes a report-less wake locally instead of re-prompting the agent', async () => {
    // D1: the host pipeline can strip `source.report`. The wake shape alone
    // must still reach the replay, which then answers with ONE local line and
    // logs the loss — never a fall-through to the forward picker (that would
    // re-send the person's old message as a duplicate prompt).
    const { manager, events, adapter } = idleHarness({})
    const dshSessionId = 'dsh-settle-wake-lost'
    const lost = {
      role: 'user',
      source: { kind: BACKGROUND_REPORT_SOURCE, form: BACKGROUND_REPORT_FORM },
      content: [{ type: 'text', text: 'Background task completed.' }],
    }
    try {
      const recognized: BackgroundWake | undefined = backgroundReportOf([lost])
      expect(recognized).toEqual({ kind: 'lost' })
      const { chunks, steps } = await hostLoopTurn(adapter, {
        provider: 'acp',
        model: 'settle',
        sessionId: dshSessionId,
        messages: [lost],
      })
      expect(settleText(chunks)).toBe(BACKGROUND_REPORT_LOST_TEXT)
      expect(steps).toHaveLength(1)
      // One searchable notice ("background report"), and NO ACP prompt: the
      // agent must never see a turn for this step.
      expect(events.filter(event => event.type === 'agent/notice'
        && (event as { text?: string }).text?.includes('background report') === true)).toHaveLength(1)
      expect(events.filter(event => event.type === 'turn/start')).toHaveLength(0)
    } finally {
      await manager.shutdownAll()
    }
  }, 30_000)

  it('replays two queued wakes FIFO: each step answers the oldest pending one', async () => {
    // F5: the host can queue two wake messages before opening the first step.
    // FIFO replays the FIRST report first and the second one on the next step;
    // a newest-first scan would drop the first report and leave the second
    // step nothing to answer (`selectForwardPrompt` would re-prompt the agent).
    const { manager, events, adapter } = idleHarness({})
    const dshSessionId = 'dsh-settle-two-wakes'
    const wakeMessage = (report: string) => ({
      role: 'user' as const,
      source: { kind: BACKGROUND_REPORT_SOURCE, form: BACKGROUND_REPORT_FORM, report },
      content: [{ type: 'text' as const, text: 'Background task completed.' }],
    })
    try {
      const first = await hostLoopTurn(adapter, {
        provider: 'acp',
        model: 'settle',
        sessionId: dshSessionId,
        messages: [wakeMessage('FIRST-WAKE-REPORT'), wakeMessage('SECOND-WAKE-REPORT')],
      })
      expect(settleText(first.chunks)).toBe('FIRST-WAKE-REPORT')
      const second = await hostLoopTurn(adapter, {
        provider: 'acp',
        model: 'settle',
        sessionId: dshSessionId,
        messages: [
          wakeMessage('FIRST-WAKE-REPORT'),
          { role: 'assistant', content: [{ type: 'text', text: 'FIRST-WAKE-REPORT' }] },
          wakeMessage('SECOND-WAKE-REPORT'),
        ],
      })
      expect(settleText(second.chunks)).toBe('SECOND-WAKE-REPORT')
      // Local replays only: the agent never received a prompt for either step.
      expect(events.filter(event => event.type === 'turn/start')).toHaveLength(0)
    } finally {
      await manager.shutdownAll()
    }
  }, 30_000)

  it('wakes for a revived run after a zero-output quiet close (nothing consumed)', async () => {
    // F4: the turn waited for the drain, heard NOTHING and closed with just
    // the deferral line. That close must NOT mark the id consumed — the answer
    // was never delivered — so the revived run's real answer still reaches the
    // chat as an idle-drain wake.
    const { manager, adapter } = idleHarness({})
    const dshSessionId = 'dsh-settle-quiet-revive'
    const wakes: Array<{ source?: { report?: string } }> = []
    manager.setDshAgentResolver(id => id === dshSessionId
      ? { session: { id: dshSessionId }, followup: message => { wakes.push(message as (typeof wakes)[number]) } }
      : undefined)
    try {
      const { chunks } = await hostLoopTurn(adapter, {
        provider: 'acp',
        model: 'settle',
        sessionId: dshSessionId,
        messages: [{ role: 'user', content: [{ type: 'text', text: 'QUIETWAKE please' }] }],
      })
      expect(settleText(chunks)).toContain('deferred this turn to a background task run')
      await until(() => wakes.length > 0, 10_000)
      expect(wakes).toHaveLength(1)
      expect(wakes[0]?.source?.report).toContain('QUIET-REVIVED-ANSWER')
    } finally {
      await manager.shutdownAll()
    }
  }, 30_000)

  it('cuts a report at the ambient ceiling, then wakes again with the continuation', async () => {
    // R6: the drain's tool call never closes inside a tiny `ambientMaxMs`.
    // The quiet window must NOT wake a half report; the ceiling cuts the wait
    // and delivers the collected head with a truncation marker. But the run is
    // still alive: once the tool closes and the tail (the real deliverable)
    // arrives, it must wake the chat AGAIN as a continuation — consuming the id
    // at the cut would swallow the final answer and the conversation looks
    // aborted.
    const { manager, events, adapter } = idleHarness({ ambientMaxMs: 400, idleTimeoutMs: 8_000 })
    const dshSessionId = 'dsh-settle-ceiling-cut'
    const wakes: Array<{ source?: { report?: string } }> = []
    manager.setDshAgentResolver(id => id === dshSessionId
      ? { session: { id: dshSessionId }, followup: message => { wakes.push(message as (typeof wakes)[number]) } }
      : undefined)
    try {
      await hostLoopTurn(adapter, {
        provider: 'acp',
        model: 'settle',
        sessionId: dshSessionId,
        messages: [{ role: 'user', content: [{ type: 'text', text: 'DISPATCHTOOL please' }] }],
      })
      await until(() => wakes.length > 0, 10_000)
      // The tool closed only at +700ms — after the 400ms ceiling — so the first
      // wake carries the collected head and the truncation marker, not the tail.
      expect(wakes[0]?.source?.report).toContain('DISPATCH-TOOL-HEAD')
      expect(wakes[0]?.source?.report).toContain('the background report hit its ambient ceiling')
      expect(wakes[0]?.source?.report).not.toContain('DISPATCH-TOOL-TAIL')
      // The tail really arrived afterwards and wakes as the continuation: a
      // fresh report, no head repeated, no truncation marker (it completed).
      await until(() => wakes.length > 1, 10_000)
      expect(wakes[1]?.source?.report).toContain('DISPATCH-TOOL-TAIL')
      expect(wakes[1]?.source?.report).not.toContain('DISPATCH-TOOL-HEAD')
      expect(wakes[1]?.source?.report).not.toContain('the background report hit its ambient ceiling')
      expect(sawAgentText(events, 'DISPATCH-TOOL-TAIL')).toBe(true)
    } finally {
      await manager.shutdownAll()
    }
  }, 30_000)

  it('treats an unknown tool status as open: only the ceiling cut wakes, with its marker', async () => {
    // R5: the drain's tool call arrives as a single `tool_call_update` with an
    // UNKNOWN status (`running`) — no opening frame, no close frame. "Unknown
    // = unclosed" must hold the quiet wake back: without the fix the quiet
    // window wakes a half report WITHOUT the truncation marker.
    const { manager, adapter } = idleHarness({ ambientMaxMs: 400, idleTimeoutMs: 8_000 })
    const dshSessionId = 'dsh-settle-unknown-tool'
    const wakes: Array<{ source?: { report?: string } }> = []
    manager.setDshAgentResolver(id => id === dshSessionId
      ? { session: { id: dshSessionId }, followup: message => { wakes.push(message as (typeof wakes)[number]) } }
      : undefined)
    try {
      await hostLoopTurn(adapter, {
        provider: 'acp',
        model: 'settle',
        sessionId: dshSessionId,
        messages: [{ role: 'user', content: [{ type: 'text', text: 'DISPATCHWEIRDTOOL please' }] }],
      })
      await until(() => wakes.length > 0, 10_000)
      await new Promise(resolve => setTimeout(resolve, 800))
      expect(wakes).toHaveLength(1)
      expect(wakes[0]?.source?.report).toContain('DISPATCH-TOOL-HEAD')
      expect(wakes[0]?.source?.report).toContain('the background report hit its ambient ceiling')
    } finally {
      await manager.shutdownAll()
    }
  }, 30_000)

  it('keeps a collected report when no host agent is mounted, and wakes the whole answer once one arrives', async () => {
    // R2/R6: with no `setDshAgentResolver` the report must NOT be dropped —
    // a drop would leave any later wake a HALF report rebuilt from later
    // frames. The retry stays bounded by `ambientMaxMs`, and a resolver that
    // mounts inside the bound still gets the full text, exactly once.
    const { manager, events, adapter } = idleHarness({ ambientMaxMs: 3_000, idleTimeoutMs: 8_000 })
    const dshSessionId = 'dsh-settle-no-agent'
    const wakes: Array<{ source?: { report?: string } }> = []
    try {
      await hostLoopTurn(adapter, {
        provider: 'acp',
        model: 'settle',
        sessionId: dshSessionId,
        messages: [{ role: 'user', content: [{ type: 'text', text: 'DISPATCH please' }] }],
      })
      // The drain's report is collected with NO host agent: no wake, no crash.
      await until(() => sawAgentText(events, 'DISPATCH-FINAL-ANSWER'), 10_000)
      await new Promise(resolve => setTimeout(resolve, 800))
      expect(wakes).toHaveLength(0)
      // Mount the resolver INSIDE the bound: the next retry delivers the whole
      // collected text as one wake.
      manager.setDshAgentResolver(id => id === dshSessionId
        ? { session: { id: dshSessionId }, followup: message => { wakes.push(message as (typeof wakes)[number]) } }
        : undefined)
      await until(() => wakes.length > 0, 10_000)
      await new Promise(resolve => setTimeout(resolve, 800))
      expect(wakes).toHaveLength(1)
      expect(wakes[0]?.source?.report).toContain('DISPATCH-FINAL-ANSWER')
      expect(wakes[0]?.source?.report).not.toContain('WORKER-REPORT-TEXT')
    } finally {
      await manager.shutdownAll()
    }
  }, 30_000)

  it('consumes the folded run and spares the zero-output run in a multi-run interleave', async () => {
    // R1: one turn folds run A's answer while the ambient record has moved to
    // run B (zero delivery). The quiet close must consume A per id (its answer
    // is on screen) and leave B unconsumed (it delivered nothing) — so B's
    // revival still wakes the chat while A's late revival can never answer the
    // same text twice. A turn-level "folded anything" bit would do exactly the
    // opposite.
    const { manager, events, adapter } = idleHarness({ idleTimeoutMs: 8_000 })
    const dshSessionId = 'dsh-settle-two-runs-interleave'
    const wakes: Array<{ source?: { report?: string } }> = []
    manager.setDshAgentResolver(id => id === dshSessionId
      ? { session: { id: dshSessionId }, followup: message => { wakes.push(message as (typeof wakes)[number]) } }
      : undefined)
    try {
      // Setup: a drain that delivers NOTHING and quiet-closes — its id is
      // retired UNCONSUMED (the F4 rule), ready to revive below.
      const setup = await hostLoopTurn(adapter, {
        provider: 'acp',
        model: 'settle',
        sessionId: dshSessionId,
        messages: [{ role: 'user', content: [{ type: 'text', text: 'QUIETDRAIN please' }] }],
      })
      expect(settleText(setup.chunks)).toContain('deferred this turn to a background task run')
      // The interleave: steered turn folds run A's text, run B replaces the
      // ambient record and stays silent.
      const interleave = await hostLoopTurn(adapter, {
        provider: 'acp',
        model: 'settle',
        sessionId: dshSessionId,
        messages: [{ role: 'user', content: [{ type: 'text', text: 'RUNMIX please' }] }],
      })
      expect(settleText(interleave.chunks)).toContain('MIX-RUN-A-TEXT')
      // B revives with its real answer AFTER the quiet close: it delivered
      // nothing at close time, so it must still wake.
      await until(() => wakes.length > 0, 10_000)
      expect(wakes[0]?.source?.report).toContain('MIX-RUN-B-ANSWER')
      // A revives late: its answer is already on screen, so its late frames
      // stay transcript-only — no second wake.
      await new Promise(resolve => setTimeout(resolve, 800))
      expect(sawAgentText(events, 'MIX-RUN-A-LATE')).toBe(true)
      expect(wakes).toHaveLength(1)
      expect(wakes[0]?.source?.report ?? '').not.toContain('MIX-RUN-A-LATE')
      expect(wakes[0]?.source?.report ?? '').not.toContain('MIX-RUN-A-TEXT')
    } finally {
      await manager.shutdownAll()
    }
  }, 30_000)

  it('keeps the process alive while the worker runs, then releases it once it reports', async () => {
    const { manager, events, adapter } = idleHarness({})
    try {
      const dshSessionId = 'dsh-settle-idle'
      const since = events.length
      const { chunks } = await hostLoopTurn(adapter, {
        provider: 'acp',
        model: 'settle',
        sessionId: dshSessionId,
        messages: [{ role: 'user', content: [{ type: 'text', text: 'DISPATCHKEEPALIVE please' }] }],
      })
      expect(settleText(chunks)).toContain('DISPATCH-ACK')

      // The idle window is 400ms. The worker is still reporting well past it.
      await new Promise(resolve => setTimeout(resolve, 1_200))
      expect(events.slice(since).some(event => event.type === 'session/released')).toBe(false)

      // Once it reports (and its drain goes quiet), the idle clock may release.
      await until(() => recordStatus(events, since).includes('completed'), 10_000)
      await until(() => events.slice(since).some(event => event.type === 'session/released'), 8_000)
    } finally {
      await manager.shutdownAll()
    }
  }, 30_000)

  it('extends the alive window while the worker is inside an open tool call', async () => {
    const { manager, events, adapter } = idleHarness({
      backgroundTaskToolMs: 600,
      backgroundOpenToolCeilingMs: 5_000,
    })
    try {
      const dshSessionId = 'dsh-settle-open-tool'
      const since = events.length
      const { chunks } = await hostLoopTurn(adapter, {
        provider: 'acp',
        model: 'settle',
        sessionId: dshSessionId,
        messages: [{ role: 'user', content: [{ type: 'text', text: 'DISPATCHLONGTOOL please' }] }],
      })
      expect(settleText(chunks)).toContain('DISPATCH-ACK')

      // Wait until the worker's tool call has actually opened, then hold for
      // longer than the plain silence window.
      await until(() => recordStatus(events, since).includes('running'), 2_000)
      // The worker opens its Bash call and says nothing for 2.5s: far past the
      // 600ms silence window, still inside the 5s open-tool ceiling.
      await new Promise(resolve => setTimeout(resolve, 1_200))
      expect(events.slice(since).some(event => event.type === 'session/released')).toBe(false)

      await until(() => recordStatus(events, since).includes('completed'), 10_000)
      await until(() => events.slice(since).some(event => event.type === 'session/released'), 8_000)
    } finally {
      await manager.shutdownAll()
    }
  }, 30_000)

  it('releases a worker whose open tool call passes the wedged ceiling', async () => {
    const { manager, events, adapter } = idleHarness({
      backgroundTaskToolMs: 600,
      backgroundOpenToolCeilingMs: 800,
    })
    try {
      const dshSessionId = 'dsh-settle-wedged-tool'
      const since = events.length
      const { chunks } = await hostLoopTurn(adapter, {
        provider: 'acp',
        model: 'settle',
        sessionId: dshSessionId,
        messages: [{ role: 'user', content: [{ type: 'text', text: 'DISPATCHULTRALONGTOOL please' }] }],
      })
      expect(settleText(chunks)).toContain('DISPATCH-ACK')

      // The call opens early and stays open for 10s; past 800ms the worker is
      // presumed wedged, so the idle clock releases it long before completion.
      // The teardown then writes `unknown`, proving this was the wedged path.
      await until(() => recordStatus(events, since).includes('running'), 2_000)
      await until(() => recordStatus(events, since).includes('unknown'), 5_000)
      expect(events.slice(since).some(event => event.type === 'session/released')).toBe(true)
    } finally {
      await manager.shutdownAll()
    }
  }, 30_000)
})
