import { describe, expect, it } from 'vitest'
import { extractCodebuddyUsage, normalizePromptUsage } from '../../src/impl.ts'
import { TurnUsageLedger } from '../../src/bridge/turn-usage-ledger.ts'

describe('normalizePromptUsage', () => {
  it('normalizes standard OpenCode ACP PromptResponse.usage with disjoint counts', () => {
    expect(normalizePromptUsage({
      totalTokens: 1350,
      inputTokens: 1000,
      outputTokens: 50,
      thoughtTokens: 12,
      cachedReadTokens: 200,
      cachedWriteTokens: 100,
    })).toEqual({
      inputTokens: 1000,
      outputTokens: 50,
      totalTokens: 1350,
      cacheReadTokens: 200,
      cacheWriteTokens: 100,
      reasoningTokens: 12,
    })
  })

  it('unfolds cache from inputTokens when upstream folded cache into inputTokens', () => {
    expect(normalizePromptUsage({
      totalTokens: 1050,
      inputTokens: 1000,
      outputTokens: 50,
      cachedReadTokens: 400,
      cachedWriteTokens: 100,
    })).toEqual({
      inputTokens: 500,
      outputTokens: 50,
      totalTokens: 1050,
      cacheReadTokens: 400,
      cacheWriteTokens: 100,
    })
  })

  it('derives totalTokens when omitted without inventing fake 0 cache fields', () => {
    const normalized = normalizePromptUsage({
      input_tokens: 300,
      output_tokens: 45,
      cache_read_input_tokens: 600,
    })
    expect(normalized).toEqual({
      inputTokens: 300,
      outputTokens: 45,
      totalTokens: 945,
      cacheReadTokens: 600,
    })
    expect(normalized).not.toHaveProperty('cacheWriteTokens')
  })

  it('clamps reasoningTokens <= outputTokens and repairs inconsistent totalTokens', () => {
    expect(normalizePromptUsage({
      inputTokens: 100,
      outputTokens: 20,
      totalTokens: 110,
      cachedReadTokens: 40,
      cachedWriteTokens: 10,
      thoughtTokens: 35,
    })).toEqual({
      inputTokens: 100,
      outputTokens: 20,
      totalTokens: 170,
      cacheReadTokens: 40,
      cacheWriteTokens: 10,
      reasoningTokens: 20,
    })
  })

  it('rejects non-objects, missing counts, and negative numbers', () => {
    expect(normalizePromptUsage(null)).toBeUndefined()
    expect(normalizePromptUsage({})).toBeUndefined()
    expect(normalizePromptUsage({ totalTokens: 100 })).toBeUndefined()
    expect(normalizePromptUsage({ inputTokens: -1, outputTokens: 10 })).toBeUndefined()
    expect(normalizePromptUsage({ inputTokens: 10, outputTokens: Number.NaN })).toBeUndefined()
  })
})

describe('extractCodebuddyUsage', () => {
  it('excludes team-member ticks (used === 0 && size === 0) and parentToolCallId ticks', () => {
    expect(extractCodebuddyUsage({
      sessionUpdate: 'usage_update',
      used: 0,
      size: 0,
      cost: { amount: 0.01, currency: 'USD' },
      _meta: { usage: { input_tokens: 500, output_tokens: 20 } },
    })).toBeUndefined()

    expect(extractCodebuddyUsage({
      sessionUpdate: 'usage_update',
      used: 120,
      size: 1000,
      _meta: {
        'codebuddy.ai/parentToolCallId': 'call_worker_1',
        'codebuddy.ai/messageId': 'msg_worker',
        usage: { input_tokens: 500, output_tokens: 20 },
      },
    })).toBeUndefined()

    expect(extractCodebuddyUsage({
      sessionUpdate: 'usage_update',
      used: 120,
      size: 1000,
    })).toBeUndefined()
  })

  it('supports OpenAI, Anthropic, and AI SDK detail spellings + messageId', () => {
    expect(extractCodebuddyUsage({
      sessionUpdate: 'usage_update',
      used: 1200,
      size: 200000,
      _meta: {
        'codebuddy.ai/messageId': 'msg_oai',
        usage: {
          prompt_tokens: 1000,
          completion_tokens: 80,
          total_tokens: 1080,
          prompt_tokens_details: { cached_tokens: 600 },
          outputTokensDetails: { reasoningTokens: 25 },
        },
      },
    })).toEqual({
      messageId: 'msg_oai',
      usage: {
        inputTokens: 400,
        outputTokens: 80,
        totalTokens: 1080,
        cacheReadTokens: 600,
        reasoningTokens: 25,
      },
    })

    expect(extractCodebuddyUsage({
      sessionUpdate: 'usage_update',
      used: 900,
      size: 200000,
      _meta: {
        'codebuddy.ai/messageId': 'msg_aisdk',
        usage: {
          inputTokens: 300,
          outputTokens: 40,
          inputTokensDetails: [{ cached_tokens: 120 }, { cached_tokens: 80 }],
          prompt_cache_write_tokens: 50,
          reasoningTokens: 15,
        },
      },
    })).toEqual({
      messageId: 'msg_aisdk',
      usage: {
        inputTokens: 300,
        outputTokens: 40,
        totalTokens: 590,
        cacheReadTokens: 200,
        cacheWriteTokens: 50,
        reasoningTokens: 15,
      },
    })
  })
})

