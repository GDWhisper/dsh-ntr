// @vitest-environment jsdom
// T3: the delegation-defaults section of the subagent card — the default-agent
// picker and the per-agent model/effort/mode defaults. Covers option rendering
// (default / configured / catalog values), client-derived stale + deleted marks
// (kept, never auto-cleared), the unread-vs-read-but-absent staleness split,
// override facts + reset visibility, the write payloads (set / {} all-default /
// null delete / reset keys), failure revert, the memory-only catalog read + the
// explicit fetch gesture, and the hand-copies pinned to the host
// (displayDelegateLabel title strip, thoughtOptionForModel read rule).
import { createElement } from 'react'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { AcpSettingsSection } from '../../src/client/panel.tsx'
import { axisChoices, catalogAge, CHOICE_LABEL_MAX, CHOICE_OPTION_MAX, choiceLabel, clipChoiceText, resolvedAxisDefaultLabel, textColumns, thoughtOptionForModel } from '../../src/client/panel/subagent-defaults.tsx'
import { AcpStore, type RpcCall } from '../../src/client/store.ts'
import { displayDelegateLabel as browserDisplayDelegateLabel, subagentPanelRows } from '../../src/client/subagent-panel.tsx'
import { ModelCatalogService, type CatalogHost } from '../../src/bridge/catalog-service.ts'
import { EventHub } from '../../src/impl.ts'
import { delegateLabel, displayDelegateLabel as hostDisplayDelegateLabel } from '../../src/impl/delegate-label.ts'
import type { AcpAgentCatalog, AcpAgentDef, AcpCatalogChoice, AcpCatalogOption, AcpDelegateSettings, AgentProbeModelsResult, DelegateSetPayload, SubagentRecord } from '../../src/protocol.ts'
import { createPanelFixture, type PanelRpcCall } from '../panel-fixture.ts'
import { category, click, mountPanel } from './harness.ts'

afterEach(cleanup)

const BASE: AcpDelegateSettings = {
  guidance: 'on', timeoutMs: 2_400_000, defaultTimeoutMs: 2_400_000,
  toolAvailable: true, restrictAvailable: true,
}

function writes(calls: PanelRpcCall[], endpoint: string): unknown[] {
  return calls.filter(call => call.endpoint === endpoint).map(call => call.payload)
}

/** Mount the settings section with a delegate view the wrapper keeps authoritative. */
async function mountDefaults(seed: AcpDelegateSettings, options: { agents?: AcpAgentDef[]; failWrite?: boolean; catalogs?: Record<string, AgentProbeModelsResult | null>; locale?: (zh: string, en: string) => string } = {}) {
  const base = createPanelFixture({ agents: options.agents, catalogs: options.catalogs })
  let current = structuredClone(seed)
  const calls: PanelRpcCall[] = []
  const rpc: RpcCall = async (channel, endpoint, payload) => {
    calls.push({ channel, endpoint, payload: structuredClone(payload) })
    if (channel === '/acp' && endpoint === 'ui/delegate') return { ok: true, value: { delegate: structuredClone(current) } }
    if (channel === '/acp' && endpoint === 'ui/delegate-set') {
      if (options.failWrite === true) return { ok: false, error: { code: 'bad_payload', message: 'no' } }
      const patch = structuredClone(payload) as DelegateSetPayload
      const next: AcpDelegateSettings = { ...current }
      if (patch.guidance !== undefined) next.guidance = patch.guidance
      if (patch.timeoutMs !== undefined) next.timeoutMs = patch.timeoutMs
      if (patch.defaultAgent !== undefined) next.defaultAgent = patch.defaultAgent
      if (patch.agentDefaults !== undefined) {
        const merged = { ...(current.agentDefaults ?? {}) }
        for (const [id, entry] of Object.entries(patch.agentDefaults)) {
          if (entry === null) delete merged[id]
          else merged[id] = entry
        }
        next.agentDefaults = merged
      }
      for (const key of patch.reset ?? []) {
        if (key === 'defaultAgent') next.defaultAgent = current.configured?.defaultAgent
        if (key === 'agentDefaults') next.agentDefaults = current.configured?.agentDefaults ?? {}
        if (key === 'guidance') next.guidance = current.configured?.guidance ?? 'off'
        if (key === 'timeoutMs') next.timeoutMs = current.configured?.timeoutMs ?? current.defaultTimeoutMs ?? next.timeoutMs
      }
      // Host view hygiene (delegateSettingsView): an empty map is NO key.
      if (next.agentDefaults !== undefined && Object.keys(next.agentDefaults).length === 0) delete next.agentDefaults
      next.resolvedDefaultAgent = next.defaultAgent ?? next.globalDefaultAgent
      current = next
      return { ok: true, value: { delegate: structuredClone(current) } }
    }
    return base.rpc(channel, endpoint, payload)
  }
  const store = new AcpStore(rpc, options.locale ?? (zh => zh))
  await store.resync()
  render(createElement(AcpSettingsSection, { acp: store }))
  return { store, calls }
}

