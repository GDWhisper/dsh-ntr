/**
 * NTR settings navigation icon.
 *
 * The settings shell picks a section's nav glyph from a hardcoded if-chain
 * over the section id (`ui-settings-general`'s `navIcon`): only a few known
 * ids get a real glyph, everything else — including `acp-agents` — falls
 * back to a generic gear. The `settings.section` slot spec carries only
 * `{ id, order, label }`, so a registrant cannot supply an icon through the
 * contract. Swapping the glyph in the DOM is the only plugin-side route.
 *
 * Identity comes from the nav row's label text: the row button carries no
 * id attribute (React's `key` never reaches the DOM). Geometry and class are
 * copied off the gear so the shell's sizing (`.navIcon { flex: none }`) and
 * the `currentColor` nav tint keep working. Colors are never hardcoded here
 * (AGENTS.md constraint 34): the glyph inherits the shell's token-driven
 * color through `currentColor`, exactly as the gear did.
 *
 * The settings panel unmounts its nav on close, so an observer re-applies on
 * every mount. Idempotence is keyed on a marker on the INJECTED GLYPH, not a
 * global flag: if React rebuilds the gear (locale/key change), the new gear
 * has no marker and gets swapped again — a global flag would short-circuit
 * forever and leave the default gear. The same marker also breaks the
 * observer's own feedback loop. A row that stops matching keeps its gear —
 * cosmetic failure only, never a broken panel. The returned cleanup fully
 * restores the DOM, so `ctx.effect` teardown / HMR leaves nothing behind.
 */

/** Shared with the `settings.section` registration so the two never drift. */
export const SETTINGS_NAV_LABEL = 'NTR'

/** Marker on the button, for diagnosis and the cleanup's attribute sweep. */
const GLYPH_ATTR = 'data-dsh-ntr-nav-icon'

/** Marker on the injected glyph itself — the idempotence / feedback-loop key. */
const GLYPH_MARK = 'data-dsh-ntr-glyph'

/**
 * Interlocking double ring, drawn in the shell's idiom: 24 grid, two rings
 * overlapping — the DSH display layer meeting the ACP agent layer. Filled
 * with `currentColor` at low opacity for the overlap; no literal colors.
 */
const DOUBLE_RING_MARKUP =
  '<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">' +
  '<circle cx="9" cy="12" r="6" stroke="currentColor" stroke-width="1.8" fill="currentColor" fill-opacity="0.08" />' +
  '<circle cx="15" cy="12" r="6" stroke="currentColor" stroke-width="1.8" fill="currentColor" fill-opacity="0.08" />' +
  '</svg>'

interface SwappedGlyph {
  gear: Element
  glyph: Element
  button: Element
}

/**
 * Replace the gear on every matching nav row that is not already our glyph.
 * No global short-circuit: a rebuilt gear (no GLYPH_MARK) is swapped again,
 * while our own glyph (carrying GLYPH_MARK) is skipped, which both gives
 * idempotence and stops the observer's mutation feedback loop.
 */
function swapNavGlyph(records: SwappedGlyph[]): void {
  for (const label of document.querySelectorAll('nav button span')) {
    if (label.textContent?.trim() !== SETTINGS_NAV_LABEL) continue
    const button = label.closest('button')
    if (button === null) continue
    // Skip the whole row if OUR glyph already lives anywhere in it — not just
    // as the first svg. React can re-insert a gear ahead of the glyph; keying
    // on "first svg" would then mint a second glyph or clobber an icon.
    if (button.querySelector(`[${GLYPH_MARK}]`) !== null) continue
    const gear = button.querySelector('svg')
    if (gear === null) continue

    const holder = document.createElement('template')
    holder.innerHTML = DOUBLE_RING_MARKUP
    const glyph = holder.content.firstElementChild
    if (glyph === null) continue

    // Inherit the gear's geometry and class: keeps `.navIcon` sizing and the
    // shell's currentColor tint. `aria-hidden` marks it decorative.
    for (const attr of ['width', 'height', 'class']) {
      const value = gear.getAttribute(attr)
      if (value !== null) glyph.setAttribute(attr, value)
    }
    glyph.setAttribute('aria-hidden', 'true')
    glyph.setAttribute(GLYPH_MARK, '1')
    button.setAttribute(GLYPH_ATTR, '1')
    gear.replaceWith(glyph)
    records.push({ gear, glyph, button })
  }
}

/**
 * Install the observer and return a teardown. Safe to call when `document`
 * is absent (SSR / non-browser test hosts): it is then a no-op.
 */
export function installSettingsNavIcon(): () => void {
  if (typeof document === 'undefined') return () => {}
  const records: SwappedGlyph[] = []
  let queued = false
  let disposed = false

  const schedule = (): void => {
    if (queued || disposed) return
    queued = true
    requestAnimationFrame(() => {
      queued = false
      if (disposed) return
      swapNavGlyph(records)
    })
  }

  const observer = new MutationObserver(schedule)
  observer.observe(document.body, { childList: true, subtree: true })
  schedule()

  return () => {
    disposed = true
    observer.disconnect()
    for (const { gear, glyph, button } of records) {
      // Restore only if OUR glyph is still in the DOM. If React already
      // removed it (panel closed / row rebuilt), re-inserting the held gear
      // reference would create a ghost node — skip instead.
      if (glyph.isConnected) glyph.replaceWith(gear)
      button.removeAttribute(GLYPH_ATTR)
    }
    records.length = 0
  }
}
