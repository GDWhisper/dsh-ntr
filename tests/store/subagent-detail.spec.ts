/**
 * Worker detail indexes (split plan P3b): the on-demand `subagents/detail`
 * history read, the per-worker cap with its omitted marker, the live-frame
 * replay over a slow read, and the 64-index LRU.
 *
 * Part of the `tests/store.spec.ts` mirror: cases lifted verbatim out of
 * `AcpStore subagent lifecycle records (the panel data layer)` (same describe
 * title, same case count for this cluster); the lifecycle-record cases stay in
 * `tests/store.spec.ts`.
 */

import { describe, expect, it } from 'vitest'
import { detailOf, makeStore } from './harness.ts'

describe('AcpStore subagent lifecycle records (the panel data layer)', () => {
  it('reads worker history on the first open only, then folds live frames by both filters', async () => {
    const { store, calls, apply } = makeStore(async (endpoint) => {
      if (endpoint !== 'subagents/detail') return { ok: true, value: {} }
      return {
        ok: true,
        value: {
          entries: [
            { seq: 1, update: { sessionUpdate: 'tool_call', toolCallId: 'call-1' } },
            { seq: 2, update: { sessionUpdate: 'tool_call', toolCallId: 'other-call' } },
          ],
        },
      }
    })
    // The ACP→chat mapping the live fold is scoped by (turn/metrics names both).
    await apply({ type: 'turn/metrics', sessionId: 'acp-s1', dshSessionId: 'chat-1', turnId: 't1', outputTokens: 1, burstMs: 1, final: true })

    await store.loadSubagentDetail('chat-1', 'acp:call-1')
    const detail = detailOf(store, 'acp:call-1')
    expect(detail?.loaded).toBe(true)
    expect(detail?.entries.map(entry => entry.seq)).toEqual([1, 2])
    expect(calls.filter(call => call.endpoint === 'subagents/detail')).toEqual([
      { endpoint: 'subagents/detail', payload: { dshSessionId: 'chat-1', childId: 'acp:call-1' } },
    ])
    // A second open reuses the index: one read per worker per page.
    await store.loadSubagentDetail('chat-1', 'acp:call-1')
    expect(calls.filter(call => call.endpoint === 'subagents/detail')).toHaveLength(1)

    // Live frames: the dispatch's OWN frames (toolCallId) and the worker's
    // frames (parentToolCallId) both count; anything else does not.
    await apply({
      type: 'session/update',
      sessionId: 'acp-s1',
      seq: 10,
      update: { sessionUpdate: 'tool_call_update', toolCallId: 'call-1', status: 'completed' },
    })
    await apply({
      type: 'session/update',
      sessionId: 'acp-s1',
      seq: 11,
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'from the worker' },
        _meta: { 'codebuddy.ai/parentToolCallId': 'call-1' },
      },
    })
    await apply({
      type: 'session/update',
      sessionId: 'acp-s1',
      seq: 12,
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'unrelated' } },
    })
    store.flushUpdates()
    expect(detailOf(store, 'acp:call-1')?.entries.map(entry => entry.seq)).toEqual([1, 2, 10, 11])
  })

  it('caps one worker at 200 entries and counts the dropped front as a marker', async () => {
    const { store, apply } = makeStore()
    await apply({ type: 'turn/metrics', sessionId: 'acp-s1', dshSessionId: 'chat-1', turnId: 't1', outputTokens: 1, burstMs: 1, final: false })
    await store.loadSubagentDetail('chat-1', 'acp:call-1')
    for (let seq = 1; seq <= 205; seq += 1) {
      await apply({
        type: 'session/update',
        sessionId: 'acp-s1',
        seq,
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `chunk ${String(seq)}` }, _meta: { 'codebuddy.ai/parentToolCallId': 'call-1' } },
      })
    }
    store.flushUpdates()
    const detail = detailOf(store, 'acp:call-1')
    expect(detail?.entries).toHaveLength(200)
    expect(detail?.entries[0]?.seq).toBe(6)
    expect(detail?.entries.at(-1)?.seq).toBe(205)
    // The index does not start at the worker's first frame — the panel says so.
    expect(detail?.omitted).toBe(5)
  })

  it('replays live frames over a slow detail read without duplicating what the host already saw', async () => {
    let releaseDetail!: () => void
    const gate = new Promise<void>(resolve => { releaseDetail = resolve })
    const dispatchFrame = { sessionUpdate: 'tool_call', toolCallId: 'call-1', status: 'in_progress' }
    const { store, apply } = makeStore(async (endpoint) => {
      if (endpoint !== 'subagents/detail') return { ok: true, value: {} }
      await gate
      // The host read saw seq 1 but not seq 2.
      return { ok: true, value: { entries: [{ seq: 1, update: dispatchFrame }] } }
    })
    await apply({ type: 'turn/metrics', sessionId: 'acp-s1', dshSessionId: 'chat-1', turnId: 't1', outputTokens: 1, burstMs: 1, final: true })

    const loading = store.loadSubagentDetail('chat-1', 'acp:call-1')
    // The same frame the host will return (must not be shown twice) and a
    // worker frame the host's answer predates (must survive it).
    await apply({ type: 'session/update', sessionId: 'acp-s1', seq: 1, update: dispatchFrame })
    await apply({
      type: 'session/update',
      sessionId: 'acp-s1',
      seq: 2,
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'late' }, _meta: { 'codebuddy.ai/parentToolCallId': 'call-1' } },
    })
    store.flushUpdates()
    releaseDetail()
    await loading
    expect(detailOf(store, 'acp:call-1')?.entries.map(entry => entry.seq)).toEqual([1, 2])
  })

  it('keeps at most 64 worker detail indexes, evicting the least recently opened', async () => {
    const { store } = makeStore()
    for (let index = 0; index < 65; index += 1) {
      await store.loadSubagentDetail('chat-1', `acp:call-${String(index)}`)
    }
    const details = store.getSnapshot().subagentDetails
    expect(Object.keys(details)).toHaveLength(64)
    expect(detailOf(store, 'acp:call-0')).toBeUndefined()
    expect(detailOf(store, 'acp:call-64')).toBeDefined()
  })
})
