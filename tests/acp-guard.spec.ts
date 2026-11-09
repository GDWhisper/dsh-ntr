/**
 * Regression tests for the ACP preset's step gate (`agent/pre-step`).
 *
 * Issue #10: a tool-bearing turn ended as `turn/end {kind:"blocked"}` with no
 * answer. `dsh-agent-loop` records a rejection from the `agent/pre-step`
 * waterfall as `blocked`, before `step/start` — and the continuation step of a
 * card-bearing message carries NO tool result in its batch (the loop stages only
 * a tool's own `additionalContexts`; the adapter reads `deriveMessages()`), so
 * the batch is whatever the harness injected. A deny list of source kinds missed
 * one — `runtime-context` first, then the newer host's `dsh-mnemon` — and the
 * residue tripped the no-user-input refusal. The gate now keeps only `user`,
 * `tool` and source-less messages, so an injection it has never heard of cannot
 * end a turn.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { BACKGROUND_REPORT_FORM, BACKGROUND_REPORT_SOURCE } from '../src/bridge.ts'

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

/** The memory recalls a newer host folds into every step (issue #10's residue). */
const mnemonInstructions = {
  role: 'user',
  source: { kind: 'dsh-mnemon', form: 'instructions' },
  content: [{ type: 'text', text: 'Remembered instructions.' }],
}
const mnemonRecall = {
  role: 'user',
  source: { kind: 'dsh-mnemon', form: 'recall' },
  content: [{ type: 'text', text: 'Recalled notes.' }],
}

