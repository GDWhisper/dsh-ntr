/**
 * The conversation's ACP session wiring (split plan P3b): the `session/chat-list`
 * read and its frame replay, the observed ACP transcripts, the branch click and
 * the subagent lifecycle records those reads replay. Moved verbatim out of
 * `tests/store.spec.ts`, which still drives the same facade — the service is
 * reached through `AcpStore`.
 */

import { describe, expect, it, vi } from 'vitest'
import { AcpStore, replayChatRowFrames, subagentKey } from '../../src/client/store.ts'
import { resolveHostFork } from '../../src/client/branch-action.tsx'
import { releasedBannerVisible } from '../../src/client/released-banner.tsx'
import type { ChatSessionView, SubagentRecord } from '../../src/protocol.ts'
import { makeStore } from './harness.ts'

describe('AcpStore subagent lifecycle records (the panel data layer)', () => {
  function record(overrides: Partial<SubagentRecord> = {}): SubagentRecord {
    return {
      childId: 'acp:call-1',
      dshSessionId: 'chat-1',
      toolCallId: 'call-1',
      label: 'general-purpose · audit',
      status: 'pending',
      startedAt: 1_000,
      lastActivityAt: 1_000,
      counts: { updates: 1, toolCalls: 0, textChars: 0 },
      ...overrides,
    }
  }

  // The components read the keyed snapshot maps directly; the tests do too.
  const recordOf = (store: AcpStore, childId: string, dshSessionId = 'chat-1'): SubagentRecord | undefined =>
    store.getSnapshot().subagents[subagentKey(dshSessionId, childId)]
  const recordsOf = (store: AcpStore, dshSessionId: string): SubagentRecord[] =>
    Object.values(store.getSnapshot().subagents).filter(row => row.dshSessionId === dshSessionId)

  it('folds creation and every transition, keyed by conversation + child id', async () => {
    const { store, apply } = makeStore()
    await apply({ type: 'subagents/record', dshSessionId: 'chat-1', record: record() })
    expect(recordOf(store, 'acp:call-1')?.status).toBe('pending')
    // The same child id in another conversation is a different record.
    await apply({ type: 'subagents/record', dshSessionId: 'chat-2', record: record({ dshSessionId: 'chat-2', status: 'running' }) })

    await apply({
      type: 'subagents/record',
      dshSessionId: 'chat-1',
      record: record({ status: 'failed', endedAt: 2_000, error: 'boom' }),
    })
    expect(recordOf(store, 'acp:call-1')?.status).toBe('failed')
    expect(recordOf(store, 'acp:call-1')?.error).toBe('boom')
    expect(recordOf(store, 'acp:call-1', 'chat-2')?.status).toBe('running')

    // A stale in-flight frame must not revive a terminal row.
    await apply({ type: 'subagents/record', dshSessionId: 'chat-1', record: record({ status: 'running' }) })
    expect(recordOf(store, 'acp:call-1')?.status).toBe('failed')
    expect(recordsOf(store, 'chat-1')).toHaveLength(1)
  })

  it('seeds records from session/chat-list, de-duplicates across rows, and replays in-flight frames', async () => {
    // The answer describes the host as of the REQUEST; the terminal frame
    // below lands while the read is in flight and must win.
    let releaseList!: () => void
    const gate = new Promise<void>(resolve => { releaseList = resolve })
    const { store, apply } = makeStore(async (endpoint) => {
      if (endpoint !== 'session/chat-list') return { ok: true, value: {} }
      await gate
      return {
        ok: true,
        value: {
          sessions: [
            {
              agentId: 'codebuddy',
              sessionId: 'acp-s1',
              subagents: [record({ status: 'running', dshSessionId: 'chat-1' })],
            },
            {
              agentId: 'codebuddy',
              sessionId: 'acp-s2',
              subagents: [record({ status: 'running', dshSessionId: 'chat-1' })],
            },
          ],
          acpMode: true,
        },
      }
    })

    const load = store.loadChatSessions('chat-1')
    await apply({
      type: 'subagents/record',
      dshSessionId: 'chat-1',
      record: record({ status: 'completed', endedAt: 3_000, dshSessionId: 'chat-1' }),
    })
    releaseList()
    await load

    // Two rows carried the same record; the keyed map holds one.
    const rows = Object.keys(store.getSnapshot().subagents)
    expect(rows).toHaveLength(1)
    expect(recordOf(store, 'acp:call-1')?.status).toBe('completed')
    expect(recordsOf(store, 'chat-1')).toHaveLength(1)
  })

})

