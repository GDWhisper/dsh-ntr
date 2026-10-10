/**
 * The ACP conversation's claim on the host's native model seat.
 *
 * WHAT IT IS: `conversation.input.model` is a `single` slot the host's composer
 * bar renders unconditionally, in the TRAILING group (`margin-left: auto`),
 * immediately before the activity/stop/submit chrome — which is exactly where
 * the host's own model selector sits. Its shipped occupant is
 * `client-ui-model-selection`'s `ModelSelect`, which reads the DSH model
 * directory and submits through `session.selectModel`, which in turn writes
 * `agentDefaultModel.saveSelection` — the process-wide default. On an ACP
 * conversation none of that describes anything real: the models belong to the
 * external agent (`agent/catalog`), so the seat would list providers this
 * conversation cannot use, and clicking one would poison the default for every
 * other conversation. Third-party seat plugins land in this same cell.
 *
 * SO THE CLAIM PUTS THE ACP BASE THERE. The ACP base (`AcpSessionControls`) is
 * the surface that already describes what this conversation runs on, and the
 * seat it has to displace is the one that would otherwise misdescribe it — one
 * cell, one occupant, and the position the host's own base occupied. The base
 * is installed by the ACP-mode gate in `index.tsx`, which holds the claim only
 * while the staged conversation runs the ACP preset and releases it the moment
 * it does not, so an ordinary conversation gets the native selector back and
 * sees no ACP chrome at all. That gate is the whole isolation story: the entry
 * does not exist outside ACP mode, rather than existing and rendering nothing.
 *
 * WHY A CLAIM AND NOT A `priority: -1` REGISTRATION: the declared rank is NOT
 * what decides this cell on the desktop runtime. The client runner (the facade
 * every bundle — including this one — is loaded through) REWRITES the priority
 * of every non-chain registration with its own page-global counter, which only
 * decreases:
 *
 *   // @deepseek-ai/dsh-cordis-client-runner, `guardedSlots`
 *   const spec = slots.spec(slot);
 *   let priority = options.priority;
 *   if (spec === undefined || spec.kind !== "chain") {
 *     priority = env.allocatePriority();   // `allocatePriority: () => --this.nextPriority`
 *     options.priority = priority;
 *   }
 *
 * So in a `single` cell (lowest live rank renders) the winner is simply
 * whoever registered LAST — a rival seat plugin that loads a moment after us
 * takes the cell no matter what either side declares. `dsh-thinking-effort`
 * provably does exactly that: it registers a model + reasoning slider into this
 * very cell, and it is a later registration, so it would stay on screen in ACP
 * conversations regardless of any rank we declare (and its own declared `-10`
 * is discarded just the same).
 *
 * The fix is therefore to treat the cell as a claim we VERIFY and, when a rival
 * took it, retake by registering again (a new registration is the lowest rank
 * on the page, which is what wins). That is the whole mechanism: read the
 * renderer's own winner view (`entriesOfSlot`, the same call the renderer's
 * outlet makes), compare it with our own component identities, and re-register
 * when it is not ours — bounded, and honest about giving up. Nothing else from
 * the retired seat machinery comes back: no abdicate recovery, no session-long
 * `seatBroken`, no rank arithmetic as an end in itself.
 *
 * WHAT THE CLAIM MUST CARRY: the occupant's own inject face. That is not an
 * optional extra — this cell is SESSION-scoped, so the renderer gives an entry
 * only the framework's standard kit (`sessionId`, `useSession`, …) unless the
 * entry declares an `inject`, and the ACP base reads `acp` and `faceFor`, both
 * of which arrive ONLY through it. Registering the occupant without one makes
 * it render with `acp === undefined`; the slot's error boundary catches the
 * resulting crash and reports it as an ABDICATION, which retires our entry from
 * the cell for the rest of that registration's life and hands the cell back to
 * the shipped `ModelSelect` — the native seat returns, the ACP base is gone,
 * and the gate never hears about it because `sync()` already verified the cell
 * and reported "held by the ACP base". So `inject` is a required option (a
 * compile error at the one call site) instead of an optional one (a silent
 * abdication at runtime). See {@link ModelSeatClaimOptions.inject}.
 *
 * The gate reads the session's own preset (`stagedIsAcpMode` in `acp-ui.tsx`)
 * rather than anything the plugin recorded, so it can never drift from the
 * roster.
 */

