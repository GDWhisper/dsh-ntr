/**
 * The ONE browser-half copy of the agent-id charset rule, shared by every
 * client consumer (panel/agent-row.tsx, subagent-panel.tsx). A second literal
 * anywhere in src/client/ is forbidden (AGENTS/ui.md §3.2).
 *
 * Cross-half hand copy: the host original is src/impl/validate.ts ·
 * AGENT_ID_PATTERN (the browser half must not import host-plane modules).
 * Equivalence is pinned by tests/agent-id.spec.ts — source/flags verbatim plus
 * behavior samples against the host original; change one, change the other.
 *
 * Pure constant module — no Node APIs, no SDK, no side effects.
 */
export const AGENT_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/