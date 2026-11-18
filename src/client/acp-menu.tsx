/**
 * The composer picker shell (`conversation.input.overlay`), split out of
 * `acp-ui.tsx` to stay within its size budget. It owns the popup's placement,
 * its dismissal gestures, and — for menus with more rows than a person can
 * scan — an in-menu search box with a bounded render window.
 *
 * The module is deliberately store-free: it imports only TYPES from
 * `acp-ui.tsx`, so `acp-ui.tsx` can re-export `AcpMenu` as a value without a
 * runtime import cycle. Bilingual copy arrives through the optional `label`
 * prop (the caller passes `acp.label`); the default resolves against the
 * browser locale so a bare mount (tests, a host without the locale service)
 * still renders one language.
 */

import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { AcpMenuItem, AcpMenuSection } from './acp-ui.tsx'

/** Row count above which the picker grows its search box. */
export const MENU_SEARCH_THRESHOLD = 30

/** Maximum rows the picker renders at once (pinned rows may push it higher). */
export const MENU_CAP = 40

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
  /** Bilingual resolver (`acp.label`); the browser locale is the fallback. */
  label?: (zh: string, en: string) => string
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

/** Case-insensitive substring match against the fields a picker row shows. */
function matches(item: AcpMenuItem, needle: string): boolean {
  return item.label.toLowerCase().includes(needle)
    || (item.detail ?? '').toLowerCase().includes(needle)
    || item.id.toLowerCase().includes(needle)
}

/**
 * Keep the rows a query matches: every `pinned` row survives untouched and
 * takes no part in matching or counting; the other rows must match `label`,
 * `detail` or `id`. Sections left with nothing are dropped, and a blank query
 * returns the sections unchanged.
 */
export function filterMenuSections(
  sections: readonly AcpMenuSection[],
  query: string,
): readonly AcpMenuSection[] {
  const needle = query.trim().toLowerCase()
  if (needle === '') return sections
  const kept: AcpMenuSection[] = []
  for (const section of sections) {
    const items = section.items.filter(item => item.pinned === true || matches(item, needle))
    if (items.length === 0) continue
    kept.push({ ...section, items })
  }
  return kept
}

/** The render window after capping, plus the counts the hint line needs. */
export interface CappedMenuSections {
  sections: readonly AcpMenuSection[]
  /** Rows in the input sections. */
  total: number
  /** Rows actually rendered. */
  shown: number
  /** Rows left out by the cap. */
  hidden: number
}

/**
 * Bound the rows the picker paints. `pinned` and `active` rows lead the order
 * (pinned first), so they survive truncation when possible; a menu with more
 * active rows than the cap keeps all of them. With `pinnedFree`, pinned rows
 * are always kept and do not count against `cap` — the query mode, where the
 * `M more` hint speaks about matches alone.
 */
export function capMenuSections(
  sections: readonly AcpMenuSection[],
  cap: number = MENU_CAP,
  pinnedFree = false,
): CappedMenuSections {
  const rows: { section: number; item: number; value: AcpMenuItem }[] = []
  sections.forEach((section, sectionIndex) => {
    section.items.forEach((value, itemIndex) => { rows.push({ section: sectionIndex, item: itemIndex, value }) })
  })
  const rank = (item: AcpMenuItem): number => item.pinned === true ? 0 : item.active === true ? 1 : 2
  const ordered = rows
    .map((row, index) => ({ row, index }))
    .sort((a, b) => rank(a.row.value) - rank(b.row.value) || a.index - b.index)
  const pinned = rows.filter(row => row.value.pinned === true).length
  const priority = rows.filter(row => row.value.pinned === true || row.value.active === true).length
  const limit = pinnedFree ? pinned + Math.max(0, cap) : Math.max(cap, priority)
  const kept = new Set(ordered.slice(0, limit).map(entry => `${entry.row.section}:${entry.row.item}`))
  const out: AcpMenuSection[] = []
  sections.forEach((section, sectionIndex) => {
    const items = section.items.filter((_, itemIndex) => kept.has(`${sectionIndex}:${itemIndex}`))
    if (items.length > 0) out.push({ ...section, items })
  })
  return { sections: out, total: rows.length, shown: kept.size, hidden: rows.length - kept.size }
}

