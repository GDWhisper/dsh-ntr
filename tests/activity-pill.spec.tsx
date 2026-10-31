// @vitest-environment jsdom
/**
 * The composer dock's activity pill, as a fake list slot reproduces it:
 * the host entry is registered under id `activity`, the claim shadows it at a
 * lower priority, and the shadow renders the HOST component with a patched
 * `sessionStats`. These tests prove the mechanism the real 0.2.1 host relies
 * on (`entriesOfSlot` one-winner-per-id, entry inject/locale exposure) without
 * pulling a private host component into the test graph.
 */

import { createElement } from 'react'
import type { ComponentType } from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ACTIVITY_ENTRY_ID,
  DOCK_SLOT,
  activityBurst,
  createActivityPillClaim,
  patchedActivityStats,
} from '../src/client/activity-pill.tsx'
import type { SeatEntry, SeatRegisterOptions, SeatSlots } from '../src/client/model-seat.tsx'
import type { AcpStore } from '../src/client/store.ts'

afterEach(cleanup)

const nativeStats = {
  turns: 1,
  steps: 2,
  llmMs: 0,
  toolMs: 0,
  ttftMs: 0,
  ttftSteps: 0,
  decodeTokens: 100,
  decodeMs: 10_000,
}

const t = (key: string, params: Record<string, unknown> = {}): string => {
  if (key === 'stats.counts') return `${String(params.turns)} 轮 ${String(params.steps)} 步`
  if (key === 'message.tokensPerSecond') return `${String(params.tps)} tok/s`
  return key
}

function HostActivityPill(props: Record<string, unknown>) {
  const mode = (props.usePerformanceUsage as (selector: (value: unknown) => unknown) => unknown)(value => value)
  const stats = (props.useProjection as (key: string) => Record<string, number> | undefined)('sessionStats')
  const speed = stats !== undefined && stats.decodeMs > 0
    ? t('message.tokensPerSecond', { tps: (stats.decodeTokens / (stats.decodeMs / 1000)).toFixed(1) })
    : null
  return createElement('span', { 'data-testid': 'activity-pill' },
    t('stats.counts', { turns: stats?.turns ?? 0, steps: stats?.steps ?? 0 }),
    speed === null ? null : ` · ${speed}`,
    mode === 'compact' ? ' [compact]' : null)
}

const performanceUsage = { get: () => 'full' }

type FakeEntry = SeatEntry & { options: NonNullable<SeatEntry['options']> & { priority: number } }

class FakeSlots implements SeatSlots {
  private readonly cells = new Map<string, FakeEntry[]>()
  private readonly declared = new Set<string>()

  constructor(slots: string[]) {
    for (const slot of slots) this.declared.add(slot)
  }

  spec(key: string): { kind?: string } | undefined {
    if (!this.declared.has(key)) return undefined
    return { kind: key === DOCK_SLOT ? 'list' : 'single' }
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
    return this.entriesOfSlot(DOCK_SLOT).find(entry => entry.options.id === ACTIVITY_ENTRY_ID) as FakeEntry | undefined
  }
}

function fakeAcp(state: Record<string, unknown>): AcpStore {
  const snapshot = state
  return {
    subscribe: () => () => {},
    getSnapshot: () => snapshot,
  } as unknown as AcpStore
}

/** What the renderer's `runInject`/`bindInjectSources` do to an entry's face. */
function bindFace(face: Record<string, unknown>): Record<string, unknown> {
  const { hooks, ...rest } = face as { hooks?: Record<string, { get(): unknown }> }
  for (const [name, source] of Object.entries(hooks ?? {})) {
    const prop = `use${name.charAt(0).toUpperCase()}${name.slice(1)}`
    rest[prop] = (selector?: (value: unknown) => unknown) => {
      const value = source.get()
      return selector === undefined ? value : selector(value)
    }
  }
  return rest
}

function makeSlots(withHost = true, withInject = true, withLocale = true): FakeSlots {
  const slots = new FakeSlots([DOCK_SLOT])
  if (withHost) {
    slots.register({
      name: DOCK_SLOT,
      id: ACTIVITY_ENTRY_ID,
      order: 0,
      priority: 0,
      ...(withInject ? { inject: () => ({ hooks: { performanceUsage } }) } : {}),
      ...(withLocale ? { locale: 'chat' } : {}),
    }, HostActivityPill)
  }
  return slots
}

function renderShadow(
  slots: FakeSlots,
  acp: AcpStore,
  projection: (key: string, selector?: (value: unknown) => unknown) => unknown = (key, selector) => {
    const value = key === 'sessionStats' ? nativeStats : undefined
    return selector === undefined ? value : selector(value)
  },
): void {
  const entry = slots.winner()
  expect(entry).toBeDefined()
  const face = entry?.inject === undefined ? {} : bindFace(entry.inject('chat-1') as Record<string, unknown>)
  render(createElement(entry?.component as ComponentType<Record<string, unknown>>, {
    sessionId: 'chat-1',
    useChat: (selector: (value: unknown) => unknown) => selector({ legacy: { nodes: [] } }),
    useProjection: projection,
    t,
    ...face,
  }))
}

