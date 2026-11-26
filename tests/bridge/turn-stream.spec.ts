import { tmpdir } from 'node:os'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { afterAll, describe, expect, it } from 'vitest'
import { AcpLlmAdapter, AgentBridge, BridgeManager, routeBindingRegistry } from '../../src/bridge.ts'
import { dispatchWithinWindows } from '../../src/bridge/turn-stream.ts'
import type { LiveSession } from '../../src/bridge/live-session.ts'
import { hasPromptSlot, isSettling, openTurnSlot, releasePromptSlot } from '../../src/bridge/session-lifecycle.ts'
import type { BackgroundDispatch } from '../../src/bridge/types.ts'
import { type AcpEvent, type ChatSessionView, type GenerateMessage, type StreamChunk } from '../../src/protocol.ts'
import { dispatchRpc, EventHub, Transcript } from '../../src/impl.ts'
import { def, hostLoopTurn } from './harness.ts'

/**
 * A segmented ACP turn interleaves prose and cards like a NATIVE multi-step
 * turn: the adapter ends its stream where a card-bearing stretch meets the
 * next non-tool event, the host settles the message, executes the card, and
 * its agent loop proposes the continuation step — which resumes the SAME
 * in-flight `session/prompt` (see docs/acp-convergence.md §1.7).
 */
