// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { SETTINGS_NAV_LABEL, installSettingsNavIcon } from '../src/client/settings-nav-icon.ts'

/** Flush the rAF-coalesced scan the installer schedules. */
const flushRaf = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()))

/** Build the host's settings nav row: nav > button > span(label) + gear svg. */
function makeNavRow(labelText: string) {
  document.body.innerHTML = ''
  const nav = document.createElement('nav')
  const button = document.createElement('button')
  const span = document.createElement('span')
  span.textContent = labelText
  const gear = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  gear.setAttribute('width', '16')
  gear.setAttribute('height', '16')
  gear.setAttribute('class', 'navIcon')
  button.appendChild(span)
  button.appendChild(gear)
  nav.appendChild(button)
  document.body.appendChild(nav)
  return { nav, button, span, gear }
}

afterEach(() => {
  document.body.innerHTML = ''
})

describe('installSettingsNavIcon', () => {
  it('swaps the gear on the row whose label matches, copying geometry and class', async () => {
    const { button, gear } = makeNavRow(SETTINGS_NAV_LABEL)
    const cleanup = installSettingsNavIcon()
    await flushRaf()

    const glyph = button.querySelector('svg')
    expect(glyph).not.toBeNull()
    expect(glyph).not.toBe(gear)
    expect(glyph!.getAttribute('width')).toBe('16')
    expect(glyph!.getAttribute('height')).toBe('16')
    expect(glyph!.getAttribute('class')).toBe('navIcon')
    expect(glyph!.getAttribute('aria-hidden')).toBe('true')
    // Three interlocking rings in a TRIANGLE: three distinct centres, and two of
    // them sharing a row — a row arrangement would put all three on one. The
    // masked circles are the three outlines (the wash is unmasked).
    const rings = Array.from(glyph!.querySelectorAll('circle[mask]'))
    expect(rings.length).toBe(3)
    expect(new Set(rings.map(ring => `${ring.getAttribute('cx')},${ring.getAttribute('cy')}`)).size).toBe(3)
    expect(new Set(rings.map(ring => ring.getAttribute('cy'))).size).toBe(2)
    // The weave: every outline is cut at exactly the two crossings it passes
    // UNDER. Three cuts would dash a ring, one would leave it on top everywhere.
    const masks = Array.from(glyph!.querySelectorAll('mask'))
    expect(masks.length).toBe(3)
    for (const mask of masks) expect(mask.querySelectorAll('circle').length).toBe(2)
    expect(button.hasAttribute('data-dsh-ntr-nav-icon')).toBe(true)
    cleanup()
  })

  it('leaves the gear untouched on a non-matching row', async () => {
    const { button, gear } = makeNavRow('Other Section')
    const cleanup = installSettingsNavIcon()
    await flushRaf()

    expect(button.querySelector('svg')).toBe(gear)
    expect(button.hasAttribute('data-dsh-ntr-nav-icon')).toBe(false)
    cleanup()
  })

  it('is idempotent across repeated scans and observer re-triggers', async () => {
    const { button } = makeNavRow(SETTINGS_NAV_LABEL)
    const cleanup = installSettingsNavIcon()
    await flushRaf()
    const firstGlyph = button.querySelector('svg')
    expect(firstGlyph!.hasAttribute('data-dsh-ntr-glyph')).toBe(true)

    // Simulate a DOM mutation that re-fires the observer, then flush again.
    button.appendChild(document.createElement('i'))
    await flushRaf()
    await flushRaf()

    expect(button.querySelector('svg')).toBe(firstGlyph)
    expect(button.querySelectorAll('svg').length).toBe(1)
    cleanup()
  })

  it('re-swaps when React rebuilds the gear without our glyph marker', async () => {
    const { button, gear } = makeNavRow(SETTINGS_NAV_LABEL)
    const cleanup = installSettingsNavIcon()
    await flushRaf()
    const firstGlyph = button.querySelector('svg')
    expect(firstGlyph).not.toBe(gear)

    // A locale/key change makes React drop our glyph and insert a fresh gear.
    // The button-level marker survives, so a global-flag implementation would
    // never swap again; the glyph-level marker is what lets us recover.
    firstGlyph!.replaceWith(gear)
    expect(button.querySelector('svg')).toBe(gear)
    button.appendChild(document.createElement('i')) // fire the observer
    await flushRaf()
    await flushRaf()

    const secondGlyph = button.querySelector('svg')
    expect(secondGlyph).not.toBe(gear)
    expect(secondGlyph!.hasAttribute('data-dsh-ntr-glyph')).toBe(true)
    cleanup()
  })

  it('does not mint a second glyph when a foreign svg precedes our glyph', async () => {
    const { button } = makeNavRow(SETTINGS_NAV_LABEL)
    const cleanup = installSettingsNavIcon()
    await flushRaf()
    const glyph = button.querySelector('svg')!

    // React inserts an unrelated svg AHEAD of our glyph. Keying on "first svg"
    // would treat it as a gear and mint a second glyph; the whole-row marker
    // check must skip the row instead.
    const foreign = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    button.insertBefore(foreign, glyph)
    button.appendChild(document.createElement('i')) // fire the observer
    await flushRaf()
    await flushRaf()

    expect(button.querySelectorAll('[data-dsh-ntr-glyph]').length).toBe(1)
    expect(button.contains(glyph)).toBe(true)
    cleanup()
  })

  it('two concurrent installers do not cross-restore each other on cleanup', async () => {
    const { button } = makeNavRow(SETTINGS_NAV_LABEL)
    const cleanupA = installSettingsNavIcon()
    await flushRaf()
    const cleanupB = installSettingsNavIcon() // sees the glyph, swaps nothing
    await flushRaf()

    expect(button.querySelectorAll('[data-dsh-ntr-glyph]').length).toBe(1)
    cleanupA() // restores the gear (glyph was still connected)
    await flushRaf()

    // B's records are empty, so its cleanup must be a no-op and not re-swap.
    cleanupB()
    await flushRaf()
    expect(button.querySelectorAll('[data-dsh-ntr-glyph]').length).toBe(0)
    expect(button.querySelector('svg')!.getAttribute('class')).toBe('navIcon')
  })

  it('cleanup restores the original gear and drops the marker', async () => {
    const { button, gear } = makeNavRow(SETTINGS_NAV_LABEL)
    const cleanup = installSettingsNavIcon()
    await flushRaf()
    expect(button.contains(gear)).toBe(false)

    cleanup()

    expect(button.querySelector('svg')).toBe(gear)
    expect(button.hasAttribute('data-dsh-ntr-nav-icon')).toBe(false)
    // A post-cleanup mutation must not re-apply (observer disconnected).
    button.appendChild(document.createElement('i'))
    await flushRaf()
    expect(button.querySelector('svg')).toBe(gear)
  })

  it('re-applies on a freshly mounted row after the first was torn down', async () => {
    const first = makeNavRow(SETTINGS_NAV_LABEL)
    const cleanup = installSettingsNavIcon()
    await flushRaf()
    expect(first.button.hasAttribute('data-dsh-ntr-nav-icon')).toBe(true)

    // Panel closes: its nav unmounts. A fresh mount must be swapped again.
    document.body.innerHTML = ''
    const second = makeNavRow(SETTINGS_NAV_LABEL)
    // Trigger the observer with the new subtree.
    second.nav.appendChild(document.createElement('i'))
    await flushRaf()
    await flushRaf()

    expect(second.button.hasAttribute('data-dsh-ntr-nav-icon')).toBe(true)
    expect(second.button.querySelectorAll('circle[mask]').length).toBe(3)
    cleanup()
  })
})