function acpState(overrides: Record<string, unknown> = {}): AcpStore {
  return fakeAcp({
    acpMode: { 'chat-1': true },
    chatSessionsFor: 'chat-1',
    chatSessions: [{ sessionId: 'acp-1', agentId: 'a', released: false }],
    burstStats: {},
    ...overrides,
  })
}

describe('the activity pill shadow', () => {
  it('takes the host activity cell with a lower-priority same-id entry', () => {
    const slots = makeSlots()
    const claim = createActivityPillClaim({ slots, inject: sessionId => ({ acp: acpState(), sessionId }) })
    expect(claim).toBeDefined()
    claim?.sync()
    expect(claim?.holding).toBe(true)
    expect(slots.raw(DOCK_SLOT)).toHaveLength(2)
    expect(slots.winner()?.options.id).toBe(ACTIVITY_ENTRY_ID)
    expect(slots.winner()?.options.priority).toBeLessThan(0)
    expect(slots.winner()?.locale).toBe('chat')
  })

  it('renders the host pill with the host formula on an ordinary conversation', () => {
    const slots = makeSlots()
    const claim = createActivityPillClaim({ slots, inject: sessionId => ({ acp: acpState({ acpMode: {} }), sessionId }) })
    claim?.sync()
    renderShadow(slots, acpState({ acpMode: {} }))
    expect(screen.getByTestId('activity-pill').textContent).toBe('1 轮 2 步 · 10.0 tok/s')
  })

  it('shows the plugin burst rate through the host formatter on an ACP conversation', () => {
    const slots = makeSlots()
    const acp = acpState({
      chatSessions: [{ sessionId: 'acp-1', agentId: 'a', released: false, burst: { outputTokens: 100, burstMs: 2000 } }],
    })
    const claim = createActivityPillClaim({ slots, inject: sessionId => ({ acp, sessionId }) })
    claim?.sync()
    renderShadow(slots, acp)
    expect(screen.getByTestId('activity-pill').textContent).toBe('1 轮 2 步 · 50.0 tok/s')
  })

  it('prefers the live aggregate over the persisted row', () => {
    const slots = makeSlots()
    const acp = acpState({
      chatSessions: [{ sessionId: 'acp-1', agentId: 'a', released: false, burst: { outputTokens: 100, burstMs: 2000 } }],
      burstStats: { 'acp-1': { outputTokens: 150, burstMs: 3000, turnId: 't', final: false } },
    })
    const claim = createActivityPillClaim({ slots, inject: sessionId => ({ acp, sessionId }) })
    claim?.sync()
    renderShadow(slots, acp)
    expect(screen.getByTestId('activity-pill').textContent).toBe('1 轮 2 步 · 50.0 tok/s')
  })

  it('hides only the speed while the ACP session has no measurable burst', () => {
    const slots = makeSlots()
    const acp = acpState()
    const claim = createActivityPillClaim({ slots, inject: sessionId => ({ acp, sessionId }) })
    claim?.sync()
    renderShadow(slots, acp)
    const text = screen.getByTestId('activity-pill').textContent
    expect(text).toBe('1 轮 2 步')
    expect(text).not.toContain('tok/s')
  })

  it('restores the native entry when the claim is released', () => {
    const slots = makeSlots()
    const claim = createActivityPillClaim({ slots, inject: sessionId => ({ acp: acpState(), sessionId }) })
    claim?.sync()
    expect(slots.winner()?.component).not.toBe(HostActivityPill)
    claim?.release()
    expect(slots.raw(DOCK_SLOT)).toHaveLength(1)
    expect(slots.winner()?.component).toBe(HostActivityPill)
  })

  it('does not claim when the host entry, inject or locale is missing', () => {
    for (const slots of [
      makeSlots(false),
      makeSlots(true, false),
      makeSlots(true, true, false),
    ]) {
      expect(createActivityPillClaim({ slots, inject: () => ({}) })).toBeUndefined()
    }
  })
})

describe('activityBurst and patchedActivityStats', () => {
  it('sums every ACP session backing the chat, preferring live aggregates', () => {
    const ui = {
      chatSessionsFor: 'chat-1',
      chatSessions: [
        { sessionId: 'acp-1', agentId: 'a', released: false, burst: { outputTokens: 10, burstMs: 500 } },
        { sessionId: 'acp-0', agentId: 'a', released: true, burst: { outputTokens: 30, burstMs: 1000 } },
      ],
      burstStats: { 'acp-1': { outputTokens: 40, burstMs: 1000, turnId: 't', final: true } },
    }
    expect(activityBurst(ui, 'chat-1')).toEqual({ outputTokens: 70, burstMs: 2000 })
    expect(activityBurst(ui, 'chat-2')).toBeUndefined()
  })

  it('leaves non-ACP stats untouched and suppresses ACP speed without a burst', () => {
    expect(patchedActivityStats(nativeStats, { outputTokens: 100, burstMs: 2000 }, false)).toBe(nativeStats)
    expect(patchedActivityStats(nativeStats, undefined, true)).toEqual({
      ...nativeStats,
      decodeTokens: 0,
      decodeMs: 0,
    })
    expect(patchedActivityStats(nativeStats, { outputTokens: 100, burstMs: 2000 }, true)).toEqual({
      ...nativeStats,
      decodeTokens: 100,
      decodeMs: 2000,
    })
  })
})
