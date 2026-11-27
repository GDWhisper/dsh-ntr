/**
 * The save gate's browser half, lifted out of `AcpStore` (split plan P3b): the
 * gate reads and gestures (`save/status` / `save/flush` / `save/cancel` /
 * `save/retry`), the page-top banner rows they produce, and the retry /
 * force / dismiss machinery behind each row.
 *
 * The banner rules are the point of this file (constraint 38): failure rows
 * persist until the user closes them and are never dropped by count, at most
 * one success row exists and it lists every agent that settled in the same
 * frame, and a gate-sourced row closed before a refresh stays closed through
 * the `sessionStorage` record keyed by `banner.key` → `banner.at`.
 *
 * The service never imports the facade: the RPC face, the snapshot, the label
 * resolver, the log allocator and the agent-save retry all arrive through
 * {@link SaveBannersHost}, so the broadcast and merge timing is exactly the
 * store's.
 */

import type { AgentSaveMode, AgentSavePayload, SaveGateFlushResult, SaveGateStatus } from '../../protocol.ts'
import type { AcpLogEntry, UiState } from './state.ts'
import { LOG_MAX_ENTRIES } from './state.ts'
import type { SaveBanner } from './save-gate.ts'
import {
  composeSaveBanners,
  normalizeSaveGateStatus,
  saveGateOutcomeForLabel,
  saveGateOutcomeSuperseded,
  saveGateTransitions,
} from './save-gate.ts'

/** sessionStorage record of persistent banners the user closed, keyed by row key. */
const SAVE_BANNER_DISMISSALS_KEY = 'dsh-ntr.save-banner-dismissals'

function readBannerDismissals(): Record<string, number> {
  try {
    const raw = globalThis.sessionStorage?.getItem(SAVE_BANNER_DISMISSALS_KEY)
    if (raw === undefined || raw === null || raw === '') return {}
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return {}
    const out: Record<string, number> = {}
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === 'number') out[key] = value
    }
    return out
  } catch {
    return {}
  }
}

function rememberBannerDismissal(banner: SaveBanner): void {
  if (banner.persistAcrossReload !== true || banner.level !== 'error') return
  try {
    const dismissed = readBannerDismissals()
    dismissed[banner.key] = banner.at
    globalThis.sessionStorage?.setItem(SAVE_BANNER_DISMISSALS_KEY, JSON.stringify(dismissed))
  } catch {
    // Storage can be unavailable (private mode); the in-memory row is still closed.
  }
}

function wasClosedAcrossReload(banner: SaveBanner): boolean {
  if (banner.persistAcrossReload !== true) return false
  return readBannerDismissals()[banner.key] === banner.at
}

/** What the banners service needs from the store, injected. */
export interface SaveBannersHost {
  /** The `/acp` RPC face (the store's own `call`, code-preserving errors included). */
  call<T>(endpoint: string, payload?: unknown): Promise<T>
  /** Commit one snapshot patch and notify listeners — the store's single writer. */
  mutate(patch: Partial<UiState>): void
  /** The current snapshot (reads only). */
  state(): UiState
  /** The store's locale-bound label resolver (a stable reference across renders). */
  label(zh: string, en: string): string
  /** Surface an action failure in the settings page's notice line. */
  flashError(error: unknown): void
  /**
   * Allocate one runtime-log line (monotonic id, shared with the store's own
   * `logPatch`, so `clearLogs` never rewinds the sequence).
   */
  logLine(level: 'info' | 'error', text: string): AcpLogEntry
  /** Re-run a save the user retried/forced from a banner (the agent-admin service). */
  retryAgentSave(payload: AgentSavePayload, mode: AgentSaveMode): Promise<unknown>
}

/** What a banner's retry/force button can actually do. */
export type SaveBannerRetry =
  | { kind: 'gate'; label: string }
  | { kind: 'cancel'; label: string }
  | { kind: 'flush' }
  | { kind: 'payload'; payload: AgentSavePayload }

