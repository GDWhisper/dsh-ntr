import { describe, expect, it } from 'vitest'
import {
  AcpError,
  EventHub,
  PermissionLedger,
  Transcript,
  acpToolCallArgsOf,
  acpToolCallDelta,
  acpToolCallFromUpdate,
  buildAdapterModelId,
  describeUnhandledUpdate,
  updateContentToText,
  canonicalizeFsPath,
  childEnv,
  dispatchRpc,
  ACP_PRESET_SOURCE,
  acpPresetStatusFromRoster,
  isAcpToolContinuation,
  isAbsolutePath,
  isUnderPath,
  MAX_CONFIG_OPTIONS_BYTES,
  mergeCatalogShape,
  parseCatalogOptions,
  permissionReplayFrames,
  pickAutoOption,
  usableConfigOptions,
  permissionToolKind,
  permissionToolPaths,
  resolveFsPath,
  resolveSessionCwd,
  selectForwardPrompt,
  sessionAgentPreset,
  sessionAgentPresetFromLog,
  splitAdapterModelId,
  splitCommandLine,
  quoteCommandToken,
  tokenizeCommandLine,
  validateAgentDef,
  validateApprovalDeadlines,
  validateConfig,
} from '../src/impl.ts'
import type { AcpManager } from '../src/impl.ts'
import type { AcpAgentDef, AgentProbeModelsResult, PermissionOptionView } from '../src/protocol.ts'

function agentDef(overrides: Partial<AcpAgentDef> = {}): AcpAgentDef {
  return {
    id: 'demo',
    title: 'Demo',
    command: 'demo-agent',
    args: [],
    env: {},
    cwd: '/work',
    allowedCwdRoots: ['/work'],
    ...overrides,
  }
}

describe('validateConfig', () => {
  it('applies defaults', () => {
    const config = validateConfig({ agents: [{ id: 'a', command: 'run-a' }] })
    expect(config.agents[0]).toMatchObject({ id: 'a', title: 'a', args: [], env: {}, allowedCwdRoots: [] })
    expect(config.transcriptMaxEntries).toBe(600)
  })
  it('derives allowedCwdRoots from cwd', () => {
    const config = validateConfig({ agents: [{ id: 'a', command: 'run-a', cwd: '/work/x' }] })
    expect(config.agents[0].allowedCwdRoots).toEqual(['/work/x'])
  })
  it('rejects bad ids, duplicates, relative cwd, secret-shaped env values are allowed but must be strings', () => {
    expect(() => validateConfig({ agents: [{ id: 'A B', command: 'x' }] })).toThrow(AcpError)
    expect(() => validateConfig({ agents: [{ id: 'a', command: 'x' }, { id: 'a', command: 'y' }] })).toThrow(/duplicate/)
    expect(() => validateConfig({ agents: [{ id: 'a', command: 'x', cwd: 'rel/path' }] })).toThrow(/absolute/)
    expect(() => validateConfig({ agents: [{ id: 'a', command: 'x', env: { K: 3 } }] })).toThrow(/env/)
    expect(() => validateConfig({ agents: 'nope' })).toThrow(/array/)
    expect(() => validateConfig({ agents: [], transcriptMaxEntries: 1 })).toThrow(/transcriptMaxEntries/)
  })
  it('defaults probeModelsOnBoot to true and rejects non-boolean values', () => {
    expect(validateConfig({ agents: [] }).probeModelsOnBoot).toBe(true)
    expect(validateConfig({ agents: [], probeModelsOnBoot: false }).probeModelsOnBoot).toBe(false)
    expect(() => validateConfig({ agents: [], probeModelsOnBoot: 'yes' })).toThrow(/probeModelsOnBoot/)
  })
  it('defaults and bounds the reliability timeouts', () => {
    const config = validateConfig({ agents: [] })
    expect(config.startupTimeoutMs).toBe(60_000)
    expect(config.permissionTimeoutMs).toBe(300_000)
    expect(config.cancelFallbackMs).toBe(15_000)
    expect(config.staleCancelRetryDelayMs).toBe(600)
    expect(config.staleCancelMaxRetries).toBe(2)
    expect(() => validateConfig({ agents: [], startupTimeoutMs: 500 })).toThrow(/startupTimeoutMs/)
    expect(() => validateConfig({ agents: [], permissionTimeoutMs: -1 })).toThrow(/permissionTimeoutMs/)
    expect(() => validateConfig({ agents: [], cancelFallbackMs: 601_000 })).toThrow(/cancelFallbackMs/)
    expect(() => validateConfig({ agents: [], staleCancelRetryDelayMs: 60_001 })).toThrow(/staleCancelRetryDelayMs/)
    expect(() => validateConfig({ agents: [], staleCancelMaxRetries: 6 })).toThrow(/staleCancelMaxRetries/)
    expect(validateConfig({ agents: [], permissionTimeoutMs: 60_000, cancelFallbackMs: 0 }).cancelFallbackMs).toBe(0)
    expect(validateConfig({ agents: [], staleCancelRetryDelayMs: 0, staleCancelMaxRetries: 0 }).staleCancelMaxRetries).toBe(0)
  })
  it('exposes ONE approval window and the expiry mode as config knobs', () => {
    // ONE window for both places an ask can wait (the conversation's approval
    // card and the settings panel's ledger): they ask the same question, so
    // they get the same answer. Two windows only made the settings card look
    // like two unrelated knobs.
    const config = validateConfig({ agents: [] })
    expect(config.permissionTimeoutMs).toBe(300_000)

    // 0 = 一直等: no deadline at all.
    expect(validateConfig({ agents: [], permissionTimeoutMs: 0 }).permissionTimeoutMs).toBe(0)
    expect(validateConfig({ agents: [], permissionTimeoutMs: 1_800_000 }).permissionTimeoutMs).toBe(1_800_000)

    expect(() => validateConfig({ agents: [], permissionTimeoutMs: -1 })).toThrow(/permissionTimeoutMs/)
    expect(() => validateConfig({ agents: [], permissionTimeoutMs: 1.5 })).toThrow(/permissionTimeoutMs/)
    expect(() => validateConfig({ agents: [], permissionTimeoutMs: 86_400_001 })).toThrow(/permissionTimeoutMs/)
  })
  it('folds the two legacy windows into the single one', () => {
    // An existing `cordis.patch.yml` named `nativeApprovalTimeoutMs` /
    // `permissionFallbackTimeoutMs`. They are folded in rather than dropped, so
    // an old file keeps meaning what it meant instead of silently reverting to
    // the default.
    expect(validateConfig({ agents: [], nativeApprovalTimeoutMs: 60_000 }).permissionTimeoutMs).toBe(60_000)
    expect(validateConfig({ agents: [], permissionFallbackTimeoutMs: 120_000 }).permissionTimeoutMs).toBe(120_000)
    // The new key wins when both are present.
    expect(validateConfig({
      agents: [],
      permissionTimeoutMs: 30_000,
      nativeApprovalTimeoutMs: 60_000,
    }).permissionTimeoutMs).toBe(30_000)
    // The legacy keys are resolved away, not carried into the running config.
    const resolved = validateConfig({ agents: [], nativeApprovalTimeoutMs: 60_000 })
    expect('nativeApprovalTimeoutMs' in resolved).toBe(false)
    expect('permissionFallbackTimeoutMs' in resolved).toBe(false)
  })
  it('carries a legacy zero over as the wait mode, never as 不等待', () => {
    // A legacy window of 0 meant "this window never fires". Today 0 means
    // 不等待 (settle on arrival), so a legacy zero would silently turn "wait
    // forever" into "answer immediately" — the one way this migration could
    // hurt an unattended deployment. The only way to say "never expires" now
    // is the `wait` mode, so that is what it carries over as.
    const legacy = validateConfig({ agents: [], nativeApprovalTimeoutMs: 0 })
    expect(legacy.permissionTimeoutMode).toBe('wait')
    expect(legacy.permissionTimeoutMs).toBe(300_000)
    // The same holds for the other legacy key, and for an explicit mode: the
    // old meaning of a zero window was "never", whatever the mode said.
    expect(validateConfig({ agents: [], permissionFallbackTimeoutMs: 0 }).permissionTimeoutMode).toBe('wait')
    expect(validateConfig({
      agents: [],
      nativeApprovalTimeoutMs: 0,
      permissionTimeoutMode: 'auto',
    }).permissionTimeoutMode).toBe('wait')
    // The NEW key's zero is the new meaning, and it is not second-guessed.
    expect(validateConfig({ agents: [], permissionTimeoutMs: 0 })).toMatchObject({
      permissionTimeoutMs: 0,
      permissionTimeoutMode: 'wait',
    })
  })

  it('keeps 不等待 to the auto mode: under 超时中止 it floors to a real wait', () => {
    // 不等待 means "settle the ask the moment it arrives". Under 自动推进 that
    // is harmless — the ask is ANSWERED, so the agent continues. Under 超时中止
    // it would be refused on arrival, and the agent would stop at every gate
    // it meets: not a timeout, a wall. So the mode does not offer that rung,
    // and a zero reaching it floors to the shortest real wait.
    expect(validateConfig({ agents: [], permissionTimeoutMs: 0, permissionTimeoutMode: 'auto' })).toMatchObject({
      permissionTimeoutMs: 0,
      permissionTimeoutMode: 'auto',
    })
    expect(validateConfig({ agents: [], permissionTimeoutMs: 0, permissionTimeoutMode: 'abort' })).toMatchObject({
      permissionTimeoutMs: 30_000,
      permissionTimeoutMode: 'abort',
    })
    // A real window is untouched in every mode.
    expect(validateConfig({ agents: [], permissionTimeoutMs: 60_000, permissionTimeoutMode: 'abort' }).permissionTimeoutMs).toBe(60_000)
  })

  it('defaults the expiry mode to wait, and takes only the three modes', () => {
    // `wait` is the default on purpose: a permission ask is a question FOR A
    // HUMAN, so the safe default is to keep waiting rather than to refuse (or
    // worse, approve) on their behalf. `abort` / `auto` are opt-in.
    expect(validateConfig({ agents: [] }).permissionTimeoutMode).toBe('wait')
    expect(validateConfig({ agents: [], permissionTimeoutMode: 'abort' }).permissionTimeoutMode).toBe('abort')
    expect(validateConfig({ agents: [], permissionTimeoutMode: 'auto' }).permissionTimeoutMode).toBe('auto')
    expect(validateConfig({ agents: [], permissionTimeoutMode: 'wait' }).permissionTimeoutMode).toBe('wait')
    // Anything outside the three is a typo, not a new mode.
    expect(() => validateConfig({ agents: [], permissionTimeoutMode: 'maybe' })).toThrow(/permissionTimeoutMode/)
    expect(() => validateConfig({ agents: [], permissionTimeoutMode: true })).toThrow(/permissionTimeoutMode/)
  })

  it('gates the settings-page deadline write through the same range as the config file', () => {
    // The card and `cordis.patch.yml` are two doors onto the same knob, so they
    // must share one gate: a window the UI can save has to survive the next
    // boot's re-validation, or the setting would silently revert.
    expect(validateApprovalDeadlines({ permissionTimeoutMs: 60_000 })).toEqual({ permissionTimeoutMs: 60_000 })
    expect(validateApprovalDeadlines({})).toEqual({})
    expect(validateApprovalDeadlines({ permissionTimeoutMs: 0 })).toEqual({ permissionTimeoutMs: 0 })
    // `reset` is not a deadline and must not land in the persisted override.
    expect(validateApprovalDeadlines({ reset: true })).toEqual({})
    // The legacy keys are gone from the write path: an old browser half must
    // not be able to smuggle a second window back in.
    expect(validateApprovalDeadlines({ nativeApprovalTimeoutMs: 60_000 })).toEqual({})
    for (const bad of [-1, 1.5, 86_400_001, '60000', null]) {
      expect(() => validateApprovalDeadlines({ permissionTimeoutMs: bad })).toThrow(/permissionTimeoutMs/)
    }
    expect(() => validateApprovalDeadlines(null)).toThrow(/approval deadlines must be an object/)
  })
  it('keeps idleTimeoutMs optional per agent and bounds it when present', () => {
    // Absent means "host default": a config stored before this field existed
    // must keep validating, or `loadPersistedAgents` would drop the agent.
    const bare = validateConfig({ agents: [{ id: 'a', command: 'x' }] })
    expect(bare.agents[0]?.idleTimeoutMs).toBeUndefined()
    expect(validateConfig({ agents: [{ id: 'a', command: 'x', idleTimeoutMs: 0 }] }).agents[0]?.idleTimeoutMs).toBe(0)
    expect(validateConfig({ agents: [{ id: 'a', command: 'x', idleTimeoutMs: 600_000 }] }).agents[0]?.idleTimeoutMs).toBe(600_000)
    // A sub-second window would thrash spawn/release; 0 is the documented "off".
    expect(() => validateConfig({ agents: [{ id: 'a', command: 'x', idleTimeoutMs: 999 }] })).toThrow(/idleTimeoutMs/)
    expect(() => validateConfig({ agents: [{ id: 'a', command: 'x', idleTimeoutMs: -1 }] })).toThrow(/idleTimeoutMs/)
    expect(() => validateConfig({ agents: [{ id: 'a', command: 'x', idleTimeoutMs: 1.5 }] })).toThrow(/idleTimeoutMs/)
    expect(() => validateConfig({ agents: [{ id: 'a', command: 'x', idleTimeoutMs: 86_400_001 }] })).toThrow(/idleTimeoutMs/)
  })
})

