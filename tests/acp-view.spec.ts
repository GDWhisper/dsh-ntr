/**
 * Browser-half pure helpers: the ACP route codec and the ACP view's diff.
 *
 * Both are logic with no DOM and no host: the codec must stay byte-identical to
 * the host's `splitAdapterModelId` (the one deliberate duplicate — see
 * src/client/acp-ui.tsx), and the diff renderer is what turns an ACP `diff`
 * payload into the only reviewable form the chat plane cannot show.
 */

import { describe, expect, it } from 'vitest'
import { ACP_PRESET_ID, acpModeFromPresetEvent, isAbsolutePathLike, joinPermissionSelect, placeMenu, rowAgentPreset, sessionHasOwnSelection, shouldShadowModelSeat, stagedSessionOf, splitAcpModelId } from '../src/client/acp-ui.tsx'
import type { AcpDirectoryState, AcpPermissionSelect } from '../src/client/acp-ui.tsx'
import { diffRows } from '../src/client/acp-view.tsx'
import { describeRoute, menuFor } from '../src/client/session-controls.tsx'
import { AcpStore } from '../src/client/store.ts'
import { isAbsolutePath, splitAdapterModelId } from '../src/impl.ts'
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

describe('isAbsolutePathLike', () => {
  const samples = [
    '/work',
    '/work/sub',
    'C:\\work',
    'C:/work',
    'c:/work/sub',
    '\\\\srv\\share',
    '//srv/share',
    '\\\\?\\C:\\x',
    'C:relative',
    'relative',
    'foo\\bar',
    '',
    'C:',
    '/',
    '.',
  ]

  it('agrees with the host isAbsolutePath it mirrors on every sample', () => {
    for (const sample of samples) {
      expect(isAbsolutePathLike(sample)).toBe(isAbsolutePath(sample))
    }
  })

  it('accepts POSIX, drive, and UNC forms and rejects drive-relative or plain-relative ones', () => {
    expect(isAbsolutePathLike('/work')).toBe(true)
    expect(isAbsolutePathLike('C:\\work')).toBe(true)
    expect(isAbsolutePathLike('//srv/share')).toBe(true)
    expect(isAbsolutePathLike('C:work')).toBe(false)
    expect(isAbsolutePathLike('relative')).toBe(false)
    // Extended-length/verbatim: the host's workspace guard cannot interpret it,
    // so the form must not bless a cwd that could never resolve.
    expect(isAbsolutePathLike('\\\\?\\C:\\x')).toBe(false)
    expect(isAbsolutePathLike('//?/C:/x')).toBe(false)
  })
})

