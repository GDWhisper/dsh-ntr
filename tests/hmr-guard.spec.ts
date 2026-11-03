import { describe, expect, it, vi } from 'vitest'
import {
  HMR_RECONCILE_GUARD_MARKER,
  installHmrReconcileGuard,
  type HmrReconcileGate,
} from '../src/hmr-guard.ts'

function fakeGate(initial = true) {
  const state = { active: initial }
  let listener: (() => void) | undefined
  const gate: HmrReconcileGate = {
    canSaveNow: () => !state.active,
    onIdle: (next) => {
      listener = next
      if (!state.active) queueMicrotask(() => { if (listener === next) next() })
      return () => { if (listener === next) listener = undefined }
    },
  }
  return {
    state,
    gate,
    fireIdle: () => { listener?.() },
    hasListener: () => listener !== undefined,
  }
}

function fakeHost() {
  const calls: unknown[][] = []
  const original = vi.fn(async (...args: unknown[]) => {
    calls.push(args)
    return { warnings: [], pending: [] }
  })
  const runExclusive = vi.fn(async (operation: () => Promise<unknown>) => operation())
  return {
    host: { reconcileProfile: original, runExclusive },
    original,
    runExclusive,
    calls,
  }
}

const tick = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 10))

describe('installHmrReconcileGuard', () => {
  it('delegates immediately when no turn is active', async () => {
    const { host, original } = fakeHost()
    const { gate } = fakeGate(false)
    installHmrReconcileGuard(host, gate)
    await expect(host.reconcileProfile('required')).resolves.toEqual({ warnings: [], pending: [] })
    expect(original).toHaveBeenCalledWith('required')
  })

  it('returns an empty reconciliation while a turn is active and retries after idle', async () => {
    const { host, original, runExclusive, calls } = fakeHost()
    const { gate, state, fireIdle } = fakeGate(true)
    installHmrReconcileGuard(host, gate, { retryDelayMs: 0 })

    await expect(host.reconcileProfile('required', 'extra')).resolves.toEqual({ warnings: [], pending: [] })
    expect(original).not.toHaveBeenCalled()

    state.active = false
    fireIdle()
    await tick()

    expect(runExclusive).toHaveBeenCalledTimes(1)
    expect(original).toHaveBeenCalledTimes(1)
    expect(calls).toEqual([['required', 'extra']])
  })

  it('keeps one idle listener across repeated active creates and retries the latest args', async () => {
    const { host, original, calls } = fakeHost()
    const { gate, state, fireIdle, hasListener } = fakeGate(true)
    installHmrReconcileGuard(host, gate, { retryDelayMs: 0 })

    await host.reconcileProfile('first')
    await host.reconcileProfile('second')
    expect(hasListener()).toBe(true)

    state.active = false
    fireIdle()
    await tick()
    expect(original).toHaveBeenCalledTimes(1)
    expect(calls).toEqual([['second']])
  })

  it('restores the original method only while its own wrapper is installed', async () => {
    const { host, original } = fakeHost()
    const { gate } = fakeGate(true)
    const restore = installHmrReconcileGuard(host, gate)
    const wrapped = host.reconcileProfile
    expect(wrapped).not.toBe(original)
    restore()
    expect(host.reconcileProfile).toBe(original)
    expect(host[HMR_RECONCILE_GUARD_MARKER]).toBeUndefined()
  })

  it('does not overwrite another wrapper during restore', async () => {
    const { host, original } = fakeHost()
    const { gate } = fakeGate(true)
    const restore = installHmrReconcileGuard(host, gate)
    const replacement = vi.fn(async () => ({ warnings: [], pending: [] }))
    host.reconcileProfile = replacement
    restore()
    expect(host.reconcileProfile).toBe(replacement)
    expect(host.reconcileProfile).not.toBe(original)
  })

  it('is idempotent: a second install cannot stack a second gate', async () => {
    const { host, original } = fakeHost()
    const { gate, state, fireIdle } = fakeGate(true)
    const first = installHmrReconcileGuard(host, gate)
    const second = installHmrReconcileGuard(host, gate)
    expect(second).not.toBe(first)

    await host.reconcileProfile('x')
    state.active = false
    fireIdle()
    await tick()
    expect(original).toHaveBeenCalledTimes(1)
  })

  it('degrades safely when the method is missing or the service is frozen', () => {
    const warnings: string[] = []
    const logger = { warn: (message: string) => { warnings.push(message) } }
    const missing = { runExclusive: async <T>(operation: () => Promise<T>) => operation() }
    expect(installHmrReconcileGuard(missing, fakeGate().gate, { logger })).toBeTypeOf('function')
    expect(warnings.some(w => w.includes('reconcileProfile is not a function'))).toBe(true)

    const { host, original } = fakeHost()
    Object.freeze(host)
    const restore = installHmrReconcileGuard(host, fakeGate().gate, { logger })
    expect(restore).toBeTypeOf('function')
    expect(host.reconcileProfile).toBe(original)
    expect(warnings.some(w => w.includes('not extensible'))).toBe(true)
  })

  it('degrades when runExclusive is missing', () => {
    const warnings: string[] = []
    const host = { reconcileProfile: vi.fn(async () => ({ warnings: [], pending: [] })) }
    installHmrReconcileGuard(host, fakeGate().gate, { logger: { warn: m => warnings.push(m) } })
    expect(warnings.some(w => w.includes('runExclusive'))).toBe(true)
  })

  it('stops a scheduled retry when the plugin is restored', async () => {
    const { host, original } = fakeHost()
    const { gate, state, fireIdle } = fakeGate(true)
    const restore = installHmrReconcileGuard(host, gate, { retryDelayMs: 20 })
    await host.reconcileProfile('late')
    state.active = false
    fireIdle()
    restore()
    await new Promise(resolve => setTimeout(resolve, 40))
    expect(original).not.toHaveBeenCalled()
  })

  it('reports whether the guard actually installed', () => {
    const { host } = fakeHost()
    expect(installHmrReconcileGuard(host, fakeGate(false).gate).installed).toBe(true)

    const missing = { runExclusive: async <T>(operation: () => Promise<T>) => operation() }
    expect(installHmrReconcileGuard(missing, fakeGate(false).gate).installed).toBe(false)
  })

  it('works while a turn never ends: reports once after the deadline, then reconciles at idle', async () => {
    const { host, original, calls } = fakeHost()
    const { gate, state, fireIdle } = fakeGate(true)
    const notices: string[] = []
    installHmrReconcileGuard(host, gate, {
      giveUpMs: 20,
      notify: message => { notices.push(message) },
    })

    await expect(host.reconcileProfile('blocked')).resolves.toEqual({ warnings: [], pending: [] })
    expect(original).not.toHaveBeenCalled()

    await new Promise(resolve => setTimeout(resolve, 40))
    expect(notices).toHaveLength(1)
    expect(notices[0]).toContain('has not ended')
    // The deadline speaks once; waiting longer must not repeat the notice.
    await new Promise(resolve => setTimeout(resolve, 40))
    expect(notices).toHaveLength(1)

    // The turn finally ends: the deferred reload still runs with the latest args.
    state.active = false
    fireIdle()
    await tick()
    expect(original).toHaveBeenCalledTimes(1)
    expect(calls).toEqual([['blocked']])
  })

  it('retries a failed reload with backoff up to the bound and reports once', async () => {
    const { host, original, runExclusive } = fakeHost()
    original.mockRejectedValue(new Error('reconcile failed'))
    const { gate, state, fireIdle, hasListener } = fakeGate(true)
    const notices: string[] = []
    installHmrReconcileGuard(host, gate, {
      retryDelayMs: 0,
      maxRetries: 2,
      notify: message => { notices.push(message) },
    })

    await host.reconcileProfile('retry-me')
    state.active = false
    fireIdle()

    // No second idle was fired: the guard itself scheduled the second attempt.
    await vi.waitFor(() => {
      expect(runExclusive).toHaveBeenCalledTimes(2)
      expect(notices).toHaveLength(1)
    })
    expect(original).toHaveBeenCalledTimes(2)
    expect(notices[0]).toContain('retry failed')
    expect(hasListener()).toBe(true)

    // A later turn boundary starts a fresh bounded cycle.
    fireIdle()
    await vi.waitFor(() => {
      expect(runExclusive).toHaveBeenCalledTimes(4)
      expect(notices).toHaveLength(2)
    })
  })

  it('clears its own marker after a foreign wrapper took over, so the next install proceeds', () => {
    const { host, original } = fakeHost()
    const first = installHmrReconcileGuard(host, fakeGate(true).gate)
    expect(first.installed).toBe(true)
    expect(host[HMR_RECONCILE_GUARD_MARKER]).toBeTypeOf('symbol')

    const replacement = vi.fn(async () => ({ warnings: [], pending: [] }))
    host.reconcileProfile = replacement
    expect(host[HMR_RECONCILE_GUARD_MARKER]).toBeTypeOf('symbol')

    first()
    // The foreign wrapper stays; OUR ownership mark is what gets cleaned.
    expect(host.reconcileProfile).toBe(replacement)
    expect(host.reconcileProfile).not.toBe(original)
    expect(host[HMR_RECONCILE_GUARD_MARKER]).toBeUndefined()

    const second = installHmrReconcileGuard(host, fakeGate(true).gate)
    expect(second.installed).toBe(true)
    expect(host.reconcileProfile).not.toBe(replacement)
  })

  it('keeps a marker owned by another guard', () => {
    const { host } = fakeHost()
    const restore = installHmrReconcileGuard(host, fakeGate(true).gate)
    const foreign = Symbol('foreign-guard')
    Object.defineProperty(host, HMR_RECONCILE_GUARD_MARKER, { value: foreign, configurable: true })
    restore()
    expect(host[HMR_RECONCILE_GUARD_MARKER]).toBe(foreign)
  })

  it('deletes the own property it added when the host method lives on the prototype', async () => {
    const proto = {
      reconcileProfile: async (_args: unknown) => ({ warnings: [] as never[], pending: [] as never[] }),
      runExclusive: async <T>(operation: () => Promise<T>) => operation(),
    }
    const host = Object.create(proto) as { reconcileProfile: typeof proto.reconcileProfile; runExclusive: typeof proto.runExclusive }
    expect(Object.hasOwn(host, 'reconcileProfile')).toBe(false)

    const restore = installHmrReconcileGuard(host, fakeGate(false).gate)
    expect(Object.hasOwn(host, 'reconcileProfile')).toBe(true)

    restore()
    expect(Object.hasOwn(host, 'reconcileProfile')).toBe(false)
    expect(host.reconcileProfile).toBe(proto.reconcileProfile)
  })

  it('restores the original own-property descriptor exactly', () => {
    const original = async () => ({ warnings: [], pending: [] })
    const host: Record<string, unknown> = {
      runExclusive: async <T>(operation: () => Promise<T>) => operation(),
    }
    Object.defineProperty(host, 'reconcileProfile', {
      value: original,
      writable: true,
      enumerable: false,
      configurable: true,
    })
    const before = Object.getOwnPropertyDescriptor(host, 'reconcileProfile')

    const restore = installHmrReconcileGuard(host, fakeGate(false).gate)
    restore()

    expect(Object.getOwnPropertyDescriptor(host, 'reconcileProfile')).toEqual(before)
  })
})
