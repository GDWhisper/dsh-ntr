/**
 * Pure host-side logic for dsh-ntr: config validation, workspace guard,
 * child env assembly, agent-skill flavor matching and frontmatter parsing,
 * capped transcript, event hub, and the RPC dispatcher. No Node imports, no
 * SDK imports — everything here is testable with plain fakes.
 *
 * This file is the BARREL for the clusters under `src/impl/`, so every existing
 * `../impl.ts` import keeps resolving unchanged. The runtime pieces and the RPC
 * dispatcher still live here; they move out in the next sub-step.
 */

import { randomUUID } from './ids.ts'
import type {
  AcpAgentDef, AcpApprovalDeadlines, AcpConversationChoice, AcpIdleRelease, AcpPresetStatus, AcpTagHalo, AcpEvent, ActiveTurnView, AgentCatalogResult, AgentProbeModelsResult, AgentSaveMode, AgentSaveResult, AgentSkillsResult, AgentTestResult,
  AgentView, ApprovalDeadlinePatch, ChatSessionView, ChatTranscriptView, DetectedAgentInfo, PermissionOutcome, PermissionOptionView, PermissionTimeoutMode, PluginReleaseNotes, PluginUpdateState, RpcResult,
  SaveGateFlushResult, SaveGateStatus, SubagentDetailResult,
} from './protocol.ts'
import { DEFAULT_SAVE_GATE_TIMEOUT_MS, DEFAULT_SESSION_TITLE_PREFIX, DEFAULT_TAG_HALO, pluginReleaseUrl } from './protocol.ts'
import { subagentToolCallId } from './subagent-records.ts'
import { AcpError } from './impl/errors.ts'
import type { PromptContentBlock } from './impl/image.ts'
import type { PendingPermissionFields, PendingPermissionView } from './impl/permission.ts'
import {
  STABLE_SEMVER, normalizeExposedModels, validateAgentDef, validateApprovalDeadlines, validateIdleReleaseMs, validatePermissionTimeoutMode, validateTagHalo,
} from './impl/validate.ts'

export { randomUUID }

export { AcpError } from './impl/errors.ts'

// ---- Config validation ----

export {
  APPROVAL_DEADLINE_MAX_MS,
  APPROVAL_DEADLINE_MIN_WAIT_MS,
  normalizeApprovalWindow,
  normalizeExposedModels,
  validateAgentDef,
  validateApprovalDeadlineMs,
  validateApprovalDeadlines,
  validateConfig,
  validateIdleReleaseMs,
  validateMcpServers,
  validatePermissionTimeoutMode,
  validateTagHalo,
} from './impl/validate.ts'

// ---- Command lines ----

export { quoteCommandToken, splitCommandLine, tokenizeCommandLine } from './impl/command-line.ts'

// ---- Workspace guard ----

export { canonicalizeFsPath, isAbsolutePath, isUnderPath, resolveFsPath, resolveSessionCwd } from './impl/paths.ts'

// ---- Child environment ----

export { childEnv } from './impl/env.ts'

// ---- Model catalog ----

export {
  MAX_CONFIG_OPTIONS_BYTES,
  buildAdapterModelId,
  hasUnambiguousModelSelector,
  mergeCatalogShape,
  parseCatalogOptions,
  splitAdapterModelId,
  usableConfigOptions,
} from './impl/catalog.ts'

// ---- ACP tool-call notifications ----

export type { AcpContentRow, AcpDiffPayload, AcpToolCallDelta, AcpToolCallSnapshot } from './impl/content.ts'
export {
  ACP_TOOL_CALL_NAME,
  BOOKKEEPING_UPDATES,
  acpContentRows,
  acpToolCallArgsOf,
  acpToolCallDelta,
  acpToolCallFromUpdate,
  describeUnhandledUpdate,
  dumpJson,
  formatAcpDiff,
  isAcpToolContinuation,
  isFinalToolCallStatus,
  updateContentToText,
} from './impl/content.ts'

// ---- Prompt images and the forwarded prompt ----

export type { PromptContentBlock, PromptImageContent, PromptTextContent } from './impl/image.ts'
export {
  detectImageMimeFromMagic,
  guessImageMimeType,
  isLocalFilePath,
  parseImageDataUrl,
  resolveImageContent,
} from './impl/image.ts'
export { normalizeFileUrlToPath, resolveImageAttachmentFromContext } from './impl/attachments.ts'

export type { ForwardPromptSelection } from './impl/forward.ts'
export { SESSION_TITLE_PLACEHOLDER_MAX, extractSessionTitlePlaceholder, selectForwardPrompt } from './impl/forward.ts'

// ---- Permission vocabulary ----

export type { PendingPermissionFields, PendingPermissionView } from './impl/permission.ts'
export {
  AUTO_OPTION_KIND_PRIORITY,
  permissionReplayFrames,
  permissionRequestFrame,
  permissionToolKind,
  permissionToolPaths,
  pickAutoOption,
} from './impl/permission.ts'

// ---- Agent skills (pure half) ----

export type { SkillDirTable, SkillFlavor } from './impl/skills.ts'
export {
  GENERIC_SKILL_DIRS,
  SKILL_DIRS_BY_FLAVOR,
  SKILL_SCAN_LIMITS,
  formatSkillMentionPrompt,
  formatSkillPathDestination,
  parseSkillFrontmatter,
  skillFlavorOf,
  skillMentionToken,
  skillMetadata,
} from './impl/skills.ts'

// ---- The agent preset a session runs ----

export type { RosterPresetRow, SessionCatalogLike, SessionLogLike } from './impl/session-log.ts'
export {
  ACP_PRESET_SOURCE,
  acpPresetStatusFromRoster,
  appendExternalSubagentCatalog,
  sessionAgentPreset,
  sessionAgentPresetFromLog,
} from './impl/session-log.ts'

// ---- Worker lifecycle records (pure half; persistence lives in `src/bridge/`) ----

