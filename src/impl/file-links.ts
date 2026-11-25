/**
 * Streaming normalizer for Markdown `file://` links emitted by ACP agents.
 *
 * Host coupling contract:
 * Agents such as Antigravity (`agy acp`) format local file references as
 * `[name](file:///abs/path#L10-L20)`. DSH's chat Markdown renderer first strips
 * `#...` fragments, calls `decodeURIComponent` on the path part, and then
 * accepts the destination as a clickable local file only when it matches the
 * host local-path whitelist (`/^(?:[\\/]\|\.{1,2}[\\/]|[a-z]:[\\/])/i`) OR
 * `!URL.canParse(decoded)`. A `file://` URI fails both checks and falls through
 * to an unclickable external anchor. If the host renderer changes that rule,
 * this rewriter will silently diverge (recorded in `AGENTS/architecture.md`).
 *
 * Streaming state-machine contract (`MarkdownFileLinkRewriter`):
 * - Bounded lookahead: `linkBuf` only holds an incomplete `](`/`](<` local-head
 *   prefix; `classifyLocalFileUrlHead` ends the wait at the first
 *   non-ambiguous character, so the buffer is bounded by construction
 *   (longest ambiguous prefix `](<file://localhost/C%3A/` is 25 chars).
 * - State set:
 *   1. Fenced code block (`fenceChar`, `fenceLen`, `fenceQuoteDepth`,
 *      `closingFencePending`, `pendingBacktickFence`, `pendingFenceQuoteDepth`)
 *   2. 4-space / tab indented code block (`canStartIndentedCode`,
 *      `inIndentedCode`) — entered only at document start or after a blank line
 *      (CommonMark §4.4), never mid-paragraph; the threshold is measured from
 *      the enclosing list item's content column when one is open
 *   3. Inline code span (`inlineTicks`) — reset across blank lines so an
 *      unclosed backtick in one paragraph never suppresses links in later ones
 *   4. Link prefix lookahead (`linkBuf`), delegating local authority & Windows
 *      drive classification to the shared `classifyLocalFileUrlHead` primitive
 *      in `src/impl/paths.ts`
 *   5. Backslash escapes (`escapePending`) — outside code an escaped delimiter
 *      is literal and never opens a span, fence, link or list marker
 *   6. Enclosing list items (`listStack`) — content indents tracked from bullet
 *      and ordered markers, popped on dedent or when the quote depth drops
 * - Reset / flush contract: `flush()` finishes any open delimiter run and emits
 *   raw `linkBuf` verbatim, so truncated EOF prefixes (`](file:///C`, etc.) are
 *   never mutated or truncated.
 *
 * Pure logic only — no Node APIs, no ACP SDK runtime values.
 */

import type { StreamChunk } from '../protocol.ts'
import { classifyLocalFileUrlHead } from './paths.ts'

const FILE_SCHEME = 'file://'

/**
 * Stateful, bounded-lookahead rewriter for Markdown `file://` link prefixes.
 *
 * Every transition is strictly single-character deterministic so arbitrary
 * chunk boundaries produce the exact same output as rewriting at once.
 */
export class MarkdownFileLinkRewriter {
  // Line-start prefix tracking (indent, blockquote depth, blank-line resets).
  private lineStart = true
  private lineIndent = 0
  private lineQuoteDepth = 0
  private afterQuoteMarker = false
  private lineHasContent = false
  private canStartIndentedCode = true
  private inIndentedCode = false
  private escapePending = false

  // Enclosing list items (content indents): indented code after a blank line is
  // measured from the item's content column, not from the page margin.
  private listStack: Array<{ readonly contentIndent: number; readonly quoteDepth: number }> = []
  private markerPhase: 'none' | 'bullet' | 'digits' | 'punct' | 'spaces' = 'none'
  private markerIndent = 0
  private markerLen = 0
  private markerDigits = 0
  private markerSpaces = 0
  private markerQuoteDepth = 0

