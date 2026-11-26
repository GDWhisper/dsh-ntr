/**
 * Read-only access to Antigravity's private SQLite session log
 * (`<agyStoreRoot>/conversations/<acpSessionId>.db`).
 *
 * Used strictly as a fallback evidence source when an Antigravity prompt ends
 * without visible assistant output (or with a generic refusal/error): upstream
 * 429 quota limits, verification URLs, and 4xx/5xx API failures land in
 * `steps` (`step_type = 17`) even when wire `session/update` and JSONL brain
 * logs stay silent.
 *
 * Strict invariants:
 * - Read-only (`{ readOnly: true }`), never writes or creates files.
 * - Rejects path traversal (`SESSION_ID_PATTERN`) and symlinks (`lstatSync`).
 * - Bounds payload reads (`MAX_ERROR_PAYLOAD_BYTES`) and busy waits
 *   (`BUSY_TIMEOUT_MS`), and always closes handles in `finally`.
 * - Fail-open: `node:sqlite` unavailability, missing DBs, busy locks, or schema
 *   drift return `undefined` without throwing.
 */
import { lstatSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { SESSION_ID_PATTERN } from './agy-transcript.ts'

/** `CORTEX_STEP_TYPE_ERROR_MESSAGE` observed in Antigravity `steps.step_type`. */
export const AGY_STEP_ERROR_MESSAGE = 17
/** Bounded prefix read from `step_payload` / `error_details` so huge traces stay out of memory. */
const MAX_ERROR_PAYLOAD_BYTES = 16_384
/** Short synchronous wait when Antigravity holds a write lock. */
const BUSY_TIMEOUT_MS = 100

const API_ERROR_RE = /Error (\d{3}), Message: ((?:(?!, Status: |Error \d{3}, Message: ).)+), Status: ([A-Z_]+|\d{3}[^,\n]*)/s
const STATUS_ERROR_RE = /(?<![A-Z_])([A-Z_]+) \(code (\d{3})\): (\P{Cc}+)/u
const QUOTA_EXHAUSTED_RE = /\b(?:reason:QUOTA_EXHAUSTED|QUOTA_EXHAUSTED|RESOURCE_EXHAUSTED)\b/
const INVALID_THINKING_SIG_RE = /\bmessages\.\d+\.content\.\d+(?:\.thinking\.signature: Field required|: Invalid `signature` in `thinking` block)/
const RESET_TIMESTAMP_RE = /\bquotaResetTimeStamp:([^\s\]]+)/
const RESET_DELAY_RE = /\bquotaResetDelay:((?:\d+(?:\.\d+)?(?:ns|us|µs|μs|ms|h|m|s))+)(?=[\s\]])/
const RETRY_DELAY_RE = /\bretryDelay:((?:\d+(?:\.\d+)?(?:ns|us|µs|μs|ms|h|m|s))+)(?=[\s\]])/
const RESETS_IN_RE = /\bResets in ((?:\d+(?:\.\d+)?(?:ns|us|µs|μs|ms|h|m|s))+)(?!\w|\.\d)/
const ERROR_JSON_START_RE = /\{\s*"error"\s*:/g
const GO_DURATION_PART_RE = /(\d+(?:\.\d+)?)(ns|us|µs|μs|ms|h|m|s)/g
const GO_DURATION_UNIT_MS: Record<string, number> = {
  ns: 1e-6,
  us: 1e-3,
  µs: 1e-3,
  μs: 1e-3,
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
}

export type AgyDbFailureKind = 'quota' | 'validation' | 'thinking_signature' | 'api_error'

export interface AgyDbStepFailure {
  idx: number
  kind: AgyDbFailureKind
  message: string
  statusCode?: number
  statusName?: string
  resetDelay?: string
  resetAtIso?: string
  validationUrl?: string
}

interface SqliteStatementLike {
  get(...params: unknown[]): Record<string, unknown> | undefined
}

interface SqliteDatabaseLike {
  exec(sql: string): void
  prepare(sql: string): SqliteStatementLike
  close(): void
}

type SqliteDatabaseCtor = new (
  path: string,
  options?: { readOnly?: boolean; timeout?: number },
) => SqliteDatabaseLike

let cachedSqliteCtor: SqliteDatabaseCtor | undefined
let sqliteLoadFailed = false

function loadSqliteCtor(): SqliteDatabaseCtor | undefined {
  if (cachedSqliteCtor !== undefined) return cachedSqliteCtor
  if (sqliteLoadFailed) return undefined
  try {
    const req = createRequire(import.meta.url)
    const mod = req('node:sqlite') as { DatabaseSync?: SqliteDatabaseCtor }
    if (typeof mod.DatabaseSync === 'function') {
      cachedSqliteCtor = mod.DatabaseSync
      return cachedSqliteCtor
    }
  } catch {
    // Host runtime omitted or restricted `node:sqlite`: fall back silently.
  }
  sqliteLoadFailed = true
  return undefined
}

/** Visible to tests only when exercising custom/mocked sqlite availability. */
export function resolveAgyDbPath(storeRoot: string, acpSessionId: string): string | undefined {
  if (storeRoot === '' || !SESSION_ID_PATTERN.test(acpSessionId)) return undefined
  const convDir = join(storeRoot, 'conversations')
  const dbPath = join(convDir, `${acpSessionId}.db`)
  try {
    const dirStat = lstatSync(convDir)
    if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) return undefined
    const fileStat = lstatSync(dbPath)
    if (fileStat.isSymbolicLink() || !fileStat.isFile()) return undefined
    return dbPath
  } catch {
    return undefined
  }
}

