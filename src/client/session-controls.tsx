/**
 * The ACP base in the conversation composer's model seat
 * (`conversation.input.model`) and its picker (`conversation.input.overlay`).
 *
 * WHAT IT IS: the base of an ACP conversation. The first level is WHICH agent
 * serves it; hanging off that are the things the agent itself owns — its own
 * permission preset, its own model, its own thought level, and any further
 * config options it publishes (the "advanced" base). All of them come from the
 * agent (`agent/catalog`, the agent's own mode list), never from DSH's model
 * catalog: an ACP agent is not a DSH provider, and DSH's catalog has no
 * per-session seam to filter it with anyway. See
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
 * WHAT IT ADDS over a bare model selector: the axes are separate. A native
 * selector would flatten them into one list of "Agent · Model" rows; here
 * "which agent", "which of ITS models", "how hard it thinks" and every extra
 * option the agent publishes are chips of their own. Before the first turn the
 * agent base is the fixed right-hand anchor; the advanced entry sits left of
 * the model, and model / thought sit between them. Once the lock retires the
 * base, model / thought inherit the right edge (user decision, 2026-10-21).
 *
 * ONE CONVERSATION, ONE AGENT (user decision, 2026-10-20): once this
 * conversation's first turn STARTS — its ACP session materializes, before the
 * prompt is sent — the agent base steps aside and the conversation is LOCKED to
 * that agent. The current agent then lives on a small, read-only tag that rides
 * the composer card's top edge (`AcpComposerAgentTag`, installed in
 * `conversation.input.overlay`). Before that first turn the base stays, so a
 * pick can still be changed before it is committed to a message. See
 * `agentBaseHidden`.
 *
 * The lock is provisional until that first turn delivers something: a turn
 * that ends without any visible block (an error before the first chunk, a
 * silent provider failure, a cancel) is rolled back by the host, the base
 * returns, and the picker works again. The composer learns both transitions
 * from `chat/agent-locked` / `chat/agent-unlocked`, not from a list read.
 *
 * The hand-off is a shatter-and-condense animation (`agent-lock-anim.ts`): the
 * base breaks into debris, then the tag forms from it. The two live in
 * different slots, so they share that module's phase clock rather than trying
 * to animate across slot boundaries.
 *
 * It is deliberately quiet: the base renders NOTHING for a conversation no ACP
 * agent has served, so an ordinary chat is untouched even before the gate
 * stands down. The ACP view tab is the entry point for those (and for re-entry
 * after a detour through another provider).
 */

import { useEffect, useState } from 'react'
import type { CSSProperties } from 'react'
// Type-only: pulls the ui-conversation SlotMap merge into this program.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import {
  AcpChip, AcpMenu, AcpShatterParts, buildAcpModelId, closeAcpMenu, ensureAcpStyle,
  openAcpMenu, setAcpMenuError, splitAcpModelId, useAcpMenu, useUi,
} from './acp-ui.tsx'
import { playAgentLockAnim, useAgentLockPhase } from './agent-lock-anim.ts'
import type {
  AcpChatInjected, AcpMenuKind, AcpMenuItem, AcpMenuSection, AcpSessionHook,
} from './acp-ui.tsx'
import type { AcpConversationChoice, AcpTagHalo, AgentCatalogResult, AgentView, ChatSessionView } from '../protocol.ts'

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
 *
 * `undefined` IS an answer, not a gap: with no binding, no live session and no
 * plugin default the guard's route rewrite has nothing to rewrite with and the
 * turn runs on the deployment default provider (see `boundModelFor` in
 * presets/acp/acp-guard.mjs). This function used to end in `agents[0]?.id`,
 * which put the first configured agent on the chip in exactly that state — a
 * name no message would ever reach (audit finding F5). The honest chip there is
 * the "选择 Agent" entry point, not a borrowed name.
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
  return undefined
}

/**
 * The agent this conversation is LOCKED to, if its first ACP turn has run.
 *
 * The host's `lockedAgentId` is the durable answer: it is written when the
 * first ACP session materializes and it survives restarts, so it is the only
 * source that can still answer after the session is gone. The live/released
 * session is the fallback for a host half from before the lock existed — the
 * moment a session exists, the conversation already has context with it.
 *
 * There is deliberately no roster check: a deleted agent still owns the
 * conversation's context, and pretending the conversation is unbound would
 * bring back a picker the turn path has to refuse. The tag names the id even
 * when no title is left.
 */
