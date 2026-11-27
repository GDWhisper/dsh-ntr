// @vitest-environment jsdom
/**
 * The released-session banner's visibility gate: exactly when the composer
 * dock says "进程已释放" and offers the resume button — and, just as
 * load-bearing, when it stays out of the way.
 *
 * Pure decision, no DOM (the seam tests/session-controls.spec.ts uses for the
 * composer's other word/behavior rules): the two real failure modes here are
 * a banner that keeps claiming a parked process after it came back, and one
 * that shows up in a conversation no NTR agent serves.
 */

import { createElement } from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ReleasedBanner,
  formatReleaseTime,
  latestReleaseOf,
  releaseCausePresentation,
  releasedBannerVisible,
} from '../src/client/released-banner.tsx'
import type { AcpStore, UiState } from '../src/client/store.ts'
import type { AcpReleaseCause, ChatSessionView } from '../src/protocol.ts'

afterEach(cleanup)

type BannerFacts = Pick<UiState, 'acpMode' | 'chatSessions' | 'chatSessionsFor'>

function row(overrides: Partial<ChatSessionView> = {}): ChatSessionView {
  return { agentId: 'pi', sessionId: 'acp-1', ...overrides }
}

function facts(overrides: Partial<BannerFacts> = {}): BannerFacts {
  return {
    acpMode: {},
    chatSessions: [],
    chatSessionsFor: undefined,
    ...overrides,
  }
}

describe('the released banner shows exactly when nothing live is left to serve the chat', () => {
  it('shows when every ACP session row of this conversation is released', () => {
    expect(releasedBannerVisible(facts({
      chatSessionsFor: 'chat-1',
      chatSessions: [row({ released: true })],
    }), 'chat-1')).toBe(true)
    // Two parked sessions (agent-switch history) read the same way.
    expect(releasedBannerVisible(facts({
      chatSessionsFor: 'chat-1',
      chatSessions: [row({ released: true }), row({ sessionId: 'acp-2', agentId: 'other', released: true })],
    }), 'chat-1')).toBe(true)
  })

  it('stays hidden while any row is live — that process serves the next message', () => {
    expect(releasedBannerVisible(facts({
      chatSessionsFor: 'chat-1',
      chatSessions: [row({ released: true }), row({ sessionId: 'acp-2', agentId: 'other' })],
    }), 'chat-1')).toBe(false)
  })

  it('stays hidden before any agent has run in the conversation', () => {
    expect(releasedBannerVisible(facts({ chatSessionsFor: 'chat-1', chatSessions: [] }), 'chat-1')).toBe(false)
  })

  it('stays hidden for a chat the rows were not loaded for', () => {
    expect(releasedBannerVisible(facts({
      chatSessionsFor: 'chat-2',
      chatSessions: [row({ released: true })],
    }), 'chat-1')).toBe(false)
  })

  it('lets an explicit non-ACP verdict outrank a lingering released row', () => {
    // The conversation's preset left NTR while its ACP session was parked:
    // the banner must leave with it (same precedence as the agent tag).
    expect(releasedBannerVisible(facts({
      acpMode: { 'chat-1': false },
      chatSessionsFor: 'chat-1',
      chatSessions: [row({ released: true })],
    }), 'chat-1')).toBe(false)
  })

  it('defers to the rows while the host has not answered the mode question', () => {
    // `undefined` is "not answered yet", not "not ACP": the parked session is
    // proof enough to show the banner.
    expect(releasedBannerVisible(facts({
      acpMode: {},
      chatSessionsFor: 'chat-1',
      chatSessions: [row({ released: true })],
    }), 'chat-1')).toBe(true)
    expect(releasedBannerVisible(facts({
      acpMode: { 'chat-1': true },
      chatSessionsFor: 'chat-1',
      chatSessions: [row({ released: true })],
    }), 'chat-1')).toBe(true)
  })
})

