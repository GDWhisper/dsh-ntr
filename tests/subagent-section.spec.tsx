// @vitest-environment jsdom
/**
 * The NTR view's read-only subagent strip, rendered: an in-flight row's elapsed
 * clock must advance once per second with no store frame to push it (a silent
 * running worker sends no `subagents/record`), and a terminal row must stay
 * frozen. The interval is gated on "any row still in flight", so a strip of
 * only terminal rows schedules no timer at all.
 *
 * The header panel (`subagent-panel.tsx`) uses the same tick helper; its own
 * clock test lives below, including the open-menu gate that keeps relative
 * "last activity" labels fresh.
 *
 * Everything else about both surfaces is pure logic and lives in
 * tests/acp-view.spec.ts; this file exists for the clocks the store cannot drive.
 */

import type { ComponentType } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SubagentSection } from '../src/client/acp-view.tsx'
import { OwnSubagentCatalog } from '../src/client/subagent-panel.tsx'
import type { AcpStore } from '../src/client/store.ts'
import type { SubagentRecord } from '../src/protocol.ts'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

/** Read the Chinese side: the assertions name what a user would read. */
const t = (zh: string): string => zh

function record(patch: Partial<SubagentRecord> = {}): SubagentRecord {
  return {
    childId: 'acp:a',
    dshSessionId: 'chat-1',
    toolCallId: 'a',
    label: 'worker',
    status: 'running',
    startedAt: 0,
    lastActivityAt: 0,
    counts: { updates: 0, toolCalls: 0, textChars: 0 },
    ...patch,
  }
}

function startClock(at = 0): void {
  vi.useFakeTimers()
  vi.setSystemTime(at)
}

describe('the subagent strip clock', () => {
  it('advances an in-flight row once per second without any store frame', () => {
    startClock(1_000_000)
    render(<SubagentSection rows={[record({ startedAt: 1_000_000 })]} served t={t} />)
    expect(screen.getByText('0s')).toBeDefined()
    expect(screen.getByText('累计 1 个 · 1 运行中')).toBeDefined()

    act(() => { vi.advanceTimersByTime(1_000) })
    expect(screen.getByText('1s')).toBeDefined()

    act(() => { vi.advanceTimersByTime(4_000) })
    expect(screen.getByText('5s')).toBeDefined()
  })

  it('freezes a finished row and stops the tick once nothing is in flight', () => {
    startClock(0)
    const view = render(<SubagentSection rows={[record()]} served t={t} />)
    act(() => { vi.advanceTimersByTime(3_000) })
    expect(screen.getByText('3s')).toBeDefined()

    view.rerender(<SubagentSection rows={[record({ status: 'completed', endedAt: 3_000 })]} served t={t} />)
    expect(screen.getByText('3s')).toBeDefined()
    // The interval is gone: the clock moves on, the frozen row does not.
    expect(vi.getTimerCount()).toBe(0)
    act(() => { vi.advanceTimersByTime(60_000) })
    expect(screen.getByText('3s')).toBeDefined()
  })

  it('ticks a pending row without calling it running', () => {
    startClock(0)
    render(<SubagentSection rows={[record({ status: 'pending' })]} served t={t} />)
    // The badge says pending and the header has no running segment; only the
    // elapsed clock moves (it counts from dispatch).
    expect(screen.getByText('等待开始')).toBeDefined()
    expect(screen.getByText('累计 1 个')).toBeDefined()
    act(() => { vi.advanceTimersByTime(2_000) })
    expect(screen.getByText('2s')).toBeDefined()
  })

  it('schedules no timer for a strip of terminal rows', () => {
    startClock(0)
    render(<SubagentSection rows={[record({ status: 'completed', endedAt: 1_000 })]} served t={t} />)
    expect(vi.getTimerCount()).toBe(0)
    act(() => { vi.advanceTimersByTime(5_000) })
    expect(screen.getByText('1s')).toBeDefined()
  })
})

/** The host's own trigger, rendered only on the panel's fail-open branch. */
const HostTrigger: ComponentType<Record<string, unknown>> = () => (
  <span data-testid="host-trigger">host</span>
)

/** A fake injected store: the panel reads `subagents` and `label` only. */
function panelStore(state: Record<string, unknown>): AcpStore {
  return {
    subscribe: () => () => {},
    getSnapshot: () => state,
    label: (zh: string) => zh,
  } as unknown as AcpStore
}

function panelState(records: readonly SubagentRecord[]): Record<string, unknown> {
  return { subagents: Object.fromEntries(records.map(item => [`${item.dshSessionId}\u0000${item.childId}`, item])) }
}

/** The host projection hook, answering as if it held one external row. */
const useSessions = (selector: (value: unknown) => unknown): unknown => selector({
  projectionsBySession: {
    'chat-1': { values: { subagentCatalog: [{ id: 'acp:a', mode: 'external', createdAt: 1_000_000, label: 'worker' }] } },
  },
})

