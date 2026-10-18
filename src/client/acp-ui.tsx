/**
 * Shared browser-side kit for the ACP *conversation* surfaces: the composer
 * base (agent / model / thought level), its picker and the ACP view tab.
 *
 * Everything here is deliberately structural. The ACP plugin's client half may
 * not import the host runtime or any client package at runtime — the seats it
 * takes (`conversation.input.model`, `conversation.input.overlay`,
 * `conversation.view`) are declared by `dsh-client-ui-conversation`, and the
 * services it reads (`sessions`) are resolved by the entry in `index.tsx` and
 * handed over as plain functions. That is what keeps this bundle loadable in a
 * deployment that composes only a subset of the official client modules: an
 * absent service yields `undefined` and the surface hides itself instead of
 * breaking the plugin.
 *
 * NO MODEL DIRECTORY. This bundle used to read and write the host's per-session
 * model directory (`ctx.modelDirectories`) so an ACP agent could be expressed as
 * a route. That axis is retired: ACP is not a DSH provider, the route write
 * polluted the deployment default, and the GUI's catalog gate then refused the
 * plugin's own route with `session/model-unavailable`. The agent identity now
 * lives in this plugin's own state (`session/chat-list`), reached by its own
 * RPC — see docs/acp-convergence.md §2.2.
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
 * One model inside a provider group of the agent's OWN catalog (from
 * `agent/catalog`). Deliberately NOT DSH's model catalog: an ACP agent's models
 * are the agent's business, and DSH's directory has no per-session seam to
 * filter them with anyway (see the module header).
 */
export interface AcpModelEntry {
  id: string
  name: string
  description?: string
  reasoning?: { efforts: readonly AcpReasoningEffort[]; defaultEffort?: string }
}

/** One provider group inside an agent's own model catalog. */
export interface AcpModelGroup {
  id: string
  name: string
  models: readonly AcpModelEntry[]
}

/** The session's command + projection face (`SessionFace`), narrowed to what the cluster reads. */
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
  /** Resolve the session's command/projection face; `undefined` before the session materializes. */
  faceFor(sessionId: string): AcpSessionFace | undefined
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
 * Build `agentId` / `agentId@choice`; mirrors the host's `buildAdapterModelId`.
 *
 * The inverse of {@link splitAcpModelId}, and a hand copy for the same reason:
 * the browser half cannot import the host plane. Needed where the browser has a
 * bare choice value (the agent's own current model, as `agent/catalog` reports
 * it) and must compare it against adapter model ids.
 */
export function buildAcpModelId(agentId: string, choice?: string): string {
  return choice === undefined || choice === '' ? agentId : `${agentId}@${choice}`
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

// ---- The connection form's command line (hand copy of src/impl.ts) ----

/**
 * Hand copies of the host's `tokenizeCommandLine` / `splitCommandLine` /
 * `quoteCommandToken` (src/impl.ts). The 命令 field is ONE command line — the
 * whole thing a user would paste into a terminal — and the panel has to parse
 * it exactly the way `validateAgentDef` will, or the "程序 / 参数" preview under
 * the field would lie about what the host is about to run. Same discipline as
 * `splitAcpModelId`: browser half cannot import the host plane, so
 * tests/acp-view.spec.ts asserts equivalence on a shared sample set.
 */
export function tokenizeCommandLine(raw: string): string[] {
  const tokens: string[] = []
  let current = ''
  let quoted = false
  let touched = false
  let quote: '"' | "'" | undefined
  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index] as string
    if (quote !== undefined) {
      if (char === '\\' && quote === '"' && raw[index + 1] === '"') {
        current += '"'
        index += 1
        continue
      }
      if (char === quote) {
        quote = undefined
        continue
      }
      current += char
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      touched = true
      continue
    }
    if (char === ' ' || char === '\t' || char === '\n' || char === '\r') {
      if (touched || current !== '') tokens.push(current)
      current = ''
      touched = false
      continue
    }
    current += char
    touched = true
  }
  if (touched || current !== '') tokens.push(current)
  return tokens
}

