/**
 * Streaming normalizer for Markdown `file://` links emitted by ACP agents.
 *
 * Agents such as Antigravity (`agy acp`) format local file references as
 * `[name](file:///abs/path#L10-L20)`. DSH's chat Markdown renderer only treats
 * a link destination as a clickable local file when `URL.canParse()` returns
 * false (plain POSIX paths `/...`, relative paths `./...`, or Windows drive
 * paths `C:/...`): a `file://` URI falls through to the external-link anchor
 * without a click handler, so it looks like a link but cannot be opened.
 *
 * Rewriting `](file:///` and `](file://localhost/` (and their `<...>` forms)
 * to bare paths at the adapter stream boundary makes links open in DSH's file
 * sidebar while leaving the ACP transcript, echo guard, code blocks, inline
 * code, non-local UNC hosts, and non-`file:` URLs untouched.
 *
 * Pure logic only — no Node APIs, no ACP SDK runtime values.
 */

import type { StreamChunk } from '../protocol.ts'

const FILE_SCHEME = 'file://'
const LOCALHOST_HOST = 'localhost/'

type LinkPhase = 'none' | 'prefix' | 'drive'

function isAsciiLetter(ch: string): boolean {
  const code = ch.charCodeAt(0)
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122)
}

/**
 * Stateful, bounded-lookahead rewriter for Markdown `file://` link prefixes.
 *
 * Only holds back characters while matching a `](file://...` prefix (at most
 * ~26 chars) so arbitrary chunk boundaries produce the exact same output as
 * rewriting the full string at once.
 */
export class MarkdownFileLinkRewriter {
  // Markdown code-context tracking so code examples are never modified.
  private lineStart = true
  private lineIndent = 0
  private fenceChar: '`' | '~' | null = null
  private fenceLen = 0
  private closingFencePending = false
  private pendingBacktickFence = 0
  private inlineTicks = 0
  private runChar: '`' | '~' | null = null
  private runLen = 0
  private runAtFenceStart = false

