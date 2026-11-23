/**
 * Pure host-side ACP form elicitation logic: schema parsing, response
 * validation, live/replay SSE frame construction, ledger lifecycle, and RPC
 * dispatch (`elicitation/respond`).
 */

import { describe, expect, it } from 'vitest'
import {
  AcpError,
  ElicitationLedger,
  dispatchRpc,
  elicitationReplayFrames,
  elicitationRequestFrame,
  parseElicitationForm,
  validateElicitationOutcome,
} from '../../src/impl.ts'
import type { AcpManager } from '../../src/impl.ts'
import {
  MAX_ELICITATION_DESC_CHARS,
  MAX_ELICITATION_FIELDS,
  MAX_ELICITATION_MESSAGE_CHARS,
  MAX_ELICITATION_OPTION_LABEL_CHARS,
  MAX_ELICITATION_OPTIONS,
  MAX_ELICITATION_TITLE_CHARS,
  type ElicitationOutcome,
} from '../../src/protocol.ts'

describe('ACP form elicitation parsing and validation', () => {
  it('parses all ACP form property schemas into normalized field views', () => {
    const parsed = parseElicitationForm({
      mode: 'form',
      sessionId: 'acp-1',
      toolCallId: 'call-9',
      message: 'Please choose your setup',
      requestedSchema: {
        type: 'object',
        title: 'Project Setup',
        description: 'Confirm before scaffolding',
        required: ['env', 'features', 'retries'],
        properties: {
          env: {
            type: 'string',
            title: 'Target Environment',
            oneOf: [
              { const: 'dev', title: 'Development', description: 'Local machine' },
              { const: 'prod', title: 'Production' },
            ],
            default: 'dev',
          },
          region: {
            type: 'string',
            enum: ['us', 'eu'],
          },
          features: {
            type: 'array',
            title: 'Features',
            minItems: 1,
            maxItems: 2,
            items: {
              anyOf: [
                { const: 'auth', title: 'Authentication' },
                { const: 'ci', title: 'CI Workflow' },
                { const: 'docs', title: 'Docs' },
              ],
            },
          },
          tags: {
            type: 'array',
            items: { type: 'string', enum: ['fast', 'strict'] },
            default: ['fast'],
          },
          notes: {
            type: 'string',
            title: 'Notes',
            minLength: 2,
            maxLength: 50,
            format: 'email',
          },
          retries: {
            type: 'integer',
            title: 'Retries',
            minimum: 0,
            maximum: 5,
            default: 2,
          },
          ratio: {
            type: 'number',
            minimum: 0.1,
            maximum: 1.0,
          },
          confirm: {
            type: 'boolean',
            title: 'Proceed?',
            default: true,
          },
          custom: {
            type: 'x-future-type',
            title: 'Future Field',
          },
        },
      },
    })

    expect(parsed).toEqual({
      acpSessionId: 'acp-1',
      toolCallId: 'call-9',
      message: 'Please choose your setup',
      title: 'Project Setup',
      description: 'Confirm before scaffolding',
      fields: [
        {
          name: 'env',
          kind: 'single-select',
          title: 'Target Environment',
          required: true,
          options: [
            { value: 'dev', label: 'Development', description: 'Local machine' },
            { value: 'prod', label: 'Production' },
          ],
          defaultValue: 'dev',
        },
        {
          name: 'region',
          kind: 'single-select',
          title: 'region',
          required: false,
          options: [
            { value: 'us', label: 'us' },
            { value: 'eu', label: 'eu' },
          ],
        },
        {
          name: 'features',
          kind: 'multi-select',
          title: 'Features',
          required: true,
          minItems: 1,
          maxItems: 2,
          options: [
            { value: 'auth', label: 'Authentication' },
            { value: 'ci', label: 'CI Workflow' },
            { value: 'docs', label: 'Docs' },
          ],
        },
        {
          name: 'tags',
          kind: 'multi-select',
          title: 'tags',
          required: false,
          options: [
            { value: 'fast', label: 'fast' },
            { value: 'strict', label: 'strict' },
          ],
          defaultValue: ['fast'],
        },
        {
          name: 'notes',
          kind: 'string',
          title: 'Notes',
          required: false,
          minLength: 2,
          maxLength: 50,
          format: 'email',
        },
        {
          name: 'retries',
          kind: 'integer',
          title: 'Retries',
          required: true,
          minimum: 0,
          maximum: 5,
          defaultValue: 2,
        },
        {
          name: 'ratio',
          kind: 'number',
          title: 'ratio',
          required: false,
          minimum: 0.1,
          maximum: 1.0,
        },
        {
          name: 'confirm',
          kind: 'boolean',
          title: 'Proceed?',
          required: false,
          defaultValue: true,
        },
        {
          name: 'custom',
          kind: 'string',
          title: 'Future Field',
          required: false,
        },
      ],
    })
  })

  it('rejects non-form modes and missing sessionId', () => {
    expect(parseElicitationForm({ mode: 'url', sessionId: 's1', elicitationId: 'e1', url: 'https://x.test', message: 'hi' })).toBeUndefined()
    expect(parseElicitationForm({ mode: 'form', message: 'missing session' })).toBeUndefined()
    expect(parseElicitationForm(null)).toBeUndefined()
  })

  it('validates accept, decline, and cancel outcomes against field schemas', () => {
    const parsed = parseElicitationForm({
      mode: 'form',
      sessionId: 'acp-1',
      message: 'Confirm',
      requestedSchema: {
        type: 'object',
        required: ['pick', 'count'],
        properties: {
          pick: { type: 'string', enum: ['a', 'b'] },
          count: { type: 'integer', minimum: 1, maximum: 3 },
          multi: { type: 'array', minItems: 1, maxItems: 2, items: { type: 'string', enum: ['x', 'y', 'z'] } },
        },
      },
    })!

    expect(validateElicitationOutcome('decline', undefined, parsed.fields)).toEqual({ action: 'decline' })
    expect(validateElicitationOutcome('cancel', undefined, parsed.fields)).toEqual({ action: 'cancel' })
    expect(validateElicitationOutcome('accept', { pick: 'a', count: 2, multi: ['x'] }, parsed.fields))
      .toEqual({ action: 'accept', content: { pick: 'a', count: 2, multi: ['x'] } })

    expect(() => validateElicitationOutcome('accept', { count: 2 }, parsed.fields)).toThrow(AcpError)
    expect(() => validateElicitationOutcome('accept', { pick: 'a', count: 1.5 }, parsed.fields)).toThrow(AcpError)
    expect(() => validateElicitationOutcome('accept', { pick: 'a', count: 5 }, parsed.fields)).toThrow(AcpError)
    expect(() => validateElicitationOutcome('accept', { pick: 'a', count: 1, multi: ['x', 'y', 'z'] }, parsed.fields)).toThrow(AcpError)
    expect(() => validateElicitationOutcome('accept', { pick: 'c', count: 2 }, parsed.fields)).toThrow(/invalid option/)
    expect(() => validateElicitationOutcome('accept', { pick: 'a', count: 2, multi: ['bogus'] }, parsed.fields)).toThrow(/invalid option/)
    expect(() => validateElicitationOutcome('accept', { pick: 'a', count: 2, extra: 'nope' }, parsed.fields)).toThrow(/unexpected elicitation field/)
    expect(() => validateElicitationOutcome('bogus', {}, parsed.fields)).toThrow(AcpError)
  })

  it('bounds overlong text, field counts, and option counts from agent schemas', () => {
    const properties: Record<string, unknown> = {}
    for (let i = 0; i < MAX_ELICITATION_FIELDS + 5; i++) {
      properties[`f${String(i)}`] = i === 0
        ? {
            type: 'string',
            title: 'T'.repeat(MAX_ELICITATION_TITLE_CHARS + 20),
            description: 'D'.repeat(MAX_ELICITATION_DESC_CHARS + 20),
            oneOf: Array.from({ length: MAX_ELICITATION_OPTIONS + 5 }, (_, j) => ({
              const: `v${String(j)}`,
              title: 'L'.repeat(MAX_ELICITATION_OPTION_LABEL_CHARS + 20),
            })),
          }
        : { type: 'string' }
    }
    const parsed = parseElicitationForm({
      mode: 'form',
      sessionId: 'acp-1',
      message: 'M'.repeat(MAX_ELICITATION_MESSAGE_CHARS + 50),
      requestedSchema: {
        type: 'object',
        title: 'S'.repeat(MAX_ELICITATION_TITLE_CHARS + 10),
        description: 'B'.repeat(MAX_ELICITATION_DESC_CHARS + 10),
        properties,
      },
    })!

    expect(parsed.message.length).toBe(MAX_ELICITATION_MESSAGE_CHARS)
    expect(parsed.message.endsWith('…')).toBe(true)
    expect(parsed.title?.length).toBe(MAX_ELICITATION_TITLE_CHARS)
    expect(parsed.description?.length).toBe(MAX_ELICITATION_DESC_CHARS)
    expect(parsed.fields).toHaveLength(MAX_ELICITATION_FIELDS)
    expect(parsed.fields[0]?.title.length).toBe(MAX_ELICITATION_TITLE_CHARS)
    expect(parsed.fields[0]?.description?.length).toBe(MAX_ELICITATION_DESC_CHARS)
    expect(parsed.fields[0]?.options).toHaveLength(MAX_ELICITATION_OPTIONS)
    expect(parsed.fields[0]?.options?.[0]?.label.length).toBe(MAX_ELICITATION_OPTION_LABEL_CHARS)
  })
})

