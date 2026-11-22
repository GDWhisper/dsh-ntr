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
  AcpDelegateAgentDefaults,
  AcpDelegateSettings,
  AcpTagHalo,
  ApprovalDeadlinesResult,
  ApprovalDeadlinesSetPayload,
  DelegateResult,
  DelegateSetPayload,
  DelegateSettingKey,
  IdleReleaseResult,
  IdleReleaseSetPayload,
  PermissionTimeoutMode,
  SkillsMcpResult,
} from '../../protocol.ts'
import {
  DEFAULT_DELEGATE_GUIDANCE,
} from '../../protocol.ts'
import type { UiState } from './state.ts'

/**
 * The built-in baseline a delegate reset falls back to OPTIMISTICALLY when the
 * config file names no value for the key. `timeoutMs` mirrors the built-in
 * global background-task long window (40 minutes); the host-reported
 * `defaultTimeoutMs` is the authority and corrects this placeholder on the
 * write's answer — the same optimistic-then-authority split the idle-release
 * card keeps. `defaultAgent` resets to "follow the global default" (undefined)
 * and `agentDefaults` to "no per-agent overrides" ({}); both keys must be
 * PRESENT here so the baseline spread clears the running override before the
 * config file's value (if any) lands on top.
 */
export const DELEGATE_DEFAULTS: Pick<AcpDelegateSettings, DelegateSettingKey> = {
  guidance: DEFAULT_DELEGATE_GUIDANCE,
  timeoutMs: 2_400_000,
  defaultAgent: undefined,
  agentDefaults: {},
}

/** Reset one key optimistically to the baseline the reset restores. */
function resetDelegateKey<K extends DelegateSettingKey>(next: AcpDelegateSettings, key: K, baseline: AcpDelegateSettings): void {
  next[key] = baseline[key]
}

/**
 * Optimistic merge of the per-agent delegation overrides: each named entry
 * REPLACES that agent's whole entry — `{}` is a valid all-default override
 * that shadows the baseline — and a `null` entry deletes it so the baseline
 * decides again (the `ui/delegate-set` contract). Absent keys keep their value.
 * The result may be an empty map; the view builder then drops the key entirely
 * (the host reports no `agentDefaults` key for an empty map).
 */
export function mergeDelegateAgentDefaults(
  current: Record<string, AcpDelegateAgentDefaults> | undefined,
  patch: Record<string, AcpDelegateAgentDefaults | null>,
): Record<string, AcpDelegateAgentDefaults> {
  const next = { ...current }
  for (const [agentId, entry] of Object.entries(patch)) {
    if (entry === null) delete next[agentId]
    else next[agentId] = entry
  }
  return next
}

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
   * Write the built-in skills MCP switch (settings page). Optimistic like
   * {@link setTitlePrefix}; a failure restores the previous value and flashes
   * the notice, so the row never claims a state the host refused to persist.
   * Deliberately NOT part of the save gate: this is not an agent save, the
   * host applies it to the sessions it creates from now on, and no process is
   * restarted.
   */
  async setSkillsMcp(value: boolean): Promise<void> {
    const previous = this.host.state().skillsMcpEnabled
    this.host.mutate({ skillsMcpEnabled: value === true })
    try {
      const result = await this.host.call<SkillsMcpResult>('ui/skills-mcp-set', { skillsMcpEnabled: value === true })
      this.host.mutate({ skillsMcpEnabled: result.skillsMcpEnabled === true })
    } catch (error) {
      this.host.mutate({ skillsMcpEnabled: previous })
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

  /**
   * Write the `acp_delegate` settings (subagent card). Only the keys the
   * patch names move; omitted keys keep their current value, so moving the
   * guidance never resets the window. Immediate RPC — not an agent save.
   */
  async setDelegateSettings(patch: DelegateSetPayload): Promise<void> {
    await this.writeDelegate(patch)
  }

  /**
   * Drop ONE persisted delegate override: the config file (or the built-in
   * default) decides again for that key alone.
   */
  async resetDelegateSetting(key: DelegateSettingKey): Promise<void> {
    await this.writeDelegate({ reset: [key] })
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

  /**
   * The one delegate write path, optimistic like {@link writeApprovalDeadlines}:
   * the value keys the payload names move now, a reset key falls back to the
   * baseline it restores, and the override facts (`configured`) plus the
   * availability facts stay as the host last reported them. The host answer —
   * the same route returns the settings now in force — is the authority; a
   * failure restores the whole previous view and flashes the notice.
   */
  private async writeDelegate(payload: DelegateSetPayload): Promise<void> {
    const previous = this.host.state().delegate
    if (previous !== undefined) {
      const next: AcpDelegateSettings = {
        ...previous,
        ...(payload.guidance === undefined ? {} : { guidance: payload.guidance }),
        ...(payload.timeoutMs === undefined ? {} : { timeoutMs: payload.timeoutMs }),
        ...(payload.defaultAgent === undefined ? {} : { defaultAgent: payload.defaultAgent }),
        ...(payload.agentDefaults === undefined
          ? {}
          : { agentDefaults: mergeDelegateAgentDefaults(previous.agentDefaults, payload.agentDefaults) }),
      }
      // The baseline a reset restores: the config file's value where it names
      // one, else the built-in default.
      const baseline: AcpDelegateSettings = { ...previous, ...DELEGATE_DEFAULTS, ...previous.configured }
      for (const key of payload.reset ?? []) resetDelegateKey(next, key, baseline)
      // Empty-map hygiene, mirroring the host view: a map with no entries is
      // NO key (`delegateSettingsView` omits it), so deleting the last entry —
      // or resetting to a baseline that names none — must not leave an
      // `agentDefaults: {}` the host would never report. A stored `{}` ENTRY
      // is a valid all-default override and keeps its key.
      if (next.agentDefaults !== undefined && Object.keys(next.agentDefaults).length === 0) delete next.agentDefaults
      // The「当前：X」display fact is derived from the override it names; keep
      // it consistent with the optimistic defaultAgent (the host answer stays
      // the authority). Only recompute when this write touches that axis.
      if (payload.defaultAgent !== undefined || (payload.reset ?? []).includes('defaultAgent')) {
        next.resolvedDefaultAgent = next.defaultAgent ?? next.globalDefaultAgent
      }
      this.host.mutate({ delegate: next })
    }
    try {
      const result = await this.host.call<DelegateResult>('ui/delegate-set', payload)
      this.host.mutate({ delegate: result.delegate })
    } catch (error) {
      this.host.mutate({ delegate: previous })
      this.host.flashError(error)
    }
  }
}
