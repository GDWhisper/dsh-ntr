/**
 * Browser-side state store for the ACP panel. Owns: the `/acp` RPC calls, the
 * `/api/acp/stream` EventSource, per-session block folding (raw ACP
 * `session/update` → render blocks), and the pending permission set.
 *
 * Deliberately framework-free: React binds through `useSyncExternalStore`.
 */

import type { AcpEvent, AgentSavePayload, AgentView, DetectedAgentInfo, SessionView } from '../protocol.ts'

/** The unary RPC face (narrowed `ctx.connection.rpc.call`). */
export type RpcCall = (channel: string, endpoint: string, payload: unknown) => Promise<
  | { ok: true; value: unknown }
  | { ok: false; error: { code: string; message: string } }
>

export type Block =
  | { kind: 'user'; text: string }
  | { kind: 'agent'; messageId?: string; text: string }
  | { kind: 'thought'; text: string }
  | { kind: 'tool'; toolCallId: string; title: string; status: string; toolKind?: string; lines: string[]; raw?: string }
  | { kind: 'plan'; entries: Array<{ content: string; status: string; priority?: string }> }
  | { kind: 'notice'; tone: 'info' | 'error'; text: string }

export interface PendingPermission {
  requestId: string
  sessionId: string
  title: string
  options: Array<{ optionId: string; name: string; kind: string }>
}

export interface UiState {
  open: boolean
  stream: 'init' | 'live' | 'down'
  agents: AgentView[]
  sessions: SessionView[]
  activeSessionId?: string
  blocks: Block[]
  permissions: PendingPermission[]
  busy: boolean
  notice?: string
  defaultModel?: string
  detectedAgents: DetectedAgentInfo[]
  detecting: boolean
}

interface Listener { (): void }

const MAX_BLOCKS = 400

function updateContentToLines(content: unknown): string[] {
  if (!Array.isArray(content)) return []
  const out: string[] = []
  for (const item of content) {
    if (typeof item !== 'object' || item === null) continue
    const row = item as Record<string, unknown>
    if (row.type === 'content') {
      const inner = row.content as Record<string, unknown> | undefined
      if (inner?.type === 'text' && typeof inner.text === 'string') out.push(inner.text)
      else if (inner?.type === 'diff') out.push(`diff ${String(inner.path ?? '')}`)
      else out.push(`[${String(inner?.type ?? 'content')}]`)
    } else if (row.type === 'terminal') {
      out.push(`[terminal ${String(row.terminalId ?? '')}]`)
    }
  }
  return out
}

export const DEFAULT_KNOWN_PRESETS: DetectedAgentInfo[] = [
  {
    id: 'pi',
    name: 'Pi Coding Agent',
    description: 'Automata / Pi Coding Agent with native ACP bridge support',
    detected: false,
    defaultCommand: 'pi-acp',
    defaultArgs: [],
  },
]

export class AcpStore {
  private state: UiState = {
    open: false,
    stream: 'init',
    agents: [],
    sessions: [],
    blocks: [],
    permissions: [],
    busy: false,
    detectedAgents: [...DEFAULT_KNOWN_PRESETS],
    detecting: false,
  }

  private readonly listeners = new Set<Listener>()
  private source?: EventSource
  private readonly lastSeq = new Map<string, number>()

  constructor(private readonly rpc: RpcCall, private readonly locale: (zh: string, en: string) => string) {}

  // ---- React bridge ----

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  getSnapshot(): UiState {
    return this.state
  }

  private mutate(patch: Partial<UiState>, blocksChanged = false): void {
    this.state = {
      ...this.state,
      ...patch,
      blocks: blocksChanged ? [...this.state.blocks] : patch.blocks ?? this.state.blocks,
    }
    for (const listener of [...this.listeners]) listener()
  }

  // ---- Transport ----

  /** Open the shared event stream once; schedule first snapshot fetch. */
  start(): void {
    if (this.source !== undefined) return
    this.connectStream()
  }

  private connectStream(): void {
    const source = new EventSource('/api/acp/stream')
    source.onopen = () => {
      void this.resync()
      this.mutate({ stream: 'live' })
    }
    source.onerror = () => {
      this.mutate({ stream: 'down' })
    }
    source.onmessage = raw => {
      let event: AcpEvent
      try {
        event = JSON.parse(String(raw.data)) as AcpEvent
      } catch {
        return
      }
      void this.applyEvent(event)
    }
    this.source = source
  }

  private async call<T>(endpoint: string, payload: unknown = {}): Promise<T> {
    const result = await this.rpc('/acp', endpoint, payload)
    if (!result.ok) throw new Error(result.error.message)
    return result.value as T
  }

