/**
 * Shared browser-side kit for the ACP *conversation* surfaces: the composer
 * cluster (agent / model / thought level) and the ACP view tab.
 *
 * Everything here is deliberately structural. The ACP plugin's client half may
 * not import the host runtime or any client package at runtime — the seats it
 * takes (`conversation.input.left`, `conversation.input.overlay`,
 * `conversation.view`) are declared by `dsh-client-ui-conversation`, and the
 * services it reads (`modelDirectories`, `sessions`) are resolved by the entry
 * in `index.tsx` and handed over as plain functions. That is what keeps this
 * bundle loadable in a deployment that composes only a subset of the official
 * client modules: an absent service yields `undefined` and the surface hides
 * itself instead of breaking the plugin.
 *
 * THE ONE DUPLICATED CODEC: `splitAcpModelId` mirrors the host's
 * `splitAdapterModelId` (src/impl.ts). It cannot be imported from there — the
 * browser half must not pull host-plane modules into the bundle — and the
 * shared contract file is types-only by rule. Keep the two in step: they are
 * the only place that knows how `agentId` and `agentId@choice` are spelled.
 */

import type { CSSProperties, ReactNode } from 'react'
import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { AcpStore, UiState } from './store.ts'

// ---- Host-facing structural types ----

/** One adapter-provided reasoning effort (DSH `ModelReasoningEffort`). */
export interface AcpReasoningEffort {
  id: string
  name: string
  description?: string
}

/**
 * One model inside a provider group (the subset of DSH's `ModelCatalogModel`).
 *
 * The ACP surfaces no longer READ these: the directory is DSH's global provider
 * catalog, and the `acp` route advertises no models there, so an ACP agent's
 * models come from `agent/catalog` instead (see `AgentCatalogResult`). The
 * shape stays because the directory still carries `groups` and the shared
 * `AcpDirectoryState` has to describe it.
 */
export interface AcpModelEntry {
  id: string
  name: string
  description?: string
  reasoning?: { efforts: readonly AcpReasoningEffort[]; defaultEffort?: string }
}

/** One provider group of the session's advisory model directory. */
export interface AcpModelGroup {
  id: string
  name: string
  models: readonly AcpModelEntry[]
}

/** The per-session model directory snapshot (`ModelDirectoryState`, narrowed). */
export interface AcpDirectoryState {
  current: { provider: string; model: string; reasoningEffort?: string } | null
  routable: boolean | null
  groups: readonly AcpModelGroup[]
  status: string
  error: string | null
}

/** The shared per-session model directory (`ctx.modelDirectories.directoryFor`). */
export interface AcpDirectory {
  store: {
    getSnapshot(): AcpDirectoryState
    subscribe(listener: () => void): () => void
  }
  load(): Promise<unknown>
  select(selection: { provider: string; model: string; reasoningEffort?: string }): Promise<void>
}

/** One row of the DSH permission-preset select (`permissionPresets.catalog`). */
export interface AcpPermissionOption {
  value: string
  name: string
  description?: string
}

/**
 * The `permissions` session projection value (DSH `PermissionSelect`),
 * narrowed: the projection carries the SELECTION ONLY — its `viewSchema` is
 * `{ currentValue }` (0.1.7-rc.2, `dsh-permission-presets`). The rows to switch
 * to are NOT in it (see `AcpPermissionCatalog`).
 */
export interface AcpPermissionSelection {
  currentValue: string
}

/**
 * The process-level permission catalog (`permissionPresets.catalog`), narrowed
 * to its rows. Deliberately NOT read off the session projection: it does not
 * live there, and declaring it there once already cost a picker entry its life
 * (a render crash abdicates the slot entry — the "seat clicks do nothing" bug).
 */
export interface AcpPermissionCatalog {
  options: readonly AcpPermissionOption[]
}

/** The joined view the picker needs: where this session is + what it can switch to. */
export interface AcpPermissionSelect {
  options: readonly AcpPermissionOption[]
  currentValue: string
}

/** Resolves the process-level permission catalog; `undefined` when the host has no such service. */
export type AcpPermissionCatalogResolver = () => Promise<AcpPermissionCatalog | undefined> | undefined

/**
 * The session's command + projection face (`SessionFace`), narrowed to what the
 * cluster uses: `/permission <preset>` writes the boundary through the host's
 * own command, so the plugin never reimplements the switch.
 */
export interface AcpSessionFace {
  command(line: string): Promise<
    { ok: true; value: { matched: boolean } } | { ok: false; error: { code: string; message: string } }
  >
  projections: {
    faceOf(key: string): {
      getSnapshot(): unknown
      subscribe(listener: () => void): () => void
    }
  }
}

/** What `index.tsx` hands every ACP conversation entry. */
export interface AcpChatInjected {
  acp: AcpStore
  /** Resolve the session's shared model directory; `undefined` when the model-selection plugin is absent. */
  directoryFor(sessionId: string): AcpDirectory | undefined
  /** Resolve the session's command/projection face; `undefined` before the session materializes. */
  faceFor(sessionId: string): AcpSessionFace | undefined
  /** Resolve the process-level permission catalog (the boundary picker's rows). */
  permissionCatalogFor?: AcpPermissionCatalogResolver
}

// ---- The session standard kit (framework-provided, declared structurally) ----

/**
 * The slice of the client runtime's `ConversationSnapshot` our composer entries
 * read: `running` is the only field we watch, and the only re-read trigger we
 * have for the host's ACP chat-session binding (a fresh conversation gets its
 * binding when its first turn creates one, and no SSE frame announces that).
 */
export interface AcpSessionSnapshot {
  running: boolean
}

