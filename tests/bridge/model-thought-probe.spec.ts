import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { BridgeManager } from '../../src/bridge.ts'
import { dispatchRpc, EventHub } from '../../src/impl.ts'
import { def } from './harness.ts'

/**
 * The thought card's fetch: `agent/probe-models` with an optional `model`.
 *
 * A model the agent has never been observed on publishes no level list, so the
 * composer offers one button that asks the agent about THAT model. It rides the
 * existing probe (same RPC, same throwaway session) and its answer is a
 * per-model SHAPE: `thoughtByModel[model]` is recorded while the agent-level
 * `currentModel` keeps whatever a real session reported.
 */

const hub = new EventHub()

function managerFor(tag: string): BridgeManager {
  return new BridgeManager([def], hub, 500, `${tmpdir()}/acp-thought-${tag}-${Date.now()}.json`)
}

describe('agent/probe-models with a target model', () => {
  it('records only that model’s levels and leaves the agent’s current model alone', async () => {
    const gm = managerFor('target')
    try {
      const full = await dispatchRpc(gm, 'agent/probe-models', { agentId: 'mock' })
      expect(full.ok).toBe(true)
      // The full probe observed the agent's own model only.
      expect(gm.agentCatalog('mock').reasoningByModel?.['mock-model-a']?.efforts.map(level => level.id))
        .toEqual(['off', 'high'])
      expect(gm.agentCatalog('mock').reasoningByModel?.['mock-model-b']).toBeUndefined()

      const answer = await dispatchRpc(gm, 'agent/probe-models', { agentId: 'mock', model: 'mock-model-b' })
      expect(answer.ok).toBe(true)
      const seat = gm.agentCatalog('mock')
      expect(seat.reasoningByModel?.['mock-model-b']?.efforts.map(level => level.id)).toEqual(['off', 'high'])
      // A probe must not rename the agent's own default in every composer.
      expect(seat.currentModel?.value).toBe('mock-model-a')
      // The catalog read that follows a probe sees it immediately.
      expect(gm.agentCatalog('mock').reasoningByModel?.['mock-model-b']).toEqual({ efforts: [{ id: 'off', name: 'Off' }, { id: 'high', name: 'High' }] })
    } finally {
      await gm.shutdownAll()
    }
  }, 30_000)

  it('reports "observed without the axis" for a model that publishes no thought_level', async () => {
    const plainDef = { ...def, env: { ...def.env, MOCK_PLAIN_MODEL_CHOICE: '1' } }
    const gm = new BridgeManager([plainDef], hub, 500, `${tmpdir()}/acp-thought-plain-${Date.now()}.json`)
    try {
      await gm.probeAgentModels('mock')
      const answer = await dispatchRpc(gm, 'agent/probe-models', { agentId: 'mock', model: 'mock-model-plain' })
      expect(answer.ok).toBe(true)
      // An empty effort list IS a record: the model was seen without the axis,
      // which is different from "never observed" and closes the card's button.
      expect(gm.agentCatalog('mock').reasoningByModel?.['mock-model-plain']).toEqual({ efforts: [] })
    } finally {
      await gm.shutdownAll()
    }
  }, 30_000)

  it('rejects a model the agent does not offer, without recording anything', async () => {
    const gm = managerFor('unknown-model')
    try {
      await gm.probeAgentModels('mock')
      const before = gm.agentCatalog('mock')
      const answer = await dispatchRpc(gm, 'agent/probe-models', { agentId: 'mock', model: 'ghost-model' })
      expect(answer).toMatchObject({ ok: false, error: { code: 'unknown_model' } })
      // Nothing was learned, and the agent-level surface is untouched.
      expect(gm.agentCatalog('mock').reasoningByModel).toEqual(before.reasoningByModel)
      expect(gm.agentCatalog('mock').currentModel?.value).toBe('mock-model-a')
    } finally {
      await gm.shutdownAll()
    }
  }, 30_000)

  it('validates the payload and the agent with the existing error codes', async () => {
    const gm = managerFor('validation')
    try {
      // The model is a string or absent: anything else is a caller bug.
      expect(await dispatchRpc(gm, 'agent/probe-models', { agentId: 'mock', model: 42 }))
        .toMatchObject({ ok: false, error: { code: 'bad_payload' } })
      // An agent the roster does not own is never spawned.
      expect(await dispatchRpc(gm, 'agent/probe-models', { agentId: 'ghost', model: 'x' }))
        .toMatchObject({ ok: false, error: { code: 'unknown_agent' } })
    } finally {
      await gm.shutdownAll()
    }
  })
})

describe('switching to an unobserved model', () => {
  it('clears the level with an info notice, not an error', async () => {
    const events: Array<{ level: string; text: string }> = []
    hub.subscribe(event => {
      if (event.type === 'agent/notice') events.push({ level: event.level, text: event.text })
    })
    const gm = managerFor('notice')
    try {
      await gm.probeAgentModels('mock')
      gm.bindChatAgent('dsh-unobserved', 'mock')
      await gm.setChatSessionEffort('dsh-unobserved', 'high', 'mock')
      const before = events.length
      await gm.setChatSessionModel('dsh-unobserved', 'mock@mock-model-b')

      // The pick is cleared (constraint 27 forbids keeping a level this model
      // may not offer), and the fact is log-only: a model switch is not an error.
      expect(gm.chatChoice('dsh-unobserved')).toEqual({ agentId: 'mock', modelId: 'mock@mock-model-b' })
      const said = events.slice(before).filter(event => event.text.includes('thought level'))
      expect(said).toHaveLength(1)
      expect(said[0]?.level).toBe('info')
      expect(said[0]?.text).toContain('thought card')
    } finally {
      await gm.shutdownAll()
    }
  }, 30_000)
})