describe('parseCatalogOptions', () => {
  it('extracts model and thought_level categories and collects the remaining selects as extras', () => {
    const catalog = parseCatalogOptions([
      { configId: 'model', name: 'Model', type: 'select', category: 'model', currentValue: 'a', options: [
        { value: 'a', name: 'Model A' },
        { value: 'b', name: 'Model B', description: 'The B model' },
      ] },
      { configId: 'think', name: 'Think', type: 'select', category: 'thought_level', currentValue: 'high', options: [
        { value: 'off', name: 'Off' },
        { value: 'high', name: 'High' },
      ] },
      { configId: 'temp', name: 'Temp', type: 'select', currentValue: 'mid', options: [{ value: 'mid', name: 'mid' }] },
      { configId: 'flag', name: 'Flag', type: 'boolean', currentValue: true },
    ])
    expect(catalog.model).toEqual({
      configId: 'model',
      name: 'Model',
      currentValue: 'a',
      choices: [{ value: 'a', name: 'Model A' }, { value: 'b', name: 'Model B', description: 'The B model' }],
    })
    expect(catalog.thought?.configId).toBe('think')
    expect(catalog.thought?.currentValue).toBe('high')
    // Every other SELECT is an extra (the composer's advanced base). A boolean
    // toggle is one too: it carries no choices, and `kind` is what tells the
    // composer to render a checkbox instead of a select.
    expect(catalog.extras).toEqual([
      { configId: 'temp', name: 'Temp', currentValue: 'mid', choices: [{ value: 'mid', name: 'mid' }] },
      { configId: 'flag', name: 'Flag', kind: 'boolean', currentValue: 'true', choices: [] },
    ])
  })

  it('sends a boolean to the advanced base even when it claims a select category', () => {
    // Some agents publish their thinking switch as a `thought_level` BOOLEAN.
    // The thought chip picks among levels and has none to show for it, so the
    // toggle must stay reachable as a checkbox rather than vanish into a slot
    // with an empty choice list.
    const catalog = parseCatalogOptions([
      { configId: 'think', name: 'Thinking', type: 'boolean', category: 'thought_level', currentValue: false },
      { configId: 'nocard', name: 'No card', category: 'model', currentValue: true },
    ])
    expect(catalog.thought).toBeUndefined()
    expect(catalog.model).toBeUndefined()
    expect(catalog.extras).toEqual([
      { configId: 'think', name: 'Thinking', kind: 'boolean', currentValue: 'false', choices: [] },
      // `type` is absent, but a JSON boolean current value with no choices is
      // still a toggle (defensive: not every agent fills `type`).
      { configId: 'nocard', name: 'No card', kind: 'boolean', currentValue: 'true', choices: [] },
    ])
  })

  it('falls back to the legacy id field, flattens grouped options, dedupes, and keeps unknown categories as extras', () => {
    const catalog = parseCatalogOptions([
      { id: 'model', category: 'model', currentValue: 'x', options: [
        { groupId: 'g', name: 'Group G', options: [{ value: 'x', name: 'X' }, { value: 'z', name: 'Z', description: 'own text' }] },
        { value: 'x', name: 'X duplicate' },
        { value: 'y', name: '' },
      ] },
      { configId: 'weird', category: 'future_thing', currentValue: 'z', options: [{ value: 'z', name: 'Z' }] },
      { category: 'thought_level', currentValue: 'on' },
    ])
    expect(catalog.model?.configId).toBe('model')
    // Dedupe keeps the first occurrence; grouped choices carry the group label
    // both as fallback description and as a dedicated `group` field (vendor).
    expect(catalog.model?.choices).toEqual([
      { value: 'x', name: 'X', description: 'Group G', group: 'Group G' },
      { value: 'z', name: 'Z', description: 'own text', group: 'Group G' },
      { value: 'y', name: 'y' },
    ])
    expect(catalog.thought).toBeUndefined()
    expect(catalog.extras).toEqual([
      { configId: 'weird', name: 'weird', currentValue: 'z', choices: [{ value: 'z', name: 'Z' }] },
    ])
  })

  it('returns an empty catalog for non-arrays and choice-less options', () => {
    expect(parseCatalogOptions('nope')).toEqual({})
    expect(parseCatalogOptions(undefined)).toEqual({})
    expect(parseCatalogOptions([{ configId: 'model', category: 'model', currentValue: 'a' }])).toEqual({
      model: { configId: 'model', name: 'model', currentValue: 'a', choices: [] },
    })
  })

  it('reads the agent\'s own mode select, which is not a DSH concept', () => {
    // Both real agents publish their permission/working mode as a
    // `category: 'mode'` select on `session/new` (omp: Mode, codebuddy:
    // Permission Mode). It used to be dropped here — every category that was
    // not model/thought_level was skipped — which left the composer with no
    // mode list until a live session existed.
    const catalog = parseCatalogOptions([
      { configId: 'mode', name: 'Permission Mode', type: 'select', category: 'mode', currentValue: 'default', options: [
        { value: 'default', name: 'Always Ask' },
        { value: 'plan', name: 'Plan' },
      ] },
    ])
    expect(catalog.mode).toEqual({
      configId: 'mode',
      name: 'Permission Mode',
      currentValue: 'default',
      choices: [{ value: 'default', name: 'Always Ask' }, { value: 'plan', name: 'Plan' }],
    })
    // Unknown / vendor categories (and options with no category at all) are
    // surfaced as extras: the advanced base gives them a control instead of
    // dropping them on the floor.
    expect(parseCatalogOptions([
      { configId: 'sandbox', category: 'sandbox', currentValue: 'false', options: [{ value: 'false', name: 'Local' }] },
    ])).toEqual({
      extras: [{
        configId: 'sandbox',
        name: 'sandbox',
        currentValue: 'false',
        choices: [{ value: 'false', name: 'Local' }],
      }],
    })
  })
})

describe('mergeCatalogShape', () => {
  it('adopts a newly observed slot without its per-session currentValue', () => {
    // The shape absorb is fed `session/set_config_option` answers, where the
    // current value is ONE session's pick (opencode: `effort` appears only
    // after switching to a model with variants). Promoting it would make that
    // pick `reasoning.defaultEffort` for every other conversation.
    const merged = mergeCatalogShape({ model: modelOption(['a'], 'a') }, {
      model: modelOption(['a'], 'b'),
      thought: { configId: 'effort', name: 'Effort', currentValue: 'high', choices: choiceList(['low', 'high', 'default']) },
    })
    expect(merged.thought).toEqual({
      configId: 'effort',
      name: 'Effort',
      currentValue: null,
      choices: choiceList(['low', 'high', 'default']),
    })
    // An existing slot keeps the CATALOG's current value, not the answer's.
    expect(merged.model?.currentValue).toBe('a')
  })

  it('keeps the catalog value while the observed choices still offer it, and drops it when they do not', () => {
    const existing = {
      thought: { configId: 'effort', name: 'Effort', currentValue: 'xhigh', choices: choiceList(['xhigh', 'default']) },
    }
    expect(mergeCatalogShape(existing, { thought: { configId: 'effort', name: 'Effort', currentValue: 'default', choices: choiceList(['xhigh', 'default']) } })
      .thought?.currentValue).toBe('xhigh')
    // The new model's vocabulary no longer offers it: back to "agent default".
    expect(mergeCatalogShape(existing, { thought: { configId: 'effort', name: 'Effort', currentValue: 'default', choices: choiceList(['low', 'max', 'default']) } })
      .thought?.currentValue).toBeNull()
  })

  it('leaves slots the answer omits alone and merges extras by configId', () => {
    const existing = {
      model: modelOption(['a'], 'a'),
      extras: [{ configId: 'temp', name: 'Temp', currentValue: 'mid', choices: choiceList(['mid']) }],
    }
    const merged = mergeCatalogShape(existing, {
      thought: { configId: 'effort', name: 'Effort', currentValue: 'default', choices: choiceList(['default']) },
      extras: [{ configId: 'style', name: 'Style', currentValue: 'plain', choices: choiceList(['plain']) }],
    })
    // Omitted: untouched (another model may still offer them).
    expect(merged.model).toEqual(existing.model)
    expect(merged.mode).toBeUndefined()
    // Extras union: the unobserved one survives, the observed one lands beside it.
    expect(merged.extras?.map(option => option.configId)).toEqual(['temp', 'style'])
    expect(merged.extras?.[0]?.currentValue).toBe('mid')
    expect(merged.extras?.[1]?.currentValue).toBeNull()
  })

  it('keeps a boolean extra a boolean, adopting its shape without the per-session value', () => {
    const existing = {
      extras: [{ configId: 'stream', name: 'Stream', kind: 'boolean' as const, currentValue: 'false', choices: [] }],
    }
    const observed = parseCatalogOptions([
      { configId: 'stream', name: 'Stream', type: 'boolean', currentValue: true },
      { configId: 'verbose', name: 'Verbose', type: 'boolean', currentValue: true },
    ])
    const merged = mergeCatalogShape(existing, observed)
    // Known toggle: shape absorbed, catalog default untouched.
    expect(merged.extras?.[0]).toEqual({ configId: 'stream', name: 'Stream', kind: 'boolean', currentValue: 'false', choices: [] })
    // New toggle: the answer's `true` is that session's pick, not the default.
    expect(merged.extras?.[1]).toEqual({ configId: 'verbose', name: 'Verbose', kind: 'boolean', currentValue: null, choices: [] })
  })
})

function modelOption(values: string[], currentValue: string | null) {
  return { configId: 'model', name: 'Model', currentValue, choices: choiceList(values) }
}

function choiceList(values: string[]) {
  return values.map(value => ({ value, name: value }))
}

