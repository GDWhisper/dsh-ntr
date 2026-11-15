/**
 * The built-in `dsh-skills` MCP switches on the browser side: the read, the
 * optimistic toggle, the revert on a refused write, and the fact that it is a
 * plain setting — never part of the save gate, never an agent save.
 *
 * Spec: docs/plan/dsh-skills-mcp.md §6.3, §7.1 and §13 (the two-level switch).
 */
import { describe, expect, it } from 'vitest'
import { AcpStore } from '../src/client/store.ts'
import type { RpcCall, UiState } from '../src/client/store.ts'
import type { DetectedAgentInfo } from '../src/protocol.ts'

/** Every endpoint a store answered with `ok`, plus the ones it was asked for. */
function makeStore(
  answer: (endpoint: string, payload: unknown) => Awaited<ReturnType<RpcCall>> | 'unknown',
  roster: DetectedAgentInfo[] = [],
) {
  const calls: Array<{ endpoint: string; payload: unknown }> = []
  const store = new AcpStore(
    async (_channel, endpoint, payload) => {
      calls.push({ endpoint, payload })
      if (endpoint === 'agents/list') return { ok: true, value: { agents: [] } }
      if (endpoint === 'sessions/list') return { ok: true, value: { sessions: [] } }
      if (endpoint === 'agents/detect') return { ok: true, value: { agents: roster } }
      const answer_ = answer(endpoint, payload)
      if (answer_ === 'unknown') return { ok: false, error: { code: 'unsupported', message: `unknown endpoint ${endpoint}` } }
      return answer_
    },
    zh => zh,
  )
  return { store, calls }
}

/** One configured agent as `agents/detect` reports it (the settings card's copy). */
function skillAgent(): DetectedAgentInfo {
  return {
    id: 'codebuddy',
    name: 'CodeBuddy',
    detected: true,
    defaultCommand: 'codebuddy',
    defaultArgs: ['--acp'],
    currentConfig: { id: 'codebuddy', title: 'CodeBuddy', command: 'codebuddy', args: ['--acp'] },
  }
}

/** The roster copy of one agent's per-agent `dsh-skills` answer. */
function agentFlag(state: UiState, agentId: string): boolean | undefined {
  return state.detectedAgents.find(info => info.id === agentId)?.currentConfig?.skillsMcpEnabled
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

describe('the per-agent skills MCP switch in the store', () => {
  it('flips the agent card with the click, then adopts the host roster answer', async () => {
    const roster = [skillAgent()]
    const { store, calls } = makeStore((endpoint, payload) => {
      if (endpoint !== 'agent/set-skills-mcp') return 'unknown'
      const { skillsMcpEnabled } = payload as { skillsMcpEnabled: boolean }
      // The host normalizes: only the explicit opt-out is stored (`true` clears it).
      if (skillsMcpEnabled) delete roster[0].currentConfig?.skillsMcpEnabled
      else if (roster[0].currentConfig !== undefined) roster[0].currentConfig.skillsMcpEnabled = false
      return { ok: true, value: { done: true } }
    }, roster)
    await store.resync()
    // Unset means ON: an existing definition is offered the server by default.
    expect(agentFlag(store.getSnapshot(), 'codebuddy')).toBeUndefined()

    const pending = store.setAgentSkillsMcp('codebuddy', false)
    // Optimistic: the card follows the click, before the host answers.
    expect(agentFlag(store.getSnapshot(), 'codebuddy')).toBe(false)
    await pending
    expect(agentFlag(store.getSnapshot(), 'codebuddy')).toBe(false)
    expect(calls.filter(call => call.endpoint === 'agent/set-skills-mcp').map(call => call.payload))
      .toEqual([{ agentId: 'codebuddy', skillsMcpEnabled: false }])

    // Turning it back on clears the key again — the host's shape, adopted.
    await store.setAgentSkillsMcp('codebuddy', true)
    expect(agentFlag(store.getSnapshot(), 'codebuddy')).toBeUndefined()
  })

  it('reverts the checkbox and flashes the notice when the strict persist is refused', async () => {
    const roster = [skillAgent()]
    const { store, calls } = makeStore((endpoint) => endpoint === 'agent/set-skills-mcp'
      ? { ok: false, error: { code: 'persist_failed', message: 'acp: failed to persist agent state' } }
      : 'unknown', roster)
    await store.resync()
    const gateBefore = store.getSnapshot().saveGate
    calls.length = 0
    await store.setAgentSkillsMcp('codebuddy', false)
    // Back to the answer the host still holds (unset = on), never "saved".
    expect(agentFlag(store.getSnapshot(), 'codebuddy')).toBeUndefined()
    expect(store.getSnapshot().notice).toBe('acp: failed to persist agent state')
    // A plain setting: no agent save, no save gate, no save banner.
    expect(calls.map(call => call.endpoint)).toEqual(['agent/set-skills-mcp'])
    expect(store.getSnapshot().saveGate).toEqual(gateBefore)
  })

  it('syncs the checkbox from the agent/exposure frame, including an older host that omits the field', async () => {
    const roster = [skillAgent()]
    const { store } = makeStore(() => 'unknown', roster)
    await store.resync()
    const apply = (event: unknown): Promise<void> =>
      (store as unknown as { applyEvent(event: unknown): Promise<void> }).applyEvent(event)

    await apply({ type: 'agent/exposure', agentId: 'codebuddy', exposedModels: [], autoDiscoverModels: true, skillsMcpEnabled: false })
    expect(agentFlag(store.getSnapshot(), 'codebuddy')).toBe(false)

    await apply({ type: 'agent/exposure', agentId: 'codebuddy', exposedModels: [], autoDiscoverModels: true, skillsMcpEnabled: true })
    expect(agentFlag(store.getSnapshot(), 'codebuddy')).toBeUndefined()

    // An older host half sends no such field: the opt-out has no value, and the
    // only shape it can mean is "not opted out" (default on).
    await apply({ type: 'agent/exposure', agentId: 'codebuddy', exposedModels: [], autoDiscoverModels: true, skillsMcpEnabled: false })
    await apply({ type: 'agent/exposure', agentId: 'codebuddy', exposedModels: [], autoDiscoverModels: true })
    expect(agentFlag(store.getSnapshot(), 'codebuddy')).toBeUndefined()
  })
})
