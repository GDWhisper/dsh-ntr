/**
 * Antigravity subagent DETAIL reads (task 3 of
 * docs/plan/antigravity-subagent-panel.md): `subagents/detail` for a record
 * with a `childConversationId` reads the child's OWN brain transcript as a
 * bounded, marked step stream — never the parent's dispatch frames. The unit
 * half drives `SubagentService` against real temp transcript files (no
 * subprocess, deterministic); the integration half proves the manager wiring
 * (store-root seam + record round trip) with the scripted mock.
 *
 * Contract pinned here:
 * - every step type keeps a destination (constraint 29), unknown types ride
 *   verbatim; `tool_calls` / `error` / `thinking` survive the read;
 * - the per-worker entry cap keeps the NEWEST steps and counts `omitted`;
 * - an oversized step is a MARKED cut (`truncatedChars`), never a drop;
 * - missing file / no store root / no session → an explicit `unreadable`
 *   notice; bad lines → readable part + a `bad-lines` notice; a file larger
 *   than the read window → a `window-cut` notice; nothing throws;
 * - notices display AFTER steps (seq orders display); the host appends them
 *   last and the browser's positional front-trim is what keeps them alive;
 * - a record WITHOUT `childConversationId` falls back to the unchanged
 *   CodeBuddy parent-transcript filter (no `source` marker).
 */
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { afterAll, describe, expect, it } from 'vitest'
import { AcpLlmAdapter, BridgeManager } from '../../src/bridge.ts'
import { SubagentService } from '../../src/bridge/subagent-service.ts'
import type { LiveSession } from '../../src/bridge/live-session.ts'
import type { BridgeTuning } from '../../src/bridge/types.ts'
import { AGY_DETAIL_READ_MAX_BYTES } from '../../src/bridge/agy-subagent-detail.ts'
import { EventHub, Transcript } from '../../src/impl.ts'
import { ACP_TOOL_RAW_MAX } from '../../src/subagent-records.ts'
import { MAX_SUBAGENT_DETAIL_ENTRIES, type SubagentDetailEntry, type SubagentRecord } from '../../src/protocol.ts'
import { def, hostLoopTurn, until } from './harness.ts'

/** One lifecycle record; agy rows carry the brain conversationId. */
function record(patch: Partial<SubagentRecord> = {}): SubagentRecord {
  return {
    childId: 'acp:d1',
    dshSessionId: 'chat-1',
    toolCallId: 'd1',
    label: 'License Migrator',
    status: 'completed',
    startedAt: 10,
    lastActivityAt: 20,
    endedAt: 30,
    counts: { updates: 1, toolCalls: 0, textChars: 0 },
    ...patch,
  }
}

/** A minimal live session; the detail read only needs identity + transcript. */
function session(patch: Partial<LiveSession> = {}): LiveSession {
  return {
    sessionId: 'S1',
    agentId: 'agy',
    acpSessionId: 'A1',
    cwd: tmpdir(),
    lifecycle: 'live',
    running: false,
    activeToolCalls: new Set<string>(),
    transcript: new Transcript(500),
    dshSessionId: 'chat-1',
    ...patch,
  } as unknown as LiveSession
}

/** A service whose agy store root resolves to the given directory (or none). */
function serviceWith(options: { storeRoot?: string; sessions?: LiveSession[] } = {}): SubagentService {
  const sessions = options.sessions ?? [session()]
  return new SubagentService({
    hub: new EventHub(),
    sessions: () => sessions,
    persistAgents: () => {},
    ambientTuning: () => ({ quietMs: 1_000, maxMs: 5_000 }),
  }, options.storeRoot === undefined ? undefined : {
    storeRoot: () => options.storeRoot,
    tuning: () => ({ agyLateOutputPollMs: 1_000 }) as unknown as Required<BridgeTuning>,
    silenceWindows: () => ({ silenceMs: 1_000, openToolCeilingMs: 5_000 }),
  })
}

/** Write a child brain transcript; returns the store root. */
function childStore(lines: readonly string[], childId = 'child-1'): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-ntr-agy-detail-'))
  const dir = join(root, 'brain', childId, '.system_generated', 'logs')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'transcript.jsonl'), lines.map(line => `${line}\n`).join(''))
  return root
}

