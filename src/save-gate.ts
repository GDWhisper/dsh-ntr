/**
 * The ACP-turn save gate.
 *
 * WHY THIS EXISTS: a DSH profile write has two effects — it edits
 * `cordis.patch.yml` and it makes the profile loader recompose. The loader's
 * module comparison can stop and replace `dsh-ntr` itself; when that happens
 * while a turn is in flight (including a detached-worker hold), the plugin's
 * disposer calls `shutdownAll()` and the turn ends with `SESSION_CLOSED`.
 * The host owns the write (`dsh-settings` → `dsh-config-editor`); this gate is
 * the plugin's published seam so the host can ask "may I write now?" and hold
 * the write until every ACP turn has finished.
 *
 * The class is host-side only (no browser imports, no ACP SDK): the browser
 * reads its state through the `save/status` frame and the `save/*` RPCs.
 */

import { DEFAULT_SAVE_GATE_TIMEOUT_MS } from './protocol.ts'
import type {
  ActiveTurnView,
  SaveGateFlushResult,
  SaveGateOutcome,
  SaveGateOutcomeView,
  SaveGateStatus,
} from './protocol.ts'

/** The two facts the gate needs from the bridge manager. */
export interface SaveGateHost {
  hasActiveTurns(): boolean
  activeTurnViews(): ActiveTurnView[]
}

/** Tunables; tests inject the clock and timers. */
export interface SaveGateOptions {
  /**
   * How long ONE queued write waits for the agent before it expires. The
   * default is ten minutes; `0` waits forever. An expired write is NOT
   * executed behind the user's back: it settles `expired` and the toast asks
   * for a retry or the explicit force gesture.
   */
  timeoutMs?: number
  now?: () => number
  setTimer?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>
  clearTimer?: (handle: ReturnType<typeof setTimeout>) => void
}

/** One write waiting for the ACP turns to finish. */
interface QueuedSave {
  id: string
  label: string
  /**
   * Per-label generation captured at queue time. A newer save for the same
   * label — or an explicit cancel/delete — bumps the label's generation, which
   * makes this entry stale before it can run.
   */
  version: number
  queuedAt: number
  deadlineAt?: number
  timer?: ReturnType<typeof setTimeout>
  operation: () => Promise<unknown>
  settle: (outcome: SaveGateOutcome) => void
}

/** One `waitForIdle` caller. */
interface IdleWaiter {
  resolve: (idle: boolean) => void
  timer?: ReturnType<typeof setTimeout>
}

/**
 * An operation that stopped because its subject no longer exists — for example
 * the agent was deleted while its save was already executing. The gate settles
 * this `cancelled` and records NO outcome: the deletion was the user's own
 * gesture, so it must not turn into a failure banner or a retryable entry.
 *
 * The property marker is checked as well as `instanceof`, so two loaded copies
 * of this module (host HMR) still recognize the same abort.
 */
export class SaveGateAborted extends Error {
  readonly acpSaveAborted = true
  constructor(message = 'acp: save aborted before it could write') {
    super(message)
    this.name = 'SaveGateAborted'
  }
}

/** True for {@link SaveGateAborted}, including a copy loaded by another module instance. */
export function isSaveGateAborted(error: unknown): error is SaveGateAborted {
  if (error instanceof SaveGateAborted) return true
  return typeof error === 'object' && error !== null && (error as { acpSaveAborted?: unknown }).acpSaveAborted === true
}

/**
 * Serializes profile writes behind ACP turns.
 *
 * The gate NEVER writes anything itself. A host patch calls
 * `gate.defer(label, () => theRealWrite())`; if the ACP plane is idle the
 * operation runs immediately with the same rejection behavior as before, so
 * deployments without an active turn keep the original save semantics.
 */
