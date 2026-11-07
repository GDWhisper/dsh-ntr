// @vitest-environment jsdom
/**
 * The header's subagent catalog cell, as a fake list slot reproduces it: the
 * host entry is registered under id `subagent-catalog`, the claim shadows it
 * at a lower priority, and the occupant splits on the ACP-mode verdict —
 *
 * - ACP conversation -> the plugin's self-drawn trigger + read-only list
 *   (projection rows joined with the plugin's six-state records);
 * - anything else, or any host shape the panel cannot serve -> the HOST
 *   component with its original props (the fail-open branch).
 */

import { createElement, useState } from 'react'
import type { ComponentType } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createSubagentCatalogClaim,
  subagentCatalogDiagIsWorthWarn,
  SUBAGENT_CATALOG_ENTRY_ID,
  SUBAGENT_CATALOG_SLOT,
} from '../src/client/subagent-activity.tsx'
import { readSubagentCatalogProjection } from '../src/client/subagent-panel.tsx'
import { createSubagentCatalogDiagSink } from '../src/client/index.tsx'
import type { SeatEntry, SeatRegisterOptions, SeatSlots } from '../src/client/model-seat.tsx'
import { AcpStore, subagentKey } from '../src/client/store.ts'
import type { AcpStore as AcpStoreType } from '../src/client/store.ts'
import type { SubagentRecord } from '../src/protocol.ts'

afterEach(cleanup)

/**
 * The status map the fake host hook answers with. The host component compares
 * the value it was handed against this reference: the plugin must pass the
 * shipped hook and map through untouched on every non-ACP / fail-open branch.
 */
let hostMap: ReadonlyMap<string, { running?: boolean }>

function HostSubagentCatalog(props: Record<string, unknown>) {
  const hook = props.useSessionStatus as ((selector?: (value: unknown) => unknown) => unknown) | undefined
  const statuses = (typeof hook === 'function' ? hook(value => value) : undefined) as
    | ReadonlyMap<string, { running?: boolean }>
    | undefined
  const running = statuses?.get('acp:call-1')?.running === true
  const navigation = typeof props.openChild === 'function' ? 'nav' : 'nonav'
  return createElement(
    'span',
    { 'data-testid': 'subagent-catalog' },
    running ? 'running' : 'idle',
    statuses === hostMap ? ' · raw' : ' · merged',
    ` · ${navigation}`,
  )
}

type FakeEntry = SeatEntry & { options: NonNullable<SeatEntry['options']> & { priority: number } }

class FakeSlots implements SeatSlots {
  private readonly cells = new Map<string, FakeEntry[]>()
  private readonly declared = new Set<string>()

  constructor(slots: string[]) {
    for (const slot of slots) this.declared.add(slot)
  }

  spec(key: string): { kind?: string } | undefined {
    if (!this.declared.has(key)) return undefined
    return { kind: 'list' }
  }

  entriesOfSlot(key: string): readonly SeatEntry[] {
    const sorted = [...(this.cells.get(key) ?? [])]
      .sort((a, b) => a.options.priority - b.options.priority)
    const seen = new Set<string | undefined>()
    return sorted.filter(entry => {
      const id = entry.options.id
      if (seen.has(id)) return false
      seen.add(id)
      return true
    })
  }

  register(options: SeatRegisterOptions, component: unknown): () => void {
    if (!this.declared.has(options.name)) throw new Error(`slot "${options.name}" is not declared`)
    const entry: FakeEntry = {
      component,
      options: {
        priority: options.priority ?? 0,
        ...(options.id === undefined ? {} : { id: options.id }),
        ...(options.order === undefined ? {} : { order: options.order }),
      },
      ...(options.inject === undefined ? {} : { inject: options.inject }),
      ...(options.locale === undefined ? {} : { locale: options.locale }),
    }
    const list = this.cells.get(options.name) ?? []
    list.push(entry)
    this.cells.set(options.name, list)
    return () => {
      const current = this.cells.get(options.name) ?? []
      const at = current.indexOf(entry)
      if (at >= 0) current.splice(at, 1)
    }
  }

