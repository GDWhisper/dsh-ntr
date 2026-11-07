// @vitest-environment jsdom
/**
 * Task 3b: the read-only subagent detail overlay, rendered from the panel's
 * rows.
 *
 * WHAT THIS COVERS (the rest is pure logic and lives in the unit specs):
 * - a row click opens the module-level target and the `shell.overlay` dialog
 *   renders the chosen worker's record;
 * - the first open reads `subagents/detail` exactly once and a reopen does not
 *   ask again (the store's `loaded` flag is the gate);
 * - `error` is `unknown`: a string renders verbatim, an object / array keeps
 *   its shape as readable JSON, and a missing reason says so instead of
 *   leaving a blank line;
 * - the bounded markers (`omitted`, per-entry `truncatedChars`) are visible;
 * - an unknown record and an empty index say "unknown / unavailable for this
 *   run" — never "no subagents";
 * - Escape / the close button clear the target, and the dialog offers no
 *   action button besides closing (the surface is read-only).
 */

import type { ComponentType } from 'react'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { closeSubagentDetail, openSubagentDetail, subagentDetailIsOpen } from '../src/client/acp-ui.tsx'
import { OwnSubagentCatalog, SubagentDetailDialog } from '../src/client/subagent-panel.tsx'
import { subagentKey } from '../src/client/store.ts'
import type { AcpStore, SubagentDetailState } from '../src/client/store.ts'
import type { SubagentDetailEntry, SubagentRecord } from '../src/protocol.ts'

afterEach(() => {
  cleanup()
  closeSubagentDetail()
  vi.useRealTimers()
})

/** One plugin lifecycle record, with sane defaults. */
function record(patch: Partial<SubagentRecord> = {}): SubagentRecord {
  return {
    childId: 'acp:a',
    dshSessionId: 'chat-1',
    toolCallId: 'a',
    label: 'worker',
    status: 'running',
    startedAt: Date.now() - 5_000,
    lastActivityAt: Date.now() - 1_000,
    counts: { updates: 3, toolCalls: 2, textChars: 40 },
    ...patch,
  }
}

/** One raw detail entry. */
function entry(seq: number, update: unknown, truncatedChars?: number): SubagentDetailEntry {
  return { seq, update, ...(truncatedChars === undefined ? {} : { truncatedChars }) }
}

/** A fully-answered detail index (so the dialog never reaches for the RPC). */
function loadedDetail(
  patch: Partial<SubagentDetailState> = {},
  entries: SubagentDetailEntry[] = [],
): SubagentDetailState {
  return {
    dshSessionId: 'chat-1',
    childId: 'acp:a',
    entries,
    loaded: true,
    omitted: 0,
    touchedAt: 0,
    ...patch,
  }
}

interface FakeStore {
  store: AcpStore
  /** `subagents/detail` calls in order. */
  calls: Array<[dshSessionId: string, childId: string]>
}

/**
 * The minimal injected store the dialog reads: a mutable snapshot behind
 * `subscribe`, the bilingual label, and the one on-demand detail read. The
 * read answers with the given history and marks the index `loaded` — the same
 * contract the real `AcpStore.loadSubagentDetail` documents.
 */
function fakeStore(options: {
  records?: readonly SubagentRecord[]
  details?: Record<string, SubagentDetailState>
  history?: SubagentDetailEntry[]
  /** Answer the read never (a slow host): the dialog must stay in its loading state. */
  neverLoads?: boolean
} = {}): FakeStore {
  let state = {
    subagents: Object.fromEntries(
      (options.records ?? []).map(item => [subagentKey(item.dshSessionId, item.childId), item]),
    ),
    subagentDetails: { ...(options.details ?? {}) },
  }
  const listeners = new Set<() => void>()
  const calls: FakeStore['calls'] = []
  const store = {
    subscribe: (callback: () => void) => {
      listeners.add(callback)
      return () => { listeners.delete(callback) }
    },
    getSnapshot: () => state,
    label: (zh: string) => zh,
    loadSubagentDetail: (dshSessionId: string, childId: string) => {
      calls.push([dshSessionId, childId])
      if (options.neverLoads === true) return new Promise<void>(() => {})
      const key = subagentKey(dshSessionId, childId)
      state = {
        ...state,
        subagentDetails: {
          ...state.subagentDetails,
          [key]: {
            dshSessionId,
            childId,
            entries: (options.history ?? []).map(item => ({ ...item })),
            loaded: true,
            omitted: 0,
            touchedAt: Date.now(),
          },
        },
      }
      for (const listener of [...listeners]) listener()
      return Promise.resolve()
    },
  }
  return { store: store as unknown as AcpStore, calls }
}

