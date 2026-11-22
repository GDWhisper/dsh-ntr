import { describe, expect, it } from 'vitest'
import { SettingsService, type SettingsHost } from '../../src/bridge/settings-service.ts'
import { DEFAULT_TUNING } from '../../src/bridge/tuning.ts'
import type { BridgeTuning } from '../../src/bridge/types.ts'
import { DEFAULT_DELEGATE_GUIDANCE } from '../../src/protocol.ts'

/**
 * The settings layer in isolation: a fake host records the two side effects a
 * delegate write owns (the state-file write and the registration reconcile),
 * so no manager, bridge or child process is needed. Same two-layer contract
 * the idle-release card follows (see `idle-release.spec.ts`). The timeout's
 * built-in default follows the global background-task long window, so the fake
 * host exposes a tuning setter to exercise that derivation.
 */
function fakeHost() {
  const calls = { persist: 0, sync: 0 }
  let tuning: Required<BridgeTuning> = { ...DEFAULT_TUNING }
  let knownAgents: Set<string> | undefined // undefined = every id is configured
  const host: SettingsHost = {
    hasAgent: agentId => knownAgents === undefined || knownAgents.has(agentId),
    bridges: () => [],
    currentTuning: () => tuning,
    replaceTuning: next => { tuning = next },
    persistAgents: () => { calls.persist += 1 },
    persistAgentsStrict: () => { calls.persist += 1 },
    syncDelegateRegistration: () => { calls.sync += 1 },
  }
  return {
    host, calls,
    setTuning: (patch: Partial<BridgeTuning>) => { tuning = { ...tuning, ...patch } },
    setKnownAgents: (ids: string[] | undefined) => { knownAgents = ids === undefined ? undefined : new Set(ids) },
  }
}

