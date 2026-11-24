/**
 * Markdown `file://` link normalization for DSH's chat renderer: strips local
 * `file://` / `file://localhost` prefixes into plain paths so links open in
 * DSH's file sidebar, preserves code spans / fenced & indented blocks / remote
 * hosts / other schemes, shares `classifyLocalFileUrlHead` with attachment
 * normalization, and wraps `AcpLlmAdapter.stream` (`purpose === undefined`).
 */

import { describe, expect, it } from 'vitest'
import { AcpLlmAdapter, type BridgeManager } from '../../src/bridge.ts'
import {
  MarkdownFileLinkRewriter,
  classifyLocalFileUrlHead,
  normalizeFileUrlToPath,
  normalizeMarkdownFileLinks,
  rewriteStreamFileLinks,
} from '../../src/impl.ts'
import type { GenerateOptions, StreamChunk } from '../../src/protocol.ts'

function streamByChunks(chunks: string[]): string {
  const rewriter = new MarkdownFileLinkRewriter()
  let out = ''
  for (const chunk of chunks) out += rewriter.push(chunk)
  out += rewriter.flush()
  return out
}

async function collect(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const out: StreamChunk[] = []
  for await (const chunk of stream) out.push(chunk)
  return out
}

async function* chunksOf(items: StreamChunk[]): AsyncIterable<StreamChunk> {
  for (const item of items) yield item
}

function adapterWith(chunks: StreamChunk[]): AcpLlmAdapter {
  const fakeManager = {
    async *streamPrompt(_options: GenerateOptions): AsyncIterable<StreamChunk> {
      for (const chunk of chunks) yield chunk
    },
  } as unknown as BridgeManager
  return new AcpLlmAdapter(fakeManager)
}

