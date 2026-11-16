// @vitest-environment jsdom
/**
 * The settings page's two `dsh-skills` MCP switches: the fixed copy, the
 * focusable info icon behind the host `Tooltip`, the capsule switch both levels
 * share, the write each one sends, and where each one lives (BOTH levels on the
 * 技能 page — the master card, then the per-agent opt-outs listed under it; no
 * agent card carries the switch any more).
 *
 * Copy is asserted VERBATIM against docs/plan/dsh-skills-mcp.md §7.2 and §13.2 —
 * the tooltip may not be reworded into "starts the process on first call" or
 * "stops the MCP immediately", and the row's warning must keep naming the master
 * switch as the gate.
 */
import { createElement } from 'react'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AcpSettingsSection } from '../src/client/panel.tsx'
import { AgentSkillsMcpRow, SkillsMcpPreference } from '../src/client/skills-mcp-preference.tsx'
import type { AcpStore, UiState } from '../src/client/store.ts'
import { createPanelFixture } from './panel-fixture.ts'

afterEach(cleanup)

const TITLE = 'DSH 技能发现'
const MASTER_LABEL = '对所有智能体开放'
const EXPLANATION = '智能体可以获取 DSH 原生技能列表（只读，按需发现）。'
const DETAIL = '技能说明只在智能体用到时读取，平时不扫描。开关只对新建或重新加载的对话生效；旧对话保持关闭前的状态。'
const AGENT_COPY = '对这个智能体开放'
const MASTER_OFF = '总开关目前处于关闭状态，开启后生效。'

/**
 * A row's switch is named by the scope copy over that agent: no row spells the
 * copy out in visible text any more, so without the name every switch in the
 * list would read as a bare agent name and no screen reader could tell what it
 * does.
 */
const rowBox = (agent: string) => `对 ${agent} 开放`

/** Only the write surfaces these components use; nothing else is reached. */
function fakeStore(master?: boolean) {
  const setSkillsMcpEnabled = vi.fn(async (_value: boolean) => {})
  const setAgentSkillsMcp = vi.fn(async (_agentId: string, _value: boolean) => {})
  const acp = { setSkillsMcpEnabled, setAgentSkillsMcp, label: (zh: string) => zh } as unknown as AcpStore
  const ui = { skillsMcpEnabled: master } as UiState
  return { acp, ui, setSkillsMcpEnabled, setAgentSkillsMcp }
}

/** The 技能 page's section, so assertions never see the hidden 智能体 page. */
function skillsSection(): HTMLElement {
  return screen.getByRole('heading', { name: TITLE }).closest('section') as HTMLElement
}

/** The list under the master card, or null when the roster is empty. */
function skillsList(section: HTMLElement): HTMLElement | null {
  return section.querySelector('.dwa-skills-agents')
}

async function openSkillsPage(store: AcpStore): Promise<void> {
  render(createElement(AcpSettingsSection, { acp: store }))
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '技能' })) })
}

