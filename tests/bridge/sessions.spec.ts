import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { afterAll, describe, expect, it } from 'vitest'
import { AcpLlmAdapter, BridgeManager, routeBindingRegistry } from '../../src/bridge.ts'
import { type AcpAgentDef, type AcpEvent, type StreamChunk } from '../../src/protocol.ts'
import { dispatchRpc, EventHub } from '../../src/impl.ts'
import { def, hostLoopTurn, normPath, settleTranscript } from './harness.ts'

/**
 * A chat session must run where its DSH session lives: the workspace the user
 * selected in the sidebar, which the host reports back as the workspace
 * resolver's `workspaceRoot` (it IS the session header cwd). The agent's
 * configured `cwd` is the plugin's own sandbox directory and only serves
 * `/acp`-RPC sessions and hosts that report no workspace — an agent started in
 * it answers "current workspace" with `~/.dsh/acp-workspaces` while its
 * Read/Glob/Bash cannot see the user's project.
 */
describe('chat session workspace (isolated manager)', () => {
  const wsHub = new EventHub()
  const wsEvents: AcpEvent[] = []
  wsHub.subscribe(event => { wsEvents.push(event) })
  // Deliberately a SIBLING of the workspace: the agent's allow-list does not
  // contain the workspace, so the session can only be anchored there because
  // the host trusts the DSH session's own root for that session.
  const narrow = mkdtempSync(join(tmpdir(), 'dsh-ntr-narrow-'))
  const workspace = mkdtempSync(join(tmpdir(), 'dsh-ntr-ws-'))
  // A second agent, so the process-workspace cases start from a state the
  // earlier cases did not leave behind: their live sessions are exactly what
  // pins a process to the directory it was spawned in.
  const wsManager = new BridgeManager([
    { ...def, id: 'wsmock', cwd: narrow, allowedCwdRoots: [narrow] },
    { ...def, id: 'wsprobe', cwd: narrow, allowedCwdRoots: [narrow] },
  ], wsHub, 500)
  const wsAdapter = new AcpLlmAdapter(wsManager)
  let wsPolicy: { workspaceRoot?: string } | undefined
  wsManager.setSessionWorkspaceResolver(() => wsPolicy)

  afterAll(async () => {
    await wsManager.shutdownAll()
  })

  /** Wait for a fresh event on THIS suite's hub (the shared `waitFor` watches the top-level one). */
  function wsWaitFor<T extends AcpEvent['type']>(type: T, predicate: (event: Extract<AcpEvent, { type: T }>) => boolean, timeoutMs = 15_000): Promise<Extract<AcpEvent, { type: T }>> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout waiting for ${type}`)), timeoutMs)
      const unsub = wsHub.subscribe(event => {
        if (event.type === type && predicate(event as Extract<AcpEvent, { type: T }>)) {
          clearTimeout(timer)
          unsub()
          resolve(event as Extract<AcpEvent, { type: T }>)
        }
      })
      const existing = wsEvents.find(event => event.type === type && predicate(event as Extract<AcpEvent, { type: T }>))
      if (existing !== undefined) {
        clearTimeout(timer)
        unsub()
        resolve(existing as Extract<AcpEvent, { type: T }>)
      }
    })
  }

  /** The session's LATEST snapshot cwd (created, then reset/meta across a resume). */
  function lastCwdOf(sessionId: string): string {
    for (let i = wsEvents.length - 1; i >= 0; i--) {
      const event = wsEvents[i]
      if ((event.type === 'session/created' || event.type === 'session/meta' || event.type === 'session/reset')
        && event.sessionId === sessionId) {
        return event.session.cwd
      }
    }
    return ''
  }

  /** Drain one adapter turn; returns the agent's echo, its host session id and that session's cwd. */
  async function wsTurn(dshSessionId: string, text: string, model = 'wsmock'): Promise<{ echoed: string; hostSessionId: string; cwd: string }> {
    const since = wsEvents.length
    for await (const chunk of wsAdapter.stream({
      provider: 'acp',
      model,
      sessionId: dshSessionId,
      messages: [{ role: 'user', content: [{ type: 'text', text }] }],
    })) {
      void chunk
    }
    const started = wsEvents.slice(since).find(event => event.type === 'turn/start' && event.text === text)
    if (started === undefined) throw new Error('the turn never started')
    // A segmented turn ends this adapter stream at its first tool card; the
    // agent keeps streaming into the transcript until its prompt settles. Wait
    // for that settlement before reading, or the echo below races the last
    // chunk (the helper never runs the host loop's continuation steps).
    await wsWaitFor('turn/end', event => event.turnId === started.turnId)
    const transcript = await dispatchRpc(wsManager, 'transcript/get', { sessionId: started.sessionId })
    if (!transcript.ok) throw new Error('transcript failed')
    const echoed = (transcript.value as { entries: Array<{ update: Record<string, unknown> }> }).entries
      .filter(e => e.update.sessionUpdate === 'agent_message_chunk')
      .map(e => String((e.update.content as { text?: string }).text ?? ''))
      .join('')
    return { echoed, hostSessionId: started.sessionId, cwd: lastCwdOf(started.sessionId) }
  }

  it('anchors a chat session at the DSH session workspace, not the agent default', async () => {
    writeFileSync(join(workspace, 'in-workspace.txt'), 'seen-by-the-agent')
    wsPolicy = { workspaceRoot: workspace }
    const turn = await wsTurn('dsh-ws-chat', 'hello there')
    expect(normPath(turn.cwd)).toBe(normPath(realpathSync(workspace)))
    // The fs guard reads the session cwd, so the workspace is readable too (the
    // agent's own allow-list does not contain it).
    const read = await wsTurn('dsh-ws-chat', `READFILE ${join(workspace, 'in-workspace.txt')}`)
    expect(normPath(read.cwd)).toBe(normPath(realpathSync(workspace)))
    expect(read.echoed).toContain('READ_OK:seen-by-the-agent')
  }, 30_000)

  it('keeps the configured cwd when the host reports no workspace', async () => {
    // No `workspaceRoot` (a deployment without the sandbox policy service, or
    // an /acp-direct session): the agent's own cwd stays in charge.
    wsPolicy = {}
    const turn = await wsTurn('dsh-ws-fallback', 'hello fallback')
    expect(normPath(turn.cwd)).toBe(normPath(realpathSync(narrow)))
  }, 30_000)

  it('resumes a crashed chat session whose cwd is the DSH workspace', async () => {
    // The regression guard: `session/load` re-validates the cwd against the
    // allowed roots, so a workspace the agent's own allow-list never contained
    // must be re-trusted there too — otherwise the session parks back into
    // `released` forever with `cwd_denied`.
    wsPolicy = { workspaceRoot: workspace }
    const first = await wsTurn('dsh-ws-resume', 'DIE now')
    expect(normPath(first.cwd)).toBe(normPath(realpathSync(workspace)))
    const released = await wsWaitFor('session/released', event => event.sessionId === first.hostSessionId)
    expect(released.session.released).toBe(true)

    const resumed = await wsTurn('dsh-ws-resume', 'back again')
    expect(resumed.hostSessionId).toBe(first.hostSessionId)
    expect(normPath(resumed.cwd)).toBe(normPath(realpathSync(workspace)))
    expect(resumed.echoed).toContain('REPLAYED: earlier conversation')
    expect(resumed.echoed).toContain('MOCK: echo back again')
  }, 30_000)

  it('moves an idle process into the chat session workspace instead of leaving it in the agent default', async () => {
    // The regression guard for agents that derive their workspace from their
    // OWN cwd (codebuddy logs `Workspace Path: <process cwd>` before it reads a
    // single ACP request): `session/new`'s cwd arrives too late for them, so the
    // process has to be started in the right directory.
    //
    // In the field the process is usually already up by then — the model probe
    // spawns it first, in the agent's configured cwd — so this case reproduces
    // exactly that order.
    wsPolicy = { workspaceRoot: workspace }
    await wsManager.probeAgentModels('wsprobe')
    const restarts = wsWaitFor('agent/notice', event => event.agentId === 'wsprobe' && event.text.includes('restarts in'))
    const moved = await wsTurn('dsh-ws-proc', 'PWD please', 'wsprobe')
    expect((await restarts).text).toContain(realpathSync(workspace))
    expect(moved.echoed).toContain(`PWD:${realpathSync(workspace)}`)
    expect(moved.echoed).not.toContain(`PWD:${realpathSync(narrow)}`)

    // A live session pins the process: a second conversation in another
    // workspace must not restart it (that would kill the first one). Its own
    // ACP cwd still follows its DSH workspace, and the session that owns the
    // process keeps working — the limit is reported, not papered over.
    const other = mkdtempSync(join(tmpdir(), 'dsh-ntr-ws2-'))
    wsManager.setSessionWorkspaceResolver(id => ({
      mode: 'workspace-write',
      approval: 'ask',
      workspaceRoot: id === 'dsh-ws-proc' ? workspace : other,
    }))
    try {
      const since = wsEvents.length
      const second = await wsTurn('dsh-ws-other', 'PWD again', 'wsprobe')
      expect(normPath(second.cwd)).toBe(normPath(realpathSync(other)))
      expect(second.echoed).toContain(`PWD:${realpathSync(workspace)}`)
      expect(wsEvents.slice(since).filter(event => event.type === 'agent/notice' && event.text.includes('restarts in'))).toHaveLength(0)
      expect((await wsTurn('dsh-ws-proc', 'PWD once more', 'wsprobe')).echoed).toContain(`PWD:${realpathSync(workspace)}`)
    } finally {
      wsManager.setSessionWorkspaceResolver(() => wsPolicy)
    }
  }, 30_000)
})

describe('conversation ↔ agent binding (isolated manager)', () => {
  const bindingHub = new EventHub()

  it('keeps the plugin default agent in its own registry, never in a DSH model route', async () => {
    const storage = `${tmpdir()}/acp-default-agent-${Date.now()}.json`
    const gm = new BridgeManager([{ ...def, id: 'guarded' }], bindingHub, 500, storage)

    // Unset reads as `undefined` — the panel's "no default agent chosen yet".
    expect(await dispatchRpc(gm, 'default/agent', {})).toEqual({ ok: true, value: { agentId: undefined } })
    await dispatchRpc(gm, 'default/agent-set', { agentId: 'guarded' })
    expect(await dispatchRpc(gm, 'default/agent', {})).toEqual({ ok: true, value: { agentId: 'guarded' } })

    // It lives in the agent registry file beside the agents, under its own key.
    const raw = JSON.parse(readFileSync(storage, 'utf-8')) as { version: number; defaultAgentId?: string; agents: unknown[] }
    expect(raw.defaultAgentId).toBe('guarded')
    expect(raw.agents).toHaveLength(1)
    expect(new BridgeManager([], bindingHub, 100, storage).defaultAgent()).toBe('guarded')

    // Deleting the agent clears the pointer (a default naming a missing agent
    // is reported as "none", so the browser offers the menu instead of
    // binding a session at nothing).
    await gm.deleteAgent('guarded')
    expect(gm.defaultAgent()).toBeUndefined()
    expect(JSON.parse(readFileSync(storage, 'utf-8')).defaultAgentId).toBeUndefined()
    await expect(gm.setDefaultAgent('ghost')).rejects.toMatchObject({ code: 'unknown_agent' })
    await gm.shutdownAll()
  })

  it('binds a conversation to an agent without touching any DSH model route', async () => {
    const gm = new BridgeManager([{ ...def, id: 'bound' }], bindingHub, 500, `${tmpdir()}/acp-bind-${Date.now()}.json`)

    // Nothing is bound yet.
    expect(gm.chatAgentFor('dsh-bind-1')).toBeUndefined()
    // Binding is a plugin-private write: no model selection is recorded anywhere.
    gm.bindChatAgent('dsh-bind-1', 'bound')
    expect(gm.chatAgentFor('dsh-bind-1')).toBe('bound')
    await expect(dispatchRpc(gm, 'session/chat-bind', { dshSessionId: 'dsh-bind-2', agentId: 'ghost' }))
      .resolves.toMatchObject({ ok: false, error: { code: 'unknown_agent' } })

    await gm.shutdownAll()
  })

  it('falls back to the session\'s own agent when no intent was recorded', async () => {
    const gm = new BridgeManager([{ ...def, id: 'bound' }], bindingHub, 500, `${tmpdir()}/acp-bind-fallback-${Date.now()}.json`)
    // A conversation that already RAN an agent is pointed at it even if the
    // intent map was never seeded (a session restored from the registry).
    gm.bindChatAgent('dsh-bind-3', 'bound')
    expect(gm.chatAgentFor('dsh-bind-3')).toBe('bound')
    await gm.shutdownAll()
  })
})

/**
 * A conversation must be set up BEFORE its first message.
 *
 * The composer's model / thought-level pickers used to write only into a live
 * ACP session, of which there is none until a turn has already gone out — so
 * the choice could not be made up front, and the first message always ran on
 * whatever the agent's defaults happened to be. The pick is now the plugin's
 * own persisted per-conversation record and is applied when the session
 * materializes (§ "apply on create/resume"), which is the OmniTerm behavior
 * this mirrors (its `config_prefs` agent-level + session-level restore).
 */
describe('agent lock at the start of the first turn (isolated manager)', () => {
  const lockHub = new EventHub()
  const lockAgents = [
    { ...def, id: 'lock-a', title: 'Lock A' },
    { ...def, id: 'lock-b', title: 'Lock B' },
  ]
  /**
   * Drive one turn the way the host loop does: stream a step, and while it
   * settled with tool-call cards, stage their results and stream the
   * continuation — so awaiting this helper means the turn really settled
   * (a single-segment drain would leave the slot claimed and the next turn
   * racing the agent's settle).
   */
  const turn = async (gm: BridgeManager, dshSessionId: string, agentId: string): Promise<void> => {
    const request = {
      model: agentId,
      sessionId: dshSessionId,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    } as never
    let messages = request.messages
    for (let step = 0; step < 8; step += 1) {
      const chunks: StreamChunk[] = []
      for await (const chunk of gm.streamPrompt({ ...request, messages } as never)) chunks.push(chunk)
      const finish = chunks.find((c): c is Extract<StreamChunk, { type: 'finish' }> => c.type === 'finish')
      const callIds = [...new Set(chunks.filter(c => c.type === 'tool-call-delta').map(c => (c as { id: string }).id))]
      if (finish === undefined || finish.reason.kind !== 'stop' || callIds.length === 0) return
      messages = [...messages, ...callIds.map(id => ({
        role: 'tool' as const,
        source: { kind: 'tool' as const, callId: id },
        content: [{ type: 'text' as const, text: 'staged result' }],
      }))]
    }
  }

  it('locks the conversation at the first turn\'s start, and refuses a switch everywhere', async () => {
    const gm = new BridgeManager(lockAgents, lockHub, 500, `${tmpdir()}/acp-lock-${Date.now()}.json`)
    gm.bindChatAgent('dsh-lock-1', 'lock-a')
    // A pick is not a lock: before the first turn the user may still change it.
    expect(gm.lockedAgentFor('dsh-lock-1')).toBeUndefined()
    gm.bindChatAgent('dsh-lock-1', 'lock-b')
    gm.bindChatAgent('dsh-lock-1', 'lock-a')

    // The lock is announced when the turn STARTS, before the agent has said
    // anything: the browser plays its hand-off while the turn is running, and
    // does not need to wait for the session list to settle.
    const seen: AcpEvent[] = []
    const off = lockHub.subscribe(event => { seen.push(event) })
    try {
      await turn(gm, 'dsh-lock-1', 'lock-a')
    } finally {
      off()
    }
    const lockAt = seen.findIndex(event => event.type === 'chat/agent-locked')
    const turnAt = seen.findIndex(event => event.type === 'turn/start')
    expect(lockAt).toBeGreaterThanOrEqual(0)
    expect(turnAt).toBeGreaterThanOrEqual(0)
    expect(lockAt).toBeLessThan(turnAt)
    expect(gm.lockedAgentFor('dsh-lock-1')).toBe('lock-a')
    expect(gm.chatChoice('dsh-lock-1')).toMatchObject({ agentId: 'lock-a', locked: true })

    // The picker path, the model path (a model id names its agent), and the
    // turn path all refuse another agent; re-binding the same one is a no-op.
    expect(() => gm.bindChatAgent('dsh-lock-1', 'lock-b')).toThrow(/locked/)
    expect(() => gm.bindChatAgent('dsh-lock-1', 'lock-a')).not.toThrow()
    // Over the browser's RPC the same refusal keeps its code, so the picker can
    // tell "you may not switch" apart from a transport failure.
    await expect(dispatchRpc(gm, 'session/chat-bind', { dshSessionId: 'dsh-lock-1', agentId: 'lock-b' }))
      .resolves.toMatchObject({ ok: false, error: { code: 'agent_locked' } })
    await expect(gm.setChatSessionModel('dsh-lock-1', 'lock-b@opus')).rejects.toMatchObject({ code: 'agent_locked' })
    await expect(gm.getOrCreateDshSession('dsh-lock-1', 'lock-b')).rejects.toMatchObject({ code: 'agent_locked' })

    // A turn arriving with another agent's model (a stale header, or a route
    // registry entry purged by a delete/re-add) is served by the LOCKED agent,
    // not rejected and never redirected. Driven to completion (continuations
    // included) so the settled-turn claim is honest.
    const staleRequest = {
      model: 'lock-b',
      sessionId: 'dsh-lock-1',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'again' }] }],
    } as never
    const staleChunks: StreamChunk[] = []
    let staleMessages = staleRequest.messages
    for (let step = 0; step < 8; step += 1) {
      const stepChunks: StreamChunk[] = []
      for await (const chunk of gm.streamPrompt({ ...staleRequest, messages: staleMessages } as never)) stepChunks.push(chunk)
      staleChunks.push(...stepChunks)
      const finish = stepChunks.find((c): c is Extract<StreamChunk, { type: 'finish' }> => c.type === 'finish')
      const callIds = [...new Set(stepChunks.filter(c => c.type === 'tool-call-delta').map(c => (c as { id: string }).id))]
      if (finish === undefined || finish.reason.kind !== 'stop' || callIds.length === 0) break
      staleMessages = [...staleMessages, ...callIds.map(id => ({
        role: 'tool' as const,
        source: { kind: 'tool' as const, callId: id },
        content: [{ type: 'text' as const, text: 'staged result' }],
      }))]
    }
    expect(staleChunks.find(chunk => chunk.type === 'finish')?.reason).toEqual({ kind: 'stop' })
    expect(gm.chatSessions('dsh-lock-1').map(session => session.agentId)).toEqual(['lock-a'])

    // The browser learns the lock from the same read that names the binding.
    const listed = await dispatchRpc(gm, 'session/chat-list', { dshSessionId: 'dsh-lock-1' })
    expect(listed).toMatchObject({ ok: true, value: { lockedAgentId: 'lock-a', boundAgentId: 'lock-a' } })
    await gm.shutdownAll()
  }, 30_000)

  it('keeps the lock across a host restart, when no session is live', async () => {
    const storage = `${tmpdir()}/acp-lock-restart-${Date.now()}.json`
    const first = new BridgeManager(lockAgents, lockHub, 500, storage)
    first.bindChatAgent('dsh-lock-2', 'lock-a')
    await turn(first, 'dsh-lock-2', 'lock-a')
    await first.shutdownAll()

    const second = new BridgeManager(lockAgents, lockHub, 500, storage)
    // The record is restored PARKED (a restart kills the process, not the
    // conversation); the persisted lock is what keeps it on its agent.
    expect(second.chatSessions('dsh-lock-2')).toMatchObject([{ agentId: 'lock-a', released: true }])
    expect(second.lockedAgentFor('dsh-lock-2')).toBe('lock-a')
    expect(second.chatChoice('dsh-lock-2')).toMatchObject({ agentId: 'lock-a', locked: true })
    // ...and the persisted record is back on the REQUEST path, not just in the
    // map: the guard's rewrite and the adapter's own check read this registry,
    // which starts empty on a fresh process.
    expect(routeBindingRegistry().conversations.get('dsh-lock-2')).toBe('lock-a')
    expect(() => second.bindChatAgent('dsh-lock-2', 'lock-b')).toThrow(/locked/)
    await second.shutdownAll()
  }, 30_000)

  it('gives the conversation back when the first turn delivers nothing', async () => {
    const gm = new BridgeManager(lockAgents, lockHub, 500, `${tmpdir()}/acp-lock-empty-${Date.now()}.json`)
    gm.bindChatAgent('dsh-lock-empty', 'lock-a')
    const seen: AcpEvent[] = []
    const off = lockHub.subscribe(event => { seen.push(event) })
    try {
      const chunks: StreamChunk[] = []
      for await (const chunk of gm.streamPrompt({
        model: 'lock-a',
        sessionId: 'dsh-lock-empty',
        // The mock answers this with bookkeeping only, then a legal end_turn:
        // the silent provider-failure shape. Nothing was exchanged.
        messages: [{ role: 'user', content: [{ type: 'text', text: 'EMPTY' }] }],
      } as never)) chunks.push(chunk)
      // The empty-turn warning is still reported (rule 23)...
      expect(chunks.find(chunk => chunk.type === 'finish')?.reason).toEqual({ kind: 'stop' })
      expect(chunks.some(chunk => chunk.type === 'text-delta' && chunk.text.includes('no visible output'))).toBe(true)
      // ...but the conversation is not trapped on an agent that produced nothing.
      expect(seen.map(event => event.type)).toEqual(expect.arrayContaining(['chat/agent-locked', 'chat/agent-unlocked']))
      expect(gm.lockedAgentFor('dsh-lock-empty')).toBeUndefined()
      expect(gm.chatChoice('dsh-lock-empty')).toEqual({ agentId: 'lock-a' })
      expect(gm.chatSessions('dsh-lock-empty')).toEqual([])
      // The picker accepts another agent again.
      expect(() => gm.bindChatAgent('dsh-lock-empty', 'lock-b')).not.toThrow()
    } finally {
      off()
      await gm.shutdownAll()
    }
  }, 30_000)

  it('rolls the lock back when the first prompt itself fails', async () => {
    const gm = new BridgeManager(lockAgents, lockHub, 500, `${tmpdir()}/acp-lock-fail-${Date.now()}.json`)
    gm.bindChatAgent('dsh-lock-fail', 'lock-a')
    const seen: AcpEvent[] = []
    const off = lockHub.subscribe(event => { seen.push(event) })
    try {
      const chunks: StreamChunk[] = []
      for await (const chunk of gm.streamPrompt({
        model: 'lock-a',
        sessionId: 'dsh-lock-fail',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'FAIL' }] }],
      } as never)) chunks.push(chunk)
      expect(chunks.find(chunk => chunk.type === 'finish')?.reason).toMatchObject({ kind: 'error' })
      expect(seen.map(event => event.type)).toEqual(expect.arrayContaining(['chat/agent-locked', 'chat/agent-unlocked']))
      expect(gm.lockedAgentFor('dsh-lock-fail')).toBeUndefined()
      expect(gm.chatChoice('dsh-lock-fail')).toEqual({ agentId: 'lock-a' })
      expect(gm.chatSessions('dsh-lock-fail')).toEqual([])
      expect(() => gm.bindChatAgent('dsh-lock-fail', 'lock-b')).not.toThrow()
    } finally {
      off()
      await gm.shutdownAll()
    }
  }, 30_000)
})

/**
 * The turn path must honor the conversation↔agent binding. The driver resolves
 * each turn's route as "pending selection → last request header → deployment
 * default" (dsh-api-session-controller's `selectionFor`), so a session that has
 * never run an ACP turn arrives at SOME OTHER adapter entirely, and one that
 * has replays its previous `acp/<agent>` header forever — the click would
 * change nothing. Two layers fix that: the guard's `agent/request` rewrite
 * makes the driver reach this adapter with the bound agent (register.spec.ts
 * covers it), and `streamPrompt` re-checks the binding in case the driver still
 * arrived with a stale agent id.
 */
describe('request-path binding (isolated manager)', () => {
  const bindingHub = new EventHub()
  /** Iterate a turn to completion (the queue closes when the turn settles). */
  async function drain(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
    const chunks: StreamChunk[] = []
    for await (const chunk of stream) chunks.push(chunk)
    return chunks
  }

  function userTurn(text: string): { role: 'user'; content: { type: 'text'; text: string }[] } {
    return { role: 'user', content: [{ type: 'text', text }] }
  }

  it('serves the bound agent even when the turn still names another one', async () => {
    const gm = new BridgeManager(
      [{ ...def, id: 'alpha' }, { ...def, id: 'beta' }],
      bindingHub,
      500,
      `${tmpdir()}/acp-redirect-${Date.now()}.json`,
    )
    const adapter = new AcpLlmAdapter(gm)
    try {
      // The picker click happens BEFORE the first turn: a switch after the
      // first turn is refused by the lock (see the agent-lock suite), so the
      // stale-route scenario is set up while the conversation is still open.
      gm.bindChatAgent('dsh-redir-1', 'beta')
      expect(routeBindingRegistry().conversations.get('dsh-redir-1')).toBe('beta')

      // Turn 1 arrives with the STALE route (the logged request header names
      // alpha — nothing outside the guard ever rewrites it). The binding wins:
      // beta serves, in its OWN session (context separation per agent). The
      // turn runs to its continuation steps (the host loop's own shape), so
      // awaiting it means the turn really settled.
      await hostLoopTurn(adapter, { provider: 'acp', model: 'alpha', sessionId: 'dsh-redir-1', messages: [userTurn('first')] })
      const sessions = gm.chatSessions('dsh-redir-1')
      expect(sessions.map(session => session.agentId)).toEqual(['beta'])
      // The turn's record names what actually served it (the bound agent), not
      // the stale id the driver arrived with. With no model pick the record
      // names the model the agent itself reported (`session/new`'s current
      // value), not a bare route — a bare route would make the composer read
      // the agent-level catalog, which other conversations can move.
      expect(sessions.find(session => session.agentId === 'beta')?.modelId).toBe('beta@mock-model-a')
      // …and the record of what the conversation is on follows the binding.
      expect(routeBindingRegistry().conversations.get('dsh-redir-1')).toBe('beta')
      // That first turn locked beta; alpha cannot take the conversation back.
      expect(() => gm.bindChatAgent('dsh-redir-1', 'alpha')).toThrow(/locked/)
    } finally {
      routeBindingRegistry().conversations.delete('dsh-redir-1')
      await gm.shutdownAll()
    }
  }, 30_000)

  it('switches the model variant through the same binding the turn path reads', async () => {
    const gm = new BridgeManager([{ ...def, id: 'alpha' }], bindingHub, 500, `${tmpdir()}/acp-variant-${Date.now()}.json`)
    try {
      await gm.setChatSessionModel('dsh-variant-1', 'alpha@mock-model-b')
      expect(routeBindingRegistry().conversations.get('dsh-variant-1')).toBe('alpha@mock-model-b')
      // A stale or ghost entry must not fail the turn: it is ignored instead.
      routeBindingRegistry().conversations.set('dsh-variant-2', 'ghost@x')
      const adapter = new AcpLlmAdapter(gm)
      await hostLoopTurn(adapter, { provider: 'acp', model: 'alpha', sessionId: 'dsh-variant-2', messages: [userTurn('hi')] })
      expect(gm.chatSessions('dsh-variant-2').map(session => session.agentId)).toEqual(['alpha'])
    } finally {
      routeBindingRegistry().conversations.delete('dsh-variant-1')
      routeBindingRegistry().conversations.delete('dsh-variant-2')
      await gm.shutdownAll()
    }
  }, 30_000)

  it('does not re-apply an adapter-defaulted effort over the seat\'s own pick', async () => {
    // The driver materializes `reasoning.defaultEffort` into every request that
    // did not ask for one. That default comes from the agent-level catalog
    // cache, which a per-session thought-level switch does not refresh — so
    // re-applying it per turn would silently revert the user's pick.
    const gm = new BridgeManager([{ ...def, id: 'alpha' }], bindingHub, 500, `${tmpdir()}/acp-effort-${Date.now()}.json`)
    try {
      // Warm the catalog: the mock advertises thought_level choices with
      // currentValue 'high', which is the effort the driver will materialize.
      // (The background probe is disabled under the test runner, so probe
      // directly — the same await the panel's manual probe uses.)
      const probe = await gm.probeAgentModels('alpha')
      expect(probe.catalog.thought?.currentValue).toBe('high')

      const adapter = new AcpLlmAdapter(gm)
      // Turn 1: a REAL pick ('off' ≠ the default) applies and is recorded.
      // The turn runs to its continuation steps so it has really settled
      // before turn 2 claims the slot (a half-drained turn would leave the
      // provisional lock armed, and turn 2's claim failure would roll the
      // whole conversation back).
      await hostLoopTurn(adapter, { provider: 'acp', model: 'alpha', sessionId: 'dsh-effort-1', reasoningEffort: 'off', messages: [userTurn('one')] })
      expect(gm.chatSessions('dsh-effort-1')[0]?.reasoningEffort).toBe('off')
      // Turn 2: the driver arrives with the materialized default ('high').
      // Re-applying it would revert the pick to the catalog's stale value.
      await hostLoopTurn(adapter, { provider: 'acp', model: 'alpha', sessionId: 'dsh-effort-1', reasoningEffort: 'high', messages: [userTurn('two')] })
      expect(gm.chatSessions('dsh-effort-1')[0]?.reasoningEffort).toBe('off')
    } finally {
      routeBindingRegistry().conversations.delete('dsh-effort-1')
      await gm.shutdownAll()
    }
  }, 30_000)

  it('mirrors the default agent into the request path and purges deleted agents', async () => {
    const gm = new BridgeManager([{ ...def, id: 'alpha' }], bindingHub, 500, `${tmpdir()}/acp-purge-${Date.now()}.json`)
    try {
      await dispatchRpc(gm, 'default/agent-set', { agentId: 'alpha' })
      expect(routeBindingRegistry().defaultModel).toBe('alpha')
      // A conversation bound to the agent, with a model variant recorded.
      routeBindingRegistry().conversations.set('dsh-purge-1', 'alpha@mock-model-a')
      await gm.deleteAgent('alpha')
      expect(routeBindingRegistry().conversations.has('dsh-purge-1')).toBe(false)
      expect(routeBindingRegistry().defaultModel).toBeUndefined()
    } finally {
      await gm.setDefaultAgent(undefined).catch(() => {})
      routeBindingRegistry().conversations.delete('dsh-purge-1')
      await gm.shutdownAll()
    }
  })
})

/**
 * The second half of a branched conversation (`session/chat-fork-adopt` →
 * `adoptForkedSession` → `AgentBridge.forkSession`): the ACP side of the
 * host-fork-then-adopt order. The host's `sessions.fork` is out of scope here —
 * in these tests the DSH child conversation already exists; what is under test
 * is the fourth session-creation point (the SAME `mcpServers` list as
 * `session/new`, the startup timeout, the id de-dup) and the child binding
 * (locked choice copy, `session/meta` republish, persistence).
 */
describe('conversation fork adoption (isolated manager)', () => {
  const forkRoot = mkdtempSync(join(tmpdir(), 'dsh-ntr-fork-'))
  afterAll(() => {
    rmSync(forkRoot, { recursive: true, force: true })
  })

  /** The mock with the UNSTABLE fork knobs on (the base `def` advertises none). */
  const forkDef = (env: Record<string, string>, id: string): AcpAgentDef => ({
    ...def,
    id,
    env: { ...def.env, ...env },
    // Non-empty on purpose: an empty list would make the "same list as
    // session/new" assertion vacuous, and an adopt that sent an empty list
    // would EVICT the live sessions' MCP scope (one list per process).
    mcpServers: [
      { name: 'local', transport: 'stdio', command: '/opt/servers/local', args: ['--mcp'], env: { TOKEN: 'x' } },
      { name: 'remote', transport: 'http', url: 'https://example.test/mcp', headers: { Authorization: 'Bearer t' } },
    ],
  })

  const forkHub = new EventHub()
  const forkEvents: AcpEvent[] = []
  forkHub.subscribe(event => { forkEvents.push(event) })

  function forkWaitFor<T extends AcpEvent['type']>(type: T, predicate: (event: Extract<AcpEvent, { type: T }>) => boolean, timeoutMs = 15_000): Promise<Extract<AcpEvent, { type: T }>> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout waiting for ${type}`)), timeoutMs)
      const unsub = forkHub.subscribe(event => {
        if (event.type === type && predicate(event as Extract<AcpEvent, { type: T }>)) {
          clearTimeout(timer)
          unsub()
          resolve(event as Extract<AcpEvent, { type: T }>)
        }
      })
      const existing = forkEvents.find(event => event.type === type && predicate(event as Extract<AcpEvent, { type: T }>))
      if (existing !== undefined) {
        clearTimeout(timer)
        unsub()
        resolve(existing as Extract<AcpEvent, { type: T }>)
      }
    })
  }

  /** Drive one turn the way the host loop does, so the settled-turn claim is honest. */
  const turn = async (gm: BridgeManager, dshSessionId: string, agentId: string, text = 'hi'): Promise<void> => {
    const request = {
      model: agentId,
      sessionId: dshSessionId,
      messages: [{ role: 'user', content: [{ type: 'text', text }] }],
    } as never
    let messages = request.messages
    for (let step = 0; step < 8; step += 1) {
      const chunks: StreamChunk[] = []
      for await (const chunk of gm.streamPrompt({ ...request, messages } as never)) chunks.push(chunk)
      const finish = chunks.find((c): c is Extract<StreamChunk, { type: 'finish' }> => c.type === 'finish')
      const callIds = [...new Set(chunks.filter(c => c.type === 'tool-call-delta').map(c => (c as { id: string }).id))]
      if (finish === undefined || finish.reason.kind !== 'stop' || callIds.length === 0) return
      messages = [...messages, ...callIds.map(id => ({
        role: 'tool' as const,
        source: { kind: 'tool' as const, callId: id },
        content: [{ type: 'text' as const, text: 'staged result' }],
      }))]
    }
  }

  /** One entry per `session/fork` request the agent actually received. */
  const forkRequests = (logPath: string): Array<{ sessionId?: string; cwd?: string; mcpServers?: Array<Record<string, unknown>> }> =>
    existsSync(logPath)
      ? (readFileSync(logPath, 'utf8').split('\n').filter(line => line.trim() !== '').map(line => JSON.parse(line)))
      : []

  /** The MCP wire list the session named by `sessionId` was created/forked with, echoed through "MCPS". */
  async function echoedMcps(gm: BridgeManager, sessionId: string): Promise<Array<Record<string, unknown>>> {
    await settleTranscript(gm, sessionId)
    const transcript = await dispatchRpc(gm, 'transcript/get', { sessionId })
    if (!transcript.ok) throw new Error('transcript failed')
    const text = (transcript.value as { entries: Array<{ update: Record<string, unknown> }> })
      .entries
      .filter(entry => entry.update.sessionUpdate === 'agent_message_chunk')
      .map(entry => String((entry.update.content as { text?: string }).text ?? ''))
      .join('')
    const begin = text.indexOf('MCPS_BEGIN')
    const end = text.indexOf('MCPS_END')
    if (begin < 0 || end <= begin) throw new Error('the agent never echoed the MCP servers')
    return JSON.parse(text.slice(begin + 'MCPS_BEGIN'.length, end)) as Array<Record<string, unknown>>
  }

  it('adopts a forked child: the fork request carries the session/new mcpServers, the child is registered, the choice is locked, and session/meta is broadcast', async () => {
    const logPath = join(forkRoot, 'adopt-fork.log')
    const storage = join(forkRoot, 'adopt-agents.json')
    const catalog = join(forkRoot, 'adopt-catalog.json')
    const gm = new BridgeManager([forkDef({ MOCK_FORK: '1', MOCK_FORK_LOG: logPath }, 'forky')], forkHub, 500, storage, catalog)
    try {
      gm.bindChatAgent('dsh-fork-parent', 'forky')
      // The FIRST turn doubles as the session/new wire witness: the mock echoes
      // the MCP servers its session was created with.
      await turn(gm, 'dsh-fork-parent', 'forky', 'MCPS please')
      const parentRows = gm.chatSessions('dsh-fork-parent')
      expect(parentRows).toHaveLength(1)
      expect(parentRows[0]).toMatchObject({ agentId: 'forky', fork: { supported: true } })
      const newWire = await echoedMcps(gm, parentRows[0].sessionId)
      expect(newWire.map(entry => entry.name)).toEqual(['local', 'remote'])

      const since = forkEvents.length
      const adopt = await gm.adoptForkedSession('dsh-fork-child', 'dsh-fork-parent')
      expect(adopt.acpSessionId).not.toBe('')

      // The republish the composer's list and occupancy ring react to.
      const meta = forkEvents.slice(since).find(event => event.type === 'session/meta' && event.sessionId === adopt.sessionId)
      expect(meta).toBeDefined()

      // The child is registered under ITS OWN conversation id, with a ready
      // fork verdict of its own (a forked session can fork again).
      const childRows = gm.chatSessions('dsh-fork-child')
      expect(childRows).toHaveLength(1)
      expect(childRows[0]).toMatchObject({ agentId: 'forky', sessionId: adopt.sessionId, fork: { supported: true } })

      // The copied choice, LOCKED: a branched conversation belongs to its agent
      // from birth — the same record the lock writes at a first turn.
      expect(gm.chatChoice('dsh-fork-parent')).toMatchObject({ agentId: 'forky', locked: true })
      expect(gm.chatChoice('dsh-fork-child')).toMatchObject({ agentId: 'forky', locked: true })

      // ...and the write reached the registry file (a host restart keeps it).
      const raw = JSON.parse(readFileSync(storage, 'utf8')) as {
        conversations?: Record<string, { agentId?: string; locked?: boolean }>
        chatSessions?: Array<{ dshSessionId: string; acpSessionId: string }>
      }
      expect(raw.conversations?.['dsh-fork-child']).toMatchObject({ agentId: 'forky', locked: true })
      expect(raw.chatSessions).toContainEqual(expect.objectContaining({ dshSessionId: 'dsh-fork-child', acpSessionId: adopt.acpSessionId }))

      // THE WIRE ASSERTION: exactly one session/fork arrived, it named the
      // parent's ACP session, and it carried the SAME mcpServers list
      // `session/new` received (one list per process — a second shape would
      // evict the live sessions' MCP tools).
      const requests = forkRequests(logPath)
      expect(requests).toHaveLength(1)
      const parentRecord = raw.chatSessions?.find(row => row.dshSessionId === 'dsh-fork-parent')
      expect(parentRecord).toBeDefined()
      expect(requests[0].sessionId).toBe(parentRecord?.acpSessionId)
      expect(requests[0].mcpServers).toEqual(newWire)

      // The child is servable end to end, and ITS session record carries the
      // same list (the forked session is the real thing, not a stub).
      await dispatchRpc(gm, 'session/prompt', { sessionId: adopt.sessionId, text: 'MCPS from the child' })
      await forkWaitFor('turn/end', event => event.sessionId === adopt.sessionId)
      expect(await echoedMcps(gm, adopt.sessionId)).toEqual(newWire)

      // The capability bit landed in the last-known catalog file, so the
      // browser's verdict outlives the agent process.
      const rawCatalog = JSON.parse(readFileSync(catalog, 'utf8')) as { agents?: Record<string, { fork?: boolean }> }
      expect(rawCatalog.agents?.forky?.fork).toBe(true)
    } finally {
      await gm.shutdownAll()
    }
  }, 30_000)

  it('applies the copied choice to the forked session (mode and extra configs ride the adopt)', async () => {
    const gm = new BridgeManager([forkDef({ MOCK_FORK: '1' }, 'forkchoice')], forkHub, 500, join(forkRoot, 'choice-agents.json'))
    try {
      gm.bindChatAgent('dsh-fork-choice-parent', 'forkchoice')
      await turn(gm, 'dsh-fork-choice-parent', 'forkchoice')
      // The parent's picks, recorded AND applied to the parent session. The
      // fork copies agent-side state, but the RECORD is what a later resume
      // re-applies — so the adopt must align the fresh session to it now (the
      // fourth creation point follows create/resume), or the composer shows
      // one thing and the agent runs another.
      await gm.setChatSessionMode('dsh-fork-choice-parent', 'strict')
      await gm.setChatSessionConfig('dsh-fork-choice-parent', 'temp', 'high')
      const since = forkEvents.length
      const adopt = await gm.adoptForkedSession('dsh-fork-choice-child', 'dsh-fork-choice-parent')
      // The mode: the fork response starts the child on the agent's 'default';
      // only applyChatChoice's `session/set_mode` makes the row say 'strict'.
      const childRows = gm.chatSessions('dsh-fork-choice-child')
      expect(childRows[0]?.modes?.currentModeId).toBe('strict')
      // The extra config: the FINAL republish carries the session's options,
      // and the temp option's current value must be the parent's pick, not the
      // forked default ('mid'). Take the LAST meta — the mode alignment's own
      // publishMeta fires before the config alignment runs.
      const metas = forkEvents.slice(since).filter(event => event.type === 'session/meta' && event.sessionId === adopt.sessionId)
      const options = ((metas.at(-1)?.session.configOptions ?? []) as Array<{ configId?: string; currentValue?: unknown }>)
      expect(options.find(option => option.configId === 'temp')?.currentValue).toBe('high')
    } finally {
      await gm.shutdownAll()
    }
  }, 30_000)

  it('applies the configured default mode to a pick-less fork', async () => {
    const gm = new BridgeManager(
      [forkDef({ MOCK_FORK: '1' }, 'forkdefault')],
      forkHub,
      500,
      join(forkRoot, 'default-fork-agents.json'),
    )
    try {
      // The parent runs BEFORE the default exists, so its pick has no mode.
      gm.bindChatAgent('dsh-fork-default-parent', 'forkdefault')
      await turn(gm, 'dsh-fork-default-parent', 'forkdefault')
      expect(gm.chatChoice('dsh-fork-default-parent')?.mode).toBeUndefined()

      // Setting the default mid-conversation leaves that pick alone; the fork
      // is a NEW conversation with no pick, so the adopt must apply it now.
      await gm.setDefaultMode('forkdefault', 'strict')
      const adopt = await gm.adoptForkedSession('dsh-fork-default-child', 'dsh-fork-default-parent')
      expect(adopt.acpSessionId).not.toBe('')
      // The fork copies the agent-side 'default'; without the fallback the
      // child would only flip to 'strict' on its next resume.
      expect(gm.chatSessions('dsh-fork-default-child')[0]?.modes?.currentModeId).toBe('strict')
    } finally {
      await gm.shutdownAll()
    }
  }, 30_000)

  it('refuses to adopt from a released parent with zero fork requests', async () => {
    const logPath = join(forkRoot, 'released-fork.log')
    const gm = new BridgeManager([forkDef({ MOCK_FORK: '1', MOCK_FORK_LOG: logPath }, 'forkrel')], forkHub, 500, join(forkRoot, 'released-agents.json'))
    try {
      gm.bindChatAgent('dsh-fork-released', 'forkrel')
      await turn(gm, 'dsh-fork-released', 'forkrel')
      // Kill the process under the live session: crash → releaseAll parks the
      // record (released ≠ destroyed). A parked parent has no process to fork
      // from — adopting it must refuse before any request goes out.
      await turn(gm, 'dsh-fork-released', 'forkrel', 'DIE now')
      const parentSessionId = gm.chatSessions('dsh-fork-released')[0]?.sessionId
      await forkWaitFor('session/released', event => event.sessionId === parentSessionId)

      await expect(gm.adoptForkedSession('dsh-fork-released-child', 'dsh-fork-released'))
        .rejects.toMatchObject({ code: 'parent_not_live' })
      // The refusal happened BEFORE the request: the agent saw no session/fork
      // (the log file is written by the first request that ever arrives).
      expect(existsSync(logPath)).toBe(false)
      // And nothing was bound for the child either.
      expect(gm.chatSessions('dsh-fork-released-child')).toEqual([])
      expect(gm.chatChoice('dsh-fork-released-child')).toBeUndefined()
    } finally {
      await gm.shutdownAll()
    }
  }, 30_000)

  it('refuses to adopt when the agent never advertised session/fork, with zero requests', async () => {
    // The base mock advertises no fork capability: the capability gate must
    // fire BEFORE the request (an unadvertised method would answer an
    // unknown-method error at best).
    const logPath = join(forkRoot, 'unsupported-fork.log')
    const gm = new BridgeManager(
      [{ ...def, id: 'forknofork', env: { ...def.env, MOCK_FORK_LOG: logPath } }],
      forkHub, 500, join(forkRoot, 'unsupported-agents.json'),
    )
    try {
      gm.bindChatAgent('dsh-fork-nofork', 'forknofork')
      await turn(gm, 'dsh-fork-nofork', 'forknofork')
      expect(gm.chatSessions('dsh-fork-nofork')[0]).toMatchObject({ fork: { supported: false, reason: 'unsupported' } })

      await expect(gm.adoptForkedSession('dsh-fork-nofork-child', 'dsh-fork-nofork'))
        .rejects.toMatchObject({ code: 'fork_unsupported' })
      expect(existsSync(logPath)).toBe(false)
      expect(gm.chatSessions('dsh-fork-nofork-child')).toEqual([])
    } finally {
      await gm.shutdownAll()
    }
  }, 30_000)

  it('refuses a fork answer that names an already-routed session and registers nothing', async () => {
    // The interleaving hazard: an answer naming the parent (or any session on
    // this connection) would route the parent's updates, asks and permission
    // cards into the child. The mock answers with the parent's own id.
    const logPath = join(forkRoot, 'conflict-fork.log')
    const gm = new BridgeManager(
      [forkDef({ MOCK_FORK: '1', MOCK_FORK_MODE: 'conflict', MOCK_FORK_LOG: logPath }, 'forkconflict')],
      forkHub, 500, join(forkRoot, 'conflict-agents.json'),
    )
    try {
      gm.bindChatAgent('dsh-fork-conflict', 'forkconflict')
      await turn(gm, 'dsh-fork-conflict', 'forkconflict')

      await expect(gm.adoptForkedSession('dsh-fork-conflict-child', 'dsh-fork-conflict'))
        .rejects.toMatchObject({ code: 'fork_id_conflict' })
      // The request went out and was answered — but nothing was bound, not
      // even a half record.
      expect(forkRequests(logPath)).toHaveLength(1)
      expect(gm.chatSessions('dsh-fork-conflict-child')).toEqual([])
      expect(gm.chatChoice('dsh-fork-conflict-child')).toBeUndefined()
    } finally {
      await gm.shutdownAll()
    }
  }, 30_000)

  it('times a wedged fork out within the startup window and keeps the bridge usable', async () => {
    // The mock answers every request except session/fork, which never resolves.
    // The adopt must come back bounded by the startup window (the same window
    // every session-creation point carries) — and the in-flight fork counter
    // must settle, so the bridge serves the conversation again afterwards.
    const logPath = join(forkRoot, 'hang-fork.log')
    const gm = new BridgeManager(
      [forkDef({ MOCK_FORK: '1', MOCK_FORK_MODE: 'hang', MOCK_FORK_LOG: logPath }, 'forkhang')],
      forkHub, 500, join(forkRoot, 'hang-agents.json'), undefined, true,
      { startupTimeoutMs: 2_000 },
    )
    try {
      gm.bindChatAgent('dsh-fork-hang', 'forkhang')
      await turn(gm, 'dsh-fork-hang', 'forkhang')

      const startedAt = Date.now()
      let timeoutMessage = ''
      await expect(gm.adoptForkedSession('dsh-fork-hang-child', 'dsh-fork-hang').catch((error: unknown) => {
        timeoutMessage = error instanceof Error ? error.message : String(error)
        throw error
      })).rejects.toMatchObject({ code: 'agent_timeout' })
      // Bounded by the startup window (plus process startup), not by forever;
      // the detail names the request that stalled.
      expect(Date.now() - startedAt).toBeLessThan(15_000)
      expect(timeoutMessage).toContain('session/fork')
      expect(forkRequests(logPath)).toHaveLength(1)
      expect(gm.chatSessions('dsh-fork-hang-child')).toEqual([])

      // The timeout tore the wedged process down (withStartupTimeout kills the
      // child), so the conversation parks — and the NEXT message resumes it on
      // a fresh process: the bridge is not wedged by the dead fork request.
      const parentSessionId = gm.chatSessions('dsh-fork-hang')[0]?.sessionId
      await forkWaitFor('session/released', event => event.sessionId === parentSessionId)
      await turn(gm, 'dsh-fork-hang', 'forkhang', 'hello again')
      expect(gm.chatSessions('dsh-fork-hang')[0]).toMatchObject({ agentId: 'forkhang' })
      expect(gm.chatSessions('dsh-fork-hang')[0]?.released).toBeUndefined()
    } finally {
      await gm.shutdownAll()
    }
  }, 30_000)
})
