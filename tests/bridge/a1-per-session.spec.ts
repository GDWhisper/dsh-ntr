import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { AcpLlmAdapter, AgentBridge, bridgeKey, BridgeManager, type BridgeTuning, isPerSessionAgent, perSessionLaunchArgs, perSessionLaunchEnv } from '../../src/bridge.ts'
import { type AcpAgentDef, type AcpEvent, type AgentCatalogResult, type ChatSessionView, type StreamChunk } from '../../src/protocol.ts'
import { AcpError, dispatchRpc, EventHub } from '../../src/impl.ts'
import { def, hostLoopTurn, isAlive, killTestProcessTree, until } from './harness.ts'

/**
 * A1: `codebuddy` is a CONNECTION-level single-session agent (one `session/new`
 * evicts the previous one), so the host gives every DSH conversation its own
 * child process. These tests drive two conversations at once over the real
 * production manager and the scripted mock: one child per conversation, one
 * transcript per child, and every teardown scoped to its own bridge.
 */
describe('A1: codebuddy runs one agent process per conversation', () => {
  const codebuddy = (env: Record<string, string> = {}, extra: Partial<AcpAgentDef> = {}): AcpAgentDef => ({
    ...def,
    id: 'codebuddy',
    title: 'CodeBuddy',
    env,
    ...extra,
  })

  interface A1Harness {
    manager: BridgeManager
    hub: EventHub
    events: AcpEvent[]
    dir: string
    config: string
    catalog: string
    close: () => Promise<void>
  }

  function makeHarness(defs: AcpAgentDef[], tuning?: BridgeTuning): A1Harness {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-ntr-a1-'))
    const hub = new EventHub()
    const events: AcpEvent[] = []
    hub.subscribe(event => events.push(event))
    const config = join(dir, 'agents.json')
    const catalog = join(dir, 'model-catalog.json')
    const manager = new BridgeManager(defs, hub, 500, config, catalog, false, tuning)
    return {
      manager,
      hub,
      events,
      dir,
      config,
      catalog,
      close: async () => {
        await manager.shutdownAll()
        rmSync(dir, { recursive: true, force: true })
      },
    }
  }

  /** Restart over the SAME on-disk state, so chatSessions restore from the file. */
  function reboot(harness: A1Harness, defs: AcpAgentDef[]): A1Harness {
    const hub = new EventHub()
    const events: AcpEvent[] = []
    hub.subscribe(event => events.push(event))
    const manager = new BridgeManager(defs, hub, 500, harness.config, harness.catalog, false)
    return {
      manager,
      hub,
      events,
      dir: harness.dir,
      config: harness.config,
      catalog: harness.catalog,
      close: async () => {
        await manager.shutdownAll()
        rmSync(harness.dir, { recursive: true, force: true })
      },
    }
  }

  function waitEvent<T extends AcpEvent['type']>(
    harness: A1Harness,
    type: T,
    predicate: (event: Extract<AcpEvent, { type: T }>) => boolean,
    timeoutMs = 15_000,
    since = 0,
  ): Promise<Extract<AcpEvent, { type: T }>> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        unsub()
        reject(new Error(`timeout waiting for ${type}`))
      }, timeoutMs)
      const unsub = harness.hub.subscribe(event => {
        if (event.type !== type) return
        const candidate = event as Extract<AcpEvent, { type: T }>
        if (!predicate(candidate)) return
        clearTimeout(timer)
        unsub()
        resolve(candidate)
      })
      const existing = harness.events
        .slice(since)
        .find(event => event.type === type && predicate(event as Extract<AcpEvent, { type: T }>))
      if (existing !== undefined) {
        clearTimeout(timer)
        unsub()
        resolve(existing as Extract<AcpEvent, { type: T }>)
      }
    })
  }

  /** Run one full chat turn (including the mock's tool-card continuation step). */
  async function chatTurn(harness: A1Harness, dshSessionId: string, text: string): Promise<string> {
    const adapter = new AcpLlmAdapter(harness.manager)
    const { chunks } = await hostLoopTurn(adapter, {
      provider: 'acp',
      model: 'codebuddy',
      sessionId: dshSessionId,
      messages: [{ role: 'user', content: [{ type: 'text', text }] }],
    })
    return chunks
      .filter((chunk): chunk is Extract<StreamChunk, { type: 'text-delta' }> => chunk.type === 'text-delta')
      .map(chunk => chunk.text)
      .join('')
  }

  function pidOf(answer: string): number {
    const match = /PID:(\d+)/.exec(answer)
    if (match === null) throw new Error(`no PID tag in ${answer}`)
    return Number(match[1])
  }

  function transcriptText(harness: A1Harness, dshSessionId: string): string {
    return harness.manager.chatTranscripts(dshSessionId)
      .flatMap(view => view.entries)
      .filter(entry => (entry.update as { sessionUpdate?: string }).sessionUpdate === 'agent_message_chunk')
      .map(entry => (entry.update as { content?: { text?: string } }).content?.text ?? '')
      .join('')
  }

  function chatRow(harness: A1Harness, dshSessionId: string): ChatSessionView | undefined {
    return harness.manager.chatSessions(dshSessionId)[0]
  }

  function bridgeMap(harness: A1Harness): Map<string, AgentBridge> {
    return (harness.manager as unknown as { bridges: Map<string, AgentBridge> }).bridges
  }

  function chatBridge(harness: A1Harness, dshSessionId: string): AgentBridge | undefined {
    return bridgeMap(harness).get(bridgeKey('codebuddy', { kind: 'chat', dshSessionId }))
  }

  /** The live child's pid, for "the process really died" assertions. */
  function livePid(bridge: AgentBridge | undefined): number | undefined {
    return (bridge as unknown as { child?: { pid?: number } } | undefined)?.child?.pid
  }

  it('A1: two concurrent conversations never share a process, an answer or a transcript', async () => {
    // With MOCK_SINGLE_SESSION the mock evicts whichever session the connection
    // served before: two answers at once are only possible with two children.
    const harness = makeHarness([codebuddy({ MOCK_SINGLE_SESSION: '1' })])
    try {
      const [answerA, answerB] = await Promise.all([
        chatTurn(harness, 'a1-concurrent-a', 'PIDTAG alpha words'),
        chatTurn(harness, 'a1-concurrent-b', 'PIDTAG beta words'),
      ])
      const pidA = pidOf(answerA)
      const pidB = pidOf(answerB)

      // One child per conversation: the same agent id, two processes.
      expect(pidA).not.toBe(pidB)
      expect(answerA).toContain('MOCK: echo PIDTAG alpha words')
      expect(answerA).toContain(`PID:${pidA}`)
      expect(answerB).toContain('MOCK: echo PIDTAG beta words')
      expect(answerB).toContain(`PID:${pidB}`)
      expect(answerA).not.toContain('beta words')
      expect(answerB).not.toContain('alpha words')

      const rowA = chatRow(harness, 'a1-concurrent-a')
      const rowB = chatRow(harness, 'a1-concurrent-b')
      expect(rowA?.sessionId).toBeDefined()
      expect(rowB?.sessionId).toBeDefined()
      expect(rowA?.sessionId).not.toBe(rowB?.sessionId)

      // Transcripts are per child, not one connection-level replay.
      expect(transcriptText(harness, 'a1-concurrent-a')).toContain('alpha words')
      expect(transcriptText(harness, 'a1-concurrent-a')).not.toContain('beta words')
      expect(transcriptText(harness, 'a1-concurrent-b')).toContain('beta words')
      expect(transcriptText(harness, 'a1-concurrent-b')).not.toContain('alpha words')
    } finally {
      await harness.close()
    }
  }, 30_000)

  it('A1: one conversation crashing releases only that conversation and leaves the other intact', async () => {
    const harness = makeHarness([codebuddy()])
    try {
      const before = await chatTurn(harness, 'a1-crash-b', 'PIDTAG beta before crash')
      const pidB = pidOf(before)
      const alpha = await chatTurn(harness, 'a1-crash-a', 'PIDTAG alpha before crash')
      const pidA = pidOf(alpha)
      expect(pidA).not.toBe(pidB)

      const rowA = chatRow(harness, 'a1-crash-a')
      const since = harness.events.length
      const released = waitEvent(harness, 'session/released', event => event.sessionId === rowA?.sessionId, 15_000, since)
      // DIE exits the child mid-turn; the adapter may finish with an error frame.
      await chatTurn(harness, 'a1-crash-a', 'DIE now').catch(() => '')
      await released
      await until(() => !isAlive(pidA))

      expect(chatRow(harness, 'a1-crash-a')?.released).toBe(true)
      expect(chatRow(harness, 'a1-crash-b')?.released).toBeUndefined()
      const releaseFrames = harness.events.slice(since).filter(event => event.type === 'session/released')
      expect(releaseFrames).toHaveLength(1)

      // The healthy conversation kept its own child and its own context.
      const after = await chatTurn(harness, 'a1-crash-b', 'PIDTAG beta after crash')
      expect(pidOf(after)).toBe(pidB)
      expect(after).toContain('MOCK: echo PIDTAG beta after crash')
      expect(transcriptText(harness, 'a1-crash-b')).toContain('beta before crash')
    } finally {
      await harness.close()
    }
  }, 40_000)

  it('A1: a conversation whose process fails to initialize does not take the healthy one down', async () => {
    const harness = makeHarness([codebuddy()])
    try {
      const healthy = await chatTurn(harness, 'a1-init-ok', 'PIDTAG beta healthy')
      const pidB = pidOf(healthy)

      // Only THIS conversation's child gets an unlaunchable command: the
      // per-session bridge fails to initialize while the sibling keeps working.
      const defs = (harness.manager as unknown as { defsMap: Map<string, AcpAgentDef> }).defsMap
      const real = defs.get('codebuddy')
      if (real === undefined) throw new Error('codebuddy def missing')
      defs.set('codebuddy', { ...real, command: 'dsh-ntr-a1-no-such-binary-xyz' })
      try {
        await expect(harness.manager.getOrCreateDshSession('a1-init-fail', 'codebuddy')).rejects.toThrow()
      } finally {
        defs.set('codebuddy', real)
      }

      const failedBridge = [...bridgeMap(harness).values()]
        .find(bridge => bridge.def.id === 'codebuddy' && bridge.state === 'error')
      expect(failedBridge).toBeDefined()
      expect(failedBridge?.errorText).toMatch(/failed to start|agent_unreachable|ENOENT|not found|connection closed/i)

      // A ready sibling wins the aggregate: the agent as a whole is still usable.
      expect(harness.manager.agentViews()[0]?.state).toBe('ready')
      const again = await chatTurn(harness, 'a1-init-ok', 'PIDTAG beta again')
      expect(pidOf(again)).toBe(pidB)
      expect(transcriptText(harness, 'a1-init-ok')).toContain('beta healthy')
    } finally {
      await harness.close()
    }
  }, 30_000)

  it('A1: a child that fails to start leaves one error notice even beside a ready sibling', async () => {
    const harness = makeHarness([codebuddy()])
    try {
      const healthy = await chatTurn(harness, 'a1-notice-ok', 'PIDTAG beta healthy')
      const pidB = pidOf(healthy)
      const since = harness.events.length

      // Only THIS conversation's child gets an unlaunchable command, so the
      // aggregate `agent/status` stays `ready` (the sibling serves) and the
      // failure would otherwise be invisible in the settings log.
      const defs = (harness.manager as unknown as { defsMap: Map<string, AcpAgentDef> }).defsMap
      const real = defs.get('codebuddy')
      if (real === undefined) throw new Error('codebuddy def missing')
      defs.set('codebuddy', { ...real, command: 'dsh-ntr-a1-no-such-binary-xyz' })
      try {
        await expect(harness.manager.getOrCreateDshSession('a1-notice-fail', 'codebuddy')).rejects.toThrow()
      } finally {
        defs.set('codebuddy', real)
      }

      const notices = harness.events.slice(since)
        .filter((event): event is Extract<AcpEvent, { type: 'agent/notice' }> => event.type === 'agent/notice' && event.agentId === 'codebuddy')
      expect(notices).toHaveLength(1)
      expect(notices[0]?.level).toBe('error')
      expect(notices[0]?.text).toContain('failed to start')
      // The notice is the ONLY place this text lives: the aggregate status must
      // not turn a working agent into an error one just because a sibling died.
      expect(harness.manager.agentViews()[0]?.state).toBe('ready')
      const again = await chatTurn(harness, 'a1-notice-ok', 'PIDTAG beta again')
      expect(pidOf(again)).toBe(pidB)
    } finally {
      await harness.close()
    }
  }, 30_000)

  it('A1: idle release is per conversation and the recovered one resets before loading', async () => {
    const harness = makeHarness([codebuddy()], { idleTimeoutMs: 250 })
    try {
      const alpha = await chatTurn(harness, 'a1-idle-a', 'PIDTAG alpha idle')
      const pidA = pidOf(alpha)
      const rowA = chatRow(harness, 'a1-idle-a')
      const since = harness.events.length

      // Keep the second conversation BUSY: its own child must survive A's release.
      const slow = chatTurn(harness, 'a1-idle-b', 'SLOW hold')
      await until(() => chatRow(harness, 'a1-idle-b')?.running === true)
      const released = waitEvent(harness, 'session/released', event => event.sessionId === rowA?.sessionId, 15_000, since)
      await released
      await until(() => !isAlive(pidA))

      expect(chatBridge(harness, 'a1-idle-a')?.state).toBe('stopped')
      expect(chatBridge(harness, 'a1-idle-b')?.state).toBe('ready')
      expect(chatRow(harness, 'a1-idle-a')?.released).toBe(true)
      expect(chatRow(harness, 'a1-idle-b')?.released).toBeUndefined()

      const rowB = chatRow(harness, 'a1-idle-b')
      await dispatchRpc(harness.manager, 'session/cancel', { sessionId: rowB?.sessionId })
      await slow

      // Recovery: the transcript is reset BEFORE `session/load` replays it,
      // otherwise the replay would be wiped by the reset that came later.
      const resumeSince = harness.events.length
      const resumed = await chatTurn(harness, 'a1-idle-a', 'after idle release')
      expect(resumed).toContain('MOCK: echo after idle release')
      const resumeEvents = harness.events.slice(resumeSince)
      const reset = resumeEvents.findIndex(event => event.type === 'session/reset' && event.sessionId === rowA?.sessionId)
      const start = resumeEvents.findIndex(event => event.type === 'turn/start' && event.sessionId === rowA?.sessionId)
      expect(reset).toBeGreaterThanOrEqual(0)
      expect(start).toBeGreaterThanOrEqual(0)
      expect(reset).toBeLessThan(start)
      const transcript = transcriptText(harness, 'a1-idle-a')
      expect(transcript).toContain('REPLAYED: earlier conversation')
      expect(transcript).toContain('after idle release')
    } finally {
      await harness.close()
    }
  }, 40_000)

  it('A1: a silent first turn that never answers still lets the idle clock release its child', async () => {
    // HANG: the prompt request never resolves and every cancel is ignored. The
    // stall watchdog force-finalizes the empty first turn, the rollback closes
    // the session — and the outstanding prompt stays on air forever. The idle
    // clock must still be able to end that process (constraint 19): a request
    // left on a closed session must not pin the child for the host's lifetime.
    const harness = makeHarness([codebuddy()], {
      turnStallMs: 200,
      turnStallTickMs: 30,
      idleTimeoutMs: 250,
      turnSettleMs: 150,
      cancelFallbackMs: 200,
    })
    try {
      const since = harness.events.length
      let pid: number | undefined
      const turn = chatTurn(harness, 'a1-abandoned', 'HANG never answers')
      await until(() => {
        // Capture INSIDE the predicate: `livePid` reads the holder's child, and
        // the release clears that reference later.
        const candidate = livePid(chatBridge(harness, 'a1-abandoned'))
        if (candidate !== undefined) pid = candidate
        return pid !== undefined
      }, 15_000)
      await turn
      expect(pid).toBeDefined()
      // Keep the identity around after the rollback forgets the conversation.
      const created = harness.events.slice(since)
        .find((event): event is Extract<AcpEvent, { type: 'session/created' }> => event.type === 'session/created')
      expect(created).toBeDefined()
      const abandonedSessionId = created?.sessionId
      // The watchdog forgot the conversation and the rollback closed the session.
      await until(() => chatRow(harness, 'a1-abandoned') === undefined, 15_000)
      // The idle clock — not a next message, not `prune` — must end the child.
      await until(() => !isAlive(pid as number), 15_000)
      // ...and it did so WITHOUT a session frame: a teardown that parks or closes
      // a session publishes `session/released` / `session/closed` for it, while
      // the idle release ends a child whose only record is already forgotten.
      // The absence is the evidence that another lifecycle path did not kill it.
      expect(harness.events.filter(event => event.type === 'session/released' && event.sessionId === abandonedSessionId)).toHaveLength(0)
      // ...and once the abandoned request's `finally` runs, the holder itself is
      // discarded: nothing lingers for a conversation the watchdog already forgot.
      await until(() => chatBridge(harness, 'a1-abandoned') === undefined, 15_000)
    } finally {
      await harness.close()
    }
  }, 40_000)

  it('A1: a live record with no owning holder fails as session_orphaned and never spawns', async () => {
    // The fallback exists for a record whose process is gone while the
    // bookkeeping still says LIVE. Production teardown always parks the record
    // first (`closed` or `released`), so this state is SYNTHETIC: the test pins
    // the fallback contract by detaching the session from its holder — so
    // `hasSession` / `hasReleased` / `inflightResume` all miss — keeping the
    // record in `dshSessionMap`, and letting the child die. This is NOT the
    // resume-in-flight path.
    const harness = makeHarness([codebuddy()])
    try {
      const answer = await chatTurn(harness, 'a1-orphan', 'PIDTAG first life')
      const pid = pidOf(answer)
      const sessionId = chatRow(harness, 'a1-orphan')?.sessionId
      expect(sessionId).toBeDefined()

      const holder = chatBridge(harness, 'a1-orphan')
      if (holder === undefined) throw new Error('holder missing')
      const internals = harness.manager as unknown as {
        bridges: Map<string, AgentBridge>
        registry: { dshSessionMap: Map<string, { sessionId: string; acpSessionId?: string; closed?: boolean; released?: boolean }> }
      }
      const recordKey = 'a1-orphan:codebuddy'
      const record = internals.registry.dshSessionMap.get(recordKey)
      expect(record?.sessionId).toBe(sessionId)
      expect(record?.closed).toBeFalsy()
      expect(record?.released).toBeFalsy()

      // Detach the OWNERSHIP only, then let the child die. Production
      // `closeSession` / `forceReset` drop BOTH indexes, so the synthetic residue
      // must do the same: an `acpIndex` entry alone is not ownership, but leaving
      // it behind would make the fixture differ from the real teardown shape.
      // (`parkSessions` would flip this record to released if it were still in
      // `sessions`, which is a different branch — resume, not the fallback.)
      const detached = holder as unknown as {
        sessions: Map<string, unknown>
        acpIndex: Map<string, unknown>
      }
      detached.sessions.delete(sessionId as string)
      expect(record?.acpSessionId).toBeDefined()
      detached.acpIndex.delete(record?.acpSessionId as string)
      killTestProcessTree(pid)
      await until(() => !isAlive(pid))
      // The OS probe answers before the child's `exit` handler runs: wait for the
      // holder to record the death, otherwise the state assertion below races the
      // bridge's own teardown (and would read the stale `ready`).
      await until(() => chatBridge(harness, 'a1-orphan')?.state === 'stopped')
      expect(internals.registry.dshSessionMap.get(recordKey)?.released).toBeFalsy()

      const createdBefore = harness.events.filter(event => event.type === 'session/created').length
      let orphanError: unknown
      try {
        await harness.manager.getOrCreateDshSession('a1-orphan', 'codebuddy')
        throw new Error('expected session_orphaned')
      } catch (error) {
        orphanError = error
      }
      expect(orphanError).toBeInstanceOf(AcpError)
      expect((orphanError as AcpError).code).toBe('session_orphaned')
      // Forget ran BEFORE the throw: the unusable record must not survive.
      expect(internals.registry.dshSessionMap.has(recordKey)).toBe(false)
      // No hidden spawn, three ways. The `session/created` count alone is NOT
      // sufficient: a spawn whose frame was lost would slip past it. The two
      // load-bearing guards are the `stopped` state and the absent child below —
      // do not drop them; without them this assertion protects nothing.
      expect(harness.events.filter(event => event.type === 'session/created')).toHaveLength(createdBefore)
      expect(chatBridge(harness, 'a1-orphan')?.state).toBe('stopped')
      expect(livePid(chatBridge(harness, 'a1-orphan'))).toBeUndefined()

      // The retry takes the CREATION path and serves a real answer on a new child.
      const again = await chatTurn(harness, 'a1-orphan', 'PIDTAG second life')
      expect(again).toContain('MOCK: echo PIDTAG second life')
      expect(pidOf(again)).not.toBe(pid)
    } finally {
      await harness.close()
    }
  }, 40_000)

  it('A1: stopAgent stops every conversation process and forgets every session', async () => {
    const harness = makeHarness([codebuddy()])
    try {
      const alpha = await chatTurn(harness, 'a1-stop-a', 'PIDTAG alpha stop')
      const pidA = pidOf(alpha)
      const beta = await chatTurn(harness, 'a1-stop-b', 'PIDTAG beta stop')
      const pidB = pidOf(beta)
      expect(pidA).not.toBe(pidB)

      const stopped = await dispatchRpc(harness.manager, 'agent/stop', { agentId: 'codebuddy' })
      expect(stopped.ok).toBe(true)
      await until(() => !isAlive(pidA) && !isAlive(pidB))

      expect(harness.manager.agentViews()[0]?.state).toBe('stopped')
      expect(harness.manager.sessions()).toEqual([])
      expect(bridgeMap(harness).size).toBe(0)
    } finally {
      await harness.close()
    }
  }, 30_000)

  it('A1: deleteAgent clears every bridge and scope, not just the bare agent key', async () => {
    const harness = makeHarness([codebuddy()])
    try {
      const alpha = await chatTurn(harness, 'a1-delete-a', 'PIDTAG alpha delete')
      const beta = await chatTurn(harness, 'a1-delete-b', 'PIDTAG beta delete')
      const pids = [pidOf(alpha), pidOf(beta)]
      const internals = harness.manager as unknown as {
        bridges: Map<string, AgentBridge>
        bridgeScopes: Map<string, unknown>
      }
      expect(internals.bridges.size).toBe(2)
      expect(internals.bridgeScopes.size).toBe(2)

      const deleted = await dispatchRpc(harness.manager, 'agent/delete', { agentId: 'codebuddy' })
      expect(deleted.ok).toBe(true)
      await until(() => pids.every(pid => !isAlive(pid)))

      expect(harness.manager.agentViews()).toEqual([])
      expect(internals.bridges.size).toBe(0)
      expect(internals.bridgeScopes.size).toBe(0)

      // The next boot reads the same file: the agent is gone, not half-present.
      const booted = new BridgeManager([], harness.hub, 500, harness.config, harness.catalog, false)
      try {
        expect(booted.agentViews()).toEqual([])
        expect((booted as unknown as { bridges: Map<string, AgentBridge> }).bridges.size).toBe(0)
      } finally {
        await booted.shutdownAll()
      }
    } finally {
      await harness.close()
    }
  }, 30_000)

  it('A1: saveAgent stops every old process before the rebuilt definition serves a new one', async () => {
    const harness = makeHarness([codebuddy()])
    try {
      const alpha = await chatTurn(harness, 'a1-save-a', 'PIDTAG alpha save')
      const beta = await chatTurn(harness, 'a1-save-b', 'PIDTAG beta save')
      const oldPids = [pidOf(alpha), pidOf(beta)]
      expect(oldPids[0]).not.toBe(oldPids[1])

      await harness.manager.saveAgent({ ...codebuddy(), title: 'CodeBuddy rebuilt' }, 'direct')
      await until(() => oldPids.every(pid => !isAlive(pid)))
      // saveAgent kicks an async catalog probe; it prunes its own bridge when done.
      await until(() => bridgeMap(harness).size === 0, 15_000)

      expect(harness.manager.sessions()).toEqual([])
      expect([...bridgeMap(harness).keys()]).toEqual([])
      const view = harness.manager.agentViews().find(agent => agent.id === 'codebuddy')
      expect(view?.title).toBe('CodeBuddy rebuilt')
      expect(view?.state).toBe('stopped')

      const fresh = await chatTurn(harness, 'a1-save-a', 'PIDTAG alpha after save')
      expect(oldPids).not.toContain(pidOf(fresh))
      expect(fresh).toContain('MOCK: echo PIDTAG alpha after save')
    } finally {
      await harness.close()
    }
  }, 40_000)

  it('A1: agentViews aggregates two ready children, one crash, an all-crash set, and no bridge', async () => {
    const harness = makeHarness([codebuddy()])
    try {
      const alpha = await chatTurn(harness, 'a1-view-a', 'PIDTAG alpha view')
      const beta = await chatTurn(harness, 'a1-view-b', 'PIDTAG beta view')
      expect(pidOf(alpha)).not.toBe(pidOf(beta))
      const rowA = chatRow(harness, 'a1-view-a')
      const rowB = chatRow(harness, 'a1-view-b')

      // Two ready children: one view, the union of their live sessions.
      let view = harness.manager.agentViews()[0]
      expect(view?.state).toBe('ready')
      expect(new Set(view?.liveSessions ?? [])).toEqual(new Set([rowA?.sessionId, rowB?.sessionId]))

      // One crash: the ready sibling wins the state, only it stays live.
      const sinceA = harness.events.length
      const releaseA = waitEvent(harness, 'session/released', event => event.sessionId === rowA?.sessionId, 15_000, sinceA)
      await chatTurn(harness, 'a1-view-a', 'DIE now').catch(() => '')
      await releaseA
      view = harness.manager.agentViews()[0]
      expect(view?.state).toBe('ready')
      expect(view?.liveSessions).toEqual([rowB?.sessionId])

      // All crashed: every child is parked, so the aggregate is stopped.
      const sinceB = harness.events.length
      const releaseB = waitEvent(harness, 'session/released', event => event.sessionId === rowB?.sessionId, 15_000, sinceB)
      await chatTurn(harness, 'a1-view-b', 'DIE now').catch(() => '')
      await releaseB
      view = harness.manager.agentViews()[0]
      expect(view?.state).toBe('stopped')
      expect(view?.liveSessions).toEqual([])
      expect(bridgeMap(harness).size).toBe(2)

      // No bridge at all: the pre-spawn shape, not an error or a ghost session.
      await dispatchRpc(harness.manager, 'agent/stop', { agentId: 'codebuddy' })
      expect(bridgeMap(harness).size).toBe(0)
      view = harness.manager.agentViews()[0]
      expect(view?.state).toBe('stopped')
      expect(view?.liveSessions).toEqual([])
      expect(view?.stderrTail).toBeUndefined()
      expect(view?.agentInfo).toBeUndefined()
    } finally {
      await harness.close()
    }
  }, 40_000)

  it('A1: fork stays hard-disabled even when the agent advertises the capability', async () => {
    // MOCK_FORK=1 makes the mock's initialize declare fork support; A1 must
    // still refuse, because one process per conversation leaves no connection
    // to fork on.
    const harness = makeHarness([codebuddy({ MOCK_FORK: '1' })])
    try {
      const answer = await chatTurn(harness, 'a1-fork-parent', 'PIDTAG alpha fork')
      expect(answer).toContain('MOCK: echo PIDTAG alpha fork')
      const row = chatRow(harness, 'a1-fork-parent')
      expect(row?.fork).toEqual({ supported: false, reason: 'unsupported' })

      await expect(harness.manager.adoptForkedSession('a1-fork-child', 'a1-fork-parent'))
        .rejects.toMatchObject({ code: 'fork_unsupported' })
      // No second ACP session, no second child: only the parent's bridge exists.
      expect(chatRow(harness, 'a1-fork-child')).toBeUndefined()
      expect(harness.manager.sessions()).toHaveLength(1)
      expect(bridgeMap(harness).size).toBe(1)
    } finally {
      await harness.close()
    }
  }, 30_000)

  it('A1: a catalog probe runs in its own process and leaves the conversation untouched', async () => {
    const harness = makeHarness([codebuddy()])
    try {
      const answer = await chatTurn(harness, 'a1-probe-a', 'PIDTAG alpha before probe')
      const pidA = pidOf(answer)
      const transcriptBefore = transcriptText(harness, 'a1-probe-a')

      const internals = harness.manager as unknown as { bridges: Map<string, AgentBridge> }
      const created: AgentBridge[] = []
      const rawSet = internals.bridges.set
      internals.bridges.set = function patched(key: string, value: AgentBridge) {
        created.push(value)
        return Map.prototype.set.call(internals.bridges, key, value)
      }
      let probePid: number | undefined
      try {
        const probing = harness.manager.probeAgentModels('codebuddy')
        // Catch the probe child while it is alive: node startup outlives a few polls.
        const deadline = Date.now() + 10_000
        while (Date.now() < deadline && probePid === undefined) {
          probePid = created.map(livePid).find(pid => pid !== undefined && pid !== pidA)
          if (probePid === undefined) await new Promise(resolve => setTimeout(resolve, 5))
        }
        expect(probePid).toBeDefined()
        expect(probePid).not.toBe(pidA)
        await probing
      } finally {
        internals.bridges.set = rawSet
      }

      // The probe bridge is pruned; the chat child still serves the same pid.
      expect(bridgeMap(harness).has(bridgeKey('codebuddy', { kind: 'probe' }))).toBe(false)
      expect(isAlive(pidA)).toBe(true)
      expect(chatBridge(harness, 'a1-probe-a')?.state).toBe('ready')
      expect(transcriptText(harness, 'a1-probe-a')).toBe(transcriptBefore)
      expect(transcriptText(harness, 'a1-probe-a')).not.toContain('REPLAYED')

      const again = await chatTurn(harness, 'a1-probe-a', 'PIDTAG alpha after probe')
      expect(pidOf(again)).toBe(pidA)
      expect(again).toContain('MOCK: echo PIDTAG alpha after probe')
    } finally {
      await harness.close()
    }
  }, 30_000)

  it('A1: launch args and env drop the CodeBuddy listener only for codebuddy', () => {
    // The stdio child must not race for 127.0.0.1:6156.
    expect(perSessionLaunchArgs(['--acp', '--port', '6156'], 'codebuddy')).toEqual(['--acp'])
    expect(perSessionLaunchArgs(['--port=6156'], 'codebuddy')).toEqual([])
    expect(perSessionLaunchArgs(['--acp', '--port=6156', '--verbose'], 'codebuddy')).toEqual(['--acp', '--verbose'])
    expect(perSessionLaunchArgs(['--acp', '--port', '6156'], 'other')).toEqual(['--acp', '--port', '6156'])

    const env = {
      SERVER__PORT: '6156',
      SERVER__HOST: '127.0.0.1',
      server__port: 'lowercase',
      Server__Host: 'mixedcase',
      KEEP: 'ok',
    }
    // Both sources, every case spelling, are dropped for codebuddy.
    expect(perSessionLaunchEnv(env, 'codebuddy')).toEqual({ KEEP: 'ok' })
    expect(perSessionLaunchEnv({ SERVER__PORT: 'p', SERVER__HOST: 'h' }, 'codebuddy')).toEqual({})
    // Non-codebuddy keeps the very object it was handed.
    expect(perSessionLaunchEnv(env, 'other')).toBe(env)
    expect(env.SERVER__PORT).toBe('6156')
    expect(isPerSessionAgent('codebuddy')).toBe(true)
    expect(isPerSessionAgent('other')).toBe(false)
  })

  it('A1: two /acp sessions get two processes and closing one prunes only its bridge', async () => {
    const harness = makeHarness([codebuddy()])
    try {
      const first = await dispatchRpc(harness.manager, 'session/start', { agentId: 'codebuddy' })
      const second = await dispatchRpc(harness.manager, 'session/start', { agentId: 'codebuddy' })
      expect(first.ok).toBe(true)
      expect(second.ok).toBe(true)
      if (!first.ok || !second.ok) throw new Error('session/start failed')
      const idA = (first.value as { sessionId: string }).sessionId
      const idB = (second.value as { sessionId: string }).sessionId
      expect(idA).not.toBe(idB)

      const bridgeFor = (sessionId: string): AgentBridge | undefined =>
        [...bridgeMap(harness).values()].find(bridge => bridge.sessionList.some(session => session.sessionId === sessionId))
      const pidA = livePid(bridgeFor(idA))
      const pidB = livePid(bridgeFor(idB))
      expect(pidA).toBeDefined()
      expect(pidB).toBeDefined()
      expect(pidA).not.toBe(pidB)
      expect(bridgeMap(harness).size).toBe(2)

      const closed = await dispatchRpc(harness.manager, 'session/close', { sessionId: idA })
      expect(closed.ok).toBe(true)
      await until(() => bridgeFor(idA) === undefined)
      await until(() => !isAlive(pidA as number))

      // Only A's ephemeral bridge is gone; B keeps its process and session.
      expect(bridgeMap(harness).size).toBe(1)
      expect(bridgeFor(idB)?.state).toBe('ready')
      expect(isAlive(pidB as number)).toBe(true)
      expect(harness.manager.sessions().map(view => view.sessionId)).toEqual([idB])
    } finally {
      await harness.close()
    }
  }, 30_000)

  it('A1: persisted conversations resume into their own processes, one spawn at a time', async () => {
    const harness = makeHarness([codebuddy()])
    let booted: A1Harness | undefined
    try {
      const alpha = await chatTurn(harness, 'a1-restore-a', 'PIDTAG alpha restore')
      const beta = await chatTurn(harness, 'a1-restore-b', 'PIDTAG beta restore')
      const oldPidA = pidOf(alpha)
      expect(pidOf(beta)).not.toBe(oldPidA)
      const rowA = chatRow(harness, 'a1-restore-a')
      const rowB = chatRow(harness, 'a1-restore-b')
      await harness.manager.shutdownAll()

      booted = reboot(harness, [codebuddy()])
      const restored = booted.manager.sessions()
      expect(restored).toHaveLength(2)
      expect(restored.every(view => view.released === true)).toBe(true)
      expect(restored.map(view => view.sessionId).sort()).toEqual([rowA?.sessionId, rowB?.sessionId].sort())
      const liveChildren = (): AgentBridge[] =>
        [...bridgeMap(booted as A1Harness).values()].filter(bridge => bridge.state !== 'stopped')
      expect(liveChildren()).toHaveLength(0)

      // Resuming A spawns exactly ONE process; B stays parked.
      const resumedA = await chatTurn(booted, 'a1-restore-a', 'PIDTAG alpha resumed')
      const pidResumedA = pidOf(resumedA)
      expect(pidResumedA).not.toBe(oldPidA)
      expect(liveChildren()).toHaveLength(1)
      expect(chatRow(booted, 'a1-restore-b')?.released).toBe(true)
      expect(transcriptText(booted, 'a1-restore-a')).toContain('alpha resumed')
      expect(transcriptText(booted, 'a1-restore-a')).not.toContain('beta resumed')

      // B then gets its own child, not A's.
      const resumedB = await chatTurn(booted, 'a1-restore-b', 'PIDTAG beta resumed')
      const pidResumedB = pidOf(resumedB)
      expect(pidResumedB).not.toBe(pidResumedA)
      expect(liveChildren()).toHaveLength(2)
      expect(transcriptText(booted, 'a1-restore-b')).toContain('beta resumed')
      expect(transcriptText(booted, 'a1-restore-b')).not.toContain('alpha resumed')
    } finally {
      if (booted !== undefined) await booted.close()
      else await harness.close()
    }
  }, 50_000)

  it('A1: two conversations still report one catalog and one command cache', async () => {
    const harness = makeHarness([codebuddy({}, { exposedModels: ['mock-model-a', 'mock-model-b'] })])
    try {
      await Promise.all([
        chatTurn(harness, 'a1-catalog-a', 'PIDTAG alpha catalog'),
        chatTurn(harness, 'a1-catalog-b', 'PIDTAG beta catalog'),
      ])
      const rowA = chatRow(harness, 'a1-catalog-a')
      const rowB = chatRow(harness, 'a1-catalog-b')
      expect(rowA?.availableCommands).toEqual([{ name: 'greet', description: 'say hi' }])
      expect(rowB?.availableCommands).toEqual([{ name: 'greet', description: 'say hi' }])

      const catalog = await dispatchRpc(harness.manager, 'agent/catalog', { agentId: 'codebuddy' })
      expect(catalog.ok).toBe(true)
      if (!catalog.ok) throw new Error('agent/catalog failed')
      const variants = (catalog.value as AgentCatalogResult).variants
      const ids = variants.map(variant => variant.id)
      expect(ids).toHaveLength(2)
      expect(new Set(ids).size).toBe(ids.length)
      expect(new Set(ids)).toEqual(new Set(['codebuddy@mock-model-a', 'codebuddy@mock-model-b']))

      // The persisted cache is keyed by AGENT, not by process: two children
      // reporting the same options must not append a second row or command.
      const persisted = JSON.parse(readFileSync(harness.catalog, 'utf-8')) as {
        agents?: Record<string, { catalog?: { model?: { choices?: Array<{ value: string }> } }; commands?: unknown[] }>
      }
      const row = persisted.agents?.codebuddy
      expect(row?.commands).toHaveLength(1)
      expect(row?.commands?.[0]).toMatchObject({ name: 'greet' })
      const modelValues = row?.catalog?.model?.choices?.map(choice => choice.value) ?? []
      expect(modelValues).toEqual(['mock-model-a', 'mock-model-b'])
    } finally {
      await harness.close()
    }
  }, 30_000)

  it('A1: a conversation created while a stop is running cannot outlive the teardown', async () => {
    const harness = makeHarness([codebuddy()])
    const internals = harness.manager as unknown as {
      bridges: Map<string, AgentBridge>
      bridgeScopes: Map<string, unknown>
      registry: { dshSessionMap: Map<string, unknown> }
    }
    // Capture every holder the manager ever registers, so a child spawned in
    // the stop window is checked for life even after its key is swept.
    const created: AgentBridge[] = []
    const rawSet = internals.bridges.set
    internals.bridges.set = function patched(key: string, value: AgentBridge): Map<string, AgentBridge> {
      created.push(value)
      return Map.prototype.set.call(internals.bridges, key, value)
    }
    try {
      const pidA = pidOf(await chatTurn(harness, 'a1-stop-a', 'PIDTAG alpha before stop'))
      const pidB = pidOf(await chatTurn(harness, 'a1-stop-b', 'PIDTAG beta before stop'))
      expect(pidA).not.toBe(pidB)

      // `stopAgent` sets its gate synchronously and only then awaits the
      // teardowns, so this call lands INSIDE the stop's await window.
      const stopping = harness.manager.stopAgent('codebuddy')
      await expect(harness.manager.getOrCreateDshSession('a1-stop-new', 'codebuddy'))
        .rejects.toMatchObject({ code: 'agent_stopping' })
      await stopping

      // No record without a holder: the rejected conversation never became a
      // `dshSessionMap` entry, and the two real ones were forgotten.
      expect(internals.registry.dshSessionMap.size).toBe(0)
      expect(chatRow(harness, 'a1-stop-new')).toBeUndefined()
      expect(harness.manager.sessions()).toEqual([])
      // The key sweep left nothing behind, scopes included.
      expect(internals.bridges.size).toBe(0)
      expect(internals.bridgeScopes.size).toBe(0)
      // ...and no child of this agent — including one a raced create might have
      // spawned — is still alive.
      await until(() => !isAlive(pidA) && !isAlive(pidB), 15_000)
      for (const bridge of created) {
        const pid = livePid(bridge)
        if (pid !== undefined) expect(isAlive(pid)).toBe(false)
      }
    } finally {
      internals.bridges.set = rawSet
      await harness.close()
    }
  }, 40_000)

  it('A1: a failed first turn prunes its holder once the close settles', async () => {
    const harness = makeHarness([codebuddy()])
    const internals = harness.manager as unknown as { bridges: Map<string, AgentBridge> }
    // The chat holder is pruned by the rollback itself, so keep a reference to
    // it (and its child) from the registration to assert the child really died.
    const created: AgentBridge[] = []
    const rawSet = internals.bridges.set
    internals.bridges.set = function patched(key: string, value: AgentBridge): Map<string, AgentBridge> {
      created.push(value)
      return Map.prototype.set.call(internals.bridges, key, value)
    }
    try {
      // EMPTY: bookkeeping only, then a legal end_turn — zero visible output.
      // The provisional first turn rolls back, forgets the record and closes
      // the session; the holder must go with it.
      const turn = chatTurn(harness, 'a1-rollback', 'EMPTY first turn')
      // Capture the pid INSIDE the predicate: by the time `turn` resolves the
      // prune may already have killed the child, and the holder object is the
      // only thing that still remembers which process it was.
      let deadPid: number | undefined
      await until(() => {
        for (const bridge of created) {
          const pid = livePid(bridge)
          if (pid !== undefined) deadPid = pid
        }
        return deadPid !== undefined
      }, 15_000)
      await turn
      expect(deadPid).toBeDefined()

      const key = bridgeKey('codebuddy', { kind: 'chat', dshSessionId: 'a1-rollback' })
      // The prune runs after the agent-side close settles, so wait for it.
      await until(() => internals.bridges.get(key) === undefined, 15_000)
      await until(() => !isAlive(deadPid as number), 15_000)
      expect(chatRow(harness, 'a1-rollback')).toBeUndefined()
      expect(harness.manager.sessions()).toEqual([])
      expect([...internals.bridges.values()].filter(bridge => bridge.def?.id === 'codebuddy')).toHaveLength(0)
    } finally {
      internals.bridges.set = rawSet
      await harness.close()
    }
  }, 40_000)

  it('A1: a resume in flight keeps its record and never mints a second ACP session', async () => {
    const harness = makeHarness([codebuddy({ MOCK_LOAD_DELAY_MS: '1200' })], { idleTimeoutMs: 250 })
    try {
      const firstAnswer = await chatTurn(harness, 'a1-resume-race', 'PIDTAG remember this conversation')
      expect(pidOf(firstAnswer)).toBeGreaterThan(0)
      const row = chatRow(harness, 'a1-resume-race')
      const sessionId = row?.sessionId
      expect(sessionId).toBeDefined()

      // Idle release parks the record and stops its child.
      await until(() => chatRow(harness, 'a1-resume-race')?.released === true, 15_000)
      const releasedPid = livePid(chatBridge(harness, 'a1-resume-race'))
      if (releasedPid !== undefined) await until(() => !isAlive(releasedPid), 15_000)

      // The /acp side starts the recovery. `MOCK_LOAD_DELAY_MS` holds the
      // `session/load` RESPONSE open, so right now the record sits in neither
      // `released` nor `sessions` — owned only by the inflight request.
      const resuming = harness.manager.setMode(sessionId as string, 'default')
      await until(
        () => [...bridgeMap(harness).values()].some(bridge => bridge.inflightResume(sessionId as string) !== undefined),
        15_000,
      )

      // A chat message for the SAME conversation lands inside that window. It
      // must wait for the recovery and reuse the record — not declare an
      // orphan and delete it.
      const same = await harness.manager.getOrCreateDshSession('a1-resume-race', 'codebuddy')
      expect(same.sessionId).toBe(sessionId)

      await resuming
      expect(harness.manager.sessions().map(view => view.sessionId)).toEqual([sessionId])
      const holder = chatBridge(harness, 'a1-resume-race')
      // One live ACP session on the holder: a second `session/new` would show 2.
      expect(holder?.sessionList).toHaveLength(1)
      expect(transcriptText(harness, 'a1-resume-race')).toContain('REPLAYED: earlier conversation')
      expect(chatRow(harness, 'a1-resume-race')?.released ?? false).toBe(false)

      // The conversation is usable: the follow-up turn answers from the SAME
      // recovered child, and still only one session exists.
      const resumedPid = livePid(holder)
      const secondAnswer = await chatTurn(harness, 'a1-resume-race', 'PIDTAG still here')
      expect(pidOf(secondAnswer)).toBe(resumedPid)
      expect(harness.manager.sessions().map(view => view.sessionId)).toEqual([sessionId])
      expect(chatBridge(harness, 'a1-resume-race')?.sessionList).toHaveLength(1)
    } finally {
      await harness.close()
    }
  }, 40_000)

  it('A1: stopping a provisional first turn settles as cancelled, not a connection error', async () => {
    const logPath = join(tmpdir(), `dsh-ntr-a1-abort-${String(Date.now())}.log`)
    // The mock shows NOTHING before waiting for the cancel (a provisional first
    // turn only rolls back when it has shown nothing), acknowledges the stop at
    // once, and holds its RESPONSE. That keeps `session/prompt` in flight while
    // the rollback closes the session and the holder wants to prune — the exact
    // window a premature prune would kill the child inside.
    const harness = makeHarness([codebuddy({
      MOCK_PROMPT_LOG: logPath,
      MOCK_CANCEL_ANSWER_DELAY_MS: '1000',
    })])
    try {
      const controller = new AbortController()
      const turn = hostLoopTurn(new AcpLlmAdapter(harness.manager), {
        provider: 'acp',
        model: 'codebuddy',
        sessionId: 'a1-abort-first',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'SILENTSLOW first turn' }] }],
      }, 8, controller.signal)
      // Abort only after the mock RECEIVED the prompt: the delayed answer then
      // guarantees the request is still outstanding when the prune runs.
      await until(
        () => existsSync(logPath) && readFileSync(logPath, 'utf8').includes('SILENTSLOW'),
        15_000,
      )
      const sessionId = chatRow(harness, 'a1-abort-first')?.sessionId
      expect(sessionId).toBeDefined()
      const ended = waitEvent(harness, 'turn/end', event => event.sessionId === sessionId, 20_000)
      controller.abort()
      const { chunks } = await turn
      const finish = chunks.find((chunk): chunk is Extract<StreamChunk, { type: 'finish' }> => chunk.type === 'finish')
      expect(finish).toBeDefined()
      // The user pressed STOP. The turn must settle as cancelled: a prune that
      // killed the child while the prompt was on air would reject it and publish
      // an ERROR frame instead.
      const end = await ended
      expect(end.stopReason).toBe('cancelled')
      expect(end.error).toBeUndefined()
    } finally {
      rmSync(logPath, { force: true })
      await harness.close()
    }
  }, 40_000)
})
