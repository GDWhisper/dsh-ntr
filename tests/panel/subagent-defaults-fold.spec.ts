// @vitest-environment jsdom
// The delegation-defaults CARD itself — the figure the spec file next door
// (`subagent-defaults.spec.ts`) covers the axes and the catalog through.
// Three facts live only here: what the folded head summarises (the one thing the
// old row layout could not show without reading four controls and comparing
// them with「默认」), that a first visit arrives FOLDED — one summary line per
// agent, the form behind that agent's own head — and that folding is a display
// toggle rather than a remount (the description keeps a local draft that commits
// on blur, so unmounting it would drop what the user was typing).
import { cleanup, fireEvent, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { category, click, DELEGATE_BASE, mountDefaults } from './harness.ts'

afterEach(cleanup)

/** One agent's card: the body's own parent (the body is the only element with
 *  the derived id, and the card is what wraps it). */
function cardOf(agentId: string): HTMLElement {
  const body = document.getElementById(`dwa-delegate-defaults-${agentId}`)
  if (body?.parentElement == null) throw new Error(`no delegation-defaults card for ${agentId}`)
  return body.parentElement
}

/** The fold button: the card's one button, whichever name it ends up with. */
function headOf(agentId: string): HTMLElement {
  const head = cardOf(agentId).querySelector('button')
  if (head === null) throw new Error(`no fold button for ${agentId}`)
  return head
}

/** The summary pills inside one card's head. */
function pillsOf(agentId: string): HTMLElement {
  const pills = cardOf(agentId).querySelector('.dwa-acc-pills')
  if (pills === null) throw new Error(`no summary pills for ${agentId}`)
  return pills as HTMLElement
}

describe('SubagentDefaults — the card head', () => {
  it('summarises the axes this profile really sets, and says so when it sets none', async () => {
    await mountDefaults({
      ...DELEGATE_BASE,
      agentDefaults: { codebuddy: { model: 'deepseek-v3', effort: 'high', description: '只改单文件' } },
    }, { keepFolded: true })
    await category('子智能体')
    // Set axes are named; the description is a fact, not a value.
    const pills = pillsOf('codebuddy')
    expect(within(pills).getByText('模型 DeepSeek V3')).toBeDefined()
    expect(within(pills).getByText('等级 High')).toBeDefined()
    expect(within(pills).getByText('已填描述')).toBeDefined()
    expect(within(pills).queryByText('全部跟随进程默认')).toBeNull()
    // An agent with no entry says exactly that instead of showing three「默认」
    // pills that say nothing.
    expect(within(pillsOf('pi')).getByText('全部跟随进程默认')).toBeDefined()
    expect(within(pillsOf('pi')).queryByText(/^模型 /)).toBeNull()
  })

  it('flags a profile that outranks the config file on the folded head', async () => {
    await mountDefaults({
      ...DELEGATE_BASE,
      agentDefaults: { codebuddy: { model: 'deepseek-v3' } },
      configured: { agentDefaults: { codebuddy: { model: 'gpt-5' } } },
    }, { keepFolded: true })
    await category('子智能体')
    // Constraint 33: an override fact may not hide behind a click, and the head
    // is the only band a folded card shows — so the fact rides there too.
    expect(cardOf('codebuddy').querySelector('.dwa-acc-body')?.hasAttribute('hidden')).toBe(true)
    expect(within(pillsOf('codebuddy')).getByText('覆盖配置文件')).toBeDefined()
    expect(within(pillsOf('pi')).queryByText('覆盖配置文件')).toBeNull()
  })
})

describe('SubagentDefaults — folding one agent', () => {
  it('starts folded, folds without unmounting the form, and 全部展开 / 全部收起 drive every card', async () => {
    await mountDefaults({ ...DELEGATE_BASE }, { keepFolded: true })
    await category('子智能体')
    const body = (): HTMLElement | null => document.getElementById('dwa-delegate-defaults-codebuddy')
    // Folded on arrival: the section first answers "who can I delegate to, and
    // what does that agent override", and the form is one click away on that
    // agent's own head. Nothing is unmounted — the body is display-toggled.
    expect(headOf('codebuddy').getAttribute('aria-expanded')).toBe('false')
    expect(body()?.hasAttribute('hidden')).toBe(true)
    expect(headOf('pi').getAttribute('aria-expanded')).toBe('false')

    // The toggle-all control names the state in force: everything folded means
    // the offer is 全部展开.
    await click(screen.getByRole('button', { name: '全部展开' }))
    expect(headOf('codebuddy').getAttribute('aria-expanded')).toBe('true')
    expect(body()?.hasAttribute('hidden')).toBe(false)
    expect(document.getElementById('dwa-delegate-defaults-pi')?.hasAttribute('hidden')).toBe(false)

    // The description commits on blur, so its draft lives in the input alone:
    // folding must display-toggle the body, never unmount it.
    const input = screen.getByLabelText('描述（写给主智能体看） · CodeBuddy') as HTMLInputElement
    fireEvent.change(input, { target: { value: '正在编辑的草稿' } })
    await click(headOf('codebuddy'))
    expect(body()?.hasAttribute('hidden')).toBe(true)
    expect(headOf('codebuddy').getAttribute('aria-expanded')).toBe('false')
    expect(screen.getByLabelText('描述（写给主智能体看） · CodeBuddy')).toBe(input)
    expect((screen.getByLabelText('描述（写给主智能体看） · CodeBuddy') as HTMLInputElement).value).toBe('正在编辑的草稿')

    // One card folded is enough to offer 全部收起 again; it folds every card.
    await click(screen.getByRole('button', { name: '全部收起' }))
    expect(body()?.hasAttribute('hidden')).toBe(true)
    expect(document.getElementById('dwa-delegate-defaults-pi')?.hasAttribute('hidden')).toBe(true)
  })

  it('offers no toggle-all control for a lone agent, whose own head still opens the form', async () => {
    await mountDefaults({ ...DELEGATE_BASE }, {
      agents: [{ id: 'codebuddy', title: 'CodeBuddy', command: 'codebuddy', args: ['--acp'] }],
      keepFolded: true,
    })
    await category('子智能体')
    // The toggle-all control exists only when there is more than one card to
    // drive; with one agent its own head is the whole path — and folding is
    // still the state the card arrives in.
    expect(screen.queryByRole('button', { name: '全部展开' })).toBeNull()
    expect(screen.queryByRole('button', { name: '全部收起' })).toBeNull()
    expect(headOf('codebuddy').getAttribute('aria-expanded')).toBe('false')
    await click(headOf('codebuddy'))
    expect(headOf('codebuddy').getAttribute('aria-expanded')).toBe('true')
    expect(document.getElementById('dwa-delegate-defaults-codebuddy')?.hasAttribute('hidden')).toBe(false)
  })
})
