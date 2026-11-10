/**
 * Archive release, pure half: the host's workspace-domain writes become a
 * pending set, and the plugin retires it on its own lifecycle events. These
 * tests drive the parser, the activity frames and the tracker's re-entrancy
 * without a host or an agent process.
 */

import { describe, expect, it, vi } from 'vitest'
import {
  ArchiveReleaseTracker,
  archiveActivityFrames,
  parseArchivedSessionIds,
} from '../src/archive-release.ts'
import type { ArchiveReleaseVerdict } from '../src/archive-release.ts'

/** The workspace global-singleton write the host emits after archiving. */
function workspaceWrite(ids: readonly string[]): unknown {
  return {
    domain: 'workspace',
    table: '',
    key: '',
    operation: 'put',
    value: { workspaceIds: [], archivedSessionIds: [...ids], pinnedSessionIds: [] },
  }
}

describe('parseArchivedSessionIds', () => {
  it('accepts the workspace global write and returns the archive set', () => {
    expect(parseArchivedSessionIds(workspaceWrite(['s1', 's2']))).toEqual(['s1', 's2'])
  })

  it('rejects other domains, table writes and deleted operations', () => {
    expect(parseArchivedSessionIds({ ...workspaceWrite(['s1']) as object, domain: 'other' })).toBeUndefined()
    expect(parseArchivedSessionIds({ ...workspaceWrite(['s1']) as object, table: 'workspaces', key: 'w1' })).toBeUndefined()
    expect(parseArchivedSessionIds({ ...workspaceWrite(['s1']) as object, operation: 'deleted' })).toBeUndefined()
    expect(parseArchivedSessionIds({ ...workspaceWrite(['s1']) as object, value: { archivedSessionIds: [1] } })).toBeUndefined()
    expect(parseArchivedSessionIds({ ...workspaceWrite(['s1']) as object, value: null })).toBeUndefined()
    expect(parseArchivedSessionIds(undefined)).toBeUndefined()
  })
})

describe('archiveActivityFrames', () => {
  it('appends one turn when the plugin owns activity and nobody reported turn', () => {
    expect(archiveActivityFrames(true, [])).toEqual([{ kind: 'turn' }])
    expect(archiveActivityFrames(true, [{ kind: 'subagent', items: [{ id: 'a' }] }]))
      .toEqual([{ kind: 'turn' }, { kind: 'subagent', items: [{ id: 'a' }] }])
  })

  it('does not duplicate a turn another provider already reported', () => {
    const rest = [{ kind: 'turn' }]
    expect(archiveActivityFrames(true, rest)).toEqual([{ kind: 'turn' }])
  })

  it('passes the remaining activity through when the plugin is quiet', () => {
    const rest = [{ kind: 'job', items: [{ id: 'j1' }] }]
    expect(archiveActivityFrames(false, rest)).toEqual(rest)
    expect(archiveActivityFrames(false, rest)).not.toBe(rest)
  })
})

describe('ArchiveReleaseTracker', () => {
  function trackerWith(verdicts: ArchiveReleaseVerdict[]): {
    tracker: ArchiveReleaseTracker
    released: string[]
  } {
    const released: string[] = []
    const queue = [...verdicts]
    const tracker = new ArchiveReleaseTracker({
      release: (id) => {
        released.push(id)
        return queue.shift() ?? 'released'
      },
    })
    return { tracker, released }
  }

  it('treats the first write as a full baseline without losing the new archive', () => {
    const { tracker, released } = trackerWith(['none', 'released'])
    tracker.onDomainChange(workspaceWrite(['historical', 'fresh']))
    // Historical ids answer `none` in a real host; both are attempted exactly once.
    expect(released).toEqual(['historical', 'fresh'])
  })

  it('releases each id added by a later write exactly once', () => {
    const { tracker, released } = trackerWith(['released', 'released', 'released'])
    tracker.onDomainChange(workspaceWrite(['a', 'b']))
    tracker.onDomainChange(workspaceWrite(['a', 'b', 'c']))
    expect(released).toEqual(['a', 'b', 'c'])
  })

  it('keeps busy ids pending and retries them on the next pump', () => {
    const { tracker, released } = trackerWith(['busy', 'released'])
    tracker.onDomainChange(workspaceWrite(['a']))
    expect(released).toEqual(['a'])
    tracker.pump()
    expect(released).toEqual(['a', 'a'])
  })

  it('drops an unarchived id from pending', () => {
    const { tracker, released } = trackerWith(['busy'])
    tracker.onDomainChange(workspaceWrite(['a']))
    tracker.onDomainChange(workspaceWrite([]))
    tracker.pump()
    expect(released).toEqual(['a'])
  })

  it('survives a release that pumps re-entrantly', () => {
    let tracker: ArchiveReleaseTracker | undefined
    const calls: string[] = []
    let replays = 0
    tracker = new ArchiveReleaseTracker({
      release: (id) => {
        calls.push(id)
        // The release path broadcasts hub frames; the wiring calls pump again.
        if (replays < 2) {
          replays += 1
          tracker?.pump()
        }
        return id === 'a' ? 'busy' : 'released'
      },
    })
    tracker.onDomainChange(workspaceWrite(['a', 'b']))
    expect(calls.filter(id => id === 'b')).toHaveLength(1)
    tracker.pump()
    expect(calls.filter(id => id === 'a')).toHaveLength(3)
  })

  it('ignores foreign domain writes and never throws on a failing host', () => {
    const release = vi.fn(() => 'released' as const)
    const tracker = new ArchiveReleaseTracker({ release })
    tracker.onDomainChange({ domain: 'session', table: '', key: '', operation: 'put', value: {} })
    expect(release).not.toHaveBeenCalled()
    const failing = new ArchiveReleaseTracker({
      release: () => {
        throw new Error('boom')
      },
    })
    expect(() => failing.onDomainChange(workspaceWrite(['a']))).not.toThrow()
  })

  it('forgets everything on dispose', () => {
    const { tracker, released } = trackerWith(['busy'])
    tracker.onDomainChange(workspaceWrite(['a']))
    tracker.dispose()
    tracker.pump()
    expect(released).toHaveLength(1)
  })
})
