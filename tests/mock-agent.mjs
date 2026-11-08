#!/usr/bin/env node
/**
 * Scripted ACP agent for integration tests (no API key, no LLM).
 *
 * Scenario markers read from the prompt text:
 *  - "PERM"  → mid-turn session/request_permission (allow_once / reject_once)
 *  - "SLOW"  → a 5s pause that session/cancel interrupts (cancelled stopReason)
 *  - "STEERABLE" → an ordinary turn cut at a card boundary: the standard
 *              opening streams, then `PRE-STEER CUT TEXT` lands after the
 *              tool card (the client closes that segment while the prompt is
 *              still on air), and the handler waits up to 5s for a
 *              `session/cancel`, answering `cancelled` when one arrives. The
 *              follow-up prompt carrying "STEER WORDS" is a plain steer —
 *              NOT the background-drain "STEER" shape below; both markers
 *              share the prefix, so the drain branch excludes them.
 *  - "DIE"   → emits one update then exits the process (crash → release → resume)
 *  - "QUOTA" → the CodeBuddy rate-limit shape: the prompt is ANSWERED (a
 *              resolve, never a reject) with `stopReason: 'refusal'` and the
 *              reason in the response `_meta["codebuddy.ai/errorMessage"]` as a
 *              JSON string whose `data.category` is `quota`. Variants:
 *              "QUOTA_DRAIN" also announces a background drain that never
 *              speaks (the ambient wait must lose to the refusal), and
 *              "QUOTA_WORKER" also dispatches a detached worker that never
 *              reports (the background hold must lose to it too).
 *  - "REFUSED" → the same resolve-with-`refusal` shape, but NOT a quota (a
 *              content policy): the turn closes as an ordinary stop and the
 *              agent's own reason must survive into the zero-output line.
 *  - "EMPTY" → only a usage_update, then a legal end_turn: the silent-failure
 *              shape wild agents produce (pi-acp folds a provider 403 into a
 *              normal stop), zero visible output
 *  - "FAIL"  → the prompt request fails (JSON-RPC error), zero visible output
 *  - "IGNORE_CANCEL" → ignores session/cancel for ~1.2s, then finishes normally
 *  - "HANG"  → the prompt request NEVER resolves and no update is ever sent
 *              (the wedged agent the inactivity watchdog exists for); a
 *              session/cancel is ignored on purpose
 *  - "HANG_DELAY:<ms>" → sends nothing for <ms> (a slow but alive agent), then
 *              runs the normal turn; session/cancel is ignored too
 *  - "HANG_TOOL" → streams the usual opening (thought / plan / tool card), puts
 *              the tool call `in_progress`, then NEVER finishes the turn: the
 *              "working on a tool" shape the second stall window covers
 *  - "HANG_TWO_TOOLS" → opens TWO tool calls, completes ONE, leaves the other
 *              `in_progress`, then NEVER finishes: the parallel-call shape (a
 *              finished call must not close the tool window while its sibling
 *              is still running)
 *  - "PACED" → a 1.2s tool wait followed by two answer chunks 100ms apart, so a
 *              test can prove the burst rate excludes tool waits but counts the
 *              within-answer gap
 *  - "PIDTAG" → appends `PID:<process.pid>` to the echo, so a test can tell
 *              whether the SAME agent process served two turns (a restart /
 *              reclaim shows a different pid). Opt-in on purpose: every other
 *              prompt keeps the byte-exact echo the existing tests assert.
 *  - "STEER" → the codebuddy 2.179.0 multitask shape: a background drain
 *              announces itself with `_meta["codebuddy.ai/unsolicitedTurn"]`,
 *              the prompt is answered at once (`end_turn`, NO
 *              `codebuddy.ai/conversationRequestId` on the response) and the
 *              actual answer streams afterwards under the drain's request id.
 *              No `session_end` is ever sent (the client's schema rejects it),
 *              so silence is the only "done" signal.
 *  - "STEERTOOL" (with STEER) → the same shape, but the drain only runs a tool
 *              (no thought, no answer text)
 *  - "STEERHARD" → a drain that outlives the client's ambient ceiling: it
 *              announces itself, the prompt is answered instantly, and NO
 *              update follows before the ceiling fires
 *  - "HARDTAIL" → the same drain (`amb-hard`) takes this prompt: instant
 *              answer, then (after 60ms) a re-announcement and
 *              `HARD-TAIL-TEXT`, proving the drain record survived the ceiling
 *  - "STALE_LATE" → a stale-cancel `cancelled` answer that arrives late
 *              (450ms), after the client may have moved on to a successor turn
 *  - "STALE_TICK" → a stale-cancel `cancelled` answer that is followed, 100ms
 *              after the response, by a `usage_update` tick: the test uses the
 *              tick as proof that the response landed, then cancels inside the
 *              client's retry-delay window
 *  - "QUIETDRAIN" → a background drain that announces itself and is answered
 *              at once, then stays SILENT so the client's ambient quiet window
 *              closes the turn; the next "REVIVE" prompt makes the same drain
 *              speak again (the drain outlived its wait)
 *  - "REVIVE" → the revived drain (`amb-quiet`) speaks at the START of this
 *              prompt, before its own `conversationRequestId` text; the client
 *              must keep it out of this turn
 *  - "REVIVE-LATE" (with REVIVE) → same drain text, but AFTER the own-id text:
 *              the stray-tail shape
 *  - "DRAINAGAIN" → the QUIETDRAIN run re-announces itself in this prompt and
 *              the response has no conversation request id: the revived id must
 *              be un-retired so the drain's text is the steered answer
 *  - "DRAINFIRST" → the revived drain speaks BEFORE the prompt response and
 *              WITHOUT re-announcing itself: the update alone must revive it
 *  - "CONVIDLE" → usage update only, then a normal answer that DOES name its
 *              conversation request id (a normal silent turn next to a recently
 *              retired drain)
 *  - "TAIL" → sends the final chunks and returns `end_turn` without waiting
 *              for their dispatch: the response/tail race the client's settle
 *              has to drain before judging an empty turn
 *  - "GAP" → the drain ticks (`usage_update` / `session_info_update`) every
 *              150ms for ~600ms after the instant response, then sends its
 *              text: proves the quiet window survives real model-call gaps
 *  - "EARLY" → the drain announces itself and streams `DRAIN-EARLY` BEFORE the
 *              prompt response (while the client cannot yet know which request
 *              id belongs to the user's turn), then answers normally WITH
 *              `_meta["codebuddy.ai/conversationRequestId"]` and streams
 *              `REAL-ANSWER`; a drain-owned tool call follows the own-id text
 *              so a normal turn must not open a card for it
 *  - "EARLY-STEER" (with EARLY) → same early `DRAIN-EARLY`, but the response
 *              carries NO conversation request id and the drain keeps talking
 *  - "FLOOD" → a background drain that announces itself and streams more
 *              indexed text updates than the client's bounded withhold buffer
 *              holds before the prompt response decides what the turn is; the
 *              response has no conversation request id, so the prompt is
 *              folded into it (and the kept tail can be told from the evicted
 *              front)
 *  - "DISPATCH" → the CodeBuddy 2.179.0 DETACHED-WORKER shape, with the
 *              measured wire details: the coordinator opens an `Agent` tool
 *              call (`codebuddy.ai/toolName` + the parent's request ids) and
 *              re-sends that SAME call with `codebuddy.ai/isBackground` /
 *              `isSubagent` once the worker runs detached; the ack update
 *              names the tool again, says "已派", and the coordinator answers
 *              its own prompt normally. The worker streams under its own
 *              request id with `codebuddy.ai/parentToolCallId`, the Agent call
 *              completes with **NO `_meta` at all** (the real wire sends it
 *              bare), an `unsolicitedTurn` drain announces itself, and the
 *              drain's TaskOutput + final text (the parent's answer) carry the
 *              response's own request id — all after the prompt response.
 *              Nothing may reach the main plane except the coordinator's own
 *              ack and the drain's final answer.
 *  - "DISPATCHNODRAIN" (with DISPATCH) → the worker never reports back: the
 *              dispatch stays in progress and only the client's worker-phase
 *              ceiling can end the turn (no parent text at all)
 *  - "DISPATCHACKNODRAIN" (with DISPATCH) → the coordinator acks ("已派") and
 *              answers, but the worker never reports: the deferral line must
 *              still appear (the ack is not the drained run's answer)
 *  - "DISPATCHSLOW" (with DISPATCH) → a slow worker phase, so a test can act
 *              while the turn is holding
 *  - "DISPATCHSILENT" (with DISPATCH) → the worker is silent for longer than
 *              the test's ambient quiet window before it reports: the worker
 *              phase has no quiet clock, so the turn must survive it
 *  - "DISPATCHLONGTOOL" (with DISPATCH) → the worker opens a tool call and then
 *              emits nothing past the client's SHORT worker silence window: the
 *              open call must hold on the long tier until the report arrives
 *  - "DISPATCHTWO" (with DISPATCH) → two dispatches; the drain announces
 *              itself while BOTH are still running, the first reports early
 *              (parent text follows) and the second later; the turn must not
 *              close after the first report
 *  - "DISPATCHALTFIRST" (with DISPATCH) → the drain announces itself BEFORE
 *              the prompt response under a DIFFERENT id (`req-alt`); the
 *              response names `req-dispatch`, and the drain's text arrives
 *              under the announced id
 *  - "DISPATCHFAST" (with DISPATCH) → the worker runs, reports and completes
 *              BEFORE the prompt response; the drain still follows
 *  - "DISPATCHLATEDRAIN" (with DISPATCH) → the dispatch completes WITHOUT
 *              `_meta` and the drain's announcement is delayed past the test's
 *              quiet window: the completion itself must start the drain phase
 *  - "DISPATCHPARKED" (with DISPATCH) → the response lands between driver
 *              steps (right after the ack) and the worker starts while the
 *              host is away: a parked hold's step must adopt it later
 *  - "DISPATCHCOMPLETEMETA" (with DISPATCH) → the detached signal and the
 *              completion arrive in ONE frame (isBackground + status completed),
 *              before anyone reported the row: it must never light
 *  - "DISPATCHFAILED" (with DISPATCH) → the worker's completion frame reports
 *              `failed` (no `_meta`, matched by callId) and carries the
 *              agent's own failure `content`; the drain still follows, so a
 *              failed worker must not change the turn-hold semantics
 *  - "DISPATCHNOSTATUS" (with DISPATCH) → the dispatch call's first `tool_call`
 *              frame carries NO status: the record starts `pending` until a
 *              worker update proves the work is running
 *
 * Environment knobs:
 *  - MOCK_NO_LOAD=1 → `initialize` advertises no `loadSession` capability
 *  - MOCK_LONG_TOOL_TITLE=1 → the main tool card carries a LONG pwsh command
 *              as its `title` (the codebuddy shape) under a distinct call id,
 *              and rewrites that title mid-call; DEFAULT OFF keeps the
 *              byte-exact 'mock tool' / 'call_1' shape and the exact echo
 *  - MOCK_IGNORE_CLOSE=1 → `session/close` is never answered (a wedged agent);
 *              the host's stall reset must not wait for a graceful close
 *  - MOCK_FORK=1 → `initialize` advertises the UNSTABLE `sessionCapabilities.fork`
 *              bit, and `session/fork` is served: a NEW session id carrying the
 *              same state shape a fresh `session/new` produces
 *  - MOCK_FORK_MODE=conflict → `session/fork` answers with the PARENT's session
 *              id (the "returned an id that already exists" shape)
 *  - MOCK_FORK_MODE=hang → `session/fork` NEVER answers (the wedged fork the
 *              startup timeout exists for)
 *  - MOCK_FORK_LOG=<path> → every `session/fork` request's params are appended
 *              there as one JSON line, so a test can count the requests the
 *              agent actually received and compare their wire shape
 *  - MOCK_PROMPT_LOG=<path> → every `session/prompt`'s text is appended there
 *              as one line, so a test can prove a rejected prompt never reached
 *              the agent
 *
 * Stale-cancel window: for 300ms after a `session/cancel` the NEXT prompt is
 * answered `cancelled` without generating a turn (the codebuddy 2.161.4
 * cleanup race — cancel state is cleared asynchronously and the prompt that
 * lands inside the window is swallowed). A prompt arriving after the window
 * runs normally.
 *  - "READFILE <path>"   → reads the file through the client fs capability
 *  - "WRITEFILE <path>"  → writes 'written-by-mock-agent' through the client fs capability
 *  - "PWD"   → reports this PROCESS's own cwd (what an agent that derives its
 *              workspace from `process.cwd()` would answer)
 *  - "MCPS"  → echoes the MCP servers this session was created with, as the
 *              exact WIRE shape the host sent (`session/new` / `session/load`)
 * Every turn streams: thought, plan, available_commands, tool_call lifecycle,
 * two same-messageId chunks, usage_update.
 * `session/new` advertises spec-shaped configOptions: a `model` selector, a
 * `thought_level` selector, and a plain legacy `temp` select.
 * `session/load` (loadSession capability) recreates the session record and
 * replays a marker update before answering, simulating agent-side persistence.
 */