describe('acp-guard pre-step source filtering', () => {
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

  it('enters the continuation step of a card-bearing message on a host with memory recalls', async () => {
    // Issue #10 exactly: nothing was claimed for this step, two `dsh-mnemon`
    // rows rode the waterfall, and the loop appended its own runtime-context
    // projection. Refusing it ended the whole turn as `blocked`.
    const preStep = await mountGuard()
    const batch = [mnemonInstructions, mnemonRecall, runtimeContext]
    const decision = await preStep({ messages: [], turn: 1, step: 2 }, nextWith(batch))
    expect(decision).toEqual({ kind: 'enter', messages: [] })
  })

  it('drops an injection kind it has never heard of', async () => {
    const preStep = await mountGuard()
    const future = { role: 'user', source: { kind: 'some-future-host-section' }, content: [{ type: 'text', text: '?' }] }
    const decision = await preStep({ messages: [], turn: 2, step: 1 }, nextWith([future]))
    expect(decision).toEqual({ kind: 'enter', messages: [] })
  })

  it('keeps the plugin background-report wake message', async () => {
    // The bridge injects this message to open a driver step for an IDLE
    // background drain; the adapter answers it locally. The gate must let it
    // through (it is neither the person nor a tool result, but it IS this
    // plugin's own turn seed).
    const preStep = await mountGuard()
    const wake = {
      role: 'user',
      source: { kind: BACKGROUND_REPORT_SOURCE, form: 'notice', report: 'DISPATCH-FINAL-ANSWER' },
      content: [{ type: 'text', text: 'Background task completed.' }],
    }
    const decision = await preStep({ messages: [], turn: 3, step: 1 }, nextWith([wake]))
    expect(decision).toEqual({ kind: 'enter', messages: [wake] })
  })

  it('drops a notice that only borrows the wake kind', async () => {
    // The wake predicate requires the notice form: our own kind alone (another
    // producer reusing it, or a future message without a form) stays context.
    const preStep = await mountGuard()
    const notice = {
      role: 'user',
      source: { kind: BACKGROUND_REPORT_SOURCE },
      content: [{ type: 'text', text: 'notice' }],
    }
    const decision = await preStep({ messages: [], turn: 2, step: 1 }, nextWith([notice]))
    expect(decision).toEqual({ kind: 'enter', messages: [] })
  })

  it('keeps a wake whose report was lost (form matches, report missing)', async () => {
    // The host pipeline can strip `source.report`. The gate must still let the
    // wake through so `streamPrompt` can close the step LOCALLY (one line +
    // one notice) instead of falling through to the forward picker — a
    // duplicated prompt that might re-dispatch the work. The predicate is
    // shape-only: kind + form.
    const preStep = await mountGuard()
    const wake = {
      role: 'user',
      source: { kind: BACKGROUND_REPORT_SOURCE, form: BACKGROUND_REPORT_FORM },
      content: [{ type: 'text', text: 'Background task completed.' }],
    }
    const decision = await preStep({ messages: [], turn: 3, step: 1 }, nextWith([wake]))
    expect(decision).toEqual({ kind: 'enter', messages: [wake] })
  })

  it('drops a notice whose form is not the wake form', async () => {
    // The kind alone must never be enough: a checkpoint carrying a
    // report-looking payload in a different form stays context.
    const preStep = await mountGuard()
    const notice = {
      role: 'user',
      source: { kind: BACKGROUND_REPORT_SOURCE, form: 'checkpoint', report: 'X' },
      content: [{ type: 'text', text: 'notice' }],
    }
    const decision = await preStep({ messages: [], turn: 2, step: 1 }, nextWith([notice]))
    expect(decision).toEqual({ kind: 'enter', messages: [] })
  })

  it('drops a wake-shaped message that is not a user message', async () => {
    // R3: the bridge's own predicate (`isBackgroundWakeMessage`) requires
    // `role === 'user'`; the guard must agree. A wake-shaped row under another
    // role — or with no role at all — is context, not this plugin's turn seed,
    // and stays stripped.
    const preStep = await mountGuard()
    const assistantWake = {
      role: 'assistant',
      source: { kind: BACKGROUND_REPORT_SOURCE, form: BACKGROUND_REPORT_FORM, report: 'X' },
      content: [{ type: 'text', text: 'Background task completed.' }],
    }
    const rolelessWake = {
      source: { kind: BACKGROUND_REPORT_SOURCE, form: BACKGROUND_REPORT_FORM, report: 'X' },
      content: [{ type: 'text', text: 'Background task completed.' }],
    }
    const decision = await preStep({ messages: [], turn: 2, step: 1 }, nextWith([assistantWake, rolelessWake]))
    expect(decision).toEqual({ kind: 'enter', messages: [] })
  })

  it('keeps a staged tool result and drops the injections around it', async () => {
    const preStep = await mountGuard()
    const staged = { role: 'tool', toolCallId: 'call-1', source: { kind: 'tool', callId: 'call-1' }, content: [{ type: 'text', text: 'grep output' }] }
    const decision = await preStep({ messages: [], turn: 4, step: 2 }, nextWith([staged, mnemonRecall, runtimeContext]))
    expect(decision).toEqual({ kind: 'enter', messages: [staged] })
  })

  it('keeps a tool result whose call id the bridge never recorded', async () => {
    // The gate is not the authority on whether a continuation is ours: the
    // adapter decides from the transcript (`isAcpToolContinuation`) and closes
    // with one pointer line when no turn of ours is live. Refusing here instead
    // would end the turn.
    const preStep = await mountGuard()
    const unknown = { role: 'tool', toolCallId: 'not-ours', source: { kind: 'tool', callId: 'not-ours' }, content: [{ type: 'text', text: '?' }] }
    const decision = await preStep({ messages: [], turn: 4, step: 2 }, nextWith([unknown]))
    expect(decision).toEqual({ kind: 'enter', messages: [unknown] })
  })

  it('keeps a hand-built message that carries no source', async () => {
    const preStep = await mountGuard()
    const bare = { role: 'user', content: [{ type: 'text', text: '你好' }] }
    const decision = await preStep({ messages: [bare], turn: 1, step: 1 }, nextWith([bare]))
    expect(decision).toEqual({ kind: 'enter', messages: [bare] })
  })

  it('enters with only the person when the harness sources accompany it', async () => {
    const preStep = await mountGuard()
    const user = { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '你好' }] }
    const agentInstructions = { role: 'user', source: { kind: 'agent-instructions' }, content: [{ type: 'text', text: 'AGENTS.md digest' }] }
    const skillCatalog = { role: 'user', source: { kind: 'skill-catalog' }, content: [{ type: 'text', text: '<available_skills>' }] }
    const pluginNotice = { role: 'user', source: { kind: 'plugin' }, content: [{ type: 'text', text: 'notice' }] }
    const batch = [user, agentInstructions, skillCatalog, pluginNotice, mnemonInstructions, mnemonRecall, runtimeContext]
    const decision = await preStep({ messages: batch, turn: 1, step: 1 }, nextWith(batch))
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

  it('rejects a runtime-context-only batch when strippedSources is empty', async () => {
    // The debug hatch replaces the allow list, and with it comes the refusal
    // for a batch left holding nothing an ACP turn could be about.
    const ctx = guardCtx()
    await import('../presets/acp/acp-guard.mjs').then(({ apply }) => apply(ctx as never, { strippedSources: [] } as never))
    const preStep = ctx.listeners.get('agent/pre-step')
    if (preStep === undefined) throw new Error('guard registered no agent/pre-step listener')
    const decision = await preStep.listener({ messages: [runtimeContext], turn: 4, step: 2 }, nextWith([runtimeContext]))
    expect(decision).toEqual({ kind: 'reject' })
  })

  it('rejects a foreign batch under an explicit deny list that keeps it', async () => {
    const ctx = guardCtx()
    await import('../presets/acp/acp-guard.mjs').then(({ apply }) => apply(ctx as never, { strippedSources: ['skill-catalog'] } as never))
    const preStep = ctx.listeners.get('agent/pre-step')
    if (preStep === undefined) throw new Error('guard registered no agent/pre-step listener')
    // `goal` is a real non-stripped source: dsh-goal-round-driver builds user
    // messages with `source.kind: "goal"` for goal follow-up rounds.
    const foreign = { role: 'user', source: { kind: 'goal' }, content: [{ type: 'text', text: 'goal round prompt' }] }
    const decision = await preStep.listener({ messages: [foreign], turn: 4, step: 2 }, nextWith([foreign]))
    expect(decision).toEqual({ kind: 'reject' })
  })

  it('passes a downstream rejection through untouched', async () => {
    const preStep = await mountGuard()
    const decision = await preStep({ messages: [], turn: 1, step: 1 }, async () => ({ kind: 'reject' as const }))
    expect(decision).toEqual({ kind: 'reject' })
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
