/**
 * Label routing and diagnostic bounding for the NATIVE subagent delegation
 * (docs/plan/acp-delegate-native-subagent.md §2 / §6).
 *
 * `ResolvedSubagentStartRequest` has no custom fields, so the per-call agent
 * choice rides in the display label: `<agentId>: <task first-line summary>`.
 * Agent ids (validate.ts · AGENT_ID_PATTERN) contain neither ':' nor ' ', so
 * the FIRST `': '` split is unambiguous. The label is a display field doubling
 * as a routing carrier — the encode/decode pair below is the ONE place that
 * knows the format, pinned by round-trip equivalence tests; a format change
 * must touch both functions together.
 *
 * The diagnostic truncation is a hand copy of the host 0.2.2-rc.5 semantics
 * (`dsh-subagent/src/out-of-process.ts · limitSubagentDiagnostic`): ≤4096 UTF-8
 * bytes INCLUDING the `\n[diagnostic truncated]` suffix, never splitting a
 * UTF-8 sequence. Equivalence tests run the host's own settlement normalizer
 * against this function so a host upgrade that drifts the semantics fails
 * loudly instead of silently changing the wire.
 *
 * Pure logic only — no Node APIs, no SDK; TextEncoder/TextDecoder are globals.
 */

import { AGENT_ID_PATTERN } from './validate.ts'

/** Code points of the task's first line kept in the label summary. */
export const DELEGATE_LABEL_SUMMARY_MAX = 80

/** Maximum UTF-8 size of a provider-authored diagnostic (host contract). */
export const MAX_DELEGATE_DIAGNOSTIC_BYTES = 4_096

/** The host's exact truncation marker (hand copy — pinned by equivalence tests). */
export const DIAGNOSTIC_TRUNCATION_SUFFIX = '\n[diagnostic truncated]'

const utf8Encoder = new TextEncoder()
const utf8Decoder = new TextDecoder()

/**
 * Encode the per-call agent choice into the activation label. The summary is
 * the task's first line, trimmed and clipped to {@link DELEGATE_LABEL_SUMMARY_MAX}
 * code points (never splitting a surrogate pair); an empty first line still
 * yields a decodable `<agentId>: ` label.
 */
export function delegateLabel(agentId: string, task: string): string {
  const firstLine = task.split(/\r?\n/, 1)[0] ?? ''
  const summary = firstLine.trim()
  const points = Array.from(summary)
  const clipped = points.length > DELEGATE_LABEL_SUMMARY_MAX
    ? `${points.slice(0, DELEGATE_LABEL_SUMMARY_MAX).join('')}…`
    : summary
  return `${agentId}: ${clipped}`
}

/**
 * Decode the agent id from an activation label: the text before the FIRST
 * `': '`, accepted only when it is a legal agent id. Anything else (missing
 * separator, illegal charset, empty prefix) reads as `undefined` — the
 * provider then fails the start cleanly instead of guessing an agent.
 */
export function agentIdFromDelegateLabel(label: string): string | undefined {
  const separator = label.indexOf(': ')
  if (separator <= 0) return undefined
  const agentId = label.slice(0, separator)
  return AGENT_ID_PATTERN.test(agentId) ? agentId : undefined
}

/**
 * Bound a provider-authored diagnostic to the host's UTF-8 byte limit without
 * splitting a UTF-8 sequence — the exact 0.2.2-rc.5 algorithm: texts within
 * the limit pass through verbatim; longer ones keep the longest prefix that
 * fits BESIDE the suffix and ends on a sequence boundary, then the suffix.
 */
export function truncateDelegateDiagnostic(diagnostic: string): string {
  const bytes = utf8Encoder.encode(diagnostic)
  if (bytes.byteLength <= MAX_DELEGATE_DIAGNOSTIC_BYTES) return diagnostic
  const suffixBytes = utf8Encoder.encode(DIAGNOSTIC_TRUNCATION_SUFFIX).byteLength
  let prefixBytes = MAX_DELEGATE_DIAGNOSTIC_BYTES - suffixBytes
  // Walk back off any UTF-8 continuation byte (10xxxxxx) so the cut never
  // lands inside a multi-byte sequence.
  while (((bytes[prefixBytes] as number) & 0b1100_0000) === 0b1000_0000) {
    prefixBytes -= 1
  }
  return utf8Decoder.decode(bytes.subarray(0, prefixBytes)) + DIAGNOSTIC_TRUNCATION_SUFFIX
}