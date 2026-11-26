/**
 * Antigravity's fixed-choice questions arrive through the APPROVAL method
 * (`session/request_permission`), not through `elicitation/create`. This module
 * is the ONLY place that decides whether one ask is a question, so the rule can
 * change in one spot once the real wire has been captured
 * (docs/plan/agy-question-asks.md §2.3).
 *
 * The gate is deliberately narrow: only an Antigravity bridge can produce a
 * question, so another agent that happens to use the same id prefix keeps the
 * approval pipeline verbatim.
 */

import { permissionAskKind } from '../impl.ts'
import type { AcpAgentDef, PermissionAskKind } from '../protocol.ts'
import { isAntigravityAgent } from './agy-transcript.ts'

export function questionAskKindOf(def: AcpAgentDef, toolCall: unknown): PermissionAskKind {
  return isAntigravityAgent(def) ? permissionAskKind(toolCall) : 'approval'
}
