/**
 * The save gate and its page-top banners (split plan P3b): the gate reads,
 * the flush/cancel/retry gestures and the row rules behind each banner.
 * Moved verbatim out of `tests/store.spec.ts`, which still drives the same
 * facade — the service is reached through `AcpStore`.
 */

import { describe, expect, it, vi } from 'vitest'
import { AcpStore, composeSaveBanners, type RpcCall, type SaveBanner } from '../../src/client/store.ts'
describe('save gate store state', () => {
  it('renders a pending save from the host frame and flushes it through the RPC', async () => {
    const calls: Array<{ endpoint: string; payload: unknown }> = []
    const pendingStatus = {
      canSave: false,
      activeTurns: 1,
      activeSessions: [{ sessionId: 'acp-1', agentId: 'codebuddy' }],
      pending: [{ id: 'save-1', label: 'settings:llm-pi-ai', queuedAt: 1, deadlineAt: 600_001 }],
      timeoutMs: 600_000,
    }
    const store = new AcpStore(async (_channel, endpoint, payload) => {
      calls.push({ endpoint, payload })
      if (endpoint === 'save/flush') return { ok: true, value: { saved: 1, expired: 0, failed: 0 } }
      if (endpoint === 'save/status') {
        return { ok: true, value: { status: { ...pendingStatus, canSave: true, activeTurns: 0, activeSessions: [], pending: [] } } }
      }
      return { ok: true, value: {} }
    }, (zh) => zh)

    await (store as unknown as { applyEvent(event: unknown): Promise<void> }).applyEvent({
      type: 'save/status',
      status: pendingStatus,
    })

    const snapshot = store.getSnapshot()
    expect(snapshot.saveGate.pending).toHaveLength(1)
    expect(snapshot.logs.some(entry => entry.text.includes('配置已暂存'))).toBe(true)

    await expect(store.forceSaveGate()).resolves.toEqual({ saved: 1, expired: 0, failed: 0 })
    expect(calls.map(call => call.endpoint)).toEqual(['save/flush', 'save/status'])
    expect(store.getSnapshot().saveGate.pending).toEqual([])
    expect(store.getSnapshot().saveGate.canSave).toBe(true)
  })

  it('forces one agent without routing through the global save/flush', async () => {
    const calls: string[] = []
    const store = new AcpStore(async (_channel, endpoint) => {
      calls.push(endpoint)
      if (endpoint === 'agent/save') return { ok: true, value: { saved: true } }
      return { ok: true, value: {} }
    }, (zh) => zh)

    await store.saveAgent({ id: 'pi', command: 'pi-acp' }, 'force')

    expect(calls).toContain('agent/save')
    // Regression guard: one agent's "save now" must never flush every held label.
    expect(calls).not.toContain('save/flush')
  })

  it('saves every held label in one explicit flush and names them in the success row', async () => {
    const calls: string[] = []
    const held = {
      canSave: false,
      activeTurns: 2,
      activeSessions: [
        { sessionId: 'acp-1', agentId: 'codebuddy' },
        { sessionId: 'acp-2', agentId: 'pi' },
      ],
      pending: [
        { id: 'save-1', label: 'agent-save:codebuddy', queuedAt: 1, deadlineAt: 600_001 },
        { id: 'save-2', label: 'agent-save:pi', queuedAt: 2, deadlineAt: 600_002 },
      ],
      timeoutMs: 600_000,
    }
    const settled = {
      ...held,
      canSave: true,
      activeTurns: 0,
      activeSessions: [],
      pending: [],
      lastOutcomes: {
        'agent-save:codebuddy': { at: 10, status: 'saved', label: 'agent-save:codebuddy' },
        'agent-save:pi': { at: 11, status: 'saved', label: 'agent-save:pi' },
      },
    }
    const store = new AcpStore(async (_channel, endpoint) => {
      calls.push(endpoint)
      if (endpoint === 'save/flush') return { ok: true, value: { saved: 2, expired: 0, failed: 0 } }
      if (endpoint === 'save/status') return { ok: true, value: { status: settled } }
      return { ok: true, value: {} }
    }, (zh) => zh)
    await (store as unknown as { applyEvent(event: unknown): Promise<void> }).applyEvent({
      type: 'save/status',
      status: held,
    })

    await expect(store.forceSaveGate()).resolves.toEqual({ saved: 2, expired: 0, failed: 0 })

    expect(calls.filter(endpoint => endpoint === 'save/flush')).toHaveLength(1)
    const success = store.getSnapshot().saveBanners.find(entry => entry.source === 'save-succeeded')
    expect(success?.body).toContain('CodeBuddy')
    expect(success?.body).toContain('Pi Coding Agent')
    expect(store.getSnapshot().saveGate.pending).toEqual([])
  })

  it('names the failed labels when an explicit flush only partly completes', async () => {
    const held = {
      canSave: false,
      activeTurns: 2,
      activeSessions: [
        { sessionId: 'acp-1', agentId: 'alpha' },
        { sessionId: 'acp-2', agentId: 'beta' },
      ],
      pending: [
        { id: 'save-1', label: 'agent-save:alpha', queuedAt: 1, deadlineAt: 600_001 },
        { id: 'save-2', label: 'agent-save:beta', queuedAt: 2, deadlineAt: 600_002 },
      ],
      timeoutMs: 600_000,
    }
    const settled = {
      ...held,
      canSave: true,
      activeTurns: 0,
      activeSessions: [],
      pending: [],
      lastOutcomes: {
        'agent-save:alpha': { at: 10, status: 'saved', label: 'agent-save:alpha' },
        'agent-save:beta': { at: 11, status: 'failed', label: 'agent-save:beta', message: 'revision conflict' },
      },
    }
    const store = new AcpStore(async (_channel, endpoint) => {
      if (endpoint === 'save/flush') return { ok: true, value: { saved: 1, expired: 0, failed: 1 } }
      if (endpoint === 'save/status') return { ok: true, value: { status: settled } }
      return { ok: true, value: {} }
    }, (zh) => zh)
    await (store as unknown as { applyEvent(event: unknown): Promise<void> }).applyEvent({
      type: 'save/status',
      status: held,
    })

    await expect(store.forceSaveGate()).resolves.toEqual({ saved: 1, expired: 0, failed: 1 })

    const partial = store.getSnapshot().saveBanners.find(entry => entry.source === 'save-partial')
    expect(partial?.body).toContain('失败 1 项')
    expect(partial?.body).toContain('agent-save:beta')
    expect(partial?.body).not.toContain('agent-save:alpha')
  })

  it('records an expired held save as an error, not as a silent success', async () => {
    const store = new AcpStore(async () => ({ ok: true, value: {} }), (zh) => zh)
    await (store as unknown as { applyEvent(event: unknown): Promise<void> }).applyEvent({
      type: 'save/status',
      status: {
        canSave: false,
        activeTurns: 1,
        activeSessions: [{ sessionId: 'acp-1', agentId: 'codebuddy' }],
        pending: [],
        timeoutMs: 600_000,
        lastOutcome: { at: 2, status: 'expired', label: 'settings:llm-pi-ai' },
      },
    })
    expect(store.getSnapshot().logs.some(entry => entry.level === 'error' && entry.text.includes('等待超时'))).toBe(true)
  })

  it('cancels one held label through the save/cancel RPC', async () => {
    const calls: Array<{ endpoint: string; payload: unknown }> = []
    const store = new AcpStore(async (_channel, endpoint, payload) => {
      calls.push({ endpoint, payload })
      if (endpoint === 'save/cancel') return { ok: true, value: { cancelled: 1 } }
      return { ok: true, value: {} }
    }, (zh) => zh)
    await expect(store.cancelSaveGate('agent-save:codebuddy')).resolves.toBe(true)
    expect(calls).toEqual([{ endpoint: 'save/cancel', payload: { label: 'agent-save:codebuddy' } }])
  })

  it('logs per-label settlements without one agent erasing another agent\'s result', async () => {
    const store = new AcpStore(async () => ({ ok: true, value: {} }), (zh) => zh)
    const emit = async (status: Record<string, unknown>): Promise<void> => {
      await (store as unknown as { applyEvent(event: unknown): Promise<void> }).applyEvent({ type: 'save/status', status })
    }
    const pendingAlpha = {
      canSave: false,
      activeTurns: 1,
      activeSessions: [{ sessionId: 'acp-alpha', agentId: 'alpha' }],
      pending: [{ id: 'save-1', label: 'agent-save:alpha', queuedAt: 1 }],
      timeoutMs: 600_000,
    }
    await emit(pendingAlpha)
    // Another agent settles first: its outcome must not clear alpha's pending
    // state or produce a "saved" line for alpha.
    await emit({ ...pendingAlpha, lastOutcomes: { 'agent-save:beta': { at: 2, status: 'saved', label: 'agent-save:beta' } } })
    expect(store.getSnapshot().saveGate.lastOutcomes?.['agent-save:beta']).toMatchObject({ status: 'saved' })
    expect(store.getSnapshot().logs.some(entry => entry.text.includes('配置已保存'))).toBe(false)
    // Alpha's own settlement arrives under its label.
    await emit({
      ...pendingAlpha,
      pending: [],
      canSave: true,
      activeTurns: 0,
      activeSessions: [],
      lastOutcomes: {
        'agent-save:alpha': { at: 3, status: 'saved', label: 'agent-save:alpha' },
        'agent-save:beta': { at: 2, status: 'saved', label: 'agent-save:beta' },
      },
    })
    expect(store.getSnapshot().saveGate.lastOutcomes?.['agent-save:alpha']).toMatchObject({ status: 'saved' })
    expect(store.getSnapshot().saveGate.lastOutcomes?.['agent-save:beta']).toMatchObject({ status: 'saved' })
    expect(store.getSnapshot().logs.filter(entry => entry.text.includes('配置已保存'))).toHaveLength(1)
  })

  it('does not treat a malformed save/cancel answer as a success', async () => {
    const pending = {
      canSave: false,
      gateAvailable: true,
      activeTurns: 1,
      activeSessions: [{ sessionId: 'acp-1', agentId: 'pi' }],
      pending: [{ id: 'save-1', label: 'agent-save:pi', queuedAt: 1 }],
      timeoutMs: 600_000,
    }
    const store = new AcpStore(async (_channel, endpoint) => {
      if (endpoint === 'save/cancel') return { ok: true, value: {} }
      return { ok: true, value: {} }
    }, (zh) => zh)
    await (store as unknown as { applyEvent(event: unknown): Promise<void> }).applyEvent({ type: 'save/status', status: pending })

    await expect(store.cancelSaveGate('agent-save:pi')).resolves.toBe(false)
    expect(store.getSnapshot().saveGate.pending).toHaveLength(1)
    expect(store.getSnapshot().saveBanners.find(row => row.key === 'save-cancel-failed:agent-save:pi'))
      .toMatchObject({ level: 'error', actions: ['retry', 'dismiss'] })
  })

  it('confirms cancellation from a matching terminal outcome when the count races to zero', async () => {
    const idle = {
      canSave: true,
      gateAvailable: true,
      activeTurns: 0,
      activeSessions: [],
      pending: [],
      timeoutMs: 600_000,
      lastOutcomes: { 'agent-save:pi': { at: 7, status: 'cancelled' as const, label: 'agent-save:pi' } },
    }
    const store = new AcpStore(async (_channel, endpoint) => {
      if (endpoint === 'save/cancel') return { ok: true, value: { cancelled: 0 } }
      if (endpoint === 'save/status') return { ok: true, value: { status: idle } }
      return { ok: true, value: {} }
    }, (zh) => zh)

    await expect(store.cancelSaveGate('agent-save:pi')).resolves.toBe(true)
    expect(store.getSnapshot().saveGate.pending).toEqual([])
    expect(store.getSnapshot().saveBanners.some(row => row.key === 'save-cancel-failed:agent-save:pi')).toBe(false)
  })

  it('ignores superseded and still-pending cancelled outcomes', async () => {
    const store = new AcpStore(async () => ({ ok: true, value: {} }), (zh) => zh)
    const emit = async (status: Record<string, unknown>): Promise<void> => {
      await (store as unknown as { applyEvent(event: unknown): Promise<void> }).applyEvent({ type: 'save/status', status })
    }
    const pending = {
      canSave: false,
      gateAvailable: true,
      activeTurns: 1,
      activeSessions: [{ sessionId: 'acp-1', agentId: 'pi' }],
      pending: [{ id: 'save-1', label: 'agent-save:pi', queuedAt: 1 }],
      timeoutMs: 600_000,
    }
    await emit(pending)
    await emit({
      ...pending,
      pending: [],
      lastOutcomes: {
        'agent-save:pi': { at: 5, status: 'cancelled', label: 'agent-save:pi', superseded: true },
      },
    })
    expect(store.getSnapshot().logs.some(entry => entry.text.includes('配置暂存已取消'))).toBe(false)

    // A cancelled row that shares the snapshot with a still-queued label is
    // the previous write's settlement, not this one's terminal state.
    await emit({
      ...pending,
      lastOutcomes: {
        'agent-save:pi': { at: 6, status: 'cancelled', label: 'agent-save:pi' },
      },
    })
    expect(store.getSnapshot().logs.some(entry => entry.text.includes('配置暂存已取消'))).toBe(false)
    expect(store.getSnapshot().saveGate.pending).toHaveLength(1)
  })
})

