// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { saveGateIsAvailable } from '../../src/client/store.ts'
import type { SaveGateStatus } from '../../src/protocol.ts'
import { category, click, detail, mountPanel, payloads, textbox } from './harness.ts'

afterEach(cleanup)

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
