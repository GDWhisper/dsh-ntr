/**
 * The conversation→agent binding the REQUEST path honors.
 *
 * `session/chat-bind` records which ACP agent serves one DSH chat session — the
 * plugin's own mapping, deliberately not a DSH model route (see
 * `bindChatAgent`). But a route is exactly what the host driver reads per step
 * (`selectionFor(agent).current`: pending selection → last request header →
 * deployment default), and a session that has never run an ACP turn resolves to
 * the DEPLOYMENT DEFAULT — so the driver would reach this adapter only if the
 * binding is recorded as the session's model selection first.
 *
 * The guard (`presets/acp/acp-guard.mjs`) does that on the wake seam: DSH
 * 0.2.2+ fixes the step's route at preparation and reads `agent.model`, so the
 * guard calls `agent.model.select({ provider: 'acp', model })` from the
 * `agent/inbox/inserted` / `agent/inbox/claimed` listeners (before that read).
 * Older hosts have no `agent.model`; there the guard keeps an `agent/request`
 * waterfall rewrite registered with `prepend` so it lands OUTSIDE the harness's
 * own rewrite and wins. The guard is loaded by the harness's Loader as its own
 * module instance, so the two halves share state through this registry on
 * `globalThis` rather than through a module import — same-package,
 * cross-instance, like a service. The guard reads it defensively and degrades
 * to "no rewrite" (the harness default plays out) when it is absent;
 * `ACP_ROUTE_BINDING_KEY` is therefore a hand-copy discipline with the guard's
 * `BINDING_KEY` (see tests/register.spec.ts for the equivalence).
 */
export const ACP_ROUTE_BINDING_KEY = Symbol.for('dsh-ntr.acp-binding')

/** The registry shape the guard reads. Values are adapter model strings. */
export interface AcpRouteBindingRegistry {
  /** DSH chat session id → the adapter model (`agentId` | `agentId@choice`) its next turn runs on. */
  readonly conversations: Map<string, string>
  /**
   * ACP tool call id → the tool's output folded to plain text. The guard's
   * `tools/execute` listener answers the host loop's execution of an ACP
   * display card from here, so the card records the tool's REAL output
   * instead of an `unknown tool` error (see `recordAcpToolOutput`).
   */
  readonly toolResults: Map<string, string>
  /**
   * Call ids whose output is COMPLETE — including a tool that produced none.
   * An announcing `tool_call` records the call with an empty output, and that
   * empty record must not read as an answer: membership here is what lets
   * `waitForToolOutput` resolve with it instead of parking until the turn
   * settles.
   */
  readonly toolOutputFinal: Set<string>
  /**
   * Resolvers waiting for a call's output to land, keyed by call id. Under the
   * segmented turn shape the host loop executes a card the moment its segment
   * settles — often BEFORE the agent has reported the tool's output — so the
   * guard's virtual tool parks here until `recordAcpToolOutput` (or the turn's
   * settlement, or the bounded timeout) releases it.
   */
  readonly toolOutputWaiters: Map<string, Set<(text: string | undefined) => void>>
  /** Bare agent id served when a conversation carries no explicit binding (`undefined`: no rewrite). */
  defaultModel?: string
  /**
   * Wait for a call's output to land (the plugin's implementation, shared via
   * the registry so the preset's separate module instance can reach it). The
   * guard's virtual tools call this when the host loop executes a card whose
   * tool is still running inside the ACP agent.
   */
  waitForToolOutput?: (callId: string, timeoutMs: number) => Promise<string | undefined>
}

/**
 * Install (or reuse) the process-wide registry. Idempotent: the guard and the
 * plugin load in either order, and a hot reload must not orphan bindings the
 * previous instance recorded.
 */
