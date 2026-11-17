import { describe, expect, it } from 'vitest'
import { ReplayEchoGuard } from '../src/bridge/agy-echo-guard.ts'
import type { LiveSession } from '../src/bridge/live-session.ts'

/** The guard only ever reads `lateEcho`; a bare record is a whole session. */
function sessionWith(late: LiveSession['lateEcho']): LiveSession {
  return { lateEcho: late } as unknown as LiveSession
}

describe('replay echo guard (event-bound lifetime)', () => {
  it('swallows each kind with its own key and retires the record after both', () => {
    const session = sessionWith({ text: 'the answer', thought: 'the thinking', at: 10 })
    const guard = new ReplayEchoGuard(session, 20)
    expect(guard.active()).toBe(true)
    expect(guard.feed('thought', 'the thinking')).toBeUndefined()
    expect(session.lateEcho?.thought).toBeUndefined()
    // Swallowing the thinking must not disarm the text key: the replay sends
    // thinking first, content second, in one flush.
    expect(guard.feed('text', 'the answer')).toBeUndefined()
    expect(session.lateEcho).toBeUndefined()
    expect(guard.feed('text', 'the answer')).toBe('the answer')
  })

  it('holds a strict prefix per kind and emits only the new tail on release', () => {
    const session = sessionWith({ text: 'old answer', thought: 'old thought', at: 10 })
    const guard = new ReplayEchoGuard(session, 20)
    expect(guard.feed('thought', 'old ')).toBeUndefined()
    expect(guard.feed('text', 'old ')).toBeUndefined()
    expect(guard.feed('thought', 'thought plus new')).toBe(' plus new')
    expect(guard.feed('text', 'answer plus new')).toBe(' plus new')
    expect(session.lateEcho).toBeUndefined()
  })

  it('fails open per kind on mismatch and keeps the other key armed', () => {
    const session = sessionWith({ text: 'old answer', thought: 'old thought', at: 10 })
    const guard = new ReplayEchoGuard(session, 20)
    expect(guard.feed('thought', 'a different thinking')).toBe('a different thinking')
    expect(session.lateEcho?.thought).toBeUndefined()
    expect(guard.feed('text', 'old answer')).toBeUndefined()
    expect(session.lateEcho).toBeUndefined()
  })

  it('passes thought through when the step carried no thinking', () => {
    const session = sessionWith({ text: 'old answer', at: 10 })
    const guard = new ReplayEchoGuard(session, 20)
    expect(guard.feed('thought', 'any thinking')).toBe('any thinking')
    expect(guard.feed('text', 'old answer')).toBeUndefined()
  })

  it('is inactive for a turn constructed before the commit', () => {
    const session = sessionWith({ text: 'old answer', at: 30 })
    const guard = new ReplayEchoGuard(session, 20)
    expect(guard.active()).toBe(false)
    expect(guard.feed('text', 'old answer')).toBe('old answer')
  })

  it('retires the record at the close of the turn that owned the replay', () => {
    const session = sessionWith({ text: 'old answer', thought: 'old thought', at: 10 })
    const guard = new ReplayEchoGuard(session, 20)
    expect(guard.feed('text', 'old ')).toBeUndefined()
    expect(guard.takeHeld()).toEqual({ text: 'old ' })
    expect(session.lateEcho).toBeUndefined()
  })

  it('keeps the record for a later turn when an earlier turn closes', () => {
    const session = sessionWith({ text: 'old answer', at: 30 })
    const guard = new ReplayEchoGuard(session, 20)
    expect(guard.takeHeld()).toEqual({})
    expect(session.lateEcho).toBeDefined()
  })
})