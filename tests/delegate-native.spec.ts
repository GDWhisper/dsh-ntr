/**
 * The NATIVE async shell and its registration seam
 * (docs/plan/acp-delegate-native-subagent.md §2 / §5): immediate activation
 * receipts, pre-activation validation, explicit capacity/auth refusals, the
 * shell selection at registration (including hot re-judgement and the
 * old-host synchronous fallback), and the degraded `off` intercept in both
 * shapes. The fake `ctx.subagents` follows the host contract: fresh controller
 * signal per activation, absolute cwd, receipt result distinct from the
 * provider run result, capacity refusal without queueing.
 */
import { describe, expect, it } from 'vitest'
import { AcpSubagentProvider, acpDelegateActivationExecute, type DelegateSubagentsLike } from '../src/bridge/delegate-provider.ts'
import { AcpDelegateRegistration, type DelegateRegistrationCtx } from '../src/bridge/delegate-registration.ts'
import { AcpDelegateService, acpDelegateToolDefinition, GUIDANCE_PREFIX, NATIVE_BASE_DESCRIPTION } from '../src/bridge/delegate-service.ts'
import { delegateLabel } from '../src/impl.ts'
import type { AcpDelegateAsyncOutput, DelegateGuidance } from '../src/protocol.ts'
import { configOptionsOf, fakeMask, fakeSubagentsService, fakeToolsCtx, happyPrompt, makeHost, modesOf, tick } from './delegate-harness.ts'

const execWithAgent = { agent: { session: { header: { cwd: 'M:/Coding/main-project' } } }, signal: new AbortController().signal }

