/**
 * The agent preset a session runs, read back from the host session log / roster.
 *
 * Part of the `tests/impl.spec.ts` mirror: one file per `src/impl/` cluster,
 * same describe titles and case counts as before the split.
 */

import { describe, expect, it } from 'vitest'
import {
  appendExternalSubagentCatalog,
} from '../../src/impl.ts'

describe('appendExternalSubagentCatalog', () => {
  it('appends one v2 external fact and skips a repeated childId', () => {
    const events: Array<{ type: string; data: Record<string, unknown> }> = []
    const session = {
      events,
      append(type: string, data: Record<string, unknown>): void {
        events.push({ type, data })
      },
    }
    expect(appendExternalSubagentCatalog(session, 'acp:call-1', 'general-purpose · audit', 123)).toBe(true)
    expect(events).toEqual([{
      type: 'subagent/catalog',
      data: {
        version: 2,
        childId: 'acp:call-1',
        childCreatedAt: 123,
        mode: 'external',
        label: 'general-purpose · audit',
      },
    }])
    expect(appendExternalSubagentCatalog(session, 'acp:call-1', 'again', 456)).toBe(false)
    expect(events).toHaveLength(1)
  })

  it('is silent when the session cannot append or the host rejects the event', () => {
    expect(appendExternalSubagentCatalog(undefined, 'acp:call-1', 'x')).toBe(false)
    const failing = {
      events: [] as unknown[],
      append(): void { throw new Error('host without subagent/catalog') },
    }
    expect(appendExternalSubagentCatalog(failing, 'acp:call-1', 'x')).toBe(false)
  })
})
