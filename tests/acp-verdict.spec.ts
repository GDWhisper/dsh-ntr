import { describe, expect, it } from 'vitest'

import {
  commitFrame,
  consumeVerdict,
  invalidateVerdict,
  markUnsettled,
  peekVerdict,
  projectAcpMode,
  settleFromHost,
  type AcpVerdict,
  type AcpVerdictBook,
} from '../src/client/acp-verdict.ts'
import { AcpStore } from '../src/client/store.ts'

function book(...entries: Array<[string, AcpVerdict]>): AcpVerdictBook {
  return new Map(entries)
}

describe('acp verdict book', () => {
  it('answers unknown for a session nobody asked about: no entry is not false', () => {
    const verdicts = book()
    expect(peekVerdict(verdicts, 'chat-1')).toBeUndefined()
    expect(consumeVerdict(verdicts, 'chat-1')).toBe(false)
    expect(projectAcpMode(verdicts)).toEqual({})
  })

  it('settles a plain host answer but never displaces a frame', () => {
    const verdicts = book()
    settleFromHost(verdicts, 'chat-1', true)
    expect(verdicts.get('chat-1')).toEqual({ kind: 'host', value: true })
    // A later read may correct a host verdict in either direction.
    settleFromHost(verdicts, 'chat-1', false)
    expect(verdicts.get('chat-1')).toEqual({ kind: 'host', value: false })

    // The gate's authorized re-ask IS allowed to move a frame verdict's value...
    commitFrame(verdicts, 'chat-1', false)
    settleFromHost(verdicts, 'chat-1', true)
    expect(verdicts.get('chat-1')).toEqual({ kind: 'frame', value: true })
    // ...but the frame keeps its rank: a plain read now defers, not settles.
    settleFromHost(verdicts, 'chat-1', false)
    expect(verdicts.get('chat-1')).toEqual({ kind: 'frame', value: false })
  })

  it('promotes the authority when a frame restates the held value', () => {
    const verdicts = book()
    settleFromHost(verdicts, 'chat-1', true)
    const before = projectAcpMode(verdicts)
    commitFrame(verdicts, 'chat-1', true)
    expect(verdicts.get('chat-1')).toEqual({ kind: 'frame', value: true })
    // Same value, so the projection the UI reads did not move.
    expect(projectAcpMode(verdicts)).toEqual(before)
  })

  it('keeps a held value on screen when a read comes back unanswered', () => {
    const verdicts = book()
    settleFromHost(verdicts, 'chat-1', true)
    markUnsettled(verdicts, 'chat-1')
    // An unanswered read is a retry signal, not a retraction of what we hold.
    expect(projectAcpMode(verdicts)).toEqual({ 'chat-1': true })

    // A session nobody answered for still records the open question.
    markUnsettled(verdicts, 'chat-2')
    expect(verdicts.get('chat-2')).toEqual({ kind: 'unsettled' })
    expect(projectAcpMode(verdicts)).toEqual({ 'chat-1': true })
  })

  it('consumes an unsettled marker destructively, and only that kind', () => {
    const verdicts = book(['chat-1', { kind: 'unsettled' }], ['chat-2', { kind: 'host', value: false }])
    expect(consumeVerdict(verdicts, 'chat-1')).toBe(false)
    expect(peekVerdict(verdicts, 'chat-1')).toBeUndefined()
    // A settled verdict answers true and survives the query.
    expect(consumeVerdict(verdicts, 'chat-2')).toBe(true)
    expect(peekVerdict(verdicts, 'chat-2')).toEqual({ kind: 'host', value: false })
  })

  it('peeks without consuming, which is what a read needs', () => {
    const verdicts = book(['chat-1', { kind: 'unsettled' }])
    expect(peekVerdict(verdicts, 'chat-1')?.kind).toBe('unsettled')
    expect(peekVerdict(verdicts, 'chat-1')?.kind).toBe('unsettled')
  })

  it('invalidates values but keeps an open question', () => {
    const verdicts = book(
      ['hosted', { kind: 'host', value: true }],
      ['framed', { kind: 'frame', value: false }],
      ['open', { kind: 'unsettled' }],
    )
    invalidateVerdict(verdicts, 'hosted')
    expect(peekVerdict(verdicts, 'hosted')).toBeUndefined()
    expect(peekVerdict(verdicts, 'framed')).toEqual({ kind: 'frame', value: false })
    // Invalidating one session leaves another's open question alone.
    invalidateVerdict(verdicts, 'open')
    expect(peekVerdict(verdicts, 'open')).toEqual({ kind: 'unsettled' })

    invalidateVerdict(verdicts)
    expect(peekVerdict(verdicts, 'framed')).toBeUndefined()
    expect(peekVerdict(verdicts, 'open')).toEqual({ kind: 'unsettled' })
    expect(projectAcpMode(verdicts)).toEqual({})
  })
})

