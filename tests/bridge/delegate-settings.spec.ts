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
  const host: SettingsHost = {
    hasAgent: () => true,
    bridges: () => [],
    currentTuning: () => tuning,
    replaceTuning: next => { tuning = next },
    persistAgents: () => { calls.persist += 1 },
    persistAgentsStrict: () => { calls.persist += 1 },
    syncDelegateRegistration: () => { calls.sync += 1 },
  }
  return { host, calls, setTuning: (patch: Partial<BridgeTuning>) => { tuning = { ...tuning, ...patch } } }
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