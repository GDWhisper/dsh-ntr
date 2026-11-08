/**
 * ACP client bridge: one child process per configured agent definition,
 * multiplexing any number of ACP sessions over the stdio connection.
 *
 * The browser NEVER reaches this layer directly; it goes through the `/acp`
 * Connection RPC channel (authenticated) into `BridgeManager`, which is the
 * only object allowed to spawn a configured command.
 */

import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { homedir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Writable, Readable } from 'node:stream'
import { accessSync, constants, copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs'
import {
  client,
  methods,
  ndJsonStream,
  PROTOCOL_VERSION,
  RequestError,
  type ClientConnection,
  type ContentBlock,
  type InitializeResponse,
  type McpServer,
  type McpServerHttp,
  type McpServerSse,
  type McpServerStdio,
  type PermissionOption,
  type RequestPermissionResponse,
  type SessionNotification,
  type SessionUpdate,
} from '@agentclientprotocol/sdk'
import {
  AcpError,
  EventHub,
  PermissionLedger,
  Transcript,
  acpToolCallDelta,
  acpToolCallFromUpdate,
  buildAdapterModelId,
  childEnv,
  hasUnambiguousModelSelector,
  isAcpToolContinuation,
  isFinalToolCallStatus,
  isUnderPath,
  mergeCatalogShape,
  parseCatalogOptions,
  usableConfigOptions,
  permissionToolKind,
  permissionRequestFrame,
  pickAutoOption,
  quoteCommandToken,
  randomUUID,
  resolveFsPath,
  resolveSessionCwd,
  selectForwardPrompt,
  skillFlavorOf,
  extractSessionTitlePlaceholder,
  isAbsolutePath,
  acpPresetStatusFromRoster,
  splitAdapterModelId,
  updateContentToText,
  describeUnhandledUpdate,
  BOOKKEEPING_UPDATES,
  validateAgentDef,
  validateTagHalo,
  validateApprovalDeadlines,
  validatePermissionTimeoutMode,
  normalizeApprovalWindow,
  agentSaveAction,
  normalizeSubagentRecordMap,
  capSubagentRecords,
  boundSubagentDetailEntry,
  subagentToolCallId,
} from './impl.ts'
import type {
  AcpToolCallSnapshot,
  PendingPermissionView,
  RosterPresetRow,
} from './impl.ts'
import type {
  AcpAgentCatalog, AcpAgentDef, AcpApprovalDeadlines, AcpConversationChoice, AcpEvent, AcpMcpServerDef, AcpPresetStatus, AcpReleaseCause, AcpTagHalo, AgentCatalogResult, AgentProbeModelsResult, AgentRefusalDetail, AgentSaveMode, AgentSaveResult, AgentSkillsResult, AgentTestFailureKind, AgentTestResult, AgentView, ChatSessionForkInfo, ChatSessionView, ChatTranscriptView, DetectedAgentInfo, GenerateOptions, LlmAdapterLike,
  LlmModelInfo, LlmModelReasoningInfo, LlmProviderInfo, LlmReasoningEffortInfo, LlmResolvedModelInfo,
  AcpIdleRelease, ActiveTurnView, ApprovalDeadlineKey, ApprovalDeadlinePatch, PermissionOutcome, PermissionOptionView, PermissionTimeoutMode, PluginReleaseNotes, PluginUpdateState, PreparedAdapterCall, SaveGateFlushResult, SaveGateStatus, SessionView, StreamChunk,
  SubagentDetailEntry, SubagentDetailResult, SubagentRecord, SubagentStatus,
} from './protocol.ts'
import { DEFAULT_IDLE_TIMEOUT_MS, DEFAULT_SAVE_GATE_TIMEOUT_MS, DEFAULT_SESSION_TITLE_PREFIX, DEFAULT_TAG_HALO, IDLE_RELEASE_MS, MAX_SUBAGENT_DETAIL_ENTRIES, MAX_SUBAGENT_RECORDS, SESSION_TITLE_PREFIX, pluginReleaseUrl } from './protocol.ts'
import type { AcpSaveGate } from './save-gate.ts'
import { SaveGateAborted } from './save-gate.ts'
import { OUTPUT_CHARS_PER_TOKEN, TurnTpsTracker } from './tps.ts'
import { scanSkillDirs } from './skills-scan.ts'
import { UpdateService } from './update.ts'

/**
 * Version of this installed package, read from the shipped `package.json` —
 * one level above both `src/` at test time and `lib/` at runtime. The settings
 * badge and the ACP handshake's `clientInfo` both report it; a copied literal
 * would go stale on every release.
 */
export const PLUGIN_VERSION: string = (() => {
  try {
    const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf-8')) as { version?: unknown }
    return typeof manifest.version === 'string' ? manifest.version : ''
  } catch {
    return ''
  }
})()

const STDERR_TAIL_LINES = 40
/** Single fs/read_text_file answer cap — agents reading huge files must page via `line`/`limit`. */
const FS_MAX_READ_BYTES = 2 * 1024 * 1024
/** Single fs/write_text_file payload cap. */
const FS_MAX_WRITE_BYTES = 2 * 1024 * 1024
/**
 * How long a stop waits for the agent to answer `session/close` before killing
 * the child anyway. The capability is optional and the LOCAL teardown is what
 * actually frees the session, so a wedged agent must not be able to hang a
 * stop — and with it the stall reclaim that calls it — forever.
 */
const SESSION_CLOSE_TIMEOUT_MS = 5_000

/** How long one `agent/skills` scan answer stays fresh; the browser re-asks past it. */
const SKILL_SCAN_TTL_MS = 60_000
/** Cached `agent/skills` answers (agent × workspace), evicted oldest-first. */
const SKILL_SCAN_CACHE_MAX = 32

/**
 * The second — and last — slice after the escalation kill (`SIGKILL` on POSIX,
 * a second `taskkill /T /F` on Windows). Deliberately short: past this point
 * the child is the OS's problem (plus the exit reaper, see `reapLiveChildren`).
 *
 * `disposeChild` RESERVES this inside the budget it is handed, so every caller's
 * number means the WHOLE disposal — graceful wait plus escalation wait — and
 * never just the first one.
 */
const KILL_ESCALATION_GRACE_MS = 500

/**
 * Fire-and-forget kill: the whole disposal budget for the non-teardown paths
 * (see `KILL_ESCALATION_GRACE_MS` for how it splits). Same 3s the old inline
 * SIGKILL timer used before escalating.
 */
const KILL_ESCALATION_DELAY_MS = 3_000

/**
 * Budget for disposing a child whose start was invalidated by a teardown (see
 * `AgentBridge.spawnAndConnect`). Short: that child was spawned moments ago and
 * never served anything, so there is nothing to drain.
 */
const STALE_START_KILL_BUDGET_MS = 2_000

/**
 * How long `BridgeManager.testAgent` waits for a failed start's child to report
 * its `exit` before writing the verdict (see `AgentBridge.awaitStartChildExit`).
 * A process that is already gone reports in microseconds; this only bounds the
 * pathological case, and it delays a user-visible answer, so it stays small.
 */
const TEST_EXIT_GRACE_MS = 250

/**
 * The WHOLE host-shutdown budget for killing children, shared by every bridge
 * (bridges run concurrently, so this is the worst case for all of them, not
 * per bridge). One number, one deadline: `AgentBridge.shutdown` hands what is
 * LEFT of it to `killChildAndWait`, and `disposeChild` reserves the escalation
 * grace inside that — so the graceful wait gets at most 4s − 500ms and the
 * whole disposal, escalation included, never exceeds 4s.
 */
const SHUTDOWN_BUDGET_MS = 4_000

/**
 * A1: agents whose ACP host keeps exactly ONE `currentSession` per stdio
 * connection. CodeBuddy is the only one today — `session/new` / `session/load`
 * replace its connection-wide session and stop the previous one, so every DSH
 * conversation needs its own child process. Every other agent multiplexes any
 * number of sessions over one process and stays on the agent-wide bridge.
 */
export const PER_SESSION_AGENT_IDS: ReadonlySet<string> = new Set(['codebuddy'])

/** True when this agent gets one child process per DSH session (A1). */
export function isPerSessionAgent(agentId: string): boolean {
  return PER_SESSION_AGENT_IDS.has(agentId)
}

/** Which process one `AgentBridge` serves (per-session agents only; all others are `agent`). */
export type BridgeScope =
  /** Non-A1: the single process configured for the agent. */
  | { kind: 'agent' }
  /** A1: one DSH chat conversation. */
  | { kind: 'chat'; dshSessionId: string }
  /** A1: a `/acp` RPC session (its own token) or the anonymous turn bucket. */
  | { kind: 'ephemeral'; token: string }
  /** A1: the throwaway child a model / config probe opens. */
  | { kind: 'probe' }

/**
 * The `bridges` key for one agent + scope. A non-per-session agent folds every
 * scope onto the bare agent id, so its map keeps exactly one entry and every
 * existing lookup stays byte-for-byte the same. A per-session agent keeps a
 * distinct key per scope; the NUL separator cannot collide with an agent id or
 * a DSH session id. `probe` carries no token — it is one fixed child per agent.
 */
export function bridgeKey(agentId: string, scope: BridgeScope): string {
  if (!isPerSessionAgent(agentId)) return agentId
  switch (scope.kind) {
    case 'agent': return `${agentId}\u0000agent`
    case 'chat': return `${agentId}\u0000chat:${scope.dshSessionId}`
    case 'ephemeral': return `${agentId}\u0000ephemeral:${scope.token}`
    case 'probe': return `${agentId}\u0000probe`
  }
}

/**
 * Drop the fixed `--port` CodeBuddy's ACP mode tries to bind: every per-session
 * child would race for `127.0.0.1:6156` (`EADDRINUSE`), and stdio needs no
 * listener at all. Both `--port <value>` and `--port=<value>` are removed; a
 * non-per-session agent keeps its arguments byte-for-byte (new array, same
 * entries — the caller's array is never mutated).
 */
export function perSessionLaunchArgs(args: readonly string[], agentId: string): string[] {
  if (!isPerSessionAgent(agentId)) return [...args]
  const kept: string[] = []
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--port') {
      index += 1 // ...and the value that follows it
      continue
    }
    if (arg.startsWith('--port=')) continue
    kept.push(arg)
  }
  return kept
}

/**
 * The same for the environment: a per-session child must not inherit an agent
 * config that pins `SERVER__PORT` / `SERVER__HOST` (the EADDRINUSE above). The
 * lookup is case-insensitive because Windows env names are, so a `server__port`
 * written in lowercase is removed too. Non-per-session agents get the input
 * object back untouched; a per-session agent gets a new object and never
 * mutates the caller's.
 */
export function perSessionLaunchEnv(env: Record<string, string>, agentId: string): Record<string, string> {
  if (!isPerSessionAgent(agentId)) return env
  const kept: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    const upper = key.toUpperCase()
    if (upper === 'SERVER__PORT' || upper === 'SERVER__HOST') continue
    kept[key] = value
  }
  return kept
}

/** What the composer showed for an agent before a conversation picked it. */
interface DisplayedChatDefaults {
  modelId?: string
  effort?: string
  /** The agent's last-known mode (the composer's select without a pick). */
  mode?: string
  extraConfigs?: Record<string, string | boolean>
}

interface LiveSession {
  /** Host-minted id (stable across an agent restart; the ACP id is per-connection). */
  sessionId: string
  agentId: string
  acpSessionId: string
  cwd: string
  title?: string
  /**
   * The adapter model id this session was last aligned to (`agentId` /
   * `agentId@choice`). Recorded here so the browser can show "which model is
   * this conversation on" from `session/chat-list` alone — the plugin's own
   * binding, not a DSH model route.
   */
  modelId?: string
  /** The model choice portion of {@link modelId}, when it carries one. */
  choice?: string
  /** The reasoning effort in force for this session, when one applies. */
  reasoningEffort?: string
  modes?: SessionView['modes']
  configOptions?: unknown[]
  availableCommands?: SessionView['availableCommands']
  plan?: unknown[]
  usage?: SessionView['usage']
  /**
   * The plugin's own measurable burst aggregate over this ACP session's turns
   * (see `src/tps.ts`). Persisted with the chat-session record so the dock's
   * rate survives a host restart; absent until a turn contributes a measurable
   * burst (>= 1 inter-chunk gap).
   */
  burst?: SessionView['burst']
  running: boolean
  /**
   * The HOST's prompt slot for this session: true from the moment a turn
   * starts until the agent answers it (or the host aborts the turn, or the
   * turn is discarded). Together with the {@link settled} gate — which STAYS
   * claimed after an abort until the agent acknowledges the cancel — this is
   * what `claimTurn` arbitrates, NOT `running`.
   *
   * The three are deliberately different:
   * - an ambient wait keeps `running` true (the background drain is still the
   *   session's work, so nothing may release the process) while this slot is
   *   already FREE (the agent answered; only the drain keeps talking);
   * - an aborted turn drops THIS flag at once (our face of the turn ends) but
   *   leaves `settled` in place, so the next prompt still waits out
   *   `turnSettleMs` for the agent instead of racing a concurrent prompt.
   */
  promptInFlight?: boolean
  closed: boolean
  /** The agent process died; the session awaits a `session/load` resume. */
  released: boolean
  /**
   * The agent-side session has history while the LOCAL buffer is empty: this
   * record was restored from disk after a host restart (the replay has not
   * landed yet), or a resume cleared the buffer ahead of the replay. The ACP
   * view then says history replays on restore instead of "nothing yet". Set
   * by `doResumeSession` (captured before the reset) and the restore path; the
   * serializer ORs it with the live buffer length.
   */
  hasHistory?: boolean
  /**
   * When the agent last showed ANY sign of life on this session: an update, a
   * permission ask (arrival or answer), or a turn start. The stall watchdog
   * measures silence from here rather than from the prompt, which may
   * legitimately be followed by a long tool run.
   */
  lastAgentActivityAt: number
  /**
   * Tool calls the agent announced and has not finished, by ACP `toolCallId`.
   * A SET, not a flag: parallel calls finish independently, and one sibling's
   * `completed` must not clear the long tool window while another is still
   * running. Non-empty = the agent is working on its own clock.
   */
  activeToolCalls: Set<string>
  /**
   * Owning DSH chat session id, when the session was opened through the LLM
   * adapter (`AcpLlmAdapter`). It is what the conversation's permission card
   * filters on (`permission/request.dshSessionId`); sessions started over the
   * `/acp` RPC have no chat session, so their asks stay on the settings panel.
   */
  dshSessionId?: string
  /**
   * True when this chat session runs on the ACP-mode agent preset, re-resolved
   * every turn. It is a report for the browser surfaces (which conversation are
   * we in), not a policy switch: an ACP agent decides its own permissions, so
   * the host arbitrates nothing (see docs/acp-convergence.md §2.3).
   */
  acpMode?: boolean
  /**
   * Resolves when the AGENT has settled the turn it is currently running (its
   * `session/prompt` response, or its acknowledgement of a cancel). This is
   * deliberately not `running`: an aborted turn ends our stream at once,
   * while the agent keeps working until it observes the cancel — and the ACP
   * protocol forbids a second `session/prompt` on a busy session.
   */
  settled?: Promise<void>
  /**
   * The resolver of {@link settled}, kept alongside so turn-scoped force
   * finalization (the cancel fallback) can open the gate without owning the
   * stream. Cleared by the same settler that clears {@link settled}.
   */
  settledResolve?: () => void
  /**
   * This session's first turn wrote the conversation's agent lock just now
   * (the conversation had none before). The lock is provisional until that
   * turn produces a visible block: a first turn that delivers nothing — an
   * error, a silent provider failure folded into a normal stop, or even a
   * cancel — rolls the lock back and closes this session, so the user can
   * choose another agent. Cleared as soon as the first turn settles.
   */
  provisionalLock?: boolean
  /**
   * Monotonic per-session counter, bumped at every turn start (both the
   * `/acp` RPC path and the adapter's `streamPrompt`). Turn-scoped timers —
   * the cancel fallback — capture it when armed and compare when they fire:
   * a timer whose generation has moved on belongs to a turn that already
   * ended, and must not force-finalize the LATER turn now on air.
   */
  turnSeq: number
  /**
   * The {@link turnSeq} of the turn `session/cancel` was last called for.
   * A `cancelled` stopReason on a turn whose generation does not match is
   * not the user's cancel: some agents answer the NEXT prompt with the
   * PREVIOUS cancel while still cleaning up (the stale-cancel swallow), and
   * that answer means the message was silently dropped.
   */
  cancelRequestedAtTurn?: number
  /**
   * The {@link turnSeq} of a turn the stall watchdog force-finalized while the
   * agent still held its `session/prompt`. The agent is presumed wedged, so the
   * NEXT prompt reclaims the process (`BridgeManager.prepareStalledSession`)
   * instead of queueing behind a turn that may never answer. Cleared when the
   * late response lands or when the reclaim replaces the process.
   */
  orphanPromptTurnSeq?: number
  /**
   * The {@link turnSeq} of a turn a reclaim (`prepareStalledSession`) ended by
   * closing the connection while the agent still held its `session/prompt`.
   * The close rejects that request, and the caller's catch would broadcast a
   * second `turn/end` for a turn already finalized: this marker tells the
   * late `then`/`catch` to drop the answer instead. Set by the reclaim, cleared
   * when that answer lands, at every new turn start, and by a resume.
   */
  reclaimedTurnSeq?: number
  /**
   * The controller of the turn currently streaming through this session.
   *
   * Chat turns are ALSO indexed by chat id ({@link BridgeManager}'s
   * `turnStreams`) because their continuation steps arrive as fresh
   * `streamPrompt` calls that look the turn up by chat id. An EPHEMERAL turn
   * (`options.sessionId === undefined`) has no chat id to index under, so this
   * attachment is the only way the stall watchdog can find its controller —
   * without it a silent ephemeral turn falls into the `/acp` branch, which
   * leaves the driver's segment queue open instead of finishing it. Cleared by
   * the controller's own `retire` when it still points at it.
   */
  turnController?: TurnStreamController
  /**
   * A background turn the agent started on its OWN initiative (CodeBuddy's
   * multitask drains: a sub-agent completion notice starts a run the client
   * never asked for). Its first `session_info_update` announces the request id
   * every later update of that run carries in `_meta`; a `session/prompt`
   * answered instantly with no conversation request id was folded into this
   * drain and its real answer arrives as the drain's updates.
   *
   * Only lifetime events clear it (close / release / resume / stop): a drain
   * may outlive the turn that was steered into it, and clearing on a normal
   * settle would misclassify the NEXT steered prompt.
   */
  ambient?: AmbientTurn
  /**
   * Request ids whose `agent/notice` already went out, so a repeated
   * announcement of the same background run is not logged twice.
   */
  ambientNotices?: Set<string>
  /**
   * Background drains this session already STOPPED waiting on (an ambient wait
   * that closed on silence, or a record that outlived `ambientStaleMs`). The
   * record is gone from {@link ambient}, but the drain itself may still be
   * running: a queued message or a long tool makes it speak again while the
   * NEXT turn is on air. Without this list the late text would teach that turn
   * the drain's id (`noteTurnRequestId` / `adoptTurnRequestId`) and fold the
   * background run's answer into the user's answer (a double answer).
   *
   * An update or re-announcement carrying a listed id REVIVES it
   * (`reviveAmbientId` + a rebuilt {@link ambient}): the run is alive, so its
   * next steered prompt must receive the drain's text. Only while the record
   * stays retired is its text transcript-only. Timestamps let the zero-output
   * report recognise a prompt folded into a recently quieted drain
   * (`hasRecentRetiredAmbient`). Bounded ({@link RETIRED_AMBIENT_MAX}), oldest
   * evicted first; every lifecycle boundary clears the list
   * (`clearAmbientState`).
   */
  retiredAmbients?: RetiredAmbient[]
  /**
   * The agent's last rate-limit refusal on this session, and when it landed.
   *
   * CodeBuddy answers a rate-limited prompt with a RESOLVED response
   * (`stopReason: 'refusal'`, the reason in the response `_meta`), so nothing
   * in the turn itself says the conversation stopped for a quota the user can
   * wait out or switch models for. The composer's dock card reads this through
   * `snapshot()`; the `at` timestamp stays here and never reaches the view.
   *
   * BOTH prompt planes write it — the chat adapter's `streamPrompt` and the
   * `/acp` RPC's `prompt` — because one LiveSession can be driven from either,
   * and a banner that survives the answer that disproved it is a lie.
   *
   * TRANSIENT by design: the next non-limited response clears it, and so does
   * every lifecycle boundary (`clearAmbientState`: close / release / resume /
   * force reset). It is deliberately NOT part of `PersistedChatSession` — a
   * quota from a previous host run says nothing about this one.
   *
   * `at` stamps when the refusal landed and nothing expires the record from
   * it: the reset time the agent reports is prose inside `message`, and
   * guessing a timestamp out of that would invent a policy the agent never
   * stated. The record clears on EVIDENCE instead (the next answer that is not
   * rate-limited, or a lifecycle boundary), which is also why an idle release
   * bounds how long a stale banner can sit on a live session.
   */
  quotaRefusal?: { message: string; at: number }
  /**
   * Detached workers this session dispatched that may still run after the
   * turn that dispatched them CLOSED. Session-level on purpose: the worker's
   * completion / drain frames arrive after that turn's controller retired,
   * and the idle clock must see the pending work so a release cannot kill the
   * agent out from under it.
   */
  backgroundDispatches?: Map<string, BackgroundDispatch>
  transcript: Transcript
}

/** One unsolicited (background) turn the agent is running, as announced in `_meta`. */
interface AmbientTurn {
  /** `codebuddy.ai/requestId` of the drain; every update of the run carries it. */
  requestId: string
  startedAt: number
  /**
   * When this drain last showed any sign of life (announcement or an update
   * carrying its request id). {@link BridgeTuning.ambientStaleMs} expires the
   * record from here, so a drain that died silently does not capture a later
   * normal turn as steered.
   */
  lastActivityAt: number
  /** Whether the drain already streamed prose (text or thought) into the transcript. */
  sawOutput: boolean
}

/** A drain id the session stopped waiting on, and when it was retired. */
interface RetiredAmbient {
  requestId: string
  /**
   * When the wait was retired. `hasRecentRetiredAmbient` uses it to tell a
   * prompt folded into a just-quieted drain from one that ended on its own;
   * `adoptTurnRequestId` / `noteTurnRequestId` ignore the id at any age.
   */
  retiredAt: number
}

/** Reliability tuning, threaded from `AcpPluginConfig` through the manager. */
export interface BridgeTuning {
  startupTimeoutMs?: number
  /**
   * How long a permission ask may sit unanswered before the deadline fires.
   *
   * ONE window for every ask. Every ask is broadcast as `permission/request`
   * and answered from the conversation's dock card; an `/acp`-RPC ask has no
   * conversation, so the settings page mirrors the same ask as its answer
   * entry. One question, one window: "is anyone there?" gets the same answer
   * wherever the card is rendered, and two numbers made the settings card look
   * like two unrelated knobs.
   *
   * `0` means 不等待, not "wait forever": `auto` settles the ask on arrival,
   * `abort` floors the window to the shortest real wait (refusing every ask on
   * arrival is a brick wall, not a timeout), and `wait` ignores the window
   * entirely.
   *
   * The deadline is what keeps a turn from hanging on a question nobody
   * answers: the card stays visible, but an unattended session would otherwise
   * wait indefinitely. Past the deadline the ask is settled IN PLACE — never
   * relocated: `abort` refuses it, `auto` answers it with the option the
   * agent's own kinds imply (broadest grant first), and `wait` never expires
   * it at all.
   *
   * Default 300000 ms. OmniTerm's equivalent is its reaper's permission-timeout
   * threshold (30 min default, 30 s steps, hot-updatable).
   */
  permissionTimeoutMs?: number
  /**
   * What an EXPIRED approval deadline does. `wait` (default) never expires
   * the ask at all; `abort` refuses it; `auto` answers it with the option the
   * agent's own kinds imply and lets the agent continue.
   *
   * Three values, and only three: an unanswered ask is either answered for
   * you, kept waiting, or refused. Same vocabulary as OmniTerm dev's
   * `acp_perm_timeout_mode`.
   *
   * The default is `wait`: a permission ask is a question FOR A HUMAN, and
   * refusing it because the human looked away from the tab is worse than
   * waiting — the ask stays visible the whole time, so nobody is left
   * wondering what happened to it. `abort` and `auto` are opt-in for the
   * deployments that would rather have a bounded turn.
   */
  permissionTimeoutMode?: PermissionTimeoutMode
  cancelFallbackMs?: number
  /**
   * How long to wait before resending a prompt the agent answered `cancelled`
   * although no cancel was requested for that turn — the stale-cancel swallow
   * (codebuddy answers the NEXT prompt with the PREVIOUS cancel while it is
   * still cleaning up). The delay must outlast the agent's cleanup window;
   * measured at 250ms on codebuddy 2.161.4, so the default is 600ms.
   */
  staleCancelRetryDelayMs?: number
  /** How many times a stale-cancelled prompt is resent before giving up. */
  staleCancelMaxRetries?: number
  /**
   * How long a new turn waits for the agent to settle a predecessor that is
   * still running on its side (an aborted turn we already stopped streaming).
   * Zero disables the wait: the next prompt then fails immediately rather than
   * racing a concurrent `session/prompt` into the agent.
   */
  turnSettleMs?: number
  /**
   * How long a turn may stay SILENT — no update, no ask, no turn start — before
   * the watchdog force-finalizes it as stalled. The turn is only watched while
   * the agent is the one holding the floor (a segment on air, no pending ask),
   * and the process survives: the next message reclaims it.
   *
   * `0` disables the watchdog.
   */
  turnStallMs?: number
  /**
   * The longer silence window used while an ACP tool call is in progress: the
   * agent runs the tool on its own clock, so the plain turn window would call
   * a healthy long-running tool stalled. `0` falls back to `turnStallMs`.
   */
  turnStallToolMs?: number
  /** How often the watchdog scans for silent turns. */
  turnStallTickMs?: number
  /**
   * Default idle-release window for agents without their own
   * `AcpAgentDef.idleTimeoutMs`: a READY process that holds no live session
   * and has no work in flight is killed after this long. `0` disables it.
   */
  idleTimeoutMs?: number
  /**
   * Idle-release window for a bridge that has NEVER hosted a real session —
   * i.e. a process a model-catalog probe spawned (probes bypass session
   * bookkeeping). Applies before and instead of `idleTimeoutMs`/`def.idleTimeoutMs`:
   * those express how long a CHAT process waits for its next message, which a
   * probe-only process has no stake in. `0` disables it.
   */
  probeIdleTimeoutMs?: number
  /**
   * How long an ambient wait (see `TurnStreamController.awaitAmbient`) stays
   * open after the LAST session update before the turn closes itself.
   *
   * A drain's end is its silence — the SDK's schema rejects the `session_end`
   * CodeBuddy never sends anyway — but "silence" must be measured in the
   * agent's own cadence, not in a chat-app-paced one. Measured against
   * CodeBuddy 2.179.0: the gaps between drain ticks (the
   * `model_requesting`→`model_streaming` hand-off of a real model call) run
   * 1.0–1.4s, so any window below that closes the turn BEFORE the answer
   * exists. 10s leaves room for two slow hand-offs without holding the turn
   * open for a drain that actually finished.
   *
   * Deliberately NOT keyed on an `agentPhase` idle flag: a drain goes idle
   * between queued messages too, so that signal closes the turn in the middle
   * of its own work.
   */
  ambientQuietMs?: number
  /**
   * The hard ceiling on ONE ambient wait: a background run that keeps ticking
   * for minutes without finishing must not hold the conversation's turn open
   * forever. At the ceiling the turn says where the rest of the output will
   * land and closes.
   */
  ambientMaxMs?: number
  /**
   * How long the WORKER phase of a detached-worker hold may go WITHOUT any
   * evidence from the worker (see `TurnStreamController.holdForBackgroundDispatch`):
   * the turn dispatched one or more background workers through `Agent` tool
   * calls, the agent answered the prompt, and at least one worker has not
   * reported back yet. There is still no quiet clock in the ambient sense —
   * measured against CodeBuddy 2.179.0, a detached worker's own updates are
   * 13–24s apart while it is perfectly alive — so every update naming the
   * dispatch or carrying its `parentToolCallId` PUSHES THIS WINDOW OUT. Only a
   * genuinely silent worker, or every known dispatch reporting (completed /
   * failed), ends the phase; a drain announcement is recorded but arms no
   * quiet clock before then. Once they have all reported, the drain's own
   * `ambientQuietMs` / `ambientMaxMs` windows take over.
   *
   * Default 600000 ms (10 minutes of silence, not of total runtime). This is
   * the SHORT tier: while the worker's last known state is an open tool call,
   * `backgroundTaskToolMs` applies instead.
   */
  backgroundTaskMaxMs?: number
  /**
   * The worker phase's LONG tier: how long it may go silent when the worker's
   * last known state is an OPEN tool call (`tool_call` / `tool_call_update`
   * carrying `parentToolCallId` without completed / failed). Mirrors the main
   * turn's {@link BridgeTuning.turnStallToolMs}: a worker blocked inside one
   * Bash / generation command emits no updates for minutes while it is
   * perfectly alive, and reading that as death closes the turn before the
   * report arrives.
   *
   * `0` falls back to `backgroundTaskMaxMs`. Default 2400000 ms (40 minutes).
   */
  backgroundTaskToolMs?: number
  /**
   * How long an OPEN worker tool call may stay open before the idle clock reads
   * the worker as WEDGED and allows the process to be released.
   *
   * An open call is stronger evidence of life than silence: a long build emits
   * no updates for tens of minutes. While one is open the plain silence window
   * (`backgroundTaskToolMs`) never applies; this ceiling does. `0` = no ceiling.
   * Default 7200000 ms (120 minutes).
   */
  backgroundOpenToolCeilingMs?: number
  /**
   * Optional ABSOLUTE ceiling on a detached-worker hold, both phases included.
   * `backgroundTaskMaxMs` keeps an ACTIVE worker alive indefinitely; this is
   * the emergency bound for a zombie that keeps emitting updates forever.
   * `0` disables it — the turn can then stay open as long as the worker keeps
   * proving it is alive, and the person can still steer/cancel the hold by
   * sending a message.
   *
   * Default 0 (no ceiling).
   */
  backgroundTaskCeilingMs?: number
  /**
   * How long a PARKED detached-worker hold may wait for the host to open the
   * driver step that carries the worker's report. The prompt response landed
   * between two steps (the host is about to execute the `Agent` card), and a
   * host that never opens the continuation step must not hang the turn. The
   * host normally opens it at once, so this is a safety bound, not a cadence —
   * deliberately far larger than one model hand-off.
   *
   * Default 30000 ms (30 seconds).
   */
  backgroundParkedGraceMs?: number
  /**
   * How long an announced background drain may go without ANY update before a
   * later instant prompt stops treating itself as folded into it. A drain that
   * went silent for minutes is over even though nothing told us; keeping the
   * record would misclassify the next normal turn as steered. Checked lazily
   * when a prompt response arrives (see `streamPrompt`), never on a timer.
   */
  ambientStaleMs?: number
  /**
   * Hold the turn across the WORKER phase too (the pre-2026-11 behaviour).
   *
   * Default `false`: the prompt response closes the turn, so the user keeps
   * talking while the worker runs; the report lands in the transcript / NTR
   * view. `true` keeps the whole turn open until the drain delivers the report
   * — one bubble, but the composer stays locked for the worker's whole run.
   * Only a deployment tuning key (no settings control).
   */
  backgroundHoldWorkerPhase?: boolean
}

/**
 * Resolves the workspace root of one chat session (`dshSessionId` = DSH session
 * id) — the sidebar's selected workspace, which the host's sandbox policy keeps
 * for the session. Never throws; `undefined` means "no workspace available" (an
 * `/acp`-RPC session, an unknown session, or a host without the service), and
 * the caller falls back to the agent's configured cwd.
 */
export type SessionWorkspaceResolver = (dshSessionId: string) => { workspaceRoot?: string } | undefined

/** Reports whether one DSH chat session runs the ACP-mode agent preset. */
/**
 * Whether ONE DSH chat session runs the ACP agent preset. May be async: a cold
 * session (the process restarted since its last turn) has to be read from the
 * persistence store, and only the answer is worth the wait — the asker is the
 * browser's seat gate, which polls.
 */
export type AcpModeResolver = (dshSessionId: string) => boolean | undefined | Promise<boolean | undefined>

/**
 * Report one detached ACP worker to the host's parent-owned subagent catalog.
 * Display-only: the host records an EXTERNAL execution with no child session.
 */
export type SubagentCatalogReporter = (dshSessionId: string, childId: string, label: string) => void

/**
 * The plugin's normalized MCP server shape → the ACP wire shape.
 *
 * THE WIRE SHAPE IS ASYMMETRIC, and getting it wrong is SILENT:
 *
 *  - the stdio variant carries NO `type` field — an entry that carries
 *    `type:'stdio'` is accepted by the agent and then never connected
 *    (measured against codebuddy: the server never appeared, the agent just
 *    reported the tool as missing);
 *  - http/sse DO carry `type`;
 *  - `env` / `headers` are `[{name,value}]` arrays on the wire, while the
 *    plugin stores them as records (like `AcpAgentDef.env`).
 *
 * So the conversion lives here, once, and each branch is annotated with the
 * SDK's OWN variant type — a wrong conversion does not compile. (The bare
 * `McpServer` union is too loose to catch it: its excess-property check
 * accepts any member's keys, so a stdio entry carrying `type:'stdio'` would
 * type-check against the http variant and only fail at runtime, inside the
 * agent, as a server that never connects.)
 */
function toAcpMcpServers(defs: AcpMcpServerDef[] | undefined): McpServer[] {
  if (defs === undefined) return []
  return defs.map(def => {
    if (def.transport === 'stdio') {
      // NO `type` here — see the note above.
      const server: McpServerStdio = {
        name: def.name,
        command: def.command,
        args: def.args ?? [],
        env: Object.entries(def.env ?? {}).map(([name, value]) => ({ name, value })),
      }
      return server
    }
    if (def.transport === 'http') {
      const server: McpServerHttp & { type: 'http' } = {
        type: 'http',
        name: def.name,
        url: def.url,
        headers: Object.entries(def.headers ?? {}).map(([name, value]) => ({ name, value })),
      }
      return server
    }
    const server: McpServerSse & { type: 'sse' } = {
      type: 'sse',
      name: def.name,
      url: def.url,
      headers: Object.entries(def.headers ?? {}).map(([name, value]) => ({ name, value })),
    }
    return server
  })
}

const DEFAULT_TUNING: Required<BridgeTuning> = {
  startupTimeoutMs: 60_000,
  permissionTimeoutMs: 300_000,
  permissionTimeoutMode: 'wait',
  cancelFallbackMs: 15_000,
  staleCancelRetryDelayMs: 600,
  staleCancelMaxRetries: 2,
  turnSettleMs: 5_000,
  turnStallMs: 600_000,
  turnStallToolMs: 1_800_000,
  turnStallTickMs: 30_000,
  idleTimeoutMs: DEFAULT_IDLE_TIMEOUT_MS,
  probeIdleTimeoutMs: 300_000,
  ambientQuietMs: 10_000,
  ambientMaxMs: 120_000,
  backgroundTaskMaxMs: 600_000,
  backgroundTaskToolMs: 2_400_000,
  backgroundOpenToolCeilingMs: 7_200_000,
  backgroundTaskCeilingMs: 0,
  backgroundParkedGraceMs: 30_000,
  ambientStaleMs: 300_000,
  backgroundHoldWorkerPhase: false,
}

type BridgeState = 'stopped' | 'starting' | 'ready' | 'error'

/**
 * Facts about one start attempt, recorded as it happens so a failure can be
 * NAMED afterwards instead of being read back out of prose.
 *
 * WHY: whatever goes wrong, the SDK rejects the pending `initialize` with the
 * same sentence (`ACP connection closed`), so the user's two actual mistakes —
 * "the agent is not installed" and "the launch command is wrong" — used to
 * arrive identical. The connection test reads this record (see
 * `classifyTestFailure`) and the settings page writes the matching fix.
 *
 * Written once per {@link AgentBridge.spawnAndConnect}, after the teardown
 * checks: a start that lost its epoch describes nothing anyone reads.
 */
export interface StartAttempt {
  /** The program token the definition names, before PATH resolution. */
  command: string
  /** Absolute path the program token resolved to; absent = never found on PATH. */
  executablePath?: string
  /**
   * The `npmPackage` auto-install was actually STARTED during this attempt.
   *
   * Set from the install step itself, never from the definition: a configured
   * package name proves nothing (the program may already sit on PATH), and
   * claiming the install ran would make the settings page name a fix that never
   * happened.
   */
  installTried: boolean
  /** `spawn` was called and returned a child (an async ENOENT still counts as spawned). */
  spawned: boolean
  /** The spawn itself failed (ENOENT, EACCES, EINVAL…). */
  spawnError?: { code?: string; message: string }
  /** The child exited while the handshake was still in flight. */
  exit?: { code: number | null; signal: string | null }
  /** The `initialize` request ran out of its startup budget. */
  timedOut: boolean
}

/**
 * Name one failed `agent/test` from the attempt's own facts.
 *
 * The timeout is read first: it is the only fact that proves the process RAN,
 * and a spawn error arriving after the teardown is stale noise about a child
 * nobody was waiting for any more. The rest follows the order of the events:
 * spawn → resolution → exit → a connection that dropped with no fact at all.
 */
export function classifyTestFailure(attempt: StartAttempt | undefined): AgentTestFailureKind {
  if (attempt === undefined) return 'handshake-failed'
  if (attempt.timedOut) return 'timeout'
  // The spawn's own error is the second-strongest fact: `spawn` RETURNS a
  // handle even when the program does not exist (the ENOENT arrives as an
  // event), so `spawned` can be true here and this must be read before it.
  if (attempt.spawnError !== undefined) {
    // ENOENT means "install it" only when nothing was ever resolved. A path WAS
    // found and then failed to launch, so the fix is not a reinstall.
    return attempt.spawnError.code === 'ENOENT' && attempt.executablePath === undefined
      ? 'not-found'
      : 'start-failed'
  }
  if (!attempt.spawned) {
    // Nothing was spawned and there is no spawn error: the failure happened
    // while RESOLVING the command, i.e. inside the npm auto-install.
    return attempt.installTried ? 'install-failed' : 'not-found'
  }
  if (attempt.exit !== undefined) return 'start-failed'
  return 'handshake-failed'
}

export class AgentBridge {
  state: BridgeState = 'stopped'
  initResult?: InitializeResponse
  lastError?: string
  stderrTail: string[] = []
  /** Facts about the LAST start attempt — see {@link StartAttempt}. */
  startAttempt?: StartAttempt
  /**
   * The child the current start attempt spawned.
   *
   * Held separately from {@link child} because `killChild` clears THAT one the
   * moment a start fails, and the exit facts of the child are exactly what a
   * failed connection test has to report (see `awaitStartChildExit`).
   */
  private startChild?: ChildProcess

  private child?: ChildProcess
  private conn?: ClientConnection
  /**
   * Teardown generation, bumped ONLY by a deliberate teardown (`stop` /
   * `shutdown` / `forceReset`), so a start that was already in flight can tell
   * that nobody owns its outcome any more: `spawnAndConnect` re-checks this
   * after each await and disposes the child it would otherwise have published
   * as `ready`. Without it, a teardown landing during `ensureAgentExecutable`
   * (a global npm install can take minutes) left a freshly spawned agent
   * running with no owner.
   *
   * `releaseAll` and `killChild` deliberately do NOT bump it: both are also the
   * failure path of a start's own handshake — a child dying during startup goes
   * `exit` → `connectionLost` → `releaseAll('died')` — and that start must
   * still publish `error` with its stderr tail rather than be mistaken for a
   * teardown (see `ensureReady`). It cannot leak a process either way: a crash
   * release only happens once the child exists, and `spawnAndConnect` has no
   * spawn point left after that.
   */
  private teardownEpoch = 0
  private starting?: Promise<void>
  private readonly sessions = new Map<string, LiveSession>()
  private readonly acpIndex = new Map<string, LiveSession>()
  /** Sessions whose process died but whose ACP id can be resumed via `session/load`. */
  private readonly released = new Map<string, LiveSession>()
  /** Inflight `session/load` resumes, shared so concurrent prompts don't double-resume. */
  private readonly resuming = new Map<string, Promise<LiveSession>>()
  readonly permissions = new PermissionLedger()
  private readonly startupTimeoutMs: number
  /**
   * The ONE approval deadline, and the mode it settles with. Neither is
   * readonly, unlike their neighbors: the settings page rewrites them on a
   * running bridge ({@link AgentBridge.applyApprovalDeadlines}), so a user
   * editing the card does not have to kill every live session to see it take
   * effect. Both are read per ask, so a reassignment reaches every ask from
   * that moment on. An ask already holding an armed timer keeps the window it
   * was started with.
   */
  private permissionTimeoutMs: number
  private permissionTimeoutMode: PermissionTimeoutMode
  private readonly cancelFallbackMs: number
  private readonly staleCancelRetryDelayMs: number
  private readonly staleCancelMaxRetries: number
  private readonly turnSettleMs: number
  /** How long a background drain's record still counts as live work for the idle clock. */
  private readonly ambientStaleMs: number
  /** How long an unfinished dispatch may stay silent and still count as live work. */
  private readonly backgroundDispatchSilenceMs: number
  /** How long an OPEN worker tool call may stay open before it is presumed wedged. */
  private readonly backgroundOpenToolCeilingMs: number
  private defaultIdleTimeoutMs: number
  private readonly probeIdleTimeoutMs: number
  /** Armed while READY; fires the idle-release check. */
  private idleTimer?: ReturnType<typeof setTimeout>
  /** Last observable activity; the idle window is measured from here. */
  private lastActivityAt = 0
  /** Throwaway catalog probes in flight — they hold no live session of their own. */
  private pendingProbes = 0
  /**
   * `session/prompt` requests still awaiting the agent's answer, keyed by the
   * session that owns them. A rollback can close the session the moment the
   * user aborts, which removes it from `sessions` — but the request is still on
   * air, and killing the child now would turn a user's STOP into a
   * connection-dropped ERROR. This map is the ownership proof `hasActiveWork`
   * needs once the session is gone — and the KEY is what lets the idle clock
   * tell a closed-and-abandoned request apart from a live one (see
   * `pendingPromptsOnServableSessions`).
   */
  private pendingPrompts = new Map<string, number>()
  /**
   * Host→agent session commands in flight (mode / config); not turns. Counted
   * PER SESSION: a command the wedged agent never answers must not pin the
   * bridge against reclaiming THAT session (it is exactly the state the
   * watchdog is recovering from), while another session's command still does.
   */
  private readonly pendingCommands = new Map<string, number>()
  /**
   * `session/new` requests in flight. The session does not exist in `sessions`
   * yet, so nothing else would tell a teardown (`releaseAll` / idle release)
   * that a caller is waiting on the child it is about to kill.
   */
  private pendingCreates = 0
  /**
   * `session/fork` requests in flight (the adopt path of a branched
   * conversation). Same teardown hazard as {@link pendingCreates}: until the
   * forked session is registered, nothing else would stop an idle release
   * from killing the child out from under the caller.
   */
  private pendingForks = 0
  /**
   * Whether a REAL session has ever been registered on this bridge. Probes
   * bypass session bookkeeping, so a bridge that has never hosted anything was
   * spawned by a probe and honors {@link probeIdleTimeoutMs}; the first
   * registered session flips it to the agent's own residency semantics.
   */
  private everHostedSession = false
  /** cwd the CURRENT child was spawned with (undefined while there is no child). */
  private spawnCwd?: string
  /**
   * Workspace a chat session wants the agent PROCESS to run in (see
   * `ensureReady`). Some agents fix their whole workspace at process start —
   * cwd-derived project state, the environment block they show the model, the
   * files their tools may touch — so `session/new`'s cwd arrives too late for
   * them (observed on codebuddy: it logs `Workspace Path: <process cwd>` before
   * any ACP request is read). For those agents the spawn cwd is the only lever
   * there is.
   */
  private wantedSpawnCwd?: string

  constructor(
    readonly def: AcpAgentDef,
    private readonly hub: EventHub,
    private readonly transcriptMax: number,
    /** Called when the connection dies so the manager can settle outstanding prompts. */
    private readonly onConnectionLost: (bridge: AgentBridge, reason: string) => void,
    /**
     * Observes `configOptions` from any real session so the manager's model
     * catalog stays warm. `shapeOnly` marks a per-session answer (a
     * `session/set_config_option` response): only the option SHAPE belongs in
     * the agent-level catalog, never its `currentValue` — see
     * {@link BridgeManager.absorbCatalogShape}.
     */
    private readonly onCatalog?: (agentId: string, configOptions: unknown, shapeOnly?: boolean) => void,
    /** Observes `availableCommands` from any real session so the agent's slash menu survives its sessions. */
    private readonly onCommands?: (agentId: string, commands: NonNullable<SessionView['availableCommands']>) => void,
    tuning?: BridgeTuning,
    /**
     * Resolved per turn: the host entry may wire the workspace reader after
     * this bridge was built.
     */
    private readonly sessionWorkspace?: () => SessionWorkspaceResolver | undefined,
    /**
     * Told whenever the SESSION RECORDS change shape (a release parks them, a
     * resume revives them): the manager persists `chatSessions` through it, so
     * a parked conversation stays resumable across a host restart (see
     * `BridgeManager.loadPersistedChatSessions`).
     */
    private readonly onSessionsDirty?: () => void,
    /**
     * Told whenever a fresh `initialize` reports the agent's
     * `sessionCapabilities.fork` bit — the LAST KNOWN fork capability the
     * manager persists and serves to the browser (the bridge's own
     * `initResult` dies with the process; the manager's copy survives it).
     */
    private readonly onForkCapability?: (agentId: string, supported: boolean) => void,
    /**
     * When present, a status transition is broadcast by the MANAGER from the
     * AGGREGATE of every process serving the agent (A1 has several) instead of
     * this child speaking for all of them. Absent on every legacy construction
     * point, which keeps their frame byte-for-byte as it was.
     */
    private readonly onStatus?: (bridge: AgentBridge) => void,
    /**
     * Every `session/update` of a live session, BEFORE the transcript cursor
     * guard: the manager's session-level bookkeeping for detached workers and
     * background drains. It must see frames no turn controller observes any
     * more (a worker reporting after the turn that dispatched it closed).
     */
    private readonly onSessionBackgroundUpdate?: (session: LiveSession, update: SessionUpdate) => void,
    /**
     * Terminalize every unfinished detached-worker record when a SESSION goes
     * away (close / release / force reset / process death). A closed TURN is
     * deliberately not one of these: its worker may still be running.
     */
    private readonly onSessionBackgroundTeardown?: (session: LiveSession, status: 'cancelled' | 'unknown') => void,
  ) {
    const merged = { ...DEFAULT_TUNING, ...tuning }
    this.startupTimeoutMs = merged.startupTimeoutMs
    this.permissionTimeoutMode = merged.permissionTimeoutMode
    // 不等待 (0) is the `auto` mode's business; under `abort` it would refuse
    // every ask on arrival, so the window is floored to the shortest real wait.
    this.permissionTimeoutMs = normalizeApprovalWindow(this.permissionTimeoutMode, merged.permissionTimeoutMs)
    this.cancelFallbackMs = merged.cancelFallbackMs
    this.staleCancelRetryDelayMs = merged.staleCancelRetryDelayMs
    this.staleCancelMaxRetries = merged.staleCancelMaxRetries
    this.turnSettleMs = merged.turnSettleMs
    this.ambientStaleMs = merged.ambientStaleMs
    this.backgroundDispatchSilenceMs = merged.backgroundTaskToolMs > 0
      ? merged.backgroundTaskToolMs
      : merged.backgroundTaskMaxMs
    this.backgroundOpenToolCeilingMs = merged.backgroundOpenToolCeilingMs
    this.defaultIdleTimeoutMs = merged.idleTimeoutMs
    this.probeIdleTimeoutMs = merged.probeIdleTimeoutMs
  }

  /**
   * Adopt a rewritten approval deadline or mode (the settings page's write).
   * Only the window and the mode live here; every other tuning value is
   * fixed at construction, because a live bridge cannot meaningfully adopt a
   * new startup or cancel window mid-flight.
   *
   * Deliberately does NOT re-arm anything: an ask that already holds a timer
   * keeps the window it was started with, and the next ask reads the new value.
   * Re-arming would move the goalposts under a human who is already deciding.
   */
  applyApprovalDeadlines(patch: { permissionTimeoutMs?: number; mode?: PermissionTimeoutMode }): void {
    if (patch.permissionTimeoutMs !== undefined) this.permissionTimeoutMs = patch.permissionTimeoutMs
    if (patch.mode !== undefined) this.permissionTimeoutMode = patch.mode
    // A mode switch can leave a window behind that the new mode cannot run
    // (不等待 under `abort`): floor it, so the ask waits instead of refusing
    // on arrival.
    this.permissionTimeoutMs = normalizeApprovalWindow(this.permissionTimeoutMode, this.permissionTimeoutMs)
  }

  /**
   * Adopt a rewritten host-default idle window (the settings page's write).
   *
   * Only the DEFAULT moves: an agent that names its own `idleTimeoutMs` keeps
   * it (that promise is about the agent, not about the deployment), and a
   * probe-only child keeps the short probe window.
   *
   * The timer is re-armed so the new window governs from NOW: an already
   * armed timer still holds the old window, so a shortened window would not
   * take effect until the old one elapsed.
   */
  applyIdleRelease(defaultIdleTimeoutMs: number): void {
    if (this.defaultIdleTimeoutMs === defaultIdleTimeoutMs) return
    this.defaultIdleTimeoutMs = defaultIdleTimeoutMs
    this.clearIdleTimer()
    this.touch()
  }

  /**
   * The idle-release window this agent honors for its CHAT process: its own
   * field, else the host default. This is the number the panel prefills and
   * displays (`AgentView.idleTimeoutMs`), so it must keep meaning "the chat
   * residency the user configured" even while the current child is a probe
   * spawn that will actually die much sooner.
   */
  private get idleTimeoutMs(): number {
    return this.def.idleTimeoutMs ?? this.defaultIdleTimeoutMs
  }

  /**
   * The window that governs THIS child right now. A bridge that has never
   * hosted a real session exists only because a probe spawned it, and a probe
   * process has no stake in how long a CHAT process may wait for its next
   * message — it gets the short probe window unconditionally (even when
   * `def.idleTimeoutMs` asks for permanent residency, which is a promise about
   * the chat process). The first registered session flips the bridge to the
   * agent's own semantics.
   */
  private get currentIdleTimeoutMs(): number {
    if (!this.everHostedSession) return this.probeIdleTimeoutMs
    return this.idleTimeoutMs
  }

  /**
   * Restart the idle-release clock. Every observable activity calls this, so a
   * bridge is only ever released after a FULL quiet window — never while it is
   * being used. Rescheduling here keeps the window measured from the LATEST
   * activity; letting an already-armed timer fire early would not.
   */
  private touch(): void {
    this.lastActivityAt = Date.now()
    this.clearIdleTimer()
    this.armIdleRelease()
  }

  /**
   * Arm the single idle timer for a full window from the last activity. The
   * callback re-checks {@link canIdleRelease} anyway, so a late activity that
   * lands while it runs can only postpone the release.
   */
  private armIdleRelease(): void {
    if (this.currentIdleTimeoutMs <= 0 || this.state !== 'ready' || this.idleTimer !== undefined) return
    const timer = setTimeout(() => {
      this.idleTimer = undefined
      this.releaseIfIdle()
    }, Math.max(0, this.lastActivityAt + this.currentIdleTimeoutMs - Date.now()))
    timer.unref?.()
    this.idleTimer = timer
  }

  private clearIdleTimer(): void {
    if (this.idleTimer === undefined) return
    clearTimeout(this.idleTimer)
    this.idleTimer = undefined
  }

  /**
   * Release a READY agent that has been quiet for a full window. The window is
   * {@link currentIdleTimeoutMs}: the short probe window for a child that has
   * never hosted a session (model-catalog probes and post-save probes spawn
   * exactly such children, see {@link probeConfigOptions}), the agent's own
   * residency window once a real session has landed.
   *
   * Scoped to bridges with no ACTIVE work, not merely no live session: an idle
   * conversation should not keep a process resident forever. Releasing parks its
   * sessions as `released` (not closed), and the next prompt resumes them on a
   * fresh child through `session/load` — the same path a crash uses.
   *
   * `releaseAll` (not `stop`) is the right teardown: `stop` drops resumable
   * records, which would destroy the context of sessions parked by an earlier
   * crash just because this bridge went quiet.
   *
   * The teardown is SILENT by design: an idle release is the expected lifecycle
   * of a resting process, not a fault — the panel's status simply falls back to
   * "configured", and a notice would only train the user to ignore notices.
   * Abnormal disappearances (crashes) surface through `session/released`
   * events instead.
   */
  private releaseIfIdle(): void {
    if (this.state !== 'ready') return
    if (!this.canIdleRelease()) {
      // Busy after all: the quiet window starts now, not at the last event.
      this.touch()
      return
    }
    this.releaseAll(`agent "${this.def.id}" was released after ${String(Math.round(this.currentIdleTimeoutMs / 1000))}s idle`, 'idle')
  }

  /**
   * Claim this bridge's single prompt slot for one turn, waiting (bounded) for
   * a predecessor the agent has not finished yet.
   *
   * WHY the wait: `onAbort` finishes OUR stream the moment the user hits stop,
   * but the cancel is a notification the agent may not have processed yet. A
   * prompt sent into that window is a second concurrent `session/prompt` on the
   * same session — forbidden by the protocol and rejected (or worse, mishandled)
   * by the agent. Waiting turns a protocol error into a short delay.
   *
   * The gate is {@link LiveSession.promptInFlight} + the settle promise, NOT
   * {@link LiveSession.running}: an ambient turn keeps `running` true for the
   * whole drain while its prompt slot is already free, so `running` would
   * refuse every message the user sends during a background task.
   *
   * @param session - the session asking for the slot.
   * @returns whether the slot was claimed, and why not when it was not.
   */
  async claimTurn(session: LiveSession): Promise<{ ok: true } | { ok: false; reason: 'busy' | 'unsettled' }> {
    if (this.promptSlotHeld(session)) return { ok: false, reason: 'busy' }
    const pending = session.settled
    if (pending === undefined) return { ok: true }
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        pending,
        new Promise<void>(resolve => {
          timer = setTimeout(resolve, this.turnSettleMs)
          timer.unref?.()
        }),
      ])
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
    // The agent never acknowledged: sending now would start a concurrent turn,
    // so report it honestly instead of handing the agent two prompts at once.
    if (session.settled !== undefined) return { ok: false, reason: 'unsettled' }
    // Re-checked after the wait: another turn may have claimed the slot while
    // this one was waiting on the gate.
    if (this.promptSlotHeld(session)) return { ok: false, reason: 'busy' }
    return { ok: true }
  }

  /** Whether a turn currently holds the agent prompt slot (see `promptInFlight`). */
  private promptSlotHeld(session: LiveSession): boolean {
    return session.promptInFlight === true
  }

  /**
   * Mark the agent-side turn as in flight — claim the agent prompt slot and
   * open the settle gate — and hand back the settler its stream owner must
   * call once the agent is actually done with it.
   *
   * @param session - the session whose turn is starting.
   * @returns the settler (idempotent; also used by connection loss).
   */
  beginTurn(session: LiveSession): () => void {
    let settle: () => void = () => { /* replaced below */ }
    const settled = new Promise<void>(resolve => { settle = resolve })
    session.settled = settled
    session.settledResolve = settle
    session.promptInFlight = true
    this.touch()
    return () => {
      // Identity-guarded: only THIS turn's settler may release the slot. A
      // superseded turn's late settler must not clear the flag a NEWER turn
      // has already claimed (its settle gate was replaced with a new promise).
      if (session.settled === settled) {
        session.settled = undefined
        session.settledResolve = undefined
        session.promptInFlight = false
      }
      settle()
      // The turn is over: a fresh window starts here rather than at the prompt
      // that may have started a long time ago.
      this.touch()
    }
  }

  /**
   * Open a session's settle gate without owning its turn stream: the turn's
   * stream is gone (a resume, a release) but the next prompt still waits on
   * this promise, and nothing is left that could ever resolve it. The prompt
   * slot itself goes with it: whatever held it is gone too.
   */
  private openSettleGate(session: LiveSession): void {
    const settle = session.settledResolve
    session.settled = undefined
    session.settledResolve = undefined
    session.promptInFlight = false
    settle?.()
  }

  view(): AgentView {
    return {
      id: this.def.id,
      title: this.def.title ?? this.def.id,
      command: this.def.command,
      args: [...(this.def.args ?? [])],
      cwd: this.def.cwd,
      allowedCwdRoots: [...(this.def.allowedCwdRoots ?? [])],
      state: this.state,
      ...(this.state === 'error' ? { stderrTail: [...this.stderrTail] } : {}),
      agentInfo: this.initResult?.agentInfo
        ? {
          name: this.initResult.agentInfo.name,
          title: this.initResult.agentInfo.title ?? undefined,
          version: this.initResult.agentInfo.version,
        }
        : undefined,
      agentCapabilities: this.initResult?.agentCapabilities,
      liveSessions: [...this.sessions.keys()],
      idleTimeoutMs: this.idleTimeoutMs,
    }
  }

  /**
   * The last startup / connection error. The manager folds it into the
   * aggregated status frame (see `BridgeManager.publishAgentStatus`); the
   * bridge itself only puts it on its own frame when it has no manager.
   */
  get errorText(): string | undefined {
    return this.lastError
  }

  /**
   * Work a teardown would interrupt: a turn in flight (or one the agent is
   * still settling after an abort), a permission ask waiting for an answer, a
   * probe, a resume, or a start. A registered-but-idle session is NOT work.
   */
  private hasActiveWork(includeClosedPrompts = true): boolean {
    const pendingPrompts = includeClosedPrompts
      ? this.pendingPrompts.size
      : this.pendingPromptsOnServableSessions()
    if (this.pendingProbes > 0
      || pendingPrompts > 0
      || this.pendingCreates > 0
      || this.pendingForks > 0
      || this.pendingCommands.size > 0
      || this.resuming.size > 0
      || this.permissions.sessionIds().length > 0
      || this.starting !== undefined) return true
    for (const session of this.sessions.values()) {
      if (session.running || session.settled !== undefined) return true
      if (hasPendingBackgroundWork(session, this.ambientStaleMs, this.backgroundDispatchSilenceMs, this.backgroundOpenToolCeilingMs)) return true
    }
    return false
  }

  /**
   * Outstanding prompts that belong to a session this bridge can still serve
   * (live or parked). A request left behind by a CLOSED session is the abort /
   * rollback case: it must keep the child alive until it settles, so `prune` and
   * workspace moves use the strict count. But an agent that NEVER answers must
   * not pin the process forever — constraint 19's idle clock needs an end point,
   * and the agent will not give one. The idle release therefore ignores
   * closed-session requests only.
   */
  private pendingPromptsOnServableSessions(): number {
    let total = 0
    for (const [sessionId, count] of this.pendingPrompts) {
      if (this.sessions.has(sessionId) || this.released.has(sessionId)) total += count
    }
    return total
  }

  /**
   * Active work on this bridge EXCEPT `session`'s own — what a restart-carrying
   * reclaim (the stall watchdog's follow-up) would destroy. Killing this child
   * restarts every ACP session on the connection, so a live conversation that
   * is mid-turn, mid-resume, or waiting on a human pins the process: its
   * context is the one thing a restart cannot give back.
   *
   * `session`'s OWN mode/config command is deliberately not counted: an agent
   * that ignores `session/set_mode` would otherwise make its own stall
   * unrecoverable — the command's counter is exactly the evidence of the wedge.
   */
  hasOtherActiveWork(session: LiveSession): boolean {
    if (this.pendingProbes > 0
      || this.pendingCreates > 0
      || this.pendingForks > 0
      || this.resuming.size > 0
      || this.starting !== undefined) return true
    for (const sessionId of this.pendingCommands.keys()) {
      if (sessionId !== session.sessionId) return true
    }
    if (this.permissions.sessionIds().some(entry => entry.sessionId !== session.sessionId)) return true
    for (const other of this.sessions.values()) {
      if (other === session) continue
      if (other.running || other.settled !== undefined) return true
      if (hasPendingBackgroundWork(other, this.ambientStaleMs, this.backgroundDispatchSilenceMs, this.backgroundOpenToolCeilingMs)) return true
    }
    return false
  }

  /**
   * Nothing depends on this child's identity right now: no live session and no
   * work. This is the WORKSPACE MOVE's predicate. It stays stricter than the
   * idle release on purpose: an idle live session still pins the process to its
   * spawn cwd (see `ensureReady`), so moving would trade workspace-aware agent
   * state for a restart on every cross-workspace turn.
   */
  private isQuiet(): boolean {
    return this.sessions.size === 0 && !this.hasActiveWork()
  }

  /**
   * Nothing is left here that a later turn could resume: no live session, no
   * parked record, no work. A per-session holder (A1) is then safe to drop; an
   * agent-wide holder is never dropped because it IS the agent's process slot.
   */
  isDiscardable(): boolean {
    return this.isQuiet() && this.released.size === 0
  }

  /**
   * A turn is in flight (or the agent has not settled its response yet) on any
   * of this bridge's sessions. `settled` only stays non-undefined while the
   * agent's answer is outstanding — the settler clears it on completion — so
   * this is real work, not an idle session.
   */
  hasActiveTurn(): boolean {
    for (const session of this.sessions.values()) {
      if (session.running || session.settled !== undefined) return true
    }
    return false
  }

  /**
   * An idle teardown is safe when nothing is WORKING. Idle live sessions do not
   * block it: `releaseAll` parks them as `released` (never closed), and the next
   * prompt brings them back with `session/load`. The exception is an agent that
   * does not advertise `loadSession`: releasing would lose a conversation it
   * cannot reload, so there the old session-less rule stands.
   */
  private canIdleRelease(): boolean {
    if (this.hasActiveWork(false)) return false
    return this.sessions.size === 0 || this.initResult?.agentCapabilities?.loadSession === true
  }

  /**
   * Memoized spawn + `initialize`; failures reset so the next call can retry.
   *
   * @param spawnCwd - the workspace the caller needs the PROCESS to run in; a
   *   chat session passes its DSH session workspace. A ready child cannot be
   *   moved (its cwd is fixed at spawn), so a quiet bridge — nothing above to
   *   lose — is restarted in the wanted workspace instead of inheriting the
   *   directory some probe happened to spawn it in. A busy bridge keeps the
   *   child it has: `session/new` still tells the agent where that session
   *   lives, and killing a live conversation to move a process never is worth
   *   it.
   */
  ensureReady(spawnCwd?: string): Promise<void> {
    if (spawnCwd !== undefined) {
      this.wantedSpawnCwd = spawnCwd
      if (this.state === 'ready' && this.conn !== undefined && this.spawnCwd !== spawnCwd && this.isQuiet()) {
        const reason = `agent "${this.def.id}" restarts in ${spawnCwd} (the workspace of the session using it)`
        this.hub.broadcast({ type: 'agent/notice', agentId: this.def.id, level: 'info', text: `acp: ${reason}` })
        this.releaseAll(reason, 'workspace')
      }
    }
    if (this.state === 'ready' && this.conn !== undefined) return Promise.resolve()
    if (this.starting !== undefined) return this.starting
    const epoch = this.teardownEpoch
    this.state = 'starting'
    this.publishStatus()
    const started = this.spawnAndConnect(epoch)
      .then(() => {
        // A teardown landed while the handshake was in flight: it owns the
        // bridge now, and `spawnAndConnect` has already disposed whatever it
        // spawned. Publishing `ready` here would paint a live status back over
        // the stopped bridge. `state` catches the one teardown that does NOT
        // bump the epoch — a crash release (`releaseAll`): without it, a
        // handshake that resolved just as the child died would paint `ready`
        // over the `stopped` that the crash left behind.
        if (this.teardownEpoch !== epoch || this.state !== 'starting') return
        this.state = 'ready'
        this.lastError = undefined
        this.publishStatus()
        // Start the idle clock only from a READY process: `starting` may take
        // the whole startup budget and must not race the release.
        this.touch()
      })
      .catch((error: unknown) => {
        // Same guard: a start nobody owns any more must not publish its
        // outcome. A start's OWN failure — `withStartupTimeout`, or the child
        // dying mid-handshake (which runs through `releaseAll`) — still reaches
        // the lines below and publishes `error` with its stderr tail; neither
        // of those paths bumps the epoch.
        if (this.teardownEpoch !== epoch) {
          // Publish nothing, but keep the caller's error contract: every
          // interrupted start has always surfaced as `agent_unreachable`.
          throw new AcpError('agent_unreachable', `acp: agent "${this.def.id}" failed to start: ${error instanceof Error ? error.message : String(error)}`)
        }
        this.state = 'error'
        this.lastError = error instanceof Error ? error.message : String(error)
        this.clearIdleTimer()
        this.killChild()
        this.publishStatus()
        throw new AcpError('agent_unreachable', `acp: agent "${this.def.id}" failed to start: ${this.lastError}`)
      })
      .finally(() => {
        // Only clear a slot that is still OURS: a teardown may have cleared it
        // (and a fresh `ensureReady` may already hold it).
        if (this.starting === started) this.starting = undefined
      })
    this.starting = started
    return started
  }

  /**
   * @param epoch - `teardownEpoch` captured when this start claimed the bridge.
   *   Every await below is a window in which a teardown can land; a stale start
   *   owns nothing and must leave no process behind (see `teardownEpoch`).
   */
  private async spawnAndConnect(epoch: number): Promise<void> {
    this.stderrTail = []
    // The attempt record starts here and is filled in as the start progresses;
    // a failure reads it back to name the cause (see `StartAttempt`).
    const attempt: StartAttempt = {
      command: this.def.command,
      // Flipped by the install step itself, not by the definition: see
      // `StartAttempt.installTried`.
      installTried: false,
      spawned: false,
      timedOut: false,
    }
    this.startAttempt = attempt
    // Resolve (and, with npmPackage, auto-install) the executable before the
    // spawn; the resolved absolute path also pins the lookup to the host PATH
    // plus the well-known extra dirs, not the child env the agent may override.
    const { command } = await ensureAgentExecutable(
      this.def,
      undefined,
      line => this.noteStderr(line),
      () => { attempt.installTried = true },
    )
    // Re-resolved (not taken from the answer above) because the install may have
    // JUST made the program resolvable: this is exactly the question "did the
    // host find a program to launch", which is what tells "not installed"
    // apart from "the launch command is wrong".
    attempt.executablePath = findExecutable(this.def.command)
    // A teardown landed while the executable was being resolved — a global
    // install can hold this await for minutes. Nothing has been spawned yet, so
    // there is nothing to reap; just refuse to create the process.
    if (this.teardownEpoch !== epoch) return
    const cwd = safeSpawnCwd(this.def, this.wantedSpawnCwd)
    this.spawnCwd = cwd
    const launch = windowsShimLaunch(command, perSessionLaunchArgs(this.def.args ?? [], this.def.id))
    let child: ChildProcess
    try {
      child = spawn(launch.command, launch.args, {
        cwd,
        env: perSessionLaunchEnv(childEnv(process.env, this.def.env ?? {}), this.def.id),
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
        shell: false,
        // A console child of a GUI host (the desktop app) would otherwise pop a
        // console window on every spawn.
        windowsHide: true,
        ...(launch.verbatim ? { windowsVerbatimArguments: true } : {}),
      })
    } catch (error) {
      // `spawn` rejects an unusable option set SYNCHRONOUSLY (an invalid `env`
      // value, a bad option type). Record that like the async `error` event
      // below, or the verdict would blame the install / PATH for a launch the
      // host refused to attempt at all.
      attempt.spawnError = {
        code: (error as NodeJS.ErrnoException).code,
        message: error instanceof Error ? error.message : String(error),
      }
      throw error
    }
    this.child = child
    this.startChild = child
    attempt.spawned = true
    trackAgentChild(child)
    child.on('error', (error) => {
      // The FACT is recorded before the identity guard: this attempt's own
      // record is not shared with a replacement child, and a start that was
      // already torn down still has to report WHY it failed. Only the teardown
      // below needs the guard — a stale event must not kill a fresh process.
      attempt.spawnError = { code: (error as NodeJS.ErrnoException).code, message: error.message }
      // Identity guard: a stale event from a PREVIOUS child must not tear down
      // a connection that replaced it (an `exit` can land after the respawn
      // already started and would otherwise kill the fresh process).
      if (this.child !== child) return
      this.noteStderr(`spawn error: ${error.message}`)
      if (this.state !== 'stopped') this.onConnectionLost(this, `spawn error: ${error.message}`)
    })
    child.on('exit', (code, signal) => {
      // Before the guard, for the same reason as the spawn error above: a child
      // that dies during the handshake closes its stdio FIRST, so the pending
      // `initialize` is already rejected (and `killChild` has already cleared
      // `this.child`) by the time this lands — the guard would swallow the one
      // fact that names a wrong launch command.
      attempt.exit = { code, signal }
      if (this.child !== child) return // stale event from a replaced child
      this.noteStderr(`[process exited code=${String(code)} signal=${String(signal)}]`)
      if (this.state === 'ready' || this.state === 'starting') {
        this.onConnectionLost(this, `agent process exited (code=${String(code)}, signal=${String(signal)})`)
      }
    })
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => {
      for (const line of chunk.split('\n')) this.noteStderr(line)
    })
    if (child.stdin === null || child.stdout === null) {
      throw new Error('agent child dropped piped stdio')
    }
    const stream = ndJsonStream(
      Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
      Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
    )
    const app = client({ name: 'dsh-ntr' })
      .onNotification(methods.client.session.update, ctx => {
        this.handleSessionUpdate(ctx.params)
      })
      .onRequest(methods.client.session.requestPermission, async ctx => {
        return this.handlePermissionRequest(ctx.params.sessionId, ctx.params.toolCall, ctx.params.options, ctx.signal)
      })
      .onRequest(methods.client.fs.readTextFile, async ctx => this.handleFsRead(ctx.params))
      .onRequest(methods.client.fs.writeTextFile, async ctx => this.handleFsWrite(ctx.params))
    const conn = app.connect(stream)
    this.conn = conn
    void conn.closed.then(() => {
      if (this.conn === conn && (this.state === 'ready')) {
        this.onConnectionLost(this, 'ACP connection closed')
      }
    })
    const init = await this.withStartupTimeout(
      conn.agent.request(methods.agent.initialize, {
        protocolVersion: PROTOCOL_VERSION,
        // The fs handlers are implemented below behind the same workspace
        // sandbox that gates session cwds; terminal is not implemented.
        // `session.configOptions.boolean` advertises the toggle form of
        // `configOptions`; agents that gate `type: "boolean"` entries on it
        // would otherwise never publish them.
        clientCapabilities: {
          fs: { readTextFile: true, writeTextFile: true },
          terminal: false,
          session: { configOptions: { boolean: {} } },
        },
        clientInfo: { name: 'dsh-ntr', title: 'DSH NTR', version: PLUGIN_VERSION },
      }),
      'initialize',
      attempt,
    )
    // The second — and widest — window: `initialize` waits up to the startup
    // budget, and a shutdown / stop during it already dropped the connection and
    // killed the child we spawned. That child is OURS even though the bridge no
    // longer points at it, so dispose it with the awaitable kill instead of
    // leaving a process nobody can reach.
    if (this.teardownEpoch !== epoch) {
      // Only when it is still the CURRENT connection: a newer one belongs to a
      // fresh start and must not be closed from here.
      if (this.conn === conn) {
        this.conn = undefined
        conn.close()
      }
      if (this.child === child) {
        this.child = undefined
        this.spawnCwd = undefined
      }
      await disposeChild(child, STALE_START_KILL_BUDGET_MS)
      return
    }
    this.initResult = init
    // The fork capability is agent knowledge that must outlive the process:
    // report it so the manager can persist a LAST KNOWN copy and serve the
    // browser's branch button after a release (`initResult` itself dies here).
    this.onForkCapability?.(this.def.id, this.initResult?.agentCapabilities?.sessionCapabilities?.fork != null)
  }

  /**
   * Bound one agent-startup request (`initialize`, `session/new`,
   * `session/load`). The SDK's `cancellationSignal` is cooperative — a wedged
   * agent never answers `$/cancel_request` either — so the only real timeout
   * is a race, and the losing call tears the child down: a process that stops
   * answering protocol requests is dead for every session it owns.
   */
  private withStartupTimeout<T>(request: Promise<T>, what: string, attempt?: StartAttempt): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        // Marks THE attempt this start owns, not whatever `this.startAttempt`
        // points at when the timer fires: a late timer from an older start must
        // not make a fresh attempt read as timed out.
        if (attempt !== undefined) attempt.timedOut = true
        this.killChild()
        reject(new AcpError('agent_timeout', `acp: agent "${this.def.id}" did not answer ${what} within ${String(this.startupTimeoutMs)}ms${this.stderrTail.length > 0 ? `; stderr: ${this.stderrTail.slice(-5).join(' | ')}` : ''}`))
      }, this.startupTimeoutMs)
      timer.unref?.()
    })
    return Promise.race([request, timeout]).finally(() => {
      clearTimeout(timer)
      // The losing request may still reject when the child is torn down below.
      void request.catch(() => { /* already surfaced through the timeout path */ })
    })
  }

  /**
   * Wait — briefly — for the current start's child to report its `exit`, so a
   * failure verdict can name the code the process died with.
   *
   * WHY a bounded WAIT instead of a read: a child that dies during the ACP
   * handshake closes its stdio FIRST. The SDK therefore rejects the pending
   * `initialize` (reporting "ACP connection closed") before Node delivers
   * `exit`, and the start's own teardown clears the child in that same window.
   * Reading the record at the rejection would miss the exit code — the single
   * most useful fact about a launch command that is wrong.
   *
   * Never rejects, and never outlasts its budget: a process that is gone
   * reports promptly, and a wedged one must not delay the verdict.
   */
  async awaitStartChildExit(budgetMs: number): Promise<void> {
    // Only a start that actually reached `spawn` has a child whose exit is
    // worth waiting for; a start that died while resolving (a failed install)
    // must not sit on the previous child for the whole grace window.
    if (this.startAttempt?.spawned !== true) return
    const child = this.startChild
    if (child === undefined) return
    if (child.exitCode !== null || child.signalCode !== null) return
    await waitForChildExit(child, budgetMs)
  }

  private noteStderr(line: string): void {
    if (line === '') return
    // Stderr is what a misbehaving agent says about itself: keep the whole line
    // (a stack trace or an activation error is exactly the line that gets cut).
    this.stderrTail.push(line)
    if (this.stderrTail.length > STDERR_TAIL_LINES) this.stderrTail.splice(0, this.stderrTail.length - STDERR_TAIL_LINES)
  }

  private publishStatus(): void {
    // A1: one child's transition must not speak for the whole agent — hand it
    // to the manager, which folds every child into one frame. With a single
    // child that frame is the identical one this method used to send.
    if (this.onStatus !== undefined) {
      this.onStatus(this)
      return
    }
    this.hub.broadcast({ type: 'agent/status', agentId: this.def.id, state: this.state, ...(this.lastError === undefined ? {} : { error: this.lastError }), agent: this.view() })
  }

  /**
   * @param cwd - the ACP session's cwd (validated against the agent's roots).
   * @param extraRoots - roots trusted for THIS session only (a chat session's
   *   DSH workspace; see `resolveSessionCwd`).
   * @param spawnCwd - where the agent PROCESS should run; see `ensureReady`.
   */
  async createSession(cwd: string | undefined, extraRoots: readonly string[] = [], spawnCwd?: string): Promise<LiveSession> {
    // Readiness (and its possible restart into `spawnCwd`, see `ensureReady`)
    // comes FIRST: `isQuiet` must not count THIS call's in-flight `session/new`
    // against that move, or a fresh conversation could never bring a quiet
    // process into its workspace. The counter is bumped in the same microtask
    // that resumes here, so no idle-release timer can slip into the gap.
    await this.ensureReady(spawnCwd)
    // Counted while the request is in flight: until `sessions.set` runs, the
    // session is invisible to every teardown predicate, and a release that
    // killed the child here would strand this promise on a dead connection.
    this.pendingCreates += 1
    try {
      return await this.openSession(cwd, extraRoots)
    } finally {
      this.pendingCreates -= 1
      this.touch()
    }
  }

  /** The body of {@link createSession}; the caller keeps `pendingCreates` for it. */
  private async openSession(cwd: string | undefined, extraRoots: readonly string[]): Promise<LiveSession> {
    const conn = this.conn
    if (conn === undefined) throw new AcpError('agent_unreachable', 'acp: connection is not open')
    const resolved = resolveSessionCwd(this.def, cwd, p => realpathSync(p), extraRoots)
    const result = await this.withStartupTimeout(
      conn.agent.request(methods.agent.session.new, { cwd: resolved, mcpServers: toAcpMcpServers(this.def.mcpServers) }),
      'session/new',
    )
    // An empty `configOptions` answer is a non-answer — see `usableConfigOptions`.
    if (this.onCatalog !== undefined && usableConfigOptions(result.configOptions)) {
      this.onCatalog(this.def.id, result.configOptions)
    }
    const session: LiveSession = {
      sessionId: randomUUID(),
      agentId: this.def.id,
      acpSessionId: result.sessionId,
      cwd: resolved,
      running: false,
      turnSeq: 0,
      closed: false,
      released: false,
      lastAgentActivityAt: Date.now(),
      activeToolCalls: new Set(),
      transcript: new Transcript(this.transcriptMax),
      ...(result.modes !== undefined && result.modes !== null
        ? {
          modes: {
            currentModeId: result.modes.currentModeId,
            availableModes: result.modes.availableModes.map(m => ({
              id: m.id,
              name: m.name,
              ...(m.description !== null ? { description: m.description } : {}),
            })),
          },
        }
        : {}),
      ...(usableConfigOptions(result.configOptions) ? { configOptions: result.configOptions } : {}),
    }
    this.sessions.set(session.sessionId, session)
    this.acpIndex.set(session.acpSessionId, session)
    // First real session on this bridge: from here the process lives by the
    // agent's own residency rules, not the probe window it was born under.
    // Any armed timer computed its delay from the old window — drop it so the
    // touch below re-arms with the effective one.
    this.clearIdleTimer()
    this.everHostedSession = true
    this.hub.broadcast({ type: 'session/created', sessionId: session.sessionId, session: snapshot(session) })
    this.touch()
    return session
  }

  /**
   * Spawn a throwaway ACP session purely to read its `configOptions` (the
   * model catalog probe). Deliberately bypasses the live-session bookkeeping
   * so probe sessions never surface in the browser session list.
   *
   * THE PROBE SENDS THE AGENT'S OWN MCP LIST, not an empty one. Measured
   * against codebuddy: the servers handed to `session/new` land in the
   * agent PROCESS's dynamic MCP scope, so a probe that sent an empty list
   * would REPLACE that scope and drop the MCP servers of the live sessions
   * on the same connection (the agent logged
   * `serverManager.delete("injected")` and the live session's
   * `mcp__injected__*` tools disappeared). One list per agent process is the
   * only shape that keeps every session of that process consistent.
   */
  async probeConfigOptions(): Promise<unknown[]> {
    // A probe is the reason an agent process can be resident with NOTHING else
    // going on: it opens a session it deliberately never registers, so the
    // probe itself is the only thing keeping it from being idle-released.
    this.pendingProbes += 1
    try {
      await this.ensureReady()
      const conn = this.conn
      if (conn === undefined) throw new AcpError('agent_unreachable', 'acp: connection is not open')
      const resolved = resolveSessionCwd(this.def, undefined, p => realpathSync(p))
      const result = await this.withStartupTimeout(
        conn.agent.request(methods.agent.session.new, { cwd: resolved, mcpServers: toAcpMcpServers(this.def.mcpServers) }),
        'session/new',
      )
      await conn.agent.request(methods.agent.session.close, { sessionId: result.sessionId }).catch(() => { /* optional capability */ })
      return Array.isArray(result.configOptions) ? result.configOptions : []
    } finally {
      this.pendingProbes -= 1
      this.touch()
    }
  }

  /**
   * Fork one live session through the agent's own `session/fork` (the
   * UNSTABLE fourth session-creation point): the agent copies its internal
   * state into a NEW ACP session that remembers the parent's context — the
   * second half of a branched conversation, after the host's `sessions.fork`
   * has already built the DSH session tree. The child is addressed by the
   * CHILD DSH conversation id, so its first message reaches an agent that
   * actually remembers the parent.
   *
   * The parent must be live on this connection — a released parent has no
   * process to fork from (the browser blocks that click; this is the hard
   * stop behind it). The ACP request carries the SAME `mcpServers` list as
   * `session/new` / `session/load` (one list per process; an empty list would
   * evict the live sessions' MCP scope) and is bounded by the startup timeout
   * like every session-creation step. Counted in {@link pendingForks} while
   * in flight so an idle release cannot kill the child out from under the
   * caller.
   */
  async forkSession(parent: LiveSession, dshSessionId: string): Promise<LiveSession> {
    // A1 (F2): the fourth session-creation point is hard-disabled per agent;
    // a per-session child holds exactly the conversation it was spawned for.
    if (isPerSessionAgent(this.def.id)) {
      throw new AcpError('fork_unsupported', `acp: agent "${this.def.id}" runs one process per conversation and cannot fork`)
    }
    if (this.initResult?.agentCapabilities?.sessionCapabilities?.fork == null) {
      throw new AcpError('fork_unsupported', `acp: agent "${this.def.id}" does not advertise the session/fork capability`)
    }
    const conn = this.conn
    if (conn === undefined) throw new AcpError('agent_unreachable', 'acp: connection is not open')
    // The child runs where the parent runs: its cwd is the parent's already
    // validated workspace, re-trusted as its own extra root (the same minimal
    // trust `resolveSessionCwd` applied when the parent was created — never
    // the agent's configured sandbox cwd, which is not where the conversation
    // lives).
    const resolved = resolveSessionCwd(this.def, parent.cwd, p => realpathSync(p), [parent.cwd])
    this.pendingForks += 1
    try {
      const result = await this.withStartupTimeout(
        conn.agent.request(methods.agent.session.fork, {
          sessionId: parent.acpSessionId,
          cwd: resolved,
          mcpServers: toAcpMcpServers(this.def.mcpServers),
        }),
        'session/fork',
      )
      // A fork answer that names the parent (or any session already routed on
      // this connection) would interleave the parent's updates, asks and
      // permission cards into the child — refuse it rather than register it.
      if (typeof result.sessionId !== 'string' || result.sessionId === '') {
        throw new AcpError('fork_failed', 'acp: session/fork returned no session id')
      }
      if (result.sessionId === parent.acpSessionId || this.acpIndex.has(result.sessionId)) {
        throw new AcpError('fork_id_conflict', 'acp: session/fork returned an id that already exists on this connection')
      }
      const session: LiveSession = {
        sessionId: randomUUID(),
        agentId: this.def.id,
        acpSessionId: result.sessionId,
        cwd: resolved,
        running: false,
        turnSeq: 0,
        closed: false,
        released: false,
        lastAgentActivityAt: Date.now(),
        activeToolCalls: new Set(),
        transcript: new Transcript(this.transcriptMax),
        dshSessionId,
        ...(result.modes !== undefined && result.modes !== null
          ? {
            modes: {
              currentModeId: result.modes.currentModeId,
              availableModes: result.modes.availableModes.map(m => ({
                id: m.id,
                name: m.name,
                ...(m.description !== null ? { description: m.description } : {}),
              })),
            },
          }
          : {}),
        ...(usableConfigOptions(result.configOptions) ? { configOptions: result.configOptions } : {}),
      }
      // The fork answer's config options are the AGENT-LEVEL surface too (the
      // same feed `session/new` provides): absorb them so the composer chips
      // of the fresh conversation render without a probe.
      if (this.onCatalog !== undefined && usableConfigOptions(result.configOptions)) {
        this.onCatalog(this.def.id, result.configOptions)
      }
      this.sessions.set(session.sessionId, session)
      this.acpIndex.set(session.acpSessionId, session)
      // Same flip as `createSession`: a registered session makes this a chat
      // process; re-arm the idle clock on the agent's own window.
      this.clearIdleTimer()
      this.everHostedSession = true
      this.hub.broadcast({ type: 'session/created', sessionId: session.sessionId, session: snapshot(session) })
      this.touch()
      return session
    } finally {
      this.pendingForks -= 1
      this.touch()
    }
  }

  /**
   * Fire one prompt turn. Returns after the agent settles the turn; the caller
   * (manager) keeps the UI informed through broadcast events, so the RPC that
   * started the turn can answer `accepted` immediately.
   *
   * A `cancelled` stop on a turn the user never cancelled is the stale-cancel
   * swallow (the agent is still cleaning up the PREVIOUS cancel and answers
   * the new prompt from it — observed on codebuddy, which drops the message
   * without generating a turn). The same prompt is resent after
   * {@link BridgeTuning.staleCancelRetryDelayMs}, out-waiting the cleanup
   * window, bounded by {@link BridgeTuning.staleCancelMaxRetries}; a genuinely
   * requested cancel (`cancelRequestedAtTurn` still names this generation)
   * returns as-is — checked BOTH before the delay and after it, so a second
   * stop click inside the retry window does not resend the prompt the user
   * just stopped.
   *
   * `turnGen` is the {@link LiveSession.turnSeq} this prompt was sent for. A
   * stale-cancel resend is only allowed while that generation still owns the
   * session: once a successor turn began (the cancel fallback finalized this
   * one and the user moved on), resending would race a second `session/prompt`
   * into the successor's turn. The late answer is returned as-is instead.
   *
   * The RESPONSE's `_meta` travels with the stop reason: it is the only place
   * an agent says whether the prompt actually queued a conversation turn (see
   * `CodebuddyMeta.conversationRequestId`), which decides whether an instant
   * answer was the turn ending or a fold into a background drain.
   */
  async runPrompt(session: LiveSession, prompt: string | ContentBlock[], turnId: string, turnGen: number): Promise<{ stopReason: string; meta?: Record<string, unknown> }> {
    const conn = this.conn
    if (conn === undefined || session.closed || session.released) throw new AcpError('session_closed', 'acp: session is closed')
    this.touch()

    const blocks: ContentBlock[] = typeof prompt === 'string'
      ? [{ type: 'text', text: prompt }]
      : prompt

    if (blocks.length === 0) {
      throw new AcpError('empty_prompt', 'acp: prompt cannot be empty')
    }

    const hasImages = blocks.some(b => b.type === 'image')
    if (hasImages && this.initResult?.agentCapabilities?.promptCapabilities?.image !== true) {
      throw new AcpError('image_unsupported', `acp: agent "${this.def.id}" does not support image input`)
    }

    for (let attempt = 0; ; attempt += 1) {
      const promptSessionId = session.sessionId
      this.pendingPrompts.set(promptSessionId, (this.pendingPrompts.get(promptSessionId) ?? 0) + 1)
      // The response is activity too: the idle window must start at the turn's
      // END, not at the prompt that may have started a long time ago.
      const result = await conn.agent.request(methods.agent.session.prompt, {
        sessionId: session.acpSessionId,
        prompt: blocks,
      }).finally(() => {
        // Decrement on the response OR the failure: a killed connection must
        // not leave this bridge permanently "busy" and unprunable.
        const remaining = (this.pendingPrompts.get(promptSessionId) ?? 1) - 1
        if (remaining > 0) this.pendingPrompts.set(promptSessionId, remaining)
        else this.pendingPrompts.delete(promptSessionId)
        this.touch()
      })
      const answered = () => ({
        stopReason: result.stopReason,
        ...(result._meta !== undefined && result._meta !== null ? { meta: result._meta } : {}),
      })
      if (result.stopReason !== 'cancelled' || session.cancelRequestedAtTurn === session.turnSeq) {
        return answered()
      }
      // The turn this answer belongs to no longer owns the session (a cancel
      // fallback finalized it and a successor began): resending would fire a
      // second `session/prompt` into the successor's turn.
      if (session.turnSeq !== turnGen) return answered()
      if (attempt >= this.staleCancelMaxRetries) return answered()
      await new Promise(resolve => setTimeout(resolve, this.staleCancelRetryDelayMs))
      if (session.closed || this.conn !== conn) throw new AcpError('session_closed', 'acp: session is closed')
      // Re-check after the delay: the successor may have started while waiting.
      if (session.turnSeq !== turnGen) return answered()
      // ...and a SECOND stop during the delay names this same generation. The
      // user already said stop, so the stale-cancel answer is not a swallow to
      // out-wait anymore: resending would make the agent run the prompt the
      // user just stopped (the double-click case). Return as-is.
      if (session.cancelRequestedAtTurn === session.turnSeq) return answered()
      this.touch()
    }
  }

  async cancel(session: LiveSession): Promise<void> {
    if (this.conn === undefined) return
    this.touch()
    // Name the generation this cancel belongs to, so `runPrompt` can tell a
    // real cancel apart from a stale one and the fallback timer can tell its
    // own turn apart from a later one.
    session.cancelRequestedAtTurn = session.turnSeq
    await this.conn.agent.notify(methods.agent.session.cancel, { sessionId: session.acpSessionId }).catch(() => { /* best effort */ })
    // The ACP spec's counterpart to the notification we just sent: a client that
    // cancels MUST answer every pending `session/request_permission` with
    // `cancelled`. Leaving them open would hold the agent's tool call blocked on
    // an answer that can no longer arrive — the turn is over, the human's
    // decision is "stop". OmniTerm does the same from `AcpClient::cancel`
    // (`PermissionManager::cancel_all`).
    this.settlePermissions(session)
    this.armCancelFallback(session)
  }

  /**
   * An agent that ignores the `session/cancel` notification must not wedge the
   * session in `running` forever (every later prompt would fail with
   * `turn_in_flight`), nor leave the adapter turn's settle gate hanging (every
   * later prompt would fail with `unsettled`). Force-finalize the turn after
   * the grace period; the real `session/prompt` response may still arrive
   * later and is folded in by the manager as usual.
   *
   * The timer is generation-guarded: it belongs to the turn `cancel` was
   * called for. If that turn already ended and a LATER turn is on air (the
   * agent settled late, the user moved on), firing would murder the innocent
   * successor — so a moved-on {@link LiveSession.turnSeq} disarms it.
   */
  private armCancelFallback(session: LiveSession): void {
    if (this.cancelFallbackMs <= 0) return
    const turnGen = session.turnSeq
    const timer = setTimeout(() => {
      this.finalizeTurn(
        session,
        turnGen,
        `agent "${this.def.id}" did not respond to the cancel request within ${String(Math.round(this.cancelFallbackMs / 1000))}s; the turn was force-finalized`,
      )
    }, this.cancelFallbackMs)
    timer.unref?.()
  }

  /**
   * Force the local end of one turn whose agent never acknowledged it: clear
   * `running`, open the settle gate, and end the turn. Shared by the cancel
   * fallback and the stall watchdog.
   *
   * A live controller owns the turn's streaming face — its segment queue, its
   * ambient clocks and its `turn/end` id. Ending the turn behind its back
   * would leave the driver step parked on an open queue, and the controller's
   * own timers would later broadcast a SECOND `turn/end` for a turn already
   * closed. So when the session still points at a current controller, the
   * force goes THROUGH it (`forceFinalize`), which runs the same closing work
   * as a normal settle exactly once. Only a turn with no live controller (an
   * `/acp`-RPC turn, or one already retired) falls back to the local broadcast
   * with `turnId: ''` — there is no stream whose id could be named.
   *
   * Generation-guarded: a turn that already ended — or that a later turn
   * superseded — is not this call's to finalize. Returns whether it acted; a
   * `false` means the caller was late and must leave the session alone.
   */
  finalizeTurn(session: LiveSession, turnGen: number, message: string): boolean {
    if (session.closed || session.turnSeq !== turnGen) return false
    const controller = session.turnController
    if (controller !== undefined && !controller.stale) {
      controller.forceFinalize({ kind: 'error', message })
      return true
    }
    // Nothing is in flight anymore (the turn settled on its own): nothing to
    // finalize. A still-pending settle gate counts as in flight even though
    // the stream is gone — that gate is what the next prompt waits on.
    if (!session.running && session.settled === undefined) return false
    session.running = false
    this.openSettleGate(session)
    this.hub.broadcast({
      type: 'turn/end',
      sessionId: session.sessionId,
      turnId: '',
      error: message,
    })
    return true
  }

  /**
   * Bring a released session back on a fresh agent process via
   * `session/load` ("send to recover"). Concurrent callers share one inflight
   * resume. The agent replays its history as fresh `session/update`s while
   * the load request is still in flight, so the session re-registers with the
   * update router and broadcasts `session/reset` BEFORE the request goes out;
   * on failure the record is parked back into the released map so a later
   * prompt can retry.
   */
  resumeSession(session: LiveSession): Promise<LiveSession> {
    const inflight = this.resuming.get(session.sessionId)
    if (inflight !== undefined) return inflight
    // An inflight resume also counts as work (see `releaseIfIdle`).
    this.touch()
    const promise = this.doResumeSession(session).finally(() => {
      this.resuming.delete(session.sessionId)
    })
    this.resuming.set(session.sessionId, promise)
    return promise
  }

  private async doResumeSession(session: LiveSession): Promise<LiveSession> {
    try {
      // The cwd was validated when the session was created, but allowed roots
      // may have narrowed since; re-check before handing the path back. A chat
      // session's cwd is its DSH workspace (never in the agent's own roots), so
      // that root has to be re-trusted here too — otherwise a crash would park
      // the session in `released` forever with `cwd_denied`. The same workspace
      // is what the resumed process must RUN in, or an agent that reads its
      // workspace from its own cwd would come back in the plugin's sandbox.
      const workspaceRoot = chatWorkspaceRoot(this.sessionWorkspace?.(), session.dshSessionId)
      await this.ensureReady(workspaceRoot)
      // The CONNECTION first: a teardown that landed during the start leaves no
      // `initResult` either, and reporting that as `resume_unsupported` would
      // blame the agent for a capability it may well have. "The bridge is not
      // up" is the honest answer.
      const conn = this.conn
      if (conn === undefined) throw new AcpError('agent_unreachable', 'acp: connection is not open')
      // The capability comes from the FRESH initialize: after a crash the
      // bridge restarts the process, so check the (new) initResult here.
      if (this.initResult?.agentCapabilities?.loadSession !== true) {
        throw new AcpError('resume_unsupported', `acp: agent "${this.def.id}" does not advertise the loadSession capability; start a new session`)
      }
      const resolved = resolveSessionCwd(this.def, session.cwd, p => realpathSync(p), workspaceRoot === undefined ? [] : [workspaceRoot])
      // Replay arrives as brand-new updates, so the transcript restarts too;
      // seq keeps meaning "position in the current epoch". What the buffer held
      // is now the agent's to replay — remember that there IS history before
      // dropping it, or a failed resume parks an empty buffer back and the
      // view claims the conversation never happened.
      session.hasHistory = session.hasHistory === true || session.transcript.since(0).length > 0
      session.transcript = new Transcript(this.transcriptMax)
      session.cwd = resolved
      session.running = false
      session.closed = false
      session.released = false
      // A resume is a fresh agent-side state: nothing from the dead process's
      // turn survives it, including the settle gate and the stall markers. A
      // background drain belonged to that process too.
      session.orphanPromptTurnSeq = undefined
      session.reclaimedTurnSeq = undefined
      session.activeToolCalls.clear()
      clearAmbientState(session)
      session.lastAgentActivityAt = Date.now()
      this.openSettleGate(session)
      // Route replay updates into the fresh transcript while the load request
      // is in flight, and let the browser drop its blocks/watermark first.
      this.acpIndex.set(session.acpSessionId, session)
      this.hub.broadcast({ type: 'session/reset', sessionId: session.sessionId, session: snapshot(session) })
      const result = await this.withStartupTimeout(
        conn.agent.request(methods.agent.session.load, { sessionId: session.acpSessionId, cwd: resolved, mcpServers: toAcpMcpServers(this.def.mcpServers) }),
        'session/load',
      )
      if (this.onCatalog !== undefined && usableConfigOptions(result.configOptions)) {
        this.onCatalog(this.def.id, result.configOptions)
      }
      session.modes = result.modes !== undefined && result.modes !== null
        ? {
          currentModeId: result.modes.currentModeId,
          availableModes: result.modes.availableModes.map(m => ({
            id: m.id,
            name: m.name,
            ...(m.description !== null ? { description: m.description } : {}),
          })),
        }
        : session.modes
      if (usableConfigOptions(result.configOptions)) session.configOptions = result.configOptions
      this.sessions.set(session.sessionId, session)
      this.released.delete(session.sessionId)
      // Same flip as `createSession`: a registered session makes this a chat
      // process; re-arm the idle clock on the agent's own window.
      this.clearIdleTimer()
      this.everHostedSession = true
      this.touch()
      // Republish so configOptions/modes observed on load reach the browser.
      this.hub.broadcast({ type: 'session/meta', sessionId: session.sessionId, session: snapshot(session) })
      this.onSessionsDirty?.()
      return session
    } catch (error) {
      this.acpIndex.delete(session.acpSessionId)
      this.sessions.delete(session.sessionId)
      session.released = true
      this.released.set(session.sessionId, session)
      this.hub.broadcast({ type: 'session/released', sessionId: session.sessionId, session: snapshot(session), reason: 'resume failed', cause: 'resume-failed' })
      this.onSessionsDirty?.()
      throw error
    }
  }

  /**
   * Release all live sessions (process died or went idle): keep them resumable,
   * settle permissions, drop the connection.
   *
   * Deliberately does NOT bump `teardownEpoch`: a child's death during startup
   * runs through `connectionLost` into this method, and that start must still
   * publish `error` with its stderr tail — the settings card expands on exactly
   * that pair (see `view` / `teardownEpoch`).
   */
  releaseAll(reason: string, cause: AcpReleaseCause): void {
    this.clearIdleTimer()
    this.parkSessions(reason, cause)
    this.conn?.close()
    this.conn = undefined
    this.killChild()
    this.state = 'stopped'
    this.initResult = undefined
    this.publishStatus()
  }

  /**
   * Park every live session as RELEASED — resumable through `session/load`,
   * never destroyed — and persist the records.
   *
   * This is the local half shared by `releaseAll` (crash / idle / workspace) and
   * `shutdown` (host exit): those paths differ only in what happens to the child
   * afterwards. A `closed` session is skipped — its record belongs to
   * `closeSession`, and flipping it to released would let a resume resurrect a
   * conversation that is being destroyed (constraint 10).
   *
   * Returns how many sessions were parked, so a shutdown with nothing to park
   * does not rewrite the state file (a second `shutdownAll` must not erase the
   * records the first one persisted).
   */
  private parkSessions(reason: string, cause: AcpReleaseCause): number {
    let parked = 0
    for (const session of [...this.sessions.values()]) {
      // A session already being closed is `closeSession`'s to delete. Marking
      // it released would park it as resumable, and `doResumeSession` flips
      // `closed` back to false — an idle release resurrecting a closed session.
      if (session.closed) continue
      // The process that owed the turn is gone, so no worker is still running:
      // every still-open dispatch becomes `unknown` before the turn/end below.
      this.onSessionBackgroundTeardown?.(session, 'unknown')
      if (session.running) {
        session.running = false
        this.hub.broadcast({ type: 'turn/end', sessionId: session.sessionId, turnId: '', error: reason })
      }
      // The process that owed the turn is gone: leaving its settle gate closed
      // would make the next prompt wait for an answer that can no longer come.
      this.openSettleGate(session)
      // No call from the dead process can still be running: drop the tool set
      // so a resumed turn starts on the plain window. A background drain died
      // with it, and a stale ambient would misclassify the NEXT prompt.
      session.activeToolCalls.clear()
      clearAmbientState(session)
      session.released = true
      this.settlePermissions(session)
      this.released.set(session.sessionId, session)
      this.hub.broadcast({ type: 'session/released', sessionId: session.sessionId, session: snapshot(session), reason, cause })
      parked += 1
    }
    this.sessions.clear()
    this.acpIndex.clear()
    // The parked records are what keeps them resumable after a host restart —
    // persist now, while their transcripts (the `hasHistory` evidence) are
    // still the ones they were parked with.
    if (parked > 0) this.onSessionsDirty?.()
    return parked
  }

  /** Detach one released session record for a resume attempt. */
  takeReleased(sessionId: string): LiveSession | undefined {
    const session = this.released.get(sessionId)
    if (session === undefined) return undefined
    this.released.delete(sessionId)
    return session
  }

  /** Drop a released session record for good (user closed it or the agent was stopped). */
  dropReleased(sessionId: string): boolean {
    return this.released.delete(sessionId)
  }

  /**
   * Register a session record restored from disk as already parked: a host
   * restart killed every process, so it comes back exactly as `releaseAll`
   * would have left it — resumable via `session/load`, never live.
   */
  parkReleased(session: LiveSession): void {
    this.released.set(session.sessionId, session)
  }

  get releasedList(): LiveSession[] {
    return [...this.released.values()]
  }

  hasReleased(sessionId: string): LiveSession | undefined {
    return this.released.get(sessionId)
  }

  inflightResume(sessionId: string): Promise<LiveSession> | undefined {
    return this.resuming.get(sessionId)
  }

  /** Run one host→agent command as work, so an idle teardown cannot cut it. */
  private async runCommand<T>(session: LiveSession, request: () => Promise<T>): Promise<T> {
    this.pendingCommands.set(session.sessionId, (this.pendingCommands.get(session.sessionId) ?? 0) + 1)
    this.touch()
    try {
      return await request()
    } finally {
      const remaining = (this.pendingCommands.get(session.sessionId) ?? 1) - 1
      if (remaining > 0) this.pendingCommands.set(session.sessionId, remaining)
      else this.pendingCommands.delete(session.sessionId)
      this.touch()
    }
  }

  async setMode(session: LiveSession, modeId: string): Promise<void> {
    const conn = this.conn
    if (conn === undefined) throw new AcpError('agent_unreachable', 'acp: connection is not open')
    await this.runCommand(session, () => conn.agent.request(methods.agent.session.setMode, { sessionId: session.acpSessionId, modeId }))
    // Well-behaved agents push `current_mode_update`, but the spec does not
    // require it — apply locally so the browser selector never goes stale.
    if (session.modes !== undefined) session.modes = { ...session.modes, currentModeId: modeId }
    this.publishMeta(session)
  }

  async setConfigOption(session: LiveSession, configId: string, value: string | boolean): Promise<void> {
    const conn = this.conn
    if (conn === undefined) throw new AcpError('agent_unreachable', 'acp: connection is not open')
    // A toggle must say so on the wire: the request union discriminates on
    // `type`, and a bare boolean `value` is not a select value id.
    const params = typeof value === 'boolean'
      ? { sessionId: session.acpSessionId, configId, value, type: 'boolean' as const }
      : { sessionId: session.acpSessionId, configId, value }
    const result = await this.runCommand(session, () => conn.agent.request(methods.agent.session.setConfigOption, params)) as { configOptions?: unknown }
    // The response carries the full authoritative option set; some agents
    // (pi-acp observed) never re-notify after a client-driven set. It feeds the
    // SESSION snapshot first — `currentValue` in a per-session answer describes
    // this session's pick, and promoting it to the catalog would turn the
    // seat's own choice into `reasoning.defaultEffort` for every other
    // conversation (and back onto itself next turn). The option SHAPE still
    // reaches the agent-level catalog (`shapeOnly`): this response is often the
    // only place an agent publishes how its option set changes with the model
    // (opencode offers `thought_level` just for models with variants), and the
    // composer's thought chip is driven by the catalog.
    if (usableConfigOptions(result.configOptions)) {
      session.configOptions = result.configOptions
      this.onCatalog?.(this.def.id, result.configOptions, true)
    }
    this.publishMeta(session)
  }

  private publishMeta(session: LiveSession): void {
    this.hub.broadcast({ type: 'session/meta', sessionId: session.sessionId, session: snapshot(session) })
  }

  async closeSession(session: LiveSession, reason: 'closed' | 'agent-stopped' | 'agent-died'): Promise<void> {
    if (session.closed) return
    session.closed = true
    // The session is going away: whatever background drain it announced ends
    // with it (a re-created session must not inherit a stale ambient).
    clearAmbientState(session)
    // ...and so does every still-open dispatch record of this session; a closed
    // session is not a cancelled worker.
    this.onSessionBackgroundTeardown?.(session, 'unknown')
    // ...and so does its prompt slot: nothing may keep rejecting a new prompt
    // for a record that is being deleted.
    session.promptInFlight = false
    // Closing a session is activity of its own: restart the idle window here
    // rather than at the prompt that opened it.
    this.touch()
    // Answer every outstanding ask BEFORE `session/close` is awaited: an agent
    // blocked on an unanswered `session/request_permission` would otherwise be
    // able to hold the close open indefinitely.
    this.settlePermissions(session)
    const conn = this.conn
    if (conn !== undefined && this.state === 'ready') {
      // `session/close` is an optional capability; the local teardown stands
      // regardless. Bound the wait: a wedged agent that ignores the request
      // must not hang the caller (the stall reclaim stops through here), so
      // the request is raced against a timeout and left behind if it loses.
      const close = conn.agent.request(methods.agent.session.close, { sessionId: session.acpSessionId }).catch(() => { /* unsupported */ })
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([
          close,
          new Promise<void>(resolve => {
            timer = setTimeout(resolve, SESSION_CLOSE_TIMEOUT_MS)
            timer.unref?.()
          }),
        ])
      } finally {
        if (timer !== undefined) clearTimeout(timer)
      }
    }
    this.sessions.delete(session.sessionId)
    this.acpIndex.delete(session.acpSessionId)
    this.hub.broadcast({ type: 'session/closed', sessionId: session.sessionId, reason })
  }

  get sessionList(): LiveSession[] {
    return [...this.sessions.values()]
  }

  hasSession(sessionId: string): LiveSession | undefined {
    return this.sessions.get(sessionId)
  }

  /** Kill the child and drop every local session bound to this connection. */
  async stop(reason: 'closed' | 'agent-stopped' | 'agent-died' = 'agent-stopped'): Promise<void> {
    // Deliberate teardown: an in-flight start owns nothing any more, and must
    // not be able to publish `ready` over the stopped state that follows.
    this.teardownEpoch += 1
    // Drop the memoized start: a later `ensureReady` must not adopt a promise
    // whose result was already discarded. That promise's own `finally`
    // re-checks identity, so it cannot clear a NEWER start's slot.
    this.starting = undefined
    this.clearIdleTimer()
    for (const session of [...this.sessions.values()]) {
      await this.closeSession(session, reason)
    }
    // A deliberate stop is not a crash: nothing stays resumable.
    this.released.clear()
    this.conn?.close()
    this.conn = undefined
    this.killChild()
    this.state = 'stopped'
    this.initResult = undefined
    this.publishStatus()
  }

  /**
   * Drop every live session record and kill the child WITHOUT asking the agent
   * to close them. `stop` sends `session/close` per session, and a wedged agent
   * that ignores it would hang the caller (the stall reclaim) — the very agent
   * this teardown exists to get rid of. The local teardown is what frees the
   * sessions, so it runs unconditionally and immediately.
   *
   * Deliberately does NOT clear `released`: those records are constraint 10's
   * — a released session survives a process death and is resumed by its next
   * message. This is a stop, not a discard.
   */
  forceReset(reason: 'agent-stopped'): void {
    this.teardownEpoch += 1
    this.starting = undefined
    this.clearIdleTimer()
    for (const session of [...this.sessions.values()]) {
      session.closed = true
      this.settlePermissions(session)
      this.openSettleGate(session)
      session.activeToolCalls.clear()
      // A forced teardown never closes its turn: every still-open dispatch
      // becomes `unknown` here.
      this.onSessionBackgroundTeardown?.(session, 'unknown')
      clearAmbientState(session)
      this.sessions.delete(session.sessionId)
      this.acpIndex.delete(session.acpSessionId)
      this.hub.broadcast({ type: 'session/closed', sessionId: session.sessionId, reason })
    }
    this.conn?.close()
    this.conn = undefined
    this.killChild()
    this.state = 'stopped'
    this.initResult = undefined
    this.publishStatus()
  }

  /**
   * Fire-and-forget kill for the NON-teardown paths: idle release, workspace
   * move, crash handling, `forceReset`, and a start's own failure. None of them
   * may block on a dying process, and CRASH ≠ DESTROY (constraint 10): the
   * sessions were already parked by the caller, this only takes the process
   * away. The awaitable variant is `killChildAndWait`, used by host shutdown.
   */
  private killChild(): void {
    const child = this.child
    this.child = undefined
    // No child, no recorded spawn cwd: the next spawn decides its own (see
    // `spawnAndConnect`). Leaving it behind would make `ensureReady` believe a
    // process is still running in that directory.
    this.spawnCwd = undefined
    if (child === undefined) return
    void disposeChild(child, KILL_ESCALATION_DELAY_MS)
  }

  /**
   * Take the current child away and WAIT until it is gone (bounded). Only the
   * host shutdown path uses this — every other teardown must stay
   * fire-and-forget.
   *
   * Always resolves: a teardown that could hang on an agent ignoring SIGTERM
   * would be worse than a leaked process, and the process-exit reaper
   * (`reapLiveChildren`) still holds the pid if even the escalation loses.
   */
  private async killChildAndWait(budgetMs: number): Promise<void> {
    const child = this.child
    this.child = undefined
    this.spawnCwd = undefined
    if (child === undefined) return
    await disposeChild(child, budgetMs)
  }

  /**
   * Host shutdown: park every live session as RELEASED (resumable, exactly as a
   * crash would leave it), then WAIT for the child to die.
   *
   * Deliberately not `stop`: `stop` asks every session's agent to
   * `session/close` and then clears the released records — i.e. it DESTROYS the
   * conversations. A host shutdown is not the user's "stop this agent" gesture:
   * the host is coming back, and the conversations must come back with it
   * (constraint 10, plus the `chatSessions` records that outlive the restart).
   * Skipping the per-session RPC is also what keeps teardown bounded: N sessions
   * would otherwise spend up to N × SESSION_CLOSE_TIMEOUT_MS before the child
   * was even signalled, and the process is about to die anyway — "the agent
   * forgot this session" costs nothing a `session/load` cannot rebuild.
   *
   * Always resolves: `budgetMs` bounds the WHOLE kill — parking is synchronous,
   * the graceful wait and the escalation both come out of the same deadline,
   * and whatever still lives after it is the exit reaper's.
   */
  async shutdown(budgetMs: number = SHUTDOWN_BUDGET_MS): Promise<void> {
    const deadline = Date.now() + Math.max(0, budgetMs)
    // A deliberate teardown: an in-flight start must not publish `ready` (or
    // leave its process running) over the stopped state this leaves behind.
    this.teardownEpoch += 1
    this.starting = undefined
    this.clearIdleTimer()
    this.parkSessions('the host is shutting down', 'shutdown')
    this.conn?.close()
    this.conn = undefined
    this.state = 'stopped'
    this.initResult = undefined
    this.publishStatus()
    await this.killChildAndWait(Math.max(0, deadline - Date.now()))
  }

  /**
   * Answer one ACP permission ask.
   *
   * EVERY ask is answered by a human through the plugin's own ledger. The
   * host's approval chain is deliberately not involved: it could accept an ask
   * and render nothing, leaving the turn hanging behind something invisible
   * with no deadline (issue #2). The ledger broadcasts `permission/request`,
   * the browser renders the answerable card, and `permission/respond` settles
   * it.
   *
   * The host answers on its own only when a deadline expires: `abort` refuses,
   * `auto` picks the option the agent's own kinds imply, `wait` never expires.
   * The ACP request's own `signal` (the agent withdrawing the ask, or the
   * connection dying) settles the same entry cancelled, so a withdrawn ask can
   * never leave a stale card behind.
   */
  private async handlePermissionRequest(acpSessionId: string, toolCall: unknown, options: PermissionOption[], signal?: AbortSignal): Promise<RequestPermissionResponse> {
    const session = this.acpIndex.get(acpSessionId)
    if (session === undefined || session.closed) return { outcome: { outcome: 'cancelled' } }
    // An ask is the agent speaking, not silence: the stall watchdog measures
    // from here, and the pending ask exempts the session anyway.
    session.lastAgentActivityAt = Date.now()
    // The deadline and the mode are read ONCE, here: an ask that started under
    // one pair keeps it, even if the settings page rewrites them mid-flight.
    const mode = this.permissionTimeoutMode
    const timeoutMs = this.permissionTimeoutMs
    // 不等待（0）只属自动推进：请求到达即按那一档收场，不建 ledger 条目、不发卡
    // ——问都来不及问。超时中止没有这一档（它会立刻拒绝每一问，agent 在每个门口
    // 都停住），它的窗口最短是真实等待。
    if (mode === 'auto' && timeoutMs === 0) {
      return this.settleExpiredAsk(session, mode, toolCall, options, 0)
    }
    const optionViews = options.map((o): PermissionOptionView => ({ optionId: o.optionId, name: o.name, kind: o.kind }))
    const reason = permissionAskReason(toolCall)
    // Computed once, at ask creation: the frame, the chat line and the timer
    // all describe the same instant, and a slow reader cannot stretch it.
    const deadlineAt = timeoutMs > 0 && mode !== 'wait' ? Date.now() + timeoutMs : undefined
    const view = {
      ...(session.dshSessionId === undefined ? {} : { dshSessionId: session.dshSessionId }),
      // Kept whole for the reconnect replay: a client that connects after the
      // ask was broadcast must be re-shown the very card it has to answer.
      toolCall,
      toolName: permissionToolName(toolCall),
      ...(reason === '' ? {} : { reason }),
      options: optionViews,
      timeoutMode: mode,
      ...(deadlineAt === undefined ? {} : { deadlineAt }),
    }
    return new Promise<RequestPermissionResponse>(resolve => {
      let timer: ReturnType<typeof setTimeout> | undefined
      let detachSignal: (() => void) | undefined
      const requestId = this.permissions.create(session.sessionId, (outcome: PermissionOutcome) => {
        clearTimeout(timer)
        detachSignal?.()
        this.touch()
        // The answer releases the agent to continue; the turn's clock restarts
        // here, not at the ask that may have waited on a human for minutes.
        session.lastAgentActivityAt = Date.now()
        this.hub.broadcast({
          type: 'permission/resolved',
          requestId,
          sessionId: session.sessionId,
          outcome,
        })
        resolve(outcome.outcome === 'selected'
          ? { outcome: { outcome: 'selected', optionId: outcome.optionId } }
          : { outcome: { outcome: 'cancelled' } })
      }, view)
      // The live frame and the replay frame come from ONE builder, so a
      // reconnecting client receives exactly what a live one did.
      this.hub.broadcast(permissionRequestFrame({ requestId, sessionId: session.sessionId, ...view }))
      if (deadlineAt !== undefined) {
        timer = setTimeout(() => {
          if (!this.permissions.has(requestId)) return
          // Settle IN PLACE: exactly one notice, one `permission/expired` (the
          // conversation's trace of the expiry) and the ledger answer.
          const outcome = this.announceExpiredAsk(session, mode, toolCall, options, timeoutMs)
          this.permissions.respond(requestId, outcome)
        }, Math.max(0, deadlineAt - Date.now()))
        timer.unref?.()
      }
      // The agent's own withdrawal settles the entry cancelled; the ledger's
      // resolve callback broadcasts `permission/resolved`, and drops this
      // listener, so nothing outlives the ask.
      if (signal !== undefined) {
        const onAbort = (): void => {
          if (!this.permissions.has(requestId)) return
          this.permissions.respond(requestId, { outcome: 'cancelled' })
        }
        if (signal.aborted) {
          onAbort()
          return
        }
        signal.addEventListener('abort', onAbort, { once: true })
        detachSignal = () => { signal.removeEventListener('abort', onAbort) }
      }
    })
  }

  /**
   * Announce and compute one ask's expiry. Shared by the 不等待 arrival path
   * and the ledger deadline, so an expiry can never broadcast two notices or
   * skip the `permission/expired` line: once the card is gone that frame is
   * the conversation's only trace of what happened to the question.
   */
  private announceExpiredAsk(
    session: LiveSession,
    mode: PermissionTimeoutMode,
    toolCall: unknown,
    options: PermissionOption[],
    timeoutMs: number,
  ): PermissionOutcome {
    const picked = mode === 'auto'
      ? pickAutoOption(options.map(option => ({ optionId: option.optionId, name: option.name, kind: option.kind })))
      : undefined
    const outcome: PermissionOutcome = picked === undefined
      ? { outcome: 'cancelled' }
      : { outcome: 'selected', optionId: picked.optionId }
    const tool = permissionToolName(toolCall)
    // 不等待（0）不是「等了 0 秒」，是没等：两种说法的区别就在这里。
    const waited = timeoutMs > 0
      ? `timed out after ${String(Math.round(timeoutMs / 1000))}s`
      : 'was not waited for'
    this.hub.broadcast({
      type: 'agent/notice',
      agentId: this.def.id,
      level: 'info',
      // Name what was missed and what was done about it — the way a human
      // needs it: which operation sat unanswered, and what the plugin answered
      // instead. OmniTerm's reaper writes the same "you missed this" notice.
      text: picked === undefined
        ? `acp: permission request for "${tool}" ${waited}; refused`
        : `acp: permission request for "${tool}" ${waited}; answered "${picked.name}"`,
    })
    this.hub.broadcast({
      type: 'permission/expired',
      sessionId: session.sessionId,
      toolCall,
      timeoutMs,
      outcome,
      ...(picked === undefined ? {} : { optionName: picked.name }),
    })
    return outcome
  }

  /**
   * Settle the 不等待 (`auto` + zero window) ask on arrival: no ledger entry
   * and no card — nothing asks a human, so there is nothing to show. `auto`
   * answers with the option the agent's own kinds imply ({@link pickAutoOption})
   * and the agent CONTINUES. A mode that cannot pick an option (no options, or
   * none with a usable id) degrades to refusing: safer than guessing, and
   * hanging is worse than either.
   */
  private settleExpiredAsk(
    session: LiveSession,
    mode: PermissionTimeoutMode,
    toolCall: unknown,
    options: PermissionOption[],
    timeoutMs: number,
  ): RequestPermissionResponse {
    session.lastAgentActivityAt = Date.now()
    const outcome = this.announceExpiredAsk(session, mode, toolCall, options, timeoutMs)
    return outcome.outcome === 'selected'
      ? { outcome: { outcome: 'selected', optionId: outcome.optionId } }
      : { outcome: { outcome: 'cancelled' } }
  }

  private settlePermissions(session: LiveSession): void {
    this.permissions.settleFor(p => p.sessionId === session.sessionId)
  }

  /** `fs/read_text_file` for agents that fetch workspace content through the
   * client. Every path passes the same workspace guard as session cwds
   * (resolveFsPath); violations answer as JSON-RPC internal errors so the
   * agent sees a refusal instead of file contents.
   */
  private handleFsRead(params: { sessionId: string; path: string; line?: number | null; limit?: number | null }): { content: string } {
    const session = this.acpIndex.get(params.sessionId)
    if (session === undefined) {
      throw fsRequestError(`acp: fs request for unknown session ${params.sessionId}`)
    }
    const path = this.guardFsPath(session, params.path)
    if (statSync(path).size > FS_MAX_READ_BYTES) {
      throw fsRequestError(`acp: fs read refused: ${path} exceeds ${String(FS_MAX_READ_BYTES)} bytes; page with line/limit or read smaller files`)
    }
    let content = readFileSync(path, 'utf8')
    if (params.line != null || params.limit != null) {
      const lines = content.split('\n')
      const start = Math.max(0, (params.line ?? 1) - 1)
      const end = params.limit != null ? start + params.limit : lines.length
      content = lines.slice(start, end).join('\n')
    }
    return { content }
  }

  /**
   * `fs/write_text_file`; parent directories are created inside the boundary.
   *
   * The workspace guard (`guardFsPath`) is the only fence, and it is the one
   * that has always applied: a write outside the session's resolved roots is
   * refused. There is deliberately NO extra access-mode layer — DSH's sandbox
   * cannot reach into the agent's own process, so a second gate here would only
   * be a fiction in front of a tool that can write without asking us at all.
   * What the agent chooses to ask about goes to the human unchanged
   * (`handlePermissionRequest`). See docs/acp-convergence.md §2.3.
   */
  private async handleFsWrite(params: { sessionId: string; path: string; content: string }): Promise<{ }> {
    const session = this.acpIndex.get(params.sessionId)
    if (session === undefined) {
      throw fsRequestError(`acp: fs request for unknown session ${params.sessionId}`)
    }
    if (params.content.length > FS_MAX_WRITE_BYTES) {
      throw fsRequestError(`acp: fs write refused: payload exceeds ${String(FS_MAX_WRITE_BYTES)} bytes`)
    }
    const path = this.guardFsPath(session, params.path)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, params.content, 'utf8')
    return { }
  }

  private guardFsPath(session: LiveSession, requested: string): string {
    try {
      return resolveFsPath(session.cwd, [...(this.def.allowedCwdRoots ?? []), session.cwd], requested, p => realpathSync(p))
    } catch (error) {
      throw fsRequestError(`acp: fs access denied: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  private handleSessionUpdate(params: SessionNotification): void {
    const session = this.acpIndex.get(params.sessionId)
    if (session === undefined) return // update for a session already closed locally
    // `closeSession` marks the record synchronously and then awaits the
    // agent's `session/close`; an update racing that wait must not revive
    // activity (e.g. report a new dispatch) on a record already going away.
    if (session.closed) return
    // Detached-worker / drain bookkeeping runs BEFORE the turn controller and
    // the cursor: a worker may report after the turn that dispatched it closed,
    // and the session-level record is the only place that fact can land.
    this.onSessionBackgroundUpdate?.(session, params.update)
    // Any update is the agent speaking: restart the stall clock here. A
    // tool-call status also says whether the agent is inside a long-running
    // tool, which earns the wider watchdog window.
    session.lastAgentActivityAt = Date.now()
    const kind = params.update.sessionUpdate
    const meta = codebuddyMetaOf(params.update)
    // A RETIRED drain that speaks again is alive, not retired. Un-retire it
    // BEFORE this update is classified and rebuild the ambient record: the run
    // may never re-announce itself, yet the next prompt folded into it must
    // still be recognised as steered and receive the drain's text. A
    // re-announcement below does the same for its id.
    if (meta?.requestId !== undefined && isRetiredAmbientId(session, meta.requestId)) {
      reviveAmbientId(session, meta.requestId)
      session.ambient = {
        requestId: meta.requestId,
        startedAt: session.ambient?.startedAt ?? Date.now(),
        lastActivityAt: Date.now(),
        sawOutput: session.ambient?.sawOutput ?? false,
      }
    }
    if (meta?.unsolicitedTurn !== undefined) {
      // The agent started a background turn on its own: remember it so a
      // prompt the agent folds into it (answered instantly, no conversation
      // request id) can be kept open until the drain speaks. Announced once per
      // request id — a repeated announcement is the same run, not news.
      const run = meta.unsolicitedTurn
      // A re-announcement also revives a drain whose wait already closed: the
      // same run is alive, and the notice de-dupe set keeps it silent.
      reviveAmbientId(session, run.requestId)
      session.ambient = { requestId: run.requestId, startedAt: Date.now(), lastActivityAt: Date.now(), sawOutput: false }
      const announced = session.ambientNotices ?? new Set<string>()
      session.ambientNotices = announced
      if (!announced.has(run.requestId)) {
        announced.add(run.requestId)
        // The de-dupe set outlives individual turns (a hard ceiling keeps the
        // drain record), so it is bounded: evict the oldest ids first.
        while (announced.size > AMBIENT_NOTICE_MAX) {
          const oldest = announced.values().next().value
          if (oldest === undefined) break
          announced.delete(oldest)
        }
        this.hub.broadcast({
          type: 'agent/notice',
          agentId: session.agentId,
          level: 'info',
          text: `acp: agent "${this.def.id}" started a background task turn (${run.reason ?? 'unsolicited'}); its output will appear in the ACP transcript view, or in the turn that was waiting for it.`,
        })
      }
    }
    if (session.ambient !== undefined
      && meta?.requestId === session.ambient.requestId) {
      // The run is alive: refresh the staleness clock on ANY update it owns,
      // not just prose (a tool-heavy stretch is still the drain working).
      session.ambient.lastActivityAt = Date.now()
      if ((kind === 'agent_message_chunk' || kind === 'agent_thought_chunk')
        && chunkTextOf((params.update as { content?: unknown }).content) !== '') {
        session.ambient.sawOutput = true
      }
    }
    if (kind === 'tool_call' || kind === 'tool_call_update') {
      const { toolCallId, status } = params.update as { toolCallId: string; status?: string | null }
      if (status === 'completed' || status === 'failed') session.activeToolCalls.delete(toolCallId)
      else if (status === 'pending' || status === 'in_progress') session.activeToolCalls.add(toolCallId)
      // A `tool_call` without a status is a call the agent just announced and
      // has not finished: count it as in flight. On an UPDATE the status is
      // optional, and an absent one carries no news either way.
      else if (kind === 'tool_call' && (status === undefined || status === null)) session.activeToolCalls.add(toolCallId)
    }
    this.applyDerived(session, params.update)
    const seq = session.transcript.append(params.update)
    this.hub.broadcast({ type: 'session/update', sessionId: session.sessionId, seq, update: params.update })
  }

  private applyDerived(session: LiveSession, update: SessionUpdate): void {
    switch (update.sessionUpdate) {
      case 'current_mode_update':
        session.modes = { ...session.modes, currentModeId: update.currentModeId }
        break
      case 'config_option_update':
        // Empty answers never overwrite the last known set — see `usableConfigOptions`.
        if (!usableConfigOptions(update.configOptions)) break
        session.configOptions = update.configOptions
        this.onCatalog?.(this.def.id, session.configOptions)
        break
      case 'available_commands_update':
        // Spread the whole command, not just name+description: the protocol
        // grows fields (and agents already send `input` hints), and a room the
        // picker has no widget for is still something the agent declared.
        const commands = update.availableCommands.map(c => ({
          ...(c as unknown as Record<string, unknown>),
          ...(c.description !== null && c.description !== undefined ? { description: c.description } : {}),
        })) as NonNullable<SessionView['availableCommands']>
        session.availableCommands = commands
        this.onCommands?.(this.def.id, commands)
        break
      case 'plan':
        session.plan = update.entries
        break
      case 'usage_update':
        session.usage = {
          used: update.used,
          size: update.size,
          ...(update.cost !== undefined && update.cost !== null
            ? { cost: { amount: update.cost.amount, currency: update.cost.currency } }
            : {}),
        }
        break
      case 'session_info_update':
        if (update.title !== undefined && update.title !== null) session.title = update.title
        break
      default:
        break
    }
  }
}

/**
 * The CodeBuddy `_meta` facts this bridge reads, when the object carries them.
 *
 * CodeBuddy runs "background drains": a sub-agent completion notice starts a
 * turn the client never prompted, announced by a `session_info_update` whose
 * `_meta["codebuddy.ai/unsolicitedTurn"]` names the run. Every update of that
 * run then carries `_meta["codebuddy.ai/requestId"]`, and a `session/prompt`
 * answered instantly (with no `codebuddy.ai/conversationRequestId` on the
 * RESPONSE) had its message folded into the drain — the real answer streams
 * afterwards, under the drain's request id.
 *
 * The same run also explains a DETACHED WORKER: `_meta["codebuddy.ai/toolName"]`
 * names the `Agent` call that dispatched it, the call is re-sent with
 * `_meta["codebuddy.ai/isBackground"] = true` once the worker runs off-turn, and
 * every update the worker emits carries
 * `_meta["codebuddy.ai/parentToolCallId"]` naming that call. Those updates are
 * the worker's own turn — they belong in the transcript, not in the session's
 * assistant message. The completion of the dispatch call itself carries NO
 * `_meta` at all, so a known call's status is read from its id.
 *
 * No other agent sends these keys: an object without them yields `undefined`,
 * so every existing path is untouched. Values are only read when they have the
 * declared shape (never guessed from a message body).
 */
interface CodebuddyMeta {
  /** The run this update belongs to. */
  requestId?: string
  /** Set on the `session_info_update` that STARTS a background turn. */
  unsolicitedTurn?: { requestId: string; reason?: string }
  /** The agent's own phase heartbeat (`{ phase }`), a liveness tick. */
  agentPhase?: { phase: string }
  /** Set on a `session/prompt` RESPONSE that really queued a conversation turn. */
  conversationRequestId?: string
  /**
   * The tool a `tool_call` names, when the agent omits `title`. `Agent` (or
   * `Task`) means the call DISPATCHED a detached worker: the call stays in
   * progress while the worker runs on its own.
   */
  toolName?: string
  /**
   * Set on every update a DETACHED WORKER emits (prose, tools, its report):
   * it names the `Agent` tool call that dispatched the worker. Such an update
   * belongs to the worker's own turn, never to this session's answer.
   */
  parentToolCallId?: string
  /**
   * Set on the dispatch call RE-SENT after the worker started
   * (`codebuddy.ai/isBackground: true`): the call handed its work to a worker
   * that keeps running off-turn, which is the structural "detached" signal.
   * The first send of the same call does not carry it.
   */
  isBackground?: boolean
  /** `codebuddy.ai/isSubagent` — the same re-send declares the worker a sub-agent. */
  isSubagent?: boolean
  /**
   * `codebuddy.ai/subagentType` / `codebuddy.ai/description` /
   * `codebuddy.ai/memberName` — the worker's identity. CodeBuddy omits the
   * dispatch call's `rawInput` on its first send (repl display), so these meta
   * keys are the ONLY place the assigned role and task line can be read.
   */
  subagentType?: string
  subagentDescription?: string
  subagentName?: string
}

/** Read the CodeBuddy `_meta` keys off an update or a `{ _meta }` wrapper. */
function codebuddyMetaOf(source: unknown): CodebuddyMeta | undefined {
  if (typeof source !== 'object' || source === null) return undefined
  const row = source as Record<string, unknown>
  const rawMeta = row._meta
  if (typeof rawMeta !== 'object' || rawMeta === null) return undefined
  const meta = rawMeta as Record<string, unknown>
  const out: CodebuddyMeta = {}
  const requestId = meta['codebuddy.ai/requestId']
  if (typeof requestId === 'string' && requestId !== '') out.requestId = requestId
  const conversationRequestId = meta['codebuddy.ai/conversationRequestId']
  if (typeof conversationRequestId === 'string' && conversationRequestId !== '') {
    out.conversationRequestId = conversationRequestId
  }
  const toolName = meta['codebuddy.ai/toolName']
  if (typeof toolName === 'string' && toolName !== '') out.toolName = toolName
  const parentToolCallId = meta['codebuddy.ai/parentToolCallId']
  if (typeof parentToolCallId === 'string' && parentToolCallId !== '') out.parentToolCallId = parentToolCallId
  // Booleans, read as booleans only: a string "true" is not the declared shape
  // and guessing from it would make another agent's unrelated key look detached.
  if (meta['codebuddy.ai/isBackground'] === true) out.isBackground = true
  if (meta['codebuddy.ai/isSubagent'] === true) out.isSubagent = true
  const subagentType = meta['codebuddy.ai/subagentType']
  if (typeof subagentType === 'string' && subagentType !== '') out.subagentType = subagentType
  const subagentDescription = meta['codebuddy.ai/description']
  if (typeof subagentDescription === 'string' && subagentDescription !== '') {
    out.subagentDescription = subagentDescription
  }
  const subagentName = meta['codebuddy.ai/memberName']
  if (typeof subagentName === 'string' && subagentName !== '') out.subagentName = subagentName
  const unsolicited = meta['codebuddy.ai/unsolicitedTurn']
  if (typeof unsolicited === 'object' && unsolicited !== null) {
    const run = unsolicited as Record<string, unknown>
    if (typeof run.requestId === 'string' && run.requestId !== '') {
      out.unsolicitedTurn = {
        requestId: run.requestId,
        ...(typeof run.reason === 'string' && run.reason !== '' ? { reason: run.reason } : {}),
      }
    }
  }
  const phase = meta['codebuddy.ai/agentPhase']
  if (typeof phase === 'object' && phase !== null) {
    const tick = phase as Record<string, unknown>
    if (typeof tick.phase === 'string' && tick.phase !== '') out.agentPhase = { phase: tick.phase }
  }
  return Object.keys(out).length === 0 ? undefined : out
}

/**
 * Remember a background drain this session stopped waiting on. A quiet close
 * drops the drain record (so an ordinary next turn is not held open for it),
 * but the run may revive afterwards; keeping its id lets every later update be
 * recognized as the drain's (`isRetiredAmbientId`) instead of being adopted as
 * the next turn's own. Bounded, oldest first — an id this far back names a run
 * no late update can plausibly still carry. Re-retiring an id refreshes its
 * timestamp and moves it to the end.
 */
function retireAmbientId(session: LiveSession, requestId: string): void {
  const retired = session.retiredAmbients ?? []
  const existing = retired.findIndex(entry => entry.requestId === requestId)
  if (existing >= 0) retired.splice(existing, 1)
  retired.push({ requestId, retiredAt: Date.now() })
  while (retired.length > RETIRED_AMBIENT_MAX) retired.shift()
  session.retiredAmbients = retired
}

/** Whether this request id names a drain the session already stopped waiting on. */
function isRetiredAmbientId(session: LiveSession, requestId: string | undefined): boolean {
  return requestId !== undefined
    && session.retiredAmbients?.some(entry => entry.requestId === requestId) === true
}

/**
 * Whether the session retired a drain recently enough that a prompt answered
 * with no ambient record and no conversation id may have been folded into it.
 * A quiet close is only evidence WE stopped waiting, so the next instant
 * answer is ambiguous; past this horizon the drain is treated as gone and the
 * ordinary zero-output warning applies.
 */
function hasRecentRetiredAmbient(session: LiveSession, withinMs: number): boolean {
  const retired = session.retiredAmbients
  if (retired === undefined || retired.length === 0) return false
  const cutoff = Date.now() - withinMs
  return retired.some(entry => entry.retiredAt >= cutoff)
}

/**
 * Work that OUTLIVES a closed turn: a detached worker that is alive (inside an
 * open tool call, or recently active), or a background drain that spoke within
 * the staleness window. Both must pin the process — an idle release would kill
 * the agent out from under them.
 *
 * An OPEN worker tool call is stronger evidence of life than silence: a long
 * build emits no updates for tens of minutes, so the plain silence window never
 * applies while one is open — the long `openToolCeilingMs` does. ANY open call
 * still inside that ceiling proves the worker alive; when every open call has
 * outlived it, plain recency decides (a worker that keeps reporting is alive).
 * `0` means no ceiling. Without some bound a worker that never reports would
 * pin the process forever.
 */
function hasPendingBackgroundWork(
  session: LiveSession,
  ambientStaleMs: number,
  dispatchSilenceMs: number,
  openToolCeilingMs: number,
): boolean {
  const dispatches = session.backgroundDispatches
  if (dispatches !== undefined) {
    for (const dispatch of dispatches.values()) {
      if (dispatch.terminal !== undefined) continue
      const openSince = latestOpenWorkerTool(dispatch)
      if (openSince !== undefined
        && (openToolCeilingMs <= 0 || Date.now() - openSince <= openToolCeilingMs)) return true
      // Every open call outlived the ceiling: fall back to plain recency, so a
      // worker that keeps reporting is still alive.
      if (Date.now() - dispatch.lastActivityAt <= dispatchSilenceMs) return true
    }
  }
  return session.ambient !== undefined
    && Date.now() - session.ambient.lastActivityAt <= ambientStaleMs
}

/**
 * When the LATEST still-open worker tool call opened, if any. The newest one
 * decides: one call may have outlived the ceiling while a sibling started
 * later and is still perfectly alive.
 */
function latestOpenWorkerTool(dispatch: BackgroundDispatch): number | undefined {
  const open = dispatch.openWorkerToolCalls
  if (open === undefined || open.size === 0) return undefined
  let latest = Number.NEGATIVE_INFINITY
  for (const at of open.values()) {
    if (at > latest) latest = at
  }
  return latest
}

/**
 * The retired drain spoke again (an update or a re-announcement carried its
 * id): it is alive, not retired. The caller rebuilds {@link LiveSession.ambient}
 * so the next prompt folded into it is recognised as steered and its text can
 * reach the user's turn; only while the id stays retired does its text remain
 * transcript-only.
 */
function reviveAmbientId(session: LiveSession, requestId: string): void {
  const retired = session.retiredAmbients
  if (retired === undefined) return
  const index = retired.findIndex(entry => entry.requestId === requestId)
  if (index < 0) return
  retired.splice(index, 1)
  if (retired.length === 0) session.retiredAmbients = undefined
}

/**
 * Forget every background-drain trace a session carried. Called at each
 * lifecycle boundary (close / release / resume / force reset): a fresh
 * agent-side state neither inherits a stale drain nor the ids of drains that
 * belonged to the old one.
 *
 * The transient rate-limit refusal goes the same way: the next process either
 * answers normally (clearing it on its own) or refuses again with its own
 * detail, and a quota recorded against the OLD process must not outlive it.
 */
function clearAmbientState(session: LiveSession): void {
  session.ambient = undefined
  session.ambientNotices?.clear()
  session.retiredAmbients = undefined
  session.quotaRefusal = undefined
}

/**
 * The closing line of a turn the agent deferred to its OWN background run: the
 * answer exists, but in the ACP transcript view rather than in this bubble.
 * Shared by the ambient wait and the detached-worker hold, so both say the
 * same thing in the same words.
 */
function backgroundDeferralLine(agentId: string): string {
  return `\n[dsh-ntr] agent "${agentId}" deferred this turn to a background task run; its output is in the ACP transcript view. Send again after the background run finishes.\n`
}

/** Human-facing identity of an ACP tool call (the approval headline). */
/**
 * Human-facing name of the tool an ask is about, for the chat line and the
 * timeout notice.
 *
 * The ACP `toolCall.title` is the declared field, but it is OPTIONAL and real
 * agents omit it: codebuddy puts the name in `_meta["codebuddy.ai/toolName"]`
 * (observed live — without the fallback the notice reads `for "tool call"`,
 * which tells the human nothing about what they missed). So read `title` first,
 * then any `_meta` key whose last segment is `toolName`, then the standard
 * `kind`, and only then give up with the generic phrase. Nothing is invented:
 * every step reads a key the agent itself declared.
 */
export function permissionToolName(toolCall: unknown): string {
  const row = (typeof toolCall === 'object' && toolCall !== null ? toolCall : {}) as Record<string, unknown>
  if (typeof row.title === 'string' && row.title !== '') return row.title
  const meta = (typeof row._meta === 'object' && row._meta !== null ? row._meta : {}) as Record<string, unknown>
  for (const [key, value] of Object.entries(meta)) {
    const segment = key.split('/').at(-1) ?? key
    if (segment.toLowerCase() === 'toolname' && typeof value === 'string' && value !== '') return value
  }
  if (typeof row.kind === 'string' && row.kind !== '') return row.kind
  return 'tool call'
}

/**
 * Why the agent refused a `session/prompt` it ANSWERED, read off the
 * response's `_meta`.
 *
 * CodeBuddy refuses a rate-limited prompt with a RESOLVED response, not a
 * rejection: `stopReason: 'refusal'` and the reason in
 * `_meta["codebuddy.ai/errorMessage"]`, a JSON string of the shape
 * `{ code, message, data: { statusCode, code, category } }`. The SDK's
 * prompt-response schema strips a top-level `errorMessage` field but passes
 * `_meta` through untouched, so this key is the only place the reason still
 * reaches the plugin — and `describeError` never sees it, because there is no
 * error to describe.
 *
 * `meta` is the `_meta` object itself (a prompt response's `meta`), not a
 * `{ _meta }` wrapper. `undefined` means "this response carries no refusal
 * detail", which is the answer for every other agent and for every normal
 * response — never a reason to invent one.
 */
export function agentRefusalDetail(meta: unknown): AgentRefusalDetail | undefined {
  if (typeof meta !== 'object' || meta === null) return undefined
  const raw = (meta as Record<string, unknown>)['codebuddy.ai/errorMessage']
  if (typeof raw !== 'string' || raw === '') return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    // Not JSON: another agent's key, or a future shape. The text is still the
    // agent's own reason, so report it as a refusal rather than dropping it.
    return { kind: 'refusal', message: raw }
  }
  if (typeof parsed !== 'object' || parsed === null) return { kind: 'refusal', message: raw }
  const row = parsed as Record<string, unknown>
  const message = typeof row.message === 'string' && row.message !== '' ? row.message : raw
  const data = typeof row.data === 'object' && row.data !== null ? row.data as Record<string, unknown> : {}
  const quota = data.category === 'quota' || data.statusCode === 429
  return { kind: quota ? 'quota' : 'refusal', message }
}

/**
 * The one wording both prompt paths use for a rate-limited turn. The chat
 * plane carries it in the turn's error, the `/acp` plane in its `turn/end`;
 * two phrasings for one fact is how a user ends up googling the wrong one.
 */
function rateLimitedTurnError(agentId: string, detail: AgentRefusalDetail): string {
  return `[dsh-ntr] agent "${agentId}" is rate limited: ${detail.message}`
}

/** Longest reason line the approval card headline carries. */
const APPROVAL_REASON_MAX = 240

/** Input keys that name the operation in one string, most specific first. */
const APPROVAL_REASON_INPUT_KEYS = [
  'command',
  'cmd',
  'path',
  'file_path',
  'filePath',
  'pattern',
  'query',
  'url',
  'description',
] as const

/**
 * One line saying WHAT the permission ask is about.
 *
 * WHY: without it the human only sees the tool's NAME ("Bash") and cannot
 * judge the request; the ACP tool call already declares the missing half — its
 * title and (for execute/edit tools) a short scalar in `rawInput`. Only ONE declared
 * string is used, never a serialized object or a whole file, and the line is
 * capped so a pathological input cannot fill the card or the audit log.
 */
export function permissionAskReason(toolCall: unknown): string {
  const row = (typeof toolCall === 'object' && toolCall !== null ? toolCall : {}) as Record<string, unknown>
  const title = permissionToolName(toolCall)
  const raw = row.rawInput
  const input = raw !== null && typeof raw === 'object' && !Array.isArray(raw)
    ? raw as Record<string, unknown>
    : typeof raw === 'string' && raw.length <= APPROVAL_REASON_MAX * 4
      // Some agents send the arguments as a JSON string; read one scalar out
      // of it instead of echoing the blob.
      ? (() => {
          try {
            const parsed: unknown = JSON.parse(raw)
            return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
              ? parsed as Record<string, unknown>
              : undefined
          } catch {
            return undefined
          }
        })()
      : undefined
  const detail = input === undefined
    ? undefined
    : APPROVAL_REASON_INPUT_KEYS
      .map(key => input[key])
      .find((value): value is string => typeof value === 'string' && value !== '')
  const line = detail === undefined || detail === title ? title : `${title} · ${detail}`
  return line.length > APPROVAL_REASON_MAX ? `${line.slice(0, APPROVAL_REASON_MAX - 1)}…` : line
}

/** Longest label the host's subagent catalog row carries for an ACP worker. */
const SUBAGENT_CATALOG_LABEL_MAX = 160

/** The structured input object an ACP tool call declared, if any. */
function rawInputObjectOf(update: Record<string, unknown>): Record<string, unknown> | undefined {
  const raw = update.rawInput ?? update.arguments
  if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>
  if (typeof raw === 'string' && raw.length <= 16_384) {
    try {
      const parsed: unknown = JSON.parse(raw)
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>
    } catch {
      return undefined
    }
  }
  return undefined
}

/**
 * One line naming a detached ACP worker in the host's subagent catalog.
 *
 * The identity is read from what CodeBuddy actually sends, in order: the
 * `_meta` keys on the dispatch call's result frames (`subagentType` /
 * `description` / `memberName` — the FIRST `tool_call` omits `rawInput`, so
 * these are often the only source), then the structured `rawInput`, then the
 * tool title. The prompt body is only used when nothing shorter exists. Capped
 * so a pathological input cannot fill the catalog row.
 */
export function subagentDispatchLabel(update: Record<string, unknown>): string {
  const meta = codebuddyMetaOf(update)
  const input = rawInputObjectOf(update) ?? {}
  const type = meta?.subagentType
    ?? nonEmptyStringOf(input.subagent_type)
    ?? nonEmptyStringOf(input.subagentType)
    ?? permissionToolName(update)
  const detail = meta?.subagentName
    ?? nonEmptyStringOf(input.name)
    ?? meta?.subagentDescription
    ?? nonEmptyStringOf(input.description)
    ?? nonEmptyStringOf(input.prompt)
  const line = detail === undefined || detail === type ? type : `${type} · ${detail}`
  return line.length > SUBAGENT_CATALOG_LABEL_MAX ? `${line.slice(0, SUBAGENT_CATALOG_LABEL_MAX - 1)}…` : line
}

/**
 * Whether the update declared the worker's IDENTITY (role / task / name)
 * rather than just restating the `Agent` tool. A bare dispatch names the tool
 * as "Agent"; reporting that as the catalog label says nothing, so the report
 * waits for one of these facts (or for the dispatch to complete).
 */
function subagentDispatchDeclaresIdentity(update: Record<string, unknown>): boolean {
  const meta = codebuddyMetaOf(update)
  if (meta?.subagentType !== undefined
    || meta?.subagentDescription !== undefined
    || meta?.subagentName !== undefined) return true
  const input = rawInputObjectOf(update)
  if (input === undefined) return false
  return ['subagent_type', 'subagentType', 'name', 'description', 'prompt']
    .some(key => nonEmptyStringOf(input[key]) !== undefined)
}

function nonEmptyStringOf(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

function snapshot(session: LiveSession): SessionView {
  return {
    sessionId: session.sessionId,
    agentId: session.agentId,
    acpSessionId: session.acpSessionId,
    cwd: session.cwd,
    ...(session.title !== undefined ? { title: session.title } : {}),
    ...(session.modes !== undefined ? { modes: session.modes } : {}),
    ...(session.configOptions !== undefined ? { configOptions: session.configOptions } : {}),
    ...(session.availableCommands !== undefined ? { availableCommands: session.availableCommands } : {}),
    ...(session.plan !== undefined ? { plan: session.plan } : {}),
    ...(session.usage !== undefined ? { usage: session.usage } : {}),
    ...(session.burst !== undefined ? { burst: session.burst } : {}),
    running: session.running,
    closed: session.closed,
    ...(session.settled !== undefined ? { settled: true } : {}),
    ...(session.released ? { released: true } : {}),
    ...(session.hasHistory === true ? { hasHistory: true } : {}),
    // The agent's own words only: the `at` timestamp is host-side bookkeeping
    // and no browser surface has a use for it.
    ...(session.quotaRefusal !== undefined ? { quotaRefusal: { message: session.quotaRefusal.message } } : {}),
    seq: session.transcript.head,
  }
}

/**
 * The `fork` half of one `session/chat-list` row: the host's verdict on
 * forking this session's ACP agent. The capability half is the agent's LAST
 * KNOWN bit (see `canForkNow`); the state half is the session's own, released
 * checked before running (a parked record is never running). The browser
 * renders its branch button from this verdict and never reads a capability
 * bit itself.
 */
function forkRowInfo(session: LiveSession, capability: boolean): { fork: ChatSessionForkInfo } {
  if (!capability) return { fork: { supported: false, reason: 'unsupported' } }
  if (session.released) return { fork: { supported: false, reason: 'released' } }
  if (session.running || session.settled !== undefined) return { fork: { supported: false, reason: 'busy' } }
  return { fork: { supported: true } }
}

/**
 * One chat-bound session record, as persisted across host restarts (the
 * `chatSessions` key of the agent registry). Deliberately identity + display
 * mirrors ONLY — the transcript is the agent's to replay on `session/load`,
 * and `configOptions` come back from the same load. `hasHistory` is what lets
 * an empty restored view say "history replays on restore" instead of
 * "nothing yet".
 */
interface PersistedChatSession {
  sessionId: string
  acpSessionId: string
  agentId: string
  dshSessionId: string
  cwd: string
  title?: string
  modelId?: string
  reasoningEffort?: string
  modes?: SessionView['modes']
  usage?: SessionView['usage']
  burst?: SessionView['burst']
  hasHistory?: boolean
}

function persistedChatSession(session: LiveSession): PersistedChatSession {
  return {
    sessionId: session.sessionId,
    acpSessionId: session.acpSessionId,
    agentId: session.agentId,
    dshSessionId: session.dshSessionId as string,
    cwd: session.cwd,
    ...(session.title === undefined ? {} : { title: session.title }),
    ...(session.modelId === undefined ? {} : { modelId: session.modelId }),
    ...(session.reasoningEffort === undefined ? {} : { reasoningEffort: session.reasoningEffort }),
    ...(session.modes === undefined ? {} : { modes: session.modes }),
    ...(session.usage === undefined ? {} : { usage: session.usage }),
    ...(session.burst === undefined ? {} : { burst: session.burst }),
    ...(session.hasHistory === true || session.transcript.since(0).length > 0 ? { hasHistory: true } : {}),
  }
}

/** Tolerant shape check for a `modes` value read back from disk. */
function isPersistedModes(value: unknown): value is SessionView['modes'] {
  if (value === null || typeof value !== 'object') return false
  const modes = value as { currentModeId?: unknown; availableModes?: unknown }
  return typeof modes.currentModeId === 'string' && Array.isArray(modes.availableModes)
}

/** Tolerant shape check for a `usage` value read back from disk. */
function isPersistedUsage(value: unknown): value is SessionView['usage'] {
  if (value === null || typeof value !== 'object') return false
  const usage = value as { used?: unknown; size?: unknown }
  return typeof usage.used === 'number' && typeof usage.size === 'number'
}

/** Tolerant shape check for a `burst` aggregate read back from disk. */
function isPersistedBurst(value: unknown): value is NonNullable<SessionView['burst']> {
  if (value === null || typeof value !== 'object') return false
  const burst = value as { outputTokens?: unknown; burstMs?: unknown }
  return typeof burst.outputTokens === 'number' && burst.outputTokens >= 0
    && typeof burst.burstMs === 'number' && burst.burstMs >= 0
}

/**
 * The DSH chat session's OWN workspace, when one is resolvable: the directory
 * the user selected in the DSH sidebar, which the host reports back as the
 * session policy's `workspaceRoot` (it is the session header cwd). This is what
 * a chat session's ACP cwd must be, so it deliberately outranks the agent's
 * configured `cwd` — that field is the plugin's own sandbox directory, not the
 * place the conversation lives.
 *
 * Never throws: a broken/absent resolver, an unknown session (an `/acp`-RPC
 * session) or a host that reports no root all read as `undefined`, and the
 * caller falls back to the agent's configured cwd.
 */
function chatWorkspaceRoot(resolver: SessionWorkspaceResolver | undefined, dshSessionId: string | undefined): string | undefined {
  if (resolver === undefined || dshSessionId === undefined) return undefined
  try {
    const root = resolver(dshSessionId)?.workspaceRoot
    return root === undefined || root === '' ? undefined : root
  } catch {
    return undefined
  }
}

/** Canonical spelling of a configured root, or the spelling as-is when it does not exist yet. */
function canonical(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

/**
 * Where the agent process itself starts.
 *
 * `wanted` (a chat session's DSH workspace, see `ensureReady`) wins over the
 * agent's configured `cwd`: some agents derive their ENTIRE notion of "the
 * project" from the directory they were started in — their file fences, the
 * environment block they show the model, their per-project state — so a process
 * started in the plugin's sandbox answers "my workspace is
 * ~/.dsh/dsh-ntr/workspaces" no matter what `session/new` said (observed on
 * codebuddy). `def.cwd` remains the answer for everything that has no DSH
 * session behind it (probes, `/acp`-RPC sessions, the settings-page test).
 */
function safeSpawnCwd(def: AcpAgentDef, wanted?: string): string {
  const configured = def.cwd ?? ensureDefaultWorkspace()
  for (const candidate of wanted === undefined ? [configured] : [wanted, configured]) {
    try {
      if (statSync(candidate).isDirectory()) return realpathSync(candidate)
    } catch { /* not usable — try the next candidate */ }
  }
  return homedir()
}

/**
 * This plugin's OWN state directory, `~/.dsh/dsh-ntr`.
 *
 * Everything this plugin persists belongs in here — the agent registry, the
 * probed model catalog, and the default ACP execution workspaces. `~/.dsh` is
 * the HOST's shared root: it holds the host's own `sessions/`, `storages/`,
 * `skills/`, `profiles/`, credentials and so on. Dropping a plugin's files
 * loose in there makes them indistinguishable from the host's state, and two
 * unrelated `acp-*.json` names at that level read as host config to anyone
 * (user or agent) looking at the directory. One owner, one subdirectory —
 * same convention `~/.dsh/skills/<owner>` and `~/.dsh/dsh-runtimes/<owner>`
 * already follow.
 *
 * `DSH_NTR_STATE_DIR` overrides the location (tests, and power users with a
 * relocated state root).
 */
export function pluginStateDir(home: string = homedir()): string {
  const override = process.env.DSH_NTR_STATE_DIR
  if (override !== undefined && override !== '') return override
  return join(home, '.dsh', 'dsh-ntr')
}

/**
 * The host's own shared `~/.dsh` root — the parent of this plugin's directory.
 *
 * Derived from {@link pluginStateDir} instead of recomputing `~/.dsh` from
 * `home`, on purpose: when a caller redirects the plugin's directory (tests,
 * a relocated state root), the legacy lookup must stay INSIDE that redirect.
 * Recomputing `~/.dsh` would make an overridden run read — and MIGRATE — the
 * real home directory.
 */
function hostStateDir(home: string = homedir()): string {
  return dirname(pluginStateDir(home))
}

/** True when the plugin's state dir was redirected (tests, relocated state). */
function stateDirExplicit(): boolean {
  const override = process.env.DSH_NTR_STATE_DIR
  return override !== undefined && override !== ''
}

/**
 * Pre-`~/.dsh/dsh-ntr` locations, kept only to MIGRATE them.
 *
 * These files used to live loose in the host's `~/.dsh` root. They are moved
 * into the plugin's own directory on first boot (see {@link migrateLegacyState})
 * and never written again — the constants stay so the migration keeps working
 * for an installation that has not started the new build yet.
 */
function legacyStatePaths(home: string = homedir()): {
  readonly dir: string
  readonly agentsFile: string
  readonly catalogFile: string
  readonly workspaces: string
} {
  const dir = hostStateDir(home)
  return {
    dir,
    agentsFile: join(dir, 'acp-agents.json'),
    catalogFile: join(dir, 'acp-model-catalog.json'),
    workspaces: join(dir, 'acp-workspaces'),
  }
}

/**
 * Move the state this plugin used to scatter across the host's `~/.dsh` root
 * into {@link pluginStateDir}.
 *
 * Idempotent and one-way: a target that already exists is left alone, so a
 * user who edits the new location never has it overwritten by a stale legacy
 * file. Only files this plugin itself created are touched — nothing else in
 * `~/.dsh` is read, moved or deleted.
 *
 * The workspace DIRECTORY is renamed rather than copied, and an agent's own
 * `cwd` / `allowedCwdRoots` are rewritten afterwards by
 * {@link rewriteLegacyWorkspaceRoots}, because those recorded absolute paths
 * would otherwise point at a directory that no longer exists (the session cwd
 * resolver rejects a missing cwd outright).
 */
function migrateLegacyState(home: string = homedir()): void {
  const legacy = legacyStatePaths(home)
  const target = pluginStateDir(home)
  try {
    const moves: Array<[string, string]> = [
      [legacy.agentsFile, join(target, 'agents.json')],
      [legacy.catalogFile, join(target, 'model-catalog.json')],
      [legacy.workspaces, join(target, 'workspaces')],
    ]
    for (const [from, to] of moves) {
      if (!existsSync(from) || existsSync(to)) continue
      mkdirSync(target, { recursive: true })
      renameSync(from, to)
    }
  } catch {
    // Best effort: a failed move leaves the legacy location readable, and the
    // readers below fall back to it, so no state is lost either way.
  }
}

/**
 * Legacy location of one plugin state file, consulted only when the new
 * location has nothing. Keeps a half-migrated installation (or a move that
 * failed because a file was momentarily locked) fully functional.
 */
function legacyFallback(name: 'agents' | 'catalog', home: string = homedir()): string {
  const legacy = legacyStatePaths(home)
  return name === 'agents' ? legacy.agentsFile : legacy.catalogFile
}

/**
 * Rewrite an agent definition's recorded workspace paths onto
 * {@link pluginStateDir} after the migration.
 *
 * `cwd` and `allowedCwdRoots` are absolute, user-visible paths stored verbatim,
 * and `resolveSessionCwd` REJECTS a cwd that does not exist — so moving the
 * directory without rewriting the agents that point into it breaks every saved
 * agent. Returns the definition unchanged when it never named the old root.
 */
export function rewriteLegacyWorkspaceRoots(def: AcpAgentDef, home: string = homedir()): AcpAgentDef {
  const from = legacyStatePaths(home).workspaces
  const to = defaultAgentWorkspace(home)
  const swap = (path: string | undefined): string | undefined => {
    if (path === undefined) return undefined
    if (!isUnderPath(path, from)) return path
    return to + path.slice(from.length)
  }
  const cwd = swap(def.cwd)
  const roots = def.allowedCwdRoots?.map(root => swap(root) ?? root)
  const cwdChanged = cwd !== def.cwd
  const rootsChanged = roots !== undefined && roots.some((root, index) => root !== def.allowedCwdRoots?.[index])
  if (!cwdChanged && !rootsChanged) return def
  return { ...def, ...(cwd === undefined ? {} : { cwd }), ...(roots === undefined ? {} : { allowedCwdRoots: roots }) }
}

/**
 * Plugin-owned default execution workspace, anchored to the plugin state dir
 * (`~/.dsh/dsh-ntr/workspaces`).
 *
 * It deliberately does NOT derive from `process.cwd()`: that is wherever the
 * DSH host happened to be launched from, so the "default workspace" used to
 * move around per launch — and, via the `allowedCwdRoots` fallback, it could
 * widen an agent's sandbox to the entire launch directory (in practice `$HOME`
 * when `dsh web` is started from the home dir).
 */
export function defaultAgentWorkspace(home: string = homedir()): string {
  return join(pluginStateDir(home), 'workspaces')
}

// ---- ACP-mode agent preset ----

/**
 * Preset id of the ACP-mode composition.
 *
 * THREE places must agree on it (no type system spans them): the declaration's
 * `config.id` in `presets/acp/acp.patch.yml` (the bundle patch the roster row
 * comes from), the browser half's `ACP_PRESET_ID` (`src/client/acp-ui.tsx`), and
 * this constant, which the host's session-log readers compare against.
 */
export const ACP_PRESET_ID = 'acp'

/** Same as {@link defaultAgentWorkspace}, best-effort creating it on disk. */
export function ensureDefaultWorkspace(home: string = homedir()): string {
  const dir = defaultAgentWorkspace(home)
  try {
    mkdirSync(dir, { recursive: true })
  } catch { /* best effort: a missing dir is reported when a session starts */ }
  return dir
}

export interface AgentPreset {
  id: string
  name: string
  description: string
  executables: string[]
  defaultCommand: string
  defaultArgs: string[]
}

export const AGENT_PRESETS: AgentPreset[] = [
  {
    id: 'pi',
    name: 'Pi Coding Agent',
    description: 'Automata / Pi Coding Agent with native ACP bridge support',
    executables: ['pi-acp', 'pi'],
    defaultCommand: 'pi-acp',
    defaultArgs: [],
  },
  {
    id: 'omp',
    name: 'Oh My Pi',
    description: 'Oh My Pi (pi-based coding agent) — run as `omp acp` over stdio',
    executables: ['omp'],
    defaultCommand: 'omp',
    defaultArgs: ['acp'],
  },
  {
    id: 'codebuddy',
    name: 'CodeBuddy Code',
    description: 'Tencent CodeBuddy Code — run as `codebuddy --acp` over stdio',
    executables: ['codebuddy', 'cbc'],
    defaultCommand: 'codebuddy',
    defaultArgs: ['--acp'],
  },
  {
    id: 'claude',
    name: 'Claude Code',
    description: 'Claude Agent SDK adapter — run as `npx -y @agentclientprotocol/claude-agent-acp` over stdio',
    executables: ['npx'],
    defaultCommand: 'npx',
    defaultArgs: ['-y', '@agentclientprotocol/claude-agent-acp'],
  },
  {
    id: 'codex',
    name: 'Codex',
    description: 'OpenAI Codex adapter — run as `npx -y @agentclientprotocol/codex-acp` over stdio',
    executables: ['npx'],
    defaultCommand: 'npx',
    defaultArgs: ['-y', '@agentclientprotocol/codex-acp'],
  },
  {
    id: 'gemini',
    name: 'Gemini CLI',
    description: 'Google Gemini CLI — run as `gemini --experimental-acp` over stdio',
    executables: ['gemini'],
    defaultCommand: 'gemini',
    defaultArgs: ['--experimental-acp'],
  },
  {
    id: 'opencode',
    name: 'OpenCode',
    description: 'OpenCode — run as `opencode acp` over stdio',
    executables: ['opencode'],
    defaultCommand: 'opencode',
    defaultArgs: ['acp'],
  },
  {
    id: 'cursor',
    name: 'Cursor CLI',
    description: 'Cursor CLI — run as `agent acp` over stdio (legacy alias `cursor-agent acp`)',
    executables: ['agent', 'cursor-agent'],
    defaultCommand: 'agent',
    defaultArgs: ['acp'],
  },
  {
    id: 'qwen',
    name: 'Qwen Code',
    description: 'Qwen Code — run as `qwen --experimental-acp` over stdio',
    executables: ['qwen'],
    defaultCommand: 'qwen',
    defaultArgs: ['--experimental-acp'],
  },
  {
    id: 'kiro',
    name: 'Kiro',
    description: 'Kiro CLI — run as `kiro-cli acp` over stdio',
    executables: ['kiro-cli'],
    defaultCommand: 'kiro-cli',
    defaultArgs: ['acp'],
  },
  {
    id: 'qoder',
    name: 'Qoder',
    description: 'Qoder CLI — run as `qodercli --acp` over stdio',
    executables: ['qodercli'],
    defaultCommand: 'qodercli',
    defaultArgs: ['--acp'],
  },
  {
    id: 'qoder-cn',
    name: 'Qoder CN',
    description: 'Qoder CLI (China) — run as `qoderclicn --acp` over stdio',
    executables: ['qoderclicn'],
    defaultCommand: 'qoderclicn',
    defaultArgs: ['--acp'],
  },
]

export function findExecutable(command: string): string | undefined {
  if (command.includes('/') || command.includes('\\')) {
    if (existsSync(command)) {
      try {
        accessSync(command, constants.X_OK)
        return realpathSync(command)
      } catch {
        return undefined
      }
    }
    return undefined
  }

  const envPath = process.env.PATH ?? ''
  const dirs = envPath.split(delimiter).filter(Boolean)
  const extraDirs = [
    join(homedir(), '.pi', 'agent', 'bin'),
    join(homedir(), '.bun', 'bin'),
    join(homedir(), '.local', 'bin'),
  ]
  const allDirs = [...new Set([...dirs, ...extraDirs])]

  const extensions = process.platform === 'win32'
    ? (process.env.PATHEXT ? process.env.PATHEXT.split(';') : ['.exe', '.cmd', '.bat'])
    : ['']

  for (const dir of allDirs) {
    for (const ext of extensions) {
      const candidate = join(dir, `${command}${ext}`)
      if (existsSync(candidate)) {
        try {
          accessSync(candidate, constants.X_OK)
          return realpathSync(candidate)
        } catch {
          // Continue searching
        }
      }
    }
  }
  return undefined
}

/** Budget for one `npm install -g` triggered by `npmPackage` (cold installs are slow). */
const NPM_INSTALL_TIMEOUT_MS = 180_000

/** A generated Windows shim: what every npm-installed agent resolves to (`codebuddy.CMD`). */
const WINDOWS_SHIM_PATTERN = /\.(?:cmd|bat)$/i

/** cmd.exe metacharacters that force quoting; inside a quoted run they are literal. */
const CMD_QUOTE_TRIGGER = /[\s"&|<>^()]/

/** Quote one command-line token for `cmd.exe`. */
function quoteForCmd(token: string): string {
  if (token !== '' && !CMD_QUOTE_TRIGGER.test(token)) return token
  return `"${token.replaceAll('"', '\\"')}"`
}

export interface ShimLaunch {
  command: string
  args: string[]
  /** The caller must pass `windowsVerbatimArguments: true` (see below). */
  verbatim: boolean
}

/**
 * Turn a resolved executable + argv into a spawnable launch.
 *
 * WHY: on Windows every npm-installed ACP agent is a generated `.cmd` shim
 * (`codebuddy`, `pi-acp`, `omp`, `npx` — `findExecutable` finds them through
 * PATHEXT), and Node ≥ 20.12 refuses to spawn a `.cmd`/`.bat` with `shell:false`
 * (the BatBadBut fix): it throws `EINVAL` before the process exists. The shim is
 * therefore handed to `cmd.exe`, which is what CreateProcess used to do for us.
 *
 * The two non-obvious details, both measured on Windows:
 *  - `windowsVerbatimArguments` — otherwise libuv re-quotes our argument with
 *    MSVCRT rules, turning the embedded quotes into `\"`, which cmd.exe does not
 *    treat as an escape; the whole line then fails as "not recognized".
 *  - the outer quote pair — `/s` strips the first and last quote of the `/c`
 *    string, so the line must be wrapped for the quoted program path to survive.
 *
 * `cmd` expands `%VAR%` even inside quotes; that is the one thing this cannot
 * neutralize (a literal `%` in a shim path or argument is not a real case).
 */
export function windowsShimLaunch(
  command: string,
  args: readonly string[],
  platform: NodeJS.Platform = process.platform,
  comspec: string = process.env.ComSpec ?? process.env.COMSPEC ?? 'cmd.exe',
): ShimLaunch {
  if (platform !== 'win32' || !WINDOWS_SHIM_PATTERN.test(command)) {
    return { command, args: [...args], verbatim: false }
  }
  const line = [command, ...args].map(quoteForCmd).join(' ')
  return { command: comspec, args: ['/d', '/s', '/c', `"${line}"`], verbatim: true }
}

/**
 * Kill a Windows process tree — the counterpart of the POSIX process-GROUP kill
 * the bridge does elsewhere (see `AgentBridge.killChild`).
 *
 * It must run while the tree is intact: a `.cmd` shim is launched through
 * `cmd.exe`, so killing the direct child first re-parents the agent and
 * `taskkill /T` can no longer reach it (measured: the agent survived `stop()`).
 * Best effort — `taskkill` is absent from no Windows this runs on, and a
 * failure here only means the OS reclaims the process later.
 */
export function killProcessTree(pid: number): ChildProcess | undefined {
  try {
    const killer = spawn('taskkill', ['/pid', String(pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true })
    killer.on('error', () => { /* nothing else to try; the OS reaps it eventually */ })
    // Handed back so a caller that wants to wait can; the existing
    // fire-and-forget callers simply ignore it.
    return killer
  } catch {
    return undefined
  }
}

/** Every agent child this host started and has not seen exit yet, by pid. */
const liveChildPids = new Set<number>()
/** Whether the process-exit reaper is already installed (installed once). */
let exitReaperArmed = false

/** Remember a freshly spawned agent child for the last-resort reaper. */
function trackAgentChild(child: ChildProcess): void {
  const pid = child.pid
  if (pid === undefined) return
  liveChildPids.add(pid)
  // Both events: `exit` is the process fact, `close` is it plus its stdio being
  // closed. Whichever comes first forgets the pid.
  const forget = (): void => { liveChildPids.delete(pid) }
  child.once('exit', forget)
  child.once('close', forget)
  if (exitReaperArmed) return
  exitReaperArmed = true
  process.once('exit', reapLiveChildren)
}

/**
 * Last resort for a host that leaves without a graceful teardown: an unhandled
 * crash that still runs `exit`, an explicit `process.exit()`, or a disposer the
 * host never awaited. Only SYNC calls are legal here — the `exit` event cannot
 * wait for a promise — hence `spawnSync` and a bare `process.kill`.
 *
 * Deliberately NOT a `SIGINT` / `SIGTERM` handler: registering one flips the
 * host's own default disposition (killing the default "exit on Ctrl-C", or
 * double-handling the host's shutdown and hanging it). A host that handles the
 * signal itself still reaches `exit`; one that is SIGKILLed can run nothing at
 * all (see AGENTS/protocol.md §7 for that limit).
 */
function reapLiveChildren(): void {
  for (const pid of liveChildPids) {
    try {
      if (process.platform === 'win32') {
        spawnSync('taskkill', ['/pid', String(pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true })
      } else {
        // The child was spawned `detached`, so it leads its own process group:
        // -pid reaches everything it started (same reasoning as the graceful
        // POSIX kill).
        process.kill(-pid, 'SIGKILL')
      }
    } catch { /* already gone, or no permission left to try */ }
  }
  liveChildPids.clear()
}

/**
 * End the child's stdin, dispatch the platform kill, and wait until the process
 * is gone — bounded, and never rejecting.
 *
 * The escalation is deliberately platform-shaped: POSIX gets a process-GROUP
 * `SIGKILL` (an agent that ignores SIGTERM is exactly what a second signal is
 * for), Windows a second `taskkill /T /F` (the first may never have run at all:
 * a failed spawn of `taskkill` is swallowed by `killProcessTree`).
 */
async function disposeChild(child: ChildProcess, budgetMs: number): Promise<void> {
  // ONE deadline for the whole disposal: the escalation wait comes out of the
  // same budget, so `budgetMs` can never turn into "grace period + grace
  // period" (see `KILL_ESCALATION_GRACE_MS`).
  const deadline = Date.now() + Math.max(0, budgetMs)
  try {
    child.stdin?.end()
  } catch { /* already gone */ }
  const pid = child.pid
  if (pid === undefined) return
  // A child that already exited may have had its pid reused: signalling it
  // would reach an unrelated process (group). Nothing left to kill.
  if (child.exitCode !== null || child.signalCode !== null) return
  const windows = process.platform === 'win32'
  if (windows) {
    // Parity with the POSIX branch, which kills the whole process GROUP: on
    // Windows "the group" is the process tree, and it has to be killed while
    // the tree is intact — killing the direct child first (a `cmd.exe` shim
    // wrapper, see `windowsShimLaunch`) re-parents the agent out of
    // `taskkill /T`'s reach. `stdin.end()` above is the graceful half.
    killProcessTree(pid)
  } else {
    try {
      process.kill(-pid, 'SIGTERM')
    } catch {
      child.kill('SIGTERM')
    }
  }
  // Everything except the escalation slice: the second wait is only there to
  // confirm a SIGKILL / taskkill landed, and it must fit inside the same budget.
  if (await waitForChildExit(child, Math.max(0, budgetMs - KILL_ESCALATION_GRACE_MS))) return
  if (windows) {
    killProcessTree(pid)
  } else {
    try {
      process.kill(-pid, 'SIGKILL')
    } catch { /* already gone */ }
  }
  // Whatever is left of the deadline, never a fresh grace period.
  await waitForChildExit(child, Math.max(0, deadline - Date.now()))
}

/** Resolve true once the child is gone, false when the budget runs out first. */
function waitForChildExit(child: ChildProcess, budgetMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true)
  return new Promise<boolean>((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const settle = (gone: boolean): void => {
      if (timer !== undefined) clearTimeout(timer)
      child.off('exit', onGone)
      child.off('close', onGone)
      resolve(gone)
    }
    const onGone = (): void => { settle(true) }
    timer = setTimeout(() => { settle(false) }, budgetMs)
    // The host may exit while this waits; an armed timer must not hold it open.
    timer.unref?.()
    child.once('exit', onGone)
    child.once('close', onGone)
  })
}

/**
 * Globally install an agent's npm package. The package name reaches the
 * installer as a spawn argv item; on Windows the installer needs a shell,
 * which is exactly why `validateAgentDef` restricts `npmPackage` to a
 * charset with no shell metacharacters.
 */
export function npmInstallGlobal(pkg: string, onLog: (line: string) => void = () => {}): Promise<void> {
  return new Promise((resolveInstall, rejectInstall) => {
    let settled = false
    onLog(`[dsh-ntr] "${pkg}" not found on PATH — running: npm install -g ${pkg}`)
    const child = spawn('npm', ['install', '-g', '--no-fund', '--no-audit', pkg], {
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
    })
    const output: string[] = []
    const collect = (chunk: unknown) => {
      for (const line of String(chunk).split('\n')) {
        if (line.trim() === '') continue
        output.push(line)
        if (output.length > 40) output.splice(0, output.length - 40)
      }
    }
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', collect)
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', collect)
    const timer = setTimeout(() => {
      child.kill()
      settle(new AcpError('agent_unreachable', `acp: npm install -g ${pkg} timed out after ${NPM_INSTALL_TIMEOUT_MS}ms; output: ${output.slice(-5).join(' | ')}`))
    }, NPM_INSTALL_TIMEOUT_MS)
    timer.unref?.()
    child.on('error', error => {
      settle(new AcpError('agent_unreachable', `acp: npm install -g ${pkg} failed to run: ${error.message}`))
    })
    child.on('exit', (code, signal) => {
      if (code === 0) {
        onLog(`[dsh-ntr] npm install -g ${pkg} finished`)
        settle(undefined)
        return
      }
      for (const line of output.slice(-5)) onLog(line)
      settle(new AcpError('agent_unreachable', `acp: npm install -g ${pkg} exited code=${String(code)} signal=${String(signal)}; output: ${output.slice(-5).join(' | ')}`))
    })

    function settle(error: AcpError | undefined): void {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error === undefined) resolveInstall()
      else rejectInstall(error)
    }
  })
}

export interface ExecutableResolution {
  command: string
  /** True when the npm auto-install ran during this resolution. */
  installed: boolean
}

/**
 * Resolve the spawn command for an agent def: PATH lookup first, then — when
 * the command is missing and the def carries `npmPackage` — a global install
 * and a second lookup. When nothing resolves the original command comes back
 * untouched so the spawn itself fails with the familiar ENOENT.
 */
export async function ensureAgentExecutable(
  def: Pick<AcpAgentDef, 'command' | 'npmPackage'>,
  install: (pkg: string, onLog: (line: string) => void) => Promise<void> = (pkg, onLog) => npmInstallGlobal(pkg, onLog),
  onLog: (line: string) => void = () => {},
  /**
   * Called when the auto-install is about to run — the only point that proves
   * an install was TRIED. A configured `npmPackage` alone does not (see
   * `StartAttempt.installTried`), and a throw below would otherwise leave no
   * trace of the attempt.
   */
  onInstallStart: () => void = () => {},
): Promise<ExecutableResolution> {
  const found = findExecutable(def.command)
  if (found !== undefined) return { command: found, installed: false }
  if (def.npmPackage === undefined || def.npmPackage === '') return { command: def.command, installed: false }
  onInstallStart()
  await install(def.npmPackage, onLog)
  const retry = findExecutable(def.command)
  if (retry === undefined) {
    onLog(`[dsh-ntr] ${def.npmPackage} installed but "${def.command}" is still not resolvable on PATH`)
  }
  return { command: retry ?? def.command, installed: true }
}

export function detectHostAgents(configuredDefs: readonly AcpAgentDef[]): DetectedAgentInfo[] {
  const presetEntries = AGENT_PRESETS.map(preset => {
    let detectedPath: string | undefined
    for (const exe of preset.executables) {
      const found = findExecutable(exe)
      if (found !== undefined) {
        detectedPath = found
        break
      }
    }
    const current = configuredDefs.find(d => d.id === preset.id)
    return {
      id: preset.id,
      name: preset.name,
      description: preset.description,
      detected: detectedPath !== undefined,
      executablePath: detectedPath,
      defaultCommand: preset.defaultCommand,
      defaultArgs: [...preset.defaultArgs],
      currentConfig: current,
    }
  })
  // Configured agents outside the preset table (custom ids created in the
  // panel) surface as their own detect entries so the browser can edit their
  // full connection form — env / npmPackage / title exist only on
  // `currentConfig`, which the synthesized client-side fallback lacks.
  const presetIds = new Set(presetEntries.map(entry => entry.id))
  const customEntries = configuredDefs
    .filter(def => !presetIds.has(def.id))
    .map(def => {
      const executablePath = findExecutable(def.command)
      return {
        id: def.id,
        name: def.title ?? def.id,
        description: `Custom ACP agent (command: ${def.command})`,
        detected: executablePath !== undefined,
        executablePath,
        defaultCommand: def.command,
        defaultArgs: [...(def.args ?? [])],
        currentConfig: def,
      }
    })
  return [...presetEntries, ...customEntries]
}

/**
 * Rescue a def persisted before `command` became a command LINE (AGENTS.md
 * constraint 26): `command` used to be the whole program string, and an
 * absolute Windows path may legitimately contain spaces
 * (`C:\Program Files\nodejs\node.exe`). Re-validating would now split that on
 * the first space and silently point the agent at `C:\Program`, so the row is
 * quoted first — but ONLY when the untouched string really is a file on disk,
 * which is the one case where the split would be wrong.
 */
function quoteLegacyCommand(item: unknown): unknown {
  if (typeof item !== 'object' || item === null) return item
  const row = item as Record<string, unknown>
  const command = row.command
  if (typeof command !== 'string') return item
  const trimmed = command.trim()
  if (!/\s/.test(trimmed) || !existsSync(trimmed)) return item
  return { ...row, command: quoteCommandToken(trimmed) }
}

/**
 * The conversation→agent binding the REQUEST path honors.
 *
 * `session/chat-bind` records which ACP agent serves one DSH chat session — the
 * plugin's own mapping, deliberately not a DSH model route (see
 * `bindChatAgent`). But a route is exactly what the host driver reads per step
 * (`selectionFor(agent).current`: pending selection → last request header →
 * deployment default), and a session that has never run an ACP turn resolves to
 * the DEPLOYMENT DEFAULT — so the driver would reach this adapter only if the
 * binding is recorded as the session's model selection first.
 *
 * The guard (`presets/acp/acp-guard.mjs`) does that on the wake seam: DSH
 * 0.2.2+ fixes the step's route at preparation and reads `agent.model`, so the
 * guard calls `agent.model.select({ provider: 'acp', model })` from the
 * `agent/inbox/inserted` / `agent/inbox/claimed` listeners (before that read).
 * Older hosts have no `agent.model`; there the guard keeps an `agent/request`
 * waterfall rewrite registered with `prepend` so it lands OUTSIDE the harness's
 * own rewrite and wins. The guard is loaded by the harness's Loader as its own
 * module instance, so the two halves share state through this registry on
 * `globalThis` rather than through a module import — same-package,
 * cross-instance, like a service. The guard reads it defensively and degrades
 * to "no rewrite" (the harness default plays out) when it is absent;
 * `ACP_ROUTE_BINDING_KEY` is therefore a hand-copy discipline with the guard's
 * `BINDING_KEY` (see tests/register.spec.ts for the equivalence).
 */
export const ACP_ROUTE_BINDING_KEY = Symbol.for('dsh-ntr.acp-binding')

/** The registry shape the guard reads. Values are adapter model strings. */
export interface AcpRouteBindingRegistry {
  /** DSH chat session id → the adapter model (`agentId` | `agentId@choice`) its next turn runs on. */
  readonly conversations: Map<string, string>
  /**
   * ACP tool call id → the tool's output folded to plain text. The guard's
   * `tools/execute` listener answers the host loop's execution of an ACP
   * display card from here, so the card records the tool's REAL output
   * instead of an `unknown tool` error (see `recordAcpToolOutput`).
   */
  readonly toolResults: Map<string, string>
  /**
   * Call ids whose output is COMPLETE — including a tool that produced none.
   * An announcing `tool_call` records the call with an empty output, and that
   * empty record must not read as an answer: membership here is what lets
   * `waitForToolOutput` resolve with it instead of parking until the turn
   * settles.
   */
  readonly toolOutputFinal: Set<string>
  /**
   * Resolvers waiting for a call's output to land, keyed by call id. Under the
   * segmented turn shape the host loop executes a card the moment its segment
   * settles — often BEFORE the agent has reported the tool's output — so the
   * guard's virtual tool parks here until `recordAcpToolOutput` (or the turn's
   * settlement, or the bounded timeout) releases it.
   */
  readonly toolOutputWaiters: Map<string, Set<(text: string | undefined) => void>>
  /** Bare agent id served when a conversation carries no explicit binding (`undefined`: no rewrite). */
  defaultModel?: string
  /**
   * Wait for a call's output to land (the plugin's implementation, shared via
   * the registry so the preset's separate module instance can reach it). The
   * guard's virtual tools call this when the host loop executes a card whose
   * tool is still running inside the ACP agent.
   */
  waitForToolOutput?: (callId: string, timeoutMs: number) => Promise<string | undefined>
}

/**
 * Install (or reuse) the process-wide registry. Idempotent: the guard and the
 * plugin load in either order, and a hot reload must not orphan bindings the
 * previous instance recorded.
 */
export function routeBindingRegistry(): AcpRouteBindingRegistry {
  const host = globalThis as unknown as { [ACP_ROUTE_BINDING_KEY]?: AcpRouteBindingRegistry }
  const existing = host[ACP_ROUTE_BINDING_KEY]
  if (existing !== undefined) {
    // A registry from an older build may predate a seam: re-attach the
    // (upgraded) implementation so the guard can always use it.
    if (existing.waitForToolOutput === undefined) existing.waitForToolOutput = (callId, timeoutMs) => waitForToolOutput(callId, timeoutMs)
    if (existing.toolOutputFinal === undefined) (existing as { toolOutputFinal: Set<string> }).toolOutputFinal = new Set<string>()
    return existing
  }
  const registry: AcpRouteBindingRegistry = {
    conversations: new Map(),
    toolResults: new Map(),
    toolOutputFinal: new Set(),
    toolOutputWaiters: new Map(),
    waitForToolOutput: (callId, timeoutMs) => waitForToolOutput(callId, timeoutMs),
  }
  host[ACP_ROUTE_BINDING_KEY] = registry
  return registry
}

/** Bounds for the shared tool-output record (see {@link recordAcpToolOutput}). */
const TOOL_OUTPUT_MAX_ENTRIES = 200
const TOOL_OUTPUT_MAX_CHARS = 16_000

/**
 * Record one ACP tool call for the guard's virtual tools. The host loop
 * "executes" every tool-call block in a settled ACP message (that execution
 * record is what draws the card); the preset registers no tools, so each call
 * would record `Error: unknown tool "<name>"`. The guard's `tools/execute`
 * listener instead registers a scoped virtual tool per name, and its body
 * answers with THIS record — the tool's real output, folded by the same helper
 * the ACP view uses.
 *
 * Every seen call id is recorded, even with empty output: an agent announces a
 * call before it reports the result (CodeBuddy restates the whole `tool_call`
 * once more with the output attached — see docs/acp-convergence.md §1.7), so
 * the first record is routinely `''`. Such a record is a placeholder, not an
 * answer: only a non-empty output, or a call the agent marked terminal,
 * releases a parked waiter. Bounded: entries are transient, but an agent that
 * inlines whole files must not grow the process-wide map without limit.
 *
 * @param final - whether the agent's status for this call is terminal.
 */
export function recordAcpToolOutput(callId: string, text: string, final = false): void {
  if (callId === '') return
  const registry = routeBindingRegistry()
  registry.toolResults.set(callId, text.length > TOOL_OUTPUT_MAX_CHARS ? `${text.slice(0, TOOL_OUTPUT_MAX_CHARS)}…` : text)
  if (final) registry.toolOutputFinal.add(callId)
  while (registry.toolResults.size > TOOL_OUTPUT_MAX_ENTRIES) {
    const oldest = registry.toolResults.keys().next().value
    if (oldest === undefined) break
    registry.toolResults.delete(oldest)
    registry.toolOutputFinal.delete(oldest)
  }
  if (text === '' && !final) return
  const waiters = registry.toolOutputWaiters.get(callId)
  if (waiters !== undefined) {
    registry.toolOutputWaiters.delete(callId)
    for (const waiter of [...waiters]) waiter(registry.toolResults.get(callId))
  }
}

/**
 * Wait for a tool call's output to land in the shared registry. The host loop
 * executes a card as soon as its segment settles, which routinely happens
 * while the ACP agent is still running the tool; the guard's virtual tool
 * parks here so the card's execution record ends up with the real output.
 *
 * Resolves with the output text, or `undefined` when the bounded timeout
 * elapses or the turn settles first (the caller then answers with a pointer to
 * the ACP transcript view). Never rejects and never waits past the timeout.
 */
export function waitForToolOutput(callId: string, timeoutMs: number): Promise<string | undefined> {
  const registry = routeBindingRegistry()
  if (callId === '') return Promise.resolve(undefined)
  const landed = registry.toolResults.get(callId)
  // An EMPTY record is an answer only once the call is terminal — a tool that
  // genuinely produced no output. Otherwise it is the announcement that the
  // call started, and resolving with it is what made every display card answer
  // with the transcript pointer while the agent was still running the tool.
  if (landed !== undefined && (landed !== '' || registry.toolOutputFinal.has(callId))) return Promise.resolve(landed)
  return new Promise<string | undefined>(resolve => {
    let settled = false
    const done = (text: string | undefined): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      const waiters = registry.toolOutputWaiters.get(callId)
      if (waiters !== undefined) {
        waiters.delete(done)
        if (waiters.size === 0) registry.toolOutputWaiters.delete(callId)
      }
      resolve(text)
    }
    const timer = setTimeout(() => done(undefined), Math.max(0, timeoutMs))
    timer.unref?.()
    let waiters = registry.toolOutputWaiters.get(callId)
    if (waiters === undefined) {
      waiters = new Set()
      registry.toolOutputWaiters.set(callId, waiters)
    }
    waiters.add(done)
  })
}

/** Release every output waiter (a turn settled; nothing more can land for it). */
export function releaseAllToolOutputWaiters(): void {
  const registry = routeBindingRegistry()
  const waiters = [...registry.toolOutputWaiters.values()]
  registry.toolOutputWaiters.clear()
  for (const set of waiters) for (const waiter of [...set]) waiter(undefined)
}

// ---- Segmented turn streaming ----

/**
 * One driver step's stream: its own chunk queue and block state. A turn is
 * MANY segments when it carries tool calls — each segment ends where a tool
 * card should sit as the LAST block of the settled assistant message, so the
 * host loop executes the card between two assistant messages exactly like a
 * native multi-step turn (see docs/acp-convergence.md §1.7).
 */
interface SegmentState {
  queue: AsyncQueue<StreamChunk>
  /** Block index within THIS segment (the host accumulator is per-stream-call). */
  index: number
  activeType: 'reasoning' | 'text' | 'tool-call' | null
  activeText: string
  /** UTF-16 units of this segment's text and reasoning chunks (the usage estimate). */
  outputChars: number
  /** The open tool-call block's snapshot, while `activeType === 'tool-call'`. */
  activeToolCall: AcpToolCallSnapshot | undefined
  /** Whether this segment opened at least one tool-call block. */
  hasCard: boolean
  /**
   * The segment belongs to an ambient wait: the agent folded our prompt into a
   * background drain it started itself. Tool traffic is recorded (so the
   * transcript and any parked tool-output waiter get it) but opens NO card —
   * a card would make the host loop execute a tool for a turn whose answer has
   * not even started streaming yet.
   */
  ambient: boolean
  /**
   * Whether this segment's open card was settled early (see
   * `settleOpenCard`). The snapshot stays open so a late restatement still
   * folds into it; the segment's closing `block-end` then replaces the settled
   * card with the final text.
   */
  cardSettled: boolean
  finished: boolean
}

/** How one segment's stream ends, in `StreamChunk.finish` terms. */
type SegmentFinishReason =
  | { kind: 'stop' }
  | { kind: 'aborted'; failure?: { message: string; code: string } }
  | { kind: 'error'; failure?: { message: string; code: string } }

/** Why a turn ended, as seen by {@link TurnStreamController.settle}. */
type TurnSettle =
  | { kind: 'stop'; stopReason: string; refusal?: string }
  | { kind: 'cancelled' }
  | { kind: 'error'; message: string; code?: string; errorKind?: 'quota' }

/** How often a running turn's live burst aggregate is pushed to the browser. */
const TPS_PUSH_INTERVAL_MS = 1000

/**
 * Bounds on the updates withheld while a turn's own request id is still
 * unknown (see `TurnStreamController.bufferAmbientUpdate`). The buffer exists
 * only for the response window of one prompt, but a chatty drain could stream
 * for a while inside it; over the bound the OLDEST entries are dropped — the
 * transcript still has every one of them.
 */
const PENDING_AMBIENT_MAX_ENTRIES = 200
const PENDING_AMBIENT_MAX_CHARS = 64 * 1024

/**
 * Bound on {@link LiveSession.ambientNotices}. The set now outlives the turn
 * that announced a drain (a hard ceiling keeps the record, and a repeated
 * announcement of the same run must stay silent), so it needs a ceiling of its
 * own for a chatty agent. Oldest ids are evicted first; an id that far back is
 * a run nobody is waiting on anymore.
 */
const AMBIENT_NOTICE_MAX = 64

/**
 * Bound on {@link LiveSession.retiredAmbients}. The ids only exist to catch a
 * drain that speaks again after its wait closed, and the timestamp lets the
 * next silent close recognise a recent fold — a short-horizon concern, so a
 * small ring is enough; the oldest is evicted first.
 */
const RETIRED_AMBIENT_MAX = 32

/**
 * Floor for the "recently retired" lookback the zero-output fallback uses
 * (twice `ambientQuietMs`). Only test-sized quiet windows fall below it; a
 * production window (10s) always wins. Without the floor a 250ms quiet window
 * would leave a 500ms lookback, too tight to survive a loaded CI scheduler
 * between one turn ending and the next prompt's response.
 */
const RETIRED_AMBIENT_RECENT_MIN_MS = 1_000

/** One ambient wait's clocks and the stop reason it will close the turn with. */
interface AmbientWait {
  /** The drain's request id: the turn is waiting on this run, not on its own. */
  requestId: string
  quietTimer: ReturnType<typeof setTimeout>
  hardTimer: ReturnType<typeof setTimeout>
  /** The stop reason the agent's `session/prompt` response carried. */
  stopReason: string
  /**
   * Whether the CEILING closed this wait (the drain was still ticking) rather
   * than silence. A hard ending must keep the session's drain record: the next
   * prompt may be folded into the same run, and it is still alive.
   */
  hard?: boolean
}

/** An update withheld from the segment until the turn's own request id is known. */
interface PendingAmbientUpdate {
  seq: number
  update: Record<string, unknown>
  /** `JSON.stringify(update).length`, kept so eviction need not re-serialize. */
  chars: number
}

/**
 * The `Agent` tool call that handed work to a DETACHED worker.
 *
 * CodeBuddy 2.179.0 with multitask on: the coordinator opens an `Agent` call
 * (`_meta["codebuddy.ai/toolName"] = "Agent"`), says "已派…", and ENDS ITS OWN
 * PROMPT normally while the worker keeps running off-turn. The call itself
 * stays `in_progress` until the worker reports, and only then does the agent
 * start the background drain that carries the worker's report into the
 * session. A turn that closed at its prompt response therefore lost the only
 * answer it was ever going to produce; this record is what the controller
 * holds the turn open for.
 */
interface BackgroundDispatch {
  /** The `Agent` call's id — the card that stays on the plane. */
  toolCallId: string
  /** The last status the agent declared for the dispatch call itself. */
  status: string
  /**
   * Whether the call already reported a TERMINAL status (completed OR failed).
   * Deliberately still one boolean: the hold only cares whether the worker
   * reported at all, never whether the report was good (constraint 23).
   */
  completed: boolean
  /**
   * Whether the work runs DETACHED, read from the dispatch call's OWN structure:
   * the call re-sent with `_meta["codebuddy.ai/isBackground"] = true`. A worker
   * update naming this call as its `parentToolCallId` does NOT set it — CodeBuddy
   * tags a synchronous subagent's child updates the same way, so that signal
   * only proves the worker alive (`sawWorkerUpdate`). A synchronous `Agent` /
   * `Task` call never declares `isBackground`, so it can never make the turn
   * wait after its own answer.
   */
  detached: boolean
  /** Whether any update came FROM the worker (`codebuddy.ai/parentToolCallId`). */
  sawWorkerUpdate: boolean
  /** One-line label for the host's subagent catalog, refreshed until reported. */
  catalogLabel: string
  /** Whether `catalogLabel` carries the worker's identity, not just the tool name. */
  catalogLabelIdentified: boolean
  /** Whether the host catalog already accepted this dispatch (one fact per call). */
  catalogReported: boolean
  /** When the dispatch call was first seen (the record's `startedAt`). */
  startedAt: number
  /** Last frame belonging to this dispatch. Memory-only: persisted with the next transition. */
  lastActivityAt: number
  /** When a terminal state was written. */
  endedAt?: number
  /**
   * The terminal status, once decided. Never overwritten: a late completion
   * after the turn already closed with `unknown` is a known limitation, not a
   * bug (the row must not stay `running`, and it must not be revived either).
   */
  terminal?: 'completed' | 'failed' | 'cancelled' | 'unknown'
  /** The terminal frame's `tool_call_update.content`, verbatim (constraint 29). */
  error?: unknown
  /** The worker's declared role (`_meta["codebuddy.ai/subagentType"]`). */
  subagentType?: string
  /** Per-worker counters; only `updates` moves per chunk and none of them writes the state file. */
  counts: { updates: number; toolCalls: number; textChars: number }
  /** The status last announced through `subagents/record` (creation included). */
  reportedStatus?: SubagentStatus
  /**
   * The WORKER's own tool calls that are still open, by `toolCallId` → when the
   * call opened. A worker silent inside a long command is alive, not wedged:
   * while one is open the idle clock grants the long open-tool ceiling instead
   * of the plain silence window (see `hasPendingBackgroundWork`).
   */
  openWorkerToolCalls?: Map<string, number>
}

/**
 * A turn held open for the detached worker its `Agent` call dispatched.
 *
 * Two phases, because their liveness signals differ:
 * - `worker`: at least one worker runs off-turn and may be silent for tens of
 *   seconds between model calls — its clock is a SILENCE window
 *   ({@link BridgeTuning.backgroundTaskMaxMs}) pushed out by every dispatch /
 *   worker update, plus an optional whole-hold ceiling
 *   ({@link BridgeTuning.backgroundTaskCeilingMs}). It ends when EVERY known
 *   dispatch reported (completed / failed); a drain announcement is recorded
 *   meanwhile but arms no clock.
 * - `drain`: every dispatch reported and the background turn that carries
 *   their report is (or is about to start) — the existing ambient windows
 *   apply (`ambientQuietMs` quiet, reset by every update; `ambientMaxMs`
 *   ceiling from the switch).
 */
interface BackgroundHold {
  /** The stop reason the prompt RESPONSE carried (what the turn closes with). */
  stopReason: string
  /** The run this hold currently waits on: the response's id or the last announcement. */
  requestId?: string
  /**
   * Every drain id this hold may fold text from: the response's
   * `conversationRequestId` / `requestId` plus every announced id. A run
   * announced before the response may name a different id than the response —
   * both are this turn's answer, and anything else stays background noise.
   */
  acceptedIds: Set<string>
  phase: 'worker' | 'drain'
  /**
   * Agent MESSAGE text folded into this hold. The parent's interim
   * acknowledgement ("已派…") landed before the hold and is not the drained
   * run's answer: a hold that never received that answer must still say where
   * it will appear.
   */
  answerChars: number
  /**
   * The transcript head when the hold began. Text at or below it arrived
   * before the hold — a parked hold replays the parent's ack from there — so
   * it is not counted in {@link answerChars}; the drain updates withheld for
   * the response are the exception and are counted explicitly when flushed.
   */
  floorSeq: number
  quietTimer?: ReturnType<typeof setTimeout>
  hardTimer?: ReturnType<typeof setTimeout>
  /** Absolute whole-hold ceiling; absent when the tuning disables it (0). */
  ceilingTimer?: ReturnType<typeof setTimeout>  /**
   * The bounded wait for a driver step to speak into. Only while the hold is
   * PARKED (`pendingBackgroundHold`): the response landed between steps, and
   * the host is expected to open the continuation step for the Agent card.
   */
  graceTimer?: ReturnType<typeof setTimeout>
  /** Whether the run's ids were already released (a close, cancel or teardown). */
  retired: boolean
}

/**
 * How long a card-bearing segment waits for the agent to stop disclosing the
 * open call's arguments before the block is settled.
 *
 * The settling rule (`docs/acp-convergence.md` §1.8) cuts a segment at the
 * next non-tool event, which for a long-running tool means the agent's next
 * words — typically AFTER the tool finished. The host's live "preparing" row
 * only advances on `argumentsDelta`, and an ACP update restates its input in
 * whole, so the real command otherwise appears only when the segment closes.
 * A short quiet window closes the tool-call BLOCK (not the segment): the row
 * settles its arguments and shows the real command while the agent still
 * executes the tool, and the segment stays open for the host-side settle,
 * watchdog and continuation semantics.
 *
 * Long enough to batch the announce → rewrite burst observed on
 * CodeBuddy (all within the same tick or two), short enough to read as live.
 */
const CARD_SETTLE_QUIET_MS = 500

/**
 * The state of ONE ACP prompt, shared across every driver step of the turn.
 *
 * The controller owns the hub subscription (for the whole agent-side turn, not
 * per stream() call), the transcript cursor (segments resume by replaying
 * `transcript.since(cursor)` — events that arrive while no segment is open are
 * recorded, never lost), the seen-call registry (a call id gets exactly one
 * card per turn, wherever its restatements land), and the turn-level facts
 * (`sawVisibleBlock`) that outlive any single segment.
 */
class TurnStreamController {
  private segment: SegmentState | undefined
  private settled = false
  /** Whether the turn's closing work already ran (see `closeTurn`). */
  private closedTurn = false
  private disposed = false
  private readonly seenCalls = new Set<string>()
  private readonly announcedKinds = new Map<string, string>()
  /** Narrative lines (permission asks) that arrived while no segment was open. */
  private readonly pendingProse: string[] = []
  sawVisibleBlock = false
  /**
   * Whether THIS turn streamed its own prose (text or reasoning), i.e. an
   * answer that is not the background drain's. Tool cards do not count — a
   * drain that only ran tools delivered no words to the conversation.
   */
  private sawAgentProse = false
  /**
   * Whether any `agent_message_chunk` text reached the plane. Reasoning does
   * not count: a steer whose drain only thought is still a turn with no answer
   * text, and must say so when it closes.
   */
  private sawVisibleText = false
  /**
   * The CodeBuddy request id this turn has adopted as its own (from the
   * prompt RESPONSE's `conversationRequestId`, or from the first update that
   * named one). Used to keep a background drain's prose out of the user's
   * answer; `undefined` means "unknown" and nothing is split (fail-open).
   */
  private turnRequestId?: string
  /**
   * Updates the session's background drain already streamed while this turn's
   * OWN request id was still unknown. They are NOT folded on arrival: a drain
   * tick that lands before the prompt response could otherwise teach the turn
   * the drain's id (`noteTurnRequestId`) and mix the drain's text into the
   * user's answer. Withheld here (cursor already advanced — the transcript
   * keeps a copy) until the response decides what this turn is:
   * - a normal turn (response carries a conversation id) discards them — they
   *   were never this turn's answer;
   * - a steered turn flushes them into the segment, in order, once
   *   `awaitAmbient` marks the segment ambient (tool cards suppressed).
   */
  private readonly pendingAmbientUpdates: PendingAmbientUpdate[] = []
  private pendingAmbientChars = 0
  /**
   * Whether the bounded buffer dropped at least one update. The flush then
   * says so in the conversation instead of silently losing the front of the
   * drain's output (constraint 29: ACP payloads are never dropped silently).
   */
  private pendingAmbientTruncated = false
  /** The ambient wait in progress, if the agent folded this prompt into a drain. */
  private awaitingAmbient?: AmbientWait
  /**
   * The prompt response named no conversation turn while a drain this session
   * retired RECENTLY may still be running without re-announcing. The turn still
   * settles at once (a drain record that no update revived is not waited on),
   * but its zero-output report says the turn may have been folded into that run
   * instead of blaming the agent and suggesting a resend.
   */
  private recentRetiredDrain = false
  /** The outcome of a settle whose closing work is waiting one macrotask (see `settle`). */
  private pendingOutcome?: TurnSettle
  private closeScheduled = false
  /**
   * The bounded wait that settles an open card's block while the agent is
   * still running the tool (see {@link CARD_SETTLE_QUIET_MS}). Only armed for
   * a segment whose open card has disclosed arguments.
   */
  private cardSettleTimer?: ReturnType<typeof setTimeout>
  private cursorSeq: number
  /**
   * Burst tracker for this turn, fed from the LIVE hub frames only. Segment
   * replay must not touch it: every event is already counted once when it
   * arrived, and replay would double the numerator and the gaps.
   */
  private readonly tps = new TurnTpsTracker()
  private tpsSeq: number
  private lastTpsPushAt = 0
  /**
   * The ambient quiet/ceiling windows, read once from the manager: they are
   * deployment tuning, not per-tick facts, and small test values must be stable
   * for the whole turn (see {@link BridgeTuning.ambientQuietMs} for the
   * measured CodeBuddy tick cadence these defaults come from).
   */
  private readonly ambientTuning: { quietMs: number; maxMs: number }
  /**
   * Detached-worker records live on the SESSION, not on this turn: a worker
   * that outlives the turn still reports, and the record has to move with it
   * (see {@link LiveSession.backgroundDispatches}). The hold still waits for
   * ALL of a turn's dispatches, but the map survives its controller.
   */
  private get dispatches(): Map<string, BackgroundDispatch> {
    return this.session.backgroundDispatches ??= new Map()
  }
  /**
   * The ids of dispatches THIS turn created. A hold may only wait for work the
   * turn itself handed out: a completed worker of an EARLIER turn still sits
   * in the session map, and waiting on it would hold an unrelated successor
   * turn against a drain it does not own.
   */
  private readonly turnDispatchIds = new Set<string>()
  /** The detached-worker hold in progress, once a segment carries it. */
  private backgroundHold?: BackgroundHold
  /**
   * A hold parked because the prompt response landed while NO driver segment
   * was open (the host is between steps, about to execute the Agent card). It
   * begins when the next `startSegment` opens — or closes after a bounded
   * grace so a host that never opens one does not hang the turn.
   */
  private pendingBackgroundHold?: BackgroundHold
  /**
   * The hold's own windows, read once at construction like the ambient pair:
   * `taskMaxMs` is the worker phase's SHORT silence window, `toolMaxMs` its
   * long tier while the worker's last known state is an open tool call,
   * `ceilingMs` the optional whole-hold absolute bound (0 = none), `graceMs`
   * the parked hold's bounded wait for a driver step (see
   * {@link BridgeTuning.backgroundTaskMaxMs} /
   * {@link BridgeTuning.backgroundTaskToolMs} /
   * {@link BridgeTuning.backgroundTaskCeilingMs} /
   * {@link BridgeTuning.backgroundParkedGraceMs}).
   */
  private readonly backgroundTuning: { taskMaxMs: number; toolMaxMs: number; ceilingMs: number; graceMs: number }
  /**
   * Tool calls FROM the worker's own turn (updates carrying
   * `parentToolCallId`) that have not reported completed / failed. They are
   * the long-tier evidence for the worker phase's silence window: a worker
   * blocked inside one command is alive, not gone (see
   * {@link BridgeTuning.backgroundTaskToolMs}).
   */
  private readonly workerToolCalls = new Set<string>()
  /**
   * When this controller was built. Only a drain announced AFTER this moment
   * may be adopted by the hold: an `ambient` record that predates the turn is
   * some earlier run's, and folding its text would mix two answers.
   */
  private readonly constructedAt: number

  constructor(
    private readonly manager: BridgeManager,
    private readonly hub: EventHub,
    readonly session: LiveSession,
    readonly turnId: string,
    /** Releases the agent-side turn slot (the `beginTurn` settler; idempotent). */
    private readonly endTurn: () => void,
    private readonly rollbackFirstTurn: (session: LiveSession) => void,
  ) {
    this.turnSeqAtStart = session.turnSeq
    this.cursorSeq = session.transcript.head
    this.tpsSeq = session.transcript.head
    this.constructedAt = Date.now()
    this.ambientTuning = manager.ambientTuning
    this.backgroundTuning = manager.backgroundTuning
    this.unsubscribe = hub.subscribe(event => this.onEvent(event))
  }

  private readonly unsubscribe: () => void
  private readonly turnSeqAtStart: number

  /** The transcript cursor: everything at or below it is already folded or recorded. */
  get replayCursor(): number {
    return this.cursorSeq
  }

  /** Whether the agent already settled its `session/prompt` for this turn. */
  get hasSettled(): boolean {
    return this.settled
  }

  /** Whether a segment is on air — the agent is expected to speak into a live driver step. */
  get hasOpenSegment(): boolean {
    return this.segment !== undefined && !this.segment.finished
  }

  /** Generation guard: a controller whose turn has been superseded must not touch the session. */
  get stale(): boolean {
    return this.disposed || this.session.turnSeq !== this.turnSeqAtStart
  }

  /**
   * Open the next segment and replay everything that landed since the cursor.
   * Visible events fold into the new segment (a card that was announced
   * between segments opens here); tool records are idempotent. Replaying may
   * itself finish the segment (card followed by prose — the prose belongs to
   * the NEXT message): the replay stops AT the cutting event without
   * consuming it, so the next segment replays it again.
   */
  startSegment(): SegmentState {
    // A step opening on an already settled turn (the response landed a tick
    // ago and the tail drain is still scheduled) closes that turn FIRST: the
    // step must read a settled controller and the session must not stay
    // `running` across the macrotask boundary — the host's next prompt would be
    // refused as busy for no reason.
    this.flushScheduledClose()
    // A step opening is the HOST handing the turn back to the agent — this
    // runs for the first step and for each continuation after the host
    // executed a card. The watchdog measures the stretch the AGENT holds the
    // floor, so the bounded gap a host step owns must not count as agent
    // silence; resetting here cannot mask a later agent silence because the
    // reset itself is bounded by one driver step.
    this.session.lastAgentActivityAt = Date.now()
    const seg: SegmentState = {
      queue: new AsyncQueue<StreamChunk>(),
      index: -1,
      activeType: null,
      activeText: '',
      outputChars: 0,
      activeToolCall: undefined,
      hasCard: false,
      // A segment opened DURING an ambient wait (never the steered first step,
      // which marks its own) inherits the suppression: the drain's tools still
      // stay transcript-only until the turn closes. A detached-worker hold
      // suppresses its cards for the same reason, and a PARKED hold must
      // suppress from the first replayed update on — the drain's TaskOutput
      // arrives in exactly that step.
      ambient: this.awaitingAmbient !== undefined
        || this.backgroundHold !== undefined
        || this.pendingBackgroundHold !== undefined,
      cardSettled: false,
      finished: false,
    }
    this.segment = seg
    const entries = this.session.transcript.since(this.cursorSeq)
    for (const entry of entries) {
      if (seg.finished) break
      const update = entry.update as Record<string, unknown>
      // The same split the live path makes: a background drain's prose is not
      // this turn's answer, even when it landed while no step was open. The
      // record (tool outputs) still goes in; the cursor moves past it.
      if (this.isForeignAmbientText(update)) {
        this.recordWithoutSegment(update)
        this.cursorSeq = entry.seq
        continue
      }
      if (!this.foldInto(seg, update, entry.seq)) break
      this.cursorSeq = entry.seq
    }
    if (!seg.finished && this.pendingProse.length > 0) {
      // Narrative that arrived between segments (a permission ask during card
      // execution): it belongs to the turn's story, so it opens this segment.
      const lines = this.pendingProse.splice(0, this.pendingProse.length).join('')
      this.emitProse(seg, 'reasoning', lines)
    }
    const parkedHold = this.pendingBackgroundHold
    if (parkedHold !== undefined && !seg.finished) {
      // The host opened the continuation step for the Agent card: the hold
      // finally has a driver step to speak the drain's answer into.
      this.adoptBackgroundHold(seg, parkedHold)
    }
    if (this.settled) this.finishAfterSettle(seg)
    return seg
  }

  /** Finish the segment on air (if any). Used by cancel paths and teardown. */
  finishActive(reason: SegmentFinishReason): void {
    if (this.segment !== undefined) this.finishSegment(this.segment, reason)
  }

  /** Whether this turn already streamed prose of its own (not a drain's). */
  get hasAgentProse(): boolean {
    return this.sawAgentProse
  }

  /**
   * Keep the turn open for a background drain the agent folded our prompt into.
   *
   * THE SHAPE: the agent answered `session/prompt` at once (CodeBuddy returns
   * `end_turn` in ~14ms when it merges the message into a drain it is already
   * running) and the real answer streams afterwards under the DRAIN's request
   * id. Closing on the response would cut the turn before its text exists —
   * which is exactly the bug this state exists for. So:
   *
   * - the agent-side prompt slot is released (`endTurn`: the response HAS
   *   landed) but the turn is NOT settled: `settled` means "the turn is over",
   *   and it is not — no `turn/end`, no `running = false`, no segment close;
   * - the segment keeps folding the session's updates, with cards suppressed
   *   (see `SegmentState.ambient`): the host must not execute a background
   *   tool for a turn whose answer has not begun;
   * - any update on the session resets the quiet clock, and the drain's end is
   *   its silence (a `session_end` is rejected by the SDK's schema and never
   *   reaches us — never wait for one); a hard ceiling closes what never ends.
   */
  awaitAmbient(requestId: string, stopReason: string): void {
    if (this.settled || this.disposed || this.awaitingAmbient !== undefined) return
    const seg = this.segment
    if (seg === undefined || seg.finished) {
      // No live driver step to speak into: nothing can be folded, so close the
      // turn the ordinary way rather than holding state that renders nothing.
      this.clearPendingAmbient()
      this.settle({ kind: 'stop', stopReason })
      return
    }
    seg.ambient = true
    // The response landed: the agent no longer holds a prompt for this turn.
    this.endTurn()
    // The drain may have spoken BEFORE the response was judged. Those updates
    // were withheld while this turn's own request id was unknowable (see
    // `pendingAmbientUpdates`); the turn IS the drain, so they are its answer —
    // folded in arrival order, now that `seg.ambient` suppresses their cards.
    this.flushPendingAmbient(seg)
    if (seg.finished) {
      this.settle({ kind: 'stop', stopReason })
      return
    }
    const wait: AmbientWait = {
      requestId,
      quietTimer: setTimeout(() => { this.onAmbientQuiet(wait) }, this.ambientTuning.quietMs),
      hardTimer: setTimeout(() => { this.onAmbientHard(wait) }, this.ambientTuning.maxMs),
      stopReason,
    }
    wait.quietTimer.unref?.()
    wait.hardTimer.unref?.()
    this.awaitingAmbient = wait
  }

  /**
   * The prompt response named no conversation turn while a drain the session
   * retired recently may still be running (and did not re-announce): the turn
   * cannot be held open, but a zero-output report must not blame the agent.
   * See `hasRecentRetiredAmbient` for the window.
   */
  noteRecentRetiredDrain(): void {
    this.recentRetiredDrain = true
  }

  /**
   * Whether the prompt response should keep this turn open for a detached
   * worker.
   *
   * With `backgroundHoldWorkerPhase` (a deployment tuning key) the answer is
   * whenever any dispatch is still running OR a detached one already reported
   * and left its drain pending. Without it, a RUNNING worker does not hold the
   * turn: the user keeps talking while it runs, and its report lands in the
   * transcript / NTR view. Only the short last window — every dispatch reported
   * and a detached one emitted worker updates, so the drain carrying the report
   * is imminent — is held.
   *
   * A synchronous `Agent` / `Task` call (completed, never declared
   * `isBackground`) matches neither and closes normally.
   */
  detachedHoldWanted(holdWorkerPhase: boolean): boolean {
    let drainPending = false
    for (const toolCallId of this.turnDispatchIds) {
      const dispatch = this.dispatches.get(toolCallId)
      if (dispatch === undefined) continue
      if (!dispatch.completed) {
        if (!holdWorkerPhase) return false
        return true
      }
      if (dispatch.detached && dispatch.sawWorkerUpdate) drainPending = true
    }
    return drainPending
  }

  /** A dispatch created while this turn was on air: the only work a hold waits for. */
  noteTurnDispatch(toolCallId: string): void {
    this.turnDispatchIds.add(toolCallId)
  }

  /** The hold this turn is inside — adopted, or parked waiting for a step. */
  private activeBackgroundHold(): BackgroundHold | undefined {
    return this.backgroundHold ?? this.pendingBackgroundHold
  }

  /** Every dispatch THIS TURN knows about reported (no dispatch counts as done). */
  private allDispatchesCompleted(): boolean {
    for (const toolCallId of this.turnDispatchIds) {
      const dispatch = this.dispatches.get(toolCallId)
      if (dispatch !== undefined && !dispatch.completed) return false
    }
    return true
  }

  /**
   * Hold the turn open for the detached worker(s) its `Agent` tool calls
   * dispatched — the second controlled ambient-family exception (constraint
   * 23), not a new idle watchdog.
   *
   * THE SHAPE (measured against CodeBuddy 2.179.0, multitask on): the
   * coordinator opens an `Agent` call that hands work to a background worker,
   * says "已派…", and the `session/prompt` RESPONSE arrives normally while the
   * worker keeps running. The worker's own updates (requestId B +
   * `parentToolCallId`) never touch this session's message; when it finishes,
   * the agent starts a background DRAIN (requestId A — the response's own
   * `conversationRequestId`) whose steps carry the report and the final answer.
   * Nothing tells the client the worker is running: no `session_end` (the SDK's
   * schema rejects it) and an `agentPhase` idle tick even fires BETWEEN the
   * worker and the drain. So the response cannot close the turn.
   *
   * The hold:
   * - releases the agent-side prompt slot (`endTurn`: the response landed)
   *   while keeping `running` and the driver step open;
   * - marks the segment background, so EVERY tool call for the rest of the
   *   hold — the workers', the drain's TaskOutput — stays transcript-only and
   *   the final message carries text with no card in front of it;
   * - waits in two phases: the worker phase's clock is a SILENCE window
   *   ({@link BridgeTuning.backgroundTaskMaxMs}) that every dispatch / worker
   *   update pushes out, so a long task that keeps reporting is never cut at a
   *   fixed total runtime. It ends when ALL known dispatches reported, after
   *   which the drain phase uses the ambient windows. An optional absolute
   *   ceiling ({@link BridgeTuning.backgroundTaskCeilingMs}, default none)
   *   bounds a zombie that keeps talking forever.
   */
  holdForBackgroundDispatch(stopReason: string, requestId?: string): void {
    if (this.settled || this.disposed || this.closedTurn || this.stale) return
    if (this.activeBackgroundHold() !== undefined) return
    const hold: BackgroundHold = {
      stopReason,
      requestId,
      acceptedIds: new Set<string>(),
      phase: 'worker',
      answerChars: 0,
      floorSeq: this.session.transcript.head,
      retired: false,
    }
    if (requestId !== undefined) hold.acceptedIds.add(requestId)
    // A drain announced while this turn was ALREADY on air belongs to it (the
    // announcement may have named a different id than the response). One that
    // predates the turn is some earlier run's, and folding its text would mix
    // two answers.
    const announced = this.session.ambient
    if (announced !== undefined && announced.startedAt >= this.constructedAt) {
      hold.acceptedIds.add(announced.requestId)
      if (hold.requestId === undefined) hold.requestId = announced.requestId
    }
    // The response landed: the agent no longer holds a prompt for this turn.
    this.endTurn()
    hold.hardTimer = setTimeout(() => { this.onBackgroundHard(hold) }, this.backgroundSilenceMs())
    hold.hardTimer.unref?.()
    this.armBackgroundCeiling(hold)
    const seg = this.segment
    if (seg !== undefined && !seg.finished) {
      this.adoptBackgroundHold(seg, hold)
    } else {
      // The response landed BETWEEN driver steps: the host is about to execute
      // the Agent card and open its continuation step. Park the hold for that
      // step, with a bounded wait — a host that never opens one must not hang
      // the turn forever.
      hold.graceTimer = setTimeout(() => { this.onBackgroundGraceExpired(hold) }, this.backgroundTuning.graceMs)
      hold.graceTimer.unref?.()
      this.pendingBackgroundHold = hold
    }
    // A FAST detached worker may already have reported (even before the
    // response): with every known dispatch complete there is no worker phase
    // left to wait out, so the drain phase starts now.
    if (this.allDispatchesCompleted()) this.startBackgroundDrain(hold)
  }

  /** Give a (possibly parked) hold a driver segment: cards off for the rest of it. */
  private adoptBackgroundHold(seg: SegmentState, hold: BackgroundHold): void {
    if (hold.graceTimer !== undefined) {
      clearTimeout(hold.graceTimer)
      hold.graceTimer = undefined
    }
    if (this.pendingBackgroundHold === hold) this.pendingBackgroundHold = undefined
    seg.ambient = true
    this.backgroundHold = hold
    // The drain may have spoken BEFORE the response was judged. Those updates
    // were withheld while this turn's own id was unknown
    // (`pendingAmbientUpdates`); only the runs THIS hold owns are its answer —
    // another run's withheld text is dropped (the transcript keeps it).
    this.flushBackgroundHoldUpdates(seg, hold)
    // The parked grace owns the wait while no step is on air; now that one is,
    // a hold whose drain phase already began arms its quiet clock.
    if (hold.phase === 'drain') this.armBackgroundQuiet(hold)
  }

  /**
   * The worker phase is over once EVERY known dispatch reported: the drain
   * that carries their reports is (about to be) running, so the existing
   * ambient windows take over, measured from HERE.
   *
   * An announced run is accepted immediately, but while any dispatch is still
   * incomplete it only records the id and switches the hold's primary run —
   * arming the quiet clock there would let a drain that spoke early cut the
   * turn off before its other worker ever reports.
   */
  private startBackgroundDrain(hold: BackgroundHold, requestId?: string): void {
    if (hold !== this.backgroundHold && hold !== this.pendingBackgroundHold) return
    if (requestId !== undefined) {
      hold.acceptedIds.add(requestId)
      hold.requestId = requestId
    }
    if (!this.allDispatchesCompleted()) return
    if (hold.phase === 'drain') {
      if (this.backgroundHold === hold) this.armBackgroundQuiet(hold)
      return
    }
    hold.phase = 'drain'
    if (hold.hardTimer !== undefined) clearTimeout(hold.hardTimer)
    hold.hardTimer = setTimeout(() => { this.onBackgroundHard(hold) }, this.ambientTuning.maxMs)
    hold.hardTimer.unref?.()
    // A parked hold belongs to the grace until a driver step opens; a hold
    // with a step arms its quiet clock now.
    if (this.backgroundHold === hold) this.armBackgroundQuiet(hold)
  }

  /**
   * A dispatch that lands while the drain phase already began means the
   * coordinator handed out NEW work: the worker phase is back, and with it the
   * absence of a quiet window.
   */
  private enterBackgroundWorkerPhase(hold: BackgroundHold): void {
    if (hold.phase === 'worker') return
    hold.phase = 'worker'
    if (hold.quietTimer !== undefined) {
      clearTimeout(hold.quietTimer)
      hold.quietTimer = undefined
    }
    if (hold.hardTimer !== undefined) clearTimeout(hold.hardTimer)
    hold.hardTimer = setTimeout(() => { this.onBackgroundHard(hold) }, this.backgroundSilenceMs())
    hold.hardTimer.unref?.()
  }

  /** Push the drain phase's quiet clock out: every update is evidence of work. */
  private armBackgroundQuiet(hold: BackgroundHold): void {
    if (hold.quietTimer !== undefined) clearTimeout(hold.quietTimer)
    hold.quietTimer = setTimeout(() => { this.onBackgroundQuiet(hold) }, this.ambientTuning.quietMs)
    hold.quietTimer.unref?.()
  }

  /**
   * Evidence from a live dispatch / worker: the worker phase is SILENCE-based,
   * so each update pushes its deadline out. A long task that keeps reporting is
   * never cut at a fixed total runtime; only a genuinely quiet worker is.
   */
  private noteBackgroundWorkerActivity(): void {
    const hold = this.activeBackgroundHold()
    if (hold === undefined || hold.phase !== 'worker' || hold.retired) return
    if (hold.hardTimer !== undefined) clearTimeout(hold.hardTimer)
    hold.hardTimer = setTimeout(() => { this.onBackgroundHard(hold) }, this.backgroundSilenceMs())
    hold.hardTimer.unref?.()
  }

  /**
   * The worker phase's silence window, by the worker's LAST KNOWN state: an
   * open worker tool call gets the long tier (`toolMaxMs`), an idle one the
   * short tier (`taskMaxMs`). Same shape as the main turn's
   * `turnStallMs` / `turnStallToolMs` pair.
   */
  private backgroundSilenceMs(): number {
    return this.workerToolCalls.size > 0 ? this.backgroundTuning.toolMaxMs : this.backgroundTuning.taskMaxMs
  }

  /** Arm the hold's optional absolute ceiling (0 = unlimited). */
  private armBackgroundCeiling(hold: BackgroundHold): void {
    if (this.backgroundTuning.ceilingMs <= 0) return
    hold.ceilingTimer = setTimeout(() => { this.onBackgroundHard(hold) }, this.backgroundTuning.ceilingMs)
    hold.ceilingTimer.unref?.()
  }

  /**
   * Any session update restarts the drain phase's quiet clock. Only an
   * ADOPTED hold has a quiet clock: a parked hold's wait belongs to its grace
   * timer, and the worker phase is pushed forward only by dispatch / worker
   * evidence (see `noteBackgroundWorkerActivity`).
   */
  private noteBackgroundHoldActivity(): void {
    const hold = this.backgroundHold
    if (hold === undefined || hold.phase !== 'drain') return
    this.armBackgroundQuiet(hold)
  }

  /** The drained run went quiet: the turn ends with the stop reason the response gave. */
  private onBackgroundQuiet(hold: BackgroundHold): void {
    if (this.backgroundHold !== hold || hold.phase !== 'drain') return
    this.closeBackgroundHold(hold, { hard: false })
  }

  /** The hold went silent past its window, or outlived the absolute ceiling. */
  private onBackgroundHard(hold: BackgroundHold): void {
    if (hold !== this.backgroundHold && hold !== this.pendingBackgroundHold) return
    // The ceiling is the evidence the worker (or its drain) never finished:
    // a row that keeps `running` here would pin the idle clock forever.
    this.manager.terminalizeSessionDispatches(this.session, 'unknown')
    this.closeBackgroundHold(hold, { hard: true })
  }

  /**
   * No driver step opened inside the grace: the host is not coming back for
   * this turn's Agent card. Close it the way a quiet ambient ending does — the
   * deferral line, never the zero-output blame — and keep ONE drain record:
   * the worker may still report into a run no turn is waiting on.
   *
   * A parked hold has NO segment by definition, so the chat plane has nowhere
   * to put the deferral line: it goes to the settings log (`agent/notice`)
   * instead of being parked on prose nobody will read.
   */
  private onBackgroundGraceExpired(hold: BackgroundHold): void {
    if (this.pendingBackgroundHold !== hold) return
    this.pendingBackgroundHold = undefined
    // No step came back for this turn: nobody is left to read a report, so the
    // unfinished rows must not stay `running` (they would pin the idle clock).
    this.manager.terminalizeSessionDispatches(this.session, 'unknown')
    this.clearBackgroundHoldTimers(hold)
    const line = hold.answerChars > 0 ? undefined : backgroundDeferralLine(this.session.agentId)
    this.releaseBackgroundHoldIds(hold, { hard: true })
    if (line !== undefined) this.broadcastBackgroundDeferral(line)
    this.closeTurn({ kind: 'stop', stopReason: hold.stopReason }, { line, keepAmbient: true, requestId: hold.requestId })
  }

  /**
   * Close a detached-worker hold exactly once. A turn that folded NO answer
   * text from its held runs says where the rest of the output will land (the
   * deferral wording, never the silent-failure blame); the parent's interim
   * acknowledgement does not count as that answer.
   *
   * Ownership of the drain ids at close (`releaseBackgroundHoldIds`): a quiet
   * close retires every accepted id and drops the session record; a hard or
   * grace close keeps exactly ONE record, because the run is provably still
   * going and a later update or re-announcement must revive it normally.
   */
  private closeBackgroundHold(hold: BackgroundHold, options: { hard: boolean }): void {
    if (this.pendingBackgroundHold === hold) this.pendingBackgroundHold = undefined
    else if (this.backgroundHold === hold) this.backgroundHold = undefined
    else return
    this.clearBackgroundHoldTimers(hold)
    const line = hold.answerChars > 0 ? undefined : backgroundDeferralLine(this.session.agentId)
    this.releaseBackgroundHoldIds(hold, { hard: options.hard })
    const onAir = this.segment !== undefined && !this.segment.finished
    // With no segment on air the closing line has no chat bubble to land in:
    // log it, so the fact is recorded rather than silently dropped.
    if (line !== undefined && !onAir) this.broadcastBackgroundDeferral(line)
    this.closeTurn(
      { kind: 'stop', stopReason: hold.stopReason },
      { line, keepAmbient: options.hard, requestId: hold.requestId },
    )
  }

  /** Write a hold's deferral line into the settings log (`agent/notice`). */
  private broadcastBackgroundDeferral(line: string): void {
    this.hub.broadcast({
      type: 'agent/notice',
      agentId: this.session.agentId,
      level: 'info',
      text: line.trim(),
    })
  }

  /** Drop a hold's clocks. The hold object itself stays for its `retired` mark. */
  private clearBackgroundHoldTimers(hold: BackgroundHold): void {
    if (hold.quietTimer !== undefined) clearTimeout(hold.quietTimer)
    if (hold.hardTimer !== undefined) clearTimeout(hold.hardTimer)
    if (hold.ceilingTimer !== undefined) clearTimeout(hold.ceilingTimer)
    if (hold.graceTimer !== undefined) clearTimeout(hold.graceTimer)
    hold.quietTimer = undefined
    hold.hardTimer = undefined
    hold.ceilingTimer = undefined
    hold.graceTimer = undefined
  }

  /**
   * Drop every hold clock (teardown / a forced ending). `retire` also gives up
   * every accepted run id — a SUCCESSOR turn must never fold the abandoned
   * hold's drain or worker text into its own answer.
   */
  private clearBackgroundHold(options?: { retire?: boolean }): void {
    const pending = this.pendingBackgroundHold
    if (pending !== undefined) {
      this.pendingBackgroundHold = undefined
      this.clearBackgroundHoldTimers(pending)
      if (options?.retire === true) this.releaseBackgroundHoldIds(pending, { hard: false })
    }
    const hold = this.backgroundHold
    if (hold === undefined) return
    this.backgroundHold = undefined
    this.clearBackgroundHoldTimers(hold)
    if (options?.retire === true) this.releaseBackgroundHoldIds(hold, { hard: false })
  }

  /**
   * Settle what happens to the session's drain records when a hold closes.
   *
   * `hard: false` (quiet close, cancel, teardown): the run is no longer waited
   * on, so EVERY accepted id is retired — its late text stays transcript-only
   * for whatever turn runs next — and the session record is dropped if it
   * names one of them.
   *
   * `hard: true` (ceiling / parked grace): the run is provably still going.
   * Exactly ONE record survives — the session's current drain if it has one,
   * else the hold's primary run — with its activity clock refreshed; the other
   * accepted ids are retired. A hold whose primary id had no session record
   * CREATES one, so a successor's `noteTurnRequestId` cannot adopt that id.
   * Every accepted id therefore ends up either retired or owned by
   * `session.ambient`; never both unowned and unretired.
   */
  private releaseBackgroundHoldIds(hold: BackgroundHold, options: { hard: boolean }): void {
    if (hold.retired) return
    hold.retired = true
    if (!options.hard) {
      for (const id of hold.acceptedIds) retireAmbientId(this.session, id)
      if (this.session.ambient !== undefined && hold.acceptedIds.has(this.session.ambient.requestId)) {
        this.session.ambient = undefined
      }
      return
    }
    const survivor = this.session.ambient?.requestId ?? hold.requestId
    for (const id of hold.acceptedIds) {
      if (id === survivor) continue
      retireAmbientId(this.session, id)
    }
    if (survivor === undefined) return
    const now = Date.now()
    if (this.session.ambient?.requestId === survivor) {
      this.session.ambient.lastActivityAt = now
    } else {
      this.session.ambient = {
        requestId: survivor,
        startedAt: now,
        lastActivityAt: now,
        sawOutput: hold.answerChars > 0,
      }
    }
    // The surviving run is alive, not retired (an earlier wait of this turn
    // may have retired it before it spoke again).
    reviveAmbientId(this.session, survivor)
  }

  /**
   * Fold the withheld drain updates that belong to this hold into its segment.
   * The rest of the buffer was some OTHER run's text: it is dropped here (the
   * transcript keeps it), never leaked into this turn's answer.
   */
  private flushBackgroundHoldUpdates(seg: SegmentState, hold: BackgroundHold): void {
    if (this.pendingAmbientUpdates.length === 0) {
      this.pendingAmbientTruncated = false
      return
    }
    const pending = this.pendingAmbientUpdates.splice(0, this.pendingAmbientUpdates.length)
    this.pendingAmbientChars = 0
    const truncated = this.pendingAmbientTruncated
    this.pendingAmbientTruncated = false
    const accepted = pending.filter(entry => {
      const requestId = codebuddyMetaOf(entry.update)?.requestId
      return requestId !== undefined && hold.acceptedIds.has(requestId)
    })
    if (accepted.length === 0) return
    if (truncated && !seg.finished) {
      // The front of the drain's output was evicted from the bounded buffer:
      // say so rather than letting the turn quietly start mid-story.
      this.emitProse(seg, 'text', '\n[dsh-ntr] background output was truncated; the ACP transcript view still has every update.\n')
    }
    for (const entry of accepted) {
      if (seg.finished) break
      this.foldInto(seg, entry.update, entry.seq)
      // The buffered drain text arrived BEFORE the hold, but it IS the held
      // run's answer: below the hold's floor it was not counted by `foldInto`,
      // so count it here (the floor exists to skip the parent's earlier ack,
      // not the drain's own words).
      if (entry.seq <= hold.floorSeq
        && String(entry.update.sessionUpdate ?? '') === 'agent_message_chunk') {
        hold.answerChars += chunkTextOf(entry.update.content).length
      }
    }
  }

  /**
   * A session-level dispatch frame landed. A live hold pushes its worker
   * silence clock; once every known dispatch reported, the hold moves to its
   * drain phase.
   */
  onBackgroundDispatchFrame(): void {
    this.noteBackgroundWorkerActivity()
    const held = this.activeBackgroundHold()
    if (held === undefined) return
    if (!this.allDispatchesCompleted()) {
      // New work handed out after the drain phase began: the worker phase (and
      // its silence window) is back, so no drain quiet clock may cut the turn.
      this.enterBackgroundWorkerPhase(held)
      return
    }
    this.startBackgroundDrain(held)
  }

  /** The agent announced the drain that carries a detached worker's report. */
  onBackgroundDrainAnnounced(requestId: string): void {
    const held = this.activeBackgroundHold()
    if (held === undefined) return
    this.noteBackgroundWorkerActivity()
    this.startBackgroundDrain(held, requestId)
  }

  /** Every known dispatch reported: a live hold moves to its drain phase. */
  onAllDispatchesCompleted(): void {
    if (!this.allDispatchesCompleted()) return
    const held = this.activeBackgroundHold()
    if (held !== undefined) this.startBackgroundDrain(held)
  }

  /**
   * A worker's own tool call moved: the long-tier silence evidence for a
   * worker-phase hold (see `backgroundSilenceMs`). No-op for a turn that is
   * already closed (the worker now reports through the session record).
   */
  onWorkerToolCall(kind: string, toolCallId: string, status: string): void {
    if (toolCallId === '' || (kind !== 'tool_call' && kind !== 'tool_call_update')) return
    if (status === 'completed' || status === 'failed') this.workerToolCalls.delete(toolCallId)
    else if (status === 'pending' || status === 'in_progress') this.workerToolCalls.add(toolCallId)
    else if (kind === 'tool_call' && status === '') this.workerToolCalls.add(toolCallId)
    // The set decides the NEXT window's tier, so the silence clock has to be
    // re-armed with the new tier now (a worker entering a long tool switches
    // the hold from the short tier to the long one).
    this.noteBackgroundWorkerActivity()
  }

  /** Any session update is evidence the drain still works: push the quiet clock out. */
  private noteAmbientActivity(): void {
    const wait = this.awaitingAmbient
    if (wait === undefined) return
    clearTimeout(wait.quietTimer)
    wait.quietTimer = setTimeout(() => { this.onAmbientQuiet(wait) }, this.ambientTuning.quietMs)
    wait.quietTimer.unref?.()
  }

  /** The drain went quiet: the turn ends with the stop reason the response gave. */
  private onAmbientQuiet(wait: AmbientWait): void {
    if (this.awaitingAmbient !== wait) return
    this.finishAmbient(wait)
  }

  /** The drain outlived the ceiling: say where the rest will land, then close. */
  private onAmbientHard(wait: AmbientWait): void {
    if (this.awaitingAmbient !== wait) return
    const seg = this.segment
    if (seg !== undefined && !seg.finished) {
      this.emitProse(seg, 'text', `\n[dsh-ntr] agent "${this.session.agentId}" is still running a background task; the rest of its output will appear in the ACP transcript view.\n`)
    }
    // The ceiling is evidence the drain is STILL RUNNING (unlike a quiet close),
    // so the ending keeps the session's drain record; see `closeTurn`.
    wait.hard = true
    // The hard explanation already says the turn was cut short; the deferred
    // line would only repeat it in different words.
    this.finishAmbient(wait, { announceDeferral: false })
  }

  /**
   * Close an ambient wait exactly once. A turn that produced no answer TEXT
   * says so: the drain's output is in the ACP transcript view, and this
   * bubble must not be empty (the zero-output report, reworded for a turn that
   * was deferred rather than failed).
   */
  private finishAmbient(wait: AmbientWait, options?: { announceDeferral?: boolean }): void {
    if (this.awaitingAmbient !== wait) return
    const line = options?.announceDeferral === false || this.sawVisibleText
      ? undefined
      : backgroundDeferralLine(this.session.agentId)
    this.closeTurn(
      { kind: 'stop', stopReason: wait.stopReason },
      { line, keepAmbient: wait.hard === true, requestId: wait.requestId },
    )
  }

  /** Drop the ambient wait's clocks (the turn is being closed by someone else). */
  private clearAmbientWait(): void {
    const wait = this.awaitingAmbient
    if (wait === undefined) return
    this.awaitingAmbient = undefined
    clearTimeout(wait.quietTimer)
    clearTimeout(wait.hardTimer)
  }

  /**
   * Withhold one background-drain update until the prompt response says what
   * this turn is. The cursor advances past it anyway: it is already in the
   * transcript, and replaying it into a later segment would emit it twice.
   * Bounded (see `PENDING_AMBIENT_MAX_*`) — the transcript still keeps every
   * entry the buffer drops.
   */
  private bufferAmbientUpdate(seq: number, update: Record<string, unknown>): void {
    const chars = JSON.stringify(update).length
    this.pendingAmbientUpdates.push({ seq, update, chars })
    this.pendingAmbientChars += chars
    while (this.pendingAmbientUpdates.length > PENDING_AMBIENT_MAX_ENTRIES
      || (this.pendingAmbientChars > PENDING_AMBIENT_MAX_CHARS && this.pendingAmbientUpdates.length > 1)) {
      const dropped = this.pendingAmbientUpdates.shift()
      if (dropped === undefined) break
      this.pendingAmbientChars -= dropped.chars
      this.pendingAmbientTruncated = true
    }
  }

  /** Fold the withheld drain updates into the now-ambient segment, once, in order. */
  private flushPendingAmbient(seg: SegmentState): void {
    if (this.pendingAmbientUpdates.length === 0) {
      this.pendingAmbientTruncated = false
      return
    }
    const truncated = this.pendingAmbientTruncated
    this.pendingAmbientTruncated = false
    const pending = this.pendingAmbientUpdates.splice(0, this.pendingAmbientUpdates.length)
    this.pendingAmbientChars = 0
    if (truncated && !seg.finished) {
      // The front of the drain's output was evicted from the bounded buffer:
      // say so rather than letting the turn quietly start mid-story.
      this.emitProse(seg, 'text', '\n[dsh-ntr] background output was truncated; the ACP transcript view still has every update.\n')
    }
    for (const entry of pending) {
      if (seg.finished) break
      this.foldInto(seg, entry.update, entry.seq)
    }
  }

  /** Drop withheld drain updates: this turn is not the drain, or it is closing. */
  private clearPendingAmbient(): void {
    this.pendingAmbientUpdates.length = 0
    this.pendingAmbientChars = 0
    this.pendingAmbientTruncated = false
  }

  /** The agent settled its `session/prompt`. Ends the turn's streaming face. */
  settle(outcome: TurnSettle): void {
    if (this.settled) return
    // `settled` is claimed NOW (a second settle, a cancel or a watchdog that
    // races the tail drain must find the turn already spoken for), but the
    // CLOSING work waits one macrotask: the SDK dispatches `session/update`
    // notifications independently of the `session/prompt` RESPONSE, so the
    // agent's last chunks can still be queued when this lands (see
    // `settleTranscript`). Only what already reached the transcript is read —
    // one macrotask, never an open-ended wait.
    this.settled = true
    this.clearAmbientWait()
    this.clearPendingAmbient()
    // An outside ending (watchdog, cancel) abandons a detached-worker hold: its
    // run is no longer this turn's, so its id is retired before the close.
    this.clearBackgroundHold({ retire: true })
    this.pendingOutcome = outcome
    this.closeScheduled = true
    setImmediate(() => { this.flushScheduledClose() })
  }

  /**
   * Force the local end of this turn — the cancel fallback and any watchdog
   * that reached the controller. Runs the SAME closing work as a normal settle
   * (`closeTurn`): the ambient clocks stop, the on-air segment closes (so the
   * driver step parked on its queue ends), exactly one `turn/end` goes out
   * with THIS turn's id, the session stops running and the prompt slot is
   * released. Idempotent: a turn that already closed ignores the call.
   */
  forceFinalize(outcome: TurnSettle): void {
    if (this.stale || this.closedTurn) return
    this.clearAmbientWait()
    // A forced ending abandons a detached-worker hold: retire its run's id so
    // its late words stay transcript-only for the next turn.
    this.clearBackgroundHold({ retire: true })
    // A settle's deferred tail read is moot once this close runs: the turn is
    // over now, and the pending macrotask must not drain anything into it.
    this.pendingOutcome = undefined
    this.closeScheduled = false
    this.closeTurn(outcome)
  }

  /**
   * Run the deferred closing work now, when a driver step is about to open on
   * an already settled turn: the continuation step must see the closed turn
   * (and the session NOT left `running` across the macrotask boundary).
   * Idempotent — the scheduled tick then finds nothing left to do.
   */
  private flushScheduledClose(): void {
    if (!this.closeScheduled) return
    this.closeScheduled = false
    const outcome = this.pendingOutcome
    this.pendingOutcome = undefined
    if (outcome === undefined) return
    // A DISPOSE that raced this queued close cleared it (see `dispose`), so a
    // close still scheduled here belongs to a settle that landed AFTER the
    // stream was retired (a crash rejects its prompt only after the teardown).
    // That turn still ends through its own queue and real id — the teardown's
    // releaseAll frame carried an empty id.
    this.drainTail()
    this.closeTurn(outcome)
  }

  /**
   * Fold the notifications that reached the transcript but not the segment:
   * the tail a response raced past. Stops AT a cutting event without consuming
   * it (same rule as `startSegment`) — its next segment is not this turn's.
   */
  private drainTail(): void {
    // The deferred read belongs to the turn that scheduled it. If the turn was
    // retired or a NEWER turn already began (turnSeq moved on) in this one
    // macrotask window, everything past the cursor is the successor's: folding
    // it here would leak its text into this turn's driver step.
    if (this.stale) return
    const seg = this.segment
    if (seg === undefined || seg.finished) return
    for (const entry of this.session.transcript.since(this.cursorSeq)) {
      if (seg.finished) break
      const update = entry.update as Record<string, unknown>
      // The same split the live path makes: a background drain's text in the
      // tail is not this turn's answer. Record what the registry needs (tool
      // outputs), move the cursor past it, and do NOT fold it — otherwise the
      // deferred read smuggles the drain's prose into a normal turn.
      if (this.isForeignAmbientText(update)) {
        this.recordWithoutSegment(update)
        this.cursorSeq = entry.seq
        continue
      }
      if (!this.foldInto(seg, update, entry.seq)) break
      this.cursorSeq = entry.seq
    }
  }

  /**
   * End the turn exactly once: burst metrics, ONE `turn/end`, the provisional
   * lock, the closing text, the segment, the session flags, the prompt slot.
   *
   * `ambient.line` marks a controlled ambient ending: the given line closes
   * the segment when the turn carried no answer text, instead of the generic
   * zero-output warning (which would blame the agent for a turn the drain
   * simply had not finished yet). `ambient.keepAmbient` says the ending was the
   * CEILING, not silence: see the drain-record comment below.
   */
  private closeTurn(outcome: TurnSettle, ambient?: { line?: string; keepAmbient?: boolean; requestId?: string }): void {
    if (this.closedTurn) return
    this.closedTurn = true
    // A closed turn is a settled turn, whichever path got here first (an
    // ambient ending does not go through `settle`).
    this.settled = true
    this.clearAmbientWait()
    this.clearPendingAmbient()
    // Whoever closed this turn already decided what happens to the held
    // run's record (`closeBackgroundHold` retired or kept it); only the clocks
    // are still ours to drop.
    this.clearBackgroundHold()
    // A worker that is still running is NOT terminalized here: it outlives
    // this turn (see `LiveSession.backgroundDispatches`), and only a session
    // teardown writes `unknown` for it. The turn closing is not evidence the
    // worker stopped.
    // A late answer to a SUPERSEDED turn still has to close this controller's
    // queue (a continuation step may be parked on it) and its settle gate —
    // but it must not touch the session the NEWER turn now owns, nor release
    // process-wide waiters that belong to that turn.
    const current = this.session.turnSeq === this.turnSeqAtStart
    if (current) {
      // A user cancel stops THIS turn's workers on the agent side too, and an
      // ERROR / watchdog ending means the agent stopped responding: neither
      // leaves a worker that can still report. Only this turn's own dispatches
      // are touched — a worker left over from an EARLIER turn may still run.
      if (outcome.kind === 'cancelled') this.manager.terminalizeSessionDispatches(this.session, 'cancelled', this.turnDispatchIds)
      else if (outcome.kind === 'error') this.manager.terminalizeSessionDispatches(this.session, 'unknown', this.turnDispatchIds)
    }
    const reason: SegmentFinishReason = outcome.kind === 'cancelled'
      ? { kind: 'aborted', failure: { message: 'Turn was cancelled', code: 'CANCELLED' } }
      : outcome.kind === 'error'
        ? { kind: 'error', failure: { message: outcome.message, code: outcome.code ?? 'INTERNAL' } }
        : { kind: 'stop' }
    if (current) {
      // An ambient ending that came from SILENCE retires the drain record with
      // its turn: a record that outlives the wait would make the NEXT instant
      // answer with no conversation request id look steered (see
      // `awaitAmbient`), holding a normal turn open for a drain this one
      // already finished waiting on. A HARD ceiling ending is the opposite
      // evidence — the drain was still ticking when the turn was cut — so the
      // record SURVIVES (activity clock refreshed; `ambientStaleMs` expires it
      // lazily) precisely so the next prompt folded into the same drain is
      // still recognised as steered. `ambientNotices` is never cleared here:
      // a repeated announcement of the same run must stay silent, and the set
      // is bounded where entries are added.
      if (ambient !== undefined) {
        if (ambient.keepAmbient === true) {
          if (this.session.ambient !== undefined) this.session.ambient.lastActivityAt = Date.now()
        } else {
          // Silence closed this wait, but silence is not proof the run ended: a
          // queued message or a long tool can make the drain speak again. So
          // RETIRE its id before dropping the record — a revived run's late
          // text must stay in the ACP transcript view instead of teaching the
          // NEXT turn the drain's id and mixing the drain's answer into the
          // user's (a double answer). The trade-off is deliberate: a next
          // prompt the agent folds into that same revived drain may not receive
          // the drain's text on the chat plane (transcript-only); a double
          // answer is worse.
          if (ambient.requestId !== undefined) retireAmbientId(this.session, ambient.requestId)
          this.session.ambient = undefined
        }
      }
      // The turn's burst aggregate must be visible before the turn is marked
      // over: the final `turn/metrics` lands first, then `turn/end` flips the
      // session/pill state. Persisting and broadcasting share one value.
      this.finalizeTps()
      if (outcome.kind === 'cancelled') {
        this.hub.broadcast({ type: 'turn/end', sessionId: this.session.sessionId, turnId: this.turnId, stopReason: 'cancelled' })
      } else if (outcome.kind === 'error') {
        // `errorKind` rides along only when the host classified the failure:
        // a quota refusal is the one error a browser surface acts on (the
        // composer's dock card), so it must not have to re-read the message.
        this.hub.broadcast({
          type: 'turn/end',
          sessionId: this.session.sessionId,
          turnId: this.turnId,
          error: outcome.message,
          ...(outcome.errorKind !== undefined ? { errorKind: outcome.errorKind } : {}),
        })
      } else {
        this.hub.broadcast({ type: 'turn/end', sessionId: this.session.sessionId, turnId: this.turnId, stopReason: outcome.stopReason })
      }
      // The provisional lock settles BEFORE any synthesized warning below: the
      // warning is our text, not evidence that the first turn delivered anything.
      //
      // An AMBIENT ending ends the provisional phase WITHOUT a rollback: a
      // deferral to a background drain is not a failed first turn, the drain's
      // text still lands in the ACP transcript view, and rolling the lock back
      // would close the session under it — dropping exactly the output the
      // deferred turn promised. The lock therefore becomes permanent.
      if (this.session.provisionalLock === true) {
        this.session.provisionalLock = false
        if (!this.sawVisibleBlock && ambient === undefined) this.rollbackFirstTurn(this.session)
      }
    }
    const seg = this.segment
    if (seg !== undefined) {
      if (ambient !== undefined) {
        // The ambient line is OUR report, so it only appears when the drain
        // delivered no answer text of its own; reasoning alone does not count.
        if (ambient.line !== undefined && current) this.emitProse(seg, 'text', ambient.line)
      } else if (current && outcome.kind === 'stop' && !this.sawVisibleBlock) {
        // The silent-failure report: a normal stop with nothing the chat
        // plane renders. Aborted or failing turns need no extra hint; this
        // is specifically "protocol says success, the bubble is empty".
        this.emitProse(seg, 'text', this.zeroOutputLine(outcome.stopReason, outcome.refusal))
      }
      this.finishSegment(seg, reason)
    }
    // When no segment is on air (the turn ended on a card) the FINAL
    // continuation step collects the tail: `startSegment` sees `settled` and
    // finishes it with the appropriate closing line.
    if (current) {
      this.session.running = false
      // The turn is over: no call from it can still earn the long tool window.
      this.session.activeToolCalls.clear()
      releaseAllToolOutputWaiters()
    }
    this.endTurn()
    // The controller stays indexed only while a continuation step can still
    // come for its cards. A cancelled, failed, or card-less turn has none: retire
    // it now; the next turn's `rememberTurnStream` would anyway. An ambient turn
    // ALWAYS retires: its suppressed calls never open cards, so keeping the index
    // would pin the controller (and its session id) to a turn nobody can continue.
    if (!current) this.retire()
    else if (ambient !== undefined || outcome.kind !== 'stop' || this.seenCalls.size === 0) this.dispose()
  }

  /**
   * Cancelled by the user: finish the on-air segment and release the turn's
   * slots. An AMBIENT turn has already released the prompt slot (its response
   * landed) and holds no segment the cancel fallback could close, so the
   * cancel closes the turn itself with the cancelled stop.
   */
  abortActiveSegment(): void {
    if (this.stale) return
    this.clearPendingAmbient()
    if (this.closeScheduled) {
      // `settle` claimed the turn but queued its closing work for the next
      // macrotask. An abort landing inside that window must not let the
      // scheduled close broadcast the RESPONSE's stop reason while the segment
      // already finished `aborted`: drop the queued outcome and close NOW with
      // the cancelled one, so `turn/end` and the segment's finish agree.
      this.closeScheduled = false
      this.pendingOutcome = undefined
      this.closeTurn({ kind: 'cancelled' })
      return
    }
    if (this.awaitingAmbient !== undefined) {
      this.settle({ kind: 'cancelled' })
      return
    }
    if (this.backgroundHold !== undefined || this.pendingBackgroundHold !== undefined) {
      // A detached-worker hold is a turn whose prompt response already landed
      // (the slot is free) and whose segment is still open on purpose: the
      // cancel ends OUR face of it now, once, and the held run's id is retired
      // so its late text cannot join the next turn.
      this.clearBackgroundHold({ retire: true })
      this.settle({ kind: 'cancelled' })
      return
    }
    this.finishActive({ kind: 'aborted', failure: { message: 'aborted', code: 'ABORTED' } })
    // The agent may take its time acknowledging the cancel, but OUR face of
    // the turn ends now: the session stops running, the HOST's prompt slot is
    // released (so a new prompt may claim it), and a provisional first lock
    // settles against what was actually shown. The AGENT-side gate (`settled`)
    // stays claimed: the prompt is still in flight over there, and a second
    // prompt sent into that window would be a concurrent `session/prompt` the
    // protocol forbids — `claimTurn` waits it out, `settle` (or the cancel
    // fallback) opens it.
    this.session.running = false
    this.session.promptInFlight = false
    if (this.session.provisionalLock === true) {
      this.session.provisionalLock = false
      if (!this.sawVisibleBlock) this.rollbackFirstTurn(this.session)
    }
    releaseAllToolOutputWaiters()
  }

  /**
   * Stop observing and release the manager's index. Idempotent.
   *
   * The segment is CLOSED here (aborted) before unsubscribing: a driver step
   * parked on its queue (`yield* segment.queue`) only ends when the queue
   * closes, and a controller replaced by the conversation's next turn would
   * otherwise leave that step hanging forever. An already finished segment is a
   * no-op, and the session's flags are left alone — a superseded turn must not
   * mark the newer turn's session idle.
   */
  dispose(): void {
    if (this.disposed) return
    // A settle may have queued its closing work for the next macrotask: this
    // close owns the turn now, so that tick must not broadcast a second
    // `turn/end` (with this turn's real id) over the teardown.
    this.closeScheduled = false
    this.pendingOutcome = undefined
    this.finishActive({ kind: 'aborted', failure: { message: 'turn stream retired', code: 'RETIRED' } })
    this.clearAmbientWait()
    this.clearPendingAmbient()
    // A successor turn must never fold this hold's drain or worker text: the
    // abandoned run's id is retired before the subscription goes away.
    this.clearBackgroundHold({ retire: true })
    // A still-running worker is NOT terminalized here: retiring a turn is not
    // evidence its worker stopped. Only a session teardown writes `unknown`
    // (see `AgentBridge.onSessionBackgroundTeardown`).
    this.retire()
    releaseAllToolOutputWaiters()
  }

  /**
   * Stop observing and release the manager's index WITHOUT touching the
   * process-wide tool-output waiters. A late settle of a superseded turn must
   * use this: those waiters now belong to the turn on air, and waking them
   * early would hand the guard a "no output" answer for a tool still running.
   */
  retire(): void {
    if (this.disposed) return
    this.disposed = true
    this.clearCardSettle()
    this.unsubscribe()
    // The session must not keep pointing at a retired turn: the stall watchdog
    // reads this slot as "what is streaming now". A newer controller may have
    // replaced it since, and that one is not ours to clear.
    if (this.session.turnController === this) this.session.turnController = undefined
    this.manager.forgetTurnStream(this)
  }

  // ---- internals ----

  /**
   * Settle the open tool card's BLOCK once the agent goes quiet.
   *
   * Why this exists: the host's live "preparing" row only advances on
   * `argumentsDelta`; an ACP update restates its input in whole, which the
   * concatenating accumulator cannot express. Waiting for the next non-tool
   * event therefore delays the real command until the agent speaks again, and
   * a long-running tool speaks only after it finished. Closing the block on a
   * short quiet window lets the row settle its arguments (the real command)
   * while the tool still runs.
   *
   * The SEGMENT stays open: the card is still its last block, the host still
   * settles the message (and executes the card) on the next non-tool event,
   * and the watchdog / continuation semantics do not move. Skipped when the
   * card disclosed no arguments (nothing to settle, and the agent may still
   * disclose them) and in ambient segments (they open no cards).
   */
  private armCardSettle(seg: SegmentState): void {
    this.clearCardSettle()
    if (this.disposed || seg.finished || seg.ambient || seg.cardSettled) return
    const call = seg.activeToolCall
    if (seg.activeType !== 'tool-call' || call === undefined) return
    if (call.argsRaw === '') return
    const timer = setTimeout(() => {
      this.cardSettleTimer = undefined
      if (this.disposed || this.segment !== seg || seg.finished) return
      if (seg.ambient || seg.cardSettled) return
      if (seg.activeType !== 'tool-call' || seg.activeToolCall === undefined) return
      if (seg.activeToolCall.argsRaw === '') return
      this.settleOpenCard(seg)
    }, CARD_SETTLE_QUIET_MS)
    // Never pin the process open for a display timer alone.
    timer.unref?.()
    this.cardSettleTimer = timer
  }

  /** Cancel the pending block settle (its segment closed, or a newer card replaced it). */
  private clearCardSettle(): void {
    if (this.cardSettleTimer === undefined) return
    clearTimeout(this.cardSettleTimer)
    this.cardSettleTimer = undefined
  }

  /**
   * Close the open tool-call block WITHOUT ending the segment, so the host's
   * live row settles its arguments. The block stays the segment's last block;
   * a later non-tool event cuts the segment exactly as before.
   *
   * The SNAPSHOT deliberately stays open. ACP updates restate their input
   * whole, so the agent can disclose a fuller command after the window: that
   * update folds into the snapshot (see `foldInto`) and the segment's closing
   * `block-end` replaces the settled card with the final text. Clearing the
   * snapshot here would hand the same call's restatements to `seenCalls`, and
   * the card would stay pinned to the early text for the rest of the turn.
   */
  private settleOpenCard(seg: SegmentState): void {
    if (seg.finished) return
    const call = seg.activeToolCall
    if (seg.activeType !== 'tool-call' || call === undefined) return
    if (seg.cardSettled) return
    seg.cardSettled = true
    seg.queue.push({
      type: 'block-end',
      index: seg.index,
      block: { type: 'tool-call' as const, id: call.callId, name: call.name, arguments: call.argsRaw },
    })
    seg.activeText = ''
  }

  private finishSegment(seg: SegmentState, reason: SegmentFinishReason): void {
    if (seg.finished) return
    // A block settle belongs to the segment that armed it; every close cancels it.
    this.clearCardSettle()
    seg.finished = true
    if (seg.activeType !== null) {
      seg.queue.push({
        type: 'block-end',
        index: seg.index,
        block: seg.activeType === 'tool-call' && seg.activeToolCall !== undefined
          ? { type: 'tool-call' as const, id: seg.activeToolCall.callId, name: seg.activeToolCall.name, arguments: seg.activeToolCall.argsRaw }
          : { type: seg.activeType as 'reasoning' | 'text', text: seg.activeText },
      })
      seg.activeType = null
      seg.activeToolCall = undefined
    }
    const outputTokens = Math.round(seg.outputChars / OUTPUT_CHARS_PER_TOKEN)
    // Zero input keeps the host's cache-hit pill hidden instead of faking 0%.
    if (outputTokens > 0) seg.queue.push({ type: 'usage', usage: { inputTokens: 0, outputTokens } })
    seg.queue.push({ type: 'finish', reason })
    seg.queue.close()
    if (this.segment === seg) this.segment = undefined
  }

  /** A segment opened on an already-settled turn: replay, then close it out. */
  private finishAfterSettle(seg: SegmentState): void {
    if (seg.finished) return
    if (this.sawVisibleBlock) {
      // The turn delivered its message(s); this last continuation step has
      // nothing new to show. An empty assistant message is not something the
      // plane can render honestly, so close with a one-line pointer.
      if (seg.index < 0 && this.pendingProse.length === 0) {
        const line = `\n[dsh-ntr] agent "${this.session.agentId}" executed its tool call(s) but sent no text reply this turn — the tool details are in the ACP transcript view.\n`
        this.emitProse(seg, 'text', line)
      }
      this.finishSegment(seg, { kind: 'stop' })
    } else {
      // A settled turn that never showed anything: the zero-output warning the
      // plane would have gotten from a single-stream turn (constraint 23).
      const line = this.zeroOutputLine()
      if (seg.index < 0) this.emitProse(seg, 'text', line)
      this.finishSegment(seg, { kind: 'stop' })
    }
  }

  /**
   * The "protocol says success, the bubble is empty" line. When a recently
   * retired drain may have taken the prompt without re-announcing itself, say
   * that instead of blaming the agent: the output exists in the transcript.
   *
   * A `refusal` stop reason is the agent's OWN verdict, not a silent failure:
   * it answered the prompt and declined to do the work. Saying "no visible
   * output" would read as a host-side gap and send the user looking for a bug
   * that is not there — and `refusal` carries the agent's reason, which is the
   * one stop reason that does (constraint 29: nothing the agent sent is
   * dropped), so it is quoted when the agent gave one.
   */
  private zeroOutputLine(stopReason?: string, refusal?: string): string {
    if (stopReason === 'refusal') {
      const detail = refusal === undefined || refusal === '' ? '' : `: ${refusal}`
      return `\n[dsh-ntr] agent "${this.session.agentId}" refused this turn${detail}.\n`
    }
    if (this.recentRetiredDrain) {
      return `\n[dsh-ntr] agent "${this.session.agentId}" produced no visible output this turn; it may have been folded into a background run; its output is in the ACP transcript view.\n`
    }
    const reason = stopReason === undefined ? '' : ` (stop reason: ${stopReason})`
    return `\n[dsh-ntr] agent "${this.session.agentId}" ended the turn with no visible output${reason}. Some agents fold upstream failures — auth, billing, rate limits — into a normal stop; try resending, and check the agent process logs if it repeats.\n`
  }

  private onEvent(event: unknown): void {
    if (this.disposed) return
    const row = event as { type?: string; sessionId?: string }
    if (row.sessionId !== undefined && row.sessionId !== this.session.sessionId) return
    if (row.type === 'session/update') {
      const typed = event as { sessionId: string; seq: number; update: unknown }
      // Any update — a `usage_update` / phase tick included — says the
      // background drain is still working, so the ambient quiet clock restarts.
      this.noteAmbientActivity()
      // A detached-worker hold's drain phase has the same rule; its worker
      // phase is pushed out only by dispatch / worker evidence (see
      // `BridgeTuning.backgroundTaskMaxMs`).
      this.noteBackgroundHoldActivity()
      const update = typed.update as Record<string, unknown>
      // Detached-worker / drain bookkeeping now lives on the SESSION (see
      // `BridgeManager.trackSessionBackgroundDispatch`): it has to outlive this
      // controller, so this turn only consumes segment content here.
      if (typed.seq <= this.cursorSeq) return
      // A background drain's prose is not this turn's answer: keep it out of
      // the plane (the transcript still has it). Fail-open — nothing is split
      // until this turn has a request id of its own to compare against.
      this.noteTurnRequestId(update)
      if (this.isForeignAmbientText(update)) {
        this.recordWithoutSegment(update)
        // Advance past it only when nothing is left unconsumed behind it: the
        // event that CUT the previous segment is parked for the next one, and
        // jumping the cursor over it would lose its text for good. The replay
        // applies the same foreign split, so leaving this one behind is safe.
        if (typed.seq === this.cursorSeq + 1) this.cursorSeq = typed.seq
        return
      }
      // The turn's OWN request id is still unknown and this update belongs to
      // the background drain: folding it now could make the drain's tick teach
      // `noteTurnRequestId` the drain's id, mixing the drain's text into the
      // user's answer. Withhold it until the prompt response decides what this
      // turn is (see `pendingAmbientUpdates`); the cursor moves on because the
      // transcript already holds the entry.
      if (this.turnRequestId === undefined
        && this.awaitingAmbient === undefined
        && this.isAmbientOwned(update)) {
        this.bufferAmbientUpdate(typed.seq, update)
        this.cursorSeq = typed.seq
        return
      }
      // Live-only burst accounting runs BEFORE the segment cursor: prose that
      // arrives between segments still belongs to this turn's output, and its
      // gaps are real. Replay never reaches this path.
      this.trackTps(typed)
      const seg = this.segment
      if (seg === undefined || seg.finished) {
        // Between segments: tool outputs still reach the shared registry (the
        // guard's virtual tool may be parked on this very record), but the
        // cursor does NOT advance — the next segment replays everything since
        // it, which re-records those idempotently and folds the prose the agent
        // streamed while its cards executed on the host.
        this.recordWithoutSegment(update)
        return
      }
      // The cursor advances only past events fully consumed into this
      // segment; the event that CUTS the segment belongs to the next one.
      if (this.foldInto(seg, update, typed.seq)) this.cursorSeq = typed.seq
    } else if (row.type === 'permission/request') {
      this.tps.onBreak()
      const typed = event as Extract<AcpEvent, { type: 'permission/request' }>
      this.pushProse(this.permissionLine(typed))
    } else if (row.type === 'permission/expired') {
      this.tps.onBreak()
      const typed = event as { toolCall: unknown; timeoutMs: number; outcome: PermissionOutcome; optionName?: string }
      this.pushProse(this.expiredLine(typed))
    }
  }

  /** Feed one live update into the turn's burst tracker. Never called by replay. */
  private trackTps(typed: { seq: number; update: unknown }): void {
    if (typed.seq <= this.tpsSeq) return
    this.tpsSeq = typed.seq
    const update = typed.update as Record<string, unknown>
    const kind = String(update.sessionUpdate ?? '')
    if (kind === 'agent_thought_chunk' || kind === 'agent_message_chunk') {
      const text = chunkTextOf(update.content)
      if (text === '') return
      this.tps.onProse(text, Date.now())
      this.pushLiveTps()
    } else if (kind === 'tool_call' || kind === 'tool_call_update') {
      this.tps.onBreak()
    }
  }

  /** Throttled live aggregate so the dock's speed moves during a long turn. */
  private pushLiveTps(): void {
    const dshSessionId = this.session.dshSessionId
    if (dshSessionId === undefined) return
    const now = Date.now()
    if (now - this.lastTpsPushAt < TPS_PUSH_INTERVAL_MS) return
    const snap = this.tps.snapshot()
    if (snap.outputTokens <= 0 || snap.burstMs <= 0) return
    this.lastTpsPushAt = now
    const base = this.session.burst ?? { outputTokens: 0, burstMs: 0 }
    this.hub.broadcast({
      type: 'turn/metrics',
      sessionId: this.session.sessionId,
      dshSessionId,
      turnId: this.turnId,
      outputTokens: base.outputTokens + snap.outputTokens,
      burstMs: base.burstMs + snap.burstMs,
      final: false,
    })
  }

  /** Close the turn's metrics: persist the measurable part, then broadcast it. */
  private finalizeTps(): void {
    const dshSessionId = this.session.dshSessionId
    if (dshSessionId === undefined) return
    const snap = this.tps.snapshot()
    if (snap.outputTokens > 0 && snap.burstMs > 0) {
      this.manager.noteSessionBurst(this.session, snap.outputTokens, snap.burstMs)
    }
    const aggregate = this.session.burst ?? { outputTokens: 0, burstMs: 0 }
    this.hub.broadcast({
      type: 'turn/metrics',
      sessionId: this.session.sessionId,
      dshSessionId,
      turnId: this.turnId,
      outputTokens: aggregate.outputTokens,
      burstMs: aggregate.burstMs,
      final: true,
    })
  }

  /**
   * Put one narrative line into the turn's prose stream.
   *
   * A card-bearing segment must stay the segment's LAST block, so a line that
   * arrives while a card is open is parked for the next segment instead of
   * streaming below the card. A line that arrives between segments waits for
   * the next one to open.
   */
  private pushProse(line: string): void {
    if (line === '') return
    const seg = this.segment
    if (seg === undefined || seg.finished) {
      this.pendingProse.push(line)
      return
    }
    if (seg.hasCard) {
      this.pendingProse.push(line)
      this.finishSegment(seg, { kind: 'stop' })
      return
    }
    this.emitProse(seg, 'reasoning', line)
  }

  /** Events that arrive between segments: recorded, replayed into the next one. */
  private recordWithoutSegment(update: Record<string, unknown>): void {
    const kind = String(update.sessionUpdate ?? '')
    if (kind === 'tool_call' || kind === 'tool_call_update') this.noteToolRecord(update)
  }

  /** Record a tool call's output (idempotent) and wake any waiter. */
  private noteToolRecord(update: Record<string, unknown>): void {
    const callId = typeof update.toolCallId === 'string' ? update.toolCallId.trim() : ''
    if (callId === '') return
    recordAcpToolOutput(callId, updateContentToText(update.content), isFinalToolCallStatus(update.status))
  }

  /**
   * Whether this update belongs to a background drain — the one the session is
   * waiting on, or one whose wait already closed (retired) but whose run can
   * still speak.
   */
  private isAmbientOwned(update: Record<string, unknown>): boolean {
    const requestId = codebuddyMetaOf(update)?.requestId
    if (requestId === undefined) return false
    return requestId === this.session.ambient?.requestId
      || isRetiredAmbientId(this.session, requestId)
  }

  /** Learn this turn's own CodeBuddy request id from the first update naming one. */
  private noteTurnRequestId(update: Record<string, unknown>): void {
    if (this.turnRequestId !== undefined) return
    const meta = codebuddyMetaOf(update)
    // A detached worker's update names A WORKER, never this turn: adopting it
    // would let the worker's own turn pass as the session's answer.
    if (meta?.parentToolCallId !== undefined) return
    // While a hold runs, the only ids this turn owns are the drain ids it
    // accepted (see `BackgroundHold.acceptedIds`) — and those belong to the
    // background run, never to a second "own turn id" that would outlive the
    // hold. Nothing else may be adopted.
    if (this.activeBackgroundHold() !== undefined) return
    const requestId = meta?.requestId
    // A background drain's update names THE DRAIN, never this turn: adopting it
    // would make `isForeignAmbientText` pass the drain's own text through. A
    // RETIRED drain (its wait closed on silence, the run revived) is the same
    // trap — that id belongs to the background run whichever turn is on air.
    if (requestId === undefined || requestId === this.session.ambient?.requestId) return
    if (isRetiredAmbientId(this.session, requestId)) return
    this.turnRequestId = requestId
  }

  /** Adopt the request id the prompt RESPONSE declared for this turn. */
  adoptTurnRequestId(requestId: string): void {
    // A retired drain id is never this turn's own: adopting it would make the
    // background run's prose pass `isForeignAmbientText` as the answer. The
    // response still ends a normal turn, so the withheld drain buffer is
    // dropped either way (the transcript keeps it).
    if (!isRetiredAmbientId(this.session, requestId)) this.turnRequestId = requestId
    // A normal turn: whatever the drain streamed while the id was unknown was
    // never this turn's answer. Drop it (the transcript keeps it) — it must not
    // surface when a later segment replays or when the turn flushes anything.
    this.clearPendingAmbient()
  }

  /**
   * Prose of the session's background drain while this turn runs on its OWN
   * request id: it belongs to the background run, not to the user's answer.
   * Fail-open by design — an unknown turn id splits nothing, and a turn that
   * was itself folded into the drain keeps its prose.
   */
  private isForeignAmbientText(update: Record<string, unknown>): boolean {
    const meta = codebuddyMetaOf(update)
    const requestId = meta?.requestId
    // A detached worker's own turn is never this session's answer, whichever
    // turn is on air (the fold-level guard lives in `foldInto` as well, for
    // the replay paths that never ask this question). This includes a worker
    // update that also names a drain id: its prose is the WORKER's.
    if (meta?.parentToolCallId !== undefined) return true
    // A detached-worker hold owns the drain phase: any run it accepted (the
    // response's id, an announcement that named a different one) is this
    // turn's answer, and every OTHER id is background noise — whatever the
    // turn's own id says. Parked holds count: the response already owns them.
    const hold = this.activeBackgroundHold()
    if (hold !== undefined) {
      if (requestId === undefined) return false
      return !hold.acceptedIds.has(requestId)
    }
    // The drain THIS turn is waiting on owns its text unconditionally: the
    // wait was opened for this id (a revived drain may still carry a retired
    // mark if the update raced the revival), so the whole steered answer must
    // reach the user instead of being filtered as background noise.
    if (requestId !== undefined && this.awaitingAmbient?.requestId === requestId) return false
    // A RETIRED drain is foreign even though its record is gone: the quiet
    // close only means WE stopped waiting, not that the run ended. Its late
    // text must never join the turn now on air — even before that turn has
    // learned a request id of its own (the fail-open below does not apply to
    // an id known to be a background run).
    if (isRetiredAmbientId(this.session, requestId)) return true
    if (this.turnRequestId === undefined) return false
    if (requestId === undefined || requestId === this.turnRequestId) return false
    const ambient = this.session.ambient
    return ambient !== undefined && requestId === ambient.requestId
  }

  /**
   * The turn's whole fold, shared by live events and segment replay. Visible
   * non-tool events END a card-bearing segment instead of joining it — that is
   * the segmentation rule that puts each card between two assistant messages.
   * Returns whether the event was consumed into this segment: the cutting
   * event is left unconsumed (and thus behind the cursor) for the next one.
   *
   * `seq` is the update's transcript position when the caller has one: the
   * detached-worker hold uses it to count only the answer text that arrived
   * AFTER the hold began (a parked hold replays the parent's earlier ack).
   */
  private foldInto(seg: SegmentState, update: Record<string, unknown>, seq?: number): boolean {
    const kind = String(update.sessionUpdate ?? '')
    // A DETACHED WORKER's own turn: its words and tools are the worker's, not
    // this session's answer. The transcript keeps them (the ACP view is where
    // the user can read them) and the shared tool-output registry still sees
    // the call, but nothing reaches this turn's message and no card opens for
    // the host to execute. This applies to EVERY turn, not just a hold.
    if (codebuddyMetaOf(update)?.parentToolCallId !== undefined) {
      this.noteToolRecord(update)
      return true
    }
    if (kind === 'agent_thought_chunk' || kind === 'agent_message_chunk') {
      const text = chunkTextOf(update.content)
      if (text === '') return true
      if (seg.hasCard) {
        this.finishSegment(seg, { kind: 'stop' })
        return false
      }
      seg.outputChars += text.length
      // "The turn's own answer", as opposed to a background drain's prose that
      // happens to stream through the same session (see `isForeignAmbientText`).
      if (!this.isAmbientOwned(update)) this.sawAgentProse = true
      if (kind === 'agent_message_chunk') {
        this.sawVisibleText = true
        // A hold's closing line asks whether ITS runs delivered answer text.
        // The parent's interim acknowledgement arrived before the hold and
        // already set `sawVisibleText`, so the hold keeps its own counter —
        // and only text that arrived after the hold began counts (a parked
        // hold replays that earlier ack from the transcript).
        const hold = this.activeBackgroundHold()
        if (hold !== undefined && (seq === undefined || seq > hold.floorSeq)) {
          hold.answerChars += text.length
        }
      }
      this.emitProse(seg, kind === 'agent_thought_chunk' ? 'reasoning' : 'text', text)
      return true
    } else if (kind === 'tool_call' || kind === 'tool_call_update') {
      this.noteToolRecord(update)
      if (seg.ambient || this.isAmbientOwned(update)) {
        // A background drain's tools stay in the transcript: opening a card
        // would make the host execute a tool and propose a continuation step
        // for a turn whose answer has not started yet. The ownership check
        // covers a NORMAL turn too — its own segment is not ambient, but a
        // drain can stream a tool call on the same session while it runs, and
        // that call is not this turn's work.
        return true
      }
      const snapshot = acpToolCallFromUpdate(update)
      if (snapshot === undefined) return true
      if (seg.activeType === 'tool-call' && seg.activeToolCall?.callId === snapshot.callId) {
        const deltas = acpToolCallDelta(seg.activeToolCall, update)
        // An early-settled block is already sealed on the host side: a
        // concatenating delta would append to a settled view. Keep the folded
        // snapshot only — the segment's closing `block-end` restates it whole.
        if (seg.cardSettled) return true
        for (const delta of deltas) {
          seg.queue.push(delta.kind === 'name'
            ? { type: 'tool-call-delta', index: seg.index, id: seg.activeToolCall.callId, name: delta.name, argumentsDelta: '' }
            : { type: 'tool-call-delta', index: seg.index, id: seg.activeToolCall.callId, argumentsDelta: delta.text })
        }
        // The agent may have JUST disclosed the real command (the announce
        // often carries only a placeholder title): restart the settle window
        // so the live row can show that text while the tool runs.
        this.armCardSettle(seg)
        return true
      }
      if (this.seenCalls.has(snapshot.callId)) return true // a restatement of a card already settled
      // A BARE status-only update for a call this turn never announced is not
      // a card. The real wire sends the detached dispatch's completion exactly
      // that way (no `_meta`, no title, no input); a turn that begins after the
      // dispatch belongs to another turn's card, and opening one here would
      // make the host execute a phantom tool.
      if (kind === 'tool_call_update' && snapshot.name === '' && snapshot.argsRaw === '') return true
      this.seenCalls.add(snapshot.callId)
      this.openToolCallBlock(seg, snapshot)
      // Let the host's live row settle this card's real command after a short
      // quiet window, instead of waiting for the next non-tool event.
      this.armCardSettle(seg)
      return true
    } else if (!BOOKKEEPING_UPDATES.has(kind)) {
      const text = describeUnhandledUpdate(kind, update)
      if (this.announcedKinds.get(kind) === text) return true
      if (seg.hasCard) {
        this.finishSegment(seg, { kind: 'stop' })
        return false
      }
      this.announcedKinds.set(kind, text)
      this.emitProse(seg, 'text', `\n${text}\n`)
      return true
    }
    return true
  }

  private emitProse(seg: SegmentState, type: 'reasoning' | 'text', text: string): void {
    if (seg.finished) return
    if (seg.activeType !== type) {
      if (seg.activeType !== null) {
        seg.queue.push({
          type: 'block-end',
          index: seg.index,
          block: seg.activeType === 'tool-call' && seg.activeToolCall !== undefined
            ? { type: 'tool-call' as const, id: seg.activeToolCall.callId, name: seg.activeToolCall.name, arguments: seg.activeToolCall.argsRaw }
            : { type: seg.activeType as 'reasoning' | 'text', text: seg.activeText },
        })
      }
      seg.index += 1
      seg.activeType = type
      seg.activeText = ''
      this.sawVisibleBlock = true
      seg.queue.push({ type: 'block-start', index: seg.index, blockType: type })
    }
    seg.activeText += text
    seg.queue.push({ type: type === 'reasoning' ? 'reasoning-delta' : 'text-delta', index: seg.index, text })
  }

  /**
   * Open a tool-call block for one call. Two adjacent tool calls share a block
   * TYPE, so the switch helper's type-equality early return cannot be used
   * here — every call needs its own block.
   */
  private openToolCallBlock(seg: SegmentState, snapshot: AcpToolCallSnapshot): void {
    if (seg.finished) return
    if (seg.activeType !== null) {
      seg.queue.push({
        type: 'block-end',
        index: seg.index,
        block: seg.activeType === 'tool-call' && seg.activeToolCall !== undefined
          ? { type: 'tool-call' as const, id: seg.activeToolCall.callId, name: seg.activeToolCall.name, arguments: seg.activeToolCall.argsRaw }
          : { type: seg.activeType as 'reasoning' | 'text', text: seg.activeText },
      })
    }
    seg.index += 1
    seg.activeType = 'tool-call'
    seg.activeText = ''
    seg.activeToolCall = snapshot
    // A NEW card owns its own settle window; the previous card's settlement
    // (if any) closed with the block-end above.
    seg.cardSettled = false
    this.sawVisibleBlock = true
    seg.hasCard = true
    seg.queue.push({ type: 'block-start', index: seg.index, blockType: 'tool-call' })
    seg.queue.push({
      type: 'tool-call-delta',
      index: seg.index,
      id: snapshot.callId,
      ...(snapshot.name === '' ? {} : { name: snapshot.name }),
      argumentsDelta: snapshot.argsRaw,
    })
  }

  private permissionLine(event: Extract<AcpEvent, { type: 'permission/request' }>): string {
    // `toolName` is host-derived (`permissionToolName`) so agents that omit
    // `title` and declare it in `_meta` still name the operation here.
    const title = event.toolName
    // The line must point at the place the answer entry actually is: a
    // chat-bound ask renders its card in the conversation; an `/acp`-RPC ask
    // has no conversation, so its card lives on the settings page.
    const lead = event.dshSessionId !== undefined
      ? 'please answer the permission card above the composer'
      : 'please approve in Settings'
    // The last clause says what happens if nobody answers, and it follows the
    // MODE: refused, answered automatically, or (in `wait`) nothing at all.
    if (event.timeoutMode === 'wait' || event.deadlineAt === undefined) {
      return `\n> 🔐 [Permission Required: ${title}] - ${lead}\n`
    }
    const remainingMs = Math.max(0, event.deadlineAt - Date.now())
    // Floor (+1 ms for the Date.now tick), min 1: rounding up would promise time already spent.
    const remainingS = Math.max(1, Math.floor((remainingMs + 1) / 1000))
    const otherwise = event.timeoutMode === 'auto'
      ? 'this request is answered automatically'
      : 'this request is cancelled'
    return `\n> 🔐 [Permission Required: ${title}] - ${lead} within ${String(remainingS)}s or ${otherwise}\n`
  }

  /**
   * The line for an ask the plugin settled itself when its deadline fired.
   *
   * The composer card is disappearing, so the conversation has to say what
   * happened to the question — otherwise the user is left with a vanished
   * card and no explanation. The wording follows the outcome: refused, or
   * answered with the option the agent's own kinds implied.
   */
  private expiredLine(event: { toolCall: unknown; timeoutMs: number; outcome: PermissionOutcome; optionName?: string }): string {
    const title = permissionToolName(event.toolCall)
    const waited = event.timeoutMs > 0
      ? `no answer within ${String(Math.round(event.timeoutMs / 1000))}s`
      : 'not waited for'
    if (event.outcome.outcome === 'selected') {
      const picked = event.optionName === undefined ? event.outcome.optionId : event.optionName
      return `\n> 🔐 [Permission Required: ${title}] - ${waited}; answered "${picked}" automatically, continuing\n`
    }
    return `\n> 🔐 [Permission Required: ${title}] - ${waited}; refused\n`
  }
}

/** Chunk text shared by the controller's fold (string / object / array forms). */
function chunkTextOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    const parts: string[] = []
    for (const item of content) {
      if (typeof item === 'string') parts.push(item)
      else if (typeof item === 'object' && item !== null) {
        const row = item as Record<string, unknown>
        if (typeof row.text === 'string') parts.push(row.text)
        else parts.push(JSON.stringify(item))
      }
    }
    return parts.join('')
  }
  if (typeof content === 'object' && content !== null) {
    const row = content as Record<string, unknown>
    if (typeof row.text === 'string') return row.text
    if (row.type === 'text' || row.type === undefined) return JSON.stringify(content)
  }
  return ''
}

/** Routes host session ids to their owning bridge. */
export class BridgeManager {
  /**
   * Process slots, keyed by `bridgeKey(agentId, scope)`. A non-per-session
   * agent folds every scope onto the bare agent id (exactly one entry, as
   * before); a per-session agent (A1) keeps one entry per chat / ephemeral /
   * probe scope, so `bridges.values()` stays the complete set and every
   * traversal keeps working unchanged.
   */
  private readonly bridges = new Map<string, AgentBridge>()
  /** The scope each `bridges` entry was created for; keys are opaque and never parsed. */
  private readonly bridgeScopes = new Map<string, BridgeScope>()
  /**
   * Agents whose `stopAgent` is on the stack, with an overlapping-stop counter.
   * `bridgeFor` refuses to mint a holder for them (see `stopAgent`): a message
   * arriving during the teardown's `await` must not spawn a child the snapshot
   * never saw, or that child would outlive the key sweep and leave a session
   * record no process can serve. A counter rather than a flag so two
   * overlapping stops cannot open the gate when the first one returns.
   */
  private readonly stoppingAgents = new Map<string, number>()
  /**
   * Child bridge → the startup error already written to the settings log. An
   * `error` child under a `ready` aggregate has no status-frame voice, so the
   * notice is its only surface; dedupe keeps repeated status publishes from
   * repeating the line.
   */
  private readonly noticedBridgeFailures = new WeakMap<AgentBridge, string>()
  private readonly defsMap = new Map<string, AcpAgentDef>()
  /**
   * `agent/skills` answers, keyed `agentId\0workspaceRoot`, TTL'd by
   * {@link SKILL_SCAN_TTL_MS}. Memory-only: the scan is a pure fs read, so a
   * fresh boot re-scans and nothing is owed to `agents.json`.
   */
  private readonly skillCache = new Map<string, { at: number; result: AgentSkillsResult }>()
  /**
   * Process-lifetime delete tombstones. `deleteAgent` records the id BEFORE it
   * awaits anything, so a save that is already running can notice the delete
   * after its own await and refuse to write the definition back. The value is
   * the delete generation: `deleteAgent` bumps it every time, and a save only
   * survives when the generation it captured still matches AND no tombstone
   * exists.
   *
   * There is deliberately no "recreate a deleted id" entry point: a same-id
   * re-import would have to remove the tombstone explicitly (and start a fresh
   * generation), which no caller does today. Clearing it on a plain save would
   * reopen exactly the resurrection race this map closes.
   */
  private readonly deletedAgentIds = new Set<string>()
  /** Delete generation per agent id; absent = never deleted in this process. */
  private readonly agentDeleteGenerations = new Map<string, number>()
  /**
   * Save generation per agent id. Every `saveAgent` call that will actually
   * write (direct / defer / force) bumps it BEFORE doing anything. An older
   * save already executing captures its generation at the start and refuses to
   * write once a newer save has bumped it: otherwise the older, slower write
   * could land last and silently replace the definition the user just saved.
   */
  private readonly agentSaveGenerations = new Map<string, number>()
  /** Last persist failure already reported, so a hot retry loop cannot spam the log. */
  private lastPersistFailure?: string
  /** The plugin's own default ACP agent id (persisted; see `persistAgents`). */
  private defaultAgentId?: string
  /** The agent tag's halo preference (persisted; see `persistAgents`). */
  private tagHaloSetting: AcpTagHalo = { ...DEFAULT_TAG_HALO }
  /**
   * Whether generated NTR session titles carry the {@link SESSION_TITLE_PREFIX}
   * badge (persisted; see `persistAgents`). Read at title-request time, so a
   * settings toggle reaches the next generated title without restarting
   * anything — but already-accepted titles are durable `session/title` events
   * the host owns, so flipping the switch never rewrites existing rows.
   */
  private sessionTitlePrefixEnabled = DEFAULT_SESSION_TITLE_PREFIX
  /**
   * What `cordis.patch.yml` asked for — ONLY if it actually named the key.
   * This is the deployment baseline, kept apart from
   * {@link deadlineOverride} so the settings card can tell the user which of
   * the two is winning. Empty when the file says nothing about the window, in
   * which case {@link baselineDeadline} (the built-in default) applies.
   */
  private configuredDeadlines: Partial<Record<ApprovalDeadlineKey, number>> = {}
  /**
   * The mode the config file named, if it named one. Kept apart from the
   * override for the same reason the window is: the card has to be able
   * to say "the file asks for `abort`, the value set here wins".
   */
  private configuredMode?: PermissionTimeoutMode
  /**
   * The window before any override — the tuning this manager was constructed
   * with, which already carries the validated config file (the host entry
   * passes `validateConfig`'s output) or the built-in default.
   *
   * Held separately from {@link configuredDeadlines} because the two answer
   * different questions: this one is what RUNS when nothing is overridden, that
   * one is what the config file NAMED (which the card shows as the reset target
   * and a bare default does not deserve). A manager built without tuning at all
   * — a direct consumer, a test — gets `DEFAULT_TUNING` here and stays correct.
   */
  private baselineDeadline: number
  /**
   * The mode before any override — the tuning this manager was constructed
   * with, which already carries the validated config file (the host entry
   * passes `validateConfig`'s output) or the built-in default.
   */
  private baselineMode: PermissionTimeoutMode
  /**
   * The settings page's own write, persisted with the agent registry. Merged
   * OVER {@link baselineDeadline}: once a user picks a window in the UI, that
   * pick is what runs, and the config file becomes the value the reset button
   * returns to. Without this split a hand-edited `cordis.patch.yml` and a UI
   * write would fight with no way to tell which one is live.
   */
  private deadlineOverride: ApprovalDeadlinePatch = {}
  /**
   * The idle-release window the settings page picked, in ms, persisted
   * with the agent registry. `undefined` means the deployment baseline runs.
   *
   * Merged OVER {@link baselineIdleTimeoutMs} exactly like
   * {@link deadlineOverride} over {@link baselineDeadline}: a UI pick is what
   * runs, and `cordis.patch.yml` becomes the value the reset button returns
   * to. Without this split the two sources would fight with no way to tell
   * which one is live.
   */
  private idleReleaseOverride?: number
  /**
   * The window `cordis.patch.yml` names, when it names one. Kept apart
   * from the override for the same reason the deadline keeps its baseline
   * apart: the settings card has to be able to say "the file asks for
   * 10 minutes, the value set here wins".
   */
  private configuredIdleTimeoutMs?: number
  /**
   * The idle-release window before any override — the tuning this manager was
   * constructed with (the deployment baseline, or the built-in 30 minutes).
   */
  private baselineIdleTimeoutMs: number
  /**
   * Tuning in force, defaults applied. The approval deadline is rewritten
   * IN PLACE by {@link applyDeadlineTuning}, which is why this is a live object
   * rather than the constructor's parameter: every bridge built afterwards
   * inherits the rewrite instead of the boot-time value.
   */
  private readonly tuning: Required<BridgeTuning>
  /**
   * The in-flight (or just-settled) segmented turn of one DSH chat session.
   * Keyed by chat session id because the continuation steps of a segmented
   * turn arrive as fresh `streamPrompt` calls that must find the SAME
   * controller — its transcript cursor, seen-call registry and turn facts are
   * what let them resume the prompt instead of re-sending it. An entry is
   * replaced by the conversation's next turn and removed on cancel, session
   * close/release, or agent stop.
   */
  private readonly turnStreams = new Map<string, TurnStreamController>()

  /** The segmented turn a continuation step of one chat session must resume. */
  turnStreamFor(dshSessionId: string): TurnStreamController | undefined {
    return this.turnStreams.get(dshSessionId)
  }

  /**
   * The ambient windows a turn's controller reads once at construction (see
   * {@link BridgeTuning.ambientQuietMs}). Exposed as a plain snapshot so the
   * controller never pokes at the manager's tuning object, and tests can tune
   * the cadence through the constructor like every other window.
   */
  get ambientTuning(): { quietMs: number; maxMs: number } {
    return {
      quietMs: this.tuning.ambientQuietMs,
      maxMs: this.tuning.ambientMaxMs,
    }
  }

  /**
   * The detached-worker hold's windows, read once at controller construction
   * for the same reason as {@link ambientTuning}: `taskMaxMs` is the worker
   * phase's SHORT silence window, `toolMaxMs` its long tier while the worker's
   * last known state is an open tool call (0 falls back to the short one), both
   * pushed out by every dispatch / worker update (see
   * {@link BridgeTuning.backgroundTaskMaxMs} /
   * {@link BridgeTuning.backgroundTaskToolMs}); `ceilingMs` their optional
   * absolute bound (0 = none) and `graceMs` the bounded wait a PARKED hold
   * gives the host to open its continuation step (see
   * {@link BridgeTuning.backgroundParkedGraceMs}). The drain phase reuses
   * {@link ambientTuning}.
   */
  get backgroundTuning(): { taskMaxMs: number; toolMaxMs: number; ceilingMs: number; graceMs: number } {
    return {
      taskMaxMs: this.tuning.backgroundTaskMaxMs,
      toolMaxMs: this.tuning.backgroundTaskToolMs > 0 ? this.tuning.backgroundTaskToolMs : this.tuning.backgroundTaskMaxMs,
      ceilingMs: this.tuning.backgroundTaskCeilingMs,
      graceMs: this.tuning.backgroundParkedGraceMs,
    }
  }

  /** Index a turn's controller, retiring whatever turn it supersedes. */
  rememberTurnStream(dshSessionId: string, controller: TurnStreamController): void {
    const previous = this.turnStreams.get(dshSessionId)
    if (previous !== undefined && previous !== controller) previous.dispose()
    this.turnStreams.set(dshSessionId, controller)
  }

  /** Drop a controller from the index (its own `dispose` calls back into this). */
  forgetTurnStream(controller: TurnStreamController): void {
    for (const [key, value] of this.turnStreams) {
      if (value === controller) this.turnStreams.delete(key)
    }
  }

  /** Tear down the turn streams of every session of one bridge (close/release/stop). */
  private disposeTurnStreamsOf(match: (controller: TurnStreamController) => boolean): void {
    for (const [key, controller] of [...this.turnStreams]) {
      if (match(controller)) {
        controller.finishActive({ kind: 'aborted', failure: { message: 'session ended', code: 'SESSION_CLOSED' } })
        controller.dispose()
        this.turnStreams.delete(key)
      }
    }
  }

  /**
   * The stall watchdog's scan loop. Armed lazily at the first turn start and
   * DROPPED once nothing anywhere is running: a manager that never runs a turn
   * never holds a timer, and one that goes quiet does not keep the host awake.
   */
  private stallTimer?: ReturnType<typeof setInterval>

  private armStallTimer(): void {
    // `turnStallMs === 0` disables the WHOLE watchdog — the base window is the
    // switch. `turnStallToolMs` cannot re-enable it: that number only widens
    // the window for a turn that already has a tool in flight.
    if (this.tuning.turnStallMs <= 0 || this.stallTimer !== undefined) return
    const timer = setInterval(() => { this.reapStalledTurns() }, Math.max(1, this.tuning.turnStallTickMs))
    timer.unref?.()
    this.stallTimer = timer
  }

  /**
   * Force-finalize turns the agent has gone silent in.
   *
   * "Silent" is scoped to the stretch where the AGENT owes the turn a word: a
   * running session with a segment on air and no pending ask. A turn waiting on
   * the host (tool cards executing between segments) or on a human (an
   * unanswered permission) is not stuck and is skipped.
   *
   * Firing does NOT kill the process (see `LiveSession.orphanPromptTurnSeq`):
   * the session, its transcript and its binding survive, and the next message
   * reclaims the process. The turn's streaming face ends through its own
   * controller when there is one, so the driver step on air closes with an
   * error instead of being torn down mid-stream.
   */
  private reapStalledTurns(): void {
    const now = Date.now()
    let anyRunning = false
    for (const bridge of this.bridges.values()) {
      for (const session of bridge.sessionList) {
        if (session.running) anyRunning = true
        if (!session.running || session.closed || session.released) continue
        // A question is on the table: the agent is waiting on a human, not
        // stuck, and that wait is the permission deadline's business.
        if (bridge.permissions.hasPendingFor(session.sessionId)) continue
        // The controller this turn is streaming through. A chat turn is indexed
        // by chat id (its continuation steps look it up that way) AND attached
        // to the session; an EPHEMERAL turn has no chat id and therefore only
        // the attachment — treating it as an `/acp` turn would finalize the
        // session state without closing the driver's segment queue.
        const indexed = session.dshSessionId === undefined ? undefined : this.turnStreams.get(session.dshSessionId)
        // An index hit only speaks for THIS session: a concurrent first turn
        // can have mapped another LiveSession under the same chat id.
        const attached = session.turnController
          ?? (indexed !== undefined && indexed.session === session ? indexed : undefined)
        // A controller from an EARLIER turn is stale the moment any newer turn
        // (e.g. an `/acp` prompt on the same chat) advances `turnSeq`: its
        // segment is already closed, `onAir` would read false, and the
        // watchdog would skip this turn forever. Treat it as absent.
        const live = attached !== undefined && !attached.stale ? attached : undefined
        // An `/acp`-RPC turn has no driver stream, so "on air" reads as true.
        const onAir = live === undefined ? true : live.hasOpenSegment
        if (!onAir) continue
        const toolWindow = this.tuning.turnStallToolMs > 0 ? this.tuning.turnStallToolMs : this.tuning.turnStallMs
        const threshold = session.activeToolCalls.size > 0 ? toolWindow : this.tuning.turnStallMs
        if (now - session.lastAgentActivityAt < threshold) continue
        void bridge.cancel(session)
        session.orphanPromptTurnSeq = session.turnSeq
        const turnGen = session.turnSeq
        const message = `acp: agent "${session.agentId}" sent no activity for ${String(Math.round(threshold / 1000))}s; the stalled turn was force-finalized`
        // A provisional first turn that showed nothing is about to be rolled
        // back by `settle` (lock released, session closed), so the notice must
        // not promise a resume that will not happen.
        const willRollback = live !== undefined && live.session.provisionalLock === true && !live.sawVisibleBlock
        if (live !== undefined) live.settle({ kind: 'error', message, code: 'INACTIVITY_TIMEOUT' })
        else bridge.finalizeTurn(session, turnGen, message)
        // What the next message can do depends on the capability the agent
        // advertised at connect time, and on whether anyone else is using it.
        const capabilities = bridge.view().agentCapabilities as { loadSession?: boolean } | undefined
        const next = willRollback
          ? 'This was the conversation\'s first turn and it delivered nothing, so it was discarded; the next message starts a new ACP session.'
          : capabilities?.loadSession === true
            ? 'The next message will restart the agent and resume the session.'
            : 'The next message will reset the ACP session; this agent does not support session resume.'
        this.hub.broadcast({
          type: 'agent/notice',
          agentId: session.agentId,
          level: 'error',
          text: `${message} ${next} If another conversation is still using the agent, the next send may be refused until that turn finishes.`,
        })
      }
    }
    if (!anyRunning && this.stallTimer !== undefined) {
      clearInterval(this.stallTimer)
      this.stallTimer = undefined
    }
  }

  constructor(
    defs: readonly AcpAgentDef[],
    readonly hub: EventHub,
    private readonly transcriptMax: number,
    private readonly configStoragePath?: string,
    private readonly catalogStoragePath?: string,
    /** Auto-probe agents for model catalogs (boot + lazy); manual probes always run. */
    private readonly probeModelsOnBoot = true,
    tuning?: BridgeTuning,
  ) {
    // Held as a live object rather than the raw parameter: the two approval
    // deadlines are rewritten in place when the settings page writes them (see
    // `applyDeadlineTuning`), and every bridge built afterwards must inherit
    // the rewrite instead of the boot-time value.
    this.tuning = { ...DEFAULT_TUNING, ...tuning }
    // The pre-override deadline value, snapshotted before anything can rewrite
    // it. Everything else in `tuning` is fixed for the manager's lifetime, so
    // only this needs a snapshot.
    this.baselineDeadline = this.tuning.permissionTimeoutMs
    this.baselineIdleTimeoutMs = this.tuning.idleTimeoutMs
    this.baselineMode = this.tuning.permissionTimeoutMode
    for (const def of defs) {
      this.defsMap.set(def.id, def)
    }
    // Move any state left loose in the host's `~/.dsh` root into this plugin's
    // own directory BEFORE reading it (see `migrateLegacyState`). Storage paths
    // injected by a caller are that caller's business; the migration only runs
    // for the default, plugin-owned locations.
    if (this.configStoragePath === undefined && this.catalogStoragePath === undefined) {
      migrateLegacyState()
    }
    this.loadPersistedAgents()
    this.loadPersistedCatalogs()
    // A persisted deadline override must reach the tuning the bridges are built
    // from, not just the settings card's readout.
    this.applyDeadlineTuning()
    // The same for the idle-release window: a persisted override must
    // reach the tuning the bridges are built from, not just the
    // settings card's readout.
    this.applyIdleReleaseTuning()
    // The request-path rewrite falls back to this default for a conversation
    // the user never bound explicitly — the same agent the composer chip shows.
    routeBindingRegistry().defaultModel = this.defaultAgent()
  }

  private makeBridge(
    def: AcpAgentDef,
    onConnectionLost: (bridge: AgentBridge, reason: string) => void,
    onCatalog?: (agentId: string, configOptions: unknown, shapeOnly?: boolean) => void,
    onCommands?: (agentId: string, commands: NonNullable<SessionView['availableCommands']>) => void,
    onSessionsDirty?: () => void,
    onForkCapability?: (agentId: string, supported: boolean) => void,
  ): AgentBridge {
    return new AgentBridge(def, this.hub, this.transcriptMax, onConnectionLost, onCatalog, onCommands, this.tuning, () => this.sessionWorkspaceResolver, onSessionsDirty, onForkCapability, bridge => {
      this.publishAgentStatus(bridge.def.id)
      this.noticeBridgeFailure(bridge)
    }, (session, update) => this.trackSessionBackgroundDispatch(session, update), (session, status) => this.terminalizeSessionDispatches(session, status))
  }

  /**
   * Every outstanding ask, across all agents, with the view the browser was
   * shown it — the source of the reconnect replay (see
   * `permissionReplayFrames`). Every ACP ask is a ledger entry, so this is the
   * whole live set.
   */
  pendingPermissionViews(): PendingPermissionView[] {
    const views: PendingPermissionView[] = []
    for (const bridge of this.bridges.values()) views.push(...bridge.permissions.pendingViews())
    return views
  }

  /**
   * Let the host resolve a chat session's workspace root — the sidebar's
   * selected workspace, which the agent's session and its process both run in.
   * Absent resolver → every chat session falls back to the agent's configured
   * cwd (`~/.dsh/dsh-ntr/workspaces`), which is the right answer for `/acp`-RPC
   * sessions and headless deployments.
   */
  setSessionWorkspaceResolver(resolver?: SessionWorkspaceResolver): void {
    this.sessionWorkspaceResolver = resolver
  }

  /**
   * Set the attachment service or context used to resolve image attachments in user prompts.
   */
  setAttachmentResolver(resolver?: unknown): void {
    this.attachmentResolver = resolver
  }

  /**
   * Wire the ACP-mode probe: given a DSH session id, report whether that
   * session runs the ACP agent preset. The host half reads it back from the
   * session log (`sessionAgentPreset`); an absent resolver means the browser
   * falls back to its own session-list rows.
   */
  setAcpModeResolver(resolver?: AcpModeResolver): void {
    this.acpModeResolver = resolver
  }

  /**
   * Optional host integration: report a detached ACP worker as an EXTERNAL
   * child in the parent chat session's subagent catalog. Display-only — the
   * host renders it as a read-only "external task" row with no child session,
   * activity or continuation. An absent reporter is a no-op.
   */
  setSubagentCatalogReporter(reporter?: SubagentCatalogReporter): void {
    this.subagentCatalogReporter = reporter
  }

  /**
   * Hand one detached worker to the host catalog. Returns whether a reporter
   * handled it; a missing chat id or reporter leaves the dispatch unclaimed so
   * a later wire update can retry.
   */
  reportSubagentCatalog(session: LiveSession, childId: string, label: string): boolean {
    const dshSessionId = session.dshSessionId
    const reporter = this.subagentCatalogReporter
    if (dshSessionId === undefined || reporter === undefined) return false
    try {
      reporter(dshSessionId, childId, label)
      return true
    } catch {
      return false
    }
  }

  /**
   * Record external-worker lifecycle rows for one conversation.
   *
   * The in-memory copy is replaced on EVERY call — `lastActivityAt` and
   * `counts` move with the worker's frames. A `subagents/record` frame goes out
   * only when the caller says the status changed (creation included), and the
   * state file is rewritten once for the batch on the same transitions.
   * `agents.json` is a synchronous full-file write, so a call per worker chunk
   * would stall the host; the caller enforces that split.
   */
  noteSubagentRecords(records: readonly SubagentRecord[], options: { announce: boolean; persist: boolean }): void {
    for (const record of records) {
      const list = this.subagentRecords.get(record.dshSessionId) ?? []
      const at = list.findIndex(row => row.childId === record.childId)
      // The cap only has work to do when a NEW row arrives (an existing row is
      // replaced in place, so the length cannot grow past the cap).
      const next = at < 0
        ? capSubagentRecords([...list, record])
        : list.map((row, index) => (index === at ? record : row))
      this.subagentRecords.set(record.dshSessionId, next)
      if (options.announce) {
        this.hub.broadcast({ type: 'subagents/record', dshSessionId: record.dshSessionId, record })
      }
    }
    if (options.persist) this.persistAgents()
  }

  /**
   * Session-level bookkeeping for CodeBuddy's detached workers and background
   * drains. Runs for EVERY `session/update`, with or without a turn controller:
   * a worker that finishes after its dispatching turn CLOSED must still move
   * its record, and the idle clock must see the pending work.
   *
   * The wire shape is unchanged from the turn-level version:
   * - the dispatch call's own frames (matched by id, completion carries no
   *   `_meta`) move status / counters and may mark it `detached`;
   * - `parentToolCallId` frames are the worker's own turn: evidence of life
   *   (`sawWorkerUpdate`), never the dispatch record's `_meta` identity;
   * - `unsolicitedTurn` names the drain that will carry the report.
   */
  private trackSessionBackgroundDispatch(session: LiveSession, update: SessionUpdate): void {
    const raw = update as Record<string, unknown>
    const meta = codebuddyMetaOf(raw)
    const kind = String(raw.sessionUpdate ?? '')
    const row = raw as { toolCallId?: unknown; status?: unknown }
    const toolCallId = typeof row.toolCallId === 'string' ? row.toolCallId.trim() : ''
    const status = typeof row.status === 'string' ? row.status : ''
    const completedStatus = status === 'completed' || status === 'failed'
    const now = Date.now()
    const type = typeof meta?.subagentType === 'string' && meta.subagentType !== '' ? meta.subagentType : undefined
    const dispatches = session.backgroundDispatches ??= new Map<string, BackgroundDispatch>()
    if ((kind === 'tool_call' || kind === 'tool_call_update') && toolCallId !== '') {
      // A terminal tool frame may arrive WITHOUT `parentToolCallId` (the real
      // completion shape): close that id in every dispatch's table by id.
      if (completedStatus) {
        for (const dispatch of dispatches.values()) dispatch.openWorkerToolCalls?.delete(toolCallId)
      }
      const known = dispatches.get(toolCallId)
      if (known !== undefined) {
        // A known dispatch: the id is the whole evidence (see the doc above).
        known.lastActivityAt = now
        known.counts.updates += 1
        if (type !== undefined && known.subagentType === undefined) known.subagentType = type
        if (status !== '') known.status = status
        const justCompleted = completedStatus && !known.completed
        if (justCompleted) {
          known.completed = true
          // The worker finished: no tool call of its own turn can still be open.
          known.openWorkerToolCalls?.clear()
          // A terminal state already written (cancelled / unknown) is never
          // overwritten by a late completion: the row keeps the ending that
          // actually happened, and the late frame only stops further counting.
          if (known.terminal === undefined) {
            known.terminal = status === 'failed' ? 'failed' : 'completed'
            known.endedAt = now
            if (status === 'failed' && raw.content !== undefined) known.error = raw.content
          }
        }
        if (!known.catalogReported) this.refreshSubagentDispatchLabel(known, raw)
        if (meta?.isBackground === true) {
          known.detached = true
          this.reportSubagentDispatch(session, known)
        }
        this.syncDispatchRecord(session, known)
        // Every frame of a known dispatch is evidence its worker still works:
        // the worker phase is SILENCE-based, so a live hold must not time out.
        session.turnController?.onBackgroundDispatchFrame()
        if (justCompleted) {
          // Last chance for a row still waiting on identity: completion is a
          // fact even when the agent never said more than the tool name.
          this.reportSubagentDispatch(session, known)
          this.noteSessionDispatchProgress(session)
        }
      } else if (meta !== undefined
        && (meta.toolName === 'Agent' || meta.toolName === 'Task')
        && (kind === 'tool_call' || meta.isBackground === true)) {
        const dispatch: BackgroundDispatch = {
          toolCallId,
          status,
          completed: completedStatus,
          detached: meta.isBackground === true,
          sawWorkerUpdate: false,
          catalogLabel: subagentDispatchLabel(raw),
          catalogLabelIdentified: subagentDispatchDeclaresIdentity(raw),
          catalogReported: false,
          startedAt: now,
          lastActivityAt: now,
          ...(completedStatus
            ? {
                terminal: status === 'failed' ? 'failed' as const : 'completed' as const,
                endedAt: now,
                ...(status === 'failed' && raw.content !== undefined ? { error: raw.content } : {}),
              }
            : {}),
          ...(type === undefined ? {} : { subagentType: type }),
          counts: { updates: 1, toolCalls: 0, textChars: 0 },
        }
        dispatches.set(toolCallId, dispatch)
        this.pruneSessionDispatches(dispatches)
        // A hold may only wait for work THIS turn handed out; a worker left
        // over from an earlier turn is not this turn's drain.
        session.turnController?.noteTurnDispatch(toolCallId)
        // Creation is a state entering the record, announced HERE — not behind
        // `catalogReported`: a row the host catalog never accepted must still
        // reach the browser ("目录待同步").
        this.syncDispatchRecord(session, dispatch)
        session.turnController?.onBackgroundDispatchFrame()
        if (dispatch.detached) this.reportSubagentDispatch(session, dispatch)
      }
    }
    if (meta?.parentToolCallId !== undefined) {
      const parent = dispatches.get(meta.parentToolCallId)
      if (parent !== undefined) {
        // The worker's own tool calls: an OPEN one is the long-tier evidence
        // the idle clock reads (`hasPendingBackgroundWork`). Completed / failed
        // closes it; an update with no status carries no news (same rule as
        // the main turn's `activeToolCalls`).
        const openTools = parent.openWorkerToolCalls ??= new Map<string, number>()
        if (toolCallId !== '' && (kind === 'tool_call' || kind === 'tool_call_update')) {
          if (status === 'completed' || status === 'failed') openTools.delete(toolCallId)
          else if (status === 'pending' || status === 'in_progress') openTools.set(toolCallId, openTools.get(toolCallId) ?? now)
          else if (kind === 'tool_call') openTools.set(toolCallId, now)
        }
        session.turnController?.onWorkerToolCall(kind, toolCallId, status)
        parent.lastActivityAt = now
        parent.counts.updates += 1
        if (kind === 'tool_call') parent.counts.toolCalls += 1
        else if (kind === 'agent_message_chunk') parent.counts.textChars += chunkTextOf(raw.content).length
        if (type !== undefined && parent.subagentType === undefined) parent.subagentType = type
        // `parentToolCallId` proves the worker alive, NOT that it runs detached:
        // CodeBuddy tags a SYNCHRONOUS subagent's child updates the same way.
        parent.sawWorkerUpdate = true
        this.reportSubagentDispatch(session, parent)
        this.syncDispatchRecord(session, parent)
        // The worker's own prose / tool frames are evidence of work too.
        session.turnController?.onBackgroundDispatchFrame()
      }
    }
    if (meta?.unsolicitedTurn !== undefined) {
      session.turnController?.onBackgroundDrainAnnounced(meta.unsolicitedTurn.requestId)
    }
  }

  /** Where one dispatch stands, derived from the wire facts of its own record. */
  private dispatchStatus(dispatch: BackgroundDispatch): SubagentStatus {
    if (dispatch.terminal !== undefined) return dispatch.terminal
    if (dispatch.sawWorkerUpdate || dispatch.detached || dispatch.status === 'in_progress') return 'running'
    return 'pending'
  }

  /** Build the persisted lifecycle record for one dispatch. */
  private dispatchRecord(dispatch: BackgroundDispatch, dshSessionId: string): SubagentRecord {
    return {
      childId: `acp:${dispatch.toolCallId}`,
      dshSessionId,
      toolCallId: dispatch.toolCallId,
      label: dispatch.catalogLabel,
      ...(dispatch.subagentType === undefined ? {} : { type: dispatch.subagentType }),
      status: this.dispatchStatus(dispatch),
      startedAt: dispatch.startedAt,
      lastActivityAt: dispatch.lastActivityAt,
      ...(dispatch.endedAt === undefined ? {} : { endedAt: dispatch.endedAt }),
      ...(dispatch.error === undefined ? {} : { error: dispatch.error }),
      counts: { ...dispatch.counts },
    }
  }

  /**
   * Keep the lifecycle record current, announcing it ONLY when its status
   * changed (creation included) and writing the state file on the same
   * transitions. A write per worker chunk would stall the host.
   */
  private syncDispatchRecord(session: LiveSession, dispatch: BackgroundDispatch): void {
    const dshSessionId = session.dshSessionId
    if (dshSessionId === undefined) return
    const status = this.dispatchStatus(dispatch)
    const transition = dispatch.reportedStatus !== status
    if (transition) dispatch.reportedStatus = status
    this.noteSubagentRecords(
      [this.dispatchRecord(dispatch, dshSessionId)],
      { announce: transition, persist: transition },
    )
  }

  /**
   * Hand one DETACHED dispatch to the host's subagent catalog. One fact per
   * tool call, and only once the wire's structure proves the work runs off-turn.
   */
  private reportSubagentDispatch(session: LiveSession, dispatch: BackgroundDispatch): void {
    if (dispatch.catalogReported) return
    if (!dispatch.catalogLabelIdentified && !dispatch.completed) return
    if (this.reportSubagentCatalog(session, `acp:${dispatch.toolCallId}`, dispatch.catalogLabel)) {
      dispatch.catalogReported = true
    }
  }

  /**
   * Take a better label from a later frame of the SAME dispatch call. A frame
   * with no identity and no title must not downgrade what is already known.
   */
  private refreshSubagentDispatchLabel(dispatch: BackgroundDispatch, update: Record<string, unknown>): void {
    const identified = subagentDispatchDeclaresIdentity(update)
    if (!identified && dispatch.catalogLabelIdentified) return
    const title = update.title
    if (!identified && !(typeof title === 'string' && title !== '')) return
    dispatch.catalogLabel = subagentDispatchLabel(update)
    dispatch.catalogLabelIdentified = identified
  }

  /**
   * A dispatch just reported: tell the turn controller it may move to its
   * drain phase. The catalog row was already offered by the completing frame.
   */
  private noteSessionDispatchProgress(session: LiveSession): void {
    session.turnController?.onAllDispatchesCompleted()
  }

  /**
   * Bound the session map. Terminal rows are history for the record view (the
   * detail read uses the transcript, not this map), so evicting the oldest
   * finished one keeps a long-lived conversation from growing without limit.
   */
  private pruneSessionDispatches(dispatches: Map<string, BackgroundDispatch>): void {
    if (dispatches.size <= MAX_SUBAGENT_RECORDS) return
    for (const [id, dispatch] of dispatches) {
      if (dispatch.terminal !== undefined) {
        dispatches.delete(id)
        return
      }
    }
  }

  /**
   * Terminalize every unfinished dispatch of a SESSION that goes away
   * (close / release / force reset / process death), or of a turn the user
   * cancelled / that failed. A normal stop is not one of these: its worker may
   * still be running (see `LiveSession.backgroundDispatches`).
   */
  terminalizeSessionDispatches(
    session: LiveSession,
    status: 'cancelled' | 'unknown',
    onlyIds?: ReadonlySet<string>,
  ): void {
    const dispatches = session.backgroundDispatches
    const dshSessionId = session.dshSessionId
    if (dispatches === undefined) return
    const now = Date.now()
    const records: SubagentRecord[] = []
    for (const dispatch of dispatches.values()) {
      if (onlyIds !== undefined && !onlyIds.has(dispatch.toolCallId)) continue
      if (dispatch.terminal !== undefined) continue
      dispatch.terminal = status
      dispatch.endedAt = now
      dispatch.reportedStatus = status
      if (dshSessionId !== undefined) records.push(this.dispatchRecord(dispatch, dshSessionId))
    }
    if (records.length === 0) return
    this.noteSubagentRecords(records, { announce: true, persist: true })
  }

  /**
   * The plugin's own lifecycle records for one conversation. Empty for a
   * conversation that never dispatched a worker; the panel joins this with the
   * host's catalog projection by `childId` (a catalog row with no record reads
   * `unknown`, never succeeded).
   */
  subagentsFor(dshSessionId: string): SubagentRecord[] {
    return [...(this.subagentRecords.get(dshSessionId) ?? [])]
  }

  /**
   * Raw transcript entries for ONE external worker — the detail view's
   * on-demand read. Two filters, BOTH needed: the dispatch's own frames
   * (`toolCallId === <dispatch id>`, which is where the raw input and the
   * terminal frame live) and the worker's frames
   * (`_meta.parentToolCallId === <dispatch id>`). Released sessions keep
   * serving their retained buffers. Bounded: the newest
   * {@link MAX_SUBAGENT_DETAIL_ENTRIES} entries, each raw payload cut at
   * `ACP_TOOL_RAW_MAX` with a marker — never silently.
   */
  subagentsDetail(dshSessionId: string, childId: string): SubagentDetailResult {
    const toolCallId = subagentToolCallId(childId)
    if (toolCallId === '') return { entries: [] }
    const matched: SubagentDetailEntry[] = []
    for (const session of this.dshSessionMap.values()) {
      // A closed session is destroyed, not merely unreachable; released ones
      // still hold the transcript the user is reading.
      if (session.dshSessionId !== dshSessionId || session.closed) continue
      for (const entry of session.transcript.since(0)) {
        const update = entry.update as Record<string, unknown>
        const meta = codebuddyMetaOf(update)
        if (update.toolCallId !== toolCallId && meta?.parentToolCallId !== toolCallId) continue
        matched.push(boundSubagentDetailEntry(entry.seq, entry.update))
      }
    }
    if (matched.length <= MAX_SUBAGENT_DETAIL_ENTRIES) return { entries: matched }
    return {
      entries: matched.slice(-MAX_SUBAGENT_DETAIL_ENTRIES),
      omitted: matched.length - MAX_SUBAGENT_DETAIL_ENTRIES,
    }
  }

  /**
   * The agent skills one conversation can use (`agent/skills`, the `/` menu's
   * skill rows): flavor from the agent's command line, one filesystem scan
   * over that flavor's skill dirs, TTL-cached in memory per agent + workspace.
   *
   * Deliberately NOT persisted (the structural difference from
   * `absorbCommands`, which must survive restarts because commands can only be
   * DECLARED by a live session): a scan is a pure fs read with no spawn
   * dependency, so a reboot simply re-scans on the first ask, and no
   * `model-catalog.json` shape or schema bump is owed. No SSE frame either —
   * the browser re-asks past the TTL. Unknown agent → empty answer, the same
   * contract `subagentsDetail` keeps.
   */
  async agentSkills(dshSessionId: string, agentId: string): Promise<AgentSkillsResult> {
    const def = this.defsMap.get(agentId)
    if (def === undefined) return { skills: [] }
    const workspaceRoot = chatWorkspaceRoot(this.sessionWorkspaceResolver, dshSessionId)
    const key = `${agentId}\u0000${workspaceRoot ?? ''}`
    const hit = this.skillCache.get(key)
    if (hit !== undefined && Date.now() - hit.at < SKILL_SCAN_TTL_MS) return hit.result
    const flavor = skillFlavorOf(def.command, def.args)
    const result = scanSkillDirs(flavor, workspaceRoot, homedir())
    // Cache eviction is insertion-order based (oldest timestamp wins), like the
    // browser half's prune: 32 agents × workspaces is far beyond any roster.
    while (this.skillCache.size >= SKILL_SCAN_CACHE_MAX) {
      let oldestKey: string | undefined
      let oldestAt = Number.POSITIVE_INFINITY
      for (const [key, value] of this.skillCache) {
        if (value.at < oldestAt) {
          oldestAt = value.at
          oldestKey = key
        }
      }
      if (oldestKey === undefined) break
      this.skillCache.delete(oldestKey)
    }
    // `truncated` is absent on the wire when nothing was cut — the marker is
    // news, the normal case is not.
    const answer: AgentSkillsResult = { skills: result.skills, ...(result.truncated ? { truncated: true } : {}) }
    this.skillCache.set(key, { at: Date.now(), result: answer })
    return answer
  }

  /**
   * Whether ONE DSH chat session runs the ACP agent preset, asked by chat
   * session id. The browser's composer surfaces consume this: on hosts whose
   * client runtime does not carry `agentPreset` on the session-list row (their
   * preferred fact source), this is the only way to know which conversation is
   * an ACP one.
   *
   * The resolver may await a persistence read (a cold session has to be read
   * from disk), so answers are CACHED per session id and served synchronously:
   * the first ask returns `false` while the read is in flight and the caller
   * re-asks on the next tick — a one-turn delay, never a wrong verdict.
   * A cached verdict is dropped when the session's log moves (preset switch,
   * new turn), so a stale answer cannot outlive the fact it was folded from.
   */
  chatSessionAcpMode(dshSessionId: string): boolean {
    const cached = this.acpModeCache.get(dshSessionId)
    if (cached !== undefined) return cached
    const resolver = this.acpModeResolver
    if (resolver === undefined) return false
    try {
      const answered = resolver(dshSessionId)
      if (answered instanceof Promise) {
        // Prime the cache from the settled read; the synchronous asker still
        // got `false` this round (see `chatSessionAcpModeAnswer` for the
        // awaitable form the RPC serves instead).
        void answered.then(verdict => {
          if (verdict !== undefined) this.acpModeCache.set(dshSessionId, verdict === true)
        }).catch(() => { /* retry on the next ask */ })
        return false
      }
      if (answered !== undefined) this.acpModeCache.set(dshSessionId, answered === true)
      return answered === true
    } catch {
      // Never guess from a failed lookup: the browser's fallback then reads
      // "not ACP", which keeps the native seat — the allowed failure mode.
      return false
    }
  }

  /**
   * The awaitable form of `chatSessionAcpMode`, served by the `session/chat-list`
   * RPC: the first ask WAITS for the cold read instead of answering early, so
   * the browser's one-shot fallback sees the settled verdict immediately —
   * a synchronous first answer of `false` would be remembered by the gate and
   * the seat would never take over. Concurrent asks for the same session share
   * one read (in-flight dedup); a failed lookup returns `false` for that ask
   * but is NOT cached, so the next ask retries.
   */
  async chatSessionAcpModeAnswer(dshSessionId: string): Promise<boolean> {
    const cached = this.acpModeCache.get(dshSessionId)
    if (cached !== undefined) return cached
    const resolver = this.acpModeResolver
    if (resolver === undefined) return false
    let inflight = this.acpModeInflight.get(dshSessionId)
    if (inflight === undefined) {
      inflight = (async () => {
        try {
          return await resolver(dshSessionId)
        } catch {
          return undefined
        } finally {
          this.acpModeInflight.delete(dshSessionId)
        }
      })()
      this.acpModeInflight.set(dshSessionId, inflight)
    }
    const verdict = await inflight
    if (verdict !== undefined) {
      this.acpModeCache.set(dshSessionId, verdict === true)
      return verdict === true
    }
    return false
  }

  /** Drop cached ACP-mode verdicts: one session's, or all of them. */
  invalidateAcpMode(dshSessionId?: string): void {
    if (dshSessionId === undefined) {
      this.acpModeCache.clear()
      return
    }
    this.acpModeCache.delete(dshSessionId)
  }

  /**
   * The ACP agent sessions backing one DSH chat session. The composer uses this
   * to offer the agent's OWN modes next to the host's Access mode control —
   * "how the agent works" beside "what it may touch", which is the split that
   * keeps the two controls from reading as duplicates.
   */
  chatSessions(dshSessionId: string): ChatSessionView[] {
    const out: ChatSessionView[] = []
    // The plugin's own lifecycle records, keyed by the CHAT session: they cover
    // live and released sessions alike (a parked conversation's terminal
    // records must survive a reload), and are attached to every row of this
    // conversation — the browser de-duplicates by `dshSessionId + childId`,
    // because one conversation can briefly have more than one ACP session row.
    const subagents = this.subagentRecords.get(dshSessionId)
    for (const session of this.dshSessionMap.values()) {
      if (session.dshSessionId !== dshSessionId || session.closed) continue
      const title = this.defsMap.get(session.agentId)?.title
      out.push({
        agentId: session.agentId,
        ...(title === undefined ? {} : { agentTitle: title }),
        sessionId: session.sessionId,
        ...(session.title === undefined ? {} : { title: session.title }),
        ...(session.modelId === undefined ? {} : { modelId: session.modelId }),
        ...(session.reasoningEffort === undefined ? {} : { reasoningEffort: session.reasoningEffort }),
        ...(session.modes === undefined ? {} : { modes: session.modes }),
        ...(session.availableCommands === undefined ? {} : { availableCommands: session.availableCommands }),
        ...(session.usage === undefined ? {} : { usage: session.usage }),
        ...(session.burst === undefined ? {} : { burst: session.burst }),
        ...(session.released ? { released: true } : {}),
        ...(session.running ? { running: true } : {}),
        ...(subagents === undefined || subagents.length === 0 ? {} : { subagents: [...subagents] }),
        ...forkRowInfo(session, this.canForkNow(session.agentId)),
      })
    }
    return out
  }

  /**
   * Adopt the ACP side of a branched conversation: the browser has already
   * asked the HOST to fork the DSH session tree (`sessions.fork`), and this
   * runs the agent's own `session/fork` of the parent conversation's live ACP
   * session so the child actually remembers the parent context — then binds
   * the child to it (the fourth session-creation point, with every discipline
   * the other three carry).
   *
   * Failure is deliberately all-or-nothing: nothing is written for the child
   * until the agent has answered, so a failed adopt leaves the child an
   * ordinary copied-history conversation whose first message starts a fresh
   * `session/new` (today's behavior) — never a half-bound record.
   *
   * @param childDshSessionId - the DSH session the host fork created.
   * @param parentDshSessionId - the conversation being branched; its ACP
   *   session must be LIVE on this connection (a released parent has no
   *   process to fork from — the browser blocks the click, this is the hard
   *   stop behind it).
   */
  async adoptForkedSession(childDshSessionId: string, parentDshSessionId: string): Promise<{ sessionId: string; acpSessionId: string }> {
    // One conversation, one agent (the lock). The parent's LIVE session is
    // the fork source; released or in-flight-settling parents are refused —
    // forking a parked record would silently resume it, and forking mid-turn
    // would fork an agent state the parent turn is still changing.
    const parent = [...this.dshSessionMap.values()].find(session =>
      session.dshSessionId === parentDshSessionId && !session.closed && !session.released)
    if (parent === undefined) {
      throw new AcpError('parent_not_live', 'acp: the conversation to branch has no live ACP session; send a message to resume it first')
    }
    if (parent.running || parent.settled !== undefined) {
      throw new AcpError('turn_in_flight', 'acp: the conversation to branch is running a turn; wait for it to finish')
    }
    const agentId = parent.agentId
    // A1 (F2): refuse before any request or record is written. `canForkNow`
    // below also answers `false`, but failing here keeps the error the same
    // shape even if the capability gate ever changes.
    if (isPerSessionAgent(agentId)) {
      throw new AcpError('fork_unsupported', `acp: agent "${agentId}" runs one process per conversation and cannot fork`)
    }
    const childKey = `${childDshSessionId}:${agentId}`
    if (this.dshSessionMap.has(childKey)) {
      throw new AcpError('id_conflict', 'acp: the forked conversation is already bound to an ACP session')
    }
    // Capability gate BEFORE any request: an agent that never advertised
    // `session/fork` must not be asked (it would answer an unknown-method
    // error at best). Live init wins, last-known falls back — the same
    // verdict the browser's row already showed.
    if (!this.canForkNow(agentId)) {
      throw new AcpError('fork_unsupported', `acp: agent "${agentId}" does not advertise the session/fork capability`)
    }
    const session = await this.bridge(agentId).forkSession(parent, childDshSessionId)
    // The fork answered — the child is real on the agent side. From here the
    // binding is written through the SAME paths as any chat session: one
    // choice record (a copy of the parent's, locked — a branched conversation
    // belongs to its agent from birth), the route pin, and persistence.
    this.dshSessionMap.set(childKey, session)
    const parentChoice = this.chatAgentIntent.get(parentDshSessionId)
    this.patchChatChoice(childDshSessionId, {
      agentId,
      locked: true,
      ...(parentChoice?.modelId === undefined ? {} : { modelId: parentChoice.modelId }),
      ...(parentChoice?.effort === undefined ? {} : { effort: parentChoice.effort }),
      ...(parentChoice?.mode === undefined ? {} : { mode: parentChoice.mode }),
      ...(parentChoice?.extraConfigs === undefined ? {} : { extraConfigs: { ...parentChoice.extraConfigs } }),
    })
    // The fourth creation point follows the same discipline as `createSession`
    // and `doResumeSession`: apply the recorded pick to the fresh session, so
    // mode and extra configs (which only this path applies) cannot drift from
    // what the composer shows — a forked session starts on the agent-side
    // state the fork copied, and the record must match what runs.
    await this.applyChatChoice(session)
    // Re-publish so the browser's list and the composer's occupancy ring see
    // the child immediately (with its just-bound choice mirrors).
    this.hub.broadcast({ type: 'session/meta', sessionId: session.sessionId, session: snapshot(session) })
    this.persistAgents()
    return { sessionId: session.sessionId, acpSessionId: session.acpSessionId }
  }

  /**
   * Bind one DSH chat session to an ACP agent.
   *
   * This is the plugin's OWN conversation↔agent mapping. It deliberately does
   * NOT call the host's `session.selectModel` RPC: the retired "express the
   * agent as a `provider: 'acp'` route" axis used it, which both polluted the
   * deployment default model and got refused by the GUI's catalog gate
   * (`session/model-unavailable`) — even though prompt admission never checked
   * catalog membership. The guard instead writes the session's selection
   * directly (`agent.model.select`) at wake time, on hosts that fix the route
   * before `agent/request`. See docs/acp-convergence.md §1.1 and §2.2.
   *
   * The host half records the intent; the actual ACP session is created on the
   * next turn (which is also what resumes a released one).
   */
  bindChatAgent(dshSessionId: string, agentId: string): void {
    if (!this.defsMap.has(agentId)) {
      throw new AcpError('unknown_agent', `acp: agent "${agentId}" is not configured`)
    }
    // ONE CONVERSATION, ONE AGENT (user decision, 2026-10-20): once the first
    // ACP turn has run, the conversation is locked to its agent. A different
    // agent has none of the context on its side, so switching is refused
    // rather than silently starting a second, empty conversation. Re-picking
    // the SAME agent is idempotent. The lock is persisted with the choice, so
    // this holds across restarts and after the ACP session is gone.
    const lockedTo = this.lockedAgentFor(dshSessionId)
    if (lockedTo !== undefined) {
      if (lockedTo === agentId) return
      throw new AcpError(
        'agent_locked',
        `acp: conversation is locked to agent "${lockedTo}" once its first turn has started; start a new conversation to use another agent`,
      )
    }
    // A switch to a DIFFERENT agent drops its model/effort/mode/configs: those
    // values are the PREVIOUS agent's vocabulary (a `choice` from its catalog, a
    // value of ITS `thought_level`, one of ITS `session/set_mode` ids, one of ITS
    // extra config options) and would be rejected or silently remapped by the
    // new one. Re-picking the SAME agent
    // is not a switch, so its picks stand. `patchChatChoice` owns that rule —
    // both entry points go through it so the two cannot drift.
    this.patchChatChoice(dshSessionId, { agentId })
  }

  /** The ACP agent a chat session was last pointed at, when one is known. */
  chatAgentFor(dshSessionId: string): string | undefined {
    const recorded = this.chatAgentIntent.get(dshSessionId)?.agentId
    if (recorded !== undefined && this.defsMap.has(recorded)) return recorded
    // Fall back to the binding itself: a session that already ran an agent is
    // pointed at that agent even if the intent map was never seeded.
    for (const session of this.dshSessionMap.values()) {
      if (session.dshSessionId === dshSessionId && !session.closed) return session.agentId
    }
    return undefined
  }

  /**
   * The agent a conversation is LOCKED to, if its first ACP turn has run.
   *
   * The persisted `locked` flag is the durable answer and deliberately ignores
   * the roster: a deleted agent still owns the conversation's context, and the
   * conversation must not pretend it is unbound (that would offer a switch the
   * turn path then has to refuse). The live/released session fallback covers
   * conversations recorded before the flag existed; the next turn writes the
   * flag (`lockChatAgent`).
   */
  lockedAgentFor(dshSessionId: string): string | undefined {
    const recorded = this.chatAgentIntent.get(dshSessionId)
    if (recorded?.locked === true) return recorded.agentId
    for (const session of this.dshSessionMap.values()) {
      if (session.dshSessionId === dshSessionId && !session.closed) return session.agentId
    }
    return undefined
  }

  /**
   * Write the conversation's agent lock and announce it once.
   *
   * Called at the START of the conversation's first ACP turn (the session was
   * just materialized), so the composer can play its base→tag hand-off while
   * the turn is running instead of waiting for it to settle. Returns true when
   * this call created the lock; the caller marks a newly created session
   * `provisionalLock`, and a first turn that delivers nothing rolls it back
   * (`rollbackFirstTurn`). The broadcast is what lets the browser react at
   * once: a `session/chat-list` read is a round-trip behind.
   */
  private lockChatAgent(dshSessionId: string, agentId: string): boolean {
    const current = this.chatAgentIntent.get(dshSessionId)
    if (current?.locked === true && current.agentId === agentId) return false
    const newlyLocked = current?.locked !== true
    this.patchChatChoice(dshSessionId, { agentId, locked: true })
    if (newlyLocked) {
      this.hub.broadcast({ type: 'chat/agent-locked', dshSessionId, agentId })
    }
    return newlyLocked
  }

  /**
   * Undo the provisional lock of a first turn that delivered nothing, and drop
   * the failed session with it.
   *
   * A turn that produced an error before any text/reasoning, or a silent
   * provider failure folded into a normal stop, exchanged nothing with the
   * agent: there is no context to protect, so the conversation may choose
   * another agent. The session is CLOSED rather than kept, because both lock
   * readers (`lockedAgentFor` here and `lockedAgentOf` in the browser) treat a
   * live session as a lock — keeping it would leave a visually locked
   * conversation whose picker the host still accepts.
   *
   * The pick itself (agent/model/effort/mode/extra configs) stays recorded: the
   * base comes back showing the same agent, ready to be changed or retried.
   */
  private rollbackFirstTurn(session: LiveSession): void {
    session.provisionalLock = false
    const dshSessionId = session.dshSessionId
    if (dshSessionId === undefined) return
    const current = this.chatAgentIntent.get(dshSessionId)
    if (current?.locked === true && current.agentId === session.agentId) {
      const next: AcpConversationChoice = { ...current }
      delete next.locked
      this.chatAgentIntent.set(dshSessionId, next)
      this.persistAgents()
      // Keep the request-path binding on the picked agent: it is still what
      // the base shows and what an unchanged retry should run.
      this.syncConversationRoute(dshSessionId)
      this.hub.broadcast({ type: 'chat/agent-unlocked', dshSessionId })
    }
    // Drop the chat-keyed record BEFORE the asynchronous agent-side close: the
    // browser's very next `session/chat-list` must not see this session.
    this.forgetDshSession(session.sessionId)
    // Use the session's OWN bridge, not `this.bridge(id)` / a map lookup by
    // agent: the agent may have been deleted while its first turn was failing,
    // and a rollback must never throw — `bridgeOwning` never creates, never
    // throws, and never routes a session to another process.
    const failed = this.bridgeOwning(session.agentId, session.sessionId)
    if (failed !== undefined) {
      // Once the agent-side close has settled, drop the holder too: a failed
      // first turn leaves nothing resumable behind it (the record was forgotten
      // above), so a per-session holder would otherwise linger with a live
      // child and no session — an orphan the next message could not use.
      // `keyOfBridge` runs inside the callback so it names the holder only if
      // this bridge is still registered.
      void failed.closeSession(session, 'closed')
        .catch(() => { /* already gone */ })
        .finally(() => {
          const key = this.keyOfBridge(failed)
          if (key !== undefined) this.pruneBridge(key)
        })
    }
  }

  /**
   * The conversation's persisted pick (agent + model + thought level). This is
   * the record that survives a host restart and is readable BEFORE the
   * conversation has ever run a turn — the composer shows it, and the turn path
   * applies it to a freshly created or resumed session.
   */
  chatChoice(dshSessionId: string): AcpConversationChoice | undefined {
    const recorded = this.chatAgentIntent.get(dshSessionId)
    if (recorded === undefined) return undefined
    if (!this.defsMap.has(recorded.agentId)) return undefined
    return { ...recorded }
  }

  /**
   * Publish one conversation's pick onto the request-path binding.
   *
   * The guard's model selection (and its legacy `agent/request` rewrite) and
   * this class's own turn admission read
   * `routeBindingRegistry().conversations`, whose values are adapter model ids.
   * The MODEL half of the pick therefore rides there, so a turn that starts
   * with `agentId` alone does not silently drop a variant chosen up front; with
   * no model picked the binding is the bare agent id (the agent's default).
   *
   * Only ever WRITES: a conversation with no recorded pick keeps whatever the
   * turn path pinned to it (the agent that actually served its last turn), which
   * is the honest answer for a session whose intent map was never seeded.
   */
  private syncConversationRoute(dshSessionId: string): void {
    const choice = this.chatAgentIntent.get(dshSessionId)
    if (choice === undefined || !this.defsMap.has(choice.agentId)) return
    routeBindingRegistry().conversations.set(dshSessionId, choice.modelId ?? choice.agentId)
  }

  /**
   * The adapter model string one chat conversation's next turn runs on — the
   * request-path binding, when it names a CONFIGURED agent. `undefined` leaves
   * the turn on whatever route the driver resolved (the allowed failure: the
   * harness default plays out).
   */
  private conversationRouteModel(dshSessionId: string): string | undefined {
    const model = routeBindingRegistry().conversations.get(dshSessionId)
    if (model === undefined || model === '') return undefined
    return this.defsMap.has(splitAdapterModelId(model).agentId) ? model : undefined
  }

  /**
   * The agent's own default thought level — the effort the driver MATERIALIZES
   * into a request that did not ask for one (`resolveCallWithInfo` fills
   * `reasoning.defaultEffort` in and marks it adapter-defaulted). Re-applying
   * that as a per-turn choice would revert a pick the user just made through
   * the seat, so the turn path treats it as "no effort requested".
   */
  private modelDefaultEffort(agentId: string): string | undefined {
    return this.reasoningMeta(agentId)?.defaultEffort
  }

  /**
   * Record one field of a conversation's pick and persist it.
   *
   * Every bottom-bar control (agent, model, thought level, the agent's own mode,
   * the advanced base's extra config values) is one field of the SAME record,
   * and the setters used to spell the record
   * out by hand each time — which is exactly how `mode` ended up as the one
   * control that reset on every restart: no setter wrote it. Patch through here
   * so a new axis cannot be half-wired.
   *
   * `undefined` CLEARS the field (the "follow the agent's default" choice).
   */
  private patchChatChoice(
    dshSessionId: string,
    patch: Partial<AcpConversationChoice>,
  ): void {
    const current = this.chatAgentIntent.get(dshSessionId)
    const agentId = patch.agentId ?? current?.agentId ?? this.chatAgentFor(dshSessionId)
    if (agentId === undefined) return
    // A patch that names a DIFFERENT agent starts from a clean record: the
    // other fields are the previous agent's vocabulary and must not survive.
    const base = patch.agentId !== undefined && patch.agentId !== current?.agentId ? {} : current
    const next: AcpConversationChoice = { ...base, ...patch, agentId }
    if (next.locked !== true) delete next.locked
    if (next.modelId === undefined) delete next.modelId
    if (next.effort === undefined) delete next.effort
    if (next.mode === undefined) delete next.mode
    if (next.extraConfigs === undefined || Object.keys(next.extraConfigs).length === 0) delete next.extraConfigs
    this.chatAgentIntent.set(dshSessionId, next)
    this.persistAgents()
    this.syncConversationRoute(dshSessionId)
  }

  /** Switch the bound agent's model for one chat session (`agentId@choice`). */
  async setChatSessionModel(dshSessionId: string, modelId: string): Promise<void> {
    const { agentId, choice } = splitAdapterModelId(modelId)
    const def = this.defsMap.get(agentId)
    if (def === undefined) {
      throw new AcpError('unknown_agent', `acp: agent "${agentId}" is not configured`)
    }
    // A model id names its agent, so this call can also be an agent switch.
    // Once locked, only the locked agent's models are accepted.
    const lockedTo = this.lockedAgentFor(dshSessionId)
    if (lockedTo !== undefined && lockedTo !== agentId) {
      throw new AcpError('agent_locked', `acp: conversation is locked to agent "${lockedTo}" once its first turn has started`)
    }
    // A model the live session's agent no longer lists is refused HERE too:
    // recording it would look like a successful switch while the next send is
    // doomed to `model_unavailable`. Before a session exists there is nothing
    // authoritative to validate against — the send-time gate covers it.
    for (const session of this.dshSessionMap.values()) {
      if (session.dshSessionId !== dshSessionId || session.agentId !== agentId || session.released) continue
      const stale = choice === undefined ? undefined : this.staleModelChoice(session, choice)
      if (stale !== undefined) {
        throw new AcpError('model_unavailable', `acp: agent "${agentId}" no longer offers model "${stale}"`)
      }
    }
    // A thought level is not a property of the agent alone: opencode publishes
    // `thought_level` only for models with variants, so the previous model's
    // level is not the new model's vocabulary. A LIVE session can judge the old
    // pick against the new model's own option set (`alignSessionConfig`, which
    // drops it with a notice when the set no longer offers it). Before the first
    // session there is no such authority — the catalog still describes the model
    // the agent was last on — so the level is cleared instead of being displayed
    // as this model's own until the first message.
    const previous = this.chatAgentIntent.get(dshSessionId)
    const nextModelId = choice === undefined ? undefined : modelId
    const modelChanged = previous?.agentId === agentId && previous.modelId !== nextModelId
    const hasLiveSession = [...this.dshSessionMap.values()].some(session =>
      session.dshSessionId === dshSessionId && session.agentId === agentId && !session.released)
    const clearEffort = modelChanged && !hasLiveSession
    // The pick is recorded even when NO live session exists yet — that is the
    // "choose the model before the first message" case. A session that
    // materializes later reads it back (`applyChatChoice`).
    this.patchChatChoice(dshSessionId, {
      agentId,
      modelId: nextModelId,
      ...(clearEffort ? { effort: undefined } : {}),
    })
    for (const session of this.dshSessionMap.values()) {
      if (session.dshSessionId !== dshSessionId || session.agentId !== agentId) continue
      session.choice = choice
      // A row can carry a level without a recorded pick (`streamPrompt` mirrors
      // the turn's effort onto the session). Clear it on the same evidence as
      // the pick — the row's own model changed and nothing live can re-validate
      // it — or the released row keeps naming the old level.
      const rowModelChanged = session.modelId !== modelId
      session.modelId = modelId
      // The chip reads this mirror through `session/chat-list`; clearing only
      // the pick would leave a parked row naming the old level.
      if (clearEffort || (rowModelChanged && !hasLiveSession)) session.reasoningEffort = undefined
      if (session.released) continue
      const aligned = await this.alignSessionConfig(session, choice, session.reasoningEffort)
      if (aligned.effortStale) session.reasoningEffort = undefined
    }
    this.persistAgents()
  }

  /**
   * Switch the reasoning effort for one chat session.
   *
   * `agentId` names the agent that serves a conversation nobody has bound —
   * the plugin default the guard's route rewrite falls back to. The browser
   * knows it (its composer chip is built from the same route), and without it
   * `chatAgentFor` answers undefined before the first session exists, so the
   * pick would be silently dropped.
   */
  async setChatSessionEffort(dshSessionId: string, effort: string | undefined, agentId?: string): Promise<void> {
    if (agentId !== undefined) {
      if (!this.defsMap.has(agentId)) {
        throw new AcpError('unknown_agent', `acp: agent "${agentId}" is not configured`)
      }
      const lockedTo = this.lockedAgentFor(dshSessionId)
      if (lockedTo !== undefined && lockedTo !== agentId) {
        throw new AcpError('agent_locked', `acp: conversation is locked to agent "${lockedTo}" once its first turn has started`)
      }
    }
    // Recorded before any session exists (see `setChatSessionModel`); a released
    // session is skipped here and re-aligned by `applyChatChoice` on resume.
    this.patchChatChoice(dshSessionId, { ...(agentId === undefined ? {} : { agentId }), effort })
    for (const session of this.dshSessionMap.values()) {
      if (session.dshSessionId !== dshSessionId) continue
      if (agentId !== undefined && session.agentId !== agentId) continue
      session.reasoningEffort = effort
      if (session.released) continue
      const aligned = await this.alignSessionConfig(session, session.choice, effort)
      // Same rule as the model axis: a dropped level is no longer "in force".
      session.reasoningEffort = aligned.effortStale ? undefined : effort
    }
    this.persistAgents()
  }

  /**
   * Set one of the agent's EXTRA config options for one chat session (the
   * composer's advanced base). The value is validated against what the agent
   * actually publishes — the live session's own options first, the cached
   * catalog second — and recorded even when no session exists yet, so the pick
   * applies when the first turn materializes one (`applyChatChoice`).
   *
   * A live session is updated immediately; a failure there is warned about and
   * the pick still stands, exactly like the model/effort alignment path.
   */
  async setChatSessionConfig(dshSessionId: string, configId: string, value: string | boolean, agentId?: string): Promise<void> {
    // `agentId` is the route the composer showed — including the plugin
    // default, which `chatAgentFor` cannot report before the first session.
    const bound = agentId ?? this.chatAgentFor(dshSessionId)
    if (bound === undefined) {
      throw new AcpError('unknown_session', `acp: no ACP agent is bound to chat session ${dshSessionId}`)
    }
    if (!this.defsMap.has(bound)) {
      throw new AcpError('unknown_agent', `acp: agent "${bound}" is not configured`)
    }
    const lockedTo = this.lockedAgentFor(dshSessionId)
    if (lockedTo !== undefined && lockedTo !== bound) {
      throw new AcpError('agent_locked', `acp: conversation is locked to agent "${lockedTo}" once its first turn has started`)
    }
    const live = [...this.dshSessionMap.values()].find(session =>
      session.dshSessionId === dshSessionId && session.agentId === bound && !session.released)
    const observed = live === undefined
      ? undefined
      : parseCatalogOptions(live.configOptions).extras?.find(option => option.configId === configId)
    const advertised = this.catalogs.get(bound)?.catalog.extras?.find(option => option.configId === configId)
    const option = observed ?? advertised
    if (option === undefined) {
      throw new AcpError('unknown_config', `acp: agent "${bound}" publishes no extra config option "${configId}"`)
    }
    if (option.kind === 'boolean') {
      // The browser sends 'true' / 'false' from a checkbox row; the wire and
      // the persisted pick both use the real boolean.
      const toggle = typeof value === 'boolean'
        ? value
        : value === 'true' ? true : value === 'false' ? false : undefined
      if (toggle === undefined) {
        throw new AcpError('bad_config', `acp: "${String(value)}" is not a boolean value of config option "${configId}"`)
      }
      value = toggle
    } else if (typeof value !== 'string' || !option.choices.some(choice => choice.value === value)) {
      throw new AcpError('bad_config', `acp: "${String(value)}" is not a value of config option "${configId}"`)
    }
    const current = this.chatAgentIntent.get(dshSessionId)
    const extraConfigs = current?.agentId === bound ? { ...current.extraConfigs } : {}
    this.patchChatChoice(dshSessionId, { agentId: bound, extraConfigs: { ...extraConfigs, [configId]: value } })
    for (const session of this.dshSessionMap.values()) {
      if (session.dshSessionId !== dshSessionId || session.agentId !== bound || session.released) continue
      try {
        await this.bridgeForSession(session).setConfigOption(session, configId, value)
      } catch (error) {
        this.hub.broadcast({
          type: 'agent/notice',
          agentId: bound,
          level: 'error',
          text: `acp: failed to set config "${configId}" to "${value}": ${describeError(error)}`,
        })
      }
    }
  }

  /**
   * Apply a conversation's persisted pick to a session that just materialized —
   * created by the first turn, or resumed through `session/load` after a crash.
   *
   * This is what makes an up-front choice real rather than decorative: the
   * session/new and session/load answers come back with the AGENT's defaults,
   * which would otherwise run the first message on a model the user already
   * replaced. Best effort, exactly like the turn path's alignment: a stale
   * model is not applied (and NOT dropped — `streamPrompt` refuses to run a
   * turn on an unknown model until the user reselects), a stale thought level
   * is dropped with a notice, and the agent's own configuration is used in the
   * meantime. Never turned into a different model than the one selected.
   */
  private async applyChatChoice(session: LiveSession): Promise<void> {
    const dshSessionId = session.dshSessionId
    if (dshSessionId === undefined) return
    const choice = this.chatAgentIntent.get(dshSessionId)
    if (choice === undefined || choice.agentId !== session.agentId) return
    const { choice: modelChoice } = splitAdapterModelId(choice.modelId ?? '')
    const aligned = await this.alignSessionConfig(session, modelChoice, choice.effort)
    // Mirror the pick onto the session so `session/chat-list` reports the
    // conversation's selection. A stale model stays mirrored on purpose: the
    // chip must keep naming what the user chose, and the next send refuses
    // with a message pointing at it.
    if (choice.modelId !== undefined) {
      session.modelId = choice.modelId
      session.choice = modelChoice
    }
    if (choice.effort !== undefined) {
      session.reasoningEffort = aligned.effortStale ? undefined : choice.effort
    }
    // The agent's own mode is the third control in the same composer bar, so it
    // follows the same contract: a mode the agent no longer declares is skipped
    // (warning, not a failed turn) — `session/new` and `session/load` both come
    // back on whatever the agent starts with.
    if (choice.mode !== undefined) {
      const offered = session.modes?.availableModes ?? []
      if (offered.length === 0 || offered.some(mode => mode.id === choice.mode)) {
        try {
          await this.bridgeForSession(session).setMode(session, choice.mode)
        } catch (error) {
          this.hub.broadcast({
            type: 'agent/notice',
            agentId: session.agentId,
            level: 'error',
            text: `acp: failed to restore mode "${choice.mode}": ${describeError(error)}`,
          })
        }
      } else {
        this.hub.broadcast({
          type: 'agent/notice',
          agentId: session.agentId,
          level: 'error',
          text: `acp: agent "${session.agentId}" no longer offers mode "${choice.mode}"; keeping its own`,
        })
      }
    }
    // The advanced base's picks follow the same contract: apply what the agent
    // still offers, warn and skip what it dropped, never fail the turn.
    if (choice.extraConfigs !== undefined) {
      const extras = parseCatalogOptions(session.configOptions).extras ?? []
      for (const [configId, value] of Object.entries(choice.extraConfigs)) {
        const option = extras.find(entry => entry.configId === configId)
        if (option === undefined) {
          this.hub.broadcast({
            type: 'agent/notice',
            agentId: session.agentId,
            level: 'error',
            text: `acp: agent "${session.agentId}" no longer offers config "${configId}"; keeping its own`,
          })
          continue
        }
        // A toggle's truth is its boolean itself; a select's is membership in
        // the choices the agent still offers.
        const usable = option.kind === 'boolean'
          ? typeof value === 'boolean'
          : typeof value === 'string' && option.choices.some(entry => entry.value === value)
        if (!usable) {
          this.hub.broadcast({
            type: 'agent/notice',
            agentId: session.agentId,
            level: 'error',
            text: `acp: agent "${session.agentId}" no longer offers "${String(value)}" for config "${configId}"; keeping its own`,
          })
          continue
        }
        try {
          await this.bridgeForSession(session).setConfigOption(session, configId, value)
        } catch (error) {
          this.hub.broadcast({
            type: 'agent/notice',
            agentId: session.agentId,
            level: 'error',
            text: `acp: failed to restore config "${configId}" to "${value}": ${describeError(error)}`,
          })
        }
      }
    }
  }

  /**
   * Every ACP session's transcript that belongs to one DSH chat session, so the
   * conversation can render the REAL agent stream (tool calls, plans, diffs) as
   * its own view tab. Released sessions keep serving their pre-crash buffer —
   * a dead agent must not blank the history the user is reading.
   *
   * Read-only and synchronous: like `transcript`, it never spawns and never
   * resumes (a `session/load` resume is triggered by *sending*, not looking).
   */
  chatTranscripts(dshSessionId: string, afterSeq?: number): ChatTranscriptView[] {
    const views: ChatTranscriptView[] = []
    for (const session of this.dshSessionMap.values()) {
      // A closed session is destroyed, not merely unreachable: its buffered
      // transcript would be a ghost the user cannot act on.
      if (session.dshSessionId !== dshSessionId || session.closed) continue
      views.push({ session: snapshot(session), entries: session.transcript.since(afterSeq ?? 0) })
    }
    return views
  }

  /**
   * Switch one chat-bound session's ACP mode.
   *
   * A released session is deliberately NOT resumed for it (user decision,
   * 2026-10-30 — the composer's axes are "what the next turn should use", and
   * the process comes back only when the user sends a message or hits the
   * released banner's resume button). The pick is recorded and
   * `applyChatChoice` applies it on resume, exactly like `setChatSessionModel`
   * / `setChatSessionEffort` / `setChatSessionConfig`; only a LIVE session is
   * told immediately (`session/set_mode`).
   */
  async setChatSessionMode(dshSessionId: string, modeId: string, agentId?: string): Promise<void> {
    if (agentId !== undefined) {
      const lockedTo = this.lockedAgentFor(dshSessionId)
      if (lockedTo !== undefined && lockedTo !== agentId) {
        throw new AcpError('agent_locked', `acp: conversation is locked to agent "${lockedTo}" once its first turn has started`)
      }
    }
    const candidates = [...this.dshSessionMap.values()].filter(session => session.dshSessionId === dshSessionId)
    const target = agentId === undefined
      ? (candidates.find(session => !session.released) ?? candidates[0])
      : candidates.find(session => session.agentId === agentId)
    // No live session yet: this is the "choose the mode before the first
    // message" case, and the pick is recorded WITHOUT spawning anything — the
    // session that materializes later reads it back (`applyChatChoice`). This
    // matches `setChatSessionModel`, which has always recorded ahead of a
    // session; refusing here was what made the mode control unusable on a
    // conversation still being set up.
    if (target === undefined) {
      const bound = agentId ?? this.chatAgentFor(dshSessionId)
      if (bound === undefined || !this.defsMap.has(bound)) {
        throw new AcpError('unknown_session', `acp: no live ACP session is bound to chat session ${dshSessionId}`)
      }
      this.patchChatChoice(dshSessionId, { agentId: bound, mode: modeId })
      return
    }
    if (target.closed) {
      throw new AcpError('unknown_session', `acp: the ACP session bound to chat session ${dshSessionId} is closed`)
    }
    // A PARKED session gets the same record-only treatment (its agent is its
    // own `agentId`, whatever the caller passed — the selection above already
    // matched it). Resuming here was the one composer axis that broke ranks
    // with the others, and it woke a process the user had explicitly parked.
    if (target.released) {
      this.patchChatChoice(dshSessionId, { agentId: target.agentId, mode: modeId })
      if (target.modes !== undefined) {
        target.modes = { ...target.modes, currentModeId: modeId }
      }
      this.persistAgents()
      return
    }
    const bridge = this.bridgeForSession(target)
    await bridge.setMode(target, modeId)
    // Persisted only AFTER the agent accepted it: a mode the agent rejected must
    // not come back on the next restore. This is the same contract the model and
    // thought level follow (user decision, 2026-10-18 — every control in the
    // bottom bar remembers its last choice, not just the thought level).
    this.patchChatChoice(dshSessionId, { agentId: target.agentId, mode: modeId })
  }

  /**
   * Bring one chat conversation's released session back on a fresh process on
   * the USER's explicit gesture (the "恢复进程" banner) — the same work the
   * next prompt performs lazily (`getOrCreateDshSession`'s released branch),
   * minus the create path: a banner button must never materialize a session
   * the conversation has not had yet. A live target passes through untouched,
   * so a double click (or a click racing the next message) spawns nothing.
   */
  async resumeChatSession(dshSessionId: string): Promise<void> {
    const candidates = [...this.dshSessionMap.values()].filter(
      session => session.dshSessionId === dshSessionId && !session.closed,
    )
    // The session the NEXT message would use — the bound agent's — is the one
    // to bring back; the first candidate is the fallback for a conversation
    // whose binding has drifted (same selection `setChatSessionMode` makes
    // without an explicit agentId).
    const target = candidates.find(session => session.agentId === this.chatAgentFor(dshSessionId)) ?? candidates[0]
    if (target === undefined) {
      throw new AcpError('unknown_session', `acp: no ACP session is bound to chat session ${dshSessionId}`)
    }
    if (!target.released) return
    // The parked record belongs to the holder it was parked on (A1); resuming
    // on any other process would open the same session twice.
    const bridge = this.bridgeForSession(target)
    const resumed = await bridge.resumeSession(target)
    // Chat-side rebind + pick re-application, verbatim the lazy path's: the
    // freshly loaded session comes back at the agent's defaults, so the
    // conversation's model / thought level must be re-applied or the composer
    // would show one thing and the process run another (see
    // `getOrCreateDshSession`).
    resumed.dshSessionId = dshSessionId
    this.lockChatAgent(dshSessionId, target.agentId)
    if (this.chatAgentIntent.has(dshSessionId)) this.syncConversationRoute(dshSessionId)
    else routeBindingRegistry().conversations.set(dshSessionId, resumed.modelId ?? target.agentId)
    await this.applyChatChoice(resumed)
    resumed.provisionalLock = false
  }

  /**
   * Wire the harness's preset roster (`ctx.agentPresets`) into `presetStatus`.
   *
   * Optional on purpose: a deployment without the registry service has no
   * roster to report and the panel card hides itself, which is strictly better
   * than inventing a second truth about where presets come from.
   */
  setPresetRosterReader(reader?: () => Promise<readonly RosterPresetRow[] | undefined>): void {
    this.presetRosterReader = reader
  }

  /**
   * Read-only state of the ACP-mode preset in the harness's own roster.
   *
   * The preset is a declaration this package SHIPS (its own bundle patch), so
   * there is nothing to install — what the panel needs to know is whether the
   * roster carries the row and can compose a session from it. `undefined` when
   * the roster cannot be read (no registry service wired): the panel then hides
   * the block rather than claiming the preset is gone.
   */
  async presetStatus(): Promise<AcpPresetStatus | undefined> {
    const reader = this.presetRosterReader
    if (reader === undefined) return undefined
    let rows: readonly RosterPresetRow[] | undefined
    try {
      rows = await reader()
    } catch {
      // An unreadable roster is not a verdict about the preset.
      return undefined
    }
    return acpPresetStatusFromRoster(rows, ACP_PRESET_ID)
  }

  /** The installed package's version (the settings page's badge). */
  pluginVersion(): string {
    return PLUGIN_VERSION
  }

  /** Wire the built-in updater (host entry only; absent in pure tests). */
  setUpdateService(service?: UpdateService): void {
    this.updateService = service
  }

  /** Registry check for the settings card; `unsupported` when no updater is wired. */
  async pluginUpdateCheck(): Promise<PluginUpdateState> {
    return this.updateService?.check() ?? { status: 'unsupported', current: PLUGIN_VERSION }
  }

  /** Delegate one install to the host plugin manager; never touches files itself. */
  async pluginUpdateApply(version: string): Promise<PluginUpdateState> {
    return this.updateService?.apply(version) ?? { status: 'unsupported', current: PLUGIN_VERSION }
  }

  /**
   * One version's release notes for the update card's preview. Pure read: no
   * install, no registry check. `refresh` is the card's retry and skips the
   * service's cache. Without a wired updater the answer still names the
   * release page, because that URL needs no network.
   */
  async pluginReleaseNotes(version: string, refresh = false): Promise<PluginReleaseNotes> {
    return this.updateService?.releaseNotes(version, refresh)
      ?? { version, url: pluginReleaseUrl(version), source: 'none' }
  }

  /**
   * Whether any ACP work is in flight. An update install may restart the host,
   * so check/apply describe the host as busy while a turn is running.
   *
   * Segmented turn streams count even between steps (the host is still
   * continuing that turn); `running` / `settled` on a session covers `/acp`
   * turns and the window between a prompt and the agent's acknowledgement.
   */
  hasActiveTurns(): boolean {
    if (this.turnStreams.size > 0) return true
    for (const bridge of this.bridges.values()) {
      if (bridge.hasActiveTurn()) return true
    }
    return false
  }

  /**
   * The live ACP turns the save gate reports. Deduplicated by ACP session id
   * because a chat turn is indexed BOTH under its controller (segmented
   * continuation) and under the session's `running` flag.
   */
  activeTurnViews(): ActiveTurnView[] {
    const views = new Map<string, ActiveTurnView>()
    for (const controller of this.turnStreams.values()) {
      const session = controller.session
      views.set(session.sessionId, {
        sessionId: session.sessionId,
        agentId: session.agentId,
        ...(session.dshSessionId === undefined ? {} : { dshSessionId: session.dshSessionId }),
      })
    }
    for (const bridge of this.bridges.values()) {
      for (const session of bridge.sessionList) {
        if (!session.running && session.settled === undefined) continue
        views.set(session.sessionId, {
          sessionId: session.sessionId,
          agentId: session.agentId,
          ...(session.dshSessionId === undefined ? {} : { dshSessionId: session.dshSessionId }),
        })
      }
    }
    return [...views.values()]
  }

  /**
   * Wire the profile-save gate (host entry only). The gate is exposed as the
   * `acpSaveGate` Cordis service so `dsh-settings` / `dsh-hmr` can ask before
   * they write or replace the plugin; absent in pure bridge tests, where the
   * RPC surface answers "always save now".
   */
  setSaveGate(gate?: AcpSaveGate): void {
    this.saveGate = gate
  }

  /** Current gate state; the RPC/SSE surface and the settings page read it. */
  saveGateStatus(): SaveGateStatus {
    return this.saveGate?.status() ?? {
      // No gate wired: this is the same synthetic idle snapshot
      // `emptySaveGateStatus` answers, and it must not claim gate availability.
      gateAvailable: false,
      canSave: true,
      activeTurns: 0,
      activeSessions: [],
      pending: [],
      timeoutMs: DEFAULT_SAVE_GATE_TIMEOUT_MS,
    }
  }

  /**
   * Global explicit "强制保存": execute EVERY queued write now.
   *
   * This is the only caller of {@link AcpSaveGate.forceFlush}. A per-agent
   * `agent/save` with `mode: 'force'` deliberately does NOT come here: that
   * gesture was approved from one agent's dialog and may only drop that
   * agent's own held write.
   */
  async saveGateFlush(): Promise<SaveGateFlushResult> {
    return this.saveGate?.forceFlush() ?? { saved: 0, expired: 0, failed: 0 }
  }

  /** Cancel one label's held write (the settings form's "I kept editing" path). */
  saveGateCancel(label: string): number {
    return this.saveGate?.cancel(label) ?? 0
  }

  /** Re-run a failed/expired held write (the failure banner's retry gesture). */
  saveGateRetry(label: string): boolean {
    return this.saveGate?.retry(label) ?? false
  }

  /** Host query: wait bounded for the ACP plane to become idle. */
  async saveGateWaitIdle(timeoutMs?: number): Promise<boolean> {
    return this.saveGate?.waitForIdle(timeoutMs) ?? true
  }

  private getStoragePath(): string | undefined {
    if (this.configStoragePath !== undefined) return this.configStoragePath
    if (process.env.DSH_ACP_CONFIG_FILE) return process.env.DSH_ACP_CONFIG_FILE
    // The test-runner guard exists so a suite never reads or writes the real
    // home directory. An explicitly redirected state dir (tests that exercise
    // the migration, or a relocated deployment) is already hermetic, so it is
    // allowed through instead of silently disabling persistence.
    if (!stateDirExplicit() && (process.env.VITEST !== undefined || process.env.NODE_ENV === 'test')) {
      return undefined
    }
    try {
      // A legacy registry that has not been migrated yet stays readable; the
      // next persist writes to the plugin's own state dir and retires it.
      const migrated = join(pluginStateDir(), 'agents.json')
      if (!existsSync(migrated)) {
        const legacy = legacyFallback('agents')
        if (existsSync(legacy)) return legacy
      }
      mkdirSync(pluginStateDir(), { recursive: true })
      return migrated
    } catch {
      return undefined
    }
  }

  /**
   * Read the agent registry file.
   *
   * TWO shapes on purpose: version 1 was a bare array of agent definitions,
   * while `defaultAgentId` (the panel's ★ gesture — the agent an ACP-mode
   * conversation should start on) needs a home that is not the deployment
   * default model. A legacy bare array still loads; it is rewritten in the
   * current shape on the next persist.
   */
  private loadPersistedAgents(): void {
    const filePath = this.getStoragePath()
    if (!filePath || !existsSync(filePath)) return
    try {
      const content = readFileSync(filePath, 'utf-8')
      const parsed = JSON.parse(content) as unknown
      const rows = Array.isArray(parsed)
        ? parsed
        : (parsed !== null && typeof parsed === 'object' ? (parsed as { agents?: unknown }).agents : undefined)
      if (Array.isArray(rows)) {
        let rewritten = false
        for (const item of rows) {
          try {
            // `rewriteLegacyWorkspaceRoots` folds a definition that still names
            // the pre-migration workspace into the plugin's own state dir: the
            // recorded absolute cwd is fed straight to `session/new`, and the
            // cwd resolver rejects one that does not exist.
            const validated = validateAgentDef(quoteLegacyCommand(item))
            const def = rewriteLegacyWorkspaceRoots(validated)
            if (def !== validated) rewritten = true
            this.defsMap.set(def.id, def)
          } catch {
            // Ignore invalid entry
          }
        }
        // Write the corrected paths back. Without this the correction lives
        // only in memory: the directory was already renamed, so the file on
        // disk keeps naming a cwd that no longer exists, and every boot has to
        // repair it again (and anything reading the file directly sees the
        // stale path).
        if (rewritten) this.persistAgents()
      }
      if (!Array.isArray(parsed) && parsed !== null && typeof parsed === 'object') {
        const stored = (parsed as { defaultAgentId?: unknown }).defaultAgentId
        // Kept as-is (even when it names an agent this boot did not load):
        // `defaultAgent()` is the accessor that filters a stale id out, so a
        // temporarily unreadable agent list cannot silently erase the choice.
        if (typeof stored === 'string' && stored !== '') this.defaultAgentId = stored
        // The halo preference is validated on write, but the file is user- or
        // version-editable: an unreadable value falls back to the default
        // rather than poisoning every read.
        try {
          this.tagHaloSetting = validateTagHalo((parsed as { tagHalo?: unknown }).tagHalo)
        } catch {
          this.tagHaloSetting = { ...DEFAULT_TAG_HALO }
        }
        // The settings page's title-prefix toggle. Written only as a boolean;
        // an explicit boolean is honored as-is, while a missing or hand-edited
        // non-boolean falls back to the default — the same user-editable-file
        // rule the halo preference hydrates by.
        const storedTitlePrefix = (parsed as { sessionTitlePrefix?: unknown }).sessionTitlePrefix
        this.sessionTitlePrefixEnabled =
          typeof storedTitlePrefix === 'boolean' ? storedTitlePrefix : DEFAULT_SESSION_TITLE_PREFIX
        // The settings page's approval-deadline override. Re-validated on every
        // boot because the state file is user- and version-editable: an
        // unreadable value must not poison the deadline, and a value the
        // validator accepts must be the value that runs (a UI write that did
        // not survive a restart would read as a broken setting).
        try {
          const raw = (parsed as { approvalDeadlines?: unknown }).approvalDeadlines ?? {}
          // The OLD card wrote the two legacy windows, and its 「关」 preset
          // wrote a zero — which then meant "this window never fires". The only
          // way to say that now is the `wait` MODE (a zero means 不等待 today),
          // so a legacy zero carries over as the mode instead of silently
          // turning "wait forever" into "answer immediately".
          const legacy = raw as { nativeApprovalTimeoutMs?: unknown; permissionFallbackTimeoutMs?: unknown }
          const legacyWindow = legacy.nativeApprovalTimeoutMs ?? legacy.permissionFallbackTimeoutMs
          const legacyNever = legacyWindow === 0
          const window = legacyNever
            ? undefined
            : validateApprovalDeadlines(raw).permissionTimeoutMs
          const mode = legacyNever
            ? ('wait' as const)
            : ((raw as { mode?: unknown }).mode === undefined
              ? undefined
              : validatePermissionTimeoutMode((raw as { mode?: unknown }).mode, 'bad_payload'))
          // The stored window is the user's RAW pick and is read back as-is:
          // 不等待 (0) belongs to `auto`, and the floor under `abort` is applied
          // at RUNTIME only (`applyDeadlineTuning`). Rewriting it here would
          // make a restart itself change what the user chose, and a later
          // switch back to `auto` could never recover the zero.
          this.deadlineOverride = {
            ...(window === undefined ? {} : { permissionTimeoutMs: window }),
            ...(mode === undefined ? {} : { mode }),
          }
        } catch {
          this.deadlineOverride = {}
        }
        // The settings page's idle-release pick. Re-validated on every boot
        // because the state file is user- and version-editable: an
        // unreadable value must not poison the window, and a value the
        // validator accepts must be the value that runs.
        try {
          const raw = (parsed as { idleRelease?: unknown }).idleRelease
          const value = (raw as { idleTimeoutMs?: unknown } | undefined)?.idleTimeoutMs
          this.idleReleaseOverride = typeof value === 'number' && IDLE_RELEASE_MS.includes(value)
            ? value
            : undefined
        } catch {
          this.idleReleaseOverride = undefined
        }
        this.loadPersistedChoices((parsed as { conversations?: unknown }).conversations)
        this.loadPersistedChatSessions((parsed as { chatSessions?: unknown }).chatSessions)
        this.loadPersistedSubagents((parsed as { subagents?: unknown }).subagents)
      }
    } catch {
      // Storage load failure is non-fatal
    }
  }

  /**
   * Read the per-conversation picks back. Tolerant on purpose, one row at a
   * time: a single corrupt entry must not cost the user every other
   * conversation's set-up. Entries are kept even when the named agent is not
   * configured on this boot — `chatChoice` filters those out, so a temporarily
   * missing agent does not erase the choice it was made for.
   */
  private loadPersistedChoices(raw: unknown): void {
    if (raw === null || typeof raw !== 'object') return
    for (const [dshSessionId, row] of Object.entries(raw as Record<string, unknown>)) {
      if (dshSessionId === '' || row === null || typeof row !== 'object') continue
      const { agentId, locked, modelId, effort, mode, extraConfigs } = row as {
        agentId?: unknown; locked?: unknown; modelId?: unknown; effort?: unknown; mode?: unknown; extraConfigs?: unknown
      }
      if (typeof agentId !== 'string' || agentId === '') continue
      const configs = extraConfigs !== null && typeof extraConfigs === 'object' && !Array.isArray(extraConfigs)
        ? Object.fromEntries(Object.entries(extraConfigs as Record<string, unknown>)
          .filter(([, value]) => typeof value === 'boolean' || (typeof value === 'string' && value !== ''))) as Record<string, string | boolean>
        : {}
      this.chatAgentIntent.set(dshSessionId, {
        agentId,
        ...(locked === true ? { locked: true } : {}),
        ...(typeof modelId === 'string' && modelId !== '' ? { modelId } : {}),
        ...(typeof effort === 'string' && effort !== '' ? { effort } : {}),
        ...(typeof mode === 'string' && mode !== '' ? { mode } : {}),
        ...(Object.keys(configs).length === 0 ? {} : { extraConfigs: configs }),
      })
    }
    // Put every restored record back on the REQUEST path, not just in this
    // map: the guard's rewrite and `conversationRouteModel` read the route
    // registry, which starts empty on a fresh process. Without this a host
    // restart would send a bound (and possibly locked) conversation to the
    // deployment default until its next turn re-pinned it.
    for (const dshSessionId of this.chatAgentIntent.keys()) this.syncConversationRoute(dshSessionId)
  }

  /**
   * Fold one settled ACP turn's measurable burst into the session aggregate and
   * persist it. A turn with no measured inter-chunk gap contributes neither
   * side: adding its tokens with zero time would inflate the session rate.
   */
  noteSessionBurst(session: LiveSession, outputTokens: number, burstMs: number): void {
    if (outputTokens <= 0 || burstMs <= 0) return
    const base = session.burst ?? { outputTokens: 0, burstMs: 0 }
    session.burst = {
      outputTokens: base.outputTokens + outputTokens,
      burstMs: base.burstMs + burstMs,
    }
    this.persistAgents()
  }

  /**
   * Write the agent registry.
   *
   * `strict` is for a save whose success the user is waiting on: a failed write
   * must reach the save gate as a rejection instead of a silent "saved". All
   * other call sites keep the old best-effort behavior, but the failure is no
   * longer invisible — it lands in the settings log as one notice per distinct
   * error (a burst of session writes can retry the same broken path).
   */
  private persistAgents(strict = false, staged?: AcpAgentDef): void {
    const filePath = this.getStoragePath()
    if (!filePath) {
      // A strict save has nowhere to write. Silent success here would tell the
      // user the definition survived when the next boot would not load it.
      if (strict) throw new AcpError('persist_failed', 'acp: failed to persist agent state: no writable state path')
      return
    }
    try {
      // The chat-bound session records themselves: a host restart kills the
      // processes but not the agent-side sessions, so restoring these as
      // PARKED keeps a conversation resumable (`session/load`) instead of
      // its next message silently starting a context-less new one.
      const chatSessions = [...this.dshSessionMap.values()]
        .filter(session => session.dshSessionId !== undefined && !session.closed)
        .map(persistedChatSession)
      // A save passes its candidate here so the file can land BEFORE `defsMap`
      // commits it. Every other caller writes the committed registry.
      const agents = [...this.defsMap.values()]
      if (staged !== undefined) {
        const index = agents.findIndex(agent => agent.id === staged.id)
        if (index >= 0) agents[index] = staged
        else agents.push(staged)
      }
      const payload = {
        version: 2,
        ...(this.defaultAgentId === undefined ? {} : { defaultAgentId: this.defaultAgentId }),
        tagHalo: this.tagHaloSetting,
        sessionTitlePrefix: this.sessionTitlePrefixEnabled,
        agents,
        // The settings page's approval deadlines. Absent while none was ever
        // written, so a fresh deployment's state file stays exactly as it was.
        ...(Object.keys(this.deadlineOverride).length === 0
          ? {}
          : { approvalDeadlines: { ...this.deadlineOverride } }),
        // The settings page's idle-release pick. Absent while none was
        // ever written, so a fresh deployment's state file stays as it was.
        ...(this.idleReleaseOverride === undefined
          ? {}
          : { idleRelease: { idleTimeoutMs: this.idleReleaseOverride } }),
        // The per-conversation picks: agent + model + thought level + mode +
        // extra config values chosen in the composer, including for
        // conversations with no live session yet.
        ...(this.chatAgentIntent.size === 0
          ? {}
          : { conversations: Object.fromEntries(this.chatAgentIntent) }),
        // The plugin's own external-worker lifecycle records (status / failure
        // reason / timings). Absent while none was ever recorded, so a fresh
        // deployment's state file stays exactly as it was.
        ...(this.subagentRecords.size === 0
          ? {}
          : { subagents: Object.fromEntries(this.subagentRecords) }),
        ...(chatSessions.length === 0 ? {} : { chatSessions }),
      }
      writeFileSync(filePath, JSON.stringify(payload, null, 2), 'utf-8')
      this.lastPersistFailure = undefined
    } catch (error) {
      const message = describeError(error)
      if (strict) throw new AcpError('persist_failed', `acp: failed to persist agent state: ${message}`)
      if (this.lastPersistFailure === message) return
      this.lastPersistFailure = message
      this.hub.broadcast({
        type: 'agent/notice',
        agentId: 'dsh-ntr',
        level: 'error',
        text: `acp: failed to persist agent state: ${message}`,
      })
    }
  }

  /**
   * Restore chat session records from disk as PARKED sessions.
   *
   * Every process died with the host, so nothing comes back live — but the
   * agent-side sessions did not. Restoring each record as `released` is what
   * makes the released banner, its resume button and the "next message
   * resumes it" promise survive a restart (the alternative is the next
   * message quietly starting a NEW, context-less session — constraint 10's
   * "released ≠ destroyed" lost at the process boundary). Tolerant, one row
   * at a time: a single corrupt entry must not cost every other conversation
   * its context. Records whose agent is no longer configured are dropped —
   * there is nothing to resume ON, and the next write omits them.
   */
  private loadPersistedChatSessions(raw: unknown): void {
    if (!Array.isArray(raw)) return
    for (const row of raw) {
      if (row === null || typeof row !== 'object') continue
      const record = row as Record<string, unknown>
      const { sessionId, acpSessionId, agentId, dshSessionId, cwd } = record
      if (typeof sessionId !== 'string' || sessionId === '') continue
      if (typeof acpSessionId !== 'string' || acpSessionId === '') continue
      if (typeof agentId !== 'string' || agentId === '') continue
      if (typeof dshSessionId !== 'string' || dshSessionId === '') continue
      if (typeof cwd !== 'string') continue
      if (!this.defsMap.has(agentId)) continue
      const { title, modelId, reasoningEffort, modes, usage, burst, hasHistory } = record as {
        title?: unknown; modelId?: unknown; reasoningEffort?: unknown; modes?: unknown; usage?: unknown; burst?: unknown; hasHistory?: unknown
      }
      const session: LiveSession = {
        sessionId,
        acpSessionId,
        agentId,
        dshSessionId,
        cwd,
        ...(typeof title === 'string' && title !== '' ? { title } : {}),
        ...(typeof modelId === 'string' && modelId !== ''
          ? { modelId, ...(splitAdapterModelId(modelId).choice === undefined ? {} : { choice: splitAdapterModelId(modelId).choice }) }
          : {}),
        ...(typeof reasoningEffort === 'string' && reasoningEffort !== '' ? { reasoningEffort } : {}),
        ...(isPersistedModes(modes) ? { modes } : {}),
        ...(isPersistedUsage(usage) ? { usage } : {}),
        ...(isPersistedBurst(burst) ? { burst } : {}),
        ...(hasHistory === true ? { hasHistory: true } : {}),
        running: false,
        turnSeq: 0,
        closed: false,
        released: true,
        lastAgentActivityAt: Date.now(),
        activeToolCalls: new Set<string>(),
        transcript: new Transcript(this.transcriptMax),
      }
      this.dshSessionMap.set(`${dshSessionId}:${agentId}`, session)
      // A1: the record parks on the holder its own DSH conversation will
      // resume through — the same scope the create branch would pick — so the
      // first message after a restart reaches the process that can `session/load`
      // it, not the agent-wide slot. Creating the holder is pure bookkeeping.
      this.bridgeFor(agentId, { kind: 'chat', dshSessionId }).parkReleased(session)
    }
  }

  /**
   * Read the persisted external-worker records back.
   *
   * Orphan keys are dropped AT LOAD, not on every write: only a conversation
   * that still has a `chatSessions` row or a persisted `conversations` entry
   * can own records. Everything else names a conversation the file no longer
   * describes (deleted, or written before a pruning close), and keeping it
   * would only make `agents.json` grow. Shutdown relies on the map staying
   * populated, which is why the prune lives here and not in `persistAgents`.
   *
   * A restored row that never reached a terminal state reads `unknown`: the
   * host restart killed every process, so nothing can still be running
   * (constraint: no row stays `running` forever).
   */
  private loadPersistedSubagents(raw: unknown): void {
    this.subagentRecords.clear()
    if (raw === undefined) return
    const keep = new Set<string>()
    for (const session of this.dshSessionMap.values()) {
      if (session.dshSessionId !== undefined && !session.closed) keep.add(session.dshSessionId)
    }
    for (const dshSessionId of this.chatAgentIntent.keys()) keep.add(dshSessionId)
    for (const [dshSessionId, records] of Object.entries(normalizeSubagentRecordMap(raw, keep))) {
      this.subagentRecords.set(dshSessionId, records)
    }
  }

  // ---- Model catalog ----

  private readonly catalogs = new Map<string, { catalog: AcpAgentCatalog; updatedAt: number }>()
  /**
   * Each agent's LAST KNOWN `sessionCapabilities.fork` bit, persisted with the
   * model catalog. A live `initialize` result outranks it whenever one exists
   * (see {@link canForkNow}) — this copy answers when the process is gone
   * (a released session's branch button must not flash into "supported" just
   * because `initResult` died with it, nor read `view().agentCapabilities`,
   * which a release clears).
   */
  private readonly forkCaps = new Map<string, boolean>()
  /**
   * The slash commands each agent declared in its most recent session, cached
   * per agent and persisted alongside the model catalog.
   *
   * This is what makes `/` list an agent's commands in a conversation that has
   * not sent its first message yet: before `session/new` there is no live
   * session to ask, and the native menu's immediacy is the bar. A live
   * session's own declaration always outranks this cache. It is learned, never
   * probed — a `session/new` for a menu would spawn an agent (constraint 8).
   */
  private readonly commandCache = new Map<string, { commands: NonNullable<SessionView['availableCommands']>; updatedAt: number }>()
  /**
   * Catalog schema the persisted file was written with. Bumped when a parser
   * gains a category, so a cache written by an older build is KNOWN to be
   * incomplete — a persisted `{model, thought}` catalog from v1 would otherwise
   * keep an agent looking like it has no `mode` axis forever.
   *
   * A stale entry is still SERVED (dropping it would blank the seats across an
   * upgrade) and is repaired for free the next time that agent's own session
   * publishes `configOptions` (`absorbCatalog`). It is NOT re-probed at boot:
   * a probe spawns a process, and starting agents nobody is talking to is the
   * defect this marker used to cause (user report, 2026-10-18).
   *
   * v2 = `mode` (`category: 'mode'`) joined `model` / `thought_level`.
   * v3 = every other select joined as `extras` (the composer's advanced base).
   */
  private static readonly CATALOG_SCHEMA = 3
  /** Agents whose persisted catalog predates {@link CATALOG_SCHEMA}. */
  private readonly catalogStale = new Set<string>()
  /** Auto-spawning probes are suppressed under test runners so suites stay deterministic. */
  private readonly autoProbeEnabled = process.env.VITEST === undefined && process.env.NODE_ENV !== 'test'

  private getCatalogStoragePath(): string | undefined {
    if (this.catalogStoragePath !== undefined) return this.catalogStoragePath
    if (process.env.DSH_ACP_CATALOG_FILE) return process.env.DSH_ACP_CATALOG_FILE
    if (!stateDirExplicit() && (process.env.VITEST !== undefined || process.env.NODE_ENV === 'test')) {
      return undefined
    }
    try {
      const migrated = join(pluginStateDir(), 'model-catalog.json')
      if (!existsSync(migrated)) {
        const legacy = legacyFallback('catalog')
        if (existsSync(legacy)) return legacy
      }
      mkdirSync(pluginStateDir(), { recursive: true })
      return migrated
    } catch {
      return undefined
    }
  }

  private loadPersistedCatalogs(): void {
    const filePath = this.getCatalogStoragePath()
    if (!filePath || !existsSync(filePath)) return
    try {
      const parsed = JSON.parse(readFileSync(filePath, 'utf-8')) as Record<string, unknown>
      const agents = parsed.agents
      if (typeof agents !== 'object' || agents === null) return
      // A cache written by an older build answers with a PARTIAL surface: it may
      // predate a category entirely. It is still served (dropping it would blank
      // the seats across the upgrade) and marked stale; `absorbCatalog` repairs
      // it for free the next time that agent's own session publishes its
      // options. No probe is spawned here on purpose — see `CATALOG_SCHEMA`.
      const stale = parsed.version !== BridgeManager.CATALOG_SCHEMA
      for (const [agentId, raw] of Object.entries(agents)) {
        if (typeof raw !== 'object' || raw === null) continue
        const row = raw as { catalog?: unknown; updatedAt?: unknown; commands?: unknown; commandsUpdatedAt?: unknown; fork?: unknown }
        // The persisted fork capability: a LAST KNOWN bit, loaded before any
        // bridge can report a fresh one (a fresh `initialize` overwrites it).
        if (typeof row.fork === 'boolean') this.forkCaps.set(agentId, row.fork)
        // Commands and the model catalog are learned independently (a session
        // may declare one before the other), so either half alone is a valid row.
        if (Array.isArray(row.commands)) {
          this.commandCache.set(agentId, {
            commands: row.commands as NonNullable<SessionView['availableCommands']>,
            updatedAt: typeof row.commandsUpdatedAt === 'number' ? row.commandsUpdatedAt : 0,
          })
        }
        if (typeof row.catalog !== 'object' || row.catalog === null) continue
        this.catalogs.set(agentId, {
          catalog: row.catalog as AcpAgentCatalog,
          updatedAt: typeof row.updatedAt === 'number' ? row.updatedAt : 0,
        })
        if (stale) this.catalogStale.add(agentId)
      }
    } catch {
      // Storage load failure is non-fatal
    }
  }

  private persistCatalogs(): void {
    const filePath = this.getCatalogStoragePath()
    if (!filePath) return
    try {
      const agents: Record<string, {
        catalog?: AcpAgentCatalog
        updatedAt?: number
        commands?: NonNullable<SessionView['availableCommands']>
        commandsUpdatedAt?: number
        fork?: boolean
      }> = {}
      for (const [agentId, entry] of this.catalogs) agents[agentId] = { catalog: entry.catalog, updatedAt: entry.updatedAt }
      for (const [agentId, entry] of this.commandCache) {
        agents[agentId] = { ...(agents[agentId] ?? {}), commands: entry.commands, commandsUpdatedAt: entry.updatedAt }
      }
      // The LAST KNOWN fork capability rides the same file: it outlives the
      // agent process, which is exactly when the browser needs it (see
      // `canForkNow`).
      for (const [agentId, supported] of this.forkCaps) {
        agents[agentId] = { ...(agents[agentId] ?? {}), fork: supported }
      }
      writeFileSync(filePath, JSON.stringify({ version: BridgeManager.CATALOG_SCHEMA, agents }, null, 2), 'utf-8')
    } catch {
      // Storage persist failure is non-fatal
    }
  }

  /**
   * Merge `configOptions` observed on any real session into the agent's catalog.
   *
   * This is the SECOND way a catalog gets refreshed (the first being an explicit
   * `probeAgentModels`), and the only one that happens for free: it rides a
   * session the user is already running. It therefore also discharges the
   * {@link CATALOG_SCHEMA} staleness mark — whatever an older parser missed, the
   * current `parseCatalogOptions` has now seen this agent's real answer.
   */
  private absorbCatalog(agentId: string, configOptions: unknown): { catalog: AcpAgentCatalog; updatedAt: number } {
    // A probe or session observation can outlive the agent it belongs to. The
    // delete already dropped this id's catalog, so writing it back here would
    // resurrect a ghost entry in `model-catalog.json` across a host restart.
    if (!this.defsMap.has(agentId) || this.isAgentDeleted(agentId)) {
      return this.catalogs.get(agentId) ?? { catalog: {}, updatedAt: 0 }
    }
    // Empty / absurd answers never overwrite known state — see `usableConfigOptions`.
    if (!usableConfigOptions(configOptions)) return this.catalogs.get(agentId) ?? { catalog: {}, updatedAt: 0 }
    const catalog = parseCatalogOptions(configOptions)
    this.catalogStale.delete(agentId)
    const existing = this.catalogs.get(agentId)
    // Auto-discovery compares this observation against the catalog known
    // BEFORE it. The first observation is only a baseline — nothing is "new"
    // yet, and calling every choice of a 500-model catalog "new" would flood
    // the selection the switch is meant to keep tidy.
    const exposedChanged = this.autoExposeNewModels(agentId, catalog, existing?.catalog)
    if (existing !== undefined && JSON.stringify(existing.catalog) === JSON.stringify(catalog)) {
      if (exposedChanged) this.broadcastExposure(agentId)
      return existing
    }
    const entry = { catalog, updatedAt: Date.now() }
    this.catalogs.set(agentId, entry)
    this.persistCatalogs()
    // The browser caches the seat surface per agent and only re-reads it when
    // it is told to. A catalog learned from a REAL session is exactly the
    // moment a conversation that was opened before that session needs the new
    // list (first-turn convergence); probing it again would spawn a process.
    this.hub.broadcast({ type: 'catalog/updated', agentId, updatedAt: entry.updatedAt })
    // After the catalog lands, so a re-read triggered by this frame already
    // sees the new models in `agent/catalog`'s variant expansion.
    if (exposedChanged) this.broadcastExposure(agentId)
    return entry
  }

  /**
   * Fold a per-session option answer's SHAPE into the agent's catalog.
   *
   * The counterpart of {@link absorbCatalog} for `session/set_config_option`
   * responses: which options exist and which choices they offer is agent
   * knowledge the seat must show (the composer's thought chip only renders
   * when the catalog has `thought_level`, and some agents publish it only in
   * the answer to a model change), while a per-session `currentValue` stays
   * out of it. No auto-exposure and no staleness discharge either — this is
   * one session's answer, not the agent-level observation those marks track.
   */
  private absorbCatalogShape(agentId: string, configOptions: unknown): void {
    // Same late-observation guard as `absorbCatalog`: a deleted agent's id must
    // never come back into the catalog file through a session answer.
    if (!this.defsMap.has(agentId) || this.isAgentDeleted(agentId)) return
    if (!usableConfigOptions(configOptions)) return
    const observed = parseCatalogOptions(configOptions)
    const existing = this.catalogs.get(agentId)
    const catalog = mergeCatalogShape(existing?.catalog, observed)
    if (existing !== undefined && JSON.stringify(existing.catalog) === JSON.stringify(catalog)) return
    const entry = { catalog, updatedAt: Date.now() }
    this.catalogs.set(agentId, entry)
    this.persistCatalogs()
    this.hub.broadcast({ type: 'catalog/updated', agentId, updatedAt: entry.updatedAt })
  }

  /**
   * Remember the slash commands an agent declared in a real session.
   *
   * Unlike {@link absorbCatalog} this does NOT feed a model surface — it keeps
   * the agent's `/` menu populated before the next conversation has a session
   * of its own. The live session's declaration is still the authority; this is
   * only what a fresh conversation has to draw from.
   *
   * Deduped on content: agents restate their list freely, and a broadcast per
   * restatement would make every open composer re-read `agent/catalog`.
   */
  private absorbCommands(agentId: string, commands: NonNullable<SessionView['availableCommands']>): void {
    const existing = this.commandCache.get(agentId)
    if (existing !== undefined && JSON.stringify(existing.commands) === JSON.stringify(commands)) return
    const entry = { commands, updatedAt: Date.now() }
    this.commandCache.set(agentId, entry)
    this.persistCatalogs()
    // Same signal as a model catalog learned from a real session: the browser
    // caches `agent/catalog` per agent and re-reads it only when told to. A
    // conversation opened before this session needs the new list for its very
    // first `/`, when there is still no live session to ask.
    this.hub.broadcast({ type: 'catalog/updated', agentId, updatedAt: entry.updatedAt })
  }

  /**
   * Record a fresh `initialize`'s `sessionCapabilities.fork` verdict (the
   * bridge reports it right after the handshake). Persisted with the model
   * catalog; no broadcast — the browser learns it through `session/chat-list`
   * rows, and its branch button deliberately runs on a last-known basis (the
   * agent's own next `initialize` is the refresh).
   */
  private noteForkCapability(agentId: string, supported: boolean): void {
    // A1 (F2): one process per conversation means there is no shared
    // connection to fork on, so the capability is permanently OFF whatever the
    // agent's handshake says. Persisting `false` also overwrites a `true`
    // cached by an earlier single-process generation.
    const verdict = isPerSessionAgent(agentId) ? false : supported
    if (this.forkCaps.get(agentId) === verdict) return
    this.forkCaps.set(agentId, verdict)
    this.persistCatalogs()
  }

  /**
   * Whether an agent's fork can be attempted RIGHT NOW: a live `initialize`
   * answer wins (the process is up, its handshake is current); only when the
   * process is gone does the LAST KNOWN persisted bit answer. `false` covers
   * "never seen" — an unknown agent simply never gets a fork attempt.
   */
  private canForkNow(agentId: string): boolean {
    // A1 (F2): hard-disabled. A per-session child serves ONE conversation, so
    // there is no connection-scoped parent/child pair to fork.
    if (isPerSessionAgent(agentId)) return false
    const bridge = this.bridges.get(agentId)
    if (bridge?.initResult !== undefined) {
      return bridge.initResult.agentCapabilities?.sessionCapabilities?.fork != null
    }
    return this.forkCaps.get(agentId) === true
  }

  /**
   * Append models this observation newly introduced to the agent's selection.
   *
   * "Newly introduced" means present in `next` but absent from the catalog
   * known `before` — NOT "absent from the selection". Comparing against the
   * selection would resurrect a model the user deliberately unchecked every
   * time the agent repeats its catalog. The first observation has no baseline
   * (`before === undefined`), so it adds nothing; the user can still add the
   * whole list with one click in the settings card. Discovery is ON unless the
   * agent definition explicitly opts out with `autoDiscoverModels: false`.
   */
  private autoExposeNewModels(agentId: string, next: AcpAgentCatalog, before: AcpAgentCatalog | undefined): boolean {
    const def = this.defsMap.get(agentId)
    if (def === undefined || def.autoDiscoverModels === false || before === undefined) return false
    // A different model-slot identity is a corrected reading, not newly added
    // models. Diffing across it would expose an entire real catalog the first
    // time a parser fix replaces a mislabelled slot (Qoder CN).
    if (before.model !== undefined && next.model !== undefined && before.model.configId !== next.model.configId) return false
    const known = new Set((before.model?.choices ?? []).map(choice => choice.value))
    const exposed = new Set(def.exposedModels ?? [])
    const added = (next.model?.choices ?? [])
      .map(choice => choice.value)
      .filter(value => !known.has(value) && !exposed.has(value))
    if (added.length === 0) return false
    def.exposedModels = [...(def.exposedModels ?? []), ...added]
    this.persistAgents()
    return true
  }

  /** Tell the browser an agent's model-visibility surface changed outside `agent/save`. */
  private broadcastExposure(agentId: string): void {
    const def = this.defsMap.get(agentId)
    if (def === undefined) return
    this.hub.broadcast({
      type: 'agent/exposure',
      agentId,
      exposedModels: [...(def.exposedModels ?? [])],
      autoDiscoverModels: def.autoDiscoverModels !== false,
    })
  }

  catalogFor(agentId: string): AcpAgentCatalog | undefined {
    return this.catalogs.get(agentId)?.catalog
  }

  /**
   * The settings panel's PERSISTENT catalog read: the last catalog observed for
   * one agent, or `undefined` when it has never published one.
   *
   * Pure memory (the same map `agentCatalog` reads, hydrated from
   * `model-catalog.json` at boot), so opening the settings page costs no agent
   * process. This is what lets the model panes show the configured selection
   * and the last known model list on mount instead of staying blank until
   * someone clicks 「检测可用模型」 — that button is a REFRESH of this cache
   * (models the agent newly publishes appear, models it stopped advertising
   * drop out), not the price of admission.
   */
  cachedAgentModels(agentId: string): AgentProbeModelsResult | undefined {
    const entry = this.catalogs.get(agentId)
    if (entry === undefined) return undefined
    return { agentId, catalog: entry.catalog, updatedAt: entry.updatedAt }
  }

  /**
   * Probe one agent right now: spawn (if needed), open a throwaway session,
   * read its `configOptions`, close it. Errors propagate to the caller (the
   * RPC result or a notice broadcast).
   */
  async probeAgentModels(agentId: string): Promise<AgentProbeModelsResult> {
    // Never spawn for an id the registry no longer owns. `absorbCatalog` also
    // guards the write, because a delete can land while this probe is awaited.
    if (!this.defsMap.has(agentId) || this.isAgentDeleted(agentId)) {
      throw new AcpError('unknown_agent', `acp: agent "${agentId}" is not configured`)
    }
    const bridge = this.bridgeFor(agentId, { kind: 'probe' })
    try {
      const configOptions = await bridge.probeConfigOptions()
      const entry = this.absorbCatalog(agentId, configOptions)
      // A fresh probe answers in the CURRENT schema by construction.
      this.catalogStale.delete(agentId)
      return { agentId, catalog: entry.catalog, updatedAt: entry.updatedAt }
    } finally {
      // A probe child exists ONLY for this call: it must not linger (and must
      // never be a chat session's process — the `probe` scope guarantees that
      // for A1, while a non-per-session agent folds it onto its single slot and
      // `pruneBridge` deliberately leaves that alone). Dropping the holder
      // stops the child; see `pruneBridge`.
      this.pruneBridge(bridgeKey(agentId, { kind: 'probe' }))
    }
  }

  /**
   * Boot-time catalog warm-up.
   *
   * DELIBERATELY DOES NOTHING (user report, 2026-10-18: an unbound conversation
   * showed "Oh My Pi 已连接" in the agent picker, i.e. a second agent process was
   * running for a conversation served by another one).
   *
   * A probe SPAWNS A PROCESS. That is only defensible for an agent the user is
   * actually engaging with, so every probe now has a gesture behind it:
   *
   *  - a conversation bound to that agent → its first `session/new` fills the
   *    catalog in via `absorbCatalog` (that is the agent the user is talking to,
   *    already running);
   *  - the settings card's own button → `agent/probe-models`, one explicit click
   *    on one agent;
   *  - a STALE on-disk entry → repaired by `absorbCatalog` the next time that
   *    agent's own session publishes its options, not at boot.
   *
   * Probing every configured agent at startup — which is what this did — turns
   * "open the app" into "start N agent processes", and the picker then honestly
   * reports them as connected, which is exactly the confusion reported.
   */
  bootstrapCatalogs(): void {
    // Intentionally empty; kept as the boot hook's name so the host entry does
    // not have to change, and so the rule lives where the call is.
  }

  /**
   * The ACP model surface for ONE agent — the seats' own list (see
   * `AgentCatalogResult`). This is what the chat composer's ACP cluster and the
   * ACP-mode model seat render; DSH's native selector has no ACP entries at all
   * (`AcpLlmAdapter.listModels` advertises nothing), because the host builds one
   * global provider catalog with no per-session seam and every session would
   * then be offered ACP agents as if they were just another model.
   *
   * Variants are opt-in: an agent with no `exposedModels` (or an empty list)
   * offers only its base entry. Offering the whole catalog by default is not a
   * feature — these menus have no search, and a real agent publishes hundreds
   * of choices (pi: 500, omp: 581), so "everything by default" is a list storm
   * the user cannot navigate. The base entry is never filtered out.
   *
   * Pure memory — NEVER spawns and NEVER starts a probe. This is a RENDER path:
   * the composer entries call it on every store change, so anything that spawns
   * here turns "open a conversation" into "start every agent" (user report,
   * 2026-10-18: a conversation served by `codebuddy` had `omp` running). A
   * missing or stale catalog is reported honestly (`probed: false`, or the stale
   * entry's contents), and the probe is started by an explicit gesture:
   * `agent/probe-models` (the settings card's button) or a session's own
   * `session/new`, both of which are about ONE agent the user is actually using.
   */
  agentCatalog(agentId: string): AgentCatalogResult {
    const def = this.defsMap.get(agentId)
    if (def === undefined) throw new AcpError('unknown_agent', `acp: agent "${agentId}" is not configured`)
    const title = def.title ?? def.id
    const entry = this.catalogs.get(agentId)
    // NO `ensureCatalog` HERE — see the note above. Reading must stay pure
    // memory, even for a stale or absent entry.
    const exposed = def.exposedModels
    const variants: AgentCatalogResult['variants'] = []
    for (const choice of entry?.catalog.model?.choices ?? []) {
      if (exposed === undefined || !exposed.includes(choice.value)) continue
      variants.push({
        id: buildAdapterModelId(def.id, choice.value),
        // The MODEL name alone, not `<agent> · <model>`: the picker already
        // groups these under "<agent>'s models", and the composer chip sits next
        // to the agent chip, so repeating the agent name in every row was noise
        // on top of noise (user report, 2026-10-18).
        name: choice.name,
        ...(choice.description !== undefined ? { description: choice.description } : {}),
      })
    }
    const reasoning = this.reasoningMeta(agentId)
    const modelOption = entry?.catalog.model
    // The model the agent reports it is ON (its `model.currentValue`, refreshed
    // every time a session publishes `configOptions`). This is what the base
    // entry NAMES: `base` is the bare `agentId` route ("let the agent choose"),
    // and the honest way to describe that route is by the model it actually
    // resolves to — "CodeBuddy Code · Hy3", not just "CodeBuddy Code". Without
    // the model name the checked row in the picker said nothing about which
    // model it was (user report, 2026-10-18).
    //
    // An agent can also sit on a model it no longer offers (or report a value it
    // forgot to list): report it with the raw value as its name rather than
    // dropping it — dropping it is what removes the model chip entirely.
    const currentModelValue = modelOption?.currentValue ?? null
    const currentModelChoice = currentModelValue === null
      ? undefined
      : modelOption?.choices.find(choice => choice.value === currentModelValue)
        ?? { value: currentModelValue, name: currentModelValue }
    const baseName = currentModelChoice === undefined
      ? title
      : `${title} · ${currentModelChoice.name}`
    const modeOption = entry?.catalog.mode
    const extraOptions = entry?.catalog.extras ?? []
    const commands = this.commandCache.get(agentId)
    return {
      agentId: def.id,
      title,
      base: {
        id: def.id,
        name: baseName,
        description: `ACP Agent: ${def.command} ${(def.args ?? []).join(' ')}`.trim(),
      },
      variants,
      probed: entry !== undefined,
      ...(reasoning !== undefined ? { reasoning } : {}),
      // The agent's OWN current model, so the model chip has something to show
      // before this conversation has picked one. Absent when the agent publishes
      // no model selector at all — then there really is no model axis.
      ...(currentModelChoice === undefined ? {} : {
        currentModel: {
          value: currentModelChoice.value,
          name: currentModelChoice.name,
          ...(currentModelChoice.description === undefined ? {} : { description: currentModelChoice.description }),
        },
      }),
      // Same reason, for the mode select: before `session/new` there is no live
      // session to read `modes` from, and the control would silently vanish on a
      // conversation the user is still setting up.
      ...(modeOption === undefined ? {} : {
        mode: {
          ...(modeOption.currentValue === null ? {} : { currentValue: modeOption.currentValue }),
          choices: modeOption.choices.map(choice => ({
            id: choice.value,
            name: choice.name,
            ...(choice.description === undefined ? {} : { description: choice.description }),
          })),
        },
      }),
      // The advanced base's content: every select without a dedicated control.
      // The browser overlays the conversation's `extraConfigs` on these current
      // values, so a pick made before the first session still shows as chosen.
      ...(extraOptions.length === 0 ? {} : {
        extras: extraOptions.map(option => ({
          configId: option.configId,
          name: option.name,
          ...(option.kind === 'boolean' ? { kind: 'boolean' as const } : {}),
          ...(option.currentValue === null ? {} : { currentValue: option.currentValue }),
          choices: option.choices.map(choice => ({
            id: choice.value,
            name: choice.name,
            ...(choice.description === undefined ? {} : { description: choice.description }),
          })),
        })),
      }),
      ...(entry === undefined ? {} : { updatedAt: entry.updatedAt }),
      // The agent's last declared slash commands, for a conversation whose own
      // ACP session does not exist yet. Live sessions still answer through
      // `session/chat-list`; this is the pre-first-message fallback only.
      ...(commands === undefined ? {} : {
        commands: commands.commands,
        commandsUpdatedAt: commands.updatedAt,
      }),
    }
  }

  /**
   * Resolve one exact ACP route id for validation/streaming. Unknown agents
   * throw (that is what turns `selectModel` into `model-unavailable`); known
   * agents NEVER throw — a stale variant degrades to a bare-id entry, because
   * the agent may have dropped a model it used to publish and an
   * already-selected session must keep working.
   */
  resolveAdapterModel(provider: string, model: string): LlmResolvedModelInfo {
    const { agentId, choice } = splitAdapterModelId(model)
    const def = this.defsMap.get(agentId)
    if (def === undefined) {
      throw new AcpError('unknown_model', `acp: model "${model}" is unavailable: agent "${agentId}" is not configured`)
    }
    const title = def.title ?? def.id
    if (choice === undefined || choice === '') {
      const reasoning = this.reasoningMeta(agentId)
      return {
        provider,
        id: model,
        name: title,
        description: `ACP Agent: ${def.command} ${(def.args ?? []).join(' ')}`.trim(),
        ...(reasoning !== undefined ? { reasoning } : {}),
      }
    }
    const modelChoice = this.catalogs.get(agentId)?.catalog.model?.choices.find(c => c.value === choice)
    if (modelChoice === undefined) {
      // Stale variant (agent dropped the model): degrade instead of throwing.
      return { provider, id: model, name: model }
    }
    const reasoning = this.reasoningMeta(agentId)
    return {
      provider,
      id: model,
      name: `${title} · ${modelChoice.name}`,
      ...(modelChoice.description !== undefined ? { description: modelChoice.description } : {}),
      ...(reasoning !== undefined ? { reasoning } : {}),
    }
  }

  /**
   * DSH reasoning metadata built from the agent's `thought_level` option:
   * efforts come from its choices and `defaultEffort` from the current value
   * (only when it is one of the choices — DSH rejects unknown defaults).
   */
  private reasoningMeta(agentId: string): LlmModelReasoningInfo | undefined {
    const thought = this.catalogs.get(agentId)?.catalog.thought
    if (thought === undefined) return undefined
    const efforts: LlmReasoningEffortInfo[] = []
    for (const choice of thought.choices) {
      if (efforts.some(e => e.id === choice.value)) continue
      efforts.push({
        id: choice.value,
        name: choice.name,
        ...(choice.description !== undefined ? { description: choice.description } : {}),
      })
    }
    if (efforts.length === 0) return undefined
    const defaultEffort = thought.currentValue
    return {
      efforts,
      ...(defaultEffort !== null && efforts.some(e => e.id === defaultEffort) ? { defaultEffort } : {}),
    }
  }

  /**
   * Bring the live ACP session's model / thought level in line with what the
   * chat UI selected: diff the session's current `configOptions` and call
   * `session/set_config_option` only for drifting entries. Best effort by
   * design — failures broadcast a notice and the turn proceeds with the
   * agent's current configuration.
   *
   * A requested model the agent no longer offers (it publishes a non-empty
   * choice list without it) is STALE. Alignment does NOT apply it and does NOT
   * delete the pick: the caller refuses the turn so another model is never run
   * unexpectedly (see `staleModelChoice` / `streamPrompt`), and the user can
   * see which selection needs replacing. A stale thought level is still
   * dropped with a one-time notice: it does not change WHICH model runs.
   * The notice is tied to that transition, not to every turn — the turn path
   * aligns twice (session materialization, then the prompt) and both calls
   * would otherwise report the same drop.
   */
  private async alignSessionConfig(
    session: LiveSession,
    modelChoice: string | undefined,
    effort: string | undefined,
  ): Promise<{ modelStale: boolean; effortStale: boolean }> {
    const wantedModel = modelChoice !== undefined && modelChoice !== '' ? modelChoice : undefined
    const wantedEffort = effort !== undefined && effort !== '' ? effort : undefined
    const result = { modelStale: false, effortStale: false }
    if (wantedModel === undefined && wantedEffort === undefined) return result
    let catalog = parseCatalogOptions(session.configOptions)
    // The session's OWN process: A1 gives one agent several children, and a
    // config write must reach the one holding this session, never the agent-wide
    // slot (which may not even be running).
    const bridge = this.bridgeForSession(session)
    const notice = (level: 'info' | 'error', text: string): void => {
      this.hub.broadcast({ type: 'agent/notice', agentId: session.agentId, level, text })
    }
    if (wantedModel !== undefined) {
      const model = catalog.model
      if (model === undefined) {
        notice('error', `acp: agent "${session.agentId}" exposes no model selector; ignoring model "${wantedModel}"`)
      } else if (model.currentValue === wantedModel) {
        // Already in force: nothing to do.
      } else if (model.choices.length > 0 && !model.choices.some(choice => choice.value === wantedModel)) {
        // Do NOT drop the pick or fall back here: the caller refuses the turn
        // (see `staleModelChoice`), so the conversation can never silently run
        // a model the user did not choose.
        result.modelStale = true
      } else {
        try {
          await bridge.setConfigOption(session, model.configId, wantedModel)
          // The answer carries the NEW model's option set (the bridge has
          // already folded it into `session.configOptions`). Whether a thought
          // level still exists is a property of THAT set — opencode publishes
          // one only for models with variants — so the effort below must be
          // judged against it, not against the model the user just left.
          catalog = parseCatalogOptions(session.configOptions)
        } catch (error) {
          notice('error', `acp: failed to switch model to "${wantedModel}": ${describeError(error)}`)
        }
      }
    }
    if (wantedEffort !== undefined) {
      const thought = catalog.thought
      if (thought === undefined) {
        // A real answer without the slot means this session's model publishes no
        // level axis at all (opencode does so only for models with variants), so
        // the pick is unappliable and must leave the record — otherwise the chip
        // keeps naming a value this model does not offer. An empty/absent option
        // set is NOT such an answer (agents answer `[]` mid-reset); that keeps
        // the pick for a later session.
        if (usableConfigOptions(session.configOptions)) {
          result.effortStale = true
          if (this.dropStalePick(session, 'effort', wantedEffort)) {
            notice('error', `acp: agent "${session.agentId}" no longer offers thought level "${wantedEffort}"; using its own current level`)
          }
        }
      } else if (thought.currentValue === wantedEffort) {
        // Already in force.
      } else if (thought.choices.length > 0 && !thought.choices.some(choice => choice.value === wantedEffort)) {
        result.effortStale = true
        if (this.dropStalePick(session, 'effort', wantedEffort)) {
          notice('error', `acp: agent "${session.agentId}" no longer offers thought level "${wantedEffort}"; using its own current level`)
        }      } else {
        try {
          await bridge.setConfigOption(session, thought.configId, wantedEffort)
        } catch (error) {
          notice('error', `acp: failed to set thought level "${wantedEffort}": ${describeError(error)}`)
        }
      }
    }
    return result
  }

  /**
   * Remove one persisted pick the agent no longer honours. Only the thought
   * level uses this today: a stale MODEL pick is deliberately kept and the
   * turn refused, so the user can see which selection must be replaced.
   * Returns true only when a record actually changed — that transition is the
   * news the notice reports.
   */
  private dropStalePick(session: LiveSession, field: 'model' | 'effort', value: string): boolean {
    const dshSessionId = session.dshSessionId
    if (dshSessionId === undefined) return false
    const choice = this.chatAgentIntent.get(dshSessionId)
    if (choice === undefined || choice.agentId !== session.agentId) return false
    const matches = field === 'model'
      ? choice.modelId === buildAdapterModelId(session.agentId, value)
      : choice.effort === value
    if (!matches) return false
    if (field === 'model') this.patchChatChoice(dshSessionId, { modelId: undefined })
    else this.patchChatChoice(dshSessionId, { effort: undefined })
    return true
  }

  /**
   * The requested model value this session's agent no longer offers, if any —
   * the gate the turn path uses to refuse before sending anything.
   *
   * Reads only the session's OWN latest `configOptions` (the same authority
   * alignment uses): a non-empty choice list without the value means the agent
   * dropped it, and applying is impossible. `undefined` means either no model
   * was requested, it is in force, or nothing authoritative is available (no
   * selector, or a selector without choices) — those keep the previous
   * best-effort behavior instead of wedging the conversation.
   *
   * Falling back to "whatever the agent runs" here is exactly the surprise this
   * gate forbids: a different model can differ in price and capability. The
   * pick is kept so the failure names a selection the user can act on.
   */
  private staleModelChoice(session: LiveSession, modelChoice: string | undefined): string | undefined {
    const wanted = modelChoice !== undefined && modelChoice !== '' ? modelChoice : undefined
    if (wanted === undefined) return undefined
    // `category` is a UX hint, not identity: an agent may publish several
    // `category: 'model'` options (Qoder CN ships `reasoning_effort` that way)
    // and no explicit `model` id. In that case the selector is a guess, so a
    // "not offered" verdict would refuse a perfectly valid pick — fail open.
    if (!hasUnambiguousModelSelector(session.configOptions)) return undefined
    const model = parseCatalogOptions(session.configOptions).model
    if (model === undefined) return undefined
    if (model.currentValue === wanted) return undefined
    // A selector without a choice list is unvalidatable; applying it is the
    // existing best effort and the agent decides.
    if (model.choices.length === 0) return undefined
    return model.choices.some(choice => choice.value === wanted) ? undefined : wanted
  }

  /**
   * Resolve (or create) the bridge for one agent + scope. Creation is pure
   * bookkeeping: `ensureReady` stays lazy, so a lookup that never runs a turn
   * costs an object and nothing else.
   */
  private bridgeFor(agentId: string, scope: BridgeScope): AgentBridge {
    const def = this.defsMap.get(agentId)
    if (def === undefined) throw new AcpError('unknown_agent', `acp: agent "${agentId}" is not configured`)
    // A teardown owns this agent right now (see `stopAgent`): refuse even an
    // EXISTING holder — it is already in the stop snapshot and going down, so
    // handing it out would act on a dying process — and never mint a new one.
    if (this.stoppingAgents.has(agentId)) {
      throw new AcpError('agent_stopping', `acp: agent "${agentId}" is stopping; send again once it has stopped`)
    }
    const key = bridgeKey(agentId, scope)
    let bridge = this.bridges.get(key)
    if (bridge === undefined) {
      bridge = this.makeBridge(def, (b, reason) => {
        this.connectionLost(b, reason)
      }, (observedAgentId, configOptions, shapeOnly) => {
        if (shapeOnly) this.absorbCatalogShape(observedAgentId, configOptions)
        else this.absorbCatalog(observedAgentId, configOptions)
      }, (observedAgentId, commands) => {
        this.absorbCommands(observedAgentId, commands)
      }, () => {
        this.persistAgents()
      }, (observedAgentId, supported) => {
        this.noteForkCapability(observedAgentId, supported)
      })
      this.bridges.set(key, bridge)
      this.bridgeScopes.set(key, scope)
    }
    return bridge
  }

  /** Every bridge currently serving one configured agent (one entry unless A1). */
  private bridgesOf(agentId: string): AgentBridge[] {
    const result: AgentBridge[] = []
    for (const bridge of this.bridges.values()) {
      if (bridge.def?.id === agentId) result.push(bridge)
    }
    return result
  }

  /** The legacy single-slot lookup; non-per-session agents keep the exact old key. */
  private bridge(agentId: string): AgentBridge {
    return this.bridgeFor(agentId, { kind: 'agent' })
  }

  /** Every session id this bridge owns right now (live + parked), for isolation checks. */
  private sessionIdsOf(bridge: AgentBridge): Set<string> {
    const ids = new Set<string>()
    for (const session of bridge.sessionList) ids.add(session.sessionId)
    for (const session of bridge.releasedList) ids.add(session.sessionId)
    return ids
  }

  /** The key a bridge is registered under, for pruning by key. */
  private keyOfBridge(bridge: AgentBridge): string | undefined {
    for (const [key, value] of this.bridges) {
      if (value === bridge) return key
    }
    return undefined
  }

  /**
   * The bridge that OWNS a session right now: live, parked, or resuming. Never
   * throws and never creates, so a lookup for a session that is already gone
   * cannot resurrect a process.
   */
  private bridgeOwning(agentId: string, sessionId: string): AgentBridge | undefined {
    for (const bridge of this.bridges.values()) {
      if (bridge.def.id !== agentId) continue
      if (bridge.hasSession(sessionId) !== undefined) return bridge
      if (bridge.hasReleased(sessionId) !== undefined) return bridge
      // A resume is the third ownership state the comment above promises:
      // `doResumeSession` clears `released` before `session/load` and only
      // registers the session after its response, so for that whole request
      // the record is in neither map. Reporting it owner-less here would let
      // `getOrCreateDshSession` forget a healthy conversation mid-recovery.
      if (bridge.inflightResume(sessionId) !== undefined) return bridge
    }
    return undefined
  }

  /**
   * The bridge a session belongs to. Ownership by session id wins (live or
   * parked); a chat session then falls back to the scope its DSH id names, and
   * anything else is an error — a session must never be routed by `agentId`
   * alone, which is the shared-`currentSession` bug A1 removes.
   */
  private bridgeForSession(session: LiveSession): AgentBridge {
    const owning = this.bridgeOwning(session.agentId, session.sessionId)
    if (owning !== undefined) return owning
    if (session.dshSessionId !== undefined) return this.bridgeFor(session.agentId, { kind: 'chat', dshSessionId: session.dshSessionId })
    throw new AcpError('unknown_session', `acp: no bridge owns session ${session.sessionId}`)
  }

  /**
   * Drop a per-session holder once nothing a later turn could resume is left in
   * it. A parked record keeps the holder alive; an agent-wide holder is never
   * dropped because it IS the agent's process slot.
   */
  private pruneBridge(key: string): void {
    const bridge = this.bridges.get(key)
    if (bridge === undefined) return
    if (!isPerSessionAgent(bridge.def.id)) return
    if (!bridge.isDiscardable()) return
    this.bridges.delete(key)
    this.bridgeScopes.delete(key)
    // Dropping the last reference must take the child with it: `isDiscardable`
    // means this holder has no live / parked session and no work left, so
    // nothing can use the process again — leaving it running would orphan it
    // with no owner and no idle timer. `stop` is fire-and-forget here exactly
    // like every non-shutdown teardown (see `killChild`).
    if (bridge.state !== 'stopped') {
      void bridge.stop('agent-stopped').catch(() => { /* already gone */ })
    }
  }

  private find(sessionId: string): { bridge: AgentBridge; session: LiveSession } {
    for (const bridge of this.bridges.values()) {
      const session = bridge.hasSession(sessionId)
      if (session !== undefined) return { bridge, session }
    }
    throw new AcpError('unknown_session', `acp: no live session ${sessionId}`)
  }

  private tryLocate(sessionId: string): { bridge: AgentBridge; session: LiveSession } | undefined {
    try {
      return this.find(sessionId)
    } catch {
      return undefined
    }
  }

  /**
   * Locate a session for an interaction, resuming it first when it was
   * released by an agent crash ("send to recover"). Resuming spawns a fresh
   * process and runs `session/load`, so the first prompt after a crash pays
   * the restart cost once and the conversation continues.
   */
  private async locateOrResume(sessionId: string): Promise<{ bridge: AgentBridge; session: LiveSession }> {
    for (const bridge of this.bridges.values()) {
      const session = bridge.hasSession(sessionId)
      if (session !== undefined) return { bridge, session }
    }
    for (const bridge of this.bridges.values()) {
      const released = bridge.hasReleased(sessionId)
      if (released !== undefined) {
        bridge.takeReleased(sessionId)
        const session = await bridge.resumeSession(released)
        return { bridge, session }
      }
      const inflight = bridge.inflightResume(sessionId)
      if (inflight !== undefined) {
        return { bridge, session: await inflight }
      }
    }
    throw new AcpError('unknown_session', `acp: no live session ${sessionId}`)
  }

  private connectionLost(bridge: AgentBridge, reason: string): void {
    // A dead process cannot settle its prompt: the turn streams riding it end
    // here (their `runPrompt` promise also rejects into settle, but this also
    // covers a promise the connection teardown leaves pending).
    // Only THIS bridge's sessions: an A1 agent's other conversations ride their
    // own processes, and matching by `agentId` would abort turns that are still
    // running fine. `releaseAll` below is already per-bridge (`parkSessions`
    // walks this instance's own `sessions`).
    const owned = this.sessionIdsOf(bridge)
    this.disposeTurnStreamsOf(controller => owned.has(controller.session.sessionId))
    bridge.releaseAll(reason, 'died')
  }

  /**
   * One agent's status as every process serving it adds up. A1 gives an agent
   * several children (one per conversation, one per probe), so the browser
   * needs a single answer: any live child means `ready`; only when none is
   * live does `starting` / `error` surface; nothing at all means `stopped`.
   * The BASE view (the first child in the winning state) carries the identity
   * fields; `liveSessions` is the union across every child.
   */
  private aggregateView(def: AcpAgentDef): AgentView {
    const bridges = this.bridgesOf(def.id)
    if (bridges.length === 0) {
      // Field-for-field the pre-spawn shape a non-A1 agent has always
      // reported: "not started yet" must not become a different shape.
      return this.makeBridge(def, () => { /* pre-spawn */ }).view()
    }
    const views = bridges.map(bridge => bridge.view())
    const state: AgentView['state'] =
      views.some(view => view.state === 'ready') ? 'ready'
        : views.some(view => view.state === 'starting') ? 'starting'
          : views.some(view => view.state === 'error') ? 'error'
            : 'stopped'
    const base = views.find(view => view.state === state) ?? views[0]
    const liveSessions = new Set<string>()
    for (const view of views) {
      for (const sessionId of view.liveSessions) liveSessions.add(sessionId)
    }
    // `stderrTail` rides along only when the AGGREGATE is `error`, and then
    // `base` is an error view — its tail is the right diagnostic. A ready
    // aggregate must never inherit a stale tail from a failed sibling.
    return { ...base, state, liveSessions: [...liveSessions] }
  }

  /**
   * Broadcast ONE `agent/status` frame built from the aggregate of every
   * process serving the agent. For a non-A1 agent there is exactly one child,
   * so the frame is byte-for-byte the one the bridge used to publish itself:
   * same `state`, same `error` (when it carries one), same `agent` view.
   *
   * A pruned child is already gone from `bridgesOf` when its `stop` reports —
   * that is deliberate: a closing probe must not flash the whole agent
   * `stopped` while its conversations are still live.
   */
  private publishAgentStatus(agentId: string): void {
    const def = this.defsMap.get(agentId)
    if (def === undefined) return
    const view = this.aggregateView(def)
    const bridges = this.bridgesOf(agentId)
    // The error belongs to the child that produced the winning state; a
    // lingering error on a stopped sibling must not colour a ready agent. No
    // second fallback: a ready aggregate whose own children carry no error must
    // publish NO `error` field, never another child's stale text.
    const error = bridges.find(bridge => bridge.state === view.state && bridge.errorText !== undefined)?.errorText
    this.hub.broadcast({
      type: 'agent/status',
      agentId,
      state: view.state,
      ...(error === undefined ? {} : { error }),
      agent: view,
    })
  }

  agentViews(): AgentView[] {
    return [...this.defsMap.values()].map(def => this.aggregateView(def))
  }

  /**
   * One log line per distinct startup failure of one child. The aggregate
   * `agent/status` deliberately stays `ready` while ANY sibling serves, so a
   * failed child's error is invisible there; without this notice the user only
   * sees "one conversation does not work". Deduped per bridge instance + text:
   * `publishStatus` fires on every transition and must not spam the log.
   */
  private noticeBridgeFailure(bridge: AgentBridge): void {
    const error = bridge.errorText
    if (bridge.state !== 'error' || error === undefined) return
    if (this.noticedBridgeFailures.get(bridge) === error) return
    this.noticedBridgeFailures.set(bridge, error)
    this.hub.broadcast({
      type: 'agent/notice',
      agentId: bridge.def.id,
      level: 'error',
      text: `acp: agent "${bridge.def.id}" failed to start: ${error}`,
    })
  }

  async detectAgents(): Promise<DetectedAgentInfo[]> {
    return detectHostAgents([...this.defsMap.values()])
  }

  /**
   * True once `deleteAgent` ran for this id in this process. The tombstone
   * lives for the process lifetime (see `deletedAgentIds`), so a stale save
   * snapshot and a fresh explicit save are both refused.
   */
  private isAgentDeleted(agentId: string): boolean {
    return this.deletedAgentIds.has(agentId)
  }

  private agentDeleteGeneration(agentId: string): number {
    return this.agentDeleteGenerations.get(agentId) ?? 0
  }

  private agentSaveGeneration(agentId: string): number {
    return this.agentSaveGenerations.get(agentId) ?? 0
  }

  /** Start a new save generation; returns the number this call owns. */
  private nextAgentSaveGeneration(agentId: string): number {
    const generation = this.agentSaveGeneration(agentId) + 1
    this.agentSaveGenerations.set(agentId, generation)
    return generation
  }

  /**
   * Abort a save whose captured delete/save generation no longer matches, or
   * whose id has a delete tombstone. Runs after every await in `saveAgentNow`,
   * so either a delete or a NEWER save that landed while this one was
   * executing wins over the definition it raced.
   * Throwing {@link SaveGateAborted} makes the gate settle `cancelled` (no
   * failure banner, no retryable entry) instead of `failed`.
   */
  private assertAgentSaveCurrent(agentId: string, saveGeneration: number, deleteGeneration: number): void {
    if (
      !this.isAgentDeleted(agentId)
      && this.agentDeleteGeneration(agentId) === deleteGeneration
      && this.agentSaveGeneration(agentId) === saveGeneration
    ) return
    throw new SaveGateAborted(`acp: agent "${agentId}" was deleted or superseded while its save was in flight`)
  }

  /** Record a delete BEFORE awaiting the stop, so in-flight saves can see it. */
  private tombstoneAgent(agentId: string): void {
    this.deletedAgentIds.add(agentId)
    this.agentDeleteGenerations.set(agentId, this.agentDeleteGeneration(agentId) + 1)
  }

  async saveAgent(def: AcpAgentDef, mode: AgentSaveMode = 'direct'): Promise<AgentSaveResult> {
    // A deleted id never comes back through this entry point. Re-creating one
    // would need an explicit "recreate" gesture that clears the tombstone; no
    // such caller exists today, and a plain save must not reopen the race.
    if (this.isAgentDeleted(def.id)) {
      throw new AcpError('agent_deleted', `acp: agent "${def.id}" was deleted and cannot be saved again`)
    }
    // The host is the single authority for this save: callers that bypass the
    // panel (RPC, scripts) must not interrupt a turn implicitly. Only the two
    // explicit gestures (`defer` / `force`) change that outcome.
    //
    // Order matters: the target's active turns decide whether a force flush is
    // even relevant. Forcing a save on an IDLE agent must not drain unrelated
    // agents' queued writes.
    const label = `agent-save:${def.id}`
    const activeSessions = this.activeTurnViews().filter(view => view.agentId === def.id)
    const action = agentSaveAction(activeSessions, mode)
    if (activeSessions.length > 0 && mode === 'force') {
      // This call owns the definition from here on. The bump happens BEFORE
      // the cancel: an older save already executing must see it and abort at
      // its next await rather than land after the new definition.
      const saveGeneration = this.nextAgentSaveGeneration(def.id)
      // ONLY this agent's held snapshot is dropped. The user authorised the
      // interruption from THIS agent's dialog, so the gesture may not spend
      // that authorisation on other agents: their queued writes stay behind
      // the gate and run at the next idle boundary. The global gesture is
      // the separate `save/flush` -> `saveGateFlush()` entry, which still
      // force-flushes every label.
      this.saveGate?.cancel(label)
      return this.saveAgentDirectly(def, saveGeneration)
    }
    if (activeSessions.length > 0) {
      if (action === 'defer' && this.saveGate !== undefined) {
        // The gate supersedes an older queued save of the same label: the old
        // entry would write values this save has already replaced. The
        // generation this entry owns is captured NOW, so a still-executing
        // older save cannot win after this one is queued.
        const saveGeneration = this.nextAgentSaveGeneration(def.id)
        void this.saveGate.defer(label, () => this.saveAgentNow(def, saveGeneration)).then(outcome => {
          if (outcome.status === 'failed') {
            this.hub.broadcast({
              type: 'agent/notice',
              agentId: def.id,
              level: 'error',
              text: `acp: deferred agent save failed: ${outcome.message}`,
            })
          } else if (outcome.status === 'expired') {
            this.hub.broadcast({
              type: 'agent/notice',
              agentId: def.id,
              level: 'error',
              text: 'acp: deferred agent save expired; save it again',
            })
          }
          // `cancelled` is a silent terminal state: a newer save superseded
          // this entry, or the agent was deleted.
        }, error => {
          this.hub.broadcast({
            type: 'agent/notice',
            agentId: def.id,
            level: 'error',
            text: `acp: deferred agent save failed: ${describeError(error)}`,
          })
        })
        return { done: true, deferred: true }
      }
      // A confirm-only gesture never supersedes a running save: no newer
      // definition exists yet. The user's next explicit save does that.
      return { done: false, confirmationRequired: true, activeSessions }
    }
    // Idle target: this save is the current version, so a stale queued entry
    // for the same agent must not flush later and overwrite it. Bump the
    // generation BEFORE the write so an older in-flight save aborts at its
    // next await instead of landing after this definition.
    const saveGeneration = this.nextAgentSaveGeneration(def.id)
    this.saveGate?.cancel(label)
    return this.saveAgentDirectly(def, saveGeneration)
  }

  /**
   * A direct save has no gate entry to settle, so a subject-gone abort becomes
   * a benign `cancelled` RESULT. Rethrowing it here would turn a delete the
   * user just performed into a failed RPC and a failure banner. The deferred
   * path deliberately keeps `saveAgentNow` unwrapped: the gate needs the thrown
   * marker to settle the queued entry `cancelled` without recording an outcome.
   */
  private async saveAgentDirectly(def: AcpAgentDef, saveGeneration: number): Promise<AgentSaveResult> {
    try {
      return await this.saveAgentNow(def, saveGeneration)
    } catch (error) {
      if (error instanceof SaveGateAborted) return { done: true, cancelled: true }
      throw error
    }
  }

  /** The original save body: stop this agent's process, persist, then probe. */
  private async saveAgentNow(def: AcpAgentDef, saveGeneration: number): Promise<AgentSaveResult> {
    // Captured before the first await. A delete bumps the generation and adds
    // the tombstone, and a newer save bumps the save generation, so each check
    // below sees that specific competing gesture.
    const deleteGeneration = this.agentDeleteGeneration(def.id)
    this.assertAgentSaveCurrent(def.id, saveGeneration, deleteGeneration)
    const defaultWorkspace = ensureDefaultWorkspace()
    const resolvedCwd = def.cwd ?? defaultWorkspace
    // Deduplicated on purpose: the panel pre-fills the same path in several
    // fields, and the old fallback also appended `process.cwd()`, which handed
    // the agent the whole launch directory as an allowed root.
    const resolvedRoots = (def.allowedCwdRoots && def.allowedCwdRoots.length > 0)
      ? [...new Set(def.allowedCwdRoots)]
      : [...new Set([resolvedCwd, defaultWorkspace])]

    const resolvedDef: AcpAgentDef = {
      ...def,
      cwd: resolvedCwd,
      allowedCwdRoots: resolvedRoots,
    }

    if (this.bridges.has(resolvedDef.id) || this.bridgesOf(resolvedDef.id).length > 0) {
      // The save performs its own strict registry write below, so the stop
      // must not race it with a second best-effort one.
      await this.stopAgent(resolvedDef.id, false)
      // First await cleared: the user may have deleted this agent, or a newer
      // save may have started, while the process was stopping. Abort before
      // touching the registry or the file.
      this.assertAgentSaveCurrent(resolvedDef.id, saveGeneration, deleteGeneration)
      // `stopAgent` drops the per-scope keys; the bare slot goes here too.
      this.bridges.delete(resolvedDef.id)
      this.bridgeScopes.delete(resolvedDef.id)
    }

    // Second gate immediately before the two writes that make the save
    // observable: either a tombstone or a newer save recorded during any
    // earlier callback wins here.
    this.assertAgentSaveCurrent(resolvedDef.id, saveGeneration, deleteGeneration)
    // Strict + STAGED: the file lands first. `defsMap` only commits after a
    // successful write, so a failed disk write cannot leave memory naming a
    // definition the registry file does not have.
    this.persistAgents(true, resolvedDef)
    this.defsMap.set(resolvedDef.id, resolvedDef)
    this.hub.broadcast({
      type: 'agent/status',
      agentId: resolvedDef.id,
      state: 'stopped',
      agent: new AgentBridge(resolvedDef, this.hub, this.transcriptMax, () => {}).view(),
    })
    // A save is user-initiated: probe the model catalog immediately so the ACP
    // seats fill in; a failing startup surfaces as a notice.
    void this.probeAgentModels(resolvedDef.id).catch((error: unknown) => {
      this.hub.broadcast({
        type: 'agent/notice',
        agentId: resolvedDef.id,
        level: 'error',
        text: `acp: model probe failed: ${describeError(error)}`,
      })
    })
    return { done: true }
  }

  /**
   * Lightweight model-visibility update: mutates the def in place (the live
   * bridge shares the same object, so nothing needs restarting), persists, and
   * republishes status. `undefined` clears the filter, which — being the same
   * as `[]` — leaves only the agent's base entry in the ACP seats.
   */
  async setExposedModels(agentId: string, exposedModels: readonly string[] | undefined): Promise<void> {
    const def = this.defsMap.get(agentId)
    if (def === undefined) throw new AcpError('unknown_agent', `acp: agent "${agentId}" is not configured`)
    if (exposedModels === undefined) delete def.exposedModels
    else def.exposedModels = [...exposedModels]
    this.persistAgents()
    const view = this.aggregateView(def)
    // The aggregate is the agent's state; the view rides along only when a
    // holder exists, exactly as this frame always did (no `error` field here).
    this.hub.broadcast({
      type: 'agent/status',
      agentId,
      state: view.state,
      ...(this.bridgesOf(agentId).length === 0 ? {} : { agent: view }),
    })
    this.broadcastExposure(agentId)
  }

  /**
   * Toggle auto-discovery of newly published models. Lightweight like
   * `setExposedModels`: the def is mutated in place (live bridges share the
   * object) and persisted; no process is restarted, and the current selection
   * is left exactly as it is. On is the default, so only the opt-out
   * (`false`) is written to the file.
   */
  async setAutoDiscoverModels(agentId: string, autoDiscoverModels: boolean): Promise<void> {
    const def = this.defsMap.get(agentId)
    if (def === undefined) throw new AcpError('unknown_agent', `acp: agent "${agentId}" is not configured`)
    if (autoDiscoverModels) delete def.autoDiscoverModels
    else def.autoDiscoverModels = false
    this.persistAgents()
    this.broadcastExposure(agentId)
  }

  async deleteAgent(agentId: string): Promise<void> {
    // Tombstone FIRST, before any await: a save that is already past its
    // generation check must see the delete when it resumes, and every later
    // save of this id is refused outright.
    this.tombstoneAgent(agentId)
    // Drop the agent's held save BEFORE stopping it: stopping ends its turns,
    // and a deferred snapshot flushing afterwards would write the definition
    // straight back into `agents.json` (the deleted agent would come back).
    this.saveGate?.cancel(`agent-save:${agentId}`)
    if (this.bridges.has(agentId) || this.bridgesOf(agentId).length > 0) {
      // This method performs its own strict registry write below.
      await this.stopAgent(agentId, false)
      // `stopAgent` drops every per-scope key; the bare key is the non-A1 /
      // pre-spawn slot and is removed here as well.
      this.bridges.delete(agentId)
      this.bridgeScopes.delete(agentId)
    }
    this.defsMap.delete(agentId)
    // The default agent is a pointer INTO this registry: deleting its target
    // must drop the pointer too, or the file would keep naming a ghost.
    if (this.defaultAgentId === agentId) this.defaultAgentId = undefined
    // Same for the request-path binding: a conversation pointed at the deleted
    // agent must fall back (to the default, or to no rewrite) rather than send
    // the next turn after a ghost.
    for (const [dshSessionId, model] of routeBindingRegistry().conversations) {
      if (splitAdapterModelId(model).agentId === agentId) routeBindingRegistry().conversations.delete(dshSessionId)
    }
    if (routeBindingRegistry().defaultModel === agentId) routeBindingRegistry().defaultModel = undefined
    // All three maps are independent (any may be missing), so delete all
    // before deciding whether the file needs rewriting. The fork capability
    // goes with the agent: a same-id rebuild must not inherit the OLD agent's
    // "supported" and click into a `fork_unsupported` wall before its own
    // first `initialize` answers.
    const droppedCatalog = this.catalogs.delete(agentId)
    const droppedCommands = this.commandCache.delete(agentId)
    const droppedFork = this.forkCaps.delete(agentId)
    if (droppedCatalog || droppedCommands || droppedFork) this.persistCatalogs()
    // Strict: the delete must not report success when the registry still names
    // the agent. The tombstone and the in-memory deletion stay in place even
    // when this throws, so nothing resurrects it inside this process; the RPC
    // failure tells the user the file needs another attempt.
    this.persistAgents(true)
    this.hub.broadcast({
      type: 'agent/status',
      agentId,
      state: 'stopped',
    })
  }

  /**
   * Spawn a throwaway agent process from raw form values and run the ACP
   * handshake against it. The bridge is never registered in `defsMap` /
   * `bridges` and broadcasts on a private hub with no sinks, so a test cannot
   * touch persisted config, real sessions, or the browser event stream. The
   * process is torn down in every outcome.
   */
  async testAgent(def: AcpAgentDef): Promise<AgentTestResult> {
    const bridge = new AgentBridge(def, new EventHub(), 50, () => {})
    const startedAt = Date.now()
    try {
      await bridge.ensureReady()
      const info = bridge.initResult?.agentInfo
      return {
        ok: true,
        ...(info
          ? { agentInfo: { name: info.name, title: info.title ?? undefined, version: info.version } }
          : {}),
        durationMs: Date.now() - startedAt,
        stderr: [...bridge.stderrTail],
      }
    } catch (error) {
      // The child's exit may still be in flight when the handshake failure is
      // reported (see `awaitStartChildExit`): give it a bounded moment so the
      // verdict can carry the exit code.
      await bridge.awaitStartChildExit(TEST_EXIT_GRACE_MS)
      // The failure is reported as FACTS, not only as the SDK's sentence: every
      // spawn failure rejects the pending `initialize` with the same
      // "ACP connection closed", which cannot tell "the agent is not installed"
      // from "the launch command is wrong". The browser writes the sentence from
      // `failure`; `error` stays for the raw text.
      const attempt = bridge.startAttempt
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        failure: classifyTestFailure(attempt),
        ...(attempt === undefined
          ? {}
          : {
            command: attempt.command,
            ...(attempt.executablePath === undefined ? {} : { executablePath: attempt.executablePath }),
            installTried: attempt.installTried,
            ...(attempt.spawnError === undefined ? {} : { spawnError: attempt.spawnError }),
            ...(attempt.exit === undefined ? {} : { exit: attempt.exit }),
          }),
        durationMs: Date.now() - startedAt,
        stderr: [...bridge.stderrTail],
      }
    } finally {
      await bridge.stop().catch(() => { /* already torn down by the failure path */ })
    }
  }

  async startSession(agentId: string, cwd: string | undefined): Promise<{ sessionId: string }> {
    // A1: an `/acp` session gets its own process. The token is only the bridge
    // key; later lookups find the session by the id it was registered with.
    const scope: BridgeScope = isPerSessionAgent(agentId)
      ? { kind: 'ephemeral', token: randomUUID() }
      : { kind: 'agent' }
    const session = await this.bridgeFor(agentId, scope).createSession(cwd)
    return { sessionId: session.sessionId }
  }

  async prompt(sessionId: string, prompt: string | ContentBlock[]): Promise<{ turnId: string }> {
    let located = await this.locateOrResume(sessionId)
    // The watchdog abandoned a previous turn here and the agent may still be
    // holding its prompt slot on the old process: reclaim BEFORE sending, or
    // this message queues behind a turn that will never answer.
    if (located.session.orphanPromptTurnSeq !== undefined) {
      const prepared = await this.prepareStalledSession(located.session)
      if (!prepared.ok) throw new AcpError('agent_unresponsive', prepared.message)
      // Without `session/load` there is nothing to re-locate: the record was
      // dropped on purpose, and "/acp" has no conversation to recreate it from.
      // Re-locating anyway would surface a misleading `unknown_session`.
      if (prepared.reset === true) {
        throw new AcpError('session_reset', `acp: agent "${located.session.agentId}" does not support session resume; start a new session`)
      }
      // A resumable reclaim released the record: re-locate what is live now.
      located = await this.locateOrResume(sessionId)
    }
    const { bridge, session } = located
    // The agent prompt slot is SHARED with chat turns: `running` alone misses
    // a chat turn whose cancellation already released it (`running` false,
    // `promptInFlight` still naming the agent-side turn), and a live chat
    // controller means a continuation step may resume the SAME agent turn.
    // A controller that already SETTLED (kept only so its card's continuation
    // can still stream) has given the agent slot back: `/acp` may use it, and
    // advancing `turnSeq` retires it — the behaviour the stale-controller
    // watchdog case pins.
    const chatController = session.turnController
    if (session.running
      || session.promptInFlight === true
      || (chatController !== undefined && !chatController.stale && !chatController.hasSettled)) {
      throw new AcpError('turn_in_flight', 'acp: this session already has a prompt in flight')
    }

    const blocks: ContentBlock[] = typeof prompt === 'string'
      ? [{ type: 'text', text: prompt }]
      : prompt

    if (blocks.length === 0) {
      throw new AcpError('empty_prompt', 'acp: prompt cannot be empty')
    }

    const hasImages = blocks.some(b => b.type === 'image')
    if (hasImages && bridge.initResult?.agentCapabilities?.promptCapabilities?.image !== true) {
      throw new AcpError('image_unsupported', `acp: agent "${bridge.def.id}" does not support image input`)
    }

    // Claim the SAME slot the chat path claims (`claimTurn` + `beginTurn`): an
    // `/acp` turn in flight must make the next chat prompt wait, and vice
    // versa. The settler is idempotent and identity-guarded; the turn still
    // ends through `turn/end` below, so chat and RPC turns share one gate
    // without sharing a stream controller.
    const endTurn = bridge.beginTurn(session)
    session.running = true
    session.turnSeq += 1
    const turnGen = session.turnSeq
    session.lastAgentActivityAt = Date.now()
    session.activeToolCalls.clear()
    // A new turn owns the session from here: any reclaim marker named an
    // earlier generation and must not suppress THIS turn's settle.
    session.reclaimedTurnSeq = undefined
    this.armStallTimer()
    const turnId = randomUUID()
    const promptText = typeof prompt === 'string'
      ? prompt
      : blocks.filter(b => b.type === 'text').map(b => (b as { text: string }).text).join('\n')
    this.hub.broadcast({ type: 'turn/start', sessionId, turnId, text: promptText })
    void bridge.runPrompt(session, blocks, turnId, turnGen)
      .then(result => {
        // The reclaim already ended this turn locally; the answer it caused is
        // that same turn reporting back, not a second turn end for the caller.
        if (session.reclaimedTurnSeq === turnGen) {
          session.reclaimedTurnSeq = undefined
          return
        }
        // A superseded turn's late answer must not end the turn now on air.
        if (session.turnSeq !== turnGen) return
        this.clearOrphanPrompt(session, turnGen)
        // The SAME rate-limit refusal the chat plane settles on (see
        // `streamPrompt`): a refused prompt RESOLVES, so without this the turn
        // would end as a plain `refusal` stop and the reason — which lives only
        // in the response `_meta` — would be dropped. The banner is a chat
        // surface, but the record hangs off the SESSION, and one LiveSession
        // can be driven from both planes: a chat conversation whose last
        // `/acp` answer was normal must not keep showing a quota the agent has
        // already stopped reporting.
        const refusal = result.stopReason === 'refusal' ? agentRefusalDetail(result.meta) : undefined
        if (refusal?.kind === 'quota') {
          session.quotaRefusal = { message: refusal.message, at: Date.now() }
          this.hub.broadcast({ type: 'session/meta', sessionId, session: snapshot(session) })
        } else if (session.quotaRefusal !== undefined) {
          session.quotaRefusal = undefined
          this.hub.broadcast({ type: 'session/meta', sessionId, session: snapshot(session) })
        }
        // Release the shared slot BEFORE the terminal frame: a listener that
        // sends the next prompt on `turn/end` must not read a stale claim.
        endTurn()
        session.running = false
        if (refusal?.kind === 'quota') {
          this.hub.broadcast({
            type: 'turn/end',
            sessionId,
            turnId,
            error: rateLimitedTurnError(session.agentId, refusal),
            errorKind: 'quota',
          })
        } else {
          this.hub.broadcast({ type: 'turn/end', sessionId, turnId, stopReason: result.stopReason })
        }
      })
      .catch((error: unknown) => {
        if (session.reclaimedTurnSeq === turnGen) {
          session.reclaimedTurnSeq = undefined
          return
        }
        if (session.turnSeq !== turnGen) return
        // The turn was ended by an EXTERNAL close (idle release, agent stop):
        // that teardown already broadcast the turn's end, and the session is
        // parked or closed. Reporting the close's rejection again would put a
        // second terminal frame on a turn the browser already saw finish.
        if (session.released || session.closed) {
          this.clearOrphanPrompt(session, turnGen)
          return
        }
        this.clearOrphanPrompt(session, turnGen)
        endTurn()
        session.running = false
        this.hub.broadcast({
          type: 'turn/end',
          sessionId,
          turnId,
          error: describeError(error),
        })
      })
      // Every outcome — normal answer, failure, reclaim early-return, or a
      // close's rejection — releases the shared prompt slot exactly once.
      .finally(() => { endTurn() })
    return { turnId }
  }

  /** The late answer landed (or failed): the turn is no longer an orphan. */
  private clearOrphanPrompt(session: LiveSession, turnGen: number): void {
    if (session.orphanPromptTurnSeq === turnGen) session.orphanPromptTurnSeq = undefined
  }

  async cancel(sessionId: string): Promise<void> {
    const live = this.tryLocate(sessionId)
    if (live === undefined) return // released/stale session: nothing to cancel
    await live.bridge.cancel(live.session)
  }

  async closeSession(sessionId: string): Promise<void> {
    // The turn stream of this session dies with it: a continuation step that
    // is already on its way must not resume a closed session.
    this.disposeTurnStreamsOf(controller => controller.session.sessionId === sessionId)
    const live = this.tryLocate(sessionId)
    if (live !== undefined) {
      await live.bridge.closeSession(live.session, 'closed')
      this.forgetDshSession(sessionId)
      const key = this.keyOfBridge(live.bridge)
      if (key !== undefined) this.pruneBridge(key)
      return
    }
    // A released session has no process left to close; just drop the record.
    for (const [key, bridge] of this.bridges) {
      if (bridge.dropReleased(sessionId)) {
        this.hub.broadcast({ type: 'session/closed', sessionId, reason: 'closed' })
        this.pruneBridge(key)
        return
      }
    }
    throw new AcpError('unknown_session', `acp: no live session ${sessionId}`)
  }

  async setMode(sessionId: string, modeId: string): Promise<void> {
    const { bridge, session } = await this.locateOrResume(sessionId)
    await bridge.setMode(session, modeId)
  }

  async setConfigOption(sessionId: string, configId: string, value: string | boolean): Promise<void> {
    const { bridge, session } = await this.locateOrResume(sessionId)
    await bridge.setConfigOption(session, configId, value)
  }

  respondPermission(requestId: string, optionId: string | undefined): void {
    for (const bridge of this.bridges.values()) {
      const owner = bridge.permissions.sessionIds().find(p => p.requestId === requestId)
      if (owner === undefined) continue
      bridge.permissions.respond(requestId, optionId === undefined ? { outcome: 'cancelled' } : { outcome: 'selected', optionId })
      return
    }
    throw new AcpError('unknown_request', `acp: no pending permission ${requestId}`)
  }

  transcript(sessionId: string, afterSeq: number | undefined): { session: unknown; entries: Array<{ seq: number; update: unknown }> } {
    const live = this.tryLocate(sessionId)
    if (live !== undefined) {
      return { session: snapshot(live.session), entries: live.session.transcript.since(afterSeq ?? 0) }
    }
    // A released session still serves its pre-crash transcript for viewing.
    for (const bridge of this.bridges.values()) {
      const released = bridge.hasReleased(sessionId)
      if (released !== undefined) {
        return { session: snapshot(released), entries: released.transcript.since(afterSeq ?? 0) }
      }
    }
    throw new AcpError('unknown_session', `acp: no live session ${sessionId}`)
  }

  sessions(): unknown[] {
    return [...this.bridges.values()].flatMap(b => [...b.sessionList, ...b.releasedList].map(snapshot))
  }

  /**
   * Kill this agent's process and forget its chat-bound session records.
   *
   * The removed records ARE persisted (`persist` defaults to true): a stop
   * closes the agent-side sessions on purpose, so leaving them in `agents.json`
   * would resurrect them as resumable after the next host restart. Save and
   * delete pass `false` because each performs its own strict registry write
   * immediately afterwards; a second best-effort write there would race the
   * definition it is about to replace.
   */
  async stopAgent(agentId: string, persist = true): Promise<void> {
    // Close the gate FIRST, synchronously and before the snapshot: from here
    // until this call returns, `bridgeFor` refuses to mint or hand out a holder
    // for this agent. Without it a message arriving during the `await` below
    // could spawn a child the snapshot never saw, and the key sweep would then
    // delete its holder — leaving an orphan process plus a live `dshSessionMap`
    // record that no bridge serves (the next prompt would fail on a dead
    // `acpSessionId`).
    this.stoppingAgents.set(agentId, (this.stoppingAgents.get(agentId) ?? 0) + 1)
    try {
      // A1 gives one agent several processes; collect every one of them first so
      // the teardown covers the whole set instead of the old single slot. The
      // KEY travels with each snapshot entry: only those keys may be swept
      // afterwards, never a key a later create re-registered.
      const entries: { key: string; bridge: AgentBridge }[] = []
      for (const [key, bridge] of this.bridges) {
        if (bridge.def?.id === agentId) entries.push({ key, bridge })
      }
      const bridges = entries.map(entry => entry.bridge)
      // The streams to kill are the sessions THIS agent owns — live, parked, or
      // still chat-keyed. Matching on `agentId` would tear down a stream that a
      // differently-scoped child of the same agent still serves.
      const owned = new Set<string>()
      for (const bridge of bridges) {
        for (const sessionId of this.sessionIdsOf(bridge)) owned.add(sessionId)
      }
      for (const [key, session] of this.dshSessionMap) {
        if (session.agentId !== agentId) continue
        owned.add(session.sessionId)
        this.dshSessionMap.delete(key)
      }
      this.disposeTurnStreamsOf(controller => owned.has(controller.session.sessionId))
      if (persist) this.persistAgents()
      // One stop per process, all at once: the children are independent, so the
      // wall clock is the slowest single teardown rather than their sum.
      await Promise.allSettled(bridges.map(bridge => bridge.stop('agent-stopped')))
      // Delete exactly the snapshot keys. The identity check is defensive (the
      // gate already makes a mid-stop registration impossible): a key now
      // holding a DIFFERENT bridge is not ours to delete.
      for (const { key, bridge } of entries) {
        if (this.bridges.get(key) !== bridge) continue
        this.bridges.delete(key)
        this.bridgeScopes.delete(key)
      }
    } finally {
      const remaining = (this.stoppingAgents.get(agentId) ?? 1) - 1
      if (remaining <= 0) this.stoppingAgents.delete(agentId)
      else this.stoppingAgents.set(agentId, remaining)
    }
  }

  /**
   * Host shutdown: park every conversation, then make sure no agent child
   * outlives the host. Bridges run CONCURRENTLY against one bounded budget, so a
   * single wedged agent cannot spend every other bridge's slice too.
   *
   * `/acp`'s "stop this agent" gesture is `stopAgent` → `stop`, which is a
   * different promise: it closes the sessions on purpose. See
   * `AgentBridge.shutdown` for why host exit must not.
   */
  async shutdownAll(): Promise<void> {
    if (this.stallTimer !== undefined) {
      clearInterval(this.stallTimer)
      this.stallTimer = undefined
    }
    this.disposeTurnStreamsOf(() => true)
    // NOT cleared before the shutdown: `persistAgents` (called from
    // `parkSessions`) writes the parked records out of `dshSessionMap`, and
    // that write is what keeps the conversations resumable across the restart.
    //
    // `allSettled`, not `all`: one bridge's failure must neither skip the
    // others nor reject a disposer that never asked for an answer. And NOT
    // cleared afterwards either: a late `persistAgents` would then write
    // `chatSessions: []` and erase exactly what the shutdown just saved. These
    // records are terminal — nothing reads them again after disposal.
    await Promise.allSettled([...this.bridges.values()].map(b => b.shutdown(SHUTDOWN_BUDGET_MS)))
  }

  /** Host-side reader of the harness preset roster (`ctx.agentPresets`), for `presetStatus`. */
  private presetRosterReader?: () => Promise<readonly RosterPresetRow[] | undefined>

  /**
   * The built-in updater, wired by the host entry. Absent in pure bridge tests —
   * the update RPCs then answer `unsupported` instead of inventing a source.
   */
  private updateService?: UpdateService
  /** The host-entry save gate; absent in pure bridge tests. */
  private saveGate?: AcpSaveGate

  /**
   * The plugin's own default ACP agent (the panel's ★ gesture): which agent an
   * ACP-mode conversation starts on. Host-side state in the agent registry
   * file — deliberately NOT a DSH model route: nothing here ever writes to the
   * host's model selection (see docs/acp-convergence.md §2.2).
   */
  defaultAgent(): string | undefined {
    // A default pointing at a deleted agent answers as "none": the browser
    // then offers the agent menu instead of auto-routing nowhere.
    return this.defaultAgentId !== undefined && this.defsMap.has(this.defaultAgentId) ? this.defaultAgentId : undefined
  }

  async setDefaultAgent(agentId: string | undefined): Promise<void> {
    if (agentId !== undefined && !this.defsMap.has(agentId)) {
      throw new AcpError('unknown_agent', `acp: agent "${agentId}" is not configured`)
    }
    this.defaultAgentId = agentId
    this.persistAgents()
    // The request-path rewrite falls back to it for never-bound conversations.
    routeBindingRegistry().defaultModel = agentId
  }

  /** The agent tag's halo preference (composer display, plugin-private). */
  tagHalo(): AcpTagHalo {
    return this.tagHaloSetting
  }

  async setTagHalo(halo: AcpTagHalo): Promise<void> {
    // Rebuild through the validator so every write passes the same gate the
    // RPC route used, whatever the caller (a direct `manager` consumer today,
    // a future non-RPC path tomorrow).
    this.tagHaloSetting = validateTagHalo(halo)
    this.persistAgents()
  }

  /** Whether generated NTR session titles carry the badge (settings page toggle). */
  sessionTitlePrefix(): boolean {
    return this.sessionTitlePrefixEnabled
  }

  async setSessionTitlePrefix(value: boolean): Promise<void> {
    // Same gate as the RPC route (the one validation a boolean needs), and the
    // same persisted-with-the-registry story as every other settings toggle.
    this.sessionTitlePrefixEnabled = value === true
    this.persistAgents()
  }

  /**
   * Declare the deployment baseline for the idle-release window — the value
   * `cordis.patch.yml` names, passed RAW (only when it names one).
   *
   * Kept separate from the validated tuning for the same reason the
   * deadline keeps its baseline apart: "the file says 10 minutes" and
   * "the file says nothing, so 30 minutes applies" are different facts.
   * The first is the reset target and shows as the fact being overridden;
   * the second is a built-in default. Called once by the host entry,
   * before any bridge exists.
   */
  setConfiguredIdleRelease(idleTimeoutMs: number | undefined): void {
    this.configuredIdleTimeoutMs = idleTimeoutMs
    if (idleTimeoutMs !== undefined) this.baselineIdleTimeoutMs = idleTimeoutMs
    this.applyIdleReleaseTuning()
  }

  /**
   * Declare the deployment baseline for the approval deadline — the values
   * `cordis.patch.yml` names, passed RAW (only the keys it actually contains).
   *
   * Kept separate from the validated tuning because "the file says 600000" and
   * "the file says nothing, so 300000 applies" are different facts: the settings
   * card shows the first as the reset target and the second as a built-in
   * default. Called once by the host entry, before any bridge exists — and it
   * also moves the baseline, so a manager built without tuning (a direct
   * consumer, a test) still runs what the deployment asked for.
   */
  setConfiguredApprovalDeadlines(values: Partial<Record<ApprovalDeadlineKey, number>>, mode?: PermissionTimeoutMode): void {
    // The baseline must be legal for the mode it runs under, or the card would
    // advertise a number the deployment cannot actually run (不等待 under
    // `abort`) and the reset button would restore it.
    //
    // This normalization applies to the CONFIG BASELINE only (the value the
    // card shows as the reset target and against which the override is
    // compared): `applyDeadlineTuning` owns the persisted override, while
    // `validateConfig` and the `AgentBridge` constructor normalize their own
    // inputs. Keeping the file's raw 0 here would make the card report the
    // floored runtime value as a user override and offer a reset that restores
    // a value it cannot run. Separating "what the file says" from "what runs"
    // needs a second protocol field; until that exists the config baseline
    // stays normalized.
    const effectiveMode = mode ?? this.configuredMode ?? this.baselineMode
    const raw = values.permissionTimeoutMs
    const window = raw === undefined ? undefined : normalizeApprovalWindow(effectiveMode, raw)
    this.configuredDeadlines = window === undefined ? {} : { permissionTimeoutMs: window }
    if (window !== undefined) this.baselineDeadline = window
    if (mode !== undefined) {
      this.configuredMode = mode
      this.baselineMode = mode
    }
    this.applyDeadlineTuning()
  }

  /**
   * The approval deadline in force, plus the facts that explain a value the
   * user did not pick: the config-file baseline an override is outranking. The
   * mode rides along with its own baseline, for the same reason: the card has
   * to be able to say "the file asks for `abort`, the value set here wins".
   *
   * Everything is reported only when it is actually in play, so the card can
   * stay silent about a plain default.
   */
  approvalDeadlines(): AcpApprovalDeadlines {
    const deadlines: AcpApprovalDeadlines = {
      permissionTimeoutMs: this.tuning.permissionTimeoutMs,
      mode: this.tuning.permissionTimeoutMode,
    }
    if (Object.keys(this.configuredDeadlines).length > 0) deadlines.configured = { ...this.configuredDeadlines }
    if (this.configuredMode !== undefined) deadlines.configuredMode = this.configuredMode
    return deadlines
  }

  /**
   * The idle-release window in force, plus the facts that explain a value the
   * user did not pick: the deployment baseline an override is outranking.
   *
   * `defaultIdleTimeoutMs` is the window a RESET returns to — the deployment
   * baseline when the config file names one, else the built-in default. It is
   * NOT a hardcoded constant: a deployment that names 10 minutes must reset
   * to 10 minutes, not to the built-in 30.
   *
   * The config file's own number is reported only when the file names one, so
   * the settings card can stay silent about a plain default.
   */
  idleRelease(): AcpIdleRelease {
    const release: AcpIdleRelease = {
      idleTimeoutMs: this.idleTimeoutMs(),
      defaultIdleTimeoutMs: this.baselineIdleTimeoutMs,
    }
    if (this.configuredIdleTimeoutMs !== undefined) release.configuredIdleTimeoutMs = this.configuredIdleTimeoutMs
    return release
  }

  /**
   * Write the idle-release window, or drop the persisted override with
   * `reset` so the deployment baseline applies again.
   *
   * HOT: the rewrite reaches every live bridge, so a user changing the window
   * never has to kill a running session to see it take effect.
   */
  async setIdleRelease(idleTimeoutMs: number | undefined, reset = false): Promise<void> {
    this.idleReleaseOverride = reset ? undefined : idleTimeoutMs
    this.applyIdleReleaseTuning()
    this.persistAgents()
  }

  /**
   * Recompute the idle-release window from override → deployment baseline, and
   * push the result to every live bridge.
   */
  private applyIdleReleaseTuning(): void {
    const window = this.idleTimeoutMs()
    this.tuning.idleTimeoutMs = window
    for (const bridge of this.bridges.values()) bridge.applyIdleRelease(window)
  }

  /**
   * The idle-release window that runs, in ms: the settings page's pick, else
   * the deployment baseline.
   */
  private idleTimeoutMs(): number {
    return this.idleReleaseOverride ?? this.baselineIdleTimeoutMs
  }

  /**
   * Write the approval deadline, or the mode (omitted keys keep their value),
   * or drop the persisted override with `reset` so the config-file baseline —
   * or the built-in default — applies again.
   *
   * HOT: the rewrite reaches every live bridge, so a user changing the window
   * never has to kill a running session to see it take effect (the one thing an
   * `agent/save`-style restart would cost them). Only asks armed AFTER the
   * write see the new window; an ask already holding a timer keeps the one it
   * started with.
   */
  async setApprovalDeadlines(patch: ApprovalDeadlinePatch, reset = false): Promise<void> {
    // Merged BEFORE validating, so the whole resulting override passes the same
    // gate the config file does (an override written by an older build is
    // re-gated here rather than trusted). The validators also drop unknown
    // keys, which is what keeps a stale payload from poisoning state.
    const merged = reset ? {} : { ...this.deadlineOverride, ...patch }
    const window = validateApprovalDeadlines(merged).permissionTimeoutMs
    const mode = merged.mode === undefined
      ? undefined
      : validatePermissionTimeoutMode(merged.mode, 'bad_payload')
    // Persist the user's RAW window, never a mode-specific rewrite: 不等待 (0)
    // belongs to `auto`, and the floor under `abort` is a RUNTIME fact applied
    // by `applyDeadlineTuning`. Flooring it here would turn a mode switch into
    // a silent edit of the stored value, so switching back to `auto` could
    // never restore the zero the user actually picked.
    this.deadlineOverride = {
      ...(window === undefined ? {} : { permissionTimeoutMs: window }),
      ...(mode === undefined ? {} : { mode }),
    }
    this.applyDeadlineTuning()
    this.persistAgents()
  }

  /**
   * Recompute the deadline and the mode from override → deployment baseline,
   * and push the result to every live bridge.
   *
   * This is the ONLY place the PERSISTED OVERRIDE is read and normalized into
   * a runtime value. Persisted state keeps the user's RAW pick (0 = 不等待
   * under `auto`), and the mode's floor is applied here on every recompute —
   * so a state file holding a zero while the mode is `abort` still runs the
   * 30 s minimum instead of refusing every ask on arrival. Nothing else may
   * read `deadlineOverride` for a runtime value.
   */
  private applyDeadlineTuning(): void {
    const permissionTimeoutMode = this.deadlineOverride.mode ?? this.baselineMode
    const permissionTimeoutMs = normalizeApprovalWindow(
      permissionTimeoutMode,
      this.deadlineOverride.permissionTimeoutMs ?? this.baselineDeadline,
    )
    this.tuning.permissionTimeoutMs = permissionTimeoutMs
    this.tuning.permissionTimeoutMode = permissionTimeoutMode
    const patch = { permissionTimeoutMs, mode: permissionTimeoutMode }
    for (const bridge of this.bridges.values()) bridge.applyApprovalDeadlines(patch)
  }

  private readonly dshSessionMap = new Map<string, LiveSession>()
  /**
   * What each DSH chat session has chosen for its ACP agent — the agent itself
   * plus the agent's model and thought level. Persisted with the agent registry
   * (`conversations`), so the pick survives a host restart and is readable
   * before the conversation has ever run a turn. This is the plugin's own
   * conversation↔agent mapping, never a DSH model route (see `bindChatAgent`).
   */
  private readonly chatAgentIntent = new Map<string, AcpConversationChoice>()
  /**
   * The plugin's OWN lifecycle records for external (ACP-dispatched) workers,
   * keyed by DSH chat session and capped at {@link MAX_SUBAGENT_RECORDS} rows
   * per conversation. The host's `subagentCatalog` projection stays the list
   * SKELETON (persisted membership); this map supplies what it cannot —
   * status, failure reason, timings and counts. Persisted under `agents.json`'s
   * `subagents` key on state transitions only.
   */
  private readonly subagentRecords = new Map<string, SubagentRecord[]>()

  /** Drop every chat-keyed record pointing at one host session (close/stop paths). */
  private forgetDshSession(sessionId: string): void {
    const owners = new Set<string>()
    let dropped = false
    for (const [key, session] of this.dshSessionMap) {
      if (session.sessionId === sessionId) {
        if (session.dshSessionId !== undefined) owners.add(session.dshSessionId)
        this.dshSessionMap.delete(key)
        dropped = true
      }
    }
    // An explicitly closed (or force-reset) session destroys the
    // conversation's worker records with it: the rows belong to a conversation
    // that no longer exists. Only when NO OTHER ACP session still serves the
    // same conversation — two sessions of one conversation must not lose each
    // other's history.
    for (const dshSessionId of owners) {
      let stillOwned = false
      for (const session of this.dshSessionMap.values()) {
        if (session.dshSessionId === dshSessionId) {
          stillOwned = true
          break
        }
      }
      if (!stillOwned) this.subagentRecords.delete(dshSessionId)
    }
    // The disk record goes with it: a closed session is destroyed, not parked,
    // and must not come back on the next boot (constraint 10).
    if (dropped) this.persistAgents()
  }
  private sessionWorkspaceResolver?: SessionWorkspaceResolver
  private acpModeResolver?: AcpModeResolver
  private subagentCatalogReporter?: SubagentCatalogReporter
  private attachmentResolver?: unknown
  /** Cached `chatSessionAcpMode` answers, keyed by DSH chat session id. */
  private readonly acpModeCache = new Map<string, boolean>()
  /** In-flight cold reads behind `chatSessionAcpModeAnswer`, keyed by session id. */
  private readonly acpModeInflight = new Map<string, Promise<boolean | undefined>>()

  /**
   * The agent values the composer is showing for a conversation that has not
   * picked them — the catalog's current model, thought level, mode and extra
   * config values.
   *
   * Captured BEFORE `session/new`: materializing the session absorbs its own
   * defaults into the catalog (`absorbCatalog`), which would overwrite exactly
   * the values the user saw and leave the first turn running the agent's
   * defaults instead. Reading is pure memory, same as `agentCatalog`.
   */
  private displayedChatDefaults(agentId: string): DisplayedChatDefaults | undefined {
    const catalog = this.catalogs.get(agentId)?.catalog
    if (catalog === undefined) return undefined
    const out: DisplayedChatDefaults = {}
    const model = catalog.model?.currentValue
    if (model !== null && model !== undefined && model !== '') {
      out.modelId = buildAdapterModelId(agentId, model)
    }
    // Only the level the chip itself reports: `reasoningMeta` keeps
    // `defaultEffort` only when the current value is one of the agent's levels.
    const effort = this.reasoningMeta(agentId)?.defaultEffort
    if (effort !== undefined) out.effort = effort
    // The mode select's pre-first-message value is the catalog's last-known
    // mode (the agent's own answer from another session), and `session/new`
    // starts on whatever the agent itself defaults to. Without capturing it,
    // a conversation whose select reads "Bypass Permissions" would run its
    // first turn on "Always Ask" — the same display/run split the model and
    // thought level are seeded for.
    const mode = catalog.mode?.currentValue
    if (mode !== null && mode !== undefined && mode !== '') out.mode = mode
    const extraConfigs: Record<string, string | boolean> = {}
    for (const option of catalog.extras ?? []) {
      const value = option.currentValue
      if (option.kind === 'boolean') {
        // The catalog encodes a toggle as 'true' / 'false'; the pick stores the
        // real boolean, exactly like an explicit checkbox click.
        if (value === 'true' || value === 'false') extraConfigs[option.configId] = value === 'true'
        continue
      }
      if (value !== null && value !== undefined && value !== '') extraConfigs[option.configId] = value
    }
    if (Object.keys(extraConfigs).length > 0) out.extraConfigs = extraConfigs
    return Object.keys(out).length === 0 ? undefined : out
  }

  /**
   * Record what the composer showed as this conversation's pick before the
   * first prompt runs.
   *
   * A conversation with no explicit pick displays the agent catalog's current
   * model / thought level / mode / extras, while the ACP session `session/new`
   * just created starts on whatever the agent itself defaults to. Without this
   * the user is shown one model and the agent runs another — the defect
   * reported as "the displayed model was not used", and the reported first
   * turn that ignored the mode select's value. Values the fresh session does
   * not offer are skipped (its `configOptions` are the authority, and the
   * catalog update that rode `session/new` will correct the display), never
   * turned into a failed first turn. Explicit picks always win: only missing
   * fields are filled.
   */
  private seedChatChoiceFromCatalog(
    dshSessionId: string,
    agentId: string,
    session: LiveSession,
    displayed: DisplayedChatDefaults | undefined,
  ): void {
    if (displayed === undefined) return
    const current = this.chatAgentIntent.get(dshSessionId)
    if (current !== undefined && current.agentId !== agentId) return
    const options = parseCatalogOptions(session.configOptions)
    const patch: Partial<AcpConversationChoice> = { agentId }
    let changed = false
    const model = options.model
    if (current?.modelId === undefined && displayed.modelId !== undefined && model !== undefined) {
      const value = splitAdapterModelId(displayed.modelId).choice
      if (value !== undefined && (model.choices.length === 0 || model.choices.some(choice => choice.value === value))) {
        patch.modelId = displayed.modelId
        changed = true
      }
    }
    const thought = options.thought
    // `reasoning.defaultEffort` was observed on whichever model the agent was
    // last on, and the composer only shows it as THIS conversation's default
    // when the route resolves to that same model (see `describeRoute`). A model
    // picked before the first message makes the old default the previous
    // model's level: seeding it would run a value the chip never showed.
    const pickedModelValue = current?.modelId === undefined ? undefined : splitAdapterModelId(current.modelId).choice
    const displayedModelValue = displayed.modelId === undefined ? undefined : splitAdapterModelId(displayed.modelId).choice
    // A catalog that cannot name its model proves nothing about an explicitly
    // picked one; only "no model picked" (the bare route / agent's own model)
    // is safe there. Mirrors `describeRoute`.
    const effortAppliesToDisplayedModel = pickedModelValue === undefined
      || (displayedModelValue !== undefined && pickedModelValue === displayedModelValue)
    if (current?.effort === undefined && displayed.effort !== undefined && thought !== undefined
      && effortAppliesToDisplayedModel) {
      if (thought.choices.length === 0 || thought.choices.some(choice => choice.value === displayed.effort)) {
        patch.effort = displayed.effort
        changed = true
      }
    }
    // The mode is the third axis of the same contract. The select's value
    // before the first message is the catalog's last-known mode; `session/new`
    // answers with the agent's own default. Seed the displayed one when the
    // fresh session still offers it — an agent that publishes no `modes`
    // field is applied best-effort, exactly like `applyChatChoice`.
    const displayedMode = displayed.mode
    const offeredModes = session.modes?.availableModes ?? []
    if (current?.mode === undefined && displayedMode !== undefined
      && (offeredModes.length === 0 || offeredModes.some(entry => entry.id === displayedMode))) {
      patch.mode = displayedMode
      changed = true
    }
    if (displayed.extraConfigs !== undefined) {
      const extraConfigs = { ...(current?.agentId === agentId ? current.extraConfigs : undefined) }
      for (const [configId, value] of Object.entries(displayed.extraConfigs)) {
        if (extraConfigs[configId] !== undefined) continue
        const option = options.extras?.find(entry => entry.configId === configId)
        if (option === undefined) continue
        // The fresh session's own option set is the authority for BOTH forms:
        // a toggle must still be a toggle, a select must still offer the value.
        if (option.kind === 'boolean'
          ? typeof value !== 'boolean'
          : typeof value !== 'string' || (option.choices.length > 0 && !option.choices.some(choice => choice.value === value))) continue
        extraConfigs[configId] = value
        changed = true
      }
      if (Object.keys(extraConfigs).length > 0) patch.extraConfigs = extraConfigs
    }
    if (!changed) return
    this.patchChatChoice(dshSessionId, patch)
  }

  async getOrCreateDshSession(dshSessionId: string | undefined, agentId: string, cwd?: string): Promise<LiveSession> {
    // The lock also guards the TURN path, not just the picker: a stale request
    // header or a route rewrite must not start a second, context-less session
    // with another agent under the same conversation.
    if (dshSessionId !== undefined) {
      const lockedTo = this.lockedAgentFor(dshSessionId)
      if (lockedTo !== undefined && lockedTo !== agentId) {
        throw new AcpError(
          'agent_locked',
          `acp: conversation is locked to agent "${lockedTo}" once its first turn has started; start a new conversation to use another agent`,
        )
      }
    }
    const key = `${dshSessionId ?? 'ephemeral'}:${agentId}`
    const existing = this.dshSessionMap.get(key)
    if (existing !== undefined && !existing.closed && !existing.released) {
      const owner = this.bridgeOwning(agentId, existing.sessionId)
      // A LIVE record must have a holder. This state is not reachable today:
      // every production deletion path parks the record first (`closeSession` /
      // `forceReset` set `closed`, a failed resume sets `released`), so only the
      // test suite synthesizes a live record without an owner to pin this
      // fallback. Should it ever happen anyway, returning the record would route
      // the next prompt to a process that no longer exists — the failure would
      // surface later as a dead `acpSessionId`, far from its cause. Drop the
      // unusable record and fail cleanly; the next attempt starts fresh.
      if (owner === undefined) {
        this.forgetDshSession(existing.sessionId)
        throw new AcpError(
          'session_orphaned',
          `acp: the session for this conversation has no live agent process; send again to start a new one`,
        )
      }
      // A resume may be in flight right now: `doResumeSession` clears `released`
      // before `session/load` and only registers the session after it answers,
      // so this record is momentarily owned by that request alone. Await it and
      // reuse the SAME session — never forget the record, and never let a second
      // ACP session be created on the same holder.
      const inflight = owner.inflightResume(existing.sessionId)
      const ready = inflight === undefined ? existing : await inflight
      // An existing session already carries context, so this is never a
      // provisional lock; it only repairs a record from before the flag (the
      // next turn's start writes/announces the lock).
      if (dshSessionId !== undefined) this.lockChatAgent(dshSessionId, agentId)
      return ready
    }
    // The session's agent died earlier: resume in place so the conversation
    // context survives via `session/load`.
    if (existing !== undefined && existing.released) {
      // The bridge that parked this record owns the resume; a chat conversation
      // falls back to the scope its DSH id names, exactly like the `new`
      // branch. Without a DSH id the old anonymous bucket stays as it was.
      const resumeBridge = this.bridgeOwning(agentId, existing.sessionId)
        ?? (dshSessionId === undefined
          ? this.bridge(agentId)
          : this.bridgeFor(agentId, { kind: 'chat', dshSessionId }))
      const resumed = await resumeBridge.resumeSession(existing)
      // Rebind explicitly: a resume keeps the record's identity, but the chat
      // session id is what the conversation's permission card addresses.
      resumed.dshSessionId = dshSessionId
      // A resume without an explicit pick must keep serving the agent the
      // conversation was ON (its own model string when one was recorded). The
      // recorded pick wins when there is one (it carries the model half).
      if (dshSessionId !== undefined) {
        this.lockChatAgent(dshSessionId, agentId)
        if (this.chatAgentIntent.has(dshSessionId)) this.syncConversationRoute(dshSessionId)
        else routeBindingRegistry().conversations.set(dshSessionId, resumed.modelId ?? agentId)
      }
      // ...and the persisted pick (model / thought level) is re-applied to the
      // freshly loaded session, whose config comes back at the agent's defaults.
      await this.applyChatChoice(resumed)
      // A RESUMED session had context before this call; a lock written here is
      // not provisional even if the conversation record was missing it.
      resumed.provisionalLock = false
      // The load refreshed the record's mirrors (modes / usage / hasHistory);
      // persist so a later restart restores what this resume saw.
      this.persistAgents()
      return resumed
    }
    // A chat session runs where its DSH session lives, not in the plugin's
    // sandbox directory: the sidebar's workspace selection IS the session's
    // workspace (`sandboxPolicy.resolve` reports it as `workspaceRoot`), and an
    // agent whose cwd is `~/.dsh/dsh-ntr/workspaces` answers "current workspace"
    // with that path while its Read/Glob/Bash cannot see the user's project.
    // That root is trusted on top of the agent's own roots for this session
    // only (see `chatWorkspaceRoot`); the fallback is the configured cwd.
    const workspaceRoot = chatWorkspaceRoot(this.sessionWorkspaceResolver, dshSessionId)
    // What the composer is showing right now. Must be read BEFORE `session/new`:
    // creating the session absorbs its defaults into the catalog, which would
    // overwrite exactly the values the user saw and bring back "displayed one
    // model, ran another". See `displayedChatDefaults`.
    const displayed = dshSessionId === undefined ? undefined : this.displayedChatDefaults(agentId)
    // A1: each chat conversation gets its own process; a call without a DSH id
    // shares the anonymous bucket, exactly like the old `ephemeral:<agent>` key.
    const scope: BridgeScope = dshSessionId === undefined
      ? { kind: 'ephemeral', token: 'anonymous' }
      : { kind: 'chat', dshSessionId }
    const session = await this.bridgeFor(agentId, scope).createSession(
      workspaceRoot ?? cwd,
      workspaceRoot === undefined ? [] : [workspaceRoot],
      // ...and the agent PROCESS runs there too, not just the session: see
      // `ensureReady` for why `session/new`'s cwd alone is not enough.
      workspaceRoot,
    )
    // Absent for `/acp`-RPC sessions and for adapter calls without a chat
    // session; their permission cards are addressed by the ACP session only.
    session.dshSessionId = dshSessionId
    this.dshSessionMap.set(key, session)
    // Turn the displayed defaults into this conversation's pick, so the first
    // prompt runs on what the user was shown (see `seedChatChoiceFromCatalog`).
    if (dshSessionId !== undefined) this.seedChatChoiceFromCatalog(dshSessionId, agentId, session, displayed)
    // Pin what this conversation now runs on, so a route that does not name it
    // (a fresh session replays the deployment default) is rewritten to reality.
    // The recorded pick wins when there is one (it carries the model half);
    // otherwise the agent that just served this turn is pinned bare.
    if (dshSessionId !== undefined) {
      if (this.chatAgentIntent.has(dshSessionId)) this.syncConversationRoute(dshSessionId)
      else routeBindingRegistry().conversations.set(dshSessionId, agentId)
    }
    // Apply whatever the conversation picked BEFORE this session existed — the
    // model and thought level chosen in the composer ahead of the first message.
    // `session/new` answered with the agent's defaults; without this the first
    // turn would run on them and the pick would only take effect afterwards.
    await this.applyChatChoice(session)
    if (dshSessionId !== undefined) {
      // The first ACP session is the moment the conversation's context starts
      // belonging to this agent. The lock is PROVISIONAL until this turn shows
      // something: if it delivers nothing, `rollbackFirstTurn` gives the
      // conversation back (a failed first attempt must not trap it).
      session.provisionalLock = this.lockChatAgent(dshSessionId, agentId)
    }
    // The record is on disk from here: a host restart restores it as parked
    // instead of the next message starting a context-less new session.
    this.persistAgents()
    return session
  }

  /**
   * Take the agent process back from a turn the stall watchdog abandoned.
   *
   * The wedged agent still holds its `session/prompt`, so the next message
   * cannot simply be sent: it would queue behind a turn that may never answer.
   * The process is restarted instead — unless another conversation on the same
   * connection is doing real work, because killing the child destroys THEIR
   * context too, and "retry after they finish" is the honest answer.
   *
   * A restart that can `session/load` costs the conversation nothing: the
   * session is parked `released` and the normal acquisition path resumes it, so
   * chat keeps its lock / `applyChatChoice` semantics and `/acp` keeps
   * `locateOrResume`. An agent without resume support is reset instead, and the
   * user is told the context is gone.
   */
  private async prepareStalledSession(session: LiveSession): Promise<{ ok: true; reset?: boolean } | { ok: false; message: string }> {
    // A session whose `session/close` is still in flight must not be touched:
    // releasing it would park it as resumable and `doResumeSession` flips
    // `closed` back to false, resurrecting a closed session. Its owner deletes
    // the record; the caller's own acquisition creates a new session (chat) or
    // rejects `session_closed` (`/acp`).
    if (session.closed) return { ok: true }
    if (session.released) return { ok: true } // the acquisition resumes it
    const bridge = this.bridgeForSession(session)
    const blocked = `acp: agent "${session.agentId}" is unresponsive, but other conversations are still using it; retry after they finish`
    if (bridge.hasOtherActiveWork(session)) return { ok: false, message: blocked }
    // A sibling conversation the agent already settled is not "work" by
    // `hasOtherActiveWork` — but its HOST may still owe the turn a
    // continuation step (a card it is executing right now), and restarting the
    // process would park and resume that live turn. Its indexed controller is
    // the evidence. Scoped to THIS bridge: the restart kills this bridge's
    // child only, so a sibling conversation on another process (A1) is not a
    // reason to refuse, and a controller of another agent's session never was.
    // A closed or released session has no host behind it (a leftover
    // controller), so it does not pin the child either.
    const owned = this.sessionIdsOf(bridge)
    for (const controller of this.turnStreams.values()) {
      if (controller.session === session) continue
      if (!owned.has(controller.session.sessionId)) continue
      if (controller.session.closed || controller.session.released) continue
      if (!controller.stale) return { ok: false, message: blocked }
    }
    const capabilities = bridge.view().agentCapabilities as { loadSession?: boolean } | undefined
    if (capabilities?.loadSession === true) {
      // Whatever teardown runs, the agent's in-flight `session/prompt` is about
      // to be rejected by the closing connection. Mark the generation so that
      // rejection does not broadcast a second `turn/end` for a turn already
      // finalized by the watchdog (`LiveSession.reclaimedTurnSeq`).
      session.reclaimedTurnSeq = session.turnSeq
      bridge.releaseAll('agent did not acknowledge the stalled turn', 'stalled')
      session.orphanPromptTurnSeq = undefined
      return { ok: true }
    }
    // No resume: the restart IS a reset, so only this session's context is at
    // stake — and any other live session pins the process even while idle.
    if (bridge.sessionList.some(other => other !== session)) return { ok: false, message: blocked }
    const agentId = session.agentId
    // `stop` would ask a wedged agent to close its sessions and wait for an
    // answer that never comes; `forceReset` is the local half only.
    session.reclaimedTurnSeq = session.turnSeq
    bridge.forceReset('agent-stopped')
    this.forgetDshSession(session.sessionId)
    session.orphanPromptTurnSeq = undefined
    this.hub.broadcast({
      type: 'agent/notice',
      agentId,
      level: 'info',
      text: `acp: agent "${agentId}" does not support session resume; the ACP session was reset (context could not be restored)`,
    })
    return { ok: true, reset: true }
  }

  /**
   * 聊天插话的槽位回收：宿主把插话作为同一会话在飞回合的下一步送达，
   * 拒绝会让整条 host turn 失败。ACP 不能向运行中的 prompt 注入消息，
   * 所以按插话语义中止当前回合，等 agent 真正结算后再让调用方重发。
   *
   * 只处理 `claimTurn` 的 `busy`（agent 仍持有本会话 prompt）；`unsettled`
   * 说明我们这一侧已经释放过槽位（用户按过停止），保持原样拒绝。
   *
   * - 控制器已 settle（响应已到，延后收口还没释放闸门）：什么都不取消，只等闸门；
   * - agent 真在跑：走用户取消同一条管线（session/cancel + 结算权限 + cancel fallback），
   *   并立即关闭宿主这一侧的 segment，让闸门在 agent 应答/兜底后打开。
   */
  private async reclaimChatPrompt(
    session: LiveSession,
    controller: TurnStreamController,
    signal?: AbortSignal,
  ): Promise<'ok' | 'aborted'> {
    if (session.closed || session.released) return 'ok'
    if (!controller.hasSettled && session.promptInFlight === true) {
      await this.bridgeForSession(session).cancel(session)
      controller.abortActiveSegment()
    }
    return this.waitForSettleGate(session, signal)
  }

  /** 等 agent 侧 prompt slot 真正释放；步骤被取消时立即返回 aborted。 */
  private waitForSettleGate(session: LiveSession, signal?: AbortSignal): Promise<'ok' | 'aborted'> {
    const pending = session.settled
    if (pending === undefined) return Promise.resolve('ok')
    if (signal?.aborted) return Promise.resolve('aborted')
    return new Promise(resolve => {
      const done = (value: 'ok' | 'aborted'): void => {
        signal?.removeEventListener('abort', onAbort)
        resolve(value)
      }
      const onAbort = (): void => { done('aborted') }
      signal?.addEventListener('abort', onAbort, { once: true })
      void pending.then(() => { done('ok') })
    })
  }

  async *streamPrompt(options: GenerateOptions): AsyncIterable<StreamChunk> {
    // The plugin's own conversation↔agent mapping decides who serves the turn
    // (see `bindChatAgent`): the driver may arrive here with the previous
    // agent's id (the logged request header replays) or a session that has
    // never run an ACP turn at all. An explicit binding outranks it.
    //
    // A LOCKED conversation outranks even that: its agent is the one holding
    // the context, so the turn must not be redirected by a stale header, a
    // route registry entry purged by a delete/re-add, or the deployment
    // default. The persisted model half is used when the route no longer names
    // the locked agent.
    const lockedTo = options.sessionId === undefined ? undefined : this.lockedAgentFor(options.sessionId)
    const routed = options.sessionId === undefined ? undefined : this.conversationRouteModel(options.sessionId)
    const model = options.sessionId === undefined
      ? options.model
      : lockedTo !== undefined
        ? (routed !== undefined && splitAdapterModelId(routed).agentId === lockedTo
          ? routed
          : this.chatChoice(options.sessionId)?.modelId ?? lockedTo)
        : routed ?? options.model
    const { agentId, choice } = splitAdapterModelId(model)
    const def = this.defsMap.get(agentId)
    if (def === undefined) {
      yield {
        type: 'finish',
        reason: { kind: 'error', failure: { message: `acp: agent "${agentId}" is not configured`, code: 'unknown_agent' } },
      }
      return
    }

    // Auxiliary host calls (`session-title`, `compaction`) ride the session's
    // logged route, so they reach this adapter looking like a turn. They are not
    // conversation: forwarding one would spend a remote agent turn on a title
    // prompt, or worse, fold it into the ACP agent's own context.
    if (options.purpose !== undefined) {
      // A title call carries the session's human messages as a JSON array (the
      // host's `dsh-session-title-llm` prompt). Answer it locally by folding
      // the first one back as the placeholder title: no ACP turn, no bridge
      // session, and the sidebar gets a title even on hosts whose own text
      // fallback never fires (issue #11, DSH 2.0.22-next). The settings
      // toggle opts the placeholder into the badge prefix; the host accepts
      // it as the title's newest revision either way.
      if (options.purpose === 'session-title') {
        const title = extractSessionTitlePlaceholder(
          options.messages ?? [],
          this.sessionTitlePrefixEnabled ? SESSION_TITLE_PREFIX : '',
        )
        if (title !== undefined) {
          yield { type: 'block-start', index: 0, blockType: 'text' }
          yield { type: 'text-delta', index: 0, text: title }
          yield { type: 'block-end', index: 0, block: { type: 'text', text: title } }
          yield { type: 'finish', reason: { kind: 'stop' } }
          return
        }
      }
      // Compaction — and a title prompt we cannot parse — stays refused before
      // touching (or spawning) anything: compaction is best-effort, and an
      // unparseable title keeps the old refusal so the host can fall back.
      yield {
        type: 'finish',
        reason: {
          kind: 'error',
          failure: {
            message: `acp: "${options.purpose}" is an auxiliary harness call, not a conversation turn — an ACP agent cannot serve it`,
            code: 'unsupported_purpose',
          },
        },
      }
      return
    }

    // A segmented tool-bearing turn arrives as MANY driver steps. The host
    // loop starts a next step whenever the settled assistant message contains
    // `tool-call` blocks — which is exactly what the ACP agent's cards are —
    // feeding it the staged tool results. Each such step RESUMES the same
    // in-flight `session/prompt` from the transcript cursor: nothing is sent
    // to the ACP agent (it runs its own loop inside ONE prompt call — see
    // `isAcpToolContinuation` and docs/acp-convergence.md §1.7).
    if (isAcpToolContinuation(options.messages ?? [])) {
      const controller = options.sessionId === undefined ? undefined : this.turnStreamFor(options.sessionId)
      if (controller === undefined || controller.stale) {
        // No in-flight turn of ours owns these staged results (a foreign
        // continuation, or one that outlived its turn): answer with one
        // closing message instead of touching the agent.
        const line = `\n[dsh-ntr] this conversation has no in-flight ACP turn to resume; the tool details are in the ACP transcript view.\n`
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text: line }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: line } }
        yield { type: 'finish', reason: { kind: 'stop' } }
        return
      }
      const segment = controller.startSegment()
      const onAbort = () => {
        void this.bridgeForSession(controller.session).cancel(controller.session)
        controller.abortActiveSegment()
      }
      if (options.signal?.aborted) onAbort()
      else options.signal?.addEventListener('abort', onAbort, { once: true })
      try {
        yield* segment.queue
      } finally {
        options.signal?.removeEventListener('abort', onAbort)
        // The FINAL continuation step retires the controller: settle ran, this
        // segment closed, and no further continuation can come for its cards.
        if (controller.hasSettled && segment.finished) controller.dispose()
      }
      return
    }

    // Forward the person's own words: the host folds its context sections
    // (AGENTS.md digest, skill catalog, runtime snapshot) after the claimed user
    // batch precisely so a consumer can tell them apart by `source` — see
    const workspaceRoot = chatWorkspaceRoot(this.sessionWorkspaceResolver, options.sessionId)
    const defaultReadFile = (p: string) => {
      try {
        if (existsSync(p)) return readFileSync(p)
        if (workspaceRoot !== undefined && !isAbsolutePath(p)) {
          const joined = join(workspaceRoot, p)
          if (existsSync(joined)) return readFileSync(joined)
        }
      } catch {}
      return undefined
    }

    const resolver = this.attachmentResolver
    const attachmentContext = resolver !== undefined && typeof resolver === 'object' && resolver !== null
      ? Object.assign(Object.create(resolver), {
          readFile: (p: string) => {
            if (typeof (resolver as { readFile?: unknown }).readFile === 'function') {
              try {
                const res = (resolver as { readFile: (p: string) => unknown }).readFile(p)
                if (res !== undefined) return res
              } catch {}
            }
            return defaultReadFile(p)
          },
        })
      : {
          readFile: defaultReadFile,
        }

    const selection = selectForwardPrompt(options.messages ?? [], attachmentContext)
    if (selection.kind === 'no-user-input') {
      // An injected-context wake: nothing the user said, nothing to send.
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }
    if (selection.kind === 'empty') {
      yield {
        type: 'finish',
        reason: {
          kind: 'error',
          failure: { message: 'acp: this request carries no user message to forward', code: 'empty_prompt' },
        },
      }
      return
    }

    let session: LiveSession
    // Same key `getOrCreateDshSession` looks up: a session the watchdog left
    // orphaned must be reclaimed BEFORE the acquisition, so this message cannot
    // queue behind a prompt the agent will never answer.
    const stalled = this.dshSessionMap.get(`${options.sessionId ?? 'ephemeral'}:${agentId}`)
    if (stalled !== undefined && stalled.orphanPromptTurnSeq !== undefined) {
      const prepared = await this.prepareStalledSession(stalled)
      if (!prepared.ok) {
        yield {
          type: 'finish',
          reason: { kind: 'error', failure: { message: prepared.message, code: 'agent_unresponsive' } },
        }
        return
      }
    }
    try {
      session = await this.getOrCreateDshSession(options.sessionId, agentId)
    } catch (err) {
      yield {
        type: 'finish',
        reason: { kind: 'error', failure: { message: describeError(err), code: 'session_init_failed' } },
      }
      return
    }

    // The bridge that owns THIS session, not the agent's first slot: an A1
    // agent keeps one process per conversation. Re-resolved through
    // `bridgeForSession` at EVERY use below — a first-turn rollback can close
    // this session and prune its holder (`rollbackFirstTurn` → `pruneBridge`),
    // and a bridge captured once would then `claimTurn` / `beginTurn` /
    // `runPrompt` on a dead object.

    // The model the conversation asks for is not one this agent offers any
    // more: refuse BEFORE sending anything. Falling back to "whatever the agent
    // runs" would silently spend the user's turn on a model they did not
    // choose (different price and capability); the pick is kept so the error
    // and the chip both name the selection that must be replaced.
    const blockedModel = this.staleModelChoice(session, choice)
    if (blockedModel !== undefined) {
      // Nothing was exchanged, so a provisional first turn must hand the
      // conversation back (same rule as any other zero-output failure).
      if (session.provisionalLock === true) this.rollbackFirstTurn(session)
      yield {
        type: 'finish',
        reason: {
          kind: 'error',
          failure: {
            message: `acp: the selected model "${blockedModel}" is not offered by agent "${agentId}" any more; choose another model and send again`,
            code: 'model_unavailable',
          },
        },
      }
      return
    }

    const hasImages = (selection.images?.length ?? 0) > 0 || (selection.content?.some(b => b.type === 'image') ?? false)
    if (hasImages && this.bridgeForSession(session).initResult?.agentCapabilities?.promptCapabilities?.image !== true) {
      if (session.provisionalLock === true) this.rollbackFirstTurn(session)
      yield {
        type: 'finish',
        reason: {
          kind: 'error',
          failure: {
            message: `acp: agent "${agentId}" does not support image input`,
            code: 'image_unsupported',
          },
        },
      }
      return
    }

    // One prompt slot per session, and a turn the user aborted still occupies
    // the AGENT's slot until it acknowledges the cancel (see `claimTurn`).
    let claim = await this.bridgeForSession(session).claimTurn(session)
    if (!claim.ok) {
      // A STEER ("插话"): the host delivers the user's mid-turn message as the
      // NEXT step of the SAME host turn, so the conversation's own ACP prompt
      // is still on air. Refusing would fail the whole host turn. ACP forbids
      // injecting into a running prompt, so the steer's real semantic — abort
      // the current turn, then send this one — is spelled cancel + wait +
      // re-claim here.
      //
      // Only `busy` can be a steer: it means the AGENT still holds OUR prompt
      // (`promptInFlight`). `unsettled` means our side already released the
      // slot (the person pressed stop, or an earlier steer cancelled): the
      // agent has not acknowledged yet, and quietly queueing the next message
      // behind a turn the user stopped is not this path's business — that
      // stays the honest `turn_in_flight` refusal below.
      //
      // Only the conversation's OWN in-flight turn qualifies (its live stream
      // controller, on this very session). A `/acp` RPC turn has no chat
      // controller, and another conversation never reaches this session, so
      // both keep the plain refusal: nothing may be cancelled behind a
      // caller's back.
      const chatController = claim.reason === 'busy' && options.sessionId !== undefined
        ? this.turnStreamFor(options.sessionId)
        : undefined
      if (options.sessionId !== undefined
        && chatController !== undefined
        && !chatController.stale
        && chatController.session === session) {
        const reclaimed = await this.reclaimChatPrompt(session, chatController, options.signal)
        if (reclaimed === 'aborted') {
          // The person pressed stop while the previous turn was winding down:
          // the steer is theirs to re-send, nothing goes to the agent.
          yield {
            type: 'finish',
            reason: { kind: 'aborted', failure: { message: 'aborted', code: 'ABORTED' } },
          }
          return
        }
        // A first turn that produced nothing rolled its provisional lock back
        // and CLOSED (and forgot) this session: the steer needs a fresh one.
        if (session.closed || session.released) {
          try {
            session = await this.getOrCreateDshSession(options.sessionId, agentId)
          } catch (err) {
            yield {
              type: 'finish',
              reason: { kind: 'error', failure: { message: describeError(err), code: 'session_init_failed' } },
            }
            return
          }
        }
        // Re-resolve: the rollback above may have closed the old session AND
        // pruned its holder, and `getOrCreateDshSession` may have built a fresh
        // one under a new bridge.
        claim = await this.bridgeForSession(session).claimTurn(session)
      }
      if (!claim.ok) {
        // Never roll the provisional lock back here: a failed claim means
        // ANOTHER prompt holds the slot (or the agent has not settled it), and
        // that turn owns the conversation's lock. Closing the session would
        // kill a turn that is actively streaming — the refusal already tells
        // the user to retry.
        yield {
          type: 'finish',
          reason: {
            kind: 'error',
            failure: {
              message: claim.reason === 'busy'
                ? 'acp: this session already has a prompt in flight'
                : 'acp: the agent is still finishing the previous (cancelled) turn; send again in a moment',
              code: 'turn_in_flight',
            },
          },
        }
        return
      }
    }

    // Same-agent model/effort switches ride the SAME ACP session (context
    // stays continuous); switching to another agent lands in a separate one
    // via the `${dshSessionId}:${agentId}` key in getOrCreateDshSession.
    // An adapter-DEFAULTED effort is not a choice (see `modelDefaultEffort`):
    // recording or re-applying one would revert the seat's own pick.
    const requestedEffort = options.reasoningEffort
    const turnEffort = requestedEffort !== undefined && requestedEffort === this.modelDefaultEffort(agentId)
      ? undefined
      : requestedEffort
    const aligned = await this.alignSessionConfig(session, choice, turnEffort)
    // The config may have changed between the pre-flight check and this
    // alignment (a `config_option_update` landed in that window). Same rule:
    // never run a model the user did not select.
    if (aligned.modelStale) {
      if (session.provisionalLock === true) this.rollbackFirstTurn(session)
      yield {
        type: 'finish',
        reason: {
          kind: 'error',
          failure: {
            message: `acp: the selected model "${choice ?? ''}" is not offered by agent "${agentId}" any more; choose another model and send again`,
            code: 'model_unavailable',
          },
        },
      }
      return
    }
    // Record what this conversation is now on, so `session/chat-list` can show
    // it without the browser having to derive it from anything else. A
    // materialized-default effort leaves the recorded pick standing: the agent
    // still runs it (the align above was skipped), and erasing it would make
    // the chip claim "default" for a conversation the user explicitly tuned.
    //
    // A BARE route (`agentId`, "let the agent choose") must not overwrite the
    // conversation's own pick: `applyChatChoice` just aligned the session to
    // the value the composer showed (including the defaults seeded for a fresh
    // conversation), and recording the bare id instead sends the model chip
    // back to the agent-level catalog — which any other conversation of the
    // same agent can move.
    const recorded = options.sessionId === undefined ? undefined : this.chatChoice(options.sessionId)
    const recordedModel = recorded !== undefined && recorded.agentId === agentId ? recorded.modelId : undefined
    // No pick at all: report the model the session itself is on (the agent's
    // own default), never the bare route — a bare id would make the chip read
    // the agent-level catalog, which other conversations can move.
    const liveModel = parseCatalogOptions(session.configOptions).model?.currentValue
    const fallbackModel = liveModel !== null && liveModel !== undefined && liveModel !== ''
      ? buildAdapterModelId(agentId, liveModel)
      : model
    const effectiveModel = choice !== undefined ? model : recordedModel ?? fallbackModel
    session.modelId = effectiveModel
    session.choice = choice ?? splitAdapterModelId(effectiveModel).choice
    if (aligned.effortStale) session.reasoningEffort = undefined
    else if (turnEffort !== undefined) session.reasoningEffort = turnEffort

    const promptText = selection.text

    // Re-resolve the ACP-preset verdict every turn (a switch made mid-
    // conversation must land on the next prompt). It is a report for the browser
    // surfaces, not a policy switch: the host arbitrates nothing about the
    // agent's own permissions (see docs/acp-convergence.md §2.3).
    if (session.dshSessionId !== undefined) {
      const resolved = await this.acpModeResolver?.(session.dshSessionId)
      session.acpMode = resolved === true
      // This turn may log an `agent-preset/selected` (a blank-session
      // recompose) and any persistence read observed the log BEFORE it: drop
      // the cached verdict so a later ask re-reads against the moved log.
      this.invalidateAcpMode(session.dshSessionId)
    } else {
      session.acpMode = false
    }

    session.running = true
    session.turnSeq += 1
    const turnGen = session.turnSeq
    session.lastAgentActivityAt = Date.now()
    session.activeToolCalls.clear()
    // A new turn owns the session from here: any reclaim marker named an
    // earlier generation and must not suppress THIS turn's settle.
    session.reclaimedTurnSeq = undefined
    this.armStallTimer()
    const turnId = randomUUID()
    this.hub.broadcast({ type: 'turn/start', sessionId: session.sessionId, turnId, text: promptText })

    // The segmented turn: ONE controller for the whole agent-side prompt, one
    // segment per driver step. The first segment streams until a card-bearing
    // stretch meets the next non-tool event (or the prompt settles); the host
    // loop then executes the card and proposes the continuation step, which
    // resumes the SAME prompt through the branch above.
    const endTurn = this.bridgeForSession(session).beginTurn(session)
    const controller = new TurnStreamController(
      this,
      this.hub,
      session,
      turnId,
      endTurn,
      victim => this.rollbackFirstTurn(victim),
    )
    if (session.dshSessionId !== undefined) this.rememberTurnStream(session.dshSessionId, controller)
    // The session itself carries the controller too: an EPHEMERAL turn
    // (`options.sessionId === undefined`) has no chat id to index under, and
    // the stall watchdog needs SOME route to the controller to close the
    // driver's segment queue. For chat turns this also disambiguates a chat id
    // two LiveSessions briefly share (a concurrent first turn). Assigned AFTER
    // `rememberTurnStream` so the controller it just retired cannot clear this
    // attachment.
    session.turnController = controller
    const segment = controller.startSegment()
    const onAbort = (): void => {
      if (controller.stale) return
      // Re-resolve, but through `bridgeOwning`: an abort must never CREATE
      // a process for a session whose holder was pruned (a rolled-back first
      // turn), and a missing owner means there is nothing left to cancel.
      const owner = this.bridgeOwning(session.agentId, session.sessionId)
      if (owner !== undefined) void owner.cancel(session)
      controller.abortActiveSegment()
    }

    if (options.signal?.aborted) {
      onAbort()
    } else {
      options.signal?.addEventListener('abort', onAbort, { once: true })
      // The agent-side turn is in flight from here until its response lands
      // (or the connection dies): that window, not our own stream, is what the
      // next turn has to respect. Settlement reaches the controller, which
      // releases the slot (`endTurn`) whether the segment on air is the first
      // or a continuation one.
      const promptBlocks: ContentBlock[] = selection.content && selection.content.length > 0
        ? selection.content as ContentBlock[]
        : [{ type: 'text', text: promptText }]

      const promptBridge = this.bridgeForSession(session)
      promptBridge.runPrompt(session, promptBlocks, turnId, turnGen)
        .then(result => {
          // The reclaim already ended this turn locally, and the close it
          // performed rejected this very request: the late answer is that same
          // turn, not a second one to broadcast.
          if (session.reclaimedTurnSeq === turnGen) {
            session.reclaimedTurnSeq = undefined
            return
          }
          const responseMeta = codebuddyMetaOf({ _meta: result.meta })
          // A RATE-LIMIT REFUSAL: the agent answered the prompt and declined
          // the work because the account is over its quota. CodeBuddy says so
          // with `stopReason: 'refusal'` plus a quota detail in the response
          // `_meta` — a RESOLVED response, so no error path and no
          // `describeError` ever sees the reason. Ranked BEFORE the hold /
          // ambient branches below: a refused turn has no answer coming, so
          // holding it open for a background run would wait on work the agent
          // just said it will not do.
          const refusal = result.stopReason === 'refusal' ? agentRefusalDetail(result.meta) : undefined
          if (refusal?.kind === 'quota') {
            // The dock card reads this through `snapshot()`, so publish it
            // BEFORE the turn ends: a browser that renders the card off
            // `turn/end` must already know why the turn failed.
            session.quotaRefusal = { message: refusal.message, at: Date.now() }
            this.hub.broadcast({ type: 'session/meta', sessionId: session.sessionId, session: snapshot(session) })
            controller.settle({
              kind: 'error',
              message: rateLimitedTurnError(agentId, refusal),
              code: 'rate_limited',
              errorKind: 'quota',
            })
            return
          }
          // Any other answer — a normal turn, a plain refusal, a hold, an
          // ambient fold — means the quota is no longer what stopped this
          // session: the banner must not outlive the evidence for it.
          if (session.quotaRefusal !== undefined) {
            session.quotaRefusal = undefined
            this.hub.broadcast({ type: 'session/meta', sessionId: session.sessionId, session: snapshot(session) })
          }
          // A DETACHED-WORKER DRAIN: every dispatched worker already reported
          // and the drain that carries its report is imminent, so keep this
          // turn open for that last window (see `holdForBackgroundDispatch`).
          // A worker STILL RUNNING does NOT hold the turn: the user keeps
          // talking, and the worker's report lands in the transcript / NTR
          // view when it finishes (CodeBuddy's own "已派…" answer closes here).
          //
          // The decision comes BEFORE `adoptTurnRequestId`: adopting the id
          // would clear the updates the drain streamed while this turn's own id
          // was unknown, and those are exactly the ones the hold must fold.
          const holdDispatch = controller.detachedHoldWanted(this.tuning.backgroundHoldWorkerPhase === true)
            && !session.released
            && !session.closed
            && result.stopReason !== 'cancelled'
          if (!holdDispatch && responseMeta?.conversationRequestId !== undefined) {
            // The response names the conversation turn it queued: an instant
            // answer that still carries one is a real (if silent) turn, and its
            // prose can be told apart from a background drain's.
            controller.adoptTurnRequestId(responseMeta.conversationRequestId)
          }
          // An announced drain that has shown NO sign of life for the staleness
          // window is over, even though nothing said so (CodeBuddy never sends
          // `session_end`). Keeping the record would make a later instant answer
          // with no conversation request id look steered, and hold a normal turn
          // open against a drain that is never coming back. RETIRE the id
          // first, so a late update or a response naming it is never adopted as
          // this session's own turn; then forget the record (the notice de-dupe
          // set with it) so this response settles normally.
          if (session.ambient !== undefined
            && Date.now() - session.ambient.lastActivityAt > this.tuning.ambientStaleMs) {
            retireAmbientId(session, session.ambient.requestId)
            session.ambient = undefined
            session.ambientNotices?.clear()
          }
          if (holdDispatch) {
            // The response may name one run while an announcement named
            // another; the hold accepts both (see `BackgroundHold.acceptedIds`).
            controller.holdForBackgroundDispatch(
              result.stopReason,
              responseMeta?.conversationRequestId ?? responseMeta?.requestId,
            )
            return
          }
          // An instant answer with NO conversation request id, while the agent
          // announced a background drain this turn has not spoken into: the
          // prompt was folded into that drain (CodeBuddy's multitask). The
          // response is a formality — keep the turn open until the drain speaks.
          if (session.ambient !== undefined
            && !session.released
            && !session.closed
            && result.stopReason !== 'cancelled'
            && responseMeta?.conversationRequestId === undefined
            && !controller.hasAgentProse) {
            controller.awaitAmbient(session.ambient.requestId, result.stopReason)
            return
          }
          // No ambient record to wait on, but a drain this session stopped
          // waiting on was retired moments ago: the run may have taken this
          // prompt WITHOUT re-announcing itself. The turn cannot be held open
          // (nothing names the drain), but a silent close must say the output
          // may be in the transcript instead of blaming the agent.
          if (session.ambient === undefined
            && result.stopReason !== 'cancelled'
            && responseMeta?.conversationRequestId === undefined
            && hasRecentRetiredAmbient(session, Math.max(this.tuning.ambientQuietMs * 2, RETIRED_AMBIENT_RECENT_MIN_MS))) {
            controller.noteRecentRetiredDrain()
          }
          controller.settle(result.stopReason === 'cancelled'
            ? { kind: 'cancelled' }
            // A refusal carries the agent's own reason (`agentRefusalDetail`),
            // and the zero-output line quotes it: a quota was already settled
            // above as an error, so what reaches here is the agent declining
            // the work and saying why.
            : {
              kind: 'stop',
              stopReason: result.stopReason,
              ...(refusal !== undefined ? { refusal: refusal.message } : {}),
            })
        })
        .catch((err: unknown) => {
          if (session.reclaimedTurnSeq === turnGen) {
            session.reclaimedTurnSeq = undefined
            return
          }
          controller.settle({ kind: 'error', message: describeError(err) })
        })
        // The agent's own answer closed the turn: whatever the watchdog marked
        // orphaned has just reported back and no longer needs a reclaim.
        .finally(() => {
          if (session.reclaimedTurnSeq === turnGen) session.reclaimedTurnSeq = undefined
          this.clearOrphanPrompt(session, turnGen)
          // A rollback during this turn could not prune the holder while the
          // agent was still answering (`hasActiveWork` counts the outstanding
          // prompt). Now that it settled, retry — this is the only second chance
          // a closed-and-forgotten session gets.
          const key = this.keyOfBridge(promptBridge)
          if (key !== undefined) this.pruneBridge(key)
        })
    }

    try {
      yield* segment.queue
    } finally {
      options.signal?.removeEventListener('abort', onAbort)
      // The FIRST segment never retires its controller here: a card-bearing
      // turn keeps it indexed so its continuation steps can resume the prompt,
      // and a card-less or cancelled one already disposed itself in `settle`.
    }
  }
}

export class AcpLlmAdapter implements LlmAdapterLike {
  constructor(private readonly manager: BridgeManager) {}

  providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: 'ACP' }
  }

  providerRetryPolicy(_provider: string): undefined {
    return undefined
  }

  imageRequestPricing(_provider: string, _model: string): undefined {
    return undefined
  }

  /**
   * Advertise NOTHING, on purpose (see `AgentCatalogResult` and
   * `BridgeManager.agentCatalog`).
   *
   * DSH's model catalog is per request, not per session (`buildModelCatalog(ctx)`
   * takes no session id), so an `acp` that listed models would list them in
   * every conversation — including the ones with no ACP agent behind them. The
   * catalog is advisory (its own contract: "an adapter may accept unlisted model
   * ids, and consumers must not turn absence into request rejection"), and route
   * liveness is judged by registration, not by this list, so `acp@agent` and
   * `acp@agent@choice` still resolve and stream while being advertised nowhere.
   * An empty list also keeps this hot path (every `session.models` / `llm.models`
   * request) allocation-free: there is no per-session seam to filter with, so
   * nothing may be listed until there is. The ACP seats read the per-agent view
   * through `agent/catalog` instead.
   */
  async listModels(_provider: string): Promise<readonly LlmModelInfo[]> {
    return []
  }

  async resolveModel(provider: string, model: string, _signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    return this.manager.resolveAdapterModel(provider, model)
  }

  async prepareCall(provider: string, model: string, signal?: AbortSignal): Promise<PreparedAdapterCall> {
    return {
      model: await this.resolveModel(provider, model, signal),
      stream: (options: GenerateOptions) => this.stream(options),
    }
  }

  stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    return this.manager.streamPrompt(options)
  }
}

export class AsyncQueue<T> {
  private queue: T[] = []
  private resolvers: Array<(result: IteratorResult<T>) => void> = []
  private closed = false

  push(item: T): void {
    if (this.closed) return
    const resolver = this.resolvers.shift()
    if (resolver) {
      resolver({ done: false, value: item })
    } else {
      this.queue.push(item)
    }
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    while (this.resolvers.length > 0) {
      const resolver = this.resolvers.shift()!
      resolver({ done: true, value: undefined as never })
    }
  }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    while (true) {
      if (this.queue.length > 0) {
        yield this.queue.shift()!
      } else if (this.closed) {
        return
      } else {
        const item = await new Promise<IteratorResult<T>>(resolve => {
          this.resolvers.push(resolve)
        })
        if (item.done) return
        yield item.value
      }
    }
  }
}

/** A JSON-RPC internal error for fs requests: actionable text in `message`, mirrored into `data` (see AGENTS.md rule 5). */
function fsRequestError(message: string): RequestError {
  return new RequestError(-32603, message, { message })
}

/**
 * JSON-RPC errors often carry the actionable detail in `data` (e.g. pi-acp * reports { errorKind: 'billing_error', message: '…' } while `message` is the
 * generic "Internal error"). Surface both.
 */
function describeError(error: unknown): string {
  if (error instanceof Error) {
    const data = (error as { data?: { errorKind?: unknown; message?: unknown } }).data
    const kind = typeof data?.errorKind === 'string' ? data.errorKind : undefined
    const detail = typeof data?.message === 'string' ? data.message : undefined
    const tail = [kind, detail].filter((v): v is string => v !== undefined && v !== '').join(': ')
    return tail === '' ? error.message : `${error.message} — ${tail}`
  }
  return String(error)
}
