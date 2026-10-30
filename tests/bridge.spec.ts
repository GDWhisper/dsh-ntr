/**
 * End-to-end over a real child process: the scripted mock ACP agent driven by
 * the production BridgeManager + dispatchRpc (the same face the browser uses).
 */

import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { afterAll, describe, expect, it } from 'vitest'
import {
  AcpLlmAdapter, AgentBridge, BridgeManager, defaultAgentWorkspace,
  detectHostAgents, ensureAgentExecutable, findExecutable, killProcessTree, pluginStateDir, routeBindingRegistry, windowsShimLaunch,
  type BridgeTuning,
  permissionAskReason, permissionToolName,
} from '../src/bridge.ts'
import { EventHub, dispatchRpc, permissionReplayFrames } from '../src/impl.ts'
import type { AcpAgentCatalog, AcpAgentDef, AcpEvent, AgentCatalogResult, ChatSessionView, ChatTranscriptView, StreamChunk } from '../src/protocol.ts'

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
): Promise<{ chunks: StreamChunk[]; steps: StreamChunk[][] }> {
  const steps: StreamChunk[][] = []
  let messages = request.messages ?? []
  for (let step = 0; step < maxSteps; step += 1) {
    const chunks: StreamChunk[] = []
    for await (const chunk of adapter.stream({ ...request, messages })) chunks.push(chunk)
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
    const first = drain('IGNORE_CANCEL please', controller.signal)
    await new Promise(resolve => setTimeout(resolve, 400))
    controller.abort()
    const firstChunks = await first
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
