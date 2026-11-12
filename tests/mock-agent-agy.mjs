/**
 * Antigravity transcript shape for the scripted mock agent (the "AGY-LATE"
 * seam). Split out of mock-agent.mjs so that file stays inside the line
 * ratchet; the host keeps one call and this module owns the wire shape.
 *
 * MOCK_AGY_STORE=<dir>: the Antigravity transcript shape (see
 * docs/plan/antigravity-late-output.md). An "AGY_LATE" prompt answers normally;
 * `agyLateAnswer` then schedules one second after the TURN RESPONSE a
 * `PLANNER_RESPONSE` append to
 * `<dir>/brain/<sessionId>/.system_generated/logs/transcript_full.jsonl`, with
 * NO `session/update` — exactly how agy reports work finished after `end_turn`.
 * "AGY_REPLAY" makes the next prompt replay that text before its own answer
 * (agy flushes the backlog when a prompt arrives); the `AGY_REPLAY_PARTIAL`
 * variant sends only the first half and ends the turn.
 *
 * "AGY_DISPATCH" prompts script the `invoke_subagent` wire shape (task 1 of
 * docs/plan/antigravity-subagent-panel.md): an ordinary tool call titled
 * "Run invoke_subagent" whose COMPLETED result only says the child was
 * CREATED — no CodeBuddy `_meta` anywhere, and no completion frame ever.
 * Variants: AGY_DISPATCHLATE (result lands after the turn response),
 * AGY_DISPATCHSLOW (result after 1.2s, so a test can cancel first),
 * AGY_DISPATCHNORESULT (no result at all), AGY_DISPATCHTWO (two dispatches),
 * AGY_DISPATCHBARE (rawInput without Role / TypeName).
 * MOCK_AGY_LOAD_REPLAY=1: `session/load` replays the dispatch + result frames
 * (agy's real replay shape is unmeasured; the plugin must skip the whole
 * load window fail-open).
 */
import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const AGY_STORE = process.env.MOCK_AGY_STORE
/** The completed tool call an agy turn announces and the next prompt replays. */
const AGY_CALL_ID = 'call_agy_1'
/** The dispatch call ids the AGY_DISPATCH scenarios open. */
const AGY_DISPATCH_ID = 'agy_dispatch_1'
const AGY_DISPATCH_ID_TWO = 'agy_dispatch_2'
const agyStepIndex = new Map()
const agyLateAnswers = new Map()
/** Answer text waiting for its turn's response (`agyLateAnswer`). */
const agyPendingLate = new Map()

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/** The dispatch `tool_call`: title + rawInput are the ONLY identity evidence. */
function agyDispatchCall(toolCallId, role) {
  return {
    sessionUpdate: 'tool_call',
    toolCallId,
    title: 'Run invoke_subagent',
    kind: 'other',
    status: 'pending',
    rawInput: role === undefined
      ? { Model: 'inherit', Prompt: 'migrate the license headers' }
      : { Model: 'inherit', Prompt: 'migrate the license headers', Role: role, TypeName: 'self' },
  }
}

