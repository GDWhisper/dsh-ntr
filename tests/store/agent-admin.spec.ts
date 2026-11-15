/**
 * The roster write path (split plan P3b): explicit detect, save, delete and
 * the connection-form dry run. Moved verbatim out of `tests/store.spec.ts`,
 * which still drives the same facade — the service is reached through
 * `AcpStore`.
 */

import { describe, expect, it, vi } from 'vitest'

describe('AcpStore agent management', () => {
  it('detectAgents queries endpoint and updates state', async () => {
    const rpcCalls: Array<{ channel: string; endpoint: string; payload: unknown }> = []
    const store = new (await import('../../src/client/store.ts')).AcpStore(
      async (channel, endpoint, payload) => {
        rpcCalls.push({ channel, endpoint, payload })
        if (endpoint === 'agents/detect') {
          return { ok: true, value: { agents: [{ id: 'pi', name: 'Pi Agent', detected: true, defaultCommand: 'pi-acp', defaultArgs: [] }] } }
        }
        return { ok: true, value: {} }
      },
      (zh) => zh,
    )

    await store.detectAgents()
    const state = store.getSnapshot()
    expect(state.detectedAgents).toHaveLength(1)
    expect(state.detectedAgents[0].id).toBe('pi')
    expect(state.detecting).toBe(false)
    expect(state.detectSummary).toBe('已检测 1 个预设：1 个已安装，其余可从「添加智能体」启用。')
  })

  it('detectAgents reports the fallback preset list as the summary when the host detects nothing', async () => {
    const store = new (await import('../../src/client/store.ts')).AcpStore(
      async (_channel, endpoint) => {
        if (endpoint === 'agents/detect') return { ok: true, value: { agents: [] } }
        return { ok: true, value: {} }
      },
      (zh) => zh,
    )
    await store.detectAgents()
    const state = store.getSnapshot()
    expect(state.detectedAgents.length).toBeGreaterThan(0)
    expect(state.detectSummary).toContain('个预设')
  })

  it('clears the previous detect summary when a re-detect fails', async () => {
    let failing = false
    const store = new (await import('../../src/client/store.ts')).AcpStore(
      async (_channel, endpoint) => {
        if (endpoint === 'agents/detect') {
          if (failing) return { ok: false, error: { code: 'internal', message: 'host offline' } }
          return { ok: true, value: { agents: [{ id: 'pi', name: 'Pi Agent', detected: true, defaultCommand: 'pi-acp', defaultArgs: [] }] } }
        }
        return { ok: true, value: {} }
      },
      (zh) => zh,
    )
    await store.detectAgents()
    expect(store.getSnapshot().detectSummary).toContain('个预设')
    failing = true
    await store.detectAgents()
    const state = store.getSnapshot()
    // The stale success line must not sit next to the failure notice.
    expect(state.detectSummary).toBeUndefined()
    expect(state.detecting).toBe(false)
    expect(state.notice).toBe('host offline')
  })

  it('saveAgent and deleteAgent trigger RPC calls and resync', async () => {
    const endpoints: string[] = []
    const store = new (await import('../../src/client/store.ts')).AcpStore(
      async (channel, endpoint, payload) => {
        endpoints.push(endpoint)
        if (endpoint === 'agents/list') return { ok: true, value: { agents: [] } }
        if (endpoint === 'sessions/list') return { ok: true, value: { sessions: [] } }
        if (endpoint === 'agents/detect') return { ok: true, value: { agents: [] } }
        return { ok: true, value: { done: true } }
      },
      (zh) => zh,
    )

    await store.saveAgent({ id: 'pi', command: 'pi-acp', args: [] })
    expect(endpoints).toContain('agent/save')
    expect(endpoints).toContain('agents/list')

    await store.deleteAgent('pi')
    expect(endpoints).toContain('agent/delete')
  })

  it('testAgent posts the form payload as-is and returns the host verdict', async () => {
    const payloads: Array<Record<string, unknown>> = []
    const store = new (await import('../../src/client/store.ts')).AcpStore(
      async (_channel, endpoint, payload) => {
        if (endpoint === 'agent/test') {
          payloads.push(payload as Record<string, unknown>)
          return { ok: true, value: { ok: false, error: 'spawn ENOENT', durationMs: 12, stderr: [] } }
        }
        return { ok: true, value: {} }
      },
      (zh) => zh,
    )

    const verdict = await store.testAgent({ id: 'pi', command: 'pi-acp', args: [], npmPackage: 'pi-acp', env: { KEY: 'v' } })
    expect(payloads[0]).toEqual({ id: 'pi', command: 'pi-acp', args: [], npmPackage: 'pi-acp', env: { KEY: 'v' } })
    // A reachable-but-broken agent is a verdict, not a thrown error.
    expect(verdict).toMatchObject({ ok: false, error: 'spawn ENOENT' })

    // Old host build: the unknown-endpoint failure becomes a localized notice.
    const oldStore = new (await import('../../src/client/store.ts')).AcpStore(
      async () => ({ ok: false, error: { code: 'unknown_endpoint', message: 'acp: unknown endpoint agent/test' } }),
      (zh) => zh,
    )
    await expect(oldStore.testAgent({ id: 'pi', command: 'pi-acp' })).rejects.toThrow(/unknown endpoint agent\/test/)
    expect(oldStore.getSnapshot().notice).toContain('重启 dsh web')
  })
})
