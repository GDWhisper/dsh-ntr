import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { AcpLlmAdapter, BridgeManager, routeBindingRegistry } from '../../src/bridge.ts'
import { EventHub } from '../../src/impl.ts'
import type { AcpAgentDef, AcpEvent } from '../../src/protocol.ts'

/**
 * Regression for pre-first-turn thought level reverting to the catalog default:
 * 1. CodeBuddy pushes `config_option_update` on `session/set_config_option`; that
 *    per-session push must go through `absorbCatalogShape`, never `absorbCatalog`,
 *    so it cannot promote `'max'` into `catalog.thought.currentValue` and make the
 *    driver-materialized `'high'` look like an explicit user override.
 * 2. Even when `session/new`, `session/load`, or a concurrent session changes
 *    `modelDefaultEffort` after `prepareCall` materialized `defaultEffort`,
 *    `streamPrompt` must compare `options.reasoningEffort` against the default
 *    captured at `prepareCall` (or before `getOrCreateDshSession`), never a post-boot read.
 */

const SDK_URL = pathToFileURL(join(process.cwd(), 'node_modules/@agentclientprotocol/sdk/dist/acp.js')).href

const PUSH_AGENT_SOURCE = `
import { appendFileSync } from 'node:fs'
import { Readable, Writable } from 'node:stream'
import { AgentSideConnection, PROTOCOL_VERSION, ndJsonStream } from ${JSON.stringify(SDK_URL)}

const defaultThought = process.env.PUSH_AGENT_NEW_THOUGHT || 'high'
const loadThought = process.env.PUSH_AGENT_LOAD_THOUGHT
const setLog = process.env.PUSH_AGENT_SET_LOG
const sessions = new Map()
let counter = 0

function optionsFor(s) {
  return [
    {
      configId: 'model',
      name: 'Model',
      category: 'model',
      type: 'select',
      currentValue: s.model,
      options: [
        { value: 'model-a', name: 'Model A' },
        { value: 'model-b', name: 'Model B' },
      ],
    },
    {
      configId: 'thought_level',
      name: 'Deep Thinking',
      category: 'thought_level',
      type: 'select',
      currentValue: s.thought,
      options: [
        { value: 'low', name: 'Low' },
        { value: 'high', name: 'High' },
        { value: 'max', name: 'Max' },
      ],
    },
  ]
}

const stream = ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin))
new AgentSideConnection(conn => ({
  async initialize() {
    return {
      protocolVersion: PROTOCOL_VERSION,
      agentCapabilities: { loadSession: true },
    }
  },
  async authenticate() { return {} },
  async newSession() {
    const sessionId = 'push-sess-' + (++counter)
    const state = { model: 'model-a', thought: defaultThought }
    sessions.set(sessionId, state)
    return { sessionId, configOptions: optionsFor(state) }
  },
  async loadSession(params) {
    const state = sessions.get(params.sessionId) || { model: 'model-a', thought: loadThought || defaultThought }
    if (loadThought) state.thought = loadThought
    sessions.set(params.sessionId, state)
    return { configOptions: optionsFor(state) }
  },
  async setSessionConfigOption(params) {
    const state = sessions.get(params.sessionId)
    if (!state) throw new Error('unknown session')
    if (setLog) appendFileSync(setLog, JSON.stringify({ configId: params.configId, value: params.value }) + '\\n')
    if (params.configId === 'model') state.model = String(params.value)
    if (params.configId === 'thought_level') state.thought = String(params.value)
    const configOptions = optionsFor(state)
    await conn.sessionUpdate({
      sessionId: params.sessionId,
      update: { sessionUpdate: 'config_option_update', configOptions },
    })
    return { configOptions }
  },
  async prompt(params) {
    const state = sessions.get(params.sessionId)
    await conn.sessionUpdate({
      sessionId: params.sessionId,
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'THOUGHT=' + state.thought + ';MODEL=' + state.model } },
    })
    return { stopReason: 'end_turn' }
  },
  async cancel() {},
}), stream)
`.trimStart()

async function runPreparedTurn(adapter: AcpLlmAdapter, model: string, sessionId: string, reasoningEffort?: string): Promise<string> {
  const prepared = await adapter.prepareCall('acp', model)
  const effectiveEffort = reasoningEffort ?? prepared.model.reasoning?.defaultEffort
  const chunks: string[] = []
  for await (const chunk of prepared.stream({
    provider: 'acp',
    model,
    sessionId,
    ...(effectiveEffort === undefined ? {} : { reasoningEffort: effectiveEffort }),
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
  })) {
    if (chunk.type === 'text-delta') chunks.push(chunk.text)
  }
  return chunks.join('')
}

