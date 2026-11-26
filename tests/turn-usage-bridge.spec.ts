import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { afterAll, describe, expect, it } from 'vitest'
import { AcpLlmAdapter, BridgeManager } from '../src/bridge.ts'
import { dispatchRpc, EventHub, type AcpTurnUsage } from '../src/impl.ts'
import type { AcpAgentDef, StreamChunk } from '../src/protocol.ts'
import { hostLoopTurn } from './bridge/harness.ts'

const USAGE_MOCK = fileURLToPath(new URL('./turn-usage-mock.mjs', import.meta.url))

const def: AcpAgentDef = {
  id: 'usage-mock',
  title: 'Usage Mock',
  command: process.execPath,
  args: [USAGE_MOCK],
  env: {},
  cwd: tmpdir(),
  allowedCwdRoots: [tmpdir()],
}

const hub = new EventHub()
const manager = new BridgeManager([def], hub, 500)
const adapter = new AcpLlmAdapter(manager)

afterAll(async () => {
  await manager.shutdownAll()
})

function stepUsage(chunks: StreamChunk[]): AcpTurnUsage | undefined {
  return chunks.find((c): c is Extract<StreamChunk, { type: 'usage' }> => c.type === 'usage')?.usage as AcpTurnUsage | undefined
}

describe('Bridge turn usage forwarding', () => {
  it('forwards OpenCode PromptResponse.usage in multi-step turn without double-counting fallback output', async () => {
    const { steps } = await hostLoopTurn(adapter, {
      provider: 'acp',
      model: 'usage-mock',
      sessionId: 'dsh-usage-opencode-multi',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'OPENCODE_MULTI' }] }],
    })
    expect(steps).toHaveLength(2)
    expect(stepUsage(steps[0]!)).toEqual({ inputTokens: 0, outputTokens: 5 })
    expect(stepUsage(steps[1]!)).toEqual({
      inputTokens: 1000,
      outputTokens: 45,
      totalTokens: 1245,
      cacheReadTokens: 200,
      reasoningTokens: 10,
    })
  }, 30_000)

  it('forwards PromptResponse.usage on card-ending turns without emitting duplicate usage in continuation step', async () => {
    const { steps } = await hostLoopTurn(adapter, {
      provider: 'acp',
      model: 'usage-mock',
      sessionId: 'dsh-usage-opencode-card-end',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'OPENCODE_CARD_END' }] }],
    })
    expect(steps).toHaveLength(2)
    expect(stepUsage(steps[0]!)).toEqual({
      inputTokens: 800,
      outputTokens: 30,
      totalTokens: 830,
    })
    expect(stepUsage(steps[1]!)).toBeUndefined()
  }, 30_000)

  it('flushes PromptResponse.usage in final continuation step when PromptResponse settles between segments', async () => {
    const { steps } = await hostLoopTurn(
      adapter,
      {
        provider: 'acp',
        model: 'usage-mock',
        sessionId: 'dsh-usage-opencode-delayed',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'OPENCODE_CARD_DELAYED_SETTLE' }] }],
      },
      8,
      undefined,
      120,
    )
    expect(steps).toHaveLength(2)
    expect(stepUsage(steps[0]!)).toBeUndefined()
    expect(stepUsage(steps[1]!)).toEqual({
      inputTokens: 900,
      outputTokens: 40,
      totalTokens: 940,
    })
  }, 30_000)

  it('forwards CodeBuddy _meta.usage deltas per messageId, filters team ticks, and ignores PromptResponse double-count', async () => {
    const dshSessionId = 'dsh-usage-codebuddy-multi'
    const { steps } = await hostLoopTurn(adapter, {
      provider: 'acp',
      model: 'usage-mock',
      sessionId: dshSessionId,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'CODEBUDDY_MULTI' }] }],
    })
    expect(steps).toHaveLength(2)
    expect(stepUsage(steps[0]!)).toEqual({
      inputTokens: 100,
      outputTokens: 15,
      cacheReadTokens: 400,
      totalTokens: 515,
    })
    expect(stepUsage(steps[1]!)).toEqual({
      inputTokens: 200,
      outputTokens: 25,
      cacheReadTokens: 500,
      cacheWriteTokens: 50,
      totalTokens: 775,
    })

    // Existing session.usage.cost preservation remains untouched in AgentBridge.
    const listed = await dispatchRpc(manager, 'session/chat-list', { dshSessionId })
    if (!listed.ok) throw new Error('session/chat-list failed')
    const view = (listed.value as { sessions: Array<{ usage?: { used: number; size: number; cost?: { amount: number; currency: string } } }> }).sessions[0]
    expect(view?.usage).toEqual({ used: 775, size: 100000, cost: { amount: 0.02, currency: 'USD' } })
  }, 30_000)

  it('preserves 4-chars/token output fallback when agent reports no real usage', async () => {
    const { steps } = await hostLoopTurn(adapter, {
      provider: 'acp',
      model: 'usage-mock',
      sessionId: 'dsh-usage-legacy',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'LEGACY_FALLBACK' }] }],
    })
    expect(steps).toHaveLength(2)
    expect(stepUsage(steps[0]!)).toEqual({ inputTokens: 0, outputTokens: Math.round('thinking…'.length / 4) })
    expect(stepUsage(steps[1]!)).toEqual({ inputTokens: 0, outputTokens: Math.round('Legacy answer'.length / 4) })
  }, 30_000)
})
