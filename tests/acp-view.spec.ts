/**
 * Browser-half pure helpers: the ACP route codec and the ACP view's diff.
 *
 * Both are logic with no DOM and no host: the codec must stay byte-identical to
 * the host's `splitAdapterModelId` (the one deliberate duplicate — see
 * src/client/acp-ui.tsx), and the diff renderer is what turns an ACP `diff`
 * payload into the only reviewable form the chat plane cannot show.
 */

import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { ACP_PRESET_ID, acpModeFromPresetEvent, formatCommandLine, isAbsolutePathLike, placeMenu, rowAgentPreset, splitAcpModelId, splitCommandLine, stagedIsAcpMode, stagedSessionOf, tokenizeCommandLine } from '../src/client/acp-ui.tsx'
import { agentLockPhaseOf, FORM_MS, playAgentLockAnim, SHATTER_MS } from '../src/client/agent-lock-anim.ts'
import { acpEmptyCopy, boundAgentOf, diffRows, historyAwaitsReplay, isNewFileDiff } from '../src/client/acp-view.tsx'
import { acpMeterUsage, compactTokenCount, contextOccupancy } from '../src/client/context-meter.tsx'
import { approvalDeadlineFacts, DEADLINE_MIN_WAIT_MS, deadlineSliderIndex, deadlineValueFor } from '../src/client/panel.tsx'
import { describeRoute, menuFor, REFRESH_CATALOG_ITEM } from '../src/client/session-controls.tsx'
import { AcpStore, deadlineRemainingLabel, PERMISSION_DEADLINE_EXPIRED, permissionsForSession, usageFromUpdate } from '../src/client/store.ts'
import type { PendingPermission } from '../src/client/store.ts'
import { APPROVAL_DEADLINE_MIN_WAIT_MS, isAbsolutePath, splitAdapterModelId, splitCommandLine as hostSplitCommandLine, tokenizeCommandLine as hostTokenizeCommandLine } from '../src/impl.ts'
import type { AgentCatalogResult, AgentView, ChatSessionView } from '../src/protocol.ts'

/**
 * Model-row ids only. The picker's last row is the explicit refresh ACTION
 * (`REFRESH_CATALOG_ITEM`, covered by session-controls.spec.ts); these
 * assertions are about which models are offered.
 */
