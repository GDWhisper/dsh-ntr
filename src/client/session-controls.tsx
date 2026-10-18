/**
 * The ACP base in the conversation composer's model seat
 * (`conversation.input.model`) and its picker (`conversation.input.overlay`).
 *
 * WHAT IT IS: the base of an ACP conversation. The first level is WHICH agent
 * serves it; hanging off that are the three things the agent itself owns —
 * its own permission preset, its own model, its own thought level. All three
 * come from the agent (`agent/catalog`, the agent's own mode list), never from
 * DSH's model catalog: an ACP agent is not a DSH provider, and DSH's catalog
 * has no per-session seam to filter it with anyway. See
 * docs/acp-convergence.md §2.1.
 *
 * WHERE IT SITS: the composer's model seat — the trailing group of the bar,
 * immediately before the submit button. That is where the host's own base
 * (the model selector) sits, and it is the cell an ACP conversation must not
 * leave to that selector: it lists DSH's providers, none of which this
 * conversation can use, and clicking one writes the process-wide default
 * model. One cell, one occupant. The base is installed there by the ACP-mode
 * gate in `index.tsx` (see `createModelSeatClaim`), which holds it only while
 * the staged conversation runs the ACP preset — so an ordinary chat gets the
 * native selector back and sees no ACP chrome at all.
 *
 * WHAT IT ADDS over a bare model selector: the three axes are separate. A
 * native selector would flatten them into one list of "Agent · Model" rows;
 * here "which agent", "which of ITS models" and "how hard it thinks" are three
 * chips, because those are the three things a person actually thinks in.
 *
 * It is deliberately quiet: the base renders NOTHING for a conversation no ACP
 * agent has served, so an ordinary chat is untouched even before the gate
 * stands down. The ACP view tab is the entry point for those (and for re-entry
 * after a detour through another provider).
 */

import { useEffect, useState } from 'react'
// Type-only: pulls the ui-conversation SlotMap merge into this program.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import {
  AcpChip, AcpMenu, buildAcpModelId, closeAcpMenu, ensureAcpStyle, openAcpMenu,
  setAcpMenuError, splitAcpModelId, useAcpMenu, useUi,
} from './acp-ui.tsx'
import type {
  AcpChatInjected, AcpMenuKind, AcpMenuItem, AcpMenuSection, AcpSessionHook,
} from './acp-ui.tsx'
import type { AcpConversationChoice, AgentCatalogResult, AgentView, ChatSessionView } from '../protocol.ts'

/**
 * Props every entry in this file receives: the injected face (built in
 * `index.tsx` where the services live) plus the session id the slot frame
 * passes to `inject`.
 */
export interface AcpClusterProps extends AcpChatInjected {
  sessionId: string
  /**
   * The framework's session snapshot hook (`SessionStandardProps.useSession`,
   * see `AcpSessionHook`). The cluster watches `running` alone: a fresh
   * conversation has no ACP binding until its first turn settles, so the binding
   * read is repeated then.
   */
  useSession: AcpSessionHook
}

const STATE_COLORS: Record<AgentView['state'], string> = {
  ready: '#22c55e',
  starting: '#eab308',
  error: '#ef4444',
  stopped: '#9ca3af',
}

function agentStateText(acp: AcpChatInjected['acp'], state: AgentView['state']): string {
  switch (state) {
    case 'ready': return acp.label('已连接', 'connected')
    case 'starting': return acp.label('启动中', 'starting')
    case 'error': return acp.label('错误', 'error')
    default: return acp.label('未启动', 'not running')
  }
}

/** Everything the chips need to describe the current agent binding. */
interface RouteInfo {
  /** The agent serving this conversation. */
  agentId?: string
  agentTitle?: string
  modelId?: string
  modelLabel?: string
  efforts: readonly { id: string; name: string; description?: string }[]
  /** `current.reasoningEffort` folded over the model's default (native seat semantics). */
  effectiveEffort?: string
  effortLabel?: string
}

/** The live (non-released) ACP session bound to this chat, if any. */
function boundSession(ui: { chatSessions: ChatSessionView[]; chatSessionsFor?: string }, sessionId: string): ChatSessionView | undefined {
  if (ui.chatSessionsFor !== sessionId) return undefined
  return ui.chatSessions.find(session => !session.released) ?? ui.chatSessions[0]
}

