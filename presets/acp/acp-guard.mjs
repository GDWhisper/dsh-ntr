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
 * defence: it removes the injections before they are even committed, so the
 * session's durable transcript shows the conversation and nothing else.
 *
 * STRIPPED SOURCES: `agent-instructions` and `skill-catalog` are the two
 * automatic reminders shipped presets add; `runtime-context` is the host's
 * own snapshot source (the constant is `runtime-context` in `dsh-agent-loop`,
 * NOT `plugin`); every `plugin`-sourced message (notices, relays, recalls) is
 * harness context by construction. `model-selection` is the host's "model
 * changed" notice: it describes the harness route (`acp/<agent>@<choice>`),
 * which this conversation does not expose and must not forward. `user` and
 * `tool` sources are kept: the first is the person, the second is
 * loop-internal continuity this session still needs.
 *
 * NO-USER-INPUT STEPS ARE REJECTED (third duty) — with ONE exception: the
 * continuation steps of this row's OWN display cards. A batch that carries no
 * user-sourced message is the fuel of a host-side CONTINUATION step — the
 * agent loop re-runs whenever the settled assistant message contains
 * `tool-call` blocks, which is exactly what the ACP agent's segmented stream
 * produces (one card-bearing message per tool activity; see
 * docs/acp-convergence.md §1.7). The host "executes" the cards and proposes
 * the next step fed with those results, and the adapter answers that step by
 * resuming the SAME in-flight `session/prompt` from the transcript cursor —
 * never by sending a new one. Forwarding an arbitrary such batch would
 * re-send the person's last words to the ACP agent — the agent runs its OWN
 * loop and must hear a prompt once — so anything whose staged tool results
 * the bridge never saw is refused (`reject` ends the turn). But a batch whose
 * every staged call id sits in the shared registry (`toolResults`) is one of
 * OUR continuation steps and passes. Batches that DO carry user input keep
 * flowing (stripped as configured), and a source-less message counts as user
 * input — the same convention the bridge's forward picker uses, so a
 * hand-assembled batch is never eaten.
 *
 * DISPLAY CARDS EXECUTE AS REAL RESULTS (fourth duty): the card the Chat
 * plane draws IS the execution record, so the call must execute and record a
 * result. With no tool registered it would record `Error: unknown tool
 * "Bash"` (a red pile of errors). The `tools/execute` waterfall is the seam:
 * for a name nothing resolves, this row registers a SCOPED virtual tool (this
 * ctx is the ACP session's agent scope, so the registration shadows nothing
 * outside it) whose body answers with the call's real output — the bridge
 * records every `tool_call` / `tool_call_update` content into the shared
 * registry (`toolResults`, keyed by call id). Under the SEGMENTED turn shape
 * the loop executes a card the moment its segment settles, which is often
 * BEFORE the agent reports the tool's output, so the body first parks on the
 * registry's `waitForToolOutput` (released by the record itself, by the
 * turn's settlement, or by a bounded timeout). A name that resolves to a REAL
 * tool passes untouched; a missing `tools` service degrades to the old
 * error-result behavior.
 *
 * Config:
 *   strippedSources?: string[]  — source kinds to strip (default below; `[]`
 *                                 disables the filter, e.g. to debug what the
 *                                 harness is injecting).
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

/** Source kinds stripped from every proposed step unless configured otherwise. */
const DEFAULT_STRIPPED_SOURCES = ['agent-instructions', 'skill-catalog', 'runtime-context', 'plugin', 'model-selection']

/** The shared binding registry's key — hand-copy of `ACP_ROUTE_BINDING_KEY` (src/bridge.ts). */
const BINDING_KEY = Symbol.for('dsh-ntr.acp-binding')

/** Read and validate the `strippedSources` list. */
function strippedSourcesOf(config) {
  const value = config?.strippedSources
  if (value === undefined) return new Set(DEFAULT_STRIPPED_SOURCES)
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) {
    throw new TypeError(`${name}: strippedSources must be an array of source-kind strings`)
  }
  return new Set(value)
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

/**
 * Whether the bridge saw this call id in the ACP update stream — the marker
 * that a staged tool result belongs to this row's own continuation steps (and
 * not to some foreign continuation this gate must refuse).
 */
function registryHasToolCall(callId) {
  try {
    if (typeof callId !== 'string' || callId === '') return false
    const registry = globalThis[BINDING_KEY]
    return registry?.toolResults?.has?.(callId) === true
  } catch {
    return false
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
  const stripped = strippedSourcesOf(config)
  const virtualDefs = makeVirtualDefs()
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
  // which is exactly the contract: nothing but the person reaches the agent.
  ctx.on('agent/pre-step', async (_payload, next) => {
    // Downstream failures propagate untouched; only this gate's own logic is guarded.
    const decision = await next()
    if (decision.kind === 'reject') return decision
    try {
      if (!Array.isArray(decision.messages)) return decision
      let kept = decision.messages
      if (stripped.size > 0) {
        const filtered = kept.filter(message => {
          const kind = message?.source?.kind
          return typeof kind !== 'string' || !stripped.has(kind)
        })
        if (filtered.length !== kept.length) kept = filtered
      }
      // The ONE legal no-user step: the continuation of this row's own display
      // cards. Every message left after stripping is a staged tool result whose
      // call id the bridge recorded; the adapter answers that step by resuming
      // the same in-flight ACP prompt (see the module header). Anything else
      // with no user input still rejects — forwarding it would re-send the
      // person's last words to the agent. An EMPTY batch keeps the plain enter:
      // the loop ends a first step with no messages as a completed no-op (the
      // injected-wake path). The accepted batch is the FILTERED one: harness
      // injections are stripped, so the adapter sees the tool results alone.
      const isOwnToolContinuation = kept.length > 0 && kept.every(message => {
        if (message?.source?.kind !== 'tool') return false
        const callId = message?.source?.callId ?? message?.toolCallId
        return registryHasToolCall(typeof callId === 'string' ? callId : '')
      })
      if (isOwnToolContinuation) {
        return kept === decision.messages ? decision : { ...decision, messages: kept }
      }
      const hasUserInput = kept.some(message => {
        const kind = message?.source?.kind
        return kind === undefined || kind === 'user'
      })
      if (kept.length > 0 && !hasUserInput) return { kind: 'reject' }
      return kept === decision.messages ? decision : { ...decision, messages: kept }
    } catch {
      // A gate bug must never eat context: degrade to keeping every message.
      return decision
    }
  }, { prepend: true })

  // The display-card executor: answer the loop's execution of an ACP tool card
  // with the call's real output (fourth duty — see the module header).
  ctx.on('tools/execute', async (exec, next) => {
    try {
      if (exec === null || typeof exec !== 'object') return next()
      if (typeof exec.name !== 'string' || exec.name === '' || exec.name === 'run_code') return next()
      const tools = typeof ctx.get === 'function' ? ctx.get('tools') : undefined
      if (tools === undefined || typeof tools.get !== 'function' || typeof tools.register !== 'function') return next()
      // The scope-aware lookup mirrors `resolveExecution`: scoped tools shadow
      // globals, and the global view would not see this session's own layer.
      const existing = tools.get(exec.name, exec.agent)
      if (existing !== undefined && !virtualDefs.has(existing)) return next()
      if (existing === undefined) {
        const definition = virtualToolDefinition(exec.name)
        tools.register(definition)
        virtualDefs.add(definition)
      }
      return next()
    } catch {
      // Registration is an upgrade, not a dependency: the old error-result
      // behavior (and the pre-step gate) still bounds the damage.
      return next()
    }
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
