import { describe, expect, it } from 'vitest'
import {
  compactCompletionLine,
  compactionContentText,
  formatCompactionNotification,
  isCompactCommand,
} from '../../src/impl.ts'
import { foldUpdate, type Block } from '../../src/client/store/blocks.ts'

describe('compaction pure helpers', () => {
  it('recognizes /compact commands cleanly without catching ordinary prose', () => {
    expect(isCompactCommand('/compact')).toBe(true)
    expect(isCompactCommand('  /compact keep recent turns\nmore')).toBe(true)
    expect(isCompactCommand('/COMPACT')).toBe(true)
    expect(isCompactCommand('please explain /compact')).toBe(false)
    expect(isCompactCommand('/compaction-help')).toBe(false)
    expect(isCompactCommand('')).toBe(false)
  })

  it('extracts readable text from compaction payloads', () => {
    expect(compactionContentText('hello')).toBe('hello')
    expect(compactionContentText([{ type: 'text', text: 'line 1' }, { type: 'text', text: 'line 2' }])).toBe('line 1\nline 2')
    expect(compactionContentText({ type: 'content', content: { type: 'text', text: 'nested' } })).toBe('nested')
  })

  it('formats compaction_update lifecycle and dedupes repeated status ticks', () => {
    const statuses = new Map<string, string>()
    expect(formatCompactionNotification({ sessionUpdate: 'compaction_update', compactionId: 'c1', status: 'in_progress' }, statuses))
      .toContain('in progress')
    expect(formatCompactionNotification({ sessionUpdate: 'compaction_update', compactionId: 'c1', status: 'in_progress' }, statuses))
      .toBeUndefined()
    expect(formatCompactionNotification({ sessionUpdate: 'compaction_summary_chunk', compactionId: 'c1', content: { type: 'text', text: 'part A' } }, statuses))
      .toBe('part A')
    expect(formatCompactionNotification({
      sessionUpdate: 'compaction_update',
      compactionId: 'c1',
      status: 'completed',
      summary: [{ type: 'text', text: 'Retained summary' }],
    }, statuses)).toBe('[dsh-ntr] context compaction completed.\n\nRetained summary')

    expect(formatCompactionNotification({
      sessionUpdate: 'compaction_update',
      compactionId: 'c2',
      status: 'failed',
      error: 'context window empty',
    }, statuses)).toBe('[dsh-ntr] context compaction failed: context window empty')
  })

  it('builds non-alarmist completion line for silent /compact turns', () => {
    expect(compactCompletionLine('agy', 'end_turn')).toContain('completed context compaction')
    expect(compactCompletionLine('agy', 'max_tokens')).toContain('(max_tokens)')
  })
})

describe('foldUpdate compaction blocks', () => {
  it('merges compaction_update and compaction_summary_chunk into one event block per compactionId', () => {
    const blocks: Block[] = []
    expect(foldUpdate(blocks, { sessionUpdate: 'compaction_update', compactionId: 'cmp-1', status: 'in_progress' })).toBe(true)
    expect(foldUpdate(blocks, { sessionUpdate: 'compaction_summary_chunk', compactionId: 'cmp-1', content: { type: 'text', text: 'chunk 1 ' } })).toBe(true)
    expect(foldUpdate(blocks, { sessionUpdate: 'compaction_summary_chunk', compactionId: 'cmp-1', content: { type: 'text', text: 'chunk 2' } })).toBe(true)
    expect(foldUpdate(blocks, { sessionUpdate: 'compaction_update', compactionId: 'cmp-1', status: 'completed' })).toBe(true)
    expect(blocks).toHaveLength(1)
    expect(blocks[0]).toMatchObject({
      kind: 'event',
      event: 'compaction_update',
      compactionId: 'cmp-1',
      status: 'completed',
    })
    expect((blocks[0] as { text: string }).text).toContain('chunk 1 chunk 2')
  })
})
