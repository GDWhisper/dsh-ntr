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
 */
import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const AGY_STORE = process.env.MOCK_AGY_STORE
/** The completed tool call an agy turn announces and the next prompt replays. */
const AGY_CALL_ID = 'call_agy_1'
const agyStepIndex = new Map()
const agyLateAnswers = new Map()
/** Answer text waiting for its turn's response (`agyLateAnswer`). */
const agyPendingLate = new Map()

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
 * the turn (before its ordinary opening frames). Returns true when the turn
 * must end immediately (a partial replay). An "AGY_LATE" prompt only records
 * its pending answer here; the write is anchored by `agyLateAnswer`.
 */
export async function agyPrompt(send, sessionId, text) {
  // agy echoes the user's own prompt as a `user_message_chunk` at the start of
  // every turn. The chat plane already shows that message, so the client must
  // drop the echo instead of folding its raw JSON into the answer.
  if (text.includes('AGY_ECHO')) {
    await send({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text } })
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
