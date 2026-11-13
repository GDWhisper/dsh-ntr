import { tmpdir } from 'node:os'
import { mkdirSync } from 'node:fs'
import { afterAll, describe, expect, it } from 'vitest'
import { AcpLlmAdapter, BridgeManager } from '../../src/bridge.ts'
import { type AcpEvent, type StreamChunk } from '../../src/protocol.ts'
import { dispatchRpc, EventHub, Transcript } from '../../src/impl.ts'
import type { LiveSession } from '../../src/bridge/live-session.ts'
import {
  AMBIENT_NOTICE_MAX,
  CONSUMED_DRAIN_MAX,
  RETIRED_AMBIENT_MAX,
  activeDrain,
  createDrainLedger,
  isConsumedDrain,
  isRetiredDrain,
  markNotice,
  retireDrain,
  reviveDrain,
  startDrain,
  stopDrain,
} from '../../src/bridge/drain-record.ts'
import { persistedChatSession, snapshot } from '../../src/bridge/shape.ts'
import { clearAmbientState } from '../../src/bridge/turn-stream.ts'
import { def, hostLoopTurn, settleTranscript } from './harness.ts'

/**
 * A prompt the agent folds into a background drain it is already running
 * (CodeBuddy 2.179.0 multitask): `session/prompt` answers `end_turn` in
 * milliseconds with no `codebuddy.ai/conversationRequestId`, and the real
 * answer streams afterwards under the drain's request id. Closing the turn on
 * that response cut every such answer — these cases pin the wait, its tools,
 * its wording, and the tail a response races past.
 */