function withReadOnlyStepsDb<T>(
  storeRoot: string,
  acpSessionId: string,
  fn: (db: SqliteDatabaseLike) => T,
): T | undefined {
  const Ctor = loadSqliteCtor()
  if (Ctor === undefined) return undefined
  const dbPath = resolveAgyDbPath(storeRoot, acpSessionId)
  if (dbPath === undefined) return undefined
  let db: SqliteDatabaseLike | undefined
  try {
    db = new Ctor(dbPath, { readOnly: true, timeout: BUSY_TIMEOUT_MS })
    try {
      db.exec(`PRAGMA busy_timeout = ${String(BUSY_TIMEOUT_MS)}`)
    } catch {
      // `timeout` constructor option already covers busy waits on modern Node builds.
    }
    const tableRow = db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'steps'").get()
    if (tableRow === undefined) return undefined
    return fn(db)
  } catch {
    return undefined
  } finally {
    try { db?.close() } catch { /* ignore */ }
  }
}

/** Read the highest `steps.idx` currently persisted (`-1` when table is empty; `undefined` if unreadable/absent). */
export function readAgyDbLastStepIndex(storeRoot: string, acpSessionId: string): number | undefined {
  return withReadOnlyStepsDb(storeRoot, acpSessionId, db => {
    const row = db.prepare('SELECT max(idx) AS maxIdx FROM steps').get()
    const maxIdx = row?.maxIdx
    return typeof maxIdx === 'number' && Number.isFinite(maxIdx) ? maxIdx : -1
  })
}

function decodeBlob(value: unknown): string {
  if (typeof value === 'string') return value
  if (value instanceof Uint8Array) {
    return new TextDecoder('utf-8', { fatal: false }).decode(value.subarray(0, MAX_ERROR_PAYLOAD_BYTES))
  }
  return ''
}

function balancedJsonObject(text: string, start: number): string | undefined {
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) return text.slice(start, i + 1)
    }
  }
  return undefined
}

function extractValidationUrl(text: string): string | undefined {
  for (const match of text.matchAll(ERROR_JSON_START_RE)) {
    const rawJson = balancedJsonObject(text, match.index ?? 0)
    if (rawJson === undefined) continue
    try {
      const parsed = JSON.parse(rawJson) as {
        error?: { code?: unknown; status?: unknown; details?: unknown }
      }
      const err = parsed.error
      if (err?.code !== 403 || err?.status !== 'PERMISSION_DENIED' || !Array.isArray(err.details)) continue
      for (const detail of err.details) {
        if (typeof detail !== 'object' || detail === null) continue
        const row = detail as { reason?: unknown; metadata?: { validation_url?: unknown } | null }
        if (row.reason === 'VALIDATION_REQUIRED') {
          const url = row.metadata?.validation_url
          return typeof url === 'string' && /^https?:\/\//i.test(url) ? url : ''
        }
      }
    } catch {
      // Ignore malformed JSON substrings embedded in protobuf bytes.
    }
  }
  return undefined
}

function parseDurationMs(delay: string): number | undefined {
  let total = 0
  let matched = false
  for (const part of delay.matchAll(GO_DURATION_PART_RE)) {
    const amount = Number(part[1])
    const unit = part[2] ?? ''
    const mult = GO_DURATION_UNIT_MS[unit]
    if (Number.isFinite(amount) && mult !== undefined) {
      total += amount * mult
      matched = true
    }
  }
  return matched && total > 0 ? total : undefined
}

function extractResetInfo(text: string, nowMs: number): { resetDelay?: string; resetAtIso?: string } {
  const ts = RESET_TIMESTAMP_RE.exec(text)?.[1]
  if (ts !== undefined) {
    const parsed = Date.parse(ts)
    if (Number.isFinite(parsed)) return { resetAtIso: new Date(parsed).toISOString() }
  }
  const delay = RESET_DELAY_RE.exec(text)?.[1] ?? RETRY_DELAY_RE.exec(text)?.[1] ?? RESETS_IN_RE.exec(text)?.[1]
  if (delay === undefined) return {}
  const ms = parseDurationMs(delay)
  return ms === undefined
    ? { resetDelay: delay }
    : { resetDelay: delay, resetAtIso: new Date(nowMs + ms).toISOString() }
}

