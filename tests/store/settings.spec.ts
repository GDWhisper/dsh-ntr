/**
 * The settings page's preference writes (split plan P3b): the tag halo, the
 * `[NTR]` title prefix and the approval deadlines — every one an optimistic
 * local write whose revert target is the host's last answer.
 *
 * Part of the `tests/store.spec.ts` mirror: cases lifted verbatim out of
 * `AcpStore agent management` (same describe title, same case count for this
 * cluster); `tests/store.spec.ts` keeps the rest of that describe.
 */

import { describe, expect, it } from 'vitest'
import { AcpStore } from '../../src/client/store.ts'

describe('AcpStore agent management', () => {
  it('reads the tag halo on resync and writes it back optimistically', async () => {
    const store = new AcpStore(
      async (_channel, endpoint) => {
        if (endpoint === 'agents/list') return { ok: true, value: { agents: [] } }
        if (endpoint === 'sessions/list') return { ok: true, value: { sessions: [] } }
        if (endpoint === 'agents/detect') return { ok: true, value: { agents: [] } }
        if (endpoint === 'ui/tag-halo') return { ok: true, value: { halo: { mode: 'steady', speed: 'slow' } } }
        return { ok: true, value: {} }
      },
      (zh) => zh,
    )
    // The host answer is the authority; the initial local default gives way.
    await store.resync()
    expect(store.getSnapshot().tagHalo).toEqual({ mode: 'steady', speed: 'slow' })

    // The write lands optimistically (the tag's look changes with the click)
    // and the RPC carries the full halo object.
    await store.setTagHalo({ mode: 'breath', speed: 'fast' })
    expect(store.getSnapshot().tagHalo).toEqual({ mode: 'breath', speed: 'fast' })

    // A failed write reverts to the previous setting instead of leaving the
    // tag looking like something the host refused.
    const failing = new AcpStore(
      async (_channel, endpoint) => {
        if (endpoint === 'agents/list') return { ok: true, value: { agents: [] } }
        if (endpoint === 'sessions/list') return { ok: true, value: { sessions: [] } }
        if (endpoint === 'agents/detect') return { ok: true, value: { agents: [] } }
        if (endpoint === 'ui/tag-halo-set') return { ok: false, error: { code: 'bad_payload', message: 'no' } }
        return { ok: true, value: {} }
      },
      (zh) => zh,
    )
    await failing.resync()
    await failing.setTagHalo({ mode: 'steady', speed: 'normal' })
    // The revert target is what resync last knew: the host default, because
    // this mock never answers `ui/tag-halo`.
    expect(failing.getSnapshot().tagHalo).toEqual({ mode: 'breath', speed: 'normal' })
  })

  it('reads the title-prefix toggle on resync and writes it back optimistically', async () => {
    const sent: Array<Record<string, unknown>> = []
    const store = new AcpStore(
      async (_channel, endpoint, payload) => {
        if (endpoint === 'agents/list') return { ok: true, value: { agents: [] } }
        if (endpoint === 'sessions/list') return { ok: true, value: { sessions: [] } }
        if (endpoint === 'agents/detect') return { ok: true, value: { agents: [] } }
        if (endpoint === 'ui/session-title-prefix') return { ok: true, value: { titlePrefix: true } }
        if (endpoint === 'ui/session-title-prefix-set') { sent.push(payload as Record<string, unknown>); return { ok: true, value: {} } }
        return { ok: true, value: {} }
      },
      (zh) => zh,
    )
    // The host answer is the authority; the initial local default gives way.
    await store.resync()
    expect(store.getSnapshot().titlePrefix).toBe(true)

    // The write lands optimistically and the RPC carries the boolean under
    // the key the host route validates — a store↔host key drift fails here.
    await store.setTitlePrefix(false)
    expect(store.getSnapshot().titlePrefix).toBe(false)
    expect(sent).toEqual([{ titlePrefix: false }])

    // A failed write reverts to the previous setting instead of leaving the
    // row showing something the host refused.
    const failing = new AcpStore(
      async (_channel, endpoint) => {
        if (endpoint === 'agents/list') return { ok: true, value: { agents: [] } }
        if (endpoint === 'sessions/list') return { ok: true, value: { sessions: [] } }
        if (endpoint === 'agents/detect') return { ok: true, value: { agents: [] } }
        if (endpoint === 'ui/session-title-prefix-set') return { ok: false, error: { code: 'bad_payload', message: 'no' } }
        return { ok: true, value: {} }
      },
      (zh) => zh,
    )
    await failing.resync()
    await failing.setTitlePrefix(false)
    // The revert target is what resync last knew: the default (on), because
    // this mock never answers `ui/session-title-prefix`.
    expect(failing.getSnapshot().titlePrefix).toBe(true)
  })

  it('reads the approval deadlines on resync and writes one back optimistically', async () => {
    const sent: Array<Record<string, unknown>> = []
    const store = new AcpStore(
      async (_channel, endpoint, payload) => {
        if (endpoint === 'agents/list') return { ok: true, value: { agents: [] } }
        if (endpoint === 'sessions/list') return { ok: true, value: { sessions: [] } }
        if (endpoint === 'agents/detect') return { ok: true, value: { agents: [] } }
        if (endpoint === 'ui/approval-deadlines') {
          return { ok: true, value: { deadlines: { permissionTimeoutMs: 600_000, mode: 'abort', configured: { permissionTimeoutMs: 600_000 } } } }
        }
        if (endpoint === 'ui/approval-deadlines-set') {
          sent.push(payload as Record<string, unknown>)
          // The host answer is the authority: it echoes what is now in force.
          return { ok: true, value: { deadlines: { permissionTimeoutMs: 30_000, mode: 'auto', configured: { permissionTimeoutMs: 600_000 } } } }
        }
        return { ok: true, value: {} }
      },
      (zh) => zh,
    )
    await store.resync()
    expect(store.getSnapshot().approvalDeadlines).toMatchObject({ permissionTimeoutMs: 600_000, mode: 'abort' })

    // Only the touched key travels; the host answer replaces the optimistic value.
    await store.setApprovalDeadline(30_000)
    expect(sent).toEqual([{ permissionTimeoutMs: 30_000 }])
    expect(store.getSnapshot().approvalDeadlines).toMatchObject({ permissionTimeoutMs: 30_000, mode: 'auto' })

    // The mode travels through the same write path.
    await store.setApprovalTimeoutMode('auto')
    expect(sent[1]).toEqual({ mode: 'auto' })
    expect(store.getSnapshot().approvalDeadlines).toMatchObject({ mode: 'auto' })

    // `reset` is its own payload, not a deadline.
    await store.resetApprovalDeadlines()
    expect(sent[2]).toEqual({ reset: true })

    // A host half without the route leaves the card hidden rather than showing
    // a number this browser invented.
    const older = new AcpStore(
      async (_channel, endpoint) => {
        if (endpoint === 'agents/list') return { ok: true, value: { agents: [] } }
        if (endpoint === 'sessions/list') return { ok: true, value: { sessions: [] } }
        if (endpoint === 'agents/detect') return { ok: true, value: { agents: [] } }
        if (endpoint === 'ui/approval-deadlines') return { ok: false, error: { code: 'unknown_endpoint', message: 'no' } }
        return { ok: true, value: {} }
      },
      (zh) => zh,
    )
    await older.resync()
    expect(older.getSnapshot().approvalDeadlines).toBeUndefined()

    // A refused write reverts to the last host answer instead of leaving the
    // card showing a window that is not running.
    const failing = new AcpStore(
      async (_channel, endpoint) => {
        if (endpoint === 'agents/list') return { ok: true, value: { agents: [] } }
        if (endpoint === 'sessions/list') return { ok: true, value: { sessions: [] } }
        if (endpoint === 'agents/detect') return { ok: true, value: { agents: [] } }
        if (endpoint === 'ui/approval-deadlines') {
          return { ok: true, value: { deadlines: { nativeApprovalTimeoutMs: 300_000, permissionFallbackTimeoutMs: 300_000 } } }
        }
        if (endpoint === 'ui/approval-deadlines-set') return { ok: false, error: { code: 'bad_payload', message: 'no' } }
        return { ok: true, value: {} }
      },
      (zh) => zh,
    )
    await failing.resync()
    await failing.setApprovalDeadline('nativeApprovalTimeoutMs', 30_000)
    expect(failing.getSnapshot().approvalDeadlines).toEqual({ nativeApprovalTimeoutMs: 300_000, permissionFallbackTimeoutMs: 300_000 })
  })

  it('reads the delegate settings on resync, writes optimistically, and resets one key', async () => {
    const sent: Array<Record<string, unknown>> = []
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const seed = {
      guidance: 'on', permissionMode: 'ask', timeoutMs: 900_000, maxOutputChars: 20_000,
      configured: { guidance: 'off', timeoutMs: 300_000 }, toolAvailable: true, restrictAvailable: true,
    }
    // The host answer differs from the optimistic value: it is the authority.
    const answer = { ...seed, guidance: 'enhanced', permissionMode: 'abort', timeoutMs: 600_000 }
    const store = new AcpStore(
      async (_channel, endpoint, payload) => {
        if (endpoint === 'agents/list') return { ok: true, value: { agents: [] } }
        if (endpoint === 'sessions/list') return { ok: true, value: { sessions: [] } }
        if (endpoint === 'agents/detect') return { ok: true, value: { agents: [] } }
        if (endpoint === 'ui/delegate') return { ok: true, value: { delegate: seed } }
        if (endpoint === 'ui/delegate-set') { sent.push(payload as Record<string, unknown>); await gate; return { ok: true, value: { delegate: answer } } }
        return { ok: true, value: {} }
      },
      (zh) => zh,
    )
    await store.resync()
    expect(store.getSnapshot().delegate).toMatchObject({ guidance: 'on', permissionMode: 'ask', timeoutMs: 900_000 })

    // Only the touched key travels, and it moves before the host answers.
    const write = store.setDelegateSettings({ guidance: 'force' })
    expect(store.getSnapshot().delegate).toMatchObject({ guidance: 'force', permissionMode: 'ask', timeoutMs: 900_000 })
    expect(sent).toEqual([{ guidance: 'force' }])
    release()
    await write
    expect(store.getSnapshot().delegate).toMatchObject({ guidance: 'enhanced', permissionMode: 'abort', timeoutMs: 600_000 })

    // A reset is per key: the optimistic fallback is the config file's value…
    const resetWindow = store.resetDelegateSetting('timeoutMs')
    expect(store.getSnapshot().delegate?.timeoutMs).toBe(300_000)
    expect(sent[1]).toEqual({ reset: ['timeoutMs'] })
    await resetWindow
    // …and the built-in default where the file names nothing.
    const resetMode = store.resetDelegateSetting('permissionMode')
    expect(store.getSnapshot().delegate?.permissionMode).toBe('auto')
    expect(sent[2]).toEqual({ reset: ['permissionMode'] })
    await resetMode
    expect(store.getSnapshot().delegate).toMatchObject(answer)
  })

  it('reverts a refused delegate write and keeps the card hidden on an older host', async () => {
    const seed = { guidance: 'on', permissionMode: 'auto', timeoutMs: 600_000, maxOutputChars: 20_000, toolAvailable: true, restrictAvailable: true }
    const failing = new AcpStore(
      async (_channel, endpoint) => {
        if (endpoint === 'agents/list') return { ok: true, value: { agents: [] } }
        if (endpoint === 'sessions/list') return { ok: true, value: { sessions: [] } }
        if (endpoint === 'agents/detect') return { ok: true, value: { agents: [] } }
        if (endpoint === 'ui/delegate') return { ok: true, value: { delegate: seed } }
        if (endpoint === 'ui/delegate-set') return { ok: false, error: { code: 'bad_payload', message: 'no' } }
        return { ok: true, value: {} }
      },
      (zh) => zh,
    )
    await failing.resync()
    await failing.setDelegateSettings({ guidance: 'force', timeoutMs: 3_600_000 })
    expect(failing.getSnapshot().delegate).toEqual(seed)
    expect(failing.getSnapshot().notice).toBe('no')

    const older = new AcpStore(
      async (_channel, endpoint) => {
        if (endpoint === 'agents/list') return { ok: true, value: { agents: [] } }
        if (endpoint === 'sessions/list') return { ok: true, value: { sessions: [] } }
        if (endpoint === 'agents/detect') return { ok: true, value: { agents: [] } }
        if (endpoint === 'ui/delegate') return { ok: false, error: { code: 'unknown_endpoint', message: 'no' } }
        return { ok: true, value: {} }
      },
      (zh) => zh,
    )
    await older.resync()
    expect(older.getSnapshot().delegate).toBeUndefined()
  })
})