describe('usableConfigOptions', () => {
  it('treats an empty or absent answer as a non-answer', () => {
    // Agents return `configOptions: []` in intermediate states (observed with
    // ccb / opencode on OmniTerm's side); overwriting known state with it would
    // wipe a perfectly good catalog for a state that passes.
    expect(usableConfigOptions(undefined)).toBe(false)
    expect(usableConfigOptions(null)).toBe(false)
    expect(usableConfigOptions([])).toBe(false)
    expect(usableConfigOptions('nope')).toBe(false)
    expect(usableConfigOptions([{ configId: 'model' }])).toBe(true)
  })

  it('drops absurdly large answers instead of absorbing them', () => {
    // A misbehaving agent must not turn every notification into an unbounded
    // write (the same red line OmniTerm caps its config snapshots at).
    const huge = [{ configId: 'model', name: 'x'.repeat(MAX_CONFIG_OPTIONS_BYTES) }]
    expect(usableConfigOptions(huge)).toBe(false)
    expect(usableConfigOptions([{ configId: 'model', name: 'x'.repeat(1024) }])).toBe(true)
  })
})

describe('adapter model id split/build', () => {
  it('splits base and variant ids at the @ separator', () => {
    expect(splitAdapterModelId('pi')).toEqual({ agentId: 'pi' })
    expect(splitAdapterModelId('pi@deepseek-chat')).toEqual({ agentId: 'pi', choice: 'deepseek-chat' })
    expect(splitAdapterModelId('a.b-c@v1')).toEqual({ agentId: 'a.b-c', choice: 'v1' })
  })
  it('builds the inverse variant id', () => {
    expect(buildAdapterModelId('pi', 'deepseek-chat')).toBe('pi@deepseek-chat')
  })
})

describe('selectForwardPrompt (host request → forwarded ACP prompt)', () => {
  const user = (text: string, id = 'u1') => ({ role: 'user', id, source: { kind: 'user' }, content: [{ type: 'text', text }] })
  const injected = (kind: string, text: string) => ({ role: 'user', source: { kind }, content: [{ type: 'text', text }] })

  it('takes the user message even when the host folds context sections after it', () => {
    const picked = selectForwardPrompt([
      user('你好'),
      injected('agent-instructions', '<system-reminder>The following workspace instructions…'),
      injected('plugin', 'Current runtime context.\n\nCurrent DSH file policy: workspace-write.'),
      injected('skill-catalog', '<available_skills>…'),
    ])
    expect(picked).toEqual({ kind: 'prompt', text: '你好', id: 'u1' })
  })

  it('ignores tool results and reports an injected-only wake separately', () => {
    expect(selectForwardPrompt([
      user('run the tests'),
      { role: 'user', source: { kind: 'tool' }, content: [{ type: 'text', text: 'exit code 0' }] },
    ])).toEqual({ kind: 'prompt', text: 'run the tests', id: 'u1' })
    expect(selectForwardPrompt([injected('skill-catalog', '<available_skills>…')])).toEqual({ kind: 'no-user-input' })
    expect(selectForwardPrompt([{ role: 'assistant', content: [{ type: 'text', text: 'hi' }] }])).toEqual({ kind: 'empty' })
  })

  it('treats a source-less message as user input and joins text blocks', () => {
    expect(selectForwardPrompt([
      { role: 'user', content: [{ type: 'text', text: 'hand-built' }] },
    ])).toEqual({ kind: 'prompt', text: 'hand-built' })
    expect(selectForwardPrompt([
      { role: 'user', content: [{ type: 'text', text: '  first  ' }, { type: 'image', url: 'x' }, { type: 'text', text: 'second' }] },
    ])).toEqual({ kind: 'prompt', text: 'first  \nsecond' })
    expect(selectForwardPrompt([{ role: 'user', content: [{ type: 'text', text: '   ' }] }])).toEqual({ kind: 'no-user-input' })
  })
})

describe('ACP tool-call notifications → tool-call stream chunks', () => {
  it('folds an announcement into a snapshot: id, title, and whatever input it disclosed', () => {
    expect(acpToolCallFromUpdate({ toolCallId: ' c1 ', title: 'Bash', rawInput: '{"cmd":"ls"}' }))
      .toEqual({ callId: 'c1', name: 'Bash', argsRaw: '{"cmd":"ls"}' })
    // No id is not a tool call; no title and no input are legal ACP — an
    // honest empty card, not a fabricated placeholder.
    expect(acpToolCallFromUpdate({ title: 'no id' })).toBeUndefined()
    expect(acpToolCallFromUpdate({ toolCallId: 'c2' })).toEqual({ callId: 'c2', name: '', argsRaw: '' })
  })

  it('reads the input spellings agents use in the wild, and nothing when they send none', () => {
    expect(acpToolCallArgsOf({ rawInput: '{"a":1}' })).toBe('{"a":1}')
    expect(acpToolCallArgsOf({ arguments: 'plain' })).toBe('plain')
    expect(acpToolCallArgsOf({ arguments: { a: 1 } })).toBe('{"a":1}')
    // An array (batched input) is an argument spelling too, not an empty one.
    expect(acpToolCallArgsOf({ arguments: [{ a: 1 }] })).toBe('[{"a":1}]')
    // An unserializable value degrades to text rather than failing the turn.
    const circular: Record<string, unknown> = {}
    circular.self = circular
    expect(acpToolCallArgsOf({ arguments: circular })).toBe('[object Object]')
    // No input at all is legal ACP: `''`, not a fabricated placeholder.
    expect(acpToolCallArgsOf({ toolCallId: 'c' })).toBe('')
  })

  it('emits deltas only for true prefix extensions; replacements move the snapshot for the closing block', () => {
    // The accumulator CONCATENATES `argumentsDelta`, while ACP restates the
    // whole input: only a real prefix extension can become a delta.
    let snapshot = acpToolCallFromUpdate({ toolCallId: 't1', title: 'first tool', rawInput: '{"cmd":"' })!
    expect(acpToolCallDelta(snapshot, { toolCallId: 't1', rawInput: '{"cmd":"ls -la"}' }))
      .toEqual([{ kind: 'args', text: 'ls -la"}' }])
    expect(snapshot.argsRaw).toBe('{"cmd":"ls -la"}')
    // A rewrite (not an extension) has no honest delta: the snapshot moves,
    // and the closing `block-end` replaces the block wholesale.
    snapshot = acpToolCallFromUpdate({ toolCallId: 't1', rawInput: '{"cmd":""}' })!
    expect(acpToolCallDelta(snapshot, { toolCallId: 't1', rawInput: '{"cmd":"ls -la"}' })).toEqual([])
    expect(snapshot.argsRaw).toBe('{"cmd":"ls -la"}')
    // A retitle is a name delta; input outranks content for the args text,
    // and content only fills a call whose agent never sent input at all.
    snapshot = acpToolCallFromUpdate({ toolCallId: 't1', title: 'a' })!
    expect(acpToolCallDelta(snapshot, { toolCallId: 't1', title: 'b', content: [{ type: 'content', content: { type: 'text', text: 'OUT' } }] }))
      .toEqual([{ kind: 'name', name: 'b' }, { kind: 'args', text: 'OUT' }])
    expect(snapshot.argsRaw).toBe('OUT')
  })

  it('recognizes the continuation steps of a card-bearing turn, and only those', () => {
    // Tool-sourced messages AFTER the last user one: the staged results the
    // host loop feeds a card-bearing turn's next step with.
    expect(isAcpToolContinuation([
      { role: 'user', source: { kind: 'user' } },
      { role: 'tool', source: { kind: 'tool', callId: 'c1' } },
    ])).toBe(true)
    // The person's new words are the last message: a fresh prompt.
    expect(isAcpToolContinuation([
      { role: 'tool', source: { kind: 'tool', callId: 'c1' } },
      { role: 'user', source: { kind: 'user' } },
    ])).toBe(false)
    // History from earlier turns sits BEFORE the new user text.
    expect(isAcpToolContinuation([
      { role: 'tool', source: { kind: 'tool', callId: 'c0' } },
      { role: 'user', source: { kind: 'user' } },
      { role: 'tool', source: { kind: 'tool', callId: 'c1' } },
    ])).toBe(true)
    // A source-less message counts as user input (the hand-built convention).
    expect(isAcpToolContinuation([
      { role: 'tool', source: { kind: 'tool', callId: 'c1' } },
      { role: 'user' },
    ])).toBe(false)
    expect(isAcpToolContinuation([{ role: 'user', source: { kind: 'user' } }])).toBe(false)
    expect(isAcpToolContinuation([])).toBe(false)
  })

  it('keeps the content kinds the Chat plane cannot render, instead of placeholders', () => {
    const text = updateContentToText([
      { type: 'content', content: { type: 'text', text: 'first' } },
      { type: 'diff', path: '/w/a.ts', oldText: 'one\ntwo\n', newText: 'one\nTWO\n' },
      { type: 'content', content: { type: 'image', data: 'abc' } },
      { type: 'terminal', terminalId: 't1' },
    ])
    expect(text).toContain('first')
    // A diff becomes its path plus -/+ lines, not a `[diff path]` stub.
    expect(text).toContain('/w/a.ts')
    expect(text).toContain('- two')
    expect(text).toContain('+ TWO')
    // Unknown kinds keep their whole payload.
    expect(text).toContain('"data":"abc"')
    expect(text).toContain('"terminalId":"t1"')
  })

  it('describes a notification it has no card for without dropping its payload', () => {
    expect(describeUnhandledUpdate('plan', {
      entries: [{ content: 'fix the bug', status: 'in_progress', priority: 'high' }],
    })).toBe('[in_progress] [high] fix the bug')
    expect(describeUnhandledUpdate('current_mode_update', { currentModeId: 'plan' })).toBe('current_mode_update: plan')
    expect(describeUnhandledUpdate('brand_new_kind', { sessionUpdate: 'brand_new_kind', extra: [1, 2] }))
      .toContain('"extra": [')
  })
})