import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'

/** Exact key of the composer's model seat (a `single`, session-scoped slot). */
export const MODEL_SEAT_KEY = 'conversation.input.model'

/**
 * Declared rank of the first occupant we install.
 *
 * Honoured only by a registry that keeps what we declare (a statically composed
 * client, or a future runner that stops rewriting non-chain priorities): it
 * displaces a shipped occupant registering at the default rank 0. Under the
 * desktop runner the rank is overwritten with its own counter — see the module
 * header — which is why the claim verifies ownership instead of trusting this.
 */
export const MODEL_SEAT_PRIORITY = -1

/**
 * How many times ONE claim may retake the cell before it stops and says so.
 *
 * Each retake is triggered by evidence (the cell's winner is not ours), so a
 * normal page needs at most one; the cap only bounds a rival that registers in
 * a loop, and reaching it is reported rather than hidden.
 */
export const MAX_SEAT_CLAIMS = 4

/** One live entry in the cell, narrowed to what the claim reads. */
export interface SeatEntry {
  component?: unknown
  options?: { priority?: number; registrant?: string }
}

/** The slot-registry face this module uses (structural: the registry is not a dependency of this bundle). */
export interface SeatSlots {
  inject(key: string, callback: () => (() => void) | Iterable<() => void>): () => void
  /** Returns the entry's disposer (the registry hangs it on the caller's fiber too). */
  register(options: SeatRegisterOptions, component: unknown): () => void
  /** The renderer's winner view per cell; absent on a runtime that does not expose it. */
  entriesOfSlot?(key: string): readonly SeatEntry[]
  /** The declaration probe; absent on a runtime that does not expose it. */
  spec?(key: string): { kind?: string } | undefined
}

/**
 * One registration's options, narrowed to what the claim passes. `inject` is
 * NOT optional in practice — see {@link ModelSeatClaimOptions.inject}.
 */
export interface SeatRegisterOptions {
  name: string
  priority?: number
  /**
   * The session-scoped face factory the renderer calls with the scope binding's
   * key (and the store's actions) before rendering, merging its result into the
   * component's props. A session-scoped occupant that renders conversation
   * chrome without one arrives with only the standard kit — no `acp`, no
   * `faceFor` — and crashes on its first render.
   */
  inject?(sessionId: unknown, actions?: unknown): unknown
}

export interface ModelSeatClaimOptions {
  slots: SeatSlots
  /**
   * The occupant to install into the cell — the ACP base for an ACP-mode
   * conversation. Called once per installed entry and receives whatever props
   * the seat frame hands an entry (the injected face plus the standard kit),
   * so it must be the component itself and not a bound closure over one
   * session's props.
   */
  occupant(): unknown
  /**
   * The inject face every installed entry declares — REQUIRED, and the reason
   * is a failure mode that is silent by construction.
   *
   * `conversation.input.model` is a SESSION-scoped slot. The renderer composes
   * an entry's props as `{ ...standardKit, ...entryInject(sessionId, actions),
   * ...slotInject, ...ownerProps }` (`SessionEntry` → `renderEntry`), so the
   * standard kit alone carries only the framework's own shares (`sessionId`,
   * `useSession`, …). Everything this plugin's occupant reads beyond that —
   * `acp`, `faceFor` — arrives ONLY through the entry's own `inject`.
   *
   * Register without it and the occupant renders with `acp === undefined`. The
   * crash is caught by the slot's error boundary, which reports it as an
   * ABDICATION: the registry retires our entry from its cell for the rest of
   * that registration's life, and the outlet re-projects onto the cell's next
   * survivor — the shipped `ModelSelect`. The native seat is back, the ACP base
   * is gone, and nothing on the gate's side moves: the abdication happens
   * during React's render phase, after `sync()` already verified the cell and
   * reported "held by the ACP base". That is exactly how the base went missing
   * with the diagnostic still claiming it was installed.
   *
   * So this is a required option rather than an optional one: the omission is
   * then a compile error at the single call site instead of a runtime
   * abdication nobody can see.
   */
  inject(sessionId: unknown, actions?: unknown): unknown
  /** Every evaluation reports its verdict here (the gate forwards it to the ACP view's diagnostic line). */
  onDiag?(line: string): void
  maxClaims?: number
}

