// @vitest-environment jsdom
// The delegation-defaults CARD itself — the figure the spec file next door
// (`subagent-defaults.spec.ts`) covers the axes and the catalog through.
// Three facts live only here: what the folded head summarises (one pill per
// axis naming the value that will actually run — the profile's own pick
// highlighted, the agent process's current value plain), that a first visit
// arrives FOLDED — one summary line per agent, the form behind that agent's
// own head — and that folding is a display toggle rather than a remount (the
// description keeps a local draft that commits on blur, so unmounting it would
// drop what the user was typing).
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { category, click, DELEGATE_BASE, hy4Catalog, mountDefaults } from './harness.ts'

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
  it('names every axis’s effective value on the folded head — the profile’s pick highlighted, the process default plain', async () => {
    await mountDefaults({
      ...DELEGATE_BASE,
      agentDefaults: { codebuddy: { model: 'deepseek-v3', effort: 'high', description: '只改单文件' } },
    }, { keepFolded: true })
    await category('子智能体')
    // The head answers "what will this agent run with" without opening the
    // card: the two axes this profile sets are named AND highlighted, so the
    // override stays visible at a glance. The cached catalog arrives on its own
    // async read, so the name resolution is awaited rather than assumed.
    const pills = pillsOf('codebuddy')
    await waitFor(() => {
      expect(within(pills).getByText('模型 DeepSeek V3').className).toContain('is-set')
      expect(within(pills).getByText('等级 High').className).toContain('is-set')
    })
    expect(within(pills).getByText('已填描述')).toBeDefined()
    // CodeBuddy publishes no mode slot, so no mode pill is invented, and a head
    // that named three values no longer needs the catch-all sentence.
    expect(within(pills).queryByText(/^模式 /)).toBeNull()
    expect(within(pills).queryByText('全部跟随进程默认')).toBeNull()
    // pi sets nothing: its model pill names the PROCESS value the cached
    // catalog reports, plain — no longer waiting for the user to override.
    const piPills = pillsOf('pi')
    await waitFor(() => expect(within(piPills).getByText('模型 GPT-5')).toBeDefined())
    expect(within(piPills).getByText('模型 GPT-5').className).not.toContain('is-set')
    // pi publishes no thought / mode slot either, so those axes stay silent
    // instead of showing a raw-id pill.
    expect(within(piPills).queryByText(/^等级 /)).toBeNull()
    expect(within(piPills).queryByText(/^模式 /)).toBeNull()
    expect(within(piPills).queryByText('全部跟随进程默认')).toBeNull()
  })

  it('mixes a highlighted set axis with a plain inherited one on the same head', async () => {
    await mountDefaults({ ...DELEGATE_BASE, agentDefaults: { codebuddy: { effort: 'high' } } }, { keepFolded: true })
    await category('子智能体')
    const pills = pillsOf('codebuddy')
    // The model follows the process — named from the cached catalog, plain; the
    // level is this profile's own pick — highlighted. Both name resolutions
    // wait for the catalog's async read.
    await waitFor(() => {
      expect(within(pills).getByText('模型 DeepSeek V3').className).not.toContain('is-set')
      expect(within(pills).getByText('等级 High').className).toContain('is-set')
    })
    expect(within(pills).queryByText('全部跟随进程默认')).toBeNull()
  })

  it('spells a process value the agent never listed as the raw id, never an alias', async () => {
    // CodeBuddy reports hy4free as current while its own list offers
    // hy4flash-free: the pill names the value that will actually run, and no
    // same-name variant is ever guessed in its place.
    await mountDefaults({ ...DELEGATE_BASE }, { catalogs: { codebuddy: hy4Catalog('hy4free') }, keepFolded: true })
    await category('子智能体')
    await waitFor(() => expect(within(pillsOf('codebuddy')).getByText('模型 hy4free')).toBeDefined())
    expect(within(pillsOf('codebuddy')).queryByText('模型 Hy4 flash')).toBeNull()
    expect(within(pillsOf('codebuddy')).getByText('模型 hy4free').className).not.toContain('is-set')
  })

  it('keeps the one fallback sentence for an agent whose catalog names no value on any axis', async () => {
    // A snapshot that was READ but carries no slot at all — what an agent with no
    // configOptions reports. The read settles, and there is still nothing to name.
    await mountDefaults({ ...DELEGATE_BASE }, {
      catalogs: { pi: { agentId: 'pi', updatedAt: 1, catalog: {} } },
      keepFolded: true,
    })
    await category('子智能体')
    // codebuddy's snapshot names its process values…
    await waitFor(() => expect(within(pillsOf('codebuddy')).getByText('模型 DeepSeek V3')).toBeDefined())
    expect(within(pillsOf('codebuddy')).queryByText('全部跟随进程默认')).toBeNull()
    // …and pi's read provably settled — its footer gesture flipped from
    // 「获取目录」 to 「刷新目录」 — with nothing on any axis, so the head says so
    // in one sentence rather than inventing a pill (constraint 8: no probe).
    await within(cardOf('pi')).findByRole('button', { name: '刷新目录', hidden: true })
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

  it('toggles delegation participation via the head pill switch without folding, keeping saved settings intact', async () => {
    const { store, calls } = await mountDefaults({
      ...DELEGATE_BASE,
      agentDefaults: { codebuddy: { model: 'deepseek-v3', description: '只改单文件' } },
    }, { keepFolded: true })
    await category('子智能体')
    const toggle = screen.getByRole('checkbox', { name: '参与子智能体委派 · CodeBuddy' }) as HTMLInputElement
    expect(toggle.checked).toBe(true)
    expect(headOf('codebuddy').getAttribute('aria-expanded')).toBe('false')

    // Disable: writes enabled: false while preserving model/description, does not unfold the card.
    await click(toggle)
    await waitFor(() => expect(store.getSnapshot().delegate?.agentDefaults?.codebuddy).toEqual({
      model: 'deepseek-v3', description: '只改单文件', enabled: false,
    }))
    expect(headOf('codebuddy').getAttribute('aria-expanded')).toBe('false')
    expect(cardOf('codebuddy').querySelector('.dwa-acc-head')?.className).toContain('is-disabled')
    const pills = pillsOf('codebuddy')
    expect(within(pills).getByText('已禁用')).toBeDefined()
    expect(within(pills).queryByText('模型 DeepSeek V3')).toBeNull()
    expect(within(pills).queryByText('已填描述')).toBeNull()

    // Re-enable: drops enabled while restoring the preserved summary pills.
    await click(toggle)
    await waitFor(() => expect(store.getSnapshot().delegate?.agentDefaults?.codebuddy).toEqual({
      model: 'deepseek-v3', description: '只改单文件',
    }))
    expect(within(pillsOf('codebuddy')).getByText('模型 DeepSeek V3')).toBeDefined()
    expect(within(pillsOf('codebuddy')).getByText('已填描述')).toBeDefined()
    expect(calls.some(call => call.endpoint === 'agent/save')).toBe(false)
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