describe('Markdown file:// link normalization', () => {
  it('rewrites POSIX file:/// and file://localhost/ links and preserves line anchors', () => {
    expect(normalizeMarkdownFileLinks('See [config.ts](file:///Users/gai/proj/src/config.ts)'))
      .toBe('See [config.ts](/Users/gai/proj/src/config.ts)')
    expect(normalizeMarkdownFileLinks('Lines [config.ts](file:///Users/gai/proj/src/config.ts#L10-L20) and [a.md](FILE://LOCALHOST/tmp/a.md:5)'))
      .toBe('Lines [config.ts](/Users/gai/proj/src/config.ts#L10-L20) and [a.md](/tmp/a.md:5)')
    expect(normalizeMarkdownFileLinks('Encoded [my doc](file:///Users/gai/my%20doc.md#L3)'))
      .toBe('Encoded [my doc](/Users/gai/my%20doc.md#L3)')
    expect(normalizeMarkdownFileLinks('Image ![shot](file:///Users/gai/shot.png)'))
      .toBe('Image ![shot](/Users/gai/shot.png)')
  })

  it('rewrites Windows drive paths only on confirmed drive:/ or drive%3A/ heads', () => {
    expect(normalizeMarkdownFileLinks('[app.ts](file:///C:/Users/dev/app.ts#L12)'))
      .toBe('[app.ts](C:/Users/dev/app.ts#L12)')
    expect(normalizeMarkdownFileLinks('[app.ts](file:///c:/Users/dev/app.ts)'))
      .toBe('[app.ts](c:/Users/dev/app.ts)')
    expect(normalizeMarkdownFileLinks('[app.ts](file://localhost/D:/work/app.ts)'))
      .toBe('[app.ts](D:/work/app.ts)')
    expect(normalizeMarkdownFileLinks('[app.ts](file:///C%3A/Users/dev/app.ts)'))
      .toBe('[app.ts](C:/Users/dev/app.ts)')
    expect(normalizeMarkdownFileLinks('[drive-a](file:///a%3A/b)'))
      .toBe('[drive-a](a:/b)')
    expect(normalizeMarkdownFileLinks('[bare](file:///a%3A)'))
      .toBe('[bare](/a%3A)')
    expect(normalizeMarkdownFileLinks('[colon](file:///a%3Ab/c)'))
      .toBe('[colon](/a%3Ab/c)')
    expect(normalizeMarkdownFileLinks('[esc](file:///a%30/b)'))
      .toBe('[esc](/a%30/b)')
  })

  it('shares classifyLocalFileUrlHead semantics with normalizeFileUrlToPath', () => {
    expect(classifyLocalFileUrlHead('/Users/a.ts')).toEqual({ kind: 'posix', consumed: 1 })
    expect(classifyLocalFileUrlHead('/C%3A/a.ts')).toEqual({ kind: 'drive', consumed: 6, driveLetter: 'C', sep: '/' })
    expect(classifyLocalFileUrlHead('/C%3A')).toEqual({ kind: 'incomplete' })
    expect(classifyLocalFileUrlHead('/a%3Ab/c')).toEqual({ kind: 'posix', consumed: 1 })
    expect(classifyLocalFileUrlHead('server/share/x.txt')).toEqual({ kind: 'remote' })

    expect(normalizeFileUrlToPath('file:///C%3A/work/a.png')).toBe('C:/work/a.png')
    expect(normalizeFileUrlToPath('file:///a:b/c')).toBe('/a:b/c')
    expect(normalizeFileUrlToPath('file:///a%3Ab/c')).toBe('/a:b/c')
  })

  it('supports CommonMark angle-bracketed destinations', () => {
    expect(normalizeMarkdownFileLinks('[notes](<file:///Users/gai/my notes.md>)'))
      .toBe('[notes](</Users/gai/my notes.md>)')
    expect(normalizeMarkdownFileLinks('[notes](<file:///C:/my notes.md>)'))
      .toBe('[notes](<C:/my notes.md>)')
    expect(normalizeMarkdownFileLinks('[notes](<file://localhost/Users/gai/my notes.md>)'))
      .toBe('[notes](</Users/gai/my notes.md>)')
  })

  it('leaves non-local file hosts, other URL schemes, and plain paths untouched', () => {
    const cases = [
      '[unc](file://fileserver/share/doc.txt)',
      '[remote](file://local/path/doc.txt)',
      '[web](https://example.com/file:///Users/a)',
      '[http](http://localhost:3000/a)',
      '[vscode](vscode://file/Users/gai/a.ts)',
      '[dsh](dsh-resource://file/session/s1/a.ts)',
      '[plain](/Users/gai/a.ts#L1)',
      '[rel](src/index.ts#L10-L20)',
      '[win](C:/Users/dev/a.ts)',
    ]
    for (const input of cases) {
      expect(normalizeMarkdownFileLinks(input)).toBe(input)
    }
  })

  it('does not rewrite links inside inline code spans, fenced blocks, indented code, or blockquote fences', () => {
    const input = [
      '    [indented-start](file:///Users/ind0.ts)',
      '    [indented-cont](file:///Users/ind0b.ts)',
      '',
      'Inline `[a](file:///Users/a.ts)` and ``[b](file:///Users/b.ts)`` then [c](file:///Users/c.ts).',
      '```markdown',
      '[inside-backtick](file:///Users/d.ts)',
      '```not-a-closing-fence',
      '[still-inside](file:///Users/e.ts)',
      '```',
      'After backtick fence: [f](file:///Users/f.ts)',
      '   ~~~md',
      '[inside-tilde](file:///Users/g.ts)',
      '   ~~~',
      'After tilde fence: [h](file:///C:/Users/h.ts)',
      '```[inline-three](file:///Users/i.ts)``` and [j](file:///Users/j.ts)',
      '',
      '    [indented-after-blank](file:///Users/ind1.ts)',
      '\t[tab-indented](file:///Users/ind2.ts)',
      '',
      'Paragraph line [p1](file:///Users/p1.ts)',
      '    continuation [p2](file:///Users/p2.ts)',
      '',
      '> ~~~md',
      '> [quoted-tilde](file:///Users/qt.ts)',
      '> ~~~',
      '> [after-qt](file:///Users/after-qt.ts)',
      '',
      '> ```ts',
      '> [quoted-unclosed-bt](file:///Users/qb.ts)',
      '',
      'Outside quote [outside](file:///Users/out.ts)',
    ].join('\n')

    const expected = [
      '    [indented-start](file:///Users/ind0.ts)',
      '    [indented-cont](file:///Users/ind0b.ts)',
      '',
      'Inline `[a](file:///Users/a.ts)` and ``[b](file:///Users/b.ts)`` then [c](/Users/c.ts).',
      '```markdown',
      '[inside-backtick](file:///Users/d.ts)',
      '```not-a-closing-fence',
      '[still-inside](file:///Users/e.ts)',
      '```',
      'After backtick fence: [f](/Users/f.ts)',
      '   ~~~md',
      '[inside-tilde](file:///Users/g.ts)',
      '   ~~~',
      'After tilde fence: [h](C:/Users/h.ts)',
      '```[inline-three](file:///Users/i.ts)``` and [j](/Users/j.ts)',
      '',
      '    [indented-after-blank](file:///Users/ind1.ts)',
      '\t[tab-indented](file:///Users/ind2.ts)',
      '',
      'Paragraph line [p1](/Users/p1.ts)',
      '    continuation [p2](/Users/p2.ts)',
      '',
      '> ~~~md',
      '> [quoted-tilde](file:///Users/qt.ts)',
      '> ~~~',
      '> [after-qt](/Users/after-qt.ts)',
      '',
      '> ```ts',
      '> [quoted-unclosed-bt](file:///Users/qb.ts)',
      '',
      'Outside quote [outside](/Users/out.ts)',
    ].join('\n')

    expect(normalizeMarkdownFileLinks(input)).toBe(expected)
  })

  it('resets unclosed inline backticks across blank lines but preserves single-newline spans', () => {
    expect(normalizeMarkdownFileLinks('A ` stray\n\nSee [a.ts](file:///Users/a.ts)'))
      .toBe('A ` stray\n\nSee [a.ts](/Users/a.ts)')
    expect(normalizeMarkdownFileLinks('`code\n[keep](file:///Users/a.ts)`'))
      .toBe('`code\n[keep](file:///Users/a.ts)`')
  })

  it('handles adversarial prefixes and preserves truncated mid-drive tails verbatim on flush', () => {
    expect(normalizeMarkdownFileLinks('[x](](file:///Users/a.ts)')).toBe('[x](](/Users/a.ts)')
    expect(normalizeMarkdownFileLinks('[x](file://foo](file:///Users/a.ts)')).toBe('[x](file://foo](/Users/a.ts)')
    expect(normalizeMarkdownFileLinks('[x](file://](file:///Users/a.ts)')).toBe('[x](file://](/Users/a.ts)')
    expect(normalizeMarkdownFileLinks('trailing ](file:')).toBe('trailing ](file:')
    expect(normalizeMarkdownFileLinks('trailing ](file:///')).toBe('trailing ](file:///')
    expect(normalizeMarkdownFileLinks('trailing ](file:///C')).toBe('trailing ](file:///C')
    expect(normalizeMarkdownFileLinks('trailing ](file:///C:')).toBe('trailing ](file:///C:')
    expect(normalizeMarkdownFileLinks('trailing ](file:///C%3')).toBe('trailing ](file:///C%3')
    expect(normalizeMarkdownFileLinks('trailing ](file:///C%3A')).toBe('trailing ](file:///C%3A')
    expect(normalizeMarkdownFileLinks('trailing ](file://localhost/C')).toBe('trailing ](file://localhost/C')
    expect(normalizeMarkdownFileLinks('trailing ](<file:///C')).toBe('trailing ](<file:///C')
    expect(normalizeMarkdownFileLinks('[root](file:///)')).toBe('[root](/)')
    expect(normalizeMarkdownFileLinks('[weird](file:///a:b/c)')).toBe('[weird](/a:b/c)')
  })

  it('produces identical output under every 1-char and 2-part chunk split', () => {
    const sample = [
      'A ` stray',
      '',
      '    [indented](file:///Users/keep-ind.ts)',
      '',
      '> ~~~md',
      '> [qt](file:///Users/keep-qt.ts)',
      '> ~~~',
      'Check [a.ts](file:///Users/gai/a.ts#L1-L5), [b.ts](file:///C:/proj/b.ts),',
      '[c.ts](file://localhost/Users/gai/c.ts), [d](<file:///Users/my file.md>),',
      '[unc](file://server/share/x.txt), and `[code](file:///keep.ts)`.',
      '```ts',
      'const link = "[keep](file:///inside.ts)"',
      '```',
      'Done: [e.ts](file:///D%3A/e.ts) and tail ](file:///C',
    ].join('\n')

    const expected = normalizeMarkdownFileLinks(sample)
    expect(streamByChunks([...sample])).toBe(expected)

    for (let cut = 1; cut < sample.length; cut++) {
      expect(streamByChunks([sample.slice(0, cut), sample.slice(cut)])).toBe(expected)
    }
  })
})