export class SaveBannersService {
  /**
   * The gesture behind each live banner row. Kept out of UiState so the
   * snapshot stays plain data; a dismissed banner drops its entry, which is
   * why the same failure can show again next time.
   */
  private readonly bannerRetries = new Map<string, SaveBannerRetry>()

  constructor(private readonly host: SaveBannersHost) {}

  /** Retain what `key`'s retry/force gesture should re-run (the agent-admin save path). */
  setBannerRetry(key: string, action: SaveBannerRetry): void {
    this.bannerRetries.set(key, action)
  }

  /**
   * Drop `key`'s retained gesture without touching the row — a fresh row for
   * the same key must not inherit a payload it no longer stands for.
   */
  forgetBannerRetry(key: string): void {
    this.bannerRetries.delete(key)
  }


  /**
   * Read the host's save gate before a settings save. The host remains the
   * authority (`agent/save` re-checks), but this lets the form show its
   * confirmation without racing a turn.
   */
  async readSaveGate(): Promise<SaveGateStatus> {
    const result = await this.host.call<{ status: SaveGateStatus }>('save/status')
    const status = normalizeSaveGateStatus(result.status)
    this.host.mutate({ saveGate: status })
    return status
  }

  /**
   * Explicit "强制保存": flush the host's held profile writes now, even while
   * an ACP turn is running. The gate broadcasts its new state; the extra
   * `save/status` read is the fallback for a host that resolves the flush
   * before its own frame lands. A transport failure gets its own visible row —
   * the caller's `.finally` must never be the only thing that runs.
   */
  async forceSaveGate(): Promise<SaveGateFlushResult> {
    try {
      return await this.flushHeldSaves()
    } catch (error) {
      this.pushSaveRetryFailedBanner(undefined, this.errorText(error))
      throw error
    }
  }

  /** Run `save/flush`, then fold its answer into banners and the gate snapshot. */
  private async flushHeldSaves(): Promise<SaveGateFlushResult> {
    // Capture what this flush was asked to write BEFORE the call: only the
    // gate's terminal rows afterwards can tell which of those labels failed.
    const heldLabels = this.host.state().saveGate.pending.map(entry => entry.label)
    const result = await this.host.call<SaveGateFlushResult>('save/flush')
    const status = await this.host.call<{ status: SaveGateStatus }>('save/status').catch(() => null)
    const next = status?.status === undefined ? undefined : normalizeSaveGateStatus(status.status)
    if (next !== undefined) this.host.mutate({ saveGate: next })
    this.reportFlushResult(result, heldLabels, next)
    return result
  }

  /**
   * Drop one held profile write by label. The settings form uses this when the
   * user edits the form after choosing "save after turns": flushing that old
   * snapshot later would silently overwrite the newer values.
   *
   * Only a numeric, positive cancellation count is success. A missing or
   * non-numeric answer leaves the held state in place and warns: the host
   * clearly answered, but it did not prove the write was dropped.
   */
  async cancelSaveGate(label: string): Promise<boolean> {
    let result: { cancelled?: number } | undefined
    try {
      result = await this.host.call<{ cancelled?: number }>('save/cancel', { label })
    } catch (error) {
      this.host.flashError(error)
      this.pushSaveCancelFailedBanner(label)
      return false
    }
    const cancelled = result?.cancelled
    if (typeof cancelled !== 'number') {
      this.pushSaveCancelFailedBanner(label)
      return false
    }
    if (cancelled > 0) {
      this.dropPendingLocally(label)
      return true
    }
    // `0` can also mean "the frame raced ahead of the status snapshot". Re-read
    // before warning; only a label still queued (or no matching terminal row)
    // is a real failure.
    try {
      const status = await this.readSaveGate()
      const stillPending = status.pending.some(entry => entry.label === label)
      const outcome = saveGateOutcomeForLabel(status, label)
      if (!stillPending && outcome?.status === 'cancelled') {
        this.dropPendingLocally(label)
        return true
      }
    } catch (error) {
      this.host.flashError(error)
    }
    this.pushSaveCancelFailedBanner(label)
    return false
  }

