import { describe, expect, it } from 'vitest'
import {
  AcpError,
  EventHub,
  PermissionLedger,
  Transcript,
  buildAdapterModelId,
  childEnv,
  dispatchRpc,
  parseCatalogOptions,
  resolveFsPath,
  resolveSessionCwd,
  splitAdapterModelId,
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
    expect(() => validateConfig({ agents: [], startupTimeoutMs: 500 })).toThrow(/startupTimeoutMs/)
    expect(() => validateConfig({ agents: [], permissionTimeoutMs: -1 })).toThrow(/permissionTimeoutMs/)
    expect(() => validateConfig({ agents: [], cancelFallbackMs: 601_000 })).toThrow(/cancelFallbackMs/)
    expect(validateConfig({ agents: [], permissionTimeoutMs: 60_000, cancelFallbackMs: 0 }).cancelFallbackMs).toBe(0)
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
    getDefaultModel: async () => ({ provider: 'acp', model: 'mock' }),
    setDefaultModel: async id => { calls.push(['setDefaultModel', id]) },
    setPermission: async (id, p) => { calls.push(['setPermission', { id, p }]) },
    detectAgents: async () => { calls.push(['detect', undefined]); return [] },
    saveAgent: async def => { calls.push(['save', def]) },
    deleteAgent: async id => { calls.push(['delete', id]) },
    setExposedModels: async (id, exposed) => { calls.push(['setExposedModels', { id, exposed }]) },
    probeAgentModels: async agentId => {
      calls.push(['probe', agentId])
      return { agentId, catalog: { model: { configId: 'model', name: 'Model', currentValue: 'a', choices: [{ value: 'a', name: 'A' }] } }, updatedAt: 1 }
    },
  }
}

describe('dispatchRpc', () => {
  it('routes endpoints and normalizes errors into the Connection result shape', async () => {
    const manager = fakeManager()
    await expect(dispatchRpc(manager, 'agents/list', {})).resolves.toEqual({ ok: true, value: { agents: [] } })
    await expect(dispatchRpc(manager, 'agents/detect', {})).resolves.toEqual({ ok: true, value: { agents: [] } })
    expect(manager.calls).toContainEqual(['detect', undefined])
    await expect(dispatchRpc(manager, 'agent/save', { id: 'pi', command: 'pi-acp' })).resolves.toEqual({ ok: true, value: { done: true } })
    expect(manager.calls).toContainEqual(['save', expect.objectContaining({ id: 'pi', command: 'pi-acp' })])
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
    await expect(dispatchRpc(manager, 'model/get-default', {})).resolves.toEqual({ ok: true, value: { provider: 'acp', model: 'mock' } })
    await expect(dispatchRpc(manager, 'model/set-default', { agentId: 'custom' })).resolves.toEqual({ ok: true, value: { done: true } })
    expect(manager.calls).toContainEqual(['setDefaultModel', 'custom'])
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
    await expect(dispatchRpc(manager, 'agent/set-exposed-models', { agentId: 'pi', exposedModels: ['a', 'b'] })).resolves.toEqual({ ok: true, value: { done: true } })
    expect(manager.calls).toContainEqual(['setExposedModels', { id: 'pi', exposed: ['a', 'b'] }])
    await expect(dispatchRpc(manager, 'agent/set-exposed-models', { agentId: 'pi' })).resolves.toEqual({ ok: true, value: { done: true } })
    expect(manager.calls).toContainEqual(['setExposedModels', { id: 'pi', exposed: undefined }])
    await expect(dispatchRpc(manager, 'agent/set-exposed-models', { agentId: 'pi', exposedModels: ['ok', ''] })).resolves.toMatchObject({ ok: false, error: { code: 'bad_payload' } })
    await expect(dispatchRpc(manager, 'agent/set-exposed-models', { agentId: 'pi', exposedModels: 'a' })).resolves.toMatchObject({ ok: false, error: { code: 'bad_payload' } })
    await expect(dispatchRpc(manager, 'agent/set-exposed-models', {})).resolves.toMatchObject({ ok: false, error: { code: 'bad_payload' } })
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
