/**
 * The per-agent default chat mode, against a real mock ACP child.
 *
 * The composer's pre-first-message value, the conversation's seeded pick and
 * the actual `session/set_mode` must agree; an explicit pick outranks the
 * default, a value the agent no longer offers is skipped with one notice, and
 * the lightweight RPC persists across a host restart.
 */
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { BridgeManager } from '../../src/bridge.ts'
import type { AcpEvent } from '../../src/protocol.ts'
import { dispatchRpc, EventHub } from '../../src/impl.ts'
import { def } from './harness.ts'

describe('agent default chat mode (isolated manager)', () => {
  const pickHub = new EventHub()

  it("starts a new conversation on the agent's configured default mode", async () => {
    const storage = `${tmpdir()}/acp-default-mode-${Date.now()}.json`
    const gm = new BridgeManager(
      [{ ...def, id: 'defaulted', defaultMode: 'strict' }],
      pickHub,
      500,
      storage,
    )
    try {
      gm.bindChatAgent('dsh-default-mode', 'defaulted')
      expect(gm.chatChoice('dsh-default-mode')).toEqual({ agentId: 'defaulted' })

      // No catalog was ever read: the configured default is captured without
      // one, seeded as the conversation's pick, and applied to the fresh
      // session (whose own `session/new` answer starts on 'default').
      for await (const _ of gm.streamPrompt({
        model: 'defaulted',
        sessionId: 'dsh-default-mode',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      } as never)) { /* drain */ }

      expect(gm.chatSessions('dsh-default-mode')[0]?.modes?.currentModeId).toBe('strict')
      expect(gm.chatChoice('dsh-default-mode')).toMatchObject({ agentId: 'defaulted', mode: 'strict' })
    } finally {
      await gm.shutdownAll()
    }
  }, 30_000)

  it('keeps an explicit pre-first-turn mode pick over the agent default', async () => {
    const storage = `${tmpdir()}/acp-default-mode-pick-${Date.now()}.json`
    const gm = new BridgeManager(
      [{ ...def, id: 'defaulted-pick', defaultMode: 'strict', env: { MOCK_FIRST_MODE: 'strict' } }],
      pickHub,
      500,
      storage,
    )
    try {
      gm.bindChatAgent('dsh-default-mode-pick', 'defaulted-pick')
      // The pick is recorded without a session; the fresh session starts on
      // 'strict' (MOCK_FIRST_MODE), so a surviving 'default' proves the pick won.
      await gm.setChatSessionMode('dsh-default-mode-pick', 'default', 'defaulted-pick')

      for await (const _ of gm.streamPrompt({
        model: 'defaulted-pick',
        sessionId: 'dsh-default-mode-pick',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      } as never)) { /* drain */ }

      expect(gm.chatSessions('dsh-default-mode-pick')[0]?.modes?.currentModeId).toBe('default')
      expect(gm.chatChoice('dsh-default-mode-pick')).toMatchObject({ agentId: 'defaulted-pick', mode: 'default' })
    } finally {
      await gm.shutdownAll()
    }
  }, 30_000)

  it('skips a default mode the fresh session does not offer, with one notice', async () => {
    const storage = `${tmpdir()}/acp-default-mode-stale-${Date.now()}.json`
    const hub = new EventHub()
    const events: AcpEvent[] = []
    hub.subscribe(event => { events.push(event) })
    const gm = new BridgeManager([{ ...def, id: 'defaulted-stale', defaultMode: 'gone' }], hub, 500, storage)
    try {
      gm.bindChatAgent('dsh-default-mode-stale', 'defaulted-stale')
      for await (const _ of gm.streamPrompt({
        model: 'defaulted-stale',
        sessionId: 'dsh-default-mode-stale',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      } as never)) { /* drain */ }

      expect(gm.chatSessions('dsh-default-mode-stale')[0]?.modes?.currentModeId).toBe('default')
      expect(gm.chatChoice('dsh-default-mode-stale')?.mode).toBeUndefined()
      const notices = events.filter((event): event is Extract<AcpEvent, { type: 'agent/notice' }> => event.type === 'agent/notice')
      expect(notices.some(event => event.text.includes('default mode "gone"'))).toBe(true)
    } finally {
      await gm.shutdownAll()
    }
  }, 30_000)

  it('preserves the default mode when a save payload predates the lightweight write', async () => {
    const storage = `${tmpdir()}/acp-default-mode-save-${Date.now()}.json`
    const gm = new BridgeManager([{ ...def, id: 'defaulted-save' }], pickHub, 500, storage)
    try {
      await gm.setDefaultMode('defaulted-save', 'strict')
      // A save captured before the RPC (a queued save, or an older browser
      // bundle) carries no field; the host must inherit the live value.
      const saved = await gm.saveAgent({ ...def, id: 'defaulted-save' })
      expect(saved.done).toBe(true)
      expect((await gm.detectAgents()).find(info => info.id === 'defaulted-save')?.currentConfig?.defaultMode).toBe('strict')
    } finally {
      await gm.shutdownAll()
    }
  }, 30_000)

  it('persists the default mode through the lightweight RPC and clears it', async () => {
    const storage = `${tmpdir()}/acp-default-mode-persist-${Date.now()}.json`
    const gm = new BridgeManager([{ ...def, id: 'defaulted-persist' }], pickHub, 500, storage)
    try {
      await dispatchRpc(gm, 'agent/set-default-mode', { agentId: 'defaulted-persist', defaultMode: 'strict' })
      expect((await gm.detectAgents()).find(info => info.id === 'defaulted-persist')?.currentConfig?.defaultMode).toBe('strict')

      // A fresh manager (host restart) reads the value back from the state file.
      const again = new BridgeManager([{ ...def, id: 'defaulted-persist' }], pickHub, 500, storage)
      try {
        expect((await again.detectAgents()).find(info => info.id === 'defaulted-persist')?.currentConfig?.defaultMode).toBe('strict')
        await dispatchRpc(again, 'agent/set-default-mode', { agentId: 'defaulted-persist', defaultMode: '' })
        expect((await again.detectAgents()).find(info => info.id === 'defaulted-persist')?.currentConfig?.defaultMode).toBeUndefined()
      } finally {
        await again.shutdownAll()
      }
    } finally {
      await gm.shutdownAll()
    }
  }, 30_000)
})
