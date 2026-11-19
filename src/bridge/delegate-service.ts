/**
 * `acp_delegate`: hand one self-contained task to a configured external ACP
 * agent, run it in that agent's OWN process, and return its final answer
 * (docs/plan/acp-delegate-subagent.md §3 / §4).
 *
 * One delegation = one fresh ACP session + one `session/prompt` + a bounded
 * teardown. The answer is folded INCREMENTALLY from the hub's `session/update`
 * stream (the transcript ring evicts early chunks on long turns, so it is only
 * a fallback), permission asks are answered by the delegation's OWN
 * session-level policy (§4.2 — the bridge-level fields are never touched), and
 * non-A1 agents serialize their delegations through a defensive per-agent
 * queue (§4.4 — the plugin does not bet on the agent's concurrency support).
 *
 * DI discipline (same as `subagent-service.ts`): the service never imports the
 * manager — every capability arrives through {@link AcpDelegateHost}. The
 * module stays free of Node APIs; time and events come from the host seams.
 */
import type { AcpEvent, AcpDelegatePolicy, DelegateGuidance, DelegatePermissionMode } from '../protocol.ts'
import { isPerSessionAgent } from './identity.ts'
import { chunkTextOf, codebuddyMetaOf } from './turn-stream.ts'

// The policy shape is authoritative in protocol/ui.ts (one definition for the
// service, LiveSession, the RPC seam and the manager); re-exported so the
// bridge barrel and existing importers keep their path.
export type { AcpDelegatePolicy }

/** What the delegate service needs from the bridge manager, injected. */
export interface AcpDelegateHost {
  /** Broadcast hub; `subscribe` returns the exact unsubscribe function. */
  hub: { subscribe(sink: (event: AcpEvent) => void): () => void }
  /** The configured agents (id + display title), for resolution and errors. */
  agents(): readonly { id: string; title: string }[]
  /** The plugin-private default agent id, when one is set. */
  defaultAgent(): string | undefined
  /** The LIVE delegate settings — execute reads them per call (hot config). */
  delegateConfig(): { guidance: DelegateGuidance; permissionMode: DelegatePermissionMode; timeoutMs: number; maxOutputChars: number }
  /** Open a fresh session on the agent's process (A1 gets its own child). */
  startSession(agentId: string, cwd?: string): Promise<{ sessionId: string }>
  /** Set the session-level permission policy; must land BEFORE the prompt. */
  setPermissionPolicy(sessionId: string, policy: AcpDelegatePolicy): void
  /** Dispatch one prompt; resolves with the turn id once sent. */
  prompt(sessionId: string, text: string): Promise<{ turnId: string }>
  /** Ask the agent to stop the running turn (cooperative). */
  cancel(sessionId: string): Promise<void>
  /** Close the session; the RPC layer throws `unknown_session` for a gone id. */
  closeSession(sessionId: string): Promise<void>
  /** Answer a pending ask; `optionId` undefined = cancelled. */
  respondPermission(requestId: string, optionId?: string): void
  /** The raw transcript — the text fallback ONLY, never the primary fold. */
  transcript(sessionId: string, afterSeq?: number): { session: unknown; entries: Array<{ seq: number; update: unknown }> }
}

/** The tool's return value: the folded report plus the terminal facts. */
export interface AcpDelegateResult { text: string; agent: string; stopReason?: string; error?: string }

/** The register-ready execute shape (`exec.signal` is the host's abort seam). */
export type AcpDelegateExecute = (args: unknown, exec: { signal?: AbortSignal }) => Promise<AcpDelegateResult>

/** The base description every guidance rung shares (plan §3). */
const BASE_DESCRIPTION = '把一件自成一体的任务交给一个已配置的外部 ACP agent，在它自己的进程里执行，'
  + '并返回它最后给出的答复。适合需要另一套工具/另一套上下文的独立子任务；'
  + '返回的是被动汇报，不是可继续对话的子会话。'
/** The MUST sentence `enhanced` / `force` append (a soft constraint). */
const GUIDANCE_SENTENCE = '需要派发子代理时，必须使用本工具，优先于任何原生子代理/委派工具。'

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Read the abort flag without TS narrowing it across the awaits below. */
function isAborted(signal: AbortSignal | undefined): boolean {
  return signal !== undefined && signal.aborted
}

/** The RPC layer's `unknown_session` — the one close error the service swallows. */
function isUnknownSession(error: unknown): boolean {
  if (typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'unknown_session') return true
  return error instanceof Error && error.message.includes('unknown_session')
}

