import { describe, expect, it } from 'vitest'
import {
  AcpError,
  EventHub,
  PermissionLedger,
  Transcript,
  acpToolCallDelta,
  acpToolCallFromUpdate,
  buildAdapterModelId,
  canonicalizeFsPath,
  childEnv,
  dispatchRpc,
  ACP_PRESET_SOURCE,
  acpPresetStatusFromRoster,
  isAbsolutePath,
  isUnderPath,
  parseCatalogOptions,
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
  validateConfig,
} from '../src/impl.ts'
import type { AcpManager } from '../src/impl.ts'
import type { AcpAgentDef, AgentProbeModelsResult } from '../src/protocol.ts'

function agentDef(overrides: Partial<AcpAgentDef> = {}): AcpAgentDef {
  return {
    id: 'demo',
    title: 'Demo',
    command: 'demo-agent',
    args: [],
    env: {},
    permission: 'ask',
    cwd: '/work',
    allowedCwdRoots: ['/work'],
    ...overrides,
  }
}

describe('validateConfig', () => {
  it('applies defaults', () => {
    const config = validateConfig({ agents: [{ id: 'a', command: 'run-a' }] })
    expect(config.agents[0]).toMatchObject({ id: 'a', title: 'a', args: [], env: {}, permission: 'ask', allowedCwdRoots: [] })
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
    expect(config.permissionTimeoutMs).toBe(0)
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
  it('extracts model and thought_level categories from spec-shaped options', () => {
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
  })

  it('falls back to the legacy id field, flattens grouped options, dedupes, and skips unknown categories', () => {
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
  })

  it('returns an empty catalog for non-arrays and choice-less options', () => {
    expect(parseCatalogOptions('nope')).toEqual({})
    expect(parseCatalogOptions(undefined)).toEqual({})
    expect(parseCatalogOptions([{ configId: 'model', category: 'model', currentValue: 'a' }])).toEqual({
      model: { configId: 'model', name: 'model', currentValue: 'a', choices: [] },
    })
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

describe('ACP tool-call notifications → Chat tool-call chunks', () => {
  it('reads the identity and label an agent announces, and refuses to invent arguments', () => {
    expect(acpToolCallFromUpdate({ toolCallId: 'call_1', title: 'mock tool', kind: 'read' }))
      .toEqual({ callId: 'call_1', name: 'mock tool', argsRaw: '' })
    // No arguments is legal ACP: the card is empty, not fabricated.
    expect(acpToolCallFromUpdate({ toolCallId: 'call_2' }))
      .toEqual({ callId: 'call_2', name: '', argsRaw: '' })
  })

  it('drops a notification with no call identity — the renderer groups by it', () => {
    expect(acpToolCallFromUpdate({ title: 'no id' })).toBeUndefined()
    expect(acpToolCallFromUpdate({ toolCallId: '   ' })).toBeUndefined()
    expect(acpToolCallFromUpdate({})).toBeUndefined()
  })

  it('accepts the argument spellings agents use in the wild', () => {
    expect(acpToolCallFromUpdate({ toolCallId: 'c', rawInput: '{"a":1}' })).toMatchObject({ argsRaw: '{"a":1}' })
    expect(acpToolCallFromUpdate({ toolCallId: 'c', arguments: 'plain' })).toMatchObject({ argsRaw: 'plain' })
    expect(acpToolCallFromUpdate({ toolCallId: 'c', arguments: { a: 1 } })).toMatchObject({ argsRaw: '{"a":1}' })
    // An unserializable value degrades to text rather than failing the card.
    const circular: Record<string, unknown> = {}
    circular.self = circular
    expect(acpToolCallFromUpdate({ toolCallId: 'c', arguments: circular }).argsRaw).toBe('[object Object]')
  })

  it('folds an update into the open snapshot, naming only real changes', () => {
    const snapshot = { callId: 'call_1', name: 'mock tool', argsRaw: '' }
    // No change at all: no deltas, so no chunk is emitted.
    expect(acpToolCallDelta(snapshot, { toolCallId: 'call_1' })).toEqual([])
    // Content becomes argument text.
    expect(acpToolCallDelta(snapshot, {
      toolCallId: 'call_1',
      content: [{ type: 'content', content: { type: 'text', text: 'tool result line' } }],
    })).toEqual([{ kind: 'args', text: 'tool result line' }])
    expect(snapshot).toEqual({ callId: 'call_1', name: 'mock tool', argsRaw: 'tool result line' })
    // A retitled agent gets a name delta and the snapshot follows.
    expect(acpToolCallDelta(snapshot, { toolCallId: 'call_1', title: 'renamed tool' }))
      .toEqual([{ kind: 'name', name: 'renamed tool' }])
    expect(snapshot.name).toBe('renamed tool')
    // A restatement of the same name is not a change.
    expect(acpToolCallDelta(snapshot, { toolCallId: 'call_1', title: 'renamed tool' })).toEqual([])
  })

  it('keeps the content kinds the Chat card cannot render, as placeholders', () => {
    const snapshot = { callId: 'c', name: '', argsRaw: '' }
    acpToolCallDelta(snapshot, {
      toolCallId: 'c',
      content: [
        { type: 'content', content: { type: 'text', text: 'first' } },
        { type: 'content', content: { type: 'diff', path: '/w/a.ts' } },
        { type: 'content', content: { type: 'image' } },
        { type: 'terminal', terminalId: 't1' },
      ],
    })
    expect(snapshot.argsRaw).toBe('first\n[diff /w/a.ts]\n[image]\n[terminal t1]')
  })

  it('treats a restated rawInput as a snapshot, not an append', () => {
    // ACP updates restate the whole input on every change; the host's
    // accumulator CONCATENATES deltas, so folding a full snapshot as one would
    // grow `{"cmd":""}{"cmd":"ls -la"}…` garbage (the oml session bug). Only
    // a genuine string extension becomes a delta (plain-text args grow like
    // that); a replacement pushes nothing and moves the snapshot, which the
    // closing `block-end` frame states in full.
    const snapshot = { callId: 'c', name: 't', argsRaw: 'Running the build' }
    expect(acpToolCallDelta(snapshot, { toolCallId: 'c', arguments: 'Running the build for the oml workspace' }))
      .toEqual([{ kind: 'args', text: ' for the oml workspace' }])
    expect(snapshot.argsRaw).toBe('Running the build for the oml workspace')
    // JSON growth is a REWRITE, not an extension — the closing brace moves.
    expect(acpToolCallDelta(snapshot, { toolCallId: 'c', rawInput: '{"file":"a.md"}' }))
      .toEqual([])
    expect(snapshot.argsRaw).toBe('{"file":"a.md"}')
    // A verbatim restatement changes nothing.
    expect(acpToolCallDelta(snapshot, { toolCallId: 'c', rawInput: '{"file":"a.md"}' }))
      .toEqual([])
    expect(snapshot.argsRaw).toBe('{"file":"a.md"}')
  })

  it('lets input outrank content: the card shows what the tool was asked, not what it printed', () => {
    const snapshot = { callId: 'c', name: 't', argsRaw: '{"file":"a.md"}' }
    // The result text arrives as `content` AFTER input was seen: it is output,
    // not arguments — ignored, or a Read card would swallow the whole file.
    expect(acpToolCallDelta(snapshot, {
      toolCallId: 'c',
      content: [{ type: 'content', content: { type: 'text', text: '   1→ entire file body' } }],
    })).toEqual([])
    expect(snapshot.argsRaw).toBe('{"file":"a.md"}')
    // Content only fills a call whose agent never sent input at all.
    const silent = { callId: 'd', name: 't', argsRaw: '' }
    expect(acpToolCallDelta(silent, {
      toolCallId: 'd',
      content: [{ type: 'content', content: { type: 'text', text: 'tool result line' } }],
    })).toEqual([{ kind: 'args', text: 'tool result line' }])
    expect(silent.argsRaw).toBe('tool result line')
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

describe('validateAgentDef', () => {
  it('validates a valid agent definition and applies defaults', () => {
    const def = validateAgentDef({ id: 'pi', command: 'pi-acp' })
    expect(def).toEqual({
      id: 'pi',
      title: 'pi',
      command: 'pi-acp',
      args: [],
      env: {},
      permission: 'ask',
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
    expect(() => canonicalizeFsPath('C:/ws', '\\\\?\\C:\\ws\\x', winRealpath)).toThrow(/does not exist/)
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
    expect(() => resolveFsPath('C:/ws', ['C:/ws'], '\\\\?\\C:\\ws\\x', winRealpath)).toThrow(/does not exist/)
    expect(() => resolveFsPath('C:/ws', ['C:/ws'], '//?/C:/ws/x', winRealpath)).toThrow(/does not exist/)
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
  it('scrubs secret-shaped and DSH_* ambient names, then merges explicit env', () => {
    const out = childEnv(
      { HOME: '/h', ANTHROPIC_API_KEY: 'sk', GITHUB_TOKEN: 'gh', DSH_PERMISSION_MODE: 'x', PLAIN: 'p' },
      { DEEPSEEK_API_KEY: 'explicit', HOME: '/other' },
    )
    expect(out).toEqual({ HOME: '/other', PLAIN: 'p', DEEPSEEK_API_KEY: 'explicit' })
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
    bindChatAgent: (dshSessionId, agentId) => { calls.push(['bindChatAgent', dshSessionId, agentId]) },
    setChatSessionModel: async (dshSessionId, modelId) => { calls.push(['setChatSessionModel', dshSessionId, modelId]) },
    setChatSessionEffort: async (dshSessionId, effort) => { calls.push(['setChatSessionEffort', dshSessionId, effort]) },
    setPermission: async (id, p) => { calls.push(['setPermission', { id, p }]) },
    detectAgents: async () => { calls.push(['detect', undefined]); return [] },
    saveAgent: async def => { calls.push(['save', def]) },
    deleteAgent: async id => { calls.push(['delete', id]) },
    testAgent: async def => {
      calls.push(['test', def])
      return { ok: true, durationMs: 5, stderr: [] }
    },
    setExposedModels: async (id, exposed) => { calls.push(['setExposedModels', { id, exposed }]) },
    probeAgentModels: async agentId => {
      calls.push(['probe', agentId])
      return { agentId, catalog: { model: { configId: 'model', name: 'Model', currentValue: 'a', choices: [{ value: 'a', name: 'A' }] } }, updatedAt: 1 }
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
    // `approvalRouted` is reported for every host build; a manager without the
    // probe (older/partial implementation) reports the degraded `false`.
    await expect(dispatchRpc(manager, 'agents/list', {})).resolves.toEqual({
      ok: true,
      value: { agents: [], approvalRouted: false },
    })
    expect(manager.calls).toContainEqual(['agents', undefined])
    const routed = { ...manager, approvalRouting: () => true }
    await expect(dispatchRpc(routed, 'agents/list', {})).resolves.toEqual({
      ok: true,
      value: { agents: [], approvalRouted: true },
    })
    // Optional chat-session mode surface: a manager without it reports none.
    await expect(dispatchRpc(manager, 'session/chat-list', { dshSessionId: 'chat-1' })).resolves.toEqual({ ok: true, value: { sessions: [], acpMode: false } })
    // The seat gate's fallback fact source: read-only, memory-only, and false
    // when the manager lacks the method (an older host half) or the resolver.
    const acpModeOn = { ...manager, chatSessionAcpMode: (dshSessionId: string) => dshSessionId === 'chat-1' }
    await expect(dispatchRpc(acpModeOn, 'session/chat-list', { dshSessionId: 'chat-1' })).resolves.toEqual({ ok: true, value: { sessions: [], acpMode: true } })
    await expect(dispatchRpc(acpModeOn, 'session/chat-list', { dshSessionId: 'chat-2' })).resolves.toEqual({ ok: true, value: { sessions: [], acpMode: false } })
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
    await expect(dispatchRpc(manager, 'agent/set-permission', { agentId: 'custom', permission: 'allow' })).resolves.toEqual({ ok: true, value: { done: true } })
    expect(manager.calls).toContainEqual(['setPermission', { id: 'custom', p: 'allow' }])
    await expect(dispatchRpc(manager, 'agent/set-permission', { agentId: 'custom', permission: 'invalid' })).resolves.toMatchObject({ ok: false, error: { code: 'bad_payload' } })
    await expect(dispatchRpc(manager, 'agent/probe-models', { agentId: 'pi' })).resolves.toMatchObject({
      ok: true,
      value: { agentId: 'pi', catalog: { model: { configId: 'model' } } },
    })
    expect(manager.calls).toContainEqual(['probe', 'pi'])
    await expect(dispatchRpc(manager, 'agent/probe-models', {})).resolves.toMatchObject({ ok: false, error: { code: 'bad_payload' } })
    const bare = { ...manager, probeAgentModels: undefined }
    await expect(dispatchRpc(bare, 'agent/probe-models', { agentId: 'pi' })).resolves.toMatchObject({ ok: false, error: { code: 'unsupported' } })
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