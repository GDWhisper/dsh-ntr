import { describe, expect, it, vi } from 'vitest'
import { AcpStore, foldUpdate, permissionsForSession, type Block } from '../src/client/store.ts'
import { acpModeFromPresetEvent, stagedIsAcpMode } from '../src/client/acp-ui.tsx'
import type { AcpAgentDef, ChatSessionView, DetectedAgentInfo } from '../src/protocol.ts'

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

  it('replaces blocks immutably: appended chunks swap the tail object, untouched rows keep their identity', () => {
    // The ACP view memoizes rows on the block object; a mutated tail would
    // look unchanged to React and the streamed text would never re-render.
    const blocks: Block[] = []
    foldUpdate(blocks, { sessionUpdate: 'agent_message_chunk', messageId: 'm1', content: { type: 'text', text: 'one' } })
    const firstRef = blocks[0]
    foldUpdate(blocks, { sessionUpdate: 'agent_message_chunk', messageId: 'm1', content: { type: 'text', text: ' two' } })
    expect(blocks[0]).not.toBe(firstRef)
    expect(blocks[0]).toMatchObject({ text: 'one two' })
    foldUpdate(blocks, { sessionUpdate: 'agent_message_chunk', messageId: 'm2', content: { type: 'text', text: 'next' } })
    expect(blocks[0]).toBe(blocks[0]) // the untouched earlier row keeps its identity
    expect(blocks[0]).toMatchObject({ text: 'one two' })
  })

  it('answers whether anything changed, and keeps raw lazy until a view reads it', () => {
    // Usage ticks fold to `false`: the batch then skips copying the blocks
    // array entirely (the coalescing flush keys off this return value).
    const blocks: Block[] = []
    expect(foldUpdate(blocks, { sessionUpdate: 'usage_update', used: 1, size: 2 })).toBe(false)
    expect(foldUpdate(blocks, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hi' } })).toBe(true)
    expect(foldUpdate(blocks, { sessionUpdate: 'config_option_update', configOptions: [] })).toBe(false)

    // `raw` is a lazy getter: folding a tool card costs no JSON, and reading
    // it once caches the pretty-print for the view's later renders.
    const toolBlocks: Block[] = []
    foldUpdate(toolBlocks, { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Bash', rawInput: '{"cmd":"ls"}' })
    const card = toolBlocks[0] as Extract<Block, { kind: 'tool' }>
    const raw = card.raw
    expect(raw).toContain('"toolCallId": "t1"')
    expect(card.raw).toBe(raw)
  })

  it('keeps a non-text chunk as its payload instead of a placeholder', () => {
    const blocks = fold({ sessionUpdate: 'agent_message_chunk', content: { type: 'image', data: 'x', mimeType: 'image/png' } })
    expect(blocks[0]).toMatchObject({ kind: 'agent' })
    expect((blocks[0] as { text: string }).text).toContain('image/png')
  })

  it('reads a chunk whose content is an object or an array of blocks', () => {
    const blocks = fold(
      { sessionUpdate: 'agent_thought_chunk', content: { text: 'nested' } },
      { sessionUpdate: 'agent_message_chunk', content: 'plain string' },
      { sessionUpdate: 'agent_message_chunk', messageId: 'm', content: [{ text: 'a' }, { text: 'b' }] },
    )
    expect(blocks.map(block => (block as { text: string }).text)).toEqual(['nested', 'plain string', 'ab'])
  })

  it('creates and merges tool cards by toolCallId, including content lines and arguments', () => {
    const blocks = fold(
      { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'run', kind: 'execute', status: 'pending', rawInput: '{"cmd":"ls"}' },
      { sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'in_progress' },
      { sessionUpdate: 'tool_call_update', toolCallId: 't1', title: 'run ls', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: 'file1\nfile2' } }] },
    )
    expect(blocks).toHaveLength(1)
    expect(blocks[0]).toMatchObject({
      kind: 'tool',
      toolCallId: 't1',
      title: 'run ls',
      status: 'completed',
      toolKind: 'execute',
      lines: ['file1\nfile2'],
      input: '{"cmd":"ls"}',
    })
  })

  it('keeps diffs as text AND as a diff, and an unknown content kind as its JSON', () => {
    const blocks = fold({
      sessionUpdate: 'tool_call',
      toolCallId: 't2',
      title: 'edit',
      content: [
        { type: 'diff', path: '/w/a.ts', oldText: 'one\ntwo\n', newText: 'one\nTWO\n' },
        { type: 'terminal', terminalId: 'term-7' },
      ],
    })
    const card = blocks[0] as Extract<Block, { kind: 'tool' }>
    expect(card.diffs).toEqual([{ path: '/w/a.ts', oldText: 'one\ntwo\n', newText: 'one\nTWO\n' }])
    expect(card.lines.join('\n')).toContain('- two')
    expect(card.lines.join('\n')).toContain('+ TWO')
    expect((card.extras ?? []).join('\n')).toContain('term-7')
    expect(card.raw).toContain('term-7')
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

  it('records a notification it has no card for as an event, and skips state-only frames', () => {
    expect(fold({ sessionUpdate: 'usage_update', used: 1, size: 2 })).toEqual([])
    expect(fold({ sessionUpdate: 'config_option_update', configOptions: [] })).toEqual([])
    const events = fold(
      { sessionUpdate: 'current_mode_update', currentModeId: 'plan' },
      { sessionUpdate: 'something_new', payload: { deep: true } },
    )
    expect(events[0]).toMatchObject({ kind: 'event', event: 'current_mode_update', text: 'plan' })
    expect((events[1] as { raw: string }).raw).toContain('"deep"')
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
    expect(state.detectSummary).toBe('已检测 1 个预设：1 个已安装，其余可从「添加智能体」启用。')
  })

  it('detectAgents reports the fallback preset list as the summary when the host detects nothing', async () => {
    const store = new (await import('../src/client/store.ts')).AcpStore(
      async (_channel, endpoint) => {
        if (endpoint === 'agents/detect') return { ok: true, value: { agents: [] } }
        return { ok: true, value: {} }
      },
      (zh) => zh,
    )
    await store.detectAgents()
    const state = store.getSnapshot()
    expect(state.detectedAgents.length).toBeGreaterThan(0)
    expect(state.detectSummary).toContain('个预设')
  })

  it('clears the previous detect summary when a re-detect fails', async () => {
    let failing = false
    const store = new (await import('../src/client/store.ts')).AcpStore(
      async (_channel, endpoint) => {
        if (endpoint === 'agents/detect') {
          if (failing) return { ok: false, error: { code: 'internal', message: 'host offline' } }
          return { ok: true, value: { agents: [{ id: 'pi', name: 'Pi Agent', detected: true, defaultCommand: 'pi-acp', defaultArgs: [] }] } }
        }
        return { ok: true, value: {} }
      },
      (zh) => zh,
    )
    await store.detectAgents()
    expect(store.getSnapshot().detectSummary).toContain('个预设')
    failing = true
    await store.detectAgents()
    const state = store.getSnapshot()
    // The stale success line must not sit next to the failure notice.
    expect(state.detectSummary).toBeUndefined()
    expect(state.detecting).toBe(false)
    expect(state.notice).toBe('host offline')
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

  it('reads the ACP-mode preset state from the harness roster on resync', async () => {
    const endpoints: string[] = []
    const store = new (await import('../src/client/store.ts')).AcpStore(
      async (_channel, endpoint) => {
        endpoints.push(endpoint)
        if (endpoint === 'agents/list') return { ok: true, value: { agents: [] } }
        if (endpoint === 'sessions/list') return { ok: true, value: { sessions: [] } }
        if (endpoint === 'agents/detect') return { ok: true, value: { agents: [] } }
        if (endpoint === 'preset/status') {
          return {
            ok: true,
            value: {
              preset: {
                id: 'acp',
                source: 'dsh-ntr/presets/acp/acp.patch.yml',
                installed: false,
                problem: 'acp-guard: cannot find module',
              },
            },
          }
        }
        return { ok: true, value: {} }
      },
      (zh) => zh,
    )

    await store.resync()
    expect(endpoints).toContain('preset/status')
    // The failure mode this card exists for: the declaration is in place but
    // the harness could not activate it, and the diagnostic travels to the UI.
    expect(store.getSnapshot().preset).toMatchObject({ installed: false, problem: 'acp-guard: cannot find module' })
  })

  it('hides the preset block when the host serves no roster', async () => {
    const store = new (await import('../src/client/store.ts')).AcpStore(
      async (_channel, endpoint) => {
        if (endpoint === 'agents/list') return { ok: true, value: { agents: [] } }
        if (endpoint === 'sessions/list') return { ok: true, value: { sessions: [] } }
        if (endpoint === 'agents/detect') return { ok: true, value: { agents: [] } }
        // Either shape means "this host cannot report a roster": an endpoint it
        // does not serve, or one that answers `null` (no `agentPresets` service).
        if (endpoint === 'preset/status') return { ok: true, value: { preset: null } }
        return { ok: true, value: {} }
      },
      (zh) => zh,
    )
    await store.resync()
    expect(store.getSnapshot().preset).toBeUndefined()

    const older = new (await import('../src/client/store.ts')).AcpStore(
      async (_channel, endpoint) => {
        if (endpoint === 'agents/list') return { ok: true, value: { agents: [] } }
        if (endpoint === 'sessions/list') return { ok: true, value: { sessions: [] } }
        if (endpoint === 'agents/detect') return { ok: true, value: { agents: [] } }
        if (endpoint === 'preset/status') return { ok: false, error: { code: 'unknown_endpoint', message: 'acp: unknown endpoint' } }
        return { ok: true, value: {} }
      },
      (zh) => zh,
    )
    await older.resync()
    expect(older.getSnapshot().preset).toBeUndefined()
  })

  it('reads the host version on resync and hides it on a host without the endpoint', async () => {
    const store = new (await import('../src/client/store.ts')).AcpStore(
      async (_channel, endpoint) => {
        if (endpoint === 'agents/list') return { ok: true, value: { agents: [] } }
        if (endpoint === 'sessions/list') return { ok: true, value: { sessions: [] } }
        if (endpoint === 'agents/detect') return { ok: true, value: { agents: [] } }
        if (endpoint === 'plugin/version') return { ok: true, value: { version: '1.2.3' } }
        return { ok: true, value: {} }
      },
      (zh) => zh,
    )
    await store.resync()
    expect(store.getSnapshot().pluginVersion).toBe('1.2.3')

    // An older host half answers `unknown endpoint`; the badge stays hidden.
    const older = new (await import('../src/client/store.ts')).AcpStore(
      async (_channel, endpoint) => {
        if (endpoint === 'agents/list') return { ok: true, value: { agents: [] } }
        if (endpoint === 'sessions/list') return { ok: true, value: { sessions: [] } }
        if (endpoint === 'agents/detect') return { ok: true, value: { agents: [] } }
        if (endpoint === 'plugin/version') return { ok: false, error: { code: 'unknown_endpoint', message: 'acp: unknown endpoint' } }
        return { ok: true, value: {} }
      },
      (zh) => zh,
    )
    await older.resync()
    expect(older.getSnapshot().pluginVersion).toBeUndefined()
  })

  it('reads the tag halo on resync and writes it back optimistically', async () => {
    const store = new (await import('../src/client/store.ts')).AcpStore(
      async (_channel, endpoint) => {
        if (endpoint === 'agents/list') return { ok: true, value: { agents: [] } }
        if (endpoint === 'sessions/list') return { ok: true, value: { sessions: [] } }
        if (endpoint === 'agents/detect') return { ok: true, value: { agents: [] } }
        if (endpoint === 'ui/tag-halo') return { ok: true, value: { halo: { mode: 'steady', speed: 'slow' } } }
        return { ok: true, value: {} }
      },
      (zh) => zh,
    )
    // The host answer is the authority; the initial local default gives way.
    await store.resync()
    expect(store.getSnapshot().tagHalo).toEqual({ mode: 'steady', speed: 'slow' })

    // The write lands optimistically (the tag's look changes with the click)
    // and the RPC carries the full halo object.
    await store.setTagHalo({ mode: 'breath', speed: 'fast' })
    expect(store.getSnapshot().tagHalo).toEqual({ mode: 'breath', speed: 'fast' })

    // A failed write reverts to the previous setting instead of leaving the
    // tag looking like something the host refused.
    const failing = new (await import('../src/client/store.ts')).AcpStore(
      async (_channel, endpoint) => {
        if (endpoint === 'agents/list') return { ok: true, value: { agents: [] } }
        if (endpoint === 'sessions/list') return { ok: true, value: { sessions: [] } }
        if (endpoint === 'agents/detect') return { ok: true, value: { agents: [] } }
        if (endpoint === 'ui/tag-halo-set') return { ok: false, error: { code: 'bad_payload', message: 'no' } }
        return { ok: true, value: {} }
      },
      (zh) => zh,
    )
    await failing.resync()
    await failing.setTagHalo({ mode: 'steady', speed: 'normal' })
    // The revert target is what resync last knew: the host default, because
    // this mock never answers `ui/tag-halo`.
    expect(failing.getSnapshot().tagHalo).toEqual({ mode: 'breath', speed: 'normal' })
  })

  it('reads the approval deadlines on resync and writes one back optimistically', async () => {
    const sent: Array<Record<string, unknown>> = []
    const store = new (await import('../src/client/store.ts')).AcpStore(
      async (_channel, endpoint, payload) => {
        if (endpoint === 'agents/list') return { ok: true, value: { agents: [] } }
        if (endpoint === 'sessions/list') return { ok: true, value: { sessions: [] } }
        if (endpoint === 'agents/detect') return { ok: true, value: { agents: [] } }
        if (endpoint === 'ui/approval-deadlines') {
          return { ok: true, value: { deadlines: { permissionTimeoutMs: 600_000, mode: 'abort', configured: { permissionTimeoutMs: 600_000 } } } }
        }
        if (endpoint === 'ui/approval-deadlines-set') {
          sent.push(payload as Record<string, unknown>)
          // The host answer is the authority: it echoes what is now in force.
          return { ok: true, value: { deadlines: { permissionTimeoutMs: 30_000, mode: 'auto', configured: { permissionTimeoutMs: 600_000 } } } }
        }
        return { ok: true, value: {} }
      },
      (zh) => zh,
    )
    await store.resync()
    expect(store.getSnapshot().approvalDeadlines).toMatchObject({ permissionTimeoutMs: 600_000, mode: 'abort' })

    // Only the touched key travels; the host answer replaces the optimistic value.
    await store.setApprovalDeadline(30_000)
    expect(sent).toEqual([{ permissionTimeoutMs: 30_000 }])
    expect(store.getSnapshot().approvalDeadlines).toMatchObject({ permissionTimeoutMs: 30_000, mode: 'auto' })

    // The mode travels through the same write path.
    await store.setApprovalTimeoutMode('auto')
    expect(sent[1]).toEqual({ mode: 'auto' })
    expect(store.getSnapshot().approvalDeadlines).toMatchObject({ mode: 'auto' })

    // `reset` is its own payload, not a deadline.
    await store.resetApprovalDeadlines()
    expect(sent[2]).toEqual({ reset: true })

    // A host half without the route leaves the card hidden rather than showing
    // a number this browser invented.
    const older = new (await import('../src/client/store.ts')).AcpStore(
      async (_channel, endpoint) => {
        if (endpoint === 'agents/list') return { ok: true, value: { agents: [] } }
        if (endpoint === 'sessions/list') return { ok: true, value: { sessions: [] } }
        if (endpoint === 'agents/detect') return { ok: true, value: { agents: [] } }
        if (endpoint === 'ui/approval-deadlines') return { ok: false, error: { code: 'unknown_endpoint', message: 'no' } }
        return { ok: true, value: {} }
      },
      (zh) => zh,
    )
    await older.resync()
    expect(older.getSnapshot().approvalDeadlines).toBeUndefined()

    // A refused write reverts to the last host answer instead of leaving the
    // card showing a window that is not running.
    const failing = new (await import('../src/client/store.ts')).AcpStore(
      async (_channel, endpoint) => {
        if (endpoint === 'agents/list') return { ok: true, value: { agents: [] } }
        if (endpoint === 'sessions/list') return { ok: true, value: { sessions: [] } }
        if (endpoint === 'agents/detect') return { ok: true, value: { agents: [] } }
        if (endpoint === 'ui/approval-deadlines') {
          return { ok: true, value: { deadlines: { nativeApprovalTimeoutMs: 300_000, permissionFallbackTimeoutMs: 300_000 } } }
        }
        if (endpoint === 'ui/approval-deadlines-set') return { ok: false, error: { code: 'bad_payload', message: 'no' } }
        return { ok: true, value: {} }
      },
      (zh) => zh,
    )
    await failing.resync()
    await failing.setApprovalDeadline('nativeApprovalTimeoutMs', 30_000)
    expect(failing.getSnapshot().approvalDeadlines).toEqual({ nativeApprovalTimeoutMs: 300_000, permissionFallbackTimeoutMs: 300_000 })
  })

  it('testAgent posts the form payload as-is and returns the host verdict', async () => {
    const payloads: Array<Record<string, unknown>> = []
    const store = new (await import('../src/client/store.ts')).AcpStore(
      async (_channel, endpoint, payload) => {
        if (endpoint === 'agent/test') {
          payloads.push(payload as Record<string, unknown>)
          return { ok: true, value: { ok: false, error: 'spawn ENOENT', durationMs: 12, stderr: [] } }
        }
        return { ok: true, value: {} }
      },
      (zh) => zh,
    )

    const verdict = await store.testAgent({ id: 'pi', command: 'pi-acp', args: [], npmPackage: 'pi-acp', env: { KEY: 'v' } })
    expect(payloads[0]).toEqual({ id: 'pi', command: 'pi-acp', args: [], npmPackage: 'pi-acp', env: { KEY: 'v' } })
    // A reachable-but-broken agent is a verdict, not a thrown error.
    expect(verdict).toMatchObject({ ok: false, error: 'spawn ENOENT' })

    // Old host build: the unknown-endpoint failure becomes a localized notice.
    const oldStore = new (await import('../src/client/store.ts')).AcpStore(
      async () => ({ ok: false, error: { code: 'unknown_endpoint', message: 'acp: unknown endpoint agent/test' } }),
      (zh) => zh,
    )
    await expect(oldStore.testAgent({ id: 'pi', command: 'pi-acp' })).rejects.toThrow(/unknown endpoint agent\/test/)
    expect(oldStore.getSnapshot().notice).toContain('重启 dsh web')
  })

  it('shows the settings ledger whenever any ask is pending', async () => {
    // The conversation dock answers the asks belonging to the open
    // conversation; the ledger is the cross-session mirror for everything it
    // cannot show (another conversation, or no chat identity at all).
    const { permissionLedgerCard } = await import('../src/client/panel.tsx')
    const pending = [{
      requestId: 'r1',
      sessionId: 's1',
      dshSessionId: 'chat-1',
      toolName: 'Bash',
      reason: 'Bash · echo hi',
      options: [{ optionId: 'allow1', name: 'Allow once', kind: 'allow_once' }],
      timeoutMode: 'abort' as const,
      deadlineAt: 1_700_000_300_000,
    }]

    expect(permissionLedgerCard({ permissions: pending })).toEqual({ visible: true })
    expect(permissionLedgerCard({ permissions: [] })).toEqual({ visible: false })
  })

  it('round-trips the agent MCP server list through the settings form', async () => {
    // The MCP list lives in the agent DEFINITION, so the form must carry it:
    // an agent whose MCP servers are configured must not lose them because
    // the user opened the settings page and saved some OTHER field.
    const { buildPayload, initialForm, payloadEquals } = await import('../src/client/panel.tsx')
    const mcpServers = [
      { name: 'local', transport: 'stdio' as const, command: '/opt/servers/local', args: ['--mcp'] },
      { name: 'remote', transport: 'http' as const, url: 'https://example.test/mcp' },
    ]
    const config: AcpAgentDef = {
      id: 'pi',
      title: 'pi',
      command: 'pi-acp',
      args: [],
      env: {},
      allowedCwdRoots: [],
      mcpServers,
    }
    const detected: DetectedAgentInfo = {
      id: 'pi',
      name: 'pi',
      detected: true,
      defaultCommand: 'pi-acp',
      defaultArgs: [],
      currentConfig: config,
    }

    // The form seeds itself from the stored list…
    const form = initialForm(detected, undefined)
    expect(form.mcpText).toContain('"local"')

    // …and saving it unchanged is NOT a change (otherwise the card would be
    // permanently dirty and every save would restart the agent).
    const payload = buildPayload(form, detected, false)
    expect(payload.mcpServers).toEqual(mcpServers)
    expect(payloadEquals(payload, config)).toBe(true)

    // Reformatting the text (reordering keys, re-indenting) is not a change
    // either.
    const reformatted = initialForm(detected, undefined)
    reformatted.mcpText = JSON.stringify([{ transport: 'http', url: 'https://example.test/mcp', name: 'remote' }, { name: 'local', command: '/opt/servers/local', args: ['--mcp'], transport: 'stdio' }], null, 4)
    expect(payloadEquals(buildPayload(reformatted, detected, false), config)).toBe(true)

    // An agent with no MCP servers sends none, and an empty list is the same
    // state as none.
    const bare: AcpAgentDef = { id: 'pi', title: 'pi', command: 'pi-acp', args: [], env: {}, allowedCwdRoots: [] }
    const bareDetected: DetectedAgentInfo = { ...detected, currentConfig: bare }
    const bareForm = initialForm(bareDetected, undefined)
    expect(bareForm.mcpText).toBe('')
    expect(buildPayload(bareForm, bareDetected, false).mcpServers).toBeUndefined()
    expect(payloadEquals(buildPayload(bareForm, bareDetected, false), bare)).toBe(true)
  })

  it('loads the chat-bound ACP sessions by chat id and switches the agent mode', async () => {
    const calls: Array<{ endpoint: string; payload: unknown }> = []
    let listed = { sessions: [] as unknown[] }
    const store = new AcpStore(async (_channel, endpoint, payload) => {
      calls.push({ endpoint, payload })
      if (endpoint === 'session/chat-list') return { ok: true, value: listed }
      if (endpoint === 'session/chat-mode-set') return { ok: true, value: { done: true } }
      return { ok: true, value: {} }
    }, (zh) => zh)

    // A chat the agent has not run in yet: nothing to render, and the store
    // records which chat the empty answer belongs to.
    await store.loadChatSessions('chat-1')
    expect(store.getSnapshot().chatSessions).toEqual([])
    expect(store.getSnapshot().chatSessionsFor).toBe('chat-1')

    listed = { sessions: [{ agentId: 'pi', sessionId: 's1', modes: { currentModeId: 'default', availableModes: [{ id: 'strict', name: 'Strict' }] } }] }
    await store.loadChatSessions('chat-1')
    expect(store.getSnapshot().chatSessions).toHaveLength(1)

    await store.setChatSessionMode('chat-1', 'strict', 'pi')
    // The switch rides the lightweight endpoint, then the binding is re-read so
    // a rejected switch cannot leave an optimistic value on screen.
    expect(calls.filter(c => c.endpoint === 'session/chat-mode-set')).toEqual([
      { endpoint: 'session/chat-mode-set', payload: { dshSessionId: 'chat-1', modeId: 'strict', agentId: 'pi' } },
    ])
    expect(calls.at(-1)?.endpoint).toBe('session/chat-list')
    expect(store.getSnapshot().notice).toBeUndefined()
  })

  it('resumes a released chat session on request and reports failures to the caller', async () => {
    const calls: Array<{ endpoint: string; payload: unknown }> = []
    let failResume = false
    const store = new AcpStore(async (_channel, endpoint, payload) => {
      calls.push({ endpoint, payload })
      if (endpoint === 'session/chat-resume') {
        return failResume
          ? { ok: false, error: { code: 'resume_unsupported', message: 'acp: agent cannot load sessions' } }
          : { ok: true, value: { done: true } }
      }
      if (endpoint === 'session/chat-list') {
        return { ok: true, value: { sessions: [{ agentId: 'pi', sessionId: 's1', released: true }] } }
      }
      return { ok: true, value: {} }
    }, (zh) => zh)

    await store.resumeChatSession('chat-1')
    expect(calls.filter(c => c.endpoint === 'session/chat-resume')).toEqual([
      { endpoint: 'session/chat-resume', payload: { dshSessionId: 'chat-1' } },
    ])
    // The binding is re-read after the gesture so the row follows the host —
    // the same contract the mode switch follows.
    expect(calls.at(-1)?.endpoint).toBe('session/chat-list')
    expect(store.getSnapshot().notice).toBeUndefined()

    // A failure is flashed to the notice AND rethrown (the banner pins it
    // beside the button the user just pressed).
    failResume = true
    await expect(store.resumeChatSession('chat-1')).rejects.toThrow('cannot load sessions')
    expect(store.getSnapshot().notice).toContain('cannot load sessions')
    expect(calls.at(-1)?.endpoint).toBe('session/chat-list')
  })

  it('exposes the agent slash commands a chat-list answer carries', async () => {
    const store = new AcpStore(async (_channel, endpoint) => {
      if (endpoint === 'session/chat-list') {
        return {
          ok: true,
          value: {
            sessions: [{
              agentId: 'pi',
              sessionId: 's1',
              availableCommands: [{ name: 'compact', description: 'compress the context' }, { name: 'session' }],
            }],
          },
        }
      }
      return { ok: true, value: {} }
    }, (zh) => zh)

    // No answer for this conversation yet: the caller may ask.
    expect(store.chatSessionCommands('chat-1')).toBeUndefined()
    await store.loadChatSessions('chat-1')
    expect(store.chatSessionCommands('chat-1')).toEqual([
      { name: 'compact', description: 'compress the context' },
      { name: 'session' },
    ])
    // Another conversation is not answered by this one's read.
    expect(store.chatSessionCommands('chat-2')).toBeUndefined()

    // A read that lands with no live ACP session has no LIVE declaration —
    // `undefined`, so the caller falls back to the agent-level cache instead
    // of reading "no session" as "this agent has no commands".
    const idle = new AcpStore(async () => ({ ok: true, value: { sessions: [] } }), (zh) => zh)
    await idle.loadChatSessions('chat-1')
    expect(idle.chatSessionCommands('chat-1')).toBeUndefined()
  })

  it('offers the agent-level command cache before the conversation has a session', async () => {
    const store = new AcpStore(async (_channel, endpoint, payload) => {
      if (endpoint === 'session/chat-list') {
        return { ok: true, value: { sessions: [], acpMode: true, boundAgentId: 'pi' } }
      }
      if (endpoint === 'agent/catalog') {
        expect(payload).toEqual({ agentId: 'pi' })
        return {
          ok: true,
          value: {
            agentId: 'pi',
            title: 'Pi',
            base: { id: 'pi', name: 'Pi' },
            variants: [],
            probed: true,
            commands: [{ name: 'compact', description: 'compress the context' }],
          },
        }
      }
      return { ok: true, value: {} }
    }, (zh) => zh)

    await store.loadChatSessions('chat-1')
    // No live declaration...
    expect(store.chatSessionCommands('chat-1')).toBeUndefined()
    // ...so the menu asks which agent serves the conversation, then that
    // agent's cached catalogue.
    expect(store.chatAgentFor('chat-1')).toBe('pi')
    expect(store.agentCommands('pi')).toBeUndefined()
    await store.loadAgentCatalog('pi')
    expect(store.agentCommands('pi')).toEqual([{ name: 'compact', description: 'compress the context' }])
  })

  it('makes a caller that arrives mid-read wait for THAT read', async () => {
    let release: (() => void) | undefined
    const reads: string[] = []
    const store = new AcpStore(async (_channel, endpoint) => {
      if (endpoint === 'session/chat-list') {
        reads.push('read')
        await new Promise<void>(resolve => { release = resolve })
        return { ok: true, value: { sessions: [{ agentId: 'pi', sessionId: 's1', availableCommands: [{ name: 'compact' }] }] } }
      }
      return { ok: true, value: {} }
    }, (zh) => zh)

    const first = store.loadChatSessions('chat-1')
    // The slash source asks while the composer's read is still in flight: it
    // must receive the answer of that read, not resolve against the old state.
    const second = store.loadChatSessions('chat-1')
    release?.()
    await Promise.all([first, second])
    expect(reads).toEqual(['read'])
    expect(store.chatSessionCommands('chat-1')).toEqual([{ name: 'compact' }])
  })

  it('degrades silently when the host has no chat-session mode surface', async () => {
    const store = new AcpStore(async () => ({ ok: false, error: { code: 'unknown_endpoint', message: 'nope' } }), (zh) => zh)
    await store.loadChatSessions('chat-1')
    expect(store.getSnapshot().chatSessions).toEqual([])
    expect(store.getSnapshot().notice).toBeUndefined()

    await store.setChatSessionMode('chat-1', 'strict')
    // A failed switch is surfaced (the user asked for it), unlike the probe.
    expect(store.getSnapshot().notice).toContain('nope')
  })

  it('records the per-session ACP-mode verdict from session/chat-list and invalidates it', async () => {
    const store = new AcpStore(async (_channel, endpoint) => {
      if (endpoint === 'session/chat-list') return { ok: true, value: { sessions: [], acpMode: true } }
      return { ok: true, value: {} }
    }, (zh) => zh)
    await store.loadChatSessions('chat-1')
    expect(store.getSnapshot().acpMode['chat-1']).toBe(true)

    // The preset switch the session committed rewrites what the log says: the
    // held verdict must go, or the seat gate would trust a moved-past answer.
    store.invalidateAcpMode('chat-1')
    expect(store.getSnapshot().acpMode).toEqual({})
    // Invalidating an unknown id stays a no-op (no listener churn).
    store.invalidateAcpMode('chat-1')
    store.invalidateAcpMode()
    expect(store.getSnapshot().acpMode).toEqual({})
  })

  it('keeps no ACP-mode verdict when an older host half omits the field', async () => {
    const store = new AcpStore(async (_channel, endpoint) => {
      if (endpoint === 'session/chat-list') return { ok: true, value: { sessions: [] } }
      return { ok: true, value: {} }
    }, (zh) => zh)
    await store.loadChatSessions('chat-1')
    // Absent field = no fact either way: the seat gate reads this as "ask
    // unanswered" and keeps the native seat, never a false ACP claim.
    expect(store.getSnapshot().acpMode).toEqual({})
  })

  it('records the agent binding optimistically on the click and folds the host answer over it', async () => {
    // The click is the whole user-visible contract of the agent picker: the
    // chip must name the picked agent immediately. The live-session list cannot
    // do that (a switch materializes its session only on the next message), so
    // the store carries the binding itself and lets the host read confirm it.
    const store = new AcpStore(async (_channel, endpoint) => {
      if (endpoint === 'session/chat-list') return { ok: true, value: { sessions: [], boundAgentId: 'omp' } }
      return { ok: true, value: { done: true } }
    }, (zh) => zh)

    await store.bindChatAgent('chat-1', 'omp')
    expect(store.getSnapshot().chatBoundAgent['chat-1']).toBe('omp')

    // The host read (the click path re-reads) confirms the same binding.
    await store.loadChatSessions('chat-1')
    expect(store.getSnapshot().chatBoundAgent['chat-1']).toBe('omp')
    // A different conversation keeps its own binding.
    await store.loadChatSessions('chat-2')
    expect(store.getSnapshot().chatBoundAgent['chat-2']).toBe('omp')

    // An older host half without the field: the optimistic value stands.
    const legacy = new AcpStore(async (_channel, endpoint) => {
      if (endpoint === 'session/chat-list') return { ok: true, value: { sessions: [] } }
      return { ok: true, value: { done: true } }
    }, (zh) => zh)
    await legacy.bindChatAgent('chat-1', 'pi')
    await legacy.loadChatSessions('chat-1')
    expect(legacy.getSnapshot().chatBoundAgent['chat-1']).toBe('pi')
  })

  it('records the one-way agent lock from session/chat-list', async () => {
    let listed: { sessions: unknown[]; lockedAgentId?: string } = { sessions: [], lockedAgentId: 'pi' }
    const store = new AcpStore(async (_channel, endpoint) => {
      if (endpoint === 'session/chat-list') return { ok: true, value: listed }
      return { ok: true, value: { done: true } }
    }, (zh) => zh)

    await store.loadChatSessions('chat-1')
    expect(store.getSnapshot().chatLockedAgent['chat-1']).toBe('pi')

    // The lock is one-way: a read that omits the field is an older host half,
    // not an unlock. Keeping it is what stops the picker coming back.
    listed = { sessions: [] }
    await store.loadChatSessions('chat-1')
    expect(store.getSnapshot().chatLockedAgent['chat-1']).toBe('pi')

    // Conversations are independent.
    listed = { sessions: [], lockedAgentId: 'omp' }
    await store.loadChatSessions('chat-2')
    expect(store.getSnapshot().chatLockedAgent['chat-2']).toBe('omp')
  })

  it('takes the start-of-turn lock from the host frame, and honours a rolled-back lock', async () => {
    let listed: { sessions: unknown[]; lockedAgentId?: string } = { sessions: [], lockedAgentId: 'pi' }
    const store = new AcpStore(async (_channel, endpoint) => {
      if (endpoint === 'session/chat-list') return { ok: true, value: listed }
      return { ok: true, value: {} }
    }, (zh) => zh)
    const apply = (event: unknown): Promise<void> =>
      (store as unknown as { applyEvent(event: unknown): Promise<void> }).applyEvent(event)

    // The host locks the conversation when the first ACP turn starts and says
    // so immediately: that frame is the hand-off trigger, not a later read.
    await apply({ type: 'chat/agent-locked', dshSessionId: 'chat-1', agentId: 'pi' })
    expect(store.getSnapshot().chatLockedAgent['chat-1']).toBe('pi')
    expect(store.getSnapshot().chatBoundAgent['chat-1']).toBe('pi')
    expect(store.getSnapshot().agentLockReveal['chat-1']).toBe(1)

    // A read confirming the same lock is not a second hand-off.
    await store.loadChatSessions('chat-1')
    expect(store.getSnapshot().agentLockReveal['chat-1']).toBe(1)

    // The first turn delivered nothing: the host rolled the lock back.
    await apply({ type: 'chat/agent-unlocked', dshSessionId: 'chat-1' })
    expect(store.getSnapshot().chatLockedAgent['chat-1']).toBeUndefined()

    // A list read that started before the rollback can still report the lock;
    // it must not revive a conversation the host has explicitly unlocked.
    await store.loadChatSessions('chat-1')
    expect(store.getSnapshot().chatLockedAgent['chat-1']).toBeUndefined()

    // The user retries: the new lock frame supersedes the rollback marker and
    // announces a fresh ceremony (the animation's serial advances).
    await apply({ type: 'chat/agent-locked', dshSessionId: 'chat-1', agentId: 'pi' })
    expect(store.getSnapshot().chatLockedAgent['chat-1']).toBe('pi')
    expect(store.getSnapshot().agentLockReveal['chat-1']).toBe(2)
  })

  it('announces a lock only when this page watched it arrive', async () => {
    // The composer plays a shatter/condense hand-off on this serial (see
    // agent-lock-anim.ts). A lock that was already there when the page opened
    // is not a transition and must not replay the ceremony on every reload.
    let listed: { sessions: unknown[]; lockedAgentId?: string } = { sessions: [] }
    const store = new AcpStore(async (_channel, endpoint) => {
      if (endpoint === 'session/chat-list') return { ok: true, value: listed }
      return { ok: true, value: { done: true } }
    }, (zh) => zh)

    await store.loadChatSessions('chat-1')
    expect(store.getSnapshot().agentLockReveal['chat-1']).toBeUndefined()

    // The first turn lands: a later read reports the lock.
    listed = { sessions: [], lockedAgentId: 'pi' }
    await store.loadChatSessions('chat-1')
    expect(store.getSnapshot().agentLockReveal['chat-1']).toBe(1)

    // Restating the lock is not another transition.
    await store.loadChatSessions('chat-1')
    expect(store.getSnapshot().agentLockReveal['chat-1']).toBe(1)

    // A page that opens an already-locked conversation seeds the lock silently.
    const reloaded = new AcpStore(async (_channel, endpoint) => {
      if (endpoint === 'session/chat-list') return { ok: true, value: { sessions: [], lockedAgentId: 'pi' } }
      return { ok: true, value: { done: true } }
    }, (zh) => zh)
    await reloaded.loadChatSessions('chat-1')
    expect(reloaded.getSnapshot().chatLockedAgent['chat-1']).toBe('pi')
    expect(reloaded.getSnapshot().agentLockReveal).toEqual({})
  })

  it('folds a committed preset frame into the verdict instead of re-reading the log', async () => {
    // The host log read is one switch behind the frame that announces the
    // switch, so the seat used to move only after a page reload.
    const reads: string[] = []
    const store = new AcpStore(async (_channel, endpoint) => {
      if (endpoint === 'session/chat-list') {
        reads.push('session/chat-list')
        return { ok: true, value: { sessions: [], acpMode: false } }
      }
      return { ok: true, value: {} }
    }, (zh) => zh)
    const gate = (): boolean => stagedIsAcpMode({ current: 'chat-1' }, id => store.getSnapshot().acpMode[id])

    // Cold seed: the session still runs the standard preset.
    await store.loadChatSessions('chat-1')
    expect(gate()).toBe(false)

    // The user switches into ACP mode. The frame carries the committed preset, so
    // the verdict comes from the frame — not from the log, which the host can
    // only fold to the preset BEFORE this switch.
    store.noteAcpMode('chat-1', acpModeFromPresetEvent('acp'))
    expect(gate()).toBe(true)
    // ...and out again, same way.
    store.noteAcpMode('chat-1', acpModeFromPresetEvent('standard'))
    expect(gate()).toBe(false)
    // Neither switch needed a round-trip.
    expect(reads).toHaveLength(1)

    // A frame restating the held verdict changes nothing (no listener churn).
    store.noteAcpMode('chat-1', acpModeFromPresetEvent('standard'))
    expect(store.getSnapshot().acpMode).toEqual({ 'chat-1': false })
  })

  it('lets a committed preset frame override a chat-list answer still in flight', async () => {
    let release: (() => void) | undefined
    const store = new AcpStore(async (_channel, endpoint) => {
      if (endpoint === 'session/chat-list') {
        await new Promise<void>(resolve => { release = resolve })
        // The log as it read BEFORE the switch: still ACP.
        return { ok: true, value: { sessions: [], acpMode: true } }
      }
      return { ok: true, value: {} }
    }, (zh) => zh)

    const pending = store.loadChatSessions('chat-1')
    // The switch commits while that read is outstanding.
    store.abandonChatSessionRead('chat-1')
    store.noteAcpMode('chat-1', acpModeFromPresetEvent('standard'))
    release?.()
    await pending
    // The stale answer must not land over the frame's verdict.
    expect(store.getSnapshot().acpMode).toEqual({ 'chat-1': false })

    // A later read for the same session is no longer blocked by the dropped one.
    const other = new AcpStore(async () => ({ ok: true, value: { sessions: [], acpMode: true } }), (zh) => zh)
    await other.abandonChatSessionRead('chat-1')
    await other.loadChatSessions('chat-1')
    expect(other.getSnapshot().acpMode['chat-1']).toBe(true)
  })

  it('keeps a frame-settled verdict immune to a later host read that lags the switch', async () => {
    // The composer's readers re-mount when the ACP surfaces re-activate, and
    // the host's log read can still fold the preset BEFORE the switch — so the
    // frame's verdict must outrank any read, whenever it lands. This is what
    // made the surface move only after a page reload.
    const reads: string[] = []
    const store = new AcpStore(async (_channel, endpoint) => {
      if (endpoint === 'session/chat-list') {
        reads.push('read')
        return { ok: true, value: { sessions: [], acpMode: false } }
      }
      return { ok: true, value: {} }
    }, (zh) => zh)
    const gate = (): boolean => stagedIsAcpMode({ current: 'chat-1' }, id => store.getSnapshot().acpMode[id])

    // Cold seed (the session still runs another preset).
    await store.loadChatSessions('chat-1')
    // The switch commits: the frame carries 'acp'.
    store.noteAcpMode('chat-1', acpModeFromPresetEvent('acp'))
    expect(gate()).toBe(true)

    // A reader mounts and reads again; the host answers with the pre-switch
    // fold. The verdict must hold.
    await store.loadChatSessions('chat-1')
    expect(store.getSnapshot().acpMode['chat-1']).toBe(true)
    expect(gate()).toBe(true)
    // ...and again, for good measure.
    await store.loadChatSessions('chat-1')
    expect(gate()).toBe(true)

    // Only a newer frame may move it.
    store.noteAcpMode('chat-1', acpModeFromPresetEvent('standard'))
    expect(gate()).toBe(false)

    // Invalidating re-opens the session to host reads (the older-runtime path
    // whose frames carry no preset has to be able to re-ask).
    store.invalidateAcpMode('chat-1')
    await store.loadChatSessions('chat-1')
    expect(store.getSnapshot().acpMode['chat-1']).toBe(false)
    expect(reads).toHaveLength(4)
  })

  it('lets the seat gate own re-ask settle a verdict a frame had settled', async () => {
    // The frame's authority has ONE authorized exception, and this is it. A
    // session whose rows are silent AND whose frames have stopped arriving has
    // the held verdict as its only fact source; a host read is the one place a
    // switch the runtime never framed can still be learned from. Without it the
    // gate pinned the conversation in ACP mode for the rest of the page — and
    // the permission seat's product is an absence, so an ordinary
    // conversation silently lost its Access mode control.
    const reads: string[] = []
    const host = { acpMode: true }
    const store = new AcpStore(async (_channel, endpoint) => {
      if (endpoint === 'session/chat-list') {
        reads.push('read')
        return { ok: true, value: { sessions: [], acpMode: host.acpMode } }
      }
      return { ok: true, value: {} }
    }, (zh) => zh)
    const gate = (): boolean => stagedIsAcpMode({ current: 'chat-1' }, id => store.getSnapshot().acpMode[id])

    // The switch into ACP mode arrives as a frame; the verdict is frame-settled.
    store.noteAcpMode('chat-1', acpModeFromPresetEvent('acp'))
    expect(gate()).toBe(true)
    // A composer reader's answer still defers to the frame (the host's log
    // read can lag a switch by one).
    host.acpMode = false
    await store.loadChatSessions('chat-1')
    expect(gate()).toBe(true)

    // The gate's own re-ask is allowed to settle it: the conversation switched
    // back, the frame path is quiet, and the host now says so.
    await store.loadChatSessions('chat-1', { settleVerdict: true })
    expect(gate()).toBe(false)
    expect(store.getSnapshot().acpMode['chat-1']).toBe(false)

    // And the frame is still the authority afterwards: a newer one wins again.
    store.noteAcpMode('chat-1', acpModeFromPresetEvent('acp'))
    expect(gate()).toBe(true)
    expect(reads).toHaveLength(2)
  })

  it('setExposedModels uses the lightweight endpoint and resyncs afterwards', async () => {
    const endpoints: string[] = []
    const payloads: Array<Record<string, unknown>> = []
    const store = new (await import('../src/client/store.ts')).AcpStore(
      async (_channel, endpoint, payload) => {
        endpoints.push(endpoint)
        payloads.push(payload as Record<string, unknown>)
        if (endpoint === 'agents/list') return { ok: true, value: { agents: [] } }
        if (endpoint === 'sessions/list') return { ok: true, value: { sessions: [] } }
        if (endpoint === 'agents/detect') return { ok: true, value: { agents: [] } }
        return { ok: true, value: { done: true } }
      },
      (zh) => zh,
    )

    await store.setExposedModels('pi', ['model-a', 'model-b'])
    expect(endpoints).toContain('agent/set-exposed-models')
    expect(endpoints).toContain('agents/list') // resync refreshes currentConfig
    const sent = payloads[endpoints.indexOf('agent/set-exposed-models')]
    expect(sent).toEqual({ agentId: 'pi', exposedModels: ['model-a', 'model-b'] })

    endpoints.length = 0
    payloads.length = 0
    await store.setExposedModels('pi', undefined)
    const cleared = payloads[endpoints.indexOf('agent/set-exposed-models')]
    expect(cleared).toEqual({ agentId: 'pi' })
  })

  it('loadAgentCatalog caches per agent and dedups concurrent reads', async () => {
    const endpoints: string[] = []
    let resolveRead: ((value: unknown) => void) | undefined
    const store = new AcpStore(
      async (_channel, endpoint) => {
        endpoints.push(endpoint)
        if (endpoint !== 'agent/catalog') return { ok: true, value: {} }
        // Hold the first read open so the second caller overlaps it.
        await new Promise<void>(resolve => { resolveRead = () => { resolve() } })
        return {
          ok: true,
          value: { agentId: 'pi', title: 'Pi', base: { id: 'pi', name: 'Pi' }, variants: [], probed: true },
        }
      },
      (zh) => zh,
    )

    const first = store.loadAgentCatalog('pi')
    const second = store.loadAgentCatalog('pi')
    resolveRead?.()
    await Promise.all([first, second])
    // Two concurrent mounts, one round-trip (the seat asks on every mount).
    expect(endpoints.filter(endpoint => endpoint === 'agent/catalog')).toHaveLength(1)
    expect(store.getSnapshot().seatCatalogs.pi).toMatchObject({ title: 'Pi', probed: true })

    // Cached: a later mount reads nothing at all.
    await store.loadAgentCatalog('pi')
    expect(endpoints.filter(endpoint => endpoint === 'agent/catalog')).toHaveLength(1)
  })

  it('drops the cached seat catalog when the host announces a new one', async () => {
    let reads = 0
    const store = new AcpStore(
      async (_channel, endpoint) => {
        if (endpoint !== 'agent/catalog') return { ok: true, value: {} }
        reads += 1
        return {
          ok: true,
          value: {
            agentId: 'pi',
            title: 'Pi',
            base: { id: 'pi', name: 'Pi' },
            variants: [],
            probed: true,
            currentModel: { value: `m${String(reads)}`, name: `M${String(reads)}` },
          },
        }
      },
      (zh) => zh,
    )

    await store.loadAgentCatalog('pi')
    expect(reads).toBe(1)
    expect(store.getSnapshot().seatCatalogs.pi?.currentModel?.value).toBe('m1')

    // A real session on the host learned a new catalog: the cached projection
    // must be dropped and re-read, or the open conversation renders yesterday's
    // list until the user presses "detect models".
    await (store as unknown as { applyEvent(event: unknown): Promise<void> }).applyEvent({
      type: 'catalog/updated',
      agentId: 'pi',
      updatedAt: 2,
    })
    expect(reads).toBe(2)
    expect(store.getSnapshot().seatCatalogs.pi?.currentModel?.value).toBe('m2')

    // And the freshly read surface is cached again (no frame-storm re-reads).
    await store.loadAgentCatalog('pi')
    expect(reads).toBe(2)
  })

  it('takes a host-side exposure change without a save, and re-reads the seat surface', async () => {
    // Auto-discovery appends models on the HOST while a session runs. The
    // settings card must hear about it (its right pane is the selection) and
    // the composer must drop its cached seat list (the variants are a
    // projection of the same filter) — without an `agent/save`.
    let reads = 0
    const store = new AcpStore(
      async (_channel, endpoint) => {
        if (endpoint === 'agent/catalog') {
          reads += 1
          return {
            ok: true,
            value: { agentId: 'pi', title: 'Pi', base: { id: 'pi', name: 'Pi' }, variants: [], probed: true },
          }
        }
        if (endpoint === 'agents/list') return { ok: true, value: { agents: [] } }
        if (endpoint === 'sessions/list') return { ok: true, value: { sessions: [] } }
        if (endpoint === 'agents/detect') {
          return {
            ok: true,
            value: {
              agents: [{
                id: 'pi',
                name: 'Pi',
                detected: true,
                defaultCommand: 'pi-acp',
                defaultArgs: [],
                currentConfig: { id: 'pi', command: 'pi-acp', exposedModels: ['a'], autoDiscoverModels: true },
              }],
            },
          }
        }
        return { ok: true, value: {} }
      },
      (zh) => zh,
    )
    await store.resync()
    expect(store.getSnapshot().detectedAgents.find(info => info.id === 'pi')?.currentConfig?.exposedModels).toEqual(['a'])

    await (store as unknown as { applyEvent(event: unknown): Promise<void> }).applyEvent({
      type: 'agent/exposure',
      agentId: 'pi',
      exposedModels: ['a', 'b'],
      autoDiscoverModels: true,
    })

    expect(store.getSnapshot().detectedAgents.find(info => info.id === 'pi')?.currentConfig).toMatchObject({
      exposedModels: ['a', 'b'],
      autoDiscoverModels: true,
    })
    expect(reads).toBe(1)
  })

  it('loadAgentCatalog stays quiet when the host has no catalog surface', async () => {
    const store = new AcpStore(
      async () => ({ ok: false, error: { code: 'unknown_endpoint', message: 'nope' } }),
      (zh) => zh,
    )
    await store.loadAgentCatalog('pi')
    // No entry and no notice: the seats fall back to the agent's own title.
    expect(store.getSnapshot().seatCatalogs.pi).toBeUndefined()
    expect(store.getSnapshot().notice).toBeUndefined()
  })

  it('setExposedModels surfaces host errors as a notice and rethrows', async () => {
    const store = new (await import('../src/client/store.ts')).AcpStore(
      async (_channel, endpoint) => {
        if (endpoint === 'agent/set-exposed-models') {
          return { ok: false, error: { code: 'unknown_agent', message: 'acp: agent "pi" is not configured' } }
        }
        return { ok: true, value: {} }
      },
      (zh) => zh,
    )
    await expect(store.setExposedModels('pi', ['a'])).rejects.toThrow(/not configured/)
    expect(store.getSnapshot().notice).toMatch(/not configured/)
  })

  it('probeModels reports a failure both inline and as a notice, then clears it on retry', async () => {
    let failing = true
    const store = new AcpStore(
      async (_channel, endpoint) => {
        if (endpoint !== 'agent/probe-models') return { ok: true, value: {} }
        if (failing) return { ok: false, error: { code: 'bad_cwd', message: 'acp: cwd does not exist: /nope' } }
        return {
          ok: true,
          value: {
            agentId: 'codebuddy',
            catalog: { model: { configId: 'model', name: 'Model', currentValue: 'm', choices: [{ value: 'm', name: 'M' }] } },
            updatedAt: 1,
          },
        }
      },
      (zh) => zh,
    )

    await store.probeModels('codebuddy')
    // A failed probe must be visible where the user clicked, not only in the
    // panel-top notice that may be scrolled out of view.
    expect(store.getSnapshot().probingModels.codebuddy).toBe(false)
    expect(store.getSnapshot().probeErrors.codebuddy).toContain('cwd does not exist')
    expect(store.getSnapshot().notice).toContain('cwd does not exist')
    // A failed settings action stays on the notice banner; the agent runtime
    // log is for agent-side messages only.
    expect(store.getSnapshot().logs).toHaveLength(0)

    failing = false
    await store.probeModels('codebuddy')
    const state = store.getSnapshot()
    expect(state.probeErrors.codebuddy).toBeUndefined()
    expect(state.modelCatalogs.codebuddy?.catalog.model?.choices).toHaveLength(1)
    // The stale failure must not stay pinned at the top of the panel.
    expect(state.notice).toBeUndefined()
  })

  it('loadCachedModels fills the panes from the persisted catalog, once per agent', async () => {
    const endpoints: string[] = []
    const store = new AcpStore(
      async (_channel, endpoint) => {
        endpoints.push(endpoint)
        if (endpoint !== 'agent/cached-models') return { ok: true, value: {} }
        return {
          ok: true,
          value: {
            agentId: 'codebuddy',
            catalog: {
              model: {
                configId: 'model',
                name: 'Model',
                currentValue: 'a',
                choices: [{ value: 'a', name: 'A' }, { value: 'b', name: 'B' }],
              },
            },
            updatedAt: 7,
          },
        }
      },
      (zh) => zh,
    )

    await store.loadCachedModels('codebuddy')
    // This is the whole point of the read: the list is there before any probe,
    // so a configured selection is visible on open instead of after a click.
    expect(store.getSnapshot().modelCatalogs.codebuddy?.catalog.model?.choices.map(c => c.value)).toEqual(['a', 'b'])
    // A probe never ran.
    expect(endpoints).not.toContain('agent/probe-models')

    // Collapse/expand and the next panel open mount the card again; the read is
    // memory-only but still deduped by the cached entry.
    await store.loadCachedModels('codebuddy')
    expect(endpoints.filter(endpoint => endpoint === 'agent/cached-models')).toHaveLength(1)
  })

  it('loadCachedModels never overwrites a probe and tolerates null or an older host', async () => {
    const probed = new AcpStore(
      async (_channel, endpoint) => {
        if (endpoint === 'agent/probe-models') {
          return {
            ok: true,
            value: {
              agentId: 'pi',
              catalog: { model: { configId: 'model', name: 'Model', choices: [{ value: 'fresh', name: 'Fresh' }] } },
              updatedAt: 2,
            },
          }
        }
        if (endpoint === 'agent/cached-models') {
          return {
            ok: true,
            value: {
              agentId: 'pi',
              catalog: { model: { configId: 'model', name: 'Model', choices: [{ value: 'stale', name: 'Stale' }] } },
              updatedAt: 1,
            },
          }
        }
        return { ok: true, value: {} }
      },
      (zh) => zh,
    )
    await probed.probeModels('pi')
    await probed.loadCachedModels('pi')
    expect(probed.getSnapshot().modelCatalogs.pi?.catalog.model?.choices.map(c => c.value)).toEqual(['fresh'])

    // `null` = the agent has never published a catalog; an `unknown_endpoint`
    // error = an older host half. Neither may surface as a failure.
    const empty = new AcpStore(
      async (_channel, endpoint) => (endpoint === 'agent/cached-models'
        ? { ok: true, value: null }
        : { ok: true, value: {} }),
      (zh) => zh,
    )
    await empty.loadCachedModels('pi')
    expect(empty.getSnapshot().modelCatalogs.pi).toBeUndefined()

    const older = new AcpStore(
      async (_channel, endpoint) => (endpoint === 'agent/cached-models'
        ? { ok: false, error: { code: 'unknown_endpoint', message: 'acp: unknown endpoint agent/cached-models' } }
        : { ok: true, value: {} }),
      (zh) => zh,
    )
    await expect(older.loadCachedModels('pi')).resolves.toBeUndefined()
    expect(older.getSnapshot().notice).toBeUndefined()
  })
})

describe('AcpStore locale switching', () => {
  it('rebuilds the detect summary in the newly active language', async () => {
    let zh = true
    const store = new AcpStore(
      async (_channel, endpoint) => (endpoint === 'agents/detect'
        ? { ok: true, value: { agents: [{ id: 'pi', name: 'Pi Agent', detected: true, defaultCommand: 'pi-acp', defaultArgs: [] }] } }
        : { ok: true, value: {} }),
      (zhText, enText) => (zh ? zhText : enText),
    )
    await store.detectAgents()
    expect(store.getSnapshot().detectSummary).toContain('个预设')

    zh = false
    store.refreshLocale()
    expect(store.getSnapshot().detectSummary).toContain('presets')
    // The counts, not the prose, survive the switch.
    expect(store.getSnapshot().detectedAgents).toHaveLength(1)
  })

  it('notifies subscribers even when no stored string is locale-derived', () => {
    const store = new AcpStore(async () => ({ ok: true, value: {} }), (zh) => zh)
    const before = store.getSnapshot()
    let notified = 0
    const stop = store.subscribe(() => { notified++ })
    store.refreshLocale()
    stop()
    expect(notified).toBe(1)
    // A fresh snapshot reference is what re-runs render-time `label()` pairs;
    // `localeRev` is what memoized transcript rows compare to notice it.
    expect(store.getSnapshot()).not.toBe(before)
    expect(store.getSnapshot().localeRev).toBe(before.localeRev + 1)
  })

  it('drops a stale detect summary once a re-detect fails, so the switch cannot revive it', async () => {
    let failing = false
    const store = new AcpStore(
      async (_channel, endpoint) => {
        if (endpoint !== 'agents/detect') return { ok: true, value: {} }
        return failing
          ? { ok: false, error: { code: 'internal', message: 'host offline' } }
          : { ok: true, value: { agents: [{ id: 'pi', name: 'Pi Agent', detected: true, defaultCommand: 'pi-acp', defaultArgs: [] }] } }
      },
      (zh) => zh,
    )
    await store.detectAgents()
    expect(store.getSnapshot().detectSummary).toBeDefined()
    failing = true
    await store.detectAgents()
    store.refreshLocale()
    expect(store.getSnapshot().detectSummary).toBeUndefined()
  })
})

describe('AcpStore event application (released / reset / turn dedup)', () => {
  function makeStore(): { store: AcpStore; apply: (event: unknown) => Promise<void> } {
    const store = new AcpStore(async () => ({ ok: true, value: {} }), (zh) => zh)
    const apply = (event: unknown): Promise<void> =>
      (store as unknown as { applyEvent(event: unknown): Promise<void> }).applyEvent(event)
    return { store, apply }
  }

  it('coalesces a frame of streaming updates into one fold and one notification', async () => {
    // Agents stream at token granularity; folding and notifying per chunk
    // re-rendered every store consumer per chunk (the whole-system lag this
    // coalescing exists to fix). With a frame scheduler present, the frames
    // queue up and ONE flush folds the batch with ONE listener notification.
    const frames: Array<() => void> = []
    vi.stubGlobal('requestAnimationFrame', (cb: () => void): number => {
      frames.push(cb)
      return frames.length
    })
    try {
      const { store, apply } = await makeStore()
      await apply({ type: 'session/created', sessionId: 's1', session: view() })
      await apply({ type: 'turn/start', sessionId: 's1', turnId: 't1', text: 'hi' })
      let notifications = 0
      store.subscribe(() => { notifications += 1 })

      await apply({ type: 'session/update', sessionId: 's1', seq: 1, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hello ' } } })
      await apply({ type: 'session/update', sessionId: 's1', seq: 2, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'world' } } })
      await apply({ type: 'session/update', sessionId: 's1', seq: 3, update: { sessionUpdate: 'usage_update', used: 5, size: 50 } })

      // Nothing folded yet: the frame has not run.
      expect(notifications).toBe(0)
      expect(store.getSnapshot().blocks.filter(b => b.kind === 'agent')).toHaveLength(0)

      // One frame runs the whole batch: one notification, one merged block.
      const pending = frames.splice(0)
      for (const frame of pending) frame()
      expect(notifications).toBe(1)
      const agentBlocks = store.getSnapshot().blocks.filter(b => b.kind === 'agent')
      expect(agentBlocks).toHaveLength(1)
      expect(agentBlocks[0]).toMatchObject({ text: 'Hello world' })
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('live-patches usage into the session, chat row and watched transcript', async () => {
    const listed = { sessions: [{ agentId: 'pi', sessionId: 's1', usage: { used: 1, size: 100 } }], acpMode: true }
    const store = new AcpStore(async (_channel, endpoint) => {
      if (endpoint === 'session/chat-list') return { ok: true, value: listed }
      if (endpoint === 'session/chat-transcript') {
        return { ok: true, value: { views: [{ session: view({ usage: { used: 1, size: 100 } }), entries: [] }] } }
      }
      return { ok: true, value: {} }
    }, zh => zh)
    const apply = (event: unknown): Promise<void> =>
      (store as unknown as { applyEvent(event: unknown): Promise<void> }).applyEvent(event)

    await store.loadChatSessions('chat-1')
    await store.loadChatTranscript('chat-1')
    await apply({ type: 'session/created', sessionId: 's1', session: view({ usage: { used: 1, size: 100 } }) })
    const blocksBefore = store.getSnapshot().chatTranscripts.s1?.blocks

    await apply({ type: 'session/update', sessionId: 's1', seq: 1, update: { sessionUpdate: 'usage_update', used: 500, size: 1000 } })

    // No animation frame in Node: the batch flushes synchronously, and every
    // snapshot the occupancy surface reads moved — not just the transcript.
    expect(store.getSnapshot().chatSessions[0]?.usage).toEqual({ used: 500, size: 1000 })
    expect(store.getSnapshot().chatTranscripts.s1?.session.usage).toEqual({ used: 500, size: 1000 })
    // A usage-only tick must not touch the folded blocks.
    expect(store.getSnapshot().chatTranscripts.s1?.blocks).toBe(blocksBefore)
  })

  it('re-reads the chat row when a turn starts before the row list has seen the session', async () => {
    // The first ACP session is materialized inside its first turn, after the
    // composer's mount / running read; without this read its usage ticks would
    // find no row and the occupancy ring would stay absent until the turn end.
    let rows: ChatSessionView[] = []
    const store = new AcpStore(async (_channel, endpoint) => {
      if (endpoint === 'session/chat-list') return { ok: true, value: { sessions: rows, acpMode: true } }
      return { ok: true, value: {} }
    }, zh => zh)
    const apply = (event: unknown): Promise<void> =>
      (store as unknown as { applyEvent(event: unknown): Promise<void> }).applyEvent(event)

    await store.loadChatSessions('chat-1')
    expect(store.getSnapshot().chatSessions).toEqual([])

    rows = [{ agentId: 'pi', sessionId: 's1', usage: { used: 10, size: 100 } }]
    await apply({ type: 'turn/start', sessionId: 's1', turnId: 't1', text: 'hi' })
    await vi.waitFor(() => expect(store.getSnapshot().chatSessions).toEqual(rows))
  })

  it('takes a republished snapshot’s (possibly absent) usage onto the chat row', async () => {
    const listed = { sessions: [{ agentId: 'pi', sessionId: 's1', usage: { used: 50, size: 100 } }], acpMode: true }
    const store = new AcpStore(async (_channel, endpoint) => {
      if (endpoint === 'session/chat-list') return { ok: true, value: listed }
      return { ok: true, value: {} }
    }, zh => zh)
    const apply = (event: unknown): Promise<void> =>
      (store as unknown as { applyEvent(event: unknown): Promise<void> }).applyEvent(event)

    await store.loadChatSessions('chat-1')
    expect(store.getSnapshot().chatSessions[0]?.usage).toEqual({ used: 50, size: 100 })

    // `session/meta` is the host's latest word on this session: when it carries
    // no usage, an older reading must not outlive it on the composer's row.
    await apply({ type: 'session/meta', sessionId: 's1', session: view() })
    expect(store.getSnapshot().chatSessions[0]?.usage).toBeUndefined()
  })

  function view(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
    return {
      sessionId: 's1',
      agentId: 'pi',
      acpSessionId: 'acp-1',
      cwd: '/w',
      running: false,
      closed: false,
      seq: 0,
      ...overrides,
    }
  }

  it('keeps a released session visible, marks it released, and clears its permissions', async () => {
    const { store, apply } = await makeStore()
    await apply({ type: 'session/created', sessionId: 's1', session: view() })
    await apply({
      type: 'permission/request',
      requestId: 'r1',
      sessionId: 's1',
      dshSessionId: 'chat-1',
      toolCall: { title: 't' },
      toolName: 'Bash',
      options: [],
      timeoutMode: 'wait',
    })
    expect(store.getSnapshot().permissions).toHaveLength(1)

    await apply({ type: 'session/released', sessionId: 's1', session: view({ released: true }), reason: 'agent process exited' })
    const state = store.getSnapshot()
    expect(state.sessions).toHaveLength(1)
    expect(state.sessions[0]).toMatchObject({ sessionId: 's1', released: true })
    expect(state.permissions).toHaveLength(0)
    // No `cause` = an older host half: treated as `died`. It belongs in the
    // runtime log, not the settings page's own action-failure banner.
    expect(state.notice).toBeUndefined()
    expect(state.logs.at(-1)).toMatchObject({ level: 'error' })
    expect(state.logs.at(-1)?.text).toContain('恢复')
  })

  it('appends agent/notice to the runtime log instead of the notice banner', async () => {
    const { store, apply } = await makeStore()
    await apply({ type: 'agent/notice', agentId: 'pi', level: 'info', text: 'acp: catalog refreshed' })
    const state = store.getSnapshot()
    expect(state.notice).toBeUndefined()
    expect(state.logs).toHaveLength(1)
    expect(state.logs[0]).toMatchObject({ level: 'info', agentId: 'pi', text: 'acp: catalog refreshed' })
    expect(state.logUnread).toBe(1)
  })

  it('bounds the runtime log to the newest entries, oldest first', async () => {
    const { store, apply } = await makeStore()
    for (let i = 0; i < 205; i++) {
      await apply({ type: 'agent/notice', agentId: 'pi', level: 'info', text: `n${String(i)}` })
    }
    const logs = store.getSnapshot().logs
    expect(logs).toHaveLength(200)
    // Append order is oldest→newest; the first five fell off the front.
    expect(logs[0]?.text).toBe('n5')
    expect(logs.at(-1)?.text).toBe('n204')
    expect(store.getSnapshot().logUnread).toBe(205)
  })

  it('marks the log read and clears it on demand', async () => {
    const { store, apply } = await makeStore()
    await apply({ type: 'agent/notice', agentId: 'pi', level: 'info', text: 'one' })
    await apply({ type: 'agent/notice', agentId: 'pi', level: 'error', text: 'two' })
    expect(store.getSnapshot().logUnread).toBe(2)

    store.markLogsRead()
    expect(store.getSnapshot().logUnread).toBe(0)
    expect(store.getSnapshot().logs).toHaveLength(2)

    store.clearLogs()
    expect(store.getSnapshot().logs).toEqual([])
    expect(store.getSnapshot().logUnread).toBe(0)
  })

  it('logs a session/closed agent-died termination as an error instead of a notice', async () => {
    const { store, apply } = await makeStore()
    await apply({ type: 'session/created', sessionId: 's1', session: view() })
    await apply({ type: 'session/closed', sessionId: 's1', reason: 'agent-died' })
    const state = store.getSnapshot()
    expect(state.sessions).toHaveLength(0)
    expect(state.notice).toBeUndefined()
    expect(state.logs).toHaveLength(1)
    expect(state.logs[0]).toMatchObject({ level: 'error' })
    expect(state.logs[0]?.text).toContain('进程退出')
  })

  it('classifies every non-idle release cause into the runtime log', async () => {
    const cases = [
      { cause: 'workspace', level: 'info', text: '工作区' },
      { cause: 'resume-failed', level: 'error', text: '恢复失败' },
      { cause: 'stalled', level: 'error', text: '卡死' },
      { cause: 'died', level: 'error', text: '进程已退出' },
    ] as const
    for (const expected of cases) {
      const { store, apply } = await makeStore()
      await apply({
        type: 'session/released',
        sessionId: 's1',
        session: view({ released: true }),
        reason: expected.cause,
        cause: expected.cause,
      })
      const state = store.getSnapshot()
      expect(state.notice).toBeUndefined()
      expect(state.logs).toHaveLength(1)
      expect(state.logs[0]).toMatchObject({ level: expected.level, agentId: 'pi' })
      expect(state.logs[0]?.text).toContain(expected.text)
    }
  })

  it('copies the permission frame fields verbatim', async () => {
    const { store, apply } = await makeStore()
    const options = [
      { optionId: 'allow', name: 'Always Allow', kind: 'allow_always' },
      { optionId: 'deny', name: 'Reject', kind: 'reject_once' },
    ]
    const deadlineAt = 1_700_000_300_000
    await apply({
      type: 'permission/request',
      requestId: 'r1',
      sessionId: 'acp-1',
      dshSessionId: 'chat-1',
      // The card must not depend on this raw payload; only the host-derived
      // fields below are rendered.
      toolCall: { title: 'NOT the card title' },
      toolName: 'Bash',
      reason: 'Bash · echo hi',
      options,
      timeoutMode: 'abort',
      deadlineAt,
    })
    expect(store.getSnapshot().permissions).toEqual([{
      requestId: 'r1',
      sessionId: 'acp-1',
      dshSessionId: 'chat-1',
      toolName: 'Bash',
      reason: 'Bash · echo hi',
      options,
      timeoutMode: 'abort',
      deadlineAt,
    }])
    // The old local title derived from `toolCall.title` is gone.
    expect(store.getSnapshot().permissions[0]).not.toHaveProperty('title')
  })

  it('re-establishes the pending asks on reconnect and prunes the stale ones', async () => {
    // A `permission/request` is broadcast ONCE, so a client that connects later
    // never learns the ask exists. The stream replays every outstanding ask and
    // terminates with the live id set; this client holds one ask that was
    // resolved while it was disconnected, which must not survive as a card that
    // can only answer `unknown_request`.
    const { store, apply } = await makeStore()
    await apply({
      type: 'permission/request',
      requestId: 'stale',
      sessionId: 's1',
      dshSessionId: 'chat-1',
      toolCall: { title: 'old' },
      toolName: 'Bash',
      options: [],
      timeoutMode: 'wait',
    })
    await apply({
      type: 'permission/request',
      requestId: 'live',
      sessionId: 's2',
      dshSessionId: 'chat-1',
      toolCall: { title: 'new' },
      toolName: 'Write',
      reason: 'Write · /w/a.ts',
      options: [{ optionId: 'ok', name: 'Allow', kind: 'allow_once' }],
      timeoutMode: 'auto',
      deadlineAt: 1_700_000_300_000,
    })
    expect(store.getSnapshot().permissions.map(p => p.requestId)).toEqual(['stale', 'live'])

    // The replay re-sends the outstanding ask (idempotent by request id — it may
    // also have arrived live) and then names what is actually live. The replay
    // keeps every frame field, not just the id.
    await apply({
      type: 'permission/request',
      requestId: 'live',
      sessionId: 's2',
      dshSessionId: 'chat-1',
      toolCall: { title: 'new' },
      toolName: 'Write',
      reason: 'Write · /w/a.ts',
      options: [{ optionId: 'ok', name: 'Allow', kind: 'allow_once' }],
      timeoutMode: 'auto',
      deadlineAt: 1_700_000_300_000,
    })
    await apply({ type: 'permission/synced', requestIds: ['live'] })
    expect(store.getSnapshot().permissions.map(p => p.requestId)).toEqual(['live'])
    expect(store.getSnapshot().permissions[0]).toMatchObject({
      sessionId: 's2',
      dshSessionId: 'chat-1',
      toolName: 'Write',
      reason: 'Write · /w/a.ts',
      timeoutMode: 'auto',
      deadlineAt: 1_700_000_300_000,
    })

    // An answered ask is pruned on its own frame, leaving the others alone.
    await apply({ type: 'permission/resolved', requestId: 'live', sessionId: 's2', outcome: { outcome: 'cancelled' } })
    expect(store.getSnapshot().permissions).toEqual([])

    // Nothing outstanding at all: the terminator alone must clear the list.
    await apply({ type: 'permission/synced', requestIds: [] })
    expect(store.getSnapshot().permissions).toEqual([])
  })

  it('filters pending asks by DSH chat session and never shows an ask with no chat identity', async () => {
    const { store, apply } = await makeStore()
    await apply({
      type: 'permission/request',
      requestId: 'mine',
      sessionId: 'acp-1',
      dshSessionId: 'chat-1',
      toolCall: {},
      toolName: 'Bash',
      options: [],
      timeoutMode: 'wait',
    })
    await apply({
      type: 'permission/request',
      requestId: 'other',
      sessionId: 'acp-2',
      dshSessionId: 'chat-2',
      toolCall: {},
      toolName: 'Write',
      options: [],
      timeoutMode: 'wait',
    })
    // An `/acp` RPC-only ask: pending, but belonging to no conversation.
    await apply({
      type: 'permission/request',
      requestId: 'rpc-only',
      sessionId: 'acp-3',
      toolCall: {},
      toolName: 'Bash',
      options: [],
      timeoutMode: 'wait',
    })
    const permissions = store.getSnapshot().permissions
    expect(permissionsForSession(permissions, 'chat-1').map(p => p.requestId)).toEqual(['mine'])
    expect(permissionsForSession(permissions, 'chat-2').map(p => p.requestId)).toEqual(['other'])
    expect(permissionsForSession(permissions, 'chat-3')).toEqual([])
  })

  it('reports a failed permission answer and rethrows it to the caller', async () => {
    // The dock pins the failure next to the card, so the error must not be
    // swallowed behind the settings page's notice.
    const store = new AcpStore(
      async (_channel, endpoint) => (endpoint === 'permission/respond'
        ? { ok: false, error: { code: 'unknown_request', message: 'ask is gone' } }
        : { ok: true, value: {} }),
      (zh) => zh,
    )
    await expect(store.respondPermission('r1', 'allow')).rejects.toThrow('ask is gone')
    expect(store.getSnapshot().notice).toBe('ask is gone')
  })

  it('resets blocks and the seq watermark on session/reset so the replay folds fresh', async () => {
    const { store, apply } = await makeStore()
    await apply({ type: 'session/created', sessionId: 's1', session: view() })
    await apply({ type: 'turn/start', sessionId: 's1', turnId: 't1', text: 'hi' })
    await apply({ type: 'session/update', sessionId: 's1', seq: 1, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'old' } } })
    expect(store.getSnapshot().blocks.length).toBeGreaterThan(0)

    await apply({ type: 'session/reset', sessionId: 's1', session: view() })
    expect(store.getSnapshot().blocks).toEqual([])

    // The replay restarts at seq 1; a stale watermark would have triggered a
    // gap refetch instead of folding.
    await apply({ type: 'session/update', sessionId: 's1', seq: 1, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'replayed' } } })
    expect(store.getSnapshot().blocks).toEqual([{ kind: 'agent', text: 'replayed' }])
  })

  it('applies only the first turn/end per open turn (cancel fallback + late real end)', async () => {
    const { store, apply } = await makeStore()
    await apply({ type: 'session/created', sessionId: 's1', session: view() })
    await apply({ type: 'turn/start', sessionId: 's1', turnId: 't1', text: 'hi' })
    await apply({ type: 'turn/end', sessionId: 's1', turnId: '', error: 'force-finalized' })
    expect(store.getSnapshot().blocks).toEqual([expect.objectContaining({ kind: 'user' }), expect.objectContaining({ kind: 'notice', tone: 'error' })])

    // The late real turn/end for the same turn must not duplicate the notice.
    await apply({ type: 'turn/end', sessionId: 's1', turnId: 't1', stopReason: 'end_turn' })
    expect(store.getSnapshot().blocks).toHaveLength(2)

    // A new turn opens the window again.
    await apply({ type: 'turn/start', sessionId: 's1', turnId: 't2', text: 'again' })
    await apply({ type: 'turn/end', sessionId: 's1', turnId: 't2', stopReason: 'end_turn' })
    expect(store.getSnapshot().blocks).toHaveLength(3)
  })

  it('refuses a transcript answer that is behind what this page already folded', async () => {
    // The host fills its transcript from the notification pipeline, which the
    // SDK paces independently of the `session/prompt` response — so a read taken
    // right after a turn can still be missing the agent's last chunk. A refetch
    // that lands inside that window used to REPLACE the folded blocks with the
    // short answer, truncating a turn the user had just watched finish.
    const store = new AcpStore(async (_channel, endpoint) => {
      if (endpoint !== 'transcript/get') return { ok: true, value: {} }
      // Deliberately behind: only the first of the two chunks this page folds.
      return { ok: true, value: { session: view(), entries: [
        { seq: 1, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hello' } } },
      ] } }
    }, (zh) => zh)
    const apply = (event: unknown): Promise<void> =>
      (store as unknown as { applyEvent(event: unknown): Promise<void> }).applyEvent(event)

    store.selectSession('s1')
    await apply({ type: 'session/created', sessionId: 's1', session: view() })
    await apply({ type: 'turn/start', sessionId: 's1', turnId: 't1', text: 'hi' })
    await apply({ type: 'session/update', sessionId: 's1', seq: 1, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hello' } } })
    await apply({ type: 'session/update', sessionId: 's1', seq: 2, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: ' world' } } })
    expect(store.getSnapshot().blocks).toEqual([{ kind: 'agent', text: 'Hello world' }])

    // The stale answer must not replace the fold…
    store.selectSession('s1')
    // `selectSession` fires the refetch without awaiting it; let it land, so the
    // assertion is about the answer's effect and not about it still being in flight.
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(store.getSnapshot().blocks).toEqual([{ kind: 'agent', text: 'Hello world' }])

    // …but an answer that has caught up still refetches (a fresh mount, or a
    // genuine replay after `session/reset` zeroed the watermark).
    const caught = new AcpStore(async (_channel, endpoint) => {
      if (endpoint !== 'transcript/get') return { ok: true, value: {} }
      return { ok: true, value: { session: view(), entries: [
        { seq: 1, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hello' } } },
        { seq: 2, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: ' world' } } },
      ] } }
    }, (zh) => zh)
    caught.selectSession('s1')
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(caught.getSnapshot().blocks).toEqual([{ kind: 'agent', text: 'Hello world' }])
  })
})

describe('AcpStore observed ACP transcripts (the ACP view tab)', () => {
  function view(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
    return {
      sessionId: 'acp-s1',
      agentId: 'pi',
      acpSessionId: 'acp-1',
      cwd: '/w',
      running: false,
      closed: false,
      seq: 0,
      ...overrides,
    }
  }

  /** Views keyed by chat session: only `chat-1` has an ACP session behind it. */
  const viewsByChat: Record<string, unknown[]> = {
    'chat-1': [{
      session: view(),
      entries: [
        { seq: 1, update: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'hi' } } },
        { seq: 2, update: { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'read a.ts', kind: 'read', status: 'completed', content: [{ type: 'diff', path: 'a.ts', oldText: 'x\n', newText: 'y\n' }] } },
      ],
    }],
  }

  function makeStore(overrides: Record<string, unknown[]> = viewsByChat): { store: AcpStore; apply: (event: unknown) => Promise<void> } {
    const store = new AcpStore(async (_channel, endpoint, payload) => {
      if (endpoint === 'session/chat-transcript') {
        const id = String((payload as { dshSessionId?: unknown }).dshSessionId)
        return { ok: true, value: { views: overrides[id] ?? [] } }
      }
      return { ok: true, value: {} }
    }, (zh) => zh)
    const apply = (event: unknown): Promise<void> =>
      (store as unknown as { applyEvent(event: unknown): Promise<void> }).applyEvent(event)
    return { store, apply }
  }

  it('observes a chat session\'s ACP transcripts by chat id and keeps its structured diffs', async () => {
    const { store } = makeStore()
    await store.loadChatTranscript('chat-1')

    const record = store.chatTranscriptOf('chat-1')
    expect(record?.blocks.map(block => block.kind)).toEqual(['user', 'tool'])
    expect(record?.seq).toBe(2)
    expect(record?.blocks[1]).toMatchObject({
      kind: 'tool',
      diffs: [{ path: 'a.ts', oldText: 'x\n', newText: 'y\n' }],
    })

    // A different chat session is its own address and must not inherit anything.
    expect(store.chatTranscriptOf('chat-2')).toBeUndefined()
    await store.loadChatTranscript('chat-2')
    expect(store.chatTranscriptOf('chat-1')?.blocks).toHaveLength(2)
    expect(store.chatTranscriptOf('chat-2')).toBeUndefined()
  })

  it('folds live frames into an observed transcript that the panel never selected', async () => {
    const { store, apply } = makeStore()
    await store.loadChatTranscript('chat-1')

    // The native chat's ACP session is NOT the panel's active session — that
    // asymmetry is the whole reason this buffer exists.
    expect(store.getSnapshot().activeSessionId).toBeUndefined()
    await apply({
      type: 'session/update',
      sessionId: 'acp-s1',
      seq: 3,
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'done' } },
    })
    expect(store.chatTranscriptOf('chat-1')?.blocks.at(-1)).toMatchObject({ kind: 'agent', text: 'done' })
    expect(store.chatTranscriptOf('chat-1')?.seq).toBe(3)
    // …and the panel's own block list stayed untouched by it.
    expect(store.getSnapshot().blocks).toEqual([])

    // A session nobody is observing is not buffered at all.
    await apply({
      type: 'session/update',
      sessionId: 'acp-other',
      seq: 1,
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'x' } },
    })
    expect(store.getSnapshot().chatTranscripts['acp-other']).toBeUndefined()
  })

  it('clears an observed transcript on session/reset and drops it on session/closed', async () => {
    const { store, apply } = makeStore()
    await store.loadChatTranscript('chat-1')
    await apply({ type: 'session/reset', sessionId: 'acp-s1', session: view() })
    expect(store.chatTranscriptOf('chat-1')?.blocks).toEqual([])
    expect(store.chatTranscriptOf('chat-1')?.seq).toBe(0)

    await apply({ type: 'session/closed', sessionId: 'acp-s1', reason: 'closed' })
    expect(store.chatTranscriptOf('chat-1')).toBeUndefined()
  })

  it('mirrors released and running onto an observed transcript', async () => {
    const { store, apply } = makeStore()
    await store.loadChatTranscript('chat-1')
    await apply({ type: 'session/released', sessionId: 'acp-s1', session: view({ released: true }), reason: 'agent died' })
    expect(store.chatTranscriptOf('chat-1')?.session).toMatchObject({ released: true })
    expect(store.chatTranscriptOf('chat-1')?.blocks).toHaveLength(2)

    await apply({ type: 'turn/start', sessionId: 'acp-s1', turnId: 't9', text: 'again' })
    expect(store.chatTranscriptOf('chat-1')?.session.running).toBe(true)
    await apply({ type: 'turn/end', sessionId: 'acp-s1', turnId: 't9', stopReason: 'end_turn' })
    expect(store.chatTranscriptOf('chat-1')?.session.running).toBe(false)
  })

  it('flips the composer session view to released on session/released', async () => {
    // The agent tag's live halo reads this list; without the flip it keeps
    // breathing for a process that is gone until the next turn re-reads.
    let listed = { sessions: [{ agentId: 'pi', sessionId: 'acp-s1' }] }
    const store = new AcpStore(async (_channel, endpoint) => {
      if (endpoint === 'session/chat-list') return { ok: true, value: listed }
      return { ok: true, value: {} }
    }, (zh) => zh)
    const apply = (event: unknown): Promise<void> =>
      (store as unknown as { applyEvent(event: unknown): Promise<void> }).applyEvent(event)

    await store.loadChatSessions('chat-1')
    expect(store.getSnapshot().chatSessions[0]).toMatchObject({ sessionId: 'acp-s1' })
    expect(store.getSnapshot().chatSessions[0]?.released).toBeUndefined()

    await apply({ type: 'session/released', sessionId: 'acp-s1', session: view({ released: true }), reason: 'idle release', cause: 'idle' })
    expect(store.getSnapshot().chatSessions[0]).toMatchObject({ sessionId: 'acp-s1', released: true })
    // An idle release is expected lifecycle: no runtime-log line, no notice.
    expect(store.getSnapshot().logs).toHaveLength(0)
    expect(store.getSnapshot().notice).toBeUndefined()

    // Resuming on a fresh process flips the row back live on `session/reset` —
    // the same stream the banner and the halo read, with no re-read in
    // between (a resume must not leave the banner claiming a parked process).
    await apply({ type: 'session/reset', sessionId: 'acp-s1', session: view() })
    expect(store.getSnapshot().chatSessions[0]?.released).toBe(false)
  })

  it('bounds how many transcripts stay resident', async () => {
    const wide: Record<string, unknown[]> = {}
    for (let i = 0; i < 9; i++) {
      wide[`chat-${String(i)}`] = [{ session: view({ sessionId: `acp-${String(i)}`, agentId: 'pi' }), entries: [] }]
    }
    const { store } = makeStore(wide)
    for (let i = 0; i < 9; i++) await store.loadChatTranscript(`chat-${String(i)}`)
    const ids = Object.keys(store.getSnapshot().chatTranscripts)
    expect(ids).toHaveLength(6)
    // The newest window survives; the oldest is the one evicted.
    expect(ids).toContain('acp-8')
    expect(ids).not.toContain('acp-0')
  })
})

