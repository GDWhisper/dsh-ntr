/**
 * Four-axis delegation choices END TO END (T2): a REAL BridgeManager over the
 * mock agent, wired exactly like src/index.ts (sessionOptions / setMode /
 * setConfigOption / notify included). Pins the live-options authority on the
 * real wire: explicit picks land as mode → model → effort writes BEFORE the
 * prompt, stale configured defaults degrade with ONE agent/notice filed under
 * the DELEGATED agent and never rewrite agents.json, an explicit stale model
 * refuses the turn without a prompt, and the effort axis plans against the
 * REFRESHED options (the mock's variant-less model removes the thought
 * selector — the model write is what reveals it). No mock-agent change: every
 * shape it already publishes.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { AcpDelegateService, BridgeManager } from '../../src/bridge.ts'
import { EventHub, dispatchRpc, parseCatalogOptions } from '../../src/impl.ts'
import type { AcpEvent } from '../../src/protocol.ts'
import { def } from './harness.ts'

// Isolate EVERY runtime write (agents.json, model-catalog.json, workspaces)
// in a throwaway state dir; the fork pool runs files sequentially, and the
// env is restored in afterAll anyway.
const stateDir = mkdtempSync(join(tmpdir(), 'dsh-ntr-dchoices-state-'))
const previousStateDir = process.env.DSH_NTR_STATE_DIR
process.env.DSH_NTR_STATE_DIR = stateDir

type MetaEvent = Extract<AcpEvent, { type: 'session/meta' }>
const metasOf = (source: readonly AcpEvent[]): MetaEvent[] =>
  source.filter((event): event is MetaEvent => event.type === 'session/meta')
const noticesOf = (source: readonly AcpEvent[]): string[] =>
  source.filter(event => event.type === 'agent/notice').map(event => (event as { text: string }).text)
type NoticeEvent = Extract<AcpEvent, { type: 'agent/notice' }>
const noticeFramesOf = (source: readonly AcpEvent[]): NoticeEvent[] =>
  source.filter((event): event is NoticeEvent => event.type === 'agent/notice')

describe('acp_delegate choice axes (mock agent)', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'dsh-ntr-dchoices-ws-'))
  const storage = join(stateDir, 'agents.json')
  const hub = new EventHub()
  const events: AcpEvent[] = []
  hub.subscribe(event => { events.push(event) })
  const manager = new BridgeManager([{ ...def, id: 'dchoice', cwd: workspace, allowedCwdRoots: [workspace] }], hub, 500, storage)
  manager.setConfiguredDelegate({ guidance: 'on', timeoutMs: 600_000 })

  /**
   * The exact host face src/index.ts wires, over any manager. The notify
   * seam is tapped into `sink` AND broadcast like the entry does — the frame
   * is filed under the DELEGATED agent (the entry's delegateNotify): the sink
   * counts the DELEGATION's degradation notices exactly (the bridge's own
   * workspace-alignment notices are a separate, pre-existing mechanism).
   */
  function wireService(m: BridgeManager, sink: string[]): AcpDelegateService {
    return new AcpDelegateService({
      hub: m.hub,
      agents: () => m.agentViews(),
      defaultAgent: () => m.defaultAgent(),
      delegateConfig: () => m.delegateConfig(),
      startSession: (agentId, cwd, opts) => m.startSession(agentId, cwd, opts),
      setPermissionPolicy: (sessionId, policy) => m.setPermissionPolicy(sessionId, policy),
      sessionOptions: sessionId => m.sessionOptions(sessionId),
      setMode: (sessionId, modeId) => m.setMode(sessionId, modeId),
      setConfigOption: (sessionId, configId, value) => m.setConfigOption(sessionId, configId, value),
      notify: (text, agentId) => { sink.push(text); m.hub.broadcast({ type: 'agent/notice', agentId: agentId ?? m.defaultAgent() ?? 'acp', level: 'info', text }) },
      prompt: (sessionId, text) => m.prompt(sessionId, text),
      cancel: sessionId => m.cancel(sessionId),
      closeSession: sessionId => m.closeSession(sessionId),
      transcript: (sessionId, afterSeq) => m.transcript(sessionId, afterSeq),
    })
  }
  const delegateNotices: string[] = []
  const service = wireService(manager, delegateNotices)
  const exec = { agent: { session: { header: { cwd: workspace } } } }

  afterAll(async () => {
    await manager.shutdownAll()
    for (const dir of [workspace, stateDir]) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    if (previousStateDir === undefined) delete process.env.DSH_NTR_STATE_DIR
    else process.env.DSH_NTR_STATE_DIR = previousStateDir
  })

  it('sessionOptions reads the live session/new answer; a gone session reads undefined', async () => {
    const start = await dispatchRpc(manager, 'session/start', { agentId: 'dchoice' })
    expect(start.ok).toBe(true)
    if (!start.ok) return
    const { sessionId } = start.value as { sessionId: string }
    const live = manager.sessionOptions(sessionId)
    expect(live?.modes?.availableModes.map(mode => mode.id)).toEqual(['default', 'strict'])
    expect(parseCatalogOptions(live?.configOptions).model?.choices.map(choice => choice.value)).toEqual(['mock-model-a', 'mock-model-b'])
    await dispatchRpc(manager, 'session/close', { sessionId })
    expect(manager.sessionOptions(sessionId)).toBeUndefined()
  }, 30_000)

  it('explicit model/mode/effort land on the session in order, BEFORE the prompt', async () => {
    delegateNotices.length = 0
    const startIndex = events.length
    const result = await service.execute({ task: 'CHOICES echo', agent: 'dchoice', model: 'mock-model-b', mode: 'strict', effort: 'off' }, exec)
    expect(result.text).toContain('MOCK: echo CHOICES echo')
    expect(result.notes).toBeUndefined()
    const metas = metasOf(events.slice(startIndex))
    // First frame carrying each write: mode strictly before model, model
    // strictly before effort (extra mode/config update frames cannot reorder).
    const modeAt = metas.findIndex(meta => meta.session.modes?.currentModeId === 'strict')
    const modelAt = metas.findIndex(meta => parseCatalogOptions(meta.session.configOptions).model?.currentValue === 'mock-model-b')
    const effortAt = metas.findIndex(meta => parseCatalogOptions(meta.session.configOptions).thought?.currentValue === 'off')
    expect(modeAt).toBeGreaterThanOrEqual(0)
    expect(modeAt).toBeLessThan(modelAt)
    expect(modelAt).toBeLessThan(effortAt)
    // The mode write preceded the model write: at mode-landing the model was
    // still the session/new default.
    expect(parseCatalogOptions(metas[modeAt].session.configOptions).model?.currentValue).toBe('mock-model-a')
    expect(delegateNotices).toEqual([])
    expect(events.slice(startIndex).some(event => event.type === 'session/closed')).toBe(true)
  }, 30_000)

  it('stale configured defaults: the task runs, ONE merged notice, agents.json byte-identical', async () => {
    delegateNotices.length = 0
    await manager.setDelegateSettings({ agentDefaults: { dchoice: { model: 'ghost-model', mode: 'ghost-mode', effort: 'ghost-effort' } } })
    const before = readFileSync(storage, 'utf8')
    const startIndex = events.length
    const result = await service.execute({ task: 'STALE echo', agent: 'dchoice' }, exec)
    expect(result.text).toContain('MOCK: echo STALE echo')
    const notes = [
      'agent「dchoice」不再提供默认模式「ghost-mode」，本次使用启动模式',
      'agent「dchoice」不再提供默认模型「ghost-model」，本次使用 agent 自身默认模型',
      'agent「dchoice」的默认思考等级「ghost-effort」不受当前模型支持，本次不设置',
    ].join('；')
    // Exactly ONE delegation notice through the seam, and it reached the hub.
    expect(delegateNotices).toEqual([notes])
    expect(noticesOf(events.slice(startIndex))).toContain(notes)
    // The hub frame is filed under the DELEGATED agent — this manager has no
    // global default, so the pre-fix wiring would have named 'acp'.
    const frames = noticeFramesOf(events.slice(startIndex)).filter(frame => frame.text === notes)
    expect(frames).toHaveLength(1)
    expect(frames[0]?.agentId).toBe('dchoice')
    expect(result.notes).toBe(notes)
    expect(result.text).toContain(`\n备注：${notes}`)
    // The runtime fallback NEVER rewrites the persisted configuration.
    expect(readFileSync(storage, 'utf8')).toBe(before)
    await manager.setDelegateSettings({ reset: ['agentDefaults'] })
  }, 30_000)

  it('an explicit stale model refuses the turn: error, session closed, NO prompt dispatched', async () => {
    delegateNotices.length = 0
    await manager.setDelegateSettings({ reset: ['agentDefaults'] })
    const startIndex = events.length
    await expect(service.execute({ task: 'REFUSED echo', agent: 'dchoice', model: 'ghost-model' }, exec))
      .rejects.toThrow('acp_delegate: agent "dchoice" does not offer model "ghost-model" (available: mock-model-a, mock-model-b)')
    const slice = events.slice(startIndex)
    expect(slice.filter(event => event.type === 'turn/start')).toHaveLength(0)
    expect(slice.some(event => event.type === 'session/closed')).toBe(true)
    expect(delegateNotices).toEqual([]) // a fatal explicit pick is not a degradation note
  }, 30_000)

  it('effort plans against the REFRESHED options: the model write removes thought, the configured effort degrades', async () => {
    // The mock's variant-less model (opt-in knob) publishes NO thought_level:
    // switching to it is exactly the "a model write changes which efforts
    // exist" situation the effort re-read must see.
    const plainStorage = join(stateDir, 'agents-plain.json')
    const plainHub = new EventHub()
    const plainEvents: AcpEvent[] = []
    plainHub.subscribe(event => { plainEvents.push(event) })
    const plainManager = new BridgeManager(
      [{ ...def, id: 'dplain', cwd: workspace, allowedCwdRoots: [workspace], env: { MOCK_PLAIN_MODEL_CHOICE: '1' } }],
      plainHub, 500, plainStorage,
    )
    try {
      await plainManager.setDelegateSettings({ agentDefaults: { dplain: { model: 'mock-model-plain', effort: 'high' } } })
      const plainNotices: string[] = []
      const result = await wireService(plainManager, plainNotices).execute({ task: 'REFRESH echo', agent: 'dplain' }, exec)
      expect(result.text).toContain('MOCK: echo REFRESH echo')
      const note = 'agent「dplain」的默认思考等级「high」不受当前模型支持，本次不设置'
      expect(result.notes).toBe(note)
      expect(plainNotices).toEqual([note])
      expect(noticesOf(plainEvents)).toContain(note)
      // Attribution on the second manager too: the frame names 'dplain'.
      const plainFrames = noticeFramesOf(plainEvents).filter(frame => frame.text === note)
      expect(plainFrames).toHaveLength(1)
      expect(plainFrames[0]?.agentId).toBe('dplain')
      // The model write DID land, and the refreshed snapshot has no thought
      // selector — that refresh is what dropped the effort, not the initial read.
      const last = metasOf(plainEvents).at(-1)
      expect(last).toBeDefined()
      const catalog = parseCatalogOptions(last?.session.configOptions)
      expect(catalog.model?.currentValue).toBe('mock-model-plain')
      expect(catalog.thought).toBeUndefined()
    } finally {
      await plainManager.shutdownAll()
    }
  }, 30_000)
})