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

/** How the human answers the agent's `session/request_permission`. */
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
  /** Child environment layered over a credential-scrubbed copy of the host env. */
  env?: Record<string, string>
  /** Default absolute workspace directory for new sessions. */
  cwd?: string
  /** Absolute roots a session cwd may resolve under. Defaults to `[cwd]`. */
  allowedCwdRoots?: string[]
  /** Permission policy: `ask` (default, surfaces the human), `allow`, `reject`. */
  permission?: PermissionMode
  /**
   * Which probed `category: model` choices are exposed as `agentId@choice`
   * variants in the native chat model selector (the selector has no search,
   * so an unfiltered pi agent floods it). Unset → every choice is exposed;
   * set → only the listed choice values. The bare `agentId` entry (the
   * agent's own default model) is always exposed regardless. Filtering only
   * affects listing — hidden variants still resolve and stream.
   */
  exposedModels?: string[]
}

export interface AcpPluginConfig {
  agents: AcpAgentDef[]
  /** Per-session transcript ring bound (default 600 entries). */
  transcriptMaxEntries?: number
  /**
   * Probe each configured agent's model catalog by spawning a throwaway ACP
   * session. Defaults to `true` (boot probe for agents without a persisted
   * catalog, plus a lazy probe when the model selector first needs one).
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
}

// ---- Host → browser events (`/api/acp/stream`, SSE) ----

export type AgentProcessState = 'stopped' | 'starting' | 'ready' | 'error'

/** Agent facts the browser may render (never includes env/argv secrets beyond argv itself, which is config-visible). */
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

export type AgentsListResult = { agents: AgentView[] }
export type SessionStartResult = { sessionId: string; session: SessionView }
export type SessionPromptResult = { accepted: true; turnId: string }
export type TranscriptResult = { session: SessionView; entries: Array<{ seq: number; update: SessionUpdate }> }
export type SessionsListResult = { sessions: SessionView[] }

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
  cwd?: string
  allowedCwdRoots?: string[]
  permission?: PermissionMode
  env?: Record<string, string>
  exposedModels?: string[]
}

export interface AgentExposedModelsPayload {
  agentId: string
  /** Absent → clear the filter (expose everything); array (even empty) → expose exactly these. */
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

export interface GenerateOptions {
  provider: string
  model: string
  /** Adapter-owned reasoning effort selected for this exact model. */
  reasoningEffort?: string
  messages: Array<{
    role: 'system' | 'user' | 'assistant'
    content: Array<{ type: string; text?: string; [k: string]: unknown }>
  }>
  system?: string
  signal?: AbortSignal
  sessionId?: string
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

