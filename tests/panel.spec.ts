// @vitest-environment jsdom
import { createElement } from 'react'
import { act, cleanup, fireEvent, isInaccessible, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { AcpSettingsSection } from '../src/client/panel.tsx'
import { saveGateIsAvailable } from '../src/client/store.ts'
import type { SaveGateStatus } from '../src/protocol.ts'
import { createPanelFixture, type PanelFixture, type PanelFixtureOptions, type PanelPermissionRequest } from './panel-fixture.ts'

afterEach(cleanup)

async function mountPanel(options: PanelFixtureOptions = {}): Promise<PanelFixture> {
  const fixture = createPanelFixture(options)
  await fixture.ready
  render(createElement(AcpSettingsSection, { acp: fixture.store }))
  return fixture
}

async function click(element: HTMLElement): Promise<void> {
  await act(async () => { fireEvent.click(element) })
}

async function category(name: string): Promise<void> {
  await click(within(screen.getByRole('navigation', { name: 'NTR 设置分类' })).getByRole('button', { name }))
}

async function detail(name: string, agent = 'CodeBuddy'): Promise<void> {
  await click(within(screen.getByRole('navigation', { name: `${agent} 配置` })).getByRole('button', { name }))
}

function textbox(name: string): HTMLInputElement {
  return screen.getByRole('textbox', { name }) as HTMLInputElement
}

function payloads(fixture: PanelFixture, endpoint: string): unknown[] {
  return fixture.calls.filter(call => call.endpoint === endpoint).map(call => call.payload)
}

function expectHiddenButMounted(element: HTMLElement): void {
  expect(element.isConnected).toBe(true)
  expect(isInaccessible(element)).toBe(true)
}

function permission(overrides: Partial<PanelPermissionRequest> = {}): PanelPermissionRequest {
  return {
    type: 'permission/request', requestId: 'ask-edit', sessionId: 'acp-preview', dshSessionId: 'other-chat',
    toolCall: { toolCallId: 'edit-1', title: 'Edit project file' },
    toolName: 'Edit project file', reason: 'Update app.ts', timeoutMode: 'wait',
    options: [
      { optionId: 'once', name: 'Allow once', kind: 'allow_once' },
      { optionId: 'always', name: 'Always Allow', kind: 'allow_always' },
      { optionId: 'deny', name: 'Reject once', kind: 'reject_once' },
    ],
    ...overrides,
  }
}

describe('NTR agent save guard', () => {
  const activeGate = {
    canSave: false,
    gateAvailable: true,
    activeTurns: 1,
    activeSessions: [{ sessionId: 'acp-1', dshSessionId: 'chat-1', agentId: 'codebuddy' }],
    pending: [],
    timeoutMs: 600_000,
  }

  async function dirtyCodeBuddy(options: Parameters<typeof mountPanel>[0] = {}): Promise<PanelFixture> {
    const fixture = await mountPanel(options)
    await click(screen.getByRole('button', { name: '管理 CodeBuddy' }))
    await detail('连接')
    fireEvent.change(textbox('显示名'), { target: { value: 'CodeBuddy 待保存' } })
    return fixture
  }

  it('does not open the confirmation or write when no turn is active', async () => {
    const fixture = await dirtyCodeBuddy()
    await click(screen.getByRole('button', { name: '保存更改' }))
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(payloads(fixture, 'agent/save')).toEqual([
      expect.objectContaining({ id: 'codebuddy', saveMode: 'direct', title: 'CodeBuddy 待保存' }),
    ])
  })

  it('cancel leaves the form and the host untouched', async () => {
    const fixture = await dirtyCodeBuddy({ saveGate: activeGate })
    await click(screen.getByRole('button', { name: '保存更改' }))
    expect(screen.getByRole('alertdialog')).toBeDefined()
    expect(screen.getByText('有 1 个会话正在运行。现在保存会中断这些会话。')).toBeDefined()
    await click(screen.getByRole('button', { name: '取消' }))
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(payloads(fixture, 'agent/save')).toEqual([])
    expect(textbox('显示名').value).toBe('CodeBuddy 待保存')
  })

  it('save-after-turns queues the save and shows the held state', async () => {
    const fixture = await dirtyCodeBuddy({ saveGate: activeGate })
    await click(screen.getByRole('button', { name: '保存更改' }))
    await click(screen.getByRole('button', { name: '回合结束后保存' }))
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(payloads(fixture, 'agent/save')).toEqual([
      expect.objectContaining({ id: 'codebuddy', saveMode: 'defer', title: 'CodeBuddy 待保存' }),
    ])
    expect(screen.getByText('配置已暂存，回合结束后自动保存。')).toBeDefined()
  })

  it('save-now-and-interrupt sends force after the confirmation', async () => {
    const fixture = await dirtyCodeBuddy({ saveGate: activeGate })
    await click(screen.getByRole('button', { name: '保存更改' }))
    await click(screen.getByRole('button', { name: '立即保存（中断该 Agent）' }))
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(payloads(fixture, 'agent/save')).toEqual([
      expect.objectContaining({ id: 'codebuddy', saveMode: 'force', title: 'CodeBuddy 待保存' }),
    ])
  })

  it('falls back to the host confirmation when save/status is unavailable', async () => {
    const fixture = await dirtyCodeBuddy({ saveGate: activeGate, saveStatus: null })
    // Older hosts answer `unsupported`; the host's agent/save guard still
    // refuses and returns the active sessions for the form's dialog.
    await click(screen.getByRole('button', { name: '保存更改' }))
    expect(screen.getByRole('alertdialog')).toBeDefined()
    // The old host cannot queue, so the defer choice is not offered.
    expect(screen.queryByRole('button', { name: '回合结束后保存' })).toBeNull()
    // The pre-check could not read the gate, so the host guard answered the
    // direct save with `confirmationRequired`; nothing was written.
    expect(payloads(fixture, 'agent/save')).toEqual([
      expect.objectContaining({ id: 'codebuddy', saveMode: 'direct' }),
    ])
  })

  it('does not trust an unavailable gate snapshot and falls back to local sessions', async () => {
    const fixture = await dirtyCodeBuddy({
      saveGate: { ...activeGate, gateAvailable: false, activeSessions: [] },
    })
    await fixture.applyEvent({
      type: 'session/created',
      sessionId: 'acp-local',
      session: {
        sessionId: 'acp-local',
        agentId: 'codebuddy',
        acpSessionId: 'acp-local',
        cwd: '/workspace/ntr-demo',
        running: true,
        closed: false,
        seq: 1,
      },
    })
    await click(screen.getByRole('button', { name: '保存更改' }))
    expect(screen.getByRole('alertdialog')).toBeDefined()
    expect(screen.getByText('有 1 个会话正在运行。现在保存会中断这些会话。')).toBeDefined()
    // The snapshot never earns the queue gesture without gateAvailable.
    expect(screen.queryByRole('button', { name: '回合结束后保存' })).toBeNull()
    // Local evidence stopped the direct send before the host guard had to answer.
    expect(payloads(fixture, 'agent/save')).toEqual([])
  })

  it('cancels the held save when the form changes and asks for a re-save', async () => {
    const fixture = await dirtyCodeBuddy({ saveGate: activeGate })
    await click(screen.getByRole('button', { name: '保存更改' }))
    await click(screen.getByRole('button', { name: '回合结束后保存' }))
    expect(screen.getByText('配置已暂存，回合结束后自动保存。')).toBeDefined()
    expect(screen.getByText('本次保存使用点击时的版本；继续修改表单会取消这次暂存。')).toBeDefined()

    fireEvent.change(textbox('显示名'), { target: { value: 'CodeBuddy 再编辑' } })
    await waitFor(() => {
      expect(payloads(fixture, 'save/cancel')).toEqual([
        expect.objectContaining({ label: 'agent-save:codebuddy' }),
      ])
    })
    expect(screen.queryByText('配置已暂存，回合结束后自动保存。')).toBeNull()
    expect(screen.getByText('已取消暂存，请重新保存。')).toBeDefined()
  })

  it('does not let another agent\'s outcome clear this agent\'s held state', async () => {
    const fixture = await dirtyCodeBuddy({ saveGate: activeGate })
    await click(screen.getByRole('button', { name: '保存更改' }))
    await click(screen.getByRole('button', { name: '回合结束后保存' }))
    expect(screen.getByText('配置已暂存，回合结束后自动保存。')).toBeDefined()

    const pending = {
      ...activeGate,
      pending: [{ id: 'save-1', label: 'agent-save:codebuddy', queuedAt: 1 }],
    }
    await fixture.applyEvent({
      type: 'save/status',
      status: {
        ...pending,
        lastOutcomes: { 'agent-save:pi': { at: 9_999_999_999_999, status: 'saved', label: 'agent-save:pi' } },
      },
    })
    expect(screen.getByText('配置已暂存，回合结束后自动保存。')).toBeDefined()

    await fixture.applyEvent({
      type: 'save/status',
      status: {
        ...pending,
        pending: [],
        lastOutcomes: {
          'agent-save:pi': { at: 9_999_999_999_999, status: 'saved', label: 'agent-save:pi' },
          'agent-save:codebuddy': { at: 9_999_999_999_999, status: 'saved', label: 'agent-save:codebuddy' },
        },
      },
    })
    await waitFor(() => {
      expect(screen.queryByText('配置已暂存，回合结束后自动保存。')).toBeNull()
    })
  })

  it('ignores a superseded cancellation and clears the stale notice when the queue returns', async () => {
    const fixture = await dirtyCodeBuddy({ saveGate: activeGate })
    await click(screen.getByRole('button', { name: '保存更改' }))
    await click(screen.getByRole('button', { name: '回合结束后保存' }))
    expect(screen.getByText('配置已暂存，回合结束后自动保存。')).toBeDefined()

    // A newer save superseded this label: the cancelled row is not evidence that
    // the CURRENT attempt was cancelled.
    await fixture.applyEvent({
      type: 'save/status',
      status: {
        ...activeGate,
        pending: [],
        lastOutcomes: {
          'agent-save:codebuddy': { at: 5, status: 'cancelled', label: 'agent-save:codebuddy', superseded: true },
        },
      },
    })
    expect(screen.getByText('配置已暂存，回合结束后自动保存。')).toBeDefined()
    expect(screen.queryByText('已取消暂存，请重新保存。')).toBeNull()

    // The new write enters the queue while the old cancelled row lingers: only
    // the held state is shown, with no contradictory "cancelled" line.
    await fixture.applyEvent({
      type: 'save/status',
      status: {
        ...activeGate,
        pending: [{ id: 'save-2', label: 'agent-save:codebuddy', queuedAt: 2 }],
        lastOutcomes: {
          'agent-save:codebuddy': { at: 5, status: 'cancelled', label: 'agent-save:codebuddy', superseded: true },
        },
      },
    })
    expect(screen.getByText('配置已暂存，回合结束后自动保存。')).toBeDefined()
    expect(screen.queryByText('已取消暂存，请重新保存。')).toBeNull()
  })

  it('counts a settled session in the older-host save fallback', async () => {
    const fixture = await dirtyCodeBuddy({ saveGate: undefined, saveStatus: null })
    await fixture.applyEvent({
      type: 'session/created',
      sessionId: 'acp-settled',
      session: {
        sessionId: 'acp-settled',
        agentId: 'codebuddy',
        acpSessionId: 'acp-settled',
        cwd: '/workspace/ntr-demo',
        running: false,
        closed: false,
        settled: true,
        seq: 1,
      },
    })
    await click(screen.getByRole('button', { name: '保存更改' }))
    expect(screen.getByRole('alertdialog')).toBeDefined()
    expect(screen.getByText('有 1 个会话正在运行。现在保存会中断这些会话。')).toBeDefined()
  })

  it('shows the affected session count before removing or stopping an agent', async () => {
    const fixture = await mountPanel({ saveGate: activeGate })
    // A released record waits for `session/load`; it is not a live interruption.
    await fixture.applyEvent({
      type: 'session/created',
      sessionId: 'acp-released',
      session: {
        sessionId: 'acp-released',
        agentId: 'codebuddy',
        acpSessionId: 'acp-released',
        cwd: '/workspace/ntr-demo',
        running: false,
        released: true,
        closed: false,
        seq: 1,
      },
    })
    const card = screen.getByRole('button', { name: '管理 CodeBuddy' }).closest('.dwa-agent-card') as HTMLElement
    await click(within(card).getByTitle('更多操作'))
    await click(within(card).getByRole('menuitem', { name: '移除配置' }))
    expect(within(card).getByText('将影响 1 个会话。')).toBeDefined()
    await click(within(card).getByRole('button', { name: '取消' }))

    // A busy agent asks before stopping; the count is the same fact.
    await fixture.applyEvent({ type: 'agent/status', agentId: 'codebuddy', state: 'ready' })
    await act(async () => { await fixture.store.resync() })
    await click(within(card).getByRole('menuitem', { name: '停止当前运行实例' }))
    expect(within(card).getByText('将影响 1 个会话。')).toBeDefined()
    await click(within(card).getByRole('button', { name: '确认停止？' }))
    expect(payloads(fixture, 'agent/stop')).toEqual([{ agentId: 'codebuddy' }])
    expect(payloads(fixture, 'agent/delete')).toEqual([])
  })

  it('keeps the held state after a remount and cancels it on the first edit', async () => {
    const fixture = await mountPanel({
      saveGate: {
        ...activeGate,
        pending: [{ id: 'save-1', label: 'agent-save:codebuddy', queuedAt: 1 }],
      },
    })
    await click(screen.getByRole('button', { name: '管理 CodeBuddy' }))
    await detail('连接')
    expect(screen.getByText('配置已暂存，回合结束后自动保存。')).toBeDefined()

    fireEvent.change(textbox('显示名'), { target: { value: 'CodeBuddy 重挂载后编辑' } })
    await waitFor(() => {
      expect(payloads(fixture, 'save/cancel')).toEqual([
        expect.objectContaining({ label: 'agent-save:codebuddy' }),
      ])
    })
    expect(screen.queryByText('配置已暂存，回合结束后自动保存。')).toBeNull()
    expect(screen.getByText('已取消暂存，请重新保存。')).toBeDefined()
  })

  it('keeps the held state and warns when the host cancels nothing', async () => {
    const fixture = await dirtyCodeBuddy({ saveGate: activeGate, saveCancel: 0 })
    await click(screen.getByRole('button', { name: '保存更改' }))
    await click(screen.getByRole('button', { name: '回合结束后保存' }))
    await fixture.applyEvent({
      type: 'save/status',
      status: {
        ...activeGate,
        pending: [{ id: 'save-1', label: 'agent-save:codebuddy', queuedAt: 1 }],
      },
    })
    expect(screen.getByText('配置已暂存，回合结束后自动保存。')).toBeDefined()

    fireEvent.change(textbox('显示名'), { target: { value: 'CodeBuddy 取消失败' } })
    await waitFor(() => {
      expect(payloads(fixture, 'save/cancel')).toEqual([
        expect.objectContaining({ label: 'agent-save:codebuddy' }),
      ])
    })
    expect(screen.getByText('配置已暂存，回合结束后自动保存。')).toBeDefined()
    expect(fixture.store.getSnapshot().saveBanners.find(banner => banner.key === 'save-cancel-failed:agent-save:codebuddy'))
      .toMatchObject({ level: 'error', actions: ['retry', 'dismiss'] })
  })

  it('keeps the defer choice and asks for a retry when save/status fails transiently', async () => {
    // The gate snapshot itself carries no CodeBuddy turn: only the browser's
    // own session row can prove the turn that the fallback must find.
    const fixture = await dirtyCodeBuddy({
      saveGate: { ...activeGate, activeSessions: [] },
      saveStatusError: 'gate read failed',
    })
    await fixture.applyEvent({
      type: 'session/created',
      sessionId: 'acp-transient',
      session: {
        sessionId: 'acp-transient',
        agentId: 'codebuddy',
        acpSessionId: 'acp-transient',
        cwd: '/workspace/ntr-demo',
        running: true,
        closed: false,
        seq: 1,
      },
    })
    await click(screen.getByRole('button', { name: '保存更改' }))
    const dialog = screen.getByRole('alertdialog')
    // The dialog names the LOCAL row only; the gate snapshot had none.
    expect(dialog.textContent).toContain('acp-transient')
    expect(screen.queryByText('acp-1')).toBeNull()
    expect(screen.getByText('读取保存状态失败，请稍后重试。')).toBeDefined()
    // A transient read failure keeps the queue gesture.
    expect(screen.getByRole('button', { name: '回合结束后保存' })).toBeDefined()
    await click(screen.getByRole('button', { name: '回合结束后保存' }))
    expect(payloads(fixture, 'agent/save')).toEqual([
      expect.objectContaining({ id: 'codebuddy', saveMode: 'defer' }),
    ])
  })

  it('treats an old-shape snapshot without gateAvailable as unavailable', async () => {
    const oldShape = {
      canSave: false,
      activeTurns: 1,
      activeSessions: [],
      pending: [],
      timeoutMs: 600_000,
    } as unknown as SaveGateStatus
    const fixture = await dirtyCodeBuddy({ saveGate: oldShape })
    expect(saveGateIsAvailable(oldShape)).toBe(false)
    expect(saveGateIsAvailable(await fixture.store.readSaveGate())).toBe(false)

    await fixture.applyEvent({
      type: 'session/created',
      sessionId: 'acp-local',
      session: {
        sessionId: 'acp-local',
        agentId: 'codebuddy',
        acpSessionId: 'acp-local',
        cwd: '/workspace/ntr-demo',
        running: true,
        closed: false,
        seq: 1,
      },
    })
    await click(screen.getByRole('button', { name: '保存更改' }))
    expect(screen.getByRole('alertdialog')).toBeDefined()
    expect(screen.getByText('有 1 个会话正在运行。现在保存会中断这些会话。')).toBeDefined()
    expect(screen.getByText('acp-local')).toBeDefined()
    // An old-shape snapshot never earns the queue gesture.
    expect(screen.queryByRole('button', { name: '回合结束后保存' })).toBeNull()
    // Local evidence stopped the direct send before the host guard had to answer.
    expect(payloads(fixture, 'agent/save')).toEqual([])

    // With no local turn left the direct save reaches the host, whose guard
    // answers `confirmationRequired`; the dialog opens without the queue gesture.
    await click(screen.getByRole('button', { name: '取消' }))
    await fixture.applyEvent({ type: 'session/closed', sessionId: 'acp-local' })
    await click(screen.getByRole('button', { name: '保存更改' }))
    expect(screen.getByRole('alertdialog')).toBeDefined()
    expect(screen.queryByRole('button', { name: '回合结束后保存' })).toBeNull()
    expect(payloads(fixture, 'agent/save')).toEqual([
      expect.objectContaining({ id: 'codebuddy', saveMode: 'direct' }),
    ])
  })

  it('shows no success receipt when the agent was deleted mid-save', async () => {
    const fixture = await dirtyCodeBuddy({ saveGate: undefined, agentSaveCancelled: true })
    await click(screen.getByRole('button', { name: '保存更改' }))
    expect(screen.queryByText('✓ 已保存')).toBeNull()
    // The form stays dirty and offers the same save again.
    expect(screen.getByRole('button', { name: '保存更改' })).toBeDefined()
    expect(fixture.store.getSnapshot().saveBanners).toEqual([])
    expect(payloads(fixture, 'agent/probe-models')).toEqual([])
    expect(payloads(fixture, 'agent/save')).toEqual([
      expect.objectContaining({ id: 'codebuddy', saveMode: 'direct' }),
    ])
  })

  it('re-sends the cancellation when the form is edited while the first cancel is in flight', async () => {
    let releaseCancel = (): void => {}
    const cancelGate = new Promise<void>((resolve) => { releaseCancel = resolve })
    const fixture = await dirtyCodeBuddy({ saveGate: activeGate, saveCancelGate: cancelGate })
    await click(screen.getByRole('button', { name: '保存更改' }))
    await click(screen.getByRole('button', { name: '回合结束后保存' }))

    fireEvent.change(textbox('显示名'), { target: { value: 'CodeBuddy 第一次编辑' } })
    await waitFor(() => {
      expect(payloads(fixture, 'save/cancel')).toHaveLength(1)
    })
    // The second edit lands while the first cancellation is waiting on the host.
    fireEvent.change(textbox('显示名'), { target: { value: 'CodeBuddy 第二次编辑' } })
    await act(async () => {
      releaseCancel()
      await Promise.resolve()
    })
    await waitFor(() => {
      expect(payloads(fixture, 'save/cancel')).toHaveLength(2)
    })
    expect(screen.getByText('已取消暂存，请重新保存。')).toBeDefined()
  })

  it('warns before a new agent reuses an id deleted in this run', async () => {
    const fixture = await mountPanel()
    await fixture.store.deleteAgent('codebuddy')
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: '管理 CodeBuddy' })).toBeNull()
    })
    await click(screen.getByRole('button', { name: '添加智能体' }))
    await click(screen.getByRole('button', { name: '自定义' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Agent ID' }), { target: { value: 'codebuddy' } })
    expect(screen.getByText('该 id 在本次运行中不可复用，需重启宿主或换一个 id。')).toBeDefined()
    expect(screen.getByRole('button', { name: '保存并启用' }).hasAttribute('disabled')).toBe(true)
  })

  it('renders a write-failure notice from the dsh-ntr source in the runtime log', async () => {
    const fixture = await mountPanel()
    const text = 'profile write failed: revision conflict'
    await fixture.applyEvent({ type: 'agent/notice', agentId: 'dsh-ntr', level: 'error', text })
    await category('日志')
    expect(screen.getByText(text)).toBeDefined()
    expect(screen.getByText('dsh-ntr')).toBeDefined()
  })
})