describe('the header subagent panel clock', () => {
  it('ticks a running row once per second and freezes it at its end stamp', () => {
    startClock(1_000_000)
    const running = panelState([record({ startedAt: 1_000_000, status: 'running', lastActivityAt: 1_000_000 })])
    const view = render(
      <OwnSubagentCatalog host={HostTrigger} acp={panelStore(running)} sessionId="chat-1" useSessions={useSessions} />,
    )
    expect(screen.getByText('累计 1 个 · 1 运行中')).toBeDefined()
    fireEvent.click(screen.getByRole('button'))
    expect(screen.getByText('0s')).toBeDefined()

    act(() => { vi.advanceTimersByTime(1_000) })
    expect(screen.getByText('1s')).toBeDefined()

    // Terminal: the row freezes at endedAt - startedAt. The interval stays
    // only because the menu is open (its "last activity" labels are relative),
    // so the elapsed clock no longer moves.
    const done = panelState([record({ startedAt: 1_000_000, status: 'completed', endedAt: 1_003_000 })])
    view.rerender(
      <OwnSubagentCatalog host={HostTrigger} acp={panelStore(done)} sessionId="chat-1" useSessions={useSessions} />,
    )
    expect(screen.getByText('3s')).toBeDefined()
    expect(vi.getTimerCount()).toBe(1)
    act(() => { vi.advanceTimersByTime(60_000) })
    expect(screen.getByText('3s')).toBeDefined()

    // Closing an all-terminal list releases the open-driven interval. The
    // open row is a button too (it opens the detail in Task 3b), so the
    // trigger is selected by its `aria-expanded` state.
    fireEvent.click(screen.getByRole('button', { expanded: true }))
    expect(vi.getTimerCount()).toBe(0)
  })

  it('refreshes relative labels when the list opens long after the last worker finished', () => {
    // A row whose last activity is newer than the last tick used to clamp to
    // "0s" forever, and a menu opened long after mount showed mount-time ages.
    startClock(1_000_000)
    const done = panelState([record({
      startedAt: 1_000_000,
      status: 'completed',
      endedAt: 1_010_000,
      lastActivityAt: 1_010_000,
    })])
    render(
      <OwnSubagentCatalog host={HostTrigger} acp={panelStore(done)} sessionId="chat-1" useSessions={useSessions} />,
    )
    // Nothing is in flight and the menu is shut: no timer, so `now` stands at
    // the mount time while the page runs on.
    expect(vi.getTimerCount()).toBe(0)
    act(() => { vi.advanceTimersByTime(65_000) })

    // Open: the label must be measured from the open (55s), not from the mount
    // (where the activity stamp was still in the future and clamps to 0s).
    fireEvent.click(screen.getByRole('button'))
    expect(screen.getByText(/最后活动 55s 前/)).toBeDefined()
    expect(screen.getByText('10s')).toBeDefined()
    act(() => { vi.advanceTimersByTime(1_000) })
    expect(screen.getByText(/最后活动 56s 前/)).toBeDefined()

    // Shut: the open-driven interval is released again. The open row is a
    // button too, so the trigger is the one that is still expanded.
    fireEvent.click(screen.getByRole('button', { expanded: true }))
    expect(vi.getTimerCount()).toBe(0)

    // Reopened a minute later: measured from the new open, not the old tick.
    act(() => { vi.advanceTimersByTime(60_000) })
    fireEvent.click(screen.getByRole('button'))
    expect(screen.getByText(/最后活动 1m 56s 前/)).toBeDefined()
  })

  it('keeps the panel shut and schedules no timer while nothing runs', () => {
    startClock(0)
    const done = panelState([record({ startedAt: 0, status: 'completed', endedAt: 1_000 })])
    render(
      <OwnSubagentCatalog host={HostTrigger} acp={panelStore(done)} sessionId="chat-1" useSessions={useSessions} />,
    )
    expect(screen.getByText('累计 1 个')).toBeDefined()
    expect(screen.queryByRole('listitem')).toBeNull()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('closes the menu and its listeners when the list empties while open', () => {
    startClock(1_000_000)
    const running = panelState([record({ startedAt: 1_000_000, lastActivityAt: 1_000_000 })])
    const view = render(
      <OwnSubagentCatalog host={HostTrigger} acp={panelStore(running)} sessionId="chat-1" useSessions={useSessions} />,
    )
    fireEvent.click(screen.getByRole('button'))
    expect(screen.getAllByRole('listitem')).toHaveLength(1)
    expect(vi.getTimerCount()).toBe(1)

    // Page-level Escape listener: the open menu handles Escape in the CAPTURE
    // phase and stops it there, so a listener that outlives the visible menu
    // would keep swallowing the page's key.
    const pageEscapes: string[] = []
    const onPageEscape = (event: KeyboardEvent): void => { if (event.key === 'Escape') pageEscapes.push('page') }
    window.addEventListener('keydown', onPageEscape)
    try {
      const emptySessions = (selector: (value: unknown) => unknown): unknown => selector({
        projectionsBySession: { 'chat-1': { values: { subagentCatalog: [] } } },
      })
      view.rerender(
        <OwnSubagentCatalog host={HostTrigger} acp={panelStore(panelState([]))} sessionId="chat-1" useSessions={emptySessions} />,
      )
      // No rows -> no menu, the open-driven interval is released, and Escape
      // reaches the page again.
      expect(screen.queryByRole('listitem')).toBeNull()
      expect(vi.getTimerCount()).toBe(0)
      fireEvent.keyDown(document.body, { key: 'Escape' })
      expect(pageEscapes).toEqual(['page'])
    } finally {
      window.removeEventListener('keydown', onPageEscape)
    }
  })
})