/**
 * `SessionStandardProps.useSession`: the selector hook the renderer binds per
 * session binding (see `standardKit` in `dsh-client-ui-renderer` —
 * `standard['sessionId'] = info.sessionId` and every `hooks` source becomes a
 * `use<Name>` selector hook).
 *
 * Declared structurally, like every other host-facing type here, because the
 * client runtime that merges `SessionStandardProps` is not part of a plugin's
 * dependency closure: `PropsRuntime<K>` resolves to `object` in a plugin's own
 * build, so the type cannot name these members even though the runtime hands
 * them over. THE MEMBERS ARE `sessionId` + `useSession` — owners pass neither,
 * and there is no `session` prop on any of these seats (reading one was a
 * shipped crash: `Cannot read properties of undefined (reading 'sessionId')`).
 */
export interface AcpSessionHook {
  <S>(selector: (snapshot: AcpSessionSnapshot) => S): S
}

// ---- The shared adapter-model codec (see the module header) ----

/** Split `agentId` / `agentId@choice`; mirrors the host's `splitAdapterModelId`. */
export function splitAcpModelId(model: string): { agentId: string; choice?: string } {
  const at = model.indexOf('@')
  if (at <= 0) return { agentId: model }
  return { agentId: model.slice(0, at), choice: model.slice(at + 1) }
}

/**
 * Whether a form value looks like an absolute path on some platform the plugin
 * runs on: POSIX (`/…`), a Windows drive path (`C:\…`, `C:/…`), or a UNC path
 * (`\\host\share…`, `//host/share…`). Mirrors the host's `isAbsolutePath`
 * (src/impl.ts) — the browser must pre-reject exactly what `validateAgentDef`
 * would reject, or a save the form enables dies on the host
 * (tests/acp-view.spec.ts asserts equivalence on a shared sample set).
 *
 * The extended-length `\\?\…` / `//?/…` family is rejected here too: the host's
 * workspace guard cannot interpret it, so a config written that way could never
 * resolve a cwd.
 */
export function isAbsolutePathLike(p: string): boolean {
  if (p.startsWith('\\\\?\\') || p.startsWith('//?/')) return false
  return p.startsWith('/') || /^[A-Za-z]:[\\/]/.test(p) || p.startsWith('\\\\')
}

/** The ACP provider route id every ACP model selection carries. */
export const ACP_PROVIDER = 'acp'

/** One model route selection (the subset of DSH's `ModelSelection`) these surfaces write. */
export interface AcpRouteSelection {
  provider: string
  model: string
  reasoningEffort?: string
}

/** The `modelSelection` session projection, narrowed to its wire view. */
export interface AcpModelSelectionProjection {
  lastUsed: AcpRouteSelection | null
  next: AcpRouteSelection | null
}

/**
 * Whether a session carries a model selection of its OWN, as opposed to running
 * on the deployment default model.
 *
 * WHY it matters: the gate routes a brand-new ACP-mode conversation to the
 * default agent, and a session that has never selected anything is the only one
 * where that is not overriding somebody's choice — a route the user picked (or
 * the `/model` popup wrote) is the documented "detached" state the seat warns
 * about instead of silently undoing.
 *
 * @returns `true`/`false` when the projection answered, `undefined` when it
 *   cannot be read at all (an older runtime, an addressed subagent route) — the
 *   caller must then leave the session alone.
 */
export function sessionHasOwnSelection(faceFor: AcpChatInjected['faceFor'], sessionId: string): boolean | undefined {
  try {
    const projection = faceFor(sessionId)?.projections.faceOf('modelSelection')?.getSnapshot() as AcpModelSelectionProjection | undefined | null
    if (projection === undefined || projection === null || typeof projection !== 'object') return undefined
    return projection.lastUsed != null || projection.next != null
  } catch {
    return undefined
  }
}

/**
 * Write one ACP route into a session's shared model directory — and keep the
 * DEPLOYMENT default model off it.
 *
 * WHY the second half: DSH's `session.selectModel` records a selection as the
 * session's own durable route AND as the deployment default, and that second
 * write is global — every NEW session in EVERY mode starts on it. So an ACP
 * pick made here would leak the agent into ordinary conversations, which is
 * exactly what this plugin's two-way isolation forbids. The host half's guard
 * (`AcpDefaultModelGuard`) puts the previous native value back, and it needs the
 * route this session was on *before* the write to do that exactly rather than
 * by guessing — hence the read below.
 *
 * Every ACP route write in this bundle goes through here (the chips' picker, the
 * ACP view's takeover, the gate's auto-route), so no surface can reintroduce the
 * leak on its own.
 */
export async function selectAcpRoute(
  acp: AcpStore,
  directory: AcpDirectory,
  selection: AcpRouteSelection,
): Promise<void> {
  const before = directory.store.getSnapshot().current
  await directory.select(selection)
  // A closed loop on purpose: an ACP route is never the value to restore, and a
  // failed repair is housekeeping noise, not a failed pick.
  await acp.reconcileDefaultModel(before === null || before.provider === ACP_PROVIDER ? undefined : before)
}

// ---- React bindings ----

/** Subscribe to the ACP store (the panel and every chat surface share this). */
export function useUi(acp: AcpStore): UiState {
  return useSyncExternalStore(cb => acp.subscribe(cb), () => acp.getSnapshot())
}

/** How long `useDirectory` keeps re-asking for a session's directory, and how long it waits between asks. */
const DIRECTORY_RESOLVE_RETRY_MS = 120
const DIRECTORY_RESOLVE_ATTEMPTS = 25

/**
 * Resolve one session's model directory, or `undefined` when the host has none
 * for it *yet*.
 *
 * A THROW IS NOT A VERDICT. `ModelDirectoryResolver.directoryFor` materializes
 * the session's runtime scope on first use and throws while that scope does not
 * exist (observed live: `cannot get property "remote.session" without inject`,
 * boot-time, for the session on stage) — and the addressed-subagent case throws
 * by design. Caching the throw is what leaves the whole ACP surface blank for
 * the page's lifetime, so the caller retries instead (see {@link useDirectory}).
 */