export function lockedAgentOf(
  hostLockedAgentId: string | undefined,
  bound: ChatSessionView | undefined,
): string | undefined {
  return hostLockedAgentId ?? bound?.agentId
}

/**
 * Whether the composer's agent base has done its job and should step aside.
 *
 * The timing is the product decision (2026-10-20): at the START of this
 * conversation's first turn. A conversation that merely recorded a pick is
 * still being set up; the user may change their mind before sending, and
 * hiding the base there would strand the pick. Once locked, the base only
 * comes back if the host ROLLS THE LOCK BACK — a first turn that delivered
 * nothing, so there is no context to protect. It also stays retired when the
 * locked agent has been deleted from the roster: the conversation's context
 * still belongs to it.
 */
export function agentBaseHidden(lockedTo: string | undefined): boolean {
  return lockedTo !== undefined
}

/**
 * Whether the composer-edge `NTR · <agent>` tag should render.
 *
 * The tag is the locked agent's nameplate: it appears exactly when the base
 * has stood down. The `acpMode` gate matters because the overlay entry is
 * registered for EVERY conversation while `ui.chatSessions` can still carry an
 * ACP session record after a conversation switched back to an ordinary preset:
 * an explicit `false` verdict must win over that lingering record, or the tag
 * would keep advertising an agent the conversation no longer runs. `undefined`
 * is "the host has not answered yet" and falls back to the lock itself, which
 * is proof this conversation was served by an agent.
 */
export function agentTagVisible(
  acpMode: boolean | undefined,
  lockedTo: string | undefined,
): boolean {
  return (acpMode ?? true) && lockedTo !== undefined
}

/**
 * Whether the tagged agent is LIVE: an ACP session serves this conversation
 * right now and it is not released (the process is up, or at least the host
 * has not marked the session suspended). This drives the tag's breathing
 * halo — released must turn it off, and the named agent must be the one the
 * live session actually serves. No session view at all reads as not alive:
 * before the first answer the state says nothing about the process.
 */
export function agentTagAlive(
  bound: ChatSessionView | undefined,
  lockedTo: string | undefined,
): boolean {
  return bound !== undefined && !bound.released && bound.agentId === lockedTo
}

/** One breath cycle per halo speed, in seconds. Settings card offers these three. */
export const TAG_HALO_PERIODS: Record<AcpTagHalo['speed'], string> = {
  slow: '5.2s',
  normal: '3.2s',
  fast: '1.2s',
}

/**
 * The tag's halo presentation for one setting: the extra classes for the tag
 * span (`alive` — the session is live; steady mode replaces the pulse with a
 * constant glow) and the CSS variable the stylesheet reads for the period.
 * The variable is set for breath mode only: in steady mode nothing animates,
 * so a stale variable could never leak into the reduced-motion fallback.
 */
export function agentTagHaloPresentation(
  halo: AcpTagHalo,
  alive: boolean,
): { classes: string; style: CSSProperties } {
  if (!alive) return { classes: '', style: {} }
  if (halo.mode === 'steady') return { classes: ' is-alive is-steady', style: {} }
  return { classes: ' is-alive', style: { '--ntr-halo-period': TAG_HALO_PERIODS[halo.speed] } as CSSProperties }
}

/**
 * Describe this conversation's ACP agent from the binding (the host's record of
 * which agent actually serves it) + the agent roster + the agent's own model
 * surface (`agent/catalog`).
 *
 * An `undefined` agentId means nothing serves this conversation's next message
 * (see `routeAgentId`); every axis then degrades to nothing rather than naming
 * an agent the request path will never use.
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
  // A model the conversation picked may be outside `exposedModels` (the pick
  // outlives the visibility filter). Its NAME is still known from the catalog's
  // `currentModel` when the values agree — show that instead of the raw value.
  const currentName = catalog?.currentModel !== undefined && parsed.choice === catalog.currentModel.value
    ? catalog.currentModel.name
    : undefined
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
      : variant?.name ?? currentName ?? parsed.choice
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

/** One extra config option as the advanced base presents it. */
export interface AdvancedOption {
  configId: string
  name: string
  /** The conversation's pick, else the value the agent reports as current. */
  value?: string
  choices: readonly { id: string; name: string; description?: string }[]
}

