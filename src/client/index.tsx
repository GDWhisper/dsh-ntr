/**
 * dsh-ntr browser entry: builds the store over the Connection RPC face and
 * contributes every public seat — the settings section, the composer's ACP
 * cluster and pickers, the ACP conversation view, and the agent-native mode
 * control beside them.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { SlotComponent } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { AcpStore, type RpcCall } from './store.ts'
import { AcpSettingsSection } from './panel.tsx'
import { AcpComposerMode } from './composer-mode.tsx'
import { AcpModelSeat, AcpSessionControls, AcpSessionMenu } from './session-controls.tsx'
import { AcpConversationView } from './acp-view.tsx'
import { acpModeFromPresetEvent, setAcpSeatActive, shouldShadowModelSeat } from './acp-ui.tsx'
import type { AcpChatInjected, AcpDirectory, AcpSessionFace, AcpSessionsSnapshot, SessionListSource } from './acp-ui.tsx'

export const name = 'dsh-ntr-client'
export const inject = ['slots', 'connection']

/** Structural view of the browser Connection handle (official type is not merged into Context). */
interface BrowserConnection {
  rpc?: {
    call(channel: string, endpoint: string, payload: unknown, signal?: AbortSignal): Promise<
      | { ok: true; value: unknown }
      | { ok: false; error: { code: string; message: string } }
    >
  }
}

/**
 * Optional services, resolved structurally rather than injected. Declaring
 * `modelDirectories` (the model-selection plugin's service) or `sessions` in
 * `inject` would make this plugin fail to load in a deployment that composes
 * only a subset of the official client modules — and both are read through
 * `ctx.get` at call time, so a late-arriving service still answers.
 */
interface StructuralServices {
  modelDirectories: { directoryFor(sessionId: string): AcpDirectory }
  sessions: {
    binding(sessionId: string): { session?: unknown } | undefined
    /** The client runtime's session list store (see `AcpSessionsSnapshot`). */
    list?: SessionListSource
  }
}

const zh = typeof navigator !== 'undefined' && /^zh\b/i.test(navigator.language)

