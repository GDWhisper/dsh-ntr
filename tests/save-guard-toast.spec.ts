// @vitest-environment jsdom

/**
 * The save-guard toast's visibility rule and the page-top banner surface:
 * failures stay until dismissed, success auto-hides, and the same reason never
 * stacks. A refused save and the HMR reload delay are announced as alerts.
 */

import { createElement } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SaveGuardToast, saveGuardToastKind } from '../src/client/save-guard-toast.tsx'
import type { SaveGateStatus } from '../src/protocol.ts'
import { createPanelFixture } from './panel-fixture.ts'

afterEach(() => {
  cleanup()
  // Closed-row records live in the tab, so they outlive one test's DOM. Each
  // test starts from a fresh tab or the next store would seed suppressed rows.
  sessionStorage.clear()
})

function status(overrides: Partial<SaveGateStatus> = {}): SaveGateStatus {
  return {
    canSave: true,
    gateAvailable: true,
    activeTurns: 0,
    activeSessions: [],
    pending: [],
    timeoutMs: 600_000,
    ...overrides,
  }
}

describe('saveGuardToastKind', () => {
  it('shows while a write is held, counting any number of queued writes', () => {
    expect(saveGuardToastKind(status({
      canSave: false,
      pending: [{ id: 'save-1', label: 'settings:llm-pi-ai', queuedAt: 1 }],
    }))).toBe('pending')
  })

  it('shows an expiry until the user dismisses that exact outcome', () => {
    const expired = status({ lastOutcome: { at: 2, status: 'expired', label: 'settings:llm-pi-ai' } })
    expect(saveGuardToastKind(expired)).toBe('expired')
    expect(saveGuardToastKind(expired, 2)).toBeUndefined()
  })

  it('shows a failure until dismissed, and hides successful deferred writes', () => {
    const failed = status({ lastOutcome: { at: 3, status: 'failed', label: 'settings:llm-pi-ai', message: 'conflict' } })
    expect(saveGuardToastKind(failed)).toBe('failed')
    expect(saveGuardToastKind(status({ lastOutcome: { at: 4, status: 'saved', label: 'settings:llm-pi-ai' } }))).toBeUndefined()
    expect(saveGuardToastKind(status({ lastOutcome: { at: 5, status: 'cancelled', label: 'settings:llm-pi-ai' } }))).toBeUndefined()
    expect(saveGuardToastKind(status())).toBeUndefined()
  })
})

