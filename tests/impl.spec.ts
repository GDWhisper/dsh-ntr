import { describe, expect, it } from 'vitest'
import {
  AcpError,
  EventHub,
  PermissionLedger,
  Transcript,
  childEnv,
  dispatchRpc,
  resolveSessionCwd,
  validateAgentDef,
  validateConfig,
} from '../src/impl.ts'
import type { AcpManager } from '../src/impl.ts'
import type { AcpAgentDef } from '../src/protocol.ts'

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
