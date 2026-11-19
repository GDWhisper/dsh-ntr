/**
 * The permission vocabulary: what `auto` answers with, and the retired-arbitration guard suite.
 *
 * Part of the `tests/impl.spec.ts` mirror: one file per `src/impl/` cluster,
 * same describe titles and case counts as before the split.
 */

import { describe, expect, it } from 'vitest'
import {
  AcpError,
  canonicalizeFsPath,
  DELEGATE_AUTO_KIND_PRIORITY,
  pickAutoOption,
  resolveFsPath,
} from '../../src/impl.ts'
import type { PermissionOptionView } from '../../src/protocol.ts'

describe('pickAutoOption (what `auto` mode answers with)', () => {
  const opt = (optionId: string, kind: string, name = optionId): PermissionOptionView => ({ optionId, name, kind })

  it('picks by the kind the agent declared, broadest grant first', () => {
    // ACP's `PermissionOption` has no "default option" field, so the kind IS
    // the only statement the agent makes about the choice it is offering. The
    // order is `allow_always` → `allow_once` → `reject_once` → `reject_always`
    // — the same rule as OmniTerm dev's `pick_auto_option`.
    expect(pickAutoOption([opt('r1', 'reject_once'), opt('a1', 'allow_once'), opt('a0', 'allow_always')])?.optionId).toBe('a0')
    expect(pickAutoOption([opt('r1', 'reject_once'), opt('a1', 'allow_once')])?.optionId).toBe('a1')
    expect(pickAutoOption([opt('r2', 'reject_always'), opt('r1', 'reject_once')])?.optionId).toBe('r1')
    expect(pickAutoOption([opt('r2', 'reject_always')])?.optionId).toBe('r2')
  })

  it('falls back to the first option when the agent offered only its own kind', () => {
    // An agent may declare a custom kind. Refusing to answer at all would hang
    // the turn, so the first usable option is taken.
    expect(pickAutoOption([opt('c1', 'custom_kind'), opt('c2', 'other')])?.optionId).toBe('c1')
  })

  it('answers nothing when there is nothing to answer', () => {
    // `undefined` is the caller's cue to degrade to `abort`: guessing an option
    // is worse than refusing, and hanging is worse than either.
    expect(pickAutoOption([])).toBeUndefined()
    // An option with no id cannot be answered with — it would be a reply the
    // agent cannot match.
    expect(pickAutoOption([opt('', 'allow_always')])).toBeUndefined()
  })
})

describe('pickAutoOption preferOnce (the delegation-only priority)', () => {
  const opt = (optionId: string, kind: string, name = optionId): PermissionOptionView => ({ optionId, name, kind })

  it('puts allow_once before allow_always when preferOnce is true', () => {
    // A shared (non-A1) process may keep the agent's allow_always memory past
    // the delegated session; the narrower grant cannot leak into the main one.
    expect(DELEGATE_AUTO_KIND_PRIORITY).toEqual(['allow_once', 'allow_always', 'reject_once', 'reject_always'])
    expect(pickAutoOption([opt('a0', 'allow_always'), opt('a1', 'allow_once')], true)?.optionId).toBe('a1')
  })

  it('keeps allow_always first by default and with preferOnce=false', () => {
    const options = [opt('a1', 'allow_once'), opt('a0', 'allow_always')]
    expect(pickAutoOption(options)?.optionId).toBe('a0')
    expect(pickAutoOption(options, false)?.optionId).toBe('a0')
  })

  it('falls back to allow_always when the agent offers no allow_once', () => {
    expect(pickAutoOption([opt('r1', 'reject_once'), opt('a0', 'allow_always')], true)?.optionId).toBe('a0')
  })

  it('leaves the reject rungs and the nothing-to-answer fallback unchanged', () => {
    expect(pickAutoOption([opt('r2', 'reject_always'), opt('r1', 'reject_once')], true)?.optionId).toBe('r1')
    expect(pickAutoOption([opt('c1', 'custom_kind')], true)?.optionId).toBe('c1')
    expect(pickAutoOption([], true)).toBeUndefined()
    expect(pickAutoOption([opt('', 'allow_once')], true)).toBeUndefined()
  })
})

describe('the retired permission axis (nothing here may arbitrate an agent ask)', () => {
  // The whole "DSH access mode maps onto ACP permission decisions" layer is gone
  // (docs/acp-convergence.md §2.3): an ACP agent is fully autonomous, its
  // `session/request_permission` is mapped to the user unchanged, and DSH's
  // sandbox cannot reach into the agent's own process anyway. These cases pin
  // the two facts that made the old axis actively harmful.
  it('has no exported decision helper left to reach for', async () => {
    const impl = await import('../../src/impl.ts') as Record<string, unknown>
    for (const gone of ['decidePermission', 'dshSessionPolicyOf', 'dshApprovalPolicyOf', 'sandboxDenialMarker']) {
      expect(impl[gone]).toBeUndefined()
    }
  })

  it('still fences a workspace, because that boundary is real and always was', () => {
    // What survives is only the workspace guard: a write or read outside the
    // session's resolved roots is refused. That is not a policy layer — it is
    // the same containment the ACP file protocol requires.
    const realpath = (p: string): string => p
    expect(resolveFsPath('/srv/ws', ['/srv/ws'], 'a.txt', realpath)).toBe('/srv/ws/a.txt')
    expect(() => resolveFsPath('/srv/ws', ['/srv/ws'], '/etc/hosts', realpath)).toThrow(AcpError)
    expect(() => canonicalizeFsPath('/srv/ws', '', realpath)).toThrow(AcpError)
  })
})
