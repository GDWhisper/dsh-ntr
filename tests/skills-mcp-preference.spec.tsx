// @vitest-environment jsdom
/**
 * The settings page's two `dsh-skills` MCP switches: the fixed copy, the
 * focusable info icon behind the host `Tooltip`, the write each one sends, and
 * where each one lives (the master card above the roster, the per-agent row
 * beside the MCP list it narrows).
 *
 * Copy is asserted VERBATIM against docs/plan/dsh-skills-mcp.md §7.2 and §13.2 —
 * the tooltip may not be reworded into "starts the process on first call" or
 * "stops the MCP immediately", and the per-agent row must keep saying that the
 * master switch has to be on.
 */
import { createElement } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AcpSettingsSection } from '../src/client/panel.tsx'
import { AgentSkillsMcpRow, SkillsMcpPreference } from '../src/client/skills-mcp-preference.tsx'
import type { AcpStore, UiState } from '../src/client/store.ts'
import { createPanelFixture } from './panel-fixture.ts'

afterEach(cleanup)

const EXPLANATION = '让 agent 查阅你的 DSH 技能文档（只读）。'
const DETAIL = '开启后，agent 可以查阅你的 DSH 技能文档：只读、不改文件，也不会获得 DSH 的其他能力。技能内容等 agent 用到时才读取，平时不扫描。开关只对新对话生效；旧对话里已在运行的辅助进程，不保证随关闭立刻退出。'
const AGENT_COPY = '向该 agent 提供 DSH 技能文档（只读）。'
const MASTER_OFF = '总开关已关闭，开启后此选项才生效。'

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
    expect(screen.getByRole('heading', { name: '技能 MCP' })).toBeTruthy()
    expect(screen.getByText(EXPLANATION)).toBeTruthy()
    const toggle = screen.getByRole('checkbox', { name: 'DSH 技能' }) as HTMLInputElement
    expect(toggle.checked).toBe(false)
    await act(async () => { fireEvent.click(toggle) })
    expect(setSkillsMcpEnabled).toHaveBeenCalledTimes(1)
    expect(setSkillsMcpEnabled).toHaveBeenCalledWith(true)
  })

  it('renders an unread value as off and never as on', () => {
    const { acp, ui } = fakeStore(undefined)
    render(createElement(SkillsMcpPreference, { acp, ui }))
    expect((screen.getByRole('checkbox', { name: 'DSH 技能' }) as HTMLInputElement).checked).toBe(false)
  })

  it('puts the mechanism in the host Tooltip behind a focusable button', async () => {
    const { acp, ui } = fakeStore(true)
    render(createElement(SkillsMcpPreference, { acp, ui }))
    const info = screen.getByRole('button', { name: '关于 DSH 技能 MCP' })
    // A real button: keyboard users can reach the tooltip by focusing it.
    expect(info.tagName).toBe('BUTTON')
    expect((info as HTMLButtonElement).type).toBe('button')
    info.focus()
    expect(document.activeElement).toBe(info)
    // The test stub renders the tooltip label inline; the wording is the plan's.
    expect(screen.getByText(DETAIL)).toBeTruthy()
  })

  it('sits above the agent list on the 智能体 page of the settings panel', async () => {
    const fixture = createPanelFixture()
    await fixture.ready
    render(createElement(AcpSettingsSection, { acp: fixture.store }))
    // The default page is 智能体: the card is visible there, with its copy.
    const heading = screen.getByRole('heading', { name: '技能 MCP' })
    expect(screen.getByText(EXPLANATION)).toBeTruthy()
    expect(screen.getByRole('checkbox', { name: 'DSH 技能' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '关于 DSH 技能 MCP' })).toBeTruthy()
    // …ABOVE the roster, not after it: the master kills what the agent rows narrow.
    const list = document.querySelector('.dwa-agent-list')
    expect(list).toBeTruthy()
    expect(heading.compareDocumentPosition(list as Node) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
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
    expect(screen.getByText(MASTER_OFF)).toBeTruthy()
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
    await act(async () => { fireEvent.click(live) })
    expect(on.calls.filter(call => call.endpoint === 'agent/set-skills-mcp').map(call => call.payload))
      .toEqual([{ agentId: 'codebuddy', skillsMcpEnabled: false }])
    expect((screen.getByRole('checkbox', { name: AGENT_COPY }) as HTMLInputElement).checked).toBe(false)
    // A plain setting: no agent save was issued along the way.
    expect(on.calls.some(call => call.endpoint === 'agent/save')).toBe(false)
  })
})
