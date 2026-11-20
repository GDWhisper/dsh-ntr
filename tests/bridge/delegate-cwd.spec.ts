/**
 * Workspace inheritance end to end (plan §3, user ruling): the delegate
 * service wired to a REAL BridgeManager over the mock agent, the same closure
 * face `src/index.ts` builds. The calling session's workspace is a SIBLING of
 * the agent's allow-list (the chat-path situation): only the inherited
 * `extraRoots` authorization can anchor a session there.
 *
 * Pins: omitted-cwd inheritance (session cwd AND process cwd), explicit
 * subdirectory admission + confinement, out-of-fence refusal with the agent id
 * and NO spawn, the degraded roots-only fence, the fs guard consuming the
 * inherited workspace (relative read/write), and the untouched `/acp` legacy
 * path (no inheritance, additive `cwd` on the answer).
 */
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { AcpDelegateService, BridgeManager } from '../../src/bridge.ts'
import { dispatchRpc, EventHub } from '../../src/impl.ts'
import type { AcpEvent } from '../../src/protocol.ts'
import { def, normPath } from './harness.ts'

describe('acp_delegate workspace inheritance (mock agent)', () => {
  const narrow = mkdtempSync(join(tmpdir(), 'dsh-ntr-dcwd-narrow-'))
  const workspace = mkdtempSync(join(tmpdir(), 'dsh-ntr-dcwd-ws-'))
  const escape = mkdtempSync(join(tmpdir(), 'dsh-ntr-dcwd-escape-'))
  const hub = new EventHub()
  const events: AcpEvent[] = []
  hub.subscribe(event => { events.push(event) })
  const manager = new BridgeManager([{ ...def, id: 'dcwd', cwd: narrow, allowedCwdRoots: [narrow] }], hub, 500)

  /** The exact host face src/index.ts wires (no registration layer needed). */
  const service = new AcpDelegateService({
    hub: manager.hub,
    agents: () => manager.agentViews(),
    defaultAgent: () => manager.defaultAgent(),
    delegateConfig: () => manager.delegateConfig(),
    startSession: (agentId, cwd, opts) => manager.startSession(agentId, cwd, opts),
    setPermissionPolicy: (sessionId, policy) => manager.setPermissionPolicy(sessionId, policy),
    prompt: (sessionId, text) => manager.prompt(sessionId, text),
    cancel: sessionId => manager.cancel(sessionId),
    closeSession: sessionId => manager.closeSession(sessionId),
    transcript: (sessionId, afterSeq) => manager.transcript(sessionId, afterSeq),
  })
  const execWithWs = { agent: { session: { header: { cwd: workspace } } } }

  afterAll(async () => {
    await manager.shutdownAll()
    for (const dir of [narrow, workspace, escape]) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  })

  it('omitted cwd: session AND process land in the calling workspace; relative fs reads/writes pass the fence', async () => {
    writeFileSync(join(workspace, 'note.txt'), 'inherited-workspace-content')
    writeFileSync(join(escape, 'secret.txt'), 'outside-every-root')

    // The process itself starts in the inherited workspace (alignSpawnCwd):
    // the mock's PWD answers process.cwd(), never session/new's cwd.
    const moved = await service.execute({ task: 'PWD please', agent: 'dcwd' }, execWithWs)
    expect(moved.text).toContain(`PWD:${realpathSync(workspace)}`)
    expect(moved.text).not.toContain(`PWD:${realpathSync(narrow)}`)
    // The footer reports the resolved session cwd (folded separators).
    expect(moved.text).toContain(`cwd=${normPath(realpathSync(workspace))}`)

    // The fs guard consumes the SAME root the chat path's extraRoots feed:
    // session.cwd IS the inherited workspace, so relative paths resolve and
    // pass inside it even though the agent's own allow-list never names it.
    const read = await service.execute({ task: 'READFILE note.txt', agent: 'dcwd' }, execWithWs)
    expect(read.text).toContain('READ_OK:inherited-workspace-content')
    const write = await service.execute({ task: 'WRITEFILE written.txt', agent: 'dcwd' }, execWithWs)
    expect(write.text).toContain('WRITE_OK')
    expect(readFileSync(join(workspace, 'written.txt'), 'utf8')).toBe('written-by-mock-agent')

    // Outside every root (agent roots + the inherited workspace): refused.
    const denied = await service.execute({ task: `READFILE ${join(escape, 'secret.txt')}`, agent: 'dcwd' }, execWithWs)
    expect(denied.text).toContain('READ_FAIL')
    expect(denied.text).toContain('outside the session workspace')
  }, 30_000)

  it('explicit cwd = a workspace subdirectory outside the agent roots: admitted, aligned, and confining', async () => {
    const sub = join(workspace, 'sub')
    mkdirSync(sub)
    writeFileSync(join(sub, 'inner.txt'), 'sub-content')

    const moved = await service.execute({ task: 'PWD please', agent: 'dcwd', cwd: sub }, execWithWs)
    expect(moved.text).toContain(`cwd=${normPath(realpathSync(sub))}`)
    expect(moved.text).toContain(`PWD:${realpathSync(sub)}`)

    // Relative fs inside the chosen directory passes…
    const read = await service.execute({ task: 'READFILE inner.txt', agent: 'dcwd', cwd: sub }, execWithWs)
    expect(read.text).toContain('READ_OK:sub-content')
    // …and the explicit cwd CONFINES the session: the parent workspace file
    // is outside this session's fence (agent roots + the chosen directory).
    const up = await service.execute({ task: 'READFILE ../note.txt', agent: 'dcwd', cwd: sub }, execWithWs)
    expect(up.text).toContain('READ_FAIL')
    expect(up.text).toContain('outside the session workspace')
  }, 30_000)

  it('explicit cwd outside both fences: cwd_denied with the agent id, and NO process spawn', async () => {
    // A FRESH manager: nothing ever ran here, so any spawn attempt would be
    // visible (ensureReady publishes agent/status 'starting' before spawning).
    const escHub = new EventHub()
    const escEvents: AcpEvent[] = []
    escHub.subscribe(event => { escEvents.push(event) })
    const escManager = new BridgeManager([{ ...def, id: 'dcwd-esc', cwd: narrow, allowedCwdRoots: [narrow] }], escHub, 500)
    const escService = new AcpDelegateService({
      hub: escManager.hub,
      agents: () => escManager.agentViews(),
      defaultAgent: () => escManager.defaultAgent(),
      delegateConfig: () => escManager.delegateConfig(),
      startSession: (agentId, cwd, opts) => escManager.startSession(agentId, cwd, opts),
      setPermissionPolicy: (sessionId, policy) => escManager.setPermissionPolicy(sessionId, policy),
      prompt: (sessionId, text) => escManager.prompt(sessionId, text),
      cancel: sessionId => escManager.cancel(sessionId),
      closeSession: sessionId => escManager.closeSession(sessionId),
      transcript: (sessionId, afterSeq) => escManager.transcript(sessionId, afterSeq),
    })
    try {
      await expect(escService.execute({ task: 'x', agent: 'dcwd-esc', cwd: escape }, { agent: { session: { header: { cwd: workspace } } } }))
        .rejects.toThrow(/acp_delegate: acp: cwd .*outside agent "dcwd-esc" allowed roots \(agent dcwd-esc\)/)
      // Validation ran BEFORE createSession/ensureReady: no status frame, no
      // session, no child — the refused cwd never spawned a throwaway process.
      expect(escEvents.filter(event => event.type === 'agent/status' && event.agentId === 'dcwd-esc')).toEqual([])
      expect(escEvents.filter(event => event.type === 'session/created')).toEqual([])
    } finally {
      await escManager.shutdownAll()
    }
  }, 30_000)

  it('no header cwd: the degraded delegation keeps the roots-only fence and the agent default', async () => {
    // No exec.agent at all: effectiveCwd undefined → def.cwd, extraRoots [].
    const degraded = await service.execute({ task: 'PWD please', agent: 'dcwd' }, {})
    expect(degraded.text).toContain(`cwd=${normPath(realpathSync(narrow))}`)
    expect(degraded.text).toContain(`PWD:${realpathSync(narrow)}`)
    // The workspace is NOT trusted on this path: an explicit cwd there is
    // refused exactly like the legacy /acp fence (roots only).
    await expect(service.execute({ task: 'x', agent: 'dcwd', cwd: workspace }, {}))
      .rejects.toThrow(/outside agent "dcwd" allowed roots \(agent dcwd\)/)
  }, 30_000)

  it('/acp legacy startSession: no inheritance, roots-only fence, additive cwd on the answer', async () => {
    const start = await dispatchRpc(manager, 'session/start', { agentId: 'dcwd' })
    expect(start.ok).toBe(true)
    if (!start.ok) return
    const value = start.value as { sessionId: string; cwd?: string }
    expect(typeof value.sessionId).toBe('string')
    // Additive field: the resolved session directory (the agent default here).
    expect(value.cwd).toBe(normPath(realpathSync(narrow)))
    // The RPC face passes NO opts: the calling-session workspace is not an
    // extra root here, so the same directory the delegation inherits is denied.
    const denied = await dispatchRpc(manager, 'session/start', { agentId: 'dcwd', cwd: workspace })
    expect(denied).toMatchObject({ ok: false, error: { code: 'cwd_denied' } })
    await dispatchRpc(manager, 'session/close', { sessionId: value.sessionId })
  }, 30_000)
})