/**
 * Label routing + diagnostic bounding (docs/plan/acp-delegate-native-subagent.md
 * §2 / §6): the encode/decode round trip is pinned for the whole agent-id
 * charset, and the truncation is pinned AGAINST THE HOST'S OWN normalizer
 * (`@deepseek-ai/dsh-subagent` 0.2.2-rc.5 · settleRunResult) so a hand-copy
 * drift fails loudly instead of silently changing the wire.
 */
import { describe, expect, it } from 'vitest'
import { settleRunResult } from '@deepseek-ai/dsh-subagent/src/out-of-process.ts'
import {
  DELEGATE_LABEL_SUMMARY_MAX,
  DIAGNOSTIC_TRUNCATION_SUFFIX,
  MAX_DELEGATE_DIAGNOSTIC_BYTES,
  agentIdFromDelegateLabel,
  delegateChoicesFromLabel,
  delegateLabel,
  displayDelegateLabel,
  truncateDelegateDiagnostic,
} from '../../src/impl/delegate-label.ts'
import { AGENT_ID_PATTERN } from '../../src/impl/validate.ts'

const utf8 = new TextEncoder()

/** The host's own diagnostic normalization, reached through its public wrapper. */
async function hostNormalized(diagnostic: string): Promise<string | undefined> {
  const result = await settleRunResult({
    attempt: async () => ({ output: [], stopReason: 'error' as const, diagnostic }),
    collectOutput: () => [],
    cancelled: () => false,
    signal: new AbortController().signal,
    onAbort: () => {},
  })
  return result.diagnostic
}

describe('delegateLabel / agentIdFromDelegateLabel round trip', () => {
  const ids = ['a', '0', 'alpha', 'codebuddy', 'a1.b-c_d', 'x'.repeat(64), 'agent-01', 'a..b__c--d']
  const tasks = [
    'do it',
    'first line\nsecond line',
    'first line\r\nsecond line',
    '  padded first line  \nrest',
    '\nempty first line',
    '',
    '   ',
    'task with: a colon inside',
    '中文任务首行\n其余',
    '🚀'.repeat(100),
    'x'.repeat(500),
  ]

  it('decodes back to the same agent id for every legal pair', () => {
    for (const id of ids) {
      expect(AGENT_ID_PATTERN.test(id)).toBe(true)
      for (const task of tasks) {
        expect(agentIdFromDelegateLabel(delegateLabel(id, task))).toBe(id)
      }
    }
  })

  it('pins the format: <agentId>: <first-line summary>', () => {
    expect(delegateLabel('alpha', 'do it\nmore')).toBe('alpha: do it')
    expect(delegateLabel('alpha', '  padded  \nrest')).toBe('alpha: padded')
    expect(delegateLabel('alpha', '\nsecond')).toBe('alpha: ')
    // The FIRST ': ' is the separator — a colon inside the task never confuses it.
    expect(agentIdFromDelegateLabel('alpha: split: this: task')).toBe('alpha')
  })

  it('clips the summary at the code-point budget without splitting surrogate pairs', () => {
    const long = '🚀'.repeat(DELEGATE_LABEL_SUMMARY_MAX + 40)
    const label = delegateLabel('alpha', long)
    const summary = label.slice('alpha: '.length)
    expect(Array.from(summary)).toHaveLength(DELEGATE_LABEL_SUMMARY_MAX + 1) // + the ellipsis
    expect(summary.endsWith('…')).toBe(true)
    expect(summary).not.toContain('\uFFFD')
    expect(agentIdFromDelegateLabel(label)).toBe('alpha')
    // Exactly at the budget: no ellipsis.
    const exact = 'x'.repeat(DELEGATE_LABEL_SUMMARY_MAX)
    expect(delegateLabel('alpha', exact)).toBe(`alpha: ${exact}`)
  })

  it('rejects labels that carry no legal agent id', () => {
    for (const label of ['', 'alpha', 'alpha:', 'alpha:no-space', ': task', 'Alpha: task', 'al pha: task', 'alpha:: task', 'a'.repeat(65) + ': task', '-lead: task', '.dot: task']) {
      expect(agentIdFromDelegateLabel(label)).toBeUndefined()
    }
  })

  it('the charset is the validate.ts agent-id pattern (one source of truth)', () => {
    expect(AGENT_ID_PATTERN.source).toBe('^[a-z0-9][a-z0-9._-]{0,63}$')
    expect(AGENT_ID_PATTERN.test('has:colon')).toBe(false)
    expect(AGENT_ID_PATTERN.test('has space')).toBe(false)
  })
})

