import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ModelCatalogService, type CatalogHost } from '../../src/bridge/catalog-service.ts'
import { EventHub } from '../../src/impl.ts'
import type { AcpAgentDef } from '../../src/protocol.ts'

/**
 * `thoughtByModel` is agent knowledge that ACCUMULATES: each answer may add one
 * model's levels, and the map rides `model-catalog.json` with the rest of the
 * catalog.
 *
 * A `configOptions` answer that names no model (no `model` slot) describes no
 * model, so it must leave the map alone. `parseCatalogOptions` and
 * `mergeCatalogShape` never carry it, so a single such answer used to erase
 * every per-model record — and `persistCatalogs` wrote that loss to disk.
 */

const agent: AcpAgentDef = { id: 'mock', title: 'Mock', command: process.execPath, args: [] }

function hostFor(hub: EventHub): CatalogHost {
  return {
    defOf: id => (id === agent.id ? agent : undefined),
    isAgentDeleted: () => false,
    bridgeForProbe: () => ({ probeConfigOptions: async () => undefined }),
    releaseProbe: () => {},
    liveForkCapability: () => undefined,
    patchDef: () => {},
    persistAgents: () => {},
    hub,
  }
}

function modelChoices(): unknown[] {
  return [
    { value: 'model-a', name: 'Model A' },
    { value: 'model-b', name: 'Model B' },
  ]
}

function thoughtChoices(): unknown[] {
  return [
    { value: 'off', name: 'Off' },
    { value: 'high', name: 'High' },
  ]
}

/** An answer that names the model it describes, like a real session does. */
function answerNaming(model: string, withThought = true): unknown[] {
  return [
    { configId: 'model', name: 'Model', category: 'model', currentValue: model, options: modelChoices() },
    ...withThought
      ? [{ configId: 'effort', name: 'Effort', category: 'thought_level', currentValue: 'high', options: thoughtChoices() }]
      : [{ configId: 'temperature', name: 'Temperature', category: 'model_config', currentValue: '0.2', options: [{ value: '0.2', name: '0.2' }] }],
  ]
}

/** A usable answer with options but NO model slot. */
function answerWithoutModel(): unknown[] {
  return [
    { configId: 'effort', name: 'Effort', category: 'thought_level', currentValue: 'off', options: thoughtChoices() },
    { configId: 'temperature', name: 'Temperature', category: 'model_config', currentValue: '0.2', options: [{ value: '0.2', name: '0.2' }] },
  ]
}

function keysOf(service: ModelCatalogService): string[] {
  return Object.keys(service.catalogFor('mock')?.thoughtByModel ?? {})
}