/** The default-agent picker (its aria-label is the visible row title). */
function defaultAgentSelect(): HTMLSelectElement {
  return screen.getByRole('combobox', { name: '默认智能体' }) as HTMLSelectElement
}
function axisSelect(axis: '模型' | '思考等级' | '模式', title: string): HTMLSelectElement {
  return screen.getByRole('combobox', { name: `${axis} · ${title}` }) as HTMLSelectElement
}
function optionValues(select: HTMLSelectElement): string[] {
  return Array.from(select.options).map(option => option.value)
}

describe('SubagentDefaults — default agent', () => {
  it('offers 默认（当前：X） plus every configured agent, and selects 默认 when no override', async () => {
    await mountDefaults({ ...BASE, globalDefaultAgent: 'codebuddy', resolvedDefaultAgent: 'codebuddy' })
    await category('子代理')
    const select = defaultAgentSelect()
    expect(select.value).toBe('')
    expect(optionValues(select)).toEqual(['', 'codebuddy', 'pi'])
    expect(screen.getByRole('option', { name: '默认（当前：codebuddy）' })).toBeDefined()
    expect(screen.getByRole('option', { name: 'CodeBuddy' })).toBeDefined()
    expect(screen.getByRole('option', { name: 'pi' })).toBeDefined()
  })

  it('says 默认（未设置） when neither a resolved nor a global default exists', async () => {
    await mountDefaults({ ...BASE })
    await category('子代理')
    expect(screen.getByRole('option', { name: '默认（未设置）' })).toBeDefined()
  })

  it('names the visible「设为默认智能体」control and says 智能体 without Agent drift', async () => {
    await mountDefaults({ ...BASE, globalDefaultAgent: 'codebuddy', resolvedDefaultAgent: 'codebuddy' })
    await category('子代理')
    // The copy names the ModelCatalogBlock button verbatim (constraint 33).
    expect(screen.getByText('委派未指明智能体时使用；「默认」跟随「设为默认智能体」的选择。')).toBeDefined()
    // One such row per configured agent, all in the same terminology.
    expect(screen.getAllByText('委派该智能体时的默认选择；「默认」跟随智能体进程自身。')).toHaveLength(2)
    const section = screen.getByText('委派默认').closest('.dwa-section-heading')?.parentElement
    expect(section?.textContent ?? '').not.toContain('Agent')
  })

  it('picking an agent writes {defaultAgent:id} immediately', async () => {
    const { store, calls } = await mountDefaults({ ...BASE, globalDefaultAgent: 'codebuddy', resolvedDefaultAgent: 'codebuddy' })
    await category('子代理')
    fireEvent.change(defaultAgentSelect(), { target: { value: 'pi' } })
    await waitFor(() => expect(writes(calls, 'ui/delegate-set')).toEqual([{ defaultAgent: 'pi' }]))
    expect(store.getSnapshot().delegate?.defaultAgent).toBe('pi')
    expect(writes(calls, 'agent/save')).toEqual([])
  })

  it('picking 默认 writes reset:[defaultAgent]', async () => {
    const { calls } = await mountDefaults({ ...BASE, defaultAgent: 'pi', resolvedDefaultAgent: 'pi', globalDefaultAgent: 'codebuddy' })
    await category('子代理')
    expect(defaultAgentSelect().value).toBe('pi')
    fireEvent.change(defaultAgentSelect(), { target: { value: '' } })
    await waitFor(() => expect(writes(calls, 'ui/delegate-set')).toEqual([{ reset: ['defaultAgent'] }]))
  })

  it('keeps a deleted default agent as a warning-colored selected option, never clears it', async () => {
    const { store } = await mountDefaults({ ...BASE, defaultAgent: 'ghost', resolvedDefaultAgent: 'ghost', globalDefaultAgent: 'codebuddy' })
    await category('子代理')
    const select = defaultAgentSelect()
    expect(select.value).toBe('ghost')
    const option = screen.getByRole('option', { name: 'ghost（已删除）' }) as HTMLOptionElement
    expect(option.value).toBe('ghost')
    expect(option.getAttribute('style')).toContain('--dsw-alias-state-warn-primary')
    expect(store.getSnapshot().delegate?.defaultAgent).toBe('ghost')
  })

  it('shows the config-file fact and a reset only when the default really overrides it', async () => {
    const { calls } = await mountDefaults({ ...BASE, defaultAgent: 'pi', resolvedDefaultAgent: 'pi', globalDefaultAgent: 'codebuddy', configured: { defaultAgent: 'codebuddy' } })
    await category('子代理')
    const note = screen.getByText(/配置文件要求：codebuddy/)
    expect(note.className).toContain('dwa-deadline-flag')
    await click(screen.getByRole('button', { name: '恢复配置文件的值' }))
    await waitFor(() => expect(writes(calls, 'ui/delegate-set')).toEqual([{ reset: ['defaultAgent'] }]))
  })

  it('no override fact and no reset when the effective default matches the config', async () => {
    await mountDefaults({ ...BASE, defaultAgent: 'codebuddy', resolvedDefaultAgent: 'codebuddy', configured: { defaultAgent: 'codebuddy' } })
    await category('子代理')
    expect(screen.queryByText(/配置文件要求/)).toBeNull()
    expect(screen.queryByRole('button', { name: '恢复配置文件的值' })).toBeNull()
  })
})

