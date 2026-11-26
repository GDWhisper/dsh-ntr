import { Buffer } from 'node:buffer'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterAll, describe, expect, it } from 'vitest'
import {
  AGY_STEP_ERROR_MESSAGE,
  classifyAgyErrorText,
  readAgyDbErrorAfter,
  readAgyDbLastStepIndex,
  resolveAgyDbPath,
} from '../../src/bridge/agy-session-db.ts'

const root = mkdtempSync(join(tmpdir(), 'dsh-ntr-agydb-'))
const convDir = join(root, 'conversations')
mkdirSync(convDir, { recursive: true })

function makeStepsDb(sessionId: string, rows: Array<{ idx: number; stepType: number; errorDetails?: Uint8Array | null; stepPayload?: Uint8Array | null }>): void {
  const dbPath = join(convDir, `${sessionId}.db`)
  const db = new DatabaseSync(dbPath)
  try {
    db.exec('CREATE TABLE IF NOT EXISTS steps (idx INTEGER PRIMARY KEY, step_type INTEGER, status INTEGER, error_details BLOB, step_payload BLOB)')
    const stmt = db.prepare('INSERT INTO steps (idx, step_type, status, error_details, step_payload) VALUES (?, ?, ?, ?, ?)')
    for (const row of rows) {
      stmt.run(row.idx, row.stepType, 0, row.errorDetails ?? null, row.stepPayload ?? null)
    }
  } finally {
    db.close()
  }
}

describe('agy-session-db read-only parser & guards', () => {
  afterAll(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('rejects traversal session ids, missing files, and symlinks', () => {
    expect(resolveAgyDbPath(root, '../escape')).toBeUndefined()
    expect(resolveAgyDbPath(root, 'a/b')).toBeUndefined()
    expect(readAgyDbLastStepIndex(root, 'missing-session')).toBeUndefined()

    makeStepsDb('target-real', [])
    const linkPath = join(convDir, 'link-session.db')
    let symlinkCreated = false
    try {
      symlinkSync(join(convDir, 'target-real.db'), linkPath)
      symlinkCreated = true
    } catch {
      // Unprivileged Windows environments may disallow file symlinks without Developer Mode.
    }
    if (symlinkCreated) {
      expect(resolveAgyDbPath(root, 'link-session')).toBeUndefined()
    }
  })

  it('reads empty and populated step baselines without mutating the DB', () => {
    makeStepsDb('empty-sess', [])
    expect(readAgyDbLastStepIndex(root, 'empty-sess')).toBe(-1)

    makeStepsDb('pop-sess', [
      { idx: 0, stepType: 14, stepPayload: Buffer.from('user input') },
      { idx: 3, stepType: 15, stepPayload: Buffer.from('planner') },
    ])
    expect(readAgyDbLastStepIndex(root, 'pop-sess')).toBe(3)
    expect(readAgyDbErrorAfter(root, 'pop-sess', 3)).toBeUndefined()
  })

  it('decodes step_type=17 protobuf payloads for quota, validation, thinking signature, and API errors', () => {
    const quotaPayload = Buffer.concat([
      Buffer.from([0x0a, 0x70]),
      Buffer.from('RESOURCE_EXHAUSTED (code 429): Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 2h23m11s.'),
    ])
    makeStepsDb('quota-sess', [
      { idx: 0, stepType: 14, stepPayload: Buffer.from('user') },
      { idx: 1, stepType: AGY_STEP_ERROR_MESSAGE, errorDetails: null, stepPayload: quotaPayload },
    ])
    const quota = readAgyDbErrorAfter(root, 'quota-sess', 0, Date.UTC(2026, 0, 1, 0, 0, 0))
    expect(quota).toMatchObject({
      idx: 1,
      kind: 'quota',
      statusCode: 429,
      statusName: 'RESOURCE_EXHAUSTED',
      resetDelay: '2h23m11s',
    })
    expect(quota?.message).toContain('Individual quota reached')
    expect(quota?.message).toContain('Resets in 2h23m11s')

    const validationJson = JSON.stringify({
      error: {
        code: 403,
        status: 'PERMISSION_DENIED',
        details: [{
          '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
          domain: 'cloudcode-pa.googleapis.com',
          reason: 'VALIDATION_REQUIRED',
          metadata: { validation_url: 'https://accounts.google.com/verify?token=abc' },
        }],
      },
    })
    const validation = classifyAgyErrorText(`\u000a\u0020${validationJson}`, 2)
    expect(validation).toMatchObject({
      idx: 2,
      kind: 'validation',
      statusCode: 403,
      validationUrl: 'https://accounts.google.com/verify?token=abc',
    })

    const sig = classifyAgyErrorText('messages.2.content.0.thinking.signature: Field required', 4)
    expect(sig?.kind).toBe('thinking_signature')

    const api = classifyAgyErrorText('Error 502, Message: Upstream gateway timeout, Status: 502 Bad Gateway', 5)
    expect(api).toMatchObject({ kind: 'api_error', statusCode: 502 })
    expect(api?.message).toContain('Upstream gateway timeout')
  })

  it('fails open on corrupt DB files and missing steps tables', () => {
    writeFileSync(join(convDir, 'corrupt-sess.db'), 'not a sqlite file')
    expect(readAgyDbLastStepIndex(root, 'corrupt-sess')).toBeUndefined()
    expect(readAgyDbErrorAfter(root, 'corrupt-sess', -1)).toBeUndefined()

    const noSteps = new DatabaseSync(join(convDir, 'nosteps-sess.db'))
    noSteps.exec('CREATE TABLE other (x INT)')
    noSteps.close()
    expect(readAgyDbLastStepIndex(root, 'nosteps-sess')).toBeUndefined()
  })
})
