/**
 * Model catalog parsing: `parseCatalogOptions` slot assignment, `mergeCatalogShape` fold-back, `usableConfigOptions` guards and the adapter model-id split/build.
 *
 * Part of the `tests/impl.spec.ts` mirror: one file per `src/impl/` cluster,
 * same describe titles and case counts as before the split.
 */

import { describe, expect, it } from 'vitest'
import {
  buildAdapterModelId,
  MAX_CONFIG_OPTIONS_BYTES,
  hasUnambiguousModelSelector,
  mergeCatalogShape,
  parseCatalogOptions,
  usableConfigOptions,
  splitAdapterModelId,
} from '../../src/impl.ts'

describe('parseCatalogOptions', () => {
  it('extracts model and thought_level categories and collects the remaining selects as extras', () => {
    const catalog = parseCatalogOptions([
      { configId: 'model', name: 'Model', type: 'select', category: 'model', currentValue: 'a', options: [
        { value: 'a', name: 'Model A' },
        { value: 'b', name: 'Model B', description: 'The B model' },
      ] },
      { configId: 'think', name: 'Think', type: 'select', category: 'thought_level', currentValue: 'high', options: [
        { value: 'off', name: 'Off' },
        { value: 'high', name: 'High' },
      ] },
      { configId: 'temp', name: 'Temp', type: 'select', currentValue: 'mid', options: [{ value: 'mid', name: 'mid' }] },
      { configId: 'flag', name: 'Flag', type: 'boolean', currentValue: true },
    ])
    expect(catalog.model).toEqual({
      configId: 'model',
      name: 'Model',
      currentValue: 'a',
      choices: [{ value: 'a', name: 'Model A' }, { value: 'b', name: 'Model B', description: 'The B model' }],
    })
    expect(catalog.thought?.configId).toBe('think')
    expect(catalog.thought?.currentValue).toBe('high')
    // Every other SELECT is an extra (the composer's advanced base). A boolean
    // toggle is one too: it carries no choices, and `kind` is what tells the
    // composer to render a checkbox instead of a select.
    expect(catalog.extras).toEqual([
      { configId: 'temp', name: 'Temp', currentValue: 'mid', choices: [{ value: 'mid', name: 'mid' }] },
      { configId: 'flag', name: 'Flag', kind: 'boolean', currentValue: 'true', choices: [] },
    ])
  })

  it('sends a boolean to the advanced base even when it claims a select category', () => {
    // Some agents publish their thinking switch as a `thought_level` BOOLEAN.
    // The thought chip picks among levels and has none to show for it, so the
    // toggle must stay reachable as a checkbox rather than vanish into a slot
    // with an empty choice list.
    const catalog = parseCatalogOptions([
      { configId: 'think', name: 'Thinking', type: 'boolean', category: 'thought_level', currentValue: false },
      { configId: 'nocard', name: 'No card', category: 'model', currentValue: true },
    ])
    expect(catalog.thought).toBeUndefined()
    expect(catalog.model).toBeUndefined()
    expect(catalog.extras).toEqual([
      { configId: 'think', name: 'Thinking', kind: 'boolean', currentValue: 'false', choices: [] },
      // `type` is absent, but a JSON boolean current value with no choices is
      // still a toggle (defensive: not every agent fills `type`).
      { configId: 'nocard', name: 'No card', kind: 'boolean', currentValue: 'true', choices: [] },
    ])
  })

  it('falls back to the legacy id field, flattens grouped options, dedupes, and keeps unknown categories as extras', () => {
    const catalog = parseCatalogOptions([
      { id: 'model', category: 'model', currentValue: 'x', options: [
        { groupId: 'g', name: 'Group G', options: [{ value: 'x', name: 'X' }, { value: 'z', name: 'Z', description: 'own text' }] },
        { value: 'x', name: 'X duplicate' },
        { value: 'y', name: '' },
      ] },
      { configId: 'weird', category: 'future_thing', currentValue: 'z', options: [{ value: 'z', name: 'Z' }] },
      { category: 'thought_level', currentValue: 'on' },
    ])
    expect(catalog.model?.configId).toBe('model')
    // Dedupe keeps the first occurrence; grouped choices carry the group label
    // both as fallback description and as a dedicated `group` field (vendor).
    expect(catalog.model?.choices).toEqual([
      { value: 'x', name: 'X', description: 'Group G', group: 'Group G' },
      { value: 'z', name: 'Z', description: 'own text', group: 'Group G' },
      { value: 'y', name: 'y' },
    ])
    expect(catalog.thought).toBeUndefined()
    expect(catalog.extras).toEqual([
      { configId: 'weird', name: 'weird', currentValue: 'z', choices: [{ value: 'z', name: 'Z' }] },
    ])
  })

  it('returns an empty catalog for non-arrays and choice-less options', () => {
    expect(parseCatalogOptions('nope')).toEqual({})
    expect(parseCatalogOptions(undefined)).toEqual({})
    expect(parseCatalogOptions([{ configId: 'model', category: 'model', currentValue: 'a' }])).toEqual({
      model: { configId: 'model', name: 'model', currentValue: 'a', choices: [] },
    })
  })

  it('reads the agent\'s own mode select, which is not a DSH concept', () => {
    // Both real agents publish their permission/working mode as a
    // `category: 'mode'` select on `session/new` (omp: Mode, codebuddy:
    // Permission Mode). It used to be dropped here — every category that was
    // not model/thought_level was skipped — which left the composer with no
    // mode list until a live session existed.
    const catalog = parseCatalogOptions([
      { configId: 'mode', name: 'Permission Mode', type: 'select', category: 'mode', currentValue: 'default', options: [
        { value: 'default', name: 'Always Ask' },
        { value: 'plan', name: 'Plan' },
      ] },
    ])
    expect(catalog.mode).toEqual({
      configId: 'mode',
      name: 'Permission Mode',
      currentValue: 'default',
      choices: [{ value: 'default', name: 'Always Ask' }, { value: 'plan', name: 'Plan' }],
    })
    // Unknown / vendor categories (and options with no category at all) are
    // surfaced as extras: the advanced base gives them a control instead of
    // dropping them on the floor.
    expect(parseCatalogOptions([
      { configId: 'sandbox', category: 'sandbox', currentValue: 'false', options: [{ value: 'false', name: 'Local' }] },
    ])).toEqual({
      extras: [{
        configId: 'sandbox',
        name: 'sandbox',
        currentValue: 'false',
        choices: [{ value: 'false', name: 'Local' }],
      }],
    })
  })

  it('keeps the model selector when an agent mislabels an effort option as category:model', () => {
    // Qoder CN 1.1.56 (issue #8): the `set_config_option(model, ...)` answer
    // tags BOTH `model` and `reasoning_effort` as category:'model'. Last-wins
    // used to replace the model list with the effort list, after which every
    // send was refused as `model_unavailable` before reaching the agent.
    const catalog = parseCatalogOptions([
      { configId: 'mode', name: 'Mode', type: 'select', category: 'mode', currentValue: 'default', options: [
        { value: 'default', name: 'Default' },
        { value: 'yolo', name: 'Bypass Permissions' },
      ] },
      { configId: 'model', name: 'Model', type: 'select', category: 'model', currentValue: 'qfmodel', options: [
        { value: 'auto', name: 'Auto (default)' },
        { value: 'qfmodel', name: 'Qwen3.8-Flash' },
        { value: 'dmodel', name: 'DeepSeek-V4-Pro' },
      ] },
      { configId: 'reasoning_effort', name: 'Reasoning Effort', type: 'select', category: 'model', currentValue: 'xhigh', options: [
        { value: 'xhigh', name: 'Extra High' },
        { value: 'low', name: 'Low' },
        { value: 'medium', name: 'Medium' },
        { value: 'none', name: 'None' },
      ] },
    ])
    expect(catalog.model?.configId).toBe('model')
    expect(catalog.model?.currentValue).toBe('qfmodel')
    expect(catalog.model?.choices.map(choice => choice.value)).toEqual(['auto', 'qfmodel', 'dmodel'])
    // The mislabelled effort is not a second model list: it is the thought
    // control the agent should have published in the first place.
    expect(catalog.thought?.configId).toBe('reasoning_effort')
    expect(catalog.thought?.currentValue).toBe('xhigh')
    expect(catalog.thought?.choices.map(choice => choice.value)).toEqual(['xhigh', 'low', 'medium', 'none'])
    expect(catalog.mode?.configId).toBe('mode')
    expect(catalog.extras).toBeUndefined()
  })

  it('never lets a same-category option replace a slot and keeps the loser settable', () => {
    const catalog = parseCatalogOptions([
      { configId: 'model', name: 'Model', category: 'model', currentValue: 'a', options: [
        { value: 'a', name: 'A' },
        { value: 'b', name: 'B' },
      ] },
      // Non-effort model-scoped option: a last-resort selector only.
      { configId: 'variant', name: 'Variant', category: 'model', currentValue: 'x', options: [{ value: 'x', name: 'X' }] },
      // A real thought_level outranks the mislabelled effort, which stays an
      // extra instead of vanishing.
      { configId: 'thought_level', name: 'Thinking', category: 'thought_level', currentValue: 'high', options: [{ value: 'high', name: 'High' }] },
      { configId: 'reasoning_effort', name: 'Reasoning Effort', category: 'model', currentValue: 'low', options: [{ value: 'low', name: 'Low' }] },
    ])
    expect(catalog.model?.configId).toBe('model')
    expect(catalog.thought?.configId).toBe('thought_level')
    expect(catalog.extras?.map(option => option.configId)).toEqual(['variant', 'reasoning_effort'])
  })
})