  /** Snapshot refresh used on panel open and after a stream outage. */
  async resync(): Promise<void> {
    try {
      const [{ agents }, { sessions }, defaultModelInfo, detectResult] = await Promise.all([
        this.call<{ agents: AgentView[] }>('agents/list'),
        this.call<{ sessions: SessionView[] }>('sessions/list'),
        this.call<{ provider?: string; model?: string }>('model/get-default').catch(() => ({} as { provider?: string; model?: string })),
        this.call<{ agents: DetectedAgentInfo[] }>('agents/detect').catch(() => null),
      ])
      const defaultModel = defaultModelInfo?.provider === 'acp' ? defaultModelInfo.model : undefined
      const detectedAgents = (detectResult && detectResult.agents.length > 0)
        ? detectResult.agents
        : (this.state.detectedAgents.length > 0 ? this.state.detectedAgents : [...DEFAULT_KNOWN_PRESETS])
      this.mutate({ agents, sessions, defaultModel, detectedAgents })
      const active = this.state.activeSessionId ?? sessions[0]?.sessionId
      if (active !== undefined) await this.loadTranscript(active)
    } catch (error) {
      this.mutate({ notice: String(error instanceof Error ? error.message : error) })
    }
  }

  async detectAgents(): Promise<void> {
    this.mutate({ detecting: true })
    try {
      const result = await this.call<{ agents: DetectedAgentInfo[] }>('agents/detect')
      this.mutate({
        detectedAgents: result.agents.length > 0 ? result.agents : [...DEFAULT_KNOWN_PRESETS],
        detecting: false,
      })
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      const notice = msg.includes('unknown endpoint agents/detect')
        ? this.locale('宿主服务运行着旧版本代码，请在终端重启 dsh web 服务以激活主机检测功能。', 'Host running older version. Please restart dsh web to enable agent detection.')
        : msg
      this.mutate({
        detecting: false,
        notice,
        detectedAgents: this.state.detectedAgents.length > 0 ? this.state.detectedAgents : [...DEFAULT_KNOWN_PRESETS],
      })
    }
  }

  async saveAgent(payload: AgentSavePayload): Promise<void> {
    try {
      await this.call('agent/save', payload)
      await this.resync()
    } catch (error) {
      this.flashError(error)
      throw error
    }
  }

  async deleteAgent(agentId: string): Promise<void> {
    try {
      await this.call('agent/delete', { agentId })
      await this.resync()
    } catch (error) {
      this.flashError(error)
      throw error
    }
  }

  // ---- Panel lifecycle ----

  toggle(): void {
    const nextOpen = !this.state.open
    this.mutate({ open: nextOpen })
    if (nextOpen) {
      this.start()
      void this.resync()
    }
  }

  close(): void {
    this.mutate({ open: false })
  }

  selectSession(sessionId: string): void {
    this.mutate({ activeSessionId: sessionId })
    void this.loadTranscript(sessionId)
  }

  private async loadTranscript(sessionId: string): Promise<void> {
    try {
      const { session, entries } = await this.call<{ session: SessionView; entries: Array<{ seq: number; update: Record<string, unknown> }> }>(
        'transcript/get',
        { sessionId },
      )
      const blocks: Block[] = []
      for (const entry of entries) {
        const before = blocks.length
        foldUpdate(blocks, entry.update)
        this.lastSeq.set(sessionId, Math.max(this.lastSeq.get(sessionId) ?? 0, entry.seq))
        void before
      }
      const sessions = this.state.sessions.some(s => s.sessionId === sessionId)
        ? this.state.sessions.map(s => (s.sessionId === sessionId ? session : s))
        : [...this.state.sessions, session]
      this.mutate({ sessions, blocks, activeSessionId: sessionId })
    } catch {
      this.mutate({ blocks: [] })
    }
  }

  // ---- Actions ----

  async startSession(agentId: string, cwd?: string): Promise<void> {
    try {
      const { sessionId } = await this.call<{ sessionId: string }>('session/start', { agentId, ...(cwd === undefined || cwd === '' ? {} : { cwd }) })
      await this.resync()
      this.selectSession(sessionId)
    } catch (error) {
      this.flashError(error)
    }
  }

  async sendPrompt(text: string): Promise<void> {
    const sessionId = this.state.activeSessionId
    if (sessionId === undefined || text.trim() === '') return
    this.mutate({ busy: true })
    try {
      await this.call('session/prompt', { sessionId, text })
    } catch (error) {
      this.flashError(error)
    } finally {
      this.mutate({ busy: false })
    }
  }

  async cancelActive(): Promise<void> {
    const sessionId = this.state.activeSessionId
    if (sessionId === undefined) return
    try {
      await this.call('session/cancel', { sessionId })
    } catch (error) {
      this.flashError(error)
    }
  }