export {
  ACP_TOOL_RAW_MAX,
  boundSubagentDetailEntry,
  capSubagentRecords,
  normalizeSubagentRecord,
  normalizeSubagentRecordMap,
  subagentToolCallId,
} from './subagent-records.ts'

// ---- Transcript ----


// ---- Transcript ----

/**
 * The kind of a state-only tick that consecutive repeats may share one entry.
 *
 * These are the frames the client folds to nothing (`STATE_ONLY_UPDATES`):
 * only their latest value is ever read. `session_info_update` qualifies only
 * while it carries no title — a title is content the replay must keep, so it
 * never lets a later tick replace its entry.
 */
function coalescibleStateKind(update: unknown): string | undefined {
  if (typeof update !== 'object' || update === null || Array.isArray(update)) return undefined
  const row = update as Record<string, unknown>
  const kind = row.sessionUpdate
  if (kind === 'usage_update' || kind === 'config_option_update') return kind
  if (kind !== 'session_info_update') return undefined
  const title = row.title
  return title === undefined || title === null || title === '' ? kind : undefined
}

/**
 * Bounded log of raw ACP session updates with monotone seq.
 *
 * Consecutive ticks of the same state-only kind share one entry (the entry is
 * replaced in place, not appended): chatty agents emit a usage / phase tick
 * every few hundred milliseconds, and letting each occupy the ring evicts the
 * conversation itself. This costs nothing on the live path — `append` still
 * allocates a fresh seq and the bridge broadcasts that frame — but replay via
 * `since` only sees the newest tick of each run.
 */
export class Transcript {
  private readonly entries: Array<{ seq: number; update: unknown }> = []
  private next = 1

  constructor(private readonly max: number) {}

  append(update: unknown): number {
    const seq = this.next++
    const last = this.entries[this.entries.length - 1]
    const kind = coalescibleStateKind(update)
    // Replace, don't push: `since(afterSeq)` keeps its filter, so intermediate
    // seq values are simply absent from replayed entries. Live SSE frames are
    // broadcast per append (the returned seq), and the client's live fold does
    // not depend on transcript contiguity — only `head` must keep advancing.
    if (kind !== undefined && last !== undefined && coalescibleStateKind(last.update) === kind) {
      this.entries[this.entries.length - 1] = { seq, update }
      return seq
    }
    this.entries.push({ seq, update })
    if (this.entries.length > this.max) this.entries.splice(0, this.entries.length - this.max)
    return seq
  }

  get head(): number {
    return this.next - 1
  }

  since(afterSeq: number): Array<{ seq: number; update: unknown }> {
    return this.entries.filter(e => e.seq > afterSeq)
  }
}

// ---- Event hub ----

export class EventHub {
  private readonly sinks = new Set<(event: AcpEvent) => void>()

  subscribe(sink: (event: AcpEvent) => void): () => void {
    this.sinks.add(sink)
    return () => { this.sinks.delete(sink) }
  }

  broadcast(event: AcpEvent): void {
    for (const sink of [...this.sinks]) {
      try {
        sink(event)
      } catch {
        // A broken subscriber must never stall protocol pumping.
      }
    }
  }
}


// ---- Permission ledger ----

export interface PendingPermission {
  requestId: string
  sessionId: string
  resolve: (outcome: PermissionOutcome) => void
  /**
   * The ask as the browser was shown it, kept for the REPLAY a reconnecting
   * client receives (see `permissionReplayFrames`). Absent on entries created
   * without a view — those still answer, they just cannot be re-shown.
   */
  view?: PendingPermissionFields
}

export class PermissionLedger {
  private readonly pending = new Map<string, PendingPermission>()

  create(sessionId: string, executor: (outcome: PermissionOutcome) => void, view?: PendingPermission['view']): string {
    const requestId = randomUUID()
    this.pending.set(requestId, { requestId, sessionId, resolve: executor, ...(view === undefined ? {} : { view }) })
    return requestId
  }

  respond(requestId: string, outcome: PermissionOutcome): true {
    const entry = this.pending.get(requestId)
    if (entry === undefined) throw new AcpError('unknown_request', `acp: no pending permission ${requestId}`)
    this.pending.delete(requestId)
    entry.resolve(outcome)
    return true
  }

  has(requestId: string): boolean {
    return this.pending.has(requestId)
  }

  settleFor(predicate: (p: { requestId: string; sessionId: string }) => boolean): string[] {
    const settled: string[] = []
    for (const [id, entry] of [...this.pending]) {
      if (!predicate(entry)) continue
      this.pending.delete(id)
      entry.resolve({ outcome: 'cancelled' })
      settled.push(id)
    }
    return settled
  }

  sessionIds(): Array<{ requestId: string; sessionId: string }> {
    return [...this.pending.values()].map(e => ({ requestId: e.requestId, sessionId: e.sessionId }))
  }

  /**
   * Whether ANY outstanding ask belongs to `sessionId`, a HOST session id
   * (`LiveSession.sessionId`) — NOT the ACP protocol session id. Used by the
   * stall watchdog: a turn blocked on a human is not a silent turn, so the
   * session with a pending permission must not be finalized as stalled.
   */
  hasPendingFor(sessionId: string): boolean {
    for (const entry of this.pending.values()) {
      if (entry.sessionId === sessionId) return true
    }
    return false
  }

  /**
   * Outstanding asks WITH the view the browser was shown, for the reconnect
   * replay. Entries created without a view are skipped: replaying a frame the
   * client cannot render (no title, no options) would show an unanswerable
   * card, which is worse than showing nothing.
   */
  pendingViews(): PendingPermissionView[] {
    const views: PendingPermissionView[] = []
    for (const entry of this.pending.values()) {
      if (entry.view === undefined) continue
      views.push({
        requestId: entry.requestId,
        sessionId: entry.sessionId,
        ...entry.view,
      })
    }
    return views
  }
}

