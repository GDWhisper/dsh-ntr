#!/usr/bin/env node
/**
 * Scripted ACP agent for integration tests (no API key, no LLM).
 *
 * Scenario markers read from the prompt text:
 *  - "PERM"  → mid-turn session/request_permission (allow_once / reject_once)
 *  - "SLOW"  → a 5s pause that session/cancel interrupts (cancelled stopReason)
 * Every turn streams: thought, plan, available_commands, tool_call lifecycle,
 * two same-messageId chunks, usage_update.
 */
import { Writable, Readable } from 'node:stream'
import { agent, methods, ndJsonStream, PROTOCOL_VERSION } from '@agentclientprotocol/sdk'

const sessions = new Map()
const cancelled = new Set()
const cancelWaiters = new Map()
let counter = 0

function mockConfigOptions(temp = 'mid') {
  return {
    id: 'temp',
    name: 'Temperature',
    type: 'select',
    currentValue: temp,
    options: [
      { value: 'low', name: 'low' },
      { value: 'mid', name: 'mid' },
      { value: 'high', name: 'high' },
    ],
  }
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
      loadSession: false,
      sessionCapabilities: { close: {} },
      promptCapabilities: { image: false, audio: false, embeddedContext: false },
    },
    agentInfo: { name: 'mock-acp-agent', title: 'Mock ACP Agent', version: '0.0.1' },
    authMethods: [],
  }))
  .onRequest(methods.agent.session.new, ctx => {
    const sessionId = `mock-sess-${String(++counter)}`
    sessions.set(sessionId, { cwd: ctx.params.cwd, modeId: 'default', temp: 'mid' })
    return {
      sessionId,
      modes: {
        currentModeId: 'default',
        availableModes: [
          { id: 'default', name: 'Default' },
          { id: 'strict', name: 'Strict' },
        ],
      },
      configOptions: [mockConfigOptions()],
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
  .onRequest(methods.agent.session.setConfigOption, ctx => {
    const session = sessions.get(ctx.params.sessionId)
    if (session === undefined) throw new Error('no such session')
    session.temp = String(ctx.params.value)
    return { configOptions: [mockConfigOptions(session.temp)] }
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
      const response = await ctx.client.request(methods.client.session.requestPermission, {
        sessionId,
        toolCall: { toolCallId: 'call_1', title: 'mock dangerous operation' },
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
