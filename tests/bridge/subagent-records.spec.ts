import { tmpdir } from 'node:os'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { afterAll, describe, expect, it } from 'vitest'
import { AcpLlmAdapter, BridgeManager } from '../../src/bridge.ts'
import { type AcpEvent, type StreamChunk, type SubagentRecord } from '../../src/protocol.ts'
import { EventHub } from '../../src/impl.ts'
import { def, hostLoopTurn, unexpectedSubagentFrames } from './harness.ts'

/**
 * The plugin-owned lifecycle record for external workers: six states derived
 * from the wire, terminal rows persisted in `agents.json` on TRANSITIONS only,
 * and a snapshot carried on `session/chat-list` for live AND released sessions.
 * This is the ONLY lifecycle source — the legacy per-worker dot feed is
 * retired and must never appear again.
 */
describe('external subagent lifecycle records (isolated manager)', () => {
  const recordWorkspace = `${tmpdir()}/dsh-ntr-subagent-records-workspace`
  mkdirSync(recordWorkspace, { recursive: true })
  const recordStorage = `${tmpdir()}/dsh-ntr-subagent-records-${String(process.pid)}-${String(Date.now())}.json`
  const recordHub = new EventHub()
  const recordEvents: AcpEvent[] = []
  recordHub.subscribe(event => { recordEvents.push(event) })
  const recordManager = new BridgeManager(
    [{ ...def, id: 'record', cwd: recordWorkspace, allowedCwdRoots: [recordWorkspace] }],
    recordHub,
    500,
    recordStorage,
    undefined,
    false,
    {
      startupTimeoutMs: 3_000,
      cancelFallbackMs: 100,
      ambientQuietMs: 250,
      backgroundTaskMaxMs: 1_500,
      backgroundTaskToolMs: 8_000,
      backgroundParkedGraceMs: 1_000,
      // These cases pin the LEGACY worker-phase hold; the product default
      // closes the turn at the response so the user keeps talking.
      backgroundHoldWorkerPhase: true,
    },
  )
  const recordAdapter = new AcpLlmAdapter(recordManager)

  afterAll(async () => {
    await recordManager.shutdownAll()
    rmSync(recordStorage, { force: true })
  })

  function recordText(chunks: StreamChunk[]): string {
    return chunks
      .filter((chunk): chunk is Extract<StreamChunk, { type: 'text-delta' }> => chunk.type === 'text-delta')
      .map(chunk => chunk.text)
      .join('')
  }

  function recordFrames(since: number, childId = 'acp:agent_dispatch'): SubagentRecord[] {
    return recordEvents
      .slice(since)
      .filter((event): event is Extract<AcpEvent, { type: 'subagents/record' }> =>
        event.type === 'subagents/record' && event.record.childId === childId)
      .map(event => event.record)
  }

  async function waitForRecordHold(dshSessionId: string): Promise<void> {
    const deadline = Date.now() + 10_000
    for (;;) {
      const live = recordManager.turnStreamFor(dshSessionId)
      if (live !== undefined && !live.hasSettled && live.hasOpenSegment && live.session.settled === undefined) return
      if (Date.now() > deadline) throw new Error('the turn never entered a detached-worker hold')
      await new Promise(resolve => setTimeout(resolve, 5))
    }
  }

  function runRecordTurn(dshSessionId: string, text: string, signal?: AbortSignal) {
    return hostLoopTurn(recordAdapter, {
      provider: 'acp',
      model: 'record',
      sessionId: dshSessionId,
      messages: [{ role: 'user', content: [{ type: 'text', text }] }],
    }, 8, signal)
  }

  function persistedRecords(): Record<string, SubagentRecord[]> | undefined {
    if (!existsSync(recordStorage)) return undefined
    const parsed = JSON.parse(readFileSync(recordStorage, 'utf-8')) as { subagents?: Record<string, SubagentRecord[]> }
    return parsed.subagents
  }

  it('announces creation + completion, keeps the catalog report, and serves the detail read', async () => {
    const dshSessionId = 'dsh-dispatch-record-completed'
    const since = recordEvents.length
    const calls: string[] = []
    recordManager.setSubagentCatalogReporter((_sessionId, childId) => { calls.push(childId) })
    try {
      const { chunks } = await runRecordTurn(dshSessionId, 'DISPATCH please')
      expect(recordText(chunks)).toContain('DISPATCH-FINAL-ANSWER')
    } finally {
      recordManager.setSubagentCatalogReporter(undefined)
    }

    const frames = recordFrames(since)
    // Creation announces `running` (the first frame says in_progress), the
    // completion announces `completed`; nothing per worker update in between.
    expect(frames.map(frame => frame.status)).toEqual(['running', 'completed'])
    expect(frames[0].dshSessionId).toBe(dshSessionId)
    expect(frames[0].toolCallId).toBe('agent_dispatch')
    expect(frames[0].label).toBe('general-purpose · explorer')
    expect(frames[0].startedAt).toBeGreaterThan(0)
    const terminal = frames.at(-1)!
    // The role arrives on the detached re-send, after creation: it is carried
    // forward into the terminal record rather than announcing a frame of its
    // own (the status did not change).
    expect(terminal.type).toBe('general-purpose')
    expect(terminal.endedAt).toBeDefined()
    expect(terminal.error).toBeUndefined()
    expect(terminal.counts.updates).toBeGreaterThan(1)
    expect(terminal.counts.toolCalls).toBeGreaterThanOrEqual(1)
    expect(terminal.counts.textChars).toBeGreaterThan(0)

    // The retired dot feed is gone; the record stream is the only lifecycle
    // source, and the catalog row is still reported exactly once.
    expect(unexpectedSubagentFrames(recordEvents, since)).toEqual([])
    expect(calls).toEqual(['acp:agent_dispatch'])

    // The snapshot carries the terminal record (live session).
    const rows = recordManager.chatSessions(dshSessionId)
    expect(rows[0]?.subagents?.map(row => row.status)).toEqual(['completed'])

    // On-demand detail: both filters hit — the dispatch's own frames (raw
    // input / completion) and the worker's frames (`parentToolCallId`).
    const detail = recordManager.subagentsDetail(dshSessionId, 'acp:agent_dispatch')
    expect(detail.omitted).toBeUndefined()
    const updates = detail.entries.map(entry => entry.update as Record<string, unknown>)
    expect(updates.some(update => update.toolCallId === 'agent_dispatch'
      && update.sessionUpdate === 'tool_call'
      && update.rawInput !== undefined)).toBe(true)
    expect(updates.some(update => update.toolCallId === 'agent_dispatch'
      && update.status === 'completed')).toBe(true)
    expect(updates.some(update => (update._meta as Record<string, unknown> | undefined)?.['codebuddy.ai/parentToolCallId'] === 'agent_dispatch')).toBe(true)
    // Unknown worker / foreign conversation: empty, not an internal error.
    expect(recordManager.subagentsDetail(dshSessionId, 'acp:missing')).toEqual({ entries: [] })
    expect(recordManager.subagentsDetail('dsh-other', 'acp:agent_dispatch')).toEqual({ entries: [] })
  }, 30_000)

  it('records a failed worker with the agent\'s own reason, and the hold semantics do not change', async () => {
    const dshSessionId = 'dsh-dispatch-record-failed'
    const since = recordEvents.length
    const { chunks, steps } = await runRecordTurn(dshSessionId, 'DISPATCH DISPATCHFAILED please')
    // A FAILED worker still counts as "reported": the drain phase starts, the
    // turn keeps holding and folds the drain's answer (constraint 23 untouched).
    expect(recordText(chunks)).toContain('DISPATCH-FINAL-ANSWER')
    expect(steps).toHaveLength(2)

    const frames = recordFrames(since)
    expect(frames.map(frame => frame.status)).toEqual(['running', 'failed'])
    // No reporter is wired in this test: the host catalog never accepted the
    // row, and the record stream is deliberately NOT gated on that acceptance
    // (the panel must see it). The retired dot feed never speaks either way.
    expect(unexpectedSubagentFrames(recordEvents, since)).toEqual([])
    const terminal = frames.at(-1)!
    // The failure reason is the completion frame's `content`, verbatim.
    expect(terminal.error).toEqual([{
      type: 'content',
      content: { type: 'text', text: 'WORKER-FAILED-REASON' },
    }])
    expect(terminal.endedAt).toBeDefined()
    // The activity clock moved with the worker's own frames, and rode along
    // with the terminal write instead of causing one of its own.
    expect(terminal.lastActivityAt).toBeGreaterThan(terminal.startedAt)
    expect(recordManager.subagentsFor(dshSessionId)[0]?.status).toBe('failed')
  }, 30_000)

  it('starts a status-less dispatch as pending and flips it to running on the first worker frame', async () => {
    const dshSessionId = 'dsh-dispatch-record-pending'
    const since = recordEvents.length
    const { chunks } = await runRecordTurn(dshSessionId, 'DISPATCHNOSTATUS please')
    expect(recordText(chunks)).toContain('DISPATCH-FINAL-ANSWER')
    expect(recordFrames(since).map(frame => frame.status)).toEqual(['pending', 'running', 'completed'])
  }, 30_000)

  it('cancels a still-open worker when the user cancels the holding turn, and a late completion does not rewrite it', async () => {
    const dshSessionId = 'dsh-dispatch-record-cancelled'
    const since = recordEvents.length
    const abort = new AbortController()
    const running = runRecordTurn(dshSessionId, 'DISPATCHSLOW please', abort.signal)
    await waitForRecordHold(dshSessionId)
    abort.abort()
    await Promise.race([
      running,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('the holding step never closed')), 5_000)),
    ])

    const afterCancel = recordFrames(since)
    expect(afterCancel.at(-1)?.status).toBe('cancelled')
    expect(afterCancel.at(-1)?.endedAt).toBeDefined()
    expect(unexpectedSubagentFrames(recordEvents, since)).toEqual([])
    // No row is left running anywhere in the snapshot either.
    expect(recordManager.subagentsFor(dshSessionId).some(row => row.status === 'running' || row.status === 'pending')).toBe(false)

    // The mock's worker still reports into the closed turn; the controller is
    // gone by then, so the record must not be revived.
    const framesAtCancel = afterCancel.length
    await new Promise(resolve => setTimeout(resolve, 1_200))
    expect(recordFrames(since)).toHaveLength(framesAtCancel)
    expect(recordManager.subagentsFor(dshSessionId)[0]?.status).toBe('cancelled')
  }, 30_000)

  it('writes the state file on transitions only, never on worker activity', async () => {
    const dshSessionId = 'dsh-dispatch-record-persist'
    const running = runRecordTurn(dshSessionId, 'DISPATCHSLOW please')
    await waitForRecordHold(dshSessionId)
    // Creation (and the pending→running flip, if any) already wrote the file.
    const duringHold = readFileSync(recordStorage, 'utf-8')
    expect(duringHold).toContain('acp:agent_dispatch')
    // The worker keeps streaming for the next several hundred ms. Those frames
    // move `lastActivityAt` in memory; the file is a synchronous full rewrite
    // and must not be touched per chunk.
    await new Promise(resolve => setTimeout(resolve, 250))
    expect(readFileSync(recordStorage, 'utf-8')).toBe(duringHold)

    await running
    const afterTerminal = persistedRecords()
    expect(afterTerminal?.[dshSessionId]?.map(row => row.status)).toEqual(['completed'])
  }, 30_000)

  it('leaves unknown — never running — when the process is released, and keeps the record for the released session', async () => {
    const dshSessionId = 'dsh-dispatch-record-release'
    const since = recordEvents.length
    const running = runRecordTurn(dshSessionId, 'DISPATCHSLOW please')
    await waitForRecordHold(dshSessionId)
    const seam = recordManager as unknown as { bridges: Map<string, { releaseAll(reason: string, cause: string): void }> }
    for (const bridge of seam.bridges.values()) bridge.releaseAll('test teardown', 'idle')
    await Promise.race([
      running,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('the holding step never closed')), 5_000)),
    ])

    const frames = recordFrames(since)
    expect(frames.at(-1)?.status).toBe('unknown')
    expect(frames.at(-1)?.endedAt).toBeDefined()
    expect(unexpectedSubagentFrames(recordEvents, since)).toEqual([])
    // Reconnect seed: the conversation is parked (released) and the terminal
    // record still rides its `session/chat-list` row.
    const rows = recordManager.chatSessions(dshSessionId)
    expect(rows[0]?.released).toBe(true)
    expect(rows[0]?.subagents?.map(row => row.status)).toEqual(['unknown'])
    // Released sessions keep serving their transcript to the detail read.
    expect(recordManager.subagentsDetail(dshSessionId, 'acp:agent_dispatch').entries.length).toBeGreaterThan(0)
  }, 30_000)

  it('leaves unknown on an explicit close, and the closed conversation\'s records are pruned', async () => {
    const dshSessionId = 'dsh-dispatch-record-close'
    const since = recordEvents.length
    const running = runRecordTurn(dshSessionId, 'DISPATCHSLOW please')
    await waitForRecordHold(dshSessionId)
    const acpSessionId = recordManager.chatSessions(dshSessionId)[0]?.sessionId
    expect(acpSessionId).toBeDefined()
    await Promise.all([
      recordManager.closeSession(acpSessionId!),
      Promise.race([
        running,
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('the holding step never closed')), 5_000)),
      ]),
    ])

    const frames = recordFrames(since)
    expect(frames.at(-1)?.status).toBe('unknown')
    expect(unexpectedSubagentFrames(recordEvents, since)).toEqual([])
    // The conversation is destroyed: its records go with it (the next write
    // must not keep the key).
    expect(recordManager.subagentsFor(dshSessionId)).toEqual([])
    expect(persistedRecords()?.[dshSessionId]).toBeUndefined()
  }, 30_000)

  it('leaves unknown on a forced reset and on a turn force-finalized with an error', async () => {
    const dshSessionId = 'dsh-dispatch-record-force'
    const since = recordEvents.length
    const running = runRecordTurn(dshSessionId, 'DISPATCHSLOW please')
    await waitForRecordHold(dshSessionId)
    const live = recordManager.turnStreamFor(dshSessionId)
    expect(live).toBeDefined()
    // The watchdog's forced ending: an ERROR close is not proof the worker ended.
    live!.forceFinalize({ kind: 'error', message: 'watchdog fired', code: 'INACTIVITY_TIMEOUT' })
    await Promise.race([
      running,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('the holding step never closed')), 5_000)),
    ])
    expect(recordFrames(since).at(-1)?.status).toBe('unknown')
    expect(unexpectedSubagentFrames(recordEvents, since)).toEqual([])

    // A forced RESET tears the session down without `closeTurn`; the record is
    // still terminalized before the controller is detached.
    const resetSessionId = 'dsh-dispatch-record-reset'
    const resetSince = recordEvents.length
    const resetRunning = runRecordTurn(resetSessionId, 'DISPATCHSLOW please')
    await waitForRecordHold(resetSessionId)
    const seam = recordManager as unknown as { bridges: Map<string, { forceReset(reason: string): void }> }
    for (const bridge of seam.bridges.values()) bridge.forceReset('agent-stopped')
    await Promise.race([
      resetRunning,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('the reset turn never closed')), 5_000)),
    ])
    expect(recordFrames(resetSince).at(-1)?.status).toBe('unknown')
    expect(unexpectedSubagentFrames(recordEvents, resetSince)).toEqual([])
  }, 30_000)

  it('closes a worker that never reports as unknown, not running', async () => {
    const dshSessionId = 'dsh-dispatch-record-nodrain'
    const since = recordEvents.length
    const { chunks } = await runRecordTurn(dshSessionId, 'DISPATCHNODRAIN please')
    // The worker-phase ceiling closed the turn with the deferral report.
    expect(recordText(chunks)).toContain('deferred this turn to a background task run')
    expect(recordFrames(since).map(frame => frame.status)).toEqual(['running', 'unknown'])
    expect(unexpectedSubagentFrames(recordEvents, since)).toEqual([])
  }, 30_000)

  it('prunes orphan record keys at load and keeps owned ones', async () => {
    const pruneStorage = `${tmpdir()}/dsh-ntr-subagent-prune-${String(process.pid)}-${String(Date.now())}.json`
    const row = (childId: string, overrides: Partial<SubagentRecord> = {}): SubagentRecord => ({
      childId,
      dshSessionId: 'chat-keep',
      toolCallId: childId.slice('acp:'.length),
      label: 'worker',
      status: 'running',
      startedAt: 10,
      lastActivityAt: 20,
      counts: { updates: 1, toolCalls: 0, textChars: 0 },
      ...overrides,
    })
    writeFileSync(pruneStorage, JSON.stringify({
      version: 2,
      agents: [{ ...def, id: 'record', cwd: recordWorkspace, allowedCwdRoots: [recordWorkspace] }],
      conversations: {
        'chat-keep': { agentId: 'record' },
        'chat-intent': { agentId: 'record' },
      },
      chatSessions: [{
        sessionId: 'S1',
        acpSessionId: 'A1',
        agentId: 'record',
        dshSessionId: 'chat-keep',
        cwd: recordWorkspace,
      }],
      subagents: {
        'chat-keep': [row('acp:keep')],
        'chat-intent': [row('acp:intent', { dshSessionId: 'chat-intent' })],
        'chat-orphan': [row('acp:orphan', { dshSessionId: 'chat-orphan' })],
      },
    }), 'utf-8')
    const pruneHub = new EventHub()
    const pruneManager = new BridgeManager([], pruneHub, 100, pruneStorage)
    try {
      // A restored row that never reached a terminal state reads unknown: the
      // process that owned it died with the host restart.
      expect(pruneManager.subagentsFor('chat-keep').map(record => record.status)).toEqual(['unknown'])
      expect(pruneManager.subagentsFor('chat-intent')).toHaveLength(1)
      expect(pruneManager.subagentsFor('chat-orphan')).toEqual([])
      // The next write carries only the surviving keys.
      await pruneManager.setTagHalo({ mode: 'steady', speed: 'slow' })
      const onDisk = JSON.parse(readFileSync(pruneStorage, 'utf-8')) as { subagents?: Record<string, unknown> }
      expect(Object.keys(onDisk.subagents ?? {}).sort()).toEqual(['chat-intent', 'chat-keep'])
    } finally {
      await pruneManager.shutdownAll()
      rmSync(pruneStorage, { force: true })
    }
  }, 30_000)
})