// ---- RPC surface ----

/** The bridge-manager face the dispatcher talks to (interface keeps dispatch pure-testable). */
export interface AcpManager {
  agentViews(): AgentView[]
  startSession(agentId: string, cwd: string | undefined): Promise<{ sessionId: string }>
  prompt(sessionId: string, prompt: string | PromptContentBlock[]): Promise<{ turnId: string }>
  cancel(sessionId: string): Promise<void>
  closeSession(sessionId: string): Promise<void>
  setMode(sessionId: string, modeId: string): Promise<void>
  setConfigOption(sessionId: string, configId: string, value: string | boolean): Promise<void>
  respondPermission(requestId: string, optionId: string | undefined): void
  transcript(sessionId: string, afterSeq: number | undefined): { session: unknown; entries: Array<{ seq: number; update: unknown }> }
  sessions(): unknown[]
  stopAgent(agentId: string): Promise<void>
  /**
   * The plugin's OWN default ACP agent (the panel's ★ gesture): which agent an
   * ACP-mode conversation should start on. Deliberately NOT a DSH model route:
   * nothing in this plugin writes the host's model selection (see
   * docs/acp-convergence.md §2.2).
   */
  defaultAgent?(): string | undefined
  /** Set (or clear, with `undefined`) the default ACP agent. */
  setDefaultAgent?(agentId: string | undefined): Promise<void>
  /** The agent tag's halo preference (composer display, plugin-private). */
  tagHalo?(): AcpTagHalo
  /** Write the halo preference (persisted with the agent registry). */
  setTagHalo?(halo: AcpTagHalo): Promise<void>
  /**
   * Whether generated NTR session titles carry the {@link SESSION_TITLE_PREFIX}
   * badge (plugin-private setting, persisted with the agent registry).
   */
  sessionTitlePrefix?(): boolean
  /** Write the title-prefix toggle (persisted with the agent registry). */
  setSessionTitlePrefix?(value: boolean): Promise<void>
  /**
   * The approval deadline in force, with the facts that explain an override
   * (the `cordis.patch.yml` baseline it outranks). `undefined` on a host half
   * from before the card existed, which hides the settings card instead of
   * guessing a value.
   */
  approvalDeadlines?(): AcpApprovalDeadlines | undefined
  /**
   * Write the approval deadline, or the mode (omitted keys keep their value),
   * or drop the persisted override with `reset` so the config-file baseline
   * applies again. Applies to the running bridges without a restart.
   */
  setApprovalDeadlines?(patch: ApprovalDeadlinePatch, reset?: boolean): Promise<void>
  /**
   * The idle-release window in force for chat processes, plus the built-in
   * default a reset returns to. `undefined` on a host half from before the
   * card existed, which hides the settings tab instead of showing a number
   * this browser invented.
   */
  idleRelease?(): AcpIdleRelease | undefined
  /**
   * Write the idle-release window (in ms), or drop the persisted
   * override with `reset` so the built-in default applies again. Applies to
   * the running bridges without a restart.
   */
  setIdleRelease?(idleTimeoutMs: number | undefined, reset?: boolean): Promise<void>
  detectAgents?(): Promise<DetectedAgentInfo[]>
  saveAgent?(def: AcpAgentDef, mode?: AgentSaveMode): Promise<AgentSaveResult>
  deleteAgent?(agentId: string): Promise<void>
  /**
   * Spawn a throwaway process from raw form values (never persisted, never
   * registered), run the ACP handshake, tear it down, and report the outcome.
   * May trigger the def's npm auto-install.
   */
  testAgent?(def: AcpAgentDef): Promise<AgentTestResult>
  /** Update which probed model choices the ACP seats offer; `undefined` clears the filter. Must not restart the agent. */
  setExposedModels?(agentId: string, exposedModels: readonly string[] | undefined): Promise<void>
  /** Toggle auto-discovery of newly published models. Must not restart the agent. */
  setAutoDiscoverModels?(agentId: string, autoDiscoverModels: boolean): Promise<void>
  probeAgentModels?(agentId: string, model?: string): Promise<AgentProbeModelsResult>
  /**
   * The ACP model surface for one agent (the seats' data source): base entry,
   * the `exposedModels` variants, and the agent's own reasoning efforts.
   * Memory-only — never spawns and never probes: an agent without a cached
   * catalog is reported with `probed: false` and whatever (possibly empty)
   * content memory holds, NOT probed on read. A catalog is filled only by
   * `agent/probe-models` (the settings-card button) and by the agent's own
   * `session/new` / `session/load` — reading the seat must never start a
   * process, or opening the page would launch every configured agent.
   */
  agentCatalog(agentId: string): AgentCatalogResult
  /**
   * The last catalog observed for one agent, or `undefined` when it has never
   * published one. Memory-only (hydrated from disk at boot), never spawns.
   *
   * This is the settings panel's mount read: it fills the model panes with the
   * already-configured selection and the last known model list, so a cache hit
   * is visible without clicking 「检测可用模型」. That button only REFRESHES the
   * cache (newly published models appear, withdrawn ones drop out).
   */
  cachedAgentModels?(agentId: string): AgentProbeModelsResult | undefined
  /**
   * ACP agent sessions backing one DSH chat session (looked up by chat session
   * id), so the composer can offer the agent's OWN mode list. Empty when no
   * agent has run in that chat yet.
   */
  chatSessions?(dshSessionId: string): ChatSessionView[]
  /**
   * Whether ONE DSH chat session runs the ACP agent preset (asked by chat
   * session id). Read-only report for `session/chat-list`; the browser's
   * model-seat gate falls back to it when the client session list does not
   * carry `agentPreset` on its rows.
   */
  chatSessionAcpMode?(dshSessionId: string): boolean
  /**
   * Awaitable verdict for `session/chat-list`: waits out the cold read behind
   * the synchronous probe, so the browser's one-shot fallback sees the settled
   * answer on the FIRST response instead of a premature `false`.
   */
  chatSessionAcpModeAnswer?(dshSessionId: string): Promise<boolean>
  /**
   * Drop the cached ACP-mode verdict for one session (or all). The gate's
   * `session/chat-list` path calls this before answering so a preset switch is
   * never masked by a stale cached negative (see the chat-list handler).
   */
  invalidateAcpMode?(dshSessionId?: string): void
  /**
   * Every ACP session transcript belonging to one DSH chat session, so the
   * conversation can render the agent's real stream (tool calls, plans,
   * diffs) in its own view tab. Read-only: never spawns, never resumes.
   */
  chatTranscripts?(dshSessionId: string, afterSeq?: number): ChatTranscriptView[]
  /**
   * Raw transcript entries for ONE external worker, read on demand by the
   * subagent panel's detail view. Addressed by chat session + catalog child id
   * (`acp:<toolCallId>`); an unknown pair answers an empty result rather than
   * failing, and released sessions keep serving their retained buffers.
   */
  subagentsDetail?(dshSessionId: string, childId: string): SubagentDetailResult
  /**
   * The agent skills one conversation can use, keyed by the SERVING agent and
   * its workspace root (`agent/skills`, the `/` menu's skill rows). Memory-only:
   * a filesystem scan with a short TTL cache, never persisted and never
   * spawned. Unknown agent → empty answer, like `subagentsDetail`.
   */
  agentSkills?(dshSessionId: string, agentId: string): AgentSkillsResult | Promise<AgentSkillsResult>
  /**
   * Switch one chat-bound ACP session's mode (`session/set_mode`). `agentId`
   * disambiguates when more than one agent has run in the same chat session;
   * without it the live (non-released) session is picked.
   */
  setChatSessionMode?(dshSessionId: string, modeId: string, agentId?: string): Promise<void>
  /**
   * Bring one chat conversation's released session back on a fresh process on
   * the user's explicit gesture (`session/chat-resume`, the released-session
   * banner's button). Same recovery the next prompt performs lazily, minus
   * the create path; no-op when the session is already live.
   */
  resumeChatSession?(dshSessionId: string): Promise<void>
  /**
   * Adopt the ACP side of a branched conversation (`session/chat-fork-adopt`):
   * the browser has already asked the HOST to fork the DSH session tree, and
   * this runs the agent's own `session/fork` of the parent's live ACP session,
   * then binds the child to it. All-or-nothing — nothing is bound on failure,
   * so the child stays an ordinary copied-history conversation.
   */
  adoptForkedSession?(childDshSessionId: string, parentDshSessionId: string): Promise<{ sessionId: string; acpSessionId: string }>
  /**
   * Point one DSH chat conversation at an ACP agent — the plugin's own
   * conversation↔agent mapping, never a DSH model route (see
   * `BridgeManager.bindChatAgent`).
   */
  bindChatAgent?(dshSessionId: string, agentId: string): void
  /**
   * The ACP agent one DSH chat conversation is pointed at — the recorded intent
   * when there is one, else the agent an existing ACP session for that
   * conversation is already served by. The composer's chip and picker read this
   * so a switch shows BEFORE the next turn materializes it.
   */
  chatAgentFor?(dshSessionId: string): string | undefined
  /**
   * The agent one DSH chat conversation is LOCKED to after its first ACP turn,
   * if any. Read-only report for `session/chat-list`: the composer hides its
   * agent picker and shows the locked agent instead. Unlike `chatAgentFor`,
   * this deliberately ignores the roster — a deleted agent still owns the
   * conversation's context.
   */
  lockedAgentFor?(dshSessionId: string): string | undefined
  /**
   * The conversation's whole persisted pick — agent, model, thought level —
   * readable BEFORE the conversation has an ACP session. This is what makes a
   * conversation set up ahead of its first message report that set-up instead
   * of the agent's defaults.
   */
  chatChoice?(dshSessionId: string): AcpConversationChoice | undefined
  /** Switch the bound agent's model (`agentId@choice`) for one chat session. */
  setChatSessionModel?(dshSessionId: string, modelId: string): Promise<void>
  /** Switch the reasoning effort for one chat session (agentId names the default-agent case). */
  setChatSessionEffort?(dshSessionId: string, effort: string | undefined, agentId?: string): Promise<void>
  /** Set one of the agent's EXTRA config options for one chat session. */
  setChatSessionConfig?(dshSessionId: string, configId: string, value: string | boolean, agentId?: string): Promise<void>
  /**
   * State of the ACP-mode agent preset in the harness's OWN roster. Read-only
   * report for the settings panel: the preset is a declaration this package
   * ships (a bundle patch), so there is nothing to install — but a declaration
   * whose activation failed stays on the roster with its diagnostic, and that
   * has to be visible somewhere the user can act on it.
   *
   * Answers `undefined` when the roster cannot be read at all (a host without
   * the registry service), which hides the panel block instead of guessing.
   */
  presetStatus?(): Promise<AcpPresetStatus | undefined>
  /**
   * The installed host package's version, reported for the settings page's
   * badge. `undefined` on a host half that predates the endpoint, which hides
   * the badge rather than showing a number the browser invented.
   */
  pluginVersion?(): string | undefined
  /**
   * Ask the host's plugin manager what is published for this package. Read-only
   * toward the installation: never downloads, never swaps files, never restarts
   * the host. Absent on a host half from before the updater existed.
   */
  pluginUpdateCheck?(): Promise<PluginUpdateState>
  /**
   * Install one exact stable version THROUGH the host's plugin manager. The
   * manager owns download/restart semantics; this plugin only relays. Absent on
   * an older host half.
   */
  pluginUpdateApply?(version: string): Promise<PluginUpdateState>
  /**
   * One version's release notes for the update card's preview. READ-ONLY: it
   * never installs and never participates in a check. `refresh` is the card's
   * retry: it must bypass every cache on the way to the network. Absent on an
   * older host half, which leaves the card with the release-page URL only.
   */
  pluginReleaseNotes?(version: string, refresh?: boolean): Promise<PluginReleaseNotes>
  /**
   * The ACP-turn save gate. Optional on older host halves: the RPCs then
   * answer "always save now" so a browser from this bundle keeps working.
   */
  saveGateStatus?(): SaveGateStatus
  saveGateFlush?(): Promise<SaveGateFlushResult>
  saveGateCancel?(label: string): number
  saveGateRetry?(label: string): boolean
  saveGateWaitIdle?(timeoutMs?: number): Promise<boolean>
}

