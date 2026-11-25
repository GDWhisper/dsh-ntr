/**
 * Bridge-level ACP elicitation tests: verifies `handleBridgeElicitationRequest`
 * lifecycle (broadcast, response, abort cancellation, unsupported mode) and a
 * real stdio JSON-RPC round-trip proving `AgentBridge` advertises
 * `clientCapabilities.elicitation.form = {}` and resolves `elicitation/create`
 * through `BridgeManager.respondElicitation`.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { BridgeManager } from '../../src/bridge.ts'
import { handleBridgeElicitationRequest } from '../../src/bridge/elicitation-bridge.ts'
import type { LiveSession } from '../../src/bridge/turn-stream.ts'
import { ElicitationLedger, EventHub } from '../../src/impl.ts'
import type { AcpAgentDef, AcpEvent } from '../../src/protocol.ts'
import { settleTranscript } from './harness.ts'

const tempDirs: string[] = []
afterEach(async () => {
  while (tempDirs.length > 0) {
    await removeTempDir(tempDirs.pop()!)
  }
})

/**
 * On Windows the mock agent can still hold the temp dir as its cwd for a moment
 * after `stopAgent` (teardown kills are fire-and-forget), so rmdir fails with
 * EPERM until the child is gone. Retry briefly instead of failing the suite.
 */
async function removeTempDir(dir: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      rmSync(dir, { recursive: true, force: true })
      return
    } catch (error) {
      if (attempt >= 50) throw error
      await new Promise(resolve => setTimeout(resolve, 100))
    }
  }
}

function fakeSession(overrides: Partial<LiveSession> = {}): LiveSession {
  return {
    sessionId: 'host-s1',
    acpSessionId: 'acp-s1',
    dshSessionId: 'dsh-s1',
    lifecycle: 'live',
    lastAgentActivityAt: 0,
    ...overrides,
  } as unknown as LiveSession
}

describe('handleBridgeElicitationRequest', () => {
  it('broadcasts elicitation/request, resolves on ledger answer, and broadcasts elicitation/resolved', async () => {
    const hub = new EventHub()
    const elicitations = new ElicitationLedger()
    const events: AcpEvent[] = []
    hub.subscribe(e => { events.push(e) })
    const session = fakeSession()
    let touched = 0

    const pending = handleBridgeElicitationRequest(
      {
        agentId: 'mock-agent',
        elicitationTimeoutMs: 0,
        hub,
        elicitations,
        sessionByAcpId: id => (id === 'acp-s1' ? session : undefined),
        touch: () => { touched += 1 },
      },
      {
        mode: 'form',
        sessionId: 'acp-s1',
        message: 'Choose mode',
        requestedSchema: {
          type: 'object',
          required: ['mode'],
          properties: {
            mode: { type: 'string', title: 'Mode', enum: ['fast', 'safe'] },
          },
        },
      },
    )

    const req = events.find((e): e is Extract<AcpEvent, { type: 'elicitation/request' }> => e.type === 'elicitation/request')
    expect(req).toBeDefined()
    expect(req?.dshSessionId).toBe('dsh-s1')
    expect(req?.deadlineAt).toBeUndefined()
    expect(req?.fields[0]?.kind).toBe('single-select')

    elicitations.respond(req!.requestId, { action: 'accept', content: { mode: 'safe' } })
    const result = await pending
    expect(result).toEqual({ action: 'accept', content: { mode: 'safe' } })
    expect(touched).toBe(1)
    expect(events.some(e => e.type === 'elicitation/resolved' && e.requestId === req!.requestId && e.action === 'accept')).toBe(true)
  })

  it('settles cancelled when the ACP request AbortSignal fires', async () => {
    const hub = new EventHub()
    const elicitations = new ElicitationLedger()
    const events: AcpEvent[] = []
    hub.subscribe(e => { events.push(e) })
    const session = fakeSession()
    const ac = new AbortController()

    const pending = handleBridgeElicitationRequest(
      { agentId: 'mock-agent', elicitationTimeoutMs: 300_000, hub, elicitations, sessionByAcpId: () => session, touch: () => undefined },
      {
        mode: 'form',
        sessionId: 'acp-s1',
        message: 'Withdrawn question',
        requestedSchema: { type: 'object', properties: {} },
      },
      ac.signal,
    )

    expect(elicitations.pendingViews()).toHaveLength(1)
    ac.abort()
    const result = await pending
    expect(result).toEqual({ action: 'cancel' })
    expect(elicitations.pendingViews()).toHaveLength(0)
    expect(events.some(e => e.type === 'elicitation/resolved' && e.action === 'cancel')).toBe(true)
  })

  it('cancels unsupported URL elicitation mode and unknown sessions', async () => {
    const hub = new EventHub()
    const elicitations = new ElicitationLedger()
    const host = {
      agentId: 'mock-agent',
      elicitationTimeoutMs: 300_000,
      hub,
      elicitations,
      sessionByAcpId: () => undefined,
      touch: () => undefined,
    }

    const urlRes = await handleBridgeElicitationRequest(host, {
      mode: 'url',
      sessionId: 'acp-s1',
      elicitationId: 'e-url',
      url: 'https://example.test/auth',
      message: 'Open URL',
    })
    expect(urlRes).toEqual({ action: 'cancel' })

    const unknownRes = await handleBridgeElicitationRequest(host, {
      mode: 'form',
      sessionId: 'missing',
      message: 'Hello?',
      requestedSchema: { type: 'object', properties: {} },
    })
    expect(unknownRes).toEqual({ action: 'cancel' })
  })

  it('cancels and broadcasts agent/notice + elicitation/resolved when elicitationTimeoutMs expires', async () => {
    const hub = new EventHub()
    const elicitations = new ElicitationLedger()
    const events: AcpEvent[] = []
    hub.subscribe(e => { events.push(e) })
    const session = fakeSession()

    const pending = handleBridgeElicitationRequest(
      {
        agentId: 'mock-agent',
        elicitationTimeoutMs: 40,
        hub,
        elicitations,
        sessionByAcpId: () => session,
        touch: () => undefined,
      },
      {
        mode: 'form',
        sessionId: 'acp-s1',
        message: 'Timed question',
        requestedSchema: { type: 'object', properties: {} },
      },
    )

    const req = events.find((e): e is Extract<AcpEvent, { type: 'elicitation/request' }> => e.type === 'elicitation/request')
    expect(req?.deadlineAt).toBeTypeOf('number')

    const result = await pending
    expect(result).toEqual({ action: 'cancel' })
    expect(elicitations.pendingViews()).toHaveLength(0)
    expect(events.some(e => e.type === 'elicitation/resolved' && e.requestId === req!.requestId && e.action === 'cancel')).toBe(true)
    const notice = events.find((e): e is Extract<AcpEvent, { type: 'agent/notice' }> => e.type === 'agent/notice')
    expect(notice).toMatchObject({ agentId: 'mock-agent', level: 'info' })
    expect(notice?.text).toContain('timed out')
    expect(notice?.text).toContain('cancelled')
  })
})

