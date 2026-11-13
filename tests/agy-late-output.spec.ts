/**
 * Integration coverage for the Antigravity transcript watcher, moved verbatim
 * out of bridge.spec.ts so each file stays inside the line ratchet. The
 * manager watches a real mock child: the only way a late answer reaches the
 * chat is the transcript file, and the next prompt's replay of the same text
 * is the only trace the adapter sees.
 */
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { afterAll, describe, expect, it, vi } from 'vitest'
import {
  AcpLlmAdapter, AgyLateOutputService, BACKGROUND_REPORT_FORM, BACKGROUND_REPORT_SOURCE, BridgeManager,
  type BridgeTuning,
} from '../src/bridge.ts'
import { DEFAULT_TUNING } from '../src/bridge/tuning.ts'
import { EventHub, dispatchRpc } from '../src/impl.ts'
import type { AcpAgentDef, AcpEvent, GenerateMessage, StreamChunk } from '../src/protocol.ts'

const MOCK = fileURLToPath(new URL('./mock-agent.mjs', import.meta.url))

const def: AcpAgentDef = {
  id: 'mock',
  title: 'Mock',
  command: process.execPath,
  args: [MOCK],
  env: {},
  cwd: tmpdir(),
  allowedCwdRoots: [tmpdir()],
}

/** Poll a condition with a deadline: process death has no event we can await. */
async function until(condition: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('condition never became true')
    await new Promise(resolve => setTimeout(resolve, 50))
  }
}

/**
 * Drive the adapter the way the host agent-loop does (docs/acp-convergence.md
 * §1.5/§1.7): stream one step; while its chunks carried tool-call blocks and
 * it finished with stop, stage those calls' results as tool-sourced messages
 * and stream the CONTINUATION. Copied from bridge.spec.ts with the cases.
 */
async function hostLoopTurn(
  adapter: AcpLlmAdapter,
  request: Parameters<typeof adapter.stream>[0],
  maxSteps = 8,
  signal?: AbortSignal,
  /** Simulated card-execution gap before each continuation step opens. */
  stepDelayMs = 0,
): Promise<{ chunks: StreamChunk[]; steps: StreamChunk[][] }> {
  const steps: StreamChunk[][] = []
  let messages = request.messages ?? []
  for (let step = 0; step < maxSteps; step += 1) {
    if (step > 0 && stepDelayMs > 0) await new Promise(resolve => setTimeout(resolve, stepDelayMs))
    const chunks: StreamChunk[] = []
    for await (const chunk of adapter.stream({
      ...request,
      messages,
      ...(signal === undefined ? {} : { signal }),
    })) chunks.push(chunk)
    steps.push(chunks)
    const finish = chunks.find((c): c is Extract<StreamChunk, { type: 'finish' }> => c.type === 'finish')
    const callIds = [...new Set(chunks.filter(c => c.type === 'tool-call-delta').map(c => (c as { id: string }).id))]
    if (finish === undefined || finish.reason.kind !== 'stop' || callIds.length === 0) break
    messages = [...messages, ...callIds.map(id => ({
      role: 'tool' as const,
      source: { kind: 'tool' as const, callId: id },
      content: [{ type: 'text' as const, text: 'staged result' }],
    }))]
  }
  return { chunks: steps.flat(), steps }
}

/**
 * Antigravity transcript late output (docs/plan/antigravity-late-output.md):
 * `agy acp` finishes work AFTER `end_turn` without sending any
 * `session/update`. The mock writes the answer only into its own transcript, so
 * the manager's file watch is the only way the chat can hear it, and the next
 * prompt's replay of the same text is the only trace the adapter sees.
 */