function ok<T>(value: T): RpcResult<T> {
  return { ok: true, value }
}

function fail(code: string, message: string): RpcResult<never> {
  return { ok: false, error: { code, message, details: {} } }
}

/**
 * The idle gate answer for a host half without the save-gate service.
 *
 * `gateAvailable: false` is what tells the browser this snapshot is a
 * placeholder: it must not offer queue / force affordances the host cannot
 * honour.
 */
export function emptySaveGateStatus(): SaveGateStatus {
  return {
    gateAvailable: false,
    canSave: true,
    activeTurns: 0,
    activeSessions: [],
    pending: [],
    timeoutMs: DEFAULT_SAVE_GATE_TIMEOUT_MS,
  }
}

/**
 * The host-side decision for one explicit agent save. `force` and an idle
 * target save now; `defer` queues; an omitted/`direct` mode with live target
 * turns asks first. This is pure so both the RPC and the panel's fallback
 * cannot drift.
 */
export function agentSaveAction(
  activeSessions: readonly ActiveTurnView[],
  mode: AgentSaveMode,
): 'save' | 'defer' | 'confirm' {
  if (activeSessions.length === 0) return 'save'
  if (mode === 'force') return 'save'
  if (mode === 'defer') return 'defer'
  return 'confirm'
}

/** String payload field with a length bound (defensive against oversized bodies). */
function str(payload: Record<string, unknown>, key: string, maxLen: number): string {
  const value = payload[key]
  if (typeof value !== 'string') throw new AcpError('bad_payload', `acp: ${key} must be a string`)
  if (value.length > maxLen) throw new AcpError('bad_payload', `acp: ${key} exceeds ${String(maxLen)} chars`)
  return value
}