describe('a prompt steered into a background drain (isolated manager)', () => {
  const drainWorkspace = `${tmpdir()}/dsh-ntr-drain-workspace`
  mkdirSync(drainWorkspace, { recursive: true })
  const drainHub = new EventHub()
  const drainEvents: AcpEvent[] = []
  drainHub.subscribe(event => { drainEvents.push(event) })
  const drainManager = new BridgeManager(
    [{ ...def, id: 'drain', cwd: drainWorkspace, allowedCwdRoots: [drainWorkspace] }],
    drainHub,
    500,
    undefined,
    undefined,
    true,
    // Tiny windows keep these cases fast. The quiet window must still exceed
    // the GAP drain's 150ms tick spacing (proving ticks hold the turn open),
    // while the cancel fallback must fire BEFORE the drain goes quiet so the
    // fallback test proves the fallback — not silence — closed the turn.
    { startupTimeoutMs: 3_000, cancelFallbackMs: 100, ambientQuietMs: 250 },
  )
  const drainAdapter = new AcpLlmAdapter(drainManager)

  afterAll(async () => {
    await drainManager.shutdownAll()
  })

  /** Drive one chat turn to completion, collecting every chunk of every step. */
  async function drainTurn(dshSessionId: string, text: string): Promise<StreamChunk[]> {
    const chunks: StreamChunk[] = []
    for await (const chunk of drainAdapter.stream({
      provider: 'acp',
      model: 'drain',
      sessionId: dshSessionId,
      messages: [
        { role: 'user', content: [{ type: 'text', text }] },
      ],
    })) {
      chunks.push(chunk)
    }
    return chunks
  }

  function textOf(chunks: StreamChunk[]): string {
    return chunks
      .filter((c): c is Extract<StreamChunk, { type: 'text-delta' }> => c.type === 'text-delta')
      .map(c => c.text)
      .join('')
  }

  function finishOf(chunks: StreamChunk[]): Extract<StreamChunk, { type: 'finish' }> | undefined {
    return chunks.find((c): c is Extract<StreamChunk, { type: 'finish' }> => c.type === 'finish')
  }

  /**
   * Wait until a chat turn has entered its ambient wait: the prompt response
   * already landed (the settle gate is open) while the drained segment is
   * still on air. The state has no event of its own, so this polls the
   * manager's controller index.
   */
  async function waitForAmbient(dshSessionId: string): Promise<NonNullable<ReturnType<BridgeManager['turnStreamFor']>>> {
    const deadline = Date.now() + 10_000
    for (;;) {
      const live = drainManager.turnStreamFor(dshSessionId)
      if (live !== undefined && !live.hasSettled && live.hasOpenSegment && live.session.turnSlot === undefined) return live
      if (Date.now() > deadline) throw new Error('the turn never entered an ambient wait')
      await new Promise(resolve => setTimeout(resolve, 5))
    }
  }

  /** The ACP transcript's raw updates for one chat session, after quiescence. */
  async function drainTranscript(dshSessionId: string): Promise<Array<Record<string, unknown>>> {
    const acpSessionId = drainManager.chatSessions(dshSessionId)[0]?.sessionId
    if (acpSessionId === undefined) throw new Error('no live ACP session for the chat session')
    await settleTranscript(drainManager, acpSessionId)
    const transcript = await dispatchRpc(drainManager, 'transcript/get', { sessionId: acpSessionId })
    if (!transcript.ok) throw new Error('transcript failed')
    return (transcript.value as { entries: Array<{ update: Record<string, unknown> }> }).entries
      .map(entry => entry.update)
  }

  const AMBIENT_REPORT = 'deferred this turn to a background task run'
  const ZERO_OUTPUT_REPORT = 'ended the turn with no visible output'
  const RETIRED_FOLD_REPORT = 'may have been folded into a background run'

  it('keeps the turn open for the drain: its text arrives, its tools stay off the main plane', async () => {
    const dshSessionId = 'dsh-drain-steer'
    const since = drainEvents.length
    const chunks = await drainTurn(dshSessionId, 'STEER please')
    const text = textOf(chunks)

    // The drain's answer reached the user's turn instead of being cut at the
    // instant `end_turn` response (the 14ms codebuddy shape).
    expect(text).toContain('AMBIENT-TEXT')
    expect(text).toContain('TAIL-TEXT')
    expect(finishOf(chunks)?.reason).toEqual({ kind: 'stop' })
    // A deferred turn is not a silent-failure turn: neither report fired.
    expect(text).not.toContain(ZERO_OUTPUT_REPORT)
    expect(text).not.toContain(AMBIENT_REPORT)

    // A background tool never opens a card on the main plane...
    expect(chunks.filter(c => c.type === 'tool-call-delta')).toHaveLength(0)
    // ...but it is in the ACP transcript the NTR view reads.
    const acpSessionId = drainManager.chatSessions(dshSessionId)[0]?.sessionId
    expect(acpSessionId).toBeDefined()
    const transcript = await dispatchRpc(drainManager, 'transcript/get', { sessionId: acpSessionId! })
    if (!transcript.ok) throw new Error('transcript failed')
    const entries = (transcript.value as { entries: Array<{ update: Record<string, unknown> }> }).entries
    expect(entries.some(entry => entry.update.sessionUpdate === 'tool_call' && entry.update.toolCallId === 'amb_tool')).toBe(true)
    expect(entries.some(entry => entry.update.sessionUpdate === 'tool_call_update'
      && entry.update.toolCallId === 'amb_tool'
      && entry.update.status === 'completed')).toBe(true)

    // `turn/end` is the LAST thing the turn says: every drained text delta
    // precedes it, and it fires exactly once.
    const order = drainEvents
      .slice(since)
      .filter(event => event.sessionId === acpSessionId)
      .map(event => event.type === 'turn/end'
        ? 'end'
        : event.type === 'session/update' && event.update.sessionUpdate === 'agent_message_chunk'
          ? 'text'
          : 'other')
      .filter(mark => mark !== 'other')
    expect(order.filter(mark => mark === 'text').length).toBeGreaterThan(0)
    expect(order.at(-1)).toBe('end')
    expect(order.filter(mark => mark === 'end')).toHaveLength(1)

    // One notice per background run, not one per drain tick.
    const notices = drainEvents
      .slice(since)
      .filter(event => event.type === 'agent/notice' && event.text.startsWith('acp: agent "drain" started a background task turn'))
    expect(notices).toHaveLength(1)
  }, 30_000)

  it('closes a first-turn drain that only ran tools with a pointer, never rolling the lock back', async () => {
    const dshSessionId = 'dsh-drain-steer-tool'
    const since = drainEvents.length
    const chunks = await drainTurn(dshSessionId, 'STEERTOOL please')
    const text = textOf(chunks)

    expect(finishOf(chunks)?.reason).toEqual({ kind: 'stop' })
    expect(text.trim()).not.toBe('')
    // Deferred, not failed: the pointer says where the output went.
    expect(text).toContain(AMBIENT_REPORT)
    expect(text).not.toContain(ZERO_OUTPUT_REPORT)

    // This was the conversation's FIRST turn and it never showed a visible
    // block (the drain ran only suppressed tools). Deferring is not a failed
    // first turn: the lock and the live session stay, and no unlock is
    // broadcast — the drain's output still lands in the transcript.
    expect(drainManager.lockedAgentFor(dshSessionId)).toBe('drain')
    expect(drainManager.chatSessions(dshSessionId)).toHaveLength(1)
    expect(drainEvents.slice(since).some(event =>
      event.type === 'chat/agent-unlocked' && event.dshSessionId === dshSessionId)).toBe(false)
  }, 30_000)

  it('keeps the turn open across sub-quiet model-call gaps in a drain', async () => {
    const chunks = await drainTurn('dsh-drain-gap', 'GAP please')
    const text = textOf(chunks)

    // The drain ticks every 150ms for ~600ms before its text exists: longer
    // than the 250ms quiet window, but no single GAP is. The turn must still
    // be open when GAP-TEXT arrives instead of closing on the first silence.
    expect(text).toContain('GAP-TEXT')
    expect(text).not.toContain(AMBIENT_REPORT)
    expect(finishOf(chunks)?.reason).toEqual({ kind: 'stop' })
  }, 30_000)

  it('withholds drain text from a normal turn and keeps drain tools off the plane', async () => {
    const dshSessionId = 'dsh-drain-early'
    const chunks = await drainTurn(dshSessionId, 'EARLY please')
    const text = textOf(chunks)

    // DRAIN-EARLY arrived while the turn's own request id was unknown and the
    // response named a conversation turn: it was never this answer.
    expect(text).toContain('REAL-ANSWER')
    expect(text).toContain('REAL-TAIL')
    expect(text).not.toContain('DRAIN-EARLY')
    expect(text).not.toContain(AMBIENT_REPORT)
    // A drain-owned tool call during a normal turn is transcript-only: opening
    // a card would make the host execute it for the user's turn.
    expect(chunks.filter(c => c.type === 'tool-call-delta')).toHaveLength(0)

    const updates = await drainTranscript(dshSessionId)
    expect(updates.some(update => update.sessionUpdate === 'agent_message_chunk'
      && String((update.content as { text?: string }).text ?? '').includes('DRAIN-EARLY'))).toBe(true)
    expect(updates.some(update => update.sessionUpdate === 'tool_call'
      && update.toolCallId === 'drain_early_tool')).toBe(true)
  }, 30_000)

  it('flushes withheld drain text into a steered turn', async () => {
    const chunks = await drainTurn('dsh-drain-early-steer', 'EARLY-STEER please')
    const text = textOf(chunks)

    // Same early drain text, but the response carries NO conversation id: the
    // prompt was folded into the drain, so the withheld text is this answer.
    expect(text).toContain('DRAIN-EARLY')
    expect(text).toContain('AFTER-EARLY')
    expect(text).not.toContain(AMBIENT_REPORT)
    expect(chunks.filter(c => c.type === 'tool-call-delta')).toHaveLength(0)
    expect(finishOf(chunks)?.reason).toEqual({ kind: 'stop' })
  }, 30_000)

  it('reports a truncated withhold buffer instead of dropping the drain front silently', async () => {
    // FLOOD streams 220 indexed drain updates before the prompt response judges
    // the turn. The bounded withhold buffer can only carry 200: the flush must
    // say the front was dropped (the transcript still has every entry), never
    // let the answer start mid-story without a word.
    const chunks = await drainTurn('dsh-drain-flood', 'FLOOD please')
    const text = textOf(chunks)

    const marker = 'background output was truncated'
    expect(text).toContain(marker)
    // The buffer evicted the FRONT, not the tail: the marker precedes the
    // retained content, and the first kept update is the one just past the
    // 200-entry bound.
    expect(text).toContain('FLOOD-020')
    expect(text).toContain('FLOOD-219')
    expect(text).not.toContain('FLOOD-000')
    expect(text).not.toContain('FLOOD-019')
    expect(text.indexOf(marker)).toBeLessThan(text.indexOf('FLOOD-020'))
    expect(finishOf(chunks)?.reason).toEqual({ kind: 'stop' })
  }, 30_000)

  it('drains the tail the prompt response raced past before judging the turn empty', async () => {
    const chunks = await drainTurn('dsh-drain-tail', 'TAIL please')
    const text = textOf(chunks)

    // The mock writes the chunks and answers without waiting for their
    // dispatch: a settle that judges visibility before one macrotask loses them.
    expect(text).toContain('TAIL-CHUNK')
    expect(text).not.toContain(ZERO_OUTPUT_REPORT)
    expect(finishOf(chunks)?.reason).toEqual({ kind: 'stop' })
  }, 30_000)

  it('still reports a normal stop with nothing to show, in the original wording', async () => {
    const chunks = await drainTurn('dsh-drain-empty', 'EMPTY please')
    const text = textOf(chunks)

    expect(text).toContain(ZERO_OUTPUT_REPORT)
    expect(text).toContain('(stop reason: end_turn)')
    // A turn nobody steered must not borrow the deferred wording.
    expect(text).not.toContain(AMBIENT_REPORT)
    expect(finishOf(chunks)?.reason).toEqual({ kind: 'stop' })
  }, 30_000)

  it('does not treat a later normal turn as steered after an ambient wait closed', async () => {
    const dshSessionId = 'dsh-drain-ambient-cleared'
    const first = await drainTurn(dshSessionId, 'STEER please')
    expect(textOf(first)).toContain('AMBIENT-TEXT')

    // The drain is over and its wait closed. The NEXT prompt is a normal turn
    // that names its conversation request id, so even with the drain's id
    // still retired it must close on its own terms — not be held open, not be
    // called a possible fold, and not borrow the deferred wording.
    const second = await drainTurn(dshSessionId, 'CONVIDLE please')
    const text = textOf(second)
    expect(text).toContain(ZERO_OUTPUT_REPORT)
    expect(text).not.toContain(AMBIENT_REPORT)
    expect(text).not.toContain(RETIRED_FOLD_REPORT)
    expect(finishOf(second)?.reason).toEqual({ kind: 'stop' })
  }, 30_000)

  it('revives a quiet-closed drain when it re-announces, so the steered text reaches the turn', async () => {
    const dshSessionId = 'dsh-drain-reannounce'
    // Turn 1 retires the drain's id: its wait closes on silence.
    const first = await drainTurn(dshSessionId, 'QUIETDRAIN please')
    expect(textOf(first)).toContain(AMBIENT_REPORT)

    // The same run re-announces itself in turn 2 and the response names no
    // conversation turn. The retired mark must not outlive the re-announcement:
    // the drain's text IS this (steered) turn's answer, not transcript-only.
    const second = await drainTurn(dshSessionId, 'DRAINAGAIN please')
    const text = textOf(second)
    expect(text).toContain('REANNOUNCED-TEXT')
    expect(text).not.toContain(AMBIENT_REPORT)
    expect(text).not.toContain(RETIRED_FOLD_REPORT)
    expect(finishOf(second)?.reason).toEqual({ kind: 'stop' })
  }, 30_000)

  it('revives a quiet-closed drain from its late update alone, so a steered prompt receives the text', async () => {
    const dshSessionId = 'dsh-drain-revive-steered'
    const first = await drainTurn(dshSessionId, 'QUIETDRAIN please')
    expect(textOf(first)).toContain(AMBIENT_REPORT)

    // The revived drain speaks BEFORE the prompt response is judged and never
    // re-announces itself. The update alone must un-retire the id and rebuild
    // the ambient record; the fold into it is then detected as steered and its
    // text (before and after the response) reaches the user.
    const second = await drainTurn(dshSessionId, 'DRAINFIRST please')
    const text = textOf(second)
    expect(text).toContain('DRAIN-FIRST-TEXT')
    expect(text).toContain('DRAIN-FIRST-TAIL')
    expect(text).not.toContain(AMBIENT_REPORT)
    expect(text).not.toContain(RETIRED_FOLD_REPORT)
    expect(finishOf(second)?.reason).toEqual({ kind: 'stop' })
  }, 30_000)

  it('reports a possible fold, not agent silence, when a recently retired drain may have taken the prompt', async () => {
    const dshSessionId = 'dsh-drain-retired-fold'
    const first = await drainTurn(dshSessionId, 'QUIETDRAIN please')
    expect(textOf(first)).toContain(AMBIENT_REPORT)

    // No drain update and no re-announcement: the prompt answers instantly with
    // no conversation request id. The drain may still be running, so the empty
    // bubble must say the turn may have been folded into it (output is in the
    // transcript) instead of blaming the agent and suggesting a resend. The
    // turn is NOT held open — the report is immediate.
    const started = Date.now()
    const second = await drainTurn(dshSessionId, 'EMPTY please')
    const text = textOf(second)
    expect(text).toContain(RETIRED_FOLD_REPORT)
    expect(text).not.toContain('try resending')
    expect(text).not.toContain('check the agent process logs')
    expect(text).not.toContain(ZERO_OUTPUT_REPORT)
    expect(Date.now() - started).toBeLessThan(5_000)
    expect(finishOf(second)?.reason).toEqual({ kind: 'stop' })
  }, 30_000)

  it('keeps a revived drain\'s late text out of the next turn that arrives first', async () => {
    const dshSessionId = 'dsh-drain-revive-first'
    // Turn 1: the drain announces itself and then stays silent, so the ambient
    // quiet window closes the turn and drops the drain record — its id is
    // RETIRED, not forgotten: the run itself is still alive.
    const first = await drainTurn(dshSessionId, 'QUIETDRAIN please')
    expect(textOf(first)).toContain(AMBIENT_REPORT)

    // Turn 2 is an ordinary turn (its response names a conversation id). The
    // revived drain speaks BEFORE this turn's own text: without the retired
    // id, `noteTurnRequestId` would adopt the drain's id and the background
    // text would be folded into the user's answer (a double answer).
    const second = await drainTurn(dshSessionId, 'REVIVE please')
    const text = textOf(second)
    expect(text).toContain('REVIVE-NORMAL-TEXT')
    expect(text).not.toContain('REVIVED-DRAIN-TEXT')
    // The revived run's tool call is a background tool: transcript-only, no
    // card for the host to execute as part of this turn.
    expect(second.filter(chunk => chunk.type === 'tool-call-delta')).toHaveLength(0)
    expect(finishOf(second)?.reason).toEqual({ kind: 'stop' })

    // Nothing was lost: the late drain prose is in the ACP transcript view.
    const updates = await drainTranscript(dshSessionId)
    expect(updates.some(update => update.sessionUpdate === 'agent_message_chunk'
      && String((update.content as { text?: string }).text ?? '').includes('REVIVED-DRAIN-TEXT'))).toBe(true)
    expect(updates.some(update => update.sessionUpdate === 'tool_call'
      && update.toolCallId === 'amb_quiet_tool')).toBe(true)
  }, 30_000)

  it('keeps a revived drain\'s late text out when it lands after the normal answer', async () => {
    const dshSessionId = 'dsh-drain-revive-late'
    const first = await drainTurn(dshSessionId, 'QUIETDRAIN please')
    expect(textOf(first)).toContain(AMBIENT_REPORT)

    // The stray-tail shape: this turn's own text (and its request id) came
    // first, then the revived drain's text. The ambient record is gone, so
    // only the retired id can tell this text apart from the answer.
    const second = await drainTurn(dshSessionId, 'REVIVE-LATE please')
    const text = textOf(second)
    expect(text).toContain('REVIVE-NORMAL-TEXT')
    expect(text).not.toContain('REVIVED-DRAIN-TEXT')
    expect(second.filter(chunk => chunk.type === 'tool-call-delta')).toHaveLength(0)
    expect(finishOf(second)?.reason).toEqual({ kind: 'stop' })

    const updates = await drainTranscript(dshSessionId)
    expect(updates.some(update => update.sessionUpdate === 'agent_message_chunk'
      && String((update.content as { text?: string }).text ?? '').includes('REVIVED-DRAIN-TEXT'))).toBe(true)
  }, 30_000)

  it('retires a waiting turn when the conversation moves on, ending its driver step without touching the session', async () => {
    const dshSessionId = 'dsh-drain-supersede'
    const since = drainEvents.length
    const chunks: StreamChunk[] = []
    const drained = (async () => {
      for await (const chunk of drainAdapter.stream({
        provider: 'acp',
        model: 'drain',
        sessionId: dshSessionId,
        messages: [{ role: 'user', content: [{ type: 'text', text: 'STEER please' }] }],
      })) {
        chunks.push(chunk)
      }
    })()

    // Entered the ambient wait: the response already released the prompt slot
    // (`endTurn` cleared `session.turnSlot`) while the segment is still open and
    // the turn is NOT settled.
    const deadline = Date.now() + 10_000
    let live = drainManager.turnStreamFor(dshSessionId)
    for (;;) {
      if (live !== undefined && live.hasOpenSegment && live.session.turnSlot === undefined) break
      if (Date.now() > deadline) throw new Error('the turn never entered an ambient wait')
      await new Promise(resolve => setTimeout(resolve, 5))
      live = drainManager.turnStreamFor(dshSessionId)
    }
    if (live === undefined) throw new Error('no controller')
    const turnId = live.turnId
    const acpSessionId = live.session.sessionId
    expect(live.hasSettled).toBe(false)

    // The conversation's next turn replaces the controller before the drain
    // goes quiet: the old driver step must not stay parked on its queue.
    const replacement = {
      session: live.session,
      stale: false,
      hasOpenSegment: true,
      finishActive: () => {},
      dispose: () => {},
      settle: () => {},
    } as unknown as never
    try {
      drainManager.rememberTurnStream(dshSessionId, replacement)
      await Promise.race([
        drained,
        new Promise((_, reject) => setTimeout(() => reject(new Error('the retired step is still parked on its queue')), 5_000)),
      ])
      // The retired turn closed ITS OWN stream...
      expect(finishOf(chunks)?.reason).toMatchObject({ kind: 'aborted' })
      // ...and never touched the session the newer turn now owns: no turn/end,
      // and the session is still running for whoever is on air.
      expect(live.session.running).toBe(true)
      expect(drainEvents.slice(since).some(event =>
        event.type === 'turn/end' && event.sessionId === acpSessionId && event.turnId === turnId)).toBe(false)
    } finally {
      drainManager.forgetTurnStream(replacement)
    }
  }, 30_000)

  it('accepts the next prompt while the previous turn still waits on its drain', async () => {
    const dshSessionId = 'dsh-drain-reenter'
    const since = drainEvents.length
    const firstChunks: StreamChunk[] = []
    const first = (async () => {
      for await (const chunk of drainAdapter.stream({
        provider: 'acp',
        model: 'drain',
        sessionId: dshSessionId,
        messages: [{ role: 'user', content: [{ type: 'text', text: 'STEER please' }] }],
      })) {
        firstChunks.push(chunk)
      }
    })()

    const waiting = await waitForAmbient(dshSessionId)
    const session = waiting.session
    // The waiting turn still holds the session's `running` flag on purpose
    // (the drain is its work), and its first-turn lock is provisional.
    expect(session.running).toBe(true)
    expect(session.provisionalLock).toBe(true)

    // The user sends again while the drain is still talking: the claim is
    // gated on the HOST's prompt slot (already released with the response),
    // never on `running` — and a failed claim must not roll the first-turn
    // lock back while the drain is streaming.
    const second = await hostLoopTurn(drainAdapter, {
      provider: 'acp',
      model: 'drain',
      sessionId: dshSessionId,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'second please' }] }],
    })
    expect(finishOf(second.chunks)?.reason).toEqual({ kind: 'stop' })
    expect(textOf(second.chunks)).toContain('MOCK: echo second please')

    // The superseded waiting step ended when the new turn took the controller
    // (rememberTurnStream disposes it, which closes its queue).
    await Promise.race([
      first,
      new Promise((_, reject) => setTimeout(() => reject(new Error('the waiting step is still parked on its queue')), 5_000)),
    ])
    expect(finishOf(firstChunks)?.reason).toMatchObject({ kind: 'aborted' })

    // Nothing gave the conversation back: the session (and its ACP transcript)
    // survived, and the lock was never rolled back.
    expect(session.lifecycle).toBe('live')
    expect(drainManager.chatSessions(dshSessionId)).toHaveLength(1)
    expect(drainEvents.slice(since).some(event =>
      event.type === 'chat/agent-unlocked' && event.dshSessionId === dshSessionId)).toBe(false)
  }, 30_000)

  it('ends a waiting turn through its controller when the cancel fallback fires: one turn/end, promptly', async () => {
    const dshSessionId = 'dsh-drain-fallback'
    const since = drainEvents.length
    const chunks: StreamChunk[] = []
    const drained = (async () => {
      for await (const chunk of drainAdapter.stream({
        provider: 'acp',
        model: 'drain',
        sessionId: dshSessionId,
        messages: [{ role: 'user', content: [{ type: 'text', text: 'STEER please' }] }],
      })) {
        chunks.push(chunk)
      }
    })()

    const waiting = await waitForAmbient(dshSessionId)
    const sessionId = waiting.session.sessionId
    const turnId = waiting.turnId

    // Cancel WITHOUT the driver's own abort (the `/acp` cancel face): the
    // ambient step stays on air until the fallback force-finalizes it.
    await drainManager.cancel(sessionId)
    const started = Date.now()
    await Promise.race([
      drained,
      new Promise((_, reject) => setTimeout(() => reject(new Error('the ambient step never closed')), 5_000)),
    ])
    // Closed by the 300ms fallback, not by the ambient ceiling (120s).
    expect(Date.now() - started).toBeLessThan(5_000)

    // Exactly one frame, and it names the turn's REAL id (the controller's),
    // with the fallback's reason.
    const frames = drainEvents.slice(since).filter(event => event.type === 'turn/end' && event.sessionId === sessionId)
    expect(frames).toHaveLength(1)
    expect(frames[0]).toMatchObject({ turnId, error: expect.stringContaining('did not respond to the cancel request') })
    expect(finishOf(chunks)?.reason).toMatchObject({ kind: 'error' })
    expect(waiting.session.running).toBe(false)
  }, 30_000)

  it('emits exactly one turn/end when a settle error lands during the ambient wait', async () => {
    const dshSessionId = 'dsh-drain-watchdog'
    const since = drainEvents.length
    const chunks: StreamChunk[] = []
    const drained = (async () => {
      for await (const chunk of drainAdapter.stream({
        provider: 'acp',
        model: 'drain',
        sessionId: dshSessionId,
        messages: [{ role: 'user', content: [{ type: 'text', text: 'STEER please' }] }],
      })) {
        chunks.push(chunk)
      }
    })()

    const waiting = await waitForAmbient(dshSessionId)
    const sessionId = waiting.session.sessionId
    const turnId = waiting.turnId

    // What the stall watchdog does when it decides the agent went silent
    // while still holding the segment open.
    waiting.settle({ kind: 'error', message: 'watchdog: synthetic silence', code: 'INACTIVITY_TIMEOUT' })
    await Promise.race([
      drained,
      new Promise((_, reject) => setTimeout(() => reject(new Error('the settled step never closed')), 5_000)),
    ])

    const frames = () => drainEvents.slice(since).filter(event => event.type === 'turn/end' && event.sessionId === sessionId)
    expect(frames()).toHaveLength(1)
    expect(frames()[0]).toMatchObject({ turnId, error: 'watchdog: synthetic silence' })
    expect(finishOf(chunks)?.reason).toMatchObject({ kind: 'error', failure: { code: 'INACTIVITY_TIMEOUT' } })

    // Longer than the ambient quiet window: a surviving quiet timer would have
    // broadcast a second frame by now. (Bounded negative wait — there is no
    // event for "the timer did not fire".)
    await new Promise(resolve => setTimeout(resolve, 900))
    expect(frames()).toHaveLength(1)
  }, 30_000)

  it('never broadcasts a second turn/end when the session closes inside the settle macrotask', async () => {
    const dshSessionId = 'dsh-drain-close-race'
    const chunks: StreamChunk[] = []
    const drained = (async () => {
      for await (const chunk of drainAdapter.stream({
        provider: 'acp',
        model: 'drain',
        sessionId: dshSessionId,
        messages: [{ role: 'user', content: [{ type: 'text', text: 'STEER please' }] }],
      })) {
        chunks.push(chunk)
      }
    })()

    const waiting = await waitForAmbient(dshSessionId)
    const sessionId = waiting.session.sessionId
    const turnId = waiting.turnId
    const since = drainEvents.length

    // The response landed: its closing work (tail drain + turn/end) is queued
    // for the next macrotask. Closing the session in that window disposes the
    // controller; the queued close must be retired with it, or the teardown's
    // already-finished turn gets a SECOND turn/end carrying the real turn id.
    waiting.settle({ kind: 'stop', stopReason: 'end_turn' })
    await drainManager.closeSession(sessionId)
    await Promise.race([
      drained,
      new Promise((_, reject) => setTimeout(() => reject(new Error('the step never closed')), 5_000)),
    ])

    const frames = drainEvents.slice(since).filter(event => event.type === 'turn/end' && event.sessionId === sessionId)
    expect(frames.filter(event => event.turnId === turnId)).toHaveLength(0)
    expect(finishOf(chunks)?.reason).toMatchObject({ kind: 'aborted' })
  }, 30_000)

  it('never folds a successor turn\'s tail into a superseded waiting turn', async () => {
    const dshSessionId = 'dsh-drain-stale-tail'
    const since = drainEvents.length
    const chunks: StreamChunk[] = []
    const drained = (async () => {
      for await (const chunk of drainAdapter.stream({
        provider: 'acp',
        model: 'drain',
        sessionId: dshSessionId,
        messages: [{ role: 'user', content: [{ type: 'text', text: 'STEER please' }] }],
      })) {
        chunks.push(chunk)
      }
    })()

    const waiting = await waitForAmbient(dshSessionId)
    const session = waiting.session

    // The turn settles, so its closing work (the deferred tail read) is queued
    // for the next macrotask...
    waiting.settle({ kind: 'cancelled' })
    // ...and in that window the conversation's NEXT turn begins: `turnSeq`
    // moves on, and an update that belongs to the new turn lands in the
    // transcript without this (superseded) segment having folded it.
    session.turnSeq += 1
    session.transcript.append({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'SUCCESSOR-TEXT' },
    })
    // A continuation step opening here runs the deferred close NOW.
    waiting.startSegment()

    await Promise.race([
      drained,
      new Promise((_, reject) => setTimeout(() => reject(new Error('the superseded step never closed')), 5_000)),
    ])
    // The stale tail read folded nothing into the old step: that text belongs
    // to the successor turn, not to this stream.
    expect(textOf(chunks)).not.toContain('SUCCESSOR-TEXT')
    expect(finishOf(chunks)?.reason).toMatchObject({ kind: 'aborted' })
    // A superseded close never touches the session the newer turn owns.
    expect(session.running).toBe(true)
    expect(drainEvents.slice(since).some(event =>
      event.type === 'turn/end' && event.sessionId === session.sessionId)).toBe(false)
  }, 30_000)

  it('keeps a turn controller\'s folded drain ids when the session drain ledger is cleared', async () => {
    const dshSessionId = 'dsh-drain-folded-isolation'
    const drained = drainTurn(dshSessionId, 'STEER please')
    const controller = await waitForAmbient(dshSessionId)
    // `foldedDrainIds` is per TURN (one id per run whose visible answer this
    // turn folded); the session ledger is per SESSION. Clearing the session
    // side must not wipe the controller's evidence, or its quiet close would
    // stop consuming a run it already delivered.
    const folded = (controller as unknown as { foldedDrainIds: Set<string> }).foldedDrainIds
    const deadline = Date.now() + 10_000
    while (folded.size === 0 && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 5))
    }
    expect(folded.size).toBeGreaterThan(0)
    const before = [...folded]
    clearAmbientState(controller.session)
    expect([...folded]).toEqual(before)
    await drained
  }, 30_000)
})

