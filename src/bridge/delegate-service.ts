/**
 * `acp_delegate`: hand one self-contained task to a configured external ACP
 * agent and run it in that agent's OWN process
 * (docs/plan/acp-delegate-native-subagent.md §2 / §4 / §5).
 *
 * One delegation = one fresh ACP session + one `session/prompt` + a bounded
 * teardown. The session inherits the CALLING DSH session's workspace when
 * `cwd` is omitted (an explicit cwd must sit inside that workspace or the
 * agent's own roots). The answer is folded INCREMENTALLY from the hub's
 * `session/update` stream (the transcript ring evicts early chunks on long
 * turns, so it is only a fallback), permission asks are answered by the
 * delegation's OWN session-level policy (the bridge-level fields are never
 * touched), and non-A1 agents serialize their delegations through a defensive
 * per-agent queue (the plugin does not bet on the agent's concurrency support).
 *
 * The four customization axes (agent/model/effort/mode) resolve per axis as
 * explicit tool argument > configured per-agent default > unset; validation
 * is the LIVE session/new answer ONLY (impl/delegate-choices.ts plans the
 * writes, mode before model, effort against the refreshed options). A stale
 * configured value degrades silently with one merged notice + settlement
 * notes; a stale explicit agent/model/mode fails the run; effort is never
 * fatal. A write RPC that throws is a runtime failure (error settlement, no
 * fallback), and a fallback NEVER rewrites the persisted configuration.
 *
 * TWO shells share ONE core: `begin()` starts a run and returns a handle whose
 * `result` promise settles with the terminal facts (never rejects); the legacy
 * synchronous `execute` awaits it and reports the folded full text (old hosts
 * without the subagent seam), while the native provider
 * (bridge/delegate-provider.ts) maps the same settlement onto the host's
 * `SubagentResult` and returns immediately. The rolling silence window lives
 * in the core; the fixed 24h absolute backstop is the host tool budget on the
 * legacy shell and an OPTIONAL built-in timer (`absoluteBudgetMs`) on the
 * native one, where no tool budget covers the detached run.
 *
 * DI discipline (same as `subagent-service.ts`): the service never imports the
 * manager — every capability arrives through {@link AcpDelegateHost}. The
 * module stays free of Node APIs; time and events come from the host seams.
 */
import type { AcpEvent, AcpDelegateAgentDefaults, AcpDelegatePolicy, AcpDelegateAsyncOutput, AcpStartSessionOpts, DelegateGuidance } from '../protocol.ts'
import { DELEGATE_TIMEOUT_MAX_MS } from '../protocol.ts'
import { isAbsolutePath, planDelegateEffort, planDelegateModeAndModel, delegateRosterText } from '../impl.ts'
import type { DelegateAgentDoc, DelegateChoiceSet, DelegateChoiceWrite, DelegateLiveOptions } from '../impl.ts'
import { isPerSessionAgent } from './identity.ts'
import { describeError } from './errors.ts'
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
  /** The LIVE delegate settings — a run reads them at its start (hot config). */
  delegateConfig(): { guidance: DelegateGuidance; timeoutMs: number; defaultAgent?: string; agentDefaults: Record<string, AcpDelegateAgentDefaults> }
  /**
   * Open a fresh session on the agent's process (A1 gets its own child).
   * Delegation ALWAYS passes opts: the cwd is validated before any spawn, the
   * calling session's workspace rides along as the one extra root, and the
   * process runs in the validated cwd. Resolves with the session id AND the
   * canonical cwd the session actually landed on (the report names it).
   */
  startSession(agentId: string, cwd?: string, opts?: AcpStartSessionOpts): Promise<{ sessionId: string; cwd: string }>
  /** Set the session-level permission policy; must land BEFORE the prompt. */
  setPermissionPolicy(sessionId: string, policy: AcpDelegatePolicy): void
  /**
   * The session's LIVE `session/new` options (configOptions + modes) — the
   * ONLY validation authority for the choice axes (never the catalog).
   * `undefined` for a session that cannot be located.
   */
  sessionOptions(sessionId: string): DelegateLiveOptions | undefined
  /** The mode-axis write: switch the session's working mode. */
  setMode(sessionId: string, modeId: string): Promise<void>
  /**
   * The model/effort-axis write: set one config option. The bridge folds the
   * authoritative answer back into the session snapshot (constraint 4), so a
   * later {@link sessionOptions} read sees the refreshed option set.
   */
  setConfigOption(sessionId: string, configId: string, value: string): Promise<void>
  /**
   * One merged degradation note per run (the settings-page log), filed under
   * the DELEGATED agent (`agentId`) — never the global default; optional.
   */
  notify?(text: string, agentId?: string): void
  /** Dispatch one prompt; resolves with the turn id once sent. */
  prompt(sessionId: string, text: string): Promise<{ turnId: string }>
  /** Ask the agent to stop the running turn (cooperative). */
  cancel(sessionId: string): Promise<void>
  /** Close the session; the RPC layer throws `unknown_session` for a gone id. */
  closeSession(sessionId: string): Promise<void>
  /** The raw transcript — the text fallback ONLY, never the primary fold. */
  transcript(sessionId: string, afterSeq?: number): { session: unknown; entries: Array<{ seq: number; update: unknown }> }
}

