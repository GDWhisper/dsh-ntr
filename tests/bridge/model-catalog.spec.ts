import { tmpdir } from 'node:os'
import { readFileSync, writeFileSync } from 'node:fs'
import { afterAll, describe, expect, it } from 'vitest'
import { AcpLlmAdapter, BridgeManager } from '../../src/bridge.ts'
import { type AcpAgentDef, type AcpEvent, type StreamChunk } from '../../src/protocol.ts'
import { dispatchRpc, EventHub } from '../../src/impl.ts'
import { createBridgeHarness, def } from './harness.ts'

const { hub, manager } = createBridgeHarness()

afterAll(async () => {
  await manager.shutdownAll()
})

describe('model catalog (isolated manager)', () => {
  const catalogPath = `${tmpdir()}/acp-catalog-test-${Date.now()}.json`
  const catalogManager = new BridgeManager([def], hub, 500, undefined, catalogPath)
  const catalogAdapter = new AcpLlmAdapter(catalogManager)

  afterAll(async () => {
    await catalogManager.shutdownAll()
  })

  it('advertises nothing: the ACP route is absent from DSH\'s model catalog', async () => {
    expect(await catalogAdapter.listModels('acp')).toEqual([])
  })

  it('serves the agent surface through agent/catalog, memory-only before any probe', async () => {
    // The seats' read is pure memory: no probe has run yet, so the answer is
    // the base entry and a `probed: false` flag (the host probes in the
    // background behind it).
    const before = catalogManager.agentCatalog('mock')
    expect(before).toMatchObject({ agentId: 'mock', title: 'Mock', probed: false, variants: [] })
    // No probe yet → no known current model, so `base` names the agent alone.
    expect(before.base).toMatchObject({ id: 'mock', name: 'Mock' })
    expect(before.currentModel).toBeUndefined()
    expect(before.reasoning).toBeUndefined()
    expect(() => catalogManager.agentCatalog('ghost')).toThrow(/not configured/)
  })

  it('reports no cached catalog before the agent has ever published one', () => {
    // The settings panel's mount read: `undefined` here is what makes it show
    // 「尚未读取模型目录」 instead of an empty list that looks like a failed probe.
    expect(catalogManager.cachedAgentModels('mock')).toBeUndefined()
  })

  it('probes configOptions, expands variants with reasoning metadata, degrades stale ids', async () => {
    const probe = await catalogManager.probeAgentModels('mock')
    expect(probe.agentId).toBe('mock')
    expect(probe.catalog.model?.configId).toBe('model')
    expect(probe.catalog.model?.choices.map(c => c.value)).toEqual(['mock-model-a', 'mock-model-b'])
    expect(probe.catalog.thought?.choices.map(c => c.value)).toEqual(['off', 'high'])
    expect(probe.catalog.thought?.currentValue).toBe('high')

    // Variants are opt-in (an unexposed catalog would flood the seats' menus —
    // pi publishes 500 choices): a probe alone offers the base entry.
    const probed = catalogManager.agentCatalog('mock')
    expect(probed.probed).toBe(true)
    expect(probed.variants).toEqual([])
    // The agent's own reasoning metadata rides the same read.
    expect(probed.reasoning?.efforts.map(e => e.id)).toEqual(['off', 'high'])
    expect(probed.reasoning?.defaultEffort).toBe('high')
    await catalogManager.setExposedModels('mock', ['mock-model-a', 'mock-model-b'])

    const seat = catalogManager.agentCatalog('mock')
    expect(seat.variants.map(variant => variant.id)).toEqual(['mock@mock-model-a', 'mock@mock-model-b'])
    // Rows name the MODEL alone — the picker already says whose models these are,
    // and the composer chip sits beside the agent chip.
    expect(seat.variants[1]).toMatchObject({ name: 'Mock Model B', description: 'The stronger mock model' })

    const resolved = await catalogAdapter.resolveModel('acp', 'mock@mock-model-b')
    expect(resolved).toMatchObject({ provider: 'acp', id: 'mock@mock-model-b', name: 'Mock · Mock Model B' })
    // `mock-model-b` has never been observed: advertise NO levels for it. The
    // agent-level slot describes model A, and borrowing it here would name
    // another model's levels as this one's (the composer calls that unknown).
    expect(resolved.reasoning).toBeUndefined()

    // The base entry carries the same reasoning metadata (agent default model).
    const base = await catalogAdapter.resolveModel('acp', 'mock')
    expect(base.reasoning?.defaultEffort).toBe('high')

    // Unknown agents throw so DSH's selectModel reports model-unavailable…
    await expect(catalogAdapter.resolveModel('acp', 'ghost')).rejects.toThrow(/not configured/)
    // …while stale variants degrade to a bare-id entry instead of throwing.
    const stale = await catalogAdapter.resolveModel('acp', 'mock@ghost-model')
    expect(stale).toMatchObject({ provider: 'acp', id: 'mock@ghost-model', name: 'mock@ghost-model' })
  }, 30_000)

  it('aligns per-turn model and thought level on the live ACP session', async () => {
    const chunks: StreamChunk[] = []
    for await (const chunk of catalogAdapter.stream({
      provider: 'acp',
      model: 'mock@mock-model-b',
      sessionId: 'dsh-align-test',
      reasoningEffort: 'off',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hello aligned' }] }],
    })) {
      chunks.push(chunk)
    }
    const finish = chunks.find((c): c is Extract<StreamChunk, { type: 'finish' }> => c.type === 'finish')
    expect(finish?.reason).toEqual({ kind: 'stop' })

    // The streamed turn ran on the agent's own model choice and effort level,
    // applied through session/set_config_option on the same ACP session.
    const view = (catalogManager.sessions() as Array<{ agentId: string; configOptions?: Array<{ configId: string; currentValue: string }> }>)
      .find(s => s.agentId === 'mock')
    expect(view?.configOptions?.find(o => o.configId === 'model')?.currentValue).toBe('mock-model-b')
    expect(view?.configOptions?.find(o => o.configId === 'thought')?.currentValue).toBe('off')
  }, 30_000)

  it('advertises a variant’s own levels once the agent was observed on it', async () => {
    // The per-turn switch above observed `mock-model-b`, so its record exists
    // now — and it belongs to THAT model, with no agent-wide default.
    const resolved = await catalogAdapter.resolveModel('acp', 'mock@mock-model-b')
    expect(resolved.reasoning?.efforts.map(e => e.id)).toEqual(['off', 'high'])
    expect(resolved.reasoning?.defaultEffort).toBeUndefined()
    // The base route keeps the agent-level default (the model it is on).
    expect((await catalogAdapter.resolveModel('acp', 'mock')).reasoning?.defaultEffort).toBe('high')
  })

  it('narrows the ACP seats via setExposedModels; hidden variants still resolve', async () => {
    // Unset and empty are the same state: no variants, only the base entry
    // (the agent's own default model), which is never filtered out.
    await catalogManager.setExposedModels('mock', undefined)
    expect(catalogManager.agentCatalog('mock').variants).toEqual([])

    await catalogManager.setExposedModels('mock', ['mock-model-b'])
    expect(catalogManager.agentCatalog('mock').variants.map(v => v.id)).toEqual(['mock@mock-model-b'])

    // An empty filter leaves just the base entry too.
    await catalogManager.setExposedModels('mock', [])
    expect(catalogManager.agentCatalog('mock').variants).toEqual([])

    // Filtering only affects listing: a hidden variant still resolves fully.
    const hidden = await catalogAdapter.resolveModel('acp', 'mock@mock-model-a')
    expect(hidden).toMatchObject({ id: 'mock@mock-model-a', name: 'Mock · Mock Model A' })

    await expect(catalogManager.setExposedModels('ghost', ['x'])).rejects.toThrow(/not configured/)
  }, 30_000)

  it('reloads a persisted catalog into a fresh manager without probing', async () => {
    const reloaded = new BridgeManager([def], hub, 500, undefined, catalogPath)
    // Nothing exposed yet, so the base entry is the whole surface…
    expect(reloaded.agentCatalog('mock')).toMatchObject({ probed: true, variants: [] })
    // …and the panel's own read answers from the same disk cache: this is what
    // fills the model panes on mount, before (and without) a probe.
    const cached = reloaded.cachedAgentModels('mock')
    expect(cached?.catalog.model?.choices.map(choice => choice.value)).toEqual(['mock-model-a', 'mock-model-b'])
    expect(cached?.updatedAt).toBeGreaterThan(0)
    // …but the catalog really did come off disk: exposing a choice is enough to
    // offer it, and that path never spawns an agent.
    await reloaded.setExposedModels('mock', ['mock-model-a', 'mock-model-b'])
    expect(reloaded.agentCatalog('mock').variants.map(v => v.id)).toEqual(['mock@mock-model-a', 'mock@mock-model-b'])
    // `def` is shared with the suite, so leave it the way it was found.
    await reloaded.setExposedModels('mock', undefined)
  })

  it('serves a catalog persisted by an older schema, and marks it for repair', async () => {
    // A `{model, thought}`-only catalog written before the `mode` category was
    // parsed would otherwise keep an agent looking like it has no mode axis
    // FOREVER. It is still SERVED (dropping it would blank the seats across an
    // upgrade), marked stale, and repaired for free by `absorbCatalog` the next
    // time that agent's own session publishes its options.
    const stalePath = `${tmpdir()}/acp-catalog-stale-${Date.now()}.json`
    writeFileSync(stalePath, JSON.stringify({
      version: 1,
      agents: { mock: { catalog: { model: { configId: 'model', name: 'Model', currentValue: 'mock-model-a', choices: [] } }, updatedAt: 1 } },
    }), 'utf-8')
    const stale = new BridgeManager([def], hub, 500, undefined, stalePath)
    // Served, so the seats keep working across the upgrade…
    expect(stale.agentCatalog('mock')).toMatchObject({ probed: true, currentModel: { value: 'mock-model-a' } })
    // …and marked, so the next real session on this agent knows to rewrite it.
    expect((stale as unknown as { catalog: { catalogStale: Set<string> } }).catalog.catalogStale.has('mock')).toBe(true)
    // A REAL session publishing its options discharges the mark — this is the
    // repair path, and it costs no process because the session already exists.
    for await (const _ of stale.streamPrompt({
      model: 'mock',
      sessionId: 'dsh-stale-repair',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    } as never)) { /* drain */ }
    expect((stale as unknown as { catalog: { catalogStale: Set<string> } }).catalog.catalogStale.has('mock')).toBe(false)
    await stale.shutdownAll()
  }, 30_000)

  it('announces a catalog learned from a real session, so open conversations can re-read it', async () => {
    // The composer caches the seat surface per agent. Before this announcement
    // path existed, the first real session could learn a NEWER catalog on the
    // host while the open conversation kept rendering yesterday's list until
    // someone pressed "detect models" (user report, 2026-10-19).
    const announcePath = `${tmpdir()}/acp-catalog-announce-${Date.now()}.json`
    const announceHub = new EventHub()
    const announced: AcpEvent[] = []
    announceHub.subscribe(event => { announced.push(event) })
    const gm = new BridgeManager([def], announceHub, 500, undefined, announcePath)

    const start = await dispatchRpc(gm, 'session/start', { agentId: 'mock' })
    expect(start.ok).toBe(true)
    if (!start.ok) return
    const sessionId = (start.value as { sessionId: string }).sessionId

    // `session/new` itself is a catalog observation: it announces the change
    // (absent → present) without any explicit probe.
    const fromSession = announced.filter(event => event.type === 'catalog/updated')
    expect(fromSession).toHaveLength(1)
    expect(fromSession[0]).toMatchObject({ agentId: 'mock' })
    expect(gm.agentCatalog('mock')).toMatchObject({ probed: true, currentModel: { value: 'mock-model-a' } })

    // A second session that publishes the SAME options is not news: the
    // catalog is unchanged, so no redundant frame (and no browser re-read).
    const second = await dispatchRpc(gm, 'session/start', { agentId: 'mock' })
    expect(second.ok).toBe(true)
    expect(announced.filter(event => event.type === 'catalog/updated')).toHaveLength(1)

    await gm.shutdownAll()
  }, 30_000)

  it('absorbs the option SHAPE of a set_config_option answer, never its currentValue', async () => {
    // opencode publishes `thought_level` (its `effort`) only for models WITH
    // variants and never re-notifies after a client-driven set: the answer to
    // `session/set_config_option` is the ONLY place the thought chip's levels
    // can come from. Its `currentValue`, though, is THIS session's pick —
    // promoting it would make `reasoning.defaultEffort` out of one
    // conversation's choice.
    const shapePath = `${tmpdir()}/acp-catalog-shape-${Date.now()}.json`
    const shapeHub = new EventHub()
    const announced: AcpEvent[] = []
    shapeHub.subscribe(event => { announced.push(event) })
    const shapeDef: AcpAgentDef = { ...def, env: { ...def.env, MOCK_MODEL: 'mock-model-plain' } }
    const gm = new BridgeManager([shapeDef], shapeHub, 500, undefined, shapePath)

    const start = await dispatchRpc(gm, 'session/start', { agentId: 'mock' })
    expect(start.ok).toBe(true)
    if (!start.ok) return
    const sessionId = (start.value as { sessionId: string }).sessionId

    // The session starts on a variant-less model: no thought_level is ever
    // published for it, and the seat must not invent one.
    expect(gm.agentCatalog('mock').reasoning).toBeUndefined()
    expect(gm.cachedAgentModels('mock')?.catalog.thought).toBeUndefined()
    const beforeSet = announced.filter(event => event.type === 'catalog/updated').length

    // Switching to a variant-bearing model answers WITH the effort option.
    await dispatchRpc(gm, 'session/config-set', { sessionId, configId: 'model', value: 'mock-model-b' })

    // The shape lands in the agent catalog (the thought chip now has levels)…
    const seat = gm.agentCatalog('mock')
    expect(seat.reasoning?.efforts.map(e => e.id)).toEqual(['off', 'high'])
    // …while the answer's currentValue (this session's `high` pick) stays out
    // of the agent's default effort.
    expect(seat.reasoning?.defaultEffort).toBeUndefined()
    // The change is announced so open conversations re-read the seat surface.
    expect(announced.filter(event => event.type === 'catalog/updated').length).toBe(beforeSet + 1)

    await gm.shutdownAll()
  }, 30_000)

  it('never lets an EMPTY configOptions answer wipe known catalog or session state', async () => {
    // Observed agents (ccb, opencode) answer `configOptions: []` in
    // intermediate states — mid-reset, or while a provider is still loading.
    // That is a non-answer: absorbing it would drop the model list the seat is
    // showing and the session's own snapshot for a state that passes moments
    // later (the rule OmniTerm settles on: empty sets never overwrite the last
    // known state).
    const emptyPath = `${tmpdir()}/acp-catalog-empty-${Date.now()}.json`
    const emptyHub = new EventHub()
    const announced: AcpEvent[] = []
    emptyHub.subscribe(event => { announced.push(event) })
    const gm = new BridgeManager([def], emptyHub, 500, undefined, emptyPath)

    const start = await dispatchRpc(gm, 'session/start', { agentId: 'mock' })
    expect(start.ok).toBe(true)
    if (!start.ok) return
    const sessionId = (start.value as { sessionId: string }).sessionId

    const catalogBefore = JSON.stringify(gm.catalogFor('mock'))
    expect(gm.catalogFor('mock')?.thought).toBeDefined()
    const optionsBefore = (gm.sessions()[0] as { configOptions?: unknown[] }).configOptions
    expect(optionsBefore?.length).toBeGreaterThan(0)
    const announcedBefore = announced.filter(event => event.type === 'catalog/updated').length

    // The agent answers the set with `[]` AND pushes a `[]` notification.
    const set = await dispatchRpc(gm, 'session/config-set', { sessionId, configId: 'mock-empty-answer', value: 'x' })
    expect(set.ok).toBe(true)

    // Catalog and session snapshot are exactly what they were.
    expect(JSON.stringify(gm.catalogFor('mock'))).toBe(catalogBefore)
    expect((gm.sessions()[0] as { configOptions?: unknown[] }).configOptions).toEqual(optionsBefore)
    // …and nothing was announced, because nothing changed.
    expect(announced.filter(event => event.type === 'catalog/updated').length).toBe(announcedBefore)

    await gm.shutdownAll()
  }, 30_000)

  it('auto-discovers models the agent newly publishes by default, without touching the existing selection', async () => {
    // Baseline: the host knew only model A, and the user had selected exactly
    // it. The agent then adds model B; discovery is ON by default (the def
    // says nothing), so B is appended and nothing else — no settings-panel
    // visit, no resurrection of unchecked models.
    const autoCatalogPath = `${tmpdir()}/acp-catalog-auto-${Date.now()}.json`
    const autoAgentsPath = `${tmpdir()}/acp-agents-auto-${Date.now()}.json`
    writeFileSync(autoCatalogPath, JSON.stringify({
      version: 2,
      agents: {
        mock: {
          catalog: {
            model: {
              configId: 'model',
              name: 'Model',
              currentValue: 'mock-model-a',
              choices: [{ value: 'mock-model-a', name: 'Mock Model A' }],
            },
          },
          updatedAt: 1,
        },
      },
    }), 'utf-8')
    const autoHub = new EventHub()
    const announced: AcpEvent[] = []
    autoHub.subscribe(event => { announced.push(event) })
    const autoDef: AcpAgentDef = {
      ...def,
      exposedModels: ['mock-model-a'],
    }
    const auto = new BridgeManager([autoDef], autoHub, 500, autoAgentsPath, autoCatalogPath)

    // A real session publishes {A, B}: B is NEW relative to the baseline.
    const start = await dispatchRpc(auto, 'session/start', { agentId: 'mock' })
    expect(start.ok).toBe(true)
    expect(auto.agentCatalog('mock').variants.map(variant => variant.id))
      .toEqual(['mock@mock-model-a', 'mock@mock-model-b'])
    expect(announced.filter((event): event is Extract<AcpEvent, { type: 'agent/exposure' }> => event.type === 'agent/exposure'))
      .toMatchObject([{ agentId: 'mock', exposedModels: ['mock-model-a', 'mock-model-b'], autoDiscoverModels: true }])
    // A persisted policy change, not a live-only tweak. On is the default, so
    // the file carries no switch field until someone opts out.
    const stored = JSON.parse(readFileSync(autoAgentsPath, 'utf-8')) as {
      agents: Array<{ exposedModels?: string[]; autoDiscoverModels?: boolean }>
    }
    expect(stored.agents[0]).toMatchObject({
      exposedModels: ['mock-model-a', 'mock-model-b'],
    })
    expect('autoDiscoverModels' in (stored.agents[0] ?? {})).toBe(false)

    // Switching it off keeps what was already discovered and persists the
    // explicit opt-out — the only value this field ever stores.
    await auto.setAutoDiscoverModels('mock', false)
    expect(auto.agentCatalog('mock').variants.map(variant => variant.id))
      .toEqual(['mock@mock-model-a', 'mock@mock-model-b'])
    const optedOut = JSON.parse(readFileSync(autoAgentsPath, 'utf-8')) as {
      agents: Array<{ autoDiscoverModels?: boolean }>
    }
    expect(optedOut.agents[0]?.autoDiscoverModels).toBe(false)
    await auto.shutdownAll()
  }, 30_000)

  it('does not auto-expose a corrected catalog after a poisoned model slot is healed', async () => {
    // A catalog persisted by the pre-fix parser: the model slot IS the effort
    // list, and auto-discovery had already exposed one of its values. The next
    // real observation corrects the identity; diffing the two lists would call
    // every real model "new" and flood the selection.
    const healCatalogPath = `${tmpdir()}/acp-catalog-heal-${Date.now()}.json`
    const healAgentsPath = `${tmpdir()}/acp-agents-heal-${Date.now()}.json`
    writeFileSync(healCatalogPath, JSON.stringify({
      version: 2,
      agents: {
        mock: {
          catalog: {
            model: {
              configId: 'reasoning_effort',
              name: 'Reasoning Effort',
              currentValue: 'xhigh',
              choices: [{ value: 'xhigh', name: 'Extra High' }, { value: 'low', name: 'Low' }],
            },
          },
          updatedAt: 1,
        },
      },
    }), 'utf-8')
    const healHub = new EventHub()
    const heal = new BridgeManager([{ ...def, exposedModels: ['xhigh'] }], healHub, 500, healAgentsPath, healCatalogPath)
    try {
      const start = await dispatchRpc(heal, 'session/start', { agentId: 'mock' })
      expect(start.ok).toBe(true)
      // The real selector replaces the poisoned identity...
      expect(heal.catalogFor('mock')?.model?.configId).toBe('model')
      expect(heal.catalogFor('mock')?.model?.choices.map(choice => choice.value))
        .toEqual(['mock-model-a', 'mock-model-b'])
      // ...without discovering both models: a changed slot identity is a
      // corrected reading, not an incremental catalog.
      expect(heal.agentCatalog('mock').variants).toEqual([])
      const defs = (heal as unknown as { defsMap: Map<string, AcpAgentDef> }).defsMap
      expect(defs.get('mock')?.exposedModels).toEqual(['xhigh'])
    } finally {
      await heal.shutdownAll()
    }
  }, 30_000)

  it('NEVER spawns an agent just because a catalog was read', async () => {
    // THE reported defect (user report, 2026-10-18): a conversation served by
    // `codebuddy` showed "Oh My Pi 已连接" in the agent picker — a second agent
    // process was running because opening the app probed EVERY configured
    // agent's catalog. `agentCatalog` is a RENDER path (the composer entries
    // call it on every store change), so a probe here means "open a page, start
    // N agents".
    //
    // The rule: reading is pure memory. A probe needs a gesture —
    // `agent/probe-models`, or a session the user is actually running.
    const spawnPath = `${tmpdir()}/acp-catalog-nospawn-${Date.now()}.json`
    // Two agents, neither with a cached catalog.
    const twoDefs = [{ ...def, id: 'nospawn-a' }, { ...def, id: 'nospawn-b' }]
    const gm = new BridgeManager(twoDefs, hub, 500, undefined, spawnPath)
    const stateOf = (id: string): string =>
      (gm.agentViews() as Array<{ id: string; state: string }>).find(agent => agent.id === id)?.state ?? 'missing'
    gm.bootstrapCatalogs()
    expect(stateOf('nospawn-a')).toBe('stopped')
    expect(stateOf('nospawn-b')).toBe('stopped')
    // Reading every agent's catalog — which the composer does on each render,
    // including for agents this conversation is not bound to — must not change
    // that.
    expect(gm.agentCatalog('nospawn-a').probed).toBe(false)
    expect(gm.agentCatalog('nospawn-b').probed).toBe(false)
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(stateOf('nospawn-a')).toBe('stopped')
    expect(stateOf('nospawn-b')).toBe('stopped')
    // The explicit gesture still works — that is the settings card's button.
    await gm.probeAgentModels('nospawn-b')
    expect(gm.agentCatalog('nospawn-b').probed).toBe(true)
    await gm.shutdownAll()
  }, 30_000)

  it('serves the agent\'s own current model and modes before any session exists', async () => {
    // What the composer reads for a conversation nobody has sent a message in
    // yet. Without these two the model chip has no label and the mode select
    // has no options, so both controls vanish on exactly the conversation the
    // user is setting up (user report, 2026-10-18).
    await catalogManager.probeAgentModels('mock')
    const seat = catalogManager.agentCatalog('mock')
    expect(seat.currentModel).toEqual({ value: 'mock-model-a', name: 'Mock Model A' })
    // `base` spells out the model that the bare route currently resolves to, so
    // the picker's checked row names a model rather than just the agent.
    expect(seat.base.name).toBe('Mock · Mock Model A')
    // The mock publishes no `category: 'mode'` select (it mirrors an agent that
    // only has the `session/new` modes field), so the field is absent rather
    // than empty — the browser must be able to tell the difference.
    expect(seat.mode).toBeUndefined()
  })
})
