/**
 * Host-side snapshot views: agent process facts, session snapshots and per-turn views the browser renders.
 *
 * Part of the protocol contract; the barrel is `src/protocol.ts` and every
 * existing `../protocol.ts` import keeps resolving through it. Pure types,
 * constants and pure helpers only — no side effects, no Node APIs, no ACP SDK
 * runtime values (type-only SDK imports are erased at build time).
 */

export type AgentProcessState = 'stopped' | 'starting' | 'ready' | 'error'

/** Agent facts the browser may render (never includes env/argv secrets beyond argv itself, which is config-visible). */
/**
 * State of the ACP-mode agent preset in the HARNESS's own preset roster.
 *
 * Nothing is installed any more: the preset ships as this package's bundle
 * patch (`presets/acp/acp.patch.yml`), which the harness composes when it
 * builds the profile, so the only question left is whether the roster carries
 * the declaration and can compose a session from it — which is exactly what a
 * `preset-<id>` row that failed to activate reports as `problem`.
 */
export interface AcpPresetStatus {
  /** Preset id (a session's `agentPreset` value; matched by the browser half). */
  id: string
  /** The declaration inside this package, for copy and debugging. */
  source: string
  /** Whether the roster carries the preset and it can compose a session. */
  installed: boolean
  /** The harness's own diagnostic when the declaration exists but is unusable. */
  problem?: string
}

export interface AgentView {
  id: string
  title: string
  command: string
  args: string[]
  cwd?: string
  allowedCwdRoots: string[]
  state: AgentProcessState
  /** Last stderr lines when state is `error` (diagnostics). */
  stderrTail?: string[]
  /** `initialize` result, once the process is ready. */
  agentInfo?: { name?: string; title?: string; version?: string }
  agentCapabilities?: unknown
  liveSessions: string[]
  /**
   * The window the host actually honors for this agent (its own
   * `idleTimeoutMs`, else the host default). Resolved, not raw, so the panel
   * can show a concrete number instead of guessing at a default; `0` = never
   * released. Absent on an older host half.
   */
  idleTimeoutMs?: number
}

/**
 * Why the host released a session's agent process. The browser turns this into
 * one runtime-log line per cause; `idle`, `shutdown` and `archived` stay silent
 * (expected lifecycle transitions or a user gesture, not faults).
 */
export type AcpReleaseCause = 'idle' | 'workspace' | 'resume-failed' | 'stalled' | 'died' | 'shutdown' | 'archived'

/** One ACP turn currently owed by an agent; the save gate reports these while deciding a profile write. */
export interface ActiveTurnView {
  /** ACP session id (the plugin's own identity). */
  sessionId: string
  /** DSH chat session id; absent for `/acp` RPC-only turns. */
  dshSessionId?: string
  agentId: string
}

/** Plugin-side measurable burst aggregate for one ACP session (not host turn timings). */
export interface SessionBurst {
  /** Sum of estimated output tokens over measurable turns. */
  outputTokens: number
  /** Sum of within-burst chunk gaps over those turns; tool/approval/long pauses excluded. */
  burstMs: number
}

/**
 * Why an agent REFUSED a `session/prompt` it answered (not rejected).
 *
 * CodeBuddy answers a rate-limited prompt with a resolved response:
 * `stopReason: 'refusal'`, and the reason in the response `_meta` as a JSON
 * string (`{ code, message, data: { statusCode, code, category } }`). The SDK's
 * prompt-response schema strips a top-level `errorMessage` field but passes
 * `_meta` through untouched, so the host half reads it there
 * (`agentRefusalDetail` in `src/bridge.ts`) — the only place the reason still
 * arrives.
 */
export interface AgentRefusalDetail {
  /**
   * `quota` for a rate limit the user can wait out or switch models for;
   * `refusal` for any other agent-side refusal.
   */
  kind: 'quota' | 'refusal'
  /** The agent's own words, unedited — they carry the reset time. */
  message: string
}

/** Derived session snapshot for replay/reconnect (source of truth stays in the transcript). */
export interface SessionView {
  sessionId: string
  agentId: string
  acpSessionId: string
  cwd: string
  title?: string
  modes?: { currentModeId?: string; availableModes?: Array<{ id: string; name?: string; description?: string }> }
  configOptions?: unknown[]
  /** The agent's slash commands, every field it declared — not just the two the picker draws. */
  availableCommands?: Array<{ name: string; description?: string; [key: string]: unknown }>
  plan?: unknown[]
  usage?: { used: number; size: number; cost?: { amount: number; currency: string } }
  /** Measurable burst aggregate over this session's turns; absent until measured. */
  burst?: SessionBurst
  running: boolean
  closed: boolean
  /**
   * The agent has not yet settled its `session/prompt` after the visible turn
   * ended. The save gate treats this as busy; an older host half never sends
   * the field, so a browser-side fallback under-reports this window.
   */
  settled?: boolean
  /**
   * The owning agent process died and the session awaits a `session/load`
   * resume. Resuming happens implicitly on the next prompt ("send to
   * recover") when the agent declares the `loadSession` capability.
   */
  released?: boolean
  /**
   * The agent-side session has history while the local buffer is empty: the
   * record was restored from disk after a host restart (the `session/load`
   * replay has not landed), or a resume cleared the buffer ahead of the
   * replay. The ACP view then says history replays on restore instead of
   * claiming "nothing yet".
   */
  hasHistory?: boolean
  /**
   * The agent's last rate-limit refusal on this session, as the agent worded
   * it (the reset time included). Set when a `session/prompt` answered
   * `stopReason: 'refusal'` with a quota detail in its `_meta`, cleared by the
   * next non-limited response and at every lifecycle boundary (close / release
   * / resume / force reset). Deliberately TRANSIENT: it never rides along in
   * the persisted chat-session record, and the record's timestamp stays on the
   * host side. Absent for every session that was never refused.
   */
  quotaRefusal?: { message: string }
  /** Highest transcript seq included in this snapshot (for gap detection). */
  seq: number
}