import { Writable, Readable } from 'node:stream'
import { appendFileSync } from 'node:fs'
import { agent, methods, ndJsonStream, PROTOCOL_VERSION } from '@agentclientprotocol/sdk'

const sessions = new Map()
/**
 * MOCK_SINGLE_SESSION=1: the CodeBuddy connection shape — one live session per
 * connection. Every `session/new` / `session/load` on this connection evicts
 * whatever it was serving before, and a prompt on an evicted session is refused
 * (never executed). Existing markers are untouched: the knob is opt-in.
 */
const SINGLE_SESSION = process.env.MOCK_SINGLE_SESSION === '1'
/**
 * MOCK_LOAD_DELAY_MS=<ms>: `session/load` answers only after this pause (the
 * replay updates still go out first). A test uses it to hold the recovery
 * open and inject a second caller while the record is owned by nobody but the
 * request itself. Default 0 keeps every other test byte-identical.
 */
const LOAD_DELAY_MS = Number(process.env.MOCK_LOAD_DELAY_MS ?? '0')
/**
 * MOCK_CANCEL_ANSWER_DELAY_MS=<ms>: "SLOW" acknowledges `session/cancel` and
 * answers `cancelled` only after this pause. A test uses it to keep the prompt
 * RESPONSE outstanding while the client closes and tries to prune the holder:
 * the delay is deterministic, so "the request is still in flight when the
 * prune runs" is a fact, not a race won by luck. Default 0 keeps every other
 * test byte-identical.
 */
const CANCEL_ANSWER_DELAY_MS = Number(process.env.MOCK_CANCEL_ANSWER_DELAY_MS ?? '0')
const evicted = new Set()
const cancelled = new Set()
const cancelWaiters = new Map()
/** sessionId → epoch ms until which the next prompt is swallowed (stale cancel). */
const cancelCleanupUntil = new Map()
/** The drain announced by "QUIETDRAIN", revived by the next "REVIVE" prompt. */
let quietDrainId = null
let counter = 0

// The model a fresh session starts on (tests may pin one via MOCK_MODEL).
const DEFAULT_MODEL = process.env.MOCK_MODEL ?? 'mock-model-a'
// Test knob: reproduce Qoder CN's payload from issue #8, where the only
// thought control is `reasoning_effort` tagged `category: 'model'`.
const QODER_MODEL_CATEGORY = process.env.MOCK_QODER_MODEL_CATEGORY === '1'
// Test knob: the mock's `mock-model-plain` (the variant-less model that
// publishes no thought_level) is also selectable from the model list.
const PLAIN_MODEL_CHOICE = process.env.MOCK_PLAIN_MODEL_CHOICE === '1'
// Test knob: publish the mode as a `category: 'mode'` select too (codebuddy /
// opencode shape), so the agent-level catalog can carry a mode value that a
// NEW conversation's `session/new` does not start on.
const MODE_OPTION = process.env.MOCK_MODE_OPTION === '1'
// Test knob: the FIRST session this process opens starts in this mode; later
// ones start on 'default'. That is the "catalog remembers another session's
// mode" shape a fresh conversation must not silently lose.
const FIRST_MODE = process.env.MOCK_FIRST_MODE
/**
 * MOCK_LONG_TOOL_TITLE=1: reproduce codebuddy's shape where the whole pwsh
 * command rides in the `title` (docs/acp-convergence.md 1.5) and the title is
 * rewritten mid-call. Opt-in on purpose: DEFAULT OFF keeps every other prompt
 * byte-identical, including the exact `MOCK: echo ...` assertion. A DISTINCT
 * call id keeps this card separate from the shared `call_1` of other turns.
 */
const LONG_TOOL_TITLE = process.env.MOCK_LONG_TOOL_TITLE === '1'
const LONG_TITLE_CALL_ID = 'long_title_call'
const LONG_TITLE_COMMAND = 'pwsh -NoProfile -Command "Get-ChildItem C:/repo -Recurse | Select-String MOCK_LONG_TITLE_MARKER | Format-Table"'
const MAIN_CALL_ID = LONG_TOOL_TITLE ? LONG_TITLE_CALL_ID : 'call_1'
const MAIN_TITLE = LONG_TOOL_TITLE ? LONG_TITLE_COMMAND : 'mock tool'

