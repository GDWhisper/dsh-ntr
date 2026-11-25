/**
 * ACP form elicitation pure logic: schema parsing, response validation,
 * live/replay SSE frame builders, and the pending-elicitation ledger.
 *
 * Part of the host-half logic; the barrel is `src/impl.ts` and every existing
 * `../impl.ts` import keeps resolving through it. Pure logic only — no Node
 * APIs, no ACP SDK runtime values.
 */

import {
  MAX_ELICITATION_DESC_CHARS,
  MAX_ELICITATION_FIELD_NAME_CHARS,
  MAX_ELICITATION_FIELDS,
  MAX_ELICITATION_MESSAGE_CHARS,
  MAX_ELICITATION_OPTION_LABEL_CHARS,
  MAX_ELICITATION_OPTION_VALUE_CHARS,
  MAX_ELICITATION_OPTIONS,
  MAX_ELICITATION_TITLE_CHARS,
  type AcpEvent,
  type ElicitationContentValue,
  type ElicitationFieldView,
  type ElicitationOption,
  type ElicitationOutcome,
  type PendingElicitationFields,
  type PendingElicitationView,
} from '../protocol.ts'
import { AcpError } from './errors.ts'
import { PendingRequestLedger, pendingReplayFrames, type PendingRequestEntry } from './pending-request.ts'

export interface ParsedElicitationForm {
  acpSessionId: string
  toolCallId?: string
  message: string
  title?: string
  description?: string
  fields: ElicitationFieldView[]
  omittedFields?: number
  omittedOptions?: number
}

interface ParseTally {
  omittedFields: number
  omittedOptions: number
}

