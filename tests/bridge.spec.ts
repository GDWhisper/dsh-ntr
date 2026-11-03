/**
 * End-to-end over a real child process: the scripted mock ACP agent driven by
 * the production BridgeManager + dispatchRpc (the same face the browser uses).
 */

import { fileURLToPath } from 'node:url'
import { spawn, type ChildProcess } from 'node:child_process'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { afterAll, describe, expect, it, vi } from 'vitest'
import {
  AcpLlmAdapter, AgentBridge, BridgeManager, defaultAgentWorkspace,
  detectHostAgents, ensureAgentExecutable, findExecutable, killProcessTree, pluginStateDir, routeBindingRegistry, windowsShimLaunch,
  type BridgeTuning,
  permissionAskReason, permissionToolName,
} from '../src/bridge.ts'
import { EventHub, dispatchRpc, permissionReplayFrames } from '../src/impl.ts'
import { AcpSaveGate } from '../src/save-gate.ts'
import type { AcpAgentCatalog, AcpAgentDef, AcpEvent, ActiveTurnView, AgentCatalogResult, ChatSessionView, ChatTranscriptView, GenerateMessage, StreamChunk } from '../src/protocol.ts'
import { OUTPUT_CHARS_PER_TOKEN } from '../src/tps.ts'

const MOCK = fileURLToPath(new URL('./mock-agent.mjs', import.meta.url))

/** Separator-blind comparison: realpath answers `\` on Windows, the session cwd is folded to `/`. */
function normPath(p: string): string {
  return p.replaceAll('\\', '/')
}

const def: AcpAgentDef = {
  id: 'mock',
  title: 'Mock',
  command: process.execPath,
  args: [MOCK],
  env: {},
  cwd: tmpdir(),
  allowedCwdRoots: [tmpdir()],
}

const hub = new EventHub()
const manager = new BridgeManager([def], hub, 500)
const events: AcpEvent[] = []
hub.subscribe(event => { events.push(event) })

function waitFor<T extends AcpEvent['type']>(type: T, predicate: (event: Extract<AcpEvent, { type: T }>) => boolean, timeoutMs = 15_000): Promise<Extract<AcpEvent, { type: T }>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${type}`)), timeoutMs)
    const unsub = hub.subscribe(event => {
      if (event.type === type && predicate(event as Extract<AcpEvent, { type: T }>)) {
        clearTimeout(timer)
        unsub()
        resolve(event as Extract<AcpEvent, { type: T }>)
      }
    })
    // The event may already have arrived before the subscription.
    const existing = events.find(event => event.type === type && predicate(event as Extract<AcpEvent, { type: T }>))
    if (existing !== undefined) {
      clearTimeout(timer)
      unsub()
      resolve(existing as Extract<AcpEvent, { type: T }>)
    }
  })
}

afterAll(async () => {
  await manager.shutdownAll()
})

/**
 * Wait until a session's transcript stops growing.
 *
 * The SDK paces the agent's output independently of the `session/prompt`
 * RESPONSE: a notification is routed into the session mailbox and handed to
 * `handleSessionUpdate` on a later microtask, so `prompt()` — and with it the
 * adapter stream — can resolve while the agent's LAST chunk is still queued.
 * Reading the transcript the instant a turn ends therefore races, and it lost
 * often enough to fail a release (CI saw the mock's echo come back as `MOCK:`
 * with the `perm=` suffix missing). Quiescence is the honest wait: two
 * consecutive reads agreeing means the fold caught up.
 *
 * Used by every `…Echo` helper below, not just the one that flaked — they all
 * read the same buffer the same way.
 */
async function settleTranscript(manager: BridgeManager, sessionId: string, attempts = 40): Promise<void> {
  let previous = -1
  for (let i = 0; i < attempts; i++) {
    const answer = await dispatchRpc(manager, 'transcript/get', { sessionId })
    if (!answer.ok) throw new Error('transcript failed')
    const head = (answer.value as { entries: Array<{ seq: number }> }).entries.at(-1)?.seq ?? 0
    if (head === previous && head > 0) return
    previous = head
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

/** Poll a condition with a deadline: process death has no event we can await. */
async function until(condition: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('condition never became true')
    await new Promise(resolve => setTimeout(resolve, 50))
  }
}

/** `kill(pid, 0)` is the portable liveness probe (EPERM would also mean alive). */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * Drive the adapter the way the host agent-loop does (docs/acp-convergence.md
 * §1.5/§1.7): stream one step; while its chunks carried `tool-call` blocks and
 * it finished with `stop`, stage those calls' results as tool-sourced messages
 * and stream the CONTINUATION — the real loop re-runs with no finish-reason
 * gate whenever the settled message contains a tool-call block. Returns every
 * chunk of every step, in step order.
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

    // The agent's own surface is the plugin's `agent/catalog`. Exposing choices
    // is the only way `agent@choice` variants appear there (via the lightweight
    // RPC — no restart), and clearing is the same as never setting.
    expect(await dispatchRpc(manager, 'agent/set-exposed-models', { agentId: 'mock', exposedModels: ['mock-model-a', 'mock-model-b'] }))
      .toEqual({ ok: true, value: { done: true } })
    const exposed = await dispatchRpc(manager, 'agent/catalog', { agentId: 'mock' })
    if (!exposed.ok) throw new Error('agent/catalog failed')
    const seat = exposed.value as AgentCatalogResult
    expect(seat).toMatchObject({ agentId: 'mock', title: 'Mock', probed: true })
    // `base` names the bare route AND the model it currently resolves to, so the
    // checked row in the picker says which model is running (user report,
    // 2026-10-18). Mock is on `mock-model-a`.
    expect(seat.base).toMatchObject({ id: 'mock', name: 'Mock · Mock Model A' })
    expect(seat.variants.map(variant => variant.id)).toEqual(['mock@mock-model-a', 'mock@mock-model-b'])
    expect(await dispatchRpc(manager, 'agent/set-exposed-models', { agentId: 'mock' })).toEqual({ ok: true, value: { done: true } })
    const cleared = await dispatchRpc(manager, 'agent/catalog', { agentId: 'mock' })
    if (!cleared.ok) throw new Error('agent/catalog failed')
    expect((cleared.value as AgentCatalogResult).variants).toEqual([])

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
    // Replay of the first segment into the continuation must not count its
    // prose twice: the reported numerator is exactly the transcript's prose.
    await settleTranscript(manager, final.sessionId)
    const transcript = await dispatchRpc(manager, 'transcript/get', { sessionId: final.sessionId })
    if (!transcript.ok) throw new Error('transcript/get failed')
    const chars = (transcript.value as { entries: Array<{ update: Record<string, unknown> }> }).entries
      .filter(entry => entry.update.sessionUpdate === 'agent_message_chunk' || entry.update.sessionUpdate === 'agent_thought_chunk')
      .map(entry => String((entry.update.content as { text?: string }).text ?? ''))
      .join('').length
    expect(final.outputTokens).toBe(Math.round(chars / OUTPUT_CHARS_PER_TOKEN))
    const listed = await dispatchRpc(manager, 'session/chat-list', { dshSessionId })
    if (!listed.ok) throw new Error('session/chat-list failed')
    const row = (listed.value as { sessions: ChatSessionView[] }).sessions
      .find(session => session.sessionId === final.sessionId)
    expect(row?.burst).toEqual({ outputTokens: final.outputTokens, burstMs: final.burstMs })
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
    // block wholesale (which is what the settled card shows). The t2 input
    // arrives serialized from its object form.
    const t1Deltas = chunks
      .filter((c): c is Extract<StreamChunk, { type: 'tool-call-delta' }> => c.type === 'tool-call-delta' && (c as { id: string }).id === 't1')
      .map(c => c.argumentsDelta).join('')
    expect(t1Deltas).toBe('{"cmd":""}')
    const t1Card = chunks.find((c): c is Extract<StreamChunk, { type: 'block-end' }> =>
      c.type === 'block-end' && (c.block as { type?: string; id?: string }).type === 'tool-call' && (c.block as { id?: string }).id === 't1')
    expect((t1Card?.block as { arguments?: string } | undefined)?.arguments).toBe('{"cmd":"ls -la"}')
    const t2Args = chunks
      .filter((c): c is Extract<StreamChunk, { type: 'tool-call-delta' }> => c.type === 'tool-call-delta' && (c as { id: string }).id === 't2')
      .map(c => c.argumentsDelta).join('')
    expect(t2Args).toBe('{"path":"a.md"}')

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

    // A session-title call rides the same logged route; it must not become an
    // ACP turn (it would spend a remote turn on a title, or fold a harness
    // prompt into the agent's own context).
    const titleChunks: StreamChunk[] = []
    for await (const chunk of adapter.stream({
      provider: 'acp',
      model: 'mock',
      sessionId,
      purpose: 'session-title',
      messages: [{
        role: 'user',
        source: { kind: 'plugin', plugin: 'dsh-session-title-llm' },
        content: [{ type: 'text', text: 'Generate the session title from this JSON array of human messages: […]' }],
      }],
    })) {
      titleChunks.push(chunk)
    }
    const titleFinish = titleChunks.find((c): c is Extract<StreamChunk, { type: 'finish' }> => c.type === 'finish')
    expect(titleFinish?.reason).toMatchObject({ kind: 'error', failure: { code: 'unsupported_purpose' } })
    expect(titleChunks.some(c => c.type === 'text-delta' || c.type === 'block-start')).toBe(false)

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

/**
 * Save-gate integration at the manager seam: a delete must cancel the agent's
 * held save, and a forced save of an IDLE agent must not drain other agents'
 * queued writes.
 */
describe('agent saves behind the save gate (isolated manager)', () => {
  function gateFor(views: ActiveTurnView[]) {
    const state = { active: views.length > 0, views }
    const host = {
      state,
      hasActiveTurns: () => state.active,
      activeTurnViews: () => state.views,
    }
    return { host, gate: new AcpSaveGate(host, undefined, { timeoutMs: 0 }) }
  }

  const targetDef: AcpAgentDef = {
    id: 'target',
    title: 'Target',
    command: process.execPath,
    args: [MOCK],
    cwd: tmpdir(),
    allowedCwdRoots: [tmpdir()],
  }

  it('delete cancels the held save so a later flush cannot resurrect the agent', async () => {
    const storage = `${tmpdir()}/acp-save-gate-delete-${Date.now()}.json`
    const isolated = new BridgeManager([], hub, 100, storage)
    const { host, gate } = gateFor([{ sessionId: 'acp-ghost', agentId: 'ghost' }])
    isolated.setSaveGate(gate)
    // The manager's own turn views come from live bridges; this test is about
    // the delete/flush ordering, so the gate's host stands in for that fact.
    const patched = isolated as unknown as { activeTurnViews: () => ActiveTurnView[] }
    patched.activeTurnViews = () => host.state.views
    const ghost = { ...targetDef, id: 'ghost', title: 'Ghost' }

    await expect(isolated.saveAgent(ghost, 'defer')).resolves.toMatchObject({ done: true, deferred: true })
    expect(gate.status().pending.map(entry => entry.label)).toEqual(['agent-save:ghost'])

    await isolated.deleteAgent('ghost')
    expect(gate.status().pending).toEqual([])

    // The turn ends after the delete: flushing must not run the stale write.
    host.state.active = false
    host.state.views = []
    gate.sync()
    await gate.forceFlush()
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(isolated.agentViews().some(agent => agent.id === 'ghost')).toBe(false)
  })

  it('force-saving an idle agent leaves other agents\' held writes queued', async () => {
    const storage = `${tmpdir()}/acp-save-gate-force-${Date.now()}.json`
    const isolated = new BridgeManager([], hub, 100, storage)
    const { gate } = gateFor([{ sessionId: 'acp-other', agentId: 'other' }])
    isolated.setSaveGate(gate)
    const target = { ...targetDef }
    // A direct save probes the catalog by spawning; this test only needs the
    // manager's save decision.
    ;(isolated as unknown as { probeAgentModels: (id: string) => Promise<void> }).probeAgentModels =
      async () => {}

    const otherSave = vi.fn(async () => 'other')
    const held = gate.defer('agent-save:other', otherSave)
    await expect(gate.status().pending.map(entry => entry.label)).toEqual(['agent-save:other'])

    await expect(isolated.saveAgent(target, 'force')).resolves.toEqual({ done: true })
    expect(otherSave).not.toHaveBeenCalled()
    expect(gate.status().pending.map(entry => entry.label)).toEqual(['agent-save:other'])

    gate.cancel('agent-save:other')
    await expect(held).resolves.toEqual({ status: 'cancelled' })
    await isolated.shutdownAll()
  })

  it('a direct save of an idle agent cancels that agent\'s older held snapshot', async () => {
    const storage = `${tmpdir()}/acp-save-gate-supersede-${Date.now()}.json`
    const isolated = new BridgeManager([], hub, 100, storage)
    const { gate } = gateFor([{ sessionId: 'acp-other', agentId: 'other' }])
    isolated.setSaveGate(gate)
    const target = { ...targetDef }
    ;(isolated as unknown as { probeAgentModels: (id: string) => Promise<void> }).probeAgentModels =
      async () => {}

    const staleOperation = vi.fn(async () => 'stale')
    const stale = gate.defer('agent-save:target', staleOperation)
    await expect(isolated.saveAgent(target, 'direct')).resolves.toEqual({ done: true })
    await expect(stale).resolves.toEqual({ status: 'cancelled' })
    expect(staleOperation).not.toHaveBeenCalled()
    expect(gate.status().pending).toEqual([])
    await isolated.shutdownAll()
  })

  it('a delete during an in-flight save aborts the save without resurrecting the agent', async () => {
    const storage = `${tmpdir()}/acp-save-gate-inflight-${Date.now()}.json`
    const isolated = new BridgeManager([], hub, 100, storage)
    const { host: gateHost, gate } = gateFor([{ sessionId: 'acp-target', agentId: 'target' }])
    isolated.setSaveGate(gate)
    const patched = isolated as unknown as {
      activeTurnViews: () => ActiveTurnView[]
      bridges: Map<string, unknown>
      stopAgent: (agentId: string) => Promise<void>
      probeAgentModels: (agentId: string) => Promise<void>
    }
    patched.activeTurnViews = () => gateHost.state.views
    // Make the save body enter its stop await. The bridge value is never
    // touched because `stopAgent` is replaced below.
    patched.bridges.set('target', {})
    let releaseStop!: () => void
    const heldStop = new Promise<void>(resolve => { releaseStop = resolve })
    let stopCalls = 0
    patched.stopAgent = async () => {
      stopCalls += 1
      if (stopCalls === 1) await heldStop
    }
    const probe = vi.fn(async () => {})
    patched.probeAgentModels = probe

    await expect(isolated.saveAgent({ ...targetDef }, 'defer')).resolves.toMatchObject({ done: true, deferred: true })
    const flushing = gate.forceFlush()
    // The save is now stopped inside its await; delete it there.
    expect(stopCalls).toBe(1)
    await isolated.deleteAgent('target')
    releaseStop()
    // The delete wins: the gate sees an abort, not a failure, and records no
    // outcome (so the browser draws no failure banner).
    await expect(flushing).resolves.toEqual({ saved: 0, expired: 0, failed: 0, cancelled: 1 })
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(isolated.agentViews().some(agent => agent.id === 'target')).toBe(false)
    expect(gate.status().lastOutcomes?.['agent-save:target']).toBeUndefined()
    expect(probe).not.toHaveBeenCalled()
    const disk = JSON.parse(readFileSync(storage, 'utf-8')) as { agents?: Array<{ id: string }> }
    expect(disk.agents?.some(agent => agent.id === 'target')).toBe(false)
    await isolated.shutdownAll()
  })

  it('a delete during a direct save reports cancelled instead of an error', async () => {
    const storage = `${tmpdir()}/acp-save-direct-inflight-${Date.now()}.json`
    const isolated = new BridgeManager([], hub, 100, storage)
    const patched = isolated as unknown as {
      activeTurnViews: () => ActiveTurnView[]
      bridges: Map<string, unknown>
      stopAgent: (agentId: string) => Promise<void>
      probeAgentModels: (agentId: string) => Promise<void>
    }
    // The dummy bridge only makes the save body enter its stop await.
    patched.activeTurnViews = () => []
    patched.bridges.set('direct', {})
    let releaseStop!: () => void
    const heldStop = new Promise<void>(resolve => { releaseStop = resolve })
    let stopCalls = 0
    patched.stopAgent = async () => {
      stopCalls += 1
      if (stopCalls === 1) await heldStop
    }
    const probe = vi.fn(async () => {})
    patched.probeAgentModels = probe

    const saving = isolated.saveAgent({ ...targetDef, id: 'direct' }, 'direct')
    expect(stopCalls).toBe(1)
    await isolated.deleteAgent('direct')
    releaseStop()
    await expect(saving).resolves.toEqual({ done: true, cancelled: true })
    expect(isolated.agentViews().some(agent => agent.id === 'direct')).toBe(false)
    expect(probe).not.toHaveBeenCalled()
    await isolated.shutdownAll()
  })

  it('refuses a save of a tombstoned id while other agents still save normally', async () => {
    const storage = `${tmpdir()}/acp-save-gate-tombstone-${Date.now()}.json`
    const isolated = new BridgeManager([], hub, 100, storage)
    ;(isolated as unknown as { probeAgentModels: (id: string) => Promise<void> }).probeAgentModels =
      async () => {}

    await isolated.deleteAgent('gone')
    await expect(isolated.saveAgent({ ...targetDef, id: 'gone' })).rejects.toMatchObject({ code: 'agent_deleted' })
    // The tombstone is per id: an unrelated save keeps the old behavior.
    await expect(isolated.saveAgent({ ...targetDef, id: 'kept' })).resolves.toEqual({ done: true })
    expect(isolated.agentViews().some(agent => agent.id === 'gone')).toBe(false)
    expect(isolated.agentViews().some(agent => agent.id === 'kept')).toBe(true)
    const disk = JSON.parse(readFileSync(storage, 'utf-8')) as { agents?: Array<{ id: string }> }
    expect(disk.agents?.map(agent => agent.id)).toEqual(['kept'])
    await isolated.shutdownAll()
  })

  it('reports a failed agent-state write as a failed save outcome and refuses the delete', async () => {
    // A directory in place of the state file makes every write fail.
    const storageDir = mkdtempSync(join(tmpdir(), 'acp-persist-fail-'))
    const localHub = new EventHub()
    const localEvents: AcpEvent[] = []
    localHub.subscribe(event => { localEvents.push(event) })
    const isolated = new BridgeManager([], localHub, 100, storageDir)
    const { host: gateHost, gate } = gateFor([{ sessionId: 'acp-target', agentId: 'disk-fail' }])
    isolated.setSaveGate(gate)
    const patched = isolated as unknown as {
      activeTurnViews: () => ActiveTurnView[]
      probeAgentModels: (agentId: string) => Promise<void>
    }
    patched.activeTurnViews = () => gateHost.state.views
    patched.probeAgentModels = async () => {}

    await expect(isolated.saveAgent({ ...targetDef, id: 'disk-fail' }, 'defer')).resolves.toMatchObject({
      done: true,
      deferred: true,
    })
    await expect(gate.forceFlush()).resolves.toMatchObject({ failed: 1 })
    expect(gate.status().lastOutcomes?.['agent-save:disk-fail']).toMatchObject({ status: 'failed' })
    // The disk write failed, so the definition must NOT be committed to memory:
    // `defsMap` may only name what the registry file actually holds.
    expect(isolated.agentViews().some(agent => agent.id === 'disk-fail')).toBe(false)
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(localEvents).toContainEqual(expect.objectContaining({
      type: 'agent/notice',
      level: 'error',
      text: expect.stringContaining('deferred agent save failed'),
    }))

    // A delete is now strict: the RPC fails with `persist_failed`, but the
    // tombstone and the in-memory removal stay in place.
    await expect(dispatchRpc(isolated, 'agent/delete', { agentId: 'disk-fail' })).resolves.toMatchObject({
      ok: false,
      error: { code: 'persist_failed' },
    })
    expect(isolated.agentViews().some(agent => agent.id === 'disk-fail')).toBe(false)
    await expect(isolated.saveAgent({ ...targetDef, id: 'disk-fail' })).rejects.toMatchObject({
      code: 'agent_deleted',
    })
    await isolated.shutdownAll()
  })

  it('fails a save strictly when the host has no writable state path', async () => {
    // Under the test runner no state dir is implied, so persistence is
    // deliberately disabled — exactly the "old host half" shape.
    const isolated = new BridgeManager([], hub, 100)
    ;(isolated as unknown as { probeAgentModels: (id: string) => Promise<void> }).probeAgentModels =
      async () => {}
    await expect(isolated.saveAgent({ ...targetDef, id: 'no-path' }, 'direct')).rejects.toMatchObject({
      code: 'persist_failed',
    })
    expect(isolated.agentViews().some(agent => agent.id === 'no-path')).toBe(false)
    await isolated.shutdownAll()
  })

  it('reports gate availability only when a real gate is wired', () => {
    const storage = `${tmpdir()}/acp-gate-availability-${Date.now()}.json`
    const isolated = new BridgeManager([], hub, 100, storage)
    // No gate: the synthetic idle snapshot must not claim to be gate-backed.
    expect(isolated.saveGateStatus()).toMatchObject({ gateAvailable: false })
    const { gate } = gateFor([])
    isolated.setSaveGate(gate)
    expect(isolated.saveGateStatus()).toMatchObject({ gateAvailable: true })
  })

  it('a newer save supersedes an in-flight save before it can write', async () => {
    const storage = `${tmpdir()}/acp-save-generation-${Date.now()}.json`
    const localHub = new EventHub()
    const localEvents: AcpEvent[] = []
    localHub.subscribe(event => { localEvents.push(event) })
    const isolated = new BridgeManager([], localHub, 100, storage)
    const patched = isolated as unknown as {
      activeTurnViews: () => ActiveTurnView[]
      bridges: Map<string, unknown>
      stopAgent: (agentId: string, persist?: boolean) => Promise<void>
      probeAgentModels: (agentId: string) => Promise<void>
    }
    patched.activeTurnViews = () => []
    // The dummy bridge makes the save body enter its stop await.
    patched.bridges.set('race', {})
    let releaseStop!: () => void
    const heldStop = new Promise<void>(resolve => { releaseStop = resolve })
    let stopCalls = 0
    patched.stopAgent = async () => {
      stopCalls += 1
      if (stopCalls === 1) await heldStop
    }
    patched.probeAgentModels = async () => {}

    const savingOld = isolated.saveAgent({ ...targetDef, id: 'race', title: 'Old' }, 'direct')
    expect(stopCalls).toBe(1)
    // The newer save starts while the older one is stopped inside its await.
    const savingNew = isolated.saveAgent({ ...targetDef, id: 'race', title: 'New' }, 'direct')
    await expect(savingNew).resolves.toEqual({ done: true })
    releaseStop()
    // The older save aborts: it must not write the Old definition over New.
    await expect(savingOld).resolves.toEqual({ done: true, cancelled: true })
    const disk = JSON.parse(readFileSync(storage, 'utf-8')) as { agents?: Array<{ id: string; title?: string }> }
    expect(disk.agents?.find(agent => agent.id === 'race')?.title).toBe('New')
    // No `agent/status` frame for the aborted save: only the winner broadcasts.
    const statuses = localEvents.filter(event => event.type === 'agent/status')
    expect(statuses).toHaveLength(1)
    expect(statuses[0]).toMatchObject({ agentId: 'race', agent: { title: 'New' } })
    await isolated.shutdownAll()
  })

  it('a newer deferred save supersedes an in-flight direct save of the same label', async () => {
    const storage = `${tmpdir()}/acp-save-generation-direct-then-defer-${Date.now()}.json`
    const localHub = new EventHub()
    const localEvents: AcpEvent[] = []
    localHub.subscribe(event => { localEvents.push(event) })
    const isolated = new BridgeManager([], localHub, 100, storage)
    const { host: gateHost, gate } = gateFor([])
    isolated.setSaveGate(gate)
    const patched = isolated as unknown as {
      activeTurnViews: () => ActiveTurnView[]
      bridges: Map<string, unknown>
      stopAgent: (agentId: string, persist?: boolean) => Promise<void>
      probeAgentModels: (agentId: string) => Promise<void>
    }
    patched.activeTurnViews = () => gateHost.state.views
    patched.bridges.set('mix2', {})
    let releaseStop!: () => void
    const heldStop = new Promise<void>(resolve => { releaseStop = resolve })
    patched.stopAgent = async () => { await heldStop }
    patched.probeAgentModels = async () => {}

    const savingOld = isolated.saveAgent({ ...targetDef, id: 'mix2', title: 'Old' }, 'direct')
    // The newer save arrives while the direct one is stopped inside its await;
    // a live turn now makes it a deferred save of the same label.
    gateHost.state.active = true
    gateHost.state.views = [{ sessionId: 'acp-mix2', agentId: 'mix2' }]
    await expect(isolated.saveAgent({ ...targetDef, id: 'mix2', title: 'New' }, 'defer')).resolves.toMatchObject({
      done: true,
      deferred: true,
    })
    releaseStop()
    await expect(savingOld).resolves.toEqual({ done: true, cancelled: true })
    // End the turn: the queued newer save flushes and is the only definition.
    gateHost.state.active = false
    gateHost.state.views = []
    gate.sync()
    await new Promise(resolve => setTimeout(resolve, 30))
    const disk = JSON.parse(readFileSync(storage, 'utf-8')) as { agents?: Array<{ id: string; title?: string }> }
    expect(disk.agents?.find(agent => agent.id === 'mix2')?.title).toBe('New')
    expect(localEvents.filter(event => event.type === 'agent/status')).toHaveLength(1)
    await isolated.shutdownAll()
  })

  it('a newer forced save supersedes an in-flight deferred save of the same label', async () => {
    const storage = `${tmpdir()}/acp-save-generation-mixed-${Date.now()}.json`
    const localHub = new EventHub()
    const localEvents: AcpEvent[] = []
    localHub.subscribe(event => { localEvents.push(event) })
    const isolated = new BridgeManager([], localHub, 100, storage)
    // The target has a live turn, so its first save is queued; the second
    // explicit FORCE save is the newer gesture that must win.
    const { host: gateHost, gate } = gateFor([{ sessionId: 'acp-mixed', agentId: 'mixed' }])
    isolated.setSaveGate(gate)
    const patched = isolated as unknown as {
      activeTurnViews: () => ActiveTurnView[]
      bridges: Map<string, unknown>
      stopAgent: (agentId: string, persist?: boolean) => Promise<void>
      probeAgentModels: (agentId: string) => Promise<void>
    }
    patched.activeTurnViews = () => gateHost.state.views
    patched.bridges.set('mixed', {})
    let releaseStop!: () => void
    const heldStop = new Promise<void>(resolve => { releaseStop = resolve })
    let stopCalls = 0
    patched.stopAgent = async () => {
      stopCalls += 1
      if (stopCalls === 1) await heldStop
    }
    patched.probeAgentModels = async () => {}

    await expect(isolated.saveAgent({ ...targetDef, id: 'mixed', title: 'Queued' }, 'defer')).resolves.toMatchObject({
      done: true,
      deferred: true,
    })
    const flushing = gate.forceFlush()
    expect(stopCalls).toBe(1)
    // The forced save arrives while the queued one is executing. It bumps the
    // generation, so the queued write aborts at its await instead of landing
    // after the newer definition.
    const forced = isolated.saveAgent({ ...targetDef, id: 'mixed', title: 'Forced' }, 'force')
    releaseStop()
    await expect(flushing).resolves.toMatchObject({ cancelled: 1, saved: 0 })
    await expect(forced).resolves.toEqual({ done: true })
    const disk = JSON.parse(readFileSync(storage, 'utf-8')) as { agents?: Array<{ id: string; title?: string }> }
    expect(disk.agents?.find(agent => agent.id === 'mixed')?.title).toBe('Forced')
    // Only the winner broadcast status; the aborted queued save did not.
    expect(localEvents.filter(event => event.type === 'agent/status')).toHaveLength(1)
    await isolated.shutdownAll()
  })

  it('a force save cancels only the target\'s own held snapshot and leaves other labels queued', async () => {
    const storage = `${tmpdir()}/acp-save-force-order-${Date.now()}.json`
    const localHub = new EventHub()
    const localEvents: AcpEvent[] = []
    localHub.subscribe(event => { localEvents.push(event) })
    const isolated = new BridgeManager([], localHub, 100, storage)
    const { host: gateHost, gate } = gateFor([{ sessionId: 'acp-target', agentId: 'target' }])
    isolated.setSaveGate(gate)
    const patched = isolated as unknown as {
      activeTurnViews: () => ActiveTurnView[]
      bridges: Map<string, unknown>
      stopAgent: (agentId: string, persist?: boolean) => Promise<void>
      probeAgentModels: (agentId: string) => Promise<void>
    }
    patched.activeTurnViews = () => gateHost.state.views
    // A dummy bridge makes the target's save enter its stop await; the spy is
    // how this test proves WHICH agents the gesture stopped.
    patched.bridges.set('target', {})
    const stopped: string[] = []
    patched.stopAgent = async agentId => { stopped.push(agentId) }
    patched.probeAgentModels = async () => {}

    const staleTarget = vi.fn(async () => 'stale')
    const stale = gate.defer('agent-save:target', staleTarget)
    const otherOperation = vi.fn(async () => 'other')
    const other = gate.defer('agent-save:other', otherOperation)

    await expect(isolated.saveAgent({ ...targetDef, title: 'Fresh' }, 'force')).resolves.toEqual({ done: true })
    // The target's old snapshot was cancelled by its own label cancel, so it
    // never ran. The OTHER label belongs to another agent's dialog: it stays
    // queued, its write never runs, and that agent's process is untouched.
    await expect(stale).resolves.toEqual({ status: 'cancelled' })
    expect(staleTarget).not.toHaveBeenCalled()
    expect(otherOperation).not.toHaveBeenCalled()
    expect(gate.status().pending.map(entry => entry.label)).toEqual(['agent-save:other'])
    expect(stopped).toEqual(['target'])
    expect(localEvents.filter(event => event.type === 'agent/status').map(event => event.agentId)).toEqual(['target'])
    // The disk holds exactly the target's fresh definition: nothing was flushed
    // on behalf of the other label.
    const disk = JSON.parse(readFileSync(storage, 'utf-8')) as { agents?: Array<{ id: string; title?: string }> }
    expect(disk.agents).toEqual([expect.objectContaining({ id: 'target', title: 'Fresh' })])

    gate.cancel('agent-save:other')
    await expect(other).resolves.toEqual({ status: 'cancelled' })
    await isolated.shutdownAll()
  })

  it('a force save of an active agent leaves two other labels pending and out of the counters', async () => {
    const storage = `${tmpdir()}/acp-save-force-scope-${Date.now()}.json`
    const isolated = new BridgeManager([], hub, 100, storage)
    const { host: gateHost, gate } = gateFor([{ sessionId: 'acp-target', agentId: 'target' }])
    isolated.setSaveGate(gate)
    const patched = isolated as unknown as {
      activeTurnViews: () => ActiveTurnView[]
      probeAgentModels: (agentId: string) => Promise<void>
    }
    patched.activeTurnViews = () => gateHost.state.views
    patched.probeAgentModels = async () => {}

    // The target's own stale snapshot is the only entry this gesture may
    // touch; the two other labels belong to other agents' dialogs.
    const staleTarget = vi.fn(async () => 'stale')
    const stale = gate.defer('agent-save:target', staleTarget)
    const firstOperation = vi.fn(async () => 'first')
    const first = gate.defer('agent-save:first', firstOperation)
    const secondOperation = vi.fn(async () => 'second')
    const second = gate.defer('agent-save:second', secondOperation)

    await expect(isolated.saveAgent({ ...targetDef, title: 'Fresh' }, 'force')).resolves.toEqual({ done: true })
    await expect(stale).resolves.toEqual({ status: 'cancelled' })
    expect(staleTarget).not.toHaveBeenCalled()
    expect(firstOperation).not.toHaveBeenCalled()
    expect(secondOperation).not.toHaveBeenCalled()
    expect(gate.status().pending.map(entry => entry.label)).toEqual(['agent-save:first', 'agent-save:second'])
    // The observable per-label counters name the target only: the two held
    // labels never entered `saved` or `cancelled`.
    expect(gate.status().lastOutcomes?.['agent-save:target']).toMatchObject({ status: 'cancelled' })
    expect(gate.status().lastOutcomes?.['agent-save:first']).toBeUndefined()
    expect(gate.status().lastOutcomes?.['agent-save:second']).toBeUndefined()
    const disk = JSON.parse(readFileSync(storage, 'utf-8')) as { agents?: Array<{ id: string; title?: string }> }
    expect(disk.agents?.map(agent => agent.id)).toEqual(['target'])
    expect(disk.agents?.[0]?.title).toBe('Fresh')

    gate.cancel('agent-save:first')
    gate.cancel('agent-save:second')
    await expect(first).resolves.toEqual({ status: 'cancelled' })
    await expect(second).resolves.toEqual({ status: 'cancelled' })
    await isolated.shutdownAll()
  })

  it('save/flush force-flushes every queued label and stops each flushed agent', async () => {
    const storage = `${tmpdir()}/acp-save-flush-global-${Date.now()}.json`
    const isolated = new BridgeManager([], hub, 100, storage)
    const { host: gateHost, gate } = gateFor([
      { sessionId: 'acp-alpha', agentId: 'alpha' },
      { sessionId: 'acp-beta', agentId: 'beta' },
    ])
    isolated.setSaveGate(gate)
    const patched = isolated as unknown as {
      activeTurnViews: () => ActiveTurnView[]
      bridges: Map<string, unknown>
      stopAgent: (agentId: string, persist?: boolean) => Promise<void>
      probeAgentModels: (agentId: string) => Promise<void>
    }
    patched.activeTurnViews = () => gateHost.state.views
    // Dummy bridges make each flushed save enter its stop await.
    patched.bridges.set('alpha', {})
    patched.bridges.set('beta', {})
    const stopped: string[] = []
    patched.stopAgent = async agentId => { stopped.push(agentId) }
    patched.probeAgentModels = async () => {}

    await expect(isolated.saveAgent({ ...targetDef, id: 'alpha', title: 'Alpha' }, 'defer')).resolves.toMatchObject({
      done: true,
      deferred: true,
    })
    await expect(isolated.saveAgent({ ...targetDef, id: 'beta', title: 'Beta' }, 'defer')).resolves.toMatchObject({
      done: true,
      deferred: true,
    })
    const settingsOperation = vi.fn(async () => 'settings')
    const settings = gate.defer('settings:llm-pi-ai', settingsOperation)
    expect(gate.status().pending.map(entry => entry.label)).toEqual([
      'agent-save:alpha',
      'agent-save:beta',
      'settings:llm-pi-ai',
    ])

    // The GLOBAL gesture is the one that may spend every label's authorisation.
    await expect(isolated.saveGateFlush()).resolves.toEqual({ saved: 3, expired: 0, failed: 0 })
    await expect(settings).resolves.toEqual({ status: 'saved', value: 'settings' })
    expect(settingsOperation).toHaveBeenCalledTimes(1)
    expect(stopped).toEqual(['alpha', 'beta'])
    expect(gate.status().pending).toEqual([])
    const disk = JSON.parse(readFileSync(storage, 'utf-8')) as { agents?: Array<{ id: string; title?: string }> }
    expect(disk.agents?.find(agent => agent.id === 'alpha')?.title).toBe('Alpha')
    expect(disk.agents?.find(agent => agent.id === 'beta')?.title).toBe('Beta')
    await isolated.shutdownAll()
  })

  it('a stop persists the removed conversation records so a restart cannot resurrect them', async () => {
    const storage = `${tmpdir()}/acp-stop-persist-${Date.now()}.json`
    const isolated = new BridgeManager([{ ...targetDef, id: 'stop-me' }], hub, 100, storage)
    // Stand in for the record a chat-bound session would leave behind.
    const sessionRecord = {
      sessionId: 'acp-stop',
      acpSessionId: 'acp-stop',
      agentId: 'stop-me',
      dshSessionId: 'dsh-stop',
      cwd: tmpdir(),
      closed: false,
      transcript: { since: () => [] },
    }
    ;(isolated as unknown as { dshSessionMap: Map<string, unknown> })
      .dshSessionMap.set('dsh-stop:stop-me', sessionRecord)
    await isolated.setExposedModels('stop-me', [])
    const before = JSON.parse(readFileSync(storage, 'utf-8')) as { chatSessions?: Array<{ dshSessionId: string }> }
    expect(before.chatSessions?.some(row => row.dshSessionId === 'dsh-stop')).toBe(true)
    await isolated.stopAgent('stop-me')
    const after = JSON.parse(readFileSync(storage, 'utf-8')) as { chatSessions?: Array<{ dshSessionId: string }> }
    // The stop closed the agent-side sessions; persisting the removal is what
    // stops the next boot from restoring them as resumable.
    expect(after.chatSessions).toBeUndefined()
    await isolated.shutdownAll()
  })

  it('does not write a probe result back after the agent was deleted', async () => {
    const storage = `${tmpdir()}/acp-probe-delete-agents-${Date.now()}.json`
    const catalogPath = `${tmpdir()}/acp-probe-delete-catalog-${Date.now()}.json`
    const localHub = new EventHub()
    const localEvents: AcpEvent[] = []
    localHub.subscribe(event => { localEvents.push(event) })
    const isolated = new BridgeManager([], localHub, 100, storage, catalogPath)
    let releaseProbe!: (configOptions: unknown[]) => void
    const heldProbe = new Promise<unknown[]>(resolve => { releaseProbe = resolve })
    ;(isolated as unknown as { bridge: (agentId: string) => unknown }).bridge = () => ({
      probeConfigOptions: () => heldProbe,
    })

    await expect(isolated.saveAgent({ ...targetDef, id: 'probe-race' }, 'direct')).resolves.toEqual({ done: true })
    // The save's fire-and-forget probe is now parked inside its await.
    await isolated.deleteAgent('probe-race')
    releaseProbe([{ id: 'model', name: 'Model', category: 'model', currentValue: 'm', options: [{ value: 'm', name: 'M' }] }])
    await new Promise(resolve => setTimeout(resolve, 20))
    // The delete dropped this id's catalog; the late answer must not put it
    // back, either in memory or in the persisted catalog file.
    expect(isolated.catalogFor('probe-race')).toBeUndefined()
    expect(existsSync(catalogPath)).toBe(false)
    expect(localEvents.filter(event => event.type === 'catalog/updated')).toHaveLength(0)
    await isolated.shutdownAll()
  })
})

/**
 * The MCP servers an agent is told to connect to.
 *
 * Two things are asserted here, and both were measured against codebuddy:
 *
 *  1. THE WIRE SHAPE. The ACP union is asymmetric — its stdio variant carries
 *     NO `type` field (an entry with `type:'stdio'` is accepted by the agent
 *     and then silently dropped: the server never connects), while http/sse
 *     DO carry one, and `env`/`headers` are `[{name,value}]` arrays.
 *  2. ONE LIST PER AGENT PROCESS. The servers land in the agent's PROCESS
 *     scope, so a session created with a DIFFERENT list replaces the scope and
 *     drops the MCP servers of the live sessions on the same connection.
 *     That is why the catalog probe sends the agent's own list too.
 */
describe('MCP servers on the wire (isolated manager)', () => {
  const mcpDef: AcpAgentDef = {
    id: 'mcp',
    title: 'MCP',
    command: process.execPath,
    args: [MOCK],
    env: {},
    cwd: tmpdir(),
    allowedCwdRoots: [tmpdir()],
    mcpServers: [
      { name: 'local', transport: 'stdio', command: '/opt/servers/local', args: ['--mcp'], env: { TOKEN: 'x' } },
      { name: 'remote', transport: 'http', url: 'https://example.test/mcp', headers: { Authorization: 'Bearer t' } },
    ],
  }
  const mcpHub = new EventHub()
  const mcpEvents: AcpEvent[] = []
  const mcpManager = new BridgeManager([mcpDef], mcpHub, 500)

  afterAll(async () => {
    await mcpManager.shutdownAll()
  })

  function waitForMcp(type: 'turn/end', predicate: (event: Extract<AcpEvent, { type: 'turn/end' }>) => boolean, timeoutMs = 15_000): Promise<Extract<AcpEvent, { type: 'turn/end' }>> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout waiting for ${type}`)), timeoutMs)
      const unsub = mcpHub.subscribe(event => {
        if (event.type === type && predicate(event as Extract<AcpEvent, { type: 'turn/end' }>)) {
          clearTimeout(timer)
          unsub()
          resolve(event as Extract<AcpEvent, { type: 'turn/end' }>)
        }
      })
      const existing = mcpEvents.find(event => event.type === type && predicate(event as Extract<AcpEvent, { type: 'turn/end' }>))
      if (existing !== undefined) {
        clearTimeout(timer)
        unsub()
        resolve(existing as Extract<AcpEvent, { type: 'turn/end' }>)
      }
    })
  }

  /** The agent's own echo of the MCP servers its session was created with. */
  async function echoedWire(sessionId: string): Promise<Array<Record<string, unknown>>> {
    // Polled rather than waited for: the turn that carries the echo may
    // already have ended when the test looks, and on the resume path the
    // transcript is RESET and refilled.
    const deadline = Date.now() + 15_000
    for (;;) {
      const transcript = await dispatchRpc(mcpManager, 'transcript/get', { sessionId })
      if (transcript.ok) {
        const text = (transcript.value as { entries: Array<{ update: Record<string, unknown> }> })
          .entries
          .filter(e => e.update.sessionUpdate === 'agent_message_chunk')
          .map(e => String((e.update.content as { text?: string }).text ?? ''))
          .join('')
        const begin = text.indexOf('MCPS_BEGIN')
        const end = text.indexOf('MCPS_END')
        if (begin >= 0 && end > begin) {
          return JSON.parse(text.slice(begin + 'MCPS_BEGIN'.length, end)) as Array<Record<string, unknown>>
        }
      }
      if (Date.now() > deadline) throw new Error('the agent never echoed the MCP servers')
      await new Promise(resolve => setTimeout(resolve, 50))
    }
  }

  it('sends the configured servers to session/new in the ACP wire shape', async () => {
    mcpHub.subscribe(event => { mcpEvents.push(event) })
    const start = await dispatchRpc(mcpManager, 'session/start', { agentId: 'mcp' })
    if (!start.ok) throw new Error('start failed')
    const id = (start.value as { sessionId: string }).sessionId

    await dispatchRpc(mcpManager, 'session/prompt', { sessionId: id, text: 'MCPS please' })
    await waitForMcp('turn/end', event => event.sessionId === id)

    const wire = await echoedWire(id)
    // The stdio entry must NOT carry `type` — the agent drops it otherwise.
    expect(wire[0]).toEqual({
      name: 'local',
      command: '/opt/servers/local',
      args: ['--mcp'],
      env: [{ name: 'TOKEN', value: 'x' }],
    })
    expect('type' in wire[0]).toBe(false)
    // The http entry DOES carry one, and its headers are the wire's array form.
    expect(wire[1]).toEqual({
      type: 'http',
      name: 'remote',
      url: 'https://example.test/mcp',
      headers: [{ name: 'Authorization', value: 'Bearer t' }],
    })
  }, 30_000)

  it('gives the catalog probe the SAME list, so probing cannot strip a live session', async () => {
    // Measured against codebuddy: the MCP servers land in the agent's process
    // scope, so a probe session created with an EMPTY list replaces that scope
    // and the live session loses its MCP tools (the agent logged
    // `serverManager.delete("injected")`). The probe therefore sends the
    // agent's own list.
    const probe = await mcpManager.probeAgentModels('mcp')
    expect(probe.agentId).toBe('mcp')

    // A session created after the probe still gets the full list — the probe
    // did not replace the process scope with an empty one.
    const start = await dispatchRpc(mcpManager, 'session/start', { agentId: 'mcp' })
    if (!start.ok) throw new Error('start failed')
    const id = (start.value as { sessionId: string }).sessionId
    await dispatchRpc(mcpManager, 'session/prompt', { sessionId: id, text: 'MCPS again' })
    await waitForMcp('turn/end', event => event.sessionId === id)
    const wire = await echoedWire(id)
    expect(wire.map(entry => entry.name)).toEqual(['local', 'remote'])
  }, 30_000)

  it('sends the same list on the resume path', async () => {
    // A released session resumes through `session/load`; that request carries
    // the MCP servers too, so the resumed session keeps its tool surface.
    const start = await dispatchRpc(mcpManager, 'session/start', { agentId: 'mcp' })
    if (!start.ok) throw new Error('start failed')
    const id = (start.value as { sessionId: string }).sessionId
    await dispatchRpc(mcpManager, 'session/prompt', { sessionId: id, text: 'DIE now' })
    await waitForMcp('session/released' as 'turn/end', event => (event as unknown as { sessionId: string }).sessionId === id)

    await dispatchRpc(mcpManager, 'session/prompt', { sessionId: id, text: 'MCPS resumed' })
    await waitForMcp('turn/end', event => event.sessionId === id)
    const wire = await echoedWire(id)
    expect(wire.map(entry => entry.name)).toEqual(['local', 'remote'])
  }, 30_000)
})


describe('model catalog (isolated manager)', () => {
  const catalogPath = `${tmpdir()}/acp-catalog-test-${Date.now()}.json`
  const catalogManager = new BridgeManager([def], hub, 500, undefined, catalogPath)
  const catalogAdapter = new AcpLlmAdapter(catalogManager)

  afterAll(async () => {
    await catalogManager.shutdownAll()
  })

  it('advertises nothing: the ACP route is absent from DSH\'s model catalog', async () => {
    expect(await catalogAdapter.listModels('acp')).toEqual([])
  })

  it('serves the agent surface through agent/catalog, memory-only before any probe', async () => {
    // The seats' read is pure memory: no probe has run yet, so the answer is
    // the base entry and a `probed: false` flag (the host probes in the
    // background behind it).
    const before = catalogManager.agentCatalog('mock')
    expect(before).toMatchObject({ agentId: 'mock', title: 'Mock', probed: false, variants: [] })
    // No probe yet → no known current model, so `base` names the agent alone.
    expect(before.base).toMatchObject({ id: 'mock', name: 'Mock' })
    expect(before.currentModel).toBeUndefined()
    expect(before.reasoning).toBeUndefined()
    expect(() => catalogManager.agentCatalog('ghost')).toThrow(/not configured/)
  })

  it('reports no cached catalog before the agent has ever published one', () => {
    // The settings panel's mount read: `undefined` here is what makes it show
    // 「尚未读取模型目录」 instead of an empty list that looks like a failed probe.
    expect(catalogManager.cachedAgentModels('mock')).toBeUndefined()
  })

  it('probes configOptions, expands variants with reasoning metadata, degrades stale ids', async () => {
    const probe = await catalogManager.probeAgentModels('mock')
    expect(probe.agentId).toBe('mock')
    expect(probe.catalog.model?.configId).toBe('model')
    expect(probe.catalog.model?.choices.map(c => c.value)).toEqual(['mock-model-a', 'mock-model-b'])
    expect(probe.catalog.thought?.choices.map(c => c.value)).toEqual(['off', 'high'])
    expect(probe.catalog.thought?.currentValue).toBe('high')

    // Variants are opt-in (an unexposed catalog would flood the seats' menus —
    // pi publishes 500 choices): a probe alone offers the base entry.
    const probed = catalogManager.agentCatalog('mock')
    expect(probed.probed).toBe(true)
    expect(probed.variants).toEqual([])
    // The agent's own reasoning metadata rides the same read.
    expect(probed.reasoning?.efforts.map(e => e.id)).toEqual(['off', 'high'])
    expect(probed.reasoning?.defaultEffort).toBe('high')
    await catalogManager.setExposedModels('mock', ['mock-model-a', 'mock-model-b'])

    const seat = catalogManager.agentCatalog('mock')
    expect(seat.variants.map(variant => variant.id)).toEqual(['mock@mock-model-a', 'mock@mock-model-b'])
    // Rows name the MODEL alone — the picker already says whose models these are,
    // and the composer chip sits beside the agent chip.
    expect(seat.variants[1]).toMatchObject({ name: 'Mock Model B', description: 'The stronger mock model' })

    const resolved = await catalogAdapter.resolveModel('acp', 'mock@mock-model-b')
    expect(resolved).toMatchObject({ provider: 'acp', id: 'mock@mock-model-b', name: 'Mock · Mock Model B' })
    expect(resolved.reasoning?.efforts.map(e => e.id)).toEqual(['off', 'high'])
    expect(resolved.reasoning?.defaultEffort).toBe('high')

    // The base entry carries the same reasoning metadata (agent default model).
    const base = await catalogAdapter.resolveModel('acp', 'mock')
    expect(base.reasoning?.defaultEffort).toBe('high')

    // Unknown agents throw so DSH's selectModel reports model-unavailable…
    await expect(catalogAdapter.resolveModel('acp', 'ghost')).rejects.toThrow(/not configured/)
    // …while stale variants degrade to a bare-id entry instead of throwing.
    const stale = await catalogAdapter.resolveModel('acp', 'mock@ghost-model')
    expect(stale).toMatchObject({ provider: 'acp', id: 'mock@ghost-model', name: 'mock@ghost-model' })
  }, 30_000)

  it('aligns per-turn model and thought level on the live ACP session', async () => {
    const chunks: StreamChunk[] = []
    for await (const chunk of catalogAdapter.stream({
      provider: 'acp',
      model: 'mock@mock-model-b',
      sessionId: 'dsh-align-test',
      reasoningEffort: 'off',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hello aligned' }] }],
    })) {
      chunks.push(chunk)
    }
    const finish = chunks.find((c): c is Extract<StreamChunk, { type: 'finish' }> => c.type === 'finish')
    expect(finish?.reason).toEqual({ kind: 'stop' })

    // The streamed turn ran on the agent's own model choice and effort level,
    // applied through session/set_config_option on the same ACP session.
    const view = (catalogManager.sessions() as Array<{ agentId: string; configOptions?: Array<{ configId: string; currentValue: string }> }>)
      .find(s => s.agentId === 'mock')
    expect(view?.configOptions?.find(o => o.configId === 'model')?.currentValue).toBe('mock-model-b')
    expect(view?.configOptions?.find(o => o.configId === 'thought')?.currentValue).toBe('off')
  }, 30_000)

  it('narrows the ACP seats via setExposedModels; hidden variants still resolve', async () => {
    // Unset and empty are the same state: no variants, only the base entry
    // (the agent's own default model), which is never filtered out.
    await catalogManager.setExposedModels('mock', undefined)
    expect(catalogManager.agentCatalog('mock').variants).toEqual([])

    await catalogManager.setExposedModels('mock', ['mock-model-b'])
    expect(catalogManager.agentCatalog('mock').variants.map(v => v.id)).toEqual(['mock@mock-model-b'])

    // An empty filter leaves just the base entry too.
    await catalogManager.setExposedModels('mock', [])
    expect(catalogManager.agentCatalog('mock').variants).toEqual([])

    // Filtering only affects listing: a hidden variant still resolves fully.
    const hidden = await catalogAdapter.resolveModel('acp', 'mock@mock-model-a')
    expect(hidden).toMatchObject({ id: 'mock@mock-model-a', name: 'Mock · Mock Model A' })

    await expect(catalogManager.setExposedModels('ghost', ['x'])).rejects.toThrow(/not configured/)
  }, 30_000)

  it('reloads a persisted catalog into a fresh manager without probing', async () => {
    const reloaded = new BridgeManager([def], hub, 500, undefined, catalogPath)
    // Nothing exposed yet, so the base entry is the whole surface…
    expect(reloaded.agentCatalog('mock')).toMatchObject({ probed: true, variants: [] })
    // …and the panel's own read answers from the same disk cache: this is what
    // fills the model panes on mount, before (and without) a probe.
    const cached = reloaded.cachedAgentModels('mock')
    expect(cached?.catalog.model?.choices.map(choice => choice.value)).toEqual(['mock-model-a', 'mock-model-b'])
    expect(cached?.updatedAt).toBeGreaterThan(0)
    // …but the catalog really did come off disk: exposing a choice is enough to
    // offer it, and that path never spawns an agent.
    await reloaded.setExposedModels('mock', ['mock-model-a', 'mock-model-b'])
    expect(reloaded.agentCatalog('mock').variants.map(v => v.id)).toEqual(['mock@mock-model-a', 'mock@mock-model-b'])
    // `def` is shared with the suite, so leave it the way it was found.
    await reloaded.setExposedModels('mock', undefined)
  })

  it('serves a catalog persisted by an older schema, and marks it for repair', async () => {
    // A `{model, thought}`-only catalog written before the `mode` category was
    // parsed would otherwise keep an agent looking like it has no mode axis
    // FOREVER. It is still SERVED (dropping it would blank the seats across an
    // upgrade), marked stale, and repaired for free by `absorbCatalog` the next
    // time that agent's own session publishes its options.
    const stalePath = `${tmpdir()}/acp-catalog-stale-${Date.now()}.json`
    writeFileSync(stalePath, JSON.stringify({
      version: 1,
      agents: { mock: { catalog: { model: { configId: 'model', name: 'Model', currentValue: 'mock-model-a', choices: [] } }, updatedAt: 1 } },
    }), 'utf-8')
    const stale = new BridgeManager([def], hub, 500, undefined, stalePath)
    // Served, so the seats keep working across the upgrade…
    expect(stale.agentCatalog('mock')).toMatchObject({ probed: true, currentModel: { value: 'mock-model-a' } })
    // …and marked, so the next real session on this agent knows to rewrite it.
    expect((stale as unknown as { catalogStale: Set<string> }).catalogStale.has('mock')).toBe(true)
    // A REAL session publishing its options discharges the mark — this is the
    // repair path, and it costs no process because the session already exists.
    for await (const _ of stale.streamPrompt({
      model: 'mock',
      sessionId: 'dsh-stale-repair',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    } as never)) { /* drain */ }
    expect((stale as unknown as { catalogStale: Set<string> }).catalogStale.has('mock')).toBe(false)
    await stale.shutdownAll()
  }, 30_000)

  it('announces a catalog learned from a real session, so open conversations can re-read it', async () => {
    // The composer caches the seat surface per agent. Before this announcement
    // path existed, the first real session could learn a NEWER catalog on the
    // host while the open conversation kept rendering yesterday's list until
    // someone pressed "detect models" (user report, 2026-10-19).
    const announcePath = `${tmpdir()}/acp-catalog-announce-${Date.now()}.json`
    const announceHub = new EventHub()
    const announced: AcpEvent[] = []
    announceHub.subscribe(event => { announced.push(event) })
    const gm = new BridgeManager([def], announceHub, 500, undefined, announcePath)

    const start = await dispatchRpc(gm, 'session/start', { agentId: 'mock' })
    expect(start.ok).toBe(true)
    if (!start.ok) return
    const sessionId = (start.value as { sessionId: string }).sessionId

    // `session/new` itself is a catalog observation: it announces the change
    // (absent → present) without any explicit probe.
    const fromSession = announced.filter(event => event.type === 'catalog/updated')
    expect(fromSession).toHaveLength(1)
    expect(fromSession[0]).toMatchObject({ agentId: 'mock' })
    expect(gm.agentCatalog('mock')).toMatchObject({ probed: true, currentModel: { value: 'mock-model-a' } })

    // A second session that publishes the SAME options is not news: the
    // catalog is unchanged, so no redundant frame (and no browser re-read).
    const second = await dispatchRpc(gm, 'session/start', { agentId: 'mock' })
    expect(second.ok).toBe(true)
    expect(announced.filter(event => event.type === 'catalog/updated')).toHaveLength(1)

    await gm.shutdownAll()
  }, 30_000)

  it('absorbs the option SHAPE of a set_config_option answer, never its currentValue', async () => {
    // opencode publishes `thought_level` (its `effort`) only for models WITH
    // variants and never re-notifies after a client-driven set: the answer to
    // `session/set_config_option` is the ONLY place the thought chip's levels
    // can come from. Its `currentValue`, though, is THIS session's pick —
    // promoting it would make `reasoning.defaultEffort` out of one
    // conversation's choice.
    const shapePath = `${tmpdir()}/acp-catalog-shape-${Date.now()}.json`
    const shapeHub = new EventHub()
    const announced: AcpEvent[] = []
    shapeHub.subscribe(event => { announced.push(event) })
    const shapeDef: AcpAgentDef = { ...def, env: { ...def.env, MOCK_MODEL: 'mock-model-plain' } }
    const gm = new BridgeManager([shapeDef], shapeHub, 500, undefined, shapePath)

    const start = await dispatchRpc(gm, 'session/start', { agentId: 'mock' })
    expect(start.ok).toBe(true)
    if (!start.ok) return
    const sessionId = (start.value as { sessionId: string }).sessionId

    // The session starts on a variant-less model: no thought_level is ever
    // published for it, and the seat must not invent one.
    expect(gm.agentCatalog('mock').reasoning).toBeUndefined()
    expect(gm.cachedAgentModels('mock')?.catalog.thought).toBeUndefined()
    const beforeSet = announced.filter(event => event.type === 'catalog/updated').length

    // Switching to a variant-bearing model answers WITH the effort option.
    await dispatchRpc(gm, 'session/config-set', { sessionId, configId: 'model', value: 'mock-model-b' })

    // The shape lands in the agent catalog (the thought chip now has levels)…
    const seat = gm.agentCatalog('mock')
    expect(seat.reasoning?.efforts.map(e => e.id)).toEqual(['off', 'high'])
    // …while the answer's currentValue (this session's `high` pick) stays out
    // of the agent's default effort.
    expect(seat.reasoning?.defaultEffort).toBeUndefined()
    // The change is announced so open conversations re-read the seat surface.
    expect(announced.filter(event => event.type === 'catalog/updated').length).toBe(beforeSet + 1)

    await gm.shutdownAll()
  }, 30_000)

  it('never lets an EMPTY configOptions answer wipe known catalog or session state', async () => {
    // Observed agents (ccb, opencode) answer `configOptions: []` in
    // intermediate states — mid-reset, or while a provider is still loading.
    // That is a non-answer: absorbing it would drop the model list the seat is
    // showing and the session's own snapshot for a state that passes moments
    // later (the rule OmniTerm settles on: empty sets never overwrite the last
    // known state).
    const emptyPath = `${tmpdir()}/acp-catalog-empty-${Date.now()}.json`
    const emptyHub = new EventHub()
    const announced: AcpEvent[] = []
    emptyHub.subscribe(event => { announced.push(event) })
    const gm = new BridgeManager([def], emptyHub, 500, undefined, emptyPath)

    const start = await dispatchRpc(gm, 'session/start', { agentId: 'mock' })
    expect(start.ok).toBe(true)
    if (!start.ok) return
    const sessionId = (start.value as { sessionId: string }).sessionId

    const catalogBefore = JSON.stringify(gm.catalogFor('mock'))
    expect(gm.catalogFor('mock')?.thought).toBeDefined()
    const optionsBefore = (gm.sessions()[0] as { configOptions?: unknown[] }).configOptions
    expect(optionsBefore?.length).toBeGreaterThan(0)
    const announcedBefore = announced.filter(event => event.type === 'catalog/updated').length

    // The agent answers the set with `[]` AND pushes a `[]` notification.
    const set = await dispatchRpc(gm, 'session/config-set', { sessionId, configId: 'mock-empty-answer', value: 'x' })
    expect(set.ok).toBe(true)

    // Catalog and session snapshot are exactly what they were.
    expect(JSON.stringify(gm.catalogFor('mock'))).toBe(catalogBefore)
    expect((gm.sessions()[0] as { configOptions?: unknown[] }).configOptions).toEqual(optionsBefore)
    // …and nothing was announced, because nothing changed.
    expect(announced.filter(event => event.type === 'catalog/updated').length).toBe(announcedBefore)

    await gm.shutdownAll()
  }, 30_000)

  it('auto-discovers models the agent newly publishes by default, without touching the existing selection', async () => {
    // Baseline: the host knew only model A, and the user had selected exactly
    // it. The agent then adds model B; discovery is ON by default (the def
    // says nothing), so B is appended and nothing else — no settings-panel
    // visit, no resurrection of unchecked models.
    const autoCatalogPath = `${tmpdir()}/acp-catalog-auto-${Date.now()}.json`
    const autoAgentsPath = `${tmpdir()}/acp-agents-auto-${Date.now()}.json`
    writeFileSync(autoCatalogPath, JSON.stringify({
      version: 2,
      agents: {
        mock: {
          catalog: {
            model: {
              configId: 'model',
              name: 'Model',
              currentValue: 'mock-model-a',
              choices: [{ value: 'mock-model-a', name: 'Mock Model A' }],
            },
          },
          updatedAt: 1,
        },
      },
    }), 'utf-8')
    const autoHub = new EventHub()
    const announced: AcpEvent[] = []
    autoHub.subscribe(event => { announced.push(event) })
    const autoDef: AcpAgentDef = {
      ...def,
      exposedModels: ['mock-model-a'],
    }
    const auto = new BridgeManager([autoDef], autoHub, 500, autoAgentsPath, autoCatalogPath)

    // A real session publishes {A, B}: B is NEW relative to the baseline.
    const start = await dispatchRpc(auto, 'session/start', { agentId: 'mock' })
    expect(start.ok).toBe(true)
    expect(auto.agentCatalog('mock').variants.map(variant => variant.id))
      .toEqual(['mock@mock-model-a', 'mock@mock-model-b'])
    expect(announced.filter((event): event is Extract<AcpEvent, { type: 'agent/exposure' }> => event.type === 'agent/exposure'))
      .toMatchObject([{ agentId: 'mock', exposedModels: ['mock-model-a', 'mock-model-b'], autoDiscoverModels: true }])
    // A persisted policy change, not a live-only tweak. On is the default, so
    // the file carries no switch field until someone opts out.
    const stored = JSON.parse(readFileSync(autoAgentsPath, 'utf-8')) as {
      agents: Array<{ exposedModels?: string[]; autoDiscoverModels?: boolean }>
    }
    expect(stored.agents[0]).toMatchObject({
      exposedModels: ['mock-model-a', 'mock-model-b'],
    })
    expect('autoDiscoverModels' in (stored.agents[0] ?? {})).toBe(false)

    // Switching it off keeps what was already discovered and persists the
    // explicit opt-out — the only value this field ever stores.
    await auto.setAutoDiscoverModels('mock', false)
    expect(auto.agentCatalog('mock').variants.map(variant => variant.id))
      .toEqual(['mock@mock-model-a', 'mock@mock-model-b'])
    const optedOut = JSON.parse(readFileSync(autoAgentsPath, 'utf-8')) as {
      agents: Array<{ autoDiscoverModels?: boolean }>
    }
    expect(optedOut.agents[0]?.autoDiscoverModels).toBe(false)
    await auto.shutdownAll()
  }, 30_000)

  it('does not auto-expose a corrected catalog after a poisoned model slot is healed', async () => {
    // A catalog persisted by the pre-fix parser: the model slot IS the effort
    // list, and auto-discovery had already exposed one of its values. The next
    // real observation corrects the identity; diffing the two lists would call
    // every real model "new" and flood the selection.
    const healCatalogPath = `${tmpdir()}/acp-catalog-heal-${Date.now()}.json`
    const healAgentsPath = `${tmpdir()}/acp-agents-heal-${Date.now()}.json`
    writeFileSync(healCatalogPath, JSON.stringify({
      version: 2,
      agents: {
        mock: {
          catalog: {
            model: {
              configId: 'reasoning_effort',
              name: 'Reasoning Effort',
              currentValue: 'xhigh',
              choices: [{ value: 'xhigh', name: 'Extra High' }, { value: 'low', name: 'Low' }],
            },
          },
          updatedAt: 1,
        },
      },
    }), 'utf-8')
    const healHub = new EventHub()
    const heal = new BridgeManager([{ ...def, exposedModels: ['xhigh'] }], healHub, 500, healAgentsPath, healCatalogPath)
    try {
      const start = await dispatchRpc(heal, 'session/start', { agentId: 'mock' })
      expect(start.ok).toBe(true)
      // The real selector replaces the poisoned identity...
      expect(heal.catalogFor('mock')?.model?.configId).toBe('model')
      expect(heal.catalogFor('mock')?.model?.choices.map(choice => choice.value))
        .toEqual(['mock-model-a', 'mock-model-b'])
      // ...without discovering both models: a changed slot identity is a
      // corrected reading, not an incremental catalog.
      expect(heal.agentCatalog('mock').variants).toEqual([])
      const defs = (heal as unknown as { defsMap: Map<string, AcpAgentDef> }).defsMap
      expect(defs.get('mock')?.exposedModels).toEqual(['xhigh'])
    } finally {
      await heal.shutdownAll()
    }
  }, 30_000)

  it('NEVER spawns an agent just because a catalog was read', async () => {
    // THE reported defect (user report, 2026-10-18): a conversation served by
    // `codebuddy` showed "Oh My Pi 已连接" in the agent picker — a second agent
    // process was running because opening the app probed EVERY configured
    // agent's catalog. `agentCatalog` is a RENDER path (the composer entries
    // call it on every store change), so a probe here means "open a page, start
    // N agents".
    //
    // The rule: reading is pure memory. A probe needs a gesture —
    // `agent/probe-models`, or a session the user is actually running.
    const spawnPath = `${tmpdir()}/acp-catalog-nospawn-${Date.now()}.json`
    // Two agents, neither with a cached catalog.
    const twoDefs = [{ ...def, id: 'nospawn-a' }, { ...def, id: 'nospawn-b' }]
    const gm = new BridgeManager(twoDefs, hub, 500, undefined, spawnPath)
    const stateOf = (id: string): string =>
      (gm.agentViews() as Array<{ id: string; state: string }>).find(agent => agent.id === id)?.state ?? 'missing'
    gm.bootstrapCatalogs()
    expect(stateOf('nospawn-a')).toBe('stopped')
    expect(stateOf('nospawn-b')).toBe('stopped')
    // Reading every agent's catalog — which the composer does on each render,
    // including for agents this conversation is not bound to — must not change
    // that.
    expect(gm.agentCatalog('nospawn-a').probed).toBe(false)
    expect(gm.agentCatalog('nospawn-b').probed).toBe(false)
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(stateOf('nospawn-a')).toBe('stopped')
    expect(stateOf('nospawn-b')).toBe('stopped')
    // The explicit gesture still works — that is the settings card's button.
    await gm.probeAgentModels('nospawn-b')
    expect(gm.agentCatalog('nospawn-b').probed).toBe(true)
    await gm.shutdownAll()
  }, 30_000)

  it('serves the agent\'s own current model and modes before any session exists', async () => {
    // What the composer reads for a conversation nobody has sent a message in
    // yet. Without these two the model chip has no label and the mode select
    // has no options, so both controls vanish on exactly the conversation the
    // user is setting up (user report, 2026-10-18).
    await catalogManager.probeAgentModels('mock')
    const seat = catalogManager.agentCatalog('mock')
    expect(seat.currentModel).toEqual({ value: 'mock-model-a', name: 'Mock Model A' })
    // `base` spells out the model that the bare route currently resolves to, so
    // the picker's checked row names a model rather than just the agent.
    expect(seat.base.name).toBe('Mock · Mock Model A')
    // The mock publishes no `category: 'mode'` select (it mirrors an agent that
    // only has the `session/new` modes field), so the field is absent rather
    // than empty — the browser must be able to tell the difference.
    expect(seat.mode).toBeUndefined()
  })
})

describe('reliability (isolated manager, short timeouts)', () => {
  const relWorkspace = `${tmpdir()}/dsh-ntr-rel-workspace`
  mkdirSync(relWorkspace, { recursive: true })
  const relHub = new EventHub()
  const relEvents: AcpEvent[] = []
  relHub.subscribe(event => { relEvents.push(event) })
  const relManager = new BridgeManager(
    [{
      ...def,
      id: 'rel',
      cwd: `${tmpdir()}/dsh-ntr-rel-workspace`,
      allowedCwdRoots: [`${tmpdir()}/dsh-ntr-rel-workspace`],
    }],
    relHub,
    500,
    undefined,
    undefined,
    true,
    // `abort` is spelled out because the plugin's own default is `wait`
    // (never expire), and `wait` outranks `permissionTimeoutMs` — the case
    // below IS the deadline firing.
    { startupTimeoutMs: 2_500, permissionTimeoutMs: 700, cancelFallbackMs: 400, permissionTimeoutMode: 'abort' },
  )

  function relWaitFor<T extends AcpEvent['type']>(type: T, predicate: (event: Extract<AcpEvent, { type: T }>) => boolean, timeoutMs = 15_000): Promise<Extract<AcpEvent, { type: T }>> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout waiting for ${type}`)), timeoutMs)
      const unsub = relHub.subscribe(event => {
        if (event.type === type && predicate(event as Extract<AcpEvent, { type: T }>)) {
          clearTimeout(timer)
          unsub()
          resolve(event as Extract<AcpEvent, { type: T }>)
        }
      })
      const existing = relEvents.find(event => event.type === type && predicate(event as Extract<AcpEvent, { type: T }>))
      if (existing !== undefined) {
        clearTimeout(timer)
        unsub()
        resolve(existing as Extract<AcpEvent, { type: T }>)
      }
    })
  }

  afterAll(async () => {
    await relManager.shutdownAll()
  })

  it('fails a hung agent with agent_timeout instead of hanging forever', async () => {
    const hung = new BridgeManager(
      [{ ...def, id: 'hung', command: process.execPath, args: ['-e', 'process.stdin.resume()'] }],
      relHub,
      100,
      undefined,
      undefined,
      true,
      { startupTimeoutMs: 700 },
    )
    try {
      const result = await dispatchRpc(hung, 'session/start', { agentId: 'hung' })
      // Startup failures surface as agent_unreachable; the timeout detail
      // (what stalled, the budget, the stderr tail) rides in the message.
      expect(result).toMatchObject({ ok: false, error: { code: 'agent_unreachable' } })
      if (result.ok) return
      expect(result.error.message).toContain('did not answer initialize')
      // The wedged child must be torn down, not left behind.
      expect(hung.agentViews().find(a => a.id === 'hung')?.state).toBe('error')
    } finally {
      await hung.shutdownAll()
    }
  }, 15_000)

  it('keeps the error state when the child dies during the handshake', async () => {
    // A CRASH is not a teardown: the settings card auto-expands on
    // `state=error` + `stderrTail`, which is the only place the user can see why
    // the agent will not start. Regression for `releaseAll` bumping
    // `teardownEpoch`: the crash release then looked like a deliberate teardown
    // to the start's own catch, which published nothing and left the failed card
    // collapsed and unexplained.
    //
    // The child hands its stdout to a GRANDCHILD on purpose: that keeps the pipe
    // open after it dies, so its own `exit` (→ `connectionLost` →
    // `releaseAll('died')`) is guaranteed to land before the connection teardown
    // rejects the pending `initialize`. The other order never reaches
    // `releaseAll` and passed even with the bug.
    const crash = new BridgeManager(
      [{
        ...def,
        id: 'crash',
        command: process.execPath,
        args: ['-e', [
          'const { spawn } = require("node:child_process")',
          'spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: ["ignore", "inherit", "inherit"] })',
          'console.error("boom: died during initialize")',
          'setTimeout(() => process.exit(3), 100)',
        ].join('; ')],
      }],
      relHub,
      100,
      undefined,
      undefined,
      true,
      { startupTimeoutMs: 5_000 },
    )
    try {
      const result = await dispatchRpc(crash, 'session/start', { agentId: 'crash' })
      // Caller-visible contract is unchanged: every failed start is
      // `agent_unreachable`.
      expect(result).toMatchObject({ ok: false, error: { code: 'agent_unreachable' } })
      const view = crash.agentViews().find(agent => agent.id === 'crash')
      expect(view?.state).toBe('error')
      expect(view?.stderrTail?.join('\n')).toContain('boom: died during initialize')
    } finally {
      await crash.shutdownAll()
    }
  }, 20_000)

  it('serves fs read/write requests inside the sandbox and refuses escapes', async () => {
    const start = await dispatchRpc(relManager, 'session/start', { agentId: 'rel' })
    if (!start.ok) throw new Error(`start failed: ${JSON.stringify(start)}`)
    const id = (start.value as { sessionId: string }).sessionId
    const workspaceRoot = `${tmpdir()}/dsh-ntr-rel-workspace`

    const write = await dispatchRpc(relManager, 'session/prompt', { sessionId: id, text: `WRITEFILE ${workspaceRoot}/fs-test/nested/probe.txt` })
    expect(write).toMatchObject({ ok: true })
    const writeEnd = await relWaitFor('turn/end', event => event.sessionId === id && event.stopReason === 'end_turn')
    void writeEnd
    const written = readFileSync(`${workspaceRoot}/fs-test/nested/probe.txt`, 'utf8')
    expect(written).toBe('written-by-mock-agent')

    const read = await dispatchRpc(relManager, 'session/prompt', { sessionId: id, text: `READFILE ${workspaceRoot}/fs-test/nested/probe.txt` })
    expect(read).toMatchObject({ ok: true })
    await relWaitFor('turn/end', event => event.sessionId === id && event.stopReason === 'end_turn' && relEvents.filter(e => e.type === 'turn/end' && e.sessionId === id).length >= 2)
    const transcript = await dispatchRpc(relManager, 'transcript/get', { sessionId: id })
    if (!transcript.ok) throw new Error('transcript failed')
    const text = (transcript.value as { entries: Array<{ update: Record<string, unknown> }> })
      .entries
      .filter(e => e.update.sessionUpdate === 'agent_message_chunk')
      .map(e => String((e.update.content as { text?: string }).text ?? ''))
      .join('')
    expect(text).toContain('READ_OK:written-by-mock-agent')

    // Escape attempts must surface as a refusal to the agent, never contents.
    const escape = await dispatchRpc(relManager, 'session/prompt', { sessionId: id, text: 'READFILE /etc/passwd' })
    expect(escape).toMatchObject({ ok: true })
    await relWaitFor('turn/end', event => event.sessionId === id && event.stopReason === 'end_turn' && relEvents.filter(e => e.type === 'turn/end' && e.sessionId === id).length >= 3)
    const transcript2 = await dispatchRpc(relManager, 'transcript/get', { sessionId: id })
    if (!transcript2.ok) throw new Error('transcript failed')
    const escapeText = (transcript2.value as { entries: Array<{ update: Record<string, unknown> }> })
      .entries
      .filter(e => e.update.sessionUpdate === 'agent_message_chunk')
      .map(e => String((e.update.content as { text?: string }).text ?? ''))
      .join('')
    expect(escapeText).toContain('READ_FAIL:')
    expect(escapeText).toContain('outside the session workspace')
  }, 30_000)

  it('resumes a session after the agent process dies (send to recover)', async () => {
    const start = await dispatchRpc(relManager, 'session/start', { agentId: 'rel' })
    if (!start.ok) throw new Error('start failed')
    const id = (start.value as { sessionId: string }).sessionId

    await dispatchRpc(relManager, 'session/prompt', { sessionId: id, text: 'DIE now' })
    const released = await relWaitFor('session/released', event => event.sessionId === id)
    expect(released.session.released).toBe(true)

    // The released session stays visible and readable (pre-crash transcript).
    const sessions = await dispatchRpc(relManager, 'sessions/list', {})
    if (!sessions.ok) throw new Error('sessions/list failed')
    const view = (sessions.value as { sessions: Array<{ sessionId: string; released?: boolean }> }).sessions.find(s => s.sessionId === id)
    expect(view?.released).toBe(true)

    // The next prompt respawns the agent and resumes via session/load.
    await dispatchRpc(relManager, 'session/prompt', { sessionId: id, text: 'back again' })
    const end = await relWaitFor('turn/end', event => event.sessionId === id && event.stopReason === 'end_turn')
    void end

    const transcript = await dispatchRpc(relManager, 'transcript/get', { sessionId: id })
    if (!transcript.ok) throw new Error('transcript failed')
    const text = (transcript.value as { entries: Array<{ update: Record<string, unknown> }> })
      .entries
      .filter(e => e.update.sessionUpdate === 'agent_message_chunk')
      .map(e => String((e.update.content as { text?: string }).text ?? ''))
      .join('')
    expect(text).toContain('REPLAYED: earlier conversation')
    expect(text).toContain('MOCK: echo back again')

    const resumed = await dispatchRpc(relManager, 'sessions/list', {})
    if (!resumed.ok) throw new Error('sessions/list failed')
    const resumedView = (resumed.value as { sessions: Array<{ sessionId: string; released?: boolean }> }).sessions.find(s => s.sessionId === id)
    expect(resumedView?.released).toBeUndefined()
  }, 30_000)

  it('force-finalizes a turn when the agent ignores cancel, and dedups the late real end', async () => {
    const start = await dispatchRpc(relManager, 'session/start', { agentId: 'rel' })
    if (!start.ok) throw new Error('start failed')
    const id = (start.value as { sessionId: string }).sessionId

    await dispatchRpc(relManager, 'session/prompt', { sessionId: id, text: 'IGNORE_CANCEL please' })
    await new Promise(resolve => setTimeout(resolve, 100))
    await dispatchRpc(relManager, 'session/cancel', { sessionId: id })

    // The fallback timer fires first: turn is force-finalized with an error.
    const fallback = await relWaitFor('turn/end', event => event.sessionId === id && event.error !== undefined && event.error.includes('force-finalized'))
    expect(fallback.turnId).toBe('')

    // The agent eventually finishes normally; the late real turn/end follows.
    const late = await relWaitFor('turn/end', event => event.sessionId === id && event.stopReason === 'end_turn')
    expect(late.turnId).not.toBe('')

    // And a prompt is possible again (the session did not stay running).
    const again = await dispatchRpc(relManager, 'session/prompt', { sessionId: id, text: 'fresh turn' })
    expect(again).toMatchObject({ ok: true, value: { accepted: true } })
    await relWaitFor('turn/end', event => event.sessionId === id && event.stopReason === 'end_turn' && event.turnId === (again.value as { turnId: string }).turnId)
  }, 30_000)

  it('answers a pending permission with cancelled after the timeout', async () => {
    const start = await dispatchRpc(relManager, 'session/start', { agentId: 'rel' })
    if (!start.ok) throw new Error('start failed')
    const id = (start.value as { sessionId: string }).sessionId

    await dispatchRpc(relManager, 'session/prompt', { sessionId: id, text: 'PERM hold' })
    const request = await relWaitFor('permission/request', event => event.sessionId === id)
    const resolved = await relWaitFor('permission/resolved', event => event.requestId === request.requestId)
    expect(resolved.outcome).toEqual({ outcome: 'cancelled' })
    // The notice explains what happened, and the turn still settles.
    await relWaitFor('agent/notice', event => event.text.includes('timed out'))
    const end = await relWaitFor('turn/end', event => event.sessionId === id && event.stopReason === 'end_turn')
    void end
  }, 30_000)
})

describe('stale cancel and silent stops (isolated manager)', () => {
  const scWorkspace = `${tmpdir()}/dsh-ntr-sc-workspace`
  mkdirSync(scWorkspace, { recursive: true })
  const scHub = new EventHub()
  const scEvents: AcpEvent[] = []
  scHub.subscribe(event => { scEvents.push(event) })
  const scManager = new BridgeManager(
    [{
      ...def,
      id: 'sc',
      cwd: scWorkspace,
      allowedCwdRoots: [scWorkspace],
    }],
    scHub,
    500,
    undefined,
    undefined,
    true,
    // cancelFallbackMs 800ms: longer than the mock's 300ms stale-cancel window,
    // so the generation-guard case can start a successor turn before it fires.
    { startupTimeoutMs: 2_500, cancelFallbackMs: 800, staleCancelRetryDelayMs: 500, staleCancelMaxRetries: 2 },
  )

  afterAll(async () => {
    await scManager.shutdownAll()
  })

  function scWaitFor<T extends AcpEvent['type']>(type: T, predicate: (event: Extract<AcpEvent, { type: T }>) => boolean, timeoutMs = 15_000): Promise<Extract<AcpEvent, { type: T }>> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout waiting for ${type}`)), timeoutMs)
      const unsub = scHub.subscribe(event => {
        if (event.type === type && predicate(event as Extract<AcpEvent, { type: T }>)) {
          clearTimeout(timer)
          unsub()
          resolve(event as Extract<AcpEvent, { type: T }>)
        }
      })
      const existing = scEvents.find(event => event.type === type && predicate(event as Extract<AcpEvent, { type: T }>))
      if (existing !== undefined) {
        clearTimeout(timer)
        unsub()
        resolve(existing as Extract<AcpEvent, { type: T }>)
      }
    })
  }

  it('does not force-finalize a LATER turn when an old cancel fallback fires', async () => {
    const start = await dispatchRpc(scManager, 'session/start', { agentId: 'sc' })
    if (!start.ok) throw new Error('start failed')
    const id = (start.value as { sessionId: string }).sessionId

    // Turn 1 settles promptly, so the fallback armed below outlives it.
    const p1 = await dispatchRpc(scManager, 'session/prompt', { sessionId: id, text: 'hello' })
    if (!p1.ok) throw new Error('prompt failed')
    await scWaitFor('turn/end', event => event.sessionId === id && event.turnId === (p1.value as { turnId: string }).turnId && event.stopReason === 'end_turn')

    // Cancel while IDLE: arms the 800ms fallback for the (already finished)
    // current generation — exactly the timer that used to murder whatever
    // turn happened to be running when it fired.
    await dispatchRpc(scManager, 'session/cancel', { sessionId: id })
    // Out-wait the mock's 300ms stale-cancel window so turn 2 is not swallowed.
    await new Promise(resolve => setTimeout(resolve, 350))

    // Turn 2 runs far longer than the remaining fallback window (the mock
    // sleeps ~1.2s on IGNORE_CANCEL). Without the generation guard the timer
    // would force-finalize THIS turn mid-flight and broadcast a bogus error.
    const p2 = await dispatchRpc(scManager, 'session/prompt', { sessionId: id, text: 'IGNORE_CANCEL please' })
    if (!p2.ok) throw new Error('prompt failed')
    const end2 = await scWaitFor('turn/end', event => event.sessionId === id && event.turnId === (p2.value as { turnId: string }).turnId, 10_000)
    expect(end2.stopReason).toBe('end_turn')
    expect(end2.error).toBeUndefined()
    expect(scEvents.some(event =>
      event.type === 'turn/end'
      && event.sessionId === id
      && typeof event.error === 'string'
      && event.error.includes('force-finalized'),
    )).toBe(false)
  }, 30_000)

  it('resends a prompt the agent swallowed with a stale cancelled stop', async () => {
    const start = await dispatchRpc(scManager, 'session/start', { agentId: 'sc' })
    if (!start.ok) throw new Error('start failed')
    const id = (start.value as { sessionId: string }).sessionId

    // Turn 1 is cancelled properly (the mock answers it from the cancel).
    const p1 = await dispatchRpc(scManager, 'session/prompt', { sessionId: id, text: 'SLOW please' })
    if (!p1.ok) throw new Error('prompt failed')
    await new Promise(resolve => setTimeout(resolve, 150))
    await dispatchRpc(scManager, 'session/cancel', { sessionId: id })
    await scWaitFor('turn/end', event => event.sessionId === id && event.turnId === (p1.value as { turnId: string }).turnId && event.stopReason === 'cancelled')

    // Turn 2 lands inside the mock's 300ms cleanup window and is answered
    // `cancelled` without a turn — the user's message, silently swallowed.
    // The bridge must detect the stale stop (no cancel was requested for THIS
    // generation) and resend after the retry delay, out-waiting the window.
    const p2 = await dispatchRpc(scManager, 'session/prompt', { sessionId: id, text: 'fresh turn' })
    if (!p2.ok) throw new Error('prompt failed')
    const end2 = await scWaitFor('turn/end', event => event.sessionId === id && event.turnId === (p2.value as { turnId: string }).turnId, 10_000)
    // Only the resent prompt can end normally: the first attempt was swallowed.
    expect(end2.stopReason).toBe('end_turn')
  }, 30_000)

  it('does not resend a stale cancelled answer once a successor turn owns the session', async () => {
    // The swallow retry is only safe while the generation that sent the prompt
    // still owns the session. Here the cancelled answer arrives late, after a
    // successor turn began (what the cancel fallback + the user's next message
    // produce): resending would fire a second session/prompt into that turn.
    const logPath = `${scWorkspace}/stale-late-prompts-${String(process.pid)}-${String(Date.now())}.log`
    const lateHub = new EventHub()
    const lateManager = new BridgeManager([
      { ...def, id: 'late', cwd: scWorkspace, allowedCwdRoots: [scWorkspace], env: { ...def.env, MOCK_PROMPT_LOG: logPath } },
    ], lateHub, 500, undefined, undefined, true, {
      startupTimeoutMs: 3_000,
      staleCancelRetryDelayMs: 250,
      staleCancelMaxRetries: 2,
    })
    try {
      const start = await dispatchRpc(lateManager, 'session/start', { agentId: 'late' })
      if (!start.ok) throw new Error('start failed')
      const id = (start.value as { sessionId: string }).sessionId
      const located = await lateManager.locateOrResume(id)
      const turnGen = located.session.turnSeq

      const pending = located.bridge.runPrompt(located.session, 'STALE_LATE please', 'turn-stale-late', turnGen)
      // Wait for the prompt to REACH the agent (the mock answers it 450ms
      // later), then move the generation on: everything the old prompt says
      // from here belongs to a superseded turn.
      const deadline = Date.now() + 10_000
      for (;;) {
        const lines = existsSync(logPath)
          ? readFileSync(logPath, 'utf8').split('\n').filter(line => line !== '')
          : []
        if (lines.length >= 1) break
        if (Date.now() > deadline) throw new Error('the prompt never reached the agent')
        await new Promise(resolve => setTimeout(resolve, 5))
      }
      located.session.turnSeq = turnGen + 1

      // The late answer comes back as-is, not as a resent prompt.
      await expect(pending).resolves.toMatchObject({ stopReason: 'cancelled' })
      // Bounded negative wait past the retry delay: no second prompt went out.
      await new Promise(resolve => setTimeout(resolve, 400))
      const lines = readFileSync(logPath, 'utf8').split('\n').filter(line => line !== '')
      expect(lines).toEqual(['STALE_LATE please'])
    } finally {
      await lateManager.shutdownAll()
      rmSync(logPath, { force: true })
    }
  }, 30_000)

  it('does not resend a stale cancelled prompt when a second stop lands during the retry delay', async () => {
    // Two clicks on stop inside one turn's retry window: the second cancel
    // names the SAME generation, so the generation guard alone would still
    // resend a prompt the user has already stopped. The resend is only for the
    // stale-cancel swallow — a requested cancel must win.
    const logPath = `${scWorkspace}/double-cancel-prompts-${String(process.pid)}-${String(Date.now())}.log`
    const hub = new EventHub()
    const manager = new BridgeManager([
      { ...def, id: 'double-cancel', cwd: scWorkspace, allowedCwdRoots: [scWorkspace], env: { ...def.env, MOCK_PROMPT_LOG: logPath } },
    ], hub, 500, undefined, undefined, true, {
      startupTimeoutMs: 3_000,
      // The mock answers `cancelled` at once and ticks 10ms later, so the
      // second cancel lands with nearly the whole (deliberately long) delay to
      // spare. The assertions below do not depend on measuring that margin:
      // the run only returns once the delay has elapsed.
      staleCancelRetryDelayMs: 2_000,
      staleCancelMaxRetries: 2,
      cancelFallbackMs: 5_000,
    })
    try {
      const start = await dispatchRpc(manager, 'session/start', { agentId: 'double-cancel' })
      if (!start.ok) throw new Error('start failed')
      const id = (start.value as { sessionId: string }).sessionId
      const located = await manager.locateOrResume(id)
      const turnGen = located.session.turnSeq

      // The tick is bookkeeping (opens nothing), but it arrives AFTER the
      // `cancelled` response: seeing it proves the client is already in its
      // retry delay — no sleep-based guess about where the response is.
      const answered = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('the cancelled answer never landed')), 10_000)
        const unsub = hub.subscribe(event => {
          if (event.type !== 'session/update') return
          if (event.sessionId !== located.session.sessionId) return
          if (event.update.sessionUpdate !== 'usage_update') return
          clearTimeout(timer)
          unsub()
          resolve()
        })
      })
      const pending = located.bridge.runPrompt(located.session, 'STALE_TICK please', 'turn-double-cancel', turnGen)
      await answered
      await located.bridge.cancel(located.session)

      await expect(pending).resolves.toMatchObject({ stopReason: 'cancelled' })
      // `runPrompt` returns only after its retry delay elapsed (or the answer
      // was not retryable), so a buggy resend would already have reached the
      // agent and appended its line. No fixed sleep guesses at the delay.
      const lines = existsSync(logPath)
        ? readFileSync(logPath, 'utf8').split('\n').filter(line => line !== '')
        : []
      expect(lines).toEqual(['STALE_TICK please'])
    } finally {
      await manager.shutdownAll()
      rmSync(logPath, { force: true })
    }
  }, 30_000)

  it('reports a normal stop that produced no visible output', async () => {
    // The pi-acp shape: an upstream failure folded into a legal end_turn,
    // bookkeeping frames only — the user would see an empty bubble. The turn
    // must carry a visible hint instead.
    const adapter = new AcpLlmAdapter(scManager)
    const chunks: StreamChunk[] = []
    for await (const chunk of adapter.stream({
      provider: 'acp',
      model: 'sc',
      sessionId: 'dsh-sc-empty-turn',
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'EMPTY please' }] },
      ],
    })) {
      chunks.push(chunk)
    }

    const text = chunks
      .filter((c): c is Extract<StreamChunk, { type: 'text-delta' }> => c.type === 'text-delta')
      .map(c => c.text)
      .join('')
    expect(text).toContain('no visible output')
    expect(text).toContain('end_turn')
    const finish = chunks.find((c): c is Extract<StreamChunk, { type: 'finish' }> => c.type === 'finish')
    expect(finish?.reason.kind).toBe('stop')
  }, 30_000)
})

describe('every ACP permission ask reaches the human through the ledger (isolated manager)', () => {
  const askHub = new EventHub()
  const askEvents: AcpEvent[] = []
  askHub.subscribe(event => { askEvents.push(event) })
  const askManager = new BridgeManager([{ ...def, id: 'ask' }], askHub, 500)
  const askAdapter = new AcpLlmAdapter(askManager)

  afterAll(async () => {
    await askManager.shutdownAll()
  })

  /**
   * Wait for a fresh event. `since` is mandatory: the hub keeps every event
   * from earlier cases, so an unscoped predicate would match a stale one.
   */
  function askWaitFor<T extends AcpEvent['type']>(type: T, since: number, predicate: (event: Extract<AcpEvent, { type: T }>) => boolean, timeoutMs = 15_000): Promise<Extract<AcpEvent, { type: T }>> {
    const matches = (event: AcpEvent): event is Extract<AcpEvent, { type: T }> =>
      event.type === type && predicate(event as Extract<AcpEvent, { type: T }>)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout waiting for ${type}`)), timeoutMs)
      const unsub = askHub.subscribe(event => {
        if (askEvents.indexOf(event) >= since && matches(event)) {
          clearTimeout(timer)
          unsub()
          resolve(event)
        }
      })
      const existing = askEvents.find((event, index) => index >= since && matches(event))
      if (existing !== undefined) {
        clearTimeout(timer)
        unsub()
        resolve(existing)
      }
    })
  }

  /**
   * Drive one adapter turn (the only path that binds a DSH chat session id),
   * answering every ask it raises through `permission/respond` exactly as the
   * browser's conversation card would. Collects the reasoning text the turn
   * streamed (where the permission line lives).
   */
  async function askTurn(sessionKey: string | undefined, text: string, optionId = 'allow1'): Promise<{ reasoning: () => string; drained: Promise<void> }> {
    const parts: string[] = []
    const answers = askHub.subscribe(event => {
      if (event.type !== 'permission/request') return
      void dispatchRpc(askManager, 'permission/respond', { requestId: event.requestId, optionId })
    })
    const drained = (async () => {
      try {
        const { chunks } = await hostLoopTurn(askAdapter, {
          provider: 'acp',
          model: 'ask',
          ...(sessionKey === undefined ? {} : { sessionId: sessionKey }),
          messages: [{ role: 'user', content: [{ type: 'text', text }] }],
        })
        for (const chunk of chunks) {
          if (chunk.type === 'reasoning-delta') parts.push(chunk.text)
        }
      } finally {
        answers()
      }
    })()
    return { reasoning: () => parts.join(''), drained }
  }

  async function askEcho(sessionId: string): Promise<string> {
    await settleTranscript(askManager, sessionId)
    const transcript = await dispatchRpc(askManager, 'transcript/get', { sessionId })
    if (!transcript.ok) throw new Error('transcript failed')
    return (transcript.value as { entries: Array<{ update: Record<string, unknown> }> }).entries
      .filter(e => e.update.sessionUpdate === 'agent_message_chunk')
      .map(e => String((e.update.content as { text?: string }).text ?? ''))
      .join('')
  }

  it('broadcasts a complete request frame for a chat-bound ask, then follows the human answer', async () => {
    const since = askEvents.length
    const { drained } = await askTurn('dsh-ask-adapter', 'PERM adapter ask')
    const request = await askWaitFor('permission/request', since, () => true)
    expect(request).toMatchObject({
      dshSessionId: 'dsh-ask-adapter',
      toolName: 'mock dangerous operation',
      reason: 'mock dangerous operation',
      timeoutMode: 'wait',
      options: [
        { optionId: 'allow1', name: 'Allow once', kind: 'allow_once' },
        { optionId: 'reject1', name: 'Reject once', kind: 'reject_once' },
      ],
    })
    // The raw ACP payload stays on the frame (constraint 29)…
    expect(request.toolCall).toMatchObject({ toolCallId: 'call_1', title: 'mock dangerous operation' })
    // …and `wait` has no deadline at all.
    expect(request).not.toHaveProperty('deadlineAt')
    await drained
    expect(await askEcho(request.sessionId)).toContain('perm=allow1')
    expect(askManager.pendingPermissionViews()).toHaveLength(0)
  }, 30_000)

  it('omits dshSessionId for an /acp RPC-only ask', async () => {
    const start = await dispatchRpc(askManager, 'session/start', { agentId: 'ask' })
    if (!start.ok) throw new Error('start failed')
    const id = (start.value as { sessionId: string }).sessionId
    const since = askEvents.length

    const prompted = dispatchRpc(askManager, 'session/prompt', { sessionId: id, text: 'PERM rpc path' })
    const request = await askWaitFor('permission/request', since, event => event.sessionId === id)
    // No chat session behind it: the conversation card cannot address it, so
    // the settings panel is its answer entry.
    expect(request).not.toHaveProperty('dshSessionId')
    expect(request.toolName).toBe('mock dangerous operation')
    expect(request.timeoutMode).toBe('wait')
    expect(request).not.toHaveProperty('deadlineAt')
    await dispatchRpc(askManager, 'permission/respond', { requestId: request.requestId, optionId: 'reject1' })
    await prompted
    await askWaitFor('turn/end', since, event => event.sessionId === id && event.stopReason === 'end_turn')
    expect(await askEcho(id)).toContain('perm=reject1')
  }, 30_000)

  it('words the chat line for the answer entry the ask actually has', async () => {
    // A chat-bound ask is answered on the card above the composer.
    const sinceChat = askEvents.length
    const chat = await askTurn('dsh-ask-line', 'PERM ask line')
    await askWaitFor('permission/request', sinceChat, event => event.dshSessionId === 'dsh-ask-line')
    await chat.drained
    expect(chat.reasoning()).toContain('please answer the permission card above the composer')
    expect(chat.reasoning()).not.toContain('within')

    // An adapter call with no DSH chat session has no conversation to show a
    // card in; its answer entry is the settings page. The inline agent asks
    // BEFORE announcing any tool call, so the line lands in the open segment
    // (a sessionless turn cannot resume a card-bearing segment — there is no
    // controller lookup key to find).
    const plainScript = [
      '(async () => {',
      "  const { agent, methods, ndJsonStream, PROTOCOL_VERSION } = await import('@agentclientprotocol/sdk')",
      "  const { Writable, Readable } = require('node:stream')",
      "  agent({ name: 'plain-ask-fake' })",
      '    .onRequest(methods.agent.initialize, () => ({',
      '      protocolVersion: PROTOCOL_VERSION,',
      "      agentCapabilities: { loadSession: false, promptCapabilities: { image: false, audio: false, embeddedContext: false } },",
      '      authMethods: [],',
      '    }))',
      "    .onRequest(methods.agent.session.new, () => ({ sessionId: 'plain-ask-1' }))",
      '    .onRequest(methods.agent.session.prompt, async ctx => {',
      '      await ctx.client.request(methods.client.session.requestPermission, {',
      '        sessionId: ctx.params.sessionId,',
      "        toolCall: { toolCallId: 'c1', title: 'Bash' },",
      "        options: [{ optionId: 'allow1', name: 'Allow once', kind: 'allow_once' }],",
      '      })',
      '      await ctx.client.notify(methods.client.session.update, {',
      '        sessionId: ctx.params.sessionId,',
      "        update: { sessionUpdate: 'agent_message_chunk', messageId: 'm1', content: { type: 'text', text: 'PLAIN DONE' } },",
      '      })',
      "      return { stopReason: 'end_turn' }",
      '    })',
      '    .connect(ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)))',
      '})()',
    ].join('\n')
    const plainHub = new EventHub()
    const plainEvents: AcpEvent[] = []
    plainHub.subscribe(event => { plainEvents.push(event) })
    const plainManager = new BridgeManager([{
      ...def,
      id: 'plain-ask',
      args: ['-e', plainScript],
      cwd: process.cwd(),
      allowedCwdRoots: [process.cwd()],
    }], plainHub, 500)
    const answers = plainHub.subscribe(event => {
      if (event.type !== 'permission/request') return
      void dispatchRpc(plainManager, 'permission/respond', { requestId: event.requestId, optionId: 'allow1' })
    })
    try {
      const parts: string[] = []
      for await (const chunk of new AcpLlmAdapter(plainManager).stream({
        provider: 'acp',
        model: 'plain-ask',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'PERM rpc line' }] }],
      })) {
        if (chunk.type === 'reasoning-delta') parts.push(chunk.text)
      }
      const frame = plainEvents.find((event): event is Extract<AcpEvent, { type: 'permission/request' }> => event.type === 'permission/request')
      expect(frame).toBeDefined()
      expect(frame).not.toHaveProperty('dshSessionId')
      expect(parts.join('')).toContain('please approve in Settings')
      expect(parts.join('')).not.toContain('above the composer')
    } finally {
      answers()
      await plainManager.shutdownAll()
    }
  }, 30_000)

  it('derives the tool name from _meta when the agent omits title', async () => {
    // Real codebuddy sends the name in `_meta["codebuddy.ai/toolName"]` and
    // omits the optional `title`; the frame (and therefore the card and the
    // chat line) must still name the operation.
    const metaScript = [
      '(async () => {',
      "  const { agent, methods, ndJsonStream, PROTOCOL_VERSION } = await import('@agentclientprotocol/sdk')",
      "  const { Writable, Readable } = require('node:stream')",
      "  agent({ name: 'meta-fake' })",
      '    .onRequest(methods.agent.initialize, () => ({',
      '      protocolVersion: PROTOCOL_VERSION,',
      "      agentCapabilities: { loadSession: false, promptCapabilities: { image: false, audio: false, embeddedContext: false } },",
      '      authMethods: [],',
      '    }))',
      "    .onRequest(methods.agent.session.new, () => ({ sessionId: 'meta-1' }))",
      '    .onRequest(methods.agent.session.prompt, async ctx => {',
      '      const response = await ctx.client.request(methods.client.session.requestPermission, {',
      '        sessionId: ctx.params.sessionId,',
      "        toolCall: { toolCallId: 'call_meta', _meta: { 'codebuddy.ai/toolName': 'Bash' } },",
      "        options: [{ optionId: 'allow1', name: 'Allow once', kind: 'allow_once' }],",
      '      })',
      "      const answer = response.outcome.outcome === 'selected' ? response.outcome.optionId : 'cancelled'",
      '      await ctx.client.notify(methods.client.session.update, {',
      '        sessionId: ctx.params.sessionId,',
      "        update: { sessionUpdate: 'agent_message_chunk', messageId: 'm1', content: { type: 'text', text: `META:${answer}` } },",
      '      })',
      "      return { stopReason: 'end_turn' }",
      '    })',
      '    .connect(ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)))',
      '})()',
    ].join('\n')
    const metaHub = new EventHub()
    const metaEvents: AcpEvent[] = []
    metaHub.subscribe(event => { metaEvents.push(event) })
    const metaManager = new BridgeManager([{
      ...def,
      id: 'meta',
      args: ['-e', metaScript],
      cwd: process.cwd(),
      allowedCwdRoots: [process.cwd()],
    }], metaHub, 500)
    const metaAdapter = new AcpLlmAdapter(metaManager)
    try {
      const drained = (async () => {
        for await (const chunk of metaAdapter.stream({
          provider: 'acp',
          model: 'meta',
          sessionId: 'dsh-meta-name',
          messages: [{ role: 'user', content: [{ type: 'text', text: 'PERM meta name' }] }],
        })) void chunk
      })()
      const request = await new Promise<Extract<AcpEvent, { type: 'permission/request' }>>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('timeout waiting for permission/request')), 15_000)
        const unsub = metaHub.subscribe(event => {
          if (event.type === 'permission/request') {
            clearTimeout(timer)
            unsub()
            resolve(event)
          }
        })
      })
      expect(request.toolName).toBe('Bash')
      expect(request.reason).toBe('Bash')
      expect(request.toolCall).toMatchObject({ _meta: { 'codebuddy.ai/toolName': 'Bash' } })
      await dispatchRpc(metaManager, 'permission/respond', { requestId: request.requestId, optionId: 'allow1' })
      await drained
      await settleTranscript(metaManager, request.sessionId)
      const transcript = await dispatchRpc(metaManager, 'transcript/get', { sessionId: request.sessionId })
      if (!transcript.ok) throw new Error('transcript failed')
      const echo = (transcript.value as { entries: Array<{ update: Record<string, unknown> }> }).entries
        .filter(e => e.update.sessionUpdate === 'agent_message_chunk')
        .map(e => String((e.update.content as { text?: string }).text ?? ''))
        .join('')
      expect(echo).toContain('META:allow1')
      void metaEvents
    } finally {
      await metaManager.shutdownAll()
    }
  }, 30_000)

  it('replays a pending ask with exactly the live frame fields', async () => {
    // The request frame is broadcast once. A client connecting later must get
    // the SAME fields back, or its conversation card (which filters on
    // `dshSessionId` and renders `toolName`/`deadlineAt`) drops the ask.
    const since = askEvents.length
    const parts: string[] = []
    const drained = (async () => {
      const { chunks } = await hostLoopTurn(askAdapter, {
        provider: 'acp',
        model: 'ask',
        sessionId: 'dsh-ask-replay',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'PERM ask replay' }] }],
      })
      for (const chunk of chunks) {
        if (chunk.type === 'reasoning-delta') parts.push(chunk.text)
      }
    })()
    const request = await askWaitFor('permission/request', since, () => true)
    const views = askManager.pendingPermissionViews()
    expect(views).toHaveLength(1)
    expect(permissionReplayFrames(views)).toEqual([
      request,
      { type: 'permission/synced', requestIds: [request.requestId] },
    ])
    await dispatchRpc(askManager, 'permission/respond', { requestId: request.requestId, optionId: 'allow1' })
    await drained
    expect(parts.join('')).toContain('please answer the permission card above the composer')
    expect(askManager.pendingPermissionViews()).toHaveLength(0)
  }, 30_000)
})

/**
 * The ONE deadline every ask carries.
 *
 * There is no second route any more: a chat-bound ask and an `/acp`-RPC ask
 * are both ledger entries, and an ask nobody answers is settled HERE — with
 * `abort` refusing it, `auto` picking the option the agent's own kinds imply,
 * or `wait` never expiring. Each expiry must leave exactly one notice and one
 * `permission/expired` frame: the card disappears, so the conversation would
 * otherwise show nothing about what happened to the question.
 */
describe('a ledger deadline settles an unanswered ask in place (isolated manager)', () => {
  const deadlineHub = new EventHub()
  const deadlineEvents: AcpEvent[] = []
  deadlineHub.subscribe(event => { deadlineEvents.push(event) })
  // A shortened window so the case runs in seconds instead of the production
  // five minutes. The mode is `abort` because this case IS about the deadline
  // firing — the plugin's own default is `wait` (never expire).
  const deadlineManager = new BridgeManager([{ ...def, id: 'deadline' }], deadlineHub, 500, undefined, undefined, true, { permissionTimeoutMs: 2_000, permissionTimeoutMode: 'abort' })
  const deadlineAdapter = new AcpLlmAdapter(deadlineManager)

  afterAll(async () => {
    await deadlineManager.shutdownAll()
  })

  function deadlineWaitFor<T extends AcpEvent['type']>(type: T, since: number, predicate: (event: Extract<AcpEvent, { type: T }>) => boolean, timeoutMs = 15_000): Promise<Extract<AcpEvent, { type: T }>> {
    const matches = (event: AcpEvent): event is Extract<AcpEvent, { type: T }> =>
      event.type === type && predicate(event as Extract<AcpEvent, { type: T }>)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout waiting for ${type}`)), timeoutMs)
      const unsub = deadlineHub.subscribe(event => {
        if (deadlineEvents.indexOf(event) >= since && matches(event)) {
          clearTimeout(timer)
          unsub()
          resolve(event)
        }
      })
      const existing = deadlineEvents.find((event, index) => index >= since && matches(event))
      if (existing !== undefined) {
        clearTimeout(timer)
        unsub()
        resolve(existing)
      }
    })
  }

  /** Drain one adapter turn, collecting the reasoning text it streamed. */
  async function deadlineTurn(sessionId: string, text: string): Promise<{ reasoning: () => string; drained: Promise<void> }> {
    const parts: string[] = []
    const drained = (async () => {
      const { chunks } = await hostLoopTurn(deadlineAdapter, {
        provider: 'acp',
        model: 'deadline',
        sessionId,
        messages: [{ role: 'user', content: [{ type: 'text', text }] }],
      })
      for (const chunk of chunks) {
        if (chunk.type === 'reasoning-delta') parts.push(chunk.text)
      }
    })()
    return { reasoning: () => parts.join(''), drained }
  }

  async function deadlineEcho(sessionId: string): Promise<string> {
    await settleTranscript(deadlineManager, sessionId)
    const transcript = await dispatchRpc(deadlineManager, 'transcript/get', { sessionId })
    if (!transcript.ok) throw new Error('transcript failed')
    return (transcript.value as { entries: Array<{ update: Record<string, unknown> }> }).entries
      .filter(e => e.update.sessionUpdate === 'agent_message_chunk')
      .map(e => String((e.update.content as { text?: string }).text ?? ''))
      .join('')
  }

  it('refuses once and leaves an expiry trace in the conversation', async () => {
    const since = deadlineEvents.length
    const { reasoning, drained } = await deadlineTurn('dsh-deadline-abort', 'PERM deadline abort')
    const request = await deadlineWaitFor('permission/request', since, () => true)

    // Nobody answers. The deadline settles the SAME ledger entry: the
    // conversation gets one expiry frame, and the ledger notice fires once.
    const expired = await deadlineWaitFor('permission/expired', since, event => event.sessionId === request.sessionId)
    expect(expired).toMatchObject({
      sessionId: request.sessionId,
      toolCall: { title: 'mock dangerous operation' },
      timeoutMs: 2_000,
      outcome: { outcome: 'cancelled' },
    })
    expect(expired).not.toHaveProperty('optionName')
    const notices = deadlineEvents.slice(since).filter((event): event is Extract<AcpEvent, { type: 'agent/notice' }> =>
      event.type === 'agent/notice' && event.text.includes('timed out after 2s'))
    expect(notices).toHaveLength(1)
    expect(notices[0]?.text).toContain('refused')

    await drained
    expect(reasoning()).toContain('no answer within 2s; refused')
    expect(await deadlineEcho(request.sessionId)).toContain('perm=cancelled')
    // The entry is gone: answering now is an error, not a second chance.
    const late = await dispatchRpc(deadlineManager, 'permission/respond', { requestId: request.requestId, optionId: 'allow1' })
    expect(late).toMatchObject({ ok: false, error: { code: 'unknown_request' } })
    expect(deadlineManager.pendingPermissionViews()).toHaveLength(0)
  }, 30_000)

  it('carries the deadline on the frame and words the chat line with it', async () => {
    const since = deadlineEvents.length
    const { reasoning, drained } = await deadlineTurn('dsh-deadline-line', 'PERM deadline line')
    const request = await deadlineWaitFor('permission/request', since, () => true)
    expect(request.timeoutMode).toBe('abort')
    expect(typeof request.deadlineAt).toBe('number')
    expect(request.deadlineAt).toBeGreaterThan(Date.now())

    // A human answers on the card; the armed deadline is cleared with it.
    await dispatchRpc(deadlineManager, 'permission/respond', { requestId: request.requestId, optionId: 'allow1' })
    await drained
    expect(reasoning()).toContain('please answer the permission card above the composer within 2s or this request is cancelled')
    expect(await deadlineEcho(request.sessionId)).toContain('perm=allow1')
  }, 30_000)

  it('answers automatically in auto mode and says which option it picked', async () => {
    const autoHub = new EventHub()
    const autoEvents: AcpEvent[] = []
    autoHub.subscribe(event => { autoEvents.push(event) })
    const autoManager = new BridgeManager([{ ...def, id: 'autodeadline' }], autoHub, 500, undefined, undefined, true, {
      permissionTimeoutMs: 600,
      permissionTimeoutMode: 'auto',
    })
    const autoAdapter = new AcpLlmAdapter(autoManager)
    const autoWaitFor = <T extends AcpEvent['type']>(type: T, predicate: (event: Extract<AcpEvent, { type: T }>) => boolean, timeoutMs = 15_000): Promise<Extract<AcpEvent, { type: T }>> => {
      const matches = (event: AcpEvent): event is Extract<AcpEvent, { type: T }> =>
        event.type === type && predicate(event as Extract<AcpEvent, { type: T }>)
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timeout waiting for ${type}`)), timeoutMs)
        const unsub = autoHub.subscribe(event => {
          if (matches(event)) {
            clearTimeout(timer)
            unsub()
            resolve(event)
          }
        })
        const existing = autoEvents.find(matches)
        if (existing !== undefined) {
          clearTimeout(timer)
          unsub()
          resolve(existing)
        }
      })
    }
    try {
      const parts: string[] = []
      const drained = (async () => {
        const { chunks } = await hostLoopTurn(autoAdapter, {
          provider: 'acp',
          model: 'autodeadline',
          sessionId: 'dsh-deadline-auto',
          messages: [{ role: 'user', content: [{ type: 'text', text: 'PERM deadline auto' }] }],
        })
        for (const chunk of chunks) {
          if (chunk.type === 'reasoning-delta') parts.push(chunk.text)
        }
      })()
      const request = await autoWaitFor('permission/request', () => true)
      expect(request.timeoutMode).toBe('auto')
      // The agent's own kinds imply allow_once first; the plugin answers with
      // it and says so, because nobody looked at the approval.
      const expired = await autoWaitFor('permission/expired', event => event.sessionId === request.sessionId)
      expect(expired).toMatchObject({
        outcome: { outcome: 'selected', optionId: 'allow1' },
        optionName: 'Allow once',
      })
      const notices = autoEvents.filter((event): event is Extract<AcpEvent, { type: 'agent/notice' }> =>
        event.type === 'agent/notice' && event.text.includes('answered "Allow once"'))
      expect(notices).toHaveLength(1)
      await drained
      expect(parts.join('')).toContain('no answer within 1s; answered "Allow once" automatically, continuing')
      const transcript = await dispatchRpc(autoManager, 'transcript/get', { sessionId: request.sessionId })
      if (!transcript.ok) throw new Error('transcript failed')
      const echo = (transcript.value as { entries: Array<{ update: Record<string, unknown> }> }).entries
        .filter(e => e.update.sessionUpdate === 'agent_message_chunk')
        .map(e => String((e.update.content as { text?: string }).text ?? ''))
        .join('')
      expect(echo).toContain('perm=allow1')
    } finally {
      await autoManager.shutdownAll()
    }
  }, 30_000)
})

/**
 * A deadline adopted from the settings page.
 *
 * The whole point of the settings card over a config-file edit: the window
 * changes WITHOUT restarting the bridge, which would cost the user every
 * running session. Pass the new number to a live bridge, then run a turn — an
 * ask raised after the write must follow it, and the frame / notice / chat
 * line must all say the same thing.
 */
describe('a rewritten deadline reaches the next ask (isolated manager)', () => {
  it('adopts a deadline the settings page writes while a session is live', async () => {
    const hotHub = new EventHub()
    const hotEvents: AcpEvent[] = []
    hotHub.subscribe(event => { hotEvents.push(event) })
    const hotManager = new BridgeManager([{ ...def, id: 'hot' }], hotHub, 500, undefined, undefined, true, {
      permissionTimeoutMs: 600_000,
      // The write below shortens the window; the MODE is what makes an expiry
      // do something, and the plugin's default (`wait`) never expires.
      permissionTimeoutMode: 'abort',
    })
    const hotWaitFor = <T extends AcpEvent['type']>(type: T, since: number, predicate: (event: Extract<AcpEvent, { type: T }>) => boolean, timeoutMs = 15_000): Promise<Extract<AcpEvent, { type: T }>> => {
      const matches = (event: AcpEvent): event is Extract<AcpEvent, { type: T }> =>
        event.type === type && predicate(event as Extract<AcpEvent, { type: T }>)
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timeout waiting for ${type}`)), timeoutMs)
        const unsub = hotHub.subscribe(event => {
          if (hotEvents.indexOf(event) >= since && matches(event)) {
            clearTimeout(timer)
            unsub()
            resolve(event)
          }
        })
        const existing = hotEvents.find((event, index) => index >= since && matches(event))
        if (existing !== undefined) {
          clearTimeout(timer)
          unsub()
          resolve(existing)
        }
      })
    }
    try {
      // The settings write, on a manager that has never run a turn.
      await hotManager.setApprovalDeadlines({ permissionTimeoutMs: 600 })
      const since = hotEvents.length
      const parts: string[] = []
      const drained = (async () => {
        const { chunks } = await hostLoopTurn(new AcpLlmAdapter(hotManager), {
          provider: 'acp',
          model: 'hot',
          sessionId: 'dsh-hot-deadline',
          messages: [{ role: 'user', content: [{ type: 'text', text: 'PERM hot deadline' }] }],
        })
        for (const chunk of chunks) {
          if (chunk.type === 'reasoning-delta') parts.push(chunk.text)
        }
      })()
      const request = await hotWaitFor('permission/request', since, () => true)
      // The frame describes the NEW 600ms window, not the 600s one the
      // bridge was built with.
      expect(request.timeoutMode).toBe('abort')
      expect(request.deadlineAt! - Date.now()).toBeLessThan(2_000)
      // Settled on that window, with one notice and one expiry frame.
      const expired = await hotWaitFor('permission/expired', since, () => true)
      expect(expired).toMatchObject({ timeoutMs: 600, outcome: { outcome: 'cancelled' } })
      const notice = await hotWaitFor('agent/notice', since, event => event.text.includes('timed out after 1s'), 5_000)
      expect(notice.text).toContain('refused')
      await drained
      expect(parts.join('')).toContain('please answer the permission card above the composer within 1s or this request is cancelled')
      expect(parts.join('')).toContain('no answer within 1s; refused')
    } finally {
      await hotManager.shutdownAll()
    }
  }, 30_000)
})

/**
 * Withdrawal and close ordering at the `AgentBridge` level.
 *
 * The ACP request's own `signal` is how an ask disappears without an answer:
 * the agent withdrew it, or the connection died. A withdrawn ask must leave
 * the ledger (and broadcast `permission/resolved`), or its card sits there
 * forever and `hasActiveWork` never clears. The mock agent cannot cancel its
 * own outgoing request, so these cases drive the bridge directly.
 */
describe('permission ask withdrawal and close ordering (AgentBridge)', () => {
  type AskSeam = {
    acpIndex: Map<string, unknown>
    conn?: unknown
    state: string
    handlePermissionRequest(
      acpSessionId: string,
      toolCall: unknown,
      options: Array<{ optionId: string; name: string; kind: string }>,
      signal?: AbortSignal,
    ): Promise<{ outcome: { outcome: string; optionId?: string } }>
    closeSession(session: unknown, reason: string): Promise<void>
  }

  const askOptions = [{ optionId: 'allow1', name: 'Allow once', kind: 'allow_once' }]

  it('settles a signal-aborted ask as cancelled and drops its card', async () => {
    const hub = new EventHub()
    const events: AcpEvent[] = []
    hub.subscribe(event => { events.push(event) })
    const bridge = new AgentBridge({ ...def, id: 'withdraw' }, hub, 500, () => {})
    const seam = bridge as unknown as AskSeam
    seam.acpIndex.set('acp-withdraw', { sessionId: 'host-withdraw', acpSessionId: 'acp-withdraw', closed: false })

    const controller = new AbortController()
    const answered = seam.handlePermissionRequest('acp-withdraw', { title: 'Bash' }, askOptions, controller.signal)
    const request = events.find((event): event is Extract<AcpEvent, { type: 'permission/request' }> => event.type === 'permission/request')
    expect(request).toBeDefined()
    expect(bridge.permissions.has(request!.requestId)).toBe(true)

    controller.abort()
    await expect(answered).resolves.toEqual({ outcome: { outcome: 'cancelled' } })
    expect(events.find(event => event.type === 'permission/resolved')).toMatchObject({
      requestId: request!.requestId,
      sessionId: 'host-withdraw',
      outcome: { outcome: 'cancelled' },
    })
    expect(bridge.permissions.has(request!.requestId)).toBe(false)
  })

  it('removes the abort listener once the ask is answered', async () => {
    const hub = new EventHub()
    const events: AcpEvent[] = []
    hub.subscribe(event => { events.push(event) })
    const bridge = new AgentBridge({ ...def, id: 'detach' }, hub, 500, () => {})
    const seam = bridge as unknown as AskSeam
    seam.acpIndex.set('acp-detach', { sessionId: 'host-detach', acpSessionId: 'acp-detach', closed: false })

    const controller = new AbortController()
    const answered = seam.handlePermissionRequest('acp-detach', { title: 'Bash' }, askOptions, controller.signal)
    const request = events.find((event): event is Extract<AcpEvent, { type: 'permission/request' }> => event.type === 'permission/request')
    bridge.permissions.respond(request!.requestId, { outcome: 'selected', optionId: 'allow1' })
    await expect(answered).resolves.toEqual({ outcome: { outcome: 'selected', optionId: 'allow1' } })
    // Aborting after the answer must be a no-op, not a second resolution.
    controller.abort()
    expect(events.filter(event => event.type === 'permission/resolved')).toHaveLength(1)
    expect(bridge.permissions.has(request!.requestId)).toBe(false)
  })

  it('settles outstanding asks before waiting for session/close', async () => {
    const hub = new EventHub()
    const bridge = new AgentBridge({ ...def, id: 'close-order' }, hub, 500, () => {})
    const seam = bridge as unknown as AskSeam
    const session = { sessionId: 'host-close', acpSessionId: 'acp-close', closed: false, running: true }
    seam.acpIndex.set('acp-close', session)

    const asked = seam.handlePermissionRequest('acp-close', { title: 'Bash' }, askOptions)
    expect(bridge.permissions.sessionIds()).toHaveLength(1)

    // A `session/close` the agent never answers (it is blocked on the ask).
    let releaseClose: (() => void) | undefined
    const closeGate = new Promise<void>(resolve => { releaseClose = resolve })
    const closeCalls: unknown[] = []
    seam.state = 'ready'
    seam.conn = { agent: { request: (_method: string, params: unknown) => { closeCalls.push(params); return closeGate } } }

    const closing = seam.closeSession(session, 'closed')
    // The ask settles even though `session/close` is still in flight: settling
    // first is what keeps a waiting agent from holding the close open.
    await expect(Promise.race([asked, new Promise(resolve => setTimeout(() => resolve('still-pending'), 200))]))
      .resolves.toEqual({ outcome: { outcome: 'cancelled' } })
    expect(closeCalls).toHaveLength(1)
    releaseClose!()
    await closing
    expect(bridge.permissions.sessionIds()).toHaveLength(0)
  })
})

/**
 * The zero window: 不等待 — the ask is settled the moment it arrives.
 *
 * A window of `0` does not mean "waited for zero seconds"; it means nobody is
 * going to be asked at all, so the ledger never creates an entry and never
 * broadcasts a card (there would be nothing to answer).
 *
 * This rung belongs to the **auto** mode: it ANSWERS the ask with the option
 * the agent's own kinds imply, so the agent continues. Under `abort` the same
 * zero would REFUSE every ask on arrival — the agent stops at every gate it
 * meets, which is not a timeout but a wall — so `abort` never offers it and
 * floors to the shortest real wait. `wait` keeps its own meaning (it never
 * expires), so a zero window under it still waits for the human.
 */
describe('a zero window settles the ask without asking anyone (isolated manager)', () => {
  interface ZeroCase {
    events: AcpEvent[]
    /** How many `permission/request` frames were broadcast. */
    requested: number
    /** Asks still waiting for an answer on the ledger. */
    pending: number
    /** The window actually in force. */
    effectiveWindow: number
    reasoning: string
    echo: string
  }

  /**
   * Run one PERM turn on a manager whose window is `0`. Any ask that DOES
   * reach the ledger is answered the way the browser's card would, so a
   * floored window (abort / wait) cannot hang the turn.
   */
  async function zeroCase(id: string, mode: 'auto' | 'abort' | 'wait'): Promise<ZeroCase> {
    const caseHub = new EventHub()
    const caseEvents: AcpEvent[] = []
    caseHub.subscribe(event => { caseEvents.push(event) })
    const caseManager = new BridgeManager([{ ...def, id }], caseHub, 500, undefined, undefined, false, {
      permissionTimeoutMs: 0,
      permissionTimeoutMode: mode,
    })
    const answers = caseHub.subscribe(event => {
      if (event.type !== 'permission/request') return
      void dispatchRpc(caseManager, 'permission/respond', { requestId: event.requestId, optionId: 'allow1' })
    })
    const adapter = new AcpLlmAdapter(caseManager)
    const parts: string[] = []
    const sessionKey = `dsh-zero-${id}`
    const prompt = `PERM zero ${id}`
    try {
      const { chunks } = await hostLoopTurn(adapter, {
        provider: 'acp',
        model: id,
        sessionId: sessionKey,
        messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
      })
      for (const chunk of chunks) {
        if (chunk.type === 'reasoning-delta') parts.push(chunk.text)
      }
      // The transcript is addressed by the ACP session id, which the turn
      // announced — not by the chat session key the adapter was given.
      const turn = caseEvents.find(e => e.type === 'turn/start' && e.text === prompt)
      if (turn?.sessionId === undefined) throw new Error('no turn started')
      await settleTranscript(caseManager, turn.sessionId)
      const transcript = await dispatchRpc(caseManager, 'transcript/get', { sessionId: turn.sessionId })
      if (!transcript.ok) throw new Error('transcript failed')
      const echo = (transcript.value as { entries: Array<{ update: Record<string, unknown> }> }).entries
        .filter(e => e.update.sessionUpdate === 'agent_message_chunk')
        .map(e => String((e.update.content as { text?: string }).text ?? ''))
        .join('')
      return {
        events: caseEvents,
        requested: caseEvents.filter(e => e.type === 'permission/request').length,
        pending: caseManager.pendingPermissionViews().length,
        effectiveWindow: caseManager.approvalDeadlines().permissionTimeoutMs,
        reasoning: parts.join(''),
        echo,
      }
    } finally {
      answers()
      await caseManager.shutdownAll()
    }
  }

  it('auto: answers on the spot, with no card at all', async () => {
    const result = await zeroCase('zeroauto', 'auto')
    // No card was broadcast, and no ledger entry was left waiting: the ask was
    // answered before it could reach a page.
    expect(result.requested).toBe(0)
    expect(result.pending).toBe(0)
    // The window in force IS 不等待.
    expect(result.effectiveWindow).toBe(0)
    // The agent still got an answer — the option its own kinds imply.
    expect(result.echo).toContain('perm=allow1')
    // And the conversation says so. "not waited for" is not "waited 0 seconds":
    // the two say different things to the human reading the transcript.
    expect(result.reasoning).toContain('not waited for; answered "Allow once" automatically, continuing')
    const notices = result.events.filter((event): event is Extract<AcpEvent, { type: 'agent/notice' }> => event.type === 'agent/notice')
    expect(notices).toHaveLength(1)
    expect(notices[0]?.text).toContain('was not waited for; answered "Allow once"')
  }, 30_000)

  it('abort: never settles on arrival — the floored window still asks the human', async () => {
    const result = await zeroCase('zeroabort', 'abort')
    // 不等待 is the auto mode's rung. Under 超时中止 a zero window would
    // refuse every ask the instant it arrived: the agent stops at every gate
    // it meets. So the window floors to the shortest REAL wait.
    expect(result.effectiveWindow).toBe(30_000)
    // Which means the ask DID reach the ledger — the question was not answered
    // behind the human's back.
    expect(result.requested).toBe(1)
    expect(result.echo).toContain('perm=allow1')
    // Nothing settled it on arrival: no expiry, no notice.
    expect(result.events.filter(e => e.type === 'permission/expired')).toHaveLength(0)
    expect(result.events.filter(e => e.type === 'agent/notice')).toHaveLength(0)
  }, 30_000)

  it('wait: keeps waiting, because the mode owns "never expires"', async () => {
    const result = await zeroCase('zerowait', 'wait')
    // `wait` says the ask never expires. The window is the OTHER axis, and the
    // mode outranks it — a wait-mode ask still reaches the human.
    expect(result.requested).toBe(1)
    expect(result.echo).toContain('perm=allow1')
    // Nothing settled it behind the human's back.
    expect(result.events.filter(e => e.type === 'permission/expired')).toHaveLength(0)
    expect(result.events.filter(e => e.type === 'agent/notice')).toHaveLength(0)
  }, 30_000)
})

/**
 * The `wait` mode keeps an ask pending.
 *
 * `wait` means "never expire": the ask stays on the ledger, visibly, until a
 * human answers it or the session is cancelled — no notice, no automatic
 * answer, and no deadline clause in the chat line.
 */
describe('the wait mode keeps an ask pending (isolated manager)', () => {
  it('never settles on its own and carries no deadline clause', async () => {
    const waitHub = new EventHub()
    const waitEvents: AcpEvent[] = []
    waitHub.subscribe(event => { waitEvents.push(event) })
    const waitManager = new BridgeManager([{ ...def, id: 'wait' }], waitHub, 500, undefined, undefined, true, {
      permissionTimeoutMs: 150,
      permissionTimeoutMode: 'wait',
    })
    const waitAdapter = new AcpLlmAdapter(waitManager)
    try {
      const since = waitEvents.length
      const parts: string[] = []
      const waitDrained = hostLoopTurn(waitAdapter, {
        provider: 'acp',
        model: 'wait',
        sessionId: 'dsh-plain-wait',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'PERM plain wait' }] }],
      })
      const request = await new Promise<Extract<AcpEvent, { type: 'permission/request' }>>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('timeout waiting for permission/request')), 15_000)
        const unsub = waitHub.subscribe(event => {
          if (waitEvents.indexOf(event) >= since && event.type === 'permission/request') {
            clearTimeout(timer)
            unsub()
            resolve(event)
          }
        })
      })

      // Well past the window: no notice, no auto-answer, and the ledger entry
      // is still there waiting for the human.
      await new Promise(resolve => setTimeout(resolve, 600))
      expect(waitEvents.slice(since).filter(e => e.type === 'agent/notice')).toHaveLength(0)
      expect(waitManager.pendingPermissionViews()).toHaveLength(1)
      const responded = await dispatchRpc(waitManager, 'permission/respond', { requestId: request.requestId, optionId: 'allow1' })
      expect(responded.ok).toBe(true)
      const { chunks } = await waitDrained
      for (const chunk of chunks) {
        if (chunk.type === 'reasoning-delta') parts.push(chunk.text)
      }
      // No deadline clause: nothing is going to happen on its own.
      expect(parts.join('')).toContain('please answer the permission card above the composer')
      expect(parts.join('')).not.toContain('within')
    } finally {
      await waitManager.shutdownAll()
    }
  }, 30_000)
})

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
    // The card's arguments came from the update's content (the call itself
    // disclosed no input), so the executed card shows the tool's output text.
    const cardArgs = first
      .filter((c): c is Extract<StreamChunk, { type: 'tool-call-delta' }> => c.type === 'tool-call-delta')
      .map(c => c.argumentsDelta).join('')
    expect(cardArgs).toBe('FAKE TOOL OUTPUT')

    // Step 2 (the continuation) carries the post-call answer and NO card: the
    // turn's last settled message is tool-free, so the loop completes here.
    expect(textOf(second)).toContain('POST-CALL ANSWER')
    expect(second.some(c => c.type === 'tool-call-delta')).toBe(false)
    expect(second.find(c => c.type === 'finish')?.reason).toEqual({ kind: 'stop' })
    expect(chunks.find(c => c.type === 'finish')?.reason).toEqual({ kind: 'stop' })

    // The tool's output reached the shared registry — the guard's virtual tool
    // answers the host loop's execution of the card from it.
    expect(routeBindingRegistry().toolResults.get('c1')).toContain('FAKE TOOL OUTPUT')
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


/**
 * Permission mapping and the agent's own modes.
 *
 * The retired axis resolved a DSH access mode and pre-judged every ask against
 * it. It is gone: an ACP agent is fully autonomous, so the ask the agent raises
 * is what reaches the human — unchanged — through this plugin's own permission
 * ledger (the conversation card). The workspace resolver these cases used to
 * fake as an access mode is now just the workspace reader (`src/index.ts`'s
 * `wireWorkspace`), so they still exercise the production path without a live
 * DSH host.
 */
describe('permission mapping and the agent\'s own modes (isolated manager)', () => {
  const modeHub = new EventHub()
  const modeEvents: AcpEvent[] = []
  modeHub.subscribe(event => { modeEvents.push(event) })
  const modeManager = new BridgeManager([{ ...def, id: 'moded' }], modeHub, 500)
  const modeAdapter = new AcpLlmAdapter(modeManager)

  afterAll(async () => {
    await modeManager.shutdownAll()
  })

  it('names the tool an ask is about, whatever field the agent declared it in', () => {
    // `title` is OPTIONAL in ACP and real agents omit it: codebuddy sends the
    // name in `_meta["codebuddy.ai/toolName"]` (observed live — without the
    // fallback the timeout notice reads `for "tool call"`, which tells the
    // human nothing about what they missed).
    expect(permissionToolName({ title: 'mock dangerous operation' })).toBe('mock dangerous operation')
    expect(permissionToolName({ _meta: { 'codebuddy.ai/toolName': 'Bash' } })).toBe('Bash')
    expect(permissionToolName({ _meta: { toolName: 'Edit' } })).toBe('Edit')
    expect(permissionToolName({ kind: 'execute' })).toBe('execute')
    expect(permissionToolName({})).toBe('tool call')
    expect(permissionToolName(undefined)).toBe('tool call')
    // A non-string or empty declaration is not a name; the chain keeps going.
    expect(permissionToolName({ title: '', _meta: { 'x/toolName': 'Bash' } })).toBe('Bash')
    expect(permissionToolName({ _meta: { 'x/toolName': 42 } })).toBe('tool call')
  })

  it('turns the declared tool input into the approval card headline', () => {
    // The host card body is `reason ?? "工具 X 请求越权执行"`; a bare tool name
    // tells the human nothing about the operation they are approving.
    expect(permissionAskReason({ title: 'mock dangerous operation' })).toBe('mock dangerous operation')
    expect(permissionAskReason({ title: 'Bash', rawInput: { command: 'npm test' } })).toBe('Bash · npm test')
    // A JSON-string rawInput is read for the same scalar, not echoed whole.
    expect(permissionAskReason({ title: 'Bash', rawInput: '{"cmd":"ls -la"}' })).toBe('Bash · ls -la')
    // The scalar already equal to the title is not repeated.
    expect(permissionAskReason({ title: 'ls -la', rawInput: { command: 'ls -la' } })).toBe('ls -la')
    // Arrays and unknown shapes never become the headline.
    expect(permissionAskReason({ title: 'Edit', rawInput: [{ path: 'a.md' }] })).toBe('Edit')
    expect(permissionAskReason({ title: 'Edit', rawInput: { mystery: 'x' } })).toBe('Edit')
    // Capped: a pathological command cannot fill the card or the audit log.
    const reason = permissionAskReason({ title: 'Bash', rawInput: { command: 'x'.repeat(1000) } })
    expect(reason.length).toBe(240)
    expect(reason.endsWith('…')).toBe(true)
  })

  /** Wait for a fresh event (the hub keeps older cases' frames, so `since` is mandatory). */
  function modeWaitFor<T extends AcpEvent['type']>(type: T, since: number, predicate: (event: Extract<AcpEvent, { type: T }>) => boolean, timeoutMs = 15_000): Promise<Extract<AcpEvent, { type: T }>> {
    const matches = (event: AcpEvent): event is Extract<AcpEvent, { type: T }> =>
      event.type === type && predicate(event as Extract<AcpEvent, { type: T }>)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout waiting for ${type}`)), timeoutMs)
      const unsub = modeHub.subscribe(event => {
        if (modeEvents.indexOf(event) >= since && matches(event)) {
          clearTimeout(timer)
          unsub()
          resolve(event)
        }
      })
      const existing = modeEvents.find((event, index) => index >= since && matches(event))
      if (existing !== undefined) {
        clearTimeout(timer)
        unsub()
        resolve(existing)
      }
    })
  }

  /**
   * Run one PERM turn, answering the ask it raises the way the browser's
   * conversation card would, then read the mock agent's own echo of what it
   * saw. See the module-level `settleTranscript` for why the wait is not
   * optional.
   */
  async function modeTurn(sessionId: string, text: string, optionId = 'allow1'): Promise<string> {
    const since = modeEvents.length
    const drained = (async () => {
      for await (const chunk of modeAdapter.stream({
        provider: 'acp',
        model: 'moded',
        sessionId,
        messages: [{ role: 'user', content: [{ type: 'text', text }] }],
      })) {
        void chunk
      }
    })()
    if (text.includes('PERM')) {
      const request = await modeWaitFor('permission/request', since, () => true)
      await dispatchRpc(modeManager, 'permission/respond', { requestId: request.requestId, optionId })
    }
    await drained
    const started = modeEvents.slice(since).find(event => event.type === 'turn/start' && event.text === text)
    if (started === undefined) throw new Error('the turn never started')
    await settleTranscript(modeManager, started.sessionId)
    const transcript = await dispatchRpc(modeManager, 'transcript/get', { sessionId: started.sessionId })
    if (!transcript.ok) throw new Error('transcript failed')
    return (transcript.value as { entries: Array<{ update: Record<string, unknown> }> }).entries
      .filter(e => e.update.sessionUpdate === 'agent_message_chunk')
      .map(e => String((e.update.content as { text?: string }).text ?? ''))
      .join('')
  }

  it('maps the agent\'s own ask to the human, whatever the agent calls it', async () => {
    // The retired axis pre-judged every ask against a resolved DSH access mode
    // (and got it backwards: `never` denied everything `full access` meant to
    // allow). Now the ask the agent raises is what reaches the human —
    // unchanged — on the conversation card.
    const since = modeEvents.length
    expect(await modeTurn('dsh-perm-1', 'PERM dangerous thing')).toContain('perm=allow1')
    const request = modeEvents.slice(since).find((event): event is Extract<AcpEvent, { type: 'permission/request' }> => event.type === 'permission/request')
    expect(request).toBeDefined()
    expect(request!.toolName).toBe('mock dangerous operation')
    expect(request!.dshSessionId).toBe('dsh-perm-1')
    expect(request!.options.map(o => o.kind)).toEqual(['allow_once', 'reject_once'])
  }, 30_000)

  it('narrates nothing into the prompt, whatever the agent asks', async () => {
    // The mock echoes its whole input, so byte equality is the whole guard. A
    // permission question is answered on its card; it is never narrated into
    // the prompt the agent receives.
    expect(await modeTurn('dsh-perm-quiet', 'PERM tell me nothing'))
      .toBe('MOCK: echo PERM tell me nothing perm=allow1')
  }, 30_000)

  it('exposes and switches the agent\'s own mode for a chat session', async () => {
    await modeTurn('dsh-mode-list', 'PERM mode list')

    const listed = await dispatchRpc(modeManager, 'session/chat-list', { dshSessionId: 'dsh-mode-list' })
    if (!listed.ok) throw new Error('listing failed')
    const sessions = (listed.value as { sessions: ChatSessionView[] }).sessions
    expect(sessions).toHaveLength(1)
    expect(sessions[0]?.agentId).toBe('moded')
    expect(sessions[0]?.modes?.availableModes?.map(m => m.id)).toEqual(['default', 'strict'])
    // A chat session the agent has not run in yet has nothing to show.
    await expect(dispatchRpc(modeManager, 'session/chat-list', { dshSessionId: 'never-ran' }))
      .resolves.toEqual({ ok: true, value: { sessions: [], acpMode: false } })

    const since = modeEvents.length
    await expect(dispatchRpc(modeManager, 'session/chat-mode-set', { dshSessionId: 'dsh-mode-list', modeId: 'strict' }))
      .resolves.toEqual({ ok: true, value: { done: true } })
    await modeWaitFor('session/meta', since, event => event.session.modes?.currentModeId === 'strict')

    // Unknown chat session → a normalized error, never a thrown exception.
    await expect(dispatchRpc(modeManager, 'session/chat-mode-set', { dshSessionId: 'never-ran', modeId: 'strict' }))
      .resolves.toMatchObject({ ok: false, error: { code: 'unknown_session' } })
  }, 30_000)

  it('reports the per-chat-session ACP-mode verdict for the composer surfaces', async () => {
    // Without the ACP-mode resolver (an older entry that never wired it) the
    // verdict is false for everything: the surfaces read "not ACP", which is
    // the allowed failure mode.
    expect(modeManager.chatSessionAcpMode('never-ran')).toBe(false)
    modeManager.setAcpModeResolver(dshSessionId => dshSessionId === 'dsh-mode-list' ? true : undefined)
    try {
      // The resolver reads the session log; only its verdict is echoed.
      expect(modeManager.chatSessionAcpMode('dsh-mode-list')).toBe(true)
      // `undefined` (unknown session) reads as "not ACP", never a guess.
      expect(modeManager.chatSessionAcpMode('never-ran')).toBe(false)
      // A settled verdict is CACHED: a resolver that later throws (a flaky
      // persistence read) must not flip a fact the log already answered.
      modeManager.setAcpModeResolver(() => { throw new Error('log unreadable') })
      expect(modeManager.chatSessionAcpMode('dsh-mode-list')).toBe(true)
      // An explicit invalidation (the log moved) is what retires the verdict.
      modeManager.invalidateAcpMode('dsh-mode-list')
      expect(modeManager.chatSessionAcpMode('dsh-mode-list')).toBe(false)
      // And the wire answer carries it, so the browser half can consume it.
      await expect(dispatchRpc(modeManager, 'session/chat-list', { dshSessionId: 'dsh-mode-list' }))
        .resolves.toMatchObject({ ok: true, value: { acpMode: false } })
      // An ASYNC resolver settles into the cache on the next ask (the cold
      // persistence read), and the wire answers with it.
      modeManager.invalidateAcpMode('dsh-mode-list')
      modeManager.setAcpModeResolver(dshSessionId => dshSessionId === 'dsh-mode-list'
        ? Promise.resolve(true)
        : undefined)
      expect(modeManager.chatSessionAcpMode('dsh-mode-list')).toBe(false)
      await new Promise(resolve => setTimeout(resolve, 10))
      expect(modeManager.chatSessionAcpMode('dsh-mode-list')).toBe(true)
      await expect(dispatchRpc(modeManager, 'session/chat-list', { dshSessionId: 'dsh-mode-list' }))
        .resolves.toMatchObject({ ok: true, value: { acpMode: true } })
    } finally {
      modeManager.setAcpModeResolver(undefined)
      modeManager.invalidateAcpMode()
    }
  })

  it('session/chat-list drops a stale cached acpMode verdict across a preset switch', async () => {
    // The browser re-asks session/chat-list on every `agent-preset/selected`; a
    // verdict cached BEFORE the switch must not be echoed, or the surface shows
    // the previous mode's answer until the next turn retires the cache. So the
    // chat-list handler invalidates the cached verdict and always folds the log
    // fresh.
    let acp = false
    modeManager.setAcpModeResolver(() => acp)
    try {
      await expect(dispatchRpc(modeManager, 'session/chat-list', { dshSessionId: 'dsh-stale-seat', refresh: true }))
        .resolves.toMatchObject({ ok: true, value: { acpMode: false } })
      // User switches the session to the ACP preset with no turn in between.
      acp = true
      await expect(dispatchRpc(modeManager, 'session/chat-list', { dshSessionId: 'dsh-stale-seat', refresh: true }))
        .resolves.toMatchObject({ ok: true, value: { acpMode: true } })
    } finally {
      modeManager.setAcpModeResolver(undefined)
      modeManager.invalidateAcpMode()
    }
  })

  it('fences fs/write_text_file by the workspace, and nothing else', async () => {
    // The access-mode layer that used to sit in front of this write is gone
    // (docs/acp-convergence.md §2.3): a DSH sandbox cannot reach into the
    // agent's own process, so a second gate here was a fiction. What remains is
    // the boundary that is real — the session's cwd and the agent's own roots.
    const dir = mkdtempSync(join(tmpdir(), 'dsh-mode-fs-'))
    const target = join(dir, 'probe.txt')

    // Inside the session's own cwd: allowed.
    expect(await modeTurn('dsh-mode-fs-in', `WRITEFILE ${target}`)).toContain('WRITE_OK')
    expect(readFileSync(target, 'utf8')).toBe('written-by-mock-agent')

    // Outside every allowed root: refused, with a message the agent's model can
    // act on (it names the path and the boundary). This suite wires no workspace
    // resolver, so the roots are the agent's own: `def.cwd` (`tmpdir()`) plus
    // its `allowedCwdRoots`. A path under the USER'S HOME is outside both.
    const outside = join(homedir(), 'dsh-ntr-escape-probe.txt')
    const denied = await modeTurn('dsh-mode-fs-out', `WRITEFILE ${outside}`)
    expect(denied).toContain('WRITE_FAIL')
    expect(denied).toContain('outside the session workspace')
    expect(existsSync(outside)).toBe(false)
  }, 30_000)
})

/**
 * A chat session must run where its DSH session lives: the workspace the user
 * selected in the sidebar, which the host reports back as the workspace
 * resolver's `workspaceRoot` (it IS the session header cwd). The agent's
 * configured `cwd` is the plugin's own sandbox directory and only serves
 * `/acp`-RPC sessions and hosts that report no workspace — an agent started in
 * it answers "current workspace" with `~/.dsh/acp-workspaces` while its
 * Read/Glob/Bash cannot see the user's project.
 */
describe('chat session workspace (isolated manager)', () => {
  const wsHub = new EventHub()
  const wsEvents: AcpEvent[] = []
  wsHub.subscribe(event => { wsEvents.push(event) })
  // Deliberately a SIBLING of the workspace: the agent's allow-list does not
  // contain the workspace, so the session can only be anchored there because
  // the host trusts the DSH session's own root for that session.
  const narrow = mkdtempSync(join(tmpdir(), 'dsh-ntr-narrow-'))
  const workspace = mkdtempSync(join(tmpdir(), 'dsh-ntr-ws-'))
  // A second agent, so the process-workspace cases start from a state the
  // earlier cases did not leave behind: their live sessions are exactly what
  // pins a process to the directory it was spawned in.
  const wsManager = new BridgeManager([
    { ...def, id: 'wsmock', cwd: narrow, allowedCwdRoots: [narrow] },
    { ...def, id: 'wsprobe', cwd: narrow, allowedCwdRoots: [narrow] },
  ], wsHub, 500)
  const wsAdapter = new AcpLlmAdapter(wsManager)
  let wsPolicy: { workspaceRoot?: string } | undefined
  wsManager.setSessionWorkspaceResolver(() => wsPolicy)

  afterAll(async () => {
    await wsManager.shutdownAll()
  })

  /** Wait for a fresh event on THIS suite's hub (the shared `waitFor` watches the top-level one). */
  function wsWaitFor<T extends AcpEvent['type']>(type: T, predicate: (event: Extract<AcpEvent, { type: T }>) => boolean, timeoutMs = 15_000): Promise<Extract<AcpEvent, { type: T }>> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout waiting for ${type}`)), timeoutMs)
      const unsub = wsHub.subscribe(event => {
        if (event.type === type && predicate(event as Extract<AcpEvent, { type: T }>)) {
          clearTimeout(timer)
          unsub()
          resolve(event as Extract<AcpEvent, { type: T }>)
        }
      })
      const existing = wsEvents.find(event => event.type === type && predicate(event as Extract<AcpEvent, { type: T }>))
      if (existing !== undefined) {
        clearTimeout(timer)
        unsub()
        resolve(existing as Extract<AcpEvent, { type: T }>)
      }
    })
  }

  /** The session's LATEST snapshot cwd (created, then reset/meta across a resume). */
  function lastCwdOf(sessionId: string): string {
    for (let i = wsEvents.length - 1; i >= 0; i--) {
      const event = wsEvents[i]
      if ((event.type === 'session/created' || event.type === 'session/meta' || event.type === 'session/reset')
        && event.sessionId === sessionId) {
        return event.session.cwd
      }
    }
    return ''
  }

  /** Drain one adapter turn; returns the agent's echo, its host session id and that session's cwd. */
  async function wsTurn(dshSessionId: string, text: string, model = 'wsmock'): Promise<{ echoed: string; hostSessionId: string; cwd: string }> {
    const since = wsEvents.length
    for await (const chunk of wsAdapter.stream({
      provider: 'acp',
      model,
      sessionId: dshSessionId,
      messages: [{ role: 'user', content: [{ type: 'text', text }] }],
    })) {
      void chunk
    }
    const started = wsEvents.slice(since).find(event => event.type === 'turn/start' && event.text === text)
    if (started === undefined) throw new Error('the turn never started')
    // A segmented turn ends this adapter stream at its first tool card; the
    // agent keeps streaming into the transcript until its prompt settles. Wait
    // for that settlement before reading, or the echo below races the last
    // chunk (the helper never runs the host loop's continuation steps).
    await wsWaitFor('turn/end', event => event.turnId === started.turnId)
    const transcript = await dispatchRpc(wsManager, 'transcript/get', { sessionId: started.sessionId })
    if (!transcript.ok) throw new Error('transcript failed')
    const echoed = (transcript.value as { entries: Array<{ update: Record<string, unknown> }> }).entries
      .filter(e => e.update.sessionUpdate === 'agent_message_chunk')
      .map(e => String((e.update.content as { text?: string }).text ?? ''))
      .join('')
    return { echoed, hostSessionId: started.sessionId, cwd: lastCwdOf(started.sessionId) }
  }

  it('anchors a chat session at the DSH session workspace, not the agent default', async () => {
    writeFileSync(join(workspace, 'in-workspace.txt'), 'seen-by-the-agent')
    wsPolicy = { workspaceRoot: workspace }
    const turn = await wsTurn('dsh-ws-chat', 'hello there')
    expect(normPath(turn.cwd)).toBe(normPath(realpathSync(workspace)))
    // The fs guard reads the session cwd, so the workspace is readable too (the
    // agent's own allow-list does not contain it).
    const read = await wsTurn('dsh-ws-chat', `READFILE ${join(workspace, 'in-workspace.txt')}`)
    expect(normPath(read.cwd)).toBe(normPath(realpathSync(workspace)))
    expect(read.echoed).toContain('READ_OK:seen-by-the-agent')
  }, 30_000)

  it('keeps the configured cwd when the host reports no workspace', async () => {
    // No `workspaceRoot` (a deployment without the sandbox policy service, or
    // an /acp-direct session): the agent's own cwd stays in charge.
    wsPolicy = {}
    const turn = await wsTurn('dsh-ws-fallback', 'hello fallback')
    expect(normPath(turn.cwd)).toBe(normPath(realpathSync(narrow)))
  }, 30_000)

  it('resumes a crashed chat session whose cwd is the DSH workspace', async () => {
    // The regression guard: `session/load` re-validates the cwd against the
    // allowed roots, so a workspace the agent's own allow-list never contained
    // must be re-trusted there too — otherwise the session parks back into
    // `released` forever with `cwd_denied`.
    wsPolicy = { workspaceRoot: workspace }
    const first = await wsTurn('dsh-ws-resume', 'DIE now')
    expect(normPath(first.cwd)).toBe(normPath(realpathSync(workspace)))
    const released = await wsWaitFor('session/released', event => event.sessionId === first.hostSessionId)
    expect(released.session.released).toBe(true)

    const resumed = await wsTurn('dsh-ws-resume', 'back again')
    expect(resumed.hostSessionId).toBe(first.hostSessionId)
    expect(normPath(resumed.cwd)).toBe(normPath(realpathSync(workspace)))
    expect(resumed.echoed).toContain('REPLAYED: earlier conversation')
    expect(resumed.echoed).toContain('MOCK: echo back again')
  }, 30_000)

  it('moves an idle process into the chat session workspace instead of leaving it in the agent default', async () => {
    // The regression guard for agents that derive their workspace from their
    // OWN cwd (codebuddy logs `Workspace Path: <process cwd>` before it reads a
    // single ACP request): `session/new`'s cwd arrives too late for them, so the
    // process has to be started in the right directory.
    //
    // In the field the process is usually already up by then — the model probe
    // spawns it first, in the agent's configured cwd — so this case reproduces
    // exactly that order.
    wsPolicy = { workspaceRoot: workspace }
    await wsManager.probeAgentModels('wsprobe')
    const restarts = wsWaitFor('agent/notice', event => event.agentId === 'wsprobe' && event.text.includes('restarts in'))
    const moved = await wsTurn('dsh-ws-proc', 'PWD please', 'wsprobe')
    expect((await restarts).text).toContain(realpathSync(workspace))
    expect(moved.echoed).toContain(`PWD:${realpathSync(workspace)}`)
    expect(moved.echoed).not.toContain(`PWD:${realpathSync(narrow)}`)

    // A live session pins the process: a second conversation in another
    // workspace must not restart it (that would kill the first one). Its own
    // ACP cwd still follows its DSH workspace, and the session that owns the
    // process keeps working — the limit is reported, not papered over.
    const other = mkdtempSync(join(tmpdir(), 'dsh-ntr-ws2-'))
    wsManager.setSessionWorkspaceResolver(id => ({
      mode: 'workspace-write',
      approval: 'ask',
      workspaceRoot: id === 'dsh-ws-proc' ? workspace : other,
    }))
    try {
      const since = wsEvents.length
      const second = await wsTurn('dsh-ws-other', 'PWD again', 'wsprobe')
      expect(normPath(second.cwd)).toBe(normPath(realpathSync(other)))
      expect(second.echoed).toContain(`PWD:${realpathSync(workspace)}`)
      expect(wsEvents.slice(since).filter(event => event.type === 'agent/notice' && event.text.includes('restarts in'))).toHaveLength(0)
      expect((await wsTurn('dsh-ws-proc', 'PWD once more', 'wsprobe')).echoed).toContain(`PWD:${realpathSync(workspace)}`)
    } finally {
      wsManager.setSessionWorkspaceResolver(() => wsPolicy)
    }
  }, 30_000)
})

describe('idle release (isolated manager)', () => {
  async function waitUntil(predicate: () => boolean, timeoutMs = 8_000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (predicate()) return true
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    return predicate()
  }

  function idleManager(id: string, tuning: BridgeTuning, overrides: Partial<AcpAgentDef> = {}): { hub: EventHub; events: AcpEvent[]; manager: BridgeManager } {
    const hub = new EventHub()
    const events: AcpEvent[] = []
    hub.subscribe(event => { events.push(event) })
    const manager = new BridgeManager([{ ...def, id, ...overrides }], hub, 500, undefined, undefined, false, tuning)
    return { hub, events, manager }
  }

  it('releases a probe-spawned process on the probe window, not the chat window', async () => {
    const { events, manager } = idleManager('idle-probe', { idleTimeoutMs: 60_000, probeIdleTimeoutMs: 150 })
    try {
      await manager.probeAgentModels('idle-probe')
      // The probe's throwaway session is deliberately never registered, so the
      // bridge still counts as never-hosted: the short probe window governs
      // even though the chat window is a full minute.
      expect(manager.agentViews()[0]).toMatchObject({ state: 'ready', liveSessions: [] })
      expect(await waitUntil(() => manager.agentViews()[0]?.state === 'stopped')).toBe(true)
      const view = manager.agentViews()[0]
      expect(view?.liveSessions).toEqual([])
      // The view keeps meaning "the chat residency the user configured" — the
      // panel prefills its form from it, so it must not leak probe semantics.
      expect(view?.idleTimeoutMs).toBe(60_000)
      // The release is silent: an idle teardown is the expected lifecycle of a
      // resting process, not a fault — no notice, the status just falls back.
      expect(events.some(event => event.type === 'agent/notice')).toBe(false)
    } finally {
      await manager.shutdownAll()
    }
  }, 30_000)

  it('releases a probe-spawned process even when the agent asked for permanent chat residency', async () => {
    const { manager } = idleManager('idle-probe-forever', { probeIdleTimeoutMs: 150 }, { idleTimeoutMs: 0 })
    try {
      await manager.probeAgentModels('idle-probe-forever')
      // def.idleTimeoutMs = 0 is a promise about the CHAT process; a probe
      // bridge never hosted one and still honors the short probe window.
      expect(await waitUntil(() => manager.agentViews()[0]?.state === 'stopped')).toBe(true)
    } finally {
      await manager.shutdownAll()
    }
  }, 30_000)

  it('never releases a chat process whose agent set idleTimeoutMs to 0', async () => {
    const { manager } = idleManager('idle-off', { idleTimeoutMs: 0 })
    try {
      const { sessionId } = await manager.startSession('idle-off', undefined)
      // Once a real session has landed, the process lives by the agent's own
      // residency rules, and 0 means never — even though the bridge was born
      // from a spawn that (before the session arrived) sat on the probe window.
      await new Promise(resolve => setTimeout(resolve, 600))
      expect(manager.agentViews()[0]).toMatchObject({ state: 'ready', liveSessions: [sessionId] })
    } finally {
      await manager.shutdownAll()
    }
  }, 30_000)

  it('releases an idle chat process on the chat window and resumes its session on the next prompt', async () => {
    const { events, manager } = idleManager('idle-live', { idleTimeoutMs: 200 })
    try {
      const { sessionId } = await manager.startSession('idle-live', undefined)
      // An idle conversation does not keep the process resident: the window
      // passes and the bridge parks the session.
      expect(await waitUntil(() => manager.agentViews()[0]?.state === 'stopped')).toBe(true)
      expect(manager.agentViews()[0]?.liveSessions).toEqual([])
      expect(manager.sessions()).toEqual([expect.objectContaining({ sessionId, released: true })])
      expect(events.some(event => event.type === 'session/released' && event.sessionId === sessionId)).toBe(true)
      expect(events.some(event => event.type === 'agent/notice')).toBe(false)

      // Releasing is not closing: the next prompt respawns and reloads it.
      await manager.prompt(sessionId, 'back again')
      expect(await waitUntil(() => events.some(event => event.type === 'turn/end'
        && event.sessionId === sessionId && event.stopReason === 'end_turn'))).toBe(true)
      expect(manager.agentViews()[0]?.liveSessions).toEqual([sessionId])
      const { entries } = manager.transcript(sessionId, undefined)
      const text = (entries as Array<{ update: Record<string, unknown> }>)
        .filter(entry => entry.update.sessionUpdate === 'agent_message_chunk')
        .map(entry => String((entry.update.content as { text?: string }).text ?? ''))
        .join('')
      expect(text).toContain('REPLAYED: earlier conversation')
      expect(text).toContain('MOCK: echo back again')
    } finally {
      await manager.shutdownAll()
    }
  }, 30_000)

  it('resumes a released chat session on the user\'s explicit gesture', async () => {
    const { events, manager } = idleManager('idle-gesture', { idleTimeoutMs: 200 })
    try {
      const session = await manager.getOrCreateDshSession('dsh-gesture-1', 'idle-gesture')
      const sessionId = session.sessionId
      expect(await waitUntil(() => manager.agentViews()[0]?.state === 'stopped')).toBe(true)
      expect(manager.chatSessions('dsh-gesture-1')).toMatchObject([{ sessionId, released: true }])

      // The banner button: the same recovery the next prompt performs lazily,
      // on the user's gesture instead.
      await manager.resumeChatSession('dsh-gesture-1')
      expect(manager.agentViews()[0]?.liveSessions).toEqual([sessionId])
      expect(manager.chatSessions('dsh-gesture-1')[0]?.released).toBeFalsy()
      // The browser learns of the resume from this frame, not a re-read.
      expect(events.some(event => event.type === 'session/reset' && event.sessionId === sessionId)).toBe(true)
      // The banner promises the context is kept: the load replay must land.
      expect(await waitUntil(() => {
        const entries = manager.chatTranscripts('dsh-gesture-1')[0]?.entries ?? []
        const text = (entries as Array<{ update: Record<string, unknown> }>)
          .filter(entry => entry.update.sessionUpdate === 'agent_message_chunk')
          .map(entry => String((entry.update.content as { text?: string }).text ?? ''))
          .join('')
        return text.includes('REPLAYED: earlier conversation')
      })).toBe(true)

      // A second click while live spawns nothing (idempotent gesture).
      await manager.resumeChatSession('dsh-gesture-1')
      expect(manager.agentViews()[0]?.liveSessions).toEqual([sessionId])

      // A conversation no ACP session ever served says so instead of
      // pretending the button worked.
      await expect(manager.resumeChatSession('dsh-gesture-never'))
        .rejects.toMatchObject({ code: 'unknown_session' })
    } finally {
      await manager.shutdownAll()
    }
  }, 30_000)

  it('records a mode pick on a parked session without waking the process', async () => {
    const { manager } = idleManager('idle-pick', { idleTimeoutMs: 200 })
    try {
      await manager.getOrCreateDshSession('dsh-idle-pick', 'idle-pick')
      expect(await waitUntil(() => manager.agentViews()[0]?.state === 'stopped')).toBe(true)
      const parked = manager.chatSessions('dsh-idle-pick')[0]
      const available = parked?.modes?.availableModes ?? []
      expect(available.length).toBeGreaterThan(1)
      const target = available.find(mode => mode.id !== parked?.modes?.currentModeId)
      expect(target).toBeDefined()

      // The composer's axes on a parked session are "what the next turn should
      // use" — recorded, never applied by force (user decision, 2026-10-30):
      // the process stays parked until the user sends or hits 恢复进程.
      await manager.setChatSessionMode('dsh-idle-pick', target!.id)
      expect(manager.chatChoice('dsh-idle-pick')).toMatchObject({ agentId: 'idle-pick', mode: target!.id })
      expect(manager.chatSessions('dsh-idle-pick')[0]?.modes?.currentModeId).toBe(target!.id)
      expect(manager.agentViews()[0]?.state).toBe('stopped')

      // The next wake applies it (`applyChatChoice`), which is the whole point
      // of a pre-switch.
      await manager.resumeChatSession('dsh-idle-pick')
      expect(manager.chatSessions('dsh-idle-pick')[0]?.modes?.currentModeId).toBe(target!.id)

      // When parked again, changing mode and resuming via prompt path (getOrCreateDshSession)
      // also retains the new mode.
      expect(await waitUntil(() => manager.agentViews()[0]?.state === 'stopped')).toBe(true)
      expect(manager.chatSessions('dsh-idle-pick')[0]?.released).toBe(true)

      const originalMode = parked!.modes!.currentModeId
      await manager.setChatSessionMode('dsh-idle-pick', originalMode)
      expect(manager.chatSessions('dsh-idle-pick')[0]?.modes?.currentModeId).toBe(originalMode)

      const promptResumed = await manager.getOrCreateDshSession('dsh-idle-pick', 'idle-pick')
      expect(promptResumed.modes?.currentModeId).toBe(originalMode)
      expect(manager.chatSessions('dsh-idle-pick')[0]?.modes?.currentModeId).toBe(originalMode)
    } finally {
      await manager.shutdownAll()
    }
  }, 30_000)

  it('updates model and effort on a parked session without waking the process', async () => {
    const { manager } = idleManager('idle-model-pick', { idleTimeoutMs: 200 })
    try {
      await manager.getOrCreateDshSession('dsh-idle-model-pick', 'idle-model-pick')
      expect(await waitUntil(() => manager.agentViews()[0]?.state === 'stopped')).toBe(true)
      const parked = manager.chatSessions('dsh-idle-model-pick')[0]
      expect(parked?.released).toBe(true)

      // Switching model and effort on a parked session immediately updates the
      // in-memory session records and persists them without waking the stopped process.
      await manager.setChatSessionModel('dsh-idle-model-pick', 'idle-model-pick@mock-model-b')
      await manager.setChatSessionEffort('dsh-idle-model-pick', 'off')

      expect(manager.agentViews()[0]?.state).toBe('stopped')
      expect(manager.chatChoice('dsh-idle-model-pick')).toMatchObject({
        agentId: 'idle-model-pick',
        modelId: 'idle-model-pick@mock-model-b',
        effort: 'off',
      })
      const updated = manager.chatSessions('dsh-idle-model-pick')[0]
      expect(updated).toMatchObject({
        modelId: 'idle-model-pick@mock-model-b',
        reasoningEffort: 'off',
        released: true,
      })

      // The next wake applies it and keeps the configuration.
      await manager.resumeChatSession('dsh-idle-model-pick')
      expect(manager.chatSessions('dsh-idle-model-pick')[0]).toMatchObject({
        modelId: 'idle-model-pick@mock-model-b',
        reasoningEffort: 'off',
      })
      expect(manager.chatSessions('dsh-idle-model-pick')[0]?.released).toBeFalsy()

      // When parked again, changing configuration and resuming via the prompt path
      // (getOrCreateDshSession) also retains the new configuration without jumping back.
      expect(await waitUntil(() => manager.agentViews()[0]?.state === 'stopped')).toBe(true)
      expect(manager.chatSessions('dsh-idle-model-pick')[0]?.released).toBe(true)

      await manager.setChatSessionModel('dsh-idle-model-pick', 'idle-model-pick@mock-model-a')
      await manager.setChatSessionEffort('dsh-idle-model-pick', 'high')

      const promptResumed = await manager.getOrCreateDshSession('dsh-idle-model-pick', 'idle-model-pick')
      expect(promptResumed).toMatchObject({
        modelId: 'idle-model-pick@mock-model-a',
        reasoningEffort: 'high',
        released: false,
      })
      expect(manager.chatSessions('dsh-idle-model-pick')[0]).toMatchObject({
        modelId: 'idle-model-pick@mock-model-a',
        reasoningEffort: 'high',
      })
    } finally {
      await manager.shutdownAll()
    }
  }, 30_000)

  it('applies a global idle-release pick to a running bridge, and keeps an agent\'s own override', async () => {
    const { manager } = idleManager('idle-global', { idleTimeoutMs: 60_000 })
    try {
      await manager.startSession('idle-global', undefined)
      expect(manager.agentViews()[0]?.idleTimeoutMs).toBe(60_000)

      // The settings page's pick reaches the RUNNING process: the window is
      // rewritten in place, so the user never has to kill a session to see it.
      await manager.setIdleRelease(300_000)
      expect(manager.agentViews()[0]?.idleTimeoutMs).toBe(300_000)
      expect(manager.idleRelease()).toMatchObject({ idleTimeoutMs: 300_000 })

      // An agent that names its OWN window keeps it — that promise is about
      // the agent, not about the deployment.
      const own = idleManager('idle-own', { idleTimeoutMs: 60_000 }, { idleTimeoutMs: 900_000 })
      try {
        await own.manager.startSession('idle-own', undefined)
        await own.manager.setIdleRelease(300_000)
        expect(own.manager.agentViews()[0]?.idleTimeoutMs).toBe(900_000)
      } finally {
        await own.manager.shutdownAll()
      }

      // A reset drops the pick: the deployment baseline runs again.
      await manager.setIdleRelease(undefined, true)
      expect(manager.idleRelease()).toMatchObject({ idleTimeoutMs: 60_000 })
    } finally {
      await manager.shutdownAll()
    }
  }, 30_000)

  it('resets to the deployment baseline, not to a built-in constant', async () => {
    const { manager } = idleManager('idle-baseline', { idleTimeoutMs: 60_000 })
    try {
      // The deployment names 10 minutes. That is what a reset must return
      // to — resetting to the built-in 30 would silently ignore the file.
      manager.setConfiguredIdleRelease(600_000)
      expect(manager.idleRelease()).toMatchObject({
        idleTimeoutMs: 600_000,
        defaultIdleTimeoutMs: 600_000,
        configuredIdleTimeoutMs: 600_000,
      })
      await manager.setIdleRelease(300_000)
      expect(manager.idleRelease()).toMatchObject({ idleTimeoutMs: 300_000 })
      await manager.setIdleRelease(undefined, true)
      expect(manager.idleRelease()).toMatchObject({ idleTimeoutMs: 600_000 })
    } finally {
      await manager.shutdownAll()
    }
  }, 30_000)

  it('lets the global window reach an agent that pins no window of its own', async () => {
    const { manager } = idleManager('idle-follow', { idleTimeoutMs: 60_000 })
    try {
      await manager.startSession('idle-follow', undefined)
      // The agent names no window, so the global pick governs it: this is the
      // whole point of the setting — a window the user moved in the settings
      // page must REACH the agents that did not pin one.
      await manager.setIdleRelease(300_000)
      expect(manager.agentViews()[0]?.idleTimeoutMs).toBe(300_000)
    } finally {
      await manager.shutdownAll()
    }
  }, 30_000)

  it('persists a global idle-release pick across a host restart', async () => {
    const storage = `${tmpdir()}/acp-idle-global-${Date.now()}.json`
    const hub = new EventHub()
    {
      const manager = new BridgeManager(
        [{ ...def, id: 'idle-persist' }], hub, 500, storage, undefined, undefined, { idleTimeoutMs: 60_000 },
      )
      try {
        await manager.setIdleRelease(900_000)
        expect(manager.idleRelease()).toMatchObject({ idleTimeoutMs: 900_000 })
      } finally {
        await manager.shutdownAll()
      }
    }

    // A fresh manager over the same state dir is a DSH restart: the pick is
    // still in force, because it was persisted with the agent registry.
    const second = new BridgeManager([{ ...def, id: 'idle-persist' }], hub, 500, storage, undefined, undefined, { idleTimeoutMs: 60_000 })
    try {
      expect(second.idleRelease()).toMatchObject({ idleTimeoutMs: 900_000 })
    } finally {
      await second.shutdownAll()
    }
  }, 30_000)

  it('keeps a parked chat session resumable across a host restart', async () => {
    // The session record is what "released ≠ destroyed" means at the process
    // boundary: without it, a DSH restart made the next message silently start
    // a context-less new session and the released banner simply vanished.
    const storage = `${tmpdir()}/acp-restart-resume-${Date.now()}.json`
    const hub = new EventHub()
    let hostSessionId = ''
    {
      const manager = new BridgeManager(
        [{ ...def, id: 'restartable' }], hub, 500, storage, undefined, undefined, { idleTimeoutMs: 200 },
      )
      try {
        // One real turn, so the session has history worth resuming.
        for await (const _ of manager.streamPrompt({
          model: 'restartable',
          sessionId: 'dsh-restart-1',
          messages: [{ role: 'user', content: [{ type: 'text', text: 'remember me' }] }],
        } as never)) { /* drain */ }
        hostSessionId = manager.chatSessions('dsh-restart-1')[0]?.sessionId ?? ''
        expect(hostSessionId).not.toBe('')
        // Park it on the idle window; the release persists the record.
        expect(await waitUntil(() => manager.agentViews()[0]?.state === 'stopped')).toBe(true)
      } finally {
        await manager.shutdownAll()
      }
    }

    // A fresh manager over the same state dir is a DSH restart.
    const second = new BridgeManager([{ ...def, id: 'restartable' }], hub, 500, storage)
    try {
      const restored = second.chatSessions('dsh-restart-1')
      // The released banner's gate (all rows released) sees the conversation
      // again — and the row says history exists on the agent side.
      expect(restored).toMatchObject([{ sessionId: hostSessionId, released: true }])
      expect(second.chatTranscripts('dsh-restart-1')[0]?.session)
        .toMatchObject({ sessionId: hostSessionId, released: true, hasHistory: true })

      // The banner button (or the next message) resumes instead of starting over.
      await second.resumeChatSession('dsh-restart-1')
      expect(second.chatSessions('dsh-restart-1')[0]?.released).toBeFalsy()
      expect(await waitUntil(() => {
        const entries = second.chatTranscripts('dsh-restart-1')[0]?.entries ?? []
        const text = (entries as Array<{ update: Record<string, unknown> }>)
          .filter(entry => entry.update.sessionUpdate === 'agent_message_chunk')
          .map(entry => String((entry.update.content as { text?: string }).text ?? ''))
          .join('')
        return text.includes('REPLAYED: earlier conversation')
      })).toBe(true)
    } finally {
      await second.shutdownAll()
    }
  }, 30_000)

  it('does not resurrect a closed session across a host restart', async () => {
    // Closed is destroyed, released is parked — the two must not blur at the
    // persistence boundary (constraint 10).
    const storage = `${tmpdir()}/acp-restart-closed-${Date.now()}.json`
    const hub = new EventHub()
    const manager = new BridgeManager([{ ...def, id: 'closer' }], hub, 500, storage)
    try {
      const session = await manager.getOrCreateDshSession('dsh-restart-2', 'closer')
      await manager.closeSession(session.sessionId)
    } finally {
      await manager.shutdownAll()
    }
    const second = new BridgeManager([{ ...def, id: 'closer' }], hub, 500, storage)
    try {
      expect(second.chatSessions('dsh-restart-2')).toEqual([])
    } finally {
      await second.shutdownAll()
    }
  }, 30_000)

  it('holds the process while a turn is running, then releases it once the turn settles', async () => {
    const { manager } = idleManager('idle-busy', { idleTimeoutMs: 200 })
    try {
      const { sessionId } = await manager.startSession('idle-busy', undefined)
      await manager.prompt(sessionId, 'SLOW please')
      // Two full windows pass while the turn is in flight: being registered is
      // not enough, but RUNNING definitely blocks the release.
      await new Promise(resolve => setTimeout(resolve, 700))
      expect(manager.agentViews()[0]).toMatchObject({ state: 'ready', liveSessions: [sessionId] })
      await manager.cancel(sessionId)
      expect(await waitUntil(() => manager.agentViews()[0]?.state === 'stopped')).toBe(true)
    } finally {
      await manager.shutdownAll()
    }
  }, 30_000)

  it('does not release a process whose agent cannot reload the session', async () => {
    const { manager } = idleManager('idle-no-load', { idleTimeoutMs: 200 }, { env: { MOCK_NO_LOAD: '1' } })
    try {
      const { sessionId } = await manager.startSession('idle-no-load', undefined)
      await new Promise(resolve => setTimeout(resolve, 700))
      // Without `loadSession`, releasing would destroy a conversation that the
      // next prompt could not bring back — the session-less rule still stands.
      expect(manager.agentViews()[0]).toMatchObject({ state: 'ready', liveSessions: [sessionId] })
    } finally {
      await manager.shutdownAll()
    }
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

describe('a silent turn is force-finalized and the next message recovers (isolated manager)', () => {
  // Windows are small (the suite would take minutes at the ten-minute
  // defaults) but not tiny: an 80ms window false-finalized HEALTHY warmup
  // turns on a loaded CI box, because the child's first tool card can take
  // longer than that to arrive. 350ms leaves room for spawn + stream jitter
  // while every negative assertion still spans five full windows.
  const STALL_MS = 350
  const TICK_MS = 25
  /** Five windows: "the watchdog had several chances and stayed quiet". */
  const QUIET_MS = STALL_MS * 5 + 100
  const stallHub = new EventHub()
  const stallEvents: AcpEvent[] = []
  stallHub.subscribe(event => { stallEvents.push(event) })
  const stallManager = new BridgeManager([{ ...def, id: 'stall' }], stallHub, 500, undefined, undefined, false, {
    turnStallMs: STALL_MS,
    turnStallTickMs: TICK_MS,
    // A tool call may legitimately take much longer than prose silence; this
    // big number is what keeps the HANG_TOOL turns alive.
    turnStallToolMs: 60_000,
    // Only used to settle the mock's wedged turns during cleanup — the stall
    // itself is not a cancel fallback.
    cancelFallbackMs: 300,
    turnSettleMs: 200,
  })
  const stallAdapter = new AcpLlmAdapter(stallManager)
  // Same windows, but the mock advertises NO `loadSession`: a stall there can
  // only be recovered by resetting the session (the context is unrecoverable).
  const noLoadManager = new BridgeManager([{ ...def, id: 'stall-noload', env: { MOCK_NO_LOAD: '1' } }], stallHub, 500, undefined, undefined, false, {
    turnStallMs: STALL_MS,
    turnStallTickMs: TICK_MS,
    turnStallToolMs: 60_000,
    cancelFallbackMs: 300,
    turnSettleMs: 200,
  })
  const noLoadAdapter = new AcpLlmAdapter(noLoadManager)
  // The hostile no-load agent: it also never answers `session/close`. A reset
  // that waited for a graceful close would hang the next message forever.
  const wedgedManager = new BridgeManager([{ ...def, id: 'stall-wedged', env: { MOCK_NO_LOAD: '1', MOCK_IGNORE_CLOSE: '1' } }], stallHub, 500, undefined, undefined, false, {
    turnStallMs: STALL_MS,
    turnStallTickMs: TICK_MS,
    turnStallToolMs: 60_000,
    cancelFallbackMs: 300,
    turnSettleMs: 200,
  })
  const wedgedAdapter = new AcpLlmAdapter(wedgedManager)
  // `turnStallMs: 0` is the off switch: no scan is armed at all.
  const offManager = new BridgeManager([{ ...def, id: 'stall-off' }], stallHub, 500, undefined, undefined, false, {
    turnStallMs: 0,
    turnStallTickMs: TICK_MS,
    cancelFallbackMs: 300,
  })
  const offAdapter = new AcpLlmAdapter(offManager)
  // `turnStallToolMs: 0` means "no separate tool window": the base window is
  // the only one in force, even with a tool in flight.
  const fallbackManager = new BridgeManager([{ ...def, id: 'stall-fallback' }], stallHub, 500, undefined, undefined, false, {
    turnStallMs: STALL_MS,
    turnStallTickMs: TICK_MS,
    turnStallToolMs: 0,
    cancelFallbackMs: 300,
  })
  const fallbackAdapter = new AcpLlmAdapter(fallbackManager)

  /**
   * Tear a manager down on the CRASH path: `shutdownAll` awaits
   * `session/close`, and the IGNORE_CLOSE mock never answers that request.
   * `releaseAll` is what the process-death path uses — it drops the local
   * records and kills the child — so it cannot block.
   */
  function hardStop(manager: BridgeManager): void {
    const seam = manager as unknown as { bridges: Map<string, { releaseAll(reason: string): void }> }
    for (const bridge of seam.bridges.values()) bridge.releaseAll('test teardown')
  }

  afterAll(async () => {
    await noLoadManager.shutdownAll()
    await stallManager.shutdownAll()
    await offManager.shutdownAll()
    await fallbackManager.shutdownAll()
    // Kill the child first; the graceful stop that follows is then a no-op.
    hardStop(wedgedManager)
    await wedgedManager.shutdownAll()
  })

  function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms))
  }

  /**
   * Wait for a frame that lands at or after `since`. The caller takes the
   * watermark before triggering the action, so an earlier test's frame can
   * neither satisfy the wait nor hide a missing one; the initial scan closes
   * the gap where the frame arrives before this subscription.
   */
  function stallWaitFor<T extends AcpEvent['type']>(type: T, predicate: (event: Extract<AcpEvent, { type: T }>) => boolean, since: number, timeoutMs = 10_000): Promise<Extract<AcpEvent, { type: T }>> {
    return new Promise((resolve, reject) => {
      let done = false
      const settle = (event: Extract<AcpEvent, { type: T }>): void => {
        if (done) return
        done = true
        clearTimeout(timer)
        unsub()
        resolve(event)
      }
      const timer = setTimeout(() => {
        if (done) return
        done = true
        unsub()
        reject(new Error(`timeout waiting for ${type}`))
      }, timeoutMs)
      const unsub = stallHub.subscribe(event => {
        if (event.type === type && stallEvents.indexOf(event) >= since
          && predicate(event as Extract<AcpEvent, { type: T }>)) settle(event as Extract<AcpEvent, { type: T }>)
      })
      for (const event of stallEvents) {
        if (event.type === type && stallEvents.indexOf(event) >= since
          && predicate(event as Extract<AcpEvent, { type: T }>)) {
          settle(event as Extract<AcpEvent, { type: T }>)
          break
        }
      }
    })
  }

  /** Drain one adapter stream (the first driver step) on any of this suite's managers. */
  async function drainWith(adapter: AcpLlmAdapter, model: string, text: string, sessionId: string, signal?: AbortSignal): Promise<StreamChunk[]> {
    const chunks: StreamChunk[] = []
    for await (const chunk of adapter.stream({
      provider: 'acp',
      model,
      sessionId,
      ...(signal === undefined ? {} : { signal }),
      messages: [{ role: 'user', content: [{ type: 'text', text }] }],
    })) {
      chunks.push(chunk)
    }
    return chunks
  }

  /** Drain one adapter stream for a chat session (the first driver step). */
  function drain(text: string, sessionId: string, signal?: AbortSignal): Promise<StreamChunk[]> {
    return drainWith(stallAdapter, 'stall', text, sessionId, signal)
  }

  /** Drain one adapter stream on the no-loadSession manager. */
  function drainNoLoad(text: string, sessionId: string): Promise<StreamChunk[]> {
    return drainWith(noLoadAdapter, 'stall-noload', text, sessionId)
  }

  /**
   * Wait until the agent has SETTLED the session's turn (`running: false`).
   * A driver step can finish at its last card well before the agent answers
   * `session/prompt`, and a prompt sent into that window is refused
   * `turn_in_flight` — a race in the test, not in the product.
   */
  async function waitForTurnSettled(manager: BridgeManager, dshSessionId: string, timeoutMs = 8_000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const live = sessionViewOf(manager, dshSessionId)
      if (live === undefined || live.running !== true) return
      if (Date.now() > deadline) throw new Error('timeout waiting for the turn to settle')
      await sleep(20)
    }
  }

  function finishOf(chunks: StreamChunk[]): Extract<StreamChunk, { type: 'finish' }> | undefined {
    return chunks.find((chunk): chunk is Extract<StreamChunk, { type: 'finish' }> => chunk.type === 'finish')
  }

  function stallMessage(chunks: StreamChunk[]): string {
    const reason = finishOf(chunks)?.reason
    return reason?.kind === 'error' ? reason.failure?.message ?? '' : ''
  }

  /** The live session record behind one chat session (the HOST session id, not the ACP one). */
  function sessionViewOf(manager: BridgeManager, dshSessionId: string): ChatTranscriptView['session'] | undefined {
    return manager.chatTranscripts(dshSessionId)[0]?.session
  }

  /** The chat session's agent chunks, joined (what the user actually saw). */
  function transcriptTextOf(manager: BridgeManager, dshSessionId: string): string {
    return manager.chatTranscripts(dshSessionId)
      .flatMap(view => view.entries)
      .filter(entry => (entry.update as Record<string, unknown>).sessionUpdate === 'agent_message_chunk')
      .map(entry => String(((entry.update as Record<string, unknown>).content as { text?: string }).text ?? ''))
      .join('')
  }

  function transcriptText(dshSessionId: string): string {
    return transcriptTextOf(stallManager, dshSessionId)
  }

  /**
   * Wait until a chat transcript contains `needle`. A late agent answer keeps
   * writing into the transcript after our face of the turn has closed, so the
   * assertion has to wait for the text, not for a frame.
   */
  async function waitForTranscriptText(manager: BridgeManager, dshSessionId: string, needle: string, timeoutMs = 8_000): Promise<string> {
    const deadline = Date.now() + timeoutMs
    let text = transcriptTextOf(manager, dshSessionId)
    while (!text.includes(needle) && Date.now() < deadline) {
      await sleep(20)
      text = transcriptTextOf(manager, dshSessionId)
    }
    return text
  }

  it('chat path: a turn that sends nothing ends with INACTIVITY_TIMEOUT and a notice', async () => {
    const since = stallEvents.length
    const chunks = await drain('HANG please', 'dsh-stall-hang')
    const finish = finishOf(chunks)
    expect(finish?.reason).toMatchObject({ kind: 'error', failure: { code: 'INACTIVITY_TIMEOUT' } })
    expect(stallMessage(chunks)).toContain('sent no activity')

    // The /acp face of the same turn is a turn/end error (the browser's ACP
    // view and the settings ledger both read that frame). A zero-output FIRST
    // turn settles its provisional lock by rolling back the conversation, so
    // the ACP session id comes from the frame, not from `chatTranscripts`.
    const ended = stallEvents.slice(since)
      .find(event => event.type === 'turn/end' && event.error !== undefined && event.error.includes('sent no activity'))
    expect(ended).toBeDefined()
    if (ended?.type === 'turn/end') expect(ended.error).toContain('sent no activity')

    // One process-wide notice per stall, telling the user what happened AND
    // what the next message will do about it. This was the conversation's FIRST
    // turn and it delivered nothing, so the rollback it triggers is what the
    // promise must describe: no resume, a new ACP session. (The resume promise
    // for a turn that HAS output is pinned by the tool-window test below.)
    const notices = stallEvents.slice(since)
      .filter(event => event.type === 'agent/notice' && event.text.includes('sent no activity'))
    expect(notices).toHaveLength(1)
    if (notices[0]?.type === 'agent/notice') {
      expect(notices[0].agentId).toBe('stall')
      expect(notices[0].text).toContain('sent no activity')
      expect(notices[0].text).toContain('first turn and it delivered nothing')
      expect(notices[0].text).toContain('the next message starts a new ACP session')
      expect(notices[0].text).not.toContain('does not support session resume')
      expect(notices[0].text).not.toContain('restart the agent and resume the session')
    }
  }, 15_000)

  it('does not fire while a permission ask is waiting for the human', async () => {
    const since = stallEvents.length
    const drained = drain('PERM hold', 'dsh-stall-perm')
    const ask = await stallWaitFor('permission/request', () => true, since)
    const acpSessionId = ask.sessionId

    // Several watchdog windows pass with the ask open. Firing here would end
    // the turn under the card the human is still looking at.
    await sleep(QUIET_MS)
    expect(stallEvents.slice(since).some(event =>
      event.type === 'turn/end' && event.sessionId === acpSessionId && event.error?.includes('sent no activity') === true)).toBe(false)
    expect(stallEvents.slice(since).some(event =>
      event.type === 'agent/notice' && event.text.includes('sent no activity'))).toBe(false)

    // Answering lets the agent finish normally: the turn ends by the agent's
    // own stop, not by the watchdog.
    const replySince = stallEvents.length
    await dispatchRpc(stallManager, 'permission/respond', { requestId: ask.requestId, optionId: 'allow1' })
    const chunks = await drained
    expect(finishOf(chunks)?.reason).toMatchObject({ kind: 'stop' })
    await stallWaitFor('turn/end', event => event.sessionId === acpSessionId && event.stopReason === 'end_turn', replySince)

    // Retire the session: a card-bearing turn keeps its stream controller
    // indexed until the host loop takes its continuation step or the session
    // closes, and this manager is shared with the reclaim tests below — a
    // leftover controller of a conversation nobody is using would pin the
    // agent process there (the reclaim refuses while a sibling looks mid-turn).
    await dispatchRpc(stallManager, 'session/close', { sessionId: acpSessionId })
  }, 15_000)

  it('chat path: the next message restarts the agent and resumes the session before sending', async () => {
    // A first turn that delivers nothing rolls its provisional lock back and
    // drops the session (existing semantics), so the stalled conversation has
    // to be one that already produced output — the case a real user is in.
    await hostLoopTurn(stallAdapter, {
      provider: 'acp',
      model: 'stall',
      sessionId: 'dsh-stall-reclaim',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hello warmup PIDTAG' }] }],
    })
    // The process that serves the conversation BEFORE the stall. `PIDTAG` is
    // opt-in in the mock, so no exact-echo assertion elsewhere sees it.
    const warm = await waitForTranscriptText(stallManager, 'dsh-stall-reclaim', 'PID:')
    const oldPid = /PID:(\d+)/.exec(warm)?.[1] ?? ''
    expect(oldPid).not.toBe('')
    const stalled = await drain('HANG please', 'dsh-stall-reclaim')
    expect(finishOf(stalled)?.reason).toMatchObject({ kind: 'error', failure: { code: 'INACTIVITY_TIMEOUT' } })

    // The orphan cleanup must replace the wedged process and run session/load
    // BEFORE delivering the new prompt. The mock only ever emits the replay
    // marker from `session/load`, so its presence proves the context came back
    // on a fresh child; the echo proves the prompt then reached that child —
    // and its pid proves that child is NOT the wedged one (a `session/load`
    // replays for any process, so `REPLAYED` alone cannot tell them apart).
    await hostLoopTurn(stallAdapter, {
      provider: 'acp',
      model: 'stall',
      sessionId: 'dsh-stall-reclaim',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hello after stall PIDTAG' }] }],
    })
    const acpSessionId = stallManager.chatTranscripts('dsh-stall-reclaim')[0]?.session.sessionId ?? ''
    expect(acpSessionId).not.toBe('')
    await settleTranscript(stallManager, acpSessionId)
    const text = transcriptText('dsh-stall-reclaim')
    expect(text).toContain('REPLAYED: earlier conversation')
    expect(text).toContain('MOCK: echo hello after stall PIDTAG perm=none')
    const newPid = /MOCK: echo hello after stall PIDTAG perm=none PID:(\d+)/.exec(text)?.[1] ?? ''
    expect(newPid).not.toBe('')
    expect(newPid).not.toBe(oldPid)

    // Retire the conversation: the manager is shared, and a reclaim (below)
    // refuses to restart the agent while another live session looks busy.
    await dispatchRpc(stallManager, 'session/close', { sessionId: acpSessionId })
  }, 20_000)

  it('/acp path: broadcasts the stall error, and a second prompt succeeds after resume', async () => {
    const start = await dispatchRpc(stallManager, 'session/start', { agentId: 'stall' })
    if (!start.ok) throw new Error('start failed')
    const sessionId = (start.value as { sessionId: string }).sessionId

    const since = stallEvents.length
    const first = await dispatchRpc(stallManager, 'session/prompt', { sessionId, text: 'HANG' })
    expect(first).toMatchObject({ ok: true, value: { accepted: true } })
    await stallWaitFor('turn/end', event =>
      event.sessionId === sessionId && event.error !== undefined && event.error.includes('sent no activity'), since)

    // The next prompt must not be answered `turn_in_flight`: the orphan is
    // reclaimed (process restarted, session/load replayed) and then served.
    const resumeSince = stallEvents.length
    const second = await dispatchRpc(stallManager, 'session/prompt', { sessionId, text: 'hello after stall' })
    expect(second).toMatchObject({ ok: true, value: { accepted: true } })
    if (!second.ok) return
    const turnId = (second.value as { turnId: string }).turnId
    await stallWaitFor('turn/end', event => event.sessionId === sessionId && event.turnId === turnId && event.stopReason === 'end_turn', resumeSince)
    await settleTranscript(stallManager, sessionId)

    const transcript = await dispatchRpc(stallManager, 'transcript/get', { sessionId })
    if (!transcript.ok) throw new Error('transcript failed')
    const text = (transcript.value as { entries: Array<{ update: Record<string, unknown> }> }).entries
      .filter(entry => entry.update.sessionUpdate === 'agent_message_chunk')
      .map(entry => String((entry.update.content as { text?: string }).text ?? ''))
      .join('')
    expect(text).toContain('REPLAYED: earlier conversation')
    expect(text).toContain('MOCK: echo hello after stall')

    // Retire the session: the shared manager's reclaim refuses while another
    // live session looks busy, and this one is done.
    await dispatchRpc(stallManager, 'session/close', { sessionId })
  }, 20_000)

  it('/acp path: the late real response still lands as its own turn/end', async () => {
    const start = await dispatchRpc(stallManager, 'session/start', { agentId: 'stall' })
    if (!start.ok) throw new Error('start failed')
    const sessionId = (start.value as { sessionId: string }).sessionId

    const since = stallEvents.length
    const first = await dispatchRpc(stallManager, 'session/prompt', { sessionId, text: 'HANG_DELAY:1200' })
    if (!first.ok) throw new Error('prompt failed')
    const turnId = (first.value as { turnId: string }).turnId

    // The watchdog speaks FIRST: the agent stays silent past the window
    // (1200ms is more than three of them) before it answers.
    const watchdog = await stallWaitFor('turn/end', event =>
      event.sessionId === sessionId && event.error !== undefined && event.error.includes('sent no activity'), since)

    // ...then the agent's own (late) response is still broadcast as the real
    // settlement of that same turn, with its own stop reason.
    const real = await stallWaitFor('turn/end', event =>
      event.sessionId === sessionId && event.turnId === turnId && event.stopReason === 'end_turn', since, 5_000)
    expect(real.turnId).toBe(turnId)
    expect(watchdog.error).toContain('sent no activity')

    // The session is usable again afterwards.
    const resumeSince = stallEvents.length
    const third = await dispatchRpc(stallManager, 'session/prompt', { sessionId, text: 'hello after late' })
    expect(third).toMatchObject({ ok: true, value: { accepted: true } })
    if (!third.ok) return
    const thirdTurnId = (third.value as { turnId: string }).turnId
    await stallWaitFor('turn/end', event => event.sessionId === sessionId && event.turnId === thirdTurnId && event.stopReason === 'end_turn', resumeSince)

    // Retire the session so a later reclaim on this shared agent is not told
    // another conversation is still using it.
    await dispatchRpc(stallManager, 'session/close', { sessionId })
  }, 20_000)

  it('holds a turn whose tool call is still in flight on the base window', async () => {
    // HANG_TOOL emits the usual opening (thought / plan / tool card) and then
    // goes silent with `call_1` pending. The base window would fire many times
    // over; the tool window (60s here) is the one that applies.
    const since = stallEvents.length
    const controller = new AbortController()
    const drained = drain('HANG_TOOL please', 'dsh-stall-tool', controller.signal)
    const settledEarly = await Promise.race([
      drained.then(() => true),
      sleep(QUIET_MS).then(() => false),
    ])
    expect(settledEarly).toBe(false)
    expect(stallEvents.slice(since).some(event =>
      event.type === 'agent/notice' && event.text.includes('sent no activity'))).toBe(false)

    // Cleanup: the host aborts (a human pressing stop); the mock ignores the
    // cancel, and the abort finishes OUR face of the turn immediately. The
    // session record still reads `running` (the agent never answered), so it
    // must be retired too or every later reclaim on this shared agent is
    // refused on its behalf.
    controller.abort()
    expect(finishOf(await drained)?.reason.kind).toBe('aborted')
    const hostId = sessionViewOf(stallManager, 'dsh-stall-tool')?.sessionId
    if (hostId !== undefined) await dispatchRpc(stallManager, 'session/close', { sessionId: hostId })
  }, 15_000)

  it('refuses reclaim while another conversation on the agent is still working', async () => {
    // A must outlive its stall: give it one delivered turn first (a zero-output
    // first turn would roll its provisional lock back instead of leaving an
    // orphan the reclaim has to deal with).
    await hostLoopTurn(stallAdapter, {
      provider: 'acp',
      model: 'stall',
      sessionId: 'dsh-stall-guard-a',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hello warmup' }] }],
    })

    // A: a wedged turn that the watchdog finalizes. B: a turn with a tool call
    // still in flight, i.e. genuine work the process must keep serving.
    const busyController = new AbortController()
    const since = stallEvents.length
    const stalled = drain('HANG please', 'dsh-stall-guard-a')
    const busy = drain('HANG_TOOL please', 'dsh-stall-guard-b', busyController.signal)

    // A sends nothing, so the first tool_call belongs to B: waiting for it
    // makes "another conversation is working" a fact instead of a timing guess.
    await stallWaitFor('session/update', event =>
      (event.update as { sessionUpdate?: string }).sessionUpdate === 'tool_call', since)

    const stalledChunks = await stalled
    expect(finishOf(stalledChunks)?.reason).toMatchObject({ kind: 'error', failure: { code: 'INACTIVITY_TIMEOUT' } })

    // A's next message cannot reclaim the process: killing it would murder B.
    const refused = await drain('hello after stall', 'dsh-stall-guard-a')
    const refusedFinish = finishOf(refused)
    expect(refusedFinish?.reason).toMatchObject({ kind: 'error' })
    expect(stallMessage(refused)).toContain('other conversations are still using it')

    // ...and the agent process was NOT killed to free A.
    expect(stallManager.agentViews().find(view => view.id === 'stall')?.state).toBe('ready')
    const listed = await dispatchRpc(stallManager, 'sessions/list', {})
    if (!listed.ok) throw new Error('sessions/list failed')
    expect((listed.value as { sessions: Array<{ running?: boolean }> }).sessions.some(session => session.running === true)).toBe(true)

    busyController.abort()
    await busy
    // Retire both sessions: B's agent never acknowledged the abort (the mock
    // ignores `session/cancel`), so its record still reads `running` — genuine
    // work on this manager's shared agent, which the reclaim tests below would
    // (correctly) refuse to kill. Closing drops the records; the wedged prompt
    // the mock still holds dies with the child the next reclaim restarts.
    for (const chatId of ['dsh-stall-guard-a', 'dsh-stall-guard-b']) {
      const hostId = sessionViewOf(stallManager, chatId)?.sessionId
      if (hostId !== undefined) await dispatchRpc(stallManager, 'session/close', { sessionId: hostId })
    }
  }, 20_000)

  it('resets a stalled session when the agent advertises no loadSession', async () => {
    // A delivered turn first, so the reset has real context to drop.
    await hostLoopTurn(noLoadAdapter, {
      provider: 'acp',
      model: 'stall-noload',
      sessionId: 'dsh-stall-noload',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hello warmup' }] }],
    })
    const oldView = sessionViewOf(noLoadManager, 'dsh-stall-noload')
    const oldHostId = oldView?.sessionId ?? ''
    const oldAcpSessionId = oldView?.acpSessionId ?? ''
    expect(oldHostId).not.toBe('')
    expect(oldAcpSessionId).not.toBe('')

    const stallSince = stallEvents.length
    const stalled = await drainNoLoad('HANG please', 'dsh-stall-noload')
    expect(finishOf(stalled)?.reason).toMatchObject({ kind: 'error', failure: { code: 'INACTIVITY_TIMEOUT' } })

    // The same watchdog notice, but this agent has nothing to resume: its
    // promise is the reset half, not "restart and resume".
    const stallNotice = stallEvents.slice(stallSince)
      .find(event => event.type === 'agent/notice' && event.agentId === 'stall-noload' && event.text.includes('sent no activity'))
    expect(stallNotice).toBeDefined()
    if (stallNotice?.type === 'agent/notice') {
      expect(stallNotice.text).toContain('sent no activity')
      expect(stallNotice.text).toContain('does not support session resume')
      expect(stallNotice.text).not.toContain('restart the agent and resume the session')
    }

    const since = stallEvents.length
    await hostLoopTurn(noLoadAdapter, {
      provider: 'acp',
      model: 'stall-noload',
      sessionId: 'dsh-stall-noload',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hello after reset' }] }],
    })

    // The next message is served on a NEW session: no `session/load` exists, so
    // the record was dropped (rather than parked as `released`) and the user is
    // told the context is gone. Both the host record and the AGENT-side session
    // are new — a reset means a fresh `session/new`, not a resumed one.
    const views = noLoadManager.chatTranscripts('dsh-stall-noload')
    expect(views).toHaveLength(1)
    const newHostId = views[0]?.session.sessionId ?? ''
    const newAcpSessionId = views[0]?.session.acpSessionId ?? ''
    expect(newHostId).not.toBe('')
    expect(newHostId).not.toBe(oldHostId)
    expect(newAcpSessionId).not.toBe('')
    expect(newAcpSessionId).not.toBe(oldAcpSessionId)
    const notice = stallEvents.slice(since)
      .find(event => event.type === 'agent/notice' && event.agentId === 'stall-noload' && event.text.includes('does not support session resume'))
    expect(notice).toBeDefined()

    await settleTranscript(noLoadManager, newHostId)
    const text = transcriptTextOf(noLoadManager, 'dsh-stall-noload')
    expect(text).toContain('MOCK: echo hello after reset')
    // Nothing was replayed from the previous process: the context is gone.
    expect(text).not.toContain('REPLAYED: earlier conversation')

    // Retire it: a no-load reclaim restarts the whole child, so it refuses
    // while ANY other live session shares it — the `/acp` test below needs an
    // agent with nothing else on it.
    await expect(dispatchRpc(noLoadManager, 'session/close', { sessionId: newHostId }))
      .resolves.toMatchObject({ ok: true })
  }, 30_000)

  it('turnStallMs: 0 disables the watchdog entirely', async () => {
    // `0` is the documented off switch, not "expire immediately": no scan is
    // armed at all, so a wedged turn simply stays the agent's until the human
    // stops it.
    const since = stallEvents.length
    const controller = new AbortController()
    const drained = drainWith(offAdapter, 'stall-off', 'HANG please', 'dsh-stall-off', controller.signal)
    const settledEarly = await Promise.race([
      drained.then(() => true),
      sleep(QUIET_MS).then(() => false),
    ])
    expect(settledEarly).toBe(false)
    expect(stallEvents.slice(since).some(event =>
      event.type === 'agent/notice' && event.agentId === 'stall-off')).toBe(false)
    expect(stallEvents.slice(since).some(event =>
      event.type === 'turn/end' && event.error !== undefined && event.error.includes('sent no activity'))).toBe(false)

    // Cleanup: the human's stop. The mock ignores the cancel, so the turn slot
    // stays the agent's; the zero-output first turn rolls its provisional lock
    // back and retires the session, otherwise a close must do it.
    const hostId = sessionViewOf(offManager, 'dsh-stall-off')?.sessionId ?? ''
    expect(hostId).not.toBe('')
    controller.abort()
    expect(finishOf(await drained)?.reason.kind).toBe('aborted')
    if (sessionViewOf(offManager, 'dsh-stall-off') !== undefined) {
      await expect(dispatchRpc(offManager, 'session/close', { sessionId: hostId }))
        .resolves.toMatchObject({ ok: true })
    }
  }, 20_000)

  it('turnStallToolMs: 0 falls back to the base window', async () => {
    // No separate tool window: an in-flight tool call is measured against
    // `turnStallMs`, so a HANG_TOOL turn is finalized like a silent one.
    const since = stallEvents.length
    const chunks = await drainWith(fallbackAdapter, 'stall-fallback', 'HANG_TOOL please', 'dsh-stall-fallback')
    expect(finishOf(chunks)?.reason).toMatchObject({ kind: 'error', failure: { code: 'INACTIVITY_TIMEOUT' } })

    // The same notice as any other stall (this agent can resume).
    const notice = stallEvents.slice(since)
      .find(event => event.type === 'agent/notice' && event.agentId === 'stall-fallback' && event.text.includes('sent no activity'))
    expect(notice).toBeDefined()
    if (notice?.type === 'agent/notice') {
      expect(notice.text).toContain('The next message will restart the agent and resume the session.')
    }

    // The tool card counts as a delivered first turn, so the session is still
    // live here: retire it explicitly.
    const hostId = sessionViewOf(fallbackManager, 'dsh-stall-fallback')?.sessionId ?? ''
    expect(hostId).not.toBe('')
    await expect(dispatchRpc(fallbackManager, 'session/close', { sessionId: hostId }))
      .resolves.toMatchObject({ ok: true })
  }, 20_000)

  it('keeps the tool window while a second parallel call is still in progress', async () => {
    // HANG_TWO_TOOLS completes `ta` and leaves `tb` in_progress. The finished
    // call must not close the tool window: the turn is still waiting on `tb`,
    // and its sibling finishing is not the agent going quiet. A boolean
    // "some tool is in flight" flipped false right here and finalized the turn
    // on the BASE window.
    const since = stallEvents.length
    const controller = new AbortController()
    const drained = drain('HANG_TWO_TOOLS please', 'dsh-stall-parallel', controller.signal)
    const settledEarly = await Promise.race([
      drained.then(() => true),
      sleep(QUIET_MS).then(() => false),
    ])
    expect(settledEarly).toBe(false)
    expect(stallEvents.slice(since).some(event =>
      event.type === 'agent/notice' && event.text.includes('sent no activity'))).toBe(false)

    controller.abort()
    expect(finishOf(await drained)?.reason.kind).toBe('aborted')
    const hostId = sessionViewOf(stallManager, 'dsh-stall-parallel')?.sessionId ?? ''
    expect(hostId).not.toBe('')
    await expect(dispatchRpc(stallManager, 'session/close', { sessionId: hostId }))
      .resolves.toMatchObject({ ok: true })
  }, 20_000)

  it('resets a wedged no-loadSession agent without waiting for session/close', async () => {
    // The hostile combination: no resume support AND `session/close` is never
    // answered. The reset has to kill the process — a reset that asks the
    // wedged agent to close first would hang the user's next message forever.
    await hostLoopTurn(wedgedAdapter, {
      provider: 'acp',
      model: 'stall-wedged',
      sessionId: 'dsh-stall-wedged',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hello warmup' }] }],
    })
    const oldAcpSessionId = sessionViewOf(wedgedManager, 'dsh-stall-wedged')?.acpSessionId ?? ''
    expect(oldAcpSessionId).not.toBe('')

    const stallSince = stallEvents.length
    const stalled = await drainWith(wedgedAdapter, 'stall-wedged', 'HANG please', 'dsh-stall-wedged')
    expect(finishOf(stalled)?.reason).toMatchObject({ kind: 'error', failure: { code: 'INACTIVITY_TIMEOUT' } })
    const stallNotice = stallEvents.slice(stallSince)
      .find(event => event.type === 'agent/notice' && event.agentId === 'stall-wedged' && event.text.includes('sent no activity'))
    expect(stallNotice).toBeDefined()
    if (stallNotice?.type === 'agent/notice') {
      expect(stallNotice.text).toContain('does not support session resume')
      expect(stallNotice.text).not.toContain('restart the agent and resume the session')
    }

    // The next message must go through on a NEW agent session. If the reset
    // awaited `session/close`, this await would never resolve.
    const since = stallEvents.length
    await hostLoopTurn(wedgedAdapter, {
      provider: 'acp',
      model: 'stall-wedged',
      sessionId: 'dsh-stall-wedged',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hello after wedged reset' }] }],
    })
    const newView = sessionViewOf(wedgedManager, 'dsh-stall-wedged')
    expect(newView).toBeDefined()
    expect(newView?.acpSessionId).not.toBe('')
    expect(newView?.acpSessionId).not.toBe(oldAcpSessionId)
    expect(stallEvents.slice(since)
      .some(event => event.type === 'agent/notice' && event.agentId === 'stall-wedged' && event.text.includes('does not support session resume'))).toBe(true)

    await settleTranscript(wedgedManager, newView?.sessionId ?? '')
    const text = transcriptTextOf(wedgedManager, 'dsh-stall-wedged')
    expect(text).toContain('MOCK: echo hello after wedged reset')
    // A reset has no history to replay.
    expect(text).not.toContain('REPLAYED: earlier conversation')
  }, 20_000)

  it('/acp path: refuses to reclaim while another /acp conversation is working', async () => {
    const stalledStart = await dispatchRpc(stallManager, 'session/start', { agentId: 'stall' })
    const busyStart = await dispatchRpc(stallManager, 'session/start', { agentId: 'stall' })
    if (!stalledStart.ok || !busyStart.ok) throw new Error('start failed')
    const stalledId = (stalledStart.value as { sessionId: string }).sessionId
    const busyId = (busyStart.value as { sessionId: string }).sessionId
    expect(stalledId).not.toBe(busyId)

    const since = stallEvents.length
    const stalledPrompt = await dispatchRpc(stallManager, 'session/prompt', { sessionId: stalledId, text: 'HANG' })
    expect(stalledPrompt).toMatchObject({ ok: true, value: { accepted: true } })
    const busyPrompt = await dispatchRpc(stallManager, 'session/prompt', { sessionId: busyId, text: 'HANG_TOOL' })
    expect(busyPrompt).toMatchObject({ ok: true, value: { accepted: true } })

    // The stalled turn sends nothing, so the tool card belongs to the busy
    // conversation: waiting for it makes "it is still working" a fact.
    await stallWaitFor('session/update', event =>
      event.sessionId === busyId && (event.update as { toolCallId?: string }).toolCallId === 'call_1', since)
    await stallWaitFor('turn/end', event =>
      event.sessionId === stalledId && event.error !== undefined && event.error.includes('sent no activity'), since)

    // Reclaiming would kill the child and murder the busy turn: refuse.
    const refused = await dispatchRpc(stallManager, 'session/prompt', { sessionId: stalledId, text: 'hello after stall' })
    expect(refused).toMatchObject({ ok: false, error: { code: 'agent_unresponsive' } })
    if (!refused.ok) expect(refused.error.message).toContain('other conversations are still using it')

    // ...and nothing was killed to free the stalled conversation.
    expect(stallManager.agentViews().find(view => view.id === 'stall')?.state).toBe('ready')
    const listed = await dispatchRpc(stallManager, 'sessions/list', {})
    if (!listed.ok) throw new Error('sessions/list failed')
    const busyView = (listed.value as { sessions: Array<{ sessionId: string; running?: boolean }> }).sessions
      .find(session => session.sessionId === busyId)
    expect(busyView?.running).toBe(true)

    // Cleanup: stop the busy turn, retire both sessions.
    await dispatchRpc(stallManager, 'session/cancel', { sessionId: busyId })
    await dispatchRpc(stallManager, 'session/close', { sessionId: busyId })
    await dispatchRpc(stallManager, 'session/close', { sessionId: stalledId })
  }, 20_000)

  it('/acp path: reclaiming a stalled session emits exactly one turn/end for it', async () => {
    const start = await dispatchRpc(stallManager, 'session/start', { agentId: 'stall' })
    if (!start.ok) throw new Error('start failed')
    const sessionId = (start.value as { sessionId: string }).sessionId

    const since = stallEvents.length
    const first = await dispatchRpc(stallManager, 'session/prompt', { sessionId, text: 'HANG' })
    if (!first.ok) throw new Error('prompt failed')
    const abandonedTurnId = (first.value as { turnId: string }).turnId
    const watchdog = await stallWaitFor('turn/end', event =>
      event.sessionId === sessionId && event.error !== undefined && event.error.includes('sent no activity'), since)
    // The watchdog frame cannot name a turn: no agent response exists to
    // attribute it to.
    expect(watchdog.turnId).toBe('')

    // The next message reclaims the process. Killing the child under the old
    // `session/prompt` rejects that request, and without the reclaim marker its
    // rejection would be broadcast as a SECOND turn/end for the abandoned turn.
    const resumeSince = stallEvents.length
    const second = await dispatchRpc(stallManager, 'session/prompt', { sessionId, text: 'hello after reclaim' })
    expect(second).toMatchObject({ ok: true, value: { accepted: true } })
    if (!second.ok) return
    const resumeTurnId = (second.value as { turnId: string }).turnId
    await stallWaitFor('turn/end', event =>
      event.sessionId === sessionId && event.turnId === resumeTurnId && event.stopReason === 'end_turn', resumeSince)

    // Let any late rejection from the dead child surface.
    await sleep(300)
    const endsForAbandoned = stallEvents.slice(since)
      .filter(event => event.type === 'turn/end' && event.sessionId === sessionId && event.turnId === abandonedTurnId)
    expect(endsForAbandoned).toHaveLength(0)
    const watchdogEnds = stallEvents.slice(since)
      .filter(event => event.type === 'turn/end' && event.sessionId === sessionId && event.error?.includes('sent no activity') === true)
    expect(watchdogEnds).toHaveLength(1)

    await dispatchRpc(stallManager, 'session/close', { sessionId })
  }, 20_000)

  it('/acp path: a stale chat controller does not blind the watchdog', async () => {
    // A card-final chat turn keeps its TurnStreamController indexed (its
    // continuation steps may still come). An `/acp` prompt on that SAME host
    // session then advances `turnSeq`, which makes the indexed controller
    // stale: its segment is already closed, so "on air" would read false and
    // the watchdog would skip this /acp turn forever.
    //
    // Only the FIRST driver step is drained on purpose: the host loop would
    // take the continuation step and retire the controller, which is exactly
    // the case where the stale record cannot exist.
    const warmup = await drain('hello warmup', 'dsh-stall-stale-controller')
    expect(finishOf(warmup)?.reason.kind).toBe('stop')
    const hostId = sessionViewOf(stallManager, 'dsh-stall-stale-controller')?.sessionId ?? ''
    expect(hostId).not.toBe('')
    // The stream above ends at its last card; the agent may not have answered
    // `session/prompt` yet. Wait for that settle — the controller stays
    // indexed (it has cards), which is what makes it stale below, but a
    // prompt sent while the turn still runs is refused `turn_in_flight`.
    await waitForTurnSettled(stallManager, 'dsh-stall-stale-controller')
    // The premise of this test: the previous turn's controller is still there.
    const seams = stallManager as unknown as { turnStreams: Map<string, unknown> }
    expect(seams.turnStreams.has('dsh-stall-stale-controller')).toBe(true)

    const since = stallEvents.length
    const prompt = await dispatchRpc(stallManager, 'session/prompt', { sessionId: hostId, text: 'HANG' })
    expect(prompt).toMatchObject({ ok: true, value: { accepted: true } })
    await stallWaitFor('turn/end', event =>
      event.sessionId === hostId && event.error !== undefined && event.error.includes('sent no activity'), since, 5_000)

    await dispatchRpc(stallManager, 'session/close', { sessionId: hostId })
  }, 20_000)

  it('/acp path: a no-load reset answers session_reset, not unknown_session', async () => {
    // A no-load reclaim drops the session record on purpose, and `/acp` has no
    // conversation to recreate it from. The caller must be told the session was
    // reset, not that the id it just used never existed.
    const start = await dispatchRpc(noLoadManager, 'session/start', { agentId: 'stall-noload' })
    if (!start.ok) throw new Error('start failed')
    const sessionId = (start.value as { sessionId: string }).sessionId

    const since = stallEvents.length
    const first = await dispatchRpc(noLoadManager, 'session/prompt', { sessionId, text: 'HANG' })
    expect(first).toMatchObject({ ok: true, value: { accepted: true } })
    await stallWaitFor('turn/end', event =>
      event.sessionId === sessionId && event.error !== undefined && event.error.includes('sent no activity'), since)
    // The watchdog finalizes the TURN only: the wedged child keeps running
    // until a message needs it back.
    expect(noLoadManager.agentViews().find(view => view.id === 'stall-noload')?.state).toBe('ready')

    const second = await dispatchRpc(noLoadManager, 'session/prompt', { sessionId, text: 'hello again' })
    expect(second).toMatchObject({ ok: false, error: { code: 'session_reset' } })
    if (!second.ok) expect(second.error.message).toContain('does not support session resume')
    // The reclaim is what tears the child down, without waiting for a graceful
    // `session/close` the wedged agent would never answer.
    expect(noLoadManager.agentViews().find(view => view.id === 'stall-noload')?.state).toBe('stopped')
  }, 20_000)

  it('chat path: a late real answer after the watchdog needs no reload', async () => {
    // The agent answers at 900ms; the window is 350ms. Our face of the turn is
    // force-finalized first, then the real answer lands on a session the host
    // already closed locally.
    await hostLoopTurn(stallAdapter, {
      provider: 'acp',
      model: 'stall',
      sessionId: 'dsh-stall-late',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hello warmup PIDTAG' }] }],
    })
    const hostId = sessionViewOf(stallManager, 'dsh-stall-late')?.sessionId ?? ''
    expect(hostId).not.toBe('')
    // The process serving this conversation. Only `PIDTAG` prompts carry it, so
    // every exact-echo assertion elsewhere in the suite stays byte-identical.
    const warm = await waitForTranscriptText(stallManager, 'dsh-stall-late', 'PID:')
    const pid = /PID:(\d+)/.exec(warm)?.[1] ?? ''
    expect(pid).not.toBe('')

    const since = stallEvents.length
    const delayed = await drain('HANG_DELAY:900 PIDTAG please', 'dsh-stall-late')
    expect(finishOf(delayed)?.reason).toMatchObject({ kind: 'error', failure: { code: 'INACTIVITY_TIMEOUT' } })
    const abandonedTurnId = (stallEvents.slice(since)
      .find(event => event.type === 'turn/start' && event.sessionId === hostId) as Extract<AcpEvent, { type: 'turn/start' }> | undefined)?.turnId ?? ''
    expect(abandonedTurnId).not.toBe('')

    // The late answer still writes into the transcript: the user sees it. Poll
    // for the echo instead of waiting on `running` — the watchdog already set
    // that to false, so a "turn settled" wait here is empty and the next prompt
    // would race the very `session/prompt` response the poll is waiting on. The
    // mock writes the echo (and its usage frame) AHEAD of that response on the
    // same stream, so seeing the echo means the response is at most a frame
    // behind; a fixed sleep here lost that race on a loaded box.
    const lateEcho = `MOCK: echo HANG_DELAY:900 PIDTAG please perm=none PID:${pid}`
    const late = await waitForTranscriptText(stallManager, 'dsh-stall-late', lateEcho)
    expect(late).toContain(lateEcho)

    // That answer cleared the orphan: the next message is served on the SAME
    // session/process. A reclaim would have replayed the history marker and
    // echoed from a NEW pid.
    await hostLoopTurn(stallAdapter, {
      provider: 'acp',
      model: 'stall',
      sessionId: 'dsh-stall-late',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hello after late PIDTAG' }] }],
    })
    const views = stallManager.chatTranscripts('dsh-stall-late')
    expect(views).toHaveLength(1)
    expect(views[0]?.session.sessionId).toBe(hostId)
    await settleTranscript(stallManager, hostId)
    const text = transcriptText('dsh-stall-late')
    expect(text).toContain(`MOCK: echo hello after late PIDTAG perm=none PID:${pid}`)
    expect(text).not.toContain('REPLAYED: earlier conversation')
    // Every answer in this conversation came from the warmed process: a respawn
    // would introduce a second pid even if it replayed the history.
    const pids = [...text.matchAll(/PID:(\d+)/g)].map(match => match[1])
    expect(new Set(pids)).toEqual(new Set([pid]))

    // The abandoned turn ended exactly once (the watchdog's frame): the late
    // answer did not settle it a second time.
    const oldTurnEnds = stallEvents.slice(since)
      .filter(event => event.type === 'turn/end' && event.turnId === abandonedTurnId)
    expect(oldTurnEnds).toHaveLength(1)
    expect(oldTurnEnds[0]).toMatchObject({ error: expect.stringContaining('sent no activity') })
  }, 20_000)

  it('closes an ephemeral turn\'s driver stream on a stall (no chat session id)', async () => {
    // A turn with no `options.sessionId` has no chat id to index its controller
    // under: the session attachment is the ONLY route the watchdog has to the
    // driver's segment queue. Without it the turn falls into the `/acp` branch,
    // which force-finalizes the session state but leaves that queue OPEN — this
    // stream would never finish (and the cancel fallback would not close it
    // either, since `finalizeTurn` only broadcasts the frame).
    const since = stallEvents.length
    const chunks: StreamChunk[] = []
    const drained = (async () => {
      for await (const chunk of stallAdapter.stream({
        provider: 'acp',
        model: 'stall',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'HANG ephemeral' }] }],
      })) chunks.push(chunk)
    })()
    // Bounded so a regression FAILS the suite instead of hanging it.
    const settled = await Promise.race([
      drained.then(() => true),
      sleep(10_000).then(() => false),
    ])
    expect(settled).toBe(true)
    expect(finishOf(chunks)?.reason).toMatchObject({ kind: 'error', failure: { code: 'INACTIVITY_TIMEOUT' } })
    expect(stallMessage(chunks)).toContain('sent no activity')

    // The host session id is the ephemeral turn's only identity: the watchdog's
    // frame and its notice both name it, and the turn ends exactly once.
    const started = stallEvents.slice(since).find((event): event is Extract<AcpEvent, { type: 'turn/start' }> =>
      event.type === 'turn/start' && event.text === 'HANG ephemeral')
    if (started === undefined) throw new Error('no turn/start for the ephemeral turn')
    const ends = stallEvents.slice(since)
      .filter(event => event.type === 'turn/end' && event.sessionId === started.sessionId)
    expect(ends).toHaveLength(1)
    const notices = stallEvents.slice(since)
      .filter(event => event.type === 'agent/notice' && event.agentId === 'stall' && event.text.includes('sent no activity'))
    expect(notices).toHaveLength(1)
    // No conversation lock was written, so there is nothing to roll back: the
    // notice promises the ordinary resume.
    if (notices[0]?.type === 'agent/notice') {
      expect(notices[0].text).toContain('restart the agent and resume the session')
    }

    // Retire the session: this manager is shared, and a leftover live session
    // would pin the agent process for later reclaim tests.
    await expect(dispatchRpc(stallManager, 'session/close', { sessionId: started.sessionId }))
      .resolves.toMatchObject({ ok: true })
  }, 20_000)
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

describe('conversation ↔ agent binding (isolated manager)', () => {
  const bindingHub = new EventHub()

  it('keeps the plugin default agent in its own registry, never in a DSH model route', async () => {
    const storage = `${tmpdir()}/acp-default-agent-${Date.now()}.json`
    const gm = new BridgeManager([{ ...def, id: 'guarded' }], bindingHub, 500, storage)

    // Unset reads as `undefined` — the panel's "no default agent chosen yet".
    expect(await dispatchRpc(gm, 'default/agent', {})).toEqual({ ok: true, value: { agentId: undefined } })
    await dispatchRpc(gm, 'default/agent-set', { agentId: 'guarded' })
    expect(await dispatchRpc(gm, 'default/agent', {})).toEqual({ ok: true, value: { agentId: 'guarded' } })

    // It lives in the agent registry file beside the agents, under its own key.
    const raw = JSON.parse(readFileSync(storage, 'utf-8')) as { version: number; defaultAgentId?: string; agents: unknown[] }
    expect(raw.defaultAgentId).toBe('guarded')
    expect(raw.agents).toHaveLength(1)
    expect(new BridgeManager([], bindingHub, 100, storage).defaultAgent()).toBe('guarded')

    // Deleting the agent clears the pointer (a default naming a missing agent
    // is reported as "none", so the browser offers the menu instead of
    // binding a session at nothing).
    await gm.deleteAgent('guarded')
    expect(gm.defaultAgent()).toBeUndefined()
    expect(JSON.parse(readFileSync(storage, 'utf-8')).defaultAgentId).toBeUndefined()
    await expect(gm.setDefaultAgent('ghost')).rejects.toMatchObject({ code: 'unknown_agent' })
    await gm.shutdownAll()
  })

  it('binds a conversation to an agent without touching any DSH model route', async () => {
    const gm = new BridgeManager([{ ...def, id: 'bound' }], bindingHub, 500, `${tmpdir()}/acp-bind-${Date.now()}.json`)

    // Nothing is bound yet.
    expect(gm.chatAgentFor('dsh-bind-1')).toBeUndefined()
    // Binding is a plugin-private write: no model selection is recorded anywhere.
    gm.bindChatAgent('dsh-bind-1', 'bound')
    expect(gm.chatAgentFor('dsh-bind-1')).toBe('bound')
    await expect(dispatchRpc(gm, 'session/chat-bind', { dshSessionId: 'dsh-bind-2', agentId: 'ghost' }))
      .resolves.toMatchObject({ ok: false, error: { code: 'unknown_agent' } })

    await gm.shutdownAll()
  })

  it('falls back to the session\'s own agent when no intent was recorded', async () => {
    const gm = new BridgeManager([{ ...def, id: 'bound' }], bindingHub, 500, `${tmpdir()}/acp-bind-fallback-${Date.now()}.json`)
    // A conversation that already RAN an agent is pointed at it even if the
    // intent map was never seeded (a session restored from the registry).
    gm.bindChatAgent('dsh-bind-3', 'bound')
    expect(gm.chatAgentFor('dsh-bind-3')).toBe('bound')
    await gm.shutdownAll()
  })
})

/**
 * A conversation must be set up BEFORE its first message.
 *
 * The composer's model / thought-level pickers used to write only into a live
 * ACP session, of which there is none until a turn has already gone out — so
 * the choice could not be made up front, and the first message always ran on
 * whatever the agent's defaults happened to be. The pick is now the plugin's
 * own persisted per-conversation record and is applied when the session
 * materializes (§ "apply on create/resume"), which is the OmniTerm behavior
 * this mirrors (its `config_prefs` agent-level + session-level restore).
 */
describe('agent lock at the start of the first turn (isolated manager)', () => {
  const lockHub = new EventHub()
  const lockAgents = [
    { ...def, id: 'lock-a', title: 'Lock A' },
    { ...def, id: 'lock-b', title: 'Lock B' },
  ]
  /**
   * Drive one turn the way the host loop does: stream a step, and while it
   * settled with tool-call cards, stage their results and stream the
   * continuation — so awaiting this helper means the turn really settled
   * (a single-segment drain would leave the slot claimed and the next turn
   * racing the agent's settle).
   */
  const turn = async (gm: BridgeManager, dshSessionId: string, agentId: string): Promise<void> => {
    const request = {
      model: agentId,
      sessionId: dshSessionId,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    } as never
    let messages = request.messages
    for (let step = 0; step < 8; step += 1) {
      const chunks: StreamChunk[] = []
      for await (const chunk of gm.streamPrompt({ ...request, messages } as never)) chunks.push(chunk)
      const finish = chunks.find((c): c is Extract<StreamChunk, { type: 'finish' }> => c.type === 'finish')
      const callIds = [...new Set(chunks.filter(c => c.type === 'tool-call-delta').map(c => (c as { id: string }).id))]
      if (finish === undefined || finish.reason.kind !== 'stop' || callIds.length === 0) return
      messages = [...messages, ...callIds.map(id => ({
        role: 'tool' as const,
        source: { kind: 'tool' as const, callId: id },
        content: [{ type: 'text' as const, text: 'staged result' }],
      }))]
    }
  }

  it('locks the conversation at the first turn\'s start, and refuses a switch everywhere', async () => {
    const gm = new BridgeManager(lockAgents, lockHub, 500, `${tmpdir()}/acp-lock-${Date.now()}.json`)
    gm.bindChatAgent('dsh-lock-1', 'lock-a')
    // A pick is not a lock: before the first turn the user may still change it.
    expect(gm.lockedAgentFor('dsh-lock-1')).toBeUndefined()
    gm.bindChatAgent('dsh-lock-1', 'lock-b')
    gm.bindChatAgent('dsh-lock-1', 'lock-a')

    // The lock is announced when the turn STARTS, before the agent has said
    // anything: the browser plays its hand-off while the turn is running, and
    // does not need to wait for the session list to settle.
    const seen: AcpEvent[] = []
    const off = lockHub.subscribe(event => { seen.push(event) })
    try {
      await turn(gm, 'dsh-lock-1', 'lock-a')
    } finally {
      off()
    }
    const lockAt = seen.findIndex(event => event.type === 'chat/agent-locked')
    const turnAt = seen.findIndex(event => event.type === 'turn/start')
    expect(lockAt).toBeGreaterThanOrEqual(0)
    expect(turnAt).toBeGreaterThanOrEqual(0)
    expect(lockAt).toBeLessThan(turnAt)
    expect(gm.lockedAgentFor('dsh-lock-1')).toBe('lock-a')
    expect(gm.chatChoice('dsh-lock-1')).toMatchObject({ agentId: 'lock-a', locked: true })

    // The picker path, the model path (a model id names its agent), and the
    // turn path all refuse another agent; re-binding the same one is a no-op.
    expect(() => gm.bindChatAgent('dsh-lock-1', 'lock-b')).toThrow(/locked/)
    expect(() => gm.bindChatAgent('dsh-lock-1', 'lock-a')).not.toThrow()
    // Over the browser's RPC the same refusal keeps its code, so the picker can
    // tell "you may not switch" apart from a transport failure.
    await expect(dispatchRpc(gm, 'session/chat-bind', { dshSessionId: 'dsh-lock-1', agentId: 'lock-b' }))
      .resolves.toMatchObject({ ok: false, error: { code: 'agent_locked' } })
    await expect(gm.setChatSessionModel('dsh-lock-1', 'lock-b@opus')).rejects.toMatchObject({ code: 'agent_locked' })
    await expect(gm.getOrCreateDshSession('dsh-lock-1', 'lock-b')).rejects.toMatchObject({ code: 'agent_locked' })

    // A turn arriving with another agent's model (a stale header, or a route
    // registry entry purged by a delete/re-add) is served by the LOCKED agent,
    // not rejected and never redirected. Driven to completion (continuations
    // included) so the settled-turn claim is honest.
    const staleRequest = {
      model: 'lock-b',
      sessionId: 'dsh-lock-1',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'again' }] }],
    } as never
    const staleChunks: StreamChunk[] = []
    let staleMessages = staleRequest.messages
    for (let step = 0; step < 8; step += 1) {
      const stepChunks: StreamChunk[] = []
      for await (const chunk of gm.streamPrompt({ ...staleRequest, messages: staleMessages } as never)) stepChunks.push(chunk)
      staleChunks.push(...stepChunks)
      const finish = stepChunks.find((c): c is Extract<StreamChunk, { type: 'finish' }> => c.type === 'finish')
      const callIds = [...new Set(stepChunks.filter(c => c.type === 'tool-call-delta').map(c => (c as { id: string }).id))]
      if (finish === undefined || finish.reason.kind !== 'stop' || callIds.length === 0) break
      staleMessages = [...staleMessages, ...callIds.map(id => ({
        role: 'tool' as const,
        source: { kind: 'tool' as const, callId: id },
        content: [{ type: 'text' as const, text: 'staged result' }],
      }))]
    }
    expect(staleChunks.find(chunk => chunk.type === 'finish')?.reason).toEqual({ kind: 'stop' })
    expect(gm.chatSessions('dsh-lock-1').map(session => session.agentId)).toEqual(['lock-a'])

    // The browser learns the lock from the same read that names the binding.
    const listed = await dispatchRpc(gm, 'session/chat-list', { dshSessionId: 'dsh-lock-1' })
    expect(listed).toMatchObject({ ok: true, value: { lockedAgentId: 'lock-a', boundAgentId: 'lock-a' } })
    await gm.shutdownAll()
  }, 30_000)

  it('keeps the lock across a host restart, when no session is live', async () => {
    const storage = `${tmpdir()}/acp-lock-restart-${Date.now()}.json`
    const first = new BridgeManager(lockAgents, lockHub, 500, storage)
    first.bindChatAgent('dsh-lock-2', 'lock-a')
    await turn(first, 'dsh-lock-2', 'lock-a')
    await first.shutdownAll()

    const second = new BridgeManager(lockAgents, lockHub, 500, storage)
    // The record is restored PARKED (a restart kills the process, not the
    // conversation); the persisted lock is what keeps it on its agent.
    expect(second.chatSessions('dsh-lock-2')).toMatchObject([{ agentId: 'lock-a', released: true }])
    expect(second.lockedAgentFor('dsh-lock-2')).toBe('lock-a')
    expect(second.chatChoice('dsh-lock-2')).toMatchObject({ agentId: 'lock-a', locked: true })
    // ...and the persisted record is back on the REQUEST path, not just in the
    // map: the guard's rewrite and the adapter's own check read this registry,
    // which starts empty on a fresh process.
    expect(routeBindingRegistry().conversations.get('dsh-lock-2')).toBe('lock-a')
    expect(() => second.bindChatAgent('dsh-lock-2', 'lock-b')).toThrow(/locked/)
    await second.shutdownAll()
  }, 30_000)

  it('gives the conversation back when the first turn delivers nothing', async () => {
    const gm = new BridgeManager(lockAgents, lockHub, 500, `${tmpdir()}/acp-lock-empty-${Date.now()}.json`)
    gm.bindChatAgent('dsh-lock-empty', 'lock-a')
    const seen: AcpEvent[] = []
    const off = lockHub.subscribe(event => { seen.push(event) })
    try {
      const chunks: StreamChunk[] = []
      for await (const chunk of gm.streamPrompt({
        model: 'lock-a',
        sessionId: 'dsh-lock-empty',
        // The mock answers this with bookkeeping only, then a legal end_turn:
        // the silent provider-failure shape. Nothing was exchanged.
        messages: [{ role: 'user', content: [{ type: 'text', text: 'EMPTY' }] }],
      } as never)) chunks.push(chunk)
      // The empty-turn warning is still reported (rule 23)...
      expect(chunks.find(chunk => chunk.type === 'finish')?.reason).toEqual({ kind: 'stop' })
      expect(chunks.some(chunk => chunk.type === 'text-delta' && chunk.text.includes('no visible output'))).toBe(true)
      // ...but the conversation is not trapped on an agent that produced nothing.
      expect(seen.map(event => event.type)).toEqual(expect.arrayContaining(['chat/agent-locked', 'chat/agent-unlocked']))
      expect(gm.lockedAgentFor('dsh-lock-empty')).toBeUndefined()
      expect(gm.chatChoice('dsh-lock-empty')).toEqual({ agentId: 'lock-a' })
      expect(gm.chatSessions('dsh-lock-empty')).toEqual([])
      // The picker accepts another agent again.
      expect(() => gm.bindChatAgent('dsh-lock-empty', 'lock-b')).not.toThrow()
    } finally {
      off()
      await gm.shutdownAll()
    }
  }, 30_000)

  it('rolls the lock back when the first prompt itself fails', async () => {
    const gm = new BridgeManager(lockAgents, lockHub, 500, `${tmpdir()}/acp-lock-fail-${Date.now()}.json`)
    gm.bindChatAgent('dsh-lock-fail', 'lock-a')
    const seen: AcpEvent[] = []
    const off = lockHub.subscribe(event => { seen.push(event) })
    try {
      const chunks: StreamChunk[] = []
      for await (const chunk of gm.streamPrompt({
        model: 'lock-a',
        sessionId: 'dsh-lock-fail',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'FAIL' }] }],
      } as never)) chunks.push(chunk)
      expect(chunks.find(chunk => chunk.type === 'finish')?.reason).toMatchObject({ kind: 'error' })
      expect(seen.map(event => event.type)).toEqual(expect.arrayContaining(['chat/agent-locked', 'chat/agent-unlocked']))
      expect(gm.lockedAgentFor('dsh-lock-fail')).toBeUndefined()
      expect(gm.chatChoice('dsh-lock-fail')).toEqual({ agentId: 'lock-a' })
      expect(gm.chatSessions('dsh-lock-fail')).toEqual([])
      expect(() => gm.bindChatAgent('dsh-lock-fail', 'lock-b')).not.toThrow()
    } finally {
      off()
      await gm.shutdownAll()
    }
  }, 30_000)
})

describe('pre-chat pick persistence (isolated manager)', () => {
  const pickHub = new EventHub()

  it('records a model/effort pick before any ACP session exists, and reports it back', async () => {
    const storage = `${tmpdir()}/acp-pick-${Date.now()}.json`
    const gm = new BridgeManager([{ ...def, id: 'picked' }], pickHub, 500, storage)

    // Nothing bound and nothing picked: the composer has nothing to show.
    expect(gm.chatChoice('dsh-pick-1')).toBeUndefined()

    gm.bindChatAgent('dsh-pick-1', 'picked')
    // No live session exists at this point — that is the whole point.
    expect(gm.chatSessions('dsh-pick-1')).toEqual([])

    await gm.setChatSessionModel('dsh-pick-1', 'picked@opus')
    await gm.setChatSessionEffort('dsh-pick-1', 'high')
    expect(gm.chatChoice('dsh-pick-1')).toEqual({ agentId: 'picked', modelId: 'picked@opus', effort: 'high' })
    // Still no session: the pick was recorded without creating one.
    expect(gm.chatSessions('dsh-pick-1')).toEqual([])

    await gm.shutdownAll()
  })

  it('persists the tag halo preference and reloads it', async () => {
    const storage = `${tmpdir()}/acp-halo-${Date.now()}.json`
    const gm = new BridgeManager([{ ...def, id: 'picked' }], pickHub, 500, storage)
    // The default before anything was ever saved.
    expect(gm.tagHalo()).toEqual({ mode: 'breath', speed: 'normal' })

    await gm.setTagHalo({ mode: 'steady', speed: 'slow' })
    // A fresh manager (host restart) reads the same registry file back.
    const reloaded = new BridgeManager([{ ...def, id: 'picked' }], pickHub, 500, storage)
    expect(reloaded.tagHalo()).toEqual({ mode: 'steady', speed: 'slow' })
    await reloaded.shutdownAll()
    await gm.shutdownAll()
  })

  it('edits an approval deadline live, persists it, and resets to the config file', async () => {
    const storage = `${tmpdir()}/acp-deadlines-${Date.now()}.json`
    const gm = new BridgeManager([{ ...def, id: 'picked' }], pickHub, 500, storage)
    // Nothing configured, nothing overridden: the built-in 5-minute window and
    // the default mode.
    expect(gm.approvalDeadlines()).toEqual({ permissionTimeoutMs: 300_000, mode: 'wait' })
    // A deployment that names the window in `cordis.patch.yml` reports it as
    // the reset target — "the file says 10 minutes" and "nothing was
    // configured, 5 is the built-in default" are different facts, and the
    // settings card has to be able to tell them apart.
    gm.setConfiguredApprovalDeadlines({ permissionTimeoutMs: 600_000 }, 'wait')
    expect(gm.approvalDeadlines()).toMatchObject({
      permissionTimeoutMs: 600_000,
      mode: 'wait',
      configured: { permissionTimeoutMs: 600_000 },
      configuredMode: 'wait',
    })

    // The UI write outranks the config file and reaches the LIVE bridge without
    // restarting anything — the whole point over an `agent/save`-style reload,
    // which would cost the user every running session.
    const tuningOf = (b: AgentBridge): { permissionTimeoutMs: number } =>
      b as unknown as { permissionTimeoutMs: number }
    const liveBridge = new AgentBridge({ ...def, id: 'live' }, pickHub, 500, () => { /* no manager behind it */ })
    ;(gm as unknown as { bridges: Map<string, AgentBridge> }).bridges.set('live', liveBridge)
    await gm.setApprovalDeadlines({ permissionTimeoutMs: 30_000, mode: 'auto' })
    expect(gm.approvalDeadlines()).toMatchObject({
      permissionTimeoutMs: 30_000,
      mode: 'auto',
      configured: { permissionTimeoutMs: 600_000 },
      configuredMode: 'wait',
    })
    expect(tuningOf(liveBridge).permissionTimeoutMs).toBe(30_000)
    // The mode reaches the live bridge too — it decides what an expiry DOES.
    expect((liveBridge as unknown as { permissionTimeoutMode: string }).permissionTimeoutMode).toBe('auto')

    // Persisted: a host restart comes back on the value the user picked, not the
    // deployment baseline. The host entry re-declares the patch file's baseline
    // on every boot, so the override has to keep outranking it after a restart.
    const reloaded = new BridgeManager([{ ...def, id: 'picked' }], pickHub, 500, storage)
    reloaded.setConfiguredApprovalDeadlines({ permissionTimeoutMs: 600_000 }, 'wait')
    expect(reloaded.approvalDeadlines()).toMatchObject({
      permissionTimeoutMs: 30_000,
      mode: 'auto',
      configured: { permissionTimeoutMs: 600_000 },
    })

    // Reset drops the override: the config file decides again.
    await reloaded.setApprovalDeadlines({}, true)
    expect(reloaded.approvalDeadlines()).toMatchObject({
      permissionTimeoutMs: 600_000,
      mode: 'wait',
    })
    // A fresh manager over the same file sees the same thing (the reset persisted).
    const afterReset = new BridgeManager([{ ...def, id: 'picked' }], pickHub, 500, storage)
    afterReset.setConfiguredApprovalDeadlines({ permissionTimeoutMs: 600_000 }, 'wait')
    expect(afterReset.approvalDeadlines()).toMatchObject({ permissionTimeoutMs: 600_000, mode: 'wait' })

    // An out-of-range write is refused before it can reach state, and the value
    // in force is untouched.
    await expect(reloaded.setApprovalDeadlines({ permissionTimeoutMs: -1 })).rejects.toThrow(/permissionTimeoutMs/)
    expect(reloaded.approvalDeadlines().permissionTimeoutMs).toBe(600_000)
    // A mode that is not one of the three is refused the same way.
    await expect(reloaded.setApprovalDeadlines({ mode: 'maybe' as never })).rejects.toThrow(/permissionTimeoutMode/)
    expect(reloaded.approvalDeadlines().mode).toBe('wait')

    await afterReset.shutdownAll()
    await reloaded.shutdownAll()
    await gm.shutdownAll()
  })

  interface PersistedDeadlines {
    approvalDeadlines?: { permissionTimeoutMs?: number; mode?: string }
  }

  const readDeadlines = (storage: string): PersistedDeadlines['approvalDeadlines'] =>
    (JSON.parse(readFileSync(storage, 'utf-8')) as PersistedDeadlines).approvalDeadlines

  it('keeps a user-picked zero through a mode switch and a restart', async () => {
    const storage = `${tmpdir()}/acp-deadline-zero-${Date.now()}.json`
    const gm = new BridgeManager([{ ...def, id: 'zero' }], pickHub, 500, storage)
    // 不等待 is the user's pick: it runs as zero under `auto`.
    await gm.setApprovalDeadlines({ permissionTimeoutMs: 0, mode: 'auto' })
    expect(gm.approvalDeadlines()).toMatchObject({ permissionTimeoutMs: 0, mode: 'auto' })
    // A mode-only write carries no window: the stored zero survives, while the
    // RUNTIME value floors to the shortest real wait under `abort`.
    await gm.setApprovalDeadlines({ mode: 'abort' })
    expect(gm.approvalDeadlines()).toMatchObject({ permissionTimeoutMs: 30_000, mode: 'abort' })
    expect(readDeadlines(storage)).toEqual({ permissionTimeoutMs: 0, mode: 'abort' })
    // Switching back restores the zero — because the write never rewrote it.
    await gm.setApprovalDeadlines({ mode: 'auto' })
    expect(gm.approvalDeadlines()).toMatchObject({ permissionTimeoutMs: 0, mode: 'auto' })
    expect(readDeadlines(storage)).toEqual({ permissionTimeoutMs: 0, mode: 'auto' })
    // A restart reads the same raw zero back, and the runtime agrees.
    const reloaded = new BridgeManager([{ ...def, id: 'zero' }], pickHub, 500, storage)
    expect(reloaded.approvalDeadlines()).toMatchObject({ permissionTimeoutMs: 0, mode: 'auto' })
    expect(readDeadlines(storage)).toEqual({ permissionTimeoutMs: 0, mode: 'auto' })
    await reloaded.shutdownAll()
    await gm.shutdownAll()
  })

  it('keeps a real window unchanged through every mode switch', async () => {
    const storage = `${tmpdir()}/acp-deadline-real-${Date.now()}.json`
    const gm = new BridgeManager([{ ...def, id: 'real' }], pickHub, 500, storage)
    await gm.setApprovalDeadlines({ permissionTimeoutMs: 300_000, mode: 'auto' })
    expect(readDeadlines(storage)).toEqual({ permissionTimeoutMs: 300_000, mode: 'auto' })
    await gm.setApprovalDeadlines({ mode: 'abort' })
    expect(gm.approvalDeadlines()).toMatchObject({ permissionTimeoutMs: 300_000, mode: 'abort' })
    expect(readDeadlines(storage)).toEqual({ permissionTimeoutMs: 300_000, mode: 'abort' })
    await gm.setApprovalDeadlines({ mode: 'auto' })
    expect(gm.approvalDeadlines()).toMatchObject({ permissionTimeoutMs: 300_000, mode: 'auto' })
    expect(readDeadlines(storage)).toEqual({ permissionTimeoutMs: 300_000, mode: 'auto' })
    const reloaded = new BridgeManager([{ ...def, id: 'real' }], pickHub, 500, storage)
    expect(reloaded.approvalDeadlines()).toMatchObject({ permissionTimeoutMs: 300_000, mode: 'auto' })
    await reloaded.shutdownAll()
    await gm.shutdownAll()
  })

  it('floors a persisted zero under abort at runtime only', async () => {
    // A state file can hold any pair the user or an older build wrote. The
    // zero must NOT become 「不等待并立即拒绝」: under `abort` it runs as the
    // 30 s minimum, and the file stays what the user chose.
    const storage = `${tmpdir()}/acp-deadline-legacy-zero-${Date.now()}.json`
    writeFileSync(storage, JSON.stringify({
      version: 2,
      approvalDeadlines: { permissionTimeoutMs: 0, mode: 'abort' },
    }), 'utf-8')
    const gm = new BridgeManager([{ ...def, id: 'legacy-zero' }], pickHub, 500, storage)
    expect(gm.approvalDeadlines()).toMatchObject({ permissionTimeoutMs: 30_000, mode: 'abort' })
    expect(readDeadlines(storage)).toEqual({ permissionTimeoutMs: 0, mode: 'abort' })
    await gm.shutdownAll()
  })

  it('reads the persisted zero back raw at boot, so a mode switch can restore it', async () => {
    // Startup must not rewrite the stored pick with the abort floor. If the
    // load path normalized it, the runtime would read the same 30 s as the
    // fixed logic and nothing below could fail — so this case asserts BOTH
    // halves: the runtime floor at boot, and the raw zero still being the
    // value a later switch back to `auto` runs on (the file included).
    const storage = `${tmpdir()}/acp-deadline-boot-zero-${Date.now()}.json`
    writeFileSync(storage, JSON.stringify({
      version: 2,
      approvalDeadlines: { permissionTimeoutMs: 0, mode: 'abort' },
    }), 'utf-8')
    const gm = new BridgeManager([{ ...def, id: 'boot-zero' }], pickHub, 500, storage)
    // Boot applies the abort floor to the RUNTIME value only.
    expect(gm.approvalDeadlines()).toMatchObject({ permissionTimeoutMs: 30_000, mode: 'abort' })
    // Switching back to `auto` recovers 不等待 from the stored value, not from
    // a boot-time rewrite of it.
    await gm.setApprovalDeadlines({ mode: 'auto' })
    expect(gm.approvalDeadlines()).toMatchObject({ permissionTimeoutMs: 0, mode: 'auto' })
    expect(readDeadlines(storage)).toEqual({ permissionTimeoutMs: 0, mode: 'auto' })
    await gm.shutdownAll()
    // A second boot over the same file agrees, so the guard also covers
    // reading a value the restart itself wrote.
    const reloaded = new BridgeManager([{ ...def, id: 'boot-zero' }], pickHub, 500, storage)
    expect(reloaded.approvalDeadlines()).toMatchObject({ permissionTimeoutMs: 0, mode: 'auto' })
    await reloaded.shutdownAll()
  })

  it('records an extra config option and applies it when the first session materializes', async () => {
    const storage = `${tmpdir()}/acp-pick-config-${Date.now()}.json`
    const gm = new BridgeManager([{ ...def, id: 'picked' }], pickHub, 500, storage)
    try {
      await gm.probeAgentModels('picked')
      // `temp` is the mock agent's extra: a select with no category. It is what
      // the composer's advanced base lists (the model/thought/mode axes keep
      // their own controls and are not repeated there).
      expect(gm.agentCatalog('picked').extras).toEqual([{
        configId: 'temp',
        name: 'Temperature',
        currentValue: 'mid',
        choices: [
          { id: 'low', name: 'low' },
          { id: 'mid', name: 'mid' },
          { id: 'high', name: 'high' },
        ],
      }, {
        // A boolean toggle: `kind` is what makes the composer draw a checkbox
        // row instead of an empty select.
        configId: 'stream',
        name: 'Stream Mode',
        kind: 'boolean',
        currentValue: 'false',
        choices: [],
      }])

      gm.bindChatAgent('dsh-pick-config', 'picked')
      await dispatchRpc(gm, 'session/chat-config-set', {
        dshSessionId: 'dsh-pick-config', configId: 'temp', value: 'high',
      })
      // A checkbox pick arrives as 'true' / 'false' from the browser row and is
      // stored as a real boolean.
      await dispatchRpc(gm, 'session/chat-config-set', {
        dshSessionId: 'dsh-pick-config', configId: 'stream', value: 'true',
      })
      expect(gm.chatChoice('dsh-pick-config')).toMatchObject({
        agentId: 'picked',
        extraConfigs: { temp: 'high', stream: true },
      })

      // The first turn creates the session; the pick reaches the agent before
      // the prompt is sent (`applyChatChoice`).
      for await (const _ of gm.streamPrompt({
        model: 'picked',
        sessionId: 'dsh-pick-config',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      } as never)) { /* drain */ }
      const live = (gm.sessions() as Array<{
        agentId: string
        configOptions?: Array<{ configId: string; currentValue: unknown }>
      }>).find(session => session.agentId === 'picked')
      expect(live?.configOptions?.find(option => option.configId === 'temp')?.currentValue).toBe('high')
      // The toggle reached the agent as a real boolean (`type: 'boolean'` is
      // enforced by the mock, which throws on a bare value).
      expect(live?.configOptions?.find(option => option.configId === 'stream')?.currentValue).toBe(true)

      // The primary axes are not extras; unknown values are refused, and a
      // toggle only accepts its own vocabulary.
      await expect(gm.setChatSessionConfig('dsh-pick-config', 'temp', 'nope')).rejects.toMatchObject({ code: 'bad_config' })
      await expect(gm.setChatSessionConfig('dsh-pick-config', 'model', 'mock-model-a')).rejects.toMatchObject({ code: 'unknown_config' })
      await expect(gm.setChatSessionConfig('dsh-pick-config', 'stream', 'nope')).rejects.toMatchObject({ code: 'bad_config' })

      // It is part of the conversation record, not process state.
      const reloaded = new BridgeManager([{ ...def, id: 'picked' }], pickHub, 500, storage)
      expect(reloaded.chatChoice('dsh-pick-config')).toMatchObject({ extraConfigs: { temp: 'high', stream: true } })
      await reloaded.shutdownAll()
    } finally {
      await gm.shutdownAll()
    }
  }, 30_000)

  it('reports the agent\'s own slash commands with the chat session view', async () => {
    const gm = new BridgeManager([{ ...def, id: 'picked' }], pickHub, 500, `${tmpdir()}/acp-pick-commands-${Date.now()}.json`)
    gm.bindChatAgent('dsh-pick-cmd', 'picked')
    for await (const _ of gm.streamPrompt({
      model: 'picked',
      sessionId: 'dsh-pick-cmd',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    } as never)) { /* drain */ }

    // The composer's `/` menu is the agent's in an NTR conversation, and these
    // are its rows: the whole row the agent declared, not just a name.
    expect(gm.chatSessions('dsh-pick-cmd')[0]?.availableCommands).toEqual([
      { name: 'greet', description: 'say hi' },
    ])
    // The same declaration is cached per agent, so a conversation that has no
    // session yet can list it before its first message.
    expect(gm.agentCatalog('picked').commands).toEqual([{ name: 'greet', description: 'say hi' }])
    await gm.shutdownAll()
  }, 30_000)

  it('keeps the agent\'s slash commands across a host restart', async () => {
    // The cache is what `/` reads in a brand-new conversation, so it has to
    // outlive the process that learned it — like the model catalog does.
    const home = join(tmpdir(), `acp-cmd-cache-${Date.now()}`)
    mkdirSync(home, { recursive: true })
    const previous = process.env.DSH_NTR_STATE_DIR
    process.env.DSH_NTR_STATE_DIR = join(home, 'state')
    try {
      const first = new BridgeManager([{ ...def, id: 'cmd-cache' }], pickHub, 500, join(home, 'agents.json'))
      first.bindChatAgent('dsh-cmd-1', 'cmd-cache')
      for await (const _ of first.streamPrompt({
        model: 'cmd-cache',
        sessionId: 'dsh-cmd-1',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      } as never)) { /* drain */ }
      await first.shutdownAll()

      const second = new BridgeManager([{ ...def, id: 'cmd-cache' }], pickHub, 500, join(home, 'agents.json'))
      // The session record is restored PARKED (a restart kills the process,
      // not the conversation)...
      expect(second.chatSessions('dsh-cmd-1')).toMatchObject([{ agentId: 'cmd-cache', released: true }])
      // ...and the agent-level answer — what `/` reads in a brand-new
      // conversation — is there too.
      expect(second.agentCatalog('cmd-cache').commands).toEqual([{ name: 'greet', description: 'say hi' }])
      await second.shutdownAll()
    } finally {
      if (previous === undefined) delete process.env.DSH_NTR_STATE_DIR
      else process.env.DSH_NTR_STATE_DIR = previous
    }
  }, 30_000)

  it('survives a host restart, because the pick belongs to the conversation, not the process', async () => {
    const storage = `${tmpdir()}/acp-pick-restart-${Date.now()}.json`
    const first = new BridgeManager([{ ...def, id: 'picked' }], pickHub, 500, storage)
    first.bindChatAgent('dsh-pick-2', 'picked')
    await first.setChatSessionModel('dsh-pick-2', 'picked@sonnet')
    await first.setChatSessionEffort('dsh-pick-2', 'low')
    await first.shutdownAll()

    // A fresh manager over the same storage answers with the same pick — this
    // is what a browser reloading after a host restart reads back.
    const second = new BridgeManager([{ ...def, id: 'picked' }], pickHub, 500, storage)
    expect(second.chatChoice('dsh-pick-2')).toEqual({ agentId: 'picked', modelId: 'picked@sonnet', effort: 'low' })
    await second.shutdownAll()
  })

  it('drops the previous agent\'s model and effort when the conversation switches agent', async () => {
    const gm = new BridgeManager(
      [{ ...def, id: 'alpha' }, { ...def, id: 'beta' }],
      pickHub,
      500,
      `${tmpdir()}/acp-pick-switch-${Date.now()}.json`,
    )
    gm.bindChatAgent('dsh-pick-3', 'alpha')
    await gm.setChatSessionModel('dsh-pick-3', 'alpha@opus')
    await gm.setChatSessionEffort('dsh-pick-3', 'high')

    // Those values are alpha's vocabulary: `opus` is a choice from ITS catalog
    // and `high` a value of ITS thought_level. Carrying them to beta would ask
    // the new agent for things it never offered.
    gm.bindChatAgent('dsh-pick-3', 'beta')
    expect(gm.chatChoice('dsh-pick-3')).toEqual({ agentId: 'beta' })

    // Re-picking the SAME agent is not a switch: the model and effort stand.
    await gm.setChatSessionModel('dsh-pick-3', 'beta@sonnet')
    gm.bindChatAgent('dsh-pick-3', 'beta')
    expect(gm.chatChoice('dsh-pick-3')).toEqual({ agentId: 'beta', modelId: 'beta@sonnet' })
    await gm.shutdownAll()
  })

  /**
   * The agent's own mode is the third control in the same bar, so it follows the
   * same "remember the last choice" contract. It used to be the one that did
   * not: `setChatSessionMode` wrote only into the live session, so a restart
   * silently put the conversation back on the agent's starting mode.
   */
  it('persists the agent\'s own mode alongside the model and thought level', async () => {
    const storage = `${tmpdir()}/acp-pick-mode-${Date.now()}.json`
    const gm = new BridgeManager([def], pickHub, 500, storage)
    gm.bindChatAgent('dsh-pick-mode-1', 'mock')
    // The mode can only be SET once a session exists (the agent declares its
    // mode list in `session/new`), so send one turn to materialize it.
    for await (const _ of gm.streamPrompt({
      model: 'mock',
      sessionId: 'dsh-pick-mode-1',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    } as never)) { /* drain */ }
    const [session] = gm.chatSessions('dsh-pick-mode-1')
    const available = session?.modes?.availableModes ?? []
    expect(available.length).toBeGreaterThan(1)
    const target = available.find(mode => mode.id !== session?.modes?.currentModeId)
    expect(target).toBeDefined()

    await gm.setChatSessionMode('dsh-pick-mode-1', target!.id, 'mock')
    // The pick now carries the mode next to the other two axes.
    expect(gm.chatChoice('dsh-pick-mode-1')).toMatchObject({ agentId: 'mock', mode: target!.id })

    // And it survives a host restart, which is the whole point.
    await gm.shutdownAll()
    const again = new BridgeManager([def], pickHub, 500, storage)
    expect(again.chatChoice('dsh-pick-mode-1')).toMatchObject({ agentId: 'mock', mode: target!.id })
    await again.shutdownAll()
  })

  it('records a mode pick before any ACP session exists', async () => {
    // The composer's mode select reads its OPTIONS from the agent catalog, so it
    // is now reachable on a conversation that has never sent a message — and the
    // click must land. It used to throw `unknown_session` here, which on screen
    // is indistinguishable from a dead control (user report, 2026-10-18).
    const gm = new BridgeManager([def], pickHub, 500, `${tmpdir()}/acp-pick-mode-early-${Date.now()}.json`)
    gm.bindChatAgent('dsh-pick-mode-3', 'mock')
    expect(gm.chatSessions('dsh-pick-mode-3')).toEqual([])
    await gm.setChatSessionMode('dsh-pick-mode-3', 'strict', 'mock')
    expect(gm.chatChoice('dsh-pick-mode-3')).toMatchObject({ agentId: 'mock', mode: 'strict' })
    // Still nothing spawned: choosing ahead of the first message costs no process.
    expect(gm.chatSessions('dsh-pick-mode-3')).toEqual([])
    // ...and it is applied to the session the first turn materializes.
    for await (const _ of gm.streamPrompt({
      model: 'mock',
      sessionId: 'dsh-pick-mode-3',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    } as never)) { /* drain */ }
    expect(gm.chatSessions('dsh-pick-mode-3')[0]?.modes?.currentModeId).toBe('strict')
    await gm.shutdownAll()

    // A conversation pointed at NO agent still fails honestly — that is a caller
    // bug, not a conversation being set up.
    const nowhere = new BridgeManager([def], pickHub, 500, `${tmpdir()}/acp-pick-mode-none-${Date.now()}.json`)
    await expect(nowhere.setChatSessionMode('never-bound', 'strict'))
      .rejects.toThrow(/no live ACP session is bound/)
    await nowhere.shutdownAll()
  }, 30_000)

  it('runs the first turn on the mode the composer showed without an explicit pick', async () => {
    // The mode select's value before the first message is the catalog's
    // last-known mode (whatever another conversation left there), while
    // `session/new` starts on the agent's own default. The composer's contract
    // is "whatever it shows is what runs" — so the displayed mode is one of the
    // pre-turn defaults the session must be seeded with, like model / effort.
    const events: AcpEvent[] = []
    const hub = new EventHub()
    hub.subscribe(event => { events.push(event) })
    const gm = new BridgeManager(
      [{ ...def, id: 'modepick', env: { MOCK_MODE_OPTION: '1', MOCK_FIRST_MODE: 'strict' } }],
      hub,
      500,
      `${tmpdir()}/acp-displayed-mode-${Date.now()}.json`,
    )
    try {
      // A probe is the gesture that fills the composer's mode select before a
      // session exists: the catalog says 'strict'. The chat session this test
      // opens afterwards is the SECOND one on that process and starts on the
      // agent's own 'default'.
      await gm.probeAgentModels('modepick')
      expect(gm.agentCatalog('modepick').mode?.currentValue).toBe('strict')

      gm.bindChatAgent('dsh-displayed-mode', 'modepick')
      expect(gm.chatChoice('dsh-displayed-mode')?.mode).toBeUndefined()
      const since = events.length
      for await (const _ of gm.streamPrompt({
        model: 'modepick',
        sessionId: 'dsh-displayed-mode',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      } as never)) { /* drain */ }

      // Proof the agent did NOT start on the displayed mode: `session/created`
      // carries the fresh session's own answer.
      const created = events.slice(since).find((event): event is Extract<AcpEvent, { type: 'session/created' }> => event.type === 'session/created')
      expect(created?.session.modes?.currentModeId).toBe('default')
      // ...yet the first turn ran on what the composer showed, and the pick is
      // the conversation's record from now on.
      expect(gm.chatSessions('dsh-displayed-mode')[0]?.modes?.currentModeId).toBe('strict')
      expect(gm.chatChoice('dsh-displayed-mode')).toMatchObject({ agentId: 'modepick', mode: 'strict' })
    } finally {
      await gm.shutdownAll()
    }
  }, 30_000)

  it('drops the previous agent\'s mode when the conversation switches agent', async () => {
    const gm = new BridgeManager(
      [{ ...def, id: 'alpha2' }, { ...def, id: 'beta2' }],
      pickHub,
      500,
      `${tmpdir()}/acp-pick-mode-switch-${Date.now()}.json`,
    )
    // Seed a mode directly through the receipt path used by the RPC layer.
    gm.bindChatAgent('dsh-pick-mode-2', 'alpha2')
    const internal = gm as unknown as {
      patchChatChoice(id: string, patch: Record<string, unknown>): void
    }
    internal.patchChatChoice('dsh-pick-mode-2', { agentId: 'alpha2', mode: 'plan' })
    expect(gm.chatChoice('dsh-pick-mode-2')).toMatchObject({ mode: 'plan' })
    // A mode id belongs to the agent that declared it; beta2 never offered it.
    gm.bindChatAgent('dsh-pick-mode-2', 'beta2')
    expect(gm.chatChoice('dsh-pick-mode-2')).toEqual({ agentId: 'beta2' })
    await gm.shutdownAll()
  })

  it('serves the pick over session/chat-list so the composer can show it before the first turn', async () => {
    const gm = new BridgeManager([{ ...def, id: 'picked' }], pickHub, 500, `${tmpdir()}/acp-pick-rpc-${Date.now()}.json`)
    await dispatchRpc(gm, 'session/chat-bind', { dshSessionId: 'dsh-pick-4', agentId: 'picked' })
    await dispatchRpc(gm, 'session/chat-model-set', { dshSessionId: 'dsh-pick-4', modelId: 'picked@opus' })
    await dispatchRpc(gm, 'session/chat-effort-set', { dshSessionId: 'dsh-pick-4', effort: 'high' })

    const listed = await dispatchRpc(gm, 'session/chat-list', { dshSessionId: 'dsh-pick-4' })
    expect(listed).toMatchObject({
      ok: true,
      value: {
        sessions: [],
        boundAgentId: 'picked',
        choice: { agentId: 'picked', modelId: 'picked@opus', effort: 'high' },
      },
    })
    // Clearing the effort reports the absence honestly instead of keeping a
    // stale value the agent is not running.
    await dispatchRpc(gm, 'session/chat-effort-set', { dshSessionId: 'dsh-pick-4' })
    expect(gm.chatChoice('dsh-pick-4')).toEqual({ agentId: 'picked', modelId: 'picked@opus' })
    await gm.shutdownAll()
  })

  it('carries the picked model onto the request path, not just the bare agent', async () => {
    const gm = new BridgeManager([{ ...def, id: 'picked' }], pickHub, 500, `${tmpdir()}/acp-pick-route-${Date.now()}.json`)
    gm.bindChatAgent('dsh-pick-5', 'picked')
    // The guard's `agent/request` rewrite reads this registry; a bare agent id
    // here would silently drop the variant the user chose up front.
    expect(routeBindingRegistry().conversations.get('dsh-pick-5')).toBe('picked')
    await gm.setChatSessionModel('dsh-pick-5', 'picked@opus')
    expect(routeBindingRegistry().conversations.get('dsh-pick-5')).toBe('picked@opus')
    await gm.shutdownAll()
  })

  /**
   * The pick must be REAL: a model chosen before the first message has to be on
   * the agent before that message runs, not applied afterwards.
   *
   * `session/new` answers with the agent's own defaults (`mock-model-a`, `high`),
   * so without `applyChatChoice` the first turn would run on them — the pick
   * would take effect only from the second message on, which is exactly the
   * "chose a model, got another one" bug this whole record exists to prevent.
   */
  it('applies a pick made before the first turn when the session is created', async () => {
    const applyHub = new EventHub()
    const meta: Array<{ configId: string; currentValue: string }[]> = []
    applyHub.subscribe(event => {
      if (event.type !== 'session/meta') return
      const options = (event.session as unknown as { configOptions?: Array<{ configId: string; currentValue: string }> }).configOptions
      if (options !== undefined) meta.push(options)
    })
    const gm = new BridgeManager([{ ...def, id: 'mock' }], applyHub, 500, `${tmpdir()}/acp-pick-apply-${Date.now()}.json`)
    // Choose `mock-model-b` / `off` with NO session in existence — the pre-chat
    // case, before a single message has been sent.
    gm.bindChatAgent('dsh-pick-6', 'mock')
    await gm.setChatSessionModel('dsh-pick-6', 'mock@mock-model-b')
    await gm.setChatSessionEffort('dsh-pick-6', 'off')
    expect(gm.chatSessions('dsh-pick-6')).toEqual([])

    const chunks: StreamChunk[] = []
    for await (const chunk of gm.streamPrompt({
      model: 'mock',
      sessionId: 'dsh-pick-6',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
    } as never)) chunks.push(chunk)
    expect(chunks.at(-1)).toMatchObject({ type: 'finish' })

    // The AGENT is now on the picked values, not its defaults: `session/meta`
    // carries the option set `session/set_config_option` answered with.
    const last = meta.at(-1) ?? []
    expect(last.find(option => option.configId === 'model')?.currentValue).toBe('mock-model-b')
    expect(last.find(option => option.configId === 'thought')?.currentValue).toBe('off')
    // ...and the conversation reports what is actually in force.
    const [session] = gm.chatSessions('dsh-pick-6')
    expect(session?.modelId).toBe('mock@mock-model-b')
    expect(session?.reasoningEffort).toBe('off')
    await gm.shutdownAll()
  })

  it('records a thought/config pick when the conversation is served by the plugin default', async () => {
    const gm = new BridgeManager([{ ...def, id: 'mock' }], pickHub, 500, `${tmpdir()}/acp-default-pick-${Date.now()}.json`)
    try {
      // The advanced options are validated against the agent's catalog, so the
      // host needs to know it; the agent id in the RPC is what names the agent
      // before any session exists (`chatAgentFor` cannot answer yet).
      await gm.probeAgentModels('mock')
      await gm.setDefaultAgent('mock')
      await gm.setChatSessionEffort('dsh-default-pick', 'off', 'mock')
      await gm.setChatSessionConfig('dsh-default-pick', 'temp', 'high', 'mock')
      expect(gm.chatChoice('dsh-default-pick')).toMatchObject({
        agentId: 'mock',
        effort: 'off',
        extraConfigs: { temp: 'high' },
      })
      // The route for the next turn carries the agent the pick belongs to.
      expect(routeBindingRegistry().conversations.get('dsh-default-pick')).toBe('mock')
      // An agent id that is not configured is refused, not recorded.
      await expect(gm.setChatSessionEffort('dsh-default-pick', 'high', 'ghost'))
        .rejects.toMatchObject({ code: 'unknown_agent' })
    } finally {
      await gm.setDefaultAgent(undefined)
      await gm.shutdownAll()
    }
  }, 30_000)

  /**
   * A conversation with no explicit pick shows the agent catalog's current
   * model / thought level / extras in the composer. The first `session/new`
   * comes back with the agent's OWN defaults, so without pinning the displayed
   * values the first message runs a different model than the one on screen —
   * the reported "displayed model was not used" defect (user report, 2026-10-24).
   */
  it('runs the values the composer showed when the first turn starts with no pick', async () => {
    const hub = new EventHub()
    const gm = new BridgeManager([{ ...def, id: 'mock' }], hub, 500, `${tmpdir()}/acp-displayed-defaults-${Date.now()}.json`)
    try {
      // The catalog the composer reads before this conversation has a session:
      // model B / thought off / temperature high. `session/new` will answer A /
      // high / mid, so a seed that does not happen is visible in the result.
      const internal = gm as unknown as { catalogs: Map<string, { catalog: AcpAgentCatalog; updatedAt: number }> }
      internal.catalogs.set('mock', {
        catalog: {
          model: {
            configId: 'model',
            name: 'Model',
            currentValue: 'mock-model-b',
            choices: [{ value: 'mock-model-a', name: 'Mock Model A' }, { value: 'mock-model-b', name: 'Mock Model B' }],
          },
          thought: {
            configId: 'thought',
            name: 'Thought Level',
            currentValue: 'off',
            choices: [{ value: 'off', name: 'Off' }, { value: 'high', name: 'High' }],
          },
          extras: [{
            configId: 'temp',
            name: 'Temperature',
            currentValue: 'high',
            choices: [{ value: 'low', name: 'low' }, { value: 'mid', name: 'mid' }, { value: 'high', name: 'high' }],
          }],
        },
        updatedAt: 1,
      })
      // No manual bind: the plugin default is what the guard's route rewrite
      // answers a never-bound conversation with.
      await gm.setDefaultAgent('mock')

      for await (const _ of gm.streamPrompt({
        model: 'mock',
        sessionId: 'dsh-displayed-defaults',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      } as never)) { /* drain */ }

      // The displayed values became the conversation's pick...
      expect(gm.chatChoice('dsh-displayed-defaults')).toMatchObject({
        agentId: 'mock',
        modelId: 'mock@mock-model-b',
        effort: 'off',
        extraConfigs: { temp: 'high' },
      })
      // ...the session reports what is actually in force...
      const [session] = gm.chatSessions('dsh-displayed-defaults')
      expect(session?.modelId).toBe('mock@mock-model-b')
      expect(session?.reasoningEffort).toBe('off')
      // ...and the agent really received them, not its own defaults.
      const live = (gm.sessions() as Array<{
        agentId: string
        configOptions?: Array<{ configId: string; currentValue: unknown }>
      }>).find(entry => entry.agentId === 'mock')
      expect(live?.configOptions?.find(option => option.configId === 'model')?.currentValue).toBe('mock-model-b')
      expect(live?.configOptions?.find(option => option.configId === 'thought')?.currentValue).toBe('off')
      expect(live?.configOptions?.find(option => option.configId === 'temp')?.currentValue).toBe('high')
      // The route for the NEXT turn carries the variant, not the bare agent.
      expect(routeBindingRegistry().conversations.get('dsh-displayed-defaults')).toBe('mock@mock-model-b')
    } finally {
      routeBindingRegistry().conversations.delete('dsh-displayed-defaults')
      await gm.setDefaultAgent(undefined)
      await gm.shutdownAll()
    }
  }, 30_000)

  it('does not pin a displayed model the fresh session no longer offers', async () => {
    const hub = new EventHub()
    const gm = new BridgeManager([{ ...def, id: 'mock' }], hub, 500, `${tmpdir()}/acp-displayed-stale-${Date.now()}.json`)
    try {
      const internal = gm as unknown as { catalogs: Map<string, { catalog: AcpAgentCatalog; updatedAt: number }> }
      internal.catalogs.set('mock', {
        catalog: {
          model: {
            configId: 'model',
            name: 'Model',
            currentValue: 'mock-model-gone',
            choices: [{ value: 'mock-model-gone', name: 'Gone' }],
          },
        },
        updatedAt: 1,
      })
      await gm.setDefaultAgent('mock')
      const chunks: StreamChunk[] = []
      for await (const chunk of gm.streamPrompt({
        model: 'mock',
        sessionId: 'dsh-displayed-stale',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      } as never)) chunks.push(chunk)

      // The stale catalog value is skipped rather than wedging the first turn.
      expect(chunks.at(-1)).toMatchObject({ type: 'finish' })
      expect(chunks.at(-1)).not.toMatchObject({ reason: { kind: 'error' } })
      expect(gm.chatChoice('dsh-displayed-stale')?.modelId).toBeUndefined()
      const [session] = gm.chatSessions('dsh-displayed-stale')
      expect(session?.modelId).toBe('mock@mock-model-a')
    } finally {
      routeBindingRegistry().conversations.delete('dsh-displayed-stale')
      await gm.setDefaultAgent(undefined)
      await gm.shutdownAll()
    }
  }, 30_000)

  /**
   * The other half of "picks are real": a model the agent has DROPPED must
   * never be silently replaced by another one. The turn is refused with
   * `model_unavailable` BEFORE anything reaches the agent, the pick is kept so
   * the user can see which selection must change, and a replacement model runs
   * normally. A stale thought level (which does not change WHICH model runs) is
   * still dropped with one notice.
   */
  it('refuses to run a dropped model, keeps the pick, warns once for stale effort, and runs the replacement', async () => {
    const staleHub = new EventHub()
    const notices: string[] = []
    staleHub.subscribe(event => {
      if (event.type === 'agent/notice' && event.text.includes('no longer offers')) notices.push(event.text)
    })
    const gm = new BridgeManager([{ ...def, id: 'mock' }], staleHub, 500, `${tmpdir()}/acp-pick-stale-${Date.now()}.json`)
    try {
      gm.bindChatAgent('dsh-stale-1', 'mock')
      // The mock offers mock-model-a / mock-model-b and off / high. These two
      // are what an agent that revised its catalog no longer provides.
      await gm.setChatSessionModel('dsh-stale-1', 'mock@dropped-model')
      await gm.setChatSessionEffort('dsh-stale-1', 'ultra')
      expect(routeBindingRegistry().conversations.get('dsh-stale-1')).toBe('mock@dropped-model')

      const blocked: StreamChunk[] = []
      for await (const chunk of gm.streamPrompt({
        model: 'mock',
        sessionId: 'dsh-stale-1',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
      } as never)) blocked.push(chunk)
      expect(blocked.at(-1)).toMatchObject({
        type: 'finish',
        reason: { kind: 'error', failure: { code: 'model_unavailable' } },
      })
      // The failure names the selection that must be replaced.
      expect(JSON.stringify(blocked.at(-1))).toContain('dropped-model')

      // The MODEL pick survives — it is what the chip and the picker point at —
      // and the request route still carries it. The stale EFFORT is gone (it
      // does not change which model runs) with exactly one notice.
      expect(gm.chatChoice('dsh-stale-1')).toEqual({ agentId: 'mock', modelId: 'mock@dropped-model' })
      expect(routeBindingRegistry().conversations.get('dsh-stale-1')).toBe('mock@dropped-model')
      expect(notices.filter(text => text.includes('thought'))).toHaveLength(1)
      expect(notices.filter(text => text.includes('model'))).toHaveLength(0)
      // The first turn exchanged nothing: the provisional lock rolled back and
      // the failed session is gone.
      expect(gm.chatSessions('dsh-stale-1')).toEqual([])

      // Replacing the model is the way forward; the next turn runs normally.
      await gm.setChatSessionModel('dsh-stale-1', 'mock@mock-model-b')
      const ok: StreamChunk[] = []
      for await (const chunk of gm.streamPrompt({
        model: 'mock',
        sessionId: 'dsh-stale-1',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
      } as never)) ok.push(chunk)
      expect(ok.at(-1)).toMatchObject({ type: 'finish' })
      expect(ok.at(-1)).not.toMatchObject({ reason: { kind: 'error' } })
      const [session] = gm.chatSessions('dsh-stale-1')
      expect(session?.modelId).toBe('mock@mock-model-b')
      const live = (gm.sessions() as Array<{
        agentId: string
        configOptions?: Array<{ configId: string; currentValue: unknown }>
      }>).find(entry => entry.agentId === 'mock')
      expect(live?.configOptions?.find(option => option.configId === 'model')?.currentValue).toBe('mock-model-b')

      // A stale model requested through the setter on a LIVE session is refused
      // too, instead of being recorded and failing on the next send.
      await expect(gm.setChatSessionModel('dsh-stale-1', 'mock@dropped-model'))
        .rejects.toMatchObject({ code: 'model_unavailable' })
      expect(gm.chatChoice('dsh-stale-1')).toMatchObject({ modelId: 'mock@mock-model-b' })
      expect(gm.chatSessions('dsh-stale-1')[0]?.modelId).toBe('mock@mock-model-b')
    } finally {
      await gm.shutdownAll()
    }
  }, 30_000)

  it('runs the selected model when an agent mislabels an effort option as category:model', async () => {
    // Issue #8 end-to-end: the agent's answer carries `model` plus a
    // `reasoning_effort` also tagged category:'model'. The turn must reach the
    // agent with the chosen model instead of failing `model_unavailable`
    // before sending anything.
    const qoderHub = new EventHub()
    const qoderDef: AcpAgentDef = {
      ...def,
      env: { ...def.env, MOCK_QODER_MODEL_CATEGORY: '1' },
    }
    const gm = new BridgeManager([{ ...qoderDef, id: 'mock' }], qoderHub, 500, `${tmpdir()}/acp-qoder-category-${Date.now()}.json`)
    try {
      gm.bindChatAgent('dsh-qoder-category', 'mock')
      await gm.setChatSessionModel('dsh-qoder-category', 'mock@mock-model-b')
      const chunks: StreamChunk[] = []
      for await (const chunk of gm.streamPrompt({
        model: 'mock',
        sessionId: 'dsh-qoder-category',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
      } as never)) chunks.push(chunk)
      expect(chunks.at(-1)).toMatchObject({ type: 'finish' })
      expect(chunks.at(-1)).not.toMatchObject({ reason: { kind: 'error' } })
      expect(gm.chatSessions('dsh-qoder-category')[0]?.modelId).toBe('mock@mock-model-b')
      // The model slot is the selector; the mislabelled effort is the thought
      // control (this fixture publishes no real thought_level).
      expect(gm.catalogFor('mock')?.model?.configId).toBe('model')
      expect(gm.catalogFor('mock')?.model?.choices.map(choice => choice.value))
        .toEqual(['mock-model-a', 'mock-model-b'])
      expect(gm.catalogFor('mock')?.thought?.configId).toBe('reasoning_effort')
    } finally {
      await gm.shutdownAll()
    }
  }, 30_000)
})

/**
 * The turn path must honor the conversation↔agent binding. The driver resolves
 * each turn's route as "pending selection → last request header → deployment
 * default" (dsh-api-session-controller's `selectionFor`), so a session that has
 * never run an ACP turn arrives at SOME OTHER adapter entirely, and one that
 * has replays its previous `acp/<agent>` header forever — the click would
 * change nothing. Two layers fix that: the guard's `agent/request` rewrite
 * makes the driver reach this adapter with the bound agent (register.spec.ts
 * covers it), and `streamPrompt` re-checks the binding in case the driver still
 * arrived with a stale agent id.
 */
describe('request-path binding (isolated manager)', () => {
  const bindingHub = new EventHub()
  /** Iterate a turn to completion (the queue closes when the turn settles). */
  async function drain(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
    const chunks: StreamChunk[] = []
    for await (const chunk of stream) chunks.push(chunk)
    return chunks
  }

  function userTurn(text: string): { role: 'user'; content: { type: 'text'; text: string }[] } {
    return { role: 'user', content: [{ type: 'text', text }] }
  }

  it('serves the bound agent even when the turn still names another one', async () => {
    const gm = new BridgeManager(
      [{ ...def, id: 'alpha' }, { ...def, id: 'beta' }],
      bindingHub,
      500,
      `${tmpdir()}/acp-redirect-${Date.now()}.json`,
    )
    const adapter = new AcpLlmAdapter(gm)
    try {
      // The picker click happens BEFORE the first turn: a switch after the
      // first turn is refused by the lock (see the agent-lock suite), so the
      // stale-route scenario is set up while the conversation is still open.
      gm.bindChatAgent('dsh-redir-1', 'beta')
      expect(routeBindingRegistry().conversations.get('dsh-redir-1')).toBe('beta')

      // Turn 1 arrives with the STALE route (the logged request header names
      // alpha — nothing outside the guard ever rewrites it). The binding wins:
      // beta serves, in its OWN session (context separation per agent). The
      // turn runs to its continuation steps (the host loop's own shape), so
      // awaiting it means the turn really settled.
      await hostLoopTurn(adapter, { provider: 'acp', model: 'alpha', sessionId: 'dsh-redir-1', messages: [userTurn('first')] })
      const sessions = gm.chatSessions('dsh-redir-1')
      expect(sessions.map(session => session.agentId)).toEqual(['beta'])
      // The turn's record names what actually served it (the bound agent), not
      // the stale id the driver arrived with. With no model pick the record
      // names the model the agent itself reported (`session/new`'s current
      // value), not a bare route — a bare route would make the composer read
      // the agent-level catalog, which other conversations can move.
      expect(sessions.find(session => session.agentId === 'beta')?.modelId).toBe('beta@mock-model-a')
      // …and the record of what the conversation is on follows the binding.
      expect(routeBindingRegistry().conversations.get('dsh-redir-1')).toBe('beta')
      // That first turn locked beta; alpha cannot take the conversation back.
      expect(() => gm.bindChatAgent('dsh-redir-1', 'alpha')).toThrow(/locked/)
    } finally {
      routeBindingRegistry().conversations.delete('dsh-redir-1')
      await gm.shutdownAll()
    }
  }, 30_000)

  it('switches the model variant through the same binding the turn path reads', async () => {
    const gm = new BridgeManager([{ ...def, id: 'alpha' }], bindingHub, 500, `${tmpdir()}/acp-variant-${Date.now()}.json`)
    try {
      await gm.setChatSessionModel('dsh-variant-1', 'alpha@mock-model-b')
      expect(routeBindingRegistry().conversations.get('dsh-variant-1')).toBe('alpha@mock-model-b')
      // A stale or ghost entry must not fail the turn: it is ignored instead.
      routeBindingRegistry().conversations.set('dsh-variant-2', 'ghost@x')
      const adapter = new AcpLlmAdapter(gm)
      await hostLoopTurn(adapter, { provider: 'acp', model: 'alpha', sessionId: 'dsh-variant-2', messages: [userTurn('hi')] })
      expect(gm.chatSessions('dsh-variant-2').map(session => session.agentId)).toEqual(['alpha'])
    } finally {
      routeBindingRegistry().conversations.delete('dsh-variant-1')
      routeBindingRegistry().conversations.delete('dsh-variant-2')
      await gm.shutdownAll()
    }
  }, 30_000)

  it('does not re-apply an adapter-defaulted effort over the seat\'s own pick', async () => {
    // The driver materializes `reasoning.defaultEffort` into every request that
    // did not ask for one. That default comes from the agent-level catalog
    // cache, which a per-session thought-level switch does not refresh — so
    // re-applying it per turn would silently revert the user's pick.
    const gm = new BridgeManager([{ ...def, id: 'alpha' }], bindingHub, 500, `${tmpdir()}/acp-effort-${Date.now()}.json`)
    try {
      // Warm the catalog: the mock advertises thought_level choices with
      // currentValue 'high', which is the effort the driver will materialize.
      // (The background probe is disabled under the test runner, so probe
      // directly — the same await the panel's manual probe uses.)
      const probe = await gm.probeAgentModels('alpha')
      expect(probe.catalog.thought?.currentValue).toBe('high')

      const adapter = new AcpLlmAdapter(gm)
      // Turn 1: a REAL pick ('off' ≠ the default) applies and is recorded.
      // The turn runs to its continuation steps so it has really settled
      // before turn 2 claims the slot (a half-drained turn would leave the
      // provisional lock armed, and turn 2's claim failure would roll the
      // whole conversation back).
      await hostLoopTurn(adapter, { provider: 'acp', model: 'alpha', sessionId: 'dsh-effort-1', reasoningEffort: 'off', messages: [userTurn('one')] })
      expect(gm.chatSessions('dsh-effort-1')[0]?.reasoningEffort).toBe('off')
      // Turn 2: the driver arrives with the materialized default ('high').
      // Re-applying it would revert the pick to the catalog's stale value.
      await hostLoopTurn(adapter, { provider: 'acp', model: 'alpha', sessionId: 'dsh-effort-1', reasoningEffort: 'high', messages: [userTurn('two')] })
      expect(gm.chatSessions('dsh-effort-1')[0]?.reasoningEffort).toBe('off')
    } finally {
      routeBindingRegistry().conversations.delete('dsh-effort-1')
      await gm.shutdownAll()
    }
  }, 30_000)

  it('mirrors the default agent into the request path and purges deleted agents', async () => {
    const gm = new BridgeManager([{ ...def, id: 'alpha' }], bindingHub, 500, `${tmpdir()}/acp-purge-${Date.now()}.json`)
    try {
      await dispatchRpc(gm, 'default/agent-set', { agentId: 'alpha' })
      expect(routeBindingRegistry().defaultModel).toBe('alpha')
      // A conversation bound to the agent, with a model variant recorded.
      routeBindingRegistry().conversations.set('dsh-purge-1', 'alpha@mock-model-a')
      await gm.deleteAgent('alpha')
      expect(routeBindingRegistry().conversations.has('dsh-purge-1')).toBe(false)
      expect(routeBindingRegistry().defaultModel).toBeUndefined()
    } finally {
      await gm.setDefaultAgent(undefined).catch(() => {})
      routeBindingRegistry().conversations.delete('dsh-purge-1')
      await gm.shutdownAll()
    }
  })
})

/**
 * Windows: every npm-installed ACP agent is a generated `.cmd` shim, and Node
 * refuses to spawn one with `shell: false` (BatBadBut) — it throws EINVAL
 * before any process exists. The launch shape below is what makes `codebuddy`,
 * `pi-acp` and `omp` start at all on that platform, and the two details it
 * encodes (verbatim arguments, the outer quote pair) were measured, not
 * guessed: without either one cmd.exe reports the line as "not recognized".
 */
describe('windows shim launch', () => {
  /** The shim writes its (grand)child's pid there once node is up. */
  async function waitForPid(marker: string): Promise<number> {
    await until(() => existsSync(marker))
    const pid = Number(readFileSync(marker, 'utf-8').trim())
    expect(Number.isInteger(pid) && pid > 0).toBe(true)
    return pid
  }

  it('wraps .cmd/.bat in cmd.exe and leaves everything else alone', () => {
    // Not a shim → untouched, verbatim off.
    expect(windowsShimLaunch('codebuddy', ['--acp'])).toEqual({ command: 'codebuddy', args: ['--acp'], verbatim: false })
    expect(windowsShimLaunch(process.execPath, ['x'], 'win32')).toEqual({ command: process.execPath, args: ['x'], verbatim: false })
    // A shim, off Windows → untouched (the POSIX shim is a real script).
    expect(windowsShimLaunch('/usr/local/bin/codebuddy', [], 'linux')).toEqual({ command: '/usr/local/bin/codebuddy', args: [], verbatim: false })
    // The shim itself: run through cmd.exe, quotes preserved verbatim.
    expect(windowsShimLaunch('C:\\nvm4w\\nodejs\\codebuddy.CMD', ['--acp'], 'win32', 'cmd.exe')).toEqual({
      command: 'cmd.exe',
      args: ['/d', '/s', '/c', '"C:\\nvm4w\\nodejs\\codebuddy.CMD --acp"'],
      verbatim: true,
    })
    // A path with spaces is quoted token by token, then the line is wrapped so
    // `/s` strips the wrapping instead of the program's own quotes.
    expect(windowsShimLaunch('C:\\Program Files\\x agent.cmd', ['a b'], 'win32', 'cmd.exe')).toEqual({
      command: 'cmd.exe',
      args: ['/d', '/s', '/c', '""C:\\Program Files\\x agent.cmd" "a b""'],
      verbatim: true,
    })
  })

  it.runIf(process.platform === 'win32')('spawns a .cmd shim (path with a space) and completes initialize', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-ntr shim '))
    try {
      const shim = join(dir, 'mock agent.cmd')
      writeFileSync(shim, `@echo off\r\n"${process.execPath}" "${MOCK}" %*\r\n`)
      const shimHub = new EventHub()
      const bridge = new AgentBridge({ ...def, id: 'shim', command: shim, args: [] }, shimHub, 200, () => {})
      await bridge.ensureReady()
      expect(bridge.initResult?.agentInfo?.name).toBe('mock-acp-agent')
      await bridge.stop()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 30_000)

  it.runIf(process.platform === 'win32')('killProcessTree reaps the agent behind the cmd.exe wrapper', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-ntr tree '))
    let child: ReturnType<typeof spawn> | undefined
    try {
      const marker = join(dir, 'grandchild.pid')
      const script = join(dir, 'sleeper.mjs')
      writeFileSync(script, `import { writeFileSync } from 'node:fs'\nwriteFileSync(${JSON.stringify(marker)}, String(process.pid))\nsetInterval(() => { /* keep alive */ }, 1000)\n`)
      const shim = join(dir, 'sleeper.cmd')
      writeFileSync(shim, `@echo off\r\n"${process.execPath}" "${script}"\r\n`)

      const launch = windowsShimLaunch(shim, [])
      child = spawn(launch.command, launch.args, { stdio: 'ignore', windowsHide: true, windowsVerbatimArguments: true })
      const cmdPid = child.pid
      expect(cmdPid).toBeDefined()

      const grandchild = await waitForPid(marker)
      expect(isAlive(grandchild)).toBe(true)

      // Killing only the direct child (what the old Windows branch did) would
      // leave this process running: `taskkill /T` must see the tree intact.
      killProcessTree(cmdPid as number)
      await until(() => !isAlive(grandchild))
      expect(isAlive(grandchild)).toBe(false)
    } finally {
      if (child?.pid !== undefined) killProcessTree(child.pid)
      rmSync(dir, { recursive: true, force: true })
    }
  }, 30_000)
})

/**
 * Host shutdown must leave no agent CHILD alive, and must not destroy the
 * conversations it parks: both are one path now (`BridgeManager.shutdownAll` →
 * `AgentBridge.shutdown`). The old path called `stop` per bridge, which asked
 * every session's agent to `session/close` (up to 5s EACH, before the child was
 * even signalled) and then cleared the released records — a host restart
 * destroyed every live conversation and could take N × 5s to exit.
 */
describe('host shutdown (isolated managers)', () => {
  /** The manager's bridge for one agent. `bridges` is private; the test needs it. */
  function bridgeOf(mgr: BridgeManager, agentId: string): AgentBridge {
    return (mgr as unknown as { bridges: Map<string, AgentBridge> }).bridges.get(agentId) as AgentBridge
  }

  /** The spawned child. `child` is private; the test needs its identity. */
  function childPidOf(bridge: AgentBridge): number | undefined {
    return (bridge as unknown as { child?: { pid?: number } }).child?.pid
  }

  /**
   * The child HANDLE, whose `exitCode` / `signalCode` can only be set by the OS
   * taking the process away. That is a stronger death fact than
   * `kill(pid, 0)`: a pid can be reused, and a terminated process can still
   * answer a query while a handle to it is open.
   */
  function childHandleOf(bridge: AgentBridge): ChildProcess | undefined {
    return (bridge as unknown as { child?: ChildProcess }).child
  }

  /** A process that never speaks ACP: the startup handshake stays pending. */
  const silentDef: AcpAgentDef = {
    ...def,
    id: 'silent',
    args: ['-e', 'setInterval(() => { /* keep alive */ }, 1000)'],
  }

  it('reaps the agent child and keeps the conversation resumable', async () => {
    const shutdownHub = new EventHub()
    const shutdownEvents: AcpEvent[] = []
    shutdownHub.subscribe(event => { shutdownEvents.push(event) })
    // A REAL state file: "still resumable after the host comes back" is a claim
    // about disk, so the restarted manager below has to read what this one wrote
    // (`VITEST` would otherwise make `persistAgents` a no-op).
    const stateDir = mkdtempSync(join(tmpdir(), 'acp-shutdown-'))
    const storage = join(stateDir, 'agents.json')
    const mgr = new BridgeManager([{ ...def, id: 'shutdown' }], shutdownHub, 500, storage)
    let pid = 0
    let sessionId = ''
    try {
      const session = await mgr.getOrCreateDshSession('dsh-shutdown-1', 'shutdown')
      sessionId = session.sessionId
      // PIDTAG: the mock appends the pid of the process that served the turn.
      await mgr.prompt(session.sessionId, 'hello PIDTAG')
      await until(() => {
        const { entries } = mgr.transcript(session.sessionId, undefined)
        const text = (entries as Array<{ update: Record<string, unknown> }>)
          .map(entry => String((entry.update.content as { text?: string } | undefined)?.text ?? ''))
          .join('')
        const found = /PID:(\d+)/.exec(text)
        if (found !== null) pid = Number(found[1])
        return pid > 0
      })
      expect(isAlive(pid)).toBe(true)
      const handle = childHandleOf(bridgeOf(mgr, 'shutdown')) as ChildProcess
      expect(handle.pid).toBe(pid)

      await mgr.shutdownAll()

      // The kill is AWAITED, and this is asserted WITHOUT a poll: the process is
      // gone the instant shutdown resolves. A poll would also pass for the old
      // fire-and-forget `killChild()` (the mock dies on SIGTERM anyway), which is
      // the regression this guards. The handle's `exitCode` / `signalCode` only
      // change when the OS took the process away; `kill(pid, 0)` is the same
      // fact through the pid.
      expect(handle.exitCode !== null || handle.signalCode !== null).toBe(true)
      expect(isAlive(pid)).toBe(false)
      // ...and the conversation was RELEASED, not closed: the record survives
      // and the next message (or a restarted host) can `session/load` it.
      expect(mgr.sessions()).toEqual([expect.objectContaining({ sessionId, released: true })])
      expect(shutdownEvents.some(event => event.type === 'session/closed' && event.sessionId === sessionId)).toBe(false)
      expect(shutdownEvents.some(event => event.type === 'session/released'
        && event.sessionId === sessionId && event.cause === 'shutdown')).toBe(true)
    } finally {
      await mgr.shutdownAll()
    }

    // A persist AFTER the shutdown must not erase what the shutdown saved:
    // `persistAgents` writes `dshSessionMap`, so clearing that map on the way
    // out is exactly how the parked records would vanish from disk. A late call
    // is normal traffic — any RPC that records a composer choice writes again.
    mgr.bindChatAgent('dsh-shutdown-late', 'shutdown')
    const onDisk = JSON.parse(readFileSync(storage, 'utf-8')) as { chatSessions?: Array<{ dshSessionId?: string }> }
    expect(onDisk.chatSessions?.map(row => row.dshSessionId)).toEqual(['dsh-shutdown-1'])

    // A fresh manager over the same file IS the restarted host: the record must
    // come back parked (released → the next message resumes it), never closed.
    const restarted = new BridgeManager([{ ...def, id: 'shutdown' }], shutdownHub, 500, storage)
    try {
      expect(restarted.chatSessions('dsh-shutdown-1')).toMatchObject([
        { sessionId, agentId: 'shutdown', released: true },
      ])
    } finally {
      await restarted.shutdownAll()
      rmSync(stateDir, { recursive: true, force: true })
    }
  }, 30_000)

  it('leaves no live child when the host shuts down during startup', async () => {
    const silentHub = new EventHub()
    const bridge = new AgentBridge(silentDef, silentHub, 200, () => { /* no session to settle */ })
    // Never awaited yet: `initialize` is still outstanding, so the child is
    // alive and `state` is `starting` when the shutdown lands.
    const started = bridge.ensureReady()
    // Attach the rejection handler NOW: the killed handshake rejects long
    // before this test is done with the pid, and a late handler reads as an
    // unhandled rejection to the runner.
    const settled = started.catch(() => { /* the teardown owns the outcome */ })
    await until(() => childHandleOf(bridge) !== undefined)
    const child = childHandleOf(bridge) as ChildProcess
    const pid = child.pid as number
    expect(isAlive(pid)).toBe(true)

    // Windows `taskkill /T /F` is a separate process: under a loaded full-suite
    // run it can need more than one second to land. The assertion below is that
    // the kill is AWAITED, not that it fits a one-second budget (the production
    // default is 4s), so give the OS room instead of racing the suite's load.
    await bridge.shutdown(3_000)

    // The awaited kill must have reported the process gone BEFORE shutdown
    // resolved (the handle's exit is the OS fact; see `childHandleOf`), and this
    // is asserted without a poll on purpose: a poll would also pass for the old
    // fire-and-forget `killChild()`.
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true)
    expect(isAlive(pid)).toBe(false)
    // The abandoned start must not paint a live status over the stopped bridge.
    expect(bridge.state).toBe('stopped')
    expect(bridge.initResult).toBeUndefined()
    // The handshake fails when its child dies; a stale start must not surface
    // as an unhandled rejection or flip the state.
    await settled
    expect(bridge.state).toBe('stopped')
    // The SIGKILL / `taskkill` escalation itself is NOT covered anywhere in this
    // block: the mock exits on the first signal, and a signal-ignoring child
    // would mean a new fixture shared with tests that must not change.
  }, 30_000)

  it('never spawns after a stop that lands while the executable is resolving', async () => {
    const racedHub = new EventHub()
    const bridge = new AgentBridge({ ...silentDef, id: 'raced' }, racedHub, 200, () => { /* no session */ })
    // `ensureReady` yields at `ensureAgentExecutable` before it spawns, so this
    // stop lands inside that window — the one a global npm install can hold for
    // minutes.
    const started = bridge.ensureReady()
    await bridge.stop()

    // The start resolves without a child and without flipping state: the
    // teardown epoch refuses to create the process at all.
    await expect(started).resolves.toBeUndefined()
    expect(childPidOf(bridge)).toBeUndefined()
    expect(bridge.state).toBe('stopped')
  }, 15_000)
})

/**
 * The second half of a branched conversation (`session/chat-fork-adopt` →
 * `adoptForkedSession` → `AgentBridge.forkSession`): the ACP side of the
 * host-fork-then-adopt order. The host's `sessions.fork` is out of scope here —
 * in these tests the DSH child conversation already exists; what is under test
 * is the fourth session-creation point (the SAME `mcpServers` list as
 * `session/new`, the startup timeout, the id de-dup) and the child binding
 * (locked choice copy, `session/meta` republish, persistence).
 */
describe('conversation fork adoption (isolated manager)', () => {
  const forkRoot = mkdtempSync(join(tmpdir(), 'dsh-ntr-fork-'))
  afterAll(() => {
    rmSync(forkRoot, { recursive: true, force: true })
  })

  /** The mock with the UNSTABLE fork knobs on (the base `def` advertises none). */
  const forkDef = (env: Record<string, string>, id: string): AcpAgentDef => ({
    ...def,
    id,
    env: { ...def.env, ...env },
    // Non-empty on purpose: an empty list would make the "same list as
    // session/new" assertion vacuous, and an adopt that sent an empty list
    // would EVICT the live sessions' MCP scope (one list per process).
    mcpServers: [
      { name: 'local', transport: 'stdio', command: '/opt/servers/local', args: ['--mcp'], env: { TOKEN: 'x' } },
      { name: 'remote', transport: 'http', url: 'https://example.test/mcp', headers: { Authorization: 'Bearer t' } },
    ],
  })

  const forkHub = new EventHub()
  const forkEvents: AcpEvent[] = []
  forkHub.subscribe(event => { forkEvents.push(event) })

  function forkWaitFor<T extends AcpEvent['type']>(type: T, predicate: (event: Extract<AcpEvent, { type: T }>) => boolean, timeoutMs = 15_000): Promise<Extract<AcpEvent, { type: T }>> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout waiting for ${type}`)), timeoutMs)
      const unsub = forkHub.subscribe(event => {
        if (event.type === type && predicate(event as Extract<AcpEvent, { type: T }>)) {
          clearTimeout(timer)
          unsub()
          resolve(event as Extract<AcpEvent, { type: T }>)
        }
      })
      const existing = forkEvents.find(event => event.type === type && predicate(event as Extract<AcpEvent, { type: T }>))
      if (existing !== undefined) {
        clearTimeout(timer)
        unsub()
        resolve(existing as Extract<AcpEvent, { type: T }>)
      }
    })
  }

  /** Drive one turn the way the host loop does, so the settled-turn claim is honest. */
  const turn = async (gm: BridgeManager, dshSessionId: string, agentId: string, text = 'hi'): Promise<void> => {
    const request = {
      model: agentId,
      sessionId: dshSessionId,
      messages: [{ role: 'user', content: [{ type: 'text', text }] }],
    } as never
    let messages = request.messages
    for (let step = 0; step < 8; step += 1) {
      const chunks: StreamChunk[] = []
      for await (const chunk of gm.streamPrompt({ ...request, messages } as never)) chunks.push(chunk)
      const finish = chunks.find((c): c is Extract<StreamChunk, { type: 'finish' }> => c.type === 'finish')
      const callIds = [...new Set(chunks.filter(c => c.type === 'tool-call-delta').map(c => (c as { id: string }).id))]
      if (finish === undefined || finish.reason.kind !== 'stop' || callIds.length === 0) return
      messages = [...messages, ...callIds.map(id => ({
        role: 'tool' as const,
        source: { kind: 'tool' as const, callId: id },
        content: [{ type: 'text' as const, text: 'staged result' }],
      }))]
    }
  }

  /** One entry per `session/fork` request the agent actually received. */
  const forkRequests = (logPath: string): Array<{ sessionId?: string; cwd?: string; mcpServers?: Array<Record<string, unknown>> }> =>
    existsSync(logPath)
      ? (readFileSync(logPath, 'utf8').split('\n').filter(line => line.trim() !== '').map(line => JSON.parse(line)))
      : []

  /** The MCP wire list the session named by `sessionId` was created/forked with, echoed through "MCPS". */
  async function echoedMcps(gm: BridgeManager, sessionId: string): Promise<Array<Record<string, unknown>>> {
    await settleTranscript(gm, sessionId)
    const transcript = await dispatchRpc(gm, 'transcript/get', { sessionId })
    if (!transcript.ok) throw new Error('transcript failed')
    const text = (transcript.value as { entries: Array<{ update: Record<string, unknown> }> })
      .entries
      .filter(entry => entry.update.sessionUpdate === 'agent_message_chunk')
      .map(entry => String((entry.update.content as { text?: string }).text ?? ''))
      .join('')
    const begin = text.indexOf('MCPS_BEGIN')
    const end = text.indexOf('MCPS_END')
    if (begin < 0 || end <= begin) throw new Error('the agent never echoed the MCP servers')
    return JSON.parse(text.slice(begin + 'MCPS_BEGIN'.length, end)) as Array<Record<string, unknown>>
  }

  it('adopts a forked child: the fork request carries the session/new mcpServers, the child is registered, the choice is locked, and session/meta is broadcast', async () => {
    const logPath = join(forkRoot, 'adopt-fork.log')
    const storage = join(forkRoot, 'adopt-agents.json')
    const catalog = join(forkRoot, 'adopt-catalog.json')
    const gm = new BridgeManager([forkDef({ MOCK_FORK: '1', MOCK_FORK_LOG: logPath }, 'forky')], forkHub, 500, storage, catalog)
    try {
      gm.bindChatAgent('dsh-fork-parent', 'forky')
      // The FIRST turn doubles as the session/new wire witness: the mock echoes
      // the MCP servers its session was created with.
      await turn(gm, 'dsh-fork-parent', 'forky', 'MCPS please')
      const parentRows = gm.chatSessions('dsh-fork-parent')
      expect(parentRows).toHaveLength(1)
      expect(parentRows[0]).toMatchObject({ agentId: 'forky', fork: { supported: true } })
      const newWire = await echoedMcps(gm, parentRows[0].sessionId)
      expect(newWire.map(entry => entry.name)).toEqual(['local', 'remote'])

      const since = forkEvents.length
      const adopt = await gm.adoptForkedSession('dsh-fork-child', 'dsh-fork-parent')
      expect(adopt.acpSessionId).not.toBe('')

      // The republish the composer's list and occupancy ring react to.
      const meta = forkEvents.slice(since).find(event => event.type === 'session/meta' && event.sessionId === adopt.sessionId)
      expect(meta).toBeDefined()

      // The child is registered under ITS OWN conversation id, with a ready
      // fork verdict of its own (a forked session can fork again).
      const childRows = gm.chatSessions('dsh-fork-child')
      expect(childRows).toHaveLength(1)
      expect(childRows[0]).toMatchObject({ agentId: 'forky', sessionId: adopt.sessionId, fork: { supported: true } })

      // The copied choice, LOCKED: a branched conversation belongs to its agent
      // from birth — the same record the lock writes at a first turn.
      expect(gm.chatChoice('dsh-fork-parent')).toMatchObject({ agentId: 'forky', locked: true })
      expect(gm.chatChoice('dsh-fork-child')).toMatchObject({ agentId: 'forky', locked: true })

      // ...and the write reached the registry file (a host restart keeps it).
      const raw = JSON.parse(readFileSync(storage, 'utf8')) as {
        conversations?: Record<string, { agentId?: string; locked?: boolean }>
        chatSessions?: Array<{ dshSessionId: string; acpSessionId: string }>
      }
      expect(raw.conversations?.['dsh-fork-child']).toMatchObject({ agentId: 'forky', locked: true })
      expect(raw.chatSessions).toContainEqual(expect.objectContaining({ dshSessionId: 'dsh-fork-child', acpSessionId: adopt.acpSessionId }))

      // THE WIRE ASSERTION: exactly one session/fork arrived, it named the
      // parent's ACP session, and it carried the SAME mcpServers list
      // `session/new` received (one list per process — a second shape would
      // evict the live sessions' MCP tools).
      const requests = forkRequests(logPath)
      expect(requests).toHaveLength(1)
      const parentRecord = raw.chatSessions?.find(row => row.dshSessionId === 'dsh-fork-parent')
      expect(parentRecord).toBeDefined()
      expect(requests[0].sessionId).toBe(parentRecord?.acpSessionId)
      expect(requests[0].mcpServers).toEqual(newWire)

      // The child is servable end to end, and ITS session record carries the
      // same list (the forked session is the real thing, not a stub).
      await dispatchRpc(gm, 'session/prompt', { sessionId: adopt.sessionId, text: 'MCPS from the child' })
      await forkWaitFor('turn/end', event => event.sessionId === adopt.sessionId)
      expect(await echoedMcps(gm, adopt.sessionId)).toEqual(newWire)

      // The capability bit landed in the last-known catalog file, so the
      // browser's verdict outlives the agent process.
      const rawCatalog = JSON.parse(readFileSync(catalog, 'utf8')) as { agents?: Record<string, { fork?: boolean }> }
      expect(rawCatalog.agents?.forky?.fork).toBe(true)
    } finally {
      await gm.shutdownAll()
    }
  }, 30_000)

  it('applies the copied choice to the forked session (mode and extra configs ride the adopt)', async () => {
    const gm = new BridgeManager([forkDef({ MOCK_FORK: '1' }, 'forkchoice')], forkHub, 500, join(forkRoot, 'choice-agents.json'))
    try {
      gm.bindChatAgent('dsh-fork-choice-parent', 'forkchoice')
      await turn(gm, 'dsh-fork-choice-parent', 'forkchoice')
      // The parent's picks, recorded AND applied to the parent session. The
      // fork copies agent-side state, but the RECORD is what a later resume
      // re-applies — so the adopt must align the fresh session to it now (the
      // fourth creation point follows create/resume), or the composer shows
      // one thing and the agent runs another.
      await gm.setChatSessionMode('dsh-fork-choice-parent', 'strict')
      await gm.setChatSessionConfig('dsh-fork-choice-parent', 'temp', 'high')
      const since = forkEvents.length
      const adopt = await gm.adoptForkedSession('dsh-fork-choice-child', 'dsh-fork-choice-parent')
      // The mode: the fork response starts the child on the agent's 'default';
      // only applyChatChoice's `session/set_mode` makes the row say 'strict'.
      const childRows = gm.chatSessions('dsh-fork-choice-child')
      expect(childRows[0]?.modes?.currentModeId).toBe('strict')
      // The extra config: the FINAL republish carries the session's options,
      // and the temp option's current value must be the parent's pick, not the
      // forked default ('mid'). Take the LAST meta — the mode alignment's own
      // publishMeta fires before the config alignment runs.
      const metas = forkEvents.slice(since).filter(event => event.type === 'session/meta' && event.sessionId === adopt.sessionId)
      const options = ((metas.at(-1)?.session.configOptions ?? []) as Array<{ configId?: string; currentValue?: unknown }>)
      expect(options.find(option => option.configId === 'temp')?.currentValue).toBe('high')
    } finally {
      await gm.shutdownAll()
    }
  }, 30_000)

  it('refuses to adopt from a released parent with zero fork requests', async () => {
    const logPath = join(forkRoot, 'released-fork.log')
    const gm = new BridgeManager([forkDef({ MOCK_FORK: '1', MOCK_FORK_LOG: logPath }, 'forkrel')], forkHub, 500, join(forkRoot, 'released-agents.json'))
    try {
      gm.bindChatAgent('dsh-fork-released', 'forkrel')
      await turn(gm, 'dsh-fork-released', 'forkrel')
      // Kill the process under the live session: crash → releaseAll parks the
      // record (released ≠ destroyed). A parked parent has no process to fork
      // from — adopting it must refuse before any request goes out.
      await turn(gm, 'dsh-fork-released', 'forkrel', 'DIE now')
      const parentSessionId = gm.chatSessions('dsh-fork-released')[0]?.sessionId
      await forkWaitFor('session/released', event => event.sessionId === parentSessionId)

      await expect(gm.adoptForkedSession('dsh-fork-released-child', 'dsh-fork-released'))
        .rejects.toMatchObject({ code: 'parent_not_live' })
      // The refusal happened BEFORE the request: the agent saw no session/fork
      // (the log file is written by the first request that ever arrives).
      expect(existsSync(logPath)).toBe(false)
      // And nothing was bound for the child either.
      expect(gm.chatSessions('dsh-fork-released-child')).toEqual([])
      expect(gm.chatChoice('dsh-fork-released-child')).toBeUndefined()
    } finally {
      await gm.shutdownAll()
    }
  }, 30_000)

  it('refuses to adopt when the agent never advertised session/fork, with zero requests', async () => {
    // The base mock advertises no fork capability: the capability gate must
    // fire BEFORE the request (an unadvertised method would answer an
    // unknown-method error at best).
    const logPath = join(forkRoot, 'unsupported-fork.log')
    const gm = new BridgeManager(
      [{ ...def, id: 'forknofork', env: { ...def.env, MOCK_FORK_LOG: logPath } }],
      forkHub, 500, join(forkRoot, 'unsupported-agents.json'),
    )
    try {
      gm.bindChatAgent('dsh-fork-nofork', 'forknofork')
      await turn(gm, 'dsh-fork-nofork', 'forknofork')
      expect(gm.chatSessions('dsh-fork-nofork')[0]).toMatchObject({ fork: { supported: false, reason: 'unsupported' } })

      await expect(gm.adoptForkedSession('dsh-fork-nofork-child', 'dsh-fork-nofork'))
        .rejects.toMatchObject({ code: 'fork_unsupported' })
      expect(existsSync(logPath)).toBe(false)
      expect(gm.chatSessions('dsh-fork-nofork-child')).toEqual([])
    } finally {
      await gm.shutdownAll()
    }
  }, 30_000)

  it('refuses a fork answer that names an already-routed session and registers nothing', async () => {
    // The interleaving hazard: an answer naming the parent (or any session on
    // this connection) would route the parent's updates, asks and permission
    // cards into the child. The mock answers with the parent's own id.
    const logPath = join(forkRoot, 'conflict-fork.log')
    const gm = new BridgeManager(
      [forkDef({ MOCK_FORK: '1', MOCK_FORK_MODE: 'conflict', MOCK_FORK_LOG: logPath }, 'forkconflict')],
      forkHub, 500, join(forkRoot, 'conflict-agents.json'),
    )
    try {
      gm.bindChatAgent('dsh-fork-conflict', 'forkconflict')
      await turn(gm, 'dsh-fork-conflict', 'forkconflict')

      await expect(gm.adoptForkedSession('dsh-fork-conflict-child', 'dsh-fork-conflict'))
        .rejects.toMatchObject({ code: 'fork_id_conflict' })
      // The request went out and was answered — but nothing was bound, not
      // even a half record.
      expect(forkRequests(logPath)).toHaveLength(1)
      expect(gm.chatSessions('dsh-fork-conflict-child')).toEqual([])
      expect(gm.chatChoice('dsh-fork-conflict-child')).toBeUndefined()
    } finally {
      await gm.shutdownAll()
    }
  }, 30_000)

  it('times a wedged fork out within the startup window and keeps the bridge usable', async () => {
    // The mock answers every request except session/fork, which never resolves.
    // The adopt must come back bounded by the startup window (the same window
    // every session-creation point carries) — and the in-flight fork counter
    // must settle, so the bridge serves the conversation again afterwards.
    const logPath = join(forkRoot, 'hang-fork.log')
    const gm = new BridgeManager(
      [forkDef({ MOCK_FORK: '1', MOCK_FORK_MODE: 'hang', MOCK_FORK_LOG: logPath }, 'forkhang')],
      forkHub, 500, join(forkRoot, 'hang-agents.json'), undefined, true,
      { startupTimeoutMs: 2_000 },
    )
    try {
      gm.bindChatAgent('dsh-fork-hang', 'forkhang')
      await turn(gm, 'dsh-fork-hang', 'forkhang')

      const startedAt = Date.now()
      let timeoutMessage = ''
      await expect(gm.adoptForkedSession('dsh-fork-hang-child', 'dsh-fork-hang').catch((error: unknown) => {
        timeoutMessage = error instanceof Error ? error.message : String(error)
        throw error
      })).rejects.toMatchObject({ code: 'agent_timeout' })
      // Bounded by the startup window (plus process startup), not by forever;
      // the detail names the request that stalled.
      expect(Date.now() - startedAt).toBeLessThan(15_000)
      expect(timeoutMessage).toContain('session/fork')
      expect(forkRequests(logPath)).toHaveLength(1)
      expect(gm.chatSessions('dsh-fork-hang-child')).toEqual([])

      // The timeout tore the wedged process down (withStartupTimeout kills the
      // child), so the conversation parks — and the NEXT message resumes it on
      // a fresh process: the bridge is not wedged by the dead fork request.
      const parentSessionId = gm.chatSessions('dsh-fork-hang')[0]?.sessionId
      await forkWaitFor('session/released', event => event.sessionId === parentSessionId)
      await turn(gm, 'dsh-fork-hang', 'forkhang', 'hello again')
      expect(gm.chatSessions('dsh-fork-hang')[0]).toMatchObject({ agentId: 'forkhang' })
      expect(gm.chatSessions('dsh-fork-hang')[0]?.released).toBeUndefined()
    } finally {
      await gm.shutdownAll()
    }
  }, 30_000)
})

describe('image input transmission and capability validation (isolated manager)', () => {
  const imageRoot = mkdtempSync(join(tmpdir(), 'dsh-ntr-image-'))
  afterAll(() => {
    try {
      rmSync(imageRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    } catch {}
  })

  const imageHub = new EventHub()
  const noImageDef: AcpAgentDef = {
    ...def,
    id: 'noimage',
    env: { ...def.env, MOCK_IMAGE: '0' },
  }
  const imageDef: AcpAgentDef = {
    ...def,
    id: 'hasimage',
    env: { ...def.env, MOCK_IMAGE: '1' },
  }

  it('intercepts prompt with image when agent does not support images', async () => {
    const gm = new BridgeManager([noImageDef], imageHub, 500, join(imageRoot, 'noimage-agents.json'))
    try {
      gm.bindChatAgent('dsh-noimage-sess', 'noimage')
      const chunks: StreamChunk[] = []
      for await (const chunk of gm.streamPrompt({
        model: 'noimage',
        sessionId: 'dsh-noimage-sess',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'describe this' },
              { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' },
            ],
          },
        ],
      } as never)) {
        chunks.push(chunk)
      }

      const finish = chunks.find(c => c.type === 'finish') as Extract<StreamChunk, { type: 'finish' }> | undefined
      expect(finish).toBeDefined()
      expect(finish?.reason).toMatchObject({
        kind: 'error',
        failure: {
          code: 'image_unsupported',
          message: expect.stringContaining('does not support image input'),
        },
      })
      // Provisional first turn lock is rolled back
      expect(gm.lockedAgentFor('dsh-noimage-sess')).toBeUndefined()
    } finally {
      await gm.shutdownAll()
    }
  }, 30_000)

  it('transmits image and text blocks when agent supports images', async () => {
    const gm = new BridgeManager([imageDef], imageHub, 500, join(imageRoot, 'image-agents.json'))
    try {
      gm.bindChatAgent('dsh-hasimage-sess', 'hasimage')
      const chunks: StreamChunk[] = []
      for await (const chunk of gm.streamPrompt({
        model: 'hasimage',
        sessionId: 'dsh-hasimage-sess',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'check image' },
              { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' },
            ],
          },
        ],
      } as never)) {
        chunks.push(chunk)
      }

      const finish = chunks.find(c => c.type === 'finish') as Extract<StreamChunk, { type: 'finish' }> | undefined
      expect(finish).toBeDefined()
      expect(finish?.reason.kind).toBe('stop')

      const acpSessionId = gm.chatSessions('dsh-hasimage-sess')[0]?.sessionId
      expect(acpSessionId).toBeDefined()
      await settleTranscript(gm, acpSessionId!)
      const transcript = await dispatchRpc(gm, 'transcript/get', { sessionId: acpSessionId })
      expect(transcript.ok).toBe(true)
      const echoedText = ((transcript as { value: { entries: Array<{ update: Record<string, unknown> }> } }).value.entries)
        .filter(entry => entry.update.sessionUpdate === 'agent_message_chunk')
        .map(entry => String((entry.update.content as { text?: string }).text ?? ''))
        .join('')
      expect(echoedText).toContain('images=1')
    } finally {
      await gm.shutdownAll()
    }
  }, 30_000)

  it('transmits image-only message (no text blocks) when agent supports images', async () => {
    const gm = new BridgeManager([imageDef], imageHub, 500, join(imageRoot, 'imageonly-agents.json'))
    try {
      gm.bindChatAgent('dsh-imgonly-sess', 'hasimage')
      const chunks: StreamChunk[] = []
      for await (const chunk of gm.streamPrompt({
        model: 'hasimage',
        sessionId: 'dsh-imgonly-sess',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' },
            ],
          },
        ],
      } as never)) {
        chunks.push(chunk)
      }

      const finish = chunks.find(c => c.type === 'finish') as Extract<StreamChunk, { type: 'finish' }> | undefined
      expect(finish).toBeDefined()
      expect(finish?.reason.kind).toBe('stop')

      const acpSessionId = gm.chatSessions('dsh-imgonly-sess')[0]?.sessionId
      expect(acpSessionId).toBeDefined()
      await settleTranscript(gm, acpSessionId!)
      const transcript = await dispatchRpc(gm, 'transcript/get', { sessionId: acpSessionId })
      expect(transcript.ok).toBe(true)
      const echoedText = ((transcript as { value: { entries: Array<{ update: Record<string, unknown> }> } }).value.entries)
        .filter(entry => entry.update.sessionUpdate === 'agent_message_chunk')
        .map(entry => String((entry.update.content as { text?: string }).text ?? ''))
        .join('')
      expect(echoedText).toContain('images=1')
    } finally {
      await gm.shutdownAll()
    }
  }, 30_000)

  it('AgentBridge.runPrompt throws image_unsupported directly if agent lacks capability', async () => {
    const gm = new BridgeManager([noImageDef], imageHub, 500, join(imageRoot, 'direct-agents.json'))
    try {
      const { sessionId } = await gm.startSession('noimage', undefined)
      const located = await gm.locateOrResume(sessionId)
      await expect(
        located.bridge.runPrompt(
          located.session,
          [
            { type: 'text', text: 'hello' },
            { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' },
          ],
          'turn-direct-1',
          located.session.turnSeq,
        ),
      ).rejects.toMatchObject({
        code: 'image_unsupported',
        message: expect.stringContaining('does not support image input'),
      })
      await expect(
        located.bridge.runPrompt(located.session, [], 'turn-direct-empty', located.session.turnSeq),
      ).rejects.toMatchObject({
        code: 'empty_prompt',
      })
    } finally {
      await gm.shutdownAll()
    }
  }, 30_000)

  it('BridgeManager.prompt supports ContentBlock[] directly and rejects when unsupported', async () => {
    const gmNo = new BridgeManager([noImageDef], imageHub, 500, join(imageRoot, 'gm-no-agents.json'))
    const gmYes = new BridgeManager([imageDef], imageHub, 500, join(imageRoot, 'gm-yes-agents.json'))
    try {
      const sNo = await gmNo.startSession('noimage', undefined)
      await expect(
        gmNo.prompt(sNo.sessionId, [
          { type: 'text', text: 'describe' },
          { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' },
        ]),
      ).rejects.toMatchObject({
        code: 'image_unsupported',
        message: expect.stringContaining('does not support image input'),
      })

      const sYes = await gmYes.startSession('hasimage', undefined)
      const res = await gmYes.prompt(sYes.sessionId, [
        { type: 'text', text: 'describe' },
        { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' },
      ])
      expect(res.turnId).toBeDefined()
      await settleTranscript(gmYes, sYes.sessionId)
      const transcript = await dispatchRpc(gmYes, 'transcript/get', { sessionId: sYes.sessionId })
      expect(transcript.ok).toBe(true)
      const echoedText = ((transcript as { value: { entries: Array<{ update: Record<string, unknown> }> } }).value.entries)
        .filter(entry => entry.update.sessionUpdate === 'agent_message_chunk')
        .map(entry => String((entry.update.content as { text?: string }).text ?? ''))
        .join('')
      expect(echoedText).toContain('images=1')
      await expect(gmYes.prompt(sYes.sessionId, [])).rejects.toMatchObject({
        code: 'empty_prompt',
      })
    } finally {
      await gmNo.shutdownAll()
      await gmYes.shutdownAll()
    }
  }, 30_000)

  it('resolves relative image file path against conversation workspace root', async () => {
    const workDir = mkdtempSync(join(imageRoot, 'work-'))
    writeFileSync(join(workDir, 'chart.png'), 'png-bytes-data')
    const gm = new BridgeManager([imageDef], imageHub, 500, join(imageRoot, 'rel-agents.json'))
    try {
      gm.setSessionWorkspaceResolver(sId => (sId === 'dsh-work-sess' ? { workspaceRoot: workDir } : undefined))
      gm.bindChatAgent('dsh-work-sess', 'hasimage')
      const chunks: StreamChunk[] = []
      for await (const chunk of gm.streamPrompt({
        model: 'hasimage',
        sessionId: 'dsh-work-sess',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'check chart' },
              { type: 'image', path: './chart.png' },
            ],
          },
        ],
      } as never)) {
        chunks.push(chunk)
      }
      const finish = chunks.find(c => c.type === 'finish') as Extract<StreamChunk, { type: 'finish' }> | undefined
      expect(finish).toBeDefined()
      expect(finish?.reason.kind).toBe('stop')

      const acpSessionId = gm.chatSessions('dsh-work-sess')[0]?.sessionId
      expect(acpSessionId).toBeDefined()
      await settleTranscript(gm, acpSessionId!)
      const transcript = await dispatchRpc(gm, 'transcript/get', { sessionId: acpSessionId })
      expect(transcript.ok).toBe(true)
      const echoedText = ((transcript as { value: { entries: Array<{ update: Record<string, unknown> }> } }).value.entries)
        .filter(entry => entry.update.sessionUpdate === 'agent_message_chunk')
        .map(entry => String((entry.update.content as { text?: string }).text ?? ''))
        .join('')
      expect(echoedText).toContain('images=1')
    } finally {
      await gm.shutdownAll()
    }
  }, 30_000)

  it('resolves attachments through an attachment resolver class with prototype methods', async () => {
    class MockAttachmentService {
      getAttachment(id: string) {
        if (id === 'service-att-1') {
          return { data: 'data:image/png;base64,cHJvdG9pbWFnZQ==' }
        }
        return undefined
      }
    }
    const gm = new BridgeManager([imageDef], imageHub, 500, join(imageRoot, 'proto-agents.json'))
    try {
      gm.setAttachmentResolver(new MockAttachmentService())
      gm.bindChatAgent('dsh-proto-sess', 'hasimage')
      const chunks: StreamChunk[] = []
      for await (const chunk of gm.streamPrompt({
        model: 'hasimage',
        sessionId: 'dsh-proto-sess',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'describe proto image' },
              { type: 'image', attachmentId: 'service-att-1' },
            ],
          },
        ],
      } as never)) {
        chunks.push(chunk)
      }
      const finish = chunks.find(c => c.type === 'finish') as Extract<StreamChunk, { type: 'finish' }> | undefined
      expect(finish?.reason.kind).toBe('stop')

      const acpSessionId = gm.chatSessions('dsh-proto-sess')[0]?.sessionId
      expect(acpSessionId).toBeDefined()
      await settleTranscript(gm, acpSessionId!)
      const transcript = await dispatchRpc(gm, 'transcript/get', { sessionId: acpSessionId })
      expect(transcript.ok).toBe(true)
      const echoedText = ((transcript as { value: { entries: Array<{ update: Record<string, unknown> }> } }).value.entries)
        .filter(entry => entry.update.sessionUpdate === 'agent_message_chunk')
        .map(entry => String((entry.update.content as { text?: string }).text ?? ''))
        .join('')
      expect(echoedText).toContain('images=1')
    } finally {
      await gm.shutdownAll()
    }
  }, 30_000)

  it('resolves image attachment through a LocalAttachmentStore service requiring this.root and async readImage', async () => {
    const hash = 'ab' + 'd'.repeat(62)
    const objectsDir = join(imageRoot, 'dsh-objects', 'objects', 'ab')
    mkdirSync(objectsDir, { recursive: true })
    writeFileSync(join(objectsDir, hash), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]))

    class RealisticAttachmentStore {
      root = join(imageRoot, 'dsh-objects')

      imageHostPath(ref: { attachmentId?: string }) {
        if (!this || this.root !== join(imageRoot, 'dsh-objects')) {
          throw new TypeError("Cannot read properties of undefined (reading 'root')")
        }
        const match = /^sha256:([a-f0-9]{64})$/.exec(String(ref?.attachmentId))
        if (!match) throw new Error('INVALID_ATTACHMENT_REF')
        return join(this.root, 'objects', match[1].slice(0, 2), match[1])
      }

      async readImage(ref: { attachmentId?: string }) {
        if (!this || this.root !== join(imageRoot, 'dsh-objects')) {
          throw new TypeError("Cannot read properties of undefined (reading 'root')")
        }
        throw new Error('ATTACHMENT_NOT_FOUND')
      }
    }

    const gm = new BridgeManager([imageDef], imageHub, 500, join(imageRoot, 'realstore-agents.json'))
    try {
      gm.setAttachmentResolver(new RealisticAttachmentStore())
      gm.bindChatAgent('dsh-realstore-sess', 'hasimage')

      const chunks: StreamChunk[] = []
      for await (const chunk of gm.streamPrompt({
        model: 'hasimage',
        sessionId: 'dsh-realstore-sess',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'describe this attached screenshot' },
              {
                type: 'image',
                attachment: {
                  attachmentId: `sha256:${hash}`,
                  mediaType: 'image/png',
                },
              },
            ],
          },
        ],
      } as never)) {
        chunks.push(chunk)
      }

      const finish = chunks.find(c => c.type === 'finish') as Extract<StreamChunk, { type: 'finish' }> | undefined
      expect(finish?.reason.kind).toBe('stop')

      const acpSessionId = gm.chatSessions('dsh-realstore-sess')[0]?.sessionId
      expect(acpSessionId).toBeDefined()
      await settleTranscript(gm, acpSessionId!)
      const transcript = await dispatchRpc(gm, 'transcript/get', { sessionId: acpSessionId })
      expect(transcript.ok).toBe(true)
      const echoedText = ((transcript as { value: { entries: Array<{ update: Record<string, unknown> }> } }).value.entries)
        .filter(entry => entry.update.sessionUpdate === 'agent_message_chunk')
        .map(entry => String((entry.update.content as { text?: string }).text ?? ''))
        .join('')
      expect(echoedText).toContain('images=1')
    } finally {
      await gm.shutdownAll()
    }
  }, 30_000)

  it('handles concurrent mixed image and text requests across different agents without interference', async () => {
    const gm = new BridgeManager([noImageDef, imageDef], imageHub, 500, join(imageRoot, 'concurrent-agents.json'))
    try {
      gm.bindChatAgent('dsh-conc-img-yes', 'hasimage')
      gm.bindChatAgent('dsh-conc-img-no', 'noimage')
      gm.bindChatAgent('dsh-conc-txt-no', 'noimage')

      const runTurn = async (sessionId: string, model: string, content: Array<{ type: string; [k: string]: unknown }>) => {
        const chunks: StreamChunk[] = []
        for await (const chunk of gm.streamPrompt({
          model,
          sessionId,
          messages: [{ role: 'user', content }],
        } as never)) {
          chunks.push(chunk)
        }
        return chunks
      }

      const [resImgYes, resImgNo, resTxtNo] = await Promise.all([
        runTurn('dsh-conc-img-yes', 'hasimage', [
          { type: 'text', text: 'image prompt' },
          { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' },
        ]),
        runTurn('dsh-conc-img-no', 'noimage', [
          { type: 'text', text: 'unsupported image prompt' },
          { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' },
        ]),
        runTurn('dsh-conc-txt-no', 'noimage', [
          { type: 'text', text: 'plain text only' },
        ]),
      ])

      expect(resImgYes.find(c => c.type === 'finish')?.reason.kind).toBe('stop')
      expect(resImgNo.find(c => c.type === 'finish')?.reason).toMatchObject({
        kind: 'error',
        failure: { code: 'image_unsupported' },
      })
      expect(resTxtNo.find(c => c.type === 'finish')?.reason.kind).toBe('stop')
    } finally {
      await gm.shutdownAll()
    }
  }, 45_000)
})

/**
 * A prompt the agent folds into a background drain it is already running
 * (CodeBuddy 2.179.0 multitask): `session/prompt` answers `end_turn` in
 * milliseconds with no `codebuddy.ai/conversationRequestId`, and the real
 * answer streams afterwards under the drain's request id. Closing the turn on
 * that response cut every such answer — these cases pin the wait, its tools,
 * its wording, and the tail a response races past.
 */
describe('a prompt steered into a background drain (isolated manager)', () => {
  const drainWorkspace = `${tmpdir()}/dsh-ntr-drain-workspace`
  mkdirSync(drainWorkspace, { recursive: true })
  const drainHub = new EventHub()
  const drainEvents: AcpEvent[] = []
  drainHub.subscribe(event => { drainEvents.push(event) })
  const drainManager = new BridgeManager(
    [{ ...def, id: 'drain', cwd: drainWorkspace, allowedCwdRoots: [drainWorkspace] }],
    drainHub,
    500,
    undefined,
    undefined,
    true,
    // Tiny windows keep these cases fast. The quiet window must still exceed
    // the GAP drain's 150ms tick spacing (proving ticks hold the turn open),
    // while the cancel fallback must fire BEFORE the drain goes quiet so the
    // fallback test proves the fallback — not silence — closed the turn.
    { startupTimeoutMs: 3_000, cancelFallbackMs: 100, ambientQuietMs: 250 },
  )
  const drainAdapter = new AcpLlmAdapter(drainManager)

  afterAll(async () => {
    await drainManager.shutdownAll()
  })

  /** Drive one chat turn to completion, collecting every chunk of every step. */
  async function drainTurn(dshSessionId: string, text: string): Promise<StreamChunk[]> {
    const chunks: StreamChunk[] = []
    for await (const chunk of drainAdapter.stream({
      provider: 'acp',
      model: 'drain',
      sessionId: dshSessionId,
      messages: [
        { role: 'user', content: [{ type: 'text', text }] },
      ],
    })) {
      chunks.push(chunk)
    }
    return chunks
  }

  function textOf(chunks: StreamChunk[]): string {
    return chunks
      .filter((c): c is Extract<StreamChunk, { type: 'text-delta' }> => c.type === 'text-delta')
      .map(c => c.text)
      .join('')
  }

  function finishOf(chunks: StreamChunk[]): Extract<StreamChunk, { type: 'finish' }> | undefined {
    return chunks.find((c): c is Extract<StreamChunk, { type: 'finish' }> => c.type === 'finish')
  }

  /**
   * Wait until a chat turn has entered its ambient wait: the prompt response
   * already landed (the settle gate is open) while the drained segment is
   * still on air. The state has no event of its own, so this polls the
   * manager's controller index.
   */
  async function waitForAmbient(dshSessionId: string): Promise<NonNullable<ReturnType<BridgeManager['turnStreamFor']>>> {
    const deadline = Date.now() + 10_000
    for (;;) {
      const live = drainManager.turnStreamFor(dshSessionId)
      if (live !== undefined && !live.hasSettled && live.hasOpenSegment && live.session.settled === undefined) return live
      if (Date.now() > deadline) throw new Error('the turn never entered an ambient wait')
      await new Promise(resolve => setTimeout(resolve, 5))
    }
  }

  /** The ACP transcript's raw updates for one chat session, after quiescence. */
  async function drainTranscript(dshSessionId: string): Promise<Array<Record<string, unknown>>> {
    const acpSessionId = drainManager.chatSessions(dshSessionId)[0]?.sessionId
    if (acpSessionId === undefined) throw new Error('no live ACP session for the chat session')
    await settleTranscript(drainManager, acpSessionId)
    const transcript = await dispatchRpc(drainManager, 'transcript/get', { sessionId: acpSessionId })
    if (!transcript.ok) throw new Error('transcript failed')
    return (transcript.value as { entries: Array<{ update: Record<string, unknown> }> }).entries
      .map(entry => entry.update)
  }

  const AMBIENT_REPORT = 'deferred this turn to a background task run'
  const ZERO_OUTPUT_REPORT = 'ended the turn with no visible output'
  const RETIRED_FOLD_REPORT = 'may have been folded into a background run'

  it('keeps the turn open for the drain: its text arrives, its tools stay off the main plane', async () => {
    const dshSessionId = 'dsh-drain-steer'
    const since = drainEvents.length
    const chunks = await drainTurn(dshSessionId, 'STEER please')
    const text = textOf(chunks)

    // The drain's answer reached the user's turn instead of being cut at the
    // instant `end_turn` response (the 14ms codebuddy shape).
    expect(text).toContain('AMBIENT-TEXT')
    expect(text).toContain('TAIL-TEXT')
    expect(finishOf(chunks)?.reason).toEqual({ kind: 'stop' })
    // A deferred turn is not a silent-failure turn: neither report fired.
    expect(text).not.toContain(ZERO_OUTPUT_REPORT)
    expect(text).not.toContain(AMBIENT_REPORT)

    // A background tool never opens a card on the main plane...
    expect(chunks.filter(c => c.type === 'tool-call-delta')).toHaveLength(0)
    // ...but it is in the ACP transcript the NTR view reads.
    const acpSessionId = drainManager.chatSessions(dshSessionId)[0]?.sessionId
    expect(acpSessionId).toBeDefined()
    const transcript = await dispatchRpc(drainManager, 'transcript/get', { sessionId: acpSessionId! })
    if (!transcript.ok) throw new Error('transcript failed')
    const entries = (transcript.value as { entries: Array<{ update: Record<string, unknown> }> }).entries
    expect(entries.some(entry => entry.update.sessionUpdate === 'tool_call' && entry.update.toolCallId === 'amb_tool')).toBe(true)
    expect(entries.some(entry => entry.update.sessionUpdate === 'tool_call_update'
      && entry.update.toolCallId === 'amb_tool'
      && entry.update.status === 'completed')).toBe(true)

    // `turn/end` is the LAST thing the turn says: every drained text delta
    // precedes it, and it fires exactly once.
    const order = drainEvents
      .slice(since)
      .filter(event => event.sessionId === acpSessionId)
      .map(event => event.type === 'turn/end'
        ? 'end'
        : event.type === 'session/update' && event.update.sessionUpdate === 'agent_message_chunk'
          ? 'text'
          : 'other')
      .filter(mark => mark !== 'other')
    expect(order.filter(mark => mark === 'text').length).toBeGreaterThan(0)
    expect(order.at(-1)).toBe('end')
    expect(order.filter(mark => mark === 'end')).toHaveLength(1)

    // One notice per background run, not one per drain tick.
    const notices = drainEvents
      .slice(since)
      .filter(event => event.type === 'agent/notice' && event.text.startsWith('acp: agent "drain" started a background task turn'))
    expect(notices).toHaveLength(1)
  }, 30_000)

  it('closes a first-turn drain that only ran tools with a pointer, never rolling the lock back', async () => {
    const dshSessionId = 'dsh-drain-steer-tool'
    const since = drainEvents.length
    const chunks = await drainTurn(dshSessionId, 'STEERTOOL please')
    const text = textOf(chunks)

    expect(finishOf(chunks)?.reason).toEqual({ kind: 'stop' })
    expect(text.trim()).not.toBe('')
    // Deferred, not failed: the pointer says where the output went.
    expect(text).toContain(AMBIENT_REPORT)
    expect(text).not.toContain(ZERO_OUTPUT_REPORT)

    // This was the conversation's FIRST turn and it never showed a visible
    // block (the drain ran only suppressed tools). Deferring is not a failed
    // first turn: the lock and the live session stay, and no unlock is
    // broadcast — the drain's output still lands in the transcript.
    expect(drainManager.lockedAgentFor(dshSessionId)).toBe('drain')
    expect(drainManager.chatSessions(dshSessionId)).toHaveLength(1)
    expect(drainEvents.slice(since).some(event =>
      event.type === 'chat/agent-unlocked' && event.dshSessionId === dshSessionId)).toBe(false)
  }, 30_000)

  it('keeps the turn open across sub-quiet model-call gaps in a drain', async () => {
    const chunks = await drainTurn('dsh-drain-gap', 'GAP please')
    const text = textOf(chunks)

    // The drain ticks every 150ms for ~600ms before its text exists: longer
    // than the 250ms quiet window, but no single GAP is. The turn must still
    // be open when GAP-TEXT arrives instead of closing on the first silence.
    expect(text).toContain('GAP-TEXT')
    expect(text).not.toContain(AMBIENT_REPORT)
    expect(finishOf(chunks)?.reason).toEqual({ kind: 'stop' })
  }, 30_000)

  it('withholds drain text from a normal turn and keeps drain tools off the plane', async () => {
    const dshSessionId = 'dsh-drain-early'
    const chunks = await drainTurn(dshSessionId, 'EARLY please')
    const text = textOf(chunks)

    // DRAIN-EARLY arrived while the turn's own request id was unknown and the
    // response named a conversation turn: it was never this answer.
    expect(text).toContain('REAL-ANSWER')
    expect(text).toContain('REAL-TAIL')
    expect(text).not.toContain('DRAIN-EARLY')
    expect(text).not.toContain(AMBIENT_REPORT)
    // A drain-owned tool call during a normal turn is transcript-only: opening
    // a card would make the host execute it for the user's turn.
    expect(chunks.filter(c => c.type === 'tool-call-delta')).toHaveLength(0)

    const updates = await drainTranscript(dshSessionId)
    expect(updates.some(update => update.sessionUpdate === 'agent_message_chunk'
      && String((update.content as { text?: string }).text ?? '').includes('DRAIN-EARLY'))).toBe(true)
    expect(updates.some(update => update.sessionUpdate === 'tool_call'
      && update.toolCallId === 'drain_early_tool')).toBe(true)
  }, 30_000)

  it('flushes withheld drain text into a steered turn', async () => {
    const chunks = await drainTurn('dsh-drain-early-steer', 'EARLY-STEER please')
    const text = textOf(chunks)

    // Same early drain text, but the response carries NO conversation id: the
    // prompt was folded into the drain, so the withheld text is this answer.
    expect(text).toContain('DRAIN-EARLY')
    expect(text).toContain('AFTER-EARLY')
    expect(text).not.toContain(AMBIENT_REPORT)
    expect(chunks.filter(c => c.type === 'tool-call-delta')).toHaveLength(0)
    expect(finishOf(chunks)?.reason).toEqual({ kind: 'stop' })
  }, 30_000)

  it('reports a truncated withhold buffer instead of dropping the drain front silently', async () => {
    // FLOOD streams 220 indexed drain updates before the prompt response judges
    // the turn. The bounded withhold buffer can only carry 200: the flush must
    // say the front was dropped (the transcript still has every entry), never
    // let the answer start mid-story without a word.
    const chunks = await drainTurn('dsh-drain-flood', 'FLOOD please')
    const text = textOf(chunks)

    const marker = 'background output was truncated'
    expect(text).toContain(marker)
    // The buffer evicted the FRONT, not the tail: the marker precedes the
    // retained content, and the first kept update is the one just past the
    // 200-entry bound.
    expect(text).toContain('FLOOD-020')
    expect(text).toContain('FLOOD-219')
    expect(text).not.toContain('FLOOD-000')
    expect(text).not.toContain('FLOOD-019')
    expect(text.indexOf(marker)).toBeLessThan(text.indexOf('FLOOD-020'))
    expect(finishOf(chunks)?.reason).toEqual({ kind: 'stop' })
  }, 30_000)

  it('drains the tail the prompt response raced past before judging the turn empty', async () => {
    const chunks = await drainTurn('dsh-drain-tail', 'TAIL please')
    const text = textOf(chunks)

    // The mock writes the chunks and answers without waiting for their
    // dispatch: a settle that judges visibility before one macrotask loses them.
    expect(text).toContain('TAIL-CHUNK')
    expect(text).not.toContain(ZERO_OUTPUT_REPORT)
    expect(finishOf(chunks)?.reason).toEqual({ kind: 'stop' })
  }, 30_000)

  it('still reports a normal stop with nothing to show, in the original wording', async () => {
    const chunks = await drainTurn('dsh-drain-empty', 'EMPTY please')
    const text = textOf(chunks)

    expect(text).toContain(ZERO_OUTPUT_REPORT)
    expect(text).toContain('(stop reason: end_turn)')
    // A turn nobody steered must not borrow the deferred wording.
    expect(text).not.toContain(AMBIENT_REPORT)
    expect(finishOf(chunks)?.reason).toEqual({ kind: 'stop' })
  }, 30_000)

  it('does not treat a later normal turn as steered after an ambient wait closed', async () => {
    const dshSessionId = 'dsh-drain-ambient-cleared'
    const first = await drainTurn(dshSessionId, 'STEER please')
    expect(textOf(first)).toContain('AMBIENT-TEXT')

    // The drain is over and its wait closed. The NEXT prompt is a normal turn
    // that names its conversation request id, so even with the drain's id
    // still retired it must close on its own terms — not be held open, not be
    // called a possible fold, and not borrow the deferred wording.
    const second = await drainTurn(dshSessionId, 'CONVIDLE please')
    const text = textOf(second)
    expect(text).toContain(ZERO_OUTPUT_REPORT)
    expect(text).not.toContain(AMBIENT_REPORT)
    expect(text).not.toContain(RETIRED_FOLD_REPORT)
    expect(finishOf(second)?.reason).toEqual({ kind: 'stop' })
  }, 30_000)

  it('revives a quiet-closed drain when it re-announces, so the steered text reaches the turn', async () => {
    const dshSessionId = 'dsh-drain-reannounce'
    // Turn 1 retires the drain's id: its wait closes on silence.
    const first = await drainTurn(dshSessionId, 'QUIETDRAIN please')
    expect(textOf(first)).toContain(AMBIENT_REPORT)

    // The same run re-announces itself in turn 2 and the response names no
    // conversation turn. The retired mark must not outlive the re-announcement:
    // the drain's text IS this (steered) turn's answer, not transcript-only.
    const second = await drainTurn(dshSessionId, 'DRAINAGAIN please')
    const text = textOf(second)
    expect(text).toContain('REANNOUNCED-TEXT')
    expect(text).not.toContain(AMBIENT_REPORT)
    expect(text).not.toContain(RETIRED_FOLD_REPORT)
    expect(finishOf(second)?.reason).toEqual({ kind: 'stop' })
  }, 30_000)

  it('revives a quiet-closed drain from its late update alone, so a steered prompt receives the text', async () => {
    const dshSessionId = 'dsh-drain-revive-steered'
    const first = await drainTurn(dshSessionId, 'QUIETDRAIN please')
    expect(textOf(first)).toContain(AMBIENT_REPORT)

    // The revived drain speaks BEFORE the prompt response is judged and never
    // re-announces itself. The update alone must un-retire the id and rebuild
    // the ambient record; the fold into it is then detected as steered and its
    // text (before and after the response) reaches the user.
    const second = await drainTurn(dshSessionId, 'DRAINFIRST please')
    const text = textOf(second)
    expect(text).toContain('DRAIN-FIRST-TEXT')
    expect(text).toContain('DRAIN-FIRST-TAIL')
    expect(text).not.toContain(AMBIENT_REPORT)
    expect(text).not.toContain(RETIRED_FOLD_REPORT)
    expect(finishOf(second)?.reason).toEqual({ kind: 'stop' })
  }, 30_000)

  it('reports a possible fold, not agent silence, when a recently retired drain may have taken the prompt', async () => {
    const dshSessionId = 'dsh-drain-retired-fold'
    const first = await drainTurn(dshSessionId, 'QUIETDRAIN please')
    expect(textOf(first)).toContain(AMBIENT_REPORT)

    // No drain update and no re-announcement: the prompt answers instantly with
    // no conversation request id. The drain may still be running, so the empty
    // bubble must say the turn may have been folded into it (output is in the
    // transcript) instead of blaming the agent and suggesting a resend. The
    // turn is NOT held open — the report is immediate.
    const started = Date.now()
    const second = await drainTurn(dshSessionId, 'EMPTY please')
    const text = textOf(second)
    expect(text).toContain(RETIRED_FOLD_REPORT)
    expect(text).not.toContain('try resending')
    expect(text).not.toContain('check the agent process logs')
    expect(text).not.toContain(ZERO_OUTPUT_REPORT)
    expect(Date.now() - started).toBeLessThan(5_000)
    expect(finishOf(second)?.reason).toEqual({ kind: 'stop' })
  }, 30_000)

  it('keeps a revived drain\'s late text out of the next turn that arrives first', async () => {
    const dshSessionId = 'dsh-drain-revive-first'
    // Turn 1: the drain announces itself and then stays silent, so the ambient
    // quiet window closes the turn and drops the drain record — its id is
    // RETIRED, not forgotten: the run itself is still alive.
    const first = await drainTurn(dshSessionId, 'QUIETDRAIN please')
    expect(textOf(first)).toContain(AMBIENT_REPORT)

    // Turn 2 is an ordinary turn (its response names a conversation id). The
    // revived drain speaks BEFORE this turn's own text: without the retired
    // id, `noteTurnRequestId` would adopt the drain's id and the background
    // text would be folded into the user's answer (a double answer).
    const second = await drainTurn(dshSessionId, 'REVIVE please')
    const text = textOf(second)
    expect(text).toContain('REVIVE-NORMAL-TEXT')
    expect(text).not.toContain('REVIVED-DRAIN-TEXT')
    // The revived run's tool call is a background tool: transcript-only, no
    // card for the host to execute as part of this turn.
    expect(second.filter(chunk => chunk.type === 'tool-call-delta')).toHaveLength(0)
    expect(finishOf(second)?.reason).toEqual({ kind: 'stop' })

    // Nothing was lost: the late drain prose is in the ACP transcript view.
    const updates = await drainTranscript(dshSessionId)
    expect(updates.some(update => update.sessionUpdate === 'agent_message_chunk'
      && String((update.content as { text?: string }).text ?? '').includes('REVIVED-DRAIN-TEXT'))).toBe(true)
    expect(updates.some(update => update.sessionUpdate === 'tool_call'
      && update.toolCallId === 'amb_quiet_tool')).toBe(true)
  }, 30_000)

  it('keeps a revived drain\'s late text out when it lands after the normal answer', async () => {
    const dshSessionId = 'dsh-drain-revive-late'
    const first = await drainTurn(dshSessionId, 'QUIETDRAIN please')
    expect(textOf(first)).toContain(AMBIENT_REPORT)

    // The stray-tail shape: this turn's own text (and its request id) came
    // first, then the revived drain's text. The ambient record is gone, so
    // only the retired id can tell this text apart from the answer.
    const second = await drainTurn(dshSessionId, 'REVIVE-LATE please')
    const text = textOf(second)
    expect(text).toContain('REVIVE-NORMAL-TEXT')
    expect(text).not.toContain('REVIVED-DRAIN-TEXT')
    expect(second.filter(chunk => chunk.type === 'tool-call-delta')).toHaveLength(0)
    expect(finishOf(second)?.reason).toEqual({ kind: 'stop' })

    const updates = await drainTranscript(dshSessionId)
    expect(updates.some(update => update.sessionUpdate === 'agent_message_chunk'
      && String((update.content as { text?: string }).text ?? '').includes('REVIVED-DRAIN-TEXT'))).toBe(true)
  }, 30_000)

  it('retires a waiting turn when the conversation moves on, ending its driver step without touching the session', async () => {
    const dshSessionId = 'dsh-drain-supersede'
    const since = drainEvents.length
    const chunks: StreamChunk[] = []
    const drained = (async () => {
      for await (const chunk of drainAdapter.stream({
        provider: 'acp',
        model: 'drain',
        sessionId: dshSessionId,
        messages: [{ role: 'user', content: [{ type: 'text', text: 'STEER please' }] }],
      })) {
        chunks.push(chunk)
      }
    })()

    // Entered the ambient wait: the response already released the prompt slot
    // (`endTurn` cleared `session.settled`) while the segment is still open and
    // the turn is NOT settled.
    const deadline = Date.now() + 10_000
    let live = drainManager.turnStreamFor(dshSessionId)
    for (;;) {
      if (live !== undefined && live.hasOpenSegment && live.session.settled === undefined) break
      if (Date.now() > deadline) throw new Error('the turn never entered an ambient wait')
      await new Promise(resolve => setTimeout(resolve, 5))
      live = drainManager.turnStreamFor(dshSessionId)
    }
    if (live === undefined) throw new Error('no controller')
    const turnId = live.turnId
    const acpSessionId = live.session.sessionId
    expect(live.hasSettled).toBe(false)

    // The conversation's next turn replaces the controller before the drain
    // goes quiet: the old driver step must not stay parked on its queue.
    const replacement = {
      session: live.session,
      stale: false,
      hasOpenSegment: true,
      finishActive: () => {},
      dispose: () => {},
      settle: () => {},
    } as unknown as never
    try {
      drainManager.rememberTurnStream(dshSessionId, replacement)
      await Promise.race([
        drained,
        new Promise((_, reject) => setTimeout(() => reject(new Error('the retired step is still parked on its queue')), 5_000)),
      ])
      // The retired turn closed ITS OWN stream...
      expect(finishOf(chunks)?.reason).toMatchObject({ kind: 'aborted' })
      // ...and never touched the session the newer turn now owns: no turn/end,
      // and the session is still running for whoever is on air.
      expect(live.session.running).toBe(true)
      expect(drainEvents.slice(since).some(event =>
        event.type === 'turn/end' && event.sessionId === acpSessionId && event.turnId === turnId)).toBe(false)
    } finally {
      drainManager.forgetTurnStream(replacement)
    }
  }, 30_000)

  it('accepts the next prompt while the previous turn still waits on its drain', async () => {
    const dshSessionId = 'dsh-drain-reenter'
    const since = drainEvents.length
    const firstChunks: StreamChunk[] = []
    const first = (async () => {
      for await (const chunk of drainAdapter.stream({
        provider: 'acp',
        model: 'drain',
        sessionId: dshSessionId,
        messages: [{ role: 'user', content: [{ type: 'text', text: 'STEER please' }] }],
      })) {
        firstChunks.push(chunk)
      }
    })()

    const waiting = await waitForAmbient(dshSessionId)
    const session = waiting.session
    // The waiting turn still holds the session's `running` flag on purpose
    // (the drain is its work), and its first-turn lock is provisional.
    expect(session.running).toBe(true)
    expect(session.provisionalLock).toBe(true)

    // The user sends again while the drain is still talking: the claim is
    // gated on the HOST's prompt slot (already released with the response),
    // never on `running` — and a failed claim must not roll the first-turn
    // lock back while the drain is streaming.
    const second = await hostLoopTurn(drainAdapter, {
      provider: 'acp',
      model: 'drain',
      sessionId: dshSessionId,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'second please' }] }],
    })
    expect(finishOf(second.chunks)?.reason).toEqual({ kind: 'stop' })
    expect(textOf(second.chunks)).toContain('MOCK: echo second please')

    // The superseded waiting step ended when the new turn took the controller
    // (rememberTurnStream disposes it, which closes its queue).
    await Promise.race([
      first,
      new Promise((_, reject) => setTimeout(() => reject(new Error('the waiting step is still parked on its queue')), 5_000)),
    ])
    expect(finishOf(firstChunks)?.reason).toMatchObject({ kind: 'aborted' })

    // Nothing gave the conversation back: the session (and its ACP transcript)
    // survived, and the lock was never rolled back.
    expect(session.closed).toBe(false)
    expect(drainManager.chatSessions(dshSessionId)).toHaveLength(1)
    expect(drainEvents.slice(since).some(event =>
      event.type === 'chat/agent-unlocked' && event.dshSessionId === dshSessionId)).toBe(false)
  }, 30_000)

  it('ends a waiting turn through its controller when the cancel fallback fires: one turn/end, promptly', async () => {
    const dshSessionId = 'dsh-drain-fallback'
    const since = drainEvents.length
    const chunks: StreamChunk[] = []
    const drained = (async () => {
      for await (const chunk of drainAdapter.stream({
        provider: 'acp',
        model: 'drain',
        sessionId: dshSessionId,
        messages: [{ role: 'user', content: [{ type: 'text', text: 'STEER please' }] }],
      })) {
        chunks.push(chunk)
      }
    })()

    const waiting = await waitForAmbient(dshSessionId)
    const sessionId = waiting.session.sessionId
    const turnId = waiting.turnId

    // Cancel WITHOUT the driver's own abort (the `/acp` cancel face): the
    // ambient step stays on air until the fallback force-finalizes it.
    await drainManager.cancel(sessionId)
    const started = Date.now()
    await Promise.race([
      drained,
      new Promise((_, reject) => setTimeout(() => reject(new Error('the ambient step never closed')), 5_000)),
    ])
    // Closed by the 300ms fallback, not by the ambient ceiling (120s).
    expect(Date.now() - started).toBeLessThan(5_000)

    // Exactly one frame, and it names the turn's REAL id (the controller's),
    // with the fallback's reason.
    const frames = drainEvents.slice(since).filter(event => event.type === 'turn/end' && event.sessionId === sessionId)
    expect(frames).toHaveLength(1)
    expect(frames[0]).toMatchObject({ turnId, error: expect.stringContaining('did not respond to the cancel request') })
    expect(finishOf(chunks)?.reason).toMatchObject({ kind: 'error' })
    expect(waiting.session.running).toBe(false)
  }, 30_000)

  it('emits exactly one turn/end when a settle error lands during the ambient wait', async () => {
    const dshSessionId = 'dsh-drain-watchdog'
    const since = drainEvents.length
    const chunks: StreamChunk[] = []
    const drained = (async () => {
      for await (const chunk of drainAdapter.stream({
        provider: 'acp',
        model: 'drain',
        sessionId: dshSessionId,
        messages: [{ role: 'user', content: [{ type: 'text', text: 'STEER please' }] }],
      })) {
        chunks.push(chunk)
      }
    })()

    const waiting = await waitForAmbient(dshSessionId)
    const sessionId = waiting.session.sessionId
    const turnId = waiting.turnId

    // What the stall watchdog does when it decides the agent went silent
    // while still holding the segment open.
    waiting.settle({ kind: 'error', message: 'watchdog: synthetic silence', code: 'INACTIVITY_TIMEOUT' })
    await Promise.race([
      drained,
      new Promise((_, reject) => setTimeout(() => reject(new Error('the settled step never closed')), 5_000)),
    ])

    const frames = () => drainEvents.slice(since).filter(event => event.type === 'turn/end' && event.sessionId === sessionId)
    expect(frames()).toHaveLength(1)
    expect(frames()[0]).toMatchObject({ turnId, error: 'watchdog: synthetic silence' })
    expect(finishOf(chunks)?.reason).toMatchObject({ kind: 'error', failure: { code: 'INACTIVITY_TIMEOUT' } })

    // Longer than the ambient quiet window: a surviving quiet timer would have
    // broadcast a second frame by now. (Bounded negative wait — there is no
    // event for "the timer did not fire".)
    await new Promise(resolve => setTimeout(resolve, 900))
    expect(frames()).toHaveLength(1)
  }, 30_000)

  it('never broadcasts a second turn/end when the session closes inside the settle macrotask', async () => {
    const dshSessionId = 'dsh-drain-close-race'
    const chunks: StreamChunk[] = []
    const drained = (async () => {
      for await (const chunk of drainAdapter.stream({
        provider: 'acp',
        model: 'drain',
        sessionId: dshSessionId,
        messages: [{ role: 'user', content: [{ type: 'text', text: 'STEER please' }] }],
      })) {
        chunks.push(chunk)
      }
    })()

    const waiting = await waitForAmbient(dshSessionId)
    const sessionId = waiting.session.sessionId
    const turnId = waiting.turnId
    const since = drainEvents.length

    // The response landed: its closing work (tail drain + turn/end) is queued
    // for the next macrotask. Closing the session in that window disposes the
    // controller; the queued close must be retired with it, or the teardown's
    // already-finished turn gets a SECOND turn/end carrying the real turn id.
    waiting.settle({ kind: 'stop', stopReason: 'end_turn' })
    await drainManager.closeSession(sessionId)
    await Promise.race([
      drained,
      new Promise((_, reject) => setTimeout(() => reject(new Error('the step never closed')), 5_000)),
    ])

    const frames = drainEvents.slice(since).filter(event => event.type === 'turn/end' && event.sessionId === sessionId)
    expect(frames.filter(event => event.turnId === turnId)).toHaveLength(0)
    expect(finishOf(chunks)?.reason).toMatchObject({ kind: 'aborted' })
  }, 30_000)

  it('never folds a successor turn\'s tail into a superseded waiting turn', async () => {
    const dshSessionId = 'dsh-drain-stale-tail'
    const since = drainEvents.length
    const chunks: StreamChunk[] = []
    const drained = (async () => {
      for await (const chunk of drainAdapter.stream({
        provider: 'acp',
        model: 'drain',
        sessionId: dshSessionId,
        messages: [{ role: 'user', content: [{ type: 'text', text: 'STEER please' }] }],
      })) {
        chunks.push(chunk)
      }
    })()

    const waiting = await waitForAmbient(dshSessionId)
    const session = waiting.session

    // The turn settles, so its closing work (the deferred tail read) is queued
    // for the next macrotask...
    waiting.settle({ kind: 'cancelled' })
    // ...and in that window the conversation's NEXT turn begins: `turnSeq`
    // moves on, and an update that belongs to the new turn lands in the
    // transcript without this (superseded) segment having folded it.
    session.turnSeq += 1
    session.transcript.append({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'SUCCESSOR-TEXT' },
    })
    // A continuation step opening here runs the deferred close NOW.
    waiting.startSegment()

    await Promise.race([
      drained,
      new Promise((_, reject) => setTimeout(() => reject(new Error('the superseded step never closed')), 5_000)),
    ])
    // The stale tail read folded nothing into the old step: that text belongs
    // to the successor turn, not to this stream.
    expect(textOf(chunks)).not.toContain('SUCCESSOR-TEXT')
    expect(finishOf(chunks)?.reason).toMatchObject({ kind: 'aborted' })
    // A superseded close never touches the session the newer turn owns.
    expect(session.running).toBe(true)
    expect(drainEvents.slice(since).some(event =>
      event.type === 'turn/end' && event.sessionId === session.sessionId)).toBe(false)
  }, 30_000)
})

/**
 * A turn whose `Agent` call dispatched a DETACHED worker: the coordinator
 * answers its own prompt ("已派…") while the worker keeps running off-turn,
 * and the worker's report arrives minutes later through a background drain.
 * Closing at the prompt response (the old behaviour) leaves the main chat with
 * no answer at all — the report exists only in the ACP transcript view.
 *
 * The turn must instead HOLD across the worker phase (no quiet window: a
 * detached worker goes silent for tens of seconds while it thinks) and then
 * close on the drain's own terms. The worker's own updates and tools are never
 * the session's answer, whichever turn is on air.
 */
describe('a turn that dispatched a detached worker (isolated manager)', () => {
  const dispatchWorkspace = `${tmpdir()}/dsh-ntr-dispatch-workspace`
  mkdirSync(dispatchWorkspace, { recursive: true })
  const dispatchHub = new EventHub()
  const dispatchEvents: AcpEvent[] = []
  dispatchHub.subscribe(event => { dispatchEvents.push(event) })
  const dispatchManager = new BridgeManager(
    [{ ...def, id: 'dispatch', cwd: dispatchWorkspace, allowedCwdRoots: [dispatchWorkspace] }],
    dispatchHub,
    500,
    undefined,
    undefined,
    false,
    {
      startupTimeoutMs: 3_000,
      cancelFallbackMs: 100,
      // The worker phase has no quiet window at all; the drain phase reuses
      // the ambient pair (a short quiet window keeps the cases fast). The
      // worker-phase cap stays well above the mock's several dispatches while
      // remaining short enough for the no-drain cases.
      ambientQuietMs: 250,
      backgroundTaskMaxMs: 1_500,
      // The parked case delays the host's next step by 100ms on purpose.
      backgroundParkedGraceMs: 1_000,
    },
  )
  const dispatchAdapter = new AcpLlmAdapter(dispatchManager)

  afterAll(async () => {
    await dispatchManager.shutdownAll()
  })

  function dispatchText(chunks: StreamChunk[]): string {
    return chunks
      .filter((chunk): chunk is Extract<StreamChunk, { type: 'text-delta' }> => chunk.type === 'text-delta')
      .map(chunk => chunk.text)
      .join('')
  }

  function dispatchFinish(chunks: StreamChunk[]): Extract<StreamChunk, { type: 'finish' }> | undefined {
    return chunks.find((chunk): chunk is Extract<StreamChunk, { type: 'finish' }> => chunk.type === 'finish')
  }

  /**
   * Wait until the turn is HOLDING: the prompt response landed (the agent-side
   * slot is free) while the driver step is still open and the controller has
   * not settled. The state has no event of its own, so this polls like
   * `waitForAmbient` does.
   */
  async function waitForHold(dshSessionId: string): Promise<NonNullable<ReturnType<BridgeManager['turnStreamFor']>>> {
    const deadline = Date.now() + 10_000
    for (;;) {
      const live = dispatchManager.turnStreamFor(dshSessionId)
      if (live !== undefined && !live.hasSettled && live.hasOpenSegment && live.session.settled === undefined) return live
      if (Date.now() > deadline) throw new Error('the turn never entered a detached-worker hold')
      await new Promise(resolve => setTimeout(resolve, 5))
    }
  }

  const DEFERRAL_REPORT = 'deferred this turn to a background task run'
  const ZERO_OUTPUT_REPORT = 'ended the turn with no visible output'

  it('keeps the turn open for the worker, then folds only the drain\'s answer', async () => {
    const dshSessionId = 'dsh-dispatch-main'
    const since = dispatchEvents.length
    const { chunks, steps } = await hostLoopTurn(dispatchAdapter, {
      provider: 'acp',
      model: 'dispatch',
      sessionId: dshSessionId,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'DISPATCH please' }] }],
    })
    const text = dispatchText(chunks)

    // The coordinator's own words AND the drain's final answer reached the
    // main plane — the second one only exists because the turn stayed open
    // past the prompt response (it lands ~200ms later in this mock, and the
    // host loop closed step 1 long before it).
    expect(text).toContain('DISPATCH-ACK')
    expect(text).toContain('DISPATCH-FINAL-ANSWER')
    // The worker's own turn never does: its prose stays in the transcript.
    expect(text).not.toContain('WORKER-THOUGHT')
    expect(text).not.toContain('WORKER-INTERNAL-TEXT')
    expect(text).not.toContain('WORKER-REPORT-TEXT')
    // A held turn that delivered text is not a deferred or failed one.
    expect(text).not.toContain(DEFERRAL_REPORT)
    expect(text).not.toContain(ZERO_OUTPUT_REPORT)

    // Two driver steps: the Agent card in step 1, then the held step whose
    // single finish arrives only after the drain's answer. The cutting ACK
    // belongs to the NEXT message, so it opens step 2 (by design).
    expect(steps).toHaveLength(2)
    expect(steps[0].filter(chunk => chunk.type === 'text-delta')).toHaveLength(0)
    expect(dispatchText(steps[1])).toContain('DISPATCH-ACK')
    expect(steps[1].filter(chunk => chunk.type === 'finish')).toHaveLength(1)
    expect(dispatchFinish(steps[1])?.reason).toEqual({ kind: 'stop' })
    expect(dispatchText(steps[1])).toContain('DISPATCH-FINAL-ANSWER')

    // Exactly one card on the plane — the coordinator's Agent call. The
    // worker's Bash and the drain's TaskOutput never open one (a card would
    // make the host execute a background tool and continue the turn).
    const callIds = new Set(chunks
      .filter((chunk): chunk is Extract<StreamChunk, { type: 'tool-call-delta' }> => chunk.type === 'tool-call-delta')
      .map(chunk => chunk.id))
    expect(callIds).toEqual(new Set(['agent_dispatch']))

    // One `turn/end`, and it is the LAST thing the turn says: every answer
    // delta — including the final one — precedes it.
    const acpSessionId = dispatchManager.chatSessions(dshSessionId)[0]?.sessionId
    expect(acpSessionId).toBeDefined()
    const frames = dispatchEvents.slice(since).filter(event =>
      event.type === 'turn/end' && event.sessionId === acpSessionId)
    expect(frames).toHaveLength(1)
    expect(frames[0]).toMatchObject({ stopReason: 'end_turn' })
    const significant = dispatchEvents
      .slice(since)
      .filter(event => event.sessionId === acpSessionId)
      .map((event, index) => ({ event, index }))
      .filter(({ event }) => event.type === 'turn/end'
        || (event.type === 'session/update'
          && event.update.sessionUpdate === 'agent_message_chunk'
          && String((event.update.content as { text?: string }).text ?? '').includes('DISPATCH-FINAL-ANSWER')))
    expect(significant).toHaveLength(2)
    expect(significant[0].event.type).toBe('session/update')
    expect(significant[1].event.type).toBe('turn/end')

    // Nothing was lost: the worker's own turn and the drain's TaskOutput are
    // in the transcript the ACP view reads.
    const transcript = await dispatchRpc(dispatchManager, 'transcript/get', { sessionId: acpSessionId! })
    if (!transcript.ok) throw new Error('transcript failed')
    const entries = (transcript.value as { entries: Array<{ update: Record<string, unknown> }> }).entries
      .map(entry => entry.update)
    expect(entries.some(update => update.toolCallId === 'worker_bash' && update.sessionUpdate === 'tool_call')).toBe(true)
    expect(entries.some(update => update.toolCallId === 'drain_task_output' && update.status === 'completed')).toBe(true)
    expect(entries.some(update => update.toolCallId === 'agent_dispatch' && update.status === 'completed')).toBe(true)
  }, 30_000)

  it('reports the detached worker to the host subagent catalog once', async () => {
    const dshSessionId = 'dsh-dispatch-catalog'
    const since = dispatchEvents.length
    const calls: Array<{ dshSessionId: string; childId: string; label: string }> = []
    dispatchManager.setSubagentCatalogReporter((reportedSessionId, childId, label) => {
      calls.push({ dshSessionId: reportedSessionId, childId, label })
    })
    try {
      await hostLoopTurn(dispatchAdapter, {
        provider: 'acp',
        model: 'dispatch',
        sessionId: dshSessionId,
        messages: [{ role: 'user', content: [{ type: 'text', text: 'DISPATCH please' }] }],
      })
      // The caller's own name wins over the task description: it is the
      // identity the coordinator used when it told the user what it sent.
      expect(calls).toEqual([{
        dshSessionId,
        childId: 'acp:agent_dispatch',
        label: 'general-purpose · explorer',
      }])

      // The row's live status rides its own frames: the host's external rows
      // have no Session, so nothing else can tell the browser the worker runs.
      // Exactly one `running: true` when the row is reported, then exactly one
      // `running: false` once the call completed / the turn closed.
      const activity = dispatchEvents
        .slice(since)
        .filter((event): event is Extract<AcpEvent, { type: 'subagents/update' }> =>
          event.type === 'subagents/update' && event.childId === 'acp:agent_dispatch')
      expect(activity.map(event => event.running)).toEqual([true, false])
      expect(activity.every(event => event.dshSessionId === dshSessionId)).toBe(true)
    } finally {
      dispatchManager.setSubagentCatalogReporter(undefined)
    }
  }, 30_000)

  it('never lights a row whose detached signal and completion share one frame', async () => {
    const dshSessionId = 'dsh-dispatch-completed-meta'
    const since = dispatchEvents.length
    const calls: Array<{ dshSessionId: string; childId: string; label: string }> = []
    dispatchManager.setSubagentCatalogReporter((reportedSessionId, childId, label) => {
      calls.push({ dshSessionId: reportedSessionId, childId, label })
    })
    try {
      await hostLoopTurn(dispatchAdapter, {
        provider: 'acp',
        model: 'dispatch',
        sessionId: dshSessionId,
        messages: [{ role: 'user', content: [{ type: 'text', text: 'DISPATCH DISPATCHCOMPLETEMETA' }] }],
      })
      // The catalog fact is still recorded (the row exists), but its work is
      // over: no `running: true` may ever be sent for it, so there is no
      // `[true, false]` flicker in the host's dot either. (The label itself is
      // not the subject here: this synthetic frame carries no rawInput, so the
      // refresh may only know the role.)
      expect(calls).toHaveLength(1)
      expect(calls[0]).toMatchObject({ dshSessionId, childId: 'acp:agent_dispatch' })
      const activity = dispatchEvents
        .slice(since)
        .filter((event): event is Extract<AcpEvent, { type: 'subagents/update' }> =>
          event.type === 'subagents/update' && event.childId === 'acp:agent_dispatch')
      expect(activity).toEqual([])
    } finally {
      dispatchManager.setSubagentCatalogReporter(undefined)
    }
  }, 30_000)

  it('waits for the dispatch identity meta before it reports the catalog row', async () => {
    const dshSessionId = 'dsh-dispatch-catalog-meta'
    const calls: Array<{ dshSessionId: string; childId: string; label: string }> = []
    dispatchManager.setSubagentCatalogReporter((reportedSessionId, childId, label) => {
      calls.push({ dshSessionId: reportedSessionId, childId, label })
    })
    try {
      await hostLoopTurn(dispatchAdapter, {
        provider: 'acp',
        model: 'dispatch',
        sessionId: dshSessionId,
        messages: [{ role: 'user', content: [{ type: 'text', text: 'DISPATCHMETA please' }] }],
      })
      // The worker was alive before the identity frame, but a bare
      // "Agent · 外部任务" row would say nothing: exactly one report, carrying
      // the role and task line from `_meta`, never the tool name.
      expect(calls).toEqual([{
        dshSessionId,
        childId: 'acp:agent_dispatch',
        label: 'general-purpose · audit the repo',
      }])
    } finally {
      dispatchManager.setSubagentCatalogReporter(undefined)
    }
  }, 30_000)

  it('keeps holding while the worker keeps reporting, past the silence window', async () => {
    const dshSessionId = 'dsh-dispatch-keepalive'
    const started = Date.now()
    const { chunks } = await hostLoopTurn(dispatchAdapter, {
      provider: 'acp',
      model: 'dispatch',
      sessionId: dshSessionId,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'DISPATCHKEEPALIVE please' }] }],
    })
    const text = dispatchText(chunks)

    // The worker phase outlived `backgroundTaskMaxMs` (1.5s here) purely on
    // worker updates. A fixed total-runtime cap would have closed the turn with
    // the deferral line and lost the drain's answer.
    expect(Date.now() - started).toBeGreaterThan(1_600)
    expect(text).toContain('DISPATCH-FINAL-ANSWER')
    expect(text).not.toContain(DEFERRAL_REPORT)
    expect(text).not.toContain(ZERO_OUTPUT_REPORT)
  }, 30_000)

  it('closes a worker that never reports after the worker-phase silence window', async () => {
    const dshSessionId = 'dsh-dispatch-nodrain'
    const since = dispatchEvents.length
    const { chunks } = await hostLoopTurn(dispatchAdapter, {
      provider: 'acp',
      model: 'dispatch',
      sessionId: dshSessionId,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'DISPATCHNODRAIN please' }] }],
    })
    const text = dispatchText(chunks)

    // Nothing pushed the worker-phase silence window out, so it ended the
    // turn — and it says where the rest of the output will land instead of
    // blaming silence.
    expect(text).toContain(DEFERRAL_REPORT)
    expect(text).not.toContain(ZERO_OUTPUT_REPORT)
    expect(dispatchFinish(chunks)?.reason).toEqual({ kind: 'stop' })

    const acpSessionId = dispatchManager.chatSessions(dshSessionId)[0]?.sessionId
    expect(acpSessionId).toBeDefined()
    const frames = dispatchEvents.slice(since).filter(event =>
      event.type === 'turn/end' && event.sessionId === acpSessionId)
    expect(frames).toHaveLength(1)
    expect(frames[0]).toMatchObject({ stopReason: 'end_turn' })
  }, 30_000)

  it('ends a holding turn once when the user cancels it', async () => {
    const dshSessionId = 'dsh-dispatch-cancel'
    const since = dispatchEvents.length
    const abort = new AbortController()
    const running = hostLoopTurn(dispatchAdapter, {
      provider: 'acp',
      model: 'dispatch',
      sessionId: dshSessionId,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'DISPATCHSLOW please' }] }],
    }, 8, abort.signal)
    const holding = await waitForHold(dshSessionId)
    const sessionId = holding.session.sessionId
    const turnId = holding.turnId

    abort.abort()
    const { chunks, steps } = await Promise.race([
      running,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('the holding step never closed')), 5_000)),
    ])

    expect(dispatchFinish(steps.at(-1) ?? [])?.reason).toMatchObject({ kind: 'aborted' })
    const frames = dispatchEvents.slice(since).filter(event => event.type === 'turn/end' && event.sessionId === sessionId)
    expect(frames).toHaveLength(1)
    expect(frames[0]).toMatchObject({ turnId, stopReason: 'cancelled' })
    expect(holding.session.running).toBe(false)
    // The cancel happened before the drain existed: its answer never reached
    // this stream (and the retired id keeps it out of the next one).
    expect(dispatchText(chunks)).not.toContain('DISPATCH-FINAL-ANSWER')
  }, 30_000)

  it('accepts the next prompt while holding, and never folds that hold\'s drain into it', async () => {
    const dshSessionId = 'dsh-dispatch-successor'
    const since = dispatchEvents.length
    const first = hostLoopTurn(dispatchAdapter, {
      provider: 'acp',
      model: 'dispatch',
      sessionId: dshSessionId,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'DISPATCHSLOW please' }] }],
    })
    const holding = await waitForHold(dshSessionId)

    // The user sends again while the worker still runs. The claim is gated on
    // the HOST's prompt slot (released with the response), not on `running`.
    // The second turn is still streaming when the first hold's drain speaks,
    // so the drain text lands while this turn is on air.
    const second = await hostLoopTurn(dispatchAdapter, {
      provider: 'acp',
      model: 'dispatch',
      sessionId: dshSessionId,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'HANG_DELAY:1400 second please' }] }],
    })
    expect(dispatchFinish(second.steps.at(-1) ?? [])?.reason).toEqual({ kind: 'stop' })
    const secondText = dispatchText(second.chunks)
    expect(secondText).toContain('MOCK: echo HANG_DELAY:1400 second please perm=none')
    // The abandoned hold's drain and worker text are not this turn's answer.
    expect(secondText).not.toContain('DISPATCH-FINAL-ANSWER')
    expect(secondText).not.toContain('WORKER-REPORT-TEXT')

    // The superseded holding step ended when the new turn took the controller.
    const firstResult = await Promise.race([
      first,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('the holding step is still parked on its queue')), 5_000)),
    ])
    expect(dispatchFinish(firstResult.steps.at(-1) ?? [])?.reason).toMatchObject({ kind: 'aborted' })
    expect(dispatchText(firstResult.chunks)).not.toContain('DISPATCH-FINAL-ANSWER')

    // Nothing gave the conversation back: the session and its transcript live.
    expect(holding.session.closed).toBe(false)
    expect(dispatchManager.chatSessions(dshSessionId)).toHaveLength(1)
    expect(dispatchEvents.slice(since).some(event =>
      event.type === 'chat/agent-unlocked' && event.dshSessionId === dshSessionId)).toBe(false)
  }, 30_000)

  /**
   * The coordinator's "已派…" ack is the PARENT's interim text, not the held
   * run's answer: a hold that never receives the drained answer must still say
   * where the output will appear. Counting `sawVisibleText` here (the ack
   * already set it) would silently leave the bubble without that line.
   */
  it('reports the deferral after the parent acked but the worker never reported', async () => {
    const dshSessionId = 'dsh-dispatch-acknodrain'
    const since = dispatchEvents.length
    const { chunks } = await hostLoopTurn(dispatchAdapter, {
      provider: 'acp',
      model: 'dispatch',
      sessionId: dshSessionId,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'DISPATCHACKNODRAIN please' }] }],
    })
    const text = dispatchText(chunks)
    expect(text).toContain('DISPATCH-ACK')
    expect(text).toContain(DEFERRAL_REPORT)
    expect(text).not.toContain(ZERO_OUTPUT_REPORT)
    expect(dispatchFinish(chunks)?.reason).toEqual({ kind: 'stop' })

    const acpSessionId = dispatchManager.chatSessions(dshSessionId)[0]?.sessionId
    expect(acpSessionId).toBeDefined()
    const frames = dispatchEvents.slice(since).filter(event =>
      event.type === 'turn/end' && event.sessionId === acpSessionId)
    expect(frames).toHaveLength(1)
  }, 30_000)

  /**
   * A detached worker thinks for tens of seconds between model calls and may
   * be silent longer than the ambient quiet window. The WORKER phase has no
   * quiet clock at all, so the turn must still be holding when the report and
   * the drain's answer arrive.
   */
  it('survives a worker silence longer than the drain quiet window', async () => {
    const dshSessionId = 'dsh-dispatch-silent'
    const { chunks } = await hostLoopTurn(dispatchAdapter, {
      provider: 'acp',
      model: 'dispatch',
      sessionId: dshSessionId,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'DISPATCHSILENT please' }] }],
    })
    const text = dispatchText(chunks)
    // The quiet window here is 250ms; the worker says nothing for 600ms.
    expect(text).toContain('DISPATCH-ACK')
    expect(text).toContain('DISPATCH-FINAL-ANSWER')
    expect(text).not.toContain(DEFERRAL_REPORT)
    expect(text).not.toContain('WORKER-REPORT-TEXT')
  }, 30_000)

  /**
   * Two `Agent` calls, both running when the drain announces itself. The
   * announcement must not arm the drain's quiet clock while a dispatch is
   * still incomplete, and the first worker's report must not close the turn:
   * the second worker's report and the final answer belong to the same turn.
   */
  it('waits for every dispatch: an early announcement and the first report do not close the turn', async () => {
    const dshSessionId = 'dsh-dispatch-two'
    const since = dispatchEvents.length
    const { chunks } = await hostLoopTurn(dispatchAdapter, {
      provider: 'acp',
      model: 'dispatch',
      sessionId: dshSessionId,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'DISPATCHTWO please' }] }],
    })
    const text = dispatchText(chunks)
    expect(text).toContain('DISPATCH-TWO-A-DONE')
    expect(text).toContain('DISPATCH-TWO-B-DONE')
    expect(text).toContain('DISPATCH-TWO-FINAL')
    expect(text).not.toContain(DEFERRAL_REPORT)
    // The worker's own words stay transcript-only.
    expect(text).not.toContain('WORKER-REPORT-TEXT')

    const acpSessionId = dispatchManager.chatSessions(dshSessionId)[0]?.sessionId
    expect(acpSessionId).toBeDefined()
    // Exactly one `turn/end`, and it follows BOTH reports and the answer.
    const relevant = dispatchEvents.slice(since).map((event, index) => ({ event, index })).filter(({ event }) => {
      if (event.type === 'turn/end') return event.sessionId === acpSessionId
      return event.type === 'session/update'
        && event.sessionId === acpSessionId
        && event.update.sessionUpdate === 'agent_message_chunk'
        && ['DISPATCH-TWO-A-DONE', 'DISPATCH-TWO-B-DONE', 'DISPATCH-TWO-FINAL']
          .some(marker => String((event.update.content as { text?: string }).text ?? '').includes(marker))
    })
    expect(relevant).toHaveLength(4)
    expect(relevant.at(-1)?.event.type).toBe('turn/end')
    expect(relevant.filter(({ event }) => event.type === 'turn/end')).toHaveLength(1)

    // Both Agent cards were on the plane; the second dispatch did not wait for
    // the first one's hold to end.
    const callIds = new Set(chunks
      .filter((chunk): chunk is Extract<StreamChunk, { type: 'tool-call-delta' }> => chunk.type === 'tool-call-delta')
      .map(chunk => chunk.id))
    expect(callIds).toEqual(new Set(['agent_dispatch', 'agent_dispatch_two']))
  }, 30_000)

  /**
   * The drain may announce itself BEFORE the prompt response, under an id the
   * response does not name. Both ids belong to this turn: requiring them to
   * match would drop the announced run's answer.
   */
  it('folds a drain announced under another id before the response', async () => {
    const dshSessionId = 'dsh-dispatch-altfirst'
    const { chunks } = await hostLoopTurn(dispatchAdapter, {
      provider: 'acp',
      model: 'dispatch',
      sessionId: dshSessionId,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'DISPATCHALTFIRST please' }] }],
    })
    const text = dispatchText(chunks)
    expect(text).toContain('DISPATCH-ACK')
    expect(text).toContain('DISPATCH-ALT-ANSWER')
    expect(text).not.toContain(DEFERRAL_REPORT)
    expect(text).not.toContain(ZERO_OUTPUT_REPORT)

    // The announced run's steps are in the transcript under its own id.
    const acpSessionId = dispatchManager.chatSessions(dshSessionId)[0]?.sessionId
    const transcript = await dispatchRpc(dispatchManager, 'transcript/get', { sessionId: acpSessionId! })
    if (!transcript.ok) throw new Error('transcript failed')
    const entries = (transcript.value as { entries: Array<{ update: Record<string, unknown> }> }).entries
      .map(entry => entry.update)
    expect(entries.some(update => update.toolCallId === 'drain_task_output')).toBe(true)
  }, 30_000)

  /**
   * A fast worker reports and completes BEFORE the prompt response. The
   * dispatch is completed, but it was structurally detached (`isBackground`,
   * worker updates), so the drain that carries its report is still coming:
   * the response must not close the turn.
   */
  it('holds for a worker that reported before the response', async () => {
    const dshSessionId = 'dsh-dispatch-fast'
    const { chunks } = await hostLoopTurn(dispatchAdapter, {
      provider: 'acp',
      model: 'dispatch',
      sessionId: dshSessionId,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'DISPATCHFAST please' }] }],
    })
    const text = dispatchText(chunks)
    expect(text).toContain('DISPATCH-ACK')
    expect(text).toContain('DISPATCH-FINAL-ANSWER')
    expect(text).not.toContain(DEFERRAL_REPORT)
    expect(text).not.toContain('WORKER-REPORT-TEXT')
  }, 30_000)

  /**
   * The real dispatch COMPLETION frame carries no `_meta` at all. Reading it
   * by id is what starts the drain phase; waiting for the CodeBuddy shape (or
   * for the announcement) would leave the turn in the worker phase until its
   * ten-minute ceiling, and the announcement here is delayed past the drain's
   * quiet window on purpose — the turn must close on the DRAIN's clock, not
   * the worker's cap, and the parent's ack must not suppress the deferral.
   */
  it('starts the drain phase from a completion frame that carries no _meta', async () => {
    const dshSessionId = 'dsh-dispatch-latedrain'
    const since = dispatchEvents.length
    const { chunks } = await hostLoopTurn(dispatchAdapter, {
      provider: 'acp',
      model: 'dispatch',
      sessionId: dshSessionId,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'DISPATCHLATEDRAIN please' }] }],
    })
    const text = dispatchText(chunks)
    expect(text).toContain('DISPATCH-ACK')
    // No drained answer text reached this turn: the deferral line must show.
    expect(text).toContain(DEFERRAL_REPORT)
    expect(text).not.toContain(ZERO_OUTPUT_REPORT)
    // The delayed answer landed after the turn was over (the drain's quiet
    // window closed it), so it stays in the transcript.
    expect(text).not.toContain('DISPATCH-LATE-ANSWER')

    const acpSessionId = dispatchManager.chatSessions(dshSessionId)[0]?.sessionId
    expect(acpSessionId).toBeDefined()
    // The mock keeps streaming after the turn closed; give the delayed answer
    // time to reach the transcript before ordering the two facts.
    const answerDeadline = Date.now() + 5_000
    while (!dispatchEvents.slice(since).some(event =>
      event.type === 'session/update'
      && event.sessionId === acpSessionId
      && event.update.sessionUpdate === 'agent_message_chunk'
      && String((event.update.content as { text?: string }).text ?? '').includes('DISPATCH-LATE-ANSWER'))) {
      if (Date.now() > answerDeadline) throw new Error('the delayed drain answer never reached the transcript')
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    const ordered = dispatchEvents.slice(since).map((event, index) => ({ event, index })).filter(({ event }) => {
      if (event.type === 'turn/end') return event.sessionId === acpSessionId
      return event.type === 'session/update'
        && event.sessionId === acpSessionId
        && event.update.sessionUpdate === 'agent_message_chunk'
        && String((event.update.content as { text?: string }).text ?? '').includes('DISPATCH-LATE-ANSWER')
    })
    expect(ordered).toHaveLength(2)
    expect(ordered[0].event.type).toBe('turn/end')
  }, 30_000)

  /**
   * The response can land BETWEEN driver steps (the ack cut the first one and
   * the host is executing the Agent card). The hold is parked for the next
   * step; when the host opens it late, the drained answer must still fold —
   * and the parked grace, not a quiet clock, owns that wait.
   */
  it('adopts a parked hold when the host opens its step late', async () => {
    const dshSessionId = 'dsh-dispatch-parked'
    const running = hostLoopTurn(dispatchAdapter, {
      provider: 'acp',
      model: 'dispatch',
      sessionId: dshSessionId,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'DISPATCHPARKED please' }] }],
    }, 8, undefined, 300)

    // The parked state: the response landed (host slot free) with no driver
    // step open and the turn not settled.
    const deadline = Date.now() + 10_000
    let parked = false
    while (!parked) {
      const live = dispatchManager.turnStreamFor(dshSessionId)
      parked = live !== undefined && !live.hasSettled && !live.hasOpenSegment && live.session.settled === undefined
      if (!parked) {
        if (Date.now() > deadline) throw new Error('the hold never parked between steps')
        await new Promise(resolve => setTimeout(resolve, 5))
      }
    }

    const { chunks } = await running
    const text = dispatchText(chunks)
    expect(text).toContain('DISPATCH-ACK')
    expect(text).toContain('DISPATCH-FINAL-ANSWER')
    expect(text).not.toContain(DEFERRAL_REPORT)
    expect(text).not.toContain('WORKER-REPORT-TEXT')
  }, 30_000)
})

/**
 * The `/acp` RPC prompt and the chat adapter drive the SAME agent session: one
 * `session/prompt` at a time is a protocol rule, whichever face sent it. The
 * RPC path must therefore claim the chat path's slot (`promptInFlight` + the
 * settle gate), and each face must refuse while the other is in flight.
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
 * The ambient ceiling is a DIFFERENT ending from a quiet drain: it announces
 * that the rest of the output will land elsewhere. That notice must stand
 * alone — the quiet ending's deferred report would only repeat it, and a
 * no-text drain would otherwise receive both.
 */
describe('the ambient hard ceiling (isolated manager)', () => {
  const hardWorkspace = `${tmpdir()}/dsh-ntr-drain-hard-workspace`
  mkdirSync(hardWorkspace, { recursive: true })
  const hardHub = new EventHub()
  const hardEvents: AcpEvent[] = []
  hardHub.subscribe(event => { hardEvents.push(event) })
  const hardManager = new BridgeManager(
    [{ ...def, id: 'drainhard', cwd: hardWorkspace, allowedCwdRoots: [hardWorkspace] }],
    hardHub,
    500,
    undefined,
    undefined,
    false,
    {
      startupTimeoutMs: 3_000,
      cancelFallbackMs: 300,
      // The ceiling beats the quiet window: this case is about what the hard
      // close SAYS, not about which timer normally closes a drain.
      ambientQuietMs: 60_000,
      ambientMaxMs: 150,
    },
  )
  const hardAdapter = new AcpLlmAdapter(hardManager)

  afterAll(async () => {
    await hardManager.shutdownAll()
  })

  async function hardTurn(dshSessionId: string, text: string): Promise<StreamChunk[]> {
    const chunks: StreamChunk[] = []
    for await (const chunk of hardAdapter.stream({
      provider: 'acp',
      model: 'drainhard',
      sessionId: dshSessionId,
      messages: [{ role: 'user', content: [{ type: 'text', text }] }],
    })) {
      chunks.push(chunk)
    }
    return chunks
  }

  function hardTextOf(chunks: StreamChunk[]): string {
    return chunks
      .filter((chunk): chunk is Extract<StreamChunk, { type: 'text-delta' }> => chunk.type === 'text-delta')
      .map(chunk => chunk.text)
      .join('')
  }

  it('closes with the hard notice only, never stacking the deferred line', async () => {
    const chunks: StreamChunk[] = []
    for await (const chunk of hardAdapter.stream({
      provider: 'acp',
      model: 'drainhard',
      sessionId: 'dsh-drain-hard',
      // Tool-only drain: no answer text, so the quiet ending's deferred line
      // WOULD fire — the case that used to stack it under the hard notice.
      messages: [{ role: 'user', content: [{ type: 'text', text: 'STEERTOOL please' }] }],
    })) {
      chunks.push(chunk)
    }
    const text = hardTextOf(chunks)

    expect(text.match(/is still running a background task/g)).toHaveLength(1)
    expect(text).not.toContain('deferred this turn to a background task run')
    expect(chunks.find((chunk): chunk is Extract<StreamChunk, { type: 'finish' }> => chunk.type === 'finish')?.reason)
      .toEqual({ kind: 'stop' })
  }, 30_000)

  it('keeps the drain record after a hard close so the next folded prompt still gets the drain text', async () => {
    const dshSessionId = 'dsh-drain-hard-retained'
    const since = hardEvents.length

    // Turn 1: a drain announces itself, the prompt is answered instantly and
    // the drain then says NOTHING before the ceiling. The hard ending is
    // evidence the drain is still running, so the session must keep its
    // record — closing it here used to make the next folded prompt look like
    // an ordinary silent turn.
    const first = await hardTurn(dshSessionId, 'STEERHARD please')
    expect(hardTextOf(first)).toContain('is still running a background task')

    // Turn 2 is folded into the SAME drain: instant answer with no
    // conversation id, and its text lands 60ms later (after the response
    // would have closed the turn, before the next ceiling). With the record
    // kept, the turn is treated as steered and the text reaches the user.
    const second = await hardTurn(dshSessionId, 'HARDTAIL please')
    const text = hardTextOf(second)
    expect(text).toContain('HARD-TAIL-TEXT')
    expect(text).not.toContain('ended the turn with no visible output')
    expect(second.find((chunk): chunk is Extract<StreamChunk, { type: 'finish' }> => chunk.type === 'finish')?.reason)
      .toEqual({ kind: 'stop' })

    // One run, one notice: the de-dupe set survives the hard close, so the
    // re-announcement during turn 2 does not log the same drain twice.
    const notices = hardEvents
      .slice(since)
      .filter(event => event.type === 'agent/notice' && event.text.startsWith('acp: agent "drainhard" started a background task turn'))
    expect(notices).toHaveLength(1)
  }, 30_000)
})
