/**
 * Browser-half pure helpers: the ACP route codec and the ACP view's diff.
 *
 * Both are logic with no DOM and no host: the codec must stay byte-identical to
 * the host's `splitAdapterModelId` (the one deliberate duplicate — see
 * src/client/acp-ui.tsx), and the diff renderer is what turns an ACP `diff`
 * payload into the only reviewable form the chat plane cannot show.
 */

import { describe, expect, it } from 'vitest'
import { ACP_PRESET_ID, acpModeFromPresetEvent, formatCommandLine, isAbsolutePathLike, placeMenu, rowAgentPreset, splitAcpModelId, splitCommandLine, stagedIsAcpMode, stagedSessionOf, tokenizeCommandLine } from '../src/client/acp-ui.tsx'
import { diffRows } from '../src/client/acp-view.tsx'
import { describeRoute, menuFor } from '../src/client/session-controls.tsx'
import { AcpStore } from '../src/client/store.ts'
import { isAbsolutePath, splitAdapterModelId, splitCommandLine as hostSplitCommandLine, tokenizeCommandLine as hostTokenizeCommandLine } from '../src/impl.ts'
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

/**
 * The connection form's 命令 field is ONE command line, and the panel parses it
 * to show "程序 / 参数" before saving. The host re-parses the same string in
 * `validateAgentDef`, so a preview that disagrees with the host would be worse
 * than no preview — the samples below are the shared truth.
 */