  // Markdown code-context tracking so code examples are never modified.
  private fenceChar: '`' | '~' | null = null
  private fenceLen = 0
  private fenceQuoteDepth = 0
  private closingFencePending = false
  private pendingBacktickFence = 0
  private pendingFenceQuoteDepth = 0
  private inlineTicks = 0
  private runChar: '`' | '~' | null = null
  private runLen = 0
  private runAtFenceStart = false
  private runQuoteDepth = 0

  // Bounded link-prefix lookahead buffer (active iff non-empty, only outside code).
  private linkBuf = ''

  push(chunk: string): string {
    if (chunk === '') return ''
    let out = ''
    for (let i = 0; i < chunk.length; i++) {
      out += this.step(chunk[i]!)
    }
    return out
  }

  flush(): string {
    this.finishRun()
    if (this.linkBuf === '') return ''
    const out = this.linkBuf
    this.linkBuf = ''
    return out
  }

  private step(ch: string): string {
    // Finish any pending delimiter run before handling a non-matching char.
    if (this.runChar !== null && ch !== this.runChar) {
      this.finishRun()
    }

    // Active link-prefix matching (only entered outside code).
    if (this.linkBuf !== '') {
      return this.stepLink(ch)
    }

    // Inside a fenced code block: watch for blockquote drop or closing fence.
    if (this.fenceChar !== null) {
      return this.stepInsideFence(ch)
    }

    // Inside a 4-space / tab indented code line: pass through until newline.
    if (this.inIndentedCode) {
      if (ch === '\n') this.finishLine()
      return ch
    }

    // Inside a backtick fence opening line or an inline code span.
    if (this.pendingBacktickFence > 0 || this.inlineTicks > 0) {
      return this.stepInsideInlineOrOpeningLine(ch)
    }

    // Line-start whitespace / blockquote prefixes (outside code).
    if (this.lineStart && this.consumeLinePrefix(ch)) {
      return ch
    }
    if (ch === '\n') {
      this.advanceMarkerProbe(ch)
      this.finishLine()
      return ch
    }

    // First non-prefix character on a line: decide whether indented code starts.
    if (this.lineStart) {
      this.pruneListStack()
      if (this.lineIndent >= this.indentedCodeThreshold() && this.canStartIndentedCode) {
        this.inIndentedCode = true
        this.lineStart = false
        this.lineHasContent = true
        return ch
      }
      this.canStartIndentedCode = false
      this.startMarkerProbe(ch)
    } else {
      this.advanceMarkerProbe(ch)
    }

    // Outside code an escaped character is literal: it cannot open a fence,
    // close a span, start a link, or extend a list marker.
    if (this.escapePending) {
      this.escapePending = false
      this.lineStart = false
      this.lineHasContent = true
      return ch
    }
    if (ch === '\\') {
      this.escapePending = true
      this.lineStart = false
      this.lineHasContent = true
      return ch
    }

    // Outside code: check for fence/inline-code delimiters first.
    if (ch === '`' || (ch === '~' && (this.runChar === '~' || (this.lineStart && this.lineIndent <= 3)))) {
      if (this.runChar === null) {
        this.runChar = ch
        this.runLen = 1
        this.runAtFenceStart = this.lineStart && this.lineIndent <= 3
        this.runQuoteDepth = this.lineQuoteDepth
        this.lineStart = false
        this.lineHasContent = true
      } else {
        this.runLen += 1
      }
      return ch
    }

    this.lineStart = false
    this.lineHasContent = true

    if (ch === ']') {
      this.linkBuf = ']'
      return ''
    }
    return ch
  }

  private consumeLinePrefix(ch: string): boolean {
    if (ch === '\r') return true
    if (ch === ' ') {
      if (this.afterQuoteMarker) {
        this.afterQuoteMarker = false
      } else {
        this.lineIndent += 1
      }
      return true
    }
    if (ch === '\t') {
      if (this.afterQuoteMarker) {
        this.afterQuoteMarker = false
        this.lineIndent += 2
      } else {
        this.lineIndent += 4 - (this.lineIndent % 4)
      }
      return true
    }
    if (ch === '>' && this.lineIndent <= 3) {
      this.lineQuoteDepth += 1
      this.lineIndent = 0
      this.afterQuoteMarker = true
      return true
    }
    this.afterQuoteMarker = false
    return false
  }