/** One transcript step line in agy's measured shape. */
function stepLine(stepIndex: number, type: string, status: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    step_index: stepIndex,
    source: 'MODEL',
    type,
    status,
    created_at: '2026-01-01T00:00:00Z',
    content: '',
    ...extra,
  })
}

const cleanups: Array<() => void> = []
afterAll(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})

function store(lines: readonly string[], childId = 'child-1'): string {
  const root = childStore(lines, childId)
  cleanups.push(() => { rmSync(root, { recursive: true, force: true }) })
  return root
}

function notices(entries: readonly SubagentDetailEntry[]): Array<Record<string, unknown>> {
  return entries
    .map(entry => entry.update as Record<string, unknown>)
    .filter(update => typeof update.notice === 'string')
}

describe('agy subagent detail: the child brain transcript read', () => {
  it('reads every step type verbatim, marked as the agy transcript source', () => {
    const root = store([
      stepLine(0, 'USER_INPUT', 'DONE', { source: 'SYSTEM', content: 'migrate the license headers' }),
      stepLine(1, 'PLANNER_RESPONSE', 'DONE', { content: 'working on it', thinking: 'check the headers first' }),
      stepLine(2, 'GENERIC', 'RUNNING', { tool_calls: [{ name: 'run_command', args: { CommandLine: 'ls -la' } }] }),
      stepLine(3, 'SYSTEM_MESSAGE', 'DONE', { source: 'SYSTEM', content: '[Message] sender=child-1 content=done' }),
      stepLine(4, 'GENERIC', 'ERROR', { error: 'command exited 1', tool_calls: [{ name: 'run_command', args: {} }] }),
      stepLine(5, 'FUTURE_KIND', 'DONE', { content: 'a type this build does not know', mystery: { a: 1 } }),
    ])
    const service = serviceWith({ storeRoot: root })
    service.noteSubagentRecords([record({ childConversationId: 'child-1' })], { announce: false, persist: false })
    const detail = service.subagentsDetail('chat-1', 'acp:d1')
    expect(detail.omitted).toBeUndefined()
    expect(detail.entries).toHaveLength(6)
    for (const entry of detail.entries) expect(entry.source).toBe('agy-transcript')
    expect(detail.entries.map(entry => entry.seq)).toEqual([0, 1, 2, 3, 4, 5])
    const updates = detail.entries.map(entry => entry.update as Record<string, unknown>)
    // The wire shape survives: tool calls with name + args, thinking, error,
    // and the unknown type's own keys (constraint 29 — nothing folded away).
    expect(updates[0]).toMatchObject({ type: 'USER_INPUT', content: 'migrate the license headers', source: 'SYSTEM' })
    expect(updates[1]).toMatchObject({ thinking: 'check the headers first' })
    expect(updates[2]).toMatchObject({ tool_calls: [{ name: 'run_command', args: { CommandLine: 'ls -la' } }] })
    expect(updates[4]).toMatchObject({ error: 'command exited 1' })
    expect(updates[5]).toMatchObject({ type: 'FUTURE_KIND', mystery: { a: 1 } })
  })

  it('keeps the newest steps at the per-worker cap and counts the omitted older ones', () => {
    const total = MAX_SUBAGENT_DETAIL_ENTRIES + 5
    const lines = Array.from({ length: total }, (_, index) => stepLine(index, 'GENERIC', 'DONE', { content: `s${String(index)}` }))
    const service = serviceWith({ storeRoot: store(lines) })
    service.noteSubagentRecords([record({ childConversationId: 'child-1' })], { announce: false, persist: false })
    const detail = service.subagentsDetail('chat-1', 'acp:d1')
    expect(detail.entries).toHaveLength(MAX_SUBAGENT_DETAIL_ENTRIES)
    expect(detail.omitted).toBe(5)
    expect(detail.entries[0]?.seq).toBe(5)
    expect(detail.entries.at(-1)?.seq).toBe(total - 1)
  })

  it('cuts an oversized step with a marker instead of dropping or sending it whole', () => {
    const huge = 'x'.repeat(ACP_TOOL_RAW_MAX + 100)
    const service = serviceWith({ storeRoot: store([stepLine(0, 'PLANNER_RESPONSE', 'DONE', { content: huge })]) })
    service.noteSubagentRecords([record({ childConversationId: 'child-1' })], { announce: false, persist: false })
    const detail = service.subagentsDetail('chat-1', 'acp:d1')
    expect(detail.entries).toHaveLength(1)
    const entry = detail.entries[0]!
    expect(entry.source).toBe('agy-transcript')
    expect(entry.truncatedChars).toBeGreaterThan(0)
    const update = entry.update as Record<string, unknown>
    expect(update.truncated).toBe(true)
    expect(String(update.text)).toContain('[truncated')
    expect(String(update.text).length).toBeLessThan(huge.length)
  })

  it('says the transcript is unreadable when the file is missing — never throws', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-ntr-agy-detail-empty-'))
    cleanups.push(() => { rmSync(root, { recursive: true, force: true }) })
    const service = serviceWith({ storeRoot: root })
    service.noteSubagentRecords([record({ childConversationId: 'child-1' })], { announce: false, persist: false })
    const detail = service.subagentsDetail('chat-1', 'acp:d1')
    expect(detail.entries).toHaveLength(1)
    expect(detail.entries[0]?.source).toBe('agy-transcript')
    expect(notices(detail.entries)).toEqual([{ notice: 'unreadable' }])
  })

  it('keeps the readable steps and marks the bad lines with their count', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-ntr-agy-detail-bad-'))
    cleanups.push(() => { rmSync(root, { recursive: true, force: true }) })
    const dir = join(root, 'brain', 'child-1', '.system_generated', 'logs')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'transcript.jsonl'), [
      stepLine(0, 'USER_INPUT', 'DONE', { content: 'prompt' }),
      'this is not json',
      '{"no_step_index": true}',
      '',
      stepLine(1, 'PLANNER_RESPONSE', 'DONE', { content: 'answer' }),
    ].join('\n') + '\n')
    const service = serviceWith({ storeRoot: root })
    service.noteSubagentRecords([record({ childConversationId: 'child-1' })], { announce: false, persist: false })
    const detail = service.subagentsDetail('chat-1', 'acp:d1')
    const steps = detail.entries.filter(entry => (entry.update as Record<string, unknown>).notice === undefined)
    expect(steps.map(entry => entry.seq)).toEqual([0, 1])
    expect(notices(detail.entries)).toEqual([{ notice: 'bad-lines', lines: 2 }])
    // Notices display AFTER every step (seq orders display). Their survival
    // under the browser cap comes from the host appending them LAST and the
    // store merge trimming positionally from the front — not from the seq.
    const noticeSeq = detail.entries.find(entry => (entry.update as Record<string, unknown>).notice !== undefined)?.seq ?? 0
    expect(noticeSeq).toBeGreaterThan(1)
  })

  it('does not count a trailing half-written line as a bad line', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-ntr-agy-detail-partial-'))
    cleanups.push(() => { rmSync(root, { recursive: true, force: true }) })
    const dir = join(root, 'brain', 'child-1', '.system_generated', 'logs')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'transcript.jsonl'), `${stepLine(0, 'USER_INPUT', 'DONE', { content: 'prompt' })}\n{"step_index": 1, "ty`)
    const service = serviceWith({ storeRoot: root })
    service.noteSubagentRecords([record({ childConversationId: 'child-1' })], { announce: false, persist: false })
    const detail = service.subagentsDetail('chat-1', 'acp:d1')
    expect(detail.entries).toHaveLength(1)
    expect(detail.entries[0]?.seq).toBe(0)
    expect(notices(detail.entries)).toEqual([])
  })

  it('keeps a complete final step the writer never newline-terminated', () => {
    // A ONE-SHOT read of a finished child: the last line may be the final
    // PLANNER_RESPONSE without its trailing newline — the report the user
    // opened the dialog for. Dropping it silently is constraint-29 loss.
    const root = mkdtempSync(join(tmpdir(), 'dsh-ntr-agy-detail-nonl-'))
    cleanups.push(() => { rmSync(root, { recursive: true, force: true }) })
    const dir = join(root, 'brain', 'child-1', '.system_generated', 'logs')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'transcript.jsonl'), [
      stepLine(0, 'USER_INPUT', 'DONE', { content: 'prompt' }),
      stepLine(1, 'PLANNER_RESPONSE', 'DONE', { content: 'the final report' }),
    ].join('\n'))
    const service = serviceWith({ storeRoot: root })
    service.noteSubagentRecords([record({ childConversationId: 'child-1' })], { announce: false, persist: false })
    const detail = service.subagentsDetail('chat-1', 'acp:d1')
    expect(detail.entries.map(entry => entry.seq)).toEqual([0, 1])
    expect((detail.entries[1]?.update as Record<string, unknown>).content).toBe('the final report')
    expect(notices(detail.entries)).toEqual([])
  })

  it('keeps looking when the first servable session cannot name a store root', () => {
    // The agent-switch edge: two live sessions share the conversation, the
    // first one's agent resolves no root. A resolved root further down the
    // list must still serve the detail — not a false `unreadable`.
    const root = store([stepLine(0, 'USER_INPUT', 'DONE', { content: 'prompt' })])
    const sessions = [session({ sessionId: 'S0', agentId: 'other' }), session()]
    const service = new SubagentService({
      hub: new EventHub(),
      sessions: () => sessions,
      persistAgents: () => {},
      ambientTuning: () => ({ quietMs: 1_000, maxMs: 5_000 }),
    }, {
      storeRoot: candidate => (candidate.agentId === 'agy' ? root : undefined),
      tuning: () => ({ agyLateOutputPollMs: 1_000 }) as unknown as Required<BridgeTuning>,
      silenceWindows: () => ({ silenceMs: 1_000, openToolCeilingMs: 5_000 }),
    })
    service.noteSubagentRecords([record({ childConversationId: 'child-1' })], { announce: false, persist: false })
    const detail = service.subagentsDetail('chat-1', 'acp:d1')
    expect(detail.entries).toHaveLength(1)
    expect(detail.entries[0]?.source).toBe('agy-transcript')
    expect(notices(detail.entries)).toEqual([])
  })

  it('marks the read window when the file is larger than the byte budget', () => {
    // One oversized first line pushes the file past the window; the newest
    // steps stay readable and the cut is stated, never silent.
    const big = stepLine(0, 'GENERIC', 'DONE', { content: 'y'.repeat(AGY_DETAIL_READ_MAX_BYTES + 1024) })
    const root = store([big, stepLine(1, 'PLANNER_RESPONSE', 'DONE', { content: 'newest answer' })])
    const service = serviceWith({ storeRoot: root })
    service.noteSubagentRecords([record({ childConversationId: 'child-1' })], { announce: false, persist: false })
    const detail = service.subagentsDetail('chat-1', 'acp:d1')
    expect(notices(detail.entries)).toEqual([{ notice: 'window-cut' }])
    const steps = detail.entries.filter(entry => (entry.update as Record<string, unknown>).notice === undefined)
    expect(steps).toHaveLength(1)
    expect(steps[0]?.seq).toBe(1)
  })

  it('an empty transcript reads as no steps, not an error', () => {
    const service = serviceWith({ storeRoot: store([]) })
    service.noteSubagentRecords([record({ childConversationId: 'child-1' })], { announce: false, persist: false })
    expect(service.subagentsDetail('chat-1', 'acp:d1')).toEqual({ entries: [] })
  })

  it('no store root or no servable session is an explicit unreadable, not a throw', () => {
    // Wiring absent (an older composition): the record still names a child.
    const noWiring = serviceWith({})
    noWiring.noteSubagentRecords([record({ childConversationId: 'child-1' })], { announce: false, persist: false })
    expect(notices(noWiring.subagentsDetail('chat-1', 'acp:d1').entries)).toEqual([{ notice: 'unreadable' }])
    // The session is closed: nothing can resolve its agent's store root.
    const closed = serviceWith({ storeRoot: store([]), sessions: [session({ lifecycle: 'closed' })] })
    closed.noteSubagentRecords([record({ childConversationId: 'child-1' })], { announce: false, persist: false })
    expect(notices(closed.subagentsDetail('chat-1', 'acp:d1').entries)).toEqual([{ notice: 'unreadable' }])
  })

  it('released sessions keep serving the child detail (readable after a host restart)', () => {
    const root = store([stepLine(0, 'USER_INPUT', 'DONE', { content: 'prompt' })])
    const service = serviceWith({ storeRoot: root, sessions: [session({ lifecycle: 'parked' })] })
    service.noteSubagentRecords([record({ childConversationId: 'child-1', status: 'unknown' })], { announce: false, persist: false })
    const detail = service.subagentsDetail('chat-1', 'acp:d1')
    expect(detail.entries).toHaveLength(1)
    expect(detail.entries[0]?.source).toBe('agy-transcript')
  })

  it('a record without childConversationId falls back to the unchanged parent filter', () => {
    const live = session()
    live.transcript.append({ sessionUpdate: 'tool_call', toolCallId: 'd1', title: 'Task', rawInput: { prompt: 'scan' } })
    live.transcript.append({
      sessionUpdate: 'agent_message_chunk',
      _meta: { 'codebuddy.ai/parentToolCallId': 'd1' },
      content: { type: 'text', text: 'worker prose' },
    })
    live.transcript.append({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'parent prose' } })
    const service = serviceWith({ storeRoot: store([]), sessions: [live] })
    service.noteSubagentRecords([record()], { announce: false, persist: false })
    const detail = service.subagentsDetail('chat-1', 'acp:d1')
    // Both CodeBuddy filters hit; the parent's own prose does not; NO marker.
    expect(detail.entries).toHaveLength(2)
    for (const entry of detail.entries) expect(entry.source).toBeUndefined()
    const updates = detail.entries.map(entry => entry.update as Record<string, unknown>)
    expect(updates.some(update => update.rawInput !== undefined)).toBe(true)
    expect(updates.some(update => JSON.stringify(update).includes('worker prose'))).toBe(true)
  })

  it('an unknown child id is still empty, not an internal error', () => {
    const service = serviceWith({ storeRoot: store([]) })
    expect(service.subagentsDetail('chat-1', 'acp:missing')).toEqual({ entries: [] })
    expect(service.subagentsDetail('chat-1', 'not-external')).toEqual({ entries: [] })
  })
})