/**
 * The agent's extra config options for one conversation, with the
 * conversation's own pick folded over the agent-reported current value.
 *
 * `choice` only applies when it belongs to the catalog's agent: a stale pick
 * from a previous agent is the previous agent's vocabulary and must not label
 * the new one's menu (same rule as `describeRoute`). Options are whatever the
 * agent publishes beyond model / thought level / mode — those have their own
 * controls, and duplicating them here would present two truths for one axis.
 */
export function advancedOptions(
  catalog: AgentCatalogResult | undefined,
  choice?: AcpConversationChoice,
): AdvancedOption[] {
  const extras = catalog?.extras ?? []
  if (catalog === undefined || extras.length === 0) return []
  const picked = choice !== undefined && choice.agentId === catalog.agentId ? choice.extraConfigs : undefined
  return extras.map(option => {
    const value = picked?.[option.configId] ?? option.currentValue
    return {
      configId: option.configId,
      name: option.name,
      ...(value === undefined ? {} : { value }),
      choices: option.choices,
    }
  })
}

/**
 * The agent base chip's label and tooltip (audit findings F5 and F26).
 *
 * The label names an agent ONLY when one actually serves this conversation:
 * `route.agentId` is the binding, the live session or the plugin default, and
 * each of those is a name the request path uses (see `routeAgentId`). With none
 * of them the chip is the "选择 Agent" entry point and says so — the old
 * `agents[0]` fallback put a stranger's name on a conversation whose next
 * message would run on the deployment default provider.
 *
 * The tooltip claims only what the menu behind the chip does: switch the agent.
 * The agent's models and thought levels have chips of their own (user decision,
 * 2026-10-17), so the previous wording — "switch the agent, its model and the
 * thought level" — promised a menu that holds the roster alone.
 */
export function agentBaseChip(
  route: RouteInfo,
  routed: boolean,
  acp: AcpChatInjected['acp'],
): { label: string; title: string } {
  const label = route.agentTitle === undefined
    ? (routed ? 'NTR' : acp.label('选择 Agent', 'Choose agent'))
    : `NTR · ${route.agentTitle}`
  const title = route.agentId === undefined
    ? acp.label(
      '这条会话当前没有 NTR agent 服务；点开可选择 agent',
      'No NTR agent is serving this conversation right now — open to choose one',
    )
    : acp.label(
      '这条会话由外接 NTR agent 服务；点开可切换 agent',
      'This conversation is served by an external NTR agent — open to switch the agent',
    )
  return { label, title }
}

/**
 * The composer-edge tag's label and tooltip.
 *
 * This tag is where the agent identity lives once the composer base steps
 * aside (see `agentBaseHidden`), so it names the agent unconditionally — the
 * caller only mounts it when the conversation is locked. It is a nameplate,
 * not a control: the tooltip says the lock is one-way and points at the only
 * way to use another agent (a new conversation).
 */
export function agentTagChip(agentTitle: string, acp: AcpChatInjected['acp']): { label: string; title: string } {
  return {
    label: `NTR · ${agentTitle}`,
    title: acp.label(
      `这条会话已锁定在 ${agentTitle}；首轮开始后不能切换 agent（上下文属于它）。换 agent 请新建会话。`,
      `This conversation is locked to ${agentTitle}. It cannot switch agents once the first turn has started — the context belongs to it. Start a new conversation to use another agent.`,
    ),
  }
}

/**
 * The agent tag riding the composer card's top edge
 * (`conversation.input.overlay`).
 *
 * The composer's agent base retires when the conversation's first ACP turn
 * starts, and that turn LOCKS the conversation to its agent (user decision,
 * 2026-10-20): a different agent would have none of the context. This tag is
 * therefore a NAMEPLATE, not a control — it keeps "who serves this
 * conversation" on screen and says why it cannot change. It deliberately has
 * no click target and no caret: the only way to use another agent is a new
 * conversation. If the turn delivered nothing, the host rolls the lock back
 * and this tag leaves with it.
 *
 * WHERE IT SITS: the overlay anchor is a zero-height absolute box at the top
 * edge of the composer card, so the tag's wrapper straddles that edge (see
 * `.ntr-acp-tag` in acp-ui.tsx) — half above the card, half inside it, like a
 * small nameplate hung on the box. This is deliberately NOT the session
 * header: the tag belongs to the input it describes, and the header is shared
 * with conversation chrome that is not about the agent.
 *
 * It gates itself: the overlay slot is registered for EVERY conversation, so
 * it must not leak `NTR · <agent>` into ordinary chats, and it may only appear
 * once the base has actually stood down (see `agentTagVisible`).
 */