describe('pre-first-turn thought level stability', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-ntr-effort-update-'))
  const scriptPath = join(dir, 'push-agent.mjs')
  writeFileSync(scriptPath, PUSH_AGENT_SOURCE, 'utf8')

  const cleanupRoutes: string[] = []
  afterAll(() => {
    for (const id of cleanupRoutes) routeBindingRegistry().conversations.delete(id)
    rmSync(dir, { recursive: true, force: true })
  })

  it('keeps pre-first-turn effort through real LlmRuntime when agent pushes config_option_update, across turn 2 and resume', async () => {
    const setLog = join(dir, 'sets-push.jsonl')
    const hub = new EventHub()
    const events: AcpEvent[] = []
    hub.subscribe(event => { events.push(event) })
    const agentDef: AcpAgentDef = {
      id: 'push-cb',
      title: 'PushCB',
      command: process.execPath,
      args: [scriptPath],
      env: { PUSH_AGENT_SET_LOG: setLog, PUSH_AGENT_LOAD_THOUGHT: 'low' },
      cwd: dir,
      allowedCwdRoots: [dir],
    }
    const gm = new BridgeManager([agentDef], hub, 500, join(dir, 'agents-push.json'), join(dir, 'catalog-push.json'))
    const adapter = new AcpLlmAdapter(gm)
    const dshSessionId = 'dsh-push-effort-1'
    cleanupRoutes.push(dshSessionId)

    try {
      // Warm catalog: agent defaults to thought_level = 'high'.
      const probe = await gm.probeAgentModels('push-cb')
      expect(probe.catalog.thought?.currentValue).toBe('high')

      // User picks 'max' on a bare route before sending the first message.
      gm.bindChatAgent(dshSessionId, 'push-cb')
      await gm.setChatSessionEffort(dshSessionId, 'max', 'push-cb')

      // Host loop prepareCall materializes `reasoningEffort: 'high'` from `defaultEffort`.
      const out1 = await runPreparedTurn(adapter, 'push-cb', dshSessionId)
      expect(out1).toContain('THOUGHT=max')

      // Per-session `config_option_update` must NOT overwrite the catalog default.
      expect(gm.catalogFor('push-cb')?.thought?.currentValue).toBe('high')
      expect(gm.chatChoice(dshSessionId)?.effort).toBe('max')
      expect(gm.chatSessions(dshSessionId)[0]?.reasoningEffort).toBe('max')

      // Turn 2 on the same live session still stays on 'max'.
      const out2 = await runPreparedTurn(adapter, 'push-cb', dshSessionId)
      expect(out2).toContain('THOUGHT=max')

      // Park (idle release) then resume via `session/load` (which returns 'low',
      // moving `modelDefaultEffort` mid-turn after `prepareCall` materialized 'high').
      const released = gm.releaseIdleProcesses('push-cb')
      expect(released.released).toHaveLength(1)
      expect(gm.chatSessions(dshSessionId)[0]?.released).toBe(true)

      const out3 = await runPreparedTurn(adapter, 'push-cb', dshSessionId)
      expect(out3).toContain('THOUGHT=max')
      expect(gm.chatSessions(dshSessionId)[0]?.reasoningEffort).toBe('max')

      const sets = readFileSync(setLog, 'utf8').trim().split('\n').map(line => JSON.parse(line) as { configId: string; value: string })
      expect(sets).toEqual([
        { configId: 'thought_level', value: 'max' },
        { configId: 'thought_level', value: 'max' },
      ])
    } finally {
      await gm.shutdownAll()
    }
  }, 30_000)

  it('keeps catalog currentValue anchored and still updates thoughtByModel / catalog/updated on config_option_update', async () => {
    const hub = new EventHub()
    const events: AcpEvent[] = []
    hub.subscribe(event => { events.push(event) })
    const agentDef: AcpAgentDef = {
      id: 'shape-cb',
      title: 'ShapeCB',
      command: process.execPath,
      args: [scriptPath],
      cwd: dir,
      allowedCwdRoots: [dir],
    }
    const gm = new BridgeManager([agentDef], hub, 500, join(dir, 'agents-shape.json'), join(dir, 'catalog-shape.json'))
    const dshSessionId = 'dsh-shape-update'
    cleanupRoutes.push(dshSessionId)

    try {
      await gm.probeAgentModels('shape-cb')
      const beforeUpdates = events.filter(event => event.type === 'catalog/updated').length

      gm.bindChatAgent(dshSessionId, 'shape-cb')
      await gm.getOrCreateDshSession(dshSessionId, 'shape-cb')
      await gm.setChatSessionModel(dshSessionId, 'shape-cb@model-b', 'shape-cb')

      expect(gm.catalogFor('shape-cb')?.model?.currentValue).toBe('model-a')
      expect(gm.catalogFor('shape-cb')?.thought?.currentValue).toBe('high')
      expect(gm.agentCatalog('shape-cb').reasoningByModel?.['model-b']?.efforts.map(e => e.id)).toEqual(['low', 'high', 'max'])
      expect(events.filter(event => event.type === 'catalog/updated').length).toBeGreaterThan(beforeUpdates)
    } finally {
      await gm.shutdownAll()
    }
  }, 30_000)

  it('keeps pre-first-turn effort when session/new or a concurrent session moves catalog defaultEffort after prepareCall', async () => {
    const hub = new EventHub()
    const catalogFile = join(dir, 'catalog-toctou.json')
    writeFileSync(catalogFile, JSON.stringify({
      version: 3,
      agents: {
        'toctou-cb': {
          catalog: {
            model: {
              configId: 'model',
              name: 'Model',
              currentValue: 'model-a',
              choices: [
                { value: 'model-a', name: 'Model A' },
                { value: 'model-b', name: 'Model B' },
              ],
            },
            thought: {
              configId: 'thought_level',
              name: 'Deep Thinking',
              currentValue: 'high',
              choices: [
                { value: 'low', name: 'Low' },
                { value: 'high', name: 'High' },
                { value: 'max', name: 'Max' },
              ],
            },
          },
          updatedAt: 1,
        },
      },
    }), 'utf8')

    const agentDef: AcpAgentDef = {
      id: 'toctou-cb',
      title: 'ToctouCB',
      command: process.execPath,
      args: [scriptPath],
      env: { PUSH_AGENT_NEW_THOUGHT: 'low' },
      cwd: dir,
      allowedCwdRoots: [dir],
    }
    const gm = new BridgeManager([agentDef], hub, 500, join(dir, 'agents-toctou.json'), catalogFile)
    const adapter = new AcpLlmAdapter(gm)
    const dsh1 = 'dsh-toctou-prepared'
    const dsh2 = 'dsh-toctou-concurrent'
    const dsh3 = 'dsh-toctou-variant'
    const dsh4 = 'dsh-toctou-direct'
    cleanupRoutes.push(dsh1, dsh2, dsh3, dsh4)

    try {
      // Case A: session/new moves catalog defaultEffort from 'high' to 'low' after prepareCall.
      gm.bindChatAgent(dsh1, 'toctou-cb')
      await gm.setChatSessionEffort(dsh1, 'max', 'toctou-cb')
      expect(await runPreparedTurn(adapter, 'toctou-cb', dsh1)).toContain('THOUGHT=max')
      expect(gm.chatSessions(dsh1)[0]?.reasoningEffort).toBe('max')

      // Case B: concurrent catalog mutation between prepareCall and stream.
      const internal = gm as unknown as { catalog: { catalogs: Map<string, { catalog: { thought?: { currentValue: string | null } }; updatedAt: number }> } }
      const entry = internal.catalog.catalogs.get('toctou-cb')
      if (entry?.catalog.thought) entry.catalog.thought.currentValue = 'high'

      gm.bindChatAgent(dsh2, 'toctou-cb')
      await gm.setChatSessionEffort(dsh2, 'max', 'toctou-cb')
      const prepared = await adapter.prepareCall('acp', 'toctou-cb')
      expect(prepared.model.reasoning?.defaultEffort).toBe('high')
      if (entry?.catalog.thought) entry.catalog.thought.currentValue = 'low'

      const chunks2: string[] = []
      for await (const chunk of prepared.stream({
        provider: 'acp',
        model: 'toctou-cb',
        sessionId: dsh2,
        reasoningEffort: 'high',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'concurrent' }] }],
      })) {
        if (chunk.type === 'text-delta') chunks2.push(chunk.text)
      }
      expect(chunks2.join('')).toContain('THOUGHT=max')

      // Case C: variant route via prepareCall captures `null` (no agent-wide fallback)
      // so an explicit `reasoningEffort` matching the catalog default is still honoured.
      const preparedVariant = await adapter.prepareCall('acp', 'toctou-cb@model-b')
      expect(preparedVariant.model.reasoning?.defaultEffort).toBeUndefined()
      const chunks3: string[] = []
      for await (const chunk of preparedVariant.stream({
        provider: 'acp',
        model: 'toctou-cb@model-b',
        sessionId: dsh3,
        reasoningEffort: 'low',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'variant' }] }],
      })) {
        if (chunk.type === 'text-delta') chunks3.push(chunk.text)
      }
      expect(chunks3.join('')).toContain('THOUGHT=low;MODEL=model-b')

      // Case D: direct streamPrompt call without prepareCall captures preDefaultEffort before session/new.
      const latestEntry = internal.catalog.catalogs.get('toctou-cb')
      if (latestEntry?.catalog.thought) latestEntry.catalog.thought.currentValue = 'high'
      gm.bindChatAgent(dsh4, 'toctou-cb')
      await gm.setChatSessionEffort(dsh4, 'max', 'toctou-cb')
      const chunks4: string[] = []
      for await (const chunk of gm.streamPrompt({
        provider: 'acp',
        model: 'toctou-cb',
        sessionId: dsh4,
        reasoningEffort: 'high',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'direct' }] }],
      })) {
        if (chunk.type === 'text-delta') chunks4.push(chunk.text)
      }
      expect(chunks4.join('')).toContain('THOUGHT=max')
    } finally {
      await gm.shutdownAll()
    }
  }, 30_000)
})