describe('delegate settings (settings layer)', () => {
  it('reports the override in force while configured keeps the deployment baseline', async () => {
    const { host, calls } = fakeHost()
    const settings = new SettingsService(host)
    // The deployment names an off-grid window: it runs as-is (the wide
    // deployment range is an explicit design, same as the idle baseline).
    settings.setConfiguredDelegate({ guidance: 'on', timeoutMs: 120_000 })
    expect(settings.delegateSettings()).toEqual({
      guidance: 'on',
      timeoutMs: 120_000,
      defaultTimeoutMs: 120_000,
      configured: { guidance: 'on', timeoutMs: 120_000 },
    })
    await settings.setDelegateSettings({ guidance: 'force', timeoutMs: 900_000 })
    expect(settings.delegateSettings()).toEqual({
      guidance: 'force',
      timeoutMs: 900_000,
      defaultTimeoutMs: 120_000,
      configured: { guidance: 'on', timeoutMs: 120_000 },
    })
    // Omitted keys keep their value; the service never fills the manager's probes.
    await settings.setDelegateSettings({ guidance: 'on' })
    expect(settings.delegateSettings()).toMatchObject({ guidance: 'on', timeoutMs: 900_000 })
    expect(settings.delegateSettings()).not.toHaveProperty('toolAvailable')
    expect(settings.delegateSettings()).not.toHaveProperty('restrictAvailable')
    expect(calls.persist).toBe(2)
  })

  it('defaults the timeout to the global background-task long window (0 falls back to the short one)', () => {
    const { host, setTuning } = fakeHost()
    const settings = new SettingsService(host)
    // Out of the box: DEFAULT_TUNING.backgroundTaskToolMs = 2400000 (40 minutes).
    expect(settings.delegateSettings().timeoutMs).toBe(2_400_000)
    expect(settings.delegateSettings().defaultTimeoutMs).toBe(2_400_000)
    // A customized long window is followed.
    setTuning({ backgroundTaskToolMs: 3_600_000 })
    expect(settings.delegateSettings().timeoutMs).toBe(3_600_000)
    expect(settings.delegateSettings().defaultTimeoutMs).toBe(3_600_000)
    // 0 falls back to the short window — the TurnWatchdogService.backgroundTuning rule.
    setTuning({ backgroundTaskToolMs: 0 })
    expect(settings.delegateSettings().timeoutMs).toBe(DEFAULT_TUNING.backgroundTaskMaxMs)
    expect(settings.delegateSettings().defaultTimeoutMs).toBe(DEFAULT_TUNING.backgroundTaskMaxMs)
  })

  it('a configured timeoutMs outranks the global window; a hand-filled override persists and resets to baseline', async () => {
    const { host, setTuning } = fakeHost()
    const settings = new SettingsService(host)
    setTuning({ backgroundTaskToolMs: 3_600_000 })
    settings.setConfiguredDelegate({ timeoutMs: 120_000 })
    // configured beats the global window for both the running value and the reset target.
    expect(settings.delegateSettings().timeoutMs).toBe(120_000)
    expect(settings.delegateSettings().defaultTimeoutMs).toBe(120_000)
    // A hand-filled override (90 minutes) outranks the configured baseline and persists.
    await settings.setDelegateSettings({ timeoutMs: 5_400_000 })
    expect(settings.delegateSettings().timeoutMs).toBe(5_400_000)
    expect(settings.persistedSettings().delegate).toEqual({ timeoutMs: 5_400_000 })
    // Reset returns to the configured baseline, not the global window.
    await settings.setDelegateSettings({ reset: ['timeoutMs'] })
    expect(settings.delegateSettings().timeoutMs).toBe(120_000)
    expect(settings.persistedSettings().delegate).toBeUndefined()
  })

  it('resets a key to the deployment baseline, or to the built-in default when the file names nothing', async () => {
    const { host } = fakeHost()
    const settings = new SettingsService(host)
    settings.setConfiguredDelegate({ guidance: 'enhanced', timeoutMs: 300_000 })
    await settings.setDelegateSettings({ guidance: 'force', timeoutMs: 60_000 })
    await settings.setDelegateSettings({ reset: ['guidance'] })
    expect(settings.delegateSettings()).toMatchObject({ guidance: 'enhanced', timeoutMs: 60_000 })
    // Reset the window: it returns to the configured baseline.
    await settings.setDelegateSettings({ reset: ['timeoutMs'] })
    expect(settings.delegateSettings()).toMatchObject({ guidance: 'enhanced', timeoutMs: 300_000, defaultTimeoutMs: 300_000 })
    // No baseline at all: every reset lands on the built-in default (the global window).
    const bare = new SettingsService(fakeHost().host)
    await bare.setDelegateSettings({ guidance: 'on', timeoutMs: 60_000 })
    await bare.setDelegateSettings({ reset: ['guidance', 'timeoutMs'] })
    expect(bare.delegateSettings().guidance).toBe(DEFAULT_DELEGATE_GUIDANCE)
    expect(bare.delegateSettings().timeoutMs).toBe(2_400_000)
    expect(bare.delegateSettings().configured).toBeUndefined()
  })

  it('survives a restart: the persisted snapshot restores the override on a fresh instance', async () => {
    const { host } = fakeHost()
    const settings = new SettingsService(host)
    settings.setConfiguredDelegate({ guidance: 'on' })
    await settings.setDelegateSettings({ guidance: 'enhanced', timeoutMs: 1_800_000 })
    const snapshot = settings.persistedSettings()
    expect(snapshot.delegate).toEqual({ guidance: 'enhanced', timeoutMs: 1_800_000 })

    // A fresh service over the serialized snapshot is a DSH restart: the pick
    // is still in force because it was persisted with the agent registry.
    const second = new SettingsService(fakeHost().host)
    second.setConfiguredDelegate({ guidance: 'on' })
    second.loadPersistedSettings(JSON.parse(JSON.stringify(snapshot)))
    expect(second.delegateSettings()).toEqual(settings.delegateSettings())
  })

  it('drops out-of-range and hand-edited values on the restart read, falling back to the baseline', () => {
    const { host } = fakeHost()
    const settings = new SettingsService(host)
    settings.setConfiguredDelegate({ guidance: 'on', timeoutMs: 120_000 })
    // The retired delegation permission key, spelled dynamically so the ghost
    // symbol does not reappear literally in source (see AGENTS/retired.md).
    const retired = ['permission', 'Mode'].join('')
    // guidance bogus + an out-of-range window + the retired key: all dropped.
    settings.loadPersistedSettings({ delegate: { guidance: 'bogus', [retired]: 'wait', timeoutMs: 999 } })
    expect(settings.delegateSettings()).toMatchObject({ guidance: 'on', timeoutMs: 120_000 })
    expect(settings.delegateSettings()).not.toHaveProperty(retired)
    // One legal key survives beside illegal siblings; the rest fall back.
    settings.loadPersistedSettings({ delegate: { guidance: 'force', timeoutMs: 600_000, [retired]: 'nope' } })
    expect(settings.delegateSettings()).toMatchObject({ guidance: 'force', timeoutMs: 600_000 })
    expect(settings.delegateSettings()).not.toHaveProperty(retired)
    // An in-range off-grid window survives the restart read (there is no ladder anymore).
    settings.loadPersistedSettings({ delegate: { timeoutMs: 123_456 } })
    expect(settings.delegateSettings().timeoutMs).toBe(123_456)
    // A hand-edited non-object is dropped without throwing; an absent key clears the override.
    settings.loadPersistedSettings({ delegate: 'force' })
    expect(settings.delegateSettings().guidance).toBe('on')
    settings.loadPersistedSettings({})
    expect(settings.persistedSettings().delegate).toBeUndefined()
  })

  it('reconciles the registration once per write and on the boot replay', async () => {
    const { host, calls } = fakeHost()
    const settings = new SettingsService(host)
    expect(calls.sync).toBe(0)
    await settings.setDelegateSettings({ guidance: 'on' })
    expect(calls.sync).toBe(1)
    expect(calls.persist).toBe(1)
    settings.applyDelegateTuning()
    expect(calls.sync).toBe(2)
    // A reset is a write too: the registration must reconcile back to the baseline.
    await settings.setDelegateSettings({ reset: ['guidance'] })
    expect(calls.sync).toBe(3)
  })

  it('keeps only the keys the deployment named in the configured facts', () => {
    const { host } = fakeHost()
    const settings = new SettingsService(host)
    settings.setConfiguredDelegate({ guidance: 'on' })
    expect(settings.delegateSettings().configured).toEqual({ guidance: 'on' })
    settings.setConfiguredDelegate({})
    expect(settings.delegateSettings().configured).toBeUndefined()
    settings.setConfiguredDelegate(undefined)
    expect(settings.delegateSettings()).toEqual({
      guidance: DEFAULT_DELEGATE_GUIDANCE,
      timeoutMs: 2_400_000,
      defaultTimeoutMs: 2_400_000,
    })
  })

  it('keeps delegate out of the persisted snapshot while no override exists', async () => {
    const { host } = fakeHost()
    const settings = new SettingsService(host)
    expect(settings.persistedSettings()).not.toHaveProperty('delegate')
    await settings.setDelegateSettings({ guidance: 'on' })
    expect(settings.persistedSettings().delegate).toEqual({ guidance: 'on' })
    await settings.setDelegateSettings({ reset: ['guidance'] })
    expect(settings.persistedSettings()).not.toHaveProperty('delegate')
  })
})

