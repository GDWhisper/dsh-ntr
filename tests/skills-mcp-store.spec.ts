/**
 * The built-in `dsh-skills` MCP switch on the browser side: the read, the
 * optimistic toggle, the revert on a refused write, and the fact that it is a
 * plain setting — never part of the save gate, never an agent save.
 *
 * Spec: docs/plan/dsh-skills-mcp.md §6.3 and §7.1.
 */
import { describe, expect, it } from 'vitest'
import { AcpStore } from '../src/client/store.ts'
import type { RpcCall } from '../src/client/store.ts'

/** Every endpoint a store answered with `ok`, plus the ones it was asked for. */
function makeStore(answer: (endpoint: string, payload: unknown) => Awaited<ReturnType<RpcCall>> | 'unknown') {
  const calls: Array<{ endpoint: string; payload: unknown }> = []
  const store = new AcpStore(
    async (_channel, endpoint, payload) => {
      calls.push({ endpoint, payload })
      if (endpoint === 'agents/list') return { ok: true, value: { agents: [] } }
      if (endpoint === 'sessions/list') return { ok: true, value: { sessions: [] } }
      if (endpoint === 'agents/detect') return { ok: true, value: { agents: [] } }
      const answer_ = answer(endpoint, payload)
      if (answer_ === 'unknown') return { ok: false, error: { code: 'unsupported', message: `unknown endpoint ${endpoint}` } }
      return answer_
    },
    zh => zh,
  )
  return { store, calls }
}

describe('the skills MCP switch in the store', () => {
  it('reads the host value on resync and treats an unanswered read as unread (never on)', async () => {
    const on = makeStore((endpoint) => endpoint === 'ui/skills-mcp'
      ? { ok: true, value: { skillsMcpEnabled: true } }
      : 'unknown')
    // Before any read the value is UNKNOWN: the toggle must not claim it is on.
    expect(on.store.getSnapshot().skillsMcpEnabled).toBeUndefined()
    await on.store.resync()
    expect(on.store.getSnapshot().skillsMcpEnabled).toBe(true)

    // An older host half answers `unsupported`: the value stays unknown, and
    // unknown is NOT on.
    const silent = makeStore(() => 'unknown')
    await silent.store.resync()
    expect(silent.store.getSnapshot().skillsMcpEnabled).toBeUndefined()

    // An explicit off is a value, not an absence.
    const off = makeStore((endpoint) => endpoint === 'ui/skills-mcp'
      ? { ok: true, value: { skillsMcpEnabled: false } }
      : 'unknown')
    await off.store.resync()
    expect(off.store.getSnapshot().skillsMcpEnabled).toBe(false)
  })

  it('flips the row with the click, then adopts the host answer as the authority', async () => {
    const { store, calls } = makeStore((endpoint) => {
      if (endpoint === 'ui/skills-mcp-set') return { ok: true, value: { skillsMcpEnabled: true } }
      return 'unknown'
    })
    await store.resync()
    const pending = store.setSkillsMcpEnabled(true)
    // Optimistic: the row flips with the click, before the host answers.
    expect(store.getSnapshot().skillsMcpEnabled).toBe(true)
    await pending
    expect(store.getSnapshot().skillsMcpEnabled).toBe(true)
    // The write travels under the key the host route validates.
    expect(calls.filter(call => call.endpoint === 'ui/skills-mcp-set').map(call => call.payload))
      .toEqual([{ skillsMcpEnabled: true }])

    // The host trims / overrides: its answer wins over the optimistic guess.
    const trimmed = makeStore((endpoint) => endpoint === 'ui/skills-mcp-set'
      ? { ok: true, value: { skillsMcpEnabled: false } }
      : 'unknown')
    await trimmed.store.resync()
    await trimmed.store.setSkillsMcpEnabled(true)
    expect(trimmed.store.getSnapshot().skillsMcpEnabled).toBe(false)
  })

  it('reverts the row and flashes the page-header notice when the write is refused', async () => {
    const { store } = makeStore((endpoint) => {
      if (endpoint === 'ui/skills-mcp') return { ok: true, value: { skillsMcpEnabled: false } }
      if (endpoint === 'ui/skills-mcp-set') return { ok: false, error: { code: 'persist_failed', message: 'acp: failed to persist agent state' } }
      return 'unknown'
    })
    await store.resync()
    expect(store.getSnapshot().skillsMcpEnabled).toBe(false)
    const gateBefore = store.getSnapshot().saveGate
    await store.setSkillsMcpEnabled(true)
    // The value the host refused to save is not shown as saved...
    expect(store.getSnapshot().skillsMcpEnabled).toBe(false)
    // ...and the failure is the settings page's own notice, not a save banner.
    expect(store.getSnapshot().notice).toBe('acp: failed to persist agent state')
    expect(store.getSnapshot().saveGate).toEqual(gateBefore)
  })

  it('is a plain setting: no save gate, no pending save, no agent/save', async () => {
    const { store, calls } = makeStore((endpoint) => endpoint === 'ui/skills-mcp-set'
      ? { ok: true, value: { skillsMcpEnabled: true } }
      : 'unknown')
    await store.resync()
    const before = store.getSnapshot()
    calls.length = 0
    await store.setSkillsMcpEnabled(true)
    // Exactly one route, and nothing from the save-gate family.
    expect(calls.map(call => call.endpoint)).toEqual(['ui/skills-mcp-set'])
    expect(store.getSnapshot().saveGate).toEqual(before.saveGate)
    expect(store.getSnapshot().saveBanners).toEqual(before.saveBanners)
  })
})
