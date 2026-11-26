/**
 * The delegation roster as the CALLER reads it: one compact line per configured
 * agent inside `acp_delegate`'s `agent` parameter description (plus a stable
 * digest for the registration signature).
 *
 * Why the roster lives in the tool schema: the main agent picks a delegate
 * BEFORE any process exists, so the only facts it can act on are the ones the
 * host already holds — the display title, the user-written description and the
 * persisted delegation defaults. Probing every agent on every turn would spawn
 * processes just to answer "who can do this", which is exactly what the catalog
 * gestures exist to avoid.
 *
 * Pure logic only — no Node APIs, no SDK. Tests pin the line grammar
 * (`tests/impl/delegate-doc.spec.ts`); the host validator owns the length caps.
 */
import type { AcpDelegateAgentDefaults } from '../protocol.ts'

/** One configured agent as the tool schema should describe it. */
export interface DelegateAgentDoc {
  id: string
  title: string
  /** The user-written "good at" line, already trimmed and capped by validation. */
  description?: string
  model?: string
  effort?: string
  mode?: string
}

/** The axis defaults a per-agent entry may carry, narrowed for the doc row. */
export function delegateAgentDoc(agentId: string, title: string, entry: AcpDelegateAgentDefaults | undefined): DelegateAgentDoc {
  const doc: DelegateAgentDoc = { id: agentId, title }
  if (entry?.description !== undefined) doc.description = entry.description
  if (entry?.model !== undefined) doc.model = entry.model
  if (entry?.effort !== undefined) doc.effort = entry.effort
  if (entry?.mode !== undefined) doc.mode = entry.mode
  return doc
}

/**
 * The whole roster: every enabled configured agent plus its persisted
 * delegation profile (agents explicitly marked `enabled: false` are omitted
 * from the caller's choice list).
 */
export function delegateAgentDocs(
  views: readonly { id: string; title: string }[],
  defaults: Record<string, AcpDelegateAgentDefaults> | undefined,
): DelegateAgentDoc[] {
  return views
    .filter(view => defaults?.[view.id]?.enabled !== false)
    .map(view => delegateAgentDoc(view.id, view.title, defaults?.[view.id]))
}

/**
 * The fragment must stay ONE line (the schema is a bulleted roster), and its
 * trailing sentence punctuation is dropped so the joined row never doubles it.
 * A hand-edited config file can carry newlines / runs of spaces; folding them
 * here is what keeps "one agent per line" true for every input.
 */
function oneLineFragment(raw: string): string {
  return raw.replace(/\s+/gu, ' ').replace(/[。．.；;，,！？!?]+$/u, '').trim()
}

/**
 * ONE roster row: `- codebuddy (CodeBuddy): <description>; defaults: model X, level Y, mode Z`.
 * The parenthetical appears only when the display title differs from the id
 * (otherwise the id alone is the shortest true name). The defaults sentence is
 * ALWAYS present: "follow the process itself" is a fact the caller needs, not
 * an absence it should guess at.
 */
export function delegateAgentDocLine(doc: DelegateAgentDoc): string {
  const title = doc.title.trim()
  const name = title === '' || title === doc.id ? doc.id : `${doc.id} (${title})`
  const parts: string[] = []
  const description = doc.description === undefined ? '' : oneLineFragment(doc.description)
  if (description !== '') parts.push(description)
  const defaults: string[] = []
  if (doc.model !== undefined) defaults.push(`model ${doc.model}`)
  if (doc.effort !== undefined) defaults.push(`level ${doc.effort}`)
  if (doc.mode !== undefined) defaults.push(`mode ${doc.mode}`)
  parts.push(defaults.length === 0 ? 'defaults: follow the process itself' : `defaults: ${defaults.join(', ')}`)
  return `- ${name}: ${parts.join('; ')}`
}

/**
 * The whole block ('' when no agent is configured). One line per agent, in the
 * roster's own order — never sorted here, so the settings page and the schema
 * agree on what "first" means.
 *
 * The header only promises a choice when the caller actually HAS grounds to
 * choose: "pick by capability" with every description blank would invite a
 * blind pick among rows that differ only in their defaults, so it names that
 * fact instead and lets the caller fall back to the omitted-`agent` path.
 */
export function delegateRosterText(docs: readonly DelegateAgentDoc[]): string {
  if (docs.length === 0) return ''
  const described = docs.some(doc => doc.description !== undefined && oneLineFragment(doc.description) !== '')
  const head = described ? 'Pick by capability:' : 'Configured agents (none has a "good at" line):'
  return [head, ...docs.map(doc => delegateAgentDocLine(doc))].join('\n')
}

/**
 * A stable digest of everything the schema renders. The registration compares
 * it to decide re-registration: a description edit must reach the NEXT request
 * header, while an unrelated settings write must not churn the tool list.
 * Fields are joined with separators that cannot appear in agent ids; missing
 * axes read as '' so "unset" and "explicitly empty" (impossible after
 * validation) cannot hash differently. The description is hashed FOLDED, the
 * same value the row renders — a whitespace-only or punctuation-only edit
 * renders identically, so it must not trigger a re-registration either.
 */
export function delegateRosterDigest(docs: readonly DelegateAgentDoc[]): string {
  return docs.map(doc => [
    doc.id,
    doc.title,
    doc.description === undefined ? '' : oneLineFragment(doc.description),
    doc.model ?? '',
    doc.effort ?? '',
    doc.mode ?? '',
  ].join('\u0001')).join('\u0002')
}