  private finishLine(): void {
    if (!this.lineHasContent) {
      // Blank line resets unclosed inline backticks and permits indented code.
      this.inlineTicks = 0
      this.canStartIndentedCode = true
    }
    this.inIndentedCode = false
    this.lineStart = true
    this.lineIndent = 0
    this.lineQuoteDepth = 0
    this.afterQuoteMarker = false
    this.lineHasContent = false
    this.escapePending = false
    this.markerPhase = 'none'
  }

  private pruneListStack(): void {
    while (this.listStack.length > 0) {
      const top = this.listStack[this.listStack.length - 1]!
      if (top.quoteDepth > this.lineQuoteDepth || this.lineIndent < top.contentIndent) {
        this.listStack.pop()
      } else {
        break
      }
    }
  }

  private indentedCodeThreshold(): number {
    const top = this.listStack[this.listStack.length - 1]
    return top === undefined ? 4 : top.contentIndent + 4
  }

  private startMarkerProbe(ch: string): void {
    this.markerQuoteDepth = this.lineQuoteDepth
    this.markerIndent = this.lineIndent
    this.markerDigits = 0
    this.markerSpaces = 0
    if (ch === '-' || ch === '+' || ch === '*') {
      this.markerPhase = 'bullet'
      this.markerLen = 1
    } else if (ch >= '0' && ch <= '9') {
      this.markerPhase = 'digits'
      this.markerLen = 1
      this.markerDigits = 1
    } else {
      this.markerPhase = 'none'
    }
  }

  private advanceMarkerProbe(ch: string): void {
    if (ch === '\r') return
    switch (this.markerPhase) {
      case 'none':
        return
      case 'bullet':
        if (ch === ' ' || ch === '\t') this.beginMarkerSpaces()
        else if (ch === '\n') this.confirmMarker(1)
        else this.markerPhase = 'none'
        return
      case 'digits':
        if (ch >= '0' && ch <= '9' && this.markerDigits < 9) {
          this.markerDigits += 1
          this.markerLen += 1
        } else if ((ch === '.' || ch === ')') && this.markerDigits > 0) {
          this.markerPhase = 'punct'
          this.markerLen += 1
        } else {
          this.markerPhase = 'none'
        }
        return
      case 'punct':
        if (ch === ' ' || ch === '\t') this.beginMarkerSpaces()
        else if (ch === '\n') this.confirmMarker(1)
        else this.markerPhase = 'none'
        return
      case 'spaces':
        if (ch === ' ' || ch === '\t') {
          this.markerSpaces += 1
        } else {
          // CommonMark: 5+ spaces after the marker keep W = 1.
          this.confirmMarker(this.markerSpaces > 4 ? 1 : this.markerSpaces)
        }
        return
    }
  }

  private beginMarkerSpaces(): void {
    this.markerPhase = 'spaces'
    this.markerSpaces = 1
  }

  private confirmMarker(spaces: number): void {
    this.markerPhase = 'none'
    if (this.listStack.length >= 16) return
    this.listStack.push({
      contentIndent: this.markerIndent + this.markerLen + spaces,
      quoteDepth: this.markerQuoteDepth,
    })
  }

  private closeFence(): void {
    this.fenceChar = null
    this.fenceLen = 0
    this.fenceQuoteDepth = 0
    this.closingFencePending = false
    this.canStartIndentedCode = true
  }