describe('SaveGuardToast banners', () => {
  afterEach(() => { vi.useRealTimers() })

  async function mount(): Promise<ReturnType<typeof createPanelFixture>> {
    const fixture = createPanelFixture()
    await fixture.ready
    render(createElement(SaveGuardToast, { acp: fixture.store }))
    return fixture
  }

  it('announces a save failure as an alert and closes it with the keyboard-accessible button', async () => {
    const fixture = await mount()
    await act(async () => {
      await fixture.applyEvent({
        type: 'save/status',
        status: {
          canSave: false,
          activeTurns: 1,
          activeSessions: [{ sessionId: 'acp-1', agentId: 'codebuddy' }],
          pending: [],
          timeoutMs: 600_000,
          lastOutcomes: {
            'settings:llm-pi-ai': { at: 5, status: 'failed', label: 'settings:llm-pi-ai', message: 'revision conflict' },
          },
        },
      })
    })
    const alert = screen.getByRole('alert')
    expect(alert.getAttribute('aria-live')).toBe('assertive')
    expect(alert.textContent).toContain('保存失败')
    expect(alert.textContent).toContain('revision conflict')
    fireEvent.click(screen.getByRole('button', { name: '知道了' }))
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('announces the HMR reload delay and auto-hides a success line', async () => {
    vi.useFakeTimers()
    const fixture = await mount()
    await act(async () => {
      await fixture.applyEvent({
        type: 'agent/notice',
        agentId: 'hmr',
        level: 'info',
        text: 'acp: hmr reconcile is still deferred after 60s: the ACP turn has not ended.',
      })
    })
    expect(screen.getByRole('alert').textContent).toContain('热重载')

    await act(async () => {
      await fixture.applyEvent({
        type: 'save/status',
        status: {
          canSave: false,
          activeTurns: 1,
          activeSessions: [{ sessionId: 'acp-1', agentId: 'codebuddy' }],
          pending: [{ id: 'save-1', label: 'settings:llm-pi-ai', queuedAt: 1 }],
          timeoutMs: 600_000,
        },
      })
    })
    await act(async () => {
      await fixture.applyEvent({
        type: 'save/status',
        status: {
          canSave: true,
          activeTurns: 0,
          activeSessions: [],
          pending: [],
          timeoutMs: 600_000,
          lastOutcomes: { 'settings:llm-pi-ai': { at: 6, status: 'saved', label: 'settings:llm-pi-ai' } },
        },
      })
    })
    expect(screen.getByText('保存成功')).toBeDefined()
    expect(screen.getByRole('alert').textContent).toContain('热重载')
    await act(async () => { vi.advanceTimersByTime(2500) })
    expect(screen.queryByText('保存成功')).toBeNull()
  })

  it('pins the banner stack to the page top, centered', async () => {
    const fixture = await mount()
    await act(async () => {
      await fixture.applyEvent({
        type: 'save/status',
        status: {
          canSave: true,
          activeTurns: 0,
          activeSessions: [],
          pending: [],
          timeoutMs: 600_000,
          lastOutcomes: {
            'settings:llm-pi-ai': { at: 5, status: 'failed', label: 'settings:llm-pi-ai', message: 'revision conflict' },
          },
        },
      })
    })
    const stack = screen.getByRole('alert').parentElement
    expect(stack?.style.top).toBe('16px')
    expect(stack?.style.left).toBe('50%')
    expect(stack?.style.transform).toBe('translateX(-50%)')
    expect(stack?.style.right).toBe('')
    expect(stack?.style.bottom).toBe('')
    // A tall stack scrolls inside the viewport instead of running off-screen.
    expect(stack?.style.maxHeight).toBe('calc(100vh - 32px)')
    expect(stack?.style.overflowY).toBe('auto')
    expect(stack?.style.maxWidth).toBe('min(420px, calc(100vw - 40px))')
  })

  it('renders one agent\'s success and another agent\'s failure together', async () => {
    const fixture = await mount()
    await act(async () => {
      await fixture.applyEvent({
        type: 'save/status',
        status: {
          canSave: false,
          gateAvailable: true,
          activeTurns: 2,
          activeSessions: [
            { sessionId: 'acp-codebuddy', agentId: 'codebuddy' },
            { sessionId: 'acp-pi', agentId: 'pi' },
          ],
          pending: [
            { id: 'save-1', label: 'agent-save:codebuddy', queuedAt: 1 },
            { id: 'save-2', label: 'agent-save:pi', queuedAt: 2 },
          ],
          timeoutMs: 600_000,
        },
      })
    })
    await act(async () => {
      await fixture.applyEvent({
        type: 'save/status',
        status: {
          canSave: true,
          gateAvailable: true,
          activeTurns: 0,
          activeSessions: [],
          pending: [],
          timeoutMs: 600_000,
          lastOutcomes: {
            'agent-save:codebuddy': { at: 20, status: 'saved', label: 'agent-save:codebuddy' },
            'agent-save:pi': { at: 21, status: 'failed', label: 'agent-save:pi', message: 'pi boom' },
          },
        },
      })
    })
    const success = screen.getByText('保存成功')
    expect(success.parentElement?.textContent).toContain('CodeBuddy')
    const failure = screen.getByRole('alert')
    expect(failure.textContent).toContain('保存失败')
    expect(failure.textContent).toContain('pi boom')
    // The arriving error did not evict the transient success row.
    expect(success.isConnected).toBe(true)
  })

  it('names both agents in one success row when a single frame settles two saves', async () => {
    const fixture = await mount()
    await act(async () => {
      await fixture.applyEvent({
        type: 'save/status',
        status: {
          canSave: false,
          gateAvailable: true,
          activeTurns: 2,
          activeSessions: [
            { sessionId: 'acp-alpha', agentId: 'alpha' },
            { sessionId: 'acp-beta', agentId: 'beta' },
          ],
          pending: [
            { id: 'save-1', label: 'agent-save:alpha', queuedAt: 1 },
            { id: 'save-2', label: 'agent-save:beta', queuedAt: 2 },
          ],
          timeoutMs: 600_000,
        },
      })
    })
    await act(async () => {
      await fixture.applyEvent({
        type: 'save/status',
        status: {
          canSave: true,
          gateAvailable: true,
          activeTurns: 0,
          activeSessions: [],
          pending: [],
          timeoutMs: 600_000,
          lastOutcomes: {
            'agent-save:alpha': { at: 20, status: 'saved', label: 'agent-save:alpha' },
            'agent-save:beta': { at: 21, status: 'saved', label: 'agent-save:beta' },
          },
        },
      })
    })
    // One row, and its body names every agent in the frame.
    const successes = screen.getAllByText('保存成功')
    expect(successes).toHaveLength(1)
    expect(successes[0]?.parentElement?.textContent).toContain('alpha、beta')
  })

  it('offers "save all now" only for two or more held rows and confirms the interrupted agents', async () => {
    const fixture = await mount()
    await act(async () => {
      await fixture.applyEvent({
        type: 'save/status',
        status: {
          canSave: false,
          gateAvailable: true,
          activeTurns: 1,
          activeSessions: [{ sessionId: 'acp-codebuddy', agentId: 'codebuddy' }],
          pending: [{ id: 'save-1', label: 'agent-save:codebuddy', queuedAt: 1 }],
          timeoutMs: 600_000,
        },
      })
    })
    // One held row is not the all-or-nothing gesture: it stays local to that agent.
    expect(screen.queryByRole('button', { name: '全部立即保存' })).toBeNull()

    await act(async () => {
      await fixture.applyEvent({
        type: 'save/status',
        status: {
          canSave: false,
          gateAvailable: true,
          activeTurns: 2,
          activeSessions: [
            { sessionId: 'acp-codebuddy', agentId: 'codebuddy' },
            { sessionId: 'acp-pi', agentId: 'pi' },
          ],
          pending: [
            { id: 'save-1', label: 'agent-save:codebuddy', queuedAt: 1 },
            { id: 'save-2', label: 'agent-save:pi', queuedAt: 2 },
          ],
          timeoutMs: 600_000,
        },
      })
    })
    fireEvent.click(screen.getByRole('button', { name: '全部立即保存' }))
    const dialog = screen.getByRole('alertdialog', { name: '全部立即保存确认' })
    expect(dialog.textContent).toContain('会写入全部暂存，并中断这些 Agent 正在进行的回合。')
    expect(dialog.textContent).toContain('CodeBuddy（1 个会话）')
    expect(dialog.textContent).toContain('pi（1 个会话）')
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(screen.getByRole('button', { name: '全部立即保存' })).toBeDefined()
  })

  it('closes only the newest banner with the page-level Escape key', async () => {
    const fixture = await mount()
    for (const [index, label] of ['alpha', 'beta'].entries()) {
      await act(async () => {
        await fixture.applyEvent({
          type: 'save/status',
          status: {
            canSave: true,
            activeTurns: 0,
            activeSessions: [],
            pending: [],
            timeoutMs: 600_000,
            lastOutcomes: { [label]: { at: index + 1, status: 'failed', label, message: `${label} error` } },
          },
        })
      })
    }
    expect(screen.getByText(/beta error/)).toBeDefined()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByText(/beta error/)).toBeNull()
    expect(screen.getByText(/alpha error/)).toBeDefined()

    // A focused input keeps its Escape key.
    const input = document.createElement('input')
    document.body.append(input)
    input.focus()
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(screen.getByText(/alpha error/)).toBeDefined()
    input.remove()
  })

  it('folds failure rows beyond six behind one explicit control', async () => {
    const fixture = await mount()
    const outcomes: NonNullable<SaveGateStatus['lastOutcomes']> = {}
    for (let index = 0; index < 7; index += 1) {
      const label = `settings:x${String(index)}`
      outcomes[label] = { at: index + 1, status: 'failed', label, message: `failure ${String(index)}` }
    }
    await act(async () => {
      await fixture.applyEvent({
        type: 'save/status',
        status: {
          canSave: true,
          activeTurns: 0,
          activeSessions: [],
          pending: [],
          timeoutMs: 600_000,
          lastOutcomes: outcomes,
        },
      })
    })
    expect(screen.getByRole('button', { name: '还有 1 条失败' })).toBeDefined()
    expect(screen.queryByText(/failure 0/)).toBeNull()
    expect(screen.getByText(/failure 6/)).toBeDefined()

    fireEvent.click(screen.getByRole('button', { name: '还有 1 条失败' }))
    expect(screen.getByText(/failure 0/)).toBeDefined()
    expect(screen.queryByRole('button', { name: '还有 1 条失败' })).toBeNull()
    const collapse = screen.getByRole('button', { name: '收起' })
    expect(collapse).toBeDefined()
    // The control sits ABOVE the expanded rows, so it stays visible in the
    // scrollable stack instead of being pushed below the viewport.
    expect(collapse.nextElementSibling?.textContent).toContain('failure 0')
  })
})
