/**
 * The model seat: the host's `conversation.input.model` cell, which an ACP
 * conversation must not leave to the native selector — and which is where the
 * ACP base belongs.
 *
 * The host's `conversation.input.model` is a `single` slot rendered
 * unconditionally by the composer bar, in the TRAILING group (the far right,
 * immediately before the submit button) — which is where the host's own model
 * selector sits. Its shipped occupant (`client-ui-model-selection`'s
 * `ModelSelect`) reads the DSH model directory and submits through
 * `session.selectModel` — which writes the process-wide default model. On an
 * ACP conversation that is doubly wrong: the models there belong to the
 * external agent, and a click would poison the default for every other
 * conversation. So the ACP base is installed in that same cell instead: one
 * cell, one occupant, and the position the host's own base occupied. See
 * src/client/model-seat.tsx.
 *
 * The mechanism is a CLAIM rather than a declared rank, because the desktop
 * client runner rewrites the priority of every non-chain registration with its
 * own page-global decreasing counter — so the cell goes to whoever registered
 * last, whatever either side declares. The fake registry in the second suite
 * models exactly that, which is what makes these tests about the real runtime
 * behaviour instead of about a number.
 */

import { describe, expect, it } from 'vitest'
import {
  createModelSeatClaim, MAX_SEAT_CLAIMS, MODEL_SEAT_KEY, MODEL_SEAT_PRIORITY,
} from '../src/client/model-seat.tsx'
import type { SeatEntry, SeatSlots } from '../src/client/model-seat.tsx'
import { ACP_PRESET_ID, stagedIsAcpMode, stagedSessionOf } from '../src/client/acp-ui.tsx'

