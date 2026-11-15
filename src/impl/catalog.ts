/**
 * Model catalog parsing of ACP `configOptions`.
 *
 * Slots are assigned by `configId` first and category second, and a per-session answer folds back as shape only — never as another conversation's current value.
 *
 * Part of the host-half logic; the barrel is `src/impl.ts` and every existing
 * `../impl.ts` import keeps resolving through it. Pure logic only — no Node
 * APIs, no ACP SDK runtime values.
 */

import type { AcpAgentCatalog, AcpCatalogOption } from '../protocol.ts'

// ---- Model catalog (pure parsing of ACP `configOptions`) ----

/**
 * ACP categories are free-form UX hints, not identity. Qoder CN tags
 * `reasoning_effort` as `category: 'model'` (the spec means `thought_level`),
 * and nothing stops an agent from reusing a category for several options.
 * Slots are therefore assigned by `configId` first and category second, and a
 * same-category option NEVER replaces another option's slot: whatever loses
 * stays reachable through `extras` instead of silently becoming the model list.
 */
const EFFORT_OPTION_HINT = /effort|thinking|thought|reason/i

function isModelSelector(configId: string, name: string): boolean {
  return configId === 'model' || name.trim().toLowerCase() === 'model'
}

type CatalogSlot = 'model' | 'thought' | 'mode'

interface CatalogSlotCandidate {
  slot: CatalogSlot
  rank: number
  option: AcpCatalogOption
}

function catalogSlotFor(category: string | undefined, configId: string, name: string): Omit<CatalogSlotCandidate, 'option'> | undefined {
  const effortish = EFFORT_OPTION_HINT.test(configId) || EFFORT_OPTION_HINT.test(name)
  if (category === 'model') {
    // The option explicitly named `model` is the selector even when other
    // model-scoped options are present.
    if (isModelSelector(configId, name)) return { slot: 'model', rank: 3 }
    // A model-scoped effort is mislabelled, not a model: route it to the
    // thought chip when no real `thought_level` option is published.
    if (effortish) return { slot: 'thought', rank: 1 }
    // An unknown model-scoped select: a last-resort selector only.
    return { slot: 'model', rank: 1 }
  }
  if (category === 'thought_level') return { slot: 'thought', rank: 3 }
  if (category === 'mode') return { slot: 'mode', rank: 2 }
  // `model_config` is where the spec puts model-dependent knobs (effort,
  // context size); only the effort-shaped ones have a dedicated control.
  if (category === 'model_config' && effortish) return { slot: 'thought', rank: 1 }
  return undefined
}

/**
 * Extract select options from a raw ACP `configOptions` payload.
 *
 * `model`, `thought_level` and `mode` get dedicated slots. Every OTHER select
 * with at least one choice lands in `extras` (deduped by `configId`, last
 * definition wins) — that is what the composer's advanced base lists and sets.
 * Tolerant by design: unknown categories, boolean options, grouped choices,
 * missing `name`, and the legacy `id` field (pre-spec agents) are all handled;
 * anything unusable is skipped silently.
 */
