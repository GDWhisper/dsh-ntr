// @vitest-environment jsdom
/**
 * The NTR view's read-only subagent strip, rendered: an in-flight row's elapsed
 * clock must advance once per second with no store frame to push it (a silent
 * running worker sends no `subagents/record`), and a terminal row must stay
 * frozen. The interval is gated on "any row still in flight", so a strip of
 * only terminal rows schedules no timer at all.
 *
 * The header panel (`subagent-panel.tsx`) uses the same tick helper and the
 * same gate; its own clock test lives below.
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

    // Terminal: the row freezes at endedAt - startedAt and the interval stops.
    const done = panelState([record({ startedAt: 1_000_000, status: 'completed', endedAt: 1_003_000 })])
    view.rerender(
      <OwnSubagentCatalog host={HostTrigger} acp={panelStore(done)} sessionId="chat-1" useSessions={useSessions} />,
    )
    expect(screen.getByText('3s')).toBeDefined()
    expect(vi.getTimerCount()).toBe(0)
    act(() => { vi.advanceTimersByTime(60_000) })
    expect(screen.getByText('3s')).toBeDefined()
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
})