export function routeBindingRegistry(): AcpRouteBindingRegistry {
  const host = globalThis as unknown as { [ACP_ROUTE_BINDING_KEY]?: AcpRouteBindingRegistry }
  const existing = host[ACP_ROUTE_BINDING_KEY]
  if (existing !== undefined) {
    // A registry from an older build may predate a seam: re-attach the
    // (upgraded) implementation so the guard can always use it.
    if (existing.waitForToolOutput === undefined) existing.waitForToolOutput = (callId, timeoutMs) => waitForToolOutput(callId, timeoutMs)
    if (existing.toolOutputFinal === undefined) (existing as { toolOutputFinal: Set<string> }).toolOutputFinal = new Set<string>()
    return existing
  }
  const registry: AcpRouteBindingRegistry = {
    conversations: new Map(),
    toolResults: new Map(),
    toolOutputFinal: new Set(),
    toolOutputWaiters: new Map(),
    waitForToolOutput: (callId, timeoutMs) => waitForToolOutput(callId, timeoutMs),
  }
  host[ACP_ROUTE_BINDING_KEY] = registry
  return registry
}

/** Bounds for the shared tool-output record (see {@link recordAcpToolOutput}). */
const TOOL_OUTPUT_MAX_ENTRIES = 200
const TOOL_OUTPUT_MAX_CHARS = 16_000

/**
 * Record one ACP tool call for the guard's virtual tools. The host loop
 * "executes" every tool-call block in a settled ACP message (that execution
 * record is what draws the card); the preset registers no tools, so each call
 * would record `Error: unknown tool "<name>"`. The guard's `tools/execute`
 * listener instead registers a scoped virtual tool per name, and its body
 * answers with THIS record — the tool's real output, folded by the same helper
 * the ACP view uses.
 *
 * Every seen call id is recorded, even with empty output: an agent announces a
 * call before it reports the result (CodeBuddy restates the whole `tool_call`
 * once more with the output attached — see docs/acp-convergence.md §1.7), so
 * the first record is routinely `''`. Such a record is a placeholder, not an
 * answer: only a non-empty output, or a call the agent marked terminal,
 * releases a parked waiter. Bounded: entries are transient, but an agent that
 * inlines whole files must not grow the process-wide map without limit.
 *
 * @param final - whether the agent's status for this call is terminal.
 */
export function recordAcpToolOutput(callId: string, text: string, final = false): void {
  if (callId === '') return
  const registry = routeBindingRegistry()
  registry.toolResults.set(callId, text.length > TOOL_OUTPUT_MAX_CHARS ? `${text.slice(0, TOOL_OUTPUT_MAX_CHARS)}…` : text)
  if (final) registry.toolOutputFinal.add(callId)
  while (registry.toolResults.size > TOOL_OUTPUT_MAX_ENTRIES) {
    const oldest = registry.toolResults.keys().next().value
    if (oldest === undefined) break
    registry.toolResults.delete(oldest)
    registry.toolOutputFinal.delete(oldest)
  }
  if (text === '' && !final) return
  const waiters = registry.toolOutputWaiters.get(callId)
  if (waiters !== undefined) {
    registry.toolOutputWaiters.delete(callId)
    for (const waiter of [...waiters]) waiter(registry.toolResults.get(callId))
  }
}

/**
 * Wait for a tool call's output to land in the shared registry. The host loop
 * executes a card as soon as its segment settles, which routinely happens
 * while the ACP agent is still running the tool; the guard's virtual tool
 * parks here so the card's execution record ends up with the real output.
 *
 * Resolves with the output text, or `undefined` when the bounded timeout
 * elapses or the turn settles first (the caller then answers with a pointer to
 * the ACP transcript view). Never rejects and never waits past the timeout.
 */