export function parseCatalogOptions(configOptions: unknown): AcpAgentCatalog {
  const out: AcpAgentCatalog = {}
  if (!Array.isArray(configOptions)) return out
  const definitions: AcpCatalogOption[] = []
  const candidates: CatalogSlotCandidate[] = []
  for (const raw of configOptions) {
    if (typeof raw !== 'object' || raw === null) continue
    const row = raw as Record<string, unknown>
    const category = typeof row.category === 'string' ? row.category : undefined
    const configIdRaw = row.configId ?? row.id
    if (typeof configIdRaw !== 'string' && typeof configIdRaw !== 'number') continue
    const configId = String(configIdRaw)
    if (configId === '') continue
    const choices: NonNullable<AcpAgentCatalog['model']>['choices'] = []
    collectCatalogChoices(row.options, choices)
    const name = typeof row.name === 'string' && row.name !== '' ? row.name : configId
    // A boolean toggle has no `options` at all; its current value is a JSON
    // boolean. It is encoded as 'true' / 'false' so the catalog stays
    // string-typed for every existing reader, and carries `kind` so the
    // composer renders a checkbox instead of a select.
    const booleanKind = row.type === 'boolean'
      || (typeof row.currentValue === 'boolean' && choices.length === 0)
    const option: AcpCatalogOption = {
      configId,
      name,
      ...(booleanKind ? { kind: 'boolean' as const } : {}),
      currentValue: booleanKind
        ? row.currentValue === true || row.currentValue === 'true'
          ? 'true'
          : row.currentValue === false || row.currentValue === 'false' ? 'false' : null
        : typeof row.currentValue === 'string' && row.currentValue !== '' ? row.currentValue : null,
      choices,
    }
    definitions.push(option)
    // A toggle is never a model / thought / mode SELECT: those controls pick
    // among choices. It belongs to the advanced base, where it is a checkbox.
    if (booleanKind) continue
    const slot = catalogSlotFor(category, configId, name)
    if (slot !== undefined) candidates.push({ ...slot, option })
  }
  const winnerIds = new Set<string>()
  for (const slot of ['model', 'thought', 'mode'] as const) {
    let winner: CatalogSlotCandidate | undefined
    for (const candidate of candidates) {
      if (candidate.slot !== slot) continue
      if (winner === undefined || candidate.rank > winner.rank) {
        winner = candidate
      } else if (candidate.rank === winner.rank && candidate.option.configId === winner.option.configId) {
        // The same option redefined later in one answer: the last definition
        // is the current one.
        winner = candidate
      }
    }
    if (winner === undefined) continue
    out[slot] = winner.option
    winnerIds.add(winner.option.configId)
  }
  // Choice-less options have nothing to pick; they would render an empty
  // section in the advanced menu, so they stay out of the catalog entirely —
  // except a boolean, whose whole point is that it has no choices. Anything
  // that lost a slot race is still a real, settable option: keep it here.
  const extras = new Map<string, AcpCatalogOption>()
  for (const option of definitions) {
    if (winnerIds.has(option.configId)) continue
    if (option.choices.length > 0 || option.kind === 'boolean') extras.set(option.configId, option)
  }
  if (extras.size > 0) out.extras = [...extras.values()]
  return out
}

/**
 * Whether a payload names ONE model selector without relying on category
 * alone. When an agent publishes several `category: 'model'` options and none
 * is explicitly the `model` id, the category is not trustworthy enough to
 * reject the user's pick — callers must fail open instead of reporting
 * `model_unavailable`.
 */
export function hasUnambiguousModelSelector(configOptions: unknown): boolean {
  if (!Array.isArray(configOptions)) return true
  let scoped = 0
  let explicit = false
  for (const raw of configOptions) {
    if (typeof raw !== 'object' || raw === null) continue
    const row = raw as Record<string, unknown>
    if (row.category !== 'model') continue
    const configIdRaw = row.configId ?? row.id
    if (typeof configIdRaw !== 'string' && typeof configIdRaw !== 'number') continue
    const configId = String(configIdRaw)
    if (configId === '') continue
    scoped += 1
    const name = typeof row.name === 'string' ? row.name : ''
    if (isModelSelector(configId, name)) explicit = true
  }
  return explicit || scoped <= 1
}

/**
 * Fold one per-session option answer's SHAPE into an agent-level catalog.
 *
 * `session/set_config_option` answers are often the ONLY place an agent
 * publishes how its option set changes with the model — opencode offers
 * `thought_level` (`effort`) just for models with variants and never
 * re-notifies after a client-driven set — and the composer's thought chip is
 * driven by the agent-level catalog. What is agent knowledge there is the
 * SHAPE (which slots exist, which choices they offer); `currentValue` is not:
 * in a per-session answer it is that session's pick, and promoting it would
 * turn one conversation's choice into `reasoning.defaultEffort` for every
 * other one. A merged slot therefore keeps the catalog's known current value
 * while the observed choices still offer it, and `null` ("the agent's own
 * default") otherwise. Slots the answer does not mention are left alone — a
 * different model may still offer them.
 */
