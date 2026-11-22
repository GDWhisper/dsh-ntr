/**
 * Label routing and diagnostic bounding for the NATIVE subagent delegation
 * (docs/plan/acp-delegate-native-subagent.md §2 / §6).
 *
 * `ResolvedSubagentStartRequest` has no custom fields, so the per-call agent
 * choice AND the explicit model/effort/mode picks ride in the display label.
 * Two formats, one carrier grammar:
 *
 * - no choices: `<agentId>: <task first-line summary>` (byte-identical to the
 *   original format — an activation without picks must not change the wire);
 * - with choices: `<agentId> ⟦m=<enc>&e=<enc>&o=<enc>⟧: <summary>` — only the
 *   keys actually present are written, in the FIXED order m, e, o, each value
 *   `encodeURIComponent`-encoded.
 *
 * Agent ids (validate.ts · AGENT_ID_PATTERN) contain neither ':' nor ' ', and
 * a canonical carrier contains no raw ': ' either (encodeURIComponent escapes
 * ':', ' ', '&', '=', '⟦', '⟧'), so the FIRST `': '` is always the separator
 * the encoder wrote: task text can never reach the prefix, and a summary that
 * itself looks like `⟦m=…⟧` or contains ': ' cannot forge a choice. The label
 * is a display field doubling as a routing carrier — the encode/decode family
 * below is the ONE place that knows the format, pinned by round-trip and
 * injection tests; a format change must touch every function here together.
 * `displayDelegateLabel` strips a STRICTLY legal carrier for the plugin's own
 * subagent panel; malformed carriers pass through untouched (routing fails
 * closed, display fails open).
 *
 * The diagnostic truncation is a hand copy of the host 0.2.2-rc.5 semantics
 * (`dsh-subagent/src/out-of-process.ts · limitSubagentDiagnostic`): ≤4096 UTF-8
 * bytes INCLUDING the `\n[diagnostic truncated]` suffix, never splitting a
 * UTF-8 sequence. Equivalence tests run the host's own settlement normalizer
 * against this function so a host upgrade that drifts the semantics fails
 * loudly instead of silently changing the wire. `mergeDelegateDiagnostic` is
 * the plugin's OWN merge policy on top of that primitive: the notes reserve a
 * byte budget so a long turnError can never eat them.
 *
 * Pure logic only — no Node APIs, no SDK; TextEncoder/TextDecoder are globals.
 */

import { AGENT_ID_PATTERN } from './validate.ts'

/** Code points of the task's first line kept in the label summary. */
export const DELEGATE_LABEL_SUMMARY_MAX = 80

/** Maximum UTF-8 size of a provider-authored diagnostic (host contract). */
export const MAX_DELEGATE_DIAGNOSTIC_BYTES = 4_096

/**
 * UTF-8 byte budget the degradation notes RESERVE inside a merged diagnostic
 * (plugin policy, not a host fact): a long turnError must never eat the notes.
 */
export const DELEGATE_NOTES_RESERVE_BYTES = 1_024

/** The host's exact truncation marker (hand copy — pinned by equivalence tests). */
export const DIAGNOSTIC_TRUNCATION_SUFFIX = '\n[diagnostic truncated]'

const utf8Encoder = new TextEncoder()
const utf8Decoder = new TextDecoder()

/**
 * The explicit per-call choice axes a delegation label can carry —
 * structurally the planner's `DelegateChoiceSet`. Persisted values are
 * non-empty strings (validate.ts gates them); the codec treats an empty
 * string like an absent key so its output is ALWAYS strictly parseable.
 */
export interface DelegateLabelChoices {
  model?: string
  effort?: string
  mode?: string
}

const CARRIER_OPEN = '⟦'
const CARRIER_CLOSE = '⟧'

/**
 * Encode the per-call agent choice (and optional explicit picks) into the
 * activation label. The summary is the task's first line, trimmed and clipped
 * to {@link DELEGATE_LABEL_SUMMARY_MAX} code points (never splitting a
 * surrogate pair); an empty first line still yields a decodable label.
 * Without choices the output is byte-identical to the original
 * `<agentId>: <summary>` format; with any present key the carrier
 * `⟦m=…&e=…&o=…⟧` rides between the id and the separator (fixed key order,
 * only present keys, encodeURIComponent values).
 */
