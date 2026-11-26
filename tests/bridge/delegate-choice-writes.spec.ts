/**
 * The delegation core's four-axis choice runtime (T2), on the shared
 * in-memory fake host — no child process, millisecond-scale. Split out of
 * tests/delegate.spec.ts when the size ratchet refused a >1000-line file;
 * lives beside the settings-layer spec (the other fake-host suite in this
 * directory). The real-process end-to-end twin is delegate-choices.spec.ts;
 * the pure planners themselves are pinned by tests/impl/delegate-choices.spec.ts.
 *
 * Pins: the agent resolution chain (explicit > delegate default > global
 * default) with the deleted-default degradation note; choice argument shape
 * validation; explicit stale model/mode as fatal prompt-error settlements
 * (nothing applied, no prompt); stale configured defaults degrading with ONE
 * merged notice while the task still runs; effort's soft drop; the
 * mode → model → effort write order with the effort re-read against the
 * REFRESHED live options; runtime write failures as errors (never fallback);
 * the configured map surviving a fallback untouched; and the degradation
 * notice filed under the DELEGATED agent, never the global default.
 */
import { describe, expect, it } from 'vitest'
import { AcpDelegateService } from '../../src/bridge/delegate-service.ts'
import { configOptionsOf, happyPrompt, makeHost, modesOf } from '../delegate-harness.ts'

// ---- four-axis customization: agent chain (T2) ----

describe('acp_delegate agent resolution chain', () => {
  it('explicit agent outranks the delegate default and the global default', async () => {
    const f = makeHost()
    f.config.defaultAgent = 'beta'
    happyPrompt(f)
    const result = await new AcpDelegateService(f.host).execute({ task: 'x', agent: 'alpha' }, {})
    expect(f.calls.startSession[0].agentId).toBe('alpha')
    expect(result.notes).toBeUndefined()
    expect(f.notices).toEqual([])
  })

  it('the delegate default outranks the global default while still configured', async () => {
    const f = makeHost()
    f.config.defaultAgent = 'beta'
    happyPrompt(f)
    const result = await new AcpDelegateService(f.host).execute({ task: 'x' }, {})
    expect(f.calls.startSession[0].agentId).toBe('beta')
    expect(result.notes).toBeUndefined()
    expect(f.notices).toEqual([])
  })

  it('a deleted delegate default degrades to the global default with ONE note', async () => {
    const f = makeHost()
    f.config.defaultAgent = 'ghost'
    happyPrompt(f, 'degraded but running')
    const result = await new AcpDelegateService(f.host).execute({ task: 'x' }, {})
    expect(f.calls.startSession[0].agentId).toBe('alpha')
    const note = 'default agent "ghost" no longer exists; using the global default "alpha"'
    expect(result.notes).toBe(note)
    expect(result.text).toContain(`\nnotes: ${note}`)
    expect(f.notices).toEqual([note])
  })

  it('a deleted delegate default with no global default is the plain no-default error, no note', async () => {
    const f = makeHost()
    f.config.defaultAgent = 'ghost'
    f.setDefault(undefined)
    await expect(new AcpDelegateService(f.host).execute({ task: 'x' }, {}))
      .rejects.toThrow('acp_delegate: no default agent configured; name one explicitly (configured: alpha, beta, codebuddy)')
    expect(f.calls.startSession).toHaveLength(0)
    expect(f.notices).toEqual([])
  })

  it('resolve carries the agent-axis note and the explicit choices', () => {
    const f = makeHost()
    f.config.defaultAgent = 'ghost'
    const service = new AcpDelegateService(f.host)
    const resolved = service.resolve({ task: 'x', model: 'm1', effort: 'high', mode: 'strict' }, {})
    expect(resolved.agentId).toBe('alpha')
    expect(resolved.choices).toEqual({ model: 'm1', effort: 'high', mode: 'strict' })
    expect(resolved.notes).toEqual(['default agent "ghost" no longer exists; using the global default "alpha"'])
    // No choices named: an empty set, never undefined keys.
    expect(service.resolve({ task: 'x', agent: 'beta' }, {}).choices).toEqual({})
    expect(service.resolve({ task: 'x', agent: 'beta' }, {}).notes).toEqual([])
  })
})

