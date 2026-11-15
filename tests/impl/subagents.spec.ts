/**
 * External subagent records: normalization and the cap, plus the `subagents/detail` payload validation.
 *
 * Part of the `tests/impl.spec.ts` mirror: one file per `src/impl/` cluster,
 * same describe titles and case counts as before the split.
 */

import { describe, expect, it } from 'vitest'
import {
  dispatchRpc,
  ACP_TOOL_RAW_MAX,
  boundSubagentDetailEntry,
  capSubagentRecords,
  normalizeSubagentRecord,
  normalizeSubagentRecordMap,
} from '../../src/impl.ts'
import type { SubagentRecord } from '../../src/protocol.ts'
import { MAX_SUBAGENT_RECORDS } from '../../src/protocol.ts'
import { fakeManager } from './harness.ts'

describe('external subagent records (schema, cap, detail)', () => {
  const record = (overrides: Partial<SubagentRecord> = {}): SubagentRecord => ({
    childId: 'acp:call-1',
    dshSessionId: 'chat-1',
    toolCallId: 'call-1',
    label: 'general-purpose · audit',
    status: 'running',
    startedAt: 100,
    lastActivityAt: 200,
    counts: { updates: 3, toolCalls: 1, textChars: 12 },
    ...overrides,
  })

  it('normalizes a stored row and keeps the failure reason shape verbatim', () => {
    expect(normalizeSubagentRecord(record({
      status: 'failed',
      error: { message: 'boom', code: 7 },
      type: 'explorer',
      endedAt: 300,
    }))).toEqual({
      childId: 'acp:call-1',
      dshSessionId: 'chat-1',
      toolCallId: 'call-1',
      label: 'general-purpose · audit',
      type: 'explorer',
      status: 'failed',
      startedAt: 100,
      lastActivityAt: 200,
      endedAt: 300,
      error: { message: 'boom', code: 7 },
      counts: { updates: 3, toolCalls: 1, textChars: 12 },
    })
    // A string reason survives as a string, an array as an array (constraint 29).
    expect(normalizeSubagentRecord(record({ error: 'rate limited' }))?.error).toBe('rate limited')
    expect(normalizeSubagentRecord(record({ error: ['a', 'b'] }))?.error).toEqual(['a', 'b'])
  })

  it('rebuilds the tool call id from the catalog child id and drops unusable rows', () => {
    const rebuilt = normalizeSubagentRecord({ ...record(), toolCallId: undefined })
    expect(rebuilt?.toolCallId).toBe('call-1')
    expect(normalizeSubagentRecord({ ...record(), childId: 'native-1' })).toBeUndefined()
    expect(normalizeSubagentRecord({ ...record(), childId: 'acp:' })).toBeUndefined()
    expect(normalizeSubagentRecord({ ...record(), dshSessionId: '' })).toBeUndefined()
    // No start time = no readable row.
    expect(normalizeSubagentRecord({ ...record(), startedAt: 'yesterday' })).toBeUndefined()
    expect(normalizeSubagentRecord(null)).toBeUndefined()
    expect(normalizeSubagentRecord([record()])).toBeUndefined()
  })

  it('reads a restored row that never reached a terminal state as unknown', () => {
    const restored = normalizeSubagentRecordMap({
      'chat-1': [
        record({ childId: 'acp:running', toolCallId: 'running', status: 'running' }),
        record({ childId: 'acp:pending', toolCallId: 'pending', status: 'pending' }),
        record({ childId: 'acp:done', toolCallId: 'done', status: 'completed', endedAt: 400 }),
      ],
    })['chat-1']
    expect(restored?.map(row => row.status)).toEqual(['unknown', 'unknown', 'completed'])
    // A converted row carries the moment its clock stopped, so the panel can
    // still show "last activity" instead of a running stopwatch.
    expect(restored?.[0].endedAt).toBe(200)
    expect(restored?.[2].endedAt).toBe(400)
  })

  it('drops keys with no surviving owner and de-duplicates by child id', () => {
    const map = normalizeSubagentRecordMap({
      'chat-1': [record()],
      'chat-2': [record({ dshSessionId: 'chat-2' })],
      'chat-orphan': [record({ dshSessionId: 'chat-orphan' })],
    }, new Set(['chat-1', 'chat-2']))
    expect(Object.keys(map).sort()).toEqual(['chat-1', 'chat-2'])
    const duplicate = normalizeSubagentRecordMap({
      'chat-1': [record({ label: 'first' }), record({ label: 'second' })],
    })['chat-1']
    expect(duplicate).toHaveLength(1)
    expect(duplicate?.[0].label).toBe('second')
  })

  it('caps at the per-chat limit, evicting the oldest TERMINAL rows only', () => {
    const rows: SubagentRecord[] = []
    for (let index = 0; index < MAX_SUBAGENT_RECORDS + 2; index += 1) {
      rows.push(record({
        childId: `acp:call-${String(index)}`,
        toolCallId: `call-${String(index)}`,
        status: 'completed',
        endedAt: 500,
      }))
    }
    // The two OLDEST terminal rows go; the newest survive.
    const capped = capSubagentRecords(rows)
    expect(capped).toHaveLength(MAX_SUBAGENT_RECORDS)
    expect(capped[0]?.toolCallId).toBe('call-2')
    expect(capped.at(-1)?.toolCallId).toBe(`call-${String(MAX_SUBAGENT_RECORDS + 1)}`)
    // Running rows are never evicted to make room: with every row still open
    // the list stays whole (the cap cannot invent a terminal state).
    const running = rows.map(row => ({ ...row, status: 'running' as const, endedAt: undefined }))
    expect(capSubagentRecords(running)).toHaveLength(running.length)
    // A mix: only terminal rows are candidates, in list order.
    const mixed = [
      { ...rows[0], status: 'running' as const, endedAt: undefined },
      rows[1],
      rows[2],
    ]
    expect(capSubagentRecords(mixed, 2).map(row => row.toolCallId)).toEqual(['call-0', 'call-2'])
  })

  it('bounds one oversized detail frame with a marker instead of dropping it', () => {
    const small = boundSubagentDetailEntry(7, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hi' } })
    expect(small.update).toEqual({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hi' } })
    expect(small.truncatedChars).toBeUndefined()
    const big = boundSubagentDetailEntry(8, {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'call-1',
      content: [{ type: 'content', content: { type: 'text', text: 'x'.repeat(ACP_TOOL_RAW_MAX + 50) } }],
    })
    expect(big.truncatedChars).toBeGreaterThan(0)
    const marked = big.update as { sessionUpdate?: string; truncated?: boolean; text?: string }
    expect(marked.sessionUpdate).toBe('tool_call_update')
    expect(marked.truncated).toBe(true)
    expect(marked.text).toContain('[truncated')
    expect(marked.text?.length).toBeLessThanOrEqual(ACP_TOOL_RAW_MAX + 80)
  })
})

describe('subagents/detail RPC (payload validation)', () => {
  it('validates both ids and the external child id prefix, and answers empty for an unknown host half', async () => {
    const detail = {
      entries: [{ seq: 3, update: { sessionUpdate: 'agent_message_chunk' } }],
      omitted: 1,
    }
    const manager = fakeManager()
    const withDetail = {
      ...manager,
      subagentsDetail: (dshSessionId: string, childId: string) => {
        manager.calls.push(['subagentsDetail', { dshSessionId, childId }])
        return detail
      },
    }
    await expect(dispatchRpc(withDetail, 'subagents/detail', { dshSessionId: 'chat-1', childId: 'acp:call-1' }))
      .resolves.toEqual({ ok: true, value: detail })
    expect(manager.calls).toContainEqual(['subagentsDetail', { dshSessionId: 'chat-1', childId: 'acp:call-1' }])
    // A host half without the method answers an empty result, not a failure.
    await expect(dispatchRpc(manager, 'subagents/detail', { dshSessionId: 'chat-1', childId: 'acp:call-1' }))
      .resolves.toEqual({ ok: true, value: { entries: [] } })
    // Payload validation happens BEFORE the optional call.
    await expect(dispatchRpc(withDetail, 'subagents/detail', { childId: 'acp:call-1' }))
      .resolves.toMatchObject({ ok: false, error: { code: 'bad_payload' } })
    await expect(dispatchRpc(withDetail, 'subagents/detail', { dshSessionId: 'chat-1' }))
      .resolves.toMatchObject({ ok: false, error: { code: 'bad_payload' } })
    await expect(dispatchRpc(withDetail, 'subagents/detail', { dshSessionId: 'chat-1', childId: 'call-1' }))
      .resolves.toMatchObject({ ok: false, error: { code: 'bad_payload' } })
    await expect(dispatchRpc(withDetail, 'subagents/detail', { dshSessionId: 'chat-1', childId: 'acp:' }))
      .resolves.toMatchObject({ ok: false, error: { code: 'bad_payload' } })
  })
})
