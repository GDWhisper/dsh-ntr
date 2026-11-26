// @vitest-environment jsdom
// T3: the delegation-defaults section of the subagent card — the default-agent
// picker and the per-agent model/effort/mode defaults. Covers option rendering
// (default / configured / catalog values), client-derived stale + deleted marks
// (kept, never auto-cleared), the unread-vs-read-but-absent staleness split,
// override facts + reset visibility, the write payloads (set / {} all-default /
// null delete / reset keys), failure revert, the memory-only catalog read + the
// explicit fetch gesture, and the hand-copies pinned to the host
// (displayDelegateLabel title strip, thoughtOptionForModel read rule).
//
// The LABEL cluster (choiceLabel / clipChoiceText / textColumns, and the
// resolvedAxisDefaultLabel + processDefaultValue read rules) lives in
// `subagent-defaults-labels.spec.ts`; the card figure itself in
// `subagent-defaults-fold.spec.ts`.
import { createElement } from 'react'
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { catalogAge, thoughtOptionForModel } from '../../src/client/panel/subagent-defaults.tsx'
import { displayDelegateLabel as browserDisplayDelegateLabel, subagentPanelRows } from '../../src/client/subagent-panel.tsx'
import { ModelCatalogService, type CatalogHost } from '../../src/bridge/catalog-service.ts'
import { EventHub } from '../../src/impl.ts'
import { delegateLabel, displayDelegateLabel as hostDisplayDelegateLabel } from '../../src/impl/delegate-label.ts'
import type { AcpAgentCatalog, AcpCatalogOption, SubagentRecord } from '../../src/protocol.ts'
import { axisSelect, category, click, DELEGATE_BASE, defaultAgentSelect, mountDefaults, mountPanel, optionValues, writes } from './harness.ts'

afterEach(cleanup)

describe('SubagentDefaults — default agent', () => {
  it('offers 默认（当前：X） plus every configured agent, and selects 默认 when no override', async () => {
    await mountDefaults({ ...DELEGATE_BASE, globalDefaultAgent: 'codebuddy', resolvedDefaultAgent: 'codebuddy' })
    await category('子智能体')
    const select = defaultAgentSelect()
    expect(select.value).toBe('')
    expect(optionValues(select)).toEqual(['', 'codebuddy', 'pi'])
    expect(screen.getByRole('option', { name: '默认（当前：codebuddy）' })).toBeDefined()
    expect(screen.getByRole('option', { name: 'CodeBuddy' })).toBeDefined()
    expect(screen.getByRole('option', { name: 'pi' })).toBeDefined()
  })

  it('says 默认（未设置） when neither a resolved nor a global default exists', async () => {
    await mountDefaults({ ...DELEGATE_BASE })
    await category('子智能体')
    expect(screen.getByRole('option', { name: '默认（未设置）' })).toBeDefined()
  })

  it('names the visible「设为默认智能体」control and says 智能体 without Agent drift', async () => {
    await mountDefaults({ ...DELEGATE_BASE, globalDefaultAgent: 'codebuddy', resolvedDefaultAgent: 'codebuddy' })
    await category('子智能体')
    // The copy names the ModelCatalogBlock button verbatim (constraint 33).
    expect(screen.getByText('委派未指明子智能体时使用；「默认」跟随「设为默认智能体」的选择。')).toBeDefined()
    // The per-agent「默认 follows the process」sentence is GONE from the rows: the
    // axis dropdown's own「默认（X）」option names the process default, so
    // repeating the rule on every agent was boilerplate (constraint 33).
    expect(screen.queryByText('委派该智能体时的默认选择；「默认」跟随智能体进程自身。')).toBeNull()
    // Said ONCE, on the section that owns the rule.
    expect(screen.getByText('只影响 acp_delegate；「默认」跟随智能体进程自身。')).toBeDefined()
    const section = screen.getByText('子智能体委派配置').closest('.dwa-section-heading')?.parentElement
    expect(section?.textContent ?? '').not.toContain('Agent')
  })

  it('picking an agent writes {defaultAgent:id} immediately', async () => {
    const { store, calls } = await mountDefaults({ ...DELEGATE_BASE, globalDefaultAgent: 'codebuddy', resolvedDefaultAgent: 'codebuddy' })
    await category('子智能体')
    fireEvent.change(defaultAgentSelect(), { target: { value: 'pi' } })
    await waitFor(() => expect(writes(calls, 'ui/delegate-set')).toEqual([{ defaultAgent: 'pi' }]))
    expect(store.getSnapshot().delegate?.defaultAgent).toBe('pi')
    expect(writes(calls, 'agent/save')).toEqual([])
  })

  it('picking 默认 writes reset:[defaultAgent]', async () => {
    const { calls } = await mountDefaults({ ...DELEGATE_BASE, defaultAgent: 'pi', resolvedDefaultAgent: 'pi', globalDefaultAgent: 'codebuddy' })
    await category('子智能体')
    expect(defaultAgentSelect().value).toBe('pi')
    fireEvent.change(defaultAgentSelect(), { target: { value: '' } })
    await waitFor(() => expect(writes(calls, 'ui/delegate-set')).toEqual([{ reset: ['defaultAgent'] }]))
  })

  it('keeps a deleted default agent as a warning-colored selected option, never clears it', async () => {
    const { store } = await mountDefaults({ ...DELEGATE_BASE, defaultAgent: 'ghost', resolvedDefaultAgent: 'ghost', globalDefaultAgent: 'codebuddy' })
    await category('子智能体')
    const select = defaultAgentSelect()
    expect(select.value).toBe('ghost')
    const option = screen.getByRole('option', { name: 'ghost（已删除）' }) as HTMLOptionElement
    expect(option.value).toBe('ghost')
    expect(option.getAttribute('style')).toContain('--dsw-alias-state-warn-primary')
    expect(store.getSnapshot().delegate?.defaultAgent).toBe('ghost')
  })

  it('shows the config-file fact and a reset only when the default really overrides it', async () => {
    const { calls } = await mountDefaults({ ...DELEGATE_BASE, defaultAgent: 'pi', resolvedDefaultAgent: 'pi', globalDefaultAgent: 'codebuddy', configured: { defaultAgent: 'codebuddy' } })
    await category('子智能体')
    const note = screen.getByText(/配置文件要求：codebuddy/)
    expect(note.className).toContain('dwa-deadline-flag')
    await click(screen.getByRole('button', { name: '恢复配置文件的值' }))
    await waitFor(() => expect(writes(calls, 'ui/delegate-set')).toEqual([{ reset: ['defaultAgent'] }]))
  })

  it('no override fact and no reset when the effective default matches the config', async () => {
    await mountDefaults({ ...DELEGATE_BASE, defaultAgent: 'codebuddy', resolvedDefaultAgent: 'codebuddy', configured: { defaultAgent: 'codebuddy' } })
    await category('子智能体')
    expect(screen.queryByText(/配置文件要求/)).toBeNull()
    expect(screen.queryByRole('button', { name: '恢复配置文件的值' })).toBeNull()
  })
})

