/**
 * Child environment assembly: the host environment is inherited whole and the agent `env` wins per key (no implicit credential filtering).
 *
 * Part of the `tests/impl.spec.ts` mirror: one file per `src/impl/` cluster,
 * same describe titles and case counts as before the split.
 */

import { describe, expect, it } from 'vitest'
import {
  childEnv,
} from '../../src/impl.ts'

describe('childEnv', () => {
  it('inherits the whole host env and lets the agent env win per key', () => {
    const out = childEnv(
      { HOME: '/h', ANTHROPIC_API_KEY: 'sk', GITHUB_TOKEN: 'gh', DSH_PERMISSION_MODE: 'x', PLAIN: 'p', EMPTY: undefined },
      { DEEPSEEK_API_KEY: 'explicit', HOME: '/other' },
    )
    expect(out).toEqual({
      HOME: '/other',
      ANTHROPIC_API_KEY: 'sk',
      GITHUB_TOKEN: 'gh',
      DSH_PERMISSION_MODE: 'x',
      PLAIN: 'p',
      DEEPSEEK_API_KEY: 'explicit',
    })
  })
})
