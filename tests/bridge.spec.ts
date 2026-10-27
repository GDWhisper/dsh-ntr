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
  type ApprovalOutcome, type ApprovalRequestContext, type BridgeTuning,
  permissionToolName,
} from '../src/bridge.ts'
import { EventHub, dispatchRpc } from '../src/impl.ts'
import type { AcpAgentCatalog, AcpAgentDef, AcpEvent, AgentCatalogResult, ChatSessionView, StreamChunk } from '../src/protocol.ts'

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

    // Usage and finish
    const usage = chunks.find((c): c is Extract<StreamChunk, { type: 'usage' }> => c.type === 'usage')
    expect(usage?.usage).toEqual({ inputTokens: 1000, outputTokens: 123 })

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
    { startupTimeoutMs: 2_500, permissionTimeoutMs: 700, cancelFallbackMs: 400 },
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

describe('native approval routing (isolated manager)', () => {
  const approvalHub = new EventHub()
  const approvalEvents: AcpEvent[] = []
  approvalHub.subscribe(event => { approvalEvents.push(event) })
  const approvalManager = new BridgeManager([{ ...def, id: 'appr' }], approvalHub, 500)
  const approvalAdapter = new AcpLlmAdapter(approvalManager)
  const calls: ApprovalRequestContext[] = []
  let scripted: ApprovalOutcome | 'throw' = 'unavailable'

  approvalManager.setApprovalRequester(request => {
    calls.push(request)
    if (scripted === 'throw') throw new Error('approval service exploded')
    return Promise.resolve(scripted)
  })

  afterAll(async () => {
    await approvalManager.shutdownAll()
  })

  /**
   * Wait for a fresh event. `since` is mandatory: the hub keeps every event
   * from earlier cases, so an unscoped predicate would match a stale one.
   */
  function apprWaitFor<T extends AcpEvent['type']>(type: T, since: number, predicate: (event: Extract<AcpEvent, { type: T }>) => boolean, timeoutMs = 15_000): Promise<Extract<AcpEvent, { type: T }>> {
    const matches = (event: AcpEvent): event is Extract<AcpEvent, { type: T }> =>
      event.type === type && predicate(event as Extract<AcpEvent, { type: T }>)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout waiting for ${type}`)), timeoutMs)
      const unsub = approvalHub.subscribe(event => {
        if (approvalEvents.indexOf(event) >= since && matches(event)) {
          clearTimeout(timer)
          unsub()
          resolve(event)
        }
      })
      const existing = approvalEvents.find((event, index) => index >= since && matches(event))
      if (existing !== undefined) {
        clearTimeout(timer)
        unsub()
        resolve(existing)
      }
    })
  }

  /**
   * Drain one adapter turn (the only path that binds a DSH chat session id) —
   * the WHOLE turn, continuing through the staged-result steps the host loop
   * would propose for its cards, so awaiting it means the turn really settled.
   */
  async function adapterTurn(sessionId: string, text: string): Promise<StreamChunk[]> {
    const { chunks } = await hostLoopTurn(approvalAdapter, {
      provider: 'acp',
      model: 'appr',
      sessionId,
      messages: [{ role: 'user', content: [{ type: 'text', text }] }],
    })
    return chunks
  }

  async function echoOf(sessionId: string, text: string): Promise<string> {
    const transcript = await dispatchRpc(approvalManager, 'transcript/get', { sessionId })
    if (!transcript.ok) throw new Error('transcript failed')
    return (transcript.value as { entries: Array<{ update: Record<string, unknown> }> }).entries
      .filter(e => e.update.sessionUpdate === 'agent_message_chunk')
      .map(e => String((e.update.content as { text?: string }).text ?? ''))
      .join('')
  }

  function hostSessionIdOf(sessionKey: string): string | undefined {
    const turn = approvalEvents.find(e => e.type === 'turn/start' && e.text === sessionKey)
    return turn?.sessionId
  }

  it('reports approvalRouting and answers an ask with the native outcome', async () => {
    expect(approvalManager.approvalRouting()).toBe(true)
    const before = approvalEvents.length

    scripted = 'allowed-once'
    await adapterTurn('dsh-approval-allow', 'PERM allow me')
    const sessionId = hostSessionIdOf('PERM allow me')
    expect(sessionId).toBeDefined()
    expect(await echoOf(sessionId!, 'PERM allow me')).toContain('perm=allow1')

    scripted = 'rejected'
    await adapterTurn('dsh-approval-reject', 'PERM deny me')
    const rejectSession = hostSessionIdOf('PERM deny me')
    expect(rejectSession).toBeDefined()
    expect(await echoOf(rejectSession!, 'PERM deny me')).toContain('perm=reject1')

    // The question travelled with the chat session identity and the tool name.
    expect(calls.at(-1)).toMatchObject({ dshSessionId: 'dsh-approval-reject', agentId: 'appr', toolName: 'mock dangerous operation' })

    // Routed asks never surface a settings-panel card: no `permission/request`
    // for this epoch, but the resolution frame still rides the stream.
    const fresh = approvalEvents.slice(before)
    expect(fresh.filter(e => e.type === 'permission/request')).toHaveLength(0)
    expect(fresh.filter(e => e.type === 'permission/resolved' && e.sessionId === rejectSession)).toHaveLength(1)
  }, 30_000)

  it('degrades to the panel ledger when the native answerer is unavailable', async () => {
    scripted = 'unavailable'
    // Drive through the adapter so the session IS chat-bound (a ledger fallback
    // must still work for a session the router could have handled).
    const since = approvalEvents.length
    const drained = adapterTurn('dsh-approval-degrade', 'PERM degrade please')
    const request = await apprWaitFor('permission/request', since, () => true)
    await dispatchRpc(approvalManager, 'permission/respond', { requestId: request.requestId, optionId: 'allow1' })
    await drained
    expect(await echoOf(request.sessionId, 'PERM degrade please')).toContain('perm=allow1')
  }, 30_000)

  it('never calls the requester for a session without a DSH chat id', async () => {
    const start = await dispatchRpc(approvalManager, 'session/start', { agentId: 'appr' })
    if (!start.ok) throw new Error('start failed')
    const id = (start.value as { sessionId: string }).sessionId
    const callsBefore = calls.length
    const since = approvalEvents.length

    await dispatchRpc(approvalManager, 'session/prompt', { sessionId: id, text: 'PERM rpc path' })
    const request = await apprWaitFor('permission/request', since, event => event.sessionId === id)
    expect(calls).toHaveLength(callsBefore)
    await dispatchRpc(approvalManager, 'permission/respond', { requestId: request.requestId, optionId: 'reject1' })
    await apprWaitFor('permission/resolved', since, event => event.requestId === request.requestId)
    await apprWaitFor('turn/end', since, event => event.sessionId === id && event.stopReason === 'end_turn')
    expect(await echoOf(id, 'PERM rpc path')).toContain('perm=reject1')
  }, 30_000)

  it('treats a throwing requester as unavailable instead of failing the turn', async () => {
    scripted = 'throw'
    const since = approvalEvents.length
    const drained = adapterTurn('dsh-approval-throw', 'PERM throw please')
    const request = await apprWaitFor('permission/request', since, () => true)
    await dispatchRpc(approvalManager, 'permission/respond', { requestId: request.requestId, optionId: 'allow1' })
    await drained
    expect(await echoOf(request.sessionId, 'PERM throw please')).toContain('perm=allow1')
  }, 30_000)
})

/**
 * The ledger fallback when the native approval chain is wired but DEGRADES.
 *
 * `approvalRouted` reports that the host HAS the approval service; it does not
 * promise every ask reaches the conversation. When the service answers
 * `unavailable` for one ask, the ask falls back to the settings-panel ledger
 * and two things must hold: the turn must not hang forever behind a question
 * the conversation never showed, and the line folded into the chat must name
 * the path the ask actually took instead of pointing at a composer prompt that
 * failed. The DESIGNED ledger paths (no approval service at all, a session
 * with no chat identity) keep waiting for the human — their answer entry is
 * the settings panel, which is where the chat line sends the user.
 */
describe('a degraded approval route still answers the turn (isolated manager)', () => {
  const degradeHub = new EventHub()
  const degradeEvents: AcpEvent[] = []
  degradeHub.subscribe(event => { degradeEvents.push(event) })
  // `permissionTimeoutMs` stays at its 0 default ("approvals belong to a
  // person"); only the degraded-route fallback is shortened so the case runs
  // in seconds instead of the production five minutes.
  const degradeManager = new BridgeManager([{ ...def, id: 'degrade' }], degradeHub, 500, undefined, undefined, true, { permissionFallbackTimeoutMs: 2_000 })
  const degradeAdapter = new AcpLlmAdapter(degradeManager)

  degradeManager.setApprovalRequester(() => Promise.resolve('unavailable'))

  afterAll(async () => {
    await degradeManager.shutdownAll()
  })

  function degradeWaitFor<T extends AcpEvent['type']>(type: T, since: number, predicate: (event: Extract<AcpEvent, { type: T }>) => boolean, timeoutMs = 15_000): Promise<Extract<AcpEvent, { type: T }>> {
    const matches = (event: AcpEvent): event is Extract<AcpEvent, { type: T }> =>
      event.type === type && predicate(event as Extract<AcpEvent, { type: T }>)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout waiting for ${type}`)), timeoutMs)
      const unsub = degradeHub.subscribe(event => {
        if (degradeEvents.indexOf(event) >= since && matches(event)) {
          clearTimeout(timer)
          unsub()
          resolve(event)
        }
      })
      const existing = degradeEvents.find((event, index) => index >= since && matches(event))
      if (existing !== undefined) {
        clearTimeout(timer)
        unsub()
        resolve(existing)
      }
    })
  }

  /** Drain one adapter turn, collecting the reasoning text it streamed. */
  async function degradeTurn(sessionId: string, text: string): Promise<{ reasoning: () => string; drained: Promise<void> }> {
    const parts: string[] = []
    const drained = (async () => {
      const { chunks } = await hostLoopTurn(degradeAdapter, {
        provider: 'acp',
        model: 'degrade',
        sessionId,
        messages: [{ role: 'user', content: [{ type: 'text', text }] }],
      })
      for (const chunk of chunks) {
        if (chunk.type === 'reasoning-delta') parts.push(chunk.text)
      }
    })()
    return { reasoning: () => parts.join(''), drained }
  }

  async function degradeEcho(sessionId: string): Promise<string> {
    const transcript = await dispatchRpc(degradeManager, 'transcript/get', { sessionId })
    if (!transcript.ok) throw new Error('transcript failed')
    return (transcript.value as { entries: Array<{ update: Record<string, unknown> }> }).entries
      .filter(e => e.update.sessionUpdate === 'agent_message_chunk')
      .map(e => String((e.update.content as { text?: string }).text ?? ''))
      .join('')
  }

  it('ends the turn instead of hanging when nobody answers the degraded ask', async () => {
    const since = degradeEvents.length
    const { drained } = await degradeTurn('dsh-degrade-hang', 'PERM degrade hang')
    const request = await degradeWaitFor('permission/request', since, () => true)

    // Nobody answers. The degraded-route deadline must answer `cancelled` on
    // the human's behalf — with the default `permissionTimeoutMs: 0` this is
    // the only thing keeping the turn from hanging forever.
    const notice = await degradeWaitFor('agent/notice', since, event => event.text.includes('timed out after 2s'))
    expect(notice.text).toContain('cancelled')
    await drained
    expect(await degradeEcho(request.sessionId)).toContain('perm=cancelled')
  }, 30_000)

  it('words the chat line by the path the ask took (degraded native route)', async () => {
    const since = degradeEvents.length
    const { reasoning, drained } = await degradeTurn('dsh-degrade-line', 'PERM degrade line')
    const request = await degradeWaitFor('permission/request', since, () => true)

    // A human CAN still answer in the settings panel; answering clears the
    // deadline, and the turn completes on that answer.
    await dispatchRpc(degradeManager, 'permission/respond', { requestId: request.requestId, optionId: 'allow1' })
    await drained
    // The composer prompt the user is waiting for failed, and the ask now
    // carries a deadline: the line has to say both.
    expect(reasoning()).toContain('the approval service is unavailable')
    expect(reasoning()).toContain('approve in Settings within 2s or this request is cancelled')
    expect(reasoning()).not.toContain('please approve in Settings')
    expect(await degradeEcho(request.sessionId)).toContain('perm=allow1')
  }, 30_000)
})

