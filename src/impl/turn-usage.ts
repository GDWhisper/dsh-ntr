/**
 * Pure ACP turn token-usage normalization and CodeBuddy `_meta.usage` extraction.
 *
 * DSH's `dsh-token-meter` enforces a strict disjoint invariant on `TokenUsage`:
 * - `inputTokens` is UNCACHED input only;
 * - `totalTokens` (when present) must satisfy
 *   `totalTokens - outputTokens >= inputTokens + (cacheReadTokens ?? 0) + (cacheWriteTokens ?? 0)`
 *   and exact equality when both cache fields are present;
 * - when `totalTokens` is omitted, BOTH `cacheReadTokens` and `cacheWriteTokens`
 *   are required by `dsh-token-meter` — so deriving `totalTokens` when absent
 *   satisfies the meter without inventing fake `0` cache fields;
 * - `reasoningTokens <= outputTokens`, and all counts are non-negative safe integers.
 *
 * Pure module: no Node imports, no SDK imports.
 */

export interface AcpTurnUsage {
  inputTokens: number
  outputTokens: number
  totalTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  reasoningTokens?: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readCount(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return undefined
  const n = value === 0 ? 0 : Math.trunc(value)
  return Number.isSafeInteger(n) ? n : undefined
}

function readRequiredField(
  row: Record<string, unknown>,
  keys: readonly string[],
): { valid: boolean; value: number | undefined } {
  let firstPositive: number | undefined
  let sawZero = false
  for (const key of keys) {
    const raw = row[key]
    if (raw === undefined || raw === null) continue
    const count = readCount(raw)
    if (count === undefined) return { valid: false, value: undefined }
    if (count > 0 && firstPositive === undefined) firstPositive = count
    else if (count === 0) sawZero = true
  }
  return { valid: true, value: firstPositive ?? (sawZero ? 0 : undefined) }
}

function readBucketCount(
  row: Record<string, unknown>,
  topKeys: readonly string[],
  nestedSources: ReadonlyArray<readonly [unknown, readonly string[]]> = [],
): number | undefined {
  // Some agents (e.g. CodeBuddy rawUsage) emit Anthropic-style `0` placeholders
  // alongside populated DeepSeek/OpenAI fields; prefer the first positive count
  // and only fall back to `0` when every present candidate is zero.
  let sawZero = false
  for (const key of topKeys) {
    const count = readCount(row[key])
    if (count === undefined) continue
    if (count > 0) return count
    sawZero = true
  }
  for (const [container, keys] of nestedSources) {
    const count = readNestedCount(container, keys)
    if (count === undefined) continue
    if (count > 0) return count
    sawZero = true
  }
  return sawZero ? 0 : undefined
}

function sumArrayCounts(entries: unknown, keys: readonly string[]): number | undefined {
  if (!Array.isArray(entries)) return undefined
  let total = 0
  let sawAny = false
  for (const entry of entries) {
    if (!isRecord(entry)) continue
    const count = readBucketCount(entry, keys)
    if (count === undefined) continue
    total += count
    sawAny = true
  }
  return sawAny && Number.isSafeInteger(total) ? total : undefined
}

function readNestedCount(container: unknown, keys: readonly string[]): number | undefined {
  if (Array.isArray(container)) return sumArrayCounts(container, keys)
  if (isRecord(container)) return readBucketCount(container, keys)
  return undefined
}

function readCacheReadTokens(row: Record<string, unknown>): number | undefined {
  return readBucketCount(
    row,
    [
      'cacheReadTokens',
      'cachedReadTokens',
      'cacheReadInputTokens',
      'cache_read_input_tokens',
      'prompt_cache_hit_tokens',
    ],
    [
      [row.prompt_tokens_details, ['cached_tokens', 'cachedTokens']],
      [row.promptTokensDetails, ['cachedTokens', 'cached_tokens']],
      [row.inputTokensDetails, ['cached_tokens', 'cachedTokens']],
    ],
  )
}

function readCacheWriteTokens(row: Record<string, unknown>): number | undefined {
  return readBucketCount(row, [
    'cacheWriteTokens',
    'cachedWriteTokens',
    'cacheCreationInputTokens',
    'cache_creation_input_tokens',
    'prompt_cache_write_tokens',
  ])
}

function readReasoningTokens(row: Record<string, unknown>): number | undefined {
  return readBucketCount(
    row,
    ['reasoningTokens', 'thoughtTokens', 'reasoning_tokens', 'completion_thinking_tokens'],
    [
      [row.outputTokensDetails, ['reasoningTokens', 'reasoning_tokens', 'thoughtTokens', 'thinkingTokens']],
      [row.output_tokens_details, ['reasoning_tokens', 'reasoningTokens', 'thoughtTokens', 'thinkingTokens']],
      [row.completion_tokens_details, ['reasoning_tokens', 'reasoningTokens']],
    ],
  )
}

/**
 * Normalize an ACP `PromptResponse.usage` (or CodeBuddy `_meta.usage`) payload
 * into a DSH-compatible disjoint `AcpTurnUsage`, or `undefined` when absent/invalid.
 */
export function normalizePromptUsage(raw: unknown): AcpTurnUsage | undefined {
  if (!isRecord(raw)) return undefined
  const inputField = readRequiredField(raw, ['inputTokens', 'input_tokens', 'prompt_tokens'])
  const outputField = readRequiredField(raw, ['outputTokens', 'output_tokens', 'completion_tokens'])
  if (!inputField.valid || !outputField.valid) return undefined
  if (inputField.value === undefined && outputField.value === undefined) return undefined

  let inputTokens = inputField.value ?? 0
  const outputTokens = outputField.value ?? 0
  const rawTotal = readBucketCount(raw, ['totalTokens', 'total_tokens'])
  const cacheReadTokens = readCacheReadTokens(raw)
  const cacheWriteTokens = readCacheWriteTokens(raw)
  const rawReasoning = readReasoningTokens(raw)

  const cacheSum = (cacheReadTokens ?? 0) + (cacheWriteTokens ?? 0)
  if (rawTotal !== undefined && cacheSum > 0 && inputTokens + outputTokens === rawTotal && inputTokens >= cacheSum) {
    inputTokens -= cacheSum
  }

  const reasoningTokens = rawReasoning === undefined ? undefined : Math.min(rawReasoning, outputTokens)
  const knownPrompt = inputTokens + (cacheReadTokens ?? 0) + (cacheWriteTokens ?? 0)
  const derivedTotal = knownPrompt + outputTokens
  let totalTokens: number
  if (rawTotal !== undefined && Number.isSafeInteger(derivedTotal)) {
    const exactPrompt = rawTotal - outputTokens
    const bothCache = cacheReadTokens !== undefined && cacheWriteTokens !== undefined
    totalTokens = exactPrompt >= knownPrompt && (!bothCache || exactPrompt === knownPrompt)
      ? rawTotal
      : derivedTotal
  } else {
    if (!Number.isSafeInteger(derivedTotal)) return undefined
    totalTokens = derivedTotal
  }

  return {
    inputTokens,
    outputTokens,
    totalTokens,
    ...(cacheReadTokens === undefined ? {} : { cacheReadTokens }),
    ...(cacheWriteTokens === undefined ? {} : { cacheWriteTokens }),
    ...(reasoningTokens === undefined ? {} : { reasoningTokens }),
  }
}

/**
 * Extract per-message token usage from a CodeBuddy `usage_update` frame,
 * excluding background team-member ticks (`used === 0 && size === 0` or
 * `codebuddy.ai/parentToolCallId`).
 */
export function extractCodebuddyUsage(
  update: Record<string, unknown>,
): { messageId?: string; usage: AcpTurnUsage } | undefined {
  if (update.sessionUpdate !== undefined && update.sessionUpdate !== 'usage_update') return undefined
  if (update.used === 0 && update.size === 0) return undefined
  if (!isRecord(update._meta)) return undefined
  const meta = update._meta
  const parentToolCallId = meta['codebuddy.ai/parentToolCallId']
  if (parentToolCallId !== undefined && parentToolCallId !== null && parentToolCallId !== '') return undefined
  const usage = normalizePromptUsage(meta.usage)
  if (usage === undefined) return undefined
  const rawMsgId = meta['codebuddy.ai/messageId']
  const messageId = typeof rawMsgId === 'string' && rawMsgId !== '' ? rawMsgId : undefined
  return {
    ...(messageId === undefined ? {} : { messageId }),
    usage,
  }
}