export class AcpSaveGate {
  private readonly queue: QueuedSave[] = []
  private readonly idleWaiters = new Set<IdleWaiter>()
  private readonly idleListeners = new Set<() => void>()
  private readonly timeoutMs: number
  private readonly now: () => number
  private readonly setTimer: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>
  private readonly clearTimer: (handle: ReturnType<typeof setTimeout>) => void
  private seq = 0
  private flushing?: Promise<SaveGateFlushResult>
  /** A forced pass requested while another flush is still running. */
  private forceTail?: Promise<SaveGateFlushResult>
  private flushScheduled = false
  /** A post-turn-boundary re-check is already queued (see `sync`). */
  private resyncScheduled = false
  private disposed = false
  /** Current generation per label; a stale queued entry never runs. */
  private readonly labelVersions = new Map<string, number>()
  /** Most recent terminal result PER LABEL, so one agent's save cannot erase another's. */
  private readonly labelOutcomes = new Map<string, SaveGateOutcomeView>()
  /**
   * The last operation per label that did not succeed. Retained so the failure
   * banner's "retry" gesture can re-run it without the original caller.
   */
  private readonly retryables = new Map<string, { operation: () => Promise<unknown>; timeoutMs?: number }>()
  private lastOutcome?: SaveGateOutcomeView
  private lastSignature = ''

