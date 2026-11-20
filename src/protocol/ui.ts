/**
 * Settings-page preferences: the display and lifecycle knobs the panel edits and the host enforces.
 *
 * Part of the protocol contract; the barrel is `src/protocol.ts` and every
 * existing `../protocol.ts` import keeps resolving through it. Pure types,
 * constants and pure helpers only — no side effects, no Node APIs, no ACP SDK
 * runtime values (type-only SDK imports are erased at build time).
 */

/**
 * How the composer-edge agent tag shows liveness (the blue halo). `breath`
 * pulses the halo at the speed below; `steady` shows a constant glow.
 * Plugin-private display preference, persisted with the agent registry.
 */
export interface AcpTagHalo {
  mode: 'breath' | 'steady'
  speed: 'slow' | 'normal' | 'fast'
}
/** Default when nothing was ever saved: the breathing halo at normal speed. */
export const DEFAULT_TAG_HALO: AcpTagHalo = { mode: 'breath', speed: 'normal' }
/** `ui/tag-halo`: read the halo preference. */
export type TagHaloResult = { halo: AcpTagHalo }
/** `ui/tag-halo-set`: write the halo preference. */
export interface TagHaloSetPayload { halo: AcpTagHalo }

/**
 * The badge prepended to an NTR session's generated title when the settings
 * toggle is on. The title is host-owned session data (the `session/title`
 * log event), so the prefix shows everywhere the title shows: the sidebar
 * row, the conversation header, and search results. Kept ASCII-short so the
 * placeholder's own budget stays intact.
 */
export const SESSION_TITLE_PREFIX = '[NTR] '
/** Default when nothing was ever saved: on, so titles carry the [NTR] prefix. */
export const DEFAULT_SESSION_TITLE_PREFIX = true
/** `ui/session-title-prefix`: read the toggle in force. */
export type SessionTitlePrefixResult = { titlePrefix: boolean }
/** `ui/session-title-prefix-set`: write the toggle. */
export interface SessionTitlePrefixSetPayload { titlePrefix: boolean }

/**
 * `ui/skills-mcp`: whether the built-in read-only `dsh-skills` MCP server is
 * offered to agents. Default off; the answer is the value the host would use
 * for the NEXT session it creates (the switch never touches a live process).
 */
export type SkillsMcpResult = { skillsMcpEnabled: boolean }
/** `ui/skills-mcp-set`: write the switch. Strictly a boolean, strict persist. */
export interface SkillsMcpSetPayload { skillsMcpEnabled: boolean }

/** The approval deadline the settings page can edit, by field name. ONE window. */
export type ApprovalDeadlineKey = 'permissionTimeoutMs'

/**
 * The idle-release windows the settings page offers, in MILLISECONDS.
 *
 * ONE ladder, shared by both halves: the browser snaps its slider to these
 * values and the host accepts only these values, so a window the slider can
 * produce is always a window the host runs. The first rung is 1 minute (an
 * aggressive release), the rest are 5-minute steps up to an hour.
 */
export const IDLE_RELEASE_MS: readonly number[] = [
  60_000, 300_000, 600_000, 900_000, 1_200_000, 1_500_000, 1_800_000, 2_100_000, 2_400_000, 2_700_000, 3_000_000, 3_300_000, 3_600_000,
]

/**
 * The built-in idle-release window for chat processes: 30 minutes.
 *
 * Lives beside the ladder it is a rung of, so the two cannot drift: a
 * deployment that names no window of its own runs this, and the settings
 * page's reset returns to it.
 */
export const DEFAULT_IDLE_TIMEOUT_MS = 1_800_000

/**
 * The idle-release window for chat processes, as the settings page edits it.
 *
 * The window is the HOST default: an agent that names its own
 * {@link AcpAgentDef.idleTimeoutMs} keeps it, and a probe-only process (one
 * that never hosted a session) still honors the short probe window — see
 * `AGENTS/protocol.md` §5.
 */
export interface AcpIdleRelease {
  /** The window in force, in ms. */
  idleTimeoutMs: number
  /**
   * The window a RESET returns to: the deployment baseline when the config
   * file names one, else the built-in default (30 minutes).
   */
  defaultIdleTimeoutMs: number
  /**
   * The window `cordis.patch.yml` names, when it names one. Reported only
   * when the file actually names one: the settings card must not say "the
   * file asks for 30 minutes" about a file that says nothing.
   */
  configuredIdleTimeoutMs?: number
}
/** `ui/idle-release`: read the idle-release window in force. */
export type IdleReleaseResult = { idleRelease?: AcpIdleRelease }
/**
 * `ui/idle-release-set`: write the idle-release window, or drop the persisted
 * override with `reset` so the built-in default applies again.
 */