/** The LEGACY tool return value: the folded report plus the terminal facts. */
export interface AcpDelegateResult { text: string; agent: string; stopReason?: string; error?: string; notes?: string }

/**
 * The host's execute context, structural on purpose: no host package import,
 * and every level may be missing on an old host (the service then degrades to
 * the agent default). `exec.agent` is the CALLING session's live agent — the
 * native shell forwards it verbatim as the activation parent, and the core
 * reads only its session header cwd (the workspace the delegation inherits).
 */
export interface AcpDelegateExecContext {
  signal?: AbortSignal
  agent?: { session?: { header?: { cwd?: string } } }
}

/** The register-ready LEGACY execute shape (synchronous full-text report). */
export type AcpDelegateExecute = (args: unknown, exec: AcpDelegateExecContext) => Promise<AcpDelegateResult>

/** The register-ready NATIVE execute shape (immediate activation receipt). */
export type AcpDelegateActivationExecute = (args: unknown, exec: AcpDelegateExecContext) => Promise<AcpDelegateAsyncOutput>

/**
 * The base description every LEGACY guidance rung shares: what it does, when it
 * pays off, what comes back. The scene list is the load-bearing part — the host
 * describes its own delegation tool with concrete examples ("research, a scoped
 * implementation, an analysis"), and an abstract "another tool set / another
 * context" never maps onto the task the caller actually holds.
 */
export const BASE_DESCRIPTION = '把一件自成一体的任务交给一个已配置的外部 ACP agent，在它自己的进程与上下文里执行，'
  + '并返回它最后给出的答复。适合独立调研、单文件改动、复核审查、跨模型第二意见这类不需要本会话上下文的工作；'
  + '返回的是被动汇报，不能续聊，要追加指令就重新派发。'
/**
 * The MUST sentence `enhanced` / `force` PREPEND, not append: the steering is
 * the first thing the caller reads instead of the last, so it is not buried
 * behind mechanism. Two escape hatches are real, and BOTH are things this tool
 * cannot do: a child that must inherit THIS conversation's context
 * (`subagent_fork`), and one you need to steer mid-run or continue across turns
 * (this provider has no `prepareContinuable`, so "ask again later" throws away
 * the child's accumulated context). Naming them turns a bare ban into a
 * decision procedure — a rule that hides its own exceptions gets ignored.
 */
export const GUIDANCE_PREFIX = '需要派发子智能体时必须使用本工具（优先于任何原生子智能体/委派工具）；只有子智能体必须继承本会话上下文、或需要中途追加指令与多轮续聊时才用原生。'
/**
 * The NATIVE base description: immediate name, settlement notification later.
 * "可以继续做不相交的工作" mirrors the host's own delegation guidance (the host
 * steers `subagent` / `subagent_fork` callers to keep working while a child
 * runs): `delivery: 'parent'` is the SAME host path for both shells, and
 * `notifySettlement` steers the notice into a busy parent turn instead of
 * dropping it — the old "派发后必须结束当前回合" was self-imposed. The shared
 * workspace is why the file-conflict guard comes along with it: an ACP child
 * inherits the caller's cwd, so "不相交" is a promise the caller has to keep.
 */
export const NATIVE_BASE_DESCRIPTION = '把一件自成一体的任务交给一个已配置的外部 ACP agent，在它自己的进程与上下文里执行，'
  + '再把最终答复带回本会话。适合独立调研、单文件改动、复核审查、跨模型第二意见这类不需要本会话上下文的工作。'
  + '只回最终答复、不回中间步骤；调用立即返回子智能体的 name，不等待结果。'
  + '派发后可以继续做不相交的工作（别和它改同一批文件，合并前复核 diff 并跑测试），只剩等待时结束本回合，'
  + '宿主会把结算通知送达并起下一轮；这是一次性委派，不能续聊，要追加指令就重新派发。'

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * The `agent` parameter description: the resolution rule plus the live roster.
 * The roster is the ONE place the caller learns "who is good at what" without
 * spawning anything — each row carries the user's description and the
 * persisted delegation defaults (see `delegateRosterText`). Absent roster
 * (older wiring / tests) falls back to the plain rule so the schema never
 * renders a half-built list.
 */
function delegateAgentParamDescription(roster: readonly DelegateAgentDoc[] | undefined): string {
  const base = '已配置的 agent id；省略 = 用子智能体委派配置的默认 agent（未配置或已失效时回落到全局默认 agent），两者都空则报错'
  if (roster === undefined) return base
  const text = delegateRosterText(roster)
  return text === '' ? base : `${base}\n${text}`
}

/** Keep the ONE error vocabulary: every surfaced message carries the prefix. */
function prefixed(message: string): string {
  return message.startsWith('acp_delegate:') ? message : `acp_delegate: ${message}`
}

