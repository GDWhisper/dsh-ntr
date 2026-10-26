/**
 * The composer's ACP cluster: what the agent base chip claims, what the model
 * picker says about a model that is not on offer, what the thought-level picker
 * calls its "follow the default" row, and what the agent-mode tooltip says about
 * the host's Access mode. Also: an empty agent roster keeps the base and offers
 * the way into NTR settings.
 *
 * These are the audit's text/behavior mismatches in this area (F5, F25, F26,
 * F27, F43): a chip that named an agent no request path would ever use, a picker
 * row that blamed one cause for a condition with two, a tooltip promising a menu
 * the agent base no longer holds, a "provider default" row on an axis no
 * provider participates in, and a "complementary to the Access mode" tooltip on
 * a control that only exists where the Access mode is hidden.
 *
 * No DOM: the pure model builders are the seam, exactly as tests/acp-view.spec.ts
 * uses them (that file owns the picker's row/label shape; this one owns what the
 * words claim).
 */

import { describe, expect, it } from 'vitest'
import { agentModeTitle } from '../src/client/composer-mode.tsx'
import {
  acpSettingsDialogIsOpen,
  closeAcpSettingsDialog,
  openAcpSettingsDialog,
} from '../src/client/acp-ui.tsx'
import {
  advancedOptions,
  agentBaseChip,
  agentBaseHasData,
  agentBaseHidden,
  agentTagChip,
  agentTagAlive,
  agentTagHaloPresentation,
  agentTagVisible,
  describeRoute,
  lockedAgentOf,
  menuFor,
  OPEN_SETTINGS_ITEM,
  REFRESH_CATALOG_ITEM,
} from '../src/client/session-controls.tsx'
import { AcpStore } from '../src/client/store.ts'
import type { AgentCatalogResult, AgentView, ChatSessionView } from '../src/protocol.ts'

describe('the agent base chip names only an agent that serves the conversation', () => {
  const acp = new AcpStore(async () => ({ ok: true, value: {} }), zh => zh)
  const agent: AgentView = {
    id: 'pi', title: 'Pi', command: 'pi-acp', args: [],
    allowedCwdRoots: [], state: 'ready', liveSessions: [],
  }
  const other: AgentView = { ...agent, id: 'omp', title: 'Omp' }
  const roster = [agent, other]
  /** The conversation's own binding — the host's record of who serves it. */
  const bound: ChatSessionView = { agentId: 'pi', agentTitle: 'Pi', sessionId: 's1', modelId: 'pi' }
  const catalog: AgentCatalogResult = {
    agentId: 'pi',
    title: 'Pi',
    base: { id: 'pi', name: 'Pi' },
    variants: [{ id: 'pi@claude-sonnet-4', name: 'Pi · Claude Sonnet 4' }],
    reasoning: { efforts: [{ id: 'high', name: 'High' }], defaultEffort: 'high' },
    probed: true,
    updatedAt: 1,
  }

  it('is the entry point, not a borrowed name, when nothing serves the conversation', () => {
    // No binding, no live session, no plugin default: the guard's route rewrite
    // finds nothing and the turn runs on the deployment default provider, so the
    // old `agents[0]` fallback put the first configured agent on a chip whose
    // conversation no message would ever send to it (F5).
    const route = describeRoute(roster, undefined, undefined)
    expect(route.agentId).toBeUndefined()
    const chip = agentBaseChip(route, false, acp)
    expect(chip.label).toBe('选择 Agent')
    expect(chip.title).toBe('这条会话当前没有 NTR agent 服务；点开可选择 agent')
  })

  it('names the agent when a binding, a live session or the plugin default serves it', () => {
    // All three are names the request path uses: the host reports the binding,
    // the live session is the agent already running, and the guard falls back to
    // the plugin's default agent.
    expect(describeRoute(roster, bound, undefined, catalog).agentId).toBe('pi')
    expect(describeRoute(roster, { ...bound, released: true }, undefined, catalog).agentId).toBe('pi')
    expect(describeRoute(roster, undefined, 'omp').agentId).toBe('omp')
    expect(describeRoute(roster, undefined, undefined, catalog, 'omp').agentId).toBe('omp')
    const chip = agentBaseChip(describeRoute(roster, bound, undefined, catalog), true, acp)
    expect(chip.label).toBe('NTR · Pi')
    expect(chip.title).toBe('这条会话由外接 NTR agent 服务；点开可切换 agent')
  })

  it('names the model and thought level for a conversation served by the plugin default', () => {
    // A brand-new ACP conversation has no binding and no pick yet; the guard's
    // route rewrite falls back to the plugin default, and the composer must
    // show that agent's own surface right away instead of waiting for a manual
    // re-pick (user report, 2026-10-24).
    const withModel: AgentCatalogResult = {
      ...catalog,
      currentModel: { value: 'claude-sonnet-4', name: 'Claude Sonnet 4' },
    }
    const served = describeRoute(roster, undefined, 'pi', withModel)
    expect(served).toMatchObject({
      agentId: 'pi',
      modelLabel: 'Claude Sonnet 4',
      effectiveEffort: 'high',
      effortLabel: 'High',
    })
    // The route is still the bare agent ("let the agent choose"); the label is
    // the model that route currently resolves to.
    expect(served.modelId).toBeUndefined()
    expect(served.efforts.map(level => level.id)).toEqual(['high'])
  })

  it('promises only the roster behind the agent base', () => {
    // The agent's models and thought levels have chips of their own (user
    // decision, 2026-10-17); the menu behind this chip holds the agent list
    // alone, so a tooltip offering to switch them too was false (F26).
    const route = describeRoute(roster, bound, undefined, catalog)
    const chip = agentBaseChip(route, true, acp)
    expect(chip.title).toContain('切换 agent')
    expect(chip.title).not.toContain('模型')
    expect(chip.title).not.toContain('思考')
    const menu = menuFor('agent', { acp, agents: roster, route })
    expect(menu.sections.map(section => section.id)).toEqual(['agent'])
  })

  it('marks no roster row active when no agent serves the conversation', () => {
    // Nothing is running and nothing is picked, so no row may read as current.
    const menu = menuFor('agent', { acp, agents: roster, route: describeRoute(roster, undefined, undefined) })
    expect(menu.sections[0]?.items.every(item => item.active !== true)).toBe(true)
  })
})

