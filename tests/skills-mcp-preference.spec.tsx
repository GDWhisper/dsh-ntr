// @vitest-environment jsdom
/**
 * The settings page's two `dsh-skills` MCP switches: the fixed copy, the
 * focusable info icon behind the host `Tooltip`, the write each one sends, and
 * where each one lives (BOTH levels on the 技能 page — the master card, then the
 * per-agent opt-outs listed under it; no agent card carries the switch any more).
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
const EXPLANATION = '智能体可以读取你装在 DSH 里的技能说明（只读）。'
const DETAIL = '技能说明只在智能体用到时读取，平时不扫描。开关只对新建或重新加载的对话生效；旧对话保持关闭前的状态。'
const AGENT_COPY = '对这个智能体开放'
const MASTER_OFF = '总开关目前处于关闭状态，开启后生效。'

/**
 * A row's checkbox is named by the agent AND the shared label (`aria-labelledby`
 * over the name span plus the copy span): without it every row in the list would
 * read 「对这个智能体开放」 and no screen reader could tell them apart.
 */
const rowBox = (agent: string) => `${agent} ${AGENT_COPY}`

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
  it('is a titled card with the fixed one-line copy, and sends the toggle to the store', async () => {
    const { acp, ui, setSkillsMcpEnabled } = fakeStore(false)
    render(createElement(SkillsMcpPreference, { acp, ui, agents: [] }))
    expect(screen.getByRole('heading', { name: TITLE })).toBeTruthy()
    expect(screen.getByText(EXPLANATION)).toBeTruthy()
    const toggle = screen.getByRole('checkbox', { name: MASTER_LABEL }) as HTMLInputElement
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
    expect(screen.queryByRole('checkbox', { name: AGENT_COPY })).toBeNull()
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
    // Two rows, one checkbox each, and each one named by its own agent: in a
    // bare list the surrounding card no longer says which agent a row belongs to.
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

  it('is just the master card when no agent is added', async () => {
    const fixture = createPanelFixture({ agents: [] })
    await fixture.ready
    await openSkillsPage(fixture.store)
    const section = skillsSection()
    // No empty-state copy and no add entry: an empty roster is the 智能体 page's
    // business, so this page shows the master switch and stops.
    expect(skillsList(section)).toBeNull()
    expect(within(section).queryByRole('checkbox', { name: AGENT_COPY })).toBeNull()
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
    // The host's re-read answer is what the checkbox keeps.
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
  it('warns only once the user touches the row, and forgets it when the master is on', () => {
    const { acp } = fakeStore(false)
    const view = render(createElement(AgentSkillsMcpRow, {
      acp, agentId: 'codebuddy', name: 'CodeBuddy', enabled: true, masterOn: false,
    }))
    const warning = (): HTMLElement | null => screen.queryByRole('button', { name: MASTER_OFF })
    // The master being off says nothing on its own.
    expect(warning()).toBeNull()
    const box = screen.getByRole('checkbox', { name: rowBox('CodeBuddy') }) as HTMLInputElement
    // A row the user may still act on: no `disabled`, no dimming class.
    expect(box.disabled).toBe(false)
    expect(box.className).toBe('')
    act(() => { fireEvent.click(box) })
    expect(warning()).not.toBeNull()
    // Master back on: the warning goes, and a later flip off starts silent again.
    const row = (masterOn: boolean) => createElement(AgentSkillsMcpRow, {
      acp, agentId: 'codebuddy', name: 'CodeBuddy', enabled: false, masterOn,
    })
    view.rerender(row(true))
    expect(warning()).toBeNull()
    view.rerender(row(false))
    expect(warning()).toBeNull()
  })

  it('never arms the warning from a click made while the master is on', () => {
    const { acp, setAgentSkillsMcp } = fakeStore(true)
    const view = render(createElement(AgentSkillsMcpRow, {
      acp, agentId: 'codebuddy', name: 'CodeBuddy', enabled: true, masterOn: true,
    }))
    const box = screen.getByRole('checkbox', { name: rowBox('CodeBuddy') }) as HTMLInputElement
    act(() => { fireEvent.click(box) })
    // The write still goes through — only the warning is withheld.
    expect(setAgentSkillsMcp).toHaveBeenCalledWith('codebuddy', false)
    expect(screen.queryByRole('button', { name: MASTER_OFF })).toBeNull()
    view.rerender(createElement(AgentSkillsMcpRow, {
      acp, agentId: 'codebuddy', name: 'CodeBuddy', enabled: false, masterOn: false,
    }))
    expect(screen.queryByRole('button', { name: MASTER_OFF })).toBeNull()
  })

  it('never warns while the master switch is on', () => {
    const { acp } = fakeStore(true)
    render(createElement(AgentSkillsMcpRow, {
      acp, agentId: 'codebuddy', name: 'CodeBuddy', enabled: true, masterOn: true,
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