/**
 * The agent serving this conversation: the plugin's own binding first (who
 * serves the NEXT message — the host reports it per chat session), then the
 * agent an ACP session for this conversation is already served by, then the
 * plugin's default — which is what lets a chip offer "use ACP: <agent>" for a
 * conversation that has never been routed, instead of going blank. The binding
 * outranks the live session because a switch applies from the next message:
 * until that turn materializes a session for the new agent, the live list still
 * names the previous one, and the chip must not read as "the click did nothing".
 */
function routeAgentId(
  boundAgentId: string | undefined,
  bound: ChatSessionView | undefined,
  agents: readonly AgentView[],
  defaultAgent: string | undefined,
): string | undefined {
  if (boundAgentId !== undefined && agents.some(agent => agent.id === boundAgentId)) return boundAgentId
  if (bound?.agentId !== undefined) return bound.agentId
  if (defaultAgent !== undefined && agents.some(agent => agent.id === defaultAgent)) return defaultAgent
  return agents[0]?.id
}

/**
 * Describe this conversation's ACP agent from the binding (the host's record of
 * which agent actually serves it) + the agent roster + the agent's own model
 * surface (`agent/catalog`).
 *
 * The model axis reads the ACP catalog, NOT any DSH model directory: an ACP
 * agent's models are the agent's own (see the module header), so there is
 * nothing to look up in DSH's catalog — and reading `current` off a directory
 * was the retired route axis.
 */
export function describeRoute(
  agents: readonly AgentView[],
  bound: ChatSessionView | undefined,
  defaultAgent: string | undefined,
  catalog?: AgentCatalogResult,
  boundAgentId?: string,
  choice?: AcpConversationChoice,
): RouteInfo {
  const agentId = routeAgentId(boundAgentId, bound, agents, defaultAgent)
  if (agentId === undefined) return { efforts: [] }
  const def = agents.find(agent => agent.id === agentId)
  const agentTitle = def?.title ?? bound?.agentTitle ?? catalog?.title ?? agentId
  // The conversation's persisted pick covers the window in which there is no
  // live ACP session yet (nothing has been sent). The live session outranks it
  // — that is what the agent is actually running right now — but without the
  // pick a conversation set up ahead of its first message could not show the
  // model and thought level it is about to use, which is the whole point of
  // choosing them early.
  const pick = choice !== undefined && choice.agentId === agentId ? choice : undefined
  const modelId = bound?.modelId ?? pick?.modelId
  const effort = bound?.reasoningEffort ?? pick?.effort
  const reasoning = catalog?.reasoning
  // The model the AGENT says it is on, for a conversation nobody has picked a
  // model for yet. Without it the chip has no label and does not render at all,
  // so an agent with a perfectly good model axis looked like it had none (user
  // report, 2026-10-18). An agent publishing no `category: 'model'` select
  // genuinely has no model axis — there `currentModel` is absent and nothing is
  // faked. Display-only: `modelId` stays in the adapter-id space, so the picker
  // keeps marking rows by what this conversation actually chose.
  const agentModel = catalog?.currentModel
  if (bound === undefined && pick === undefined && agentModel === undefined) {
    return { agentId, agentTitle, efforts: [] }
  }
  const parsed = splitAcpModelId(modelId ?? '')
  const variant = catalog?.variants.find(entry => entry.id === modelId)
  const effectiveEffort = effort ?? reasoning?.defaultEffort
  // The chip names the MODEL, not the agent (user report, 2026-10-18): the agent
  // is already the chip to its right, so "CodeBuddy Code" beside "ACP · CodeBuddy
  // Code" said nothing about which model was running. A bare `agentId` route
  // means "the agent's own choice", which the catalog resolves to `currentModel`.
  const modelLabel = modelId === undefined
    ? agentModel?.name
    : parsed.choice === undefined
      // Bare route: name the model it resolves to. `base.name` already spells out
      // `<agent> · <model>`, so prefer the model half when we have it.
      ? agentModel?.name ?? catalog?.base.name ?? agentTitle
      : variant?.name ?? parsed.choice
  return {
    agentId,
    agentTitle,
    ...(modelId === undefined ? {} : { modelId }),
    ...(modelLabel === undefined ? {} : { modelLabel }),
    efforts: reasoning?.efforts ?? [],
    ...effectiveEffort === undefined ? {} : { effectiveEffort },
    ...effectiveEffort === undefined
      ? {}
      : { effortLabel: reasoning?.efforts.find(level => level.id === effectiveEffort)?.name ?? effectiveEffort },
  }
}