describe('End-to-end stdio ACP elicitation round-trip', () => {
  it('advertises elicitation.form and delivers user answers back to the agent', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-ntr-elicit-'))
    tempDirs.push(dir)
    const agentPath = join(dir, 'elicit-agent.mjs')
    writeFileSync(agentPath, `
import readline from 'node:readline'

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })
rl.on('close', () => process.exit(0))
process.on('SIGTERM', () => process.exit(0))
let seenFormCap = false
let nextReqId = 100
const waiters = new Map()

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\\n')
}

rl.on('line', line => {
  if (!line.trim()) return
  const msg = JSON.parse(line)
  if (msg.id !== undefined && msg.method === undefined) {
    const w = waiters.get(msg.id)
    if (w) { waiters.delete(msg.id); w(msg.result) }
    return
  }
  if (msg.method === 'initialize') {
    seenFormCap = msg.params?.clientCapabilities?.elicitation?.form != null
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        protocolVersion: 1,
        agentInfo: { name: 'elicit-mock', version: '1.0.0' },
        agentCapabilities: { loadSession: false },
      },
    })
    return
  }
  if (msg.method === 'session/new') {
    send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'acp-elicit-1' } })
    return
  }
  if (msg.method === 'session/close') {
    send({ jsonrpc: '2.0', id: msg.id, result: {} })
    return
  }
  if (msg.method === 'session/prompt') {
    const reqId = nextReqId++
    waiters.set(reqId, result => {
      const answer = result?.action === 'accept' ? result.content?.choice : result?.action
      send({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: 'acp-elicit-1',
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'cap=' + String(seenFormCap) + ',answer=' + String(answer) },
          },
        },
      })
      send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } })
    })
    send({
      jsonrpc: '2.0',
      id: reqId,
      method: 'elicitation/create',
      params: {
        mode: 'form',
        sessionId: 'acp-elicit-1',
        message: 'Which option?',
        requestedSchema: {
          type: 'object',
          required: ['choice'],
          properties: {
            choice: {
              type: 'string',
              title: 'Choice',
              oneOf: [
                { const: 'opt_a', title: 'Option A' },
                { const: 'opt_b', title: 'Option B' },
              ],
            },
          },
        },
      },
    })
  }
})
`, 'utf8')

    const def: AcpAgentDef = {
      id: 'elicit-mock',
      title: 'Elicit Mock',
      command: process.execPath,
      args: [agentPath],
      env: {},
      cwd: dir,
      allowedCwdRoots: [dir],
    }
    const hub = new EventHub()
    const events: AcpEvent[] = []
    hub.subscribe(e => { events.push(e) })
    const manager = new BridgeManager([def], hub, 500)

    try {
      const { sessionId } = await manager.startSession('elicit-mock', dir)
      const askPromise = new Promise<Extract<AcpEvent, { type: 'elicitation/request' }>>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('timeout waiting for elicitation/request')), 10_000)
        const unsub = hub.subscribe(e => {
          if (e.type === 'elicitation/request') {
            clearTimeout(timer)
            unsub()
            resolve(e)
          }
        })
      })

      const promptPromise = manager.prompt(sessionId, 'ask me')
      const ask = await askPromise
      expect(ask.message).toBe('Which option?')
      expect(manager.pendingElicitationViews()).toHaveLength(1)

      manager.respondElicitation(ask.requestId, { action: 'accept', content: { choice: 'opt_b' } })
      await promptPromise

      const endPromise = new Promise<void>((resolve, reject) => {
        if (events.some(e => e.type === 'turn/end' && e.sessionId === sessionId)) {
          resolve()
          return
        }
        const timer = setTimeout(() => reject(new Error('timeout waiting for turn/end')), 10_000)
        const unsub = hub.subscribe(e => {
          if (e.type === 'turn/end' && e.sessionId === sessionId) {
            clearTimeout(timer)
            unsub()
            resolve()
          }
        })
      })
      await endPromise
      await settleTranscript(manager, sessionId)

      const tx = manager.transcript(sessionId, 0)
      const text = tx.entries
        .map(e => (e.update as { content?: { text?: string } })?.content?.text ?? '')
        .join('')
      expect(text).toContain('cap=true,answer=opt_b')
      expect(manager.pendingElicitationViews()).toHaveLength(0)
    } finally {
      await manager.stopAgent('elicit-mock')
    }
  }, 15_000)
})