describe('an empty agent roster keeps the base and offers the settings entry', () => {
  const acp = new AcpStore(async () => ({ ok: true, value: {} }), zh => zh)

  it('waits for the host roster answer before calling the roster empty', () => {
    // Before `agents/list` answers, `agents: []` means "not read yet". Offering
    // the setup entry there would accuse a configured deployment on every load.
    expect(agentBaseHasData(undefined, [], false)).toBe(false)
    expect(agentBaseHasData(undefined, [], true)).toBe(true)
    // A live session or a non-empty roster is evidence on its own.
    expect(agentBaseHasData(undefined, [{ id: 'pi' } as AgentView], false)).toBe(true)
    expect(agentBaseHasData({ agentId: 'pi', sessionId: 's1' }, [], false)).toBe(true)
  })

  it('keeps the base chip and puts the setup action inside its picker', () => {
    const route = describeRoute([], undefined, undefined)
    // The base still says what it always said: nothing serves this conversation.
    expect(agentBaseChip(route, false, acp).label).toBe('选择 Agent')
    // ...but with an empty roster the tooltip points at settings, not at a pick
    // the menu cannot offer.
    const emptyChip = agentBaseChip(route, false, acp, true)
    expect(emptyChip.title).toContain('NTR 设置')
    expect(emptyChip.title).not.toContain('可选择 agent')
    const menu = menuFor('agent', { acp, agents: [], route })
    const items = menu.sections[0]?.items ?? []
    // Status first (not clickable), then the action row that opens settings.
    expect(items.map(item => item.id)).toEqual(['none', OPEN_SETTINGS_ITEM])
    expect(items[0]?.disabled).toBe(true)
    expect(items[1]).toMatchObject({ label: '打开 NTR 设置' })
    expect(items[1]?.disabled).toBeUndefined()
  })

  it('opens and closes the frame-wide settings dialog', () => {
    closeAcpSettingsDialog()
    expect(acpSettingsDialogIsOpen()).toBe(false)
    openAcpSettingsDialog()
    expect(acpSettingsDialogIsOpen()).toBe(true)
    closeAcpSettingsDialog()
    expect(acpSettingsDialogIsOpen()).toBe(false)
  })
})