/**
 * The native approval route TAKING a question and never answering it.
 *
 * A routed ask has exactly one answer entry — the composer takeover — and no
 * broadcast at all, so a host that accepts the question and then never renders
 * it (the answerer sits outside the browser scope, the conversation is not
 * mounted, the client never received the remote event) hangs the turn behind
 * something invisible: no card, no chat line, no deadline. Reported as issue
 * #2: the ask is logged host-side and nothing ever answers it.
 *
 * The bridge bounds that state instead of trusting the host: past
 * `nativeApprovalTimeoutMs` the ask is WITHDRAWN (the signal handed to the host
 * aborts, settling its waterfall `cancelled` and dropping the composer panel)
 * and re-asked on the ledger, where the chat line and the settings card are
 * both visible. Withdrawing is not answering — the same question stays
 * answerable in Settings — and the ledger's degraded-route deadline still ends
 * the turn if nobody answers there either.
 */
describe('a native approval route that never answers still answers the turn (isolated manager)', () => {
  const silentHub = new EventHub()
  const silentEvents: AcpEvent[] = []
  silentHub.subscribe(event => { silentEvents.push(event) })
  const silentManager = new BridgeManager([{ ...def, id: 'silent' }], silentHub, 500, undefined, undefined, true, {
    nativeApprovalTimeoutMs: 1_200,
    permissionFallbackTimeoutMs: 2_000,
  })
  const silentAdapter = new AcpLlmAdapter(silentManager)
  /** Signals handed to the host approval chain, so a withdrawal is observable. */
  const hostAsks: { signal: AbortSignal | undefined }[] = []

  silentManager.setApprovalRequester(request => {
    hostAsks.push({ signal: request.signal })
    // A host that took the question and will never answer it.
    return new Promise<ApprovalOutcome>(() => { /* never settles */ })
  })

  afterAll(async () => {
    await silentManager.shutdownAll()
  })

  function silentWaitFor<T extends AcpEvent['type']>(type: T, since: number, predicate: (event: Extract<AcpEvent, { type: T }>) => boolean, timeoutMs = 15_000): Promise<Extract<AcpEvent, { type: T }>> {
    const matches = (event: AcpEvent): event is Extract<AcpEvent, { type: T }> =>
      event.type === type && predicate(event as Extract<AcpEvent, { type: T }>)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout waiting for ${type}`)), timeoutMs)
      const unsub = silentHub.subscribe(event => {
        if (silentEvents.indexOf(event) >= since && matches(event)) {
          clearTimeout(timer)
          unsub()
          resolve(event)
        }
      })
      const existing = silentEvents.find((event, index) => index >= since && matches(event))
      if (existing !== undefined) {
        clearTimeout(timer)
        unsub()
        resolve(existing)
      }
    })
  }

  /** Drain one adapter turn, collecting the reasoning text it streamed. */
  async function silentTurn(sessionId: string, text: string): Promise<{ reasoning: () => string; drained: Promise<void> }> {
    const parts: string[] = []
    const drained = (async () => {
      const { chunks } = await hostLoopTurn(silentAdapter, {
        provider: 'acp',
        model: 'silent',
        sessionId,
        messages: [{ role: 'user', content: [{ type: 'text', text }] }],
      })
      for (const chunk of chunks) {
        if (chunk.type === 'reasoning-delta') parts.push(chunk.text)
      }
    })()
    return { reasoning: () => parts.join(''), drained }
  }

  async function silentEcho(sessionId: string): Promise<string> {
    const transcript = await dispatchRpc(silentManager, 'transcript/get', { sessionId })
    if (!transcript.ok) throw new Error('transcript failed')
    return (transcript.value as { entries: Array<{ update: Record<string, unknown> }> }).entries
      .filter(e => e.update.sessionUpdate === 'agent_message_chunk')
      .map(e => String((e.update.content as { text?: string }).text ?? ''))
      .join('')
  }

  it('withdraws the ask from the host and re-asks it on the ledger', async () => {
    const since = silentEvents.length
    const { reasoning, drained } = await silentTurn('dsh-silent-withdraw', 'PERM silent withdraw')
    const request = await silentWaitFor('permission/request', since, () => true)

    // Exactly one host ask, and it was withdrawn: the signal the bridge handed
    // over aborted, which is what settles the host waterfall `cancelled` in
    // production and drops the composer panel.
    expect(hostAsks).toHaveLength(1)
    expect(hostAsks[0]?.signal?.aborted).toBe(true)

    // A human can still answer — in the settings panel now.
    await dispatchRpc(silentManager, 'permission/respond', { requestId: request.requestId, optionId: 'allow1' })
    await drained
    // The line must not claim the service is unavailable (it answered nothing,
    // which is not the same failure) and must name the deadline it now carries.
    // The cause stays an OBSERVED FACT — a slow human and a host that never
    // rendered the question look identical from here.
    expect(reasoning()).toContain('no answer in the conversation within 1s')
    expect(reasoning()).toContain('approve in Settings within 2s or this request is cancelled')
    expect(reasoning()).not.toContain('please approve in Settings')
    expect(await silentEcho(request.sessionId)).toContain('perm=allow1')
  }, 30_000)

  it('ends the turn instead of hanging when nobody answers the withdrawn ask', async () => {
    const since = silentEvents.length
    const { drained } = await silentTurn('dsh-silent-hang', 'PERM silent hang')
    const request = await silentWaitFor('permission/request', since, () => true)

    // Nobody answers anywhere. The degraded-route deadline answers `cancelled`
    // on the human's behalf — the only thing keeping the turn from hanging
    // forever behind a question the conversation never showed.
    const notice = await silentWaitFor('agent/notice', since, event => event.text.includes('timed out after 2s'))
    expect(notice.text).toContain('cancelled')
    await drained
    expect(await silentEcho(request.sessionId)).toContain('perm=cancelled')
  }, 30_000)

  it('lists the outstanding ledger asks for a reconnecting client', async () => {
    // The `permission/request` frame is broadcast ONCE. A client that connects
    // later — page reload, second tab, stream outage — would never learn this
    // ask exists, and for a ledger ask the settings card is the only answer
    // entry (OmniTerm closes the same hole by replaying
    // `pending_events()` on every WS connect). The manager must therefore be
    // able to name every outstanding ask with the view it was shown.
    const since = silentEvents.length
    const { drained } = await silentTurn('dsh-silent-replay', 'PERM silent replay')
    const request = await silentWaitFor('permission/request', since, () => true)

    const views = silentManager.pendingPermissionViews()
    expect(views).toHaveLength(1)
    expect(views[0]).toMatchObject({
      requestId: request.requestId,
      sessionId: request.sessionId,
      toolCall: request.toolCall,
      options: request.options,
    })

    await dispatchRpc(silentManager, 'permission/respond', { requestId: request.requestId, optionId: 'allow1' })
    await drained
    expect(silentManager.pendingPermissionViews()).toHaveLength(0)
  }, 30_000)

  it('leaves a promptly answered native ask alone', async () => {
    // The deadline is a withdrawal, not an answer: a host that answers inside
    // the window must never reach the ledger, and the ask must not be counted
    // twice.
    const before = hostAsks.length
    const since = silentEvents.length
    silentManager.setApprovalRequester(request => {
      hostAsks.push({ signal: request.signal })
      return new Promise<ApprovalOutcome>(resolve => { setTimeout(() => { resolve('allowed-once') }, 50) })
    })
    const { drained } = await silentTurn('dsh-silent-prompt', 'PERM silent prompt')
    await drained
    expect(hostAsks).toHaveLength(before + 1)
    expect(silentEvents.slice(since).filter(e => e.type === 'permission/request')).toHaveLength(0)
    const turn = silentEvents.find(e => e.type === 'turn/start' && e.text === 'PERM silent prompt')
    expect(turn).toBeDefined()
    expect(await silentEcho(turn!.sessionId)).toContain('perm=allow1')
    // Restore the never-answering requester for any later case.
    silentManager.setApprovalRequester(request => {
      hostAsks.push({ signal: request.signal })
      return new Promise<ApprovalOutcome>(() => { /* never settles */ })
    })
  }, 30_000)
})

/**
 * The DESIGNED ledger path: a host with no approval service at all.
 *
 * Every ask rides the ledger and the settings panel's card is the answer
 * entry, so `permissionTimeoutMs: 0` must keep meaning "wait for the human" —
 * the degraded-route deadline must not leak into this path — and the chat
 * line names the panel plainly.
 */
describe('the designed ledger path still waits for the human (isolated manager)', () => {
  const plainHub = new EventHub()
  const plainEvents: AcpEvent[] = []
  plainHub.subscribe(event => { plainEvents.push(event) })
  // A shortened degraded-route deadline that must NEVER fire on this path.
  const plainManager = new BridgeManager([{ ...def, id: 'plain' }], plainHub, 500, undefined, undefined, true, { permissionFallbackTimeoutMs: 150 })
  const plainAdapter = new AcpLlmAdapter(plainManager)

  afterAll(async () => {
    await plainManager.shutdownAll()
  })

  it('keeps waiting with permissionTimeoutMs 0 and says "approve in Settings"', async () => {
    expect(plainManager.approvalRouting()).toBe(false)
    const since = plainEvents.length
    const parts: string[] = []
    // The whole turn, continuation steps included: the permission ask cuts the
    // first segment, so draining one stream() call is NOT draining the turn.
    const plainDrained = hostLoopTurn(plainAdapter, {
      provider: 'acp',
      model: 'plain',
      sessionId: 'dsh-plain-ledger',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'PERM plain ledger' }] }],
    })
    const request = await new Promise<Extract<AcpEvent, { type: 'permission/request' }>>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout waiting for permission/request')), 15_000)
      const unsub = plainHub.subscribe(event => {
        if (plainEvents.indexOf(event) >= since && event.type === 'permission/request') {
          clearTimeout(timer)
          unsub()
          resolve(event)
        }
      })
    })

    // Well past the shortened degraded-route deadline: no notice, no
    // auto-cancel. The panel card is the designed answer entry here.
    await new Promise(resolve => setTimeout(resolve, 600))
    expect(plainEvents.slice(since).filter(e => e.type === 'agent/notice')).toHaveLength(0)
    // Still pending — `respond` throws `unknown_request` for an ask that is not.
    const responded = await dispatchRpc(plainManager, 'permission/respond', { requestId: request.requestId, optionId: 'allow1' })
    expect(responded.ok).toBe(true)
    const { chunks } = await plainDrained
    for (const chunk of chunks) {
      if (chunk.type === 'reasoning-delta') parts.push(chunk.text)
    }

    const reasoning = parts.join('')
    expect(reasoning).toContain('please approve in Settings')
    expect(reasoning).not.toContain('unavailable')
    const transcript = await dispatchRpc(plainManager, 'transcript/get', { sessionId: request.sessionId })
    expect(transcript.ok).toBe(true)
    if (!transcript.ok) return
    const echo = (transcript.value as { entries: Array<{ update: Record<string, unknown> }> }).entries
      .filter(e => e.update.sessionUpdate === 'agent_message_chunk')
      .map(e => String((e.update.content as { text?: string }).text ?? ''))
      .join('')
    expect(echo).toContain('perm=allow1')
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
 * is what reaches the human, routed to the native composer when the host's
 * approval chain is available and otherwise to the settings-panel ledger. The
 * workspace resolver these cases used to fake as an access mode is now just
 * the workspace reader (`src/index.ts`'s `wireWorkspace`), so they still
 * exercise the production path without a live DSH host.
 */
describe('permission mapping and the agent\'s own modes (isolated manager)', () => {
  const modeHub = new EventHub()
  const modeEvents: AcpEvent[] = []
  modeHub.subscribe(event => { modeEvents.push(event) })
  const modeManager = new BridgeManager([{ ...def, id: 'moded' }], modeHub, 500)
  const modeAdapter = new AcpLlmAdapter(modeManager)
  const asks: ApprovalRequestContext[] = []
  let answer: ApprovalOutcome = 'allowed-once'

  modeManager.setApprovalRequester(request => {
    asks.push(request)
    return Promise.resolve(answer)
  })

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

  /** Drain one adapter turn and return the mock agent's own echo of what it saw. */
  async function modeTurn(sessionId: string, text: string): Promise<string> {
    const since = modeEvents.length
    for await (const chunk of modeAdapter.stream({
      provider: 'acp',
      model: 'moded',
      sessionId,
      messages: [{ role: 'user', content: [{ type: 'text', text }] }],
    })) {
      void chunk
    }
    const started = modeEvents.slice(since).find(event => event.type === 'turn/start' && event.text === text)
    if (started === undefined) throw new Error('the turn never started')
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
    // unchanged.
    answer = 'allowed-once'
    const before = asks.length
    expect(await modeTurn('dsh-perm-1', 'PERM dangerous thing')).toContain('perm=allow1')
    expect(asks).toHaveLength(before + 1)
    expect(asks.at(-1)?.toolName).toBe('mock dangerous operation')
  }, 30_000)

  it('narrates nothing into the prompt, whatever the agent asks', async () => {
    // The mock echoes its whole input, so byte equality is the whole guard. A
    // permission question is answered in the conversation; it is never narrated
    // into the prompt the agent receives.
    answer = 'allowed-once'
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
    // No live session exists on the fresh host; the persisted lock is the only
    // thing keeping the conversation on its agent.
    expect(second.chatSessions('dsh-lock-2')).toEqual([])
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
      // No live session for this conversation...
      expect(second.chatSessions('dsh-cmd-1')).toEqual([])
      // ...but the agent-level answer is there.
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