describe('the skills MCP master card', () => {
  it('is one row: the capability and its copy on the left, the switch on the right', async () => {
    const { acp, ui, setSkillsMcpEnabled } = fakeStore(false)
    render(createElement(SkillsMcpPreference, { acp, ui, agents: [] }))
    const card = skillsSection().querySelector('.dwa-skills-card') as HTMLElement
    // The left half names the capability and says what it does, on one line.
    const text = card.querySelector('.dwa-skills-card-text') as HTMLElement
    expect(within(text).getByRole('heading', { name: TITLE })).toBeTruthy()
    expect(within(text).getByText(EXPLANATION)).toBeTruthy()
    // The right half is the switch and the icon that explains it — and the
    // visible label text is gone: the layout carries the meaning now.
    const control = card.querySelector('.dwa-skills-card-control') as HTMLElement
    expect(control.querySelector('.dwa-info-btn')).toBeTruthy()
    expect(control.querySelector('.dwa-pill')).toBeTruthy()
    expect(within(card).queryByText(MASTER_LABEL)).toBeNull()
    // The switch itself: a real checkbox, off, and it writes on click.
    const toggle = within(card).getByRole('checkbox', { name: MASTER_LABEL }) as HTMLInputElement
    expect(toggle.type).toBe('checkbox')
    expect(toggle.checked).toBe(false)
    await act(async () => { fireEvent.click(toggle) })
    expect(setSkillsMcpEnabled).toHaveBeenCalledTimes(1)
    expect(setSkillsMcpEnabled).toHaveBeenCalledWith(true)
  })

  it('renders an unread value as off and never as on', () => {
    const { acp, ui } = fakeStore(undefined)
    render(createElement(SkillsMcpPreference, { acp, ui, agents: [] }))
    expect((screen.getByRole('checkbox', { name: MASTER_LABEL }) as HTMLInputElement).checked).toBe(false)
  })

  it('draws the switch as a capsule: a track, a knob, and a checkbox over both', () => {
    const { acp, ui } = fakeStore(true)
    render(createElement(SkillsMcpPreference, { acp, ui, agents: [] }))
    const pill = screen.getByRole('checkbox', { name: MASTER_LABEL }).closest('.dwa-pill') as HTMLElement
    // The track carries the knob; the real checkbox covers the whole pill, so
    // pointer, keyboard and assistive tech keep the platform's own behaviour.
    const track = pill.querySelector('.dwa-pill-track') as HTMLElement
    expect(track.querySelector('.dwa-pill-knob')).toBeTruthy()
    const box = within(pill).getByRole('checkbox') as HTMLInputElement
    expect(box.checked).toBe(true)
    // The sibling order is the CSS's contract: `.dwa-pill input:checked +
    // .dwa-pill-track` and the focus-ring rule both hang off it.
    expect(box.nextElementSibling).toBe(track)
  })

  it('puts the mechanism in the host Tooltip behind a focusable button', async () => {
    const { acp, ui } = fakeStore(true)
    render(createElement(SkillsMcpPreference, { acp, ui, agents: [] }))
    const info = screen.getByRole('button', { name: '关于 DSH 技能发现' })
    // A real button: keyboard users can reach the tooltip by focusing it.
    expect(info.tagName).toBe('BUTTON')
    expect((info as HTMLButtonElement).type).toBe('button')
    info.focus()
    expect(document.activeElement).toBe(info)
    // The test stub renders the tooltip label inline; the wording is the plan's.
    expect(screen.getByText(DETAIL)).toBeTruthy()
  })

  it('owns the 技能 page alone: no agent card carries either switch', async () => {
    const fixture = createPanelFixture()
    await fixture.ready
    render(createElement(AcpSettingsSection, { acp: fixture.store }))
    // The 智能体 page manages agents: the deployment-wide card is not on it…
    expect(screen.queryByRole('heading', { name: TITLE })).toBeNull()
    expect(screen.queryByRole('checkbox', { name: MASTER_LABEL })).toBeNull()
    // …and an agent's 「高级」 page no longer holds the per-agent switch.
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '管理 CodeBuddy' })) })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '高级' })) })
    expect(screen.queryByRole('checkbox', { name: rowBox('CodeBuddy') })).toBeNull()
    // The 技能 page carries the master card with its copy and info button.
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '技能' })) })
    expect(screen.getByRole('heading', { name: TITLE })).toBeTruthy()
    expect(screen.getByText(EXPLANATION)).toBeTruthy()
    expect(screen.getByRole('checkbox', { name: MASTER_LABEL })).toBeTruthy()
    expect(screen.getByRole('button', { name: '关于 DSH 技能发现' })).toBeTruthy()
  })
})