  /** Re-run a failed/expired held write through the host gate. */
  async retrySaveGate(label: string): Promise<'retried' | 'none' | 'error'> {
    try {
      const result = await this.host.call<{ retried?: unknown }>('save/retry', { label })
      if (result.retried === true) {
        // A status frame is already on its way; this read closes the gap when
        // the host resolves the retry before broadcasting.
        await this.readSaveGate().catch(() => { /* the status frame remains authoritative */ })
        return 'retried'
      }
      if (result.retried === false) return 'none'
      // A malformed answer is not "nothing to retry": reporting that would
      // hide a real host problem behind a success receipt.
      throw new Error(this.host.label(
        '宿主返回了无法识别的重试结果。',
        'The host returned an unrecognised retry result.',
      ))
    } catch (error) {
      this.pushSaveRetryFailedBanner(label, this.errorText(error))
      return 'error'
    }
  }

  private dropPendingLocally(label: string): void {
    const next = this.host.state().saveGate.pending.filter(entry => entry.label !== label)
    if (next.length === this.host.state().saveGate.pending.length) {
      // Still clear a stale "cancel did not take effect" row on a success.
      this.dismissBanner(`save-cancel-failed:${label}`)
      return
    }
    this.host.mutate({
      saveGate: {
        ...this.host.state().saveGate,
        pending: next,
      },
      saveBanners: this.host.state().saveBanners.filter(banner => banner.key !== `save-cancel-failed:${label}`),
    })
    this.bannerRetries.delete(`save-cancel-failed:${label}`)
  }

  /**
   * The banner's "知道了": remove it, and let the same failure reappear later.
   * `at` names the row that owns the gesture. An auto-dismiss timer passes the
   * timestamp it was registered with, so a NEWER row sharing the key survives.
   */
  dismissBanner(key: string, at?: number): void {
    const current = this.host.state().saveBanners.find(banner => banner.key === key)
    if (current === undefined) {
      this.bannerRetries.delete(key)
      return
    }
    if (at !== undefined && current.at !== at) return
    rememberBannerDismissal(current)
    this.bannerRetries.delete(key)
    this.host.mutate({ saveBanners: this.host.state().saveBanners.filter(banner => banner.key !== key) })
  }

  /** The banner's "重试": re-run the retained host write or the rejected save. */
  async retryBanner(key: string): Promise<void> {
    const action = this.bannerRetries.get(key)
    if (action === undefined) {
      this.dismissBanner(key)
      return
    }
    if (action.kind === 'cancel') {
      this.dismissBanner(key)
      const cancelled = await this.cancelSaveGate(action.label)
      // A failed retry re-adds its own "cancel did not take effect" row.
      if (cancelled) this.pushSaveCancelledBanner(action.label)
      return
    }
    if (action.kind === 'gate') {
      const outcome = await this.retrySaveGate(action.label)
      if (outcome === 'error') {
        // Keep the original failure row AND the new error receipt: an RPC
        // failure is not evidence that nothing was left to retry.
        return
      }
      this.dismissBanner(key)
      // "重试" never silently escalates to a force flush: a force can interrupt
      // a running turn, and that is a separate, explicit gesture.
      if (outcome === 'none') this.pushSaveRetryNoneBanner(action.label)
      return
    }
    if (action.kind === 'flush') {
      await this.retryFlushBanner(key)
      return
    }
    this.dismissBanner(key)
    try {
      await this.host.retryAgentSave(action.payload, 'defer')
    } catch { /* the failure banner has already been replaced */ }
  }

