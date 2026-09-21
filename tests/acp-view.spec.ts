/**
 * Browser-half pure helpers: the ACP route codec and the ACP view's diff.
 *
 * Both are logic with no DOM and no host: the codec must stay byte-identical to
 * the host's `splitAdapterModelId` (the one deliberate duplicate — see
 * src/client/acp-ui.tsx), and the diff renderer is what turns an ACP `diff`
 * payload into the only reviewable form the chat plane cannot show.
 */

import { describe, expect, it } from 'vitest'
import { ACP_PRESET_ID, shouldShadowModelSeat, splitAcpModelId } from '../src/client/acp-ui.tsx'
import type { AcpDirectoryState, AcpPermissionSelect } from '../src/client/acp-ui.tsx'
import { diffRows } from '../src/client/acp-view.tsx'
import { describeRoute, menuFor } from '../src/client/session-controls.tsx'
import { AcpStore } from '../src/client/store.ts'
import { splitAdapterModelId } from '../src/impl.ts'
import type { AgentCatalogResult, AgentView, ChatSessionView } from '../src/protocol.ts'

describe('splitAcpModelId', () => {
  const samples = [
    'pi',
    'pi@claude-sonnet-4',
    'pi@vendor/model:free',
    'codebuddy@hy3',
    'a.b-c_d@x@y',
    '',
    '@leading',
    'no-choice@',
  ]

  it('stays identical to the host codec it mirrors', () => {
    for (const model of samples) {
      expect(splitAcpModelId(model)).toEqual(splitAdapterModelId(model))
    }
  })

  it('splits on the first @ so a choice may contain one', () => {
    expect(splitAcpModelId('pi@a@b')).toEqual({ agentId: 'pi', choice: 'a@b' })
    expect(splitAcpModelId('pi')).toEqual({ agentId: 'pi' })
  })
})

describe('shouldShadowModelSeat (the ACP-mode model seat gate)', () => {
  const row = (agentPreset?: string): { agentPreset?: string } => (agentPreset === undefined ? {} : { agentPreset })

  it('takes the seat over only for an ACP-preset session', () => {
    const byId = { a: row(ACP_PRESET_ID), b: row('standard'), c: row() }
    expect(shouldShadowModelSeat({ current: 'a', byId })).toBe(true)
    expect(shouldShadowModelSeat({ current: 'b', byId })).toBe(false)
    // No preset recorded (a deployment without presets) is not ACP mode.
    expect(shouldShadowModelSeat({ current: 'c', byId })).toBe(false)
  })

  it('fails open for everything it cannot read', () => {
    expect(shouldShadowModelSeat(undefined)).toBe(false)
    expect(shouldShadowModelSeat({})).toBe(false)
    expect(shouldShadowModelSeat({ current: 'gone', byId: {} })).toBe(false)
    expect(shouldShadowModelSeat({ current: 'a', byId: {} })).toBe(false)
    // An addressed subagent route refuses the Agent-bound model RPCs, so the
    // native seat's own behaviour is what that route gets.
    expect(shouldShadowModelSeat({ current: 'a', byId: { a: row(ACP_PRESET_ID) }, currentAddress: { parent: 'p' } })).toBe(false)
  })

  it('falls back to the host-side report when the session row carries no preset', () => {
    // Older client runtimes ship session rows without `agentPreset` at all
    // (observed on DSH 0.1.5-rc.2: every row undefined) — there the plugin's
    // own host report is the only fact source the takeover has.
    const silentRow = { a: row() }
    const verdicts: Record<string, boolean | undefined> = { a: true, b: false }
    const ask = (sessionId: string): boolean | undefined => verdicts[sessionId]
    expect(shouldShadowModelSeat({ current: 'a', byId: silentRow }, ask)).toBe(true)
    expect(shouldShadowModelSeat({ current: 'b', byId: silentRow }, ask)).toBe(false)
    // No verdict held yet (ask still in flight, or an older host half): the
    // fallback reads as "not ACP", which keeps the native seat — the allowed
    // failure mode.
    expect(shouldShadowModelSeat({ current: 'x', byId: silentRow }, ask)).toBe(false)
    expect(shouldShadowModelSeat({ current: 'a', byId: silentRow })).toBe(false)
  })

  it('lets an explicit non-ACP row win over the host-side report', () => {
    // The runtime row is the fresher fold (it tracks `agent-preset/selected`);
    // a stale host verdict must not shadow a row that names another preset.
    const verdicts = (): boolean | undefined => true
    expect(shouldShadowModelSeat({ current: 'b', byId: { b: row('standard') } }, verdicts)).toBe(false)
    expect(shouldShadowModelSeat({ current: 'b', byId: { b: row(ACP_PRESET_ID) } }, verdicts)).toBe(true)
  })
})