describe('acpModeFromPresetEvent (the live preset frame)', () => {
  // The `agent-preset/selected` frame is `[sessionId, agentPreset]` and is the
  // ONLY race-free signal: the host's session-log cold read triggered from that
  // same frame still folds the PREVIOUS preset, which is what made the model
  // seat lag one switch behind until a page reload.
  it('takes the verdict off the frame’s own preset field', () => {
    expect(acpModeFromPresetEvent(ACP_PRESET_ID)).toBe(true)
    expect(acpModeFromPresetEvent('standard')).toBe(false)
    expect(acpModeFromPresetEvent('ptc')).toBe(false)
  })

  it('reads a missing or malformed field as "not ACP", never "definitely ACP"', () => {
    expect(acpModeFromPresetEvent(undefined)).toBe(false)
    expect(acpModeFromPresetEvent(null)).toBe(false)
    expect(acpModeFromPresetEvent('')).toBe(false)
    expect(acpModeFromPresetEvent(42)).toBe(false)
    expect(acpModeFromPresetEvent({ agentPreset: ACP_PRESET_ID })).toBe(false)
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

  it('derives the staged session from the rc.2 list shape (no `current` field)', () => {
    // DSH 0.1.7-rc.2's session controller ships `{ ids, byId, phase }` rows of
    // `{ id, retainedBy, projectionValues, origin }` — the staged session is
    // the row whose main-view retain count is positive, and the preset rides
    // `projectionValues.agentPreset` (verified against the shipped
    // dsh-api-session-controller; the old top-level fields do not exist).
    const rc2Row = (agentPreset?: string, extra: Record<string, unknown> = {}) => ({
      id: 'r1',
      retainedBy: { mainView: 1 },
      ...(agentPreset === undefined ? {} : { projectionValues: { agentPreset } }),
      ...extra,
    })
    expect(shouldShadowModelSeat({ byId: { r1: rc2Row(ACP_PRESET_ID) } })).toBe(true)
    expect(shouldShadowModelSeat({ byId: { r1: rc2Row('standard') } })).toBe(false)
    // Row silent (projections not folded yet): the host-side fallback answers.
    const ask = (id: string): boolean | undefined => (id === 'r1' ? true : undefined)
    expect(shouldShadowModelSeat({ byId: { r1: rc2Row() } }, ask)).toBe(true)
    expect(shouldShadowModelSeat({ byId: { r1: rc2Row() } })).toBe(false)
    // No row holds the main view (boot, or the list has not loaded): stand down.
    expect(shouldShadowModelSeat({ byId: { r1: rc2Row(ACP_PRESET_ID, { retainedBy: {} }) } })).toBe(false)
    expect(shouldShadowModelSeat({ byId: {} })).toBe(false)
    // An addressed subagent session is on stage: no ACP seat (its model RPCs
    // are refused), even though the row names the ACP preset.
    expect(shouldShadowModelSeat({ byId: { r1: rc2Row(ACP_PRESET_ID, { origin: 'subagent' }) } })).toBe(false)
    // Only the main-view row decides; a background ACP session does not leak
    // the takeover onto a staged non-ACP session.
    expect(shouldShadowModelSeat({
      byId: {
        r1: { id: 'r1', retainedBy: { mainView: 1 }, projectionValues: { agentPreset: 'standard' } },
        r2: { id: 'r2', retainedBy: {}, projectionValues: { agentPreset: ACP_PRESET_ID } },
      },
    })).toBe(false)
  })

  it('reads the staged session and its preset the same way the gate does', () => {
    // stagedSessionOf is the shared derivation (the ask gate in index.tsx uses
    // it too); rowAgentPreset is the preset accessor both spellings fold into.
    expect(stagedSessionOf({ current: 'old', byId: { old: { agentPreset: 'standard' } } }))
      .toEqual({ sessionId: 'old', row: { agentPreset: 'standard' }, subagent: false })
    expect(stagedSessionOf({ current: 'old' })?.sessionId).toBe('old')
    expect(stagedSessionOf({ current: 'old', currentAddress: { parent: 'p' } })?.subagent).toBe(true)
    const rc2 = stagedSessionOf({ byId: { r1: { id: 'r1', retainedBy: { mainView: 2 } } } })
    expect(rc2?.sessionId).toBe('r1')
    // With several qualifying rows the list's own `ids` order decides (display
    // order, not key insertion order), and a row that omits `id` still resolves
    // through its key.
    expect(stagedSessionOf({
      ids: ['b', 'a'],
      byId: { a: { id: 'a', retainedBy: { mainView: 1 } }, b: { id: 'b', retainedBy: { mainView: 1 } } },
    })?.sessionId).toBe('b')
    expect(stagedSessionOf({ byId: { r9: { retainedBy: { mainView: 1 } } } })?.sessionId).toBe('r9')
    expect(rowAgentPreset({ projectionValues: { agentPreset: ACP_PRESET_ID } })).toBe(ACP_PRESET_ID)
    expect(rowAgentPreset({ agentPreset: 'standard' })).toBe('standard')
    expect(rowAgentPreset(undefined)).toBeUndefined()
    expect(rowAgentPreset({})).toBeUndefined()
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

describe('the permissions projection shape (the picker must survive the real one)', () => {
  const acp = new AcpStore(async () => ({ ok: true, value: {} }), zh => zh)
  const agent: AgentView = {
    id: 'pi', title: 'Pi', command: 'pi-acp', args: [], permission: 'ask',
    allowedCwdRoots: [], state: 'ready', liveSessions: [],
  }
  const state: AcpDirectoryState = {
    current: { provider: 'acp', model: 'pi' },
    routable: true,
    groups: [],
    status: 'ready',
    error: null,
  }
  const base = { acp, agents: [agent], state }
  const routed = describeRoute(state, [agent], undefined)

  it('menuFor survives the runtime projection (selection only, no options)', () => {
    // What `projections.faceOf('permissions').getSnapshot()` ACTUALLY answers on
    // 0.1.7-rc.2: the projection's `viewSchema` is `{ currentValue }` — the rows
    // to switch to live in the process-level `permissionPresets.catalog`, a
    // different surface. Reading `options.length` off this value used to throw
    // inside the overlay entry's render, and a slot-entry crash ABIDATES the
    // picker for the rest of the session — the reported "ACP seat clicks do
    // nothing" symptom.
    const selection = { currentValue: 'workspace-write' } as unknown as AcpPermissionSelect
    expect(() => menuFor('seat', { ...base, route: routed, permissions: selection })).not.toThrow()
    const menu = menuFor('seat', { ...base, route: routed, permissions: selection })
    expect(menu.sections.map(s => s.id)).not.toContain('boundary')
  })

  it('joins the projection selection with the catalog rows', () => {
    // Absent selection = this host projects no boundary at all.
    expect(joinPermissionSelect(undefined, { options: [] })).toBeUndefined()
    expect(joinPermissionSelect('nonsense' as never, undefined)).toBeUndefined()
    // Absent catalog = no rows to offer, but the selection still reads true.
    expect(joinPermissionSelect({ currentValue: 'workspace-write' }, undefined))
      .toEqual({ options: [], currentValue: 'workspace-write' })
    // Garbage rows are dropped rather than rendered.
    expect(joinPermissionSelect({ currentValue: 'read-only' }, {
      options: [{ value: 'read-only', name: 'ReadOnly', description: 'r' }, { name: 'no value' }, null as never],
    })).toEqual({ options: [{ value: 'read-only', name: 'ReadOnly', description: 'r' }], currentValue: 'read-only' })
  })

  it('renders the boundary rows from the join, filtered and marked', () => {
    const joined = joinPermissionSelect({ currentValue: 'workspace-write' }, {
      options: [
        { value: 'workspace-write', name: 'Workspace' },
        { value: 'custom', name: 'Custom' },
        { value: 'danger-full-access', name: 'Full' },
      ],
    })!
    const menu = menuFor('seat', { ...base, route: routed, permissions: joined })
    const boundary = menu.sections.find(s => s.id === 'boundary')
    expect(boundary?.items.map(i => i.id)).toEqual(['workspace-write', 'danger-full-access'])
    expect(boundary?.items[0]?.active).toBe(true)
  })
})

describe('sessionHasOwnSelection (the gate\u2019s auto-route predicate)', () => {
  /** A `faceFor` stub whose `modelSelection` projection answers with one value. */
  function faceForReturning(value: unknown) {
    return (() => ({
      projections: { faceOf: () => ({ getSnapshot: () => value, subscribe: () => () => {} }) },
    })) as never
  }

  it('reports a session that already carries a route of its own', () => {
    expect(sessionHasOwnSelection(faceForReturning({ lastUsed: { provider: 'acp', model: 'pi' }, next: null }), 's1')).toBe(true)
    expect(sessionHasOwnSelection(faceForReturning({ lastUsed: null, next: { provider: 'deepseek', model: 'x' } }), 's1')).toBe(true)
  })

  it('reports a never-selected session as free to route', () => {
    expect(sessionHasOwnSelection(faceForReturning({ lastUsed: null, next: null }), 's1')).toBe(false)
  })

  it('returns undefined when the projection cannot be read at all', () => {
    // An older runtime without the projection, or an addressed subagent route:
    // the gate must leave the session alone (re-asking on the next tick) rather
    // than decide "never selected" from a missing answer.
    expect(sessionHasOwnSelection(faceForReturning(undefined), 's1')).toBeUndefined()
    expect(sessionHasOwnSelection(faceForReturning('nonsense'), 's1')).toBeUndefined()
    expect(sessionHasOwnSelection((() => { throw new Error('no face') }) as never, 's1')).toBeUndefined()
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

describe('placeMenu (the picker docks to the control that opened it)', () => {
  const menu = { width: 360, height: 200 }
  const viewport = { width: 1200, height: 800 }

  it('docks right-aligned above the trigger', () => {
    // The ACP seat sits in the composer's trailing row: the menu's right edge
    // lands on the seat's, floating just above it — NOT at the card's top-left
    // (where the overlay anchor parks it by default).
    expect(placeMenu({ left: 800, right: 900, top: 500, bottom: 530 }, menu, viewport))
      .toEqual({ x: 540, y: 292 })
  })

  it('flips below the trigger when the top has no room', () => {
    expect(placeMenu({ left: 800, right: 900, top: 40, bottom: 70 }, menu, viewport))
      .toEqual({ x: 540, y: 78 })
  })

  it('slides left at the right edge and stops at the left edge', () => {
    expect(placeMenu({ left: 1100, right: 1195, top: 500, bottom: 530 }, menu, viewport).x).toBe(832)
    expect(placeMenu({ left: 5, right: 100, top: 500, bottom: 530 }, menu, viewport).x).toBe(8)
  })

  it('clamps to the viewport when even the flip cannot fit', () => {
    // Short viewport: below the trigger would overflow the bottom, so the menu
    // settles against the bottom edge instead of hanging out of the window.
    expect(placeMenu({ left: 800, right: 900, top: 10, bottom: 40 }, menu, { width: 1200, height: 250 }))
      .toEqual({ x: 540, y: 42 })
  })
})