  /** The banner's "强制保存": flush the gate or force the rejected payload. */
  async forceBanner(key: string): Promise<void> {
    const action = this.bannerRetries.get(key)
    if (action?.kind === 'payload') {
      this.dismissBanner(key)
      try {
        await this.host.retryAgentSave(action.payload, 'force')
      } catch { /* the failure banner has already been replaced */ }
      return
    }
    // A gate failure/expiry row is settled by the flush itself; a transport
    // error becomes a fresh visible receipt. The partial row is different: it
    // must survive until a flush actually clears every held write.
    if (action?.kind === 'gate') {
      this.dismissBanner(key)
      try {
        await this.flushHeldSaves()
      } catch (error) {
        this.pushSaveRetryFailedBanner(undefined, this.errorText(error))
      }
      return
    }
    await this.retryFlushBanner(key)
  }

  /**
   * Retry/force one `save-partial` row. The original partial row survives a
   * transport failure; only an all-saved flush clears it. A partially completed
   * retry replaces the row through {@link reportFlushResult} instead.
   */
  private async retryFlushBanner(key: string): Promise<void> {
    const beforeAt = this.host.state().saveBanners.find(banner => banner.key === key)?.at
    try {
      const result = await this.flushHeldSaves()
      const remaining = (result.expired ?? 0) + (result.failed ?? 0)
      if (remaining === 0) this.dismissBanner(key, beforeAt)
    } catch (error) {
      this.pushSaveRetryFailedBanner(undefined, this.errorText(error))
    }
  }

  /** Translate one force-flush result into a success or partial-failure banner. */
  private reportFlushResult(
    result: SaveGateFlushResult,
    heldLabels: readonly string[] = [],
    status?: SaveGateStatus,
  ): void {
    const expired = result.expired ?? 0
    const failed = result.failed ?? 0
    const failedLabels = status === undefined
      ? []
      : heldLabels.filter(label => {
        const outcome = saveGateOutcomeForLabel(status, label)
        return outcome?.status === 'failed' || outcome?.status === 'expired'
      })
    if (expired > 0 || failed > 0) {
      const key = 'save-partial'
      this.bannerRetries.set(key, { kind: 'flush' })
      const named = failedLabels.length === 0
        ? ''
        : this.host.label(` 未写入：${failedLabels.join('、')}。`, ` Not written: ${failedLabels.join(', ')}.`)
      this.pushSaveBanner({
        key,
        source: 'save-partial',
        level: 'error',
        title: this.host.label('强制保存只完成一部分', 'Forced save only partly completed'),
        body: this.host.label(
          `已保存 ${String(result.saved)} 项，失败 ${String(failed)} 项，过期 ${String(expired)} 项${result.cancelled ? `，取消 ${String(result.cancelled)} 项` : ''}。请重试。${named}`,
          `${String(result.saved)} saved, ${String(failed)} failed, ${String(expired)} expired${result.cancelled ? `, ${String(result.cancelled)} cancelled` : ''}. Please retry.${named}`,
        ),
        at: Date.now(),
        actions: ['retry', 'dismiss'],
      })
      return
    }
    if (result.saved > 0) {
      const savedLabels = status === undefined
        ? []
        : heldLabels.filter(label => saveGateOutcomeForLabel(status, label)?.status === 'saved')
      this.pushSaveSuccessBanner(result.saved, savedLabels)
    }
  }

