import { describe, expect, it } from 'vitest'
import {
  AcpError,
  EventHub,
  PermissionLedger,
  Transcript,
  acpToolCallArgsOf,
  acpToolCallDelta,
  acpToolCallFromUpdate,
  ACP_TOOL_CALL_NAME,
  appendExternalSubagentCatalog,
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
  isFinalToolCallStatus,
  isLocalFilePath,
  normalizeFileUrlToPath,
  isUnderPath,
  MAX_CONFIG_OPTIONS_BYTES,
  hasUnambiguousModelSelector,
  mergeCatalogShape,
  parseCatalogOptions,
  permissionReplayFrames,
  pickAutoOption,
  usableConfigOptions,
  permissionToolKind,
  permissionToolPaths,
  resolveFsPath,
  resolveSessionCwd,
  resolveImageAttachmentFromContext,
  selectForwardPrompt,
  extractSessionTitlePlaceholder,
  SESSION_TITLE_PLACEHOLDER_MAX,
  detectImageMimeFromMagic,
  sessionAgentPreset,
  sessionAgentPresetFromLog,
  splitAdapterModelId,
  splitCommandLine,
  quoteCommandToken,
  tokenizeCommandLine,
  skillFlavorOf,
  SKILL_DIRS_BY_FLAVOR,
  GENERIC_SKILL_DIRS,
  SKILL_SCAN_LIMITS,
  parseSkillFrontmatter,
  skillMetadata,
  skillMentionToken,
  formatSkillPathDestination,
  formatSkillMentionPrompt,
  validateAgentDef,
  validateApprovalDeadlines,
  validateConfig,
  agentSaveAction,
  ACP_TOOL_RAW_MAX,
  boundSubagentDetailEntry,
  capSubagentRecords,
  normalizeSubagentRecord,
  normalizeSubagentRecordMap,
} from '../src/impl.ts'
import { agentRefusalDetail } from '../src/bridge.ts'
import type { AcpManager } from '../src/impl.ts'
import type { AcpAgentDef, AgentProbeModelsResult, PermissionOptionView, SubagentRecord } from '../src/protocol.ts'
import { MAX_SUBAGENT_RECORDS, SESSION_TITLE_PREFIX } from '../src/protocol.ts'

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
  it('accepts the agyLateOutput switch as an optional boolean', () => {
    // Absent: the tuning default (on) stays in force; the config object must
    // not carry `undefined`, or the host entry would overwrite the default.
    expect(validateConfig({ agents: [] })).not.toHaveProperty('agyLateOutput')
    expect(validateConfig({ agents: [], agyLateOutput: false }).agyLateOutput).toBe(false)
    expect(validateConfig({ agents: [], agyLateOutput: true }).agyLateOutput).toBe(true)
    expect(() => validateConfig({ agents: [], agyLateOutput: 'yes' })).toThrow(/agyLateOutput/)
    expect(() => validateConfig({ agents: [], agyLateOutput: 0 })).toThrow(/agyLateOutput/)
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
  it('defaults and bounds the inactivity watchdog windows', () => {
    // Two silence windows (no tool in flight / tool in flight) plus the scan
    // interval. All three are diagnostic knobs, not UI controls: `0` means
    // "off" or "fall back", never "expire immediately".
    const config = validateConfig({ agents: [] })
    expect(config.turnStallMs).toBe(600_000)
    expect(config.turnStallToolMs).toBe(1_800_000)
    expect(config.turnStallTickMs).toBe(30_000)

    expect(validateConfig({ agents: [], turnStallMs: 0, turnStallToolMs: 0, turnStallTickMs: 1 }))
      .toMatchObject({ turnStallMs: 0, turnStallToolMs: 0, turnStallTickMs: 1 })

    // Out of range / non-integers are refused loudly at boot.
    expect(() => validateConfig({ agents: [], turnStallMs: -1 })).toThrow(/turnStallMs/)
    expect(() => validateConfig({ agents: [], turnStallMs: 1.5 })).toThrow(/turnStallMs/)
    expect(() => validateConfig({ agents: [], turnStallMs: 86_400_001 })).toThrow(/turnStallMs/)
    expect(() => validateConfig({ agents: [], turnStallToolMs: -1 })).toThrow(/turnStallToolMs/)
    expect(() => validateConfig({ agents: [], turnStallToolMs: 1.5 })).toThrow(/turnStallToolMs/)
    expect(() => validateConfig({ agents: [], turnStallToolMs: 86_400_001 })).toThrow(/turnStallToolMs/)
    expect(() => validateConfig({ agents: [], turnStallTickMs: 0 })).toThrow(/turnStallTickMs/)
    expect(() => validateConfig({ agents: [], turnStallTickMs: 1.5 })).toThrow(/turnStallTickMs/)
    expect(() => validateConfig({ agents: [], turnStallTickMs: 60_001 })).toThrow(/turnStallTickMs/)
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

  it('keeps the model selector when an agent mislabels an effort option as category:model', () => {
    // Qoder CN 1.1.56 (issue #8): the `set_config_option(model, ...)` answer
    // tags BOTH `model` and `reasoning_effort` as category:'model'. Last-wins
    // used to replace the model list with the effort list, after which every
    // send was refused as `model_unavailable` before reaching the agent.
    const catalog = parseCatalogOptions([
      { configId: 'mode', name: 'Mode', type: 'select', category: 'mode', currentValue: 'default', options: [
        { value: 'default', name: 'Default' },
        { value: 'yolo', name: 'Bypass Permissions' },
      ] },
      { configId: 'model', name: 'Model', type: 'select', category: 'model', currentValue: 'qfmodel', options: [
        { value: 'auto', name: 'Auto (default)' },
        { value: 'qfmodel', name: 'Qwen3.8-Flash' },
        { value: 'dmodel', name: 'DeepSeek-V4-Pro' },
      ] },
      { configId: 'reasoning_effort', name: 'Reasoning Effort', type: 'select', category: 'model', currentValue: 'xhigh', options: [
        { value: 'xhigh', name: 'Extra High' },
        { value: 'low', name: 'Low' },
        { value: 'medium', name: 'Medium' },
        { value: 'none', name: 'None' },
      ] },
    ])
    expect(catalog.model?.configId).toBe('model')
    expect(catalog.model?.currentValue).toBe('qfmodel')
    expect(catalog.model?.choices.map(choice => choice.value)).toEqual(['auto', 'qfmodel', 'dmodel'])
    // The mislabelled effort is not a second model list: it is the thought
    // control the agent should have published in the first place.
    expect(catalog.thought?.configId).toBe('reasoning_effort')
    expect(catalog.thought?.currentValue).toBe('xhigh')
    expect(catalog.thought?.choices.map(choice => choice.value)).toEqual(['xhigh', 'low', 'medium', 'none'])
    expect(catalog.mode?.configId).toBe('mode')
    expect(catalog.extras).toBeUndefined()
  })

  it('never lets a same-category option replace a slot and keeps the loser settable', () => {
    const catalog = parseCatalogOptions([
      { configId: 'model', name: 'Model', category: 'model', currentValue: 'a', options: [
        { value: 'a', name: 'A' },
        { value: 'b', name: 'B' },
      ] },
      // Non-effort model-scoped option: a last-resort selector only.
      { configId: 'variant', name: 'Variant', category: 'model', currentValue: 'x', options: [{ value: 'x', name: 'X' }] },
      // A real thought_level outranks the mislabelled effort, which stays an
      // extra instead of vanishing.
      { configId: 'thought_level', name: 'Thinking', category: 'thought_level', currentValue: 'high', options: [{ value: 'high', name: 'High' }] },
      { configId: 'reasoning_effort', name: 'Reasoning Effort', category: 'model', currentValue: 'low', options: [{ value: 'low', name: 'Low' }] },
    ])
    expect(catalog.model?.configId).toBe('model')
    expect(catalog.thought?.configId).toBe('thought_level')
    expect(catalog.extras?.map(option => option.configId)).toEqual(['variant', 'reasoning_effort'])
  })
})

describe('hasUnambiguousModelSelector', () => {
  it('trusts an explicit model id, or a single model-scoped option', () => {
    expect(hasUnambiguousModelSelector([{ configId: 'model', category: 'model' }])).toBe(true)
    expect(hasUnambiguousModelSelector([{ configId: 'reasoning_effort', category: 'model' }])).toBe(true)
    expect(hasUnambiguousModelSelector([
      { configId: 'model', category: 'model' },
      { configId: 'reasoning_effort', category: 'model' },
    ])).toBe(true)
    expect(hasUnambiguousModelSelector([{ configId: 'modelId', name: 'Model', category: 'model' }, { configId: 'other', category: 'model' }])).toBe(true)
  })

  it('reports ambiguity when several model-scoped options exist and none is the selector', () => {
    expect(hasUnambiguousModelSelector([
      { configId: 'alpha', category: 'model' },
      { configId: 'beta', category: 'model' },
    ])).toBe(false)
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

  it('heals a poisoned model slot on the next observation', () => {
    // A catalog persisted by the broken parser holds `reasoning_effort` in the
    // model slot. The corrected observation replaces the identity, and the old
    // effort value is not carried over because the real model list cannot
    // offer it.
    const existing = {
      model: { configId: 'reasoning_effort', name: 'Reasoning Effort', currentValue: 'xhigh', choices: choiceList(['xhigh', 'low']) },
    }
    const observed = parseCatalogOptions([
      { configId: 'model', name: 'Model', category: 'model', currentValue: 'qfmodel', options: [
        { value: 'auto', name: 'Auto' },
        { value: 'qfmodel', name: 'Qwen3.8-Flash' },
      ] },
      { configId: 'reasoning_effort', name: 'Reasoning Effort', category: 'model', currentValue: 'xhigh', options: [
        { value: 'xhigh', name: 'Extra High' },
        { value: 'low', name: 'Low' },
      ] },
    ])
    const merged = mergeCatalogShape(existing, observed)
    expect(merged.model?.configId).toBe('model')
    expect(merged.model?.currentValue).toBeNull()
    expect(merged.thought?.configId).toBe('reasoning_effort')
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

  it('extracts direct base64 image blocks and populates images and content arrays', () => {
    const picked = selectForwardPrompt([
      {
        role: 'user',
        id: 'msg-img',
        content: [
          { type: 'text', text: 'look at this image' },
          { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' },
        ],
      },
    ])
    expect(picked).toEqual({
      kind: 'prompt',
      id: 'msg-img',
      text: 'look at this image',
      images: [{ type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' }],
      content: [
        { type: 'text', text: 'look at this image' },
        { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' },
      ],
    })
  })

  it('parses data URLs and anthropic source image blocks', () => {
    const picked = selectForwardPrompt([
      {
        role: 'user',
        content: [
          { type: 'image', url: 'data:image/jpeg;base64,/9j/4AAQSkZJRg==' },
          { type: 'image', source: { type: 'base64', media_type: 'image/webp', data: 'UklGRiQAAABXRUJQVlA=' } },
        ],
      },
    ])
    expect(picked).toEqual({
      kind: 'prompt',
      text: '',
      images: [
        { type: 'image', data: '/9j/4AAQSkZJRg==', mimeType: 'image/jpeg', uri: 'data:image/jpeg;base64,/9j/4AAQSkZJRg==' },
        { type: 'image', data: 'UklGRiQAAABXRUJQVlA=', mimeType: 'image/webp' },
      ],
      content: [
        { type: 'image', data: '/9j/4AAQSkZJRg==', mimeType: 'image/jpeg', uri: 'data:image/jpeg;base64,/9j/4AAQSkZJRg==' },
        { type: 'image', data: 'UklGRiQAAABXRUJQVlA=', mimeType: 'image/webp' },
      ],
    })
  })

  it('reads file paths via context readFile and resolves MIME types', () => {
    const context = {
      readFile: (path: string) => (path === '/workspace/test.png' ? Buffer.from('mock-png-binary') : undefined),
    }
    const picked = selectForwardPrompt([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'analyze diagram' },
          { type: 'image', path: '/workspace/test.png' },
        ],
      },
    ], context)
    expect(picked).toEqual({
      kind: 'prompt',
      text: 'analyze diagram',
      images: [
        {
          type: 'image',
          data: Buffer.from('mock-png-binary').toString('base64'),
          mimeType: 'image/png',
          uri: 'file:///workspace/test.png',
        },
      ],
      content: [
        { type: 'text', text: 'analyze diagram' },
        {
          type: 'image',
          data: Buffer.from('mock-png-binary').toString('base64'),
          mimeType: 'image/png',
          uri: 'file:///workspace/test.png',
        },
      ],
    })
  })

  it('resolves attachments from context service or map', () => {
    const context = {
      attachments: {
        'att-1': { data: 'YXR0MWJhc2U2NA==', mimeType: 'image/gif' },
      },
      getAttachment: (id: string) => (id === 'att-2' ? Buffer.from('att2-bytes') : undefined),
    }
    const picked = selectForwardPrompt([
      {
        role: 'user',
        content: [
          { type: 'image', attachmentId: 'att-1' },
          { type: 'image', attachment: { id: 'att-2' } },
        ],
      },
    ], context)
    expect(picked).toEqual({
      kind: 'prompt',
      text: '',
      images: [
        { type: 'image', data: 'YXR0MWJhc2U2NA==', mimeType: 'image/gif', uri: 'attachment://att-1' },
        { type: 'image', data: Buffer.from('att2-bytes').toString('base64'), mimeType: 'image/png', uri: 'attachment://att-2' },
      ],
      content: [
        { type: 'image', data: 'YXR0MWJhc2U2NA==', mimeType: 'image/gif', uri: 'attachment://att-1' },
        { type: 'image', data: Buffer.from('att2-bytes').toString('base64'), mimeType: 'image/png', uri: 'attachment://att-2' },
      ],
    })
  })

  it('preserves interleaved order of text and image content blocks', () => {
    const picked = selectForwardPrompt([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'step 1' },
          { type: 'image', data: 'aW1nMQ==', mimeType: 'image/png' },
          { type: 'text', text: 'step 2' },
          { type: 'image', data: 'aW1nMg==', mimeType: 'image/jpeg' },
        ],
      },
    ])
    expect(picked).toEqual({
      kind: 'prompt',
      text: 'step 1\nstep 2',
      images: [
        { type: 'image', data: 'aW1nMQ==', mimeType: 'image/png' },
        { type: 'image', data: 'aW1nMg==', mimeType: 'image/jpeg' },
      ],
      content: [
        { type: 'text', text: 'step 1' },
        { type: 'image', data: 'aW1nMQ==', mimeType: 'image/png' },
        { type: 'text', text: 'step 2' },
        { type: 'image', data: 'aW1nMg==', mimeType: 'image/jpeg' },
      ],
    })
  })

  it('validates local file paths complying with Rule 24 and cross-platform paths', () => {
    expect(isLocalFilePath('/absolute/posix/path.png')).toBe(true)
    expect(isLocalFilePath('C:\\Windows\\test.png')).toBe(true)
    expect(isLocalFilePath('D:/workspace/test.png')).toBe(true)
    expect(isLocalFilePath('\\\\server\\share\\img.png')).toBe(true)
    expect(isLocalFilePath('//server/share/img.png')).toBe(true)
    expect(isLocalFilePath('./relative.png')).toBe(true)
    expect(isLocalFilePath('../parent.png')).toBe(true)
    expect(isLocalFilePath('..\\parent.png')).toBe(true)
    expect(isLocalFilePath('\\\\?\\C:\\device')).toBe(false)
    expect(isLocalFilePath('not-a-path')).toBe(false)
    expect(isLocalFilePath('')).toBe(false)
  })

  it('normalizes file URLs to absolute paths on POSIX and Windows', () => {
    expect(normalizeFileUrlToPath('file:///workspace/test.png')).toBe('/workspace/test.png')
    expect(normalizeFileUrlToPath('file://localhost/workspace/test.png')).toBe('/workspace/test.png')
    expect(normalizeFileUrlToPath('file:///C:/workspace/test.png')).toBe('C:/workspace/test.png')
    expect(normalizeFileUrlToPath('file://localhost/C:/workspace/test.png')).toBe('C:/workspace/test.png')
    expect(normalizeFileUrlToPath('file://C:/workspace/test.png')).toBe('C:/workspace/test.png')
    expect(normalizeFileUrlToPath('file:///C:/My%20Documents/test%201.png')).toBe('C:/My Documents/test 1.png')
    expect(normalizeFileUrlToPath('file:///workspace/%E6%B5%8B%E8%AF%95.png')).toBe('/workspace/测试.png')
    expect(normalizeFileUrlToPath('file://server/share/test.png')).toBe('//server/share/test.png')
    expect(normalizeFileUrlToPath('file://server/share/My%20Photo.png')).toBe('//server/share/My Photo.png')
    expect(normalizeFileUrlToPath('/plain/path.png')).toBe('/plain/path.png')
  })

  it('parses OpenAI style image_url blocks and raw base64 image strings', () => {
    const picked = selectForwardPrompt([
      {
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: 'data:image/png;base64,b3BlbmFpaW1n' } },
          { type: 'image', image: 'cmF3YmFzZTY0' },
        ],
      },
    ])
    expect(picked).toEqual({
      kind: 'prompt',
      text: '',
      images: [
        { type: 'image', data: 'b3BlbmFpaW1n', mimeType: 'image/png', uri: 'data:image/png;base64,b3BlbmFpaW1n' },
        { type: 'image', data: 'cmF3YmFzZTY0', mimeType: 'image/png' },
      ],
      content: [
        { type: 'image', data: 'b3BlbmFpaW1n', mimeType: 'image/png', uri: 'data:image/png;base64,b3BlbmFpaW1n' },
        { type: 'image', data: 'cmF3YmFzZTY0', mimeType: 'image/png' },
      ],
    })
  })

  it('handles Buffer and Uint8Array image inputs', () => {
    const picked = selectForwardPrompt([
      {
        role: 'user',
        content: [
          { type: 'image', data: Buffer.from('buffer-data'), mimeType: 'image/jpeg' },
          { type: 'image', buffer: Buffer.from('buffer-prop'), mimeType: 'image/png' },
          { type: 'image', content: new Uint8Array([1, 2, 3]) },
        ],
      },
    ])
    expect(picked).toEqual({
      kind: 'prompt',
      text: '',
      images: [
        { type: 'image', data: Buffer.from('buffer-data').toString('base64'), mimeType: 'image/jpeg' },
        { type: 'image', data: Buffer.from('buffer-prop').toString('base64'), mimeType: 'image/png' },
        { type: 'image', data: Buffer.from([1, 2, 3]).toString('base64'), mimeType: 'image/png' },
      ],
      content: [
        { type: 'image', data: Buffer.from('buffer-data').toString('base64'), mimeType: 'image/jpeg' },
        { type: 'image', data: Buffer.from('buffer-prop').toString('base64'), mimeType: 'image/png' },
        { type: 'image', data: Buffer.from([1, 2, 3]).toString('base64'), mimeType: 'image/png' },
      ],
    })
  })

  it('converts non-base64 data URL to base64 encoding', () => {
    const picked = selectForwardPrompt([
      {
        role: 'user',
        content: [
          { type: 'image', url: 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg"/>' },
        ],
      },
    ])
    expect(picked).toEqual({
      kind: 'prompt',
      text: '',
      images: [
        {
          type: 'image',
          data: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>').toString('base64'),
          mimeType: 'image/svg+xml',
          uri: 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg"/>',
        },
      ],
      content: [
        {
          type: 'image',
          data: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>').toString('base64'),
          mimeType: 'image/svg+xml',
          uri: 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg"/>',
        },
      ],
    })
  })

  it('strips Data URL header and parses MIME in attachment objects', () => {
    const picked = selectForwardPrompt([
      {
        role: 'user',
        content: [
          { type: 'image', attachment: { data: 'data:image/webp;base64,d2VicGRhdGE=' } },
        ],
      },
    ])
    expect(picked).toEqual({
      kind: 'prompt',
      text: '',
      images: [
        { type: 'image', data: 'd2VicGRhdGE=', mimeType: 'image/webp' },
      ],
      content: [
        { type: 'image', data: 'd2VicGRhdGE=', mimeType: 'image/webp' },
      ],
    })
  })

  it('resolves attachment pointing to a local file path', () => {
    const context = {
      readFile: (p: string) => (p === '/cache/att.png' ? Buffer.from('png-bytes') : undefined),
      attachments: {
        'att-path-1': '/cache/att.png',
        'att-path-2': { path: '/cache/att.png' },
      },
    }
    const picked = selectForwardPrompt([
      {
        role: 'user',
        content: [
          { type: 'image', attachmentId: 'att-path-1' },
          { type: 'image', attachmentId: 'att-path-2' },
        ],
      },
    ], context)
    expect(picked).toEqual({
      kind: 'prompt',
      text: '',
      images: [
        { type: 'image', data: Buffer.from('png-bytes').toString('base64'), mimeType: 'image/png', uri: 'attachment://att-path-1' },
        { type: 'image', data: Buffer.from('png-bytes').toString('base64'), mimeType: 'image/png', uri: 'attachment://att-path-2' },
      ],
      content: [
        { type: 'image', data: Buffer.from('png-bytes').toString('base64'), mimeType: 'image/png', uri: 'attachment://att-path-1' },
        { type: 'image', data: Buffer.from('png-bytes').toString('base64'), mimeType: 'image/png', uri: 'attachment://att-path-2' },
      ],
    })
  })

  it('preserves caller mimeType on attachment blocks over guessed fallback', () => {
    const context = {
      attachments: {
        'uuid-123': 'YXR0Ynl0ZXM=',
      },
    }
    const picked = selectForwardPrompt([
      {
        role: 'user',
        content: [
          { type: 'image', attachmentId: 'uuid-123', mimeType: 'image/webp' },
        ],
      },
    ], context)
    expect(picked).toEqual({
      kind: 'prompt',
      text: '',
      images: [
        { type: 'image', data: 'YXR0Ynl0ZXM=', mimeType: 'image/webp', uri: 'attachment://uuid-123' },
      ],
      content: [
        { type: 'image', data: 'YXR0Ynl0ZXM=', mimeType: 'image/webp', uri: 'attachment://uuid-123' },
      ],
    })
  })

  it('supports message.parts structure and type attachment with image mimeType', () => {
    const picked = selectForwardPrompt([
      {
        role: 'user',
        parts: [
          { type: 'text', text: 'question' },
          { type: 'attachment', mimeType: 'image/png', data: 'aW1n' },
        ],
      } as never,
    ])
    expect(picked).toEqual({
      kind: 'prompt',
      text: 'question',
      images: [
        { type: 'image', data: 'aW1n', mimeType: 'image/png' },
      ],
      content: [
        { type: 'text', text: 'question' },
        { type: 'image', data: 'aW1n', mimeType: 'image/png' },
      ],
    })
  })

  it('handles string content safely without throwing TypeError', () => {
    const picked = selectForwardPrompt([
      {
        role: 'user',
        content: 'plain string content' as never,
      },
    ])
    expect(picked).toEqual({
      kind: 'prompt',
      text: 'plain string content',
    })
  })

  it('extracts image from type file with recognized image extension', () => {
    const context = {
      readFile: (p: string) => (p === '/work/screenshot.png' ? Buffer.from('img-bytes') : undefined),
    }
    const picked = selectForwardPrompt([
      {
        role: 'user',
        content: [
          { type: 'file', path: '/work/screenshot.png' },
        ],
      },
    ], context)
    expect(picked).toEqual({
      kind: 'prompt',
      text: '',
      images: [
        { type: 'image', data: Buffer.from('img-bytes').toString('base64'), mimeType: 'image/png', uri: 'file:///work/screenshot.png' },
      ],
      content: [
        { type: 'image', data: Buffer.from('img-bytes').toString('base64'), mimeType: 'image/png', uri: 'file:///work/screenshot.png' },
      ],
    })
  })

  it('extracts image from type attachment with nested attachment object', () => {
    const picked = selectForwardPrompt([
      {
        role: 'user',
        content: [
          { type: 'attachment', attachment: { id: 'a1', mimeType: 'image/png', data: 'dGVzdA==' } },
        ],
      },
    ])
    expect(picked).toEqual({
      kind: 'prompt',
      text: '',
      images: [
        { type: 'image', data: 'dGVzdA==', mimeType: 'image/png' },
      ],
      content: [
        { type: 'image', data: 'dGVzdA==', mimeType: 'image/png' },
      ],
    })
  })

  it('extracts image from type attachment with attachmentId via context lookup', () => {
    const context = {
      attachments: {
        'att-ctx': { data: 'YXR0Y29udGV4dA==', mimeType: 'image/webp' },
      },
    }
    const picked = selectForwardPrompt([
      {
        role: 'user',
        content: [
          { type: 'attachment', attachmentId: 'att-ctx' },
        ],
      },
    ], context)
    expect(picked).toEqual({
      kind: 'prompt',
      text: '',
      images: [
        { type: 'image', data: 'YXR0Y29udGV4dA==', mimeType: 'image/webp', uri: 'attachment://att-ctx' },
      ],
      content: [
        { type: 'image', data: 'YXR0Y29udGV4dA==', mimeType: 'image/webp', uri: 'attachment://att-ctx' },
      ],
    })
  })

  it('does not treat non-image files or non-image data URLs as images', () => {
    const context = {
      readFile: (p: string) => (p === '/work/notes.txt' ? 'hello plain text' : undefined),
    }
    const picked = selectForwardPrompt([
      {
        role: 'user',
        content: [
          { type: 'file', path: '/work/notes.txt' },
          { type: 'image', data: 'data:application/pdf;base64,JVBERi0xLjQK' },
        ],
      },
    ], context)
    expect(picked).toEqual({ kind: 'no-user-input' })
  })

  it('supports remote HTTP/HTTPS image URLs by retaining uri', () => {
    const picked = selectForwardPrompt([
      {
        role: 'user',
        content: [
          { type: 'image', url: 'https://example.com/cat.png' },
          { type: 'image_url', image_url: { url: 'http://example.com/dog.jpg' } },
        ],
      },
    ])
    expect(picked).toEqual({
      kind: 'prompt',
      text: '',
      images: [
        { type: 'image', data: '', mimeType: 'image/png', uri: 'https://example.com/cat.png' },
        { type: 'image', data: '', mimeType: 'image/jpeg', uri: 'http://example.com/dog.jpg' },
      ],
      content: [
        { type: 'image', data: '', mimeType: 'image/png', uri: 'https://example.com/cat.png' },
        { type: 'image', data: '', mimeType: 'image/jpeg', uri: 'http://example.com/dog.jpg' },
      ],
    })
  })

  it('supports single-object message content', () => {
    const picked = selectForwardPrompt([
      {
        role: 'user',
        content: { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' },
      },
    ])
    expect(picked).toEqual({
      kind: 'prompt',
      text: '',
      images: [
        { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' },
      ],
      content: [
        { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' },
      ],
    })
  })

  it('resolves real DSH attachment structure using store imageHostPath and maps mediaType to mimeType', () => {
    const rawImageBytes = Buffer.from('png-host-content')
    const context = {
      imageHostPath: (ref: unknown) => {
        if (typeof ref === 'string' && ref.includes('1f4e8f2d9e96479ec762b46f8d6b946bed452bba976ca1092abd773bd0fb3796')) {
          return '/dsh/cache/1f4e8f.png'
        }
        return undefined
      },
      readFile: (p: string) => (p === '/dsh/cache/1f4e8f.png' ? rawImageBytes : undefined),
    }

    const picked = selectForwardPrompt([
      {
        role: 'user',
        content: [
          {
            type: 'image',
            attachment: {
              attachmentId: 'sha256:1f4e8f2d9e96479ec762b46f8d6b946bed452bba976ca1092abd773bd0fb3796',
              mediaType: 'image/png',
              width: 128,
              height: 92,
              bytes: 2216,
              name: 'image.png',
            },
          },
        ],
      },
    ], context)

    expect(picked).toEqual({
      kind: 'prompt',
      text: '',
      images: [
        {
          type: 'image',
          data: rawImageBytes.toString('base64'),
          mimeType: 'image/png',
          uri: 'attachment://sha256:1f4e8f2d9e96479ec762b46f8d6b946bed452bba976ca1092abd773bd0fb3796',
        },
      ],
      content: [
        {
          type: 'image',
          data: rawImageBytes.toString('base64'),
          mimeType: 'image/png',
          uri: 'attachment://sha256:1f4e8f2d9e96479ec762b46f8d6b946bed452bba976ca1092abd773bd0fb3796',
        },
      ],
    })
  })

  it('resolves DSH attachment using store readImage returning Uint8Array synchronously', () => {
    const rawBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    const context = {
      readImage: (ref: unknown) => {
        return { ref, data: rawBytes }
      },
    }

    const picked = selectForwardPrompt([
      {
        role: 'user',
        content: [
          {
            type: 'image',
            attachment: {
              attachmentId: 'sha256:abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234',
              mediaType: 'image/png',
            },
          },
        ],
      },
    ], context)

    expect(picked).toEqual({
      kind: 'prompt',
      text: '',
      images: [
        {
          type: 'image',
          data: Buffer.from(rawBytes).toString('base64'),
          mimeType: 'image/png',
          uri: 'attachment://sha256:abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234',
        },
      ],
      content: [
        {
          type: 'image',
          data: Buffer.from(rawBytes).toString('base64'),
          mimeType: 'image/png',
          uri: 'attachment://sha256:abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234',
        },
      ],
    })
  })

  it('falls back to store-free disk lookup at ~/.dsh/attachments/v1/objects/<hash[0..1]>/<hash>', () => {
    const hash = '1f4e8f2d9e96479ec762b46f8d6b946bed452bba976ca1092abd773bd0fb3796'
    const diskBytes = Buffer.from('disk-attachment-bytes')
    let queriedPath: string | undefined

    const context = {
      readFile: (p: string) => {
        queriedPath = p
        if (p.includes(`attachments/v1/objects/1f/${hash}`) || p.includes(`attachments\\v1\\objects\\1f\\${hash}`)) {
          return diskBytes
        }
        return undefined
      },
    }

    const picked = selectForwardPrompt([
      {
        role: 'user',
        content: [
          {
            type: 'image',
            attachment: {
              attachmentId: `sha256:${hash}`,
              mediaType: 'image/webp',
            },
          },
        ],
      },
    ], context)

    expect(queriedPath).toBeDefined()
    expect(picked).toEqual({
      kind: 'prompt',
      text: '',
      images: [
        {
          type: 'image',
          data: diskBytes.toString('base64'),
          mimeType: 'image/webp',
          uri: `attachment://sha256:${hash}`,
        },
      ],
      content: [
        {
          type: 'image',
          data: diskBytes.toString('base64'),
          mimeType: 'image/webp',
          uri: `attachment://sha256:${hash}`,
        },
      ],
    })
  })

  it('detects MIME type from magic numbers when mediaType and mimeType are absent', () => {
    const jpegBytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46])
    const context = {
      attachments: {
        'img-magic-jpeg': { data: jpegBytes },
      },
    }

    const picked = selectForwardPrompt([
      {
        role: 'user',
        content: [
          {
            type: 'image',
            attachment: {
              attachmentId: 'img-magic-jpeg',
            },
          },
        ],
      },
    ], context)

    expect(picked).toEqual({
      kind: 'prompt',
      text: '',
      images: [
        {
          type: 'image',
          data: jpegBytes.toString('base64'),
          mimeType: 'image/jpeg',
          uri: 'attachment://img-magic-jpeg',
        },
      ],
      content: [
        {
          type: 'image',
          data: jpegBytes.toString('base64'),
          mimeType: 'image/jpeg',
          uri: 'attachment://img-magic-jpeg',
        },
      ],
    })
  })

  it('respects attachmentId extraction precedence (b.attachment.attachmentId > b.attachmentId > b.attachment.id > b.id)', () => {
    const context = {
      attachments: {
        'id-att-field': { data: 'YXR0MQ==', mimeType: 'image/png' },
        'id-top-att': { data: 'YXR0Mg==', mimeType: 'image/png' },
        'id-nested-id': { data: 'YXR0Mw==', mimeType: 'image/png' },
        'id-top-id': { data: 'YXR0NA==', mimeType: 'image/png' },
      },
    }

    // 1. b.attachment.attachmentId wins over b.attachmentId
    const pick1 = selectForwardPrompt([
      {
        role: 'user',
        content: [
          {
            type: 'image',
            attachmentId: 'id-top-att',
            attachment: {
              attachmentId: 'id-att-field',
              id: 'id-nested-id',
            },
            id: 'id-top-id',
          },
        ],
      },
    ], context)
    expect(pick1).toMatchObject({
      images: [{ uri: 'attachment://id-att-field', data: 'YXR0MQ==' }],
    })

    // 2. b.attachmentId wins over b.attachment.id
    const pick2 = selectForwardPrompt([
      {
        role: 'user',
        content: [
          {
            type: 'image',
            attachmentId: 'id-top-att',
            attachment: {
              id: 'id-nested-id',
            },
            id: 'id-top-id',
          },
        ],
      },
    ], context)
    expect(pick2).toMatchObject({
      images: [{ uri: 'attachment://id-top-att', data: 'YXR0Mg==' }],
    })

    // 3. b.attachment.id wins over b.id
    const pick3 = selectForwardPrompt([
      {
        role: 'user',
        content: [
          {
            type: 'image',
            attachment: {
              id: 'id-nested-id',
            },
            id: 'id-top-id',
          },
        ],
      },
    ], context)
    expect(pick3).toMatchObject({
      images: [{ uri: 'attachment://id-nested-id', data: 'YXR0Mw==' }],
    })
  })

  it('extracts DSH image interleaved with text blocks in order', () => {
    const context = {
      attachments: {
        'sha256:dsh-img': { data: 'aGVsbG8=', mimeType: 'image/png' },
      },
    }
    const picked = selectForwardPrompt([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Step 1: Check this screenshot' },
          {
            type: 'image',
            attachment: {
              attachmentId: 'sha256:dsh-img',
              mediaType: 'image/png',
            },
          },
          { type: 'text', text: 'Step 2: Finish' },
        ],
      },
    ], context)

    expect(picked).toEqual({
      kind: 'prompt',
      text: 'Step 1: Check this screenshot\nStep 2: Finish',
      images: [
        { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png', uri: 'attachment://sha256:dsh-img' },
      ],
      content: [
        { type: 'text', text: 'Step 1: Check this screenshot' },
        { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png', uri: 'attachment://sha256:dsh-img' },
        { type: 'text', text: 'Step 2: Finish' },
      ],
    })
  })

  it('detects multiple image formats using detectImageMimeFromMagic or falls back to image/png', () => {
    // PNG
    expect(detectImageMimeFromMagic(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe('image/png')
    // JPEG
    expect(detectImageMimeFromMagic(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg')
    // GIF
    expect(detectImageMimeFromMagic(Buffer.from('GIF89a'))).toBe('image/gif')
    // WebP
    expect(detectImageMimeFromMagic(Buffer.from([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]))).toBe('image/webp')
    // BMP
    expect(detectImageMimeFromMagic(Buffer.from([0x42, 0x4d, 0, 0]))).toBe('image/bmp')
    // SVG text
    expect(detectImageMimeFromMagic('<svg xmlns="http://www.w3.org/2000/svg"/>')).toBe('image/svg+xml')
    // Unknown bytes
    expect(detectImageMimeFromMagic(Buffer.from([0x01, 0x02, 0x03]))).toBeUndefined()
    expect(detectImageMimeFromMagic(undefined)).toBeUndefined()
  })

  it('safely extracts attachment through LocalAttachmentStore-like class preserving this.root', () => {
    class MockLocalAttachmentStore {
      root = 'M:/mock/dsh/attachments/v1'

      imageHostPath(ref: { attachmentId?: string }) {
        if (!this || this.root !== 'M:/mock/dsh/attachments/v1') {
          throw new TypeError("Cannot read properties of undefined (reading 'root')")
        }
        const match = /^sha256:([a-f0-9]{64})$/.exec(String(ref?.attachmentId))
        if (!match) throw new Error('INVALID_ATTACHMENT_REF')
        return `${this.root}/objects/${match[1].slice(0, 2)}/${match[1]}`
      }

      async readImage(ref: { attachmentId?: string }) {
        if (!this || this.root !== 'M:/mock/dsh/attachments/v1') {
          throw new TypeError("Cannot read properties of undefined (reading 'root')")
        }
        throw new Error('ATTACHMENT_NOT_FOUND')
      }
    }

    const pngHeader = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])
    const hash = 'a'.repeat(64)
    const store = new MockLocalAttachmentStore()
    const childContext = Object.assign(Object.create(store), {
      readFile: (p: string) => {
        if (p === `M:/mock/dsh/attachments/v1/objects/aa/${hash}`) {
          return pngHeader
        }
        return undefined
      },
    })

    const picked = selectForwardPrompt([
      {
        role: 'user',
        content: [
          {
            type: 'image',
            attachment: {
              attachmentId: `sha256:${hash}`,
              mediaType: 'image/png',
            },
          },
        ],
      },
    ], childContext)

    expect(picked).toEqual({
      kind: 'prompt',
      text: '',
      images: [
        {
          type: 'image',
          data: pngHeader.toString('base64'),
          mimeType: 'image/png',
          uri: `attachment://sha256:${hash}`,
        },
      ],
      content: [
        {
          type: 'image',
          data: pngHeader.toString('base64'),
          mimeType: 'image/png',
          uri: `attachment://sha256:${hash}`,
        },
      ],
    })
  })

  it('handles async readImage rejection gracefully without unhandledRejection crash', async () => {
    let unhandledCaught = false
    const onUnhandled = () => {
      unhandledCaught = true
    }
    process.on('unhandledRejection', onUnhandled)

    try {
      class FailingStore {
        root = '/root'
        imageHostPath() {
          throw new Error('no host path')
        }
        async readImage() {
          throw new Error('async image load failed')
        }
      }

      const store = new FailingStore()
      const res = resolveImageAttachmentFromContext('sha256:' + 'b'.repeat(64), store)
      expect(res).toBeUndefined()

      await new Promise(r => setTimeout(r, 10))
      expect(unhandledCaught).toBe(false)
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })

  it('resolves attachments through ctx.get("attachments") service preserving rootContext for file reading', () => {
    const pngHeader = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    const hash = 'c'.repeat(64)
    const expectedPath = `/dsh/attachments/v1/objects/cc/${hash}`

    class StoreService {
      root = '/dsh/attachments/v1'
      imageHostPath(ref: { attachmentId?: string }) {
        if (!this || this.root !== '/dsh/attachments/v1') {
          throw new TypeError("Cannot read properties of undefined (reading 'root')")
        }
        return expectedPath
      }
    }

    const serviceInstance = new StoreService()
    const ctx = {
      get(name: string) {
        if (name === 'attachments') return serviceInstance
        return undefined
      },
      readFile(p: string) {
        if (p === expectedPath) return pngHeader
        return undefined
      },
    }

    const res = resolveImageAttachmentFromContext(`sha256:${hash}`, ctx) as { path?: string; data?: Buffer }
    expect(res).toBeDefined()
    expect(res.path).toBe(expectedPath)
    expect(res.data).toEqual(pngHeader)
  })

  it('falls back to Symbol.for("cordis.original") when proxy method invocation throws', () => {
    const pngHeader = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    const hash = 'd'.repeat(64)
    const expectedPath = `/dsh/attachments/v1/objects/dd/${hash}`

    class RealStoreInstance {
      root = '/dsh/attachments/v1'
      imageHostPath(ref: { attachmentId?: string }) {
        if (!this || this.root !== '/dsh/attachments/v1') {
          throw new TypeError("Cannot read properties of undefined (reading 'root')")
        }
        return expectedPath
      }
    }

    const realInstance = new RealStoreInstance()
    // Simulated Cordis proxy where the outer proxy throws, but cordis.original works
    const proxy = {
      imageHostPath() {
        throw new TypeError("Cannot read properties of undefined (reading 'root')")
      },
      [Symbol.for('cordis.original')]: realInstance,
    }

    const ctx = {
      get: (name: string) => (name === 'attachments' ? proxy : undefined),
      readFile: (p: string) => (p === expectedPath ? pngHeader : undefined),
    }

    const res = resolveImageAttachmentFromContext(`sha256:${hash}`, ctx) as { path?: string; data?: Buffer }
    expect(res).toBeDefined()
    expect(res.path).toBe(expectedPath)
    expect(res.data).toEqual(pngHeader)
  })

  it('safely handles context whose property getters throw "without inject" errors', () => {
    const cordisContextWithTraps = {
      get: () => undefined,
      get attachments(): never {
        throw new Error('cannot get property "attachments" without inject')
      },
      get attachmentService(): never {
        throw new Error('cannot get property "attachmentService" without inject')
      },
    }

    // Must not throw, fails open gracefully
    expect(() => resolveImageAttachmentFromContext('sha256:' + 'e'.repeat(64), cordisContextWithTraps)).not.toThrow()
    expect(resolveImageAttachmentFromContext('sha256:' + 'e'.repeat(64), cordisContextWithTraps)).toBeUndefined()
  })
})

describe('extractSessionTitlePlaceholder (host title prompt → placeholder title)', () => {
  const titlePrompt = (text: string) => [{ role: 'user', source: { kind: 'plugin', plugin: 'dsh-session-title-llm' }, content: [{ type: 'text', text }] }]

  it('takes the first human message out of the prompt\'s JSON array', () => {
    expect(extractSessionTitlePlaceholder(titlePrompt(
      'Generate the session title from this JSON array of human messages: ["给这个仓库写一份测试指南","second human line"]',
    ))).toBe('给这个仓库写一份测试指南')
    // A bracket in prose before the real array must not block the scan.
    expect(extractSessionTitlePlaceholder(titlePrompt(
      '[optional] Generate the session title from this JSON array of human messages: ["你好"]',
    ))).toBe('你好')
  })

  it('reads object elements via text / content / message and skips empties', () => {
    expect(extractSessionTitlePlaceholder(titlePrompt('prompt: [{"text":"  "},{"content":"第一个问题"}]'))).toBe('第一个问题')
    expect(extractSessionTitlePlaceholder(titlePrompt('prompt: [{"message":"first"}]'))).toBe('first')
    // Objects without a usable string field fall through; a string element still wins.
    expect(extractSessionTitlePlaceholder(titlePrompt('prompt: [{"other":1},"fallback title"]'))).toBe('fallback title')
  })

  it('collapses whitespace and truncates by code points with an ellipsis', () => {
    expect(extractSessionTitlePlaceholder(titlePrompt('["a\\n  b\\t c"]'))).toBe('a b c')
    const long = '啊'.repeat(SESSION_TITLE_PLACEHOLDER_MAX + 10)
    expect(extractSessionTitlePlaceholder(titlePrompt(`["${long}"]`)))
      .toBe('啊'.repeat(SESSION_TITLE_PLACEHOLDER_MAX) + '…')
    // The cut falls mid-run of astral chars: the pair stays intact (a naive
    // UTF-16 slice would emit a lone half surrogate here).
    const mixed = 'a'.repeat(SESSION_TITLE_PLACEHOLDER_MAX - 1) + '🙂'.repeat(10)
    expect(extractSessionTitlePlaceholder(titlePrompt(`["${mixed}"]`)))
      .toBe('a'.repeat(SESSION_TITLE_PLACEHOLDER_MAX - 1) + '🙂' + '…')
  })

  it('prepends the settings prefix inside the same total cap', () => {
    const prefixLen = Array.from(SESSION_TITLE_PREFIX).length
    // Off (the default): byte-identical to the prefixless answer, explicit or not.
    expect(extractSessionTitlePlaceholder(titlePrompt('["你好"]'))).toBe('你好')
    expect(extractSessionTitlePlaceholder(titlePrompt('["你好"]'), '')).toBe('你好')
    // On: the prefix rides the front of the same placeholder.
    expect(extractSessionTitlePlaceholder(titlePrompt('["你好"]'), SESSION_TITLE_PREFIX)).toBe(SESSION_TITLE_PREFIX + '你好')
    // A long title reserves the prefix's code points from the cap first, so
    // the full answer keeps exactly the prefixless worst-case length.
    const long = '啊'.repeat(SESSION_TITLE_PLACEHOLDER_MAX + 10)
    expect(extractSessionTitlePlaceholder(titlePrompt(`["${long}"]`), SESSION_TITLE_PREFIX))
      .toBe(SESSION_TITLE_PREFIX + '啊'.repeat(SESSION_TITLE_PLACEHOLDER_MAX - prefixLen) + '…')
    // Unparseable prompts stay undefined either way — no prefix-only answer.
    expect(extractSessionTitlePlaceholder(titlePrompt('no array here'), SESSION_TITLE_PREFIX)).toBeUndefined()
  })

  it('returns undefined for prompts without a parseable human-message array', () => {
    expect(extractSessionTitlePlaceholder(titlePrompt('Generate the session title from this JSON array of human messages: not json'))).toBeUndefined()
    expect(extractSessionTitlePlaceholder(titlePrompt('Generate the session title: []'))).toBeUndefined()
    expect(extractSessionTitlePlaceholder(titlePrompt('Generate the session title: ["   ",""]'))).toBeUndefined()
    expect(extractSessionTitlePlaceholder(titlePrompt('Generate the session title: ["unclosed bracket'))).toBeUndefined()
    expect(extractSessionTitlePlaceholder([])).toBeUndefined()
  })
})

describe('ACP tool-call notifications → tool-call stream chunks', () => {
  it('folds an announcement into a snapshot: constant name, full title preserved in args', () => {
    // The name is a fixed plugin constant, NEVER the agent's own title; the
    // title is folded into argsRaw so it is not silently dropped (constraint 29).
    expect(acpToolCallFromUpdate({ toolCallId: ' c1 ', title: 'Bash', rawInput: '{"cmd":"ls"}' }))
      .toEqual({ callId: 'c1', name: ACP_TOOL_CALL_NAME, title: 'Bash', argsRaw: 'Bash\n{"cmd":"ls"}' })
    // A long command-string title survives IN FULL when the agent disclosed no
    // separate input: the exact case the constant-name fix must not lose.
    const command = "pwsh -NoProfile -Command Get-ChildItem -Recurse | Select-String 'SECRET_PATTERN_XYZ'"
    expect(acpToolCallFromUpdate({ toolCallId: 'c1', title: command }))
      .toEqual({ callId: 'c1', name: ACP_TOOL_CALL_NAME, title: command, argsRaw: command })
    // No id is not a tool call; no title and no input are legal ACP — an
    // honest empty card, not a fabricated placeholder. The empty name is also
    // what lets the bridge skip a bare status-only update as a phantom card.
    expect(acpToolCallFromUpdate({ title: 'no id' })).toBeUndefined()
    expect(acpToolCallFromUpdate({ toolCallId: 'c2' })).toEqual({ callId: 'c2', name: '', title: '', argsRaw: '' })
  })

  it('reads only the two live statuses as "output may still arrive"', () => {
    expect(isFinalToolCallStatus('pending')).toBe(false)
    expect(isFinalToolCallStatus('in_progress')).toBe(false)
    // The announcing `tool_call` routinely carries no status at all: treating
    // that as terminal would answer a display card before the tool ran.
    expect(isFinalToolCallStatus(undefined)).toBe(false)
    expect(isFinalToolCallStatus('')).toBe(false)
    expect(isFinalToolCallStatus(3)).toBe(false)
    expect(isFinalToolCallStatus('completed')).toBe(true)
    expect(isFinalToolCallStatus('failed')).toBe(true)
    // ACP v2 adds `cancelled`, and an agent may invent its own: anything not
    // live is terminal.
    expect(isFinalToolCallStatus('cancelled')).toBe(true)
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
    // whole input: only a real prefix extension can become a delta. The title
    // stays folded into the body across the extension, so it is never dropped.
    let snapshot = acpToolCallFromUpdate({ toolCallId: 't1', title: 'first tool', rawInput: '{"cmd":"' })!
    expect(acpToolCallDelta(snapshot, { toolCallId: 't1', rawInput: '{"cmd":"ls -la"}' }))
      .toEqual([{ kind: 'args', text: 'ls -la"}' }])
    expect(snapshot.argsRaw).toBe('first tool\n{"cmd":"ls -la"}')
    // A rewrite (not an extension) has no honest delta: the snapshot moves,
    // and the closing `block-end` replaces the block wholesale.
    snapshot = acpToolCallFromUpdate({ toolCallId: 't1', rawInput: '{"cmd":""}' })!
    expect(acpToolCallDelta(snapshot, { toolCallId: 't1', rawInput: '{"cmd":"ls -la"}' })).toEqual([])
    expect(snapshot.argsRaw).toBe('{"cmd":"ls -la"}')
  })

  it('never emits a raw title as a name delta; the constant name stays and the rewritten command is preserved', () => {
    // codebuddy rewrites titles mid-call: a name delta would re-inject a long
    // command as the (host) tool name. The name is a fixed constant, so NO name
    // delta is emitted; the NEW title is preserved in argsRaw instead.
    const snapshot = acpToolCallFromUpdate({ toolCallId: 't1', title: 'pwsh -Command Get-Process' })!
    expect(snapshot.name).toBe(ACP_TOOL_CALL_NAME)
    const rewritten = 'pwsh -Command Get-Process | Where-Object { $_.CPU -gt 100 } | Format-Table -AutoSize'
    const deltas = acpToolCallDelta(snapshot, { toolCallId: 't1', title: rewritten })
    expect(deltas.every(delta => delta.kind !== 'name')).toBe(true)
    expect(snapshot.name).toBe(ACP_TOOL_CALL_NAME)
    expect(snapshot.title).toBe(rewritten)
    expect(snapshot.argsRaw).toBe(rewritten)
    // A title-less update keeps the already-preserved title (no silent drop).
    const after = acpToolCallDelta(snapshot, { toolCallId: 't1', rawInput: '{"cmd":"ls"}' })
    expect(after.every(delta => delta.kind !== 'name')).toBe(true)
    expect(snapshot.argsRaw).toContain(rewritten)
    expect(snapshot.argsRaw).toContain('{"cmd":"ls"}')
  })

  it('promotes an empty snapshot name to ACP_TOOL_CALL_NAME and emits a name delta on update with title or args or content', () => {
    // A tool call announced with only an id starts with an empty name
    // (the phantom-card guard convention). When an update supplies a title
    // or input, the name must be promoted to the constant and emit a name
    // delta so the host knows the card's tool name.
    const snapshot = acpToolCallFromUpdate({ toolCallId: 'c2' })!
    expect(snapshot.name).toBe('')
    const deltas = acpToolCallDelta(snapshot, { toolCallId: 'c2', title: 'Bash', rawInput: 'ls' })
    expect(snapshot.name).toBe(ACP_TOOL_CALL_NAME)
    expect(deltas).toContainEqual({ kind: 'name', name: ACP_TOOL_CALL_NAME })
    expect(deltas).toContainEqual({ kind: 'args', text: 'Bash\nls' })

    // Subsequent updates do NOT re-emit the name delta
    const after = acpToolCallDelta(snapshot, { toolCallId: 'c2', rawInput: 'ls -la' })
    expect(after.every(d => d.kind !== 'name')).toBe(true)

    // A call that starts empty and gets content also promotes its name
    const contentSnap = acpToolCallFromUpdate({ toolCallId: 'c3' })!
    expect(contentSnap.name).toBe('')
    const contentDeltas = acpToolCallDelta(contentSnap, {
      toolCallId: 'c3',
      content: [{ type: 'content', content: { type: 'text', text: 'output' } }],
    })
    expect(contentSnap.name).toBe(ACP_TOOL_CALL_NAME)
    expect(contentDeltas).toContainEqual({ kind: 'name', name: ACP_TOOL_CALL_NAME })
    expect(contentDeltas).toContainEqual({ kind: 'args', text: 'output' })
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

  it('coalesces a run of usage ticks into one replayable entry', () => {
    const t = new Transcript(600)
    let seq = 0
    for (let used = 1; used <= 10; used++) {
      seq = t.append({ sessionUpdate: 'usage_update', used, size: 1000 })
    }
    const entries = t.since(0)
    expect(entries).toHaveLength(1)
    expect(entries[0]?.seq).toBe(seq)
    expect(entries[0]?.seq).toBe(10)
    expect(entries[0]?.update).toEqual({ sessionUpdate: 'usage_update', used: 10, size: 1000 })
    expect(t.head).toBe(10)
    expect(t.since(seq)).toEqual([])
  })

  it('keeps every content entry and only collapses each consecutive state run', () => {
    const t = new Transcript(600)
    t.append({ sessionUpdate: 'usage_update', used: 1, size: 100 })
    t.append({ sessionUpdate: 'tool_call', toolCallId: 'c1', title: 'run', status: 'pending' })
    t.append({ sessionUpdate: 'usage_update', used: 2, size: 100 })
    t.append({ sessionUpdate: 'usage_update', used: 3, size: 100 })
    t.append({ sessionUpdate: 'agent_message_chunk', messageId: 'm1', content: { type: 'text', text: 'hi' } })
    t.append({ sessionUpdate: 'usage_update', used: 4, size: 100 })
    const entries = t.since(0)
    expect(entries.map(e => (e.update as { sessionUpdate: string }).sessionUpdate)).toEqual([
      'usage_update', 'tool_call', 'usage_update', 'agent_message_chunk', 'usage_update',
    ])
    // The merged tick kept the seq of the LAST frame of its run, so replayed
    // seqs have holes but are monotone.
    expect(entries.map(e => e.seq)).toEqual([1, 2, 4, 5, 6])
    expect((entries[2]?.update as { used: number }).used).toBe(3)
    expect(entries.filter(e => (e.update as { sessionUpdate: string }).sessionUpdate !== 'usage_update')).toHaveLength(2)
    // A watermark at the last content seq still replays the latest state tick.
    expect(t.since(5)).toEqual([{ seq: 6, update: { sessionUpdate: 'usage_update', used: 4, size: 100 } }])
  })

  it('never merges a titled session_info_update, but does merge the phase ticks after it', () => {
    const t = new Transcript(600)
    const titled = { sessionUpdate: 'session_info_update', title: 'Fix the login bug' }
    t.append(titled)
    t.append({ sessionUpdate: 'session_info_update', _meta: { phase: 'thinking' } })
    t.append({ sessionUpdate: 'session_info_update', _meta: { phase: 'writing' } })
    const entries = t.since(0)
    expect(entries).toHaveLength(2)
    expect(entries[0]?.update).toEqual(titled)
    expect(entries[1]?.seq).toBe(3)
    expect((entries[1]?.update as { _meta?: unknown })._meta).toEqual({ phase: 'writing' })
    // A missing title qualifies as a tick too; an empty one as well.
    const u = new Transcript(600)
    u.append({ sessionUpdate: 'session_info_update', _meta: { phase: 'a' } })
    u.append({ sessionUpdate: 'session_info_update', title: '', _meta: { phase: 'b' } })
    expect(u.since(0)).toHaveLength(1)
    expect((u.since(0)[0]?.update as { _meta?: unknown })._meta).toEqual({ phase: 'b' })
  })

  it('coalesces consecutive config_option_update frames, keeping the latest options', () => {
    const t = new Transcript(600)
    t.append({ sessionUpdate: 'config_option_update', configOptions: [{ configId: 'model', currentValue: 'a' }] })
    t.append({ sessionUpdate: 'config_option_update', configOptions: [{ configId: 'model', currentValue: 'b' }] })
    const entries = t.since(0)
    expect(entries).toHaveLength(1)
    expect(entries[0]?.seq).toBe(2)
    expect(entries[0]?.update).toEqual({
      sessionUpdate: 'config_option_update',
      configOptions: [{ configId: 'model', currentValue: 'b' }],
    })
  })

  it('leaves plan, command lists, mode changes and stream chunks unmerged', () => {
    const t = new Transcript(600)
    const updates = [
      { sessionUpdate: 'plan', entries: [] },
      { sessionUpdate: 'available_commands_update', availableCommands: [] },
      { sessionUpdate: 'current_mode_update', currentModeId: 'm' },
      { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'a' } },
      { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'b' } },
    ]
    for (const update of updates) t.append(update)
    expect(t.since(0)).toHaveLength(updates.length)
    expect(t.since(0).map(e => e.seq)).toEqual([1, 2, 3, 4, 5])
  })

  it('does not let a different state kind extend the previous tick', () => {
    const t = new Transcript(600)
    t.append({ sessionUpdate: 'usage_update', used: 1, size: 10 })
    t.append({ sessionUpdate: 'config_option_update', configOptions: [] })
    t.append({ sessionUpdate: 'usage_update', used: 2, size: 10 })
    expect(t.since(0).map(e => (e.update as { sessionUpdate: string }).sessionUpdate)).toEqual([
      'usage_update', 'config_option_update', 'usage_update',
    ])
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

  it('answers hasPendingFor per session and forgets an ask once it is settled', () => {
    // The inactivity watchdog asks this question before firing: an ask waiting
    // for the human is NOT the agent being stuck (`wait` has no deadline at
    // all, so a stalled-looking turn can legitimately sit here forever).
    const ledger = new PermissionLedger()
    const answered: unknown[] = []
    const first = ledger.create('s1', outcome => { answered.push(outcome) })
    const other = ledger.create('s2', () => {})

    expect(ledger.hasPendingFor('s1')).toBe(true)
    expect(ledger.hasPendingFor('s2')).toBe(true)
    expect(ledger.hasPendingFor('s3')).toBe(false)
    // The key is the HOST session id (`LiveSession.sessionId`), not the ACP
    // protocol session id, and it is matched exactly: no prefix matching.
    expect(ledger.hasPendingFor('s')).toBe(false)

    ledger.respond(first, { outcome: 'cancelled' })
    expect(answered).toEqual([{ outcome: 'cancelled' }])
    expect(ledger.hasPendingFor('s1')).toBe(false)
    expect(ledger.hasPendingFor('s2')).toBe(true)

    ledger.settleFor(entry => entry.sessionId === 's2')
    expect(ledger.hasPendingFor('s2')).toBe(false)
    void other
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
    sessionTitlePrefix: () => true,
    setSessionTitlePrefix: async value => { calls.push(['setSessionTitlePrefix', value]) },
    approvalDeadlines: () => ({ permissionTimeoutMs: 300_000, mode: 'abort' as const }),
    setApprovalDeadlines: async (patch, reset) => { calls.push(['setApprovalDeadlines', patch, reset]) },
    idleRelease: () => ({ idleTimeoutMs: 1_800_000, defaultIdleTimeoutMs: 1_800_000 }),
    setIdleRelease: async (idleTimeoutMs, reset) => { calls.push(['setIdleRelease', idleTimeoutMs, reset]) },
    bindChatAgent: (dshSessionId, agentId) => { calls.push(['bindChatAgent', dshSessionId, agentId]) },
    setChatSessionModel: async (dshSessionId, modelId) => { calls.push(['setChatSessionModel', dshSessionId, modelId]) },
    setChatSessionEffort: async (dshSessionId, effort) => { calls.push(['setChatSessionEffort', dshSessionId, effort]) },
    resumeChatSession: async dshSessionId => { calls.push(['resumeChatSession', dshSessionId]) },
    adoptForkedSession: async (childDshSessionId, parentDshSessionId) => {
      calls.push(['adoptForkedSession', { childDshSessionId, parentDshSessionId }])
      return { sessionId: 'S-child', acpSessionId: 'acp-child' }
    },
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
    // The released banner's explicit resume, addressed by the chat session id
    // like every other conversation surface.
    await expect(dispatchRpc(manager, 'session/chat-resume', { dshSessionId: 'chat-1' })).resolves.toEqual({ ok: true, value: { done: true } })
    expect(manager.calls).toContainEqual(['resumeChatSession', 'chat-1'])
    await expect(dispatchRpc(manager, 'session/chat-resume', {})).resolves.toMatchObject({ ok: false, error: { code: 'bad_payload' } })
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
    // Version badge source: present on this half, silent (not failing) on a
    // manager that predates the endpoint.
    await expect(dispatchRpc({ ...manager, pluginVersion: () => '1.2.3' }, 'plugin/version', {}))
      .resolves.toEqual({ ok: true, value: { version: '1.2.3' } })
    await expect(dispatchRpc({ ...manager, pluginVersion: undefined }, 'plugin/version', {}))
      .resolves.toEqual({ ok: true, value: { version: undefined } })
    // Save gate: status/flush/wait-idle route to the manager; an older half
    // answers the idle status (or `unsupported` for the gestures) instead of
    // failing the browser.
    const gateStatus = {
      gateAvailable: true,
      canSave: false,
      activeTurns: 1,
      activeSessions: [{ sessionId: 'S', agentId: 'demo' }],
      pending: [{ id: 'save-1', label: 'settings:llm-pi-ai', queuedAt: 1, deadlineAt: 2 }],
      timeoutMs: 600_000,
    }
    const withGate = {
      ...manager,
      saveGateStatus: () => gateStatus,
      saveGateFlush: async () => ({ saved: 1, expired: 0, failed: 0 }),
      saveGateWaitIdle: async (timeoutMs?: number) => {
        manager.calls.push(['waitIdle', timeoutMs])
        return true
      },
    }
    await expect(dispatchRpc(withGate, 'save/status', {})).resolves.toEqual({ ok: true, value: { status: gateStatus } })
    await expect(dispatchRpc(manager, 'save/status', {})).resolves.toMatchObject({
      ok: true,
      // The fallback snapshot is NOT gate-backed: the browser must be able to
      // tell it cannot queue / force anything on this host half.
      value: { status: { gateAvailable: false, canSave: true, activeTurns: 0, pending: [] } },
    })
    await expect(dispatchRpc(withGate, 'save/flush', {})).resolves.toEqual({
      ok: true,
      value: { saved: 1, expired: 0, failed: 0 },
    })
    await expect(dispatchRpc(manager, 'save/flush', {})).resolves.toMatchObject({ ok: false, error: { code: 'unsupported' } })
    const withCancel = {
      ...manager,
      saveGateCancel: (label: string) => {
        manager.calls.push(['saveCancel', label])
        return 2
      },
    }
    await expect(dispatchRpc(withCancel, 'save/cancel', { label: 'agent-save:pi' }))
      .resolves.toEqual({ ok: true, value: { cancelled: 2 } })
    expect(manager.calls).toContainEqual(['saveCancel', 'agent-save:pi'])
    await expect(dispatchRpc(manager, 'save/cancel', { label: 'agent-save:pi' }))
      .resolves.toMatchObject({ ok: false, error: { code: 'unsupported' } })
    const withRetry = {
      ...manager,
      saveGateRetry: (label: string) => {
        manager.calls.push(['saveRetry', label])
        return true
      },
    }
    await expect(dispatchRpc(withRetry, 'save/retry', { label: 'agent-save:pi' }))
      .resolves.toEqual({ ok: true, value: { retried: true } })
    expect(manager.calls).toContainEqual(['saveRetry', 'agent-save:pi'])
    await expect(dispatchRpc(manager, 'save/retry', { label: 'agent-save:pi' }))
      .resolves.toMatchObject({ ok: false, error: { code: 'unsupported' } })
    await expect(dispatchRpc(withGate, 'save/wait-idle', { timeoutMs: 50 })).resolves.toEqual({ ok: true, value: { idle: true } })
    expect(manager.calls).toContainEqual(['waitIdle', 50])
    await expect(dispatchRpc(withGate, 'save/wait-idle', { timeoutMs: -1 })).resolves.toMatchObject({ ok: false, error: { code: 'bad_payload' } })
    await expect(dispatchRpc(manager, 'save/wait-idle', {})).resolves.toMatchObject({ ok: false, error: { code: 'unsupported' } })
    // Built-in update: check/apply delegate to the manager; an older host half
    // answers `unsupported` instead of failing, and a malformed version never
    // reaches the manager.
    const withUpdate = {
      ...manager,
      pluginUpdateCheck: async () => {
        manager.calls.push(['updateCheck', undefined])
        return { status: 'current' as const, current: '1.2.3' }
      },
      pluginUpdateApply: async (version: string) => {
        manager.calls.push(['updateApply', version])
        return { status: 'applied' as const, current: '1.2.3', installed: version }
      },
      pluginReleaseNotes: async (version: string, refresh?: boolean) => {
        manager.calls.push(['releaseNotes', version, refresh])
        return { version, url: `https://example.test/releases/tag/v${version}`, source: 'github' as const, body: 'notes' }
      },
    }
    await expect(dispatchRpc(withUpdate, 'plugin/update-check', {}))
      .resolves.toEqual({ ok: true, value: { status: 'current', current: '1.2.3' } })
    expect(manager.calls).toContainEqual(['updateCheck', undefined])
    await expect(dispatchRpc(withUpdate, 'plugin/update-apply', { version: '1.3.0' }))
      .resolves.toEqual({ ok: true, value: { status: 'applied', current: '1.2.3', installed: '1.3.0' } })
    expect(manager.calls).toContainEqual(['updateApply', '1.3.0'])
    await expect(dispatchRpc(withUpdate, 'plugin/update-apply', { version: '1.3' }))
      .resolves.toMatchObject({ ok: false, error: { code: 'bad_payload' } })
    // Release notes are a read: the same version syntax, nothing installed.
    await expect(dispatchRpc(withUpdate, 'plugin/release-notes', { version: '1.3.0' }))
      .resolves.toEqual({
        ok: true,
        value: { version: '1.3.0', url: 'https://example.test/releases/tag/v1.3.0', source: 'github', body: 'notes' },
      })
    expect(manager.calls).toContainEqual(['releaseNotes', '1.3.0', undefined])
    // The card's retry must reach the network: `refresh` passes straight through.
    await expect(dispatchRpc(withUpdate, 'plugin/release-notes', { version: '1.3.0', refresh: true }))
      .resolves.toMatchObject({ ok: true, value: { version: '1.3.0', source: 'github' } })
    expect(manager.calls).toContainEqual(['releaseNotes', '1.3.0', true])
    await expect(dispatchRpc(withUpdate, 'plugin/release-notes', { version: '1.3.0', refresh: 'yes' }))
      .resolves.toMatchObject({ ok: false, error: { code: 'bad_payload' } })
    await expect(dispatchRpc(withUpdate, 'plugin/release-notes', { version: '1.3' }))
      .resolves.toMatchObject({ ok: false, error: { code: 'bad_payload' } })
    await expect(dispatchRpc(manager, 'plugin/update-check', {}))
      .resolves.toEqual({ ok: true, value: { status: 'unsupported', current: '' } })
    await expect(dispatchRpc(manager, 'plugin/update-apply', { version: '1.3.0' }))
      .resolves.toEqual({ ok: true, value: { status: 'unsupported', current: '' } })
    // An older host half still answers a link it can derive without a network.
    await expect(dispatchRpc(manager, 'plugin/release-notes', { version: '1.3.0' }))
      .resolves.toEqual({
        ok: true,
        value: {
          version: '1.3.0',
          url: 'https://github.com/GDWhisper/dsh-ntr/releases/tag/v1.3.0',
          source: 'none',
        },
      })
    await expect(dispatchRpc(manager, 'agent/save', { id: 'pi', command: 'pi-acp' })).resolves.toEqual({ ok: true, value: { done: true } })
    expect(manager.calls).toContainEqual(['save', expect.objectContaining({ id: 'pi', command: 'pi-acp' })])
    const withSaveMode = {
      ...manager,
      saveAgent: async (def: AcpAgentDef, mode?: 'direct' | 'defer' | 'force') => {
        manager.calls.push(['saveMode', def.id, mode])
        return mode === 'defer' ? { done: true, deferred: true } : { done: true }
      },
    }
    await expect(dispatchRpc(withSaveMode, 'agent/save', { id: 'pi', command: 'pi-acp', saveMode: 'defer' }))
      .resolves.toEqual({ ok: true, value: { done: true, deferred: true } })
    expect(manager.calls).toContainEqual(['saveMode', 'pi', 'defer'])
    await expect(dispatchRpc(manager, 'agent/save', { id: 'pi', command: 'pi-acp', saveMode: 'bogus' }))
      .resolves.toMatchObject({ ok: false, error: { code: 'bad_payload' } })
    // A legacy caller that sends no gesture must NOT receive `ok` when the host
    // refused the save: the explicit failure signal is the whole point.
    const busyManager = {
      ...manager,
      saveAgent: async (busyDef: AcpAgentDef, mode?: 'direct' | 'defer' | 'force') => {
        manager.calls.push(['busySave', busyDef.id, mode])
        return {
          done: false,
          confirmationRequired: true,
          activeSessions: [{ sessionId: 'S', agentId: busyDef.id }],
        }
      },
    }
    await expect(dispatchRpc(busyManager, 'agent/save', { id: 'pi', command: 'pi-acp' }))
      .resolves.toMatchObject({ ok: false, error: { code: 'confirmation_required' } })
    expect(manager.calls).toContainEqual(['busySave', 'pi', undefined])
    // The new panel always sends a mode, so its answer shape is unchanged.
    await expect(dispatchRpc(busyManager, 'agent/save', { id: 'pi', command: 'pi-acp', saveMode: 'direct' }))
      .resolves.toEqual({
        ok: true,
        value: {
          done: false,
          confirmationRequired: true,
          activeSessions: [{ sessionId: 'S', agentId: 'pi' }],
        },
      })
    const noSave = { ...manager, saveAgent: undefined }
    await expect(dispatchRpc(noSave, 'agent/save', { id: 'pi', command: 'pi-acp' }))
      .resolves.toMatchObject({ ok: false, error: { code: 'unsupported' } })
    expect(agentSaveAction([], 'direct')).toBe('save')
    expect(agentSaveAction([{ sessionId: 'S', agentId: 'pi' }], 'direct')).toBe('confirm')
    expect(agentSaveAction([{ sessionId: 'S', agentId: 'pi' }], 'defer')).toBe('defer')
    expect(agentSaveAction([{ sessionId: 'S', agentId: 'pi' }], 'force')).toBe('save')
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
    await expect(dispatchRpc(manager, 'session/prompt', { sessionId: 'S', prompt: [] })).resolves.toMatchObject({ ok: false, error: { code: 'bad_payload' } })
    await expect(dispatchRpc(manager, 'session/prompt', { sessionId: 'S', prompt: [{ type: 'unknown' }] })).resolves.toMatchObject({ ok: false, error: { code: 'bad_payload' } })
    await expect(dispatchRpc(manager, 'session/prompt', { sessionId: 'S', prompt: [{ type: 'image', data: 'abc' }] })).resolves.toMatchObject({ ok: false, error: { code: 'bad_payload' } })
    await expect(dispatchRpc(manager, 'session/prompt', { sessionId: 'S', prompt: [{ type: 'image', data: 'abc', mimeType: 'text/plain' }] })).resolves.toMatchObject({ ok: false, error: { code: 'bad_payload' } })
    await expect(dispatchRpc(manager, 'session/prompt', { sessionId: 'S', prompt: [{ type: 'image', data: 'abc', mimeType: 'image/png', uri: 123 }] })).resolves.toMatchObject({ ok: false, error: { code: 'bad_payload' } })
    await expect(dispatchRpc(manager, 'session/prompt', { sessionId: 'S', prompt: [{ type: 'text', text: 'hi' }, { type: 'image', data: 'abc', mimeType: 'image/png' }] })).resolves.toMatchObject({ ok: true, value: { accepted: true, turnId: 'T' } })
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
    // The session-title prefix toggle: read falls back to the default (on) on
    // an older host half; only a boolean passes the write gate.
    await expect(dispatchRpc(manager, 'ui/session-title-prefix', {})).resolves.toEqual({ ok: true, value: { titlePrefix: true } })
    await expect(dispatchRpc({ ...manager, sessionTitlePrefix: undefined }, 'ui/session-title-prefix', {})).resolves.toEqual({ ok: true, value: { titlePrefix: true } })
    await expect(dispatchRpc(manager, 'ui/session-title-prefix-set', { titlePrefix: true })).resolves.toEqual({ ok: true, value: { titlePrefix: true } })
    expect(manager.calls).toContainEqual(['setSessionTitlePrefix', true])
    await expect(dispatchRpc({ ...manager, sessionTitlePrefix: () => false }, 'ui/session-title-prefix-set', { titlePrefix: false })).resolves.toEqual({ ok: true, value: { titlePrefix: false } })
    await expect(dispatchRpc(manager, 'ui/session-title-prefix-set', {})).resolves.toMatchObject({ ok: false, error: { code: 'bad_payload' } })
    await expect(dispatchRpc(manager, 'ui/session-title-prefix-set', { titlePrefix: 'yes' })).resolves.toMatchObject({ ok: false, error: { code: 'bad_payload' } })
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
    // The idle-release window: read is `undefined` on an older host half (which
    // hides the tab), and a write is validated against the shared ladder —
    // only a rung the slider offers is a window the host runs.
    await expect(dispatchRpc(manager, 'ui/idle-release', {})).resolves.toEqual({
      ok: true,
      value: { idleRelease: { idleTimeoutMs: 1_800_000, defaultIdleTimeoutMs: 1_800_000 } },
    })
    await expect(dispatchRpc({ ...manager, idleRelease: undefined }, 'ui/idle-release', {})).resolves.toEqual({
      ok: true,
      value: { idleRelease: undefined },
    })
    await expect(dispatchRpc(manager, 'ui/idle-release-set', { idleTimeoutMs: 300_000 })).resolves.toMatchObject({ ok: true })
    expect(manager.calls).toContainEqual(['setIdleRelease', 300_000, false])
    await expect(dispatchRpc(manager, 'ui/idle-release-set', { reset: true })).resolves.toMatchObject({ ok: true })
    expect(manager.calls).toContainEqual(['setIdleRelease', undefined, true])
    for (const bad of [0, -1, 1.5, 86_400_001, '60000', 90_000]) {
      await expect(dispatchRpc(manager, 'ui/idle-release-set', { idleTimeoutMs: bad }))
        .resolves.toMatchObject({ ok: false, error: { code: 'bad_payload' } })
    }
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

  it('routes session/chat-fork-adopt to the manager and normalizes a bad payload', async () => {
    // The second half of a branched conversation: the browser names the DSH
    // child the host fork built and the parent to fork from — the manager owns
    // everything past this shape check.
    const manager = fakeManager()
    await expect(dispatchRpc(manager, 'session/chat-fork-adopt', { dshSessionId: 'child-1', parentDshSessionId: 'parent-1' }))
      .resolves.toEqual({ ok: true, value: { sessionId: 'S-child', acpSessionId: 'acp-child' } })
    expect(manager.calls).toContainEqual(['adoptForkedSession', { childDshSessionId: 'child-1', parentDshSessionId: 'parent-1' }])

    // Both ids are mandatory strings within the same bound every conversation
    // endpoint carries: absent, non-string, or over-length is one shape
    // failure, and none of them reaches the manager.
    const badPayloads: Array<Record<string, unknown>> = [
      {},
      { dshSessionId: 'child-1' },
      { parentDshSessionId: 'parent-1' },
      { dshSessionId: 7, parentDshSessionId: 'parent-1' },
      { dshSessionId: 'child-1', parentDshSessionId: null },
      { dshSessionId: 'x'.repeat(129), parentDshSessionId: 'parent-1' },
      { dshSessionId: 'child-1', parentDshSessionId: 'y'.repeat(129) },
    ]
    for (const payload of badPayloads) {
      await expect(dispatchRpc(manager, 'session/chat-fork-adopt', payload))
        .resolves.toMatchObject({ ok: false, error: { code: 'bad_payload' } })
    }
    expect(manager.calls.filter(([kind]) => kind === 'adoptForkedSession')).toHaveLength(1)

    // An older host half without the endpoint answers ok rather than failing —
    // the adopt is an optional surface, like the other chat-session ones.
    await expect(dispatchRpc({ ...manager, adoptForkedSession: undefined }, 'session/chat-fork-adopt', { dshSessionId: 'child-1', parentDshSessionId: 'parent-1' }))
      .resolves.toEqual({ ok: true, value: { done: true } })
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

describe('appendExternalSubagentCatalog', () => {
  it('appends one v2 external fact and skips a repeated childId', () => {
    const events: Array<{ type: string; data: Record<string, unknown> }> = []
    const session = {
      events,
      append(type: string, data: Record<string, unknown>): void {
        events.push({ type, data })
      },
    }
    expect(appendExternalSubagentCatalog(session, 'acp:call-1', 'general-purpose · audit', 123)).toBe(true)
    expect(events).toEqual([{
      type: 'subagent/catalog',
      data: {
        version: 2,
        childId: 'acp:call-1',
        childCreatedAt: 123,
        mode: 'external',
        label: 'general-purpose · audit',
      },
    }])
    expect(appendExternalSubagentCatalog(session, 'acp:call-1', 'again', 456)).toBe(false)
    expect(events).toHaveLength(1)
  })

  it('is silent when the session cannot append or the host rejects the event', () => {
    expect(appendExternalSubagentCatalog(undefined, 'acp:call-1', 'x')).toBe(false)
    const failing = {
      events: [] as unknown[],
      append(): void { throw new Error('host without subagent/catalog') },
    }
    expect(appendExternalSubagentCatalog(failing, 'acp:call-1', 'x')).toBe(false)
  })
})

/**
 * `agentRefusalDetail` lives in bridge.ts (it reads a `session/prompt`
 * RESPONSE, which only the bridge sees) but is pure, so its branches are
 * pinned here rather than in the subprocess suite. The wire fact behind every
 * case: CodeBuddy refuses a prompt with a RESOLVED response — no error object,
 * no `describeError` — and puts the reason in the response `_meta`.
 */
describe('agentRefusalDetail (a refused prompt response, read off its _meta)', () => {
  const QUOTA_MESSAGE = '429 您使用量已超出频率限制，将在 2026-11-05 12:00 重置，您也可以切换其他模型继续使用。'

  it('reads a legal quota refusal as a quota', () => {
    const meta = {
      'codebuddy.ai/errorMessage': JSON.stringify({
        code: -32003,
        message: QUOTA_MESSAGE,
        data: { statusCode: 429, code: 6004, category: 'quota' },
      }),
    }
    expect(agentRefusalDetail(meta)).toEqual({ kind: 'quota', message: QUOTA_MESSAGE })
  })

  it('keeps the raw text when the JSON is damaged', () => {
    const broken = '{"code":-32003,"message":"429 quota",'
    expect(agentRefusalDetail({ 'codebuddy.ai/errorMessage': broken }))
      .toEqual({ kind: 'refusal', message: broken })
  })

  it('answers undefined when the key is missing or _meta is not an object', () => {
    expect(agentRefusalDetail({ 'codebuddy.ai/requestId': 'r-1' })).toBeUndefined()
    expect(agentRefusalDetail(undefined)).toBeUndefined()
    expect(agentRefusalDetail(null)).toBeUndefined()
    expect(agentRefusalDetail('codebuddy.ai/errorMessage')).toBeUndefined()
    expect(agentRefusalDetail(42)).toBeUndefined()
  })

  it('is a plain refusal when the category says so', () => {
    const meta = {
      'codebuddy.ai/errorMessage': JSON.stringify({
        code: -32003,
        message: 'content policy',
        data: { statusCode: 400, code: 6001, category: 'content_filter' },
      }),
    }
    expect(agentRefusalDetail(meta)).toEqual({ kind: 'refusal', message: 'content policy' })
  })

  it('still reads a quota from statusCode alone', () => {
    const meta = {
      'codebuddy.ai/errorMessage': JSON.stringify({
        code: -32003,
        message: QUOTA_MESSAGE,
        data: { statusCode: 429, code: 6004 },
      }),
    }
    expect(agentRefusalDetail(meta)).toEqual({ kind: 'quota', message: QUOTA_MESSAGE })
  })

  it('falls back to the raw text when the message is empty', () => {
    const raw = JSON.stringify({ code: -32003, message: '', data: { category: 'quota' } })
    expect(agentRefusalDetail({ 'codebuddy.ai/errorMessage': raw }))
      .toEqual({ kind: 'quota', message: raw })
  })
})

describe('external subagent records (schema, cap, detail)', () => {
  const record = (overrides: Partial<SubagentRecord> = {}): SubagentRecord => ({
    childId: 'acp:call-1',
    dshSessionId: 'chat-1',
    toolCallId: 'call-1',
    label: 'general-purpose · audit',
    status: 'running',
    startedAt: 100,
    lastActivityAt: 200,
    counts: { updates: 3, toolCalls: 1, textChars: 12 },
    ...overrides,
  })

  it('normalizes a stored row and keeps the failure reason shape verbatim', () => {
    expect(normalizeSubagentRecord(record({
      status: 'failed',
      error: { message: 'boom', code: 7 },
      type: 'explorer',
      endedAt: 300,
    }))).toEqual({
      childId: 'acp:call-1',
      dshSessionId: 'chat-1',
      toolCallId: 'call-1',
      label: 'general-purpose · audit',
      type: 'explorer',
      status: 'failed',
      startedAt: 100,
      lastActivityAt: 200,
      endedAt: 300,
      error: { message: 'boom', code: 7 },
      counts: { updates: 3, toolCalls: 1, textChars: 12 },
    })
    // A string reason survives as a string, an array as an array (constraint 29).
    expect(normalizeSubagentRecord(record({ error: 'rate limited' }))?.error).toBe('rate limited')
    expect(normalizeSubagentRecord(record({ error: ['a', 'b'] }))?.error).toEqual(['a', 'b'])
  })

  it('rebuilds the tool call id from the catalog child id and drops unusable rows', () => {
    const rebuilt = normalizeSubagentRecord({ ...record(), toolCallId: undefined })
    expect(rebuilt?.toolCallId).toBe('call-1')
    expect(normalizeSubagentRecord({ ...record(), childId: 'native-1' })).toBeUndefined()
    expect(normalizeSubagentRecord({ ...record(), childId: 'acp:' })).toBeUndefined()
    expect(normalizeSubagentRecord({ ...record(), dshSessionId: '' })).toBeUndefined()
    // No start time = no readable row.
    expect(normalizeSubagentRecord({ ...record(), startedAt: 'yesterday' })).toBeUndefined()
    expect(normalizeSubagentRecord(null)).toBeUndefined()
    expect(normalizeSubagentRecord([record()])).toBeUndefined()
  })

  it('reads a restored row that never reached a terminal state as unknown', () => {
    const restored = normalizeSubagentRecordMap({
      'chat-1': [
        record({ childId: 'acp:running', toolCallId: 'running', status: 'running' }),
        record({ childId: 'acp:pending', toolCallId: 'pending', status: 'pending' }),
        record({ childId: 'acp:done', toolCallId: 'done', status: 'completed', endedAt: 400 }),
      ],
    })['chat-1']
    expect(restored?.map(row => row.status)).toEqual(['unknown', 'unknown', 'completed'])
    // A converted row carries the moment its clock stopped, so the panel can
    // still show "last activity" instead of a running stopwatch.
    expect(restored?.[0].endedAt).toBe(200)
    expect(restored?.[2].endedAt).toBe(400)
  })

  it('drops keys with no surviving owner and de-duplicates by child id', () => {
    const map = normalizeSubagentRecordMap({
      'chat-1': [record()],
      'chat-2': [record({ dshSessionId: 'chat-2' })],
      'chat-orphan': [record({ dshSessionId: 'chat-orphan' })],
    }, new Set(['chat-1', 'chat-2']))
    expect(Object.keys(map).sort()).toEqual(['chat-1', 'chat-2'])
    const duplicate = normalizeSubagentRecordMap({
      'chat-1': [record({ label: 'first' }), record({ label: 'second' })],
    })['chat-1']
    expect(duplicate).toHaveLength(1)
    expect(duplicate?.[0].label).toBe('second')
  })

  it('caps at the per-chat limit, evicting the oldest TERMINAL rows only', () => {
    const rows: SubagentRecord[] = []
    for (let index = 0; index < MAX_SUBAGENT_RECORDS + 2; index += 1) {
      rows.push(record({
        childId: `acp:call-${String(index)}`,
        toolCallId: `call-${String(index)}`,
        status: 'completed',
        endedAt: 500,
      }))
    }
    // The two OLDEST terminal rows go; the newest survive.
    const capped = capSubagentRecords(rows)
    expect(capped).toHaveLength(MAX_SUBAGENT_RECORDS)
    expect(capped[0]?.toolCallId).toBe('call-2')
    expect(capped.at(-1)?.toolCallId).toBe(`call-${String(MAX_SUBAGENT_RECORDS + 1)}`)
    // Running rows are never evicted to make room: with every row still open
    // the list stays whole (the cap cannot invent a terminal state).
    const running = rows.map(row => ({ ...row, status: 'running' as const, endedAt: undefined }))
    expect(capSubagentRecords(running)).toHaveLength(running.length)
    // A mix: only terminal rows are candidates, in list order.
    const mixed = [
      { ...rows[0], status: 'running' as const, endedAt: undefined },
      rows[1],
      rows[2],
    ]
    expect(capSubagentRecords(mixed, 2).map(row => row.toolCallId)).toEqual(['call-0', 'call-2'])
  })

  it('bounds one oversized detail frame with a marker instead of dropping it', () => {
    const small = boundSubagentDetailEntry(7, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hi' } })
    expect(small.update).toEqual({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hi' } })
    expect(small.truncatedChars).toBeUndefined()
    const big = boundSubagentDetailEntry(8, {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'call-1',
      content: [{ type: 'content', content: { type: 'text', text: 'x'.repeat(ACP_TOOL_RAW_MAX + 50) } }],
    })
    expect(big.truncatedChars).toBeGreaterThan(0)
    const marked = big.update as { sessionUpdate?: string; truncated?: boolean; text?: string }
    expect(marked.sessionUpdate).toBe('tool_call_update')
    expect(marked.truncated).toBe(true)
    expect(marked.text).toContain('[truncated')
    expect(marked.text?.length).toBeLessThanOrEqual(ACP_TOOL_RAW_MAX + 80)
  })
})

describe('subagents/detail RPC (payload validation)', () => {
  it('validates both ids and the external child id prefix, and answers empty for an unknown host half', async () => {
    const detail = {
      entries: [{ seq: 3, update: { sessionUpdate: 'agent_message_chunk' } }],
      omitted: 1,
    }
    const manager = fakeManager()
    const withDetail = {
      ...manager,
      subagentsDetail: (dshSessionId: string, childId: string) => {
        manager.calls.push(['subagentsDetail', { dshSessionId, childId }])
        return detail
      },
    }
    await expect(dispatchRpc(withDetail, 'subagents/detail', { dshSessionId: 'chat-1', childId: 'acp:call-1' }))
      .resolves.toEqual({ ok: true, value: detail })
    expect(manager.calls).toContainEqual(['subagentsDetail', { dshSessionId: 'chat-1', childId: 'acp:call-1' }])
    // A host half without the method answers an empty result, not a failure.
    await expect(dispatchRpc(manager, 'subagents/detail', { dshSessionId: 'chat-1', childId: 'acp:call-1' }))
      .resolves.toEqual({ ok: true, value: { entries: [] } })
    // Payload validation happens BEFORE the optional call.
    await expect(dispatchRpc(withDetail, 'subagents/detail', { childId: 'acp:call-1' }))
      .resolves.toMatchObject({ ok: false, error: { code: 'bad_payload' } })
    await expect(dispatchRpc(withDetail, 'subagents/detail', { dshSessionId: 'chat-1' }))
      .resolves.toMatchObject({ ok: false, error: { code: 'bad_payload' } })
    await expect(dispatchRpc(withDetail, 'subagents/detail', { dshSessionId: 'chat-1', childId: 'call-1' }))
      .resolves.toMatchObject({ ok: false, error: { code: 'bad_payload' } })
    await expect(dispatchRpc(withDetail, 'subagents/detail', { dshSessionId: 'chat-1', childId: 'acp:' }))
      .resolves.toMatchObject({ ok: false, error: { code: 'bad_payload' } })
  })
})

// ---- Agent skills (pure half) ----

describe('agent skills (impl)', () => {
  describe('skillFlavorOf', () => {
    it('maps the sample table: bare commands, presets and npx package specs', () => {
      // The flavor table's samples, verbatim.
      expect(skillFlavorOf('claude', ['--acp'])).toBe('claude')
      expect(skillFlavorOf('npx', ['-y', '@agentclientprotocol/claude-agent-acp'])).toBe('claude')
      expect(skillFlavorOf('npx', ['claude-code-acp'])).toBe('claude')
      expect(skillFlavorOf('opencode', ['acp'])).toBe('opencode')
      expect(skillFlavorOf('codex', ['acp'])).toBe('codex')
      expect(skillFlavorOf('npx', ['-y', '@agentclientprotocol/codex-acp'])).toBe('codex')
      expect(skillFlavorOf('gemini', ['--experimental-acp'])).toBe('gemini')
      expect(skillFlavorOf('kimi')).toBe('kimi')
      expect(skillFlavorOf('kimi-cli')).toBe('kimi')
      expect(skillFlavorOf('npx', ['-y', '@moonshotai/kimi-cli'])).toBe('kimi')
      expect(skillFlavorOf('pi-acp')).toBe('pi')
      expect(skillFlavorOf('pi')).toBe('pi')
      expect(skillFlavorOf('omp', ['acp'])).toBe('pi')
      expect(skillFlavorOf('goose', ['acp'])).toBe('goose')
      expect(skillFlavorOf('droid', ['exec', 'acp'])).toBe('droid')
    })

    it('skips launcher tokens and their flags (node, npx, cmd.exe, pnpm dlx), case- and suffix-insensitive', () => {
      expect(skillFlavorOf('node', ['agent.js'])).toBe('generic')
      expect(skillFlavorOf('cmd', ['/d', '/s', '/c', 'claude', '--acp'])).toBe('claude')
      expect(skillFlavorOf('CMD.EXE', ['/C', 'claude'])).toBe('claude')
      expect(skillFlavorOf('pnpm', ['dlx', '@moonshotai/kimi-cli'])).toBe('kimi')
      expect(skillFlavorOf('npm', ['exec', '-y', '@agentclientprotocol/codex-acp'])).toBe('codex')
      expect(skillFlavorOf('NODE.EXE', ['/path/to/claude'])).toBe('claude')
      expect(skillFlavorOf('C:\\Program Files\\nodejs\\npx.cmd', ['-y', '@agentclientprotocol/claude-agent-acp'])).toBe('claude')
    })

    it('matches pi with a dash boundary so api-* never hits, and falls back to generic', () => {
      expect(skillFlavorOf('api-helper')).toBe('generic')
      expect(skillFlavorOf('pi-tools')).toBe('pi')
      expect(skillFlavorOf('qwen', ['acp'])).toBe('generic')
      expect(skillFlavorOf('codebuddy', ['--acp'])).toBe('generic')
      expect(skillFlavorOf('')).toBe('generic')
      expect(skillFlavorOf('node')).toBe('generic')
    })
  })

  it('keeps the flavor dir tables in the documented shape', () => {
    const flavors = Object.entries(SKILL_DIRS_BY_FLAVOR)
    expect(flavors.length).toBe(8)
    for (const [, table] of flavors) {
      for (const dir of table.projectDirs) {
        expect(dir.startsWith('~/')).toBe(false)
        expect(dir.startsWith('/')).toBe(false)
        expect(dir.includes('\\')).toBe(false)
        expect(dir.includes('..')).toBe(false)
      }
      for (const dir of [...table.globalDirs, ...table.systemDirs]) {
        expect(dir.startsWith('~/')).toBe(true)
        expect(dir.includes('\\')).toBe(false)
        expect(dir.includes('..')).toBe(false)
      }
      expect(table.projectDirs.length).toBeGreaterThan(0)
      expect(table.globalDirs.length).toBeGreaterThan(0)
    }
    expect(SKILL_DIRS_BY_FLAVOR.claude.projectDirs).toEqual(['.claude/skills'])
    expect(SKILL_DIRS_BY_FLAVOR.codex.systemDirs).toEqual(['~/.codex/skills/.system'])
    expect(SKILL_DIRS_BY_FLAVOR.pi.globalDirs).toEqual(['~/.pi/agent/skills'])
    // The generic fallback is a table too, and never empty.
    expect(GENERIC_SKILL_DIRS.projectDirs).toEqual(['.agents/skills'])
    expect(GENERIC_SKILL_DIRS.globalDirs.length).toBeGreaterThan(0)
  })

  describe('parseSkillFrontmatter', () => {
    it('returns {} without frontmatter and strips a BOM', () => {
      expect(parseSkillFrontmatter('no markers here')).toEqual({})
      expect(parseSkillFrontmatter('name: x\n---\n')).toEqual({})
      expect(parseSkillFrontmatter('\uFEFF---\nname: x\n---\n')).toEqual({ name: 'x' })
      expect(parseSkillFrontmatter('---\r\nname: x\r\n---\r\n')).toEqual({ name: 'x' })
    })

    it('throws when the opening marker never closes', () => {
      expect(() => parseSkillFrontmatter('---\nname: x')).toThrow()
      expect(() => parseSkillFrontmatter('---\nname: x\nbody text')).toThrow()
    })

    it('skips comments and blank lines, strips paired quotes, drops empty values', () => {
      const parsed = parseSkillFrontmatter('---\n# a comment\n\nname: "My Skill"\ndescription: \'use it\'\nempty:\n---\nbody')
      expect(parsed).toEqual({ name: 'My Skill', description: 'use it' })
    })

    it('accepts one nesting level under metadata and flattens it', () => {
      const parsed = parseSkillFrontmatter('---\nmetadata:\n  owner: pi\n  - list item\nname: x\n---\n')
      expect(parsed).toEqual({ 'metadata.owner': 'pi', name: 'x' })
      // A malformed nested line throws, like a malformed top-level line.
      expect(() => parseSkillFrontmatter('---\nmetadata:\n  not a pair\n---\n')).toThrow()
    })
  })

  describe('skillMentionToken', () => {
    it('uses a whitespace-free name directly', () => {
      expect(skillMentionToken('code-review', 'whatever/SKILL.md')).toBe('code-review')
      expect(skillMentionToken('  spaced-name  ', 'a/SKILL.md')).toBe('spaced-name')
    })

    it('falls back to the last path segment when the name has whitespace, and folds whitespace to dashes last', () => {
      expect(skillMentionToken('My Skill', 'my-skill/SKILL.md')).toBe('my-skill')
      expect(skillMentionToken('My Skill', 'a/b/c/SKILL.MD')).toBe('c')
      expect(skillMentionToken('My Skill', '')).toBe('My-Skill')
      expect(skillMentionToken('', '')).toBe('')
    })
  })

  it('escapes destinations with backslash and close-paren and formats the prompt verbatim', () => {
    expect(formatSkillPathDestination('C:\\a\\x.md')).toBe('C:\\\\a\\\\x.md')
    expect(formatSkillPathDestination('/a/b(x).md')).toBe('/a/b(x\\).md')
    expect(formatSkillMentionPrompt('code-review', '/home/u/.claude/skills/code-review')).toBe(
      'use /code-review [Skill Path](/home/u/.claude/skills/code-review)',
    )
    expect(formatSkillMentionPrompt('review', 'C:\\Users\\u\\skills\\review')).toBe(
      'use /review [Skill Path](C:\\\\Users\\\\u\\\\skills\\\\review)',
    )
  })

  it('serves agent/skills through the dispatcher: validated ids, optional call, empty fallback', async () => {
    const skills = { skills: [{ token: 't', name: 't', scope: 'project', folder: 't', insertion: 'use /t [Skill Path](t)' }] }
    const manager = fakeManager()
    const withSkills = {
      ...manager,
      agentSkills: (dshSessionId: string, agentId: string) => {
        manager.calls.push(['agentSkills', { dshSessionId, agentId }])
        return Promise.resolve(skills)
      },
    }
    await expect(dispatchRpc(withSkills, 'agent/skills', { dshSessionId: 'chat-1', agentId: 'claude' }))
      .resolves.toEqual({ ok: true, value: skills })
    expect(manager.calls).toContainEqual(['agentSkills', { dshSessionId: 'chat-1', agentId: 'claude' }])
    // A host half without the method answers an empty menu, not a failure.
    await expect(dispatchRpc(manager, 'agent/skills', { dshSessionId: 'chat-1', agentId: 'claude' }))
      .resolves.toEqual({ ok: true, value: { skills: [] } })
    // Payload validation happens BEFORE the optional call.
    await expect(dispatchRpc(withSkills, 'agent/skills', { agentId: 'claude' }))
      .resolves.toMatchObject({ ok: false, error: { code: 'bad_payload' } })
    await expect(dispatchRpc(withSkills, 'agent/skills', { dshSessionId: 'chat-1' }))
      .resolves.toMatchObject({ ok: false, error: { code: 'bad_payload' } })
    await expect(dispatchRpc(withSkills, 'agent/skills', { dshSessionId: 3, agentId: 'claude' }))
      .resolves.toMatchObject({ ok: false, error: { code: 'bad_payload' } })
  })
})