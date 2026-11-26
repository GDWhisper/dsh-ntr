// @vitest-environment jsdom
// The delegation-defaults LABEL cluster: how one catalog value is spelled as
// text. `choiceLabel` / `clipChoiceText` / `textColumns` cap a row in display
// COLUMNS (a native <select> sizes its popup to the widest option, and one
// agent's paragraph-long mode description pushed the list past the dialog —
// user report, 2026-11-23); `resolvedAxisDefaultLabel` resolves the process
// default the「默认」option names in parentheses, and `processDefaultValue` is
// the raw-value core of that same read — the one the folded head's pill
// consumes.
//
// Split out of `subagent-defaults.spec.ts` when that file reached the 1000-line
// ratchet: describe titles and case counts moved verbatim, and the mounted
// assertions drive the same `mountDefaults` harness as its siblings.
import { cleanup, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { axisChoices, CHOICE_LABEL_MAX, CHOICE_OPTION_MAX, choiceLabel, clipChoiceText, processDefaultValue, resolvedAxisDefaultLabel, textColumns } from '../../src/client/panel/subagent-defaults.tsx'
import type { AcpAgentCatalog, AcpCatalogChoice, AcpCatalogOption, AgentProbeModelsResult } from '../../src/protocol.ts'
import { axisSelect, category, click, DELEGATE_BASE, hy4Catalog, mountDefaults, optionValues } from './harness.ts'

afterEach(cleanup)

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
    await mountDefaults({ ...DELEGATE_BASE }, { catalogs: { codebuddy: knownCatalog } })
    await category('子智能体')
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
    await mountDefaults({ ...DELEGATE_BASE }, { catalogs: { codebuddy: null } })
    await category('子智能体')
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
    await mountDefaults({ ...DELEGATE_BASE }, { catalogs: { codebuddy: knownCatalog }, locale: (zh, en) => en })
    await click(within(screen.getByRole('navigation', { name: 'NTR settings categories' })).getByRole('button', { name: 'Subagents' }))
    const model = screen.getByRole('combobox', { name: 'Model · CodeBuddy' }) as HTMLSelectElement
    await waitFor(() => expect(optionValues(model)).toContain('m1'))
    const option = within(model).getByRole('option', { name: 'Default (Model One · x0.5 credits)' }) as HTMLOptionElement
    expect(option.value).toBe('')
    expect(option.textContent).toBe('Default (Model One · x0.5 credits)')
  })

  // The real cached shape: same-name variants told apart ONLY by description,
  // and a process currentValue (hy4free) absent from the choice list.
  it('the parentheses match the hit row verbatim, description included', async () => {
    await mountDefaults({ ...DELEGATE_BASE }, { catalogs: { codebuddy: hy4Catalog('hy4flash-free') } })
    await category('子智能体')
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
    await mountDefaults({ ...DELEGATE_BASE }, { catalogs: { codebuddy: hy4Catalog('hy4flash') } })
    await category('子智能体')
    const model = axisSelect('模型', 'CodeBuddy')
    await waitFor(() => expect(optionValues(model)).toContain('hy4flash'))
    const option = within(model).getByRole('option', { name: '默认（Hy4 flash · x0.03 credits）' }) as HTMLOptionElement
    expect(option.textContent).toBe('默认（Hy4 flash · x0.03 credits）')
    expect(within(model).queryByRole('option', { name: '默认（Hy4 flash · x0.00 credits）' })).toBeNull()
  })

  it('a hit without a description spells the bare name in parentheses', async () => {
    const catalog: AgentProbeModelsResult = { agentId: 'codebuddy', updatedAt: 1, catalog: { model: slot('plain', [{ value: 'plain', name: 'Plain' }]) } }
    await mountDefaults({ ...DELEGATE_BASE }, { catalogs: { codebuddy: catalog } })
    await category('子智能体')
    const model = axisSelect('模型', 'CodeBuddy')
    await waitFor(() => expect(optionValues(model)).toContain('plain'))
    expect((within(model).getByRole('option', { name: '默认（Plain）' }) as HTMLOptionElement).textContent).toBe('默认（Plain）')
  })

  it('a currentValue outside the choices spells the raw value marked 未在列表中 — no alias guessed', async () => {
    await mountDefaults({ ...DELEGATE_BASE }, { catalogs: { codebuddy: hy4Catalog('hy4free') } })
    await category('子智能体')
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
    await mountDefaults({ ...DELEGATE_BASE }, { catalogs: { codebuddy: hy4Catalog('hy4free') }, locale: (zh, en) => en })
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
    await mountDefaults({ ...DELEGATE_BASE }, { catalogs: { codebuddy: catalog }, locale: (zh, en) => en })
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
    await mountDefaults({ ...DELEGATE_BASE, agentDefaults: { codebuddy: { model: longId } } }, { catalogs: { codebuddy: catalog } })
    await category('子智能体')
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
    await mountDefaults({ ...DELEGATE_BASE }, { catalogs: { codebuddy: catalog } })
    await category('子智能体')
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
    await mountDefaults({ ...DELEGATE_BASE }, { catalogs: { codebuddy: catalog } })
    await category('子智能体')
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
    await mountDefaults({ ...DELEGATE_BASE }, { catalogs: { codebuddy: catalog } })
    await category('子智能体')
    const effort = axisSelect('思考等级', 'CodeBuddy')
    await waitFor(() => expect(optionValues(effort)).toContain('deep'))
    const option = within(effort).getByRole('option', { name: '默认（Deep · deeper thinking）' }) as HTMLOptionElement
    expect(option.value).toBe('')
    expect(option.textContent).toBe('默认（Deep · deeper thinking）')
  })
})