  /**
   * A success receipt names the agent (or the non-agent label) it belongs to.
   * Several agents settling in one frame share ONE row whose body lists every
   * one of them, so the last settlement cannot erase the others' identity.
   */
  private saveSuccessBanner(saved: number, labels: string[] = []): SaveBanner {
    const subjects = labels.map(label => this.saveSubjectOf(label))
    const count = saved > 1
      ? this.host.label(`已保存 ${String(saved)} 项配置`, `${String(saved)} settings were saved`)
      : undefined
    const body = subjects.length === 0
      ? (count === undefined ? this.host.label('已保存。', 'Saved.') : `${count}。`)
      : subjects.length > 3
        ? this.host.label(
          `已保存：${subjects.slice(0, 3).join('、')} 等 ${String(subjects.length)} 个。`,
          `Saved: ${subjects.slice(0, 3).join(', ')}, ${String(subjects.length)} total.`,
        )
        : this.host.label(`已保存：${subjects.join('、')}。`, `Saved: ${subjects.join(', ')}.`)
    return {
      key: 'save-succeeded',
      source: 'save-succeeded',
      level: 'success',
      title: this.host.label('保存成功', 'Saved'),
      body,
      at: Date.now(),
      actions: ['dismiss'],
      autoDismissMs: 2500,
    }
  }

  private saveSubjectOf(label: string): string {
    const prefix = 'agent-save:'
    if (!label.startsWith(prefix)) return label
    const agentId = label.slice(prefix.length)
    const configured = this.host.state().agents.find(agent => agent.id === agentId)
    const detected = this.host.state().detectedAgents.find(agent => agent.id === agentId)
    return configured?.title ?? detected?.name ?? agentId
  }

  private pushSaveSuccessBanner(saved: number, labels: string[] = []): void {
    this.pushSaveBanner(this.saveSuccessBanner(saved, labels))
  }

  private errorText(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
  }

  /** One visible receipt for a retry/force that failed before any settlement. */
  private pushSaveRetryFailedBanner(label: string | undefined, message: string): void {
    this.pushSaveBanner({
      key: `save-retry-failed:${label ?? 'flush'}`,
      source: 'save-retry-failed',
      level: 'error',
      title: this.host.label('重试失败', 'Retry failed'),
      body: this.host.label(`重试没有完成：${message}`, `The retry did not complete: ${message}`),
      at: Date.now(),
      actions: ['dismiss'],
      ...(label === undefined ? {} : { label }),
    })
  }

  private pushSaveCancelledBanner(label: string): void {
    this.pushSaveBanner({
      key: `save-cancelled:${label}`,
      source: 'save-cancelled',
      level: 'success',
      title: this.host.label('已取消暂存', 'Held save cancelled'),
      body: this.host.label(
        '回合结束后不会写入点击时的版本。',
        'The values from the moment you clicked will not be written when the turn ends.',
      ),
      at: Date.now(),
      actions: ['dismiss'],
      autoDismissMs: 2500,
    })
  }

  private pushSaveCancelFailedBanner(label: string): void {
    const key = `save-cancel-failed:${label}`
    this.bannerRetries.set(key, { kind: 'cancel', label })
    this.pushSaveBanner({
      key,
      source: 'save-cancel-failed',
      level: 'error',
      title: this.host.label('取消未生效', 'Cancel did not take effect'),
      body: this.host.label(
        '取消未生效，回合结束会写入点击时版本。',
        'The cancel did not take effect. The values from the moment you clicked will be written when the turn ends.',
      ),
      at: Date.now(),
      actions: ['retry', 'dismiss'],
      label,
    })
  }

  private pushSaveRetryNoneBanner(label: string): void {
    this.pushSaveBanner({
      key: `save-retry-none:${label}`,
      source: 'save-retry-none',
      level: 'success',
      title: this.host.label('已无待重试项', 'Nothing left to retry'),
      body: this.host.label('该配置已不在待重试的队列中。', 'That setting is no longer waiting to be retried.'),
      at: Date.now(),
      actions: ['dismiss'],
      autoDismissMs: 2500,
    })
  }

  /**
   * The failure/expiry rows that a successful save of `label` retires. Scoped to
   * the same agent (or the same non-agent setting) so another agent's failure
   * receipts survive.
   */
  private saveFailureKeysFor(label: string): Set<string> {
    const keys = new Set([`save-failed:${label}`, `save-expired:${label}`])
    const prefix = 'agent-save:'
    if (label.startsWith(prefix)) {
      const agentId = label.slice(prefix.length)
      keys.add(`save-failed:${agentId}`)
      keys.add(`save-rejected:${agentId}`)
    }
    return keys
  }