describe('SubagentDefaults — per-agent axes', () => {
  it('renders model/effort/mode selects from the memory-only catalog', async () => {
    const { calls } = await mountDefaults({ ...DELEGATE_BASE })
    await category('子智能体')
    const model = axisSelect('模型', 'CodeBuddy')
    await waitFor(() => expect(optionValues(model)).toContain('deepseek-v3'))
    expect(optionValues(model)).toEqual(['', 'deepseek-v3', 'claude-sonnet-4'])
    // codebuddy's agent-level thought slot describes its current model.
    expect(optionValues(axisSelect('思考等级', 'CodeBuddy'))).toEqual(['', 'medium', 'high'])
    // No mode option published → only 默认.
    expect(optionValues(axisSelect('模式', 'CodeBuddy'))).toEqual([''])
    // The catalog read is the memory-only route: opening the page never spawns,
    // and the probe waits for the user's own click.
    expect(screen.queryByRole('button', { name: '获取目录' })).toBeNull()
    expect(writes(calls, 'agent/cached-models').length).toBeGreaterThan(0)
    expect(writes(calls, 'agent/probe-models')).toEqual([])
  })

  it('model options carry the agent description (consumption multiplier), distinguishing same-name variants', async () => {
    await mountDefaults({ ...DELEGATE_BASE }, {
      catalogs: {
        codebuddy: {
          catalog: {
            model: {
              configId: 'model', name: 'Model', currentValue: 'hy4-flash',
              choices: [
                { value: 'hy4-flash', name: 'Hy4 flash', description: '消耗倍率 0.3x' },
                { value: 'hy4-flash-pro', name: 'Hy4 flash', description: '消耗倍率 1x' },
                { value: 'plain', name: 'Plain' },
              ],
            },
          },
        },
      },
    })
    await category('子智能体')
    const model = axisSelect('模型', 'CodeBuddy')
    await waitFor(() => expect(optionValues(model)).toContain('hy4-flash'))
    expect(optionValues(model)).toEqual(['', 'hy4-flash', 'hy4-flash-pro', 'plain'])
    expect(within(model).getByRole('option', { name: 'Hy4 flash · 消耗倍率 0.3x' })).toBeDefined()
    expect(within(model).getByRole('option', { name: 'Hy4 flash · 消耗倍率 1x' })).toBeDefined()
    // No description → the bare name, no separator.
    expect(within(model).getByRole('option', { name: 'Plain' })).toBeDefined()
  })

  it('setting a model writes the whole entry with that axis', async () => {
    const { store, calls } = await mountDefaults({ ...DELEGATE_BASE })
    await category('子智能体')
    const model = axisSelect('模型', 'CodeBuddy')
    await waitFor(() => expect(optionValues(model)).toContain('claude-sonnet-4'))
    fireEvent.change(model, { target: { value: 'claude-sonnet-4' } })
    await waitFor(() => expect(writes(calls, 'ui/delegate-set')).toEqual([{ agentDefaults: { codebuddy: { model: 'claude-sonnet-4' } } }]))
    expect(store.getSnapshot().delegate?.agentDefaults?.codebuddy).toEqual({ model: 'claude-sonnet-4' })
  })

  it('clearing the last axis stores an {} all-default override (shadows the baseline)', async () => {
    const { calls } = await mountDefaults({ ...DELEGATE_BASE, agentDefaults: { codebuddy: { model: 'deepseek-v3' } } })
    await category('子智能体')
    const model = axisSelect('模型', 'CodeBuddy')
    await waitFor(() => expect(model.value).toBe('deepseek-v3'))
    fireEvent.change(model, { target: { value: '' } })
    await waitFor(() => expect(writes(calls, 'ui/delegate-set')).toEqual([{ agentDefaults: { codebuddy: {} } }]))
  })

  it('keeps the other axes when one changes', async () => {
    const { calls } = await mountDefaults({ ...DELEGATE_BASE, agentDefaults: { codebuddy: { model: 'deepseek-v3', mode: 'ask' } } })
    await category('子智能体')
    const effort = axisSelect('思考等级', 'CodeBuddy')
    await waitFor(() => expect(optionValues(effort)).toContain('high'))
    fireEvent.change(effort, { target: { value: 'high' } })
    await waitFor(() => expect(writes(calls, 'ui/delegate-set')).toEqual([{ agentDefaults: { codebuddy: { model: 'deepseek-v3', mode: 'ask', effort: 'high' } } }]))
  })

  it('commits the description on blur, trimmed, keeping the other axes', async () => {
    const { store, calls } = await mountDefaults({ ...DELEGATE_BASE, agentDefaults: { codebuddy: { model: 'deepseek-v3' } } })
    await category('子智能体')
    const input = screen.getByLabelText('描述（写给主智能体看） · CodeBuddy') as HTMLInputElement
    expect(input.value).toBe('')
    fireEvent.change(input, { target: { value: '  通用编码  ' } })
    fireEvent.blur(input)
    await waitFor(() => expect(writes(calls, 'ui/delegate-set')).toEqual([{ agentDefaults: { codebuddy: { model: 'deepseek-v3', description: '通用编码' } } }]))
    expect(store.getSnapshot().delegate?.agentDefaults?.codebuddy).toEqual({ model: 'deepseek-v3', description: '通用编码' })
  })

  it('clearing the description deletes only that key and keeps the axes', async () => {
    const { calls } = await mountDefaults({ ...DELEGATE_BASE, agentDefaults: { codebuddy: { model: 'deepseek-v3', description: '通用编码' } } })
    await category('子智能体')
    const input = screen.getByLabelText('描述（写给主智能体看） · CodeBuddy') as HTMLInputElement
    expect(input.value).toBe('通用编码')
    fireEvent.change(input, { target: { value: '   ' } })
    fireEvent.blur(input)
    await waitFor(() => expect(writes(calls, 'ui/delegate-set')).toEqual([{ agentDefaults: { codebuddy: { model: 'deepseek-v3' } } }]))
  })

  it('marks a stale model and mode as warning-colored kept options, never auto-clears', async () => {
    const catalog: AgentProbeModelsResult = {
      agentId: 'codebuddy', updatedAt: 1,
      catalog: {
        model: { configId: 'model', name: 'Model', currentValue: 'm1', choices: [{ value: 'm1', name: 'M1' }, { value: 'm2', name: 'M2' }] },
        mode: { configId: 'mode', name: 'Mode', currentValue: 'o1', choices: [{ value: 'o1', name: 'O1' }, { value: 'o2', name: 'O2' }] },
      },
    }
    const { store } = await mountDefaults({ ...DELEGATE_BASE, agentDefaults: { codebuddy: { model: 'gone', mode: 'lost' } } }, { catalogs: { codebuddy: catalog } })
    await category('子智能体')
    const model = axisSelect('模型', 'CodeBuddy')
    await waitFor(() => expect(optionValues(model)).toContain('gone'))
    for (const [axis, value] of [['模型', 'gone'], ['模式', 'lost']] as const) {
      const select = axisSelect(axis, 'CodeBuddy')
      expect(select.value).toBe(value)
      const option = within(select).getByRole('option', { name: `${value}（已失效）` }) as HTMLOptionElement
      expect(option.getAttribute('style')).toContain('--dsw-alias-state-warn-primary')
    }
    expect(store.getSnapshot().delegate?.agentDefaults?.codebuddy).toEqual({ model: 'gone', mode: 'lost' })
  })

  it('marks a stale effort against the selected model’s known levels', async () => {
    const catalog: AgentProbeModelsResult = {
      agentId: 'codebuddy', updatedAt: 1,
      catalog: {
        model: { configId: 'model', name: 'Model', currentValue: 'm1', choices: [{ value: 'm1', name: 'M1' }] },
        thought: { configId: 'thought_level', name: 'Thinking', currentValue: 'e1', choices: [{ value: 'e1', name: 'E1' }, { value: 'e2', name: 'E2' }] },
      },
    }
    const { store } = await mountDefaults({ ...DELEGATE_BASE, agentDefaults: { codebuddy: { model: 'm1', effort: 'nope' } } }, { catalogs: { codebuddy: catalog } })
    await category('子智能体')
    const effort = axisSelect('思考等级', 'CodeBuddy')
    await waitFor(() => expect(optionValues(effort)).toContain('nope'))
    expect(effort.value).toBe('nope')
    const option = within(effort).getByRole('option', { name: 'nope（已失效）' }) as HTMLOptionElement
    expect(option.getAttribute('style')).toContain('--dsw-alias-state-warn-primary')
    expect(store.getSnapshot().delegate?.agentDefaults?.codebuddy).toEqual({ model: 'm1', effort: 'nope' })
  })

  it('keeps a persisted value plain (not stale) while its catalog axis is unread', async () => {
    // pi publishes no thought slot and no mode: with no evidence of staleness the
    // kept values stay plain, and the missing catalog offers the fetch gesture.
    const { store } = await mountDefaults({ ...DELEGATE_BASE, agentDefaults: { pi: { effort: 'x', mode: 'y' } } }, { catalogs: { pi: null } })
    await category('子智能体')
    const effort = axisSelect('思考等级', 'pi')
    await waitFor(() => expect(optionValues(effort)).toContain('x'))
    expect(within(effort).getByRole('option', { name: 'x' })).toBeDefined()
    expect(within(effort).queryByRole('option', { name: 'x（已失效）' })).toBeNull()
    const mode = axisSelect('模式', 'pi')
    expect(within(mode).getByRole('option', { name: 'y' })).toBeDefined()
    expect(within(mode).queryByRole('option', { name: 'y（已失效）' })).toBeNull()
    const block = effort.closest('.dwa-preference-block') as HTMLElement
    expect(within(block).getByRole('button', { name: '获取目录' })).toBeDefined()
    expect(store.getSnapshot().delegate?.agentDefaults?.pi).toEqual({ effort: 'x', mode: 'y' })
  })

  it('marks kept model/mode values stale when the catalog is read but the axes are absent', async () => {
    // The catalog WAS read (an entry exists) but publishes no model/mode slot:
    // that is evidence the kept values no longer exist — warning-colored and
    // kept, with the row's 刷新目录 still able to ask the agent again.
    const catalog: AgentProbeModelsResult = { agentId: 'codebuddy', updatedAt: 1, catalog: {} }
    const { store } = await mountDefaults({ ...DELEGATE_BASE, agentDefaults: { codebuddy: { model: 'gone', mode: 'lost' } } }, { catalogs: { codebuddy: catalog } })
    await category('子智能体')
    const model = axisSelect('模型', 'CodeBuddy')
    await waitFor(() => expect(optionValues(model)).toContain('gone'))
    for (const [axis, value] of [['模型', 'gone'], ['模式', 'lost']] as const) {
      const select = axisSelect(axis, 'CodeBuddy')
      expect(select.value).toBe(value)
      const option = within(select).getByRole('option', { name: `${value}（已失效）` }) as HTMLOptionElement
      expect(option.getAttribute('style')).toContain('--dsw-alias-state-warn-primary')
    }
    const block = model.closest('.dwa-preference-block') as HTMLElement
    expect(within(block).queryByRole('button', { name: '获取目录' })).toBeNull()
    expect(store.getSnapshot().delegate?.agentDefaults?.codebuddy).toEqual({ model: 'gone', mode: 'lost' })
  })

  it('marks a kept effort stale when the selected model was observed without the axis (null)', async () => {
    // The effort axis already separates the two states via the per-model null:
    // read-but-absent levels mark the kept value, exactly like model/mode do.
    const catalog: AgentProbeModelsResult = {
      agentId: 'codebuddy', updatedAt: 1,
      catalog: {
        model: { configId: 'model', name: 'Model', currentValue: 'm1', choices: [{ value: 'm1', name: 'M1' }] },
        thoughtByModel: { m1: null },
      },
    }
    const { store } = await mountDefaults({ ...DELEGATE_BASE, agentDefaults: { codebuddy: { model: 'm1', effort: 'x' } } }, { catalogs: { codebuddy: catalog } })
    await category('子智能体')
    const effort = axisSelect('思考等级', 'CodeBuddy')
    await waitFor(() => expect(optionValues(effort)).toContain('x'))
    expect(effort.value).toBe('x')
    const option = within(effort).getByRole('option', { name: 'x（已失效）' }) as HTMLOptionElement
    expect(option.getAttribute('style')).toContain('--dsw-alias-state-warn-primary')
    expect(store.getSnapshot().delegate?.agentDefaults?.codebuddy).toEqual({ model: 'm1', effort: 'x' })
  })

  it('effort options follow the selected model via thoughtByModel', async () => {
    const catalog: AgentProbeModelsResult = {
      agentId: 'codebuddy', updatedAt: 1,
      catalog: {
        model: { configId: 'model', name: 'Model', currentValue: 'm-a', choices: [{ value: 'm-a', name: 'Model A' }, { value: 'm-b', name: 'Model B' }] },
        thought: { configId: 'thought_level', name: 'Thinking', currentValue: 'low', choices: [{ value: 'low', name: 'Low' }] },
        thoughtByModel: {
          'm-a': { configId: 'thought_level', name: 'Thinking', currentValue: 'low', choices: [{ value: 'low', name: 'Low' }] },
          'm-b': { configId: 'thought_level', name: 'Thinking', currentValue: 'high', choices: [{ value: 'high', name: 'High' }, { value: 'max', name: 'Max' }] },
        },
      },
    }
    await mountDefaults({ ...DELEGATE_BASE }, { catalogs: { codebuddy: catalog } })
    await category('子智能体')
    const effort = axisSelect('思考等级', 'CodeBuddy')
    const block = axisSelect('模型', 'CodeBuddy').closest('.dwa-preference-block') as HTMLElement
    // model=默认 → the catalog current model (m-a) levels.
    await waitFor(() => expect(optionValues(effort)).toEqual(['', 'low']))
    expect(within(block).getByText('等级作用于运行时实际模型，不支持会自动丢弃。')).toBeDefined()
    // Pick m-b → its own levels, and the model=默认 hint goes away on this row.
    fireEvent.change(axisSelect('模型', 'CodeBuddy'), { target: { value: 'm-b' } })
    await waitFor(() => expect(optionValues(axisSelect('思考等级', 'CodeBuddy'))).toEqual(['', 'high', 'max']))
    expect(within(block).queryByText('等级作用于运行时实际模型，不支持会自动丢弃。')).toBeNull()
  })

  it('shows the per-agent config-file fact and a reset that deletes the override entry', async () => {
    const { calls } = await mountDefaults({ ...DELEGATE_BASE, agentDefaults: { codebuddy: { model: 'claude-sonnet-4' } }, configured: { agentDefaults: { codebuddy: { model: 'deepseek-v3' } } } })
    await category('子智能体')
    await waitFor(() => expect(optionValues(axisSelect('模型', 'CodeBuddy'))).toContain('claude-sonnet-4'))
    expect(screen.getByText(/配置文件要求：模型 deepseek-v3/).className).toContain('dwa-deadline-flag')
    await click(screen.getByRole('button', { name: '恢复配置文件的值' }))
    await waitFor(() => expect(writes(calls, 'ui/delegate-set')).toEqual([{ agentDefaults: { codebuddy: null } }]))
  })

  it('no per-agent reset when the entry matches the config baseline', async () => {
    await mountDefaults({ ...DELEGATE_BASE, agentDefaults: { codebuddy: { model: 'deepseek-v3' } }, configured: { agentDefaults: { codebuddy: { model: 'deepseek-v3' } } } })
    await category('子智能体')
    await waitFor(() => expect(optionValues(axisSelect('模型', 'CodeBuddy'))).toContain('deepseek-v3'))
    expect(screen.queryByText(/配置文件要求/)).toBeNull()
    expect(screen.queryByRole('button', { name: '恢复配置文件的值' })).toBeNull()
  })

  it('offers 获取目录 only when the catalog is missing, and probes on click', async () => {
    const { calls } = await mountDefaults({ ...DELEGATE_BASE }, { catalogs: { codebuddy: null } })
    await category('子智能体')
    const button = await screen.findByRole('button', { name: '获取目录' })
    await click(button)
    await waitFor(() => expect(writes(calls, 'agent/probe-models')).toEqual([{ agentId: 'codebuddy' }]))
  })

  it('reverts the whole delegate view when a defaults write is refused', async () => {
    const seed: AcpDelegateSettings = { ...DELEGATE_BASE, agentDefaults: { codebuddy: { model: 'deepseek-v3' } } }
    const { store } = await mountDefaults(seed, { failWrite: true })
    await category('子智能体')
    const model = axisSelect('模型', 'CodeBuddy')
    await waitFor(() => expect(model.value).toBe('deepseek-v3'))
    fireEvent.change(model, { target: { value: 'claude-sonnet-4' } })
    await waitFor(() => expect(store.getSnapshot().notice).toBe('no'))
    expect(store.getSnapshot().delegate?.agentDefaults).toEqual({ codebuddy: { model: 'deepseek-v3' } })
    expect(model.value).toBe('deepseek-v3')
  })
})