describe('command-line parsing (browser ⇄ host hand copy)', () => {
  const samples = [
    'codebuddy --acp',
    'omp',
    'pi-acp',
    'npx -y @tencent-ai/codebuddy-code --acp',
    '  omp   acp  ',
    '"C:\\Program Files\\nodejs\\node.exe" --acp',
    "'my agent' --flag value",
    'cmd /c "a b"',
    'say "\\"hi\\""',
    'a "" b',
    '""',
    '"',
    'has space',
    '',
    '   ',
  ]

  it('splits and tokenizes exactly like the host implementation it mirrors', () => {
    for (const sample of samples) {
      expect(splitCommandLine(sample)).toEqual(hostSplitCommandLine(sample))
      expect(tokenizeCommandLine(sample)).toEqual(hostTokenizeCommandLine(sample))
    }
  })

  it('round-trips a stored def through the field, quoting only what needs it', () => {
    expect(formatCommandLine('codebuddy', ['--acp'])).toBe('codebuddy --acp')
    expect(splitCommandLine(formatCommandLine('C:\\Program Files\\x.exe', ['a b']))).toEqual({
      command: 'C:\\Program Files\\x.exe',
      args: ['a b'],
    })
    expect(splitCommandLine(formatCommandLine('omp', ['acp']))).toEqual({ command: 'omp', args: ['acp'] })
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

describe('stagedIsAcpMode (does the staged conversation run the ACP preset)', () => {
  const row = (agentPreset?: string): { agentPreset?: string } => (agentPreset === undefined ? {} : { agentPreset })

  it('answers true only for an ACP-preset session', () => {
    const byId = { a: row(ACP_PRESET_ID), b: row('standard'), c: row() }
    expect(stagedIsAcpMode({ current: 'a', byId })).toBe(true)
    expect(stagedIsAcpMode({ current: 'b', byId })).toBe(false)
    // No preset recorded (a deployment without presets) is not ACP mode.
    expect(stagedIsAcpMode({ current: 'c', byId })).toBe(false)
  })

  it('fails open for everything it cannot read', () => {
    expect(stagedIsAcpMode(undefined)).toBe(false)
    expect(stagedIsAcpMode({})).toBe(false)
    expect(stagedIsAcpMode({ current: 'gone', byId: {} })).toBe(false)
    expect(stagedIsAcpMode({ current: 'a', byId: {} })).toBe(false)
    // An addressed subagent route is not a conversation this plugin drives.
    expect(stagedIsAcpMode({ current: 'a', byId: { a: row(ACP_PRESET_ID) }, currentAddress: { parent: 'p' } })).toBe(false)
  })

  it('falls back to the host-side report when the session row carries no preset', () => {
    // Older client runtimes ship session rows without `agentPreset` at all
    // (observed on DSH 0.1.5-rc.2: every row undefined) — there the plugin's
    // own host report is the only fact source.
    const silentRow = { a: row() }
    const verdicts: Record<string, boolean | undefined> = { a: true, b: false }
    const ask = (sessionId: string): boolean | undefined => verdicts[sessionId]
    expect(stagedIsAcpMode({ current: 'a', byId: silentRow }, ask)).toBe(true)
    expect(stagedIsAcpMode({ current: 'b', byId: silentRow }, ask)).toBe(false)
    // No verdict held yet (ask still in flight, or an older host half): the
    // fallback reads as "not ACP" — the allowed failure mode.
    expect(stagedIsAcpMode({ current: 'x', byId: silentRow }, ask)).toBe(false)
    expect(stagedIsAcpMode({ current: 'a', byId: silentRow })).toBe(false)
  })

  it('lets an explicit non-ACP row win over the host-side report', () => {
    // The runtime row is the fresher fold (it tracks `agent-preset/selected`);
    // a stale host verdict must not override a row that names another preset.
    const verdicts = (): boolean | undefined => true
    expect(stagedIsAcpMode({ current: 'b', byId: { b: row('standard') } }, verdicts)).toBe(false)
    expect(stagedIsAcpMode({ current: 'b', byId: { b: row(ACP_PRESET_ID) } }, verdicts)).toBe(true)
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
    expect(stagedIsAcpMode({ byId: { r1: rc2Row(ACP_PRESET_ID) } })).toBe(true)
    expect(stagedIsAcpMode({ byId: { r1: rc2Row('standard') } })).toBe(false)
    // Row silent (projections not folded yet): the host-side fallback answers.
    const ask = (id: string): boolean | undefined => (id === 'r1' ? true : undefined)
    expect(stagedIsAcpMode({ byId: { r1: rc2Row() } }, ask)).toBe(true)
    expect(stagedIsAcpMode({ byId: { r1: rc2Row() } })).toBe(false)
    // No row holds the main view (boot, or the list has not loaded): stand down.
    expect(stagedIsAcpMode({ byId: { r1: rc2Row(ACP_PRESET_ID, { retainedBy: {} }) } })).toBe(false)
    expect(stagedIsAcpMode({ byId: {} })).toBe(false)
    // An addressed subagent session is on stage, even though the row names the
    // ACP preset.
    expect(stagedIsAcpMode({ byId: { r1: rc2Row(ACP_PRESET_ID, { origin: 'subagent' }) } })).toBe(false)
    // Only the main-view row decides; a background ACP session does not leak
    // the verdict onto a staged non-ACP session.
    expect(stagedIsAcpMode({
      byId: {
        r1: { id: 'r1', retainedBy: { mainView: 1 }, projectionValues: { agentPreset: 'standard' } },
        r2: { id: 'r2', retainedBy: {}, projectionValues: { agentPreset: ACP_PRESET_ID } },
      },
    })).toBe(false)
  })

  it('reads the staged session and its preset the same way the surfaces do', () => {
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

describe('ACP composer picker (agent / its models / its thought level)', () => {
  const acp = new AcpStore(async () => ({ ok: true, value: {} }), zh => zh)
  const agent: AgentView = {
    id: 'pi', title: 'Pi', command: 'pi-acp', args: [], permission: 'ask',
    allowedCwdRoots: [], state: 'ready', liveSessions: [],
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
  /** The conversation's own binding — the host's record of who serves it. */
  const bound: ChatSessionView = { agentId: 'pi', agentTitle: 'Pi', sessionId: 's1', modelId: 'pi' }
  const base = { acp, agents: [agent], catalog }
  const routed = describeRoute([agent], bound, undefined, catalog)
  const modes = { currentModeId: 'plan', availableModes: [{ id: 'plan', name: 'Plan' }, { id: 'acceptEdits', name: 'Accept edits' }] }

  it('offers ONLY the agent roster in the agent base', () => {
    // The base is the entry point for "who serves this conversation" and
    // nothing else (user decision, 2026-10-17). Every other axis the agent
    // publishes has its own control, so seeing it stacked in here too meant
    // two entries for one setting and a four-section dump behind one gesture.
    const menu = menuFor('agent', { ...base, route: routed, agentModes: modes })
    expect(menu.sections.map(section => section.id)).toEqual(['agent'])
    expect(menu.sections[0]?.items[0]).toMatchObject({ id: 'pi', active: true, dot: '#22c55e' })
    // The agent's own modes are adjacent to the roster but NOT in this menu:
    // they belong to the composer-mode select alone.
    expect(menu.sections.some(section => section.id === 'agent-mode')).toBe(false)
  })

  it('shows the base entry plus the exposed variants in the MODEL picker', () => {
    // The model axis did not disappear — it moved to its own chip, which is
    // where the model control reads it from.
    const menu = menuFor('model', { ...base, route: routed })
    const models = menu.sections[0]
    // The bare `agentId` row (the agent's default model) is never filtered out;
    // everything after it is what `exposedModels` let through.
    expect(models?.items.map(item => item.id)).toEqual(['pi', 'pi@claude-sonnet-4'])
    expect(models?.items[0]).toMatchObject({ label: 'Pi · 默认', active: true })
  })

  it('offers the thought levels in the THOUGHT picker, and only there', () => {
    const thought = menuFor('thought', { ...base, route: routed })
    expect(thought.sections[0]?.items.map(item => item.id)).toEqual(['provider-default', 'high'])
    expect(menuFor('agent', { ...base, route: routed }).sections.map(s => s.id)).toEqual(['agent'])
  })

  it('labels a variant route from the agent catalog, not a DSH directory', () => {
    const onVariant = describeRoute([agent], { ...bound, modelId: 'pi@claude-sonnet-4' }, undefined, catalog)
    expect(onVariant.modelLabel).toBe('Pi · Claude Sonnet 4')
    expect(onVariant.efforts.map(e => e.id)).toEqual(['high'])
    // No effort of its own yet: the agent's own default applies.
    expect(onVariant.effectiveEffort).toBe('high')
    // A variant the agent dropped still labels itself instead of vanishing.
    const stale = describeRoute([agent], { ...bound, modelId: 'pi@gone' }, undefined, catalog)
    expect(stale.modelLabel).toBe('gone')
  })

  it('renders the bare route from the catalog when nothing else is known', () => {
    // Without the agent catalog the roster title is what we can honestly show.
    const withoutCatalog = describeRoute([agent], bound, undefined)
    expect(withoutCatalog).toMatchObject({ agentId: 'pi', agentTitle: 'Pi', modelLabel: 'Pi', efforts: [] })
    // A binding naming an agent the roster no longer has still labels itself.
    const unknownAgent = describeRoute([], { ...bound, agentId: 'ghost', modelId: 'ghost@x' }, undefined)
    expect(unknownAgent.modelLabel).toBe('x')
  })

  it('shows the recorded binding before the live session has caught up', () => {
    // The click recorded 'omp' for this conversation, but the live session list
    // still names 'pi' — a switch applies from the NEXT message, and until that
    // turn materializes a session for the new agent the chip must read 'omp',
    // not the previous agent (that lag is exactly what read as "clicking does
    // nothing"). An unknown binding id falls through to the live session.
    const switched = describeRoute([agent, { ...agent, id: 'omp', title: 'Omp' }], bound, undefined, catalog, 'omp')
    expect(switched.agentId).toBe('omp')
    expect(switched.agentTitle).toBe('Omp')
    const ghost = describeRoute([agent], bound, undefined, catalog, 'ghost')
    expect(ghost.agentId).toBe('pi')
    // No binding: the live session decides (the pre-binding behavior).
    expect(describeRoute([agent], bound, undefined, catalog).agentId).toBe('pi')
  })

  it('drops the axes the agent does not publish', () => {
    const silent: AgentCatalogResult = { ...catalog, variants: [], reasoning: undefined }
    const route = describeRoute([agent], bound, undefined, silent)
    // The base never carries these axes any more — it is the roster, full stop.
    expect(menuFor('agent', { acp, agents: [agent], catalog: silent, route }).sections.map(s => s.id)).toEqual(['agent'])
    // The MODEL picker still degrades honestly: `variants: []` means the base
    // row is all this agent offers, which is exactly one row — not an error.
    expect(menuFor('model', { acp, agents: [agent], catalog: silent, route }).sections[0]?.items.map(item => item.id))
      .toEqual(['pi'])
    const noCatalog = describeRoute([agent], bound, undefined)
    const fallback = menuFor('model', { acp, agents: [agent], route: noCatalog })
    expect(fallback.sections[0]?.items.map(item => item.id)).toEqual(['pi'])
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
    // conversation runs something else: the route still resolves, so it stays as
    // a marked row above the offered ones.
    const hidden = describeRoute([agent], { ...bound, modelId: 'pi@gone' }, undefined, catalog)
    const menu = menuFor('model', { acp, agents: [agent], catalog, route: hidden })
    expect(menu.sections[0]?.items.map(item => item.id)).toEqual(['pi@gone', 'pi', 'pi@claude-sonnet-4'])
    expect(menu.sections[0]?.items[0]).toMatchObject({ active: true })
    // The default route is the base row itself — never duplicated.
    const onDefault = menuFor('model', { ...base, route: routed })
    expect(onDefault.sections[0]?.items.map(item => item.id)).toEqual(['pi', 'pi@claude-sonnet-4'])
  })

  it('points an unfiltered agent at the exposure editor instead of looking broken', () => {
    const unfiltered: AgentCatalogResult = { ...catalog, variants: [] }
    const model = menuFor('model', { acp, agents: [agent], catalog: unfiltered, route: describeRoute([agent], bound, undefined, unfiltered) })
    expect(model.note).toMatch(/设置 → ACP 代理/)
  })

  it('keeps the agent named when the binding is released, so the picker can offer a way back', () => {
    const released = describeRoute([agent], { ...bound, released: true }, undefined, catalog)
    expect(released).toMatchObject({ agentId: 'pi', agentTitle: 'Pi' })
    // The base still answers "who serves this" even for a released session;
    // the rest of the axes live in their own pickers.
    expect(menuFor('agent', { ...base, route: released }).sections.map(s => s.id)).toEqual(['agent'])
  })

  it('offers only the roster when no agent is known yet', () => {
    // The plugin's own default points nowhere (no agents configured, or the
    // star names a deleted one): there is nothing to describe.
    const nothing = describeRoute([], undefined, undefined)
    expect(nothing.agentId).toBeUndefined()
    expect(menuFor('agent', { acp, agents: [], route: nothing }).sections.map(s => s.id)).toEqual(['agent'])
    // No agents at all: the menu says so instead of rendering an empty list.
    expect(menuFor('agent', { acp, agents: [], route: nothing }).sections[0]?.items[0])
      .toMatchObject({ id: 'none', disabled: true })
  })

  it('offers the roster for a conversation with no binding yet', () => {
    // The plugin's own default names a real agent, so the agent axis is live —
    // but no ACP session has run, so nothing describes "which model is current".
    const fresh = describeRoute([agent], undefined, 'pi', catalog)
    expect(fresh).toMatchObject({ agentId: 'pi', agentTitle: 'Pi' })
    expect(fresh.modelId).toBeUndefined()
    // The base lists the roster only; the models this agent OFFERS are readable
    // before the first turn — through the model chip's own picker.
    expect(menuFor('agent', { ...base, route: fresh }).sections.map(s => s.id)).toEqual(['agent'])
    expect(menuFor('model', { ...base, route: fresh }).sections[0]?.items.map(i => i.id))
      .toEqual(['pi', 'pi@claude-sonnet-4'])
    // No effort axis: nothing has run, so there is no current effort to mark.
    expect(menuFor('agent', { ...base, route: fresh }).sections.map(s => s.id)).not.toContain('thought')
  })
})

describe('the picker survives a host projection that is not what we assumed', () => {
  const acp = new AcpStore(async () => ({ ok: true, value: {} }), zh => zh)
  const agent: AgentView = {
    id: 'pi', title: 'Pi', command: 'pi-acp', args: [], permission: 'ask',
    allowedCwdRoots: [], state: 'ready', liveSessions: [],
  }
  const routed = describeRoute([agent], { agentId: 'pi', sessionId: 's1' }, undefined)

  it('menuFor never throws when the session face answers a shape we did not expect', () => {
    // What `projections.faceOf('permissions').getSnapshot()` ACTUALLY answers on
    // 0.1.7-rc.2: the projection's `viewSchema` is `{ currentValue }` — nothing
    // else. Reading `options.length` off that value used to throw inside the
    // overlay entry's render, and a slot-entry crash ABIDATES the picker for the
    // rest of the session — the reported "ACP seat clicks do nothing" symptom.
    // The boundary section is gone with the permission axis (the agent decides
    // its own approvals), so the picker now carries no projection at all — but
    // the discipline holds: every field it builds from is checked before use.
    for (const face of [undefined, null, 'nonsense', 42, {}, { currentValue: 7 }]) {
      expect(() => menuFor('agent', { acp, agents: [agent], route: routed, ...(face === undefined ? {} : { agentModes: face as never }) }))
        .not.toThrow()
    }
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