export interface IdleReleaseSetPayload {
  /** The window to run, in ms; omitted when `reset` is true. */
  idleTimeoutMs?: number
  /** Drop the persisted override so the built-in default applies again. */
  reset?: boolean
}

/**
 * What an EXPIRED approval deadline does. Three modes, and only three — an
 * unanswered ask either gets answered for you, keeps waiting, or is refused.
 *
 * - `abort`: answer `cancelled`. The operation is refused and the agent
 *   continues with that answer.
 * - `auto`: answer the ask with the option the AGENT's own kinds imply
 *   (`allow_always` → `allow_once` → `reject_once` → `reject_always` → the
 *   first option), and the agent CONTINUES executing. This is unattended
 *   operation: the plugin may end up approving something nobody looked at,
 *   which is why it is opt-in and why the outcome is announced.
 * - `wait` (default): never expire. The ask stays pending, visibly, until a
 *   human answers it or the session is cancelled.
 *
 * Same three modes as OmniTerm dev's `acp_perm_timeout_mode`, under the same
 * names. The plugin's own default is `wait`, not `abort` and not `auto`: a
 * permission ask is a question for a human, so the safe default is to keep
 * waiting rather than to refuse (or worse, approve) on their behalf.
 */
export type PermissionTimeoutMode = 'abort' | 'auto' | 'wait'

/**
 * What the settings page's approval-deadline card shows: the values in force,
 * plus the facts that explain why a value the user did not pick is winning.
 *
 * `configured` is present only when `cordis.patch.yml` names a key — a settings
 * override outranks it, and the card must say so rather than silently showing
 * the override. `configuredMode` is the same fact about the mode.
 */
export interface AcpApprovalDeadlines {
  /**
   * The one wait window, in ms. `0` means 不等待 — the ask is settled on
   * arrival, without asking anyone, and only the `auto` mode runs it.
   * Never expiring is the `mode`'s business.
   *
   * It covers BOTH places an ask can live (the conversation's approval card
   * and the settings panel's ledger): one question, one answer, one number.
   */
  permissionTimeoutMs: number
  /** What an expired deadline does. Always present: `wait` is the default. */
  mode: PermissionTimeoutMode
  /** The config-file value for the window, when the file names one. */
  configured?: Partial<Record<ApprovalDeadlineKey, number>>
  /** The config-file baseline for `mode`, when the file names one. */
  configuredMode?: PermissionTimeoutMode
}
/**
 * `ui/approval-deadlines`: read the deadlines in force. `deadlines` is absent
 * on a host half from before the card existed, which hides the card rather than
 * showing a number the browser invented.
 */
export type ApprovalDeadlinesResult = { deadlines?: AcpApprovalDeadlines }
/**
 * One write to the approval-deadline settings: the window, and the mode.
 * Omitted keys keep their current value — a card that only moved the mode
 * must not reset the number.
 */
export interface ApprovalDeadlinePatch {
  permissionTimeoutMs?: number
  mode?: PermissionTimeoutMode
}
/**
 * `ui/approval-deadlines-set`: write the deadline, or the mode.
 * `reset: true` drops the persisted override so the `cordis.patch.yml`
 * baseline (or the built-in default) applies again.
 */
export interface ApprovalDeadlinesSetPayload extends ApprovalDeadlinePatch {
  reset?: boolean
}

/**
 * The delegation guidance rungs the settings page offers, in order of how
 * strongly the `acp_delegate` tool's description steers the model toward it.
 *
 * ONE ladder, shared by both halves (the same discipline as
 * {@link IDLE_RELEASE_MS}): the browser offers only these four rungs and the
 * host accepts only these four. The guidance rung doubles as the REGISTRATION
 * switch — `off` means the tool is not registered at all (a clean request
 * header: the native model never sees the capability), `on` registers the base
 * description, `enhanced` appends a MUST sentence (a soft constraint), and
 * `force` additionally masks the host's native delegation tools per agent.
 * There is no separate `enabled` key: one truth, one knob.
 */
export const DELEGATE_GUIDANCE = ['off', 'on', 'enhanced', 'force'] as const
export type DelegateGuidance = (typeof DELEGATE_GUIDANCE)[number]

