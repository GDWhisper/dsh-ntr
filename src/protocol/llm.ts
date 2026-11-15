/**
 * LLM adapter contract: the DSH core streaming shapes this plugin's adapter implements.
 *
 * Part of the protocol contract; the barrel is `src/protocol.ts` and every
 * existing `../protocol.ts` import keeps resolving through it. Pure types,
 * constants and pure helpers only — no side effects, no Node APIs, no ACP SDK
 * runtime values (type-only SDK imports are erased at build time).
 */

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