describe('ACP model seat picker', () => {
  const acp = new AcpStore(async () => ({ ok: true, value: {} }), zh => zh)
  const agent: AgentView = {
    id: 'pi', title: 'Pi', command: 'pi-acp', args: [], permission: 'ask',
    allowedCwdRoots: [], state: 'ready', liveSessions: [],
  }
  const state: AcpDirectoryState = {
    current: { provider: 'acp', model: 'pi' },
    routable: true,
    // The directory still carries groups (it is DSH's global catalog), but the
    // ACP surfaces never read the `acp` group out of it: the route advertises
    // no models, so the agent's own surface is `agent/catalog` below.
    groups: [],
    status: 'ready',
    error: null,
  }
  /** What `agent/catalog` answers for this agent (`exposedModels` already applied). */
  const catalog: AgentCatalogResult = {
    agentId: 'pi',
    title: 'Pi',
    base: { id: 'pi', name: 'Pi' },
    variants: [{ id: 'pi@claude-sonnet-4', name: 'Pi · Claude Sonnet 4' }],
    reasoning: { efforts: [{ id: 'high', name: 'High' }], defaultEffort: 'high' },
    probed: true,
    updatedAt: 1,
  }
  const base = { acp, agents: [agent], state, catalog }
  const routed = describeRoute(state, [agent], undefined, catalog)
  const permissions: AcpPermissionSelect = { options: [{ value: 'workspace-write', name: 'Workspace' }], currentValue: 'workspace-write' }

  it('stacks all three axes plus the boundary in one screen', () => {
    const menu = menuFor('seat', { ...base, route: routed, permissions })
    expect(menu.sections.map(section => section.id)).toEqual(['agent', 'model', 'thought', 'boundary'])
    expect(menu.sections[0]?.items[0]).toMatchObject({ id: 'pi', active: true, dot: '#22c55e' })
    expect(menu.sections[2]?.items.map(item => item.id)).toEqual(['provider-default', 'high'])
    expect(menu.sections[3]?.items[0]).toMatchObject({ id: 'workspace-write', active: true })
  })

  it('offers the base entry plus the exposed variants, and nothing else', () => {
    const menu = menuFor('seat', { ...base, route: routed })
    const models = menu.sections.find(section => section.id === 'model')
    // The bare `agentId` row (the agent's default model) is never filtered out;
    // everything after it is what `exposedModels` let through.
    expect(models?.items.map(item => item.id)).toEqual(['pi', 'pi@claude-sonnet-4'])
    expect(models?.items[0]).toMatchObject({ label: 'Pi · 默认', active: true })
  })

  it('labels a variant route from the agent catalog, not the directory', () => {
    const onVariant = describeRoute({ ...state, current: { provider: 'acp', model: 'pi@claude-sonnet-4' } }, [agent], undefined, catalog)
    expect(onVariant.modelLabel).toBe('Pi · Claude Sonnet 4')
    expect(onVariant.efforts.map(e => e.id)).toEqual(['high'])
    expect(onVariant.effectiveEffort).toBe('high')
    // A variant the agent dropped still labels itself instead of vanishing.
    const stale = describeRoute({ ...state, current: { provider: 'acp', model: 'pi@gone' } }, [agent], undefined, catalog)
    expect(stale.modelLabel).toBe('gone')
  })

  it('renders the bare route from the catalog without any directory group', () => {
    // No ACP group anywhere in the directory: without the agent catalog the
    // seat falls back to the roster title, which is still honest.
    const withoutCatalog = describeRoute(state, [agent], undefined)
    expect(withoutCatalog).toMatchObject({ routed: true, agentTitle: 'Pi', modelLabel: 'Pi', efforts: [] })
    const unknownAgent = describeRoute({ ...state, current: { provider: 'acp', model: 'ghost' } }, [], undefined)
    expect(unknownAgent.modelLabel).toBe('ghost')
  })

  it('drops the axes the agent does not publish', () => {
    const silent: AgentCatalogResult = { ...catalog, variants: [], reasoning: undefined }
    const route = describeRoute(state, [agent], undefined, silent)
    expect(menuFor('seat', { acp, agents: [agent], state, catalog: silent, route }).sections.map(s => s.id)).toEqual(['agent', 'model'])
    // …and when the catalog itself is missing, the route's own id is the row.
    const noCatalog = describeRoute(state, [agent], undefined)
    const fallback = menuFor('seat', { acp, agents: [agent], state, route: noCatalog })
    expect(fallback.sections.find(section => section.id === 'model')?.items.map(item => item.id)).toEqual(['pi'])
  })

  it('keeps the single-axis pickers header-shaped as before', () => {
    const model = menuFor('model', { ...base, route: routed })
    expect(model.note).toBeDefined()
    expect(model.sections.map(s => s.id)).toEqual(['model'])
    expect(model.sections[0]?.title).toBeUndefined()
    expect(model.sections[0]?.items[0]).toMatchObject({ id: 'pi', label: 'Pi · 默认' })
  })

  it('marks a current route the exposure filter no longer lists', () => {
    // Unchecking a model in the settings must not make the picker look like the
    // session runs something else: the route still resolves, so it stays as a
    // marked row above the offered ones.
    const hidden = describeRoute({ ...state, current: { provider: 'acp', model: 'pi@gone' } }, [agent], undefined, catalog)
    const menu = menuFor('model', { acp, agents: [agent], state, catalog, route: hidden })
    expect(menu.sections[0]?.items.map(item => item.id)).toEqual(['pi@gone', 'pi', 'pi@claude-sonnet-4'])
    expect(menu.sections[0]?.items[0]).toMatchObject({ active: true })
    // The default route is the base row itself — never duplicated.
    const onDefault = menuFor('model', { ...base, route: routed })
    expect(onDefault.sections[0]?.items.map(item => item.id)).toEqual(['pi', 'pi@claude-sonnet-4'])
  })

  it('points an unfiltered agent at the exposure editor instead of looking broken', () => {
    const unfiltered: AgentCatalogResult = { ...catalog, variants: [] }
    const model = menuFor('model', { acp, agents: [agent], state, catalog: unfiltered, route: describeRoute(state, [agent], undefined, unfiltered) })
    expect(model.note).toMatch(/设置 → ACP 代理/)
  })

  it('keeps the agent named after the route leaves ACP, so the seat can warn', () => {
    const bound: ChatSessionView = { agentId: 'pi', agentTitle: 'Pi', sessionId: 's1' }
    const elsewhere = describeRoute({ ...state, current: { provider: 'deepseek', model: 'chat' } }, [], bound, catalog)
    expect(elsewhere).toMatchObject({ routed: false, agentId: 'pi', agentTitle: 'Pi' })
    // The roster and the agent's models stay offered: they ARE the way back.
    const menu = menuFor('seat', { ...base, route: elsewhere })
    expect(menu.sections.map(s => s.id)).toEqual(['agent', 'model'])
    expect(menu.sections[0]?.items[0]?.active).toBe(false)
  })

  it('offers only the roster when nothing has been bound yet', () => {
    const elsewhere = describeRoute({ ...state, current: { provider: 'deepseek', model: 'chat' } }, [], undefined, catalog)
    expect(elsewhere).toMatchObject({ routed: false })
    expect(menuFor('seat', { ...base, route: elsewhere }).sections.map(s => s.id)).toEqual(['agent'])
  })
})

