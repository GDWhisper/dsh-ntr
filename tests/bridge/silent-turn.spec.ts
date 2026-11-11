import { afterAll, describe, expect, it } from 'vitest'
import { AcpLlmAdapter, BridgeManager } from '../../src/bridge.ts'
import { type AcpEvent, type ChatTranscriptView, type StreamChunk } from '../../src/protocol.ts'
import { dispatchRpc, EventHub } from '../../src/impl.ts'
import { def, hostLoopTurn, settleTranscript } from './harness.ts'

describe('a silent turn is force-finalized and the next message recovers (isolated manager)', () => {
  // Windows are small (the suite would take minutes at the ten-minute
  // defaults) but not tiny: an 80ms window false-finalized HEALTHY warmup
  // turns on a loaded CI box, because the child's first tool card can take
  // longer than that to arrive. 350ms leaves room for spawn + stream jitter
  // while every negative assertion still spans five full windows.
  const STALL_MS = 350
  const TICK_MS = 25
  /** Five windows: "the watchdog had several chances and stayed quiet". */
  const QUIET_MS = STALL_MS * 5 + 100
  const stallHub = new EventHub()
  const stallEvents: AcpEvent[] = []
  stallHub.subscribe(event => { stallEvents.push(event) })
  const stallManager = new BridgeManager([{ ...def, id: 'stall' }], stallHub, 500, undefined, undefined, false, {
    turnStallMs: STALL_MS,
    turnStallTickMs: TICK_MS,
    // A tool call may legitimately take much longer than prose silence; this
    // big number is what keeps the HANG_TOOL turns alive.
    turnStallToolMs: 60_000,
    // Only used to settle the mock's wedged turns during cleanup — the stall
    // itself is not a cancel fallback.
    cancelFallbackMs: 300,
    turnSettleMs: 200,
  })
  const stallAdapter = new AcpLlmAdapter(stallManager)
  // Same windows, but the mock advertises NO `loadSession`: a stall there can
  // only be recovered by resetting the session (the context is unrecoverable).
  const noLoadManager = new BridgeManager([{ ...def, id: 'stall-noload', env: { MOCK_NO_LOAD: '1' } }], stallHub, 500, undefined, undefined, false, {
    turnStallMs: STALL_MS,
    turnStallTickMs: TICK_MS,
    turnStallToolMs: 60_000,
    cancelFallbackMs: 300,
    turnSettleMs: 200,
  })
  const noLoadAdapter = new AcpLlmAdapter(noLoadManager)
  // The hostile no-load agent: it also never answers `session/close`. A reset
  // that waited for a graceful close would hang the next message forever.
  const wedgedManager = new BridgeManager([{ ...def, id: 'stall-wedged', env: { MOCK_NO_LOAD: '1', MOCK_IGNORE_CLOSE: '1' } }], stallHub, 500, undefined, undefined, false, {
    turnStallMs: STALL_MS,
    turnStallTickMs: TICK_MS,
    turnStallToolMs: 60_000,
    cancelFallbackMs: 300,
    turnSettleMs: 200,
  })
  const wedgedAdapter = new AcpLlmAdapter(wedgedManager)
  // `turnStallMs: 0` is the off switch: no scan is armed at all.
  const offManager = new BridgeManager([{ ...def, id: 'stall-off' }], stallHub, 500, undefined, undefined, false, {
    turnStallMs: 0,
    turnStallTickMs: TICK_MS,
    cancelFallbackMs: 300,
  })
  const offAdapter = new AcpLlmAdapter(offManager)
  // `turnStallToolMs: 0` means "no separate tool window": the base window is
  // the only one in force, even with a tool in flight.
  const fallbackManager = new BridgeManager([{ ...def, id: 'stall-fallback' }], stallHub, 500, undefined, undefined, false, {
    turnStallMs: STALL_MS,
    turnStallTickMs: TICK_MS,
    turnStallToolMs: 0,
    cancelFallbackMs: 300,
  })
  const fallbackAdapter = new AcpLlmAdapter(fallbackManager)

  /**
   * Tear a manager down on the CRASH path: `shutdownAll` awaits
   * `session/close`, and the IGNORE_CLOSE mock never answers that request.
   * `releaseAll` is what the process-death path uses — it drops the local
   * records and kills the child — so it cannot block.
   */
  function hardStop(manager: BridgeManager): void {
    const seam = manager as unknown as { bridges: Map<string, { releaseAll(reason: string): void }> }
    for (const bridge of seam.bridges.values()) bridge.releaseAll('test teardown')
  }

  afterAll(async () => {
    await noLoadManager.shutdownAll()
    await stallManager.shutdownAll()
    await offManager.shutdownAll()
    await fallbackManager.shutdownAll()
    // Kill the child first; the graceful stop that follows is then a no-op.
    hardStop(wedgedManager)
    await wedgedManager.shutdownAll()
  })

  function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms))
  }

  /**
   * Wait for a frame that lands at or after `since`. The caller takes the
   * watermark before triggering the action, so an earlier test's frame can
   * neither satisfy the wait nor hide a missing one; the initial scan closes
   * the gap where the frame arrives before this subscription.
   */
  function stallWaitFor<T extends AcpEvent['type']>(type: T, predicate: (event: Extract<AcpEvent, { type: T }>) => boolean, since: number, timeoutMs = 10_000): Promise<Extract<AcpEvent, { type: T }>> {
    return new Promise((resolve, reject) => {
      let done = false
      const settle = (event: Extract<AcpEvent, { type: T }>): void => {
        if (done) return
        done = true
        clearTimeout(timer)
        unsub()
        resolve(event)
      }
      const timer = setTimeout(() => {
        if (done) return
        done = true
        unsub()
        reject(new Error(`timeout waiting for ${type}`))
      }, timeoutMs)
      const unsub = stallHub.subscribe(event => {
        if (event.type === type && stallEvents.indexOf(event) >= since
          && predicate(event as Extract<AcpEvent, { type: T }>)) settle(event as Extract<AcpEvent, { type: T }>)
      })
      for (const event of stallEvents) {
        if (event.type === type && stallEvents.indexOf(event) >= since
          && predicate(event as Extract<AcpEvent, { type: T }>)) {
          settle(event as Extract<AcpEvent, { type: T }>)
          break
        }
      }
    })
  }

  /** Drain one adapter stream (the first driver step) on any of this suite's managers. */
  async function drainWith(adapter: AcpLlmAdapter, model: string, text: string, sessionId: string, signal?: AbortSignal): Promise<StreamChunk[]> {
    const chunks: StreamChunk[] = []
    for await (const chunk of adapter.stream({
      provider: 'acp',
      model,
      sessionId,
      ...(signal === undefined ? {} : { signal }),
      messages: [{ role: 'user', content: [{ type: 'text', text }] }],
    })) {
      chunks.push(chunk)
    }
    return chunks
  }

  /** Drain one adapter stream for a chat session (the first driver step). */
  function drain(text: string, sessionId: string, signal?: AbortSignal): Promise<StreamChunk[]> {
    return drainWith(stallAdapter, 'stall', text, sessionId, signal)
  }

  /** Drain one adapter stream on the no-loadSession manager. */
  function drainNoLoad(text: string, sessionId: string): Promise<StreamChunk[]> {
    return drainWith(noLoadAdapter, 'stall-noload', text, sessionId)
  }

  /**
   * Wait until the agent has SETTLED the session's turn (`running: false`).
   * A driver step can finish at its last card well before the agent answers
   * `session/prompt`, and a prompt sent into that window is refused
   * `turn_in_flight` — a race in the test, not in the product.
   */
  async function waitForTurnSettled(manager: BridgeManager, dshSessionId: string, timeoutMs = 8_000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const live = sessionViewOf(manager, dshSessionId)
      if (live === undefined || live.running !== true) return
      if (Date.now() > deadline) throw new Error('timeout waiting for the turn to settle')
      await sleep(20)
    }
  }

  function finishOf(chunks: StreamChunk[]): Extract<StreamChunk, { type: 'finish' }> | undefined {
    return chunks.find((chunk): chunk is Extract<StreamChunk, { type: 'finish' }> => chunk.type === 'finish')
  }

  function stallMessage(chunks: StreamChunk[]): string {
    const reason = finishOf(chunks)?.reason
    return reason?.kind === 'error' ? reason.failure?.message ?? '' : ''
  }

  /** The live session record behind one chat session (the HOST session id, not the ACP one). */
  function sessionViewOf(manager: BridgeManager, dshSessionId: string): ChatTranscriptView['session'] | undefined {
    return manager.chatTranscripts(dshSessionId)[0]?.session
  }

  /** The chat session's agent chunks, joined (what the user actually saw). */
  function transcriptTextOf(manager: BridgeManager, dshSessionId: string): string {
    return manager.chatTranscripts(dshSessionId)
      .flatMap(view => view.entries)
      .filter(entry => (entry.update as Record<string, unknown>).sessionUpdate === 'agent_message_chunk')
      .map(entry => String(((entry.update as Record<string, unknown>).content as { text?: string }).text ?? ''))
      .join('')
  }

  function transcriptText(dshSessionId: string): string {
    return transcriptTextOf(stallManager, dshSessionId)
  }

  /**
   * Wait until a chat transcript contains `needle`. A late agent answer keeps
   * writing into the transcript after our face of the turn has closed, so the
   * assertion has to wait for the text, not for a frame.
   */
  async function waitForTranscriptText(manager: BridgeManager, dshSessionId: string, needle: string, timeoutMs = 8_000): Promise<string> {
    const deadline = Date.now() + timeoutMs
    let text = transcriptTextOf(manager, dshSessionId)
    while (!text.includes(needle) && Date.now() < deadline) {
      await sleep(20)
      text = transcriptTextOf(manager, dshSessionId)
    }
    return text
  }

  it('chat path: a turn that sends nothing ends with INACTIVITY_TIMEOUT and a notice', async () => {
    const since = stallEvents.length
    const chunks = await drain('HANG please', 'dsh-stall-hang')
    const finish = finishOf(chunks)
    expect(finish?.reason).toMatchObject({ kind: 'error', failure: { code: 'INACTIVITY_TIMEOUT' } })
    expect(stallMessage(chunks)).toContain('sent no activity')

    // The /acp face of the same turn is a turn/end error (the browser's ACP
    // view and the settings ledger both read that frame). A zero-output FIRST
    // turn settles its provisional lock by rolling back the conversation, so
    // the ACP session id comes from the frame, not from `chatTranscripts`.
    const ended = stallEvents.slice(since)
      .find(event => event.type === 'turn/end' && event.error !== undefined && event.error.includes('sent no activity'))
    expect(ended).toBeDefined()
    if (ended?.type === 'turn/end') expect(ended.error).toContain('sent no activity')

    // One process-wide notice per stall, telling the user what happened AND
    // what the next message will do about it. This was the conversation's FIRST
    // turn and it delivered nothing, so the rollback it triggers is what the
    // promise must describe: no resume, a new ACP session. (The resume promise
    // for a turn that HAS output is pinned by the tool-window test below.)
    const notices = stallEvents.slice(since)
      .filter(event => event.type === 'agent/notice' && event.text.includes('sent no activity'))
    expect(notices).toHaveLength(1)
    if (notices[0]?.type === 'agent/notice') {
      expect(notices[0].agentId).toBe('stall')
      expect(notices[0].text).toContain('sent no activity')
      expect(notices[0].text).toContain('first turn and it delivered nothing')
      expect(notices[0].text).toContain('the next message starts a new ACP session')
      expect(notices[0].text).not.toContain('does not support session resume')
      expect(notices[0].text).not.toContain('restart the agent and resume the session')
    }
  }, 15_000)

  it('does not fire while a permission ask is waiting for the human', async () => {
    const since = stallEvents.length
    const drained = drain('PERM hold', 'dsh-stall-perm')
    const ask = await stallWaitFor('permission/request', () => true, since)
    const acpSessionId = ask.sessionId

    // Several watchdog windows pass with the ask open. Firing here would end
    // the turn under the card the human is still looking at.
    await sleep(QUIET_MS)
    expect(stallEvents.slice(since).some(event =>
      event.type === 'turn/end' && event.sessionId === acpSessionId && event.error?.includes('sent no activity') === true)).toBe(false)
    expect(stallEvents.slice(since).some(event =>
      event.type === 'agent/notice' && event.text.includes('sent no activity'))).toBe(false)

    // Answering lets the agent finish normally: the turn ends by the agent's
    // own stop, not by the watchdog.
    const replySince = stallEvents.length
    await dispatchRpc(stallManager, 'permission/respond', { requestId: ask.requestId, optionId: 'allow1' })
    const chunks = await drained
    expect(finishOf(chunks)?.reason).toMatchObject({ kind: 'stop' })
    await stallWaitFor('turn/end', event => event.sessionId === acpSessionId && event.stopReason === 'end_turn', replySince)

    // Retire the session: a card-bearing turn keeps its stream controller
    // indexed until the host loop takes its continuation step or the session
    // closes, and this manager is shared with the reclaim tests below — a
    // leftover controller of a conversation nobody is using would pin the
    // agent process there (the reclaim refuses while a sibling looks mid-turn).
    await dispatchRpc(stallManager, 'session/close', { sessionId: acpSessionId })
  }, 15_000)

  it('chat path: the next message restarts the agent and resumes the session before sending', async () => {
    // A first turn that delivers nothing rolls its provisional lock back and
    // drops the session (existing semantics), so the stalled conversation has
    // to be one that already produced output — the case a real user is in.
    await hostLoopTurn(stallAdapter, {
      provider: 'acp',
      model: 'stall',
      sessionId: 'dsh-stall-reclaim',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hello warmup PIDTAG' }] }],
    })
    // The process that serves the conversation BEFORE the stall. `PIDTAG` is
    // opt-in in the mock, so no exact-echo assertion elsewhere sees it.
    const warm = await waitForTranscriptText(stallManager, 'dsh-stall-reclaim', 'PID:')
    const oldPid = /PID:(\d+)/.exec(warm)?.[1] ?? ''
    expect(oldPid).not.toBe('')
    const stalled = await drain('HANG please', 'dsh-stall-reclaim')
    expect(finishOf(stalled)?.reason).toMatchObject({ kind: 'error', failure: { code: 'INACTIVITY_TIMEOUT' } })

    // The orphan cleanup must replace the wedged process and run session/load
    // BEFORE delivering the new prompt. The mock only ever emits the replay
    // marker from `session/load`, so its presence proves the context came back
    // on a fresh child; the echo proves the prompt then reached that child —
    // and its pid proves that child is NOT the wedged one (a `session/load`
    // replays for any process, so `REPLAYED` alone cannot tell them apart).
    await hostLoopTurn(stallAdapter, {
      provider: 'acp',
      model: 'stall',
      sessionId: 'dsh-stall-reclaim',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hello after stall PIDTAG' }] }],
    })
    const acpSessionId = stallManager.chatTranscripts('dsh-stall-reclaim')[0]?.session.sessionId ?? ''
    expect(acpSessionId).not.toBe('')
    await settleTranscript(stallManager, acpSessionId)
    const text = transcriptText('dsh-stall-reclaim')
    expect(text).toContain('REPLAYED: earlier conversation')
    expect(text).toContain('MOCK: echo hello after stall PIDTAG perm=none')
    const newPid = /MOCK: echo hello after stall PIDTAG perm=none PID:(\d+)/.exec(text)?.[1] ?? ''
    expect(newPid).not.toBe('')
    expect(newPid).not.toBe(oldPid)

    // Retire the conversation: the manager is shared, and a reclaim (below)
    // refuses to restart the agent while another live session looks busy.
    await dispatchRpc(stallManager, 'session/close', { sessionId: acpSessionId })
  }, 20_000)

  it('/acp path: broadcasts the stall error, and a second prompt succeeds after resume', async () => {
    const start = await dispatchRpc(stallManager, 'session/start', { agentId: 'stall' })
    if (!start.ok) throw new Error('start failed')
    const sessionId = (start.value as { sessionId: string }).sessionId

    const since = stallEvents.length
    const first = await dispatchRpc(stallManager, 'session/prompt', { sessionId, text: 'HANG' })
    expect(first).toMatchObject({ ok: true, value: { accepted: true } })
    await stallWaitFor('turn/end', event =>
      event.sessionId === sessionId && event.error !== undefined && event.error.includes('sent no activity'), since)

    // The next prompt must not be answered `turn_in_flight`: the orphan is
    // reclaimed (process restarted, session/load replayed) and then served.
    const resumeSince = stallEvents.length
    const second = await dispatchRpc(stallManager, 'session/prompt', { sessionId, text: 'hello after stall' })
    expect(second).toMatchObject({ ok: true, value: { accepted: true } })
    if (!second.ok) return
    const turnId = (second.value as { turnId: string }).turnId
    await stallWaitFor('turn/end', event => event.sessionId === sessionId && event.turnId === turnId && event.stopReason === 'end_turn', resumeSince)
    await settleTranscript(stallManager, sessionId)

    const transcript = await dispatchRpc(stallManager, 'transcript/get', { sessionId })
    if (!transcript.ok) throw new Error('transcript failed')
    const text = (transcript.value as { entries: Array<{ update: Record<string, unknown> }> }).entries
      .filter(entry => entry.update.sessionUpdate === 'agent_message_chunk')
      .map(entry => String((entry.update.content as { text?: string }).text ?? ''))
      .join('')
    expect(text).toContain('REPLAYED: earlier conversation')
    expect(text).toContain('MOCK: echo hello after stall')

    // Retire the session: the shared manager's reclaim refuses while another
    // live session looks busy, and this one is done.
    await dispatchRpc(stallManager, 'session/close', { sessionId })
  }, 20_000)

  it('/acp path: the late real response still lands as its own turn/end', async () => {
    const start = await dispatchRpc(stallManager, 'session/start', { agentId: 'stall' })
    if (!start.ok) throw new Error('start failed')
    const sessionId = (start.value as { sessionId: string }).sessionId

    const since = stallEvents.length
    const first = await dispatchRpc(stallManager, 'session/prompt', { sessionId, text: 'HANG_DELAY:1200' })
    if (!first.ok) throw new Error('prompt failed')
    const turnId = (first.value as { turnId: string }).turnId

    // The watchdog speaks FIRST: the agent stays silent past the window
    // (1200ms is more than three of them) before it answers.
    const watchdog = await stallWaitFor('turn/end', event =>
      event.sessionId === sessionId && event.error !== undefined && event.error.includes('sent no activity'), since)

    // ...then the agent's own (late) response is still broadcast as the real
    // settlement of that same turn, with its own stop reason.
    const real = await stallWaitFor('turn/end', event =>
      event.sessionId === sessionId && event.turnId === turnId && event.stopReason === 'end_turn', since, 5_000)
    expect(real.turnId).toBe(turnId)
    expect(watchdog.error).toContain('sent no activity')

    // The session is usable again afterwards.
    const resumeSince = stallEvents.length
    const third = await dispatchRpc(stallManager, 'session/prompt', { sessionId, text: 'hello after late' })
    expect(third).toMatchObject({ ok: true, value: { accepted: true } })
    if (!third.ok) return
    const thirdTurnId = (third.value as { turnId: string }).turnId
    await stallWaitFor('turn/end', event => event.sessionId === sessionId && event.turnId === thirdTurnId && event.stopReason === 'end_turn', resumeSince)

    // Retire the session so a later reclaim on this shared agent is not told
    // another conversation is still using it.
    await dispatchRpc(stallManager, 'session/close', { sessionId })
  }, 20_000)

  it('holds a turn whose tool call is still in flight on the base window', async () => {
    // HANG_TOOL emits the usual opening (thought / plan / tool card) and then
    // goes silent with `call_1` pending. The base window would fire many times
    // over; the tool window (60s here) is the one that applies.
    const since = stallEvents.length
    const controller = new AbortController()
    const drained = drain('HANG_TOOL please', 'dsh-stall-tool', controller.signal)
    const settledEarly = await Promise.race([
      drained.then(() => true),
      sleep(QUIET_MS).then(() => false),
    ])
    expect(settledEarly).toBe(false)
    expect(stallEvents.slice(since).some(event =>
      event.type === 'agent/notice' && event.text.includes('sent no activity'))).toBe(false)

    // Cleanup: the host aborts (a human pressing stop); the mock ignores the
    // cancel, and the abort finishes OUR face of the turn immediately. The
    // session record still reads `running` (the agent never answered), so it
    // must be retired too or every later reclaim on this shared agent is
    // refused on its behalf.
    controller.abort()
    expect(finishOf(await drained)?.reason.kind).toBe('aborted')
    const hostId = sessionViewOf(stallManager, 'dsh-stall-tool')?.sessionId
    if (hostId !== undefined) await dispatchRpc(stallManager, 'session/close', { sessionId: hostId })
  }, 15_000)

  it('refuses reclaim while another conversation on the agent is still working', async () => {
    // A must outlive its stall: give it one delivered turn first (a zero-output
    // first turn would roll its provisional lock back instead of leaving an
    // orphan the reclaim has to deal with).
    await hostLoopTurn(stallAdapter, {
      provider: 'acp',
      model: 'stall',
      sessionId: 'dsh-stall-guard-a',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hello warmup' }] }],
    })

    // A: a wedged turn that the watchdog finalizes. B: a turn with a tool call
    // still in flight, i.e. genuine work the process must keep serving.
    const busyController = new AbortController()
    const since = stallEvents.length
    const stalled = drain('HANG please', 'dsh-stall-guard-a')
    const busy = drain('HANG_TOOL please', 'dsh-stall-guard-b', busyController.signal)

    // A sends nothing, so the first tool_call belongs to B: waiting for it
    // makes "another conversation is working" a fact instead of a timing guess.
    await stallWaitFor('session/update', event =>
      (event.update as { sessionUpdate?: string }).sessionUpdate === 'tool_call', since)

    const stalledChunks = await stalled
    expect(finishOf(stalledChunks)?.reason).toMatchObject({ kind: 'error', failure: { code: 'INACTIVITY_TIMEOUT' } })

    // A's next message cannot reclaim the process: killing it would murder B.
    const refused = await drain('hello after stall', 'dsh-stall-guard-a')
    const refusedFinish = finishOf(refused)
    expect(refusedFinish?.reason).toMatchObject({ kind: 'error' })
    expect(stallMessage(refused)).toContain('other conversations are still using it')

    // ...and the agent process was NOT killed to free A.
    expect(stallManager.agentViews().find(view => view.id === 'stall')?.state).toBe('ready')
    const listed = await dispatchRpc(stallManager, 'sessions/list', {})
    if (!listed.ok) throw new Error('sessions/list failed')
    expect((listed.value as { sessions: Array<{ running?: boolean }> }).sessions.some(session => session.running === true)).toBe(true)

    busyController.abort()
    await busy
    // Retire both sessions: B's agent never acknowledged the abort (the mock
    // ignores `session/cancel`), so its record still reads `running` — genuine
    // work on this manager's shared agent, which the reclaim tests below would
    // (correctly) refuse to kill. Closing drops the records; the wedged prompt
    // the mock still holds dies with the child the next reclaim restarts.
    for (const chatId of ['dsh-stall-guard-a', 'dsh-stall-guard-b']) {
      const hostId = sessionViewOf(stallManager, chatId)?.sessionId
      if (hostId !== undefined) await dispatchRpc(stallManager, 'session/close', { sessionId: hostId })
    }
  }, 20_000)

  it('resets a stalled session when the agent advertises no loadSession', async () => {
    // A delivered turn first, so the reset has real context to drop.
    await hostLoopTurn(noLoadAdapter, {
      provider: 'acp',
      model: 'stall-noload',
      sessionId: 'dsh-stall-noload',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hello warmup' }] }],
    })
    const oldView = sessionViewOf(noLoadManager, 'dsh-stall-noload')
    const oldHostId = oldView?.sessionId ?? ''
    const oldAcpSessionId = oldView?.acpSessionId ?? ''
    expect(oldHostId).not.toBe('')
    expect(oldAcpSessionId).not.toBe('')

    const stallSince = stallEvents.length
    const stalled = await drainNoLoad('HANG please', 'dsh-stall-noload')
    expect(finishOf(stalled)?.reason).toMatchObject({ kind: 'error', failure: { code: 'INACTIVITY_TIMEOUT' } })

    // The same watchdog notice, but this agent has nothing to resume: its
    // promise is the reset half, not "restart and resume".
    const stallNotice = stallEvents.slice(stallSince)
      .find(event => event.type === 'agent/notice' && event.agentId === 'stall-noload' && event.text.includes('sent no activity'))
    expect(stallNotice).toBeDefined()
    if (stallNotice?.type === 'agent/notice') {
      expect(stallNotice.text).toContain('sent no activity')
      expect(stallNotice.text).toContain('does not support session resume')
      expect(stallNotice.text).not.toContain('restart the agent and resume the session')
    }

    const since = stallEvents.length
    await hostLoopTurn(noLoadAdapter, {
      provider: 'acp',
      model: 'stall-noload',
      sessionId: 'dsh-stall-noload',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hello after reset' }] }],
    })

    // The next message is served on a NEW session: no `session/load` exists, so
    // the record was dropped (rather than parked as `released`) and the user is
    // told the context is gone. Both the host record and the AGENT-side session
    // are new — a reset means a fresh `session/new`, not a resumed one.
    const views = noLoadManager.chatTranscripts('dsh-stall-noload')
    expect(views).toHaveLength(1)
    const newHostId = views[0]?.session.sessionId ?? ''
    const newAcpSessionId = views[0]?.session.acpSessionId ?? ''
    expect(newHostId).not.toBe('')
    expect(newHostId).not.toBe(oldHostId)
    expect(newAcpSessionId).not.toBe('')
    expect(newAcpSessionId).not.toBe(oldAcpSessionId)
    const notice = stallEvents.slice(since)
      .find(event => event.type === 'agent/notice' && event.agentId === 'stall-noload' && event.text.includes('does not support session resume'))
    expect(notice).toBeDefined()

    await settleTranscript(noLoadManager, newHostId)
    const text = transcriptTextOf(noLoadManager, 'dsh-stall-noload')
    expect(text).toContain('MOCK: echo hello after reset')
    // Nothing was replayed from the previous process: the context is gone.
    expect(text).not.toContain('REPLAYED: earlier conversation')

    // Retire it: a no-load reclaim restarts the whole child, so it refuses
    // while ANY other live session shares it — the `/acp` test below needs an
    // agent with nothing else on it.
    await expect(dispatchRpc(noLoadManager, 'session/close', { sessionId: newHostId }))
      .resolves.toMatchObject({ ok: true })
  }, 30_000)

  it('turnStallMs: 0 disables the watchdog entirely', async () => {
    // `0` is the documented off switch, not "expire immediately": no scan is
    // armed at all, so a wedged turn simply stays the agent's until the human
    // stops it.
    const since = stallEvents.length
    const controller = new AbortController()
    const drained = drainWith(offAdapter, 'stall-off', 'HANG please', 'dsh-stall-off', controller.signal)
    const settledEarly = await Promise.race([
      drained.then(() => true),
      sleep(QUIET_MS).then(() => false),
    ])
    expect(settledEarly).toBe(false)
    expect(stallEvents.slice(since).some(event =>
      event.type === 'agent/notice' && event.agentId === 'stall-off')).toBe(false)
    expect(stallEvents.slice(since).some(event =>
      event.type === 'turn/end' && event.error !== undefined && event.error.includes('sent no activity'))).toBe(false)

    // Cleanup: the human's stop. The mock ignores the cancel, so the turn slot
    // stays the agent's; the zero-output first turn rolls its provisional lock
    // back and retires the session, otherwise a close must do it.
    const hostId = sessionViewOf(offManager, 'dsh-stall-off')?.sessionId ?? ''
    expect(hostId).not.toBe('')
    controller.abort()
    expect(finishOf(await drained)?.reason.kind).toBe('aborted')
    if (sessionViewOf(offManager, 'dsh-stall-off') !== undefined) {
      await expect(dispatchRpc(offManager, 'session/close', { sessionId: hostId }))
        .resolves.toMatchObject({ ok: true })
    }
  }, 20_000)

  it('turnStallToolMs: 0 falls back to the base window', async () => {
    // No separate tool window: an in-flight tool call is measured against
    // `turnStallMs`, so a HANG_TOOL turn is finalized like a silent one.
    const since = stallEvents.length
    const chunks = await drainWith(fallbackAdapter, 'stall-fallback', 'HANG_TOOL please', 'dsh-stall-fallback')
    expect(finishOf(chunks)?.reason).toMatchObject({ kind: 'error', failure: { code: 'INACTIVITY_TIMEOUT' } })

    // The same notice as any other stall (this agent can resume).
    const notice = stallEvents.slice(since)
      .find(event => event.type === 'agent/notice' && event.agentId === 'stall-fallback' && event.text.includes('sent no activity'))
    expect(notice).toBeDefined()
    if (notice?.type === 'agent/notice') {
      expect(notice.text).toContain('The next message will restart the agent and resume the session.')
    }

    // The tool card counts as a delivered first turn, so the session is still
    // live here: retire it explicitly.
    const hostId = sessionViewOf(fallbackManager, 'dsh-stall-fallback')?.sessionId ?? ''
    expect(hostId).not.toBe('')
    await expect(dispatchRpc(fallbackManager, 'session/close', { sessionId: hostId }))
      .resolves.toMatchObject({ ok: true })
  }, 20_000)

  it('keeps the tool window while a second parallel call is still in progress', async () => {
    // HANG_TWO_TOOLS completes `ta` and leaves `tb` in_progress. The finished
    // call must not close the tool window: the turn is still waiting on `tb`,
    // and its sibling finishing is not the agent going quiet. A boolean
    // "some tool is in flight" flipped false right here and finalized the turn
    // on the BASE window.
    const since = stallEvents.length
    const controller = new AbortController()
    const drained = drain('HANG_TWO_TOOLS please', 'dsh-stall-parallel', controller.signal)
    const settledEarly = await Promise.race([
      drained.then(() => true),
      sleep(QUIET_MS).then(() => false),
    ])
    expect(settledEarly).toBe(false)
    expect(stallEvents.slice(since).some(event =>
      event.type === 'agent/notice' && event.text.includes('sent no activity'))).toBe(false)

    controller.abort()
    expect(finishOf(await drained)?.reason.kind).toBe('aborted')
    const hostId = sessionViewOf(stallManager, 'dsh-stall-parallel')?.sessionId ?? ''
    expect(hostId).not.toBe('')
    await expect(dispatchRpc(stallManager, 'session/close', { sessionId: hostId }))
      .resolves.toMatchObject({ ok: true })
  }, 20_000)

  it('resets a wedged no-loadSession agent without waiting for session/close', async () => {
    // The hostile combination: no resume support AND `session/close` is never
    // answered. The reset has to kill the process — a reset that asks the
    // wedged agent to close first would hang the user's next message forever.
    await hostLoopTurn(wedgedAdapter, {
      provider: 'acp',
      model: 'stall-wedged',
      sessionId: 'dsh-stall-wedged',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hello warmup' }] }],
    })
    const oldAcpSessionId = sessionViewOf(wedgedManager, 'dsh-stall-wedged')?.acpSessionId ?? ''
    expect(oldAcpSessionId).not.toBe('')

    const stallSince = stallEvents.length
    const stalled = await drainWith(wedgedAdapter, 'stall-wedged', 'HANG please', 'dsh-stall-wedged')
    expect(finishOf(stalled)?.reason).toMatchObject({ kind: 'error', failure: { code: 'INACTIVITY_TIMEOUT' } })
    const stallNotice = stallEvents.slice(stallSince)
      .find(event => event.type === 'agent/notice' && event.agentId === 'stall-wedged' && event.text.includes('sent no activity'))
    expect(stallNotice).toBeDefined()
    if (stallNotice?.type === 'agent/notice') {
      expect(stallNotice.text).toContain('does not support session resume')
      expect(stallNotice.text).not.toContain('restart the agent and resume the session')
    }

    // The next message must go through on a NEW agent session. If the reset
    // awaited `session/close`, this await would never resolve.
    const since = stallEvents.length
    await hostLoopTurn(wedgedAdapter, {
      provider: 'acp',
      model: 'stall-wedged',
      sessionId: 'dsh-stall-wedged',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hello after wedged reset' }] }],
    })
    const newView = sessionViewOf(wedgedManager, 'dsh-stall-wedged')
    expect(newView).toBeDefined()
    expect(newView?.acpSessionId).not.toBe('')
    expect(newView?.acpSessionId).not.toBe(oldAcpSessionId)
    expect(stallEvents.slice(since)
      .some(event => event.type === 'agent/notice' && event.agentId === 'stall-wedged' && event.text.includes('does not support session resume'))).toBe(true)

    await settleTranscript(wedgedManager, newView?.sessionId ?? '')
    const text = transcriptTextOf(wedgedManager, 'dsh-stall-wedged')
    expect(text).toContain('MOCK: echo hello after wedged reset')
    // A reset has no history to replay.
    expect(text).not.toContain('REPLAYED: earlier conversation')
  }, 20_000)

  it('/acp path: refuses to reclaim while another /acp conversation is working', async () => {
    const stalledStart = await dispatchRpc(stallManager, 'session/start', { agentId: 'stall' })
    const busyStart = await dispatchRpc(stallManager, 'session/start', { agentId: 'stall' })
    if (!stalledStart.ok || !busyStart.ok) throw new Error('start failed')
    const stalledId = (stalledStart.value as { sessionId: string }).sessionId
    const busyId = (busyStart.value as { sessionId: string }).sessionId
    expect(stalledId).not.toBe(busyId)

    const since = stallEvents.length
    const stalledPrompt = await dispatchRpc(stallManager, 'session/prompt', { sessionId: stalledId, text: 'HANG' })
    expect(stalledPrompt).toMatchObject({ ok: true, value: { accepted: true } })
    const busyPrompt = await dispatchRpc(stallManager, 'session/prompt', { sessionId: busyId, text: 'HANG_TOOL' })
    expect(busyPrompt).toMatchObject({ ok: true, value: { accepted: true } })

    // The stalled turn sends nothing, so the tool card belongs to the busy
    // conversation: waiting for it makes "it is still working" a fact.
    await stallWaitFor('session/update', event =>
      event.sessionId === busyId && (event.update as { toolCallId?: string }).toolCallId === 'call_1', since)
    await stallWaitFor('turn/end', event =>
      event.sessionId === stalledId && event.error !== undefined && event.error.includes('sent no activity'), since)

    // Reclaiming would kill the child and murder the busy turn: refuse.
    const refused = await dispatchRpc(stallManager, 'session/prompt', { sessionId: stalledId, text: 'hello after stall' })
    expect(refused).toMatchObject({ ok: false, error: { code: 'agent_unresponsive' } })
    if (!refused.ok) expect(refused.error.message).toContain('other conversations are still using it')

    // ...and nothing was killed to free the stalled conversation.
    expect(stallManager.agentViews().find(view => view.id === 'stall')?.state).toBe('ready')
    const listed = await dispatchRpc(stallManager, 'sessions/list', {})
    if (!listed.ok) throw new Error('sessions/list failed')
    const busyView = (listed.value as { sessions: Array<{ sessionId: string; running?: boolean }> }).sessions
      .find(session => session.sessionId === busyId)
    expect(busyView?.running).toBe(true)

    // Cleanup: stop the busy turn, retire both sessions.
    await dispatchRpc(stallManager, 'session/cancel', { sessionId: busyId })
    await dispatchRpc(stallManager, 'session/close', { sessionId: busyId })
    await dispatchRpc(stallManager, 'session/close', { sessionId: stalledId })
  }, 20_000)

  it('/acp path: reclaiming a stalled session emits exactly one turn/end for it', async () => {
    const start = await dispatchRpc(stallManager, 'session/start', { agentId: 'stall' })
    if (!start.ok) throw new Error('start failed')
    const sessionId = (start.value as { sessionId: string }).sessionId

    const since = stallEvents.length
    const first = await dispatchRpc(stallManager, 'session/prompt', { sessionId, text: 'HANG' })
    if (!first.ok) throw new Error('prompt failed')
    const abandonedTurnId = (first.value as { turnId: string }).turnId
    const watchdog = await stallWaitFor('turn/end', event =>
      event.sessionId === sessionId && event.error !== undefined && event.error.includes('sent no activity'), since)
    // The watchdog frame cannot name a turn: no agent response exists to
    // attribute it to.
    expect(watchdog.turnId).toBe('')

    // The next message reclaims the process. Killing the child under the old
    // `session/prompt` rejects that request, and without the reclaim marker its
    // rejection would be broadcast as a SECOND turn/end for the abandoned turn.
    const resumeSince = stallEvents.length
    const second = await dispatchRpc(stallManager, 'session/prompt', { sessionId, text: 'hello after reclaim' })
    expect(second).toMatchObject({ ok: true, value: { accepted: true } })
    if (!second.ok) return
    const resumeTurnId = (second.value as { turnId: string }).turnId
    await stallWaitFor('turn/end', event =>
      event.sessionId === sessionId && event.turnId === resumeTurnId && event.stopReason === 'end_turn', resumeSince)

    // Let any late rejection from the dead child surface.
    await sleep(300)
    const endsForAbandoned = stallEvents.slice(since)
      .filter(event => event.type === 'turn/end' && event.sessionId === sessionId && event.turnId === abandonedTurnId)
    expect(endsForAbandoned).toHaveLength(0)
    const watchdogEnds = stallEvents.slice(since)
      .filter(event => event.type === 'turn/end' && event.sessionId === sessionId && event.error?.includes('sent no activity') === true)
    expect(watchdogEnds).toHaveLength(1)

    await dispatchRpc(stallManager, 'session/close', { sessionId })
  }, 20_000)

  it('/acp path: a stale chat controller does not blind the watchdog', async () => {
    // A card-final chat turn keeps its TurnStreamController indexed (its
    // continuation steps may still come). An `/acp` prompt on that SAME host
    // session then advances `turnSeq`, which makes the indexed controller
    // stale: its segment is already closed, so "on air" would read false and
    // the watchdog would skip this /acp turn forever.
    //
    // Only the FIRST driver step is drained on purpose: the host loop would
    // take the continuation step and retire the controller, which is exactly
    // the case where the stale record cannot exist.
    const warmup = await drain('hello warmup', 'dsh-stall-stale-controller')
    expect(finishOf(warmup)?.reason.kind).toBe('stop')
    const hostId = sessionViewOf(stallManager, 'dsh-stall-stale-controller')?.sessionId ?? ''
    expect(hostId).not.toBe('')
    // The stream above ends at its last card; the agent may not have answered
    // `session/prompt` yet. Wait for that settle — the controller stays
    // indexed (it has cards), which is what makes it stale below, but a
    // prompt sent while the turn still runs is refused `turn_in_flight`.
    await waitForTurnSettled(stallManager, 'dsh-stall-stale-controller')
    // The premise of this test: the previous turn's controller is still there.
    const seams = stallManager as unknown as { turnStreams: Map<string, unknown> }
    expect(seams.turnStreams.has('dsh-stall-stale-controller')).toBe(true)

    const since = stallEvents.length
    const prompt = await dispatchRpc(stallManager, 'session/prompt', { sessionId: hostId, text: 'HANG' })
    expect(prompt).toMatchObject({ ok: true, value: { accepted: true } })
    await stallWaitFor('turn/end', event =>
      event.sessionId === hostId && event.error !== undefined && event.error.includes('sent no activity'), since, 5_000)

    await dispatchRpc(stallManager, 'session/close', { sessionId: hostId })
  }, 20_000)

  it('/acp path: a no-load reset answers session_reset, not unknown_session', async () => {
    // A no-load reclaim drops the session record on purpose, and `/acp` has no
    // conversation to recreate it from. The caller must be told the session was
    // reset, not that the id it just used never existed.
    const start = await dispatchRpc(noLoadManager, 'session/start', { agentId: 'stall-noload' })
    if (!start.ok) throw new Error('start failed')
    const sessionId = (start.value as { sessionId: string }).sessionId

    const since = stallEvents.length
    const first = await dispatchRpc(noLoadManager, 'session/prompt', { sessionId, text: 'HANG' })
    expect(first).toMatchObject({ ok: true, value: { accepted: true } })
    await stallWaitFor('turn/end', event =>
      event.sessionId === sessionId && event.error !== undefined && event.error.includes('sent no activity'), since)
    // The watchdog finalizes the TURN only: the wedged child keeps running
    // until a message needs it back.
    expect(noLoadManager.agentViews().find(view => view.id === 'stall-noload')?.state).toBe('ready')

    const second = await dispatchRpc(noLoadManager, 'session/prompt', { sessionId, text: 'hello again' })
    expect(second).toMatchObject({ ok: false, error: { code: 'session_reset' } })
    if (!second.ok) expect(second.error.message).toContain('does not support session resume')
    // The reclaim is what tears the child down, without waiting for a graceful
    // `session/close` the wedged agent would never answer.
    expect(noLoadManager.agentViews().find(view => view.id === 'stall-noload')?.state).toBe('stopped')
  }, 20_000)

  it('chat path: a late real answer after the watchdog needs no reload', async () => {
    // The agent answers at 900ms; the window is 350ms. Our face of the turn is
    // force-finalized first, then the real answer lands on a session the host
    // already closed locally.
    await hostLoopTurn(stallAdapter, {
      provider: 'acp',
      model: 'stall',
      sessionId: 'dsh-stall-late',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hello warmup PIDTAG' }] }],
    })
    const hostId = sessionViewOf(stallManager, 'dsh-stall-late')?.sessionId ?? ''
    expect(hostId).not.toBe('')
    // The process serving this conversation. Only `PIDTAG` prompts carry it, so
    // every exact-echo assertion elsewhere in the suite stays byte-identical.
    const warm = await waitForTranscriptText(stallManager, 'dsh-stall-late', 'PID:')
    const pid = /PID:(\d+)/.exec(warm)?.[1] ?? ''
    expect(pid).not.toBe('')

    const since = stallEvents.length
    const delayed = await drain('HANG_DELAY:900 PIDTAG please', 'dsh-stall-late')
    expect(finishOf(delayed)?.reason).toMatchObject({ kind: 'error', failure: { code: 'INACTIVITY_TIMEOUT' } })
    const abandonedTurnId = (stallEvents.slice(since)
      .find(event => event.type === 'turn/start' && event.sessionId === hostId) as Extract<AcpEvent, { type: 'turn/start' }> | undefined)?.turnId ?? ''
    expect(abandonedTurnId).not.toBe('')

    // The late answer still writes into the transcript: the user sees it. Poll
    // for the echo instead of waiting on `running` — the watchdog already set
    // that to false, so a "turn settled" wait here is empty and the next prompt
    // would race the very `session/prompt` response the poll is waiting on. The
    // mock writes the echo (and its usage frame) AHEAD of that response on the
    // same stream, so seeing the echo means the response is at most a frame
    // behind; a fixed sleep here lost that race on a loaded box.
    const lateEcho = `MOCK: echo HANG_DELAY:900 PIDTAG please perm=none PID:${pid}`
    const late = await waitForTranscriptText(stallManager, 'dsh-stall-late', lateEcho)
    expect(late).toContain(lateEcho)

    // That answer cleared the orphan: the next message is served on the SAME
    // session/process. A reclaim would have replayed the history marker and
    // echoed from a NEW pid.
    await hostLoopTurn(stallAdapter, {
      provider: 'acp',
      model: 'stall',
      sessionId: 'dsh-stall-late',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hello after late PIDTAG' }] }],
    })
    const views = stallManager.chatTranscripts('dsh-stall-late')
    expect(views).toHaveLength(1)
    expect(views[0]?.session.sessionId).toBe(hostId)
    await settleTranscript(stallManager, hostId)
    const text = transcriptText('dsh-stall-late')
    expect(text).toContain(`MOCK: echo hello after late PIDTAG perm=none PID:${pid}`)
    expect(text).not.toContain('REPLAYED: earlier conversation')
    // Every answer in this conversation came from the warmed process: a respawn
    // would introduce a second pid even if it replayed the history.
    const pids = [...text.matchAll(/PID:(\d+)/g)].map(match => match[1])
    expect(new Set(pids)).toEqual(new Set([pid]))

    // The abandoned turn ended exactly once (the watchdog's frame): the late
    // answer did not settle it a second time.
    const oldTurnEnds = stallEvents.slice(since)
      .filter(event => event.type === 'turn/end' && event.turnId === abandonedTurnId)
    expect(oldTurnEnds).toHaveLength(1)
    expect(oldTurnEnds[0]).toMatchObject({ error: expect.stringContaining('sent no activity') })
  }, 20_000)

  it('closes a stalled driver stream through its chat turn controller', async () => {
    // Adapter turns without a DSH session id are refused before they start
    // (the host-internal auxiliary-call guard), so the driver stream the
    // watchdog must close always belongs to a chat-identified turn. Warm the
    // conversation FIRST: a provisional first turn that delivers nothing rolls
    // back instead, and that path is pinned by its own test above. Here the
    // controller is found by its chat id, and its segment queue must CLOSE —
    // finalizing the session state alone would leave this stream hanging.
    const sessionId = 'dsh-stall-driver'
    await hostLoopTurn(stallAdapter, {
      provider: 'acp',
      model: 'stall',
      sessionId,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hello warmup' }] }],
    })
    const since = stallEvents.length
    const chunks: StreamChunk[] = []
    const drained = (async () => {
      for await (const chunk of stallAdapter.stream({
        provider: 'acp',
        model: 'stall',
        sessionId,
        messages: [{ role: 'user', content: [{ type: 'text', text: 'HANG driver' }] }],
      })) chunks.push(chunk)
    })()
    // Bounded so a regression FAILS the suite instead of hanging it.
    const settled = await Promise.race([
      drained.then(() => true),
      sleep(10_000).then(() => false),
    ])
    expect(settled).toBe(true)
    expect(finishOf(chunks)?.reason).toMatchObject({ kind: 'error', failure: { code: 'INACTIVITY_TIMEOUT' } })
    expect(stallMessage(chunks)).toContain('sent no activity')

    // The chat id is the turn's identity: the watchdog's frame and its notice
    // both name the ACP session, and the turn ends exactly once.
    const started = stallEvents.slice(since).find((event): event is Extract<AcpEvent, { type: 'turn/start' }> =>
      event.type === 'turn/start' && event.text === 'HANG driver')
    if (started === undefined) throw new Error('no turn/start for the stalled turn')
    expect(stallManager.chatTranscripts(sessionId)[0]?.session.sessionId).toBe(started.sessionId)
    const ends = stallEvents.slice(since)
      .filter(event => event.type === 'turn/end' && event.sessionId === started.sessionId)
    expect(ends).toHaveLength(1)
    const notices = stallEvents.slice(since)
      .filter(event => event.type === 'agent/notice' && event.agentId === 'stall' && event.text.includes('sent no activity'))
    expect(notices).toHaveLength(1)
    // The conversation already carried context (the warmup turn), so there is
    // nothing to roll back: the notice promises the ordinary resume.
    if (notices[0]?.type === 'agent/notice') {
      expect(notices[0].text).toContain('restart the agent and resume the session')
    }

    // Retire the session: this manager is shared, and a leftover live session
    // would pin the agent process for later reclaim tests.
    await expect(dispatchRpc(stallManager, 'session/close', { sessionId: started.sessionId }))
      .resolves.toMatchObject({ ok: true })
  }, 20_000)
})