describe('SubagentDefaults — per-agent axes', () => {
  it('renders model/effort/mode selects from the memory-only catalog', async () => {
    const { calls } = await mountDefaults({ ...BASE })
    await category('子代理')
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
    await mountDefaults({ ...BASE }, {
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
    await category('子代理')
    const model = axisSelect('模型', 'CodeBuddy')
    await waitFor(() => expect(optionValues(model)).toContain('hy4-flash'))
    expect(optionValues(model)).toEqual(['', 'hy4-flash', 'hy4-flash-pro', 'plain'])
    expect(within(model).getByRole('option', { name: 'Hy4 flash · 消耗倍率 0.3x' })).toBeDefined()
    expect(within(model).getByRole('option', { name: 'Hy4 flash · 消耗倍率 1x' })).toBeDefined()
    // No description → the bare name, no separator.
    expect(within(model).getByRole('option', { name: 'Plain' })).toBeDefined()
  })

  it('setting a model writes the whole entry with that axis', async () => {
    const { store, calls } = await mountDefaults({ ...BASE })
    await category('子代理')
    const model = axisSelect('模型', 'CodeBuddy')
    await waitFor(() => expect(optionValues(model)).toContain('claude-sonnet-4'))
    fireEvent.change(model, { target: { value: 'claude-sonnet-4' } })
    await waitFor(() => expect(writes(calls, 'ui/delegate-set')).toEqual([{ agentDefaults: { codebuddy: { model: 'claude-sonnet-4' } } }]))
    expect(store.getSnapshot().delegate?.agentDefaults?.codebuddy).toEqual({ model: 'claude-sonnet-4' })
  })

  it('clearing the last axis stores an {} all-default override (shadows the baseline)', async () => {
    const { calls } = await mountDefaults({ ...BASE, agentDefaults: { codebuddy: { model: 'deepseek-v3' } } })
    await category('子代理')
    const model = axisSelect('模型', 'CodeBuddy')
    await waitFor(() => expect(model.value).toBe('deepseek-v3'))
    fireEvent.change(model, { target: { value: '' } })
    await waitFor(() => expect(writes(calls, 'ui/delegate-set')).toEqual([{ agentDefaults: { codebuddy: {} } }]))
  })

  it('keeps the other axes when one changes', async () => {
    const { calls } = await mountDefaults({ ...BASE, agentDefaults: { codebuddy: { model: 'deepseek-v3', mode: 'ask' } } })
    await category('子代理')
    const effort = axisSelect('思考等级', 'CodeBuddy')
    await waitFor(() => expect(optionValues(effort)).toContain('high'))
    fireEvent.change(effort, { target: { value: 'high' } })
    await waitFor(() => expect(writes(calls, 'ui/delegate-set')).toEqual([{ agentDefaults: { codebuddy: { model: 'deepseek-v3', mode: 'ask', effort: 'high' } } }]))
  })

  it('commits the description on blur, trimmed, keeping the other axes', async () => {
    const { store, calls } = await mountDefaults({ ...BASE, agentDefaults: { codebuddy: { model: 'deepseek-v3' } } })
    await category('子代理')
    const input = screen.getByLabelText('描述（写给主代理看） · CodeBuddy') as HTMLInputElement
    expect(input.value).toBe('')
    fireEvent.change(input, { target: { value: '  通用编码  ' } })
    fireEvent.blur(input)
    await waitFor(() => expect(writes(calls, 'ui/delegate-set')).toEqual([{ agentDefaults: { codebuddy: { model: 'deepseek-v3', description: '通用编码' } } }]))
    expect(store.getSnapshot().delegate?.agentDefaults?.codebuddy).toEqual({ model: 'deepseek-v3', description: '通用编码' })
  })

  it('clearing the description deletes only that key and keeps the axes', async () => {
    const { calls } = await mountDefaults({ ...BASE, agentDefaults: { codebuddy: { model: 'deepseek-v3', description: '通用编码' } } })
    await category('子代理')
    const input = screen.getByLabelText('描述（写给主代理看） · CodeBuddy') as HTMLInputElement
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
    const { store } = await mountDefaults({ ...BASE, agentDefaults: { codebuddy: { model: 'gone', mode: 'lost' } } }, { catalogs: { codebuddy: catalog } })
    await category('子代理')
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
    const { store } = await mountDefaults({ ...BASE, agentDefaults: { codebuddy: { model: 'm1', effort: 'nope' } } }, { catalogs: { codebuddy: catalog } })
    await category('子代理')
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
    const { store } = await mountDefaults({ ...BASE, agentDefaults: { pi: { effort: 'x', mode: 'y' } } }, { catalogs: { pi: null } })
    await category('子代理')
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
    const { store } = await mountDefaults({ ...BASE, agentDefaults: { codebuddy: { model: 'gone', mode: 'lost' } } }, { catalogs: { codebuddy: catalog } })
    await category('子代理')
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
    const { store } = await mountDefaults({ ...BASE, agentDefaults: { codebuddy: { model: 'm1', effort: 'x' } } }, { catalogs: { codebuddy: catalog } })
    await category('子代理')
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
    await mountDefaults({ ...BASE }, { catalogs: { codebuddy: catalog } })
    await category('子代理')
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
    const { calls } = await mountDefaults({ ...BASE, agentDefaults: { codebuddy: { model: 'claude-sonnet-4' } }, configured: { agentDefaults: { codebuddy: { model: 'deepseek-v3' } } } })
    await category('子代理')
    await waitFor(() => expect(optionValues(axisSelect('模型', 'CodeBuddy'))).toContain('claude-sonnet-4'))
    expect(screen.getByText(/配置文件要求：模型 deepseek-v3/).className).toContain('dwa-deadline-flag')
    await click(screen.getByRole('button', { name: '恢复配置文件的值' }))
    await waitFor(() => expect(writes(calls, 'ui/delegate-set')).toEqual([{ agentDefaults: { codebuddy: null } }]))
  })

  it('no per-agent reset when the entry matches the config baseline', async () => {
    await mountDefaults({ ...BASE, agentDefaults: { codebuddy: { model: 'deepseek-v3' } }, configured: { agentDefaults: { codebuddy: { model: 'deepseek-v3' } } } })
    await category('子代理')
    await waitFor(() => expect(optionValues(axisSelect('模型', 'CodeBuddy'))).toContain('deepseek-v3'))
    expect(screen.queryByText(/配置文件要求/)).toBeNull()
    expect(screen.queryByRole('button', { name: '恢复配置文件的值' })).toBeNull()
  })

  it('offers 获取目录 only when the catalog is missing, and probes on click', async () => {
    const { calls } = await mountDefaults({ ...BASE }, { catalogs: { codebuddy: null } })
    await category('子代理')
    const button = await screen.findByRole('button', { name: '获取目录' })
    await click(button)
    await waitFor(() => expect(writes(calls, 'agent/probe-models')).toEqual([{ agentId: 'codebuddy' }]))
  })

  it('reverts the whole delegate view when a defaults write is refused', async () => {
    const seed: AcpDelegateSettings = { ...BASE, agentDefaults: { codebuddy: { model: 'deepseek-v3' } } }
    const { store } = await mountDefaults(seed, { failWrite: true })
    await category('子代理')
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
    expect(screen.queryByRole('combobox', { name: '默认智能体' })).toBeNull()
    expect(screen.queryByText('委派默认')).toBeNull()
  })

  it('hides only the defaults section when no agents or default values exist', async () => {
    await mountDefaults(BASE, { agents: [] })
    await category('子代理')
    expect(screen.getByRole('slider', { name: '子代理委派' })).toBeDefined()
    expect(screen.queryByRole('combobox', { name: '默认智能体' })).toBeNull()
    expect(screen.queryByText('委派默认')).toBeNull()
  })

  it('keeps a deleted default recoverable with an empty roster', async () => {
    await mountDefaults({ ...BASE, defaultAgent: 'ghost', resolvedDefaultAgent: 'ghost' }, { agents: [] })
    await category('子代理')
    const select = defaultAgentSelect()
    expect(select.value).toBe('ghost')
    expect(screen.getByRole('option', { name: 'ghost（已删除）' })).toBeDefined()
  })

  it('keeps a config-file default recoverable with an empty roster', async () => {
    await mountDefaults({ ...BASE, configured: { defaultAgent: 'ghost' } }, { agents: [] })
    await category('子代理')
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
    const { calls } = await mountDefaults({ ...BASE }, { catalogs: { codebuddy: cached('codebuddy', 1), pi: cached('pi', 1) } })
    await category('子代理')
    await waitFor(() => expect(screen.getByRole('combobox', { name: '模型 · CodeBuddy' })).toBeDefined())
    // Stale or not, the page spends no probe: one probe can start an agent process.
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(writes(calls, 'agent/probe-models')).toEqual([])
  })

  it('shows the snapshot age and probes only when 刷新目录 is clicked', async () => {
    const { calls } = await mountDefaults({ ...BASE }, { catalogs: { codebuddy: cached('codebuddy', Date.now() - 3 * 24 * 60 * 60_000) } })
    await category('子代理')
    const row = screen.getByRole('combobox', { name: '模型 · CodeBuddy' }).closest('.dwa-preference-block') as HTMLElement
    expect(within(row).getByText('目录更新于 3 天前')).toBeDefined()
    expect(writes(calls, 'agent/probe-models')).toEqual([])
    await click(within(row).getByRole('button', { name: '刷新目录' }))
    await waitFor(() => expect(writes(calls, 'agent/probe-models')).toEqual([{ agentId: 'codebuddy' }]))
  })

  it('an unread catalog keeps 获取目录 and shows no age', async () => {
    await mountDefaults({ ...BASE }, { catalogs: { codebuddy: null } })
    await category('子代理')
    const row = screen.getByRole('button', { name: '获取目录' }).closest('.dwa-preference-block') as HTMLElement
    expect(within(row).queryByText(/目录更新于/)).toBeNull()
    // `pi` still has a dated snapshot, so the age line is a per-row fact.
    expect(screen.getAllByText(/目录更新于/).length).toBeGreaterThan(0)
  })

  it('pulls nothing while the section stays hidden', async () => {
    const { calls } = await mountDefaults({ ...BASE }, { catalogs: { codebuddy: cached('codebuddy', 1) } })
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

describe('choiceLabel — one row text for rows and parentheses alike', () => {
  it('spells name · description when present, the bare name otherwise', () => {
    expect(choiceLabel({ value: 'hy4flash-free', name: 'Hy4 flash', description: 'x0.00 credits' })).toBe('Hy4 flash · x0.00 credits')
    expect(choiceLabel({ value: 'plain', name: 'Plain' })).toBe('Plain')
  })

  // User report, 2026-11-23: a native <select> sizes its popup to the widest
  // option, so one agent's paragraph-long mode description pushed the list past
  // the dialog. Every row is capped in COLUMNS (wide CJK counts double).
  const AUTO = 'An AI reviewer checks each action that would otherwise ask for approval and approves or denies it. A failed review blocks only that action; it never falls back to a prompt or leaves auto mode.'

  it('caps a long description at CHOICE_LABEL_MAX columns, cutting on a word boundary', () => {
    const full = `Auto · ${AUTO}`
    const label = choiceLabel({ value: 'auto', name: 'Auto', description: AUTO })
    expect(textColumns(label)).toBeLessThanOrEqual(CHOICE_LABEL_MAX)
    expect(label.endsWith('…')).toBe(true)
    // The retained part is the untouched head of the full row…
    expect(full.startsWith(label.slice(0, -1))).toBe(true)
    // …and the cut lands right after a space, never inside a word.
    expect(full.charAt(label.length - 1)).toBe(' ')
  })

  it('counts East Asian wide characters as two columns so CJK descriptions cap too', () => {
    expect(textColumns('模式')).toBe(4)
    // Emoji ride the same rule and are never split off their surrogate pair:
    // a code-unit slice would keep half of the second emoji at this budget.
    expect(textColumns('😀')).toBe(2)
    expect(clipChoiceText('😀😀😀😀', 4)).toBe('😀…')
    const description = '这是一段很长的说明文字，用来确认中文说明也会按显示宽度封顶，不会把下拉列表撑宽。'
    const label = choiceLabel({ value: 'm', name: '模型', description })
    expect(textColumns(label)).toBeLessThanOrEqual(CHOICE_LABEL_MAX)
    expect(label.endsWith('…')).toBe(true)
  })

  it('leaves a row that already fits untouched — no ellipsis, no trimming', () => {
    const short = 'x0.00 credits'
    expect(clipChoiceText(`Hy4 flash · ${short}`)).toBe(`Hy4 flash · ${short}`)
    expect(clipChoiceText('短说明')).toBe('短说明')
  })
})

describe('resolvedAxisDefaultLabel — the process default the 默认 option spells', () => {
  const slot = (currentValue: string | null, choices: AcpCatalogChoice[] = [], kind?: 'boolean'): AcpCatalogOption => ({
    configId: 'slot', name: 'Slot', currentValue, choices, ...(kind === undefined ? {} : { kind }),
  })
  const modelOne: AcpCatalogChoice = { value: 'm1', name: 'Model One', description: 'x0.5 credits' }
  // One read catalog naming a default on every axis (effort via the legacy slot).
  const knownCatalog: AgentProbeModelsResult = {
    agentId: 'codebuddy', updatedAt: 1,
    catalog: {
      model: { configId: 'model', name: 'Model', currentValue: 'm1', choices: [modelOne, { value: 'm2', name: 'Model Two' }] },
      thought: { configId: 'thought_level', name: 'Thinking', currentValue: 'e1', choices: [{ value: 'e1', name: 'Level One' }] },
      mode: { configId: 'mode', name: 'Mode', currentValue: 'o1', choices: [{ value: 'o1', name: 'Mode One' }] },
    },
  }

  it('returns undefined on every axis while the catalog is unread', () => {
    for (const axis of ['model', 'effort', 'mode'] as const) {
      expect(resolvedAxisDefaultLabel(undefined, axis, undefined)).toBeUndefined()
      expect(resolvedAxisDefaultLabel(undefined, axis, 'm1')).toBeUndefined()
    }
  })

  it('returns undefined when the axis slot is missing', () => {
    expect(resolvedAxisDefaultLabel({}, 'model', undefined)).toBeUndefined()
    expect(resolvedAxisDefaultLabel({}, 'mode', undefined)).toBeUndefined()
    expect(resolvedAxisDefaultLabel({}, 'effort', undefined)).toBeUndefined()
    // A read catalog whose picked model was never observed has no effort evidence.
    expect(resolvedAxisDefaultLabel({ model: slot('m1', [modelOne]) }, 'effort', 'm2')).toBeUndefined()
  })

  it('returns undefined for a null or empty currentValue', () => {
    for (const current of [null, '']) {
      expect(resolvedAxisDefaultLabel({ model: slot(current, [modelOne]) }, 'model', undefined)).toBeUndefined()
      expect(resolvedAxisDefaultLabel({ mode: slot(current) }, 'mode', undefined)).toBeUndefined()
      expect(resolvedAxisDefaultLabel({ thought: slot(current) }, 'effort', undefined)).toBeUndefined()
    }
  })

  it('names the choice the currentValue hits — the same label its row spells', () => {
    expect(resolvedAxisDefaultLabel(knownCatalog.catalog, 'model', undefined)).toEqual({ text: 'Model One · x0.5 credits', listed: true })
    expect(resolvedAxisDefaultLabel(knownCatalog.catalog, 'mode', undefined)).toEqual({ text: 'Mode One', listed: true })
  })

  it('falls back to the raw value (listed:false) when no choice matches or the matched name is empty', () => {
    expect(resolvedAxisDefaultLabel({ model: slot('ghost', [modelOne]) }, 'model', undefined)).toEqual({ text: 'ghost', listed: false })
    expect(resolvedAxisDefaultLabel({ model: slot('m1', [{ value: 'm1', name: '' }]) }, 'model', undefined)).toEqual({ text: 'm1', listed: false })
  })

  it('returns undefined for a boolean toggle slot', () => {
    const toggle = slot('true', [], 'boolean')
    expect(resolvedAxisDefaultLabel({ model: toggle }, 'model', undefined)).toBeUndefined()
    expect(resolvedAxisDefaultLabel({ mode: toggle }, 'mode', undefined)).toBeUndefined()
    expect(resolvedAxisDefaultLabel({ thought: toggle }, 'effort', undefined)).toBeUndefined()
  })

  it('effort reads the same effective-model slot as axisChoices', () => {
    const levels1 = slot('e1', [{ value: 'e1', name: 'Level One' }])
    const levels2 = slot('e2', [{ value: 'e2', name: 'Level Two' }])
    const model = slot('m1', [modelOne, { value: 'm2', name: 'Model Two' }])
    const mapped: AcpAgentCatalog = { model, thoughtByModel: { m1: levels1, m2: levels2 } }
    // No pick (or an empty one) describes the catalog's current model m1.
    expect(resolvedAxisDefaultLabel(mapped, 'effort', undefined)).toEqual({ text: 'Level One', listed: true })
    expect(resolvedAxisDefaultLabel(mapped, 'effort', '')).toEqual({ text: 'Level One', listed: true })
    // An explicit m2 uses its own record.
    expect(resolvedAxisDefaultLabel(mapped, 'effort', 'm2')).toEqual({ text: 'Level Two', listed: true })
    // Observed without the axis → nothing to name.
    expect(resolvedAxisDefaultLabel({ model, thoughtByModel: { m1: levels1, m2: null } }, 'effort', 'm2')).toBeUndefined()
    // Legacy catalog without the map: only the named current model keeps the slot.
    const legacy: AcpAgentCatalog = { model, thought: levels1 }
    expect(resolvedAxisDefaultLabel(legacy, 'effort', undefined)).toEqual({ text: 'Level One', listed: true })
    expect(resolvedAxisDefaultLabel(legacy, 'effort', 'm1')).toEqual({ text: 'Level One', listed: true })
    expect(resolvedAxisDefaultLabel(legacy, 'effort', 'm2')).toBeUndefined()
    // The named default is always one of the axis's own known choices, and the
    // parentheses spell that choice's row label verbatim.
    for (const pick of [undefined, 'm1', 'm2']) {
      const label = resolvedAxisDefaultLabel(mapped, 'effort', pick)
      expect(label?.listed).toBe(true)
      expect((axisChoices(mapped, 'effort', pick) ?? []).some(choice => choiceLabel(choice) === label?.text)).toBe(true)
    }
  })

  it('the 默认 option spells the resolved process default in parentheses when the catalog is known', async () => {
    await mountDefaults({ ...BASE }, { catalogs: { codebuddy: knownCatalog } })
    await category('子代理')
    const model = axisSelect('模型', 'CodeBuddy')
    await waitFor(() => expect(optionValues(model)).toContain('m1'))
    for (const [axis, text] of [['模型', 'Model One · x0.5 credits'], ['思考等级', 'Level One'], ['模式', 'Mode One']] as const) {
      const select = axisSelect(axis, 'CodeBuddy')
      const option = within(select).getByRole('option', { name: `默认（${text}）` }) as HTMLOptionElement
      expect(option.value).toBe('')
      // The parentheses spell the SAME label as the hit choice's own row.
      expect(option.textContent).toBe(`默认（${text}）`)
    }
  })

  it('the 默认 option stays plain 默认 while the catalog is unread', async () => {
    await mountDefaults({ ...BASE }, { catalogs: { codebuddy: null } })
    await category('子代理')
    // The fetch gesture proves the memory-only read settled as missing.
    await screen.findByRole('button', { name: '获取目录' })
    for (const axis of ['模型', '思考等级', '模式'] as const) {
      const select = axisSelect(axis, 'CodeBuddy')
      const option = within(select).getByRole('option', { name: '默认' }) as HTMLOptionElement
      expect(option.value).toBe('')
      expect(option.textContent).toBe('默认')
    }
  })

  it('the English locale spells Default (X) with the same resolved label', async () => {
    await mountDefaults({ ...BASE }, { catalogs: { codebuddy: knownCatalog }, locale: (zh, en) => en })
    await click(within(screen.getByRole('navigation', { name: 'NTR settings categories' })).getByRole('button', { name: 'Subagents' }))
    const model = screen.getByRole('combobox', { name: 'Model · CodeBuddy' }) as HTMLSelectElement
    await waitFor(() => expect(optionValues(model)).toContain('m1'))
    const option = within(model).getByRole('option', { name: 'Default (Model One · x0.5 credits)' }) as HTMLOptionElement
    expect(option.value).toBe('')
    expect(option.textContent).toBe('Default (Model One · x0.5 credits)')
  })

  // The real cached shape: same-name variants told apart ONLY by description,
  // and a process currentValue (hy4free) absent from the choice list.
  const hy4Catalog = (currentValue: string): AgentProbeModelsResult => ({
    agentId: 'codebuddy', updatedAt: 1,
    catalog: {
      model: {
        configId: 'model', name: 'Model', currentValue,
        choices: [
          { value: 'hy4std', name: 'Hy4 std', description: 'x0.01 credits' },
          { value: 'hy4flash-free', name: 'Hy4 flash', description: 'x0.00 credits' },
          { value: 'hy4flash', name: 'Hy4 flash', description: 'x0.03 credits' },
        ],
      },
    },
  })

  it('the parentheses match the hit row verbatim, description included', async () => {
    await mountDefaults({ ...BASE }, { catalogs: { codebuddy: hy4Catalog('hy4flash-free') } })
    await category('子代理')
    const model = axisSelect('模型', 'CodeBuddy')
    await waitFor(() => expect(optionValues(model)).toContain('hy4flash-free'))
    const option = within(model).getByRole('option', { name: '默认（Hy4 flash · x0.00 credits）' }) as HTMLOptionElement
    expect(option.value).toBe('')
    expect(option.textContent).toBe('默认（Hy4 flash · x0.00 credits）')
    const row = within(model).getByRole('option', { name: 'Hy4 flash · x0.00 credits' }) as HTMLOptionElement
    expect(row.value).toBe('hy4flash-free')
    expect(option.textContent).toBe(`默认（${row.textContent}）`)
  })

  it('same-name variants: currentValue pointing at the SECOND choice carries its description', async () => {
    await mountDefaults({ ...BASE }, { catalogs: { codebuddy: hy4Catalog('hy4flash') } })
    await category('子代理')
    const model = axisSelect('模型', 'CodeBuddy')
    await waitFor(() => expect(optionValues(model)).toContain('hy4flash'))
    const option = within(model).getByRole('option', { name: '默认（Hy4 flash · x0.03 credits）' }) as HTMLOptionElement
    expect(option.textContent).toBe('默认（Hy4 flash · x0.03 credits）')
    expect(within(model).queryByRole('option', { name: '默认（Hy4 flash · x0.00 credits）' })).toBeNull()
  })

  it('a hit without a description spells the bare name in parentheses', async () => {
    const catalog: AgentProbeModelsResult = { agentId: 'codebuddy', updatedAt: 1, catalog: { model: slot('plain', [{ value: 'plain', name: 'Plain' }]) } }
    await mountDefaults({ ...BASE }, { catalogs: { codebuddy: catalog } })
    await category('子代理')
    const model = axisSelect('模型', 'CodeBuddy')
    await waitFor(() => expect(optionValues(model)).toContain('plain'))
    expect((within(model).getByRole('option', { name: '默认（Plain）' }) as HTMLOptionElement).textContent).toBe('默认（Plain）')
  })

  it('a currentValue outside the choices spells the raw value marked 未在列表中 — no alias guessed', async () => {
    await mountDefaults({ ...BASE }, { catalogs: { codebuddy: hy4Catalog('hy4free') } })
    await category('子代理')
    const model = axisSelect('模型', 'CodeBuddy')
    await waitFor(() => expect(optionValues(model)).toContain('hy4flash-free'))
    const option = within(model).getByRole('option', { name: '默认（hy4free，未在列表中）' }) as HTMLOptionElement
    expect(option.value).toBe('')
    expect(option.textContent).toBe('默认（hy4free，未在列表中）')
    // The row's one visible line stays one line; the why lives in the hover
    // title instead (constraint 33).
    const hint = model.closest('label')?.title ?? ''
    expect(hint).toContain('hy4free')
    expect(hint).toContain('没有说明可显示')
    expect(screen.queryByText(/没有说明可显示/)).toBeNull()
  })

  it('the English locale marks the unlisted value "not listed"', async () => {
    await mountDefaults({ ...BASE }, { catalogs: { codebuddy: hy4Catalog('hy4free') }, locale: (zh, en) => en })
    await click(within(screen.getByRole('navigation', { name: 'NTR settings categories' })).getByRole('button', { name: 'Subagents' }))
    const model = screen.getByRole('combobox', { name: 'Model · CodeBuddy' }) as HTMLSelectElement
    await waitFor(() => expect(optionValues(model)).toContain('hy4flash-free'))
    const option = within(model).getByRole('option', { name: 'Default (hy4free, not listed)' }) as HTMLOptionElement
    expect(option.value).toBe('')
    expect(option.textContent).toBe('Default (hy4free, not listed)')
  })

  it('an unlisted raw value is budgeted together with the English wrapper and marker', async () => {
    const longId = `model-${'x'.repeat(80)}`
    const catalog: AgentProbeModelsResult = {
      agentId: 'codebuddy', updatedAt: 1,
      catalog: { model: slot(longId, [{ value: 'm1', name: 'Model One' }]) },
    }
    await mountDefaults({ ...BASE }, { catalogs: { codebuddy: catalog }, locale: (zh, en) => en })
    await click(within(screen.getByRole('navigation', { name: 'NTR settings categories' })).getByRole('button', { name: 'Subagents' }))
    const model = screen.getByRole('combobox', { name: 'Model · CodeBuddy' }) as HTMLSelectElement
    await waitFor(() => expect(optionValues(model)).toContain('m1'))
    const fallback = Array.from(model.options).find(option => option.value === '') as HTMLOptionElement
    expect(fallback.textContent?.endsWith(', not listed)')).toBe(true)
    // The English wrapper (10) is the widest one, and the marker's 12 columns
    // come out of the same budget — the row lands exactly on the option cap.
    expect(textColumns(fallback.textContent ?? '')).toBe(CHOICE_OPTION_MAX)
  })

  it('a long stale kept value is budgeted together with its 已失效 marker', async () => {
    const longId = `stale-${'y'.repeat(80)}`
    const catalog: AgentProbeModelsResult = {
      agentId: 'codebuddy', updatedAt: 1,
      catalog: { model: slot('m1', [{ value: 'm1', name: 'Model One' }]) },
    }
    await mountDefaults({ ...BASE, agentDefaults: { codebuddy: { model: longId } } }, { catalogs: { codebuddy: catalog } })
    await category('子代理')
    const model = axisSelect('模型', 'CodeBuddy')
    await waitFor(() => expect(optionValues(model)).toContain('m1'))
    const kept = Array.from(model.options).find(option => option.value === longId) as HTMLOptionElement
    expect(kept.textContent?.endsWith('（已失效）')).toBe(true)
    expect(textColumns(kept.textContent ?? '')).toBe(CHOICE_OPTION_MAX)
    for (const option of Array.from(model.options)) {
      expect(textColumns(option.textContent ?? '')).toBeLessThanOrEqual(CHOICE_OPTION_MAX)
    }
  })

  it('a paragraph-long mode description is capped in the row and in the 默认 parentheses', async () => {
    const auto = 'An AI reviewer checks each action that would otherwise ask for approval and approves or denies it. A failed review blocks only that action; it never falls back to a prompt or leaves auto mode.'
    const catalog: AgentProbeModelsResult = {
      agentId: 'codebuddy', updatedAt: 1,
      catalog: {
        mode: slot('auto', [
          { value: 'default', name: 'Always Ask', description: 'Prompts for permission on first use of each tool' },
          { value: 'auto', name: 'Auto', description: auto },
        ]),
      },
    }
    await mountDefaults({ ...BASE }, { catalogs: { codebuddy: catalog } })
    await category('子代理')
    const mode = axisSelect('模式', 'CodeBuddy')
    await waitFor(() => expect(optionValues(mode)).toContain('auto'))
    const row = Array.from(mode.options).find(option => option.value === 'auto') as HTMLOptionElement
    expect(textColumns(row.textContent ?? '')).toBeLessThanOrEqual(CHOICE_LABEL_MAX)
    expect(row.textContent?.endsWith('…')).toBe(true)
    const fallback = Array.from(mode.options).find(option => option.value === '') as HTMLOptionElement
    expect(fallback.textContent).toBe(`默认（${row.textContent}）`)
    // The popup sizes to the WIDEST option, decoration included — so the 默认
    // row (wrapper + row) must fit the same budget as an ordinary row.
    for (const option of Array.from(mode.options)) {
      expect(textColumns(option.textContent ?? '')).toBeLessThanOrEqual(CHOICE_OPTION_MAX)
    }
  })

  it('boolean slots and null/empty currentValue keep the option plain 默认', async () => {
    const catalog: AgentProbeModelsResult = {
      agentId: 'codebuddy', updatedAt: 1,
      catalog: {
        model: slot('true', [], 'boolean'),
        thought: slot(null, [{ value: 'e1', name: 'Level One' }]),
        mode: slot('', [{ value: 'o1', name: 'Mode One' }]),
      },
    }
    await mountDefaults({ ...BASE }, { catalogs: { codebuddy: catalog } })
    await category('子代理')
    // The mode row proves the catalog settled (a boolean model slot renders nothing).
    await waitFor(() => expect(optionValues(axisSelect('模式', 'CodeBuddy'))).toContain('o1'))
    for (const axis of ['模型', '思考等级', '模式'] as const) {
      const option = within(axisSelect(axis, 'CodeBuddy')).getByRole('option', { name: '默认' }) as HTMLOptionElement
      expect(option.value).toBe('')
      expect(option.textContent).toBe('默认')
    }
  })

  it('effort parentheses carry the description through the thoughtByModel path', async () => {
    const catalog: AgentProbeModelsResult = {
      agentId: 'codebuddy', updatedAt: 1,
      catalog: {
        model: slot('m1', [{ value: 'm1', name: 'Model One' }]),
        thoughtByModel: { m1: slot('deep', [{ value: 'deep', name: 'Deep', description: 'deeper thinking' }]) },
      },
    }
    await mountDefaults({ ...BASE }, { catalogs: { codebuddy: catalog } })
    await category('子代理')
    const effort = axisSelect('思考等级', 'CodeBuddy')
    await waitFor(() => expect(optionValues(effort)).toContain('deep'))
    const option = within(effort).getByRole('option', { name: '默认（Deep · deeper thinking）' }) as HTMLOptionElement
    expect(option.value).toBe('')
    expect(option.textContent).toBe('默认（Deep · deeper thinking）')
  })
})