export function AcpComposerAgentTag(props: AcpClusterProps) {
  ensureAcpStyle()
  const { acp, sessionId, useSession } = props
  const ui = useUi(acp)
  const running = useSession(snapshot => snapshot.running)
  useEffect(() => {
    void acp.loadChatSessions(sessionId)
  }, [acp, sessionId, running])
  const bound = boundSession(ui, sessionId)
  const lockedTo = lockedAgentOf(ui.chatLockedAgent[sessionId], bound)
  const reveal = ui.agentLockReveal[sessionId]
  const phase = useAgentLockPhase(sessionId, reveal)
  // Both surfaces start the same clock; whichever effect runs first wins and
  // the other is a no-op (playAgentLockAnim is idempotent per reveal). The
  // lock arrives at the START of the first turn (chat/agent-locked), so the
  // hand-off plays while the turn runs — see agent-lock-anim.ts.
  useEffect(() => {
    if (reveal !== undefined) playAgentLockAnim(sessionId, reveal)
  }, [reveal, sessionId])
  // The tag stays away while the base is still breaking apart: the hand-off is
  // base → debris → tag, never both on screen at once.
  if (phase === 'shatter') return null
  if (!agentTagVisible(ui.acpMode[sessionId], lockedTo) || lockedTo === undefined) return null
  const agentTitle = ui.agents.find(agent => agent.id === lockedTo)?.title ?? bound?.agentTitle ?? lockedTo
  // The halo rides the settled tag only: while the forming animation owns the
  // chip its `animation` shorthand must not be overridden mid-flight.
  const alive = phase !== 'form' && agentTagAlive(bound, lockedTo)
  const halo = agentTagHaloPresentation(ui.tagHalo, alive)
  return (
    <span
      className={`ntr-acp-tag${phase === 'form' ? ' is-forming' : ''}${halo.classes}`}
      style={halo.style}
    >
      <AcpChip {...agentTagChip(agentTitle, acp)}>
        {phase === 'form' && <AcpShatterParts mode="in" />}
      </AcpChip>
    </span>
  )
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
  // The lock is resolved BEFORE the agent route: a locked conversation belongs
  // to its agent even when no session is live, so it must never fall back to
  // the plugin default (that would put another agent's models and thought
  // levels on its bar).
  const lockedTo = lockedAgentOf(ui.chatLockedAgent[sessionId], bound)
  // The lock hand-off (see agent-lock-anim.ts): the tag slot in the overlay
  // starts the same clock from its own effect; either call arms it once.
  const reveal = ui.agentLockReveal[sessionId]
  const lockPhase = useAgentLockPhase(sessionId, reveal)
  useEffect(() => {
    if (reveal !== undefined) playAgentLockAnim(sessionId, reveal)
  }, [reveal, sessionId])
  const agentId = lockedTo ?? routeAgentId(ui.chatBoundAgent[sessionId], bound, agents, ui.defaultAgent)
  // A deleted locked agent has no surface to show: suppress its chips instead
  // of keeping a dead agent's last-known model menu interactive.
  const agentListed = agentId !== undefined && agents.some(agent => agent.id === agentId)
  const catalog = agentListed ? ui.seatCatalogs[agentId] : undefined
  // Read the catalog ONLY for a conversation that actually points at an agent
  // (`routeAgentId`'s answer, which includes the plugin default). The old gate
  // listed only bound / pick / optimistic binding, so a NEW conversation
  // served by the default agent showed no model/thought chips until the user
  // re-picked the agent by hand. `agent/catalog` is pure memory (it never
  // spawns), so reading the default agent's surface cannot start a process.
  // (The 2026-10-18 spawn report is about the retired probe-on-read path;
  // the host answers this RPC from memory.)
  const served = agentId !== undefined
  useEffect(() => {
    if (served && agentListed && agentId !== undefined) void acp.loadAgentCatalog(agentId)
  }, [acp, served, agentListed, agentId])
  const route = describeRoute(
    agents,
    bound,
    // A locked conversation has no default fallback: the lock is the answer.
    lockedTo === undefined ? ui.defaultAgent : undefined,
    catalog,
    lockedTo ?? ui.chatBoundAgent[sessionId],
    choice,
  )
  // A conversation with no ACP story to tell gets no chrome: the ACP view tab
  // owns the entry point for starting one.
  if (bound === undefined && agents.length === 0) return null
  // Set up = an agent serves this conversation: a live session, a persisted
  // pick, the host's optimistic binding, OR the plugin default the guard's
  // route rewrite falls back to. The last one is what makes a brand-new
  // conversation show its model / thought chips without a manual re-pick.
  const routed = route.agentId !== undefined
  // The base's retirement and the conversation's one-way agent lock are the
  // same event (see `agentBaseHidden`): the first ACP turn. From then on the
  // base never comes back, and the tag is the only place the agent's name
  // lives.
  //
  // The picker could already be open when the first turn starts (clicking the
  // send button is inside the composer card, which AcpMenu treats as its own
  // furniture, so it does not close the menu). Once locked, that menu can only
  // offer a switch the host will refuse — close it instead of leaving a live
  // control over a locked conversation.
  useEffect(() => {
    if (lockedTo === undefined || menu === null) return
    if (menu.sessionId === sessionId && menu.kind === 'agent') closeAcpMenu()
  }, [lockedTo, menu?.sessionId, menu?.kind, sessionId])
  // Keep the base mounted for the shatter half even though the lock already
  // retired it: unmounting on the same commit the lock arrives would skip the
  // transition entirely (the tag waits for the same phase to leave 'shatter').
  const shattering = lockPhase === 'shatter' && lockedTo !== undefined
  const showAgentBase = !agentBaseHidden(lockedTo) || shattering
  const modelLabel = routed ? route.modelLabel : undefined
  const showModel = agentListed && modelLabel !== undefined
  const showThought = agentListed && routed && route.efforts.length > 0
  const extras = advancedOptions(catalog, choice)
  const showAdvanced = agentListed && routed && extras.length > 0
  // Nothing left to show: the cell stays claimed (the claim owns it), but this
  // occupant renders an empty cluster rather than a bare wrapper.
  if (!showAgentBase && !showAdvanced && !showModel && !showThought) return null
  const open = (kind: AcpMenuKind, trigger: HTMLElement): void => { openAcpMenu(sessionId, kind, trigger) }

  // Ordering (user decision, 2026-10-21): the AGENT base stays the fixed
  // right-hand anchor BEFORE the first turn — that is where users know it
  // from, and it must not be squeezed out by chips the agent happens to
  // publish. The advanced entry sits immediately left of the model, so the
  // agent's extra options never push the primary axes around. Once the first
  // turn locks the conversation the base retires (2026-10-20) and the
  // model / thought pair inherits the right edge.
  return (
    <span className="ntr-acp-cluster">
      {/* Immediately left of the model: the advanced base collects everything
          the agent publishes that is NOT one of the primary axes. */}
      {showAdvanced && (
        <AcpChip
          label={`${acp.label('高级', 'Advanced')} · ${String(extras.length)}`}
          title={acp.label(
            `agent 的额外配置项：${extras.map(option => option.name).join('、')}`,
            `extra agent config options: ${extras.map(option => option.name).join(', ')}`,
          )}
          active={menu?.sessionId === sessionId && menu.kind === 'advanced'}
          onClick={(trigger) => { open('advanced', trigger) }}
        />
      )}
      {showModel && modelLabel !== undefined && (
        <AcpChip
          label={modelLabel}
          title={acp.label('agent 自己的模型目录', "the agent's own model directory")}
          active={menu?.sessionId === sessionId && menu.kind === 'model'}
          onClick={(trigger) => { open('model', trigger) }}
        />
      )}
      {showThought && (
        <AcpChip
          label={`${acp.label('思考', 'think')} · ${route.effortLabel ?? acp.label('默认', 'default')}`}
          title={acp.label('思考等级（agent 的 thought_level）', "Thought level (the agent's thought_level)")}
          active={menu?.sessionId === sessionId && menu.kind === 'thought'}
          onClick={(trigger) => { open('thought', trigger) }}
        />
      )}
      {/* Last on purpose while present: the fixed right-hand anchor before the
          lock. CSS gives the last chip `flex: none`, so a long model name or
          an extra chip can only squeeze what is to its left — the agent base
          never disappears. It retires after the first ACP turn (user decision,
          2026-10-20) and the composer-edge tag replaces it; the retirement
          itself is the shatter played here (see `shattering`). */}
      {showAgentBase && (
        <AcpChip
          {...agentBaseChip(route, routed, acp)}
          active={routed}
          className={shattering ? 'ntr-acp-shatter' : undefined}
          onClick={shattering ? undefined : (trigger) => { open('agent', trigger) }}
        >
          {shattering && <AcpShatterParts mode="out" />}
        </AcpChip>
      )}
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
  /** The conversation's persisted pick (the advanced menu overlays its extras). */
  choice?: AcpConversationChoice
  /** A `agent/probe-models` request for this agent is in flight. */
  probing?: boolean
  error?: string
}

/**
 * The model picker's explicit refresh row. It is an ACTION, not a model: the
 * pick handler intercepts it and probes the agent instead of recording a pick.
 * The id cannot collide with a real row — agent ids match
 * `[a-z0-9][a-z0-9._-]{0,63}` (no underscores) and variant ids always carry
 * `agentId@value`.
 */
export const REFRESH_CATALOG_ITEM = '__refresh-catalog__'

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
      label: acp.label('还没有配置 NTR agent', 'No NTR agent configured yet'),
      detail: acp.label('设置 → NTR', 'Settings → NTR'),
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
  // An explicit gesture, not a render side effect: opening the picker stays
  // cache-first (reading must never spawn), and the user asks for a fresh
  // directory by picking this row. The host's `agent/probe-models` may start
  // or reuse that agent's process.
  const refresh: AcpMenuItem = {
    id: REFRESH_CATALOG_ITEM,
    label: context.probing === true
      ? acp.label('正在检测…', 'Detecting…')
      : acp.label('刷新目录', 'Refresh list'),
    detail: acp.label('向 agent 重新读取模型列表', 're-read the model list from the agent'),
    disabled: context.probing === true,
  }
  if (catalog === undefined) {
    // No catalog yet (a fresh conversation, or a host still probing): the
    // current model is the only row we can honestly show — plus the refresh
    // action, which is how a first catalog gets fetched on demand.
    const items: AcpMenuItem[] = route.modelId === undefined
      ? []
      : [{ id: route.modelId, label: route.modelLabel ?? route.modelId, active: true }]
    items.push(refresh)
    return {
      id: 'model',
      title: acp.label(`${route.agentTitle ?? 'agent'} 的模型`, `Models of ${route.agentTitle ?? 'the agent'}`),
      items,
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
    // way — `route.modelLabel` already resolves the stale-variant case — so the
    // row's detail must name BOTH causes: blaming only the Settings → NTR
    // checkbox sent people looking for a box they had already ticked (audit
    // finding F25). A dropped model is NOT silently replaced: the host refuses
    // the send (`model_unavailable`), so the detail must not promise a fallback.
    rows.push({
      id: buildAcpModelId(route.agentId, inForce),
      label: `${inForce === current?.value ? current?.name ?? inForce : route.modelLabel ?? inForce} · ${acp.label('当前', 'current')}`,
      detail: acp.label(
        '不在此列表出的模型里：可能在「设置 → NTR」里取消了勾选，也可能已从 agent 的目录掉出；若 agent 已不再提供，发送会被拒绝，请改选或用「刷新目录」重新读取。',
        "Not among the models listed here: it may be unchecked in Settings → NTR, or it may have dropped out of the agent's catalog. If the agent no longer offers it, sending is refused — pick another model or use Refresh list to re-read the directory.",
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
  rows.push(refresh)
  return {
    id: 'model',
    title: acp.label(`${route.agentTitle ?? 'agent'} 的模型`, `Models of ${route.agentTitle ?? 'the agent'}`),
    note: catalog.variants.length === 0
      ? acp.label(
        'agent 自己上报的模型目录；这里只列出它当前用的模型，其余可在「设置 → NTR」里勾选可见。',
        "The agent's own model directory; only the model it is on is offered here — enable more in Settings → NTR.",
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
    // The id keeps its historical name on purpose: it is an internal sentinel
    // the pick handler compares against, and no user ever reads it. The LABEL is
    // the user-visible claim, and "provider default" was false (audit finding
    // F43): this axis is the agent's own `thought_level`, with no DSH provider
    // anywhere on it (`listModels('acp')` answers an empty catalog). Clearing
    // the pick leaves the agent's own `reasoning.defaultEffort` in force, which
    // is what `effectiveEffort` reports.
    id: 'provider-default',
    label: acp.label('跟随 agent 默认', 'Agent default'),
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
 * The advanced base's sections: one per extra config option.
 *
 * Section ids carry a `config:` prefix because `AcpMenu.onPick` hands the
 * section id back and the other pickers already own `agent` / `model` /
 * `thought` — an agent could legitimately name one of its options `model`,
 * and the pick would then be read as the primary model axis.
 */
function advancedSections(context: MenuContext): AcpMenuSection[] {
  return advancedOptions(context.catalog, context.choice).map(option => ({
    id: `config:${option.configId}`,
    title: option.name,
    items: option.choices.map(choice => ({
      id: choice.id,
      label: choice.name,
      ...(choice.description === undefined ? {} : { detail: choice.description }),
      active: choice.id === option.value,
    })),
  }))
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

  if (kind === 'advanced') {
    return {
      title: acp.label('高级选项', 'Advanced options'),
      note: acp.label(
        'agent 自己发布的额外配置项；选中只作用于这条会话，下一条消息生效。',
        'Extra config options published by the agent; a pick belongs to this conversation and applies from the next message.',
      ),
      sections: advancedSections(context),
    }
  }

  return { title: acp.label('NTR', 'NTR'), sections: [] }
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
  // Same lock rule as the cluster: a locked conversation belongs to its agent
  // even when the host's bound-agent mirror or the plugin default says
  // otherwise — the menu must list ITS extras, not a stranger's.
  const lockedTo = lockedAgentOf(ui.chatLockedAgent[sessionId], bound)
  const agentId = lockedTo ?? routeAgentId(ui.chatBoundAgent[sessionId], bound, agents, ui.defaultAgent)
  const catalog = agentId === undefined ? undefined : ui.seatCatalogs[agentId]
  // Same rule as the cluster: a menu that is not open, or a conversation that
  // points at no agent, must not read anybody's catalog. The default agent is
  // included: the guard's route rewrite uses it, and the read is memory-only.
  const served = agentId !== undefined
  useEffect(() => {
    if (menu !== null && served && agentId !== undefined) void acp.loadAgentCatalog(agentId)
  }, [acp, menu, served, agentId])

  if (menu === null || menu.sessionId !== sessionId) return null
  const route = describeRoute(
    agents,
    bound,
    lockedTo === undefined ? ui.defaultAgent : undefined,
    catalog,
    lockedTo ?? ui.chatBoundAgent[sessionId],
    choice,
  )
  // A menu-model bug must never retire the whole picker: a render throw inside
  // this slot entry makes the error boundary ABDICATE it for the rest of the
  // session (every later click silently opens nothing). Show the failure inside
  // the menu instead of dying.
  let model: ReturnType<typeof menuFor>
  try {
    const probing = menu.kind === 'model' && agentId !== undefined && ui.probingModels[agentId] === true
    const menuError = menu.error ?? (menu.kind === 'model' && agentId !== undefined ? ui.probeErrors[agentId] : undefined)
    model = menuFor(menu.kind, {
      acp,
      agents,
      route,
      ...catalog === undefined ? {} : { catalog },
      ...choice === undefined ? {} : { choice },
      ...probing ? { probing: true } : {},
      ...menuError === undefined ? {} : { error: menuError },
    })
  } catch (error) {
    model = {
      title: acp.label('NTR', 'NTR'),
      sections: [],
      error: error instanceof Error ? error.message : String(error),
    }
  }

  const pick = async (sectionId: string, itemId: string): Promise<void> => {
    // Everything here writes into the PLUGIN's own binding for this chat
    // session — never a DSH model route (see the module header).
    try {
      if (sectionId === 'model' && itemId === REFRESH_CATALOG_ITEM) {
        // The one explicit refresh gesture: an `agent/probe-models` request.
        // Opening the menu never probes; this row does. Keep the picker open so
        // the fresh list (or the probe error) lands where the user asked.
        if (agentId !== undefined) await acp.probeModels(agentId)
        return
      }
      if (sectionId === 'agent') {
        await acp.bindChatAgent(sessionId, itemId)
      } else if (sectionId === 'model') {
        await acp.setChatSessionModel(sessionId, itemId, agentId)
      } else if (sectionId === 'thought') {
        await acp.setChatSessionEffort(sessionId, itemId === 'provider-default' ? undefined : itemId, agentId)
      } else if (sectionId.startsWith('config:')) {
        // One section per extra option; the id after the prefix names the
        // agent's own `configId` (see advancedSections).
        await acp.setChatSessionConfig(sessionId, sectionId.slice('config:'.length), itemId, agentId)
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
