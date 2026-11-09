import type { AgentRefusalDetail, ChatSessionForkInfo, SessionView } from '../protocol.ts'
import type { PersistedChatSession } from './types.ts'
import { codebuddyMetaOf, permissionToolName } from './turn-stream.ts'
import type { LiveSession } from './turn-stream.ts'

/**
 * Why the agent refused a `session/prompt` it ANSWERED, read off the
 * response's `_meta`.
 *
 * CodeBuddy refuses a rate-limited prompt with a RESOLVED response, not a
 * rejection: `stopReason: 'refusal'` and the reason in
 * `_meta["codebuddy.ai/errorMessage"]`, a JSON string of the shape
 * `{ code, message, data: { statusCode, code, category } }`. The SDK's
 * prompt-response schema strips a top-level `errorMessage` field but passes
 * `_meta` through untouched, so this key is the only place the reason still
 * reaches the plugin — and `describeError` never sees it, because there is no
 * error to describe.
 *
 * `meta` is the `_meta` object itself (a prompt response's `meta`), not a
 * `{ _meta }` wrapper. `undefined` means "this response carries no refusal
 * detail", which is the answer for every other agent and for every normal
 * response — never a reason to invent one.
 */
export function agentRefusalDetail(meta: unknown): AgentRefusalDetail | undefined {
  if (typeof meta !== 'object' || meta === null) return undefined
  const raw = (meta as Record<string, unknown>)['codebuddy.ai/errorMessage']
  if (typeof raw !== 'string' || raw === '') return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    // Not JSON: another agent's key, or a future shape. The text is still the
    // agent's own reason, so report it as a refusal rather than dropping it.
    return { kind: 'refusal', message: raw }
  }
  if (typeof parsed !== 'object' || parsed === null) return { kind: 'refusal', message: raw }
  const row = parsed as Record<string, unknown>
  const message = typeof row.message === 'string' && row.message !== '' ? row.message : raw
  const data = typeof row.data === 'object' && row.data !== null ? row.data as Record<string, unknown> : {}
  const quota = data.category === 'quota' || data.statusCode === 429
  return { kind: quota ? 'quota' : 'refusal', message }
}

/**
 * The one wording both prompt paths use for a rate-limited turn. The chat
 * plane carries it in the turn's error, the `/acp` plane in its `turn/end`;
 * two phrasings for one fact is how a user ends up googling the wrong one.
 */
function rateLimitedTurnError(agentId: string, detail: AgentRefusalDetail): string {
  return `[dsh-ntr] agent "${agentId}" is rate limited: ${detail.message}`
}

/** Longest reason line the approval card headline carries. */
const APPROVAL_REASON_MAX = 240

/** Input keys that name the operation in one string, most specific first. */
const APPROVAL_REASON_INPUT_KEYS = [
  'command',
  'cmd',
  'path',
  'file_path',
  'filePath',
  'pattern',
  'query',
  'url',
  'description',
] as const

/**
 * One line saying WHAT the permission ask is about.
 *
 * WHY: without it the human only sees the tool's NAME ("Bash") and cannot
 * judge the request; the ACP tool call already declares the missing half — its
 * title and (for execute/edit tools) a short scalar in `rawInput`. Only ONE declared
 * string is used, never a serialized object or a whole file, and the line is
 * capped so a pathological input cannot fill the card or the audit log.
 */
export function permissionAskReason(toolCall: unknown): string {
  const row = (typeof toolCall === 'object' && toolCall !== null ? toolCall : {}) as Record<string, unknown>
  const title = permissionToolName(toolCall)
  const raw = row.rawInput
  const input = raw !== null && typeof raw === 'object' && !Array.isArray(raw)
    ? raw as Record<string, unknown>
    : typeof raw === 'string' && raw.length <= APPROVAL_REASON_MAX * 4
      // Some agents send the arguments as a JSON string; read one scalar out
      // of it instead of echoing the blob.
      ? (() => {
          try {
            const parsed: unknown = JSON.parse(raw)
            return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
              ? parsed as Record<string, unknown>
              : undefined
          } catch {
            return undefined
          }
        })()
      : undefined
  const detail = input === undefined
    ? undefined
    : APPROVAL_REASON_INPUT_KEYS
      .map(key => input[key])
      .find((value): value is string => typeof value === 'string' && value !== '')
  const line = detail === undefined || detail === title ? title : `${title} · ${detail}`
  return line.length > APPROVAL_REASON_MAX ? `${line.slice(0, APPROVAL_REASON_MAX - 1)}…` : line
}

/** Longest label the host's subagent catalog row carries for an ACP worker. */
const SUBAGENT_CATALOG_LABEL_MAX = 160

/** The structured input object an ACP tool call declared, if any. */
function rawInputObjectOf(update: Record<string, unknown>): Record<string, unknown> | undefined {
  const raw = update.rawInput ?? update.arguments
  if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>
  if (typeof raw === 'string' && raw.length <= 16_384) {
    try {
      const parsed: unknown = JSON.parse(raw)
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>
    } catch {
      return undefined
    }
  }
  return undefined
}

/**
 * One line naming a detached ACP worker in the host's subagent catalog.
 *
 * The identity is read from what CodeBuddy actually sends, in order: the
 * `_meta` keys on the dispatch call's result frames (`subagentType` /
 * `description` / `memberName` — the FIRST `tool_call` omits `rawInput`, so
 * these are often the only source), then the structured `rawInput`, then the
 * tool title. The prompt body is only used when nothing shorter exists. Capped
 * so a pathological input cannot fill the catalog row.
 */
