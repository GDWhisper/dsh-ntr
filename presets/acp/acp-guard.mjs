/**
 * acp-guard — keep the harness's own context injections out of an ACP session.
 *
 * WHY: a session on the `acp` preset is a shell around another agent. The
 * harness still wakes its driver for injected context (`agent-instructions` and
 * the `skill-catalog` reminder arrive through the `agent/pre-step` waterfall),
 * and those injections ride the request as sourced USER messages — folded
 * directly behind the person's own message, with the runtime-context snapshot
 * appended after them. A bridge that forwarded "the last user message" would
 * hand the ACP agent the harness's context instead of the question. dsh-ntr's
 * bridge filters by `message.source.kind`, and this row is the second line of
 * defence: it removes the injections before `step()` commits them, so the
 * session's durable transcript — which is what `deriveMessages()` feeds the
 * adapter — shows the conversation and nothing else. One exception is the
 * host's own runtime-context projection: `step()` recomputes and appends it
 * whether or not this gate let a copy through, so all stripping decides there
 * is its position, not its presence.
 *
 * KEPT SOURCES — AN ALLOW LIST, NOT A DENY LIST: only `user` (the person) and
 * `tool` (the loop's own continuity) survive, plus a message with no `source`
 * at all (the hand-built-request convention the bridge's forward picker uses).
 * Everything else the harness contributes is context by construction: its
 * identity, the AGENTS.md digest (`agent-instructions`), the skill catalog, the
 * runtime snapshot (`runtime-context` — the host's own constant, NOT `plugin`),
 * memory recalls (`dsh-mnemon`), plugin notices, and the "model changed"
 * notice (`model-selection`), which describes a harness route this
 * conversation does not expose.
 *
 * Naming the kinds to DROP instead was issue #10 twice over: every host release
 * adds an injection, and a kind missing from the list left a residue in a
 * continuation step's batch — which the refusal below turned into
 * `turn/end {kind:"blocked"}`, killing the whole turn. `strippedSources` still
 * names kinds to drop; supplying it REPLACES the allow list, so `[]` keeps
 * everything (the debugging hatch it always was).
 *
 * A CONTINUATION STEP IS NEVER REFUSED (third duty). The driver proposes a next
 * step whenever the settled assistant message carries `tool-call` blocks —
 * exactly what the ACP agent's segmented stream produces (one card-bearing
 * message per tool activity; see docs/acp-convergence.md §1.8). That step's
 * batch holds NO tool result: `dsh-agent-loop` stages only a tool's own
 * `additionalContexts` into the next-step inbox, and the request the adapter
 * reads is `session.deriveMessages()` — the whole transcript, not this batch.
 * So the batch is whatever the harness injected plus the loop's own
 * runtime-context projection (which `step()` appends to the transcript whether
 * or not it survived this gate), and after the allow list it is EMPTY.
 *
 * Refusing it would end the turn; entering it hands the decision to the adapter,
 * which is already the authority (`isAcpToolContinuation` in src/impl.ts): it
 * resumes the SAME in-flight `session/prompt` from the transcript cursor — never
 * sending a new one, so the person's words reach the agent exactly once — and
 * closes with one pointer line when no turn of ours is live. An empty batch on
 * a FIRST step stays the plain enter: the loop ends it as a completed no-op
 * (the injected-wake path). Only a batch left with neither the person nor a
 * tool result is refused, which the allow list makes unreachable unless an
 * explicit `strippedSources` override put foreign kinds back.
 *
 * DISPLAY CARDS EXECUTE AS REAL RESULTS (fourth duty): the card the Chat
 * plane draws IS the execution record, so the call must execute and record a
 * result. With no tool registered it would record `Error: unknown tool
 * "Bash"` (a red pile of errors). The `tools/execute` waterfall is the seam:
 * for that ONE reserved name, this row registers a SCOPED virtual tool (this
 * ctx is the ACP session's agent scope, so the registration shadows nothing
 * outside it) whose body answers with the call's real output — the bridge
 * records every `tool_call` / `tool_call_update` content into the shared
 * registry (`toolResults`, keyed by call id). Under the SEGMENTED turn shape
 * the loop executes a card the moment its segment settles, which is often
 * BEFORE the agent reports the tool's output, so the body first parks on the
 * registry's `waitForToolOutput` (released by the record itself, by the
 * turn's settlement, or by a bounded timeout). A name that resolves to a REAL
 * tool passes untouched; a missing `tools` service degrades to the old
 * error-result behavior. EXCEPTION: the ONE reserved name this plugin gives
 * its own cards (`ACP_TOOL_CALL_NAME` below) must never resolve to a real host
 * tool. If `tools.get(CONST, exec.agent)` does return one, tools/execute fails
 * closed with an error result (no register, no next()) - delegating would run
 * agent-supplied args in the host process, bypassing the permission ledger.
 *
 * THE ISOLATION GATE: the listener handles ONLY `ACP_TOOL_CALL_NAME`. Every
 * other tool name is passed straight through with one string comparison at the
 * very top - no warn, no probe, no virtual-tool registration, no fail-closed.
 * Non-NTR paths therefore see nothing of this row (belt and braces on top of
 * the host's scope-filtered `tools/execute` waterfall).
 *
 * Config:
 *   strippedSources?: string[]  — source kinds to drop, REPLACING the allow
 *                                 list below (`[]` keeps everything, e.g. to
 *                                 debug what the harness is injecting).
 *
 * ROUTE (second duty): the host driver resolves each step's route as "pending
 * selection → last request header → deployment default". A session that has
 * never run an ACP turn therefore resolves to the deployment default (a
 * provider this conversation cannot use), and one bound to a different agent
 * replays the previous `acp/<agent>` header. The route must be the plugin's
 * conversation→agent binding (`dsh-ntr` records it on bind, on model switch,
 * and when a session materializes; the plugin's default agent answers
 * conversations nobody bound).
 *
 * DSH 0.2.2+ FIXES THAT ROUTE AT STEP PREPARATION: `preStep` captures
 * `agent.model.current()` synchronously right after the inbox splice that
 * wakes the driver, and `agent/request` may then only adjust non-route
 * controls — proposing a different provider/model (or effort) fails the step
 * with "agent/request proposed … after step preparation fixed …; use
 * agent.model.select() before step preparation". The hook that lands before
 * that capture is the agent's OWN selection projection: `agent.model.select`
 * appends a `model/selection` event, and the projection is folded
 * synchronously, so a listener on `agent/inbox/inserted` (the splice that
 * wakes the driver) and on `agent/inbox/claimed` (inside `preStep`, right
 * before the capture — it also covers input queued in a previous process)
 * runs in time. This row records the binding there. `agent/created` is
 * deliberately NOT a seam: a preset switch away before the first turn would
 * leave an `acp/...` selection on what is now an ordinary session.
 *
 * OLDER HOSTS (no `agent.model`) get the reverse: their `preStep` captures no
 * route, and only the `agent/request` waterfall can name one. This row keeps
 * that rewrite for exactly those hosts, registered with `{ prepend: true }` so
 * it lands outside the harness's own selection rewrite. It drops the resolved
 * `reasoningEffort`: that belongs to whatever route the seed named, while the
 * agent's thought level is the plugin's own per-session axis
 * (`session/chat-effort-set`), and a foreign effort would fail the adapter's
 * effort validation.
 *
 * The binding lives on `globalThis` under `BINDING_KEY` — the guard and the
 * plugin are separate module instances of the same package, so a module import
 * would not share state. Read defensively: a registry that is absent or shaped
 * unexpectedly degrades to "no rewrite", which is exactly the pre-guard
 * behavior. `BINDING_KEY` is a hand-copy discipline with `ACP_ROUTE_BINDING_KEY`
 * in src/bridge.ts (tests/register.spec.ts asserts the two see one registry).
 *
 * Deliberately dependency-free: this file is loaded by the harness's Loader as
 * the preset declaration's `dsh-ntr/acp-guard` row (see acp.patch.yml), and it
 * needs nothing but the `ctx` it is handed and node builtins. Keeping it that
 * way means a preset row can never fail for a reason the plugin's own dependency
 * graph would have to explain. A filter bug must never eat context, so every
 * step into this listener is guarded and degrades to "keep everything".
 */