export function waitForToolOutput(callId: string, timeoutMs: number): Promise<string | undefined> {
  const registry = routeBindingRegistry()
  if (callId === '') return Promise.resolve(undefined)
  const landed = registry.toolResults.get(callId)
  // An EMPTY record is an answer only once the call is terminal — a tool that
  // genuinely produced no output. Otherwise it is the announcement that the
  // call started, and resolving with it is what made every display card answer
  // with the transcript pointer while the agent was still running the tool.
  if (landed !== undefined && (landed !== '' || registry.toolOutputFinal.has(callId))) return Promise.resolve(landed)
  return new Promise<string | undefined>(resolve => {
    let settled = false
    const done = (text: string | undefined): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      const waiters = registry.toolOutputWaiters.get(callId)
      if (waiters !== undefined) {
        waiters.delete(done)
        if (waiters.size === 0) registry.toolOutputWaiters.delete(callId)
      }
      resolve(text)
    }
    const timer = setTimeout(() => done(undefined), Math.max(0, timeoutMs))
    timer.unref?.()
    let waiters = registry.toolOutputWaiters.get(callId)
    if (waiters === undefined) {
      waiters = new Set()
      registry.toolOutputWaiters.set(callId, waiters)
    }
    waiters.add(done)
  })
}

/** Release every output waiter (a turn settled; nothing more can land for it). */
export function releaseAllToolOutputWaiters(): void {
  const registry = routeBindingRegistry()
  const waiters = [...registry.toolOutputWaiters.values()]
  registry.toolOutputWaiters.clear()
  for (const set of waiters) for (const waiter of [...set]) waiter(undefined)
}

/**
 * The `source` of the host message that carries an idle background drain's
 * report into the chat plane.
 *
 * CodeBuddy's unsolicited turn is not a chat turn: with the default "settle at
 * the prompt response" nothing owns its prose. The only entry into the main
 * plane is a driver step, so the manager injects one hidden user message and
 * the adapter answers it LOCALLY with the collected report (no ACP prompt is
 * sent — the agent already produced that text). The chat row renders as
 * injected context (`source.kind !== 'user'`), never as the person's words,
 * and the report rides in `source.report` so the visible text stays one neutral
 * line.
 *
 * The kind MUST be producer-owned: DSH's V4 session format refuses the retired
 * catch-all `'plugin'` kind in every durable message slot ("format v4 message
 * requires a producer-owned source kind"). A released V3 `plugin` source is
 * rewritten to `plugin:<name>` only while an old log is migrated; a live
 * producer declares its own kind. This plugin therefore owns `dsh-ntr` and
 * keeps its attribution in `form` + `summary` + `report`.
 *
 * The preset guard hand-copies ALL of these constants (a separate module
 * instance the loader mounts without imports). All sides must change together.
 */
export const BACKGROUND_REPORT_SOURCE = 'dsh-ntr'

/**
 * The `source.form` of that wake message (see {@link BACKGROUND_REPORT_SOURCE}).
 *
 * The wake-shape predicate is kind + FORM — deliberately NOT "carries a report":
 * a host pipeline that strips `source.report` must still let the wake reach
 * `streamPrompt`, which then closes the turn LOCALLY with
 * {@link BACKGROUND_REPORT_LOST_TEXT}. A message with another kind or another
 * form is ordinary context and stays stripped.
 *
 * A `notice` also needs a `summary`: the host's context row reads it as the
 * collapsed one-line account and falls back to the OPAQUE body when it is
 * absent (that body lists every source field, including `report`). The wake
 * therefore records the same neutral line there.
 */
export const BACKGROUND_REPORT_FORM = 'notice'

/**
 * The visible text of that wake message. Deliberately NEUTRAL: it is shown as
 * an injected-notice row, while the actual answer follows as the assistant
 * message the adapter replay yields.
 */
export const BACKGROUND_WAKE_TEXT = 'Background task completed.'

/**
 * What the adapter answers a wake whose `source.report` the host pipeline
 * lost. One fixed, neutral English line, answered LOCALLY (no `session/prompt`
 * — and never a fall-through to the forward picker: that would re-send the
 * person's last real message as a duplicate prompt and the agent might
 * dispatch the work all over again). The full output is in the ACP transcript
 * view either way.
 */
