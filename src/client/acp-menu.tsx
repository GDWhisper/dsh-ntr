/**
 * The composer picker shell (`conversation.input.overlay`), split out of
 * `acp-ui.tsx` to stay within its size budget. It owns the popup's placement,
 * its dismissal gestures, and — for menus with more rows than a person can
 * scan — an in-menu search box. The list keeps every row and scrolls inside a
 * fixed-height body, so the scrollbar reaches the rows a query does not name.
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
  /**
   * Force the search box on regardless of row count. The model axis passes
   * this: even a narrowed list scrolls, and its rows are the ones people scan
   * for a name.
   */
  searchable?: boolean
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
 * above the list. Every row is rendered and the body scrolls; short menus keep
 * their previous appearance and behavior.
 */
export function AcpMenu({ model, anchor, searchable: forceSearch, onPick, onClose, label = browserLabel }: AcpMenuProps) {
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
  // `pinned` rows are fixed actions (e.g. "refresh the directory") and
  // `disabled` rows are status lines: neither drives the search threshold nor
  // `N items`.
  const selectableTotal = useMemo(
    () => sections.reduce(
      (count, section) => count + section.items.filter(item => item.pinned !== true && item.disabled !== true).length,
      0,
    ),
    [sections],
  )
  const showSearch = (forceSearch ?? selectableTotal > MENU_SEARCH_THRESHOLD) && selectableTotal > 0
  // `useMemo` deps are exactly the section list and the query: the filter is
  // pure, so a section only changes when one of them does.
  const view = useMemo(() => {
    const filtered = filterMenuSections(sections, query)
    const matching = filtered.reduce(
      (count, section) => count + section.items.filter(item => item.pinned !== true).length,
      0,
    )
    return { sections: filtered, matching }
  }, [sections, query])
  // The row Enter / ArrowDown starts from: the first enabled entry. Pinned
  // rows are fixed actions in the menu's action bar, never a pick target —
  // Enter must not fire "refresh the directory" on a query the user narrowed.
  const firstPick = useMemo(() => {
    for (const section of view.sections) {
      for (const item of section.items) {
        if (item.pinned !== true && item.disabled !== true) {
          return { item, sectionId: section.id }
        }
      }
    }
    return undefined
  }, [view])
  // Pinned rows are hoisted out of the list into the action bar above it: they
  // are commands about the list (e.g. "re-read the model list"), not entries.
  const pinnedActions = useMemo(() => {
    const out: { item: AcpMenuItem; sectionId: string }[] = []
    for (const section of view.sections) {
      for (const item of section.items) {
        if (item.pinned === true) out.push({ item, sectionId: section.id })
      }
    }
    return out
  }, [view])

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
    if (showSearch) searchRef.current?.focus()
  }, [open])

  // Shrinking below the threshold unmounts the box; a leftover query would
  // keep filtering the list with no visible way to clear it.
  useEffect(() => {
    if (!showSearch && queryRef.current !== '') setQueryValue('')
  }, [showSearch])

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
    : label(`匹配 ${view.matching} 项`, `${view.matching} matches`)
  // An empty list means no selectable rows; a menu with only pinned actions
  // still shows its action bar, not a placeholder row.
  const empty = view.sections.every(section => section.items.every(item => item.pinned === true))

  return (
    <div ref={rootRef} className="ntr-acp-menu">
      <div className="ntr-acp-menu-head">
        <span className="ntr-acp-menu-title">{model.title}</span>
        {model.loading && <span className="ntr-acp-menu-spin" aria-hidden>…</span>}
      </div>
      {showSearch && (
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
      {/* Outside the scrollport: the cap hint and the fixed actions must stay
          visible without scrolling. Neither present → no line at all. */}
      {(pinnedActions.length > 0 || showSearch) && (
        <div className="ntr-acp-menu-actions">
          {showSearch && <span className="ntr-acp-menu-hint">{hint}</span>}
          {pinnedActions.map(({ item, sectionId }) => (
            <button
              key={`${sectionId}/${item.id}`}
              type="button"
              className="ntr-acp-menu-action"
              disabled={item.disabled === true}
              title={item.detail}
              onClick={() => { onPick(item.id, sectionId) }}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
      <div ref={bodyRef} className="ntr-acp-menu-body" role="menu" aria-label={model.title} onKeyDown={onBodyKeyDown}>
        {view.sections.map(section => {
          // Pinned rows live in the action bar; a section left with none of
          // its own rows would only render a title over blank space.
          const visible = section.items.filter(item => item.pinned !== true)
          if (visible.length === 0) return null
          return (
            <div key={section.id} className="ntr-acp-menu-section">
              {section.title !== undefined && <div className="ntr-acp-menu-section-title">{section.title}</div>}
              {section.note !== undefined && <div className="ntr-acp-menu-note">{section.note}</div>}
              {visible.map(item => (
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
          )
        })}
        {query.trim() !== '' && view.matching === 0 && (
          <div className="ntr-acp-menu-empty">{label('没有匹配项', 'No matching items')}</div>
        )}
        {query.trim() === '' && empty && <div className="ntr-acp-menu-empty">—</div>}
      </div>
    </div>
  )
}