describe('AGY-LATE: Antigravity transcript late output', () => {
  function textOf(chunks: readonly StreamChunk[]): string {
    return chunks
      .filter((chunk): chunk is Extract<StreamChunk, { type: 'text-delta' }> => chunk.type === 'text-delta')
      .map(chunk => chunk.text)
      .join('')
  }

  function userText(text: string): GenerateMessage {
    return { role: 'user', content: [{ type: 'text', text }] }
  }

  interface LateHarness {
    manager: BridgeManager
    events: AcpEvent[]
    adapter: AcpLlmAdapter
    store: string
    prompts: string
    workspace: string
  }

  /**
   * A manager whose only agent is the mock, with the Antigravity seam forced on:
   * `isAgent: () => true` plus a fixed transcript store. `MOCK_AGY_STORE` is
   * passed through the agent definition, not the host environment.
   */
  function lateHarness(options: { writeTranscript?: boolean; tuning?: BridgeTuning } = {}): LateHarness {
    const workspace = mkdtempSync(join(tmpdir(), 'dsh-ntr-agy-late-'))
    const store = join(workspace, 'store')
    const prompts = join(workspace, 'prompts.log')
    const hub = new EventHub()
    const events: AcpEvent[] = []
    hub.subscribe(event => { events.push(event) })
    const agent: AcpAgentDef = {
      ...def,
      id: 'agy-late',
      cwd: workspace,
      allowedCwdRoots: [workspace],
      env: {
        ...(options.writeTranscript === false ? {} : { MOCK_AGY_STORE: store }),
        MOCK_PROMPT_LOG: prompts,
      },
    }
    const manager = new BridgeManager(
      [agent],
      hub,
      500,
      undefined,
      undefined,
      false,
      {
        startupTimeoutMs: 3_000,
        idleTimeoutMs: 60_000,
        agyLateOutputPollMs: 25,
        agyLateOutputQuietMs: 40,
        agyLateOutputMaxMs: 5_000,
        agyLateOutputEchoMs: 60_000,
        ...options.tuning,
      },
      { isAgent: () => true, storeRoot: () => store },
    )
    return { manager, events, adapter: new AcpLlmAdapter(manager), store, prompts, workspace }
  }

  const cleanups: Array<() => Promise<void>> = []
  afterAll(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup()
  })

  function harnessWithResolver(dshSessionId: string, wakes: GenerateMessage[]): { harness: LateHarness; cleanup: () => Promise<void> } {
    const harness = lateHarness()
    harness.manager.setDshAgentResolver(id => id === dshSessionId
      ? { session: { id: dshSessionId }, followup: message => { wakes.push(message as GenerateMessage) } }
      : undefined)
    const cleanup = async (): Promise<void> => {
      await harness.manager.shutdownAll()
      rmSync(harness.workspace, { recursive: true, force: true })
    }
    cleanups.push(cleanup)
    return { harness, cleanup }
  }

  function promptCount(path: string): number {
    if (!existsSync(path)) return 0
    const text = readFileSync(path, 'utf8')
    return text === '' ? 0 : text.trimEnd().split('\n').length
  }

  async function firstLateTurn(harness: LateHarness, dshSessionId: string, text = 'AGY_LATE please'): Promise<string> {
    const { chunks } = await hostLoopTurn(harness.adapter, {
      provider: 'acp',
      model: 'agy-late',
      sessionId: dshSessionId,
      messages: [userText(text)],
    })
    return textOf(chunks)
  }

  /** The host step that answers the injected wake: it replays the report locally. */
  async function wakeStep(harness: LateHarness, dshSessionId: string, messages: GenerateMessage[]): Promise<string> {
    const chunks: StreamChunk[] = []
    for await (const chunk of harness.adapter.stream({ provider: 'acp', model: 'agy-late', sessionId: dshSessionId, messages })) {
      chunks.push(chunk)
    }
    return textOf(chunks)
  }

  it('delivers a post-turn answer once, without sending a second prompt', async () => {
    const dshSessionId = 'dsh-agy-late-deliver'
    const wakes: GenerateMessage[] = []
    const { harness } = harnessWithResolver(dshSessionId, wakes)
    const first = await firstLateTurn(harness, dshSessionId)
    expect(first).toContain('MOCK: echo AGY_LATE please')

    await until(() => wakes.length === 1, 10_000)
    const wake = wakes[0]
    expect(wake?.role).toBe('user')
    expect(wake?.source?.kind).toBe(BACKGROUND_REPORT_SOURCE)
    expect(wake?.source?.form).toBe(BACKGROUND_REPORT_FORM)
    expect(String(wake?.source?.report)).toContain('AGY-LATE-ANSWER AGY_LATE please')
    // The watch delivered; the agent itself saw exactly ONE prompt.
    expect(promptCount(harness.prompts)).toBe(1)
  }, 30_000)

  it('keeps the agent echo of the user prompt out of the answer mirror', async () => {
    const dshSessionId = 'dsh-agy-echo'
    const wakes: GenerateMessage[] = []
    const { harness } = harnessWithResolver(dshSessionId, wakes)
    const { chunks } = await hostLoopTurn(harness.adapter, {
      provider: 'acp',
      model: 'agy-late',
      sessionId: dshSessionId,
      messages: [userText('AGY_ECHO please')],
    })
    const answered = textOf(chunks)
    expect(answered).toContain('MOCK: echo AGY_ECHO please')
    // agy echoes the user's own prompt at the start of the turn. The host
    // already renders that message, so the answer mirror must not repeat its
    // raw JSON (field: session-af26f3a8, 2026-11-13).
    expect(answered).not.toContain('user_message_chunk')
    expect(answered).not.toContain('"sessionUpdate"')
  }, 30_000)

  it('delivers the answer a subagent report produced, never the poll chatter', async () => {
    const dshSessionId = 'dsh-agy-report-gate'
    const wakes: GenerateMessage[] = []
    const { harness } = harnessWithResolver(dshSessionId, wakes)
    await firstLateTurn(harness, dshSessionId, 'AGY_REPORT please')
    await until(() => wakes.length >= 1, 10_000)
    // The polling loop's own status line landed 550 ms earlier; give it room
    // to (wrongly) deliver as well before asserting the one-report shape.
    await new Promise(resolve => setTimeout(resolve, 600))
    expect(wakes).toHaveLength(1)
    const report = String(wakes[0]?.source?.report)
    expect(report).toContain('AGY-REPORT-ANSWER')
    expect(report).not.toContain('I am waiting')
  }, 30_000)

  it('keeps watching after a wake turn, so a later answer still arrives', async () => {
    const dshSessionId = 'dsh-agy-rearm'
    const wakes: GenerateMessage[] = []
    const { harness } = harnessWithResolver(dshSessionId, wakes)
    await firstLateTurn(harness, dshSessionId)
    await until(() => wakes.length === 1, 10_000)
    const first = wakes[0]
    if (first === undefined) return
    // The host answers the wake in a turn that has NO ACP controller, so the
    // only re-arm point is the manager's wake branch.
    await wakeStep(harness, dshSessionId, [userText('AGY_LATE please'), first])
    const brainRoot = join(harness.store, 'brain')
    const [acpSessionId] = readdirSync(brainRoot)
    expect(acpSessionId).toBeDefined()
    if (acpSessionId === undefined) return
    await new Promise(resolve => setTimeout(resolve, 100))
    const transcript = join(brainRoot, acpSessionId, '.system_generated', 'logs', 'transcript_full.jsonl')
    appendFileSync(transcript, `${JSON.stringify({
      step_index: 99,
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      created_at: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
      content: 'AGY-SECOND-ANSWER without a new prompt',
    })}\n`)
    await until(() => wakes.length === 2, 10_000)
    expect(String(wakes[1]?.source?.report)).toContain('AGY-SECOND-ANSWER')
  }, 30_000)

  it('skips poll chatter across interleaved synchronous tools and delivers the answer after a task completion message', async () => {
    vi.useFakeTimers()
    try {
      const closedAt = new Date('2026-11-13T04:32:38.000Z')
      vi.setSystemTime(closedAt)
      const workspace = mkdtempSync(join(tmpdir(), 'dsh-ntr-agy-interleaved-'))
      const logs = join(workspace, 'brain', 'acp-session-1', '.system_generated', 'logs')
      mkdirSync(logs, { recursive: true })
      const transcript = join(logs, 'transcript_full.jsonl')
      writeFileSync(transcript, `${JSON.stringify({
        step_index: 1, type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-11-13T04:32:32Z', content: 'turn answer',
      })}\n`)
      const delivered: string[] = []
      const service = new AgyLateOutputService({
        isAgent: () => true,
        storeRoot: () => workspace,
        tuning: () => ({
          ...DEFAULT_TUNING,
          agyLateOutputPollMs: 1_000,
          agyLateOutputQuietMs: 1_500,
          agyLateOutputMaxMs: 0,
        }),
        host: {
          defOf: () => def,
          isBusy: () => false,
          deliver: (_session, text) => { delivered.push(text); return true },
        },
      })
      const session = {
        sessionId: 'live-interleaved',
        agentId: 'mock',
        acpSessionId: 'acp-session-1',
        dshSessionId: 'dsh-interleaved',
        closed: false,
        released: false,
      } as unknown as Parameters<AgyLateOutputService['arm']>[0]
      service.arm(session, Date.now())

      // A background task starts, then a synchronous tool (`manage_subagents list`)
      // and a `manage_task status` (Status: RUNNING) run, followed by poll chatter.
      // None of the synchronous GENERIC DONE lines may disarm the waiting gate.
      appendFileSync(transcript, [
        JSON.stringify({
          step_index: 2, type: 'GENERIC', status: 'RUNNING', created_at: '2026-11-13T04:33:00Z',
          content: 'Tool is running as a background task with task id: acp-session-1/task-2',
        }),
        JSON.stringify({
          step_index: 3, type: 'GENERIC', status: 'DONE', created_at: '2026-11-13T04:33:10Z',
          content: 'You have 1 active subagent(s)',
        }),
        JSON.stringify({
          step_index: 4, type: 'GENERIC', status: 'DONE', created_at: '2026-11-13T04:33:11Z',
          content: 'Task: acp-session-1/task-2\nStatus: RUNNING',
        }),
        JSON.stringify({
          step_index: 5, type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-11-13T04:33:12Z',
          content: 'I am waiting for the background task.',
        }),
      ].join('\n') + '\n')
      await vi.advanceTimersByTimeAsync(4_000)
      expect(delivered).toEqual([])

      // When the background task completes via its own SYSTEM_MESSAGE, the
      // following PLANNER_RESPONSE IS the real answer and must be delivered
      // even without a separate GENERIC DONE step.
      appendFileSync(transcript, [
        JSON.stringify({
          step_index: 6, type: 'SYSTEM_MESSAGE', status: 'DONE', created_at: '2026-11-13T04:34:00Z',
          content: '<SYSTEM_MESSAGE>\n[Message] timestamp=2026-11-13T04:34:00Z sender=acp-session-1/task-2 priority=MESSAGE_PRIORITY_HIGH content=done\n</SYSTEM_MESSAGE>',
        }),
        JSON.stringify({
          step_index: 7, type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-11-13T04:34:01Z',
          content: 'Here is the finished command report.',
        }),
      ].join('\n') + '\n')
      await vi.advanceTimersByTimeAsync(3_000)
      expect(delivered).toEqual(['Here is the finished command report.'])
      rmSync(workspace, { recursive: true, force: true })
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not lose a subagent report written between wake delivery and armAfterWake', async () => {
    vi.useFakeTimers()
    try {
      const closedAt = new Date('2026-11-13T04:32:38.000Z')
      vi.setSystemTime(closedAt)
      const workspace = mkdtempSync(join(tmpdir(), 'dsh-ntr-agy-gap-'))
      const logs = join(workspace, 'brain', 'acp-session-1', '.system_generated', 'logs')
      mkdirSync(logs, { recursive: true })
      const transcript = join(logs, 'transcript_full.jsonl')
      writeFileSync(transcript, `${JSON.stringify({
        step_index: 1, type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-11-13T04:32:32Z', content: 'turn answer',
      })}\n`)
      const delivered: string[] = []
      const service = new AgyLateOutputService({
        isAgent: () => true,
        storeRoot: () => workspace,
        tuning: () => ({
          ...DEFAULT_TUNING,
          agyLateOutputPollMs: 1_000,
          agyLateOutputQuietMs: 1_500,
          agyLateOutputMaxMs: 0,
        }),
        host: {
          defOf: () => def,
          isBusy: () => false,
          deliver: (_session, text) => { delivered.push(text); return true },
        },
      })
      const session = {
        sessionId: 'live-gap',
        agentId: 'mock',
        acpSessionId: 'acp-session-1',
        dshSessionId: 'dsh-gap',
        closed: false,
        released: false,
      } as unknown as Parameters<AgyLateOutputService['arm']>[0]
      service.arm(session, Date.now())

      // First late answer lands and is delivered; watch disarms while wake is scheduled.
      appendFileSync(transcript, `${JSON.stringify({
        step_index: 2, type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-11-13T04:32:40Z', content: 'first update',
      })}\n`)
      await vi.advanceTimersByTimeAsync(3_000)
      expect(delivered).toEqual(['first update'])

      // Before `armAfterWake` runs (1 second later), the subagent finishes and
      // writes its report + answer (whose `created_at` may even precede armAfterWake).
      appendFileSync(transcript, [
        JSON.stringify({
          step_index: 3, type: 'SYSTEM_MESSAGE', status: 'DONE', created_at: '2026-11-13T04:32:41Z',
          content: '<SYSTEM_MESSAGE>\n[Message] timestamp=2026-11-13T04:32:41Z sender=subagent-99 priority=MESSAGE_PRIORITY_HIGH content=report\n</SYSTEM_MESSAGE>',
        }),
        JSON.stringify({
          step_index: 4, type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-11-13T04:32:41Z',
          content: 'final subagent answer',
        }),
      ].join('\n') + '\n')

      await vi.advanceTimersByTimeAsync(2_000)
      service.armAfterWake(session)
      await vi.advanceTimersByTimeAsync(3_000)
      expect(delivered).toEqual(['first update', 'final subagent answer'])
      rmSync(workspace, { recursive: true, force: true })
    } finally {
      vi.useRealTimers()
    }
  })

  it('drops a stale reportGate when a new background task starts before answering', async () => {
    vi.useFakeTimers()
    try {
      const closedAt = new Date('2026-11-13T04:32:38.000Z')
      vi.setSystemTime(closedAt)
      const workspace = mkdtempSync(join(tmpdir(), 'dsh-ntr-agy-gate-reset-'))
      const logs = join(workspace, 'brain', 'acp-session-1', '.system_generated', 'logs')
      mkdirSync(logs, { recursive: true })
      const transcript = join(logs, 'transcript_full.jsonl')
      writeFileSync(transcript, `${JSON.stringify({
        step_index: 1, type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-11-13T04:32:32Z', content: 'turn answer',
      })}\n`)
      const delivered: string[] = []
      const service = new AgyLateOutputService({
        isAgent: () => true,
        storeRoot: () => workspace,
        tuning: () => ({
          ...DEFAULT_TUNING,
          agyLateOutputPollMs: 1_000,
          agyLateOutputQuietMs: 1_500,
          agyLateOutputMaxMs: 0,
        }),
        host: {
          defOf: () => def,
          isBusy: () => false,
          deliver: (_session, text) => { delivered.push(text); return true },
        },
      })
      const session = {
        sessionId: 'live-gate-reset',
        agentId: 'mock',
        acpSessionId: 'acp-session-1',
        dshSessionId: 'dsh-gate-reset',
        closed: false,
        released: false,
      } as unknown as Parameters<AgyLateOutputService['arm']>[0]
      service.arm(session, Date.now())

      // Subagent reports, then planner launches a background verification task and writes waiting prose.
      appendFileSync(transcript, [
        JSON.stringify({
          step_index: 2, type: 'SYSTEM_MESSAGE', status: 'DONE', created_at: '2026-11-13T04:33:00Z',
          content: '<SYSTEM_MESSAGE>\n[Message] timestamp=2026-11-13T04:33:00Z sender=subagent-1 priority=MESSAGE_PRIORITY_HIGH content=report\n</SYSTEM_MESSAGE>',
        }),
        JSON.stringify({
          step_index: 3, type: 'GENERIC', status: 'RUNNING', created_at: '2026-11-13T04:33:05Z',
          content: 'Tool is running as a background task with task id: acp-session-1/task-3',
        }),
        JSON.stringify({
          step_index: 4, type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-11-13T04:33:06Z',
          content: 'Waiting for verification command to complete.',
        }),
      ].join('\n') + '\n')
      await vi.advanceTimersByTimeAsync(4_000)
      expect(delivered).toEqual([])

      appendFileSync(transcript, [
        JSON.stringify({
          step_index: 5, type: 'SYSTEM_MESSAGE', status: 'DONE', created_at: '2026-11-13T04:33:20Z',
          content: '<SYSTEM_MESSAGE>\n[Message] timestamp=2026-11-13T04:33:20Z sender=acp-session-1/task-3 priority=MESSAGE_PRIORITY_HIGH content=done\n</SYSTEM_MESSAGE>',
        }),
        JSON.stringify({
          step_index: 6, type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-11-13T04:33:21Z',
          content: 'Verified and complete.',
        }),
      ].join('\n') + '\n')
      await vi.advanceTimersByTimeAsync(3_000)
      expect(delivered).toEqual(['Verified and complete.'])
      rmSync(workspace, { recursive: true, force: true })
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not wake while the next user turn is still running', async () => {
    const dshSessionId = 'dsh-agy-late-busy'
    const wakes: GenerateMessage[] = []
    const { harness } = harnessWithResolver(dshSessionId, wakes)
    await firstLateTurn(harness, dshSessionId)
    // A slow turn is on air when the transcript line lands one second later:
    // the backlog belongs to that turn, so the watch must stand down.
    const { chunks } = await hostLoopTurn(harness.adapter, {
      provider: 'acp',
      model: 'agy-late',
      sessionId: dshSessionId,
      messages: [userText('HANG_DELAY:1500 AGY_BUSY please')],
    })
    expect(textOf(chunks)).toContain('MOCK: echo HANG_DELAY:1500 AGY_BUSY please')
    // Give the (disarmed) watch's poll cadence room to prove it delivers nothing.
    await new Promise(resolve => setTimeout(resolve, 400))
    expect(wakes).toHaveLength(0)
  }, 30_000)

  it('stops the watch when the session is closed', async () => {
    const dshSessionId = 'dsh-agy-late-closed'
    const wakes: GenerateMessage[] = []
    const { harness } = harnessWithResolver(dshSessionId, wakes)
    // Observability only (AgyLateOutputService.armedCount): the watch is on
    // the map, and the transcript file it observes is the mock's existing one.
    const lateOutput = (harness.manager as unknown as {
      lateOutput: { armedCount: number; disarm(session: unknown): void }
    }).lateOutput
    const armed = (): number => lateOutput.armedCount
    await firstLateTurn(harness, dshSessionId)
    expect(armed()).toBe(1)
    // The service's own `disarm` is the same table withdrawal `arm` uses when
    // a new turn supersedes the previous watch; a no-op here would make BOTH
    // paths lie to the map.
    const sessions = [...(harness.manager as unknown as {
      registry: { sessions(): Iterable<unknown> }
    }).registry.sessions()]
    const session = sessions[0]
    expect(session).toBeDefined()
    if (session === undefined) return
    lateOutput.disarm(session)
    expect(armed()).toBe(0)
    harness.manager.armLateOutputWatch(session as never, Date.now())
    expect(armed()).toBe(1)
    const listed = await dispatchRpc(harness.manager, 'sessions/list', {})
    expect(listed.ok).toBe(true)
    const acpSessionId = listed.ok ? (listed.value as { sessions: Array<{ sessionId: string }> }).sessions[0]?.sessionId : undefined
    expect(acpSessionId).toBeDefined()
    if (acpSessionId === undefined) return
    const closed = await dispatchRpc(harness.manager, 'session/close', { sessionId: acpSessionId })
    expect(closed.ok).toBe(true)
    // The teardown really withdrew the watch, not merely silenced it.
    expect(armed()).toBe(0)
    // The mock appends its late answer anyway; a withdrawn watch must not wake.
    await new Promise(resolve => setTimeout(resolve, 1_600))
    expect(wakes).toHaveLength(0)
  }, 30_000)

  it('reads a missing transcript without waking or flooding notices', async () => {
    const dshSessionId = 'dsh-agy-late-missing'
    const wakes: GenerateMessage[] = []
    const harness = lateHarness({ writeTranscript: false })
    harness.manager.setDshAgentResolver(id => id === dshSessionId
      ? { session: { id: dshSessionId }, followup: message => { wakes.push(message as GenerateMessage) } }
      : undefined)
    cleanups.push(async () => {
      await harness.manager.shutdownAll()
      rmSync(harness.workspace, { recursive: true, force: true })
    })
    await firstLateTurn(harness, dshSessionId)
    // Neither transcript candidate exists: nothing is armed (a tail built on a
    // missing file would replay the whole history once the file appeared).
    expect((harness.manager as unknown as { lateOutput: { armedCount: number } }).lateOutput.armedCount).toBe(0)
    await new Promise(resolve => setTimeout(resolve, 1_200))
    expect(wakes).toHaveLength(0)
    expect(harness.events.filter(event => event.type === 'agent/notice')).toHaveLength(0)
  }, 30_000)

  it('swallows the replayed old answer once and keeps the new one', async () => {
    const dshSessionId = 'dsh-agy-late-replay'
    const wakes: GenerateMessage[] = []
    const { harness } = harnessWithResolver(dshSessionId, wakes)
    const first = await firstLateTurn(harness, dshSessionId)
    await until(() => wakes.length === 1, 10_000)
    const wake = wakes[0]
    expect(wake).toBeDefined()
    if (wake === undefined) return
    const replayed = await wakeStep(harness, dshSessionId, [userText('AGY_LATE please'), wake])
    expect(replayed).toContain('AGY-LATE-ANSWER AGY_LATE please')
    // The guard only applies to a turn that began AFTER the delivery was
    // recorded, and a real person never sends inside the same millisecond.
    await new Promise(resolve => setTimeout(resolve, 5))

    const next = await hostLoopTurn(harness.adapter, {
      provider: 'acp',
      model: 'agy-late',
      sessionId: dshSessionId,
      messages: [userText('AGY_REPLAY please')],
    })
    const answered = textOf(next.chunks)
    expect(answered).toContain('MOCK: echo AGY_REPLAY please')
    expect(answered).not.toContain('AGY-LATE-ANSWER')
    // The old answer is on screen exactly once: in the wake step, never again.
    const all = `${first}${replayed}${answered}`
    expect(all.split('AGY-LATE-ANSWER').length - 1).toBe(1)
    // The replayed tool frame opened no second card: its id belongs to a
    // COMPLETED turn, so the replay is transcript-only.
    const cardIds = next.chunks
      .filter((chunk): chunk is Extract<StreamChunk, { type: 'tool-call-delta' }> => chunk.type === 'tool-call-delta')
      .map(chunk => chunk.id)
    expect(cardIds).not.toContain('call_agy_1')
    expect(promptCount(harness.prompts)).toBe(2)
  }, 30_000)

  it('delivers the late answer of a turn that carried a tool card', async () => {
    const dshSessionId = 'dsh-agy-late-toolcard'
    const wakes: GenerateMessage[] = []
    const { harness } = harnessWithResolver(dshSessionId, wakes)
    const { chunks } = await hostLoopTurn(harness.adapter, {
      provider: 'acp',
      model: 'agy-late',
      sessionId: dshSessionId,
      messages: [userText('AGY_LATE tool card')],
    })
    // The turn really carried a card (`seenCalls.size > 0`): its controller is
    // kept for the continuation step instead of being disposed at closeTurn.
    const cardIds = chunks
      .filter((chunk): chunk is Extract<StreamChunk, { type: 'tool-call-delta' }> => chunk.type === 'tool-call-delta')
      .map(chunk => chunk.id)
    expect(cardIds).toContain('call_agy_1')

    await until(() => wakes.length === 1, 10_000)
    expect(String(wakes[0]?.source?.report)).toContain('AGY-LATE-ANSWER')
    expect(promptCount(harness.prompts)).toBe(1)
  }, 30_000)

  it('flushes a held echo prefix when the turn ends mid-prefix', async () => {
    const dshSessionId = 'dsh-agy-late-partial'
    const wakes: GenerateMessage[] = []
    const { harness } = harnessWithResolver(dshSessionId, wakes)
    await firstLateTurn(harness, dshSessionId)
    await until(() => wakes.length === 1, 10_000)
    const wake = wakes[0]
    if (wake === undefined) return
    const replayed = await wakeStep(harness, dshSessionId, [userText('AGY_LATE please'), wake])
    expect(replayed).toContain('AGY-LATE-ANSWER')
    await new Promise(resolve => setTimeout(resolve, 5))

    const { chunks } = await hostLoopTurn(harness.adapter, {
      provider: 'acp',
      model: 'agy-late',
      sessionId: dshSessionId,
      messages: [userText('AGY_REPLAY_PARTIAL please')],
    })
    const answered = textOf(chunks)
    // The mock ends the turn after the first half of the replayed answer: the
    // strict prefix the guard held must be emitted, never dropped.
    expect(answered).toContain('AGY-LATE-ANSWER ')
    expect(answered.split('AGY-LATE-ANSWER').length - 1).toBe(1)
  }, 30_000)

  it('leaves lateEcho unset when a real user message outranks the wake', async () => {
    const dshSessionId = 'dsh-agy-late-skipped'
    const wakes: GenerateMessage[] = []
    const { harness } = harnessWithResolver(dshSessionId, wakes)
    await firstLateTurn(harness, dshSessionId)
    await until(() => wakes.length === 1, 10_000)
    const wake = wakes[0]
    if (wake === undefined) return
    // The person spoke again after the wake was queued: the FIFO skips it, so
    // the report never reaches the plane and its echo must not be swallowed.
    const skipped = await hostLoopTurn(harness.adapter, {
      provider: 'acp',
      model: 'agy-late',
      sessionId: dshSessionId,
      messages: [userText('AGY_LATE please'), wake, userText('AGY_INSERTED please')],
    })
    const skippedText = textOf(skipped.chunks)
    expect(skippedText).toContain('MOCK: echo AGY_INSERTED please')
    expect(skippedText).not.toContain('AGY-LATE-ANSWER')

    const { chunks } = await hostLoopTurn(harness.adapter, {
      provider: 'acp',
      model: 'agy-late',
      sessionId: dshSessionId,
      messages: [userText('AGY_REPLAY please')],
    })
    const answered = textOf(chunks)
    expect(answered).toContain('AGY-LATE-ANSWER AGY_LATE please')
    expect(answered).toContain('MOCK: echo AGY_REPLAY please')
  }, 30_000)
})

/**
 * Lifetime of one watch, on a fake clock: the field failure this guards against
 * is a research subagent that finished 12m34s after its turn closed and was
 * dropped by a fixed 10-minute deadline (session-af26f3a8, 2026-11-13). The
 * watch is bounded by the SESSION (release / close / next turn), not by time.
 */
describe('AGY-LATE: watch lifetime', () => {
  const CLOSED_AT = new Date('2026-11-13T03:04:23.000Z')
  const LATE_AT = '2026-11-13T03:16:57Z'

  interface Lifetime {
    service: AgyLateOutputService
    session: Parameters<AgyLateOutputService['arm']>[0]
    transcript: string
    delivered: string[]
    workspace: string
  }

  function lifetime(maxMs: number): Lifetime {
    const workspace = mkdtempSync(join(tmpdir(), 'dsh-ntr-agy-lifetime-'))
    const logs = join(workspace, 'brain', 'acp-session-1', '.system_generated', 'logs')
    mkdirSync(logs, { recursive: true })
    const transcript = join(logs, 'transcript_full.jsonl')
    // The transcript already exists when the turn closes (arm requires that),
    // with the turn's own answer at or below the baseline.
    writeFileSync(transcript, `${JSON.stringify({
      step_index: 3, type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-11-13T03:04:15Z', content: 'turn answer',
    })}\n`)
    const delivered: string[] = []
    const service = new AgyLateOutputService({
      isAgent: () => true,
      storeRoot: () => workspace,
      tuning: () => ({
        ...DEFAULT_TUNING,
        agyLateOutputPollMs: 1_000,
        agyLateOutputQuietMs: 1_500,
        agyLateOutputMaxMs: maxMs,
      }),
      host: {
        defOf: () => def,
        isBusy: () => false,
        deliver: (_session, text) => { delivered.push(text); return true },
      },
    })
    const session = {
      sessionId: 'live-lifetime',
      agentId: 'mock',
      acpSessionId: 'acp-session-1',
      dshSessionId: 'dsh-lifetime',
      closed: false,
      released: false,
    } as unknown as Parameters<AgyLateOutputService['arm']>[0]
    return { service, session, transcript, delivered, workspace }
  }

  function appendLateAnswer(transcript: string): void {
    writeFileSync(transcript, `${JSON.stringify({
      step_index: 5, type: 'PLANNER_RESPONSE', status: 'DONE', created_at: LATE_AT, content: 'the missing late answer',
    })}\n`, { flag: 'a' })
  }

  it('delivers an answer that lands thirteen minutes after the turn closed', async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(CLOSED_AT)
      const { service, session, transcript, delivered, workspace } = lifetime(0)
      service.arm(session, Date.now())
      expect(service.armedCount).toBe(1)
      // The old fixed bound (600000 ms) expired here with nothing to deliver.
      await vi.advanceTimersByTimeAsync(754_000)
      appendLateAnswer(transcript)
      await vi.advanceTimersByTimeAsync(3_000)
      expect(delivered).toEqual(['the missing late answer'])
      expect(service.armedCount).toBe(0)
      rmSync(workspace, { recursive: true, force: true })
    } finally {
      vi.useRealTimers()
    }
  })

  it('still honours a positive deadline when a deployment sets one', async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(CLOSED_AT)
      const { service, session, transcript, delivered, workspace } = lifetime(600_000)
      service.arm(session, Date.now())
      expect(service.armedCount).toBe(1)
      await vi.advanceTimersByTimeAsync(600_001)
      expect(service.armedCount).toBe(0)
      appendLateAnswer(transcript)
      await vi.advanceTimersByTimeAsync(3_000)
      expect(delivered).toEqual([])
      rmSync(workspace, { recursive: true, force: true })
    } finally {
      vi.useRealTimers()
    }
  })
})