function extractCleanText(raw: string): string {
  // Collapse control bytes / protobuf delimiters into spaces while keeping readable segments.
  const segments = raw
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\uFFFD]+/g, '\n')
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length >= 8 && /[A-Za-z0-9]/.test(line))
  return segments.slice(0, 4).join(' ').slice(0, 400).trim()
}

/** Pure classifier for decoded `step_type = 17` error payload text. */
export function classifyAgyErrorText(raw: string, idx: number, nowMs: number = Date.now()): AgyDbStepFailure | undefined {
  if (raw.trim() === '') return undefined
  const apiMatch = API_ERROR_RE.exec(raw)
  const statusMatch = apiMatch === null ? STATUS_ERROR_RE.exec(raw) : null
  const statusCode = apiMatch !== null
    ? Number(apiMatch[1])
    : statusMatch !== null
      ? Number(statusMatch[2])
      : undefined
  const apiMessage = apiMatch !== null
    ? apiMatch[2]?.trim()
    : statusMatch !== null
      ? statusMatch[3]?.trim()
      : undefined
  const statusName = apiMatch !== null
    ? apiMatch[3]?.trim()
    : statusMatch !== null
      ? statusMatch[1]?.trim()
      : undefined

  if (QUOTA_EXHAUSTED_RE.test(raw) || statusCode === 429) {
    const { resetDelay, resetAtIso } = extractResetInfo(raw, nowMs)
    const base = apiMessage !== undefined && apiMessage !== ''
      ? apiMessage
      : 'You have reached your Antigravity quota for this period.'
    const hasResetInText = /\bResets in\b/i.test(base)
    const resetSuffix = resetDelay !== undefined && !hasResetInText
      ? ` Resets in ${resetDelay}`
      : resetAtIso !== undefined && !hasResetInText
        ? ` Resets at ${resetAtIso}`
        : ''
    return {
      idx,
      kind: 'quota',
      message: `${base}${resetSuffix}`.trim(),
      ...(statusCode === undefined ? {} : { statusCode }),
      ...(statusName === undefined ? {} : { statusName }),
      ...(resetDelay === undefined ? {} : { resetDelay }),
      ...(resetAtIso === undefined ? {} : { resetAtIso }),
    }
  }

  const validationUrl = extractValidationUrl(raw)
  if (validationUrl !== undefined) {
    return {
      idx,
      kind: 'validation',
      message: validationUrl !== ''
        ? `Account verification is required before continuing: ${validationUrl}`
        : 'Account verification is required before continuing.',
      statusCode: 403,
      statusName: 'VALIDATION_REQUIRED',
      ...(validationUrl === '' ? {} : { validationUrl }),
    }
  }

  if (INVALID_THINKING_SIG_RE.test(raw)) {
    return {
      idx,
      kind: 'thinking_signature',
      message: 'Session history carries an invalid thinking block signature (INVALID_THINKING_SIGNATURE); start a fresh session to continue.',
      statusCode,
      statusName: 'INVALID_THINKING_SIGNATURE',
    }
  }

  if (apiMessage !== undefined && apiMessage !== '') {
    const prefix = statusName !== undefined ? `${statusName}${statusCode !== undefined ? ` (${String(statusCode)})` : ''}: ` : ''
    return {
      idx,
      kind: 'api_error',
      message: `${prefix}${apiMessage}`.slice(0, 500),
      ...(statusCode === undefined ? {} : { statusCode }),
      ...(statusName === undefined ? {} : { statusName }),
    }
  }

  const fallback = extractCleanText(raw)
  if (fallback === '') return undefined
  return { idx, kind: 'api_error', message: fallback }
}

/**
 * Inspect newly written error steps (`idx > baselineIdx` and `step_type = 17`)
 * in Antigravity's read-only SQLite session log.
 */
export function readAgyDbErrorAfter(
  storeRoot: string,
  acpSessionId: string,
  baselineIdx: number,
  nowMs: number = Date.now(),
): AgyDbStepFailure | undefined {
  return withReadOnlyStepsDb(storeRoot, acpSessionId, db => {
    const row = db.prepare(
      `SELECT idx, substr(error_details, 1, ?) AS errorDetails, substr(step_payload, 1, ?) AS stepPayload
       FROM steps
       WHERE idx > ? AND step_type = ?
       ORDER BY idx DESC
       LIMIT 1`,
    ).get(MAX_ERROR_PAYLOAD_BYTES, MAX_ERROR_PAYLOAD_BYTES, baselineIdx, AGY_STEP_ERROR_MESSAGE)
    if (row === undefined || typeof row.idx !== 'number') return undefined
    const combined = [decodeBlob(row.errorDetails), decodeBlob(row.stepPayload)].filter(Boolean).join('\n')
    return classifyAgyErrorText(combined, row.idx, nowMs)
  })
}