  /**
   * A successful save retires that agent's older failure receipts: leaving
   * "the setting was not written" beside a fresh success would contradict it.
   * Only failure/expiry rows go; another agent's rows and receipts stay.
   */
  clearAgentSaveFailures(agentId: string): void {
    const keys = this.saveFailureKeysFor(`agent-save:${agentId}`)
    for (const key of keys) this.bannerRetries.delete(key)
    const next = this.host.state().saveBanners.filter(banner => !keys.has(banner.key))
    if (next.length !== this.host.state().saveBanners.length) this.host.mutate({ saveBanners: next })
  }

  /**
   * A deleted agent must not leave a retry gesture behind: its payload would
   * recreate exactly what the user removed. Clear the id-keyed rows and the
   * label-keyed gate rows in one place.
   */
  clearAgentSaveBanners(agentId: string): void {
    const label = `agent-save:${agentId}`
    const keys = new Set([
      `save-failed:${agentId}`,
      `save-rejected:${agentId}`,
      `save-failed:${label}`,
      `save-expired:${label}`,
      `save-cancel-failed:${label}`,
      `save-cancelled:${label}`,
      `save-retry-none:${label}`,
      `save-retry-failed:${label}`,
    ])
    for (const key of keys) this.bannerRetries.delete(key)
    const next = this.host.state().saveBanners.filter(banner => !keys.has(banner.key))
    if (next.length !== this.host.state().saveBanners.length) this.host.mutate({ saveBanners: next })
  }

