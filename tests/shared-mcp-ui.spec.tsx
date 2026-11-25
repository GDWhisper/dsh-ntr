// @vitest-environment jsdom
import { createElement } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AcpSettingsSection } from '../src/client/panel.tsx'
import { ensureStyle } from '../src/client/panel/styles.ts'
import { SharedMcpPreference } from '../src/client/shared-mcp-preference.tsx'
import type { UiState } from '../src/client/store.ts'
import type { AcpSharedMcpSettings } from '../src/protocol.ts'
import { AcpStore, type RpcCall } from '../src/client/store.ts'

afterEach(cleanup)

function fakeStore(sharedMcp: AcpSharedMcpSettings | undefined) {
  const setSharedMcp = vi.fn(async () => {})
  const setAgentSharedMcp = vi.fn(async () => {})
  const acp = { setSharedMcp, setAgentSharedMcp, label: (zh: string) => zh } as unknown as AcpStore
  const ui = { sharedMcp } as UiState
  return { acp, ui, setSharedMcp, setAgentSharedMcp }
}

describe('SharedMcpPreference', () => {
  it('saves valid shared MCP JSON, toggles host sync, renders host badges, and toggles per-agent opt-out', async () => {
    const { acp, ui, setSharedMcp, setAgentSharedMcp } = fakeStore({
      servers: [],
      hostSyncEnabled: false,
      hostAvailable: true,
      hostServers: [
        { name: 'mem', transport: 'stdio', enabled: true, hasCwd: true, syncable: true },
        { name: 'gh', transport: 'stdio', enabled: true, hasCredentialTemplate: true, syncable: false },
        { name: 'paused', transport: 'http', enabled: false, syncable: false },
      ],
    })
    const { container } = render(createElement(SharedMcpPreference, {
      acp,
      ui,
      agents: [{ id: 'a1', name: 'CodeBuddy', enabled: true }],
    }))

    // Host card uses split layout + host badge classes, with no nested card containers.
    expect(container.querySelectorAll('.dwa-card .dwa-skills-card')).toHaveLength(0)
    expect(container.querySelectorAll('.dwa-row-split').length).toBe(2)
    expect(screen.getByText('mem')).toBeTruthy()
    const syncableBadge = screen.getByText('可同步（忽略 cwd）')
    const credBadge = screen.getByText('含凭据模板（已跳过）')
    const disabledBadge = screen.getByText('已停用')
    expect(syncableBadge.className).toContain('dwa-badge-success')
    expect(credBadge.className).toContain('dwa-badge-warn')
    expect(disabledBadge.className).toBe('dwa-badge')

    // Per-agent section carries an explicit subsection heading & scope copy.
    expect(screen.getByRole('heading', { name: '按智能体开关' })).toBeTruthy()
    expect(screen.getByText(/私有配置与 DSH 技能发现不受影响/)).toBeTruthy()

    // Edit global JSON and save.
    const textarea = screen.getByLabelText('全局 MCP 服务器 JSON') as HTMLTextAreaElement
    expect(textarea.getAttribute('spellcheck')).toBe('false')
    expect(textarea.className).toContain('dwa-input')
    expect(textarea.className).toContain('dwa-input-mono')
    const saveBtn = screen.getByRole('button', { name: '保存' }) as HTMLButtonElement
    expect(saveBtn.disabled).toBe(true)

    fireEvent.change(textarea, { target: { value: 'not-json' } })
    expect(screen.getByRole('alert')).toBeTruthy()
    expect(saveBtn.disabled).toBe(true)

    // Schema-invalid arrays must also fail client validation before reaching the host.
    for (const bad of [
      '{}',
      '[{}]',
      JSON.stringify([{ name: 'a', transport: 'stdio' }]),
      JSON.stringify([{ name: 'a', transport: 'http' }]),
      JSON.stringify([{ name: 'a', transport: 'acp', command: '/bin/a' }]),
      JSON.stringify([{ name: 'dup', transport: 'stdio', command: '/a' }, { name: 'dup', transport: 'http', url: 'https://x' }]),
    ]) {
      fireEvent.change(textarea, { target: { value: bad } })
      expect(screen.getByRole('alert')).toBeTruthy()
      expect(saveBtn.disabled).toBe(true)
    }

    const validJson = JSON.stringify([{ name: 'ctx', transport: 'stdio', command: '/usr/bin/ctx' }])
    fireEvent.change(textarea, { target: { value: validJson } })
    expect(screen.queryByRole('alert')).toBeNull()
    expect(saveBtn.disabled).toBe(false)
    await act(async () => { fireEvent.click(saveBtn) })
    expect(setSharedMcp).toHaveBeenCalledWith({
      servers: [{ name: 'ctx', transport: 'stdio', command: '/usr/bin/ctx' }],
    })

    // Toggle host sync switch.
    const hostSwitch = screen.getByRole('checkbox', { name: '同步 DSH 宿主 MCP' }) as HTMLInputElement
    expect(hostSwitch.checked).toBe(false)
    await act(async () => { fireEvent.click(hostSwitch) })
    expect(setSharedMcp).toHaveBeenCalledWith({ hostSyncEnabled: true })

    // Toggle per-agent switch.
    const agentSwitch = screen.getByRole('checkbox', { name: '对 CodeBuddy 启用统一 MCP' }) as HTMLInputElement
    expect(agentSwitch.checked).toBe(true)
    await act(async () => { fireEvent.click(agentSwitch) })
    expect(setAgentSharedMcp).toHaveBeenCalledWith('a1', false)
  })

  it('preserves dirty draft across background resync and canonicalizes after own save completes', () => {
    const { acp, ui } = fakeStore({ servers: [], hostSyncEnabled: false, hostAvailable: false })
    const { rerender } = render(createElement(SharedMcpPreference, { acp, ui, agents: [] }))
    const textarea = screen.getByLabelText('全局 MCP 服务器 JSON') as HTMLTextAreaElement

    fireEvent.change(textarea, { target: { value: '[{"name":"draft-edit","transport":"stdio","command":"/bin/draft"}]' } })
    // Simulate another client/host resync updating ui.sharedMcp while user has an unsubmitted edit.
    const resyncedUi = {
      sharedMcp: {
        servers: [{ name: 'remote-server', transport: 'http' as const, url: 'https://remote.example/mcp' }],
        hostSyncEnabled: false,
        hostAvailable: false,
      },
    } as UiState
    rerender(createElement(SharedMcpPreference, { acp, ui: resyncedUi, agents: [] }))
    expect(textarea.value).toBe('[{"name":"draft-edit","transport":"stdio","command":"/bin/draft"}]')
  })

  it('canonicalizes textarea after saving unformatted JSON once host echoes it back', async () => {
    let resolveSave!: () => void
    const setSharedMcp = vi.fn(() => new Promise<void>(resolve => { resolveSave = resolve }))
    const acp = { setSharedMcp, setAgentSharedMcp: vi.fn(async () => {}), label: (zh: string) => zh } as unknown as AcpStore
    const ui1 = { sharedMcp: { servers: [], hostSyncEnabled: false, hostAvailable: false } } as UiState
    const { rerender } = render(createElement(SharedMcpPreference, { acp, ui: ui1, agents: [] }))
    const textarea = screen.getByLabelText('全局 MCP 服务器 JSON') as HTMLTextAreaElement
    const saveBtn = screen.getByRole('button', { name: '保存' }) as HTMLButtonElement

    const compact = '[{"name":"saved","transport":"stdio","command":"/bin/saved"}]'
    fireEvent.change(textarea, { target: { value: compact } })
    fireEvent.click(saveBtn)

    const ui2 = {
      sharedMcp: {
        servers: [{ name: 'saved', transport: 'stdio' as const, command: '/bin/saved' }],
        hostSyncEnabled: false,
        hostAvailable: false,
      },
    } as UiState
    rerender(createElement(SharedMcpPreference, { acp, ui: ui2, agents: [] }))
    await act(async () => { resolveSave() })
    expect(textarea.value).toBe(JSON.stringify([{ name: 'saved', transport: 'stdio', command: '/bin/saved' }], null, 2))
  })

  it('ignores concurrent switch clicks while a toggle RPC is in flight', async () => {
    let resolveHost!: () => void
    let resolveAgent!: () => void
    const setSharedMcp = vi.fn(() => new Promise<void>(resolve => { resolveHost = resolve }))
    const setAgentSharedMcp = vi.fn(() => new Promise<void>(resolve => { resolveAgent = resolve }))
    const acp = { setSharedMcp, setAgentSharedMcp, label: (zh: string) => zh } as unknown as AcpStore
    const ui = { sharedMcp: { servers: [], hostSyncEnabled: false, hostAvailable: true, hostServers: [] } } as UiState
    render(createElement(SharedMcpPreference, { acp, ui, agents: [{ id: 'a1', name: 'CodeBuddy', enabled: true }] }))

    const hostSwitch = screen.getByRole('checkbox', { name: '同步 DSH 宿主 MCP' }) as HTMLInputElement
    fireEvent.click(hostSwitch)
    fireEvent.click(hostSwitch)
    expect(setSharedMcp).toHaveBeenCalledTimes(1)
    await act(async () => { resolveHost() })
    fireEvent.click(hostSwitch)
    expect(setSharedMcp).toHaveBeenCalledTimes(2)

    const agentSwitch = screen.getByRole('checkbox', { name: '对 CodeBuddy 启用统一 MCP' }) as HTMLInputElement
    fireEvent.click(agentSwitch)
    fireEvent.click(agentSwitch)
    expect(setAgentSharedMcp).toHaveBeenCalledTimes(1)
    await act(async () => { resolveAgent() })
    fireEvent.click(agentSwitch)
    expect(setAgentSharedMcp).toHaveBeenCalledTimes(2)
  })

  it('hides host sync card when hostAvailable is false', () => {
    const { acp, ui } = fakeStore({ servers: [], hostSyncEnabled: false, hostAvailable: false })
    render(createElement(SharedMcpPreference, { acp, ui, agents: [] }))
    expect(screen.queryByRole('heading', { name: '同步 DSH 宿主 MCP' })).toBeNull()
  })

  it('shows MCP tab in AcpSettingsSection and refreshes ui/shared-mcp when navigating to it', async () => {
    let hostCount = 0
    const rpc: RpcCall = async (_channel, endpoint) => {
      if (endpoint === 'agents/list') return { ok: true, value: { agents: [] } }
      if (endpoint === 'sessions/list') return { ok: true, value: { sessions: [] } }
      if (endpoint === 'agents/detect') return { ok: true, value: { agents: [] } }
      if (endpoint === 'ui/shared-mcp') {
        hostCount += 1
        return {
          ok: true,
          value: {
            sharedMcp: {
              servers: [],
              hostSyncEnabled: false,
              hostAvailable: true,
              hostServers: hostCount > 1
                ? [{ name: 'fresh-host-mcp', transport: 'http', enabled: true, syncable: true }]
                : [],
            },
          },
        }
      }
      return { ok: true, value: {} }
    }
    const store = new AcpStore(rpc, (zh: string) => zh)
    await store.resync()
    expect(hostCount).toBe(1)
    render(createElement(AcpSettingsSection, { acp: store }))
    const tab = screen.getByRole('button', { name: 'MCP' })
    await act(async () => { fireEvent.click(tab) })
    expect(hostCount).toBe(2)
    expect(screen.getByRole('heading', { name: '全局 MCP 服务器' })).toBeTruthy()
    expect(screen.getByRole('heading', { name: '同步 DSH 宿主 MCP' })).toBeTruthy()
    expect(screen.getByText('fresh-host-mcp')).toBeTruthy()
  })

  it('uses only valid host theme tokens in panel stylesheet rules for MCP', () => {
    ensureStyle()
    const css = Array.from(document.head.querySelectorAll('style'))
      .map(el => el.textContent ?? '')
      .join('\n')
    for (const invalidToken of [
      '--font-mono',
      '--border-subtle',
      '--text-tertiary',
      '--bg-success-subtle',
      '--bg-warning-subtle',
      '--text-success',
      '--text-warning',
      '--bg-subtle',
    ]) {
      expect(css).not.toContain(invalidToken)
    }
    expect(css).toContain('textarea:focus-visible')
    expect(css).toContain('.dwa-mcp-agents')
    expect(css).toContain('var(--ntr-line-quiet)')
  })
})