/** Cordis plugin name used by loader diagnostics. */
export const name = 'acp-guard'

/**
 * Hand-copy of `ACP_TOOL_CALL_NAME` in src/impl.ts (this preset row is a
 * SEPARATE module instance the Loader mounts without imports). It is the ONE
 * name the plugin gives every ACP tool-call display card; a bare identifier
 * with the plugin-owned prefix that no real host tool may ever occupy.
 */
const ACP_TOOL_CALL_NAME = 'dsh_ntr__acp_tool_call'

/**
 * A fail-closed result. A tools/execute listener that does NOT call `next()`
 * short-circuits execution; an error-shaped value passes `resolveExecution`
 * without the host ever running its own tool with agent-supplied arguments.
 */
function collisionResult(execName) {
  const text = `dsh-ntr: refusing to execute "${execName}" - the reserved ACP tool name "${ACP_TOOL_CALL_NAME}" is occupied by a real host tool`
  return { isError: true, content: [{ type: 'text', text }], text }
}

/** The source kinds a proposed step keeps (see the module header). */
const KEPT_SOURCES = new Set(['user', 'tool'])

/** The shared binding registry's key — hand-copy of `ACP_ROUTE_BINDING_KEY` (src/bridge.ts). */
const BINDING_KEY = Symbol.for('dsh-ntr.acp-binding')