describe('the agent base retires after the first turn, locks the agent, and the edge tag takes over', () => {
  const acp = new AcpStore(async () => ({ ok: true, value: {} }), zh => zh)
  /** An ACP session that proves this conversation has actually run a turn. */
  const ran: ChatSessionView = { agentId: 'pi', agentTitle: 'Pi', sessionId: 's1' }

  it('does not let the plugin default or a pre-chat pick count as a lock', () => {
    // `lockedAgentOf` takes no default and no pick by design. A configured
    // default or a pick made ahead of the first message is what a fresh
    // conversation WOULD start on — not proof its context belongs to anyone
    // yet. Counting either would hide the base before the user can change it.
    expect(lockedAgentOf(undefined, undefined)).toBeUndefined()
    expect(agentBaseHidden(lockedAgentOf(undefined, undefined))).toBe(false)
  })

  it('locks on the first ACP session, even without a host binding', () => {
    expect(lockedAgentOf(undefined, ran)).toBe('pi')
    expect(agentBaseHidden('pi')).toBe(true)
  })

  it('keeps the host lock after the session is gone', () => {
    // The lock is persisted with the conversation, not with the process: the
    // tag must still name the agent after a restart or an agent stop.
    expect(lockedAgentOf('pi', undefined)).toBe('pi')
    expect(agentBaseHidden('pi')).toBe(true)
  })

  it('ignores the roster: a deleted agent still owns the conversation context', () => {
    // No roster check on purpose. Bringing the base back here would offer a
    // switch the turn path has to refuse; the tag names the stale id instead.
    const deleted: ChatSessionView = { ...ran, agentId: 'deleted', agentTitle: 'Deleted' }
    expect(lockedAgentOf(undefined, deleted)).toBe('deleted')
    expect(agentBaseHidden('deleted')).toBe(true)
    // The durable host lock outranks a stale session naming another agent.
    expect(lockedAgentOf('pi', deleted)).toBe('pi')
  })

  it('shows the tag only when the base has stood down', () => {
    expect(agentTagVisible(true, undefined)).toBe(false) // before the first turn
    expect(agentTagVisible(true, 'pi')).toBe(true)
    // A lingering lock must not leak the tag into a conversation that switched
    // back to an ordinary preset; an unanswered host verdict falls back to the
    // lock, which itself proves ACP.
    expect(agentTagVisible(false, 'pi')).toBe(false)
    expect(agentTagVisible(undefined, 'pi')).toBe(true)
  })

  it('reads the tag as alive only for a live session of the tagged agent', () => {
    // A live, unreleased session of the locked agent breathes.
    expect(agentTagAlive(ran, 'pi')).toBe(true)
    // Released (process gone / idle-released) turns the halo off; the tag
    // itself stays, so the halo must not keep claiming a process that is not.
    expect(agentTagAlive({ ...ran, released: true }, 'pi')).toBe(false)
    // The live session must be the tagged agent's own: a view naming another
    // agent (a stale roster entry after a delete/re-add) is not "alive".
    expect(agentTagAlive({ ...ran, agentId: 'other' }, 'pi')).toBe(false)
    // No session view at all (host has not answered yet): not alive.
    expect(agentTagAlive(undefined, 'pi')).toBe(false)
    expect(agentTagAlive(ran, undefined)).toBe(false)
  })

  it('maps the halo setting to the tag classes and the animation period', () => {
    // Not alive: no halo classes and no CSS variable at all — a stale period
    // could never leak into some future non-animated state.
    expect(agentTagHaloPresentation({ mode: 'breath', speed: 'fast' }, false))
      .toEqual({ classes: '', style: {} })
    // Breath mode carries the period variable for the stylesheet.
    expect(agentTagHaloPresentation({ mode: 'breath', speed: 'slow' }, true))
      .toEqual({ classes: ' is-alive', style: { '--ntr-halo-period': '5.2s' } })
    expect(agentTagHaloPresentation({ mode: 'breath', speed: 'normal' }, true))
      .toEqual({ classes: ' is-alive', style: { '--ntr-halo-period': '3.2s' } })
    expect(agentTagHaloPresentation({ mode: 'breath', speed: 'fast' }, true))
      .toEqual({ classes: ' is-alive', style: { '--ntr-halo-period': '1.2s' } })
    // Steady mode: constant glow, no animation, therefore no variable.
    expect(agentTagHaloPresentation({ mode: 'steady', speed: 'normal' }, true))
      .toEqual({ classes: ' is-alive is-steady', style: {} })
  })

  it('names the locked agent and says switching is closed', () => {
    const tag = agentTagChip('Pi', acp)
    expect(tag.label).toBe('NTR · Pi')
    expect(tag.title).toContain('锁定')
    expect(tag.title).toContain('不能切换')
    expect(tag.title).toContain('新建会话')
  })
})

