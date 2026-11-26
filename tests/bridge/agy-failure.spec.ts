import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterAll, describe, expect, it } from 'vitest'
import { BridgeManager } from '../../src/bridge.ts'
import { EventHub, dispatchRpc } from '../../src/impl.ts'
import type { AcpAgentDef, AcpEvent, ChatSessionView, StreamChunk } from '../../src/protocol.ts'

const workDir = mkdtempSync(join(tmpdir(), 'dsh-ntr-agyfail-'))
const storeRoot = join(workDir, 'store')
const convDir = join(storeRoot, 'conversations')
mkdirSync(convDir, { recursive: true })

const mockPath = join(workDir, 'agy-failure-mock.mjs')
const sdkUrl = new URL('../../node_modules/@agentclientprotocol/sdk/dist/acp.js', import.meta.url).href

writeFileSync(mockPath, `
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { Readable, Writable } from 'node:stream'
import { AgentSideConnection, PROTOCOL_VERSION, ndJsonStream } from ${JSON.stringify(sdkUrl)}

const convDir = ${JSON.stringify(convDir)}
let seq = 0

function appendErrorStep(acpSessionId, text) {
  const db = new DatabaseSync(join(convDir, acpSessionId + '.db'))
  try {
    db.exec('CREATE TABLE IF NOT EXISTS steps (idx INTEGER PRIMARY KEY, step_type INTEGER, status INTEGER, error_details BLOB, step_payload BLOB)')
    const maxRow = db.prepare('SELECT max(idx) AS m FROM steps').get()
    const nextIdx = typeof maxRow?.m === 'number' ? maxRow.m + 1 : 0
    db.prepare('INSERT INTO steps (idx, step_type, status, error_details, step_payload) VALUES (?, 17, 0, NULL, ?)').run(nextIdx, Buffer.from(text))
  } finally {
    db.close()
  }
}

const conn = new AgentSideConnection(agentConn => ({
  async initialize() {
    return { protocolVersion: PROTOCOL_VERSION, agentCapabilities: { loadSession: true } }
  },
  async newSession() {
    seq += 1
    return { sessionId: 'acp-fail-' + String(seq), configOptions: [] }
  },
  async prompt(params) {
    const text = (params.prompt ?? []).map(p => (p && typeof p.text === 'string' ? p.text : '')).join('')
    if (text === 'trigger-quota') {
      appendErrorStep(params.sessionId, 'RESOURCE_EXHAUSTED (code 429): Individual quota reached. Resets in 1h15m.')
      return { stopReason: 'end_turn' }
    }
    if (text === 'trigger-validation') {
      appendErrorStep(params.sessionId, JSON.stringify({
        error: {
          code: 403,
          status: 'PERMISSION_DENIED',
          details: [{
            '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
            reason: 'VALIDATION_REQUIRED',
            metadata: { validation_url: 'https://accounts.google.com/verify/123' },
          }],
        },
      }))
      return { stopReason: 'end_turn' }
    }
    await agentConn.sessionUpdate({
      sessionId: params.sessionId,
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Recovered answer' } },
    })
    return { stopReason: 'end_turn' }
  },
  async cancel() {},
}), ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)))
void conn
`, 'utf8')

const agyDef: AcpAgentDef = {
  id: 'agy-mock',
  title: 'AGY Mock',
  command: process.execPath,
  args: [mockPath],
  cwd: workDir,
  allowedCwdRoots: [workDir],
}

