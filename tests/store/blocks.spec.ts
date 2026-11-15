/**
 * Block folding, verbatim from `tests/store.spec.ts` (split plan P3a test
 * mirror): same describe title and case count, cases unchanged.
 */

import { describe, expect, it } from 'vitest'
import { foldUpdate } from '../../src/client/store/blocks.ts'
import type { Block } from '../../src/client/store/blocks.ts'

function fold(...updates: Array<Record<string, unknown>>): Block[] {
  const blocks: Block[] = []
  for (const update of updates) foldUpdate(blocks, update)
  return blocks
}

describe('foldUpdate', () => {
  it('merges same-messageId agent chunks and starts a new block on a new id', () => {
    const blocks = fold(
      { sessionUpdate: 'agent_message_chunk', messageId: 'm1', content: { type: 'text', text: 'Hello ' } },
      { sessionUpdate: 'agent_message_chunk', messageId: 'm1', content: { type: 'text', text: 'world' } },
      { sessionUpdate: 'agent_message_chunk', messageId: 'm2', content: { type: 'text', text: 'next' } },
    )
    expect(blocks).toEqual([
      { kind: 'agent', messageId: 'm1', text: 'Hello world' },
      { kind: 'agent', messageId: 'm2', text: 'next' },
    ])
  })

  it('merges message-less chunks into the previous same-kind block', () => {
    const blocks = fold(
      { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'a' } },
      { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'b' } },
      { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'think' } },
    )
    expect(blocks.map(b => b.kind)).toEqual(['user', 'thought'])
    expect(blocks[0]).toMatchObject({ text: 'ab' })
  })

  it('replaces blocks immutably: appended chunks swap the tail object, untouched rows keep their identity', () => {
    // The ACP view memoizes rows on the block object; a mutated tail would
    // look unchanged to React and the streamed text would never re-render.
    const blocks: Block[] = []
    foldUpdate(blocks, { sessionUpdate: 'agent_message_chunk', messageId: 'm1', content: { type: 'text', text: 'one' } })
    const firstRef = blocks[0]
    foldUpdate(blocks, { sessionUpdate: 'agent_message_chunk', messageId: 'm1', content: { type: 'text', text: ' two' } })
    expect(blocks[0]).not.toBe(firstRef)
    expect(blocks[0]).toMatchObject({ text: 'one two' })
    foldUpdate(blocks, { sessionUpdate: 'agent_message_chunk', messageId: 'm2', content: { type: 'text', text: 'next' } })
    expect(blocks[0]).toBe(blocks[0]) // the untouched earlier row keeps its identity
    expect(blocks[0]).toMatchObject({ text: 'one two' })
  })

  it('answers whether anything changed, and keeps raw lazy until a view reads it', () => {
    // Usage ticks fold to `false`: the batch then skips copying the blocks
    // array entirely (the coalescing flush keys off this return value).
    const blocks: Block[] = []
    expect(foldUpdate(blocks, { sessionUpdate: 'usage_update', used: 1, size: 2 })).toBe(false)
    expect(foldUpdate(blocks, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hi' } })).toBe(true)
    expect(foldUpdate(blocks, { sessionUpdate: 'config_option_update', configOptions: [] })).toBe(false)

    // `raw` is a lazy getter: folding a tool card costs no JSON, and reading
    // it once caches the pretty-print for the view's later renders.
    const toolBlocks: Block[] = []
    foldUpdate(toolBlocks, { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Bash', rawInput: '{"cmd":"ls"}' })
    const card = toolBlocks[0] as Extract<Block, { kind: 'tool' }>
    const raw = card.raw
    expect(raw).toContain('"toolCallId": "t1"')
    expect(card.raw).toBe(raw)
  })

  it('keeps a non-text chunk as its payload instead of a placeholder', () => {
    const blocks = fold({ sessionUpdate: 'agent_message_chunk', content: { type: 'image', data: 'x', mimeType: 'image/png' } })
    expect(blocks[0]).toMatchObject({ kind: 'agent' })
    expect((blocks[0] as { text: string }).text).toContain('image/png')
  })

  it('reads a chunk whose content is an object or an array of blocks', () => {
    const blocks = fold(
      { sessionUpdate: 'agent_thought_chunk', content: { text: 'nested' } },
      { sessionUpdate: 'agent_message_chunk', content: 'plain string' },
      { sessionUpdate: 'agent_message_chunk', messageId: 'm', content: [{ text: 'a' }, { text: 'b' }] },
    )
    expect(blocks.map(block => (block as { text: string }).text)).toEqual(['nested', 'plain string', 'ab'])
  })

  it('creates and merges tool cards by toolCallId, including content lines and arguments', () => {
    const blocks = fold(
      { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'run', kind: 'execute', status: 'pending', rawInput: '{"cmd":"ls"}' },
      { sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'in_progress' },
      { sessionUpdate: 'tool_call_update', toolCallId: 't1', title: 'run ls', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: 'file1\nfile2' } }] },
    )
    expect(blocks).toHaveLength(1)
    expect(blocks[0]).toMatchObject({
      kind: 'tool',
      toolCallId: 't1',
      title: 'run ls',
      status: 'completed',
      toolKind: 'execute',
      lines: ['file1\nfile2'],
      input: '{"cmd":"ls"}',
    })
  })

  it('keeps diffs as text AND as a diff, and an unknown content kind as its JSON', () => {
    const blocks = fold({
      sessionUpdate: 'tool_call',
      toolCallId: 't2',
      title: 'edit',
      content: [
        { type: 'diff', path: '/w/a.ts', oldText: 'one\ntwo\n', newText: 'one\nTWO\n' },
        { type: 'terminal', terminalId: 'term-7' },
      ],
    })
    const card = blocks[0] as Extract<Block, { kind: 'tool' }>
    expect(card.diffs).toEqual([{ path: '/w/a.ts', oldText: 'one\ntwo\n', newText: 'one\nTWO\n' }])
    expect(card.lines.join('\n')).toContain('- two')
    expect(card.lines.join('\n')).toContain('+ TWO')
    expect((card.extras ?? []).join('\n')).toContain('term-7')
    expect(card.raw).toContain('term-7')
  })

  it('materializes an update-only tool card when the original rolled out of the window', () => {
    const blocks = fold({ sessionUpdate: 'tool_call_update', toolCallId: 'ghost', status: 'completed' })
    expect(blocks[0]).toMatchObject({ kind: 'tool', toolCallId: 'ghost', status: 'completed' })
  })

  it('replaces the plan in place', () => {
    const blocks = fold(
      { sessionUpdate: 'plan', entries: [{ content: 'a', status: 'pending' }] },
      { sessionUpdate: 'plan', entries: [{ content: 'a', status: 'completed' }] },
    )
    expect(blocks).toHaveLength(1)
    expect(blocks[0]).toMatchObject({ kind: 'plan', entries: [{ content: 'a', status: 'completed' }] })
  })

  it('records a notification it has no card for as an event, and skips state-only frames', () => {
    expect(fold({ sessionUpdate: 'usage_update', used: 1, size: 2 })).toEqual([])
    expect(fold({ sessionUpdate: 'config_option_update', configOptions: [] })).toEqual([])
    const events = fold(
      { sessionUpdate: 'current_mode_update', currentModeId: 'plan' },
      { sessionUpdate: 'something_new', payload: { deep: true } },
    )
    expect(events[0]).toMatchObject({ kind: 'event', event: 'current_mode_update', text: 'plan' })
    expect((events[1] as { raw: string }).raw).toContain('"deep"')
  })
})