/** Read the abort flag without TS narrowing it across the awaits below. */
function isAborted(signal: AbortSignal | undefined): boolean {
  return signal !== undefined && signal.aborted
}

/**
 * The calling DSH session's workspace, from the host's execute context: the
 * session header cwd (the directory the user picked in the sidebar — the SAME
 * root the chat path trusts as `extraRoots`, constraint 15), never the agent's
 * effective `working_directory` cd. Only a non-empty absolute path counts;
 * anything else (no agent, no header, a relative or malformed cwd) reads as
 * `undefined` and the delegation degrades to the agent's own default without
 * an error. Optional chaining throughout: the host shape is not ours to trust.
 */
function sessionWorkspaceOf(exec: AcpDelegateExecContext): string | undefined {
  const cwd = exec.agent?.session?.header?.cwd
  return typeof cwd === 'string' && cwd !== '' && isAbsolutePath(cwd) ? cwd : undefined
}

/** The RPC layer's `unknown_session` — the one close error the service swallows. */
function isUnknownSession(error: unknown): boolean {
  if (typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'unknown_session') return true
  return error instanceof Error && error.message.includes('unknown_session')
}

/**
 * The delegation's session policy is ALWAYS auto-answer-on-arrival (`{auto, 0}`)
 * — the permission-mode axis is retired, so there is nothing to choose. The
 * bridge answers in place (no ledger entry, no `permission/request` frame);
 * `preferOnce` keeps a shared (non-A1) process from memorizing `allow_always`
 * across sessions, while an A1 ephemeral process dies with the session and
 * keeps the default priority.
 */
function autoPolicyFor(agentId: string): AcpDelegatePolicy {
  return { mode: 'auto', windowMs: 0, preferOnce: !isPerSessionAgent(agentId) }
}

/**
 * The register-ready tool definition (compiled JSON Schema + `output.render`,
 * the verified `virtualToolDefinition` shape — NOT the `defineTool` DSL).
 *
 * `mode` selects the shell's wording and output contract: `legacy` (default)
 * describes the synchronous full-text report; `native` describes the immediate
 * activation receipt whose answer arrives as the host's settlement
 * notification. The guidance rung bakes into the description; hot changes
 * re-register through `AcpDelegateRegistration`. The host budget is the FIXED
 * 24h absolute backstop (`DELEGATE_TIMEOUT_MAX_MS`) — on the legacy shell it
 * bounds execute itself; on the native shell execute returns at once and the
 * core's built-in `absoluteBudgetMs` timer bounds the detached run instead.
 * `off` still builds the base description — the builder never judges `off`;
 * registration decides whether to register.
 */
