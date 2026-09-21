/**
 * dsh-ntr shared contracts (browser-safe: types only, zero runtime code).
 *
 * Two planes:
 * - `AcpEvent`: host → browser, one JSON frame per `session/update` fold,
 *   permission round-trip, agent process status, and turn lifecycle.
 * - RPC payloads: browser → host unary calls on the `/acp` Connection channel.
 *
 * Security invariants encoded here (enforced host-side in impl.ts):
 * - The browser never names a program to spawn; it selects a configured
 *   agent id and a cwd that must resolve inside the agent's allowed roots.
 * - Agent environment variables flow config → child process only.
 */

import type { SessionUpdate } from '@agentclientprotocol/sdk'

// ---- Configuration (host side, from the profile layer) ----

/**
 * Per-agent *policy* for `session/request_permission` — it decides whether a
 * human is asked at all, NOT where the question is rendered.
 *
 * - `ask`: surface every request to a human. The surface is picked by host
 *   capability: the chat composer when the native approval chain is wired
 *   (see `AgentsListResult.approvalRouted`), otherwise the settings panel.
 * - `allow` / `reject`: answer automatically, nothing is ever surfaced.
 */
export type PermissionMode = 'ask' | 'allow' | 'reject'

/** One pre-configured ACP agent executable. */
export interface AcpAgentDef {
  /** Stable id the browser selects by. `^[a-z0-9][a-z0-9._-]*$`. */
  id: string
  /** Display name (defaults to the id). */
  title?: string
  /** Executable spawned over stdio; NEVER supplied by the browser. */
  command: string
  /** Argument vector (no shell interpretation). */
  args?: string[]
  /**
   * npm package installed globally (`npm install -g`) when `command` cannot be
   * resolved on the host PATH, right before the spawn is attempted. Unset → a
   * missing command just fails with ENOENT. Name-only charset is enforced by
   * `validateAgentDef` (no shell metacharacters can ever reach the installer).
   */
  npmPackage?: string
  /** Child environment layered over a credential-scrubbed copy of the host env. */
  env?: Record<string, string>
  /** Default absolute workspace directory for new sessions. */
  cwd?: string
  /** Absolute roots a session cwd may resolve under. Defaults to `[cwd]`. */
  allowedCwdRoots?: string[]
  /** Permission policy: `ask` (default, surfaces the human), `allow`, `reject`. */
  permission?: PermissionMode
  /**
   * Which probed `category: model` choices this agent offers as `agentId@choice`
   * variants in the plugin's own ACP seats (the chips/picker in the chat
   * composer and the ACP-mode model seat). Those menus have no search, so the
   * full catalog is a list storm nobody can navigate: a real pi agent publishes
   * 500 choices, omp 581. Variants are **opt-in** — unset or empty offers none
   * of them, and only the listed choice values are added. The bare `agentId`
   * entry (the agent's own default model) is always offered regardless, so an
   * agent is never unreachable. Filtering only affects listing — hidden
   * variants still resolve and stream (see `agent/catalog`).
   *
   * ACP models are deliberately absent from DSH's native model selector — see
   * {@link AgentCatalogResult} for why that is structural, not cosmetic.
   */
  exposedModels?: string[]
  /**
   * How long this agent's process may sit READY with no live session and
   * nothing in flight before the host releases it (kills the child). Unset →
   * the host default (30 minutes). `0` = never release, and only agents with
   * no live session are ever candidates (see `AgentBridge.releaseIfIdle`):
   * probing / post-save spawns are what leak processes, since they hold no
   * session at all. Nothing is lost either way — a released session is
   * resumed with `session/load` on the next send.
   */
  idleTimeoutMs?: number
}

