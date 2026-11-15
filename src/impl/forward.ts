/**
 * Host request → forwarded ACP prompt selection.
 *
 * Only the message whose `source.kind` says "user" is forwarded (constraint 16); the session-title prompt is folded back into a placeholder title.
 *
 * Part of the host-half logic; the barrel is `src/impl.ts` and every existing
 * `../impl.ts` import keeps resolving through it. Pure logic only — no Node
 * APIs, no ACP SDK runtime values.
 */

import type { PromptContentBlock, PromptImageContent } from './image.ts'
import { resolveImageContent } from './image.ts'

export type ForwardPromptSelection =
  | {
      kind: 'prompt'
      text: string
      id?: string
      images?: PromptImageContent[]
      content?: PromptContentBlock[]
    }
  | { kind: 'no-user-input' }
  | { kind: 'empty' }

/**
 * Select the user's own words out of a host-built request.
 *
 * Why this exists (AGENTS.md rule 16): the host appends its context sections
 * *after* the claimed user batch — `agent-instructions` folds its digest right
 * behind the prompt, and the driver appends the runtime-context snapshot after
 * that — so "the last user-role message" is routinely an injected section, not
 * the prompt. Only the message's `source` distinguishes them: `kind: 'user'` is
 * the person, anything else (`plugin`, `skill-catalog`, `agent-instructions`,
 * `tool`, …) is harness context. An absent source means a hand-built request
 * (tests, headless callers) and counts as user input.
 *
 * @param messages - the request's ordered messages, exactly as the host built them.
 * @param context - optional host context or attachment resolver for reading attachments.
 * @returns the last real user message's text and any image content blocks, or why there is none to forward.
 */
export function selectForwardPrompt(messages: readonly {
  role: string
  content?: string | Array<{ type?: string; text?: string; [k: string]: unknown }> | { type?: string; text?: string; [k: string]: unknown }
  source?: { kind?: string }
  id?: string
}[], context?: unknown): ForwardPromptSelection {
  let sawUserRole = false
  let last: {
    text: string
    id?: string
    images?: PromptImageContent[]
    content?: PromptContentBlock[]
  } | undefined
  for (const message of messages) {
    if (message.role !== 'user') continue
    sawUserRole = true
    const kind = message.source?.kind
    if (kind !== undefined && kind !== 'user') continue

    const content = message.content ?? (message as { parts?: unknown }).parts
    const rawBlocks: Array<Record<string, unknown>> = Array.isArray(content)
      ? (content as Array<Record<string, unknown>>)
      : (typeof content === 'string'
          ? [{ type: 'text', text: content }]
          : (typeof content === 'object' && content !== null ? [content as Record<string, unknown>] : []))

    const text = rawBlocks
      .filter(block => block.type === 'text' && typeof block.text === 'string')
      .map(block => block.text as string)
      .join('\n')
      .trim()

    const images: PromptImageContent[] = []
    const contentBlocks: PromptContentBlock[] = []

    for (const block of rawBlocks) {
      if (!block || typeof block !== 'object') continue
      if (block.type === 'text' && typeof block.text === 'string') {
        if (block.text.trim() !== '') {
          contentBlocks.push({ type: 'text', text: block.text })
        }
      } else {
        const resolved = resolveImageContent(block, context)
        if (resolved !== undefined) {
          images.push(resolved)
          contentBlocks.push(resolved)
        }
      }
    }

    if (text === '' && images.length === 0) continue

    const item: {
      text: string
      id?: string
      images?: PromptImageContent[]
      content?: PromptContentBlock[]
    } = { text, ...(message.id === undefined ? {} : { id: message.id }) }
    if (images.length > 0) {
      item.images = images
      item.content = contentBlocks
    }
    last = item
  }
  if (last !== undefined) return { kind: 'prompt', ...last }
  return sawUserRole ? { kind: 'no-user-input' } : { kind: 'empty' }
}

/** Longest placeholder title the adapter answers a `session-title` call with. */
export const SESSION_TITLE_PLACEHOLDER_MAX = 60

/**
 * Pulls the first human message out of the host's title-generation prompt, to
 * serve as a session's placeholder title (AGENTS.md rule 16).
 *
 * The host's `dsh-session-title-llm` call arrives as one user message whose
 * text embeds the session's human messages as a JSON array — observed format:
 * "Generate the session title from this JSON array of human messages: […]".
 * Scanning the raw text for a balanced array (string-aware, so `]` inside
 * strings cannot truncate it) keeps this independent of the instruction
 * wording, which may drift between host versions. Elements may be plain
 * strings or objects; for objects the first string among `text` / `content` /
 * `message` wins. Whitespace collapses to single spaces and long titles cut at
 * {@link SESSION_TITLE_PLACEHOLDER_MAX} code points (surrogate-pair safe) with
 * an ellipsis.
 *
 * Anything unparseable returns `undefined`, and the caller keeps the old
 * `unsupported_purpose` refusal — the worst case stays exactly what shipped
 * before the placeholder existed (issue #11: the host's own text fallback does
 * not fire on every host version, so a parseable prompt must be answered).
 *
 * When `prefix` is non-empty, its code-point length is reserved from the cap
 * and the result comes back with the prefix already prepended — the full
 * answer keeps exactly the worst-case length the prefixless form had, so the
 * settings toggle changes what the title starts with, not how long it can get.
 */
export function extractSessionTitlePlaceholder(messages: readonly {
  role: string
  content?: string | Array<{ type?: string; text?: string; [k: string]: unknown }> | { type?: string; text?: string; [k: string]: unknown }
}[], prefix = ''): string | undefined {
  const blocks: string[] = []
  for (const message of messages) {
    if (message.role !== 'user') continue
    const content = message.content ?? (message as { parts?: unknown }).parts
    const rawBlocks: Array<Record<string, unknown>> = Array.isArray(content)
      ? (content as Array<Record<string, unknown>>)
      : (typeof content === 'string'
          ? [{ type: 'text', text: content }]
          : (typeof content === 'object' && content !== null ? [content as Record<string, unknown>] : []))
    for (const block of rawBlocks) {
      if (typeof block.text === 'string') blocks.push(block.text)
    }
  }

  const prompt = blocks.join('\n')
  const budget = Math.max(0, SESSION_TITLE_PLACEHOLDER_MAX - Array.from(prefix).length)
  for (let start = prompt.indexOf('['); start !== -1; start = prompt.indexOf('[', start + 1)) {
    let parsed: unknown
    try {
      parsed = JSON.parse(sliceBalancedJsonArray(prompt, start))
    } catch {
      continue
    }
    if (!Array.isArray(parsed)) continue
    for (const element of parsed) {
      const value = typeof element === 'string'
        ? element
        : (element !== null && typeof element === 'object'
            ? firstStringField(element as Record<string, unknown>, ['text', 'content', 'message'])
            : undefined)
      if (value === undefined) continue
      const collapsed = value.replace(/\s+/gu, ' ').trim()
      if (collapsed === '') continue
      const chars = Array.from(collapsed)
      const capped = chars.length <= budget
        ? collapsed
        : chars.slice(0, budget).join('') + '…'
      return prefix === '' ? capped : prefix + capped
    }
  }
  return undefined
}

/** Slices the balanced `[…]` region starting at `start`, or `''` when it never closes. */
function sliceBalancedJsonArray(text: string, start: number): string {
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === '[') depth++
    else if (ch === ']' && --depth === 0) return text.slice(start, i + 1)
  }
  return ''
}

/** First string among `keys`, for title-array elements that arrive as objects. */
function firstStringField(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string') return value
  }
  return undefined
}