export function mergeCatalogShape(existing: AcpAgentCatalog | undefined, observed: AcpAgentCatalog): AcpAgentCatalog {
  const out: AcpAgentCatalog = {}
  const merge = (prev: AcpCatalogOption | undefined, next: AcpCatalogOption): AcpCatalogOption => {
    const kept = prev?.currentValue ?? null
    return {
      configId: next.configId,
      name: next.name,
      ...(next.kind === 'boolean' ? { kind: 'boolean' as const } : {}),
      // A boolean has no choices to test `kept` against; it keeps the
      // catalog's known default like any other slot (the answer's value is
      // still one session's truth, not the agent's).
      currentValue: kept !== null && (next.choices.length === 0 || next.choices.some(choice => choice.value === kept)) ? kept : null,
      choices: next.choices,
    }
  }
  for (const slot of ['model', 'thought', 'mode'] as const) {
    const prev = existing?.[slot]
    const next = observed[slot]
    if (next === undefined) {
      if (prev !== undefined) out[slot] = prev
      continue
    }
    out[slot] = merge(prev, next)
  }
  // Extras merge by configId: observed entries refresh their shape, entries
  // only the earlier answer knew survive (another model may still offer them).
  const extras = new Map<string, AcpCatalogOption>()
  for (const option of existing?.extras ?? []) extras.set(option.configId, option)
  for (const option of observed.extras ?? []) extras.set(option.configId, merge(extras.get(option.configId), option))
  if (extras.size > 0) out.extras = [...extras.values()]
  return out
}

/**
 * Size ceiling for one `configOptions` answer to be believed. Normal answers
 * are a few KB (a 500-model catalog is well under this); beyond it the agent is
 * misbehaving and absorbing/persisting it would turn every notification into
 * an unbounded write.
 */
export const MAX_CONFIG_OPTIONS_BYTES = 1 << 20

/**
 * Whether a `configOptions` answer may overwrite known state.
 *
 * An EMPTY (or absent) answer is a non-answer: observed agents return
 * `configOptions: []` in intermediate states, and treating that as "this agent
 * now has no options" would wipe a perfectly good catalog and session
 * snapshot for a state that passes (the rule OmniTerm settles on for the same
 * observation — empty sets never overwrite the last known state). Oversized
 * answers are dropped for the same reason: see {@link MAX_CONFIG_OPTIONS_BYTES}.
 */
export function usableConfigOptions(configOptions: unknown): configOptions is unknown[] {
  if (!Array.isArray(configOptions) || configOptions.length === 0) return false
  return JSON.stringify(configOptions).length <= MAX_CONFIG_OPTIONS_BYTES
}

/** Flatten select `options` (plain values or `SessionConfigSelectGroup`s) into choices, deduped by value. */
function collectCatalogChoices(options: unknown, out: NonNullable<AcpAgentCatalog['model']>['choices']): void {
  if (!Array.isArray(options)) return
  for (const raw of options) {
    if (typeof raw !== 'object' || raw === null) continue
    const row = raw as Record<string, unknown>
    if (Array.isArray(row.options)) {
      // Grouped form: flatten the inner values, borrowing the group label as fallback description.
      for (const inner of row.options) {
        if (typeof inner !== 'object' || inner === null) continue
        pushCatalogChoice(inner as Record<string, unknown>, out, typeof row.name === 'string' ? row.name : undefined)
      }
      continue
    }
    pushCatalogChoice(row, out)
  }
}

function pushCatalogChoice(row: Record<string, unknown>, out: NonNullable<AcpAgentCatalog['model']>['choices'], groupLabel?: string): void {
  const value = row.value
  if (typeof value !== 'string' || value === '') return
  if (out.some(c => c.value === value)) return
  const description = typeof row.description === 'string' && row.description !== '' ? row.description : groupLabel
  out.push({
    value,
    name: typeof row.name === 'string' && row.name !== '' ? row.name : value,
    ...(description !== undefined ? { description } : {}),
    // The group label is kept on its own field (commonly the vendor) so the
    // settings panel can filter by it even when the choice has its own text.
    // Only real ACP `SessionConfigSelectGroup` labels land here — no guessing:
    // any vendor may serve another vendor's models, so synthesizing buckets
    // from name prefixes or value paths would misclassify.
    ...(groupLabel !== undefined ? { group: groupLabel } : {}),
  })
}

/**
 * Split an adapter model id into its agent id and optional model choice.
 * `@` is the separator because agent ids are restricted to `[a-z0-9._-]`.
 */
export function splitAdapterModelId(model: string): { agentId: string; choice?: string } {
  const at = model.indexOf('@')
  if (at <= 0) return { agentId: model }
  return { agentId: model.slice(0, at), choice: model.slice(at + 1) }
}

/** Inverse of {@link splitAdapterModelId} for variant entries. */
export function buildAdapterModelId(agentId: string, choice: string): string {
  return `${agentId}@${choice}`
}