describe('validateAgentDef', () => {
  it('validates a valid agent definition and applies defaults', () => {
    const def = validateAgentDef({ id: 'pi', command: 'pi-acp' })
    expect(def).toEqual({
      id: 'pi',
      title: 'pi',
      command: 'pi-acp',
      args: [],
      env: {},
      cwd: undefined,
      allowedCwdRoots: [],
    })
    expect('exposedModels' in def).toBe(false)
  })

  it('normalizes exposedModels (dedupe) and rejects malformed filters', () => {
    expect(validateAgentDef({ id: 'pi', command: 'x', exposedModels: ['b', 'a', 'b'] }).exposedModels).toEqual(['b', 'a'])
    expect(validateAgentDef({ id: 'pi', command: 'x', exposedModels: [] }).exposedModels).toEqual([])
    expect(() => validateAgentDef({ id: 'pi', command: 'x', exposedModels: 'model-a' })).toThrow(/exposedModels/)
    expect(() => validateAgentDef({ id: 'pi', command: 'x', exposedModels: ['a', ''] })).toThrow(/exposedModels/)
    expect(() => validateAgentDef({ id: 'pi', command: 'x', exposedModels: [42] })).toThrow(/exposedModels/)
  })

  // The cap used to be 256 entries, which is below what real agents publish
  // (pi: 500 choices, omp: 581) — the panel's "only my selected models" switch
  // sends every choice at once and got `bad_payload` for a legitimate filter.
  it('accepts an exposedModels filter as large as a real catalog, and bounds it by size', () => {
    const catalog = Array.from({ length: 600 }, (_, i) => `provider/model-${String(i)}`)
    expect(validateAgentDef({ id: 'pi', command: 'x', exposedModels: catalog }).exposedModels).toEqual(catalog)
    // Config reload re-validates the stored filter: exceeding the bound would
    // silently drop the whole agent definition, so the guard is on total size.
    expect(() => validateAgentDef({ id: 'pi', command: 'x', exposedModels: Array.from({ length: 3000 }, (_, i) => `${'x'.repeat(400)}-${String(i)}`) })).toThrow(/too large/)
    expect(() => validateAgentDef({ id: 'pi', command: 'x', exposedModels: ['y'.repeat(513)] })).toThrow(/exposedModels/)
  })

  it('treats autoDiscoverModels as on by default; only the explicit opt-out is persisted', () => {
    // Default-on: `true` and absent are the same state, so neither is stored.
    expect('autoDiscoverModels' in validateAgentDef({ id: 'pi', command: 'x', autoDiscoverModels: true })).toBe(false)
    expect('autoDiscoverModels' in validateAgentDef({ id: 'pi', command: 'x' })).toBe(false)
    expect(validateAgentDef({ id: 'pi', command: 'x', autoDiscoverModels: false }).autoDiscoverModels).toBe(false)
    expect(() => validateAgentDef({ id: 'pi', command: 'x', autoDiscoverModels: 'yes' })).toThrow(/autoDiscoverModels/)
  })

  it('accepts, trims, and drops npmPackage; rejects invalid package names', () => {
    expect(validateAgentDef({ id: 'pi', command: 'x', npmPackage: ' @mariozechner/pi-acp ' }).npmPackage).toBe('@mariozechner/pi-acp')
    expect(validateAgentDef({ id: 'pi', command: 'x', npmPackage: 'omp@latest' }).npmPackage).toBe('omp@latest')
    expect('npmPackage' in validateAgentDef({ id: 'pi', command: 'x', npmPackage: '  ' })).toBe(false)
    expect('npmPackage' in validateAgentDef({ id: 'pi', command: 'x' })).toBe(false)
    // Shell metacharacters must never reach the installer spawn argv.
    expect(() => validateAgentDef({ id: 'pi', command: 'x', npmPackage: 'pkg; rm -rf /' })).toThrow(/npmPackage/)
    expect(() => validateAgentDef({ id: 'pi', command: 'x', npmPackage: 'pkg$(whoami)' })).toThrow(/npmPackage/)
    expect(() => validateAgentDef({ id: 'pi', command: 'x', npmPackage: 'pkg && other' })).toThrow(/npmPackage/)
    expect(() => validateAgentDef({ id: 'pi', command: 'x', npmPackage: 42 })).toThrow(/npmPackage/)
  })

  it('rejects empty command and invalid id', () => {
    expect(() => validateAgentDef({ id: 'pi', command: '' })).toThrow(AcpError)
    expect(() => validateAgentDef({ id: 'PI AGENT', command: 'pi-acp' })).toThrow(AcpError)
  })

  // The MCP server list. The plugin stores it in its OWN normalized shape
  // (every entry carries an explicit `transport`), because the ACP wire shape
  // is asymmetric: its stdio variant carries NO `type` field, so a config
  // written in the wire shape by hand is accepted by the agent and then
  // silently dropped (measured: the server never connects). The wire
  // conversion lives in bridge.ts; these cases cover the shape the HOST
  // accepts and persists.
  it('accepts MCP servers in the normalized shape and keeps them verbatim', () => {
    const servers = [
      { name: 'local', transport: 'stdio', command: '/opt/servers/local', args: ['--mcp'], env: { TOKEN: 'x' } },
      { name: 'remote', transport: 'http', url: 'https://example.test/mcp', headers: { Authorization: 'Bearer t' } },
      { name: 'events', transport: 'sse', url: 'https://example.test/sse' },
    ]
    const def = validateAgentDef({ id: 'pi', command: 'x', mcpServers: servers })
    // Verbatim: the host validates, it does not reshape. A host that filled in
    // defaults would make the settings panel report a change where there is
    // none.
    expect(def.mcpServers).toEqual(servers)
    // And it survives the REBUILD: a field not listed in validateAgentDef's
    // return is silently stripped, which would delete the whole feature.
    expect('mcpServers' in def).toBe(true)
  })

  it('treats an absent MCP list as "none" rather than storing an empty one', () => {
    expect('mcpServers' in validateAgentDef({ id: 'pi', command: 'x' })).toBe(false)
    expect(validateAgentDef({ id: 'pi', command: 'x', mcpServers: [] }).mcpServers).toEqual([])
  })

  it('rejects malformed MCP server entries', () => {
    expect(() => validateAgentDef({ id: 'pi', command: 'x', mcpServers: 'nope' })).toThrow(/mcpServers/)
    expect(() => validateAgentDef({ id: 'pi', command: 'x', mcpServers: [{ transport: 'stdio', command: 'x' }] })).toThrow(/name/)
    expect(() => validateAgentDef({ id: 'pi', command: 'x', mcpServers: [{ name: 'a', transport: 'stdio' }] })).toThrow(/command/)
    expect(() => validateAgentDef({ id: 'pi', command: 'x', mcpServers: [{ name: 'a', transport: 'http' }] })).toThrow(/url/)
    expect(() => validateAgentDef({ id: 'pi', command: 'x', mcpServers: [{ name: 'a', transport: 'sse' }] })).toThrow(/url/)
    expect(() => validateAgentDef({ id: 'pi', command: 'x', mcpServers: [{ name: 'a', transport: 'ftp', url: 'x' }] })).toThrow(/transport/)
    expect(() => validateAgentDef({ id: 'pi', command: 'x', mcpServers: [{ name: 'a', transport: 'stdio', command: 'x', args: [1] }] })).toThrow(/args/)
    expect(() => validateAgentDef({ id: 'pi', command: 'x', mcpServers: [{ name: 'a', transport: 'stdio', command: 'x', env: { K: 1 } }] })).toThrow(/env/)
    expect(() => validateAgentDef({ id: 'pi', command: 'x', mcpServers: [{ name: 'a', transport: 'http', url: 'u', headers: { K: 1 } }] })).toThrow(/headers/)
    // Two servers sharing a name would collide inside the agent, where the name
    // namespaces the tools (`mcp__<name>__<tool>`).
    expect(() => validateAgentDef({
      id: 'pi',
      command: 'x',
      mcpServers: [{ name: 'a', transport: 'stdio', command: 'x' }, { name: 'a', transport: 'stdio', command: 'y' }],
    })).toThrow(/more than one/)
  })

  it('refuses the ACP transport variant, which the client side cannot serve', () => {
    // `transport: 'acp'` means the agent calls back into this plugin over
    // `mcp/message` — a method the stable ACP SDK does not expose on the
    // client side. Accepting it would store a server the agent can never
    // reach.
    expect(() => validateAgentDef({ id: 'pi', command: 'x', mcpServers: [{ name: 'a', transport: 'acp', serverId: 's' }] })).toThrow(/not supported/)
  })

  it('bounds the MCP server list', () => {
    const many = Array.from({ length: 40 }, (_, i) => ({ name: `s${String(i)}`, transport: 'stdio', command: 'x' }))
    expect(() => validateAgentDef({ id: 'pi', command: 'x', mcpServers: many })).toThrow(/at most/)
  })
})

/**
 * The 命令 field is a command LINE. This is the semantics the panel's single
 * input relies on, and the reason `codebuddy --acp` (the whole command pasted
 * into one box) is a working configuration instead of an executable named
 * `codebuddy --acp` — the failure that produced "ACP connection closed".
 */
describe('command lines', () => {
  it('splits a pasted command line into program + arguments', () => {
    expect(splitCommandLine('codebuddy --acp')).toEqual({ command: 'codebuddy', args: ['--acp'] })
    expect(splitCommandLine('  omp   acp  ')).toEqual({ command: 'omp', args: ['acp'] })
    expect(splitCommandLine('pi-acp')).toEqual({ command: 'pi-acp', args: [] })
    expect(splitCommandLine('npx -y @tencent-ai/codebuddy-code --acp')).toEqual({
      command: 'npx',
      args: ['-y', '@tencent-ai/codebuddy-code', '--acp'],
    })
  })

  it('keeps a quoted path in one piece, and a backslash is not an escape', () => {
    expect(splitCommandLine('"C:\\Program Files\\nodejs\\node.exe" --acp'))
      .toEqual({ command: 'C:\\Program Files\\nodejs\\node.exe', args: ['--acp'] })
    expect(splitCommandLine("'my agent' --flag value")).toEqual({ command: 'my agent', args: ['--flag', 'value'] })
    expect(splitCommandLine('cmd /c "a b"')).toEqual({ command: 'cmd', args: ['/c', 'a b'] })
    // `\"` is the one escape the tokenizer honors (Windows paths are otherwise
    // nothing but backslashes, so a general escape would mangle them).
    expect(splitCommandLine('say "\\"hi\\""')).toEqual({ command: 'say', args: ['"hi"'] })
  })

  it('answers an empty command for blank and quote-only input', () => {
    expect(splitCommandLine('')).toEqual({ command: '', args: [] })
    expect(splitCommandLine('   ')).toEqual({ command: '', args: [] })
    expect(splitCommandLine('""')).toEqual({ command: '', args: [] })
    expect(tokenizeCommandLine('a "" b')).toEqual(['a', '', 'b'])
  })

  it('quotes tokens only when they need it, and round-trips', () => {
    expect(quoteCommandToken('plain')).toBe('plain')
    expect(quoteCommandToken('has space')).toBe('"has space"')
    expect(quoteCommandToken('')).toBe('""')
    for (const token of ['plain', 'has space', 'C:\\Program Files\\x.exe', 'say "hi"', "it's"]) {
      expect(splitCommandLine(quoteCommandToken(token)).command).toBe(token)
    }
  })

  it('folds the command line\'s trailing tokens in front of the explicit args', () => {
    const def = validateAgentDef({ id: 'codebuddy', command: 'codebuddy --acp' })
    expect(def.command).toBe('codebuddy')
    expect(def.args).toEqual(['--acp'])
    // Idempotent: re-validating what this function returned (every boot does)
    // must not move anything around.
    expect(validateAgentDef(def)).toMatchObject({ command: 'codebuddy', args: ['--acp'] })
    // The canonical shape — bare command + args, what every preset stores — is
    // untouched, and an explicit args list keeps its own order after the parsed
    // ones.
    expect(validateAgentDef({ id: 'omp', command: 'omp', args: ['acp'] })).toMatchObject({ command: 'omp', args: ['acp'] })
    expect(validateAgentDef({ id: 'x', command: 'cmd /c foo', args: ['--tail'] }).args).toEqual(['/c', 'foo', '--tail'])
    // Quoting survives: the stored command is the bare path, not the quotes.
    expect(validateAgentDef({ id: 'x', command: '"C:\\Program Files\\x.exe" --acp' }))
      .toMatchObject({ command: 'C:\\Program Files\\x.exe', args: ['--acp'] })
    expect(() => validateAgentDef({ id: 'x', command: '"' })).toThrow(AcpError)
  })

  it('does NOT round-trip a whitespace command through a bare re-validate (quoting restores it)', () => {
    // The returned `command` is the BARE path (spawn needs it unquoted). A bare
    // command with a space is not re-parseable: splitCommandLine splits it again,
    // so the fold's idempotence holds only for whitespace-free commands.
    const def = validateAgentDef({ id: 'x', command: '"C:\\Program Files\\x.exe" --acp' })
    expect(def).toMatchObject({ command: 'C:\\Program Files\\x.exe', args: ['--acp'] })
    expect(validateAgentDef(def)).toMatchObject({ command: 'C:\\Program', args: ['Files\\x.exe', '--acp'] })
    // What `loadPersistedAgents` does before re-validating (quoteLegacyCommand,
    // when the path exists): re-quote the command token and it round-trips.
    const requoted = validateAgentDef({ ...def, command: quoteCommandToken(def.command) })
    expect(requoted).toMatchObject({ command: 'C:\\Program Files\\x.exe', args: ['--acp'] })
  })
})

