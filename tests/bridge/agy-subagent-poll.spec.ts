/**
 * Antigravity subagent transcript polling (task 2 of
 * docs/plan/antigravity-subagent-panel.md). The wire never reports a child's
 * completion: the poll service reads the child's brain transcript (activity,
 * the DONE fallback) and the parent transcript (the authoritative
 * SYSTEM_MESSAGE report), drives running → completed / unknown, and keeps a
 * non-terminal dispatch inside the silence windows counted as active work so
 * an idle release cannot kill the process out from under a silent child.
 */
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { afterAll, describe, expect, it } from 'vitest'
import { AcpLlmAdapter, BridgeManager, type BridgeTuning } from '../../src/bridge.ts'
import { EventHub } from '../../src/impl.ts'
import type { AcpAgentDef, AcpEvent, StreamChunk, SubagentRecord } from '../../src/protocol.ts'
import { def, hostLoopTurn, unexpectedSubagentFrames, until } from './harness.ts'

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

interface PollHarness {
  manager: BridgeManager
  events: AcpEvent[]
  adapter: AcpLlmAdapter
  workspace: string
  storage: string
  store: string
}

/**
 * A manager whose only agent is the mock with the Antigravity seam forced on
 * and a REAL transcript store: the mock writes the child step stream and the
 * parent report under it (MOCK_AGY_STORE). The poll cadence is shortened so
 * the ceiling tests run in seconds, not minutes.
 */
function pollHarness(options: { tuning?: BridgeTuning } = {}): PollHarness {
  const workspace = mkdtempSync(join(tmpdir(), 'dsh-ntr-agy-poll-'))
  const store = join(workspace, 'store')
  const storage = join(workspace, 'agents.json')
  const hub = new EventHub()
  const events: AcpEvent[] = []
  hub.subscribe(event => { events.push(event) })
  const agent: AcpAgentDef = {
    ...def,
    id: 'agy-poll',
    cwd: workspace,
    allowedCwdRoots: [workspace],
    env: { MOCK_AGY_STORE: store },
  }
  const manager = new BridgeManager(
    [agent],
    hub,
    500,
    storage,
    undefined,
    false,
    {
      startupTimeoutMs: 3_000,
      idleTimeoutMs: 60_000,
      cancelFallbackMs: 100,
      turnStallMs: 0,
      agyLateOutputPollMs: 100,
      ...options.tuning,
    },
    { isAgent: () => true, storeRoot: () => store },
  )
  return { manager, events, adapter: new AcpLlmAdapter(manager), workspace, storage, store }
}