/** The three-rung mapping of plan §4.2 (session policy, never bridge fields). */
function policyFor(mode: DelegatePermissionMode, agentId: string): AcpDelegatePolicy {
  if (mode === 'auto') return { mode: 'auto', windowMs: 0, preferOnce: !isPerSessionAgent(agentId) }
  if (mode === 'abort') return { mode: 'abort', windowMs: 30_000 }
  return { mode: 'wait', windowMs: 0 }
}

/**
 * The register-ready tool definition (compiled JSON Schema + `output.render`,
 * the verified `virtualToolDefinition` shape — NOT the `defineTool` DSL).
 *
 * The guidance rung bakes into the description and the budget into `timeoutMs`
 * (+30s cooperative grace over the internal window); hot changes re-register
 * through `AcpDelegateRegistration`. `off` still builds the base description —
 * the builder never judges `off`; registration decides whether to register.
 */
export function acpDelegateToolDefinition(opts: { guidance: DelegateGuidance; timeoutMs: number; execute: AcpDelegateExecute }): {
  name: string
  description: string
  parameters: Record<string, unknown>
  output: { schema: Record<string, unknown>; render: (args: unknown, value: unknown) => Array<{ type: 'text'; text: string }> }
  timeoutMs: number
  execute: AcpDelegateExecute
} {
  const description = opts.guidance === 'enhanced' || opts.guidance === 'force'
    ? BASE_DESCRIPTION + GUIDANCE_SENTENCE
    : BASE_DESCRIPTION
  return {
    name: 'acp_delegate',
    description,
    parameters: {
      type: 'object',
      properties: {
        task: { type: 'string', description: '完整任务描述（子代理看不到本会话上下文）' },
        agent: { type: 'string', description: '已配置的 agent id；省略 = 插件默认 agent' },
        cwd: { type: 'string', description: '工作目录，必须在该 agent 已配置的 allowedCwdRoots 内；省略 = 该 agent 的默认工作区' },
      },
      required: ['task'],
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          text: { type: 'string' },
          agent: { type: 'string' },
          stopReason: { type: 'string' },
          error: { type: 'string' },
        },
        required: ['text'],
      },
      render: (_args: unknown, value: unknown) => [{ type: 'text', text: String((value as { text?: unknown } | null | undefined)?.text ?? '') }],
    },
    // Cooperative budget: the host aborts the derived signal at this deadline
    // and only replaces the result with TOOL_TIMEOUT after execute settles.
    timeoutMs: opts.timeoutMs + 30_000,
    execute: opts.execute,
  }
}

/**
 * run()'s settlement discriminator (constraint 17 / AGENTS/state.md §10): ONE
 * explicit string-literal union, first cause wins — a later cause never
 * overwrites it. The coexisting scheduling handles (queue promise, timer,
 * abort listener) stay handles: §10's exception covers them, not this outcome.
 */
type DelegateSettle = 'pending' | 'ended' | 'timed-out' | 'aborted' | 'prompt-error'

/**
 * One delegation run, end to end (plan §4 steps 1–6). Every failure surfaces
 * as `Error('acp_delegate: …')` — the host normalizes a thrown execute into an
 * `isError` tool result for the model; the process never crashes.
 */
export class AcpDelegateService {
  /**
   * Defensive per-agent serial queues (§4.4): non-A1 delegations to the SAME
   * agent id chain on one promise; different agents run in parallel; A1
   * (one process per delegation) never queues. A tail never rejects, so one
   * failed delegation does not poison the chain behind it.
   */
  private readonly queues = new Map<string, Promise<void>>()

  constructor(private readonly host: AcpDelegateHost) {}