/** The composer cluster: agent, model and thought level — or nothing at all. */
export function AcpSessionControls(props: AcpClusterProps) {
  ensureAcpStyle()
  const { acp, sessionId, useSession } = props
  const ui = useUi(acp)
  const running = useSession(snapshot => snapshot.running)
  const menu = useAcpMenu()
  useEffect(() => {
    void acp.loadChatSessions(sessionId)
  }, [acp, sessionId, running])
  const bound = boundSession(ui, sessionId)
  const agents = ui.agents
  const choice = ui.chatChoice[sessionId]
  const agentId = routeAgentId(ui.chatBoundAgent[sessionId], bound, agents, ui.defaultAgent)
  const catalog = agentId === undefined ? undefined : ui.seatCatalogs[agentId]
  // Read the catalog ONLY for a conversation that actually points at an agent.
  // `routeAgentId` falls back to the plugin's global default so the picker can
  // offer a way in — but that fallback must not cause a READ of an unrelated
  // agent's surface: reading is what can spawn a probe process (user report,
  // 2026-10-18: a conversation served by one agent had another one start up).
  const served = bound !== undefined || choice !== undefined || ui.chatBoundAgent[sessionId] !== undefined
  useEffect(() => {
    if (served && agentId !== undefined) void acp.loadAgentCatalog(agentId)
  }, [acp, served, agentId])
  const route = describeRoute(agents, bound, ui.defaultAgent, catalog, ui.chatBoundAgent[sessionId], choice)
  // A conversation with no ACP story to tell gets no chrome: the ACP view tab
  // owns the entry point for starting one.
  if (bound === undefined && agents.length === 0) return null
  // Set up = an ACP session exists OR the conversation carries a persisted pick.
  // The second half is what makes the cluster usable BEFORE the first message:
  // the model and thought level can be chosen up front, and they must show as
  // chosen rather than as nothing at all.
  const routed = bound !== undefined || choice !== undefined || ui.chatBoundAgent[sessionId] !== undefined
  const open = (kind: AcpMenuKind, trigger: HTMLElement): void => { openAcpMenu(sessionId, kind, trigger) }

  // The AGENT base is pinned to the RIGHT edge (user decision, 2026-10-17).
  // Ordering, not luck: it is the last child, and the cluster is the rightmost
  // cell of the composer bar, so whatever the agent publishes can only push
  // into the space to its left. Before this the base was the FIRST child, so
  // each extra chip (model, thought level) shoved it further left — the base
  // visibly moved depending on what the agent happened to advertise, which
  // reads as the whole bar reflowing when you switch agents.
  return (
    <span className="ntr-acp-cluster">
      {routed && route.modelLabel !== undefined && (
        <AcpChip
          label={route.modelLabel}
          title={acp.label('agent 自己的模型目录', "the agent's own model directory")}
          active={menu?.sessionId === sessionId && menu.kind === 'model'}
          onClick={(trigger) => { open('model', trigger) }}
        />
      )}
      {routed && route.efforts.length > 0 && (
        <AcpChip
          label={`${acp.label('思考', 'think')} · ${route.effortLabel ?? acp.label('默认', 'default')}`}
          title={acp.label('思考等级（agent 的 thought_level）', "Thought level (the agent's thought_level)")}
          active={menu?.sessionId === sessionId && menu.kind === 'thought'}
          onClick={(trigger) => { open('thought', trigger) }}
        />
      )}
      {/* Last on purpose: this is the fixed right-hand anchor of the cluster. */}
      <AcpChip
        label={route.agentTitle === undefined
          ? (routed ? 'ACP' : acp.label('接入 ACP', 'Use ACP'))
          : `ACP · ${route.agentTitle}`}
        title={acp.label(
          '这个会话由外接 ACP agent 服务；点开可切换 agent、它的模型与思考等级',
          'This conversation is served by an external ACP agent — open to switch the agent, its model and the thought level',
        )}
        active={routed}
        onClick={(trigger) => { open('agent', trigger) }}
      />
    </span>
  )
}

