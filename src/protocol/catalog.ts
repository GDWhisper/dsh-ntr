/**
 * Model catalog: the per-agent ACP `configOptions` view the plugin's own seats read.
 *
 * Part of the protocol contract; the barrel is `src/protocol.ts` and every
 * existing `../protocol.ts` import keeps resolving through it. Pure types,
 * constants and pure helpers only — no side effects, no Node APIs, no ACP SDK
 * runtime values (type-only SDK imports are erased at build time).
 */

import type { LlmModelReasoningInfo } from './llm.ts'
import type { SessionView } from './views.ts'

// ---- Model catalog (host-side cache of ACP `configOptions`) ----

/** One selectable value of a `model` / `thought_level` config option. */
export interface AcpCatalogChoice {
  value: string
  name: string
  description?: string
  /**
   * Label of the `SessionConfigSelectGroup` this choice arrived under
   * (commonly the vendor); absent when the agent ships a flat option list.
   * Deliberately never guessed from name/value — vendors cross-list models,
   * so only the agent's own grouping is trustworthy.
   */
  group?: string
}

/** A parsed `category: model | thought_level` select option for one agent. */
export interface AcpCatalogOption {
  configId: string
  name: string
  /**
   * `'boolean'` for an on/off toggle: `currentValue` is the string `'true'` /
   * `'false'` (the catalog stays string-typed so every existing reader keeps
   * working) and `choices` is empty. Absent means the ordinary select.
   */
  kind?: 'boolean'
  /** Currently selected value at parse time (may be absent from `choices`). */
  currentValue: string | null
  choices: AcpCatalogChoice[]
}

/**
 * The per-category catalog derived from one agent's `configOptions`.
 *
 * `mode` duplicates `session/new`'s `modes` on the agents observed so far,
 * but it is the only copy a conversation can read BEFORE it has a live
 * session — the window in which the composer must still show the control.
 *
 * `extras` are the remaining select options (temperature, `model_config`,
 * anything unknown); they ride the "advanced" base, which is what lets a
 * session-less conversation show and set them.
 */
export interface AcpAgentCatalog {
  model?: AcpCatalogOption
  thought?: AcpCatalogOption
  mode?: AcpCatalogOption
  extras?: AcpCatalogOption[]
  /**
   * The `thought` slot each MODEL was observed with, keyed by the choice
   * value; `null` = observed without the slot (opencode only publishes
   * `effort` for models with variants). Absent key = never observed.
   */
  thoughtByModel?: Record<string, AcpCatalogOption | null>
}

/** Result of `agent/probe-models`: the freshly probed (or cached) catalog. */
export interface AgentProbeModelsResult {
  agentId: string
  catalog: AcpAgentCatalog
  updatedAt: number
}

/** One of the agent's extra select options, shaped for the composer's advanced menu. */
export interface AgentCatalogExtraOption {
  configId: string
  /** The agent's own option name (falls back to the config id host-side). */
  name: string
  /**
   * `'boolean'` for an on/off toggle (`currentValue` is `'true'` / `'false'`,
   * `choices` is empty and the composer renders a checkbox row). Absent means
   * the ordinary select. Kept optional so cached catalogs written before
   * toggles existed still read.
   */
  kind?: 'boolean'
  /** The value the agent reports as current, when it reports one. */
  currentValue?: string
  choices: Array<{ id: string; name: string; description?: string }>
}

/**
 * Result of `agent/catalog`: the ACP model surface for ONE agent.
 *
 * THIS IS THE ONLY PLACE ACP MODELS EXIST. DSH builds its provider/model
 * catalog per *request*, not per session — `buildModelCatalog(ctx)` takes no
 * session id, so every session's model directory is that same global list. A
 * provider that advertises models therefore advertises them to every
 * conversation, including the ones where the external agent has no tool
 * registration, no runtime context and is not the model talking at all. The
 * `acp` route consequently advertises nothing (`LlmAdapter.listModels` is
 * advisory — exact ids still resolve and stream), and the plugin's own seats
 * read this per-agent view instead. There is no per-session seam on the host
 * to filter the global catalog with, so "advertise nothing" is the only
 * structurally honest isolation.
 *
 * Read-only and memory-only: it never spawns and never starts a probe, not
 * even for an agent with no cached catalog — that case is reported honestly
 * (`probed: false`, `base` entry only). A catalog fills only from a gesture:
 * the agent's own `session/new` / `session/load`, the settings card's
 * `agent/probe-models` button, or an on-disk cache. (Boot-time probing used
 * to exist and no longer does — see `BridgeManager.bootstrapCatalogs`.)
 */
