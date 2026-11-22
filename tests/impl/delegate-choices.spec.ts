/**
 * Pure choice planning for the native acp_delegate four-axis customization:
 * the full mode/model matrix (explicit/configured × legal/stale/no-selector/
 * free-value), effort's never-fatal contract, and the EXACT note wording the
 * settings card and settlement notes surface. Imports go through the impl
 * barrel so the re-export block is exercised too.
 */
import { describe, expect, it } from 'vitest'
import { planDelegateEffort, planDelegateModeAndModel } from '../../src/impl.ts'
import type { DelegateChoiceSet, DelegateLiveOptions } from '../../src/impl.ts'

/** Build a live session/new answer: mode ids plus model/thought selectors. */
function live(opts: {
  modes?: string[]
  model?: { configId?: string; choices?: string[] }
  thought?: { configId?: string; choices?: string[] }
} = {}): DelegateLiveOptions {
  const configOptions: unknown[] = []
  if (opts.model !== undefined) {
    configOptions.push({
      category: 'model',
      configId: opts.model.configId ?? 'model',
      name: 'Model',
      currentValue: null,
      options: (opts.model.choices ?? []).map(value => ({ value, name: value })),
    })
  }
  if (opts.thought !== undefined) {
    configOptions.push({
      category: 'thought_level',
      configId: opts.thought.configId ?? 'effort',
      name: 'Thought level',
      currentValue: null,
      options: (opts.thought.choices ?? []).map(value => ({ value, name: value })),
    })
  }
  return {
    configOptions,
    ...(opts.modes !== undefined ? { modes: { availableModes: opts.modes.map(id => ({ id })) } } : {}),
  }
}

const NONE: DelegateChoiceSet = {}

describe('planDelegateModeAndModel · mode axis', () => {
  const liveModes = live({ modes: ['ask', 'architect'] })

  it('skips the axis when neither explicit nor configured names a mode', () => {
    expect(planDelegateModeAndModel({ agentId: 'a', explicit: NONE, configured: NONE, live: liveModes }))
      .toEqual({ writes: [], notes: [] })
  })

  it('writes a legal explicit mode', () => {
    expect(planDelegateModeAndModel({ agentId: 'a', explicit: { mode: 'ask' }, configured: NONE, live: liveModes }))
      .toEqual({ writes: [{ kind: 'mode', modeId: 'ask' }], notes: [] })
  })

  it('writes a legal configured mode', () => {
    expect(planDelegateModeAndModel({ agentId: 'a', explicit: NONE, configured: { mode: 'architect' }, live: liveModes }))
      .toEqual({ writes: [{ kind: 'mode', modeId: 'architect' }], notes: [] })
  })

  it('explicit wins over configured without a note about the shadowed default', () => {
    expect(planDelegateModeAndModel({ agentId: 'a', explicit: { mode: 'ask' }, configured: { mode: 'ghost' }, live: liveModes }))
      .toEqual({ writes: [{ kind: 'mode', modeId: 'ask' }], notes: [] })
  })

  it('explicit stale mode is fatal with the available list', () => {
    expect(planDelegateModeAndModel({ agentId: 'a', explicit: { mode: 'ghost' }, configured: NONE, live: liveModes }))
      .toEqual({ writes: [], notes: [], fatal: 'acp_delegate: agent "a" does not offer mode "ghost" (available: ask, architect)' })
  })

  it('configured stale mode degrades to the startup mode with the fixed note', () => {
    expect(planDelegateModeAndModel({ agentId: 'a', explicit: NONE, configured: { mode: 'ghost' }, live: liveModes }))
      .toEqual({ writes: [], notes: ['agent「a」不再提供默认模式「ghost」，本次使用启动模式'] })
  })

  it('explicit mode without a published mode list is fatal (absent or empty)', () => {
    for (const noModes of [live({}), live({ modes: [] })]) {
      expect(planDelegateModeAndModel({ agentId: 'a', explicit: { mode: 'ask' }, configured: NONE, live: noModes }))
        .toEqual({ writes: [], notes: [], fatal: 'acp_delegate: agent "a" does not publish mode selection' })
    }
  })

  it('configured mode without a published mode list skips with the 未提供 note', () => {
    for (const noModes of [live({}), live({ modes: [] })]) {
      expect(planDelegateModeAndModel({ agentId: 'a', explicit: NONE, configured: { mode: 'ask' }, live: noModes }))
        .toEqual({ writes: [], notes: ['agent「a」未提供默认模式「ask」，本次使用启动模式'] })
    }
  })
})