/**
 * The ambient ceiling is a DIFFERENT ending from a quiet drain: it announces
 * that the rest of the output will land elsewhere. That notice must stand
 * alone — the quiet ending's deferred report would only repeat it, and a
 * no-text drain would otherwise receive both.
 */
describe('the ambient hard ceiling (isolated manager)', () => {
  const hardWorkspace = `${tmpdir()}/dsh-ntr-drain-hard-workspace`
  mkdirSync(hardWorkspace, { recursive: true })
  const hardHub = new EventHub()
  const hardEvents: AcpEvent[] = []
  hardHub.subscribe(event => { hardEvents.push(event) })
  const hardManager = new BridgeManager(
    [{ ...def, id: 'drainhard', cwd: hardWorkspace, allowedCwdRoots: [hardWorkspace] }],
    hardHub,
    500,
    undefined,
    undefined,
    false,
    {
      startupTimeoutMs: 3_000,
      cancelFallbackMs: 300,
      // The ceiling beats the quiet window: this case is about what the hard
      // close SAYS, not about which timer normally closes a drain.
      ambientQuietMs: 60_000,
      ambientMaxMs: 150,
    },
  )
  const hardAdapter = new AcpLlmAdapter(hardManager)

  afterAll(async () => {
    await hardManager.shutdownAll()
  })

  async function hardTurn(dshSessionId: string, text: string): Promise<StreamChunk[]> {
    const chunks: StreamChunk[] = []
    for await (const chunk of hardAdapter.stream({
      provider: 'acp',
      model: 'drainhard',
      sessionId: dshSessionId,
      messages: [{ role: 'user', content: [{ type: 'text', text }] }],
    })) {
      chunks.push(chunk)
    }
    return chunks
  }

  function hardTextOf(chunks: StreamChunk[]): string {
    return chunks
      .filter((chunk): chunk is Extract<StreamChunk, { type: 'text-delta' }> => chunk.type === 'text-delta')
      .map(chunk => chunk.text)
      .join('')
  }

  it('closes with the hard notice only, never stacking the deferred line', async () => {
    const chunks: StreamChunk[] = []
    for await (const chunk of hardAdapter.stream({
      provider: 'acp',
      model: 'drainhard',
      sessionId: 'dsh-drain-hard',
      // Tool-only drain: no answer text, so the quiet ending's deferred line
      // WOULD fire — the case that used to stack it under the hard notice.
      messages: [{ role: 'user', content: [{ type: 'text', text: 'STEERTOOL please' }] }],
    })) {
      chunks.push(chunk)
    }
    const text = hardTextOf(chunks)

    expect(text.match(/is still running a background task/g)).toHaveLength(1)
    expect(text).not.toContain('deferred this turn to a background task run')
    expect(chunks.find((chunk): chunk is Extract<StreamChunk, { type: 'finish' }> => chunk.type === 'finish')?.reason)
      .toEqual({ kind: 'stop' })
  }, 30_000)

  it('keeps the drain record after a hard close so the next folded prompt still gets the drain text', async () => {
    const dshSessionId = 'dsh-drain-hard-retained'
    const since = hardEvents.length

    // Turn 1: a drain announces itself, the prompt is answered instantly and
    // the drain then says NOTHING before the ceiling. The hard ending is
    // evidence the drain is still running, so the session must keep its
    // record — closing it here used to make the next folded prompt look like
    // an ordinary silent turn.
    const first = await hardTurn(dshSessionId, 'STEERHARD please')
    expect(hardTextOf(first)).toContain('is still running a background task')

    // Turn 2 is folded into the SAME drain: instant answer with no
    // conversation id, and its text lands 60ms later (after the response
    // would have closed the turn, before the next ceiling). With the record
    // kept, the turn is treated as steered and the text reaches the user.
    const second = await hardTurn(dshSessionId, 'HARDTAIL please')
    const text = hardTextOf(second)
    expect(text).toContain('HARD-TAIL-TEXT')
    expect(text).not.toContain('ended the turn with no visible output')
    expect(second.find((chunk): chunk is Extract<StreamChunk, { type: 'finish' }> => chunk.type === 'finish')?.reason)
      .toEqual({ kind: 'stop' })

    // One run, one notice: the de-dupe set survives the hard close, so the
    // re-announcement during turn 2 does not log the same drain twice.
    const notices = hardEvents
      .slice(since)
      .filter(event => event.type === 'agent/notice' && event.text.startsWith('acp: agent "drainhard" started a background task turn'))
    expect(notices).toHaveLength(1)
  }, 30_000)
})