export function acpDelegateToolDefinition(opts: {
  guidance: DelegateGuidance
  execute: AcpDelegateExecute | AcpDelegateActivationExecute
  mode?: 'legacy' | 'native'
  /** The configured agents, described for the caller; absent = the short generic line. */
  roster?: readonly DelegateAgentDoc[]
}): {
  name: string
  description: string
  parameters: Record<string, unknown>
  output: { schema: Record<string, unknown>; render: (args: unknown, value: unknown) => Array<{ type: 'text'; text: string }> }
  timeoutMs: number
  execute: AcpDelegateExecute | AcpDelegateActivationExecute
} {
  const native = opts.mode === 'native'
  const base = native ? NATIVE_BASE_DESCRIPTION : BASE_DESCRIPTION
  const steering = opts.guidance === 'enhanced' || opts.guidance === 'force'
  const description = steering ? GUIDANCE_PREFIX + base : base
  return {
    name: 'acp_delegate',
    description,
    parameters: {
      type: 'object',
      properties: {
        task: { type: 'string', description: '完整任务描述（子智能体看不到本会话上下文）' },
        agent: { type: 'string', description: delegateAgentParamDescription(opts.roster) },
        cwd: { type: 'string', description: '工作目录；省略 = 继承调用会话工作区；显式指定须在该工作区或该 agent 的 allowedCwdRoots 内' },
        model: { type: 'string', description: '模型 id；省略 = 用子智能体委派配置中该 agent 的默认模型；显式指定而 agent 不提供时报错' },
        effort: { type: 'string', description: '思考等级；省略 = 用子智能体委派配置的默认值；不支持时自动丢弃并留痕' },
        mode: { type: 'string', description: '工作模式 id；省略 = 用子智能体委派配置的默认值；显式指定而 agent 不提供时报错' },
      },
      required: ['task'],
    },
    output: native
      ? {
        schema: {
          type: 'object',
          properties: {
            kind: { type: 'string', enum: ['activation', 'error'] },
            name: { type: 'string' },
            agent: { type: 'string' },
            error: { type: 'string' },
          },
          required: ['kind'],
        },
        render: (_args: unknown, value: unknown) => {
          const row = (typeof value === 'object' && value !== null ? value : {}) as { kind?: unknown; name?: unknown; agent?: unknown; error?: unknown; text?: unknown }
          if (row.kind === 'activation') {
            return [{ type: 'text', text: `已委派给 ACP agent ${String(row.agent ?? '')}：子智能体 ${String(row.name ?? '')} 已在后台开始执行。可继续做不相交的工作；只剩等待时结束本回合，完成后宿主会把它的答复作为通知送达本会话。` }]
          }
          if (row.kind === 'error') return [{ type: 'text', text: `acp_delegate 委派失败：${String(row.error ?? '')}` }]
          return [{ type: 'text', text: String(row.text ?? '') }]
        },
      }
      : {
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
    // Host cooperative budget: a FIXED 24h absolute backstop. On the legacy
    // shell it runs from execute start — a runaway loop that keeps producing
    // output never goes silent, so the rolling silence window alone cannot
    // stop it. On the native shell execute returns immediately and the core's
    // built-in absolute timer (absoluteBudgetMs) carries the same bound.
    timeoutMs: DELEGATE_TIMEOUT_MAX_MS,
    execute: opts.execute,
  }
}

/**
 * The core's settlement discriminator (constraint 17 / AGENTS/state.md §10):
 * ONE explicit string-literal union, first cause wins — a later cause never
 * overwrites it. The coexisting scheduling handles (queue promise, timer,
 * abort listener) stay handles: §10's exception covers them, not this outcome.
 */
type DelegateSettle = 'pending' | 'ended' | 'timed-out' | 'aborted' | 'prompt-error'

/** The terminal facts of one delegation run — the shells' shared vocabulary. */
export interface AcpDelegateSettlement {
  outcome: Exclude<DelegateSettle, 'pending'>
  agent: string
  /** The folded answer text WITHOUT any footer; '' when none was produced. */
  text: string
  /** The resolved session cwd; absent when no session ever started. */
  cwd?: string
  stopReason?: string
  turnError?: string
  /** The full `acp_delegate: …` failure message for a non-ended outcome. */
  error?: string
  /**
   * The merged degradation notes (agent-axis fallback + stale choice axes),
   * one Chinese line each joined into a single text; absent when nothing
   * degraded. The same text went to `host.notify` exactly once.
   */
  notes?: string
  refused: number
  autoAnswered: number
}

/**
 * One started delegation: the result promise NEVER rejects (every path —
 * completion, silence timeout, abort, dispose, even an unexpected core bug —
 * settles it), and `dispose` is idempotent, settling a pending run `aborted`.
 * The native provider maps this onto the host's never-reject `SubagentRun`;
 * the legacy shell awaits it and reports or throws.
 */
export interface AcpDelegateRunHandle {
  readonly agentId: string
  readonly result: Promise<AcpDelegateSettlement>
  dispose(): Promise<void>
}

/** The resolved call facts, before any session or queue work. */
export interface AcpDelegateResolved {
  agentId: string
  task: string
  /** args.cwd ?? the calling session workspace; undefined degrades to the agent default. */
  cwd: string | undefined
  /** The calling session workspace as the ONE extra root (empty when absent). */
  extraRoots: readonly string[]
  /** The EXPLICIT per-call choice axes (validated non-empty strings). */
  choices: DelegateChoiceSet
  /**
   * Agent-axis degradation notes (a stale delegate default falling back to
   * the global default); empty when nothing degraded. The choice axes add
   * their planner notes at run time.
   */
  notes: string[]
}

/**
 * The delegation core plus its two shells. Every failure surfaces with the
 * `acp_delegate: …` vocabulary — the legacy shell throws it (the host
 * normalizes a thrown execute into an `isError` tool result), the native
 * settlement carries it as diagnostic; the process never crashes.
 */
export class AcpDelegateService {
  /**
   * Defensive per-agent serial queues: non-A1 delegations to the SAME agent
   * id chain on one promise; different agents run in parallel; A1 (one process
   * per delegation) never queues. A tail never rejects, so one failed
   * delegation does not poison the chain behind it.
   */
  private readonly queues = new Map<string, Promise<void>>()

  constructor(private readonly host: AcpDelegateHost) {}

  /** The LEGACY synchronous shell: await the core, report the folded text. */
  execute: AcpDelegateExecute = async (args, exec) => {
    try {
      return legacyReport(await this.begin(args, exec).result)
    } catch (error) {
      throw new Error(prefixed(messageOf(error)))
    }
  }

  /**
   * Steps 1–3 without any side effect: parse, resolve the agent, compute the
   * effective cwd and extra roots. Throws the foreseeable `acp_delegate: …`
   * errors (bad task, unknown agent, no default) — the native execute calls
   * this BEFORE startActivation so refusals never mint a catalog row.
   */
  resolve(args: unknown, exec: AcpDelegateExecContext): AcpDelegateResolved {
    const row = (typeof args === 'object' && args !== null ? args : {}) as Record<string, unknown>
    const task = row.task
    if (typeof task !== 'string' || task.trim() === '') throw new Error('acp_delegate: task must be a non-empty string')
    const agentArg = row.agent
    if (agentArg !== undefined && typeof agentArg !== 'string') throw new Error('acp_delegate: agent must be a string')
    const cwd = row.cwd
    if (cwd !== undefined && typeof cwd !== 'string') throw new Error('acp_delegate: cwd must be a string')
    const choices: DelegateChoiceSet = {}
    for (const key of ['model', 'effort', 'mode'] as const) {
      const value = row[key]
      if (value === undefined) continue
      if (typeof value !== 'string' || value === '') throw new Error(`acp_delegate: ${key} must be a non-empty string`)
      choices[key] = value
    }
    const { agentId, notes } = this.resolveAgent(agentArg)
    // Workspace inheritance: an omitted cwd inherits the CALLING session's
    // workspace; that workspace is also the one extra root an explicit cwd is
    // validated against (the user picked it — the same authorization the chat
    // path's extraRoots carry, never a model-invented root). Without a usable
    // header cwd the delegation degrades to args.cwd ?? the agent default,
    // roots-only fence, no error.
    const sessionCwd = sessionWorkspaceOf(exec)
    return {
      agentId,
      task,
      cwd: cwd ?? sessionCwd,
      extraRoots: sessionCwd === undefined ? [] : [sessionCwd],
      choices,
      notes,
    }
  }

  /**
   * Start one delegation run and return its handle IMMEDIATELY (the native
   * provider's entry). Validation errors throw synchronously — a clean
   * failure before any resource exists. `absoluteBudgetMs` arms the built-in
   * absolute backstop timer (the native shell passes the fixed 24h; the legacy
   * shell omits it and keeps the host tool budget instead).
   */
  begin(args: unknown, exec: AcpDelegateExecContext, opts?: { absoluteBudgetMs?: number }): AcpDelegateRunHandle {
    const resolved = this.resolve(args, exec)
    const agentId = resolved.agentId
    // ONE internal abort channel: the outer exec/request signal forwards into
    // it, and dispose drives it too. The host detaches exec.signal after
    // publication (native seam), so the run must own its cancellation.
    const controller = new AbortController()
    const signal = controller.signal
    const outer = exec.signal
    const forward = (): void => { controller.abort() }
    if (outer !== undefined) {
      if (outer.aborted) controller.abort()
      else outer.addEventListener('abort', forward, { once: true })
    }
    let resolveResult!: (settlement: AcpDelegateSettlement) => void
    const result = new Promise<AcpDelegateSettlement>(resolve => { resolveResult = resolve })
    let published = false
    // External causes (dispose / absolute expiry) requested BEFORE the run
    // installs its settle — buffered, then drained in order at bind time.
    const pending: Array<{ cause: 'aborted' | 'timed-out'; failure?: unknown }> = []
    let fire: ((cause: 'aborted' | 'timed-out', failure?: unknown) => void) | undefined
    let budgetTimer: ReturnType<typeof setTimeout> | undefined
    const publish = (settlement: AcpDelegateSettlement): void => {
      if (published) return
      published = true
      clearTimeout(budgetTimer)
      outer?.removeEventListener('abort', forward)
      resolveResult(settlement)
    }
    const requestCause = (cause: 'aborted' | 'timed-out', failure?: unknown): void => {
      // Fire (or buffer) the cause FIRST, then abort: the abort-driven settle
      // is a no-op once a cause won, so an expiry is never misread as an abort.
      if (fire !== undefined) fire(cause, failure)
      else pending.push({ cause, failure })
      controller.abort()
    }
    if (opts?.absoluteBudgetMs !== undefined) {
      const budgetMs = opts.absoluteBudgetMs
      budgetTimer = setTimeout(() => {
        requestCause('timed-out', new Error(`acp_delegate: timed out after ${String(budgetMs)}ms absolute budget`))
      }, budgetMs)
    }
    const execution = (async () => {
      try {
        // A1: one child process per delegation — naturally parallel, no queue.
        if (!isPerSessionAgent(agentId)) {
          const previous = this.queues.get(agentId) ?? Promise.resolve()
          await this.waitQueued(previous, signal)
        }
        const settlement = await this.run(resolved, signal, {
          bind: fn => {
            fire = fn
            for (const cause of pending) fn(cause.cause, cause.failure)
            pending.length = 0
          },
        })
        publish(settlement)
      } catch (error) {
        // The queue wait's abort (or an unexpected core bug) lands here: a
        // buffered external cause outranks the queue-abort message, so an
        // expiry while queued still settles timed-out, never aborted.
        const buffered = pending[0]
        const outcome = buffered?.cause ?? (isAborted(signal) ? 'aborted' : 'prompt-error')
        const message = buffered?.failure !== undefined ? messageOf(buffered.failure) : messageOf(error)
        publish({ outcome, agent: agentId, text: '', refused: 0, autoAnswered: 0, error: prefixed(message) })
      }
    })()
    if (!isPerSessionAgent(agentId)) {
      // The tail settles (never rejects) when this execution settles, so the
      // next waiter proceeds even after a failure or a queue-abort.
      const tail = execution.then(() => {}, () => {})
      this.queues.set(agentId, tail)
      void tail.then(() => { if (this.queues.get(agentId) === tail) this.queues.delete(agentId) })
    }
    return {
      agentId,
      result,
      dispose: async () => {
        requestCause('aborted')
        await result
      },
    }
  }

  /**
   * Step 2: resolve the agent id; errors list the configured ids. The chain:
   * explicit arg (must be configured) → the delegate default-agent setting
   * (ONLY while still configured; a deleted target degrades one level with a
   * note) → the plugin-global default (already filtered for deleted agents)
   * → the no-default error. A stale delegate default with no global fallback
   * is the plain no-default error — no note without a fallback to name.
   */
  private resolveAgent(agentArg: string | undefined): { agentId: string; notes: string[] } {
    const configured = this.host.agents()
    const ids = configured.map(agent => agent.id).join(', ')
    if (agentArg !== undefined) {
      if (!configured.some(agent => agent.id === agentArg)) {
        throw new Error(`acp_delegate: unknown agent "${agentArg}" (configured: ${ids})`)
      }
      return { agentId: agentArg, notes: [] }
    }
    const delegateDefault = this.host.delegateConfig().defaultAgent
    if (delegateDefault !== undefined && configured.some(agent => agent.id === delegateDefault)) {
      return { agentId: delegateDefault, notes: [] }
    }
    const fallback = this.host.defaultAgent()
    if (fallback !== undefined) {
      return {
        agentId: fallback,
        notes: delegateDefault === undefined ? [] : [`默认 agent「${delegateDefault}」已失效，改用全局默认「${fallback}」`],
      }
    }
    throw new Error(`acp_delegate: no default agent configured; name one explicitly (configured: ${ids})`)
  }

  /**
   * The queue wait observes the run's signal: the budget runs from the call
   * start, so a delegation whose turn in the queue never comes leaves the
   * queue and throws instead of burning the whole budget silently.
   */
  private async waitQueued(previous: Promise<void>, signal: AbortSignal): Promise<void> {
    if (isAborted(signal)) throw new Error('acp_delegate: aborted while queued')
    await new Promise<void>((resolve, reject) => {
      const onAbort = (): void => { reject(new Error('acp_delegate: aborted while queued')) }
      signal.addEventListener('abort', onAbort, { once: true })
      const done = (): void => { signal.removeEventListener('abort', onAbort); resolve() }
      // A failed predecessor must not fail the waiter: the queue drains on.
      previous.then(done, done)
    })
  }

  /**
   * Apply one planned choice write through the host's existing RPC face.
   * The bridge folds a config-option answer back into the session snapshot
   * (constraint 4), which is what makes the effort re-read authoritative.
   */
  private async applyChoiceWrite(sessionId: string, write: DelegateChoiceWrite): Promise<void> {
    if (write.kind === 'mode') await this.host.setMode(sessionId, write.modeId)
    else await this.host.setConfigOption(sessionId, write.configId, write.value)
  }

  /**
   * Steps 4–10: session, policy, fold, prompt, bounded settlement. Resolves
   * the terminal facts; the first settlement cause wins and every later event
   * is a no-op. Only an unexpected bug (or a close failure after a normal end)
   * throws — the launcher flattens it into a prompt-error settlement.
   */
  private async run(resolved: AcpDelegateResolved, signal: AbortSignal, external: {
    bind(fn: (cause: 'aborted' | 'timed-out', failure?: unknown) => void): void
  }): Promise<AcpDelegateSettlement> {
    const { agentId, task, cwd, extraRoots } = resolved
    const config = this.host.delegateConfig()
    // Degradation trail: the agent-axis notes from resolve plus the choice
    // planners' notes, merged into ONE notice and settlement fact at the end.
    const notes: string[] = [...resolved.notes]
    // ---- settlement machinery (synchronous, before any await) ----
    let text = ''
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
    const settle = (cause: Exclude<DelegateSettle, 'pending'>, failure?: unknown): void => {
      if (outcome !== 'pending') return
      outcome = cause
      promptFailure = failure
      resolveEnd()
    }
    external.bind(settle)
    let sessionId: string | undefined
    let resolvedCwd: string | undefined
    let closed = false
    let promptSent = false
    let silenceTimer: ReturnType<typeof setTimeout> | undefined
    let unsubscribe: (() => void) | undefined
    const onAbort = (): void => { settle('aborted') }
    const closeOnce = async (): Promise<void> => {
      if (closed || sessionId === undefined) return
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
    // ---- rolling silence window ----
    // ONE window, renewed by activity — the same idea as the main session's
    // turn watchdog (constraint 23): only silence counts toward the timeout.
    // Every hub event of THIS session re-arms it: any `session/update` kind
    // (tool_call / tool_call_update progress frames included, not just message
    // chunks) and `permission/expired` settlements. Delegation deliberately
    // keeps a SINGLE window — tool progress frames renew it, so a working
    // agent is never cut off mid-task BY THE SILENCE WINDOW. The fixed 24h
    // absolute backstop (the host tool budget on the legacy shell, the core's
    // absoluteBudgetMs timer on the native one) still applies against runaway
    // loops that never go silent. Never add a second window.
    const touchSilence = (): void => {
      // After settlement a late event must not re-arm: no dangling timer may
      // fire a second settle (first cause wins).
      if (outcome !== 'pending') return
      if (silenceTimer !== undefined) clearTimeout(silenceTimer)
      silenceTimer = setTimeout(() => { settle('timed-out') }, config.timeoutMs)
    }
    // Shared by the live fold and the transcript fallback: seq dedupe, skip
    // the agent's OWN subagent prose (parentToolCallId), accumulate in full.
    const collect = (seq: number, update: unknown): void => {
      if (seenSeq.has(seq)) return
      seenSeq.add(seq)
      if (typeof update !== 'object' || update === null) return
      const row = update as Record<string, unknown>
      if (row.sessionUpdate !== 'agent_message_chunk') return
      if (codebuddyMetaOf(update)?.parentToolCallId !== undefined) return
      const chunk = chunkTextOf(row.content)
      if (chunk === '') return
      text += chunk
    }
    try {
      if (isAborted(signal)) settle('aborted')
      if (outcome === 'pending') {
        try {
          // Opts ALWAYS ride along: the bridge validates the cwd BEFORE any
          // spawn and aligns the agent process with the validated session cwd
          // (codebuddy fixes its workspace at process start). The degraded
          // path passes an empty extraRoots list — roots-only fence, same
          // validation.
          const started = await this.host.startSession(agentId, cwd, { extraRoots, alignSpawnCwd: true })
          sessionId = started.sessionId
          resolvedCwd = started.cwd
        } catch (error) {
          // cwd_denied / bad_cwd / no_cwd pass through verbatim, with the agent id.
          settle('prompt-error', new Error(`acp_delegate: ${messageOf(error)} (agent ${agentId})`))
        }
      }
      if (outcome === 'pending' && sessionId !== undefined) {
        // The session policy MUST land before the prompt. It is always
        // auto-answer-on-arrival; the bridge settles asks in place.
        try {
          this.host.setPermissionPolicy(sessionId, autoPolicyFor(agentId))
        } catch (error) {
          settle('prompt-error', error)
        }
        if (isAborted(signal)) settle('aborted')
      }
      if (outcome === 'pending' && sessionId !== undefined) {
        // The four choice axes, validated against the LIVE session/new answer
        // (never the catalog): explicit arg > configured per-agent default >
        // unset. A stale EXPLICIT model/mode is fatal (nothing applied, no
        // prompt); a stale CONFIGURED value degrades to unset with a note;
        // effort is never fatal. Mode writes precede model writes, and the
        // effort plan re-reads the REFRESHED options after the model write
        // (a model switch can change which efforts exist). A write RPC that
        // throws is a RUNTIME failure — error settlement, never a fallback.
        const configured = config.agentDefaults[agentId] ?? {}
        const explicit = resolved.choices
        let live = this.host.sessionOptions(sessionId) ?? {}
        const plan = planDelegateModeAndModel({ agentId, explicit, configured, live })
        notes.push(...plan.notes)
        if (plan.fatal !== undefined) {
          settle('prompt-error', new Error(plan.fatal))
        } else {
          try {
            for (const write of plan.writes) {
              if (outcome !== 'pending') break
              await this.applyChoiceWrite(sessionId, write)
            }
            if (outcome === 'pending' && (explicit.effort ?? configured.effort) !== undefined) {
              live = this.host.sessionOptions(sessionId) ?? {}
              const effortPlan = planDelegateEffort({ agentId, explicit, configured, live })
              notes.push(...effortPlan.notes)
              if (effortPlan.write !== undefined) await this.applyChoiceWrite(sessionId, effortPlan.write)
            }
          } catch (error) {
            settle('prompt-error', new Error(describeError(error)))
          }
        }
        if (isAborted(signal)) settle('aborted')
      }
      if (outcome === 'pending' && sessionId !== undefined) {
        // Subscribe BEFORE the prompt so no chunk of the turn can slip past.
        unsubscribe = this.host.hub.subscribe(event => {
          switch (event.type) {
            case 'session/update':
              if (event.sessionId !== sessionId) return
              // ANY kind is activity and renews the window; collect() keeps
              // only the answer text.
              touchSilence()
              collect(event.seq, event.update)
              return
            // No `permission/request` case: the policy is auto+0, so the bridge
            // answers every ask in place and never broadcasts a request frame.
            case 'permission/expired':
              if (event.sessionId !== sessionId) return
              // A settled ask is activity too — it renews the silence window.
              touchSilence()
              // `selected` = auto-answered; anything else (the degraded abort
              // when no legal option can be picked) = refused.
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
        signal.addEventListener('abort', onAbort, { once: true })
        if (isAborted(signal)) onAbort()
        // Arm the silence window BEFORE the prompt goes out (a prompt that
        // never answers is silence too); activity renews it.
        touchSilence()
        promptSent = true
        // A rejected prompt (turn_in_flight, agent died, …) settles the wait
        // too; its error surfaces after the bounded cleanup below.
        void this.host.prompt(sessionId, task).then(
          () => {},
          (error: unknown) => { settle('prompt-error', error) },
        )
      }
      await endSignal
      clearTimeout(silenceTimer)
      signal.removeEventListener('abort', onAbort)
      if (outcome !== 'ended') {
        // Self-settling failure path: cancel (only a dispatched prompt can be
        // cancelled) THEN close, and never wait for a turn/end afterwards
        // (close does not emit one). Each cleanup step is awaited once,
        // bounded by the host's own close/cancel races.
        if (sessionId !== undefined) {
          if (promptSent) { try { await this.host.cancel(sessionId) } catch { /* bounded cleanup */ } }
          await closeQuietly()
        }
      } else if (sessionId !== undefined) {
        // Text fallback — read the transcript ONCE, before close (close
        // deletes the record; a later read would only throw unknown_session).
        if (text === '') {
          try {
            const dump = this.host.transcript(sessionId, 0)
            for (const entry of dump.entries) collect(entry.seq, entry.update)
          } catch { /* fail-open: the placeholder reports the empty answer */ }
        }
        // Normal end: close exactly once, then unsubscribe in finally.
        await closeOnce()
      }
    } catch (error) {
      if (outcome === 'ended') {
        // A close failure after a normal end surfaces like the legacy shell
        // always did: the launcher flattens it into a prompt-error settlement.
        clearTimeout(silenceTimer)
        signal.removeEventListener('abort', onAbort)
        throw error
      }
      settle('prompt-error', error)
      clearTimeout(silenceTimer)
      signal.removeEventListener('abort', onAbort)
      if (sessionId !== undefined) {
        if (promptSent) { try { await this.host.cancel(sessionId) } catch { /* bounded cleanup */ } }
        await closeQuietly()
      }
    } finally {
      clearTimeout(silenceTimer)
      signal.removeEventListener('abort', onAbort)
      unsubscribe?.()
    }
    const settlement: AcpDelegateSettlement = {
      outcome: outcome === 'pending' ? 'prompt-error' : outcome,
      agent: agentId,
      text,
      refused,
      autoAnswered,
    }
    if (resolvedCwd !== undefined) settlement.cwd = resolvedCwd
    if (stopReason !== undefined) settlement.stopReason = stopReason
    if (turnError !== undefined) settlement.turnError = turnError
    if (settlement.outcome === 'aborted') settlement.error = 'acp_delegate: aborted'
    else if (settlement.outcome === 'timed-out') {
      settlement.error = promptFailure !== undefined
        ? prefixed(messageOf(promptFailure))
        : `acp_delegate: timed out after ${String(config.timeoutMs)}ms of silence`
    } else if (settlement.outcome === 'prompt-error') {
      settlement.error = prefixed(messageOf(promptFailure))
    }
    if (notes.length > 0) {
      // ONE merged notice per run, and the same text on the settlement so
      // both shells can report it. The note belongs to the DELEGATED agent,
      // not the global default. A broken sink never masks the outcome.
      settlement.notes = notes.join('；')
      try { this.host.notify?.(settlement.notes, agentId) } catch { /* the trail is best-effort */ }
    }
    return settlement
  }
}

/**
 * The LEGACY report: the folded body plus the footer the model reads. The
 * resolved cwd sits between the agent id and the terminal fact, so the caller
 * knows WHERE the work ran. Non-ended outcomes throw the settlement's message
 * — byte-identical to the pre-split synchronous service.
 */
function legacyReport(settlement: AcpDelegateSettlement): AcpDelegateResult {
  if (settlement.outcome !== 'ended') throw new Error(settlement.error ?? `acp_delegate: ${settlement.outcome}`)
  const body = settlement.text === '' ? '(the agent returned no text)' : settlement.text
  let footer = `\n\n— acp_delegate · ${settlement.agent} · cwd=${settlement.cwd ?? ''} · ${settlement.stopReason ?? settlement.turnError ?? 'unknown'}`
  if (settlement.refused > 0) footer += ` · 拒绝 ${String(settlement.refused)} 个审批`
  if (settlement.autoAnswered > 0) footer += ` · 自动代答 ${String(settlement.autoAnswered)} 个`
  if (settlement.notes !== undefined) footer += `\n备注：${settlement.notes}`
  const result: AcpDelegateResult = { text: body + footer, agent: settlement.agent }
  if (settlement.stopReason !== undefined) result.stopReason = settlement.stopReason
  if (settlement.turnError !== undefined) result.error = settlement.turnError
  if (settlement.notes !== undefined) result.notes = settlement.notes
  return result
}