export interface AgentCatalogResult {
  agentId: string
  /** Agent display name (`title` ?? id). */
  title: string
  /**
   * The bare-`agentId` entry: the route that means "let the agent choose its own
   * model". Its `name` spells out the model that route CURRENTLY resolves to
   * (`<agent> · <model>`) — the bare route is not a model, so naming it after the
   * agent alone left the checked row in the picker saying nothing about which
   * model was in force.
   */
  base: { id: string; name: string; description?: string }
  /**
   * The `agentId@choice` variants this agent exposes (`exposedModels` applied).
   * An UNSET filter is the default-open state, so this carries every published
   * choice then; an explicit array — including `[]` — is the user's narrowing.
   */
  variants: Array<{ id: string; name: string; description?: string }>
  /**
   * The agent-level `thought_level` slot: the last observed model's levels,
   * including its `defaultEffort`. Per-model answers ride `reasoningByModel`.
   */
  reasoning?: LlmModelReasoningInfo
  /**
   * The levels each MODEL was observed with, keyed by the choice value.
   * `{ efforts: [] }` = observed without the axis; absent = never observed
   * (that model must not borrow another model's levels).
   */
  reasoningByModel?: Record<string, LlmModelReasoningInfo>
  /**
   * The model the agent itself reports as selected (`model.currentValue`).
   *
   * Without it the model chip has no label for a conversation that has not
   * picked one and does not render at all; its absence means the agent
   * publishes no `category: 'model'` select. Unlike `base` (a ROUTE, the bare
   * `agentId`), this is a MODEL VALUE: the picker needs both to name the route
   * and to mark the row in force.
   */
  currentModel?: { value: string; name: string; description?: string }
  /**
   * The agent's own MODE options (`category: 'mode'`, e.g. codebuddy's
   * `Always Ask` … `Bypass Permissions`).
   *
   * The live composer select reads the `modes` field of `session/new` /
   * `session/load`; this copy exists for the window before one exists. It is
   * the same list on every agent observed so far (omp, codebuddy), and it is
   * the only source a conversation set up ahead of its first message has.
   */
  mode?: {
    /** The agent's current mode id, when it reports one. */
    currentValue?: string
    choices: Array<{ id: string; name: string; description?: string }>
  }
  /**
   * The agent's remaining select options — everything that is not the model,
   * the thought level, or the mode. Empty/absent means the composer shows no
   * advanced base.
   */
  extras?: AgentCatalogExtraOption[]
  /**
   * The slash commands this agent declared in its most recent session
   * (`available_commands_update`), cached per agent.
   *
   * A live session reports its own list through `session/chat-list`, and that
   * one always wins. This copy exists for the window BEFORE a conversation has
   * an ACP session: typing `/` in a fresh NTR conversation must list the
   * agent's commands, the way the native menu lists DSH's — waiting for the
   * first message to discover them is what makes the menu look empty.
   */
  commands?: SessionView['availableCommands']
  /** When those commands were last observed. */
  commandsUpdatedAt?: number
  /** A probe has produced a catalog for this agent (`false` → base entry only). */
  probed: boolean
  /** When the cached catalog was last refreshed. */
  updatedAt?: number
}

/**
 * The model values the ACP seats offer for one agent.
 *
 * Unset `exposedModels` is the DEFAULT-OPEN state: every model the agent
 * publishes is offered, so a freshly configured agent's chip menu works on
 * first use. An explicit array — including the empty one — is the user's
 * narrowing (empty = only the base / currently-in-force row). Host and
 * settings card must agree on this one rule, so it lives here.
 */
export function effectiveExposedModels(
  exposedModels: readonly string[] | undefined,
  catalogValues: readonly string[],
): string[] {
  return exposedModels === undefined ? [...catalogValues] : [...exposedModels]
}
