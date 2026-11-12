// @vitest-environment jsdom
/**
 * Task 3: the read-only agy STEP view (the child's own brain transcript).
 *
 * The detail overlay routes on the `source: 'agy-transcript'` marker (and the
 * record's `childConversationId`): marked entries render as transcript steps —
 * text / thinking / tool cards / reports — NOT as `session/update` frames, and
 * the CodeBuddy rendering stays byte-identical for unmarked entries.
 *
 * Pinned here:
 * - `describeAgyStep` gives every step type a destination (constraint 29),
 *   unknown types fall back to a generic row with the verbatim JSON;
 * - the truncation marker is visible; a cut step keeps its retained text;
 * - read notices (`unreadable` / `bad-lines` / `window-cut`) say so explicitly;
 * - the surface is READ-ONLY: the close button is the only button (no cancel /
 *   retry / message — agy has no control plane);
 * - the parent turn's prose never splices into the step stream.
 */

import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { closeSubagentDetail, openSubagentDetail } from '../src/client/acp-ui.tsx'
import { SubagentDetailDialog } from '../src/client/subagent-detail.tsx'
import { agyStepStatusTone, describeAgyStep } from '../src/client/subagent-detail-agy.tsx'
import { subagentKey } from '../src/client/store.ts'
import type { AcpStore, SubagentDetailState } from '../src/client/store.ts'
import type { SubagentDetailEntry, SubagentRecord } from '../src/protocol.ts'

afterEach(() => {
  cleanup()
  closeSubagentDetail()
})

/** One agy lifecycle record (the brain conversationId routes the step view). */
function record(patch: Partial<SubagentRecord> = {}): SubagentRecord {
  return {
    childId: 'acp:d1',
    dshSessionId: 'chat-1',
    toolCallId: 'd1',
    label: 'License Migrator',
    childConversationId: 'child-1',
    status: 'completed',
    startedAt: Date.now() - 5_000,
    lastActivityAt: Date.now() - 1_000,
    endedAt: Date.now(),
    counts: { updates: 3, toolCalls: 1, textChars: 40 },
    ...patch,
  }
}

/** One marked transcript-step entry (the host's wire shape, verbatim). */
function stepEntry(seq: number, step: Record<string, unknown>, truncatedChars?: number): SubagentDetailEntry {
  return {
    seq,
    source: 'agy-transcript',
    update: { step_index: seq, source: 'MODEL', type: 'GENERIC', status: 'DONE', content: '', ...step },
    ...(truncatedChars === undefined ? {} : { truncatedChars }),
  }
}

/** One read notice entry (sorts after the steps). */
function noticeEntry(notice: string, lines?: number): SubagentDetailEntry {
  return {
    seq: Number.MAX_SAFE_INTEGER,
    source: 'agy-transcript',
    update: { notice, ...(lines === undefined ? {} : { lines }) },
  }
}

function loadedDetail(entries: SubagentDetailEntry[], patch: Partial<SubagentDetailState> = {}): SubagentDetailState {
  return {
    dshSessionId: 'chat-1',
    childId: 'acp:d1',
    entries,
    loaded: true,
    omitted: 0,
    touchedAt: 0,
    ...patch,
  }
}

/** The minimal injected store (same contract as subagent-detail.spec.tsx). */
function fakeStore(options: {
  records?: readonly SubagentRecord[]
  details?: Record<string, SubagentDetailState>
} = {}): AcpStore {
  const state = {
    subagents: Object.fromEntries(
      (options.records ?? []).map(item => [subagentKey(item.dshSessionId, item.childId), item]),
    ),
    subagentDetails: { ...(options.details ?? {}) },
  }
  const listeners = new Set<() => void>()
  return {
    subscribe: (callback: () => void) => {
      listeners.add(callback)
      return () => { listeners.delete(callback) }
    },
    getSnapshot: () => state,
    label: (zh: string) => zh,
    loadSubagentDetail: () => Promise.resolve(),
  } as unknown as AcpStore
}

