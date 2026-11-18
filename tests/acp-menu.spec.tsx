// @vitest-environment jsdom
/**
 * The composer picker's in-menu search: threshold, render cap, matching,
 * Escape staging and the keyboard hop between the search box and the rows.
 * The component is mounted bare (no store, no provider); a null anchor makes
 * the placement effect a no-op.
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  AcpMenu,
  MENU_CAP,
  MENU_SEARCH_THRESHOLD,
  capMenuSections,
  filterMenuSections,
} from '../src/client/acp-menu.tsx'
import type { AcpMenuItem, AcpMenuSection } from '../src/client/acp-ui.tsx'

afterEach(cleanup)

function items(count: number, overrides: (index: number) => Partial<AcpMenuItem> = () => ({})): AcpMenuItem[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `m-${index}`,
    label: `Model ${index}`,
    ...overrides(index),
  }))
}

function section(id: string, rows: AcpMenuItem[], title?: string): AcpMenuSection {
  return { id, ...(title === undefined ? {} : { title }), items: rows }
}

function renderMenu(sections: AcpMenuSection[], onPick = vi.fn(), onClose = vi.fn()) {
  render(
    <AcpMenu
      model={{ title: 'Test menu', sections }}
      anchor={null}
      label={zh => zh}
      onPick={onPick}
      onClose={onClose}
    />,
  )
  return { onPick, onClose }
}

/** The same menu as an element, for tests that re-render while it stays open. */
function menu(sections: AcpMenuSection[], onPick = vi.fn(), onClose = vi.fn()) {
  return (
    <AcpMenu
      model={{ title: 'Test menu', sections }}
      anchor={null}
      label={zh => zh}
      onPick={onPick}
      onClose={onClose}
    />
  )
}

/** The menu's rows, pinned / disabled rows included. */
function rows(): HTMLElement[] {
  return screen.queryAllByRole('menuitemradio').concat(screen.queryAllByRole('menuitemcheckbox'))
}

describe('AcpMenu search visibility', () => {
  it(`shows the search box above ${MENU_SEARCH_THRESHOLD} rows`, () => {
    renderMenu([section('s', items(MENU_SEARCH_THRESHOLD + 1))])
    expect(screen.getByRole('searchbox', { name: '搜索菜单项' })).toBeTruthy()
    expect(screen.getByPlaceholderText('搜索…')).toBeTruthy()
  })

  it('keeps short menus unchanged (no search box)', () => {
    renderMenu([section('s', items(MENU_SEARCH_THRESHOLD - 1))])
    expect(screen.queryByRole('searchbox')).toBeNull()
  })

  it('draws the line exactly at the threshold', () => {
    const { rerender } = render(menu([section('s', items(MENU_SEARCH_THRESHOLD))]))
    expect(screen.queryByRole('searchbox')).toBeNull()

    rerender(menu([section('s', items(MENU_SEARCH_THRESHOLD + 1))]))
    expect(screen.getByRole('searchbox')).toBeTruthy()
  })

  it('does not count pinned rows toward the threshold', () => {
    const pinned: AcpMenuItem = { id: 'refresh', label: 'Refresh list', pinned: true }
    renderMenu([section('s', [...items(MENU_SEARCH_THRESHOLD), pinned])])
    expect(screen.queryByRole('searchbox')).toBeNull()
  })

  it('focuses the search box once when the menu opens', () => {
    renderMenu([section('s', items(MENU_SEARCH_THRESHOLD + 1))])
    expect(document.activeElement).toBe(screen.getByRole('searchbox'))
  })

  it('does not steal focus when the menu grows past the threshold while open', () => {
    const { rerender } = render(menu([section('s', items(MENU_SEARCH_THRESHOLD - 1))]))
    expect(screen.queryByRole('searchbox')).toBeNull()

    rerender(menu([section('s', items(MENU_SEARCH_THRESHOLD + 1))]))
    expect(screen.queryByRole('searchbox')).not.toBeNull()
    expect(document.activeElement).not.toBe(screen.getByRole('searchbox'))
  })

  it('clears a leftover query when the menu shrinks below the threshold', () => {
    const onPick = vi.fn()
    const { rerender } = render(menu([section('s', items(MENU_SEARCH_THRESHOLD + 1))], onPick))
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'Model 1' } })

    rerender(menu([section('s', items(MENU_SEARCH_THRESHOLD - 1))], onPick))
    expect(screen.queryByRole('searchbox')).toBeNull()
    // Without the reset the old query would still filter the short list.
    expect(rows().length).toBe(MENU_SEARCH_THRESHOLD - 1)

    rerender(menu([section('s', items(MENU_SEARCH_THRESHOLD + 1))], onPick))
    expect((screen.getByRole('searchbox') as HTMLInputElement).value).toBe('')
  })
})

describe('AcpMenu render cap (empty query)', () => {
  it('caps 200 rows at 40 while keeping the active and pinned rows visible', () => {
    const pinned: AcpMenuItem = { id: 'refresh', label: 'Refresh list', pinned: true }
    const rowsInMenu = items(199, index => (index === 150 ? { active: true } : {}))
    rowsInMenu.push(pinned)
    renderMenu([section('s', rowsInMenu)])

    expect(rows().length).toBeLessThanOrEqual(MENU_CAP)
    expect(screen.getByText('Model 150')).toBeTruthy()
    expect(screen.getByText('Refresh list')).toBeTruthy()
    expect(screen.getByText('共 199 项，输入关键词筛选')).toBeTruthy()
  })
})