describe('released banner observability (cause, reason, timestamp)', () => {
  const zhLabel = (zh: string): string => zh
  const enLabel = (_zh: string, en: string): string => en

  it('maps every release cause to a distinct badge and tone', () => {
    const causes: AcpReleaseCause[] = ['shutdown', 'idle', 'died', 'archived', 'workspace', 'stalled', 'resume-failed']
    const zhLabels = causes.map(cause => releaseCausePresentation(cause, zhLabel).label)
    const enLabels = causes.map(cause => releaseCausePresentation(cause, enLabel).label)
    expect(new Set(zhLabels).size).toBe(causes.length)
    expect(new Set(enLabels).size).toBe(causes.length)
    expect(releaseCausePresentation('shutdown', zhLabel)).toEqual({ label: '热重载 / 宿主关闭', tone: 'warn' })
    expect(releaseCausePresentation('idle', zhLabel)).toEqual({ label: '空闲释放', tone: 'idle' })
    expect(releaseCausePresentation('died', zhLabel)).toEqual({ label: '进程崩溃', tone: 'fail' })
    expect(releaseCausePresentation('archived', zhLabel)).toEqual({ label: '会话归档', tone: 'idle' })
    expect(releaseCausePresentation('future-cause' as AcpReleaseCause, zhLabel)).toEqual({ label: 'future-cause', tone: 'idle' })
  })

  it('picks the latest released row and preserves cause, reason, and timestamp', () => {
    expect(latestReleaseOf([row({ released: true })])).toBeUndefined()
    expect(latestReleaseOf([row({ released: true, releaseReason: '   ' })])).toBeUndefined()
    expect(latestReleaseOf([
      row({ sessionId: 'acp-1', released: true, releaseCause: 'idle', releaseReason: 'idle 30m' }),
      row({ sessionId: 'acp-2', released: true }),
    ])).toEqual({ cause: 'idle', reason: 'idle 30m' })
    expect(latestReleaseOf([
      row({ sessionId: 'acp-1', released: true, releaseCause: 'idle', releaseReason: 'idle 30m', releasedAt: 1_000 }),
      row({ sessionId: 'acp-2', released: true, releaseCause: 'died', releaseReason: 'exit 1', releasedAt: 2_000 }),
    ])).toEqual({
      cause: 'died',
      reason: 'exit 1',
      releasedAt: 2_000,
    })
  })

  it('formats same-day timestamps as HH:MM:SS and earlier days with MM-DD', () => {
    const sameDayNow = new Date(2026, 10, 27, 15, 0, 0).getTime()
    const sameDayAt = new Date(2026, 10, 27, 9, 5, 7).getTime()
    const prevDayAt = new Date(2026, 10, 26, 23, 4, 5).getTime()
    expect(formatReleaseTime(sameDayAt, sameDayNow)).toEqual({
      short: '09:05:07',
      full: '2026-11-27 09:05:07',
    })
    expect(formatReleaseTime(prevDayAt, sameDayNow)).toEqual({
      short: '11-26 23:04:05',
      full: '2026-11-26 23:04:05',
    })
    expect(formatReleaseTime(0, sameDayNow)).toBeUndefined()
  })

  it('renders release cause badge, timestamp, and reason inside ReleasedBanner', () => {
    const releasedAt = new Date(2026, 10, 27, 9, 44, 57).getTime()
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 10, 27, 10, 0, 0))
    try {
      const snapshot = {
        acpMode: { 'chat-1': true },
        chatSessionsFor: 'chat-1',
        chatSessions: [
          row({
            released: true,
            releaseCause: 'shutdown',
            releaseReason: 'the host is shutting down',
            releasedAt,
          }),
        ],
      } as unknown as UiState
      const fakeStore = {
        subscribe: () => () => {},
        getSnapshot: () => snapshot,
        loadChatSessions: () => Promise.resolve(),
        resumeChatSession: () => Promise.resolve(),
        label: zhLabel,
      } as unknown as AcpStore

      render(createElement(ReleasedBanner, { acp: fakeStore, sessionId: 'chat-1' }))
      expect(screen.getByText('进程已释放')).toBeTruthy()
      expect(screen.getByText('热重载 / 宿主关闭')).toBeTruthy()
      expect(screen.getByText('09:44:57')).toBeTruthy()
      expect(screen.getByText('the host is shutting down')).toBeTruthy()
    } finally {
      vi.useRealTimers()
    }
  })

  it('renders cleanly when cause is absent (older host) and surfaces resume failures', async () => {
    const snapshot = {
      acpMode: { 'chat-1': true },
      chatSessionsFor: 'chat-1',
      chatSessions: [row({ released: true, releaseReason: 'legacy exit' })],
    } as unknown as UiState
    const fakeStore = {
      subscribe: () => () => {},
      getSnapshot: () => snapshot,
      loadChatSessions: () => Promise.resolve(),
      resumeChatSession: () => Promise.reject(new Error('load failed')),
      label: zhLabel,
    } as unknown as AcpStore

    render(createElement(ReleasedBanner, { acp: fakeStore, sessionId: 'chat-1' }))
    expect(screen.getByText('进程已释放')).toBeTruthy()
    expect(screen.getByText('legacy exit')).toBeTruthy()
    screen.getByRole('button', { name: '恢复进程' }).click()
    expect((await screen.findByRole('alert')).textContent).toContain('load failed')
  })
})
