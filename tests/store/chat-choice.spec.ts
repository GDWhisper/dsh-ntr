/**
 * One conversation's own ACP picks (split plan P3b): the agent binding, the
 * model / thought-level / extra-config writes and the optimistic
 * `chatChoice` record behind them. Moved verbatim out of `tests/store.spec.ts`,
 * which still drives the same facade — the service is reached through
 * `AcpStore`.
 */

import { describe, expect, it } from 'vitest'
import { AcpStore } from '../../src/client/store.ts'

describe('the conversation↔agent binding (no DSH model route)', () => {
  /** A store that records every call and answers the panel's resync endpoints. */
  function makeStore(defaultAgentId?: string) {
    const calls: Array<{ endpoint: string; payload: unknown }> = []
    const store = new AcpStore(async (_channel, endpoint, payload) => {
      calls.push({ endpoint, payload })
      if (endpoint === 'agents/list') return { ok: true, value: { agents: [] } }
      if (endpoint === 'sessions/list') return { ok: true, value: { sessions: [] } }
      if (endpoint === 'agents/detect') return { ok: true, value: { agents: [] } }
      if (endpoint === 'default/agent') return { ok: true, value: { ...(defaultAgentId === undefined ? {} : { agentId: defaultAgentId }) } }
      if (endpoint === 'session/chat-list') return { ok: true, value: { sessions: [], acpMode: false } }
      return { ok: true, value: {} }
    }, (zh) => zh)
    return { store, calls }
  }

  it('binds, re-models, re-efforts and configures a conversation through its own RPCs', async () => {
    const { store, calls } = makeStore()

    await store.bindChatAgent('chat-1', 'codebuddy')
    await store.setChatSessionModel('chat-1', 'codebuddy@hy3')
    await store.setChatSessionEffort('chat-1', 'high')
    await store.setChatSessionEffort('chat-1', undefined)
    await store.setChatSessionConfig('chat-1', 'temp', 'high')
    // A toggle keeps its boolean across the RPC; the checkbox value is not
    // stringified on the way out.
    await store.setChatSessionConfig('chat-1', 'stream', true)

    expect(calls.map(c => c.endpoint)).toEqual([
      'session/chat-bind', 'session/chat-model-set', 'session/chat-effort-set', 'session/chat-effort-set',
      'session/chat-config-set', 'session/chat-config-set',
    ])
    expect(calls[0].payload).toEqual({ dshSessionId: 'chat-1', agentId: 'codebuddy' })
    expect(calls[1].payload).toEqual({ dshSessionId: 'chat-1', modelId: 'codebuddy@hy3' })
    expect(calls[2].payload).toEqual({ dshSessionId: 'chat-1', effort: 'high' })
    // An absent effort is a clear, not an empty string.
    expect(calls[3].payload).toEqual({ dshSessionId: 'chat-1' })
    expect(calls[4].payload).toEqual({ dshSessionId: 'chat-1', configId: 'temp', value: 'high' })
    expect(calls[5].payload).toEqual({ dshSessionId: 'chat-1', configId: 'stream', value: true })
    // The advanced pick is part of the SAME conversation record, written
    // optimistically so the menu's checkmark moves on the click.
    expect(store.getSnapshot().chatChoice['chat-1']).toMatchObject({
      agentId: 'codebuddy',
      modelId: 'codebuddy@hy3',
      extraConfigs: { temp: 'high', stream: true },
    })
  })

  it('optimistically updates chatSessions when switching model, effort or mode', async () => {
    let listed = {
      sessions: [
        {
          agentId: 'codebuddy',
          sessionId: 's1',
          modelId: 'codebuddy@hy2',
          reasoningEffort: 'low',
          modes: { currentModeId: 'default', availableModes: [{ id: 'default', name: 'Default' }, { id: 'strict', name: 'Strict' }] },
        },
      ],
      acpMode: true,
    }
    let holdChatList: Promise<void> | undefined
    let releaseChatList: (() => void) | undefined
    const store = new AcpStore(async (_channel, endpoint, payload) => {
      if (endpoint === 'session/chat-model-set') {
        const p = payload as { modelId: string }
        listed = {
          ...listed,
          sessions: listed.sessions.map(s => ({ ...s, modelId: p.modelId })),
        }
        return { ok: true, value: {} }
      }
      if (endpoint === 'session/chat-effort-set') {
        const p = payload as { effort?: string }
        listed = {
          ...listed,
          sessions: listed.sessions.map(s => ({ ...s, reasoningEffort: p.effort })),
        }
        return { ok: true, value: {} }
      }
      if (endpoint === 'session/chat-mode-set') {
        const p = payload as { modeId: string }
        listed = {
          ...listed,
          sessions: listed.sessions.map(s => ({ ...s, modes: { ...s.modes, currentModeId: p.modeId } })),
        }
        return { ok: true, value: {} }
      }
      if (endpoint === 'session/chat-list') {
        if (holdChatList) await holdChatList
        return { ok: true, value: listed }
      }
      return { ok: true, value: {} }
    }, zh => zh)

    await store.loadChatSessions('chat-1')
    expect(store.getSnapshot().chatSessions[0]).toMatchObject({
      agentId: 'codebuddy',
      modelId: 'codebuddy@hy2',
      reasoningEffort: 'low',
      modes: { currentModeId: 'default' },
    })

    // Switching model optimistically updates chatSessions without waiting for reload
    await store.setChatSessionModel('chat-1', 'codebuddy@hy3', 'codebuddy')
    expect(store.getSnapshot().chatSessions[0]?.modelId).toBe('codebuddy@hy3')

    // Switching effort optimistically updates chatSessions
    await store.setChatSessionEffort('chat-1', 'high', 'codebuddy')
    expect(store.getSnapshot().chatSessions[0]?.reasoningEffort).toBe('high')

    // Switching mode optimistically updates both chatChoice and chatSessions before reload settles
    holdChatList = new Promise(resolve => { releaseChatList = resolve })
    const modePromise = store.setChatSessionMode('chat-1', 'strict', 'codebuddy')
    // Yield a microtask so chat-mode-set completes and optimistic write occurs
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(store.getSnapshot().chatChoice['chat-1']?.mode).toBe('strict')
    expect(store.getSnapshot().chatSessions[0]?.modes?.currentModeId).toBe('strict')
    releaseChatList!()
    await modePromise
    expect(store.getSnapshot().chatSessions[0]?.modes?.currentModeId).toBe('strict')

    // Switching on an unrelated conversation does not mutate chatSessionsFor chat-1
    const prevSessions = store.getSnapshot().chatSessions
    await store.setChatSessionModel('chat-2', 'codebuddy@hy4', 'codebuddy')
    expect(store.getSnapshot().chatSessions).toBe(prevSessions)

    // Switching to the same value does not mutate chatSessions
    await store.setChatSessionModel('chat-1', 'codebuddy@hy3', 'codebuddy')
    expect(store.getSnapshot().chatSessions).toBe(prevSessions)

    // session/meta event updates modes in chatSessions
    const apply = (event: unknown): Promise<void> =>
      (store as unknown as { applyEvent(event: unknown): Promise<void> }).applyEvent(event as never)
    await apply({
      type: 'session/meta',
      sessionId: 's1',
      session: {
        sessionId: 's1',
        agentId: 'codebuddy',
        acpSessionId: 'acp-1',
        cwd: '/w',
        running: false,
        closed: false,
        seq: 0,
        modes: { currentModeId: 'default', availableModes: [{ id: 'default', name: 'Default' }] },
      },
    })
    expect(store.getSnapshot().chatSessions[0]?.modes?.currentModeId).toBe('default')

    // session/meta with identical modes does not mutate chatSessions reference
    const sameMetaSessions = store.getSnapshot().chatSessions
    await apply({
      type: 'session/meta',
      sessionId: 's1',
      session: {
        sessionId: 's1',
        agentId: 'codebuddy',
        acpSessionId: 'acp-1',
        cwd: '/w',
        running: false,
        closed: false,
        seq: 0,
        modes: { currentModeId: 'default', availableModes: [{ id: 'default', name: 'Default' }] },
      },
    })
    expect(store.getSnapshot().chatSessions).toBe(sameMetaSessions)

    // session/meta with null or undefined modes does not throw and leaves chatSessions unchanged
    const metaNullSessions = store.getSnapshot().chatSessions
    await apply({
      type: 'session/meta',
      sessionId: 's1',
      session: {
        sessionId: 's1',
        agentId: 'codebuddy',
        acpSessionId: 'acp-1',
        cwd: '/w',
        running: false,
        closed: false,
        seq: 0,
        modes: null,
      },
    })
    expect(store.getSnapshot().chatSessions).toBe(metaNullSessions)

    await apply({
      type: 'session/meta',
      sessionId: 's1',
      session: {
        sessionId: 's1',
        agentId: 'codebuddy',
        acpSessionId: 'acp-1',
        cwd: '/w',
        running: false,
        closed: false,
        seq: 0,
      },
    })
    expect(store.getSnapshot().chatSessions).toBe(metaNullSessions)

    // Switching model without explicit agentId infers owner from modelId
    await store.setChatSessionModel('chat-1', 'codebuddy@hy4')
    expect(store.getSnapshot().chatSessions[0]?.modelId).toBe('codebuddy@hy4')
    expect(store.getSnapshot().chatChoice['chat-1']?.modelId).toBe('codebuddy@hy4')

    // Switching model with multiple '@' correctly extracts the leading agent id
    await store.setChatSessionModel('chat-1', 'codebuddy@var@nested')
    expect(store.getSnapshot().chatSessions[0]?.modelId).toBe('codebuddy@var@nested')
    expect(store.getSnapshot().chatChoice['chat-1']?.agentId).toBe('codebuddy')

    // Switching model with leading '@' (malformed) falls back to existing owner rather than setting ""
    await store.setChatSessionModel('chat-1', '@only-choice')
    expect(store.getSnapshot().chatChoice['chat-1']?.agentId).toBe('codebuddy')
    expect(store.getSnapshot().chatSessions[0]?.modelId).toBe('@only-choice')

    // Switching with whitespace agentId falls back rather than corrupting agentId into whitespace
    await store.setChatSessionEffort('chat-1', 'low', '   ')
    expect(store.getSnapshot().chatChoice['chat-1']?.agentId).toBe('codebuddy')
    expect(store.getSnapshot().chatSessions[0]?.reasoningEffort).toBe('low')
  })

  it('drops a pre-first-turn thought pick on a model switch, keeps it on a live session', async () => {
    let listed: { sessions: Array<{ agentId: string; sessionId: string; modelId: string; reasoningEffort?: string }>; acpMode: boolean } = {
      sessions: [],
      acpMode: true,
    }
    const store = new AcpStore(async (_channel, endpoint) => {
      if (endpoint === 'session/chat-list') return { ok: true, value: listed }
      return { ok: true, value: {} }
    }, (zh) => zh)

    // No ACP session yet: a level picked for `hy3` cannot be presented as
    // `hy4`'s (the host clears it for the same reason).
    await store.loadChatSessions('chat-pick')
    await store.setChatSessionModel('chat-pick', 'codebuddy@hy3', 'codebuddy')
    await store.setChatSessionEffort('chat-pick', 'high', 'codebuddy')
    expect(store.getSnapshot().chatChoice['chat-pick']).toMatchObject({ modelId: 'codebuddy@hy3', effort: 'high' })
    await store.setChatSessionModel('chat-pick', 'codebuddy@hy4', 'codebuddy')
    expect(store.getSnapshot().chatChoice['chat-pick']).toEqual({ agentId: 'codebuddy', modelId: 'codebuddy@hy4' })

    // A LIVE session is different: the host re-validates the level against the
    // new model's own options, so the optimistic path must not drop it first.
    listed = {
      sessions: [{ agentId: 'codebuddy', sessionId: 's1', modelId: 'codebuddy@hy3', reasoningEffort: 'high' }],
      acpMode: true,
    }
    await store.loadChatSessions('chat-live')
    await store.setChatSessionModel('chat-live', 'codebuddy@hy3', 'codebuddy')
    await store.setChatSessionEffort('chat-live', 'high', 'codebuddy')
    await store.setChatSessionModel('chat-live', 'codebuddy@hy4', 'codebuddy')
    expect(store.getSnapshot().chatChoice['chat-live']).toMatchObject({ modelId: 'codebuddy@hy4', effort: 'high' })
    expect(store.getSnapshot().chatSessions[0]?.reasoningEffort).toBe('high')
  })

  it('attributes a pick to the plugin default before anything was bound', async () => {
    // A fresh conversation served by the default agent has no binding and no
    // choice yet. The host records the pick for that agent; the optimistic
    // chip must do the same instead of waiting for the next `session/chat-list`.
    const { store, calls } = makeStore('codebuddy')
    await store.resync()
    await store.setChatSessionEffort('chat-2', 'high', 'codebuddy')
    expect(calls.at(-1)).toEqual({
      endpoint: 'session/chat-effort-set',
      payload: { dshSessionId: 'chat-2', effort: 'high', agentId: 'codebuddy' },
    })
    expect(store.getSnapshot().chatChoice['chat-2']).toEqual({ agentId: 'codebuddy', effort: 'high' })
  })

  it('surfaces a failed binding as a notice AND rethrows, so the menu shows the error', async () => {
    const store = new AcpStore(async (_channel, endpoint) => {
      if (endpoint === 'session/chat-bind') return { ok: false, error: { code: 'unknown_agent', message: 'no such agent' } }
      return { ok: true, value: {} }
    }, (zh) => zh)

    await expect(store.bindChatAgent('chat-1', 'ghost')).rejects.toThrow('no such agent')
    expect(store.getSnapshot().notice).toBe('no such agent')
  })

  it('reads the plugin default agent from default/agent and sets it back', async () => {
    const { store, calls } = makeStore('codebuddy')

    await store.resync()
    expect(store.getSnapshot().defaultAgent).toBe('codebuddy')

    // No default agent chosen: absent, not a fallback.
    const bare = makeStore()
    await bare.store.resync()
    expect(bare.store.getSnapshot().defaultAgent).toBeUndefined()

    await store.setDefaultAgent('pi')
    expect(calls.at(-1)).toEqual({ endpoint: 'default/agent-set', payload: { agentId: 'pi' } })
    expect(store.getSnapshot().defaultAgent).toBe('pi')

    // Clearing is legal (the only way to remove a star).
    await store.setDefaultAgent(undefined)
    expect(calls.at(-1)).toEqual({ endpoint: 'default/agent-set', payload: {} })
    expect(store.getSnapshot().defaultAgent).toBeUndefined()
  })
})