describe('SubagentDefaults — gating', () => {
  it('renders nothing on a host without the delegate RPC', async () => {
    await mountPanel()
    expect(screen.queryByRole('combobox', { name: '默认子智能体' })).toBeNull()
    expect(screen.queryByText('子智能体委派配置')).toBeNull()
  })

  it('hides only the defaults section when no agents or default values exist', async () => {
    await mountDefaults(DELEGATE_BASE, { agents: [] })
    await category('子智能体')
    expect(screen.getByRole('slider', { name: '子智能体委派' })).toBeDefined()
    expect(screen.queryByRole('combobox', { name: '默认子智能体' })).toBeNull()
    expect(screen.queryByText('子智能体委派配置')).toBeNull()
  })

  it('keeps a deleted default recoverable with an empty roster', async () => {
    await mountDefaults({ ...DELEGATE_BASE, defaultAgent: 'ghost', resolvedDefaultAgent: 'ghost' }, { agents: [] })
    await category('子智能体')
    const select = defaultAgentSelect()
    expect(select.value).toBe('ghost')
    expect(screen.getByRole('option', { name: 'ghost（已删除）' })).toBeDefined()
  })

  it('keeps a config-file default recoverable with an empty roster', async () => {
    await mountDefaults({ ...DELEGATE_BASE, configured: { defaultAgent: 'ghost' } }, { agents: [] })
    await category('子智能体')
    expect(defaultAgentSelect().value).toBe('')
    expect(screen.getByText(/配置文件要求：ghost/)).toBeDefined()
    expect(screen.getByRole('button', { name: '恢复配置文件的值' })).toBeDefined()
  })
})