/** Inputs one picker model is built from (kept explicit so the shape stays reviewable). */
export interface MenuContext {
  acp: AcpChatInjected['acp']
  agents: readonly AgentView[]
  route: RouteInfo
  /** The bound agent's own model surface (`agent/catalog`), if it has loaded. */
  catalog?: AgentCatalogResult
  error?: string
}

/** The agent roster rows: one row per configured ACP agent, current one marked. */
function agentSection(context: MenuContext): AcpMenuSection {
  const { acp, route } = context
  const items: AcpMenuItem[] = context.agents.map(agent => ({
    id: agent.id,
    label: agent.title ?? agent.id,
    detail: agentStateText(acp, agent.state),
    dot: STATE_COLORS[agent.state],
    active: route.agentId === agent.id,
  }))
  if (items.length === 0) {
    items.push({
      id: 'none',
      label: acp.label('还没有配置 ACP agent', 'No ACP agent configured yet'),
      detail: acp.label('设置 → ACP 代理', 'Settings → ACP Agents'),
      disabled: true,
    })
  }
  return {
    id: 'agent',
    items,
  }
}

/**
 * The selected agent's OWN models — `undefined` when no agent is known yet.
 *
 * The rows come from `agent/catalog`, not from any DSH model directory: ACP
 * models are not advertised in DSH's catalog at all, and the exposure filter
 * (`exposedModels`) is applied host-side, so what arrives here is exactly what
 * this agent offers in this conversation.
 *
 * ONE ROW PER MODEL, and the checked row names its model (user report,
 * 2026-10-18). The bare `agentId` route ("let the agent choose") is NOT a model,
 * so it is folded onto the row of the model it currently resolves to: the
 * previous shape listed `<agent> · 默认` AND `<agent> · Hy3` as two entries for
 * one model, and the checked one was the row that did not say "Hy3".
 */
function modelSection(context: MenuContext): AcpMenuSection | undefined {
  const { acp, route, catalog } = context
  if (route.agentId === undefined) return undefined
  if (catalog === undefined) {
    // No catalog yet (a fresh conversation, or a host still probing): the
    // current model is the only row we can honestly show.
    return route.modelId === undefined ? undefined : {
      id: 'model',
      title: acp.label(`${route.agentTitle ?? 'agent'} 的模型`, `Models of ${route.agentTitle ?? 'the agent'}`),
      items: [{ id: route.modelId, label: route.modelLabel ?? route.modelId, active: true }],
    }
  }
  // Which model is IN FORCE, as a model VALUE (not a route). `route.modelId` is
  // an adapter id: the bare `agentId` means "the agent's own choice", which the
  // catalog resolves to `currentModel.value`. A variant is a specific value.
  const parsed = splitAcpModelId(route.modelId ?? '')
  const pickedChoice = parsed.choice
  const current = catalog.currentModel
  const inForce = pickedChoice ?? current?.value
  // What the agent offers, as model VALUES. `exposedModels` is a filter over what
  // is OFFERED, not over what works, so a model in force outside this set still
  // gets a row — otherwise the picker would imply the conversation runs another.
  const offered = new Map<string, AcpMenuItem>()
  for (const variant of catalog.variants) {
    const value = splitAcpModelId(variant.id).choice
    if (value === undefined) continue
    offered.set(value, {
      id: variant.id,
      label: variant.name,
      ...(variant.description === undefined ? {} : { detail: variant.description }),
      active: value === inForce,
    })
  }
  // THE BUG IN THE SCREENSHOT (user report, 2026-10-18): the agent is on `hy3`,
  // `hy3` is also exposed, and the list showed `<agent> · 默认 ✓` above
  // `<agent> · Hy3` — two rows for one model, the checkmark on the one that named
  // no model. So: ONE row per model, and the model in force is marked wherever it
  // appears.
  const rows: AcpMenuItem[] = []
  if (inForce !== undefined && !offered.has(inForce)) {
    // Either the agent is on a model its own exposure filter hides, or the
    // conversation picked one that has dropped out of the catalog. Named either
    // way — `route.modelLabel` already resolves the stale-variant case.
    rows.push({
      id: buildAcpModelId(route.agentId, inForce),
      label: `${inForce === current?.value ? current?.name ?? inForce : route.modelLabel ?? inForce} · ${acp.label('当前', 'current')}`,
      detail: acp.label(
        '未在「设置 → ACP 代理」里勾选可见；仍然可用。',
        'Not checked as visible in Settings → ACP Agents; still usable.',
      ),
      active: true,
    })
  }
  if (current === undefined) {
    // The bare `agentId` route could not be resolved to a model — the agent has
    // never been probed (or publishes no model selector). The bare row is then
    // the only honest description of what this conversation runs, and leaving the
    // picker empty would read as broken rather than as unknown.
    //
    // When the route DOES resolve to a model this row is deliberately absent: it
    // would be a second row for that same model, which is precisely the defect
    // being fixed.
    rows.push({
      id: catalog.base.id,
      label: `${catalog.base.name} · ${acp.label('默认', 'default')}`,
      ...(catalog.base.description === undefined ? {} : { detail: catalog.base.description }),
      active: inForce === undefined,
    })
  }
  rows.push(...offered.values())
  return {
    id: 'model',
    title: acp.label(`${route.agentTitle ?? 'agent'} 的模型`, `Models of ${route.agentTitle ?? 'the agent'}`),
    note: catalog.variants.length === 0
      ? acp.label(
        'agent 自己上报的模型目录；这里只列出它当前用的模型，其余可在「设置 → ACP 代理」里勾选可见。',
        "The agent's own model directory; only the model it is on is offered here — enable more in Settings → ACP Agents.",
      )
      : acp.label(
        'agent 自己上报的模型目录；勾选的那条就是这条会话正在用的模型。',
        "The agent's own model directory; the checked row is the model this conversation is running.",
      ),
    items: rows,
  }
}