function resolveDirectory(
  directoryFor: AcpChatInjected['directoryFor'],
  sessionId: string,
): AcpDirectory | undefined {
  try {
    return directoryFor(sessionId)
  } catch {
    return undefined
  }
}

/**
 * Resolve and observe one session's model directory. The directory is loaded
 * once per session (the host is the fact source and pushes the current
 * selection back), and `undefined` covers both "service absent" and "this is
 * an addressed subagent session, which the Agent-bound RPCs refuse".
 *
 * The resolution is retried (bounded) rather than memoized: the first render of
 * a freshly staged session legitimately precedes its runtime scope, and a
 * one-shot memo would freeze that failure. Once a directory is in hand the
 * retry stops for good, so a steady-state surface does no extra work.
 */
export function useDirectory(directoryFor: AcpChatInjected['directoryFor'], sessionId: string): {
  directory?: AcpDirectory
  state?: AcpDirectoryState
} {
  // Keyed on the RESOLVER, never on an object carrying it: a fresh options
  // object every render would re-resolve (and so re-load) the directory on
  // every render, which is an RPC loop.
  const [directory, setDirectory] = useState<AcpDirectory | undefined>(() => resolveDirectory(directoryFor, sessionId))
  useEffect(() => {
    const first = resolveDirectory(directoryFor, sessionId)
    if (first !== undefined) {
      setDirectory(first)
      return
    }
    setDirectory(undefined)
    let attempts = 0
    const timer = setInterval(() => {
      const resolved = resolveDirectory(directoryFor, sessionId)
      if (resolved !== undefined) {
        setDirectory(resolved)
        clearInterval(timer)
        return
      }
      // Bounded: a session that never materializes a runtime scope (an
      // addressed subagent route) simply keeps the surface hidden.
      if (++attempts >= DIRECTORY_RESOLVE_ATTEMPTS) clearInterval(timer)
    }, DIRECTORY_RESOLVE_RETRY_MS)
    return () => { clearInterval(timer) }
  }, [directoryFor, sessionId])
  const subscribe = useMemo(
    () => (cb: () => void): (() => void) => directory?.store.subscribe(cb) ?? noopSubscribe,
    [directory],
  )
  const getState = useMemo(() => (): AcpDirectoryState | undefined => directory?.store.getSnapshot(), [directory])
  const state = useSyncExternalStore(subscribe, getState)
  useEffect(() => {
    if (directory === undefined) return
    void directory.load().catch(() => { /* the picker's own error row is the retry surface */ })
  }, [directory])
  return { ...directory === undefined ? {} : { directory }, ...state === undefined ? {} : { state } }
}

function noopSubscribe(): () => void {
  return () => {}
}

/**
 * Join the session's `permissions` projection (the selection) with the
 * permission-preset catalog (the rows). Every partial is legal and must not
 * throw: an absent selection means this host projects no boundary; an absent
 * catalog means there are no rows to offer. Nothing here may throw — the caller
 * renders inside a slot entry whose crash ABIDATES the whole picker.
 */
export function joinPermissionSelect(
  selection: unknown,
  catalog: AcpPermissionCatalog | undefined,
): AcpPermissionSelect | undefined {
  const currentValue = (selection as AcpPermissionSelection | null | undefined)?.currentValue
  if (typeof currentValue !== 'string') return undefined
  const raw = Array.isArray(catalog?.options) ? catalog.options : []
  const options = raw.filter((option): option is AcpPermissionOption =>
    typeof option?.value === 'string' && typeof option?.name === 'string')
  return { options, currentValue }
}

// The permission catalog is PROCESS-level (one table for every session) and its
// read is a remote round-trip: one fetch per page, fanned out to every picker.
let permissionCatalogCache: AcpPermissionCatalog | undefined
let permissionCatalogPending = false
const permissionCatalogListeners = new Set<() => void>()

function ensurePermissionCatalog(permissionCatalogFor: AcpPermissionCatalogResolver | undefined): void {
  if (permissionCatalogFor === undefined || permissionCatalogCache !== undefined || permissionCatalogPending) return
  let pending: Promise<AcpPermissionCatalog | undefined> | undefined
  try {
    pending = permissionCatalogFor()
  } catch {
    return
  }
  if (pending === undefined) return
  permissionCatalogPending = true
  void Promise.resolve(pending)
    .then((catalog) => {
      if (Array.isArray(catalog?.options)) permissionCatalogCache = catalog
    })
    .catch(() => { /* no catalog: the picker simply offers no rows to switch to */ })
    .finally(() => {
      permissionCatalogPending = false
      for (const listener of [...permissionCatalogListeners]) listener()
    })
}

/**
 * Read one session's DSH Access mode for the pickers: the `permissions`
 * projection carries the selection (`{ currentValue }`), and the rows come from
 * the process-level `permissionPresets.catalog` — joined by
 * `joinPermissionSelect` because the projection alone cannot list them.
 */
