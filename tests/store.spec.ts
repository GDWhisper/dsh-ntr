import { describe, expect, it } from 'vitest'
import { foldUpdate, type Block } from '../src/client/store.ts'

function fold(...updates: Array<Record<string, unknown>>): Block[] {
  const blocks: Block[] = []
  for (const update of updates) foldUpdate(blocks, update)
  return blocks
}

describe('foldUpdate', () => {
  it('merges same-messageId agent chunks and starts a new block on a new id', () => {
    const blocks = fold(
      { sessionUpdate: 'agent_message_chunk', messageId: 'm1', content: { type: 'text', text: 'Hello ' } },
      { sessionUpdate: 'agent_message_chunk', messageId: 'm1', content: { type: 'text', text: 'world' } },
      { sessionUpdate: 'agent_message_chunk', messageId: 'm2', content: { type: 'text', text: 'next' } },
    )
    expect(blocks).toEqual([
      { kind: 'agent', messageId: 'm1', text: 'Hello world' },
      { kind: 'agent', messageId: 'm2', text: 'next' },
    ])
  })

  it('merges message-less chunks into the previous same-kind block', () => {
    const blocks = fold(
      { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'a' } },
      { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'b' } },
      { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'think' } },
    )
    expect(blocks.map(b => b.kind)).toEqual(['user', 'thought'])
    expect(blocks[0]).toMatchObject({ text: 'ab' })
  })

  it('renders non-text content as a placeholder', () => {
    const blocks = fold({ sessionUpdate: 'agent_message_chunk', content: { type: 'image', data: 'x', mimeType: 'image/png' } })
    expect(blocks[0]).toMatchObject({ kind: 'agent', text: '[image]' })
  })

  it('creates and merges tool cards by toolCallId, including content lines', () => {
    const blocks = fold(
      { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'run', kind: 'execute', status: 'pending' },
      { sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'in_progress' },
      { sessionUpdate: 'tool_call_update', toolCallId: 't1', title: 'run ls', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: 'file1\nfile2' } }] },
    )
    expect(blocks).toHaveLength(1)
    expect(blocks[0]).toEqual({ kind: 'tool', toolCallId: 't1', title: 'run ls', status: 'completed', toolKind: 'execute', lines: ['file1\nfile2'] })
  })

  it('materializes an update-only tool card when the original rolled out of the window', () => {
    const blocks = fold({ sessionUpdate: 'tool_call_update', toolCallId: 'ghost', status: 'completed' })
    expect(blocks[0]).toMatchObject({ kind: 'tool', toolCallId: 'ghost', status: 'completed' })
  })

  it('replaces the plan in place', () => {
    const blocks = fold(
      { sessionUpdate: 'plan', entries: [{ content: 'a', status: 'pending' }] },
      { sessionUpdate: 'plan', entries: [{ content: 'a', status: 'completed' }] },
    )
    expect(blocks).toHaveLength(1)
    expect(blocks[0]).toMatchObject({ kind: 'plan', entries: [{ content: 'a', status: 'completed' }] })
  })

  it('ignores meta updates that ride on the session snapshot', () => {
    expect(fold({ sessionUpdate: 'usage_update', used: 1, size: 2 })).toEqual([])
    expect(fold({ sessionUpdate: 'current_mode_update', currentModeId: 'x' })).toEqual([])
  })
})

describe('AcpStore agent management', () => {
  it('detectAgents queries endpoint and updates state', async () => {
    const rpcCalls: Array<{ channel: string; endpoint: string; payload: unknown }> = []
    const store = new (await import('../src/client/store.ts')).AcpStore(
      async (channel, endpoint, payload) => {
        rpcCalls.push({ channel, endpoint, payload })
        if (endpoint === 'agents/detect') {
          return { ok: true, value: { agents: [{ id: 'pi', name: 'Pi Agent', detected: true, defaultCommand: 'pi-acp', defaultArgs: [] }] } }
        }
        return { ok: true, value: {} }
      },
      (zh) => zh,
    )

    await store.detectAgents()
    const state = store.getSnapshot()
    expect(state.detectedAgents).toHaveLength(1)
    expect(state.detectedAgents[0].id).toBe('pi')
    expect(state.detecting).toBe(false)
  })

  it('saveAgent and deleteAgent trigger RPC calls and resync', async () => {
    const endpoints: string[] = []
    const store = new (await import('../src/client/store.ts')).AcpStore(
      async (channel, endpoint, payload) => {
        endpoints.push(endpoint)
        if (endpoint === 'agents/list') return { ok: true, value: { agents: [] } }
        if (endpoint === 'sessions/list') return { ok: true, value: { sessions: [] } }
        if (endpoint === 'agents/detect') return { ok: true, value: { agents: [] } }
        return { ok: true, value: { done: true } }
      },
      (zh) => zh,
    )

    await store.saveAgent({ id: 'pi', command: 'pi-acp', args: [] })
    expect(endpoints).toContain('agent/save')
    expect(endpoints).toContain('agents/list')

    await store.deleteAgent('pi')
    expect(endpoints).toContain('agent/delete')
  })
})