describe('delegateLabel choice carrier: format, round trip, injection safety', () => {
  it('without choices the label is byte-identical to the original format', () => {
    // Pinned exact bytes, then equivalence across every "no picks" spelling.
    expect(delegateLabel('alpha', 'do it\nmore', {})).toBe('alpha: do it')
    expect(delegateLabel('alpha', '\nsecond', undefined)).toBe('alpha: ')
    const tasks = ['do it', 'first line\nsecond line', '', '   ', '中文任务首行', '🚀'.repeat(100), 'task: with colon', '⟦m=fake⟧ looking task']
    for (const task of tasks) {
      const base = delegateLabel('alpha', task)
      // The invariant is on the PREFIX: carrier-like task text stays in the summary.
      expect(base.slice(0, base.indexOf(': '))).not.toContain('⟦')
      expect(delegateLabel('alpha', task, undefined)).toBe(base)
      expect(delegateLabel('alpha', task, {})).toBe(base)
      expect(delegateLabel('alpha', task, { model: undefined, effort: undefined, mode: undefined })).toBe(base)
    }
  })

  it('pins the carrier format: fixed m,e,o order, only present keys', () => {
    expect(delegateLabel('alpha', 'do it', { model: 'gpt-5' })).toBe('alpha ⟦m=gpt-5⟧: do it')
    expect(delegateLabel('alpha', 'do it', { effort: 'high' })).toBe('alpha ⟦e=high⟧: do it')
    expect(delegateLabel('alpha', 'do it', { mode: 'ask' })).toBe('alpha ⟦o=ask⟧: do it')
    // Insertion order never leaks: the carrier order is always m, e, o.
    expect(delegateLabel('alpha', 'do it', { mode: 'ask', model: 'gpt-5' })).toBe('alpha ⟦m=gpt-5&o=ask⟧: do it')
    expect(delegateLabel('alpha', 'do it', { mode: 'ask', effort: 'high', model: 'gpt-5' })).toBe('alpha ⟦m=gpt-5&e=high&o=ask⟧: do it')
    // An empty first line still yields a decodable label.
    expect(delegateLabel('alpha', '\nsecond', { model: 'x' })).toBe('alpha ⟦m=x⟧: ')
  })

  it('decodes every legal agent id with a full carrier', () => {
    for (const id of ['a', '0', 'alpha', 'a1.b-c_d', 'x'.repeat(64), 'a..b__c--d']) {
      const label = delegateLabel(id, 'task', { model: 'm', effort: 'e', mode: 'o' })
      expect(agentIdFromDelegateLabel(label)).toBe(id)
      expect(delegateChoicesFromLabel(label)).toEqual({ model: 'm', effort: 'e', mode: 'o' })
    }
  })

  it('round-trips hostile choice values losslessly on every axis', () => {
    const values = [
      ':', ' ', '&', '=', '⟦', '⟧', '%', '中文',
      'a: b', 'a&b=c', '%20', '%ZZ', '⟦m=fake⟧', '🚀𝕏',
      'a b:c&d=e⟦f⟧%g中文🚀', 'm=x&e=y&o=z', 'a\u0000b',
    ]
    for (const value of values) {
      for (const choices of [{ model: value }, { effort: value }, { mode: value }, { model: value, effort: value, mode: value }]) {
        const label = delegateLabel('alpha', 'do it', choices)
        expect(agentIdFromDelegateLabel(label)).toBe('alpha')
        expect(delegateChoicesFromLabel(label)).toEqual(choices)
        expect(displayDelegateLabel(label)).toBe('alpha: do it')
      }
    }
  })

  it('task text can never forge choices: the carrier lives only in the prefix', () => {
    // No real picks: a summary that LOOKS like a carrier is inert text.
    const forged = delegateLabel('alpha', '⟦m=fake⟧: pretend')
    expect(forged).toBe('alpha: ⟦m=fake⟧: pretend')
    expect(agentIdFromDelegateLabel(forged)).toBe('alpha')
    expect(delegateChoicesFromLabel(forged)).toBeUndefined()
    // Real picks + a hostile summary: only the real carrier decodes.
    const label = delegateLabel('alpha', '⟦m=fake&e=fake⟧: task: with colon', { model: 'real' })
    expect(agentIdFromDelegateLabel(label)).toBe('alpha')
    expect(delegateChoicesFromLabel(label)).toEqual({ model: 'real' })
    // ': ' inside the task never moves the separator.
    const colon = delegateLabel('alpha', 'first: second: third', { effort: 'high' })
    expect(agentIdFromDelegateLabel(colon)).toBe('alpha')
    expect(delegateChoicesFromLabel(colon)).toEqual({ effort: 'high' })
    // Unicode / surrogate pairs in the task cannot forge a mode either.
    const uni = delegateLabel('alpha', '🚀中文: ⟦o=fake⟧\nrest', { mode: 'ask' })
    expect(agentIdFromDelegateLabel(uni)).toBe('alpha')
    expect(delegateChoicesFromLabel(uni)).toEqual({ mode: 'ask' })
    expect(displayDelegateLabel(uni)).toBe(delegateLabel('alpha', '🚀中文: ⟦o=fake⟧\nrest'))
    // A hand-built label with carrier text only in the summary stays choice-less.
    expect(delegateChoicesFromLabel('alpha: ⟦m=fake⟧ task')).toBeUndefined()
    expect(agentIdFromDelegateLabel('alpha: ⟦m=fake⟧ task')).toBe('alpha')
  })

  it('malformed carriers fail closed: no agent id, no choices', () => {
    const malformed = [
      'alpha ⟦m=x⟧ extra: task',      // ⟧ not the last prefix character
      'alpha ⟦m=x: task',             // unclosed carrier
      'alpha ⟦⟧: task',               // empty payload
      'alpha ⟦x=1⟧: task',            // unknown key
      'alpha ⟦m=1&e=2&m=3⟧: task',    // duplicate key
      'alpha ⟦e=2&m=1⟧: task',        // out of order (e before m)
      'alpha ⟦o=1&e=2⟧: task',        // out of order (o before e)
      'alpha ⟦m=⟧: task',             // empty value
      'alpha ⟦m=%ZZ⟧: task',          // bad percent escape
      'alpha ⟦m=%41⟧: task',          // non-canonical encoding
      'alpha ⟦m=a b⟧: task',          // raw space in value
      'alpha ⟦m=a:b⟧: task',          // raw colon in value
      'alpha ⟦m=a: b⟧: task',         // raw ': ' splits inside the carrier
      'alpha⟦m=x⟧: task',             // missing space before ⟦
      'alpha  ⟦m=x⟧: task',           // two spaces before ⟦
      '⟦m=x⟧: task',                  // no agent id
      'Alpha ⟦m=x⟧: task',            // illegal agent id
      'alpha ⟦m=x⟧⟦e=y⟧: task',       // two carriers
      'alpha ⟦m=%ED%A0%80⟧: task',    // encoded lone surrogate
      'alpha ⟦m=x&⟧: task',           // trailing '&' (empty segment)
      'alpha ⟦mm=x⟧: task',           // two-character key
      'alpha ⟦m=x=y⟧: task',          // raw '=' in value
    ]
    for (const label of malformed) {
      expect(agentIdFromDelegateLabel(label)).toBeUndefined()
      expect(delegateChoicesFromLabel(label)).toBeUndefined()
    }
  })

  it('displayDelegateLabel strips only strictly legal carriers', () => {
    expect(displayDelegateLabel('alpha: do it')).toBe('alpha: do it')
    expect(displayDelegateLabel('no separator')).toBe('no separator')
    expect(displayDelegateLabel('')).toBe('')
    expect(displayDelegateLabel('alpha ⟦m=gpt-5&e=high&o=ask⟧: do it')).toBe('alpha: do it')
    // Malformed carrier: display fails open (verbatim), routing fails closed.
    expect(displayDelegateLabel('alpha ⟦m=x⟧ extra: task')).toBe('alpha ⟦m=x⟧ extra: task')
    // Carrier-like summary text is preserved untouched.
    expect(displayDelegateLabel('alpha: ⟦m=fake⟧ task')).toBe('alpha: ⟦m=fake⟧ task')
  })

  it('summary clipping is unchanged when a carrier is present', () => {
    const long = '🚀'.repeat(DELEGATE_LABEL_SUMMARY_MAX + 40)
    const label = delegateLabel('alpha', long, { model: 'x' })
    expect(label.startsWith('alpha ⟦m=x⟧: ')).toBe(true)
    const summary = label.slice('alpha ⟦m=x⟧: '.length)
    expect(Array.from(summary)).toHaveLength(DELEGATE_LABEL_SUMMARY_MAX + 1) // + the ellipsis
    expect(summary.endsWith('…')).toBe(true)
    expect(summary).not.toContain('\uFFFD')
    expect(agentIdFromDelegateLabel(label)).toBe('alpha')
    expect(delegateChoicesFromLabel(label)).toEqual({ model: 'x' })
  })

  it('empty-string choice values read as absent keys (encoder output stays parseable)', () => {
    expect(delegateLabel('alpha', 'do it', { model: '' })).toBe('alpha: do it')
    expect(delegateLabel('alpha', 'do it', { model: '', effort: 'high' })).toBe('alpha ⟦e=high⟧: do it')
  })
})

