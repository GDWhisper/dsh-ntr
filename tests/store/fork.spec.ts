/**
 * The NTR branch button state machine, verbatim from `tests/store.spec.ts`
 * (split plan P3a test mirror): same describe title and case count.
 */

import { describe, expect, it } from 'vitest'
import { forkStateOf } from '../../src/client/store/fork.ts'
import type { ChatSessionView } from '../../src/protocol.ts'

/**
 * The NTR branch button's state machine (the message-actions plan §D4). Every
 * input is a fact someone else owns — the row's `fork` verdict is the host's,
 * `hostFork` is the runtime probe, `isTail` is the host's own DOM marker — so
 * the mapping is pure precedence, and `undefined` facts degrade CLOSED.
 */
describe('forkStateOf (the NTR branch button state machine)', () => {
  const readyRow: ChatSessionView = { agentId: 'pi', sessionId: 's1', fork: { supported: true } }

  it('maps the six states in the precedence they render', () => {
    expect(forkStateOf(readyRow, true, true)).toBe('ready')
    // The runtime has no `sessions.fork` face: nothing can work, ever.
    expect(forkStateOf(readyRow, false, true)).toBe('hostUnavailable')
    // No row: the conversation's ACP session is parked (or was never read) —
    // degrade to released, never to a click-through.
    expect(forkStateOf(undefined, true, true)).toBe('released')
    // A row from a host half that predates the fork field: unsupported.
    expect(forkStateOf({ agentId: 'pi', sessionId: 's1' }, true, true)).toBe('unsupported')
    // The host's verdict is the authority; its reason rides through.
    expect(forkStateOf({ agentId: 'pi', sessionId: 's1', fork: { supported: false, reason: 'unsupported' } }, true, true)).toBe('unsupported')
    expect(forkStateOf({ agentId: 'pi', sessionId: 's1', fork: { supported: false, reason: 'released' } }, true, true)).toBe('released')
    expect(forkStateOf({ agentId: 'pi', sessionId: 's1', fork: { supported: false, reason: 'busy' } }, true, true)).toBe('busy')
    // `false` with no reason: a host half that predates reasons (treat as
    // unsupported, never as a click-through).
    expect(forkStateOf({ agentId: 'pi', sessionId: 's1', fork: { supported: false } }, true, true)).toBe('unsupported')
    // History rows gray out even when everything else is fine.
    expect(forkStateOf(readyRow, true, false)).toBe('notTail')
  })

  it('answers busy from the live running flag even when the row says ready', () => {
    // The row's own `running` only refreshes on a chat-list read; the
    // SSE-driven live flag is the fresher fact, and a running turn is not
    // forkable (the adopt refuses mid-turn parents too).
    expect(forkStateOf(readyRow, true, true, true)).toBe('busy')
    expect(forkStateOf(readyRow, true, true, false)).toBe('ready')
    // An absent live flag is no fact at all: the row's ready stands.
    expect(forkStateOf(readyRow, true, true, undefined)).toBe('ready')
  })
})