describe('the native model seat is occupied by the ACP base on an ACP conversation', () => {
  const acpRow = (retainedBy = { mainView: 1 }) => ({
    id: 'r1', retainedBy, projectionValues: { agentPreset: ACP_PRESET_ID },
  })

  it('displaces the native occupant rather than sitting beside it', () => {
    // `ModelSelect` registers at the slot's default priority (0), and a
    // `single` cell renders its LOWEST live priority. A positive or zero
    // declared priority here would either throw (same-priority duplicate,
    // which is fail-loud) or lose to the shipped entry — on a registry that
    // keeps what a registration declares. The desktop runner overwrites it;
    // see the claim tests below, which are what actually settle the cell.
    expect(MODEL_SEAT_PRIORITY).toBeLessThan(0)
  })

  it('stays hidden on every host shape the gate can be asked about', () => {
    for (const snapshot of [undefined, {}, { byId: {} }]) {
      expect(stagedIsAcpMode(snapshot)).toBe(false)
    }
  })

  it('shadow-flip follows the preset, not a flag the plugin set', () => {
    // The gate reads the runtime's own fold of `agent-preset/selected`, so it
    // can never drift from the roster the way a plugin-owned marker would.
    expect(stagedIsAcpMode({ byId: { r1: acpRow() } })).toBe(true)
    expect(stagedIsAcpMode({
      byId: { r1: { id: 'r1', retainedBy: { mainView: 1 }, projectionValues: { agentPreset: 'standard' } } },
    })).toBe(false)
  })

  it('drops the shadow for a subagent route, which is not a conversation we drive', () => {
    // The subagent's own model surface is its parent's concern; shadowing the
    // seat here would remove the native selector from a surface that needs it.
    // (An addressed route is marked `currentAddress` on the older snapshot
    // shape, or `origin` on the rc.2 rows — both are what `stagedSessionOf`
    // folds into `subagent`.)
    expect(stagedIsAcpMode({
      current: 'r1', currentAddress: { parent: 'p' }, byId: { r1: { agentPreset: ACP_PRESET_ID } },
    })).toBe(false)
    expect(stagedIsAcpMode({ byId: { r1: { id: 'r1', retainedBy: { mainView: 1 }, origin: 'subagent' } } }))
      .toBe(false)
  })

  it('requires a staged session — the gate stands down rather than guess', () => {
    // No session on stage (boot, or the list has not loaded): the gate has
    // nothing to judge, so it must not shadow. Shadowing on a guess would hide
    // the native seat from an ordinary conversation.
    expect(stagedSessionOf({ byId: { r1: { id: 'r1', retainedBy: {}, projectionValues: { agentPreset: ACP_PRESET_ID } } } }))
      .toBeUndefined()
    expect(stagedIsAcpMode({ byId: { r1: { id: 'r1', retainedBy: {}, projectionValues: { agentPreset: ACP_PRESET_ID } } } }))
      .toBe(false)
  })

  it('finds a staged row that has no ids entry — byId is the superset', () => {
    // rc.2's controller projects `ids` from the host list only, then appends
    // two families to `byId` WITHOUT an ids entry: subagent-catalog children of
    // a projected parent, and live retained scopes. Either can be the row the
    // main view holds. Walking `ids` alone here reported "nothing is staged"
    // and the gate stood down on a real ACP conversation — the native model
    // selector stayed on screen and nothing said why. `byId` is the candidate
    // set; `ids` only breaks ties in display order.
    const snapshot = {
      ids: ['other'],
      byId: {
        other: { id: 'other', retainedBy: { mainView: 0 } },
        r1: { id: 'r1', retainedBy: { mainView: 1 }, projectionValues: { agentPreset: ACP_PRESET_ID } },
      },
    }
    expect(stagedSessionOf(snapshot)?.sessionId).toBe('r1')
    expect(stagedIsAcpMode(snapshot)).toBe(true)
  })

  it('keeps ids order when several rows retain the main view', () => {
    // A multi-view layout can leave two rows retained. The host's own main-view
    // picker takes the first `byId` row it finds, but a list that shows them in
    // `ids` order should hand the seat to the one the user sees first — not to
    // whichever id happened to be inserted first into the map.
    const snapshot = {
      ids: ['b', 'a'],
      byId: {
        a: { id: 'a', retainedBy: { mainView: 1 }, projectionValues: { agentPreset: 'standard' } },
        b: { id: 'b', retainedBy: { mainView: 1 }, projectionValues: { agentPreset: ACP_PRESET_ID } },
      },
    }
    expect(stagedSessionOf(snapshot)?.sessionId).toBe('b')
    expect(stagedIsAcpMode(snapshot)).toBe(true)
  })

  it('ranks rows without an ids entry last, so a real list row always wins', () => {
    // The two fallback families are display-less; if one of them outranked the
    // genuine staged row the gate would judge the wrong conversation entirely.
    const snapshot = {
      ids: ['real'],
      byId: {
        stray: { id: 'stray', retainedBy: { mainView: 1 }, projectionValues: { agentPreset: ACP_PRESET_ID } },
        real: { id: 'real', retainedBy: { mainView: 1 }, projectionValues: { agentPreset: 'standard' } },
      },
    }
    expect(stagedSessionOf(snapshot)?.sessionId).toBe('real')
    expect(stagedIsAcpMode(snapshot)).toBe(false)
  })
})

/**
 * The claim, exercised against a stand-in registry that keeps the runtime's
 * OWN rule: a non-chain registration's declared priority is discarded and
 * replaced by a page-global decreasing rank, so the most recent registration
 * wins the cell. The real rule was read from the shipped client runner's
 * `guardedSlots` (the facade every bundle, including this one, registers
 * through) and from `SlotRegistry.entriesOfSlot`, which is the winner view the
 * renderer's own outlet reads.
 */
