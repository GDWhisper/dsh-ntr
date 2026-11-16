// @vitest-environment jsdom
/**
 * The settings page's two `dsh-skills` MCP switches: the fixed copy, the
 * focusable info icon behind the host `Tooltip`, the write each one sends, and
 * where each one lives (the master card on the 技能 page, the per-agent row
 * beside the MCP list it narrows).
 *
 * Copy is asserted VERBATIM against docs/plan/dsh-skills-mcp.md §7.2 and §13.2 —
 * the tooltip may not be reworded into "starts the process on first call" or
 * "stops the MCP immediately", and the per-agent row must keep saying what
 * gates it (the built-in service, not the JSON list) and how far one agent's
 * opt-out reaches.
 */
import { createElement } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
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
const AGENT_NOTE = '这一项控制「DSH 技能发现」提供的技能服务，与手填的 MCP 服务器无关。关闭只影响这个智能体，其他智能体仍可读取。'
const MASTER_OFF = '「技能」页的「DSH 技能发现」处于关闭状态，打开后这一项才生效。'

/** Only the write surfaces these components use; nothing else is reached. */
function fakeStore(master?: boolean) {
  const setSkillsMcpEnabled = vi.fn(async (_value: boolean) => {})
  const setAgentSkillsMcp = vi.fn(async (_agentId: string, _value: boolean) => {})
  const acp = { setSkillsMcpEnabled, setAgentSkillsMcp, label: (zh: string) => zh } as unknown as AcpStore
  const ui = { skillsMcpEnabled: master } as UiState
  return { acp, ui, setSkillsMcpEnabled, setAgentSkillsMcp }
}

describe('the skills MCP master card', () => {
  it('is a titled card with the fixed one-line copy, and sends the toggle to the store', async () => {
    const { acp, ui, setSkillsMcpEnabled } = fakeStore(false)
    render(createElement(SkillsMcpPreference, { acp, ui }))
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
    render(createElement(SkillsMcpPreference, { acp, ui }))
    expect((screen.getByRole('checkbox', { name: MASTER_LABEL }) as HTMLInputElement).checked).toBe(false)
  })

  it('puts the mechanism in the host Tooltip behind a focusable button', async () => {
    const { acp, ui } = fakeStore(true)
    render(createElement(SkillsMcpPreference, { acp, ui }))
    const info = screen.getByRole('button', { name: '关于 DSH 技能发现' })
    // A real button: keyboard users can reach the tooltip by focusing it.
    expect(info.tagName).toBe('BUTTON')
    expect((info as HTMLButtonElement).type).toBe('button')
    info.focus()
    expect(document.activeElement).toBe(info)
    // The test stub renders the tooltip label inline; the wording is the plan's.
    expect(screen.getByText(DETAIL)).toBeTruthy()
  })

  it('owns a 技能 page of its own, off the page that manages agents', async () => {
    const fixture = createPanelFixture()
    await fixture.ready
    render(createElement(AcpSettingsSection, { acp: fixture.store }))
    // The agents page manages agents: the deployment-wide card is not on it…
    expect(screen.queryByRole('heading', { name: TITLE })).toBeNull()
    expect(screen.queryByRole('checkbox', { name: MASTER_LABEL })).toBeNull()
    // …while the per-agent half still lives in the agent card, greyed by the
    // off master and naming the page that owns it.
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '管理 CodeBuddy' })) })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '高级' })) })
    expect(screen.getByRole('checkbox', { name: AGENT_COPY })).toBeTruthy()
    expect(screen.getAllByText(MASTER_OFF).length).toBeGreaterThan(0)
    // The 技能 page carries the master card with its copy and info button.
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '技能' })) })
    expect(screen.getByRole('heading', { name: TITLE })).toBeTruthy()
    expect(screen.getByText(EXPLANATION)).toBeTruthy()
    expect(screen.getByRole('checkbox', { name: MASTER_LABEL })).toBeTruthy()
    expect(screen.getByRole('button', { name: '关于 DSH 技能发现' })).toBeTruthy()
  })
})

