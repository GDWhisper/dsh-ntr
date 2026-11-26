import { describe, expect, it } from 'vitest'
import { BURST_GAP_MS, CJK_CHARS_PER_TOKEN, OUTPUT_CHARS_PER_TOKEN, TurnTpsTracker, estimateProseTokens } from '../src/tps.ts'

const chunk = (length: number) => 'x'.repeat(length)

describe('TurnTpsTracker', () => {
  it('anchors the first chunk without crediting untimed tokens and accumulates subsequent chunks within the burst window', () => {
    const tracker = new TurnTpsTracker()
    tracker.onProse(chunk(100), 0)
    expect(tracker.snapshot()).toEqual({ outputTokens: 0, burstMs: 0 })
    tracker.onProse(chunk(100), 200)
    tracker.onProse(chunk(100), 400)
    expect(tracker.snapshot()).toEqual({ outputTokens: 50, burstMs: 400 })
  })

  it('counts a gap of exactly gapMs but re-anchors without crediting tokens past gapMs', () => {
    const edge = new TurnTpsTracker()
    edge.onProse(chunk(100), 0)
    edge.onProse(chunk(100), BURST_GAP_MS)
    expect(edge.snapshot()).toEqual({ outputTokens: 25, burstMs: BURST_GAP_MS })

    const beyond = new TurnTpsTracker()
    beyond.onProse(chunk(400), 0)
    beyond.onProse(chunk(400), BURST_GAP_MS + 1)
    expect(beyond.snapshot()).toEqual({ outputTokens: 0, burstMs: 0 })
    beyond.onProse(chunk(100), BURST_GAP_MS + 101)
    expect(beyond.snapshot()).toEqual({ outputTokens: 25, burstMs: 100 })
  })

  it('re-anchors at the first prose after a break without crediting untimed tokens', () => {
    const tracker = new TurnTpsTracker()
    tracker.onProse(chunk(100), 0)
    tracker.onProse(chunk(100), 200)
    tracker.onBreak()
    tracker.onProse(chunk(400), 250)
    expect(tracker.snapshot()).toEqual({ outputTokens: 25, burstMs: 200 })
    tracker.onProse(chunk(100), 450)
    expect(tracker.snapshot()).toEqual({ outputTokens: 50, burstMs: 400 })
  })

  it('reports a single chunk as zero tokens and zero milliseconds', () => {
    const tracker = new TurnTpsTracker()
    tracker.onProse('hello world', 12345)
    expect(tracker.snapshot()).toEqual({ outputTokens: 0, burstMs: 0 })
  })

  it('ignores empty strings and non-monotonic timestamps', () => {
    const tracker = new TurnTpsTracker()
    tracker.onProse('', 0)
    tracker.onProse(chunk(4), 500)
    tracker.onProse('', 1000)
    expect(tracker.snapshot()).toEqual({ outputTokens: 0, burstMs: 0 })
    tracker.onProse(chunk(4), 1500)
    expect(tracker.snapshot()).toEqual({ outputTokens: 1, burstMs: 1000 })
    // Out-of-order earlier timestamp re-anchors without subtracting burstMs or adding tokens.
    tracker.onProse(chunk(40), 1400)
    expect(tracker.snapshot()).toEqual({ outputTokens: 1, burstMs: 1000 })
  })

  it('weights CJK code units denser than ASCII and measures UTF-16 code units', () => {
    const emoji = '🙂🙂🙂🙂'
    expect(emoji.length).toBe(8)
    const tracker = new TurnTpsTracker()
    tracker.onProse('a', 0)
    tracker.onProse(emoji, 100)
    expect(tracker.snapshot()).toEqual({
      outputTokens: Math.round(emoji.length / OUTPUT_CHARS_PER_TOKEN),
      burstMs: 100,
    })

    // 300 CJK characters -> 300 / 1.5 = 200 tokens, plus 40 ASCII -> 10 tokens.
    const cjk = '测'.repeat(300)
    tracker.onProse(`${cjk}${'x'.repeat(40)}`, 300)
    expect(tracker.snapshot()).toEqual({
      outputTokens: 2 + Math.round(300 / CJK_CHARS_PER_TOKEN + 40 / OUTPUT_CHARS_PER_TOKEN),
      burstMs: 300,
    })
    expect(estimateProseTokens(`${cjk}${'x'.repeat(40)}`)).toBe(210)

    // Tiny mixed chunks accumulate raw CJK/ASCII counts without per-chunk rounding drift.
    const streamed = new TurnTpsTracker()
    streamed.onProse('anchor', 0)
    for (let i = 1; i <= 6; i += 1) {
      streamed.onProse('字ab', i * 100)
    }
    // 6 CJK (6 / 1.5 = 4) + 12 ASCII (12 / 4 = 3) = 7 tokens across 600ms.
    expect(streamed.snapshot()).toEqual({ outputTokens: 7, burstMs: 600 })
    expect(estimateProseTokens('字ab'.repeat(6))).toBe(7)
  })

  it('honors a custom gap window', () => {
    const tracker = new TurnTpsTracker(500)
    tracker.onProse(chunk(4), 0)
    tracker.onProse(chunk(4), 500)
    expect(tracker.snapshot()).toEqual({ outputTokens: 1, burstMs: 500 })
    tracker.onProse(chunk(40), 1001)
    expect(tracker.snapshot()).toEqual({ outputTokens: 1, burstMs: 500 })
  })

  it('takes a pure snapshot', () => {
    const tracker = new TurnTpsTracker()
    tracker.onProse(chunk(8), 0)
    const first = tracker.snapshot()
    const second = tracker.snapshot()
    expect(second).toEqual(first)
    expect(second).not.toBe(first)
    tracker.onProse(chunk(8), 100)
    expect(tracker.snapshot()).toEqual({ outputTokens: 2, burstMs: 100 })
  })
})