describe('acp_delegate native activation shell', () => {
  it('returns the name IMMEDIATELY — the receipt result is never awaited', async () => {
    const f = makeHost()
    const { service, specs } = fakeSubagentsService({ hangResult: true })
    const execute = acpDelegateActivationExecute({ service: new AcpDelegateService(f.host), subagents: service })
    const value = await execute({ task: 'do it', agent: 'alpha' }, execWithAgent)
    expect(value).toEqual({ kind: 'activation', name: 'agent-1', agent: 'alpha' })
    expect(specs).toHaveLength(1)
    const spec = specs[0]
    expect(spec.provider).toBe('acp')
    expect(spec.label).toBe('alpha: do it')
    expect(spec.prompt).toEqual([{ type: 'text', text: 'do it' }])
    expect(spec.delivery).toBe('parent')
    expect(spec.parent).toBe(execWithAgent.agent)
    expect(spec.signal).toBe(execWithAgent.signal)
    expect(spec.cwd).toBe('M:/Coding/main-project')
    // No capability fields ever ride along (the host would refuse them).
    expect(spec).not.toHaveProperty('agentOptions')
    expect(spec).not.toHaveProperty('outputSchema')
    expect(spec).not.toHaveProperty('maxDepth')
    expect(spec).not.toHaveProperty('agentPreset')
    // The delegation core never ran: activation is the provider's job.
    expect(f.calls.startSession).toHaveLength(0)
  })

  it('cwd: explicit wins, omitted inherits the session workspace, absent header omits cwd', async () => {
    const f = makeHost()
    const { service, specs } = fakeSubagentsService({ hangResult: true })
    const execute = acpDelegateActivationExecute({ service: new AcpDelegateService(f.host), subagents: service })
    await execute({ task: 'x', agent: 'alpha', cwd: 'M:/Coding/main-project/sub' }, execWithAgent)
    expect(specs[0].cwd).toBe('M:/Coding/main-project/sub')
    // A live agent without a usable header cwd: the spec omits cwd and the
    // host resolves the parent's own working directory at materialization.
    await execute({ task: 'x', agent: 'alpha' }, { agent: { session: { header: {} } } })
    expect(specs[1].cwd).toBeUndefined()
  })

  it('the label carries only the task first line', async () => {
    const f = makeHost()
    const { service, specs } = fakeSubagentsService({ hangResult: true })
    const execute = acpDelegateActivationExecute({ service: new AcpDelegateService(f.host), subagents: service })
    await execute({ task: 'first line\nsecond line', agent: 'beta' }, execWithAgent)
    expect(specs[0].label).toBe('beta: first line')
    expect(specs[0].prompt).toEqual([{ type: 'text', text: 'first line\nsecond line' }])
  })

  it('pre-validation refuses BEFORE any activation: bad task, unknown agent, no default', async () => {
    const f = makeHost()
    const { service, specs } = fakeSubagentsService()
    const execute = acpDelegateActivationExecute({ service: new AcpDelegateService(f.host), subagents: service })
    expect(await execute({ task: '' }, {})).toMatchObject({ kind: 'error', error: 'acp_delegate: task must be a non-empty string' })
    expect(await execute({ task: 'x', agent: 'nope' }, {})).toMatchObject({ kind: 'error', error: 'acp_delegate: unknown agent "nope" (configured: alpha, beta, codebuddy)' })
    f.setDefault(undefined)
    expect(await execute({ task: 'x' }, {})).toMatchObject({ kind: 'error' })
    expect(specs).toHaveLength(0)
    // A resolved refusal names the agent it resolved.
    f.setDefault('alpha')
    const { service: failing, specs: failedSpecs } = fakeSubagentsService({ failWith: new Error('boom') })
    const execute2 = acpDelegateActivationExecute({ service: new AcpDelegateService(f.host), subagents: failing })
    expect(await execute2({ task: 'x', agent: 'alpha' }, execWithAgent)).toEqual({ kind: 'error', error: 'boom', agent: 'alpha' })
    expect(failedSpecs).toHaveLength(1)
  })

  it('a missing exec.agent is an explicit error, never a thrown execute', async () => {
    const f = makeHost()
    const { service, specs } = fakeSubagentsService()
    const execute = acpDelegateActivationExecute({ service: new AcpDelegateService(f.host), subagents: service })
    const value = await execute({ task: 'x', agent: 'alpha' }, {})
    expect(value.kind).toBe('error')
    expect((value as { error: string }).error).toContain('requires the calling agent')
    expect(specs).toHaveLength(0)
  })

  it('capacity / authorization / provider refusals surface their typed codes to the model', async () => {
    const f = makeHost()
    const cases = [
      { code: 'ACTIVATION_LIMIT_REACHED', message: 'subagent capacity reached' },
      { code: 'UNAUTHORIZED', message: 'subagent creation requires the exact live parent agent' },
      { code: 'NO_PROVIDER', message: 'no subagent provider registered for "acp"' },
    ]
    for (const refusal of cases) {
      const { service } = fakeSubagentsService({ failWith: Object.assign(new Error(refusal.message), { code: refusal.code }) })
      const execute = acpDelegateActivationExecute({ service: new AcpDelegateService(f.host), subagents: service })
      const value = await execute({ task: 'x', agent: 'alpha' }, execWithAgent) as { kind: string; error: string; agent?: string }
      expect(value.kind).toBe('error')
      expect(value.error).toContain(refusal.code)
      expect(value.error).toContain(refusal.message)
      expect(value.agent).toBe('alpha')
    }
  })

  it('full fake chain: activation → provider run → settlement; dispose interrupts to aborted', async () => {
    const f = makeHost()
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    f.onPrompt(async (sessionId) => {
      await gate
      f.emit({ type: 'session/update', sessionId, seq: 1, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'native answer' } } })
      f.emit({ type: 'turn/end', sessionId, turnId: 't', stopReason: 'end_turn' })
      return { turnId: 't' }
    })
    const { service, receipts } = fakeSubagentsService()
    service.registerProvider(new AcpSubagentProvider({ service: new AcpDelegateService(f.host) }))
    const execute = acpDelegateActivationExecute({ service: new AcpDelegateService(f.host), subagents: service })
    const value = await execute({ task: 'do it', agent: 'alpha' }, execWithAgent)
    expect(value).toMatchObject({ kind: 'activation', name: 'agent-1' })
    await tick()
    expect(f.calls.prompt).toHaveLength(1) // the child is really running
    release()
    const result = await receipts[0].result
    expect(result).toEqual({ output: [{ type: 'text', text: 'native answer' }], stopReason: 'completed' })

    // A second delegation, interrupted through the receipt dispose.
    f.onPrompt(() => new Promise(() => {}))
    const second = await execute({ task: 'long task', agent: 'alpha' }, execWithAgent)
    expect(second).toMatchObject({ kind: 'activation', name: 'agent-2' })
    await tick()
    await receipts[1].dispose()
    expect((await receipts[1].result).stopReason).toBe('aborted')
  })

  it('capacity refusal when the shared pool is full (no queueing)', async () => {
    const f = makeHost()
    const { service } = fakeSubagentsService({ hangResult: true, capacity: 2 })
    service.registerProvider(new AcpSubagentProvider({ service: new AcpDelegateService(f.host) }))
    const execute = acpDelegateActivationExecute({ service: new AcpDelegateService(f.host), subagents: service })
    expect(await execute({ task: 'one', agent: 'alpha' }, execWithAgent)).toMatchObject({ kind: 'activation' })
    expect(await execute({ task: 'two', agent: 'alpha' }, execWithAgent)).toMatchObject({ kind: 'activation' })
    const third = await execute({ task: 'three', agent: 'alpha' }, execWithAgent) as { kind: string; error: string }
    expect(third.kind).toBe('error')
    expect(third.error).toContain('ACTIVATION_LIMIT_REACHED')
  })
})