describe('acp_delegate choice argument validation', () => {
  it('rejects a present-but-empty or non-string choice axis before any session', () => {
    const f = makeHost()
    const service = new AcpDelegateService(f.host)
    for (const key of ['model', 'effort', 'mode'] as const) {
      for (const value of ['', 42, null, {}]) {
        expect(() => service.resolve({ task: 'x', [key]: value }, {})).toThrow(`acp_delegate: ${key} must be a non-empty string`)
      }
    }
    expect(f.calls.startSession).toHaveLength(0)
  })
})

// ---- four-axis customization: choice planning at run time (T2) ----

describe('acp_delegate choice writes', () => {
  it('explicit stale mode: prompt-error settlement, session closed, NO prompt and NO writes', async () => {
    const f = makeHost()
    f.liveOptions.set('session-1', { configOptions: configOptionsOf(['m1']), modes: modesOf('default', 'strict') })
    const settlement = await new AcpDelegateService(f.host).begin({ task: 'x', agent: 'alpha', mode: 'ghost' }, {}).result
    expect(settlement.outcome).toBe('prompt-error')
    expect(settlement.error).toBe('acp_delegate: agent "alpha" does not offer mode "ghost" (available: default, strict)')
    expect(f.calls.prompt).toHaveLength(0)
    expect(f.calls.setMode).toEqual([])
    expect(f.calls.setConfig).toEqual([])
    expect(f.calls.cancel).toEqual([]) // nothing was dispatched
    expect(f.calls.close).toEqual(['session-1'])
    expect(f.sinkCount()).toBe(0)
  })

  it('explicit stale model: prompt-error settlement, session closed, NO prompt', async () => {
    const f = makeHost()
    f.liveOptions.set('session-1', { configOptions: configOptionsOf(['m1', 'm2']), modes: modesOf('default') })
    const settlement = await new AcpDelegateService(f.host).begin({ task: 'x', agent: 'alpha', model: 'ghost' }, {}).result
    expect(settlement.outcome).toBe('prompt-error')
    expect(settlement.error).toBe('acp_delegate: agent "alpha" does not offer model "ghost" (available: m1, m2)')
    expect(f.calls.prompt).toHaveLength(0)
    expect(f.calls.close).toEqual(['session-1'])
  })

  it('an unpublished axis is fatal for an explicit pick too', async () => {
    for (const [args, message] of [
      [{ mode: 'strict' }, 'acp_delegate: agent "alpha" does not publish mode selection'],
      [{ model: 'm1' }, 'acp_delegate: agent "alpha" does not publish model selection'],
    ] as Array<[Record<string, string>, string]>) {
      const f = makeHost() // no live options at all
      const settlement = await new AcpDelegateService(f.host).begin({ task: 'x', agent: 'alpha', ...args }, {}).result
      expect(settlement.outcome).toBe('prompt-error')
      expect(settlement.error).toBe(message)
      expect(f.calls.prompt).toHaveLength(0)
      expect(f.calls.close).toEqual(['session-1'])
    }
  })

  it('fatal applies NOTHING: a plannable configured mode is not written when the explicit model is fatal', async () => {
    const f = makeHost()
    f.config.agentDefaults = { alpha: { mode: 'strict' } }
    f.liveOptions.set('session-1', { configOptions: configOptionsOf(['m1']), modes: modesOf('default', 'strict') })
    const settlement = await new AcpDelegateService(f.host).begin({ task: 'x', agent: 'alpha', model: 'ghost' }, {}).result
    expect(settlement.outcome).toBe('prompt-error')
    expect(f.calls.setMode).toEqual([])
    expect(f.calls.prompt).toHaveLength(0)
  })

  it('the legacy shell throws the fatal choice error after closing the session', async () => {
    const f = makeHost()
    f.liveOptions.set('session-1', { modes: modesOf('default') })
    await expect(new AcpDelegateService(f.host).execute({ task: 'x', agent: 'alpha', mode: 'ghost' }, {}))
      .rejects.toThrow('acp_delegate: agent "alpha" does not offer mode "ghost" (available: default)')
    expect(f.calls.prompt).toHaveLength(0)
    expect(f.calls.close).toEqual(['session-1'])
  })

  it('stale configured model/mode/effort: the task STILL runs, one merged notify, settlement.notes', async () => {
    const f = makeHost()
    f.config.agentDefaults = { alpha: { model: 'ghost-m', effort: 'ghost-e', mode: 'ghost-o' } }
    f.liveOptions.set('session-1', { configOptions: configOptionsOf(['m1', 'm2'], ['high']), modes: modesOf('default', 'strict') })
    happyPrompt(f, 'still runs')
    const settlement = await new AcpDelegateService(f.host).begin({ task: 'x', agent: 'alpha' }, {}).result
    expect(settlement.outcome).toBe('ended')
    expect(settlement.text).toBe('still runs')
    const notes = [
      'agent "alpha" no longer offers default mode "ghost-o" — using the startup mode',
      'agent "alpha" no longer offers default model "ghost-m" — using its own default model',
      'agent "alpha" default thought level "ghost-e" is not supported by the current model — not setting it',
    ].join('; ')
    expect(settlement.notes).toBe(notes)
    expect(f.notices).toEqual([notes]) // exactly ONE merged notice
    expect(f.calls.prompt).toHaveLength(1)
    expect(f.calls.setMode).toEqual([])
    expect(f.calls.setConfig).toEqual([])
  })

  it('configured defaults the agent never published degrade with the "publishes no" wording', async () => {
    const f = makeHost()
    f.config.agentDefaults = { alpha: { model: 'm1', mode: 'strict' } }
    f.liveOptions.set('session-1', {}) // publishes nothing
    happyPrompt(f)
    const settlement = await new AcpDelegateService(f.host).begin({ task: 'x', agent: 'alpha' }, {}).result
    expect(settlement.outcome).toBe('ended')
    expect(settlement.notes).toBe([
      'agent "alpha" publishes no default mode "strict" — using the startup mode',
      'agent "alpha" publishes no default model "m1" — using its own default model',
    ].join('; '))
    expect(f.notices).toHaveLength(1)
  })

  it('explicit stale effort: soft-dropped with a note, the turn still runs', async () => {
    const f = makeHost()
    f.liveOptions.set('session-1', { configOptions: configOptionsOf(['m1'], ['high']) })
    happyPrompt(f, 'effort dropped')
    const settlement = await new AcpDelegateService(f.host).begin({ task: 'x', agent: 'alpha', effort: 'low' }, {}).result
    expect(settlement.outcome).toBe('ended')
    expect(settlement.text).toBe('effort dropped')
    expect(settlement.notes).toBe('thought level "low" is not supported by the current model — dropped')
    expect(f.notices).toEqual(['thought level "low" is not supported by the current model — dropped'])
    expect(f.calls.setConfig).toEqual([])
    expect(f.calls.prompt).toHaveLength(1)
  })

  it('valid configured defaults are applied without any explicit argument', async () => {
    const f = makeHost()
    f.config.agentDefaults = { alpha: { model: 'm2', mode: 'strict', effort: 'high' } }
    f.liveOptions.set('session-1', { configOptions: configOptionsOf(['m1', 'm2'], ['high']), modes: modesOf('default', 'strict') })
    happyPrompt(f)
    const settlement = await new AcpDelegateService(f.host).begin({ task: 'x', agent: 'alpha' }, {}).result
    expect(settlement.outcome).toBe('ended')
    expect(settlement.notes).toBeUndefined()
    expect(f.notices).toEqual([])
    expect(f.calls.setMode).toEqual([{ sessionId: 'session-1', modeId: 'strict' }])
    expect(f.calls.setConfig).toEqual([
      { sessionId: 'session-1', configId: 'model', value: 'm2' },
      { sessionId: 'session-1', configId: 'thought', value: 'high' },
    ])
  })

  it('an explicit pick outranks the configured default on the same axis', async () => {
    const f = makeHost()
    f.config.agentDefaults = { alpha: { model: 'm1' } }
    f.liveOptions.set('session-1', { configOptions: configOptionsOf(['m1', 'm2']) })
    happyPrompt(f)
    await new AcpDelegateService(f.host).begin({ task: 'x', agent: 'alpha', model: 'm2' }, {}).result
    expect(f.calls.setConfig).toEqual([{ sessionId: 'session-1', configId: 'model', value: 'm2' }])
  })

  it('write order is mode → model → effort, and effort plans against the REFRESHED options', async () => {
    const f = makeHost()
    f.liveOptions.set('session-1', { configOptions: configOptionsOf(['m1', 'm2'], ['high']), modes: modesOf('default', 'strict') })
    // The model write changes which efforts exist — the bridge folds the
    // authoritative answer back into the snapshot (constraint 4); the fake
    // mirrors that by swapping the live options when the model lands.
    f.onSetConfigOption(async (sessionId, configId, value) => {
      if (configId === 'model' && value === 'm2') {
        f.liveOptions.set(sessionId, { configOptions: configOptionsOf(['m1', 'm2'], ['high', 'low']), modes: modesOf('default', 'strict') })
      }
    })
    happyPrompt(f)
    const settlement = await new AcpDelegateService(f.host).begin({ task: 'x', agent: 'alpha', mode: 'strict', model: 'm2', effort: 'low' }, {}).result
    expect(settlement.outcome).toBe('ended')
    expect(settlement.notes).toBeUndefined()
    expect(f.calls.setMode).toEqual([{ sessionId: 'session-1', modeId: 'strict' }])
    expect(f.calls.setConfig).toEqual([
      { sessionId: 'session-1', configId: 'model', value: 'm2' },
      { sessionId: 'session-1', configId: 'thought', value: 'low' },
    ])
    expect(f.order.indexOf('setMode')).toBeLessThan(f.order.indexOf('setConfig'))
    expect(f.order.lastIndexOf('setConfig')).toBeLessThan(f.order.indexOf('prompt'))
    // TWO live reads: the initial plan, then the effort re-read AFTER the model write.
    expect(f.calls.options).toEqual(['session-1', 'session-1'])
  })

  it('without the refresh the same effort would be dropped: the re-read is what saves it', async () => {
    const f = makeHost()
    f.liveOptions.set('session-1', { configOptions: configOptionsOf(['m1', 'm2'], ['high']), modes: modesOf('default') })
    happyPrompt(f)
    const settlement = await new AcpDelegateService(f.host).begin({ task: 'x', agent: 'alpha', model: 'm2', effort: 'low' }, {}).result
    expect(settlement.outcome).toBe('ended')
    expect(settlement.notes).toBe('thought level "low" is not supported by the current model — dropped')
    expect(f.calls.setConfig).toEqual([{ sessionId: 'session-1', configId: 'model', value: 'm2' }])
  })

  it('no effort axis requested: exactly ONE live read, no effort write', async () => {
    const f = makeHost()
    f.liveOptions.set('session-1', { configOptions: configOptionsOf(['m1', 'm2'], ['high']) })
    happyPrompt(f)
    await new AcpDelegateService(f.host).begin({ task: 'x', agent: 'alpha', model: 'm2' }, {}).result
    expect(f.calls.options).toEqual(['session-1'])
    expect(f.calls.setConfig).toEqual([{ sessionId: 'session-1', configId: 'model', value: 'm2' }])
  })

  it('a choice-less selector accepts any free value (model and effort)', async () => {
    const f = makeHost()
    f.liveOptions.set('session-1', {
      configOptions: [
        { configId: 'model', category: 'model', currentValue: 'm1', options: [] },
        { configId: 'thought', category: 'thought_level', currentValue: 'high', options: [] },
      ],
    })
    happyPrompt(f)
    const settlement = await new AcpDelegateService(f.host).begin({ task: 'x', agent: 'alpha', model: 'free-model', effort: 'free-effort' }, {}).result
    expect(settlement.outcome).toBe('ended')
    expect(settlement.notes).toBeUndefined()
    expect(f.calls.setConfig).toEqual([
      { sessionId: 'session-1', configId: 'model', value: 'free-model' },
      { sessionId: 'session-1', configId: 'thought', value: 'free-effort' },
    ])
  })

  it('a write RPC that throws is a runtime failure: prompt-error with the parsed detail, no fallback', async () => {
    const f = makeHost()
    f.liveOptions.set('session-1', { configOptions: configOptionsOf(['m1']), modes: modesOf('default', 'strict') })
    f.onSetMode(async () => {
      throw Object.assign(new Error('Internal error'), { data: { errorKind: 'auth_error', message: 'token expired' } })
    })
    const settlement = await new AcpDelegateService(f.host).begin({ task: 'x', agent: 'alpha', mode: 'strict' }, {}).result
    expect(settlement.outcome).toBe('prompt-error')
    expect(settlement.error).toBe('acp_delegate: Internal error — auth_error: token expired')
    expect(f.calls.prompt).toHaveLength(0)
    expect(f.calls.setConfig).toEqual([])
    expect(f.calls.close).toEqual(['session-1'])
    expect(f.notices).toEqual([]) // a runtime failure is NOT a degradation note
  })

  it('a stale configured value never rewrites the configured map it came from', async () => {
    const f = makeHost()
    f.config.agentDefaults = { alpha: { model: 'ghost-m', mode: 'ghost-o', effort: 'ghost-e' } }
    const before = JSON.stringify(f.config.agentDefaults)
    f.liveOptions.set('session-1', { configOptions: configOptionsOf(['m1'], ['high']), modes: modesOf('default') })
    happyPrompt(f)
    await new AcpDelegateService(f.host).begin({ task: 'x', agent: 'alpha' }, {}).result
    expect(JSON.stringify(f.config.agentDefaults)).toBe(before)
  })
})