describe('resolveSessionCwd', () => {
  const realpath = (p: string): string => (p === '/link' ? '/work/real' : p === '/escape' ? '/etc' : p)

  it('defaults to the configured cwd', () => {
    expect(resolveSessionCwd(agentDef(), undefined, realpath)).toBe('/work')
    expect(resolveSessionCwd(agentDef(), '', realpath)).toBe('/work')
  })
  it('accepts nested paths under an allowed root and canonicalizes symlinks', () => {
    expect(resolveSessionCwd(agentDef(), '/work/sub/dir', realpath)).toBe('/work/sub/dir')
    expect(resolveSessionCwd(agentDef(), '/link', realpath)).toBe('/work/real')
  })
  it('refuses paths outside the roots and non-absolute or missing ones', () => {
    expect(() => resolveSessionCwd(agentDef(), '/etc', realpath)).toThrow(/outside/)
    expect(() => resolveSessionCwd(agentDef(), 'relative', realpath)).toThrow(/absolute/)
    expect(() => resolveSessionCwd(agentDef({ cwd: undefined, allowedCwdRoots: [] }), undefined, realpath)).toThrow(/no default cwd/)
  })
  it('guards prefix confusion (/work2 must not pass under /work)', () => {
    expect(() => resolveSessionCwd(agentDef(), '/work2', realpath)).toThrow(/outside/)
  })
  it('trusts explicitly passed extra roots for this session only', () => {
    // A chat session's cwd is the workspace the user picked in the DSH
    // sidebar; it is never in the agent's own allow-list, which is why the
    // caller has to hand it over as an extra root explicitly.
    expect(() => resolveSessionCwd(agentDef(), '/elsewhere', realpath)).toThrow(/outside/)
    expect(resolveSessionCwd(agentDef(), '/elsewhere', realpath, ['/elsewhere'])).toBe('/elsewhere')
    // Trusting one directory must not widen anything else.
    expect(() => resolveSessionCwd(agentDef(), '/etc', realpath, ['/elsewhere'])).toThrow(/outside/)
    // A junk extra root (relative, non-string) is dropped, never treated as a root.
    expect(() => resolveSessionCwd(agentDef(), '/etc', realpath, ['relative', 42 as unknown as string])).toThrow(/outside/)
    // The configured roots stay in effect alongside it.
    expect(resolveSessionCwd(agentDef(), '/work/sub', realpath, ['/elsewhere'])).toBe('/work/sub')
  })
  it('lets an extra root serve as the cwd of a cwd-less agent', () => {
    const def = agentDef({ cwd: undefined, allowedCwdRoots: [] })
    expect(() => resolveSessionCwd(def, undefined, realpath)).toThrow(/no default cwd/)
    expect(resolveSessionCwd(def, '/elsewhere', realpath, ['/elsewhere'])).toBe('/elsewhere')
  })
})

describe('resolveFsPath', () => {
  /** realpath that mimics the filesystem: /ws exists (with a symlink to /etc), deeper paths must already exist. */
  const realpath = (p: string): string => {
    if (p === '/' || p === '/ws' || p === '/ws/existing' || p === '/ws/link') {
      return p === '/ws/link' ? '/etc' : p
    }
    throw new Error(`realpath: ENOENT ${p}`)
  }

  it('accepts absolute and relative paths inside the workspace', () => {
    expect(resolveFsPath('/ws', ['/ws'], '/ws/existing', realpath)).toBe('/ws/existing')
    expect(resolveFsPath('/ws', ['/ws'], 'existing', realpath)).toBe('/ws/existing')
  })
  it('canonicalizes a fresh write target through its nearest existing ancestor', () => {
    expect(resolveFsPath('/ws', ['/ws'], '/ws/a/b/c/new.txt', realpath)).toBe('/ws/a/b/c/new.txt')
    expect(resolveFsPath('/ws', ['/ws'], 'sub/./x/../new.txt', realpath)).toBe('/ws/sub/new.txt')
  })
  it('rejects escapes via .., symlinks, and out-of-root absolutes', () => {
    expect(() => resolveFsPath('/ws', ['/ws'], '/ws/../../etc/passwd', realpath)).toThrow(/outside/)
    expect(() => resolveFsPath('/ws', ['/ws'], '/ws/link/passwd', realpath)).toThrow(/outside/)
    expect(() => resolveFsPath('/ws', ['/ws'], '/etc/passwd', realpath)).toThrow(/outside/)
    expect(() => resolveFsPath('/ws', ['/other'], 'file.txt', realpath)).toThrow(/outside/)
  })
  it('guards prefix confusion and empty paths', () => {
    expect(() => resolveFsPath('/ws', ['/ws'], '/ws2/file.txt', realpath)).toThrow(/outside/)
    expect(() => resolveFsPath('/ws', ['/ws'], '', realpath)).toThrow(/non-empty/)
  })
})

describe('cross-platform paths (Windows)', () => {
  // Mimics a Windows realpath: drive root and configured dirs exist, deeper
  // paths must already exist, and the disk answers in `\`-separated form with
  // on-disk casing (here: different from the request where it matters).
  const winRealpath = (p: string): string => {
    if (p === 'C:/' || p === 'C:\\') return 'C:\\'
    if (p === 'C:/ws' || p === 'C:\\ws') return 'C:\\WS'
    if (p === 'C:/ws/existing' || p === 'C:\\ws\\existing') return 'C:\\ws\\existing'
    if (p === 'C:/ws/link' || p === 'C:\\ws\\link') return 'C:\\etc'
    if (p === 'C:/etc/via/link') return 'C:\\etc'
    if (p === 'C:/ws/existing/../../Windows') return 'C:\\Windows'
    if (p === 'D:/other' || p === 'D:\\other') return 'D:\\other'
    if (p === '//srv/share' || p === '\\\\srv\\share' || p === '//srv/share/') return '\\\\srv\\share'
    if (p === '//srv/share/proj/file.txt') return '\\\\srv\\share\\proj\\file.txt'
    if (p === '//srv/other/') return '\\\\srv\\other'
    throw new Error(`realpath: ENOENT ${p}`)
  }

  it('validateAgentDef accepts drive, forward-slash, and UNC forms', () => {
    const def = validateAgentDef({ id: 'win', command: 'x', cwd: 'C:\\Users\\me\\proj', allowedCwdRoots: ['C:/Users/me', 'D:\\data'] })
    expect(def.cwd).toBe('C:\\Users\\me\\proj')
    expect(def.allowedCwdRoots).toEqual(['C:/Users/me', 'D:\\data'])
    expect(() => validateAgentDef({ id: 'win', command: 'x', cwd: '\\\\srv\\share' })).not.toThrow()
  })
  it('validateAgentDef rejects drive-relative and plain-relative paths', () => {
    expect(() => validateAgentDef({ id: 'win', command: 'x', cwd: 'C:Users' })).toThrow(/absolute/)
    expect(() => validateAgentDef({ id: 'win', command: 'x', cwd: 'foo\\bar' })).toThrow(/absolute/)
    expect(() => validateAgentDef({ id: 'win', command: 'x', allowedCwdRoots: ['C:/ok', 'relative'] })).toThrow(/absolute/)
  })

  it('isUnderPath folds separators and case for win32-style paths only', () => {
    expect(isUnderPath('C:/WS/sub/x.txt', 'c:\\ws')).toBe(true)
    expect(isUnderPath('C:\\work2\\x', 'C:/work')).toBe(false)
    expect(isUnderPath('C:/x', 'C:/')).toBe(true)
    // POSIX keeps case sensitivity and the old prefix guard.
    expect(isUnderPath('/WORK/x', '/work')).toBe(false)
    expect(isUnderPath('/work/x', '/work/')).toBe(true)
    expect(isUnderPath('/work2/x', '/work')).toBe(false)
    expect(isUnderPath('/anything', '/')).toBe(true)
    // A non-absolute root contains nothing.
    expect(isUnderPath('/work/x', 'relative')).toBe(false)
  })

  it('resolveSessionCwd accepts a Windows def and answers in folded /-form', () => {
    const def = agentDef({ cwd: 'C:\\ws', allowedCwdRoots: ['C:/ws'] })
    expect(resolveSessionCwd(def, undefined, winRealpath)).toBe('C:/WS')
    expect(resolveSessionCwd(def, 'C:/ws/existing', winRealpath)).toBe('C:/ws/existing')
    expect(resolveSessionCwd(def, 'C:\\ws\\existing', winRealpath)).toBe('C:/ws/existing')
    expect(() => resolveSessionCwd(def, 'C:/etc/via/link', winRealpath)).toThrow(/outside/)
  })
  it('resolveSessionCwd trusts Windows-style extra roots for the session', () => {
    const def = agentDef({ cwd: 'C:\\ws', allowedCwdRoots: ['C:/ws'] })
    expect(resolveSessionCwd(def, 'D:\\other', winRealpath, ['D:/other'])).toBe('D:/other')
    expect(() => resolveSessionCwd(def, 'C:/ws/existing/../../Windows', winRealpath)).toThrow(/outside/)
  })
  it('resolveSessionCwd still rejects relative candidates on Windows', () => {
    const def = agentDef({ cwd: 'C:\\ws', allowedCwdRoots: ['C:/ws'] })
    expect(() => resolveSessionCwd(def, 'C:relative', winRealpath)).toThrow(/absolute/)
  })

  it('resolveFsPath joins relative requests under a drive-letter workspace', () => {
    const roots = ['C:\\ws']
    // The disk answers with its own casing (C:\WS); fresh tails keep the
    // request's spelling on top of the resolved ancestor — real Windows behavior.
    expect(resolveFsPath('C:/ws', roots, 'existing', winRealpath)).toBe('C:/ws/existing')
    expect(resolveFsPath('C:/ws', roots, 'sub/./x/../new.txt', winRealpath)).toBe('C:/WS/sub/new.txt')
    expect(resolveFsPath('C:/ws', roots, 'sub\\back.txt', winRealpath)).toBe('C:/WS/sub/back.txt')
  })
  it('resolveFsPath keeps an absolute drive request in its own head', () => {
    expect(resolveFsPath('C:/ws', ['C:/ws'], 'C:\\ws\\existing', winRealpath)).toBe('C:/ws/existing')
  })
  it('resolveFsPath canonicalizes a fresh write target through the existing ancestor', () => {
    expect(resolveFsPath('C:/ws', ['C:/ws'], 'a/b/c/new.txt', winRealpath)).toBe('C:/WS/a/b/c/new.txt')
  })
  it('resolveFsPath rejects escapes, symlinks, prefix confusion, and extended-length forms', () => {
    expect(() => resolveFsPath('C:/ws', ['C:/ws'], '..\\..\\Windows\\x', winRealpath)).toThrow(/outside/)
    expect(() => resolveFsPath('C:/ws', ['C:/ws'], 'C:/ws/link/x', winRealpath)).toThrow(/outside/)
    expect(() => resolveFsPath('C:/ws', ['C:/ws'], 'C:/ws2/file.txt', winRealpath)).toThrow(/outside/)
    expect(() => resolveFsPath('C:/ws', ['C:/ws'], '\\\\srv\\share\\file.txt', winRealpath)).toThrow(/outside/)
    expect(() => canonicalizeFsPath('C:/ws', '\\\\?\\C:\\ws\\x', winRealpath)).toThrow(/cannot resolve/)
  })
  it('resolveFsPath contains a UNC workspace under its share root', () => {
    expect(resolveFsPath('//srv/share/proj', ['//srv/share'], 'file.txt', winRealpath)).toBe('//srv/share/proj/file.txt')
    expect(() => resolveFsPath('//srv/share/proj', ['\\\\srv\\share'], '//srv/other/file.txt', winRealpath)).toThrow(/outside/)
    // The disk hands back its own casing (shares are often stored upper-case) and
    // `foldSeparators` returns it as `//SRV/SHARE/…`: the containment must still
    // fold case after that normalization, or every UNC workspace denies.
    const upperRealpath = (p: string): string => {
      if (p === '//srv/share/proj/file.txt') return '\\\\SRV\\SHARE\\proj\\file.txt'
      throw new Error(`realpath: ENOENT ${p}`)
    }
    expect(resolveFsPath('//srv/share/proj', ['\\\\srv\\share'], 'file.txt', upperRealpath)).toBe('//SRV/SHARE/proj/file.txt')
  })

  it('folds UNC case under both separator spellings and keeps POSIX byte-exact', () => {
    expect(isUnderPath('\\\\SRV\\SHARE\\x', '\\\\srv\\share')).toBe(true)
    expect(isUnderPath('//SRV/SHARE/x', '\\\\srv\\share')).toBe(true)
    expect(isUnderPath('\\\\SRV\\SHARE\\x', '//srv/share')).toBe(true)
    expect(isUnderPath('//srv/other/x', '\\\\srv\\share')).toBe(false)
    // A POSIX backslash is a filename character, never a separator.
    expect(isUnderPath('/work/a\\b', '/work/a')).toBe(false)
    expect(isUnderPath('/WORK/x', '/work')).toBe(false)
  })

  it('scopes a `/` root to POSIX-form paths', () => {
    expect(isUnderPath('/anything', '/')).toBe(true)
    // One filesystem tree, not every drive and share the plugin can see.
    expect(isUnderPath('C:/x', '/')).toBe(false)
    expect(isUnderPath('\\\\srv\\share\\x', '/')).toBe(false)
  })

  it('answers a bare-root request with an absolute spelling', () => {
    const echo = (p: string): string => p
    expect(canonicalizeFsPath('/ws', '/', echo)).toBe('/')
    expect(canonicalizeFsPath('/ws', '..', echo)).toBe('/')
    expect(canonicalizeFsPath('C:/ws', 'C:\\', winRealpath)).toBe('C:/')
    expect(isUnderPath(canonicalizeFsPath('/ws', '/', echo), '/')).toBe(true)
  })

  it('rejects the extended-length form in config and in requests', () => {
    expect(isAbsolutePath('\\\\?\\C:\\ws')).toBe(false)
    expect(() => validateAgentDef({ id: 'win', command: 'x', cwd: '\\\\?\\C:\\ws' })).toThrow(/absolute/)
    expect(() => validateAgentDef({ id: 'win', command: 'x', allowedCwdRoots: ['\\\\?\\C:\\ws'] })).toThrow(/absolute/)
    expect(() => resolveFsPath('C:/ws', ['C:/ws'], '\\\\?\\C:\\ws\\x', winRealpath)).toThrow(/cannot resolve/)
    expect(() => resolveFsPath('C:/ws', ['C:/ws'], '//?/C:/ws/x', winRealpath)).toThrow(/cannot resolve/)
  })

  it('blames the unjudgeable FORM, not a missing file, when realpath says everything exists', () => {
    // A realpath that resolves ANY path: so the only reason these two forms are
    // refused is that this layer cannot address them — the error must say that,
    // not the false "does not exist".
    const allExist = (p: string): string => p
    // Extended-length / verbatim head (`\\?\…`, `//?/…`).
    expect(() => canonicalizeFsPath('C:/ws', '\\\\?\\C:\\ws\\file.txt', allExist)).toThrow(/cannot resolve/)
    expect(() => canonicalizeFsPath('C:/ws', '//?/C:/ws/file.txt', allExist)).toThrow(/cannot resolve/)
    // Share-less UNC head (`\\host`, `//host`): host but no share, so segmentize
    // returns undefined and the path is unaddressable — again not "does not exist".
    expect(() => canonicalizeFsPath('C:/ws', '\\\\host', allExist)).toThrow(/cannot resolve/)
    expect(() => canonicalizeFsPath('C:/ws', '//host', allExist)).toThrow(/cannot resolve/)
    // A genuinely absent path still reports the honest "does not exist".
    const nothing = (): string => { throw new Error('ENOENT') }
    expect(() => canonicalizeFsPath('C:/ws', 'C:\\ws\\gone.txt', nothing)).toThrow(/does not exist/)
  })

  it('folds a Windows workspace root against declared locations (the surviving containment)', () => {
    // This used to prove `decidePermission`'s arithmetic. The decision layer is
    // retired; what remains is the containment primitive the workspace fence is
    // built on, and it must keep folding separators and case the same way.
    expect(isUnderPath('C:\\proj\\a.txt', 'C:/proj')).toBe(true)
    expect(isUnderPath('D:\\proj\\a.txt', 'C:/proj')).toBe(false)
    // A path can be inside a root spelled with either separator on either side.
    expect(isUnderPath('C:/proj/sub/b.ts', 'C:\\proj')).toBe(true)
  })
})