describe('the conversation↔agent binding (no DSH model route)', () => {
  /** A store that records every call and answers the panel's resync endpoints. */
  function makeStore(defaultAgentId?: string) {
    const calls: Array<{ endpoint: string; payload: unknown }> = []
    const store = new AcpStore(async (_channel, endpoint, payload) => {
      calls.push({ endpoint, payload })
      if (endpoint === 'agents/list') return { ok: true, value: { agents: [] } }
      if (endpoint === 'sessions/list') return { ok: true, value: { sessions: [] } }
      if (endpoint === 'agents/detect') return { ok: true, value: { agents: [] } }
      if (endpoint === 'default/agent') return { ok: true, value: { ...(defaultAgentId === undefined ? {} : { agentId: defaultAgentId }) } }
      if (endpoint === 'session/chat-list') return { ok: true, value: { sessions: [], acpMode: false } }
      return { ok: true, value: {} }
    }, (zh) => zh)
    return { store, calls }
  }

  it('binds, re-models, re-efforts and configures a conversation through its own RPCs', async () => {
    const { store, calls } = makeStore()

    await store.bindChatAgent('chat-1', 'codebuddy')
    await store.setChatSessionModel('chat-1', 'codebuddy@hy3')
    await store.setChatSessionEffort('chat-1', 'high')
    await store.setChatSessionEffort('chat-1', undefined)
    await store.setChatSessionConfig('chat-1', 'temp', 'high')
    // A toggle keeps its boolean across the RPC; the checkbox value is not
    // stringified on the way out.
    await store.setChatSessionConfig('chat-1', 'stream', true)

    expect(calls.map(c => c.endpoint)).toEqual([
      'session/chat-bind', 'session/chat-model-set', 'session/chat-effort-set', 'session/chat-effort-set',
      'session/chat-config-set', 'session/chat-config-set',
    ])
    expect(calls[0].payload).toEqual({ dshSessionId: 'chat-1', agentId: 'codebuddy' })
    expect(calls[1].payload).toEqual({ dshSessionId: 'chat-1', modelId: 'codebuddy@hy3' })
    expect(calls[2].payload).toEqual({ dshSessionId: 'chat-1', effort: 'high' })
    // An absent effort is a clear, not an empty string.
    expect(calls[3].payload).toEqual({ dshSessionId: 'chat-1' })
    expect(calls[4].payload).toEqual({ dshSessionId: 'chat-1', configId: 'temp', value: 'high' })
    expect(calls[5].payload).toEqual({ dshSessionId: 'chat-1', configId: 'stream', value: true })
    // The advanced pick is part of the SAME conversation record, written
    // optimistically so the menu's checkmark moves on the click.
    expect(store.getSnapshot().chatChoice['chat-1']).toMatchObject({
      agentId: 'codebuddy',
      modelId: 'codebuddy@hy3',
      extraConfigs: { temp: 'high', stream: true },
    })
  })

  it('attributes a pick to the plugin default before anything was bound', async () => {
    // A fresh conversation served by the default agent has no binding and no
    // choice yet. The host records the pick for that agent; the optimistic
    // chip must do the same instead of waiting for the next `session/chat-list`.
    const { store, calls } = makeStore('codebuddy')
    await store.resync()
    await store.setChatSessionEffort('chat-2', 'high', 'codebuddy')
    expect(calls.at(-1)).toEqual({
      endpoint: 'session/chat-effort-set',
      payload: { dshSessionId: 'chat-2', effort: 'high', agentId: 'codebuddy' },
    })
    expect(store.getSnapshot().chatChoice['chat-2']).toEqual({ agentId: 'codebuddy', effort: 'high' })
  })

  it('surfaces a failed binding as a notice AND rethrows, so the menu shows the error', async () => {
    const store = new AcpStore(async (_channel, endpoint) => {
      if (endpoint === 'session/chat-bind') return { ok: false, error: { code: 'unknown_agent', message: 'no such agent' } }
      return { ok: true, value: {} }
    }, (zh) => zh)

    await expect(store.bindChatAgent('chat-1', 'ghost')).rejects.toThrow('no such agent')
    expect(store.getSnapshot().notice).toBe('no such agent')
  })

  it('reads the plugin default agent from default/agent and sets it back', async () => {
    const { store, calls } = makeStore('codebuddy')

    await store.resync()
    expect(store.getSnapshot().defaultAgent).toBe('codebuddy')

    // No default agent chosen: absent, not a fallback.
    const bare = makeStore()
    await bare.store.resync()
    expect(bare.store.getSnapshot().defaultAgent).toBeUndefined()

    await store.setDefaultAgent('pi')
    expect(calls.at(-1)).toEqual({ endpoint: 'default/agent-set', payload: { agentId: 'pi' } })
    expect(store.getSnapshot().defaultAgent).toBe('pi')

    // Clearing is legal (the only way to remove a star).
    await store.setDefaultAgent(undefined)
    expect(calls.at(-1)).toEqual({ endpoint: 'default/agent-set', payload: {} })
    expect(store.getSnapshot().defaultAgent).toBeUndefined()
  })
})

