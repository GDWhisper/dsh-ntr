/**
 * Antigravity dispatch recognition + lifecycle records (task 1 of
 * docs/plan/antigravity-subagent-panel.md). agy sends NO CodeBuddy `_meta`:
 * the dispatch is an ordinary `invoke_subagent` tool call whose COMPLETED
 * result only says the child was CREATED. The record therefore stops at
 * `running` (never `completed` from the wire), teardown writes the terminal
 * state, and the whole bookkeeping is invisible to non-agy agents.
 */
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { afterAll, describe, expect, it } from 'vitest'
import { AcpLlmAdapter, BridgeManager, type BridgeTuning } from '../../src/bridge.ts'
import { EventHub } from '../../src/impl.ts'
import type { AcpAgentDef, AcpEvent, StreamChunk, SubagentRecord } from '../../src/protocol.ts'
import { def, hostLoopTurn, unexpectedSubagentFrames, until } from './harness.ts'

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

function textOf(chunks: readonly StreamChunk[]): string {
  return chunks
    .filter((chunk): chunk is Extract<StreamChunk, { type: 'text-delta' }> => chunk.type === 'text-delta')
    .map(chunk => chunk.text)
    .join('')
}

interface AgyHarness {
  manager: BridgeManager
  events: AcpEvent[]
  adapter: AcpLlmAdapter
  workspace: string
  storage: string
}

/**
 * A manager whose only agent is the mock with the Antigravity seam forced on
 * (`isAgent: () => true`, the same probe the late-output watch reads). No
 * MOCK_AGY_STORE: the dispatch scenarios need no transcript file (task 2).
 */
function agyHarness(options: { probe?: boolean; tuning?: BridgeTuning; env?: Record<string, string>; storage?: string } = {}): AgyHarness {
  const workspace = mkdtempSync(join(tmpdir(), 'dsh-ntr-agy-subagents-'))
  const storage = options.storage ?? join(workspace, 'agents.json')
  const hub = new EventHub()
  const events: AcpEvent[] = []
  hub.subscribe(event => { events.push(event) })
  const agent: AcpAgentDef = {
    ...def,
    id: 'agy-sub',
    cwd: workspace,
    allowedCwdRoots: [workspace],
    env: { ...options.env },
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
      ...options.tuning,
    },
    options.probe === false ? undefined : { isAgent: () => true, storeRoot: () => join(workspace, 'store') },
  )
  return { manager, events, adapter: new AcpLlmAdapter(manager), workspace, storage }
}