describe('childEnv', () => {
  it('inherits the whole host env and lets the agent env win per key', () => {
    const out = childEnv(
      { HOME: '/h', ANTHROPIC_API_KEY: 'sk', GITHUB_TOKEN: 'gh', DSH_PERMISSION_MODE: 'x', PLAIN: 'p', EMPTY: undefined },
      { DEEPSEEK_API_KEY: 'explicit', HOME: '/other' },
    )
    expect(out).toEqual({
      HOME: '/other',
      ANTHROPIC_API_KEY: 'sk',
      GITHUB_TOKEN: 'gh',
      DSH_PERMISSION_MODE: 'x',
      PLAIN: 'p',
      DEEPSEEK_API_KEY: 'explicit',
    })
  })
})

describe('Transcript', () => {
  it('assigns monotone seq and bounds memory while since() replays', () => {
    const t = new Transcript(5)
    for (let i = 0; i < 9; i++) t.append({ i })
    expect(t.head).toBe(9)
    const kept = t.since(0)
    expect(kept.map(e => e.seq)).toEqual([5, 6, 7, 8, 9])
    expect(t.since(7).map(e => e.update)).toEqual([{ i: 7 }, { i: 8 }])
  })
})

describe('pickAutoOption (what `auto` mode answers with)', () => {
  const opt = (optionId: string, kind: string, name = optionId): PermissionOptionView => ({ optionId, name, kind })

  it('picks by the kind the agent declared, broadest grant first', () => {
    // ACP's `PermissionOption` has no "default option" field, so the kind IS
    // the only statement the agent makes about the choice it is offering. The
    // order is `allow_always` → `allow_once` → `reject_once` → `reject_always`
    // — the same rule as OmniTerm dev's `pick_auto_option`.
    expect(pickAutoOption([opt('r1', 'reject_once'), opt('a1', 'allow_once'), opt('a0', 'allow_always')])?.optionId).toBe('a0')
    expect(pickAutoOption([opt('r1', 'reject_once'), opt('a1', 'allow_once')])?.optionId).toBe('a1')
    expect(pickAutoOption([opt('r2', 'reject_always'), opt('r1', 'reject_once')])?.optionId).toBe('r1')
    expect(pickAutoOption([opt('r2', 'reject_always')])?.optionId).toBe('r2')
  })

  it('falls back to the first option when the agent offered only its own kind', () => {
    // An agent may declare a custom kind. Refusing to answer at all would hang
    // the turn, so the first usable option is taken.
    expect(pickAutoOption([opt('c1', 'custom_kind'), opt('c2', 'other')])?.optionId).toBe('c1')
  })

  it('answers nothing when there is nothing to answer', () => {
    // `undefined` is the caller's cue to degrade to `abort`: guessing an option
    // is worse than refusing, and hanging is worse than either.
    expect(pickAutoOption([])).toBeUndefined()
    // An option with no id cannot be answered with — it would be a reply the
    // agent cannot match.
    expect(pickAutoOption([opt('', 'allow_always')])).toBeUndefined()
  })
})

describe('PermissionLedger', () => {
  it('resolves exactly once and settles scoped pendings as cancelled', () => {
    const ledger = new PermissionLedger()
    let a: unknown
    let b: unknown
    const ra = ledger.create('s1', o => { a = o })
    const rb = ledger.create('s2', o => { b = o })
    ledger.respond(ra, { outcome: 'selected', optionId: 'allow1' })
    expect(a).toEqual({ outcome: 'selected', optionId: 'allow1' })
    expect(() => ledger.respond(ra, { outcome: 'cancelled' })).toThrow(/no pending/)
    ledger.settleFor(p => p.sessionId === 's2')
    expect(b).toEqual({ outcome: 'cancelled' })
    expect(ledger.sessionIds()).toHaveLength(0)
    void rb
  })

  it('replays only asks that carry a view, as their original request frame', () => {
    const ledger = new PermissionLedger()
    // Every field the live frame carried must ride the replay too: the
    // conversation card filters on `dshSessionId` and renders `toolName` /
    // `deadlineAt`, so a replay missing one would silently drop the ask.
    const view = {
      dshSessionId: 'chat-1',
      toolCall: { title: 'Bash' },
      toolName: 'Bash',
      reason: 'Bash · ls -la',
      options: [{ optionId: 'allow1', name: 'Allow once', kind: 'allow_once' }],
      timeoutMode: 'abort' as const,
      deadlineAt: 1_700_000_000_000,
    }
    const shown = ledger.create('s1', () => {}, view)
    // An entry without a view still answers — it just cannot be re-shown.
    const hidden = ledger.create('s2', () => {})

    expect(ledger.pendingViews()).toEqual([{ requestId: shown, sessionId: 's1', ...view }])

    const frames = permissionReplayFrames(ledger.pendingViews())
    // The ask rides its ORIGINAL frame: the client folds both by request id,
    // so a replay that arrived alongside the live broadcast is idempotent.
    expect(frames[0]).toEqual({ type: 'permission/request', requestId: shown, sessionId: 's1', ...view })
    // …and the terminator carries the live set, so a client that reconnects
    // drops anything it still holds from before the disconnect.
    expect(frames.at(-1)).toEqual({ type: 'permission/synced', requestIds: [shown] })

    ledger.respond(shown, { outcome: 'cancelled' })
    expect(permissionReplayFrames(ledger.pendingViews())).toEqual([{ type: 'permission/synced', requestIds: [] }])
    void hidden
  })
})

function fakeManager(): AcpManager & { calls: Array<[string, unknown]> } {
  const calls: Array<[string, unknown]> = []
  return {
    calls,
    agentViews: () => { calls.push(['agents', undefined]); return [] },
    startSession: async (agentId, cwd) => { calls.push(['start', { agentId, cwd }]); return { sessionId: 'S' } },
    prompt: async (sessionId, text) => { calls.push(['prompt', { sessionId, text }]); return { turnId: 'T' } },
    cancel: async id => { calls.push(['cancel', id]) },
    closeSession: async id => { calls.push(['close', id]) },
    setMode: async (id, m) => { calls.push(['mode', { id, m }]) },
    setConfigOption: async (id, c, v) => { calls.push(['config', { id, c, v }]) },
    respondPermission: (r, o) => { calls.push(['perm', { r, o }]) },
    transcript: (id) => ({ session: { id }, entries: [] }),
    sessions: () => [],
    stopAgent: async id => { calls.push(['stop', id]) },
    defaultAgent: () => 'mock',
    setDefaultAgent: async id => { calls.push(['setDefaultAgent', id]) },
    tagHalo: () => ({ mode: 'breath', speed: 'slow' }),
    setTagHalo: async halo => { calls.push(['setTagHalo', halo]) },
    approvalDeadlines: () => ({ permissionTimeoutMs: 300_000, mode: 'abort' as const }),
    setApprovalDeadlines: async (patch, reset) => { calls.push(['setApprovalDeadlines', patch, reset]) },
    bindChatAgent: (dshSessionId, agentId) => { calls.push(['bindChatAgent', dshSessionId, agentId]) },
    setChatSessionModel: async (dshSessionId, modelId) => { calls.push(['setChatSessionModel', dshSessionId, modelId]) },
    setChatSessionEffort: async (dshSessionId, effort) => { calls.push(['setChatSessionEffort', dshSessionId, effort]) },
    detectAgents: async () => { calls.push(['detect', undefined]); return [] },
    saveAgent: async def => { calls.push(['save', def]) },
    deleteAgent: async id => { calls.push(['delete', id]) },
    testAgent: async def => {
      calls.push(['test', def])
      return { ok: true, durationMs: 5, stderr: [] }
    },
    setExposedModels: async (id, exposed) => { calls.push(['setExposedModels', { id, exposed }]) },
    setAutoDiscoverModels: async (id, autoDiscoverModels) => { calls.push(['setAutoDiscoverModels', { id, autoDiscoverModels }]) },
    probeAgentModels: async agentId => {
      calls.push(['probe', agentId])
      return { agentId, catalog: { model: { configId: 'model', name: 'Model', currentValue: 'a', choices: [{ value: 'a', name: 'A' }] } }, updatedAt: 1 }
    },
    // Stands in for the host's persisted catalog (`cachedAgentModels`) — the
    // read that fills the settings panes on mount without a probe.
    cachedAgentModels: agentId => {
      calls.push(['cachedModels', agentId])
      return { agentId, catalog: { model: { configId: 'model', name: 'Model', currentValue: 'a', choices: [{ value: 'a', name: 'A' }] } }, updatedAt: 2 }
    },
    agentCatalog: agentId => {
      calls.push(['catalog', agentId])
      return {
        agentId,
        title: 'Agent',
        base: { id: agentId, name: 'Agent' },
        variants: [{ id: `${agentId}@a`, name: 'Agent · A' }],
        probed: true,
        updatedAt: 1,
      }
    },
    chatTranscripts: (dshSessionId, afterSeq) => {
      calls.push(['chatTranscripts', { dshSessionId, afterSeq }])
      return []
    },
  }
}

