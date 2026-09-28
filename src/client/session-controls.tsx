/**
 * The ACP cluster in the conversation composer (`conversation.input.left`) and
 * its picker (`conversation.input.overlay`).
 *
 * WHAT IT IS NOT: a second model selector. The composer already HAS one, and
 * its seat is single-occupancy — this cluster reads and writes the *same*
 * per-session model directory (`ctx.modelDirectories`) the native seat uses, so
 * a switch made in either surface is what the other shows next. That is also
 * what makes it the honest place to pick an ACP agent: an ACP agent IS a route
 * (`acp@<agentId>`), and the host is the single fact source for it.
 *
 * WHAT IT ADDS over the native seat: the ACP side's own vocabulary. The native
 * selector flattens the ACP catalog into rows like "Pi · GLM-5.3", so the three
 * things a person actually thinks in — which agent, which of ITS models, how
 * hard it should think — arrive scrambled into one list. Here they are three
 * chips with the agent as the axis, plus the one setting the ACP side has no
 * other home for: the conversation's DSH Access mode, shown inside the ACP chip
 * as the boundary that actually binds this session's agent (see
 * docs/acp-permission-and-sandbox.md).
 *
 * It is deliberately quiet: the cluster renders NOTHING for a conversation that
 * has never been routed to an ACP agent, so an ordinary chat's tool row is
 * untouched. The ACP view tab is the entry point for those (and for re-entry
 * after a detour through another provider).
 *
 * IN ACP MODE IT STANDS DOWN. The native model seat is taken over by
 * {@link AcpModelSeat} there (`index.tsx`'s seat gate), and that seat owns the
 * same three axes plus the boundary section — leaving the chips up would put two
 * copies of one control in one tool row, which is what this file exists to
 * avoid. Ordinary conversations keep the chips (they are how a session gets
 * ROUTED to an ACP agent in the first place).
 */

import { useEffect, useState } from 'react'
// Type-only: pulls the ui-conversation SlotMap merge into this program.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import {
  ACP_PROVIDER, AcpChip, AcpMenu, closeAcpMenu, ensureAcpStyle, openAcpMenu, selectAcpRoute,
  setAcpMenuError, splitAcpModelId, useAcpMenu, useAcpSeatActive, useDirectory, usePermissionSelect, useUi,
} from './acp-ui.tsx'
import type {
  AcpChatInjected, AcpDirectoryState, AcpMenuKind, AcpMenuItem, AcpMenuSection, AcpSessionFace,
  AcpSessionHook,
} from './acp-ui.tsx'
import type { AgentCatalogResult, AgentView, ChatSessionView } from '../protocol.ts'

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