describe('SubagentDefaults — catalog freshness is the user’s call', () => {
  /** A cached snapshot with the age the row is expected to name. */
  const cached = (agentId: string, updatedAt: number): AgentProbeModelsResult => ({
    agentId,
    updatedAt,
    catalog: {
      model: {
        configId: 'model', name: 'Model', currentValue: 'hy4flash-free',
        choices: [{ value: 'hy4flash-free', name: 'Hy4 flash', description: 'x0.00 credits' }],
      },
    },
  })

  it('never probes on its own: opening the page only reads the cache', async () => {
    const { calls } = await mountDefaults({ ...DELEGATE_BASE }, { catalogs: { codebuddy: cached('codebuddy', 1), pi: cached('pi', 1) } })
    await category('子智能体')
    await waitFor(() => expect(screen.getByRole('combobox', { name: '模型 · CodeBuddy' })).toBeDefined())
    // Stale or not, the page spends no probe: one probe can start an agent process.
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(writes(calls, 'agent/probe-models')).toEqual([])
  })

  it('shows the snapshot age and probes only when 刷新目录 is clicked', async () => {
    const { calls } = await mountDefaults({ ...DELEGATE_BASE }, { catalogs: { codebuddy: cached('codebuddy', Date.now() - 3 * 24 * 60 * 60_000) } })
    await category('子智能体')
    const row = screen.getByRole('combobox', { name: '模型 · CodeBuddy' }).closest('.dwa-preference-block') as HTMLElement
    expect(within(row).getByText('目录更新于 3 天前')).toBeDefined()
    expect(writes(calls, 'agent/probe-models')).toEqual([])
    await click(within(row).getByRole('button', { name: '刷新目录' }))
    await waitFor(() => expect(writes(calls, 'agent/probe-models')).toEqual([{ agentId: 'codebuddy' }]))
  })

  it('an unread catalog keeps 获取目录 and shows no age', async () => {
    await mountDefaults({ ...DELEGATE_BASE }, { catalogs: { codebuddy: null } })
    await category('子智能体')
    const row = screen.getByRole('button', { name: '获取目录' }).closest('.dwa-preference-block') as HTMLElement
    expect(within(row).queryByText(/目录更新于/)).toBeNull()
    // `pi` still has a dated snapshot, so the age line is a per-row fact.
    expect(screen.getAllByText(/目录更新于/).length).toBeGreaterThan(0)
  })

  it('pulls nothing while the section stays hidden', async () => {
    const { calls } = await mountDefaults({ ...DELEGATE_BASE }, { catalogs: { codebuddy: cached('codebuddy', 1) } })
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(writes(calls, 'agent/cached-models')).toEqual([])
    expect(writes(calls, 'agent/probe-models')).toEqual([])
  })
})