describe('the per-agent skills MCP row', () => {
  it('offers the fixed copy and is ON when the agent never opted out', async () => {
    const { acp, setAgentSkillsMcp } = fakeStore(true)
    render(createElement(AgentSkillsMcpRow, { acp, agentId: 'codebuddy', enabled: true, masterOn: true }))
    const box = screen.getByRole('checkbox', { name: AGENT_COPY }) as HTMLInputElement
    expect(screen.getByText(AGENT_COPY)).toBeTruthy()
    // Unset means offered: only an explicit opt-out reaches this component as off.
    expect(box.checked).toBe(true)
    expect(box.disabled).toBe(false)
    // Master on: the standing note draws the scope pair and severs the row from
    // the hand-written MCP list above it; the gate sentence is not shown.
    expect(screen.getByText(AGENT_NOTE)).toBeTruthy()
    expect(screen.queryByText(MASTER_OFF)).toBeNull()
    await act(async () => { fireEvent.click(box) })
    expect(setAgentSkillsMcp).toHaveBeenCalledWith('codebuddy', false)
  })

  it('shows an explicit opt-out as unchecked', () => {
    const { acp } = fakeStore(true)
    render(createElement(AgentSkillsMcpRow, { acp, agentId: 'codebuddy', enabled: false, masterOn: true }))
    expect((screen.getByRole('checkbox', { name: AGENT_COPY }) as HTMLInputElement).checked).toBe(false)
  })

  it('is greyed out and refuses clicks while the master switch is off', () => {
    const { acp } = fakeStore(false)
    render(createElement(AgentSkillsMcpRow, { acp, agentId: 'codebuddy', enabled: true, masterOn: false }))
    const box = screen.getByRole('checkbox', { name: AGENT_COPY }) as HTMLInputElement
    // Disabled is the guard a browser honours; the hint names why.
    expect(box.disabled).toBe(true)
    // Master off: the gate sentence replaces the scope note.
    expect(screen.getByText(MASTER_OFF)).toBeTruthy()
    expect(screen.queryByText(AGENT_NOTE)).toBeNull()
  })

  it('is wired into the agent card beside the MCP list, dimmed until the master switch is on', async () => {
    const off = createPanelFixture()
    await off.ready
    const first = render(createElement(AcpSettingsSection, { acp: off.store }))
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '管理 CodeBuddy' })) })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '高级' })) })
    const box = screen.getByRole('checkbox', { name: AGENT_COPY }) as HTMLInputElement
    expect(box.checked).toBe(true)
    expect(box.disabled).toBe(true)
    // Every agent card carries the row, so the hint repeats per card.
    expect(screen.getAllByText(MASTER_OFF).length).toBeGreaterThan(0)
    first.unmount()

    // Master on: the same row writes through the lightweight RPC, and the host's
    // roster answer is what the checkbox keeps.
    const on = createPanelFixture({ skillsMcp: true })
    await on.ready
    render(createElement(AcpSettingsSection, { acp: on.store }))
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '管理 CodeBuddy' })) })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '高级' })) })
    const live = screen.getByRole('checkbox', { name: AGENT_COPY }) as HTMLInputElement
    expect(live.disabled).toBe(false)
    // The standing note travels with the row: it is what tells the user this is
    // not a switch for the hand-written MCP servers above it.
    expect(screen.getAllByText(AGENT_NOTE).length).toBeGreaterThan(0)
    await act(async () => { fireEvent.click(live) })
    expect(on.calls.filter(call => call.endpoint === 'agent/set-skills-mcp').map(call => call.payload))
      .toEqual([{ agentId: 'codebuddy', skillsMcpEnabled: false }])
    expect((screen.getByRole('checkbox', { name: AGENT_COPY }) as HTMLInputElement).checked).toBe(false)
    // A plain setting: no agent save was issued along the way.
    expect(on.calls.some(call => call.endpoint === 'agent/save')).toBe(false)
  })
})
