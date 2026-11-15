/**
 * `agentRefusalDetail` reads a `session/prompt` RESPONSE that only the bridge sees, but it is pure, so its branches are pinned here instead of in the subprocess suite.
 *
 * Part of the `tests/impl.spec.ts` mirror: one file per `src/impl/` cluster,
 * same describe titles and case counts as before the split.
 */

import { describe, expect, it } from 'vitest'
import { agentRefusalDetail } from '../../src/bridge.ts'

/**
 * `agentRefusalDetail` lives in bridge.ts (it reads a `session/prompt`
 * RESPONSE, which only the bridge sees) but is pure, so its branches are
 * pinned here rather than in the subprocess suite. The wire fact behind every
 * case: CodeBuddy refuses a prompt with a RESOLVED response — no error object,
 * no `describeError` — and puts the reason in the response `_meta`.
 */
describe('agentRefusalDetail (a refused prompt response, read off its _meta)', () => {
  const QUOTA_MESSAGE = '429 您使用量已超出频率限制，将在 2026-11-05 12:00 重置，您也可以切换其他模型继续使用。'

  it('reads a legal quota refusal as a quota', () => {
    const meta = {
      'codebuddy.ai/errorMessage': JSON.stringify({
        code: -32003,
        message: QUOTA_MESSAGE,
        data: { statusCode: 429, code: 6004, category: 'quota' },
      }),
    }
    expect(agentRefusalDetail(meta)).toEqual({ kind: 'quota', message: QUOTA_MESSAGE })
  })

  it('keeps the raw text when the JSON is damaged', () => {
    const broken = '{"code":-32003,"message":"429 quota",'
    expect(agentRefusalDetail({ 'codebuddy.ai/errorMessage': broken }))
      .toEqual({ kind: 'refusal', message: broken })
  })

  it('answers undefined when the key is missing or _meta is not an object', () => {
    expect(agentRefusalDetail({ 'codebuddy.ai/requestId': 'r-1' })).toBeUndefined()
    expect(agentRefusalDetail(undefined)).toBeUndefined()
    expect(agentRefusalDetail(null)).toBeUndefined()
    expect(agentRefusalDetail('codebuddy.ai/errorMessage')).toBeUndefined()
    expect(agentRefusalDetail(42)).toBeUndefined()
  })

  it('is a plain refusal when the category says so', () => {
    const meta = {
      'codebuddy.ai/errorMessage': JSON.stringify({
        code: -32003,
        message: 'content policy',
        data: { statusCode: 400, code: 6001, category: 'content_filter' },
      }),
    }
    expect(agentRefusalDetail(meta)).toEqual({ kind: 'refusal', message: 'content policy' })
  })

  it('still reads a quota from statusCode alone', () => {
    const meta = {
      'codebuddy.ai/errorMessage': JSON.stringify({
        code: -32003,
        message: QUOTA_MESSAGE,
        data: { statusCode: 429, code: 6004 },
      }),
    }
    expect(agentRefusalDetail(meta)).toEqual({ kind: 'quota', message: QUOTA_MESSAGE })
  })

  it('falls back to the raw text when the message is empty', () => {
    const raw = JSON.stringify({ code: -32003, message: '', data: { category: 'quota' } })
    expect(agentRefusalDetail({ 'codebuddy.ai/errorMessage': raw }))
      .toEqual({ kind: 'quota', message: raw })
  })
})