describe('the model seat claim', () => {
  /** A stand-in for the ACP base the gate installs into the cell. */
  const ACP_BASE = function AcpBase(): null { return null }

  /**
   * A stand-in for the ACP base that reads its face the way the real one does.
   *
   * `AcpSessionControls` destructures `{ acp, sessionId, useSession }` off its
   * props and calls `useUi(acp)`; with no inject face `acp` is `undefined` and
   * that call throws on the first render — which the slot's error boundary
   * converts into an abdication. This reproduces exactly that dependency
   * without importing the real component (which would pull the whole store and
   * React tree into a unit test).
   */
  const ACP_BASE_READING_ITS_FACE = function AcpBase(props: {
    acp?: unknown
    sessionId?: string
    useSession?: unknown
  }): null {
    // The shape the real base actually depends on: the store, then the hook.
    const acp = props.acp as { label?: unknown } | undefined
    if (acp === undefined || typeof acp.label !== 'function') {
      throw new TypeError("Cannot read properties of undefined (reading 'label')")
    }
    if (props.sessionId === undefined || props.useSession === undefined) {
      throw new TypeError('no session kit')
    }
    return null
  }

  /**
   * A stand-in for the gate's `chatFace` — the inject face every entry the
   * claim installs must declare. See the regression test at the bottom of this
   * suite for why it is not optional.
   */
  const CHAT_FACE = (sessionId: unknown): { acp: unknown; sessionId: string; faceFor: unknown } => ({
    acp: { label: () => '' }, sessionId: String(sessionId), faceFor: () => undefined,
  })

  /**
   * A stand-in for `ctx.slots`.
   *
   * `register` mimics the runner: the declared priority is thrown away and the
   * entry is ranked by a page-global counter that only decreases. It also KEEPS
   * the entry's `inject` — the registry stores the whole options object minus
   * its undefined members, exactly like `SlotCore.register` — because the
   * renderer reads it back out of the entry to compose the component's props.
   * `inject` mimics the registry: an undeclared slot throws on the way in, and
   * the disposer covers both the wait and whatever the callback installed.
   */
  function makeSlots(declared = true) {
    /** A live entry, in the registry's own shape (`options` carries the rank and the registrant). */
    interface FakeEntry {
      component: unknown
      options: { priority: number; registrant?: string }
      /** What the entry's own `inject` produced (the renderer reads this back). */
      inject?: (sessionId: unknown, actions?: unknown) => unknown
    }
    const entries: FakeEntry[] = []
    const ranks: number[] = []
    /** Every registration attempted, including ones the runner would rank (for assertions). */
    const attempted: Array<{ name: string; declaredPriority?: number; inject?: unknown }> = []
    let counter = 0
    let declaredNow = declared
    let epoch = declaredNow ? 1 : 0
    /** Reconciliation hooks the real registry fires from its declaration channel. */
    const watchers = new Set<() => void>()
    const slots: SeatSlots = {
      register(options: { name: string; priority?: number; inject?: (sessionId: unknown, actions?: unknown) => unknown }, component: unknown): () => void {
        attempted.push({
          name: options.name,
          ...options.priority === undefined ? {} : { declaredPriority: options.priority },
          ...options.inject === undefined ? {} : { inject: options.inject },
        })
        if (!declaredNow) throw new Error(`slot "${options.name}" is not declared (a parent entry's children table must declare it)`)
        // The runner's rewrite, verbatim in effect: the declaration is ignored.
        const rank = --counter
        ranks.push(rank)
        const entry: FakeEntry = {
          component,
          options: { priority: rank },
          ...options.inject === undefined ? {} : { inject: options.inject },
        }
        entries.push(entry)
        let live = true
        return () => {
          if (!live) return
          live = false
          entries.splice(entries.indexOf(entry), 1)
        }
      },
      inject(_key: string, callback: () => (() => void) | Iterable<() => void>): () => void {
        let active: (() => void) | undefined
        let activeEpoch: number | undefined
        let stopped = false
        const stop = (): void => {
          if (stopped) return
          stopped = true
          watchers.delete(reconcile)
          active?.()
          active = undefined
        }
        const reconcile = (): void => {
          if (stopped) return
          if (active !== undefined && activeEpoch === epoch) return
          active?.()
          active = undefined
          activeEpoch = undefined
          if (!declaredNow) return
          const effect = callback()
          activeEpoch = epoch
          active = typeof effect === 'function' ? effect : () => { for (const d of [...effect].reverse()) d() }
        }
        watchers.add(reconcile)
        reconcile() // throws when the slot is not declared, exactly like the registry
        return stop
      },
      entriesOfSlot(_key: string): readonly SeatEntry[] {
        // Lowest rank renders: `SlotCore.entriesOfSlot` returns cell heads in
        // priority order and the renderer takes `[0]`.
        return [...entries].sort((a, b) => a.options.priority - b.options.priority)
      },
      // The declaration probe. `inject` WAITS for it (it does not throw), so
      // this is the only way a claimant can tell an unmounted composer bar from
      // a cell someone else is holding.
      spec(_key: string): { kind?: string } | undefined {
        return declaredNow ? { kind: 'single' } : undefined
      },
    }
    return {
      slots,
      entries,
      ranks,
      attempted,
      /** Who the cell actually renders right now (the ranked head), or `undefined` when empty. */
      head(): SeatEntry | undefined {
        return slots.entriesOfSlot(MODEL_SEAT_KEY)[0]
      },
      /** Registrations made by us (the rival's are attributed in `attempted` too). */
      get ourRegistrations(): number {
        return entries.filter(entry => entry.options.registrant === undefined).length
      },
      /** A rival seat plugin registering LATER than us — the race we lose by default. */
      rival(registrant: string, priority?: number): void {
        attempted.push({ name: MODEL_SEAT_KEY, ...priority === undefined ? {} : { declaredPriority: priority } })
        // A rival also goes through the runner: its declared rank, whatever it
        // is (`dsh-thinking-effort` declares -10), is overwritten the same way.
        const rank = --counter
        ranks.push(rank)
        entries.push({ component: { rival: registrant }, options: { priority: rank, registrant } })
      },
      declare(): void { declaredNow = true; epoch += 1; for (const watch of [...watchers]) watch() },
    }
  }

  it('installs the ACP base and reports holding the cell', () => {
    const fake = makeSlots()
    const diag: string[] = []
    const claim = createModelSeatClaim({
      slots: fake.slots, occupant: () => ACP_BASE, inject: CHAT_FACE, onDiag: (line) => diag.push(line),
    })
    claim.sync()
    expect(claim.holding).toBe(true)
    expect(fake.entries).toHaveLength(1)
    // The occupant is a fresh identity per install — never the shared one the
    // gate hands over, or two entries could be folded into one.
    expect(fake.head()?.component).not.toBe(ACP_BASE)
    expect(diag.at(-1)).toContain('held by the ACP base')
    // The first occupant declares exactly the documented rank — on a
    // registry that keeps what a registration declares, that is what displaces
    // the shipped occupant (registered at the default 0).
    expect(fake.attempted[0]?.declaredPriority).toBe(MODEL_SEAT_PRIORITY)
  })

  it('hands the seat frame its props, so the base can read the session', () => {
    // The occupant is called with whatever the seat frame passes an entry (the
    // injected face plus the standard kit). It must forward them: the base
    // needs `sessionId` and the `useSession` hook to describe this
    // conversation, and a wrapper that dropped them would render a dead chip.
    const fake = makeSlots()
    const seen: unknown[] = []
    const claim = createModelSeatClaim({
      slots: fake.slots, occupant: () => (props: unknown) => { seen.push(props); return null }, inject: CHAT_FACE,
    })
    claim.sync()
    const rendered = fake.head()?.component as ((props: unknown) => unknown) | undefined
    const hook = (): undefined => undefined
    rendered?.({ sessionId: 's1', useSession: hook })
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ sessionId: 's1', useSession: hook })
  })

  it('retakes the cell when a rival registers after us', () => {
    // This is the reported failure: on the desktop, `dsh-thinking-effort`
    // registers its model/effort slider into this very cell, later than we do,
    // so its entry is ranked below ours and the native-looking seat stays on
    // screen. The claim notices through `entriesOfSlot` — the renderer's own
    // winner view — and registers again, which is what wins.
    const fake = makeSlots()
    const diag: string[] = []
    const claim = createModelSeatClaim({
      slots: fake.slots, occupant: () => ACP_BASE, inject: CHAT_FACE, onDiag: (line) => diag.push(line),
    })
    claim.sync()
    fake.rival('@hytime/dsh-thinking-effort', -10)
    expect(fake.head()?.options?.registrant).toBe('@hytime/dsh-thinking-effort')

    claim.sync() // what `slots/changed` triggers in the gate
    expect(claim.holding).toBe(true)
    expect(fake.head()?.options?.registrant).toBeUndefined()
    expect(diag.at(-1)).toContain('retook it from @hytime/dsh-thinking-effort')
    // The rival declared -10 and lost the cell anyway: on this registry what a
    // registration declares is not what ranks it, which is why a claim that
    // only declared a lower number would have been the wrong fix.
    expect(fake.attempted[1]?.declaredPriority).toBe(-10)
  })

  it('holds without registering again while nobody takes the cell', () => {
    // The gate calls `sync()` on every store mutation, list notification and
    // cell change. A claim that re-registered on each one would stack entries
    // for the whole session.
    const fake = makeSlots()
    const claim = createModelSeatClaim({
      slots: fake.slots, occupant: () => ACP_BASE, inject: CHAT_FACE,
    })
    claim.sync()
    for (let i = 0; i < 10; i += 1) claim.sync()
    expect(fake.entries).toHaveLength(1)
    expect(fake.ourRegistrations).toBe(1)
  })

  it('gives up loudly after the retake budget is spent', () => {
    // A rival that re-registers in a loop must not turn this into an endless
    // registration war; the user has to be able to read why the seat is back.
    const fake = makeSlots()
    const diag: string[] = []
    const claim = createModelSeatClaim({
      slots: fake.slots, occupant: () => ACP_BASE, inject: CHAT_FACE, onDiag: (line) => diag.push(line),
    })
    claim.sync()
    for (let i = 0; i < MAX_SEAT_CLAIMS + 3; i += 1) {
      fake.rival('rival', -100)
      claim.sync()
    }
    expect(claim.holding).toBe(false)
    expect(diag.at(-1)).toContain('gave up')
    // One install plus the budget — and no more registrations on later syncs.
    expect(fake.ourRegistrations).toBe(1 + MAX_SEAT_CLAIMS)
    const spent = fake.ourRegistrations
    claim.sync()
    expect(fake.ourRegistrations).toBe(spent)
  })

  it('releases every entry it installed, including retakes', () => {
    // Releasing is what takes the ACP base back out of the cell — the gate
    // calls it the moment the staged conversation leaves ACP mode, and the
    // native selector has to come back there.
    const fake = makeSlots()
    const claim = createModelSeatClaim({
      slots: fake.slots, occupant: () => ACP_BASE, inject: CHAT_FACE,
    })
    claim.sync()
    fake.rival('rival')
    claim.sync()
    expect(fake.entries).toHaveLength(3) // ours, the rival's, and the retake

    claim.release()
    expect(fake.ourRegistrations).toBe(0)
    // The rival's entry is not ours to dispose — only our own entries go.
    expect(fake.entries).toHaveLength(1)
    expect(claim.holding).toBe(false)
    // Disposing twice must not throw (the gate may release on both the
    // stand-down path and the effect teardown).
    expect(() => claim.release()).not.toThrow()
  })

  it('waits for the seat to be declared instead of throwing', () => {
    // The gate runs long before the composer bar mounts; the registry throws on
    // an undeclared slot, and that must not escape into a store mutation.
    const fake = makeSlots(false)
    const diag: string[] = []
    const claim = createModelSeatClaim({
      slots: fake.slots, occupant: () => ACP_BASE, inject: CHAT_FACE, onDiag: (line) => diag.push(line),
    })
    expect(() => claim.sync()).not.toThrow()
    expect(claim.holding).toBe(false)
    expect(diag.at(-1)).toContain('waiting for the host to declare')
    expect(fake.entries).toHaveLength(0)

    fake.declare()
    claim.sync()
    expect(claim.holding).toBe(true)
    expect(fake.entries).toHaveLength(1)
  })

  it('installs without pretending when the runtime exposes no winner view', () => {
    // `entriesOfSlot` is the only way to tell who won a cell. A runtime without
    // it cannot be verified — so say that, and do not loop trying.
    const fake = makeSlots()
    const slots: SeatSlots = { inject: fake.slots.inject, register: fake.slots.register }
    const diag: string[] = []
    const claim = createModelSeatClaim({
      slots, occupant: () => ACP_BASE, inject: CHAT_FACE, onDiag: (line) => diag.push(line),
    })
    claim.sync()
    for (let i = 0; i < 5; i += 1) claim.sync()
    expect(claim.holding).toBe(true)
    expect(fake.attempted).toHaveLength(1)
    expect(diag.at(-1)).toContain('not verifiable')
  })

  it('keeps the cell when the base renders with the face it declared', () => {
    // THE regression this suite exists for, exercised the way the runtime
    // composes an entry.
    //
    // `conversation.input.model` is a SESSION-scoped slot, and the renderer
    // composes an entry's props as `{ ...standardKit, ...entryInject(sessionId,
    // actions), ...slotInject, ...ownerProps }` (`SessionEntry` →
    // `renderEntry`). The kit carries only the framework's own shares
    // (`sessionId`, `useSession`, …), so everything the ACP base reads beyond
    // it — `acp`, `faceFor` — arrives ONLY through the entry's own `inject`.
    //
    // Register the occupant without one and it renders with `acp === undefined`
    // and throws. The slot's error boundary catches that crash and reports it
    // as an ABDICATION: the registry retires our entry from its cell for the
    // rest of that registration's life, and the outlet re-projects onto the
    // cell's next survivor — the shipped `ModelSelect`. The native seat is back
    // and the ACP base is gone, while the gate's diagnostic still reads "held
    // by the ACP base", because `sync()` verified the cell during React's
    // commit phase, long before the occupant rendered.
    //
    // So this renders the occupant exactly as the runtime does and asserts the
    // entry survives its own render, which is what keeps it in the cell.
    const fake = makeSlots()
    const claim = createModelSeatClaim({
      slots: fake.slots,
      occupant: () => ACP_BASE_READING_ITS_FACE,
      inject: CHAT_FACE,
    })
    claim.sync()

    const head = fake.head()
    expect(head).toBeDefined()
    const inject = (head as { inject?: (sessionId: unknown, actions?: unknown) => unknown }).inject
    expect(typeof inject).toBe('function')
    // What the renderer hands the component: the standard kit, then the face.
    const composed = { sessionId: 's1', useSession: () => ({ running: false }), ...inject?.('s1') }
    expect(() => (head?.component as (p: unknown) => unknown)(composed)).not.toThrow()
    expect(fake.head()?.component).toBe(head?.component)
    expect(claim.holding).toBe(true)
  })

  it('an occupant reading a face it was never given is the failure this closes', () => {
    // The same render WITHOUT the inject face — the exact shape the claim
    // registered before this option existed. The occupant cannot survive it,
    // and "cannot survive" means an abdication: our entry leaves the cell and
    // the native seat returns, with nothing on the gate's side to report it.
    // `inject` is a required option precisely so this cannot be written again.
    const fake = makeSlots()
    const claim = createModelSeatClaim({
      slots: fake.slots,
      occupant: () => ACP_BASE_READING_ITS_FACE,
      // Cast, not an omission: the claim now REQUIRES this option, so the only
      // way to model the old registration is to pass a face that produces
      // nothing — which is what an entry with no `inject` effectively had.
      inject: () => undefined,
    })
    claim.sync()
    const head = fake.head()
    const inject = (head as { inject?: (sessionId: unknown, actions?: unknown) => unknown }).inject
    expect(typeof inject).toBe('function')
    // The kit alone, exactly what an entry without a face would render with.
    const composed = { sessionId: 's1', useSession: () => ({ running: false }), ...inject?.('s1') }
    // The base reads `props.acp` and crashes — which the runtime's error
    // boundary converts into the abdication that hands the cell back.
    expect(() => (head?.component as (p: unknown) => unknown)(composed)).toThrow()
  })
})