describe('hasUnambiguousModelSelector', () => {
  it('trusts an explicit model id, or a single model-scoped option', () => {
    expect(hasUnambiguousModelSelector([{ configId: 'model', category: 'model' }])).toBe(true)
    expect(hasUnambiguousModelSelector([{ configId: 'reasoning_effort', category: 'model' }])).toBe(true)
    expect(hasUnambiguousModelSelector([
      { configId: 'model', category: 'model' },
      { configId: 'reasoning_effort', category: 'model' },
    ])).toBe(true)
    expect(hasUnambiguousModelSelector([{ configId: 'modelId', name: 'Model', category: 'model' }, { configId: 'other', category: 'model' }])).toBe(true)
  })

  it('reports ambiguity when several model-scoped options exist and none is the selector', () => {
    expect(hasUnambiguousModelSelector([
      { configId: 'alpha', category: 'model' },
      { configId: 'beta', category: 'model' },
    ])).toBe(false)
  })
})

describe('mergeCatalogShape', () => {
  it('adopts a newly observed slot without its per-session currentValue', () => {
    // The shape absorb is fed `session/set_config_option` answers, where the
    // current value is ONE session's pick (opencode: `effort` appears only
    // after switching to a model with variants). Promoting it would make that
    // pick `reasoning.defaultEffort` for every other conversation.
    const merged = mergeCatalogShape({ model: modelOption(['a'], 'a') }, {
      model: modelOption(['a'], 'b'),
      thought: { configId: 'effort', name: 'Effort', currentValue: 'high', choices: choiceList(['low', 'high', 'default']) },
    })
    expect(merged.thought).toEqual({
      configId: 'effort',
      name: 'Effort',
      currentValue: null,
      choices: choiceList(['low', 'high', 'default']),
    })
    // An existing slot keeps the CATALOG's current value, not the answer's.
    expect(merged.model?.currentValue).toBe('a')
  })

  it('keeps the catalog value while the observed choices still offer it, and drops it when they do not', () => {
    const existing = {
      thought: { configId: 'effort', name: 'Effort', currentValue: 'xhigh', choices: choiceList(['xhigh', 'default']) },
    }
    expect(mergeCatalogShape(existing, { thought: { configId: 'effort', name: 'Effort', currentValue: 'default', choices: choiceList(['xhigh', 'default']) } })
      .thought?.currentValue).toBe('xhigh')
    // The new model's vocabulary no longer offers it: back to "agent default".
    expect(mergeCatalogShape(existing, { thought: { configId: 'effort', name: 'Effort', currentValue: 'default', choices: choiceList(['low', 'max', 'default']) } })
      .thought?.currentValue).toBeNull()
  })

  it('leaves slots the answer omits alone and merges extras by configId', () => {
    const existing = {
      model: modelOption(['a'], 'a'),
      extras: [{ configId: 'temp', name: 'Temp', currentValue: 'mid', choices: choiceList(['mid']) }],
    }
    const merged = mergeCatalogShape(existing, {
      thought: { configId: 'effort', name: 'Effort', currentValue: 'default', choices: choiceList(['default']) },
      extras: [{ configId: 'style', name: 'Style', currentValue: 'plain', choices: choiceList(['plain']) }],
    })
    // Omitted: untouched (another model may still offer them).
    expect(merged.model).toEqual(existing.model)
    expect(merged.mode).toBeUndefined()
    // Extras union: the unobserved one survives, the observed one lands beside it.
    expect(merged.extras?.map(option => option.configId)).toEqual(['temp', 'style'])
    expect(merged.extras?.[0]?.currentValue).toBe('mid')
    expect(merged.extras?.[1]?.currentValue).toBeNull()
  })

  it('keeps a boolean extra a boolean, adopting its shape without the per-session value', () => {
    const existing = {
      extras: [{ configId: 'stream', name: 'Stream', kind: 'boolean' as const, currentValue: 'false', choices: [] }],
    }
    const observed = parseCatalogOptions([
      { configId: 'stream', name: 'Stream', type: 'boolean', currentValue: true },
      { configId: 'verbose', name: 'Verbose', type: 'boolean', currentValue: true },
    ])
    const merged = mergeCatalogShape(existing, observed)
    // Known toggle: shape absorbed, catalog default untouched.
    expect(merged.extras?.[0]).toEqual({ configId: 'stream', name: 'Stream', kind: 'boolean', currentValue: 'false', choices: [] })
    // New toggle: the answer's `true` is that session's pick, not the default.
    expect(merged.extras?.[1]).toEqual({ configId: 'verbose', name: 'Verbose', kind: 'boolean', currentValue: null, choices: [] })
  })

  it('heals a poisoned model slot on the next observation', () => {
    // A catalog persisted by the broken parser holds `reasoning_effort` in the
    // model slot. The corrected observation replaces the identity, and the old
    // effort value is not carried over because the real model list cannot
    // offer it.
    const existing = {
      model: { configId: 'reasoning_effort', name: 'Reasoning Effort', currentValue: 'xhigh', choices: choiceList(['xhigh', 'low']) },
    }
    const observed = parseCatalogOptions([
      { configId: 'model', name: 'Model', category: 'model', currentValue: 'qfmodel', options: [
        { value: 'auto', name: 'Auto' },
        { value: 'qfmodel', name: 'Qwen3.8-Flash' },
      ] },
      { configId: 'reasoning_effort', name: 'Reasoning Effort', category: 'model', currentValue: 'xhigh', options: [
        { value: 'xhigh', name: 'Extra High' },
        { value: 'low', name: 'Low' },
      ] },
    ])
    const merged = mergeCatalogShape(existing, observed)
    expect(merged.model?.configId).toBe('model')
    expect(merged.model?.currentValue).toBeNull()
    expect(merged.thought?.configId).toBe('reasoning_effort')
  })

  it('keeps the agent-level thought slot when the answer describes ANOTHER model', () => {
    // CodeBuddy's real shape (verified against `codebuddy --acp`): the thought
    // axis' vocabulary is MODEL-dependent — its default `hy4flash-free`
    // publishes `high` alone while another model publishes off/high/max — and
    // the answer for the second still lists every model in the model slot.
    // Folding those levels into the agent-level slot leaves the catalog hybrid
    // (model slot naming the first model, thought slot offering the second
    // one's), so a route with no model of its own reads `max` from it, the
    // session's own answer refuses `max`, and `applyChatChoice` drops the
    // pre-first-turn pick as stale: the turn runs the agent's own `high` and
    // the chip snaps back — the reported "I switched to max and it ran high".
    const existing = {
      model: modelOption(['mock-model-a', 'mock-model-b'], 'mock-model-a'),
      thought: { configId: 'thought', name: 'Thought Level', currentValue: 'high', choices: choiceList(['high']) },
    }
    const merged = mergeCatalogShape(existing, {
      model: modelOption(['mock-model-a', 'mock-model-b'], 'mock-model-b'),
      thought: { configId: 'thought', name: 'Thought Level', currentValue: 'max', choices: choiceList(['off', 'high', 'max']) },
    })
    // The narrow vocabulary stays exactly as it was: another model's levels are
    // not the agent's. They are not lost either — `rememberModelThought` keeps
    // them per model (`thoughtByModel`), the only place a per-model vocabulary
    // can be read back from.
    expect(merged.thought).toEqual(existing.thought)
    // The MODEL slot is still free to self-correct from this same answer: the
    // observation's choices are absorbed and the catalog's current value kept.
    expect(merged.model).toEqual(existing.model)
  })

  it('promotes the thought slot when the answer names the model the catalog is on', () => {
    // The guard is per-model, not per-answer: an observation about the model
    // the catalog is anchored on is agent knowledge like any other slot. Its
    // `currentValue` is still one session's pick, so the catalog's own value
    // survives while the choices widen.
    const existing = {
      model: modelOption(['mock-model-a', 'mock-model-b'], 'mock-model-a'),
      thought: { configId: 'thought', name: 'Thought Level', currentValue: 'high', choices: choiceList(['high']) },
    }
    const merged = mergeCatalogShape(existing, {
      model: modelOption(['mock-model-a', 'mock-model-b'], 'mock-model-a'),
      thought: { configId: 'thought', name: 'Thought Level', currentValue: 'max', choices: choiceList(['off', 'high', 'max']) },
    })
    expect(merged.thought?.choices.map(choice => choice.value)).toEqual(['off', 'high', 'max'])
    expect(merged.thought?.currentValue).toBe('high')
  })

  it('promotes the thought slot from an answer that names no model at all', () => {
    // opencode's publish-on-switch: it offers `effort` just for models with
    // variants and never re-notifies after a client-driven set, so the first
    // such answer is the ONLY one that can put the chip in the composer at all.
    // An answer that names no model cannot be attributed to one, so it stays
    // agent-wide.
    const existing = {
      model: modelOption(['a'], 'a'),
      thought: { configId: 'thought', name: 'Thought Level', currentValue: 'off', choices: choiceList(['off', 'high']) },
    }
    const merged = mergeCatalogShape(existing, {
      thought: { configId: 'effort', name: 'Effort', currentValue: 'high', choices: choiceList(['low', 'high', 'default']) },
    })
    expect(merged.thought?.configId).toBe('effort')
    expect(merged.thought?.choices.map(choice => choice.value)).toEqual(['low', 'high', 'default'])
    // A model slot the answer does not carry is left alone.
    expect(merged.model).toEqual(existing.model)

    // A model slot that is present but BLANK names no model either:
    // `parseCatalogOptions` normalises an empty `currentValue` to `null`, and a
    // catalog reloaded from `model-catalog.json` can hold one.
    const blank = mergeCatalogShape(existing, parseCatalogOptions([
      { configId: 'model', name: 'Model', category: 'model', currentValue: '', options: [{ value: 'a', name: 'A' }] },
      { configId: 'effort', name: 'Effort', category: 'thought_level', currentValue: 'high', options: [
        { value: 'low', name: 'Low' },
        { value: 'high', name: 'High' },
        { value: 'default', name: 'Default' },
      ] },
    ]))
    expect(blank.thought?.configId).toBe('effort')
    expect(blank.thought?.choices.map(choice => choice.value)).toEqual(['low', 'high', 'default'])
    // The blank value is not adopted as the agent's model: the catalog keeps
    // naming the one it is on.
    expect(blank.model?.currentValue).toBe('a')
  })

  it('promotes the FIRST observed thought slot even when it describes another model', () => {
    // The opencode shape again, from the other side: the agent-level slot
    // starts out EMPTY because the model the session began on publishes no
    // thought_level, so the first observation of one is what puts the chip in
    // the composer at all. There is nothing to protect yet, so the per-model
    // guard does not apply — blocking it would hide the axis until a session
    // happened to start on a model that has one.
    const existing = { model: modelOption(['mock-model-a', 'mock-model-b'], 'mock-model-a') }
    const merged = mergeCatalogShape(existing, {
      model: modelOption(['mock-model-a', 'mock-model-b'], 'mock-model-b'),
      thought: { configId: 'thought', name: 'Thought Level', currentValue: 'max', choices: choiceList(['off', 'high', 'max']) },
    })
    expect(merged.thought?.choices.map(choice => choice.value)).toEqual(['off', 'high', 'max'])
    // Still not the answer's per-session pick.
    expect(merged.thought?.currentValue).toBeNull()
  })

  it('folds an observed axis in when the catalog names no model to contradict it', () => {
    // The guard protects the ANCHOR, not the slot — and what it reads is the
    // anchor AFTER the merge. With no model slot to merge into, that anchor is
    // null (`merge` never adopts an observed `currentValue`), so there is
    // nothing to contradict and the observed axis simply becomes the agent's
    // knowledge. Freezing the first vocabulary instead would strand the chip
    // on levels the agent has since moved past — the mirror image of the
    // defect the guard exists for.
    const existing = {
      thought: { configId: 'thought', name: 'Thought Level', currentValue: 'high', choices: choiceList(['off', 'high']) },
    }
    const merged = mergeCatalogShape(existing, {
      model: modelOption(['a'], 'a'),
      thought: { configId: 'thought', name: 'Thought Level', currentValue: 'max', choices: choiceList(['low', 'high', 'max']) },
    })
    expect(merged.thought?.choices.map(choice => choice.value)).toEqual(['low', 'high', 'max'])
    // The catalog's own value still wins over the answer's per-session pick.
    expect(merged.thought?.currentValue).toBe('high')

    // Same verdict when the answer drops the model the catalog was anchored on:
    // the merged model slot carries no value, so nothing is contradicted and the
    // fresh observation is the most current knowledge there is.
    const dropped = mergeCatalogShape(
      {
        model: modelOption(['a'], 'a'),
        thought: { configId: 'thought', name: 'Thought Level', currentValue: 'high', choices: choiceList(['off', 'high']) },
      },
      {
        model: modelOption(['b'], 'b'),
        thought: { configId: 'thought', name: 'Thought Level', currentValue: 'max', choices: choiceList(['low', 'high', 'max']) },
      },
    )
    expect(dropped.thought?.choices.map(choice => choice.value)).toEqual(['low', 'high', 'max'])
    expect(dropped.model?.currentValue).toBeNull()
  })
})

