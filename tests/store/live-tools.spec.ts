import { afterEach, describe, expect, it, vi } from 'vitest'
import { AcpStore } from '../../src/client/store.ts'
import { LiveToolCallIndex, MAX_LIVE_TOOL_SESSIONS, MAX_LIVE_TOOLS_PER_SESSION } from '../../src/client/store/live-tools.ts'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('LiveToolCallIndex', () => {
  it('folds updates, parses stringified JSON rawInput, preserves output on empty text, and skips no-op updates', () => {
    const index = new LiveToolCallIndex()
    const owners = new Map([['acp-1', 'dsh-1']])

    expect(index.foldBatch('acp-1', [{
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'c1',
        title: 'Run tests',
        kind: 'execute',
        rawInput: '{"command":"npm test"}',
        content: [{ type: 'text', text: 'line 1' }],
      },
    }])).toBe(true)

    const first = index.get('dsh-1', 'c1', owners)
    expect(first?.rawInput).toEqual({ command: 'npm test' })
    expect(first?.outputText).toBe('line 1')

    // Empty text item and status-only restatement must neither wipe output nor mutate reference.
    expect(index.foldBatch('acp-1', [{
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'c1',
        status: 'in_progress',
        content: [{ type: 'text', text: '' }],
      },
    }])).toBe(false)
    expect(index.get('dsh-1', 'c1', owners)).toBe(first)
    expect(first?.outputText).toBe('line 1')

    // Plain non-JSON string rawInput stays verbatim.
    expect(index.foldBatch('acp-1', [{
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'c2',
        rawInput: 'git status',
      },
    }])).toBe(true)
    expect(index.get('dsh-1', 'c2', owners)?.rawInput).toBe('git status')

    // Detached worker updates (`codebuddy.ai/parentToolCallId`) must not populate or evict chat live tools.
    expect(index.foldBatch('acp-1', [{
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'c1',
        title: 'WORKER OVERWRITE',
        _meta: { 'codebuddy.ai/parentToolCallId': 'dispatch-1' },
      },
    }])).toBe(false)
    expect(index.get('dsh-1', 'c1', owners)?.title).toBe('Run tests')
  })

  it('evicts oldest calls and sessions at bounded LRU caps and isolates across dshSessionId', () => {
    const index = new LiveToolCallIndex()
    const owners = new Map<string, string>()

    for (let i = 0; i <= MAX_LIVE_TOOLS_PER_SESSION; i += 1) {
      index.foldBatch('acp-cap', [{
        update: { sessionUpdate: 'tool_call', toolCallId: `c-${i}`, title: `call-${i}` },
      }])
    }
    owners.set('acp-cap', 'dsh-cap')
    expect(index.get('dsh-cap', 'c-0', owners)).toBeUndefined()
    expect(index.get('dsh-cap', `c-${MAX_LIVE_TOOLS_PER_SESSION}`, owners)?.title).toBe(`call-${MAX_LIVE_TOOLS_PER_SESSION}`)

    for (let s = 0; s <= MAX_LIVE_TOOL_SESSIONS; s += 1) {
      const sid = `acp-s-${s}`
      owners.set(sid, `dsh-s-${s}`)
      index.foldBatch(sid, [{ update: { sessionUpdate: 'tool_call', toolCallId: 'same-id', title: `title-${s}` } }])
    }
    expect(index.get('dsh-s-0', 'same-id', owners)).toBeUndefined()
    expect(index.get(`dsh-s-${MAX_LIVE_TOOL_SESSIONS}`, 'same-id', owners)?.title).toBe(`title-${MAX_LIVE_TOOL_SESSIONS}`)
    expect(index.get('dsh-s-1', 'same-id', owners)?.title).toBe('title-1')
  })
})

describe('AcpStore live tool lifecycle cleanup', () => {
  const feed = (store: AcpStore, event: unknown) =>
    (store as unknown as { applyEvent(e: unknown): Promise<void> }).applyEvent(event)

  it('drops queued pendingUpdates on session/closed, session/released, and session/reset and prunes owners on close', async () => {
    const rafQueue: Array<() => void> = []
    vi.stubGlobal('requestAnimationFrame', (cb: () => void) => {
      rafQueue.push(cb)
      return rafQueue.length
    })
    const store = new AcpStore(async () => ({ ok: true, value: {} }), (_zh, en) => en)

    for (const boundary of ['session/released', 'session/reset', 'session/closed'] as const) {
      await feed(store, { type: 'turn/start', sessionId: 'acp-race', dshSessionId: 'dsh-race', turnId: 't1', text: 'hi' })
      await feed(store, {
        type: 'session/update',
        sessionId: 'acp-race',
        seq: 1,
        update: { sessionUpdate: 'tool_call', toolCallId: 'c-stale', title: 'stale command' },
      })
      // Update stays queued until rAF fires (lifecycle boundary wins the race).
      expect(rafQueue.length).toBeGreaterThan(0)
      if (boundary === 'session/closed') {
        await feed(store, { type: 'session/closed', sessionId: 'acp-race', reason: 'closed' })
      } else if (boundary === 'session/released') {
        await feed(store, {
          type: 'session/released',
          sessionId: 'acp-race',
          reason: 'idle',
          session: { sessionId: 'acp-race', agentId: 'a', acpSessionId: 'x', cwd: '/repo', running: false, closed: false, released: true, seq: 1 },
        })
      } else {
        await feed(store, {
          type: 'session/reset',
          sessionId: 'acp-race',
          session: { sessionId: 'acp-race', agentId: 'a', acpSessionId: 'x', cwd: '/repo', running: false, closed: false, seq: 0 },
        })
      }
      while (rafQueue.length > 0) rafQueue.shift()?.()
      store.flushUpdates()
      expect(store.liveToolCall('dsh-race', 'c-stale')).toBeUndefined()
    }

    const owners = (store as unknown as { acpSessionOwners: Map<string, string> }).acpSessionOwners
    expect(owners.has('acp-race')).toBe(false)
  })

  it('preserves already-flushed live tool data across session/released until session/reset or session/closed', async () => {
    const store = new AcpStore(async () => ({ ok: true, value: {} }), (_zh, en) => en)
    await feed(store, { type: 'turn/start', sessionId: 'acp-rel', dshSessionId: 'dsh-rel', turnId: 't1', text: 'hi' })
    await feed(store, {
      type: 'session/update',
      sessionId: 'acp-rel',
      seq: 1,
      update: { sessionUpdate: 'tool_call', toolCallId: 'c-settled', title: 'git diff', rawInput: { command: 'git diff' } },
    })
    store.flushUpdates()
    expect(store.liveToolCall('dsh-rel', 'c-settled')?.title).toBe('git diff')

    await feed(store, {
      type: 'session/released',
      sessionId: 'acp-rel',
      reason: 'idle',
      session: { sessionId: 'acp-rel', agentId: 'a', acpSessionId: 'x', cwd: '/repo', running: false, closed: false, released: true, seq: 1 },
    })
    expect(store.liveToolCall('dsh-rel', 'c-settled')?.title).toBe('git diff')

    await feed(store, {
      type: 'session/reset',
      sessionId: 'acp-rel',
      session: { sessionId: 'acp-rel', agentId: 'a', acpSessionId: 'x', cwd: '/repo', running: false, closed: false, seq: 0 },
    })
    expect(store.liveToolCall('dsh-rel', 'c-settled')).toBeUndefined()
  })
})
