/**
 * The ACP model catalog's browser half (split plan P3b): the cached/persisted
 * panes, the explicit probe, the seat surface cache, the exposure filter writes
 * and the host's `catalog/updated` / `agent/exposure` invalidations.
 *
 * Part of the `tests/store.spec.ts` mirror: cases lifted verbatim out of
 * `AcpStore agent management` (same describe title, same case count for this
 * cluster); `tests/store.spec.ts` keeps the rest of that describe.
 */

import { describe, expect, it } from 'vitest'
import { AcpStore } from '../../src/client/store.ts'

describe('AcpStore agent management', () => {
  it('setExposedModels uses the lightweight endpoint and resyncs afterwards', async () => {
    const endpoints: string[] = []
    const payloads: Array<Record<string, unknown>> = []
    const store = new AcpStore(
      async (_channel, endpoint, payload) => {
        endpoints.push(endpoint)
        payloads.push(payload as Record<string, unknown>)
        if (endpoint === 'agents/list') return { ok: true, value: { agents: [] } }
        if (endpoint === 'sessions/list') return { ok: true, value: { sessions: [] } }
        if (endpoint === 'agents/detect') return { ok: true, value: { agents: [] } }
        return { ok: true, value: { done: true } }
      },
      (zh) => zh,
    )

    await store.setExposedModels('pi', ['model-a', 'model-b'])
    expect(endpoints).toContain('agent/set-exposed-models')
    expect(endpoints).toContain('agents/list') // resync refreshes currentConfig
    const sent = payloads[endpoints.indexOf('agent/set-exposed-models')]
    expect(sent).toEqual({ agentId: 'pi', exposedModels: ['model-a', 'model-b'] })

    endpoints.length = 0
    payloads.length = 0
    await store.setExposedModels('pi', undefined)
    const cleared = payloads[endpoints.indexOf('agent/set-exposed-models')]
    expect(cleared).toEqual({ agentId: 'pi' })
  })

  it('loadAgentCatalog caches per agent and dedups concurrent reads', async () => {
    const endpoints: string[] = []
    let resolveRead: ((value: unknown) => void) | undefined
    const store = new AcpStore(
      async (_channel, endpoint) => {
        endpoints.push(endpoint)
        if (endpoint !== 'agent/catalog') return { ok: true, value: {} }
        // Hold the first read open so the second caller overlaps it.
        await new Promise<void>(resolve => { resolveRead = () => { resolve() } })
        return {
          ok: true,
          value: { agentId: 'pi', title: 'Pi', base: { id: 'pi', name: 'Pi' }, variants: [], probed: true },
        }
      },
      (zh) => zh,
    )

    const first = store.loadAgentCatalog('pi')
    const second = store.loadAgentCatalog('pi')
    resolveRead?.()
    await Promise.all([first, second])
    // Two concurrent mounts, one round-trip (the seat asks on every mount).
    expect(endpoints.filter(endpoint => endpoint === 'agent/catalog')).toHaveLength(1)
    expect(store.getSnapshot().seatCatalogs.pi).toMatchObject({ title: 'Pi', probed: true })

    // Cached: a later mount reads nothing at all.
    await store.loadAgentCatalog('pi')
    expect(endpoints.filter(endpoint => endpoint === 'agent/catalog')).toHaveLength(1)
  })

  it('drops the cached seat catalog when the host announces a new one', async () => {
    let reads = 0
    const store = new AcpStore(
      async (_channel, endpoint) => {
        if (endpoint !== 'agent/catalog') return { ok: true, value: {} }
        reads += 1
        return {
          ok: true,
          value: {
            agentId: 'pi',
            title: 'Pi',
            base: { id: 'pi', name: 'Pi' },
            variants: [],
            probed: true,
            currentModel: { value: `m${String(reads)}`, name: `M${String(reads)}` },
          },
        }
      },
      (zh) => zh,
    )

    await store.loadAgentCatalog('pi')
    expect(reads).toBe(1)
    expect(store.getSnapshot().seatCatalogs.pi?.currentModel?.value).toBe('m1')

    // A real session on the host learned a new catalog: the cached projection
    // must be dropped and re-read, or the open conversation renders yesterday's
    // list until the user presses "detect models".
    await (store as unknown as { applyEvent(event: unknown): Promise<void> }).applyEvent({
      type: 'catalog/updated',
      agentId: 'pi',
      updatedAt: 2,
    })
    expect(reads).toBe(2)
    expect(store.getSnapshot().seatCatalogs.pi?.currentModel?.value).toBe('m2')

    // And the freshly read surface is cached again (no frame-storm re-reads).
    await store.loadAgentCatalog('pi')
    expect(reads).toBe(2)
  })

  it('takes a host-side exposure change without a save, and re-reads the seat surface', async () => {
    // Auto-discovery appends models on the HOST while a session runs. The
    // settings card must hear about it (its right pane is the selection) and
    // the composer must drop its cached seat list (the variants are a
    // projection of the same filter) — without an `agent/save`.
    let reads = 0
    const store = new AcpStore(
      async (_channel, endpoint) => {
        if (endpoint === 'agent/catalog') {
          reads += 1
          return {
            ok: true,
            value: { agentId: 'pi', title: 'Pi', base: { id: 'pi', name: 'Pi' }, variants: [], probed: true },
          }
        }
        if (endpoint === 'agents/list') return { ok: true, value: { agents: [] } }
        if (endpoint === 'sessions/list') return { ok: true, value: { sessions: [] } }
        if (endpoint === 'agents/detect') {
          return {
            ok: true,
            value: {
              agents: [{
                id: 'pi',
                name: 'Pi',
                detected: true,
                defaultCommand: 'pi-acp',
                defaultArgs: [],
                currentConfig: { id: 'pi', command: 'pi-acp', exposedModels: ['a'], autoDiscoverModels: true },
              }],
            },
          }
        }
        return { ok: true, value: {} }
      },
      (zh) => zh,
    )
    await store.resync()
    expect(store.getSnapshot().detectedAgents.find(info => info.id === 'pi')?.currentConfig?.exposedModels).toEqual(['a'])

    await (store as unknown as { applyEvent(event: unknown): Promise<void> }).applyEvent({
      type: 'agent/exposure',
      agentId: 'pi',
      exposedModels: ['a', 'b'],
      autoDiscoverModels: true,
    })

    expect(store.getSnapshot().detectedAgents.find(info => info.id === 'pi')?.currentConfig).toMatchObject({
      exposedModels: ['a', 'b'],
      autoDiscoverModels: true,
    })
    expect(reads).toBe(1)

    // An ABSENT field is the default-open state and must CLEAR the explicit
    // filter — the object spread must not keep the previous array.
    await (store as unknown as { applyEvent(event: unknown): Promise<void> }).applyEvent({
      type: 'agent/exposure',
      agentId: 'pi',
      autoDiscoverModels: true,
    })
    expect(store.getSnapshot().detectedAgents.find(info => info.id === 'pi')?.currentConfig?.exposedModels).toBeUndefined()
    expect(reads).toBe(2)
  })

  it('loadAgentCatalog stays quiet when the host has no catalog surface', async () => {
    const store = new AcpStore(
      async () => ({ ok: false, error: { code: 'unknown_endpoint', message: 'nope' } }),
      (zh) => zh,
    )
    await store.loadAgentCatalog('pi')
    // No entry and no notice: the seats fall back to the agent's own title.
    expect(store.getSnapshot().seatCatalogs.pi).toBeUndefined()
    expect(store.getSnapshot().notice).toBeUndefined()
  })

  it('setExposedModels surfaces host errors as a notice and rethrows', async () => {
    const store = new AcpStore(
      async (_channel, endpoint) => {
        if (endpoint === 'agent/set-exposed-models') {
          return { ok: false, error: { code: 'unknown_agent', message: 'acp: agent "pi" is not configured' } }
        }
        return { ok: true, value: {} }
      },
      (zh) => zh,
    )
    await expect(store.setExposedModels('pi', ['a'])).rejects.toThrow(/not configured/)
    expect(store.getSnapshot().notice).toMatch(/not configured/)
  })

  it('probeModels reports a failure both inline and as a notice, then clears it on retry', async () => {
    let failing = true
    const store = new AcpStore(
      async (_channel, endpoint) => {
        if (endpoint !== 'agent/probe-models') return { ok: true, value: {} }
        if (failing) return { ok: false, error: { code: 'bad_cwd', message: 'acp: cwd does not exist: /nope' } }
        return {
          ok: true,
          value: {
            agentId: 'codebuddy',
            catalog: { model: { configId: 'model', name: 'Model', currentValue: 'm', choices: [{ value: 'm', name: 'M' }] } },
            updatedAt: 1,
          },
        }
      },
      (zh) => zh,
    )

    await store.probeModels('codebuddy')
    // A failed probe must be visible where the user clicked, not only in the
    // panel-top notice that may be scrolled out of view.
    expect(store.getSnapshot().probingModels.codebuddy).toBe(false)
    expect(store.getSnapshot().probeErrors.codebuddy).toContain('cwd does not exist')
    expect(store.getSnapshot().notice).toContain('cwd does not exist')
    // A failed settings action stays on the notice banner; the agent runtime
    // log is for agent-side messages only.
    expect(store.getSnapshot().logs).toHaveLength(0)

    failing = false
    await store.probeModels('codebuddy')
    const state = store.getSnapshot()
    expect(state.probeErrors.codebuddy).toBeUndefined()
    expect(state.modelCatalogs.codebuddy?.catalog.model?.choices).toHaveLength(1)
    // The stale failure must not stay pinned at the top of the panel.
    expect(state.notice).toBeUndefined()
  })

  it('a silent probe keeps its failure on the row and out of the page notice', async () => {
    const store = new AcpStore(
      async (_channel, endpoint) => endpoint !== 'agent/probe-models'
        ? { ok: true, value: {} }
        : { ok: false, error: { code: 'agent_unreachable', message: 'boom' } },
      (zh) => zh,
    )
    // The page refreshes stale snapshots on its own; a failure nobody asked for
    // must not take over the settings page's notice line.
    await store.probeModels('codebuddy', undefined, { silent: true })
    expect(store.getSnapshot().probingModels.codebuddy).toBe(false)
    expect(store.getSnapshot().probeErrors.codebuddy).toContain('boom')
    expect(store.getSnapshot().notice).toBeUndefined()
  })

  it('staleAfterMs spends itself: a repeat attempt inside the window never spawns', async () => {
    const endpoints: string[] = []
    const store = new AcpStore(async (_channel, endpoint) => {
      endpoints.push(endpoint)
      if (endpoint === 'agent/cached-models') return { ok: true, value: { agentId: 'codebuddy', updatedAt: 1, catalog: {} } }
      if (endpoint === 'agent/probe-models') return { ok: true, value: { agentId: 'codebuddy', catalog: {}, updatedAt: 1 } }
      return { ok: true, value: {} }
    }, (zh: string) => zh)
    await store.loadCachedModels('codebuddy')
    await store.probeModels('codebuddy', undefined, { silent: true, staleAfterMs: 600_000 })
    expect(endpoints.filter(endpoint => endpoint === 'agent/probe-models')).toHaveLength(1)
    // The answer kept its old stamp (an unchanged probe), so the attempt's own
    // time is what ages out — otherwise every remount would probe again.
    await store.probeModels('codebuddy', undefined, { silent: true, staleAfterMs: 600_000 })
    expect(endpoints.filter(endpoint => endpoint === 'agent/probe-models')).toHaveLength(1)
  })

  it('staleAfterMs leaves a fresh snapshot and an unread catalog alone', async () => {
    const endpoints: string[] = []
    const store = new AcpStore(async (_channel, endpoint) => {
      endpoints.push(endpoint)
      if (endpoint === 'agent/cached-models') return { ok: true, value: { agentId: 'codebuddy', updatedAt: Date.now(), catalog: {} } }
      return { ok: true, value: {} }
    }, (zh: string) => zh)
    await store.loadCachedModels('codebuddy')
    await store.probeModels('codebuddy', undefined, { silent: true, staleAfterMs: 600_000 })
    // Unread: the「获取目录」button owns that case.
    await store.probeModels('pi', undefined, { silent: true, staleAfterMs: 600_000 })
    expect(endpoints).not.toContain('agent/probe-models')
  })

  it('loadCachedModels fills the panes from the persisted catalog, once per agent', async () => {
    const endpoints: string[] = []
    const store = new AcpStore(
      async (_channel, endpoint) => {
        endpoints.push(endpoint)
        if (endpoint !== 'agent/cached-models') return { ok: true, value: {} }
        return {
          ok: true,
          value: {
            agentId: 'codebuddy',
            catalog: {
              model: {
                configId: 'model',
                name: 'Model',
                currentValue: 'a',
                choices: [{ value: 'a', name: 'A' }, { value: 'b', name: 'B' }],
              },
            },
            updatedAt: 7,
          },
        }
      },
      (zh) => zh,
    )

    await store.loadCachedModels('codebuddy')
    // This is the whole point of the read: the list is there before any probe,
    // so a configured selection is visible on open instead of after a click.
    expect(store.getSnapshot().modelCatalogs.codebuddy?.catalog.model?.choices.map(c => c.value)).toEqual(['a', 'b'])
    // A probe never ran.
    expect(endpoints).not.toContain('agent/probe-models')

    // Collapse/expand and the next panel open mount the card again; the read is
    // memory-only but still deduped by the cached entry.
    await store.loadCachedModels('codebuddy')
    expect(endpoints.filter(endpoint => endpoint === 'agent/cached-models')).toHaveLength(1)
  })

  it('loadCachedModels never overwrites a probe and tolerates null or an older host', async () => {
    const probed = new AcpStore(
      async (_channel, endpoint) => {
        if (endpoint === 'agent/probe-models') {
          return {
            ok: true,
            value: {
              agentId: 'pi',
              catalog: { model: { configId: 'model', name: 'Model', choices: [{ value: 'fresh', name: 'Fresh' }] } },
              updatedAt: 2,
            },
          }
        }
        if (endpoint === 'agent/cached-models') {
          return {
            ok: true,
            value: {
              agentId: 'pi',
              catalog: { model: { configId: 'model', name: 'Model', choices: [{ value: 'stale', name: 'Stale' }] } },
              updatedAt: 1,
            },
          }
        }
        return { ok: true, value: {} }
      },
      (zh) => zh,
    )
    await probed.probeModels('pi')
    await probed.loadCachedModels('pi')
    expect(probed.getSnapshot().modelCatalogs.pi?.catalog.model?.choices.map(c => c.value)).toEqual(['fresh'])

    // `null` = the agent has never published a catalog; an `unknown_endpoint`
    // error = an older host half. Neither may surface as a failure.
    const empty = new AcpStore(
      async (_channel, endpoint) => (endpoint === 'agent/cached-models'
        ? { ok: true, value: null }
        : { ok: true, value: {} }),
      (zh) => zh,
    )
    await empty.loadCachedModels('pi')
    expect(empty.getSnapshot().modelCatalogs.pi).toBeUndefined()

    const older = new AcpStore(
      async (_channel, endpoint) => (endpoint === 'agent/cached-models'
        ? { ok: false, error: { code: 'unknown_endpoint', message: 'acp: unknown endpoint agent/cached-models' } }
        : { ok: true, value: {} }),
      (zh) => zh,
    )
    await expect(older.loadCachedModels('pi')).resolves.toBeUndefined()
    expect(older.getSnapshot().notice).toBeUndefined()
  })
})