export function usePermissionSelect(
  faceFor: AcpChatInjected['faceFor'],
  sessionId: string,
  permissionCatalogFor?: AcpPermissionCatalogResolver,
): AcpPermissionSelect | undefined {
  const face = useMemo(() => {
    try {
      return faceFor(sessionId)
    } catch {
      return undefined
    }
  }, [faceFor, sessionId])
  const subscribe = useMemo(() => (cb: () => void): (() => void) => {
    try {
      return face?.projections.faceOf('permissions').subscribe(cb) ?? noopSubscribe
    } catch {
      return noopSubscribe
    }
  }, [face])
  const getState = useMemo((): (() => AcpPermissionSelection | undefined) => () => {
    try {
      return face?.projections.faceOf('permissions').getSnapshot() as AcpPermissionSelection | undefined
    } catch {
      return undefined
    }
  }, [face])
  const selection = useSyncExternalStore(subscribe, getState)
  const [catalog, setCatalog] = useState<AcpPermissionCatalog | undefined>(permissionCatalogCache)
  useEffect(() => {
    ensurePermissionCatalog(permissionCatalogFor)
    const listener = (): void => { setCatalog(permissionCatalogCache) }
    permissionCatalogListeners.add(listener)
    listener()
    return () => { permissionCatalogListeners.delete(listener) }
  }, [permissionCatalogFor])
  return useMemo(() => joinPermissionSelect(selection, catalog), [selection, catalog])
}

// ---- The ACP-mode model seat (shadowing the native one) ----

/**
 * The ACP agent preset's id. THREE places must agree on it (no type system
 * spans them): the declaration's `config.id` in `presets/acp/acp.patch.yml`
 * (this bundle's own patch, carried by package.json `dsh.bundle.patch` — no
 * install step), the host half's `ACP_PRESET_ID` (`src/bridge.ts`), and this
 * constant (the browser cannot read the host plane). `acp` is the value the
 * session list reports for an ACP-mode session and the same string the host's
 * own `sessionAgentPreset` resolver reads back from the session log.
 */
export const ACP_PRESET_ID = 'acp'

/**
 * The bits of the client session list the seat gate reads.
 *
 * Structural on purpose: the client runtime package is not a dependency of
 * this bundle, so the list is resolved as a plain observable at call time and
 * an unexpected shape simply reads as "no ACP session" — which leaves the
 * native seat exactly where it was.
 *
 * TWO SHAPES ship in the wild. DSH 0.1.7-rc.2's session controller
 * (`dsh-api-session-controller`) builds `{ ids, byId, phase,
 * projectionsBySession }` with NO `current` field at all — the staged session
 * is the row whose `retainedBy.mainView` count is positive (the same rule
 * `dsh-client-ui-session` uses to pick its main view), and the session's
 * preset rides `projectionValues.agentPreset` (folded from the
 * `agent-preset/selected` log event; the value is the preset's `id`).
 * Older runtimes carried a literal `current` plus a top-level `agentPreset`
 * on the row and a `currentAddress` marker for addressed subagent routes.
 */
export interface AcpSessionsSnapshot {
  /** Old runtimes only: the currently selected session id. */
  current?: string
  /** Old runtimes only: set when the current route is an addressed subagent session. */
  currentAddress?: unknown
  /** List rows by session id (both runtime shapes). */
  byId?: Record<string, AcpSessionsRow | undefined>
  /**
   * rc.2 shape: row ids in display order. Preferred over the `byId` key order
   * when picking the staged row, so a multi-view list cannot hand the seat to
   * whichever session happened to be inserted first.
   */
  ids?: readonly string[]
  phase?: string
}

/** One session-list row, narrowed to what the gate reads (both shapes). */
export interface AcpSessionsRow {
  id?: string
  /** Old runtimes: the preset at the top level. */
  agentPreset?: string
  /** rc.2: session projections, `agentPreset` among them. */
  projectionValues?: { agentPreset?: string } | undefined
  /** rc.2: per-surface retain counts; `mainView > 0` marks the staged session. */
  retainedBy?: { mainView?: number } | undefined
  /** rc.2: `"subagent"` marks addressed subagent rows. */
  origin?: string
}

/**
 * The preset the row records, under either runtime spelling. `undefined` means
 * the row is silent (projections not loaded yet, or a runtime without presets)
 * — never "definitely not ACP".
 */
export function rowAgentPreset(row: AcpSessionsRow | undefined): string | undefined {
  return row?.agentPreset ?? row?.projectionValues?.agentPreset
}

/** The session the composer is staged on, derived per runtime shape. */
export interface AcpStagedSession {
  sessionId: string
  row?: AcpSessionsRow
  /** Addressed subagent route: its model RPCs are refused, so the seat stands down. */
  subagent: boolean
}

/**
 * Which session the composer is currently staged on.
 *
 * Old runtimes answer from `snapshot.current` (with `currentAddress` as the
 * subagent marker). rc.2 has no `current`: the staged session is the row the
 * main view retains (`retainedBy.mainView > 0`) — the exact rule
 * `dsh-client-ui-session` applies, walked in the list's own `ids` order — and a
 * row with `origin === "subagent"` is an addressed subagent route. `undefined`
 * when nothing is staged yet (the list has not loaded, or no row holds the main
 * view): callers must stand down rather than guess.
 */
export function stagedSessionOf(snapshot: AcpSessionsSnapshot | undefined): AcpStagedSession | undefined {
  if (snapshot === undefined) return undefined
  if (snapshot.current !== undefined) {
    return {
      sessionId: snapshot.current,
      row: snapshot.byId?.[snapshot.current],
      subagent: snapshot.currentAddress !== undefined,
    }
  }
  const byId = snapshot.byId ?? {}
  const sessionId = (snapshot.ids ?? Object.keys(byId)).find(
    id => (byId[id]?.retainedBy?.mainView ?? 0) > 0,
  )
  if (sessionId === undefined) return undefined
  const row = byId[sessionId]
  return { sessionId, row, subagent: row?.origin === 'subagent' }
}

/**
 * Whether the composer's model seat must be taken over by the ACP seat: the
 * current session runs the ACP agent preset, and it is an ordinary session (an
 * addressed subagent route gets no ACP seat — its model RPCs are refused).
 *
 * FACT SOURCES, in order: the client runtime's session row (`agentPreset`
 * top-level on older runtimes, `projectionValues.agentPreset` on rc.2, folded
 * from the host's `agent-preset/selected` frames) — and, when the row carries
 * no preset, the plugin's own host-side report (`AcpStore.acpMode`, read from
 * the same session log the host's `sessionAgentPreset` resolver reads). Neither
 * source alone covers every deployment, and a false from an ABSENT field must
 * not read as "definitely not ACP", which is why the fallback exists.
 */