describe('save banners', () => {
  async function emit(store: AcpStore, event: unknown): Promise<void> {
    await (store as unknown as { applyEvent(event: unknown): Promise<void> }).applyEvent(event)
  }

  function createStore(handler?: (endpoint: string, payload: unknown) => Promise<unknown> | unknown): AcpStore {
    return new AcpStore(async (_channel, endpoint, payload) => {
      const value = handler === undefined ? { done: true } : await handler(endpoint, payload)
      return { ok: true, value: value ?? {} }
    }, (zh) => zh)
  }

  it('turns a failed gate outcome into a persistent retryable banner', async () => {
    const store = createStore()
    const status = {
      canSave: true,
      activeTurns: 0,
      activeSessions: [],
      pending: [],
      timeoutMs: 600_000,
      lastOutcomes: { 'settings:llm-pi-ai': { at: 5, status: 'failed', label: 'settings:llm-pi-ai', message: 'revision conflict' } },
    }
    await emit(store, { type: 'save/status', status })
    const banner = store.getSnapshot().saveBanners.find(entry => entry.key === 'save-failed:settings:llm-pi-ai')
    expect(banner).toMatchObject({ source: 'save-failed', level: 'error', actions: ['retry', 'dismiss'] })
    expect(banner?.body).toContain('revision conflict')
    expect(banner?.autoDismissMs).toBeUndefined()
    // The same reason replaces its row instead of stacking.
    await emit(store, { type: 'save/status', status })
    expect(store.getSnapshot().saveBanners.filter(entry => entry.key === 'save-failed:settings:llm-pi-ai')).toHaveLength(1)
  })

  it('shows a success banner for a held write and never for an immediate save', async () => {
    const store = createStore()
    const idle = { canSave: true, activeTurns: 0, activeSessions: [], pending: [], timeoutMs: 600_000 }
    // An immediate save (never in the queue) is silent: the form reports it.
    await emit(store, {
      type: 'save/status',
      status: {
        ...idle,
        lastOutcomes: { 'settings:llm-pi-ai': { at: 6, status: 'saved', label: 'settings:llm-pi-ai' } },
      },
    })
    expect(store.getSnapshot().saveBanners).toEqual([])

    // A held write earns the global receipt when it settles.
    await emit(store, {
      type: 'save/status',
      status: {
        ...idle,
        canSave: false,
        activeTurns: 1,
        activeSessions: [{ sessionId: 'acp-1', agentId: 'codebuddy' }],
        pending: [{ id: 'save-1', label: 'settings:llm-pi-ai', queuedAt: 1 }],
      },
    })
    await emit(store, {
      type: 'save/status',
      status: {
        ...idle,
        lastOutcomes: { 'settings:llm-pi-ai': { at: 6, status: 'saved', label: 'settings:llm-pi-ai' } },
      },
    })
    expect(store.getSnapshot().saveBanners.find(entry => entry.key === 'save-succeeded'))
      .toMatchObject({ level: 'success', autoDismissMs: 2500, actions: ['dismiss'] })
    store.dismissBanner('save-succeeded')
    expect(store.getSnapshot().saveBanners).toEqual([])

    const failed = {
      canSave: false,
      activeTurns: 1,
      activeSessions: [{ sessionId: 'acp-1', agentId: 'codebuddy' }],
      pending: [],
      timeoutMs: 600_000,
      lastOutcomes: { 'settings:llm-pi-ai': { at: 7, status: 'failed', label: 'settings:llm-pi-ai', message: 'again' } },
    }
    await emit(store, { type: 'save/status', status: failed })
    expect(store.getSnapshot().saveBanners).toHaveLength(1)
    store.dismissBanner('save-failed:settings:llm-pi-ai')
    expect(store.getSnapshot().saveBanners).toEqual([])
    // A later failure with the same key must appear again.
    await emit(store, {
      type: 'save/status',
      status: { ...failed, lastOutcomes: { 'settings:llm-pi-ai': { at: 8, status: 'failed', label: 'settings:llm-pi-ai', message: 'later' } } },
    })
    expect(store.getSnapshot().saveBanners).toHaveLength(1)
  })

  it('surfaces the HMR reload delay from agent/notice as an alert banner', async () => {
    const store = createStore()
    await emit(store, {
      type: 'agent/notice',
      agentId: 'hmr',
      level: 'info',
      text: 'acp: hmr reconcile is still deferred after 60s: the ACP turn has not ended.',
    })
    expect(store.getSnapshot().saveBanners.find(entry => entry.key === 'hmr-delay'))
      .toMatchObject({ source: 'hmr-delay', level: 'error', actions: ['dismiss'] })
    expect(store.getSnapshot().saveBanners[0]?.body).toContain('热重载')
  })

  it('shows an expiry banner and a partial force-flush banner', async () => {
    const store = createStore(endpoint => {
      if (endpoint === 'save/flush') return { saved: 1, expired: 1, failed: 1 }
      return { done: true }
    })
    await emit(store, {
      type: 'save/status',
      status: {
        canSave: false,
        activeTurns: 1,
        activeSessions: [{ sessionId: 'acp-1', agentId: 'codebuddy' }],
        pending: [{ id: 'save-1', label: 'agent-save:alpha', queuedAt: 1 }],
        timeoutMs: 600_000,
        lastOutcomes: { 'agent-save:alpha': { at: 5, status: 'expired', label: 'agent-save:alpha' } },
      },
    })
    const expired = store.getSnapshot().saveBanners.find(entry => entry.source === 'save-expired')
    expect(expired).toMatchObject({ level: 'error', actions: ['retry', 'force', 'dismiss'] })

    await store.forceSaveGate()
    const partial = store.getSnapshot().saveBanners.find(entry => entry.source === 'save-partial')
    expect(partial).toMatchObject({ level: 'error', actions: ['retry', 'dismiss'] })
    expect(partial?.body).toContain('失败 1 项')
  })

  it('retries the retained gate write from the banner action', async () => {
    const calls: string[] = []
    const store = createStore(endpoint => {
      calls.push(endpoint)
      if (endpoint === 'save/retry') return { retried: true }
      if (endpoint === 'save/status') {
        return {
          status: {
            canSave: true,
            activeTurns: 0,
            activeSessions: [],
            pending: [],
            timeoutMs: 600_000,
          },
        }
      }
      return { done: true }
    })
    await emit(store, {
      type: 'save/status',
      status: {
        canSave: true,
        activeTurns: 0,
        activeSessions: [],
        pending: [],
        timeoutMs: 600_000,
        lastOutcomes: {
          'settings:llm-pi-ai': { at: 5, status: 'failed', label: 'settings:llm-pi-ai', message: 'conflict' },
        },
      },
    })
    await store.retryBanner('save-failed:settings:llm-pi-ai')
    expect(calls).toContain('save/retry')
    expect(calls).not.toContain('save/flush')
    expect(store.getSnapshot().saveBanners.some(banner => banner.key === 'save-failed:settings:llm-pi-ai')).toBe(false)
  })

  it('reports a refused legacy save with retry and force actions', async () => {
    const store = createStore(endpoint => {
      if (endpoint === 'agent/save') {
        return Promise.reject(Object.assign(new Error('the agent has running turns'), { code: 'confirmation_required' }))
      }
      return { done: true }
    })
    // The test RPC adapter answers `ok:false` for a rejected promise.
    await expect(store.saveAgent({ id: 'pi', command: 'pi-acp' }, 'direct')).rejects.toThrow()
    const banner = store.getSnapshot().saveBanners.find(entry => entry.key === 'save-rejected:pi')
    expect(banner).toMatchObject({ source: 'save-rejected', actions: ['retry', 'force', 'dismiss'], title: '保存被拒绝' })
  })

  it('never drops a failure row and keeps at most one success row', async () => {
    const failure = (key: string, at: number): SaveBanner => ({
      key, source: 'save-failed', level: 'error', title: key, body: key, at, actions: ['dismiss'],
    })
    const success = (key: string, at: number): SaveBanner => ({
      key, source: 'save-cancelled', level: 'success', title: key, body: key, at, actions: ['dismiss'], autoDismissMs: 2500,
    })
    let rows = [failure('a', 1), failure('b', 2)]
    rows = composeSaveBanners(rows, success('s1', 3))
    rows = composeSaveBanners(rows, success('s2', 4))
    expect(rows.filter(row => row.level === 'error').map(row => row.key)).toEqual(['a', 'b'])
    expect(rows.filter(row => row.level === 'success')).toHaveLength(1)
    expect(rows[rows.length - 1]?.key).toBe('s2')

    const store = createStore()
    const idle = { canSave: true, activeTurns: 0, activeSessions: [], pending: [], timeoutMs: 600_000 }
    for (let index = 0; index < 7; index += 1) {
      const label = `settings:x${String(index)}`
      await emit(store, {
        type: 'save/status',
        status: { ...idle, lastOutcomes: { [label]: { at: index + 1, status: 'failed', label, message: 'x' } } },
      })
    }
    expect(store.getSnapshot().saveBanners.filter(row => row.level === 'error')).toHaveLength(7)
  })

  it('rebuilds a terminal banner during resync so a refresh does not lose it', async () => {
    const status = {
      canSave: true,
      activeTurns: 0,
      activeSessions: [],
      pending: [{ id: 'save-1', label: 'settings:llm-pi-ai', queuedAt: 1 }],
      timeoutMs: 600_000,
      lastOutcomes: { 'agent-save:pi': { at: 9, status: 'failed', label: 'agent-save:pi', message: 'deleted' } },
    }
    const store = new AcpStore(async (_channel, endpoint) => {
      if (endpoint === 'agents/list') return { ok: true, value: { agents: [] } }
      if (endpoint === 'sessions/list') return { ok: true, value: { sessions: [] } }
      if (endpoint === 'agents/detect') return { ok: true, value: { agents: [] } }
      if (endpoint === 'save/status') return { ok: true, value: { status } }
      return { ok: true, value: {} }
    }, (zh) => zh)
    await store.resync()
    expect(store.getSnapshot().saveBanners.find(row => row.key === 'save-failed:agent-save:pi'))
      .toMatchObject({ source: 'save-failed', level: 'error', actions: ['retry', 'dismiss'] })
    // A held entry that already existed before the refresh is not a new event.
    expect(store.getSnapshot().logs.some(entry => entry.text.includes('配置已暂存'))).toBe(false)
  })

  it('does not rebuild a gate failure closed before a refresh, but rebuilds an unclosed one', async () => {
    const backing = new Map<string, string>()
    const storage = {
      get length() { return backing.size },
      clear: () => { backing.clear() },
      getItem: (key: string) => backing.get(key) ?? null,
      key: (index: number) => [...backing.keys()][index] ?? null,
      removeItem: (key: string) => { backing.delete(key) },
      setItem: (key: string, value: string) => { backing.set(key, value) },
    } as Storage
    vi.stubGlobal('sessionStorage', storage)
    try {
      const status = {
        canSave: true,
        gateAvailable: true,
        activeTurns: 0,
        activeSessions: [],
        pending: [],
        timeoutMs: 600_000,
        lastOutcomes: {
          'agent-save:alpha': { at: 11, status: 'failed' as const, label: 'agent-save:alpha', message: 'alpha failed' },
          'agent-save:beta': { at: 12, status: 'failed' as const, label: 'agent-save:beta', message: 'beta failed' },
        },
      }
      const rpc: RpcCall = async (_channel, endpoint) => {
        if (endpoint === 'agents/list') return { ok: true, value: { agents: [] } }
        if (endpoint === 'sessions/list') return { ok: true, value: { sessions: [] } }
        if (endpoint === 'agents/detect') return { ok: true, value: { agents: [] } }
        if (endpoint === 'save/status') return { ok: true, value: { status } }
        return { ok: true, value: {} }
      }

      const first = new AcpStore(rpc, (zh) => zh)
      await first.resync()
      expect(first.getSnapshot().saveBanners.map(row => row.key)).toEqual([
        'save-failed:agent-save:alpha',
        'save-failed:agent-save:beta',
      ])
      first.dismissBanner('save-failed:agent-save:alpha')

      // A new store simulates the page reload; sessionStorage carries the
      // closed-row record into it.
      const second = new AcpStore(rpc, (zh) => zh)
      await second.resync()
      expect(second.getSnapshot().saveBanners.map(row => row.key)).toEqual(['save-failed:agent-save:beta'])
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('seeds the first SSE frame after a refresh without reviving a closed failure or expiry', async () => {
    const backing = new Map<string, string>()
    const storage = {
      get length() { return backing.size },
      clear: () => { backing.clear() },
      getItem: (key: string) => backing.get(key) ?? null,
      key: (index: number) => [...backing.keys()][index] ?? null,
      removeItem: (key: string) => { backing.delete(key) },
      setItem: (key: string, value: string) => { backing.set(key, value) },
    } as Storage
    backing.set('dsh-ntr.save-banner-dismissals', JSON.stringify({
      'save-failed:agent-save:alpha': 11,
      'save-expired:agent-save:gamma': 12,
    }))
    vi.stubGlobal('sessionStorage', storage)
    try {
      const store = createStore()
      const status = {
        canSave: true,
        gateAvailable: true,
        activeTurns: 0,
        activeSessions: [],
        pending: [],
        timeoutMs: 600_000,
        lastOutcomes: {
          'agent-save:alpha': { at: 11, status: 'failed' as const, label: 'agent-save:alpha', message: 'alpha failed' },
          'agent-save:gamma': { at: 12, status: 'expired' as const, label: 'agent-save:gamma' },
          'agent-save:beta': { at: 13, status: 'failed' as const, label: 'agent-save:beta', message: 'beta failed' },
        },
      }
      // The SSE frame lands before resync; it is still the host snapshot being
      // seeded, so the closed records must hold.
      await emit(store, { type: 'save/status', status })
      expect(store.getSnapshot().saveBanners.map(row => row.key)).toEqual(['save-failed:agent-save:beta'])

      // A genuinely new settlement carries a different `at`; closing an old row
      // must not swallow it.
      await emit(store, {
        type: 'save/status',
        status: {
          ...status,
          lastOutcomes: {
            ...status.lastOutcomes,
            'agent-save:alpha': { at: 14, status: 'failed' as const, label: 'agent-save:alpha', message: 'alpha failed again' },
          },
        },
      })
      expect(store.getSnapshot().saveBanners.map(row => row.key)).toEqual([
        'save-failed:agent-save:beta',
        'save-failed:agent-save:alpha',
      ])
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('keeps a success receipt when a failure arrives and names the agent', async () => {
    const store = createStore()
    const pending = {
      canSave: false,
      gateAvailable: true,
      activeTurns: 1,
      activeSessions: [
        { sessionId: 'acp-alpha', agentId: 'alpha' },
        { sessionId: 'acp-beta', agentId: 'beta' },
      ],
      pending: [
        { id: 'save-1', label: 'agent-save:alpha', queuedAt: 1 },
        { id: 'save-2', label: 'agent-save:beta', queuedAt: 2 },
      ],
      timeoutMs: 600_000,
    }
    await emit(store, { type: 'save/status', status: pending })
    await emit(store, {
      type: 'save/status',
      status: {
        ...pending,
        canSave: true,
        activeTurns: 0,
        activeSessions: [],
        pending: [],
        lastOutcomes: {
          'agent-save:alpha': { at: 20, status: 'saved', label: 'agent-save:alpha' },
          'agent-save:beta': { at: 21, status: 'failed', label: 'agent-save:beta', message: 'beta boom' },
        },
      },
    })
    const banners = store.getSnapshot().saveBanners
    expect(banners.find(row => row.key === 'save-succeeded')?.body).toContain('alpha')
    expect(banners.find(row => row.key === 'save-succeeded')?.body).toContain('已保存')
    expect(banners.find(row => row.key === 'save-failed:agent-save:beta')?.body).toContain('beta boom')
    // Both receipts are visible at once; the error did not evict the success.
    expect(banners).toHaveLength(2)
  })

  it('names every agent that saved in one frame in a single success row and logs each label', async () => {
    const store = createStore()
    const idle = { canSave: true, gateAvailable: true, activeTurns: 0, activeSessions: [], pending: [], timeoutMs: 600_000 }
    const pending = {
      ...idle,
      canSave: false,
      activeTurns: 1,
      activeSessions: [
        { sessionId: 'acp-alpha', agentId: 'alpha' },
        { sessionId: 'acp-beta', agentId: 'beta' },
      ],
      pending: [
        { id: 'save-1', label: 'agent-save:alpha', queuedAt: 1 },
        { id: 'save-2', label: 'agent-save:beta', queuedAt: 2 },
      ],
    }
    await emit(store, { type: 'save/status', status: pending })
    await emit(store, {
      type: 'save/status',
      status: {
        ...pending,
        canSave: true,
        activeTurns: 0,
        activeSessions: [],
        pending: [],
        lastOutcomes: {
          'agent-save:alpha': { at: 20, status: 'saved', label: 'agent-save:alpha' },
          'agent-save:beta': { at: 21, status: 'saved', label: 'agent-save:beta' },
        },
      },
    })
    const successes = store.getSnapshot().saveBanners.filter(row => row.key === 'save-succeeded')
    expect(successes).toHaveLength(1)
    expect(successes[0]?.body).toBe('已保存：alpha、beta。')
    const savedLogs = store.getSnapshot().logs
      .filter(entry => entry.text.includes('配置已保存'))
      .map(entry => entry.text)
    expect(savedLogs).toEqual([
      '配置已保存：agent-save:alpha。',
      '配置已保存：agent-save:beta。',
    ])
  })

  it('clears an agent\'s old failure receipts once its held save succeeds', async () => {
    const store = createStore()
    const idle = { canSave: true, gateAvailable: true, activeTurns: 0, activeSessions: [], pending: [], timeoutMs: 600_000 }
    const alpha = 'agent-save:alpha'
    const beta = 'agent-save:beta'
    const pending = {
      ...idle,
      canSave: false,
      activeTurns: 1,
      activeSessions: [
        { sessionId: 'acp-alpha', agentId: 'alpha' },
        { sessionId: 'acp-beta', agentId: 'beta' },
      ],
      pending: [{ id: 'save-1', label: alpha, queuedAt: 1 }],
      lastOutcomes: {
        [alpha]: { at: 5, status: 'failed' as const, label: alpha, message: 'old alpha failure' },
        [beta]: { at: 6, status: 'failed' as const, label: beta, message: 'beta failure' },
      },
    }
    await emit(store, { type: 'save/status', status: pending })
    expect(store.getSnapshot().saveBanners.map(row => row.key)).toEqual([
      'save-failed:agent-save:alpha',
      'save-failed:agent-save:beta',
    ])

    await emit(store, {
      type: 'save/status',
      status: {
        ...pending,
        canSave: true,
        activeTurns: 0,
        activeSessions: [],
        pending: [],
        lastOutcomes: {
          [alpha]: { at: 7, status: 'saved', label: alpha },
          [beta]: { at: 6, status: 'failed', label: beta, message: 'beta failure' },
        },
      },
    })
    const banners = store.getSnapshot().saveBanners
    expect(banners.some(row => row.key === 'save-failed:agent-save:alpha')).toBe(false)
    // Only the agent that succeeded loses its receipts.
    expect(banners.find(row => row.key === 'save-failed:agent-save:beta')?.body).toContain('beta failure')
    expect(banners.find(row => row.key === 'save-succeeded')?.body).toContain('alpha')
  })

  it('drops a stale cancelled receipt when a resync shows that label queued again', async () => {
    let cancelled = 0
    const idle = { canSave: true, gateAvailable: true, activeTurns: 0, activeSessions: [], pending: [], timeoutMs: 600_000 }
    const queued = {
      ...idle,
      canSave: false,
      activeTurns: 1,
      activeSessions: [{ sessionId: 'acp-1', agentId: 'pi' }],
      pending: [{ id: 'save-1', label: 'agent-save:pi', queuedAt: 1 }],
    }
    const store = new AcpStore(async (_channel, endpoint) => {
      if (endpoint === 'save/cancel') return { ok: true, value: { cancelled } }
      if (endpoint === 'save/status') return { ok: true, value: { status: queued } }
      if (endpoint === 'agents/list') return { ok: true, value: { agents: [] } }
      if (endpoint === 'sessions/list') return { ok: true, value: { sessions: [] } }
      if (endpoint === 'agents/detect') return { ok: true, value: { agents: [] } }
      return { ok: true, value: {} }
    }, (zh) => zh)

    await expect(store.cancelSaveGate('agent-save:pi')).resolves.toBe(false)
    cancelled = 1
    await store.retryBanner('save-cancel-failed:agent-save:pi')
    expect(store.getSnapshot().saveBanners.find(row => row.key === 'save-cancelled:agent-save:pi')).toBeDefined()

    await store.resync()
    expect(store.getSnapshot().saveBanners.some(row => row.key === 'save-cancelled:agent-save:pi')).toBe(false)
  })

  it('clears a deleted agent\'s failure rows and retry payloads', async () => {
    const calls: string[] = []
    const idle = { canSave: true, activeTurns: 0, activeSessions: [], pending: [], timeoutMs: 600_000 }
    const store = new AcpStore(async (_channel, endpoint) => {
      calls.push(endpoint)
      if (endpoint === 'agents/list') return { ok: true, value: { agents: [] } }
      if (endpoint === 'sessions/list') return { ok: true, value: { sessions: [] } }
      if (endpoint === 'agents/detect') return { ok: true, value: { agents: [] } }
      if (endpoint === 'save/status') return { ok: true, value: { status: idle } }
      if (endpoint === 'agent/save') return { ok: false, error: { code: 'write_failed', message: 'cannot write' } }
      return { ok: true, value: {} }
    }, (zh) => zh)
    await expect(store.saveAgent({ id: 'pi', command: 'pi-acp' }, 'direct')).rejects.toThrow('cannot write')
    expect(store.getSnapshot().saveBanners.map(row => row.key)).toContain('save-failed:pi')
    await emit(store, {
      type: 'save/status',
      status: {
        ...idle,
        lastOutcomes: { 'agent-save:pi': { at: 3, status: 'failed', label: 'agent-save:pi', message: 'write failed' } },
      },
    })
    expect(store.getSnapshot().saveBanners.map(row => row.key)).toContain('save-failed:agent-save:pi')

    await store.deleteAgent('pi')
    const keys = store.getSnapshot().saveBanners.map(row => row.key)
    expect(keys).not.toContain('save-failed:pi')
    expect(keys).not.toContain('save-failed:agent-save:pi')
    // The creation form reads this to warn before a doomed reuse.
    expect(store.getSnapshot().deletedAgentIds).toContain('pi')

    const savesBefore = calls.filter(endpoint => endpoint === 'agent/save').length
    await store.retryBanner('save-failed:pi')
    expect(calls.filter(endpoint => endpoint === 'agent/save')).toHaveLength(savesBefore)
  })

  it('does not escalate a gate retry with nothing to retry into a forced flush', async () => {
    const calls: string[] = []
    const store = createStore(endpoint => {
      calls.push(endpoint)
      if (endpoint === 'save/retry') return { retried: false }
      return { done: true }
    })
    await emit(store, {
      type: 'save/status',
      status: {
        canSave: true,
        activeTurns: 0,
        activeSessions: [],
        pending: [],
        timeoutMs: 600_000,
        lastOutcomes: {
          'settings:llm-pi-ai': { at: 5, status: 'failed', label: 'settings:llm-pi-ai', message: 'conflict' },
        },
      },
    })
    await store.retryBanner('save-failed:settings:llm-pi-ai')
    expect(calls).not.toContain('save/flush')
    expect(store.getSnapshot().saveBanners.find(row => row.key === 'save-retry-none:settings:llm-pi-ai'))
      .toMatchObject({ level: 'success', title: '已无待重试项' })
  })

  it('keeps the failed banner and reports the RPC error when save/retry throws', async () => {
    const store = createStore(endpoint => {
      if (endpoint === 'save/retry') return Promise.reject(new Error('retry transport exploded'))
      return { done: true }
    })
    await emit(store, {
      type: 'save/status',
      status: {
        canSave: true,
        gateAvailable: true,
        activeTurns: 0,
        activeSessions: [],
        pending: [],
        timeoutMs: 600_000,
        lastOutcomes: {
          'settings:llm-pi-ai': { at: 5, status: 'failed', label: 'settings:llm-pi-ai', message: 'conflict' },
        },
      },
    })
    await store.retryBanner('save-failed:settings:llm-pi-ai')
    // The original failure row survives: a failed RPC is not "nothing left".
    expect(store.getSnapshot().saveBanners.find(row => row.key === 'save-failed:settings:llm-pi-ai')).toBeDefined()
    const receipt = store.getSnapshot().saveBanners.find(row => row.key === 'save-retry-failed:settings:llm-pi-ai')
    expect(receipt).toMatchObject({ source: 'save-retry-failed', level: 'error' })
    expect(receipt?.body).toContain('retry transport exploded')
    expect(store.getSnapshot().saveBanners.some(row => row.key === 'save-retry-none:settings:llm-pi-ai')).toBe(false)
  })

  it('keeps a partial force banner after a failed retry/force and reports the error', async () => {
    let failFlush = false
    const idle = {
      canSave: true,
      gateAvailable: true,
      activeTurns: 0,
      activeSessions: [],
      pending: [],
      timeoutMs: 600_000,
    }
    const store = createStore(endpoint => {
      if (endpoint === 'save/flush') {
        if (failFlush) return Promise.reject(new Error('flush transport down'))
        return { saved: 0, expired: 0, failed: 1 }
      }
      if (endpoint === 'save/status') return { status: idle }
      return { done: true }
    })
    await store.forceSaveGate()
    expect(store.getSnapshot().saveBanners.find(row => row.key === 'save-partial')).toBeDefined()

    failFlush = true
    await store.retryBanner('save-partial')
    expect(store.getSnapshot().saveBanners.find(row => row.key === 'save-partial')).toBeDefined()
    expect(store.getSnapshot().saveBanners.find(row => row.key === 'save-retry-failed:flush')?.body)
      .toContain('flush transport down')

    await store.forceBanner('save-partial')
    expect(store.getSnapshot().saveBanners.find(row => row.key === 'save-partial')).toBeDefined()
    expect(store.getSnapshot().saveBanners.find(row => row.key === 'save-retry-failed:flush')?.body)
      .toContain('flush transport down')
    expect(store.getSnapshot().saveBanners.some(row => row.key.startsWith('save-retry-none'))).toBe(false)
  })

  it('reports a cancel the host did not perform and retries it from the banner', async () => {
    let cancelled = 0
    const idle = { canSave: true, activeTurns: 0, activeSessions: [], pending: [], timeoutMs: 600_000 }
    const pending = {
      ...idle,
      canSave: false,
      activeTurns: 1,
      activeSessions: [{ sessionId: 'acp-1', agentId: 'pi' }],
      pending: [{ id: 'save-1', label: 'agent-save:pi', queuedAt: 1 }],
    }
    const store = new AcpStore(async (_channel, endpoint) => {
      if (endpoint === 'save/cancel') return { ok: true, value: { cancelled } }
      if (endpoint === 'agents/list') return { ok: true, value: { agents: [] } }
      if (endpoint === 'sessions/list') return { ok: true, value: { sessions: [] } }
      if (endpoint === 'agents/detect') return { ok: true, value: { agents: [] } }
      if (endpoint === 'save/status') return { ok: true, value: { status: pending } }
      return { ok: true, value: {} }
    }, (zh) => zh)
    await emit(store, { type: 'save/status', status: pending })

    await expect(store.cancelSaveGate('agent-save:pi')).resolves.toBe(false)
    expect(store.getSnapshot().saveGate.pending).toHaveLength(1)
    expect(store.getSnapshot().saveBanners.find(row => row.key === 'save-cancel-failed:agent-save:pi'))
      .toMatchObject({ level: 'error', actions: ['retry', 'dismiss'], body: '取消未生效，回合结束会写入点击时版本。' })

    cancelled = 1
    await store.retryBanner('save-cancel-failed:agent-save:pi')
    expect(store.getSnapshot().saveGate.pending).toEqual([])
    expect(store.getSnapshot().saveBanners.find(row => row.key === 'save-cancelled:agent-save:pi'))
      .toMatchObject({ level: 'success', title: '已取消暂存' })
  })

  it('only dismisses the banner row whose timestamp the timer captured', async () => {
    const idle = { canSave: true, activeTurns: 0, activeSessions: [], pending: [], timeoutMs: 600_000 }
    const store = createStore()
    await emit(store, {
      type: 'save/status',
      status: { ...idle, canSave: false, activeTurns: 1, pending: [{ id: 'save-1', label: 'settings:llm-pi-ai', queuedAt: 1 }] },
    })
    await emit(store, {
      type: 'save/status',
      status: { ...idle, lastOutcomes: { 'settings:llm-pi-ai': { at: 6, status: 'saved', label: 'settings:llm-pi-ai' } } },
    })
    const at = store.getSnapshot().saveBanners.find(row => row.key === 'save-succeeded')?.at
    expect(at).toBeTypeOf('number')
    store.dismissBanner('save-succeeded', (at ?? 0) - 1)
    expect(store.getSnapshot().saveBanners.some(row => row.key === 'save-succeeded')).toBe(true)
    store.dismissBanner('save-succeeded', at)
    expect(store.getSnapshot().saveBanners.some(row => row.key === 'save-succeeded')).toBe(false)
  })

  it('does not resync or probe a save the host cancelled because the agent vanished', async () => {
    const calls: string[] = []
    const store = new AcpStore(async (_channel, endpoint) => {
      calls.push(endpoint)
      if (endpoint === 'agent/save') return { ok: true, value: { done: false, cancelled: true } }
      return { ok: true, value: {} }
    }, (zh) => zh)
    await expect(store.saveAgent({ id: 'pi', command: 'pi-acp' }, 'direct'))
      .resolves.toEqual({ done: false, cancelled: true })
    expect(calls).toEqual(['agent/save'])
  })

  it('reports agent_deleted as a cancelled save without retry or force', async () => {
    const calls: string[] = []
    const store = createStore(endpoint => {
      calls.push(endpoint)
      if (endpoint === 'agent/save') {
        return Promise.reject(Object.assign(new Error('the agent was deleted'), { code: 'agent_deleted' }))
      }
      return { done: true }
    })
    await expect(store.saveAgent({ id: 'pi', command: 'pi-acp' }, 'direct')).rejects.toThrow('deleted')
    const banner = store.getSnapshot().saveBanners.find(entry => entry.key === 'save-failed:pi')
    expect(banner).toMatchObject({ source: 'save-failed', level: 'error', actions: ['dismiss'] })
    expect(banner?.title).toBe('保存已取消')
    expect(banner?.body).toBe('该 Agent 已被删除，本次保存已取消。')
    expect(store.getSnapshot().deletedAgentIds).toContain('pi')
    // The retry gesture is gone: no payload was retained, so it cannot recreate
    // the id the user removed.
    const savesBefore = calls.filter(endpoint => endpoint === 'agent/save').length
    await store.retryBanner('save-failed:pi')
    expect(calls.filter(endpoint => endpoint === 'agent/save')).toHaveLength(savesBefore)
  })

  it('keeps a write-failure notice whose source id is not a configured agent', async () => {
    const store = createStore()
    const text = 'profile write failed: revision conflict'
    await emit(store, { type: 'agent/notice', agentId: 'dsh-ntr', level: 'error', text })
    const entry = store.getSnapshot().logs[store.getSnapshot().logs.length - 1]
    expect(entry).toMatchObject({ level: 'error', agentId: 'dsh-ntr', text })
    // It is a log line, not an HMR/save banner.
    expect(store.getSnapshot().saveBanners).toEqual([])
  })
})