/** First token = program, rest = arguments. Mirrors the host's `splitCommandLine`. */
export function splitCommandLine(raw: string): { command: string; args: string[] } {
  const tokens = tokenizeCommandLine(raw)
  return { command: tokens[0] ?? '', args: tokens.slice(1) }
}

/** Quote one token for a command line — only when it needs it. */
export function quoteCommandToken(token: string): string {
  if (token !== '' && !/[\s"']/.test(token)) return token
  return `"${token.replaceAll('"', '\\"')}"`
}

/** Join a parsed command back into the single editable field (round-trips through `splitCommandLine`). */
export function formatCommandLine(command: string, args: readonly string[] = []): string {
  return [command, ...args].map(quoteCommandToken).join(' ')
}

// ---- React bindings ----

/** Subscribe to the ACP store (the panel and every chat surface share this). */
export function useUi(acp: AcpStore): UiState {
  return useSyncExternalStore(cb => acp.subscribe(cb), () => acp.getSnapshot())
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
 * The bits of the client session list this plugin reads.
 *
 * Structural on purpose: the client runtime package is not a dependency of
 * this bundle, so the list is resolved as a plain observable at call time and
 * an unexpected shape simply reads as "no ACP session" — which leaves every ACP
 * surface hidden rather than broken.
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
   * rc.2 shape: row ids in display order. A TIE-BREAK hint, never the
   * candidate set: `byId` is a superset of `ids` (the session controller adds
   * catalog-only and retained-scope rows to `byId` without giving them an
   * `ids` entry), so walking `ids` alone can miss the row the main view
   * actually retains. See {@link stagedSessionOf}.
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
  /** Addressed subagent route: it is not a conversation this plugin may drive. */
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
  // Candidate set is `byId`, NOT `ids`. In rc.2 the controller projects
  // `ids` from the host list only, then appends two fallback families to
  // `byId` without an `ids` entry: subagent-catalog children of a projected
  // parent, and live retained scopes carrying a subagent address. A retained
  // scope of either family can be the row holding the main view, so an
  // `ids`-only walk would report "nothing is staged" and every ACP surface
  // (this gate included) would stand down on a real ACP conversation.
  //
  // `ids` still matters: it is the display order, so when several rows retain
  // the main view (multi-view layouts) the one the list shows first wins —
  // the same row `dsh-client-ui-session` puts on screen. Everything outside
  // `ids` sorts last, in `byId` key order.
  const order = new Map<string, number>()
  for (const [index, id] of (snapshot.ids ?? []).entries()) order.set(id, index)
  const rank = (id: string): number => order.get(id) ?? Number.MAX_SAFE_INTEGER
  const candidates = Object.keys(byId).sort((a, b) => rank(a) - rank(b))
  const sessionId = candidates.find(id => (byId[id]?.retainedBy?.mainView ?? 0) > 0)
  if (sessionId === undefined) return undefined
  const row = byId[sessionId]
  return { sessionId, row, subagent: row?.origin === 'subagent' }
}

/** Whether the staged session runs the ACP agent preset. */
export function stagedIsAcpMode(
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
 * PREVIOUS preset and the surface would lag one switch behind until a reload.
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

// ---- The one open menu (composer overlay slot) ----

/** Which picker the composer overlay is showing. */
export type AcpMenuKind = 'agent' | 'model' | 'thought'

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
.ntr-acp-cluster { display: inline-flex; align-items: center; gap: 6px; min-width: 0; max-width: 100%; flex-wrap: nowrap; }
/* The agent base is the cluster's fixed right-hand anchor: it never shrinks
   below its own label, while the agent-published chips to its left absorb the
   squeeze. Without this a long model name could compress the base instead,
   which is the same "it moved" symptom as reordering it was meant to fix. */
.ntr-acp-cluster > .ntr-acp-chip:last-child { flex: none; }
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
.ntr-acp-seat-diag { font-family: var(--dsw-alias-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace); opacity: 0.72; word-break: break-word; }
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