describe('agy subagent detail: manager wiring (real mock child)', () => {
  it('serves the child transcript steps through subagents/detail after the dispatch completes', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'dsh-ntr-agy-detail-wire-'))
    const storeRoot = join(workspace, 'store')
    const storage = join(workspace, 'agents.json')
    const hub = new EventHub()
    const manager = new BridgeManager(
      [{ ...def, id: 'agy-detail', cwd: workspace, allowedCwdRoots: [workspace], env: { MOCK_AGY_STORE: storeRoot } }],
      hub,
      500,
      storage,
      undefined,
      false,
      { startupTimeoutMs: 3_000, idleTimeoutMs: 60_000, cancelFallbackMs: 100, turnStallMs: 0, agyLateOutputPollMs: 100 },
      { isAgent: () => true, storeRoot: () => storeRoot },
    )
    const adapter = new AcpLlmAdapter(manager)
    try {
      const dshSessionId = 'dsh-agy-detail-wire'
      await hostLoopTurn(adapter, {
        provider: 'acp',
        model: 'agy-detail',
        sessionId: dshSessionId,
        messages: [{ role: 'user', content: [{ type: 'text', text: 'AGY_DISPATCHREPORT please' }] }],
      })
      await until(() => manager.subagentsFor(dshSessionId).some(row => row.status === 'completed'))
      const childConversationId = manager.subagentsFor(dshSessionId)[0]?.childConversationId
      expect(childConversationId).toMatch(/^agy-child-/)
      const detail = manager.subagentsDetail(dshSessionId, 'acp:agy_dispatch_1')
      expect(detail.entries.length).toBeGreaterThanOrEqual(3)
      for (const entry of detail.entries) expect(entry.source).toBe('agy-transcript')
      const updates = detail.entries.map(entry => entry.update as Record<string, unknown>)
      expect(updates.some(update => update.type === 'USER_INPUT' && update.content === 'migrate the license headers')).toBe(true)
      expect(updates.some(update => update.type === 'GENERIC'
        && JSON.stringify(update.tool_calls).includes('run_command'))).toBe(true)
      expect(updates.some(update => update.type === 'PLANNER_RESPONSE' && update.status === 'DONE')).toBe(true)
      // The parent's dispatch frames are NOT the detail source anymore.
      expect(updates.some(update => update.sessionUpdate === 'tool_call')).toBe(false)
    } finally {
      await manager.shutdownAll()
      rmSync(workspace, { recursive: true, force: true })
    }
  }, 30_000)
})