describe('AcpSettingsSection navigation', () => {
  it('starts with collapsed agents, no creation form, and no model cache read or probe', async () => {
    const fixture = await mountPanel()
    const nav = screen.getByRole('navigation', { name: 'NTR 设置分类' })
    expect(within(nav).getAllByRole('button').map(button => button.textContent)).toEqual(['智能体', '审批时限', '进程管理', '对话外观', '日志'])
    expect(within(nav).getByRole('button', { name: '智能体', pressed: true })).toBeDefined()
    expect(screen.getByRole('region', { name: '已接入的智能体' })).toBeDefined()
    expect(screen.getByRole('button', { name: '管理 CodeBuddy', expanded: false })).toBeDefined()
    expect(screen.getByRole('button', { name: '管理 pi', expanded: false })).toBeDefined()
    expect(screen.queryByRole('navigation', { name: 'CodeBuddy 配置' })).toBeNull()
    expect(screen.queryByRole('textbox')).toBeNull()
    // Query the hidden add page explicitly: hidden inputs would still count.
    expect(within(screen.getByLabelText('添加智能体')).queryByRole('textbox', { hidden: true })).toBeNull()
    expect(screen.queryByRole('heading', { name: '审批时限' })).toBeNull()
    expect(screen.queryByRole('heading', { name: '对话外观' })).toBeNull()
    expect(payloads(fixture, 'agent/cached-models')).toEqual([])
    expect(payloads(fixture, 'agent/probe-models')).toEqual([])
  })

  it('shows the host version as a badge next to the page title', async () => {
    await mountPanel({ pluginVersion: '9.9.9' })
    expect(screen.getByText('v9.9.9').className).toContain('dwa-version')
  })

  it('hides the version badge on a host half without the endpoint', async () => {
    await mountPanel({ pluginVersion: null })
    expect(document.querySelector('.dwa-version')).toBeNull()
  })

  it('shows only the running version when the plugin is up to date', async () => {
    const fixture = await mountPanel()
    expect(screen.getByText('v0.2.1').className).toContain('dwa-version')
    expect(screen.queryByText(/可更新/)).toBeNull()
    expect(payloads(fixture, 'plugin/update-check')).toEqual([{}])
  })

  it('opens the update card from the version badge when up to date', async () => {
    await mountPanel()
    await click(await screen.findByRole('button', { name: 'v0.2.1' }))
    expect(screen.getByText('已是最新版本。')).toBeDefined()
    expect(screen.getByRole('button', { name: '重新检查' })).toBeDefined()
  })

  it('opens the update card from the version badge after a failed check', async () => {
    await mountPanel({
      pluginUpdate: { status: 'failed', current: '0.2.1', latest: '9.9.9', message: 'registry timeout' },
    })
    await click(await screen.findByRole('button', { name: 'v0.2.1' }))
    expect(screen.getByText('更新失败。')).toBeDefined()
    expect(screen.getByText('registry timeout')).toBeDefined()
  })

  it('offers an available update, opens the card, and installs the exact version', async () => {
    const fixture = await mountPanel({
      pluginUpdate: {
        status: 'available', current: '0.2.1', installed: '0.2.1', latest: '9.9.9',
        publishedAt: '2026-10-28T00:00:00.000Z',
      },
    })
    const badge = await screen.findByRole('button', { name: '可更新 v9.9.9' })
    expect(badge.className).toContain('dwa-update-badge')
    await click(badge)
    expect(screen.getByText('最新 v9.9.9')).toBeDefined()
    expect(screen.getByText('当前 v0.2.1')).toBeDefined()
    expect(screen.getByText(/更新会卸载并重装插件/)).toBeDefined()

    await click(screen.getByRole('button', { name: '更新' }))
    await waitFor(() => expect(payloads(fixture, 'plugin/update-apply')).toEqual([{ version: '9.9.9' }]))
    await waitFor(() => expect(screen.getByText(/重启 DSH 后生效/)).toBeDefined())
    expect(screen.getByText('待重启 v9.9.9')).toBeDefined()
  })

  it('lets the applying badge open the card mid-install', async () => {
    await mountPanel({
      pluginUpdate: { status: 'applying', current: '0.2.1', installed: '0.2.1', latest: '9.9.9' },
    })
    await click(await screen.findByRole('button', { name: '更新中…' }))
    expect(screen.getByText('当前 v0.2.1')).toBeDefined()
    expect(screen.getByRole('button', { name: '正在更新…' })).toBeDefined()
  })

  it('hides the update entry on a host without the update endpoints', async () => {
    const fixture = await mountPanel({ pluginUpdate: null })
    await waitFor(() => expect(payloads(fixture, 'plugin/update-check')).toEqual([{}]))
    expect(screen.getByText('v0.2.1')).toBeDefined()
    expect(document.querySelector('.dwa-update-badge')).toBeNull()
    expect(fixture.store.getSnapshot().notice).toBeUndefined()
    expect(screen.queryByText(/unknown endpoint/)).toBeNull()
  })

  it('marks a source install and explains it cannot be updated here', async () => {
    await mountPanel({ pluginUpdate: { status: 'source-install', current: '0.2.1', installed: '0.2.1' } })
    const version = await screen.findByTitle('源码或本地安装，无法通过 registry 更新。')
    expect(screen.queryByText(/可更新/)).toBeNull()
    expect(document.querySelector('.dwa-update-badge')).toBeNull()
    await click(version)
    expect(screen.getByText('源码或本地安装，无法通过 registry 更新。', { selector: '.dwa-update-copy' })).toBeDefined()
  })

  it('does not name a disk version when the install response was interrupted', async () => {
    await mountPanel({
      pluginUpdate: { status: 'available', current: '0.2.1', installed: '0.2.1', latest: '9.9.9' },
      pluginUpdateApplyError: 'socket hang up',
    })
    await click(await screen.findByRole('button', { name: '可更新 v9.9.9' }))
    await click(screen.getByRole('button', { name: '更新' }))
    await waitFor(() => expect(screen.getByText('更新可能已完成，请刷新页面确认当前版本。')).toBeDefined())
    expect(screen.queryByText(/磁盘已是/)).toBeNull()
    // The disk version is unknown: no restart badge may invent one.
    expect(screen.queryByText(/待重启/)).toBeNull()
    expect(document.querySelector('.dwa-update-badge')).toBeNull()
  })

  it('keeps the version badge as the only update entry without a known disk version', async () => {
    await mountPanel({ pluginUpdate: { status: 'restart-required', current: '0.2.1', latest: '9.9.9' } })
    await waitFor(() => expect(document.querySelector('.dwa-update-badge')).toBeNull())
    await click(await screen.findByRole('button', { name: 'v0.2.1' }))
    expect(screen.getByText('更新可能已完成，请刷新页面确认当前版本。')).toBeDefined()
    expect(screen.queryByText(/磁盘已是/)).toBeNull()
  })

  it('moves agent notices into the runtime log and clears the unread dot', async () => {
    const fixture = await mountPanel()
    await act(async () => {
      await fixture.applyEvent({ type: 'agent/notice', agentId: 'pi', level: 'info', text: 'one' })
      await fixture.applyEvent({ type: 'agent/notice', agentId: 'pi', level: 'error', text: 'two' })
    })
    const nav = screen.getByRole('navigation', { name: 'NTR 设置分类' })
    const logsButton = within(nav).getByRole('button', { name: '日志' })
    // The dot is decoration only: the tab's name stays exactly 日志.
    expect(logsButton.textContent).toBe('日志')
    expect(logsButton.querySelector('.dwa-log-dot')?.getAttribute('aria-hidden')).toBe('true')

    await click(logsButton)
    const region = screen.getByRole('region', { name: '运行日志' })
    expect(within(nav).getByRole('button', { name: '日志' }).querySelector('.dwa-log-dot')).toBeNull()
    expect(within(region).queryByText('暂无运行日志。')).toBeNull()
    const rows = within(region).getAllByRole('listitem')
    expect(rows).toHaveLength(2)
    expect(rows[0].textContent).toContain('two')
    expect(rows[1].textContent).toContain('one')
    expect(rows[0].querySelector('.dwa-log-level.is-error')?.textContent).toBe('错误')
    expect(rows[1].querySelector('.dwa-log-level.is-info')?.textContent).toBe('信息')

    await click(within(region).getByRole('button', { name: '清空' }))
    expect(within(region).getByText('暂无运行日志。')).toBeDefined()
  })

  it('shows only the chosen category and keeps the other pages mounted', async () => {
    const fixture = await mountPanel()
    const agents = screen.getByRole('region', { name: '已接入的智能体' })
    await category('审批时限')
    const approvals = screen.getByRole('heading', { name: '审批时限' })
    expectHiddenButMounted(agents)
    expect(screen.queryByRole('button', { name: '管理 CodeBuddy' })).toBeNull()
    expect(screen.queryByRole('heading', { name: '对话外观' })).toBeNull()

    await category('对话外观')
    const appearance = screen.getByRole('region', { name: '对话外观' })
    expectHiddenButMounted(approvals)
    expect(screen.getByRole('button', { name: '呼吸' })).toBeDefined()
    await category('智能体')
    expectHiddenButMounted(appearance)
    expect(screen.getByRole('region', { name: '已接入的智能体' })).toBe(agents)
    expect(payloads(fixture, 'agent/cached-models')).toEqual([])
    expect(payloads(fixture, 'agent/probe-models')).toEqual([])
  })

  it('offers the idle-release window on the Processes tab and writes the picked rung', async () => {
    const fixture = await mountPanel()
    await category('进程管理')
    expect(screen.getByRole('heading', { name: '空闲释放' })).toBeDefined()
    // The readout names the window in force (30 minutes by default). The tick
    // labels repeat it, so the readout is read from the value block.
    expect(screen.getByText('30 分钟', { selector: '.dwa-deadline-value' })).toBeDefined()

    const slider = screen.getByRole('slider', { name: '释放窗口' }) as HTMLInputElement
    // The ladder is 1 minute, then 5-minute steps: index 3 is 15 minutes.
    fireEvent.change(slider, { target: { value: '3' } })
    await waitFor(() => { expect(payloads(fixture, 'ui/idle-release-set')).toHaveLength(1) })
    expect(payloads(fixture, 'ui/idle-release-set')[0]).toEqual({ idleTimeoutMs: 900_000 })
  })

  it('offers no reset when nothing outranks the deployment baseline', async () => {
    await mountPanel({
      idleRelease: { idleTimeoutMs: 1_800_000, defaultIdleTimeoutMs: 1_800_000 },
    })
    await category('进程管理')
    expect(screen.queryByRole('button', { name: '恢复默认值' })).toBeNull()
    expect(screen.queryByRole('button', { name: '恢复配置文件的值' })).toBeNull()
  })

  it('names the config file window when the user outranks it', async () => {
    // The user picked 15 minutes over the file's 30: the reset appears, and
    // it says it returns to the FILE's value, because that is what it does.
    await mountPanel({
      idleRelease: {
        idleTimeoutMs: 900_000,
        defaultIdleTimeoutMs: 1_800_000,
        configuredIdleTimeoutMs: 1_800_000,
      },
    })
    await category('进程管理')
    expect(screen.getByRole('button', { name: '恢复配置文件的值' })).toBeDefined()
    // The fact being overridden is visible, in warning ink.
    expect(screen.getByText(/配置文件（cordis.patch.yml）设为 30 分钟/)).toBeDefined()
  })

  it('hides the Processes tab on a host without the idle-release RPC', async () => {
    const fixture = await mountPanel({ idleRelease: null })
    expect(screen.queryByRole('button', { name: '进程管理' })).toBeNull()
  })

  it('lets a per-agent override pin one agent while the global window governs the rest', async () => {
    const fixture = await mountPanel({
      agents: [{
        id: 'codebuddy', title: 'CodeBuddy', command: 'codebuddy', args: ['--acp'],
        cwd: '/workspace/ntr-demo', allowedCwdRoots: ['/workspace/ntr-demo'], idleTimeoutMs: 900_000,
      }],
    })
    await click(screen.getByRole('button', { name: '管理 CodeBuddy' }))
    await detail('高级')
    // The agent's OWN override is shown, not the host's resolved window.
    expect((textbox('空闲释放覆盖（毫秒）') as HTMLInputElement).value).toBe('900000')
  })

  it('reads the cache only for an expanded, active model page; navigation never probes', async () => {
    // An empty cache keeps duplicate reads observable.
    const fixture = await mountPanel({ catalogs: { codebuddy: null } })
    await click(screen.getByRole('button', { name: '管理 CodeBuddy' }))
    expect(within(screen.getByRole('navigation', { name: 'CodeBuddy 配置' })).getAllByRole('button').map(button => button.textContent))
      .toEqual(['模型', '连接', '高级'])
    expect(payloads(fixture, 'agent/cached-models')).toEqual([{ agentId: 'codebuddy' }])
    await detail('连接')
    await click(screen.getByRole('button', { name: '收起 CodeBuddy' }))
    await click(screen.getByRole('button', { name: '管理 CodeBuddy' }))
    await detail('高级')
    await category('对话外观')
    await category('智能体')
    expect(payloads(fixture, 'agent/cached-models')).toEqual([{ agentId: 'codebuddy' }])
    await detail('模型')
    expect(payloads(fixture, 'agent/cached-models')).toEqual([{ agentId: 'codebuddy' }, { agentId: 'codebuddy' }])
    expect(payloads(fixture, 'agent/probe-models')).toEqual([])
  })

  it('distinguishes an unanswered roster from an empty configured roster', async () => {
    let release!: () => void
    const initialResyncGate = new Promise<void>(resolve => { release = resolve })
    const fixture = createPanelFixture({ agents: [], initialResyncGate })
    render(createElement(AcpSettingsSection, { acp: fixture.store }))
    expect(screen.getByRole('status').textContent).toBe('正在读取智能体…')
    expect(screen.queryByRole('heading', { name: '接入第一个智能体' })).toBeNull()
    expect(screen.queryByRole('button', { name: '添加智能体' })).toBeNull()
    expect(screen.queryByRole('button', { name: '审批时限' })).toBeNull()

    await act(async () => { release(); await fixture.ready })
    expect(screen.queryByText('正在读取智能体…')).toBeNull()
    expect(screen.getByRole('heading', { name: '接入第一个智能体' })).toBeDefined()
    expect(screen.getByRole('button', { name: '添加智能体' })).toBeDefined()
    expect(screen.getByRole('button', { name: '审批时限' })).toBeDefined()
    expect(screen.queryByRole('button', { name: /^管理 / })).toBeNull()
    expect(payloads(fixture, 'agent/cached-models')).toEqual([])
    expect(payloads(fixture, 'agent/probe-models')).toEqual([])
  })

  it('omits the approval category on a host without its RPC, without losing permission answers', async () => {
    await mountPanel({ approvalDeadlines: null, permissions: [permission()] })
    const nav = screen.getByRole('navigation', { name: 'NTR 设置分类' })
    expect(within(nav).getAllByRole('button').map(button => button.textContent)).toEqual(['智能体', '进程管理', '对话外观', '日志'])
    expect(screen.queryByRole('slider', { name: '等待时长', hidden: true })).toBeNull()
    await category('对话外观')
    expect(screen.getByRole('button', { name: 'Always Allow' })).toBeDefined()
  })

  it('keeps normal preset provenance behind View diagnostics', async () => {
    await mountPanel()
    const source = 'dsh-ntr/presets/acp/acp.patch.yml'
    expect(screen.queryByText(source)).toBeNull()
    expect(screen.queryByText('NTR 模式需要检查，当前可能无法开始对话。')).toBeNull()
    await click(screen.getByRole('button', { name: '查看诊断' }))
    expect(screen.getByRole('heading', { name: '连接诊断' })).toBeDefined()
    expect(isInaccessible(screen.getByText(source))).toBe(false)
    await category('对话外观')
    expect(screen.queryByRole('heading', { name: '连接诊断' })).toBeNull()
    // It may be unmounted or hidden; either way it must not leak into a normal page.
    const provenance = screen.queryByText(source)
    expect(provenance === null || isInaccessible(provenance)).toBe(true)
  })

  it('shows an unusable preset warning globally, not just inside diagnostics', async () => {
    await mountPanel({ preset: { id: 'acp', source: 'broken/acp.patch.yml', installed: false, problem: 'preset composition failed' } })
    for (const name of ['智能体', '审批时限', '对话外观']) {
      await category(name)
      expect(screen.getByRole('status').textContent).toContain('NTR 模式需要检查')
      expect(within(screen.getByRole('status')).getByRole('button', { name: '查看诊断' })).toBeDefined()
      expect(screen.queryByText('broken/acp.patch.yml')).toBeNull()
    }
    await click(within(screen.getByRole('status')).getByRole('button', { name: '查看诊断' }))
    expect(screen.getByText('宿主报告：preset composition failed')).toBeDefined()
  })
})