// ---- four-axis customization: the degradation notice's agent attribution (H1) ----

describe('acp_delegate degradation notice attribution', () => {
  it('an explicit agent different from the global default files the note under ITSELF', async () => {
    const f = makeHost() // global default is 'alpha'
    f.config.agentDefaults = { beta: { model: 'ghost-m' } }
    f.liveOptions.set('session-1', { configOptions: configOptionsOf(['m1']) })
    happyPrompt(f)
    const settlement = await new AcpDelegateService(f.host).begin({ task: 'x', agent: 'beta' }, {}).result
    expect(settlement.outcome).toBe('ended')
    expect(f.calls.startSession[0].agentId).toBe('beta')
    // Exactly ONE merged notice, attributed to the DELEGATED agent 'beta' —
    // never the global default 'alpha'.
    expect(f.noticeCalls).toHaveLength(1)
    expect(f.noticeCalls[0].agentId).toBe('beta')
    expect(f.noticeCalls[0].text).toBe(settlement.notes)
  })

  it('a valid delegate default that outranks the global default files the note under ITSELF', async () => {
    const f = makeHost() // global default is 'alpha'
    f.config.defaultAgent = 'beta'
    f.config.agentDefaults = { beta: { model: 'ghost-m' } }
    f.liveOptions.set('session-1', { configOptions: configOptionsOf(['m1']) })
    happyPrompt(f)
    await new AcpDelegateService(f.host).begin({ task: 'x' }, {}).result
    expect(f.calls.startSession[0].agentId).toBe('beta')
    expect(f.noticeCalls).toHaveLength(1)
    expect(f.noticeCalls[0].agentId).toBe('beta')
  })

  it('a stale delegate default degraded to the global default files the note under the RESOLVED agent', async () => {
    const f = makeHost() // global default is 'alpha'
    f.config.defaultAgent = 'ghost' // deleted → degrades to 'alpha' with a note
    happyPrompt(f)
    const settlement = await new AcpDelegateService(f.host).begin({ task: 'x' }, {}).result
    expect(settlement.outcome).toBe('ended')
    expect(f.calls.startSession[0].agentId).toBe('alpha')
    expect(f.noticeCalls).toHaveLength(1)
    expect(f.noticeCalls[0].agentId).toBe('alpha')
    expect(f.noticeCalls[0].text).toBe(settlement.notes)
  })
})