export interface AcpPluginConfig {
  agents: AcpAgentDef[]
  /** Per-session transcript ring bound (default 600 entries). */
  transcriptMaxEntries?: number
  /**
   * Probe each configured agent's model catalog by spawning a throwaway ACP
   * session. Defaults to `true` (boot probe for agents without a persisted
   * catalog, plus a lazy probe when an ACP seat first asks for a list).
   * `false` disables every automatic spawn; the catalog then only fills from
   * real sessions or the manual probe button.
   */
  probeModelsOnBoot?: boolean
  /**
   * Budget for one agent startup step (`initialize`, `session/new`, and the
   * `session/load` of a resume). An agent that does not answer within this
   * window is killed and the request fails with `agent_timeout` instead of
   * hanging forever. Default 60000 ms.
   */
  startupTimeoutMs?: number
  /**
   * How long a pending `session/request_permission` (`permission: ask`) may
   * sit unanswered before the host answers `cancelled` on the user's behalf.
   * `0` (default) waits forever — the human decides, matching the ACP spec's
   * stance that approvals belong to a person.
   */
  permissionTimeoutMs?: number
  /**
   * After `session/cancel`, how long to wait for the agent to settle the turn
   * before the host force-finalizes it. An agent that ignores the cancel
   * notification must not wedge the session in `running` forever.
   * Default 15000 ms; `0` disables the fallback.
   */
  cancelFallbackMs?: number
  /**
   * Install the bundled ACP-mode agent preset into the roster's user root
   * (`~/.dsh/.agent-presets/acp`) at boot when it is absent. Default `true`;
   * an existing preset is never touched.
   */
  installAcpPreset?: boolean
}

// ---- Host → browser events (`/api/acp/stream`, SSE) ----

export type AgentProcessState = 'stopped' | 'starting' | 'ready' | 'error'

/** Agent facts the browser may render (never includes env/argv secrets beyond argv itself, which is config-visible). */
/**
 * Install state of the ACP-mode agent preset (`presets/acp` → the roster's user
 * root). Read-only report: the panel shows it, and the browser can only ask the
 * host to (re)install from the bundled copy.
 */
export interface AcpPresetStatus {
  /** Preset id, which is also its directory name. */
  id: string
  /** Absolute target directory under the user preset root. */
  dir: string
  /** Whether the directory exists — an existing preset is never overwritten. */
  installed: boolean
  /** Bundled files absent from the installed copy (the repair list). */
  missing: string[]
}

export interface AgentView {
  id: string
  title: string
  command: string
  args: string[]
  permission: PermissionMode
  cwd?: string
  allowedCwdRoots: string[]
  state: AgentProcessState
  /** Last stderr lines when state is `error` (diagnostics). */
  stderrTail?: string[]
  /** `initialize` result, once the process is ready. */
  agentInfo?: { name?: string; title?: string; version?: string }
  agentCapabilities?: unknown
  liveSessions: string[]
  /**
   * The window the host actually honors for this agent (its own
   * `idleTimeoutMs`, else the host default). Resolved, not raw, so the panel
   * can show a concrete number instead of guessing at a default; `0` = never
   * released. Absent on an older host half.
   */
  idleTimeoutMs?: number
}

export type AcpEvent =
  | { type: 'agent/status'; agentId: string; state: AgentProcessState; error?: string; agent?: AgentView }
  | { type: 'agent/notice'; agentId: string; level: 'info' | 'error'; text: string }
  | { type: 'session/created'; sessionId: string; session: SessionView }
  | { type: 'session/meta'; sessionId: string; session: SessionView }
  | { type: 'session/closed'; sessionId: string; reason: 'closed' | 'agent-stopped' | 'agent-died' }
  | {
    /** The agent process died: the session is kept resumable, not destroyed. */
    type: 'session/released'
    sessionId: string
    session: SessionView
    reason: string
  }
  | {
    /**
     * The session was resumed through `session/load` on a fresh agent
     * process; the agent replays its history as fresh `session/update`s, so
     * the browser must drop local blocks and the seq watermark first.
     */
    type: 'session/reset'
    sessionId: string
    session: SessionView
  }
  | { type: 'session/update'; sessionId: string; seq: number; update: SessionUpdate }
  | { type: 'permission/request'; requestId: string; sessionId: string; toolCall: unknown; options: PermissionOptionView[] }
  | { type: 'permission/resolved'; requestId: string; sessionId: string; outcome: PermissionOutcome }
  | { type: 'turn/start'; sessionId: string; turnId: string; text: string }
  | { type: 'turn/end'; sessionId: string; turnId: string; stopReason?: string; error?: string }

export interface PermissionOptionView {
  optionId: string
  name: string
  kind: string
}

export type PermissionOutcome = { outcome: 'selected'; optionId: string } | { outcome: 'cancelled' }