/** Everything the chips need to describe the current route, computed once. */
interface RouteInfo {
  /** The session is routed to the ACP provider right now. */
  routed: boolean
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
 * The agent serving this conversation: the route's own agent when it is on
 * `acp`, else the last agent that ran here (`bound`), which is what lets a chip
 * offer "back to ACP: <agent>" instead of going blank the moment the user tries
 * another provider.
 */
function routeAgentId(state: AcpDirectoryState | undefined, bound: ChatSessionView | undefined): string | undefined {
  const current = state?.current ?? null
  const routed = current !== null && current.provider === ACP_PROVIDER
  return (routed && current !== null ? splitAcpModelId(current.model).agentId : undefined) ?? bound?.agentId
}

/**
 * Describe this session's ACP route from the host's directory + the agent
 * roster + the agent's own model surface (`agent/catalog`).
 *
 * The model axis reads the ACP catalog, NOT the session's model directory: the
 * directory is DSH's global provider catalog, and the `acp` route advertises
 * nothing there, so an ACP agent's models never appear in a non-ACP
 * conversation (see `AgentCatalogResult`). The directory still owns `current` —
 * it is the single fact source for which route this session is on.
 */
export function describeRoute(
  state: AcpDirectoryState | undefined,
  agents: readonly AgentView[],
  bound: ChatSessionView | undefined,
  catalog?: AgentCatalogResult,
): RouteInfo {
  const current = state?.current ?? null
  const agentId = routeAgentId(state, bound)
  if (agentId === undefined) return { routed: false, efforts: [] }
  const routed = current !== null && current.provider === ACP_PROVIDER
  const def = agents.find(agent => agent.id === agentId)
  const agentTitle = def?.title ?? bound?.agentTitle ?? catalog?.title ?? agentId
  if (!routed || current === null) return { routed: false, agentId, agentTitle, efforts: [] }
  const parsed = splitAcpModelId(current.model)
  const variant = catalog?.variants.find(entry => entry.id === current.model)
  const reasoning = catalog?.reasoning
  const effectiveEffort = current.reasoningEffort ?? reasoning?.defaultEffort
  return {
    routed: true,
    agentId,
    agentTitle,
    modelId: current.model,
    modelLabel: parsed.choice === undefined
      ? catalog?.base.name ?? agentTitle
      : variant?.name ?? parsed.choice,
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
  const { acp, sessionId, directoryFor, useSession } = props
  const ui = useUi(acp)
  const { state } = useDirectory(directoryFor, sessionId)
  const menu = useAcpMenu()
  const running = useSession(snapshot => snapshot.running)
  useEffect(() => {
    void acp.loadChatSessions(sessionId)
  }, [acp, sessionId, running])
  const bound = boundSession(ui, sessionId)
  const agentId = routeAgentId(state, bound)
  const catalog = agentId === undefined ? undefined : ui.seatCatalogs[agentId]
  useEffect(() => {
    if (agentId !== undefined) void acp.loadAgentCatalog(agentId)
  }, [acp, agentId])
  const route = describeRoute(state, ui.agents, bound, catalog)
  // The seat owns the ACP controls in ACP mode (see the module header).
  const seatOwns = useAcpSeatActive()
  // No ACP route and no ACP history: this conversation has no ACP story to
  // tell, and chrome for it would be noise. The ACP view tab owns that entry.
  if (seatOwns || state === undefined || (!route.routed && bound === undefined)) return null
  const open = (kind: AcpMenuKind, trigger: HTMLElement): void => { openAcpMenu(sessionId, kind, trigger) }

  return (
    <span className="ntr-acp-cluster">
      <AcpChip
        label={route.agentTitle === undefined
          ? (route.routed ? 'ACP' : acp.label('接入 ACP', 'Use ACP'))
          : `ACP · ${route.agentTitle}`}
        title={acp.label(
          '这个会话由外接 ACP agent 服务；点开可切换 agent 与会话边界',
          'This conversation is served by an external ACP agent — open to switch the agent and the boundary',
        )}
        active={route.routed}
        onClick={(trigger) => { open('agent', trigger) }}
      />
      {route.routed && route.modelLabel !== undefined && (
        <AcpChip
          label={route.modelLabel}
          title={acp.label('agent 自己的模型目录', "the agent's own model directory")}
          active={menu?.sessionId === sessionId && menu.kind === 'model'}
          onClick={(trigger) => { open('model', trigger) }}
        />
      )}
      {route.routed && route.efforts.length > 0 && (
        <AcpChip
          label={`${acp.label('思考', 'think')} · ${route.effortLabel ?? acp.label('默认', 'default')}`}
          title={acp.label('思考等级（agent 的 thought_level）', "Thought level (the agent's thought_level)")}
          active={menu?.sessionId === sessionId && menu.kind === 'thought'}
          onClick={(trigger) => { open('thought', trigger) }}
        />
      )}
    </span>
  )
}

/** Inputs one picker model is built from (kept explicit so the shape stays reviewable). */
export interface MenuContext {
  acp: AcpChatInjected['acp']
  agents: readonly AgentView[]
  route: RouteInfo
  /** The routed agent's own model surface (`agent/catalog`), if it has loaded. */
  catalog?: AgentCatalogResult
  state?: AcpDirectoryState
  permissions?: { options: readonly { value: string; name: string; description?: string }[]; currentValue: string }
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
    active: route.routed && route.agentId === agent.id,
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
    title: acp.label('智能体（这个会话由谁服务）', 'Agent (who serves this conversation)'),
    note: acp.label(
      '切换从下一条消息开始生效；同一个 agent 内换模型/思考等级不会丢上下文。',
      'A switch applies from your next message; model/effort changes inside one agent keep its context.',
    ),
    items,
  }
}

/**
 * The selected agent's OWN models — `undefined` when no agent is known yet.
 *
 * The rows come from `agent/catalog`, not from the session's model directory:
 * ACP models are not advertised in DSH's catalog at all, and the exposure
 * filter (`exposedModels`) is applied host-side, so what arrives here is
 * exactly what this agent offers in this conversation. `catalog.base` is the
 * agent's default model (the bare `agentId` route) and is always offered.
 */
function modelSection(context: MenuContext): AcpMenuSection | undefined {
  const { acp, route, catalog } = context
  if (route.agentId === undefined) return undefined
  const items: AcpMenuItem[] = catalog === undefined
    // No catalog yet (a fresh conversation, or a host still probing): the
    // current route is the only row we can honestly show.
    ? (route.modelId === undefined ? [] : [{ id: route.modelId, label: route.modelLabel ?? route.modelId, active: true }])
    : [
      // The session can sit on a model the list no longer offers: `exposedModels`
      // is a filter over what is OFFERED, not over what works (an unexposed
      // variant still resolves — see `resolveAdapterModel`), and an agent may
      // simply have dropped a choice. Marking where we are keeps the picker from
      // implying the session runs the default.
      ...(route.modelId === undefined
        || route.modelId === catalog.base.id
        || catalog.variants.some(variant => variant.id === route.modelId)
        ? []
        : [{
          id: route.modelId,
          label: `${route.modelLabel ?? route.modelId} · ${acp.label('当前', 'current')}`,
          detail: acp.label(
            '未在「设置 → ACP 代理」里勾选可见；仍然可用。',
            'Not checked as visible in Settings → ACP Agents; still usable.',
          ),
          active: true,
        }]),
      {
        id: catalog.base.id,
        label: `${catalog.base.name} · ${acp.label('默认', 'default')}`,
        ...(catalog.base.description === undefined ? {} : { detail: catalog.base.description }),
        active: catalog.base.id === route.modelId,
      },
      ...catalog.variants.map(variant => ({
        id: variant.id,
        label: variant.name,
        ...(variant.description === undefined ? {} : { detail: variant.description }),
        active: variant.id === route.modelId,
      })),
    ]
  return {
    id: 'model',
    title: acp.label(`${route.agentTitle ?? 'agent'} 的模型`, `Models of ${route.agentTitle ?? 'the agent'}`),
    note: catalog !== undefined && catalog.variants.length === 0
      ? acp.label(
        'agent 自己上报的模型目录；这里只列出默认模型，其余可在「设置 → ACP 代理」里勾选可见。',
        "The agent's own model directory; only its default is offered here — enable more in Settings → ACP Agents.",
      )
      : acp.label(
        'agent 自己上报的模型目录；带「默认」的一条是它的默认模型。',
        "The agent's own model directory; the row marked default is its default model.",
      ),
    items,
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
  }
  return {
    id: 'thought',
    title: acp.label('思考等级', 'Thought level'),
    note: acp.label(
      '由 agent 的 thought_level 配置项驱动，下一次请求生效。',
      "Driven by the agent's own thought_level option; applies to the next request.",
    ),
    items,
  }
}

/** The session's DSH Access mode, when the host projects one for it. */
function boundarySection(context: MenuContext): AcpMenuSection | undefined {
  const { acp } = context
  const permissions = context.permissions
  // Both fields are runtime values from a projection + a remote catalog, not
  // types: never trust either shape (a `.length` off an absent `options` used
  // to throw here, and a throw inside a slot entry retires the whole picker).
  if (permissions === undefined
    || !Array.isArray(permissions.options)
    || permissions.options.length === 0) return undefined
  return {
    id: 'boundary',
    title: acp.label('会话边界（DSH Access mode）', 'Conversation boundary (DSH access mode)'),
    note: acp.label(
      'agent 的工具跑在它自己的进程里，DSH 的沙箱管不到它；这一档规定的是宿主给我们这道闸门的边界（写盘与询问）。',
      "The agent's tools run in its own process, beyond the DSH sandbox; this preset is what binds our gate — its writes and its asks.",
    ),
    items: permissions.options
      .filter(option => typeof option?.value === 'string' && option.value !== 'custom')
      .map(option => ({
        id: option.value,
        label: option.name,
        ...option.description === undefined ? {} : { detail: option.description },
        active: option.value === permissions.currentValue,
      })),
  }
}

/** Build the picker model for one kind. */
export function menuFor(kind: AcpMenuKind, context: MenuContext): {
  title: string
  note?: string
  sections: AcpMenuSection[]
  error?: string
  loading?: boolean
} {
  const { acp, route, state } = context
  const loading = state?.status === 'loading' || state?.status === 'selecting'
  const error = context.error ?? state?.error ?? undefined
  const common = { ...loading ? { loading: true } : {}, ...error === null || error === undefined ? {} : { error } }

  if (kind === 'seat') {
    // The ACP-mode seat's own screen: all three axes in one list, because in ACP
    // mode there is no other surface left to pick a model in.
    const sections: AcpMenuSection[] = [agentSection(context)]
    const model = modelSection(context)
    if (model !== undefined) sections.push(model)
    if (route.efforts.length > 0) sections.push(thoughtSection(context))
    const boundary = boundarySection(context)
    if (boundary !== undefined) sections.push(boundary)
    return {
      ...common,
      title: acp.label('ACP 模式', 'ACP mode'),
      note: acp.label(
        '这条会话跑的是 ACP 预设：模型只能是对端 agent。别的模型在这条会话里没有工具、也不是它在说话。',
        'This session runs the ACP preset: the model can only be the external agent. Any other model would have no tools here — and it would not be the agent talking.',
      ),
      sections,
    }
  }

  if (kind === 'agent') {
    const sections: AcpMenuSection[] = [agentSection(context)]
    const boundary = boundarySection(context)
    if (boundary !== undefined) sections.push(boundary)
    return { ...common, title: acp.label('ACP 模式', 'ACP mode'), sections }
  }

  if (kind === 'model') {
    const section = modelSection(context)
    if (section === undefined) return { ...common, title: acp.label('模型', 'Models'), sections: [] }
    // The single-axis pickers keep the shape they had before the seat existed:
    // one title + note on the menu header, rows under a header-less section.
    return { ...common, title: section.title ?? acp.label('模型', 'Models'), note: section.note, sections: [{ ...section, title: undefined, note: undefined }] }
  }

  if (kind === 'thought') {
    const section = thoughtSection(context)
    return { ...common, title: section.title ?? acp.label('思考等级', 'Thought level'), note: section.note, sections: [{ ...section, title: undefined, note: undefined }] }
  }

  return { ...common, title: acp.label('ACP', 'ACP'), sections: [] }
}

/**
 * The picker itself, living in the composer's overlay seat. It renders nothing
 * unless a chip of THIS session opened it, so a stale menu can never leak
 * across a session switch.
 */
export function AcpSessionMenu(props: AcpClusterProps) {
  ensureAcpStyle()
  const { acp, sessionId, directoryFor, faceFor, permissionCatalogFor } = props
  const ui = useUi(acp)
  const { directory, state } = useDirectory(directoryFor, sessionId)
  const permissions = usePermissionSelect(faceFor, sessionId, permissionCatalogFor)
  const menu = useAcpMenu()
  const [busy, setBusy] = useState(false)
  const bound = boundSession(ui, sessionId)
  const agentId = routeAgentId(state, bound)
  const catalog = agentId === undefined ? undefined : ui.seatCatalogs[agentId]
  useEffect(() => {
    if (agentId !== undefined) void acp.loadAgentCatalog(agentId)
  }, [acp, agentId])

  if (menu === null || menu.sessionId !== sessionId) return null
  const route = describeRoute(state, ui.agents, bound, catalog)
  // A menu-model bug must never retire the whole picker: a render throw inside
  // this slot entry makes the error boundary ABIDATE it for the rest of the
  // session (every later click silently opens nothing — that was the reported
  // "ACP seat clicks do nothing" bug, caused by `boundarySection` reading
  // `options.length` off the projection, which has no `options`). Show the
  // failure inside the menu instead of dying.
  let model: ReturnType<typeof menuFor>
  try {
    model = menuFor(menu.kind, {
      acp,
      agents: ui.agents,
      route,
      ...catalog === undefined ? {} : { catalog },
      ...state === undefined ? {} : { state },
      ...permissions === undefined ? {} : { permissions },
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
    if (sectionId === 'boundary') {
      const face = safeFace(faceFor, sessionId)
      if (face === undefined) {
        setAcpMenuError(acp.label('这个会话还不能执行命令', 'this session cannot run commands yet'))
        return
      }
      try {
        const result = await face.command(`/permission ${itemId}`)
        if (!result.ok) {
          setAcpMenuError(`${result.error.code}: ${result.error.message}`)
          return
        }
        if (!result.value.matched) {
          setAcpMenuError(acp.label('这台宿主没有注册 /permission 命令', 'this host registers no /permission command'))
          return
        }
      } catch (error) {
        setAcpMenuError(text(error))
        return
      }
      closeAcpMenu()
      return
    }
    if (directory === undefined) {
      setAcpMenuError(acp.label('这台宿主没有模型目录服务', 'this host exposes no model directory service'))
      return
    }
    // The native seat's rule, mirrored: picking a model adopts that route's own
    // default effort (composing a stale effort onto a fresh model is how a
    // selector starts lying about what will actually run).
    const selection = sectionId === 'agent'
      ? { provider: ACP_PROVIDER, model: itemId }
      : sectionId === 'model'
        ? {
          provider: ACP_PROVIDER,
          model: itemId,
          // The agent's own default effort for whatever model it is on now:
          // composing a stale effort onto a fresh model is how a selector
          // starts lying about what will actually run.
          ...catalog?.reasoning?.defaultEffort === undefined ? {} : { reasoningEffort: catalog.reasoning.defaultEffort },
        }
        : {
          provider: ACP_PROVIDER,
          model: route.modelId ?? '',
          ...itemId === 'provider-default' ? {} : { reasoningEffort: itemId },
        }
    if (selection.model === '') {
      setAcpMenuError(acp.label('当前没有可切换的模型', 'there is no model to switch to right now'))
      return
    }
    try {
      // Never `directory.select` directly: an ACP pick must not become the
      // deployment default model (see `selectAcpRoute`).
      await selectAcpRoute(acp, directory, selection)
      closeAcpMenu()
    } catch (error) {
      setAcpMenuError(text(error))
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

/**
 * The ACP-mode model seat: what occupies the composer's `conversation.input.model`
 * seat while this session runs the ACP agent preset.
 *
 * WHY IT EXISTS: the native seat's catalog is built host-wide from every
 * registered provider — there is no per-session seam on the host side — so in an
 * ACP session it offers models that cannot work there at all: the ACP preset
 * strips the host's tools, and the session is the external agent's turn anyway.
 * The seat is registered at a lower shadowing rank by the gate in `index.tsx`,
 * and only ever while an ACP-mode session is current; every other session keeps
 * the untouched native seat. It reads and writes the SAME per-session model
 * directory (`ctx.modelDirectories`) as everything else here.
 *
 * The `/model` command popup is NOT ours to hide (a command contribution, not a
 * slot), so the seat also reports the case it cannot prevent: a route pointed
 * at another provider shows up as a warning-colored seat whose menu switches
 * back to an agent.
 */
export interface AcpSeatProps extends AcpChatInjected {
  sessionId: string
  /** The seat's owner share (`InputControlOwnerProps`): the bar's chrome lock. */
  locked?: boolean
}

/** The composer's model seat while the session runs the ACP preset. */
export function AcpModelSeat(props: AcpSeatProps) {
  ensureAcpStyle()
  const { acp, sessionId, directoryFor } = props
  const ui = useUi(acp)
  const { state } = useDirectory(directoryFor, sessionId)
  const menu = useAcpMenu()
  useEffect(() => {
    void acp.loadChatSessions(sessionId)
  }, [acp, sessionId])
  const bound = boundSession(ui, sessionId)
  const agentId = routeAgentId(state, bound)
  const catalog = agentId === undefined ? undefined : ui.seatCatalogs[agentId]
  useEffect(() => {
    if (agentId !== undefined) void acp.loadAgentCatalog(agentId)
  }, [acp, agentId])
  const route = describeRoute(state, ui.agents, bound, catalog)
  const open = menu?.sessionId === sessionId && menu.kind === 'seat'
  // A directory that has not answered yet is NOT a route that left ACP: only a
  // loaded catalog may say the current model belongs to somebody else, or the
  // warning would flash on every mount.
  const pendingRoute = state === undefined || (state.current === null && (state.status === 'idle' || state.status === 'loading'))
  // Not routed = the session's model was pointed elsewhere (the `/model` popup
  // can still do that); the menu's agent section is the way back.
  const detached = !route.routed && !pendingRoute
  const sub = [route.modelLabel, route.effortLabel]
    .filter((part): part is string => part !== undefined && part !== '')
    .join(' · ')
  return (
    <button
      type="button"
      className={`ntr-acp-seat${open ? ' is-open' : ''}${detached ? ' is-detached' : ''}`}
      aria-haspopup="menu"
      disabled={props.locked === true}
      title={detached
        ? acp.label(
          '这条会话跑的是 ACP 预设，但当前模型不是 ACP agent（那个模型在这里没有工具）——点开切回',
          'This session runs the ACP preset, but its model is not an ACP agent (that model has no tools here) — open to switch back',
        )
        : acp.label(
          'ACP 模式：模型只能是对端 agent。点开可切换 agent、它的模型与思考等级',
          'ACP mode: the model can only be the external agent. Open to switch the agent, its model and the thought level',
        )}
      onClick={(event) => {
        openAcpMenu(sessionId, 'seat', event.currentTarget)
      }}
    >
      <span className="ntr-acp-seat-main">{route.agentTitle === undefined ? 'ACP' : `ACP · ${route.agentTitle}`}</span>
      {sub !== '' && <span className="ntr-acp-seat-sub">{sub}</span>}
      <span className="ntr-acp-caret" aria-hidden>▾</span>
    </button>
  )
}

/** Resolve the session face without letting a missing session throw through render. */
function safeFace(faceFor: AcpChatInjected['faceFor'], sessionId: string): AcpSessionFace | undefined {
  try {
    return faceFor(sessionId)
  } catch {
    return undefined
  }
}

function text(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
