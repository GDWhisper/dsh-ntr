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
}

export interface AcpPluginConfig {
  agents: AcpAgentDef[]
  /** Per-session transcript ring bound (default 600 entries). */
  transcriptMaxEntries?: number
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
  | { type: 'session/created'; sessionId: string; session: SessionView }
  | { type: 'session/meta'; sessionId: string; session: SessionView }
  | { type: 'session/closed'; sessionId: string; reason: 'closed' | 'agent-stopped' | 'agent-died' }
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
}

// ---- LLM Streaming & Adapter types (shared with DSH core LLM service) ----

export interface LlmModelInfo {
  provider: string
  id: string
  name: string
  description?: string
  inputModalities?: readonly string[]
}

export interface LlmResolvedModelInfo extends LlmModelInfo {
  context?: { contextWindow: number }
  defaultMaxTokens?: number
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