describe('diffRows (ACP view)', () => {
  const textOf = (rows: ReturnType<typeof diffRows>): string =>
    rows.map(row => `${row.sign}${row.text}`).join('\n')

  it('marks a pure addition and a pure removal', () => {
    expect(diffRows(null, 'a\nb')).toEqual([
      { sign: '+', text: 'a' },
      { sign: '+', text: 'b' },
    ])
    expect(diffRows('a\nb', '')).toEqual([
      { sign: '-', text: 'a' },
      { sign: '-', text: 'b' },
    ])
  })

  it('keeps unchanged context and aligns a one-line edit', () => {
    expect(diffRows('a\nb\nc\n', 'a\nB\nc\n')).toEqual([
      { sign: ' ', text: 'a' },
      { sign: '-', text: 'b' },
      { sign: '+', text: 'B' },
      { sign: ' ', text: 'c' },
    ])
  })

  it('handles an inserted line in the middle', () => {
    expect(textOf(diffRows('one\ntwo', 'one\nmiddle\ntwo'))).toBe(' one\n+middle\n two')
  })

  it('reports identical payloads as context only', () => {
    expect(diffRows('same\n', 'same\n').every(row => row.sign === ' ')).toBe(true)
  })

  it('trims a shared head and tail before diffing the middle', () => {
    const rows = diffRows('keep\nold\nkeep2', 'keep\nnew\nkeep2')
    expect(textOf(rows)).toBe(' keep\n-old\n+new\n keep2')
  })

  it('falls back to remove-then-add past the matrix cap instead of blowing up', () => {
    const before = Array.from({ length: 400 }, (_, index) => `old ${String(index)}`).join('\n')
    const after = Array.from({ length: 400 }, (_, index) => `new ${String(index)}`).join('\n')
    const rows = diffRows(before, after)
    expect(rows.filter(row => row.sign === '-')).toHaveLength(400)
    expect(rows.filter(row => row.sign === '+')).toHaveLength(400)
    // Removals precede the additions: the fallback is a replacement block.
    expect(rows[399]?.sign).toBe('-')
    expect(rows[400]?.sign).toBe('+')
  })
})