export function subagentDispatchLabel(update: Record<string, unknown>): string {
  const meta = codebuddyMetaOf(update)
  const input = rawInputObjectOf(update) ?? {}
  const type = meta?.subagentType
    ?? nonEmptyStringOf(input.subagent_type)
    ?? nonEmptyStringOf(input.subagentType)
    ?? permissionToolName(update)
  const detail = meta?.subagentName
    ?? nonEmptyStringOf(input.name)
    ?? meta?.subagentDescription
    ?? nonEmptyStringOf(input.description)
    ?? nonEmptyStringOf(input.prompt)
  const line = detail === undefined || detail === type ? type : `${type} · ${detail}`
  return line.length > SUBAGENT_CATALOG_LABEL_MAX ? `${line.slice(0, SUBAGENT_CATALOG_LABEL_MAX - 1)}…` : line
}

/**
 * Whether the update declared the worker's IDENTITY (role / task / name)
 * rather than just restating the `Agent` tool. A bare dispatch names the tool
 * as "Agent"; reporting that as the catalog label says nothing, so the report
 * waits for one of these facts (or for the dispatch to complete).
 */
function subagentDispatchDeclaresIdentity(update: Record<string, unknown>): boolean {
  const meta = codebuddyMetaOf(update)
  if (meta?.subagentType !== undefined
    || meta?.subagentDescription !== undefined
    || meta?.subagentName !== undefined) return true
  const input = rawInputObjectOf(update)
  if (input === undefined) return false
  return ['subagent_type', 'subagentType', 'name', 'description', 'prompt']
    .some(key => nonEmptyStringOf(input[key]) !== undefined)
}

function nonEmptyStringOf(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

function snapshot(session: LiveSession): SessionView {
  return {
    sessionId: session.sessionId,
    agentId: session.agentId,
    acpSessionId: session.acpSessionId,
    cwd: session.cwd,
    ...(session.title !== undefined ? { title: session.title } : {}),
    ...(session.modes !== undefined ? { modes: session.modes } : {}),
    ...(session.configOptions !== undefined ? { configOptions: session.configOptions } : {}),
    ...(session.availableCommands !== undefined ? { availableCommands: session.availableCommands } : {}),
    ...(session.plan !== undefined ? { plan: session.plan } : {}),
    ...(session.usage !== undefined ? { usage: session.usage } : {}),
    ...(session.burst !== undefined ? { burst: session.burst } : {}),
    running: session.running,
    closed: session.closed,
    ...(session.settled !== undefined ? { settled: true } : {}),
    ...(session.released ? { released: true } : {}),
    ...(session.hasHistory === true ? { hasHistory: true } : {}),
    // The agent's own words only: the `at` timestamp is host-side bookkeeping
    // and no browser surface has a use for it.
    ...(session.quotaRefusal !== undefined ? { quotaRefusal: { message: session.quotaRefusal.message } } : {}),
    seq: session.transcript.head,
  }
}

/**
 * The `fork` half of one `session/chat-list` row: the host's verdict on
 * forking this session's ACP agent. The capability half is the agent's LAST
 * KNOWN bit (see `canForkNow`); the state half is the session's own, released
 * checked before running (a parked record is never running). The browser
 * renders its branch button from this verdict and never reads a capability
 * bit itself.
 */
function forkRowInfo(session: LiveSession, capability: boolean): { fork: ChatSessionForkInfo } {
  if (!capability) return { fork: { supported: false, reason: 'unsupported' } }
  if (session.released) return { fork: { supported: false, reason: 'released' } }
  if (session.running || session.settled !== undefined) return { fork: { supported: false, reason: 'busy' } }
  return { fork: { supported: true } }
}

function persistedChatSession(session: LiveSession): PersistedChatSession {
  return {
    sessionId: session.sessionId,
    acpSessionId: session.acpSessionId,
    agentId: session.agentId,
    dshSessionId: session.dshSessionId as string,
    cwd: session.cwd,
    ...(session.title === undefined ? {} : { title: session.title }),
    ...(session.modelId === undefined ? {} : { modelId: session.modelId }),
    ...(session.reasoningEffort === undefined ? {} : { reasoningEffort: session.reasoningEffort }),
    ...(session.modes === undefined ? {} : { modes: session.modes }),
    ...(session.usage === undefined ? {} : { usage: session.usage }),
    ...(session.burst === undefined ? {} : { burst: session.burst }),
    ...(session.hasHistory === true || session.transcript.since(0).length > 0 ? { hasHistory: true } : {}),
  }
}

/** Tolerant shape check for a `modes` value read back from disk. */
function isPersistedModes(value: unknown): value is SessionView['modes'] {
  if (value === null || typeof value !== 'object') return false
  const modes = value as { currentModeId?: unknown; availableModes?: unknown }
  return typeof modes.currentModeId === 'string' && Array.isArray(modes.availableModes)
}

/** Tolerant shape check for a `usage` value read back from disk. */
function isPersistedUsage(value: unknown): value is SessionView['usage'] {
  if (value === null || typeof value !== 'object') return false
  const usage = value as { used?: unknown; size?: unknown }
  return typeof usage.used === 'number' && typeof usage.size === 'number'
}

/** Tolerant shape check for a `burst` aggregate read back from disk. */
function isPersistedBurst(value: unknown): value is NonNullable<SessionView['burst']> {
  if (value === null || typeof value !== 'object') return false
  const burst = value as { outputTokens?: unknown; burstMs?: unknown }
  return typeof burst.outputTokens === 'number' && burst.outputTokens >= 0
    && typeof burst.burstMs === 'number' && burst.burstMs >= 0
}

export {
  forkRowInfo,
  isPersistedBurst,
  isPersistedModes,
  isPersistedUsage,
  persistedChatSession,
  rateLimitedTurnError,
  snapshot,
  subagentDispatchDeclaresIdentity,
}
