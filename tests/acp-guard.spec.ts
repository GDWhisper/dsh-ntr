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
  const listeners = new Map<string, { listener: (payload: unknown, next: () => Promise<unknown>) => Promise<unknown> }>()
  return {
    listeners,
    on: vi.fn((name: string, listener: (payload: unknown, next: () => Promise<unknown>) => Promise<unknown>) => {
      listeners.set(name, { listener })
      return () => {}
    }),
    get: vi.fn((service: string) => services[service]),
  }
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
})
