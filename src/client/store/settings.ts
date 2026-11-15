/**
 * The settings page's preference writes, lifted out of `AcpStore` (split plan
 * P3b): the agent-tag halo, the `[NTR]` title prefix, the approval deadlines
 * (window, expiry mode, reset) and the idle-release window.
 *
 * Two shapes share this cluster because they share one contract: an optimistic
 * local write for the click, then the host answer — the SAME route reports the
 * value now in force — as the authority. A failure restores the previous view
 * and flashes the notice.
 *
 * The service never imports the facade: `call` / `mutate` / the snapshot and
 * `flashError` arrive through {@link SettingsHost}, so the broadcast and merge
 * timing of every write is exactly the store's.
 */

import type {
  AcpTagHalo,
  ApprovalDeadlinesResult,
  ApprovalDeadlinesSetPayload,
  IdleReleaseResult,
  IdleReleaseSetPayload,
  PermissionTimeoutMode,
} from '../../protocol.ts'
import type { UiState } from './state.ts'

/** What the settings service needs from the store, injected. */
export interface SettingsHost {
  /** The `/acp` RPC face (the store's own `call`, code-preserving errors included). */
  call<T>(endpoint: string, payload?: unknown): Promise<T>
  /** Commit one snapshot patch and notify listeners — the store's single writer. */
  mutate(patch: Partial<UiState>): void
  /** The current snapshot (reads only). */
  state(): UiState
  /** Surface an action failure in the settings page's notice line. */
  flashError(error: unknown): void
}

/**
 * Write the agent tag's halo preference (settings card). The value is
 * validated host-side; this side writes optimistically first so the tag's
 * look changes with the click, and reverts to the host answer on a failure.
 */
export class SettingsService {
  constructor(private readonly host: SettingsHost) {}

  async setTagHalo(halo: AcpTagHalo): Promise<void> {
    const previous = this.host.state().tagHalo
    this.host.mutate({ tagHalo: halo })
    try {
      await this.host.call('ui/tag-halo-set', { halo })
    } catch (error) {
      this.host.mutate({ tagHalo: previous })
      this.host.flashError(error)
    }
  }

  /**
   * Write the title-prefix toggle (settings page). Optimistic like
   * {@link setTagHalo}: the row flips with the click and reverts to the host
   * answer on a failure. The host persists the pick and applies it from the
   * next title generation on.
   */
  async setTitlePrefix(value: boolean): Promise<void> {
    const previous = this.host.state().titlePrefix
    this.host.mutate({ titlePrefix: value === true })
    try {
      await this.host.call('ui/session-title-prefix-set', { titlePrefix: value === true })
    } catch (error) {
      this.host.mutate({ titlePrefix: previous })
      this.host.flashError(error)
    }
  }

  /**
   * Write the approval deadline (settings card), or drop the persisted override
   * with `reset` so the `cordis.patch.yml` baseline applies again.
   *
   * The host answer — the same route returns the deadlines now in force — is the
   * authority, so an optimistic write that the host trims (out of range, or
   * merged with a value this browser did not know about) self-corrects instead
   * of drifting from what runs.
   */
  async setApprovalDeadline(ms: number): Promise<void> {
    await this.writeApprovalDeadlines({ permissionTimeoutMs: ms })
  }

  /**
   * Write the mode: what an expired deadline DOES (`abort` refuses, `auto`
   * answers with the option the agent's own kinds imply, `wait` never
   * expires). Same write path as the window, so the host answer stays
   * the authority.
   */
  async setApprovalTimeoutMode(mode: PermissionTimeoutMode): Promise<void> {
    await this.writeApprovalDeadlines({ mode })
  }

  /** Drop the persisted override: the config file (or the built-in default) decides again. */
  async resetApprovalDeadlines(): Promise<void> {
    await this.writeApprovalDeadlines({ reset: true })
  }

  /**
   * Write the idle-release window (in ms).
   *
   * The host answer — the same route returns the window now in force — is
   * the authority, so an optimistic write that the host trims self-corrects
   * instead of drifting from what runs.
   */
  async setIdleRelease(idleTimeoutMs: number): Promise<void> {
    await this.writeIdleRelease({ idleTimeoutMs })
  }

  /**
   * Drop the persisted override: the config file (or the built-in default)
   * decides again.
   */
  async resetIdleRelease(): Promise<void> {
    await this.writeIdleRelease({ reset: true })
  }

  private async writeIdleRelease(payload: IdleReleaseSetPayload): Promise<void> {
    const previous = this.host.state().idleRelease
    try {
      const result = await this.host.call<IdleReleaseResult>('ui/idle-release-set', payload)
      this.host.mutate({ idleRelease: result.idleRelease })
    } catch (error) {
      this.host.mutate({ idleRelease: previous })
      this.host.flashError(error)
    }
  }

  private async writeApprovalDeadlines(payload: ApprovalDeadlinesSetPayload): Promise<void> {
    const previous = this.host.state().approvalDeadlines
    // Optimistic only where it is safe: the effective numbers and the mode move
    // now, and the override facts (`configured`) stay as the host last reported
    // them. A failure restores the whole view.
    if (previous !== undefined) {
      this.host.mutate({
        approvalDeadlines: {
          ...previous,
          ...(payload.permissionTimeoutMs === undefined ? {} : { permissionTimeoutMs: payload.permissionTimeoutMs }),
          ...(payload.mode === undefined ? {} : { mode: payload.mode }),
        },
      })
    }
    try {
      const result = await this.host.call<ApprovalDeadlinesResult>('ui/approval-deadlines-set', payload)
      this.host.mutate({ approvalDeadlines: result.deadlines })
    } catch (error) {
      this.host.mutate({ approvalDeadlines: previous })
      this.host.flashError(error)
    }
  }
}
