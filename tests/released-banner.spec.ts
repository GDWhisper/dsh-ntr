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

import { describe, expect, it } from 'vitest'
import { releasedBannerVisible } from '../src/client/released-banner.tsx'
import type { UiState } from '../src/client/store.ts'
import type { ChatSessionView } from '../src/protocol.ts'

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