describe('AcpStore observed ACP transcripts (the ACP view tab)', () => {
  function view(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
    return {
      sessionId: 'acp-s1',
      agentId: 'pi',
      acpSessionId: 'acp-1',
      cwd: '/w',
      running: false,
      closed: false,
      seq: 0,
      ...overrides,
    }
  }

  /** Views keyed by chat session: only `chat-1` has an ACP session behind it. */
  const viewsByChat: Record<string, unknown[]> = {
    'chat-1': [{
      session: view(),
      entries: [
        { seq: 1, update: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'hi' } } },
        { seq: 2, update: { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'read a.ts', kind: 'read', status: 'completed', content: [{ type: 'diff', path: 'a.ts', oldText: 'x\n', newText: 'y\n' }] } },
      ],
    }],
  }

  function makeStore(overrides: Record<string, unknown[]> = viewsByChat): { store: AcpStore; apply: (event: unknown) => Promise<void> } {
    const store = new AcpStore(async (_channel, endpoint, payload) => {
      if (endpoint === 'session/chat-transcript') {
        const id = String((payload as { dshSessionId?: unknown }).dshSessionId)
        return { ok: true, value: { views: overrides[id] ?? [] } }
      }
      return { ok: true, value: {} }
    }, (zh) => zh)
    const apply = (event: unknown): Promise<void> =>
      (store as unknown as { applyEvent(event: unknown): Promise<void> }).applyEvent(event)
    return { store, apply }
  }

  it('observes a chat session\'s ACP transcripts by chat id and keeps its structured diffs', async () => {
    const { store } = makeStore()
    await store.loadChatTranscript('chat-1')

    const record = store.chatTranscriptOf('chat-1')
    expect(record?.blocks.map(block => block.kind)).toEqual(['user', 'tool'])
    expect(record?.seq).toBe(2)
    expect(record?.blocks[1]).toMatchObject({
      kind: 'tool',
      diffs: [{ path: 'a.ts', oldText: 'x\n', newText: 'y\n' }],
    })

    // A different chat session is its own address and must not inherit anything.
    expect(store.chatTranscriptOf('chat-2')).toBeUndefined()
    await store.loadChatTranscript('chat-2')
    expect(store.chatTranscriptOf('chat-1')?.blocks).toHaveLength(2)
    expect(store.chatTranscriptOf('chat-2')).toBeUndefined()
  })

  it('folds live frames into an observed transcript that the panel never selected', async () => {
    const { store, apply } = makeStore()
    await store.loadChatTranscript('chat-1')

    // The native chat's ACP session is NOT the panel's active session — that
    // asymmetry is the whole reason this buffer exists.
    expect(store.getSnapshot().activeSessionId).toBeUndefined()
    await apply({
      type: 'session/update',
      sessionId: 'acp-s1',
      seq: 3,
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'done' } },
    })
    expect(store.chatTranscriptOf('chat-1')?.blocks.at(-1)).toMatchObject({ kind: 'agent', text: 'done' })
    expect(store.chatTranscriptOf('chat-1')?.seq).toBe(3)
    // …and the panel's own block list stayed untouched by it.
    expect(store.getSnapshot().blocks).toEqual([])

    // A session nobody is observing is not buffered at all.
    await apply({
      type: 'session/update',
      sessionId: 'acp-other',
      seq: 1,
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'x' } },
    })
    expect(store.getSnapshot().chatTranscripts['acp-other']).toBeUndefined()
  })

  it('clears an observed transcript on session/reset and drops it on session/closed', async () => {
    const { store, apply } = makeStore()
    await store.loadChatTranscript('chat-1')
    await apply({ type: 'session/reset', sessionId: 'acp-s1', session: view() })
    expect(store.chatTranscriptOf('chat-1')?.blocks).toEqual([])
    expect(store.chatTranscriptOf('chat-1')?.seq).toBe(0)

    await apply({ type: 'session/closed', sessionId: 'acp-s1', reason: 'closed' })
    expect(store.chatTranscriptOf('chat-1')).toBeUndefined()
  })

  it('mirrors released and running onto an observed transcript', async () => {
    const { store, apply } = makeStore()
    await store.loadChatTranscript('chat-1')
    await apply({ type: 'session/released', sessionId: 'acp-s1', session: view({ released: true }), reason: 'agent died' })
    expect(store.chatTranscriptOf('chat-1')?.session).toMatchObject({ released: true })
    expect(store.chatTranscriptOf('chat-1')?.blocks).toHaveLength(2)

    await apply({ type: 'turn/start', sessionId: 'acp-s1', turnId: 't9', text: 'again' })
    expect(store.chatTranscriptOf('chat-1')?.session.running).toBe(true)
    await apply({ type: 'turn/end', sessionId: 'acp-s1', turnId: 't9', stopReason: 'end_turn' })
    expect(store.chatTranscriptOf('chat-1')?.session.running).toBe(false)
  })

  it('flips the composer session view to released on session/released', async () => {
    // The agent tag's live halo reads this list; without the flip it keeps
    // breathing for a process that is gone until the next turn re-reads.
    let listed = { sessions: [{ agentId: 'pi', sessionId: 'acp-s1' }] }
    const store = new AcpStore(async (_channel, endpoint) => {
      if (endpoint === 'session/chat-list') return { ok: true, value: listed }
      return { ok: true, value: {} }
    }, (zh) => zh)
    const apply = (event: unknown): Promise<void> =>
      (store as unknown as { applyEvent(event: unknown): Promise<void> }).applyEvent(event)

    await store.loadChatSessions('chat-1')
    expect(store.getSnapshot().chatSessions[0]).toMatchObject({ sessionId: 'acp-s1' })
    expect(store.getSnapshot().chatSessions[0]?.released).toBeUndefined()

    await apply({ type: 'session/released', sessionId: 'acp-s1', session: view({ released: true }), reason: 'idle release', cause: 'idle' })
    expect(store.getSnapshot().chatSessions[0]).toMatchObject({ sessionId: 'acp-s1', released: true })
    // An idle release is expected lifecycle: no runtime-log line, no notice.
    expect(store.getSnapshot().logs).toHaveLength(0)
    expect(store.getSnapshot().notice).toBeUndefined()

    // Resuming on a fresh process flips the row back live on `session/reset` —
    // the same stream the banner and the halo read, with no re-read in
    // between (a resume must not leave the banner claiming a parked process).
    await apply({ type: 'session/reset', sessionId: 'acp-s1', session: view() })
    expect(store.getSnapshot().chatSessions[0]?.released).toBe(false)
  })

  it('bounds how many transcripts stay resident', async () => {
    const wide: Record<string, unknown[]> = {}
    for (let i = 0; i < 9; i++) {
      wide[`chat-${String(i)}`] = [{ session: view({ sessionId: `acp-${String(i)}`, agentId: 'pi' }), entries: [] }]
    }
    const { store } = makeStore(wide)
    for (let i = 0; i < 9; i++) await store.loadChatTranscript(`chat-${String(i)}`)
    const ids = Object.keys(store.getSnapshot().chatTranscripts)
    expect(ids).toHaveLength(6)
    // The newest window survives; the oldest is the one evicted.
    expect(ids).toContain('acp-8')
    expect(ids).not.toContain('acp-0')
  })
})

