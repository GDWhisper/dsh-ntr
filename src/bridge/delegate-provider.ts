/**
 * Native subagent activation for `acp_delegate`
 * (docs/plan/acp-delegate-native-subagent.md §2 / §4 / §6).
 *
 * On a host with the `ctx.subagents` seam the plugin registers the `acp`
 * SubagentProvider (one-shot external leaf: `start` only, no
 * `prepareContinuable`, all start capabilities false) and the tool's execute
 * becomes the ASYNC shell: validate → `startActivation` → return the name at
 * once. The answer is delivered by the HOST's settlement notification into
 * the parent session — the tool never awaits the result (awaiting would
 * double-deliver the content and occupy the parent turn for the whole child
 * run).
 *
 * The provider reuses the delegation core (`AcpDelegateService.begin`): the
 * agent id rides in the activation label (impl/delegate-label.ts), the cwd
 * arrives absolute from the host, and the calling workspace is re-read from
 * `request.parent`'s session header for the extra-root fence. The core's
 * rolling silence window plus the built-in 24h absolute timer bound the run;
 * `request.signal` (the host's OWN controller, detached from exec.signal after
 * publication) and `dispose` both settle it `aborted`. The settlement wrapper
 * below guarantees the published result NEVER rejects and never dangles —
 * `waitForTreeWork` and the shared capacity slot depend on it.
 *
 * Host packages are TYPE-ONLY imports (the index.ts pattern): zero runtime
 * value imports, every capability arrives through ctx or the injected service.
 */
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {
  ResolvedSubagentStartRequest,
  SubagentActivation,
  SubagentActivationSpec,
  SubagentProvider,
  SubagentResult,
  SubagentRun,
} from '@deepseek-ai/dsh-subagent'
import { randomUUID } from '../ids.ts'
import { agentIdFromDelegateLabel, delegateChoicesFromLabel, delegateLabel, mergeDelegateDiagnostic, truncateDelegateDiagnostic } from '../impl.ts'
import { DELEGATE_TIMEOUT_MAX_MS } from '../protocol.ts'
import type {
  AcpDelegateActivationExecute,
  AcpDelegateRunHandle,
  AcpDelegateService,
  AcpDelegateSettlement,
} from './delegate-service.ts'

/** The registry name the tool's activation spec selects. */
export const ACP_SUBAGENT_PROVIDER = 'acp'

/**
 * The out-of-process capability advertisement: NONE (a hand-written frozen
 * literal, the host's NO_START_CAPABILITIES shape). A child in another process
 * cannot honor parent-enforced start features; the service rejects any
 * request needing them (UNSUPPORTED_CAPABILITY) before start runs — so the
 * activation spec must never carry agentOptions/outputSchema/maxDepth/
 * agentPreset.
 */
const NO_START_CAPABILITIES = Object.freeze({
  agentOptions: false,
  agentPreset: false,
  outputSchema: false,
  depthLimit: false,
})

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** The text blocks of a prompt, joined in order (the task is one text block). */
function promptTextOf(prompt: readonly ContentBlock[]): string {
  return prompt
    .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
    .map(block => block.text)
    .join('\n')
}

/** Non-empty folded text as the host's output blocks; silence reads as []. */
function outputBlocksOf(text: string): Array<{ type: 'text'; text: string }> {
  return text === '' ? [] : [{ type: 'text', text }]
}

/**
 * Map the ACP turn's OWN stop reason onto the host's vocabulary
 * (`dsh-subagent` · SubagentStopReasonMap). `refusal` and `max_tokens` are the
 * agent's verdicts, and the host already names them in the settlement summary
 * ("declined the task" / "ran out of room before it finished"), so collapsing
 * them into `completed` tells the parent the opposite of what happened; a
 * `cancelled` turn is unfinished, not a success. Everything else — `end_turn`,
 * and `max_turn_requests` which has no host counterpart — reads as
 * `completed`, with the latter named in the diagnostic
 * ({@link unmappedStopNote}).
 */
function hostStopReasonOf(stopReason: string | undefined): SubagentResult['stopReason'] {
  switch (stopReason) {
    case 'refusal': return 'refusal'
    case 'max_tokens': return 'max-tokens'
    case 'cancelled': return 'aborted'
    default: return 'completed'
  }
}

/**
 * The terminal state one ended settlement maps onto. The ACP turn's own reason
 * wins whenever it names something (refusal / token ceiling / cancellation), but
 * an ERROR-ONLY turn/end — the watchdog's forced close, a dead process, a
 * rejected prompt — carries a failure with no stop reason of its own, and the
 * host's `error` is the honest terminal there: calling it `completed` would be
 * the very flattening this mapping exists to remove.
 */
function hostTerminalOf(settlement: AcpDelegateSettlement): SubagentResult['stopReason'] {
  const mapped = hostStopReasonOf(settlement.stopReason)
  return mapped === 'completed' && settlement.turnError !== undefined ? 'error' : mapped
}

