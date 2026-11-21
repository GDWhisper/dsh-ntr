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
  delegateLabel,
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