describe('Antigravity dispatch lifecycle records', () => {
  const cleanups: Array<() => Promise<void>> = []
  afterAll(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup()
  })

  function harness(options: Parameters<typeof agyHarness>[0] = {}): AgyHarness {
    const created = agyHarness(options)
    cleanups.push(async () => {
      await created.manager.shutdownAll()
      rmSync(created.workspace, { recursive: true, force: true })
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

  function runTurn(subject: AgyHarness, dshSessionId: string, text: string) {
    return hostLoopTurn(subject.adapter, {
      provider: 'acp',
      model: 'agy-sub',
      sessionId: dshSessionId,
      messages: [{ role: 'user', content: [{ type: 'text', text }] }],
    })
  }

  /** ONE driver step, no host-loop continuation: the turn closes at the response. */
  async function singleStep(subject: AgyHarness, dshSessionId: string, text: string, signal?: AbortSignal): Promise<StreamChunk[]> {
    const chunks: StreamChunk[] = []
    for await (const chunk of subject.adapter.stream({
      provider: 'acp',
      model: 'agy-sub',
      sessionId: dshSessionId,
      messages: [{ role: 'user', content: [{ type: 'text', text }] }],
      ...(signal === undefined ? {} : { signal }),
    })) chunks.push(chunk)
    return chunks
  }

  function persisted(subject: AgyHarness): Record<string, SubagentRecord[]> | undefined {
    if (!existsSync(subject.storage)) return undefined
    const parsed = JSON.parse(readFileSync(subject.storage, 'utf-8')) as { subagents?: Record<string, SubagentRecord[]> }
    return parsed.subagents
  }

  function releaseAll(subject: AgyHarness): void {
    const seam = subject.manager as unknown as { bridges: Map<string, { releaseAll(reason: string, cause: string): void }> }
    for (const bridge of seam.bridges.values()) bridge.releaseAll('test teardown', 'idle')
  }

  it('announces pending at dispatch and running at the creation result, without a catalog gate', async () => {
    const subject = harness()
    const dshSessionId = 'dsh-agy-dispatch-basic'
    const since = subject.events.length
    // No reporter wired: the record stream must NOT wait for catalog acceptance.
    const { chunks } = await runTurn(subject, dshSessionId, 'AGY_DISPATCH please')
    expect(textOf(chunks)).toContain('AGY-DISPATCH-ACK')
    await until(() => recordFrames(subject.events, since).length >= 2)

    const frames = recordFrames(subject.events, since)
    expect(frames.map(frame => frame.status)).toEqual(['pending', 'running'])
    expect(frames[0]).toMatchObject({
      childId: 'acp:agy_dispatch_1',
      dshSessionId,
      toolCallId: 'agy_dispatch_1',
      label: 'License Migrator',
      type: 'self',
    })
    expect(frames[0].childConversationId).toBeUndefined()
    expect(frames[0].startedAt).toBeGreaterThan(0)
    const running = frames.at(-1)!
    // The creation result is NOT a completion: no terminal state, no endedAt.
    expect(running.status).toBe('running')
    expect(running.endedAt).toBeUndefined()
    expect(running.childConversationId).toMatch(/^agy-child-mock-sess-\d+-\d+-1$/)
    expect(running.counts.updates).toBeGreaterThanOrEqual(2)
    expect(unexpectedSubagentFrames(subject.events, since)).toEqual([])
    // The snapshot carries the running row (live session).
    expect(subject.manager.subagentsFor(dshSessionId)[0]?.status).toBe('running')
    expect(subject.manager.chatSessions(dshSessionId)[0]?.subagents?.map(row => row.status)).toEqual(['running'])
  }, 30_000)

  it('reports one catalog row per dispatch with the rawInput label', async () => {
    const subject = harness()
    const dshSessionId = 'dsh-agy-dispatch-catalog'
    const since = subject.events.length
    const calls: Array<{ childId: string; label: string }> = []
    subject.manager.setSubagentCatalogReporter((_sessionId, childId, label) => { calls.push({ childId, label }) })
    try {
      await runTurn(subject, dshSessionId, 'AGY_DISPATCHTWO please')
    } finally {
      subject.manager.setSubagentCatalogReporter(undefined)
    }
    await until(() => calls.length === 2)
    // One fact per call, in dispatch order — the trigger's cumulative count.
    expect(calls).toEqual([
      { childId: 'acp:agy_dispatch_1', label: 'License Migrator' },
      { childId: 'acp:agy_dispatch_2', label: 'Header Auditor' },
    ])
    expect(recordFrames(subject.events, since, 'acp:agy_dispatch_1').map(frame => frame.status)).toEqual(['pending', 'running'])
    expect(recordFrames(subject.events, since, 'acp:agy_dispatch_2').map(frame => frame.status)).toEqual(['pending', 'running'])
    expect(unexpectedSubagentFrames(subject.events, since)).toEqual([])
  }, 30_000)

  it('records a title-only dispatch but waits for identity before the catalog report', async () => {
    const subject = harness()
    const dshSessionId = 'dsh-agy-dispatch-bare'
    const since = subject.events.length
    const calls: string[] = []
    subject.manager.setSubagentCatalogReporter((_sessionId, childId) => { calls.push(childId) })
    try {
      await runTurn(subject, dshSessionId, 'AGY_DISPATCHBARE please')
    } finally {
      subject.manager.setSubagentCatalogReporter(undefined)
    }
    await until(() => recordFrames(subject.events, since).length >= 2)
    const frames = recordFrames(subject.events, since)
    expect(frames.map(frame => frame.status)).toEqual(['pending', 'running'])
    expect(frames[0].label).toBe('Run invoke_subagent')
    expect(frames[0].type).toBeUndefined()
    // No identity ever declared: the catalog row waits (no completion fallback
    // exists on this wire — the result is creation, not completion).
    expect(calls).toEqual([])
  }, 30_000)

  it('moves the record when the creation result lands after the turn closed', async () => {
    const subject = harness()
    const dshSessionId = 'dsh-agy-dispatch-late'
    const since = subject.events.length
    // One driver step: the turn closes at the response. (The ack text may
    // land transcript-only — the response can race the last notification —
    // so the record, not the chunk text, is this test's subject.)
    await singleStep(subject, dshSessionId, 'AGY_DISPATCHLATE please')
    // The result is scheduled 200ms out; the turn is already closed. Only the
    // session-level tracker can still move the record.
    await until(() => recordFrames(subject.events, since).some(frame => frame.status === 'running'))
    const frames = recordFrames(subject.events, since)
    expect(frames.map(frame => frame.status)).toEqual(['pending', 'running'])
    expect(frames.at(-1)?.childConversationId).toMatch(/^agy-child-/)
    expect(subject.manager.subagentsFor(dshSessionId)[0]?.status).toBe('running')
  }, 30_000)

  it('cancel writes cancelled and the late creation result never revives it', async () => {
    const subject = harness()
    const dshSessionId = 'dsh-agy-dispatch-cancel'
    const since = subject.events.length
    const abort = new AbortController()
    const running = singleStep(subject, dshSessionId, 'AGY_DISPATCHSLOW please', abort.signal)
    await until(() => recordFrames(subject.events, since).some(frame => frame.status === 'pending'))
    abort.abort()
    await running
    await until(() => recordFrames(subject.events, since).some(frame => frame.status === 'cancelled'))
    const frames = recordFrames(subject.events, since)
    expect(frames.at(-1)?.status).toBe('cancelled')
    expect(frames.at(-1)?.endedAt).toBeDefined()
    // The mock's creation result lands at ~1.2s, after the cancel: a terminal
    // row is never overwritten by a late frame.
    const count = frames.length
    await sleep(1_500)
    expect(recordFrames(subject.events, since)).toHaveLength(count)
    expect(subject.manager.subagentsFor(dshSessionId)[0]?.status).toBe('cancelled')
    expect(unexpectedSubagentFrames(subject.events, since)).toEqual([])
  }, 30_000)

  it('release leaves unknown — never running — and keeps the record on the parked row', async () => {
    const subject = harness()
    const dshSessionId = 'dsh-agy-dispatch-release'
    const since = subject.events.length
    await singleStep(subject, dshSessionId, 'AGY_DISPATCHNORESULT please')
    await until(() => recordFrames(subject.events, since).some(frame => frame.status === 'pending'))
    releaseAll(subject)
    await until(() => recordFrames(subject.events, since).some(frame => frame.status === 'unknown'))
    const frames = recordFrames(subject.events, since)
    expect(frames.at(-1)?.status).toBe('unknown')
    expect(frames.at(-1)?.endedAt).toBeDefined()
    expect(unexpectedSubagentFrames(subject.events, since)).toEqual([])
    const rows = subject.manager.chatSessions(dshSessionId)
    expect(rows[0]?.released).toBe(true)
    expect(rows[0]?.subagents?.map(row => row.status)).toEqual(['unknown'])
  }, 30_000)

  it('close leaves unknown and prunes the closed conversation\'s records', async () => {
    const subject = harness()
    const dshSessionId = 'dsh-agy-dispatch-close'
    const since = subject.events.length
    await runTurn(subject, dshSessionId, 'AGY_DISPATCH please')
    await until(() => recordFrames(subject.events, since).some(frame => frame.status === 'running'))
    const acpSessionId = subject.manager.chatSessions(dshSessionId)[0]?.sessionId
    expect(acpSessionId).toBeDefined()
    await subject.manager.closeSession(acpSessionId!)
    expect(recordFrames(subject.events, since).at(-1)?.status).toBe('unknown')
    expect(unexpectedSubagentFrames(subject.events, since)).toEqual([])
    expect(subject.manager.subagentsFor(dshSessionId)).toEqual([])
    expect(persisted(subject)?.[dshSessionId]).toBeUndefined()
  }, 30_000)

  it('force reset leaves unknown', async () => {
    const subject = harness()
    const dshSessionId = 'dsh-agy-dispatch-reset'
    const since = subject.events.length
    await singleStep(subject, dshSessionId, 'AGY_DISPATCHNORESULT please')
    await until(() => recordFrames(subject.events, since).some(frame => frame.status === 'pending'))
    const seam = subject.manager as unknown as { bridges: Map<string, { forceReset(reason: string): void }> }
    for (const bridge of seam.bridges.values()) bridge.forceReset('agent-stopped')
    await until(() => recordFrames(subject.events, since).some(frame => frame.status === 'unknown'))
    expect(recordFrames(subject.events, since).at(-1)?.status).toBe('unknown')
    expect(unexpectedSubagentFrames(subject.events, since)).toEqual([])
  }, 30_000)

  it('writes agents.json on transitions only and keeps childConversationId on disk', async () => {
    const subject = harness()
    const stableId = 'dsh-agy-dispatch-persist-stable'
    await singleStep(subject, stableId, 'AGY_DISPATCHNORESULT please')
    await until(() => persisted(subject)?.[stableId]?.[0]?.status === 'pending')
    // Creation wrote the file; no further transition happens, so the file must
    // stay byte-identical while the session sits idle.
    const during = readFileSync(subject.storage, 'utf-8')
    await sleep(250)
    expect(readFileSync(subject.storage, 'utf-8')).toBe(during)

    const runningId = 'dsh-agy-dispatch-persist-running'
    await runTurn(subject, runningId, 'AGY_DISPATCH please')
    await until(() => persisted(subject)?.[runningId]?.[0]?.status === 'running')
    const onDisk = persisted(subject)?.[runningId]?.[0]
    expect(onDisk?.childConversationId).toMatch(/^agy-child-mock-sess-\d+-\d+-1$/)
    expect(onDisk?.childConversationId).toBe(subject.manager.subagentsFor(runningId)[0]?.childConversationId)
  }, 30_000)

  it('a host restart restores the record and the load replay creates nothing', async () => {
    const storage = join(tmpdir(), `dsh-ntr-agy-replay-${String(process.pid)}-${String(Date.now())}.json`)
    const dshSessionId = 'dsh-agy-dispatch-replay'
    const first = agyHarness({ storage, env: { MOCK_AGY_LOAD_REPLAY: '1' } })
    let second: AgyHarness | undefined
    let original: SubagentRecord | undefined
    try {
      try {
        await runTurn(first, dshSessionId, 'AGY_DISPATCH please')
        await until(() => first.manager.subagentsFor(dshSessionId)[0]?.status === 'running')
        original = first.manager.subagentsFor(dshSessionId)[0]
        expect(original?.childConversationId).toMatch(/^agy-child-/)
      } finally {
        await first.manager.shutdownAll()
      }
      // The dispose path terminalized the running row and persisted it.
      const onDisk = JSON.parse(readFileSync(storage, 'utf-8')) as { subagents?: Record<string, SubagentRecord[]> }
      expect(onDisk.subagents?.[dshSessionId]?.[0]?.status).toBe('unknown')
      expect(onDisk.subagents?.[dshSessionId]?.[0]?.childConversationId).toBe(original?.childConversationId)

      second = agyHarness({ storage, env: { MOCK_AGY_LOAD_REPLAY: '1' } })
      expect(second.manager.subagentsFor(dshSessionId)[0]).toMatchObject({
        status: 'unknown',
        startedAt: original!.startedAt,
        childConversationId: original!.childConversationId,
      })
      const since = second.events.length
      await second.manager.resumeChatSession(dshSessionId)
      // The replayed dispatch + creation result are history: no new record,
      // no regression of the restored one.
      const rows = second.manager.subagentsFor(dshSessionId)
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({
        status: 'unknown',
        startedAt: original!.startedAt,
        childConversationId: original!.childConversationId,
      })
      expect(recordFrames(second.events, since).filter(frame => frame.status === 'pending' || frame.status === 'running')).toEqual([])
      // Constraint 29: skipping bookkeeping must not drop the replay DATA.
      const entries = second.manager.chatTranscripts(dshSessionId)[0]?.entries as Array<{ update: Record<string, unknown> }> | undefined
      expect(entries?.some(entry => entry.update.toolCallId === 'agy_dispatch_1' && entry.update.sessionUpdate === 'tool_call')).toBe(true)
      expect(entries?.some(entry => entry.update.toolCallId === 'agy_dispatch_1' && entry.update.status === 'completed')).toBe(true)
    } finally {
      await second?.manager.shutdownAll()
      // The restored session's cwd names the FIRST workspace: it must outlive
      // the restart, so both workspaces go only here.
      rmSync(first.workspace, { recursive: true, force: true })
      if (second !== undefined) rmSync(second.workspace, { recursive: true, force: true })
      rmSync(storage, { force: true })
    }
  }, 30_000)

  it('an in-process release + resume replay does not touch the terminal dispatch', async () => {
    const subject = harness({ env: { MOCK_AGY_LOAD_REPLAY: '1' } })
    const dshSessionId = 'dsh-agy-dispatch-replay-inproc'
    await runTurn(subject, dshSessionId, 'AGY_DISPATCH please')
    await until(() => subject.manager.subagentsFor(dshSessionId)[0]?.status === 'running')
    const original = subject.manager.subagentsFor(dshSessionId)[0]
    releaseAll(subject)
    await until(() => subject.manager.subagentsFor(dshSessionId)[0]?.status === 'unknown')
    const since = subject.events.length
    await subject.manager.resumeChatSession(dshSessionId)
    const rows = subject.manager.subagentsFor(dshSessionId)
    expect(rows).toHaveLength(1)
    // The surviving dispatch map is skipped whole: not even counters move.
    expect(rows[0]).toMatchObject({ status: 'unknown', startedAt: original!.startedAt, counts: original!.counts })
    expect(recordFrames(subject.events, since)).toEqual([])
  }, 30_000)

  it('non-agy agents get no dispatch records, but the frames still fold', async () => {
    const subject = harness({ probe: false })
    const dshSessionId = 'dsh-agy-dispatch-nonagy'
    const since = subject.events.length
    const { chunks } = await runTurn(subject, dshSessionId, 'AGY_DISPATCH please')
    expect(textOf(chunks)).toContain('AGY-DISPATCH-ACK')
    // Give any (wrong) bookkeeping room to speak before asserting silence.
    await sleep(200)
    expect(subject.events.slice(since).filter(event => event.type === 'subagents/record')).toEqual([])
    expect(subject.manager.subagentsFor(dshSessionId)).toEqual([])
    // Constraint 29: the tool frames still reach the transcript view.
    const entries = subject.manager.chatTranscripts(dshSessionId)[0]?.entries as Array<{ update: Record<string, unknown> }> | undefined
    expect(entries?.some(entry => entry.update.toolCallId === 'agy_dispatch_1')).toBe(true)
  }, 30_000)
})