/**
 * The one ending the host's vocabulary cannot express. `max_turn_requests` is
 * a real ending (the child hit its own turn-request ceiling), so the run is not
 * an error — but the answer may be cut short while the summary says "finished"
 * either way, so the plugin names it.
 */
function unmappedStopNote(stopReason: string | undefined): string | undefined {
  if (stopReason === undefined || stopReason === '' || stopReason === 'end_turn') return undefined
  if (hostStopReasonOf(stopReason) !== 'completed') return undefined
  return `ACP 停因 ${stopReason}：这一回合不是正常结束，答复可能不完整`
}

/**
 * The delegation's ask ledger as ONE line. Every permission ask a child hits is
 * answered by its own session policy (`auto` + zero window,
 * delegate-service.ts · autoPolicyFor), so nobody else ever sees them: this
 * settlement is the parent's only notice that the child cleared N gates by
 * itself, and `refused` is the one case the child actually LOST a tool call to
 * (the ask could not be auto-picked and degraded to a refusal). Absent when the
 * child never asked.
 */
function askCountsNote(autoAnswered: number, refused: number): string | undefined {
  if (autoAnswered <= 0 && refused <= 0) return undefined
  const parts: string[] = []
  if (autoAnswered > 0) parts.push(`自动代答 ${String(autoAnswered)} 个`)
  if (refused > 0) parts.push(`拒绝 ${String(refused)} 个`)
  return `委派会话的审批：${parts.join('、')}`
}

/** The diagnostic's leading facts (failure detail, ending note) as one text. */
function leadingFacts(...facts: Array<string | undefined>): string | undefined {
  const kept = facts.filter((fact): fact is string => fact !== undefined && fact !== '')
  return kept.length === 0 ? undefined : kept.join('\n')
}

/**
 * The RESERVED side of the merge: the degradation notes plus the ask counts.
 * Counts ride this side (impl/delegate-label.ts · mergeDelegateDiagnostic keeps
 * a byte budget for it) so an extreme failure text can never truncate them
 * away — they are the smallest and least recoverable fact the settlement adds.
 */
function reservedFacts(notes: string | undefined, counts: string | undefined): string | undefined {
  const kept = [notes, counts].filter((fact): fact is string => fact !== undefined && fact !== '')
  return kept.length === 0 ? undefined : kept.join('；')
}

/**
 * Map one core settlement onto the host's terminal result (plan §4):
 * ended → its own ending ({@link hostTerminalOf}), aborted → aborted,
 * timed-out / prompt-error → error. Each carries ONE bounded diagnostic
 * (impl/delegate-label.ts · mergeDelegateDiagnostic, ≤4096 UTF-8 bytes, notes
 * reserved) made of the failure detail and the unnameable ending up front and
 * the notes with the ask counts on the reserved side; all-empty → no diagnostic
 * at all. Partial folded text rides along on every outcome (the host's own
 * cancel path keeps its output snapshot too); a normal end with no text keeps
 * the legacy placeholder so the parent still reads a fact instead of an empty
 * notification. No footer is written into output — the host's settlement
 * summary already names the child and its stop reason, and the host appends
 * this diagnostic on EVERY terminal state (`dsh-subagent` ·
 * createSettlementMessage), which is what carries the ask counts to a
 * `completed` parent at all; the plugin never double-writes the catalog or the
 * record stream.
 */
function resultOfSettlement(settlement: AcpDelegateSettlement): SubagentResult {
  const counts = askCountsNote(settlement.autoAnswered, settlement.refused)
  switch (settlement.outcome) {
    case 'ended': {
      const text = settlement.text === '' ? '(the agent returned no text)' : settlement.text
      const result: SubagentResult = {
        output: [{ type: 'text', text }],
        stopReason: hostTerminalOf(settlement),
      }
      // A watchdog error-only turn/end still carries the agent's failure detail.
      const diagnostic = mergeDelegateDiagnostic(
        leadingFacts(settlement.turnError, unmappedStopNote(settlement.stopReason)),
        reservedFacts(settlement.notes, counts),
      )
      return diagnostic === undefined ? result : { ...result, diagnostic }
    }
    case 'aborted': {
      const result: SubagentResult = { output: outputBlocksOf(settlement.text), stopReason: 'aborted' }
      const diagnostic = mergeDelegateDiagnostic(undefined, reservedFacts(settlement.notes, counts))
      return diagnostic === undefined ? result : { ...result, diagnostic }
    }
    case 'timed-out':
    case 'prompt-error':
      return {
        output: outputBlocksOf(settlement.text),
        stopReason: 'error',
        diagnostic: mergeDelegateDiagnostic(
          leadingFacts(settlement.error ?? `acp_delegate: ${settlement.outcome}`),
          reservedFacts(settlement.notes, counts),
        ) as string,
      }
  }
}

/**
 * The never-reject settlement wrapper: the core's result promise already
 * settles on every path, and this wrapper flattens even an infrastructure
 * rejection into `stopReason: 'error'` with a bounded diagnostic — a published
 * run result that rejects or dangles would wedge the host's `waitForTreeWork`
 * and leak the shared capacity slot.
 */