  async closeActive(): Promise<void> {
    const sessionId = this.state.activeSessionId
    if (sessionId === undefined) return
    try {
      await this.call('session/close', { sessionId })
    } catch (error) {
      this.flashError(error)
    }
  }

  async setMode(modeId: string): Promise<void> {
    const sessionId = this.state.activeSessionId
    if (sessionId === undefined) return
    try {
      await this.call('session/mode-set', { sessionId, modeId })
    } catch (error) {
      this.flashError(error)
    }
  }

  async setConfigOption(configId: string, value: string): Promise<void> {
    const sessionId = this.state.activeSessionId
    if (sessionId === undefined) return
    try {
      await this.call('session/config-set', { sessionId, configId, value })
    } catch (error) {
      this.flashError(error)
    }
  }

  async respondPermission(requestId: string, optionId?: string): Promise<void> {
    try {
      await this.call('permission/respond', { requestId, ...(optionId === undefined ? {} : { optionId }) })
    } catch (error) {
      this.flashError(error)
    }
  }

  async stopAgent(agentId: string): Promise<void> {
    try {
      await this.call('agent/stop', { agentId })
      await this.resync()
    } catch (error) {
      this.flashError(error)
    }
  }

  async setDefaultModel(agentId: string): Promise<void> {
    try {
      await this.call('model/set-default', { agentId })
      this.mutate({ defaultModel: agentId })
    } catch (error) {
      this.flashError(error)
    }
  }

  async setPermission(agentId: string, permission: 'ask' | 'allow' | 'reject'): Promise<void> {
    try {
      await this.call('agent/set-permission', { agentId, permission })
      await this.resync()
    } catch (error) {
      this.flashError(error)
    }
  }

  label(zh: string, en: string): string {
    return this.locale(zh, en)
  }

  clearNotice(): void {
    this.mutate({ notice: undefined })
  }

  private flashError(error: unknown): void {
    this.mutate({ notice: error instanceof Error ? error.message : String(error) })
  }

  // ---- Event application ----

  private applyEvent(event: AcpEvent): Promise<void> {
    switch (event.type) {
      case 'agent/status': {
        if (event.agent !== undefined) {
          const agents = this.state.agents.some(a => a.id === event.agent?.id)
            ? this.state.agents.map(a => (a.id === event.agent?.id ? event.agent : a))
            : [...this.state.agents, event.agent]
          this.mutate({ agents })
        } else {
          this.mutate({})
        }
        return Promise.resolve()
      }
      case 'session/created': {
        const sessions = this.state.sessions.some(s => s.sessionId === event.sessionId)
          ? this.state.sessions.map(s => (s.sessionId === event.sessionId ? event.session : s))
          : [...this.state.sessions, event.session]
        this.mutate({ sessions, activeSessionId: this.state.activeSessionId ?? event.sessionId })
        return Promise.resolve()
      }
      case 'session/meta': {
        // Host re-published the session view after mode/config changes.
        const sessions = this.state.sessions.some(s => s.sessionId === event.sessionId)
          ? this.state.sessions.map(s => (s.sessionId === event.sessionId ? event.session : s))
          : this.state.sessions
        this.mutate({ sessions })
        return Promise.resolve()
      }
      case 'session/closed': {
        const sessions = this.state.sessions.filter(s => s.sessionId !== event.sessionId)
        const active = this.state.activeSessionId === event.sessionId ? sessions[0]?.sessionId : this.state.activeSessionId
        this.mutate({
          sessions,
          activeSessionId: active,
          permissions: this.state.permissions.filter(p => p.sessionId !== event.sessionId),
          ...(event.reason === 'agent-died' ? { notice: this.locale('会话因 agent 进程退出而终止', 'session ended: agent process died') } : {}),
        })
        return Promise.resolve()
      }
      case 'session/update': {
        if (event.sessionId !== this.state.activeSessionId) {
          // Background session: bump its seq bound; full refresh happens on select.
          this.lastSeq.set(event.sessionId, event.seq)
          return Promise.resolve()
        }
        const seen = this.lastSeq.get(event.sessionId)
        if (seen !== undefined && event.seq !== seen + 1) {
          void this.loadTranscript(event.sessionId) // gap detected → replay
          return Promise.resolve()
        }
        this.lastSeq.set(event.sessionId, event.seq)
        foldUpdate(this.state.blocks, event.update as unknown as Record<string, unknown>)
        this.mutate({ blocks: [...this.state.blocks] })
        return Promise.resolve()
      }
      case 'permission/request': {
        const title = typeof (event.toolCall as { title?: unknown } | undefined)?.title === 'string'
          ? String((event.toolCall as { title: string }).title)
          : this.locale('工具调用', 'tool call')
        this.mutate({
          permissions: [...this.state.permissions.filter(p => p.requestId !== event.requestId), {
            requestId: event.requestId,
            sessionId: event.sessionId,
            title,
            options: event.options,
          }],
        })
        return Promise.resolve()
      }
      case 'permission/resolved': {
        this.mutate({ permissions: this.state.permissions.filter(p => p.requestId !== event.requestId) })
        return Promise.resolve()
      }
      case 'turn/start': {
        if (event.sessionId === this.state.activeSessionId) {
          this.state.blocks.push({ kind: 'user', text: event.text })
          trimBlocks(this.state.blocks)
          this.mutate({ sessions: this.state.sessions.map(s => (s.sessionId === event.sessionId ? { ...s, running: true } : s)) })
        }
        return Promise.resolve()
      }
      case 'turn/end': {
        if (event.sessionId === this.state.activeSessionId) {
          if (event.error !== undefined) {
            this.state.blocks.push({ kind: 'notice', tone: 'error', text: event.error })
          } else if (event.stopReason !== undefined && event.stopReason !== 'end_turn') {
            this.state.blocks.push({ kind: 'notice', tone: 'info', text: `stop: ${event.stopReason}` })
          }
          trimBlocks(this.state.blocks)
          this.mutate({ sessions: this.state.sessions.map(s => (s.sessionId === event.sessionId ? { ...s, running: false } : s)) })
        }
        return Promise.resolve()
      }
      default:
        return Promise.resolve()
    }
  }
}