describe('remembering thought levels per model', () => {
  it('keeps the map when an answer names no model, through persist and reload', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-ntr-thought-retention-'))
    const file = join(dir, 'model-catalog.json')
    try {
      const service = new ModelCatalogService(hostFor(new EventHub()), file)
      service.absorbCatalog('mock', answerNaming('model-a'))
      service.absorbCatalog('mock', answerNaming('model-b'))
      // Two observations of two models accumulate — that is the whole point.
      expect(keysOf(service)).toEqual(['model-a', 'model-b'])

      // One full answer that carries other options but omits the model slot.
      service.absorbCatalog('mock', answerWithoutModel())

      // The per-model records survived it…
      expect(keysOf(service)).toEqual(['model-a', 'model-b'])
      // …and so did the on-disk copy: `persistCatalogs` wrote the retained map.
      const written = JSON.parse(readFileSync(file, 'utf-8')) as {
        agents: Record<string, { catalog?: { thoughtByModel?: Record<string, unknown> } }>
      }
      expect(Object.keys(written.agents.mock?.catalog?.thoughtByModel ?? {})).toEqual(['model-a', 'model-b'])

      // A fresh service over the same file reads the map back.
      const reloaded = new ModelCatalogService(hostFor(new EventHub()), file)
      reloaded.loadPersistedCatalogs()
      expect(keysOf(reloaded)).toEqual(['model-a', 'model-b'])
      expect(reloaded.modelReasoning('mock', 'model-b')?.efforts.map(level => level.id)).toEqual(['off', 'high'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('does not invent an empty map when the first answer names no model', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-ntr-thought-first-'))
    const file = join(dir, 'model-catalog.json')
    try {
      // No earlier catalog at all: `previous?.thoughtByModel` is undefined, so
      // the model-less answer must fall back to the base shape — not to
      // `{ ...base, thoughtByModel: undefined }`, which would leave a dirty key
      // behind and persist a meaningless empty map.
      const service = new ModelCatalogService(hostFor(new EventHub()), file)
      service.absorbCatalog('mock', answerWithoutModel())

      expect(service.catalogFor('mock')?.thought?.configId).toBe('effort')
      expect(service.catalogFor('mock')?.thoughtByModel).toBeUndefined()
      expect(Object.hasOwn(service.catalogFor('mock') ?? {}, 'thoughtByModel')).toBe(false)

      // The row is still a normal catalog on disk, with no map key inside…
      const written = JSON.parse(readFileSync(file, 'utf-8')) as {
        agents: Record<string, { catalog?: Record<string, unknown> }>
      }
      expect(written.agents.mock?.catalog?.thought).toBeDefined()
      expect(Object.hasOwn(written.agents.mock?.catalog ?? {}, 'thoughtByModel')).toBe(false)

      // …and a fresh service reads the agent back with no per-model knowledge.
      const reloaded = new ModelCatalogService(hostFor(new EventHub()), file)
      reloaded.loadPersistedCatalogs()
      expect(reloaded.catalogFor('mock')?.thought?.configId).toBe('effort')
      expect(reloaded.catalogFor('mock')?.thoughtByModel).toBeUndefined()
      expect(reloaded.modelReasoning('mock', 'model-a')).toBeUndefined()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('still records the named model, including "observed without the axis"', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-ntr-thought-named-'))
    const file = join(dir, 'model-catalog.json')
    try {
      const service = new ModelCatalogService(hostFor(new EventHub()), file)
      service.absorbCatalog('mock', answerNaming('model-a'))
      expect(service.catalogFor('mock')?.thoughtByModel?.['model-a']?.configId).toBe('effort')

      // Naming a model that publishes no level axis records `null` — a KNOWN
      // "no levels" — while the other model's record stays untouched.
      service.absorbCatalog('mock', answerNaming('model-b', false))
      expect(service.catalogFor('mock')?.thoughtByModel?.['model-b']).toBeNull()
      expect(service.catalogFor('mock')?.thoughtByModel?.['model-a']?.configId).toBe('effort')
      expect(service.modelReasoning('mock', 'model-b')).toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('keeps the map when a set_config_option SHAPE answer names no model', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-ntr-thought-shape-'))
    const file = join(dir, 'model-catalog.json')
    try {
      const service = new ModelCatalogService(hostFor(new EventHub()), file)
      service.absorbCatalogShape('mock', answerNaming('model-a'))
      expect(keysOf(service)).toEqual(['model-a'])

      // `mergeCatalogShape` keeps the catalog's model slot, but the OBSERVATION
      // named none — no model's vocabulary was restated, so nothing is lost.
      service.absorbCatalogShape('mock', answerWithoutModel())
      expect(keysOf(service)).toEqual(['model-a'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('serves a v3 cache written before the map existed, and repairs it by observation', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-ntr-thought-legacy-'))
    const file = join(dir, 'model-catalog.json')
    try {
      // The schema version was NOT bumped for `thoughtByModel`, so this is an
      // ordinary v3 row: served as-is, with no per-model key inside.
      writeFileSync(file, JSON.stringify({
        version: 3,
        agents: {
          mock: {
            catalog: {
              model: { configId: 'model', name: 'Model', currentValue: 'model-a', choices: [{ value: 'model-a', name: 'Model A' }] },
              thought: { configId: 'effort', name: 'Effort', currentValue: 'high', choices: thoughtChoices() },
            },
            updatedAt: 1,
          },
        },
      }), 'utf-8')
      const service = new ModelCatalogService(hostFor(new EventHub()), file)
      service.loadPersistedCatalogs()

      // The model list is still served…
      expect(service.catalogFor('mock')?.model?.choices.map(choice => choice.value)).toEqual(['model-a'])
      // …and the model the catalog NAMES keeps its agent-level levels.
      expect(service.modelReasoning('mock', 'model-a')?.efforts.map(level => level.id)).toEqual(['off', 'high'])
      // Any other model is UNKNOWN (undefined), never "observed without the
      // axis" (null): the composer then offers its fetch button, it does not
      // claim the model has no levels.
      expect(service.catalogFor('mock')?.thoughtByModel).toBeUndefined()
      expect(service.modelReasoning('mock', 'model-b')).toBeUndefined()

      // The next observation that names a model fills the map in for free.
      service.absorbCatalog('mock', answerNaming('model-a'))
      expect(keysOf(service)).toEqual(['model-a'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