describe('TurnUsageLedger', () => {
  it('replaces per messageId, computes deltas across segments, and ignores PromptResponse after per-message usage', () => {
    const ledger = new TurnUsageLedger()
    ledger.observeUsageUpdate({
      sessionUpdate: 'usage_update',
      used: 500,
      size: 10000,
      _meta: {
        'codebuddy.ai/messageId': 'm1',
        usage: { input_tokens: 100, cache_read_input_tokens: 300, output_tokens: 10 },
      },
    })
    ledger.observeUsageUpdate({
      sessionUpdate: 'usage_update',
      used: 520,
      size: 10000,
      _meta: {
        'codebuddy.ai/messageId': 'm1',
        usage: { input_tokens: 100, cache_read_input_tokens: 300, output_tokens: 30 },
      },
    })

    expect(ledger.takeSegmentUsage(100)).toEqual({
      inputTokens: 100,
      outputTokens: 30,
      cacheReadTokens: 300,
      totalTokens: 430,
    })

    ledger.observeUsageUpdate({
      sessionUpdate: 'usage_update',
      used: 800,
      size: 10000,
      _meta: {
        'codebuddy.ai/messageId': 'm2',
        usage: { input_tokens: 200, cache_read_input_tokens: 400, cache_creation_input_tokens: 50, output_tokens: 25 },
      },
    })
    ledger.recordPromptUsage({ inputTokens: 9999, outputTokens: 9999, totalTokens: 19998 })

    expect(ledger.takeSegmentUsage(40)).toEqual({
      inputTokens: 200,
      outputTokens: 25,
      cacheReadTokens: 400,
      cacheWriteTokens: 50,
      totalTokens: 675,
    })
  })

  it('deducts earlier fallback outputTokens when turn-end PromptResponse.usage arrives', () => {
    const ledger = new TurnUsageLedger()
    expect(ledger.takeSegmentUsage(40)).toEqual({ inputTokens: 0, outputTokens: 10 })
    expect(ledger.takeSegmentUsage(20)).toEqual({ inputTokens: 0, outputTokens: 5 })

    ledger.recordPromptUsage({
      inputTokens: 1000,
      outputTokens: 50,
      totalTokens: 1250,
      cacheReadTokens: 200,
      reasoningTokens: 40,
    })

    expect(ledger.takeSegmentUsage(140)).toEqual({
      inputTokens: 1000,
      outputTokens: 35,
      totalTokens: 1235,
      cacheReadTokens: 200,
      reasoningTokens: 35,
    })
    expect(ledger.takeSegmentUsage(0)).toBeUndefined()
  })

  it('keeps totalTokens consistent when fallback estimate exceeds real outputTokens', () => {
    const ledger = new TurnUsageLedger()
    expect(ledger.takeSegmentUsage(80)).toEqual({ inputTokens: 0, outputTokens: 20 })

    ledger.recordPromptUsage({
      inputTokens: 500,
      outputTokens: 10,
      totalTokens: 510,
      reasoningTokens: 8,
    })

    expect(ledger.takeSegmentUsage(0)).toEqual({
      inputTokens: 500,
      outputTokens: 0,
      totalTokens: 500,
      reasoningTokens: 0,
    })
  })
})