describe('the skills page agent list', () => {
  it('lists only the added agents, in the 智能体 page order', async () => {
    const fixture = createPanelFixture()
    await fixture.ready
    await openSkillsPage(fixture.store)
    const section = skillsSection()
    const list = skillsList(section) as HTMLElement
    // The fixture's roster: CodeBuddy and pi are added, 「Oh My Pi」 is only a
    // preset — it belongs to the add panel, not to this list.
    expect(within(section).getByText('CodeBuddy')).toBeTruthy()
    expect(within(section).getByText('pi')).toBeTruthy()
    expect(within(section).queryByText('Oh My Pi')).toBeNull()
    // The order is the roster's own, so the two pages never disagree.
    expect([...list.querySelectorAll('.dwa-preference-label')].map(node => node.textContent))
      .toEqual(['pi', 'CodeBuddy'])
    // Two rows, one switch each, and each one named by its own agent: in a
    // bare list the surrounding card no longer says which agent a row is.
    expect(within(section).getByRole('checkbox', { name: rowBox('pi') })).toBeTruthy()
    expect(within(section).getByRole('checkbox', { name: rowBox('CodeBuddy') })).toBeTruthy()
    // The warning slot is always mounted and hidden with `visibility`: it keeps
    // its width so a pop never reflows the row, and stays out of the tab order
    // and the accessibility tree until it warns.
    const slots = list.querySelectorAll('.dwa-skills-warn')
    expect(slots).toHaveLength(2)
    for (const slot of slots) {
      expect((slot as HTMLElement).style.visibility).toBe('hidden')
    }
    expect(within(section).queryByRole('button', { name: MASTER_OFF })).toBeNull()
  })

  it('keeps each row to the name and its switch, with no label text', async () => {
    const fixture = createPanelFixture()
    await fixture.ready
    await openSkillsPage(fixture.store)
    const list = skillsList(skillsSection()) as HTMLElement
    const rows = [...list.querySelectorAll('.dwa-preference-row')]
    expect(rows).toHaveLength(2)
    for (const row of rows) {
      const line = row as HTMLElement
      // Left: the name. Right: the capsule switch. The scope copy is gone.
      expect(line.querySelector('.dwa-preference-label')).toBeTruthy()
      expect(line.querySelector('.dwa-pill')).toBeTruthy()
      expect(within(line).queryByText(AGENT_COPY)).toBeNull()
    }
  })

  it('gives both levels the same capsule switch', async () => {
    const fixture = createPanelFixture({ skillsMcp: true })
    await fixture.ready
    await openSkillsPage(fixture.store)
    const section = skillsSection()
    // One track per level: the master, plus one under it per agent.
    expect(section.querySelectorAll('.dwa-pill-track')).toHaveLength(3)
    for (const pill of section.querySelectorAll('.dwa-pill')) {
      expect((pill as HTMLElement).querySelector('.dwa-pill-knob')).toBeTruthy()
    }
  })

  it('is just the master card when no agent is added', async () => {
    const fixture = createPanelFixture({ agents: [] })
    await fixture.ready
    await openSkillsPage(fixture.store)
    const section = skillsSection()
    // No empty-state copy and no add entry: an empty roster is the 智能体 page's
    // business, so this page shows the master switch and stops.
    expect(skillsList(section)).toBeNull()
    expect(within(section).queryByRole('checkbox', { name: rowBox('CodeBuddy') })).toBeNull()
    expect(within(section).queryByText(AGENT_COPY)).toBeNull()
    expect(within(section).getByRole('checkbox', { name: MASTER_LABEL })).toBeTruthy()
  })

  it('writes the per-agent answer through the lightweight RPC, never through a save', async () => {
    const fixture = createPanelFixture()
    await fixture.ready
    await openSkillsPage(fixture.store)
    const section = skillsSection()
    const box = within(section).getByRole('checkbox', { name: rowBox('pi') }) as HTMLInputElement
    // Unset means offered: only an explicit opt-out reaches the row as off.
    expect(box.checked).toBe(true)
    await act(async () => { fireEvent.click(box) })
    expect(fixture.calls.filter(call => call.endpoint === 'agent/set-skills-mcp').map(call => call.payload))
      .toEqual([{ agentId: 'pi', skillsMcpEnabled: false }])
    // A plain setting: no agent save was issued along the way.
    expect(fixture.calls.some(call => call.endpoint === 'agent/save')).toBe(false)
    // The host's re-read answer is what the switch keeps.
    expect((within(section).getByRole('checkbox', { name: rowBox('pi') }) as HTMLInputElement).checked).toBe(false)
  })

  it('never warns from a click made while the master is on, not even after it goes off', async () => {
    const fixture = createPanelFixture({ skillsMcp: true })
    await fixture.ready
    await openSkillsPage(fixture.store)
    const section = skillsSection()
    const box = within(section).getByRole('checkbox', { name: rowBox('CodeBuddy') }) as HTMLInputElement
    await act(async () => { fireEvent.click(box) })
    // The write goes through; only the warning is withheld, because the master
    // was on when the user acted.
    expect(fixture.calls.filter(call => call.endpoint === 'agent/set-skills-mcp').map(call => call.payload))
      .toEqual([{ agentId: 'codebuddy', skillsMcpEnabled: false }])
    expect(within(section).queryByRole('button', { name: MASTER_OFF })).toBeNull()
    // Turning the master off must not warn on its own — the row the user touched
    // earlier, while it was on, is exactly the case that must stay silent.
    await act(async () => { fireEvent.click(within(section).getByRole('checkbox', { name: MASTER_LABEL })) })
    expect(within(section).queryByRole('button', { name: MASTER_OFF })).toBeNull()
  })
})