async function drainStream(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

describe('Antigravity DB-backed structured failure & QuotaBanner integration', () => {
  const hub = new EventHub()
  const events: AcpEvent[] = []
  hub.subscribe(event => { events.push(event) })
  const manager = new BridgeManager(
    [agyDef],
    hub,
    500,
    undefined,
    undefined,
    false,
    undefined,
    { isAgent: () => true, storeRoot: () => storeRoot },
  )

  afterAll(async () => {
    await manager.shutdownAll()
    rmSync(workDir, { recursive: true, force: true })
  })

  it('keeps first-turn session alive with QuotaBanner on DB 429 refusal and clears it on next reply', async () => {
    const mark = events.length
    const chunks = await drainStream(manager.streamPrompt({
      model: 'agy-mock',
      sessionId: 'dsh-quota-first',
      messages: [{ role: 'user', content: 'trigger-quota', source: { kind: 'user' } }],
    }))

    const finish = chunks.find(c => c.type === 'finish') as Extract<StreamChunk, { type: 'finish' }> | undefined
    expect(finish?.reason.kind).toBe('error')

    const slice = events.slice(mark)
    const turnEnd = slice.find(e => e.type === 'turn/end') as Extract<AcpEvent, { type: 'turn/end' }> | undefined
    expect(turnEnd?.errorKind).toBe('quota')
    expect(turnEnd?.error).toContain('Individual quota reached')
    expect(turnEnd?.error).toContain('Resets in 1h15m')

    // Design ruling A3: first-turn quota refusal MUST NOT rollback provisional lock!
    expect(slice.some(e => e.type === 'chat/agent-unlocked')).toBe(false)

    const metaWithQuota = [...slice].reverse().find(e => e.type === 'session/meta') as Extract<AcpEvent, { type: 'session/meta' }> | undefined
    expect(metaWithQuota?.session.quotaRefusal?.message).toContain('Individual quota reached')

    const chatRows = await dispatchRpc(manager, 'session/chat-list', { dshSessionId: 'dsh-quota-first' })
    expect(chatRows.ok).toBe(true)
    const rows = (chatRows.value as { sessions: ChatSessionView[] }).sessions
    expect(rows).toHaveLength(1)
    expect(rows[0]?.closed).not.toBe(true)
    expect(rows[0]?.released).not.toBe(true)

    // Subsequent successful turn answers cleanly and clears quotaRefusal.
    const mark2 = events.length
    const okChunks = await drainStream(manager.streamPrompt({
      model: 'agy-mock',
      sessionId: 'dsh-quota-first',
      messages: [{ role: 'user', content: 'hello again', source: { kind: 'user' } }],
    }))
    const text = okChunks.filter(c => c.type === 'text-delta').map(c => (c as { text: string }).text).join('')
    expect(text).toBe('Recovered answer')
    const metaCleared = [...events.slice(mark2)].reverse().find(e => e.type === 'session/meta') as Extract<AcpEvent, { type: 'session/meta' }> | undefined
    expect(metaCleared?.session.quotaRefusal).toBeUndefined()
  })

  it('surfaces VALIDATION_REQUIRED notice and URL on DB 403 step', async () => {
    const mark = events.length
    const chunks = await drainStream(manager.streamPrompt({
      model: 'agy-mock',
      sessionId: 'dsh-val-1',
      messages: [{ role: 'user', content: 'trigger-validation', source: { kind: 'user' } }],
    }))
    const finish = chunks.find(c => c.type === 'finish') as Extract<StreamChunk, { type: 'finish' }> | undefined
    expect(finish?.reason.kind).toBe('error')
    const notice = events.slice(mark).find(e => e.type === 'agent/notice') as Extract<AcpEvent, { type: 'agent/notice' }> | undefined
    expect(notice?.level).toBe('error')
    expect(notice?.text).toContain('https://accounts.google.com/verify/123')
  })

  it('surfaces quotaRefusal and errorKind=quota symmetrically on /acp RPC prompt path', async () => {
    const started = await dispatchRpc(manager, 'session/start', { agentId: 'agy-mock', cwd: workDir })
    expect(started.ok).toBe(true)
    const sessionId = (started.value as { sessionId: string }).sessionId

    const mark = events.length
    const sent = await dispatchRpc(manager, 'session/prompt', { sessionId, text: 'trigger-quota' })
    expect(sent.ok).toBe(true)

    await new Promise<void>((resolve, reject) => {
      const deadline = Date.now() + 5000
      const check = (): void => {
        if (events.slice(mark).some(e => e.type === 'turn/end' && e.sessionId === sessionId)) {
          resolve()
          return
        }
        if (Date.now() > deadline) {
          reject(new Error('timeout waiting for /acp turn/end'))
          return
        }
        setTimeout(check, 20)
      }
      check()
    })

    const slice = events.slice(mark)
    const turnEnd = slice.find(e => e.type === 'turn/end' && e.sessionId === sessionId) as Extract<AcpEvent, { type: 'turn/end' }> | undefined
    expect(turnEnd?.errorKind).toBe('quota')
    expect(turnEnd?.error).toContain('Individual quota reached')

    const meta = [...slice].reverse().find(e => e.type === 'session/meta' && e.sessionId === sessionId) as Extract<AcpEvent, { type: 'session/meta' }> | undefined
    expect(meta?.session.quotaRefusal?.message).toContain('Individual quota reached')
  })
})