describe('AcpMenu query filtering', () => {
  it('matches label, detail and id, and drops non-matching sections', () => {
    const first = section('first', items(29, index => ({ id: `a-${index}`, label: `Alpha ${index}` })), 'First')
    const second = section('second', [
      { id: 'beta-row', label: 'Beta', detail: 'has a speedy detail' },
      { id: 'needle-id', label: 'Gamma' },
    ], 'Second')
    renderMenu([first, second])
    const input = screen.getByRole('searchbox')

    fireEvent.change(input, { target: { value: 'speedy' } })
    expect(rows().map(row => row.textContent)).toEqual(['Betahas a speedy detail'])

    fireEvent.change(input, { target: { value: '#needle' } })
    expect(rows()).toHaveLength(0)

    fireEvent.change(input, { target: { value: 'needle' } })
    expect(screen.getByText('Gamma')).toBeTruthy()
    expect(screen.queryByText('First')).toBeNull()

    fireEvent.change(input, { target: { value: 'alpha 3' } })
    expect(screen.getByText('Alpha 3')).toBeTruthy()
    expect(screen.queryByText('Alpha 4')).toBeNull()

    fireEvent.change(input, { target: { value: 'zzz' } })
    expect(screen.getByText('没有匹配项')).toBeTruthy()
  })

  it('truncates matches beyond the cap and reports the remainder', () => {
    const pinned: AcpMenuItem = { id: 'refresh', label: 'Refresh list', pinned: true }
    renderMenu([section('s', [...items(200), pinned])])
    const input = screen.getByRole('searchbox')

    fireEvent.change(input, { target: { value: 'model' } })
    // The pinned row does not count against the cap: 40 matches + refresh.
    expect(rows()).toHaveLength(MENU_CAP + 1)
    expect(screen.getByText('Refresh list')).toBeTruthy()
    expect(screen.getByText('还有 160 项，继续输入以缩小范围')).toBeTruthy()
  })
})

describe('AcpMenu keyboard', () => {
  it('ArrowDown enters the list, ArrowUp from the first row returns to the box', () => {
    renderMenu([section('s', items(31))])
    const input = screen.getByRole('searchbox')
    const list = rows()

    fireEvent.keyDown(input, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(list[0])

    fireEvent.keyDown(list[0] as HTMLElement, { key: 'ArrowUp' })
    expect(document.activeElement).toBe(input)

    fireEvent.keyDown(input, { key: 'ArrowDown' })
    fireEvent.keyDown(list[0] as HTMLElement, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(list[1])
  })

  it('Enter in the search box picks the first available row', () => {
    const onPick = vi.fn()
    renderMenu([section('s', items(31))], onPick)
    fireEvent.keyDown(screen.getByRole('searchbox'), { key: 'Enter' })
    expect(onPick).toHaveBeenCalledWith('m-0', 's')
  })

  it('prefers a matching row over a pinned action when Enter is pressed', () => {
    const onPick = vi.fn()
    const pinned: AcpMenuItem = { id: 'refresh', label: 'Refresh list', pinned: true }
    renderMenu([section('s', [pinned, ...items(31)])], onPick)
    const input = screen.getByRole('searchbox')
    fireEvent.change(input, { target: { value: 'Model 3' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onPick).toHaveBeenCalledWith('m-3', 's')
  })

  it('Enter skips a disabled first row and ignores an IME composition', () => {
    const onPick = vi.fn()
    renderMenu([section('s', items(31, index => (index === 0 ? { disabled: true } : {})))], onPick)
    const input = screen.getByRole('searchbox')

    fireEvent.keyDown(input, { key: 'Enter', isComposing: true })
    expect(onPick).not.toHaveBeenCalled()

    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onPick).toHaveBeenCalledWith('m-1', 's')
  })

  it('Enter never activates a pinned row when the query matches nothing', () => {
    const onPick = vi.fn()
    const pinned: AcpMenuItem = { id: 'refresh', label: 'Refresh list', pinned: true }
    renderMenu([section('s', [...items(31), pinned])], onPick)
    const input = screen.getByRole('searchbox')

    fireEvent.change(input, { target: { value: 'zzz' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onPick).not.toHaveBeenCalled()
  })

  it('Escape clears a non-empty query before it closes the menu', () => {
    const { onClose } = renderMenu([section('s', items(31))])
    const input = screen.getByRole('searchbox') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'Model 1' } })
    expect(input.value).toBe('Model 1')

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).not.toHaveBeenCalled()
    expect(input.value).toBe('')

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})

describe('capMenuSections / filterMenuSections', () => {
  const pinned: AcpMenuItem = { id: 'refresh', label: 'Refresh list', pinned: true }

  it('caps the rows and keeps pinned rows inside the window', () => {
    const capped = capMenuSections([section('s', [...items(50), pinned])], 10)
    expect(capped.total).toBe(51)
    expect(capped.shown).toBe(10)
    expect(capped.hidden).toBe(41)
    expect(capped.sections[0]?.items).toHaveLength(10)
    expect(capped.sections[0]?.items.some(item => item.pinned === true)).toBe(true)
  })

  it('does not charge pinned rows against the cap in query mode', () => {
    const capped = capMenuSections([section('s', [pinned, ...items(50)])], 10, true)
    expect(capped.sections[0]?.items).toHaveLength(11)
    expect(capped.hidden).toBe(40)
  })

  it('keeps pinned rows out of matching and drops empty sections', () => {
    const sections = [
      section('first', [{ id: 'alpha', label: 'Alpha' }], 'First'),
      section('second', [pinned, { id: 'gamma', label: 'Gamma' }], 'Second'),
    ]
    const filtered = filterMenuSections(sections, 'gamma')
    expect(filtered.map(entry => entry.id)).toEqual(['second'])
    expect(filtered[0]?.items.map(item => item.id)).toEqual(['refresh', 'gamma'])
    expect(filterMenuSections(sections, '')).toBe(sections)
  })
})