describe('the per-agent row with the master switch off', () => {
  it('warns only once the user turns the row on, and forgets it when the master is on', () => {
    const { acp } = fakeStore(false)
    const view = render(createElement(AgentSkillsMcpRow, {
      acp, agentId: 'codebuddy', name: 'CodeBuddy', enabled: false, masterOn: false,
    }))
    const warning = (): HTMLElement | null => screen.queryByRole('button', { name: MASTER_OFF })
    // The master being off says nothing on its own.
    expect(warning()).toBeNull()
    const box = screen.getByRole('checkbox', { name: rowBox('CodeBuddy') }) as HTMLInputElement
    // A row the user may still act on: no `disabled`, no dimming class.
    expect(box.disabled).toBe(false)
    expect(box.className).not.toMatch(/is-off|dim|disabled/)
    act(() => { fireEvent.click(box) })
    expect(warning()).not.toBeNull()
    // Master back on: the warning goes, and a later flip off starts silent again.
    const row = (masterOn: boolean) => createElement(AgentSkillsMcpRow, {
      acp, agentId: 'codebuddy', name: 'CodeBuddy', enabled: true, masterOn,
    })
    view.rerender(row(true))
    expect(warning()).toBeNull()
    view.rerender(row(false))
    expect(warning()).toBeNull()
  })

  it('says nothing when the user opts a row out, and retires a pop that is showing', () => {
    const { acp, setAgentSkillsMcp } = fakeStore(false)
    const view = render(createElement(AgentSkillsMcpRow, {
      acp, agentId: 'codebuddy', name: 'CodeBuddy', enabled: true, masterOn: false,
    }))
    const box = screen.getByRole('checkbox', { name: rowBox('CodeBuddy') }) as HTMLInputElement
    // Opting out is the answer the master already forces, so it waits on
    // nothing: no reminder, and the write goes through all the same.
    act(() => { fireEvent.click(box) })
    expect(setAgentSkillsMcp).toHaveBeenCalledWith('codebuddy', false)
    expect(screen.queryByRole('button', { name: MASTER_OFF })).toBeNull()
    // Turning it back on is the action that waits on the master, so that warns.
    view.rerender(createElement(AgentSkillsMcpRow, {
      acp, agentId: 'codebuddy', name: 'CodeBuddy', enabled: false, masterOn: false,
    }))
    act(() => { fireEvent.click(box) })
    expect(screen.queryByRole('button', { name: MASTER_OFF })).not.toBeNull()
    // …and opting out again retires the pop instead of leaving it stale.
    view.rerender(createElement(AgentSkillsMcpRow, {
      acp, agentId: 'codebuddy', name: 'CodeBuddy', enabled: true, masterOn: false,
    }))
    act(() => { fireEvent.click(box) })
    expect(screen.queryByRole('button', { name: MASTER_OFF })).toBeNull()
  })

  it('never arms the warning from a click made while the master is on', () => {
    const { acp, setAgentSkillsMcp } = fakeStore(true)
    const view = render(createElement(AgentSkillsMcpRow, {
      acp, agentId: 'codebuddy', name: 'CodeBuddy', enabled: false, masterOn: true,
    }))
    const box = screen.getByRole('checkbox', { name: rowBox('CodeBuddy') }) as HTMLInputElement
    act(() => { fireEvent.click(box) })
    // The write still goes through — only the warning is withheld.
    expect(setAgentSkillsMcp).toHaveBeenCalledWith('codebuddy', true)
    expect(screen.queryByRole('button', { name: MASTER_OFF })).toBeNull()
    view.rerender(createElement(AgentSkillsMcpRow, {
      acp, agentId: 'codebuddy', name: 'CodeBuddy', enabled: true, masterOn: false,
    }))
    expect(screen.queryByRole('button', { name: MASTER_OFF })).toBeNull()
  })

  it('never warns while the master switch is on', () => {
    const { acp } = fakeStore(true)
    render(createElement(AgentSkillsMcpRow, {
      acp, agentId: 'codebuddy', name: 'CodeBuddy', enabled: false, masterOn: true,
    }))
    expect(screen.queryByRole('button', { name: MASTER_OFF })).toBeNull()
    // A click while the master is on is an ordinary setting change, not a warning.
    act(() => { fireEvent.click(screen.getByRole('checkbox', { name: rowBox('CodeBuddy') })) })
    expect(screen.queryByRole('button', { name: MASTER_OFF })).toBeNull()
  })

  it('shows an explicit opt-out as unchecked', () => {
    const { acp } = fakeStore(true)
    render(createElement(AgentSkillsMcpRow, {
      acp, agentId: 'codebuddy', name: 'CodeBuddy', enabled: false, masterOn: true,
    }))
    expect((screen.getByRole('checkbox', { name: rowBox('CodeBuddy') }) as HTMLInputElement).checked).toBe(false)
  })

  it('carries the agent name the 智能体 page spells', () => {
    const { acp } = fakeStore(true)
    render(createElement(AgentSkillsMcpRow, {
      acp, agentId: 'codebuddy', name: 'CodeBuddy', enabled: true, masterOn: true,
    }))
    expect(screen.getByText('CodeBuddy')).toBeTruthy()
  })
})
