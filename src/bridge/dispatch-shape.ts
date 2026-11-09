import type { SubagentRecord, SubagentStatus } from '../protocol.ts'
import { MAX_SUBAGENT_RECORDS } from '../protocol.ts'
import type { BackgroundDispatch } from './types.ts'
import { subagentDispatchDeclaresIdentity, subagentDispatchLabel } from './shape.ts'

/** Where one dispatch stands, derived from the wire facts of its own record. */
export function dispatchStatus(dispatch: BackgroundDispatch): SubagentStatus {
  if (dispatch.terminal !== undefined) return dispatch.terminal
  if (dispatch.sawWorkerUpdate || dispatch.detached || dispatch.status === 'in_progress') return 'running'
  return 'pending'
}

/** Build the persisted lifecycle record for one dispatch. */
export function dispatchRecord(dispatch: BackgroundDispatch, dshSessionId: string): SubagentRecord {
  return {
    childId: `acp:${dispatch.toolCallId}`,
    dshSessionId,
    toolCallId: dispatch.toolCallId,
    label: dispatch.catalogLabel,
    ...(dispatch.subagentType === undefined ? {} : { type: dispatch.subagentType }),
    status: dispatchStatus(dispatch),
    startedAt: dispatch.startedAt,
    lastActivityAt: dispatch.lastActivityAt,
    ...(dispatch.endedAt === undefined ? {} : { endedAt: dispatch.endedAt }),
    ...(dispatch.error === undefined ? {} : { error: dispatch.error }),
    counts: { ...dispatch.counts },
  }
}

/**
 * Take a better label from a later frame of the SAME dispatch call. A frame
 * with no identity and no title must not downgrade what is already known.
 */
export function refreshSubagentDispatchLabel(dispatch: BackgroundDispatch, update: Record<string, unknown>): void {
  const identified = subagentDispatchDeclaresIdentity(update)
  if (!identified && dispatch.catalogLabelIdentified) return
  const title = update.title
  if (!identified && !(typeof title === 'string' && title !== '')) return
  dispatch.catalogLabel = subagentDispatchLabel(update)
  dispatch.catalogLabelIdentified = identified
}

/**
 * Bound the session map. Terminal rows are history for the record view (the
 * detail read uses the transcript, not this map), so evicting the oldest
 * finished one keeps a long-lived conversation from growing without limit.
 */
export function pruneSessionDispatches(dispatches: Map<string, BackgroundDispatch>): void {
  if (dispatches.size <= MAX_SUBAGENT_RECORDS) return
  for (const [id, dispatch] of dispatches) {
    if (dispatch.terminal !== undefined) {
      dispatches.delete(id)
      return
    }
  }
}
