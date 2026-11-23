/**
 * ACP form elicitation pure logic: schema parsing, response validation,
 * live/replay SSE frame builders, and the pending-elicitation ledger.
 *
 * Part of the host-half logic; the barrel is `src/impl.ts` and every existing
 * `../impl.ts` import keeps resolving through it. Pure logic only — no Node
 * APIs, no ACP SDK runtime values.
 */

import { randomUUID } from '../ids.ts'
import type {
  AcpEvent,
  ElicitationContentValue,
  ElicitationFieldView,
  ElicitationOption,
  ElicitationOutcome,
  PendingElicitationFields,
  PendingElicitationView,
} from '../protocol.ts'
import { AcpError } from './errors.ts'

export interface ParsedElicitationForm {
  acpSessionId: string
  toolCallId?: string
  message: string
  title?: string
  description?: string
  fields: ElicitationFieldView[]
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function parseEnumOptions(raw: unknown): ElicitationOption[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined
  const out: ElicitationOption[] = []
  for (const item of raw) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) continue
    const row = item as Record<string, unknown>
    if (typeof row.const !== 'string') continue
    const title = typeof row.title === 'string' && row.title !== '' ? row.title : row.const
    const description = nonEmptyString(row.description)
    out.push({
      value: row.const,
      label: title,
      ...(description === undefined ? {} : { description }),
    })
  }
  return out.length > 0 ? out : undefined
}

function parsePlainEnum(raw: unknown, rawNames?: unknown): ElicitationOption[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined
  const names = Array.isArray(rawNames) ? rawNames : undefined
  const out: ElicitationOption[] = []
  for (let i = 0; i < raw.length; i++) {
    const value = raw[i]
    if (typeof value !== 'string') continue
    const label = names !== undefined && typeof names[i] === 'string' && names[i] !== ''
      ? (names[i] as string)
      : value
    out.push({ value, label })
  }
  return out.length > 0 ? out : undefined
}

function parseField(name: string, raw: unknown, required: boolean): ElicitationFieldView {
  const row = (typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>
  const type = typeof row.type === 'string' ? row.type : 'string'
  const title = nonEmptyString(row.title) ?? name
  const description = nonEmptyString(row.description)
  const base = {
    name,
    title,
    ...(description === undefined ? {} : { description }),
    required,
  }

  if (type === 'boolean') {
    return {
      ...base,
      kind: 'boolean',
      ...(typeof row.default === 'boolean' ? { defaultValue: row.default } : {}),
    }
  }

  if (type === 'number' || type === 'integer') {
    const minimum = finiteNumber(row.minimum)
    const maximum = finiteNumber(row.maximum)
    const defaultNum = finiteNumber(row.default)
    return {
      ...base,
      kind: type,
      ...(minimum === undefined ? {} : { minimum }),
      ...(maximum === undefined ? {} : { maximum }),
      ...(defaultNum === undefined ? {} : { defaultValue: defaultNum }),
    }
  }

  if (type === 'array') {
    const items = (typeof row.items === 'object' && row.items !== null && !Array.isArray(row.items)
      ? row.items
      : {}) as Record<string, unknown>
    const options = parseEnumOptions(items.anyOf)
      ?? parseEnumOptions(items.oneOf)
      ?? parsePlainEnum(items.enum, items.enumNames)
      ?? []
    const minItems = finiteNumber(row.minItems)
    const maxItems = finiteNumber(row.maxItems)
    const defaultArr = Array.isArray(row.default)
      ? row.default.filter((v): v is string => typeof v === 'string')
      : undefined
    return {
      ...base,
      kind: 'multi-select',
      options,
      ...(minItems === undefined ? {} : { minItems }),
      ...(maxItems === undefined ? {} : { maxItems }),
      ...(defaultArr === undefined ? {} : { defaultValue: defaultArr }),
    }
  }

  // `string` (or unknown/custom schema type degraded to text input so nothing is dropped).
  const options = parseEnumOptions(row.oneOf) ?? parsePlainEnum(row.enum, row.enumNames)
  if (options !== undefined) {
    return {
      ...base,
      kind: 'single-select',
      options,
      ...(typeof row.default === 'string' ? { defaultValue: row.default } : {}),
    }
  }

  const minLength = finiteNumber(row.minLength)
  const maxLength = finiteNumber(row.maxLength)
  const format = nonEmptyString(row.format)
  return {
    ...base,
    kind: 'string',
    ...(minLength === undefined ? {} : { minLength }),
    ...(maxLength === undefined ? {} : { maxLength }),
    ...(format === undefined ? {} : { format }),
    ...(typeof row.default === 'string' ? { defaultValue: row.default } : {}),
  }
}

/**
 * Parse an ACP `elicitation/create` request into a normalized form descriptor.
 * Returns `undefined` when the request is not a session-scoped `mode: "form"`
 * elicitation (we only advertise `elicitation: { form: {} }`).
 */
export function parseElicitationForm(raw: unknown): ParsedElicitationForm | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined
  const row = raw as Record<string, unknown>
  if (row.mode !== 'form') return undefined
  const acpSessionId = nonEmptyString(row.sessionId)
  if (acpSessionId === undefined) return undefined
  const message = typeof row.message === 'string' ? row.message : ''
  const toolCallId = nonEmptyString(row.toolCallId)
  const schema = (typeof row.requestedSchema === 'object' && row.requestedSchema !== null && !Array.isArray(row.requestedSchema)
    ? row.requestedSchema
    : {}) as Record<string, unknown>
  const title = nonEmptyString(schema.title)
  const description = nonEmptyString(schema.description)
  const requiredSet = new Set(
    Array.isArray(schema.required) ? schema.required.filter((v): v is string => typeof v === 'string') : [],
  )
  const properties = (typeof schema.properties === 'object' && schema.properties !== null && !Array.isArray(schema.properties)
    ? schema.properties
    : {}) as Record<string, unknown>
  const fields = Object.entries(properties).map(([name, prop]) => parseField(name, prop, requiredSet.has(name)))
  return {
    acpSessionId,
    ...(toolCallId === undefined ? {} : { toolCallId }),
    message,
    ...(title === undefined ? {} : { title }),
    ...(description === undefined ? {} : { description }),
    fields,
  }
}

