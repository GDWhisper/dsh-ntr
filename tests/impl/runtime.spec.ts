/**
 * Runtime holders: the capped transcript, the event hub and the permission ledger lifecycle.
 *
 * Part of the `tests/impl.spec.ts` mirror: one file per `src/impl/` cluster,
 * same describe titles and case counts as before the split.
 */

import { describe, expect, it } from 'vitest'
import {
  EventHub,
  PermissionLedger,
  Transcript,
  permissionReplayFrames,
} from '../../src/impl.ts'

describe('Transcript', () => {
  it('assigns monotone seq and bounds memory while since() replays', () => {
    const t = new Transcript(5)
    for (let i = 0; i < 9; i++) t.append({ i })
    expect(t.head).toBe(9)
    const kept = t.since(0)
    expect(kept.map(e => e.seq)).toEqual([5, 6, 7, 8, 9])
    expect(t.since(7).map(e => e.update)).toEqual([{ i: 7 }, { i: 8 }])
  })

  it('coalesces a run of usage ticks into one replayable entry', () => {
    const t = new Transcript(600)
    let seq = 0
    for (let used = 1; used <= 10; used++) {
      seq = t.append({ sessionUpdate: 'usage_update', used, size: 1000 })
    }
    const entries = t.since(0)
    expect(entries).toHaveLength(1)
    expect(entries[0]?.seq).toBe(seq)
    expect(entries[0]?.seq).toBe(10)
    expect(entries[0]?.update).toEqual({ sessionUpdate: 'usage_update', used: 10, size: 1000 })
    expect(t.head).toBe(10)
    expect(t.since(seq)).toEqual([])
  })

  it('keeps every content entry and only collapses each consecutive state run', () => {
    const t = new Transcript(600)
    t.append({ sessionUpdate: 'usage_update', used: 1, size: 100 })
    t.append({ sessionUpdate: 'tool_call', toolCallId: 'c1', title: 'run', status: 'pending' })
    t.append({ sessionUpdate: 'usage_update', used: 2, size: 100 })
    t.append({ sessionUpdate: 'usage_update', used: 3, size: 100 })
    t.append({ sessionUpdate: 'agent_message_chunk', messageId: 'm1', content: { type: 'text', text: 'hi' } })
    t.append({ sessionUpdate: 'usage_update', used: 4, size: 100 })
    const entries = t.since(0)
    expect(entries.map(e => (e.update as { sessionUpdate: string }).sessionUpdate)).toEqual([
      'usage_update', 'tool_call', 'usage_update', 'agent_message_chunk', 'usage_update',
    ])
    // The merged tick kept the seq of the LAST frame of its run, so replayed
    // seqs have holes but are monotone.
    expect(entries.map(e => e.seq)).toEqual([1, 2, 4, 5, 6])
    expect((entries[2]?.update as { used: number }).used).toBe(3)
    expect(entries.filter(e => (e.update as { sessionUpdate: string }).sessionUpdate !== 'usage_update')).toHaveLength(2)
    // A watermark at the last content seq still replays the latest state tick.
    expect(t.since(5)).toEqual([{ seq: 6, update: { sessionUpdate: 'usage_update', used: 4, size: 100 } }])
  })

  it('never merges a titled session_info_update, but does merge the phase ticks after it', () => {
    const t = new Transcript(600)
    const titled = { sessionUpdate: 'session_info_update', title: 'Fix the login bug' }
    t.append(titled)
    t.append({ sessionUpdate: 'session_info_update', _meta: { phase: 'thinking' } })
    t.append({ sessionUpdate: 'session_info_update', _meta: { phase: 'writing' } })
    const entries = t.since(0)
    expect(entries).toHaveLength(2)
    expect(entries[0]?.update).toEqual(titled)
    expect(entries[1]?.seq).toBe(3)
    expect((entries[1]?.update as { _meta?: unknown })._meta).toEqual({ phase: 'writing' })
    // A missing title qualifies as a tick too; an empty one as well.
    const u = new Transcript(600)
    u.append({ sessionUpdate: 'session_info_update', _meta: { phase: 'a' } })
    u.append({ sessionUpdate: 'session_info_update', title: '', _meta: { phase: 'b' } })
    expect(u.since(0)).toHaveLength(1)
    expect((u.since(0)[0]?.update as { _meta?: unknown })._meta).toEqual({ phase: 'b' })
  })

  it('coalesces consecutive config_option_update frames, keeping the latest options', () => {
    const t = new Transcript(600)
    t.append({ sessionUpdate: 'config_option_update', configOptions: [{ configId: 'model', currentValue: 'a' }] })
    t.append({ sessionUpdate: 'config_option_update', configOptions: [{ configId: 'model', currentValue: 'b' }] })
    const entries = t.since(0)
    expect(entries).toHaveLength(1)
    expect(entries[0]?.seq).toBe(2)
    expect(entries[0]?.update).toEqual({
      sessionUpdate: 'config_option_update',
      configOptions: [{ configId: 'model', currentValue: 'b' }],
    })
  })

  it('leaves plan, command lists, mode changes and stream chunks unmerged', () => {
    const t = new Transcript(600)
    const updates = [
      { sessionUpdate: 'plan', entries: [] },
      { sessionUpdate: 'available_commands_update', availableCommands: [] },
      { sessionUpdate: 'current_mode_update', currentModeId: 'm' },
      { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'a' } },
      { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'b' } },
    ]
    for (const update of updates) t.append(update)
    expect(t.since(0)).toHaveLength(updates.length)
    expect(t.since(0).map(e => e.seq)).toEqual([1, 2, 3, 4, 5])
  })

  it('does not let a different state kind extend the previous tick', () => {
    const t = new Transcript(600)
    t.append({ sessionUpdate: 'usage_update', used: 1, size: 10 })
    t.append({ sessionUpdate: 'config_option_update', configOptions: [] })
    t.append({ sessionUpdate: 'usage_update', used: 2, size: 10 })
    expect(t.since(0).map(e => (e.update as { sessionUpdate: string }).sessionUpdate)).toEqual([
      'usage_update', 'config_option_update', 'usage_update',
    ])
  })
})