describe('Antigravity subagent transcript polling', () => {
  const cleanups: Array<() => Promise<void>> = []
  afterAll(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup()
  })

  function harness(options: Parameters<typeof pollHarness>[0] = {}): PollHarness {
    const created = pollHarness(options)
    cleanups.push(async () => {
      await created.manager.shutdownAll()
      // Windows keeps the killed agent's transcript handles open for a moment,
      // and `force` only ignores a missing path — so the delete races EPERM
      // until the OS releases them. Retry, as `bridge.spec.ts` does for the
      // same observation; a temp dir that outlives the run is not a failure.
      rmSync(created.workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    })
    return created
  }

  function recordFrames(events: readonly AcpEvent[], since: number, childId = 'acp:agy_dispatch_1'): SubagentRecord[] {
    return events
      .slice(since)
      .filter((event): event is Extract<AcpEvent, { type: 'subagents/record' }> =>
        event.type === 'subagents/record' && event.record.childId === childId)
      .map(event => event.record)
  }

  function runTurn(subject: PollHarness, dshSessionId: string, text: string) {
    return hostLoopTurn(subject.adapter, {
      provider: 'acp',
      model: 'agy-poll',
      sessionId: dshSessionId,
      messages: [{ role: 'user', content: [{ type: 'text', text }] }],
    })
  }

  function persisted(subject: PollHarness): Record<string, SubagentRecord[]> | undefined {
    if (!existsSync(subject.storage)) return undefined
    const parsed = JSON.parse(readFileSync(subject.storage, 'utf-8')) as { subagents?: Record<string, SubagentRecord[]> }
    return parsed.subagents
  }

  function releaseAll(subject: PollHarness): void {
    const seam = subject.manager as unknown as { bridges: Map<string, { releaseAll(reason: string, cause: string): void }> }
    for (const bridge of seam.bridges.values()) bridge.releaseAll('test teardown', 'idle')
  }

  /** Observability only: the poll service's armed-watch count. */
  function armedCount(subject: PollHarness): number {
    const seam = subject.manager as unknown as { subagents: { agyPoll?: { armedCount: number } } }
    return seam.subagents.agyPoll?.armedCount ?? 0
  }

  function childFile(subject: PollHarness, childConversationId: string): string {
    return join(subject.store, 'brain', childConversationId, '.system_generated', 'logs', 'transcript.jsonl')
  }

  function parentFile(subject: PollHarness, dshSessionId: string): string {
    // The mock writes under the ACP session id (its own session/new id), which
    // the transcript view's snapshot carries; released sessions included.
    const acpSessionId = subject.manager.chatTranscripts(dshSessionId)[0]?.session.acpSessionId ?? 'missing'
    return join(subject.store, 'brain', acpSessionId, '.system_generated', 'logs', 'transcript_full.jsonl')
  }

  /** Append one child step the way agy does (test-side, timing controlled). */
  function appendChildStep(subject: PollHarness, childConversationId: string, stepIndex: number, type: string, status: string, content: string): void {
    const line = JSON.stringify({
      step_index: stepIndex,
      source: 'MODEL',
      type,
      status,
      created_at: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
      content,
    })
    appendFileSync(childFile(subject, childConversationId), `${line}\n`)
  }

  /** Append the parent's authoritative report frame for one child. */
  function appendParentReport(subject: PollHarness, dshSessionId: string, childConversationId: string): void {
    const content = `[Message] timestamp=${new Date().toISOString()} sender=${childConversationId} priority=MESSAGE_PRIORITY_HIGH content=done`
    const line = JSON.stringify({ step_index: 99, source: 'SYSTEM', type: 'SYSTEM_MESSAGE', status: 'DONE', content })
    appendFileSync(parentFile(subject, dshSessionId), `${line}\n`)
  }

  it('the parent report completes the child; both signals in one tick count ONE completion', async () => {
    const subject = harness()
    const dshSessionId = 'dsh-agy-poll-report'
    const since = subject.events.length
    await runTurn(subject, dshSessionId, 'AGY_DISPATCHREPORT please')
    await until(() => recordFrames(subject.events, since).some(frame => frame.status === 'completed'))
    const frames = recordFrames(subject.events, since)
    expect(frames.map(frame => frame.status)).toEqual(['pending', 'running', 'completed'])
    // The mock writes the child DONE and the parent report in the SAME write:
    // exactly one completed frame, one endedAt, no double announce.
    expect(frames.filter(frame => frame.status === 'completed')).toHaveLength(1)
    const completed = frames.at(-1)!
    expect(completed.endedAt).toBeDefined()
    expect(completed.childConversationId).toMatch(/^agy-child-/)
    // The child's transcript steps moved the counters (tool step included).
    expect(completed.counts.toolCalls).toBeGreaterThanOrEqual(1)
    expect(completed.counts.updates).toBeGreaterThanOrEqual(4)
    expect(unexpectedSubagentFrames(subject.events, since)).toEqual([])
    expect(persisted(subject)?.[dshSessionId]?.[0]?.status).toBe('completed')
    // Terminal dispatch: the watch is gone.
    await until(() => armedCount(subject) === 0)
  }, 30_000)

  it('the child DONE fallback completes when the parent report never lands', async () => {
    // A short quiet window keeps the gate observable: the DONE planner is the
    // newest step, so the fallback fires — but only AFTER the window, never
    // on the tick that first reads the DONE.
    const subject = harness({ tuning: { agyLateOutputQuietMs: 800 } })
    const dshSessionId = 'dsh-agy-poll-childdone'
    const since = subject.events.length
    await runTurn(subject, dshSessionId, 'AGY_DISPATCHCHILDDONE please')
    // 2 wire frames (dispatch + creation result) + 2 child steps: the DONE
    // planner response has just been read.
    await until(() => (subject.manager.subagentsFor(dshSessionId)[0]?.counts.updates ?? 0) >= 4)
    // The DONE was just read: the quiet window has not elapsed yet.
    expect(subject.manager.subagentsFor(dshSessionId)[0]?.status).toBe('running')
    await until(() => recordFrames(subject.events, since).some(frame => frame.status === 'completed'))
    expect(recordFrames(subject.events, since).map(frame => frame.status)).toEqual(['pending', 'running', 'completed'])
    // The parent transcript really carries no report: the fallback did it.
    const parent = readFileSync(parentFile(subject, dshSessionId), 'utf-8')
    expect(parent).not.toContain('SYSTEM_MESSAGE')
    expect(unexpectedSubagentFrames(subject.events, since)).toEqual([])
  }, 30_000)

  it('an intermediate planner DONE does not complete the child; the parent report does', async () => {
    const subject = harness()
    const dshSessionId = 'dsh-agy-poll-midturn'
    const since = subject.events.length
    await runTurn(subject, dshSessionId, 'AGY_DISPATCHMIDTURN please')
    // All five child steps are read (2 wire frames + 5 steps): the DONE at
    // step 2 was INTERMEDIATE — GENERIC work followed it, so the row must
    // still be running.
    await until(() => (subject.manager.subagentsFor(dshSessionId)[0]?.counts.updates ?? 0) >= 7)
    expect(subject.manager.subagentsFor(dshSessionId)[0]?.status).toBe('running')
    expect(recordFrames(subject.events, since).some(frame => frame.status === 'completed')).toBe(false)
    // Past the quiet window measured from the intermediate DONE (300ms +
    // 1500ms): a "latest planner seen so far" fallback would have fired by
    // now. The newest-step gate keeps the row running until the report.
    await sleep(1_000)
    expect(subject.manager.subagentsFor(dshSessionId)[0]?.status).toBe('running')
    expect(recordFrames(subject.events, since).some(frame => frame.status === 'completed')).toBe(false)
    // The authoritative parent report (the scenario's 6th step, ~4s)
    // completes it exactly once.
    await until(() => recordFrames(subject.events, since).some(frame => frame.status === 'completed'))
    const frames = recordFrames(subject.events, since)
    expect(frames.filter(frame => frame.status === 'completed')).toHaveLength(1)
    expect(frames.map(frame => frame.status)).toEqual(['pending', 'running', 'completed'])
    expect(readFileSync(parentFile(subject, dshSessionId), 'utf-8')).toContain('SYSTEM_MESSAGE')
    expect(unexpectedSubagentFrames(subject.events, since)).toEqual([])
    await until(() => armedCount(subject) === 0)
  }, 30_000)

  it('one child completing leaves the sibling running with its tail and watch alive', async () => {
    const subject = harness()
    const dshSessionId = 'dsh-agy-poll-siblings'
    const since = subject.events.length
    await runTurn(subject, dshSessionId, 'AGY_DISPATCHTWO please')
    await until(() => recordFrames(subject.events, since, 'acp:agy_dispatch_1').some(frame => frame.status === 'completed'))
    // The first child finished via its parent report; the second is untouched.
    const second = subject.manager.subagentsFor(dshSessionId).find(row => row.childId === 'acp:agy_dispatch_2')!
    expect(second.status).toBe('running')
    expect(second.endedAt).toBeUndefined()
    expect(recordFrames(subject.events, since, 'acp:agy_dispatch_2').some(frame => frame.status === 'completed' || frame.status === 'unknown')).toBe(false)
    // The session watch stays armed for the sibling (one watch per session).
    expect(armedCount(subject)).toBe(1)
    // The sibling's tail still reads: a new child step moves its counters.
    const before = second.counts.updates
    appendChildStep(subject, second.childConversationId!, 3, 'GENERIC', 'DONE', 'sibling still works')
    await until(() => (subject.manager.subagentsFor(dshSessionId).find(row => row.childId === 'acp:agy_dispatch_2')?.counts.updates ?? 0) > before)
    expect(subject.manager.subagentsFor(dshSessionId).find(row => row.childId === 'acp:agy_dispatch_2')?.status).toBe('running')
    // The sibling finishes via its OWN parent report: completed exactly once,
    // and only then does the watch withdraw.
    appendParentReport(subject, dshSessionId, second.childConversationId!)
    await until(() => recordFrames(subject.events, since, 'acp:agy_dispatch_2').some(frame => frame.status === 'completed'))
    expect(recordFrames(subject.events, since, 'acp:agy_dispatch_2').filter(frame => frame.status === 'completed')).toHaveLength(1)
    await until(() => armedCount(subject) === 0)
    expect(unexpectedSubagentFrames(subject.events, since)).toEqual([])
  }, 30_000)

  it('ERROR tool steps are runtime failures, not a terminal failure; DONE still completes', async () => {
    const subject = harness()
    const dshSessionId = 'dsh-agy-poll-error'
    const since = subject.events.length
    await runTurn(subject, dshSessionId, 'AGY_DISPATCHERROR please')
    await until(() => recordFrames(subject.events, since).some(frame => frame.status === 'completed'))
    const frames = recordFrames(subject.events, since)
    expect(frames.map(frame => frame.status)).toEqual(['pending', 'running', 'completed'])
    expect(frames.some(frame => frame.status === 'failed')).toBe(false)
    expect(unexpectedSubagentFrames(subject.events, since)).toEqual([])
  }, 30_000)

  it('a running child keeps its record running and moves activity in memory', async () => {
    const subject = harness()
    const dshSessionId = 'dsh-agy-poll-running'
    const since = subject.events.length
    await runTurn(subject, dshSessionId, 'AGY_DISPATCHOPENTOOL please')
    await until(() => (subject.manager.subagentsFor(dshSessionId)[0]?.counts.toolCalls ?? 0) >= 1)
    expect(armedCount(subject)).toBe(1)
    const row = subject.manager.subagentsFor(dshSessionId)[0]!
    expect(row.status).toBe('running')
    expect(row.endedAt).toBeUndefined()
    await sleep(300)
    // Still running: an open tool step is life, not a terminal signal.
    expect(subject.manager.subagentsFor(dshSessionId)[0]?.status).toBe('running')
    expect(recordFrames(subject.events, since).some(frame => frame.status === 'completed' || frame.status === 'unknown')).toBe(false)
    expect(subject.manager.subagentsFor(dshSessionId)[0]?.lastActivityAt).toBeGreaterThanOrEqual(row.lastActivityAt)
  }, 30_000)

  it('silence past the ceiling turns unknown and lets the idle release proceed', async () => {
    const subject = harness({ tuning: { idleTimeoutMs: 200, backgroundTaskToolMs: 400 } })
    const dshSessionId = 'dsh-agy-poll-silence'
    const since = subject.events.length
    await runTurn(subject, dshSessionId, 'AGY_DISPATCHSILENT please')
    await until(() => recordFrames(subject.events, since).some(frame => frame.status === 'unknown'))
    expect(recordFrames(subject.events, since).filter(frame => frame.status === 'unknown')).toHaveLength(1)
    expect(recordFrames(subject.events, since).map(frame => frame.status)).toEqual(['pending', 'running', 'unknown'])
    // Past the ceiling the dispatch no longer pins the process: the short idle
    // window releases it and parks the session (constraint 10).
    await until(() => subject.manager.agentViews()[0]?.state === 'stopped')
    expect(subject.manager.chatSessions(dshSessionId)[0]?.released).toBe(true)
    expect(persisted(subject)?.[dshSessionId]?.[0]?.status).toBe('unknown')
    expect(unexpectedSubagentFrames(subject.events, since)).toEqual([])
  }, 30_000)

  it('a silent child INSIDE the ceiling blocks the idle release', async () => {
    const subject = harness({ tuning: { idleTimeoutMs: 200, backgroundTaskToolMs: 60_000 } })
    const dshSessionId = 'dsh-agy-poll-blocked'
    const since = subject.events.length
    await runTurn(subject, dshSessionId, 'AGY_DISPATCHSILENT please')
    await until(() => recordFrames(subject.events, since).some(frame => frame.status === 'running'))
    // Several idle windows pass; the running dispatch pins the process.
    await sleep(700)
    expect(subject.manager.agentViews()[0]?.state).toBe('ready')
    expect(subject.events.slice(since).some(event => event.type === 'session/released')).toBe(false)
    expect(subject.manager.subagentsFor(dshSessionId)[0]?.status).toBe('running')
  }, 30_000)

  it('an open tool step grants the long ceiling past the plain silence window', async () => {
    const subject = harness({ tuning: { idleTimeoutMs: 200, backgroundTaskToolMs: 500, backgroundOpenToolCeilingMs: 10_000 } })
    const dshSessionId = 'dsh-agy-poll-opentool'
    await runTurn(subject, dshSessionId, 'AGY_DISPATCHOPENTOOL please')
    await until(() => (subject.manager.subagentsFor(dshSessionId)[0]?.counts.toolCalls ?? 0) >= 1)
    // The plain window (500ms) expires while the tool step stays open: the
    // long ceiling (10s) still counts the child as active work. The margin
    // is wide so full-suite load cannot expire it before the assertion.
    await sleep(1_200)
    expect(subject.manager.subagentsFor(dshSessionId)[0]?.status).toBe('running')
    expect(subject.manager.agentViews()[0]?.state).toBe('ready')
  }, 30_000)

  it('an open tool step past its OWN ceiling turns unknown', async () => {
    const subject = harness({ tuning: { backgroundTaskToolMs: 300, backgroundOpenToolCeilingMs: 600 } })
    const dshSessionId = 'dsh-agy-poll-toolceiling'
    const since = subject.events.length
    await runTurn(subject, dshSessionId, 'AGY_DISPATCHOPENTOOL please')
    await until(() => recordFrames(subject.events, since).some(frame => frame.status === 'unknown'))
    expect(recordFrames(subject.events, since).filter(frame => frame.status === 'unknown')).toHaveLength(1)
    expect(unexpectedSubagentFrames(subject.events, since)).toEqual([])
  }, 30_000)

  it('release stops the poll: a late child DONE and parent report never revive the row', async () => {
    const subject = harness()
    const dshSessionId = 'dsh-agy-poll-released'
    const since = subject.events.length
    await runTurn(subject, dshSessionId, 'AGY_DISPATCHSILENT please')
    await until(() => recordFrames(subject.events, since).some(frame => frame.status === 'running'))
    const childId = subject.manager.subagentsFor(dshSessionId)[0]?.childConversationId
    expect(childId).toBeDefined()
    releaseAll(subject)
    await until(() => recordFrames(subject.events, since).some(frame => frame.status === 'unknown'))
    expect(armedCount(subject)).toBe(0)
    const frozen = subject.manager.subagentsFor(dshSessionId)[0]!
    // The child "finishes" after the release: no poll may read it.
    appendChildStep(subject, childId!, 2, 'PLANNER_RESPONSE', 'DONE', 'late completion')
    appendParentReport(subject, dshSessionId, childId!)
    await sleep(400)
    expect(recordFrames(subject.events, since).some(frame => frame.status === 'completed')).toBe(false)
    const after = subject.manager.subagentsFor(dshSessionId)[0]!
    expect(after.status).toBe('unknown')
    expect(after.counts).toEqual(frozen.counts)
    expect(armedCount(subject)).toBe(0)
  }, 30_000)

  it('close stops the poll and prunes the records', async () => {
    const subject = harness()
    const dshSessionId = 'dsh-agy-poll-closed'
    const since = subject.events.length
    await runTurn(subject, dshSessionId, 'AGY_DISPATCHSILENT please')
    await until(() => recordFrames(subject.events, since).some(frame => frame.status === 'running'))
    const childId = subject.manager.subagentsFor(dshSessionId)[0]?.childConversationId
    const acpSessionId = subject.manager.chatSessions(dshSessionId)[0]?.sessionId
    await subject.manager.closeSession(acpSessionId!)
    expect(recordFrames(subject.events, since).at(-1)?.status).toBe('unknown')
    expect(subject.manager.subagentsFor(dshSessionId)).toEqual([])
    expect(persisted(subject)?.[dshSessionId]).toBeUndefined()
    expect(armedCount(subject)).toBe(0)
    appendChildStep(subject, childId!, 2, 'PLANNER_RESPONSE', 'DONE', 'late completion')
    await sleep(300)
    expect(recordFrames(subject.events, since).filter(frame => frame.status === 'completed')).toEqual([])
    expect(unexpectedSubagentFrames(subject.events, since)).toEqual([])
  }, 30_000)

  it('agents.json is written on transitions only; transcript activity stays in memory', async () => {
    const subject = harness()
    const dshSessionId = 'dsh-agy-poll-persist'
    await runTurn(subject, dshSessionId, 'AGY_DISPATCHOPENTOOL please')
    await until(() => persisted(subject)?.[dshSessionId]?.[0]?.status === 'running')
    const before = readFileSync(subject.storage, 'utf-8')
    const rowBefore = subject.manager.subagentsFor(dshSessionId)[0]!
    const childId = rowBefore.childConversationId!
    // A new child step: activity moves in memory, no transition, no write.
    appendChildStep(subject, childId, 3, 'GENERIC', 'DONE', 'tool result')
    await until(() => (subject.manager.subagentsFor(dshSessionId)[0]?.lastActivityAt ?? 0) > rowBefore.lastActivityAt)
    expect(subject.manager.subagentsFor(dshSessionId)[0]?.counts.updates).toBeGreaterThan(rowBefore.counts.updates)
    expect(readFileSync(subject.storage, 'utf-8')).toBe(before)
    // More poll ticks with nothing new: still byte-stable.
    await sleep(250)
    expect(readFileSync(subject.storage, 'utf-8')).toBe(before)
  }, 30_000)

  it('crash release marks unknown and a resume never revives the old poll', async () => {
    const subject = harness()
    const dshSessionId = 'dsh-agy-poll-resume'
    const since = subject.events.length
    await runTurn(subject, dshSessionId, 'AGY_DISPATCHSILENT please')
    await until(() => recordFrames(subject.events, since).some(frame => frame.status === 'running'))
    const childId = subject.manager.subagentsFor(dshSessionId)[0]?.childConversationId
    releaseAll(subject)
    await until(() => recordFrames(subject.events, since).some(frame => frame.status === 'unknown'))
    const resumeSince = subject.events.length
    await subject.manager.resumeChatSession(dshSessionId)
    // The view omits `released` when false (same as the idle-release specs).
    expect(subject.manager.chatSessions(dshSessionId)[0]?.released).toBeFalsy()
    expect(subject.manager.subagentsFor(dshSessionId)[0]?.status).toBe('unknown')
    expect(armedCount(subject)).toBe(0)
    // The historical child "finishes" after the resume: history is terminal,
    // no poll may be rebuilt for it.
    appendChildStep(subject, childId!, 2, 'PLANNER_RESPONSE', 'DONE', 'late completion')
    appendParentReport(subject, dshSessionId, childId!)
    await sleep(400)
    expect(subject.manager.subagentsFor(dshSessionId)[0]?.status).toBe('unknown')
    expect(recordFrames(subject.events, resumeSince)).toEqual([])
    expect(armedCount(subject)).toBe(0)
  }, 30_000)

  it('a dispatch whose creation result never lands still ends unknown past the ceiling', async () => {
    const subject = harness({ tuning: { backgroundTaskToolMs: 300 } })
    const dshSessionId = 'dsh-agy-poll-noresult'
    const since = subject.events.length
    await runTurn(subject, dshSessionId, 'AGY_DISPATCHNORESULT please')
    await until(() => recordFrames(subject.events, since).some(frame => frame.status === 'unknown'))
    expect(recordFrames(subject.events, since).map(frame => frame.status)).toEqual(['pending', 'unknown'])
    expect(unexpectedSubagentFrames(subject.events, since)).toEqual([])
  }, 30_000)

  it('a missing child file builds no tail; the parent report still completes', async () => {
    const subject = harness()
    const dshSessionId = 'dsh-agy-poll-nofile'
    const since = subject.events.length
    await runTurn(subject, dshSessionId, 'AGY_DISPATCHNOFILE please')
    await until(() => recordFrames(subject.events, since).some(frame => frame.status === 'completed'))
    const childId = subject.manager.subagentsFor(dshSessionId)[0]?.childConversationId
    expect(childId).toBeDefined()
    // No child transcript was ever written: no tail could be built on it.
    expect(existsSync(childFile(subject, childId!))).toBe(false)
    expect(recordFrames(subject.events, since).filter(frame => frame.status === 'completed')).toHaveLength(1)
    expect(unexpectedSubagentFrames(subject.events, since)).toEqual([])
  }, 30_000)

  it('recovers the conversationId from the parent creation step when the wire result has no content', async () => {
    // agy 1.5.5's completed creation frame carries no usable content
    // (session-a12ff72b). The id lives only in the parent GENERIC creation
    // step; without recovery the whole poll flies blind (no tail, no activity
    // extension, no completion match) and the row ends unknown at the ceiling.
    const subject = harness()
    const dshSessionId = 'dsh-agy-poll-wireless'
    const since = subject.events.length
    await runTurn(subject, dshSessionId, 'AGY_DISPATCHWIRELESS please')
    await until(() => recordFrames(subject.events, since).some(frame => frame.status === 'completed'))
    const frames = recordFrames(subject.events, since)
    // pending (wire result, no id) → running (recovered) → completed (report).
    expect(frames.map(frame => frame.status)).toEqual(['pending', 'running', 'completed'])
    const completed = frames.at(-1)!
    expect(completed.childConversationId).toMatch(/^agy-child-/)
    // The recovered id built the child tail: its steps moved the counters.
    expect(completed.counts.toolCalls).toBeGreaterThanOrEqual(1)
    expect(completed.counts.updates).toBeGreaterThanOrEqual(4)
    expect(persisted(subject)?.[dshSessionId]?.[0]?.childConversationId).toMatch(/^agy-child-/)
    expect(unexpectedSubagentFrames(subject.events, since)).toEqual([])
    await until(() => armedCount(subject) === 0)
  }, 30_000)

  it('the measured sender=system failure report terminalizes failed with the error payload', async () => {
    const subject = harness()
    const dshSessionId = 'dsh-agy-poll-fail'
    const since = subject.events.length
    await runTurn(subject, dshSessionId, 'AGY_DISPATCHFAIL please')
    await until(() => recordFrames(subject.events, since).some(frame => frame.status === 'failed'))
    const frames = recordFrames(subject.events, since)
    expect(frames.map(frame => frame.status)).toEqual(['pending', 'running', 'failed'])
    const failed = frames.at(-1)!
    expect(failed.endedAt).toBeDefined()
    expect(String(failed.error)).toContain('encountered an error')
    expect(failed.childConversationId).toMatch(/^agy-child-/)
    // ONE error-level notice names the worker and the reason (settings log).
    const notices = subject.events.slice(since).filter(event => event.type === 'agent/notice')
    expect(notices).toHaveLength(1)
    expect(notices[0]).toMatchObject({ level: 'error' })
    expect(String((notices[0] as { text: string }).text)).toContain('failed')
    expect(persisted(subject)?.[dshSessionId]?.[0]?.status).toBe('failed')
    expect(unexpectedSubagentFrames(subject.events, since)).toEqual([])
    await until(() => armedCount(subject) === 0)
  }, 30_000)

  it('a creation step and failure report in ONE batch still terminalize failed (wireless)', async () => {
    // The creation step and the failure report land in the SAME readNew batch
    // (wireless result, both written synchronously). The poll must claim the
    // recovered id BEFORE matching reports: readNew consumes incrementally, so
    // a report skipped for a missing childId never returns — and the failure
    // direction has no child-transcript fallback (P1-1 regression).
    const subject = harness()
    const dshSessionId = 'dsh-agy-poll-failwireless'
    const since = subject.events.length
    await runTurn(subject, dshSessionId, 'AGY_DISPATCHFAILWIRELESS please')
    await until(() => recordFrames(subject.events, since).some(frame => frame.status === 'failed'))
    const frames = recordFrames(subject.events, since)
    expect(frames.map(frame => frame.status)).toEqual(['pending', 'running', 'failed'])
    const failed = frames.at(-1)!
    expect(failed.childConversationId).toMatch(/^agy-child-/)
    expect(String(failed.error)).toContain('encountered an error')
    const notices = subject.events.slice(since).filter(event => event.type === 'agent/notice')
    expect(notices).toHaveLength(1)
    expect(unexpectedSubagentFrames(subject.events, since)).toEqual([])
    await until(() => armedCount(subject) === 0)
  }, 30_000)
})