/**
 * The keep-predicate for one proposed step's messages: the allow list, or the
 * configured deny list replacing it. A source-less message is always kept — a
 * hand-built request (tests, headless callers) carries no provenance.
 */
function messageFilterOf(config) {
  const value = config?.strippedSources
  if (value === undefined) {
    return message => {
      const kind = message?.source?.kind
      return typeof kind !== 'string' || KEPT_SOURCES.has(kind)
    }
  }
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) {
    throw new TypeError(`${name}: strippedSources must be an array of source-kind strings`)
  }
  const stripped = new Set(value)
  return message => {
    const kind = message?.source?.kind
    return typeof kind !== 'string' || !stripped.has(kind)
  }
}

/**
 * The adapter model one conversation's next turn runs on, as the plugin
 * recorded it. `undefined` → no rewrite (the harness default plays out).
 */
function boundModelFor(dshSessionId) {
  try {
    const registry = globalThis[BINDING_KEY]
    if (registry === undefined || typeof dshSessionId !== 'string' || dshSessionId === '') return undefined
    const bound = registry.conversations?.get?.(dshSessionId)
    if (typeof bound === 'string' && bound !== '') return bound
    const fallback = registry.defaultModel
    return typeof fallback === 'string' && fallback !== '' ? fallback : undefined
  } catch {
    return undefined
  }
}

/**
 * Whether this host fixes the step's route before `agent/request` and rejects
 * a rewrite there (DSH 0.2.2+). Such hosts expose the recorded selection as
 * `agent.model`; older hosts expose neither member.
 */
function fixesRouteBeforeRequest(agent) {
  return typeof agent?.model?.select === 'function'
}

/**
 * Record the conversation's adapter route as the host's model selection, so
 * `preStep` captures it (see the module header). No-op on hosts without
 * `agent.model` — the `agent/request` rewrite carries those.
 */
