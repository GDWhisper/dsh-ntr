/**
 * The built-in updater's browser half (split plan P3b): the throttled check,
 * the single-install guard, the generation guard that keeps a stale check from
 * overwriting an install's verdict, and the older-host degradation.
 *
 * Part of the `tests/store.spec.ts` mirror: this is the whole
 * `AcpStore plugin updates` describe, moved verbatim (same title, same case
 * count).
 */

import { describe, expect, it, vi } from 'vitest'
import { AcpStore } from '../../src/client/store.ts'

describe('AcpStore plugin updates', () => {
  it('reads the update state, throttles repeat checks, and honors force', async () => {
    let now = 1_000_000
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => now)
    try {
      const endpoints: string[] = []
      const store = new AcpStore(async (_channel, endpoint) => {
        endpoints.push(endpoint)
        if (endpoint === 'plugin/update-check') {
          return { ok: true, value: { status: 'available', current: '0.2.1', installed: '0.2.1', latest: '9.9.9' } }
        }
        return { ok: true, value: {} }
      }, (zh) => zh)

      expect(await store.checkPluginUpdate()).toMatchObject({ status: 'available', latest: '9.9.9' })
      expect(store.getSnapshot().pluginUpdate).toMatchObject({ status: 'available', latest: '9.9.9' })
      expect(endpoints.filter(endpoint => endpoint === 'plugin/update-check')).toHaveLength(1)

      // Every settings mount inside the window answers from the held state.
      await store.checkPluginUpdate()
      expect(endpoints.filter(endpoint => endpoint === 'plugin/update-check')).toHaveLength(1)

      now += 10 * 60 * 1000
      await store.checkPluginUpdate()
      expect(endpoints.filter(endpoint => endpoint === 'plugin/update-check')).toHaveLength(2)

      // The card's own button always goes out.
      await store.checkPluginUpdate(true)
      expect(endpoints.filter(endpoint => endpoint === 'plugin/update-check')).toHaveLength(3)
    } finally {
      nowSpy.mockRestore()
    }
  })

  it('coalesces concurrent checks into one RPC, force included', async () => {
    let release: (() => void) | undefined
    const gate = new Promise<void>(resolve => { release = resolve })
    let calls = 0
    const store = new AcpStore(async (_channel, endpoint) => {
      if (endpoint !== 'plugin/update-check') return { ok: true, value: {} }
      calls += 1
      await gate
      return { ok: true, value: { status: 'available', current: '0.2.1', installed: '0.2.1', latest: '9.9.9' } }
    }, (zh) => zh)

    const first = store.checkPluginUpdate()
    const second = store.checkPluginUpdate(true)
    expect(calls).toBe(1)
    release?.()
    expect(await first).toMatchObject({ status: 'available' })
    expect(await second).toEqual(await first)
    expect(calls).toBe(1)
  })

  it('applies the exact latest version and adopts the host answer', async () => {
    const calls: Array<{ endpoint: string; payload: unknown }> = []
    const applied = { status: 'restart-required', current: '0.2.1', installed: '9.9.9', latest: '9.9.9' }
    const store = new AcpStore(async (_channel, endpoint, payload) => {
      calls.push({ endpoint, payload })
      if (endpoint === 'plugin/update-check') {
        return { ok: true, value: { status: 'available', current: '0.2.1', installed: '0.2.1', latest: '9.9.9' } }
      }
      if (endpoint === 'plugin/update-apply') return { ok: true, value: applied }
      return { ok: true, value: {} }
    }, (zh) => zh)

    await store.checkPluginUpdate()
    expect(await store.applyPluginUpdate('9.9.9')).toEqual(applied)
    expect(store.getSnapshot().pluginUpdate).toEqual(applied)
    expect(calls.filter(call => call.endpoint === 'plugin/update-apply')).toEqual([{
      endpoint: 'plugin/update-apply', payload: { version: '9.9.9' },
    }])
    expect(store.getSnapshot().notice).toBeUndefined()
  })

  it('fires one install for a double apply', async () => {
    let release: (() => void) | undefined
    const gate = new Promise<void>(resolve => { release = resolve })
    const endpoints: string[] = []
    const applied = { status: 'restart-required', current: '0.2.1', installed: '9.9.9', latest: '9.9.9' }
    const store = new AcpStore(async (_channel, endpoint) => {
      endpoints.push(endpoint)
      if (endpoint === 'plugin/update-check') {
        return { ok: true, value: { status: 'available', current: '0.2.1', installed: '0.2.1', latest: '9.9.9' } }
      }
      if (endpoint === 'plugin/update-apply') {
        await gate
        return { ok: true, value: applied }
      }
      return { ok: true, value: {} }
    }, (zh) => zh)

    await store.checkPluginUpdate()
    const first = store.applyPluginUpdate('9.9.9')
    const second = store.applyPluginUpdate('9.9.9')
    expect(await second).toBeUndefined()
    expect(endpoints.filter(endpoint => endpoint === 'plugin/update-apply')).toHaveLength(1)
    release?.()
    expect(await first).toEqual(applied)
  })

  it('keeps the disk-may-have-changed fact when the install response is interrupted', async () => {
    const endpoints: string[] = []
    const store = new AcpStore(async (_channel, endpoint) => {
      endpoints.push(endpoint)
      if (endpoint === 'plugin/update-check') {
        return { ok: true, value: { status: 'available', current: '0.2.1', installed: '0.2.1', latest: '9.9.9' } }
      }
      if (endpoint === 'plugin/update-apply') throw new Error('socket hang up')
      return { ok: true, value: {} }
    }, (zh) => zh)

    await store.checkPluginUpdate()
    expect(await store.applyPluginUpdate('9.9.9')).toBeUndefined()
    // The update may have completed (HMR uninstall/reinstall); never claim
    // the disk did not change, and never claim the new version is installed.
    const state = store.getSnapshot().pluginUpdate
    expect(state).toMatchObject({
      status: 'restart-required', current: '0.2.1', latest: '9.9.9', message: 'socket hang up',
    })
    // The disk version is unknown, not a fact: no `installed` may survive.
    expect(state?.installed).toBeUndefined()
    expect(store.getSnapshot().notice).toBe('更新请求已中断；请刷新页面确认当前版本。')
    // The throttle was reset, so the next ordinary check really asks the host
    // instead of serving this unknown verdict for ten minutes.
    const checksBefore = endpoints.filter(endpoint => endpoint === 'plugin/update-check').length
    await store.checkPluginUpdate()
    expect(endpoints.filter(endpoint => endpoint === 'plugin/update-check').length).toBe(checksBefore + 1)
  })

  it('drops a check that lands after an apply started (generation guard)', async () => {
    let releaseCheck: (() => void) | undefined
    const gate = new Promise<void>(resolve => { releaseCheck = resolve })
    const applied = { status: 'applied', current: '0.2.1', installed: '9.9.9', latest: '9.9.9' }
    const store = new AcpStore(async (_channel, endpoint) => {
      if (endpoint === 'plugin/update-check') {
        await gate
        return { ok: true, value: { status: 'available', current: '0.2.1', installed: '0.2.1', latest: '9.9.9' } }
      }
      if (endpoint === 'plugin/update-apply') return { ok: true, value: applied }
      return { ok: true, value: {} }
    }, (zh) => zh)

    const check = store.checkPluginUpdate()
    expect(await store.applyPluginUpdate('9.9.9')).toEqual(applied)
    releaseCheck?.()
    // The pre-install read answers `available`; it must not overwrite the
    // install's verdict.
    expect(await check).toBeUndefined()
    expect(store.getSnapshot().pluginUpdate).toEqual(applied)
  })

  it('drops a check that started during an install and lands after it settles', async () => {
    let releaseApply: (() => void) | undefined
    const applyGate = new Promise<void>(resolve => { releaseApply = resolve })
    let releaseCheck: (() => void) | undefined
    const checkGate = new Promise<void>(resolve => { releaseCheck = resolve })
    const applied = { status: 'applied', current: '0.2.1', installed: '9.9.9', latest: '9.9.9' }
    const store = new AcpStore(async (_channel, endpoint) => {
      if (endpoint === 'plugin/update-check') {
        await checkGate
        // The host saw the install in progress; this answer is stale by the
        // time it lands.
        return { ok: true, value: { status: 'applying', current: '0.2.1' } }
      }
      if (endpoint === 'plugin/update-apply') {
        await applyGate
        return { ok: true, value: applied }
      }
      return { ok: true, value: {} }
    }, (zh) => zh)

    const apply = store.applyPluginUpdate('9.9.9')
    const check = store.checkPluginUpdate()
    releaseApply?.()
    expect(await apply).toEqual(applied)
    releaseCheck?.()
    expect(await check).toBeUndefined()
    expect(store.getSnapshot().pluginUpdate).toEqual(applied)
  })

  it('treats a host without the endpoint as a silent degradation', async () => {
    const store = new AcpStore(async () => ({
      ok: false, error: { code: 'unknown_endpoint', message: 'acp: unknown endpoint plugin/update-check' },
    }), (zh) => zh)

    expect(await store.checkPluginUpdate()).toBeUndefined()
    expect(store.getSnapshot().pluginUpdate).toBeUndefined()
    // An older host is a normal deployment, not an error to flash.
    expect(store.getSnapshot().notice).toBeUndefined()
  })
})
