import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { BridgeManager } from '../../src/bridge.ts'
import { EventHub, validateAgentDef } from '../../src/impl.ts'
import {
  effectiveWriteTextFileEnabled,
  isAntigravityCommand,
  type AcpAgentDef,
  type StreamChunk,
} from '../../src/protocol.ts'
import { buildPayload, initialForm, payloadEquals } from '../../src/client/panel/form.ts'

const workDir = mkdtempSync(join(tmpdir(), 'dsh-ntr-writecap-'))
const agyShimPath = join(workDir, 'agy.mjs')

writeFileSync(agyShimPath, `
import { Readable, Writable } from 'node:stream'
import { AgentSideConnection, PROTOCOL_VERSION, ndJsonStream } from ${JSON.stringify(new URL('../../node_modules/@agentclientprotocol/sdk/dist/acp.js', import.meta.url).href)}

let seenFsCaps = null
let activeConn = null
const conn = new AgentSideConnection(agentConn => {
  activeConn = agentConn
  return {
    async initialize(params) {
      seenFsCaps = params.clientCapabilities?.fs ?? null
      return { protocolVersion: PROTOCOL_VERSION, agentCapabilities: { loadSession: true } }
    },
    async newSession() {
      return { sessionId: 'acp-wc-1', configOptions: [] }
    },
    async prompt(params) {
      let writeRejected = false
      try {
        await activeConn.writeTextFile({ sessionId: params.sessionId, path: ${JSON.stringify(join(workDir, 'probe.txt'))}, content: 'hi' })
      } catch {
        writeRejected = true
      }
      await agentConn.sessionUpdate({
        sessionId: params.sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: JSON.stringify({ fs: seenFsCaps, writeRejected }) },
        },
      })
      return { stopReason: 'end_turn' }
    },
    async cancel() {},
  }
}, ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)))
void conn
`, 'utf8')

async function collectText(stream: AsyncIterable<StreamChunk>): Promise<string> {
  let out = ''
  for await (const chunk of stream) {
    if (chunk.type === 'text-delta') out += chunk.text
  }
  return out
}

describe('fs.writeTextFile Antigravity default and explicit override', () => {
  const hub = new EventHub()
  const agyDefaultDef: AcpAgentDef = {
    id: 'agy-default',
    command: 'agy',
    args: ['acp'],
    cwd: workDir,
    allowedCwdRoots: [workDir],
  }
  const genericDef: AcpAgentDef = {
    id: 'generic',
    command: 'codebuddy',
    args: ['--acp'],
    cwd: workDir,
    allowedCwdRoots: [workDir],
  }

  // Test the bridge wiring by matching `isAntigravityCommand` with `command: 'agy'` vs override on our shim.
  const shimDefaultOff: AcpAgentDef = {
    id: 'shim-off',
    command: process.execPath,
    args: [agyShimPath],
    cwd: workDir,
    allowedCwdRoots: [workDir],
    writeTextFileEnabled: false,
  }
  const shimOverrideOn: AcpAgentDef = {
    id: 'shim-on',
    command: process.execPath,
    args: [agyShimPath],
    cwd: workDir,
    allowedCwdRoots: [workDir],
    writeTextFileEnabled: true,
  }
  const manager = new BridgeManager([shimDefaultOff, shimOverrideOn], hub, 500)

  afterAll(async () => {
    await manager.shutdownAll()
    rmSync(workDir, { recursive: true, force: true })
  })

  it('defaults writeTextFile to false for agy acp and true for generic agents, with explicit override', () => {
    expect(isAntigravityCommand(agyDefaultDef)).toBe(true)
    expect(effectiveWriteTextFileEnabled(agyDefaultDef)).toBe(false)
    expect(effectiveWriteTextFileEnabled({ ...agyDefaultDef, writeTextFileEnabled: true })).toBe(true)

    expect(isAntigravityCommand(genericDef)).toBe(false)
    expect(effectiveWriteTextFileEnabled(genericDef)).toBe(true)
    expect(effectiveWriteTextFileEnabled({ ...genericDef, writeTextFileEnabled: false })).toBe(false)
  })

  it('validates and round-trips writeTextFileEnabled through validateAgentDef and panel form', () => {
    const clean = validateAgentDef({ id: 'agy', command: 'agy acp', cwd: workDir })
    expect(clean.writeTextFileEnabled).toBeUndefined()

    const forcedOn = validateAgentDef({ id: 'agy', command: 'agy acp', cwd: workDir, writeTextFileEnabled: true })
    expect(forcedOn.writeTextFileEnabled).toBe(true)

    const detected = {
      id: 'agy',
      name: 'Antigravity',
      detected: true,
      defaultCommand: 'agy',
      defaultArgs: ['acp'],
      currentConfig: forcedOn,
    }
    const form = initialForm(detected, undefined)
    expect(form.writeTextFileMode).toBe('enabled')
    const payload = buildPayload(form, detected, false)
    expect(payload.writeTextFileEnabled).toBe(true)
    expect(payloadEquals(payload, forcedOn)).toBe(true)

    const backToDefault = buildPayload({ ...form, writeTextFileMode: 'default' }, detected, false)
    expect(backToDefault.writeTextFileEnabled).toBeUndefined()
    expect(payloadEquals(backToDefault, forcedOn)).toBe(false)
  })

  it('omits writeTextFile handler and advertises writeTextFile=false when disabled on BridgeManager', async () => {
    const offRaw = await collectText(manager.streamPrompt({
      model: 'shim-off',
      sessionId: 'dsh-wc-off',
      messages: [{ role: 'user', content: 'test off', source: { kind: 'user' } }],
    }))
    const offResult = JSON.parse(offRaw) as { fs: { readTextFile?: boolean; writeTextFile?: boolean }; writeRejected: boolean }
    expect(offResult.fs).toEqual({ readTextFile: true, writeTextFile: false })
    expect(offResult.writeRejected).toBe(true)

    const onRaw = await collectText(manager.streamPrompt({
      model: 'shim-on',
      sessionId: 'dsh-wc-on',
      messages: [{ role: 'user', content: 'test on', source: { kind: 'user' } }],
    }))
    const onResult = JSON.parse(onRaw) as { fs: { readTextFile?: boolean; writeTextFile?: boolean }; writeRejected: boolean }
    expect(onResult.fs).toEqual({ readTextFile: true, writeTextFile: true })
    expect(onResult.writeRejected).toBe(false)
  })
})
