/**
 * Native delegation END TO END (docs/plan/acp-delegate-native-subagent.md §9):
 * a REAL BridgeManager over the mock agent, the registered `acp` provider, and
 * a fake `ctx.subagents` shaped by the host contract. Pins the async chain —
 * immediate name while the turn is still on air, settlement delivering the
 * folded answer, interrupt → aborted, the silence window → error + diagnostic,
 * explicit capacity refusal — plus the old-host synchronous fallback on the
 * same manager.
 */
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { AcpDelegateRegistration, AcpDelegateService, AcpSubagentProvider, BridgeManager, type DelegateSubagentsLike } from '../../src/bridge.ts'
import { EventHub } from '../../src/impl.ts'
import type { AcpDelegateAsyncOutput, AcpEvent } from '../../src/protocol.ts'
import { fakeMask, fakeSubagentsService, fakeToolsCtx } from '../delegate-harness.ts'
import { def, normPath, until } from './harness.ts'

describe('acp_delegate native activation (mock agent)', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'dsh-ntr-dnative-'))
  const hub = new EventHub()
  const events: AcpEvent[] = []
  hub.subscribe(event => { events.push(event) })
  const manager = new BridgeManager([{ ...def, id: 'dnative', cwd: workspace, allowedCwdRoots: [workspace] }], hub, 500)
  manager.setConfiguredDelegate({ guidance: 'on', timeoutMs: 600_000 })

  /** The exact host face src/index.ts wires. */
  const service = new AcpDelegateService({
    hub: manager.hub,
    agents: () => manager.agentViews(),
    defaultAgent: () => manager.defaultAgent(),
    delegateConfig: () => manager.delegateConfig(),
    startSession: (agentId, cwd, opts) => manager.startSession(agentId, cwd, opts),
    setPermissionPolicy: (sessionId, policy) => manager.setPermissionPolicy(sessionId, policy),
    sessionOptions: sessionId => manager.sessionOptions(sessionId),
    setMode: (sessionId, modeId) => manager.setMode(sessionId, modeId),
    setConfigOption: (sessionId, configId, value) => manager.setConfigOption(sessionId, configId, value),
    prompt: (sessionId, text) => manager.prompt(sessionId, text),
    cancel: sessionId => manager.cancel(sessionId),
    closeSession: sessionId => manager.closeSession(sessionId),
    transcript: (sessionId, afterSeq) => manager.transcript(sessionId, afterSeq),
  })
  // The calling session's live agent stand-in: its header cwd is the workspace
  // the delegation inherits (the same root the chat path trusts).
  const exec = { agent: { id: 'parent-session', session: { header: { id: 'parent-session', cwd: workspace } } }, signal: new AbortController().signal }

  /** One full wiring: provider registered, tool registered through the seam. */
  function wire(opts?: { capacity?: number; seam?: boolean }) {
    const fake = fakeSubagentsService(opts)
    fake.service.registerProvider(new AcpSubagentProvider({ service }))
    const tools = fakeToolsCtx()
    tools.install()
    const registration = new AcpDelegateRegistration({
      ctx: tools.ctx,
      service,
      config: () => manager.delegateConfig(),
      forceMask: fakeMask(),
      ...(opts?.seam === false ? {} : { subagents: () => fake.service as DelegateSubagentsLike }),
    })
    registration.sync()
    const definition = tools.registered[0].definition
    return { ...fake, definition, registration }
  }

  afterAll(async () => {
    await manager.shutdownAll()
    // Windows holds the child's cwd handle until the tree kill lands (the
    // HANG test leaves a wedged prompt on air, and taskkill is fire-and-forget
    // inside stop()): retry past the release instead of failing the suite on
    // a cleanup race. 15s covers a heavily loaded parallel vitest run.
    for (let attempt = 0; ; attempt += 1) {
      try {
        rmSync(workspace, { recursive: true, force: true })
        break
      } catch (error) {
        if (attempt >= 60) throw error
        await new Promise(resolve => setTimeout(resolve, 250))
      }
    }
  })

  it('returns the name while the turn runs; the settlement delivers the folded answer', async () => {
    const w = wire()
    const started = Date.now()
    const startsBefore = events.filter(event => event.type === 'turn/start').length
    // SLOW holds the mock's turn for 5s: a synchronous shell could not return
    // before it, the async shell returns as soon as the child is published.
    const value = await w.definition.execute({ task: 'SLOW native chain', agent: 'dnative' }, exec) as unknown as AcpDelegateAsyncOutput
    expect(value).toEqual({ kind: 'activation', name: 'agent-1', agent: 'dnative' })
    expect(Date.now() - started).toBeLessThan(4_000)
    expect(w.specs[0].label).toBe('dnative: SLOW native chain')
    expect(w.specs[0].delivery).toBe('parent')
    // The child is really running on the agent's own process.
    await until(() => events.filter(event => event.type === 'turn/start').length > startsBefore)
    const result = await w.receipts[0].result
    expect(result.stopReason).toBe('completed')
    const text = result.output.map(block => (block as { text?: string }).text ?? '').join('')
    expect(text).toContain('MOCK: echo SLOW native chain perm=none')
    expect(text).not.toContain('— acp_delegate') // the host owns the summary footer
    // The session closed exactly once the run settled.
    await until(() => events.some(event => event.type === 'session/closed'))
  }, 30_000)

  it('interrupt through the receipt dispose settles aborted and closes the session', async () => {
    const w = wire()
    const startsBefore = events.filter(event => event.type === 'turn/start').length
    const value = await w.definition.execute({ task: 'SLOW interrupt me', agent: 'dnative' }, exec) as unknown as AcpDelegateAsyncOutput
    expect(value).toMatchObject({ kind: 'activation', name: 'agent-1' })
    await until(() => events.filter(event => event.type === 'turn/start').length > startsBefore)
    const closedBefore = events.filter(event => event.type === 'session/closed').length
    await w.receipts[0].dispose()
    const result = await w.receipts[0].result
    expect(result.stopReason).toBe('aborted')
    // Idempotent: a second dispose neither throws nor re-closes.
    await w.receipts[0].dispose()
    await until(() => events.filter(event => event.type === 'session/closed').length > closedBefore)
  }, 30_000)

  it('the silence window settles error with a diagnostic on a wedged agent', async () => {
    const w = wire()
    // Hot config: the core reads the window live per run — no re-registration
    // needed for the window itself.
    manager.setConfiguredDelegate({ guidance: 'on', timeoutMs: 500 })
    try {
      const value = await w.definition.execute({ task: 'HANG silence please', agent: 'dnative' }, exec) as unknown as AcpDelegateAsyncOutput
      expect(value).toMatchObject({ kind: 'activation' })
      const result = await w.receipts[0].result
      expect(result.stopReason).toBe('error')
      expect(result.diagnostic).toContain('timed out after 500ms of silence')
      expect(result.output).toEqual([]) // the wedged agent produced no text
    } finally {
      manager.setConfiguredDelegate({ guidance: 'on', timeoutMs: 600_000 })
    }
  }, 30_000)

  it('a full shared pool refuses explicitly instead of queueing', async () => {
    const w = wire({ capacity: 1 })
    const first = await w.definition.execute({ task: 'SLOW occupy the slot', agent: 'dnative' }, exec) as unknown as AcpDelegateAsyncOutput
    expect(first).toMatchObject({ kind: 'activation' })
    const second = await w.definition.execute({ task: 'SLOW refused', agent: 'dnative' }, exec) as { kind: string; error: string; agent?: string }
    expect(second.kind).toBe('error')
    expect(second.error).toContain('ACTIVATION_LIMIT_REACHED')
    expect(second.agent).toBe('dnative')
    // Releasing the slot admits a new activation again.
    await w.receipts[0].dispose()
    expect((await w.receipts[0].result).stopReason).toBe('aborted')
    const third = await w.definition.execute({ task: 'SLOW admitted', agent: 'dnative' }, exec) as unknown as AcpDelegateAsyncOutput
    expect(third).toMatchObject({ kind: 'activation' })
    await w.receipts[1].dispose()
    await w.receipts[1].result
  }, 30_000)

  it('old-host fallback: without the seam the SAME manager serves the legacy synchronous full text', async () => {
    const w = wire({ seam: false })
    expect(w.definition.description).toContain('并返回它最后给出的答复')
    const value = await w.definition.execute({ task: 'legacy echo', agent: 'dnative' }, exec)
    expect(value.text).toContain('MOCK: echo legacy echo perm=none')
    expect(value.text).toContain(`— acp_delegate · dnative · cwd=${normPath(realpathSync(workspace))} · end_turn`)
    expect(value.agent).toBe('dnative')
    expect(value.stopReason).toBe('end_turn')
  }, 30_000)
})