// ---- registration shell selection (§5) ----

function makeRegistration(ctx: DelegateRegistrationCtx, subagents?: () => DelegateSubagentsLike | undefined) {
  const f = makeHost()
  const config = { guidance: 'off' as DelegateGuidance, timeoutMs: 600_000 }
  const mask = fakeMask()
  const notices: string[] = []
  const registration = new AcpDelegateRegistration({
    ctx,
    service: new AcpDelegateService(f.host),
    config: () => ({ ...config }),
    forceMask: mask,
    notify: text => { notices.push(text) },
    ...(subagents === undefined ? {} : { subagents }),
  })
  return { registration, config, mask, notices, f }
}

describe('acp_delegate registration shell selection', () => {
  it('no seam (old host): the LEGACY synchronous shell registers, full text with footer', async () => {
    const tools = fakeToolsCtx()
    tools.install()
    const { registration, config, f } = makeRegistration(tools.ctx)
    config.guidance = 'on'
    registration.sync()
    const definition = tools.registered[0].definition
    expect(definition.description).toContain('并返回它最后给出的答复')
    expect(definition.description).not.toContain('结算通知')
    expect(definition.output?.schema.required).toEqual(['text'])
    happyPrompt(f, 'legacy answer')
    const value = await definition.execute({ task: 'x', agent: 'alpha' }, {})
    expect(value.text).toContain('legacy answer')
    expect(value.text).toContain('— acp_delegate · alpha · cwd=/agent-default · end_turn')
  })

  it('seam present: the NATIVE shell registers with async wording and the activation schema', async () => {
    const tools = fakeToolsCtx()
    tools.install()
    const { service } = fakeSubagentsService({ hangResult: true })
    const { registration, config, f } = makeRegistration(tools.ctx, () => service)
    // The entry wiring registers the provider before the tool syncs.
    service.registerProvider(new AcpSubagentProvider({ service: new AcpDelegateService(f.host) }))
    config.guidance = 'on'
    registration.sync()
    const definition = tools.registered[0].definition
    expect(definition.description).toBe(NATIVE_BASE_DESCRIPTION)
    expect(definition.description).toContain('立即返回子代理的 name')
    expect(definition.description).toContain('结算通知')
    // The end-turn duty is now the host's own soft rule ("continue useful work,
    // end the turn only when waiting is all that is left"), not a plugin ban.
    expect(definition.description).toContain('只剩等待时结束本回合')
    // Nothing else kept the old ban from creeping back; this does.
    expect(definition.description).not.toMatch(/派发后(必须|立即)结束/)
    expect(definition.description).not.toContain('优先于任何原生子代理/委派工具')
    expect(definition.output?.schema.required).toEqual(['kind'])
    const value = await definition.execute({ task: 'x', agent: 'alpha' }, execWithAgent) as unknown as AcpDelegateAsyncOutput
    expect(value).toEqual({ kind: 'activation', name: 'agent-1', agent: 'alpha' })
    // enhanced/force PREPEND the native MUST sentence; the end-turn rule stays in the base.
    for (const guidance of ['enhanced', 'force'] as const) {
      config.guidance = guidance
      registration.sync()
      expect(tools.registered[0].definition.description).toBe(GUIDANCE_PREFIX + NATIVE_BASE_DESCRIPTION)
    }
  })

  it('the native render speaks the delegation receipt and the refusal', () => {
    const definition = acpDelegateToolDefinition({ guidance: 'on', mode: 'native', execute: async () => ({ kind: 'activation', name: 'agent-1', agent: 'alpha' }) })
    expect(definition.output.render({}, { kind: 'activation', name: 'agent-1', agent: 'alpha' }))
      .toEqual([{ type: 'text', text: '已委派给 ACP agent alpha：子代理 agent-1 已在后台开始执行。可继续做不相交的工作；只剩等待时结束本回合，完成后宿主会把它的答复作为通知送达本会话。' }])
    expect(definition.output.render({}, { kind: 'error', error: 'ACTIVATION_LIMIT_REACHED: full' }))
      .toEqual([{ type: 'text', text: 'acp_delegate 委派失败：ACTIVATION_LIMIT_REACHED: full' }])
    expect(definition.output.render({}, undefined)).toEqual([{ type: 'text', text: '' }])
  })

  it('a late subagents seam re-judges the shell through the inject seam', () => {
    const tools = fakeToolsCtx()
    tools.install()
    let seam: DelegateSubagentsLike | undefined
    const { registration, config } = makeRegistration(tools.ctx, () => seam)
    config.guidance = 'on'
    registration.sync()
    expect(tools.registered[0].definition.description).toContain('并返回它最后给出的答复') // legacy first
    expect(tools.namedInjectArmed('subagents')).toBe(true)
    seam = fakeSubagentsService({ hangResult: true }).service
    tools.fireNamedInject('subagents')
    expect(tools.disposerCalls()).toBe(1) // the legacy insertion was replaced
    expect(tools.registered).toHaveLength(1)
    expect(tools.registered[0].definition.description).toContain('立即返回子代理的 name')
  })

  it('guidance hot-reload re-judges the seam; off unregisters in both shells', () => {
    const tools = fakeToolsCtx()
    tools.install()
    let seam: DelegateSubagentsLike | undefined = fakeSubagentsService({ hangResult: true }).service
    const { registration, config } = makeRegistration(tools.ctx, () => seam)
    config.guidance = 'on'
    registration.sync()
    expect(tools.registered[0].definition.description).toContain('立即返回子代理的 name')
    // The seam disappears (host downgrade / service unload): a guidance change
    // re-registers the legacy shell.
    seam = undefined
    config.guidance = 'enhanced'
    registration.sync()
    expect(tools.disposerCalls()).toBe(1)
    expect(tools.registered[0].definition.description).toContain('并返回它最后给出的答复')
    expect(tools.registered[0].definition.description).toContain('优先于任何原生子代理/委派工具')
    config.guidance = 'off'
    registration.sync()
    expect(tools.registered).toHaveLength(0)
  })

  it('degraded native registration answers off in the async shape', async () => {
    const tools = fakeToolsCtx('none')
    tools.install()
    const { service } = fakeSubagentsService({ hangResult: true })
    const { registration, config, f } = makeRegistration(tools.ctx, () => service)
    config.guidance = 'on'
    registration.sync()
    const definition = tools.registered[0].definition
    config.guidance = 'off'
    registration.sync() // cannot remove; the wrapper must intercept
    expect(tools.registered).toHaveLength(1)
    const value = await definition.execute({ task: 'x' }, {}) as unknown as AcpDelegateAsyncOutput
    expect(value).toEqual({ kind: 'error', error: 'acp_delegate is disabled' })
    expect(f.calls.startSession).toHaveLength(0)
  })

  it('when still excludes NTR sessions on the native shell', () => {
    const tools = fakeToolsCtx()
    tools.install()
    const { service } = fakeSubagentsService({ hangResult: true })
    const { registration, config } = makeRegistration(tools.ctx, () => service)
    config.guidance = 'force'
    registration.sync()
    const when = tools.registered[0].options?.when
    expect(when!({ agent: { session: { header: { agentPreset: 'acp' } } } })).toBe(false)
    expect(when!({ agent: { session: { header: { agentPreset: 'standard' } } } })).toBe(true)
    expect(when!({})).toBe(true)
  })
})

