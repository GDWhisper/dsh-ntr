/**
 * Structured failure & quota resolution for Antigravity turns, shared by the
 * chat plane (`BridgeManager.streamPrompt`) and the `/acp` RPC plane
 * (`BridgeRpcService.sendPrompt`).
 *
 * Keeps `manager.ts` and `bridge-rpc-service.ts` free of duplicated DB fallback
 * logic and within their baseline line budgets.
 */
import type { EventHub } from '../impl.ts'
import type { AcpAgentDef, AgentRefusalDetail } from '../protocol.ts'
import { readAgyDbErrorAfter, readAgyDbLastStepIndex, type AgyDbStepFailure } from './agy-session-db.ts'
import { agyStoreRoot, isAntigravityAgent } from './agy-transcript.ts'
import { describeError } from './errors.ts'
import { agentRefusalDetail, rateLimitedTurnError } from './shape.ts'

export interface AgyStoreContext {
  isAntigravity: boolean
  storeRoot?: string
}

export interface AgyTurnBaseline {
  storeRoot: string
  acpSessionId: string
  stepIndex: number
}

export type ResolvedPromptFailure =
  | { kind: 'quota'; refusal: AgentRefusalDetail; turnError: string }
  | { kind: 'error'; message: string; code?: string }

/** Compute Antigravity store identity + root using optional test probe override. */
export function resolveAgyStoreContext(
  def: AcpAgentDef | undefined,
  probe?: { isAgent(def: AcpAgentDef): boolean; storeRoot(): string | undefined },
): AgyStoreContext {
  if (def === undefined) return { isAntigravity: false }
  if (probe !== undefined) {
    return probe.isAgent(def)
      ? { isAntigravity: true, storeRoot: probe.storeRoot() }
      : { isAntigravity: false }
  }
  return isAntigravityAgent(def)
    ? { isAntigravity: true, storeRoot: agyStoreRoot(def) ?? undefined }
    : { isAntigravity: false }
}

/**
 * Sample the current `steps.idx` baseline before `runPrompt` starts.
 * When `.db` has not been created yet (first turn of a new session), returns
 * `-1` so any newly created error step at `idx >= 0` is detected after settle.
 */
export function sampleAgyDbBaseline(
  ctx: AgyStoreContext,
  acpSessionId: string,
): AgyTurnBaseline | undefined {
  if (!ctx.isAntigravity || ctx.storeRoot === undefined || ctx.storeRoot === '') return undefined
  const idx = readAgyDbLastStepIndex(ctx.storeRoot, acpSessionId)
  return { storeRoot: ctx.storeRoot, acpSessionId, stepIndex: idx ?? -1 }
}

function failureFromDbStep(
  agentId: string,
  step: AgyDbStepFailure,
  hub: EventHub,
): ResolvedPromptFailure {
  if (step.kind === 'quota') {
    const refusal: AgentRefusalDetail = { kind: 'quota', message: step.message }
    return {
      kind: 'quota',
      refusal,
      turnError: rateLimitedTurnError(agentId, refusal),
    }
  }
  if (step.kind === 'validation') {
    hub.broadcast({ type: 'agent/notice', agentId, level: 'error', text: step.message })
    return { kind: 'error', message: step.message, code: 'VALIDATION_REQUIRED' }
  }
  return {
    kind: 'error',
    message: step.message,
    ...(step.statusName === undefined ? {} : { code: step.statusName }),
  }
}

/**
 * Inspect wire refusal `_meta` first, falling back to new `step_type = 17`
 * entries in Antigravity's read-only session DB when a turn gave no prose (or
 * returned `stopReason: 'refusal'`). Non-error turns that delivered assistant
 * prose perform zero extra DB reads (`shouldInspectDb === false`).
 */
export function resolveAgyTurnFailureFromResponse(
  agentId: string,
  baseline: AgyTurnBaseline | undefined,
  result: { stopReason?: string; meta?: unknown },
  shouldInspectDb: boolean,
  hub: EventHub,
): ResolvedPromptFailure | undefined {
  const wireRefusal = result.stopReason === 'refusal' ? agentRefusalDetail(result.meta) : undefined
  if (wireRefusal?.kind === 'quota') {
    return {
      kind: 'quota',
      refusal: wireRefusal,
      turnError: rateLimitedTurnError(agentId, wireRefusal),
    }
  }
  if (!shouldInspectDb && result.stopReason !== 'refusal') return undefined
  if (baseline === undefined) return undefined
  const dbFailure = readAgyDbErrorAfter(baseline.storeRoot, baseline.acpSessionId, baseline.stepIndex)
  if (dbFailure === undefined) return undefined
  return failureFromDbStep(agentId, dbFailure, hub)
}

/**
 * Upgrade a rejected prompt error (`runPrompt().catch`) with Antigravity's
 * structured `step_type = 17` failure if one landed after the baseline.
 */
export function resolveAgyTurnFailureFromRejection(
  agentId: string,
  baseline: AgyTurnBaseline | undefined,
  error: unknown,
  hub: EventHub,
): ResolvedPromptFailure {
  if (baseline !== undefined) {
    const dbFailure = readAgyDbErrorAfter(baseline.storeRoot, baseline.acpSessionId, baseline.stepIndex)
    if (dbFailure !== undefined) return failureFromDbStep(agentId, dbFailure, hub)
  }
  return { kind: 'error', message: describeError(error) }
}
