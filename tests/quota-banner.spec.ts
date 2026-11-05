// @vitest-environment jsdom
/**
 * The rate-limit banner: exactly when the composer dock says "agent 已限流"
 * and repeats the agent's own message — and, just as load-bearing, when it
 * stays out of the way.
 *
 * Two halves, mirroring how the released banner is tested (pure decision, no
 * host) plus a render check (the branch entry's pattern): the gate is a pure
 * function over the store snapshot, and the component must print the agent's
 * text VERBATIM — the reset time inside it is the one fact the user needs, so a
 * paraphrase or a truncation here defeats the whole row.
 *
 * The real failure modes are a banner that outlives the refusal (claiming a
 * limit after the agent answered the next turn), and one that appears in a
 * conversation no NTR agent serves — an ordinary conversation never receives
 * `quotaRefusal`, so both must fail closed.
 */

import { createElement } from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { QuotaBanner, quotaRefusalMessage } from '../src/client/quota-banner.tsx'
import { AcpStore } from '../src/client/store.ts'
import type { UiState } from '../src/client/store.ts'
import type { ChatSessionView, SessionView } from '../src/protocol.ts'

afterEach(cleanup)

type BannerFacts = Pick<UiState, 'acpMode' | 'chatSessions' | 'chatSessionsFor' | 'sessions'>

/** The agent's own text, reset time included — the row must repeat it as-is. */
const REFUSAL = '429 您使用量已超出频率限制，将在 2026-11-05 12:00 重置，您也可以切换其他模型继续使用。'

function row(overrides: Partial<ChatSessionView> = {}): ChatSessionView {
  return { agentId: 'pi', sessionId: 'acp-1', ...overrides }
}

/**
 * One host `SessionView`. `quotaRefusal` arrives with the host half's field
 * (see AGENTS/protocol.md), so the shape is assembled as a plain record and
 * asserted into the view type rather than written as a typed literal.
 */
function session(overrides: Record<string, unknown> = {}): SessionView {
  const base: Record<string, unknown> = {
    sessionId: 'acp-1', agentId: 'pi', acpSessionId: 'acp-1', cwd: '/w',
    running: true, closed: false, seq: 0,
  }
  return { ...base, ...overrides } as unknown as SessionView
}

function facts(overrides: Partial<BannerFacts> = {}): BannerFacts {
  return {
    acpMode: {},
    chatSessions: [],
    chatSessionsFor: undefined,
    sessions: [],
    ...overrides,
  }
}

describe('the rate-limit banner shows exactly the live session refusal of this conversation', () => {
  it('repeats the agent message when this conversation\'s live session carries a refusal', () => {
    expect(quotaRefusalMessage(facts({
      chatSessionsFor: 'chat-1',
      chatSessions: [row()],
      sessions: [session({ quotaRefusal: { message: REFUSAL } })],
    }), 'chat-1')).toBe(REFUSAL)
  })

  it('stays hidden while the session has no refusal', () => {
    expect(quotaRefusalMessage(facts({
      chatSessionsFor: 'chat-1',
      chatSessions: [row()],
      sessions: [session()],
    }), 'chat-1')).toBeUndefined()
    // An older host half that never sends the field is the same state.
    expect(quotaRefusalMessage(facts({
      chatSessionsFor: 'chat-1',
      chatSessions: [row()],
      sessions: [],
    }), 'chat-1')).toBeUndefined()
  })

  it('stays hidden for a chat the rows were not loaded for', () => {
    expect(quotaRefusalMessage(facts({
      chatSessionsFor: 'chat-2',
      chatSessions: [row()],
      sessions: [session({ quotaRefusal: { message: REFUSAL } })],
    }), 'chat-1')).toBeUndefined()
  })

  it('lets an explicit non-ACP verdict outrank a lingering refusal', () => {
    // The conversation's preset left NTR while its session was still live: the
    // row must leave with it (same precedence as the released banner).
    expect(quotaRefusalMessage(facts({
      acpMode: { 'chat-1': false },
      chatSessionsFor: 'chat-1',
      chatSessions: [row()],
      sessions: [session({ quotaRefusal: { message: REFUSAL } })],
    }), 'chat-1')).toBeUndefined()
  })

  it('defers to the rows while the host has not answered the mode question', () => {
    // `undefined` is "not answered yet", not "not ACP": the refusal on this
    // conversation's own live session is proof enough.
    expect(quotaRefusalMessage(facts({
      acpMode: {},
      chatSessionsFor: 'chat-1',
      chatSessions: [row()],
      sessions: [session({ quotaRefusal: { message: REFUSAL } })],
    }), 'chat-1')).toBe(REFUSAL)
    expect(quotaRefusalMessage(facts({
      acpMode: { 'chat-1': true },
      chatSessionsFor: 'chat-1',
      chatSessions: [row()],
      sessions: [session({ quotaRefusal: { message: REFUSAL } })],
    }), 'chat-1')).toBe(REFUSAL)
  })

  it('stays hidden before any agent has run in the conversation', () => {
    expect(quotaRefusalMessage(facts({ chatSessionsFor: 'chat-1', chatSessions: [] }), 'chat-1')).toBeUndefined()
  })

  it('stays hidden when the conversation has no live row', () => {
    // A parked row is the released banner's business: the host clears the
    // refusal at the release boundary, so nothing here is left to report.
    expect(quotaRefusalMessage(facts({
      chatSessionsFor: 'chat-1',
      chatSessions: [row({ released: true })],
      sessions: [session({ released: true })],
    }), 'chat-1')).toBeUndefined()
  })

  it('stays hidden when the matching session itself is parked', () => {
    expect(quotaRefusalMessage(facts({
      chatSessionsFor: 'chat-1',
      chatSessions: [row()],
      sessions: [session({ released: true, quotaRefusal: { message: REFUSAL } })],
    }), 'chat-1')).toBeUndefined()
  })

  it('ignores another conversation\'s refusal', () => {
    // `SessionView` carries no DSH session id; the live chat row is the only
    // bridge, so a refusal on a sibling session must not leak in here.
    expect(quotaRefusalMessage(facts({
      chatSessionsFor: 'chat-1',
      chatSessions: [row()],
      sessions: [session({ sessionId: 'acp-2', quotaRefusal: { message: REFUSAL } })],
    }), 'chat-1')).toBeUndefined()
  })

  it('finds the refusal on the SECOND live row — a concurrent first turn shares the chat id', () => {
    // The host lets two LiveSessions briefly share one chat id (see the
    // `session.turnController` comment in src/bridge.ts). Reading only the first
    // live row would hide a refusal that landed on the second one.
    expect(quotaRefusalMessage(facts({
      chatSessionsFor: 'chat-1',
      chatSessions: [row({ sessionId: 'acp-1' }), row({ sessionId: 'acp-2' })],
      sessions: [
        session({ sessionId: 'acp-1' }),
        session({ sessionId: 'acp-2', quotaRefusal: { message: REFUSAL } }),
      ],
    }), 'chat-1')).toBe(REFUSAL)
  })

  it('skips a live row whose session is closed', () => {
    // The host guarantees a closed snapshot carries no refusal, so this is a
    // defensive gap being closed rather than an observed bug.
    expect(quotaRefusalMessage(facts({
      chatSessionsFor: 'chat-1',
      chatSessions: [row({ sessionId: 'acp-1' })],
      sessions: [session({ sessionId: 'acp-1', closed: true, quotaRefusal: { message: REFUSAL } })],
    }), 'chat-1')).toBeUndefined()
  })

  it('keeps scanning past a parked row to find a live one with the refusal', () => {
    expect(quotaRefusalMessage(facts({
      chatSessionsFor: 'chat-1',
      chatSessions: [row({ sessionId: 'acp-old', released: true }), row({ sessionId: 'acp-1' })],
      sessions: [
        session({ sessionId: 'acp-old', released: true }),
        session({ sessionId: 'acp-1', quotaRefusal: { message: REFUSAL } }),
      ],
    }), 'chat-1')).toBe(REFUSAL)
  })
})

