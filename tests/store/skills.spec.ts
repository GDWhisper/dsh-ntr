/**
 * The `/` menu's ACP rows (split plan P3b): the slash commands a live ACP
 * session / the agent-level cache declared, and the per-conversation skill rows
 * `agent/skills` answers.
 *
 * Part of the `tests/store.spec.ts` mirror: two cases lifted out of
 * `AcpStore agent management` plus the whole `agentSkills (the / menu skill
 * rows)` describe, moved verbatim (same titles, same case counts).
 */

import { describe, expect, it, vi } from 'vitest'
import { AcpStore, SKILL_MENU_TTL_MS, skillRowsKey } from '../../src/client/store.ts'
import type { AgentSkillEntry } from '../../src/protocol.ts'

describe('AcpStore agent management', () => {
  it('exposes the agent slash commands a chat-list answer carries', async () => {
    const store = new AcpStore(async (_channel, endpoint) => {
      if (endpoint === 'session/chat-list') {
        return {
          ok: true,
          value: {
            sessions: [{
              agentId: 'pi',
              sessionId: 's1',
              availableCommands: [{ name: 'compact', description: 'compress the context' }, { name: 'session' }],
            }],
          },
        }
      }
      return { ok: true, value: {} }
    }, (zh) => zh)

    // No answer for this conversation yet: the caller may ask.
    expect(store.chatSessionCommands('chat-1')).toBeUndefined()
    await store.loadChatSessions('chat-1')
    expect(store.chatSessionCommands('chat-1')).toEqual([
      { name: 'compact', description: 'compress the context' },
      { name: 'session' },
    ])
    // Another conversation is not answered by this one's read.
    expect(store.chatSessionCommands('chat-2')).toBeUndefined()

    // A read that lands with no live ACP session has no LIVE declaration —
    // `undefined`, so the caller falls back to the agent-level cache instead
    // of reading "no session" as "this agent has no commands".
    const idle = new AcpStore(async () => ({ ok: true, value: { sessions: [] } }), (zh) => zh)
    await idle.loadChatSessions('chat-1')
    expect(idle.chatSessionCommands('chat-1')).toBeUndefined()
  })

  it('offers the agent-level command cache before the conversation has a session', async () => {
    const store = new AcpStore(async (_channel, endpoint, payload) => {
      if (endpoint === 'session/chat-list') {
        return { ok: true, value: { sessions: [], acpMode: true, boundAgentId: 'pi' } }
      }
      if (endpoint === 'agent/catalog') {
        expect(payload).toEqual({ agentId: 'pi' })
        return {
          ok: true,
          value: {
            agentId: 'pi',
            title: 'Pi',
            base: { id: 'pi', name: 'Pi' },
            variants: [],
            probed: true,
            commands: [{ name: 'compact', description: 'compress the context' }],
          },
        }
      }
      return { ok: true, value: {} }
    }, (zh) => zh)

    await store.loadChatSessions('chat-1')
    // No live declaration...
    expect(store.chatSessionCommands('chat-1')).toBeUndefined()
    // ...so the menu asks which agent serves the conversation, then that
    // agent's cached catalogue.
    expect(store.chatAgentFor('chat-1')).toBe('pi')
    expect(store.agentCommands('pi')).toBeUndefined()
    await store.loadAgentCatalog('pi')
    expect(store.agentCommands('pi')).toEqual([{ name: 'compact', description: 'compress the context' }])
  })
})