describe('rewriteStreamFileLinks', () => {
  it('rewrites split text-delta and reasoning-delta chunks and matching block-end blocks', async () => {
    const raw: StreamChunk[] = [
      { type: 'block-start', index: 0, blockType: 'reasoning' },
      { type: 'reasoning-delta', index: 0, text: 'Inspecting [a.ts](file:' },
      { type: 'reasoning-delta', index: 0, text: '///Users/gai/a.ts#L4)' },
      { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'Inspecting [a.ts](file:///Users/gai/a.ts#L4)' } },
      { type: 'block-start', index: 1, blockType: 'text' },
      { type: 'text-delta', index: 1, text: 'Updated [b.ts](file:///C:/work/' },
      { type: 'text-delta', index: 1, text: 'b.ts) and tail ](file:' },
      { type: 'block-end', index: 1, block: { type: 'text', text: 'Updated [b.ts](file:///C:/work/b.ts) and tail ](file:' } },
      { type: 'block-start', index: 2, blockType: 'tool-call' },
      { type: 'tool-call-delta', index: 2, id: 'c1', name: 'dsh_ntr__acp_tool_call', argumentsDelta: '{"description":"[keep](file:///x)"}' },
      { type: 'block-end', index: 2, block: { type: 'tool-call', id: 'c1', name: 'dsh_ntr__acp_tool_call', arguments: '{"description":"[keep](file:///x)"}' } },
      { type: 'usage', usage: { inputTokens: 0, outputTokens: 12 } },
      { type: 'finish', reason: { kind: 'stop' } },
    ]

    const out = await collect(rewriteStreamFileLinks(chunksOf(raw)))

    const reasoningDeltas = out.filter(c => c.type === 'reasoning-delta').map(c => c.text).join('')
    const reasoningEnd = out.find(c => c.type === 'block-end' && c.index === 0)
    expect(reasoningDeltas).toBe('Inspecting [a.ts](/Users/gai/a.ts#L4)')
    expect(reasoningEnd).toEqual({
      type: 'block-end',
      index: 0,
      block: { type: 'reasoning', text: 'Inspecting [a.ts](/Users/gai/a.ts#L4)' },
    })

    const textDeltas = out.filter(c => c.type === 'text-delta').map(c => c.text).join('')
    const textEnd = out.find(c => c.type === 'block-end' && c.index === 1)
    expect(textDeltas).toBe('Updated [b.ts](C:/work/b.ts) and tail ](file:')
    expect(textEnd).toEqual({
      type: 'block-end',
      index: 1,
      block: { type: 'text', text: 'Updated [b.ts](C:/work/b.ts) and tail ](file:' },
    })

    // Tool-call blocks pass through untouched.
    const toolDelta = out.find(c => c.type === 'tool-call-delta')
    const toolEnd = out.find(c => c.type === 'block-end' && c.index === 2)
    expect(toolDelta).toEqual(raw[9])
    expect(toolEnd).toEqual(raw[10])
  })
})

describe('AcpLlmAdapter Markdown file:// link rewriting', () => {
  it('rewrites local file:// links in conversation turns', async () => {
    const adapter = adapterWith([
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: 'Open [index.ts](file://' },
      { type: 'text-delta', index: 0, text: '/Users/gai/proj/index.ts#L10)' },
      { type: 'block-end', index: 0, block: { type: 'text', text: 'Open [index.ts](file:///Users/gai/proj/index.ts#L10)' } },
      { type: 'finish', reason: { kind: 'stop' } },
    ])

    const chunks = await collect(adapter.stream({
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

    const chunks = await collect(adapter.stream({
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
