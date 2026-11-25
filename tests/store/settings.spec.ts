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
          return { ok: true, value: { deadlines: { permissionTimeoutMs: 30_000, elicitationTimeoutMs: 0, mode: 'auto', configured: { permissionTimeoutMs: 600_000 } } } }
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

    // The form-question window uses the same optimistic write path.
    await store.setElicitationDeadline(0)
    expect(sent[2]).toEqual({ elicitationTimeoutMs: 0 })
    expect(store.getSnapshot().approvalDeadlines).toMatchObject({ elicitationTimeoutMs: 0 })

    // `reset` is its own payload, not a deadline.
    await store.resetApprovalDeadlines()
    expect(sent[3]).toEqual({ reset: true })

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

  it('keeps only the newest approval-deadline answer when writes finish out of order', async () => {
    const pending = new Map<number, (answer: unknown) => void>()
    const store = new AcpStore(async (_channel, endpoint, payload) => {
      if (endpoint === 'agents/list') return { ok: true, value: { agents: [] } }
      if (endpoint === 'sessions/list') return { ok: true, value: { sessions: [] } }
      if (endpoint === 'agents/detect') return { ok: true, value: { agents: [] } }
      if (endpoint === 'ui/approval-deadlines') {
        return { ok: true, value: { deadlines: { permissionTimeoutMs: 300_000, elicitationTimeoutMs: 300_000, mode: 'wait' } } }
      }
      if (endpoint === 'ui/approval-deadlines-set') {
        const patch = payload as { elicitationTimeoutMs?: number }
        return await new Promise(resolve => { pending.set(patch.elicitationTimeoutMs ?? 0, resolve) })
      }
      return { ok: true, value: {} }
    }, zh => zh)
    await store.resync()
    const older = store.setElicitationDeadline(30_000)
    const newer = store.setElicitationDeadline(60_000)
    pending.get(60_000)?.({ ok: true, value: { deadlines: { permissionTimeoutMs: 300_000, elicitationTimeoutMs: 60_000, mode: 'wait' } } })
    await newer
    expect(store.getSnapshot().approvalDeadlines?.elicitationTimeoutMs).toBe(60_000)
    pending.get(30_000)?.({ ok: true, value: { deadlines: { permissionTimeoutMs: 300_000, elicitationTimeoutMs: 30_000, mode: 'wait' } } })
    await older
    expect(store.getSnapshot().approvalDeadlines?.elicitationTimeoutMs).toBe(60_000)

    const staleFailure = store.setElicitationDeadline(90_000)
    const latest = store.setElicitationDeadline(120_000)
    pending.get(120_000)?.({ ok: true, value: { deadlines: { permissionTimeoutMs: 300_000, elicitationTimeoutMs: 120_000, mode: 'wait' } } })
    await latest
    pending.get(90_000)?.({ ok: false, error: { code: 'bad_payload', message: 'late failure' } })
    await staleFailure
    expect(store.getSnapshot().approvalDeadlines?.elicitationTimeoutMs).toBe(120_000)
  })

  it('reads the delegate settings on resync, writes optimistically, and resets one key', async () => {
    const sent: Array<Record<string, unknown>> = []
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const seed = {
      guidance: 'on', timeoutMs: 900_000, defaultTimeoutMs: 2_400_000,
      configured: { guidance: 'off', timeoutMs: 300_000 }, toolAvailable: true, restrictAvailable: true,
    }
    // The host answer differs from the optimistic value: it is the authority.
    const answer = { ...seed, guidance: 'enhanced', timeoutMs: 600_000 }
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
    expect(store.getSnapshot().delegate).toMatchObject({ guidance: 'on', timeoutMs: 900_000 })

    // Only the touched key travels, and it moves before the host answers.
    const write = store.setDelegateSettings({ guidance: 'force' })
    expect(store.getSnapshot().delegate).toMatchObject({ guidance: 'force', timeoutMs: 900_000 })
    expect(sent).toEqual([{ guidance: 'force' }])
    release()
    await write
    expect(store.getSnapshot().delegate).toMatchObject({ guidance: 'enhanced', timeoutMs: 600_000 })

    // A reset is per key: the optimistic fallback is the config file's value…
    const resetWindow = store.resetDelegateSetting('timeoutMs')
    expect(store.getSnapshot().delegate?.timeoutMs).toBe(300_000)
    expect(sent[1]).toEqual({ reset: ['timeoutMs'] })
    await resetWindow
    expect(store.getSnapshot().delegate).toMatchObject(answer)
  })

  it('reverts a refused delegate write and keeps the card hidden on an older host', async () => {
    const seed = { guidance: 'on', timeoutMs: 600_000, defaultTimeoutMs: 2_400_000, toolAvailable: true, restrictAvailable: true }
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

// T3: the delegation-defaults axes (defaultAgent / agentDefaults) ride the same
// optimistic-then-authority write path. These pin the optimistic merge, the new
// reset baselines, and the whole-view revert on a refused write.
describe('AcpStore delegate defaults writes', () => {
  const BASE = { guidance: 'on', timeoutMs: 900_000, defaultTimeoutMs: 2_400_000, toolAvailable: true, restrictAvailable: true }

  /** A store whose `ui/delegate-set` answers via `onSet` (recording payloads). */
  function makeDelegateStore(seed: Record<string, unknown>, onSet: (payload: any) => any) {
    const sent: Array<Record<string, unknown>> = []
    const store = new AcpStore(
      async (_channel, endpoint, payload) => {
        if (endpoint === 'agents/list') return { ok: true, value: { agents: [] } }
        if (endpoint === 'sessions/list') return { ok: true, value: { sessions: [] } }
        if (endpoint === 'agents/detect') return { ok: true, value: { agents: [] } }
        if (endpoint === 'ui/delegate') return { ok: true, value: { delegate: seed } }
        if (endpoint === 'ui/delegate-set') { sent.push(payload as Record<string, unknown>); return onSet(payload) }
        return { ok: true, value: {} }
      },
      (zh) => zh,
    )
    return { store, sent }
  }
  const echo = (seed: Record<string, unknown>) => (payload: any) => {
    let next: any = { ...seed }
    if (payload.defaultAgent !== undefined) next.defaultAgent = payload.defaultAgent
    if (payload.agentDefaults !== undefined) {
      const merged = { ...(seed.agentDefaults ?? {}) }
      for (const [id, entry] of Object.entries(payload.agentDefaults)) {
        if (entry === null) delete merged[id]
        else merged[id] = entry
      }
      next.agentDefaults = merged
    }
    for (const key of payload.reset ?? []) {
      if (key === 'defaultAgent') next.defaultAgent = seed.configured?.defaultAgent
      if (key === 'agentDefaults') next.agentDefaults = seed.configured?.agentDefaults ?? {}
    }
    // Host view hygiene (delegateSettingsView): an empty map is NO key.
    if (next.agentDefaults !== undefined && Object.keys(next.agentDefaults).length === 0) delete next.agentDefaults
    next.resolvedDefaultAgent = next.defaultAgent ?? seed.globalDefaultAgent
    return { ok: true, value: { delegate: next } }
  }

  it('merges defaultAgent and agentDefaults optimistically, then adopts the host answer', async () => {
    const seed = { ...BASE, globalDefaultAgent: 'pi', resolvedDefaultAgent: 'pi', agentDefaults: {} }
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const answer = { ...seed, defaultAgent: 'codebuddy', resolvedDefaultAgent: 'codebuddy', agentDefaults: { codebuddy: { model: 'm1' } } }
    const { store, sent } = makeDelegateStore(seed, async () => { await gate; return { ok: true, value: { delegate: answer } } })
    await store.resync()

    const write = store.setDelegateSettings({ defaultAgent: 'codebuddy', agentDefaults: { codebuddy: { model: 'm1' } } })
    // Optimistic: the override and the derived「当前：X」move before the answer.
    expect(store.getSnapshot().delegate?.defaultAgent).toBe('codebuddy')
    expect(store.getSnapshot().delegate?.resolvedDefaultAgent).toBe('codebuddy')
    expect(store.getSnapshot().delegate?.agentDefaults).toEqual({ codebuddy: { model: 'm1' } })
    expect(sent).toEqual([{ defaultAgent: 'codebuddy', agentDefaults: { codebuddy: { model: 'm1' } } }])
    release()
    await write
    expect(store.getSnapshot().delegate).toMatchObject(answer)
  })

  it('merges per-agent entries by replacement: {} shadows, null deletes, absent keys stay', async () => {
    const seed = { ...BASE, agentDefaults: { a: { model: 'm' }, b: { mode: 'x' } } }
    const { store, sent } = makeDelegateStore(seed, echo(seed))
    await store.resync()
    await store.setDelegateSettings({ agentDefaults: { a: null, b: {}, c: { effort: 'high' } } })
    expect(sent).toEqual([{ agentDefaults: { a: null, b: {}, c: { effort: 'high' } } }])
    expect(store.getSnapshot().delegate?.agentDefaults).toEqual({ b: {}, c: { effort: 'high' } })
  })

  it('reset defaultAgent returns to the configured baseline, else follows the global default', async () => {
    const configured = { ...BASE, globalDefaultAgent: 'pi', defaultAgent: 'pi', resolvedDefaultAgent: 'pi', configured: { defaultAgent: 'codebuddy' } }
    const withFile = makeDelegateStore(configured, echo(configured))
    await withFile.store.resync()
    await withFile.store.resetDelegateSetting('defaultAgent')
    expect(withFile.sent).toEqual([{ reset: ['defaultAgent'] }])
    expect(withFile.store.getSnapshot().delegate?.defaultAgent).toBe('codebuddy')
    expect(withFile.store.getSnapshot().delegate?.resolvedDefaultAgent).toBe('codebuddy')

    const noFile = { ...BASE, globalDefaultAgent: 'pi', defaultAgent: 'codebuddy', resolvedDefaultAgent: 'codebuddy' }
    const bare = makeDelegateStore(noFile, echo(noFile))
    await bare.store.resync()
    await bare.store.resetDelegateSetting('defaultAgent')
    expect(bare.store.getSnapshot().delegate?.defaultAgent).toBeUndefined()
    expect(bare.store.getSnapshot().delegate?.resolvedDefaultAgent).toBe('pi')
  })

  it('reset agentDefaults returns to the configured map, else no map key', async () => {
    const configured = { ...BASE, agentDefaults: { a: { model: 'm' } }, configured: { agentDefaults: { a: { mode: 'x' } } } }
    const withFile = makeDelegateStore(configured, echo(configured))
    await withFile.store.resync()
    await withFile.store.resetDelegateSetting('agentDefaults')
    expect(withFile.sent).toEqual([{ reset: ['agentDefaults'] }])
    expect(withFile.store.getSnapshot().delegate?.agentDefaults).toEqual({ a: { mode: 'x' } })

    const noFile = { ...BASE, agentDefaults: { a: { model: 'm' } } }
    const bare = makeDelegateStore(noFile, echo(noFile))
    await bare.store.resync()
    await bare.store.resetDelegateSetting('agentDefaults')
    // The host view omits an empty map — the optimistic view must not invent
    // an `agentDefaults: {}` key the host would never report.
    expect(bare.store.getSnapshot().delegate?.agentDefaults).toBeUndefined()
    expect(Object.hasOwn(bare.store.getSnapshot().delegate ?? {}, 'agentDefaults')).toBe(false)
  })

  it('deleting the last entry drops the agentDefaults key optimistically (host parity)', async () => {
    const seed = { ...BASE, agentDefaults: { a: { model: 'm' } } }
    const { store, sent } = makeDelegateStore(seed, echo(seed))
    await store.resync()
    const write = store.setDelegateSettings({ agentDefaults: { a: null } })
    // Before the host answers: the optimistic view already has the host shape.
    expect(store.getSnapshot().delegate?.agentDefaults).toBeUndefined()
    expect(Object.hasOwn(store.getSnapshot().delegate ?? {}, 'agentDefaults')).toBe(false)
    expect(sent).toEqual([{ agentDefaults: { a: null } }])
    await write
    expect(Object.hasOwn(store.getSnapshot().delegate ?? {}, 'agentDefaults')).toBe(false)
  })

  it('a lone {} entry is a valid all-default override and keeps its key', async () => {
    const seed = { ...BASE, agentDefaults: { a: { model: 'm' }, b: { mode: 'x' } } }
    const { store } = makeDelegateStore(seed, echo(seed))
    await store.resync()
    await store.setDelegateSettings({ agentDefaults: { a: {}, b: null } })
    // The {} ENTRY survives (it shadows the baseline); only an empty MAP
    // loses the key — the two must not be conflated.
    expect(store.getSnapshot().delegate?.agentDefaults).toEqual({ a: {} })
    expect(Object.hasOwn(store.getSnapshot().delegate ?? {}, 'agentDefaults')).toBe(true)
  })

  it('reverts the whole delegate view when a defaults write is refused', async () => {
    const seed = { ...BASE, globalDefaultAgent: 'pi', defaultAgent: 'codebuddy', resolvedDefaultAgent: 'codebuddy', agentDefaults: { a: { model: 'm' } } }
    const { store } = makeDelegateStore(seed, () => ({ ok: false, error: { code: 'bad_payload', message: 'no' } }))
    await store.resync()
    await store.setDelegateSettings({ defaultAgent: 'pi', agentDefaults: { a: null } })
    expect(store.getSnapshot().delegate).toEqual(seed)
    expect(store.getSnapshot().notice).toBe('no')
  })
})