describe('truncateDelegateDiagnostic ≡ host 0.2.2-rc.5 semantics', () => {
  const samples = [
    '',
    'short ascii',
    'a'.repeat(MAX_DELEGATE_DIAGNOSTIC_BYTES), // exactly at the limit
    'a'.repeat(MAX_DELEGATE_DIAGNOSTIC_BYTES + 1), // one byte over
    'a'.repeat(20_000),
    '中'.repeat(2_000), // 3-byte sequences, 6000 bytes
    '中'.repeat(1_365) + 'a', // exactly 4096 bytes, multibyte
    '中'.repeat(1_366), // 4098 bytes: the cut lands inside a sequence
    'a'.repeat(4_071) + '𝕏' + 'b'.repeat(200), // 4-byte sequence astride the cut
    'a'.repeat(4_072) + '𝕏' + 'b'.repeat(200), // continuation byte at the cut
    'a'.repeat(4_073) + '𝕏' + 'b'.repeat(200), // sequence starts exactly at the cut
    '🚀'.repeat(1_500), // only 4-byte sequences
    'mixed 中文 and ascii 🚀 '.repeat(400),
    'line one\nline two\n'.repeat(500),
    'tab\tand\u0000control',
  ]

  it('matches the host normalizer byte for byte on every sample', async () => {
    for (const sample of samples) {
      expect(truncateDelegateDiagnostic(sample)).toBe(await hostNormalized(sample))
    }
  })

  it('within the limit: verbatim, no marker', () => {
    for (const sample of ['', 'short ascii', 'a'.repeat(MAX_DELEGATE_DIAGNOSTIC_BYTES), '中'.repeat(1_365) + 'a']) {
      expect(truncateDelegateDiagnostic(sample)).toBe(sample)
      expect(truncateDelegateDiagnostic(sample)).not.toContain('[diagnostic truncated]')
    }
  })

  it('over the limit: ≤4096 UTF-8 bytes INCLUDING the suffix, no split sequence', () => {
    for (const sample of samples) {
      const bounded = truncateDelegateDiagnostic(sample)
      expect(utf8.encode(bounded).byteLength).toBeLessThanOrEqual(MAX_DELEGATE_DIAGNOSTIC_BYTES)
      if (utf8.encode(sample).byteLength > MAX_DELEGATE_DIAGNOSTIC_BYTES) {
        expect(bounded.endsWith(DIAGNOSTIC_TRUNCATION_SUFFIX)).toBe(true)
        expect(bounded).not.toContain('\uFFFD') // a split sequence would decode to U+FFFD
      }
    }
  })

  it('the suffix is the host marker verbatim', () => {
    expect(DIAGNOSTIC_TRUNCATION_SUFFIX).toBe('\n[diagnostic truncated]')
    const bounded = truncateDelegateDiagnostic('a'.repeat(20_000))
    // 4096 - 23 suffix bytes = 4073 body bytes for pure ASCII.
    expect(bounded).toBe('a'.repeat(4_073) + DIAGNOSTIC_TRUNCATION_SUFFIX)
  })
})