  constructor(
    private readonly host: SaveGateHost,
    private readonly onChange?: (status: SaveGateStatus) => void,
    options: SaveGateOptions = {},
  ) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_SAVE_GATE_TIMEOUT_MS
    this.now = options.now ?? (() => Date.now())
    this.setTimer = options.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs))
    this.clearTimer = options.clearTimer ?? (handle => { clearTimeout(handle) })
  }

  /** True exactly when no ACP turn is owed by any agent. */
  canSaveNow(): boolean {
    return !this.host.hasActiveTurns()
  }

  /** The full state the browser and a host caller render. */
  status(): SaveGateStatus {
    const active = this.host.hasActiveTurns()
    const activeSessions = this.host.activeTurnViews()
    return {
      // This snapshot comes from the real gate, not a host-half fallback.
      gateAvailable: true,
      canSave: !active,
      // A manager with a turn stream but no session view still counts as busy;
      // one is the honest lower bound there.
      activeTurns: activeSessions.length > 0 ? activeSessions.length : active ? 1 : 0,
      activeSessions,
      pending: this.queue.map(entry => ({
        id: entry.id,
        label: entry.label,
        queuedAt: entry.queuedAt,
        ...(entry.deadlineAt === undefined ? {} : { deadlineAt: entry.deadlineAt }),
      })),
      timeoutMs: this.timeoutMs,
      ...(this.lastOutcome === undefined ? {} : { lastOutcome: this.lastOutcome }),
      ...(this.labelOutcomes.size === 0 ? {} : { lastOutcomes: Object.fromEntries(this.labelOutcomes) }),
    }
  }

  /**
   * Run a write now when idle, or queue it behind the ACP turns.
   *
   * The returned promise settles when the write actually ran (or expired /
   * failed). A host caller that awaits this keeps the settings request pending;
   * the browser toast explains why. `options.timeoutMs` overrides the gate's
   * window for this one write; `0` waits forever.
   */
  defer(label: string, operation: () => Promise<unknown>, options: { timeoutMs?: number } = {}): Promise<SaveGateOutcome> {
    if (this.disposed) {
      return Promise.resolve({ status: 'failed', message: 'acp: save gate is disposed' })
    }
    // A newer save for the same label supersedes anything still waiting: the
    // old entry would write values the user has already replaced. Those entries
    // settle `cancelled` WITH `superseded: true`, so the toast can distinguish
    // "a newer save replaced this" from an explicit `save/cancel`.
    const version = this.nextLabelVersion(label)
    this.cancelQueued(label, true)
    this.retryables.set(label, { operation, ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }) })
    if (!this.host.hasActiveTurns()) {
      // No active turn: EXACT original behavior. The caller's rejection shape
      // is not swallowed (it becomes a `failed` outcome the host can rethrow).
      // The outcome is still recorded and broadcast so the settings UI sees
      // an immediate save settle just like a deferred one.
      return this.runImmediately(label, operation)
    }
    const timeoutMs = options.timeoutMs ?? this.timeoutMs
    const id = `save-${String(++this.seq)}`
    const queuedAt = this.now()
    const deadlineAt = timeoutMs > 0 ? queuedAt + timeoutMs : undefined
    return new Promise<SaveGateOutcome>(resolve => {
      const entry: QueuedSave = {
        id,
        label,
        version,
        queuedAt,
        ...(deadlineAt === undefined ? {} : { deadlineAt }),
        operation,
        settle: resolve,
      }
      this.armExpiry(entry)
      this.queue.push(entry)
      this.notify()
    })
  }

  /**
   * Drop every queued write carrying `label` and invalidate its generation.
   * A deleted agent uses this so a turn ending later cannot resurrect its
   * definition; the settings form uses it when the user keeps editing after
   * choosing "save after turns". Returns how many entries were dropped.
   */
  cancel(label: string): number {
    this.nextLabelVersion(label)
    this.retryables.delete(label)
    return this.cancelQueued(label)
  }

  /**
   * Re-run the last failed/expired write of `label` through the same queue.
   * Returns false when nothing is retained (already saved, or a newer save
   * replaced it). The failure banner's "retry" action uses this.
   */
  retry(label: string): boolean {
    if (this.disposed) return false
    const retryable = this.retryables.get(label)
    if (retryable === undefined) return false
    void this.defer(label, retryable.operation, retryable.timeoutMs === undefined ? {} : { timeoutMs: retryable.timeoutMs })
    return true
  }

  /** Resolve true when no turn is active, or false when the bounded wait expires. */
  waitForIdle(timeoutMs: number = this.timeoutMs): Promise<boolean> {
    if (!this.host.hasActiveTurns()) return Promise.resolve(true)
    return new Promise<boolean>(resolve => {
      const waiter: IdleWaiter = { resolve }
      if (timeoutMs > 0) {
        waiter.timer = this.setTimer(() => this.settleWaiter(waiter, false), timeoutMs)
      }
      this.idleWaiters.add(waiter)
    })
  }

  /**
   * Notification for a host that wants to retry a deferred profile reload.
   * The listener runs on every transition to idle; it is the caller's job to
   * re-check its own pending work and unsubscribe when it no longer needs it.
   */
  onIdle(listener: () => void): () => void {
    this.idleListeners.add(listener)
    // The race the host cannot close by itself: `canSaveNow()` was false, then
    // the turn ended before the listener existed. Fire immediately when the
    // plane is already idle so a deferred reload cannot wait forever.
    if (!this.host.hasActiveTurns()) {
      queueMicrotask(() => {
        if (this.disposed || !this.idleListeners.has(listener)) return
        try { listener() } catch { /* a listener must never break a turn boundary */ }
      })
    }
    return () => { this.idleListeners.delete(listener) }
  }

  /** Re-read the host's state after a turn boundary; flush the queue when idle. */
  sync(): void {
    if (this.disposed) return
    this.notify()
    if (!this.host.hasActiveTurns()) {
      this.settleIdle()
      this.scheduleIdleFlush()
      return
    }
    // `turn/end` is broadcast BEFORE the turn stream retires its controller
    // (a segmented turn can still be awaiting a continuation step). The
    // manager's `hasActiveTurns` therefore reads true at this instant even
    // when the turn is about to disappear. Re-check once after the current
    // synchronous teardown; without this the last frame would keep claiming
    // "saving" and a queued write would never flush.
    if (this.resyncScheduled) return
    this.resyncScheduled = true
    this.setTimer(() => {
      this.resyncScheduled = false
      this.recheck()
    }, 0)
  }

  /**
   * Global explicit "强制保存": execute EVERY queued write NOW, even while a
   * turn is active. ONLY the global `save/flush` entry
   * (`BridgeManager.saveGateFlush`) uses this. A per-agent `agent/save` with
   * `force` does NOT: the user authorised that gesture from one agent's dialog,
   * so it cancels its own label and writes directly instead of flushing the
   * whole queue (which would stop every other agent holding a pending write).
   *
   * A force request that arrives while another flush is still running cannot
   * reuse that promise: entries queued during the running pass would survive
   * it. It therefore queues ONE follow-up forced pass behind the current flush
   * (concurrent force callers share it), so the gesture always ends with an
   * empty queue.
   */
  async forceFlush(): Promise<SaveGateFlushResult> {
    if (this.disposed) return { saved: 0, expired: 0, failed: 0 }
    if (this.flushing === undefined) return this.flushQueue(true)
    this.forceTail ??= this.flushing
      .then(() => undefined, () => undefined)
      .then(() => {
        this.forceTail = undefined
        return this.flushQueue(true)
      })
    return this.forceTail
  }

  /** Stop accepting writes; queued writes settle `failed` and are never run. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const entry of [...this.queue]) {
      this.clearExpiry(entry)
      entry.settle({ status: 'failed', message: 'acp: save gate was disposed before the write ran' })
    }
    this.queue.length = 0
    this.retryables.clear()
    for (const waiter of [...this.idleWaiters]) this.settleWaiter(waiter, false)
    this.idleListeners.clear()
    this.notify()
  }

  private armExpiry(entry: QueuedSave): void {
    if (entry.deadlineAt === undefined) return
    const delayMs = Math.max(0, entry.deadlineAt - this.now())
    entry.timer = this.setTimer(() => { this.expire(entry.id) }, delayMs)
  }

  private clearExpiry(entry: QueuedSave): void {
    if (entry.timer === undefined) return
    this.clearTimer(entry.timer)
    entry.timer = undefined
  }

  /** A queued write ran out of its bounded wait; drop it without writing. */
  private expire(id: string): void {
    const index = this.queue.findIndex(entry => entry.id === id)
    if (index < 0) return
    const [entry] = this.queue.splice(index, 1)
    this.clearExpiry(entry)
    this.recordOutcome(entry.label, { status: 'expired' })
    entry.settle({ status: 'expired' })
    this.notify()
  }

  /** Bump the label generation; entries carrying the old number are stale. */
  private nextLabelVersion(label: string): number {
    const version = (this.labelVersions.get(label) ?? 0) + 1
    this.labelVersions.set(label, version)
    return version
  }

  /**
   * Remove every queued entry of `label`, settling them `cancelled`.
   * `superseded` marks entries displaced by a NEWER save of the same label;
   * the explicit `save/cancel` API leaves it unset.
   */
  private cancelQueued(label: string, superseded = false): number {
    let cancelled = 0
    for (let index = this.queue.length - 1; index >= 0; index -= 1) {
      const entry = this.queue[index]
      if (entry.label !== label) continue
      this.queue.splice(index, 1)
      this.clearExpiry(entry)
      this.retryables.delete(label)
      const outcome: SaveGateOutcome = superseded ? { status: 'cancelled', superseded: true } : { status: 'cancelled' }
      this.recordOutcome(entry.label, outcome)
      entry.settle(outcome)
      cancelled += 1
    }
    if (cancelled > 0) this.notify()
    return cancelled
  }

  /** The idle path: run the write at once, but record and publish its result. */
  private async runImmediately(label: string, operation: () => Promise<unknown>): Promise<SaveGateOutcome> {
    try {
      const value = await operation()
      const outcome = { status: 'saved', value } as const
      this.retryables.delete(label)
      this.recordOutcome(label, outcome)
      this.notify()
      return outcome
    } catch (error) {
      // Subject-gone abort: silent terminal state, no outcome for the banner.
      if (isSaveGateAborted(error)) {
        this.retryables.delete(label)
        return { status: 'cancelled' }
      }
      const outcome = {
        status: 'failed',
        message: error instanceof Error ? error.message : String(error),
        error,
      } as const
      this.recordOutcome(label, outcome)
      this.notify()
      return outcome
    }
  }

  /** One post-teardown re-read; it does NOT schedule another. */
  private recheck(): void {
    if (this.disposed) return
    this.notify()
    if (!this.host.hasActiveTurns()) {
      this.settleIdle()
      this.scheduleIdleFlush()
    }
  }

  private scheduleIdleFlush(): void {
    if (this.disposed || this.flushScheduled || this.flushing !== undefined) return
    if (this.queue.length === 0 || this.host.hasActiveTurns()) return
    this.flushScheduled = true
    // A macrotask, not a microtask: `turn/end` is broadcast BEFORE the turn
    // stream retires its controller, and the gate must see the retired state.
    this.setTimer(() => {
      this.flushScheduled = false
      void this.flushQueue(false)
    }, 0)
  }

  /** Publish the idle transition to waiters and host listeners exactly once. */
  private settleIdle(): void {
    for (const waiter of [...this.idleWaiters]) this.settleWaiter(waiter, true)
    for (const listener of [...this.idleListeners]) {
      try { listener() } catch { /* a listener must never break a turn boundary */ }
    }
  }

  private flushQueue(force: boolean): Promise<SaveGateFlushResult> {
    if (this.flushing !== undefined) return this.flushing
    this.flushing = this.runFlush(force).finally(() => {
      this.flushing = undefined
      this.notify()
      this.scheduleIdleFlush()
    })
    return this.flushing
  }

  private async runFlush(force: boolean): Promise<SaveGateFlushResult> {
    const result: SaveGateFlushResult = { saved: 0, expired: 0, failed: 0 }
    // A forced pass executes exactly what was queued when it started. A save
    // that arrives while this pass runs belongs to the NEXT turn boundary (or
    // the next explicit force); absorbing it here would write a value the
    // caller only asked to hold.
    const forcedSnapshot = force ? new Set(this.queue) : undefined
    while (this.queue.length > 0) {
      if (!force && this.host.hasActiveTurns()) break
      let entry: QueuedSave
      if (forcedSnapshot !== undefined) {
        const index = this.queue.findIndex(candidate => forcedSnapshot.has(candidate))
        // Only entries queued during this pass are left; keep them pending.
        if (index < 0) break
        entry = this.queue[index]
        this.queue.splice(index, 1)
      } else {
        entry = this.queue.shift()!
      }
      this.clearExpiry(entry)
      // Execution-time generation check: a newer save, a cancel or a delete
      // that landed while this entry waited must win over the stale snapshot.
      if (entry.version !== (this.labelVersions.get(entry.label) ?? 0)) {
        result.cancelled = (result.cancelled ?? 0) + 1
        this.recordOutcome(entry.label, { status: 'cancelled' })
        entry.settle({ status: 'cancelled' })
        continue
      }
      if (!force && entry.deadlineAt !== undefined && this.now() >= entry.deadlineAt) {
        result.expired += 1
        this.recordOutcome(entry.label, { status: 'expired' })
        entry.settle({ status: 'expired' })
        continue
      }
      try {
        const value = await entry.operation()
        result.saved += 1
        this.retryables.delete(entry.label)
        this.recordOutcome(entry.label, { status: 'saved', value })
        entry.settle({ status: 'saved', value })
      } catch (error) {
        // The write aborted because its subject vanished while it ran (an agent
        // deleted mid-flight). That is the delete winning, not a failed save:
        // settle `cancelled`, record nothing, and never offer a retry.
        if (isSaveGateAborted(error)) {
          result.cancelled = (result.cancelled ?? 0) + 1
          this.retryables.delete(entry.label)
          entry.settle({ status: 'cancelled' })
          continue
        }
        const message = error instanceof Error ? error.message : String(error)
        result.failed += 1
        this.recordOutcome(entry.label, { status: 'failed', message })
        entry.settle({ status: 'failed', message, error })
      }
    }
    return result
  }

  private settleWaiter(waiter: IdleWaiter, idle: boolean): void {
    if (!this.idleWaiters.delete(waiter)) return
    if (waiter.timer !== undefined) this.clearTimer(waiter.timer)
    waiter.resolve(idle)
  }

  private recordOutcome(label: string, outcome: SaveGateOutcome): void {
    const view: SaveGateOutcomeView = {
      at: this.now(),
      status: outcome.status,
      label,
      ...(outcome.status === 'failed' ? { message: outcome.message } : {}),
      ...(outcome.status === 'cancelled' && outcome.superseded === true ? { superseded: true } : {}),
    }
    this.lastOutcome = view
    this.labelOutcomes.set(label, view)
  }

  private notify(): void {
    const status = this.status()
    const signature = JSON.stringify(status)
    if (signature === this.lastSignature) return
    this.lastSignature = signature
    this.onChange?.(status)
  }
}