function isValidContentValue(value: unknown): value is ElicitationContentValue {
  if (typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (Array.isArray(value)) return value.every(item => typeof item === 'string')
  return false
}

/**
 * Validate a browser-submitted elicitation response (`accept` / `decline` /
 * `cancel`). When `fields` are supplied, also enforces required fields and
 * per-field type/range constraints.
 */
export function validateElicitationOutcome(
  action: unknown,
  content: unknown,
  fields?: readonly ElicitationFieldView[],
): ElicitationOutcome {
  if (action === 'decline' || action === 'cancel') return { action }
  if (action !== 'accept') {
    throw new AcpError('bad_payload', 'acp: action must be accept, decline, or cancel')
  }
  if (typeof content !== 'object' || content === null || Array.isArray(content)) {
    throw new AcpError('bad_payload', 'acp: accept response requires a content object')
  }
  const normalized: Record<string, ElicitationContentValue> = {}
  for (const [key, value] of Object.entries(content as Record<string, unknown>)) {
    if (value === undefined) continue
    if (!isValidContentValue(value)) {
      throw new AcpError('bad_payload', `acp: invalid value for elicitation field "${key}"`)
    }
    normalized[key] = value
  }
  if (fields !== undefined) {
    for (const field of fields) {
      const val = normalized[field.name]
      if (val === undefined) {
        if (field.required) {
          throw new AcpError('bad_payload', `acp: missing required field "${field.title}"`)
        }
        continue
      }
      if (field.kind === 'string' || field.kind === 'single-select') {
        if (typeof val !== 'string') {
          throw new AcpError('bad_payload', `acp: field "${field.title}" must be a string`)
        }
        if (field.required && val.trim() === '') {
          throw new AcpError('bad_payload', `acp: field "${field.title}" is required`)
        }
        if (field.minLength !== undefined && val.length < field.minLength) {
          throw new AcpError('bad_payload', `acp: field "${field.title}" must be at least ${String(field.minLength)} characters`)
        }
        if (field.maxLength !== undefined && val.length > field.maxLength) {
          throw new AcpError('bad_payload', `acp: field "${field.title}" must be at most ${String(field.maxLength)} characters`)
        }
      } else if (field.kind === 'boolean') {
        if (typeof val !== 'boolean') {
          throw new AcpError('bad_payload', `acp: field "${field.title}" must be a boolean`)
        }
      } else if (field.kind === 'number' || field.kind === 'integer') {
        if (typeof val !== 'number' || !Number.isFinite(val)) {
          throw new AcpError('bad_payload', `acp: field "${field.title}" must be a number`)
        }
        if (field.kind === 'integer' && !Number.isInteger(val)) {
          throw new AcpError('bad_payload', `acp: field "${field.title}" must be an integer`)
        }
        if (field.minimum !== undefined && val < field.minimum) {
          throw new AcpError('bad_payload', `acp: field "${field.title}" must be >= ${String(field.minimum)}`)
        }
        if (field.maximum !== undefined && val > field.maximum) {
          throw new AcpError('bad_payload', `acp: field "${field.title}" must be <= ${String(field.maximum)}`)
        }
      } else if (field.kind === 'multi-select') {
        if (!Array.isArray(val)) {
          throw new AcpError('bad_payload', `acp: field "${field.title}" must be an array of strings`)
        }
        if (field.required && val.length === 0) {
          throw new AcpError('bad_payload', `acp: select at least one option for "${field.title}"`)
        }
        if (field.minItems !== undefined && val.length < field.minItems) {
          throw new AcpError('bad_payload', `acp: select at least ${String(field.minItems)} option(s) for "${field.title}"`)
        }
        if (field.maxItems !== undefined && val.length > field.maxItems) {
          throw new AcpError('bad_payload', `acp: select at most ${String(field.maxItems)} option(s) for "${field.title}"`)
        }
      }
    }
  }
  return { action: 'accept', content: normalized }
}

/** Build the `elicitation/request` SSE frame (shared by live broadcast and reconnect replay). */
export function elicitationRequestFrame(view: PendingElicitationView): AcpEvent {
  return {
    type: 'elicitation/request',
    requestId: view.requestId,
    sessionId: view.sessionId,
    ...(view.dshSessionId === undefined ? {} : { dshSessionId: view.dshSessionId }),
    ...(view.toolCallId === undefined ? {} : { toolCallId: view.toolCallId }),
    message: view.message,
    ...(view.title === undefined ? {} : { title: view.title }),
    ...(view.description === undefined ? {} : { description: view.description }),
    fields: view.fields,
  }
}

/** Snapshot replay frames for a newly connected SSE client, ending with `elicitation/synced`. */
export function elicitationReplayFrames(pending: readonly PendingElicitationView[]): AcpEvent[] {
  const requests: AcpEvent[] = pending.map(elicitationRequestFrame)
  return [...requests, { type: 'elicitation/synced', requestIds: pending.map(p => p.requestId) }]
}

export interface PendingElicitationEntry {
  requestId: string
  sessionId: string
  resolve: (outcome: ElicitationOutcome) => void
  view: PendingElicitationFields
}

/** Host ledger tracking in-flight `elicitation/create` requests across a bridge. */
export class ElicitationLedger {
  private readonly pending = new Map<string, PendingElicitationEntry>()

  create(sessionId: string, executor: (outcome: ElicitationOutcome) => void, view: PendingElicitationFields): string {
    const requestId = randomUUID()
    this.pending.set(requestId, { requestId, sessionId, resolve: executor, view })
    return requestId
  }

  respond(requestId: string, outcome: ElicitationOutcome): true {
    const entry = this.pending.get(requestId)
    if (entry === undefined) throw new AcpError('unknown_request', `acp: no pending elicitation ${requestId}`)
    const validated = outcome.action === 'accept'
      ? validateElicitationOutcome('accept', outcome.content, entry.view.fields)
      : outcome
    this.pending.delete(requestId)
    entry.resolve(validated)
    return true
  }

  has(requestId: string): boolean {
    return this.pending.has(requestId)
  }

  settleFor(predicate: (entry: { requestId: string; sessionId: string }) => boolean): string[] {
    const settled: string[] = []
    for (const [id, entry] of [...this.pending]) {
      if (!predicate(entry)) continue
      this.pending.delete(id)
      entry.resolve({ action: 'cancel' })
      settled.push(id)
    }
    return settled
  }

  sessionIds(): Array<{ requestId: string; sessionId: string }> {
    return [...this.pending.values()].map(e => ({ requestId: e.requestId, sessionId: e.sessionId }))
  }

  hasPendingFor(sessionId: string): boolean {
    for (const entry of this.pending.values()) {
      if (entry.sessionId === sessionId) return true
    }
    return false
  }

  pendingViews(): PendingElicitationView[] {
    const out: PendingElicitationView[] = []
    for (const entry of this.pending.values()) {
      out.push({ requestId: entry.requestId, sessionId: entry.sessionId, ...entry.view })
    }
    return out
  }
}