export const BACKGROUND_REPORT_LOST_TEXT = 'Background task completed, but its report was lost in the host pipeline. The full output is in the ACP transcript view.'

/**
 * Bound on one drained report. The text rides TWO payloads (the hidden wake
 * message's `source.report` and the assistant reply the adapter yields), so an
 * unbounded transcript-sized answer would be copied twice. Same budget as an
 * ACP tool payload; the tail is dropped WITH a marker, never silently.
 */
export const BACKGROUND_REPORT_MAX = 256_000

/**
 * Whether this message is the plugin's own idle-drain wake — the ONE shape
 * `wakeChatWithBackgroundReport` injects. Shared by
 * {@link backgroundReportOf} and the local replay in `streamPrompt`; the preset
 * guard hand-copies the same predicate (`isBackgroundWake`).
 *
 * Deliberately shape-only (kind + form, no report): a host pipeline that
 * strips `source.report` must still let the wake through so the adapter can
 * close the step locally with {@link BACKGROUND_REPORT_LOST_TEXT}.
 *
 * Residual risk (an unguardable lower bound): a host that strips `source`
 * ENTIRELY turns the wake into a source-less message, which the forward picker
 * reads as the person's own words. Nothing in this repo can defend against
 * that; it is the reason the predicate is shape-based at all.
 */
function isBackgroundWakeMessage(message: unknown): boolean {
  const row = message as { role?: unknown; source?: { kind?: unknown; form?: unknown } } | undefined
  if (row?.role !== 'user') return false
  const source = row.source
  if (source === undefined || source === null || typeof source !== 'object') return false
  return source.kind === BACKGROUND_REPORT_SOURCE
    && source.form === BACKGROUND_REPORT_FORM
}

/**
 * What one driver step must answer for a wake message, or `undefined` when the
 * step is an ordinary turn.
 *
 * FIFO — the OLDEST unanswered wake wins. Candidates are the wake-shaped
 * messages; a candidate is skipped when anything after it already answered it
 * (an `assistant` / `tool` message — the replay, or a continuation) or
 * outranks it (a REAL user message — the person spoke again; injected
 * projections and system/developer nodes say nothing about who this step
 * answers). The host opens one step per queued wake, so a newest-first scan
 * would replay the SECOND wake first, drop the first report, and leave the
 * next step with nothing to answer — `selectForwardPrompt` would then re-send
 * the person's old message as a duplicate prompt.
 */
export function backgroundReportOf(messages: readonly unknown[]): BackgroundWake | undefined {
  for (let index = 0; index < messages.length; index += 1) {
    if (!isBackgroundWakeMessage(messages[index])) continue
    let answered = false
    for (let later = index + 1; later < messages.length; later += 1) {
      const row = messages[later] as { role?: unknown; source?: { kind?: unknown } } | undefined
      // An assistant reply consumed it; a tool result is a continuation step.
      if (row?.role === 'assistant' || row?.role === 'tool') {
        answered = true
        break
      }
      // The person spoke again: their words outrank a queued wake.
      if (row?.role === 'user') {
        const kind = row.source?.kind
        if (kind === 'user' || kind === undefined) {
          answered = true
          break
        }
      }
    }
    if (answered) continue
    const report = (messages[index] as { source?: { report?: unknown } }).source?.report
    return typeof report === 'string' && report.trim() !== ''
      ? { kind: 'report', text: report }
      : { kind: 'lost' }
  }
  return undefined
}

/**
 * The wake shape {@link backgroundReportOf} recognized, discriminated:
 * `report` replays the collected text, `lost` means the wake arrived without
 * its report (the host pipeline stripped `source.report`) and the step must
 * close locally with {@link BACKGROUND_REPORT_LOST_TEXT}.
 */
export type BackgroundWake = { kind: 'report'; text: string } | { kind: 'lost' }