describe('AcpSettingsSection editing', () => {
  it('preserves connection and partial MCP drafts across detail tabs, categories, and collapse', async () => {
    const fixture = await mountPanel()
    await click(screen.getByRole('button', { name: '管理 CodeBuddy' }))
    await detail('连接')
    const title = textbox('显示名')
    const command = textbox('启动命令（程序 + 参数）')
    fireEvent.change(title, { target: { value: 'CodeBuddy 本地草稿' } })
    fireEvent.change(command, { target: { value: 'codebuddy --acp --verbose' } })
    await detail('高级')
    const mcp = screen.getByRole('textbox', { name: 'MCP 服务器（JSON）' }) as HTMLTextAreaElement
    const partialJson = '[{"name":"unfinished"'
    fireEvent.change(mcp, { target: { value: partialJson } })
    await detail('模型')
    expectHiddenButMounted(title)
    expectHiddenButMounted(command)
    expectHiddenButMounted(mcp)
    await category('审批时限')
    await category('对话外观')
    await category('智能体')
    await click(screen.getByRole('button', { name: '收起 CodeBuddy' }))
    expectHiddenButMounted(mcp)
    await click(screen.getByRole('button', { name: '管理 CodeBuddy' }))
    await detail('连接')
    expect(textbox('显示名')).toBe(title)
    expect(title.value).toBe('CodeBuddy 本地草稿')
    expect(textbox('启动命令（程序 + 参数）')).toBe(command)
    expect(command.value).toBe('codebuddy --acp --verbose')
    await detail('高级')
    expect(screen.getByRole('textbox', { name: 'MCP 服务器（JSON）' })).toBe(mcp)
    expect(mcp.value).toBe(partialJson)
    expect(payloads(fixture, 'agent/save')).toEqual([])
    expect(payloads(fixture, 'agent/probe-models')).toEqual([])
  })

  it('preserves the model search itself when the row or category is hidden', async () => {
    const fixture = await mountPanel()
    await click(screen.getByRole('button', { name: '管理 CodeBuddy' }))
    const search = textbox('搜索模型')
    fireEvent.change(search, { target: { value: 'sonnet' } })
    await detail('连接')
    expectHiddenButMounted(search)
    await category('对话外观')
    await category('智能体')
    await click(screen.getByRole('button', { name: '收起 CodeBuddy' }))
    await click(screen.getByRole('button', { name: '管理 CodeBuddy' }))
    await detail('模型')
    expect(textbox('搜索模型')).toBe(search)
    expect(search.value).toBe('sonnet')
    expect(screen.getByRole('button', { name: /Claude Sonnet 4/ })).toBeDefined()
    expect(payloads(fixture, 'agent/probe-models')).toEqual([])
  })

  it('disables unchanged saves and enables Save changes only while the form is dirty', async () => {
    const fixture = await mountPanel()
    await click(screen.getByRole('button', { name: '管理 CodeBuddy' }))
    await detail('连接')
    const save = screen.getByRole('button', { name: /^保存/ }) as HTMLButtonElement
    expect(save.disabled).toBe(true)
    const title = textbox('显示名')
    fireEvent.change(title, { target: { value: 'CodeBuddy 已编辑' } })
    expect((screen.getByRole('button', { name: '保存更改' }) as HTMLButtonElement).disabled).toBe(false)
    fireEvent.change(title, { target: { value: 'CodeBuddy' } })
    expect(save.disabled).toBe(true)
    fireEvent.change(title, { target: { value: 'CodeBuddy 已编辑' } })
    await click(screen.getByRole('button', { name: '保存更改' }))
    expect(payloads(fixture, 'agent/save')).toHaveLength(1)
    expect(payloads(fixture, 'agent/save')[0]).toMatchObject({ id: 'codebuddy', title: 'CodeBuddy 已编辑', command: 'codebuddy', args: ['--acp'] })
    expect(screen.getByRole('button', { name: '收起 CodeBuddy 已编辑' })).toBeDefined()
    await act(async () => { await fixture.store.resync() })
    expect(textbox('显示名').value).toBe('CodeBuddy 已编辑')
    expect(save.disabled).toBe(true)
  })

  it('can clear an idle-release override and becomes clean again after saving', async () => {
    const fixture = await mountPanel({ agents: [{
      id: 'codebuddy', title: 'CodeBuddy', command: 'codebuddy', args: ['--acp'],
      cwd: '/workspace/ntr-demo', allowedCwdRoots: ['/workspace/ntr-demo'], idleTimeoutMs: 0,
    }] })
    await click(screen.getByRole('button', { name: '管理 CodeBuddy' }))
    await detail('高级')
    const save = screen.getByRole('button', { name: '保存更改' }) as HTMLButtonElement
    expect(save.disabled).toBe(true)
    fireEvent.change(textbox('空闲释放覆盖（毫秒）'), { target: { value: '' } })
    expect(save.disabled).toBe(false)
    await click(save)
    expect(payloads(fixture, 'agent/save')).toHaveLength(1)
    expect(payloads(fixture, 'agent/save')[0]).not.toHaveProperty('idleTimeoutMs')
    await act(async () => { await fixture.store.resync() })
    expect(save.disabled).toBe(true)
  })

  it('mounts Add only on demand, retains its draft on return, then returns to the list after saving', async () => {
    const fixture = await mountPanel()
    await click(screen.getByRole('button', { name: '添加智能体' }))
    expect(screen.queryByRole('button', { name: '管理 CodeBuddy' })).toBeNull()
    await click(screen.getByRole('button', { name: '自定义' }))
    const id = textbox('Agent ID')
    const title = textbox('显示名')
    const command = textbox('启动命令（程序 + 参数）')
    fireEvent.change(id, { target: { value: 'local-helper' } })
    fireEvent.change(title, { target: { value: '我的本地助手' } })
    fireEvent.change(command, { target: { value: 'local-acp --stdio' } })
    await click(screen.getByRole('button', { name: '返回智能体列表' }))
    expectHiddenButMounted(title)
    expectHiddenButMounted(command)
    expect(screen.getByRole('button', { name: '管理 CodeBuddy' })).toBeDefined()
    await category('对话外观')
    await category('智能体')
    await click(screen.getByRole('button', { name: '添加智能体' }))
    expect(textbox('显示名')).toBe(title)
    expect(title.value).toBe('我的本地助手')
    expect(textbox('启动命令（程序 + 参数）')).toBe(command)
    expect(command.value).toBe('local-acp --stdio')
    expect(id.value).toBe('local-helper')
    expect(payloads(fixture, 'agent/save')).toEqual([])
    await click(screen.getByRole('button', { name: '保存并启用' }))
    expect(payloads(fixture, 'agent/save')).toHaveLength(1)
    expect(payloads(fixture, 'agent/save')[0]).toMatchObject({ id: 'local-helper', title: '我的本地助手', command: 'local-acp', args: ['--stdio'] })
    expect(screen.getByRole('button', { name: '管理 我的本地助手' })).toBeDefined()
    expect(screen.queryByRole('button', { name: '返回智能体列表' })).toBeNull()
    expect(screen.getByRole('region', { name: '已接入的智能体' })).toBeDefined()
  })

  it('persists model selection and auto-discovery only through lightweight RPCs', async () => {
    const fixture = await mountPanel()
    await click(screen.getByRole('button', { name: '管理 CodeBuddy' }))
    await click(screen.getByRole('button', { name: /Claude Sonnet 4/ }))
    await waitFor(() => expect(payloads(fixture, 'agent/set-exposed-models')).toEqual([
      { agentId: 'codebuddy', exposedModels: ['deepseek-v3', 'claude-sonnet-4'] },
    ]))
    await click(screen.getByRole('button', { name: '清空' }))
    await waitFor(() => expect(payloads(fixture, 'agent/set-exposed-models').at(-1)).toEqual({ agentId: 'codebuddy', exposedModels: [] }))
    await click(screen.getByRole('checkbox', { name: '自动发现新模型' }))
    expect(payloads(fixture, 'agent/set-auto-discover-models')).toEqual([{ agentId: 'codebuddy', autoDiscoverModels: false }])
    await act(async () => { await fixture.store.resync() })
    expect((screen.getByRole('checkbox', { name: '自动发现新模型' }) as HTMLInputElement).checked).toBe(false)
    expect((screen.getByRole('button', { name: '清空' }) as HTMLButtonElement).disabled).toBe(true)
    expect(payloads(fixture, 'agent/save')).toEqual([])
    expect(payloads(fixture, 'agent/probe-models')).toEqual([])
    expect(payloads(fixture, 'agent/stop')).toEqual([])
  })

  it('persists the plugin default and appearance through their own RPCs', async () => {
    const fixture = await mountPanel()
    await click(screen.getByRole('button', { name: '管理 pi' }))
    await click(screen.getByRole('button', { name: '设为默认智能体' }))
    expect(payloads(fixture, 'default/agent-set')).toEqual([{ agentId: 'pi' }])
    await category('对话外观')
    await click(screen.getByRole('button', { name: '快速' }))
    await click(screen.getByRole('button', { name: '常亮' }))
    expect(payloads(fixture, 'ui/tag-halo-set')).toEqual([
      { halo: { mode: 'breath', speed: 'fast' } }, { halo: { mode: 'steady', speed: 'fast' } },
    ])
    await act(async () => { await fixture.store.resync() })
    expect(fixture.store.getSnapshot().defaultAgent).toBe('pi')
    expect(fixture.store.getSnapshot().tagHalo).toEqual({ mode: 'steady', speed: 'fast' })
    expect(screen.queryByRole('button', { name: '快速' })).toBeNull()
    expect(payloads(fixture, 'agent/save')).toEqual([])
    expect(payloads(fixture, 'agent/probe-models')).toEqual([])
  })
})