describe('the model picker names both reasons a current model is not on offer', () => {
  const acp = new AcpStore(async () => ({ ok: true, value: {} }), zh => zh)
  const agent: AgentView = {
    id: 'pi', title: 'Pi', command: 'pi-acp', args: [],
    allowedCwdRoots: [], state: 'ready', liveSessions: [],
  }
  const bound: ChatSessionView = { agentId: 'pi', agentTitle: 'Pi', sessionId: 's1', modelId: 'pi' }
  const catalog: AgentCatalogResult = {
    agentId: 'pi',
    title: 'Pi',
    base: { id: 'pi', name: 'Pi' },
    variants: [{ id: 'pi@claude-sonnet-4', name: 'Pi · Claude Sonnet 4' }],
    probed: true,
    updatedAt: 1,
  }

  it('does not blame only the visibility filter when the agent dropped the model', () => {
    // The route names a variant the agent's catalog no longer lists. The old
    // detail said "not checked as visible in Settings → NTR" and nothing else,
    // which sent people hunting for a checkbox they had already ticked (F25).
    const route = describeRoute([agent], { ...bound, modelId: 'pi@gone' }, undefined, catalog)
    const menu = menuFor('model', { acp, agents: [agent], catalog, route })
    const row = menu.sections[0]?.items[0]
    expect(row?.id).toBe('pi@gone')
    expect(row?.detail).toContain('设置 → NTR')
    expect(row?.detail).toContain('掉出')
    // A dropped model is NOT silently replaced: the host refuses the turn and
    // the picker points at the refresh gesture instead of promising a fallback.
    expect(row?.detail).not.toContain('仍然可用')
    expect(row?.detail).toContain('拒绝')
    expect(row?.detail).toContain('刷新目录')
  })

  it('keeps both causes in the detail when the exposure filter hides the model', () => {
    // The other cause: the agent is on a model its own exposure filter hides.
    const offList: AgentCatalogResult = { ...catalog, variants: [], currentModel: { value: 'hy3', name: 'Hy3' } }
    const route = describeRoute([agent], undefined, undefined, offList, 'pi')
    const menu = menuFor('model', { acp, agents: [agent], catalog: offList, route })
    const row = menu.sections[0]?.items[0]
    expect(row?.label).toContain('当前')
    expect(row?.detail).toContain('设置 → NTR')
    expect(row?.detail).toContain('掉出')
  })

  it('names a picked current model by its catalog name even when the filter hides it', () => {
    // Pinning the displayed default makes it a normal variant pick. If that
    // model is not in `exposedModels`, the chip must still say "Hy3", not the
    // raw agent-facing value.
    const offList: AgentCatalogResult = { ...catalog, variants: [], currentModel: { value: 'hy3', name: 'Hy3' } }
    const route = describeRoute([agent], { ...bound, modelId: 'pi@hy3' }, undefined, offList)
    expect(route.modelLabel).toBe('Hy3')
  })

  it('ends the model menu with an explicit refresh row and shows a probe in flight', () => {
    const route = describeRoute([agent], bound, undefined, catalog)
    const idle = menuFor('model', { acp, agents: [agent], catalog, route })
    // The action is a ROW, not a model: it carries no active mark, and it is
    // last so the model rows keep their order.
    expect(idle.sections[0]?.items.at(-1)).toMatchObject({
      id: REFRESH_CATALOG_ITEM,
      label: '刷新目录',
      disabled: false,
    })
    const busy = menuFor('model', { acp, agents: [agent], catalog, route, probing: true })
    expect(busy.sections[0]?.items.at(-1)).toMatchObject({
      id: REFRESH_CATALOG_ITEM,
      label: '正在检测…',
      disabled: true,
    })
    // Even before any catalog has loaded, the refresh action is the way to
    // fetch one on demand.
    const cold = menuFor('model', { acp, agents: [agent], route: describeRoute([agent], bound, undefined) })
    expect(cold.sections[0]?.items.at(-1)?.id).toBe(REFRESH_CATALOG_ITEM)
  })
})