/** The agent's `thought_level` levels (its own vocabulary). */
function thoughtSection(context: MenuContext): AcpMenuSection {
  const { acp, route } = context
  const items: AcpMenuItem[] = [{
    id: 'provider-default',
    label: acp.label('跟随 provider 默认', 'Provider default'),
    active: route.effectiveEffort === undefined,
  }]
  for (const level of route.efforts) {
    items.push({
      id: level.id,
      label: level.name,
      ...level.description === undefined ? {} : { detail: level.description },
      active: level.id === route.effectiveEffort,
    })
  }  return {
    id: 'thought',
    title: acp.label('思考等级', 'Thought level'),
    note: acp.label(
      '由 agent 的 thought_level 配置项驱动，下一次请求生效。',
      "Driven by the agent's own thought_level option; applies to the next request.",
    ),
    items,
  }
}

/**
 * REMOVED on purpose (2026-10-17): the agent's own `session/set_mode` list used
 * to ride inside the agent base's menu. It has its own control
 * (`AcpComposerMode`, the native-mode select in `conversation.input.left`), so
 * duplicating it in the base made two entries for one setting and put four
 * unrelated axes behind a control whose only job is "who serves this
 * conversation". Do not reintroduce it here — the editor belongs to
 * composer-mode.tsx.
 */