describe('planDelegateModeAndModel · model axis', () => {
  const liveModel = live({ model: { choices: ['gpt-5', 'claude-4'] } })

  it('skips the axis when neither explicit nor configured names a model', () => {
    expect(planDelegateModeAndModel({ agentId: 'a', explicit: NONE, configured: NONE, live: liveModel }))
      .toEqual({ writes: [], notes: [] })
  })

  it('writes a legal explicit model through the selector configId', () => {
    expect(planDelegateModeAndModel({ agentId: 'a', explicit: { model: 'gpt-5' }, configured: NONE, live: liveModel }))
      .toEqual({ writes: [{ kind: 'config', configId: 'model', value: 'gpt-5' }], notes: [] })
  })

  it('writes a legal configured model', () => {
    expect(planDelegateModeAndModel({ agentId: 'a', explicit: NONE, configured: { model: 'claude-4' }, live: liveModel }))
      .toEqual({ writes: [{ kind: 'config', configId: 'model', value: 'claude-4' }], notes: [] })
  })

  it('honors a non-default selector configId', () => {
    const custom = live({ model: { configId: 'model_id', choices: ['x'] } })
    expect(planDelegateModeAndModel({ agentId: 'a', explicit: { model: 'x' }, configured: NONE, live: custom }))
      .toEqual({ writes: [{ kind: 'config', configId: 'model_id', value: 'x' }], notes: [] })
  })

  it('explicit wins over configured on the model axis', () => {
    expect(planDelegateModeAndModel({ agentId: 'a', explicit: { model: 'gpt-5' }, configured: { model: 'ghost' }, live: liveModel }))
      .toEqual({ writes: [{ kind: 'config', configId: 'model', value: 'gpt-5' }], notes: [] })
  })

  it('explicit stale model is fatal with the available list', () => {
    expect(planDelegateModeAndModel({ agentId: 'a', explicit: { model: 'ghost' }, configured: NONE, live: liveModel }))
      .toEqual({ writes: [], notes: [], fatal: 'acp_delegate: agent "a" does not offer model "ghost" (available: gpt-5, claude-4)' })
  })

  it('configured stale model degrades to the agent default with the fixed note', () => {
    expect(planDelegateModeAndModel({ agentId: 'a', explicit: NONE, configured: { model: 'ghost' }, live: liveModel }))
      .toEqual({ writes: [], notes: ['agent「a」不再提供默认模型「ghost」，本次使用 agent 自身默认模型'] })
  })

  it('explicit model without a model selector is fatal', () => {
    expect(planDelegateModeAndModel({ agentId: 'a', explicit: { model: 'x' }, configured: NONE, live: live({}) }))
      .toEqual({ writes: [], notes: [], fatal: 'acp_delegate: agent "a" does not publish model selection' })
  })

  it('configured model without a model selector skips with the 未提供 note', () => {
    expect(planDelegateModeAndModel({ agentId: 'a', explicit: NONE, configured: { model: 'x' }, live: live({}) }))
      .toEqual({ writes: [], notes: ['agent「a」未提供默认模型「x」，本次使用 agent 自身默认模型'] })
  })

  it('a choice-less model selector accepts any free value, explicit and configured', () => {
    const free = live({ model: { choices: [] } })
    expect(planDelegateModeAndModel({ agentId: 'a', explicit: { model: 'anything/goes' }, configured: NONE, live: free }))
      .toEqual({ writes: [{ kind: 'config', configId: 'model', value: 'anything/goes' }], notes: [] })
    expect(planDelegateModeAndModel({ agentId: 'a', explicit: NONE, configured: { model: 'free-form' }, live: free }))
      .toEqual({ writes: [{ kind: 'config', configId: 'model', value: 'free-form' }], notes: [] })
  })
})

describe('planDelegateModeAndModel · ordering and fatal contract', () => {
  const both = live({ modes: ['ask'], model: { choices: ['gpt-5'] } })

  it('plans mode before model', () => {
    expect(planDelegateModeAndModel({ agentId: 'a', explicit: { mode: 'ask', model: 'gpt-5' }, configured: NONE, live: both }))
      .toEqual({ writes: [{ kind: 'mode', modeId: 'ask' }, { kind: 'config', configId: 'model', value: 'gpt-5' }], notes: [] })
  })

  it('a stale configured mode notes while the model still writes', () => {
    expect(planDelegateModeAndModel({ agentId: 'a', explicit: NONE, configured: { mode: 'ghost', model: 'gpt-5' }, live: both }))
      .toEqual({ writes: [{ kind: 'config', configId: 'model', value: 'gpt-5' }], notes: ['agent「a」不再提供默认模式「ghost」，本次使用启动模式'] })
  })

  it('fatal means nothing is applied: writes empty even when the other axis planned', () => {
    const result = planDelegateModeAndModel({ agentId: 'a', explicit: { mode: 'ask', model: 'ghost' }, configured: NONE, live: both })
    expect(result.fatal).toBe('acp_delegate: agent "a" does not offer model "ghost" (available: gpt-5)')
    expect(result.writes).toEqual([])
  })

  it('keeps earlier notes when a later axis is fatal', () => {
    const result = planDelegateModeAndModel({ agentId: 'a', explicit: { model: 'ghost' }, configured: { mode: 'ghost2' }, live: both })
    expect(result.fatal).toBe('acp_delegate: agent "a" does not offer model "ghost" (available: gpt-5)')
    expect(result.notes).toEqual(['agent「a」不再提供默认模式「ghost2」，本次使用启动模式'])
    expect(result.writes).toEqual([])
  })

  it('ignores the effort axis entirely', () => {
    const withThought = live({ modes: ['ask'], model: { choices: ['gpt-5'] }, thought: { choices: ['high'] } })
    expect(planDelegateModeAndModel({ agentId: 'a', explicit: { effort: 'high' }, configured: { effort: 'low' }, live: withThought }))
      .toEqual({ writes: [], notes: [] })
  })
})