function mockConfigOptions(state = { temp: 'mid', model: DEFAULT_MODEL, effort: 'high' }) {
  return [
    {
      configId: 'model',
      name: 'Model',
      type: 'select',
      category: 'model',
      currentValue: state.model,
      options: [
        { value: 'mock-model-a', name: 'Mock Model A' },
        { value: 'mock-model-b', name: 'Mock Model B', description: 'The stronger mock model' },
        ...(PLAIN_MODEL_CHOICE ? [{ value: 'mock-model-plain', name: 'Mock Model Plain' }] : []),
      ],
    },
    // `mock-model-plain` stands for a model with NO variants: like opencode's
    // `effort` option, a thought_level is published only for models that have
    // one — switching the model is what reveals it.
    ...(state.model === 'mock-model-plain' ? [] : QODER_MODEL_CATEGORY ? [{
      configId: 'reasoning_effort',
      name: 'Reasoning Effort',
      type: 'select',
      category: 'model',
      currentValue: state.effort,
      options: [
        { value: 'xhigh', name: 'Extra High' },
        { value: 'low', name: 'Low' },
        { value: 'medium', name: 'Medium' },
        { value: 'none', name: 'None' },
      ],
    }] : [{
      configId: 'thought',
      name: 'Thought Level',
      type: 'select',
      category: 'thought_level',
      currentValue: state.effort,
      options: [
        { value: 'off', name: 'Off' },
        { value: 'high', name: 'High' },
      ],
    }]),
    {
      configId: 'temp',
      name: 'Temperature',
      type: 'select',
      currentValue: state.temp,
      options: [
        { value: 'low', name: 'low' },
        { value: 'mid', name: 'mid' },
        { value: 'high', name: 'high' },
      ],
    },
    // Only when the knob is on: the mock otherwise mirrors an agent whose modes
    // exist ONLY in `session/new`'s `modes` field.
    ...(MODE_OPTION ? [{
      configId: 'mode',
      name: 'Mode',
      type: 'select',
      category: 'mode',
      currentValue: state.modeId ?? 'default',
      options: [
        { value: 'default', name: 'Default' },
        { value: 'strict', name: 'Strict' },
      ],
    }] : []),
    // A boolean toggle (ACP `type: 'boolean'`, no choices). The composer
    // renders it as a checkbox; the host must send it back as
    // `type: 'boolean'` with a real boolean value.
    {
      configId: 'stream',
      name: 'Stream Mode',
      type: 'boolean',
      currentValue: state.stream === true,
    },
  ]
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function cancelPromise(sessionId) {
  return new Promise(resolve => {
    const list = cancelWaiters.get(sessionId) ?? []
    list.push(resolve)
    cancelWaiters.set(sessionId, list)
  })
}

function fireCancel(sessionId) {
  for (const resolve of cancelWaiters.get(sessionId) ?? []) resolve()
  cancelWaiters.set(sessionId, [])
}

/**
 * Connection-level single-session eviction: keep the record (so close / config
 * calls stay coherent) but mark it superseded. Returning here instead of
 * deleting the record also keeps the "REPLAYED" replay path of a later
 * `session/load` byte-identical.
 */
function evictForNewSession(sessionId) {
  if (!SINGLE_SESSION) return
  for (const id of sessions.keys()) {
    if (id !== sessionId) evicted.add(id)
  }
}

const app = agent({ name: 'mock-acp-agent' })
  .onRequest(methods.agent.initialize, () => ({
    protocolVersion: PROTOCOL_VERSION,
    agentCapabilities: {
      loadSession: process.env.MOCK_NO_LOAD !== '1',
      sessionCapabilities: {
        close: {},
        // Opt-in: advertising the UNSTABLE fork bit unconditionally would let a
        // fork-naive host ask an agent that never implemented it.
        ...(process.env.MOCK_FORK === '1' ? { fork: {} } : {}),
      },
      promptCapabilities: { image: process.env.MOCK_IMAGE === '1', audio: false, embeddedContext: false },
    },
    agentInfo: { name: 'mock-acp-agent', title: 'Mock ACP Agent', version: '0.0.1' },
    authMethods: [],
  }))
  .onRequest(methods.agent.session.new, ctx => {
    // The PID prefix makes ids unique ACROSS PROCESSES too: a restart creates a
    // new counter, and a test that proves "the host opened a NEW agent session"
    // (a reset, not a `session/load`) compares ids from two different children.
    const sessionId = `mock-sess-${String(process.pid)}-${String(++counter)}`
    evictForNewSession(sessionId)
    const modeId = FIRST_MODE !== undefined && counter === 1 ? FIRST_MODE : 'default'
    sessions.set(sessionId, { cwd: ctx.params.cwd, modeId, temp: 'mid', model: DEFAULT_MODEL, effort: 'high', stream: false, mcpServers: ctx.params.mcpServers })
    return {
      sessionId,
      modes: {
        currentModeId: modeId,
        availableModes: [
          { id: 'default', name: 'Default' },
          { id: 'strict', name: 'Strict' },
        ],
      },
      configOptions: mockConfigOptions(sessions.get(sessionId)),
    }
  })
  .onNotification(methods.agent.session.cancel, ctx => {
    cancelled.add(ctx.params.sessionId)
    cancelCleanupUntil.set(ctx.params.sessionId, Date.now() + 300)
    fireCancel(ctx.params.sessionId)
  })
  .onRequest(methods.agent.session.close, async ctx => {
    // IGNORE_CLOSE: the wedged agent that never acknowledges a graceful close.
    // A stall recovery must not depend on this request (it restarts the
    // process instead), so a host that awaited it would hang here forever —
    // which is exactly what the integration test pins.
    if (process.env.MOCK_IGNORE_CLOSE === '1') await new Promise(() => {})
    sessions.delete(ctx.params.sessionId)
    return {}
  })
  .onRequest(methods.agent.session.load, async ctx => {
    const { sessionId, cwd } = ctx.params
    evictForNewSession(sessionId)
    // Stand-in for agent-side persistence: recreate the record, replay a
    // marker update, then answer with the session state.
    sessions.set(sessionId, { cwd, modeId: 'default', temp: 'mid', model: DEFAULT_MODEL, effort: 'high', stream: false, mcpServers: ctx.params.mcpServers })
    const send = update => ctx.client.notify(methods.client.session.update, { sessionId, update })
    await send({ sessionUpdate: 'tool_call', toolCallId: 'replay_tool', title: 'replayed tool', kind: 'other', status: 'completed' })
    await send({ sessionUpdate: 'agent_message_chunk', messageId: 'replay-1', content: { type: 'text', text: 'REPLAYED: earlier conversation' } })
    // MOCK_LOAD_DELAY_MS: hold the RESPONSE open so a test can act while the
    // session is mid-recovery (released cleared, not yet in `sessions`). The
    // replay above already landed, so the pause is deterministic: the test sees
    // the inflight request, not a sleep-based guess.
    if (LOAD_DELAY_MS > 0) await new Promise(resolve => setTimeout(resolve, LOAD_DELAY_MS))
    return {
      modes: {
        currentModeId: 'default',
        availableModes: [
          { id: 'default', name: 'Default' },
          { id: 'strict', name: 'Strict' },
        ],
      },
      configOptions: mockConfigOptions(sessions.get(sessionId)),
    }
  })
  .onRequest(methods.agent.session.fork, async ctx => {
    // Recorded BEFORE any mode branch: the log is the record of what the agent
    // actually received, so a "zero requests" assertion reads an absent file
    // and a wire-shape assertion reads the request's own params.
    const logPath = process.env.MOCK_FORK_LOG
    if (logPath !== undefined) appendFileSync(logPath, `${JSON.stringify(ctx.params)}\n`)
    if (process.env.MOCK_FORK_MODE === 'hang') {
      // The wedged fork: this request stays open forever, like the HANG prompt.
      await new Promise(() => {})
    }
    if (process.env.MOCK_FORK_MODE === 'conflict') {
      // The interleaving hazard: an answer naming a session this connection
      // already routes would let the parent's updates land in the child.
      return { sessionId: ctx.params.sessionId }
    }
    const sessionId = `mock-sess-${String(process.pid)}-${String(++counter)}`
    sessions.set(sessionId, { cwd: ctx.params.cwd, modeId: 'default', temp: 'mid', model: DEFAULT_MODEL, effort: 'high', stream: false, mcpServers: ctx.params.mcpServers })
    return {
      sessionId,
      modes: {
        currentModeId: 'default',
        availableModes: [
          { id: 'default', name: 'Default' },
          { id: 'strict', name: 'Strict' },
        ],
      },
      configOptions: mockConfigOptions(sessions.get(sessionId)),
    }
  })
  .onRequest(methods.agent.session.setConfigOption, async ctx => {
    const session = sessions.get(ctx.params.sessionId)
    if (session === undefined) throw new Error('no such session')
    // Test knob: an agent mid-reset answering (and pushing) an EMPTY option
    // set. The host must treat it as a non-answer that never wipes known state.
    if (ctx.params.configId === 'mock-empty-answer') {
      await ctx.client.notify(methods.client.session.update, {
        sessionId: ctx.params.sessionId,
        update: { sessionUpdate: 'config_option_update', configOptions: [] },
      })
      return { configOptions: [] }
    }
    if (ctx.params.configId === 'temp') session.temp = String(ctx.params.value)
    else if (ctx.params.configId === 'model') session.model = String(ctx.params.value)
    else if (ctx.params.configId === 'thought') session.effort = String(ctx.params.value)
    else if (ctx.params.configId === 'mode' && MODE_OPTION) session.modeId = String(ctx.params.value)
    else if (ctx.params.configId === 'stream') {
      // A boolean option must arrive discriminated: `type: 'boolean'` + a real
      // boolean. The request union keys on `type`, so a client that forgets it
      // is sending a select value id at a toggle.
      if (ctx.params.type !== 'boolean' || typeof ctx.params.value !== 'boolean') {
        throw new Error('stream is a boolean option: expected type "boolean" and a boolean value')
      }
      session.stream = ctx.params.value
    }
    return { configOptions: mockConfigOptions(session) }
  })
  .onRequest(methods.agent.session.setMode, async ctx => {
    const session = sessions.get(ctx.params.sessionId)
    if (session === undefined) throw new Error('no such session')
    session.modeId = ctx.params.modeId
    await ctx.client.notify(methods.client.session.update, {
      sessionId: ctx.params.sessionId,
      update: { sessionUpdate: 'current_mode_update', currentModeId: ctx.params.modeId },
    })
    return {}
  })
  .onRequest(methods.agent.session.prompt, async ctx => {
    const { sessionId } = ctx.params
    const imageBlocks = ctx.params.prompt.filter(part => part.type === 'image')
    const text = ctx.params.prompt
      .filter(part => part.type === 'text')
      .map(part => part.text)
      .join(' ')
    const promptLog = process.env.MOCK_PROMPT_LOG
    if (promptLog !== undefined) appendFileSync(promptLog, `${text}\n`)

    // Single-session connection (MOCK_SINGLE_SESSION=1): a session superseded
    // by a later `session/new` / `session/load` executes NOTHING — no markers,
    // no updates, no cancel acknowledgment. This is the CodeBuddy wire shape
    // the per-session-process design exists for.
    if (SINGLE_SESSION && evicted.has(sessionId)) {
      throw new Error('session_superseded: this connection switched to another session')
    }

    const send = update => ctx.client.notify(methods.client.session.update, { sessionId, update })
    let permissionAnswer = 'none'

    // Stale-cancel swallow: a prompt landing inside the cleanup window of the
    // PREVIOUS cancel is answered from that cancel — no updates, no turn.
    const cleanupUntil = cancelCleanupUntil.get(sessionId)
    if (cleanupUntil !== undefined && Date.now() < cleanupUntil) {
      return { stopReason: 'cancelled' }
    }

    // Inactivity-watchdog modes, checked before any output. None of them
    // acknowledges session/cancel: the watchdog exists for the agent that does
    // not even acknowledge a cancel, so the reply must not arrive just because
    // the host gave up on it. `HANG_TOOL` / `HANG_TWO_TOOLS` are excluded here —
    // they hang LATER, with tool calls already in flight.
    const delayed = /HANG_DELAY:(\d+)/.exec(text)
    if (delayed !== null) {
      await sleep(Number(delayed[1]))
    } else if (text.includes('HANG') && !text.includes('HANG_TOOL') && !text.includes('HANG_TWO_TOOLS')) {
      // A wedged agent: this request stays open forever. Nothing resolves it —
      // not the cancel notification, not a timer. The process keeps serving
      // other sessions, exactly like an agent stuck inside one turn.
      await new Promise(() => {})
    }

    if (text.includes('FAIL') && !text.includes('DISPATCHFAILED')) {
      throw new Error('mock prompt failure')
    }

    if (text.includes('STALE_LATE')) {
      // The stale-cancel answer arrives LATE: a swallowed prompt's `cancelled`
      // response lands after the client may already have moved on to a
      // successor turn. The client must not resend it into that successor.
      await sleep(450)
      return { stopReason: 'cancelled' }
    }

    if (text.includes('STALE_TICK')) {
      // A stale-cancel answer followed by one tick AFTER the response. The test
      // waits for the tick (proof the `cancelled` answer landed) and then
      // cancels inside the client's retry delay: a second stop must suppress
      // the resend. The tick is bookkeeping, so it opens nothing on the plane.
      // It lands almost immediately so the cancel has the whole retry delay to
      // arrive, not a fixed slice of it.
      setTimeout(() => {
        void ctx.client.notify(methods.client.session.update, {
          sessionId,
          update: { sessionUpdate: 'usage_update', used: 7, size: 1000 },
        })
      }, 10)
      return { stopReason: 'cancelled' }
    }

    if (text.includes('DISPATCH')) {
      // The detached-worker shape CodeBuddy 2.179.0 produces with multitask
      // on, with the measured wire details:
      //  - the dispatch call names its tool (`codebuddy.ai/toolName: "Agent"`)
      //    and the parent turn's ids on its FIRST send;
      //  - the SAME call is re-sent with `codebuddy.ai/isBackground: true` /
      //    `isSubagent` / `subagentType` once the worker runs detached — the
      //    structural signal, no English text needed;
      //  - the ack update names the tool again; the dispatch COMPLETION carries
      //    no `_meta` at all (the real wire sends it bare);
      //  - the worker's updates name their parent call (`parentToolCallId`) and
      //    a request id of their own (`req-worker`);
      //  - the drain's TaskOutput names `TaskOutput`, the final parent text
      //    carries only `requestId`, and both use the RESPONSE's conversation
      //    request id (`req-dispatch`) unless the drain announced another.
      const dispatchId = 'agent_dispatch'
      const secondId = 'agent_dispatch_two'
      const drainId = 'req-dispatch'
      const altId = 'req-alt'
      const workerId = 'req-worker'
      const secondWorkerId = 'req-worker-two'
      const slow = text.includes('DISPATCHSLOW')
      const silent = text.includes('DISPATCHSILENT')
      const two = text.includes('DISPATCHTWO')
      const fast = text.includes('DISPATCHFAST')
      const parked = text.includes('DISPATCHPARKED')
      const noDrain = text.includes('DISPATCHNODRAIN')
      const ackNoDrain = text.includes('DISPATCHACKNODRAIN')
      const lateDrain = text.includes('DISPATCHLATEDRAIN')
      const altFirst = text.includes('DISPATCHALTFIRST')
      const completedMeta = text.includes('DISPATCHCOMPLETEMETA')
      // A SYNCHRONOUS subagent: the child's own turn streams with
      // `parentToolCallId` (CodeBuddy labels child updates this way for sync AND
      // detached workers), but the dispatch is never re-sent with
      // `isBackground`. The tool completes and the parent answers in the SAME
      // turn; no drain follows, so the turn must close at the response.
      const sync = text.includes('DISPATCHSYNC')
      // The worker's own completion reports `failed` WITH the agent's reason
      // in `content` (still no `_meta`: matched by callId alone).
      const failed = text.includes('DISPATCHFAILED')
      // The first `tool_call` frame carries no status at all: the lifecycle
      // record starts `pending` until a worker update arrives.
      const noStatus = text.includes('DISPATCHNOSTATUS')
      // A long but healthy worker: it keeps emitting updates well past the
      // client's worker-phase SILENCE window. Those updates must push that
      // window out instead of letting a fixed total runtime cut the turn.
      const keepAlive = text.includes('DISPATCHKEEPALIVE')
      // A worker blocked inside ONE long tool call: it opens the call and then
      // emits nothing for longer than the client's SHORT worker silence
      // window. The open call alone must move the wait to the long tier.
      const longTool = text.includes('DISPATCHLONGTOOL')
      // The real first send omits `rawInput` (repl display) AND the title, so
      // its only label source is `_meta.toolName`. The identity arrives later,
      // on the result frame's `_meta` — the shape this variant pins.
      const identityOnly = text.includes('DISPATCHMETA')
      // The run the PARENT's own steps carry. Normally the response's
      // conversation request id; an early announcement can name another.
      let parentRun = drainId
      const notify = (update, meta) => ctx.client.notify(methods.client.session.update, {
        sessionId,
        update: meta === undefined ? update : { ...update, _meta: meta },
      })
      const dispatchCall = callId => ({
        sessionUpdate: 'tool_call',
        toolCallId: callId,
        title: 'Agent',
        kind: 'other',
        ...(noStatus ? {} : { status: 'in_progress' }),
        ...(identityOnly ? {} : {
          rawInput: {
            description: 'audit the repo',
            subagent_type: 'general-purpose',
            name: 'explorer',
            prompt: 'read the tree',
          },
        }),
      })
      const firstMeta = {
        'codebuddy.ai/toolName': 'Agent',
        'codebuddy.ai/requestId': drainId,
        'codebuddy.ai/conversationRequestId': drainId,
      }
      // No `toolName` here: the re-send is about the WORKER, not the call.
      const resendMeta = {
        'codebuddy.ai/isBackground': true,
        'codebuddy.ai/isSubagent': true,
        'codebuddy.ai/subagentType': 'general-purpose',
        'codebuddy.ai/requestId': drainId,
      }
      const ackMeta = {
        'codebuddy.ai/toolName': 'Agent',
        'codebuddy.ai/requestId': drainId,
        'codebuddy.ai/conversationRequestId': drainId,
      }
      const sendFirst = callId => notify(dispatchCall(callId), firstMeta)
      const sendResend = callId => notify(dispatchCall(callId), resendMeta)
      // The result frame's identity meta: the first place the role and task
      // line can be read when the first send omitted `rawInput`.
      const sendIdentity = callId => notify({
        sessionUpdate: 'tool_call_update',
        toolCallId: callId,
        status: 'in_progress',
      }, {
        ...resendMeta,
        'codebuddy.ai/description': 'audit the repo',
      })
      const sendAck = callId => notify({
        sessionUpdate: 'tool_call_update',
        toolCallId: callId,
        status: 'in_progress',
        content: [{
          type: 'content',
          content: {
            type: 'text',
            text: 'Started general-purpose agent: explorer\nagent_id: agent-1\nThe worker is running detached (no team). Wait for <task-notification>, then call TaskOutput once for the full report.',
          },
        }],
      }, ackMeta)
      const sendWorker = (update, id = workerId, parent = dispatchId) => notify(update, {
        'codebuddy.ai/requestId': id,
        'codebuddy.ai/parentToolCallId': parent,
      })
      // The parent's own steps: requestId only (TaskOutput names its tool; the
      // final prose names nothing).
      const sendDrain = (update, toolName) => notify(update, {
        'codebuddy.ai/requestId': parentRun,
        ...(toolName === undefined ? {} : { 'codebuddy.ai/toolName': toolName }),
      })
      // The real completion frame: NO `_meta` at all.
      const sendCompleted = (callId, status = 'completed', content) => notify({
        sessionUpdate: 'tool_call_update',
        toolCallId: callId,
        status,
        ...(content === undefined ? {} : { content }),
      })
      const announce = id => notify({ sessionUpdate: 'session_info_update' }, {
        'codebuddy.ai/unsolicitedTurn': { requestId: id, reason: 'background_drain' },
        'codebuddy.ai/requestId': id,
      })
      // The coordinator's own message ("已派…"): this turn's parent prose, so
      // it carries the parent run's request id and nothing else.
      const sendParentText = text => notify(
        { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } },
        { 'codebuddy.ai/requestId': parentRun },
      )
      const workerTurn = async (id, parent, toolCallId) => {
        // The worker's own turn: prose, a tool, its report. None of it is the
        // session's answer; it belongs in the ACP transcript view.
        await sendWorker({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'WORKER-THOUGHT ' } }, id, parent)
        await sendWorker({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'WORKER-INTERNAL-TEXT ' } }, id, parent)
        await sendWorker({
          sessionUpdate: 'tool_call',
          toolCallId,
          title: 'Bash',
          kind: 'execute',
          status: 'in_progress',
          rawInput: { command: 'rg TODO src' },
        }, id, parent)
        await sleep(longTool ? 2_500 : slow ? 400 : 60)
        await sendWorker({
          sessionUpdate: 'tool_call_update',
          toolCallId,
          status: 'completed',
          content: [{ type: 'content', content: { type: 'text', text: 'src/a.ts:3 TODO' } }],
        }, id, parent)
        await sendWorker({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'WORKER-REPORT-TEXT ' } }, id, parent)
        if (keepAlive) {
          // Live evidence far beyond the client's 1.5s worker-phase window.
          for (let tick = 0; tick < 7; tick += 1) {
            await sleep(300)
            await sendWorker({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: `WORKER-KEEPALIVE-${String(tick)} ` } }, id, parent)
          }
        }
        if (slow) await sleep(400)
      }
      const drainTurn = async (finalText = 'DISPATCH-FINAL-ANSWER', announceRun = true) => {
        if (announceRun && !altFirst) await announce(parentRun)
        await sendDrain({
          sessionUpdate: 'tool_call',
          toolCallId: 'drain_task_output',
          title: 'TaskOutput',
          kind: 'read',
          status: 'in_progress',
        }, 'TaskOutput')
        await sleep(slow ? 300 : 40)
        await sendDrain({
          sessionUpdate: 'tool_call_update',
          toolCallId: 'drain_task_output',
          status: 'completed',
          content: [{ type: 'content', content: { type: 'text', text: 'WORKER REPORT BODY' } }],
        })
        // The parent's own answer — the text the main chat must receive.
        await sendDrain({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: finalText } })
      }

      await sendFirst(dispatchId)
      if (sync) {
        // The child's own turn streams (`parentToolCallId`, no `isBackground`),
        // the tool returns its result, and the parent consumes it and answers —
        // all before the prompt response. Nothing runs off-turn, so the response
        // must settle the turn normally instead of holding for a drain that will
        // never come.
        await workerTurn(workerId, dispatchId, 'worker_bash')
        await sendCompleted(dispatchId)
        await sendParentText('DISPATCH-SYNC-ANSWER ')
        return { stopReason: 'end_turn', _meta: { 'codebuddy.ai/conversationRequestId': drainId, 'codebuddy.ai/requestId': drainId } }
      }
      if (completedMeta) {
        // One frame that is simultaneously the detached re-send and the
        // completion, on a dispatch nobody has reported yet. The row must not
        // light: its work is already over.
        await notify({ sessionUpdate: 'tool_call_update', toolCallId: dispatchId, status: 'completed' }, resendMeta)
        await sleep(20)
        return { stopReason: 'end_turn', _meta: { 'codebuddy.ai/conversationRequestId': drainId, 'codebuddy.ai/requestId': drainId } }
      }
      if (identityOnly) {
        // The worker is already alive before the parent's result frame, so the
        // detached evidence arrives WITHOUT a usable label: the client must
        // not report a bare "Agent" row, only wait for the identity below.
        await sendWorker({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'WORKER-THOUGHT ' } })
        await sendIdentity(dispatchId)
      } else {
        await sendResend(dispatchId)
      }
      if (two) {
        await sendFirst(secondId)
        await sendResend(secondId)
      }
      const response = {
        stopReason: 'end_turn',
        _meta: { 'codebuddy.ai/conversationRequestId': drainId, 'codebuddy.ai/requestId': drainId },
      }
      if (noDrain) {
        // The worker never reports back and the coordinator says nothing: only
        // the client's worker-phase ceiling can end this turn.
        await sleep(30)
        return response
      }
      // The coordinator's acknowledgement, then the prompt response: on the
      // wire the parent turn is OVER while the worker runs on.
      await sleep(20)
      await sendAck(dispatchId)
      if (two) await sendAck(secondId)
      await sleep(20)
      await sendParentText('DISPATCH-ACK ')
      if (ackNoDrain) {
        // Acked, then silence: the dispatch never reports.
        await sleep(120)
        return response
      }
      if (fast) {
        // The worker is so fast it reports, streams and completes BEFORE the
        // response; the drain still follows the parent's answer.
        await workerTurn(workerId, dispatchId, 'worker_bash')
        await sendCompleted(dispatchId)
        setTimeout(() => { void drainTurn() }, 30)
        return response
      }
      if (altFirst) {
        // The drain announces itself BEFORE the response, under its own id.
        await announce(altId)
        parentRun = altId
      }
      if (parked) {
        // The response lands BETWEEN driver steps: the ack was the cutting
        // event and the host has not opened the next step yet. The worker
        // starts while the host is away; the parked hold must adopt its step.
        setTimeout(() => {
          void (async () => {
            await workerTurn(workerId, dispatchId, 'worker_bash')
            await sendCompleted(dispatchId)
            await drainTurn()
          })()
        }, 30)
        return response
      }
      await sleep(slow ? 120 : 60)
      setTimeout(() => {
        void (async () => {
          if (two) {
            // The drain announced itself while BOTH dispatches were running:
            // the first report must not arm its quiet clock, so the turn must
            // still be holding after it.
            await announce(parentRun)
            await workerTurn(workerId, dispatchId, 'worker_bash')
            await sendCompleted(dispatchId)
            await sendDrain({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'DISPATCH-TWO-A-DONE ' } })
            await sleep(120)
            await workerTurn(secondWorkerId, secondId, 'worker_bash_two')
            await sendCompleted(secondId)
            await sendDrain({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'DISPATCH-TWO-B-DONE ' } })
            await drainTurn('DISPATCH-TWO-FINAL ', false)
            return
          }
          if (silent) await sleep(600)
          if (lateDrain) {
            // The dispatch completes WITHOUT meta and the drain is not
            // announced for a while: the completion alone must start the drain
            // phase (its quiet window then closes the turn).
            await workerTurn(workerId, dispatchId, 'worker_bash')
            await sendCompleted(dispatchId)
            await sleep(400)
            await drainTurn('DISPATCH-LATE-ANSWER')
            return
          }
          await workerTurn(workerId, dispatchId, 'worker_bash')
          await sendCompleted(
            dispatchId,
            failed ? 'failed' : 'completed',
            failed ? [{ type: 'content', content: { type: 'text', text: 'WORKER-FAILED-REASON' } }] : undefined,
          )
          await drainTurn(altFirst ? 'DISPATCH-ALT-ANSWER' : 'DISPATCH-FINAL-ANSWER')
        })()
      }, 30)
      return response
    }

    if (text.includes('GAP')) {
      // A drain that spends ~600ms inside a real model hand-off, ticking every
      // 150ms: the client's quiet window must be measured in the agent's own
      // cadence, not in chat-app milliseconds.
      const requestId = 'amb-gap'
      const drainSend = update => ctx.client.notify(methods.client.session.update, {
        sessionId,
        update: { ...update, _meta: { 'codebuddy.ai/requestId': requestId } },
      })
      await ctx.client.notify(methods.client.session.update, {
        sessionId,
        update: {
          sessionUpdate: 'session_info_update',
          _meta: { 'codebuddy.ai/unsolicitedTurn': { requestId, reason: 'background_drain' } },
        },
      })
      await sleep(25)
      setTimeout(() => {
        void (async () => {
          for (let i = 0; i < 4; i += 1) {
            await sleep(150)
            await drainSend(i % 2 === 0
              ? { sessionUpdate: 'usage_update', used: 10 + i, size: 1000 }
              : { sessionUpdate: 'session_info_update' })
          }
          await drainSend({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'GAP-TEXT' } })
        })()
      }, 20)
      return { stopReason: 'end_turn' }
    }

    if (text.includes('FLOOD')) {
      // More drain updates than the client's bounded withhold buffer holds.
      // They stream BEFORE the prompt response, while the client cannot know
      // yet whether this prompt is its own turn or a steer; the response then
      // says "steer" (no conversation request id), so the buffer is flushed —
      // and its dropped front must be reported, never silently lost. Each
      // update carries its index so a test can prove the buffer kept the TAIL.
      const requestId = 'amb-flood'
      const drainSend = update => ctx.client.notify(methods.client.session.update, {
        sessionId,
        update: { ...update, _meta: { 'codebuddy.ai/requestId': requestId } },
      })
      await ctx.client.notify(methods.client.session.update, {
        sessionId,
        update: {
          sessionUpdate: 'session_info_update',
          _meta: { 'codebuddy.ai/unsolicitedTurn': { requestId, reason: 'background_drain' } },
        },
      })
      await sleep(25)
      for (let i = 0; i < 220; i += 1) {
        await drainSend({
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: `FLOOD-${String(i).padStart(3, '0')} ` },
        })
      }
      // Dispatch time, not a timing bet: the notifications must be in the
      // client's hands before the response is judged.
      await sleep(50)
      return { stopReason: 'end_turn' }
    }

    if (text.includes('EARLY')) {
      // The drain speaks BEFORE the prompt response is judged. The client has
      // no own request id yet, so the drain's text must be withheld until the
      // response says whether this prompt was its own turn or a steer.
      const drainId = 'amb-early'
      const conversationId = 'conv-early'
      const drainSend = update => ctx.client.notify(methods.client.session.update, {
        sessionId,
        update: { ...update, _meta: { 'codebuddy.ai/requestId': drainId } },
      })
      const ownSend = update => ctx.client.notify(methods.client.session.update, {
        sessionId,
        update: { ...update, _meta: { 'codebuddy.ai/requestId': conversationId } },
      })
      await ctx.client.notify(methods.client.session.update, {
        sessionId,
        update: {
          sessionUpdate: 'session_info_update',
          _meta: { 'codebuddy.ai/unsolicitedTurn': { requestId: drainId, reason: 'background_drain' } },
        },
      })
      await sleep(25)
      await drainSend({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'DRAIN-EARLY ' } })
      // Give the client time to fold it while the turn's own id is unknown.
      await sleep(30)
      if (text.includes('STEER')) {
        // Steered: the response has NO conversation id, so the withheld drain
        // text must be flushed into this turn; the drain keeps talking.
        setTimeout(() => {
          void (async () => {
            await drainSend({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'AFTER-EARLY ' } })
            await drainSend({ sessionUpdate: 'tool_call', toolCallId: 'amb_early_tool', title: 'early drain tool', kind: 'other', status: 'in_progress' })
            await drainSend({
              sessionUpdate: 'tool_call_update',
              toolCallId: 'amb_early_tool',
              status: 'completed',
              content: [{ type: 'content', content: { type: 'text', text: 'EARLY TOOL OUTPUT' } }],
            })
          })()
        }, 20)
        return { stopReason: 'end_turn' }
      }
      // A normal turn: its own text names the conversation turn id first, then
      // a drain-owned tool call arrives (which must stay transcript-only), and
      // the response confirms the conversation id.
      await ownSend({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'REAL-ANSWER ' } })
      await drainSend({ sessionUpdate: 'tool_call', toolCallId: 'drain_early_tool', title: 'drain tool during a normal turn', kind: 'other', status: 'in_progress' })
      await drainSend({
        sessionUpdate: 'tool_call_update',
        toolCallId: 'drain_early_tool',
        status: 'completed',
        content: [{ type: 'content', content: { type: 'text', text: 'DRAIN EARLY TOOL OUTPUT' } }],
      })
      await ownSend({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'REAL-TAIL' } })
      await sleep(20)
      return { stopReason: 'end_turn', _meta: { 'codebuddy.ai/conversationRequestId': conversationId } }
    }

    if (text.includes('DRAINAGAIN')) {
      // The drain from QUIETDRAIN is alive and RE-ANNOUNCES itself: the client
      // must un-retire the id, rebuild the ambient record, and treat this
      // prompt as steered — the text below is the answer, not transcript-only.
      const requestId = quietDrainId ?? 'amb-quiet'
      const drainSend = update => ctx.client.notify(methods.client.session.update, {
        sessionId,
        update: { ...update, _meta: { 'codebuddy.ai/requestId': requestId } },
      })
      await ctx.client.notify(methods.client.session.update, {
        sessionId,
        update: {
          sessionUpdate: 'session_info_update',
          _meta: { 'codebuddy.ai/unsolicitedTurn': { requestId, reason: 'background_drain' } },
        },
      })
      await sleep(25)
      setTimeout(() => {
        void drainSend({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'REANNOUNCED-TEXT ' } })
      }, 20)
      return { stopReason: 'end_turn' }
    }

    if (text.includes('DRAINFIRST')) {
      // The revived drain speaks BEFORE the prompt response is judged and does
      // NOT re-announce itself: the update alone must un-retire the id and
      // rebuild the ambient record, so the folded prompt is recognised as
      // steered and the whole answer reaches the user.
      const requestId = quietDrainId ?? 'amb-quiet'
      const drainSend = update => ctx.client.notify(methods.client.session.update, {
        sessionId,
        update: { ...update, _meta: { 'codebuddy.ai/requestId': requestId } },
      })
      await drainSend({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'DRAIN-FIRST-TEXT ' } })
      await sleep(30)
      setTimeout(() => {
        void drainSend({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'DRAIN-FIRST-TAIL' } })
      }, 20)
      return { stopReason: 'end_turn' }
    }

    if (text.includes('QUIETDRAIN')) {
      // A drain that announces itself and is answered at once, then stays
      // SILENT: the client's ambient quiet window closes the turn. The run
      // itself is NOT over — the next "REVIVE" prompt makes it speak again.
      const requestId = 'amb-quiet'
      await ctx.client.notify(methods.client.session.update, {
        sessionId,
        update: {
          sessionUpdate: 'session_info_update',
          _meta: { 'codebuddy.ai/unsolicitedTurn': { requestId, reason: 'background_drain' } },
        },
      })
      await sleep(25)
      quietDrainId = requestId
      return { stopReason: 'end_turn' }
    }

    if (text.includes('REVIVE')) {
      // The drain from QUIETDRAIN outlived its ambient wait and speaks during
      // THIS turn. REVIVE sends it BEFORE the own-id text (the id-adoption
      // trap); REVIVE-LATE sends it after (the stray-tail shape). Either way it
      // is a background run's output and must not join the user's answer.
      const requestId = quietDrainId ?? 'amb-quiet'
      const drainSend = update => ctx.client.notify(methods.client.session.update, {
        sessionId,
        update: { ...update, _meta: { 'codebuddy.ai/requestId': requestId } },
      })
      const ownSend = update => ctx.client.notify(methods.client.session.update, {
        sessionId,
        update: { ...update, _meta: { 'codebuddy.ai/requestId': 'conv-revive' } },
      })
      const revived = async () => {
        await drainSend({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'REVIVED-DRAIN-TEXT ' } })
        await drainSend({ sessionUpdate: 'tool_call', toolCallId: 'amb_quiet_tool', title: 'revived drain tool', kind: 'other', status: 'in_progress' })
        await drainSend({
          sessionUpdate: 'tool_call_update',
          toolCallId: 'amb_quiet_tool',
          status: 'completed',
          content: [{ type: 'content', content: { type: 'text', text: 'REVIVED TOOL OUTPUT' } }],
        })
      }
      if (text.includes('REVIVE-LATE')) {
        await ownSend({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'REVIVE-NORMAL-TEXT ' } })
        await revived()
      } else {
        await revived()
        await ownSend({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'REVIVE-NORMAL-TEXT ' } })
      }
      // Dispatch time, not a timing bet: every notification is in the client's
      // hands before the response is judged.
      await sleep(30)
      return { stopReason: 'end_turn', _meta: { 'codebuddy.ai/conversationRequestId': 'conv-revive' } }
    }

    if (text.includes('STEERHARD')) {
      // A drain that OUTLIVES the client's ambient ceiling: it announces
      // itself and the prompt is answered instantly, but no update follows
      // before the ceiling fires. The client must keep the drain record — the
      // HARDTAIL prompt below is folded into the SAME run.
      const requestId = 'amb-hard'
      await ctx.client.notify(methods.client.session.update, {
        sessionId,
        update: {
          sessionUpdate: 'session_info_update',
          _meta: { 'codebuddy.ai/unsolicitedTurn': { requestId, reason: 'background_drain' } },
        },
      })
      await sleep(25)
      return { stopReason: 'end_turn' }
    }

    if (text.includes('HARDTAIL')) {
      // The same drain (`amb-hard`) takes this prompt: instant answer, no
      // conversation id, then its text lands a beat later — after the instant
      // response, before the next ceiling. It re-announces itself first so a
      // test can prove one run is announced once (the notice de-dupe set must
      // survive the hard close).
      const requestId = 'amb-hard'
      const drainSend = update => ctx.client.notify(methods.client.session.update, {
        sessionId,
        update: { ...update, _meta: { 'codebuddy.ai/requestId': requestId } },
      })
      setTimeout(() => {
        void (async () => {
          await ctx.client.notify(methods.client.session.update, {
            sessionId,
            update: {
              sessionUpdate: 'session_info_update',
              _meta: { 'codebuddy.ai/unsolicitedTurn': { requestId, reason: 'background_drain' } },
            },
          })
          await drainSend({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'HARD-TAIL-TEXT ' } })
        })()
      }, 60)
      return { stopReason: 'end_turn' }
    }

    // The chat-steer scenario ("STEERABLE" and the follow-up "STEER WORDS")
    // shares this prefix but is NOT the drain shape: its first turn is an
    // ordinary prompt waiting on a cancel, and its steer words must reach the
    // agent as a plain prompt. Every existing drain marker still matches.
    if (text.includes('STEER') && !text.includes('STEERABLE') && !text.includes('STEER WORDS')) {
      // The background-drain shape: an unsolicited turn announces itself, the
      // prompt is folded into it and answered at once, and the real content
      // streams afterwards under the drain's request id.
      const requestId = 'amb-1'
      const drainSend = update => ctx.client.notify(methods.client.session.update, {
        sessionId,
        update: { ...update, _meta: { 'codebuddy.ai/requestId': requestId } },
      })
      await ctx.client.notify(methods.client.session.update, {
        sessionId,
        update: {
          sessionUpdate: 'session_info_update',
          _meta: { 'codebuddy.ai/unsolicitedTurn': { requestId, reason: 'background_drain' } },
        },
      })
      // The announcement must be in the client's hands BEFORE its response is
      // judged, or an instant `end_turn` reads as an ordinary silent turn.
      // 25ms is dispatch time, not a timing bet: the response is next.
      await sleep(25)
      setTimeout(() => {
        void (async () => {
          if (!text.includes('STEERTOOL')) {
            await drainSend({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'AMBIENT-THOUGHT ' } })
            await drainSend({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'AMBIENT-' } })
            await drainSend({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'TEXT ' } })
          }
          await drainSend({ sessionUpdate: 'tool_call', toolCallId: 'amb_tool', title: 'background tool', kind: 'other', status: 'in_progress' })
          await drainSend({
            sessionUpdate: 'tool_call_update',
            toolCallId: 'amb_tool',
            status: 'completed',
            content: [{ type: 'content', content: { type: 'text', text: 'AMBIENT TOOL OUTPUT' } }],
          })
          if (!text.includes('STEERTOOL')) {
            await drainSend({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'TAIL-TEXT' } })
          }
        })()
      }, 20)
      // No `codebuddy.ai/conversationRequestId`: the turn was merged into the
      // running drain, which is exactly what the client has to detect.
      return { stopReason: 'end_turn' }
    }

    if (text.includes('TAIL')) {
      // The tail race: the chunks are written but NOT awaited, then the answer
      // returns immediately — the client's notification dispatch may not have
      // folded them yet when the response lands.
      void send({ sessionUpdate: 'agent_message_chunk', messageId: 'tail', content: { type: 'text', text: 'TAIL-' } })
      void send({ sessionUpdate: 'agent_message_chunk', messageId: 'tail', content: { type: 'text', text: 'CHUNK' } })
      return { stopReason: 'end_turn' }
    }

    if (text.includes('CONVIDLE')) {
      // A normal instant answer that names the conversation turn it queued:
      // even with a recently retired drain id in the session, this turn is its
      // own and must close with the ordinary zero-output warning.
      await send({ sessionUpdate: 'usage_update', used: 5, size: 1000 })
      return { stopReason: 'end_turn', _meta: { 'codebuddy.ai/conversationRequestId': 'conv-idle' } }
    }

    if (text.includes('QUOTA')) {
      // The CodeBuddy rate-limit wire shape, measured: the prompt RESOLVES
      // (`stopReason: 'refusal'`, no JSON-RPC error anywhere) and the reason
      // rides the response `_meta` as a JSON string. Nothing in the turn says
      // the account is over quota, so a client that only reads the stop reason
      // reports a clean, silent turn.
      // Merge, never replace: the dispatch frames carry their own `_meta` keys
      // (`toolName` / `isBackground`) and those are the whole signal.
      const quotaMeta = update => ctx.client.notify(methods.client.session.update, {
        sessionId,
        update: { ...update, _meta: { ...(update._meta ?? {}), 'codebuddy.ai/requestId': 'req-quota' } },
      })
      if (text.includes('QUOTA_DRAIN')) {
        // A drain announced and then silent: an ambient wait on it would hold
        // the turn open for the whole quiet window, so a client that ranks the
        // refusal below the ambient branch never ends this turn on time.
        await ctx.client.notify(methods.client.session.update, {
          sessionId,
          update: {
            sessionUpdate: 'session_info_update',
            _meta: { 'codebuddy.ai/unsolicitedTurn': { requestId: 'amb-quota', reason: 'background_drain' } },
          },
        })
        await sleep(25)
      }
      if (text.includes('QUOTA_WORKER')) {
        // A detached worker dispatched and never reporting: a background hold
        // would keep the turn open for the worker window, which is the other
        // branch the refusal must outrank.
        await quotaMeta({
          sessionUpdate: 'tool_call',
          toolCallId: 'agent_quota',
          title: 'Agent',
          kind: 'other',
          status: 'in_progress',
          rawInput: { description: 'audit the repo', subagent_type: 'general-purpose', name: 'explorer' },
          _meta: { 'codebuddy.ai/toolName': 'Agent' },
        })
        await quotaMeta({
          sessionUpdate: 'tool_call',
          toolCallId: 'agent_quota',
          title: 'Agent',
          kind: 'other',
          status: 'in_progress',
          _meta: { 'codebuddy.ai/isBackground': true, 'codebuddy.ai/isSubagent': true },
        })
        await sleep(25)
      }
      return {
        stopReason: 'refusal',
        _meta: {
          'codebuddy.ai/errorMessage': JSON.stringify({
            code: -32003,
            message: '429 您使用量已超出频率限制，将在 2026-11-05 12:00 重置，您也可以切换其他模型继续使用。',
            data: { statusCode: 429, code: 6004, category: 'quota' },
          }),
        },
      }
    }

    if (text.includes('REFUSED')) {
      // The same resolve-with-`refusal` shape, but the agent declined for a
      // reason that is not a quota: the turn is an ordinary stop, and the
      // agent's own reason must reach the user rather than be dropped.
      return {
        stopReason: 'refusal',
        _meta: {
          'codebuddy.ai/errorMessage': JSON.stringify({
            code: -32003,
            message: 'content policy: the requested action is not allowed',
            data: { statusCode: 400, code: 6001, category: 'content_filter' },
          }),
        },
      }
    }

    if (text.includes('EMPTY')) {
      // Bookkeeping frames only: opens no visible block in the host's fold.
      await send({ sessionUpdate: 'usage_update', used: 5, size: 1000 })
      return { stopReason: 'end_turn' }
    }

    if (text.includes('DIE')) {
      await send({ sessionUpdate: 'agent_message_chunk', messageId: 'dying', content: { type: 'text', text: 'about to die' } })
      process.exit(1)
    }

    if (text.includes('READFILE')) {
      const path = text.split('READFILE')[1]?.trim().split(/\s+/)[0] ?? ''
      try {
        const file = await ctx.client.request(methods.client.fs.readTextFile, { sessionId, path })
        await send({ sessionUpdate: 'agent_message_chunk', messageId: 'fs', content: { type: 'text', text: `READ_OK:${file.content}` } })
      } catch (error) {
        await send({ sessionUpdate: 'agent_message_chunk', messageId: 'fs', content: { type: 'text', text: `READ_FAIL:${String(error?.message ?? error)}` } })
      }
    }

    if (text.includes('WRITEFILE')) {
      const path = text.split('WRITEFILE')[1]?.trim().split(/\s+/)[0] ?? ''
      try {
        await ctx.client.request(methods.client.fs.writeTextFile, { sessionId, path, content: 'written-by-mock-agent' })
        await send({ sessionUpdate: 'agent_message_chunk', messageId: 'fs', content: { type: 'text', text: 'WRITE_OK' } })
      } catch (error) {
        await send({ sessionUpdate: 'agent_message_chunk', messageId: 'fs', content: { type: 'text', text: `WRITE_FAIL:${String(error?.message ?? error)}` } })
      }
    }

    if (text.includes('PWD')) {
      // The stand-in for agents (codebuddy) that fix their workspace at process
      // start: this answer depends on where the child was SPAWNED, never on
      // `session/new`'s cwd.
      await send({ sessionUpdate: 'agent_message_chunk', messageId: 'cwd', content: { type: 'text', text: `PWD:${process.cwd()}` } })
    }

    if (text.includes('MCPS')) {
      // Echoes back the MCP servers this session was created with, so a test
      // can assert the exact WIRE shape the host sent (`session/new` /
      // `session/load`). Delimited on both sides: the chunk is joined with the
      // rest of the turn's text, so the JSON needs its own boundaries.
      const session = sessions.get(sessionId)
      await send({ sessionUpdate: 'agent_message_chunk', messageId: 'mcps', content: { type: 'text', text: `MCPS_BEGIN${JSON.stringify(session?.mcpServers ?? [])}MCPS_END` } })
    }

    if (text.includes('SILENTSLOW')) {
      // NO opening update at all: a provisional first turn only rolls back when
      // it has shown nothing, so the abort path under test needs the silent
      // shape. The cancel is acknowledged at once; MOCK_CANCEL_ANSWER_DELAY_MS
      // is what holds the RESPONSE open after it.
      const wasCancelled = await Promise.race([
        sleep(5000).then(() => false),
        cancelPromise(sessionId).then(() => true),
      ])
      if (wasCancelled) {
        cancelled.delete(sessionId)
        if (CANCEL_ANSWER_DELAY_MS > 0) await sleep(CANCEL_ANSWER_DELAY_MS)
        return { stopReason: 'cancelled' }
      }
    }

    await send({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'thinking…' } })
    await send({
      sessionUpdate: 'plan',
      entries: [
        { content: 'step one', status: 'completed', priority: 'high' },
        { content: 'step two', status: 'in_progress', priority: 'medium' },
      ],
    })
    await send({
      sessionUpdate: 'available_commands_update',
      availableCommands: [{ name: 'greet', description: 'say hi' }],
    })
    if (text.includes('TWOTOOLS')) {
      // The shapes the wild agents (codebuddy) actually send: a call announced
      // with a `rawInput` snapshot that later updates RESTATE IN WHOLE (the
      // update is a replacement, not an append), and a second call announced
      // while the first card is still the open block. The restatements also
      // INTERLEAVE across parallel calls — the t1 restatement below lands
      // while t2's card is the open block, and the final t1 update carries
      // the tool's real output as `content`.
      await send({ sessionUpdate: 'tool_call', toolCallId: 't1', title: 'first tool', rawInput: '{"cmd":""}' })
      await send({ sessionUpdate: 'tool_call_update', toolCallId: 't1', rawInput: '{"cmd":"ls -la"}' })
      // Some agents restate the announcement instead of updating; the same
      // callId on an open card is an update, never a second card.
      await send({ sessionUpdate: 'tool_call', toolCallId: 't1', title: 'first tool', rawInput: '{"cmd":"ls -la"}' })
      await send({ sessionUpdate: 'tool_call', toolCallId: 't2', title: 'second tool', rawInput: { path: 'a.md' } })
      await send({ sessionUpdate: 'tool_call', toolCallId: 't1', title: '`ls -la`', rawInput: '{"cmd":"ls -la"}' })
      await send({ sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: 'T1 OUTPUT LINE' } }] })
    }

    if (text.includes('HANG_TWO_TOOLS')) {
      // Parallel tool calls, the shape real agents produce: `ta` COMPLETES
      // while `tb` is still `in_progress`. The turn is still the agent's to
      // run — a sibling finishing is not the turn going quiet — so the host
      // must keep applying the (longer) tool window. Then silence, like
      // HANG_TOOL: session/cancel is ignored on purpose.
      await send({ sessionUpdate: 'tool_call', toolCallId: 'ta', title: 'first parallel tool', kind: 'other', status: 'pending' })
      await send({ sessionUpdate: 'tool_call', toolCallId: 'tb', title: 'second parallel tool', kind: 'other', status: 'pending' })
      await send({ sessionUpdate: 'tool_call_update', toolCallId: 'ta', status: 'in_progress' })
      await send({ sessionUpdate: 'tool_call_update', toolCallId: 'tb', status: 'in_progress' })
      await send({
        sessionUpdate: 'tool_call_update',
        toolCallId: 'ta',
        status: 'completed',
        content: [{ type: 'content', content: { type: 'text', text: 'first parallel result' } }],
      })
      await new Promise(() => {})
    }

    await send({ sessionUpdate: 'tool_call', toolCallId: MAIN_CALL_ID, title: MAIN_TITLE, kind: 'other', status: 'pending' })

    if (text.includes('PERM')) {
      // `PERMEDIT` / `PERMEXEC` declare the ACP tool-call kind and
      // `PERMLOC:<path>` the write locations, so host tests can exercise the
      // DSH access-mode mapping (kind classification + workspace containment).
      const kind = text.includes('PERMEDIT') ? 'edit' : text.includes('PERMEXEC') ? 'execute' : undefined
      const location = /PERMLOC:(\S+)/.exec(text)
      const toolCall = {
        toolCallId: 'call_1',
        title: 'mock dangerous operation',
        ...(kind === undefined ? {} : { kind }),
        ...(location === null ? {} : { locations: [{ path: location[1] }] }),
      }
      const response = await ctx.client.request(methods.client.session.requestPermission, {
        sessionId,
        toolCall,
        options: [
          { optionId: 'allow1', name: 'Allow once', kind: 'allow_once' },
          { optionId: 'reject1', name: 'Reject once', kind: 'reject_once' },
        ],
      })
      permissionAnswer = response.outcome.outcome === 'selected' ? response.outcome.optionId : 'cancelled'
    }

    await send({ sessionUpdate: 'tool_call_update', toolCallId: MAIN_CALL_ID, status: 'in_progress' })
    if (LONG_TOOL_TITLE) {
      // codebuddy rewrites titles mid-call: the raw command must never ride
      // back out as a tool name, but its (new) text must be preserved.
      await send({
        sessionUpdate: 'tool_call_update',
        toolCallId: LONG_TITLE_CALL_ID,
        title: `${LONG_TITLE_COMMAND} -Verbose`,
        status: 'in_progress',
      })
    }
    if (text.includes('STEERABLE')) {
      // 卡片之后再发一条正文：插件会在卡片边界切段、把宿主 step 结束，
      // 但本 prompt 仍然在飞 —— 宿主插话正好落在这个窗口。session/cancel
      // 立刻以 cancelled 结束，用来验证「取消当前回合后再发新 prompt」。
      await send({ sessionUpdate: 'agent_message_chunk', messageId: 'm-steer-cut', content: { type: 'text', text: 'PRE-STEER CUT TEXT ' } })
      const wasCancelled = await Promise.race([
        sleep(5000).then(() => false),
        cancelPromise(sessionId).then(() => true),
      ])
      cancelled.delete(sessionId)
      if (wasCancelled) return { stopReason: 'cancelled' }
    }
    if (text.includes('SLOW')) {
      const wasCancelled = await Promise.race([
        sleep(5000).then(() => false),
        cancelPromise(sessionId).then(() => true),
      ])
      if (wasCancelled) {
        cancelled.delete(sessionId)
        // MOCK_CANCEL_ANSWER_DELAY_MS: acknowledge the cancel at once, but hold
        // the RESPONSE so the client's close / prune window lands inside it.
        if (CANCEL_ANSWER_DELAY_MS > 0) await sleep(CANCEL_ANSWER_DELAY_MS)
        return { stopReason: 'cancelled' }
      }
    }
    if (text.includes('IGNORE_CANCEL')) {
      // Deliberately ignore the cancel notification to exercise the host's
      // cancel fallback timer; the turn eventually finishes normally.
      await sleep(1200)
      fireCancel(sessionId)
    }
    if (text.includes('HANG_TOOL')) {
      // The tool call is open (status `in_progress` above) and never completes:
      // a working agent whose tool half may legitimately take much longer than
      // its prose half. session/cancel is ignored, like the other HANG modes.
      await new Promise(() => {})
    }
    await send({
      sessionUpdate: 'tool_call_update',
      toolCallId: MAIN_CALL_ID,
      status: 'completed',
      content: [{ type: 'content', content: { type: 'text', text: 'tool result line' } }],
    })
    const paced = text.includes('PACED')
    if (paced) await sleep(1200)
    await send({ sessionUpdate: 'agent_message_chunk', messageId: 'm1', content: { type: 'text', text: 'MOCK:' } })
    if (paced) await sleep(100)
    // Opt-in process token: `REPLAYED` proves a `session/load`, but it is
    // emitted by ANY child, so it cannot prove the process changed. The pid can.
    const pidTag = text.includes('PIDTAG') ? ` PID:${String(process.pid)}` : ''
    const imgTag = imageBlocks.length > 0 ? ` images=${String(imageBlocks.length)}` : ''
    await send({ sessionUpdate: 'agent_message_chunk', messageId: 'm1', content: { type: 'text', text: ` echo ${text} perm=${permissionAnswer}${pidTag}${imgTag}` } })
    await send({ sessionUpdate: 'usage_update', used: 123, size: 1000 })
    return { stopReason: 'end_turn' }
  })

const stream = ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin))
app.connect(stream)