export function delegateLabel(agentId: string, task: string, choices?: DelegateLabelChoices): string {
  const firstLine = task.split(/\r?\n/, 1)[0] ?? ''
  const summary = firstLine.trim()
  const points = Array.from(summary)
  const clipped = points.length > DELEGATE_LABEL_SUMMARY_MAX
    ? `${points.slice(0, DELEGATE_LABEL_SUMMARY_MAX).join('')}…`
    : summary
  const carrier = encodeChoiceCarrier(choices)
  return carrier === undefined
    ? `${agentId}: ${clipped}`
    : `${agentId} ${CARRIER_OPEN}${carrier}${CARRIER_CLOSE}: ${clipped}`
}

/** The carrier payload, or undefined when no axis is present. */
function encodeChoiceCarrier(choices: DelegateLabelChoices | undefined): string | undefined {
  if (choices === undefined) return undefined
  const parts: string[] = []
  if (choices.model !== undefined && choices.model !== '') parts.push(`m=${encodeURIComponent(choices.model)}`)
  if (choices.effort !== undefined && choices.effort !== '') parts.push(`e=${encodeURIComponent(choices.effort)}`)
  if (choices.mode !== undefined && choices.mode !== '') parts.push(`o=${encodeURIComponent(choices.mode)}`)
  return parts.length > 0 ? parts.join('&') : undefined
}

/**
 * STRICT carrier parse of a label prefix: the whole prefix must be exactly
 * `<agentId> ⟦<payload>⟧` — one space before a single `⟦`, a single `⟧` as
 * the last character, a legal agent id, and a payload of `key=encoded`
 * segments joined by '&': keys from {m,e,o}, each at most once, in ascending
 * m<e<o order, every value non-empty and CANONICALLY encodeURIComponent-ed
 * (decode must succeed and re-encode identically). Anything else is
 * `undefined` — a malformed carrier never routes and never yields choices.
 */
function parseCarrierPrefix(prefix: string): { agentId: string; choices: DelegateLabelChoices } | undefined {
  const open = prefix.indexOf(CARRIER_OPEN)
  if (open <= 0 || prefix.indexOf(CARRIER_OPEN, open + 1) !== -1) return undefined
  if (prefix[open - 1] !== ' ') return undefined
  if (!prefix.endsWith(CARRIER_CLOSE) || prefix.indexOf(CARRIER_CLOSE) !== prefix.length - 1) return undefined
  const agentId = prefix.slice(0, open - 1)
  if (!AGENT_ID_PATTERN.test(agentId)) return undefined
  const payload = prefix.slice(open + 1, prefix.length - 1)
  if (payload === '') return undefined
  const choices: DelegateLabelChoices = {}
  let lastKey = -1
  for (const segment of payload.split('&')) {
    // 'm=x' is the shortest legal segment; the key is exactly one character.
    if (segment.length < 3 || segment[1] !== '=') return undefined
    const key = segment[0] === 'm' ? 0 : segment[0] === 'e' ? 1 : segment[0] === 'o' ? 2 : -1
    if (key === -1 || key <= lastKey) return undefined
    lastKey = key
    const encoded = segment.slice(2)
    let decoded: string
    try {
      decoded = decodeURIComponent(encoded)
    } catch {
      return undefined
    }
    if (encodeURIComponent(decoded) !== encoded) return undefined
    if (key === 0) choices.model = decoded
    else if (key === 1) choices.effort = decoded
    else choices.mode = decoded
  }
  return { agentId, choices }
}

/**
 * Decode the agent id from an activation label: the text before the FIRST
 * `': '`. Without a carrier it must be a legal agent id outright; with a
 * carrier (`⟦` in the prefix) the agent part AND the carrier syntax must both
 * be strictly legal. Anything else (missing separator, illegal charset,
 * empty prefix, malformed carrier) reads as `undefined` — the provider then
 * fails the start cleanly instead of guessing an agent.
 */
export function agentIdFromDelegateLabel(label: string): string | undefined {
  const separator = label.indexOf(': ')
  if (separator <= 0) return undefined
  const prefix = label.slice(0, separator)
  if (!prefix.includes(CARRIER_OPEN)) return AGENT_ID_PATTERN.test(prefix) ? prefix : undefined
  return parseCarrierPrefix(prefix)?.agentId
}

/**
 * Decode the explicit choice axes from an activation label: `undefined` when
 * the prefix carries no carrier OR the carrier is malformed; the decoded
 * values when it is strictly legal. Task text after the first `': '` is never
 * consulted, so a summary cannot inject choices.
 */