/**
 * The session-level drain ledger keeps the old containers' capacity and
 * eviction order in three bounded id rings, and stays out of every outward
 * shape. These cases pin those bookkeeping rules directly.
 */
describe('the drain ledger rings and guards (unit)', () => {
  /**
   * A plain-object probe for a leaked ledger: `JSON.stringify` renders a Map as
   * `{}`, so string matching can never catch one. Report any Map value or any
   * drain-named key at any depth.
   */
  function drainLeaks(value: unknown, path = ''): string[] {
    if (value instanceof Map) return [path === '' ? '<map>' : path]
    if (Array.isArray(value)) return value.flatMap((entry, index) => drainLeaks(entry, `${path}[${String(index)}]`))
    if (typeof value !== 'object' || value === null) return []
    return Object.entries(value).flatMap(([key, entry]) =>
      key.toLowerCase().includes('drain') ? [`${path}.${key}`] : drainLeaks(entry, `${path}.${key}`))
  }

  it('evicts the oldest retired drain id past the 32-entry ring and drops its record', () => {
    let ledger = createDrainLedger()
    for (let index = 0; index <= RETIRED_AMBIENT_MAX; index += 1) {
      ledger = retireDrain(ledger, `retired-${String(index)}`, 1_000 + index, false)
    }
    expect(ledger.retired).toHaveLength(RETIRED_AMBIENT_MAX)
    expect(ledger.retired[0]).toBe('retired-1')
    expect(ledger.retired.at(-1)).toBe(`retired-${String(RETIRED_AMBIENT_MAX)}`)
    // The evicted id is no longer retired and its record is unreachable — a
    // late frame for it can neither revive nor mute anything.
    expect(isRetiredDrain(ledger, 'retired-0')).toBe(false)
    expect(ledger.records.has('retired-0')).toBe(false)
    expect(isRetiredDrain(ledger, `retired-${String(RETIRED_AMBIENT_MAX)}`)).toBe(true)
  })

  it('keeps a revived drain consumed and evicts the oldest consumed id past its ring', () => {
    let ledger = createDrainLedger()
    ledger = startDrain(ledger, 'run-revived', 1, 1, true)
    ledger = retireDrain(ledger, 'run-revived', 2, true)
    stopDrain(ledger, 'run-revived')
    reviveDrain(ledger, 'run-revived')
    // Revival clears the retirement but never the delivery evidence; the run
    // re-enters the ambient slot and stays silent (the fourth state).
    expect(isRetiredDrain(ledger, 'run-revived')).toBe(false)
    expect(isConsumedDrain(ledger, 'run-revived')).toBe(true)
    ledger = startDrain(ledger, 'run-revived', 3, 3, false)
    expect(activeDrain(ledger)?.requestId).toBe('run-revived')
    expect(isConsumedDrain(ledger, 'run-revived')).toBe(true)
    for (let index = 0; index < CONSUMED_DRAIN_MAX; index += 1) {
      ledger = retireDrain(ledger, `consumed-${String(index)}`, 10 + index, true)
    }
    expect(ledger.consumed).toHaveLength(CONSUMED_DRAIN_MAX)
    expect(ledger.consumed).not.toContain('run-revived')
    expect(isConsumedDrain(ledger, 'run-revived')).toBe(false)
    expect(isConsumedDrain(ledger, `consumed-${String(CONSUMED_DRAIN_MAX - 1)}`)).toBe(true)
  })

  it('keeps drain bookkeeping out of the session view and the persisted row', () => {
    const session: LiveSession = {
      sessionId: 'drain-guard',
      agentId: 'drain',
      acpSessionId: 'acp-drain-guard',
      cwd: '/tmp/drain-guard',
      dshSessionId: 'dsh-drain-guard',
      running: false,
      turnSeq: 0,
      lifecycle: 'live',
      lastAgentActivityAt: 1,
      activeToolCalls: new Set<string>(),
      transcript: new Transcript(1_000),
      drains: startDrain(createDrainLedger(), 'guarded-run', 1, 1, true),
    }
    // The ledger is populated, so a clean view/row is meaningful.
    expect(activeDrain(session.drains)?.requestId).toBe('guarded-run')
    const view = snapshot(session)
    expect(Object.hasOwn(view, 'drains')).toBe(false)
    expect(drainLeaks(view)).toEqual([])
    const row = persistedChatSession(session)
    expect(Object.hasOwn(row, 'drains')).toBe(false)
    expect(drainLeaks(row)).toEqual([])
  })

  it('evicts the oldest noticed drain id past its ring without dropping the active record', () => {
    let ledger = startDrain(createDrainLedger(), 'active-run', 1, 1, false)
    ledger = markNotice(ledger, 'active-run', 2)
    for (let index = 0; index < AMBIENT_NOTICE_MAX; index += 1) {
      ledger = markNotice(ledger, `noticed-${String(index)}`, 3 + index)
    }
    expect(ledger.notices).toHaveLength(AMBIENT_NOTICE_MAX)
    expect(ledger.notices).not.toContain('active-run')
    expect(ledger.notices.at(-1)).toBe(`noticed-${String(AMBIENT_NOTICE_MAX - 1)}`)
    expect(ledger.records.get('active-run')?.noticeSent).toBe(false)
    // Ring eviction must not prune the live record: it still owns the ambient
    // slot, and a re-announcement of it must be able to log a notice again.
    expect(ledger.records.has('active-run')).toBe(true)
    expect(activeDrain(ledger)?.requestId).toBe('active-run')
  })
})