  private stepInsideFence(ch: string): string {
    if (this.closingFencePending) {
      if (ch === ' ' || ch === '\t' || ch === '\r') return ch
      if (ch === '\n') {
        this.closeFence()
        this.finishLine()
        return ch
      }
      this.closingFencePending = false
      this.lineHasContent = true
      return ch
    }
    if (this.lineStart && this.consumeLinePrefix(ch)) {
      return ch
    }
    if (ch === '\n') {
      if (this.lineQuoteDepth < this.fenceQuoteDepth) {
        this.closeFence()
      }
      this.finishLine()
      return ch
    }
    // Leaving a blockquote terminates any fenced code block opened inside it.
    if (this.lineStart && this.lineQuoteDepth < this.fenceQuoteDepth) {
      this.closeFence()
      return this.step(ch)
    }
    if (
      ch === this.fenceChar
      && (this.runChar === ch || (this.lineStart && this.lineIndent <= 3 && this.lineQuoteDepth === this.fenceQuoteDepth))
    ) {
      if (this.runChar === null) {
        this.runChar = ch
        this.runLen = 1
        this.runAtFenceStart = true
        this.runQuoteDepth = this.lineQuoteDepth
        this.lineStart = false
        this.lineHasContent = true
      } else {
        this.runLen += 1
      }
      return ch
    }
    this.lineStart = false
    this.lineHasContent = true
    return ch
  }

  private stepInsideInlineOrOpeningLine(ch: string): string {
    if (ch === '`') {
      if (this.runChar === null) {
        this.runChar = '`'
        this.runLen = 1
        this.runAtFenceStart = false
        this.runQuoteDepth = this.lineQuoteDepth
      } else {
        this.runLen += 1
      }
      this.lineStart = false
      this.lineHasContent = true
      return ch
    }
    if (ch === '\n' && this.pendingBacktickFence > 0) {
      // Opening line ended without another backtick: confirmed fenced code block.
      this.fenceChar = '`'
      this.fenceLen = this.pendingBacktickFence
      this.fenceQuoteDepth = this.pendingFenceQuoteDepth
      this.pendingBacktickFence = 0
      this.pendingFenceQuoteDepth = 0
      this.finishLine()
      return ch
    }
    if (this.lineStart && this.consumeLinePrefix(ch)) {
      return ch
    }
    if (ch === '\n') {
      this.finishLine()
      return ch
    }
    this.lineStart = false
    this.lineHasContent = true
    return ch
  }

  private finishRun(): void {
    const ch = this.runChar
    const len = this.runLen
    const atFenceStart = this.runAtFenceStart
    const quoteDepth = this.runQuoteDepth
    this.runChar = null
    this.runLen = 0
    this.runAtFenceStart = false
    this.runQuoteDepth = 0
    if (ch === null) return

    if (this.fenceChar !== null) {
      if (atFenceStart && ch === this.fenceChar && len >= this.fenceLen) {
        this.closingFencePending = true
      }
      return
    }
    if (this.pendingBacktickFence > 0) {
      // Another backtick on the opening line means it was an inline code span,
      // not a fenced code block (CommonMark §4.5).
      if (len === this.pendingBacktickFence) {
        this.pendingBacktickFence = 0
        this.pendingFenceQuoteDepth = 0
      } else {
        this.inlineTicks = this.pendingBacktickFence
        this.pendingBacktickFence = 0
        this.pendingFenceQuoteDepth = 0
      }
      return
    }
    if (this.inlineTicks > 0) {
      if (ch === '`' && len === this.inlineTicks) {
        this.inlineTicks = 0
      }
      return
    }
    if (atFenceStart && len >= 3) {
      if (ch === '~') {
        this.fenceChar = '~'
        this.fenceLen = len
        this.fenceQuoteDepth = quoteDepth
      } else {
        this.pendingBacktickFence = len
        this.pendingFenceQuoteDepth = quoteDepth
      }
      return
    }
    if (ch === '`') {
      this.inlineTicks = len
    }
  }

