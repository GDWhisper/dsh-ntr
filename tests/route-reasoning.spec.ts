import { describe, expect, it } from 'vitest'
import { AcpStore } from '../src/client/store.ts'
import type { AgentCatalogResult, AgentView } from '../src/protocol.ts'
import { modelOffersEffort, reasoningForModel, thoughtLevelsUnknown } from '../src/client/route-reasoning.ts'
import { describeRoute, menuFor } from '../src/client/session-controls.tsx'

/**
 * Which thought levels one model publishes is a per-model fact: opencode
 * publishes `effort` only for models with variants. The catalog records each
 * observed model separately, and the composer must read the level list of the
 * model the conversation will RUN, not whichever model the agent last used.
 */
describe('per-model thought levels', () => {
  const acp = new AcpStore(async () => ({ ok: true, value: {} }), zh => zh)
  const agent: AgentView = {
    id: 'pi', title: 'Pi', command: 'pi-acp', args: [],
    allowedCwdRoots: [], state: 'ready', liveSessions: [],
  }
  const catalog: AgentCatalogResult = {
    agentId: 'pi',
    title: 'Pi',
    base: { id: 'pi', name: 'Pi' },
    variants: [
      { id: 'pi@plain', name: 'Plain' },
      { id: 'pi@full', name: 'Full' },
    ],
    // The agent-level slot describes the model the agent was last observed on.
    reasoning: { efforts: [{ id: 'off', name: 'Off' }, { id: 'high', name: 'High' }], defaultEffort: 'high' },
    currentModel: { value: 'base-model', name: 'Base' },
    reasoningByModel: {
      'base-model': { efforts: [{ id: 'off', name: 'Off' }, { id: 'high', name: 'High' }] },
      plain: { efforts: [] },
      full: { efforts: [{ id: 'low', name: 'Low' }, { id: 'max', name: 'Max' }] },
    },
    probed: true,
    updatedAt: 1,
  }

  it('reads the selected model’s own record, and refuses to borrow another one', () => {
    // The bare route is the agent's own model: the agent-level slot, default included.
    expect(reasoningForModel(catalog, undefined)).toEqual(catalog.reasoning)
    // The model the catalog names shares that answer.
    expect(reasoningForModel(catalog, 'base-model')).toEqual(catalog.reasoning)
    // A model observed WITHOUT the axis has none — even though the agent-level
    // slot still carries the previous model's levels.
    expect(reasoningForModel(catalog, 'plain')?.efforts).toEqual([])
    // A model with its own observation gets that observation.
    expect(reasoningForModel(catalog, 'full')?.efforts.map(level => level.id)).toEqual(['low', 'max'])
    // Never observed: unknown, not the previous model's list.
    expect(reasoningForModel(catalog, 'never-seen')).toBeUndefined()
    expect(reasoningForModel(undefined, 'full')).toBeUndefined()
  })

  it('treats an older host catalog without per-model knowledge as agent-wide', () => {
    const oldHost: AgentCatalogResult = {
      ...catalog,
      currentModel: undefined,
      reasoningByModel: undefined,
    }
    expect(reasoningForModel(oldHost, 'anything')?.efforts.map(level => level.id)).toEqual(['off', 'high'])
  })

  it('keeps an effort only when the target model declares it', () => {
    expect(modelOffersEffort(catalog, 'full', 'max')).toBe(true)
    expect(modelOffersEffort(catalog, 'full', 'high')).toBe(false)
    expect(modelOffersEffort(catalog, 'never-seen', 'high')).toBe(false)
    expect(modelOffersEffort(undefined, 'full', 'max')).toBe(false)
    expect(modelOffersEffort(catalog, 'full', undefined)).toBe(false)
  })

  it('shows the switched model’s levels in the thought picker', () => {
    // Before the first message, with the model switched to `full`, the menu
    // offers THAT model's vocabulary — not the agent-level list.
    const route = describeRoute([agent], undefined, undefined, catalog, 'pi', { agentId: 'pi', modelId: 'pi@full' })
    expect(route.efforts.map(level => level.id)).toEqual(['low', 'max'])
    const menu = menuFor('thought', { acp, agents: [agent], catalog, route })
    expect(menu.sections[0]?.items.map(item => item.id)).toEqual(['provider-default', 'low', 'max'])
    // Switching to a model with no level axis leaves nothing to offer.
    const plain = describeRoute([agent], undefined, undefined, catalog, 'pi', { agentId: 'pi', modelId: 'pi@plain' })
    expect(plain.efforts).toEqual([])
    expect(menuFor('thought', { acp, agents: [agent], catalog, route: plain }).sections[0]?.items.map(item => item.id))
      .toEqual(['provider-default'])
  })
})

/**
 * "Unknown" is a THIRD state, not the same as "observed without the axis": the
 * composer offers its fetch button only for a model nobody has seen, so the two
 * undefined answers must be told apart from the per-model map.
 */
describe('per-model thought knowledge: unknown vs observed-absent', () => {
  const catalog: AgentCatalogResult = {
    agentId: 'pi',
    title: 'Pi',
    base: { id: 'pi', name: 'Pi' },
    variants: [],
    reasoning: { efforts: [{ id: 'off', name: 'Off' }], defaultEffort: 'off' },
    currentModel: { value: 'base', name: 'Base' },
    reasoningByModel: {
      base: { efforts: [{ id: 'off', name: 'Off' }] },
      plain: { efforts: [] },
    },
    probed: true,
    updatedAt: 1,
  }

  it('is unknown only for a model the catalog has no record of', () => {
    // Other models' records answer for themselves — even an EMPTY one.
    expect(thoughtLevelsUnknown(catalog, 'plain')).toBe(false)
    expect(thoughtLevelsUnknown(catalog, 'base')).toBe(false)
    // Never observed: the one state that gets the card's fetch button.
    expect(thoughtLevelsUnknown(catalog, 'never-seen')).toBe(true)
    // No catalog / no model to name: nothing honest to claim.
    expect(thoughtLevelsUnknown(undefined, 'never-seen')).toBe(false)
    expect(thoughtLevelsUnknown(catalog, undefined)).toBe(false)
  })

  it('does not call a model unknown when its agent-level slot is the answer', () => {
    // The catalog names this model: its slot being absent means the agent was
    // observed WITHOUT the axis, not that the model was never used.
    const noAxis: AgentCatalogResult = { ...catalog, reasoning: undefined, reasoningByModel: {} }
    expect(thoughtLevelsUnknown(noAxis, 'base')).toBe(false)
    expect(thoughtLevelsUnknown(noAxis, 'other')).toBe(true)
    // An older host catalog with no per-model map and no current model: a pick
    // has no record anywhere, so it is honest to offer the fetch.
    const oldHost: AgentCatalogResult = { ...catalog, currentModel: undefined, reasoningByModel: undefined, reasoning: undefined }
    expect(thoughtLevelsUnknown(oldHost, 'picked')).toBe(true)
  })
})
