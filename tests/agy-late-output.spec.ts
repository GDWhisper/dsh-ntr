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
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { afterAll, describe, expect, it, vi } from 'vitest'
import {
  AcpLlmAdapter, BACKGROUND_FAILURE_WAKE_TEXT, BACKGROUND_REPORT_FORM, BACKGROUND_REPORT_SOURCE, BridgeManager,
  type BridgeTuning,
} from '../src/bridge.ts'
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
 * Antigravity transcript late output (docs/plan/archive/antigravity-late-output.md):
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

  function thoughtOf(chunks: readonly StreamChunk[]): string {
    return chunks
      .filter((chunk): chunk is Extract<StreamChunk, { type: 'reasoning-delta' }> => chunk.type === 'reasoning-delta')
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

  it('surfaces a background failure as a wake without arming the echo guard', async () => {
    const dshSessionId = 'dsh-agy-late-failure'
    const wakes: GenerateMessage[] = []
    const { harness } = harnessWithResolver(dshSessionId, wakes)
    await hostLoopTurn(harness.adapter, {
      provider: 'acp',
      model: 'agy-late',
      sessionId: dshSessionId,
      messages: [userText('AGY_DISPATCHFAIL please')],
    })
    await until(() => wakes.length === 1, 10_000)
    const wake = wakes[0]
    expect(wake?.role).toBe('user')
    expect(wake?.source?.kind).toBe(BACKGROUND_REPORT_SOURCE)
    expect(wake?.source?.form).toBe(BACKGROUND_REPORT_FORM)
    expect((wake?.content as Array<{ text: string }>)[0]?.text).toBe(BACKGROUND_FAILURE_WAKE_TEXT)
    expect(String(wake?.source?.report)).toContain('encountered an error')
    expect(String(wake?.source?.report)).toContain('EOF')
    // The wake replays locally: the agent saw exactly ONE prompt (the dispatch).
    expect(promptCount(harness.prompts)).toBe(1)
    // No echo guard: agy never replays a failure it did not write as a planner
    // step, so neither the pending nor the committed record may be armed.
    const seam = harness.manager as unknown as { registry: { sessionAt(id: string, agentId: string): { pendingLateEcho?: unknown; lateEcho?: unknown } | undefined } }
    const live = seam.registry.sessionAt(dshSessionId, 'agy-late')
    expect(live).toBeDefined()
    expect(live?.pendingLateEcho).toBeUndefined()
    expect(live?.lateEcho).toBeUndefined()
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
    // The replayed thinking is the late step's own: swallowed beside its text.
    expect(thoughtOf(next.chunks)).not.toContain('AGY-LATE-THOUGHT')
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
    expect(thoughtOf(chunks)).not.toContain('AGY-LATE-THOUGHT')
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
    // No commit happened, so the replayed thinking shows too (fail-open).
    expect(thoughtOf(chunks)).toContain('AGY-LATE-THOUGHT')
  }, 30_000)

  it('swallows the replay when the next prompt arrives long after the delivery', async () => {
    const dshSessionId = 'dsh-agy-late-slow-reply'
    const wakes: GenerateMessage[] = []
    const { harness } = harnessWithResolver(dshSessionId, wakes)
    await firstLateTurn(harness, dshSessionId)
    await until(() => wakes.length === 1, 10_000)
    const wake = wakes[0]
    if (wake === undefined) return
    await wakeStep(harness, dshSessionId, [userText('AGY_LATE please'), wake])
    // The field incident (session-a12ff72b): the person replied 24 minutes
    // after the delivery. The replay binds to the NEXT PROMPT, not to a
    // wall-clock window, so the guard must still swallow it whole.
    const realNow = Date.now
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => realNow() + 24 * 60_000)
    try {
      const { chunks } = await hostLoopTurn(harness.adapter, {
        provider: 'acp',
        model: 'agy-late',
        sessionId: dshSessionId,
        messages: [userText('AGY_REPLAY please')],
      })
      const answered = textOf(chunks)
      expect(answered).toContain('MOCK: echo AGY_REPLAY please')
      expect(answered).not.toContain('AGY-LATE-ANSWER')
      expect(thoughtOf(chunks)).not.toContain('AGY-LATE-THOUGHT')
    } finally {
      clock.mockRestore()
    }
  }, 30_000)

  it('retires the echo record when the turn closes with no segment on air', async () => {
    const dshSessionId = 'dsh-agy-late-segmentless'
    const wakes: GenerateMessage[] = []
    const { harness } = harnessWithResolver(dshSessionId, wakes)
    await firstLateTurn(harness, dshSessionId)
    await until(() => wakes.length === 1, 10_000)
    const wake = wakes[0]
    if (wake === undefined) return
    await wakeStep(harness, dshSessionId, [userText('AGY_LATE please'), wake])
    await new Promise(resolve => setTimeout(resolve, 5))
    // The flush replays only the thinking and ends the turn: nothing visible,
    // no card, so no segment is on air at close. The thought key is consumed;
    // the text key must NOT stay armed past this turn.
    const silent = await hostLoopTurn(harness.adapter, {
      provider: 'acp',
      model: 'agy-late',
      sessionId: dshSessionId,
      messages: [userText('AGY_REPLAY_THOUGHT_ONLY please')],
    })
    expect(thoughtOf(silent.chunks)).not.toContain('AGY-LATE-THOUGHT')
    expect(textOf(silent.chunks)).not.toContain('AGY-LATE-ANSWER')

    const next = await hostLoopTurn(harness.adapter, {
      provider: 'acp',
      model: 'agy-late',
      sessionId: dshSessionId,
      messages: [userText('AGY_REPLAY please')],
    })
    // The record retired at the segment-less close: this replay is unguarded
    // and must show (fail-open), never be swallowed by a dead key.
    expect(textOf(next.chunks)).toContain('AGY-LATE-ANSWER AGY_LATE please')
  }, 30_000)

  it('retires the echo record when a cancel closes the turn segment-less', async () => {
    const dshSessionId = 'dsh-agy-late-cancel'
    const wakes: GenerateMessage[] = []
    const { harness } = harnessWithResolver(dshSessionId, wakes)
    await firstLateTurn(harness, dshSessionId)
    await until(() => wakes.length === 1, 10_000)
    const wake = wakes[0]
    if (wake === undefined) return
    await wakeStep(harness, dshSessionId, [userText('AGY_LATE please'), wake])
    await new Promise(resolve => setTimeout(resolve, 5))
    // Cancel while the guard holds a strict prefix: the abort finishes the
    // on-air segment, so the close runs with no segment — the record must
    // still retire (a cancel discards the held bytes, not the next turn).
    const abort = new AbortController()
    const heldTurn = hostLoopTurn(harness.adapter, {
      provider: 'acp',
      model: 'agy-late',
      sessionId: dshSessionId,
      messages: [userText('AGY_REPLAY_HOLD please')],
    }, 8, abort.signal)
    await new Promise(resolve => setTimeout(resolve, 400))
    abort.abort()
    const held = await heldTurn
    expect(textOf(held.chunks)).not.toContain('AGY-LATE-ANSWER')

    const next = await hostLoopTurn(harness.adapter, {
      provider: 'acp',
      model: 'agy-late',
      sessionId: dshSessionId,
      messages: [userText('AGY_REPLAY please')],
    })
    expect(textOf(next.chunks)).toContain('AGY-LATE-ANSWER AGY_LATE please')
  }, 30_000)

  it('retires the echo record when an /acp prompt consumes the flush', async () => {
    const dshSessionId = 'dsh-agy-late-rpc-flush'
    const wakes: GenerateMessage[] = []
    const { harness } = harnessWithResolver(dshSessionId, wakes)
    await firstLateTurn(harness, dshSessionId)
    await until(() => wakes.length === 1, 10_000)
    const wake = wakes[0]
    if (wake === undefined) return
    await wakeStep(harness, dshSessionId, [userText('AGY_LATE please'), wake])
    await new Promise(resolve => setTimeout(resolve, 5))
    // The RPC face has no controller: its prompt consumes the flush on the raw
    // transcript, so the committed guard must retire at claim time.
    const acpSessionId = harness.events.find(event => 'sessionId' in event)?.sessionId
    expect(acpSessionId).toBeDefined()
    if (acpSessionId === undefined) return
    const sent = await dispatchRpc(harness.manager, 'session/prompt', { sessionId: acpSessionId, text: 'AGY_REPLAY please' })
    expect(sent.ok).toBe(true)
    if (!sent.ok) return
    const turnId = (sent.value as { turnId: string }).turnId
    await until(() => harness.events.some(event => event.type === 'turn/end' && event.turnId === turnId), 10_000)

    const next = await hostLoopTurn(harness.adapter, {
      provider: 'acp',
      model: 'agy-late',
      sessionId: dshSessionId,
      messages: [userText('AGY_REPLAY please')],
    })
    expect(textOf(next.chunks)).toContain('AGY-LATE-ANSWER AGY_LATE please')
  }, 30_000)
})
