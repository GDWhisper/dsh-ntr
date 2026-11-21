/**
 * Adapter stream boundary: `AcpLlmAdapter.stream()` normalizes local `file://`
 * Markdown links on conversation turns while leaving auxiliary calls
 * (`purpose !== undefined`, e.g. `session-title`) untouched.
 */

import { describe, expect, it } from 'vitest'
import { AcpLlmAdapter, type BridgeManager } from '../../src/bridge.ts'
import type { GenerateOptions, StreamChunk } from '../../src/protocol.ts'

function adapterWith(chunks: StreamChunk[]): AcpLlmAdapter {
  const fakeManager = {
    async *streamPrompt(_options: GenerateOptions): AsyncIterable<StreamChunk> {
      for (const chunk of chunks) yield chunk
    },
  } as unknown as BridgeManager
  return new AcpLlmAdapter(fakeManager)
}

async function drain(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const out: StreamChunk[] = []
  for await (const chunk of stream) out.push(chunk)
  return out
}

describe('AcpLlmAdapter Markdown file:// link rewriting', () => {
  it('rewrites local file:// links in conversation turns', async () => {
    const adapter = adapterWith([
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: 'Open [index.ts](file://' },
      { type: 'text-delta', index: 0, text: '/Users/gai/proj/index.ts#L10)' },
      { type: 'block-end', index: 0, block: { type: 'text', text: 'Open [index.ts](file:///Users/gai/proj/index.ts#L10)' } },
      { type: 'finish', reason: { kind: 'stop' } },
    ])

    const chunks = await drain(adapter.stream({
      provider: 'acp',
      model: 'antigravity',
      messages: [],
    }))

    expect(chunks.filter(c => c.type === 'text-delta').map(c => c.text).join(''))
      .toBe('Open [index.ts](/Users/gai/proj/index.ts#L10)')
    expect(chunks.find(c => c.type === 'block-end')).toEqual({
      type: 'block-end',
      index: 0,
      block: { type: 'text', text: 'Open [index.ts](/Users/gai/proj/index.ts#L10)' },
    })
  })

  it('leaves auxiliary calls with purpose set untouched', async () => {
    const rawText = '[NTR] Check [a.md](file:///Users/gai/a.md)'
    const adapter = adapterWith([
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: rawText },
      { type: 'block-end', index: 0, block: { type: 'text', text: rawText } },
      { type: 'finish', reason: { kind: 'stop' } },
    ])

    const chunks = await drain(adapter.stream({
      provider: 'acp',
      model: 'antigravity',
      messages: [],
      purpose: 'session-title',
    }))

    expect(chunks.filter(c => c.type === 'text-delta').map(c => c.text).join('')).toBe(rawText)
    expect(chunks.find(c => c.type === 'block-end')).toEqual({
      type: 'block-end',
      index: 0,
      block: { type: 'text', text: rawText },
    })
  })
})
