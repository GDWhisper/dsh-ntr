// @vitest-environment jsdom
// The delegation IDENTITY control and its seeding rule. The card's axes and the
// folded head live in the sibling specs (`subagent-defaults.spec.ts` /
// `subagent-defaults-fold.spec.ts`); what lives ONLY here is the tag itself —
// which presets the dropdown offers, when a preset seeds the description
// silently, and the keep-or-replace question when it must not.
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { DELEGATE_IDENTITY_PRESETS, identityFillDecision } from '../../src/client/panel/delegate-identity.tsx'
import { DELEGATE_BASE, category, click, mountDefaults, writes } from './harness.ts'

afterEach(cleanup)

const TITLE = 'CodeBuddy'

/** Pick one identity in the dropdown, the way a keyboard user would. */
async function pickIdentity(value: string): Promise<void> {
  await act(async () => {
    fireEvent.change(screen.getByRole('combobox', { name: `身份 · ${TITLE}` }), { target: { value } })
  })
}

/** The value the「自定义身份…」option carries (the control keeps it private). */
function customOptionValue(): string {
  const select = screen.getByRole('combobox', { name: `身份 · ${TITLE}` }) as HTMLSelectElement
  return select.options[select.options.length - 1].value
}

function presetText(identity: string): string {
  const preset = DELEGATE_IDENTITY_PRESETS.find(row => row.identity === identity)
  if (preset === undefined) throw new Error(`no preset named ${identity}`)
  return preset.description
}

describe('the identity seeding rule', () => {
  it('seeds when there is nothing to destroy', () => {
    // A blank description is the whole point of a preset.
    expect(identityFillDecision('code-reviewer', undefined, undefined)).toBe('fill')
    expect(identityFillDecision('code-reviewer', undefined, '   ')).toBe('fill')
    // Swapping one preset for another is not losing user work: the text on
    // screen is still the CURRENT identity's own seed.
    expect(identityFillDecision('Research', 'code-reviewer', presetText('code-reviewer'))).toBe('fill')
  })

  it('asks when the description is the user’s own', () => {
    expect(identityFillDecision('Research', 'code-reviewer', '只改单文件，别碰测试')).toBe('confirm')
    // Another preset's text under a CUSTOM identity is still user text.
    expect(identityFillDecision('code-reviewer', '我的标签', presetText('Research'))).toBe('confirm')
  })

  it('leaves the description alone when there is nothing to seed', () => {
    // A custom tag carries no preset text, and clearing the tag never reaches
    // this rule at all.
    expect(identityFillDecision('运维值守', 'code-reviewer', '我自己的描述')).toBe('none')
    // A preset whose own text is empty has nothing to seed either.
    expect(identityFillDecision('code-reviewer', 'Research', '我自己的描述')).toBe('confirm')
  })
})