export function shouldShadowModelSeat(
  snapshot: AcpSessionsSnapshot | undefined,
  acpMode?: (sessionId: string) => boolean | undefined,
): boolean {
  const staged = stagedSessionOf(snapshot)
  if (staged === undefined || staged.subagent) return false
  const listed = rowAgentPreset(staged.row)
  if (listed !== undefined) return listed === ACP_PRESET_ID
  return acpMode?.(staged.sessionId) === true
}

/**
 * The ACP-mode verdict a committed `agent-preset/selected` frame carries. The
 * frame is `[sessionId, agentPreset]` and the runtime broadcasts it the moment
 * a switch commits — before the appended session-log row is visible to a fresh
 * `session/chat-list` cold read, so re-reading the log from that frame folds the
 * PREVIOUS preset and the seat would lag one switch behind until a reload.
 * The frame's own preset is therefore the live path's fact source; the host read
 * only seeds a session this tab has never seen a frame for.
 */
export function acpModeFromPresetEvent(agentPreset: unknown): boolean {
  return agentPreset === ACP_PRESET_ID
}

/** The session list store as this bundle reads it (structural, see {@link AcpSessionsSnapshot}). */
export interface SessionListSource {
  getSnapshot(): AcpSessionsSnapshot | undefined
  subscribe(listener: () => void): () => void
}

let seatActive = false
const seatListeners = new Set<() => void>()

/**
 * Record whether this plugin currently occupies the composer's model seat. The
 * composer cluster reads it to stand down: with the seat live, its own
 * agent/model/effort chips would be a second copy of the same three controls in
 * one tool row.
 */
export function setAcpSeatActive(active: boolean): void {
  if (seatActive === active) return
  seatActive = active
  for (const listener of [...seatListeners]) listener()
}

/** Subscribe to the seat-occupancy flag. */
export function useAcpSeatActive(): boolean {
  return useSyncExternalStore(
    cb => {
      seatListeners.add(cb)
      return () => { seatListeners.delete(cb) }
    },
    () => seatActive,
  )
}

// ---- The one open menu (composer overlay slot) ----

/** Which picker the composer overlay is showing (`seat` = the ACP-mode model seat). */
export type AcpMenuKind = 'agent' | 'model' | 'thought' | 'boundary' | 'seat'

interface MenuState {
  sessionId: string
  kind: AcpMenuKind
  /** The control that opened the picker; the popup docks to it. */
  trigger?: HTMLElement
  /** Last pick failure, rendered inside the open picker (its own retry surface). */
  error?: string
}

let menuState: MenuState | null = null
const menuListeners = new Set<() => void>()

function emitMenu(): void {
  for (const listener of [...menuListeners]) listener()
}

/** Toggle-style open: pressing the same chip twice closes its menu. */
export function openAcpMenu(sessionId: string, kind: AcpMenuKind, trigger?: HTMLElement): void {
  menuState = menuState !== null && menuState.sessionId === sessionId && menuState.kind === kind
    ? null
    : { sessionId, kind, ...trigger === undefined ? {} : { trigger } }
  emitMenu()
}

/** Close whatever picker is open (Escape, pick, outside pointer). */
export function closeAcpMenu(): void {
  if (menuState === null) return
  menuState = null
  emitMenu()
}

/**
 * Report a pick failure inside the open picker. The menu stays open on
 * purpose: a failed switch must not leave the user staring at a closed chip
 * with no idea whether it took effect.
 */
export function setAcpMenuError(error?: string): void {
  if (menuState === null) return
  menuState = { ...menuState, ...(error === undefined ? { error: undefined } : { error }) }
  emitMenu()
}

/** Subscribe to the open-picker state (both the chips and the overlay read it). */
export function useAcpMenu(): MenuState | null {
  return useSyncExternalStore(
    cb => {
      menuListeners.add(cb)
      return () => { menuListeners.delete(cb) }
    },
    () => menuState,
  )
}

// ---- Menu presentation ----

/** One selectable row of a picker. */
export interface AcpMenuItem {
  id: string
  label: string
  detail?: string
  /** Current value (rendered with the accent + a check). */
  active?: boolean
  disabled?: boolean
  /** Leading status dot color (agent process state). */
  dot?: string
}

/** One titled block of rows. */
export interface AcpMenuSection {
  id: string
  title?: string
  note?: string
  items: readonly AcpMenuItem[]
}

/** Props of the picker shell rendered into `conversation.input.overlay`. */
export interface AcpMenuProps {
  /** Menu model; `undefined` renders nothing (closed). */
  model?: {
    title: string
    note?: string
    sections: readonly AcpMenuSection[]
    error?: string
    loading?: boolean
  }
  /** The control that opened the menu; the popup docks above it (see `placeMenu`). */
  anchor?: HTMLElement | null
  onPick(itemId: string, sectionId: string): void
  onClose(): void
}

/**
 * Pure popup placement, viewport coordinates: the menu docks with its right
 * edge under the trigger's, `gap`px above it — and only then clamps to the
 * viewport (flip below when the top has no room, slide left at the right edge).
 * Separated from the DOM measurement so the geometry stays testable.
 */
export function placeMenu(
  trigger: { left: number; right: number; top: number; bottom: number },
  menu: { width: number; height: number },
  viewport: { width: number; height: number },
  gap = 8,
): { x: number; y: number } {
  const x = Math.min(
    Math.max(gap, trigger.right - menu.width),
    Math.max(gap, viewport.width - menu.width - gap),
  )
  const above = trigger.top - menu.height - gap
  let y = above >= gap ? above : trigger.bottom + gap
  if (y + menu.height > viewport.height - gap) {
    y = Math.max(gap, viewport.height - menu.height - gap)
  }
  return { x, y }
}