/** The creation result: `completed` means CREATED, never "child finished". */
function agyDispatchResult(toolCallId, sessionId, suffix) {
  const childId = `agy-child-${sessionId}-${suffix}`
  const text = `Created the following subagent:\n${JSON.stringify({
    conversationId: childId,
    logAbsoluteUri: `file:///mock/brain/${childId}/.system_generated/logs/transcript.jsonl`,
    workspaceUris: [],
  })}`
  return {
    sessionUpdate: 'tool_call_update',
    toolCallId,
    status: 'completed',
    content: [{ type: 'content', content: { type: 'text', text } }],
  }
}

const agyDispatchAck = {
  sessionUpdate: 'agent_message_chunk',
  messageId: 'm-agy-dispatch',
  content: { type: 'text', text: 'AGY-DISPATCH-ACK' },
}

/**
 * agy's transcript file exists before its first late answer: the plugin's
 * watch only arms on an EXISTING file (a missing file would baseline 0/0 and
 * replay the whole history later). Created on the turn response that will
 * write it, so a session that never asks for a late answer never grows a
 * store.
 */
function ensureAgyTranscript(sessionId) {
  if (AGY_STORE === undefined) return
  try {
    const dir = join(AGY_STORE, 'brain', sessionId, '.system_generated', 'logs')
    mkdirSync(dir, { recursive: true })
    appendFileSync(join(dir, 'transcript_full.jsonl'), '')
  } catch {
    // Best effort: a transcript write never changes the agent's answer.
  }
}

/**
 * Run the Antigravity replay behaviour for one prompt, at the very start of
 * the turn (before its ordinary opening frames). Returns `false` when the
 * prompt is not an agy scenario, `true` to end the turn with `end_turn`, or
 * `'cancelled'` to answer a cancel the way the real agent does. An "AGY_LATE"
 * prompt only records its pending answer here; the write is anchored by
 * `agyLateAnswer`. `cancelWait` is the host's cancel-waiter factory.
 */
export async function agyPrompt(send, sessionId, text, cancelWait) {
  if (text.includes('AGY_DISPATCH')) {
    const role = text.includes('AGY_DISPATCHBARE') ? undefined : 'License Migrator'
    await send(agyDispatchCall(AGY_DISPATCH_ID, role))
    if (text.includes('AGY_DISPATCHTWO')) await send(agyDispatchCall(AGY_DISPATCH_ID_TWO, 'Header Auditor'))
    if (text.includes('AGY_DISPATCHNORESULT')) {
      await send(agyDispatchAck)
      return true
    }
    if (text.includes('AGY_DISPATCHLATE')) {
      // The creation result lands AFTER the turn response (real wire: ~5s
      // after the call). The session-level tracker must still move the record.
      setTimeout(() => {
        void Promise.resolve(send(agyDispatchResult(AGY_DISPATCH_ID, sessionId, '1'))).catch(() => {})
      }, 200)
      await send(agyDispatchAck)
      return true
    }
    if (text.includes('AGY_DISPATCHSLOW')) {
      // A slow creation result, so a test can cancel first. The cancel is
      // acknowledged the way the real agent does (stopReason cancelled).
      const wasCancelled = await Promise.race([
        sleep(1_200).then(() => false),
        cancelWait(sessionId).then(() => true),
      ])
      if (wasCancelled) {
        // The child exists already: its creation result still lands late,
        // after the cancel — a terminal row must not be revived by it.
        setTimeout(() => {
          void Promise.resolve(send(agyDispatchResult(AGY_DISPATCH_ID, sessionId, '1'))).catch(() => {})
        }, 300)
        return 'cancelled'
      }
    } else {
      await sleep(120)
    }
    await send(agyDispatchResult(AGY_DISPATCH_ID, sessionId, '1'))
    if (text.includes('AGY_DISPATCHTWO')) await send(agyDispatchResult(AGY_DISPATCH_ID_TWO, sessionId, '2'))
    await send(agyDispatchAck)
    return true
  }
  // agy flushes the previous turn's late answer at the START of the next
  // prompt: replay it here, without any marker of its own (just text), so the
  // plugin's echo guard is the only thing that can drop it.
  const lateAnswer = agyLateAnswers.get(sessionId)
  if (lateAnswer !== undefined && text.includes('AGY_REPLAY')) {
    // agy also replays the PREVIOUS turn's completed tool frame. The id was
    // seen in a completed turn, so the client must open no second card.
    await send({ sessionUpdate: 'tool_call_update', toolCallId: AGY_CALL_ID, status: 'completed' })
    const partial = text.includes('AGY_REPLAY_PARTIAL')
    const replay = partial ? lateAnswer.slice(0, Math.ceil(lateAnswer.length / 2)) : lateAnswer
    await send({ sessionUpdate: 'agent_message_chunk', messageId: 'm-agy-replay', content: { type: 'text', text: replay } })
    // The turn ends in the middle of a strict prefix of the replayed answer:
    // the client must flush what it held instead of dropping it.
    if (partial) return true
  }

  if (AGY_STORE !== undefined && text.includes('AGY_LATE')) {
    // The late answer lands only in agy's own transcript, one second AFTER
    // this turn's response: `agyLateAnswer` owns the anchor and the write.
    const answer = `AGY-LATE-ANSWER ${text}`
    agyLateAnswers.set(sessionId, answer)
    agyPendingLate.set(sessionId, answer)
  }
  return false
}

/**
 * End the turn the way agy does, and arm the late answer one second from now:
 * the delay is anchored to the TURN RESPONSE, not to the prompt, so a slow
 * turn cannot land its backlog inside the prompt that is still running.
 * Returns the prompt handler's terminal result.
 */
export function agyLateAnswer(sessionId) {
  const answer = agyPendingLate.get(sessionId)
  if (answer !== undefined) {
    agyPendingLate.delete(sessionId)
    ensureAgyTranscript(sessionId)
    const stepIndex = (agyStepIndex.get(sessionId) ?? 0) + 1
    agyStepIndex.set(sessionId, stepIndex)
    setTimeout(() => {
      try {
        const dir = join(AGY_STORE, 'brain', sessionId, '.system_generated', 'logs')
        mkdirSync(dir, { recursive: true })
        const line = JSON.stringify({
          step_index: stepIndex,
          type: 'PLANNER_RESPONSE',
          status: 'DONE',
          created_at: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
          content: answer,
        })
        appendFileSync(join(dir, 'transcript_full.jsonl'), `${line}\n`)
      } catch {
        // Best effort: a transcript write never changes the agent's answer.
      }
    }, 1000)
  }
  return { stopReason: 'end_turn' }
}

/**
 * Send the turn's opening tool card, preceded by agy's own completed card on
 * an "AGY_LATE" turn (its id is replayed by the next prompt, so the client must
 * open no second card for it).
 */
export async function sendOpeningToolCard(send, text, card) {
  if (AGY_STORE !== undefined && text.includes('AGY_LATE')) {
    await send({
      sessionUpdate: 'tool_call',
      toolCallId: AGY_CALL_ID,
      title: 'agy scheduled tool',
      kind: 'other',
      status: 'completed',
      content: [{ type: 'content', content: { type: 'text', text: 'agy tool result' } }],
    })
  }
  await send(card)
}

/**
 * The `session/load` replay hook. Owns the generic `replay_tool` frame (moved
 * here verbatim so mock-agent.mjs stays inside its line ratchet) and, under
 * MOCK_AGY_LOAD_REPLAY, the historical dispatch + creation result. agy's real
 * replay shape is UNMEASURED (task-1 brief): the plugin must skip bookkeeping
 * for the whole load window fail-open, whatever the replay carries.
 */
export async function agyLoadReplay(send, sessionId) {
  await send({ sessionUpdate: 'tool_call', toolCallId: 'replay_tool', title: 'replayed tool', kind: 'other', status: 'completed' })
  if (process.env.MOCK_AGY_LOAD_REPLAY === undefined) return
  await send(agyDispatchCall(AGY_DISPATCH_ID, 'License Migrator'))
  await send(agyDispatchResult(AGY_DISPATCH_ID, sessionId, '1'))
}