describe('catalogAge — the snapshot age in words', () => {
  const T0 = 1_700_000_000_000
  it('names minutes, hours and days, and stays silent on an undated snapshot', () => {
    expect(catalogAge(undefined)).toBeUndefined()
    expect(catalogAge(0)).toBeUndefined()
    expect(catalogAge(T0, T0)).toEqual({ zh: '刚刚', en: 'a moment ago' })
    expect(catalogAge(T0, T0 + 90_000)).toEqual({ zh: '1 分钟前', en: '1 min ago' })
    expect(catalogAge(T0, T0 + 3 * 3_600_000)).toEqual({ zh: '3 小时前', en: '3 h ago' })
    expect(catalogAge(T0, T0 + 50 * 3_600_000)).toEqual({ zh: '2 天前', en: '2 d ago' })
  })
})

describe('displayDelegateLabel — title strips the routing carrier', () => {
  it('the browser hand-copy matches the host for legal and malformed carriers', () => {
    const samples = [
      delegateLabel('codebuddy', 'do it'),
      delegateLabel('codebuddy', 'do it', { model: 'gpt-5', effort: 'high', mode: 'ask' }),
      delegateLabel('a1.b-c_d', '中文任务: 带冒号', { model: 'm/a b', effort: '低', mode: 'o&x' }),
      delegateLabel('pi', '🚀 launch', { mode: 'plan' }),
      'codebuddy: plain no carrier',
      'no separator here',
      '',
      'codebuddy ⟦m=x⟧ extra: task',          // malformed: text after carrier
      'codebuddy: ⟦m=fake⟧ task',             // carrier in the task, not the prefix
      'codebuddy ⟦m=x&e=y&o=z&m=w⟧: task',    // duplicate key
      'codebuddy ⟦e=y&m=x⟧: task',            // out-of-order keys
      'codebuddy ⟦m=%ZZ⟧: task',              // bad encoding
      'BAD ID ⟦m=x⟧: task',                   // illegal agent id
    ]
    for (const label of samples) {
      expect(browserDisplayDelegateLabel(label), label).toBe(hostDisplayDelegateLabel(label))
    }
  })

  it('subagentPanelRows shows the label without the carrier (projection and record rows)', () => {
    const label = delegateLabel('codebuddy', 'do it', { model: 'gpt-5', effort: 'high', mode: 'ask' })
    const projectionRows = [{ id: 'acp:t1', createdAt: 10, label }]
    const rows = subagentPanelRows(projectionRows, [])
    expect(rows[0].title).toBe('codebuddy: do it')

    const record: SubagentRecord = {
      childId: 'acp:t2', dshSessionId: 'chat-1', toolCallId: 't2', label,
      status: 'completed', startedAt: 1, lastActivityAt: 2, endedAt: 3,
      counts: { updates: 1, toolCalls: 0, textChars: 0 },
    }
    const recordRows = subagentPanelRows([], [record])
    expect(recordRows[0].title).toBe('codebuddy: do it')
  })
})

