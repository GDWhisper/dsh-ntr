/**
 * Runtime guard around the host's profile HMR reconciliation.
 *
 * WHY: `dsh-hmr` compares EVERY loaded module under the profile roots on a
 * configuration refresh. A settings save therefore stops and replaces
 * `dsh-ntr` whenever its `lib/` on disk is newer than the boot snapshot,
 * aborting an in-flight ACP turn. This wrapper runs no host file change: it
 * replaces the public `hmr.reconcileProfile` method, which `refresh` calls on
 * the instance. While an ACP turn is active it returns a valid empty
 * reconciliation immediately (ending the HMR transaction), then retries the
 * original method once the turn ends.
 *
 * A retry is bounded on purpose: the original method can fail, and idling is
 * not an event that repeats. Failed retries are rescheduled with backoff up to
 * `maxRetries`; a turn that never ends is reported after `giveUpMs`. Either
 * way the failure reaches `notify`, so the deferred reload is never lost in
 * silence waiting for an idle that may never come.
 *
 * The wrapper is deliberately defensive: a missing service, a missing method,
 * a read-only property or a changed method shape leaves HMR exactly as it was.
 * A host upgrade can only disable the guard; it cannot break HMR.
 */

/** Marker on the HMR instance; records which guard currently owns the wrapper. */
export const HMR_RECONCILE_GUARD_MARKER = Symbol.for('dsh-ntr.hmr-reconcile-guard')

/** The only gate surface the HMR guard needs. */
export interface HmrReconcileGate {
  canSaveNow(): boolean
  onIdle(listener: () => void): () => void
}

/** The host methods we wrap. Structural so a host upgrade cannot fail a type check. */
export interface HmrReconcileHost {
  reconcileProfile(...args: unknown[]): Promise<unknown>
  runExclusive<T>(operation: () => Promise<T>): Promise<T>
}

export interface HmrGuardLogger {
  warn(message: string): void
}

export interface HmrGuardOptions {
  logger?: HmrGuardLogger
  /** Base delay before retrying after idle; doubles per failed attempt. */
  retryDelayMs?: number
  /** Consecutive retries allowed for one deferred reload before the bound is reached. */
  maxRetries?: number
  /** Upper bound for a single backoff delay. */
  maxRetryDelayMs?: number
  /**
   * How long one deferred reload may wait for a turn that never ends before the
   * guard reports it. `0` disables that deadline report.
   */
  giveUpMs?: number
  /** User-visible notification; the host entry forwards it to the runtime log. */
  notify?: (message: string) => void
}

/** The empty reconciliation `refresh` accepts while the turn is running. */
export interface EmptyReconciliation {
  warnings: never[]
  pending: never[]
}

/** Disposer plus the fact every caller needs: was the wrapper really installed? */
export interface HmrGuardHandle {
  (): void
  /** False when the guard degraded and left the HMR service untouched. */
  readonly installed: boolean
}

export const EMPTY_RECONCILIATION: EmptyReconciliation = { warnings: [], pending: [] }

/** Retries after one idle transition before the guard reports the failure. */
const DEFAULT_MAX_RETRIES = 3
/** Never wait longer than this between two retries of the same deferred reload. */
const DEFAULT_MAX_RETRY_DELAY_MS = 60_000
/** A turn that has not ended after this long gets one explicit report. */
const DEFAULT_GIVE_UP_MS = 600_000

type AnyRecord = Record<PropertyKey, unknown>

/** A handle for every degraded path; the caller must not record it as installed. */
function disabledHandle(): HmrGuardHandle {
  return Object.assign((): void => { /* nothing was installed */ }, { installed: false })
}

/**
 * Install the guard on one HMR service instance.
 *
 * @returns A callable disposer plus `installed`. The disposer restores the
 *   original method ONLY when our wrapper is still the installed one; a foreign
 *   wrapper stays untouched. Marker cleanup still removes OUR ownership mark, so
 *   a later install can proceed.
 */
