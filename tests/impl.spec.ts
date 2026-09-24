import { describe, expect, it } from 'vitest'
import {
  AcpDefaultModelGuard,
  AcpError,
  EventHub,
  PermissionLedger,
  Transcript,
  buildAdapterModelId,
  canonicalizeFsPath,
  childEnv,
  decidePermission,
  dispatchRpc,
  dshApprovalPolicyOf,
  dshSessionPolicyOf,
  ACP_PRESET_SOURCE,
  acpPresetStatusFromRoster,
  isUnderPath,
  parseCatalogOptions,
  permissionToolKind,
  permissionToolPaths,
  lastNativeRoute,
  resolveFsPath,
  resolveSessionCwd,
  sandboxDenialMarker,
  selectForwardPrompt,
  sessionAgentPreset,
  sessionAgentPresetFromLog,
  splitAdapterModelId,
  validateAgentDef,
  validateConfig,
} from '../src/impl.ts'
import type { AcpManager, DefaultModelPorts, DshSessionPolicy, ModelRouteSelection } from '../src/impl.ts'
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
    expect(() => validateConfig({ agents: [], startupTimeoutMs: 500 })).toThrow(/startupTimeoutMs/)
    expect(() => validateConfig({ agents: [], permissionTimeoutMs: -1 })).toThrow(/permissionTimeoutMs/)
    expect(() => validateConfig({ agents: [], cancelFallbackMs: 601_000 })).toThrow(/cancelFallbackMs/)
    expect(validateConfig({ agents: [], permissionTimeoutMs: 60_000, cancelFallbackMs: 0 }).cancelFallbackMs).toBe(0)
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
    reconcileDefaultModel: async previous => {
      calls.push(['reconcileDefaultModel', previous])
      return { selection: previous, restored: previous !== undefined, stranded: previous === undefined }
    },
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
    // `approvalRouted` / `accessModeRouted` are reported for every host build; a
    // manager without the probes (older/partial implementation) reports the
    // degraded `false` for each.
    await expect(dispatchRpc(manager, 'agents/list', {})).resolves.toEqual({
      ok: true,
      value: { agents: [], approvalRouted: false, accessModeRouted: false },
    })
    expect(manager.calls).toContainEqual(['agents', undefined])
    const routed = { ...manager, approvalRouting: () => true }
    await expect(dispatchRpc(routed, 'agents/list', {})).resolves.toEqual({
      ok: true,
      value: { agents: [], approvalRouted: true, accessModeRouted: false },
    })
    const modeRouted = { ...manager, accessModeRouting: () => true }
    await expect(dispatchRpc(modeRouted, 'agents/list', {})).resolves.toEqual({
      ok: true,
      value: { agents: [], approvalRouted: false, accessModeRouted: true },
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
    // The plugin's OWN default ACP agent (the panel's ★ gesture) — never the
    // deployment default model, which must stay a native route.
    await expect(dispatchRpc(manager, 'model/get-default', {})).resolves.toEqual({ ok: true, value: { provider: 'acp', model: 'mock' } })
    await expect(dispatchRpc(manager, 'model/set-default', { agentId: 'custom' })).resolves.toEqual({ ok: true, value: { done: true } })
    expect(manager.calls).toContainEqual(['setDefaultAgent', 'custom'])
    // A host half with no default agent answers `{}` → the panel shows no ★.
    await expect(dispatchRpc({ ...manager, defaultAgent: undefined }, 'model/get-default', {})).resolves.toEqual({ ok: true, value: {} })
    // The guard's RPC: the pre-write route rides along, and the host's outcome
    // is passed through untouched.
    await expect(dispatchRpc(manager, 'model/reconcile-default', {})).resolves.toEqual({
      ok: true,
      value: { restored: false, stranded: true },
    })
    await expect(dispatchRpc(manager, 'model/reconcile-default', {
      previous: { provider: 'deepseek', model: 'deepseek-v4', reasoningEffort: 'high' },
    })).resolves.toEqual({
      ok: true,
      value: { selection: { provider: 'deepseek', model: 'deepseek-v4', reasoningEffort: 'high' }, restored: true, stranded: false },
    })
    expect(manager.calls).toContainEqual(['reconcileDefaultModel', { provider: 'deepseek', model: 'deepseek-v4', reasoningEffort: 'high' }])
    // A malformed `previous` is not a payload error (it is optional metadata);
    // a non-object one is.
    await expect(dispatchRpc(manager, 'model/reconcile-default', { previous: { provider: 'x' } })).resolves.toMatchObject({ ok: true })
    await expect(dispatchRpc(manager, 'model/reconcile-default', { previous: 'x' })).resolves.toMatchObject({ ok: false, error: { code: 'bad_payload' } })
    await expect(dispatchRpc({ ...manager, reconcileDefaultModel: undefined }, 'model/reconcile-default', {})).resolves.toEqual({
      ok: true,
      value: { restored: false, stranded: false },
    })
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

describe('DSH access mode → ACP permission decision', () => {
  const policy = (overrides: Partial<DshSessionPolicy> = {}): DshSessionPolicy => ({
    mode: 'workspace-write',
    approval: 'ask',
    ...overrides,
  })

  it('lets full access answer locally — the inversion this mapping replaces', () => {
    // 完全权限 = danger-full-access + approval `never`; the host resolves every
    // `never` ask to 'rejected', so routing there denied exactly what the mode allows.
    expect(decidePermission(policy({ mode: 'danger-full-access', approval: 'never' }), 'execute')).toBe('allow')
    expect(decidePermission(policy({ mode: 'danger-full-access', approval: 'never' }), undefined)).toBe('allow')
    expect(decidePermission(policy({ mode: 'danger-full-access', approval: 'never' }), 'edit', ['/etc/passwd'])).toBe('allow')
  })

  it('allows reads in every mode and for every approval policy', () => {
    for (const mode of ['read-only', 'workspace-write', 'danger-full-access'] as const) {
      for (const approval of ['ask', 'never'] as const) {
        expect(decidePermission(policy({ mode, approval }), 'read')).toBe('allow')
        expect(decidePermission(policy({ mode, approval }), 'search')).toBe('allow')
      }
    }
  })

  it('denies writes under read-only + never and escalates them under read-only + ask', () => {
    expect(decidePermission(policy({ mode: 'read-only', approval: 'never' }), 'edit', ['/tmp/x'])).toBe('reject')
    expect(decidePermission(policy({ mode: 'read-only', approval: 'never' }), 'delete')).toBe('reject')
    expect(decidePermission(policy({ mode: 'read-only', approval: 'never' }), 'execute')).toBe('reject')
    expect(decidePermission(policy({ mode: 'read-only', approval: 'ask' }), 'edit', ['/tmp/x'])).toBe('ask')
    expect(decidePermission(policy({ mode: 'read-only', approval: 'ask' }), 'execute')).toBe('ask')
  })

  it('permits a proven in-workspace write under workspace-write and escalates anything else', () => {
    const p = policy({ workspaceRoot: '/srv/ws' })
    expect(decidePermission(p, 'edit', ['/srv/ws/src/a.ts'])).toBe('allow')
    expect(decidePermission(p, 'edit', ['/srv/ws'])).toBe('allow')
    expect(decidePermission(p, 'edit', ['/etc/passwd'])).toBe('ask')
    // Mixed locations: one outside the boundary is enough to need a human.
    expect(decidePermission(p, 'edit', ['/srv/ws/a.ts', '/tmp/b.ts'])).toBe('ask')
    // An undeclared target cannot be proven inside the boundary.
    expect(decidePermission(p, 'edit')).toBe('ask')
    expect(decidePermission(policy({ workspaceRoot: '/srv/ws', approval: 'never' }), 'edit', ['/etc/passwd'])).toBe('reject')
    expect(decidePermission(policy({ workspaceRoot: undefined }), 'edit', ['/srv/ws/a.ts'])).toBe('ask')
  })

  it('treats an unknown effect as confined only under read-only', () => {
    expect(decidePermission(policy({ mode: 'read-only', approval: 'never' }), undefined)).toBe('reject')
    expect(decidePermission(policy({ mode: 'read-only', approval: 'ask' }), 'other')).toBe('ask')
    expect(decidePermission(policy({ approval: 'never' }), 'execute')).toBe('allow')
    expect(decidePermission(policy({ approval: 'never' }), undefined)).toBe('allow')
  })

  it('narrates only in ACP mode: every ask the agent raises reaches the human', () => {
    // The agent's own permission mode decides what it asks about, so the
    // boundary arithmetic must not answer for it — except where the host cannot
    // ask anybody at all (`never` resolves every ask to 'rejected' before an
    // answerer runs, so a quiet local reject is the honest answer).
    const narrate = { narrateOnly: true }
    const ws = policy({ workspaceRoot: '/srv/ws' })
    expect(decidePermission(ws, 'edit', ['/srv/ws/a.ts'], narrate)).toBe('ask')
    expect(decidePermission(ws, 'execute', [], narrate)).toBe('ask')
    expect(decidePermission(policy({ mode: 'read-only' }), 'edit', [], narrate)).toBe('ask')
    // Reads and full access are never worth a prompt.
    expect(decidePermission(ws, 'read', [], narrate)).toBe('allow')
    expect(decidePermission(policy({ mode: 'danger-full-access', approval: 'never' }), 'edit', ['/etc/passwd'], narrate)).toBe('allow')
    expect(decidePermission(policy({ mode: 'read-only', approval: 'never' }), 'edit', [], narrate)).toBe('reject')
  })

  it('folds a session\'s agent preset, newest selection winning over the header', () => {
    expect(sessionAgentPreset(undefined)).toBeUndefined()
    expect(sessionAgentPreset({ header: { agentPreset: 'standard' } })).toBe('standard')
    expect(sessionAgentPreset({ header: {} })).toBeUndefined()
    expect(sessionAgentPreset({
      header: { agentPreset: 'standard' },
      events: [{ type: 'turn/start' }, { type: 'agent-preset/selected', data: { agentPreset: 'acp' } }],
    })).toBe('acp')
    // A malformed event must not shadow the header with garbage.
    expect(sessionAgentPreset({
      header: { agentPreset: 'standard' },
      events: [{ type: 'agent-preset/selected', data: {} }],
    })).toBeUndefined()
  })

  it('reads the ACP-mode preset status out of the harness roster', () => {
    // Unreadable roster (no `agentPresets` service): no verdict at all, which
    // hides the panel block instead of claiming the preset is gone.
    expect(acpPresetStatusFromRoster(undefined, 'acp')).toBeUndefined()

    // A readable roster WITHOUT the row: the declaration was not composed.
    expect(acpPresetStatusFromRoster([{ id: 'standard' }], 'acp')).toMatchObject({
      id: 'acp',
      source: ACP_PRESET_SOURCE,
      installed: false,
    })
    expect(acpPresetStatusFromRoster([{ id: 'standard' }], 'acp')?.problem).toMatch(/roster/)

    // A row that cannot compose a session carries the harness's own diagnostic.
    expect(acpPresetStatusFromRoster([{ id: 'acp', broken: 'acp-guard: cannot find module' }], 'acp')).toEqual({
      id: 'acp',
      source: ACP_PRESET_SOURCE,
      installed: false,
      problem: 'acp-guard: cannot find module',
    })
    // An empty/garbage `broken` is the harness's way of saying "finite": the
    // registry omits the field on a healthy row, so neither may read as broken.
    expect(acpPresetStatusFromRoster([{ id: 'acp', broken: '' }], 'acp')).toEqual({
      id: 'acp',
      source: ACP_PRESET_SOURCE,
      installed: true,
    })
    expect(acpPresetStatusFromRoster([{ id: 'acp' }], 'acp')?.installed).toBe(true)
  })

  it('folds a preset from a RAW stored log (the cold-read path)', () => {
    // `sessionPersistence` hands back the header verbatim and a read handle
    // returns raw event objects — neither is a host `Session`, so the fold is
    // spelled on its own inputs.
    expect(sessionAgentPresetFromLog('standard', [])).toBe('standard')
    expect(sessionAgentPresetFromLog(undefined, [
      { type: 'sandbox/mode', data: { mode: 'ask' } },
      { type: 'agent-preset/selected', data: { agentPreset: 'acp' } },
    ])).toBe('acp')
    // Newest selection wins over an older one and over the header.
    expect(sessionAgentPresetFromLog('standard', [
      { type: 'agent-preset/selected', data: { agentPreset: 'acp' } },
      { type: 'agent-preset/selected', data: { agentPreset: 'minimal' } },
    ])).toBe('minimal')
    expect(sessionAgentPresetFromLog(7, [{ type: 'turn/start' }])).toBeUndefined()
  })

  it('reads the ACP tool-call shape defensively', () => {
    expect(permissionToolKind({ kind: 'edit' })).toBe('edit')
    expect(permissionToolKind({ kind: '' })).toBeUndefined()
    expect(permissionToolKind({})).toBeUndefined()
    expect(permissionToolKind(null)).toBeUndefined()
    expect(permissionToolPaths({ locations: [{ path: '/a' }, { path: '' }, {}, 'x'] })).toEqual(['/a'])
    expect(permissionToolPaths({})).toEqual([])
  })

  it('compares containment lexically and conservatively', () => {
    expect(isUnderPath('/srv/ws/a.ts', '/srv/ws/')).toBe(true)
    expect(isUnderPath('/srv/ws', '/srv/ws')).toBe(true)
    expect(isUnderPath('/srv/wsx/a.ts', '/srv/ws')).toBe(false)
    expect(isUnderPath('/anything', '/')).toBe(true)
    expect(isUnderPath('/srv', 'relative/path')).toBe(false)
  })

  it('folds the session approval policy over the configured default', () => {
    expect(dshApprovalPolicyOf({ events: [{ type: 'approval/policy', data: { policy: 'never' } }] }, 'ask')).toBe('never')
    expect(dshApprovalPolicyOf({ events: [{ type: 'approval/policy', data: { policy: 'ask' } }] }, 'never')).toBe('ask')
    // The LAST switch wins, exactly like the host's own fold.
    expect(dshApprovalPolicyOf({
      events: [
        { type: 'approval/policy', data: { policy: 'never' } },
        { type: 'sandbox/mode', data: { mode: 'read-only' } },
        { type: 'approval/policy', data: { policy: 'ask' } },
      ],
    }, 'never')).toBe('ask')
    expect(dshApprovalPolicyOf({ events: [] }, 'never')).toBe('never')
    expect(dshApprovalPolicyOf(undefined, undefined)).toBe('ask')
    expect(dshApprovalPolicyOf({ events: [{ type: 'approval/policy', data: {} }] }, 'never')).toBe('ask')
    expect(dshApprovalPolicyOf({}, 'unexpected')).toBe('ask')
  })

  it('refuses a mode outside the vocabulary instead of guessing a boundary', () => {
    expect(dshSessionPolicyOf({ mode: 'sandboxed', workspaceRoot: '/x' }, undefined, 'ask')).toBeUndefined()
    expect(dshSessionPolicyOf({}, undefined, 'ask')).toBeUndefined()
    expect(dshSessionPolicyOf({ mode: null }, undefined, 'ask')).toBeUndefined()
  })

  it('assembles the snapshot and drops an unusable workspace root', () => {
    expect(dshSessionPolicyOf({ mode: 'read-only', workspaceRoot: '/srv/ws' }, { events: [] }, 'ask')).toEqual({
      mode: 'read-only',
      approval: 'ask',
      workspaceRoot: '/srv/ws',
    })
    expect(dshSessionPolicyOf({ mode: 'danger-full-access' }, { events: [] }, 'never')).toEqual({
      mode: 'danger-full-access',
      approval: 'never',
    })
    expect(dshSessionPolicyOf({ mode: 'workspace-write', workspaceRoot: '' }, undefined, 'ask')).toEqual({
      mode: 'workspace-write',
      approval: 'ask',
    })
  })

  it('carries the host denial dialect', () => {
    expect(sandboxDenialMarker('read-only')).toBe('[sandbox: file access denied under read-only mode]')
    expect(sandboxDenialMarker('workspace-write')).toBe('[sandbox: file access denied under workspace-write mode]')
  })

  it('canonicalizes without containment for the unrestricted mode', () => {
    const realpath = (p: string): string => p
    expect(canonicalizeFsPath('/srv/ws', '/etc/hosts', realpath)).toBe('/etc/hosts')
    expect(canonicalizeFsPath('/srv/ws', 'sub/../a.txt', realpath)).toBe('/srv/ws/a.txt')
    expect(() => canonicalizeFsPath('/srv/ws', '', realpath)).toThrow(AcpError)
    // The containment variant still refuses what it always refused.
    expect(() => resolveFsPath('/srv/ws', ['/srv/ws'], '/etc/hosts', realpath)).toThrow(AcpError)
    expect(resolveFsPath('/srv/ws', ['/srv/ws'], 'a.txt', realpath)).toBe('/srv/ws/a.txt')
  })
})

/**
 * The deployment default model is global to every mode, so an ACP route landing
 * in it leaks the agent into ordinary conversations. These cases pin the guard's
 * candidate order and its refusal to invent a value.
 */
describe('AcpDefaultModelGuard', () => {
  const native: ModelRouteSelection = { provider: 'tokitoken', model: 'deepseek-v4.1-flash' }
  const acpRoute: ModelRouteSelection = { provider: 'acp', model: 'codebuddy@hy3', reasoningEffort: 'enabled' }

  function guard(initial: ModelRouteSelection | undefined, extra: Partial<DefaultModelPorts> = {}): {
    guard: AcpDefaultModelGuard
    writes: ModelRouteSelection[]
    set: (next: ModelRouteSelection | undefined) => void
  } {
    let current = initial
    const writes: ModelRouteSelection[] = []
    return {
      writes,
      set: next => { current = next },
      guard: new AcpDefaultModelGuard({
        read: () => current,
        write: async next => { writes.push(next); current = next },
        ...extra,
      }),
    }
  }

  it('learns a native default and puts it back when the default becomes an ACP route', async () => {
    const { guard: g, writes, set } = guard(native)
    expect(await g.reconcile()).toEqual({ selection: native, restored: false, stranded: false })
    expect(g.remembered).toEqual(native)
    // The ACP pick (DSH's `selectModel` wrote it) is repaired.…
    set(acpRoute)
    expect(await g.reconcile()).toEqual({ selection: native, restored: true, stranded: false })
    expect(writes).toEqual([native])
  })

  it('learns a route the caller saw BEFORE its own ACP write (the exact pre-write value)', async () => {
    // A default already poisoned by an older build: the only native value in
    // sight is the session's own pre-write route, which outranks the fallback.
    const { guard: g, writes } = guard(acpRoute, { fallback: () => ({ provider: 'mimo', model: 'mimo-v2.6-pro' }) })
    expect(await g.reconcile(native)).toEqual({ selection: native, restored: true, stranded: false })
    expect(writes).toEqual([native])
  })

  it('falls back to the deployment\'s own last native route, and never to another ACP one', async () => {
    const poisoned = guard(acpRoute, { fallback: () => ({ provider: 'mimo', model: 'mimo-v2.6-pro' }) })
    expect(await poisoned.guard.reconcile()).toMatchObject({ restored: true, selection: { provider: 'mimo' } })
    // A fallback that is itself an ACP route is not a candidate.
    const acpFallback = guard(acpRoute, { fallback: () => acpRoute })
    expect(await acpFallback.guard.reconcile()).toEqual({ selection: acpRoute, restored: false, stranded: true })
  })

  it('stays stranded — and silent — when no native candidate exists', async () => {
    const { guard: g, writes } = guard(acpRoute)
    expect(await g.reconcile()).toEqual({ selection: acpRoute, restored: false, stranded: true })
    expect(writes).toEqual([])
  })

  it('never lets a malformed or non-native value become the remembered default', async () => {
    const { guard: g } = guard(native)
    await g.reconcile()
    g.noteNative({ provider: 'acp', model: 'pi' })
    g.noteNative({ provider: '', model: 'x' })
    g.noteNative(undefined)
    expect(g.remembered).toEqual(native)
  })

  it('is inert when the service cannot answer, and reports why a repair failed', async () => {
    const throwing = new AcpDefaultModelGuard({ read: () => { throw new Error('no service') }, write: async () => {} })
    expect(await throwing.reconcile(native)).toEqual({ restored: false, stranded: false })
    const unwritable = new AcpDefaultModelGuard({
      read: () => acpRoute,
      write: async () => { throw new Error('read-only profile') },
    })
    unwritable.noteNative(native)
    expect(await unwritable.reconcile()).toEqual({ selection: acpRoute, restored: false, stranded: true })
    // An empty answer is not a selection either.
    const empty = new AcpDefaultModelGuard({ read: () => ({ provider: '  ', model: '' }), write: async () => {} })
    expect(await empty.reconcile()).toEqual({ restored: false, stranded: false })
  })
})

describe('lastNativeRoute', () => {
  it('picks the freshest non-ACP route among live sessions', () => {
    expect(lastNativeRoute([
      { requestHeader: () => ({ config: { provider: 'mimo', model: 'mimo-v2.6-pro' } }), events: [{ type: 'turn/end', time: 100 }] },
      { requestHeader: () => ({ config: { provider: 'acp', model: 'codebuddy@hy3' } }), events: [{ type: 'turn/end', time: 500 }] },
      { requestHeader: () => ({ config: { provider: 'tokitoken', model: 'step-5-preview', reasoningEffort: 'high' } }), events: [{ type: 'turn/end', time: 300 }] },
    ])).toEqual({ provider: 'tokitoken', model: 'step-5-preview', reasoningEffort: 'high' })
  })

  it('skips sessions with no request, an ACP route, or an unreadable header', () => {
    expect(lastNativeRoute([
      {},
      { events: [{ type: 'turn/end', time: 900 }] },
      { requestHeader: () => ({ config: { provider: 'acp', model: 'pi' } }), events: [{ type: 'turn/end', time: 800 }] },
      { requestHeader: () => { throw new Error('cold session') } },
      { requestHeader: () => ({ config: { provider: 'tokitoken', model: '' } }) },
    ])).toBeUndefined()
    expect(lastNativeRoute(undefined)).toBeUndefined()
    expect(lastNativeRoute([])).toBeUndefined()
  })
})