describe('thoughtOptionForModel — equivalence with the host read rule', () => {
  // The browser hand-copy must make the SAME decision as the host's
  // `ModelCatalogService.modelReasoning` on the same catalog + model value.
  // The host answers with reasoning info while the browser keeps the raw
  // option, so an option answer is compared against the host's OWN projection
  // of that option (a catalog whose thought slot IS the option, asked with no
  // model runs exactly `reasoningFromOption(thought) ?? null`) — never against
  // a second hand-copy of either rule.
  const agent: AcpAgentDef = { id: 'mock', title: 'Mock', command: process.execPath, args: [] }
  function hostFor(): CatalogHost {
    return {
      defOf: id => (id === agent.id ? agent : undefined),
      isAgentDeleted: () => false,
      bridgeForProbe: () => ({ probeConfigOptions: async () => undefined }),
      releaseProbe: () => {},
      liveForkCapability: () => undefined,
      patchDef: () => {},
      persistAgents: () => {},
      hub: new EventHub(),
    }
  }
  function seed(service: ModelCatalogService, catalog: AcpAgentCatalog | undefined): void {
    // The same private-map seam tests/bridge/chat-picks.spec.ts uses: the read
    // rule runs on the EXACT catalog shape, with no parser in between.
    const internal = service as unknown as { catalogs: Map<string, { catalog: AcpAgentCatalog; updatedAt: number }> }
    if (catalog === undefined) internal.catalogs.delete(agent.id)
    else internal.catalogs.set(agent.id, { catalog, updatedAt: 0 })
  }
  const service = new ModelCatalogService(hostFor())

  const levelsA: AcpCatalogOption = {
    configId: 'effort', name: 'Effort', currentValue: 'high',
    choices: [{ value: 'off', name: 'Off' }, { value: 'high', name: 'High', description: 'deeper' }],
  }
  const levelsB: AcpCatalogOption = { configId: 'effort', name: 'Effort', currentValue: 'max', choices: [{ value: 'max', name: 'Max' }] }
  const toggle: AcpCatalogOption = { configId: 'effort', name: 'Effort', kind: 'boolean', currentValue: 'true', choices: [] }
  const duplicated: AcpCatalogOption = {
    configId: 'effort', name: 'Effort', currentValue: 'high',
    choices: [{ value: 'high', name: 'High' }, { value: 'high', name: 'High again' }, { value: 'low', name: 'Low' }],
  }
  const modelSlot = (current: string | null): AcpCatalogOption => ({
    configId: 'model', name: 'Model', currentValue: current,
    choices: [{ value: 'm-a', name: 'A' }, { value: 'm-b', name: 'B' }],
  })

  function expectEquivalent(catalog: AcpAgentCatalog | undefined, modelValue: string | undefined, why: string): void {
    seed(service, catalog)
    const host = service.modelReasoning(agent.id, modelValue)
    const browser = thoughtOptionForModel(catalog, modelValue)
    if (browser === undefined) { expect(host, why).toBeUndefined(); return }
    if (browser === null) { expect(host, why).toBeNull(); return }
    const projector = new ModelCatalogService(hostFor())
    seed(projector, { thought: browser })
    expect(host, why).toEqual(projector.modelReasoning(agent.id))
  }

  it('matches the host decision across per-model, empty, legacy, absent and prototype-key samples', () => {
    const legacy = { model: modelSlot('m-a'), thought: levelsA }
    const mapped = { model: modelSlot('m-a'), thought: levelsA, thoughtByModel: { 'm-a': levelsA, 'm-b': null } }
    const samples: Array<[AcpAgentCatalog | undefined, string | undefined, string]> = [
      // Unread catalog: no evidence either way.
      [undefined, undefined, 'unread catalog, no model picked'],
      [undefined, 'm-a', 'unread catalog, model named'],
      // Read but nothing published.
      [{}, undefined, 'read empty catalog, no model picked'],
      [{}, 'm-a', 'read empty catalog, model absent'],
      // Legacy catalog (no per-model map): the named model keeps the slot.
      [legacy, undefined, 'legacy, no pick describes the current model'],
      [legacy, 'm-a', 'legacy, current model named'],
      [legacy, 'm-b', 'legacy, another model is unknown'],
      [legacy, '', 'legacy, empty pick falls back to the current model'],
      [{ model: modelSlot('m-a') }, 'm-a', 'legacy without a thought slot stays unknown'],
      [{ model: modelSlot('m-a') }, undefined, 'no thought slot, no pick'],
      [{ thought: levelsA }, undefined, 'thought slot without a model slot, no pick'],
      [{ thought: levelsA }, 'm-a', 'thought slot alone describes no named model'],
      // Per-model records.
      [mapped, 'm-a', 'per-model levels present'],
      [mapped, 'm-b', 'per-model null = observed without the axis'],
      [mapped, undefined, 'no pick describes the current model’s record'],
      [mapped, 'm-c', 'model absent from the map'],
      [{ model: modelSlot('m-a'), thought: levelsA, thoughtByModel: { 'm-b': levelsB } }, 'm-a', 'map present but the current model unrecorded falls back to the legacy slot'],
      [{ model: modelSlot('m-a'), thought: levelsA, thoughtByModel: { 'm-b': levelsB } }, 'm-b', 'recorded model other than the current one'],
      [{ model: modelSlot('m-a'), thoughtByModel: { 'm-a': levelsA } }, 'm-a', 'map without an agent-level thought slot'],
      [{ thoughtByModel: { 'm-a': levelsA } }, 'm-a', 'map without a model slot, model named'],
      [{ thoughtByModel: { 'm-a': levelsA } }, undefined, 'map without a model slot, no pick'],
      // Empty choices (a boolean toggle publishes no levels).
      [{ model: modelSlot('m-a'), thoughtByModel: { 'm-a': toggle } }, 'm-a', 'per-model empty choices'],
      [{ thought: toggle }, undefined, 'agent-level empty choices'],
      // Projection details: duplicate values dedupe, descriptions ride along.
      [{ model: modelSlot('m-a'), thoughtByModel: { 'm-a': duplicated } }, 'm-a', 'duplicate choice values and descriptions'],
      // hasOwnProperty boundaries: prototype names are not records…
      [{ model: modelSlot('m-a'), thoughtByModel: { toString: levelsB } }, 'toString', 'own prototype-named key is a real record'],
      [{ model: modelSlot('m-a'), thoughtByModel: {} }, 'toString', 'empty map must not read Object.prototype.toString'],
      [{ model: modelSlot('m-a'), thoughtByModel: {} }, 'constructor', 'empty map must not read Object.prototype.constructor'],
      [{ model: modelSlot('m-a'), thoughtByModel: {} }, 'hasOwnProperty', 'empty map must not read Object.prototype.hasOwnProperty'],
      [{ model: modelSlot('m-a'), thoughtByModel: Object.create({ 'm-x': levelsB }) as Record<string, AcpCatalogOption | null> }, 'm-x', 'inherited entry is not an own record'],
      [{ model: modelSlot('m-a'), thoughtByModel: { 'm-a': undefined } as unknown as Record<string, AcpCatalogOption | null> }, 'm-a', 'own undefined value reads as observed-without-axis'],
      // currentValue null names no model.
      [{ model: modelSlot(null), thought: levelsA }, undefined, 'null current model falls back to the agent-level slot'],
    ]
    for (const [catalog, modelValue, why] of samples) expectEquivalent(catalog, modelValue, why)
  })
})

