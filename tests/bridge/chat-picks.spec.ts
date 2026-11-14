import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { AgentBridge, BridgeManager, routeBindingRegistry } from '../../src/bridge.ts'
import { type AcpAgentCatalog, type AcpAgentDef, type AcpEvent, type StreamChunk } from '../../src/protocol.ts'
import { dispatchRpc, EventHub } from '../../src/impl.ts'
import { def } from './harness.ts'

describe('pre-chat pick persistence (isolated manager)', () => {
  const pickHub = new EventHub()

  it('records a model/effort pick before any ACP session exists, and reports it back', async () => {
    const storage = `${tmpdir()}/acp-pick-${Date.now()}.json`
    const gm = new BridgeManager([{ ...def, id: 'picked' }], pickHub, 500, storage)

    // Nothing bound and nothing picked: the composer has nothing to show.
    expect(gm.chatChoice('dsh-pick-1')).toBeUndefined()

    gm.bindChatAgent('dsh-pick-1', 'picked')
    // No live session exists at this point — that is the whole point.
    expect(gm.chatSessions('dsh-pick-1')).toEqual([])

    await gm.setChatSessionModel('dsh-pick-1', 'picked@opus')
    await gm.setChatSessionEffort('dsh-pick-1', 'high')
    expect(gm.chatChoice('dsh-pick-1')).toEqual({ agentId: 'picked', modelId: 'picked@opus', effort: 'high' })
    // Still no session: the pick was recorded without creating one.
    expect(gm.chatSessions('dsh-pick-1')).toEqual([])

    await gm.shutdownAll()
  })

  it('clears a thought-level pick when the model changes before any session exists', async () => {
    const storage = `${tmpdir()}/acp-pick-switch-${Date.now()}.json`
    const gm = new BridgeManager([{ ...def, id: 'picked' }], pickHub, 500, storage)
    gm.bindChatAgent('dsh-pick-switch', 'picked')
    await gm.setChatSessionModel('dsh-pick-switch', 'picked@opus')
    await gm.setChatSessionEffort('dsh-pick-switch', 'high')
    expect(gm.chatChoice('dsh-pick-switch')).toMatchObject({ modelId: 'picked@opus', effort: 'high' })

    // No live session can say whether `high` exists on the new model, so the
    // level is dropped rather than shown as the new model's own (the reported
    // "thought level still shows the previous model's" before the first turn).
    await gm.setChatSessionModel('dsh-pick-switch', 'picked@sonnet')
    expect(gm.chatChoice('dsh-pick-switch')).toEqual({ agentId: 'picked', modelId: 'picked@sonnet' })

    // Re-picking the SAME model is not a switch: a level chosen after the
    // switch stands.
    await gm.setChatSessionEffort('dsh-pick-switch', 'low')
    await gm.setChatSessionModel('dsh-pick-switch', 'picked@sonnet')
    expect(gm.chatChoice('dsh-pick-switch')).toEqual({ agentId: 'picked', modelId: 'picked@sonnet', effort: 'low' })
    await gm.shutdownAll()
  })

  it('persists the tag halo preference and reloads it', async () => {
    const storage = `${tmpdir()}/acp-halo-${Date.now()}.json`
    const gm = new BridgeManager([{ ...def, id: 'picked' }], pickHub, 500, storage)
    // The default before anything was ever saved.
    expect(gm.tagHalo()).toEqual({ mode: 'breath', speed: 'normal' })

    await gm.setTagHalo({ mode: 'steady', speed: 'slow' })
    // A fresh manager (host restart) reads the same registry file back.
    const reloaded = new BridgeManager([{ ...def, id: 'picked' }], pickHub, 500, storage)
    expect(reloaded.tagHalo()).toEqual({ mode: 'steady', speed: 'slow' })
    await reloaded.shutdownAll()
    await gm.shutdownAll()
  })

  it('persists the session-title prefix toggle and reloads it', async () => {
    const storage = `${tmpdir()}/acp-title-prefix-${Date.now()}.json`
    const gm = new BridgeManager([{ ...def, id: 'picked' }], pickHub, 500, storage)
    // The default before anything was ever saved.
    expect(gm.sessionTitlePrefix()).toBe(true)

    await gm.setSessionTitlePrefix(false)
    // A fresh manager (host restart) reads the same registry file back.
    const reloaded = new BridgeManager([{ ...def, id: 'picked' }], pickHub, 500, storage)
    expect(reloaded.sessionTitlePrefix()).toBe(false)
    await reloaded.shutdownAll()
    // A hand-edited non-boolean reads as the default (on), never as an
    // explicit value — the same user-editable-file rule the halo hydrates by.
    writeFileSync(storage, readFileSync(storage, 'utf-8').replace(/"sessionTitlePrefix": ?false/, '"sessionTitlePrefix":"false"'))
    const coerced = new BridgeManager([{ ...def, id: 'picked' }], pickHub, 500, storage)
    expect(coerced.sessionTitlePrefix()).toBe(true)
    await coerced.shutdownAll()
    await gm.shutdownAll()
  })

  it('edits an approval deadline live, persists it, and resets to the config file', async () => {
    const storage = `${tmpdir()}/acp-deadlines-${Date.now()}.json`
    const gm = new BridgeManager([{ ...def, id: 'picked' }], pickHub, 500, storage)
    // Nothing configured, nothing overridden: the built-in 5-minute window and
    // the default mode.
    expect(gm.approvalDeadlines()).toEqual({ permissionTimeoutMs: 300_000, mode: 'wait' })
    // A deployment that names the window in `cordis.patch.yml` reports it as
    // the reset target — "the file says 10 minutes" and "nothing was
    // configured, 5 is the built-in default" are different facts, and the
    // settings card has to be able to tell them apart.
    gm.setConfiguredApprovalDeadlines({ permissionTimeoutMs: 600_000 }, 'wait')
    expect(gm.approvalDeadlines()).toMatchObject({
      permissionTimeoutMs: 600_000,
      mode: 'wait',
      configured: { permissionTimeoutMs: 600_000 },
      configuredMode: 'wait',
    })

    // The UI write outranks the config file and reaches the LIVE bridge without
    // restarting anything — the whole point over an `agent/save`-style reload,
    // which would cost the user every running session.
    const tuningOf = (b: AgentBridge): { permissionTimeoutMs: number } =>
      b as unknown as { permissionTimeoutMs: number }
    const liveBridge = new AgentBridge({ ...def, id: 'live' }, pickHub, 500, () => { /* no manager behind it */ })
    ;(gm as unknown as { bridges: Map<string, AgentBridge> }).bridges.set('live', liveBridge)
    await gm.setApprovalDeadlines({ permissionTimeoutMs: 30_000, mode: 'auto' })
    expect(gm.approvalDeadlines()).toMatchObject({
      permissionTimeoutMs: 30_000,
      mode: 'auto',
      configured: { permissionTimeoutMs: 600_000 },
      configuredMode: 'wait',
    })
    expect(tuningOf(liveBridge).permissionTimeoutMs).toBe(30_000)
    // The mode reaches the live bridge too — it decides what an expiry DOES.
    expect((liveBridge as unknown as { permissionTimeoutMode: string }).permissionTimeoutMode).toBe('auto')

    // Persisted: a host restart comes back on the value the user picked, not the
    // deployment baseline. The host entry re-declares the patch file's baseline
    // on every boot, so the override has to keep outranking it after a restart.
    const reloaded = new BridgeManager([{ ...def, id: 'picked' }], pickHub, 500, storage)
    reloaded.setConfiguredApprovalDeadlines({ permissionTimeoutMs: 600_000 }, 'wait')
    expect(reloaded.approvalDeadlines()).toMatchObject({
      permissionTimeoutMs: 30_000,
      mode: 'auto',
      configured: { permissionTimeoutMs: 600_000 },
    })

    // Reset drops the override: the config file decides again.
    await reloaded.setApprovalDeadlines({}, true)
    expect(reloaded.approvalDeadlines()).toMatchObject({
      permissionTimeoutMs: 600_000,
      mode: 'wait',
    })
    // A fresh manager over the same file sees the same thing (the reset persisted).
    const afterReset = new BridgeManager([{ ...def, id: 'picked' }], pickHub, 500, storage)
    afterReset.setConfiguredApprovalDeadlines({ permissionTimeoutMs: 600_000 }, 'wait')
    expect(afterReset.approvalDeadlines()).toMatchObject({ permissionTimeoutMs: 600_000, mode: 'wait' })

    // An out-of-range write is refused before it can reach state, and the value
    // in force is untouched.
    await expect(reloaded.setApprovalDeadlines({ permissionTimeoutMs: -1 })).rejects.toThrow(/permissionTimeoutMs/)
    expect(reloaded.approvalDeadlines().permissionTimeoutMs).toBe(600_000)
    // A mode that is not one of the three is refused the same way.
    await expect(reloaded.setApprovalDeadlines({ mode: 'maybe' as never })).rejects.toThrow(/permissionTimeoutMode/)
    expect(reloaded.approvalDeadlines().mode).toBe('wait')

    await afterReset.shutdownAll()
    await reloaded.shutdownAll()
    await gm.shutdownAll()
  })

  interface PersistedDeadlines {
    approvalDeadlines?: { permissionTimeoutMs?: number; mode?: string }
  }

  const readDeadlines = (storage: string): PersistedDeadlines['approvalDeadlines'] =>
    (JSON.parse(readFileSync(storage, 'utf-8')) as PersistedDeadlines).approvalDeadlines

  it('keeps a user-picked zero through a mode switch and a restart', async () => {
    const storage = `${tmpdir()}/acp-deadline-zero-${Date.now()}.json`
    const gm = new BridgeManager([{ ...def, id: 'zero' }], pickHub, 500, storage)
    // 不等待 is the user's pick: it runs as zero under `auto`.
    await gm.setApprovalDeadlines({ permissionTimeoutMs: 0, mode: 'auto' })
    expect(gm.approvalDeadlines()).toMatchObject({ permissionTimeoutMs: 0, mode: 'auto' })
    // A mode-only write carries no window: the stored zero survives, while the
    // RUNTIME value floors to the shortest real wait under `abort`.
    await gm.setApprovalDeadlines({ mode: 'abort' })
    expect(gm.approvalDeadlines()).toMatchObject({ permissionTimeoutMs: 30_000, mode: 'abort' })
    expect(readDeadlines(storage)).toEqual({ permissionTimeoutMs: 0, mode: 'abort' })
    // Switching back restores the zero — because the write never rewrote it.
    await gm.setApprovalDeadlines({ mode: 'auto' })
    expect(gm.approvalDeadlines()).toMatchObject({ permissionTimeoutMs: 0, mode: 'auto' })
    expect(readDeadlines(storage)).toEqual({ permissionTimeoutMs: 0, mode: 'auto' })
    // A restart reads the same raw zero back, and the runtime agrees.
    const reloaded = new BridgeManager([{ ...def, id: 'zero' }], pickHub, 500, storage)
    expect(reloaded.approvalDeadlines()).toMatchObject({ permissionTimeoutMs: 0, mode: 'auto' })
    expect(readDeadlines(storage)).toEqual({ permissionTimeoutMs: 0, mode: 'auto' })
    await reloaded.shutdownAll()
    await gm.shutdownAll()
  })

  it('keeps a real window unchanged through every mode switch', async () => {
    const storage = `${tmpdir()}/acp-deadline-real-${Date.now()}.json`
    const gm = new BridgeManager([{ ...def, id: 'real' }], pickHub, 500, storage)
    await gm.setApprovalDeadlines({ permissionTimeoutMs: 300_000, mode: 'auto' })
    expect(readDeadlines(storage)).toEqual({ permissionTimeoutMs: 300_000, mode: 'auto' })
    await gm.setApprovalDeadlines({ mode: 'abort' })
    expect(gm.approvalDeadlines()).toMatchObject({ permissionTimeoutMs: 300_000, mode: 'abort' })
    expect(readDeadlines(storage)).toEqual({ permissionTimeoutMs: 300_000, mode: 'abort' })
    await gm.setApprovalDeadlines({ mode: 'auto' })
    expect(gm.approvalDeadlines()).toMatchObject({ permissionTimeoutMs: 300_000, mode: 'auto' })
    expect(readDeadlines(storage)).toEqual({ permissionTimeoutMs: 300_000, mode: 'auto' })
    const reloaded = new BridgeManager([{ ...def, id: 'real' }], pickHub, 500, storage)
    expect(reloaded.approvalDeadlines()).toMatchObject({ permissionTimeoutMs: 300_000, mode: 'auto' })
    await reloaded.shutdownAll()
    await gm.shutdownAll()
  })

  it('floors a persisted zero under abort at runtime only', async () => {
    // A state file can hold any pair the user or an older build wrote. The
    // zero must NOT become 「不等待并立即拒绝」: under `abort` it runs as the
    // 30 s minimum, and the file stays what the user chose.
    const storage = `${tmpdir()}/acp-deadline-legacy-zero-${Date.now()}.json`
    writeFileSync(storage, JSON.stringify({
      version: 2,
      approvalDeadlines: { permissionTimeoutMs: 0, mode: 'abort' },
    }), 'utf-8')
    const gm = new BridgeManager([{ ...def, id: 'legacy-zero' }], pickHub, 500, storage)
    expect(gm.approvalDeadlines()).toMatchObject({ permissionTimeoutMs: 30_000, mode: 'abort' })
    expect(readDeadlines(storage)).toEqual({ permissionTimeoutMs: 0, mode: 'abort' })
    await gm.shutdownAll()
  })

  it('reads the persisted zero back raw at boot, so a mode switch can restore it', async () => {
    // Startup must not rewrite the stored pick with the abort floor. If the
    // load path normalized it, the runtime would read the same 30 s as the
    // fixed logic and nothing below could fail — so this case asserts BOTH
    // halves: the runtime floor at boot, and the raw zero still being the
    // value a later switch back to `auto` runs on (the file included).
    const storage = `${tmpdir()}/acp-deadline-boot-zero-${Date.now()}.json`
    writeFileSync(storage, JSON.stringify({
      version: 2,
      approvalDeadlines: { permissionTimeoutMs: 0, mode: 'abort' },
    }), 'utf-8')
    const gm = new BridgeManager([{ ...def, id: 'boot-zero' }], pickHub, 500, storage)
    // Boot applies the abort floor to the RUNTIME value only.
    expect(gm.approvalDeadlines()).toMatchObject({ permissionTimeoutMs: 30_000, mode: 'abort' })
    // Switching back to `auto` recovers 不等待 from the stored value, not from
    // a boot-time rewrite of it.
    await gm.setApprovalDeadlines({ mode: 'auto' })
    expect(gm.approvalDeadlines()).toMatchObject({ permissionTimeoutMs: 0, mode: 'auto' })
    expect(readDeadlines(storage)).toEqual({ permissionTimeoutMs: 0, mode: 'auto' })
    await gm.shutdownAll()
    // A second boot over the same file agrees, so the guard also covers
    // reading a value the restart itself wrote.
    const reloaded = new BridgeManager([{ ...def, id: 'boot-zero' }], pickHub, 500, storage)
    expect(reloaded.approvalDeadlines()).toMatchObject({ permissionTimeoutMs: 0, mode: 'auto' })
    await reloaded.shutdownAll()
  })

  it('records an extra config option and applies it when the first session materializes', async () => {
    const storage = `${tmpdir()}/acp-pick-config-${Date.now()}.json`
    const gm = new BridgeManager([{ ...def, id: 'picked' }], pickHub, 500, storage)
    try {
      await gm.probeAgentModels('picked')
      // `temp` is the mock agent's extra: a select with no category. It is what
      // the composer's advanced base lists (the model/thought/mode axes keep
      // their own controls and are not repeated there).
      expect(gm.agentCatalog('picked').extras).toEqual([{
        configId: 'temp',
        name: 'Temperature',
        currentValue: 'mid',
        choices: [
          { id: 'low', name: 'low' },
          { id: 'mid', name: 'mid' },
          { id: 'high', name: 'high' },
        ],
      }, {
        // A boolean toggle: `kind` is what makes the composer draw a checkbox
        // row instead of an empty select.
        configId: 'stream',
        name: 'Stream Mode',
        kind: 'boolean',
        currentValue: 'false',
        choices: [],
      }])

      gm.bindChatAgent('dsh-pick-config', 'picked')
      await dispatchRpc(gm, 'session/chat-config-set', {
        dshSessionId: 'dsh-pick-config', configId: 'temp', value: 'high',
      })
      // A checkbox pick arrives as 'true' / 'false' from the browser row and is
      // stored as a real boolean.
      await dispatchRpc(gm, 'session/chat-config-set', {
        dshSessionId: 'dsh-pick-config', configId: 'stream', value: 'true',
      })
      expect(gm.chatChoice('dsh-pick-config')).toMatchObject({
        agentId: 'picked',
        extraConfigs: { temp: 'high', stream: true },
      })

      // The first turn creates the session; the pick reaches the agent before
      // the prompt is sent (`applyChatChoice`).
      for await (const _ of gm.streamPrompt({
        model: 'picked',
        sessionId: 'dsh-pick-config',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      } as never)) { /* drain */ }
      const live = (gm.sessions() as Array<{
        agentId: string
        configOptions?: Array<{ configId: string; currentValue: unknown }>
      }>).find(session => session.agentId === 'picked')
      expect(live?.configOptions?.find(option => option.configId === 'temp')?.currentValue).toBe('high')
      // The toggle reached the agent as a real boolean (`type: 'boolean'` is
      // enforced by the mock, which throws on a bare value).
      expect(live?.configOptions?.find(option => option.configId === 'stream')?.currentValue).toBe(true)

      // The primary axes are not extras; unknown values are refused, and a
      // toggle only accepts its own vocabulary.
      await expect(gm.setChatSessionConfig('dsh-pick-config', 'temp', 'nope')).rejects.toMatchObject({ code: 'bad_config' })
      await expect(gm.setChatSessionConfig('dsh-pick-config', 'model', 'mock-model-a')).rejects.toMatchObject({ code: 'unknown_config' })
      await expect(gm.setChatSessionConfig('dsh-pick-config', 'stream', 'nope')).rejects.toMatchObject({ code: 'bad_config' })

      // It is part of the conversation record, not process state.
      const reloaded = new BridgeManager([{ ...def, id: 'picked' }], pickHub, 500, storage)
      expect(reloaded.chatChoice('dsh-pick-config')).toMatchObject({ extraConfigs: { temp: 'high', stream: true } })
      await reloaded.shutdownAll()
    } finally {
      await gm.shutdownAll()
    }
  }, 30_000)

  it('reports the agent\'s own slash commands with the chat session view', async () => {
    const gm = new BridgeManager([{ ...def, id: 'picked' }], pickHub, 500, `${tmpdir()}/acp-pick-commands-${Date.now()}.json`)
    gm.bindChatAgent('dsh-pick-cmd', 'picked')
    for await (const _ of gm.streamPrompt({
      model: 'picked',
      sessionId: 'dsh-pick-cmd',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    } as never)) { /* drain */ }

    // The composer's `/` menu is the agent's in an NTR conversation, and these
    // are its rows: the whole row the agent declared, not just a name.
    expect(gm.chatSessions('dsh-pick-cmd')[0]?.availableCommands).toEqual([
      { name: 'greet', description: 'say hi' },
    ])
    // The same declaration is cached per agent, so a conversation that has no
    // session yet can list it before its first message.
    expect(gm.agentCatalog('picked').commands).toEqual([{ name: 'greet', description: 'say hi' }])
    await gm.shutdownAll()
  }, 30_000)

  it('keeps the agent\'s slash commands across a host restart', async () => {
    // The cache is what `/` reads in a brand-new conversation, so it has to
    // outlive the process that learned it — like the model catalog does.
    const home = join(tmpdir(), `acp-cmd-cache-${Date.now()}`)
    mkdirSync(home, { recursive: true })
    const previous = process.env.DSH_NTR_STATE_DIR
    process.env.DSH_NTR_STATE_DIR = join(home, 'state')
    try {
      const first = new BridgeManager([{ ...def, id: 'cmd-cache' }], pickHub, 500, join(home, 'agents.json'))
      first.bindChatAgent('dsh-cmd-1', 'cmd-cache')
      for await (const _ of first.streamPrompt({
        model: 'cmd-cache',
        sessionId: 'dsh-cmd-1',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      } as never)) { /* drain */ }
      await first.shutdownAll()

      const second = new BridgeManager([{ ...def, id: 'cmd-cache' }], pickHub, 500, join(home, 'agents.json'))
      // The session record is restored PARKED (a restart kills the process,
      // not the conversation)...
      expect(second.chatSessions('dsh-cmd-1')).toMatchObject([{ agentId: 'cmd-cache', released: true }])
      // ...and the agent-level answer — what `/` reads in a brand-new
      // conversation — is there too.
      expect(second.agentCatalog('cmd-cache').commands).toEqual([{ name: 'greet', description: 'say hi' }])
      await second.shutdownAll()
    } finally {
      if (previous === undefined) delete process.env.DSH_NTR_STATE_DIR
      else process.env.DSH_NTR_STATE_DIR = previous
    }
  }, 30_000)

  it('survives a host restart, because the pick belongs to the conversation, not the process', async () => {
    const storage = `${tmpdir()}/acp-pick-restart-${Date.now()}.json`
    const first = new BridgeManager([{ ...def, id: 'picked' }], pickHub, 500, storage)
    first.bindChatAgent('dsh-pick-2', 'picked')
    await first.setChatSessionModel('dsh-pick-2', 'picked@sonnet')
    await first.setChatSessionEffort('dsh-pick-2', 'low')
    await first.shutdownAll()

    // A fresh manager over the same storage answers with the same pick — this
    // is what a browser reloading after a host restart reads back.
    const second = new BridgeManager([{ ...def, id: 'picked' }], pickHub, 500, storage)
    expect(second.chatChoice('dsh-pick-2')).toEqual({ agentId: 'picked', modelId: 'picked@sonnet', effort: 'low' })
    await second.shutdownAll()
  })

  it('drops the previous agent\'s model and effort when the conversation switches agent', async () => {
    const gm = new BridgeManager(
      [{ ...def, id: 'alpha' }, { ...def, id: 'beta' }],
      pickHub,
      500,
      `${tmpdir()}/acp-pick-switch-${Date.now()}.json`,
    )
    gm.bindChatAgent('dsh-pick-3', 'alpha')
    await gm.setChatSessionModel('dsh-pick-3', 'alpha@opus')
    await gm.setChatSessionEffort('dsh-pick-3', 'high')

    // Those values are alpha's vocabulary: `opus` is a choice from ITS catalog
    // and `high` a value of ITS thought_level. Carrying them to beta would ask
    // the new agent for things it never offered.
    gm.bindChatAgent('dsh-pick-3', 'beta')
    expect(gm.chatChoice('dsh-pick-3')).toEqual({ agentId: 'beta' })

    // Re-picking the SAME agent is not a switch: the model and effort stand.
    await gm.setChatSessionModel('dsh-pick-3', 'beta@sonnet')
    gm.bindChatAgent('dsh-pick-3', 'beta')
    expect(gm.chatChoice('dsh-pick-3')).toEqual({ agentId: 'beta', modelId: 'beta@sonnet' })
    await gm.shutdownAll()
  })

  /**
   * The agent's own mode is the third control in the same bar, so it follows the
   * same "remember the last choice" contract. It used to be the one that did
   * not: `setChatSessionMode` wrote only into the live session, so a restart
   * silently put the conversation back on the agent's starting mode.
   */
  it('persists the agent\'s own mode alongside the model and thought level', async () => {
    const storage = `${tmpdir()}/acp-pick-mode-${Date.now()}.json`
    const gm = new BridgeManager([def], pickHub, 500, storage)
    gm.bindChatAgent('dsh-pick-mode-1', 'mock')
    // The mode can only be SET once a session exists (the agent declares its
    // mode list in `session/new`), so send one turn to materialize it.
    for await (const _ of gm.streamPrompt({
      model: 'mock',
      sessionId: 'dsh-pick-mode-1',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    } as never)) { /* drain */ }
    const [session] = gm.chatSessions('dsh-pick-mode-1')
    const available = session?.modes?.availableModes ?? []
    expect(available.length).toBeGreaterThan(1)
    const target = available.find(mode => mode.id !== session?.modes?.currentModeId)
    expect(target).toBeDefined()

    await gm.setChatSessionMode('dsh-pick-mode-1', target!.id, 'mock')
    // The pick now carries the mode next to the other two axes.
    expect(gm.chatChoice('dsh-pick-mode-1')).toMatchObject({ agentId: 'mock', mode: target!.id })

    // And it survives a host restart, which is the whole point.
    await gm.shutdownAll()
    const again = new BridgeManager([def], pickHub, 500, storage)
    expect(again.chatChoice('dsh-pick-mode-1')).toMatchObject({ agentId: 'mock', mode: target!.id })
    await again.shutdownAll()
  })

  it('records a mode pick before any ACP session exists', async () => {
    // The composer's mode select reads its OPTIONS from the agent catalog, so it
    // is now reachable on a conversation that has never sent a message — and the
    // click must land. It used to throw `unknown_session` here, which on screen
    // is indistinguishable from a dead control (user report, 2026-10-18).
    const gm = new BridgeManager([def], pickHub, 500, `${tmpdir()}/acp-pick-mode-early-${Date.now()}.json`)
    gm.bindChatAgent('dsh-pick-mode-3', 'mock')
    expect(gm.chatSessions('dsh-pick-mode-3')).toEqual([])
    await gm.setChatSessionMode('dsh-pick-mode-3', 'strict', 'mock')
    expect(gm.chatChoice('dsh-pick-mode-3')).toMatchObject({ agentId: 'mock', mode: 'strict' })
    // Still nothing spawned: choosing ahead of the first message costs no process.
    expect(gm.chatSessions('dsh-pick-mode-3')).toEqual([])
    // ...and it is applied to the session the first turn materializes.
    for await (const _ of gm.streamPrompt({
      model: 'mock',
      sessionId: 'dsh-pick-mode-3',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    } as never)) { /* drain */ }
    expect(gm.chatSessions('dsh-pick-mode-3')[0]?.modes?.currentModeId).toBe('strict')
    await gm.shutdownAll()

    // A conversation pointed at NO agent still fails honestly — that is a caller
    // bug, not a conversation being set up.
    const nowhere = new BridgeManager([def], pickHub, 500, `${tmpdir()}/acp-pick-mode-none-${Date.now()}.json`)
    await expect(nowhere.setChatSessionMode('never-bound', 'strict'))
      .rejects.toThrow(/no live ACP session is bound/)
    await nowhere.shutdownAll()
  }, 30_000)

  it('runs the first turn on the mode the composer showed without an explicit pick', async () => {
    // The mode select's value before the first message is the catalog's
    // last-known mode (whatever another conversation left there), while
    // `session/new` starts on the agent's own default. The composer's contract
    // is "whatever it shows is what runs" — so the displayed mode is one of the
    // pre-turn defaults the session must be seeded with, like model / effort.
    const events: AcpEvent[] = []
    const hub = new EventHub()
    hub.subscribe(event => { events.push(event) })
    const gm = new BridgeManager(
      [{ ...def, id: 'modepick', env: { MOCK_MODE_OPTION: '1', MOCK_FIRST_MODE: 'strict' } }],
      hub,
      500,
      `${tmpdir()}/acp-displayed-mode-${Date.now()}.json`,
    )
    try {
      // A probe is the gesture that fills the composer's mode select before a
      // session exists: the catalog says 'strict'. The chat session this test
      // opens afterwards is the SECOND one on that process and starts on the
      // agent's own 'default'.
      await gm.probeAgentModels('modepick')
      expect(gm.agentCatalog('modepick').mode?.currentValue).toBe('strict')

      gm.bindChatAgent('dsh-displayed-mode', 'modepick')
      expect(gm.chatChoice('dsh-displayed-mode')?.mode).toBeUndefined()
      const since = events.length
      for await (const _ of gm.streamPrompt({
        model: 'modepick',
        sessionId: 'dsh-displayed-mode',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      } as never)) { /* drain */ }

      // Proof the agent did NOT start on the displayed mode: `session/created`
      // carries the fresh session's own answer.
      const created = events.slice(since).find((event): event is Extract<AcpEvent, { type: 'session/created' }> => event.type === 'session/created')
      expect(created?.session.modes?.currentModeId).toBe('default')
      // ...yet the first turn ran on what the composer showed, and the pick is
      // the conversation's record from now on.
      expect(gm.chatSessions('dsh-displayed-mode')[0]?.modes?.currentModeId).toBe('strict')
      expect(gm.chatChoice('dsh-displayed-mode')).toMatchObject({ agentId: 'modepick', mode: 'strict' })
    } finally {
      await gm.shutdownAll()
    }
  }, 30_000)

  it('drops the previous agent\'s mode when the conversation switches agent', async () => {
    const gm = new BridgeManager(
      [{ ...def, id: 'alpha2' }, { ...def, id: 'beta2' }],
      pickHub,
      500,
      `${tmpdir()}/acp-pick-mode-switch-${Date.now()}.json`,
    )
    // Seed a mode directly through the receipt path used by the RPC layer.
    gm.bindChatAgent('dsh-pick-mode-2', 'alpha2')
    const internal = gm as unknown as {
      patchChatChoice(id: string, patch: Record<string, unknown>): void
    }
    internal.patchChatChoice('dsh-pick-mode-2', { agentId: 'alpha2', mode: 'plan' })
    expect(gm.chatChoice('dsh-pick-mode-2')).toMatchObject({ mode: 'plan' })
    // A mode id belongs to the agent that declared it; beta2 never offered it.
    gm.bindChatAgent('dsh-pick-mode-2', 'beta2')
    expect(gm.chatChoice('dsh-pick-mode-2')).toEqual({ agentId: 'beta2' })
    await gm.shutdownAll()
  })

  it('serves the pick over session/chat-list so the composer can show it before the first turn', async () => {
    const gm = new BridgeManager([{ ...def, id: 'picked' }], pickHub, 500, `${tmpdir()}/acp-pick-rpc-${Date.now()}.json`)
    await dispatchRpc(gm, 'session/chat-bind', { dshSessionId: 'dsh-pick-4', agentId: 'picked' })
    await dispatchRpc(gm, 'session/chat-model-set', { dshSessionId: 'dsh-pick-4', modelId: 'picked@opus' })
    await dispatchRpc(gm, 'session/chat-effort-set', { dshSessionId: 'dsh-pick-4', effort: 'high' })

    const listed = await dispatchRpc(gm, 'session/chat-list', { dshSessionId: 'dsh-pick-4' })
    expect(listed).toMatchObject({
      ok: true,
      value: {
        sessions: [],
        boundAgentId: 'picked',
        choice: { agentId: 'picked', modelId: 'picked@opus', effort: 'high' },
      },
    })
    // Clearing the effort reports the absence honestly instead of keeping a
    // stale value the agent is not running.
    await dispatchRpc(gm, 'session/chat-effort-set', { dshSessionId: 'dsh-pick-4' })
    expect(gm.chatChoice('dsh-pick-4')).toEqual({ agentId: 'picked', modelId: 'picked@opus' })
    await gm.shutdownAll()
  })

  it('carries the picked model onto the request path, not just the bare agent', async () => {
    const gm = new BridgeManager([{ ...def, id: 'picked' }], pickHub, 500, `${tmpdir()}/acp-pick-route-${Date.now()}.json`)
    gm.bindChatAgent('dsh-pick-5', 'picked')
    // The guard's `agent/request` rewrite reads this registry; a bare agent id
    // here would silently drop the variant the user chose up front.
    expect(routeBindingRegistry().conversations.get('dsh-pick-5')).toBe('picked')
    await gm.setChatSessionModel('dsh-pick-5', 'picked@opus')
    expect(routeBindingRegistry().conversations.get('dsh-pick-5')).toBe('picked@opus')
    await gm.shutdownAll()
  })

  /**
   * The pick must be REAL: a model chosen before the first message has to be on
   * the agent before that message runs, not applied afterwards.
   *
   * `session/new` answers with the agent's own defaults (`mock-model-a`, `high`),
   * so without `applyChatChoice` the first turn would run on them — the pick
   * would take effect only from the second message on, which is exactly the
   * "chose a model, got another one" bug this whole record exists to prevent.
   */
  it('applies a pick made before the first turn when the session is created', async () => {
    const applyHub = new EventHub()
    const meta: Array<{ configId: string; currentValue: string }[]> = []
    applyHub.subscribe(event => {
      if (event.type !== 'session/meta') return
      const options = (event.session as unknown as { configOptions?: Array<{ configId: string; currentValue: string }> }).configOptions
      if (options !== undefined) meta.push(options)
    })
    const gm = new BridgeManager([{ ...def, id: 'mock' }], applyHub, 500, `${tmpdir()}/acp-pick-apply-${Date.now()}.json`)
    // Choose `mock-model-b` / `off` with NO session in existence — the pre-chat
    // case, before a single message has been sent.
    gm.bindChatAgent('dsh-pick-6', 'mock')
    await gm.setChatSessionModel('dsh-pick-6', 'mock@mock-model-b')
    await gm.setChatSessionEffort('dsh-pick-6', 'off')
    expect(gm.chatSessions('dsh-pick-6')).toEqual([])

    const chunks: StreamChunk[] = []
    for await (const chunk of gm.streamPrompt({
      model: 'mock',
      sessionId: 'dsh-pick-6',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
    } as never)) chunks.push(chunk)
    expect(chunks.at(-1)).toMatchObject({ type: 'finish' })

    // The AGENT is now on the picked values, not its defaults: `session/meta`
    // carries the option set `session/set_config_option` answered with.
    const last = meta.at(-1) ?? []
    expect(last.find(option => option.configId === 'model')?.currentValue).toBe('mock-model-b')
    expect(last.find(option => option.configId === 'thought')?.currentValue).toBe('off')
    // ...and the conversation reports what is actually in force.
    const [session] = gm.chatSessions('dsh-pick-6')
    expect(session?.modelId).toBe('mock@mock-model-b')
    expect(session?.reasoningEffort).toBe('off')
    await gm.shutdownAll()
  })

  it('drops a thought level the newly picked model does not publish, and says so once', async () => {
    const switchHub = new EventHub()
    const notices: string[] = []
    switchHub.subscribe(event => {
      if (event.type === 'agent/notice') notices.push(event.text)
    })
    // The knob makes `mock-model-plain` (no thought_level) selectable, so the
    // switch below is a model the agent really offers.
    const gm = new BridgeManager([{ ...def, env: { ...def.env, MOCK_PLAIN_MODEL_CHOICE: '1' } }], switchHub, 500, `${tmpdir()}/acp-model-effort-${Date.now()}.json`)
    gm.bindChatAgent('dsh-model-effort', 'mock')
    // Materialize a LIVE session on the variant-bearing model (thought off/high).
    for await (const _chunk of gm.streamPrompt({
      model: 'mock',
      sessionId: 'dsh-model-effort',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
    } as never)) { /* drain */ }
    await gm.setChatSessionEffort('dsh-model-effort', 'high')
    expect(gm.chatSessions('dsh-model-effort')[0]?.reasoningEffort).toBe('high')

    // `mock-model-plain` publishes no thought_level at all. The set's answer is
    // the new model's authoritative option set, so the level is stale: it must
    // leave the pick and the row the chip reads, with exactly one notice.
    await gm.setChatSessionModel('dsh-model-effort', 'mock@mock-model-plain')
    expect(gm.chatChoice('dsh-model-effort')).toMatchObject({ agentId: 'mock', modelId: 'mock@mock-model-plain' })
    expect(gm.chatChoice('dsh-model-effort')?.effort).toBeUndefined()
    expect(gm.chatSessions('dsh-model-effort')[0]?.reasoningEffort).toBeUndefined()
    expect(notices.filter(text => text.includes('no longer offers thought level "high"'))).toHaveLength(1)
    await gm.shutdownAll()
  })

  it('keeps a thought level a live model switch still offers', async () => {
    const keepHub = new EventHub()
    const dropped: string[] = []
    keepHub.subscribe(event => {
      if (event.type === 'agent/notice' && event.text.includes('no longer offers thought level')) dropped.push(event.text)
    })
    const gm = new BridgeManager([{ ...def, id: 'mock' }], keepHub, 500, `${tmpdir()}/acp-model-keep-${Date.now()}.json`)
    gm.bindChatAgent('dsh-model-keep', 'mock')
    for await (const _chunk of gm.streamPrompt({
      model: 'mock',
      sessionId: 'dsh-model-keep',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
    } as never)) { /* drain */ }
    await gm.setChatSessionEffort('dsh-model-keep', 'high')
    expect(gm.chatSessions('dsh-model-keep')[0]?.reasoningEffort).toBe('high')

    // `mock-model-b` still publishes off/high: the level survives the switch,
    // on both the pick and the row the chip reads — and nothing is reported.
    await gm.setChatSessionModel('dsh-model-keep', 'mock@mock-model-b')
    expect(gm.chatChoice('dsh-model-keep')).toMatchObject({ modelId: 'mock@mock-model-b', effort: 'high' })
    expect(gm.chatSessions('dsh-model-keep')[0]?.reasoningEffort).toBe('high')
    expect(dropped).toEqual([])
    await gm.shutdownAll()
  })

  it('records a thought/config pick when the conversation is served by the plugin default', async () => {
    const gm = new BridgeManager([{ ...def, id: 'mock' }], pickHub, 500, `${tmpdir()}/acp-default-pick-${Date.now()}.json`)
    try {
      // The advanced options are validated against the agent's catalog, so the
      // host needs to know it; the agent id in the RPC is what names the agent
      // before any session exists (`chatAgentFor` cannot answer yet).
      await gm.probeAgentModels('mock')
      await gm.setDefaultAgent('mock')
      await gm.setChatSessionEffort('dsh-default-pick', 'off', 'mock')
      await gm.setChatSessionConfig('dsh-default-pick', 'temp', 'high', 'mock')
      expect(gm.chatChoice('dsh-default-pick')).toMatchObject({
        agentId: 'mock',
        effort: 'off',
        extraConfigs: { temp: 'high' },
      })
      // The route for the next turn carries the agent the pick belongs to.
      expect(routeBindingRegistry().conversations.get('dsh-default-pick')).toBe('mock')
      // An agent id that is not configured is refused, not recorded.
      await expect(gm.setChatSessionEffort('dsh-default-pick', 'high', 'ghost'))
        .rejects.toMatchObject({ code: 'unknown_agent' })
    } finally {
      await gm.setDefaultAgent(undefined)
      await gm.shutdownAll()
    }
  }, 30_000)

  /**
   * A conversation with no explicit pick shows the agent catalog's current
   * model / thought level / extras in the composer. The first `session/new`
   * comes back with the agent's OWN defaults, so without pinning the displayed
   * values the first message runs a different model than the one on screen —
   * the reported "displayed model was not used" defect (user report, 2026-10-24).
   */
  it('runs the values the composer showed when the first turn starts with no pick', async () => {
    const hub = new EventHub()
    const gm = new BridgeManager([{ ...def, id: 'mock' }], hub, 500, `${tmpdir()}/acp-displayed-defaults-${Date.now()}.json`)
    try {
      // The catalog the composer reads before this conversation has a session:
      // model B / thought off / temperature high. `session/new` will answer A /
      // high / mid, so a seed that does not happen is visible in the result.
      const internal = gm as unknown as { catalog: { catalogs: Map<string, { catalog: AcpAgentCatalog; updatedAt: number }> } }
      internal.catalog.catalogs.set('mock', {
        catalog: {
          model: {
            configId: 'model',
            name: 'Model',
            currentValue: 'mock-model-b',
            choices: [{ value: 'mock-model-a', name: 'Mock Model A' }, { value: 'mock-model-b', name: 'Mock Model B' }],
          },
          thought: {
            configId: 'thought',
            name: 'Thought Level',
            currentValue: 'off',
            choices: [{ value: 'off', name: 'Off' }, { value: 'high', name: 'High' }],
          },
          extras: [{
            configId: 'temp',
            name: 'Temperature',
            currentValue: 'high',
            choices: [{ value: 'low', name: 'low' }, { value: 'mid', name: 'mid' }, { value: 'high', name: 'high' }],
          }],
        },
        updatedAt: 1,
      })
      // No manual bind: the plugin default is what the guard's route rewrite
      // answers a never-bound conversation with.
      await gm.setDefaultAgent('mock')

      for await (const _ of gm.streamPrompt({
        model: 'mock',
        sessionId: 'dsh-displayed-defaults',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      } as never)) { /* drain */ }

      // The displayed values became the conversation's pick...
      expect(gm.chatChoice('dsh-displayed-defaults')).toMatchObject({
        agentId: 'mock',
        modelId: 'mock@mock-model-b',
        effort: 'off',
        extraConfigs: { temp: 'high' },
      })
      // ...the session reports what is actually in force...
      const [session] = gm.chatSessions('dsh-displayed-defaults')
      expect(session?.modelId).toBe('mock@mock-model-b')
      expect(session?.reasoningEffort).toBe('off')
      // ...and the agent really received them, not its own defaults.
      const live = (gm.sessions() as Array<{
        agentId: string
        configOptions?: Array<{ configId: string; currentValue: unknown }>
      }>).find(entry => entry.agentId === 'mock')
      expect(live?.configOptions?.find(option => option.configId === 'model')?.currentValue).toBe('mock-model-b')
      expect(live?.configOptions?.find(option => option.configId === 'thought')?.currentValue).toBe('off')
      expect(live?.configOptions?.find(option => option.configId === 'temp')?.currentValue).toBe('high')
      // The route for the NEXT turn carries the variant, not the bare agent.
      expect(routeBindingRegistry().conversations.get('dsh-displayed-defaults')).toBe('mock@mock-model-b')
    } finally {
      routeBindingRegistry().conversations.delete('dsh-displayed-defaults')
      await gm.setDefaultAgent(undefined)
      await gm.shutdownAll()
    }
  }, 30_000)

  it('does not pin a displayed model the fresh session no longer offers', async () => {
    const hub = new EventHub()
    const gm = new BridgeManager([{ ...def, id: 'mock' }], hub, 500, `${tmpdir()}/acp-displayed-stale-${Date.now()}.json`)
    try {
      const internal = gm as unknown as { catalog: { catalogs: Map<string, { catalog: AcpAgentCatalog; updatedAt: number }> } }
      internal.catalog.catalogs.set('mock', {
        catalog: {
          model: {
            configId: 'model',
            name: 'Model',
            currentValue: 'mock-model-gone',
            choices: [{ value: 'mock-model-gone', name: 'Gone' }],
          },
        },
        updatedAt: 1,
      })
      await gm.setDefaultAgent('mock')
      const chunks: StreamChunk[] = []
      for await (const chunk of gm.streamPrompt({
        model: 'mock',
        sessionId: 'dsh-displayed-stale',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      } as never)) chunks.push(chunk)

      // The stale catalog value is skipped rather than wedging the first turn.
      expect(chunks.at(-1)).toMatchObject({ type: 'finish' })
      expect(chunks.at(-1)).not.toMatchObject({ reason: { kind: 'error' } })
      expect(gm.chatChoice('dsh-displayed-stale')?.modelId).toBeUndefined()
      const [session] = gm.chatSessions('dsh-displayed-stale')
      expect(session?.modelId).toBe('mock@mock-model-a')
    } finally {
      routeBindingRegistry().conversations.delete('dsh-displayed-stale')
      await gm.setDefaultAgent(undefined)
      await gm.shutdownAll()
    }
  }, 30_000)

  /**
   * The other half of "picks are real": a model the agent has DROPPED must
   * never be silently replaced by another one. The turn is refused with
   * `model_unavailable` BEFORE anything reaches the agent, the pick is kept so
   * the user can see which selection must change, and a replacement model runs
   * normally. A stale thought level (which does not change WHICH model runs) is
   * still dropped with one notice.
   */
  it('refuses to run a dropped model, keeps the pick, warns once for stale effort, and runs the replacement', async () => {
    const staleHub = new EventHub()
    const notices: string[] = []
    staleHub.subscribe(event => {
      if (event.type === 'agent/notice' && event.text.includes('no longer offers')) notices.push(event.text)
    })
    const gm = new BridgeManager([{ ...def, id: 'mock' }], staleHub, 500, `${tmpdir()}/acp-pick-stale-${Date.now()}.json`)
    try {
      gm.bindChatAgent('dsh-stale-1', 'mock')
      // The mock offers mock-model-a / mock-model-b and off / high. These two
      // are what an agent that revised its catalog no longer provides.
      await gm.setChatSessionModel('dsh-stale-1', 'mock@dropped-model')
      await gm.setChatSessionEffort('dsh-stale-1', 'ultra')
      expect(routeBindingRegistry().conversations.get('dsh-stale-1')).toBe('mock@dropped-model')

      const blocked: StreamChunk[] = []
      for await (const chunk of gm.streamPrompt({
        model: 'mock',
        sessionId: 'dsh-stale-1',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
      } as never)) blocked.push(chunk)
      expect(blocked.at(-1)).toMatchObject({
        type: 'finish',
        reason: { kind: 'error', failure: { code: 'model_unavailable' } },
      })
      // The failure names the selection that must be replaced.
      expect(JSON.stringify(blocked.at(-1))).toContain('dropped-model')

      // The MODEL pick survives — it is what the chip and the picker point at —
      // and the request route still carries it. The stale EFFORT is gone (it
      // does not change which model runs) with exactly one notice.
      expect(gm.chatChoice('dsh-stale-1')).toEqual({ agentId: 'mock', modelId: 'mock@dropped-model' })
      expect(routeBindingRegistry().conversations.get('dsh-stale-1')).toBe('mock@dropped-model')
      expect(notices.filter(text => text.includes('thought'))).toHaveLength(1)
      expect(notices.filter(text => text.includes('model'))).toHaveLength(0)
      // The first turn exchanged nothing: the provisional lock rolled back and
      // the failed session is gone.
      expect(gm.chatSessions('dsh-stale-1')).toEqual([])

      // Replacing the model is the way forward; the next turn runs normally.
      await gm.setChatSessionModel('dsh-stale-1', 'mock@mock-model-b')
      const ok: StreamChunk[] = []
      for await (const chunk of gm.streamPrompt({
        model: 'mock',
        sessionId: 'dsh-stale-1',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
      } as never)) ok.push(chunk)
      expect(ok.at(-1)).toMatchObject({ type: 'finish' })
      expect(ok.at(-1)).not.toMatchObject({ reason: { kind: 'error' } })
      const [session] = gm.chatSessions('dsh-stale-1')
      expect(session?.modelId).toBe('mock@mock-model-b')
      const live = (gm.sessions() as Array<{
        agentId: string
        configOptions?: Array<{ configId: string; currentValue: unknown }>
      }>).find(entry => entry.agentId === 'mock')
      expect(live?.configOptions?.find(option => option.configId === 'model')?.currentValue).toBe('mock-model-b')

      // A stale model requested through the setter on a LIVE session is refused
      // too, instead of being recorded and failing on the next send.
      await expect(gm.setChatSessionModel('dsh-stale-1', 'mock@dropped-model'))
        .rejects.toMatchObject({ code: 'model_unavailable' })
      expect(gm.chatChoice('dsh-stale-1')).toMatchObject({ modelId: 'mock@mock-model-b' })
      expect(gm.chatSessions('dsh-stale-1')[0]?.modelId).toBe('mock@mock-model-b')
    } finally {
      await gm.shutdownAll()
    }
  }, 30_000)

  it('runs the selected model when an agent mislabels an effort option as category:model', async () => {
    // Issue #8 end-to-end: the agent's answer carries `model` plus a
    // `reasoning_effort` also tagged category:'model'. The turn must reach the
    // agent with the chosen model instead of failing `model_unavailable`
    // before sending anything.
    const qoderHub = new EventHub()
    const qoderDef: AcpAgentDef = {
      ...def,
      env: { ...def.env, MOCK_QODER_MODEL_CATEGORY: '1' },
    }
    const gm = new BridgeManager([{ ...qoderDef, id: 'mock' }], qoderHub, 500, `${tmpdir()}/acp-qoder-category-${Date.now()}.json`)
    try {
      gm.bindChatAgent('dsh-qoder-category', 'mock')
      await gm.setChatSessionModel('dsh-qoder-category', 'mock@mock-model-b')
      const chunks: StreamChunk[] = []
      for await (const chunk of gm.streamPrompt({
        model: 'mock',
        sessionId: 'dsh-qoder-category',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
      } as never)) chunks.push(chunk)
      expect(chunks.at(-1)).toMatchObject({ type: 'finish' })
      expect(chunks.at(-1)).not.toMatchObject({ reason: { kind: 'error' } })
      expect(gm.chatSessions('dsh-qoder-category')[0]?.modelId).toBe('mock@mock-model-b')
      // The model slot is the selector; the mislabelled effort is the thought
      // control (this fixture publishes no real thought_level).
      expect(gm.catalogFor('mock')?.model?.configId).toBe('model')
      expect(gm.catalogFor('mock')?.model?.choices.map(choice => choice.value))
        .toEqual(['mock-model-a', 'mock-model-b'])
      expect(gm.catalogFor('mock')?.thought?.configId).toBe('reasoning_effort')
    } finally {
      await gm.shutdownAll()
    }
  }, 30_000)
  it('drops an effort the target model was observed without, before any session exists, with one notice', async () => {
    const hub = new EventHub()
    const notices: string[] = []
    hub.subscribe(event => { if (event.type === 'agent/notice') notices.push(event.text) })
    const gm = new BridgeManager([{ ...def, env: { ...def.env, MOCK_PLAIN_MODEL_CHOICE: '1' } }], hub, 500, `${tmpdir()}/acp-model-plain-${Date.now()}.json`)
    gm.bindChatAgent('learn-plain', 'mock')
    // A live session observes the variant-less model: its answer is the only
    // place that model's option set exists, and it records "no thought axis".
    for await (const _chunk of gm.streamPrompt({
      model: 'mock',
      sessionId: 'learn-plain',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
    } as never)) { /* drain */ }
    await gm.setChatSessionModel('learn-plain', 'mock@mock-model-plain')
    expect(gm.agentCatalog('mock').reasoningByModel?.['mock-model-plain']).toEqual({ efforts: [] })

    // A DIFFERENT conversation with no ACP session at all — the pre-first-turn
    // window this record exists for.
    gm.bindChatAgent('fresh-plain', 'mock')
    await gm.setChatSessionEffort('fresh-plain', 'high', 'mock')
    const before = notices.length
    await gm.setChatSessionModel('fresh-plain', 'mock@mock-model-plain')
    expect(gm.chatChoice('fresh-plain')).toEqual({ agentId: 'mock', modelId: 'mock@mock-model-plain' })
    // Exactly one notice: the cleared level is news, and it is said once.
    expect(notices.length - before).toBe(1)
    expect(notices.at(-1)).toContain('no longer offers thought level "high"')
    await gm.shutdownAll()
  }, 30_000)

  it('keeps a level the target model declares, and the first turn runs it after the switch', async () => {
    const hub = new EventHub()
    const notices: string[] = []
    const meta: Array<Array<{ configId: string; currentValue: string }>> = []
    hub.subscribe(event => {
      if (event.type === 'agent/notice') notices.push(event.text)
      if (event.type !== 'session/meta') return
      const options = (event.session as unknown as { configOptions?: Array<{ configId: string; currentValue: string }> }).configOptions
      if (options !== undefined) meta.push(options)
    })
    const gm = new BridgeManager([{ ...def, id: 'mock' }], hub, 500, `${tmpdir()}/acp-model-keep-pre-${Date.now()}.json`)
    // Learn `mock-model-b`'s own levels by switching a live session to it.
    gm.bindChatAgent('learn-b', 'mock')
    for await (const _chunk of gm.streamPrompt({
      model: 'mock',
      sessionId: 'learn-b',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
    } as never)) { /* drain */ }
    await gm.setChatSessionModel('learn-b', 'mock@mock-model-b')
    expect(gm.agentCatalog('mock').reasoningByModel?.['mock-model-b']?.efforts.map(level => level.id))
      .toEqual(['off', 'high'])

    gm.bindChatAgent('fresh-b', 'mock')
    await gm.setChatSessionModel('fresh-b', 'mock@mock-model-a')
    await gm.setChatSessionEffort('fresh-b', 'high', 'mock')
    const before = notices.length
    await gm.setChatSessionModel('fresh-b', 'mock@mock-model-b')
    // The level is part of B's vocabulary, so the pick survives — silently.
    expect(gm.chatChoice('fresh-b')).toEqual({ agentId: 'mock', modelId: 'mock@mock-model-b', effort: 'high' })
    expect(notices.length).toBe(before)

    // The first message materializes the session; `applyChatChoice` applies the
    // record, so the turn runs on the model AND the level the composer showed.
    for await (const _chunk of gm.streamPrompt({
      model: 'mock',
      sessionId: 'fresh-b',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
    } as never)) { /* drain */ }
    const [session] = gm.chatSessions('fresh-b')
    expect(session?.modelId).toBe('mock@mock-model-b')
    expect(session?.reasoningEffort).toBe('high')
    const last = meta.at(-1) ?? []
    expect(last.find(option => option.configId === 'model')?.currentValue).toBe('mock-model-b')
    expect(last.find(option => option.configId === 'thought')?.currentValue).toBe('high')
    await gm.shutdownAll()
  }, 30_000)

})