/** Derived session snapshot for replay/reconnect (source of truth stays in the transcript). */
export interface SessionView {
  sessionId: string
  agentId: string
  acpSessionId: string
  cwd: string
  title?: string
  modes?: { currentModeId?: string; availableModes?: Array<{ id: string; name?: string; description?: string }> }
  configOptions?: unknown[]
  availableCommands?: Array<{ name: string; description?: string }>
  plan?: unknown[]
  usage?: { used: number; size: number; cost?: { amount: number; currency: string } }
  running: boolean
  closed: boolean
  /**
   * The owning agent process died and the session awaits a `session/load`
   * resume. Resuming happens implicitly on the next prompt ("send to
   * recover") when the agent declares the `loadSession` capability.
   */
  released?: boolean
  /** Highest transcript seq included in this snapshot (for gap detection). */
  seq: number
}

// ---- Browser → host RPC (`/acp` channel; payloads below) ----

export type RpcResult<T> = {
  ok: true
  value: T
} | {
  ok: false
  /** Mirrors the host `ConnectionRpcFailure` shape (details is transport-mandated). */
  error: { code: string; message: string; details: object }
}

export interface AgentsListResult {
  agents: AgentView[]
  /**
   * True when permission asks are routed to the host approval chain and the
   * browser must stop rendering the settings-panel permission card. False (or
   * absent on an older host) keeps the degraded ledger path visible.
   */
  approvalRouted?: boolean
  /**
   * True when a chat-backed session's *DSH access mode* (the composer's Access
   * mode control) governs its permission asks and fs writes, so the agent-level
   * `permission` field below only applies to sessions without a chat binding
   * (`/acp` RPC). False (or absent on an older host) means the agent field
   * governs everything, as it did before the mapping existed.
   */
  accessModeRouted?: boolean
}
export type SessionStartResult = { sessionId: string; session: SessionView }
export type SessionPromptResult = { accepted: true; turnId: string }
export type TranscriptResult = { session: SessionView; entries: Array<{ seq: number; update: SessionUpdate }> }
export type SessionsListResult = { sessions: SessionView[] }

/**
 * One ACP agent session currently backing a DSH chat session, looked up by the
 * chat session id the composer already knows. This is what lets the browser
 * expose an agent's OWN mode list in the conversation (the ACP-native control),
 * independently of the host's Access mode preset.
 */
export interface ChatSessionView {
  agentId: string
  /** Display name of the agent definition, when it differs from the id. */
  agentTitle?: string
  /** Host-minted session id (stable across an agent restart). */
  sessionId: string
  title?: string
  /** The agent's declared modes, when it has any (`session/new` / `session/load`). */
  modes?: SessionView['modes']
  /** The agent process died; the session awaits a `session/load` resume. */
  released?: boolean
}
export type ChatSessionsListResult = { sessions: ChatSessionView[] }

/**
 * The `session/chat-list` answer: the backing ACP sessions, plus whether that
 * DSH chat session runs the ACP agent preset (host-read from the session log).
 * The composer's model-seat gate falls back to the latter when the client
 * runtime's session rows carry no `agentPreset` — on such hosts it is the only
 * fact source the seat takeover has.
 */
export interface ChatSessionListResult extends ChatSessionsListResult {
  acpMode?: boolean
}

/**
 * One ACP session's folded transcript, addressed by its DSH chat session.
 *
 * This is the data behind the conversation's ACP view tab: the native chat
 * plane can only ever show text/reasoning (that is the LLM adapter's whole
 * chunk vocabulary), so tool calls, plans and diffs have no home there — they
 * only exist in the ACP transcript, and this is how the browser reaches it
 * without knowing an ACP session id up front.
 */
export interface ChatTranscriptView {
  session: SessionView
  /**
   * Raw ACP `session/update` payloads in seq order (the fold happens
   * client-side). `unknown` is deliberate, matching `TranscriptResult`: the
   * host's buffer is transport-agnostic and must not import the SDK.
   */
  entries: Array<{ seq: number; update: unknown }>
}
export type ChatTranscriptResult = { views: ChatTranscriptView[] }
export interface ChatTranscriptPayload { dshSessionId: string; afterSeq?: number }

