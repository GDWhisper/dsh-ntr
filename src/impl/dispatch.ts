/**
 * The `/acp` RPC surface: the `AcpManager` face the bridge fills and the one
 * dispatcher every `POST /acp/*` goes through.
 *
 * Pure in the module-purity sense — the manager is an interface, so dispatch is
 * testable with a fake — and deliberately boring: one `switch` over endpoint
 * strings, validation in a fixed order, errors as `{ok:false, error}` values
 * (never throws), ACP `error.data` read before the message.
 *
 * Part of the host-half logic; the barrel is `src/impl.ts`.
 */

import type {
  AcpAgentDef, AcpApprovalDeadlines, AcpConversationChoice, AcpDelegateSettings, AcpIdleRelease, AcpPresetStatus, AcpSharedMcpSettings, AcpTagHalo, AcpEvent, ActiveTurnView, AgentCatalogResult, AgentProbeModelsResult, AgentSaveMode, AgentSaveResult, AgentSkillsResult, AgentTestResult,
  AgentView, ApprovalDeadlinePatch, ChatSessionView, ChatTranscriptView, DelegateSetPayload, DetectedAgentInfo, ElicitationOutcome, PermissionOutcome, PermissionOptionView, PermissionTimeoutMode, PluginReleaseNotes, PluginUpdateState, RpcResult,
  SaveGateFlushResult, SaveGateStatus, SharedMcpSetPayload, SubagentDetailResult,
} from '../protocol.ts'
import { DEFAULT_MODE_MAX, DEFAULT_SAVE_GATE_TIMEOUT_MS, DEFAULT_SESSION_TITLE_PREFIX, DEFAULT_TAG_HALO, pluginReleaseUrl } from '../protocol.ts'
import { subagentToolCallId } from '../subagent-records.ts'
import { validateElicitationOutcome } from './elicitation.ts'
import { AcpError } from './errors.ts'
import type { PromptContentBlock } from './image.ts'
import {
  normalizeExposedModels, validateAgentDef, validateApprovalDeadlines, validateDelegateSettings, validateIdleReleaseMs, validateMcpServers, validatePermissionTimeoutMode, validateTagHalo,
} from './validate.ts'

// ---- RPC surface ----

/** The only version shape the update endpoints accept: an exact stable semver. */
const STABLE_SEMVER = /^\d+\.\d+\.\d+$/

