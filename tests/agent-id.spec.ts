/**
 * The agent-id charset rule across the half boundary (AGENTS/ui.md §3.2):
 * src/client/agent-id.ts is the ONE browser-half copy, shared by
 * panel/agent-row.tsx and subagent-panel.tsx; the host original is
 * src/impl/validate.ts · AGENT_ID_PATTERN. The hand copy is pinned here —
 * source/flags verbatim plus behavior samples — and the subagent-panel
 * consumer is pinned at the length boundary so a drifted local literal
 * cannot sneak back in (a second literal in src/client/ is forbidden).
 */
import { describe, expect, it } from 'vitest'
import { AGENT_ID_PATTERN as clientPattern } from '../src/client/agent-id.ts'
import { displayDelegateLabel } from '../src/client/subagent-panel.tsx'
import { delegateLabel, displayDelegateLabel as hostDisplayDelegateLabel } from '../src/impl/delegate-label.ts'
import { AGENT_ID_PATTERN as hostPattern } from '../src/impl/validate.ts'

describe('client AGENT_ID_PATTERN ≡ host original (cross-half hand copy)', () => {
  it('source and flags are verbatim identical', () => {
    expect(clientPattern.source).toBe(hostPattern.source)
    expect(clientPattern.flags).toBe(hostPattern.flags)
    expect(clientPattern.source).toBe('^[a-z0-9][a-z0-9._-]{0,63}$')
  })

  it('behavior samples: both halves render the same verdict on every sample', () => {
    const samples: Array<[string, boolean]> = [
      // legal
      ['a', true],
      ['0abc', true],
      ['a.b_c-d', true],
      ['x'.repeat(64), true],
      // illegal
      ['x'.repeat(65), false],
      ['A', false],
      ['-a', false],
      ['.a', false],
      ['a b', false],
      ['a:b', false],
      ['', false],
      ['中文', false],
      ['a⟦b', false],
    ]
    for (const [sample, expected] of samples) {
      expect(hostPattern.test(sample), `host: ${JSON.stringify(sample)}`).toBe(expected)
      expect(clientPattern.test(sample), `client: ${JSON.stringify(sample)}`).toBe(expected)
    }
  })
})

describe('consumers ride the shared constant (length boundary)', () => {
  it('subagent-panel strips a carrier whose agent id is exactly 64 chars', () => {
    const id = 'x'.repeat(64)
    const label = delegateLabel(id, 'do it', { model: 'm', effort: 'high', mode: 'ask' })
    expect(displayDelegateLabel(label)).toBe(`${id}: do it`)
    expect(displayDelegateLabel(label)).toBe(hostDisplayDelegateLabel(label))
  })

  it('subagent-panel fails open on a 65-char id exactly like the host', () => {
    const label = delegateLabel('x'.repeat(65), 'do it', { model: 'm' })
    // An illegal id makes the carrier malformed: display passes it through.
    expect(displayDelegateLabel(label)).toBe(label)
    expect(displayDelegateLabel(label)).toBe(hostDisplayDelegateLabel(label))
  })
})