describe('PermissionLedger', () => {
  it('resolves exactly once and settles scoped pendings as cancelled', () => {
    const ledger = new PermissionLedger()
    let a: unknown
    let b: unknown
    const ra = ledger.create('s1', o => { a = o })
    const rb = ledger.create('s2', o => { b = o })
    ledger.respond(ra, { outcome: 'selected', optionId: 'allow1' })
    expect(a).toEqual({ outcome: 'selected', optionId: 'allow1' })
    expect(() => ledger.respond(ra, { outcome: 'cancelled' })).toThrow(/no pending/)
    ledger.settleFor(p => p.sessionId === 's2')
    expect(b).toEqual({ outcome: 'cancelled' })
    expect(ledger.sessionIds()).toHaveLength(0)
    void rb
  })

  it('answers hasPendingFor per session and forgets an ask once it is settled', () => {
    // The inactivity watchdog asks this question before firing: an ask waiting
    // for the human is NOT the agent being stuck (`wait` has no deadline at
    // all, so a stalled-looking turn can legitimately sit here forever).
    const ledger = new PermissionLedger()
    const answered: unknown[] = []
    const first = ledger.create('s1', outcome => { answered.push(outcome) })
    const other = ledger.create('s2', () => {})

    expect(ledger.hasPendingFor('s1')).toBe(true)
    expect(ledger.hasPendingFor('s2')).toBe(true)
    expect(ledger.hasPendingFor('s3')).toBe(false)
    // The key is the HOST session id (`LiveSession.sessionId`), not the ACP
    // protocol session id, and it is matched exactly: no prefix matching.
    expect(ledger.hasPendingFor('s')).toBe(false)

    ledger.respond(first, { outcome: 'cancelled' })
    expect(answered).toEqual([{ outcome: 'cancelled' }])
    expect(ledger.hasPendingFor('s1')).toBe(false)
    expect(ledger.hasPendingFor('s2')).toBe(true)

    ledger.settleFor(entry => entry.sessionId === 's2')
    expect(ledger.hasPendingFor('s2')).toBe(false)
    void other
  })

  it('replays only asks that carry a view, as their original request frame', () => {
    const ledger = new PermissionLedger()
    // Every field the live frame carried must ride the replay too: the
    // conversation card filters on `dshSessionId` and renders `toolName` /
    // `deadlineAt`, so a replay missing one would silently drop the ask.
    const view = {
      dshSessionId: 'chat-1',
      toolCall: { title: 'Bash' },
      toolName: 'Bash',
      reason: 'Bash · ls -la',
      options: [{ optionId: 'allow1', name: 'Allow once', kind: 'allow_once' }],
      timeoutMode: 'abort' as const,
      deadlineAt: 1_700_000_000_000,
    }
    const shown = ledger.create('s1', () => {}, view)
    // An entry without a view still answers — it just cannot be re-shown.
    const hidden = ledger.create('s2', () => {})

    expect(ledger.pendingViews()).toEqual([{ requestId: shown, sessionId: 's1', ...view }])

    const frames = permissionReplayFrames(ledger.pendingViews())
    // The ask rides its ORIGINAL frame: the client folds both by request id,
    // so a replay that arrived alongside the live broadcast is idempotent.
    expect(frames[0]).toEqual({ type: 'permission/request', requestId: shown, sessionId: 's1', ...view })
    // …and the terminator carries the live set, so a client that reconnects
    // drops anything it still holds from before the disconnect.
    expect(frames.at(-1)).toEqual({ type: 'permission/synced', requestIds: [shown] })

    ledger.respond(shown, { outcome: 'cancelled' })
    expect(permissionReplayFrames(ledger.pendingViews())).toEqual([{ type: 'permission/synced', requestIds: [] }])
    void hidden
  })
})

describe('EventHub', () => {
  it('isolates subscriber failures', () => {
    const hub = new EventHub()
    const seen: unknown[] = []
    hub.subscribe(() => { throw new Error('boom') })
    hub.subscribe(e => { seen.push(e) })
    hub.broadcast({ type: 'session/closed', sessionId: 'x', reason: 'closed' })
    expect(seen).toHaveLength(1)
  })
})
