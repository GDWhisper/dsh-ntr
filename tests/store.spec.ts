import { describe, expect, it, vi } from 'vitest'
import { AcpStore, permissionsForSession } from '../src/client/store.ts'
import { acpModeFromPresetEvent, stagedIsAcpMode } from '../src/client/acp-ui.tsx'
import type { AcpAgentDef, ChatSessionView, DetectedAgentInfo } from '../src/protocol.ts'
import { makeStore } from './store/harness.ts'

describe('AcpStore agent management', () => {
  it('reads the ACP-mode preset state from the harness roster on resync', async () => {
    const endpoints: string[] = []
    const store = new (await import('../src/client/store.ts')).AcpStore(
      async (_channel, endpoint) => {
        endpoints.push(endpoint)
        if (endpoint === 'agents/list') return { ok: true, value: { agents: [] } }
        if (endpoint === 'sessions/list') return { ok: true, value: { sessions: [] } }
        if (endpoint === 'agents/detect') return { ok: true, value: { agents: [] } }
        if (endpoint === 'preset/status') {
          return {
            ok: true,
            value: {
              preset: {
                id: 'acp',
                source: 'dsh-ntr/presets/acp/acp.patch.yml',
                installed: false,
                problem: 'acp-guard: cannot find module',
              },
            },
          }
        }
        return { ok: true, value: {} }
      },
      (zh) => zh,
    )

    await store.resync()
    expect(endpoints).toContain('preset/status')
    // The failure mode this card exists for: the declaration is in place but
    // the harness could not activate it, and the diagnostic travels to the UI.
    expect(store.getSnapshot().preset).toMatchObject({ installed: false, problem: 'acp-guard: cannot find module' })
  })

  it('hides the preset block when the host serves no roster', async () => {
    const store = new (await import('../src/client/store.ts')).AcpStore(
      async (_channel, endpoint) => {
        if (endpoint === 'agents/list') return { ok: true, value: { agents: [] } }
        if (endpoint === 'sessions/list') return { ok: true, value: { sessions: [] } }
        if (endpoint === 'agents/detect') return { ok: true, value: { agents: [] } }
        // Either shape means "this host cannot report a roster": an endpoint it
        // does not serve, or one that answers `null` (no `agentPresets` service).
        if (endpoint === 'preset/status') return { ok: true, value: { preset: null } }
        return { ok: true, value: {} }
      },
      (zh) => zh,
    )
    await store.resync()
    expect(store.getSnapshot().preset).toBeUndefined()

    const older = new (await import('../src/client/store.ts')).AcpStore(
      async (_channel, endpoint) => {
        if (endpoint === 'agents/list') return { ok: true, value: { agents: [] } }
        if (endpoint === 'sessions/list') return { ok: true, value: { sessions: [] } }
        if (endpoint === 'agents/detect') return { ok: true, value: { agents: [] } }
        if (endpoint === 'preset/status') return { ok: false, error: { code: 'unknown_endpoint', message: 'acp: unknown endpoint' } }
        return { ok: true, value: {} }
      },
      (zh) => zh,
    )
    await older.resync()
    expect(older.getSnapshot().preset).toBeUndefined()
  })

  it('reads the host version on resync and hides it on a host without the endpoint', async () => {
    const store = new (await import('../src/client/store.ts')).AcpStore(
      async (_channel, endpoint) => {
        if (endpoint === 'agents/list') return { ok: true, value: { agents: [] } }
        if (endpoint === 'sessions/list') return { ok: true, value: { sessions: [] } }
        if (endpoint === 'agents/detect') return { ok: true, value: { agents: [] } }
        if (endpoint === 'plugin/version') return { ok: true, value: { version: '1.2.3' } }
        return { ok: true, value: {} }
      },
      (zh) => zh,
    )
    await store.resync()
    expect(store.getSnapshot().pluginVersion).toBe('1.2.3')

    // An older host half answers `unknown endpoint`; the badge stays hidden.
    const older = new (await import('../src/client/store.ts')).AcpStore(
      async (_channel, endpoint) => {
        if (endpoint === 'agents/list') return { ok: true, value: { agents: [] } }
        if (endpoint === 'sessions/list') return { ok: true, value: { sessions: [] } }
        if (endpoint === 'agents/detect') return { ok: true, value: { agents: [] } }
        if (endpoint === 'plugin/version') return { ok: false, error: { code: 'unknown_endpoint', message: 'acp: unknown endpoint' } }
        return { ok: true, value: {} }
      },
      (zh) => zh,
    )
    await older.resync()
    expect(older.getSnapshot().pluginVersion).toBeUndefined()
  })


  it('shows the settings ledger whenever any ask is pending', async () => {
    // The conversation dock answers the asks belonging to the open
    // conversation; the ledger is the cross-session mirror for everything it
    // cannot show (another conversation, or no chat identity at all).
    const { permissionLedgerCard } = await import('../src/client/panel.tsx')
    const pending = [{
      requestId: 'r1',
      sessionId: 's1',
      dshSessionId: 'chat-1',
      toolName: 'Bash',
      reason: 'Bash · echo hi',
      options: [{ optionId: 'allow1', name: 'Allow once', kind: 'allow_once' }],
      timeoutMode: 'abort' as const,
      deadlineAt: 1_700_000_300_000,
    }]

    expect(permissionLedgerCard({ permissions: pending })).toEqual({ visible: true })
    expect(permissionLedgerCard({ permissions: [] })).toEqual({ visible: false })
  })

  it('round-trips the agent MCP server list through the settings form', async () => {
    // The MCP list lives in the agent DEFINITION, so the form must carry it:
    // an agent whose MCP servers are configured must not lose them because
    // the user opened the settings page and saved some OTHER field.
    const { buildPayload, initialForm, payloadEquals } = await import('../src/client/panel.tsx')
    const mcpServers = [
      { name: 'local', transport: 'stdio' as const, command: '/opt/servers/local', args: ['--mcp'] },
      { name: 'remote', transport: 'http' as const, url: 'https://example.test/mcp' },
    ]
    const config: AcpAgentDef = {
      id: 'pi',
      title: 'pi',
      command: 'pi-acp',
      args: [],
      env: {},
      allowedCwdRoots: [],
      mcpServers,
    }
    const detected: DetectedAgentInfo = {
      id: 'pi',
      name: 'pi',
      detected: true,
      defaultCommand: 'pi-acp',
      defaultArgs: [],
      currentConfig: config,
    }

    // The form seeds itself from the stored list…
    const form = initialForm(detected, undefined)
    expect(form.mcpText).toContain('"local"')

    // …and saving it unchanged is NOT a change (otherwise the card would be
    // permanently dirty and every save would restart the agent).
    const payload = buildPayload(form, detected, false)
    expect(payload.mcpServers).toEqual(mcpServers)
    expect(payloadEquals(payload, config)).toBe(true)

    // Reformatting the text (reordering keys, re-indenting) is not a change
    // either.
    const reformatted = initialForm(detected, undefined)
    reformatted.mcpText = JSON.stringify([{ transport: 'http', url: 'https://example.test/mcp', name: 'remote' }, { name: 'local', command: '/opt/servers/local', args: ['--mcp'], transport: 'stdio' }], null, 4)
    expect(payloadEquals(buildPayload(reformatted, detected, false), config)).toBe(true)

    // An agent with no MCP servers sends none, and an empty list is the same
    // state as none.
    const bare: AcpAgentDef = { id: 'pi', title: 'pi', command: 'pi-acp', args: [], env: {}, allowedCwdRoots: [] }
    const bareDetected: DetectedAgentInfo = { ...detected, currentConfig: bare }
    const bareForm = initialForm(bareDetected, undefined)
    expect(bareForm.mcpText).toBe('')
    expect(buildPayload(bareForm, bareDetected, false).mcpServers).toBeUndefined()
    expect(payloadEquals(buildPayload(bareForm, bareDetected, false), bare)).toBe(true)
  })

  it('loads the chat-bound ACP sessions by chat id and switches the agent mode', async () => {
    const calls: Array<{ endpoint: string; payload: unknown }> = []
    let listed = { sessions: [] as unknown[] }
    const store = new AcpStore(async (_channel, endpoint, payload) => {
      calls.push({ endpoint, payload })
      if (endpoint === 'session/chat-list') return { ok: true, value: listed }
      if (endpoint === 'session/chat-mode-set') return { ok: true, value: { done: true } }
      return { ok: true, value: {} }
    }, (zh) => zh)

    // A chat the agent has not run in yet: nothing to render, and the store
    // records which chat the empty answer belongs to.
    await store.loadChatSessions('chat-1')
    expect(store.getSnapshot().chatSessions).toEqual([])
    expect(store.getSnapshot().chatSessionsFor).toBe('chat-1')

    listed = { sessions: [{ agentId: 'pi', sessionId: 's1', modes: { currentModeId: 'default', availableModes: [{ id: 'strict', name: 'Strict' }] } }] }
    await store.loadChatSessions('chat-1')
    expect(store.getSnapshot().chatSessions).toHaveLength(1)

    await store.setChatSessionMode('chat-1', 'strict', 'pi')
    // The switch rides the lightweight endpoint, then the binding is re-read so
    // a rejected switch cannot leave an optimistic value on screen.
    expect(calls.filter(c => c.endpoint === 'session/chat-mode-set')).toEqual([
      { endpoint: 'session/chat-mode-set', payload: { dshSessionId: 'chat-1', modeId: 'strict', agentId: 'pi' } },
    ])
    expect(calls.at(-1)?.endpoint).toBe('session/chat-list')
    expect(store.getSnapshot().notice).toBeUndefined()
  })

  it('resumes a released chat session on request and reports failures to the caller', async () => {
    const calls: Array<{ endpoint: string; payload: unknown }> = []
    let failResume = false
    const store = new AcpStore(async (_channel, endpoint, payload) => {
      calls.push({ endpoint, payload })
      if (endpoint === 'session/chat-resume') {
        return failResume
          ? { ok: false, error: { code: 'resume_unsupported', message: 'acp: agent cannot load sessions' } }
          : { ok: true, value: { done: true } }
      }
      if (endpoint === 'session/chat-list') {
        return { ok: true, value: { sessions: [{ agentId: 'pi', sessionId: 's1', released: true }] } }
      }
      return { ok: true, value: {} }
    }, (zh) => zh)

    await store.resumeChatSession('chat-1')
    expect(calls.filter(c => c.endpoint === 'session/chat-resume')).toEqual([
      { endpoint: 'session/chat-resume', payload: { dshSessionId: 'chat-1' } },
    ])
    // The binding is re-read after the gesture so the row follows the host —
    // the same contract the mode switch follows.
    expect(calls.at(-1)?.endpoint).toBe('session/chat-list')
    expect(store.getSnapshot().notice).toBeUndefined()

    // A failure is flashed to the notice AND rethrown (the banner pins it
    // beside the button the user just pressed).
    failResume = true
    await expect(store.resumeChatSession('chat-1')).rejects.toThrow('cannot load sessions')
    expect(store.getSnapshot().notice).toContain('cannot load sessions')
    expect(calls.at(-1)?.endpoint).toBe('session/chat-list')
  })

  it('makes a caller that arrives mid-read wait for THAT read', async () => {
    let release: (() => void) | undefined
    const reads: string[] = []
    const store = new AcpStore(async (_channel, endpoint) => {
      if (endpoint === 'session/chat-list') {
        reads.push('read')
        await new Promise<void>(resolve => { release = resolve })
        return { ok: true, value: { sessions: [{ agentId: 'pi', sessionId: 's1', availableCommands: [{ name: 'compact' }] }] } }
      }
      return { ok: true, value: {} }
    }, (zh) => zh)

    const first = store.loadChatSessions('chat-1')
    // The slash source asks while the composer's read is still in flight: it
    // must receive the answer of that read, not resolve against the old state.
    const second = store.loadChatSessions('chat-1')
    release?.()
    await Promise.all([first, second])
    expect(reads).toEqual(['read'])
    expect(store.chatSessionCommands('chat-1')).toEqual([{ name: 'compact' }])
  })

  it('degrades silently when the host has no chat-session mode surface', async () => {
    const store = new AcpStore(async () => ({ ok: false, error: { code: 'unknown_endpoint', message: 'nope' } }), (zh) => zh)
    await store.loadChatSessions('chat-1')
    expect(store.getSnapshot().chatSessions).toEqual([])
    expect(store.getSnapshot().notice).toBeUndefined()

    await store.setChatSessionMode('chat-1', 'strict')
    // A failed switch is surfaced (the user asked for it), unlike the probe.
    expect(store.getSnapshot().notice).toContain('nope')
  })

  it('records the per-session ACP-mode verdict from session/chat-list and invalidates it', async () => {
    const store = new AcpStore(async (_channel, endpoint) => {
      if (endpoint === 'session/chat-list') return { ok: true, value: { sessions: [], acpMode: true } }
      return { ok: true, value: {} }
    }, (zh) => zh)
    await store.loadChatSessions('chat-1')
    expect(store.getSnapshot().acpMode['chat-1']).toBe(true)

    // The preset switch the session committed rewrites what the log says: the
    // held verdict must go, or the seat gate would trust a moved-past answer.
    store.invalidateAcpMode('chat-1')
    expect(store.getSnapshot().acpMode).toEqual({})
    // Invalidating an unknown id stays a no-op (no listener churn).
    store.invalidateAcpMode('chat-1')
    store.invalidateAcpMode()
    expect(store.getSnapshot().acpMode).toEqual({})
  })

  it('keeps no ACP-mode verdict when an older host half omits the field', async () => {
    const store = new AcpStore(async (_channel, endpoint) => {
      if (endpoint === 'session/chat-list') return { ok: true, value: { sessions: [] } }
      return { ok: true, value: {} }
    }, (zh) => zh)
    await store.loadChatSessions('chat-1')
    // Absent field = no fact either way: the seat gate reads this as "ask
    // unanswered" and keeps the native seat, never a false ACP claim.
    expect(store.getSnapshot().acpMode).toEqual({})
  })

  it('records the agent binding optimistically on the click and folds the host answer over it', async () => {
    // The click is the whole user-visible contract of the agent picker: the
    // chip must name the picked agent immediately. The live-session list cannot
    // do that (a switch materializes its session only on the next message), so
    // the store carries the binding itself and lets the host read confirm it.
    const store = new AcpStore(async (_channel, endpoint) => {
      if (endpoint === 'session/chat-list') return { ok: true, value: { sessions: [], boundAgentId: 'omp' } }
      return { ok: true, value: { done: true } }
    }, (zh) => zh)

    await store.bindChatAgent('chat-1', 'omp')
    expect(store.getSnapshot().chatBoundAgent['chat-1']).toBe('omp')

    // The host read (the click path re-reads) confirms the same binding.
    await store.loadChatSessions('chat-1')
    expect(store.getSnapshot().chatBoundAgent['chat-1']).toBe('omp')
    // A different conversation keeps its own binding.
    await store.loadChatSessions('chat-2')
    expect(store.getSnapshot().chatBoundAgent['chat-2']).toBe('omp')

    // An older host half without the field: the optimistic value stands.
    const legacy = new AcpStore(async (_channel, endpoint) => {
      if (endpoint === 'session/chat-list') return { ok: true, value: { sessions: [] } }
      return { ok: true, value: { done: true } }
    }, (zh) => zh)
    await legacy.bindChatAgent('chat-1', 'pi')
    await legacy.loadChatSessions('chat-1')
    expect(legacy.getSnapshot().chatBoundAgent['chat-1']).toBe('pi')
  })

  it('records the one-way agent lock from session/chat-list', async () => {
    let listed: { sessions: unknown[]; lockedAgentId?: string } = { sessions: [], lockedAgentId: 'pi' }
    const store = new AcpStore(async (_channel, endpoint) => {
      if (endpoint === 'session/chat-list') return { ok: true, value: listed }
      return { ok: true, value: { done: true } }
    }, (zh) => zh)

    await store.loadChatSessions('chat-1')
    expect(store.getSnapshot().chatLockedAgent['chat-1']).toBe('pi')

    // The lock is one-way: a read that omits the field is an older host half,
    // not an unlock. Keeping it is what stops the picker coming back.
    listed = { sessions: [] }
    await store.loadChatSessions('chat-1')
    expect(store.getSnapshot().chatLockedAgent['chat-1']).toBe('pi')

    // Conversations are independent.
    listed = { sessions: [], lockedAgentId: 'omp' }
    await store.loadChatSessions('chat-2')
    expect(store.getSnapshot().chatLockedAgent['chat-2']).toBe('omp')
  })

  it('takes the start-of-turn lock from the host frame, and honours a rolled-back lock', async () => {
    let listed: { sessions: unknown[]; lockedAgentId?: string } = { sessions: [], lockedAgentId: 'pi' }
    const store = new AcpStore(async (_channel, endpoint) => {
      if (endpoint === 'session/chat-list') return { ok: true, value: listed }
      return { ok: true, value: {} }
    }, (zh) => zh)
    const apply = (event: unknown): Promise<void> =>
      (store as unknown as { applyEvent(event: unknown): Promise<void> }).applyEvent(event)

    // The host locks the conversation when the first ACP turn starts and says
    // so immediately: that frame is the hand-off trigger, not a later read.
    await apply({ type: 'chat/agent-locked', dshSessionId: 'chat-1', agentId: 'pi' })
    expect(store.getSnapshot().chatLockedAgent['chat-1']).toBe('pi')
    expect(store.getSnapshot().chatBoundAgent['chat-1']).toBe('pi')
    expect(store.getSnapshot().agentLockReveal['chat-1']).toBe(1)

    // A read confirming the same lock is not a second hand-off.
    await store.loadChatSessions('chat-1')
    expect(store.getSnapshot().agentLockReveal['chat-1']).toBe(1)

    // The first turn delivered nothing: the host rolled the lock back.
    await apply({ type: 'chat/agent-unlocked', dshSessionId: 'chat-1' })
    expect(store.getSnapshot().chatLockedAgent['chat-1']).toBeUndefined()

    // A list read that started before the rollback can still report the lock;
    // it must not revive a conversation the host has explicitly unlocked.
    await store.loadChatSessions('chat-1')
    expect(store.getSnapshot().chatLockedAgent['chat-1']).toBeUndefined()

    // The user retries: the new lock frame supersedes the rollback marker and
    // announces a fresh ceremony (the animation's serial advances).
    await apply({ type: 'chat/agent-locked', dshSessionId: 'chat-1', agentId: 'pi' })
    expect(store.getSnapshot().chatLockedAgent['chat-1']).toBe('pi')
    expect(store.getSnapshot().agentLockReveal['chat-1']).toBe(2)
  })

  it('announces a lock only when this page watched it arrive', async () => {
    // The composer plays a shatter/condense hand-off on this serial (see
    // agent-lock-anim.ts). A lock that was already there when the page opened
    // is not a transition and must not replay the ceremony on every reload.
    let listed: { sessions: unknown[]; lockedAgentId?: string } = { sessions: [] }
    const store = new AcpStore(async (_channel, endpoint) => {
      if (endpoint === 'session/chat-list') return { ok: true, value: listed }
      return { ok: true, value: { done: true } }
    }, (zh) => zh)

    await store.loadChatSessions('chat-1')
    expect(store.getSnapshot().agentLockReveal['chat-1']).toBeUndefined()

    // The first turn lands: a later read reports the lock.
    listed = { sessions: [], lockedAgentId: 'pi' }
    await store.loadChatSessions('chat-1')
    expect(store.getSnapshot().agentLockReveal['chat-1']).toBe(1)

    // Restating the lock is not another transition.
    await store.loadChatSessions('chat-1')
    expect(store.getSnapshot().agentLockReveal['chat-1']).toBe(1)

    // A page that opens an already-locked conversation seeds the lock silently.
    const reloaded = new AcpStore(async (_channel, endpoint) => {
      if (endpoint === 'session/chat-list') return { ok: true, value: { sessions: [], lockedAgentId: 'pi' } }
      return { ok: true, value: { done: true } }
    }, (zh) => zh)
    await reloaded.loadChatSessions('chat-1')
    expect(reloaded.getSnapshot().chatLockedAgent['chat-1']).toBe('pi')
    expect(reloaded.getSnapshot().agentLockReveal).toEqual({})
  })

  it('folds a committed preset frame into the verdict instead of re-reading the log', async () => {
    // The host log read is one switch behind the frame that announces the
    // switch, so the seat used to move only after a page reload.
    const reads: string[] = []
    const store = new AcpStore(async (_channel, endpoint) => {
      if (endpoint === 'session/chat-list') {
        reads.push('session/chat-list')
        return { ok: true, value: { sessions: [], acpMode: false } }
      }
      return { ok: true, value: {} }
    }, (zh) => zh)
    const gate = (): boolean => stagedIsAcpMode({ current: 'chat-1' }, id => store.getSnapshot().acpMode[id])

    // Cold seed: the session still runs the standard preset.
    await store.loadChatSessions('chat-1')
    expect(gate()).toBe(false)

    // The user switches into ACP mode. The frame carries the committed preset, so
    // the verdict comes from the frame — not from the log, which the host can
    // only fold to the preset BEFORE this switch.
    store.noteAcpMode('chat-1', acpModeFromPresetEvent('acp'))
    expect(gate()).toBe(true)
    // ...and out again, same way.
    store.noteAcpMode('chat-1', acpModeFromPresetEvent('standard'))
    expect(gate()).toBe(false)
    // Neither switch needed a round-trip.
    expect(reads).toHaveLength(1)

    // A frame restating the held verdict changes nothing (no listener churn).
    store.noteAcpMode('chat-1', acpModeFromPresetEvent('standard'))
    expect(store.getSnapshot().acpMode).toEqual({ 'chat-1': false })
  })

  it('lets a committed preset frame override a chat-list answer still in flight', async () => {
    let release: (() => void) | undefined
    const store = new AcpStore(async (_channel, endpoint) => {
      if (endpoint === 'session/chat-list') {
        await new Promise<void>(resolve => { release = resolve })
        // The log as it read BEFORE the switch: still ACP.
        return { ok: true, value: { sessions: [], acpMode: true } }
      }
      return { ok: true, value: {} }
    }, (zh) => zh)

    const pending = store.loadChatSessions('chat-1')
    // The switch commits while that read is outstanding.
    store.abandonChatSessionRead('chat-1')
    store.noteAcpMode('chat-1', acpModeFromPresetEvent('standard'))
    release?.()
    await pending
    // The stale answer must not land over the frame's verdict.
    expect(store.getSnapshot().acpMode).toEqual({ 'chat-1': false })

    // A later read for the same session is no longer blocked by the dropped one.
    const other = new AcpStore(async () => ({ ok: true, value: { sessions: [], acpMode: true } }), (zh) => zh)
    await other.abandonChatSessionRead('chat-1')
    await other.loadChatSessions('chat-1')
    expect(other.getSnapshot().acpMode['chat-1']).toBe(true)
  })

  it('keeps a frame-settled verdict immune to a later host read that lags the switch', async () => {
    // The composer's readers re-mount when the ACP surfaces re-activate, and
    // the host's log read can still fold the preset BEFORE the switch — so the
    // frame's verdict must outrank any read, whenever it lands. This is what
    // made the surface move only after a page reload.
    const reads: string[] = []
    const store = new AcpStore(async (_channel, endpoint) => {
      if (endpoint === 'session/chat-list') {
        reads.push('read')
        return { ok: true, value: { sessions: [], acpMode: false } }
      }
      return { ok: true, value: {} }
    }, (zh) => zh)
    const gate = (): boolean => stagedIsAcpMode({ current: 'chat-1' }, id => store.getSnapshot().acpMode[id])

    // Cold seed (the session still runs another preset).
    await store.loadChatSessions('chat-1')
    // The switch commits: the frame carries 'acp'.
    store.noteAcpMode('chat-1', acpModeFromPresetEvent('acp'))
    expect(gate()).toBe(true)

    // A reader mounts and reads again; the host answers with the pre-switch
    // fold. The verdict must hold.
    await store.loadChatSessions('chat-1')
    expect(store.getSnapshot().acpMode['chat-1']).toBe(true)
    expect(gate()).toBe(true)
    // ...and again, for good measure.
    await store.loadChatSessions('chat-1')
    expect(gate()).toBe(true)

    // Only a newer frame may move it.
    store.noteAcpMode('chat-1', acpModeFromPresetEvent('standard'))
    expect(gate()).toBe(false)

    // Invalidating re-opens the session to host reads (the older-runtime path
    // whose frames carry no preset has to be able to re-ask).
    store.invalidateAcpMode('chat-1')
    await store.loadChatSessions('chat-1')
    expect(store.getSnapshot().acpMode['chat-1']).toBe(false)
    expect(reads).toHaveLength(4)
  })

  it('lets the seat gate own re-ask settle a verdict a frame had settled', async () => {
    // The frame's authority has ONE authorized exception, and this is it. A
    // session whose rows are silent AND whose frames have stopped arriving has
    // the held verdict as its only fact source; a host read is the one place a
    // switch the runtime never framed can still be learned from. Without it the
    // gate pinned the conversation in ACP mode for the rest of the page — and
    // the permission seat's product is an absence, so an ordinary
    // conversation silently lost its Access mode control.
    const reads: string[] = []
    const host = { acpMode: true }
    const store = new AcpStore(async (_channel, endpoint) => {
      if (endpoint === 'session/chat-list') {
        reads.push('read')
        return { ok: true, value: { sessions: [], acpMode: host.acpMode } }
      }
      return { ok: true, value: {} }
    }, (zh) => zh)
    const gate = (): boolean => stagedIsAcpMode({ current: 'chat-1' }, id => store.getSnapshot().acpMode[id])

    // The switch into ACP mode arrives as a frame; the verdict is frame-settled.
    store.noteAcpMode('chat-1', acpModeFromPresetEvent('acp'))
    expect(gate()).toBe(true)
    // A composer reader's answer still defers to the frame (the host's log
    // read can lag a switch by one).
    host.acpMode = false
    await store.loadChatSessions('chat-1')
    expect(gate()).toBe(true)

    // The gate's own re-ask is allowed to settle it: the conversation switched
    // back, the frame path is quiet, and the host now says so.
    await store.loadChatSessions('chat-1', { settleVerdict: true })
    expect(gate()).toBe(false)
    expect(store.getSnapshot().acpMode['chat-1']).toBe(false)

    // And the frame is still the authority afterwards: a newer one wins again.
    store.noteAcpMode('chat-1', acpModeFromPresetEvent('acp'))
    expect(gate()).toBe(true)
    expect(reads).toHaveLength(2)
  })
})

