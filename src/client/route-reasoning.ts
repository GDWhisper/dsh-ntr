/**
 * Which thought levels ONE model publishes, resolved from the agent catalog.
 *
 * `AgentCatalogResult.reasoning` is the agent-level snapshot — the option set
 * the agent was last observed with. That set is model-dependent on some agents
 * (opencode publishes `effort` only for models with variants), so the catalog
 * also carries per-model observations. This module is the single read rule for
 * the composer and the optimistic pick mirror, so the two cannot disagree
 * about which levels a conversation's selected model offers.
 *
 * Pure: no store, no clock, no I/O.
 */
import type { AgentCatalogResult, LlmModelReasoningInfo } from '../protocol.ts'

/**
 * The levels `modelValue` publishes, `undefined` when that is unknown.
 *
 * 1. No model picked (bare route / the agent's own choice): the agent-level
 *    slot IS the default model's vocabulary, including its `defaultEffort`.
 * 2. The picked model is the one the catalog names: same answer, same reason.
 * 3. Another model with a recorded observation: that record, even an empty one
 *    (`{ efforts: [] }` means the model was observed WITHOUT a level axis).
 * 4. A catalog from an older host that names no current model: its slot is the
 *    only vocabulary there is.
 * 5. Otherwise unknown. Another model's levels must not be shown as this one's.
 */
export function reasoningForModel(
  catalog: AgentCatalogResult | undefined,
  modelValue: string | undefined,
): LlmModelReasoningInfo | undefined {
  if (catalog === undefined) return undefined
  const current = catalog.currentModel?.value
  if (modelValue === undefined || (current !== undefined && current === modelValue)) return catalog.reasoning
  if (catalog.reasoningByModel !== undefined
    && Object.prototype.hasOwnProperty.call(catalog.reasoningByModel, modelValue)) {
    return catalog.reasoningByModel[modelValue]
  }
  if (catalog.reasoningByModel === undefined && current === undefined) return catalog.reasoning
  return undefined
}

/**
 * Whether `effort` may survive a switch to `modelValue`: true only when that
 * model's own levels are known and include it. Unknown counts as "no" — the
 * host clears the pick in the same situation, and keeping the old level here
 * would name a value the new model may not offer.
 */
export function modelOffersEffort(
  catalog: AgentCatalogResult | undefined,
  modelValue: string | undefined,
  effort: string | undefined,
): boolean {
  if (effort === undefined) return false
  return reasoningForModel(catalog, modelValue)?.efforts.some(level => level.id === effort) ?? false
}

/** The choice half of an adapter model id (`agentId@choice`), or `undefined`. */
export function modelValueOf(adapterModelId: string | undefined): string | undefined {
  if (adapterModelId === undefined) return undefined
  const at = adapterModelId.indexOf('@')
  if (at <= 0) return undefined
  const value = adapterModelId.slice(at + 1)
  return value === '' ? undefined : value
}

/**
 * Whether `modelValue`'s levels are UNKNOWN (never observed) rather than
 * "observed without the axis".
 *
 * `reasoningForModel` answers `undefined` in both cases; only the per-model map
 * can tell them apart, and the composer must not offer a fetch for a model it
 * already knows publishes no levels. `false` also covers "no catalog / no model
 * to name" and the catalog's OWN current model, whose agent-level slot is its
 * answer — an absent slot there means "no axis", not "unknown".
 */
export function thoughtLevelsUnknown(
  catalog: AgentCatalogResult | undefined,
  modelValue: string | undefined,
): boolean {
  if (catalog === undefined || modelValue === undefined || reasoningForModel(catalog, modelValue) !== undefined) return false
  if (Object.prototype.hasOwnProperty.call(catalog.reasoningByModel ?? {}, modelValue)) return false
  return catalog.currentModel?.value !== modelValue
}