describe('ElicitationLedger, replay frames, and RPC dispatch', () => {
  it('tracks pending asks, replays identically with deadlineAt, responds once, and keeps entries on validation errors', () => {
    const ledger = new ElicitationLedger()
    const received: ElicitationOutcome[] = []
    const view = {
      dshSessionId: 'dsh-1',
      message: 'Pick one',
      deadlineAt: 1_700_000_000_000,
      fields: [{ name: 'choice', kind: 'single-select' as const, title: 'Choice', required: true, options: [{ value: 'a', label: 'A' }] }],
    }
    const id1 = ledger.create('s1', outcome => { received.push(outcome) }, view)
    const id2 = ledger.create('s2', outcome => { received.push(outcome) }, { message: 'Second', fields: [] })

    expect(ledger.hasPendingFor('s1')).toBe(true)
    expect(ledger.hasPendingFor('s9')).toBe(false)

    const liveFrame = elicitationRequestFrame({ requestId: id1, sessionId: 's1', ...view })
    expect(liveFrame).toMatchObject({ deadlineAt: 1_700_000_000_000 })
    const replay = elicitationReplayFrames(ledger.pendingViews())
    expect(replay[0]).toEqual(liveFrame)
    expect(replay.at(-1)).toEqual({ type: 'elicitation/synced', requestIds: [id1, id2] })

    // Invalid option leaves the ask pending so the caller can retry with a valid one.
    expect(() => ledger.respond(id1, { action: 'accept', content: { choice: 'z' } })).toThrow(/invalid option/)
    expect(ledger.has(id1)).toBe(true)

    ledger.respond(id1, { action: 'accept', content: { choice: 'a' } })
    expect(received[0]).toEqual({ action: 'accept', content: { choice: 'a' } })
    expect(() => ledger.respond(id1, { action: 'cancel' })).toThrow(AcpError)

    const settled = ledger.settleFor(entry => entry.sessionId === 's2')
    expect(settled).toEqual([id2])
    expect(received[1]).toEqual({ action: 'cancel' })
    expect(ledger.pendingViews()).toEqual([])
  })

  it('routes elicitation/respond through dispatchRpc', async () => {
    const calls: Array<{ requestId: string; outcome: ElicitationOutcome }> = []
    const manager = {
      respondElicitation(requestId: string, outcome: ElicitationOutcome) {
        calls.push({ requestId, outcome })
      },
    } as unknown as AcpManager

    const okAccept = await dispatchRpc(manager, 'elicitation/respond', {
      requestId: 'req-1',
      action: 'accept',
      content: { answer: 'yes', ok: true, count: 2, tags: ['a'] },
    })
    expect(okAccept).toEqual({ ok: true, value: { done: true } })
    expect(calls[0]).toEqual({
      requestId: 'req-1',
      outcome: { action: 'accept', content: { answer: 'yes', ok: true, count: 2, tags: ['a'] } },
    })

    const okDecline = await dispatchRpc(manager, 'elicitation/respond', { requestId: 'req-2', action: 'decline' })
    expect(okDecline).toEqual({ ok: true, value: { done: true } })
    expect(calls[1]).toEqual({ requestId: 'req-2', outcome: { action: 'decline' } })

    const bad = await dispatchRpc(manager, 'elicitation/respond', { requestId: 'req-3', action: 'accept', content: 'not-object' })
    expect(bad.ok).toBe(false)
  })
})
