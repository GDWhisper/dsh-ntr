/**
 * End-to-end over a real child process: the scripted mock ACP agent driven by
 * the production BridgeManager + dispatchRpc (the same face the browser uses).
 */

import { fileURLToPath } from 'node:url'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { afterAll, describe, expect, it } from 'vitest'
import { AcpLlmAdapter, BridgeManager, classifyTestFailure, defaultAgentWorkspace, detectHostAgents, ensureAgentExecutable, findExecutable, pluginStateDir, routeBindingRegistry, type StartAttempt } from '../src/bridge.ts'
import { type AcpAgentDef, type AcpEvent, type AgentCatalogResult, type ChatSessionView, SESSION_TITLE_PREFIX, type StreamChunk } from '../src/protocol.ts'
import { ACP_TOOL_CALL_NAME, dispatchRpc, EventHub } from '../src/impl.ts'
import { OUTPUT_CHARS_PER_TOKEN } from '../src/tps.ts'
import { createBridgeHarness, def, hostLoopTurn, MOCK, settleTranscript } from './bridge/harness.ts'

const { hub, manager, events, waitFor } = createBridgeHarness()

afterAll(async () => {
  await manager.shutdownAll()
})

describe('ACP bridge over stdio (mock agent)', () => {
  it('spawns, initializes, creates a session, streams a full turn with a human permission answer', async () => {
    const start = await dispatchRpc(manager, 'session/start', { agentId: 'mock' })
    expect(start.ok).toBe(true)
    if (!start.ok) return
    const id = (start.value as { sessionId: string }).sessionId

    // The created session carries the negotiated modes from session/new.
    const created = events.find(event => event.type === 'session/created')
    expect(created).toBeDefined()

    const prompt = await dispatchRpc(manager, 'session/prompt', { sessionId: id, text: 'hello PERM world' })
    expect(prompt).toEqual({ ok: true, value: { accepted: true, turnId: expect.any(String) } })

    // A human permission request must surface and resolve through the ledger.
    const permission = await waitFor('permission/request', event => event.sessionId === id)
    expect(permission.options.map(o => o.kind)).toEqual(['allow_once', 'reject_once'])
    const responded = await dispatchRpc(manager, 'permission/respond', { requestId: permission.requestId, optionId: 'allow1' })
    expect(responded.ok).toBe(true)
    await waitFor('permission/resolved', event => event.requestId === permission.requestId)

    const end = await waitFor('turn/end', event => event.sessionId === id)
    expect(end.stopReason).toBe('end_turn')

    // Transcript replay returns the ordered raw updates the browser folds.
    const transcript = await dispatchRpc(manager, 'transcript/get', { sessionId: id })
    expect(transcript.ok).toBe(true)
    if (!transcript.ok) return
    const entries = (transcript.value as { entries: Array<{ update: Record<string, unknown> }> }).entries
    const kinds = entries.map(e => String(e.update.sessionUpdate))
    expect(kinds).toContain('agent_thought_chunk')
    expect(kinds).toContain('plan')
    expect(kinds).toContain('available_commands_update')
    expect(kinds.filter(k => k === 'tool_call' || k === 'tool_call_update')).toHaveLength(3)
    const chunks = entries.filter(e => e.update.sessionUpdate === 'agent_message_chunk')
    expect(chunks.length).toBe(2)
    const text = chunks.map(c => String((c.update.content as { text: string }).text)).join('')
    expect(text).toBe('MOCK: echo hello PERM world perm=allow1')

    // Session snapshot absorbed the derived updates.
    const sessions = await dispatchRpc(manager, 'sessions/list', {})
    if (!sessions.ok) throw new Error('sessions/list failed')
    const view = (sessions.value as { sessions: Array<Record<string, unknown> & { sessionId: string }> }).sessions.find(s => s.sessionId === id)
    expect(view?.usage).toMatchObject({ used: 123, size: 1000 })
    expect(view?.availableCommands).toEqual([{ name: 'greet', description: 'say hi' }])
  }, 30_000)

  it('blocks a second prompt while a turn is in flight and closes sessions idempotently', async () => {
    const start = await dispatchRpc(manager, 'session/start', { agentId: 'mock' })
    if (!start.ok) throw new Error('start failed')
    const id = (start.value as { sessionId: string }).sessionId
    await dispatchRpc(manager, 'session/prompt', { sessionId: id, text: 'PERM hold' })
    const permission = await waitFor('permission/request', event => event.sessionId === id)
    const busy = await dispatchRpc(manager, 'session/prompt', { sessionId: id, text: 'second' })
    expect(busy).toMatchObject({ ok: false, error: { code: 'turn_in_flight' } })
    await dispatchRpc(manager, 'permission/respond', { requestId: permission.requestId, optionId: 'reject1' })
    await waitFor('turn/end', event => event.sessionId === id && event.stopReason !== undefined)
    await dispatchRpc(manager, 'session/close', { sessionId: id })
    const again = await dispatchRpc(manager, 'session/close', { sessionId: id })
    expect(again).toMatchObject({ ok: false, error: { code: 'unknown_session' } })
  }, 30_000)

  it('cancels a slow turn and reports the cancelled stop reason', async () => {
    const start = await dispatchRpc(manager, 'session/start', { agentId: 'mock' })
    if (!start.ok) throw new Error('start failed')
    const id = (start.value as { sessionId: string }).sessionId
    await dispatchRpc(manager, 'session/prompt', { sessionId: id, text: 'SLOW please' })
    await new Promise(resolve => setTimeout(resolve, 300))
    await dispatchRpc(manager, 'session/cancel', { sessionId: id })
    const end = await waitFor('turn/end', event => event.sessionId === id)
    expect(end.stopReason).toBe('cancelled')
  }, 30_000)

  it('answers a pending permission with cancelled when the turn is cancelled', async () => {
    // The ACP spec's other half of `session/cancel`: a client that cancels MUST
    // answer every pending `session/request_permission` with `cancelled`. Without
    // it the agent's tool call stays blocked on an answer that can no longer
    // arrive, and the ledger keeps a card for a turn that is already over
    // (OmniTerm: `PermissionManager::cancel_all`, called from `AcpClient::cancel`).
    const start = await dispatchRpc(manager, 'session/start', { agentId: 'mock' })
    if (!start.ok) throw new Error('start failed')
    const id = (start.value as { sessionId: string }).sessionId
    const since = events.length
    await dispatchRpc(manager, 'session/prompt', { sessionId: id, text: 'hello PERM cancel me' })
    const permission = await waitFor('permission/request', event => event.sessionId === id && events.indexOf(event) >= since)
    expect(permission.options.map(o => o.kind)).toEqual(['allow_once', 'reject_once'])

    await dispatchRpc(manager, 'session/cancel', { sessionId: id })
    const resolved = await waitFor('permission/resolved', event => event.requestId === permission.requestId && events.indexOf(event) >= since)
    expect(resolved.outcome).toEqual({ outcome: 'cancelled' })
    // The ask is gone from the ledger: answering it now is an error, not a
    // second chance.
    const late = await dispatchRpc(manager, 'permission/respond', { requestId: permission.requestId, optionId: 'allow1' })
    expect(late).toMatchObject({ ok: false, error: { code: 'unknown_request' } })
    // And the agent was NOT left blocked on our answer: it received `cancelled`
    // and finished the turn on its own.
    await waitFor('turn/end', event => event.sessionId === id && events.indexOf(event) >= since)
    const transcript = await dispatchRpc(manager, 'transcript/get', { sessionId: id })
    expect(transcript.ok).toBe(true)
    if (!transcript.ok) return
    const echo = (transcript.value as { entries: Array<{ update: Record<string, unknown> }> }).entries
      .filter(e => e.update.sessionUpdate === 'agent_message_chunk')
      .map(e => String((e.update.content as { text?: string }).text ?? ''))
      .join('')
    expect(echo).toContain('perm=cancelled')
  }, 30_000)

  it('enforces the cwd allow-list before touching the agent', async () => {
    // An existing directory outside the allow-list: /etc on POSIX, C:\Windows on Windows.
    const escapeCwd = process.platform === 'win32' ? 'C:\\Windows' : '/etc'
    const escape = await dispatchRpc(manager, 'session/start', { agentId: 'mock', cwd: escapeCwd })
    expect(escape).toMatchObject({ ok: false, error: { code: 'cwd_denied' } })
    const missing = await dispatchRpc(manager, 'session/start', { agentId: 'mock', cwd: '/definitely/not/here' })
    expect(missing).toMatchObject({ ok: false, error: { code: 'bad_cwd' } })
  })

  it('rejects unknown agents and settles permissions when a session closes', async () => {
    const unknown = await dispatchRpc(manager, 'session/start', { agentId: 'ghost' })
    expect(unknown).toMatchObject({ ok: false, error: { code: 'unknown_agent' } })

    const start = await dispatchRpc(manager, 'session/start', { agentId: 'mock' })
    if (!start.ok) throw new Error('start failed')
    const id = (start.value as { sessionId: string }).sessionId
    await dispatchRpc(manager, 'session/prompt', { sessionId: id, text: 'PERM now' })
    const permission = await waitFor('permission/request', event => event.sessionId === id)
    await dispatchRpc(manager, 'session/close', { sessionId: id })
    const resolved = await waitFor('permission/resolved', event => event.requestId === permission.requestId)
    expect(resolved.outcome).toEqual({ outcome: 'cancelled' })
    // The turn must not hang forever either: prompt settles (agent answered the
    // parked permission request with cancelled).
    const end = await waitFor('turn/end', event => event.sessionId === id)
    expect(end.stopReason !== undefined || end.error !== undefined).toBe(true)
  }, 30_000)

  it('surfaces modes switching through current_mode_update', async () => {
    const start = await dispatchRpc(manager, 'session/start', { agentId: 'mock' })
    if (!start.ok) throw new Error('start failed')
    const id = (start.value as { sessionId: string }).sessionId
    const before = events.length
    void before
    await dispatchRpc(manager, 'session/mode-set', { sessionId: id, modeId: 'strict' })
    const update = await waitFor('session/update', event =>
      event.sessionId === id && (event.update as { sessionUpdate?: string }).sessionUpdate === 'current_mode_update')
    expect((update.update as { currentModeId: string }).currentModeId).toBe('strict')
    const sessions = await dispatchRpc(manager, 'sessions/list', {})
    if (!sessions.ok) throw new Error('sessions/list failed')
    const view = (sessions.value as { sessions: Array<{ sessionId: string; modes?: { currentModeId?: string } }> }).sessions.find(s => s.sessionId === id)
    expect(view?.modes?.currentModeId).toBe('strict')

    // config-set must flow back through the authoritative response even for
    // agents that never push config_option_update.
    const cfg = await dispatchRpc(manager, 'session/config-set', { sessionId: id, configId: 'temp', value: 'high' })
    expect(cfg.ok).toBe(true)
    const meta = await waitFor('session/meta', event =>
      event.sessionId === id && (event.session as unknown as { configOptions?: Array<{ configId: string; currentValue: string }> }).configOptions?.some(o => o.configId === 'temp' && o.currentValue === 'high') === true)
    const temp = ((meta.session as unknown as { configOptions: Array<{ configId: string; currentValue: string }> }).configOptions).find(o => o.configId === 'temp')
    expect(temp?.currentValue).toBe('high')
    await dispatchRpc(manager, 'session/close', { sessionId: id })
  }, 30_000)

  it('implements LlmAdapter: discovers models and streams a full turn over native chat chunks', async () => {
    const adapter = new AcpLlmAdapter(manager)
    expect(adapter.providerInfo('acp')).toEqual({ id: 'acp', name: 'ACP' })

    // The route advertises NO models. That is the isolation guarantee: DSH
    // builds one global provider catalog with no per-session seam, so anything
    // listed here would be offered in every conversation — including the ones
    // where no ACP agent is behind the route at all.
    expect(await adapter.listModels('acp')).toEqual([])

    // The agent's own surface is the plugin's `agent/catalog`. Narrowing is a
    // lightweight RPC (no restart); unset is the DEFAULT-OPEN state, so every
    // model the agent publishes is offered once the filter is reset.
    expect(await dispatchRpc(manager, 'agent/set-exposed-models', { agentId: 'mock', exposedModels: ['mock-model-a'] }))
      .toEqual({ ok: true, value: { done: true } })
    const exposed = await dispatchRpc(manager, 'agent/catalog', { agentId: 'mock' })
    if (!exposed.ok) throw new Error('agent/catalog failed')
    const seat = exposed.value as AgentCatalogResult
    expect(seat).toMatchObject({ agentId: 'mock', title: 'Mock', probed: true })
    // `base` names the bare route AND the model it currently resolves to, so the
    // checked row in the picker says which model is running (user report,
    // 2026-10-18). Mock is on `mock-model-a`.
    expect(seat.base).toMatchObject({ id: 'mock', name: 'Mock · Mock Model A' })
    expect(seat.variants.map(variant => variant.id)).toEqual(['mock@mock-model-a'])
    expect(await dispatchRpc(manager, 'agent/set-exposed-models', { agentId: 'mock' })).toEqual({ ok: true, value: { done: true } })
    const reopened = await dispatchRpc(manager, 'agent/catalog', { agentId: 'mock' })
    if (!reopened.ok) throw new Error('agent/catalog failed')
    expect((reopened.value as AgentCatalogResult).variants.map(variant => variant.id)).toEqual(['mock@mock-model-a', 'mock@mock-model-b'])

    const resolved = await adapter.resolveModel('acp', 'mock')
    expect(resolved).toEqual(expect.objectContaining({ provider: 'acp', id: 'mock', name: 'Mock' }))

    const { chunks, steps } = await hostLoopTurn(adapter, {
      provider: 'acp',
      model: 'mock',
      sessionId: 'dsh-native-test-1',
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'hello from native chat' }] },
      ],
    })

    // The turn is SEGMENTED into host steps (docs/acp-convergence.md §1.7):
    // the mock's turn is thought → plan → tool card → answer, so step 1
    // carries the prose and the CARD, and the loop's continuation step
    // (staged tool results) streams the ANSWER as its own tool-free message —
    // the card sits between two assistant messages, like a native turn.
    expect(steps.length).toBe(2)
    const [first, second] = steps
    const firstText = first
      .filter((c): c is Extract<StreamChunk, { type: 'text-delta' }> => c.type === 'text-delta')
      .map(c => c.text).join('')
    // Step 1: the plan is announced inline (one line per kind) and the tool
    // becomes a real `tool-call` block the host loop can execute as a card.
    expect(firstText).toContain('[in_progress]')
    expect(firstText).not.toContain('MOCK: echo')
    expect(first.some(c => c.type === 'tool-call-delta')).toBe(true)
    expect(first.find(c => c.type === 'block-start' && (c as { blockType: string }).blockType === 'tool-call')).toBeDefined()
    // The card is the LAST block of step 1: the cutting event (the answer's
    // first chunk) belongs to the next message.
    const firstStarts = first.filter(c => c.type === 'block-start').map(c => (c as { blockType: string }).blockType)
    expect(firstStarts.at(-1)).toBe('tool-call')

    // Step 2 (the continuation): the agent's answer, and NO card — the turn
    // ends here, so the loop sees a tool-free settled message and completes.
    const secondText = second
      .filter((c): c is Extract<StreamChunk, { type: 'text-delta' }> => c.type === 'text-delta')
      .map(c => c.text).join('')
    expect(secondText).toContain('MOCK: echo hello from native chat perm=none')
    expect(second.some(c => c.type === 'tool-call-delta')).toBe(false)
    expect(second.find(c => c.type === 'finish')?.reason).toEqual({ kind: 'stop' })

    const types = chunks.map(c => c.type)
    expect(types).toContain('block-start')
    expect(types).toContain('reasoning-delta')
    expect(types).toContain('block-end')
    expect(types).toContain('usage')
    expect(types).toContain('finish')

    // Reasoning block: the agent's own thoughts and NOTHING else.
    const reasoningDeltas = chunks.filter((c): c is Extract<StreamChunk, { type: 'reasoning-delta' }> => c.type === 'reasoning-delta')
    const thoughtText = reasoningDeltas.map(c => c.text).join('')
    expect(thoughtText).toContain('thinking…')
    expect(thoughtText).not.toContain('mock tool')

    // Usage is a per-segment OUTPUT estimate, never the ACP `usage_update` pair:
    // `used` / `size` are context occupancy, and mapping them onto request
    // tokens produced impossible totals and tok/s (issue #6). `inputTokens: 0`
    // also hides the host's cache-hit pill instead of reporting a false 0%.
    const usages = chunks.filter((c): c is Extract<StreamChunk, { type: 'usage' }> => c.type === 'usage')
    expect(usages).toHaveLength(2)
    expect(usages.every(c => c.usage.inputTokens === 0)).toBe(true)
    const firstStepUsage = first.find((c): c is Extract<StreamChunk, { type: 'usage' }> => c.type === 'usage')
    const secondStepUsage = second.find((c): c is Extract<StreamChunk, { type: 'usage' }> => c.type === 'usage')
    expect(firstStepUsage?.usage).toEqual({ inputTokens: 0, outputTokens: Math.round('thinking…'.length / 4) })
    expect(secondStepUsage?.usage).toEqual({ inputTokens: 0, outputTokens: Math.round(secondText.length / 4) })

    const finish = chunks.find((c): c is Extract<StreamChunk, { type: 'finish' }> => c.type === 'finish')
    expect(finish?.reason).toEqual({ kind: 'stop' })

    // A staged batch whose call ids the bridge never saw is NOT one of our
    // continuation steps: it carries no user input and must not be forwarded
    // to the agent (re-sending the person's last words). It answers with one
    // closing message instead of an `empty_prompt` error — the loop expects a
    // stream, and the message tells the user where the details went.
    const continued: StreamChunk[] = []
    for await (const chunk of adapter.stream({
      provider: 'acp',
      model: 'mock',
      sessionId: 'dsh-native-test-1',
      messages: [
        { role: 'tool', source: { kind: 'tool', callId: 'foreign_call' }, content: [{ type: 'text', text: 'tool result line' }] },
      ],
    })) {
      continued.push(chunk)
    }
    expect(continued.some(c => c.type === 'text-delta')).toBe(true)
    expect(continued.find((c): c is Extract<StreamChunk, { type: 'finish' }> => c.type === 'finish')?.reason)
      .toEqual({ kind: 'stop' })
  }, 30_000)

  it('reports a burst rate that excludes the tool wait and serves it from chat-list', async () => {
    const adapter = new AcpLlmAdapter(manager)
    const dshSessionId = 'dsh-metrics-paced'
    await hostLoopTurn(adapter, {
      provider: 'acp',
      model: 'mock',
      sessionId: dshSessionId,
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'PACED metrics' }] },
      ],
    })
    const final = await waitFor('turn/metrics', event =>
      event.final && event.dshSessionId === dshSessionId && event.outputTokens > 0)
    // The mock sleeps 1.2s after the tool completes and then emits two answer
    // chunks 100ms apart. The tool wait is outside the burst (a tool update
    // breaks it AND the gap is >1s); only the within-answer gap counts.
    expect(final.burstMs).toBeGreaterThan(0)
    expect(final.burstMs).toBeLessThan(1000)
    // The running turn pushed live aggregates (final:false) on the same turn,
    // so the dock moves before settle; the final frame is the same turn's.
    const live = events.filter((event): event is Extract<AcpEvent, { type: 'turn/metrics' }> =>
      event.type === 'turn/metrics' && event.dshSessionId === dshSessionId && !event.final)
    expect(live.length).toBeGreaterThan(0)
    expect(live.every(event => event.turnId === final.turnId)).toBe(true)
    // Replay must not double-count, and anchor chunks contribute no untimed tokens.
    await settleTranscript(manager, final.sessionId)
    const transcript = await dispatchRpc(manager, 'transcript/get', { sessionId: final.sessionId })
    if (!transcript.ok) throw new Error('transcript/get failed')
    const proseChunks = (transcript.value as { entries: Array<{ update: Record<string, unknown> }> }).entries
      .filter(entry => entry.update.sessionUpdate === 'agent_message_chunk' || entry.update.sessionUpdate === 'agent_thought_chunk')
      .map(entry => String((entry.update.content as { text?: string }).text ?? ''))
    expect(final.outputTokens).toBe(Math.round((proseChunks.at(-1) ?? '').length / OUTPUT_CHARS_PER_TOKEN))
    expect(final.outputTokens).toBeLessThan(Math.round(proseChunks.join('').length / OUTPUT_CHARS_PER_TOKEN))
    const listed = await dispatchRpc(manager, 'session/chat-list', { dshSessionId })
    if (!listed.ok) throw new Error('session/chat-list failed')
    const row = (listed.value as { sessions: ChatSessionView[] }).sessions
      .find(session => session.sessionId === final.sessionId)
    expect(row?.burst).toEqual({ outputTokens: final.outputTokens, burstMs: final.burstMs })
  }, 30_000)

  it('settles a running card block before the agent speaks again', async () => {
    const adapter = new AcpLlmAdapter(manager)
    const startedAt = Date.now()
    const frames: Array<{ at: number; chunk: StreamChunk }> = []
    for await (const chunk of adapter.stream({
      provider: 'acp',
      model: 'mock',
      sessionId: 'dsh-card-settle',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'PACED settle the card' }] }],
    })) {
      frames.push({ at: Date.now() - startedAt, chunk })
    }
    const cardEnd = frames.find(({ chunk }) => chunk.type === 'block-end'
      && (chunk.block as { type?: string }).type === 'tool-call')
    // The mock holds its answer 1.2s after the tool call; that answer is the
    // cutting event, so the first stream ends there and the answer itself
    // belongs to the continuation step.
    const finish = frames.at(-1)
    expect(cardEnd).toBeDefined()
    expect(finish?.chunk.type).toBe('finish')
    // The card's block settles on its own quiet window, well before the cut:
    // that is what lets the live row show the real command while the agent is
    // STILL running the tool.
    expect(finish?.at ?? 0).toBeGreaterThan((cardEnd?.at ?? 0) + 300)
    // The settled body carries the agent's own title, not an empty argument
    // area: it is the command the live row renders during the run.
    if (cardEnd?.chunk.type !== 'block-end') return
    expect((cardEnd.chunk.block as { arguments?: string }).arguments).toContain('mock tool')
    const acpId = manager.chatTranscripts('dsh-card-settle')[0]?.session.sessionId
    if (acpId !== undefined) await dispatchRpc(manager, 'session/close', { sessionId: acpId })
  }, 30_000)

  it('replaces an early-settled card with a late restatement at segment close', async () => {
    const adapter = new AcpLlmAdapter(manager)
    const startedAt = Date.now()
    const frames: Array<{ at: number; chunk: StreamChunk }> = []
    for await (const chunk of adapter.stream({
      provider: 'acp',
      model: 'mock',
      sessionId: 'dsh-card-restate',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'LATECARD restate the card' }] }],
    })) {
      frames.push({ at: Date.now() - startedAt, chunk })
    }
    const cardEnds = frames.filter(({ chunk }) => chunk.type === 'block-end'
      && (chunk.block as { type?: string }).type === 'tool-call')
    // The quiet window settles the announced title; the segment's own close
    // restates the card whole with the input disclosed later.
    expect(cardEnds).toHaveLength(2)
    const first = (cardEnds[0]?.chunk.block as { arguments?: string } | undefined)?.arguments ?? ''
    const last = (cardEnds[1]?.chunk.block as { arguments?: string } | undefined)?.arguments ?? ''
    expect(first).toContain('mock tool')
    expect(first).not.toContain('git push')
    expect(last).toContain('git push origin main --tags')
    // A sealed host view takes no further fragment: the late text must NOT
    // ride in as a delta after the early settle.
    const settledAt = cardEnds[0]?.at ?? 0
    const lateDeltas = frames.filter(({ chunk, at }) => chunk.type === 'tool-call-delta'
      && chunk.argumentsDelta !== '' && at > settledAt)
    expect(lateDeltas).toHaveLength(0)
    const acpId = manager.chatTranscripts('dsh-card-restate')[0]?.session.sessionId
    if (acpId !== undefined) await dispatchRpc(manager, 'session/close', { sessionId: acpId })
  }, 30_000)

  it('persists the burst aggregate across a host restart', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-ntr-burst-'))
    const storage = join(root, 'agents.json')
    const dshSessionId = 'dsh-burst-restart'
    const first = new BridgeManager([def], new EventHub(), 500, storage)
    let expected: ChatSessionView['burst']
    try {
      await hostLoopTurn(new AcpLlmAdapter(first), {
        provider: 'acp',
        model: 'mock',
        sessionId: dshSessionId,
        messages: [{ role: 'user', content: [{ type: 'text', text: 'PACED restart' }] }],
      })
      for (let attempt = 0; attempt < 200 && expected === undefined; attempt += 1) {
        const listed = await dispatchRpc(first, 'session/chat-list', { dshSessionId })
        if (!listed.ok) throw new Error('session/chat-list failed')
        expected = (listed.value as { sessions: ChatSessionView[] }).sessions.find(session => session.burst !== undefined)?.burst
        if (expected === undefined) await new Promise(resolve => setTimeout(resolve, 25))
      }
      expect(expected?.burstMs).toBeGreaterThan(0)
      await first.shutdownAll()
      const second = new BridgeManager([def], new EventHub(), 500, storage)
      try {
        const listed = await dispatchRpc(second, 'session/chat-list', { dshSessionId })
        if (!listed.ok) throw new Error('session/chat-list after restart failed')
        const restored = (listed.value as { sessions: ChatSessionView[] }).sessions.find(session => session.burst !== undefined)
        expect(restored?.burst).toEqual(expected)
        expect(restored?.released).toBe(true)
      } finally {
        await second.shutdownAll()
      }
    } finally {
      await first.shutdownAll()
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    }
  }, 30_000)

  it('gives every call exactly one card across restatements, interleaving and segments', async () => {
    // The oml session bug's other half: the agent restates a call in whole on
    // every progress tick, and with parallel calls the restatements interleave
    // (t1, t2, t1…). A call gets ONE card per turn wherever its restatements
    // land; the restatement only refreshes the shared output record.
    const adapter = new AcpLlmAdapter(manager)
    const { chunks, steps } = await hostLoopTurn(adapter, {
      provider: 'acp',
      model: 'mock',
      sessionId: 'dsh-native-test-2',
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'TWOTOOLS please' }] },
      ],
    })

    // t1 and t2 announced, t1 restated four times total: exactly one card per
    // call id across the whole turn.
    const callIds = chunks.filter(c => c.type === 'tool-call-delta').map(c => (c as { id: string }).id)
    expect(callIds.filter(id => id === 't1')).toHaveLength(1)
    expect(callIds.filter(id => id === 't2')).toHaveLength(1)

    // The t1 restatement REWROTE its input (`{"cmd":""}` → `{"cmd":"ls -la"}`)
    // — a replacement, not a prefix extension, so no concatenating delta can
    // express it: the snapshot moves and the closing `block-end` replaces the
    // block wholesale. The args are a JSON object (`description` + `input`) the
    // host preparing row reads; the t2 input arrives serialized from its object.
    const t1Deltas = chunks
      .filter((c): c is Extract<StreamChunk, { type: 'tool-call-delta' }> => c.type === 'tool-call-delta' && (c as { id: string }).id === 't1')
      .map(c => c.argumentsDelta).join('')
    expect(t1Deltas).toBe('{"description":"first tool","input":{"cmd":""}}')
    const t1Card = chunks.find((c): c is Extract<StreamChunk, { type: 'block-end' }> =>
      c.type === 'block-end' && (c.block as { type?: string; id?: string }).type === 'tool-call' && (c.block as { id?: string }).id === 't1')
    expect((t1Card?.block as { arguments?: string } | undefined)?.arguments).toBe('{"description":"first tool","input":{"cmd":"ls -la"}}')
    const t2Args = chunks
      .filter((c): c is Extract<StreamChunk, { type: 'tool-call-delta' }> => c.type === 'tool-call-delta' && (c as { id: string }).id === 't2')
      .map(c => c.argumentsDelta).join('')
    expect(t2Args).toBe('{"description":"second tool","input":{"path":"a.md"}}')

    // …and the answer is still there, in the continuation step after the
    // cards' step.
    const lastText = (steps.at(-1) ?? [])
      .filter((c): c is Extract<StreamChunk, { type: 'text-delta' }> => c.type === 'text-delta')
      .map(c => c.text).join('')
    expect(lastText).toContain('MOCK: echo TWOTOOLS please perm=none')
    // The tool's real output reached the shared registry (the guard's virtual
    // tool answers the host loop's card execution from it).
    expect(routeBindingRegistry().toolResults.get('t1')).toContain('T1 OUTPUT LINE')
  }, 30_000)

  it('normalizes a long pwsh command title to the constant name and keeps the command in args', async () => {
    // Env-gated, DEFAULT-OFF mock knob (MOCK_LONG_TOOL_TITLE=1): the agent puts
    // a whole pwsh command in `title` and rewrites it mid-call. Its OWN
    // EventHub / BridgeManager + a distinct call id keep this isolated from the
    // shared manager and from every byte-exact echo assertion.
    const longHub = new EventHub()
    const longDef: AcpAgentDef = { ...def, env: { ...def.env, MOCK_LONG_TOOL_TITLE: '1' } }
    const longManager = new BridgeManager([longDef], longHub, 500)
    try {
      const adapter = new AcpLlmAdapter(longManager)
      const { chunks } = await hostLoopTurn(adapter, {
        provider: 'acp',
        model: 'mock',
        sessionId: 'dsh-long-title-1',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'LONG TITLE TURN' }] }],
      })
      const deltas = chunks.filter((c): c is Extract<StreamChunk, { type: 'tool-call-delta' }> => c.type === 'tool-call-delta')
      const names = deltas
        .map(c => (c as { name?: string }).name)
        .filter((n): n is string => n !== undefined)
      expect(names.length).toBeGreaterThan(0)
      // Every name is the constant; the raw pwsh command never becomes a name,
      // not even on the mid-call title rewrite.
      expect(names).toContain(ACP_TOOL_CALL_NAME)
      expect(names.every(n => n === ACP_TOOL_CALL_NAME)).toBe(true)
      // The full command survives in the arguments/argsRaw payload (no silent
      // drop), including across the rewrite.
      expect(deltas.map(c => c.argumentsDelta).join('')).toContain('MOCK_LONG_TITLE_MARKER')
      const card = chunks.find((c): c is Extract<StreamChunk, { type: 'block-end' }> =>
        c.type === 'block-end' && (c.block as { type?: string }).type === 'tool-call')
      expect((card?.block as { arguments?: string } | undefined)?.arguments).toContain('MOCK_LONG_TITLE_MARKER')
      // noteToolRecord / recordAcpToolOutput key the REAL output by callId.
      expect(routeBindingRegistry().toolResults.get('long_title_call')).toContain('tool result line')
      // The knob leaves the byte-exact echo untouched.
      const answer = chunks
        .filter((c): c is Extract<StreamChunk, { type: 'text-delta' }> => c.type === 'text-delta')
        .map(c => c.text).join('')
      expect(answer).toContain('MOCK: echo LONG TITLE TURN perm=none')
    } finally {
      await longManager.shutdownAll()
      routeBindingRegistry().toolResults.delete('long_title_call')
      routeBindingRegistry().toolOutputFinal.delete('long_title_call')
    }
  }, 30_000)

  it('reports the ACP-mode preset from the harness roster it is wired to', async () => {
    // No roster reader wired (a host without `agentPresets`): no verdict, which
    // the panel renders as "no block" rather than "the preset is gone".
    expect(await manager.presetStatus()).toBeUndefined()

    manager.setPresetRosterReader(async () => [{ id: 'standard' }])
    expect(await manager.presetStatus()).toMatchObject({ id: 'acp', installed: false })

    manager.setPresetRosterReader(async () => [{ id: 'acp' }, { id: 'standard' }])
    expect(await manager.presetStatus()).toEqual({
      id: 'acp',
      source: 'dsh-ntr/presets/acp/acp.patch.yml',
      installed: true,
    })

    manager.setPresetRosterReader(async () => [{ id: 'acp', broken: 'persona: invalid config' }])
    expect(await manager.presetStatus()).toMatchObject({ installed: false, problem: 'persona: invalid config' })

    // A roster read that throws is not a verdict about the preset either.
    manager.setPresetRosterReader(async () => { throw new Error('registry down') })
    expect(await manager.presetStatus()).toBeUndefined()
    manager.setPresetRosterReader(undefined)
  })

  it('ships the ACP-mode preset as its own bundle patch, resolvable from the profile', () => {
    // The preset is a DECLARATION this package carries: the harness composes the
    // `preset-<id>` roster row from `dsh.bundle.patch`, so the plugin must ship
    // both the patch and every file the declaration names. A declaration whose
    // plugin row cannot be resolved fails activation and the mode silently
    // disappears from the picker — which is exactly what this pins.
    const root = fileURLToPath(new URL('..', import.meta.url))
    const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8')) as {
      exports: Record<string, string>
      dsh: { bundle: { patch: string | string[] }, client: unknown }
      files: string[]
    }
    const patches = Array.isArray(manifest.dsh.bundle.patch) ? manifest.dsh.bundle.patch : [manifest.dsh.bundle.patch]
    expect(patches).toContain('./presets/acp/acp.patch.yml')
    expect(manifest.files).toContain('presets')

    const declaration = readFileSync(join(root, 'presets/acp/acp.patch.yml'), 'utf-8')
    expect(declaration).toMatch(/^[ \t]+id: acp$/m)
    // The guard is named through the package's exports map: a preset
    // declaration resolves its plugin names against the PROFILE's resolution
    // base, never against the patch file that inserted the row, so a relative
    // `./acp-guard.mjs` would resolve to a file that is not there.
    const guardSpecifier = /name: (dsh-ntr\/acp-guard)/.exec(declaration)?.[1]
    expect(guardSpecifier).toBe('dsh-ntr/acp-guard')
    const guardTarget = manifest.exports['./acp-guard']
    expect(guardTarget).toBe('./presets/acp/acp-guard.mjs')
    expect(existsSync(join(root, guardTarget.replace(/^\.\//, '')))).toBe(true)
  })

  it('ships the locale dictionaries the plugin card resolves through', () => {
    // DSH resolves `<package>/locale/en.json` through the package's exports map
    // and treats the file's directory as the whole dictionary set; the English
    // entry doubles as the fallback, so it must stay identical to the manifest.
    const root = fileURLToPath(new URL('..', import.meta.url))
    const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8')) as {
      description: string
      exports: Record<string, string>
      files: string[]
    }
    expect(manifest.exports['./locale/*.json']).toBe('./locale/*.json')
    expect(manifest.files).toContain('locale')

    const descriptionOf = (lang: string): string | undefined => {
      const dict = JSON.parse(readFileSync(join(root, 'locale', `${lang}.json`), 'utf-8')) as {
        meta?: { description?: string }
      }
      return dict.meta?.description
    }
    expect(descriptionOf('en')).toBe(manifest.description)
    expect(descriptionOf('zh')).toBeTruthy()
    expect(descriptionOf('zh')).not.toBe(descriptionOf('en'))
  })

  it('ships a persona row the persona row schema accepts', () => {
    // The row's schema is `prefix: string` (required) + `suffix?: string` + the
    // two flags. A stale key (`text` used to be the persona prose key) makes the
    // preset unloadable at session creation — `invalid config: $.prefix missing
    // required value` — and the error only surfaces when a session actually
    // switches to this preset, so pin the field names here.
    // Git checks the patch file out with CRLF on Windows; the row regex anchors on \n.
    const composition = readFileSync(fileURLToPath(new URL('../presets/acp/acp.patch.yml', import.meta.url)), 'utf-8').replaceAll('\r\n', '\n')
    const personaRow = /- id: persona\n[\s\S]*?(?=\n\s*- id: |\s*$)/.exec(composition)?.[0]
    expect(personaRow, 'the preset must carry a persona row').toBeTruthy()
    expect(personaRow).toMatch(/^[ \t]+prefix:/m)
    expect(personaRow).toMatch(/^[ \t]+complete: true$/m)
    expect(personaRow).toMatch(/^[ \t]+includeRuntimeContext: false$/m)
    expect(personaRow).not.toMatch(/^[ \t]+text:/m)
  })

  it('forwards only the user message past harness-injected context, and refuses auxiliary calls', async () => {
    const adapter = new AcpLlmAdapter(manager)
    const sessionId = 'dsh-injected-context-test'

    // The host appends its context sections AFTER the claimed user batch
    // (dsh-agent-instructions folds its digest there, the driver appends the
    // runtime snapshot last), so "the last user-role message" is an injection.
    // The turn runs to its continuation steps (the mock's card cuts the first
    // segment; the loop's staged batch resumes it for the answer).
    const { chunks } = await hostLoopTurn(adapter, {
      provider: 'acp',
      model: 'mock',
      sessionId,
      messages: [
        { role: 'user', id: 'u1', source: { kind: 'user' }, content: [{ type: 'text', text: 'hello from the person' }] },
        { role: 'user', id: 'i1', source: { kind: 'agent-instructions' }, content: [{ type: 'text', text: '<system-reminder>The following workspace instructions…' }] },
        { role: 'user', id: 'i2', source: { kind: 'plugin', plugin: '@deepseek-ai/dsh-system-prompt', form: 'snapshot' }, content: [{ type: 'text', text: 'Current runtime context.\n\nCurrent DSH file policy: workspace-write.' }] },
        { role: 'user', id: 'i3', source: { kind: 'skill-catalog' }, content: [{ type: 'text', text: '<available_skills>…' }] },
      ],
    })
    const answer = chunks
      .filter((c): c is Extract<StreamChunk, { type: 'text-delta' }> => c.type === 'text-delta')
      .map(c => c.text).join('')
    expect(answer).toContain('MOCK: echo hello from the person perm=none')
    // …and the injected sections never reached the agent: its echo carries the
    // person's words and nothing the harness appended behind them.
    expect(answer).not.toContain('workspace instructions')
    expect(answer).not.toContain('Current runtime context')

    // The turn above retired its controller (its last step carried no card),
    // so a staged batch naming one of its calls is not a continuation of
    // anything in flight: it gets the closing message, never a forward.
    const continued: StreamChunk[] = []
    for await (const chunk of adapter.stream({
      provider: 'acp',
      model: 'mock',
      sessionId,
      messages: [
        { role: 'tool', source: { kind: 'tool', callId: 'call_1' }, content: [{ type: 'text', text: 'tool result line' }] },
      ],
    })) {
      continued.push(chunk)
    }
    expect(continued
      .filter((c): c is Extract<StreamChunk, { type: 'text-delta' }> => c.type === 'text-delta')
      .map(c => c.text).join('')).toContain('no in-flight ACP turn to resume')

    // A session-title call rides the same logged route. The host's
    // `dsh-session-title-llm` prompt embeds the session's human messages as a
    // JSON array, and the adapter answers it LOCALLY with a placeholder title
    // (the first human message) — never an ACP turn, which would spend a
    // remote turn on a title or fold a harness prompt into the agent's own
    // context (issue #11: the sidebar also lost its title on hosts whose text
    // fallback never fires).
    const titleChunks: StreamChunk[] = []
    for await (const chunk of adapter.stream({
      provider: 'acp',
      model: 'mock',
      sessionId,
      purpose: 'session-title',
      messages: [{
        role: 'user',
        source: { kind: 'plugin', plugin: 'dsh-session-title-llm' },
        content: [{ type: 'text', text: 'Generate the session title from this JSON array of human messages: ["给这个仓库写一份测试指南","second human line"]' }],
      }],
    })) {
      titleChunks.push(chunk)
    }
    expect(titleChunks.map(c => c.type)).toEqual(['block-start', 'text-delta', 'block-end', 'finish'])
    const titleText = titleChunks.find((c): c is Extract<StreamChunk, { type: 'text-delta' }> => c.type === 'text-delta')?.text
    // The badge is on by default, so the placeholder answer carries it.
    expect(titleText).toBe(`${SESSION_TITLE_PREFIX}给这个仓库写一份测试指南`)
    const titleFinish = titleChunks.find((c): c is Extract<StreamChunk, { type: 'finish' }> => c.type === 'finish')
    expect(titleFinish?.reason).toMatchObject({ kind: 'stop' })

    // Switching the badge off drops the prefix from the same answer (the flag
    // is read at request time, so it lands without restarting anything) while
    // keeping the placeholder's own budget. The pick persists with the agent
    // registry — the reload round-trip is pinned by its own test below.
    await manager.setSessionTitlePrefix(false)
    const bareChunks: StreamChunk[] = []
    for await (const chunk of adapter.stream({
      provider: 'acp',
      model: 'mock',
      sessionId,
      purpose: 'session-title',
      messages: [{
        role: 'user',
        source: { kind: 'plugin', plugin: 'dsh-session-title-llm' },
        content: [{ type: 'text', text: 'Generate the session title from this JSON array of human messages: ["给这个仓库写一份测试指南","second human line"]' }],
      }],
    })) {
      bareChunks.push(chunk)
    }
    const bareText = bareChunks.find((c): c is Extract<StreamChunk, { type: 'text-delta' }> => c.type === 'text-delta')?.text
    expect(bareText).toBe('给这个仓库写一份测试指南')
    // Back on, so the shared manager's later tests see the default again.
    await manager.setSessionTitlePrefix(true)

    // A title prompt without a parseable human-message array keeps the old
    // refusal, and compaction is refused outright: the adapter must never turn
    // an auxiliary call into a remote turn.
    for (const [purpose, prompt] of [
      ['session-title', 'Generate the session title from this JSON array of human messages: not json'],
      ['compaction', 'Fold this conversation for compaction: ["hello from the person"]'],
    ] as const) {
      const refused: StreamChunk[] = []
      for await (const chunk of adapter.stream({
        provider: 'acp',
        model: 'mock',
        sessionId,
        purpose,
        messages: [{
          role: 'user',
          source: { kind: 'plugin', plugin: purpose === 'session-title' ? 'dsh-session-title-llm' : 'dsh-compaction' },
          content: [{ type: 'text', text: prompt }],
        }],
      })) {
        refused.push(chunk)
      }
      const refusalFinish = refused.find((c): c is Extract<StreamChunk, { type: 'finish' }> => c.type === 'finish')
      expect(refusalFinish?.reason).toMatchObject({ kind: 'error', failure: { code: 'unsupported_purpose' } })
      expect(refused.some(c => c.type === 'text-delta' || c.type === 'block-start')).toBe(false)
    }

    // An injected-context wake carries nothing the user said: no ACP turn at all.
    const wakeChunks: StreamChunk[] = []
    for await (const chunk of adapter.stream({
      provider: 'acp',
      model: 'mock',
      sessionId,
      messages: [{ role: 'user', source: { kind: 'skill-catalog' }, content: [{ type: 'text', text: '<available_skills>…' }] }],
    })) {
      wakeChunks.push(chunk)
    }
    expect(wakeChunks).toEqual([{ type: 'finish', reason: { kind: 'stop' } }])
  }, 30_000)

  it('refuses an anonymous host-internal auxiliary call before any ACP session exists', async () => {
    // DSH 0.2.1-rc.5's auto-review risk classifier calls `ctx.llm.stream`
    // with the session header's `acp` route but WITHOUT `purpose` and WITHOUT
    // a usable `sessionId` (absent, or an empty string). Forwarding that call
    // would create an `ephemeral:<agent>` ACP session and send the review text
    // as a user prompt — a hidden agent turn with tool access.
    const adapter = new AcpLlmAdapter(manager)
    for (const anonymousSessionId of [undefined, ''] as const) {
      const since = events.length
      const chunks: StreamChunk[] = []
      for await (const chunk of adapter.stream({
        provider: 'acp',
        model: 'mock',
        sessionId: anonymousSessionId,
        system: 'Rate the risk of the pending tool call.',
        messages: [{
          role: 'user',
          source: { kind: 'plugin', plugin: '@deepseek-ai/dsh-experimental-auto-review' },
          content: [{ type: 'text', text: 'pending tool: Bash {"command":"rm -rf build"}' }],
        }],
      })) chunks.push(chunk)

      // Exactly one closing chunk: no text, no block, no forwarded prompt.
      expect(chunks).toEqual([{
        type: 'finish',
        reason: {
          kind: 'error',
          failure: {
            code: 'unsupported_auxiliary_call',
            message: expect.stringContaining('not forwarded to the ACP agent'),
          },
        },
      }])
      expect(chunks.some(chunk => chunk.type === 'text-delta' || chunk.type === 'block-start')).toBe(false)
      // Nothing was spawned: the guard runs before `getOrCreateDshSession` (the
      // `ephemeral:<agent>` bucket) and before `selectForwardPrompt`.
      await new Promise(resolve => setTimeout(resolve, 100))
      expect(events.slice(since).filter(event => event.type === 'session/created' || event.type === 'turn/start')).toEqual([])
    }

    // `purpose` still WINS: a title call without a session id answers locally
    // through the title path instead of hitting the anonymous-call guard.
    const titleChunks: StreamChunk[] = []
    for await (const chunk of adapter.stream({
      provider: 'acp',
      model: 'mock',
      purpose: 'session-title',
      messages: [{
        role: 'user',
        source: { kind: 'plugin', plugin: 'dsh-session-title-llm' },
        content: [{ type: 'text', text: 'Generate the session title from this JSON array of human messages: ["匿名标题","second"]' }],
      }],
    })) titleChunks.push(chunk)
    expect(titleChunks.map(chunk => chunk.type)).toEqual(['block-start', 'text-delta', 'block-end', 'finish'])
    expect(titleChunks.find((chunk): chunk is Extract<StreamChunk, { type: 'text-delta' }> => chunk.type === 'text-delta')?.text)
      .toBe(`${SESSION_TITLE_PREFIX}匿名标题`)
  }, 30_000)

  it('handles cancellation in adapter.stream via AbortSignal', async () => {
    const adapter = new AcpLlmAdapter(manager)
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 200)

    const chunks: StreamChunk[] = []
    for await (const chunk of adapter.stream({
      provider: 'acp',
      model: 'mock',
      sessionId: 'dsh-native-cancel-test',
      signal: controller.signal,
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'SLOW please' }] },
      ],
    })) {
      chunks.push(chunk)
    }

    const finish = chunks.find((c): c is Extract<StreamChunk, { type: 'finish' }> => c.type === 'finish')
    expect(finish?.reason.kind).toBe('aborted')
  }, 30_000)

  it('detects host executables and returns known presets', async () => {
    // node is guaranteed in the test runner
    const nodePath = findExecutable('node')
    expect(nodePath).toBeDefined()

    const detected = detectHostAgents([])
    const piPreset = detected.find(d => d.id === 'pi')
    expect(piPreset).toBeDefined()
    expect(piPreset?.defaultCommand).toBe('pi-acp')
    expect(piPreset?.defaultArgs).toEqual([])
  })

  it('surfaces configured custom agents as detect entries carrying their full def', () => {
    const custom: AcpAgentDef = {
      id: 'my-agent',
      title: 'My Agent',
      command: process.execPath,
      args: [MOCK],
      npmPackage: '@scope/my-agent',
      env: { MY_KEY: 'v' },
    }
    const detected = detectHostAgents([custom])
    const entry = detected.find(d => d.id === 'my-agent')
    expect(entry).toBeDefined()
    expect(entry?.detected).toBe(true) // process.execPath resolves on PATH
    expect(entry?.currentConfig).toMatchObject({ id: 'my-agent', npmPackage: '@scope/my-agent', env: { MY_KEY: 'v' } })
    expect(entry?.defaultCommand).toBe(process.execPath)
    // Preset ids are not duplicated as custom entries.
    expect(detected.filter(d => d.id === 'pi')).toHaveLength(1)
  })

  it('ensureAgentExecutable resolves PATH first, installs on miss, and never rewrites a bare miss', async () => {
    // Resolvable command: no install, absolute path pinned.
    const installs: string[] = []
    const noInstall = async (pkg: string) => { installs.push(pkg) }
    const direct = await ensureAgentExecutable({ command: 'node' }, noInstall)
    expect(direct.installed).toBe(false)
    expect(installs).toEqual([])
    expect(direct.command).toBe(findExecutable('node'))

    // Missing command with no npmPackage: the original comes back untouched.
    const bare = await ensureAgentExecutable({ command: 'definitely-missing-dsh-ntr-cmd' }, noInstall)
    expect(bare).toEqual({ command: 'definitely-missing-dsh-ntr-cmd', installed: false })
    expect(installs).toEqual([])

    // Missing command with npmPackage: install runs, command falls back when
    // still unresolvable (the spawn then fails with the familiar ENOENT).
    const installed = await ensureAgentExecutable(
      { command: 'definitely-missing-dsh-ntr-cmd', npmPackage: 'some-pkg' },
      noInstall,
    )
    expect(installs).toEqual(['some-pkg'])
    expect(installed.installed).toBe(true)
    expect(installed.command).toBe('definitely-missing-dsh-ntr-cmd')

    // An installer failure propagates so the caller can surface it.
    await expect(ensureAgentExecutable(
      { command: 'definitely-missing-dsh-ntr-cmd', npmPackage: 'some-pkg' },
      async () => { throw new Error('npm down') },
    )).rejects.toThrow(/npm down/)
  })

  it('classifies a failed start from the attempt record, not from the SDK sentence', () => {
    // The pure half of the connection test's verdict: every spawn failure
    // rejects `initialize` with the same "ACP connection closed", so the cause
    // can only come from these facts. The integration case above covers
    // `not-found` / `start-failed` on real processes; the windows that need a
    // dead or hung agent are pinned here.
    const base: StartAttempt = { command: 'codebuddy', installTried: false, spawned: false, timedOut: false }
    // Nothing was spawned and no spawn error: the resolution step threw, i.e.
    // the npm auto-install.
    expect(classifyTestFailure(undefined)).toBe('handshake-failed')
    expect(classifyTestFailure(base)).toBe('not-found')
    expect(classifyTestFailure({ ...base, installTried: true })).toBe('install-failed')
    // `spawn` RETURNS a handle for a program that does not exist (the ENOENT is
    // an async event), so `spawned` is true and the spawn error must win.
    expect(classifyTestFailure({
      ...base, spawned: true, spawnError: { code: 'ENOENT', message: 'spawn codebuddy ENOENT' },
    })).toBe('not-found')
    // …but ENOENT AFTER a path resolved is not "install it": the file was found
    // and then failed to launch, which is a start failure.
    expect(classifyTestFailure({
      ...base, spawned: true, executablePath: '/usr/local/bin/codebuddy', spawnError: { code: 'ENOENT', message: 'spawn ENOENT' },
    })).toBe('start-failed')
    // A program that exists but cannot be launched is NOT a missing agent.
    expect(classifyTestFailure({
      ...base, spawned: true, spawnError: { code: 'EACCES', message: 'spawn EACCES' },
    })).toBe('start-failed')
    // `spawn` threw synchronously: nothing was spawned, yet the OS gave a reason.
    expect(classifyTestFailure({
      ...base, spawnError: { code: 'EINVAL', message: 'spawn EINVAL' },
    })).toBe('start-failed')
    // The timeout is definitive even if a stale spawn error lands afterwards.
    expect(classifyTestFailure({
      ...base, timedOut: true, spawnError: { code: 'EACCES', message: 'stale spawn error' },
    })).toBe('timeout')
    expect(classifyTestFailure({ ...base, spawned: true, timedOut: true })).toBe('timeout')
    // A timeout also kills the child, so the exit fact is present — the timeout
    // must still be reported as such.
    expect(classifyTestFailure({
      ...base, spawned: true, timedOut: true, exit: { code: null, signal: 'SIGKILL' },
    })).toBe('timeout')
    expect(classifyTestFailure({ ...base, spawned: true, exit: { code: 3, signal: null } })).toBe('start-failed')
    expect(classifyTestFailure({ ...base, spawned: true })).toBe('handshake-failed')
  })

  it('testAgent handshakes a throwaway process without touching the manager', async () => {
    const before = manager.agentViews().map(a => a.id)
    const result = await manager.testAgent({
      id: 'test-only',
      command: process.execPath,
      args: [MOCK],
      cwd: tmpdir(),
      allowedCwdRoots: [tmpdir()],
    })
    expect(result.ok).toBe(true)
    expect(result.agentInfo).toBeDefined()
    expect(result.durationMs).toBeGreaterThanOrEqual(0)
    expect(Array.isArray(result.stderr)).toBe(true)
    // The test def was never registered.
    expect(manager.agentViews().map(a => a.id)).toEqual(before)

    // A broken form value yields an ok:false verdict, not a throw.
    const failed = await manager.testAgent({
      id: 'test-only',
      command: 'definitely-missing-dsh-ntr-cmd',
      cwd: tmpdir(),
      allowedCwdRoots: [tmpdir()],
    })
    expect(failed.ok).toBe(false)
    expect(failed.error).toBeDefined()
    // The verdict NAMES the cause: a missing program is 'not-found', which is
    // what lets the card say "install the agent" instead of echoing the SDK's
    // one-size sentence ("ACP connection closed") for every spawn failure.
    expect(failed.failure).toBe('not-found')
    expect(failed.command).toBe('definitely-missing-dsh-ntr-cmd')
    expect(failed.executablePath).toBeUndefined()
    expect(failed.installTried).toBe(false)
    // The OS reason travels with the verdict: ENOENT is what separates "there
    // is nothing to run" from "the OS refused to run it" without reading prose.
    expect(failed.spawnError?.code).toBe('ENOENT')

    // A program that EXISTS but is not a usable ACP launch: it is found on
    // PATH, starts, and dies at once — the other mistake the card must name
    // differently (or the user reinstalls an agent that was never missing).
    const died = await manager.testAgent({
      id: 'test-died',
      // `process.execPath` resolves, and `-e` makes it exit before speaking ACP.
      command: process.execPath,
      args: ['-e', 'process.exit(3)'],
      cwd: tmpdir(),
      allowedCwdRoots: [tmpdir()],
    })
    expect(died.ok).toBe(false)
    expect(died.failure).toBe('start-failed')
    expect(died.executablePath).toBeDefined()
    expect(died.exit).toEqual({ code: 3, signal: null })
    // It launched; the refusal was the ACP conversation, not the OS.
    expect(died.spawnError).toBeUndefined()
  }, 30_000)

  it('supports saving and deleting agents dynamically with persistence', async () => {
    const testStorage = `${tmpdir()}/acp-test-storage-${Date.now()}.json`
    const dynamicManager = new BridgeManager([], hub, 100, testStorage)

    expect(dynamicManager.agentViews()).toHaveLength(0)

    await dynamicManager.saveAgent({
      id: 'test-agent',
      title: 'Test Agent',
      command: process.execPath,
      args: [MOCK],
      cwd: tmpdir(),
      allowedCwdRoots: [tmpdir()],
      exposedModels: ['mock-model-b'],
    })

    expect(dynamicManager.agentViews()).toHaveLength(1)
    expect(dynamicManager.agentViews()[0].id).toBe('test-agent')

    // Verify loading from persistence in a fresh manager instance, including
    // the exposure filter surviving the round-trip.
    const reloadedManager = new BridgeManager([], hub, 100, testStorage)
    expect(reloadedManager.agentViews()).toHaveLength(1)
    expect(reloadedManager.agentViews()[0].id).toBe('test-agent')
    expect((reloadedManager as unknown as { defsMap: Map<string, AcpAgentDef> }).defsMap.get('test-agent')?.exposedModels)
      .toEqual(['mock-model-b'])

    // Delete agent
    await dynamicManager.deleteAgent('test-agent')
    expect(dynamicManager.agentViews()).toHaveLength(0)

    const reloadedAfterDelete = new BridgeManager([], hub, 100, testStorage)
    expect(reloadedAfterDelete.agentViews()).toHaveLength(0)
  })

  it('anchors the default workspace to the plugin state dir, not the launch cwd', () => {
    // This plugin's own directory under the host's `~/.dsh` root — never that
    // root itself. Loose `acp-*.json` files and an `acp-workspaces/` directory
    // beside the host's `sessions/`, `storages/` and credentials made plugin
    // state indistinguishable from host state.
    expect(defaultAgentWorkspace('/tmp/fake-home')).toBe(join('/tmp/fake-home', '.dsh', 'dsh-ntr', 'workspaces'))
    expect(defaultAgentWorkspace()).toBe(join(homedir(), '.dsh', 'dsh-ntr', 'workspaces'))
    expect(defaultAgentWorkspace()).not.toBe(join(process.cwd(), 'acp-workspaces'))
    // The state dir is the common root every persisted file hangs off.
    expect(pluginStateDir('/tmp/fake-home')).toBe(join('/tmp/fake-home', '.dsh', 'dsh-ntr'))
    expect(defaultAgentWorkspace('/tmp/fake-home').startsWith(pluginStateDir('/tmp/fake-home'))).toBe(true)
  })

  /**
   * The move off the host's shared `~/.dsh` root must not cost anyone their
   * setup, and must not break the agents it moves.
   *
   * The hard part is the recorded workspace: an agent's `cwd` and
   * `allowedCwdRoots` are absolute paths stored verbatim, and the session cwd
   * resolver REJECTS a cwd that does not exist. Renaming the directory without
   * rewriting those fields turns every saved agent into a `bad_cwd` failure.
   */
  it('migrates plugin state out of the host root and rewrites the workspace paths', async () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-ntr-migrate-'))
    // The old layout: files loose in the host's root, workspaces beside them.
    mkdirSync(join(home, '.dsh', 'acp-workspaces'), { recursive: true })
    mkdirSync(join(home, '.dsh', 'sessions'), { recursive: true })
    writeFileSync(join(home, '.dsh', 'sessions', 'host-state.txt'), 'the host owns this', 'utf-8')
    const legacyCwd = join(home, '.dsh', 'acp-workspaces')
    writeFileSync(join(home, '.dsh', 'acp-agents.json'), JSON.stringify({
      version: 2,
      defaultAgentId: 'legacy',
      agents: [{
        id: 'legacy',
        command: process.execPath,
        args: [MOCK],
        cwd: legacyCwd,
        allowedCwdRoots: [legacyCwd],
      }],
    }), 'utf-8')
    writeFileSync(join(home, '.dsh', 'acp-model-catalog.json'), JSON.stringify({ version: 1, agents: {} }), 'utf-8')

    const previous = process.env.DSH_NTR_STATE_DIR
    process.env.DSH_NTR_STATE_DIR = join(home, '.dsh', 'dsh-ntr')
    try {
      const manager = new BridgeManager([], hub, 100)
      const defs = (manager as unknown as { defsMap: Map<string, AcpAgentDef> }).defsMap
      const migrated = defs.get('legacy')
      // The agent survived, and its workspace now points at the new home.
      expect(migrated).toBeDefined()
      expect(migrated?.cwd).toBe(defaultAgentWorkspace())
      expect(migrated?.allowedCwdRoots).toEqual([defaultAgentWorkspace()])
      expect(migrated?.cwd).not.toBe(legacyCwd)
      // The migration is one-way: the old spots are empty, the host's own
      // state is untouched, and the registry now lives under the plugin dir.
      expect(existsSync(join(home, '.dsh', 'acp-agents.json'))).toBe(false)
      expect(existsSync(join(home, '.dsh', 'acp-model-catalog.json'))).toBe(false)
      expect(existsSync(legacyCwd)).toBe(false)
      expect(existsSync(join(home, '.dsh', 'sessions', 'host-state.txt'))).toBe(true)
      expect(existsSync(join(home, '.dsh', 'dsh-ntr', 'agents.json'))).toBe(true)
      // The correction must reach DISK, not just memory: the recorded cwd it
      // replaced no longer exists, so a file still naming it is a booby trap for
      // anything that reads it directly (and for the next boot).
      const onDisk = JSON.parse(readFileSync(join(home, '.dsh', 'dsh-ntr', 'agents.json'), 'utf-8')) as {
        agents: Array<{ id: string; cwd?: string; allowedCwdRoots?: string[] }>
      }
      const onDiskAgent = onDisk.agents.find(agent => agent.id === 'legacy')
      expect(onDiskAgent?.cwd).toBe(defaultAgentWorkspace())
      expect(onDiskAgent?.allowedCwdRoots).toEqual([defaultAgentWorkspace()])

      // Idempotent: a second boot over the migrated layout changes nothing.
      const again = new BridgeManager([], hub, 100)
      const againDefs = (again as unknown as { defsMap: Map<string, AcpAgentDef> }).defsMap
      expect(againDefs.get('legacy')?.cwd).toBe(defaultAgentWorkspace())
      await again.shutdownAll()
      await manager.shutdownAll()
    } finally {
      if (previous === undefined) delete process.env.DSH_NTR_STATE_DIR
      else process.env.DSH_NTR_STATE_DIR = previous
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('never overwrites state that already exists in the plugin directory', async () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-ntr-noclobber-'))
    mkdirSync(join(home, '.dsh', 'dsh-ntr'), { recursive: true })
    // Both locations populated: the new one is the truth, the stale legacy file
    // must not clobber the setup the user has been editing.
    writeFileSync(join(home, '.dsh', 'dsh-ntr', 'agents.json'), JSON.stringify({
      version: 2,
      agents: [{ id: 'current', command: process.execPath, args: [MOCK] }],
    }), 'utf-8')
    writeFileSync(join(home, '.dsh', 'acp-agents.json'), JSON.stringify({
      version: 2,
      agents: [{ id: 'stale', command: process.execPath, args: [MOCK] }],
    }), 'utf-8')

    const previous = process.env.DSH_NTR_STATE_DIR
    process.env.DSH_NTR_STATE_DIR = join(home, '.dsh', 'dsh-ntr')
    try {
      const manager = new BridgeManager([], hub, 100)
      const defs = (manager as unknown as { defsMap: Map<string, AcpAgentDef> }).defsMap
      expect(defs.has('current')).toBe(true)
      expect(defs.has('stale')).toBe(false)
      await manager.shutdownAll()
    } finally {
      if (previous === undefined) delete process.env.DSH_NTR_STATE_DIR
      else process.env.DSH_NTR_STATE_DIR = previous
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('defaults a cwd-less agent into the plugin workspace and deduplicates roots', async () => {    const testStorage = `${tmpdir()}/acp-workspace-defaults-${Date.now()}.json`
    const wsManager = new BridgeManager([], hub, 100, testStorage)

    // No cwd, no roots (the panel always pre-fills both, but YAML/RPC callers
    // may not): the host must pick the plugin workspace, never `process.cwd()`.
    await wsManager.saveAgent({
      id: 'defaults',
      command: process.execPath,
      args: [MOCK],
    })
    const saved = (wsManager as unknown as { defsMap: Map<string, AcpAgentDef> }).defsMap.get('defaults')
    expect(saved?.cwd).toBe(defaultAgentWorkspace())
    expect(saved?.allowedCwdRoots).toEqual([defaultAgentWorkspace()])
    expect(saved?.allowedCwdRoots).not.toContain(process.cwd())

    // Duplicated panel input collapses to a single root (was `[cwd, cwd, $HOME]`).
    await wsManager.saveAgent({
      id: 'defaults',
      command: process.execPath,
      args: [MOCK],
      cwd: defaultAgentWorkspace(),
      allowedCwdRoots: [defaultAgentWorkspace(), defaultAgentWorkspace()],
    })
    expect((wsManager as unknown as { defsMap: Map<string, AcpAgentDef> }).defsMap.get('defaults')?.allowedCwdRoots)
      .toEqual([defaultAgentWorkspace()])

    await wsManager.shutdownAll()
  })
})