/** The host's own trigger, only rendered on the panel's fail-open branch. */
const HostTrigger: ComponentType<Record<string, unknown>> = () => (
  <span data-testid="host-trigger">host</span>
)

/** The host projection hook, answering with one external row. */
const useSessions = (selector: (value: unknown) => unknown): unknown => selector({
  projectionsBySession: {
    'chat-1': {
      values: {
        subagentCatalog: [{ id: 'acp:a', mode: 'external', createdAt: Date.now() - 5_000, label: 'scanner' }],
      },
    },
  },
})

/** Flush the on-open detail read (a promise) inside React's act. */
async function flush(): Promise<void> {
  await act(async () => { await Promise.resolve() })
}

describe('the subagent detail overlay', () => {
  it('opens from a panel row and renders the chosen record', async () => {
    const item = record({ type: 'explore', label: 'scanner' })
    const { store } = fakeStore({ records: [item] })
    render(
      <>
        <OwnSubagentCatalog host={HostTrigger} acp={store} sessionId="chat-1" useSessions={useSessions} />
        <SubagentDetailDialog acp={store} />
      </>,
    )
    // Nothing is open until a row is chosen.
    expect(screen.queryByRole('dialog')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /累计 1 个/ }))
    fireEvent.click(screen.getByRole('button', { name: '查看 explore · scanner 的详情' }))
    const dialog = screen.getByRole('dialog', { name: '子智能体详情' })
    expect(within(dialog).getByText('explore · scanner')).toBeDefined()
    expect(within(dialog).getByText('运行中')).toBeDefined()
    expect(within(dialog).getByText(/2 次工具调用/)).toBeDefined()
    expect(subagentDetailIsOpen()).toEqual({ dshSessionId: 'chat-1', childId: 'acp:a' })
    await flush()
  })

  it('opens at the newest content and stops following once the reader scrolls up', () => {
    const key = subagentKey('chat-1', 'acp:a')
    const { store } = fakeStore({
      records: [record()],
      details: {
        [key]: loadedDetail({}, [
          entry(1, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'tail' } }),
        ]),
      },
    })
    act(() => { openSubagentDetail('chat-1', 'acp:a') })
    render(<SubagentDetailDialog acp={store} />)
    const dialog = screen.getByRole('dialog', { name: '子智能体详情' })
    const body = dialog.querySelector('.ntr-acp-dialog-body') as HTMLElement
    // The status summary lives outside the scrollport, so it stays on screen
    // while the content below is pinned to its newest frame.
    const summary = dialog.querySelector('.ntr-acp-subagent-detail-summary') as HTMLElement
    expect(summary).not.toBeNull()
    expect(body.contains(summary)).toBe(false)
    expect(summary.textContent ?? '').toContain('运行中')
    // jsdom has no layout: give the scrollport a measurable height.
    Object.defineProperty(body, 'scrollHeight', { configurable: true, get: () => 500 })
    Object.defineProperty(body, 'clientHeight', { configurable: true, get: () => 200 })

    // Any content re-render runs the pin effect; a fresh open lands at the end.
    fireEvent.click(screen.getByRole('button', { name: '原始事件' }))
    expect(body.scrollTop).toBe(500)

    // Scrolled away: the next content change must not yank the reader back.
    body.scrollTop = 100
    fireEvent.scroll(body)
    fireEvent.click(screen.getByRole('button', { name: '内容视图' }))
    expect(body.scrollTop).toBe(100)
  })

  it('shows a quiet loading placeholder until the history answers', () => {
    const { store } = fakeStore({ neverLoads: true })
    act(() => { openSubagentDetail('chat-1', 'acp:a') })
    render(<SubagentDetailDialog acp={store} />)
    expect(screen.getByText('正在读取明细…')).toBeDefined()
  })

  it('reads the history once on the first open and never again', async () => {
    const { store, calls } = fakeStore()
    act(() => { openSubagentDetail('chat-1', 'acp:a') })
    render(<SubagentDetailDialog acp={store} />)
    await flush()
    expect(calls).toEqual([['chat-1', 'acp:a']])
    expect(screen.getByText(/本次运行没有读到这个子智能体的明细/)).toBeDefined()

    // Close and reopen: the index is `loaded`, so no second read.
    fireEvent.click(screen.getByRole('button', { name: '关闭子智能体详情' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    act(() => { openSubagentDetail('chat-1', 'acp:a') })
    await flush()
    expect(calls).toHaveLength(1)
    expect(screen.getByRole('dialog', { name: '子智能体详情' })).toBeDefined()
  })

  it('renders a string failure reason verbatim', () => {
    const item = record({ status: 'failed', endedAt: Date.now(), error: 'quota exceeded' })
    const key = subagentKey('chat-1', 'acp:a')
    const { store } = fakeStore({ records: [item], details: { [key]: loadedDetail() } })
    act(() => { openSubagentDetail('chat-1', 'acp:a') })
    render(<SubagentDetailDialog acp={store} />)
    expect(screen.getByText('失败原因：')).toBeDefined()
    expect(screen.getByText('quota exceeded')).toBeDefined()
  })

  it('renders a structured failure reason as readable JSON without dropping its shape', () => {
    const item = record({
      status: 'failed',
      endedAt: Date.now(),
      error: { code: 429, detail: ['rate limited', 'retry later'] },
    })
    const key = subagentKey('chat-1', 'acp:a')
    const { store } = fakeStore({ records: [item], details: { [key]: loadedDetail() } })
    act(() => { openSubagentDetail('chat-1', 'acp:a') })
    render(<SubagentDetailDialog acp={store} />)
    const dialog = screen.getByRole('dialog', { name: '子智能体详情' })
    const text = dialog.textContent ?? ''
    expect(text).toContain('"code": 429')
    expect(text).toContain('"detail": [')
    expect(text).toContain('rate limited')
    expect(text).toContain('retry later')
  })

  it('says the agent gave no reason instead of leaving it blank', () => {
    const item = record({ status: 'failed', endedAt: Date.now() })
    const key = subagentKey('chat-1', 'acp:a')
    const { store } = fakeStore({ records: [item], details: { [key]: loadedDetail() } })
    act(() => { openSubagentDetail('chat-1', 'acp:a') })
    render(<SubagentDetailDialog acp={store} />)
    expect(screen.getByText('失败原因：agent 未给原因')).toBeDefined()
  })

  it('shows the bounded markers for omitted entries and a cut payload', () => {
    const key = subagentKey('chat-1', 'acp:a')
    const details = {
      [key]: loadedDetail({ omitted: 3 }, [
        entry(1, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hello' } }, 42),
      ]),
    }
    const { store } = fakeStore({ records: [record()], details })
    act(() => { openSubagentDetail('chat-1', 'acp:a') })
    render(<SubagentDetailDialog acp={store} />)
    expect(screen.getByText('更早的 3 条明细已省略')).toBeDefined()
    // The content view shows the retained text; the per-frame cut marker is
    // diagnostic detail and lives in the raw view.
    expect(screen.getByText('hello')).toBeDefined()
    fireEvent.click(screen.getByRole('button', { name: '原始事件' }))
    expect(screen.getByText('负载截断 42 字符')).toBeDefined()
  })

  it('renders the dispatch input and the folded worker stream, with raw frames on demand', () => {
    const key = subagentKey('chat-1', 'acp:a')
    const entries = [
      entry(4, {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'w1',
        _meta: { 'codebuddy.ai/parentToolCallId': 'a' },
        status: 'completed',
        content: [{ type: 'content', content: { type: 'text', text: 'tool result' } }],
      }),
      entry(1, {
        sessionUpdate: 'tool_call',
        toolCallId: 'a',
        title: 'Task',
        rawInput: { prompt: 'scan the repo', description: 'scan', subagent_type: 'explore', files: ['a.ts', 'b.ts'] },
      }),
      entry(2, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'worker says hi' } }),
      entry(3, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'thinking hard' } }),
      entry(5, { sessionUpdate: 'plan', entries: [{ content: 'step one', status: 'in_progress', priority: 'high' }] }),
      entry(6, { sessionUpdate: 'mystery_kind', foo: ['x', 'y'] }),
    ]
    const { store } = fakeStore({ records: [record()], details: { [key]: loadedDetail({}, entries) } })
    act(() => { openSubagentDetail('chat-1', 'acp:a') })
    render(<SubagentDetailDialog acp={store} />)
    const dialog = screen.getByRole('dialog', { name: '子智能体详情' })

    // Dispatch input: the named fields plus an array, kept as shape.
    expect(within(dialog).getByText('派遣入参')).toBeDefined()
    expect(dialog.textContent).toContain('scan the repo')
    expect(dialog.textContent).toContain('subagent_type')
    expect(dialog.textContent).toContain('b.ts')

    // Content view (default): bubbles, a continuous reasoning section that
    // starts expanded, tool cards, plans and one event card per unknown kind.
    // The dispatch's own tool_call is not a worker bubble.
    expect(within(dialog).getByText('worker says hi')).toBeDefined()
    expect(within(dialog).getByText('thinking hard')).toBeDefined()
    expect(within(dialog).getByText('思考过程').closest('details')?.open).toBe(true)
    expect(dialog.textContent).toContain('tool result')
    expect(dialog.textContent).toContain('step one')
    expect(dialog.textContent).toContain('mystery_kind')
    const eventCard = within(dialog).getByText('mystery_kind').closest('.ntr-acp-tool')
    expect(eventCard).not.toBeNull()
    fireEvent.click(within(eventCard as HTMLElement).getByRole('button', { name: '原始数据' }))
    expect(dialog.textContent).toContain('"foo"')

    // Raw frames are still one click away, in seq order.
    fireEvent.click(within(dialog).getByRole('button', { name: '原始事件' }))
    const kinds = [...dialog.querySelectorAll('[data-kind]')].map(node => node.getAttribute('data-kind'))
    expect(kinds).toEqual([
      'tool_call',
      'agent_message_chunk',
      'agent_thought_chunk',
      'tool_call_update',
      'plan',
      'mystery_kind',
    ])
  })

  it('says the state is unknown for a record without a terminal state', () => {
    const item = record({ status: 'unknown' })
    const key = subagentKey('chat-1', 'acp:a')
    const { store } = fakeStore({ records: [item], details: { [key]: loadedDetail() } })
    act(() => { openSubagentDetail('chat-1', 'acp:a') })
    render(<SubagentDetailDialog acp={store} />)
    const dialog = screen.getByRole('dialog', { name: '子智能体详情' })
    expect(within(dialog).getByText('状态未知')).toBeDefined()
    expect(within(dialog).getByText(/状态未知：agent 未上报终态/)).toBeDefined()
  })

  it('says the detail is unavailable for this run — not "no subagents" — when nothing was recorded', () => {
    const key = subagentKey('chat-1', 'acp:a')
    const { store } = fakeStore({ details: { [key]: loadedDetail() } })
    act(() => { openSubagentDetail('chat-1', 'acp:a') })
    render(<SubagentDetailDialog acp={store} />)
    const dialog = screen.getByRole('dialog', { name: '子智能体详情' })
    expect(within(dialog).getByText('没有生命周期记录')).toBeDefined()
    expect(within(dialog).getByText('这个子智能体没有生命周期记录，状态未知。')).toBeDefined()
    expect(within(dialog).getByText(/本次运行没有读到这个子智能体的明细/)).toBeDefined()
    expect(screen.queryByText('该 agent 未上报子智能体')).toBeNull()
  })

  it('closes from the close button and from Escape, and offers no other action', () => {
    const key = subagentKey('chat-1', 'acp:a')
    const { store } = fakeStore({ records: [record()], details: { [key]: loadedDetail() } })
    act(() => { openSubagentDetail('chat-1', 'acp:a') })
    render(<SubagentDetailDialog acp={store} />)
    let dialog = screen.getByRole('dialog', { name: '子智能体详情' })
    // Read-only: the only button in the frame is the close control.
    expect(within(dialog).getAllByRole('button')).toHaveLength(1)

    fireEvent.click(within(dialog).getByRole('button', { name: '关闭子智能体详情' }))
    expect(subagentDetailIsOpen()).toBeNull()
    expect(screen.queryByRole('dialog')).toBeNull()

    // Escape closes it too.
    act(() => { openSubagentDetail('chat-1', 'acp:a') })
    dialog = screen.getByRole('dialog', { name: '子智能体详情' })
    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect(subagentDetailIsOpen()).toBeNull()
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('keeps the composer’s Escape: an editor-focused Escape does not close', () => {
    const key = subagentKey('chat-1', 'acp:a')
    const { store } = fakeStore({ records: [record()], details: { [key]: loadedDetail() } })
    act(() => { openSubagentDetail('chat-1', 'acp:a') })
    render(
      <>
        <textarea data-testid="composer" />
        <SubagentDetailDialog acp={store} />
      </>,
    )
    const composer = screen.getByTestId('composer')
    composer.focus()
    fireEvent.keyDown(composer, { key: 'Escape' })
    expect(subagentDetailIsOpen()).toEqual({ dshSessionId: 'chat-1', childId: 'acp:a' })
    expect(screen.getByRole('dialog', { name: '子智能体详情' })).toBeDefined()
  })
})
