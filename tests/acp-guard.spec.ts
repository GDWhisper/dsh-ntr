/**
 * Regression tests for the ACP preset's step gate (`agent/pre-step`).
 *
 * Issue #10: a continuation step fed only with the host's runtime-context
 * snapshot was rejected, and the host turns every rejection into
 * `turn/end {kind:"blocked"}`. `runtime-context` is the real source constant
 * in `dsh-agent-loop` (not `plugin`), so the gate must strip it exactly like
 * the other harness injections.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'

function guardCtx(services: Record<string, unknown> = {}) {
  const listeners = new Map<string, { listener: (payload: any, next: any) => any }>()
  return {
    listeners,
    on: vi.fn((name: string, listener: (payload: any, next: any) => any) => {
      listeners.set(name, { listener })
      return () => {}
    }),
    get: vi.fn((service: string) => services[service]),
  }
}

/** Mount the guard and hand back its listener table. */
async function mountGuardAll() {
  const ctx = guardCtx()
  await import('../presets/acp/acp-guard.mjs').then(({ apply }) => apply(ctx as never, undefined))
  return ctx.listeners
}

async function mountGuard() {
  const ctx = guardCtx()
  await import('../presets/acp/acp-guard.mjs').then(({ apply }) => apply(ctx as never, undefined))
  const preStep = ctx.listeners.get('agent/pre-step')
  if (preStep === undefined) throw new Error('guard registered no agent/pre-step listener')
  return preStep.listener
}

/** The host's default `next()`: `messages: context === undefined ? claimed : [...claimed, context]`. */
function nextWith(claimed: unknown[], context?: unknown) {
  return async () => ({ kind: 'enter' as const, messages: context === undefined ? claimed : [...claimed, context] })
}

const runtimeContext = {
  role: 'user',
  source: { kind: 'runtime-context', form: 'snapshot' },
  content: [{ type: 'text', text: 'Current runtime context.' }],
}

