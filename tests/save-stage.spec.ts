// @vitest-environment jsdom

/**
 * Stage attribution for one agent's save gesture. A single gate frame can carry
 * both the queue entry and a terminal row, and an edit that lands while a
 * cancellation is in flight must be sent again. Both rules live in the panel's
 * `SaveStage`, so they are exercised through the visible held line.
 */

import { createElement } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { AcpSettingsSection } from '../src/client/panel.tsx'
import type { SaveGateOutcomeView, SaveGateStatus } from '../src/protocol.ts'
import { createPanelFixture, type PanelFixture, type PanelFixtureOptions } from './panel-fixture.ts'

afterEach(cleanup)

const HELD = '配置已暂存，回合结束后自动保存。'
const CANCELLED = '已取消暂存，请重新保存。'

const activeGate: SaveGateStatus = {
  canSave: false,
  gateAvailable: true,
  activeTurns: 1,
  activeSessions: [{ sessionId: 'acp-1', dshSessionId: 'chat-1', agentId: 'codebuddy' }],
  pending: [],
  timeoutMs: 600_000,
}

async function click(element: HTMLElement): Promise<void> {
  await act(async () => { fireEvent.click(element) })
}

async function dirtyCodeBuddy(options: PanelFixtureOptions = {}): Promise<PanelFixture> {
  const fixture = createPanelFixture(options)
  await fixture.ready
  render(createElement(AcpSettingsSection, { acp: fixture.store }))
  await click(screen.getByRole('button', { name: '管理 CodeBuddy' }))
  await click(within(screen.getByRole('navigation', { name: 'CodeBuddy 配置' })).getByRole('button', { name: '连接' }))
  fireEvent.change(screen.getByRole('textbox', { name: '显示名' }), { target: { value: 'CodeBuddy 待保存' } })
  return fixture
}

function payloads(fixture: PanelFixture, endpoint: string): unknown[] {
  return fixture.calls.filter(call => call.endpoint === endpoint).map(call => call.payload)
}

async function deferSave(): Promise<void> {
  await click(screen.getByRole('button', { name: '保存更改' }))
  await click(screen.getByRole('button', { name: '回合结束后保存' }))
}

describe('save stage attribution', () => {
  it('keeps the held stage when one frame carries both the queue entry and a terminal row', async () => {
    const fixture = await dirtyCodeBuddy({ saveGate: activeGate })
    await deferSave()
    expect(screen.getByText(HELD)).toBeDefined()

    const terminal: SaveGateOutcomeView = { at: 7, status: 'cancelled', label: 'agent-save:codebuddy' }
    // One tick, one frame: the label is still queued AND a terminal row exists.
    // The queue branch must win, or the held stage would settle on evidence
    // that belongs to the same frame that keeps the write queued.
    await act(async () => {
      await fixture.applyEvent({
        type: 'save/status',
        status: {
          ...activeGate,
          pending: [{ id: 'save-1', label: 'agent-save:codebuddy', queuedAt: 1 }],
          lastOutcomes: { 'agent-save:codebuddy': terminal },
        },
      })
    })
    expect(screen.getByText(HELD)).toBeDefined()
    expect(screen.queryByText(CANCELLED)).toBeNull()

    // The same terminal row without the queue entry settles the held stage.
    await act(async () => {
      await fixture.applyEvent({
        type: 'save/status',
        status: { ...activeGate, pending: [], lastOutcomes: { 'agent-save:codebuddy': terminal } },
      })
    })
    await waitFor(() => expect(screen.queryByText(HELD)).toBeNull())
    expect(screen.getByText(CANCELLED)).toBeDefined()
  })

  it('re-sends the cancellation when an edit lands while the first cancel is in flight', async () => {
    let releaseCancel = (): void => {}
    const cancelGate = new Promise<void>(resolve => { releaseCancel = resolve })
    const fixture = await dirtyCodeBuddy({ saveGate: activeGate, saveCancelGate: cancelGate })
    await deferSave()
    expect(screen.getByText(HELD)).toBeDefined()

    fireEvent.change(screen.getByRole('textbox', { name: '显示名' }), { target: { value: 'CodeBuddy 第一次编辑' } })
    await waitFor(() => expect(payloads(fixture, 'save/cancel')).toHaveLength(1))
    // The second edit lands while the first cancellation waits on the host:
    // the effect skipped that edit, so the follow-up must resend the label.
    fireEvent.change(screen.getByRole('textbox', { name: '显示名' }), { target: { value: 'CodeBuddy 第二次编辑' } })
    await act(async () => {
      releaseCancel()
      await Promise.resolve()
    })
    await waitFor(() => expect(payloads(fixture, 'save/cancel')).toHaveLength(2))
    expect(payloads(fixture, 'save/cancel')).toEqual([
      expect.objectContaining({ label: 'agent-save:codebuddy' }),
      expect.objectContaining({ label: 'agent-save:codebuddy' }),
    ])
    await waitFor(() => expect(screen.queryByText(HELD)).toBeNull())
    expect(screen.getByText(CANCELLED)).toBeDefined()
  })

  it('does not show the held line while the confirmation dialog owns the save', async () => {
    const fixture = await dirtyCodeBuddy({ saveGate: activeGate })
    await click(screen.getByRole('button', { name: '保存更改' }))
    expect(screen.getByRole('alertdialog')).toBeDefined()
    expect(screen.queryByText(HELD)).toBeNull()

    // The same label enters the queue while the dialog decides the gesture.
    // The dialog owns the save here, so the stage is `confirming`, not `held`.
    await act(async () => {
      await fixture.applyEvent({
        type: 'save/status',
        status: {
          ...activeGate,
          pending: [{ id: 'save-1', label: 'agent-save:codebuddy', queuedAt: 1 }],
        },
      })
    })
    expect(screen.queryByText(HELD)).toBeNull()
    expect(screen.getByRole('alertdialog')).toBeDefined()
  })

  it('keeps the held stage when the confirmation dialog opens over a staged save', async () => {
    const fixture = await dirtyCodeBuddy({ saveGate: activeGate })
    await deferSave()
    expect(screen.getByText(HELD)).toBeDefined()

    // The dialog opening must not overwrite the held stage.
    await click(screen.getByRole('button', { name: '保存更改' }))
    expect(screen.getByRole('alertdialog')).toBeDefined()
    expect(screen.getByText(HELD)).toBeDefined()

    // An edit still cancels the staged write instead of silently losing it.
    fireEvent.change(screen.getByRole('textbox', { name: '显示名' }), { target: { value: 'CodeBuddy 弹窗中编辑' } })
    await waitFor(() => expect(payloads(fixture, 'save/cancel')).toHaveLength(1))
    expect(screen.queryByText(HELD)).toBeNull()
    expect(screen.getByText(CANCELLED)).toBeDefined()
  })
})
