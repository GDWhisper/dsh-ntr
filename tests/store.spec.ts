import { describe, expect, it, vi } from 'vitest'
import { AcpStore, composeSaveBanners, foldUpdate, forkStateOf, permissionsForSession, replayChatRowFrames, saveGateTransitions, skillRowsKey, subagentKey, SKILL_MENU_TTL_MS, type Block, type RpcCall, type SaveBanner, type SubagentDetailState } from '../src/client/store.ts'
import { acpModeFromPresetEvent, stagedIsAcpMode } from '../src/client/acp-ui.tsx'
import { resolveHostFork } from '../src/client/branch-action.tsx'
import { releasedBannerVisible } from '../src/client/released-banner.tsx'
import type { AcpAgentDef, AgentSkillEntry, ChatSessionView, DetectedAgentInfo, SubagentRecord } from '../src/protocol.ts'

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

  it('reads the title-prefix toggle on resync and writes it back optimistically', async () => {
    const sent: Array<Record<string, unknown>> = []
    const store = new (await import('../src/client/store.ts')).AcpStore(
      async (_channel, endpoint, payload) => {
        if (endpoint === 'agents/list') return { ok: true, value: { agents: [] } }
        if (endpoint === 'sessions/list') return { ok: true, value: { sessions: [] } }
        if (endpoint === 'agents/detect') return { ok: true, value: { agents: [] } }
        if (endpoint === 'ui/session-title-prefix') return { ok: true, value: { titlePrefix: true } }
        if (endpoint === 'ui/session-title-prefix-set') { sent.push(payload as Record<string, unknown>); return { ok: true, value: {} } }
        return { ok: true, value: {} }
      },
      (zh) => zh,
    )
    // The host answer is the authority; the initial local default gives way.
    await store.resync()
    expect(store.getSnapshot().titlePrefix).toBe(true)

    // The write lands optimistically and the RPC carries the boolean under
    // the key the host route validates — a store↔host key drift fails here.
    await store.setTitlePrefix(false)
    expect(store.getSnapshot().titlePrefix).toBe(false)
    expect(sent).toEqual([{ titlePrefix: false }])

    // A failed write reverts to the previous setting instead of leaving the
    // row showing something the host refused.
    const failing = new (await import('../src/client/store.ts')).AcpStore(
      async (_channel, endpoint) => {
        if (endpoint === 'agents/list') return { ok: true, value: { agents: [] } }
        if (endpoint === 'sessions/list') return { ok: true, value: { sessions: [] } }
        if (endpoint === 'agents/detect') return { ok: true, value: { agents: [] } }
        if (endpoint === 'ui/session-title-prefix-set') return { ok: false, error: { code: 'bad_payload', message: 'no' } }
        return { ok: true, value: {} }
      },
      (zh) => zh,
    )
    await failing.resync()
    await failing.setTitlePrefix(true)
    // The revert target is what resync last knew: the default (off), because
    // this mock never answers `ui/session-title-prefix`.
    expect(failing.getSnapshot().titlePrefix).toBe(false)
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

  it('records a live turn/metrics frame in burstStats and notifies subscribers', async () => {
    const { store, apply } = await makeStore()
    let notified = 0
    store.subscribe(() => { notified++ })

    await apply({ type: 'turn/metrics', sessionId: 's1', dshSessionId: 'chat-1', turnId: 't1', outputTokens: 120, burstMs: 900, final: false })

    expect(notified).toBe(1)
    expect(store.getSnapshot().burstStats.s1).toEqual({ outputTokens: 120, burstMs: 900, turnId: 't1', final: false })
  })

  it('ignores a late live turn/metrics frame for a turn already finalized', async () => {
    const { store, apply } = await makeStore()
    await apply({ type: 'turn/metrics', sessionId: 's1', dshSessionId: 'chat-1', turnId: 't1', outputTokens: 200, burstMs: 1500, final: true })
    let notified = 0
    store.subscribe(() => { notified++ })

    // A stream reconnect can deliver the earlier live frame after the final
    // one; it must not regress the finalized aggregate.
    await apply({ type: 'turn/metrics', sessionId: 's1', dshSessionId: 'chat-1', turnId: 't1', outputTokens: 150, burstMs: 1200, final: false })

    expect(notified).toBe(0)
    expect(store.getSnapshot().burstStats.s1).toEqual({ outputTokens: 200, burstMs: 1500, turnId: 't1', final: true })
  })

  it('accepts a live frame from a new turn after the previous one finalized', async () => {
    const { store, apply } = await makeStore()
    await apply({ type: 'turn/metrics', sessionId: 's1', dshSessionId: 'chat-1', turnId: 't1', outputTokens: 200, burstMs: 1500, final: true })

    await apply({ type: 'turn/metrics', sessionId: 's1', dshSessionId: 'chat-1', turnId: 't2', outputTokens: 250, burstMs: 1800, final: false })

    expect(store.getSnapshot().burstStats.s1).toEqual({ outputTokens: 250, burstMs: 1800, turnId: 't2', final: false })
  })

  it('drops only the closing session burstStats entry on session/closed', async () => {
    const { store, apply } = await makeStore()
    await apply({ type: 'session/created', sessionId: 's1', session: view() })
    await apply({ type: 'turn/metrics', sessionId: 's1', dshSessionId: 'chat-1', turnId: 't1', outputTokens: 10, burstMs: 50, final: true })
    await apply({ type: 'turn/metrics', sessionId: 's2', dshSessionId: 'chat-2', turnId: 't9', outputTokens: 20, burstMs: 60, final: true })

    await apply({ type: 'session/closed', sessionId: 's1', reason: 'closed' })

    const state = store.getSnapshot()
    expect(state.burstStats.s1).toBeUndefined()
    expect(state.burstStats.s2).toEqual({ outputTokens: 20, burstMs: 60, turnId: 't9', final: true })
  })

  it('leaves blocks and sessions untouched on turn/metrics', async () => {
    const { store, apply } = await makeStore()
    await apply({ type: 'session/created', sessionId: 's1', session: view() })
    await apply({ type: 'turn/start', sessionId: 's1', turnId: 't1', text: 'hi' })
    const blocksBefore = store.getSnapshot().blocks
    const sessionsBefore = store.getSnapshot().sessions

    await apply({ type: 'turn/metrics', sessionId: 's1', dshSessionId: 'chat-1', turnId: 't1', outputTokens: 5, burstMs: 40, final: false })

    const state = store.getSnapshot()
    expect(state.blocks).toBe(blocksBefore)
    expect(state.sessions).toBe(sessionsBefore)
    expect(state.burstStats.s1).toMatchObject({ turnId: 't1' })
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

describe('AcpStore subagent lifecycle records (the panel data layer)', () => {
  function record(overrides: Partial<SubagentRecord> = {}): SubagentRecord {
    return {
      childId: 'acp:call-1',
      dshSessionId: 'chat-1',
      toolCallId: 'call-1',
      label: 'general-purpose · audit',
      status: 'pending',
      startedAt: 1_000,
      lastActivityAt: 1_000,
      counts: { updates: 1, toolCalls: 0, textChars: 0 },
      ...overrides,
    }
  }

  function makeStore(rpc: (endpoint: string, payload: unknown) => Promise<{ ok: boolean; value?: unknown; error?: { code: string; message: string } }> = async () => ({ ok: true, value: {} })) {
    const calls: Array<{ endpoint: string; payload: unknown }> = []
    const store = new AcpStore(async (_channel, endpoint, payload) => {
      calls.push({ endpoint, payload })
      return rpc(endpoint, payload) as never
    }, (zh) => zh)
    const apply = (event: unknown): Promise<void> =>
      (store as unknown as { applyEvent(event: unknown): Promise<void> }).applyEvent(event)
    return { store, calls, apply }
  }

  // The components read the keyed snapshot maps directly; the tests do too.
  const recordOf = (store: AcpStore, childId: string, dshSessionId = 'chat-1'): SubagentRecord | undefined =>
    store.getSnapshot().subagents[subagentKey(dshSessionId, childId)]
  const recordsOf = (store: AcpStore, dshSessionId: string): SubagentRecord[] =>
    Object.values(store.getSnapshot().subagents).filter(row => row.dshSessionId === dshSessionId)
  const detailOf = (store: AcpStore, childId: string): SubagentDetailState | undefined =>
    store.getSnapshot().subagentDetails[subagentKey('chat-1', childId)]

  it('folds creation and every transition, keyed by conversation + child id', async () => {
    const { store, apply } = makeStore()
    await apply({ type: 'subagents/record', dshSessionId: 'chat-1', record: record() })
    expect(recordOf(store, 'acp:call-1')?.status).toBe('pending')
    // The same child id in another conversation is a different record.
    await apply({ type: 'subagents/record', dshSessionId: 'chat-2', record: record({ dshSessionId: 'chat-2', status: 'running' }) })

    await apply({
      type: 'subagents/record',
      dshSessionId: 'chat-1',
      record: record({ status: 'failed', endedAt: 2_000, error: 'boom' }),
    })
    expect(recordOf(store, 'acp:call-1')?.status).toBe('failed')
    expect(recordOf(store, 'acp:call-1')?.error).toBe('boom')
    expect(recordOf(store, 'acp:call-1', 'chat-2')?.status).toBe('running')

    // A stale in-flight frame must not revive a terminal row.
    await apply({ type: 'subagents/record', dshSessionId: 'chat-1', record: record({ status: 'running' }) })
    expect(recordOf(store, 'acp:call-1')?.status).toBe('failed')
    expect(recordsOf(store, 'chat-1')).toHaveLength(1)
  })

  it('seeds records from session/chat-list, de-duplicates across rows, and replays in-flight frames', async () => {
    // The answer describes the host as of the REQUEST; the terminal frame
    // below lands while the read is in flight and must win.
    let releaseList!: () => void
    const gate = new Promise<void>(resolve => { releaseList = resolve })
    const { store, apply } = makeStore(async (endpoint) => {
      if (endpoint !== 'session/chat-list') return { ok: true, value: {} }
      await gate
      return {
        ok: true,
        value: {
          sessions: [
            {
              agentId: 'codebuddy',
              sessionId: 'acp-s1',
              subagents: [record({ status: 'running', dshSessionId: 'chat-1' })],
            },
            {
              agentId: 'codebuddy',
              sessionId: 'acp-s2',
              subagents: [record({ status: 'running', dshSessionId: 'chat-1' })],
            },
          ],
          acpMode: true,
        },
      }
    })

    const load = store.loadChatSessions('chat-1')
    await apply({
      type: 'subagents/record',
      dshSessionId: 'chat-1',
      record: record({ status: 'completed', endedAt: 3_000, dshSessionId: 'chat-1' }),
    })
    releaseList()
    await load

    // Two rows carried the same record; the keyed map holds one.
    const rows = Object.keys(store.getSnapshot().subagents)
    expect(rows).toHaveLength(1)
    expect(recordOf(store, 'acp:call-1')?.status).toBe('completed')
    expect(recordsOf(store, 'chat-1')).toHaveLength(1)
  })

  it('reads worker history on the first open only, then folds live frames by both filters', async () => {
    const { store, calls, apply } = makeStore(async (endpoint) => {
      if (endpoint !== 'subagents/detail') return { ok: true, value: {} }
      return {
        ok: true,
        value: {
          entries: [
            { seq: 1, update: { sessionUpdate: 'tool_call', toolCallId: 'call-1' } },
            { seq: 2, update: { sessionUpdate: 'tool_call', toolCallId: 'other-call' } },
          ],
        },
      }
    })
    // The ACP→chat mapping the live fold is scoped by (turn/metrics names both).
    await apply({ type: 'turn/metrics', sessionId: 'acp-s1', dshSessionId: 'chat-1', turnId: 't1', outputTokens: 1, burstMs: 1, final: true })

    await store.loadSubagentDetail('chat-1', 'acp:call-1')
    const detail = detailOf(store, 'acp:call-1')
    expect(detail?.loaded).toBe(true)
    expect(detail?.entries.map(entry => entry.seq)).toEqual([1, 2])
    expect(calls.filter(call => call.endpoint === 'subagents/detail')).toEqual([
      { endpoint: 'subagents/detail', payload: { dshSessionId: 'chat-1', childId: 'acp:call-1' } },
    ])
    // A second open reuses the index: one read per worker per page.
    await store.loadSubagentDetail('chat-1', 'acp:call-1')
    expect(calls.filter(call => call.endpoint === 'subagents/detail')).toHaveLength(1)

    // Live frames: the dispatch's OWN frames (toolCallId) and the worker's
    // frames (parentToolCallId) both count; anything else does not.
    await apply({
      type: 'session/update',
      sessionId: 'acp-s1',
      seq: 10,
      update: { sessionUpdate: 'tool_call_update', toolCallId: 'call-1', status: 'completed' },
    })
    await apply({
      type: 'session/update',
      sessionId: 'acp-s1',
      seq: 11,
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'from the worker' },
        _meta: { 'codebuddy.ai/parentToolCallId': 'call-1' },
      },
    })
    await apply({
      type: 'session/update',
      sessionId: 'acp-s1',
      seq: 12,
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'unrelated' } },
    })
    store.flushUpdates()
    expect(detailOf(store, 'acp:call-1')?.entries.map(entry => entry.seq)).toEqual([1, 2, 10, 11])
  })

  it('caps one worker at 200 entries and counts the dropped front as a marker', async () => {
    const { store, apply } = makeStore()
    await apply({ type: 'turn/metrics', sessionId: 'acp-s1', dshSessionId: 'chat-1', turnId: 't1', outputTokens: 1, burstMs: 1, final: false })
    await store.loadSubagentDetail('chat-1', 'acp:call-1')
    for (let seq = 1; seq <= 205; seq += 1) {
      await apply({
        type: 'session/update',
        sessionId: 'acp-s1',
        seq,
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `chunk ${String(seq)}` }, _meta: { 'codebuddy.ai/parentToolCallId': 'call-1' } },
      })
    }
    store.flushUpdates()
    const detail = detailOf(store, 'acp:call-1')
    expect(detail?.entries).toHaveLength(200)
    expect(detail?.entries[0]?.seq).toBe(6)
    expect(detail?.entries.at(-1)?.seq).toBe(205)
    // The index does not start at the worker's first frame — the panel says so.
    expect(detail?.omitted).toBe(5)
  })

  it('replays live frames over a slow detail read without duplicating what the host already saw', async () => {
    let releaseDetail!: () => void
    const gate = new Promise<void>(resolve => { releaseDetail = resolve })
    const dispatchFrame = { sessionUpdate: 'tool_call', toolCallId: 'call-1', status: 'in_progress' }
    const { store, apply } = makeStore(async (endpoint) => {
      if (endpoint !== 'subagents/detail') return { ok: true, value: {} }
      await gate
      // The host read saw seq 1 but not seq 2.
      return { ok: true, value: { entries: [{ seq: 1, update: dispatchFrame }] } }
    })
    await apply({ type: 'turn/metrics', sessionId: 'acp-s1', dshSessionId: 'chat-1', turnId: 't1', outputTokens: 1, burstMs: 1, final: true })

    const loading = store.loadSubagentDetail('chat-1', 'acp:call-1')
    // The same frame the host will return (must not be shown twice) and a
    // worker frame the host's answer predates (must survive it).
    await apply({ type: 'session/update', sessionId: 'acp-s1', seq: 1, update: dispatchFrame })
    await apply({
      type: 'session/update',
      sessionId: 'acp-s1',
      seq: 2,
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'late' }, _meta: { 'codebuddy.ai/parentToolCallId': 'call-1' } },
    })
    store.flushUpdates()
    releaseDetail()
    await loading
    expect(detailOf(store, 'acp:call-1')?.entries.map(entry => entry.seq)).toEqual([1, 2])
  })

  it('keeps at most 64 worker detail indexes, evicting the least recently opened', async () => {
    const { store } = makeStore()
    for (let index = 0; index < 65; index += 1) {
      await store.loadSubagentDetail('chat-1', `acp:call-${String(index)}`)
    }
    const details = store.getSnapshot().subagentDetails
    expect(Object.keys(details)).toHaveLength(64)
    expect(detailOf(store, 'acp:call-0')).toBeUndefined()
    expect(detailOf(store, 'acp:call-64')).toBeDefined()
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

  it('optimistically updates chatSessions when switching model, effort or mode', async () => {
    let listed = {
      sessions: [
        {
          agentId: 'codebuddy',
          sessionId: 's1',
          modelId: 'codebuddy@hy2',
          reasoningEffort: 'low',
          modes: { currentModeId: 'default', availableModes: [{ id: 'default', name: 'Default' }, { id: 'strict', name: 'Strict' }] },
        },
      ],
      acpMode: true,
    }
    let holdChatList: Promise<void> | undefined
    let releaseChatList: (() => void) | undefined
    const store = new AcpStore(async (_channel, endpoint, payload) => {
      if (endpoint === 'session/chat-model-set') {
        const p = payload as { modelId: string }
        listed = {
          ...listed,
          sessions: listed.sessions.map(s => ({ ...s, modelId: p.modelId })),
        }
        return { ok: true, value: {} }
      }
      if (endpoint === 'session/chat-effort-set') {
        const p = payload as { effort?: string }
        listed = {
          ...listed,
          sessions: listed.sessions.map(s => ({ ...s, reasoningEffort: p.effort })),
        }
        return { ok: true, value: {} }
      }
      if (endpoint === 'session/chat-mode-set') {
        const p = payload as { modeId: string }
        listed = {
          ...listed,
          sessions: listed.sessions.map(s => ({ ...s, modes: { ...s.modes, currentModeId: p.modeId } })),
        }
        return { ok: true, value: {} }
      }
      if (endpoint === 'session/chat-list') {
        if (holdChatList) await holdChatList
        return { ok: true, value: listed }
      }
      return { ok: true, value: {} }
    }, zh => zh)

    await store.loadChatSessions('chat-1')
    expect(store.getSnapshot().chatSessions[0]).toMatchObject({
      agentId: 'codebuddy',
      modelId: 'codebuddy@hy2',
      reasoningEffort: 'low',
      modes: { currentModeId: 'default' },
    })

    // Switching model optimistically updates chatSessions without waiting for reload
    await store.setChatSessionModel('chat-1', 'codebuddy@hy3', 'codebuddy')
    expect(store.getSnapshot().chatSessions[0]?.modelId).toBe('codebuddy@hy3')

    // Switching effort optimistically updates chatSessions
    await store.setChatSessionEffort('chat-1', 'high', 'codebuddy')
    expect(store.getSnapshot().chatSessions[0]?.reasoningEffort).toBe('high')

    // Switching mode optimistically updates both chatChoice and chatSessions before reload settles
    holdChatList = new Promise(resolve => { releaseChatList = resolve })
    const modePromise = store.setChatSessionMode('chat-1', 'strict', 'codebuddy')
    // Yield a microtask so chat-mode-set completes and optimistic write occurs
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(store.getSnapshot().chatChoice['chat-1']?.mode).toBe('strict')
    expect(store.getSnapshot().chatSessions[0]?.modes?.currentModeId).toBe('strict')
    releaseChatList!()
    await modePromise
    expect(store.getSnapshot().chatSessions[0]?.modes?.currentModeId).toBe('strict')

    // Switching on an unrelated conversation does not mutate chatSessionsFor chat-1
    const prevSessions = store.getSnapshot().chatSessions
    await store.setChatSessionModel('chat-2', 'codebuddy@hy4', 'codebuddy')
    expect(store.getSnapshot().chatSessions).toBe(prevSessions)

    // Switching to the same value does not mutate chatSessions
    await store.setChatSessionModel('chat-1', 'codebuddy@hy3', 'codebuddy')
    expect(store.getSnapshot().chatSessions).toBe(prevSessions)

    // session/meta event updates modes in chatSessions
    const apply = (event: unknown): Promise<void> =>
      (store as unknown as { applyEvent(event: unknown): Promise<void> }).applyEvent(event as never)
    await apply({
      type: 'session/meta',
      sessionId: 's1',
      session: {
        sessionId: 's1',
        agentId: 'codebuddy',
        acpSessionId: 'acp-1',
        cwd: '/w',
        running: false,
        closed: false,
        seq: 0,
        modes: { currentModeId: 'default', availableModes: [{ id: 'default', name: 'Default' }] },
      },
    })
    expect(store.getSnapshot().chatSessions[0]?.modes?.currentModeId).toBe('default')

    // session/meta with identical modes does not mutate chatSessions reference
    const sameMetaSessions = store.getSnapshot().chatSessions
    await apply({
      type: 'session/meta',
      sessionId: 's1',
      session: {
        sessionId: 's1',
        agentId: 'codebuddy',
        acpSessionId: 'acp-1',
        cwd: '/w',
        running: false,
        closed: false,
        seq: 0,
        modes: { currentModeId: 'default', availableModes: [{ id: 'default', name: 'Default' }] },
      },
    })
    expect(store.getSnapshot().chatSessions).toBe(sameMetaSessions)

    // session/meta with null or undefined modes does not throw and leaves chatSessions unchanged
    const metaNullSessions = store.getSnapshot().chatSessions
    await apply({
      type: 'session/meta',
      sessionId: 's1',
      session: {
        sessionId: 's1',
        agentId: 'codebuddy',
        acpSessionId: 'acp-1',
        cwd: '/w',
        running: false,
        closed: false,
        seq: 0,
        modes: null,
      },
    })
    expect(store.getSnapshot().chatSessions).toBe(metaNullSessions)

    await apply({
      type: 'session/meta',
      sessionId: 's1',
      session: {
        sessionId: 's1',
        agentId: 'codebuddy',
        acpSessionId: 'acp-1',
        cwd: '/w',
        running: false,
        closed: false,
        seq: 0,
      },
    })
    expect(store.getSnapshot().chatSessions).toBe(metaNullSessions)

    // Switching model without explicit agentId infers owner from modelId
    await store.setChatSessionModel('chat-1', 'codebuddy@hy4')
    expect(store.getSnapshot().chatSessions[0]?.modelId).toBe('codebuddy@hy4')
    expect(store.getSnapshot().chatChoice['chat-1']?.modelId).toBe('codebuddy@hy4')

    // Switching model with multiple '@' correctly extracts the leading agent id
    await store.setChatSessionModel('chat-1', 'codebuddy@var@nested')
    expect(store.getSnapshot().chatSessions[0]?.modelId).toBe('codebuddy@var@nested')
    expect(store.getSnapshot().chatChoice['chat-1']?.agentId).toBe('codebuddy')

    // Switching model with leading '@' (malformed) falls back to existing owner rather than setting ""
    await store.setChatSessionModel('chat-1', '@only-choice')
    expect(store.getSnapshot().chatChoice['chat-1']?.agentId).toBe('codebuddy')
    expect(store.getSnapshot().chatSessions[0]?.modelId).toBe('@only-choice')

    // Switching with whitespace agentId falls back rather than corrupting agentId into whitespace
    await store.setChatSessionEffort('chat-1', 'low', '   ')
    expect(store.getSnapshot().chatChoice['chat-1']?.agentId).toBe('codebuddy')
    expect(store.getSnapshot().chatSessions[0]?.reasoningEffort).toBe('low')
  })

  it('drops a pre-first-turn thought pick on a model switch, keeps it on a live session', async () => {
    let listed: { sessions: Array<{ agentId: string; sessionId: string; modelId: string; reasoningEffort?: string }>; acpMode: boolean } = {
      sessions: [],
      acpMode: true,
    }
    const store = new AcpStore(async (_channel, endpoint) => {
      if (endpoint === 'session/chat-list') return { ok: true, value: listed }
      return { ok: true, value: {} }
    }, (zh) => zh)

    // No ACP session yet: a level picked for `hy3` cannot be presented as
    // `hy4`'s (the host clears it for the same reason).
    await store.loadChatSessions('chat-pick')
    await store.setChatSessionModel('chat-pick', 'codebuddy@hy3', 'codebuddy')
    await store.setChatSessionEffort('chat-pick', 'high', 'codebuddy')
    expect(store.getSnapshot().chatChoice['chat-pick']).toMatchObject({ modelId: 'codebuddy@hy3', effort: 'high' })
    await store.setChatSessionModel('chat-pick', 'codebuddy@hy4', 'codebuddy')
    expect(store.getSnapshot().chatChoice['chat-pick']).toEqual({ agentId: 'codebuddy', modelId: 'codebuddy@hy4' })

    // A LIVE session is different: the host re-validates the level against the
    // new model's own options, so the optimistic path must not drop it first.
    listed = {
      sessions: [{ agentId: 'codebuddy', sessionId: 's1', modelId: 'codebuddy@hy3', reasoningEffort: 'high' }],
      acpMode: true,
    }
    await store.loadChatSessions('chat-live')
    await store.setChatSessionModel('chat-live', 'codebuddy@hy3', 'codebuddy')
    await store.setChatSessionEffort('chat-live', 'high', 'codebuddy')
    await store.setChatSessionModel('chat-live', 'codebuddy@hy4', 'codebuddy')
    expect(store.getSnapshot().chatChoice['chat-live']).toMatchObject({ modelId: 'codebuddy@hy4', effort: 'high' })
    expect(store.getSnapshot().chatSessions[0]?.reasoningEffort).toBe('high')
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

/**
 * The NTR branch button's state machine (the message-actions plan §D4). Every
 * input is a fact someone else owns — the row's `fork` verdict is the host's,
 * `hostFork` is the runtime probe, `isTail` is the host's own DOM marker — so
 * the mapping is pure precedence, and `undefined` facts degrade CLOSED.
 */
describe('forkStateOf (the NTR branch button state machine)', () => {
  const readyRow: ChatSessionView = { agentId: 'pi', sessionId: 's1', fork: { supported: true } }

  it('maps the six states in the precedence they render', () => {
    expect(forkStateOf(readyRow, true, true)).toBe('ready')
    // The runtime has no `sessions.fork` face: nothing can work, ever.
    expect(forkStateOf(readyRow, false, true)).toBe('hostUnavailable')
    // No row: the conversation's ACP session is parked (or was never read) —
    // degrade to released, never to a click-through.
    expect(forkStateOf(undefined, true, true)).toBe('released')
    // A row from a host half that predates the fork field: unsupported.
    expect(forkStateOf({ agentId: 'pi', sessionId: 's1' }, true, true)).toBe('unsupported')
    // The host's verdict is the authority; its reason rides through.
    expect(forkStateOf({ agentId: 'pi', sessionId: 's1', fork: { supported: false, reason: 'unsupported' } }, true, true)).toBe('unsupported')
    expect(forkStateOf({ agentId: 'pi', sessionId: 's1', fork: { supported: false, reason: 'released' } }, true, true)).toBe('released')
    expect(forkStateOf({ agentId: 'pi', sessionId: 's1', fork: { supported: false, reason: 'busy' } }, true, true)).toBe('busy')
    // `false` with no reason: a host half that predates reasons (treat as
    // unsupported, never as a click-through).
    expect(forkStateOf({ agentId: 'pi', sessionId: 's1', fork: { supported: false } }, true, true)).toBe('unsupported')
    // History rows gray out even when everything else is fine.
    expect(forkStateOf(readyRow, true, false)).toBe('notTail')
  })

  it('answers busy from the live running flag even when the row says ready', () => {
    // The row's own `running` only refreshes on a chat-list read; the
    // SSE-driven live flag is the fresher fact, and a running turn is not
    // forkable (the adopt refuses mid-turn parents too).
    expect(forkStateOf(readyRow, true, true, true)).toBe('busy')
    expect(forkStateOf(readyRow, true, true, false)).toBe('ready')
    // An absent live flag is no fact at all: the row's ready stands.
    expect(forkStateOf(readyRow, true, true, undefined)).toBe('ready')
  })
})

/**
 * The branch click (the message-actions plan §D5): the HOST forks the DSH tree
 * first (the injected `forkHost` face), then the plugin adopts the ACP side via
 * `session/chat-fork-adopt`. A failure at either stage is flashed to the notice
 * banner (a user-action failure) AND returned as `{ failure }` — the line the
 * conversation renders beside the button; nothing opens.
 */
describe('forkChatSession (the NTR branch click)', () => {
  it('reports a host-fork failure to the notice and never sends the adopt', async () => {
    const calls: Array<{ endpoint: string; payload: unknown }> = []
    const store = new AcpStore(async (_channel, endpoint, payload) => {
      calls.push({ endpoint, payload })
      return { ok: true, value: {} }
    }, (zh) => zh)

    const outcome = await store.forkChatSession('chat-1', async () => {
      throw new Error('host fork exploded')
    })
    expect(outcome).toEqual({ failure: 'host fork exploded' })
    expect(store.getSnapshot().notice).toContain('host fork exploded')
    // Host first is structural: with no child there is nothing to adopt.
    expect(calls).toEqual([])
  })

  it('refuses a host answer that is not a session id', async () => {
    const calls: Array<{ endpoint: string; payload: unknown }> = []
    const store = new AcpStore(async (_channel, endpoint, payload) => {
      calls.push({ endpoint, payload })
      return { ok: true, value: {} }
    }, (zh) => zh)

    expect(await store.forkChatSession('chat-1', async () => 42)).toEqual({ failure: '宿主没有返回分支会话，分支未完成。' })
    expect(store.getSnapshot().notice).toContain('宿主没有返回分支会话')
    expect(calls).toEqual([])
  })

  it('reports a failed adopt with the actionable line and leaves the child unbound', async () => {
    const calls: Array<{ endpoint: string; payload: unknown }> = []
    const store = new AcpStore(async (_channel, endpoint, payload) => {
      calls.push({ endpoint, payload })
      if (endpoint === 'session/chat-fork-adopt') {
        return { ok: false, error: { code: 'parent_not_live', message: 'acp: the conversation to branch has no live ACP session' } }
      }
      return { ok: true, value: {} }
    }, (zh) => zh)

    const outcome = await store.forkChatSession('chat-1', async () => 'child-1')
    // The child EXISTS but nothing is attached to it: the failure line must say
    // what happens next (its first message starts a fresh session), not just
    // name the error.
    expect(outcome).toEqual({
      failure: '分支会话已创建，但没有接上 agent 的上下文（acp: the conversation to branch has no live ACP session）；在子会话里发送的第一条消息会开启全新会话。',
    })
    expect(store.getSnapshot().notice).toContain('分支会话已创建，但没有接上 agent 的上下文')
    expect(calls).toEqual([
      { endpoint: 'session/chat-fork-adopt', payload: { dshSessionId: 'child-1', parentDshSessionId: 'chat-1' } },
    ])
  })

  it('adopts: sends the child the host returned and resolves it', async () => {
    const calls: Array<{ endpoint: string; payload: unknown }> = []
    const store = new AcpStore(async (_channel, endpoint, payload) => {
      calls.push({ endpoint, payload })
      if (endpoint === 'session/chat-fork-adopt') return { ok: true, value: { done: true } }
      return { ok: true, value: {} }
    }, (zh) => zh)

    const outcome = await store.forkChatSession('chat-1', async sessionId => `${sessionId}-copy`)
    expect(outcome).toEqual({ childId: 'chat-1-copy' })
    expect(calls).toEqual([
      { endpoint: 'session/chat-fork-adopt', payload: { dshSessionId: 'chat-1-copy', parentDshSessionId: 'chat-1' } },
    ])
    expect(store.getSnapshot().notice).toBeUndefined()
  })

  it('preserves sessions instance context when called with resolveHostFork', async () => {
    class HostSessionsService {
      list = {
        getSnapshot() {
          return [{ id: 'parent-1' }]
        },
      }

      async fork(options: { sessionId: string; increaseTitle?: boolean }) {
        // Reproduces the exact host implementation pattern that failed with:
        // Cannot read properties of undefined (reading 'getSnapshot')
        const list = this.list.getSnapshot()
        if (!list || list.length === 0) throw new Error('empty session list')
        return `${options.sessionId}-child`
      }
    }

    const hostService = new HostSessionsService()
    const hostFace = resolveHostFork(hostService)
    expect(hostFace).toBeDefined()

    const calls: Array<{ endpoint: string; payload: unknown }> = []
    const store = new AcpStore(async (_channel, endpoint, payload) => {
      calls.push({ endpoint, payload })
      if (endpoint === 'session/chat-fork-adopt') return { ok: true, value: { done: true } }
      return { ok: true, value: {} }
    }, (zh) => zh)

    const outcome = await store.forkChatSession('chat-1', sessionId => {
      return hostFace!.fork({ sessionId, increaseTitle: true })
    })

    expect(outcome).toEqual({ childId: 'chat-1-child' })
    expect(calls).toEqual([
      { endpoint: 'session/chat-fork-adopt', payload: { dshSessionId: 'chat-1-child', parentDshSessionId: 'chat-1' } },
    ])
    expect(store.getSnapshot().notice).toBeUndefined()
  })
})

describe('save gate store state', () => {
  it('renders a pending save from the host frame and flushes it through the RPC', async () => {
    const calls: Array<{ endpoint: string; payload: unknown }> = []
    const pendingStatus = {
      canSave: false,
      activeTurns: 1,
      activeSessions: [{ sessionId: 'acp-1', agentId: 'codebuddy' }],
      pending: [{ id: 'save-1', label: 'settings:llm-pi-ai', queuedAt: 1, deadlineAt: 600_001 }],
      timeoutMs: 600_000,
    }
    const store = new AcpStore(async (_channel, endpoint, payload) => {
      calls.push({ endpoint, payload })
      if (endpoint === 'save/flush') return { ok: true, value: { saved: 1, expired: 0, failed: 0 } }
      if (endpoint === 'save/status') {
        return { ok: true, value: { status: { ...pendingStatus, canSave: true, activeTurns: 0, activeSessions: [], pending: [] } } }
      }
      return { ok: true, value: {} }
    }, (zh) => zh)

    await (store as unknown as { applyEvent(event: unknown): Promise<void> }).applyEvent({
      type: 'save/status',
      status: pendingStatus,
    })

    const snapshot = store.getSnapshot()
    expect(snapshot.saveGate.pending).toHaveLength(1)
    expect(snapshot.logs.some(entry => entry.text.includes('配置已暂存'))).toBe(true)

    await expect(store.forceSaveGate()).resolves.toEqual({ saved: 1, expired: 0, failed: 0 })
    expect(calls.map(call => call.endpoint)).toEqual(['save/flush', 'save/status'])
    expect(store.getSnapshot().saveGate.pending).toEqual([])
    expect(store.getSnapshot().saveGate.canSave).toBe(true)
  })

  it('forces one agent without routing through the global save/flush', async () => {
    const calls: string[] = []
    const store = new AcpStore(async (_channel, endpoint) => {
      calls.push(endpoint)
      if (endpoint === 'agent/save') return { ok: true, value: { saved: true } }
      return { ok: true, value: {} }
    }, (zh) => zh)

    await store.saveAgent({ id: 'pi', command: 'pi-acp' }, 'force')

    expect(calls).toContain('agent/save')
    // Regression guard: one agent's "save now" must never flush every held label.
    expect(calls).not.toContain('save/flush')
  })

  it('saves every held label in one explicit flush and names them in the success row', async () => {
    const calls: string[] = []
    const held = {
      canSave: false,
      activeTurns: 2,
      activeSessions: [
        { sessionId: 'acp-1', agentId: 'codebuddy' },
        { sessionId: 'acp-2', agentId: 'pi' },
      ],
      pending: [
        { id: 'save-1', label: 'agent-save:codebuddy', queuedAt: 1, deadlineAt: 600_001 },
        { id: 'save-2', label: 'agent-save:pi', queuedAt: 2, deadlineAt: 600_002 },
      ],
      timeoutMs: 600_000,
    }
    const settled = {
      ...held,
      canSave: true,
      activeTurns: 0,
      activeSessions: [],
      pending: [],
      lastOutcomes: {
        'agent-save:codebuddy': { at: 10, status: 'saved', label: 'agent-save:codebuddy' },
        'agent-save:pi': { at: 11, status: 'saved', label: 'agent-save:pi' },
      },
    }
    const store = new AcpStore(async (_channel, endpoint) => {
      calls.push(endpoint)
      if (endpoint === 'save/flush') return { ok: true, value: { saved: 2, expired: 0, failed: 0 } }
      if (endpoint === 'save/status') return { ok: true, value: { status: settled } }
      return { ok: true, value: {} }
    }, (zh) => zh)
    await (store as unknown as { applyEvent(event: unknown): Promise<void> }).applyEvent({
      type: 'save/status',
      status: held,
    })

    await expect(store.forceSaveGate()).resolves.toEqual({ saved: 2, expired: 0, failed: 0 })

    expect(calls.filter(endpoint => endpoint === 'save/flush')).toHaveLength(1)
    const success = store.getSnapshot().saveBanners.find(entry => entry.source === 'save-succeeded')
    expect(success?.body).toContain('CodeBuddy')
    expect(success?.body).toContain('Pi Coding Agent')
    expect(store.getSnapshot().saveGate.pending).toEqual([])
  })

  it('names the failed labels when an explicit flush only partly completes', async () => {
    const held = {
      canSave: false,
      activeTurns: 2,
      activeSessions: [
        { sessionId: 'acp-1', agentId: 'alpha' },
        { sessionId: 'acp-2', agentId: 'beta' },
      ],
      pending: [
        { id: 'save-1', label: 'agent-save:alpha', queuedAt: 1, deadlineAt: 600_001 },
        { id: 'save-2', label: 'agent-save:beta', queuedAt: 2, deadlineAt: 600_002 },
      ],
      timeoutMs: 600_000,
    }
    const settled = {
      ...held,
      canSave: true,
      activeTurns: 0,
      activeSessions: [],
      pending: [],
      lastOutcomes: {
        'agent-save:alpha': { at: 10, status: 'saved', label: 'agent-save:alpha' },
        'agent-save:beta': { at: 11, status: 'failed', label: 'agent-save:beta', message: 'revision conflict' },
      },
    }
    const store = new AcpStore(async (_channel, endpoint) => {
      if (endpoint === 'save/flush') return { ok: true, value: { saved: 1, expired: 0, failed: 1 } }
      if (endpoint === 'save/status') return { ok: true, value: { status: settled } }
      return { ok: true, value: {} }
    }, (zh) => zh)
    await (store as unknown as { applyEvent(event: unknown): Promise<void> }).applyEvent({
      type: 'save/status',
      status: held,
    })

    await expect(store.forceSaveGate()).resolves.toEqual({ saved: 1, expired: 0, failed: 1 })

    const partial = store.getSnapshot().saveBanners.find(entry => entry.source === 'save-partial')
    expect(partial?.body).toContain('失败 1 项')
    expect(partial?.body).toContain('agent-save:beta')
    expect(partial?.body).not.toContain('agent-save:alpha')
  })

  it('records an expired held save as an error, not as a silent success', async () => {
    const store = new AcpStore(async () => ({ ok: true, value: {} }), (zh) => zh)
    await (store as unknown as { applyEvent(event: unknown): Promise<void> }).applyEvent({
      type: 'save/status',
      status: {
        canSave: false,
        activeTurns: 1,
        activeSessions: [{ sessionId: 'acp-1', agentId: 'codebuddy' }],
        pending: [],
        timeoutMs: 600_000,
        lastOutcome: { at: 2, status: 'expired', label: 'settings:llm-pi-ai' },
      },
    })
    expect(store.getSnapshot().logs.some(entry => entry.level === 'error' && entry.text.includes('等待超时'))).toBe(true)
  })

  it('cancels one held label through the save/cancel RPC', async () => {
    const calls: Array<{ endpoint: string; payload: unknown }> = []
    const store = new AcpStore(async (_channel, endpoint, payload) => {
      calls.push({ endpoint, payload })
      if (endpoint === 'save/cancel') return { ok: true, value: { cancelled: 1 } }
      return { ok: true, value: {} }
    }, (zh) => zh)
    await expect(store.cancelSaveGate('agent-save:codebuddy')).resolves.toBe(true)
    expect(calls).toEqual([{ endpoint: 'save/cancel', payload: { label: 'agent-save:codebuddy' } }])
  })

  it('logs per-label settlements without one agent erasing another agent\'s result', async () => {
    const store = new AcpStore(async () => ({ ok: true, value: {} }), (zh) => zh)
    const emit = async (status: Record<string, unknown>): Promise<void> => {
      await (store as unknown as { applyEvent(event: unknown): Promise<void> }).applyEvent({ type: 'save/status', status })
    }
    const pendingAlpha = {
      canSave: false,
      activeTurns: 1,
      activeSessions: [{ sessionId: 'acp-alpha', agentId: 'alpha' }],
      pending: [{ id: 'save-1', label: 'agent-save:alpha', queuedAt: 1 }],
      timeoutMs: 600_000,
    }
    await emit(pendingAlpha)
    // Another agent settles first: its outcome must not clear alpha's pending
    // state or produce a "saved" line for alpha.
    await emit({ ...pendingAlpha, lastOutcomes: { 'agent-save:beta': { at: 2, status: 'saved', label: 'agent-save:beta' } } })
    expect(store.getSnapshot().saveGate.lastOutcomes?.['agent-save:beta']).toMatchObject({ status: 'saved' })
    expect(store.getSnapshot().logs.some(entry => entry.text.includes('配置已保存'))).toBe(false)
    // Alpha's own settlement arrives under its label.
    await emit({
      ...pendingAlpha,
      pending: [],
      canSave: true,
      activeTurns: 0,
      activeSessions: [],
      lastOutcomes: {
        'agent-save:alpha': { at: 3, status: 'saved', label: 'agent-save:alpha' },
        'agent-save:beta': { at: 2, status: 'saved', label: 'agent-save:beta' },
      },
    })
    expect(store.getSnapshot().saveGate.lastOutcomes?.['agent-save:alpha']).toMatchObject({ status: 'saved' })
    expect(store.getSnapshot().saveGate.lastOutcomes?.['agent-save:beta']).toMatchObject({ status: 'saved' })
    expect(store.getSnapshot().logs.filter(entry => entry.text.includes('配置已保存'))).toHaveLength(1)
  })

  it('does not treat a malformed save/cancel answer as a success', async () => {
    const pending = {
      canSave: false,
      gateAvailable: true,
      activeTurns: 1,
      activeSessions: [{ sessionId: 'acp-1', agentId: 'pi' }],
      pending: [{ id: 'save-1', label: 'agent-save:pi', queuedAt: 1 }],
      timeoutMs: 600_000,
    }
    const store = new AcpStore(async (_channel, endpoint) => {
      if (endpoint === 'save/cancel') return { ok: true, value: {} }
      return { ok: true, value: {} }
    }, (zh) => zh)
    await (store as unknown as { applyEvent(event: unknown): Promise<void> }).applyEvent({ type: 'save/status', status: pending })

    await expect(store.cancelSaveGate('agent-save:pi')).resolves.toBe(false)
    expect(store.getSnapshot().saveGate.pending).toHaveLength(1)
    expect(store.getSnapshot().saveBanners.find(row => row.key === 'save-cancel-failed:agent-save:pi'))
      .toMatchObject({ level: 'error', actions: ['retry', 'dismiss'] })
  })

  it('confirms cancellation from a matching terminal outcome when the count races to zero', async () => {
    const idle = {
      canSave: true,
      gateAvailable: true,
      activeTurns: 0,
      activeSessions: [],
      pending: [],
      timeoutMs: 600_000,
      lastOutcomes: { 'agent-save:pi': { at: 7, status: 'cancelled' as const, label: 'agent-save:pi' } },
    }
    const store = new AcpStore(async (_channel, endpoint) => {
      if (endpoint === 'save/cancel') return { ok: true, value: { cancelled: 0 } }
      if (endpoint === 'save/status') return { ok: true, value: { status: idle } }
      return { ok: true, value: {} }
    }, (zh) => zh)

    await expect(store.cancelSaveGate('agent-save:pi')).resolves.toBe(true)
    expect(store.getSnapshot().saveGate.pending).toEqual([])
    expect(store.getSnapshot().saveBanners.some(row => row.key === 'save-cancel-failed:agent-save:pi')).toBe(false)
  })

  it('ignores superseded and still-pending cancelled outcomes', async () => {
    const store = new AcpStore(async () => ({ ok: true, value: {} }), (zh) => zh)
    const emit = async (status: Record<string, unknown>): Promise<void> => {
      await (store as unknown as { applyEvent(event: unknown): Promise<void> }).applyEvent({ type: 'save/status', status })
    }
    const pending = {
      canSave: false,
      gateAvailable: true,
      activeTurns: 1,
      activeSessions: [{ sessionId: 'acp-1', agentId: 'pi' }],
      pending: [{ id: 'save-1', label: 'agent-save:pi', queuedAt: 1 }],
      timeoutMs: 600_000,
    }
    await emit(pending)
    await emit({
      ...pending,
      pending: [],
      lastOutcomes: {
        'agent-save:pi': { at: 5, status: 'cancelled', label: 'agent-save:pi', superseded: true },
      },
    })
    expect(store.getSnapshot().logs.some(entry => entry.text.includes('配置暂存已取消'))).toBe(false)

    // A cancelled row that shares the snapshot with a still-queued label is
    // the previous write's settlement, not this one's terminal state.
    await emit({
      ...pending,
      lastOutcomes: {
        'agent-save:pi': { at: 6, status: 'cancelled', label: 'agent-save:pi' },
      },
    })
    expect(store.getSnapshot().logs.some(entry => entry.text.includes('配置暂存已取消'))).toBe(false)
    expect(store.getSnapshot().saveGate.pending).toHaveLength(1)
  })
})

describe('save banners', () => {
  async function emit(store: AcpStore, event: unknown): Promise<void> {
    await (store as unknown as { applyEvent(event: unknown): Promise<void> }).applyEvent(event)
  }

  function createStore(handler?: (endpoint: string, payload: unknown) => Promise<unknown> | unknown): AcpStore {
    return new AcpStore(async (_channel, endpoint, payload) => {
      const value = handler === undefined ? { done: true } : await handler(endpoint, payload)
      return { ok: true, value: value ?? {} }
    }, (zh) => zh)
  }

  it('turns a failed gate outcome into a persistent retryable banner', async () => {
    const store = createStore()
    const status = {
      canSave: true,
      activeTurns: 0,
      activeSessions: [],
      pending: [],
      timeoutMs: 600_000,
      lastOutcomes: { 'settings:llm-pi-ai': { at: 5, status: 'failed', label: 'settings:llm-pi-ai', message: 'revision conflict' } },
    }
    await emit(store, { type: 'save/status', status })
    const banner = store.getSnapshot().saveBanners.find(entry => entry.key === 'save-failed:settings:llm-pi-ai')
    expect(banner).toMatchObject({ source: 'save-failed', level: 'error', actions: ['retry', 'dismiss'] })
    expect(banner?.body).toContain('revision conflict')
    expect(banner?.autoDismissMs).toBeUndefined()
    // The same reason replaces its row instead of stacking.
    await emit(store, { type: 'save/status', status })
    expect(store.getSnapshot().saveBanners.filter(entry => entry.key === 'save-failed:settings:llm-pi-ai')).toHaveLength(1)
  })

  it('shows a success banner for a held write and never for an immediate save', async () => {
    const store = createStore()
    const idle = { canSave: true, activeTurns: 0, activeSessions: [], pending: [], timeoutMs: 600_000 }
    // An immediate save (never in the queue) is silent: the form reports it.
    await emit(store, {
      type: 'save/status',
      status: {
        ...idle,
        lastOutcomes: { 'settings:llm-pi-ai': { at: 6, status: 'saved', label: 'settings:llm-pi-ai' } },
      },
    })
    expect(store.getSnapshot().saveBanners).toEqual([])

    // A held write earns the global receipt when it settles.
    await emit(store, {
      type: 'save/status',
      status: {
        ...idle,
        canSave: false,
        activeTurns: 1,
        activeSessions: [{ sessionId: 'acp-1', agentId: 'codebuddy' }],
        pending: [{ id: 'save-1', label: 'settings:llm-pi-ai', queuedAt: 1 }],
      },
    })
    await emit(store, {
      type: 'save/status',
      status: {
        ...idle,
        lastOutcomes: { 'settings:llm-pi-ai': { at: 6, status: 'saved', label: 'settings:llm-pi-ai' } },
      },
    })
    expect(store.getSnapshot().saveBanners.find(entry => entry.key === 'save-succeeded'))
      .toMatchObject({ level: 'success', autoDismissMs: 2500, actions: ['dismiss'] })
    store.dismissBanner('save-succeeded')
    expect(store.getSnapshot().saveBanners).toEqual([])

    const failed = {
      canSave: false,
      activeTurns: 1,
      activeSessions: [{ sessionId: 'acp-1', agentId: 'codebuddy' }],
      pending: [],
      timeoutMs: 600_000,
      lastOutcomes: { 'settings:llm-pi-ai': { at: 7, status: 'failed', label: 'settings:llm-pi-ai', message: 'again' } },
    }
    await emit(store, { type: 'save/status', status: failed })
    expect(store.getSnapshot().saveBanners).toHaveLength(1)
    store.dismissBanner('save-failed:settings:llm-pi-ai')
    expect(store.getSnapshot().saveBanners).toEqual([])
    // A later failure with the same key must appear again.
    await emit(store, {
      type: 'save/status',
      status: { ...failed, lastOutcomes: { 'settings:llm-pi-ai': { at: 8, status: 'failed', label: 'settings:llm-pi-ai', message: 'later' } } },
    })
    expect(store.getSnapshot().saveBanners).toHaveLength(1)
  })

  it('surfaces the HMR reload delay from agent/notice as an alert banner', async () => {
    const store = createStore()
    await emit(store, {
      type: 'agent/notice',
      agentId: 'hmr',
      level: 'info',
      text: 'acp: hmr reconcile is still deferred after 60s: the ACP turn has not ended.',
    })
    expect(store.getSnapshot().saveBanners.find(entry => entry.key === 'hmr-delay'))
      .toMatchObject({ source: 'hmr-delay', level: 'error', actions: ['dismiss'] })
    expect(store.getSnapshot().saveBanners[0]?.body).toContain('热重载')
  })

  it('shows an expiry banner and a partial force-flush banner', async () => {
    const store = createStore(endpoint => {
      if (endpoint === 'save/flush') return { saved: 1, expired: 1, failed: 1 }
      return { done: true }
    })
    await emit(store, {
      type: 'save/status',
      status: {
        canSave: false,
        activeTurns: 1,
        activeSessions: [{ sessionId: 'acp-1', agentId: 'codebuddy' }],
        pending: [{ id: 'save-1', label: 'agent-save:alpha', queuedAt: 1 }],
        timeoutMs: 600_000,
        lastOutcomes: { 'agent-save:alpha': { at: 5, status: 'expired', label: 'agent-save:alpha' } },
      },
    })
    const expired = store.getSnapshot().saveBanners.find(entry => entry.source === 'save-expired')
    expect(expired).toMatchObject({ level: 'error', actions: ['retry', 'force', 'dismiss'] })

    await store.forceSaveGate()
    const partial = store.getSnapshot().saveBanners.find(entry => entry.source === 'save-partial')
    expect(partial).toMatchObject({ level: 'error', actions: ['retry', 'dismiss'] })
    expect(partial?.body).toContain('失败 1 项')
  })

  it('retries the retained gate write from the banner action', async () => {
    const calls: string[] = []
    const store = createStore(endpoint => {
      calls.push(endpoint)
      if (endpoint === 'save/retry') return { retried: true }
      if (endpoint === 'save/status') {
        return {
          status: {
            canSave: true,
            activeTurns: 0,
            activeSessions: [],
            pending: [],
            timeoutMs: 600_000,
          },
        }
      }
      return { done: true }
    })
    await emit(store, {
      type: 'save/status',
      status: {
        canSave: true,
        activeTurns: 0,
        activeSessions: [],
        pending: [],
        timeoutMs: 600_000,
        lastOutcomes: {
          'settings:llm-pi-ai': { at: 5, status: 'failed', label: 'settings:llm-pi-ai', message: 'conflict' },
        },
      },
    })
    await store.retryBanner('save-failed:settings:llm-pi-ai')
    expect(calls).toContain('save/retry')
    expect(calls).not.toContain('save/flush')
    expect(store.getSnapshot().saveBanners.some(banner => banner.key === 'save-failed:settings:llm-pi-ai')).toBe(false)
  })

  it('reports a refused legacy save with retry and force actions', async () => {
    const store = createStore(endpoint => {
      if (endpoint === 'agent/save') {
        return Promise.reject(Object.assign(new Error('the agent has running turns'), { code: 'confirmation_required' }))
      }
      return { done: true }
    })
    // The test RPC adapter answers `ok:false` for a rejected promise.
    await expect(store.saveAgent({ id: 'pi', command: 'pi-acp' }, 'direct')).rejects.toThrow()
    const banner = store.getSnapshot().saveBanners.find(entry => entry.key === 'save-rejected:pi')
    expect(banner).toMatchObject({ source: 'save-rejected', actions: ['retry', 'force', 'dismiss'], title: '保存被拒绝' })
  })

  it('never drops a failure row and keeps at most one success row', async () => {
    const failure = (key: string, at: number): SaveBanner => ({
      key, source: 'save-failed', level: 'error', title: key, body: key, at, actions: ['dismiss'],
    })
    const success = (key: string, at: number): SaveBanner => ({
      key, source: 'save-cancelled', level: 'success', title: key, body: key, at, actions: ['dismiss'], autoDismissMs: 2500,
    })
    let rows = [failure('a', 1), failure('b', 2)]
    rows = composeSaveBanners(rows, success('s1', 3))
    rows = composeSaveBanners(rows, success('s2', 4))
    expect(rows.filter(row => row.level === 'error').map(row => row.key)).toEqual(['a', 'b'])
    expect(rows.filter(row => row.level === 'success')).toHaveLength(1)
    expect(rows[rows.length - 1]?.key).toBe('s2')

    const store = createStore()
    const idle = { canSave: true, activeTurns: 0, activeSessions: [], pending: [], timeoutMs: 600_000 }
    for (let index = 0; index < 7; index += 1) {
      const label = `settings:x${String(index)}`
      await emit(store, {
        type: 'save/status',
        status: { ...idle, lastOutcomes: { [label]: { at: index + 1, status: 'failed', label, message: 'x' } } },
      })
    }
    expect(store.getSnapshot().saveBanners.filter(row => row.level === 'error')).toHaveLength(7)
  })

  it('rebuilds a terminal banner during resync so a refresh does not lose it', async () => {
    const status = {
      canSave: true,
      activeTurns: 0,
      activeSessions: [],
      pending: [{ id: 'save-1', label: 'settings:llm-pi-ai', queuedAt: 1 }],
      timeoutMs: 600_000,
      lastOutcomes: { 'agent-save:pi': { at: 9, status: 'failed', label: 'agent-save:pi', message: 'deleted' } },
    }
    const store = new AcpStore(async (_channel, endpoint) => {
      if (endpoint === 'agents/list') return { ok: true, value: { agents: [] } }
      if (endpoint === 'sessions/list') return { ok: true, value: { sessions: [] } }
      if (endpoint === 'agents/detect') return { ok: true, value: { agents: [] } }
      if (endpoint === 'save/status') return { ok: true, value: { status } }
      return { ok: true, value: {} }
    }, (zh) => zh)
    await store.resync()
    expect(store.getSnapshot().saveBanners.find(row => row.key === 'save-failed:agent-save:pi'))
      .toMatchObject({ source: 'save-failed', level: 'error', actions: ['retry', 'dismiss'] })
    // A held entry that already existed before the refresh is not a new event.
    expect(store.getSnapshot().logs.some(entry => entry.text.includes('配置已暂存'))).toBe(false)
  })

  it('does not rebuild a gate failure closed before a refresh, but rebuilds an unclosed one', async () => {
    const backing = new Map<string, string>()
    const storage = {
      get length() { return backing.size },
      clear: () => { backing.clear() },
      getItem: (key: string) => backing.get(key) ?? null,
      key: (index: number) => [...backing.keys()][index] ?? null,
      removeItem: (key: string) => { backing.delete(key) },
      setItem: (key: string, value: string) => { backing.set(key, value) },
    } as Storage
    vi.stubGlobal('sessionStorage', storage)
    try {
      const status = {
        canSave: true,
        gateAvailable: true,
        activeTurns: 0,
        activeSessions: [],
        pending: [],
        timeoutMs: 600_000,
        lastOutcomes: {
          'agent-save:alpha': { at: 11, status: 'failed' as const, label: 'agent-save:alpha', message: 'alpha failed' },
          'agent-save:beta': { at: 12, status: 'failed' as const, label: 'agent-save:beta', message: 'beta failed' },
        },
      }
      const rpc: RpcCall = async (_channel, endpoint) => {
        if (endpoint === 'agents/list') return { ok: true, value: { agents: [] } }
        if (endpoint === 'sessions/list') return { ok: true, value: { sessions: [] } }
        if (endpoint === 'agents/detect') return { ok: true, value: { agents: [] } }
        if (endpoint === 'save/status') return { ok: true, value: { status } }
        return { ok: true, value: {} }
      }

      const first = new AcpStore(rpc, (zh) => zh)
      await first.resync()
      expect(first.getSnapshot().saveBanners.map(row => row.key)).toEqual([
        'save-failed:agent-save:alpha',
        'save-failed:agent-save:beta',
      ])
      first.dismissBanner('save-failed:agent-save:alpha')

      // A new store simulates the page reload; sessionStorage carries the
      // closed-row record into it.
      const second = new AcpStore(rpc, (zh) => zh)
      await second.resync()
      expect(second.getSnapshot().saveBanners.map(row => row.key)).toEqual(['save-failed:agent-save:beta'])
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('seeds the first SSE frame after a refresh without reviving a closed failure or expiry', async () => {
    const backing = new Map<string, string>()
    const storage = {
      get length() { return backing.size },
      clear: () => { backing.clear() },
      getItem: (key: string) => backing.get(key) ?? null,
      key: (index: number) => [...backing.keys()][index] ?? null,
      removeItem: (key: string) => { backing.delete(key) },
      setItem: (key: string, value: string) => { backing.set(key, value) },
    } as Storage
    backing.set('dsh-ntr.save-banner-dismissals', JSON.stringify({
      'save-failed:agent-save:alpha': 11,
      'save-expired:agent-save:gamma': 12,
    }))
    vi.stubGlobal('sessionStorage', storage)
    try {
      const store = createStore()
      const status = {
        canSave: true,
        gateAvailable: true,
        activeTurns: 0,
        activeSessions: [],
        pending: [],
        timeoutMs: 600_000,
        lastOutcomes: {
          'agent-save:alpha': { at: 11, status: 'failed' as const, label: 'agent-save:alpha', message: 'alpha failed' },
          'agent-save:gamma': { at: 12, status: 'expired' as const, label: 'agent-save:gamma' },
          'agent-save:beta': { at: 13, status: 'failed' as const, label: 'agent-save:beta', message: 'beta failed' },
        },
      }
      // The SSE frame lands before resync; it is still the host snapshot being
      // seeded, so the closed records must hold.
      await emit(store, { type: 'save/status', status })
      expect(store.getSnapshot().saveBanners.map(row => row.key)).toEqual(['save-failed:agent-save:beta'])

      // A genuinely new settlement carries a different `at`; closing an old row
      // must not swallow it.
      await emit(store, {
        type: 'save/status',
        status: {
          ...status,
          lastOutcomes: {
            ...status.lastOutcomes,
            'agent-save:alpha': { at: 14, status: 'failed' as const, label: 'agent-save:alpha', message: 'alpha failed again' },
          },
        },
      })
      expect(store.getSnapshot().saveBanners.map(row => row.key)).toEqual([
        'save-failed:agent-save:beta',
        'save-failed:agent-save:alpha',
      ])
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('keeps a success receipt when a failure arrives and names the agent', async () => {
    const store = createStore()
    const pending = {
      canSave: false,
      gateAvailable: true,
      activeTurns: 1,
      activeSessions: [
        { sessionId: 'acp-alpha', agentId: 'alpha' },
        { sessionId: 'acp-beta', agentId: 'beta' },
      ],
      pending: [
        { id: 'save-1', label: 'agent-save:alpha', queuedAt: 1 },
        { id: 'save-2', label: 'agent-save:beta', queuedAt: 2 },
      ],
      timeoutMs: 600_000,
    }
    await emit(store, { type: 'save/status', status: pending })
    await emit(store, {
      type: 'save/status',
      status: {
        ...pending,
        canSave: true,
        activeTurns: 0,
        activeSessions: [],
        pending: [],
        lastOutcomes: {
          'agent-save:alpha': { at: 20, status: 'saved', label: 'agent-save:alpha' },
          'agent-save:beta': { at: 21, status: 'failed', label: 'agent-save:beta', message: 'beta boom' },
        },
      },
    })
    const banners = store.getSnapshot().saveBanners
    expect(banners.find(row => row.key === 'save-succeeded')?.body).toContain('alpha')
    expect(banners.find(row => row.key === 'save-succeeded')?.body).toContain('已保存')
    expect(banners.find(row => row.key === 'save-failed:agent-save:beta')?.body).toContain('beta boom')
    // Both receipts are visible at once; the error did not evict the success.
    expect(banners).toHaveLength(2)
  })

  it('names every agent that saved in one frame in a single success row and logs each label', async () => {
    const store = createStore()
    const idle = { canSave: true, gateAvailable: true, activeTurns: 0, activeSessions: [], pending: [], timeoutMs: 600_000 }
    const pending = {
      ...idle,
      canSave: false,
      activeTurns: 1,
      activeSessions: [
        { sessionId: 'acp-alpha', agentId: 'alpha' },
        { sessionId: 'acp-beta', agentId: 'beta' },
      ],
      pending: [
        { id: 'save-1', label: 'agent-save:alpha', queuedAt: 1 },
        { id: 'save-2', label: 'agent-save:beta', queuedAt: 2 },
      ],
    }
    await emit(store, { type: 'save/status', status: pending })
    await emit(store, {
      type: 'save/status',
      status: {
        ...pending,
        canSave: true,
        activeTurns: 0,
        activeSessions: [],
        pending: [],
        lastOutcomes: {
          'agent-save:alpha': { at: 20, status: 'saved', label: 'agent-save:alpha' },
          'agent-save:beta': { at: 21, status: 'saved', label: 'agent-save:beta' },
        },
      },
    })
    const successes = store.getSnapshot().saveBanners.filter(row => row.key === 'save-succeeded')
    expect(successes).toHaveLength(1)
    expect(successes[0]?.body).toBe('已保存：alpha、beta。')
    const savedLogs = store.getSnapshot().logs
      .filter(entry => entry.text.includes('配置已保存'))
      .map(entry => entry.text)
    expect(savedLogs).toEqual([
      '配置已保存：agent-save:alpha。',
      '配置已保存：agent-save:beta。',
    ])
  })

  it('clears an agent\'s old failure receipts once its held save succeeds', async () => {
    const store = createStore()
    const idle = { canSave: true, gateAvailable: true, activeTurns: 0, activeSessions: [], pending: [], timeoutMs: 600_000 }
    const alpha = 'agent-save:alpha'
    const beta = 'agent-save:beta'
    const pending = {
      ...idle,
      canSave: false,
      activeTurns: 1,
      activeSessions: [
        { sessionId: 'acp-alpha', agentId: 'alpha' },
        { sessionId: 'acp-beta', agentId: 'beta' },
      ],
      pending: [{ id: 'save-1', label: alpha, queuedAt: 1 }],
      lastOutcomes: {
        [alpha]: { at: 5, status: 'failed' as const, label: alpha, message: 'old alpha failure' },
        [beta]: { at: 6, status: 'failed' as const, label: beta, message: 'beta failure' },
      },
    }
    await emit(store, { type: 'save/status', status: pending })
    expect(store.getSnapshot().saveBanners.map(row => row.key)).toEqual([
      'save-failed:agent-save:alpha',
      'save-failed:agent-save:beta',
    ])

    await emit(store, {
      type: 'save/status',
      status: {
        ...pending,
        canSave: true,
        activeTurns: 0,
        activeSessions: [],
        pending: [],
        lastOutcomes: {
          [alpha]: { at: 7, status: 'saved', label: alpha },
          [beta]: { at: 6, status: 'failed', label: beta, message: 'beta failure' },
        },
      },
    })
    const banners = store.getSnapshot().saveBanners
    expect(banners.some(row => row.key === 'save-failed:agent-save:alpha')).toBe(false)
    // Only the agent that succeeded loses its receipts.
    expect(banners.find(row => row.key === 'save-failed:agent-save:beta')?.body).toContain('beta failure')
    expect(banners.find(row => row.key === 'save-succeeded')?.body).toContain('alpha')
  })

  it('drops a stale cancelled receipt when a resync shows that label queued again', async () => {
    let cancelled = 0
    const idle = { canSave: true, gateAvailable: true, activeTurns: 0, activeSessions: [], pending: [], timeoutMs: 600_000 }
    const queued = {
      ...idle,
      canSave: false,
      activeTurns: 1,
      activeSessions: [{ sessionId: 'acp-1', agentId: 'pi' }],
      pending: [{ id: 'save-1', label: 'agent-save:pi', queuedAt: 1 }],
    }
    const store = new AcpStore(async (_channel, endpoint) => {
      if (endpoint === 'save/cancel') return { ok: true, value: { cancelled } }
      if (endpoint === 'save/status') return { ok: true, value: { status: queued } }
      if (endpoint === 'agents/list') return { ok: true, value: { agents: [] } }
      if (endpoint === 'sessions/list') return { ok: true, value: { sessions: [] } }
      if (endpoint === 'agents/detect') return { ok: true, value: { agents: [] } }
      return { ok: true, value: {} }
    }, (zh) => zh)

    await expect(store.cancelSaveGate('agent-save:pi')).resolves.toBe(false)
    cancelled = 1
    await store.retryBanner('save-cancel-failed:agent-save:pi')
    expect(store.getSnapshot().saveBanners.find(row => row.key === 'save-cancelled:agent-save:pi')).toBeDefined()

    await store.resync()
    expect(store.getSnapshot().saveBanners.some(row => row.key === 'save-cancelled:agent-save:pi')).toBe(false)
  })

  it('clears a deleted agent\'s failure rows and retry payloads', async () => {
    const calls: string[] = []
    const idle = { canSave: true, activeTurns: 0, activeSessions: [], pending: [], timeoutMs: 600_000 }
    const store = new AcpStore(async (_channel, endpoint) => {
      calls.push(endpoint)
      if (endpoint === 'agents/list') return { ok: true, value: { agents: [] } }
      if (endpoint === 'sessions/list') return { ok: true, value: { sessions: [] } }
      if (endpoint === 'agents/detect') return { ok: true, value: { agents: [] } }
      if (endpoint === 'save/status') return { ok: true, value: { status: idle } }
      if (endpoint === 'agent/save') return { ok: false, error: { code: 'write_failed', message: 'cannot write' } }
      return { ok: true, value: {} }
    }, (zh) => zh)
    await expect(store.saveAgent({ id: 'pi', command: 'pi-acp' }, 'direct')).rejects.toThrow('cannot write')
    expect(store.getSnapshot().saveBanners.map(row => row.key)).toContain('save-failed:pi')
    await emit(store, {
      type: 'save/status',
      status: {
        ...idle,
        lastOutcomes: { 'agent-save:pi': { at: 3, status: 'failed', label: 'agent-save:pi', message: 'write failed' } },
      },
    })
    expect(store.getSnapshot().saveBanners.map(row => row.key)).toContain('save-failed:agent-save:pi')

    await store.deleteAgent('pi')
    const keys = store.getSnapshot().saveBanners.map(row => row.key)
    expect(keys).not.toContain('save-failed:pi')
    expect(keys).not.toContain('save-failed:agent-save:pi')
    // The creation form reads this to warn before a doomed reuse.
    expect(store.getSnapshot().deletedAgentIds).toContain('pi')

    const savesBefore = calls.filter(endpoint => endpoint === 'agent/save').length
    await store.retryBanner('save-failed:pi')
    expect(calls.filter(endpoint => endpoint === 'agent/save')).toHaveLength(savesBefore)
  })

  it('does not escalate a gate retry with nothing to retry into a forced flush', async () => {
    const calls: string[] = []
    const store = createStore(endpoint => {
      calls.push(endpoint)
      if (endpoint === 'save/retry') return { retried: false }
      return { done: true }
    })
    await emit(store, {
      type: 'save/status',
      status: {
        canSave: true,
        activeTurns: 0,
        activeSessions: [],
        pending: [],
        timeoutMs: 600_000,
        lastOutcomes: {
          'settings:llm-pi-ai': { at: 5, status: 'failed', label: 'settings:llm-pi-ai', message: 'conflict' },
        },
      },
    })
    await store.retryBanner('save-failed:settings:llm-pi-ai')
    expect(calls).not.toContain('save/flush')
    expect(store.getSnapshot().saveBanners.find(row => row.key === 'save-retry-none:settings:llm-pi-ai'))
      .toMatchObject({ level: 'success', title: '已无待重试项' })
  })

  it('keeps the failed banner and reports the RPC error when save/retry throws', async () => {
    const store = createStore(endpoint => {
      if (endpoint === 'save/retry') return Promise.reject(new Error('retry transport exploded'))
      return { done: true }
    })
    await emit(store, {
      type: 'save/status',
      status: {
        canSave: true,
        gateAvailable: true,
        activeTurns: 0,
        activeSessions: [],
        pending: [],
        timeoutMs: 600_000,
        lastOutcomes: {
          'settings:llm-pi-ai': { at: 5, status: 'failed', label: 'settings:llm-pi-ai', message: 'conflict' },
        },
      },
    })
    await store.retryBanner('save-failed:settings:llm-pi-ai')
    // The original failure row survives: a failed RPC is not "nothing left".
    expect(store.getSnapshot().saveBanners.find(row => row.key === 'save-failed:settings:llm-pi-ai')).toBeDefined()
    const receipt = store.getSnapshot().saveBanners.find(row => row.key === 'save-retry-failed:settings:llm-pi-ai')
    expect(receipt).toMatchObject({ source: 'save-retry-failed', level: 'error' })
    expect(receipt?.body).toContain('retry transport exploded')
    expect(store.getSnapshot().saveBanners.some(row => row.key === 'save-retry-none:settings:llm-pi-ai')).toBe(false)
  })

  it('keeps a partial force banner after a failed retry/force and reports the error', async () => {
    let failFlush = false
    const idle = {
      canSave: true,
      gateAvailable: true,
      activeTurns: 0,
      activeSessions: [],
      pending: [],
      timeoutMs: 600_000,
    }
    const store = createStore(endpoint => {
      if (endpoint === 'save/flush') {
        if (failFlush) return Promise.reject(new Error('flush transport down'))
        return { saved: 0, expired: 0, failed: 1 }
      }
      if (endpoint === 'save/status') return { status: idle }
      return { done: true }
    })
    await store.forceSaveGate()
    expect(store.getSnapshot().saveBanners.find(row => row.key === 'save-partial')).toBeDefined()

    failFlush = true
    await store.retryBanner('save-partial')
    expect(store.getSnapshot().saveBanners.find(row => row.key === 'save-partial')).toBeDefined()
    expect(store.getSnapshot().saveBanners.find(row => row.key === 'save-retry-failed:flush')?.body)
      .toContain('flush transport down')

    await store.forceBanner('save-partial')
    expect(store.getSnapshot().saveBanners.find(row => row.key === 'save-partial')).toBeDefined()
    expect(store.getSnapshot().saveBanners.find(row => row.key === 'save-retry-failed:flush')?.body)
      .toContain('flush transport down')
    expect(store.getSnapshot().saveBanners.some(row => row.key.startsWith('save-retry-none'))).toBe(false)
  })

  it('reports a cancel the host did not perform and retries it from the banner', async () => {
    let cancelled = 0
    const idle = { canSave: true, activeTurns: 0, activeSessions: [], pending: [], timeoutMs: 600_000 }
    const pending = {
      ...idle,
      canSave: false,
      activeTurns: 1,
      activeSessions: [{ sessionId: 'acp-1', agentId: 'pi' }],
      pending: [{ id: 'save-1', label: 'agent-save:pi', queuedAt: 1 }],
    }
    const store = new AcpStore(async (_channel, endpoint) => {
      if (endpoint === 'save/cancel') return { ok: true, value: { cancelled } }
      if (endpoint === 'agents/list') return { ok: true, value: { agents: [] } }
      if (endpoint === 'sessions/list') return { ok: true, value: { sessions: [] } }
      if (endpoint === 'agents/detect') return { ok: true, value: { agents: [] } }
      if (endpoint === 'save/status') return { ok: true, value: { status: pending } }
      return { ok: true, value: {} }
    }, (zh) => zh)
    await emit(store, { type: 'save/status', status: pending })

    await expect(store.cancelSaveGate('agent-save:pi')).resolves.toBe(false)
    expect(store.getSnapshot().saveGate.pending).toHaveLength(1)
    expect(store.getSnapshot().saveBanners.find(row => row.key === 'save-cancel-failed:agent-save:pi'))
      .toMatchObject({ level: 'error', actions: ['retry', 'dismiss'], body: '取消未生效，回合结束会写入点击时版本。' })

    cancelled = 1
    await store.retryBanner('save-cancel-failed:agent-save:pi')
    expect(store.getSnapshot().saveGate.pending).toEqual([])
    expect(store.getSnapshot().saveBanners.find(row => row.key === 'save-cancelled:agent-save:pi'))
      .toMatchObject({ level: 'success', title: '已取消暂存' })
  })

  it('only dismisses the banner row whose timestamp the timer captured', async () => {
    const idle = { canSave: true, activeTurns: 0, activeSessions: [], pending: [], timeoutMs: 600_000 }
    const store = createStore()
    await emit(store, {
      type: 'save/status',
      status: { ...idle, canSave: false, activeTurns: 1, pending: [{ id: 'save-1', label: 'settings:llm-pi-ai', queuedAt: 1 }] },
    })
    await emit(store, {
      type: 'save/status',
      status: { ...idle, lastOutcomes: { 'settings:llm-pi-ai': { at: 6, status: 'saved', label: 'settings:llm-pi-ai' } } },
    })
    const at = store.getSnapshot().saveBanners.find(row => row.key === 'save-succeeded')?.at
    expect(at).toBeTypeOf('number')
    store.dismissBanner('save-succeeded', (at ?? 0) - 1)
    expect(store.getSnapshot().saveBanners.some(row => row.key === 'save-succeeded')).toBe(true)
    store.dismissBanner('save-succeeded', at)
    expect(store.getSnapshot().saveBanners.some(row => row.key === 'save-succeeded')).toBe(false)
  })

  it('compares gate snapshots by label and terminal status, not by a browser clock', () => {
    const idle = { canSave: true, activeTurns: 0, activeSessions: [], pending: [], timeoutMs: 600_000 }
    const pending = {
      ...idle,
      canSave: false,
      activeTurns: 1,
      pending: [{ id: 'save-1', label: 'agent-save:pi', queuedAt: 1 }],
    }
    const settled = {
      ...idle,
      lastOutcomes: { 'agent-save:pi': { at: 5, status: 'failed' as const, label: 'agent-save:pi', message: 'x' } },
    }
    const first = saveGateTransitions(undefined, pending)
    expect(first.addedPending).toHaveLength(1)
    expect(first.outcomes).toEqual([])
    const second = saveGateTransitions(pending, settled)
    expect(second.outcomes).toEqual([
      { label: 'agent-save:pi', outcome: settled.lastOutcomes['agent-save:pi'], wasPending: true, isPending: false },
    ])
    expect(saveGateTransitions(settled, settled).outcomes).toEqual([])
  })

  it('does not resync or probe a save the host cancelled because the agent vanished', async () => {
    const calls: string[] = []
    const store = new AcpStore(async (_channel, endpoint) => {
      calls.push(endpoint)
      if (endpoint === 'agent/save') return { ok: true, value: { done: false, cancelled: true } }
      return { ok: true, value: {} }
    }, (zh) => zh)
    await expect(store.saveAgent({ id: 'pi', command: 'pi-acp' }, 'direct'))
      .resolves.toEqual({ done: false, cancelled: true })
    expect(calls).toEqual(['agent/save'])
  })

  it('reports agent_deleted as a cancelled save without retry or force', async () => {
    const calls: string[] = []
    const store = createStore(endpoint => {
      calls.push(endpoint)
      if (endpoint === 'agent/save') {
        return Promise.reject(Object.assign(new Error('the agent was deleted'), { code: 'agent_deleted' }))
      }
      return { done: true }
    })
    await expect(store.saveAgent({ id: 'pi', command: 'pi-acp' }, 'direct')).rejects.toThrow('deleted')
    const banner = store.getSnapshot().saveBanners.find(entry => entry.key === 'save-failed:pi')
    expect(banner).toMatchObject({ source: 'save-failed', level: 'error', actions: ['dismiss'] })
    expect(banner?.title).toBe('保存已取消')
    expect(banner?.body).toBe('该 Agent 已被删除，本次保存已取消。')
    expect(store.getSnapshot().deletedAgentIds).toContain('pi')
    // The retry gesture is gone: no payload was retained, so it cannot recreate
    // the id the user removed.
    const savesBefore = calls.filter(endpoint => endpoint === 'agent/save').length
    await store.retryBanner('save-failed:pi')
    expect(calls.filter(endpoint => endpoint === 'agent/save')).toHaveLength(savesBefore)
  })

  it('keeps a write-failure notice whose source id is not a configured agent', async () => {
    const store = createStore()
    const text = 'profile write failed: revision conflict'
    await emit(store, { type: 'agent/notice', agentId: 'dsh-ntr', level: 'error', text })
    const entry = store.getSnapshot().logs[store.getSnapshot().logs.length - 1]
    expect(entry).toMatchObject({ level: 'error', agentId: 'dsh-ntr', text })
    // It is a log line, not an HMR/save banner.
    expect(store.getSnapshot().saveBanners).toEqual([])
  })
})

/**
 * The released banner reads a CACHED row list. A `session/chat-list` read that
 * started before a resume / release / close must not overwrite the frame that
 * landed while it was in flight, and a turn start must ask the host again.
 */
describe('AcpStore chat-row freshness (the released banner follows the host)', () => {
  type Answer = { ok: true; value: unknown }

  function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
    let resolve: (value: T) => void = () => {}
    const promise = new Promise<T>(done => { resolve = done })
    return { promise, resolve }
  }

  function row(released?: boolean): ChatSessionView {
    return { agentId: 'pi', sessionId: 's1', ...(released === true ? { released: true } : {}) }
  }

  function view(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      sessionId: 's1', agentId: 'pi', acpSessionId: 'acp-1', cwd: '/w',
      running: false, closed: false, seq: 0, ...overrides,
    }
  }

  function apply(store: AcpStore, event: unknown): Promise<void> {
    return (store as unknown as { applyEvent(event: unknown): Promise<void> }).applyEvent(event)
  }

  /** Answers by read order; the last one repeats if a test reads more. */
  function makeStore(
    answers: Array<Answer | Promise<Answer>>,
  ): { store: AcpStore; reads: () => number } {
    let reads = 0
    const store = new AcpStore(async (_channel, endpoint) => {
      if (endpoint !== 'session/chat-list') return { ok: true, value: { done: true } }
      const answer = answers[Math.min(reads, answers.length - 1)]
      reads += 1
      return answer
    }, zh => zh)
    return { store, reads: () => reads }
  }

  function answered(rows: ChatSessionView[]): Answer {
    return { ok: true, value: { sessions: rows } }
  }

  it('replays a resume frame over a chat-list answer that started before the resume', async () => {
    const held = deferred<Answer>()
    const { store } = makeStore([held.promise])
    const pending = store.loadChatSessions('chat-1')

    await apply(store, { type: 'session/reset', sessionId: 's1', session: view() })
    held.resolve({ ok: true, value: { sessions: [row(true)] } })
    await pending

    expect(store.getSnapshot().chatSessions[0]?.released).not.toBe(true)
    expect(releasedBannerVisible(store.getSnapshot(), 'chat-1')).toBe(false)
  })

  it('replays a release frame over a live chat-list answer', async () => {
    const held = deferred<Answer>()
    const { store } = makeStore([held.promise])
    const pending = store.loadChatSessions('chat-1')

    await apply(store, {
      type: 'session/released', sessionId: 's1', session: view({ released: true }), reason: 'agent process exited',
    })
    held.resolve({ ok: true, value: { sessions: [row()] } })
    await pending

    expect(store.getSnapshot().chatSessions[0]?.released).toBe(true)
    expect(releasedBannerVisible(store.getSnapshot(), 'chat-1')).toBe(true)
  })

  it('replays a close frame so a late answer cannot resurrect a closed row', async () => {
    const held = deferred<Answer>()
    const { store } = makeStore([held.promise])
    const pending = store.loadChatSessions('chat-1')

    await apply(store, { type: 'session/closed', sessionId: 's1', reason: 'closed' })
    held.resolve({ ok: true, value: { sessions: [row(true)] } })
    await pending

    expect(store.getSnapshot().chatSessions).toEqual([])
    expect(releasedBannerVisible(store.getSnapshot(), 'chat-1')).toBe(false)
  })

  it('re-reads the row list on every turn start and drops the stale in-flight read', async () => {
    const held = deferred<Answer>()
    // Read #1 seeds `chatSessionsFor` (the banner cannot show without it).
    // Read #2 hangs so the turn start has a stale read to drop. Read #3 is
    // the forced read and carries the host's live row.
    const { store, reads } = makeStore([answered([row(true)]), held.promise, answered([row()])])
    await store.loadChatSessions('chat-1')
    expect(releasedBannerVisible(store.getSnapshot(), 'chat-1')).toBe(true)
    const stale = store.loadChatSessions('chat-1')

    await apply(store, { type: 'turn/start', sessionId: 's1', turnId: 't1', text: 'hi' })
    held.resolve(answered([row(true)]))
    await stale
    await vi.waitFor(() => expect(store.getSnapshot().chatSessions[0]?.released).not.toBe(true))

    expect(reads()).toBe(3)
    expect(releasedBannerVisible(store.getSnapshot(), 'chat-1')).toBe(false)
  })

  it('forces a fresh answer after the explicit resume button', async () => {
    const held = deferred<Answer>()
    const { store, reads } = makeStore([answered([row(true)]), held.promise, answered([row()])])
    await store.loadChatSessions('chat-1')
    expect(releasedBannerVisible(store.getSnapshot(), 'chat-1')).toBe(true)
    const stale = store.loadChatSessions('chat-1')

    // The host's "already live" branch broadcasts no frame at all: only a
    // forced read can clear a row the browser still holds as released.
    await store.resumeChatSession('chat-1')
    held.resolve(answered([row(true)]))
    await stale

    expect(reads()).toBe(3)
    expect(store.getSnapshot().chatSessions[0]?.released).not.toBe(true)
    expect(releasedBannerVisible(store.getSnapshot(), 'chat-1')).toBe(false)
  })

  it('replays only later frames and only rows the answer already carries', () => {
    const rows = [row(true)]
    // A frame the read had already seen is not applied twice.
    expect(replayChatRowFrames(rows, [{ seq: 1, sessionId: 's1', kind: 'reset' }], 1)).toEqual(rows)
    // Another conversation's session must never enter this conversation's list.
    expect(replayChatRowFrames(rows, [{ seq: 1, sessionId: 'other', kind: 'reset' }], 0)).toEqual(rows)
    // Later frames apply in arrival order, so the last state wins.
    expect(replayChatRowFrames(rows, [
      { seq: 1, sessionId: 's1', kind: 'released' },
      { seq: 2, sessionId: 's1', kind: 'reset' },
    ], 0)).toEqual([{ agentId: 'pi', sessionId: 's1', released: false }])
  })
})

describe('agentSkills (the / menu skill rows)', () => {
  const ROWS_A: AgentSkillEntry[] = [
    { token: 'skill-a', name: 'A', scope: 'project', folder: 'skill-a', insertion: 'use /skill-a [Skill Path](.claude/skills/skill-a)' },
  ]
  const ROWS_B: AgentSkillEntry[] = [
    { token: 'skill-b', name: 'B', scope: 'global', folder: 'skill-b', insertion: 'use /skill-b [Skill Path](/home/u/.claude/skills/skill-b)' },
  ]

  interface SkillHarness {
    store: AcpStore
    calls: Array<{ endpoint: string; payload: unknown }>
    setAnswer(rows: AgentSkillEntry[]): void
  }

  function skillHarness(): SkillHarness {
    const calls: Array<{ endpoint: string; payload: unknown }> = []
    let answer: { skills: AgentSkillEntry[] } = { skills: [] }
    const store = new AcpStore(async (_channel, endpoint, payload) => {
      calls.push({ endpoint, payload })
      if (endpoint === 'agent/skills') return { ok: true, value: answer }
      return { ok: true, value: {} }
    }, (zh) => zh)
    return {
      store,
      calls,
      setAnswer(rows) { answer = { skills: rows } },
    }
  }

  it('joins concurrent reads into one RPC, and reads again once the read settled', async () => {
    let release: ((value: { ok: true; value: { skills: AgentSkillEntry[] } }) => void) | undefined
    const calls: Array<{ endpoint: string }> = []
    const store = new AcpStore(async (_channel, endpoint) => {
      calls.push({ endpoint })
      if (endpoint === 'agent/skills') {
        return new Promise(resolve => { release = resolve })
      }
      return { ok: true, value: {} }
    }, (zh) => zh)
    await store.bindChatAgent('chat-1', 'agent-a')

    const first = store.loadAgentSkills('chat-1')
    const second = store.loadAgentSkills('chat-1')
    expect(second).toBe(first)
    release!({ ok: true, value: { skills: ROWS_A } })
    await first
    expect(store.skillRowsFor('chat-1')).toEqual(ROWS_A)
    expect(calls.filter(row => row.endpoint === 'agent/skills')).toHaveLength(1)

    // Settled reads leave the map, so the next caller past the TTL re-asks.
    expect(store.loadAgentSkills('chat-1')).not.toBe(first)
  })

  it('records "unknown agent" as NOTHING: no state, no RPC, self-heals once a binding lands', async () => {
    const { store, calls, setAnswer } = skillHarness()
    setAnswer(ROWS_A)

    await store.loadAgentSkills('chat-1')
    expect(calls.filter(row => row.endpoint === 'agent/skills')).toEqual([])
    expect(store.skillRowsFor('chat-1')).toBeUndefined()
    expect(store.getSnapshot().agentSkills).toEqual({})

    // The binding appears (the composer's optimistic click): the next menu
    // poll fetches normally.
    await store.bindChatAgent('chat-1', 'agent-a')
    await store.loadAgentSkills('chat-1')
    expect(store.skillRowsFor('chat-1')).toEqual(ROWS_A)
    expect(calls.filter(row => row.endpoint === 'agent/skills')).toEqual([
      { endpoint: 'agent/skills', payload: { dshSessionId: 'chat-1', agentId: 'agent-a' } },
    ])
  })

  it('keeps [] (confirmed empty) apart from undefined (never asked / expired / agent moved)', async () => {
    const { store, calls, setAnswer } = skillHarness()
    await store.bindChatAgent('chat-2', 'agent-a')
    setAnswer([])

    await store.loadAgentSkills('chat-2')
    expect(store.skillRowsFor('chat-2')).toEqual([])
    // Another conversation has no answer at all — never this one's empty.
    expect(store.skillRowsFor('chat-9')).toBeUndefined()
    // And a failing read writes nothing: the rows stay "unknown". The read
    // REJECTS — the slash wrapper is the caller that degrades it to an empty
    // menu.
    const failing = new AcpStore(async (_channel, endpoint) => {
      calls.push({ endpoint, payload: undefined })
      if (endpoint === 'agent/skills') return { ok: false, error: { code: 'unknown_endpoint', message: 'older host' } }
      return { ok: true, value: {} }
    }, (zh) => zh)
    await failing.bindChatAgent('chat-3', 'agent-a')
    await expect(failing.loadAgentSkills('chat-3')).rejects.toThrow('older host')
    expect(failing.skillRowsFor('chat-3')).toBeUndefined()
  })

  it('expires the rows past the TTL and re-asks', async () => {
    vi.useFakeTimers()
    try {
      const { store, setAnswer } = skillHarness()
      await store.bindChatAgent('chat-1', 'agent-a')
      setAnswer(ROWS_A)
      await store.loadAgentSkills('chat-1')
      expect(store.skillRowsFor('chat-1')).toEqual(ROWS_A)

      vi.setSystemTime(Date.now() + SKILL_MENU_TTL_MS + 1)
      expect(store.skillRowsFor('chat-1')).toBeUndefined()
      await store.loadAgentSkills('chat-1')
      expect(store.skillRowsFor('chat-1')).toEqual(ROWS_A)
    } finally {
      vi.useRealTimers()
    }
  })

  it('invalidates by composite key on an agent switch, and never shows the old agent within the TTL', async () => {
    const { store, calls, setAnswer } = skillHarness()
    await store.bindChatAgent('chat-1', 'agent-a')
    setAnswer(ROWS_A)
    await store.loadAgentSkills('chat-1')
    expect(store.skillRowsFor('chat-1')).toEqual(ROWS_A)
    expect(store.skillInsertionFor('chat-1', 'skill-a')).toBe(ROWS_A[0].insertion)

    // The user binds agent B. The old rows become unaddressable IMMEDIATELY —
    // no invalidation hook, no TTL wait.
    await store.bindChatAgent('chat-1', 'agent-b')
    setAnswer(ROWS_B)
    expect(store.skillRowsFor('chat-1')).toBeUndefined()
    expect(store.skillInsertionFor('chat-1', 'skill-a')).toBeUndefined()

    await store.loadAgentSkills('chat-1')
    expect(store.skillRowsFor('chat-1')).toEqual(ROWS_B)
    expect(store.skillInsertionFor('chat-1', 'skill-b')).toBe(ROWS_B[0].insertion)
    // Each read named the agent that was current at read time.
    expect(calls.filter(row => row.endpoint === 'agent/skills').map(row => (row.payload as { agentId: string }).agentId))
      .toEqual(['agent-a', 'agent-b'])
    // And A's rows never came back: both answers sit under different keys.
    expect(Object.keys(store.getSnapshot().agentSkills).sort()).toEqual([
      skillRowsKey('chat-1', 'agent-a'),
      skillRowsKey('chat-1', 'agent-b'),
    ].sort())
  })
})