/** One option source's result, plus what it had to drop. */
interface ParsedOptions {
  options: ElicitationOption[]
  omitted: number
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

function truncateWithEllipsis(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

function cappedText(value: unknown, max: number): string | undefined {
  const s = nonEmptyString(value)
  return s === undefined ? undefined : truncateWithEllipsis(s, max)
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function parseEnumOptions(raw: unknown): ParsedOptions | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined
  const out: ElicitationOption[] = []
  let omitted = 0
  for (const item of raw) {
    if (out.length >= MAX_ELICITATION_OPTIONS
      || typeof item !== 'object' || item === null || Array.isArray(item)) {
      omitted += 1
      continue
    }
    const row = item as Record<string, unknown>
    if (typeof row.const !== 'string' || row.const.length > MAX_ELICITATION_OPTION_VALUE_CHARS) {
      omitted += 1
      continue
    }
    const rawLabel = typeof row.title === 'string' && row.title !== '' ? row.title : row.const
    const label = truncateWithEllipsis(rawLabel, MAX_ELICITATION_OPTION_LABEL_CHARS)
    const description = cappedText(row.description, MAX_ELICITATION_DESC_CHARS)
    out.push({
      value: row.const,
      label,
      ...(description === undefined ? {} : { description }),
    })
  }
  return { options: out, omitted }
}

function parsePlainEnum(raw: unknown, rawNames?: unknown): ParsedOptions | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined
  const names = Array.isArray(rawNames) ? rawNames : undefined
  const out: ElicitationOption[] = []
  let omitted = 0
  for (let i = 0; i < raw.length; i++) {
    const value = raw[i]
    if (out.length >= MAX_ELICITATION_OPTIONS
      || typeof value !== 'string' || value.length > MAX_ELICITATION_OPTION_VALUE_CHARS) {
      omitted += 1
      continue
    }
    const rawLabel = names !== undefined && typeof names[i] === 'string' && names[i] !== ''
      ? (names[i] as string)
      : value
    out.push({ value, label: truncateWithEllipsis(rawLabel, MAX_ELICITATION_OPTION_LABEL_CHARS) })
  }
  return { options: out, omitted }
}

/**
 * Try option sources in priority order. The first source with usable options
 * wins and only ITS omissions count; a source superseded that way was not
 * "lost". When no source yields any option, the field degrades to a text
 * input, so every option those sources dropped is lost — sum them all.
 */
function pickOptions(sources: ReadonlyArray<() => ParsedOptions | undefined>): { picked?: ParsedOptions; dropped: number } {
  let dropped = 0
  for (const source of sources) {
    const parsed = source()
    if (parsed === undefined) continue
    if (parsed.options.length > 0) return { picked: parsed, dropped: 0 }
    dropped += parsed.omitted
  }
  return { dropped }
}

function parseField(name: string, raw: unknown, required: boolean, tally: ParseTally): ElicitationFieldView {
  const row = (typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>
  const type = typeof row.type === 'string' ? row.type : 'string'
  const title = cappedText(row.title, MAX_ELICITATION_TITLE_CHARS)
    ?? truncateWithEllipsis(name, MAX_ELICITATION_TITLE_CHARS)
  const description = cappedText(row.description, MAX_ELICITATION_DESC_CHARS)
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
    const { picked, dropped } = pickOptions([
      () => parseEnumOptions(items.anyOf),
      () => parseEnumOptions(items.oneOf),
      () => parsePlainEnum(items.enum, items.enumNames),
    ])
    const options = picked?.options ?? []
    tally.omittedOptions += picked?.omitted ?? dropped
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
  const { picked, dropped } = pickOptions([
    () => parseEnumOptions(row.oneOf),
    () => parsePlainEnum(row.enum, row.enumNames),
  ])
  tally.omittedOptions += picked?.omitted ?? dropped
  if (picked !== undefined) {
    return {
      ...base,
      kind: 'single-select',
      options: picked.options,
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
  const message = typeof row.message === 'string'
    ? truncateWithEllipsis(row.message, MAX_ELICITATION_MESSAGE_CHARS)
    : ''
  const toolCallId = nonEmptyString(row.toolCallId)
  const schema = (typeof row.requestedSchema === 'object' && row.requestedSchema !== null && !Array.isArray(row.requestedSchema)
    ? row.requestedSchema
    : {}) as Record<string, unknown>
  const title = cappedText(schema.title, MAX_ELICITATION_TITLE_CHARS)
  const description = cappedText(schema.description, MAX_ELICITATION_DESC_CHARS)
  const requiredSet = new Set(
    Array.isArray(schema.required) ? schema.required.filter((v): v is string => typeof v === 'string') : [],
  )
  const properties = (typeof schema.properties === 'object' && schema.properties !== null && !Array.isArray(schema.properties)
    ? schema.properties
    : {}) as Record<string, unknown>
  const fields: ElicitationFieldView[] = []
  const tally: ParseTally = { omittedFields: 0, omittedOptions: 0 }
  for (const [name, prop] of Object.entries(properties)) {
    if (fields.length >= MAX_ELICITATION_FIELDS
      || name === '' || name.length > MAX_ELICITATION_FIELD_NAME_CHARS) {
      tally.omittedFields += 1
      continue
    }
    fields.push(parseField(name, prop, requiredSet.has(name), tally))
  }
  return {
    acpSessionId,
    ...(toolCallId === undefined ? {} : { toolCallId }),
    message,
    ...(title === undefined ? {} : { title }),
    ...(description === undefined ? {} : { description }),
    fields,
    ...(tally.omittedFields === 0 ? {} : { omittedFields: tally.omittedFields }),
    ...(tally.omittedOptions === 0 ? {} : { omittedOptions: tally.omittedOptions }),
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
 * `cancel`). When `fields` are supplied, rejects undeclared keys, enforces
 * required fields, type/range constraints, and enum option membership.
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
    const fieldByName = new Map(fields.map(f => [f.name, f]))
    for (const key of Object.keys(normalized)) {
      if (!fieldByName.has(key)) {
        throw new AcpError('bad_payload', `acp: unexpected elicitation field "${key}"`)
      }
    }
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
        if (field.kind === 'single-select' && field.options !== undefined && field.options.length > 0) {
          const allowed = new Set(field.options.map(o => o.value))
          if (!allowed.has(val)) {
            throw new AcpError('bad_payload', `acp: invalid option for "${field.title}"`)
          }
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
        if (field.options !== undefined && field.options.length > 0) {
          const allowed = new Set(field.options.map(o => o.value))
          for (const item of val) {
            if (!allowed.has(item)) {
              throw new AcpError('bad_payload', `acp: invalid option for "${field.title}"`)
            }
          }
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
    ...(view.omittedFields === undefined ? {} : { omittedFields: view.omittedFields }),
    ...(view.omittedOptions === undefined ? {} : { omittedOptions: view.omittedOptions }),
    ...(view.deadlineAt === undefined ? {} : { deadlineAt: view.deadlineAt }),
  }
}

/** Snapshot replay frames for a newly connected SSE client, ending with `elicitation/synced`. */
export function elicitationReplayFrames(pending: readonly PendingElicitationView[]): AcpEvent[] {
  return pendingReplayFrames(
    pending,
    elicitationRequestFrame,
    requestIds => ({ type: 'elicitation/synced', requestIds }),
  )
}

export type PendingElicitationEntry = PendingRequestEntry<PendingElicitationFields, ElicitationOutcome>

/** Host ledger tracking in-flight `elicitation/create` requests across a bridge. */
export class ElicitationLedger extends PendingRequestLedger<PendingElicitationFields, ElicitationOutcome> {
  constructor() {
    super({
      kind: 'elicitation',
      cancelOutcome: () => ({ action: 'cancel' }),
      normalizeOutcome: (outcome, view) =>
        outcome.action === 'accept'
          ? validateElicitationOutcome('accept', outcome.content, view?.fields)
          : outcome,
    })
  }
}