describe("a segmented turn interleaves like a native multi-step turn (isolated manager)", () => {
  /**
   * A fake agent whose answer is INTERLEAVED with its tool activity: text
   * before the first call, then a call, then the rest of the answer — the
   * shape a native turn gets by running two model steps with the cards in
   * between, and the shape a segmented ACP turn now reproduces across the
   * host loop's own steps.
   *
   * Written inline (`node -e`) so no new fixture file is needed; its `cwd` is
   * the repository root so the dynamic SDK import resolves.
   */
  const interleavedScript = [
    '(async () => {',
    "  const { agent, methods, ndJsonStream, PROTOCOL_VERSION } = await import('@agentclientprotocol/sdk')",
    "  const { Writable, Readable } = require('node:stream')",
    "  agent({ name: 'interleaved-fake' })",
    '    .onRequest(methods.agent.initialize, () => ({',
    '      protocolVersion: PROTOCOL_VERSION,',
    "      agentCapabilities: { loadSession: false, promptCapabilities: { image: false, audio: false, embeddedContext: false } },",
    '      authMethods: [],',
    '    }))',
    "    .onRequest(methods.agent.session.new, () => ({ sessionId: 'interleaved-1' }))",
    '    .onRequest(methods.agent.session.prompt, async ctx => {',
    '      const send = update => ctx.client.notify(methods.client.session.update, { sessionId: ctx.params.sessionId, update })',
    "      const promptOf = params => String(params?.prompt?.[0]?.text ?? '')",
    "      await send({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'thinking…' } })",
    "      if (!promptOf(ctx.params).includes('END ON TOOL')) {",
    "        await send({ sessionUpdate: 'agent_message_chunk', messageId: 'm1', content: { type: 'text', text: 'PRE-CALL ANSWER' } })",
    '      }',
    "      await send({ sessionUpdate: 'tool_call', toolCallId: 'c1', title: 'fake tool', kind: 'other', status: 'pending' })",
    "      await send({ sessionUpdate: 'tool_call_update', toolCallId: 'c1', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: 'FAKE TOOL OUTPUT' } }] })",
    "      if (!promptOf(ctx.params).includes('END ON TOOL')) {",
    "        await send({ sessionUpdate: 'agent_message_chunk', messageId: 'm2', content: { type: 'text', text: 'POST-CALL ANSWER' } })",
    '      }',
    "      return { stopReason: 'end_turn' }",
    '    })',
    "    .connect(ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)))",
    '})()',
  ].join('\n')
  const interleavedHub = new EventHub()
  const interleavedManager = new BridgeManager([{
    ...def,
    id: 'interleaved',
    args: ['-e', interleavedScript],
    cwd: process.cwd(),
    allowedCwdRoots: [process.cwd()],
  }], interleavedHub, 500)
  const interleavedAdapter = new AcpLlmAdapter(interleavedManager)

  afterAll(async () => {
    await interleavedManager.shutdownAll()
  })

  const textOf = (chunks: readonly StreamChunk[]): string => chunks
    .filter((c): c is Extract<StreamChunk, { type: 'text-delta' }> => c.type === 'text-delta')
    .map(c => c.text)
    .join('')

  it('splits at the tool card: prose before it in step 1, the rest in the continuation step', async () => {
    const { chunks, steps } = await hostLoopTurn(interleavedAdapter, {
      provider: 'acp',
      model: 'interleaved',
      sessionId: 'dsh-interleaved-1',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'go' }] }],
    })

    // Exactly two host steps: the card-bearing message, then the continuation.
    expect(steps.length).toBe(2)
    const [first, second] = steps

    // Step 1 carries the pre-call prose and the CARD as its last block — the
    // host loop executes the card right below this message, above the next.
    const firstText = textOf(first)
    expect(firstText).toContain('PRE-CALL ANSWER')
    expect(firstText).not.toContain('POST-CALL ANSWER')
    const firstStarts = first.filter(c => c.type === 'block-start').map(c => (c as { blockType: string }).blockType)
    expect(firstStarts.at(-1)).toBe('tool-call')
    expect(firstStarts.slice(0, -1)).toEqual(['reasoning', 'text'])
    // The name is the fixed constant and the card's arguments are a JSON object
    // whose `description` carries the agent's own title (read live by the host
    // preparing row); the tool's real output lives in the shared output registry
    // (asserted below), not in the card body.
    const cardArgs = first
      .filter((c): c is Extract<StreamChunk, { type: 'tool-call-delta' }> => c.type === 'tool-call-delta')
      .map(c => c.argumentsDelta).join('')
    expect(cardArgs).toBe('{"description":"fake tool","kind":"other"}')

    // Step 2 (the continuation) carries the post-call answer and NO card: the
    // turn's last settled message is tool-free, so the loop completes here.
    expect(textOf(second)).toContain('POST-CALL ANSWER')
    expect(second.some(c => c.type === 'tool-call-delta')).toBe(false)
    expect(second.find(c => c.type === 'finish')?.reason).toEqual({ kind: 'stop' })
    expect(chunks.find(c => c.type === 'finish')?.reason).toEqual({ kind: 'stop' })

    // The tool's output reached the shared registry — the guard's virtual tool
    // answers the host loop's execution of the card from it. The agent's
    // `completed` status marked the call terminal, which is what lets a tool
    // that prints NOTHING release its card instead of parking it.
    expect(routeBindingRegistry().toolResults.get('c1')).toContain('FAKE TOOL OUTPUT')
    expect(routeBindingRegistry().toolOutputFinal.has('c1')).toBe(true)
  }, 30_000)

  it('answers a foreign staged batch with a closing message, and a card-final turn with the tail pointer', async () => {
    // A staged batch for a conversation with NO in-flight ACP turn is foreign
    // by construction (the host loop only stages results it executed): the
    // adapter must not forward it — that would re-send the person's words —
    // and answers with one closing message instead.
    const foreign: StreamChunk[] = []
    for await (const chunk of interleavedAdapter.stream({
      provider: 'acp',
      model: 'interleaved',
      sessionId: 'dsh-interleaved-2',
      messages: [
        { role: 'tool', source: { kind: 'tool', callId: 'c1' }, content: [{ type: 'text', text: 'FAKE TOOL OUTPUT' }] },
      ],
    })) {
      foreign.push(chunk)
    }
    expect(textOf(foreign)).toContain('no in-flight ACP turn to resume')
    expect(foreign.find(c => c.type === 'finish')?.reason).toEqual({ kind: 'stop' })

    // A turn that ENDS on its card settles with no segment on air; the host
    // loop still executes the card and proposes one last continuation, which
    // answers with the tail pointer (the turn delivered its prose already).
    const { steps } = await hostLoopTurn(interleavedAdapter, {
      provider: 'acp',
      model: 'interleaved',
      sessionId: 'dsh-interleaved-3',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'END ON TOOL' }] }],
    })
    expect(steps.length).toBe(2)
    const [first, tail] = steps
    expect(first.some(c => c.type === 'tool-call-delta')).toBe(true)
    expect(textOf(tail)).toContain('sent no text reply this turn')
    expect(tail.some(c => c.type === 'tool-call-delta')).toBe(false)
    expect(tail.find(c => c.type === 'finish')?.reason).toEqual({ kind: 'stop' })
  }, 30_000)
})