  execute: AcpDelegateExecute = async (args, exec) => {
    try {
      return await this.delegate(args, exec)
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('acp_delegate:')) throw error
      throw new Error(`acp_delegate: ${messageOf(error)}`)
    }
  }

  /** Steps 1–3: parse, resolve (no session yet), then queue or run. */
  private async delegate(args: unknown, exec: { signal?: AbortSignal }): Promise<AcpDelegateResult> {
    const row = (typeof args === 'object' && args !== null ? args : {}) as Record<string, unknown>
    const task = row.task
    if (typeof task !== 'string' || task.trim() === '') throw new Error('acp_delegate: task must be a non-empty string')
    const agentArg = row.agent
    if (agentArg !== undefined && typeof agentArg !== 'string') throw new Error('acp_delegate: agent must be a string')
    const cwd = row.cwd
    if (cwd !== undefined && typeof cwd !== 'string') throw new Error('acp_delegate: cwd must be a string')
    const agentId = this.resolveAgent(agentArg)
    const signal = exec.signal
    // A1: one child process per delegation — naturally parallel, no queue.
    if (isPerSessionAgent(agentId)) return this.run(agentId, task, cwd, signal)
    const previous = this.queues.get(agentId) ?? Promise.resolve()
    const execution = (async () => {
      await this.waitQueued(previous, signal)
      return this.run(agentId, task, cwd, signal)
    })()
    // The tail settles (never rejects) when this execution settles, so the
    // next waiter proceeds even after a failure or a queue-abort.
    const tail = execution.then(() => {}, () => {})
    this.queues.set(agentId, tail)
    try {
      return await execution
    } finally {
      if (this.queues.get(agentId) === tail) this.queues.delete(agentId)
    }
  }

  /** Step 2: resolve the agent id; errors list the configured ids. */
  private resolveAgent(agentArg: string | undefined): string {
    const configured = this.host.agents()
    const ids = configured.map(agent => agent.id).join(', ')
    if (agentArg === undefined) {
      const fallback = this.host.defaultAgent()
      if (fallback === undefined) {
        throw new Error(`acp_delegate: no default agent configured; name one explicitly (configured: ${ids})`)
      }
      return fallback
    }
    if (!configured.some(agent => agent.id === agentArg)) {
      throw new Error(`acp_delegate: unknown agent "${agentArg}" (configured: ${ids})`)
    }
    return agentArg
  }

  /**
   * The queue wait observes `exec.signal`: the host budget runs from execute
   * start, so a delegation whose turn in the queue never comes leaves the
   * queue and throws instead of burning the whole budget silently (§4.4).
   */
  private async waitQueued(previous: Promise<void>, signal: AbortSignal | undefined): Promise<void> {
    if (isAborted(signal)) throw new Error('acp_delegate: aborted while queued')
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => { reject(new Error('acp_delegate: aborted while queued')) }
      signal?.addEventListener('abort', onAbort, { once: true })
      const done = () => { signal?.removeEventListener('abort', onAbort); resolve() }
      // A failed predecessor must not fail the waiter: the queue drains on.
      previous.then(done, done)
    })
  }

  /** Steps 4–10: session, policy, fold, prompt, bounded settlement, report. */
  private async run(agentId: string, task: string, cwd: string | undefined, signal: AbortSignal | undefined): Promise<AcpDelegateResult> {
    if (isAborted(signal)) throw new Error('acp_delegate: aborted')
    const config = this.host.delegateConfig()
    let sessionId: string
    try {
      sessionId = (await this.host.startSession(agentId, cwd)).sessionId
    } catch (error) {
      // cwd_denied / bad_cwd / no_cwd pass through verbatim, with the agent id.
      throw new Error(`acp_delegate: ${messageOf(error)} (agent ${agentId})`)
    }
    let closed = false
    const closeOnce = async (): Promise<void> => {
      if (closed) return
      closed = true
      try {
        await this.host.closeSession(sessionId)
      } catch (error) {
        if (!isUnknownSession(error)) throw error
      }
    }
    const closeQuietly = async (): Promise<void> => {
      try { await closeOnce() } catch { /* cleanup never masks the primary failure */ }
    }
    // Step 5: the session policy MUST land before the prompt (§4.2).
    const policy = policyFor(config.permissionMode, agentId)
    try {
      this.host.setPermissionPolicy(sessionId, policy)
    } catch (error) {
      await closeQuietly()
      throw error
    }
    if (isAborted(signal)) {
      await closeQuietly()
      throw new Error('acp_delegate: aborted')
    }

    // ---- incremental fold state (step 6) ----
    let text = ''
    let truncated = false
    const seenSeq = new Set<number>()
    let refused = 0
    let autoAnswered = 0
    let stopReason: string | undefined
    let turnError: string | undefined
    // Widened on purpose: the causes are written inside closures (settle), so
    // the reads below must see the whole union, not the initializer literal.
    let outcome = 'pending' as DelegateSettle
    let promptFailure: unknown
    let resolveEnd!: () => void
    const endSignal = new Promise<void>(resolve => { resolveEnd = resolve })
    // First cause wins: the guard turns every later cause into a no-op, so the
    // settlement below reads ONE discriminator, never flag-check order. The
    // failure payload rides along and is only written by the winning cause.
    const settle = (cause: Exclude<DelegateSettle, 'pending'>, failure?: unknown): void => {
      if (outcome !== 'pending') return
      outcome = cause
      promptFailure = failure
      resolveEnd()
    }
    const cap = config.maxOutputChars
    // Shared by the live fold and the transcript fallback: seq dedupe, skip
    // the agent's OWN subagent prose (parentToolCallId), cap with a marker.
    const collect = (seq: number, update: unknown): void => {
      if (seenSeq.has(seq)) return
      seenSeq.add(seq)
      if (truncated) return
      if (typeof update !== 'object' || update === null) return
      const row = update as Record<string, unknown>
      if (row.sessionUpdate !== 'agent_message_chunk') return
      if (codebuddyMetaOf(update)?.parentToolCallId !== undefined) return
      const chunk = chunkTextOf(row.content)
      if (chunk === '') return
      if (text.length + chunk.length > cap) {
        const room = cap - text.length
        if (room > 0) text += chunk.slice(0, room)
        text += `\n…[truncated at ${String(cap)} chars]`
        truncated = true
        return
      }
      text += chunk
    }
    // Subscribe BEFORE the prompt so no chunk of the turn can slip past.
    const unsubscribe = this.host.hub.subscribe(event => {
      switch (event.type) {
        case 'session/update':
          if (event.sessionId === sessionId) collect(event.seq, event.update)
          return
        case 'permission/request':
          if (event.sessionId !== sessionId) return
          // abort: answer cancelled on arrival, beating the 30s timer. auto+0
          // never broadcasts this frame (the bridge answers in place); ask
          // leaves the ask for a human.
          if (policy.mode === 'abort') {
            refused += 1
            try { this.host.respondPermission(event.requestId, undefined) } catch { /* unknown_request: already settled */ }
          }
          return
        case 'permission/expired':
          if (event.sessionId !== sessionId) return
          if (event.outcome.outcome === 'selected') autoAnswered += 1
          else refused += 1
          return
        case 'turn/end':
          // Match by sessionId, ANY turnId: the watchdog finalizes a
          // controller-less session with turnId '' and an error-only frame.
          if (event.sessionId !== sessionId || outcome !== 'pending') return
          stopReason = event.stopReason
          turnError = event.error
          settle('ended')
          return
        default:
          return
      }
    })

    // ---- step 7: prompt, then wait on turn/end / timeout / abort ----
    const onAbort = () => { settle('aborted') }
    signal?.addEventListener('abort', onAbort, { once: true })
    if (isAborted(signal)) onAbort()
    // The internal window starts when the prompt goes out, ahead of the
    // host's +30s cooperative budget.
    const timer = setTimeout(() => { settle('timed-out') }, config.timeoutMs)
    try {
      // A rejected prompt (turn_in_flight, agent died, …) settles the wait
      // too; its error surfaces after the bounded cleanup below.
      void this.host.prompt(sessionId, task).then(
        () => {},
        (error: unknown) => { settle('prompt-error', error) },
      )
      await endSignal
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      if (outcome !== 'ended') {
        // Self-settling failure path: cancel THEN close, and never wait for a
        // turn/end afterwards (close does not emit one). Each cleanup step is
        // awaited once, bounded by the host's own close/cancel races, so the
        // whole settlement lands inside the +30s grace.
        try { await this.host.cancel(sessionId) } catch { /* bounded cleanup */ }
        await closeQuietly()
        if (outcome === 'aborted') throw new Error('acp_delegate: aborted')
        if (outcome === 'timed-out') throw new Error(`acp_delegate: timed out after ${String(config.timeoutMs)}ms`)
        throw new Error(`acp_delegate: ${messageOf(promptFailure)}`)
      }
      // Step 9: text fallback — read the transcript ONCE, before close (close
      // deletes the record; a later read would only throw unknown_session).
      if (text === '') {
        try {
          const dump = this.host.transcript(sessionId, 0)
          for (const entry of dump.entries) collect(entry.seq, entry.update)
        } catch { /* fail-open: the placeholder below reports the empty answer */ }
      }
      // Step 8 (normal end): close exactly once, then unsubscribe in finally.
      await closeOnce()
      // Step 10: the report the model reads.
      const body = text === '' ? '(the agent returned no text)' : text
      let footer = `\n\n— acp_delegate · ${agentId} · ${stopReason ?? turnError ?? 'unknown'}`
      if (refused > 0) footer += ` · 拒绝 ${String(refused)} 个审批`
      if (autoAnswered > 0) footer += ` · 自动代答 ${String(autoAnswered)} 个`
      const result: AcpDelegateResult = { text: body + footer, agent: agentId }
      if (stopReason !== undefined) result.stopReason = stopReason
      if (turnError !== undefined) result.error = turnError
      return result
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      unsubscribe()
    }
  }
}