/** Open the overlay on the one worker and render the dialog. */
function openDialog(store: AcpStore): HTMLElement {
  act(() => { openSubagentDetail('chat-1', 'acp:d1') })
  render(<SubagentDetailDialog acp={store} />)
  return screen.getByRole('dialog', { name: '子智能体详情' })
}

describe('describeAgyStep (pure step normalization)', () => {
  it('routes the four measured step types and keeps their payloads', () => {
    const user = describeAgyStep({ step_index: 0, type: 'USER_INPUT', status: 'DONE', content: 'the prompt' })
    expect(user.kind).toBe('user-input')
    expect(user.content).toBe('the prompt')
    const planner = describeAgyStep({ step_index: 1, type: 'PLANNER_RESPONSE', status: 'DONE', content: 'answer', thinking: 'hmm' })
    expect(planner.kind).toBe('planner')
    expect(planner.thinking).toBe('hmm')
    const tool = describeAgyStep({ step_index: 2, type: 'GENERIC', status: 'RUNNING', tool_calls: [{ name: 'run_command', args: { CommandLine: 'ls' } }] })
    expect(tool.kind).toBe('tool')
    expect(tool.tools).toEqual([{ name: 'run_command', args: { CommandLine: 'ls' } }])
    const system = describeAgyStep({ step_index: 3, type: 'SYSTEM_MESSAGE', status: 'DONE', content: '[Message] sender=child-1' })
    expect(system.kind).toBe('system')
    expect(system.content).toContain('[Message]')
  })

  it('a GENERIC step without tool calls is a generic step, not a tool card', () => {
    const view = describeAgyStep({ step_index: 1, type: 'GENERIC', status: 'DONE', content: 'Message sent to parent' })
    expect(view.kind).toBe('generic')
    expect(view.tools).toEqual([])
    expect(view.content).toBe('Message sent to parent')
  })

  it('an unknown type falls back to a generic row with the verbatim JSON', () => {
    const view = describeAgyStep({ step_index: 9, type: 'FUTURE_KIND', status: 'DONE', content: 'x', mystery: [1, 2] })
    expect(view.kind).toBe('unknown')
    expect(view.type).toBe('FUTURE_KIND')
    expect(view.raw).toContain('FUTURE_KIND')
    expect(view.raw).toContain('mystery')
  })

  it('extra keys on a known type keep a destination (nothing silently dropped)', () => {
    const view = describeAgyStep({ step_index: 1, type: 'PLANNER_RESPONSE', status: 'DONE', content: 'ok', token_count: 42 })
    expect(view.kind).toBe('planner')
    expect(view.raw).toContain('token_count')
  })

  it('keeps the error string and maps the status tone', () => {
    const view = describeAgyStep({ step_index: 2, type: 'GENERIC', status: 'ERROR', error: 'command exited 1' })
    expect(view.error).toBe('command exited 1')
    expect(agyStepStatusTone('ERROR')).toBe('fail')
    expect(agyStepStatusTone('RUNNING')).toBe('busy')
    expect(agyStepStatusTone('DONE')).toBe('done')
    expect(agyStepStatusTone('WHATEVER')).toBe('idle')
  })

  it('a host-cut step keeps its retained text, not a re-escaped JSON blob', () => {
    const view = describeAgyStep({ sessionUpdate: 'unknown', truncated: true, text: 'retained head\n… [truncated 5 chars]' })
    expect(view.cutText).toBe('retained head\n… [truncated 5 chars]')
  })

  it('read notices normalize to their own row kind', () => {
    expect(describeAgyStep({ notice: 'unreadable' }).kind).toBe('notice')
    const bad = describeAgyStep({ notice: 'bad-lines', lines: 3 })
    expect(bad.kind).toBe('notice')
    expect(bad.noticeLines).toBe(3)
    expect(describeAgyStep({ notice: 'window-cut' }).notice).toBe('window-cut')
  })

  it('fails open on a non-object payload instead of throwing', () => {
    const view = describeAgyStep('plain text')
    expect(view.kind).toBe('unknown')
    expect(view.raw).toContain('plain text')
    expect(describeAgyStep(null).kind).toBe('unknown')
  })
})