describe('acp-guard pre-step source filtering', () => {
  afterEach(async () => {
    const { routeBindingRegistry } = await import('../src/bridge.ts')
    routeBindingRegistry().toolResults.clear()
  })

  it('enters an empty batch for a runtime-context-only continuation step', async () => {
    const preStep = await mountGuard()
    const decision = await preStep({ messages: [], turn: 4, step: 2 }, nextWith([], runtimeContext))
    expect(decision).toEqual({ kind: 'enter', messages: [] })
  })

  it('still enters an empty continuation batch', async () => {
    const preStep = await mountGuard()
    const decision = await preStep({ messages: [], turn: 4, step: 2 }, nextWith([]))
    expect(decision).toEqual({ kind: 'enter', messages: [] })
  })

  it('still rejects a foreign non-user, non-tool message', async () => {
    const preStep = await mountGuard()
    const foreign = { role: 'user', source: { kind: 'goal' }, content: [{ type: 'text', text: 'goal material' }] }
    const decision = await preStep({ messages: [foreign], turn: 4, step: 2 }, nextWith([foreign]))
    expect(decision).toEqual({ kind: 'reject' })
  })

  it('still rejects a staged tool result whose call id is not registered', async () => {
    const preStep = await mountGuard()
    const foreignTool = { role: 'user', source: { kind: 'tool', callId: 'not-ours' }, content: [{ type: 'text', text: '?' }] }
    const decision = await preStep({ messages: [foreignTool], turn: 4, step: 2 }, nextWith([foreignTool]))
    expect(decision).toEqual({ kind: 'reject' })
  })

  it('enters a staged tool continuation whose call id is registered', async () => {
    const { routeBindingRegistry } = await import('../src/bridge.ts')
    routeBindingRegistry().toolResults.set('own-1', 'grep output')
    const preStep = await mountGuard()
    const ownTool = { role: 'user', source: { kind: 'tool', callId: 'own-1' }, content: [{ type: 'text', text: 'grep output' }] }
    const decision = await preStep({ messages: [ownTool], turn: 4, step: 2 }, nextWith([ownTool]))
    expect(decision).toEqual({ kind: 'enter', messages: [ownTool] })
  })

  it('enters a registered tool continuation with runtime-context stripped', async () => {
    const { routeBindingRegistry } = await import('../src/bridge.ts')
    routeBindingRegistry().toolResults.set('own-2', 'grep output')
    const preStep = await mountGuard()
    const ownTool = { role: 'user', source: { kind: 'tool', callId: 'own-2' }, content: [{ type: 'text', text: 'grep output' }] }
    const decision = await preStep({ messages: [ownTool, runtimeContext], turn: 4, step: 2 }, nextWith([ownTool, runtimeContext]))
    expect(decision).toEqual({ kind: 'enter', messages: [ownTool] })
  })

  it('rejects a runtime-context-only batch when strippedSources is empty', async () => {
    const ctx = guardCtx()
    await import('../presets/acp/acp-guard.mjs').then(({ apply }) => apply(ctx as never, { strippedSources: [] } as never))
    const preStep = ctx.listeners.get('agent/pre-step')
    if (preStep === undefined) throw new Error('guard registered no agent/pre-step listener')
    const decision = await preStep.listener({ messages: [runtimeContext], turn: 4, step: 2 }, nextWith([runtimeContext]))
    expect(decision).toEqual({ kind: 'reject' })
  })

  it('rejects a registered tool continuation carrying a foreign message', async () => {
    const { routeBindingRegistry } = await import('../src/bridge.ts')
    routeBindingRegistry().toolResults.set('own-3', 'grep output')
    const preStep = await mountGuard()
    const ownTool = { role: 'user', source: { kind: 'tool', callId: 'own-3' }, content: [{ type: 'text', text: 'grep output' }] }
    // `goal` is a real non-stripped source: dsh-goal-round-driver builds user
    // messages with `source.kind: "goal"` for goal follow-up rounds.
    const foreign = { role: 'user', source: { kind: 'goal' }, content: [{ type: 'text', text: 'goal round prompt' }] }
    const decision = await preStep({ messages: [ownTool, foreign], turn: 4, step: 2 }, nextWith([ownTool, foreign]))
    expect(decision).toEqual({ kind: 'reject' })
  })

  it('enters with only the person when the four harness sources accompany it', async () => {
    const preStep = await mountGuard()
    const user = { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '你好' }] }
    const agentInstructions = { role: 'user', source: { kind: 'agent-instructions' }, content: [{ type: 'text', text: 'AGENTS.md digest' }] }
    const skillCatalog = { role: 'user', source: { kind: 'skill-catalog' }, content: [{ type: 'text', text: '<available_skills>' }] }
    const pluginNotice = { role: 'user', source: { kind: 'plugin' }, content: [{ type: 'text', text: 'notice' }] }
    const batch = [user, agentInstructions, skillCatalog, pluginNotice, runtimeContext]
    const decision = await preStep({ messages: batch, turn: 1, step: 1 }, nextWith(batch))
    expect(decision).toEqual({ kind: 'enter', messages: [user] })
  })

  it('keeps the person and strips runtime-context from a mixed batch', async () => {
    const preStep = await mountGuard()
    const user = { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '你好' }] }
    const decision = await preStep({ messages: [user, runtimeContext], turn: 1, step: 1 }, nextWith([user, runtimeContext]))
    expect(decision).toEqual({ kind: 'enter', messages: [user] })
  })

  it('strips the host model-switch notice so it never reaches the agent', async () => {
    const preStep = await mountGuard()
    const user = { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '你好' }] }
    const notice = {
      role: 'user',
      source: { kind: 'model-selection', form: 'notice' },
      content: [{ type: 'text', text: '[model changed: acp/beta → acp/beta@fast]' }],
    }
    const decision = await preStep({ messages: [user, notice], turn: 2, step: 1 }, nextWith([user, notice]))
    expect(decision).toEqual({ kind: 'enter', messages: [user] })
  })
})

