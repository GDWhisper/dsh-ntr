import { extractCodebuddyUsage, type AcpTurnUsage } from '../impl.ts'
import { OUTPUT_CHARS_PER_TOKEN } from '../tps.ts'

interface UsageTotals {
  inputTokens: number
  outputTokens: number
  totalTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  reasoningTokens: number
}

function emptyTotals(): UsageTotals {
  return {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
  }
}

function addUsage(acc: UsageTotals, usage: AcpTurnUsage): void {
  acc.inputTokens += usage.inputTokens
  acc.outputTokens += usage.outputTokens
  acc.totalTokens += usage.totalTokens ?? (
    usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0) + usage.outputTokens
  )
  acc.cacheReadTokens += usage.cacheReadTokens ?? 0
  acc.cacheWriteTokens += usage.cacheWriteTokens ?? 0
  acc.reasoningTokens += usage.reasoningTokens ?? 0
}

/**
 * Per-turn usage ledger shared across every segmented driver step of one turn.
 *
 * Bridges two ACP reporting models onto DSH's per-step `StreamChunk` `{ type: 'usage' }`:
 * 1. Streaming per-message usage (`usage_update._meta.usage` with optional
 *    `codebuddy.ai/messageId`): updates for the same `messageId` replace rather
 *    than add, and each segment flushes only the unflushed delta.
 * 2. Turn-end `PromptResponse.usage` (e.g. OpenCode): recorded only when no
 *    per-message real usage was observed this turn (preventing double-counting),
 *    and flushed on the closing segment (including card-ending turns whose final
 *    continuation step closes after `settle`).
 *
 * While no real unflushed usage is available (intermediate tool segments on
 * turn-end agents, or legacy agents without usage), `takeSegmentUsage` emits the
 * 4-chars/token output estimate (`inputTokens: 0`) and deducts that emitted
 * fallback from the real usage when it eventually arrives so turn totals match.
 */
export class TurnUsageLedger {
  private readonly byMessage = new Map<string, AcpTurnUsage>()
  private readonly seenSeqs = new Set<number>()
  private anonymousUsage: AcpTurnUsage | undefined
  private promptUsage: AcpTurnUsage | undefined
  private promptUsageFlushed = false

  private readonly flushed = emptyTotals()
  private emittedFallbackOutput = 0

  private sawCacheReadSinceFlush = false
  private sawCacheWriteSinceFlush = false
  private sawReasoningSinceFlush = false

  observeUsageUpdate(update: Record<string, unknown>, seq?: number): void {
    if (seq !== undefined) {
      if (this.seenSeqs.has(seq)) return
      this.seenSeqs.add(seq)
    }
    const extracted = extractCodebuddyUsage(update)
    if (extracted === undefined) return
    if (extracted.messageId !== undefined) {
      this.byMessage.set(extracted.messageId, extracted.usage)
    } else {
      this.anonymousUsage = extracted.usage
    }
    if (extracted.usage.cacheReadTokens !== undefined) this.sawCacheReadSinceFlush = true
    if (extracted.usage.cacheWriteTokens !== undefined) this.sawCacheWriteSinceFlush = true
    if (extracted.usage.reasoningTokens !== undefined) this.sawReasoningSinceFlush = true
  }

  recordPromptUsage(usage: AcpTurnUsage | undefined): void {
    if (usage === undefined) return
    if (this.byMessage.size > 0 || this.anonymousUsage !== undefined) return
    this.promptUsage = usage
    this.promptUsageFlushed = false
    if (usage.cacheReadTokens !== undefined) this.sawCacheReadSinceFlush = true
    if (usage.cacheWriteTokens !== undefined) this.sawCacheWriteSinceFlush = true
    if (usage.reasoningTokens !== undefined) this.sawReasoningSinceFlush = true
  }

