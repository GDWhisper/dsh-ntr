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
 * automatic reminders shipped presets add; every `plugin`-sourced message
 * (runtime-context snapshots, notices, relays, recalls) is harness context by
 * construction. `user` and `tool` sources are kept: the first is the person,
 * the second is loop-internal continuity this session still needs.
 *
 * Config:
 *   strippedSources?: string[]  — source kinds to strip (default below; `[]`
 *                                 disables the filter, e.g. to debug what the
 *                                 harness is injecting).
 *
 * ROUTE REWRITE (second duty): the host driver resolves each turn's route as
 * "pending selection → last request header → deployment default", and a plugin
 * cannot append a selection. A session that has never run an ACP turn therefore
 * resolves to the deployment default (a provider this conversation cannot use),
 * and one that has replays its previous `acp/<agent>` header even after the
 * user switched agents in the composer. The driver exposes exactly one seam for
 * this: the `agent/request` waterfall. This row registers a listener that
 * rewrites the resolved config to the plugin's conversation→agent binding
 * (`dsh-ntr` records it on bind, on model switch, and when a session
 * materializes; the plugin's default agent answers conversations nobody bound).
 *
 * The listener is registered with `{ prepend: true }`: waterfall listeners run
 * outermost-first, and the harness's own `installModelSelection` rewrite (which
 * re-applies `selectionFor(agent).current` — the deployment default for a
 * session with no selection history) is registered BEFORE this row mounts, so
 * only the outermost slot lets the binding win. The rewrite drops the resolved
 * `reasoningEffort`: it belongs to whatever route the seed named, while the
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
const DEFAULT_STRIPPED_SOURCES = ['agent-instructions', 'skill-catalog', 'plugin']

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
 * Register the strip filter and the route rewrite for this preset's agent scope.
 * @param ctx - the preset-scoped context the row is mounted under.
 * @param config - optional `strippedSources` override.
 */
export function apply(ctx, config) {
  const stripped = strippedSourcesOf(config)
  if (stripped.size > 0) {
    ctx.on('agent/pre-step', async (_payload, next) => {
      // Downstream failures propagate untouched; only this filter's own logic is guarded.
      const decision = await next()
      if (decision.kind === 'reject') return decision
      try {
        if (!Array.isArray(decision.messages)) return decision
        const kept = decision.messages.filter(message => {
          const kind = message?.source?.kind
          return typeof kind !== 'string' || !stripped.has(kind)
        })
        return kept.length === decision.messages.length ? decision : { ...decision, messages: kept }
      } catch {
        // A filter bug must never eat context: degrade to keeping every message.
        return decision
      }
    })
  }

  // The route rewrite: outermost on purpose — see the module header for why
  // `prepend` is load-bearing (the harness's own selection rewrite registers
  // first, and outermost runs last, so its value is what the driver sees).
  ctx.on('agent/request', async (payload, next) => {
    const resolved = await next()
    try {
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