describe('prompt slot (isolated manager)', () => {
  const slotHub = new EventHub()
  const slotManager = new BridgeManager([{ ...def, id: 'slot' }], slotHub, 500, undefined, undefined, false, {
    turnSettleMs: 200,
    // Keep the cancel fallback out of the way: this suite is about the wait
    // for the AGENT's own settlement, not about the host giving up on it.
    cancelFallbackMs: 5_000,
  })
  const slotAdapter = new AcpLlmAdapter(slotManager)

  afterAll(async () => {
    await slotManager.shutdownAll()
  })

  /** Drain one adapter stream for the shared session id. */
  async function drain(text: string, signal?: AbortSignal): Promise<StreamChunk[]> {
    const chunks: StreamChunk[] = []
    for await (const chunk of slotAdapter.stream({
      provider: 'acp',
      model: 'slot',
      sessionId: 'dsh-slot',
      ...(signal === undefined ? {} : { signal }),
      messages: [{ role: 'user', content: [{ type: 'text', text }] }],
    })) {
      chunks.push(chunk)
    }
    return chunks
  }

  it('refuses a second prompt while the agent still owns the cancelled turn, then accepts it once settled', async () => {
    // IGNORE_CANCEL: the mock keeps working ~1.2s after receiving the cancel,
    // so the aborted stream and the agent's settlement are far apart — exactly
    // the window in which a naive implementation sends a concurrent prompt.
    const controller = new AbortController()
    const firstChunks: StreamChunk[] = []
    const firstStream = slotAdapter.stream({
      provider: 'acp',
      model: 'slot',
      sessionId: 'dsh-slot',
      signal: controller.signal,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'IGNORE_CANCEL please' }] }],
    })[Symbol.asyncIterator]()
    // Abort only after the turn has shown a visible block. A fixed 400ms sleep
    // raced CPU contention: if the abort landed before the prompt reached the
    // agent (or before any block was folded), the provisional first turn rolled
    // back and the next prompt legitimately opened a fresh session instead of
    // hitting the busy slot. Waiting for the first visible delta makes both the
    // "still busy" refusal and the later resume deterministic.
    while (true) {
      const step = await firstStream.next()
      if (step.done) break
      firstChunks.push(step.value)
      if (step.value.type === 'text-delta' || step.value.type === 'reasoning-delta' || step.value.type === 'tool-call-delta') break
    }
    controller.abort()
    while (true) {
      const step = await firstStream.next()
      if (step.done) break
      firstChunks.push(step.value)
    }
    expect(firstChunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'aborted' } })

    // Immediately afterwards: the slot is still the agent's, so the honest
    // answer is a refusal — never a second `session/prompt` on a busy session.
    const second = await drain('hello after cancel')
    expect(second.find((chunk): chunk is Extract<StreamChunk, { type: 'finish' }> => chunk.type === 'finish'))
      .toMatchObject({ reason: { kind: 'error', failure: { code: 'turn_in_flight' } } })

    // Once the agent has settled, the session is usable again: nothing wedged.
    await new Promise(resolve => setTimeout(resolve, 1_600))
    const third = await drain('hello again')
    // The echo rides the continuation step (the two-step turn shape), so the
    // settled turn is followed by the staged-results replay.
    const thirdAnswer: StreamChunk[] = []
    for await (const chunk of slotAdapter.stream({
      provider: 'acp',
      model: 'slot',
      sessionId: 'dsh-slot',
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'hello again' }] },
        { role: 'tool', source: { kind: 'tool', callId: 'call_1' }, content: [{ type: 'text', text: 'tool result line' }] },
      ],
    })) {
      thirdAnswer.push(chunk)
    }
    const text = thirdAnswer
      .filter((chunk): chunk is Extract<StreamChunk, { type: 'text-delta' }> => chunk.type === 'text-delta')
      .map(chunk => chunk.text)
      .join('')
    expect(text).toContain('MOCK: echo hello again')
  }, 30_000)
})