  takeSegmentUsage(fallbackOutputChars: number): AcpTurnUsage | undefined {
    const real = this.takeRealDelta()
    if (real !== undefined) {
      const deduction = Math.min(real.outputTokens, this.emittedFallbackOutput)
      this.emittedFallbackOutput -= deduction
      if (deduction === 0) return real
      const outputTokens = real.outputTokens - deduction
      const totalTokens = real.totalTokens === undefined ? undefined : Math.max(0, real.totalTokens - deduction)
      const reasoningTokens = real.reasoningTokens === undefined ? undefined : Math.min(real.reasoningTokens, outputTokens)
      return {
        ...real,
        outputTokens,
        ...(totalTokens === undefined ? {} : { totalTokens }),
        ...(reasoningTokens === undefined ? {} : { reasoningTokens }),
      }
    }
    const est = Math.round(fallbackOutputChars / OUTPUT_CHARS_PER_TOKEN)
    if (est <= 0) return undefined
    this.emittedFallbackOutput += est
    // Zero input keeps the host's cache-hit pill hidden instead of faking 0%.
    return { inputTokens: 0, outputTokens: est }
  }

  private takeRealDelta(): AcpTurnUsage | undefined {
    if (this.byMessage.size === 0 && this.anonymousUsage === undefined) {
      if (this.promptUsage === undefined || this.promptUsageFlushed) return undefined
      this.promptUsageFlushed = true
      this.sawCacheReadSinceFlush = false
      this.sawCacheWriteSinceFlush = false
      this.sawReasoningSinceFlush = false
      return this.promptUsage
    }

    const observed = emptyTotals()
    for (const usage of this.byMessage.values()) addUsage(observed, usage)
    if (this.anonymousUsage !== undefined) addUsage(observed, this.anonymousUsage)

    const deltaInput = Math.max(0, observed.inputTokens - this.flushed.inputTokens)
    const deltaOutput = Math.max(0, observed.outputTokens - this.flushed.outputTokens)
    const deltaCacheRead = Math.max(0, observed.cacheReadTokens - this.flushed.cacheReadTokens)
    const deltaCacheWrite = Math.max(0, observed.cacheWriteTokens - this.flushed.cacheWriteTokens)
    const deltaReasoning = Math.max(0, observed.reasoningTokens - this.flushed.reasoningTokens)
    const rawDeltaTotal = Math.max(0, observed.totalTokens - this.flushed.totalTokens)

    const includeCacheRead = deltaCacheRead > 0 || this.sawCacheReadSinceFlush
    const includeCacheWrite = deltaCacheWrite > 0 || this.sawCacheWriteSinceFlush
    const includeReasoning = deltaReasoning > 0 || this.sawReasoningSinceFlush

    const hasDelta = deltaInput > 0
      || deltaOutput > 0
      || rawDeltaTotal > 0
      || deltaCacheRead > 0
      || deltaCacheWrite > 0
    if (!hasDelta) return undefined

    const knownPromptDelta = deltaInput + (includeCacheRead ? deltaCacheRead : 0) + (includeCacheWrite ? deltaCacheWrite : 0)
    const derivedTotal = knownPromptDelta + deltaOutput
    const bothCache = includeCacheRead && includeCacheWrite
    const totalTokens = rawDeltaTotal >= derivedTotal && (!bothCache || rawDeltaTotal === derivedTotal)
      ? rawDeltaTotal
      : derivedTotal

    this.flushed.inputTokens += deltaInput
    this.flushed.outputTokens += deltaOutput
    this.flushed.totalTokens += rawDeltaTotal
    this.flushed.cacheReadTokens += deltaCacheRead
    this.flushed.cacheWriteTokens += deltaCacheWrite
    this.flushed.reasoningTokens += deltaReasoning
    this.sawCacheReadSinceFlush = false
    this.sawCacheWriteSinceFlush = false
    this.sawReasoningSinceFlush = false

    const reasoningTokens = includeReasoning ? Math.min(deltaReasoning, deltaOutput) : undefined
    return {
      inputTokens: deltaInput,
      outputTokens: deltaOutput,
      totalTokens,
      ...(includeCacheRead ? { cacheReadTokens: deltaCacheRead } : {}),
      ...(includeCacheWrite ? { cacheWriteTokens: deltaCacheWrite } : {}),
      ...(reasoningTokens === undefined ? {} : { reasoningTokens }),
    }
  }
}
