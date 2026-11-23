/**
 * Shared fakes for the `src/impl/` mirror: an agent definition factory and the
 * `AcpManager` stand-in that records calls. Both are plain objects, so a test
 * file can assert on the calls a dispatch made without a subprocess.
 */

import type { AcpAgentDef } from '../../src/protocol.ts'
import type { AcpManager } from '../../src/impl.ts'

export function agentDef(overrides: Partial<AcpAgentDef> = {}): AcpAgentDef {
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

export function fakeManager(): AcpManager & { calls: Array<[string, unknown]> } {
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
    respondElicitation: (r, o) => { calls.push(['elicit', { r, o }]) },
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

