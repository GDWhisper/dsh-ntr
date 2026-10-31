import { describe, expect, it } from 'vitest'
import { BURST_GAP_MS, OUTPUT_CHARS_PER_TOKEN, TurnTpsTracker } from '../src/tps.ts'

const chunk = (length: number) => 'x'.repeat(length)

describe('TurnTpsTracker', () => {
  it('accumulates prose chunks within the burst window', () => {
    const tracker = new TurnTpsTracker()
    tracker.onProse(chunk(100), 0)
    tracker.onProse(chunk(100), 200)
    tracker.onProse(chunk(100), 400)
    expect(tracker.snapshot()).toEqual({ outputTokens: 75, burstMs: 400 })
  })

  it('counts a gap of exactly gapMs but not one millisecond more', () => {
    const edge = new TurnTpsTracker()
    edge.onProse(chunk(100), 0)
    edge.onProse(chunk(100), BURST_GAP_MS)
    expect(edge.snapshot().burstMs).toBe(BURST_GAP_MS)

    const beyond = new TurnTpsTracker()
    beyond.onProse(chunk(100), 0)
    beyond.onProse(chunk(100), BURST_GAP_MS + 1)
    expect(beyond.snapshot().burstMs).toBe(0)
  })

  it('starts a new burst at the first prose after a break', () => {
    const tracker = new TurnTpsTracker()
    tracker.onProse(chunk(100), 0)
    tracker.onProse(chunk(100), 200)
    tracker.onBreak()
    tracker.onProse(chunk(100), 250)
    expect(tracker.snapshot()).toEqual({ outputTokens: 75, burstMs: 200 })
    tracker.onProse(chunk(100), 450)
    expect(tracker.snapshot().burstMs).toBe(400)
  })

  it('reports a single chunk as one burst of zero milliseconds', () => {
    const tracker = new TurnTpsTracker()
    tracker.onProse('hello world', 12345)
    const { outputTokens, burstMs } = tracker.snapshot()
    expect(outputTokens).toBeGreaterThan(0)
    expect(burstMs).toBe(0)
  })

  it('ignores empty strings entirely', () => {
    const tracker = new TurnTpsTracker()
    tracker.onProse('', 0)
    tracker.onProse(chunk(4), 500)
    tracker.onProse('', 1000)
    expect(tracker.snapshot()).toEqual({ outputTokens: 1, burstMs: 0 })
    tracker.onProse(chunk(4), 1500)
    expect(tracker.snapshot()).toEqual({ outputTokens: 2, burstMs: 1000 })
  })

  it('measures UTF-16 code units, not bytes', () => {
    const text = '🙂🙂🙂🙂'
    expect(text.length).toBe(8)
    const tracker = new TurnTpsTracker()
    tracker.onProse(text, 0)
    expect(tracker.snapshot().outputTokens).toBe(2)
    expect(tracker.snapshot().outputTokens).toBe(Math.round(text.length / OUTPUT_CHARS_PER_TOKEN))
  })

  it('honors a custom gap window', () => {
    const tracker = new TurnTpsTracker(500)
    tracker.onProse(chunk(1), 0)
    tracker.onProse(chunk(1), 500)
    expect(tracker.snapshot().burstMs).toBe(500)
    tracker.onProse(chunk(1), 1001)
    expect(tracker.snapshot().burstMs).toBe(500)
  })

  it('takes a pure snapshot', () => {
    const tracker = new TurnTpsTracker()
    tracker.onProse(chunk(8), 0)
    const first = tracker.snapshot()
    const second = tracker.snapshot()
    expect(second).toEqual(first)
    expect(second).not.toBe(first)
    tracker.onProse(chunk(8), 100)
    expect(tracker.snapshot()).toEqual({ outputTokens: 4, burstMs: 100 })
  })
})