  private stepLink(ch: string): string {
    const buf = this.linkBuf
    if (buf === ']') {
      if (ch === '(') {
        this.linkBuf = ']('
        return ''
      }
      return this.abortLink(ch)
    }
    if (buf === '](' && ch === '<') {
      this.linkBuf = '](<'
      return ''
    }
    const openerLen = buf.startsWith('](<') ? 3 : 2
    const afterOpener = buf.slice(openerLen)
    if (afterOpener.length < FILE_SCHEME.length) {
      if (ch.toLowerCase() === FILE_SCHEME[afterOpener.length]) {
        this.linkBuf += ch
        return ''
      }
      return this.abortLink(ch)
    }
    const nextAfterScheme = afterOpener.slice(FILE_SCHEME.length) + ch
    const head = classifyLocalFileUrlHead(nextAfterScheme)
    if (head.kind === 'incomplete') {
      this.linkBuf += ch
      return ''
    }
    if (head.kind === 'remote') {
      return this.abortLink(ch)
    }
    const opener = openerLen === 3 ? '](<' : ']('
    this.linkBuf = ''
    if (head.kind === 'drive') {
      this.lineStart = false
      this.lineHasContent = true
      return `${opener}${head.driveLetter}:${head.sep}`
    }
    const tail = nextAfterScheme.slice(head.consumed)
    let out = `${opener}/`
    for (let i = 0; i < tail.length; i++) {
      out += this.step(tail[i]!)
    }
    return out
  }

  private abortLink(ch: string): string {
    const flushed = this.linkBuf
    this.linkBuf = ''
    return flushed + this.step(ch)
  }
}

/** Rewrite Markdown `file://` local-file links in one complete text string. */
export function normalizeMarkdownFileLinks(text: string): string {
  if (!text.includes('](')) return text
  const rewriter = new MarkdownFileLinkRewriter()
  return rewriter.push(text) + rewriter.flush()
}

interface BlockRewriterState {
  readonly blockType: 'text' | 'reasoning'
  readonly rewriter: MarkdownFileLinkRewriter
}

/**
 * Wrap an `AsyncIterable<StreamChunk>` so local `file://` Markdown links in
 * `text` and `reasoning` blocks become plain paths that DSH's chat renderer
 * opens directly in its file sidebar.
 */
export async function* rewriteStreamFileLinks(source: AsyncIterable<StreamChunk>): AsyncIterable<StreamChunk> {
  const blocks = new Map<number, BlockRewriterState>()
  for await (const chunk of source) {
    if (chunk.type === 'block-start') {
      if (chunk.blockType === 'text' || chunk.blockType === 'reasoning') {
        blocks.set(chunk.index, { blockType: chunk.blockType, rewriter: new MarkdownFileLinkRewriter() })
      }
      yield chunk
      continue
    }
    if (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta') {
      let state = blocks.get(chunk.index)
      if (state === undefined) {
        state = {
          blockType: chunk.type === 'reasoning-delta' ? 'reasoning' : 'text',
          rewriter: new MarkdownFileLinkRewriter(),
        }
        blocks.set(chunk.index, state)
      }
      const text = state.rewriter.push(chunk.text)
      if (text !== '') yield { ...chunk, text }
      continue
    }
    if (chunk.type === 'block-end') {
      const state = blocks.get(chunk.index)
      if (state !== undefined) {
        blocks.delete(chunk.index)
        const tail = state.rewriter.flush()
        if (tail !== '') {
          yield state.blockType === 'reasoning'
            ? { type: 'reasoning-delta', index: chunk.index, text: tail }
            : { type: 'text-delta', index: chunk.index, text: tail }
        }
      }
      const block = chunk.block
      if (typeof block === 'object' && block !== null) {
        const row = block as { type?: unknown; text?: unknown }
        if ((row.type === 'text' || row.type === 'reasoning') && typeof row.text === 'string') {
          const rewritten = normalizeMarkdownFileLinks(row.text)
          if (rewritten !== row.text) {
            yield { ...chunk, block: { ...row, text: rewritten } }
            continue
          }
        }
      }
      yield chunk
      continue
    }
    if (chunk.type === 'finish') {
      for (const [index, state] of blocks) {
        const tail = state.rewriter.flush()
        if (tail !== '') {
          yield state.blockType === 'reasoning'
            ? { type: 'reasoning-delta', index, text: tail }
            : { type: 'text-delta', index, text: tail }
        }
      }
      blocks.clear()
      yield chunk
      continue
    }
    yield chunk
  }
}