// ---- four-axis customization: the label carrier end to end (T2) ----

describe('acp_delegate native choice carrier (execute → start → begin)', () => {
  it('execute encodes the explicit choices into the activation label; the prompt stays the task', async () => {
    const f = makeHost()
    const { service, specs } = fakeSubagentsService({ hangResult: true })
    const execute = acpDelegateActivationExecute({ service: new AcpDelegateService(f.host), subagents: service })
    const choices = { model: 'm2', effort: 'high', mode: 'strict' }
    const value = await execute({ task: 'do it', agent: 'alpha', ...choices }, execWithAgent)
    expect(value).toMatchObject({ kind: 'activation', agent: 'alpha' })
    expect(specs[0].label).toBe(delegateLabel('alpha', 'do it', choices))
    expect(specs[0].label).toBe('alpha ⟦m=m2&e=high&o=strict⟧: do it')
    expect(specs[0].prompt).toEqual([{ type: 'text', text: 'do it' }])
    // No choices: the label stays byte-identical to the original format.
    await execute({ task: 'plain', agent: 'alpha' }, execWithAgent)
    expect(specs[1].label).toBe('alpha: plain')
  })

  it('the full chain applies the carried choices as writes before the prompt', async () => {
    const f = makeHost()
    f.liveOptions.set('session-1', { configOptions: configOptionsOf(['m1', 'm2'], ['high', 'low']), modes: modesOf('default', 'strict') })
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    f.onPrompt(async (sessionId) => {
      await gate
      f.emit({ type: 'session/update', sessionId, seq: 1, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'chosen answer' } } })
      f.emit({ type: 'turn/end', sessionId, turnId: 't', stopReason: 'end_turn' })
      return { turnId: 't' }
    })
    const { service, receipts } = fakeSubagentsService()
    service.registerProvider(new AcpSubagentProvider({ service: new AcpDelegateService(f.host) }))
    const execute = acpDelegateActivationExecute({ service: new AcpDelegateService(f.host), subagents: service })
    const value = await execute({ task: 'do it', agent: 'alpha', model: 'm2', effort: 'low', mode: 'strict' }, execWithAgent)
    expect(value).toMatchObject({ kind: 'activation', name: 'agent-1' })
    await tick()
    // The provider decoded the carrier and the core applied every axis in order.
    expect(f.calls.setMode).toEqual([{ sessionId: 'session-1', modeId: 'strict' }])
    expect(f.calls.setConfig).toEqual([
      { sessionId: 'session-1', configId: 'model', value: 'm2' },
      { sessionId: 'session-1', configId: 'thought', value: 'low' },
    ])
    expect(f.order.lastIndexOf('setConfig')).toBeLessThan(f.order.indexOf('prompt'))
    expect(f.calls.prompt).toEqual([{ sessionId: 'session-1', text: 'do it' }])
    release()
    const result = await receipts[0].result
    expect(result).toEqual({ output: [{ type: 'text', text: 'chosen answer' }], stopReason: 'completed' })
    expect(f.notices).toEqual([]) // every pick was live: nothing degraded
  })

  it('a stale explicit choice in the carrier settles error through the host notification path', async () => {
    const f = makeHost()
    f.liveOptions.set('session-1', { configOptions: configOptionsOf(['m1']), modes: modesOf('default') })
    const { service, receipts } = fakeSubagentsService()
    service.registerProvider(new AcpSubagentProvider({ service: new AcpDelegateService(f.host) }))
    const execute = acpDelegateActivationExecute({ service: new AcpDelegateService(f.host), subagents: service })
    // Pre-validation passes (the shape is legal); the LIVE check at run time
    // is what refuses — the activation exists, its result carries the error.
    const value = await execute({ task: 'do it', agent: 'alpha', model: 'ghost' }, execWithAgent)
    expect(value).toMatchObject({ kind: 'activation' })
    const result = await receipts[0].result
    expect(result.stopReason).toBe('error')
    expect(result.diagnostic).toContain('does not offer model "ghost"')
    expect(f.calls.prompt).toHaveLength(0)
    expect(f.calls.close).toEqual(['session-1'])
  })
})