/**
 * The session-level policy shape a delegation runs under — the ONE
 * authoritative definition, shared by the delegate service, `LiveSession`, the
 * RPC seam and the manager. A delegation ALWAYS runs `{auto, 0}` (answer on
 * arrival, the agent continues); there is no permission-mode knob. It is set
 * on the delegated `sessionId` BEFORE the prompt and never writes a
 * bridge-level field, so the main conversation's approval settings stay
 * byte-for-byte. `preferOnce` asks the auto answer to prefer `allow_once` over
 * `allow_always` on a shared (non-A1) process, where an `allow_always` memory
 * could leak into the main session's later asks.
 */
export interface AcpDelegatePolicy { mode: PermissionTimeoutMode; windowMs: number; preferOnce?: boolean }

/**
 * The delegate-only `startSession` options — the ONE authoritative shape shared
 * by the delegate service's host seam, the manager and the RPC service. The
 * `/acp` RPC face never passes them: without opts the legacy path runs verbatim
 * (roots-only fence, no spawn alignment). With opts the cwd is validated BEFORE
 * any process starts, so a refused cwd never spawns a throwaway child.
 *
 * `extraRoots` are roots trusted for THIS session only, on top of the agent's
 * `allowedCwdRoots` — the same authorization the chat path uses: the calling
 * DSH session's workspace is a directory the USER picked, never a root the
 * model invented. `alignSpawnCwd` additionally runs the agent PROCESS in the
 * validated session cwd (agents like codebuddy fix their workspace at spawn).
 */
export interface AcpStartSessionOpts {
  extraRoots?: readonly string[]
  alignSpawnCwd?: boolean
}

/** Built-in default: off — no deployment's request header changes by default. */
export const DEFAULT_DELEGATE_GUIDANCE: DelegateGuidance = 'off'

/**
 * The single-delegation window bounds, in MILLISECONDS — the ONE source shared
 * by the host validator (`validateDelegateMs`), the persisted-read filter
 * (`SettingsService.loadPersistedSettings`) and the browser's minute-input
 * guard. 1 second … 24 hours. The built-in DEFAULT is deliberately NOT a
 * constant here: it follows the global background-task long window (see
 * `SettingsService.delegateSettings` / {@link AcpDelegateSettings.defaultTimeoutMs}).
 */
export const DELEGATE_TIMEOUT_MIN_MS = 1_000
export const DELEGATE_TIMEOUT_MAX_MS = 86_400_000

/** The delegate setting a write may name, by field name. */
export type DelegateSettingKey = 'guidance' | 'timeoutMs'

/**
 * What the settings page's delegation card shows: the values in force, plus
 * the facts that explain why a value the user did not pick is winning.
 *
 * `configured` is present only for keys `cordis.patch.yml` actually names — a
 * settings override outranks the baseline, and the card must say so rather
 * than silently showing the override. `toolAvailable` / `restrictAvailable`
 * report whether the host offers tool registration / per-agent masking: when
 * false, the card says the switch cannot take effect instead of pretending
 * the request header changed.
 */
export interface AcpDelegateSettings {
  guidance: DelegateGuidance
  timeoutMs: number
  /**
   * The window a RESET returns to: the deployment baseline when the config
   * file names one, else the global background-task long window (the built-in
   * default — the same split {@link AcpIdleRelease.defaultIdleTimeoutMs} keeps).
   */
  defaultTimeoutMs: number
  /** Deployment baseline facts: only keys cordis.patch.yml actually names. */
  configured?: Partial<Pick<AcpDelegateSettings, DelegateSettingKey>>
  toolAvailable: boolean
  restrictAvailable: boolean
}
/**
 * `ui/delegate`: read the delegation settings in force. `delegate` is absent
 * on a host half from before the card existed, which hides the card rather
 * than showing a number the browser invented.
 */
export type DelegateResult = { delegate?: AcpDelegateSettings }
/**
 * `ui/delegate-set`: write delegation settings. Omitted keys keep their
 * current value — a card that only moved the guidance must not reset the
 * window. `timeoutMs` accepts any integer in [1000, 86400000]; the guidance
 * rungs are the whole vocabulary.
 */
export interface DelegateSetPayload {
  guidance?: DelegateGuidance
  timeoutMs?: number
  /** Drop the persisted overrides for these keys; baseline/default decides again. */
  reset?: readonly DelegateSettingKey[]
}