export function installHmrReconcileGuard(
  target: unknown,
  gate: HmrReconcileGate,
  options: HmrGuardOptions = {},
): HmrGuardHandle {
  const logger = options.logger
  const notify = options.notify
  const warn = (message: string): void => {
    try { logger?.warn(`dsh-ntr: ${message}`) } catch { /* logging must never break install */ }
  }
  const report = (message: string): void => {
    warn(message)
    try { notify?.(message) } catch { /* a notification must never break the guard */ }
  }
  const refuse = (message: string): HmrGuardHandle => {
    warn(message)
    return disabledHandle()
  }
  if (target === null || typeof target !== 'object') {
    return refuse('hmr service is not an object; hot-reload guard disabled')
  }
  const host = target as Partial<HmrReconcileHost> & AnyRecord
  if (typeof host.reconcileProfile !== 'function') {
    return refuse('hmr.reconcileProfile is not a function; hot-reload guard disabled')
  }
  if (typeof host.runExclusive !== 'function') {
    return refuse('hmr.runExclusive is not a function; hot-reload guard disabled')
  }
  if (host[HMR_RECONCILE_GUARD_MARKER] !== undefined) {
    // Another instance (or a foreign wrapper) already owns the method. A
    // second install must not stack gates or duplicate retries.
    return disabledHandle()
  }
  if (Object.isExtensible(host) !== true) {
    return refuse('hmr service is not extensible; hot-reload guard disabled')
  }
  const own = Object.getOwnPropertyDescriptor(host, 'reconcileProfile')
  if (own !== undefined && own.writable === false && own.set === undefined) {
    return refuse('hmr.reconcileProfile is read-only; hot-reload guard disabled')
  }

  const original = host.reconcileProfile
  const owner = Symbol('dsh-ntr.hmr-reconcile-guard-owner')
  const retryDelayMs = Math.max(0, options.retryDelayMs ?? 0)
  const maxRetries = Math.max(1, Math.floor(options.maxRetries ?? DEFAULT_MAX_RETRIES))
  const maxRetryDelayMs = Math.max(retryDelayMs, options.maxRetryDelayMs ?? DEFAULT_MAX_RETRY_DELAY_MS)
  const giveUpMs = Math.max(0, options.giveUpMs ?? DEFAULT_GIVE_UP_MS)
  let offline: (() => void) | undefined
  let retryTimer: ReturnType<typeof setTimeout> | undefined
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined
  let lastArgs: unknown[] = []
  let attempts = 0
  let pending = false
  let notified = false
  let closed = false

  /** Schedule a timer that may wait minutes without keeping the host process alive. */
  const arm = (callback: () => void, delayMs: number): ReturnType<typeof setTimeout> => {
    const timer = setTimeout(callback, delayMs)
    timer.unref?.()
    return timer
  }
  const clearRetryTimer = (): void => {
    if (retryTimer === undefined) return
    clearTimeout(retryTimer)
    retryTimer = undefined
  }
  const clearDeadlineTimer = (): void => {
    if (deadlineTimer === undefined) return
    clearTimeout(deadlineTimer)
    deadlineTimer = undefined
  }
  const clearIdleListener = (): void => {
    if (offline === undefined) return
    try { offline() } catch { /* an unsubscribe must not break teardown */ }
    offline = undefined
  }

  /** The deferred reload ran: forget the wait, its timers and the idle listener. */
  const settle = (): void => {
    if (closed) return
    pending = false
    attempts = 0
    notified = false
    clearRetryTimer()
    clearDeadlineTimer()
    clearIdleListener()
  }

  /** One explicit report per wait; a later turn boundary starts a fresh cycle. */
  const giveUp = (message: string): void => {
    clearRetryTimer()
    clearDeadlineTimer()
    if (notified) return
    notified = true
    report(message)
  }

  /** The gate fires this on every transition to idle; a turn boundary resets the bound. */
  function ensureIdleListener(): void {
    if (closed || offline !== undefined) return
    try {
      offline = gate.onIdle(() => {
        attempts = 0
        notified = false
        scheduleRetry()
      })
    } catch (error) {
      warn(`could not register idle retry: ${error instanceof Error ? error.message : String(error)}`)
      offline = undefined
    }
  }

  /**
   * Aim one retry. Idle is only a trigger, not the retry itself: a failed retry
   * schedules the next one with backoff instead of waiting for another idle
   * that may never arrive.
   */
  function scheduleRetry(): void {
    if (closed || !pending) return
    if (!gate.canSaveNow()) {
      ensureIdleListener()
      return
    }
    if (attempts >= maxRetries) {
      giveUp(`hmr reconcile retry failed ${String(maxRetries)} time(s): the deferred profile reload is still pending and will run at the next turn boundary`)
      return
    }
    if (retryTimer !== undefined) return
    const delayMs = Math.min(maxRetryDelayMs, retryDelayMs * 2 ** attempts)
    attempts += 1
    retryTimer = arm(() => {
      retryTimer = undefined
      if (closed || !pending) return
      if (!gate.canSaveNow()) {
        ensureIdleListener()
        return
      }
      let running: Promise<unknown>
      try {
        running = host.runExclusive!(() => original.apply(host, lastArgs))
      } catch (error) {
        warn(`hmr retry did not start: ${error instanceof Error ? error.message : String(error)}`)
        scheduleRetry()
        return
      }
      void running.then(
        () => { settle() },
        error => {
          warn(`hmr retry failed: ${error instanceof Error ? error.message : String(error)}`)
          scheduleRetry()
        },
      )
    }, delayMs)
  }

  const wrapped = async (...args: unknown[]): Promise<unknown> => {
    if (gate.canSaveNow()) {
      // A new request while the plane is idle supersedes any deferred one: run
      // the original now instead of leaving a stale wait behind.
      if (pending) settle()
      return original.apply(host, args)
    }
    lastArgs = args
    if (!pending) {
      pending = true
      attempts = 0
      notified = false
      if (giveUpMs > 0) {
        const seconds = Math.max(1, Math.round(giveUpMs / 1000))
        deadlineTimer = arm(() => {
          deadlineTimer = undefined
          if (closed || !pending || gate.canSaveNow()) return
          giveUp(`hmr reconcile is still deferred after ${String(seconds)}s: the ACP turn has not ended. The deferred profile reload will run when the turn ends`)
        }, giveUpMs)
      }
    }
    ensureIdleListener()
    // A valid empty result lets `refresh` update `lastInputs` and close its
    // `runExclusive` transaction immediately; the turn keeps its plugin.
    return EMPTY_RECONCILIATION
  }

  /**
   * Put the method back exactly as it was found: an inherited prototype method
   * must lose the own property the wrapper added, and an existing own property
   * must keep its original descriptor (writable / enumerable / accessor shape).
   */
  const restoreMethod = (): void => {
    if (host.reconcileProfile !== wrapped) return
    try {
      if (own !== undefined) {
        Object.defineProperty(host, 'reconcileProfile', own)
      } else {
        delete (host as AnyRecord)['reconcileProfile']
      }
    } catch (error) {
      warn(`could not restore hmr.reconcileProfile: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  try {
    host.reconcileProfile = wrapped
    Object.defineProperty(host, HMR_RECONCILE_GUARD_MARKER, {
      value: owner,
      configurable: true,
    })
  } catch (error) {
    // Assignment can fail on a host that made the method non-writable or the
    // service non-extensible after our checks. Leave the original in place.
    if (host.reconcileProfile === wrapped) {
      try { restoreMethod() } catch { /* the caller keeps the original closure */ }
    }
    warn(`could not install hot-reload guard: ${error instanceof Error ? error.message : String(error)}`)
    return disabledHandle()
  }

  return Object.assign((): void => {
    if (closed) return
    closed = true
    clearRetryTimer()
    clearDeadlineTimer()
    clearIdleListener()
    restoreMethod()
    // A foreign wrapper may have replaced the method while our marker stayed
    // behind. Drop OUR mark even then, or the next install would be blocked.
    if (host[HMR_RECONCILE_GUARD_MARKER] === owner) {
      try {
        delete (host as AnyRecord)[HMR_RECONCILE_GUARD_MARKER]
      } catch (error) {
        warn(`could not clear the hot-reload guard marker: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }, { installed: true })
}

/** Structural sanity check used by the host entry before installing. */
export function isHmrReconcileHost(value: unknown): value is HmrReconcileHost {
  return value !== null && typeof value === 'object'
    && typeof (value as { reconcileProfile?: unknown }).reconcileProfile === 'function'
    && typeof (value as { runExclusive?: unknown }).runExclusive === 'function'
}