function selectBoundRoute(agent) {
  try {
    if (!fixesRouteBeforeRequest(agent)) return
    const sessionId = agent?.session?.id
    const model = boundModelFor(typeof sessionId === 'string' ? sessionId : undefined)
    if (model === undefined) return
    agent.model.select({ provider: 'acp', model })
  } catch {
    // A selection bug must never break the step: the host's route check turns
    // a missing selection into a loud, attributable failure instead.
  }
}

/**
 * The ACP tool call's real output, as the bridge folded it. `undefined` when
 * the call carried no content (the card then shows a plain note).
 */
function toolOutputFor(callId) {
  try {
    if (typeof callId !== 'string' || callId === '') return undefined
    const registry = globalThis[BINDING_KEY]
    const text = registry?.toolResults?.get?.(callId)
    return typeof text === 'string' && text !== '' ? text : undefined
  } catch {
    return undefined
  }
}

/** A tool body's return value: the shared `output.schema` below validates this shape. */
function virtualToolValue(callId) {
  return { text: toolOutputFor(callId) ?? 'This tool call ran inside the ACP agent process; its output lives in the ACP transcript view.' }
}

/** The marker set for definitions this row registered (never shadow a real tool). */
function makeVirtualDefs() {
  return new WeakSet()
}

/**
 * One scoped virtual tool per ACP tool name. Returns the registry definition.
 *
 * The body first answers from the shared registry when the output has already
 * landed, and otherwise parks on `registry.waitForToolOutput` — under the
 * segmented turn shape the loop executes a card while the ACP agent may still
 * be running the tool, and the wait is released by the record itself, by the
 * turn's settlement, or by the bounded timeout (in that order).
 */
function virtualToolDefinition(toolName) {
  return {
    name: toolName,
    description: 'dsh-ntr: display card of a tool the ACP agent already executed in its own process.',
    parameters: { type: 'object', properties: {} },
    output: {
      schema: { type: 'object', properties: {} },
      render: (_arguments, value) => [{ type: 'text', text: String(value?.text ?? '') }],
    },
    execute: async (_arguments, exec) => {
      const callId = typeof exec?.callId === 'string' ? exec.callId : ''
      const registry = globalThis[BINDING_KEY]
      if (toolOutputFor(callId) !== undefined) return virtualToolValue(callId)
      if (typeof registry?.waitForToolOutput === 'function') {
        try {
          const text = await registry.waitForToolOutput(callId, TOOL_OUTPUT_WAIT_MS)
          if (typeof text === 'string' && text !== '') return { text }
        } catch {
          // A waiter failure degrades to the transcript pointer, never to an error.
        }
      }
      return virtualToolValue(callId)
    },
  }
}

/**
 * How long a virtual tool parks on `waitForToolOutput` before answering with
 * the transcript pointer. Generous on purpose: the ACP agent runs the tool on
 * its own clock, and the turn's settlement releases the wait long before this
 * fires in every healthy case — this bound only caps a wedged agent.
 */
const TOOL_OUTPUT_WAIT_MS = 30 * 60 * 1000

/**
 * Register the step gate, the display-card executor, and the route selection
 * for this preset's agent scope.
 * @param ctx - the preset-scoped context the row is mounted under.
 * @param config - optional `strippedSources` override.
 */