/** Build the picker model for one kind. */
export function menuFor(kind: AcpMenuKind, context: MenuContext): {
  title: string
  note?: string
  sections: AcpMenuSection[]
  error?: string
  loading?: boolean
} {
  const { acp, route } = context

  if (kind === 'agent') {
    // The agent base is ONLY the entry point for starting/replacing the agent
    // (user decision, 2026-10-17). Everything else the agent publishes — its
    // models, its thought levels, its own modes — has a seat of its own and is
    // reached from there, so stacking them in here turned one gesture ("who
    // serves this conversation") into a four-section dump and made the agent
    // list harder to scan. One control, one job.
    //
    // ONE heading, no note (user decision, 2026-10-18): the menu header says it
    // and the section adds no second title. The previous caption spelled out
    // where the other axes live and how switching applies — true, but it read
    // as a manual for a list that is self-explanatory, and it pushed the rows
    // down for no information the user needed at the moment of picking.
    return {
      title: acp.label('选择你的 Agent', 'Choose your agent'),
      sections: [{ ...agentSection(context), title: undefined, note: undefined }],
    }
  }

  if (kind === 'model') {
    const section = modelSection(context)
    if (section === undefined) return { title: acp.label('模型', 'Models'), sections: [] }
    // The single-axis picker keeps the shape it had before: one title + note on
    // the menu header, rows under a header-less section.
    return { title: section.title ?? acp.label('模型', 'Models'), note: section.note, sections: [{ ...section, title: undefined, note: undefined }] }
  }

  if (kind === 'thought') {
    const section = thoughtSection(context)
    return { title: section.title ?? acp.label('思考等级', 'Thought level'), note: section.note, sections: [{ ...section, title: undefined, note: undefined }] }
  }

  return { title: acp.label('ACP', 'ACP'), sections: [] }
}

/**
 * The picker itself, living in the composer's overlay seat. It renders nothing
 * unless a chip of THIS session opened it, so a stale menu can never leak
 * across a session switch.
 */
export function AcpSessionMenu(props: AcpClusterProps) {
  ensureAcpStyle()
  const { acp, sessionId } = props
  const ui = useUi(acp)
  const menu = useAcpMenu()
  const [busy, setBusy] = useState(false)
  const bound = boundSession(ui, sessionId)
  const agents = ui.agents
  const choice = ui.chatChoice[sessionId]
  const agentId = routeAgentId(ui.chatBoundAgent[sessionId], bound, agents, ui.defaultAgent)
  const catalog = agentId === undefined ? undefined : ui.seatCatalogs[agentId]
  // Same rule as the cluster: a menu that is not open, or a conversation that
  // points at no agent, must not read (and so must not probe) anybody's catalog.
  const served = bound !== undefined || choice !== undefined || ui.chatBoundAgent[sessionId] !== undefined
  useEffect(() => {
    if (menu !== null && served && agentId !== undefined) void acp.loadAgentCatalog(agentId)
  }, [acp, menu, served, agentId])

  if (menu === null || menu.sessionId !== sessionId) return null
  const route = describeRoute(agents, bound, ui.defaultAgent, catalog, ui.chatBoundAgent[sessionId], choice)
  // A menu-model bug must never retire the whole picker: a render throw inside
  // this slot entry makes the error boundary ABDICATE it for the rest of the
  // session (every later click silently opens nothing). Show the failure inside
  // the menu instead of dying.
  let model: ReturnType<typeof menuFor>
  try {
    model = menuFor(menu.kind, {
      acp,
      agents,
      route,
      ...catalog === undefined ? {} : { catalog },
      ...menu.error === undefined ? {} : { error: menu.error },
    })
  } catch (error) {
    model = {
      title: acp.label('ACP', 'ACP'),
      sections: [],
      error: error instanceof Error ? error.message : String(error),
    }
  }

  const pick = async (sectionId: string, itemId: string): Promise<void> => {
    // Everything here writes into the PLUGIN's own binding for this chat
    // session — never a DSH model route (see the module header).
    try {
      if (sectionId === 'agent') {
        await acp.bindChatAgent(sessionId, itemId)
      } else if (sectionId === 'model') {
        await acp.setChatSessionModel(sessionId, itemId)
      } else if (sectionId === 'thought') {
        await acp.setChatSessionEffort(sessionId, itemId === 'provider-default' ? undefined : itemId)
      } else {
        // `agent-mode` used to be handled here; the agent's mode list now lives
        // only in the composer-mode control (see the removed-section note).
        return
      }
      await acp.loadChatSessions(sessionId)
      closeAcpMenu()
    } catch (error) {
      setAcpMenuError(error instanceof Error ? error.message : String(error))
    }
  }

  return (
    <AcpMenu
      model={model}
      anchor={menu.trigger}
      onPick={(itemId, sectionId) => {
        if (busy) return
        setAcpMenuError(undefined)
        setBusy(true)
        void pick(sectionId, itemId).finally(() => { setBusy(false) })
      }}
      onClose={() => { closeAcpMenu() }}
    />
  )
}