describe('processDefaultValue — the raw value a 默认 selection resolves to', () => {
  const slot = (currentValue: string | null, choices: AcpCatalogChoice[] = [], kind?: 'boolean'): AcpCatalogOption => ({
    configId: 'slot', name: 'Slot', currentValue, choices, ...(kind === undefined ? {} : { kind }),
  })
  const modelOne: AcpCatalogChoice = { value: 'm1', name: 'Model One', description: 'x0.5 credits' }

  // The folded head's pill reads this directly and the dropdown's parentheses
  // read it through resolvedAxisDefaultLabel — one slot-selection rule, so the
  // unread / missing / boolean / empty cases are pinned HERE rather than twice.
  it('returns undefined for an unread catalog, a missing or boolean slot, and a null or empty currentValue', () => {
    for (const axis of ['model', 'effort', 'mode'] as const) {
      expect(processDefaultValue(undefined, axis, undefined)).toBeUndefined()
      expect(processDefaultValue({}, axis, undefined)).toBeUndefined()
      expect(processDefaultValue({ model: slot(null, [modelOne]) }, axis, undefined)).toBeUndefined()
    }
    expect(processDefaultValue({ model: slot('true', [], 'boolean') }, 'model', undefined)).toBeUndefined()
    expect(processDefaultValue({ mode: slot('') }, 'mode', undefined)).toBeUndefined()
    // A picked model never observed with the effort axis has no evidence either.
    expect(processDefaultValue({ model: slot('m1', [modelOne]) }, 'effort', 'm2')).toBeUndefined()
  })

  it('returns the currentValue even when no choice lists it — the pill spells it raw', () => {
    // CodeBuddy reports hy4free while offering hy4flash-free: the pill names the
    // value that will actually run, and axisValueName keeps it unaliased.
    expect(processDefaultValue({ model: slot('hy4free', [{ value: 'hy4flash-free', name: 'Hy4 flash' }]) }, 'model', undefined)).toBe('hy4free')
    expect(processDefaultValue({ model: slot('m1', [{ value: 'm1', name: '' }]) }, 'model', undefined)).toBe('m1')
  })

  it('effort reads the same effective-model slot as axisChoices (the label block pins the full map)', () => {
    const levels = slot('e1', [{ value: 'e1', name: 'Level One' }])
    const model = slot('m1', [modelOne])
    const mapped: AcpAgentCatalog = { model, thoughtByModel: { m1: levels, m2: null } }
    expect(processDefaultValue(mapped, 'effort', undefined)).toBe('e1')
    expect(processDefaultValue(mapped, 'effort', 'm2')).toBeUndefined()
    expect(processDefaultValue({ model, thought: levels }, 'effort', undefined)).toBe('e1')
  })
})
