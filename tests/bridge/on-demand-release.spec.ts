import { describe, expect, it } from 'vitest'
import { BridgeManager } from '../../src/bridge.ts'
import { EventHub } from '../../src/impl.ts'
import { def } from './harness.ts'

/**
 * `acp_release`'s host half: the on-demand idle release. It runs the SAME
 * eligibility as the idle timer — a live session is parked only when the agent
 * advertises `session/load`; a busy process is never touched.
 */
function managerFor(ids: readonly string[], overrides: Partial<typeof def> = {}): BridgeManager {
  const hub = new EventHub()
  return new BridgeManager(ids.map(id => ({ ...def, id, ...overrides })), hub, 500)
}

describe('on-demand idle release', () => {
  it('parks a live session and kills the process immediately, then reports nothing left', async () => {
    const manager = managerFor(['rel'])
    try {
      await manager.startSession('rel', undefined)
      expect(manager.agentViews()[0]).toMatchObject({ state: 'ready' })
      const report = manager.releaseIdleProcesses()
      expect(report.released).toEqual([{ agentId: 'rel', sessions: 1 }])
      expect(manager.agentViews()[0]?.state).toBe('stopped')
      expect(manager.agentViews()[0]?.liveSessions).toEqual([])
      // A second call has no ready process to release.
      expect(manager.releaseIdleProcesses()).toEqual({ released: [], skipped: [] })
    } finally {
      await manager.shutdownAll()
    }
  }, 30_000)

  it('narrows to one named agent and leaves the others running', async () => {
    const manager = managerFor(['rel-a', 'rel-b'])
    try {
      await manager.startSession('rel-a', undefined)
      await manager.startSession('rel-b', undefined)
      expect(manager.releaseIdleProcesses('rel-a').released).toEqual([{ agentId: 'rel-a', sessions: 1 }])
      expect(manager.agentViews().find(view => view.id === 'rel-a')?.state).toBe('stopped')
      expect(manager.agentViews().find(view => view.id === 'rel-b')?.state).toBe('ready')
    } finally {
      await manager.shutdownAll()
    }
  }, 30_000)

  it('refuses to park a live session on an agent that cannot reload it', async () => {
    const manager = managerFor(['rel-no-load'], { env: { MOCK_NO_LOAD: '1' } })
    try {
      await manager.startSession('rel-no-load', undefined)
      const report = manager.releaseIdleProcesses()
      expect(report.released).toEqual([])
      expect(report.skipped).toEqual([{ agentId: 'rel-no-load', reason: 'no-resume' }])
      // Nothing was killed: the conversation it could not reload is still served.
      expect(manager.agentViews()[0]?.state).toBe('ready')
    } finally {
      await manager.shutdownAll()
    }
  }, 30_000)
})