describe('acp verdict store', () => {
  it('answers a consumed unsettled marker by retrying, and settles on the next answer', async () => {
    let host: { sessions: unknown[]; acpMode?: boolean } = { sessions: [] }
    const store = new AcpStore(async (_channel, endpoint) => {
      if (endpoint === 'session/chat-list') return { ok: true, value: host }
      return { ok: true, value: {} }
    }, (zh) => zh)

    // The read answered without a verdict: the gate must be able to retry.
    await store.loadChatSessions('chat-1')
    expect(store.getSnapshot().acpMode).toEqual({})
    expect(store.hasAcpModeVerdict('chat-1')).toBe(false)
    // ...and the gate's second look is the same answer, not a consumed-but-true.
    expect(store.hasAcpModeVerdict('chat-1')).toBe(false)

    // The retry is not blocked by the unanswered read: peekVerdict does not
    // consume a frame rank, and there is none here.
    host = { sessions: [], acpMode: true }
    await store.loadChatSessions('chat-1')
    expect(store.getSnapshot().acpMode).toEqual({ 'chat-1': true })
    expect(store.hasAcpModeVerdict('chat-1')).toBe(true)
  })

  it('clears frame and host verdicts on global invalidation, and re-opens reads', async () => {
    let host: { sessions: unknown[]; acpMode?: boolean } = { sessions: [], acpMode: false }
    const store = new AcpStore(async (_channel, endpoint) => {
      if (endpoint === 'session/chat-list') return { ok: true, value: host }
      return { ok: true, value: {} }
    }, (zh) => zh)

    store.noteAcpMode('chat-1', true)
    await store.loadChatSessions('chat-2')
    expect(store.getSnapshot().acpMode).toEqual({ 'chat-1': true, 'chat-2': false })

    store.invalidateAcpMode()
    expect(store.getSnapshot().acpMode).toEqual({})
    expect(store.hasAcpModeVerdict('chat-1')).toBe(false)
    expect(store.hasAcpModeVerdict('chat-2')).toBe(false)

    // A frame verdict no longer bars the host read once invalidated.
    host = { sessions: [], acpMode: true }
    await store.loadChatSessions('chat-1')
    expect(store.getSnapshot().acpMode).toEqual({ 'chat-1': true })
  })

  it('keeps the frame rank after the gate’s authorized re-ask', async () => {
    let host = { sessions: [] as unknown[], acpMode: true }
    const store = new AcpStore(async (_channel, endpoint) => {
      if (endpoint === 'session/chat-list') return { ok: true, value: host }
      return { ok: true, value: {} }
    }, (zh) => zh)

    store.noteAcpMode('chat-1', true)
    host = { sessions: [], acpMode: false }
    // A composer read still defers to the frame.
    await store.loadChatSessions('chat-1')
    expect(store.getSnapshot().acpMode).toEqual({ 'chat-1': true })

    // The gate's TTL re-ask is authorized to adopt the host value...
    await store.loadChatSessions('chat-1', { settleVerdict: true })
    expect(store.getSnapshot().acpMode).toEqual({ 'chat-1': false })

    // ...but the verdict is still a frame's: a plain read may not move it back.
    host = { sessions: [], acpMode: true }
    await store.loadChatSessions('chat-1')
    expect(store.getSnapshot().acpMode).toEqual({ 'chat-1': false })
  })

  it('throttles a held verdict’s ask by TTL, retries an unanswered one, and releases on demand', () => {
    const store = new AcpStore(async () => ({ ok: true, value: {} }), (zh) => zh)

    store.noteAcpMode('chat-1', true)
    expect(store.claimAcpAsk('chat-1', 60_000)).toBe(true)
    expect(store.claimAcpAsk('chat-1', 60_000)).toBe(false)
    // A held verdict is re-asked once its TTL elapsed.
    expect(store.claimAcpAsk('chat-1', 0)).toBe(true)

    // No verdict held: an unanswered ask is retried immediately, not parked.
    expect(store.claimAcpAsk('chat-2', 60_000)).toBe(true)
    expect(store.claimAcpAsk('chat-2', 60_000)).toBe(true)

    // A committed frame drops the ledger entry so the next evaluation asks.
    store.releaseAcpAsk('chat-1')
    expect(store.claimAcpAsk('chat-1', 60_000)).toBe(true)
  })
})