/**
 * The branch click (the message-actions plan §D5): the HOST forks the DSH tree
 * first (the injected `forkHost` face), then the plugin adopts the ACP side via
 * `session/chat-fork-adopt`. A failure at either stage is flashed to the notice
 * banner (a user-action failure) AND returned as `{ failure }` — the line the
 * conversation renders beside the button; nothing opens.
 */
describe('forkChatSession (the NTR branch click)', () => {
  it('reports a host-fork failure to the notice and never sends the adopt', async () => {
    const calls: Array<{ endpoint: string; payload: unknown }> = []
    const store = new AcpStore(async (_channel, endpoint, payload) => {
      calls.push({ endpoint, payload })
      return { ok: true, value: {} }
    }, (zh) => zh)

    const outcome = await store.forkChatSession('chat-1', async () => {
      throw new Error('host fork exploded')
    })
    expect(outcome).toEqual({ failure: 'host fork exploded' })
    expect(store.getSnapshot().notice).toContain('host fork exploded')
    // Host first is structural: with no child there is nothing to adopt.
    expect(calls).toEqual([])
  })

  it('refuses a host answer that is not a session id', async () => {
    const calls: Array<{ endpoint: string; payload: unknown }> = []
    const store = new AcpStore(async (_channel, endpoint, payload) => {
      calls.push({ endpoint, payload })
      return { ok: true, value: {} }
    }, (zh) => zh)

    expect(await store.forkChatSession('chat-1', async () => 42)).toEqual({ failure: '宿主没有返回分支会话，分支未完成。' })
    expect(store.getSnapshot().notice).toContain('宿主没有返回分支会话')
    expect(calls).toEqual([])
  })

  it('reports a failed adopt with the actionable line and leaves the child unbound', async () => {
    const calls: Array<{ endpoint: string; payload: unknown }> = []
    const store = new AcpStore(async (_channel, endpoint, payload) => {
      calls.push({ endpoint, payload })
      if (endpoint === 'session/chat-fork-adopt') {
        return { ok: false, error: { code: 'parent_not_live', message: 'acp: the conversation to branch has no live ACP session' } }
      }
      return { ok: true, value: {} }
    }, (zh) => zh)

    const outcome = await store.forkChatSession('chat-1', async () => 'child-1')
    // The child EXISTS but nothing is attached to it: the failure line must say
    // what happens next (its first message starts a fresh session), not just
    // name the error.
    expect(outcome).toEqual({
      failure: '分支会话已创建，但没有接上 agent 的上下文（acp: the conversation to branch has no live ACP session）；在子会话里发送的第一条消息会开启全新会话。',
    })
    expect(store.getSnapshot().notice).toContain('分支会话已创建，但没有接上 agent 的上下文')
    expect(calls).toEqual([
      { endpoint: 'session/chat-fork-adopt', payload: { dshSessionId: 'child-1', parentDshSessionId: 'chat-1' } },
    ])
  })

  it('adopts: sends the child the host returned and resolves it', async () => {
    const calls: Array<{ endpoint: string; payload: unknown }> = []
    const store = new AcpStore(async (_channel, endpoint, payload) => {
      calls.push({ endpoint, payload })
      if (endpoint === 'session/chat-fork-adopt') return { ok: true, value: { done: true } }
      return { ok: true, value: {} }
    }, (zh) => zh)

    const outcome = await store.forkChatSession('chat-1', async sessionId => `${sessionId}-copy`)
    expect(outcome).toEqual({ childId: 'chat-1-copy' })
    expect(calls).toEqual([
      { endpoint: 'session/chat-fork-adopt', payload: { dshSessionId: 'chat-1-copy', parentDshSessionId: 'chat-1' } },
    ])
    expect(store.getSnapshot().notice).toBeUndefined()
  })

  it('preserves sessions instance context when called with resolveHostFork', async () => {
    class HostSessionsService {
      list = {
        getSnapshot() {
          return [{ id: 'parent-1' }]
        },
      }

      async fork(options: { sessionId: string; increaseTitle?: boolean }) {
        // Reproduces the exact host implementation pattern that failed with:
        // Cannot read properties of undefined (reading 'getSnapshot')
        const list = this.list.getSnapshot()
        if (!list || list.length === 0) throw new Error('empty session list')
        return `${options.sessionId}-child`
      }
    }

    const hostService = new HostSessionsService()
    const hostFace = resolveHostFork(hostService)
    expect(hostFace).toBeDefined()

    const calls: Array<{ endpoint: string; payload: unknown }> = []
    const store = new AcpStore(async (_channel, endpoint, payload) => {
      calls.push({ endpoint, payload })
      if (endpoint === 'session/chat-fork-adopt') return { ok: true, value: { done: true } }
      return { ok: true, value: {} }
    }, (zh) => zh)

    const outcome = await store.forkChatSession('chat-1', sessionId => {
      return hostFace!.fork({ sessionId, increaseTitle: true })
    })

    expect(outcome).toEqual({ childId: 'chat-1-child' })
    expect(calls).toEqual([
      { endpoint: 'session/chat-fork-adopt', payload: { dshSessionId: 'chat-1-child', parentDshSessionId: 'chat-1' } },
    ])
    expect(store.getSnapshot().notice).toBeUndefined()
  })
})


