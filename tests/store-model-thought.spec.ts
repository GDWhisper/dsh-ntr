import { describe, expect, it } from 'vitest'
import { AcpStore } from '../src/client/store.ts'
import type { AgentCatalogResult, ChatSessionView } from '../src/protocol.ts'
import { describeRoute } from '../src/client/session-controls.tsx'

/**
 * The optimistic half of the model switch: the browser already holds the
 * agent's per-model thought records, so it must drop a level the new model
 * does not declare before the host's answer arrives — and keep one it does.
 * The host stays the authority; these cases pin that the two agree.
 */
function makeStore(catalog: AgentCatalogResult, sessions: ChatSessionView[] = []) {
  const calls: Array<{ endpoint: string; payload: unknown }> = []
  const store = new AcpStore(async (_channel, endpoint, payload) => {
    calls.push({ endpoint, payload })
    if (endpoint === 'agent/catalog') return { ok: true, value: catalog }
    if (endpoint === 'session/chat-list') return { ok: true, value: { sessions, acpMode: true } }
    return { ok: true, value: {} }
  }, zh => zh)
  return { store, calls }
}

const catalog: AgentCatalogResult = {
  agentId: 'codebuddy',
  title: 'CodeBuddy',
  base: { id: 'codebuddy', name: 'CodeBuddy' },
  variants: [
    { id: 'codebuddy@plain', name: 'Plain' },
    { id: 'codebuddy@full', name: 'Full' },
  ],
  reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }], defaultEffort: 'high' },
  currentModel: { value: 'base', name: 'Base' },
  reasoningByModel: {
    base: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }] },
    plain: { efforts: [] },
    full: { efforts: [{ id: 'max', name: 'Max' }] },
  },
  probed: true,
}

describe('the optimistic model switch and its thought level', () => {
  it('drops a pre-first-turn effort the new model does not declare, without inventing a notice', async () => {
    const { store } = makeStore(catalog)
    await store.loadAgentCatalog('codebuddy')
    await store.setChatSessionEffort('chat-1', 'high', 'codebuddy')
    expect(store.getSnapshot().chatChoice['chat-1']).toMatchObject({ effort: 'high' })

    // No live session: `plain` was observed without a level axis, so the pick
    // cannot survive. The host broadcasts the one notice; the browser must not
    // fabricate a second one.
    await store.setChatSessionModel('chat-1', 'codebuddy@plain', 'codebuddy')
    expect(store.getSnapshot().chatChoice['chat-1']).toEqual({ agentId: 'codebuddy', modelId: 'codebuddy@plain' })
    expect(store.getSnapshot().logs).toEqual([])
    expect(store.getSnapshot().notice).toBeUndefined()
  })

  it('keeps an effort the new model declares', async () => {
    const { store } = makeStore(catalog)
    await store.loadAgentCatalog('codebuddy')
    await store.setChatSessionEffort('chat-2', 'max', 'codebuddy')
    await store.setChatSessionModel('chat-2', 'codebuddy@full', 'codebuddy')
    expect(store.getSnapshot().chatChoice['chat-2']).toEqual({
      agentId: 'codebuddy',
      modelId: 'codebuddy@full',
      effort: 'max',
    })
  })

  it('leaves a live session’s level to the host, which re-reads the agent’s own options', async () => {
    const live: ChatSessionView = { agentId: 'codebuddy', sessionId: 's1', modelId: 'codebuddy@base', reasoningEffort: 'high' }
    const { store } = makeStore(catalog, [live])
    await store.loadChatSessions('chat-3')
    await store.setChatSessionEffort('chat-3', 'high', 'codebuddy')
    await store.setChatSessionModel('chat-3', 'codebuddy@plain', 'codebuddy')
    // `plain`'s catalog record says "no axis", but a live session answers with
    // the agent's current option set — the host decides, so the pick stays.
    expect(store.getSnapshot().chatChoice['chat-3']).toMatchObject({ modelId: 'codebuddy@plain', effort: 'high' })
    expect(store.getSnapshot().chatSessions[0]?.reasoningEffort).toBe('high')
  })
})

describe('a model the catalog has never seen', () => {
  it('clears the optimistic effort and leaves the card in its unknown state', async () => {
    const { store } = makeStore(catalog)
    await store.loadAgentCatalog('codebuddy')
    await store.setChatSessionEffort('chat-never', 'high', 'codebuddy')
    await store.setChatSessionModel('chat-never', 'codebuddy@never-seen', 'codebuddy')

    // Same conservative answer the host gives: no record means "not proven to
    // offer this level", so the pick cannot keep naming it.
    expect(store.getSnapshot().chatChoice['chat-never']).toEqual({ agentId: 'codebuddy', modelId: 'codebuddy@never-seen' })
    // A model switch is not an error: nothing is logged and no banner appears.
    expect(store.getSnapshot().logs).toEqual([])
    expect(store.getSnapshot().notice).toBeUndefined()

    // ...and the composer's thought card knows what to fetch.
    const route = describeRoute(
      [{ id: 'codebuddy', title: 'CodeBuddy', command: 'codebuddy', args: [], allowedCwdRoots: [], state: 'ready', liveSessions: [] }],
      undefined,
      undefined,
      catalog,
      'codebuddy',
      store.getSnapshot().chatChoice['chat-never'],
    )
    expect(route.efforts).toEqual([])
    expect(route.thoughtUnknown).toBe('never-seen')
  })
})