  inject(key: string, callback: () => (() => void) | Iterable<() => void>): () => void {
    if (!this.declared.has(key)) return () => {}
    const effect = callback()
    return typeof effect === 'function' ? effect : () => { for (const dispose of [...effect].reverse()) dispose() }
  }

  raw(key: string): readonly FakeEntry[] {
    return this.cells.get(key) ?? []
  }

  winner(): FakeEntry | undefined {
    return this.entriesOfSlot(SUBAGENT_CATALOG_SLOT)
      .find(entry => entry.options.id === SUBAGENT_CATALOG_ENTRY_ID) as FakeEntry | undefined
  }
}

function fakeAcp(state: Record<string, unknown>): AcpStoreType {
  const snapshot = state
  return {
    subscribe: () => () => {},
    getSnapshot: () => snapshot,
    // The self-drawn panel resolves both language sides through the store.
    label: (zh: string) => zh,
  } as unknown as AcpStoreType
}

/**
 * The host's hook, as a REAL hook: the wrapper must call it on every path,
 * because the host component stores it among its own hooks. A zero-hook
 * projector for the merged path would change that component's hook count the
 * moment the active set flips, which React rejects on the same mount.
 */
function useHostSessionStatus(selector?: (value: unknown) => unknown): unknown {
  const [statuses] = useState(hostMap)
  return selector === undefined ? statuses : selector(statuses)
}

const catalogActions = (): Record<string, unknown> => ({
  openChild() {},
  openChildAside() {},
  refreshProjection() {},
})

function makeSlots(withHost = true, withInject = true, withLocale = true): FakeSlots {
  const slots = new FakeSlots([SUBAGENT_CATALOG_SLOT])
  if (withHost) {
    slots.register({
      name: SUBAGENT_CATALOG_SLOT,
      id: SUBAGENT_CATALOG_ENTRY_ID,
      order: 10,
      priority: 0,
      ...(withInject ? { inject: () => catalogActions() } : {}),
      ...(withLocale ? { locale: 'subagent' } : {}),
    }, HostSubagentCatalog)
  }
  return slots
}

function acpState(overrides: Record<string, unknown> = {}): AcpStore {
  return fakeAcp({
    acpMode: { 'chat-1': true },
    subagents: {},
    ...overrides,
  })
}

/** One plugin lifecycle record, with sane defaults. */
function record(patch: Partial<SubagentRecord> = {}): SubagentRecord {
  return {
    childId: 'acp:a',
    dshSessionId: 'chat-1',
    toolCallId: 'a',
    label: 'worker',
    status: 'running',
    startedAt: 1_000,
    lastActivityAt: 2_000,
    counts: { updates: 1, toolCalls: 0, textChars: 0 },
    ...patch,
  }
}

/** The host's `subagentCatalog` view value for one session. */
function projection(rows: readonly Record<string, unknown>[]): Record<string, unknown> {
  return { 'chat-1': { values: { subagentCatalog: rows } } }
}

interface ShadowOptions {
  /** `projectionsBySession` the fake host hook answers with. */
  projections?: Record<string, unknown>
  /** Omit the `useSessions` prop entirely (an older host shape). */
  withoutUseSessions?: boolean
}

/** Render the winning entry the way the renderer does: inject face + standard kit. */
function renderShadow(slots: FakeSlots, options: ShadowOptions = {}): void {
  const entry = slots.winner()
  expect(entry).toBeDefined()
  const face = entry?.inject === undefined ? {} : entry.inject('chat-1') as Record<string, unknown>
  hostMap = new Map([['session-1', { running: true }]])
  const props: Record<string, unknown> = {
    sessionId: 'chat-1',
    useSessionStatus: useHostSessionStatus,
    t: (key: string) => key,
    ...face,
  }
  if (options.withoutUseSessions !== true) {
    props.useSessions = (selector: (value: unknown) => unknown) => selector({
      byId: {},
      projectionsBySession: options.projections ?? {},
    })
  }
  render(createElement(entry?.component as ComponentType<Record<string, unknown>>, props))
}

