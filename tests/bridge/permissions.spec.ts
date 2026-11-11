import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { afterAll, describe, expect, it } from 'vitest'
import { AcpLlmAdapter, AgentBridge, BridgeManager, permissionAskReason, permissionToolName } from '../../src/bridge.ts'
import { type AcpEvent, type ChatSessionView } from '../../src/protocol.ts'
import { dispatchRpc, EventHub, permissionReplayFrames } from '../../src/impl.ts'
import { def, hostLoopTurn, settleTranscript, until } from './harness.ts'

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

    // An adapter call with no DSH chat session is now refused before it starts
    // (the host-internal auxiliary-call guard), so the sessionless ask is a
    // real `/acp` RPC turn. Its only answer entry is the settings page, and
    // the frame proves it: no `dshSessionId`.
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
      const start = await dispatchRpc(plainManager, 'session/start', { agentId: 'plain-ask' })
      if (!start.ok) throw new Error('start failed')
      const id = (start.value as { sessionId: string }).sessionId
      const since = plainEvents.length
      const prompted = dispatchRpc(plainManager, 'session/prompt', { sessionId: id, text: 'PERM rpc line' })
      await until(() => plainEvents.slice(since).some(event => event.type === 'permission/request'))
      const frame = plainEvents.slice(since).find((event): event is Extract<AcpEvent, { type: 'permission/request' }> => event.type === 'permission/request')
      expect(frame).toBeDefined()
      expect(frame).not.toHaveProperty('dshSessionId')
      expect(frame?.toolName).toBe('Bash')
      await expect(prompted).resolves.toMatchObject({ ok: true, value: { accepted: true } })
      await until(() => plainEvents.slice(since).some(event => event.type === 'turn/end' && event.sessionId === id))
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