describe('AcpSettingsSection permissions', () => {
  it.each(['智能体', '审批时限', '对话外观', '添加智能体'])('answers verbatim permission options and cancels independently from %s', async page => {
    const fixture = await mountPanel()
    if (page === '添加智能体') await click(screen.getByRole('button', { name: page }))
    else await category(page)
    await act(async () => { await fixture.applyEvent(permission()) })
    expect(screen.getByText('Edit project file')).toBeDefined()
    const optionNames = screen.getAllByRole('button').map(button => button.textContent)
      .filter(name => ['Allow once', 'Always Allow', 'Reject once'].includes(name ?? ''))
    expect(optionNames).toEqual(['Allow once', 'Always Allow', 'Reject once'])
    await click(screen.getByRole('button', { name: 'Always Allow' }))
    expect(payloads(fixture, 'permission/respond')).toEqual([{ requestId: 'ask-edit', optionId: 'always' }])
    expect(screen.queryByRole('button', { name: 'Always Allow' })).toBeNull()

    // An RPC-only ask has no conversation identity, but must still be answerable.
    await act(async () => { await fixture.applyEvent(permission({ requestId: 'ask-cancel', dshSessionId: undefined })) })
    await category(page === '对话外观' ? '智能体' : '对话外观')
    expect(screen.getByRole('button', { name: 'Reject once' })).toBeDefined()
    // Independent cancellation must not select the agent's rejection option.
    await click(screen.getByRole('button', { name: '取消' }))
    expect(payloads(fixture, 'permission/respond')).toEqual([
      { requestId: 'ask-edit', optionId: 'always' }, { requestId: 'ask-cancel' },
    ])
    expect(screen.queryByText('待处理权限请求')).toBeNull()
  })

  it('draws no slider for default wait, offers zero for auto, and starts abort at a real wait', async () => {
    const fixture = await mountPanel()
    await category('审批时限')
    expect(screen.getByRole('button', { name: '一直等待' })).toBeDefined()
    expect(screen.queryByRole('slider', { name: '等待时长', hidden: true })).toBeNull()
    expect(screen.queryByRole('button', { name: '恢复配置文件的值' })).toBeNull()
    expect(payloads(fixture, 'ui/approval-deadlines-set')).toEqual([])

    await click(screen.getByRole('button', { name: '自动推进' }))
    let slider = screen.getByRole('slider', { name: '等待时长' }) as HTMLInputElement
    await act(async () => { fireEvent.change(slider, { target: { value: slider.min } }) })
    expect(payloads(fixture, 'ui/approval-deadlines-set')).toEqual([{ mode: 'auto' }, { permissionTimeoutMs: 0 }])
    expect(screen.getAllByText('不等待').length).toBeGreaterThan(0)
    expect(fixture.store.getSnapshot().approvalDeadlines).toMatchObject({ mode: 'auto', permissionTimeoutMs: 0 })

    await click(screen.getByRole('button', { name: '超时中止' }))
    expect(screen.queryByText('不等待')).toBeNull()
    slider = screen.getByRole('slider', { name: '等待时长' }) as HTMLInputElement
    expect(slider.value).toBe(slider.min)
    expect(fixture.store.getSnapshot().approvalDeadlines).toMatchObject({ mode: 'abort', permissionTimeoutMs: 30_000 })
    // Move away and back to exercise the abort ladder's first selectable value.
    await act(async () => { fireEvent.change(slider, { target: { value: slider.max } }) })
    await act(async () => { fireEvent.change(slider, { target: { value: slider.min } }) })
    expect(payloads(fixture, 'ui/approval-deadlines-set').slice(2)).toEqual([
      { mode: 'abort' }, { permissionTimeoutMs: 21_600_000 }, { permissionTimeoutMs: 30_000 },
    ])
    await click(screen.getByRole('button', { name: '一直等待' }))
    expect(screen.queryByRole('slider', { name: '等待时长', hidden: true })).toBeNull()
    expect(payloads(fixture, 'ui/approval-deadlines-set').at(-1)).toEqual({ mode: 'wait' })
  })

  it('resets a real approval override to the host baseline', async () => {
    const fixture = await mountPanel({ approvalDeadlines: {
      mode: 'auto', permissionTimeoutMs: 0, configuredMode: 'wait', configured: { permissionTimeoutMs: 300_000 },
    } })
    await category('审批时限')
    await click(screen.getByRole('button', { name: '恢复配置文件的值' }))
    expect(payloads(fixture, 'ui/approval-deadlines-set')).toEqual([{ reset: true }])
    expect(screen.queryByRole('button', { name: '恢复配置文件的值' })).toBeNull()
    expect(screen.queryByRole('slider', { name: '等待时长', hidden: true })).toBeNull()
    await act(async () => { await fixture.store.resync() })
    expect(fixture.store.getSnapshot().approvalDeadlines).toMatchObject({ mode: 'wait', permissionTimeoutMs: 300_000 })
  })
})