  // Link prefix lookahead state (only active outside code).
  private linkPhase: LinkPhase = 'none'
  private linkBuf = ''
  private driveBuf = ''

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
    if (this.linkPhase === 'none') return ''
    let out: string
    if (this.linkPhase === 'prefix') {
      out = this.linkBuf
    } else if (this.driveBuf === '') {
      out = this.linkBuf
    } else {
      const opener = this.linkBuf.startsWith('](<') ? '](<' : ']('
      out = `${opener}/${this.driveBuf}`
    }
    this.linkPhase = 'none'
    this.linkBuf = ''
    this.driveBuf = ''
    return out
  }

  private step(ch: string): string {
    // Finish any pending delimiter run before handling a non-matching char.
    if (this.runChar !== null && ch !== this.runChar) {
      this.finishRun()
    }

    // Active link-prefix matching (only entered outside code).
    if (this.linkPhase !== 'none') {
      return this.stepLink(ch)
    }

    // Inside a fenced code block: only watch for a valid closing fence.
    if (this.fenceChar !== null) {
      return this.stepInsideFence(ch)
    }

    // Inside a backtick fence opening line or an inline code span.
    if (this.pendingBacktickFence > 0 || this.inlineTicks > 0) {
      return this.stepInsideInlineOrOpeningLine(ch)
    }

    // Outside code: check for fence/inline-code delimiters first.
    if (ch === '`' || (ch === '~' && (this.runChar === '~' || (this.lineStart && this.lineIndent <= 3)))) {
      if (this.runChar === null) {
        this.runChar = ch
        this.runLen = 1
        this.runAtFenceStart = this.lineStart && this.lineIndent <= 3
        this.lineStart = false
      } else {
        this.runLen += 1
      }
      return ch
    }

    this.advanceLineState(ch)

    if (ch === ']') {
      this.linkPhase = 'prefix'
      this.linkBuf = ']'
      return ''
    }
    return ch
  }

  private stepInsideFence(ch: string): string {
    if (this.closingFencePending) {
      if (ch === ' ' || ch === '\t' || ch === '\r') return ch
      if (ch === '\n') {
        this.fenceChar = null
        this.fenceLen = 0
        this.closingFencePending = false
        this.lineStart = true
        this.lineIndent = 0
        return ch
      }
      this.closingFencePending = false
      return ch
    }
    if (ch === this.fenceChar && (this.runChar === ch || (this.lineStart && this.lineIndent <= 3))) {
      if (this.runChar === null) {
        this.runChar = ch
        this.runLen = 1
        this.runAtFenceStart = true
        this.lineStart = false
      } else {
        this.runLen += 1
      }
      return ch
    }
    this.advanceLineState(ch)
    return ch
  }

  private stepInsideInlineOrOpeningLine(ch: string): string {
    if (ch === '`') {
      if (this.runChar === null) {
        this.runChar = '`'
        this.runLen = 1
        this.runAtFenceStart = false
      } else {
        this.runLen += 1
      }
      this.lineStart = false
      return ch
    }
    if (ch === '\n' && this.pendingBacktickFence > 0) {
      // Opening line ended without another backtick: confirmed fenced code block.
      this.fenceChar = '`'
      this.fenceLen = this.pendingBacktickFence
      this.pendingBacktickFence = 0
      this.lineStart = true
      this.lineIndent = 0
      return ch
    }
    this.advanceLineState(ch)
    return ch
  }

  private finishRun(): void {
    const ch = this.runChar
    const len = this.runLen
    const atFenceStart = this.runAtFenceStart
    this.runChar = null
    this.runLen = 0
    this.runAtFenceStart = false
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
      } else {
        this.inlineTicks = this.pendingBacktickFence
        this.pendingBacktickFence = 0
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
      } else {
        this.pendingBacktickFence = len
      }
      return
    }
    if (ch === '`') {
      this.inlineTicks = len
    }
  }

  private advanceLineState(ch: string): void {
    if (ch === '\n') {
      this.lineStart = true
      this.lineIndent = 0
    } else if (this.lineStart && ch === ' ') {
      this.lineIndent += 1
    } else if (ch !== '\r') {
      this.lineStart = false
    }
  }

  private stepLink(ch: string): string {
    if (this.linkPhase === 'prefix') {
      return this.stepLinkPrefix(ch)
    }
    return this.stepDrivePeek(ch)
  }

  private stepLinkPrefix(ch: string): string {
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
    const hostPart = afterOpener.slice(FILE_SCHEME.length)
    if (hostPart === '' && ch === '/') {
      this.linkBuf += '/'
      this.linkPhase = 'drive'
      this.driveBuf = ''
      return ''
    }
    if (ch.toLowerCase() === LOCALHOST_HOST[hostPart.length]) {
      this.linkBuf += ch
      if (hostPart.length + 1 === LOCALHOST_HOST.length) {
        this.linkPhase = 'drive'
        this.driveBuf = ''
      }
      return ''
    }
    return this.abortLink(ch)
  }

  private stepDrivePeek(ch: string): string {
    const opener = this.linkBuf.startsWith('](<') ? '](<' : ']('
    const d = this.driveBuf
    if (d.length === 0) {
      if (isAsciiLetter(ch)) {
        this.driveBuf = ch
        return ''
      }
      return this.finishLink(`${opener}/`, ch)
    }
    if (d.length === 1) {
      if (ch === ':' || ch === '%') {
        this.driveBuf += ch
        return ''
      }
      return this.finishLink(`${opener}/${d}`, ch)
    }
    if (d.length === 2) {
      if (d[1] === ':') {
        if (ch === '/' || ch === '\\') {
          this.resetLink()
          this.advanceLineState(ch)
          return `${opener}${d}${ch}`
        }
        return this.finishLink(`${opener}/${d}`, ch)
      }
      if (ch === '3') {
        this.driveBuf += ch
        return ''
      }
      return this.finishLink(`${opener}/${d}`, ch)
    }
    if (d.length === 3) {
      if (ch === 'a' || ch === 'A') {
        this.driveBuf += ch
        return ''
      }
      return this.finishLink(`${opener}/${d}`, ch)
    }
    if (ch === '/' || ch === '\\') {
      this.resetLink()
      this.advanceLineState(ch)
      return `${opener}${d}${ch}`
    }
    return this.finishLink(`${opener}/${d}`, ch)
  }

  private resetLink(): void {
    this.linkPhase = 'none'
    this.linkBuf = ''
    this.driveBuf = ''
  }

  private abortLink(ch: string): string {
    const flushed = this.linkBuf
    this.resetLink()
    return flushed + this.step(ch)
  }

  private finishLink(prefix: string, ch: string): string {
    this.resetLink()
    return prefix + this.step(ch)
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