/** Browser-locale fallback for the shell's bilingual pairs. */
function browserLabel(zh: string, en: string): string {
  if (typeof navigator === 'undefined') return zh
  return /^zh\b/i.test(navigator.language) ? zh : en
}

const NO_SECTIONS: readonly AcpMenuSection[] = []

/**
 * The picker shell. It rides the composer's overlay anchor (the card's top
 * edge) — the seat the platform reserves for menus, so the popup is never
 * clipped by the card's own scrollport — and then docks itself to the control
 * that opened it (`anchor`): the seat or a chip is a dropdown trigger, and a
 * menu that materializes elsewhere on the card reads as "nothing happened".
 *
 * Long menus (more rows than {@link MENU_SEARCH_THRESHOLD}) grow a search box
 * above the list and paint at most {@link MENU_CAP} rows; short menus keep
 * their previous appearance and behavior.
 */
export function AcpMenu({ model, anchor, onPick, onClose, label = browserLabel }: AcpMenuProps) {
  const rootRef = useRef<HTMLDivElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const [query, setQuery] = useState('')
  const queryRef = useRef('')
  const didAutoFocus = useRef(false)
  const setQueryValue = (next: string): void => {
    queryRef.current = next
    setQuery(next)
  }
  const sections = model?.sections ?? NO_SECTIONS
  const open = model !== undefined
  // `pinned` rows are fixed actions (e.g. "refresh the directory"), not
  // selectable entries: they drive neither the search threshold nor `N items`.
  const selectableTotal = useMemo(
    () => sections.reduce(
      (count, section) => count + section.items.filter(item => item.pinned !== true).length,
      0,
    ),
    [sections],
  )
  const searchable = selectableTotal > MENU_SEARCH_THRESHOLD
  // `useMemo` deps are exactly the section list and the query: the filter and
  // the cap are pure, so the render window only moves when one of them does.
  const view = useMemo(() => {
    const filtered = filterMenuSections(sections, query)
    const capped = capMenuSections(filtered, MENU_CAP, query.trim() !== '')
    const matching = filtered.reduce(
      (count, section) => count + section.items.filter(item => item.pinned !== true).length,
      0,
    )
    return { ...capped, matching }
  }, [sections, query])
  // The row Enter / ArrowDown starts from: the first enabled row of the
  // RENDERED window, so truncated-away rows are never activated.
  const firstPick = useMemo(() => {
    const enabled: { item: AcpMenuItem; sectionId: string }[] = []
    for (const section of view.sections) {
      for (const item of section.items) {
        if (item.disabled !== true) enabled.push({ item, sectionId: section.id })
      }
    }
    // A query picks the first MATCH, never a pinned action that happens to sit
    // above it in the menu (e.g. "refresh the directory").
    if (query.trim() !== '') {
      const match = enabled.find(entry => entry.item.pinned !== true)
      if (match !== undefined) return match
    }
    return enabled[0]
  }, [view, query])

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
      if (event.key !== 'Escape') return
      // Two-stage Escape: clear the query first, close only on the second one.
      // A single branch, so a press can never both clear and close.
      event.stopPropagation()
      if (queryRef.current !== '') {
        event.preventDefault()
        setQueryValue('')
        searchRef.current?.focus()
        return
      }
      onClose()
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

  // Focus the box once per opening, not once per growth: a menu that crosses
  // the threshold while open (e.g. a directory refresh) must not steal the
  // caret from the control the user just used.
  useEffect(() => {
    if (!open) {
      didAutoFocus.current = false
      setQueryValue('')
      return
    }
    if (didAutoFocus.current) return
    didAutoFocus.current = true
    if (searchable) searchRef.current?.focus()
  }, [open])

  // Shrinking below the threshold unmounts the box; a leftover query would
  // keep filtering the list with no visible way to clear it.
  useEffect(() => {
    if (!searchable && queryRef.current !== '') setQueryValue('')
  }, [searchable])

  if (model === undefined) return null

  const onSearchKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'ArrowDown' && firstPick !== undefined) {
      event.preventDefault()
      bodyRef.current?.querySelector<HTMLButtonElement>('.ntr-acp-menu-item:not(:disabled)')?.focus()
      return
    }
    // Enter activates the first available row, except while an IME is composing.
    // With no match there is nothing to pick — never fall through to a pinned
    // row (e.g. "refresh"), which would fire on a query the user just narrowed.
    if (event.key === 'Enter' && event.nativeEvent.isComposing === false) {
      if (query.trim() !== '' && view.matching === 0) return
      if (firstPick === undefined) return
      event.preventDefault()
      onPick(firstPick.item.id, firstPick.sectionId)
    }
  }

  const onBodyKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    const target = event.target
    if (!(target instanceof HTMLElement) || !target.classList.contains('ntr-acp-menu-item')) return
    const buttons = Array.from(
      bodyRef.current?.querySelectorAll<HTMLButtonElement>('.ntr-acp-menu-item:not(:disabled)') ?? [],
    )
    const index = buttons.indexOf(target as HTMLButtonElement)
    if (index < 0) return
    event.preventDefault()
    if (event.key === 'ArrowDown') {
      buttons[(index + 1) % buttons.length]?.focus()
      return
    }
    if (index > 0) {
      buttons[index - 1]?.focus()
      return
    }
    // First row: back to the search box when there is one, else wrap.
    if (searchRef.current !== null) searchRef.current.focus()
    else buttons[buttons.length - 1]?.focus()
  }

  const hint = query.trim() === ''
    ? label(`共 ${selectableTotal} 项，输入关键词筛选`, `${selectableTotal} items — type to filter`)
    : label(`还有 ${view.hidden} 项，继续输入以缩小范围`, `${view.hidden} more — keep typing to narrow`)
  const empty = view.sections.length === 0

  return (
    <div ref={rootRef} className="ntr-acp-menu">
      <div className="ntr-acp-menu-head">
        <span className="ntr-acp-menu-title">{model.title}</span>
        {model.loading && <span className="ntr-acp-menu-spin" aria-hidden>…</span>}
      </div>
      {searchable && (
        <input
          ref={searchRef}
          type="search"
          className="ntr-acp-menu-search"
          aria-label={label('搜索菜单项', 'Search menu items')}
          placeholder={label('搜索…', 'Search…')}
          value={query}
          onChange={(event) => { setQueryValue(event.target.value) }}
          onKeyDown={onSearchKeyDown}
        />
      )}
      {model.note !== undefined && <div className="ntr-acp-menu-note">{model.note}</div>}
      {model.error !== undefined && <div className="ntr-acp-menu-error">{model.error}</div>}
      {/* Outside the scrollport: the cap hint must stay visible without scrolling. */}
      {view.hidden > 0 && <div className="ntr-acp-menu-hint">{hint}</div>}
      <div ref={bodyRef} className="ntr-acp-menu-body" role="menu" aria-label={model.title} onKeyDown={onBodyKeyDown}>
        {view.sections.map(section => (
          <div key={section.id} className="ntr-acp-menu-section">
            {section.title !== undefined && <div className="ntr-acp-menu-section-title">{section.title}</div>}
            {section.note !== undefined && <div className="ntr-acp-menu-note">{section.note}</div>}
            {section.items.map(item => (
              <button
                key={`${section.id}/${item.id}`}
                type="button"
                role={item.checkbox === true ? 'menuitemcheckbox' : 'menuitemradio'}
                aria-checked={item.active === true}
                className={`ntr-acp-menu-item${item.active === true ? ' is-active' : ''}`}
                disabled={item.disabled === true}
                onClick={() => { onPick(item.id, section.id) }}
              >
                {item.dot !== undefined && <span className="ntr-acp-dot" style={{ background: item.dot }} aria-hidden />}
                {item.checkbox === true && (
                  <span className={`ntr-acp-check${item.active === true ? ' is-on' : ''}`} aria-hidden>{item.active === true ? '✓' : ''}</span>
                )}
                <span className="ntr-acp-menu-item-label">{item.label}</span>
                {item.active === true && item.checkbox !== true && <span className="ntr-acp-tick" aria-hidden>✓</span>}
                {item.detail !== undefined && <span className="ntr-acp-menu-item-detail">{item.detail}</span>}
              </button>
            ))}
          </div>
        ))}
        {query.trim() !== '' && view.matching === 0 && (
          <div className="ntr-acp-menu-empty">{label('没有匹配项', 'No matching items')}</div>
        )}
        {query.trim() === '' && empty && <div className="ntr-acp-menu-empty">—</div>}
      </div>
    </div>
  )
}