function optionalStr(payload: Record<string, unknown>, key: string, maxLen: number): string | undefined {
  const value = payload[key]
  if (value === undefined || value === '') return undefined
  if (typeof value !== 'string') throw new AcpError('bad_payload', `acp: ${key} must be a string`)
  if (value.length > maxLen) throw new AcpError('bad_payload', `acp: ${key} exceeds ${String(maxLen)} chars`)
  return value
}

/** Dispatch one decoded `/acp` channel call. Never rejects; protocol errors come back as `ok:false`. */
export async function dispatchRpc(manager: AcpManager, endpoint: string, payload: unknown): Promise<RpcResult<unknown>> {
  const body = (typeof payload === 'object' && payload !== null ? payload : {}) as Record<string, unknown>
  try {
    switch (endpoint) {
      case 'agents/list':
        return ok({ agents: manager.agentViews() })
      case 'agents/detect':
        return ok({ agents: await (manager.detectAgents?.() ?? Promise.resolve([])) })
      case 'agent/save': {
        const mode = body.saveMode
        if (mode !== undefined && mode !== 'direct' && mode !== 'defer' && mode !== 'force') {
          throw new AcpError('bad_payload', 'acp: saveMode must be direct, defer, or force')
        }
        if (manager.saveAgent === undefined) {
          return fail('unsupported', 'acp: agent/save is not available')
        }
        const def = validateAgentDef(body)
        const result = (await manager.saveAgent(def, mode as AgentSaveMode | undefined)) ?? { done: true }
        // An older caller that sends no gesture gets `done: false` when turns
        // are live. Returning `ok` there made a refused save look successful
        // to any caller that only checks the RPC envelope; the new panel always
        // sends `saveMode`, so this explicit failure signal is for legacy callers.
        if (mode === undefined && result.confirmationRequired === true) {
          return fail('confirmation_required', 'acp: the agent has running turns; send an explicit saveMode')
        }
        return ok(result)
      }
      case 'agent/delete': {
        const agentId = str(body, 'agentId', 64)
        await manager.deleteAgent?.(agentId)
        return ok({ done: true })
      }
      case 'agent/test': {
        if (manager.testAgent === undefined) {
          return fail('unsupported', 'acp: agent/test is not available')
        }
        // Invoked as a method to keep the manager receiver (see probe-models).
        return ok(await manager.testAgent(validateAgentDef(body)))
      }
      case 'session/start':
        return ok(await manager.startSession(str(body, 'agentId', 64), optionalStr(body, 'cwd', 4096)))
      case 'session/prompt': {
        let promptInput: string | PromptContentBlock[]
        if (Array.isArray(body.prompt)) {
          if (body.prompt.length === 0) {
            throw new AcpError('bad_payload', 'acp: prompt array cannot be empty')
          }
          for (const b of body.prompt) {
            if (!b || typeof b !== 'object') throw new AcpError('bad_payload', 'acp: prompt blocks must be objects')
            const block = b as Record<string, unknown>
            if (block.type === 'text') {
              if (typeof block.text !== 'string') throw new AcpError('bad_payload', 'acp: text block requires string text')
              if (block.text.length > (1 << 20)) throw new AcpError('bad_payload', 'acp: text block exceeds max length')
            } else if (block.type === 'image') {
              if (typeof block.data !== 'string' || typeof block.mimeType !== 'string') {
                throw new AcpError('bad_payload', 'acp: image block requires string data and mimeType')
              }
              if (!block.mimeType.toLowerCase().startsWith('image/')) {
                throw new AcpError('bad_payload', 'acp: image block mimeType must start with image/')
              }
              if (block.uri !== undefined && typeof block.uri !== 'string') {
                throw new AcpError('bad_payload', 'acp: image block uri must be string')
              }
              if (block.data.length > (20 << 20)) throw new AcpError('bad_payload', 'acp: image block exceeds max data length')
            } else {
              throw new AcpError('bad_payload', `acp: unsupported prompt block type: ${String(block.type)}`)
            }
          }
          promptInput = body.prompt as PromptContentBlock[]
        } else {
          promptInput = str(body, 'text', 1 << 20)
        }
        const { turnId } = await manager.prompt(str(body, 'sessionId', 64), promptInput)
        return ok({ accepted: true as const, turnId })
      }
      case 'session/cancel':
        await manager.cancel(str(body, 'sessionId', 64)); return ok({ done: true })
      case 'session/close':
        await manager.closeSession(str(body, 'sessionId', 64)); return ok({ done: true })
      case 'session/mode-set':
        await manager.setMode(str(body, 'sessionId', 64), str(body, 'modeId', 128)); return ok({ done: true })
      case 'session/config-set': {
        const value = body.value
        if (typeof value !== 'string' && typeof value !== 'boolean') throw new AcpError('bad_payload', 'acp: value must be string|boolean')
        await manager.setConfigOption(str(body, 'sessionId', 64), str(body, 'configId', 128), value)
        return ok({ done: true })
      }
      case 'permission/respond':
        return ok({ done: manager.respondPermission(str(body, 'requestId', 64), optionalStr(body, 'optionId', 128)) })
      case 'transcript/get': {
        const after = body.afterSeq
        if (after !== undefined && typeof after !== 'number') throw new AcpError('bad_payload', 'acp: afterSeq must be a number')
        return ok(manager.transcript(str(body, 'sessionId', 64), after as number | undefined))
      }
      case 'sessions/list':
        return ok({ sessions: manager.sessions() })
      case 'session/chat-list': {
        // Validate before the optional call: `manager.chatSessions?.(str(...))`
        // would short-circuit the arguments away on a manager without the
        // method, silently skipping the payload check.
        const dshSessionId = str(body, 'dshSessionId', 128)
        // The gate re-asks this on every `agent-preset/selected`; it passes
        // `refresh` to mean "the session log moved, re-resolve". A verdict
        // cached from BEFORE the switch must not be echoed, or the ACP model
        // seat never activates and the ACP model stays unselectable until a
        // prompt turn retires the cache — a chicken-and-egg (you can't run that
        // turn without the model the seat is supposed to offer). Callers that
        // DON'T pass `refresh` keep the per-session cache (repeat reads stay
        // cheap); the browser half always sets it (see AcpStore.loadChatSessions).
        if (body.refresh === true) manager.invalidateAcpMode?.(dshSessionId)
        const lockedAgentId = manager.lockedAgentFor?.(dshSessionId)
        return ok({
          sessions: manager.chatSessions?.(dshSessionId) ?? [],
          // The plugin's own binding for this conversation — who serves its
          // NEXT message. The composer's chip and picker read it so a switch
          // is visible before the next turn materializes a session for the
          // new agent (the live-session list below lags one message by design).
          boundAgentId: manager.chatAgentFor?.(dshSessionId),
          // Set once the first ACP turn has run: the conversation is locked to
          // this agent and the composer offers no picker any more. Reported
          // even when the agent is no longer in the roster (its context still
          // belongs to this conversation).
          ...(lockedAgentId === undefined ? {} : { lockedAgentId }),
          // The rest of the persisted pick (model + thought level). Read
          // BEFORE any ACP session exists, which is what lets the composer show
          // a conversation set up ahead of its first message as it really is.
          choice: manager.chatChoice?.(dshSessionId),
          // Read-only memory answer, same authority as `setAcpModeResolver`'s
          // session-log read: the seat gate's fallback fact source on hosts
          // whose session rows carry no `agentPreset`. Awaited: a cold read
          // must not be answered with a premature `false`.
          acpMode: manager.chatSessionAcpModeAnswer !== undefined
            ? await manager.chatSessionAcpModeAnswer(dshSessionId)
            : manager.chatSessionAcpMode?.(dshSessionId) === true,
        })
      }
      case 'session/chat-transcript': {
        const dshSessionId = str(body, 'dshSessionId', 128)
        const after = body.afterSeq
        if (after !== undefined && typeof after !== 'number') throw new AcpError('bad_payload', 'acp: afterSeq must be a number')
        return ok({ views: manager.chatTranscripts?.(dshSessionId, after as number | undefined) ?? [] })
      }
      case 'subagents/detail': {
        // The panel's detail dialog asks on demand — this is never a resident
        // SSE feed. The child id must name an external catalog row; the two
        // id fields are validated BEFORE the optional call (the same shape
        // rule as `session/chat-list`). An unknown conversation / worker is
        // an empty answer, not an internal error: the panel renders its
        // "detail no longer readable" line from that.
        const dshSessionId = str(body, 'dshSessionId', 128)
        const childId = str(body, 'childId', 256)
        if (subagentToolCallId(childId) === '') {
          throw new AcpError('bad_payload', 'acp: childId must be an external subagent identity (acp:<toolCallId>)')
        }
        return ok(manager.subagentsDetail?.(dshSessionId, childId) ?? { entries: [] })
      }
      case 'agent/skills': {
        // The `/` menu's skill rows, asked per conversation + agent. The two id
        // fields are validated BEFORE the optional call (the same shape rule as
        // `session/chat-list` above); a manager without the method — an older
        // host half — answers an empty menu instead of an error.
        const dshSessionId = str(body, 'dshSessionId', 128)
        const agentId = str(body, 'agentId', 64)
        return ok((await manager.agentSkills?.(dshSessionId, agentId)) ?? { skills: [] })
      }
      case 'session/chat-mode-set': {
        const dshSessionId = str(body, 'dshSessionId', 128)
        const modeId = str(body, 'modeId', 128)
        await manager.setChatSessionMode?.(dshSessionId, modeId, optionalStr(body, 'agentId', 64))
        return ok({ done: true })
      }
      case 'session/chat-resume': {
        // The released-session banner's explicit resume: the recovery the next
        // prompt performs lazily, on the user's gesture instead. Addressed by
        // DSH chat session id, like the rest of the conversation surfaces.
        const dshSessionId = str(body, 'dshSessionId', 128)
        await manager.resumeChatSession?.(dshSessionId)
        return ok({ done: true })
      }
      case 'session/chat-fork-adopt': {
        // The second half of a branched conversation: bind the DSH session the
        // host's `sessions.fork` just created to the agent's own `session/fork`
        // of the parent's live ACP session. Both ids are validated before the
        // optional call — the same shape rule as `session/chat-list` above.
        // The adopted ids ride the answer (the protocol's ChatForkAdoptResult);
        // a manager without the method keeps the plain `done` shape.
        const dshSessionId = str(body, 'dshSessionId', 128)
        const parentDshSessionId = str(body, 'parentDshSessionId', 128)
        const adopted = await manager.adoptForkedSession?.(dshSessionId, parentDshSessionId)
        return ok(adopted ?? { done: true })
      }
      case 'session/chat-bind': {
        // Point one chat conversation at an ACP agent. The plugin's own
        // conversation↔agent mapping — NOT a DSH model route (see
        // `BridgeManager.bindChatAgent`).
        const dshSessionId = str(body, 'dshSessionId', 128)
        const agentId = str(body, 'agentId', 64)
        await manager.bindChatAgent?.(dshSessionId, agentId)
        return ok({ done: true })
      }
      case 'session/chat-model-set': {
        const dshSessionId = str(body, 'dshSessionId', 128)
        const modelId = str(body, 'modelId', 128)
        await manager.setChatSessionModel?.(dshSessionId, modelId)
        return ok({ done: true })
      }
      case 'session/chat-effort-set': {
        const dshSessionId = str(body, 'dshSessionId', 128)
        await manager.setChatSessionEffort?.(dshSessionId, optionalStr(body, 'effort', 64), optionalStr(body, 'agentId', 64))
        return ok({ done: true })
      }
      case 'session/chat-config-set': {
        const dshSessionId = str(body, 'dshSessionId', 128)
        const configId = str(body, 'configId', 128)
        const value = body.value
        if (typeof value === 'boolean') {
          await manager.setChatSessionConfig?.(dshSessionId, configId, value, optionalStr(body, 'agentId', 64))
          return ok({ done: true })
        }
        await manager.setChatSessionConfig?.(dshSessionId, configId, str(body, 'value', 512), optionalStr(body, 'agentId', 64))
        return ok({ done: true })
      }
      case 'preset/status':
        return ok({ preset: await manager.presetStatus?.() ?? null })
      case 'plugin/version':
        // Absent on a host half from before the badge existed: the browser
        // hides it instead of naming a version it cannot know.
        return ok({ version: manager.pluginVersion?.() })
      case 'save/status':
        // A host half without the gate answers the idle state, so the browser
        // never renders a pending toast it cannot resolve. `gateAvailable`
        // stays false there: the snapshot is a placeholder, not a gate.
        return ok({ status: manager.saveGateStatus?.() ?? emptySaveGateStatus() })
      case 'save/flush':
        if (manager.saveGateFlush === undefined) {
          return fail('unsupported', 'acp: save/flush is not available')
        }
        return ok(await manager.saveGateFlush())
      case 'save/cancel': {
        if (manager.saveGateCancel === undefined) {
          return fail('unsupported', 'acp: save/cancel is not available')
        }
        const label = str(body, 'label', 256)
        return ok({ cancelled: manager.saveGateCancel(label) })
      }
      case 'save/retry': {
        if (manager.saveGateRetry === undefined) {
          return fail('unsupported', 'acp: save/retry is not available')
        }
        const label = str(body, 'label', 256)
        return ok({ retried: manager.saveGateRetry(label) })
      }
      case 'save/wait-idle': {
        if (manager.saveGateWaitIdle === undefined) {
          return fail('unsupported', 'acp: save/wait-idle is not available')
        }
        const timeoutMs = body.timeoutMs
        if (timeoutMs !== undefined && (typeof timeoutMs !== 'number' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > DEFAULT_SAVE_GATE_TIMEOUT_MS)) {
          throw new AcpError('bad_payload', `acp: timeoutMs must be an integer between 0 and ${String(DEFAULT_SAVE_GATE_TIMEOUT_MS)}`)
        }
        return ok({ idle: await manager.saveGateWaitIdle(timeoutMs as number | undefined) })
      }
      case 'plugin/update-check':
        // An older host half answers `unsupported` rather than failing: the
        // settings card then hides the update section.
        return ok(await (manager.pluginUpdateCheck?.() ?? { status: 'unsupported' as const, current: '' }))
      case 'plugin/update-apply': {
        const version = str(body, 'version', 64)
        if (!STABLE_SEMVER.test(version)) {
          throw new AcpError('bad_payload', 'acp: version must be a stable semver (x.y.z)')
        }
        return ok(await (manager.pluginUpdateApply?.(version) ?? { status: 'unsupported' as const, current: '' }))
      }
      case 'plugin/release-notes': {
        // Same version syntax as apply, but nothing is installed: this only
        // previews what a version says. `refresh` (the card's retry) must
        // reach the network, so it is passed through rather than swallowed.
        const version = str(body, 'version', 64)
        if (!STABLE_SEMVER.test(version)) {
          throw new AcpError('bad_payload', 'acp: version must be a stable semver (x.y.z)')
        }
        const refresh = body.refresh
        if (refresh !== undefined && typeof refresh !== 'boolean') {
          throw new AcpError('bad_payload', 'acp: refresh must be a boolean')
        }
        return ok(await (manager.pluginReleaseNotes?.(version, refresh)
          ?? { version, url: pluginReleaseUrl(version), source: 'none' as const }))
      }
      case 'agent/stop':
        await manager.stopAgent(str(body, 'agentId', 64)); return ok({ done: true })
      case 'default/agent':
        // The plugin's OWN default ACP agent (the panel's ★ gesture): which
        // agent an ACP-mode conversation starts on. `undefined` when none is
        // chosen yet, or the choice points at a deleted agent.
        //
        // NOT a DSH model route. It used to be reported as `{provider: 'acp',
        // model: agentId}` under `model/get-default`, which invited readers to
        // treat it as one — and the whole provider-route axis it fed has been
        // retired (see docs/acp-convergence.md §3 batch 1). The endpoint is
        // named for what it actually is.
        return ok({ agentId: manager.defaultAgent?.() })
      case 'default/agent-set': {
        const agentId = optionalStr(body, 'agentId', 64)
        await manager.setDefaultAgent?.(agentId)
        return ok({ done: true })
      }
      case 'ui/tag-halo':
        // Absent on a host half from before the setting existed: the browser
        // falls back to its own default instead of failing the read.
        return ok({ halo: manager.tagHalo?.() ?? DEFAULT_TAG_HALO })
      case 'ui/tag-halo-set': {
        await manager.setTagHalo?.(validateTagHalo(body.halo))
        return ok({ done: true })
      }
      case 'ui/session-title-prefix':
        // Absent on a host half from before the setting existed: the browser
        // shows off rather than guessing a value it cannot trust.
        return ok({ titlePrefix: manager.sessionTitlePrefix?.() ?? DEFAULT_SESSION_TITLE_PREFIX })
      case 'ui/session-title-prefix-set': {
        if (typeof body.titlePrefix !== 'boolean') throw new AcpError('bad_payload', 'acp: titlePrefix must be boolean')
        await manager.setSessionTitlePrefix?.(body.titlePrefix)
        return ok({ titlePrefix: manager.sessionTitlePrefix?.() ?? DEFAULT_SESSION_TITLE_PREFIX })
      }
      case 'ui/approval-deadlines':
        // Absent on a host half from before the card existed: the browser then
        // renders nothing rather than a number it cannot trust.
        return ok({ deadlines: manager.approvalDeadlines?.() })
      case 'ui/approval-deadlines-set': {
        const patch: ApprovalDeadlinePatch = {
          ...validateApprovalDeadlines({ permissionTimeoutMs: body.permissionTimeoutMs }),
          ...(body.mode === undefined ? {} : { mode: validatePermissionTimeoutMode(body.mode, 'bad_payload') }),
        }
        await manager.setApprovalDeadlines?.(patch, body.reset === true)
        return ok({ deadlines: manager.approvalDeadlines?.() })
      }
      case 'ui/idle-release':
        // Absent on a host half from before the tab existed: the browser then
        // renders nothing rather than a number it cannot trust.
        return ok({ idleRelease: manager.idleRelease?.() })
      case 'ui/idle-release-set': {
        const reset = body.reset === true
        const idleTimeoutMs = reset ? undefined : validateIdleReleaseMs(body.idleTimeoutMs, 'bad_payload')
        await manager.setIdleRelease?.(idleTimeoutMs, reset)
        return ok({ idleRelease: manager.idleRelease?.() })
      }
      case 'agent/set-exposed-models': {
        const agentId = str(body, 'agentId', 64)
        const raw = body.exposedModels
        if (raw === undefined) {
          await manager.setExposedModels?.(agentId, undefined)
          return ok({ done: true })
        }
        // Same normalizer as the config validator: the panel's "only my selected
        // models" mode sends every probed choice in one call, so the route must
        // accept exactly what the catalog can produce (constraint 8's sibling —
        // saving a filter must never be the thing that breaks).
        await manager.setExposedModels?.(agentId, normalizeExposedModels(raw, 'exposedModels', 'bad_payload'))
        return ok({ done: true })
      }
      case 'agent/set-auto-discover-models': {
        const agentId = str(body, 'agentId', 64)
        const autoDiscoverModels = body.autoDiscoverModels
        if (typeof autoDiscoverModels !== 'boolean') {
          return fail('bad_payload', 'acp: autoDiscoverModels must be a boolean')
        }
        await manager.setAutoDiscoverModels?.(agentId, autoDiscoverModels)
        return ok({ done: true })
      }
      case 'agent/probe-models': {
        if (manager.probeAgentModels === undefined) {
          return fail('unsupported', 'acp: agent/probe-models is not available')
        }
        // Must invoke as a method: extracting the function would drop the
        // manager receiver (`this`) and crash the real BridgeManager.
        return ok(await manager.probeAgentModels(str(body, 'agentId', 64), optionalStr(body, 'model', 200)))
      }
      case 'agent/cached-models': {
        // Persistent-cache read for the settings panel. `null` (not an error)
        // when the host has no cached catalog for this agent yet: the panel
        // renders its empty state, and the probe button is how it gets filled.
        const agentId = str(body, 'agentId', 64)
        return ok(manager.cachedAgentModels?.(agentId) ?? null)
      }
      case 'agent/catalog':
        // The seats' model list. Read-only and memory-only on purpose: the
        // conversation asks for it on every mount, so it must never spawn (a
        // probe only ever runs in the background behind it).
        return ok(manager.agentCatalog(str(body, 'agentId', 64)))
      default:
        return fail('unknown_endpoint', `acp: unknown endpoint ${endpoint}`)
    }
  } catch (error) {
    if (error instanceof AcpError) return fail(error.code, error.message)
    return fail('internal', error instanceof Error ? error.message : String(error))
  }
}