describe('dispatchRpc', () => {
  it('routes endpoints and normalizes errors into the Connection result shape', async () => {
    const manager = fakeManager()
    // `agents/list` is the roster alone: the retired approval/access-mode axes
    // have no reporting field left.
    await expect(dispatchRpc(manager, 'agents/list', {})).resolves.toEqual({
      ok: true,
      value: { agents: [] },
    })
    expect(manager.calls).toContainEqual(['agents', undefined])
    // Optional chat-session mode surface: a manager without it reports none.
    await expect(dispatchRpc(manager, 'session/chat-list', { dshSessionId: 'chat-1' })).resolves.toEqual({ ok: true, value: { sessions: [], acpMode: false } })
    // The seat gate's fallback fact source: read-only, memory-only, and false
    // when the manager lacks the method (an older host half) or the resolver.
    const acpModeOn = { ...manager, chatSessionAcpMode: (dshSessionId: string) => dshSessionId === 'chat-1' }
    await expect(dispatchRpc(acpModeOn, 'session/chat-list', { dshSessionId: 'chat-1' })).resolves.toEqual({ ok: true, value: { sessions: [], acpMode: true } })
    await expect(dispatchRpc(acpModeOn, 'session/chat-list', { dshSessionId: 'chat-2' })).resolves.toEqual({ ok: true, value: { sessions: [], acpMode: false } })
    // The one-way agent lock: reported alongside the binding, and absent (not a
    // false field) on a manager from before the lock existed.
    const locked = { ...manager, lockedAgentFor: (dshSessionId: string) => (dshSessionId === 'chat-1' ? 'pi' : undefined) }
    await expect(dispatchRpc(locked, 'session/chat-list', { dshSessionId: 'chat-1' }))
      .resolves.toMatchObject({ ok: true, value: { lockedAgentId: 'pi' } })
    await expect(dispatchRpc(manager, 'session/chat-list', { dshSessionId: 'chat-1' }))
      .resolves.toEqual({ ok: true, value: { sessions: [], acpMode: false } })
    await expect(dispatchRpc(manager, 'session/chat-mode-set', { dshSessionId: 'chat-1', modeId: 'strict' })).resolves.toEqual({ ok: true, value: { done: true } })
    await expect(dispatchRpc(manager, 'session/chat-list', {})).resolves.toMatchObject({ ok: false, error: { code: 'bad_payload' } })
    // The ACP view's data source: addressed by the CHAT session id, because
    // the browser has no ACP session id before the first turn.
    await expect(dispatchRpc(manager, 'session/chat-transcript', { dshSessionId: 'chat-1' })).resolves.toEqual({ ok: true, value: { views: [] } })
    expect(manager.calls).toContainEqual(['chatTranscripts', { dshSessionId: 'chat-1', afterSeq: undefined }])
    await expect(dispatchRpc(manager, 'session/chat-transcript', { dshSessionId: 'chat-1', afterSeq: 7 })).resolves.toEqual({ ok: true, value: { views: [] } })
    expect(manager.calls).toContainEqual(['chatTranscripts', { dshSessionId: 'chat-1', afterSeq: 7 }])
    await expect(dispatchRpc(manager, 'session/chat-transcript', {})).resolves.toMatchObject({ ok: false, error: { code: 'bad_payload' } })
    await expect(dispatchRpc(manager, 'session/chat-transcript', { dshSessionId: 'chat-1', afterSeq: 'x' })).resolves.toMatchObject({ ok: false, error: { code: 'bad_payload' } })
    // A host half without the method answers an empty list rather than failing.
    await expect(dispatchRpc({ ...manager, chatTranscripts: undefined }, 'session/chat-transcript', { dshSessionId: 'chat-1' })).resolves.toEqual({ ok: true, value: { views: [] } })
    // Preset surface: a host half with no roster reader reports `null` instead
    // of failing, so the panel's status poll still answers (and hides the block).
    await expect(dispatchRpc(manager, 'preset/status', {})).resolves.toEqual({ ok: true, value: { preset: null } })
    const withPreset = {
      ...manager,
      presetStatus: async () => ({
        id: 'acp',
        source: 'dsh-ntr/presets/acp/acp.patch.yml',
        installed: false,
        problem: 'the harness preset roster does not carry this declaration',
      }),
    }
    await expect(dispatchRpc(withPreset, 'preset/status', {})).resolves.toEqual({
      ok: true,
      value: {
        preset: {
          id: 'acp',
          source: 'dsh-ntr/presets/acp/acp.patch.yml',
          installed: false,
          problem: 'the harness preset roster does not carry this declaration',
        },
      },
    })
    await expect(dispatchRpc(manager, 'agents/detect', {})).resolves.toEqual({ ok: true, value: { agents: [] } })
    expect(manager.calls).toContainEqual(['detect', undefined])
    await expect(dispatchRpc(manager, 'agent/save', { id: 'pi', command: 'pi-acp' })).resolves.toEqual({ ok: true, value: { done: true } })
    expect(manager.calls).toContainEqual(['save', expect.objectContaining({ id: 'pi', command: 'pi-acp' })])
    await expect(dispatchRpc(manager, 'agent/test', { id: 'pi', command: 'pi-acp', npmPackage: 'pi-acp' })).resolves.toEqual({ ok: true, value: { ok: true, durationMs: 5, stderr: [] } })
    expect(manager.calls).toContainEqual(['test', expect.objectContaining({ id: 'pi', command: 'pi-acp', npmPackage: 'pi-acp' })])
    await expect(dispatchRpc(manager, 'agent/test', { id: 'pi', command: 'pi-acp', npmPackage: 'bad name' })).resolves.toMatchObject({ ok: false, error: { code: 'bad_config' } })
    await expect(dispatchRpc(manager, 'agent/test', { id: 'pi' })).resolves.toMatchObject({ ok: false, error: { code: 'bad_config' } })
    const bareTest = { ...manager, testAgent: undefined }
    await expect(dispatchRpc(bareTest, 'agent/test', { id: 'pi', command: 'pi-acp' })).resolves.toMatchObject({ ok: false, error: { code: 'unsupported' } })
    await expect(dispatchRpc(manager, 'agent/delete', { agentId: 'pi' })).resolves.toEqual({ ok: true, value: { done: true } })
    expect(manager.calls).toContainEqual(['delete', 'pi'])
    await expect(dispatchRpc(manager, 'session/start', { agentId: 'a' })).resolves.toEqual({ ok: true, value: { sessionId: 'S' } })
    await expect(dispatchRpc(manager, 'nope', {})).resolves.toMatchObject({ ok: false, error: { code: 'unknown_endpoint' } })
    await expect(dispatchRpc(manager, 'session/prompt', { sessionId: 'S' })).resolves.toMatchObject({
      ok: false,
      error: { code: 'bad_payload', details: {} },
    })
    await expect(dispatchRpc(manager, 'session/prompt', { sessionId: 'S', text: 3 })).resolves.toMatchObject({ ok: false })
    await expect(dispatchRpc(manager, 'session/config-set', { sessionId: 'S', configId: 'm', value: 42 })).resolves.toMatchObject({ ok: false, error: { code: 'bad_payload' } })
    // The plugin's OWN default ACP agent (the panel's ★ gesture) — a
    // plugin-private id, never a DSH model route.
    await expect(dispatchRpc(manager, 'default/agent', {})).resolves.toEqual({ ok: true, value: { agentId: 'mock' } })
    await expect(dispatchRpc(manager, 'default/agent-set', { agentId: 'custom' })).resolves.toEqual({ ok: true, value: { done: true } })
    expect(manager.calls).toContainEqual(['setDefaultAgent', 'custom'])
    // A host half with no default agent answers `undefined` → the panel shows no ★.
    await expect(dispatchRpc({ ...manager, defaultAgent: undefined }, 'default/agent', {})).resolves.toEqual({ ok: true, value: { agentId: undefined } })
    // Clearing the default is legal and is the only way to remove a star.
    await expect(dispatchRpc(manager, 'default/agent-set', {})).resolves.toEqual({ ok: true, value: { done: true } })
    expect(manager.calls).toContainEqual(['setDefaultAgent', undefined])
    // The tag halo preference: read falls back to the default on an older host
    // half; writes are validated (only the settings card's enums pass).
    await expect(dispatchRpc(manager, 'ui/tag-halo', {})).resolves.toEqual({ ok: true, value: { halo: { mode: 'breath', speed: 'slow' } } })
    await expect(dispatchRpc({ ...manager, tagHalo: undefined }, 'ui/tag-halo', {})).resolves.toEqual({ ok: true, value: { halo: { mode: 'breath', speed: 'normal' } } })
    await expect(dispatchRpc(manager, 'ui/tag-halo-set', { halo: { mode: 'steady', speed: 'fast' } })).resolves.toEqual({ ok: true, value: { done: true } })
    expect(manager.calls).toContainEqual(['setTagHalo', { mode: 'steady', speed: 'fast' }])
    await expect(dispatchRpc(manager, 'ui/tag-halo-set', { halo: { mode: 'blink', speed: 'fast' } })).resolves.toMatchObject({ ok: false, error: { code: 'bad_payload' } })
    await expect(dispatchRpc(manager, 'ui/tag-halo-set', { halo: { mode: 'breath', speed: 'ludicrous' } })).resolves.toMatchObject({ ok: false, error: { code: 'bad_payload' } })
    await expect(dispatchRpc(manager, 'ui/tag-halo-set', {})).resolves.toMatchObject({ ok: false, error: { code: 'bad_payload' } })
    // The approval deadlines: read is `undefined` on an older host half (which
    // hides the card), and a write is validated before it reaches the manager —
    // the same range the config file is held to, so a value the card can send is
    // a value the next boot accepts.
    await expect(dispatchRpc(manager, 'ui/approval-deadlines', {})).resolves.toEqual({
      ok: true,
      value: { deadlines: { permissionTimeoutMs: 300_000, mode: 'abort' } },
    })
    await expect(dispatchRpc({ ...manager, approvalDeadlines: undefined }, 'ui/approval-deadlines', {})).resolves.toEqual({
      ok: true,
      value: { deadlines: undefined },
    })
    await expect(dispatchRpc(manager, 'ui/approval-deadlines-set', { permissionTimeoutMs: 60_000 })).resolves.toEqual({
      ok: true,
      value: { deadlines: { permissionTimeoutMs: 300_000, mode: 'abort' } },
    })
    // Only the touched key travels: the manager merges, so a card that edited
    // the window must not reset the mode.
    expect(manager.calls).toContainEqual(['setApprovalDeadlines', { permissionTimeoutMs: 60_000 }, false])
    // The mode travels through the same route, and only the three values pass.
    await expect(dispatchRpc(manager, 'ui/approval-deadlines-set', { mode: 'auto' })).resolves.toMatchObject({ ok: true })
    expect(manager.calls).toContainEqual(['setApprovalDeadlines', { mode: 'auto' }, false])
    for (const bad of ['maybe', '', 1, null]) {
      await expect(dispatchRpc(manager, 'ui/approval-deadlines-set', { mode: bad }))
        .resolves.toMatchObject({ ok: false, error: { code: 'bad_payload' } })
    }
    await expect(dispatchRpc(manager, 'ui/approval-deadlines-set', { reset: true })).resolves.toMatchObject({ ok: true })
    expect(manager.calls).toContainEqual(['setApprovalDeadlines', {}, true])
    for (const bad of [-1, 1.5, 86_400_001, '60000']) {
      await expect(dispatchRpc(manager, 'ui/approval-deadlines-set', { permissionTimeoutMs: bad }))
        .resolves.toMatchObject({ ok: false, error: { code: 'bad_payload' } })
    }
    // `0` is the meaningful value (一直等), not a rejection.
    await expect(dispatchRpc(manager, 'ui/approval-deadlines-set', { permissionTimeoutMs: 0 }))
      .resolves.toMatchObject({ ok: true })
    expect(manager.calls).toContainEqual(['setApprovalDeadlines', { permissionTimeoutMs: 0 }, false])
    // An unknown key is dropped rather than persisted into state, and the two
    // legacy windows can no longer be smuggled back in.
    await expect(dispatchRpc(manager, 'ui/approval-deadlines-set', { bogusKey: 5 })).resolves.toMatchObject({ ok: true })
    expect(manager.calls).toContainEqual(['setApprovalDeadlines', {}, false])
    await expect(dispatchRpc(manager, 'ui/approval-deadlines-set', { nativeApprovalTimeoutMs: 60_000 })).resolves.toMatchObject({ ok: true })
    expect(manager.calls).toContainEqual(['setApprovalDeadlines', {}, false])
    // The conversation↔agent mapping: the plugin's own binding, never a model route.
    await expect(dispatchRpc(manager, 'session/chat-bind', { dshSessionId: 'chat-1', agentId: 'pi' })).resolves.toEqual({ ok: true, value: { done: true } })
    expect(manager.calls).toContainEqual(['bindChatAgent', 'chat-1', 'pi'])
    await expect(dispatchRpc(manager, 'session/chat-model-set', { dshSessionId: 'chat-1', modelId: 'pi@a' })).resolves.toEqual({ ok: true, value: { done: true } })
    expect(manager.calls).toContainEqual(['setChatSessionModel', 'chat-1', 'pi@a'])
    await expect(dispatchRpc(manager, 'session/chat-effort-set', { dshSessionId: 'chat-1', effort: 'high' })).resolves.toEqual({ ok: true, value: { done: true } })
    expect(manager.calls).toContainEqual(['setChatSessionEffort', 'chat-1', 'high'])
    // Absent effort clears it (follow the agent's own default).
    await expect(dispatchRpc(manager, 'session/chat-effort-set', { dshSessionId: 'chat-1' })).resolves.toEqual({ ok: true, value: { done: true } })
    expect(manager.calls).toContainEqual(['setChatSessionEffort', 'chat-1', undefined])
    await expect(dispatchRpc(manager, 'session/chat-bind', { dshSessionId: 'chat-1' })).resolves.toMatchObject({ ok: false, error: { code: 'bad_payload' } })
    await expect(dispatchRpc(manager, 'agent/probe-models', { agentId: 'pi' })).resolves.toMatchObject({
      ok: true,
      value: { agentId: 'pi', catalog: { model: { configId: 'model' } } },
    })
    expect(manager.calls).toContainEqual(['probe', 'pi'])
    await expect(dispatchRpc(manager, 'agent/probe-models', {})).resolves.toMatchObject({ ok: false, error: { code: 'bad_payload' } })
    const bare = { ...manager, probeAgentModels: undefined }
    await expect(dispatchRpc(bare, 'agent/probe-models', { agentId: 'pi' })).resolves.toMatchObject({ ok: false, error: { code: 'unsupported' } })
    // The settings panel's mount read: the host's persisted catalog, no probe.
    await expect(dispatchRpc(manager, 'agent/cached-models', { agentId: 'pi' })).resolves.toMatchObject({
      ok: true,
      value: { agentId: 'pi', updatedAt: 2 },
    })
    expect(manager.calls).toContainEqual(['cachedModels', 'pi'])
    await expect(dispatchRpc(manager, 'agent/cached-models', {})).resolves.toMatchObject({ ok: false, error: { code: 'bad_payload' } })
    // An older host half without the read answers `null` rather than failing:
    // the panel then shows its empty state and the button still works.
    await expect(dispatchRpc({ ...manager, cachedAgentModels: undefined }, 'agent/cached-models', { agentId: 'pi' }))
      .resolves.toEqual({ ok: true, value: null })
    // `agent/catalog` is the seats' model list — the ONLY place ACP models are
    // offered, since the `acp` route advertises nothing in DSH's own catalog.
    await expect(dispatchRpc(manager, 'agent/catalog', { agentId: 'pi' })).resolves.toMatchObject({
      ok: true,
      value: { agentId: 'pi', base: { id: 'pi' }, variants: [{ id: 'pi@a' }], probed: true },
    })
    expect(manager.calls).toContainEqual(['catalog', 'pi'])
    await expect(dispatchRpc(manager, 'agent/catalog', {})).resolves.toMatchObject({ ok: false, error: { code: 'bad_payload' } })
    await expect(dispatchRpc(manager, 'agent/set-exposed-models', { agentId: 'pi', exposedModels: ['a', 'b'] })).resolves.toEqual({ ok: true, value: { done: true } })
    expect(manager.calls).toContainEqual(['setExposedModels', { id: 'pi', exposed: ['a', 'b'] }])
    await expect(dispatchRpc(manager, 'agent/set-exposed-models', { agentId: 'pi' })).resolves.toEqual({ ok: true, value: { done: true } })
    expect(manager.calls).toContainEqual(['setExposedModels', { id: 'pi', exposed: undefined }])
    await expect(dispatchRpc(manager, 'agent/set-exposed-models', { agentId: 'pi', exposedModels: ['ok', ''] })).resolves.toMatchObject({ ok: false, error: { code: 'bad_payload' } })
    await expect(dispatchRpc(manager, 'agent/set-exposed-models', { agentId: 'pi', exposedModels: 'a' })).resolves.toMatchObject({ ok: false, error: { code: 'bad_payload' } })
    await expect(dispatchRpc(manager, 'agent/set-exposed-models', {})).resolves.toMatchObject({ ok: false, error: { code: 'bad_payload' } })
    // A whole real catalog must go through in one call (see the config-side case).
    const catalog = Array.from({ length: 581 }, (_, i) => `provider/model-${String(i)}`)
    await expect(dispatchRpc(manager, 'agent/set-exposed-models', { agentId: 'omp', exposedModels: catalog })).resolves.toEqual({ ok: true, value: { done: true } })
    expect(manager.calls).toContainEqual(['setExposedModels', { id: 'omp', exposed: catalog }])
    // Auto-discovery is a per-agent switch on the same lightweight surface —
    // never `agent/save`, which would restart the process.
    await expect(dispatchRpc(manager, 'agent/set-auto-discover-models', { agentId: 'pi', autoDiscoverModels: true })).resolves.toEqual({ ok: true, value: { done: true } })
    expect(manager.calls).toContainEqual(['setAutoDiscoverModels', { id: 'pi', autoDiscoverModels: true }])
    await expect(dispatchRpc(manager, 'agent/set-auto-discover-models', { agentId: 'pi', autoDiscoverModels: 'yes' })).resolves.toMatchObject({ ok: false, error: { code: 'bad_payload' } })
    await expect(dispatchRpc(manager, 'agent/set-auto-discover-models', { agentId: 'pi' })).resolves.toMatchObject({ ok: false, error: { code: 'bad_payload' } })
    await expect(dispatchRpc(manager, 'agent/set-auto-discover-models', { autoDiscoverModels: true })).resolves.toMatchObject({ ok: false, error: { code: 'bad_payload' } })
  })

  it('invokes agent/probe-models as a manager method so the receiver (`this`) survives', async () => {
    const receiver = fakeManager() as AcpManager & { marker: string }
    receiver.marker = 'host'
    Object.assign(receiver, {
      // A `this`-reading method like the real BridgeManager.probeAgentModels
      // (which dereferences this.bridge); an arrow fake would hide the bug.
      probeAgentModels(this: { marker: string }, agentId: string): Promise<AgentProbeModelsResult> {
        if (this?.marker !== 'host') throw new AcpError('internal', 'probe lost its manager receiver')
        return Promise.resolve({ agentId, catalog: {}, updatedAt: 1 })
      },
    })
    await expect(dispatchRpc(receiver, 'agent/probe-models', { agentId: 'pi' })).resolves.toEqual({
      ok: true,
      value: { agentId: 'pi', catalog: {}, updatedAt: 1 },
    })
  })

  it('rejects oversized text payloads with a protocol error, not a crash', async () => {
    const manager = fakeManager()
    const huge = 'x'.repeat((1 << 20) + 1)
    const result = await dispatchRpc(manager, 'session/prompt', { sessionId: 'S', text: huge })
    expect(result.ok).toBe(false)
  })
})

