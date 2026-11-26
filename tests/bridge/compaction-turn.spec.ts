import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { BridgeManager } from '../../src/bridge.ts'
import { EventHub } from '../../src/impl.ts'
import type { AcpAgentDef, AcpEvent, StreamChunk } from '../../src/protocol.ts'

const workDir = mkdtempSync(join(tmpdir(), 'dsh-ntr-compaction-'))
const mockPath = join(workDir, 'compaction-mock.mjs')

writeFileSync(mockPath, `
import { Readable, Writable } from 'node:stream'
import { AgentSideConnection, PROTOCOL_VERSION, ndJsonStream } from ${JSON.stringify(new URL('../../node_modules/@agentclientprotocol/sdk/dist/acp.js', import.meta.url).href)}

let seenClientCaps = null
const conn = new AgentSideConnection(agentConn => ({
  async initialize(params) {
    seenClientCaps = params.clientCapabilities ?? null
    return { protocolVersion: PROTOCOL_VERSION, agentCapabilities: { loadSession: true } }
  },
  async newSession() {
    return { sessionId: 'acp-cmp-1', configOptions: [] }
  },
  async prompt(params) {
    const text = (params.prompt ?? []).map(p => (p && typeof p.text === 'string' ? p.text : '')).join('')
    if (text === '/compact check-caps') {
      await agentConn.sessionUpdate({
        sessionId: params.sessionId,
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: JSON.stringify(seenClientCaps) } },
      })
      return { stopReason: 'end_turn' }
    }
    if (text === '/compact with-updates') {
      await agentConn.sessionUpdate({
        sessionId: params.sessionId,
        update: { sessionUpdate: 'compaction_update', compactionId: 'cmp-1', status: 'in_progress' },
      })
      await agentConn.sessionUpdate({
        sessionId: params.sessionId,
        update: { sessionUpdate: 'compaction_update', compactionId: 'cmp-1', status: 'completed', summary: [{ type: 'text', text: 'Kept context' }] },
      })
      return { stopReason: 'end_turn' }
    }
    if (text === '/compact') {
      await agentConn.sessionUpdate({
        sessionId: params.sessionId,
        update: { sessionUpdate: 'usage_update', used: 100, size: 1000 },
      })
      return { stopReason: 'end_turn' }
    }
    return { stopReason: 'end_turn' }
  },
  async cancel() {},
}), ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)))
void conn
`, 'utf8')

const agentDef: AcpAgentDef = {
  id: 'cmp-mock',
  title: 'Compaction Mock',
  command: process.execPath,
  args: [mockPath],
  cwd: workDir,
  allowedCwdRoots: [workDir],
}

async function collectText(stream: AsyncIterable<StreamChunk>): Promise<string> {
  let out = ''
  for await (const chunk of stream) {
    if (chunk.type === 'text-delta') out += chunk.text
  }
  return out
}

describe('compaction capability advertising and /compact zero-output handling', () => {
  const hub = new EventHub()
  const events: AcpEvent[] = []
  hub.subscribe(event => { events.push(event) })
  const manager = new BridgeManager([agentDef], hub, 500)

  afterAll(async () => {
    await manager.shutdownAll()
    rmSync(workDir, { recursive: true, force: true })
  })

  it('advertises session.compaction, renders compaction updates, and avoids false upstream errors on silent /compact', async () => {
    const capsOut = await collectText(manager.streamPrompt({
      model: 'cmp-mock',
      sessionId: 'dsh-cmp-1',
      messages: [{ role: 'user', content: '/compact check-caps', source: { kind: 'user' } }],
    }))
    const parsedCaps = JSON.parse(capsOut) as { session?: { compaction?: unknown; configOptions?: { boolean?: unknown } } }
    expect(parsedCaps.session?.compaction).toEqual({})
    expect(parsedCaps.session?.configOptions?.boolean).toEqual({})

    const updatesOut = await collectText(manager.streamPrompt({
      model: 'cmp-mock',
      sessionId: 'dsh-cmp-1',
      messages: [{ role: 'user', content: '/compact with-updates', source: { kind: 'user' } }],
    }))
    expect(updatesOut).toContain('context compaction completed')
    expect(updatesOut).toContain('Kept context')
    expect(updatesOut).not.toContain('upstream failures')

    const silentCompactOut = await collectText(manager.streamPrompt({
      model: 'cmp-mock',
      sessionId: 'dsh-cmp-1',
      messages: [{ role: 'user', content: '/compact', source: { kind: 'user' } }],
    }))
    expect(silentCompactOut).toContain('completed context compaction')
    expect(silentCompactOut).not.toContain('upstream failures')

    const silentNormalOut = await collectText(manager.streamPrompt({
      model: 'cmp-mock',
      sessionId: 'dsh-cmp-1',
      messages: [{ role: 'user', content: 'hello silently', source: { kind: 'user' } }],
    }))
    expect(silentNormalOut).toContain('ended the turn with no visible output')
    expect(silentNormalOut).toContain('upstream failures')
  })
})