describe('the thought picker calls its cleared-pick row the agent default', () => {
  const acp = new AcpStore(async () => ({ ok: true, value: {} }), zh => zh)
  const agent: AgentView = {
    id: 'pi', title: 'Pi', command: 'pi-acp', args: [],
    allowedCwdRoots: [], state: 'ready', liveSessions: [],
  }
  const bound: ChatSessionView = { agentId: 'pi', agentTitle: 'Pi', sessionId: 's1', modelId: 'pi' }

  it('names the agent, because no provider is on this axis', () => {
    // This axis is the agent's own `thought_level`; `listModels('acp')` answers
    // an empty catalog, so "provider default" described a participant that does
    // not exist (F43). The id is the internal sentinel the pick handler compares
    // against — the label is what the user reads.
    const route = describeRoute([agent], bound, undefined)
    expect(route.effectiveEffort).toBeUndefined()
    const menu = menuFor('thought', { acp, agents: [agent], route })
    expect(menu.sections[0]?.items[0]).toMatchObject({
      id: 'provider-default',
      label: '跟随 agent 默认',
      active: true,
    })
  })
})

describe('the advanced base collects the agent’s remaining config options', () => {
  const acp = new AcpStore(async () => ({ ok: true, value: {} }), zh => zh)
  const agent: AgentView = {
    id: 'pi', title: 'Pi', command: 'pi-acp', args: [],
    allowedCwdRoots: [], state: 'ready', liveSessions: [],
  }
  const catalog: AgentCatalogResult = {
    agentId: 'pi',
    title: 'Pi',
    base: { id: 'pi', name: 'Pi' },
    variants: [],
    probed: true,
    extras: [
      {
        configId: 'temp',
        name: 'Temperature',
        currentValue: 'mid',
        choices: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }],
      },
      {
        configId: 'brave',
        name: 'Brave Mode',
        choices: [{ id: 'on', name: 'On' }, { id: 'off', name: 'Off' }],
      },
    ],
  }
  const route = describeRoute([agent], undefined, undefined, catalog, 'pi')

  it('overlays the conversation pick and ignores another agent’s pick', () => {
    expect(advancedOptions(catalog, { agentId: 'pi', extraConfigs: { temp: 'high' } })).toEqual([
      {
        configId: 'temp',
        name: 'Temperature',
        value: 'high',
        choices: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }],
      },
      {
        configId: 'brave',
        name: 'Brave Mode',
        choices: [{ id: 'on', name: 'On' }, { id: 'off', name: 'Off' }],
      },
    ])
    // A pick from the previous agent is that agent's vocabulary: it must not
    // label this catalog's first option.
    expect(advancedOptions(catalog, { agentId: 'omp', extraConfigs: { temp: 'low' } })[0]?.value).toBe('mid')
    expect(advancedOptions(undefined, undefined)).toEqual([])
  })

  it('builds one config-prefixed section per option, with the pick checked', () => {
    const menu = menuFor('advanced', {
      acp,
      agents: [agent],
      route,
      catalog,
      choice: { agentId: 'pi', extraConfigs: { temp: 'high' } },
    })
    expect(menu.title).toBe('高级选项')
    // The prefix keeps an agent option literally named `model` from colliding
    // with the primary model picker's section id.
    expect(menu.sections.map(section => section.id)).toEqual(['config:temp', 'config:brave'])
    expect(menu.sections[0]).toMatchObject({ title: 'Temperature' })
    expect(menu.sections[0]?.items).toEqual([
      { id: 'low', label: 'Low', active: false },
      { id: 'high', label: 'High', active: true },
    ])
  })
})

describe('the agent-mode tooltip does not call the host access mode complementary', () => {
  const acp = new AcpStore(async () => ({ ok: true, value: {} }), zh => zh)

  it('says the Access mode is hidden in the conversation where this select appears', () => {
    // The same ACP-mode gate that renders this select hides the host's Access
    // mode (`createPermissionSeatClaim` renders nothing in that seat), so the two
    // never share a screen and "complementary" was false (F27).
    const title = agentModeTitle('pi', acp)
    expect(title).toContain('由 agent 自己定义')
    expect(title).toContain('Access mode 不显示')
    expect(title).not.toContain('互补')
    // An agent id that never resolved still reads as a sentence.
    expect(agentModeTitle(undefined, acp)).toContain('agent')
  })
})