describe('agentSkills (the / menu skill rows)', () => {
  const ROWS_A: AgentSkillEntry[] = [
    { token: 'skill-a', name: 'A', scope: 'project', folder: 'skill-a', insertion: 'use /skill-a [Skill Path](.claude/skills/skill-a)' },
  ]
  const ROWS_B: AgentSkillEntry[] = [
    { token: 'skill-b', name: 'B', scope: 'global', folder: 'skill-b', insertion: 'use /skill-b [Skill Path](/home/u/.claude/skills/skill-b)' },
  ]

  interface SkillHarness {
    store: AcpStore
    calls: Array<{ endpoint: string; payload: unknown }>
    setAnswer(rows: AgentSkillEntry[]): void
  }

  function skillHarness(): SkillHarness {
    const calls: Array<{ endpoint: string; payload: unknown }> = []
    let answer: { skills: AgentSkillEntry[] } = { skills: [] }
    const store = new AcpStore(async (_channel, endpoint, payload) => {
      calls.push({ endpoint, payload })
      if (endpoint === 'agent/skills') return { ok: true, value: answer }
      return { ok: true, value: {} }
    }, (zh) => zh)
    return {
      store,
      calls,
      setAnswer(rows) { answer = { skills: rows } },
    }
  }

  it('joins concurrent reads into one RPC, and reads again once the read settled', async () => {
    let release: ((value: { ok: true; value: { skills: AgentSkillEntry[] } }) => void) | undefined
    const calls: Array<{ endpoint: string }> = []
    const store = new AcpStore(async (_channel, endpoint) => {
      calls.push({ endpoint })
      if (endpoint === 'agent/skills') {
        return new Promise(resolve => { release = resolve })
      }
      return { ok: true, value: {} }
    }, (zh) => zh)
    await store.bindChatAgent('chat-1', 'agent-a')

    const first = store.loadAgentSkills('chat-1')
    const second = store.loadAgentSkills('chat-1')
    expect(second).toBe(first)
    release!({ ok: true, value: { skills: ROWS_A } })
    await first
    expect(store.skillRowsFor('chat-1')).toEqual(ROWS_A)
    expect(calls.filter(row => row.endpoint === 'agent/skills')).toHaveLength(1)

    // Settled reads leave the map, so the next caller past the TTL re-asks.
    expect(store.loadAgentSkills('chat-1')).not.toBe(first)
  })

  it('records "unknown agent" as NOTHING: no state, no RPC, self-heals once a binding lands', async () => {
    const { store, calls, setAnswer } = skillHarness()
    setAnswer(ROWS_A)

    await store.loadAgentSkills('chat-1')
    expect(calls.filter(row => row.endpoint === 'agent/skills')).toEqual([])
    expect(store.skillRowsFor('chat-1')).toBeUndefined()
    expect(store.getSnapshot().agentSkills).toEqual({})

    // The binding appears (the composer's optimistic click): the next menu
    // poll fetches normally.
    await store.bindChatAgent('chat-1', 'agent-a')
    await store.loadAgentSkills('chat-1')
    expect(store.skillRowsFor('chat-1')).toEqual(ROWS_A)
    expect(calls.filter(row => row.endpoint === 'agent/skills')).toEqual([
      { endpoint: 'agent/skills', payload: { dshSessionId: 'chat-1', agentId: 'agent-a' } },
    ])
  })

  it('keeps [] (confirmed empty) apart from undefined (never asked / expired / agent moved)', async () => {
    const { store, calls, setAnswer } = skillHarness()
    await store.bindChatAgent('chat-2', 'agent-a')
    setAnswer([])

    await store.loadAgentSkills('chat-2')
    expect(store.skillRowsFor('chat-2')).toEqual([])
    // Another conversation has no answer at all — never this one's empty.
    expect(store.skillRowsFor('chat-9')).toBeUndefined()
    // And a failing read writes nothing: the rows stay "unknown". The read
    // REJECTS — the slash wrapper is the caller that degrades it to an empty
    // menu.
    const failing = new AcpStore(async (_channel, endpoint) => {
      calls.push({ endpoint, payload: undefined })
      if (endpoint === 'agent/skills') return { ok: false, error: { code: 'unknown_endpoint', message: 'older host' } }
      return { ok: true, value: {} }
    }, (zh) => zh)
    await failing.bindChatAgent('chat-3', 'agent-a')
    await expect(failing.loadAgentSkills('chat-3')).rejects.toThrow('older host')
    expect(failing.skillRowsFor('chat-3')).toBeUndefined()
  })

  it('expires the rows past the TTL and re-asks', async () => {
    vi.useFakeTimers()
    try {
      const { store, setAnswer } = skillHarness()
      await store.bindChatAgent('chat-1', 'agent-a')
      setAnswer(ROWS_A)
      await store.loadAgentSkills('chat-1')
      expect(store.skillRowsFor('chat-1')).toEqual(ROWS_A)

      vi.setSystemTime(Date.now() + SKILL_MENU_TTL_MS + 1)
      expect(store.skillRowsFor('chat-1')).toBeUndefined()
      await store.loadAgentSkills('chat-1')
      expect(store.skillRowsFor('chat-1')).toEqual(ROWS_A)
    } finally {
      vi.useRealTimers()
    }
  })

  it('invalidates by composite key on an agent switch, and never shows the old agent within the TTL', async () => {
    const { store, calls, setAnswer } = skillHarness()
    await store.bindChatAgent('chat-1', 'agent-a')
    setAnswer(ROWS_A)
    await store.loadAgentSkills('chat-1')
    expect(store.skillRowsFor('chat-1')).toEqual(ROWS_A)
    expect(store.skillInsertionFor('chat-1', 'skill-a')).toBe(ROWS_A[0].insertion)

    // The user binds agent B. The old rows become unaddressable IMMEDIATELY —
    // no invalidation hook, no TTL wait.
    await store.bindChatAgent('chat-1', 'agent-b')
    setAnswer(ROWS_B)
    expect(store.skillRowsFor('chat-1')).toBeUndefined()
    expect(store.skillInsertionFor('chat-1', 'skill-a')).toBeUndefined()

    await store.loadAgentSkills('chat-1')
    expect(store.skillRowsFor('chat-1')).toEqual(ROWS_B)
    expect(store.skillInsertionFor('chat-1', 'skill-b')).toBe(ROWS_B[0].insertion)
    // Each read named the agent that was current at read time.
    expect(calls.filter(row => row.endpoint === 'agent/skills').map(row => (row.payload as { agentId: string }).agentId))
      .toEqual(['agent-a', 'agent-b'])
    // And A's rows never came back: both answers sit under different keys.
    expect(Object.keys(store.getSnapshot().agentSkills).sort()).toEqual([
      skillRowsKey('chat-1', 'agent-a'),
      skillRowsKey('chat-1', 'agent-b'),
    ].sort())
  })
})
