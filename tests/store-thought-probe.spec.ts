/**
 * The thought card's fetch, store side: `probeModels(agentId, model)`.
 *
 * The gesture must ride the SAME `agent/probe-models` RPC the settings card and
 * the model picker's 「刷新目录」 use — one probe channel, one spawn entry — and
 * its failure belongs on the card, never the settings page's notice.
 */
import { describe, expect, it } from 'vitest'
import { AcpStore } from '../src/client/store.ts'
import type { AgentCatalogResult, AgentProbeModelsResult } from '../src/protocol.ts'

function makeStore(options: { fail?: boolean; catalog?: AgentCatalogResult } = {}) {
  const calls: Array<{ endpoint: string; payload: unknown }> = []
  const store = new AcpStore(async (_channel, endpoint, payload) => {
    calls.push({ endpoint, payload })
    if (endpoint === 'agent/probe-models') {
      if (options.fail === true) {
        return { ok: false as const, error: { code: 'unknown_model', message: 'acp: agent "pi" does not offer model "gone"' } }
      }
      const result: AgentProbeModelsResult = { agentId: 'pi', catalog: {}, updatedAt: 2 }
      return { ok: true as const, value: result }
    }
    if (endpoint === 'agent/catalog' && options.catalog !== undefined) {
      return { ok: true as const, value: options.catalog }
    }
    return { ok: true as const, value: {} }
  }, zh => zh)
  return { store, calls }
}

const catalog: AgentCatalogResult = {
  agentId: 'pi',
  title: 'Pi',
  base: { id: 'pi', name: 'Pi' },
  variants: [{ id: 'pi@full', name: 'Full' }],
  reasoning: { efforts: [{ id: 'high', name: 'High' }], defaultEffort: 'high' },
  currentModel: { value: 'base', name: 'Base' },
  reasoningByModel: {
    base: { efforts: [{ id: 'high', name: 'High' }] },
    full: { efforts: [{ id: 'max', name: 'Max' }] },
  },
  probed: true,
  updatedAt: 2,
}

describe('fetching one model’s thought levels from the composer', () => {
  it('calls the existing probe RPC with the target model and re-reads the catalog', async () => {
    const { store, calls } = makeStore({ catalog })
    await store.probeModels('pi', 'full')
    // The same endpoint the settings card and 「刷新目录」 use; the model is the
    // only addition, and it is what makes the answer that model's own surface.
    expect(calls.filter(call => call.endpoint === 'agent/probe-models')).toEqual([
      { endpoint: 'agent/probe-models', payload: { agentId: 'pi', model: 'full' } },
    ])
    expect(store.getSnapshot().probingModels.pi).toBe(false)
    expect(store.getSnapshot().probeErrors.pi).toBeUndefined()
    // The seat catalog is invalidated in the same patch and read back, so
    // `reasoningForModel` sees the new record on the next render.
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(store.getSnapshot().seatCatalogs.pi?.reasoningByModel?.full?.efforts.map(level => level.id))
      .toEqual(['max'])
  })

  it('keeps a failed fetch on the card: no page notice, the reason recorded', async () => {
    const { store } = makeStore({ fail: true })
    await store.probeModels('pi', 'gone')
    const state = store.getSnapshot()
    // The card renders `probeErrors`; the settings page's notice stays clear
    // (constraint 38: that banner belongs to settings actions, not gestures).
    expect(state.probeErrors.pi).toContain('does not offer model')
    expect(state.notice).toBeUndefined()
    expect(state.probingModels.pi).toBe(false)
    expect(state.logs).toEqual([])
  })

  it('still reports a full refresh through the page notice', async () => {
    const { store } = makeStore({ fail: true })
    await store.probeModels('pi')
    // Untargeted probes are the settings card's own gesture: they keep the
    // page notice they always had.
    expect(store.getSnapshot().notice).toContain('does not offer model')
  })
})
