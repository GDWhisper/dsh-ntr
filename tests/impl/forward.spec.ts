/**
 * Prompt selection: only a `source.kind === 'user'` message is forwarded (constraint 16), and the host title prompt folds back into a placeholder title.
 *
 * Part of the `tests/impl.spec.ts` mirror: one file per `src/impl/` cluster,
 * same describe titles and case counts as before the split.
 */

import { describe, expect, it } from 'vitest'
import {
  selectForwardPrompt,
  extractSessionTitlePlaceholder,
  SESSION_TITLE_PLACEHOLDER_MAX,
} from '../../src/impl.ts'
import { SESSION_TITLE_PREFIX } from '../../src/protocol.ts'

describe('selectForwardPrompt (host request → forwarded ACP prompt)', () => {
  const user = (text: string, id = 'u1') => ({ role: 'user', id, source: { kind: 'user' }, content: [{ type: 'text', text }] })
  const injected = (kind: string, text: string) => ({ role: 'user', source: { kind }, content: [{ type: 'text', text }] })

  it('takes the user message even when the host folds context sections after it', () => {
    const picked = selectForwardPrompt([
      user('你好'),
      injected('agent-instructions', '<system-reminder>The following workspace instructions…'),
      injected('plugin', 'Current runtime context.\n\nCurrent DSH file policy: workspace-write.'),
      injected('skill-catalog', '<available_skills>…'),
    ])
    expect(picked).toEqual({ kind: 'prompt', text: '你好', id: 'u1' })
  })

  it('ignores tool results and reports an injected-only wake separately', () => {
    expect(selectForwardPrompt([
      user('run the tests'),
      { role: 'user', source: { kind: 'tool' }, content: [{ type: 'text', text: 'exit code 0' }] },
    ])).toEqual({ kind: 'prompt', text: 'run the tests', id: 'u1' })
    expect(selectForwardPrompt([injected('skill-catalog', '<available_skills>…')])).toEqual({ kind: 'no-user-input' })
    expect(selectForwardPrompt([{ role: 'assistant', content: [{ type: 'text', text: 'hi' }] }])).toEqual({ kind: 'empty' })
  })

  it('treats a source-less message as user input and joins text blocks', () => {
    expect(selectForwardPrompt([
      { role: 'user', content: [{ type: 'text', text: 'hand-built' }] },
    ])).toEqual({ kind: 'prompt', text: 'hand-built' })
    expect(selectForwardPrompt([
      { role: 'user', content: [{ type: 'text', text: '  first  ' }, { type: 'image', url: 'x' }, { type: 'text', text: 'second' }] },
    ])).toEqual({ kind: 'prompt', text: 'first  \nsecond' })
    expect(selectForwardPrompt([{ role: 'user', content: [{ type: 'text', text: '   ' }] }])).toEqual({ kind: 'no-user-input' })
  })

})

describe('extractSessionTitlePlaceholder (host title prompt → placeholder title)', () => {
  const titlePrompt = (text: string) => [{ role: 'user', source: { kind: 'plugin', plugin: 'dsh-session-title-llm' }, content: [{ type: 'text', text }] }]

  it('takes the first human message out of the prompt\'s JSON array', () => {
    expect(extractSessionTitlePlaceholder(titlePrompt(
      'Generate the session title from this JSON array of human messages: ["给这个仓库写一份测试指南","second human line"]',
    ))).toBe('给这个仓库写一份测试指南')
    // A bracket in prose before the real array must not block the scan.
    expect(extractSessionTitlePlaceholder(titlePrompt(
      '[optional] Generate the session title from this JSON array of human messages: ["你好"]',
    ))).toBe('你好')
  })

  it('reads object elements via text / content / message and skips empties', () => {
    expect(extractSessionTitlePlaceholder(titlePrompt('prompt: [{"text":"  "},{"content":"第一个问题"}]'))).toBe('第一个问题')
    expect(extractSessionTitlePlaceholder(titlePrompt('prompt: [{"message":"first"}]'))).toBe('first')
    // Objects without a usable string field fall through; a string element still wins.
    expect(extractSessionTitlePlaceholder(titlePrompt('prompt: [{"other":1},"fallback title"]'))).toBe('fallback title')
  })

  it('collapses whitespace and truncates by code points with an ellipsis', () => {
    expect(extractSessionTitlePlaceholder(titlePrompt('["a\\n  b\\t c"]'))).toBe('a b c')
    const long = '啊'.repeat(SESSION_TITLE_PLACEHOLDER_MAX + 10)
    expect(extractSessionTitlePlaceholder(titlePrompt(`["${long}"]`)))
      .toBe('啊'.repeat(SESSION_TITLE_PLACEHOLDER_MAX) + '…')
    // The cut falls mid-run of astral chars: the pair stays intact (a naive
    // UTF-16 slice would emit a lone half surrogate here).
    const mixed = 'a'.repeat(SESSION_TITLE_PLACEHOLDER_MAX - 1) + '🙂'.repeat(10)
    expect(extractSessionTitlePlaceholder(titlePrompt(`["${mixed}"]`)))
      .toBe('a'.repeat(SESSION_TITLE_PLACEHOLDER_MAX - 1) + '🙂' + '…')
  })

  it('prepends the settings prefix inside the same total cap', () => {
    const prefixLen = Array.from(SESSION_TITLE_PREFIX).length
    // Off (the default): byte-identical to the prefixless answer, explicit or not.
    expect(extractSessionTitlePlaceholder(titlePrompt('["你好"]'))).toBe('你好')
    expect(extractSessionTitlePlaceholder(titlePrompt('["你好"]'), '')).toBe('你好')
    // On: the prefix rides the front of the same placeholder.
    expect(extractSessionTitlePlaceholder(titlePrompt('["你好"]'), SESSION_TITLE_PREFIX)).toBe(SESSION_TITLE_PREFIX + '你好')
    // A long title reserves the prefix's code points from the cap first, so
    // the full answer keeps exactly the prefixless worst-case length.
    const long = '啊'.repeat(SESSION_TITLE_PLACEHOLDER_MAX + 10)
    expect(extractSessionTitlePlaceholder(titlePrompt(`["${long}"]`), SESSION_TITLE_PREFIX))
      .toBe(SESSION_TITLE_PREFIX + '啊'.repeat(SESSION_TITLE_PLACEHOLDER_MAX - prefixLen) + '…')
    // Unparseable prompts stay undefined either way — no prefix-only answer.
    expect(extractSessionTitlePlaceholder(titlePrompt('no array here'), SESSION_TITLE_PREFIX)).toBeUndefined()
  })

  it('returns undefined for prompts without a parseable human-message array', () => {
    expect(extractSessionTitlePlaceholder(titlePrompt('Generate the session title from this JSON array of human messages: not json'))).toBeUndefined()
    expect(extractSessionTitlePlaceholder(titlePrompt('Generate the session title: []'))).toBeUndefined()
    expect(extractSessionTitlePlaceholder(titlePrompt('Generate the session title: ["   ",""]'))).toBeUndefined()
    expect(extractSessionTitlePlaceholder(titlePrompt('Generate the session title: ["unclosed bracket'))).toBeUndefined()
    expect(extractSessionTitlePlaceholder([])).toBeUndefined()
  })
})