describe('AcpStore plugin updates', () => {
  it('reads the update state, throttles repeat checks, and honors force', async () => {
    let now = 1_000_000
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => now)
    try {
      const endpoints: string[] = []
      const store = new AcpStore(async (_channel, endpoint) => {
        endpoints.push(endpoint)
        if (endpoint === 'plugin/update-check') {
          return { ok: true, value: { status: 'available', current: '0.2.1', installed: '0.2.1', latest: '9.9.9' } }
        }
        return { ok: true, value: {} }
      }, (zh) => zh)

      expect(await store.checkPluginUpdate()).toMatchObject({ status: 'available', latest: '9.9.9' })
      expect(store.getSnapshot().pluginUpdate).toMatchObject({ status: 'available', latest: '9.9.9' })
      expect(endpoints.filter(endpoint => endpoint === 'plugin/update-check')).toHaveLength(1)

      // Every settings mount inside the window answers from the held state.
      await store.checkPluginUpdate()
      expect(endpoints.filter(endpoint => endpoint === 'plugin/update-check')).toHaveLength(1)

      now += 10 * 60 * 1000
      await store.checkPluginUpdate()
      expect(endpoints.filter(endpoint => endpoint === 'plugin/update-check')).toHaveLength(2)

      // The card's own button always goes out.
      await store.checkPluginUpdate(true)
      expect(endpoints.filter(endpoint => endpoint === 'plugin/update-check')).toHaveLength(3)
    } finally {
      nowSpy.mockRestore()
    }
  })

  it('coalesces concurrent checks into one RPC, force included', async () => {
    let release: (() => void) | undefined
    const gate = new Promise<void>(resolve => { release = resolve })
    let calls = 0
    const store = new AcpStore(async (_channel, endpoint) => {
      if (endpoint !== 'plugin/update-check') return { ok: true, value: {} }
      calls += 1
      await gate
      return { ok: true, value: { status: 'available', current: '0.2.1', installed: '0.2.1', latest: '9.9.9' } }
    }, (zh) => zh)

    const first = store.checkPluginUpdate()
    const second = store.checkPluginUpdate(true)
    expect(calls).toBe(1)
    release?.()
    expect(await first).toMatchObject({ status: 'available' })
    expect(await second).toEqual(await first)
    expect(calls).toBe(1)
  })

  it('applies the exact latest version and adopts the host answer', async () => {
    const calls: Array<{ endpoint: string; payload: unknown }> = []
    const applied = { status: 'restart-required', current: '0.2.1', installed: '9.9.9', latest: '9.9.9' }
    const store = new AcpStore(async (_channel, endpoint, payload) => {
      calls.push({ endpoint, payload })
      if (endpoint === 'plugin/update-check') {
        return { ok: true, value: { status: 'available', current: '0.2.1', installed: '0.2.1', latest: '9.9.9' } }
      }
      if (endpoint === 'plugin/update-apply') return { ok: true, value: applied }
      return { ok: true, value: {} }
    }, (zh) => zh)

    await store.checkPluginUpdate()
    expect(await store.applyPluginUpdate('9.9.9')).toEqual(applied)
    expect(store.getSnapshot().pluginUpdate).toEqual(applied)
    expect(calls.filter(call => call.endpoint === 'plugin/update-apply')).toEqual([{
      endpoint: 'plugin/update-apply', payload: { version: '9.9.9' },
    }])
    expect(store.getSnapshot().notice).toBeUndefined()
  })

  it('fires one install for a double apply', async () => {
    let release: (() => void) | undefined
    const gate = new Promise<void>(resolve => { release = resolve })
    const endpoints: string[] = []
    const applied = { status: 'restart-required', current: '0.2.1', installed: '9.9.9', latest: '9.9.9' }
    const store = new AcpStore(async (_channel, endpoint) => {
      endpoints.push(endpoint)
      if (endpoint === 'plugin/update-check') {
        return { ok: true, value: { status: 'available', current: '0.2.1', installed: '0.2.1', latest: '9.9.9' } }
      }
      if (endpoint === 'plugin/update-apply') {
        await gate
        return { ok: true, value: applied }
      }
      return { ok: true, value: {} }
    }, (zh) => zh)

    await store.checkPluginUpdate()
    const first = store.applyPluginUpdate('9.9.9')
    const second = store.applyPluginUpdate('9.9.9')
    expect(await second).toBeUndefined()
    expect(endpoints.filter(endpoint => endpoint === 'plugin/update-apply')).toHaveLength(1)
    release?.()
    expect(await first).toEqual(applied)
  })

  it('keeps the disk-may-have-changed fact when the install response is interrupted', async () => {
    const endpoints: string[] = []
    const store = new AcpStore(async (_channel, endpoint) => {
      endpoints.push(endpoint)
      if (endpoint === 'plugin/update-check') {
        return { ok: true, value: { status: 'available', current: '0.2.1', installed: '0.2.1', latest: '9.9.9' } }
      }
      if (endpoint === 'plugin/update-apply') throw new Error('socket hang up')
      return { ok: true, value: {} }
    }, (zh) => zh)

    await store.checkPluginUpdate()
    expect(await store.applyPluginUpdate('9.9.9')).toBeUndefined()
    // The update may have completed (HMR uninstall/reinstall); never claim
    // the disk did not change, and never claim the new version is installed.
    const state = store.getSnapshot().pluginUpdate
    expect(state).toMatchObject({
      status: 'restart-required', current: '0.2.1', latest: '9.9.9', message: 'socket hang up',
    })
    // The disk version is unknown, not a fact: no `installed` may survive.
    expect(state?.installed).toBeUndefined()
    expect(store.getSnapshot().notice).toBe('更新请求已中断；请刷新页面确认当前版本。')
    // The throttle was reset, so the next ordinary check really asks the host
    // instead of serving this unknown verdict for ten minutes.
    const checksBefore = endpoints.filter(endpoint => endpoint === 'plugin/update-check').length
    await store.checkPluginUpdate()
    expect(endpoints.filter(endpoint => endpoint === 'plugin/update-check').length).toBe(checksBefore + 1)
  })

  it('drops a check that lands after an apply started (generation guard)', async () => {
    let releaseCheck: (() => void) | undefined
    const gate = new Promise<void>(resolve => { releaseCheck = resolve })
    const applied = { status: 'applied', current: '0.2.1', installed: '9.9.9', latest: '9.9.9' }
    const store = new AcpStore(async (_channel, endpoint) => {
      if (endpoint === 'plugin/update-check') {
        await gate
        return { ok: true, value: { status: 'available', current: '0.2.1', installed: '0.2.1', latest: '9.9.9' } }
      }
      if (endpoint === 'plugin/update-apply') return { ok: true, value: applied }
      return { ok: true, value: {} }
    }, (zh) => zh)

    const check = store.checkPluginUpdate()
    expect(await store.applyPluginUpdate('9.9.9')).toEqual(applied)
    releaseCheck?.()
    // The pre-install read answers `available`; it must not overwrite the
    // install's verdict.
    expect(await check).toBeUndefined()
    expect(store.getSnapshot().pluginUpdate).toEqual(applied)
  })

  it('drops a check that started during an install and lands after it settles', async () => {
    let releaseApply: (() => void) | undefined
    const applyGate = new Promise<void>(resolve => { releaseApply = resolve })
    let releaseCheck: (() => void) | undefined
    const checkGate = new Promise<void>(resolve => { releaseCheck = resolve })
    const applied = { status: 'applied', current: '0.2.1', installed: '9.9.9', latest: '9.9.9' }
    const store = new AcpStore(async (_channel, endpoint) => {
      if (endpoint === 'plugin/update-check') {
        await checkGate
        // The host saw the install in progress; this answer is stale by the
        // time it lands.
        return { ok: true, value: { status: 'applying', current: '0.2.1' } }
      }
      if (endpoint === 'plugin/update-apply') {
        await applyGate
        return { ok: true, value: applied }
      }
      return { ok: true, value: {} }
    }, (zh) => zh)

    const apply = store.applyPluginUpdate('9.9.9')
    const check = store.checkPluginUpdate()
    releaseApply?.()
    expect(await apply).toEqual(applied)
    releaseCheck?.()
    expect(await check).toBeUndefined()
    expect(store.getSnapshot().pluginUpdate).toEqual(applied)
  })

  it('treats a host without the endpoint as a silent degradation', async () => {
    const store = new AcpStore(async () => ({
      ok: false, error: { code: 'unknown_endpoint', message: 'acp: unknown endpoint plugin/update-check' },
    }), (zh) => zh)

    expect(await store.checkPluginUpdate()).toBeUndefined()
    expect(store.getSnapshot().pluginUpdate).toBeUndefined()
    // An older host is a normal deployment, not an error to flash.
    expect(store.getSnapshot().notice).toBeUndefined()
  })
})
