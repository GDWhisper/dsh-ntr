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
import { AcpContextMeter } from './context-meter.tsx'
import { AcpComposerAgentTag, AcpSessionControls, AcpSessionMenu } from './session-controls.tsx'
import { AcpConversationView } from './acp-view.tsx'
import { AcpSettingsDialog } from './settings-dialog.tsx'
import { PermissionDock } from './permission-dock.tsx'
import {
  createModelSeatClaim,
  createPermissionSeatClaim,
  MODEL_SEAT_KEY,
  PERMISSION_SEAT_KEY,
} from './model-seat.tsx'
import type { ModelSeatClaim, SeatSlots } from './model-seat.tsx'
import {
  acpModeFromPresetEvent, rowAgentPreset, stagedIsAcpMode, stagedSessionOf,
} from './acp-ui.tsx'
import type { AcpChatInjected, AcpSessionFace, AcpSessionsSnapshot, SessionListSource } from './acp-ui.tsx'
import { createSlashIsolation, slashAcpVerdict } from './slash-isolation.ts'
import type { SlashSource } from './slash-isolation.ts'

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

const browserPrefersZh = typeof navigator !== 'undefined' && /^zh\b/i.test(navigator.language)

/**
 * Structural view of the shell's locale service (`@deepseek-ai/dsh-client-locale`).
 *
 * Read through {@link ctx.get} rather than injected: a composition without the
 * service must still load, and the label pairs carry their own browser-derived
 * fallback for exactly that case.
 */
interface LocaleFace {
  resolveText?(text: Record<string, string>): string
  subscribe?(listener: () => void): () => void
}

/**
 * How long a host verdict may stand as the gate's ONLY fact source before the
 * gate asks the host again.
 *
 * The gate prefers the staged session row's own preset. On a host whose client
 * rows carry no `agentPreset` the row is silent, and then the
 * `session/chat-list` verdict is all there is — and it used to be asked ONCE
 * per session, for the rest of the page's life. A preset switch that no
 * `agent-preset/selected` frame announced (the `remote` face absent when this
 * effect ran, or a runtime that never forwards the frame) therefore left the
 * gate judging a conversation that had already left ACP mode: both cells stayed
 * claimed, and the permission cell's product is an ABSENCE — an ordinary
 * conversation silently lost its Access mode control with nothing on screen to
 * say why. The host reads the session log every switch is appended to, so
 * re-asking is what lets the truth arrive late; the bound keeps that at one
 * round-trip per window per staged session instead of one per store mutation
 * (the resolve-loop the one-shot ask was bought to prevent).
 */
const ACP_MODE_VERDICT_TTL_MS = 2000

/**
 * Slash-source discovery retry (see the slash-isolation effect): a source
 * registers with no event, so a module that loads after this one is found by
 * polling the roster a bounded number of times. 20 × 500ms covers a slow page
 * load; the timer stops as soon as a source is wrapped.
 */
const SLASH_SYNC_ATTEMPTS = 20
const SLASH_SYNC_DELAY_MS = 500