/**
 * The picker shell. It rides the composer's overlay anchor (the card's top
 * edge) — the seat the platform reserves for menus, so the popup is never
 * clipped by the card's own scrollport — and then docks itself to the control
 * that opened it (`anchor`): the seat or a chip is a dropdown trigger, and a
 * menu that materializes elsewhere on the card reads as "nothing happened".
 */
export function AcpMenu({ model, anchor, onPick, onClose }: AcpMenuProps) {
  const rootRef = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const node = rootRef.current
    if (node === null || model === undefined) return
    const place = (): void => {
      try {
        if (anchor === undefined || anchor === null || !anchor.isConnected) {
          node.style.transform = ''
          return
        }
        const menuRect = node.getBoundingClientRect()
        const triggerRect = anchor.getBoundingClientRect()
        const { x, y } = placeMenu(
          triggerRect,
          menuRect,
          { width: window.innerWidth, height: window.innerHeight },
        )
        // Translate from wherever CSS parked the popup: the offset parent is
        // the platform's zero-height overlay anchor, so plain left/top would
        // need its exact geometry — measuring the delta needs none.
        node.style.transform = 'none'
        const base = node.getBoundingClientRect()
        node.style.transform = `translate(${x - base.left}px, ${y - base.top}px)`
      } catch { /* placement must never break the menu */ }
    }
    place()
    window.addEventListener('resize', place)
    return () => { window.removeEventListener('resize', place) }
  }, [model, anchor])
  useEffect(() => {
    if (model === undefined) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        onClose()
      }
    }
    const onPointerDown = (event: PointerEvent): void => {
      if (!(event.target instanceof Node)) return
      if (rootRef.current?.contains(event.target)) return
      // Clicking the composer card itself must not close the menu (the chips
      // live there); everything else outside does.
      if (rootRef.current?.closest('[data-composer-card]')?.contains(event.target) === true) return
      onClose()
    }
    document.addEventListener('keydown', onKey, true)
    document.addEventListener('pointerdown', onPointerDown, true)
    return () => {
      document.removeEventListener('keydown', onKey, true)
      document.removeEventListener('pointerdown', onPointerDown, true)
    }
  }, [model, onClose])

  if (model === undefined) return null
  return (
    <div ref={rootRef} className="ntr-acp-menu" role="menu" aria-label={model.title}>
      <div className="ntr-acp-menu-head">
        <span className="ntr-acp-menu-title">{model.title}</span>
        {model.loading && <span className="ntr-acp-menu-spin" aria-hidden>…</span>}
      </div>
      {model.note !== undefined && <div className="ntr-acp-menu-note">{model.note}</div>}
      {model.error !== undefined && <div className="ntr-acp-menu-error">{model.error}</div>}
      <div className="ntr-acp-menu-body">
        {model.sections.map(section => (
          <div key={section.id} className="ntr-acp-menu-section">
            {section.title !== undefined && <div className="ntr-acp-menu-section-title">{section.title}</div>}
            {section.note !== undefined && <div className="ntr-acp-menu-note">{section.note}</div>}
            {section.items.map(item => (
              <button
                key={`${section.id}/${item.id}`}
                type="button"
                role="menuitemradio"
                aria-checked={item.active === true}
                className={`ntr-acp-menu-item${item.active === true ? ' is-active' : ''}`}
                disabled={item.disabled === true}
                onClick={() => { onPick(item.id, section.id) }}
              >
                {item.dot !== undefined && <span className="ntr-acp-dot" style={{ background: item.dot }} aria-hidden />}
                <span className="ntr-acp-menu-item-label">{item.label}</span>
                {item.active === true && <span className="ntr-acp-tick" aria-hidden>✓</span>}
                {item.detail !== undefined && <span className="ntr-acp-menu-item-detail">{item.detail}</span>}
              </button>
            ))}
          </div>
        ))}
        {model.sections.every(section => section.items.length === 0) && (
          <div className="ntr-acp-menu-empty">—</div>
        )}
      </div>
    </div>
  )
}

// ---- Chips ----

/** One composer chip (the trigger of a picker). */
export function AcpChip(props: {
  label: string
  title?: string
  active?: boolean
  onClick: (trigger: HTMLElement) => void
  children?: ReactNode
  style?: CSSProperties
}) {
  return (
    <button
      type="button"
      className={`ntr-acp-chip${props.active === true ? ' is-active' : ''}`}
      title={props.title}
      aria-haspopup="menu"
      onClick={(event) => { props.onClick(event.currentTarget) }}
      style={props.style}
    >
      {props.children}
      <span className="ntr-acp-chip-label">{props.label}</span>
      <span className="ntr-acp-caret" aria-hidden>▾</span>
    </button>
  )
}

// ---- Styles ----

