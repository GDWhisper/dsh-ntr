/**
 * Browser store elicitation helpers and `AcpStore` session lifecycle cleanup:
 * SSE event folding (including idempotent request updates), per-session
 * filtering, enum option validation, and cleanup on `session/closed` /
 * `session/released`.
 */

import { describe, expect, it } from 'vitest'
import {
  buildElicitationContent,
  elicitationsForSession,
  initialElicitationDraft,
  reduceElicitationEvent,
  type PendingElicitation,
} from '../../src/client/store.ts'
import type { ElicitationFieldView } from '../../src/protocol.ts'
import { makeStore } from './harness.ts'

const en = (_zh: string, text: string) => text

describe('client store elicitation helpers', () => {
  it('folds elicitation/request idempotently, preserves deadlineAt, and settles resolved/synced frames', () => {
    const fields: ElicitationFieldView[] = [
      { name: 'choice', kind: 'single-select', title: 'Choice', required: true, options: [{ value: 'a', label: 'A' }] },
    ]
    let list: PendingElicitation[] = []
    list = reduceElicitationEvent(list, {
      type: 'elicitation/request',
      requestId: 'r1',
      sessionId: 's1',
      dshSessionId: 'chat-1',
      message: 'Pick one',
      fields,
      deadlineAt: 1_700_000_000_000,
    })!
    // Duplicate requestId replaces the entry idempotently without growing the list.
    list = reduceElicitationEvent(list, {
      type: 'elicitation/request',
      requestId: 'r1',
      sessionId: 's1',
      dshSessionId: 'chat-1',
      message: 'Pick one updated',
      fields,
      deadlineAt: 1_700_000_005_000,
    })!
    list = reduceElicitationEvent(list, {
      type: 'elicitation/request',
      requestId: 'r2',
      sessionId: 's2',
      message: 'RPC only',
      fields: [],
    })!
    expect(list).toHaveLength(2)
    expect(elicitationsForSession(list, 'chat-1')).toMatchObject([
      { requestId: 'r1', message: 'Pick one updated', deadlineAt: 1_700_000_005_000 },
    ])
    expect(elicitationsForSession(list, 'chat-2')).toEqual([])

    list = reduceElicitationEvent(list, { type: 'elicitation/resolved', requestId: 'r1', sessionId: 's1', action: 'accept' })!
    expect(list.map(e => e.requestId)).toEqual(['r2'])

    list = reduceElicitationEvent(list, { type: 'elicitation/synced', requestIds: [] })!
    expect(list).toEqual([])
  })

  it('seeds defaults and validates form drafts including option membership', () => {
    const fields: ElicitationFieldView[] = [
      { name: 'mode', kind: 'single-select', title: 'Mode', required: true, defaultValue: 'fast', options: [{ value: 'fast', label: 'Fast' }] },
      { name: 'tags', kind: 'multi-select', title: 'Tags', required: true, minItems: 1, maxItems: 2, defaultValue: ['a'], options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }] },
      { name: 'retries', kind: 'integer', title: 'Retries', required: true, minimum: 1, maximum: 5, defaultValue: 2 },
      { name: 'agree', kind: 'boolean', title: 'Agree', required: false, defaultValue: true },
      { name: 'note', kind: 'string', title: 'Note', required: false, minLength: 3 },
    ]

    const draft = initialElicitationDraft(fields)
    expect(draft).toEqual({ mode: 'fast', tags: ['a'], retries: '2', agree: true, note: '' })

    expect(buildElicitationContent(fields, draft, en)).toEqual({
      ok: true,
      content: { mode: 'fast', tags: ['a'], retries: 2, agree: true },
    })

    const badInt = buildElicitationContent(fields, { ...draft, retries: '2.5' }, en)
    expect(badInt.ok).toBe(false)

    const missingReq = buildElicitationContent(fields, { ...draft, mode: '' }, en)
    expect(missingReq.ok).toBe(false)

    const badSingleOption = buildElicitationContent(fields, { ...draft, mode: 'unknown' }, en)
    expect(badSingleOption.ok).toBe(false)

    const badMultiOption = buildElicitationContent(fields, { ...draft, tags: ['a', 'c'] }, en)
    expect(badMultiOption.ok).toBe(false)

    const shortNote = buildElicitationContent(fields, { ...draft, note: 'hi' }, en)
    expect(shortNote.ok).toBe(false)
  })

  it('clears pending elicitations only for the session closed or released on AcpStore', async () => {
    const { store, apply } = makeStore()
    await apply({
      type: 'elicitation/request',
      requestId: 'r1',
      sessionId: 's1',
      dshSessionId: 'chat-1',
      message: 'First',
      fields: [],
    })
    await apply({
      type: 'elicitation/request',
      requestId: 'r2',
      sessionId: 's2',
      dshSessionId: 'chat-2',
      message: 'Second',
      fields: [],
    })
    expect(store.getSnapshot().elicitations.map(e => e.requestId)).toEqual(['r1', 'r2'])

    await apply({ type: 'session/closed', sessionId: 's1', reason: 'closed' })
    expect(store.getSnapshot().elicitations.map(e => e.requestId)).toEqual(['r2'])

    await apply({
      type: 'session/released',
      sessionId: 's2',
      session: {
        sessionId: 's2',
        acpSessionId: 'acp-2',
        agentId: 'mock',
        cwd: '/work',
        running: false,
        lifecycle: 'released',
      },
      reason: 'idle',
      cause: 'idle',
    })
    expect(store.getSnapshot().elicitations).toEqual([])
  })
})