describe('observed chat transcripts (isolated manager)', () => {
  const txHub = new EventHub()
  const txManager = new BridgeManager([{ ...def, id: 'tx' }], txHub, 500)
  const txAdapter = new AcpLlmAdapter(txManager)

  afterAll(async () => {
    await txManager.shutdownAll()
  })

  /** Run one adapter turn for a chat session and drain it. */
  async function txTurn(sessionId: string, text: string): Promise<void> {
    // The WHOLE turn (continuation steps included): the first segment ends at
    // the agent's first message chunk, and the echo only completes in the
    // continuation — reading the transcript after a single-segment drain
    // races the mock's remaining frames.
    const { chunks } = await hostLoopTurn(txAdapter, {
      provider: 'acp',
      model: 'tx',
      sessionId,
      messages: [{ role: 'user', content: [{ type: 'text', text }] }],
    })
    void chunks
  }

  it('addresses a chat session\'s ACP transcript by the chat id and serves it over RPC', async () => {
    await txTurn('dsh-tx-1', 'hello transcript')

    const views = txManager.chatTranscripts('dsh-tx-1')
    expect(views).toHaveLength(1)
    expect(views[0]?.session.agentId).toBe('tx')
    const kinds = views[0]?.entries.map(entry => String((entry.update as Record<string, unknown>).sessionUpdate)) ?? []
    expect(kinds).toContain('agent_message_chunk')
    // The tool calls the native chat cannot render are exactly what this view
    // exists for, so their presence is part of the contract.
    expect(kinds).toContain('tool_call')
    const echoed = views[0]?.entries
      .filter(entry => (entry.update as Record<string, unknown>).sessionUpdate === 'agent_message_chunk')
      .map(entry => String(((entry.update as Record<string, unknown>).content as { text?: string }).text ?? ''))
      .join('')
    expect(echoed).toContain('MOCK: echo hello transcript')

    // `afterSeq` pages the same buffer the transcript RPC serves: past the head
    // the session snapshot still answers, with nothing left to replay.
    expect(txManager.chatTranscripts('dsh-tx-1', 10_000)[0]?.entries).toEqual([])
    // A chat session no ACP agent has run in has nothing to show.
    expect(txManager.chatTranscripts('dsh-tx-never')).toEqual([])

    const viaRpc = await dispatchRpc(txManager, 'session/chat-transcript', { dshSessionId: 'dsh-tx-1' })
    expect(viaRpc.ok).toBe(true)
    if (!viaRpc.ok) return
    const views2 = (viaRpc.value as { views: Array<{ entries: unknown[] }> }).views
    expect(views2).toHaveLength(1)
    expect(views2[0]?.entries.length).toBe(views[0]?.entries.length)

    // The composer's agent chip reads the roster title for the chat binding.
    const listed = await dispatchRpc(txManager, 'session/chat-list', { dshSessionId: 'dsh-tx-1' })
    if (!listed.ok) throw new Error('listing failed')
    expect((listed.value as { sessions: ChatSessionView[] }).sessions[0]?.agentTitle).toBe('Mock')
    // The composer's occupancy ring reads the chat row, so the agent's own
    // context sample must ride this answer — not only the transcript.
    expect((listed.value as { sessions: ChatSessionView[] }).sessions[0]?.usage).toMatchObject({ used: 123, size: 1000 })
  }, 30_000)

  it('drops a closed session instead of serving a ghost transcript', async () => {
    await txTurn('dsh-tx-2', 'hello close')
    const views = txManager.chatTranscripts('dsh-tx-2')
    const sessionId = views[0]?.session.sessionId ?? ''
    expect(sessionId).not.toBe('')

    await expect(dispatchRpc(txManager, 'session/close', { sessionId })).resolves.toEqual({ ok: true, value: { done: true } })
    expect(txManager.chatTranscripts('dsh-tx-2')).toEqual([])
    const listed = await dispatchRpc(txManager, 'session/chat-list', { dshSessionId: 'dsh-tx-2' })
    expect(listed).toMatchObject({ ok: true, value: { sessions: [], acpMode: false } })
    // Closing the ACP session does not unlock the conversation: the lock
    // belongs to the conversation, and its next turn resumes the same agent.
    expect(listed).toMatchObject({ ok: true, value: { lockedAgentId: 'tx' } })
  }, 30_000)
})

/**
 * The `/acp` RPC prompt and the chat adapter drive the SAME agent session: one
 * `session/prompt` at a time is a protocol rule, whichever face sent it. The
 * RPC path must therefore claim the chat path's slot (`turnSlot`: the prompt
 * slot plus the settle gate), and each face must refuse while the other is in
 * flight.
 */