export function apply(ctx, config) {
  const keep = messageFilterOf(config)
  const virtualDefs = makeVirtualDefs()
  // Probe ONCE at mount: if the host already has a REAL tool under our reserved
  // name, the plugin's isolation is broken. Record it loudly (console only) and
  // do not continue as if safe; every execution still fails closed below.
  try {
    const globalTools = typeof ctx.get === 'function' ? ctx.get('tools') : undefined
    const occupied = globalTools !== undefined && typeof globalTools.get === 'function'
      ? globalTools.get(ACP_TOOL_CALL_NAME)
      : undefined
    console.warn('[acp-guard] reserved-name mount probe', { reserved: ACP_TOOL_CALL_NAME, occupiedByRealTool: occupied !== undefined })
  } catch (error) {
    console.warn('[acp-guard] reserved-name mount probe threw', { error: String(error) })
  }
  // The route, before DSH 0.2.2's `preStep` captures it: `inbox/inserted` is
  // the synchronous splice that wakes the driver, and `inbox/claimed` fires
  // inside `preStep` just before the capture (the last-second seam, which also
  // covers input queued in a previous process). Both are no-ops on hosts
  // without `agent.model` (see the module header).
  ctx.on('agent/inbox/inserted', ({ agent } = {}) => { selectBoundRoute(agent) })
  ctx.on('agent/inbox/claimed', ({ agent } = {}) => { selectBoundRoute(agent) })
  // Outermost: the harness's own `installModelSelection` appends its "model
  // changed" notice AFTER calling `next()`, so only a prepended gate sees (and
  // strips) it. Inner listeners that add messages run inside this gate too —
  // which is exactly the contract, and exactly why the filter is an allow list:
  // a host-plane row this package has never heard of (issue #10's `dsh-mnemon`)
  // lands here as well. Nothing but the person and the loop's own tool
  // continuity reaches the agent.
  ctx.on('agent/pre-step', async (_payload, next) => {
    // Downstream failures propagate untouched; only this gate's own logic is guarded.
    const decision = await next()
    if (decision.kind === 'reject') return decision
    try {
      if (!Array.isArray(decision.messages)) return decision
      const kept = decision.messages.filter(keep)
      // The one refusal left: a batch carrying neither the person nor a tool
      // result is nothing an ACP turn could be about, and entering it would let
      // the adapter forward the transcript's last user message on a step that
      // was never meant to speak. The allow list cannot produce such a batch —
      // this is the explicit `strippedSources` override's safety net.
      const foreign = kept.length > 0 && !kept.some(message => {
        const kind = message?.source?.kind
        return kind === undefined || kind === 'user' || kind === 'tool'
      })
      if (foreign) return { kind: 'reject' }
      return kept.length === decision.messages.length ? decision : { ...decision, messages: kept }
    } catch {
      // A gate bug must never eat context: degrade to keeping every message.
      return decision
    }
  }, { prepend: true })

  // The display-card executor: answer the loop's execution of an ACP tool card
  // with the call's real output (fourth duty - see the module header).
  ctx.on('tools/execute', async (exec, next) => {
    const execName = (exec !== null && typeof exec === 'object' && typeof exec.name === 'string') ? exec.name : ''
    // ISOLATION GATE. The ONLY name this row owns is the reserved constant:
    // every other tool call passes straight through with one string comparison
    // - no probing, no virtual-tool registration, no fail-closed, no warn.
    // After this line `execName === ACP_TOOL_CALL_NAME` always, so the old
    // non-object / empty-name / `run_code` skip branches are gone.
    if (execName !== ACP_TOOL_CALL_NAME) return next()
    let blocked = null
    let reason = 'virtual tool ready'
    try {
      const tools = typeof ctx.get === 'function' ? ctx.get('tools') : undefined
      if (tools === undefined || typeof tools.get !== 'function' || typeof tools.register !== 'function') {
        reason = 'no usable tools service'
      } else {
        // HARD ASSERTION: the reserved constant name must never be occupied
        // by a REAL host tool. `next()` would let the host's own tool run
        // with agent-supplied arguments in the host process, bypassing this
        // plugin's permission ledger. Fail closed: no register, no next().
        let occupied
        try {
          occupied = tools.get(ACP_TOOL_CALL_NAME, exec.agent)
        } catch (error) {
          console.warn('[acp-guard] tools/execute: reserved-name probe threw; failing closed', { execName, error: String(error) })
          blocked = collisionResult(execName)
        }
        if (blocked === null) {
          console.warn('[acp-guard] tools/execute: reserved-name probe', { execName, occupied: occupied !== undefined })
          if (occupied !== undefined && !virtualDefs.has(occupied)) {
            console.warn('[acp-guard] tools/execute: reserved name occupied by a real host tool; failing closed', { execName, reserved: ACP_TOOL_CALL_NAME })
            blocked = collisionResult(execName)
          }
        }
        if (blocked === null) {
          // The scope-aware lookup mirrors `resolveExecution`: scoped tools
          // shadow globals, and the global view would not see this session's
          // own layer.
          const existing = tools.get(execName, exec.agent)
          console.warn('[acp-guard] tools/execute: before register', { execName, getBeforeRegister: existing !== undefined })
          if (existing !== undefined && !virtualDefs.has(existing)) {
            reason = 'name is a real host tool'
          } else if (existing === undefined) {
            const definition = virtualToolDefinition(execName)
            try {
              tools.register(definition)
              virtualDefs.add(definition)
              console.warn('[acp-guard] tools/execute: registered scoped virtual tool', {
                execName,
                registerThrew: false,
                getAfterRegister: tools.get(execName, exec.agent) !== undefined,
              })
            } catch (error) {
              console.warn('[acp-guard] tools/execute: register threw', {
                execName,
                registerThrew: true,
                error: String(error),
                getAfterRegister: tools.get(execName, exec.agent) !== undefined,
              })
            }
          } else {
            console.warn('[acp-guard] tools/execute: reusing scoped virtual tool', { execName, getAfterRegister: true })
          }
        }
      }
    } catch (error) {
      console.warn('[acp-guard] tools/execute: unexpected failure; delegating', { execName, error: String(error) })
      reason = 'unexpected failure'
    }
    if (blocked !== null) {
      return blocked
    }
    // next() is called EXACTLY ONCE, outside the try: a throwing downstream
    // must never be re-invoked by an outer catch (that would double-execute a
    // card). Its result is still logged for observability.
    console.warn('[acp-guard] tools/execute: delegating', { execName, reason })
    const result = await next()
    console.warn('[acp-guard] tools/execute: next() result', { execName, result })
    return result
  })

  // The legacy route rewrite: DSH 0.2.2+ captures the route before this
  // waterfall and fails the step when it changes, so only hosts without
  // `agent.model` are served here (`selectBoundRoute` carries the others).
  // Outermost on purpose: the harness's own selection rewrite registers
  // before this row, and the outermost waterfall slot is the one whose
  // return value the driver receives, so only it can override the binding.
  ctx.on('agent/request', async (payload, next) => {
    const resolved = await next()
    try {
      if (fixesRouteBeforeRequest(payload?.agent)) {
        // The route is already fixed from the selection; the host compares the
        // proposed effort against that SAME captured selection, so make it
        // agree there — a foreign `agent/request` listener (inner ones run
        // before this outermost slot) may have replaced the seed's effort.
        // The plugin's own selection never carries one (the agent's thought
        // level is its own axis), while an unbound session keeps the
        // deployment selection's effort; both are handled by reading current.
        if (resolved === undefined || typeof resolved !== 'object') return resolved
        let current
        try { current = payload.agent.model.current?.() } catch { current = undefined }
        const effort = current?.reasoningEffort
        if (resolved.reasoningEffort === effort) return resolved
        if (effort === undefined) {
          const { reasoningEffort: _foreign, ...rest } = resolved
          return rest
        }
        return { ...resolved, reasoningEffort: effort }
      }
      const model = boundModelFor(payload?.agent?.session?.id === undefined
        ? undefined
        : String(payload.agent.session.id))
      if (model === undefined) return resolved
      if (resolved === undefined || typeof resolved !== 'object') return resolved
      const { reasoningEffort: _inherited, ...rest } = resolved
      return { ...rest, provider: 'acp', model }
    } catch {
      // A rewrite bug must never break a turn: keep the resolved route.
      return resolved
    }
  }, { prepend: true })
}
