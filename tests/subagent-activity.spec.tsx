// @vitest-environment jsdom
/**
 * The header's subagent catalog trigger, as a fake list slot reproduces it:
 * the host entry is registered under id `subagent-catalog`, the claim shadows
 * it at a lower priority, and the shadow renders the HOST component with a
 * substituted `useSessionStatus` that marks the live `acp:<toolCallId>` rows
 * running. These tests prove the mechanism the real 0.2.1 host relies on
 * (one winner per id, entry inject/locale exposure) without pulling a private
 * host component into the test graph.
 */

import { createElement, useState } from 'react'
import type { ComponentType } from 'react'
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createSubagentCatalogClaim,
  SUBAGENT_CATALOG_ENTRY_ID,
  SUBAGENT_CATALOG_SLOT,
} from '../src/client/subagent-activity.tsx'
import type { SeatEntry, SeatRegisterOptions, SeatSlots } from '../src/client/model-seat.tsx'
import { AcpStore } from '../src/client/store.ts'
import type { AcpStore as AcpStoreType } from '../src/client/store.ts'

afterEach(cleanup)

/**
 * The status map the fake host hook answers with. The host component compares
 * the value it was handed against this reference, so a test can tell a
 * substituted hook (a copy) from the shipped one (the same map).
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
    activeSubagents: { 'chat-1': ['acp:call-1'] },
    ...overrides,
  })
}

/** Render the winning entry the way the renderer does: inject face + standard kit. */
function renderShadow(slots: FakeSlots): void {
  const entry = slots.winner()
  expect(entry).toBeDefined()
  const face = entry?.inject === undefined ? {} : entry.inject('chat-1') as Record<string, unknown>
  hostMap = new Map([['session-1', { running: true }]])
  render(createElement(entry?.component as ComponentType<Record<string, unknown>>, {
    sessionId: 'chat-1',
    useSessions: (selector: (value: unknown) => unknown) => selector({ byId: {}, projectionsBySession: {} }),
    useSessionStatus: useHostSessionStatus,
    t: (key: string) => key,
    ...face,
  }))
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

  it('lights the live external worker through the host component', () => {
    const slots = makeSlots()
    const claim = createSubagentCatalogClaim({ slots, inject: sessionId => ({ acp: acpState(), sessionId }) })
    claim?.sync()
    renderShadow(slots)
    // The host's own component read `running: true` for `acp:call-1` from a
    // COPY of its status map, and its catalog actions still reach it.
    expect(screen.getByTestId('subagent-catalog').textContent).toBe('running · merged · nav')
  })

  it('passes the host hook straight through with no active ids', () => {
    const slots = makeSlots()
    for (const acp of [
      acpState({ activeSubagents: {} }),
      acpState({ activeSubagents: { 'chat-1': [] } }),
      acpState({ activeSubagents: { 'chat-2': ['acp:call-1'] } }),
    ]) {
      const shadow = createSubagentCatalogClaim({ slots, inject: sessionId => ({ acp, sessionId }) })
      shadow?.sync()
      renderShadow(slots)
      expect(screen.getByTestId('subagent-catalog').textContent).toBe('idle · raw · nav')
      shadow?.release()
      cleanup()
    }
  })

  it('passes the host hook straight through outside ACP mode', () => {
    const slots = makeSlots()
    const acp = acpState({ acpMode: { 'chat-1': false } })
    const claim = createSubagentCatalogClaim({ slots, inject: sessionId => ({ acp, sessionId }) })
    claim?.sync()
    renderShadow(slots)
    // The active set still names this chat, but the gate's verdict says the
    // conversation is not ACP: the host component must see the shipped map.
    expect(screen.getByTestId('subagent-catalog').textContent).toBe('idle · raw · nav')
  })

  it('keeps the host hook sequence stable when a worker starts and stops on one mount', async () => {
    // The host stores this hook mid-list; a substitute that does not call the
    // real hook would change its hook count on the active-set flip and throw
    // (React: "Rendered fewer/more hooks…"). This mounts ONCE and toggles.
    const store = new AcpStore(async () => ({ ok: true, value: {} }), (zh) => zh)
    store.noteAcpMode('chat-1', true)
    const apply = (event: unknown): Promise<void> =>
      (store as unknown as { applyEvent(event: unknown): Promise<void> }).applyEvent(event)
    const slots = makeSlots()
    const claim = createSubagentCatalogClaim({ slots, inject: sessionId => ({ acp: store, sessionId }) })
    claim?.sync()
    renderShadow(slots)
    expect(screen.getByTestId('subagent-catalog').textContent).toBe('idle · raw · nav')

    await act(async () => {
      await apply({ type: 'subagents/update', dshSessionId: 'chat-1', childId: 'acp:call-1', running: true })
    })
    expect(screen.getByTestId('subagent-catalog').textContent).toBe('running · merged · nav')

    await act(async () => {
      await apply({ type: 'subagents/update', dshSessionId: 'chat-1', childId: 'acp:call-1', running: false })
    })
    expect(screen.getByTestId('subagent-catalog').textContent).toBe('idle · raw · nav')
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