function settleDelegateRun(handle: AcpDelegateRunHandle): Promise<SubagentResult> {
  return handle.result.then(resultOfSettlement, (error: unknown): SubagentResult => ({
    output: [],
    stopReason: 'error',
    diagnostic: truncateDelegateDiagnostic(messageOf(error)),
  }))
}

/**
 * The `acp` provider: one external one-shot leaf per activation. `start`
 * throws for foreseeable refusals (no agent id in the label, empty prompt, an
 * agent deleted since the tool's pre-validation) — a clean failure: the host
 * writes no catalog row and releases the capacity slot. Everything after the
 * handle is published settles through `result`, never through a rejection.
 */
export class AcpSubagentProvider implements SubagentProvider {
  readonly name = ACP_SUBAGENT_PROVIDER
  readonly capabilities = NO_START_CAPABILITIES
  /** The child sees ONLY the task text — never the parent's turn prefix. */
  readonly inheritsParentContext = false

  constructor(private readonly deps: { service: AcpDelegateService }) {}

  async start(request: ResolvedSubagentStartRequest): Promise<SubagentRun> {
    const agentId = agentIdFromDelegateLabel(request.label ?? '')
    if (agentId === undefined) throw new Error('acp: delegate activation label carries no agent id')
    const task = promptTextOf(request.prompt)
    if (task.trim() === '') throw new Error('acp: delegate activation prompt carries no text')
    // The core re-reads the live delegate config (silence window) and the
    // calling workspace from request.parent's session header (extra roots);
    // request.cwd is already absolute (the host resolved it). The built-in
    // 24h absolute timer replaces the legacy host tool budget, which cannot
    // cover a run detached from its tool call. The explicit choice axes ride
    // in the label carrier (a malformed one already failed the id decode).
    const handle = this.deps.service.begin(
      { task, agent: agentId, cwd: request.cwd, ...(delegateChoicesFromLabel(request.label ?? '') ?? {}) },
      { signal: request.signal, agent: request.parent },
      { absoluteBudgetMs: DELEGATE_TIMEOUT_MAX_MS },
    )
    return {
      // SessionId is a pure compile-time brand; the host checks uniqueness
      // across its three tables and disposes a duplicate (DUPLICATE_CHILD).
      id: randomUUID() as SessionId,
      result: settleDelegateRun(handle),
      dispose: () => handle.dispose(),
    }
  }
}

/**
 * The structural `ctx.subagents` face this integration needs (fake-friendly,
 * probe-checked): provider registration plus the managed activation entry.
 */
export interface DelegateSubagentsLike {
  registerProvider(provider: SubagentProvider): unknown
  startActivation(spec: SubagentActivationSpec): Promise<SubagentActivation>
}

/**
 * Surface a refusal with its typed code: the host throws SubagentError
 * (ACTIVATION_LIMIT_REACHED / UNAUTHORIZED / NO_PROVIDER / …) whose message
 * alone may not name the code the model must react to.
 */
function describeActivationError(error: unknown): string {
  const code = (typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined)
  const message = messageOf(error)
  return typeof code === 'string' && code !== '' && !message.includes(code) ? `${code}: ${message}` : message
}

/**
 * The ASYNC execute shell (plan §2): pre-validate the foreseeable errors
 * (task/agent/cwd shape, agent resolution) BEFORE any activation, then start
 * the external child and return its name IMMEDIATELY — never awaiting the
 * receipt's result. `delivery: 'parent'` is the catalog-row precondition and
 * the settlement-notification route; the label carries the per-call agent
 * choice (the request shape has no custom fields). Every refusal becomes an
 * explicit `{kind:'error'}` the model can read, never a thrown execute.
 */
export function acpDelegateActivationExecute(deps: {
  service: AcpDelegateService
  subagents: DelegateSubagentsLike
}): AcpDelegateActivationExecute {
  return async (args, exec) => {
    let agentId = ''
    try {
      const resolved = deps.service.resolve(args, exec)
      agentId = resolved.agentId
      if (exec.agent === undefined) {
        throw new Error('acp_delegate: activation requires the calling agent (host exec.agent is absent)')
      }
      const spec: SubagentActivationSpec = {
        provider: ACP_SUBAGENT_PROVIDER,
        label: delegateLabel(resolved.agentId, resolved.task, resolved.choices),
        prompt: [{ type: 'text', text: resolved.task }],
        // The exact live calling agent — the host's authorization checks
        // identity, not a copy. exec.agent IS that instance at runtime.
        parent: exec.agent as unknown as Agent,
        signal: exec.signal ?? new AbortController().signal,
        delivery: 'parent',
        ...(resolved.cwd === undefined ? {} : { cwd: resolved.cwd }),
      }
      const receipt = await deps.subagents.startActivation(spec)
      return { kind: 'activation', name: receipt.name, agent: resolved.agentId }
    } catch (error) {
      return { kind: 'error', error: describeActivationError(error), ...(agentId === '' ? {} : { agent: agentId }) }
    }
  }
}