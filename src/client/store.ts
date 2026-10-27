/**
 * Browser-side state store for the ACP panel. Owns: the `/acp` RPC calls, the
 * `/api/acp/stream` EventSource, per-session block folding (raw ACP
 * `session/update` → render blocks), and the pending permission set.
 *
 * Deliberately framework-free: React binds through `useSyncExternalStore`.
 */

import type { AcpApprovalDeadlines, AcpConversationChoice, AcpEvent, AcpPresetStatus, AcpTagHalo, AgentCatalogResult, AgentProbeModelsResult, AgentSavePayload, AgentTestResult, AgentView, ChatSessionView, ChatTranscriptView, ApprovalDeadlineKey, ApprovalDeadlinesSetPayload, ApprovalDeadlinesResult, DetectedAgentInfo, SessionView } from '../protocol.ts'
import { DEFAULT_TAG_HALO } from '../protocol.ts'

/** One slash command the ACP agent declared, whole row (the menu draws name, description and `input.hint`). */
export type AgentCommand = NonNullable<ChatSessionView['availableCommands']>[number]

/** The unary RPC face (narrowed `ctx.connection.rpc.call`). */
export type RpcCall = (channel: string, endpoint: string, payload: unknown) => Promise<
  | { ok: true; value: unknown }
  | { ok: false; error: { code: string; message: string } }
>

export type Block =
  | { kind: 'user'; text: string }
  | { kind: 'agent'; messageId?: string; text: string }
  | { kind: 'thought'; text: string }
  | {
    kind: 'tool'
    toolCallId: string
    title: string
    status: string
    toolKind?: string
    lines: string[]
    /**
     * Structured ACP diffs (`content: [{type:'diff'}]`). Kept apart from
     * {@link lines} because a diff is the one tool payload worth rendering as
     * a diff: flattening it to `diff <path>` throws away everything that makes
     * an edit reviewable.
     */
    diffs?: Array<{ path: string; oldText: string | null; newText: string }>
    /** Text items the card cannot render (diff output, an unknown content kind's JSON). */
    extras?: string[]
    /**
     * The call's arguments, as the agent sent them (`rawInput` / `arguments`).
     * Rendered read-only under the header: the real model's view of "it ran
     * `ls -la`" is that line, and the old fold dropped it entirely.
     */
    input?: string
    /** The call's other named fields (`kind`, `status`, `locations`, `terminalId`, `meta`), one `key: value` per line. */
    details?: string[]
    /** The whole notification this block was last written from, pretty-printed. */
    raw?: string
  }
  | { kind: 'plan'; entries: Array<{ content: string; status: string; priority?: string }> }
  /**
   * Any other ACP notification, kept whole: an available-commands list, a mode
   * change, or a kind newer than this build. `text` is the readable fold and
   * `raw` the untouched payload — an agent's word the ACP view cannot format is
   * still an agent's word.
   */
  | { kind: 'event'; event: string; text: string; raw?: string; status?: string }
  | { kind: 'notice'; tone: 'info' | 'error'; text: string }

export interface PendingPermission {
  requestId: string
  sessionId: string
  title: string
  options: Array<{ optionId: string; name: string; kind: string }>
}

/**
 * One observed ACP transcript, keyed by ACP session id. This is the ACP view
 * tab's data source: the native chat plane can only render text/reasoning
 * (that is the LLM adapter's entire chunk vocabulary), so the real tool calls,
 * plans and diffs live here and nowhere else.
 */
export interface ChatTranscript {
  /** The DSH chat session this ACP session belongs to (its refetch address). */
  owner: string
  session: SessionView
  blocks: Block[]
  /** Highest folded transcript seq (gap detection for the live stream). */
  seq: number
}

export interface UiState {
  open: boolean
  /**
   * Bumped by {@link AcpStore.refreshLocale}. Labels resolve while rendering,
   * but memoized transcript rows compare props — this counter is what tells
   * them the language switched.
   */
  localeRev: number
  stream: 'init' | 'live' | 'down'
  agents: AgentView[]
  /**
   * Whether the host has answered `agents/list` at least once in this page.
   * `agents: []` alone cannot tell "no agent configured" from "not read yet";
   * a surface that offers a setup entry on an empty roster must wait for this.
   */
  agentsLoaded: boolean
  sessions: SessionView[]
  activeSessionId?: string
  blocks: Block[]
  permissions: PendingPermission[]
  busy: boolean
  notice?: string
  /**
   * The plugin's OWN default ACP agent (the panel's ★ gesture) — which agent a
   * new ACP-mode conversation starts on. NOT the deployment default model: that
   * one is global to every mode, and nothing in this bundle writes it.
   */
  defaultAgent?: string
  detectedAgents: DetectedAgentInfo[]
  detecting: boolean
  /**
   * Outcome of the last explicit re-detect (`重新检测与刷新`). Detection
   * usually finds exactly what the panel already renders — without this line
   * the button reads as dead. Set only by an explicit click, not the ambient
   * resync, and cleared again when that click's detection fails (a stale success
   * line next to the failure notice reads as if nothing happened).
   */
  detectSummary?: string
  /** Probed model catalogs per agent id (from `agent/probe-models`). */
  modelCatalogs: Record<string, AgentProbeModelsResult>
  /**
   * Per-agent ACP model surfaces (from `agent/catalog`) — the data source for
   * the conversation-side chips and the ACP-mode model seat. Kept apart from
   * {@link modelCatalogs} on purpose: that one is the panel's full probe
   * result (every choice an agent published), while this is the filtered,
   * ready-to-render list the seats offer.
   */
  seatCatalogs: Record<string, AgentCatalogResult>
  probingModels: Record<string, boolean>
  /**
   * Last probe failure per agent id, rendered next to the button that
   * triggered it. `notice` alone is not enough: it lives at the top of the
   * settings panel, so a probe failing below the fold (missing cwd, an agent
   * that never answers, …) reads as a dead button.
   */
  probeErrors: Record<string, string>
  /**
   * Host reports that it HAS the native approval chain (permission asks are
   * answered in the chat composer). This is a capability report, not a
   * per-ask promise: an individual ask still falls back to the settings-panel
   * ledger when the service is unavailable this time, or when the session has
   * no chat identity behind it (`AgentBridge.askNativeApproval`). The panel
   * therefore answers ANY pending ask, whatever this flag says — see
   * `permissionLedgerCard` in panel.tsx. False on an older host or when the
   * approval service is missing, in which case the ledger is the only path.
   */
  approvalRouted: boolean
  /**
   * ACP agent sessions backing the chat session the composer control sits in.
   * Only meaningful together with {@link chatSessionsFor}: the control reads it
   * by chat session id, so a stale list from another conversation never renders.
   */
  chatSessions: ChatSessionView[]
  /** The DSH chat session id {@link chatSessions} was loaded for. */
  chatSessionsFor?: string
  /**
   * The agent tag's halo preference (settings-editable display choice). The
   * tag reads it per render; the host answer in `resync` is the authority and
   * a write lands optimistically first.
   */
  tagHalo: AcpTagHalo
  /**
   * The approval deadlines in force, as the settings card edits them. Absent on
   * a host half from before the card existed, which hides the card rather than
   * showing a number this browser invented. Writes land optimistically and the
   * host answer (returned by the same route) is the authority.
   */
  approvalDeadlines?: AcpApprovalDeadlines
  /**
   * Per-chat-session "does this conversation run the ACP preset" verdicts, as
   * reported by `session/chat-list` (host-read from the session log). The
   * composer surfaces fall back to this when the client runtime's session rows
   * carry no `agentPreset` (older hosts); a session never asked about is simply
   * absent.
   */
  acpMode: Record<string, boolean>
  /**
   * Per-chat-session ACP agent binding, as reported by `session/chat-list`'s
   * `boundAgentId` (the host's intent map plus its live-session fallback): who
   * serves this conversation's NEXT message. `session/chat-bind` writes the
   * optimistic entry here the moment the click succeeds — the live session
   * list cannot reflect a switch until a turn materializes a session for the
   * new agent, and the chip would otherwise keep naming the previous agent.
   */
  chatBoundAgent: Record<string, string>
  /**
   * Per-chat-session agent lock, as reported by `chat/agent-locked` (the live
   * path) or `session/chat-list`'s `lockedAgentId` (the fallback): the first
   * ACP turn has STARTED, so this conversation belongs to that agent and
   * cannot be switched. The lock is provisional until that turn shows
   * something; `chat/agent-unlocked` removes it when it delivers nothing. The
   * composer hides its agent base and shows a read-only tag for this agent.
   * The id is kept even when the agent has been deleted from the roster — the
   * conversation is still locked to it.
   */
  chatLockedAgent: Record<string, string>
  /**
   * Per-chat-session serial for a lock THIS page saw arrive — bumped by the
   * `chat/agent-locked` frame (the live path, sent when the first turn starts)
   * or by a later `session/chat-list` answer that first reports `lockedAgentId`
   * (the fallback when the frame was missed). A rolled-back first turn followed
   * by a retry therefore gets a fresh serial, and its ceremony plays again.
   *
   * This is the animation's trigger, and the reason it cannot replay on a page
   * load: a conversation that is already locked when its list is first read
   * has no entry here. The composer's base and its edge tag
   * (`agent-lock-anim.ts`) play the shatter/condense hand-off only for a serial
   * they have not consumed.
   */
  agentLockReveal: Record<string, number>
  /**
   * The conversation's persisted pick — model and thought level — as reported by
   * `session/chat-list`'s `choice`, and written optimistically the moment a
   * picker commits one.
   *
   * This is the record that makes a conversation usable BEFORE it has ever run
   * a turn: without it the model / thought-level chips can only reflect a live
   * ACP session, which does not exist until the first message has already gone
   * out on whatever the agent's defaults were.
   */
  chatChoice: Record<string, AcpConversationChoice>
  /**
   * The model-seat shadow gate's own account of what it last decided, and why
   * (`src/client/index.tsx`'s `syncAcpMode`). Read-only, human-facing, and
   * rendered by the ACP view: every branch of that gate ends with the native
   * model seat either shadowed or not, and without this line the four ways it
   * can end "not shadowed" are indistinguishable from the outside — which is
   * exactly how "the ACP base still has not been replaced" became unreadable.
   */
  seatDiag: string
  /**
   * Diagnostic summary from the permission-seat blanking gate (`conversation.input.permission`).
   */
  permissionSeatDiag: string
  /**
   * Why slash isolation is not in force, when it is not (`idle` while it is).
   * Isolation degrades OPEN — an unrecognized source shape leaves the host's
   * commands in charge — so without this line the only symptom would be a menu
   * that quietly lists the wrong commands.
   */
  slashDiag: string
  /**
   * Observed ACP transcripts keyed by ACP session id. Only sessions the
   * conversation's ACP view asked for are watched (live `session/update`
   * frames fold straight into them), and the map is capped so a long browsing
   * session cannot accumulate every transcript it ever looked at.
   */
  chatTranscripts: Record<string, ChatTranscript>
  /**
   * State of the host's ACP-mode agent preset IN THE HARNESS ROSTER (the entry
   * the new-session picker shows). `undefined` when the host serves no roster
   * (`preset/status` answering `null`), in which case the panel hides the block.
   */
  preset?: AcpPresetStatus
}

