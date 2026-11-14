import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SessionUpdate } from '@agentclientprotocol/sdk'
import { AgentBridge } from '../src/bridge.ts'
import type { LiveSession } from '../src/bridge/live-session.ts'
import { PersistenceService, type PersistenceHost } from '../src/bridge/persistence-service.ts'
import { EventHub } from '../src/impl.ts'
import type { AcpAgentDef } from '../src/protocol.ts'
import { AcpStore } from '../src/client/store.ts'

/**
 * The two CALL SITES of `mergeUsageSample`, guarded against a silent revert.
 * `tests/usage.spec.ts` proves the merge itself; these cases prove the bridge
 * and the browser fold still route a `usage_update` through it — a file that
 * only tests the pure function would stay green if either call were undone.
 */

/** The store's own event entry point, exactly as the SSE path calls it. */
type ApplyEvent = { applyEvent(event: unknown): Promise<void> }

function view(usage?: { used: number; size: number }): Record<string, unknown> {
  return {
    sessionId: 's1',
    agentId: 'pi',
    acpSessionId: 'acp-1',
    cwd: '/w',
    running: false,
    closed: false,
    seq: 0,
    ...(usage === undefined ? {} : { usage }),
  }
}

/** The CodeBuddy background-subagent tick, verbatim from the wire. */
const TEAM_MEMBER_TICK = {
  sessionUpdate: 'usage_update',
  used: 0,
  size: 0,
  cost: { amount: 0.09, currency: '' },
}

describe('browser wiring: a degenerate usage_update never replaces the row reading', () => {
  it('keeps the chat row and the watched transcript on the last good sample, then still moves on a real one', async () => {
    const store = new AcpStore(async (_channel, endpoint) => {
      if (endpoint === 'session/chat-list') {
        return { ok: true, value: { sessions: [{ agentId: 'pi', sessionId: 's1', usage: { used: 500, size: 1000 } }], acpMode: true } }
      }
      if (endpoint === 'session/chat-transcript') {
        return { ok: true, value: { views: [{ session: view({ used: 500, size: 1000 }), entries: [] }] } }
      }
      return { ok: true, value: {} }
    }, zh => zh)
    const apply = (event: unknown): Promise<void> => (store as unknown as ApplyEvent).applyEvent(event)
    await store.loadChatSessions('chat-1')
    await store.loadChatTranscript('chat-1')
    await apply({ type: 'session/created', sessionId: 's1', session: view({ used: 500, size: 1000 }) })

    await apply({ type: 'session/update', sessionId: 's1', seq: 1, update: TEAM_MEMBER_TICK })

    expect(store.getSnapshot().chatSessions[0]?.usage).toEqual({ used: 500, size: 1000 })
    expect(store.getSnapshot().chatTranscripts.s1?.session.usage).toEqual({ used: 500, size: 1000 })

    // The frame is ignored, the path is not: a readable sample still lands in both.
    await apply({ type: 'session/update', sessionId: 's1', seq: 2, update: { sessionUpdate: 'usage_update', used: 600, size: 1000 } })
    expect(store.getSnapshot().chatSessions[0]?.usage).toEqual({ used: 600, size: 1000 })
    expect(store.getSnapshot().chatTranscripts.s1?.session.usage).toEqual({ used: 600, size: 1000 })
  })
})

/**
 * `AgentBridge.applyDerived` needs no child process to judge: the usage case
 * touches only `session.usage`, so an unconstructed instance is the honest seam
 * (a second mock agent would exist for one frame). The test fails if the call
 * site goes back to copying `used`/`size` straight onto the record.
 */
describe('host wiring: applyDerived merges into the record instead of overwriting it', () => {
  type Seam = { applyDerived(session: LiveSession, update: SessionUpdate): void }
  const seam = (): Seam => Object.create(AgentBridge.prototype) as Seam
  const sample = (overrides: Record<string, unknown>): SessionUpdate =>
    ({ ...TEAM_MEMBER_TICK, ...overrides }) as SessionUpdate

  it('keeps the last good reading for the team-member tick and still records its cost', () => {
    const session = { usage: { used: 41_428, size: 192_000 } } as unknown as LiveSession
    seam().applyDerived(session, sample({}))
    expect(session.usage).toEqual({ used: 41_428, size: 192_000, cost: { amount: 0.09, currency: '' } })
  })

  it('lets a readable sample replace the reading', () => {
    const session = { usage: { used: 41_428, size: 192_000 } } as unknown as LiveSession
    seam().applyDerived(session, sample({ used: 41_500, size: 192_000, cost: undefined }))
    expect(session.usage).toEqual({ used: 41_500, size: 192_000 })
  })

  it('invents no reading when the first thing the session hears is a cost tick', () => {
    const session = {} as unknown as LiveSession
    seam().applyDerived(session, sample({}))
    expect(session.usage).toBeUndefined()
  })
})

/**
 * The third call site: `PersistenceService.loadPersistedChatSessions` filters a
 * stored row through `isPersistedUsage`. Without it a 0/0 written by an older
 * build comes back on every boot and the ring stays missing until the agent
 * speaks again — the "it never came back after a refresh" half of the report.
 */
describe('persistence wiring: a stored 0/0 never comes back as a reading', () => {
  it('drops the degenerate row and keeps the valid one', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-ntr-usage-'))
    const file = join(dir, 'agents.json')
    const def = {
      id: 'pi',
      title: 'Pi',
      command: process.execPath,
      args: [] as string[],
      env: {},
      cwd: tmpdir(),
      allowedCwdRoots: [tmpdir()],
    } as unknown as AcpAgentDef
    try {
      writeFileSync(file, JSON.stringify({
        agents: [{ id: 'pi', title: 'Pi', command: process.execPath, args: [], cwd: tmpdir(), allowedCwdRoots: [tmpdir()] }],
        chatSessions: [
          {
            sessionId: 's-degenerate',
            acpSessionId: 'acp-a',
            agentId: 'pi',
            dshSessionId: 'chat-a',
            cwd: tmpdir(),
            usage: { used: 0, size: 0, cost: { amount: 0.09, currency: '' } },
          },
          {
            sessionId: 's-valid',
            acpSessionId: 'acp-b',
            agentId: 'pi',
            dshSessionId: 'chat-b',
            cwd: tmpdir(),
            usage: { used: 500, size: 1000 },
          },
        ],
      }))
      const defs = new Map<string, AcpAgentDef>([[def.id, def]])
      let restored: readonly LiveSession[] = []
      const host: PersistenceHost = {
        hub: new EventHub(),
        defs: () => defs,
        settingsPersisted: () => ({}) as unknown as ReturnType<PersistenceHost['settingsPersisted']>,
        applyPersistedSettings: () => {},
        conversationsPersisted: () => undefined,
        applyPersistedConversations: () => {},
        chatSessionsPersisted: () => [],
        applyPersistedChatSessions: (sessions) => { restored = sessions },
        subagentsPersisted: () => ({}),
        applyPersistedSubagents: () => {},
      }
      new PersistenceService(host, file, 600).loadPersistedAgents()

      // The degenerate row still loads as a session (its conversation is real);
      // only the fake reading is gone. The valid row keeps its occupancy.
      expect(restored.map(session => [session.sessionId, session.usage]))
        .toEqual([['s-degenerate', undefined], ['s-valid', { used: 500, size: 1000 }]])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