/** The bridge-manager face the dispatcher talks to (interface keeps dispatch pure-testable). */
export interface AcpManager {
  agentViews(): AgentView[]
  startSession(agentId: string, cwd: string | undefined): Promise<{ sessionId: string; cwd?: string }>
  prompt(sessionId: string, prompt: string | PromptContentBlock[]): Promise<{ turnId: string }>
  cancel(sessionId: string): Promise<void>
  closeSession(sessionId: string): Promise<void>
  setMode(sessionId: string, modeId: string): Promise<void>
  setConfigOption(sessionId: string, configId: string, value: string | boolean): Promise<void>
  respondPermission(requestId: string, optionId: string | undefined): void
  respondElicitation(requestId: string, outcome: ElicitationOutcome): void
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
   * Whether the built-in read-only `dsh-skills` MCP server is offered to
   * agents (default off). Applies to sessions created from now on; a live
   * process keeps whatever list it was started with.
   */
  skillsMcpEnabled?(): boolean
  /** Write the skills MCP switch: strict persist, then hot-apply. */
  setSkillsMcpEnabled?(value: boolean): Promise<void>
  /** Unified MCP settings (shared servers + optional host `dsh-mcp-manager` sync). */
  sharedMcp?(): AcpSharedMcpSettings
  /** Write unified MCP servers and/or host sync toggle (strict persist). */
  setSharedMcp?(patch: SharedMcpSetPayload): Promise<void>
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
  /**
   * The delegation settings in force (the `acp_delegate` card), with the
   * deployment-baseline facts an override outranks and the host's capability
   * flags. `undefined` on a host half from before the card existed, which
   * hides the settings tab instead of showing a number this browser invented.
   */
  delegateSettings?(): AcpDelegateSettings | undefined
  /**
   * Write delegation settings (omitted keys keep their value), or drop the
   * persisted overrides for the keys named in `reset` so the deployment
   * baseline (or the built-in default) applies again. Applies to the running
   * bridges without a restart.
   */
  setDelegateSettings?(patch: DelegateSetPayload): Promise<void>
  detectAgents?(): Promise<DetectedAgentInfo[]>
  saveAgent?(def: AcpAgentDef, mode?: AgentSaveMode): Promise<AgentSaveResult>
  deleteAgent?(agentId: string): Promise<void>
  /**
   * Spawn a throwaway process from raw form values (never persisted, never
   * registered), run the ACP handshake, tear it down, and report the outcome.
   * May trigger the def's npm auto-install.
   */
  testAgent?(def: AcpAgentDef): Promise<AgentTestResult>
  /** Update which probed model choices the ACP seats offer; `undefined` resets to default-open (all published models). Must not restart the agent. */
  setExposedModels?(agentId: string, exposedModels: readonly string[] | undefined): Promise<void>
  /** Toggle auto-discovery of newly published models. Must not restart the agent. */
  setAutoDiscoverModels?(agentId: string, autoDiscoverModels: boolean): Promise<void>
  /**
   * Opt ONE agent out of (or back into) the built-in `dsh-skills` MCP server.
   * In-place definition edit + strict persist: must not restart the agent and
   * must not go through `agent/save`. See {@link AcpAgentDef.skillsMcpEnabled}.
   */
  setSkillsMcp?(agentId: string, skillsMcpEnabled: boolean): Promise<void>
  setSharedMcpAgent?(agentId: string, sharedMcpEnabled: boolean): Promise<void>
  /** Per-agent default chat mode; `undefined` / blank clears it. */
  setDefaultMode?(agentId: string, defaultMode?: string): Promise<void>
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
        // The whole answer rides through (`ok` picks no fields): the manager's
        // additive `cwd` (the resolved session directory) reaches the wire.
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
      case 'elicitation/respond': {
        const requestId = str(body, 'requestId', 64)
        const outcome = validateElicitationOutcome(body.action, body.content)
        manager.respondElicitation(requestId, outcome)
        return ok({ done: true })
      }
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
      case 'ui/skills-mcp':
        // Absent on a host half from before the switch existed: off, never a
        // guessed "on" (an unread value must not advertise an MCP server).
        return ok({ skillsMcpEnabled: manager.skillsMcpEnabled?.() === true })
      case 'ui/skills-mcp-set': {
        // Strictly a boolean: a missing / string / object value must not be
        // coerced into a write (there is no "false-like" here, only bad input).
        if (typeof body.skillsMcpEnabled !== 'boolean') {
          throw new AcpError('bad_payload', 'acp: skillsMcpEnabled must be boolean')
        }
        await manager.setSkillsMcpEnabled?.(body.skillsMcpEnabled)
        return ok({ skillsMcpEnabled: manager.skillsMcpEnabled?.() === true })
      }
      case 'ui/shared-mcp':
        return ok({ sharedMcp: manager.sharedMcp?.() })
      case 'ui/shared-mcp-set': {
        const patch: SharedMcpSetPayload = {}
        if (body.servers !== undefined) {
          patch.servers = validateMcpServers(body.servers, 'sharedMcp.servers', 'bad_payload')
        }
        if (body.hostSyncEnabled !== undefined) {
          if (typeof body.hostSyncEnabled !== 'boolean') {
            throw new AcpError('bad_payload', 'acp: hostSyncEnabled must be boolean')
          }
          patch.hostSyncEnabled = body.hostSyncEnabled
        }
        if (patch.servers === undefined && patch.hostSyncEnabled === undefined) {
          throw new AcpError('bad_payload', 'acp: sharedMcp patch must name servers or hostSyncEnabled')
        }
        await manager.setSharedMcp?.(patch)
        return ok({ sharedMcp: manager.sharedMcp?.() })
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
      case 'ui/delegate':
        // Absent on a host half from before the card existed: the browser then
        // renders nothing rather than a number it cannot trust.
        return ok({ delegate: manager.delegateSettings?.() })
      case 'ui/delegate-set': {
        const patch = validateDelegateSettings(body)
        await manager.setDelegateSettings?.(patch)
        return ok({ delegate: manager.delegateSettings?.() })
      }
      case 'agent/set-exposed-models': {
        const agentId = str(body, 'agentId', 64)
        const raw = body.exposedModels
        // Absent → reset to the default-open state (every published model is
        // offered); an explicit array — including `[]` — is the user's
        // narrowing (empty = only the base / currently-in-force row). The two
        // are different states and must never be merged here.
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
      case 'agent/set-skills-mcp': {
        const agentId = str(body, 'agentId', 64)
        // Strictly a boolean: the switch is stored as an explicit opt-out, so
        // a missing / string / null value has no "false-like" reading — it is
        // bad input and must not write.
        if (typeof body.skillsMcpEnabled !== 'boolean') {
          return fail('bad_payload', 'acp: skillsMcpEnabled must be a boolean')
        }
        await manager.setSkillsMcp?.(agentId, body.skillsMcpEnabled)
        return ok({ done: true })
      }
      case 'agent/set-shared-mcp': {
        const agentId = str(body, 'agentId', 64)
        if (typeof body.sharedMcpEnabled !== 'boolean') {
          return fail('bad_payload', 'acp: sharedMcpEnabled must be a boolean')
        }
        await manager.setSharedMcpAgent?.(agentId, body.sharedMcpEnabled)
        return ok({ done: true })
      }
      case 'agent/set-default-mode': {
        const agentId = str(body, 'agentId', 64)
        // An absent / empty field is the explicit "follow the agent" answer,
        // not bad input: the control sends `''` when the user clears it.
        await manager.setDefaultMode?.(agentId, optionalStr(body, 'defaultMode', DEFAULT_MODE_MAX))
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
