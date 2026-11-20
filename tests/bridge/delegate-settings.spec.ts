import { describe, expect, it } from 'vitest'
import { SettingsService, type SettingsHost } from '../../src/bridge/settings-service.ts'
import { DEFAULT_TUNING } from '../../src/bridge/tuning.ts'
import type { BridgeTuning } from '../../src/bridge/types.ts'
import {
  DEFAULT_DELEGATE_GUIDANCE,
  DEFAULT_DELEGATE_PERMISSION_MODE,
  DEFAULT_DELEGATE_TIMEOUT_MS,
} from '../../src/protocol.ts'

/**
 * The settings layer in isolation: a fake host records the two side effects a
 * delegate write owns (the state-file write and the registration reconcile),
 * so no manager, bridge or child process is needed. Same two-layer contract
 * the idle-release card follows (see `idle-release.spec.ts`).
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
  return { host, calls }
}

describe('delegate settings (settings layer)', () => {
  it('reports the override in force while configured keeps the deployment baseline', async () => {
    const { host, calls } = fakeHost()
    const settings = new SettingsService(host)
    // The deployment names an off-ladder window: it runs as-is (the wider
    // deployment range is an explicit design, same as the idle baseline).
    settings.setConfiguredDelegate({ guidance: 'on', timeoutMs: 120_000 })
    expect(settings.delegateSettings()).toEqual({
      guidance: 'on',
      permissionMode: DEFAULT_DELEGATE_PERMISSION_MODE,
      timeoutMs: 120_000,
      configured: { guidance: 'on', timeoutMs: 120_000 },
    })
    await settings.setDelegateSettings({ guidance: 'force', timeoutMs: 900_000 })
    expect(settings.delegateSettings()).toEqual({
      guidance: 'force',
      permissionMode: DEFAULT_DELEGATE_PERMISSION_MODE,
      timeoutMs: 900_000,
      configured: { guidance: 'on', timeoutMs: 120_000 },
    })
    // Omitted keys keep their value; the service never fills the manager's probes.
    await settings.setDelegateSettings({ permissionMode: 'ask' })
    expect(settings.delegateSettings()).toMatchObject({ guidance: 'force', permissionMode: 'ask', timeoutMs: 900_000 })
    expect(settings.delegateSettings()).not.toHaveProperty('toolAvailable')
    expect(settings.delegateSettings()).not.toHaveProperty('restrictAvailable')
    expect(calls.persist).toBe(2)
  })

  it('resets a key to the deployment baseline, or to the built-in default when the file names nothing', async () => {
    const { host } = fakeHost()
    const settings = new SettingsService(host)
    settings.setConfiguredDelegate({ guidance: 'enhanced', permissionMode: 'abort' })
    await settings.setDelegateSettings({ guidance: 'force', timeoutMs: 60_000 })
    await settings.setDelegateSettings({ reset: ['guidance'] })
    expect(settings.delegateSettings()).toMatchObject({ guidance: 'enhanced', timeoutMs: 60_000 })
    // The deployment never named the numeric keys: reset returns to the defaults.
    await settings.setDelegateSettings({ reset: ['timeoutMs', 'permissionMode'] })
    expect(settings.delegateSettings()).toMatchObject({
      guidance: 'enhanced',
      permissionMode: 'abort',
      timeoutMs: DEFAULT_DELEGATE_TIMEOUT_MS,
    })
    // No baseline at all: every reset lands on the built-in default.
    const bare = new SettingsService(fakeHost().host)
    await bare.setDelegateSettings({ guidance: 'on' })
    await bare.setDelegateSettings({ reset: ['guidance'] })
    expect(bare.delegateSettings().guidance).toBe(DEFAULT_DELEGATE_GUIDANCE)
    expect(bare.delegateSettings().configured).toBeUndefined()
  })

  it('survives a restart: the persisted snapshot restores the override on a fresh instance', async () => {
    const { host } = fakeHost()
    const settings = new SettingsService(host)
    settings.setConfiguredDelegate({ guidance: 'on' })
    await settings.setDelegateSettings({ guidance: 'enhanced', permissionMode: 'ask', timeoutMs: 1_800_000 })
    const snapshot = settings.persistedSettings()
    expect(snapshot.delegate).toEqual({ guidance: 'enhanced', permissionMode: 'ask', timeoutMs: 1_800_000 })

    // A fresh service over the serialized snapshot is a DSH restart: the pick
    // is still in force because it was persisted with the agent registry.
    const second = new SettingsService(fakeHost().host)
    second.setConfiguredDelegate({ guidance: 'on' })
    second.loadPersistedSettings(JSON.parse(JSON.stringify(snapshot)))
    expect(second.delegateSettings()).toEqual(settings.delegateSettings())
  })

  it('drops off-ladder and hand-edited values on the restart read, falling back to the baseline', () => {
    const { host } = fakeHost()
    const settings = new SettingsService(host)
    settings.setConfiguredDelegate({ guidance: 'on', timeoutMs: 120_000 })
    settings.loadPersistedSettings({ delegate: { guidance: 'bogus', permissionMode: 'wait', timeoutMs: 12_345 } })
    expect(settings.delegateSettings()).toMatchObject({
      guidance: 'on',
      permissionMode: DEFAULT_DELEGATE_PERMISSION_MODE,
      timeoutMs: 120_000,
    })
    // One legal key survives beside illegal siblings; the rest fall back.
    settings.loadPersistedSettings({ delegate: { guidance: 'force', timeoutMs: 600_000, permissionMode: 'nope' } })
    expect(settings.delegateSettings()).toMatchObject({
      guidance: 'force',
      timeoutMs: 600_000,
      permissionMode: DEFAULT_DELEGATE_PERMISSION_MODE,
    })
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
      permissionMode: DEFAULT_DELEGATE_PERMISSION_MODE,
      timeoutMs: DEFAULT_DELEGATE_TIMEOUT_MS,
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