describe('the subagent catalog shadow', () => {
  it('takes the host catalog cell with a lower-priority same-id entry', () => {
    const slots = makeSlots()
    const claim = createSubagentCatalogClaim({ slots, inject: sessionId => ({ acp: acpState(), sessionId }) })
    expect(claim).toBeDefined()
    claim?.sync()
    expect(claim?.holding).toBe(true)
    expect(slots.raw(SUBAGENT_CATALOG_SLOT)).toHaveLength(2)
    expect(slots.winner()?.options.id).toBe(SUBAGENT_CATALOG_ENTRY_ID)
    expect(slots.winner()?.options.order).toBe(10)
    expect(slots.winner()?.options.priority).toBeLessThan(0)
    expect(slots.winner()?.locale).toBe('subagent')
  })

  it('hands a host shape it cannot serve back to the host component untouched', () => {
    const slots = makeSlots()
    const claim = createSubagentCatalogClaim({ slots, inject: sessionId => ({ acp: acpState(), sessionId }) })
    claim?.sync()
    // No catalog projection -> the panel must hand the cell back to the host
    // component with its shipped hook and props (the allowed failure mode).
    renderShadow(slots)
    expect(screen.getByTestId('subagent-catalog').textContent).toBe('idle · raw · nav')
  })

  it('draws the self-drawn trigger and read-only list in an ACP conversation', () => {
    const slots = makeSlots()
    const acp = acpState({
      subagents: {
        [subagentKey('chat-1', 'acp:a')]: record({
          childId: 'acp:a',
          type: 'explore',
          status: 'running',
          startedAt: 1_000,
          lastActivityAt: 2_000,
          counts: { updates: 2, toolCalls: 3, textChars: 5 },
        }),
        [subagentKey('chat-1', 'acp:b')]: record({
          childId: 'acp:b',
          toolCallId: 'b',
          label: 'writer',
          status: 'completed',
          startedAt: 500,
          endedAt: 5_500,
          lastActivityAt: 5_500,
        }),
      },
    })
    const claim = createSubagentCatalogClaim({ slots, inject: sessionId => ({ acp, sessionId }) })
    claim?.sync()
    renderShadow(slots, {
      projections: projection([
        { id: 'acp:a', mode: 'external', createdAt: 1_000, label: 'scanner' },
        { id: 'acp:b', mode: 'external', createdAt: 500, label: 'writer' },
      ]),
    })
    // The host component is NOT rendered: the cell is the plugin's own trigger,
    // with the cumulative count and the running count kept apart.
    expect(screen.queryByTestId('subagent-catalog')).toBeNull()
    expect(screen.getByText('子智能体 · 累计 2 个 · 1 运行中')).toBeDefined()

    fireEvent.click(screen.getByRole('button'))
    expect(screen.getAllByRole('listitem')).toHaveLength(2)
    // Newest dispatch first: the projection label wins over the record's
    // fallback one, and the record's `type` prefixes it.
    expect(screen.getByText('explore · scanner')).toBeDefined()
    expect(screen.getByText('writer')).toBeDefined()
    expect(screen.getByText('运行中')).toBeDefined()
    expect(screen.getByText('已完成')).toBeDefined()
    // The completed row froze at endedAt - startedAt; no fake controls exist.
    expect(screen.getByText('5s')).toBeDefined()
    expect(screen.queryAllByRole('link')).toHaveLength(0)
    expect(screen.queryAllByRole('menuitem')).toHaveLength(0)
  })

  it('shows an unknown history row and a catalog-pending dispatch honestly', () => {
    const slots = makeSlots()
    const acp = acpState({
      subagents: {
        [subagentKey('chat-1', 'acp:new')]: record({
          childId: 'acp:new',
          status: 'pending',
          startedAt: 9_000,
          lastActivityAt: 9_100,
        }),
      },
    })
    const claim = createSubagentCatalogClaim({ slots, inject: sessionId => ({ acp, sessionId }) })
    claim?.sync()
    renderShadow(slots, {
      projections: projection([{ id: 'acp:old', mode: 'external', createdAt: 1_000, label: 'history' }]),
    })
    // `pending` is dispatched but not running: no running segment in the
    // trigger, while the row itself reads pending.
    expect(screen.getByText('子智能体 · 累计 2 个')).toBeDefined()
    fireEvent.click(screen.getByRole('button'))
    // A catalog row with no record predates state tracking: it must read
    // unknown, never succeeded, and the row says so in full.
    expect(screen.getByText('状态未知')).toBeDefined()
    expect(screen.getByText(/历史记录，状态未知/)).toBeDefined()
    // A dispatch the host catalog has not appended yet is still listed.
    expect(screen.getByText('等待开始')).toBeDefined()
    expect(screen.getByText(/目录待同步/)).toBeDefined()
  })

  it('fails open to the host component on every host shape it cannot serve', () => {
    const shapes: Array<{ name: string; options: ShadowOptions }> = [
      { name: 'no useSessions hook', options: { withoutUseSessions: true } },
      { name: 'projection not an array', options: { projections: { 'chat-1': { values: { subagentCatalog: 'nope' } } } } },
      { name: 'native catalog row', options: { projections: projection([{ id: 'session-2', mode: 'one-shot', createdAt: 1 }]) } },
      { name: 'row without an id', options: { projections: projection([{ mode: 'external' }]) } },
      { name: 'row without a mode', options: { projections: projection([{ id: 'acp:x' }]) } },
    ]
    for (const shape of shapes) {
      const diagnosed: string[] = []
      const slots = makeSlots()
      const claim = createSubagentCatalogClaim({
        slots,
        inject: sessionId => ({ acp: acpState({ subagents: {} }), sessionId }),
        onDiag: line => diagnosed.push(line),
      })
      claim?.sync()
      renderShadow(slots, shape.options)
      expect(screen.getByTestId('subagent-catalog'), shape.name).toBeDefined()
      expect(screen.queryByText(/累计 /), shape.name).toBeNull()
      expect(diagnosed.some(line => line.startsWith('subagent catalog: ')), shape.name).toBe(true)
      claim?.release()
      cleanup()
    }
  })

  it('passes the host hook straight through outside ACP mode', () => {
    const slots = makeSlots()
    const acp = acpState({ acpMode: { 'chat-1': false } })
    const claim = createSubagentCatalogClaim({ slots, inject: sessionId => ({ acp, sessionId }) })
    claim?.sync()
    renderShadow(slots)
    // The gate's verdict says the conversation is not ACP: the host component
    // must see the shipped map, untouched.
    expect(screen.getByTestId('subagent-catalog').textContent).toBe('idle · raw · nav')
  })

  it('swaps the component type on an ACP-mode flip without a hook-count error', async () => {
    // The host component stores its hook mid-list; the occupant must switch
    // between TWO component types (never a conditional hook) when the
    // ACP-mode verdict flips on one mount, or React rejects the render.
    const store = new AcpStore(async () => ({ ok: true, value: {} }), (zh) => zh)
    const slots = makeSlots()
    const claim = createSubagentCatalogClaim({ slots, inject: sessionId => ({ acp: store, sessionId }) })
    claim?.sync()
    renderShadow(slots, { projections: projection([{ id: 'acp:a', mode: 'external', createdAt: 1_000, label: 'worker' }]) })
    expect(screen.getByTestId('subagent-catalog').textContent).toBe('idle · raw · nav')

    await act(async () => {
      store.noteAcpMode('chat-1', true)
    })
    // ACP mode: the self-drawn trigger takes the cell in place of the host
    // component.
    expect(screen.queryByTestId('subagent-catalog')).toBeNull()
    expect(screen.getByText('子智能体 · 累计 1 个')).toBeDefined()
  })

  it('restores the native entry when the claim is released', () => {
    const slots = makeSlots()
    const claim = createSubagentCatalogClaim({ slots, inject: sessionId => ({ acp: acpState(), sessionId }) })
    claim?.sync()
    expect(slots.winner()?.component).not.toBe(HostSubagentCatalog)
    claim?.release()
    expect(slots.raw(SUBAGENT_CATALOG_SLOT)).toHaveLength(1)
    expect(slots.winner()?.component).toBe(HostSubagentCatalog)
  })

  it('does not claim when the host entry, inject or locale is missing', () => {
    const diagnosed: string[] = []
    for (const slots of [
      makeSlots(false),
      makeSlots(true, false),
      makeSlots(true, true, false),
    ]) {
      expect(createSubagentCatalogClaim({
        slots,
        inject: () => ({}),
        onDiag: line => diagnosed.push(line),
      })).toBeUndefined()
    }
    expect(diagnosed).toEqual(Array.from({ length: 3 }, () => 'subagent catalog: host entry not available'))
  })
})