export function apply(ctx: Context): void {
  const connection = ctx.get('connection') as BrowserConnection | undefined
  const rpc = connection?.rpc
  if (rpc === undefined) {
    throw new Error('dsh-ntr: browser connection.rpc is unavailable')
  }
  const call: RpcCall = (channel, endpoint, payload) => rpc.call(channel, endpoint, payload)

  /**
   * Resolve one optional service without injecting it. A plain `ctx.get` at
   * call time keeps the plugin loadable when the service is absent AND picks it
   * up when it arrives later — which an `inject` dependency cannot do without
   * also making its absence fatal.
   */
  const service = <T,>(name: string): T | undefined => (ctx as unknown as { get(key: string): unknown }).get(name) as T | undefined

  /**
   * Resolve a Chinese/English pair against the shell's active locale. Read per
   * call, so a language switch reaches every render-time `label()` call without
   * rebuilding the store. A host without the locale service keeps the
   * browser-derived choice the pairs shipped with.
   */
  const label = (zhText: string, enText: string): string => {
    const resolved = service<LocaleFace>('locale')?.resolveText?.({ zh: zhText, en: enText })
    return typeof resolved === 'string' && resolved !== '' ? resolved : browserPrefersZh ? zhText : enText
  }

  const store = new AcpStore(call, label)
  store.start()

  // A locale switch changes no data, only which side of each pair renders;
  // republishing the snapshot is what re-runs them. Attached through
  // `internal/service` so a late-arriving locale service is still hooked.
  ctx.effect(() => {
    let stop: (() => void) | undefined
    const attach = (): void => {
      if (stop !== undefined) return
      stop = service<LocaleFace>('locale')?.subscribe?.(() => { store.refreshLocale() })
    }
    attach()
    const stopService = ctx.on('internal/service', attach)
    return () => {
      stopService()
      stop?.()
    }
  }, 'dsh-ntr: locale switch re-render')

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
    label: () => 'NTR',
    inject: () => ({ acp: store }),
  }, AcpSettingsSection)), 'dsh-ntr: settings section')

  // The same NTR settings, opened from the composer when the agent roster is
  // empty (the agent base's picker action). It rides the frame's overlay layer
  // because the composer seat and the dialog live in unrelated slot trees; the
  // host settings shell has no programmatic open seam, so the dialog mounts the
  // same section the shell mounts (see settings-dialog.tsx). Renders nothing
  // while closed.
  ctx.effect(() => ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'acp-settings-dialog',
    order: 30,
    inject: () => ({ acp: store }),
  }, AcpSettingsDialog as unknown as SlotComponent<any>)), 'dsh-ntr: NTR settings dialog')

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

  // The agent's OWN context occupancy in the composer's bottom info row
  // (`conversation.composer.dock` — the dock below the input card where the
  // host renders its native ContextMeter). The native meter reads host
  // projections an ACP request never feeds, so this ring reports the agent's
  // `usage_update` used/size instead (see context-meter.tsx). Registered for
  // every conversation; the component gates itself on an ACP conversation row
  // carrying usage.
  ctx.effect(() => ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
    name: 'conversation.composer.dock',
    id: 'acp-context-meter',
    order: 10,
    inject: (sessionId: unknown) => chatFace(sessionId),
  }, AcpContextMeter as unknown as SlotComponent<any>)), 'dsh-ntr: composer context meter')

  // Its picker rides the composer's overlay seat — the platform's home for
  // menus, so the popup floats above the card instead of being clipped by it.
  ctx.effect(() => ctx.slots.inject('conversation.input.overlay', () => ctx.slots.register({
    name: 'conversation.input.overlay',
    id: 'acp-menu',
    order: 10,
    inject: (sessionId: unknown) => chatFace(sessionId),
  }, AcpSessionMenu as unknown as SlotComponent<any>)), 'dsh-ntr: composer ACP picker')

  // The agent tag riding the composer card's top edge. The agent base steps
  // aside after the conversation's first ACP turn, which also LOCKS the
  // conversation to its agent (`agentBaseHidden` in session-controls.tsx); this
  // tag is the read-only nameplate that keeps naming it. It shares the overlay
  // seat with the picker itself; both are positioned floating entries inside
  // the card, while the tag is pinned to the card's top edge
  // (`.ntr-acp-tag`). Registered for every conversation, gated inside the
  // component.
  ctx.effect(() => ctx.slots.inject('conversation.input.overlay', () => ctx.slots.register({
    name: 'conversation.input.overlay',
    id: 'acp-agent-tag',
    order: 5,
    inject: (sessionId: unknown) => chatFace(sessionId),
  }, AcpComposerAgentTag as unknown as SlotComponent<any>)), 'dsh-ntr: composer agent tag')

  // Pending permission asks for the staged conversation, above the composer
  // card (`conversation.input.dock` — a session-scoped list slot; the host's
  // own queue/todo docks register the same way). The slot spans the whole
  // conversation column, so the dock component applies the composer's own
  // width formula to line up with the input box. Every ask is dispatched as
  // broadcast as `permission/request`; the dock renders only the ones carrying
  // this conversation's id, so it needs no ACP-mode gate. Asks without a chat
  // identity stay on the settings-panel ledger.
  ctx.effect(() => ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
    name: 'conversation.input.dock',
    id: 'acp-permissions',
    order: 10,
    // The positional inject argument is the session binding key — the chat
    // session id this dock belongs to (same contract as every other entry).
    inject: (sessionId: unknown) => chatFace(sessionId),
  }, PermissionDock as unknown as SlotComponent<any>)), 'dsh-ntr: conversation permission dock')

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
   * `session/chat-list` fallback), mapped to WHEN the last ask went out. The
   * ask is once per id so a host whose answer carries no `acpMode` cannot turn
   * every store mutation into a fresh RPC — the classic resolve-loop this file
   * already guards against elsewhere. `agent-preset/selected` clears an id so a
   * committed preset switch re-asks.
   *
   * An id is REMOVED again when its ask comes back without a verdict: a
   * one-shot ask that cannot answer must not wedge the gate for the rest of
   * the page's life. The next store mutation or list notification retries it,
   * which is what makes the fallback recoverable rather than a single coin
   * flip (a host half that transiently fails, or answers `{}` because the
   * session's projection row is not resident yet, used to leave the native
   * model seat visible forever with nothing in the console to say why).
   *
   * A verdict that IS held is re-asked once per {@link ACP_MODE_VERDICT_TTL_MS}
   * while the row stays silent — see the constant for why a held verdict may
   * not be permanent.
   */
  const acpModeAsked = new Map<string, number>()

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
     * Claim on the host's native permission seat (`conversation.input.permission`),
     * held while the staged conversation runs in ACP mode to blank out the
     * Access mode dropdown — the DSH read-only / workspace-write /
     * danger-full-access knob, which describes policies this runtime applies to
     * ITS OWN tools and therefore says nothing about a separate agent process.
     *
     * Unlike the model seat, the right answer here is an empty cell rather than
     * an ACP replacement: the ACP agent's own permission surface is what it
     * sends over `session/request_permission`, and there is nothing of ours to
     * put in this slot. So the occupant is a component that renders `null`.
     *
     * That makes the lifecycle discipline load-bearing in a way the model seat
     * does not rely on: the evidence for taking the cell (the staged preset) is
     * derived from a store that can go silent, while the entry itself is
     * indistinguishable from a permanent one to anyone looking at the screen.
     * A claim that outlives its reason has silently removed a control from
     * ordinary conversations, so {@link standDown} runs on every path that is
     * not a confirmed ACP verdict — including the ones where no verdict is
     * available yet.
     */
    let permissionClaim: ModelSeatClaim | undefined
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
    let permissionSeatDiag = 'idle'
    /**
     * Hand BOTH cells back to their shipped occupants.
     *
     * Every path that is not "this staged conversation is CONFIRMED to run the
     * ACP preset" ends here — including the paths that carry no verdict at all
     * (no session list, nothing staged, an addressed subagent route). Standing
     * down is the only safe default, because keeping a blanking entry installed
     * while the evidence has gone silent hides a control the user needs: the
     * cells sit in every conversation's composer bar, so an entry that outlives
     * its reason is indistinguishable from a permanent one. The next evaluation
     * re-installs if ACP mode is confirmed again, so this is not a decision
     * about the conversation — only about whose chrome is on screen while we
     * cannot answer.
     */
    const standDown = (reason: string): void => {
      seatDiag = reason
      // The permission line names the release explicitly: "staged X is not in
      // ACP mode" and "staged X is ACP mode" are the two states a reader has
      // to tell apart, and the seat this claim holds renders nothing — so
      // without the word, "released" and "re-installed on the next evidence"
      // read identically in the one place either is observable.
      permissionSeatDiag = `${reason} (released)`
      disarmVerdictReask()
      if (claim !== undefined) { claim.release(); claim = undefined }
      if (permissionClaim !== undefined) { permissionClaim.release(); permissionClaim = undefined }
    }
    /**
     * Re-ask timer for the staged session, armed while the row is silent and a
     * verdict is held (see {@link ACP_MODE_VERDICT_TTL_MS}). A re-ask needs a
     * trigger of its own: on the host shape this covers nothing else moves —
     * the row never speaks, the frame path may be dead, and a page with no
     * store traffic would otherwise never re-run the gate, which is exactly
     * how a stale verdict became permanent. One timer at a time, because the
     * gate judges exactly one staged session; cleared whenever the row speaks,
     * whenever the gate stands down, and on teardown.
     */
    let verdictReask: ReturnType<typeof setTimeout> | undefined
    const armVerdictReask = (): void => {
      if (verdictReask !== undefined) return
      verdictReask = setTimeout(() => {
        verdictReask = undefined
        runGate()
      }, ACP_MODE_VERDICT_TTL_MS)
    }
    const disarmVerdictReask = (): void => {
      if (verdictReask === undefined) return
      clearTimeout(verdictReask)
      verdictReask = undefined
    }
    const syncAcpMode = (): void => {
      const list = sessionsList()
      const snapshot = list?.getSnapshot() as AcpSessionsSnapshot | undefined
      if (list === undefined) {
        standDown('no session list service')
        return
      }
      const staged = stagedSessionOf(snapshot)
      if (staged === undefined) {
        standDown('no staged session (nothing retains the main view)')
        return
      }
      if (staged.subagent) {
        standDown(`staged ${staged.sessionId} is an addressed subagent route`)
        return
      }
      // The gate prefers the runtime's own session row; on hosts whose rows
      // carry no `agentPreset` the row is silent and only our host-side report
      // can answer. Ask while the row is silent AND we hold no verdict — the
      // store subscriber below re-runs this gate when the answer lands
      // (`loadChatSessions` dedups racing asks in flight too). An ask that came
      // back without an answer is reported unsettled and retracted here, so the
      // next tick asks again rather than parking the session forever.
      //
      // A verdict that IS held is re-asked once it ages past
      // {@link ACP_MODE_VERDICT_TTL_MS}: while the row is silent it is this
      // gate's only fact source, and the host's log read is the one place a
      // switch the runtime never framed can still be learned from.
      const verdictHeld = acpModeVerdict(staged.sessionId) !== undefined || store.hasAcpModeVerdict(staged.sessionId)
      const askedAt = acpModeAsked.get(staged.sessionId)
      const askIsDue = askedAt === undefined
        || (!verdictHeld || Date.now() - askedAt >= ACP_MODE_VERDICT_TTL_MS)
      if (rowAgentPreset(staged.row) === undefined && askIsDue) {
        acpModeAsked.set(staged.sessionId, Date.now())
        // `settleVerdict` on the TTL re-ask only: the answer of a read the gate
        // itself commissioned may settle a verdict a frame had settled (see
        // `acpModeLive`), which is what lets a switch the runtime never framed
        // still reach this gate. A composer reader's answer keeps deferring to
        // the frame, because the host's log read can lag a switch by one.
        void store.loadChatSessions(staged.sessionId, verdictHeld ? { settleVerdict: true } : undefined)
      } else if (!verdictHeld && askedAt !== undefined) {
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
      //
      // The Access mode selector beside it (`conversation.input.permission`)
      // has no ACP counterpart to be replaced with: it selects the file-write
      // policy THIS runtime applies to its own tools, which a separate agent
      // process never consults, so in ACP mode the honest thing to render is
      // nothing. Both cells follow the same evidence — the staged
      // conversation's preset — through one {@link standDown}, so neither can
      // stay claimed after the evidence for it stops answering.
      if (!stagedIsAcpMode(snapshot, acpModeVerdict)) {
        standDown(`staged ${staged.sessionId} is not in ACP mode`)
        return
      }
      // The row speaks, so the host verdict is not this gate's only fact
      // source and no re-ask timer is needed.
      if (rowAgentPreset(staged.row) !== undefined) disarmVerdictReask()
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

      permissionSeatDiag = `staged ${staged.sessionId} is ACP mode`
      permissionClaim ??= createPermissionSeatClaim({
        slots: ctx.slots as unknown as SeatSlots,
        onDiag: (line) => { permissionSeatDiag = `staged ${staged.sessionId} · ${line}` },
      })
      permissionClaim.sync()
      // Confirmed ACP on a silent row: the verdict is all the evidence there
      // is, so it gets a re-ask deadline (see {@link ACP_MODE_VERDICT_TTL_MS}).
      if (rowAgentPreset(staged.row) === undefined) armVerdictReask()
    }
    // A committed preset switch rewrites the session the gate judged. The
    // runtime's frame carries the new preset, so fold it straight into the
    // verdict map — see the handler for why re-reading the log there would be a
    // step behind. Structural `remote` (not injected): an older runtime without
    // it simply never gets this refresh path, and the one-shot ask still applies.
    //
    // Resolved through {@link attach} rather than once when this effect ran: a
    // page that loads this bundle before the gateway publishes `remote` used to
    // lose the frame path for the rest of its life, and on a host whose rows
    // are silent the frame is the only live fact source there is. The
    // subscription is made once (the guard), and `internal/service` re-runs the
    // attach whenever a service appears — the same late-arrival path the
    // session list already uses.
    let stopPreset: (() => void) | undefined
    const attachPresetFrames = (): void => {
      if (stopPreset !== undefined) return
      const remote = (ctx as unknown as { get(key: string): unknown }).get('remote') as
        | { $on?(event: string, listener: (...args: unknown[]) => void): () => void }
        | undefined
      if (typeof remote?.$on !== 'function') return
      stopPreset = remote.$on('agent-preset/selected', (...args: unknown[]) => {
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
    }
    const attach = (): void => {
      const list = sessionsList()
      if (list !== undefined && stopWatch === undefined) stopWatch = list.subscribe(runGate)
      attachPresetFrames()
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
     *
     * NOT RE-ENTRANT, and deliberately so. The host's slot registry emits
     * `slots/changed` SYNCHRONOUSLY from inside `slots.register` and from
     * inside an entry's disposer (`SlotCore.markDirty` → the registry's
     * `onMutate` bridge → `ctx.emit`), and the store re-runs this gate from
     * inside its own `mutate`. So an evaluation that installs or releases an
     * entry re-enters itself from within its own call stack — and a nested
     * evaluation reads the SAME evidence (neither the session snapshot nor the
     * store has changed), so it can only repeat the decision. Worse, a nested
     * install sees `installed.length === 0` because the outer install has not
     * pushed its disposer yet, registers a second entry, and that entry's own
     * `slots/changed` re-enters again: an unbounded registration pile whose
     * store-subscriber feedback never settles. A nested run is therefore
     * dropped — the evaluation already in flight judged this evidence and is
     * about to publish its verdict, and the next trigger tries again.
     */
    let gateRunning = false
    const runGate = (): void => {
      if (gateRunning) return
      gateRunning = true
      try {
        syncAcpMode()
        store.noteSeatDiag(seatDiag)
        store.notePermissionSeatDiag(permissionSeatDiag)
      } finally {
        gateRunning = false
      }
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
      if (args[0] !== MODEL_SEAT_KEY && args[0] !== PERMISSION_SEAT_KEY) return
      runGate()
    })
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
      disarmVerdictReask()
      if (claim !== undefined) { claim.release(); claim = undefined }
      if (permissionClaim !== undefined) { permissionClaim.release(); permissionClaim = undefined }
      store.noteSeatDiag('gate disposed')
      store.notePermissionSeatDiag('gate disposed')
    }
  }, 'dsh-ntr: ACP mode tracking')

  /**
   * Slash isolation (`src/client/slash-isolation.ts`): in an ACP conversation
   * the composer's `/` menu, Enter and Space adjudication belong to the AGENT.
   * The host's slash sources describe commands THIS runtime would execute, and
   * a name they recognize never reaches the prompt sink — so `/model` in an NTR
   * conversation would run DSH's model picker instead of reaching the agent.
   *
   * The host pipeline offers no per-session seam (adjudication polls sources in
   * registration order; duplicates throw; no availability hook), so the live
   * sources are wrapped in memory. The verdict is the same two-source read the
   * seat gate uses: the staged row's own preset, else the host's answer.
   *
   * Re-runs on `internal/service` (a late `inputTriggers`) and on store traffic
   * (a source registering after us), and is idempotent. Everything is restored
   * on teardown so a plugin reload never leaves the previous instance's
   * callbacks behind.
   */
  ctx.effect(() => {
    let warned = ''
    const isolation = createSlashIsolation({
      sources: () => {
        const triggers = service<{ live?: { sources?: unknown } }>('inputTriggers')
        // A host WITHOUT the trigger service has no slash menu, so there is
        // nothing to isolate and nothing to report. A service whose shape is
        // not what this module knows is different: that returns undefined and
        // is reported (the seam degraded open, which needs a line).
        if (triggers === undefined) return []
        const sources = triggers.live?.sources
        return Array.isArray(sources) ? sources as SlashSource[] : undefined
      },
      verdict: (sessionId) => slashAcpVerdict(
        sessionsList()?.getSnapshot(),
        sessionId,
        id => store.getSnapshot().acpMode[id],
      ),
      ensureVerdict: async (sessionId) => {
        const held = (): boolean | undefined => slashAcpVerdict(
          sessionsList()?.getSnapshot(),
          sessionId,
          id => store.getSnapshot().acpMode[id],
        )
        const known = held()
        if (known !== undefined) return known
        await store.loadChatSessions(sessionId)
        return held()
      },
      // The LIVE session's declaration wins; a conversation that has not sent
      // its first message yet falls back to the agent-level cache learned from
      // earlier sessions (`agent/catalog` → `commands`). That fallback is what
      // makes `/` list the agent's commands immediately, like the native menu,
      // instead of waiting for a session that only the first message creates.
      commands: async (sessionId) => {
        const live = store.chatSessionCommands(sessionId)
        if (live !== undefined) return live
        const agentId = store.chatAgentFor(sessionId)
        if (agentId === undefined) return undefined
        const cached = store.agentCommands(agentId)
        if (cached !== undefined) return cached
        // `agent/catalog` is pure memory on the host — no probe is spawned by
        // this read (constraint 8); an agent with no cached list simply stays
        // absent, and the menu shows nothing until its first session declares.
        await store.loadAgentCatalog(agentId)
        return store.agentCommands(agentId)
      },
      refresh: (sessionId) => { void store.loadChatSessions(sessionId) },
      onDiag: (line) => {
        store.noteSlashDiag(line)
        // Console once per distinct line: the NTR view shows the same string,
        // but a shape change is exactly the kind of thing a bug report needs a
        // timestamped console record of.
        if (warned === line) return
        warned = line
        if (line !== 'idle') console.warn(`[dsh-ntr] slash isolation: ${line}`)
      },
    })
    /**
     * Sources register with no event of their own: `inputTriggers` announces
     * the SERVICE, not the roster. A client module that loads after this one
     * therefore adds the `command` source in silence. The retry below is the
     * bounded answer to that gap — stop as soon as something is wrapped, and
     * give up after {@link SLASH_SYNC_ATTEMPTS} so a host with no slash
     * pipeline does not keep a timer alive.
     */
    let retryTimer: ReturnType<typeof setTimeout> | undefined
    let attempts = 0
    const sync = (): void => {
      if (isolation.sync()) {
        if (retryTimer !== undefined) {
          clearTimeout(retryTimer)
          retryTimer = undefined
        }
        return
      }
      // The service's arrival is announced (`internal/service`), so there is
      // nothing to poll for until it exists; the gap this retry closes is a
      // roster that is still empty while the service is already there.
      if (service('inputTriggers') === undefined) return
      if (retryTimer !== undefined || attempts >= SLASH_SYNC_ATTEMPTS) return
      attempts += 1
      retryTimer = setTimeout(() => {
        retryTimer = undefined
        sync()
      }, SLASH_SYNC_DELAY_MS)
    }
    sync()
    const stopService = ctx.on('internal/service', sync)
    // Store traffic is guaranteed after mount; sync is cheap and idempotent
    // once everything is wrapped.
    const stopStore = store.subscribe(sync)
    return () => {
      if (retryTimer !== undefined) clearTimeout(retryTimer)
      stopStore()
      stopService()
      isolation.dispose()
      store.noteSlashDiag('idle')
    }
  }, 'dsh-ntr: slash isolation')

  // The ACP view tab: the agent's real stream (tool cards, plans, unified
  // diffs). Session-scope list entry; the view ring renders it one tab at a
  // time. Meanwhile the agent's prose and thinking ride the NATIVE chat plane
  // through the LLM adapter — see docs/acp-convergence.md §2.1.
  ctx.effect(() => ctx.slots.inject('conversation.view', () => ctx.slots.register({
    name: 'conversation.view',
    id: 'acp',
    order: 20,
    label: () => 'NTR',
    inject: (sessionId: unknown) => chatFace(sessionId),
  }, AcpConversationView as unknown as SlotComponent<any>)), 'dsh-ntr: ACP view tab')
}