export interface SessionStartPayload { agentId: string; cwd?: string }
export interface SessionPromptPayload { sessionId: string; text: string }
export interface SessionIdPayload { sessionId: string }
export interface PermissionRespondPayload { requestId: string; optionId?: string }
export interface SessionModeSetPayload { sessionId: string; modeId: string }
export interface SessionConfigSetPayload { sessionId: string; configId: string; value: string | boolean }
export interface TranscriptGetPayload { sessionId: string; afterSeq?: number }
export interface AgentIdPayload { agentId: string }
export interface AgentPermissionSetPayload { agentId: string; permission: PermissionMode }
export interface ModelDefaultSetPayload { agentId: string }
export type ModelDefaultResult = { provider?: string; model?: string }

/** Host-detected agent presence and tested defaults. */
export interface DetectedAgentInfo {
  id: string
  name: string
  description?: string
  detected: boolean
  executablePath?: string
  defaultCommand: string
  defaultArgs: string[]
  currentConfig?: AcpAgentDef
}

export type AgentDetectResult = { agents: DetectedAgentInfo[] }

export interface AgentSavePayload {
  id: string
  title?: string
  command: string
  args?: string[]
  npmPackage?: string
  cwd?: string
  allowedCwdRoots?: string[]
  permission?: PermissionMode
  env?: Record<string, string>
  exposedModels?: string[]
  /** Absent → keep the host default (30 minutes); `0` = never release. */
  idleTimeoutMs?: number
}

/** Result of `agent/test`: spawn + initialize a throwaway process from form values, then tear it down. */
export interface AgentTestResult {
  ok: boolean
  /** Failure reason when `ok` is false (spawn ENOENT, install failure, initialize timeout, …). */
  error?: string
  /** The agent's `initialize` identity, when the handshake completed. */
  agentInfo?: { name?: string; title?: string; version?: string }
  /** Wall-clock cost of the whole test, including a triggered npm install. */
  durationMs: number
  /** Tail of the child's stderr (and installer output), newest last. */
  stderr: string[]
}

export interface AgentExposedModelsPayload {
  agentId: string
  /** Absent → clear the filter (expose no variants); array (even empty) → expose exactly these. */
  exposedModels?: string[]
}

// ---- Model catalog (host-side cache of ACP `configOptions`) ----

/** One selectable value of a `model` / `thought_level` config option. */
export interface AcpCatalogChoice {
  value: string
  name: string
  description?: string
  /**
   * Label of the `SessionConfigSelectGroup` this choice arrived under
   * (commonly the vendor); absent when the agent ships a flat option list.
   * Deliberately never guessed from name/value — vendors cross-list models,
   * so only the agent's own grouping is trustworthy.
   */
  group?: string
}

/** A parsed `category: model | thought_level` select option for one agent. */
export interface AcpCatalogOption {
  configId: string
  name: string
  /** Currently selected value at parse time (may be absent from `choices`). */
  currentValue: string | null
  choices: AcpCatalogChoice[]
}

/** The model/thought-level catalog derived from one agent's `configOptions`. */
export interface AcpAgentCatalog {
  model?: AcpCatalogOption
  thought?: AcpCatalogOption
}

/** Result of `agent/probe-models`: the freshly probed (or cached) catalog. */
export interface AgentProbeModelsResult {
  agentId: string
  catalog: AcpAgentCatalog
  updatedAt: number
}

/**
 * Result of `agent/catalog`: the ACP model surface for ONE agent.
 *
 * THIS IS THE ONLY PLACE ACP MODELS EXIST. DSH builds its provider/model
 * catalog per *request*, not per session — `buildModelCatalog(ctx)` takes no
 * session id, so every session's model directory is that same global list. A
 * provider that advertises models therefore advertises them to every
 * conversation, including the ones where the external agent has no tool
 * registration, no runtime context and is not the model talking at all. The
 * `acp` route consequently advertises nothing (`LlmAdapter.listModels` is
 * advisory — exact ids still resolve and stream), and the plugin's own seats
 * read this per-agent view instead. There is no per-session seam on the host
 * to filter the global catalog with, so "advertise nothing" is the only
 * structurally honest isolation.
 *
 * Read-only and memory-only: it never spawns. An agent without a cached
 * catalog merely gets a background probe, exactly like the old selector path.
 */