/**
 * The production console sink. The self-drawn panel's fail-open reasons
 * ("not an array", "no useSessions hook", a native child it cannot navigate,
 * no session id, an unexpected row shape) match none of the shared failure
 * keywords, so a keyword-only filter made every one of them silent.
 */
describe('the subagent catalog diagnostic sink', () => {
  it('prints a real panel fail-open reason, once per verdict change', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const sink = createSubagentCatalogDiagSink()
      const read = readSubagentCatalogProjection('not an array')
      expect(read.ok).toBe(false)
      if (read.ok) return
      const line = `subagent catalog: ${read.reason}`

      sink(line)
      expect(warn).toHaveBeenCalledWith(`[dsh-ntr] ${line}`)
      sink(line)
      expect(warn).toHaveBeenCalledTimes(1)
      // The ordinary older-host case still says nothing: the native trigger is
      // simply still there.
      sink('subagent catalog: host entry not available')
      expect(warn).toHaveBeenCalledTimes(1)
    } finally {
      warn.mockRestore()
    }
  })

  it('accepts every reason the panel and projection reader can emit', () => {
    const values: unknown[] = [
      undefined,
      'not an array',
      [null],
      [{ mode: 'external' }],
      [{ id: 'acp:x' }],
      [{ id: 'session-1', mode: 'one-shot' }],
      [{ id: 'acp:x', mode: 'external', createdAt: 'soon' }],
      [{ id: 'acp:x', mode: 'external', label: 7 }],
    ]
    for (const value of values) {
      const read = readSubagentCatalogProjection(value)
      expect(read.ok).toBe(false)
      if (read.ok) continue
      const line = `subagent catalog: ${read.reason}`
      expect(subagentCatalogDiagIsWorthWarn(line), line).toBe(true)
    }
    // Reasons emitted by the component itself rather than the projection reader.
    expect(subagentCatalogDiagIsWorthWarn('subagent catalog: the host entry has no useSessions hook')).toBe(true)
    expect(subagentCatalogDiagIsWorthWarn('subagent catalog: the host handed the entry no session id')).toBe(true)
  })

  it('keeps the shared failure keywords and stays silent on success', () => {
    expect(subagentCatalogDiagIsWorthWarn('conversation.session.header.actions: held by the ACP base')).toBe(false)
    expect(subagentCatalogDiagIsWorthWarn('conversation.session.header.actions: taken by client-ui-subagent — gave up after 3 retakes')).toBe(true)
    expect(subagentCatalogDiagIsWorthWarn('conversation.session.header.actions: still held by another entry after retake 3')).toBe(true)
    expect(subagentCatalogDiagIsWorthWarn('subagent catalog: registration failed (boom)')).toBe(true)
  })
})