export function apply(ctx: Context): void {
  const connection = ctx.get('connection') as BrowserConnection | undefined
  const rpc = connection?.rpc
  if (rpc === undefined) {
    throw new Error('dsh-ntr: browser connection.rpc is unavailable')
  }
  const call: RpcCall = (channel, endpoint, payload) => rpc.call(channel, endpoint, payload)
  const store = new AcpStore(call, (zhText, enText) => (zh ? zhText : enText))
  store.start()

  /**
   * Resolve one optional service without injecting it. A plain `ctx.get` at
   * call time keeps the plugin loadable when the service is absent AND picks it
   * up when it arrives later — which an `inject` dependency cannot do without
   * also making its absence fatal.
   */
  const service = <T,>(name: string): T | undefined => (ctx as unknown as { get(key: string): unknown }).get(name) as T | undefined

  /**
   * This session's shared model directory (`ctx.modelDirectories`); `undefined`
   * when it cannot be resolved *yet*.
   *
   * Two legitimate throws land here: an addressed subagent session (refused on
   * purpose) and a session whose runtime scope has not been materialized yet —
   * observed live as `cannot get property "remote.session" without inject` for
   * the session on stage, milliseconds after boot. They are NOT the same verdict,
   * so the caller retries instead of treating `undefined` as final (see
   * `useDirectory`).
   */
  const directoryFor = (sessionId: string): AcpDirectory | undefined => {
    try {
      return service<StructuralServices['modelDirectories']>('modelDirectories')?.directoryFor(sessionId)
    } catch {
      return undefined
    }
  }

  /** This session's command/projection face (`ctx.sessions`); `undefined` before it materializes. */
  const faceFor = (sessionId: string): AcpSessionFace | undefined => {
    try {
      return service<StructuralServices['sessions']>('sessions')?.binding(sessionId)?.session as AcpSessionFace | undefined
    } catch {
      return undefined
    }
  }

  /** The injected face every ACP conversation entry receives. */
  const chatFace = (sessionId: unknown): AcpChatInjected & { sessionId: string } => ({
    acp: store,
    sessionId: String(sessionId),
    directoryFor,
    faceFor,
  })

  ctx.effect(() => ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'acp-agents',
    order: 120,
    label: () => (zh ? 'ACP 代理' : 'ACP Agents'),
    inject: () => ({ acp: store }),
  }, AcpSettingsSection)), 'dsh-ntr: settings section')

  // The chat side of the permission story: DSH's Access mode governs the
  // boundary (see `accessModeRouting`), and the agent's OWN modes sit beside it
  // in the composer tool row — the seat the slot contract reserves for exactly
  // this ("entries sit beside that chrome, never replace it").
  ctx.effect(() => ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
    name: 'conversation.input.left',
    id: 'acp-mode',
    order: 20,
    // The id rides the injected face rather than the standard kit: the kit's
    // top-level `sessionId` only exists in newer renderers, while the positional
    // inject argument is the contract every version honors (see
    // composer-mode.tsx).
    inject: (sessionId: unknown) => chatFace(sessionId),
    // The cast is the price of the slot map's published `.d.ts` dropping its
    // `owner` field: the props contract is declared structurally in
    // composer-mode.tsx, so the composed-props constraint cannot be met by type
    // (see the note there). Runtime passes the real shares either way.
  }, AcpComposerMode as unknown as SlotComponent<any>)), 'dsh-ntr: composer agent-mode control')

  // The ACP cluster: which agent serves this conversation, which of ITS models,
  // and how hard it should think — written through the SAME per-session model
  // directory the native seat uses, so the two surfaces can never disagree.
  ctx.effect(() => ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
    name: 'conversation.input.left',
    id: 'acp-cluster',
    order: 10,
    inject: (sessionId: unknown) => chatFace(sessionId),
    // Same cast as the mode control: the published slot map drops `owner`, so
    // the composed-props constraint cannot be met by type (the props contract
    // lives structurally in session-controls.tsx).
  }, AcpSessionControls as unknown as SlotComponent<any>)), 'dsh-ntr: composer ACP cluster')

  // Its picker rides the composer's overlay seat — the platform's home for
  // menus, so the popup floats above the card instead of being clipped by it.
  ctx.effect(() => ctx.slots.inject('conversation.input.overlay', () => ctx.slots.register({
    name: 'conversation.input.overlay',
    id: 'acp-menu',
    order: 10,
    inject: (sessionId: unknown) => chatFace(sessionId),
  }, AcpSessionMenu as unknown as SlotComponent<any>)), 'dsh-ntr: composer ACP picker')

  // The ACP-mode model seat: while the CURRENT session runs the ACP preset, the
  // composer's single model seat is taken over by our ACP-only seat, so the
  // native catalog (every provider the host registers, session-independent —
  // there is no per-session seam to filter it with) cannot offer models that
  // cannot work under that preset. The opposite direction needs no seat: ACP
  // models are never advertised in that catalog in the first place (see
  // `AcpLlmAdapter.listModels`), so a non-ACP conversation cannot see them.
  // Registration here is dynamic and keyed on the client runtime's own session
  // list, and every uncertain path (service missing, declarer missing,
  // registration refused, addressed subagent route) leaves the native seat
  // exactly where it was — the failure mode is "no takeover", never "no model
  // selector".
  const sessionsList = (): SessionListSource | undefined => {
    const list = service<StructuralServices['sessions']>('sessions')?.list
    if (list === undefined || typeof list.getSnapshot !== 'function' || typeof list.subscribe !== 'function') return undefined
    return list
  }

  let seatRegistered = false
  let seatDispose: (() => void) | undefined
  /**
   * Extra seat entries minted by the winner race below (a rival shadowing seat
   * registered after us holds a lower auto rank; each extra entry undercuts it).
   * All of them retire together with the seat (see `dropSeat`).
   */
  const extraSeatDisposals: (() => void)[] = []
  /** Component identities minted for the winner race (see `seatIsOurs`). */
  const extraWrappers = new Set<unknown>()
  /** Retire every seat contribution (primary + any race mints). */
  const dropSeat = (): void => {
    const dispose = seatDispose
    seatDispose = undefined
    seatRegistered = false
    while (extraSeatDisposals.length > 0) {
      try { extraSeatDisposals.pop()?.() } catch { /* already gone */ }
    }
    extraWrappers.clear()
    setAcpSeatActive(false)
    dispose?.()
  }
  /** Set once the seat's own render crashed: never re-take the seat this session. */
  let seatBroken = false

  /**
   * Chat session ids the seat gate has already asked the host about (the
   * `session/chat-list` fallback). The ask must be one-shot per id: a host
   * whose answer carries no `acpMode` would otherwise turn every store
   * mutation into a fresh RPC — the classic resolve-loop this file already
   * guards against elsewhere. `agent-preset/selected` clears an id so a
   * committed preset switch re-asks.
   */
  const acpModeAsked = new Set<string>()

  /** The host-side verdict for the seat gate, when we hold one (`AcpStore.acpMode`). */
  const acpModeVerdict = (sessionId: string): boolean | undefined => store.getSnapshot().acpMode[sessionId]

  /** Register or drop the seat for the current session's preset state (idempotent). */
  const syncModelSeat = (): void => {
    if (seatBroken) return
    const list = sessionsList()
    const snapshot = list?.getSnapshot() as AcpSessionsSnapshot | undefined
    const current = snapshot?.current
    // The gate prefers the runtime's own session row; on hosts whose rows
    // carry no `agentPreset` the row is silent and only our host-side report
    // can answer. Ask once per id, exactly while the row is silent AND no
    // verdict is held — the store subscriber below re-runs this gate when the
    // answer lands (`loadChatSessions` dedups racing asks in flight too).
    if (list !== undefined && current !== undefined
      && snapshot?.currentAddress === undefined
      && snapshot?.byId?.[current]?.agentPreset === undefined
      && acpModeVerdict(current) === undefined
      && !acpModeAsked.has(current)) {
      acpModeAsked.add(current)
      void store.loadChatSessions(current)
    }
    const want = list !== undefined
      && service<StructuralServices['modelDirectories']>('modelDirectories') !== undefined
      && shouldShadowModelSeat(snapshot, acpModeVerdict)
    if (want === seatRegistered) return
    if (!want) {
      dropSeat()
      return
    }
    try {
      seatDispose = ctx.slots.inject('conversation.input.model', () => ctx.slots.register({
        name: 'conversation.input.model',
        // Shadowing rank: the native ui-model-selection seat sits at the
        // default 0 and only the lowest live entry of a cell renders. NOTE:
        // the dynamic-plugin runner gives this entry its own per-package rank,
        // and a rival shadowing seat registered later can head the cell (see
        // `ensureSeatWins` below) — this number is the declaration, the race
        // below is the enforcement.
        priority: -1,
        inject: (sessionId: unknown) => chatFace(sessionId),
      }, AcpModelSeat as unknown as SlotComponent<any>))
      seatRegistered = true
      setAcpSeatActive(true)
      ensureSeatWins()
    } catch {
      // A refused registration (slot undeclared in this build, or the rank is
      // taken) leaves the native seat in place, which is the safe outcome.
      seatRegistered = false
      seatDispose = undefined
      setAcpSeatActive(false)
    }
  }

  /**
   * Settle cell ownership when another shadowing entry shares the seat.
   *
   * The renderer renders a cell's LOWEST live entry, but the dynamic-plugin
   * runner gives every package one auto rank (observed: -1), so a rival
   * shadowing seat (e.g. `dsh-thinking-effort`'s model slider) registered at
   * the same tick lands at the SAME rank and — being registered later in the
   * sorted order — our entry can end up headless: registered, but never
   * rendered. Retire-and-re-register does NOT work here: the runner's load
   * convergence drops the newer of two same-rank contributions, silently
   * removing our entry entirely (observed live).
   *
   * The race is therefore settled by STACKING: register one extra entry at an
   * EXPLICIT rank strictly below the incumbent head's (an exact duplicate of
   * our own rank throws, so the undercut must move), with a distinct component
   * identity so dedup cannot fold it into the standing entry. One undercut
   * seat wins the cell; bounded by `attempt`; the stack unwinds via `dropSeat`
   * when the gate stands down.
   */
  const seatIsOurs = (component: unknown): boolean =>
    component === AcpModelSeat || extraWrappers.has(component)
  const ensureSeatWins = (attempt = 0): void => {
    if (seatBroken || !seatRegistered || attempt >= 4) return
    const slots = ctx.slots as unknown as {
      entriesOfSlot?(key: string): readonly { component?: unknown }[]
    }
    const heads = typeof slots?.entriesOfSlot === 'function' ? slots.entriesOfSlot('conversation.input.model') : undefined
    if (heads === undefined || heads.length === 0) return
    if (seatIsOurs(heads[0].component)) return
    const headPrio = typeof (heads[0] as { options?: { priority?: number } }).options?.priority === 'number'
      ? (heads[0] as { options: { priority: number } }).options.priority
      : 0
    const undercut = Math.min(headPrio - 1, -100)
    const wrapper: SlotComponent<any> = props => AcpModelSeat(props)
    extraWrappers.add(wrapper)
    try {
      extraSeatDisposals.push(ctx.slots.inject('conversation.input.model', () => ctx.slots.register({
        name: 'conversation.input.model',
        priority: undercut,
        inject: (sessionId: unknown) => chatFace(sessionId),
      }, wrapper)))
    } catch {
      return
    }
    setTimeout(() => ensureSeatWins(attempt + 1), 0)
  }

  ctx.effect(() => {
    let stopWatch: (() => void) | undefined
    const attach = (): void => {
      const list = sessionsList()
      if (list !== undefined && stopWatch === undefined) stopWatch = list.subscribe(syncModelSeat)
      syncModelSeat()
    }
    attach()
    // The store mutates when `session/chat-list` answers, so the fallback
    // verdict arriving is what re-runs this gate — the list subscription alone
    // cannot see it (the runtime rows are silent on these hosts).
    const stopStore = store.subscribe(syncModelSeat)
    // A committed preset switch rewrites the session the gate judged. The
    // runtime's frame carries the new preset, so fold it straight into the
    // verdict map — see the handler for why re-reading the log there would be a
    // step behind. Structural `remote` (not injected): an older runtime without
    // it simply never gets this refresh path, and the one-shot ask still applies.
    const remote = (ctx as unknown as { get(key: string): unknown }).get('remote') as
      | { $on?(event: string, listener: (...args: unknown[]) => void): () => void }
      | undefined
    const stopPreset = typeof remote?.$on === 'function'
      ? remote.$on('agent-preset/selected', (...args: unknown[]) => {
        // `[sessionId, agentPreset]`: the frame carries the committed preset, so
        // fold IT rather than re-asking the host. The runtime broadcasts this
        // the moment the switch commits, while the appended session-log row is
        // not yet visible to a fresh `session/chat-list` cold read — reading
        // there folds the PREVIOUS preset, which kept the seat one switch behind
        // until a page reload (the reported "switching into or out of ACP mode
        // only moves the model seat after a refresh" symptom). The host read
        // stays the cold path for a session this tab has no frame for.
        const sessionId = args[0]
        if (typeof sessionId !== 'string') return
        // A frame supersedes both a held verdict and a pending one-shot ask.
        acpModeAsked.delete(sessionId)
        if (args.length >= 2) {
          // The late answer to an ask that predates the frame must not win: it
          // describes the log from before the switch.
          store.abandonChatSessionRead(sessionId)
          store.noteAcpMode(sessionId, acpModeFromPresetEvent(args[1]))
        } else {
          // A frame carrying no preset can only be honoured by a fresh host
          // read — the behaviour the fold replaced.
          store.invalidateAcpMode(sessionId)
        }
        syncModelSeat()
      })
      : undefined
    // Late services: the runtime's session list normally exists before this
    // module applies, but a build that loads us first must not end up without
    // the seat for the rest of the page's life.
    const stopService = ctx.on('internal/service', attach)
    // Supervision: a crash inside the seat's own render retires the entry
    // (`abdicate`) and the native seat takes the cell back by itself — but the
    // cluster would stay stood-down and the ACP controls would vanish with it.
    // Only a cell's WINNER renders, and while we hold rank -1 that is us, so an
    // abdication here is ours: hand both surfaces back and stop retrying.
    const stopErrors = ctx.slots.onEntryError((key, _entry, _error, info) => {
      if (seatBroken || !seatRegistered || !info.abdicated || key !== 'conversation.input.model') return
      seatBroken = true
      dropSeat()
    })
    return () => {
      stopErrors()
      stopService()
      stopStore()
      stopPreset?.()
      stopWatch?.()
      dropSeat()
    }
  }, 'dsh-ntr: ACP model seat')

  // The ACP view tab: the agent's real stream (tool cards, plans, unified
  // diffs) in a seat of its own, because the chat plane's chunk vocabulary is
  // text + reasoning and nothing else. Session-scope list entry; the view ring
  // renders it one tab at a time.
  ctx.effect(() => ctx.slots.inject('conversation.view', () => ctx.slots.register({
    name: 'conversation.view',
    id: 'acp',
    order: 20,
    label: () => 'ACP',
    inject: (sessionId: unknown) => chatFace(sessionId),
  }, AcpConversationView as unknown as SlotComponent<any>)), 'dsh-ntr: ACP view tab')
}