/**
 * The released banner reads a CACHED row list. A `session/chat-list` read that
 * started before a resume / release / close must not overwrite the frame that
 * landed while it was in flight, and a turn start must ask the host again.
 */
describe('AcpStore chat-row freshness (the released banner follows the host)', () => {
  type Answer = { ok: true; value: unknown }

  function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
    let resolve: (value: T) => void = () => {}
    const promise = new Promise<T>(done => { resolve = done })
    return { promise, resolve }
  }

  function row(released?: boolean): ChatSessionView {
    return { agentId: 'pi', sessionId: 's1', ...(released === true ? { released: true } : {}) }
  }

  function view(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      sessionId: 's1', agentId: 'pi', acpSessionId: 'acp-1', cwd: '/w',
      running: false, closed: false, seq: 0, ...overrides,
    }
  }

  function apply(store: AcpStore, event: unknown): Promise<void> {
    return (store as unknown as { applyEvent(event: unknown): Promise<void> }).applyEvent(event)
  }

  /** Answers by read order; the last one repeats if a test reads more. */
  function makeStore(
    answers: Array<Answer | Promise<Answer>>,
  ): { store: AcpStore; reads: () => number } {
    let reads = 0
    const store = new AcpStore(async (_channel, endpoint) => {
      if (endpoint !== 'session/chat-list') return { ok: true, value: { done: true } }
      const answer = answers[Math.min(reads, answers.length - 1)]
      reads += 1
      return answer
    }, zh => zh)
    return { store, reads: () => reads }
  }

  function answered(rows: ChatSessionView[]): Answer {
    return { ok: true, value: { sessions: rows } }
  }

  it('replays a resume frame over a chat-list answer that started before the resume', async () => {
    const held = deferred<Answer>()
    const { store } = makeStore([held.promise])
    const pending = store.loadChatSessions('chat-1')

    await apply(store, { type: 'session/reset', sessionId: 's1', session: view() })
    held.resolve({ ok: true, value: { sessions: [row(true)] } })
    await pending

    expect(store.getSnapshot().chatSessions[0]?.released).not.toBe(true)
    expect(releasedBannerVisible(store.getSnapshot(), 'chat-1')).toBe(false)
  })

  it('replays a release frame over a live chat-list answer', async () => {
    const held = deferred<Answer>()
    const { store } = makeStore([held.promise])
    const pending = store.loadChatSessions('chat-1')

    await apply(store, {
      type: 'session/released', sessionId: 's1', session: view({ released: true }), reason: 'agent process exited',
    })
    held.resolve({ ok: true, value: { sessions: [row()] } })
    await pending

    expect(store.getSnapshot().chatSessions[0]?.released).toBe(true)
    expect(releasedBannerVisible(store.getSnapshot(), 'chat-1')).toBe(true)
  })

  it('replays a close frame so a late answer cannot resurrect a closed row', async () => {
    const held = deferred<Answer>()
    const { store } = makeStore([held.promise])
    const pending = store.loadChatSessions('chat-1')

    await apply(store, { type: 'session/closed', sessionId: 's1', reason: 'closed' })
    held.resolve({ ok: true, value: { sessions: [row(true)] } })
    await pending

    expect(store.getSnapshot().chatSessions).toEqual([])
    expect(releasedBannerVisible(store.getSnapshot(), 'chat-1')).toBe(false)
  })

  it('re-reads the row list on every turn start and drops the stale in-flight read', async () => {
    const held = deferred<Answer>()
    // Read #1 seeds `chatSessionsFor` (the banner cannot show without it).
    // Read #2 hangs so the turn start has a stale read to drop. Read #3 is
    // the forced read and carries the host's live row.
    const { store, reads } = makeStore([answered([row(true)]), held.promise, answered([row()])])
    await store.loadChatSessions('chat-1')
    expect(releasedBannerVisible(store.getSnapshot(), 'chat-1')).toBe(true)
    const stale = store.loadChatSessions('chat-1')

    await apply(store, { type: 'turn/start', sessionId: 's1', turnId: 't1', text: 'hi' })
    held.resolve(answered([row(true)]))
    await stale
    await vi.waitFor(() => expect(store.getSnapshot().chatSessions[0]?.released).not.toBe(true))

    expect(reads()).toBe(3)
    expect(releasedBannerVisible(store.getSnapshot(), 'chat-1')).toBe(false)
  })

  it('forces a fresh answer after the explicit resume button', async () => {
    const held = deferred<Answer>()
    const { store, reads } = makeStore([answered([row(true)]), held.promise, answered([row()])])
    await store.loadChatSessions('chat-1')
    expect(releasedBannerVisible(store.getSnapshot(), 'chat-1')).toBe(true)
    const stale = store.loadChatSessions('chat-1')

    // The host's "already live" branch broadcasts no frame at all: only a
    // forced read can clear a row the browser still holds as released.
    await store.resumeChatSession('chat-1')
    held.resolve(answered([row(true)]))
    await stale

    expect(reads()).toBe(3)
    expect(store.getSnapshot().chatSessions[0]?.released).not.toBe(true)
    expect(releasedBannerVisible(store.getSnapshot(), 'chat-1')).toBe(false)
  })

  it('replays only later frames and only rows the answer already carries', () => {
    const rows = [row(true)]
    // A frame the read had already seen is not applied twice.
    expect(replayChatRowFrames(rows, [{ seq: 1, sessionId: 's1', kind: 'reset' }], 1)).toEqual(rows)
    // Another conversation's session must never enter this conversation's list.
    expect(replayChatRowFrames(rows, [{ seq: 1, sessionId: 'other', kind: 'reset' }], 0)).toEqual(rows)
    // Later frames apply in arrival order, so the last state wins.
    expect(replayChatRowFrames(rows, [
      { seq: 1, sessionId: 's1', kind: 'released' },
      { seq: 2, sessionId: 's1', kind: 'reset' },
    ], 0)).toEqual([{ agentId: 'pi', sessionId: 's1', released: false }])
  })
})
