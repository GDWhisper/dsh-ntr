#!/usr/bin/env node
import { Readable, Writable } from 'node:stream'
import { agent, methods, ndJsonStream, PROTOCOL_VERSION } from '@agentclientprotocol/sdk'

let counter = 0

function promptTextOf(prompt) {
  return (prompt ?? [])
    .filter(block => block?.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('\n')
}

const app = agent({ name: 'turn-usage-mock' })
  .onRequest(methods.agent.initialize, () => ({
    protocolVersion: PROTOCOL_VERSION,
    agentCapabilities: { loadSession: true },
    agentInfo: { name: 'turn-usage-mock', title: 'Turn Usage Mock', version: '0.0.1' },
    authMethods: [],
  }))
  .onRequest(methods.agent.session.new, () => ({
    sessionId: `usage-sess-${String(++counter)}`,
  }))
  .onRequest(methods.agent.session.prompt, async ctx => {
    const { sessionId, prompt } = ctx.params
    const text = promptTextOf(prompt)
    const send = update => ctx.client.notify(methods.client.session.update, { sessionId, update })

    if (text.includes('OPENCODE_MULTI')) {
      await send({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: '12345678901234567890' } })
      await send({ sessionUpdate: 'tool_call', toolCallId: 'oc_1', title: 'Read', status: 'in_progress', rawInput: { path: 'a.ts' } })
      await send({ sessionUpdate: 'tool_call_update', toolCallId: 'oc_1', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: 'ok' } }] })
      await send({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'OpenCode final answer' } })
      return {
        stopReason: 'end_turn',
        usage: {
          inputTokens: 1000,
          outputTokens: 50,
          totalTokens: 1250,
          cachedReadTokens: 200,
          thoughtTokens: 10,
        },
      }
    }

    if (text.includes('OPENCODE_CARD_END')) {
      await send({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Working on it' } })
      await send({ sessionUpdate: 'tool_call', toolCallId: 'oc_card_1', title: 'Bash', status: 'in_progress', rawInput: { command: 'ls' } })
      await send({ sessionUpdate: 'tool_call_update', toolCallId: 'oc_card_1', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: 'done' } }] })
      return {
        stopReason: 'end_turn',
        usage: {
          inputTokens: 800,
          outputTokens: 30,
          totalTokens: 830,
        },
      }
    }

    if (text.includes('OPENCODE_CARD_DELAYED_SETTLE')) {
      await send({ sessionUpdate: 'tool_call', toolCallId: 'oc_delay_1', title: 'Bash', status: 'in_progress', rawInput: { command: 'ls' } })
      await send({ sessionUpdate: 'tool_call_update', toolCallId: 'oc_delay_1', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: 'done' } }] })
      await send({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '12345678' } })
      await new Promise(resolve => setTimeout(resolve, 60))
      return {
        stopReason: 'end_turn',
        usage: {
          inputTokens: 900,
          outputTokens: 40,
          totalTokens: 940,
        },
      }
    }

    if (text.includes('CODEBUDDY_MULTI')) {
      await send({
        sessionUpdate: 'usage_update',
        used: 500,
        size: 100000,
        _meta: {
          'codebuddy.ai/messageId': 'cb_m1',
          usage: { input_tokens: 100, cache_read_input_tokens: 400, output_tokens: 5 },
        },
      })
      await send({
        sessionUpdate: 'usage_update',
        used: 515,
        size: 100000,
        _meta: {
          'codebuddy.ai/messageId': 'cb_m1',
          usage: { input_tokens: 100, cache_read_input_tokens: 400, output_tokens: 15 },
        },
      })
      await send({ sessionUpdate: 'tool_call', toolCallId: 'cb_tool_1', title: 'Bash', status: 'in_progress', rawInput: { command: 'pwd' } })
      await send({
        sessionUpdate: 'usage_update',
        used: 200,
        size: 100000,
        _meta: {
          'codebuddy.ai/parentToolCallId': 'cb_tool_1',
          'codebuddy.ai/messageId': 'cb_worker',
          usage: { input_tokens: 8888, output_tokens: 888 },
        },
      })
      await send({ sessionUpdate: 'tool_call_update', toolCallId: 'cb_tool_1', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: '/' } }] })
      await send({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'CodeBuddy final answer' } })
      await send({
        sessionUpdate: 'usage_update',
        used: 775,
        size: 100000,
        _meta: {
          'codebuddy.ai/messageId': 'cb_m2',
          usage: { input_tokens: 200, cache_read_input_tokens: 500, cache_creation_input_tokens: 50, output_tokens: 25 },
        },
      })
      await send({
        sessionUpdate: 'usage_update',
        used: 0,
        size: 0,
        cost: { amount: 0.02, currency: 'USD' },
        _meta: {
          'codebuddy.ai/messageId': 'cb_team',
          usage: { input_tokens: 9999, output_tokens: 999 },
        },
      })
      return {
        stopReason: 'end_turn',
        usage: { inputTokens: 9999, outputTokens: 9999, totalTokens: 19998 },
      }
    }

    await send({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'thinking…' } })
    await send({ sessionUpdate: 'tool_call', toolCallId: 'legacy_1', title: 'Echo', status: 'in_progress', rawInput: { text } })
    await send({ sessionUpdate: 'tool_call_update', toolCallId: 'legacy_1', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: 'ok' } }] })
    await send({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Legacy answer' } })
    await send({ sessionUpdate: 'usage_update', used: 123, size: 1000 })
    return { stopReason: 'end_turn' }
  })

const stream = ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin))
app.connect(stream)