  /**
   * Fold one gate snapshot into banners and log lines. The SSE frame and
   * `resync` share this, so a page refresh rebuilds the terminal rows it missed
   * instead of only replacing `saveGate`.
   *
   * `logPending = false` on a resync: the held entry did not APPEAR at refresh
   * time, and logging it on every panel open would be noise. Terminal rows are
   * still synthesized.
   *
   * A terminal row is a SEED (rebuilt from a snapshot rather than witnessed live)
   * when a resync asks for it or when the previous snapshot has no terminal
   * entry for that label — the first SSE frame after a refresh lands before
   * `resync` and carries the whole host roster. Seeded rows obey the closed-row
   * records in sessionStorage; live settlements carry a new `at`, so closing an
   * old row never suppresses a later failure of the same label.
   */
  saveGatePatch(
    previous: SaveGateStatus,
    next: SaveGateStatus,
    logPending = true,
    rebuildRows = false,
  ): Partial<UiState> {
    const { addedPending, outcomes } = saveGateTransitions(previous, next)
    const logged: AcpLogEntry[] = []
    const log = (level: 'info' | 'error', text: string): void => {
      logged.push(this.host.logLine(level, text))
    }
    let banners = this.host.state().saveBanners
    for (const entry of addedPending) {
      // The queue is authoritative again: drop a just-shown "cancelled"
      // success row for the same label so the two prompts are not shown side
      // by side. A resync can re-enter the queue too, so this is not tied to
      // whether the arrival is worth a log line.
      banners = banners.filter(banner => banner.key !== `save-cancelled:${entry.label}`)
      if (logPending) {
        log('info', this.host.label(
          '本轮对话还在进行，配置已暂存，回合结束后自动保存。',
          'A turn is still running. The setting is held and will be saved when the turn ends.',
        ))
      }
    }
    const savedLabels: string[] = []
    for (const { label, outcome, wasPending, isPending } of outcomes) {
      if (outcome.status === 'saved') {
        // Only a previously HELD write earns the global receipt; a direct save
        // from the form reports success on its own.
        if (!wasPending) continue
        // A success retires this agent's earlier failure/expiry receipts.
        const cleared = this.saveFailureKeysFor(label)
        for (const key of cleared) this.bannerRetries.delete(key)
        banners = banners.filter(banner => !cleared.has(banner.key))
        log('info', this.host.label(
          `配置已保存：${label}。`,
          `The setting was saved: ${label}.`,
        ))
        savedLabels.push(label)
      } else if (outcome.status === 'expired') {
        const key = `save-expired:${label}`
        const row: SaveBanner = {
          key,
          source: 'save-expired',
          level: 'error',
          title: this.host.label('暂存已过期', 'Held save expired'),
          body: this.host.label('等待超时，配置尚未写入。请重试。', 'The wait expired before the setting was written. Please retry.'),
          at: outcome.at,
          actions: isPending ? ['retry', 'force', 'dismiss'] : ['retry', 'dismiss'],
          label,
          persistAcrossReload: true,
        }
        if ((rebuildRows || saveGateOutcomeForLabel(previous, label) === undefined) && wasClosedAcrossReload(row)) continue
        log('error', this.host.label(
          '配置保存等待超时，尚未写入；请重新保存。',
          'The setting was not saved before its wait expired. Please save it again.',
        ))
        this.bannerRetries.set(key, { kind: 'gate', label })
        banners = composeSaveBanners(banners, row)
      } else if (outcome.status === 'failed') {
        const key = `save-failed:${label}`
        const row: SaveBanner = {
          key,
          source: 'save-failed',
          level: 'error',
          title: this.host.label('保存失败', 'Save failed'),
          body: this.host.label(
            `配置未写入：${outcome.message ?? '未知错误'}`,
            `The setting was not written: ${outcome.message ?? 'unknown error'}`,
          ),
          at: outcome.at,
          actions: ['retry', 'dismiss'],
          label,
          persistAcrossReload: true,
        }
        if ((rebuildRows || saveGateOutcomeForLabel(previous, label) === undefined) && wasClosedAcrossReload(row)) continue
        log('error', this.host.label(
          `配置保存失败：${outcome.message ?? '未知错误'}`,
          `The setting could not be saved: ${outcome.message ?? 'unknown error'}`,
        ))
        this.bannerRetries.set(key, { kind: 'gate', label })
        banners = composeSaveBanners(banners, row)
      } else if (outcome.status === 'cancelled') {
        // A superseded row belongs to a newer save; a label still queued has
        // not settled either. Neither is this attempt's cancellation.
        if (saveGateOutcomeSuperseded(outcome) || isPending) continue
        // Cancellation is a silent terminal result: no banner, one log line.
        if (wasPending) log('info', this.host.label('配置暂存已取消。', 'The held setting was cancelled.'))
      }
    }
    // One frame can settle several agents together. Show a single success row
    // that names every one of them instead of letting the last overwrite the
    // rest, and keep one log line per label above.
    if (savedLabels.length > 0) {
      banners = composeSaveBanners(banners, this.saveSuccessBanner(savedLabels.length, savedLabels))
    }
    return {
      ...(logged.length === 0 ? {} : {
        logs: [...this.host.state().logs, ...logged].slice(-LOG_MAX_ENTRIES),
        logUnread: this.host.state().logUnread + logged.length,
      }),
      ...(banners === this.host.state().saveBanners ? {} : { saveBanners: banners }),
    }
  }

  /** Drop any lingering `hmr-delay` banner once the deferred reload settles. */
  clearHmrDelayBanner(): void {
    const next = this.host.state().saveBanners.filter(banner => banner.key !== 'hmr-delay')
    if (next.length !== this.host.state().saveBanners.length) this.host.mutate({ saveBanners: next })
  }

  /**
   * Add or replace one banner. The key IS the dedupe rule; failure rows are
   * never dropped by count, and only one transient success row is kept.
   */
  pushSaveBanner(banner: SaveBanner): void {
    this.host.mutate({ saveBanners: composeSaveBanners(this.host.state().saveBanners, banner) })
  }
}