interface Listener { (): void }

const MAX_BLOCKS = 400
/** How many observed ACP transcripts stay live at once (insertion-ordered eviction). */
const MAX_WATCHED = 6

/** Raw JSON budget for one event block; the cut is marked. */
const RAW_MAX = 256_000

/** Pretty-printed JSON of an agent message (never throws, cuts only at {@link RAW_MAX} with a marker). */
export function jsonText(value: unknown): string {
  let text: string
  try {
    text = JSON.stringify(value, null, 2) ?? String(value)
  } catch {
    text = String(value)
  }
  return text.length > RAW_MAX
    ? `${text.slice(0, RAW_MAX)}\n… [truncated ${String(text.length - RAW_MAX)} chars]`
    : text
}

/**
 * The call's arguments as the agent sent them. Accepts every spelling seen in
 * the wild (`rawInput` / `arguments`, string / object / array) and never
 * invents one: a call with no input gets `undefined`.
 */
export function toolInputOf(update: Record<string, unknown>): string | undefined {
  for (const key of ['rawInput', 'arguments'] as const) {
    const value = update[key]
    if (typeof value === 'string') {
      if (value !== '') return value
      continue
    }
    if (Array.isArray(value)) {
      if (value.length > 0) return JSON.stringify(value, null, 2)
      continue
    }
    if (typeof value === 'object' && value !== null) return JSON.stringify(value, null, 2)
  }
  return undefined
}

/** The call's other named fields, one `key: value` per line. */
export function toolDetailsOf(update: Record<string, unknown>): string[] {
  const lines: string[] = []
  for (const key of ['kind', 'status', 'locations', 'terminalId', 'meta'] as const) {
    const value = update[key]
    if (value === undefined || value === null || value === '') continue
    if (key === 'locations' && Array.isArray(value) && value.length === 0) continue
    lines.push(`${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`)
  }
  return lines
}

/** Text a `text` / `thinking` chunk's `content` carries (string, object, or array of blocks). */
function chunkText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content.map(item => {
      if (typeof item === 'string') return item
      if (typeof item === 'object' && item !== null) {
        const row = item as Record<string, unknown>
        return typeof row.text === 'string' ? row.text : JSON.stringify(item)
      }
      return ''
    }).join('')
  }
  if (typeof content === 'object' && content !== null) {
    const row = content as Record<string, unknown>
    if (typeof row.text === 'string') return row.text
    return JSON.stringify(content)
  }
  return ''
}

/**
 * One tool call's `content`, split into what the card renders as text
 * ({@link lines}), the structured edits it renders as diffs, and everything
 * else as its own readable text ({@link extras}). Nothing is dropped: a diff is
 * ALSO shown as text (header plus `-`/`+` lines) because the model's view of a
 * tool result is text, and a kind this build cannot render becomes its full
 * JSON.
 */
function splitToolContent(content: unknown): { lines: string[]; diffs?: Array<{ path: string; oldText: string | null; newText: string }>; extras: string[] } {
  const lines: string[] = []
  const extras: string[] = []
  const diffs: Array<{ path: string; oldText: string | null; newText: string }> = []
  if (!Array.isArray(content)) {
    if (typeof content === 'string' && content !== '') lines.push(content)
    return { lines, extras }
  }
  for (const item of content) {
    if (typeof item === 'string') {
      if (item !== '') lines.push(item)
      continue
    }
    if (typeof item !== 'object' || item === null) continue
    const row = item as Record<string, unknown>
    if (row.type === 'content') {
      const inner = row.content as Record<string, unknown> | undefined
      if (typeof inner === 'string') {
        lines.push(inner)
      } else if (inner?.type === 'text') {
        lines.push(typeof inner.text === 'string' ? inner.text : JSON.stringify(item))
      } else if (inner?.type === 'diff' && typeof inner.path === 'string') {
        const diff = { path: inner.path, oldText: typeof inner.oldText === 'string' ? inner.oldText : null, newText: typeof inner.newText === 'string' ? inner.newText : '' }
        diffs.push(diff)
        lines.push(diffText(diff))
      } else {
        extras.push(`${String(inner?.type ?? 'content')} ${JSON.stringify(item)}`)
      }
      continue
    }
    if (row.type === 'diff' && typeof row.path === 'string' && typeof row.newText === 'string') {
      const diff = { path: row.path, oldText: typeof row.oldText === 'string' ? row.oldText : null, newText: row.newText }
      diffs.push(diff)
      lines.push(diffText(diff))
      continue
    }
    if (row.type === 'text' && typeof row.text === 'string') {
      lines.push(row.text)
      continue
    }
    extras.push(`${String(row.type ?? 'content')} ${JSON.stringify(item)}`)
  }
  return { lines, extras, ...(diffs.length === 0 ? {} : { diffs }) }
}

/** A structured edit as plain text: its path, then `-`/`+` lines with three lines of context. */
function diffText(diff: { path: string; oldText: string | null; newText: string }): string {
  const split = (text: string | null): string[] => text === null || text === '' ? [] : (text.endsWith('\n') ? text.slice(0, -1) : text).split('\n')
  const oldLines = split(diff.oldText)
  const newLines = split(diff.newText)
  let head = 0
  while (head < oldLines.length && head < newLines.length && oldLines[head] === newLines[head]) head++
  let tail = 0
  while (
    tail < oldLines.length - head
    && tail < newLines.length - head
    && oldLines[oldLines.length - 1 - tail] === newLines[newLines.length - 1 - tail]
  ) tail++
  const out: string[] = [diff.path]
  for (let i = Math.max(0, head - 3); i < head; i++) out.push(`  ${oldLines[i] ?? ''}`)
  for (let i = head; i < oldLines.length - tail; i++) out.push(`- ${oldLines[i] ?? ''}`)
  for (let i = head; i < newLines.length - tail; i++) out.push(`+ ${newLines[i] ?? ''}`)
  for (let i = oldLines.length - tail; i < oldLines.length; i++) out.push(`  ${oldLines[i] ?? ''}`)
  return out.join('\n')
}

/** The readable fold of a notification the view has no card of its own for. */
export function describeEvent(kind: string, update: Record<string, unknown>): string {
  if (kind === 'available_commands_update') {
    const commands = Array.isArray(update.availableCommands) ? update.availableCommands : []
    return commands.map(command => {
      const row = (typeof command === 'object' && command !== null ? command : {}) as Record<string, unknown>
      const name = typeof row.name === 'string' ? row.name : ''
      const description = typeof row.description === 'string' && row.description !== '' ? ` — ${row.description}` : ''
      return `${name}${description}`
    }).join('\n')
  }
  if (kind === 'plan') {
    const entries = Array.isArray(update.entries) ? update.entries : []
    return entries.map(entry => {
      const row = (typeof entry === 'object' && entry !== null ? entry : {}) as Record<string, unknown>
      return `[${String(row.status ?? 'pending')}] ${String(row.content ?? '')}`
    }).join('\n')
  }
  if (kind === 'current_mode_update' && typeof update.currentModeId === 'string') return update.currentModeId
  return ''
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
  {
    id: 'omp',
    name: 'Oh My Pi',
    description: 'Oh My Pi (pi-based coding agent) — run as `omp acp` over stdio',
    detected: false,
    defaultCommand: 'omp',
    defaultArgs: ['acp'],
  },
  // Hand copy of the host's `AGENT_PRESETS` entry (src/bridge.ts): the panel
  // falls back to this list before the first `agents/detect` round-trip.
  {
    id: 'codebuddy',
    name: 'CodeBuddy Code',
    description: 'Tencent CodeBuddy Code — run as `codebuddy --acp` over stdio',
    detected: false,
    defaultCommand: 'codebuddy',
    defaultArgs: ['--acp'],
  },
  {
    id: 'claude',
    name: 'Claude Code',
    description: 'Claude Agent SDK adapter — run as `npx -y @agentclientprotocol/claude-agent-acp` over stdio',
    detected: false,
    defaultCommand: 'npx',
    defaultArgs: ['-y', '@agentclientprotocol/claude-agent-acp'],
  },
  {
    id: 'codex',
    name: 'Codex',
    description: 'OpenAI Codex adapter — run as `npx -y @agentclientprotocol/codex-acp` over stdio',
    detected: false,
    defaultCommand: 'npx',
    defaultArgs: ['-y', '@agentclientprotocol/codex-acp'],
  },
  {
    id: 'gemini',
    name: 'Gemini CLI',
    description: 'Google Gemini CLI — run as `gemini --experimental-acp` over stdio',
    detected: false,
    defaultCommand: 'gemini',
    defaultArgs: ['--experimental-acp'],
  },
  {
    id: 'opencode',
    name: 'OpenCode',
    description: 'OpenCode — run as `opencode acp` over stdio',
    detected: false,
    defaultCommand: 'opencode',
    defaultArgs: ['acp'],
  },
  {
    id: 'qwen',
    name: 'Qwen Code',
    description: 'Qwen Code — run as `qwen --experimental-acp` over stdio',
    detected: false,
    defaultCommand: 'qwen',
    defaultArgs: ['--experimental-acp'],
  },
  {
    id: 'kiro',
    name: 'Kiro',
    description: 'Kiro CLI — run as `kiro-cli acp` over stdio',
    detected: false,
    defaultCommand: 'kiro-cli',
    defaultArgs: ['acp'],
  },
  {
    id: 'qoder',
    name: 'Qoder',
    description: 'Qoder CLI — run as `qodercli --acp` over stdio',
    detected: false,
    defaultCommand: 'qodercli',
    defaultArgs: ['--acp'],
  },
  {
    id: 'qoder-cn',
    name: 'Qoder CN',
    description: 'Qoder CLI (China) — run as `qoderclicn --acp` over stdio',
    detected: false,
    defaultCommand: 'qoderclicn',
    defaultArgs: ['--acp'],
  },
]

