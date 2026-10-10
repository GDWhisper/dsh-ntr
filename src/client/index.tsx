/**
 * dsh-ntr browser entry: builds the store over the Connection RPC face and
 * contributes every public seat — the settings section, the ACP conversation
 * view, the agent-native mode control, and the ACP base in the composer's
 * model seat (installed by the ACP-mode gate, which is what keeps it out of
 * every non-ACP conversation).
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
import { AcpSessionControls, AcpSessionMenu } from './session-controls.tsx'
import { AcpConversationView } from './acp-view.tsx'
import { createModelSeatClaim, MODEL_SEAT_KEY } from './model-seat.tsx'
import type { ModelSeatClaim, SeatSlots } from './model-seat.tsx'
import {
  acpModeFromPresetEvent, rowAgentPreset, stagedIsAcpMode, stagedSessionOf,
} from './acp-ui.tsx'
import type { AcpChatInjected, AcpSessionFace, AcpSessionsSnapshot, SessionListSource } from './acp-ui.tsx'

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
 * `sessions` in `inject` would make this plugin fail to load in a deployment
 * that composes only a subset of the official client modules — and it is read
 * through `ctx.get` at call time, so a late-arriving service still answers.
 */
interface StructuralServices {
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
    faceFor,
  })

  ctx.effect(() => ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'acp-agents',
    order: 120,
    label: () => (zh ? 'ACP 代理' : 'ACP Agents'),
    inject: () => ({ acp: store }),
  }, AcpSettingsSection)), 'dsh-ntr: settings section')

  // The agent's OWN modes sit in the composer tool row — the seat the slot
  // contract reserves for exactly this ("entries sit beside that chrome, never
  // replace it"). They are a different layer from everything the host controls:
  // this is HOW the agent works, not what it may touch.
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

  // Its picker rides the composer's overlay seat — the platform's home for
  // menus, so the popup floats above the card instead of being clipped by it.
  ctx.effect(() => ctx.slots.inject('conversation.input.overlay', () => ctx.slots.register({
    name: 'conversation.input.overlay',
    id: 'acp-menu',
    order: 10,
    inject: (sessionId: unknown) => chatFace(sessionId),
  }, AcpSessionMenu as unknown as SlotComponent<any>)), 'dsh-ntr: composer ACP picker')

  /**
   * The client runtime's session list store, read structurally. Used to find
   * the session the composer is staged on and whether it runs the ACP preset —
   * which is what every ACP conversation entry keys off.
   */
  const sessionsList = (): SessionListSource | undefined => {
    const list = service<StructuralServices['sessions']>('sessions')?.list
    if (list === undefined || typeof list.getSnapshot !== 'function' || typeof list.subscribe !== 'function') return undefined
    return list
  }

  /**
   * Chat session ids the ACP-mode tracker has already asked the host about (the
   * `session/chat-list` fallback). The ask is once per id so a host whose
   * answer carries no `acpMode` cannot turn every store mutation into a fresh
   * RPC — the classic resolve-loop this file already guards against elsewhere.
   * `agent-preset/selected` clears an id so a committed preset switch re-asks.
   *
   * An id is REMOVED again when its ask comes back without a verdict: a
   * one-shot ask that cannot answer must not wedge the gate for the rest of
   * the page's life. The next store mutation or list notification retries it,
   * which is what makes the fallback recoverable rather than a single coin
   * flip (a host half that transiently fails, or answers `{}` because the
   * session's projection row is not resident yet, used to leave the native
   * model seat visible forever with nothing in the console to say why).
   */
  const acpModeAsked = new Set<string>()

  /** The host-side verdict for the seat gate, when we hold one (`AcpStore.acpMode`). */
  const acpModeVerdict = (sessionId: string): boolean | undefined => store.getSnapshot().acpMode[sessionId]

  ctx.effect(() => {
    let stopWatch: (() => void) | undefined
    /**
     * The claim on the host's model seat, held while the staged conversation
     * runs the ACP preset. That cell is where the host's own base sits (the
     * trailing group, right before the submit button), so the claim installs
     * the ACP base there rather than blanking it — one cell, one occupant, and
     * the position the user expects. Ownership of the cell is NOT settled by
     * the rank a registration declares — the client runner rewrites non-chain
     * priorities with its own page-global counter, so the last registrant
     * wins — which is why the claim verifies the cell's winner and retakes it
     * when a rival (a shipped occupant, or a third-party seat plugin later in
     * the load order) is holding it. See model-seat.tsx.
     */
    let claim: ModelSeatClaim | undefined
    /**
     * Last diagnostic line from {@link syncAcpMode}. Every way this gate can
     * end with the native seat still on screen used to be silent — an inner
     * `catch { return [] }` and an outer `catch { … }` between them swallowed
     * both the registration failure and the inject failure, leaving "the ACP
     * conversation still shows the native model picker" with nothing to read
     * it from. This string is the gate's own account of what it last decided,
     * verified or not, and why; the ACP view renders it.
     */
    let seatDiag = 'idle'
    const syncAcpMode = (): void => {
      const list = sessionsList()
      const snapshot = list?.getSnapshot() as AcpSessionsSnapshot | undefined
      if (list === undefined) {
        seatDiag = 'no session list service'
        return
      }
      const staged = stagedSessionOf(snapshot)
      if (staged === undefined) {
        seatDiag = 'no staged session (nothing retains the main view)'
        return
      }
      if (staged.subagent) {
        seatDiag = `staged ${staged.sessionId} is an addressed subagent route`
        return
      }
      // The gate prefers the runtime's own session row; on hosts whose rows
      // carry no `agentPreset` the row is silent and only our host-side report
      // can answer. Ask while the row is silent AND no verdict is held — the
      // store subscriber below re-runs this gate when the answer lands
      // (`loadChatSessions` dedups racing asks in flight too). An ask that came
      // back without an answer is reported unsettled and retracted here, so the
      // next tick asks again rather than parking the session forever.
      const verdictHeld = acpModeVerdict(staged.sessionId) !== undefined || store.hasAcpModeVerdict(staged.sessionId)
      if (rowAgentPreset(staged.row) === undefined
        && !verdictHeld
        && !acpModeAsked.has(staged.sessionId)) {
        acpModeAsked.add(staged.sessionId)
        void store.loadChatSessions(staged.sessionId)
      } else if (!verdictHeld && acpModeAsked.has(staged.sessionId)) {
        // The previous ask for this session came back without a verdict (or is
        // still in flight). Withdraw the one-shot mark so the round-trip can be
        // repeated: without this, one silent failure pins the native seat in
        // place for the rest of the page's life with nothing to show why.
        acpModeAsked.delete(staged.sessionId)
      }
      // An ACP conversation's models belong to the external agent, so the
      // host's native model seat must not be on screen here — it would list
      // providers this conversation cannot use, and clicking one writes the
      // process-wide default model. The seat is also exactly where the host's
      // own base sat (the trailing group, before the submit button), which is
      // where the ACP base belongs — so instead of blanking the cell we install
      // the ACP base in it. See model-seat.tsx for why occupying it is not
      // enough on its own.
      if (!stagedIsAcpMode(snapshot, acpModeVerdict)) {
        seatDiag = `staged ${staged.sessionId} is not in ACP mode`
        if (claim !== undefined) { claim.release(); claim = undefined }
        return
      }
      // Stays re-runnable on purpose: the seat is not declared before the
      // composer bar mounts, a registration can be refused, and the cell can be
      // taken from us later. The claim reports each of those through the
      // diagnostic line instead of pretending the base is installed — the
      // next evaluation (store mutation, list notification, preset frame, or a
      // change to the cell itself) simply tries again.
      seatDiag = `staged ${staged.sessionId} is ACP mode`
      claim ??= createModelSeatClaim({
        slots: ctx.slots as unknown as SeatSlots,
        occupant: () => AcpSessionControls,
        // The occupant's own face — REQUIRED by the claim, and the reason is a
        // silent failure this gate could never see: `conversation.input.model`
        // is session-scoped, so without it the entry renders with the standard
        // kit alone (`acp === undefined`), the slot's error boundary abdicates
        // our entry from the cell, and the native seat comes back while the
        // diagnostic still says "held by the ACP base". See model-seat.tsx.
        inject: (sessionId: unknown) => chatFace(sessionId),
        onDiag: (line) => { seatDiag = `staged ${staged.sessionId} · ${line}` },
      })
      claim.sync()
    }
    const attach = (): void => {
      const list = sessionsList()
      if (list !== undefined && stopWatch === undefined) stopWatch = list.subscribe(runGate)
      runGate()
    }
    /**
     * Wrap {@link syncAcpMode} so every evaluation also publishes its verdict
     * to the store. The gate runs on every store mutation, list notification,
     * preset frame and change to the model-seat cell itself, so the published
     * line is always the latest verdict — which is the whole point: the visible
     * symptom ("the native seat is still there") looks identical whether the
     * seat was never declared, refused us, or was taken by a rival, and only
     * this line tells them apart.
     */
    const runGate = (): void => {
      syncAcpMode()
      store.noteSeatDiag(seatDiag)
    }
    attach()
    // The store mutates when `session/chat-list` answers, so the fallback
    // verdict arriving is what re-runs this gate — the list subscription alone
    // cannot see it (the runtime rows are silent on these hosts).
    const stopStore = store.subscribe(runGate)
    // The cell can be taken by someone else at any moment (the runner ranks the
    // most recent registration lowest, so a seat plugin loading or re-mounting
    // after us wins). `slots/changed` carries the key, and the claim's `sync`
    // retakes the cell only when it is actually holding something that is not
    // ours — so this is evidence-driven, not a poll.
    const stopCell = ctx.on('slots/changed', (...args: unknown[]) => {
      if (args[0] !== MODEL_SEAT_KEY) return
      runGate()
    })
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
        // there folds the PREVIOUS preset, which kept the surface one switch
        // behind until a page reload (the reported "switching into or out of ACP
        // mode only moves the model seat after a refresh" symptom). The host read
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
        runGate()
      })
      : undefined
    // Late services: the runtime's session list normally exists before this
    // module applies, but a build that loads us first must not end up without
    // the gate for the rest of the page's life.
    const stopService = ctx.on('internal/service', attach)
    return () => {
      stopService()
      stopStore()
      stopCell()
      stopPreset?.()
      stopWatch?.()
      if (claim !== undefined) { claim.release(); claim = undefined }
      store.noteSeatDiag('gate disposed')
    }
  }, 'dsh-ntr: ACP mode tracking')

  // The ACP view tab: the agent's real stream (tool cards, plans, unified
  // diffs). Session-scope list entry; the view ring renders it one tab at a
  // time. Meanwhile the agent's prose and thinking ride the NATIVE chat plane
  // through the LLM adapter — see docs/acp-convergence.md §2.1.
  ctx.effect(() => ctx.slots.inject('conversation.view', () => ctx.slots.register({
    name: 'conversation.view',
    id: 'acp',
    order: 20,
    label: () => 'ACP',
    inject: (sessionId: unknown) => chatFace(sessionId),
  }, AcpConversationView as unknown as SlotComponent<any>)), 'dsh-ntr: ACP view tab')
}