describe('acp-guard route selection', () => {
  afterEach(async () => {
    const { routeBindingRegistry } = await import('../src/bridge.ts')
    const registry = routeBindingRegistry()
    registry.conversations.clear()
    registry.defaultModel = undefined
  })

  it('records the conversation binding as the host model selection on inbox insert', async () => {
    const listeners = await mountGuardAll()
    const inserted = listeners.get('agent/inbox/inserted')
    if (inserted === undefined) throw new Error('guard registered no agent/inbox/inserted listener')
    const { routeBindingRegistry } = await import('../src/bridge.ts')
    routeBindingRegistry().conversations.set('dsh-sel-1', 'beta@mock-model-b')
    const select = vi.fn()
    inserted.listener({ agent: { session: { id: 'dsh-sel-1' }, model: { select } } })
    expect(select).toHaveBeenCalledWith({ provider: 'acp', model: 'beta@mock-model-b' })
  })

  it('records the selection when the step claims its input, before the route is captured', async () => {
    const listeners = await mountGuardAll()
    const claimed = listeners.get('agent/inbox/claimed')
    if (claimed === undefined) throw new Error('guard registered no agent/inbox/claimed listener')
    const { routeBindingRegistry } = await import('../src/bridge.ts')
    routeBindingRegistry().conversations.set('dsh-sel-2', 'gamma')
    const select = vi.fn()
    claimed.listener({ agent: { session: { id: 'dsh-sel-2' }, model: { select } } })
    expect(select).toHaveBeenCalledWith({ provider: 'acp', model: 'gamma' })
  })

  it('falls back to the plugin default agent for a conversation nobody bound', async () => {
    const listeners = await mountGuardAll()
    const inserted = listeners.get('agent/inbox/inserted')
    if (inserted === undefined) throw new Error('guard registered no agent/inbox/inserted listener')
    const { routeBindingRegistry } = await import('../src/bridge.ts')
    routeBindingRegistry().defaultModel = 'fallback-agent'
    const select = vi.fn()
    inserted.listener({ agent: { session: { id: 'dsh-sel-3' }, model: { select } } })
    expect(select).toHaveBeenCalledWith({ provider: 'acp', model: 'fallback-agent' })
  })

  it('does nothing on hosts without agent.model (0.2.1 and older)', async () => {
    const listeners = await mountGuardAll()
    const inserted = listeners.get('agent/inbox/inserted')
    if (inserted === undefined) throw new Error('guard registered no agent/inbox/inserted listener')
    const { routeBindingRegistry } = await import('../src/bridge.ts')
    routeBindingRegistry().conversations.set('dsh-sel-4', 'beta')
    expect(() => inserted.listener({ agent: { session: { id: 'dsh-sel-4' } } })).not.toThrow()
  })

  it('never rewrites the fixed route (0.2.2+), and aligns the effort to the captured selection', async () => {
    const listeners = await mountGuardAll()
    const request = listeners.get('agent/request')
    if (request === undefined) throw new Error('guard registered no agent/request listener')
    // The plugin's selection carries no effort, so a foreign effort (e.g. from
    // a host thinking-effort plugin registered inside this row) must be gone —
    // the host compares the proposal against the captured selection.
    const acpAgent = {
      session: { id: 'dsh-sel-5' },
      model: { select: vi.fn(), current: () => ({ provider: 'acp', model: 'beta' }) },
    }
    const stripped = await request.listener(
      { agent: acpAgent },
      async () => ({ provider: 'acp', model: 'beta', maxTokens: 1024, reasoningEffort: 'high' }),
    )
    expect(stripped).toEqual({ provider: 'acp', model: 'beta', maxTokens: 1024 })

    // An UNBOUND session keeps the deployment selection's own effort: nothing
    // is stripped, because current() reports that effort.
    const deploymentAgent = {
      session: { id: 'dsh-sel-unbound' },
      model: { select: vi.fn(), current: () => ({ provider: 'deepseek', model: 'deepseek-v4', reasoningEffort: 'max' }) },
    }
    const restored = await request.listener(
      { agent: deploymentAgent },
      async () => ({ provider: 'deepseek', model: 'deepseek-v4' }),
    )
    expect(restored).toEqual({ provider: 'deepseek', model: 'deepseek-v4', reasoningEffort: 'max' })
  })

  it('still rewrites agent/request on a legacy host (0.2.1)', async () => {
    const listeners = await mountGuardAll()
    const request = listeners.get('agent/request')
    if (request === undefined) throw new Error('guard registered no agent/request listener')
    const { routeBindingRegistry } = await import('../src/bridge.ts')
    routeBindingRegistry().conversations.set('dsh-sel-6', 'beta@mock-model-b')
    const resolved = await request.listener(
      { agent: { session: { id: 'dsh-sel-6' } } },
      async () => ({ provider: 'deepseek', model: 'deepseek-v4', reasoningEffort: 'high' }),
    )
    expect(resolved).toEqual({ provider: 'acp', model: 'beta@mock-model-b' })
  })
})