describe('the /acp prompt shares the chat prompt slot (isolated manager)', () => {
  const gateLog = `${tmpdir()}/dsh-ntr-gate-prompts-${String(process.pid)}-${String(Date.now())}.log`
  const gateHub = new EventHub()
  const gateEvents: AcpEvent[] = []
  gateHub.subscribe(event => { gateEvents.push(event) })
  const gateManager = new BridgeManager(
    [{ ...def, id: 'gate', env: { ...def.env, MOCK_PROMPT_LOG: gateLog } }],
    gateHub,
    500,
    undefined,
    undefined,
    false,
    { startupTimeoutMs: 5_000, cancelFallbackMs: 1_000 },
  )
  const gateAdapter = new AcpLlmAdapter(gateManager)

  afterAll(async () => {
    await gateManager.shutdownAll()
    rmSync(gateLog, { force: true })
  })

  /** Every `session/prompt` text the agent actually received, in order. */
  function promptLines(): string[] {
    return existsSync(gateLog)
      ? readFileSync(gateLog, 'utf8').split('\n').filter(line => line !== '')
      : []
  }

  /** Fresh each time: an old event from an earlier case never satisfies a wait. */
  function gateWaitFor<T extends AcpEvent['type']>(type: T, since: number, predicate: (event: Extract<AcpEvent, { type: T }>) => boolean, timeoutMs = 15_000): Promise<Extract<AcpEvent, { type: T }>> {
    const matches = (event: AcpEvent): event is Extract<AcpEvent, { type: T }> =>
      event.type === type && predicate(event as Extract<AcpEvent, { type: T }>)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout waiting for ${type}`)), timeoutMs)
      const unsub = gateHub.subscribe(event => {
        if (gateEvents.indexOf(event) >= since && matches(event)) {
          clearTimeout(timer)
          unsub()
          resolve(event)
        }
      })
      const existing = gateEvents.find((event, index) => index >= since && matches(event))
      if (existing !== undefined) {
        clearTimeout(timer)
        unsub()
        resolve(existing)
      }
    })
  }

  /** The mock's first tool tick proves `session/prompt` reached the agent. */
  function promptReached(sessionId: string, since: number): Promise<void> {
    return gateWaitFor('session/update', since, event => event.sessionId === sessionId
      && (event.update as { toolCallId?: string }).toolCallId === 'call_1'
      && (event.update as { status?: string }).status === 'in_progress')
      .then(() => {})
  }

  async function collectWith(dshSessionId: string, messages: GenerateMessage[], signal?: AbortSignal): Promise<StreamChunk[]> {
    const chunks: StreamChunk[] = []
    for await (const chunk of gateAdapter.stream({
      provider: 'acp',
      model: 'gate',
      sessionId: dshSessionId,
      ...(signal === undefined ? {} : { signal }),
      messages,
    })) chunks.push(chunk)
    return chunks
  }

  function collect(dshSessionId: string, text: string, signal?: AbortSignal): Promise<StreamChunk[]> {
    return collectWith(dshSessionId, [{ role: 'user', content: [{ type: 'text', text }] }], signal)
  }

  function gateFinish(chunks: StreamChunk[]): Extract<StreamChunk, { type: 'finish' }> | undefined {
    return chunks.find((chunk): chunk is Extract<StreamChunk, { type: 'finish' }> => chunk.type === 'finish')
  }

  it('refuses a chat prompt while an /acp prompt is in flight', async () => {
    const session = await gateManager.getOrCreateDshSession('dsh-gate-acp-first', 'gate')
    const since = gateEvents.length
    const before = promptLines().length
    await gateManager.prompt(session.sessionId, 'SLOW ACP_FIRST please')
    await promptReached(session.sessionId, since)

    // The RPC answered `accepted`; the agent is still inside the turn. A chat
    // prompt for the SAME ACP session must be refused before it is sent.
    const chunks = await collect('dsh-gate-acp-first', 'chat while acp')
    expect(gateFinish(chunks)?.reason).toMatchObject({ kind: 'error', failure: { code: 'turn_in_flight' } })
    expect(promptLines().slice(before)).toEqual(['SLOW ACP_FIRST please'])
    expect(gateEvents.slice(since).filter(event => event.type === 'turn/start' && event.sessionId === session.sessionId))
      .toHaveLength(1)

    // Release the /acp turn so shutdown is not left waiting on it.
    await gateManager.cancel(session.sessionId)
    await gateWaitFor('turn/end', since, event => event.sessionId === session.sessionId && event.stopReason === 'cancelled')
  }, 30_000)

  it('refuses an /acp prompt while a chat turn is in flight', async () => {
    const session = await gateManager.getOrCreateDshSession('dsh-gate-chat-first', 'gate')
    const since = gateEvents.length
    const before = promptLines().length
    const controller = new AbortController()
    const running = collect('dsh-gate-chat-first', 'SLOW CHAT_FIRST please', controller.signal)
    await promptReached(session.sessionId, since)

    let code: string | undefined
    try {
      await gateManager.prompt(session.sessionId, 'acp while chat')
    } catch (error) {
      code = (error as { code?: string }).code
    }
    expect(code).toBe('turn_in_flight')
    expect(promptLines().slice(before)).toEqual(['SLOW CHAT_FIRST please'])

    controller.abort()
    expect(gateFinish(await running)?.reason).toMatchObject({ kind: 'aborted' })
    await gateWaitFor('turn/end', since, event => event.sessionId === session.sessionId)
  }, 30_000)

  it('accepts a chat prompt after an /acp turn completed normally', async () => {
    // The other half of the two-way gate: an /acp turn that ENDS normally
    // (not cancelled) must release the slot it claimed, so the same session's
    // chat path can stream a full turn.
    const dshSessionId = 'dsh-gate-acp-then-chat'
    const session = await gateManager.getOrCreateDshSession(dshSessionId, 'gate')
    const since = gateEvents.length
    const accepted = await gateManager.prompt(session.sessionId, 'normal acp turn')
    await gateWaitFor('turn/end', since, event => event.sessionId === session.sessionId
      && event.turnId === accepted.turnId
      && event.stopReason === 'end_turn')

    const before = promptLines().length
    // The mock's normal turn carries a tool card, so drive the real host loop:
    // the first step opens the card, the continuation resumes the SAME ACP
    // turn. What matters is that the chat path was admitted at all and
    // completed normally after the /acp slot was released.
    const { chunks } = await hostLoopTurn(gateAdapter, {
      provider: 'acp',
      model: 'gate',
      sessionId: dshSessionId,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'chat after acp' }] }],
    })
    expect(gateFinish(chunks)?.reason).toEqual({ kind: 'stop' })
    const text = chunks
      .filter((chunk): chunk is Extract<StreamChunk, { type: 'text-delta' }> => chunk.type === 'text-delta')
      .map(chunk => chunk.text)
      .join('')
    expect(text).toContain('MOCK: echo chat after acp perm=none')
    expect(promptLines().slice(before)).toEqual(['chat after acp'])
  }, 30_000)

  /**
   * The host's steer shape: the task's history (its first user turn, the
   * settled assistant card, that card's staged tool result) followed by the
   * person's mid-turn words. `isAcpToolContinuation` must not read it as a
   * continuation step (a user-sourced message follows the tool result), and
   * `selectForwardPrompt` must pick the last user-sourced message.
   */
  function steerMessages(firstWords: string, words: string): GenerateMessage[] {
    return [
      { role: 'user', content: [{ type: 'text', text: firstWords }], source: { kind: 'user' } },
      { role: 'assistant', content: [{ type: 'tool-call', id: 'call_1', name: 'mock tool', arguments: '{}' }], source: { kind: 'model' } },
      { role: 'tool', content: [{ type: 'tool-result', text: 'tool result line' }], source: { kind: 'tool', callId: 'call_1' } },
      { role: 'user', content: [{ type: 'text', text: words }], source: { kind: 'user' } },
    ]
  }

  it('a chat steer cancels the running ACP turn and resends the words', async () => {
    const dshSessionId = 'dsh-steer-live'
    const session = await gateManager.getOrCreateDshSession(dshSessionId, 'gate')
    const since = gateEvents.length

    // Turn 1 stops at the mock's card boundary: the prose after the card ends
    // the driver's segment while the ACP prompt is still on air — the exact
    // window a host steer lands in.
    const first = await collectWith(dshSessionId, [
      { role: 'user', content: [{ type: 'text', text: 'STEERABLE first turn' }], source: { kind: 'user' } },
    ])
    expect(gateFinish(first)?.reason).toEqual({ kind: 'stop' })
    expect(promptLines()).toContain('STEERABLE first turn')

    // Turn 2 is the steer. The old prompt is still running, so the adapter
    // must cancel it, wait for the agent to settle, re-claim the slot and send
    // the words as the next prompt (not refuse with `turn_in_flight`).
    const second = await collectWith(dshSessionId, steerMessages('STEERABLE first turn', 'STEER WORDS'))
    expect(gateFinish(second)?.reason.kind).not.toBe('error')
    // The mock's stale-cancel window may answer the first send with
    // `cancelled` and the adapter resends it, so the log may name the words
    // twice — only that it reached the agent matters.
    expect(promptLines()).toContain('STEER WORDS')
    // The OLD turn was cancelled, not waited out or silently lost.
    await gateWaitFor('turn/end', since, event => event.sessionId === session.sessionId
      && event.stopReason === 'cancelled', 30_000)
    // ...and the resent prompt reached its own ending, so the next case starts
    // on a settled session.
    await gateWaitFor('turn/end', since, event => event.sessionId === session.sessionId
      && event.stopReason !== 'cancelled', 30_000)
  }, 30_000)

  it('a steer stopped while the old turn is winding down sends nothing', async () => {
    const dshSessionId = 'dsh-steer-aborted'
    const session = await gateManager.getOrCreateDshSession(dshSessionId, 'gate')
    const since = gateEvents.length

    const first = await collectWith(dshSessionId, [
      { role: 'user', content: [{ type: 'text', text: 'STEERABLE first turn' }], source: { kind: 'user' } },
    ])
    expect(gateFinish(first)?.reason).toEqual({ kind: 'stop' })
    const before = promptLines().length

    // A steer whose signal is already aborted: the reclaim still cancels the
    // old turn (the person said stop), but the new words must never be sent.
    const controller = new AbortController()
    controller.abort()
    const chunks = await collectWith(dshSessionId, steerMessages('STEERABLE first turn', 'STEER WORDS'), controller.signal)

    expect(gateFinish(chunks)?.reason.kind).toBe('aborted')
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(promptLines().slice(before)).toEqual([])
    // The interrupt's cancel DID go out: the old turn still ends cancelled.
    await gateWaitFor('turn/end', since, event => event.sessionId === session.sessionId
      && event.stopReason === 'cancelled', 30_000)
  }, 30_000)
})

/**
 * The two-tier dispatch silence rule, pinned directly (it is shared verbatim
 * by the idle clock's CodeBuddy + agy branches and the agy subagent poll).
 */
describe('dispatchWithinWindows (pure two-tier silence rule)', () => {
  function dispatch(lastActivityAt: number, open?: Map<string, number>): BackgroundDispatch {
    return { lastActivityAt, ...(open === undefined ? {} : { openWorkerToolCalls: open }) } as BackgroundDispatch
  }

  it('plain recency decides with exact <= boundaries', () => {
    expect(dispatchWithinWindows(dispatch(1_000), 500, 0, 1_500)).toBe(true)
    expect(dispatchWithinWindows(dispatch(1_000), 500, 0, 1_501)).toBe(false)
    expect(dispatchWithinWindows(dispatch(1_000), 0, 0, 1_000)).toBe(true)
    expect(dispatchWithinWindows(dispatch(1_000), 0, 0, 1_001)).toBe(false)
  })

  it('an open tool call outranks plain silence, with exact <= boundaries', () => {
    const open = new Map([['t1', 2_000]])
    // Silent for an hour, but the tool opened 10s ago inside a 60s ceiling.
    expect(dispatchWithinWindows(dispatch(0, open), 500, 60_000, 12_000)).toBe(true)
    expect(dispatchWithinWindows(dispatch(0, open), 500, 60_000, 62_000)).toBe(true)
    expect(dispatchWithinWindows(dispatch(0, open), 500, 60_000, 62_001)).toBe(false)
  })

  it('ceilingMs <= 0 means no ceiling: any open call proves life', () => {
    const open = new Map([['t1', 0]])
    expect(dispatchWithinWindows(dispatch(0, open), 500, 0, 10_000_000)).toBe(true)
    expect(dispatchWithinWindows(dispatch(0, open), 500, -1, 10_000_000)).toBe(true)
  })

  it('the NEWEST open call decides; all-open-past-ceiling falls back to recency', () => {
    // One call outlived the ceiling, a sibling opened later and is alive.
    const mixed = new Map([['old', 0], ['new', 9_000]])
    expect(dispatchWithinWindows(dispatch(0, mixed), 500, 5_000, 10_000)).toBe(true)
    // BOTH past the ceiling: plain recency decides again.
    const stale = new Map([['a', 0], ['b', 1_000]])
    expect(dispatchWithinWindows(dispatch(9_800, stale), 500, 5_000, 10_000)).toBe(true)
    expect(dispatchWithinWindows(dispatch(9_000, stale), 500, 5_000, 10_000)).toBe(false)
    // An empty open table is no open call at all.
    expect(dispatchWithinWindows(dispatch(0, new Map()), 500, 60_000, 10_000)).toBe(false)
  })
})

/**
 * The turn slot is ONE value object for the host prompt slot and the settle
 * gate, stamped with the `turnSeq` that owns it. Both boundaries clear it by
 * generation, so a superseded turn's late callback cannot reach the newer
 * turn on air.
 */
describe('the turn slot is generation-guarded (AgentBridge)', () => {
  function bareSession(): LiveSession {
    return {
      sessionId: 'slot-session-1',
      agentId: 'slot-fixture',
      acpSessionId: 'acp-slot-fixture',
      cwd: tmpdir(),
      running: false,
      turnSeq: 0,
      lifecycle: 'live',
      lastAgentActivityAt: Date.now(),
      activeToolCalls: new Set<string>(),
      transcript: new Transcript(64),
    }
  }

  it('a late settler from a superseded turn must not clear the newer turn\'s prompt slot or settle gate', () => {
    const bridge = new AgentBridge({ ...def, id: 'slot-guard' }, new EventHub(), 500, () => {})
    const session = bareSession()
    session.turnSeq = 1
    const settleFirst = bridge.beginTurn(session)
    // The first turn is aborted: the host slot goes, the settle gate stays.
    releasePromptSlot(session, 1)
    expect(hasPromptSlot(session)).toBe(false)
    expect(isSettling(session)).toBe(true)
    // A new turn claims BOTH; the old settler now lands late.
    session.turnSeq = 2
    const settleSecond = bridge.beginTurn(session)
    settleFirst()
    expect(hasPromptSlot(session)).toBe(true)
    expect(isSettling(session)).toBe(true)
    // The turn that actually owns the slot still releases it.
    settleSecond()
    expect(hasPromptSlot(session)).toBe(false)
    expect(isSettling(session)).toBe(false)
  })

  it('a settler from a turn whose generation moved on without a rebuilt slot must not clear the gate', () => {
    const bridge = new AgentBridge({ ...def, id: 'slot-seq-only' }, new EventHub(), 500, () => {})
    const session = bareSession()
    session.turnSeq = 1
    const settleFirst = bridge.beginTurn(session)
    // A turn start bumps `turnSeq` before it rebuilds the slot; while the old
    // slot is still the one in place, it belongs to the PAST generation. Its
    // settler must not open the gate the newer generation will inherit.
    session.turnSeq = 2
    settleFirst()
    expect(hasPromptSlot(session)).toBe(true)
    expect(isSettling(session)).toBe(true)
  })

  it('opening the settle gate for a superseded turnSeq must leave the newer turn\'s gate claimed', () => {
    const bridge = new AgentBridge({ ...def, id: 'slot-open-seq' }, new EventHub(), 500, () => {})
    const session = bareSession()
    session.turnSeq = 2
    const slot = bridge.beginTurn(session)
    openTurnSlot(session, 1)
    expect(session.turnSlot).toBeDefined()
    expect(hasPromptSlot(session)).toBe(true)
    expect(isSettling(session)).toBe(true)
    // The generation that actually owns the slot still opens it.
    openTurnSlot(session, 2)
    expect(hasPromptSlot(session)).toBe(false)
    expect(isSettling(session)).toBe(false)
    slot()
  })

  it('a park that races a close must not resurrect the destroyed session as resumable', async () => {
    const hub = new EventHub()
    const events: AcpEvent[] = []
    hub.subscribe(event => { events.push(event) })
    const bridge = new AgentBridge({ ...def, id: 'close-race' }, hub, 500, () => {})
    const session = bareSession()
    const seam = bridge as unknown as { sessions: Map<string, LiveSession> }
    seam.sessions.set(session.sessionId, session)
    await bridge.closeSession(session, 'closed')
    expect(session.lifecycle).toBe('closed')
    expect(bridge.hasSession(session.sessionId)).toBeUndefined()
    // `closeSession` marks the lifecycle BEFORE it awaits `session/close`, so a
    // park (idle release / archive) can arrive while the record is still
    // registered. It must skip a closed record: parking it would leave a
    // resumable entry, and the next resume would load a destroyed session.
    seam.sessions.set(session.sessionId, session)
    bridge.releaseAll('late park', 'idle')
    expect(bridge.hasReleased(session.sessionId)).toBeUndefined()
    expect(session.lifecycle).toBe('closed')
    expect(events.filter(event => event.type === 'session/released' && event.sessionId === session.sessionId)).toEqual([])
  })
})