describe('planDelegateEffort · never fatal', () => {
  const liveThought = live({ thought: { choices: ['low', 'high'] } })

  it('skips when neither side names an effort', () => {
    expect(planDelegateEffort({ agentId: 'a', explicit: NONE, configured: NONE, live: liveThought })).toEqual({ notes: [] })
  })

  it('writes a legal explicit effort through the thought selector configId', () => {
    expect(planDelegateEffort({ agentId: 'a', explicit: { effort: 'high' }, configured: NONE, live: liveThought }))
      .toEqual({ write: { kind: 'config', configId: 'effort', value: 'high' }, notes: [] })
  })

  it('writes a legal configured effort', () => {
    expect(planDelegateEffort({ agentId: 'a', explicit: NONE, configured: { effort: 'low' }, live: liveThought }))
      .toEqual({ write: { kind: 'config', configId: 'effort', value: 'low' }, notes: [] })
  })

  it('explicit wins over configured without a note', () => {
    expect(planDelegateEffort({ agentId: 'a', explicit: { effort: 'high' }, configured: { effort: 'ghost' }, live: liveThought }))
      .toEqual({ write: { kind: 'config', configId: 'effort', value: 'high' }, notes: [] })
  })

  it('honors a non-default thought configId', () => {
    const custom = live({ thought: { configId: 'reasoning_effort', choices: ['high'] } })
    expect(planDelegateEffort({ agentId: 'a', explicit: { effort: 'high' }, configured: NONE, live: custom }))
      .toEqual({ write: { kind: 'config', configId: 'reasoning_effort', value: 'high' }, notes: [] })
  })

  it('soft-drops a stale explicit effort with the fixed note', () => {
    expect(planDelegateEffort({ agentId: 'a', explicit: { effort: 'max' }, configured: NONE, live: liveThought }))
      .toEqual({ notes: ['思考等级「max」不受当前模型支持，已丢弃'] })
  })

  it('skips a stale configured effort with the fixed note', () => {
    expect(planDelegateEffort({ agentId: 'a', explicit: NONE, configured: { effort: 'max' }, live: liveThought }))
      .toEqual({ notes: ['agent「a」的默认思考等级「max」不受当前模型支持，本次不设置'] })
  })

  it('soft-drops an explicit effort when no thought selector is published', () => {
    expect(planDelegateEffort({ agentId: 'a', explicit: { effort: 'high' }, configured: NONE, live: live({}) }))
      .toEqual({ notes: ['思考等级「high」不受当前模型支持，已丢弃'] })
  })

  it('skips a configured effort when no thought selector is published', () => {
    expect(planDelegateEffort({ agentId: 'a', explicit: NONE, configured: { effort: 'high' }, live: live({}) }))
      .toEqual({ notes: ['agent「a」的默认思考等级「high」不受当前模型支持，本次不设置'] })
  })

  it('a choice-less thought selector accepts any free value, explicit and configured', () => {
    const free = live({ thought: { choices: [] } })
    expect(planDelegateEffort({ agentId: 'a', explicit: { effort: 'ultra' }, configured: NONE, live: free }))
      .toEqual({ write: { kind: 'config', configId: 'effort', value: 'ultra' }, notes: [] })
    expect(planDelegateEffort({ agentId: 'a', explicit: NONE, configured: { effort: 'ultra' }, live: free }))
      .toEqual({ write: { kind: 'config', configId: 'effort', value: 'ultra' }, notes: [] })
  })

  it('reads the refreshed live options it is given (post-model-write)', () => {
    // The same explicit level against two different model answers: the caller
    // re-invokes after the model write, and the plan follows the NEW choices.
    const before = live({ thought: { choices: ['low', 'high'] } })
    const after = live({ thought: { choices: ['minimal'] } })
    expect(planDelegateEffort({ agentId: 'a', explicit: { effort: 'high' }, configured: NONE, live: before }).write)
      .toEqual({ kind: 'config', configId: 'effort', value: 'high' })
    expect(planDelegateEffort({ agentId: 'a', explicit: { effort: 'high' }, configured: NONE, live: after }))
      .toEqual({ notes: ['思考等级「high」不受当前模型支持，已丢弃'] })
  })

  it('ignores mode and model values', () => {
    expect(planDelegateEffort({ agentId: 'a', explicit: { mode: 'ask', model: 'gpt-5' }, configured: NONE, live: liveThought }))
      .toEqual({ notes: [] })
  })
})