import { describe, expect, it } from 'vitest'
import { mergeUsageSample } from '../src/usage.ts'
import { usageFromUpdate } from '../src/client/store.ts'
import { isPersistedUsage } from '../src/bridge/shape.ts'

/**
 * The CodeBuddy shape this guard exists for: while a background subagent (a
 * "team member") runs, CodeBuddy publishes its credit as a `usage_update` on the
 * LEADER session with `used: 0, size: 0` and a cost. Measured on the wire:
 * `AcpUsagePublisher.publishTeamMemberCredit` in codebuddy-code.
 */
const teamMemberTick = {
  sessionUpdate: 'usage_update',
  used: 0,
  size: 0,
  cost: { amount: 0.09, currency: '' },
  _meta: { 'codebuddy.ai/requestId': 'req-worker' },
}

describe('mergeUsageSample', () => {
  it('accepts a zero used count with a real window (a legitimate 0% reading)', () => {
    expect(mergeUsageSample(undefined, { used: 0, size: 1_000 })).toEqual({ used: 0, size: 1_000 })
  })

  it('replaces the reading with a usable sample and keeps its cost', () => {
    expect(mergeUsageSample({ used: 5, size: 1_000 }, { used: 7, size: 1_000, cost: { amount: 0.02, currency: 'USD' } }))
      .toEqual({ used: 7, size: 1_000, cost: { amount: 0.02, currency: 'USD' } })
  })

  it('clears an old cost when a usable sample carries none (the frame is the whole reading)', () => {
    expect(mergeUsageSample({ used: 5, size: 1_000, cost: { amount: 0.02, currency: 'USD' } }, { used: 9, size: 1_000 }))
      .toEqual({ used: 9, size: 1_000 })
  })

  it('keeps the last good reading when the team-member tick arrives, and still records the cost', () => {
    expect(mergeUsageSample({ used: 41_428, size: 192_000 }, teamMemberTick))
      .toEqual({ used: 41_428, size: 192_000, cost: { amount: 0.09, currency: '' } })
  })

  it('returns the previous reading by identity when the tick carries no cost', () => {
    const previous = { used: 41_428, size: 192_000 }
    expect(mergeUsageSample(previous, { used: 0, size: 0 })).toBe(previous)
  })

  it('invents no reading when the session never had one', () => {
    expect(mergeUsageSample(undefined, teamMemberTick)).toBeUndefined()
  })

  it.each([
    ['string fields', { used: '5', size: '1000' }],
    ['NaN', { used: Number.NaN, size: 1_000 }],
    ['infinite size', { used: 5, size: Number.POSITIVE_INFINITY }],
    ['negative used', { used: -1, size: 1_000 }],
    ['zero size', { used: 5, size: 0 }],
    ['negative size', { used: 5, size: -1 }],
    ['missing fields', {}],
  ])('keeps the last good reading for a %s sample', (_label, sample) => {
    expect(mergeUsageSample({ used: 5, size: 1_000 }, sample)).toEqual({ used: 5, size: 1_000 })
  })

  it('ignores a malformed cost instead of writing it into the reading', () => {
    expect(mergeUsageSample(undefined, { used: 5, size: 1_000, cost: { amount: '0.09', currency: '' } }))
      .toEqual({ used: 5, size: 1_000 })
    expect(mergeUsageSample({ used: 5, size: 1_000 }, { used: 0, size: 0, cost: { amount: Number.NaN, currency: 'USD' } }))
      .toEqual({ used: 5, size: 1_000 })
  })
})

describe('usageFromUpdate (browser fold)', () => {
  it('accepts a zero used count with a real window (a legitimate 0% reading)', () => {
    expect(usageFromUpdate({ used: 0, size: 1_000 })).toEqual({ used: 0, size: 1_000 })
  })

  it('accepts a usable sample and drops the cost whose currency is empty', () => {
    expect(usageFromUpdate({ sessionUpdate: 'usage_update', used: 5, size: 50, cost: { amount: 1, currency: 'USD' } }))
      .toEqual({ used: 5, size: 50, cost: { amount: 1, currency: 'USD' } })
    expect(usageFromUpdate({ used: 5, size: 50, cost: { amount: 1, currency: '' } }))
      .toEqual({ used: 5, size: 50 })
  })

  it('ignores the team-member tick so the row keeps its last reading', () => {
    expect(usageFromUpdate(teamMemberTick)).toBeUndefined()
  })

  it.each([
    ['zero size', { used: 5, size: 0 }],
    ['negative size', { used: 5, size: -10 }],
    ['negative used', { used: -5, size: 100 }],
    ['strings', { used: '5', size: '100' }],
    ['NaN', { used: Number.NaN, size: 100 }],
  ])('ignores a %s frame', (_label, update) => {
    expect(usageFromUpdate(update)).toBeUndefined()
  })
})

describe('isPersistedUsage', () => {
  it('accepts a real reading, cost included', () => {
    expect(isPersistedUsage({ used: 5, size: 1_000 })).toBe(true)
    expect(isPersistedUsage({ used: 0, size: 1_000 })).toBe(true)
    expect(isPersistedUsage({ used: 5, size: 1_000, cost: { amount: 0.09, currency: '' } })).toBe(true)
  })

  it.each([
    ['a stored team-member tick', { used: 0, size: 0, cost: { amount: 0.09, currency: '' } }],
    ['zero size', { used: 5, size: 0 }],
    ['negative size', { used: 5, size: -1 }],
    ['negative used', { used: -5, size: 100 }],
    ['non-numbers', { used: '5', size: 100 }],
    ['a non-object', 'usage'],
    ['null', null],
  ])('rejects %s', (_label, value) => {
    expect(isPersistedUsage(value)).toBe(false)
  })
})