describe('the agy step view in the detail overlay', () => {
  it('renders the child step stream — text, thinking, tool card, report — not session/update blocks', () => {
    const key = subagentKey('chat-1', 'acp:d1')
    const entries = [
      stepEntry(0, { type: 'USER_INPUT', status: 'DONE', source: 'SYSTEM', content: 'migrate the license headers' }),
      stepEntry(1, { type: 'PLANNER_RESPONSE', status: 'DONE', content: 'working on it', thinking: 'check the headers first' }),
      stepEntry(2, { type: 'GENERIC', status: 'RUNNING', tool_calls: [{ name: 'run_command', args: { CommandLine: 'ls -la' } }] }),
      stepEntry(3, { type: 'SYSTEM_MESSAGE', status: 'DONE', source: 'SYSTEM', content: '[Message] sender=child-1 content=done' }),
    ]
    const dialog = openDialog(fakeStore({ records: [record()], details: { [key]: loadedDetail(entries) } }))
    const text = dialog.textContent ?? ''
    expect(text).toContain('migrate the license headers')
    expect(text).toContain('working on it')
    expect(text).toContain('check the headers first')
    expect(text).toContain('run_command')
    expect(text).toContain('CommandLine')
    expect(text).toContain('ls -la')
    expect(text).toContain('[Message] sender=child-1')
    // The step view has its own heading and no raw-frame toggle.
    expect(within(dialog).getByText('步骤流')).toBeDefined()
    expect(within(dialog).queryByRole('button', { name: '原始事件' })).toBeNull()
    // The parent turn's prose is not here: only the child's own steps render.
    expect(dialog.querySelectorAll('[data-step-type]').length).toBe(4)
  })

  it('an unknown step type renders a generic row with its JSON', () => {
    const key = subagentKey('chat-1', 'acp:d1')
    const entries = [stepEntry(0, { type: 'FUTURE_KIND', status: 'DONE', content: 'x', mystery: { a: 1 } })]
    const dialog = openDialog(fakeStore({ records: [record()], details: { [key]: loadedDetail(entries) } }))
    expect(dialog.textContent).toContain('FUTURE_KIND')
    expect(dialog.textContent).toContain('mystery')
  })

  it('shows the truncation marker and the retained text of a cut step', () => {
    const key = subagentKey('chat-1', 'acp:d1')
    const entries = [stepEntry(0, { sessionUpdate: 'unknown', truncated: true, text: 'retained head' }, 42)]
    const dialog = openDialog(fakeStore({ records: [record()], details: { [key]: loadedDetail(entries) } }))
    expect(within(dialog).getByText('负载截断 42 字符')).toBeDefined()
    expect(dialog.textContent).toContain('retained head')
  })

  it('says the transcript is unreadable explicitly', () => {
    const key = subagentKey('chat-1', 'acp:d1')
    const dialog = openDialog(fakeStore({ records: [record()], details: { [key]: loadedDetail([noticeEntry('unreadable')]) } }))
    expect(dialog.textContent).toContain('读不到这个子代理的 transcript')
  })

  it('states bad lines and the read window with their facts', () => {
    const key = subagentKey('chat-1', 'acp:d1')
    const entries = [
      stepEntry(0, { type: 'USER_INPUT', status: 'DONE', content: 'prompt' }),
      noticeEntry('bad-lines', 3),
      noticeEntry('window-cut'),
    ]
    const dialog = openDialog(fakeStore({ records: [record()], details: { [key]: loadedDetail(entries) } }))
    expect(dialog.textContent).toContain('3 行无法解析')
    expect(dialog.textContent).toContain('超出读取窗口')
    // Notices render after the steps (they are footnotes, not content).
    const text = dialog.textContent ?? ''
    expect(text.indexOf('prompt')).toBeLessThan(text.indexOf('3 行无法解析'))
  })

  it('is read-only: the close button is the ONLY button (no cancel / retry / message)', () => {
    const key = subagentKey('chat-1', 'acp:d1')
    const entries = [
      stepEntry(0, { type: 'USER_INPUT', status: 'DONE', content: 'prompt' }),
      stepEntry(1, { type: 'GENERIC', status: 'ERROR', error: 'command exited 1', tool_calls: [{ name: 'run_command', args: {} }] }),
    ]
    const dialog = openDialog(fakeStore({ records: [record()], details: { [key]: loadedDetail(entries) } }))
    expect(within(dialog).getAllByRole('button')).toHaveLength(1)
    expect(within(dialog).getByRole('button', { name: '关闭子智能体详情' })).toBeDefined()
    expect(dialog.textContent).toContain('command exited 1')
    expect(screen.queryByText(/取消|重试|发送/)).toBeNull()
  })

  it('an empty child transcript says "no steps yet", not the CodeBuddy empty copy', () => {
    const key = subagentKey('chat-1', 'acp:d1')
    const dialog = openDialog(fakeStore({ records: [record()], details: { [key]: loadedDetail([]) } }))
    expect(dialog.textContent).toContain('还没有步骤')
    expect(dialog.textContent).not.toContain('本次运行没有读到这个子智能体的明细')
  })

  it('unmarked CodeBuddy entries keep the existing frame rendering (routing fallback)', () => {
    const key = subagentKey('chat-1', 'acp:d1')
    const entries: SubagentDetailEntry[] = [
      { seq: 1, update: { sessionUpdate: 'tool_call', toolCallId: 'd1', title: 'Task', rawInput: { prompt: 'scan' } } },
      { seq: 2, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'worker says hi' } } },
    ]
    const dialog = openDialog(fakeStore({
      records: [record({ childConversationId: undefined })],
      details: { [key]: loadedDetail(entries) },
    }))
    expect(within(dialog).getByText('派遣入参')).toBeDefined()
    expect(dialog.textContent).toContain('worker says hi')
    expect(within(dialog).getByRole('button', { name: '原始事件' })).toBeDefined()
    expect(dialog.querySelectorAll('[data-step-type]').length).toBe(0)
  })

  it('live dispatch frames feed the header, never the step stream', () => {
    const key = subagentKey('chat-1', 'acp:d1')
    const entries: SubagentDetailEntry[] = [
      // A live-captured dispatch frame (no marker) alongside the read steps.
      { seq: 7, update: { sessionUpdate: 'tool_call', toolCallId: 'd1', title: 'Run invoke_subagent', rawInput: { Prompt: 'migrate' } } },
      stepEntry(0, { type: 'USER_INPUT', status: 'DONE', content: 'migrate the license headers' }),
    ]
    const dialog = openDialog(fakeStore({ records: [record()], details: { [key]: loadedDetail(entries) } }))
    expect(within(dialog).getByText('派遣入参')).toBeDefined()
    expect(dialog.textContent).toContain('migrate')
    // Only the marked step is in the stream; the wire frame is not a step.
    expect(dialog.querySelectorAll('[data-step-type]').length).toBe(1)
  })

  it('the omitted marker still shows above the step stream', () => {
    const key = subagentKey('chat-1', 'acp:d1')
    const entries = [stepEntry(5, { type: 'PLANNER_RESPONSE', status: 'DONE', content: 'tail' })]
    const dialog = openDialog(fakeStore({ records: [record()], details: { [key]: loadedDetail(entries, { omitted: 5 }) } }))
    expect(within(dialog).getByText('更早的 5 条明细已省略')).toBeDefined()
    expect(dialog.textContent).toContain('tail')
  })

  it('Escape still closes the step view', () => {
    const key = subagentKey('chat-1', 'acp:d1')
    openDialog(fakeStore({ records: [record()], details: { [key]: loadedDetail([stepEntry(0, { content: 'x' })]) } }))
    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})