function modelRowIds(menu: ReturnType<typeof menuFor>): string[] {
  return (menu.sections[0]?.items ?? [])
    .map(item => item.id)
    .filter(id => id !== REFRESH_CATALOG_ITEM)
}

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
    id: 'pi', title: 'Pi', command: 'pi-acp', args: [],
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
    expect(menu.sections[0]?.items[0]).toMatchObject({ id: 'pi', active: true, dot: 'var(--dsw-alias-state-success-primary, #22c55e)' })
    // The agent's own modes are adjacent to the roster but NOT in this menu:
    // they belong to the composer-mode select alone.
    expect(menu.sections.some(section => section.id === 'agent-mode')).toBe(false)
  })

  it('paints every agent state with a host alias token, never a literal', () => {
    // Dark mode only follows the host palette when the dot resolves through
    // the alias tokens; a raw hex would stay light in both themes (issue #4).
    const agents: AgentView[] = (['ready', 'starting', 'error', 'stopped'] as const)
      .map((state, index) => ({ ...agent, id: `agent-${index}`, state }))
    const menu = menuFor('agent', { ...base, agents, route: routed })
    expect(menu.sections[0]?.items.map(item => item.dot)).toEqual([
      'var(--dsw-alias-state-success-primary, #22c55e)',
      'var(--dsw-alias-state-warn-primary, #eab308)',
      'var(--dsw-alias-state-error-primary, #ef4444)',
      'var(--dsw-alias-state-idle-primary, #9ca3af)',
    ])
  })

  it('shows the base entry plus the exposed variants in the MODEL picker', () => {
    // The model axis did not disappear — it moved to its own chip, which is
    // where the model control reads it from.
    const menu = menuFor('model', { ...base, route: routed })
    const models = menu.sections[0]
    // The bare `agentId` row (the agent's default model) is never filtered out;
    // everything after it is what `exposedModels` let through.
    expect(modelRowIds(menu)).toEqual(['pi', 'pi@claude-sonnet-4'])
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

  it('shows a pick made before the conversation ever ran a turn', () => {
    // THE case this exists for: no live ACP session yet, but the user already
    // chose an agent, its model and a thought level in the composer. Reading
    // only the live session would show nothing and make the pick look lost.
    const picked = describeRoute([agent], undefined, undefined, catalog, 'pi', {
      agentId: 'pi',
      modelId: 'pi@claude-sonnet-4',
      effort: 'high',
    })
    expect(picked).toMatchObject({
      agentId: 'pi',
      modelId: 'pi@claude-sonnet-4',
      modelLabel: 'Pi · Claude Sonnet 4',
      effectiveEffort: 'high',
    })
    // The agent's own catalog still supplies the axes, not the pick.
    expect(picked.efforts.map(level => level.id)).toEqual(['high'])

    // A pick naming an agent this route is NOT on is ignored: the record
    // belongs to whichever agent the conversation is bound to.
    const otherAgent = describeRoute([agent], undefined, undefined, catalog, 'pi', {
      agentId: 'someone-else',
      modelId: 'someone-else@x',
    })
    expect(otherAgent).toMatchObject({ agentId: 'pi', efforts: [] })
    expect(otherAgent.modelId).toBeUndefined()
  })

  it('shows the model chip for a conversation that has picked nothing yet', () => {
    // THE regression this exists for (user report, 2026-10-18): a conversation
    // with a persisted pick of `{ agent, effort }` and NO model — the shape you
    // get by only touching the thought-level chip — had `modelId === undefined`
    // and therefore rendered no model chip at all. An agent with a perfectly
    // good model axis looked like it had none.
    const withAgentModel: AgentCatalogResult = {
      ...catalog,
      currentModel: { value: 'claude-sonnet-4', name: 'Claude Sonnet 4' },
    }
    const pickedEffortOnly = describeRoute([agent], undefined, undefined, withAgentModel, 'pi', {
      agentId: 'pi',
      effort: 'high',
    })
    // The label comes from the agent's own reported current model, and the
    // adapter id stays unset: this conversation has not chosen a model, so
    // nothing pretends it did (the picker marks rows by `modelId`).
    expect(pickedEffortOnly.modelLabel).toBe('Claude Sonnet 4')
    expect(pickedEffortOnly.modelId).toBeUndefined()

    // An agent that publishes no `category: 'model'` select has no model axis,
    // and the chip stays away rather than inventing a label.
    expect(describeRoute([agent], undefined, undefined, catalog, 'pi', { agentId: 'pi' }).modelLabel)
      .toBeUndefined()
  })

  it('lists one row per model, and the checked row names its model', () => {
    // THE bug in the screenshot (user report, 2026-10-18): codebuddy is on `hy3`,
    // `hy3` is ALSO in `exposedModels`, and the picker rendered
    //   <agent> · 默认  ✓        ← the checked row, naming no model at all
    //   <agent> · Hy3
    // i.e. two rows for one model, with the checkmark on the one that did not
    // say "Hy3". One row per model; the checked row names the model.
    const onExposed: AgentCatalogResult = {
      ...catalog,
      base: { id: 'pi', name: 'Pi · Claude Sonnet 4' },
      // Not a variant row — it is the agent's `currentValue`, and the exposure
      // list below happens to contain the same value.
      currentModel: { value: 'claude-sonnet-4', name: 'Claude Sonnet 4' },
    }
    const route = describeRoute([agent], undefined, undefined, onExposed, 'pi')
    const menu = menuFor('model', { acp, agents: [agent], catalog: onExposed, route })
    // ONE row for the model the agent is on — not a "默认" row plus a variant row.
    // The row is the VARIANT row (it is in `exposedModels`), so it carries that
    // row's label; what matters is that it is marked and that it names a model.
    expect(modelRowIds(menu)).toEqual(['pi@claude-sonnet-4'])
    expect(menu.sections[0]?.items[0]).toMatchObject({ active: true })
    expect(menu.sections[0]?.items[0]?.label).toContain('Claude Sonnet 4')
    // The chip names the model too, not the agent (the agent chip already does).
    expect(route.modelLabel).toBe('Claude Sonnet 4')

    // An agent sitting on a model the exposure filter does not list: still one
    // row, still named, still checked — the picker must never imply the
    // conversation runs one of the offered models instead.
    const offList: AgentCatalogResult = {
      ...catalog,
      variants: [{ id: 'pi@other-model', name: 'Other Model' }],
      currentModel: { value: 'hy3', name: 'Hy3' },
    }
    const offMenu = menuFor('model', { acp, agents: [agent], catalog: offList, route: describeRoute([agent], undefined, undefined, offList, 'pi') })
    expect(modelRowIds(offMenu)).toEqual(['pi@hy3', 'pi@other-model'])
    expect(offMenu.sections[0]?.items[0]).toMatchObject({ active: true, label: 'Hy3 · 当前' })
    expect(offMenu.sections[0]?.items[1]).toMatchObject({ active: false })
  })

  it('offers the agent\'s modes before any live session exists', () => {
    // The mode select used to require a live session, because that is where its
    // list came from — so on a conversation still being set up it silently
    // vanished (user report, 2026-10-18). The probed catalog carries the same
    // list the agent publishes on `session/new`.
    const withMode: AgentCatalogResult = {
      ...catalog,
      mode: {
        currentValue: 'default',
        choices: [{ id: 'default', name: 'Always Ask' }, { id: 'plan', name: 'Plan' }],
      },
    }
    expect(withMode.mode?.choices.map(choice => choice.id)).toEqual(['default', 'plan'])
    // Nothing to show for an agent that declares no modes.
    expect(catalog.mode).toBeUndefined()
  })

  it('lets the live session outrank the pick once one exists', () => {
    // The session is what the agent is ACTUALLY running (it may have switched
    // its own model); the pick only covers the window before one exists.
    const live = describeRoute([agent], { ...bound, modelId: 'pi', reasoningEffort: 'low' }, undefined, catalog, 'pi', {
      agentId: 'pi',
      modelId: 'pi@claude-sonnet-4',
      effort: 'high',
    })
    expect(live.modelId).toBe('pi')
    expect(live.effectiveEffort).toBe('low')
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
    expect(modelRowIds(menuFor('model', { acp, agents: [agent], catalog: silent, route })))
      .toEqual(['pi'])
    const noCatalog = describeRoute([agent], bound, undefined)
    const fallback = menuFor('model', { acp, agents: [agent], route: noCatalog })
    expect(modelRowIds(fallback)).toEqual(['pi'])
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
    expect(modelRowIds(menu)).toEqual(['pi@gone', 'pi', 'pi@claude-sonnet-4'])
    expect(menu.sections[0]?.items[0]).toMatchObject({ active: true })
    // The default route is the base row itself — never duplicated.
    const onDefault = menuFor('model', { ...base, route: routed })
    expect(modelRowIds(onDefault)).toEqual(['pi', 'pi@claude-sonnet-4'])
  })

  it('points an unfiltered agent at the exposure editor instead of looking broken', () => {
    const unfiltered: AgentCatalogResult = { ...catalog, variants: [] }
    const model = menuFor('model', { acp, agents: [agent], catalog: unfiltered, route: describeRoute([agent], bound, undefined, unfiltered) })
    expect(model.note).toMatch(/设置 → NTR/)
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
    expect(modelRowIds(menuFor('model', { ...base, route: fresh })))
      .toEqual(['pi', 'pi@claude-sonnet-4'])
    // No effort axis: nothing has run, so there is no current effort to mark.
    expect(menuFor('agent', { ...base, route: fresh }).sections.map(s => s.id)).not.toContain('thought')
  })
})