/** A store whose chat rows and session views the frames below have populated. */
function quotaStore(overrides: { refusal?: string; chatSessionsFor?: string } = {}) {
  const rows: ChatSessionView[] = [{ agentId: 'pi', sessionId: 'acp-1' }]
  const store = new AcpStore(async (_channel, endpoint) => {
    if (endpoint === 'session/chat-list') {
      return { ok: true, value: { sessions: rows, acpMode: true } }
    }
    return { ok: true, value: {} }
  }, zh => zh)
  const apply = (event: unknown): Promise<void> =>
    (store as unknown as { applyEvent(event: unknown): Promise<void> }).applyEvent(event)
  const base: Record<string, unknown> = {
    sessionId: 'acp-1', agentId: 'pi', acpSessionId: 'acp-1', cwd: '/w',
    running: false, closed: false, seq: 0,
  }
  return {
    store,
    /** The delivery path the host uses: create, then the refusal's `session/meta`. */
    async seed(): Promise<void> {
      await store.loadChatSessions(overrides.chatSessionsFor ?? 'chat-1')
      await apply({ type: 'session/created', sessionId: 'acp-1', session: base })
      await apply({
        type: 'session/meta',
        sessionId: 'acp-1',
        session: overrides.refusal === undefined
          ? base
          : { ...base, quotaRefusal: { message: overrides.refusal } },
      })
    },
  }
}

describe('QuotaBanner renders the refusal as the agent wrote it', () => {
  it('prints the agent message verbatim, reset time included', async () => {
    const { store, seed } = quotaStore({ refusal: REFUSAL })
    await seed()
    render(createElement(QuotaBanner, { acp: store, sessionId: 'chat-1' }))
    const banner = screen.getByRole('region', { name: 'agent 已限流' })
    expect(banner.textContent).toContain(REFUSAL)
  })

  it('renders nothing when the conversation\'s session carries no refusal', async () => {
    const { store, seed } = quotaStore()
    await seed()
    const { container } = render(createElement(QuotaBanner, { acp: store, sessionId: 'chat-1' }))
    expect(container.innerHTML).toBe('')
    expect(screen.queryByRole('region')).toBeNull()
  })

  it('renders nothing in a conversation the rows belong to another chat', async () => {
    const { store, seed } = quotaStore({ refusal: REFUSAL })
    await seed()
    const { container } = render(createElement(QuotaBanner, { acp: store, sessionId: 'chat-9' }))
    expect(container.innerHTML).toBe('')
  })
})
