#!/usr/bin/env node
/**
 * Scripted ACP agent for integration tests (no API key, no LLM).
 *
 * Scenario markers read from the prompt text:
 *  - "PERM"  → mid-turn session/request_permission (allow_once / reject_once)
 *  - "SLOW"  → a 5s pause that session/cancel interrupts (cancelled stopReason)
 *  - "DIE"   → emits one update then exits the process (crash → release → resume)
 *  - "EMPTY" → only a usage_update, then a legal end_turn: the silent-failure
 *              shape wild agents produce (pi-acp folds a provider 403 into a
 *              normal stop), zero visible output
 *  - "FAIL"  → the prompt request fails (JSON-RPC error), zero visible output
 *  - "IGNORE_CANCEL" → ignores session/cancel for ~1.2s, then finishes normally
 *  - "HANG"  → the prompt request NEVER resolves and no update is ever sent
 *              (the wedged agent the inactivity watchdog exists for); a
 *              session/cancel is ignored on purpose
 *  - "HANG_DELAY:<ms>" → sends nothing for <ms> (a slow but alive agent), then
 *              runs the normal turn; session/cancel is ignored too
 *  - "HANG_TOOL" → streams the usual opening (thought / plan / tool card), puts
 *              the tool call `in_progress`, then NEVER finishes the turn: the
 *              "working on a tool" shape the second stall window covers
 *  - "HANG_TWO_TOOLS" → opens TWO tool calls, completes ONE, leaves the other
 *              `in_progress`, then NEVER finishes: the parallel-call shape (a
 *              finished call must not close the tool window while its sibling
 *              is still running)
 *  - "PIDTAG" → appends `PID:<process.pid>` to the echo, so a test can tell
 *              whether the SAME agent process served two turns (a restart /
 *              reclaim shows a different pid). Opt-in on purpose: every other
 *              prompt keeps the byte-exact echo the existing tests assert.
 *
 * Environment knobs:
 *  - MOCK_NO_LOAD=1 → `initialize` advertises no `loadSession` capability
 *  - MOCK_IGNORE_CLOSE=1 → `session/close` is never answered (a wedged agent);
 *              the host's stall reset must not wait for a graceful close
 *
 * Stale-cancel window: for 300ms after a `session/cancel` the NEXT prompt is
 * answered `cancelled` without generating a turn (the codebuddy 2.161.4
 * cleanup race — cancel state is cleared asynchronously and the prompt that
 * lands inside the window is swallowed). A prompt arriving after the window
 * runs normally.
 *  - "READFILE <path>"   → reads the file through the client fs capability
 *  - "WRITEFILE <path>"  → writes 'written-by-mock-agent' through the client fs capability
 *  - "PWD"   → reports this PROCESS's own cwd (what an agent that derives its
 *              workspace from `process.cwd()` would answer)
 *  - "MCPS"  → echoes the MCP servers this session was created with, as the
 *              exact WIRE shape the host sent (`session/new` / `session/load`)
 * Every turn streams: thought, plan, available_commands, tool_call lifecycle,
 * two same-messageId chunks, usage_update.
 * `session/new` advertises spec-shaped configOptions: a `model` selector, a
 * `thought_level` selector, and a plain legacy `temp` select.
 * `session/load` (loadSession capability) recreates the session record and
 * replays a marker update before answering, simulating agent-side persistence.
 */
import { Writable, Readable } from 'node:stream'
import { agent, methods, ndJsonStream, PROTOCOL_VERSION } from '@agentclientprotocol/sdk'

const sessions = new Map()
const cancelled = new Set()
const cancelWaiters = new Map()
/** sessionId → epoch ms until which the next prompt is swallowed (stale cancel). */
const cancelCleanupUntil = new Map()
let counter = 0

// The model a fresh session starts on (tests may pin one via MOCK_MODEL).
const DEFAULT_MODEL = process.env.MOCK_MODEL ?? 'mock-model-a'