const STYLE = `
.ntr-acp-cluster { display: inline-flex; align-items: center; gap: 6px; min-width: 0; }
.ntr-acp-chip { display: inline-flex; align-items: center; gap: 5px; max-width: 220px; font: inherit; font-size: 12px; line-height: 1.4; padding: 3px 8px; border-radius: 999px; border: 1px solid var(--dsw-alias-border-l2, #d1d5db); background: var(--dsw-alias-bg-layer-2, #f3f4f6); color: inherit; cursor: pointer; }
.ntr-acp-chip:hover { background: var(--dsw-alias-interactive-bg-active, #0000000d); }
.ntr-acp-chip.is-active { border-color: var(--dsw-alias-state-business-primary, #2563eb); color: var(--dsw-alias-state-business-primary, #2563eb); background: color-mix(in srgb, var(--dsw-alias-state-business-primary, #2563eb) 10%, transparent); }
.ntr-acp-chip-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ntr-acp-caret { opacity: 0.6; font-size: 10px; }
.ntr-acp-seat { display: inline-flex; align-items: center; gap: 6px; max-width: 260px; font: inherit; font-size: 12px; line-height: 1.4; padding: 4px 10px; border-radius: 999px; border: 1px solid var(--dsw-alias-border-l2, #d1d5db); background: var(--dsw-alias-bg-layer-2, #f3f4f6); color: inherit; cursor: pointer; }
.ntr-acp-seat:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-active, #0000000d); }
.ntr-acp-seat:disabled { opacity: 0.5; cursor: default; }
.ntr-acp-seat.is-open { border-color: var(--dsw-alias-state-business-primary, #2563eb); color: var(--dsw-alias-state-business-primary, #2563eb); }
.ntr-acp-seat.is-detached { border-color: var(--ntr-warn, #d97706); color: var(--ntr-warn, #d97706); }
.ntr-acp-seat-main { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ntr-acp-seat-sub { color: var(--dsw-alias-text-secondary, #6b7280); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ntr-acp-dot { width: 7px; height: 7px; border-radius: 50%; flex: none; }
.ntr-acp-tick { margin-left: auto; color: var(--dsw-alias-state-business-primary, #2563eb); }
.ntr-acp-menu { position: absolute; bottom: calc(100% + 8px); left: 8px; z-index: 100; width: min(360px, 100%); max-height: min(420px, 60vh); display: flex; flex-direction: column; border: 1px solid var(--dsw-alias-border-l2, #d1d5db); border-radius: 10px; background: var(--dsw-alias-bg-layer-1, #fff); box-shadow: 0 12px 32px rgba(0, 0, 0, 0.16); font-size: 12px; overflow: hidden; }
.ntr-acp-menu-head { padding: 8px 10px 6px; font-weight: 600; display: flex; align-items: center; gap: 6px; }
.ntr-acp-menu-title { flex: 1; }
.ntr-acp-menu-spin { opacity: 0.5; }
.ntr-acp-menu-note { padding: 0 10px 6px; font-size: 11px; color: var(--dsw-alias-text-secondary, #6b7280); line-height: 1.5; }
.ntr-acp-menu-error { margin: 0 10px 6px; padding: 6px 8px; border-radius: 6px; background: #fee2e2; color: #b91c1c; font-size: 11px; }
.ntr-acp-menu-body { overflow: auto; padding: 0 4px 6px; }
.ntr-acp-menu-section { display: flex; flex-direction: column; padding-top: 4px; }
.ntr-acp-menu-section-title { padding: 6px 8px 4px; font-size: 10px; letter-spacing: 0.04em; text-transform: uppercase; color: var(--dsw-alias-text-secondary, #6b7280); }
.ntr-acp-menu-item { display: flex; align-items: center; gap: 6px; font: inherit; font-size: 12px; text-align: left; padding: 6px 8px; border: none; border-radius: 6px; background: none; color: inherit; cursor: pointer; width: 100%; }
.ntr-acp-menu-item:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-active, #0000000d); }
.ntr-acp-menu-item:disabled { opacity: 0.45; cursor: default; }
.ntr-acp-menu-item.is-active { font-weight: 600; }
.ntr-acp-menu-item-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ntr-acp-menu-item-detail { color: var(--dsw-alias-text-secondary, #6b7280); font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; text-align: right; }
.ntr-acp-menu-empty { padding: 10px; text-align: center; color: var(--dsw-alias-text-secondary, #6b7280); }
/* ---- ACP view tab ---- */
.ntr-acp-view { display: flex; flex-direction: column; height: 100%; min-height: 0; font-size: 13px; line-height: 1.6; }
.ntr-acp-view-head { display: flex; align-items: center; gap: 8px; padding: 8px 12px; border-bottom: 1px solid var(--dsw-alias-border-l2, #e5e7eb); font-size: 12px; color: var(--dsw-alias-text-secondary, #6b7280); }
.ntr-acp-view-agent { font-weight: 600; color: inherit; }
.ntr-acp-view-meta { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 40%; direction: rtl; text-align: left; }
.ntr-acp-view-head .ntr-acp-more { margin-left: auto; }
.ntr-acp-stream { flex: 1; min-height: 0; overflow: auto; padding: 12px 14px 24px; display: flex; flex-direction: column; gap: 10px; }
.ntr-acp-badge { font-size: 11px; padding: 1px 8px; border-radius: 999px; border: 1px solid transparent; }
.ntr-acp-badge.is-done { color: #15803d; background: #dcfce7; }
.ntr-acp-badge.is-busy { color: #1d4ed8; background: #dbeafe; }
.ntr-acp-badge.is-warn { color: #b45309; background: #fef3c7; }
.ntr-acp-badge.is-fail { color: #b91c1c; background: #fee2e2; }
.ntr-acp-badge.is-idle { color: var(--dsw-alias-text-secondary, #6b7280); background: var(--dsw-alias-bg-layer-2, #f3f4f6); }
.ntr-acp-bubble { max-width: 88%; padding: 8px 12px; border-radius: 12px; white-space: pre-wrap; word-break: break-word; }
.ntr-acp-bubble.is-user { align-self: flex-end; background: color-mix(in srgb, var(--dsw-alias-state-business-primary, #2563eb) 12%, transparent); }
.ntr-acp-bubble.is-agent { align-self: flex-start; background: var(--dsw-alias-bg-layer-2, #f3f4f6); }
.ntr-acp-inline-code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; padding: 1px 4px; border-radius: 4px; background: color-mix(in srgb, currentColor 10%, transparent); }
.ntr-acp-code { margin: 6px 0; padding: 8px 10px; border-radius: 8px; background: #0f172a; color: #e2e8f0; overflow: auto; font-size: 12px; line-height: 1.5; }
.ntr-acp-thought { border-left: 3px solid var(--dsw-alias-border-l2, #d1d5db); padding-left: 8px; color: var(--dsw-alias-text-secondary, #6b7280); font-size: 12px; }
.ntr-acp-thought > summary { cursor: pointer; font-size: 11px; letter-spacing: 0.04em; text-transform: uppercase; }
.ntr-acp-thought-body { white-space: pre-wrap; padding: 4px 0 2px; }
.ntr-acp-tool { border: 1px solid var(--dsw-alias-border-l2, #e5e7eb); border-radius: 10px; background: var(--dsw-alias-bg-layer-1, #fff); overflow: hidden; }
.ntr-acp-tool.is-fail { border-color: #fca5a5; }
.ntr-acp-tool-head { display: flex; align-items: center; gap: 8px; padding: 7px 10px; font-size: 12px; }
.ntr-acp-tool-title { flex: 1; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ntr-acp-tool-body { margin: 0; padding: 8px 10px; border-top: 1px solid var(--dsw-alias-border-l2, #e5e7eb); background: var(--dsw-alias-bg-layer-2, #f9fafb); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11.5px; line-height: 1.55; white-space: pre-wrap; word-break: break-word; max-height: 340px; overflow: auto; }
.ntr-acp-diff { border-top: 1px solid var(--dsw-alias-border-l2, #e5e7eb); }
.ntr-acp-diff-head { display: flex; align-items: center; gap: 8px; padding: 5px 10px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11.5px; background: var(--dsw-alias-bg-layer-2, #f9fafb); }
.ntr-acp-diff-path { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ntr-acp-diff-stats .is-add { color: #15803d; }
.ntr-acp-diff-stats .is-del { color: #b91c1c; }
.ntr-acp-diff-body { max-height: 360px; overflow: auto; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11.5px; line-height: 1.55; }
.ntr-acp-diff-row { display: flex; gap: 8px; padding: 0 10px; white-space: pre; }
.ntr-acp-diff-row.is-add { background: #dcfce7; }
.ntr-acp-diff-row.is-del { background: #fee2e2; }
.ntr-acp-diff-row.is-ctx { color: var(--dsw-alias-text-secondary, #6b7280); }
.ntr-acp-diff-sign { width: 1ch; flex: none; opacity: 0.7; }
.ntr-acp-diff-text { overflow-x: auto; }
.ntr-acp-diff-note { padding: 4px 10px 6px; font-size: 11px; color: var(--dsw-alias-text-secondary, #6b7280); }
.ntr-acp-more { font: inherit; font-size: 11.5px; padding: 3px 10px; border-radius: 6px; border: 1px solid var(--dsw-alias-border-l2, #d1d5db); background: var(--dsw-alias-bg-layer-2, #f3f4f6); color: inherit; cursor: pointer; }
.ntr-acp-more:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-active, #0000000d); }
.ntr-acp-more:disabled { opacity: 0.5; cursor: default; }
.ntr-acp-more.is-primary { border-color: transparent; background: var(--dsw-alias-button-primary-fill, #2563eb); color: var(--dsw-alias-button-primary-invert, #fff); }
.ntr-acp-tool > .ntr-acp-more, .ntr-acp-empty-actions .ntr-acp-more { margin: 6px 10px; }
.ntr-acp-plan { border: 1px solid var(--dsw-alias-border-l2, #e5e7eb); border-radius: 10px; padding: 8px 10px; background: var(--dsw-alias-bg-layer-1, #fff); }
.ntr-acp-plan-head { font-size: 11px; letter-spacing: 0.04em; text-transform: uppercase; color: var(--dsw-alias-text-secondary, #6b7280); margin-bottom: 4px; }
.ntr-acp-plan-row { display: flex; align-items: baseline; gap: 8px; font-size: 12.5px; padding: 1px 0; }
.ntr-acp-plan-row.is-completed { color: var(--dsw-alias-text-secondary, #6b7280); text-decoration: line-through; }
.ntr-acp-plan-row.is-in_progress { font-weight: 600; }
.ntr-acp-plan-glyph { width: 1ch; flex: none; }
.ntr-acp-plan-prio { margin-left: auto; font-size: 10px; text-transform: uppercase; color: var(--dsw-alias-text-secondary, #6b7280); }
.ntr-acp-notice { padding: 6px 10px; border-radius: 8px; font-size: 12px; }
.ntr-acp-notice.is-error { background: #fee2e2; color: #b91c1c; }
.ntr-acp-notice.is-info { background: var(--dsw-alias-bg-layer-2, #f3f4f6); color: var(--dsw-alias-text-secondary, #6b7280); }
.ntr-acp-empty { margin: auto; max-width: 460px; text-align: center; display: flex; flex-direction: column; gap: 10px; padding: 24px; }
.ntr-acp-empty-title { font-size: 14px; font-weight: 600; }
.ntr-acp-empty-body { margin: 0; color: var(--dsw-alias-text-secondary, #6b7280); font-size: 12.5px; line-height: 1.7; }
.ntr-acp-empty-hint { color: var(--dsw-alias-text-secondary, #6b7280); font-size: 12px; }
.ntr-acp-empty-actions { display: flex; flex-wrap: wrap; gap: 8px; justify-content: center; }
`

let styleMounted = false

/** Mount the shared stylesheet once (same pattern as the settings panel's). */
export function ensureAcpStyle(): void {
  if (styleMounted || typeof document === 'undefined') return
  styleMounted = true
  const node = document.createElement('style')
  node.textContent = STYLE
  document.head.appendChild(node)
}