describe('the identity control', () => {
  it('offers the presets plus 自定义… in one dropdown, with a placeholder while nothing is set', async () => {
    await mountDefaults({ ...DELEGATE_BASE }, {})
    await category('子智能体')
    const select = screen.getByRole('combobox', { name: `身份 · ${TITLE}` }) as HTMLSelectElement
    // Nothing set: a DISABLED placeholder stands in. A select whose value
    // matches no option renders an empty box and looks broken, so the
    // placeholder carries the same '' value — while clearing stays impossible
    // until something is actually set.
    const placeholder = select.options[0]
    expect(placeholder.value).toBe('')
    expect(placeholder.disabled).toBe(true)
    expect(placeholder.textContent).toBe('未设置身份…')
    for (const preset of DELEGATE_IDENTITY_PRESETS) {
      expect(Array.from(select.options).some(option => option.value === preset.identity)).toBe(true)
    }
    expect(select.options[select.options.length - 1].textContent).toBe('自定义身份…')
  })

  it('seeds the description from the preset in ONE write', async () => {
    const { calls } = await mountDefaults({ ...DELEGATE_BASE }, {})
    await category('子智能体')
    await pickIdentity('code-reviewer')
    await waitFor(() => expect(writes(calls, 'ui/delegate-set')).toHaveLength(1))
    expect(writes(calls, 'ui/delegate-set')[0]).toEqual({
      agentDefaults: { codebuddy: { identity: 'code-reviewer', description: presetText('code-reviewer') } },
    })
    // The seeded text lands in the description input's own draft, so the user
    // sees what the caller will read.
    await waitFor(() => {
      expect((screen.getByRole('textbox', { name: `描述（写给主智能体看） · ${TITLE}` }) as HTMLInputElement).value)
        .toBe(presetText('code-reviewer'))
    })
  })

  it('swaps one preset for another without asking', async () => {
    const { calls } = await mountDefaults({
      ...DELEGATE_BASE,
      agentDefaults: { codebuddy: { identity: 'code-reviewer', description: presetText('code-reviewer') } },
    }, {})
    await category('子智能体')
    await pickIdentity('Research')
    await waitFor(() => expect(writes(calls, 'ui/delegate-set')).toHaveLength(1))
    expect(writes(calls, 'ui/delegate-set')[0]).toEqual({
      agentDefaults: { codebuddy: { identity: 'Research', description: presetText('Research') } },
    })
    expect(screen.queryByRole('alertdialog')).toBeNull()
  })

  it('asks before replacing a description the user wrote, and 不替换 keeps it', async () => {
    const { calls } = await mountDefaults({
      ...DELEGATE_BASE,
      agentDefaults: { codebuddy: { identity: 'code-reviewer', description: '只改单文件，别碰测试' } },
    }, {})
    await category('子智能体')
    await pickIdentity('Research')
    // The question shows BOTH texts: the one that would be lost and the one
    // that would replace it. Nothing is written before the user answers.
    const dialog = screen.getByRole('alertdialog', { name: '替换描述' })
    expect(within(dialog).getByText(presetText('Research'))).toBeDefined()
    expect(within(dialog).getByText('只改单文件，别碰测试')).toBeDefined()
    expect(writes(calls, 'ui/delegate-set')).toHaveLength(0)

    await click(within(dialog).getByRole('button', { name: '不替换' }))
    await waitFor(() => expect(writes(calls, 'ui/delegate-set')).toHaveLength(1))
    expect(writes(calls, 'ui/delegate-set')[0]).toEqual({
      agentDefaults: { codebuddy: { identity: 'Research', description: '只改单文件，别碰测试' } },
    })
    expect(screen.queryByRole('alertdialog')).toBeNull()
  })

  it('替换 writes the identity and the preset description together', async () => {
    const { calls } = await mountDefaults({
      ...DELEGATE_BASE,
      agentDefaults: { codebuddy: { identity: 'code-reviewer', description: '只改单文件，别碰测试' } },
    }, {})
    await category('子智能体')
    await pickIdentity('Research')
    await click(within(screen.getByRole('alertdialog', { name: '替换描述' })).getByRole('button', { name: '替换' }))
    await waitFor(() => expect(writes(calls, 'ui/delegate-set')).toHaveLength(1))
    expect(writes(calls, 'ui/delegate-set')[0]).toEqual({
      agentDefaults: { codebuddy: { identity: 'Research', description: presetText('Research') } },
    })
  })

  it('re-picking the current tag writes nothing', async () => {
    const { calls } = await mountDefaults({
      ...DELEGATE_BASE,
      agentDefaults: { codebuddy: { identity: 'Research', description: presetText('Research') } },
    }, {})
    await category('子智能体')
    await pickIdentity('Research')
    expect(writes(calls, 'ui/delegate-set')).toHaveLength(0)
  })

  it('自定义 opens a text input that commits on blur, and an empty commit keeps the tag', async () => {
    const { calls } = await mountDefaults({ ...DELEGATE_BASE }, {})
    await category('子智能体')
    await pickIdentity(customOptionValue())
    const input = screen.getByRole('textbox', { name: `身份（自定义） · ${TITLE}` }) as HTMLInputElement
    await act(async () => { fireEvent.change(input, { target: { value: '运维值守' } }) })
    await act(async () => { fireEvent.blur(input) })
    await waitFor(() => expect(writes(calls, 'ui/delegate-set')).toHaveLength(1))
    expect(writes(calls, 'ui/delegate-set')[0]).toEqual({ agentDefaults: { codebuddy: { identity: '运维值守' } } })
    expect(screen.queryByRole('textbox', { name: `身份（自定义） · ${TITLE}` })).toBeNull()

    // An accidental blur with nothing typed must not unset what is there.
    cleanup()
    const { calls: second } = await mountDefaults({
      ...DELEGATE_BASE,
      agentDefaults: { codebuddy: { identity: '运维值守' } },
    }, {})
    await category('子智能体')
    await pickIdentity(customOptionValue())
    const again = screen.getByRole('textbox', { name: `身份（自定义） · ${TITLE}` }) as HTMLInputElement
    expect(again.value).toBe('运维值守') // the draft opens on the stored tag
    await act(async () => { fireEvent.change(again, { target: { value: '' } }) })
    await act(async () => { fireEvent.blur(again) })
    expect(writes(second, 'ui/delegate-set')).toHaveLength(0)
  })

  it('keeps a persisted custom value selectable and spells it back', async () => {
    await mountDefaults({ ...DELEGATE_BASE, agentDefaults: { codebuddy: { identity: '运维值守' } } }, {})
    await category('子智能体')
    const select = screen.getByRole('combobox', { name: `身份 · ${TITLE}` }) as HTMLSelectElement
    // The kept option spells the value itself (AxisSelect's idiom): the user
    // reads back what is stored instead of a "custom" placeholder.
    expect(select.options[select.options.length - 1].textContent).toBe('运维值守')
    expect(Array.from(select.options).some(option => option.value === '')).toBe(true) // 未设置 is now an offer
  })

  it('未设置 clears the tag and leaves the description alone', async () => {
    const { calls } = await mountDefaults({
      ...DELEGATE_BASE,
      agentDefaults: { codebuddy: { identity: 'Research', description: presetText('Research') } },
    }, {})
    await category('子智能体')
    await pickIdentity('')
    await waitFor(() => expect(writes(calls, 'ui/delegate-set')).toHaveLength(1))
    expect(writes(calls, 'ui/delegate-set')[0]).toEqual({
      agentDefaults: { codebuddy: { description: presetText('Research') } },
    })
  })

  it('commits a custom identity on Enter as well as on blur', async () => {
    const { calls } = await mountDefaults({ ...DELEGATE_BASE }, {})
    await category('子智能体')
    await pickIdentity(customOptionValue())
    const input = screen.getByRole('textbox', { name: `身份（自定义） · ${TITLE}` }) as HTMLInputElement
    await act(async () => { fireEvent.change(input, { target: { value: '运维值守' } }) })
    await act(async () => { fireEvent.keyDown(input, { key: 'Enter' }) })
    await waitFor(() => expect(writes(calls, 'ui/delegate-set')).toHaveLength(1))
    expect(writes(calls, 'ui/delegate-set')[0]).toEqual({ agentDefaults: { codebuddy: { identity: '运维值守' } } })
  })

  it('asks before a preset can overwrite a description the user is still typing', async () => {
    const { calls } = await mountDefaults({ ...DELEGATE_BASE }, {})
    await category('子智能体')
    // Type into the description WITHOUT blurring, then pick a preset. The
    // decision must see the live draft: a silent fill would swallow text the
    // user can see on screen and has not committed.
    const input = screen.getByRole('textbox', { name: `描述（写给主智能体看） · ${TITLE}` }) as HTMLInputElement
    await act(async () => { fireEvent.change(input, { target: { value: '正在写，还没提交' } }) })
    await pickIdentity('code-reviewer')
    const dialog = screen.getByRole('alertdialog', { name: '替换描述' })
    expect(within(dialog).getByText('正在写，还没提交')).toBeDefined()
    expect(writes(calls, 'ui/delegate-set')).toHaveLength(0)
  })

  it('retires an open question when the pick changes again', async () => {
    const { calls } = await mountDefaults({
      ...DELEGATE_BASE,
      agentDefaults: { codebuddy: { description: '我自己的描述' } },
    }, {})
    await category('子智能体')
    await pickIdentity('code-reviewer')
    expect(screen.getByRole('alertdialog', { name: '替换描述' })).toBeDefined()
    // Moving off the pick must close the old question: its buttons would
    // otherwise write back an identity the user has already left. (The custom
    // branch carries no preset text, so it opens no question of its own.)
    await pickIdentity(customOptionValue())
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(writes(calls, 'ui/delegate-set')).toHaveLength(0)
  })

  it('names the config file’s identity in the override line', async () => {
    await mountDefaults({
      ...DELEGATE_BASE,
      agentDefaults: { codebuddy: { model: 'deepseek-v3' } },
      configured: { agentDefaults: { codebuddy: { identity: 'code-reviewer' } } },
    }, {})
    await category('子智能体')
    // The override fact must name what the config file actually asks for: a row
    // claiming「全部默认」while the file names an identity is a lie (constraint 33).
    await waitFor(() => {
      expect(screen.getByText(/配置文件要求：/).textContent).toContain('身份 code-reviewer')
    })
  })
})