function mockConfigOptions(state = { temp: 'mid', model: DEFAULT_MODEL, effort: 'high' }) {
  return [
    {
      configId: 'model',
      name: 'Model',
      type: 'select',
      category: 'model',
      currentValue: state.model,
      options: [
        { value: 'mock-model-a', name: 'Mock Model A' },
        { value: 'mock-model-b', name: 'Mock Model B', description: 'The stronger mock model' },
      ],
    },
    // `mock-model-plain` stands for a model with NO variants: like opencode's
    // `effort` option, a thought_level is published only for models that have
    // one — switching the model is what reveals it.
    ...(state.model === 'mock-model-plain' ? [] : [{
      configId: 'thought',
      name: 'Thought Level',
      type: 'select',
      category: 'thought_level',
      currentValue: state.effort,
      options: [
        { value: 'off', name: 'Off' },
        { value: 'high', name: 'High' },
      ],
    }]),
    {
      configId: 'temp',
      name: 'Temperature',
      type: 'select',
      currentValue: state.temp,
      options: [
        { value: 'low', name: 'low' },
        { value: 'mid', name: 'mid' },
        { value: 'high', name: 'high' },
      ],
    },
    // A boolean toggle (ACP `type: 'boolean'`, no choices). The composer
    // renders it as a checkbox; the host must send it back as
    // `type: 'boolean'` with a real boolean value.
    {
      configId: 'stream',
      name: 'Stream Mode',
      type: 'boolean',
      currentValue: state.stream === true,
    },
  ]
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function cancelPromise(sessionId) {
  return new Promise(resolve => {
    const list = cancelWaiters.get(sessionId) ?? []
    list.push(resolve)
    cancelWaiters.set(sessionId, list)
  })
}

function fireCancel(sessionId) {
  for (const resolve of cancelWaiters.get(sessionId) ?? []) resolve()
  cancelWaiters.set(sessionId, [])
}

const app = agent({ name: 'mock-acp-agent' })
  .onRequest(methods.agent.initialize, () => ({
    protocolVersion: PROTOCOL_VERSION,
    agentCapabilities: {
      loadSession: process.env.MOCK_NO_LOAD !== '1',
      sessionCapabilities: { close: {} },
      promptCapabilities: { image: false, audio: false, embeddedContext: false },
    },
    agentInfo: { name: 'mock-acp-agent', title: 'Mock ACP Agent', version: '0.0.1' },
    authMethods: [],
  }))
  .onRequest(methods.agent.session.new, ctx => {
    // The PID prefix makes ids unique ACROSS PROCESSES too: a restart creates a
    // new counter, and a test that proves "the host opened a NEW agent session"
    // (a reset, not a `session/load`) compares ids from two different children.
    const sessionId = `mock-sess-${String(process.pid)}-${String(++counter)}`
    sessions.set(sessionId, { cwd: ctx.params.cwd, modeId: 'default', temp: 'mid', model: DEFAULT_MODEL, effort: 'high', stream: false, mcpServers: ctx.params.mcpServers })
    return {
      sessionId,
      modes: {
        currentModeId: 'default',
        availableModes: [
          { id: 'default', name: 'Default' },
          { id: 'strict', name: 'Strict' },
        ],
      },
      configOptions: mockConfigOptions(sessions.get(sessionId)),
    }
  })
  .onNotification(methods.agent.session.cancel, ctx => {
    cancelled.add(ctx.params.sessionId)
    cancelCleanupUntil.set(ctx.params.sessionId, Date.now() + 300)
    fireCancel(ctx.params.sessionId)
  })
  .onRequest(methods.agent.session.close, async ctx => {
    // IGNORE_CLOSE: the wedged agent that never acknowledges a graceful close.
    // A stall recovery must not depend on this request (it restarts the
    // process instead), so a host that awaited it would hang here forever —
    // which is exactly what the integration test pins.
    if (process.env.MOCK_IGNORE_CLOSE === '1') await new Promise(() => {})
    sessions.delete(ctx.params.sessionId)
    return {}
  })
  .onRequest(methods.agent.session.load, async ctx => {
    const { sessionId, cwd } = ctx.params
    // Stand-in for agent-side persistence: recreate the record, replay a
    // marker update, then answer with the session state.
    sessions.set(sessionId, { cwd, modeId: 'default', temp: 'mid', model: DEFAULT_MODEL, effort: 'high', stream: false, mcpServers: ctx.params.mcpServers })
    const send = update => ctx.client.notify(methods.client.session.update, { sessionId, update })
    await send({ sessionUpdate: 'tool_call', toolCallId: 'replay_tool', title: 'replayed tool', kind: 'other', status: 'completed' })
    await send({ sessionUpdate: 'agent_message_chunk', messageId: 'replay-1', content: { type: 'text', text: 'REPLAYED: earlier conversation' } })
    return {
      modes: {
        currentModeId: 'default',
        availableModes: [
          { id: 'default', name: 'Default' },
          { id: 'strict', name: 'Strict' },
        ],
      },
      configOptions: mockConfigOptions(sessions.get(sessionId)),
    }
  })
  .onRequest(methods.agent.session.setConfigOption, async ctx => {
    const session = sessions.get(ctx.params.sessionId)
    if (session === undefined) throw new Error('no such session')
    // Test knob: an agent mid-reset answering (and pushing) an EMPTY option
    // set. The host must treat it as a non-answer that never wipes known state.
    if (ctx.params.configId === 'mock-empty-answer') {
      await ctx.client.notify(methods.client.session.update, {
        sessionId: ctx.params.sessionId,
        update: { sessionUpdate: 'config_option_update', configOptions: [] },
      })
      return { configOptions: [] }
    }
    if (ctx.params.configId === 'temp') session.temp = String(ctx.params.value)
    else if (ctx.params.configId === 'model') session.model = String(ctx.params.value)
    else if (ctx.params.configId === 'thought') session.effort = String(ctx.params.value)
    else if (ctx.params.configId === 'stream') {
      // A boolean option must arrive discriminated: `type: 'boolean'` + a real
      // boolean. The request union keys on `type`, so a client that forgets it
      // is sending a select value id at a toggle.
      if (ctx.params.type !== 'boolean' || typeof ctx.params.value !== 'boolean') {
        throw new Error('stream is a boolean option: expected type "boolean" and a boolean value')
      }
      session.stream = ctx.params.value
    }
    return { configOptions: mockConfigOptions(session) }
  })
  .onRequest(methods.agent.session.setMode, async ctx => {
    const session = sessions.get(ctx.params.sessionId)
    if (session === undefined) throw new Error('no such session')
    session.modeId = ctx.params.modeId
    await ctx.client.notify(methods.client.session.update, {
      sessionId: ctx.params.sessionId,
      update: { sessionUpdate: 'current_mode_update', currentModeId: ctx.params.modeId },
    })
    return {}
  })
  .onRequest(methods.agent.session.prompt, async ctx => {
    const { sessionId } = ctx.params
    const text = ctx.params.prompt
      .filter(part => part.type === 'text')
      .map(part => part.text)
      .join(' ')
    const send = update => ctx.client.notify(methods.client.session.update, { sessionId, update })
    let permissionAnswer = 'none'

    // Stale-cancel swallow: a prompt landing inside the cleanup window of the
    // PREVIOUS cancel is answered from that cancel — no updates, no turn.
    const cleanupUntil = cancelCleanupUntil.get(sessionId)
    if (cleanupUntil !== undefined && Date.now() < cleanupUntil) {
      return { stopReason: 'cancelled' }
    }

    // Inactivity-watchdog modes, checked before any output. None of them
    // acknowledges session/cancel: the watchdog exists for the agent that does
    // not even acknowledge a cancel, so the reply must not arrive just because
    // the host gave up on it. `HANG_TOOL` / `HANG_TWO_TOOLS` are excluded here —
    // they hang LATER, with tool calls already in flight.
    const delayed = /HANG_DELAY:(\d+)/.exec(text)
    if (delayed !== null) {
      await sleep(Number(delayed[1]))
    } else if (text.includes('HANG') && !text.includes('HANG_TOOL') && !text.includes('HANG_TWO_TOOLS')) {
      // A wedged agent: this request stays open forever. Nothing resolves it —
      // not the cancel notification, not a timer. The process keeps serving
      // other sessions, exactly like an agent stuck inside one turn.
      await new Promise(() => {})
    }

    if (text.includes('FAIL')) {
      throw new Error('mock prompt failure')
    }

    if (text.includes('EMPTY')) {
      // Bookkeeping frames only: opens no visible block in the host's fold.
      await send({ sessionUpdate: 'usage_update', used: 5, size: 1000 })
      return { stopReason: 'end_turn' }
    }

    if (text.includes('DIE')) {
      await send({ sessionUpdate: 'agent_message_chunk', messageId: 'dying', content: { type: 'text', text: 'about to die' } })
      process.exit(1)
    }

    if (text.includes('READFILE')) {
      const path = text.split('READFILE')[1]?.trim().split(/\s+/)[0] ?? ''
      try {
        const file = await ctx.client.request(methods.client.fs.readTextFile, { sessionId, path })
        await send({ sessionUpdate: 'agent_message_chunk', messageId: 'fs', content: { type: 'text', text: `READ_OK:${file.content}` } })
      } catch (error) {
        await send({ sessionUpdate: 'agent_message_chunk', messageId: 'fs', content: { type: 'text', text: `READ_FAIL:${String(error?.message ?? error)}` } })
      }
    }

    if (text.includes('WRITEFILE')) {
      const path = text.split('WRITEFILE')[1]?.trim().split(/\s+/)[0] ?? ''
      try {
        await ctx.client.request(methods.client.fs.writeTextFile, { sessionId, path, content: 'written-by-mock-agent' })
        await send({ sessionUpdate: 'agent_message_chunk', messageId: 'fs', content: { type: 'text', text: 'WRITE_OK' } })
      } catch (error) {
        await send({ sessionUpdate: 'agent_message_chunk', messageId: 'fs', content: { type: 'text', text: `WRITE_FAIL:${String(error?.message ?? error)}` } })
      }
    }

    if (text.includes('PWD')) {
      // The stand-in for agents (codebuddy) that fix their workspace at process
      // start: this answer depends on where the child was SPAWNED, never on
      // `session/new`'s cwd.
      await send({ sessionUpdate: 'agent_message_chunk', messageId: 'cwd', content: { type: 'text', text: `PWD:${process.cwd()}` } })
    }

    if (text.includes('MCPS')) {
      // Echoes back the MCP servers this session was created with, so a test
      // can assert the exact WIRE shape the host sent (`session/new` /
      // `session/load`). Delimited on both sides: the chunk is joined with the
      // rest of the turn's text, so the JSON needs its own boundaries.
      const session = sessions.get(sessionId)
      await send({ sessionUpdate: 'agent_message_chunk', messageId: 'mcps', content: { type: 'text', text: `MCPS_BEGIN${JSON.stringify(session?.mcpServers ?? [])}MCPS_END` } })
    }

    await send({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'thinking…' } })
    await send({
      sessionUpdate: 'plan',
      entries: [
        { content: 'step one', status: 'completed', priority: 'high' },
        { content: 'step two', status: 'in_progress', priority: 'medium' },
      ],
    })
    await send({
      sessionUpdate: 'available_commands_update',
      availableCommands: [{ name: 'greet', description: 'say hi' }],
    })
    if (text.includes('TWOTOOLS')) {
      // The shapes the wild agents (codebuddy) actually send: a call announced
      // with a `rawInput` snapshot that later updates RESTATE IN WHOLE (the
      // update is a replacement, not an append), and a second call announced
      // while the first card is still the open block. The restatements also
      // INTERLEAVE across parallel calls — the t1 restatement below lands
      // while t2's card is the open block, and the final t1 update carries
      // the tool's real output as `content`.
      await send({ sessionUpdate: 'tool_call', toolCallId: 't1', title: 'first tool', rawInput: '{"cmd":""}' })
      await send({ sessionUpdate: 'tool_call_update', toolCallId: 't1', rawInput: '{"cmd":"ls -la"}' })
      // Some agents restate the announcement instead of updating; the same
      // callId on an open card is an update, never a second card.
      await send({ sessionUpdate: 'tool_call', toolCallId: 't1', title: 'first tool', rawInput: '{"cmd":"ls -la"}' })
      await send({ sessionUpdate: 'tool_call', toolCallId: 't2', title: 'second tool', rawInput: { path: 'a.md' } })
      await send({ sessionUpdate: 'tool_call', toolCallId: 't1', title: '`ls -la`', rawInput: '{"cmd":"ls -la"}' })
      await send({ sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: 'T1 OUTPUT LINE' } }] })
    }

    if (text.includes('HANG_TWO_TOOLS')) {
      // Parallel tool calls, the shape real agents produce: `ta` COMPLETES
      // while `tb` is still `in_progress`. The turn is still the agent's to
      // run — a sibling finishing is not the turn going quiet — so the host
      // must keep applying the (longer) tool window. Then silence, like
      // HANG_TOOL: session/cancel is ignored on purpose.
      await send({ sessionUpdate: 'tool_call', toolCallId: 'ta', title: 'first parallel tool', kind: 'other', status: 'pending' })
      await send({ sessionUpdate: 'tool_call', toolCallId: 'tb', title: 'second parallel tool', kind: 'other', status: 'pending' })
      await send({ sessionUpdate: 'tool_call_update', toolCallId: 'ta', status: 'in_progress' })
      await send({ sessionUpdate: 'tool_call_update', toolCallId: 'tb', status: 'in_progress' })
      await send({
        sessionUpdate: 'tool_call_update',
        toolCallId: 'ta',
        status: 'completed',
        content: [{ type: 'content', content: { type: 'text', text: 'first parallel result' } }],
      })
      await new Promise(() => {})
    }

    await send({ sessionUpdate: 'tool_call', toolCallId: 'call_1', title: 'mock tool', kind: 'other', status: 'pending' })

    if (text.includes('PERM')) {
      // `PERMEDIT` / `PERMEXEC` declare the ACP tool-call kind and
      // `PERMLOC:<path>` the write locations, so host tests can exercise the
      // DSH access-mode mapping (kind classification + workspace containment).
      const kind = text.includes('PERMEDIT') ? 'edit' : text.includes('PERMEXEC') ? 'execute' : undefined
      const location = /PERMLOC:(\S+)/.exec(text)
      const toolCall = {
        toolCallId: 'call_1',
        title: 'mock dangerous operation',
        ...(kind === undefined ? {} : { kind }),
        ...(location === null ? {} : { locations: [{ path: location[1] }] }),
      }
      const response = await ctx.client.request(methods.client.session.requestPermission, {
        sessionId,
        toolCall,
        options: [
          { optionId: 'allow1', name: 'Allow once', kind: 'allow_once' },
          { optionId: 'reject1', name: 'Reject once', kind: 'reject_once' },
        ],
      })
      permissionAnswer = response.outcome.outcome === 'selected' ? response.outcome.optionId : 'cancelled'
    }

    await send({ sessionUpdate: 'tool_call_update', toolCallId: 'call_1', status: 'in_progress' })
    if (text.includes('SLOW')) {
      const wasCancelled = await Promise.race([
        sleep(5000).then(() => false),
        cancelPromise(sessionId).then(() => true),
      ])
      if (wasCancelled) {
        cancelled.delete(sessionId)
        return { stopReason: 'cancelled' }
      }
    }
    if (text.includes('IGNORE_CANCEL')) {
      // Deliberately ignore the cancel notification to exercise the host's
      // cancel fallback timer; the turn eventually finishes normally.
      await sleep(1200)
      fireCancel(sessionId)
    }
    if (text.includes('HANG_TOOL')) {
      // The tool call is open (status `in_progress` above) and never completes:
      // a working agent whose tool half may legitimately take much longer than
      // its prose half. session/cancel is ignored, like the other HANG modes.
      await new Promise(() => {})
    }
    await send({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'call_1',
      status: 'completed',
      content: [{ type: 'content', content: { type: 'text', text: 'tool result line' } }],
    })
    await send({ sessionUpdate: 'agent_message_chunk', messageId: 'm1', content: { type: 'text', text: 'MOCK:' } })
    // Opt-in process token: `REPLAYED` proves a `session/load`, but it is
    // emitted by ANY child, so it cannot prove the process changed. The pid can.
    const pidTag = text.includes('PIDTAG') ? ` PID:${String(process.pid)}` : ''
    await send({ sessionUpdate: 'agent_message_chunk', messageId: 'm1', content: { type: 'text', text: ` echo ${text} perm=${permissionAnswer}${pidTag}` } })
    await send({ sessionUpdate: 'usage_update', used: 123, size: 1000 })
    return { stopReason: 'end_turn' }
  })

const stream = ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin))
app.connect(stream)
