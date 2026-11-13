import { tmpdir } from 'node:os'
import { mkdirSync } from 'node:fs'
import { afterAll, describe, expect, it } from 'vitest'
import { AcpLlmAdapter, BridgeManager } from '../../src/bridge.ts'
import { type AcpEvent, type StreamChunk } from '../../src/protocol.ts'
import { dispatchRpc, EventHub } from '../../src/impl.ts'
import { def, hostLoopTurn, unexpectedSubagentFrames } from './harness.ts'

/**
 * A turn whose `Agent` call dispatched a DETACHED worker: the coordinator
 * answers its own prompt ("已派…") while the worker keeps running off-turn,
 * and the worker's report arrives minutes later through a background drain.
 * Closing at the prompt response (the old behaviour) leaves the main chat with
 * no answer at all — the report exists only in the ACP transcript view.
 *
 * The turn must instead HOLD across the worker phase (no quiet window: a
 * detached worker goes silent for tens of seconds while it thinks) and then
 * close on the drain's own terms. The worker's own updates and tools are never
 * the session's answer, whichever turn is on air.
 */
describe('a turn that dispatched a detached worker (isolated manager)', () => {
  const dispatchWorkspace = `${tmpdir()}/dsh-ntr-dispatch-workspace`
  mkdirSync(dispatchWorkspace, { recursive: true })
  const dispatchHub = new EventHub()
  const dispatchEvents: AcpEvent[] = []
  dispatchHub.subscribe(event => { dispatchEvents.push(event) })
  const dispatchManager = new BridgeManager(
    [{ ...def, id: 'dispatch', cwd: dispatchWorkspace, allowedCwdRoots: [dispatchWorkspace] }],
    dispatchHub,
    500,
    undefined,
    undefined,
    false,
    {
      startupTimeoutMs: 3_000,
      cancelFallbackMs: 100,
      // The worker phase has no quiet window at all; the drain phase reuses
      // the ambient pair (a short quiet window keeps the cases fast). The
      // worker-phase cap stays well above the mock's several dispatches while
      // remaining short enough for the no-drain cases.
      ambientQuietMs: 250,
      backgroundTaskMaxMs: 1_500,
      // The long tier while the worker is inside an open tool call: well above
      // the mock's 2.5s silent tool, still short enough for a failure to fail
      // fast.
      backgroundTaskToolMs: 8_000,
      // The parked case delays the host's next step by 100ms on purpose.
      backgroundParkedGraceMs: 1_000,
      // These cases pin the LEGACY worker-phase hold; the product default
      // closes the turn at the response so the user keeps talking.
      backgroundHoldWorkerPhase: true,
    },
  )
  const dispatchAdapter = new AcpLlmAdapter(dispatchManager)

  afterAll(async () => {
    await dispatchManager.shutdownAll()
  })

  function dispatchText(chunks: StreamChunk[]): string {
    return chunks
      .filter((chunk): chunk is Extract<StreamChunk, { type: 'text-delta' }> => chunk.type === 'text-delta')
      .map(chunk => chunk.text)
      .join('')
  }

  function dispatchFinish(chunks: StreamChunk[]): Extract<StreamChunk, { type: 'finish' }> | undefined {
    return chunks.find((chunk): chunk is Extract<StreamChunk, { type: 'finish' }> => chunk.type === 'finish')
  }

  /**
   * Wait until the turn is HOLDING: the prompt response landed (the agent-side
   * slot is free) while the driver step is still open and the controller has
   * not settled. The state has no event of its own, so this polls like
   * `waitForAmbient` does.
   */
  async function waitForHold(dshSessionId: string): Promise<NonNullable<ReturnType<BridgeManager['turnStreamFor']>>> {
    const deadline = Date.now() + 10_000
    for (;;) {
      const live = dispatchManager.turnStreamFor(dshSessionId)
      if (live !== undefined && !live.hasSettled && live.hasOpenSegment && live.session.turnSlot === undefined) return live
      if (Date.now() > deadline) throw new Error('the turn never entered a detached-worker hold')
      await new Promise(resolve => setTimeout(resolve, 5))
    }
  }

  const DEFERRAL_REPORT = 'deferred this turn to a background task run'
  const ZERO_OUTPUT_REPORT = 'ended the turn with no visible output'

  it('keeps the turn open for the worker, then folds only the drain\'s answer', async () => {
    const dshSessionId = 'dsh-dispatch-main'
    const since = dispatchEvents.length
    const { chunks, steps } = await hostLoopTurn(dispatchAdapter, {
      provider: 'acp',
      model: 'dispatch',
      sessionId: dshSessionId,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'DISPATCH please' }] }],
    })
    const text = dispatchText(chunks)

    // The coordinator's own words AND the drain's final answer reached the
    // main plane — the second one only exists because the turn stayed open
    // past the prompt response (it lands ~200ms later in this mock, and the
    // host loop closed step 1 long before it).
    expect(text).toContain('DISPATCH-ACK')
    expect(text).toContain('DISPATCH-FINAL-ANSWER')
    // The worker's own turn never does: its prose stays in the transcript.
    expect(text).not.toContain('WORKER-THOUGHT')
    expect(text).not.toContain('WORKER-INTERNAL-TEXT')
    expect(text).not.toContain('WORKER-REPORT-TEXT')
    // A held turn that delivered text is not a deferred or failed one.
    expect(text).not.toContain(DEFERRAL_REPORT)
    expect(text).not.toContain(ZERO_OUTPUT_REPORT)

    // Two driver steps: the Agent card in step 1, then the held step whose
    // single finish arrives only after the drain's answer. The cutting ACK
    // belongs to the NEXT message, so it opens step 2 (by design).
    expect(steps).toHaveLength(2)
    expect(steps[0].filter(chunk => chunk.type === 'text-delta')).toHaveLength(0)
    expect(dispatchText(steps[1])).toContain('DISPATCH-ACK')
    expect(steps[1].filter(chunk => chunk.type === 'finish')).toHaveLength(1)
    expect(dispatchFinish(steps[1])?.reason).toEqual({ kind: 'stop' })
    expect(dispatchText(steps[1])).toContain('DISPATCH-FINAL-ANSWER')

    // Exactly one card on the plane — the coordinator's Agent call. The
    // worker's Bash and the drain's TaskOutput never open one (a card would
    // make the host execute a background tool and continue the turn).
    const callIds = new Set(chunks
      .filter((chunk): chunk is Extract<StreamChunk, { type: 'tool-call-delta' }> => chunk.type === 'tool-call-delta')
      .map(chunk => chunk.id))
    expect(callIds).toEqual(new Set(['agent_dispatch']))

    // One `turn/end`, and it is the LAST thing the turn says: every answer
    // delta — including the final one — precedes it.
    const acpSessionId = dispatchManager.chatSessions(dshSessionId)[0]?.sessionId
    expect(acpSessionId).toBeDefined()
    const frames = dispatchEvents.slice(since).filter(event =>
      event.type === 'turn/end' && event.sessionId === acpSessionId)
    expect(frames).toHaveLength(1)
    expect(frames[0]).toMatchObject({ stopReason: 'end_turn' })
    const significant = dispatchEvents
      .slice(since)
      .filter(event => event.sessionId === acpSessionId)
      .map((event, index) => ({ event, index }))
      .filter(({ event }) => event.type === 'turn/end'
        || (event.type === 'session/update'
          && event.update.sessionUpdate === 'agent_message_chunk'
          && String((event.update.content as { text?: string }).text ?? '').includes('DISPATCH-FINAL-ANSWER')))
    expect(significant).toHaveLength(2)
    expect(significant[0].event.type).toBe('session/update')
    expect(significant[1].event.type).toBe('turn/end')

    // Nothing was lost: the worker's own turn and the drain's TaskOutput are
    // in the transcript the ACP view reads.
    const transcript = await dispatchRpc(dispatchManager, 'transcript/get', { sessionId: acpSessionId! })
    if (!transcript.ok) throw new Error('transcript failed')
    const entries = (transcript.value as { entries: Array<{ update: Record<string, unknown> }> }).entries
      .map(entry => entry.update)
    expect(entries.some(update => update.toolCallId === 'worker_bash' && update.sessionUpdate === 'tool_call')).toBe(true)
    expect(entries.some(update => update.toolCallId === 'drain_task_output' && update.status === 'completed')).toBe(true)
    expect(entries.some(update => update.toolCallId === 'agent_dispatch' && update.status === 'completed')).toBe(true)
  }, 30_000)

  it('reports the detached worker to the host subagent catalog once', async () => {
    const dshSessionId = 'dsh-dispatch-catalog'
    const since = dispatchEvents.length
    const calls: Array<{ dshSessionId: string; childId: string; label: string }> = []
    dispatchManager.setSubagentCatalogReporter((reportedSessionId, childId, label) => {
      calls.push({ dshSessionId: reportedSessionId, childId, label })
    })
    try {
      await hostLoopTurn(dispatchAdapter, {
        provider: 'acp',
        model: 'dispatch',
        sessionId: dshSessionId,
        messages: [{ role: 'user', content: [{ type: 'text', text: 'DISPATCH please' }] }],
      })
      // The caller's own name wins over the task description: it is the
      // identity the coordinator used when it told the user what it sent.
      expect(calls).toEqual([{
        dshSessionId,
        childId: 'acp:agent_dispatch',
        label: 'general-purpose · explorer',
      }])

      // The record stream is the ONLY lifecycle source (the legacy per-worker
      // dot feed is retired). The catalog report itself still happens once,
      // and separately, above.
      expect(unexpectedSubagentFrames(dispatchEvents, since)).toEqual([])
    } finally {
      dispatchManager.setSubagentCatalogReporter(undefined)
    }
  }, 30_000)

  it('names a dispatch with a shared detachment-and-completion frame as completed in its record', async () => {
    const dshSessionId = 'dsh-dispatch-completed-meta'
    const since = dispatchEvents.length
    const calls: Array<{ dshSessionId: string; childId: string; label: string }> = []
    dispatchManager.setSubagentCatalogReporter((reportedSessionId, childId, label) => {
      calls.push({ dshSessionId: reportedSessionId, childId, label })
    })
    try {
      await hostLoopTurn(dispatchAdapter, {
        provider: 'acp',
        model: 'dispatch',
        sessionId: dshSessionId,
        messages: [{ role: 'user', content: [{ type: 'text', text: 'DISPATCH DISPATCHCOMPLETEMETA' }] }],
      })
      // The catalog fact is still recorded (the row exists) even though its
      // work was over when it arrived. (The label itself is not the subject
      // here: this synthetic frame carries no rawInput, so the refresh may
      // only know the role.)
      expect(calls).toHaveLength(1)
      expect(calls[0]).toMatchObject({ dshSessionId, childId: 'acp:agent_dispatch' })
      // The record still tells the truth — creation, then the terminal
      // `completed` the shared frame carried — and the retired dot feed stays
      // silent.
      const records = dispatchEvents
        .slice(since)
        .filter((event): event is Extract<AcpEvent, { type: 'subagents/record' }> =>
          event.type === 'subagents/record' && event.record.childId === 'acp:agent_dispatch')
        .map(event => event.record)
      expect(records.map(record => record.status)).toEqual(['running', 'completed'])
      expect(records.at(-1)?.endedAt).toBeDefined()
      expect(unexpectedSubagentFrames(dispatchEvents, since)).toEqual([])
    } finally {
      dispatchManager.setSubagentCatalogReporter(undefined)
    }
  }, 30_000)

  it('waits for the dispatch identity meta before it reports the catalog row', async () => {
    const dshSessionId = 'dsh-dispatch-catalog-meta'
    const calls: Array<{ dshSessionId: string; childId: string; label: string }> = []
    dispatchManager.setSubagentCatalogReporter((reportedSessionId, childId, label) => {
      calls.push({ dshSessionId: reportedSessionId, childId, label })
    })
    try {
      await hostLoopTurn(dispatchAdapter, {
        provider: 'acp',
        model: 'dispatch',
        sessionId: dshSessionId,
        messages: [{ role: 'user', content: [{ type: 'text', text: 'DISPATCHMETA please' }] }],
      })
      // The worker was alive before the identity frame, but a bare
      // "Agent · 外部任务" row would say nothing: exactly one report, carrying
      // the role and task line from `_meta`, never the tool name.
      expect(calls).toEqual([{
        dshSessionId,
        childId: 'acp:agent_dispatch',
        label: 'general-purpose · audit the repo',
      }])
    } finally {
      dispatchManager.setSubagentCatalogReporter(undefined)
    }
  }, 30_000)

  it('keeps holding while the worker keeps reporting, past the silence window', async () => {
    const dshSessionId = 'dsh-dispatch-keepalive'
    const started = Date.now()
    const { chunks } = await hostLoopTurn(dispatchAdapter, {
      provider: 'acp',
      model: 'dispatch',
      sessionId: dshSessionId,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'DISPATCHKEEPALIVE please' }] }],
    })
    const text = dispatchText(chunks)

    // The worker phase outlived `backgroundTaskMaxMs` (1.5s here) purely on
    // worker updates. A fixed total-runtime cap would have closed the turn with
    // the deferral line and lost the drain's answer.
    expect(Date.now() - started).toBeGreaterThan(1_600)
    expect(text).toContain('DISPATCH-FINAL-ANSWER')
    expect(text).not.toContain(DEFERRAL_REPORT)
    expect(text).not.toContain(ZERO_OUTPUT_REPORT)
  }, 30_000)

  it('keeps holding while the worker is inside one long, silent tool call', async () => {
    const dshSessionId = 'dsh-dispatch-longtool'
    const started = Date.now()
    const { chunks } = await hostLoopTurn(dispatchAdapter, {
      provider: 'acp',
      model: 'dispatch',
      sessionId: dshSessionId,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'DISPATCHLONGTOOL please' }] }],
    })
    const text = dispatchText(chunks)

    // The worker opens its Bash call and then says nothing for 2.5s — longer
    // than `backgroundTaskMaxMs` (1.5s). The open call is the evidence that
    // keeps the worker phase on the long tier; without it the turn would close
    // with the deferral line before the report ever arrived.
    expect(Date.now() - started).toBeGreaterThan(2_000)
    expect(text).toContain('DISPATCH-FINAL-ANSWER')
    expect(text).not.toContain(DEFERRAL_REPORT)
    expect(text).not.toContain(ZERO_OUTPUT_REPORT)
  }, 30_000)

  it('closes a worker that never reports after the worker-phase silence window', async () => {
    const dshSessionId = 'dsh-dispatch-nodrain'
    const since = dispatchEvents.length
    const { chunks } = await hostLoopTurn(dispatchAdapter, {
      provider: 'acp',
      model: 'dispatch',
      sessionId: dshSessionId,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'DISPATCHNODRAIN please' }] }],
    })
    const text = dispatchText(chunks)

    // Nothing pushed the worker-phase silence window out, so it ended the
    // turn — and it says where the rest of the output will land instead of
    // blaming silence.
    expect(text).toContain(DEFERRAL_REPORT)
    expect(text).not.toContain(ZERO_OUTPUT_REPORT)
    expect(dispatchFinish(chunks)?.reason).toEqual({ kind: 'stop' })

    const acpSessionId = dispatchManager.chatSessions(dshSessionId)[0]?.sessionId
    expect(acpSessionId).toBeDefined()
    const frames = dispatchEvents.slice(since).filter(event =>
      event.type === 'turn/end' && event.sessionId === acpSessionId)
    expect(frames).toHaveLength(1)
    expect(frames[0]).toMatchObject({ stopReason: 'end_turn' })
  }, 30_000)

  it('closes a synchronous subagent turn at the response, without a deferral', async () => {
    const dshSessionId = 'dsh-dispatch-sync'
    const since = dispatchEvents.length
    const { chunks } = await hostLoopTurn(dispatchAdapter, {
      provider: 'acp',
      model: 'dispatch',
      sessionId: dshSessionId,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'DISPATCHSYNC please' }] }],
    })
    const text = dispatchText(chunks)

    // The child streamed its own turn (`parentToolCallId`) but the dispatch was
    // never declared background (`isBackground`): the parent consumed the result
    // and answered in the SAME turn. The answer must reach the bubble and the
    // turn must close at the response — no hold, so no deferral line trailing a
    // complete answer (the misread this case pins).
    expect(text).toContain('DISPATCH-SYNC-ANSWER')
    expect(text).not.toContain(DEFERRAL_REPORT)
    expect(text).not.toContain(ZERO_OUTPUT_REPORT)
    expect(dispatchFinish(chunks)?.reason).toEqual({ kind: 'stop' })
    // The worker's own turn stays transcript-only, as for any dispatch.
    expect(text).not.toContain('WORKER-INTERNAL-TEXT')
    expect(text).not.toContain('WORKER-REPORT-TEXT')

    const acpSessionId = dispatchManager.chatSessions(dshSessionId)[0]?.sessionId
    expect(acpSessionId).toBeDefined()
    const frames = dispatchEvents.slice(since).filter(event =>
      event.type === 'turn/end' && event.sessionId === acpSessionId)
    expect(frames).toHaveLength(1)
    expect(frames[0]).toMatchObject({ stopReason: 'end_turn' })
  }, 30_000)

  it('ends a holding turn once when the user cancels it', async () => {
    const dshSessionId = 'dsh-dispatch-cancel'
    const since = dispatchEvents.length
    const abort = new AbortController()
    const running = hostLoopTurn(dispatchAdapter, {
      provider: 'acp',
      model: 'dispatch',
      sessionId: dshSessionId,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'DISPATCHSLOW please' }] }],
    }, 8, abort.signal)
    const holding = await waitForHold(dshSessionId)
    const sessionId = holding.session.sessionId
    const turnId = holding.turnId

    abort.abort()
    const { chunks, steps } = await Promise.race([
      running,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('the holding step never closed')), 5_000)),
    ])

    expect(dispatchFinish(steps.at(-1) ?? [])?.reason).toMatchObject({ kind: 'aborted' })
    const frames = dispatchEvents.slice(since).filter(event => event.type === 'turn/end' && event.sessionId === sessionId)
    expect(frames).toHaveLength(1)
    expect(frames[0]).toMatchObject({ turnId, stopReason: 'cancelled' })
    expect(holding.session.running).toBe(false)
    // The cancel happened before the drain existed: its answer never reached
    // this stream (and the retired id keeps it out of the next one).
    expect(dispatchText(chunks)).not.toContain('DISPATCH-FINAL-ANSWER')
  }, 30_000)

  it('accepts the next prompt while holding, and never folds that hold\'s drain into it', async () => {
    const dshSessionId = 'dsh-dispatch-successor'
    const since = dispatchEvents.length
    const first = hostLoopTurn(dispatchAdapter, {
      provider: 'acp',
      model: 'dispatch',
      sessionId: dshSessionId,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'DISPATCHSLOW please' }] }],
    })
    const holding = await waitForHold(dshSessionId)

    // The user sends again while the worker still runs. The claim is gated on
    // the HOST's prompt slot (released with the response), not on `running`.
    // The second turn is still streaming when the first hold's drain speaks,
    // so the drain text lands while this turn is on air.
    const second = await hostLoopTurn(dispatchAdapter, {
      provider: 'acp',
      model: 'dispatch',
      sessionId: dshSessionId,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'HANG_DELAY:1400 second please' }] }],
    })
    expect(dispatchFinish(second.steps.at(-1) ?? [])?.reason).toEqual({ kind: 'stop' })
    const secondText = dispatchText(second.chunks)
    expect(secondText).toContain('MOCK: echo HANG_DELAY:1400 second please perm=none')
    // The abandoned hold's drain and worker text are not this turn's answer.
    expect(secondText).not.toContain('DISPATCH-FINAL-ANSWER')
    expect(secondText).not.toContain('WORKER-REPORT-TEXT')

    // The superseded holding step ended when the new turn took the controller.
    const firstResult = await Promise.race([
      first,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('the holding step is still parked on its queue')), 5_000)),
    ])
    expect(dispatchFinish(firstResult.steps.at(-1) ?? [])?.reason).toMatchObject({ kind: 'aborted' })
    expect(dispatchText(firstResult.chunks)).not.toContain('DISPATCH-FINAL-ANSWER')

    // The superseded controller was disposed by the successor's
    // `rememberTurnStream`. Its worker now belongs to the SESSION (see
    // `LiveSession.backgroundDispatches`), so its record keeps moving on its
    // own: still running, or `completed` once it reports — never `unknown`,
    // because retiring the turn is no evidence the worker stopped.
    const records = dispatchEvents
      .slice(since)
      .filter((event): event is Extract<AcpEvent, { type: 'subagents/record' }> =>
        event.type === 'subagents/record' && event.record.childId === 'acp:agent_dispatch')
      .map(event => event.record)
    expect(records.length).toBeGreaterThan(0)
    expect(['running', 'completed']).toContain(records.at(-1)?.status)
    expect(unexpectedSubagentFrames(dispatchEvents, since)).toEqual([])

    // Nothing gave the conversation back: the session and its transcript live.
    expect(holding.session.lifecycle).toBe('live')
    expect(dispatchManager.chatSessions(dshSessionId)).toHaveLength(1)
    expect(dispatchEvents.slice(since).some(event =>
      event.type === 'chat/agent-unlocked' && event.dshSessionId === dshSessionId)).toBe(false)
  }, 30_000)

  /**
   * The coordinator's "已派…" ack is the PARENT's interim text, not the held
   * run's answer: a hold that never receives the drained answer must still say
   * where the output will appear. Counting `sawVisibleText` here (the ack
   * already set it) would silently leave the bubble without that line.
   */
  it('reports the deferral after the parent acked but the worker never reported', async () => {
    const dshSessionId = 'dsh-dispatch-acknodrain'
    const since = dispatchEvents.length
    const { chunks } = await hostLoopTurn(dispatchAdapter, {
      provider: 'acp',
      model: 'dispatch',
      sessionId: dshSessionId,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'DISPATCHACKNODRAIN please' }] }],
    })
    const text = dispatchText(chunks)
    expect(text).toContain('DISPATCH-ACK')
    expect(text).toContain(DEFERRAL_REPORT)
    expect(text).not.toContain(ZERO_OUTPUT_REPORT)
    expect(dispatchFinish(chunks)?.reason).toEqual({ kind: 'stop' })

    const acpSessionId = dispatchManager.chatSessions(dshSessionId)[0]?.sessionId
    expect(acpSessionId).toBeDefined()
    const frames = dispatchEvents.slice(since).filter(event =>
      event.type === 'turn/end' && event.sessionId === acpSessionId)
    expect(frames).toHaveLength(1)
  }, 30_000)

  /**
   * A detached worker thinks for tens of seconds between model calls and may
   * be silent longer than the ambient quiet window. The WORKER phase has no
   * quiet clock at all, so the turn must still be holding when the report and
   * the drain's answer arrive.
   */
  it('survives a worker silence longer than the drain quiet window', async () => {
    const dshSessionId = 'dsh-dispatch-silent'
    const { chunks } = await hostLoopTurn(dispatchAdapter, {
      provider: 'acp',
      model: 'dispatch',
      sessionId: dshSessionId,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'DISPATCHSILENT please' }] }],
    })
    const text = dispatchText(chunks)
    // The quiet window here is 250ms; the worker says nothing for 600ms.
    expect(text).toContain('DISPATCH-ACK')
    expect(text).toContain('DISPATCH-FINAL-ANSWER')
    expect(text).not.toContain(DEFERRAL_REPORT)
    expect(text).not.toContain('WORKER-REPORT-TEXT')
  }, 30_000)

  /**
   * Two `Agent` calls, both running when the drain announces itself. The
   * announcement must not arm the drain's quiet clock while a dispatch is
   * still incomplete, and the first worker's report must not close the turn:
   * the second worker's report and the final answer belong to the same turn.
   */
  it('waits for every dispatch: an early announcement and the first report do not close the turn', async () => {
    const dshSessionId = 'dsh-dispatch-two'
    const since = dispatchEvents.length
    const { chunks } = await hostLoopTurn(dispatchAdapter, {
      provider: 'acp',
      model: 'dispatch',
      sessionId: dshSessionId,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'DISPATCHTWO please' }] }],
    })
    const text = dispatchText(chunks)
    expect(text).toContain('DISPATCH-TWO-A-DONE')
    expect(text).toContain('DISPATCH-TWO-B-DONE')
    expect(text).toContain('DISPATCH-TWO-FINAL')
    expect(text).not.toContain(DEFERRAL_REPORT)
    // The worker's own words stay transcript-only.
    expect(text).not.toContain('WORKER-REPORT-TEXT')

    const acpSessionId = dispatchManager.chatSessions(dshSessionId)[0]?.sessionId
    expect(acpSessionId).toBeDefined()
    // Exactly one `turn/end`, and it follows BOTH reports and the answer.
    const relevant = dispatchEvents.slice(since).map((event, index) => ({ event, index })).filter(({ event }) => {
      if (event.type === 'turn/end') return event.sessionId === acpSessionId
      return event.type === 'session/update'
        && event.sessionId === acpSessionId
        && event.update.sessionUpdate === 'agent_message_chunk'
        && ['DISPATCH-TWO-A-DONE', 'DISPATCH-TWO-B-DONE', 'DISPATCH-TWO-FINAL']
          .some(marker => String((event.update.content as { text?: string }).text ?? '').includes(marker))
    })
    expect(relevant).toHaveLength(4)
    expect(relevant.at(-1)?.event.type).toBe('turn/end')
    expect(relevant.filter(({ event }) => event.type === 'turn/end')).toHaveLength(1)

    // Both Agent cards were on the plane; the second dispatch did not wait for
    // the first one's hold to end.
    const callIds = new Set(chunks
      .filter((chunk): chunk is Extract<StreamChunk, { type: 'tool-call-delta' }> => chunk.type === 'tool-call-delta')
      .map(chunk => chunk.id))
    expect(callIds).toEqual(new Set(['agent_dispatch', 'agent_dispatch_two']))
  }, 30_000)

  /**
   * The drain may announce itself BEFORE the prompt response, under an id the
   * response does not name. Both ids belong to this turn: requiring them to
   * match would drop the announced run's answer.
   */
  it('folds a drain announced under another id before the response', async () => {
    const dshSessionId = 'dsh-dispatch-altfirst'
    const { chunks } = await hostLoopTurn(dispatchAdapter, {
      provider: 'acp',
      model: 'dispatch',
      sessionId: dshSessionId,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'DISPATCHALTFIRST please' }] }],
    })
    const text = dispatchText(chunks)
    expect(text).toContain('DISPATCH-ACK')
    expect(text).toContain('DISPATCH-ALT-ANSWER')
    expect(text).not.toContain(DEFERRAL_REPORT)
    expect(text).not.toContain(ZERO_OUTPUT_REPORT)

    // The announced run's steps are in the transcript under its own id.
    const acpSessionId = dispatchManager.chatSessions(dshSessionId)[0]?.sessionId
    const transcript = await dispatchRpc(dispatchManager, 'transcript/get', { sessionId: acpSessionId! })
    if (!transcript.ok) throw new Error('transcript failed')
    const entries = (transcript.value as { entries: Array<{ update: Record<string, unknown> }> }).entries
      .map(entry => entry.update)
    expect(entries.some(update => update.toolCallId === 'drain_task_output')).toBe(true)
  }, 30_000)

  /**
   * A fast worker reports and completes BEFORE the prompt response. The
   * dispatch is completed, but it was structurally detached (`isBackground`,
   * worker updates), so the drain that carries its report is still coming:
   * the response must not close the turn.
   */
  it('holds for a worker that reported before the response', async () => {
    const dshSessionId = 'dsh-dispatch-fast'
    const { chunks } = await hostLoopTurn(dispatchAdapter, {
      provider: 'acp',
      model: 'dispatch',
      sessionId: dshSessionId,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'DISPATCHFAST please' }] }],
    })
    const text = dispatchText(chunks)
    expect(text).toContain('DISPATCH-ACK')
    expect(text).toContain('DISPATCH-FINAL-ANSWER')
    expect(text).not.toContain(DEFERRAL_REPORT)
    expect(text).not.toContain('WORKER-REPORT-TEXT')
  }, 30_000)

  /**
   * The real dispatch COMPLETION frame carries no `_meta` at all. Reading it
   * by id is what starts the drain phase; waiting for the CodeBuddy shape (or
   * for the announcement) would leave the turn in the worker phase until its
   * ten-minute ceiling, and the announcement here is delayed past the drain's
   * quiet window on purpose — the turn must close on the DRAIN's clock, not
   * the worker's cap, and the parent's ack must not suppress the deferral.
   */
  it('starts the drain phase from a completion frame that carries no _meta', async () => {
    const dshSessionId = 'dsh-dispatch-latedrain'
    const since = dispatchEvents.length
    const { chunks } = await hostLoopTurn(dispatchAdapter, {
      provider: 'acp',
      model: 'dispatch',
      sessionId: dshSessionId,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'DISPATCHLATEDRAIN please' }] }],
    })
    const text = dispatchText(chunks)
    expect(text).toContain('DISPATCH-ACK')
    // No drained answer text reached this turn: the deferral line must show.
    expect(text).toContain(DEFERRAL_REPORT)
    expect(text).not.toContain(ZERO_OUTPUT_REPORT)
    // The delayed answer landed after the turn was over (the drain's quiet
    // window closed it), so it stays in the transcript.
    expect(text).not.toContain('DISPATCH-LATE-ANSWER')

    const acpSessionId = dispatchManager.chatSessions(dshSessionId)[0]?.sessionId
    expect(acpSessionId).toBeDefined()
    // The mock keeps streaming after the turn closed; give the delayed answer
    // time to reach the transcript before ordering the two facts.
    const answerDeadline = Date.now() + 5_000
    while (!dispatchEvents.slice(since).some(event =>
      event.type === 'session/update'
      && event.sessionId === acpSessionId
      && event.update.sessionUpdate === 'agent_message_chunk'
      && String((event.update.content as { text?: string }).text ?? '').includes('DISPATCH-LATE-ANSWER'))) {
      if (Date.now() > answerDeadline) throw new Error('the delayed drain answer never reached the transcript')
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    const ordered = dispatchEvents.slice(since).map((event, index) => ({ event, index })).filter(({ event }) => {
      if (event.type === 'turn/end') return event.sessionId === acpSessionId
      return event.type === 'session/update'
        && event.sessionId === acpSessionId
        && event.update.sessionUpdate === 'agent_message_chunk'
        && String((event.update.content as { text?: string }).text ?? '').includes('DISPATCH-LATE-ANSWER')
    })
    expect(ordered).toHaveLength(2)
    expect(ordered[0].event.type).toBe('turn/end')
  }, 30_000)

  /**
   * The response can land BETWEEN driver steps (the ack cut the first one and
   * the host is executing the Agent card). The hold is parked for the next
   * step; when the host opens it late, the drained answer must still fold —
   * and the parked grace, not a quiet clock, owns that wait.
   */
  it('adopts a parked hold when the host opens its step late', async () => {
    const dshSessionId = 'dsh-dispatch-parked'
    const running = hostLoopTurn(dispatchAdapter, {
      provider: 'acp',
      model: 'dispatch',
      sessionId: dshSessionId,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'DISPATCHPARKED please' }] }],
    }, 8, undefined, 300)

    // The parked state: the response landed (host slot free) with no driver
    // step open and the turn not settled.
    const deadline = Date.now() + 10_000
    let parked = false
    while (!parked) {
      const live = dispatchManager.turnStreamFor(dshSessionId)
      parked = live !== undefined && !live.hasSettled && !live.hasOpenSegment && live.session.turnSlot === undefined
      if (!parked) {
        if (Date.now() > deadline) throw new Error('the hold never parked between steps')
        await new Promise(resolve => setTimeout(resolve, 5))
      }
    }

    const { chunks } = await running
    const text = dispatchText(chunks)
    expect(text).toContain('DISPATCH-ACK')
    expect(text).toContain('DISPATCH-FINAL-ANSWER')
    expect(text).not.toContain(DEFERRAL_REPORT)
    expect(text).not.toContain('WORKER-REPORT-TEXT')
  }, 30_000)
})
