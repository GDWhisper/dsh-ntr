// @vitest-environment jsdom
/**
 * The settings page's `dsh-skills` MCP switch: the fixed copy, the focusable
 * info icon behind the host `Tooltip`, the write it sends, and the fact that
 * the row is mounted on the 智能体 page.
 *
 * Copy is asserted VERBATIM against docs/plan/dsh-skills-mcp.md §7.2 — the
 * tooltip may not be reworded into "starts the process on first call" or
 * "stops the MCP immediately".
 */
import { createElement } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AcpSettingsSection } from '../src/client/panel.tsx'
import { SkillsMcpPreference } from '../src/client/skills-mcp-preference.tsx'
import type { AcpStore, UiState } from '../src/client/store.ts'
import { createPanelFixture } from './panel-fixture.ts'

afterEach(cleanup)

const EXPLANATION = '让 agent 查阅你的 DSH 技能文档（只读）。'
const DETAIL = '开启后，agent 可以查阅你的 DSH 技能文档：只读、不改文件，也不会获得 DSH 的其他能力。技能内容等 agent 用到时才读取，平时不扫描。开关只对新对话生效；旧对话里已在运行的辅助进程，不保证随关闭立刻退出。'

/** Only the write surface this component uses; nothing else is reached. */
function fakeStore(enabled?: boolean) {
  const setSkillsMcpEnabled = vi.fn(async (_value: boolean) => {})
  const acp = { setSkillsMcpEnabled, label: (zh: string) => zh } as unknown as AcpStore
  const ui = { skillsMcpEnabled: enabled } as UiState
  return { acp, ui, setSkillsMcpEnabled }
}

describe('the skills MCP preference row', () => {
  it('shows the fixed explanation and sends the toggle to the store', async () => {
    const { acp, ui, setSkillsMcpEnabled } = fakeStore(false)
    render(createElement(SkillsMcpPreference, { acp, ui }))
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

  it('is mounted on the 智能体 page of the settings panel', async () => {
    const fixture = createPanelFixture()
    await fixture.ready
    render(createElement(AcpSettingsSection, { acp: fixture.store }))
    // The default page is 智能体: the row is visible there, with its copy.
    expect(screen.getByText(EXPLANATION)).toBeTruthy()
    expect(screen.getByRole('checkbox', { name: 'DSH 技能' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '关于 DSH 技能 MCP' })).toBeTruthy()
  })
})