export class AcpStore {
  private state: UiState = {
    open: false,
    localeRev: 0,
    stream: 'init',
    agents: [],
    agentsLoaded: false,
    sessions: [],
    blocks: [],
    permissions: [],
    busy: false,
    detectedAgents: [...DEFAULT_KNOWN_PRESETS],
    detecting: false,
    modelCatalogs: {},
    seatCatalogs: {},
    probingModels: {},
    probeErrors: {},
    approvalRouted: false,
    chatSessions: [],
    tagHalo: { ...DEFAULT_TAG_HALO },
    approvalDeadlines: undefined,
    chatTranscripts: {},
    acpMode: {},
    chatBoundAgent: {},
    chatLockedAgent: {},
    agentLockReveal: {},
    chatChoice: {},
    seatDiag: 'idle',
    permissionSeatDiag: 'idle',
    slashDiag: 'idle',
  }

  private readonly listeners = new Set<Listener>()
  private source?: EventSource
  private readonly lastSeq = new Map<string, number>()
  /** Sessions with a finalized turn (dedups the cancel-fallback + late real turn/end pair). */
  private readonly openTurns = new Set<string>()
  /** In-flight `session/chat-list` reads, keyed by chat session id. */
  private readonly chatSessionReads = new Map<string, { dropped: boolean; done: Promise<void> }>()
  /**
   * Chat sessions whose list has answered at least once in this page. The
   * FIRST answer only seeds the lock; a lock appearing on a later answer is a
   * transition this page actually witnessed, and only that one is announced via
   * {@link UiState.agentLockReveal}.
   */
  private readonly chatListLoaded = new Set<string>()
  /**
   * Conversations whose provisional first-turn lock the host rolled back
   * (`chat/agent-unlocked`, no visible output in the first turn). A
   * `session/chat-list` read that started BEFORE the rollback can still name
   * `lockedAgentId`; it must not revive the lock. A new `chat/agent-locked`
   * frame clears the entry (the user retried and the turn really started).
   */
  private readonly chatUnlocked = new Set<string>()
  /**
   * Sessions whose ACP-mode verdict a committed `agent-preset/selected` frame
   * settled. A frame settles the verdict; the host's log read can lag a switch
   * by one (the appended row is not yet visible to a fresh read, and the seat
   * taking the model cell re-mounts readers), so a read may only settle a
   * session no frame has spoken for — otherwise a stale answer would regress a
   * verdict the runtime already told us the truth about.
   *
   * The ONE exception is the gate's own re-ask ({@link loadChatSessions} with
   * `settleVerdict`): a verdict the gate has held as its only fact source for
   * longer than its TTL is exactly the case where the frame path has gone
   * quiet, and without an authorized re-read a switch the runtime never framed
   * could never be corrected.
   */
  private readonly acpModeLive = new Set<string>()
  /**
   * Chat sessions whose host read came back WITHOUT a verdict (no `acpMode`
   * field, or the read failed). The seat gate consults this to retract its
   * one-shot ask ledger entry, so a read that could not answer costs one retry
   * instead of leaving the native model seat visible for the rest of the page.
   */
  private readonly acpModeUnsettled = new Set<string>()
  /** In-flight `agent/catalog` reads, keyed by agent id. */
  private readonly seatCatalogReads = new Set<string>()
  /** In-flight `agent/cached-models` reads, keyed by agent id. */
  private readonly cachedModelReads = new Set<string>()
  /** Counts behind the last successful explicit re-detect, so a locale switch can re-render its summary. */
  private detectCounts: { total: number; installed: number } | undefined

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

  // ---- Streaming update coalescing ----

  /**
   * Live `session/update` frames waiting to be folded. Agents stream at token
   * granularity — hundreds of frames a second with usage ticks interleaved —
   * and folding plus notifying listeners per frame re-rendered every store
   * consumer per chunk. Frames are coalesced into ONE fold + ONE mutate per
   * animation frame instead; the order inside a batch is preserved, and the
   * transcript watermark (`lastSeq`) advances per batch.
   */
  private readonly pendingUpdates: Array<{ sessionId: string; seq: number; update: unknown }> = []
  private updateFlushArmed = false

  /** Fold everything pending now (idempotent; the scheduler clears its flag). */
  flushUpdates(): void {
    const batch = this.pendingUpdates.splice(0, this.pendingUpdates.length)
    this.updateFlushArmed = false
    if (batch.length === 0) return
    const bySession = new Map<string, Array<{ seq: number; update: unknown }>>()
    for (const item of batch) {
      const list = bySession.get(item.sessionId)
      if (list === undefined) bySession.set(item.sessionId, [item])
      else list.push(item)
    }
    let chatTranscripts = this.state.chatTranscripts
    let blocksChanged = false
    for (const [sessionId, items] of bySession) {
      const last = items[items.length - 1]
      // The observed transcript folds every frame (a watched session's cards
      // and prose); blocks are copied only when something actually changed, so
      // a usage-only tick costs one record object, not a re-render payload.
      const record = chatTranscripts[sessionId]
      if (record !== undefined) {
        let changed = false
        for (const item of items) {
          if (foldUpdate(record.blocks, item.update as Record<string, unknown>)) changed = true
        }
        chatTranscripts = {
          ...chatTranscripts,
          [sessionId]: { ...record, seq: last.seq, ...(changed ? { blocks: [...record.blocks] } : {}) },
        }
      }
      if (sessionId !== this.state.activeSessionId) {
        this.lastSeq.set(sessionId, last.seq)
        continue
      }
      const seen = this.lastSeq.get(sessionId)
      const contiguous = seen === undefined
        || (items[0].seq === seen + 1 && items.every((item, index) => index === 0 || item.seq === items[index - 1].seq + 1))
      this.lastSeq.set(sessionId, last.seq)
      if (!contiguous) {
        void this.loadTranscript(sessionId) // gap detected → replay
        continue
      }
      for (const item of items) {
        if (foldUpdate(this.state.blocks, item.update as Record<string, unknown>)) blocksChanged = true
      }
    }
    const patch: Partial<UiState> = {}
    if (chatTranscripts !== this.state.chatTranscripts) patch.chatTranscripts = chatTranscripts
    if (blocksChanged) patch.blocks = [...this.state.blocks]
    if (Object.keys(patch).length > 0) this.mutate(patch)
  }