/** Merge a raw ACP update into the block list (mutates in place). */
export function foldUpdate(blocks: Block[], update: Record<string, unknown>): void {
  const kind = String(update.sessionUpdate ?? '')
  const content = update.content as Record<string, unknown> | undefined
  switch (kind) {
    case 'user_message_chunk':
    case 'agent_message_chunk':
    case 'agent_thought_chunk': {
      const targetKind = kind === 'user_message_chunk' ? 'user' : kind === 'agent_message_chunk' ? 'agent' : 'thought'
      const text = content?.type === 'text' && typeof content.text === 'string'
        ? content.text
        : content !== undefined ? `[${String(content.type)}]` : ''
      if (text === '') return
      const messageId = typeof update.messageId === 'string' ? update.messageId : undefined
      const last = blocks[blocks.length - 1]
      if (targetKind === 'agent' && last?.kind === 'agent' && ((messageId !== undefined && last.messageId === messageId) || (messageId === undefined && last.messageId === undefined))) {
        last.text += text
      } else if (targetKind !== 'agent' && last?.kind === targetKind) {
        last.text += text
      } else if (targetKind === 'agent') {
        blocks.push({ kind: 'agent', ...(messageId === undefined ? {} : { messageId }), text })
      } else {
        blocks.push({ kind: targetKind, text })
      }
      return
    }
    case 'tool_call': {
      blocks.push({
        kind: 'tool',
        toolCallId: String(update.toolCallId ?? ''),
        title: String(update.title ?? ''),
        status: String(update.status ?? 'pending'),
        ...(typeof update.kind === 'string' ? { toolKind: update.kind } : {}),
        lines: updateContentToLines(update.content),
      })
      return
    }
    case 'tool_call_update': {
      const id = String(update.toolCallId ?? '')
      for (let i = blocks.length - 1; i >= 0; i--) {
        const block = blocks[i]
        if (block?.kind !== 'tool' || block.toolCallId !== id) continue
        if (typeof update.title === 'string' && update.title !== '') block.title = update.title
        if (typeof update.status === 'string') block.status = update.status
        const lines = updateContentToLines(update.content)
        if (lines.length > 0) block.lines = lines
        return
      }
      // Update for a tool call that rolled out of the transcript window.
      blocks.push({ kind: 'tool', toolCallId: id, title: id, status: String(update.status ?? 'completed'), lines: updateContentToLines(update.content) })
      return
    }
    case 'plan': {
      const entries = Array.isArray(update.entries)
        ? (update.entries as Array<Record<string, unknown>>).map(e => ({
          content: String(e.content ?? ''),
          status: String(e.status ?? 'pending'),
          ...(typeof e.priority === 'string' ? { priority: e.priority } : {}),
        }))
        : []
      const existing = [...blocks].reverse().find(b => b.kind === 'plan')
      if (existing !== undefined && existing.kind === 'plan') {
        existing.entries = entries
      } else {
        blocks.push({ kind: 'plan', entries })
      }
      return
    }
    default:
      // available_commands / modes / config / usage / session_info ride on the
      // SessionView snapshot, not the block stream.
      return
  }
}

function trimBlocks(blocks: Block[]): void {
  if (blocks.length > MAX_BLOCKS) blocks.splice(0, blocks.length - MAX_BLOCKS)
}
