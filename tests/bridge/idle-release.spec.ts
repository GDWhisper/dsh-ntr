import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { BridgeManager, type BridgeTuning } from '../../src/bridge.ts'
import { type AcpAgentDef, type AcpEvent, type SubagentRecord } from '../../src/protocol.ts'
import { EventHub } from '../../src/impl.ts'
import { def, until } from './harness.ts'

describe('idle release (isolated manager)', () => {
  async function waitUntil(predicate: () => boolean, timeoutMs = 8_000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (predicate()) return true
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    return predicate()
  }

  function idleManager(id: string, tuning: BridgeTuning, overrides: Partial<AcpAgentDef> = {}): { hub: EventHub; events: AcpEvent[]; manager: BridgeManager } {
    const hub = new EventHub()
    const events: AcpEvent[] = []
    hub.subscribe(event => { events.push(event) })
    const manager = new BridgeManager([{ ...def, id, ...overrides }], hub, 500, undefined, undefined, false, tuning)
    return { hub, events, manager }
  }

  it('releases a probe-spawned process on the probe window, not the chat window', async () => {
    const { events, manager } = idleManager('idle-probe', { idleTimeoutMs: 60_000, probeIdleTimeoutMs: 150 })
    try {
      await manager.probeAgentModels('idle-probe')
      // The probe's throwaway session is deliberately never registered, so the
      // bridge still counts as never-hosted: the short probe window governs
      // even though the chat window is a full minute.
      expect(manager.agentViews()[0]).toMatchObject({ state: 'ready', liveSessions: [] })
      expect(await waitUntil(() => manager.agentViews()[0]?.state === 'stopped')).toBe(true)
      const view = manager.agentViews()[0]
      expect(view?.liveSessions).toEqual([])
      // The view keeps meaning "the chat residency the user configured" — the
      // panel prefills its form from it, so it must not leak probe semantics.
      expect(view?.idleTimeoutMs).toBe(60_000)
      // The release is silent: an idle teardown is the expected lifecycle of a
      // resting process, not a fault — no notice, the status just falls back.
      expect(events.some(event => event.type === 'agent/notice')).toBe(false)
    } finally {
      await manager.shutdownAll()
    }
  }, 30_000)

  it('releases a probe-spawned process even when the agent asked for permanent chat residency', async () => {
    const { manager } = idleManager('idle-probe-forever', { probeIdleTimeoutMs: 150 }, { idleTimeoutMs: 0 })
    try {
      await manager.probeAgentModels('idle-probe-forever')
      // def.idleTimeoutMs = 0 is a promise about the CHAT process; a probe
      // bridge never hosted one and still honors the short probe window.
      expect(await waitUntil(() => manager.agentViews()[0]?.state === 'stopped')).toBe(true)
    } finally {
      await manager.shutdownAll()
    }
  }, 30_000)

  it('never releases a chat process whose agent set idleTimeoutMs to 0', async () => {
    const { manager } = idleManager('idle-off', { idleTimeoutMs: 0 })
    try {
      const { sessionId } = await manager.startSession('idle-off', undefined)
      // Once a real session has landed, the process lives by the agent's own
      // residency rules, and 0 means never — even though the bridge was born
      // from a spawn that (before the session arrived) sat on the probe window.
      await new Promise(resolve => setTimeout(resolve, 600))
      expect(manager.agentViews()[0]).toMatchObject({ state: 'ready', liveSessions: [sessionId] })
    } finally {
      await manager.shutdownAll()
    }
  }, 30_000)

  it('releases an idle chat process on the chat window and resumes its session on the next prompt', async () => {
    const { events, manager } = idleManager('idle-live', { idleTimeoutMs: 200 })
    try {
      const { sessionId } = await manager.startSession('idle-live', undefined)
      // An idle conversation does not keep the process resident: the window
      // passes and the bridge parks the session.
      expect(await waitUntil(() => manager.agentViews()[0]?.state === 'stopped')).toBe(true)
      expect(manager.agentViews()[0]?.liveSessions).toEqual([])
      expect(manager.sessions()).toEqual([expect.objectContaining({ sessionId, released: true })])
      expect(events.some(event => event.type === 'session/released' && event.sessionId === sessionId)).toBe(true)
      expect(events.some(event => event.type === 'agent/notice')).toBe(false)

      // Releasing is not closing: the next prompt respawns and reloads it.
      await manager.prompt(sessionId, 'back again')
      expect(await waitUntil(() => events.some(event => event.type === 'turn/end'
        && event.sessionId === sessionId && event.stopReason === 'end_turn'))).toBe(true)
      expect(manager.agentViews()[0]?.liveSessions).toEqual([sessionId])
      const { entries } = manager.transcript(sessionId, undefined)
      const text = (entries as Array<{ update: Record<string, unknown> }>)
        .filter(entry => entry.update.sessionUpdate === 'agent_message_chunk')
        .map(entry => String((entry.update.content as { text?: string }).text ?? ''))
        .join('')
      expect(text).toContain('REPLAYED: earlier conversation')
      expect(text).toContain('MOCK: echo back again')
    } finally {
      await manager.shutdownAll()
    }
  }, 30_000)

  it('resumes a released chat session on the user\'s explicit gesture', async () => {
    const { events, manager } = idleManager('idle-gesture', { idleTimeoutMs: 200 })
    try {
      const session = await manager.getOrCreateDshSession('dsh-gesture-1', 'idle-gesture')
      const sessionId = session.sessionId
      expect(await waitUntil(() => manager.agentViews()[0]?.state === 'stopped')).toBe(true)
      expect(manager.chatSessions('dsh-gesture-1')).toMatchObject([{ sessionId, released: true }])

      // The banner button: the same recovery the next prompt performs lazily,
      // on the user's gesture instead.
      await manager.resumeChatSession('dsh-gesture-1')
      expect(manager.agentViews()[0]?.liveSessions).toEqual([sessionId])
      expect(manager.chatSessions('dsh-gesture-1')[0]?.released).toBeFalsy()
      // The browser learns of the resume from this frame, not a re-read.
      expect(events.some(event => event.type === 'session/reset' && event.sessionId === sessionId)).toBe(true)
      // The banner promises the context is kept: the load replay must land.
      expect(await waitUntil(() => {
        const entries = manager.chatTranscripts('dsh-gesture-1')[0]?.entries ?? []
        const text = (entries as Array<{ update: Record<string, unknown> }>)
          .filter(entry => entry.update.sessionUpdate === 'agent_message_chunk')
          .map(entry => String((entry.update.content as { text?: string }).text ?? ''))
          .join('')
        return text.includes('REPLAYED: earlier conversation')
      })).toBe(true)

      // A second click while live spawns nothing (idempotent gesture).
      await manager.resumeChatSession('dsh-gesture-1')
      expect(manager.agentViews()[0]?.liveSessions).toEqual([sessionId])

      // A conversation no ACP session ever served says so instead of
      // pretending the button worked.
      await expect(manager.resumeChatSession('dsh-gesture-never'))
        .rejects.toMatchObject({ code: 'unknown_session' })
    } finally {
      await manager.shutdownAll()
    }
  }, 30_000)

  it('records a mode pick on a parked session without waking the process', async () => {
    const { manager } = idleManager('idle-pick', { idleTimeoutMs: 200 })
    try {
      await manager.getOrCreateDshSession('dsh-idle-pick', 'idle-pick')
      expect(await waitUntil(() => manager.agentViews()[0]?.state === 'stopped')).toBe(true)
      const parked = manager.chatSessions('dsh-idle-pick')[0]
      const available = parked?.modes?.availableModes ?? []
      expect(available.length).toBeGreaterThan(1)
      const target = available.find(mode => mode.id !== parked?.modes?.currentModeId)
      expect(target).toBeDefined()

      // The composer's axes on a parked session are "what the next turn should
      // use" — recorded, never applied by force (user decision, 2026-10-30):
      // the process stays parked until the user sends or hits 恢复进程.
      await manager.setChatSessionMode('dsh-idle-pick', target!.id)
      expect(manager.chatChoice('dsh-idle-pick')).toMatchObject({ agentId: 'idle-pick', mode: target!.id })
      expect(manager.chatSessions('dsh-idle-pick')[0]?.modes?.currentModeId).toBe(target!.id)
      expect(manager.agentViews()[0]?.state).toBe('stopped')

      // The next wake applies it (`applyChatChoice`), which is the whole point
      // of a pre-switch.
      await manager.resumeChatSession('dsh-idle-pick')
      expect(manager.chatSessions('dsh-idle-pick')[0]?.modes?.currentModeId).toBe(target!.id)

      // When parked again, changing mode and resuming via prompt path (getOrCreateDshSession)
      // also retains the new mode.
      expect(await waitUntil(() => manager.agentViews()[0]?.state === 'stopped')).toBe(true)
      expect(manager.chatSessions('dsh-idle-pick')[0]?.released).toBe(true)

      const originalMode = parked!.modes!.currentModeId
      await manager.setChatSessionMode('dsh-idle-pick', originalMode)
      expect(manager.chatSessions('dsh-idle-pick')[0]?.modes?.currentModeId).toBe(originalMode)

      const promptResumed = await manager.getOrCreateDshSession('dsh-idle-pick', 'idle-pick')
      expect(promptResumed.modes?.currentModeId).toBe(originalMode)
      expect(manager.chatSessions('dsh-idle-pick')[0]?.modes?.currentModeId).toBe(originalMode)
    } finally {
      await manager.shutdownAll()
    }
  }, 30_000)

  it('updates model and effort on a parked session without waking the process', async () => {
    const { manager } = idleManager('idle-model-pick', { idleTimeoutMs: 200 })
    try {
      await manager.getOrCreateDshSession('dsh-idle-model-pick', 'idle-model-pick')
      expect(await waitUntil(() => manager.agentViews()[0]?.state === 'stopped')).toBe(true)
      const parked = manager.chatSessions('dsh-idle-model-pick')[0]
      expect(parked?.released).toBe(true)

      // Switching model and effort on a parked session immediately updates the
      // in-memory session records and persists them without waking the stopped process.
      await manager.setChatSessionModel('dsh-idle-model-pick', 'idle-model-pick@mock-model-b')
      await manager.setChatSessionEffort('dsh-idle-model-pick', 'off')

      expect(manager.agentViews()[0]?.state).toBe('stopped')
      expect(manager.chatChoice('dsh-idle-model-pick')).toMatchObject({
        agentId: 'idle-model-pick',
        modelId: 'idle-model-pick@mock-model-b',
        effort: 'off',
      })
      const updated = manager.chatSessions('dsh-idle-model-pick')[0]
      expect(updated).toMatchObject({
        modelId: 'idle-model-pick@mock-model-b',
        reasoningEffort: 'off',
        released: true,
      })

      // The next wake applies it and keeps the configuration.
      await manager.resumeChatSession('dsh-idle-model-pick')
      expect(manager.chatSessions('dsh-idle-model-pick')[0]).toMatchObject({
        modelId: 'idle-model-pick@mock-model-b',
        reasoningEffort: 'off',
      })
      expect(manager.chatSessions('dsh-idle-model-pick')[0]?.released).toBeFalsy()

      // When parked again, changing configuration and resuming via the prompt path
      // (getOrCreateDshSession) also retains the new configuration without jumping back.
      expect(await waitUntil(() => manager.agentViews()[0]?.state === 'stopped')).toBe(true)
      expect(manager.chatSessions('dsh-idle-model-pick')[0]?.released).toBe(true)

      await manager.setChatSessionModel('dsh-idle-model-pick', 'idle-model-pick@mock-model-a')
      await manager.setChatSessionEffort('dsh-idle-model-pick', 'high')

      const promptResumed = await manager.getOrCreateDshSession('dsh-idle-model-pick', 'idle-model-pick')
      expect(promptResumed).toMatchObject({
        modelId: 'idle-model-pick@mock-model-a',
        reasoningEffort: 'high',
        released: false,
      })
      expect(manager.chatSessions('dsh-idle-model-pick')[0]).toMatchObject({
        modelId: 'idle-model-pick@mock-model-a',
        reasoningEffort: 'high',
      })
    } finally {
      await manager.shutdownAll()
    }
  }, 30_000)

  it('applies a global idle-release pick to a running bridge, and keeps an agent\'s own override', async () => {
    const { manager } = idleManager('idle-global', { idleTimeoutMs: 60_000 })
    try {
      await manager.startSession('idle-global', undefined)
      expect(manager.agentViews()[0]?.idleTimeoutMs).toBe(60_000)

      // The settings page's pick reaches the RUNNING process: the window is
      // rewritten in place, so the user never has to kill a session to see it.
      await manager.setIdleRelease(300_000)
      expect(manager.agentViews()[0]?.idleTimeoutMs).toBe(300_000)
      expect(manager.idleRelease()).toMatchObject({ idleTimeoutMs: 300_000 })

      // An agent that names its OWN window keeps it — that promise is about
      // the agent, not about the deployment.
      const own = idleManager('idle-own', { idleTimeoutMs: 60_000 }, { idleTimeoutMs: 900_000 })
      try {
        await own.manager.startSession('idle-own', undefined)
        await own.manager.setIdleRelease(300_000)
        expect(own.manager.agentViews()[0]?.idleTimeoutMs).toBe(900_000)
      } finally {
        await own.manager.shutdownAll()
      }

      // A reset drops the pick: the deployment baseline runs again.
      await manager.setIdleRelease(undefined, true)
      expect(manager.idleRelease()).toMatchObject({ idleTimeoutMs: 60_000 })
    } finally {
      await manager.shutdownAll()
    }
  }, 30_000)

  it('resets to the deployment baseline, not to a built-in constant', async () => {
    const { manager } = idleManager('idle-baseline', { idleTimeoutMs: 60_000 })
    try {
      // The deployment names 10 minutes. That is what a reset must return
      // to — resetting to the built-in 30 would silently ignore the file.
      manager.setConfiguredIdleRelease(600_000)
      expect(manager.idleRelease()).toMatchObject({
        idleTimeoutMs: 600_000,
        defaultIdleTimeoutMs: 600_000,
        configuredIdleTimeoutMs: 600_000,
      })
      await manager.setIdleRelease(300_000)
      expect(manager.idleRelease()).toMatchObject({ idleTimeoutMs: 300_000 })
      await manager.setIdleRelease(undefined, true)
      expect(manager.idleRelease()).toMatchObject({ idleTimeoutMs: 600_000 })
    } finally {
      await manager.shutdownAll()
    }
  }, 30_000)

  it('lets the global window reach an agent that pins no window of its own', async () => {
    const { manager } = idleManager('idle-follow', { idleTimeoutMs: 60_000 })
    try {
      await manager.startSession('idle-follow', undefined)
      // The agent names no window, so the global pick governs it: this is the
      // whole point of the setting — a window the user moved in the settings
      // page must REACH the agents that did not pin one.
      await manager.setIdleRelease(300_000)
      expect(manager.agentViews()[0]?.idleTimeoutMs).toBe(300_000)
    } finally {
      await manager.shutdownAll()
    }
  }, 30_000)

  it('persists a global idle-release pick across a host restart', async () => {
    const storage = `${tmpdir()}/acp-idle-global-${Date.now()}.json`
    const hub = new EventHub()
    {
      const manager = new BridgeManager(
        [{ ...def, id: 'idle-persist' }], hub, 500, storage, undefined, undefined, { idleTimeoutMs: 60_000 },
      )
      try {
        await manager.setIdleRelease(900_000)
        expect(manager.idleRelease()).toMatchObject({ idleTimeoutMs: 900_000 })
      } finally {
        await manager.shutdownAll()
      }
    }

    // A fresh manager over the same state dir is a DSH restart: the pick is
    // still in force, because it was persisted with the agent registry.
    const second = new BridgeManager([{ ...def, id: 'idle-persist' }], hub, 500, storage, undefined, undefined, { idleTimeoutMs: 60_000 })
    try {
      expect(second.idleRelease()).toMatchObject({ idleTimeoutMs: 900_000 })
    } finally {
      await second.shutdownAll()
    }
  }, 30_000)

  it('keeps a parked chat session resumable across a host restart', async () => {
    // The session record is what "released ≠ destroyed" means at the process
    // boundary: without it, a DSH restart made the next message silently start
    // a context-less new session and the released banner simply vanished.
    const storage = `${tmpdir()}/acp-restart-resume-${Date.now()}.json`
    const hub = new EventHub()
    let hostSessionId = ''
    {
      const manager = new BridgeManager(
        [{ ...def, id: 'restartable' }], hub, 500, storage, undefined, undefined, { idleTimeoutMs: 200 },
      )
      try {
        // One real turn, so the session has history worth resuming.
        for await (const _ of manager.streamPrompt({
          model: 'restartable',
          sessionId: 'dsh-restart-1',
          messages: [{ role: 'user', content: [{ type: 'text', text: 'remember me' }] }],
        } as never)) { /* drain */ }
        hostSessionId = manager.chatSessions('dsh-restart-1')[0]?.sessionId ?? ''
        expect(hostSessionId).not.toBe('')
        // Park it on the idle window; the release persists the record.
        expect(await waitUntil(() => manager.agentViews()[0]?.state === 'stopped')).toBe(true)
      } finally {
        await manager.shutdownAll()
      }
    }

    // A fresh manager over the same state dir is a DSH restart.
    const second = new BridgeManager([{ ...def, id: 'restartable' }], hub, 500, storage)
    try {
      const restored = second.chatSessions('dsh-restart-1')
      // The released banner's gate (all rows released) sees the conversation
      // again — and the row says history exists on the agent side.
      expect(restored).toMatchObject([{ sessionId: hostSessionId, released: true }])
      expect(second.chatTranscripts('dsh-restart-1')[0]?.session)
        .toMatchObject({ sessionId: hostSessionId, released: true, hasHistory: true })

      // The banner button (or the next message) resumes instead of starting over.
      await second.resumeChatSession('dsh-restart-1')
      expect(second.chatSessions('dsh-restart-1')[0]?.released).toBeFalsy()
      expect(await waitUntil(() => {
        const entries = second.chatTranscripts('dsh-restart-1')[0]?.entries ?? []
        const text = (entries as Array<{ update: Record<string, unknown> }>)
          .filter(entry => entry.update.sessionUpdate === 'agent_message_chunk')
          .map(entry => String((entry.update.content as { text?: string }).text ?? ''))
          .join('')
        return text.includes('REPLAYED: earlier conversation')
      })).toBe(true)
    } finally {
      await second.shutdownAll()
    }
  }, 30_000)

  it('does not resurrect a historical dispatch as running when a resume replays it', async () => {
    // CodeBuddy's `session/load` replays every historical Agent dispatch as a
    // pending `tool_call` plus an in_progress `tool_call_update` — never a
    // terminal frame. Treating that replay as live dispatches rebuilt finished
    // workers as `running` with the resume instant as their start time,
    // overwriting the persisted completed records.
    const storage = `${tmpdir()}/acp-replay-dispatch-${Date.now()}.json`
    const dshSessionId = 'dsh-replay-dispatch'
    let original: SubagentRecord | undefined
    {
      // The knob rides the PERSISTED definition: `loadPersistedAgents` rebuilds
      // defsMap from disk, so a knob only on the second manager would be
      // overwritten. It fires on `session/load` alone, which the first never does.
      const manager = new BridgeManager(
        [{ ...def, id: 'replay-dispatch', env: { MOCK_LOAD_REPLAY_DISPATCH: '1' } }],
        new EventHub(), 500, storage,
      )
      try {
        for await (const _ of manager.streamPrompt({
          model: 'replay-dispatch',
          sessionId: dshSessionId,
          messages: [{ role: 'user', content: [{ type: 'text', text: 'DISPATCH DISPATCHCOMPLETEMETA' }] }],
        } as never)) { /* drain */ }
        await until(() => manager.subagentsFor(dshSessionId).some(row => row.childId === 'acp:agent_dispatch' && row.status === 'completed'))
        original = manager.subagentsFor(dshSessionId).find(row => row.childId === 'acp:agent_dispatch')
        expect(original).toMatchObject({ status: 'completed' })
      } finally {
        await manager.shutdownAll()
      }
    }

    // A fresh manager over the same state dir is a DSH restart; its agent
    // replays the historical dispatch frames during `session/load`.
    const hub2 = new EventHub()
    const events2: AcpEvent[] = []
    hub2.subscribe(event => { events2.push(event) })
    const second = new BridgeManager(
      [{ ...def, id: 'replay-dispatch', env: { MOCK_LOAD_REPLAY_DISPATCH: '1' } }],
      hub2, 500, storage,
    )
    try {
      expect(second.chatSessions(dshSessionId)).toMatchObject([{ released: true }])
      expect(second.subagentsFor(dshSessionId).find(row => row.childId === 'acp:agent_dispatch'))
        .toMatchObject({ status: 'completed', startedAt: original!.startedAt })
      await second.resumeChatSession(dshSessionId)
      const rows = second.subagentsFor(dshSessionId).filter(row => row.childId === 'acp:agent_dispatch')
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({
        status: 'completed',
        startedAt: original!.startedAt,
        endedAt: original!.endedAt,
        counts: original!.counts,
      })
      // The replay must not announce a lifecycle regression either.
      expect(events2.filter((event): event is Extract<AcpEvent, { type: 'subagents/record' }> =>
        event.type === 'subagents/record'
        && event.record.childId === 'acp:agent_dispatch'
        && (event.record.status === 'running' || event.record.status === 'pending'))).toEqual([])
      // The replayed drain announcement is history too: rebuilding a live
      // ambient from it would collect the replayed prose into a background
      // report and wake the chat with a ghost turn once the quiet window ends.
      expect(events2.filter(event => event.type === 'agent/notice'
        && event.text.includes('background task turn'))).toEqual([])
      // Constraint 29: skipping lifecycle bookkeeping must not drop the replay
      // DATA — the dispatch frames and the marker text still reach the view.
      const entries = second.chatTranscripts(dshSessionId)[0]?.entries as Array<{ update: Record<string, unknown> }> | undefined
      expect(entries?.some(entry => entry.update.toolCallId === 'agent_dispatch' && entry.update.sessionUpdate === 'tool_call')).toBe(true)
      expect(entries?.some(entry => entry.update.sessionUpdate === 'agent_message_chunk'
        && String((entry.update.content as { text?: string }).text ?? '').includes('REPLAYED: earlier conversation'))).toBe(true)
      expect(entries?.some(entry => entry.update.sessionUpdate === 'agent_message_chunk'
        && String((entry.update.content as { text?: string }).text ?? '').includes('REPLAYED-DRAIN-ANSWER'))).toBe(true)
    } finally {
      await second.shutdownAll()
    }
  }, 30_000)

  it('does not resurrect an unmarked historical dispatch replayed inside the load window', async () => {
    // An agent that replays without CodeBuddy's history marker: the in-flight
    // `session/load` window alone must keep the replay from creating live
    // dispatches (the ACP spec puts the whole replay before the response).
    const storage = `${tmpdir()}/acp-replay-dispatch-bare-${Date.now()}.json`
    const dshSessionId = 'dsh-replay-dispatch-bare'
    let original: SubagentRecord | undefined
    {
      const manager = new BridgeManager(
        [{ ...def, id: 'replay-bare', env: { MOCK_LOAD_REPLAY_DISPATCH: 'bare' } }],
        new EventHub(), 500, storage,
      )
      try {
        for await (const _ of manager.streamPrompt({
          model: 'replay-bare',
          sessionId: dshSessionId,
          messages: [{ role: 'user', content: [{ type: 'text', text: 'DISPATCH DISPATCHCOMPLETEMETA' }] }],
        } as never)) { /* drain */ }
        await until(() => manager.subagentsFor(dshSessionId).some(row => row.childId === 'acp:agent_dispatch' && row.status === 'completed'))
        original = manager.subagentsFor(dshSessionId).find(row => row.childId === 'acp:agent_dispatch')
      } finally {
        await manager.shutdownAll()
      }
    }
    const second = new BridgeManager(
      [{ ...def, id: 'replay-bare', env: { MOCK_LOAD_REPLAY_DISPATCH: 'bare' } }],
      new EventHub(), 500, storage,
    )
    try {
      await second.resumeChatSession(dshSessionId)
      const rows = second.subagentsFor(dshSessionId).filter(row => row.childId === 'acp:agent_dispatch')
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({ status: 'completed', startedAt: original!.startedAt, counts: original!.counts })
    } finally {
      await second.shutdownAll()
    }
  }, 30_000)

  it('leaves surviving terminal dispatches untouched when an idle release resumes in process', async () => {
    // No host restart here: the LiveSession (and its backgroundDispatches map)
    // survives the idle release, so the replay lands on the KNOWN-dispatch
    // branch. Letting it through would pollute counts / lastActivityAt of a
    // finished worker even though its terminal state cannot regress.
    const storage = `${tmpdir()}/acp-replay-dispatch-inproc-${Date.now()}.json`
    const dshSessionId = 'dsh-replay-dispatch-inproc'
    const hub2 = new EventHub()
    const events2: AcpEvent[] = []
    hub2.subscribe(event => { events2.push(event) })
    const manager = new BridgeManager(
      [{ ...def, id: 'replay-inproc', env: { MOCK_LOAD_REPLAY_DISPATCH: '1' } }],
      hub2, 500, storage, undefined, false, { idleTimeoutMs: 200 },
    )
    try {
      for await (const _ of manager.streamPrompt({
        model: 'replay-inproc',
        sessionId: dshSessionId,
        messages: [{ role: 'user', content: [{ type: 'text', text: 'DISPATCH DISPATCHCOMPLETEMETA' }] }],
      } as never)) { /* drain */ }
      await until(() => manager.subagentsFor(dshSessionId).some(row => row.childId === 'acp:agent_dispatch' && row.status === 'completed'))
      const original = manager.subagentsFor(dshSessionId).find(row => row.childId === 'acp:agent_dispatch')
      // The idle window parks the session; the process dies but the record —
      // and its dispatch map — stay on the same LiveSession object.
      await until(() => manager.agentViews()[0]?.state === 'stopped')
      const since = events2.length
      await manager.resumeChatSession(dshSessionId)
      const rows = manager.subagentsFor(dshSessionId).filter(row => row.childId === 'acp:agent_dispatch')
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({
        status: 'completed',
        startedAt: original!.startedAt,
        endedAt: original!.endedAt,
        counts: original!.counts,
        lastActivityAt: original!.lastActivityAt,
      })
      expect(events2.slice(since).filter((event): event is Extract<AcpEvent, { type: 'subagents/record' }> =>
        event.type === 'subagents/record' && event.record.childId === 'acp:agent_dispatch')).toEqual([])
    } finally {
      await manager.shutdownAll()
    }
  }, 30_000)

  it('does not resurrect a closed session across a host restart', async () => {
    // Closed is destroyed, released is parked — the two must not blur at the
    // persistence boundary (constraint 10).
    const storage = `${tmpdir()}/acp-restart-closed-${Date.now()}.json`
    const hub = new EventHub()
    const manager = new BridgeManager([{ ...def, id: 'closer' }], hub, 500, storage)
    try {
      const session = await manager.getOrCreateDshSession('dsh-restart-2', 'closer')
      await manager.closeSession(session.sessionId)
    } finally {
      await manager.shutdownAll()
    }
    const second = new BridgeManager([{ ...def, id: 'closer' }], hub, 500, storage)
    try {
      expect(second.chatSessions('dsh-restart-2')).toEqual([])
    } finally {
      await second.shutdownAll()
    }
  }, 30_000)

  it('holds the process while a turn is running, then releases it once the turn settles', async () => {
    const { manager } = idleManager('idle-busy', { idleTimeoutMs: 200 })
    try {
      const { sessionId } = await manager.startSession('idle-busy', undefined)
      await manager.prompt(sessionId, 'SLOW please')
      // Two full windows pass while the turn is in flight: being registered is
      // not enough, but RUNNING definitely blocks the release.
      await new Promise(resolve => setTimeout(resolve, 700))
      expect(manager.agentViews()[0]).toMatchObject({ state: 'ready', liveSessions: [sessionId] })
      await manager.cancel(sessionId)
      expect(await waitUntil(() => manager.agentViews()[0]?.state === 'stopped')).toBe(true)
    } finally {
      await manager.shutdownAll()
    }
  }, 30_000)

  it('does not release a process whose agent cannot reload the session', async () => {
    const { manager } = idleManager('idle-no-load', { idleTimeoutMs: 200 }, { env: { MOCK_NO_LOAD: '1' } })
    try {
      const { sessionId } = await manager.startSession('idle-no-load', undefined)
      await new Promise(resolve => setTimeout(resolve, 700))
      // Without `loadSession`, releasing would destroy a conversation that the
      // next prompt could not bring back — the session-less rule still stands.
      expect(manager.agentViews()[0]).toMatchObject({ state: 'ready', liveSessions: [sessionId] })
    } finally {
      await manager.shutdownAll()
    }
  }, 30_000)

  /** The agent_message_chunk text of one session's transcript, joined. */
  function transcriptText(manager: BridgeManager, sessionId: string): string {
    const { entries } = manager.transcript(sessionId, undefined)
    return (entries as Array<{ update: Record<string, unknown> }>)
      .filter(entry => entry.update.sessionUpdate === 'agent_message_chunk')
      .map(entry => String((entry.update.content as { text?: string }).text ?? ''))
      .join('')
  }

  it('releases an archived idle conversation and resumes it on the next prompt', async () => {
    const { events, manager } = idleManager('archive-idle', { idleTimeoutMs: 60_000 })
    try {
      const session = await manager.getOrCreateDshSession('dsh-archive-idle', 'archive-idle')
      const sessionId = session.sessionId
      expect(manager.agentViews()[0]).toMatchObject({ state: 'ready', liveSessions: [sessionId] })

      // Archiving a QUIET conversation is the idle park: the process goes away
      // and the record stays resumable. If this returned `busy` or `none`, the
      // host's archive waterfall would either retry forever or report a
      // release it never performed.
      expect(manager.releaseArchivedSession('dsh-archive-idle')).toBe('released')
      expect(manager.agentViews()[0]).toMatchObject({ state: 'stopped', liveSessions: [] })
      // The record itself is what the browser renders as "parked": losing it
      // would make the archive indistinguishable from a deleted conversation.
      expect(manager.chatSessions('dsh-archive-idle')).toMatchObject([{ sessionId, released: true }])
      // The cause is load-bearing: the runtime log names WHY a process left,
      // and only `archived` tells the user this was the archive gesture.
      expect(events.filter(event => event.type === 'session/released' && event.sessionId === sessionId))
        .toMatchObject([{ cause: 'archived', reason: 'archived chat session' }])

      // Park ≠ destroy: the next message must reload the same conversation on
      // a fresh child, with its history replayed rather than started over.
      await manager.prompt(sessionId, 'back again')
      expect(await waitUntil(() => events.some(event => event.type === 'turn/end'
        && event.sessionId === sessionId && event.stopReason === 'end_turn'))).toBe(true)
      expect(manager.agentViews()[0]?.liveSessions).toEqual([sessionId])
      expect(manager.chatSessions('dsh-archive-idle')[0]?.released).toBeFalsy()
      expect(transcriptText(manager, sessionId)).toContain('REPLAYED: earlier conversation')
    } finally {
      await manager.shutdownAll()
    }
  }, 30_000)

  it('reports an active turn as archive activity and clears it after settle', async () => {
    const { events, manager } = idleManager('archive-active', { idleTimeoutMs: 60_000 })
    try {
      const session = await manager.getOrCreateDshSession('dsh-archive-active', 'archive-active')
      // HANG_DELAY keeps `session/prompt` on air without any output, so the
      // facts are read while the turn is demonstrably still the agent's work.
      await manager.prompt(session.sessionId, 'HANG_DELAY:900')
      expect(manager.archiveActivityFacts('dsh-archive-active')).toMatchObject([{ acpSessionId: session.acpSessionId }])

      // Once the turn settles the same query must go empty: a stale fact would
      // make every later archive attempt report `busy` forever.
      expect(await waitUntil(() => events.some(event => event.type === 'turn/end'
        && event.sessionId === session.sessionId && event.stopReason === 'end_turn'))).toBe(true)
      expect(manager.archiveActivityFacts('dsh-archive-active')).toEqual([])
    } finally {
      await manager.shutdownAll()
    }
  }, 30_000)

  it('keeps the archive release pending while a sibling conversation runs', async () => {
    const { events, manager } = idleManager('archive-sibling', { idleTimeoutMs: 60_000 })
    try {
      // Both conversations ride ONE agent-wide process (the mock is not a
      // per-session agent), so releasing either one kills the other's work.
      const idle = await manager.getOrCreateDshSession('dsh-archive-sib-idle', 'archive-sibling')
      const busy = await manager.getOrCreateDshSession('dsh-archive-sib-busy', 'archive-sibling')
      expect([...(manager.agentViews()[0]?.liveSessions ?? [])].sort())
        .toEqual([idle.sessionId, busy.sessionId].sort())

      await manager.prompt(busy.sessionId, 'HANG_DELAY:900')
      // `busy` rather than a silent park: the host retries later, and the turn
      // the sibling still owns is not lost to a teardown it never agreed to.
      expect(manager.releaseArchivedSession('dsh-archive-sib-idle')).toBe('busy')
      expect(manager.agentViews()[0]?.state).toBe('ready')

      expect(await waitUntil(() => events.some(event => event.type === 'turn/end'
        && event.sessionId === busy.sessionId && event.stopReason === 'end_turn'))).toBe(true)
      expect(manager.releaseArchivedSession('dsh-archive-sib-idle')).toBe('released')
      expect(manager.agentViews()[0]?.state).toBe('stopped')
      // `releaseAll` parks every session of the process, not only the archived
      // one: both records must stay resumable after the shared child disappears.
      expect(manager.chatSessions('dsh-archive-sib-idle')).toMatchObject([{ released: true }])
      expect(manager.chatSessions('dsh-archive-sib-busy')).toMatchObject([{ released: true }])
    } finally {
      await manager.shutdownAll()
    }
  }, 30_000)

  it('refuses an archive release for an agent that cannot reload a parked session', async () => {
    const { events, manager } = idleManager('archive-no-load', { idleTimeoutMs: 60_000 }, { env: { MOCK_NO_LOAD: '1' } })
    try {
      const session = await manager.getOrCreateDshSession('dsh-archive-no-load', 'archive-no-load')
      // Without `session/load` the park would destroy the conversation instead
      // of shelving it, so the conservative verdict is `unsupported` — and the
      // process must be left alone rather than torn down first.
      expect(manager.releaseArchivedSession('dsh-archive-no-load')).toBe('unsupported')
      expect(manager.agentViews()[0]).toMatchObject({ state: 'ready', liveSessions: [session.sessionId] })
      // No frame means the browser was never told the session is parked.
      expect(events.some(event => event.type === 'session/released')).toBe(false)
    } finally {
      await manager.shutdownAll()
    }
  }, 30_000)

  it('archiving an already released conversation emits no second frame', async () => {
    const { events, manager } = idleManager('archive-twice', { idleTimeoutMs: 60_000 })
    try {
      const session = await manager.getOrCreateDshSession('dsh-archive-twice', 'archive-twice')
      expect(manager.releaseArchivedSession('dsh-archive-twice')).toBe('released')
      // The parked record already satisfies the request; a retry is a no-op.
      // A second `session/released` frame would make the runtime log claim two
      // releases for one teardown and could re-trigger the browser's release
      // banner for a conversation that never moved.
      expect(manager.releaseArchivedSession('dsh-archive-twice')).toBe('released')
      expect(events.filter(event => event.type === 'session/released' && event.sessionId === session.sessionId))
        .toHaveLength(1)
    } finally {
      await manager.shutdownAll()
    }
  }, 30_000)

  it('cancels an archived running turn and releases it once the turn settles', async () => {
    const { events, manager } = idleManager('archive-cancel', { idleTimeoutMs: 60_000 })
    try {
      const session = await manager.getOrCreateDshSession('dsh-archive-cancel', 'archive-cancel')
      // `SLOW` keeps the agent waiting for a cancel (unlike `HANG_DELAY`, which
      // completes on its own), so this turn can only end through the stop
      // gesture — exactly the path an archive takes on a running conversation.
      await manager.prompt(session.sessionId, 'SLOW please')
      // The archive write can land while the turn is still owed: the release
      // must wait, and the host's stop gesture is what ends that turn first.
      expect(manager.releaseArchivedSession('dsh-archive-cancel')).toBe('busy')
      manager.cancelArchivedSession('dsh-archive-cancel')
      expect(await waitUntil(() => events.some(event => event.type === 'turn/end'
        && event.sessionId === session.sessionId && event.stopReason === 'cancelled'))).toBe(true)
      // Once the turn is over the next drain parks the conversation — this is
      // the sequence the wiring performs on the turn/end frame.
      expect(manager.releaseArchivedSession('dsh-archive-cancel')).toBe('released')
      expect(manager.chatSessions('dsh-archive-cancel')).toMatchObject([{ released: true }])
    } finally {
      await manager.shutdownAll()
    }
  }, 30_000)
})