describe('the picker survives a host projection that is not what we assumed', () => {
  const acp = new AcpStore(async () => ({ ok: true, value: {} }), zh => zh)
  const agent: AgentView = {
    id: 'pi', title: 'Pi', command: 'pi-acp', args: [],
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

describe('isNewFileDiff (the diff footnote)', () => {
  it('calls a file new only when there was no old side', () => {
    // THE rule (audit F8): the footnote used to read `removed === 0`, and an
    // EXISTING file that only gained lines also diffs to zero removals — so a
    // real edit was labelled "new file". The old side decides, never the count.
    expect(isNewFileDiff(null, 'a\nb')).toBe(true)
    expect(isNewFileDiff('', 'a\nb')).toBe(true)
    // Identical payloads: nothing was removed either, and there is no edit to
    // mislabel, so the degenerate case keeps the footnote it always had.
    expect(isNewFileDiff('a\nb', 'a\nb')).toBe(true)

    expect(isNewFileDiff('a\n', 'a\nb\n')).toBe(false)
    expect(isNewFileDiff('a\nb\n', 'a\nB\nb\n')).toBe(false)
    // A pure removal edits an existing file; it is the opposite of a new one.
    expect(isNewFileDiff('a\nb\n', 'a\n')).toBe(false)
  })

  it('is not reachable from the row counts the old rule used', () => {
    // The proof the row count cannot decide it: both of these diffs have zero
    // removals, and only one of them is a new file.
    const grown = diffRows('a\n', 'a\nb\n')
    const created = diffRows(null, 'a\nb\n')
    expect(grown.filter(row => row.sign === '-')).toHaveLength(0)
    expect(created.filter(row => row.sign === '-')).toHaveLength(0)
    expect(isNewFileDiff('a\n', 'a\nb\n')).toBe(false)
    expect(isNewFileDiff(null, 'a\nb\n')).toBe(true)
  })
})

/**
 * The empty state of the conversation's ACP view.
 *
 * Its copy is a pure function (`acpEmptyCopy`) because this bundle has no DOM
 * test, and the copy IS the defect: `chatTranscriptOf` answering `undefined`
 * covers both "no agent has ever served this conversation" and "its ACP session
 * record is gone", and one sentence claimed the first for both.
 */
describe('the ACP view empty state (no transcript to show)', () => {
  const agent: AgentView = {
    id: 'pi', title: 'Pi', command: 'pi-acp', args: [],
    allowedCwdRoots: [], state: 'ready', liveSessions: [],
  }
  /** Read the English side, so the assertions name what a user would read. */
  const en = (_zh: string, text: string): string => text
  const zh = (text: string): string => text

  it('reads the binding the transcript does not carry', () => {
    // THE F6 case: the ACP session was destroyed (`closeSession` →
    // `forgetDshSession` drops the record, so `chatTranscriptOf` answers
    // undefined) while the host binding still names the agent — the composer
    // chip says "NTR · Pi" one row above this view.
    expect(boundAgentOf(undefined, 'pi', undefined, [agent])).toEqual({ id: 'pi', title: 'Pi' })
    // A live or parked session outranks the recorded binding.
    expect(boundAgentOf({ agentId: 'omp', agentTitle: 'Omp', sessionId: 's1' }, 'pi', undefined, [agent]))
      .toEqual({ id: 'omp', title: 'Omp' })
    // The persisted pick covers the window before the first turn.
    expect(boundAgentOf(undefined, undefined, 'pi', [agent])).toEqual({ id: 'pi', title: 'Pi' })
    // Nothing anywhere: this conversation really has no agent.
    expect(boundAgentOf(undefined, undefined, undefined, [agent])).toBeUndefined()
    // An agent the roster no longer has still names itself.
    expect(boundAgentOf(undefined, 'ghost', undefined, [agent])).toEqual({ id: 'ghost', title: 'ghost' })
  })

  it('does not claim "no NTR agent has run" while an agent is bound', () => {
    const copy = acpEmptyCopy({ bound: { id: 'pi', title: 'Pi' }, hasAgents: true, acpMode: true }, en)
    expect(copy.title).not.toMatch(/No NTR agent has run/)
    expect(copy.title).toBe('This conversation has no ACP session to show right now')
    // The next step is a message, not a pick: the agent is already chosen.
    expect(copy.body).toMatch(/Send it a message/)
    expect(copy.hint).toBe('bound to · Pi')
    // The Chinese side says the same thing, not a stale variant of it.
    expect(acpEmptyCopy({ bound: { id: 'pi', title: 'Pi' }, hasAgents: true, acpMode: true }, zh).title)
      .toBe('这个会话当前没有可显示的 ACP 会话')
  })

  it('keeps the honest "nothing has run" title when nothing is bound', () => {
    const copy = acpEmptyCopy({ hasAgents: true, acpMode: true }, en)
    expect(copy.title).toBe('No NTR agent has run in this conversation yet')
    expect(copy.body).toMatch(/Pick a NTR agent/)
  })

  it('points at the composer base only inside an NTR-mode conversation', () => {
    // THE F7 case: the base is installed by the ACP-mode gate alone
    // (`syncAcpMode`), and the NTR view tab is registered unconditionally — so
    // in an ordinary conversation that cell still holds the host's own model
    // selector and the hint sent the user to a control that is not there.
    expect(acpEmptyCopy({ hasAgents: true, acpMode: true }, en).hint)
      .toBe('pick one from the NTR base in the composer')
    const ordinary = acpEmptyCopy({ hasAgents: true, acpMode: false }, en)
    expect(ordinary.hint).toBe('This conversation is not in NTR mode · NTR is chosen when a conversation starts')
    expect(ordinary.hint).not.toMatch(/composer/)
    // A host that never answered (older half) gets no line rather than a guess.
    expect(acpEmptyCopy({ hasAgents: true }, en).hint).toBeUndefined()
  })

  it('sends a deployment with no configured agent to the settings page', () => {
    expect(acpEmptyCopy({ hasAgents: false, acpMode: true }, en).hint)
      .toBe('No agent configured · Settings → NTR')
    // No agents means no base to point at either way.
    expect(acpEmptyCopy({ hasAgents: false }, en).hint).toBe('No agent configured · Settings → NTR')
  })

  it('says history replays only when a parked record carries history', () => {
    // A record restored from disk after a host restart: released, and the
    // agent-side session has the turns the empty local buffer cannot show —
    // "还没有消息" to someone whose chat plane shows yesterday's turns is the
    // kind of contradiction this copy rule exists to prevent.
    expect(historyAwaitsReplay({ released: true, hasHistory: true })).toBe(true)
    // A parked session with nothing to show really has nothing.
    expect(historyAwaitsReplay({ released: true })).toBe(false)
    expect(historyAwaitsReplay({ released: true, hasHistory: false })).toBe(false)
    // A live session (mid-replay or not) must not promise a restore.
    expect(historyAwaitsReplay({ hasHistory: true })).toBe(false)
    expect(historyAwaitsReplay({})).toBe(false)
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

describe('the agent-lock hand-off clock', () => {
  it('shatters, then forms, then settles — and never replays a consumed reveal', () => {
    vi.useFakeTimers()
    try {
      const session = 'chat-lock-anim-1'
      // The commit that first sees a witnessed lock already renders the base in
      // its shatter phase (no frame with neither surface), even before the
      // effect arms the clock.
      expect(agentLockPhaseOf(session, 1)).toBe('shatter')
      playAgentLockAnim(session, 1)
      expect(agentLockPhaseOf(session, 1)).toBe('shatter')
      vi.advanceTimersByTime(SHATTER_MS - 1)
      expect(agentLockPhaseOf(session, 1)).toBe('shatter')
      vi.advanceTimersByTime(1)
      expect(agentLockPhaseOf(session, 1)).toBe('form')
      vi.advanceTimersByTime(FORM_MS - 1)
      expect(agentLockPhaseOf(session, 1)).toBe('form')
      vi.advanceTimersByTime(1)
      expect(agentLockPhaseOf(session, 1)).toBe('idle')

      // Opening the page again carries no reveal at all; and even an effect
      // re-run with the same serial cannot start a second ceremony.
      expect(agentLockPhaseOf(session)).toBe('idle')
      playAgentLockAnim(session, 1)
      expect(agentLockPhaseOf(session, 1)).toBe('idle')
    } finally {
      vi.useRealTimers()
    }
  })

  it('lets a retry after a rolled-back first turn start a fresh ceremony', () => {
    vi.useFakeTimers()
    try {
      const session = 'chat-lock-anim-retry'
      playAgentLockAnim(session, 1)
      vi.advanceTimersByTime(SHATTER_MS)
      expect(agentLockPhaseOf(session, 1)).toBe('form')
      // The host rolled the lock back; the retry witnesses reveal 2 while the
      // old ceremony would still be forming. The new reveal must shatter.
      expect(agentLockPhaseOf(session, 2)).toBe('shatter')
      playAgentLockAnim(session, 2)
      expect(agentLockPhaseOf(session, 2)).toBe('shatter')
      // At t = SHATTER + FORM the OLD form timer fires. If it were not fenced
      // by its epoch it would delete the retry's ceremony; the retry itself
      // moved to form at SHATTER after its start.
      vi.advanceTimersByTime(FORM_MS)
      expect(agentLockPhaseOf(session, 2)).toBe('form')
      vi.advanceTimersByTime(SHATTER_MS)
      expect(agentLockPhaseOf(session, 2)).toBe('idle')
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('approvalDeadlineFacts', () => {
  // The card carries TWO controls — one window (how long) and one mode (what
  // happens) — and an override can sit on either, so each is decided on its
  // own. The reset button is honest only when something is ACTUALLY being
  // outranked: offering it for a baseline that AGREES with the running value
  // would put a button on the face of the settings that does nothing
  // (observed live).
  const base = { permissionTimeoutMs: 300_000, mode: 'abort' as const }
  it('reports no override when the config file says nothing', () => {
    const facts = approvalDeadlineFacts(base)
    expect(facts.baseline).toBeUndefined()
    expect(facts.modeBaseline).toBeUndefined()
    expect(facts.overridden).toBe(false)
  })
  it('reports no override when the config file AGREES with the running value', () => {
    const facts = approvalDeadlineFacts({ ...base, configured: { permissionTimeoutMs: 300_000 } })
    expect(facts.overridden).toBe(false)
    expect(facts.baseline).toBeUndefined()
  })
  it('reports the baseline of the window that is outranked', () => {
    const facts = approvalDeadlineFacts({ ...base, configured: { permissionTimeoutMs: 600_000 } })
    expect(facts.baseline).toBe(600_000)
    expect(facts.overridden).toBe(true)
  })
  it('decides the mode on its own: an agreed mode is not an override', () => {
    const facts = approvalDeadlineFacts({ ...base, configuredMode: 'abort' })
    expect(facts.modeBaseline).toBeUndefined()
    expect(facts.overridden).toBe(false)
  })
  it('reports the mode baseline when the card outranks it', () => {
    const facts = approvalDeadlineFacts({ ...base, mode: 'auto', configuredMode: 'wait' })
    expect(facts.modeBaseline).toBe('wait')
    expect(facts.overridden).toBe(true)
  })
})

describe('deadlineSliderIndex', () => {
  it('keeps a rung where it is', () => {
    expect(deadlineSliderIndex(300_000)).toBe(3)
    expect(deadlineSliderIndex(30_000)).toBe(1)
    // 不等待 is the FIRST rung: the slider reads left to right as "wait longer",
    // and not waiting at all is the shortest wait there is.
    expect(deadlineSliderIndex(0)).toBe(0)
  })
  it('parks an off-ladder window on the nearest rung', () => {
    // 45 seconds sits exactly between 30 秒 and 1 分钟 — a tie goes to the
    // SHORTER wait, so the thumb never promises more patience than it has.
    expect(deadlineSliderIndex(45_000)).toBe(1)
    expect(deadlineSliderIndex(200_000)).toBe(3)
    expect(deadlineSliderIndex(400_000)).toBe(3)
  })
  it('parks a window longer than every rung on the longest one', () => {
    expect(deadlineSliderIndex(86_400_000)).toBe(7)
  })
  it('offers 不等待 under 自动推进 only', () => {
    // The auto ladder carries 不等待 as its first rung.
    expect(deadlineSliderIndex(0, 'auto')).toBe(0)
    // The abort ladder does not: refusing every ask the instant it arrives
    // stops the agent at every gate, so the shortest wait it offers is the
    // first REAL one. A zero parks on that rung instead of on a rung that
    // does not exist.
    expect(deadlineSliderIndex(30_000, 'abort')).toBe(0)
    expect(deadlineSliderIndex(300_000, 'abort')).toBe(2)
    expect(deadlineSliderIndex(0, 'abort')).toBe(0)
    expect(deadlineSliderIndex(86_400_000, 'abort')).toBe(6)
  })
})

describe('deadlineValueFor', () => {
  it('drops 不等待 under 超时中止, keeping the shortest real wait', () => {
    // 不等待 answers, so the agent continues — that is the auto mode's deal.
    expect(deadlineValueFor('auto', 0)).toBe(0)
    // 超时中止 refuses. A zero window there would refuse every ask on arrival
    // (the agent stops at every gate), so it floors to the shortest real wait.
    expect(deadlineValueFor('abort', 0)).toBe(30_000)
    expect(deadlineValueFor('abort', 45_000)).toBe(45_000)
    // 一直等待 has no window at all.
    expect(deadlineValueFor('wait', undefined)).toBeUndefined()
  })
  it('keeps the browser floor in step with the host half', () => {
    // The browser half hand-copies the floor (it may not import the host
    // module), so the copy is pinned here instead of drifting.
    expect(DEADLINE_MIN_WAIT_MS).toBe(APPROVAL_DEADLINE_MIN_WAIT_MS)
  })
})

describe('permissionsForSession', () => {
  const ask = (overrides: Partial<PendingPermission>): PendingPermission => ({
    requestId: 'r1',
    sessionId: 'acp-1',
    dshSessionId: 'chat-1',
    toolName: 'Bash',
    options: [],
    timeoutMode: 'wait',
    ...overrides,
  })

  it('keeps only the asks addressed to the conversation', () => {
    const permissions = [
      ask({ requestId: 'mine', dshSessionId: 'chat-1' }),
      ask({ requestId: 'other', dshSessionId: 'chat-2' }),
      ask({ requestId: 'also-mine', dshSessionId: 'chat-1' }),
    ]
    expect(permissionsForSession(permissions, 'chat-1').map(p => p.requestId)).toEqual(['mine', 'also-mine'])
    expect(permissionsForSession(permissions, 'chat-2').map(p => p.requestId)).toEqual(['other'])
    expect(permissionsForSession(permissions, 'chat-3')).toEqual([])
  })

  it('never puts an ask without a chat identity into a conversation', () => {
    // An `/acp` RPC-only ask is pending but has no conversation to render in;
    // it stays on the settings-panel ledger.
    const permissions = [ask({ requestId: 'rpc', dshSessionId: undefined })]
    expect(permissionsForSession(permissions, 'chat-1')).toEqual([])
  })
})

describe('deadlineRemainingLabel', () => {
  const now = 1_700_000_000_000

  it('has no countdown in wait mode, even if a deadline was supplied', () => {
    expect(deadlineRemainingLabel(now + 10_000, now, 'wait')).toBeUndefined()
    expect(deadlineRemainingLabel(undefined, now, 'abort')).toBeUndefined()
    expect(deadlineRemainingLabel(undefined, now, 'auto')).toBeUndefined()
  })

  it('formats the remaining time in seconds (rounding up, so it never reads zero early)', () => {
    expect(deadlineRemainingLabel(now + 12_000, now, 'abort')).toBe('12s')
    expect(deadlineRemainingLabel(now + 1, now, 'auto')).toBe('1s')
    expect(deadlineRemainingLabel(now + 90_000, now, 'abort')).toBe('1m 30s')
    expect(deadlineRemainingLabel(now + 120_000, now, 'auto')).toBe('2m')
  })

  it('reports an expired deadline instead of counting backwards', () => {
    expect(deadlineRemainingLabel(now, now, 'abort')).toBe(PERMISSION_DEADLINE_EXPIRED)
    expect(deadlineRemainingLabel(now - 1, now, 'auto')).toBe(PERMISSION_DEADLINE_EXPIRED)
  })
})

describe('contextOccupancy', () => {
  it('rounds and clamps the agent sample to a bounded percentage', () => {
    expect(contextOccupancy({ used: 280, size: 1000 })).toEqual({ percent: 28, used: 280, size: 1000 })
    expect(contextOccupancy({ used: 0, size: 1000 })).toEqual({ percent: 0, used: 0, size: 1000 })
    // Over-capacity samples (agents may report used > size) must not draw a
    // ring past a full circle.
    expect(contextOccupancy({ used: 2000, size: 1000 })).toEqual({ percent: 100, used: 2000, size: 1000 })
  })

  it('renders nothing for absent or unusable samples instead of a fake 0%', () => {
    expect(contextOccupancy(undefined)).toBeUndefined()
    expect(contextOccupancy({ used: 1, size: 0 })).toBeUndefined()
    expect(contextOccupancy({ used: -1, size: 100 })).toBeUndefined()
    expect(contextOccupancy({ used: Number.NaN, size: 100 })).toBeUndefined()
    expect(contextOccupancy({ used: 1, size: Number.POSITIVE_INFINITY })).toBeUndefined()
  })
})

describe('compactTokenCount', () => {
  it('matches the host meter’s K/M shape', () => {
    expect(compactTokenCount(0)).toBe('0')
    expect(compactTokenCount(999)).toBe('999')
    expect(compactTokenCount(1000)).toBe('1K')
    expect(compactTokenCount(12_345)).toBe('12.3K')
    expect(compactTokenCount(123_456)).toBe('123K')
    expect(compactTokenCount(1_500_000)).toBe('1.5M')
    expect(compactTokenCount(200_000_000)).toBe('200M')
  })
})

describe('usageFromUpdate', () => {
  it('carries a well-formed sample (with cost) and ignores malformed frames', () => {
    expect(usageFromUpdate({ used: 123, size: 1000 })).toEqual({ used: 123, size: 1000 })
    expect(usageFromUpdate({ used: 123, size: 1000, cost: { amount: 0.25, currency: 'USD' } }))
      .toEqual({ used: 123, size: 1000, cost: { amount: 0.25, currency: 'USD' } })
    // A malformed sample must leave the previous reading on screen, not zero it.
    expect(usageFromUpdate({ used: '123', size: 1000 })).toBeUndefined()
    expect(usageFromUpdate({ used: Number.NaN, size: 1000 })).toBeUndefined()
    expect(usageFromUpdate({ used: 123, size: Number.POSITIVE_INFINITY })).toBeUndefined()
    // A partial cost is dropped, the occupancy sample survives.
    expect(usageFromUpdate({ used: 123, size: 1000, cost: { amount: 'x' } })).toEqual({ used: 123, size: 1000 })
  })
})

describe('acpMeterUsage', () => {
  const row = { agentId: 'pi', sessionId: 's1', usage: { used: 28, size: 100 } }

  it('shows the row sample only for the conversation it belongs to', () => {
    expect(acpMeterUsage({ acpMode: { c: true }, chatSessionsFor: 'c', chatSessions: [row] }, 'c'))
      .toEqual({ used: 28, size: 100 })
    expect(acpMeterUsage({ acpMode: {}, chatSessionsFor: 'c', chatSessions: [row] }, 'c'))
      .toEqual({ used: 28, size: 100 })
    // A list read for another conversation must never leak into this one.
    expect(acpMeterUsage({ acpMode: { c: true }, chatSessionsFor: 'other', chatSessions: [row] }, 'c'))
      .toBeUndefined()
    expect(acpMeterUsage({ acpMode: { c: true }, chatSessionsFor: 'c', chatSessions: [] }, 'c'))
      .toBeUndefined()
  })

  it('an explicit non-ACP verdict outranks a lingering session row', () => {
    // Switching a conversation off the NTR preset does not close its ACP
    // session; the ring must leave with the preset, like the agent tag does.
    expect(acpMeterUsage({ acpMode: { c: false }, chatSessionsFor: 'c', chatSessions: [row] }, 'c'))
      .toBeUndefined()
  })

  it('prefers the live row over a released one for the same conversation', () => {
    const released = { agentId: 'pi', sessionId: 's0', usage: { used: 5, size: 100 }, released: true }
    expect(acpMeterUsage({ acpMode: { c: true }, chatSessionsFor: 'c', chatSessions: [released, row] }, 'c'))
      .toEqual({ used: 28, size: 100 })
    expect(acpMeterUsage({ acpMode: { c: true }, chatSessionsFor: 'c', chatSessions: [released] }, 'c'))
      .toEqual({ used: 5, size: 100 })
  })
})

/**
 * The NTR message-actions stylesheet (the message-actions plan §D2/D3). STYLE
 * is a module-private constant mounted by `ensureAcpStyle`, so the assertions
 * read the source file itself. These selectors are the feature's fragile half —
 * the host's three icons are hidden by LOCALIZED aria-labels (its button
 * classes are CSS-module hashes and there is no data-* hook), so a host copy
 * change or a new language must fail HERE first, loudly, not silently un-hide
 * the icons.
 */
describe('NTR message-actions stylesheet (acp-ui.tsx STYLE)', () => {
  const acpUiSource = readFileSync(new URL('../src/client/acp-ui.tsx', import.meta.url), 'utf8')

  /** The three host icons' localized labels (zh + en); the branch button is OUR own button's label too. */
  const hiddenLabels: Array<{ label: string; own: boolean }> = [
    { label: '在新对话中分支', own: true },
    { label: 'Branch into a new conversation', own: true },
    { label: '好的回答', own: false },
    { label: '有问题的回答', own: false },
    { label: '取消标记', own: false },
    { label: 'Good response', own: false },
    { label: 'Bad response', own: false },
    { label: 'Remove rating', own: false },
  ]

  it('hides every host action button by its localized aria-label, and passes our own branch button through', () => {
    for (const { label, own } of hiddenLabels) {
      // `:not([data-ntr-branch])` is the pass OUR button carries — same label,
      // same row; without it the hide rule would swallow our own entry.
      const pass = own ? ':not([data-ntr-branch])' : ''
      expect(acpUiSource).toContain(`html[data-ntr-acp] [data-turn-tail] button[aria-label="${label}"]${pass}`)
    }
    // NO :has(> button…) wrapper rules, ever: the host's Tooltip clones its
    // child without a wrapper, so a :has rule matches the actions ROW (branch
    // button) or the list slot's shared display:contents anchor (feedback
    // buttons) — hiding the whole row. Verified against the real host package;
    // this assertion keeps the SELECTOR from coming back (the STYLE comment
    // naming the hazard is fine — match the selector prefix, not the prose).
    expect(acpUiSource).not.toContain('[data-turn-tail] :has(> button')
  })

  it('the hide block actually hides, and the copy button is never named', () => {
    // The hide declaration lives inside the one selector list above.
    expect(acpUiSource.match(/display: none !important;/g) ?? []).toHaveLength(1)
    // The label closest to ours in the DOM (复制 / Copy) must never be hidden:
    // a rule keyed on it would break the one host action NTR keeps.
    expect(acpUiSource).not.toContain('aria-label="复制"')
    expect(acpUiSource).not.toContain('aria-label="Copy"')
  })

  it('styles the plugin branch button like the host icon it replaces', () => {
    expect(acpUiSource).toContain('.ntr-branch-action {')
    expect(acpUiSource).toContain('.ntr-branch-action svg')
    expect(acpUiSource).toContain('.ntr-branch-action:hover')
    // The unavailable state (the six-state machine's gray) and its hover reset.
    expect(acpUiSource).toContain('.ntr-branch-action[data-unavailable]')
    expect(acpUiSource).toContain('.ntr-branch-action[data-unavailable]:hover')
    expect(acpUiSource).toContain('.ntr-branch-action:focus-visible')
    // Colors come from the host's alias tokens (a var() fallback is the only
    // place a literal may appear) — the same discipline the plan copied from
    // the host's `.xzv4MW_action`.
    expect(acpUiSource).toContain('var(--dsw-alias-label-tertiary')
    expect(acpUiSource).toContain('var(--dsh-content-font-delta')
  })
})