  private armUpdateFlush(): void {
    if (this.updateFlushArmed) return
    this.updateFlushArmed = true
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => { this.updateFlushArmed = false; this.flushUpdates() })
      return
    }
    // No frame scheduler (a plain Node runtime): fold at once, keeping the
    // same one-mutate-per-batch contract for non-browser consumers.
    this.flushUpdates()
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
      const [{ agents, approvalRouted }, { sessions }, defaultAgentInfo, detectResult, presetResult, tagHaloResult, deadlinesResult] = await Promise.all([
        this.call<{ agents: AgentView[]; approvalRouted?: boolean }>('agents/list'),
        this.call<{ sessions: SessionView[] }>('sessions/list'),
        // The plugin's OWN default ACP agent — a plugin-private id, not a DSH
        // model route (see `defaultAgent` on the host half).
        this.call<{ agentId?: string }>('default/agent').catch(() => ({} as { agentId?: string })),
        this.call<{ agents: DetectedAgentInfo[] }>('agents/detect').catch(() => null),
        // `null` (host without a preset roster) hides the panel block.
        this.call<{ preset: AcpPresetStatus | null }>('preset/status').catch(() => null),
        // Host without the endpoint (older half) keeps the local default.
        this.call<{ halo: AcpTagHalo }>('ui/tag-halo').catch(() => ({ halo: { ...DEFAULT_TAG_HALO } })),
        // `undefined` (older half) hides the deadline card instead of showing a
        // number this browser made up.
        this.call<ApprovalDeadlinesResult>('ui/approval-deadlines').catch(() => ({ deadlines: undefined })),
      ])
      const detectedAgents = (detectResult && detectResult.agents.length > 0)
        ? detectResult.agents
        : (this.state.detectedAgents.length > 0 ? this.state.detectedAgents : [...DEFAULT_KNOWN_PRESETS])
      // Absent on an older host: keep the settings-panel card (degraded path).
      this.mutate({
        agents,
        agentsLoaded: true,
        sessions,
        defaultAgent: defaultAgentInfo?.agentId,
        detectedAgents,
        approvalRouted: approvalRouted === true,
        preset: presetResult?.preset ?? undefined,
        tagHalo: tagHaloResult?.halo ?? { ...DEFAULT_TAG_HALO },
        approvalDeadlines: deadlinesResult.deadlines,
      })
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
      const agents = result.agents.length > 0 ? result.agents : [...DEFAULT_KNOWN_PRESETS]
      const installed = agents.filter(agent => agent.detected).length
      this.detectCounts = { total: agents.length, installed }
      this.mutate({
        detectedAgents: agents,
        detecting: false,
        detectSummary: this.detectSummaryOf(agents.length, installed),
      })
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      const notice = msg.includes('unknown endpoint agents/detect')
        ? this.locale('宿主服务运行着旧版本代码，请在终端重启 dsh web 服务以激活主机检测功能。', 'Host running older version. Please restart dsh web to enable agent detection.')
        : msg
      this.detectCounts = undefined
      this.mutate({
        detecting: false,
        notice,
        detectedAgents: this.state.detectedAgents.length > 0 ? this.state.detectedAgents : [...DEFAULT_KNOWN_PRESETS],
        // A failed re-detect must not keep showing the previous run's success line.
        detectSummary: undefined,
      })
    }
  }

  private detectSummaryOf(total: number, installed: number): string {
    return this.locale(
      `已检测 ${String(total)} 个预设：${String(installed)} 个已安装，其余可从「添加智能体」启用。`,
      `Detected ${String(total)} presets: ${String(installed)} installed, enable the rest via "Add agent".`,
    )
  }

  async saveAgent(payload: AgentSavePayload): Promise<void> {
    try {
      await this.call('agent/save', payload)
      await this.resync()
      // The host probes the catalog right after a save; pull the fresh result
      // so the agent card fills in without a second click.
      void this.probeModels(payload.id)
    } catch (error) {
      this.flashError(error)
      throw error
    }
  }

  /**
   * Dry-run the connection form: the host spawns a throwaway process from
   * these exact values, handshakes, and tears it down. A reachable-but-broken
   * agent arrives as `{ ok: false }`, not a thrown error; only transport or
   * validation failures reject.
   */
  async testAgent(payload: AgentSavePayload): Promise<AgentTestResult> {
    try {
      return await this.call<AgentTestResult>('agent/test', payload)
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      const notice = msg.includes('unknown endpoint agent/test')
        ? this.locale('宿主服务运行着旧版本代码，请在终端重启 dsh web 服务以启用连接测试功能。', 'Host running older version. Please restart dsh web to enable connection testing.')
        : msg
      this.mutate({ notice })
      throw error
    }
  }

  /**
   * Seed one agent's model panes from the host's PERSISTENT catalog cache
   * (`agent/cached-models`, memory-only: it never spawns).
   *
   * The settings card used to learn a catalog only from `agent/probe-models`,
   * so its panes stayed blank until the user clicked 「检测可用模型」 on every
   * visit — including the models already configured, which are known from the
   * agent definition and the on-disk catalog. This read fills both panes on
   * mount; the probe stays the explicit REFRESH (add what the agent newly
   * publishes, drop what it stopped advertising).
   */
  async loadCachedModels(agentId: string): Promise<void> {
    if (this.state.modelCatalogs[agentId] !== undefined || this.cachedModelReads.has(agentId)) return
    this.cachedModelReads.add(agentId)
    try {
      const result = await this.call<AgentProbeModelsResult | null>('agent/cached-models', { agentId })
      // `null` = this agent never published a catalog. A probe may have landed
      // while this read was in flight; a fresh probe always wins.
      if (result === null || result === undefined || this.state.modelCatalogs[agentId] !== undefined) return
      this.mutate({ modelCatalogs: { ...this.state.modelCatalogs, [agentId]: result } })
    } catch {
      // Older host without the endpoint, or an agent deleted meanwhile: the
      // panes fall back to the selection alone, exactly as before a probe.
    } finally {
      this.cachedModelReads.delete(agentId)
    }
  }

  /** Ask the host to probe one agent's model catalog (spawn + throwaway session). */
  async probeModels(agentId: string): Promise<void> {
    const previousError = this.state.probeErrors[agentId]
    this.mutate({
      probingModels: { ...this.state.probingModels, [agentId]: true },
      probeErrors: this.clearProbeError(agentId),
    })
    try {
      const result = await this.call<AgentProbeModelsResult>('agent/probe-models', { agentId })
      // The seat list is a filtered view of the same catalog: drop the cached
      // one (in the same patch) and re-read below, so a fresh probe lands in an
      // open conversation too.
      const seatCatalogs = { ...this.state.seatCatalogs }
      delete seatCatalogs[agentId]
      this.mutate({
        modelCatalogs: { ...this.state.modelCatalogs, [agentId]: result },
        seatCatalogs,
        probingModels: { ...this.state.probingModels, [agentId]: false },
        // A retry after the user fixed the problem must not leave the old
        // failure pinned at the top of the panel. Only drop the notice when it
        // is still ours — anything newer belongs to someone else.
        ...(previousError !== undefined && this.state.notice === previousError ? { notice: undefined } : {}),
      })
      void this.loadAgentCatalog(agentId)
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      const notice = msg.includes('unknown endpoint agent/probe-models')
        ? this.locale('宿主服务运行着旧版本代码，请在终端重启 dsh web 服务以激活模型检测功能。', 'Host running older version. Please restart dsh web to enable model detection.')
        : msg
      this.mutate({
        notice,
        probingModels: { ...this.state.probingModels, [agentId]: false },
        probeErrors: { ...this.state.probeErrors, [agentId]: notice },
      })
    }
  }

  private clearProbeError(agentId: string): Record<string, string> {
    if (this.state.probeErrors[agentId] === undefined) return this.state.probeErrors
    const next = { ...this.state.probeErrors }
    delete next[agentId]
    return next
  }

  /**
   * Read one agent's ACP model surface (`agent/catalog`) — what the composer
   * chips and the ACP-mode model seat render. Cached per agent, because the
   * list only changes when the agent's catalog is re-probed or its exposure
   * filter is edited (both of which drop the cache below), and deduped because
   * every ACP surface asks for it on mount.
   *
   * The host answers from memory, so this is safe to call from a render effect;
   * a probe it may trigger runs in the background on the host side.
   */
  async loadAgentCatalog(agentId: string): Promise<void> {
    if (this.state.seatCatalogs[agentId] !== undefined || this.seatCatalogReads.has(agentId)) return
    this.seatCatalogReads.add(agentId)
    try {
      const result = await this.call<AgentCatalogResult>('agent/catalog', { agentId })
      this.mutate({ seatCatalogs: { ...this.state.seatCatalogs, [agentId]: result } })
    } catch {
      // An older host half, or an agent that was deleted meanwhile: the seats
      // fall back to the roster's own title and the bare agent route, which is
      // exactly what they show before a catalog exists.
    } finally {
      this.seatCatalogReads.delete(agentId)
    }
  }

  /** Drop one agent's cached seat catalog (its model surface just changed). */
  private invalidateSeatCatalog(agentId: string): void {
    if (this.state.seatCatalogs[agentId] === undefined) return
    const next = { ...this.state.seatCatalogs }
    delete next[agentId]
    this.mutate({ seatCatalogs: next })
  }

  /**
   * Persist the ACP-seat model filter for one agent. `undefined` clears the
   * filter — same as an empty list, i.e. no `agentId@choice` variants, only
   * the agent's base entry. Uses the dedicated lightweight RPC so the agent
   * process and its live sessions are never restarted.
   */
  async setExposedModels(agentId: string, exposedModels: string[] | undefined): Promise<void> {
    try {
      await this.call('agent/set-exposed-models', {
        agentId,
        ...(exposedModels === undefined ? {} : { exposedModels }),
      })
      await this.resync()
      // The seats render the filtered list, so an edited filter has to be
      // re-read or the open conversation keeps offering the old set.
      this.invalidateSeatCatalog(agentId)
      void this.loadAgentCatalog(agentId)
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      const notice = msg.includes('unknown endpoint agent/set-exposed-models')
        ? this.locale('宿主服务运行着旧版本代码，请在终端重启 dsh web 服务以启用模型筛选功能。', 'Host running older version. Please restart dsh web to enable model filtering.')
        : msg
      this.mutate({ notice })
      throw error
    }
  }

  async deleteAgent(agentId: string): Promise<void> {
    try {
      await this.call('agent/delete', { agentId })
      await this.resync()
      // Nothing should keep offering a deleted agent's models (a conversation
      // that was routed to it falls back to its roster entry).
      this.invalidateSeatCatalog(agentId)
    } catch (error) {
      this.flashError(error)
      throw error
    }
  }

  /**
   * Persist the auto-discovery switch for one agent. Lightweight like
   * {@link setExposedModels}: no process restart, and the current selection is
   * left exactly as it is.
   */
  async setAutoDiscoverModels(agentId: string, autoDiscoverModels: boolean): Promise<void> {
    try {
      await this.call('agent/set-auto-discover-models', { agentId, autoDiscoverModels })
      await this.resync()
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      const notice = msg.includes('unknown endpoint agent/set-auto-discover-models')
        ? this.locale('宿主服务运行着旧版本代码，请在终端重启 dsh web 服务以启用自动发现功能。', 'Host running older version. Please restart dsh web to enable auto-discovery.')
        : msg
      this.mutate({ notice })
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
      // An answer BEHIND what this page already folded must not replace it.
      //
      // The host fills its transcript from the notification pipeline, which the
      // SDK paces independently of the `session/prompt` response, so a read
      // taken right after a turn can still be missing the agent's last chunk.
      // `lastSeq` already refuses to go backwards; the blocks must not either,
      // or switching away and back inside that window truncates a turn the user
      // just watched finish. A resumed session replays as fresh updates, but
      // only after `session/reset` zeroes the watermark — so this cannot swallow
      // a legitimate replay.
      const seen = this.lastSeq.get(sessionId) ?? 0
      if ((entries.at(-1)?.seq ?? 0) < seen) return
      const blocks: Block[] = []
      for (const entry of entries) {
        foldUpdate(blocks, entry.update)
        this.lastSeq.set(sessionId, Math.max(this.lastSeq.get(sessionId) ?? 0, entry.seq))
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

  /**
   * Load the ACP agent sessions backing one DSH chat session. The composer
   * control calls this per chat session (and again whenever a turn settles, so
   * the binding a fresh conversation just created shows up).
   */
  /**
   * Load the ACP agent sessions backing one DSH chat session. The composer
   * control calls this per chat session (and again whenever a turn settles, so
   * the binding a fresh conversation just created shows up).
   *
   * `settleVerdict` is the seat gate's own re-ask and the ONLY read allowed to
   * settle a verdict a frame had already settled (see {@link acpModeLive}): the
   * gate holds such a verdict as its only fact source while the session row
   * stays silent, and a host read is the one place a switch the runtime never
   * framed can still be learned from. Composer readers pass nothing and keep
   * the frame's authority.
   */
  loadChatSessions(dshSessionId: string, options?: { settleVerdict?: boolean }): Promise<void> {
    // Two composer entries read this (the agent-mode control and the ACP
    // cluster) and both re-read when a turn settles; one round-trip answers
    // for both instead of two racing ones. A caller arriving mid-read waits
    // for THAT read rather than returning immediately: the slash source's
    // one-shot "do I have a verdict yet?" ask is only useful if it can
    // receive the answer of a read already in flight.
    const inFlight = this.chatSessionReads.get(dshSessionId)
    if (inFlight !== undefined) return inFlight.done
    const read: { dropped: boolean; done: Promise<void> } = { dropped: false, done: Promise.resolve() }
    this.chatSessionReads.set(dshSessionId, read)
    read.done = this.readChatSessionList(dshSessionId, options, read)
    return read.done
  }

  private async readChatSessionList(
    dshSessionId: string,
    options: { settleVerdict?: boolean } | undefined,
    read: { dropped: boolean },
  ): Promise<void> {
    const settle = options?.settleVerdict === true || !this.acpModeLive.has(dshSessionId)
    try {
      const { sessions, acpMode, boundAgentId, lockedAgentId, choice } = await this.call<{ sessions: ChatSessionView[]; acpMode?: boolean; boundAgentId?: string; lockedAgentId?: string; choice?: AcpConversationChoice }>('session/chat-list', { dshSessionId, refresh: true })
      // A committed `agent-preset/selected` frame may have settled this
      // session's verdict while the read was in flight; the host answer then
      // describes the log as of BEFORE that switch and must not overwrite it.
      if (read.dropped) return
      // The first answer for a conversation only seeds what is already true: a
      // lock reported there belongs to an earlier page. A lock that appears on
      // a LATER answer is the first-turn transition unfolding in front of the
      // user, and only that one is announced to the hand-off animation.
      const firstAnswer = !this.chatListLoaded.has(dshSessionId)
      this.chatListLoaded.add(dshSessionId)
      // The lock is one-way, so a read that no longer reports one is an older
      // host half, not an unlock: keep what we already know in that case. The
      // one explicit unlock is the host's rollback frame, tracked separately.
      // A read that AGREES there is no lock clears the rollback marker, so a
      // later legitimate lock (even with its frame missed) is accepted again.
      if (lockedAgentId === undefined) this.chatUnlocked.delete(dshSessionId)
      const reportedLock = lockedAgentId !== undefined && this.chatUnlocked.has(dshSessionId)
        ? undefined
        : lockedAgentId
      const chatLockedAgent = reportedLock === undefined
        ? this.state.chatLockedAgent
        : { ...this.state.chatLockedAgent, [dshSessionId]: reportedLock }
      const witnessedLock = !firstAnswer
        && reportedLock !== undefined
        && this.state.chatLockedAgent[dshSessionId] === undefined
      const agentLockReveal = witnessedLock
        ? { ...this.state.agentLockReveal, [dshSessionId]: (this.state.agentLockReveal[dshSessionId] ?? 0) + 1 }
        : this.state.agentLockReveal
      this.mutate({
        chatSessions: sessions,
        chatSessionsFor: dshSessionId,
        chatLockedAgent,
        agentLockReveal,
        // The host's binding (intent + live-session fallback) outranks the
        // optimistic entry this store wrote on the click; a host without the
        // field (older half) simply leaves the optimistic value standing.
        ...(boundAgentId === undefined
          ? {}
          : { chatBoundAgent: { ...this.state.chatBoundAgent, [dshSessionId]: boundAgentId } }),
        // The persisted pick (model + thought level) — the host's record,
        // present before any ACP session exists. Merged over the optimistic
        // entry so a value a click just wrote is not erased by a read that
        // started before the click landed.
        ...(choice === undefined
          ? {}
          : { chatChoice: { ...this.state.chatChoice, [dshSessionId]: choice } }),
        // The seat gate's fallback fact source: absent on an older host half,
        // which then simply never takes the seat over (the allowed failure).
        // A frame-settled verdict outranks any read, whenever it lands: the
        // host's log read can lag a switch by one, and taking the model seat
        // re-mounts readers, so a stale answer would otherwise regress it.
        ...(acpMode === undefined || !settle
          ? {}
          : { acpMode: { ...this.state.acpMode, [dshSessionId]: acpMode === true } }),
      })
      // A read that answered but carried no verdict has NOT settled this
      // session. The gate's ask ledger is one-shot per id, so unless the id is
      // retracted here it stays marked "asked" forever and the gate never asks
      // again — one silent round-trip and the native model seat is permanent
      // for that session. The gate re-derives this from `hasAcpModeVerdict`
      // on its next evaluation (every store mutation re-runs it), which is
      // what makes the fallback recoverable instead of a single coin flip.
      if (acpMode === undefined && settle) {
        this.acpModeUnsettled.add(dshSessionId)
      }
    } catch {
      // A host without this surface (older build) has nothing to show; the
      // control simply renders nothing rather than an error nobody can act on.
      if (read.dropped) return
      this.mutate({ chatSessions: [], chatSessionsFor: dshSessionId })
      if (settle) {
        this.acpModeUnsettled.add(dshSessionId)
      }
    } finally {
      if (this.chatSessionReads.get(dshSessionId) === read) this.chatSessionReads.delete(dshSessionId)
    }
  }

  /**
   * Abandon the in-flight `session/chat-list` read for one session (or all of
   * them): a committed `agent-preset/selected` frame carries the authoritative
   * verdict, and the late answer to an ask that predates the frame describes
   * the log from before the switch — it must not land in the store.
   */
  abandonChatSessionRead(dshSessionId?: string): void {
    if (dshSessionId === undefined) {
      for (const read of this.chatSessionReads.values()) read.dropped = true
      this.chatSessionReads.clear()
      return
    }
    const read = this.chatSessionReads.get(dshSessionId)
    if (read === undefined) return
    read.dropped = true
    this.chatSessionReads.delete(dshSessionId)
  }

  /**
   * The slash commands the LIVE ACP session declared for one chat session, as
   * read by {@link loadChatSessions} (`available_commands_update` →
   * `session/chat-list`).
   *
   * `undefined` covers both "no answer has landed yet" and "there is no live
   * session (or it has not declared anything)" — in every one of those cases
   * the caller falls back to the agent-level cache ({@link agentCommands}),
   * which is what makes `/` list commands before the first message exists.
   */
  chatSessionCommands(dshSessionId: string): readonly AgentCommand[] | undefined {
    if (this.state.chatSessionsFor !== dshSessionId) return undefined
    return this.state.chatSessions[0]?.availableCommands
  }

  /**
   * The slash commands the agent declared in its most recent session, from
   * `agent/catalog` (host-cached per agent, see `AgentCatalogResult.commands`).
   * The pre-first-turn source for the `/` menu.
   */
  agentCommands(agentId: string | undefined): readonly AgentCommand[] | undefined {
    if (agentId === undefined) return undefined
    return this.state.seatCatalogs[agentId]?.commands
  }

  /**
   * Which agent serves one conversation as far as this page can tell, without
   * reading any catalog: live ACP session → agent lock → host/optimistic
   * binding → persisted pick → plugin default. Used to find the agent whose
   * cached commands the `/` menu should offer before a session exists.
   */
  chatAgentFor(dshSessionId: string): string | undefined {
    if (this.state.chatSessionsFor === dshSessionId) {
      const live = this.state.chatSessions[0]
      if (live !== undefined) return live.agentId
    }
    // The lock outlives the session: after the first turn it is the durable
    // answer even when the ACP session is gone.
    return this.state.chatLockedAgent[dshSessionId]
      ?? this.state.chatBoundAgent[dshSessionId]
      ?? this.state.chatChoice[dshSessionId]?.agentId
      ?? this.state.defaultAgent
  }

  /**
   * Record the verdict a committed `agent-preset/selected` frame carries, folded
   * from the frame's own preset field ({@link acpModeFromPresetEvent}). The
   * frame is authoritative: it marks the session live-settled, so no later host
   * read may regress it (see {@link acpModeLive}) — the gate's own TTL re-ask
   * being the one authorized exception. Same no-op-when-unchanged discipline as
   * the other accessors, so a frame restating the held verdict costs no
   * listener churn.
   */
  noteAcpMode(dshSessionId: string, acpMode: boolean): void {
    this.acpModeLive.add(dshSessionId)
    if (this.state.acpMode[dshSessionId] === acpMode) return
    this.mutate({ acpMode: { ...this.state.acpMode, [dshSessionId]: acpMode } })
  }

  /**
   * Record the model-seat gate's last decision (see the `seatDiag` field). The
   * gate owns the string; the store only carries it so the ACP view can render
   * *why* the native seat is or is not shadowed. No-op when unchanged, so the
   * gate can call this on every evaluation without churning listeners.
   */
  noteSeatDiag(text: string): void {
    if (this.state.seatDiag === text) return
    this.mutate({ seatDiag: text })
  }

  /**
   * Record the permission-seat gate's last decision (`conversation.input.permission`).
   */
  notePermissionSeatDiag(text: string): void {
    if (this.state.permissionSeatDiag === text) return
    this.mutate({ permissionSeatDiag: text })
  }

  /**
   * Record the slash-isolation seam's last verdict (`idle` = in force, or no
   * problem to report). No-op when unchanged, like the seat lines.
   */
  noteSlashDiag(text: string): void {
    if (this.state.slashDiag === text) return
    this.mutate({ slashDiag: text })
  }

  /**
   * Whether a chat session's host read produced a verdict the seat gate can
   * rely on. `false` means "asked but not answered" — the read returned no
   * `acpMode` field or failed outright — and is the signal for the gate to
   * retract its one-shot ask ledger entry for this id so it can ask again.
   *
   * A verdict handed down by a committed `agent-preset/selected` frame is
   * authoritative and outranks everything (see {@link acpModeLive}); such a
   * session always answers `true` here, settled or not.
   */
  hasAcpModeVerdict(dshSessionId: string): boolean {
    if (this.acpModeLive.has(dshSessionId)) return true
    if (this.acpModeUnsettled.has(dshSessionId)) {
      this.acpModeUnsettled.delete(dshSessionId)
      return false
    }
    return this.state.acpMode[dshSessionId] !== undefined
  }

  /**
   * Drop one chat session's ACP-mode verdict — or the whole map. The preset
   * switch a session committed is announced by the host (`agent-preset/selected`)
   * and folded by the runtime into its own rows, but NOT into this map, so the
   * gate re-asks instead of trusting a verdict the session log has moved past.
   */
  invalidateAcpMode(dshSessionId?: string): void {
    if (dshSessionId === undefined) {
      // Dropping the whole map also re-opens every session to host reads.
      this.acpModeLive.clear()
      if (Object.keys(this.state.acpMode).length === 0) return
      this.mutate({ acpMode: {} })
      return
    }
    this.acpModeLive.delete(dshSessionId)
    if (this.state.acpMode[dshSessionId] === undefined) return
    const acpMode = { ...this.state.acpMode }
    delete acpMode[dshSessionId]
    this.mutate({ acpMode })
  }

  /**
   * Switch the ACP agent's own mode for one chat session (`session/set_mode`),
   * then re-read the binding so the control reflects what the agent actually
   * reports (a rejected switch must not leave an optimistic lie on screen).
   */
  async setChatSessionMode(dshSessionId: string, modeId: string, agentId?: string): Promise<void> {
    try {
      await this.call('session/chat-mode-set', { dshSessionId, modeId, ...(agentId === undefined ? {} : { agentId }) })
    } catch (error) {
      this.flashError(error)
    }
    await this.loadChatSessions(dshSessionId)
  }

  // ---- ACP transcript observation (the conversation's ACP view) ----

  /**
   * Start (or refresh) observation of every ACP transcript behind one DSH chat
   * session. Blocks are rebuilt from scratch — the host buffer is the record,
   * and this view is the only consumer that needs the raw agent stream.
   */
  async loadChatTranscript(dshSessionId: string): Promise<void> {
    let views: ChatTranscriptView[]
    try {
      ({ views } = await this.call<{ views: ChatTranscriptView[] }>(
        'session/chat-transcript',
        { dshSessionId },
      ))
    } catch {
      // An older host half (or a session with no ACP binding): nothing to
      // observe, and no error worth flashing for a read-only side view.
      return
    }
    // Everything this chat session used to have, minus what it still has: a
    // closed or replaced ACP session must not linger as a ghost tab body.
    const merged: Record<string, ChatTranscript> = {}
    for (const [id, record] of Object.entries(this.state.chatTranscripts)) {
      if (record.owner !== dshSessionId) merged[id] = record
    }
    for (const view of views) {
      const blocks: Block[] = []
      for (const entry of view.entries) foldUpdate(blocks, entry.update as Record<string, unknown>)
      merged[view.session.sessionId] = {
        owner: dshSessionId,
        session: view.session,
        blocks,
        seq: view.entries.length > 0 ? view.entries[view.entries.length - 1]?.seq ?? 0 : 0,
      }
    }
    this.mutate({ chatTranscripts: this.evictTranscripts(merged) })
  }

  /** Observed transcript for one ACP session id (undefined → nobody is watching it). */
  transcriptOf(acpSessionId: string): ChatTranscript | undefined {
    return this.state.chatTranscripts[acpSessionId]
  }

  /** The observed transcript of one chat session (the live binding wins over a released one). */
  chatTranscriptOf(dshSessionId: string): ChatTranscript | undefined {
    const owned = Object.values(this.state.chatTranscripts).filter(record => record.owner === dshSessionId)
    return owned.find(record => !record.session.released) ?? owned[0]
  }

  /** Keep the resident transcript map at its bound, newest insertion first. */
  private evictTranscripts(map: Record<string, ChatTranscript>): Record<string, ChatTranscript> {
    const ids = Object.keys(map)
    if (ids.length <= MAX_WATCHED) return map
    const out: Record<string, ChatTranscript> = {}
    for (const id of ids.slice(ids.length - MAX_WATCHED)) {
      const value = map[id]
      if (value !== undefined) out[id] = value
    }
    return out
  }

  /** Re-publish an observed transcript's session snapshot (mode / released flips). */
  private watchedSessionPatch(sessionId: string, session: SessionView): { chatTranscripts?: Record<string, ChatTranscript> } {
    const current = this.state.chatTranscripts[sessionId]
    if (current === undefined) return {}
    return { chatTranscripts: { ...this.state.chatTranscripts, [sessionId]: { ...current, session } } }
  }

  /** Mirror the running flag onto a transcript the ACP view is showing. */
  private markWatchedRunning(sessionId: string, running: boolean): void {
    const current = this.state.chatTranscripts[sessionId]
    if (current === undefined || current.session.running === running) return
    this.mutate({
      chatTranscripts: {
        ...this.state.chatTranscripts,
        [sessionId]: { ...current, session: { ...current.session, running } },
      },
    })
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

  /**
   * Set the plugin's OWN default ACP agent (the panel's ★ gesture): which agent
   * an ACP-mode conversation starts on. Plugin-private state — the host keeps it
   * in its own agent registry file, and nothing here touches DSH's model
   * selection (see docs/acp-convergence.md §2.2).
   */
  async setDefaultAgent(agentId: string | undefined): Promise<void> {
    try {
      await this.call('default/agent-set', { ...(agentId === undefined ? {} : { agentId }) })
      this.mutate({ defaultAgent: agentId })
    } catch (error) {
      this.flashError(error)
    }
  }

  /**
   * Write the agent tag's halo preference (settings card). The value is
   * validated host-side; this side writes optimistically first so the tag's
   * look changes with the click, and reverts to the host answer on a failure.
   */
  async setTagHalo(halo: AcpTagHalo): Promise<void> {
    const previous = this.state.tagHalo
    this.mutate({ tagHalo: halo })
    try {
      await this.call('ui/tag-halo-set', { halo })
    } catch (error) {
      this.mutate({ tagHalo: previous })
      this.flashError(error)
    }
  }

  /**
   * Write one approval deadline (settings card), or drop the persisted override
   * with `reset` so the `cordis.patch.yml` baseline applies again.
   *
   * The host answer — the same route returns the deadlines now in force — is the
   * authority, so an optimistic write that the host trims (out of range, or
   * merged with a value this browser did not know about) self-corrects instead
   * of drifting from what runs.
   */
  async setApprovalDeadline(key: ApprovalDeadlineKey, ms: number): Promise<void> {
    await this.writeApprovalDeadlines({ [key]: ms })
  }

  /** Drop the persisted override: the config file (or the built-in default) decides again. */
  async resetApprovalDeadlines(): Promise<void> {
    await this.writeApprovalDeadlines({ reset: true })
  }

  private async writeApprovalDeadlines(payload: ApprovalDeadlinesSetPayload): Promise<void> {
    const previous = this.state.approvalDeadlines
    // Optimistic only where it is safe: the effective numbers move now, and the
    // override facts (`configured`) stay as the host last reported them. A
    // failure restores the whole view.
    if (previous !== undefined) {
      this.mutate({
        approvalDeadlines: {
          ...previous,
          ...(payload.nativeApprovalTimeoutMs === undefined ? {} : { nativeApprovalTimeoutMs: payload.nativeApprovalTimeoutMs }),
          ...(payload.permissionFallbackTimeoutMs === undefined ? {} : { permissionFallbackTimeoutMs: payload.permissionFallbackTimeoutMs }),
        },
      })
    }
    try {
      const result = await this.call<ApprovalDeadlinesResult>('ui/approval-deadlines-set', payload)
      this.mutate({ approvalDeadlines: result.deadlines })
    } catch (error) {
      this.mutate({ approvalDeadlines: previous })
      this.flashError(error)
    }
  }

  /**
   * Bind one DSH chat session to an ACP agent. This is the plugin's own
   * conversation↔agent mapping: it does NOT write a DSH model route, so it
   * cannot pollute the deployment default model and cannot be refused by the
   * GUI's catalog gate (the retired `session/model-unavailable` failure).
   *
   * The mapping is host-side and keyed by chat session id; the browser learns
   * the binding back through `session/chat-list`.
   */
  async bindChatAgent(dshSessionId: string, agentId: string): Promise<void> {
    try {
      await this.call('session/chat-bind', { dshSessionId, agentId })
      // Optimistic: the host recorded the intent, so the NEXT message runs the
      // picked agent — but the live-session list (`chatSessions`) cannot show
      // that until the turn materializes its session. Recording here is what
      // makes the chip and the picker's checkmark move on the click itself.
      this.mutate({ chatBoundAgent: { ...this.state.chatBoundAgent, [dshSessionId]: agentId } })
    } catch (error) {
      this.flashError(error)
      throw error
    }
  }

  /** Switch the bound agent's model (`agentId@choice`) for one chat session. */
  async setChatSessionModel(dshSessionId: string, modelId: string, agentId?: string): Promise<void> {
    try {
      await this.call('session/chat-model-set', { dshSessionId, modelId })
      // Optimistic for the same reason the binding is: the host recorded the
      // pick, and a conversation with no ACP session yet would otherwise show
      // the agent's default until its first turn created one.
      this.writeChoice(dshSessionId, choice => ({ ...choice, modelId }), agentId)
    } catch (error) {
      this.flashError(error)
      throw error
    }
  }

  /** Switch the bound agent's reasoning effort for one chat session. */
  async setChatSessionEffort(dshSessionId: string, effort: string | undefined, agentId?: string): Promise<void> {
    try {
      await this.call('session/chat-effort-set', {
        dshSessionId,
        ...(effort === undefined ? {} : { effort }),
        ...(agentId === undefined ? {} : { agentId }),
      })
      this.writeChoice(dshSessionId, choice => {
        const { effort: _dropped, ...rest } = choice
        return effort === undefined ? rest : { ...rest, effort }
      }, agentId)
    } catch (error) {
      this.flashError(error)
      throw error
    }
  }

  /** Set one of the bound agent's EXTRA config options for one chat session. */
  async setChatSessionConfig(dshSessionId: string, configId: string, value: string | boolean, agentId?: string): Promise<void> {
    try {
      await this.call('session/chat-config-set', {
        dshSessionId,
        configId,
        value,
        ...(agentId === undefined ? {} : { agentId }),
      })
      this.writeChoice(dshSessionId, choice => ({
        ...choice,
        extraConfigs: { ...choice.extraConfigs, [configId]: value },
      }), agentId)
    } catch (error) {
      this.flashError(error)
      throw error
    }
  }

  /**
   * Patch one conversation's optimistic pick. The agent half is required by the
   * record (a model or thought level belongs to an agent). Its owner is the
   * route the picker used, else the recorded pick, the optimistic binding, or
   * the plugin default — that last one really serves a never-bound conversation
   * (the guard routes to it), so waiting for `session/chat-list` would leave the
   * chip behind the click. Only a conversation with none of those is left alone.
   */
  private writeChoice(dshSessionId: string, update: (choice: AcpConversationChoice) => AcpConversationChoice, agentId?: string): void {
    const current = this.state.chatChoice[dshSessionId]
    // The plugin default is a real route (the host applies it to a conversation
    // nobody bound), so an optimistic pick in a fresh conversation belongs to
    // it — without this the host recorded the pick but the chip waited for the
    // next `session/chat-list`.
    const owner = agentId ?? current?.agentId ?? this.state.chatBoundAgent[dshSessionId] ?? this.state.defaultAgent
    if (owner === undefined) return
    const next = update({ ...current, agentId: owner })
    this.mutate({ chatChoice: { ...this.state.chatChoice, [dshSessionId]: { ...next, agentId: owner } } })
  }

  /**
   * Localize one string. BOUND to the instance in the constructor: the ACP
   * view hands this reference to memoized rows, so it must stay stable across
   * renders or every row re-renders on every store notification.
   */
  label: (zh: string, en: string) => string = (zh: string, en: string): string => this.locale(zh, en)

  /**
   * Republish the snapshot after a locale switch. Every `label()` resolves
   * against the current language while rendering, so a notification is all
   * that is needed — except the detect summary, which the store owns as an
   * already-resolved string and rebuilds from its counts here.
   */
  refreshLocale(): void {
    const counts = this.detectCounts
    this.mutate({
      localeRev: this.state.localeRev + 1,
      ...(counts === undefined ? {} : { detectSummary: this.detectSummaryOf(counts.total, counts.installed) }),
    })
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
      case 'agent/notice': {
        this.mutate({ notice: event.text })
        return Promise.resolve()
      }
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
        this.mutate({ sessions, ...this.watchedSessionPatch(event.sessionId, event.session) })
        return Promise.resolve()
      }
      case 'session/closed': {
        const sessions = this.state.sessions.filter(s => s.sessionId !== event.sessionId)
        const active = this.state.activeSessionId === event.sessionId ? sessions[0]?.sessionId : this.state.activeSessionId
        this.openTurns.delete(event.sessionId)
        const closedTranscripts = { ...this.state.chatTranscripts }
        delete closedTranscripts[event.sessionId]
        // The composer's chat-list view must lose the closed row too: a stale
        // entry would keep reading as a live session (the agent tag's halo
        // breathes on `!released`) until some future turn re-reads the list.
        const chatSessions = this.state.chatSessions.filter(s => s.sessionId !== event.sessionId)
        this.mutate({
          sessions,
          activeSessionId: active,
          chatTranscripts: closedTranscripts,
          ...(chatSessions.length !== this.state.chatSessions.length ? { chatSessions } : {}),
          permissions: this.state.permissions.filter(p => p.sessionId !== event.sessionId),
          ...(event.reason === 'agent-died' ? { notice: this.locale('会话因 agent 进程退出而终止', 'session ended: agent process died') } : {}),
        })
        return Promise.resolve()
      }
      case 'session/released': {
        // The agent process died: keep the session visible (marked released)
        // instead of dropping it — the next prompt resumes it via session/load.
        const sessions = this.state.sessions.some(s => s.sessionId === event.sessionId)
          ? this.state.sessions.map(s => (s.sessionId === event.sessionId ? event.session : s))
          : [...this.state.sessions, event.session]
        this.openTurns.delete(event.sessionId)
        // The composer's own list (`session/chat-list` views) must flip too, or
        // the agent tag's live halo keeps breathing for a process that is gone:
        // nothing else re-reads this list until the next turn settles.
        const chatSessions = this.state.chatSessions.some(s => s.sessionId === event.sessionId)
          ? this.state.chatSessions.map(s => (s.sessionId === event.sessionId ? { ...s, released: true } : s))
          : this.state.chatSessions
        this.mutate({
          sessions,
          ...(chatSessions !== this.state.chatSessions ? { chatSessions } : {}),
          permissions: this.state.permissions.filter(p => p.sessionId !== event.sessionId),
          // An observed transcript keeps its buffer but flips to released, so
          // the ACP view can say "会恢复" instead of silently looking dead.
          ...this.watchedSessionPatch(event.sessionId, event.session),
          notice: this.locale(
            'agent 进程已退出，会话已挂起；再次发送消息将自动恢复。',
            'agent process died; the session is paused and will resume on your next message.',
          ),
        })
        return Promise.resolve()
      }
      case 'session/reset': {
        // The session was resumed on a fresh process and the agent is about to
        // replay its history as fresh updates: drop local blocks and the seq
        // watermark so the replay folds in from a clean slate.
        this.lastSeq.set(event.sessionId, 0)
        this.openTurns.delete(event.sessionId)
        const isActive = event.sessionId === this.state.activeSessionId
        const sessions = this.state.sessions.some(s => s.sessionId === event.sessionId)
          ? this.state.sessions.map(s => (s.sessionId === event.sessionId ? event.session : s))
          : [...this.state.sessions, event.session]
        // The agent is about to replay its whole history as fresh updates:
        // an observed transcript must drop both its blocks and its watermark
        // or the replay would be read as a gap and refetched forever.
        const watched = this.state.chatTranscripts[event.sessionId]
        this.mutate({
          sessions,
          ...(isActive ? { blocks: [] } : {}),
          ...(watched === undefined ? {} : {
            chatTranscripts: {
              ...this.state.chatTranscripts,
              [event.sessionId]: { ...watched, session: event.session, blocks: [], seq: 0 },
            },
          }),
        })
        return Promise.resolve()
      }
      case 'session/update': {
        // Coalesced (see `pendingUpdates`): one fold + one mutate per frame.
        this.pendingUpdates.push({ sessionId: event.sessionId, seq: event.seq, update: event.update })
        this.armUpdateFlush()
        return Promise.resolve()
      }
      case 'catalog/updated': {
        // The host learned a new catalog, or a new slash-command list, from a
        // real session (its session/new, session/load, a config_option_update,
        // or an available_commands_update). The seat list is a cached
        // projection of both, so drop and re-read it — deduped by
        // `loadAgentCatalog`, and memory-only on the host, so this never starts
        // a probe.
        this.invalidateSeatCatalog(event.agentId)
        return this.loadAgentCatalog(event.agentId)
      }
      case 'agent/exposure': {
        // The host changed an agent's model visibility outside `agent/save`:
        // the settings card edited it, the auto-discovery switch was flipped,
        // or newly published models were appended automatically. Patch the
        // settings card's copy of the definition AND drop the seat cache — the
        // variants `agent/catalog` answers are a projection of this filter.
        const exposedModels = event.exposedModels.length === 0 ? undefined : [...event.exposedModels]
        const detectedAgents = this.state.detectedAgents.map(info =>
          info.id === event.agentId && info.currentConfig !== undefined
            ? {
                ...info,
                currentConfig: {
                  ...info.currentConfig,
                  exposedModels: exposedModels === undefined ? undefined : exposedModels,
                  autoDiscoverModels: event.autoDiscoverModels,
                },
              }
            : info)
        this.invalidateSeatCatalog(event.agentId)
        this.mutate({ detectedAgents })
        return this.loadAgentCatalog(event.agentId)
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
      case 'permission/synced': {
        // Terminator of the reconnect replay: the host just re-sent every
        // outstanding ask, and this set is the authoritative live list. Drop
        // anything this client still holds from before the disconnect — an ask
        // resolved while it was away is gone host-side, and answering it would
        // only earn `unknown_request`.
        const live = new Set(event.requestIds)
        this.mutate({ permissions: this.state.permissions.filter(p => live.has(p.requestId)) })
        return Promise.resolve()
      }
      case 'chat/agent-locked': {
        // The host locks a conversation at the START of its first ACP turn and
        // says so at once; this frame is what makes the hand-off animation run
        // at the start rather than on the turn-settled list read. It is emitted
        // only on the transition, so it always announces a new ceremony — even
        // if a racing list read already seeded the lock itself.
        this.chatUnlocked.delete(event.dshSessionId)
        this.mutate({
          chatLockedAgent: { ...this.state.chatLockedAgent, [event.dshSessionId]: event.agentId },
          chatBoundAgent: { ...this.state.chatBoundAgent, [event.dshSessionId]: event.agentId },
          agentLockReveal: { ...this.state.agentLockReveal, [event.dshSessionId]: (this.state.agentLockReveal[event.dshSessionId] ?? 0) + 1 },
        })
        return Promise.resolve()
      }
      case 'chat/agent-unlocked': {
        // The first turn delivered nothing and the host rolled the lock back.
        // The base must return; the failed ACP session is closed host-side, so
        // drop a cached list that still names it and let the next read confirm.
        this.chatUnlocked.add(event.dshSessionId)
        const chatLockedAgent = { ...this.state.chatLockedAgent }
        delete chatLockedAgent[event.dshSessionId]
        this.mutate({
          chatLockedAgent,
          ...(this.state.chatSessionsFor === event.dshSessionId ? { chatSessions: [] } : {}),
        })
        return Promise.resolve()
      }
      case 'turn/start': {
        this.openTurns.add(event.sessionId)
        this.markWatchedRunning(event.sessionId, true)
        if (event.sessionId === this.state.activeSessionId) {
          this.state.blocks.push({ kind: 'user', text: event.text })
          trimBlocks(this.state.blocks)
          this.mutate({ sessions: this.state.sessions.map(s => (s.sessionId === event.sessionId ? { ...s, running: true } : s)) })
        }
        return Promise.resolve()
      }
      case 'turn/end': {
        // One turn may end twice (force-finalized after an ignored cancel, or
        // settled by the host after a crash, then the real response arrives);
        // only the first turn/end per open turn is applied.
        if (!this.openTurns.has(event.sessionId)) return Promise.resolve()
        this.openTurns.delete(event.sessionId)
        this.markWatchedRunning(event.sessionId, false)
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
/**
 * Fold one transcript update into a block list. IMMUTABLE per block: the ACP
 * view memoizes rows on the block object, so an appended chunk replaces the
 * tail block instead of mutating it (array copies stay the caller's job, one
 * per folded batch). Returns whether any block changed — a usage-only tick
 * folds to `false` and the batch skips copying the array.
 *
 * `raw` is a lazy getter: pretty-printing a tool payload costs up to
 * {@link RAW_MAX} characters of JSON per call, and progress ticks restate
 * whole calls at high frequency — the cost is paid once, by the view that
 * actually shows the card, never by the fold loop.
 */
export function foldUpdate(blocks: Block[], update: Record<string, unknown>): boolean {
  const kind = String(update.sessionUpdate ?? '')
  const content = update.content as Record<string, unknown> | undefined
  switch (kind) {
    case 'user_message_chunk':
    case 'agent_message_chunk':
    case 'agent_thought_chunk': {
      const targetKind = kind === 'user_message_chunk' ? 'user' : kind === 'agent_message_chunk' ? 'agent' : 'thought'
      const text = chunkText(content)
      if (text === '') return false
      const messageId = typeof update.messageId === 'string' ? update.messageId : undefined
      const last = blocks[blocks.length - 1]
      if (targetKind === 'agent' && last?.kind === 'agent' && ((messageId !== undefined && last.messageId === messageId) || (messageId === undefined && last.messageId === undefined))) {
        blocks[blocks.length - 1] = { ...last, text: last.text + text }
      } else if (targetKind !== 'agent' && last?.kind === targetKind) {
        blocks[blocks.length - 1] = { ...last, text: last.text + text }
      } else if (targetKind === 'agent') {
        blocks.push({ kind: 'agent', ...(messageId === undefined ? {} : { messageId }), text })
      } else {
        blocks.push({ kind: targetKind, text })
      }
      return true
    }
    case 'tool_call': {
      let rawOf: string | undefined
      blocks.push({
        kind: 'tool',
        toolCallId: String(update.toolCallId ?? ''),
        title: String(update.title ?? ''),
        status: String(update.status ?? 'pending'),
        ...(typeof update.kind === 'string' ? { toolKind: update.kind } : {}),
        ...splitToolContent(update.content),
        ...toolInputFields(update),
        get raw() { return rawOf ??= jsonText(update) },
      })
      return true
    }
    case 'tool_call_update': {
      const id = String(update.toolCallId ?? '')
      for (let i = blocks.length - 1; i >= 0; i--) {
        const block = blocks[i]
        if (block?.kind !== 'tool' || block.toolCallId !== id) continue
        // An update restates the call in whole, but every field it does NOT
        // carry keeps the block's previous value (the restatement that only
        // brings a result must not wipe the arguments the card shows).
        const parsed = splitToolContent(update.content)
        const input = toolInputOf(update)
        const details = toolDetailsOf(update)
        let rawOf: string | undefined
        blocks[i] = {
          kind: 'tool',
          toolCallId: id,
          title: typeof update.title === 'string' && update.title !== '' ? update.title : block.title,
          status: typeof update.status === 'string' ? update.status : block.status,
          ...(typeof update.kind === 'string' ? { toolKind: update.kind } : block.toolKind === undefined ? {} : { toolKind: block.toolKind }),
          lines: parsed.lines.length > 0 ? parsed.lines : block.lines,
          ...(parsed.diffs === undefined
            ? block.diffs === undefined ? {} : { diffs: block.diffs }
            : { diffs: parsed.diffs }),
          ...(parsed.extras.length > 0 ? { extras: parsed.extras } : block.extras === undefined ? {} : { extras: block.extras }),
          ...(input === undefined ? block.input === undefined ? {} : { input: block.input } : { input }),
          ...(details.length > 0 ? { details } : block.details === undefined ? {} : { details: block.details }),
          get raw() { return rawOf ??= jsonText(update) },
        }
        return true
      }
      // Update for a tool call that rolled out of the transcript window.
      let rawOf: string | undefined
      blocks.push({
        kind: 'tool',
        toolCallId: id,
        title: id,
        status: String(update.status ?? 'completed'),
        ...splitToolContent(update.content),
        ...toolInputFields(update),
        get raw() { return rawOf ??= jsonText(update) },
      })
      return true
    }
    case 'plan': {
      const entries = Array.isArray(update.entries)
        ? (update.entries as Array<Record<string, unknown>>).map(e => ({
          content: String(e.content ?? ''),
          status: String(e.status ?? 'pending'),
          ...(typeof e.priority === 'string' ? { priority: e.priority } : {}),
        }))
        : []
      for (let i = blocks.length - 1; i >= 0; i--) {
        const block = blocks[i]
        if (block?.kind !== 'plan') continue
        blocks[i] = { ...block, entries }
        return true
      }
      blocks.push({ kind: 'plan', entries })
      return true
    }
    default: {
      // Every remaining notification kind is kept, not dropped: a command list,
      // a mode change, or a kind newer than this build. Bookkeeping frames that
      // say nothing new (`config_option_update` / `usage_update` /
      // `session_info_update`) ride the SessionView snapshot — they are state,
      // not stream content, and a row per tick would be noise.
      if (kind === '' || STATE_ONLY_UPDATES.has(kind)) return false
      let rawOf: string | undefined
      blocks.push({ kind: 'event', event: kind, text: describeEvent(kind, update), get raw() { return rawOf ??= jsonText(update) } })
      return true
    }
  }
}

/**
 * The input / detail fields a tool block carries from an update, spread-ready.
 * Kept apart from the content split so `tool_call` and `tool_call_update` share
 * one spelling of "when does a field appear".
 */
function toolInputFields(update: Record<string, unknown>): Record<string, unknown> {
  const fields: Record<string, unknown> = {}
  const input = toolInputOf(update)
  if (input !== undefined) fields.input = input
  const details = toolDetailsOf(update)
  if (details.length > 0) fields.details = details
  return fields
}

/** Notifications that update the SessionView snapshot instead of the block stream. */
export const STATE_ONLY_UPDATES: ReadonlySet<string> = new Set([
  'config_option_update',
  'usage_update',
  'session_info_update',
])

function trimBlocks(blocks: Block[]): void {
  if (blocks.length > MAX_BLOCKS) blocks.splice(0, blocks.length - MAX_BLOCKS)
}