export interface AgentCatalogResult {
  agentId: string
  /** Agent display name (`title` ?? id). */
  title: string
  /** The bare-`agentId` entry: the agent's own default model, always offered. */
  base: { id: string; name: string; description?: string }
  /** The `agentId@choice` variants this agent exposes (`exposedModels` applied). */
  variants: Array<{ id: string; name: string; description?: string }>
  /**
   * Reasoning efforts from the agent's own `thought_level` option, when it
   * advertises one. Agent-wide by construction (a thought level is not a
   * property of one model), which is why it rides here and not on `variants`.
   */
  reasoning?: LlmModelReasoningInfo
  /** A probe has produced a catalog for this agent (`false` → base entry only). */
  probed: boolean
  /** When the cached catalog was last refreshed. */
  updatedAt?: number
}

// ---- LLM Streaming & Adapter types (shared with DSH core LLM service) ----

export interface LlmModelInfo {
  provider: string
  id: string
  name: string
  description?: string
  inputModalities?: readonly string[]
}

/** One reasoning effort advertised by a model (mirrors DSH `LlmReasoningEffortInfo`). */
export interface LlmReasoningEffortInfo {
  id: string
  name: string
  description?: string
}

/** Reasoning metadata (mirrors DSH `LlmModelReasoningInfo`): `defaultEffort` must be one of `efforts`. */
export interface LlmModelReasoningInfo {
  efforts: readonly LlmReasoningEffortInfo[]
  defaultEffort?: string
}

export interface LlmResolvedModelInfo extends LlmModelInfo {
  context?: { contextWindow: number }
  defaultMaxTokens?: number
  reasoning?: LlmModelReasoningInfo
}

export interface LlmProviderInfo {
  id: string
  name: string
}

export type StreamChunk =
  | { type: 'block-start'; index: number; blockType: 'text' | 'reasoning' | 'tool-call' | 'tool-result' }
  | { type: 'text-delta'; index: number; text: string }
  | { type: 'reasoning-delta'; index: number; text: string }
  | { type: 'tool-call-delta'; index: number; id: string; name?: string; argumentsDelta: string }
  | { type: 'block-end'; index: number; block: unknown }
  | { type: 'usage'; usage: { inputTokens: number; outputTokens: number } }
  | {
    type: 'finish'
    reason:
      | { kind: 'stop' }
      | { kind: 'aborted'; failure?: { message: string; code: string } }
      | { kind: 'error'; failure?: { message: string; code: string } }
  }

/**
 * Provenance of one message in a host-built request. The host tags every
 * message, and the tag is the only way to tell the user's own words apart from
 * the context sections the harness injects around them (`agent-instructions`,
 * `skill-catalog`, the `@deepseek-ai/dsh-system-prompt` runtime snapshot, tool
 * results) — see AGENTS.md rule 16.
 */
export interface GenerateMessageSource {
  kind?: string
  plugin?: string
  form?: string
  [k: string]: unknown
}

export interface GenerateMessage {
  role: 'system' | 'user' | 'assistant'
  content: Array<{ type: string; text?: string; [k: string]: unknown }>
  /** Host provenance; absent sources are treated as real user input (hand-built callers). */
  source?: GenerateMessageSource
  /** Stable identity of the durable message, when the host built the request from a session log. */
  id?: string
}

export interface GenerateOptions {
  provider: string
  model: string
  /** Adapter-owned reasoning effort selected for this exact model. */
  reasoningEffort?: string
  messages: GenerateMessage[]
  system?: string
  signal?: AbortSignal
  sessionId?: string
  /**
   * Auxiliary (non-conversation) call classification, e.g. `session-title` or
   * `compaction`. Ordinary turns leave it unset; an ACP bridge must never turn
   * one of these into a remote agent turn.
   */
  purpose?: string
}

export interface PreparedAdapterCall {
  readonly model: LlmResolvedModelInfo
  stream(options: GenerateOptions): AsyncIterable<StreamChunk>
}

export interface LlmAdapterLike {
  providerInfo?(provider: string): LlmProviderInfo
  providerRetryPolicy?(provider: string): unknown
  imageRequestPricing?(provider: string, model: string): unknown
  listModels?(provider: string): Promise<readonly LlmModelInfo[]>
  resolveModel?(provider: string, model: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo>
  prepareCall?(provider: string, model: string, signal?: AbortSignal): Promise<PreparedAdapterCall>
  stream(options: GenerateOptions): AsyncIterable<StreamChunk>
}