describe('AcpStore locale switching', () => {
  it('rebuilds the detect summary in the newly active language', async () => {
    let zh = true
    const store = new AcpStore(
      async (_channel, endpoint) => (endpoint === 'agents/detect'
        ? { ok: true, value: { agents: [{ id: 'pi', name: 'Pi Agent', detected: true, defaultCommand: 'pi-acp', defaultArgs: [] }] } }
        : { ok: true, value: {} }),
      (zhText, enText) => (zh ? zhText : enText),
    )
    await store.detectAgents()
    expect(store.getSnapshot().detectSummary).toContain('个预设')

    zh = false
    store.refreshLocale()
    expect(store.getSnapshot().detectSummary).toContain('presets')
    // The counts, not the prose, survive the switch.
    expect(store.getSnapshot().detectedAgents).toHaveLength(1)
  })

  it('notifies subscribers even when no stored string is locale-derived', () => {
    const store = new AcpStore(async () => ({ ok: true, value: {} }), (zh) => zh)
    const before = store.getSnapshot()
    let notified = 0
    const stop = store.subscribe(() => { notified++ })
    store.refreshLocale()
    stop()
    expect(notified).toBe(1)
    // A fresh snapshot reference is what re-runs render-time `label()` pairs;
    // `localeRev` is what memoized transcript rows compare to notice it.
    expect(store.getSnapshot()).not.toBe(before)
    expect(store.getSnapshot().localeRev).toBe(before.localeRev + 1)
  })

  it('drops a stale detect summary once a re-detect fails, so the switch cannot revive it', async () => {
    let failing = false
    const store = new AcpStore(
      async (_channel, endpoint) => {
        if (endpoint !== 'agents/detect') return { ok: true, value: {} }
        return failing
          ? { ok: false, error: { code: 'internal', message: 'host offline' } }
          : { ok: true, value: { agents: [{ id: 'pi', name: 'Pi Agent', detected: true, defaultCommand: 'pi-acp', defaultArgs: [] }] } }
      },
      (zh) => zh,
    )
    await store.detectAgents()
    expect(store.getSnapshot().detectSummary).toBeDefined()
    failing = true
    await store.detectAgents()
    store.refreshLocale()
    expect(store.getSnapshot().detectSummary).toBeUndefined()
  })
})