function modelOption(values: string[], currentValue: string | null) {
  return { configId: 'model', name: 'Model', currentValue, choices: choiceList(values) }
}

function choiceList(values: string[]) {
  return values.map(value => ({ value, name: value }))
}

describe('usableConfigOptions', () => {
  it('treats an empty or absent answer as a non-answer', () => {
    // Agents return `configOptions: []` in intermediate states (observed with
    // ccb / opencode on OmniTerm's side); overwriting known state with it would
    // wipe a perfectly good catalog for a state that passes.
    expect(usableConfigOptions(undefined)).toBe(false)
    expect(usableConfigOptions(null)).toBe(false)
    expect(usableConfigOptions([])).toBe(false)
    expect(usableConfigOptions('nope')).toBe(false)
    expect(usableConfigOptions([{ configId: 'model' }])).toBe(true)
  })

  it('drops absurdly large answers instead of absorbing them', () => {
    // A misbehaving agent must not turn every notification into an unbounded
    // write (the same red line OmniTerm caps its config snapshots at).
    const huge = [{ configId: 'model', name: 'x'.repeat(MAX_CONFIG_OPTIONS_BYTES) }]
    expect(usableConfigOptions(huge)).toBe(false)
    expect(usableConfigOptions([{ configId: 'model', name: 'x'.repeat(1024) }])).toBe(true)
  })
})

describe('adapter model id split/build', () => {
  it('splits base and variant ids at the @ separator', () => {
    expect(splitAdapterModelId('pi')).toEqual({ agentId: 'pi' })
    expect(splitAdapterModelId('pi@deepseek-chat')).toEqual({ agentId: 'pi', choice: 'deepseek-chat' })
    expect(splitAdapterModelId('a.b-c@v1')).toEqual({ agentId: 'a.b-c', choice: 'v1' })
  })
  it('builds the inverse variant id', () => {
    expect(buildAdapterModelId('pi', 'deepseek-chat')).toBe('pi@deepseek-chat')
  })
})