describe('SubagentDefaults — disabling agents for delegation', () => {
  it('excludes disabled agents from the default-agent picker, marks a disabled selection, and warns when all are disabled', async () => {
    await mountDefaults({
      ...DELEGATE_BASE,
      defaultAgent: 'codebuddy',
      resolvedDefaultAgent: 'codebuddy',
      agentDefaults: { codebuddy: { enabled: false } },
    })
    await category('子智能体')
    const select = defaultAgentSelect()
    expect(select.value).toBe('codebuddy')
    expect(optionValues(select)).toEqual(['', 'pi', 'codebuddy'])
    const disabledOpt = within(select).getByRole('option', { name: 'CodeBuddy（已禁用）' }) as HTMLOptionElement
    expect(disabledOpt.getAttribute('style')).toContain('--dsw-alias-state-warn-primary')
    expect(screen.getByText(/当前指定的默认子智能体已禁用/).className).toContain('dwa-deadline-flag')
    expect(screen.getByText('当前已禁用子智能体委派，启用后以下配置生效。').className).toContain('is-neutral')

    // Disabling the remaining agent surfaces the all-disabled warning while keeping the guidance rung intact.
    await click(screen.getByRole('checkbox', { name: '参与子智能体委派 · pi' }))
    expect(await screen.findByText('所有智能体均已禁用，当前无法通过 acp_delegate 委派任务。')).toBeDefined()
    expect((screen.getByRole('slider', { name: '子智能体委派' }) as HTMLInputElement).value).toBe('1')
  })

  it('flags a disabled global default in the default option and shows disabled in config baseline notes', async () => {
    await mountDefaults({
      ...DELEGATE_BASE,
      globalDefaultAgent: 'codebuddy',
      resolvedDefaultAgent: 'codebuddy',
      agentDefaults: { codebuddy: {} },
      configured: { agentDefaults: { codebuddy: { enabled: false } } },
    })
    await category('子智能体')
    expect(screen.getByText(/配置文件要求：已禁用/).className).toContain('dwa-deadline-flag')

    await click(screen.getByRole('checkbox', { name: '参与子智能体委派 · CodeBuddy' }))
    expect(await screen.findByRole('option', { name: '默认（当前：codebuddy，已禁用）' })).toBeDefined()
    expect(screen.getByText(/当前跟随的全局默认智能体已禁用/).className).toContain('dwa-deadline-flag')
  })
})