describe('AcpStore event application (released / reset / turn dedup)', () => {
  function makeStore(): { store: AcpStore; apply: (event: unknown) => Promise<void> } {
    const store = new AcpStore(async () => ({ ok: true, value: {} }), (zh) => zh)
    const apply = (event: unknown): Promise<void> =>
      (store as unknown as { applyEvent(event: unknown): Promise<void> }).applyEvent(event)
    return { store, apply }
  }

  it('coalesces a frame of streaming updates into one fold and one notification', async () => {
    // Agents stream at token granularity; folding and notifying per chunk
    // re-rendered every store consumer per chunk (the whole-system lag this
    // coalescing exists to fix). With a frame scheduler present, the frames
    // queue up and ONE flush folds the batch with ONE listener notification.
    const frames: Array<() => void> = []
    vi.stubGlobal('requestAnimationFrame', (cb: () => void): number => {
      frames.push(cb)
      return frames.length
    })
    try {
      const { store, apply } = await makeStore()
      await apply({ type: 'session/created', sessionId: 's1', session: view() })
      await apply({ type: 'turn/start', sessionId: 's1', turnId: 't1', text: 'hi' })
      let notifications = 0
      store.subscribe(() => { notifications += 1 })

      await apply({ type: 'session/update', sessionId: 's1', seq: 1, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hello ' } } })
      await apply({ type: 'session/update', sessionId: 's1', seq: 2, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'world' } } })
      await apply({ type: 'session/update', sessionId: 's1', seq: 3, update: { sessionUpdate: 'usage_update', used: 5, size: 50 } })

      // Nothing folded yet: the frame has not run.
      expect(notifications).toBe(0)
      expect(store.getSnapshot().blocks.filter(b => b.kind === 'agent')).toHaveLength(0)

      // One frame runs the whole batch: one notification, one merged block.
      const pending = frames.splice(0)
      for (const frame of pending) frame()
      expect(notifications).toBe(1)
      const agentBlocks = store.getSnapshot().blocks.filter(b => b.kind === 'agent')
      expect(agentBlocks).toHaveLength(1)
      expect(agentBlocks[0]).toMatchObject({ text: 'Hello world' })
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('live-patches usage into the session, chat row and watched transcript', async () => {
    const listed = { sessions: [{ agentId: 'pi', sessionId: 's1', usage: { used: 1, size: 100 } }], acpMode: true }
    const store = new AcpStore(async (_channel, endpoint) => {
      if (endpoint === 'session/chat-list') return { ok: true, value: listed }
      if (endpoint === 'session/chat-transcript') {
        return { ok: true, value: { views: [{ session: view({ usage: { used: 1, size: 100 } }), entries: [] }] } }
      }
      return { ok: true, value: {} }
    }, zh => zh)
    const apply = (event: unknown): Promise<void> =>
      (store as unknown as { applyEvent(event: unknown): Promise<void> }).applyEvent(event)

    await store.loadChatSessions('chat-1')
    await store.loadChatTranscript('chat-1')
    await apply({ type: 'session/created', sessionId: 's1', session: view({ usage: { used: 1, size: 100 } }) })
    const blocksBefore = store.getSnapshot().chatTranscripts.s1?.blocks

    await apply({ type: 'session/update', sessionId: 's1', seq: 1, update: { sessionUpdate: 'usage_update', used: 500, size: 1000 } })

    // No animation frame in Node: the batch flushes synchronously, and every
    // snapshot the occupancy surface reads moved — not just the transcript.
    expect(store.getSnapshot().chatSessions[0]?.usage).toEqual({ used: 500, size: 1000 })
    expect(store.getSnapshot().chatTranscripts.s1?.session.usage).toEqual({ used: 500, size: 1000 })
    // A usage-only tick must not touch the folded blocks.
    expect(store.getSnapshot().chatTranscripts.s1?.blocks).toBe(blocksBefore)
  })

  it('re-reads the chat row when a turn starts before the row list has seen the session', async () => {
    // The first ACP session is materialized inside its first turn, after the
    // composer's mount / running read; without this read its usage ticks would
    // find no row and the occupancy ring would stay absent until the turn end.
    let rows: ChatSessionView[] = []
    const store = new AcpStore(async (_channel, endpoint) => {
      if (endpoint === 'session/chat-list') return { ok: true, value: { sessions: rows, acpMode: true } }
      return { ok: true, value: {} }
    }, zh => zh)
    const apply = (event: unknown): Promise<void> =>
      (store as unknown as { applyEvent(event: unknown): Promise<void> }).applyEvent(event)

    await store.loadChatSessions('chat-1')
    expect(store.getSnapshot().chatSessions).toEqual([])

    rows = [{ agentId: 'pi', sessionId: 's1', usage: { used: 10, size: 100 } }]
    await apply({ type: 'turn/start', sessionId: 's1', turnId: 't1', text: 'hi' })
    await vi.waitFor(() => expect(store.getSnapshot().chatSessions).toEqual(rows))
  })

  it('takes a republished snapshot’s (possibly absent) usage onto the chat row', async () => {
    const listed = { sessions: [{ agentId: 'pi', sessionId: 's1', usage: { used: 50, size: 100 } }], acpMode: true }
    const store = new AcpStore(async (_channel, endpoint) => {
      if (endpoint === 'session/chat-list') return { ok: true, value: listed }
      return { ok: true, value: {} }
    }, zh => zh)
    const apply = (event: unknown): Promise<void> =>
      (store as unknown as { applyEvent(event: unknown): Promise<void> }).applyEvent(event)

    await store.loadChatSessions('chat-1')
    expect(store.getSnapshot().chatSessions[0]?.usage).toEqual({ used: 50, size: 100 })

    // `session/meta` is the host's latest word on this session: when it carries
    // no usage, an older reading must not outlive it on the composer's row.
    await apply({ type: 'session/meta', sessionId: 's1', session: view() })
    expect(store.getSnapshot().chatSessions[0]?.usage).toBeUndefined()
  })

  function view(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
    return {
      sessionId: 's1',
      agentId: 'pi',
      acpSessionId: 'acp-1',
      cwd: '/w',
      running: false,
      closed: false,
      seq: 0,
      ...overrides,
    }
  }

  it('keeps a released session visible, marks it released, and clears its permissions', async () => {
    const { store, apply } = await makeStore()
    await apply({ type: 'session/created', sessionId: 's1', session: view() })
    await apply({
      type: 'permission/request',
      requestId: 'r1',
      sessionId: 's1',
      dshSessionId: 'chat-1',
      toolCall: { title: 't' },
      toolName: 'Bash',
      options: [],
      timeoutMode: 'wait',
    })
    expect(store.getSnapshot().permissions).toHaveLength(1)

    await apply({ type: 'session/released', sessionId: 's1', session: view({ released: true }), reason: 'agent process exited' })
    const state = store.getSnapshot()
    expect(state.sessions).toHaveLength(1)
    expect(state.sessions[0]).toMatchObject({ sessionId: 's1', released: true })
    expect(state.permissions).toHaveLength(0)
    // No `cause` = an older host half: treated as `died`. It belongs in the
    // runtime log, not the settings page's own action-failure banner.
    expect(state.notice).toBeUndefined()
    expect(state.logs.at(-1)).toMatchObject({ level: 'error' })
    expect(state.logs.at(-1)?.text).toContain('恢复')
  })

  it('appends agent/notice to the runtime log instead of the notice banner', async () => {
    const { store, apply } = await makeStore()
    await apply({ type: 'agent/notice', agentId: 'pi', level: 'info', text: 'acp: catalog refreshed' })
    const state = store.getSnapshot()
    expect(state.notice).toBeUndefined()
    expect(state.logs).toHaveLength(1)
    expect(state.logs[0]).toMatchObject({ level: 'info', agentId: 'pi', text: 'acp: catalog refreshed' })
    expect(state.logUnread).toBe(1)
  })

  it('bounds the runtime log to the newest entries, oldest first', async () => {
    const { store, apply } = await makeStore()
    for (let i = 0; i < 205; i++) {
      await apply({ type: 'agent/notice', agentId: 'pi', level: 'info', text: `n${String(i)}` })
    }
    const logs = store.getSnapshot().logs
    expect(logs).toHaveLength(200)
    // Append order is oldest→newest; the first five fell off the front.
    expect(logs[0]?.text).toBe('n5')
    expect(logs.at(-1)?.text).toBe('n204')
    expect(store.getSnapshot().logUnread).toBe(205)
  })

  it('marks the log read and clears it on demand', async () => {
    const { store, apply } = await makeStore()
    await apply({ type: 'agent/notice', agentId: 'pi', level: 'info', text: 'one' })
    await apply({ type: 'agent/notice', agentId: 'pi', level: 'error', text: 'two' })
    expect(store.getSnapshot().logUnread).toBe(2)

    store.markLogsRead()
    expect(store.getSnapshot().logUnread).toBe(0)
    expect(store.getSnapshot().logs).toHaveLength(2)

    store.clearLogs()
    expect(store.getSnapshot().logs).toEqual([])
    expect(store.getSnapshot().logUnread).toBe(0)
  })

  it('logs a session/closed agent-died termination as an error instead of a notice', async () => {
    const { store, apply } = await makeStore()
    await apply({ type: 'session/created', sessionId: 's1', session: view() })
    await apply({ type: 'session/closed', sessionId: 's1', reason: 'agent-died' })
    const state = store.getSnapshot()
    expect(state.sessions).toHaveLength(0)
    expect(state.notice).toBeUndefined()
    expect(state.logs).toHaveLength(1)
    expect(state.logs[0]).toMatchObject({ level: 'error' })
    expect(state.logs[0]?.text).toContain('进程退出')
  })

  it('classifies every non-idle release cause into the runtime log', async () => {
    const cases = [
      { cause: 'workspace', level: 'info', text: '工作区' },
      { cause: 'resume-failed', level: 'error', text: '恢复失败' },
      { cause: 'stalled', level: 'error', text: '卡死' },
      { cause: 'died', level: 'error', text: '进程已退出' },
    ] as const
    for (const expected of cases) {
      const { store, apply } = await makeStore()
      await apply({
        type: 'session/released',
        sessionId: 's1',
        session: view({ released: true }),
        reason: expected.cause,
        cause: expected.cause,
      })
      const state = store.getSnapshot()
      expect(state.notice).toBeUndefined()
      expect(state.logs).toHaveLength(1)
      expect(state.logs[0]).toMatchObject({ level: expected.level, agentId: 'pi' })
      expect(state.logs[0]?.text).toContain(expected.text)
    }
  })

  it('copies the permission frame fields verbatim', async () => {
    const { store, apply } = await makeStore()
    const options = [
      { optionId: 'allow', name: 'Always Allow', kind: 'allow_always' },
      { optionId: 'deny', name: 'Reject', kind: 'reject_once' },
    ]
    const deadlineAt = 1_700_000_300_000
    await apply({
      type: 'permission/request',
      requestId: 'r1',
      sessionId: 'acp-1',
      dshSessionId: 'chat-1',
      // The card must not depend on this raw payload; only the host-derived
      // fields below are rendered.
      toolCall: { title: 'NOT the card title' },
      toolName: 'Bash',
      reason: 'Bash · echo hi',
      options,
      timeoutMode: 'abort',
      deadlineAt,
    })
    expect(store.getSnapshot().permissions).toEqual([{
      requestId: 'r1',
      sessionId: 'acp-1',
      dshSessionId: 'chat-1',
      toolName: 'Bash',
      reason: 'Bash · echo hi',
      options,
      timeoutMode: 'abort',
      deadlineAt,
    }])
    // The old local title derived from `toolCall.title` is gone.
    expect(store.getSnapshot().permissions[0]).not.toHaveProperty('title')
  })

  it('re-establishes the pending asks on reconnect and prunes the stale ones', async () => {
    // A `permission/request` is broadcast ONCE, so a client that connects later
    // never learns the ask exists. The stream replays every outstanding ask and
    // terminates with the live id set; this client holds one ask that was
    // resolved while it was disconnected, which must not survive as a card that
    // can only answer `unknown_request`.
    const { store, apply } = await makeStore()
    await apply({
      type: 'permission/request',
      requestId: 'stale',
      sessionId: 's1',
      dshSessionId: 'chat-1',
      toolCall: { title: 'old' },
      toolName: 'Bash',
      options: [],
      timeoutMode: 'wait',
    })
    await apply({
      type: 'permission/request',
      requestId: 'live',
      sessionId: 's2',
      dshSessionId: 'chat-1',
      toolCall: { title: 'new' },
      toolName: 'Write',
      reason: 'Write · /w/a.ts',
      options: [{ optionId: 'ok', name: 'Allow', kind: 'allow_once' }],
      timeoutMode: 'auto',
      deadlineAt: 1_700_000_300_000,
    })
    expect(store.getSnapshot().permissions.map(p => p.requestId)).toEqual(['stale', 'live'])

    // The replay re-sends the outstanding ask (idempotent by request id — it may
    // also have arrived live) and then names what is actually live. The replay
    // keeps every frame field, not just the id.
    await apply({
      type: 'permission/request',
      requestId: 'live',
      sessionId: 's2',
      dshSessionId: 'chat-1',
      toolCall: { title: 'new' },
      toolName: 'Write',
      reason: 'Write · /w/a.ts',
      options: [{ optionId: 'ok', name: 'Allow', kind: 'allow_once' }],
      timeoutMode: 'auto',
      deadlineAt: 1_700_000_300_000,
    })
    await apply({ type: 'permission/synced', requestIds: ['live'] })
    expect(store.getSnapshot().permissions.map(p => p.requestId)).toEqual(['live'])
    expect(store.getSnapshot().permissions[0]).toMatchObject({
      sessionId: 's2',
      dshSessionId: 'chat-1',
      toolName: 'Write',
      reason: 'Write · /w/a.ts',
      timeoutMode: 'auto',
      deadlineAt: 1_700_000_300_000,
    })

    // An answered ask is pruned on its own frame, leaving the others alone.
    await apply({ type: 'permission/resolved', requestId: 'live', sessionId: 's2', outcome: { outcome: 'cancelled' } })
    expect(store.getSnapshot().permissions).toEqual([])

    // Nothing outstanding at all: the terminator alone must clear the list.
    await apply({ type: 'permission/synced', requestIds: [] })
    expect(store.getSnapshot().permissions).toEqual([])
  })

  it('filters pending asks by DSH chat session and never shows an ask with no chat identity', async () => {
    const { store, apply } = await makeStore()
    await apply({
      type: 'permission/request',
      requestId: 'mine',
      sessionId: 'acp-1',
      dshSessionId: 'chat-1',
      toolCall: {},
      toolName: 'Bash',
      options: [],
      timeoutMode: 'wait',
    })
    await apply({
      type: 'permission/request',
      requestId: 'other',
      sessionId: 'acp-2',
      dshSessionId: 'chat-2',
      toolCall: {},
      toolName: 'Write',
      options: [],
      timeoutMode: 'wait',
    })
    // An `/acp` RPC-only ask: pending, but belonging to no conversation.
    await apply({
      type: 'permission/request',
      requestId: 'rpc-only',
      sessionId: 'acp-3',
      toolCall: {},
      toolName: 'Bash',
      options: [],
      timeoutMode: 'wait',
    })
    const permissions = store.getSnapshot().permissions
    expect(permissionsForSession(permissions, 'chat-1').map(p => p.requestId)).toEqual(['mine'])
    expect(permissionsForSession(permissions, 'chat-2').map(p => p.requestId)).toEqual(['other'])
    expect(permissionsForSession(permissions, 'chat-3')).toEqual([])
  })

  it('reports a failed permission answer and rethrows it to the caller', async () => {
    // The dock pins the failure next to the card, so the error must not be
    // swallowed behind the settings page's notice.
    const store = new AcpStore(
      async (_channel, endpoint) => (endpoint === 'permission/respond'
        ? { ok: false, error: { code: 'unknown_request', message: 'ask is gone' } }
        : { ok: true, value: {} }),
      (zh) => zh,
    )
    await expect(store.respondPermission('r1', 'allow')).rejects.toThrow('ask is gone')
    expect(store.getSnapshot().notice).toBe('ask is gone')
  })

  it('resets blocks and the seq watermark on session/reset so the replay folds fresh', async () => {
    const { store, apply } = await makeStore()
    await apply({ type: 'session/created', sessionId: 's1', session: view() })
    await apply({ type: 'turn/start', sessionId: 's1', turnId: 't1', text: 'hi' })
    await apply({ type: 'session/update', sessionId: 's1', seq: 1, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'old' } } })
    expect(store.getSnapshot().blocks.length).toBeGreaterThan(0)

    await apply({ type: 'session/reset', sessionId: 's1', session: view() })
    expect(store.getSnapshot().blocks).toEqual([])

    // The replay restarts at seq 1; a stale watermark would have triggered a
    // gap refetch instead of folding.
    await apply({ type: 'session/update', sessionId: 's1', seq: 1, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'replayed' } } })
    expect(store.getSnapshot().blocks).toEqual([{ kind: 'agent', text: 'replayed' }])
  })

  it('applies only the first turn/end per open turn (cancel fallback + late real end)', async () => {
    const { store, apply } = await makeStore()
    await apply({ type: 'session/created', sessionId: 's1', session: view() })
    await apply({ type: 'turn/start', sessionId: 's1', turnId: 't1', text: 'hi' })
    await apply({ type: 'turn/end', sessionId: 's1', turnId: '', error: 'force-finalized' })
    expect(store.getSnapshot().blocks).toEqual([expect.objectContaining({ kind: 'user' }), expect.objectContaining({ kind: 'notice', tone: 'error' })])

    // The late real turn/end for the same turn must not duplicate the notice.
    await apply({ type: 'turn/end', sessionId: 's1', turnId: 't1', stopReason: 'end_turn' })
    expect(store.getSnapshot().blocks).toHaveLength(2)

    // A new turn opens the window again.
    await apply({ type: 'turn/start', sessionId: 's1', turnId: 't2', text: 'again' })
    await apply({ type: 'turn/end', sessionId: 's1', turnId: 't2', stopReason: 'end_turn' })
    expect(store.getSnapshot().blocks).toHaveLength(3)
  })

  it('records a live turn/metrics frame in burstStats and notifies subscribers', async () => {
    const { store, apply } = await makeStore()
    let notified = 0
    store.subscribe(() => { notified++ })

    await apply({ type: 'turn/metrics', sessionId: 's1', dshSessionId: 'chat-1', turnId: 't1', outputTokens: 120, burstMs: 900, final: false })

    expect(notified).toBe(1)
    expect(store.getSnapshot().burstStats.s1).toEqual({ outputTokens: 120, burstMs: 900, turnId: 't1', final: false })
  })

  it('ignores a late live turn/metrics frame for a turn already finalized', async () => {
    const { store, apply } = await makeStore()
    await apply({ type: 'turn/metrics', sessionId: 's1', dshSessionId: 'chat-1', turnId: 't1', outputTokens: 200, burstMs: 1500, final: true })
    let notified = 0
    store.subscribe(() => { notified++ })

    // A stream reconnect can deliver the earlier live frame after the final
    // one; it must not regress the finalized aggregate.
    await apply({ type: 'turn/metrics', sessionId: 's1', dshSessionId: 'chat-1', turnId: 't1', outputTokens: 150, burstMs: 1200, final: false })

    expect(notified).toBe(0)
    expect(store.getSnapshot().burstStats.s1).toEqual({ outputTokens: 200, burstMs: 1500, turnId: 't1', final: true })
  })

  it('accepts a live frame from a new turn after the previous one finalized', async () => {
    const { store, apply } = await makeStore()
    await apply({ type: 'turn/metrics', sessionId: 's1', dshSessionId: 'chat-1', turnId: 't1', outputTokens: 200, burstMs: 1500, final: true })

    await apply({ type: 'turn/metrics', sessionId: 's1', dshSessionId: 'chat-1', turnId: 't2', outputTokens: 250, burstMs: 1800, final: false })

    expect(store.getSnapshot().burstStats.s1).toEqual({ outputTokens: 250, burstMs: 1800, turnId: 't2', final: false })
  })

  it('drops only the closing session burstStats entry on session/closed', async () => {
    const { store, apply } = await makeStore()
    await apply({ type: 'session/created', sessionId: 's1', session: view() })
    await apply({ type: 'turn/metrics', sessionId: 's1', dshSessionId: 'chat-1', turnId: 't1', outputTokens: 10, burstMs: 50, final: true })
    await apply({ type: 'turn/metrics', sessionId: 's2', dshSessionId: 'chat-2', turnId: 't9', outputTokens: 20, burstMs: 60, final: true })

    await apply({ type: 'session/closed', sessionId: 's1', reason: 'closed' })

    const state = store.getSnapshot()
    expect(state.burstStats.s1).toBeUndefined()
    expect(state.burstStats.s2).toEqual({ outputTokens: 20, burstMs: 60, turnId: 't9', final: true })
  })

  it('leaves blocks and sessions untouched on turn/metrics', async () => {
    const { store, apply } = await makeStore()
    await apply({ type: 'session/created', sessionId: 's1', session: view() })
    await apply({ type: 'turn/start', sessionId: 's1', turnId: 't1', text: 'hi' })
    const blocksBefore = store.getSnapshot().blocks
    const sessionsBefore = store.getSnapshot().sessions

    await apply({ type: 'turn/metrics', sessionId: 's1', dshSessionId: 'chat-1', turnId: 't1', outputTokens: 5, burstMs: 40, final: false })

    const state = store.getSnapshot()
    expect(state.blocks).toBe(blocksBefore)
    expect(state.sessions).toBe(sessionsBefore)
    expect(state.burstStats.s1).toMatchObject({ turnId: 't1' })
  })

  it('refuses a transcript answer that is behind what this page already folded', async () => {
    // The host fills its transcript from the notification pipeline, which the
    // SDK paces independently of the `session/prompt` response — so a read taken
    // right after a turn can still be missing the agent's last chunk. A refetch
    // that lands inside that window used to REPLACE the folded blocks with the
    // short answer, truncating a turn the user had just watched finish.
    const store = new AcpStore(async (_channel, endpoint) => {
      if (endpoint !== 'transcript/get') return { ok: true, value: {} }
      // Deliberately behind: only the first of the two chunks this page folds.
      return { ok: true, value: { session: view(), entries: [
        { seq: 1, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hello' } } },
      ] } }
    }, (zh) => zh)
    const apply = (event: unknown): Promise<void> =>
      (store as unknown as { applyEvent(event: unknown): Promise<void> }).applyEvent(event)

    store.selectSession('s1')
    await apply({ type: 'session/created', sessionId: 's1', session: view() })
    await apply({ type: 'turn/start', sessionId: 's1', turnId: 't1', text: 'hi' })
    await apply({ type: 'session/update', sessionId: 's1', seq: 1, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hello' } } })
    await apply({ type: 'session/update', sessionId: 's1', seq: 2, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: ' world' } } })
    expect(store.getSnapshot().blocks).toEqual([{ kind: 'agent', text: 'Hello world' }])

    // The stale answer must not replace the fold…
    store.selectSession('s1')
    // `selectSession` fires the refetch without awaiting it; let it land, so the
    // assertion is about the answer's effect and not about it still being in flight.
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(store.getSnapshot().blocks).toEqual([{ kind: 'agent', text: 'Hello world' }])

    // …but an answer that has caught up still refetches (a fresh mount, or a
    // genuine replay after `session/reset` zeroed the watermark).
    const caught = new AcpStore(async (_channel, endpoint) => {
      if (endpoint !== 'transcript/get') return { ok: true, value: {} }
      return { ok: true, value: { session: view(), entries: [
        { seq: 1, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hello' } } },
        { seq: 2, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: ' world' } } },
      ] } }
    }, (zh) => zh)
    caught.selectSession('s1')
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(caught.getSnapshot().blocks).toEqual([{ kind: 'agent', text: 'Hello world' }])
  })
})
