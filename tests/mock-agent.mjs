#!/usr/bin/env node
/**
 * Scripted ACP agent for integration tests (no API key, no LLM).
 *
 * Scenario markers read from the prompt text:
 *  - "PERM"  → mid-turn session/request_permission (allow_once / reject_once)
 *  - "SLOW"  → a 5s pause that session/cancel interrupts (cancelled stopReason)
 *  - "DIE"   → emits one update then exits the process (crash → release → resume)
 *  - "IGNORE_CANCEL" → ignores session/cancel for ~1.2s, then finishes normally
 *  - "READFILE <path>"   → reads the file through the client fs capability
 *  - "WRITEFILE <path>"  → writes 'written-by-mock-agent' through the client fs capability
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
let counter = 0

function mockConfigOptions(state = { temp: 'mid', model: 'mock-model-a', effort: 'high' }) {
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
    {
      configId: 'thought',
      name: 'Thought Level',
      type: 'select',
      category: 'thought_level',
      currentValue: state.effort,
      options: [
        { value: 'off', name: 'Off' },
        { value: 'high', name: 'High' },
      ],
    },
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
      loadSession: true,
      sessionCapabilities: { close: {} },
      promptCapabilities: { image: false, audio: false, embeddedContext: false },
    },
    agentInfo: { name: 'mock-acp-agent', title: 'Mock ACP Agent', version: '0.0.1' },
    authMethods: [],
  }))
  .onRequest(methods.agent.session.new, ctx => {
    const sessionId = `mock-sess-${String(++counter)}`
    sessions.set(sessionId, { cwd: ctx.params.cwd, modeId: 'default', temp: 'mid', model: 'mock-model-a', effort: 'high' })
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
    fireCancel(ctx.params.sessionId)
  })
  .onRequest(methods.agent.session.close, ctx => {
    sessions.delete(ctx.params.sessionId)
    return {}
  })
  .onRequest(methods.agent.session.load, async ctx => {
    const { sessionId, cwd } = ctx.params
    // Stand-in for agent-side persistence: recreate the record, replay a
    // marker update, then answer with the session state.
    sessions.set(sessionId, { cwd, modeId: 'default', temp: 'mid', model: 'mock-model-a', effort: 'high' })
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
  .onRequest(methods.agent.session.setConfigOption, ctx => {
    const session = sessions.get(ctx.params.sessionId)
    if (session === undefined) throw new Error('no such session')
    if (ctx.params.configId === 'temp') session.temp = String(ctx.params.value)
    else if (ctx.params.configId === 'model') session.model = String(ctx.params.value)
    else if (ctx.params.configId === 'thought') session.effort = String(ctx.params.value)
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
    await send({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'call_1',
      status: 'completed',
      content: [{ type: 'content', content: { type: 'text', text: 'tool result line' } }],
    })
    await send({ sessionUpdate: 'agent_message_chunk', messageId: 'm1', content: { type: 'text', text: 'MOCK:' } })
    await send({ sessionUpdate: 'agent_message_chunk', messageId: 'm1', content: { type: 'text', text: ` echo ${text} perm=${permissionAnswer}` } })
    await send({ sessionUpdate: 'usage_update', used: 123, size: 1000 })
    return { stopReason: 'end_turn' }
  })

const stream = ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin))
app.connect(stream)
