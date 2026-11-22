/**
 * Pure choice planning for the NATIVE acp_delegate activation's four-axis
 * customization (AGENTS.md constraint 40; AGENTS/state.md §1).
 *
 * Value chain per axis: explicit tool argument > configured per-agent default
 * > unset (the agent process's own default decides). "Stale" means ONLY that
 * the live session/new answer no longer offers the value — the catalog is a
 * UI option source, never the validation authority. Fallback rules:
 * - a stale CONFIGURED value degrades silently to "unset" plus one note;
 * - a stale EXPLICIT agent/model/mode is fatal immediately;
 * - effort is NEVER fatal: a stale explicit level is soft-dropped with a note.
 * Stale persisted values are kept and marked by the caller, never deleted.
 *
 * `planDelegateModeAndModel` plans mode first, then model (a model write can
 * change which efforts exist). `planDelegateEffort` is separate: the caller
 * invokes it AFTER the model write, against the REFRESHED live options.
 * A present `fatal` means the caller must surface it and apply NOTHING —
 * `writes` is then empty. Notes are one Chinese line each, wording pinned by
 * tests/impl/delegate-choices.spec.ts.
 *
 * Pure logic only — no Node APIs, no SDK; reuses impl/catalog.ts parsing.
 */

import { parseCatalogOptions } from './catalog.ts'

/** The three choice axes; an absent key means "not requested on this axis". */
export interface DelegateChoiceSet {
  model?: string
  effort?: string
  mode?: string
}

/**
 * The LIVE session/new answer — the only validation authority. `modes` is the
 * session mode list; `configOptions` is the raw ACP config-option payload the
 * catalog parser understands.
 */
export interface DelegateLiveOptions {
  configOptions?: unknown
  modes?: { availableModes: Array<{ id: string }> }
}

/** One planned write: a session mode switch or a config-option set. */
export type DelegateChoiceWrite =
  | { kind: 'mode'; modeId: string }
  | { kind: 'config'; configId: string; value: string }

/**
 * Plan the mode and model axes, in that order. Each axis takes
 * `explicit ?? configured`; neither present = the axis is skipped entirely.
 * Mode: no live mode list = "not published"; a value outside the list is
 * stale. Model: the parsed `model` selector with ZERO choices accepts any
 * free value; otherwise the value must be listed. Explicit + stale (or not
 * published) → fatal; configured + stale → skip with a note.
 */
export function planDelegateModeAndModel(opts: {
  agentId: string
  explicit: DelegateChoiceSet
  configured: DelegateChoiceSet
  live: DelegateLiveOptions
}): { writes: DelegateChoiceWrite[]; notes: string[]; fatal?: string } {
  const { agentId, explicit, configured, live } = opts
  const writes: DelegateChoiceWrite[] = []
  const notes: string[] = []

  // ---- mode axis (first) ----
  const mode = explicit.mode ?? configured.mode
  if (mode !== undefined) {
    const available = live.modes?.availableModes ?? []
    if (available.length === 0) {
      if (explicit.mode !== undefined) {
        return { writes: [], notes, fatal: `acp_delegate: agent "${agentId}" does not publish mode selection` }
      }
      notes.push(`agent「${agentId}」未提供默认模式「${mode}」，本次使用启动模式`)
    } else if (!available.some(entry => entry.id === mode)) {
      if (explicit.mode !== undefined) {
        return { writes: [], notes, fatal: `acp_delegate: agent "${agentId}" does not offer mode "${mode}" (available: ${available.map(entry => entry.id).join(', ')})` }
      }
      notes.push(`agent「${agentId}」不再提供默认模式「${mode}」，本次使用启动模式`)
    } else {
      writes.push({ kind: 'mode', modeId: mode })
    }
  }

  // ---- model axis (second) ----
  const model = explicit.model ?? configured.model
  if (model !== undefined) {
    const selector = parseCatalogOptions(live.configOptions).model
    if (selector === undefined) {
      if (explicit.model !== undefined) {
        return { writes: [], notes, fatal: `acp_delegate: agent "${agentId}" does not publish model selection` }
      }
      notes.push(`agent「${agentId}」未提供默认模型「${model}」，本次使用 agent 自身默认模型`)
    } else if (selector.choices.length > 0 && !selector.choices.some(choice => choice.value === model)) {
      if (explicit.model !== undefined) {
        return { writes: [], notes, fatal: `acp_delegate: agent "${agentId}" does not offer model "${model}" (available: ${selector.choices.map(choice => choice.value).join(', ')})` }
      }
      notes.push(`agent「${agentId}」不再提供默认模型「${model}」，本次使用 agent 自身默认模型`)
    } else {
      writes.push({ kind: 'config', configId: selector.configId, value: model })
    }
  }

  return { writes, notes }
}

/**
 * Plan the effort axis against the (post-model-write, refreshed) live options.
 * NEVER fatal: an explicit level the current model does not support is
 * soft-dropped with a note; a stale configured level is skipped with a note.
 * The `thought` selector with zero choices accepts any free value, exactly
 * like the model selector.
 */
export function planDelegateEffort(opts: {
  agentId: string
  explicit: DelegateChoiceSet
  configured: DelegateChoiceSet
  live: DelegateLiveOptions
}): { write?: DelegateChoiceWrite; notes: string[] } {
  const { agentId, explicit, configured, live } = opts
  const notes: string[] = []
  const effort = explicit.effort ?? configured.effort
  if (effort === undefined) return { notes }
  const selector = parseCatalogOptions(live.configOptions).thought
  if (selector === undefined || (selector.choices.length > 0 && !selector.choices.some(choice => choice.value === effort))) {
    notes.push(explicit.effort !== undefined
      ? `思考等级「${effort}」不受当前模型支持，已丢弃`
      : `agent「${agentId}」的默认思考等级「${effort}」不受当前模型支持，本次不设置`)
    return { notes }
  }
  return { write: { kind: 'config', configId: selector.configId, value: effort }, notes }
}