describe('EventHub', () => {
  it('isolates subscriber failures', () => {
    const hub = new EventHub()
    const seen: unknown[] = []
    hub.subscribe(() => { throw new Error('boom') })
    hub.subscribe(e => { seen.push(e) })
    hub.broadcast({ type: 'session/closed', sessionId: 'x', reason: 'closed' })
    expect(seen).toHaveLength(1)
  })
})

describe('the retired permission axis (nothing here may arbitrate an agent ask)', () => {
  // The whole "DSH access mode maps onto ACP permission decisions" layer is gone
  // (docs/acp-convergence.md §2.3): an ACP agent is fully autonomous, its
  // `session/request_permission` is mapped to the user unchanged, and DSH's
  // sandbox cannot reach into the agent's own process anyway. These cases pin
  // the two facts that made the old axis actively harmful.
  it('has no exported decision helper left to reach for', async () => {
    const impl = await import('../src/impl.ts') as Record<string, unknown>
    for (const gone of ['decidePermission', 'dshSessionPolicyOf', 'dshApprovalPolicyOf', 'sandboxDenialMarker']) {
      expect(impl[gone]).toBeUndefined()
    }
  })

  it('still fences a workspace, because that boundary is real and always was', () => {
    // What survives is only the workspace guard: a write or read outside the
    // session's resolved roots is refused. That is not a policy layer — it is
    // the same containment the ACP file protocol requires.
    const realpath = (p: string): string => p
    expect(resolveFsPath('/srv/ws', ['/srv/ws'], 'a.txt', realpath)).toBe('/srv/ws/a.txt')
    expect(() => resolveFsPath('/srv/ws', ['/srv/ws'], '/etc/hosts', realpath)).toThrow(AcpError)
    expect(() => canonicalizeFsPath('/srv/ws', '', realpath)).toThrow(AcpError)
  })
})