export function delegateChoicesFromLabel(label: string): DelegateLabelChoices | undefined {
  const separator = label.indexOf(': ')
  if (separator <= 0) return undefined
  const prefix = label.slice(0, separator)
  if (!prefix.includes(CARRIER_OPEN)) return undefined
  return parseCarrierPrefix(prefix)?.choices
}

/**
 * The label as the plugin's own subagent panel should show it: a strictly
 * legal carrier is stripped back to `<agentId>: <summary>`; anything without
 * a carrier — including a MALFORMED one — passes through verbatim (display
 * fails open where routing fails closed).
 */
export function displayDelegateLabel(label: string): string {
  const separator = label.indexOf(': ')
  if (separator <= 0) return label
  const prefix = label.slice(0, separator)
  if (!prefix.includes(CARRIER_OPEN)) return label
  const parsed = parseCarrierPrefix(prefix)
  if (parsed === undefined) return label
  return `${parsed.agentId}: ${label.slice(separator + 2)}`
}

/**
 * Bound a provider-authored diagnostic to the host's UTF-8 byte limit without
 * splitting a UTF-8 sequence — the exact 0.2.2-rc.5 algorithm: texts within
 * the limit pass through verbatim; longer ones keep the longest prefix that
 * fits BESIDE the suffix and ends on a sequence boundary, then the suffix.
 */
export function truncateDelegateDiagnostic(diagnostic: string): string {
  return truncateUtf8Diagnostic(diagnostic, MAX_DELEGATE_DIAGNOSTIC_BYTES)
}

/**
 * The truncation algorithm above, parameterized by byte budget (the notes
 * reserve and the turnError remainder need smaller limits). Same marker, same
 * boundary walk-back; the exported host-equivalent behavior lives in
 * {@link truncateDelegateDiagnostic} and must stay byte-identical.
 */
function truncateUtf8Diagnostic(text: string, limitBytes: number): string {
  const bytes = utf8Encoder.encode(text)
  if (bytes.byteLength <= limitBytes) return text
  const suffixBytes = utf8Encoder.encode(DIAGNOSTIC_TRUNCATION_SUFFIX).byteLength
  let prefixBytes = limitBytes - suffixBytes
  // Walk back off any UTF-8 continuation byte (10xxxxxx) so the cut never
  // lands inside a multi-byte sequence.
  while (((bytes[prefixBytes] as number) & 0b1100_0000) === 0b1000_0000) {
    prefixBytes -= 1
  }
  return utf8Decoder.decode(bytes.subarray(0, prefixBytes)) + DIAGNOSTIC_TRUNCATION_SUFFIX
}

/**
 * Merge the failure detail and the degradation notes into ONE bounded
 * diagnostic with a RESERVED notes budget (plugin policy — the host only
 * truncates, it does not merge). A long turnError must never eat the notes:
 * a stale-default degradation has to reach the parent even when the turn
 * itself also reported an error. Pinned by tests/impl/delegate-label.spec.ts:
 *
 * - both absent (undefined or '') → undefined;
 * - only one present → truncateDelegateDiagnostic(that part);
 * - both present → the notes keep up to DELEGATE_NOTES_RESERVE_BYTES (longer
 *   notes truncate to that budget WITH the marker), the turnError gets the
 *   remainder of MAX_DELEGATE_DIAGNOSTIC_BYTES after the notes' ACTUAL bytes
 *   and the '\n' separator, truncated UTF-8-safely with the marker when over
 *   budget. The merged total never exceeds MAX_DELEGATE_DIAGNOSTIC_BYTES.
 *   When everything fits, the output is the verbatim `turnError\nnotes` join.
 */
export function mergeDelegateDiagnostic(turnError: string | undefined, notes: string | undefined): string | undefined {
  const error = turnError === undefined || turnError === '' ? undefined : turnError
  const note = notes === undefined || notes === '' ? undefined : notes
  if (note === undefined) return error === undefined ? undefined : truncateDelegateDiagnostic(error)
  if (error === undefined) return truncateDelegateDiagnostic(note)
  const boundedNotes = truncateUtf8Diagnostic(note, DELEGATE_NOTES_RESERVE_BYTES)
  const separator = '\n'
  const errorBudget = MAX_DELEGATE_DIAGNOSTIC_BYTES - utf8Encoder.encode(boundedNotes).byteLength - utf8Encoder.encode(separator).byteLength
  return truncateUtf8Diagnostic(error, errorBudget) + separator + boundedNotes
}