export interface ModelSeatClaim {
  /** Hold or retake the cell; idempotent, so it can run on every gate evaluation. */
  sync(): void
  /** Whether the last verified observation found our entry winning the cell. */
  readonly holding: boolean
  /** Release every entry this claim installed (the gate's stand-down). */
  release(): void
}

/** Where the cell stood, as far as this bundle can tell. */
interface CellView {
  /**
   * `false` while the composer bar has not mounted the seat. `inject` WAITS
   * for the declaration instead of failing, so an undeclared seat and a seat
   * held by someone else both read as "the winner is not ours" through the
   * winner view alone — and only one of them justifies a retake.
   */
  declared: boolean
  /** `false` when the runtime exposes no winner view — ownership cannot be verified there. */
  verified: boolean
  entry?: SeatEntry
}

/**
 * Take and hold the composer's model seat for one ACP-mode spell.
 *
 * Lifecycle: the gate creates a claim when the staged conversation enters ACP
 * mode, calls `sync()` on every evaluation (store mutation, session-list
 * notification, preset frame, and any change to the cell itself), and calls
 * `release()` when the conversation leaves ACP mode or the gate tears down.
 */
export function createModelSeatClaim(options: ModelSeatClaimOptions): ModelSeatClaim {
  const { slots, occupant, inject } = options
  const onDiag = options.onDiag
  const maxClaims = options.maxClaims ?? MAX_SEAT_CLAIMS
  /**
   * The component identity of every entry we installed. Fresh per install: the
   * runner attributes a crashed entry by component identity, and two seats with
   * one identity could be folded into a single entry.
   */
  const ours = new Set<unknown>()
  /** Declared ranks we have used — a registry that keeps them throws on a duplicate. */
  const declared = new Set<number>()
  /** Disposers of every entry we installed, oldest first (released as a stack). */
  const installed: Array<() => void> = []
  /** Retakes spent on this claim. */
  let retakes = 0
  let holding = false

  const say = (line: string): void => onDiag?.(line)

  /** The rival's own words about itself, for the diagnostic line. */
  const describe = (entry: SeatEntry | undefined): string => {
    if (entry === undefined) return 'no occupant'
    const who = entry.options?.registrant
    const rank = entry.options?.priority
    if (who === undefined && rank === undefined) return 'another entry'
    return `${who ?? 'an unnamed entry'} (rank ${rank ?? 0})`
  }

  /** Read the cell's declaration and winner, distinguishing the three states that matter. */
  const cell = (): CellView => {
    let declared = true
    if (typeof slots.spec === 'function') {
      try { declared = slots.spec(MODEL_SEAT_KEY) !== undefined } catch { declared = false }
    }
    if (typeof slots.entriesOfSlot !== 'function') return { declared, verified: false }
    try {
      const heads = slots.entriesOfSlot(MODEL_SEAT_KEY) ?? []
      return { declared, verified: true, ...heads[0] === undefined ? {} : { entry: heads[0] } }
    } catch {
      // A registry that throws here tells us nothing about ownership; refusing
      // to loop on it is the only safe reading.
      return { declared, verified: false }
    }
  }

  /**
   * Install one more entry occupying the cell.
   *
   * A declared rank strictly below the incumbent's (and below anything we have
   * used, since a duplicate rank is a hard error in a registry that keeps it).
   * Returns `false` — with the reason reported — when the registry refuses,
   * which is recoverable: the gate re-evaluates and tries again.
   */
  const install = (head: SeatEntry | undefined): boolean => {
    // The first occupant declares exactly the documented rank; a retake goes
    // strictly below it (and below whatever holds the cell now) so a registry
    // that KEEPS declared ranks has no duplicate and no incumbent above us.
    const base = installed.length === 0 ? MODEL_SEAT_PRIORITY : MODEL_SEAT_PRIORITY - 1 - retakes
    let rank = Math.min((head?.options?.priority ?? 0) - 1, base)
    while (declared.has(rank)) rank -= 1
    // A fresh identity per install: the registry dedups by component identity,
    // and one occupant object shared across entries could be folded into one.
    // The wrapper is what the seat frame calls, so it forwards the frame's
    // props (the injected face plus the standard kit) to the occupant — without
    // them the base could not name the session it is describing.
    const component = (props: unknown): unknown => {
      const installed = occupant() as (p: unknown) => unknown
      return installed(props)
    }
    ours.add(component)
    declared.add(rank)
    try {
      installed.push(slots.inject(MODEL_SEAT_KEY, () => slots.register({
        name: MODEL_SEAT_KEY,
        priority: rank,
        // The occupant's own face. This cell is session-scoped, so the
        // renderer hands an entry only the standard kit unless the entry
        // declares an `inject` — and everything the ACP base reads beyond the
        // kit (`acp`, `faceFor`) arrives ONLY through it. See
        // {@link ModelSeatClaimOptions.inject} for the failure this closes.
        inject,
      }, component)))
      return true
    } catch (error) {
      ours.delete(component)
      declared.delete(rank)
      say(`model seat: registration failed (${error instanceof Error ? error.message : String(error)})`)
      return false
    }
  }

  return {
    get holding(): boolean { return holding },
    sync(): void {
      // The occupant has to exist before there is anything to verify.
      if (installed.length === 0 && !install(undefined)) return
      const view = cell()
      if (!view.declared) {
        // Nothing to win yet: the composer bar has not mounted the seat, and
        // our registration is parked on that declaration.
        holding = false
        say(`${MODEL_SEAT_KEY}: waiting for the host to declare the seat`)
        return
      }
      if (!view.verified) {
        holding = true
        say(`${MODEL_SEAT_KEY}: occupied (ownership is not verifiable on this runtime)`)
        return
      }
      if (ours.has(view.entry?.component)) {
        holding = true
        say(`${MODEL_SEAT_KEY}: held by the ACP base${retakes === 0 ? '' : ` (retook it ${retakes}×)`}`)
        return
      }
      // A rival holds the cell — including the case where our own first
      // registration lost it outright.
      const incumbent = view
      if (retakes >= maxClaims) {
        // Bounded and loud: a rival that re-registers in a loop must not turn
        // this into an endless registration war, and the user must be able to
        // read why the native control is back.
        holding = false
        say(`${MODEL_SEAT_KEY}: taken by ${describe(incumbent.entry)} — gave up after ${maxClaims} retakes`)
        return
      }
      retakes += 1
      if (!install(incumbent.entry)) return
      // Verify — a fresh registration is expected to be the lowest live rank on
      // the page, but being wrong about that must be visible, not assumed.
      const settled = cell()
      if (settled.verified && ours.has(settled.entry?.component)) {
        holding = true
        say(`${MODEL_SEAT_KEY}: retook it from ${describe(incumbent.entry)} (retake ${retakes})`)
        return
      }
      holding = false
      say(`${MODEL_SEAT_KEY}: still held by ${describe(settled.entry ?? incumbent.entry)} after retake ${retakes}`)
    },
    release(): void {
      while (installed.length > 0) {
        try { installed.pop()?.() } catch { /* a refused disposer must not strand the rest */ }
      }
      ours.clear()
      declared.clear()
      retakes = 0
      holding = false
    },
  }
}