// ---- four-axis customization: the new delegate keys (T2) ----

describe('delegate choice settings (settings layer)', () => {
  it('defaultAgent override wins over the baseline; the view reports the three facts', async () => {
    const { host } = fakeHost()
    const settings = new SettingsService(host)
    settings.setConfiguredDelegate({ defaultAgent: 'base-agent' })
    settings.loadPersistedSettings({ defaultAgentId: 'global-agent' })
    expect(settings.delegateSettings()).toMatchObject({
      defaultAgent: 'base-agent',
      globalDefaultAgent: 'global-agent',
      resolvedDefaultAgent: 'base-agent',
      configured: { defaultAgent: 'base-agent' },
    })
    await settings.setDelegateSettings({ defaultAgent: 'pick-agent' })
    expect(settings.delegateSettings()).toMatchObject({
      defaultAgent: 'pick-agent',
      globalDefaultAgent: 'global-agent',
      resolvedDefaultAgent: 'pick-agent',
      configured: { defaultAgent: 'base-agent' },
    })
    expect(settings.persistedSettings().delegate).toEqual({ defaultAgent: 'pick-agent' })
    // Reset returns to the configured baseline; the global default is untouched.
    await settings.setDelegateSettings({ reset: ['defaultAgent'] })
    expect(settings.delegateSettings().defaultAgent).toBe('base-agent')
    expect(settings.delegateSettings().resolvedDefaultAgent).toBe('base-agent')
    expect(settings.persistedSettings().delegate).toBeUndefined()
  })

  it('no override: resolvedDefaultAgent follows the global default; a deleted global reads as none', () => {
    const { host, setKnownAgents } = fakeHost()
    const settings = new SettingsService(host)
    settings.loadPersistedSettings({ defaultAgentId: 'global-agent' })
    expect(settings.delegateSettings()).toMatchObject({ globalDefaultAgent: 'global-agent', resolvedDefaultAgent: 'global-agent' })
    expect(settings.delegateSettings().defaultAgent).toBeUndefined()
    setKnownAgents(['other'])
    expect(settings.delegateSettings().globalDefaultAgent).toBeUndefined()
    expect(settings.delegateSettings().resolvedDefaultAgent).toBeUndefined()
  })

  it('agentDefaults entries replace wholesale; {} shadows the baseline and null deletes', async () => {
    const { host } = fakeHost()
    const settings = new SettingsService(host)
    settings.setConfiguredDelegate({ agentDefaults: { alpha: { model: 'base-m', effort: 'base-e' }, beta: { mode: 'base-o' } } })
    expect(settings.delegateSettings().agentDefaults).toEqual({ alpha: { model: 'base-m', effort: 'base-e' }, beta: { mode: 'base-o' } })
    // WHOLE-ENTRY replacement: the new entry does not merge keys with the baseline.
    await settings.setDelegateSettings({ agentDefaults: { alpha: { mode: 'strict' } } })
    expect(settings.delegateSettings().agentDefaults).toEqual({ alpha: { mode: 'strict' }, beta: { mode: 'base-o' } })
    expect(settings.persistedSettings().delegate).toEqual({ agentDefaults: { alpha: { mode: 'strict' } } })
    // {} is a valid all-default override that SHADOWS the baseline for that agent.
    await settings.setDelegateSettings({ agentDefaults: { beta: {} } })
    expect(settings.delegateSettings().agentDefaults).toEqual({ alpha: { mode: 'strict' }, beta: {} })
    // null deletes the override entry: the baseline decides again.
    await settings.setDelegateSettings({ agentDefaults: { alpha: null } })
    expect(settings.delegateSettings().agentDefaults).toEqual({ alpha: { model: 'base-m', effort: 'base-e' }, beta: {} })
    // reset drops the whole override map.
    await settings.setDelegateSettings({ reset: ['agentDefaults'] })
    expect(settings.delegateSettings().agentDefaults).toEqual({ alpha: { model: 'base-m', effort: 'base-e' }, beta: { mode: 'base-o' } })
    expect(settings.persistedSettings().delegate).toBeUndefined()
  })

  it('deleting the LAST agentDefaults entry leaves no empty-map residue in the snapshot', async () => {
    const { host } = fakeHost()
    const settings = new SettingsService(host)
    await settings.setDelegateSettings({ agentDefaults: { alpha: { model: 'm' } } })
    expect(settings.persistedSettings().delegate).toEqual({ agentDefaults: { alpha: { model: 'm' } } })
    // Delete the last entry: the key disappears entirely, never `agentDefaults: {}`.
    await settings.setDelegateSettings({ agentDefaults: { alpha: null } })
    expect(settings.persistedSettings()).not.toHaveProperty('delegate')
    expect(settings.delegateSettings().agentDefaults).toBeUndefined()
    // A sibling override keeps the delegate key, but the emptied map still goes.
    await settings.setDelegateSettings({ guidance: 'on', agentDefaults: { beta: {} } })
    await settings.setDelegateSettings({ agentDefaults: { beta: null } })
    expect(settings.persistedSettings().delegate).toEqual({ guidance: 'on' })
    // A {} ENTRY is a valid all-default override — it survives its own write.
    await settings.setDelegateSettings({ agentDefaults: { beta: {} } })
    expect(settings.persistedSettings().delegate).toEqual({ guidance: 'on', agentDefaults: { beta: {} } })
    // Deleting one of TWO entries keeps the map (it still has an entry).
    await settings.setDelegateSettings({ agentDefaults: { alpha: { mode: 'strict' } } })
    await settings.setDelegateSettings({ agentDefaults: { alpha: null } })
    expect(settings.persistedSettings().delegate).toEqual({ guidance: 'on', agentDefaults: { beta: {} } })
    // reset behavior is unchanged: the whole map drops.
    await settings.setDelegateSettings({ reset: ['agentDefaults'] })
    expect(settings.persistedSettings().delegate).toEqual({ guidance: 'on' })
  })

  it('an empty payload map creates no override key, and never wipes an existing map', async () => {
    const { host } = fakeHost()
    const settings = new SettingsService(host)
    await settings.setDelegateSettings({ agentDefaults: {} })
    expect(settings.persistedSettings()).not.toHaveProperty('delegate')
    // Over an existing map an empty payload is a no-op, not a wipe.
    await settings.setDelegateSettings({ agentDefaults: { alpha: { model: 'm' } } })
    await settings.setDelegateSettings({ agentDefaults: {} })
    expect(settings.persistedSettings().delegate).toEqual({ agentDefaults: { alpha: { model: 'm' } } })
  })

  it('configured facts name only the keys the file named, including the new ones', () => {
    const { host } = fakeHost()
    const settings = new SettingsService(host)
    settings.setConfiguredDelegate({ defaultAgent: 'base-agent', agentDefaults: { alpha: { model: 'm' } } })
    expect(settings.delegateSettings().configured).toEqual({ defaultAgent: 'base-agent', agentDefaults: { alpha: { model: 'm' } } })
    // An empty baseline still reports no configured facts at all.
    settings.setConfiguredDelegate({})
    expect(settings.delegateSettings().configured).toBeUndefined()
    expect(settings.delegateSettings().agentDefaults).toBeUndefined()
  })

  it('survives a restart: the new keys round-trip through the persisted snapshot', async () => {
    const { host } = fakeHost()
    const settings = new SettingsService(host)
    await settings.setDelegateSettings({ defaultAgent: 'pick-agent', agentDefaults: { alpha: { model: 'm2', effort: 'high' }, beta: {} } })
    const snapshot = JSON.parse(JSON.stringify(settings.persistedSettings())) as Record<string, unknown>
    const second = new SettingsService(fakeHost().host)
    second.loadPersistedSettings(snapshot)
    expect(second.delegateSettings().defaultAgent).toBe('pick-agent')
    expect(second.delegateSettings().agentDefaults).toEqual({ alpha: { model: 'm2', effort: 'high' }, beta: {} })
    expect(second.persistedSettings().delegate).toEqual(snapshot.delegate)
  })

  it('drops hand-edited shapes on the restart read, key by key; stale-but-legal values survive', () => {
    const { host } = fakeHost()
    const settings = new SettingsService(host)
    settings.setConfiguredDelegate({ defaultAgent: 'base-agent', agentDefaults: { alpha: { model: 'base-m' } } })
    // An illegal pointer shape is dropped; the legal map beside it survives.
    settings.loadPersistedSettings({ delegate: { defaultAgent: 42, agentDefaults: { alpha: { mode: 'strict' } } } })
    expect(settings.delegateSettings().defaultAgent).toBe('base-agent')
    expect(settings.delegateSettings().agentDefaults).toEqual({ alpha: { mode: 'strict' } })
    // An illegal entry drops the whole map (the baseline decides again)…
    settings.loadPersistedSettings({ delegate: { defaultAgent: 'pick-agent', agentDefaults: { alpha: { model: '' } } } })
    expect(settings.delegateSettings().defaultAgent).toBe('pick-agent')
    expect(settings.delegateSettings().agentDefaults).toEqual({ alpha: { model: 'base-m' } })
    // …and an illegal agent-id key is refused too.
    settings.loadPersistedSettings({ delegate: { agentDefaults: { 'not an id': { model: 'm' } } } })
    expect(settings.delegateSettings().agentDefaults).toEqual({ alpha: { model: 'base-m' } })
    // Keep+mark: a value the agent may no longer offer is SHAPE-legal, so it
    // stays persisted — the runtime degrades it with a note, never the boot.
    // The view still merges the baseline entry beside the override map.
    settings.loadPersistedSettings({ delegate: { agentDefaults: { ghost: { model: 'no-longer-offered' } } } })
    expect(settings.delegateSettings().agentDefaults).toEqual({ alpha: { model: 'base-m' }, ghost: { model: 'no-longer-offered' } })
  })

  it('forgetAgent drops the deleted agent\'s override entry but KEEPS the defaultAgent pointer', async () => {
    const { host } = fakeHost()
    const settings = new SettingsService(host)
    settings.loadPersistedSettings({ defaultAgentId: 'alpha' })
    await settings.setDelegateSettings({ defaultAgent: 'alpha', agentDefaults: { alpha: { model: 'm' }, beta: { mode: 'strict' } } })
    settings.forgetAgent('alpha')
    // The GLOBAL default pointer follows the delete (existing semantics)…
    expect(settings.defaultAgent()).toBeUndefined()
    // …but the delegate pointer is kept for the browser to mark stale, and
    // only the deleted agent's override entry dies.
    expect(settings.delegateSettings().defaultAgent).toBe('alpha')
    expect(settings.delegateSettings().agentDefaults).toEqual({ beta: { mode: 'strict' } })
    expect(settings.persistedSettings().delegate).toEqual({ defaultAgent: 'alpha', agentDefaults: { beta: { mode: 'strict' } } })
    // Forgetting an agent with no entry changes nothing.
    settings.forgetAgent('gamma')
    expect(settings.persistedSettings().delegate).toEqual({ defaultAgent: 'alpha', agentDefaults: { beta: { mode: 'strict' } } })
  })

  it('forgetAgent deleting the LAST entry leaves no empty-map residue; the pointer survives', async () => {
    const { host } = fakeHost()
    const settings = new SettingsService(host)
    settings.loadPersistedSettings({ defaultAgentId: 'alpha' })
    await settings.setDelegateSettings({ defaultAgent: 'alpha', agentDefaults: { alpha: { model: 'm' } } })
    settings.forgetAgent('alpha')
    // Existing duties unchanged: the global pointer follows the delete, the
    // delegate pointer is kept for the browser to mark stale…
    expect(settings.defaultAgent()).toBeUndefined()
    expect(settings.delegateSettings().defaultAgent).toBe('alpha')
    // …and the emptied map drops the key entirely, never `agentDefaults: {}`.
    expect(settings.persistedSettings().delegate).toEqual({ defaultAgent: 'alpha' })
    expect(settings.delegateSettings().agentDefaults).toBeUndefined()
  })

  it('forgetAgent deleting one of TWO entries keeps the map, including a surviving {} entry', async () => {
    const { host } = fakeHost()
    const settings = new SettingsService(host)
    await settings.setDelegateSettings({ agentDefaults: { alpha: { model: 'm' }, beta: {} } })
    settings.forgetAgent('alpha')
    expect(settings.delegateSettings().agentDefaults).toEqual({ beta: {} })
    expect(settings.persistedSettings().delegate).toEqual({ agentDefaults: { beta: {} } })
  })

  it('the new keys ride the same persist + reconcile side effects as the old ones', async () => {
    const { host, calls } = fakeHost()
    const settings = new SettingsService(host)
    await settings.setDelegateSettings({ defaultAgent: 'alpha', agentDefaults: { alpha: { model: 'm' } } })
    expect(calls.persist).toBe(1)
    expect(calls.sync).toBe(1)
    await settings.setDelegateSettings({ reset: ['defaultAgent', 'agentDefaults'] })
    expect(calls.persist).toBe(2)
    expect(calls.sync).toBe(2)
    expect(settings.persistedSettings().delegate).toBeUndefined()
  })
})