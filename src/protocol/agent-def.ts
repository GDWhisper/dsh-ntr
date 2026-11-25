/**
 * Configuration surface: the agent definitions and plugin config the host reads from the profile layer.
 *
 * Part of the protocol contract; the barrel is `src/protocol.ts` and every
 * existing `../protocol.ts` import keeps resolving through it. Pure types,
 * constants and pure helpers only — no side effects, no Node APIs, no ACP SDK
 * runtime values (type-only SDK imports are erased at build time).
 */

import type { AcpDelegateAgentDefaults, DelegateGuidance, PermissionTimeoutMode } from './ui.ts'

// ---- Configuration (host side, from the profile layer) ----

/** One pre-configured ACP agent executable. */
export interface AcpAgentDef {
  /** Stable id the browser selects by. `^[a-z0-9][a-z0-9._-]*$`. */
  id: string
  /** Display name (defaults to the id). */
  title?: string
  /**
   * Executable spawned over stdio, as a full command line (`codebuddy --acp`),
   * parsed by `validateAgentDef`. The browser MAY set it — that is exactly
   * what the settings panel's single command box does, through `agent/save`
   * (persist, then probe) and `agent/test` (spawn a throwaway handshake). A
   * SESSION never can: `session/start` and the conversation binding only
   * select a configured agent id (see the module header).
   */
  command: string
  /** Argument vector (no shell interpretation). */
  args?: string[]
  /**
   * npm package installed globally (`npm install -g`) when `command` cannot be
   * resolved on the host PATH, right before the spawn is attempted. Unset → a
   * missing command just fails with ENOENT. Name-only charset is enforced by
   * `validateAgentDef` (no shell metacharacters can ever reach the installer).
   */
  npmPackage?: string
  /** Child environment: the inherited host env, with these keys layered on top. */
  env?: Record<string, string>
  /** Default absolute workspace directory for new sessions. */
  cwd?: string
  /** Absolute roots a session cwd may resolve under. Defaults to `[cwd]`. */
  allowedCwdRoots?: string[]
  /**
   * Which probed `category: model` choices this agent offers as `agentId@choice`
   * variants in the plugin's own ACP seats (the chips/picker in the chat
   * composer and the ACP-mode model seat). Those menus have no search, so a
   * full catalog can be a list storm nobody can navigate: a real pi agent
   * publishes 500 choices, omp 581. The rule is DEFAULT-OPEN: unset means every
   * model the agent publishes is offered, so a freshly configured agent's chip
   * menu works on first use. An explicit array — including the empty one — is
   * the user's narrowing: `[]` leaves only the base / currently-in-force row,
   * and a non-empty list offers exactly those values. The bare `agentId`
   * entry (the agent's own default model) is always offered regardless, so an
   * agent is never unreachable. Filtering only affects listing — hidden
   * variants still resolve and stream (see `agent/catalog`).
   *
   * ACP models are deliberately absent from DSH's native model selector — see
   * {@link AgentCatalogResult} for why that is structural, not cosmetic.
   */
  exposedModels?: string[]
  /**
   * Auto-discovery for {@link exposedModels}, ON by default: every model the
   * agent NEWLY publishes (present in an observed catalog but absent from the
   * one known before it) is appended to `exposedModels` automatically. It never
   * touches models the user already had selected, and the very first catalog
   * observation is a baseline (nothing is "new" yet). When `exposedModels` is
   * unset (default-open), nothing is appended at all: every model is already
   * offered, and appending would freeze the whole catalog into the definition.
   * `false` is the explicit
   * opt-out and the only value persisted; unset means "on". Flipped from the
   * settings card's lightweight `agent/set-auto-discover-models` RPC — never by
   * `agent/save`, which restarts the process for connection changes.
   */
  autoDiscoverModels?: boolean
  /**
   * How long this agent's process may sit READY with no live session and
   * nothing in flight before the host releases it (kills the child). Unset →
   * the host default (30 minutes). `0` = never release, and only agents with
   * no live session are ever candidates (see `AgentBridge.releaseIfIdle`):
   * probing / post-save spawns are what leak processes, since they hold no
   * session at all. Nothing is lost either way — a released session is
   * resumed with `session/load` on the next send.
   */
  idleTimeoutMs?: number
  /**
   * MCP servers this agent should connect to, in the plugin's NORMALIZED shape
   * (see {@link AcpMcpServerDef}) — not the ACP wire shape.
   *
   * WHY A NORMALIZED SHAPE: the ACP wire union is asymmetric — its stdio
   * variant carries NO `type` field while http/sse do, and `env`/`headers` are
   * `[{name,value}]` arrays. A hand-written config that guessed the wire
   * shape wrong is accepted by the agent and then SILENTLY DROPPED (measured:
   * a stdio entry carrying `type:'stdio'` never connects). The normalized
   * shape has one explicit discriminant, so the wire conversion happens in
   * exactly one place (bridge.ts) and TypeScript checks it against the SDK's
   * `McpServer` union.
   *
   * An agent's OWN MCP configuration (e.g. `~/.codebuddy/.mcp.json`) is read
   * by the agent itself and needs no declaration here — this field only adds
   * servers ON TOP of that.
   */
  mcpServers?: AcpMcpServerDef[]
  /**
   * The agent's own mode (`session/set_mode` id) that a NEW chat conversation
   * starts on when the conversation has no explicit pick. Unset = follow the
   * agent's own initial mode. This is a FALLBACK, never a written pick: the
   * conversation's recorded choice always outranks it, and `acp_delegate` has
   * its own per-agent defaults (`AcpDelegateAgentDefaults.mode`).
   *
   * Read at session creation / resume (`ChatChoiceService`), so the composer's
   * pre-first-message value and the first turn's actual mode agree. A value the
   * live session no longer offers is skipped with one notice and the field is
   * kept, never rewritten. Edited through the settings card's lightweight
   * `agent/set-default-mode` RPC; a full `agent/save` carries the field so it
   * cannot be cleared, but never edits it.
   */
  defaultMode?: string
  /**
   * Whether this agent is offered the built-in `dsh-skills` MCP server, ON by
   * default: unset means "on", so a definition written before the two-level
   * switch existed needs no migration and the master switch alone reproduces
   * the earlier behaviour. `false` is the explicit opt-out and the only value
   * ever stored — the effective condition is
   * `master switch && skillsMcpEnabled !== false`.
   *
   * Flipped from the agent card's lightweight `agent/set-skills-mcp` RPC,
   * NEVER by `agent/save` (which stops the process): the definition is mutated
   * in place, so a live bridge's `session/new` / `session/load` / probe / fork
   * sees the new value on its next request. Existing sessions keep the tools
   * they were created with.
   */
  skillsMcpEnabled?: boolean
}

/** How an MCP server is reached. `acp` (agent→client `mcp/message`) is NOT supported. */
export type AcpMcpTransport = 'stdio' | 'http' | 'sse'

/**
 * One MCP server, in the plugin's normalized shape.
 *
 * The ACP-transport variant (agent calls back into the client over
 * `mcp/message`) is deliberately absent: the client side of that method is
 * not in the ACP SDK's stable surface, and no agent advertises the
 * capability. `validateAgentDef` rejects it with that reason.
 */
export type AcpMcpServerDef =
  | {
    /** Namespaces the agent's tools as `mcp__<name>__<tool>`; unique per agent. */
    name: string
    transport: 'stdio'
    /** Executable to spawn for this server. */
    command: string
    /** Arguments for the command. */
    args?: string[]
    /** Environment for the server process (layered over the agent's own env). */
    env?: Record<string, string>
  }
  | {
    /** Namespaces the agent's tools as `mcp__<name>__<tool>`; unique per agent. */
    name: string
    transport: 'http' | 'sse'
    /** The server's URL. */
    url: string
    /** Extra request headers (e.g. authorization). */
    headers?: Record<string, string>
  }

/**
 * The deployment baseline for `acp_delegate` (the `delegate` key of
 * `cordis.patch.yml`). Two layers, the same shape as the idle-release and
 * approval-deadline knobs: the value here is the baseline, and a settings-page
 * override persisted in `agents.json` (`delegate`) outranks it per key; a
 * reset returns to this baseline, or to the built-in default when the file
 * names no key. Both layers hot-apply — no host restart, no new session; the
 * change lands on the next step of existing conversations.
 *
 * `guidance` defaults to `off`: the tool is NOT registered, so every
 * deployment's request header is unchanged until someone opts in.
 */
export interface AcpDelegateConfig {
  /** The guidance rung; doubles as the registration switch (`off` = not registered). */
  guidance?: DelegateGuidance
  /** Single-delegation window: an integer in [1000, 86400000] ms. */
  timeoutMs?: number
  /** Deployment-baseline delegation default agent (a legal agent id). */
  defaultAgent?: string
  /**
   * Deployment-baseline per-agent choice defaults. Shape-validated only: a
   * value the agent no longer offers persists and is marked stale at runtime.
   */
  agentDefaults?: Record<string, AcpDelegateAgentDefaults>
}

export interface AcpPluginConfig {
  agents: AcpAgentDef[]
  /** Per-session transcript ring bound (default 600 entries). */
  transcriptMaxEntries?: number
  /**
   * DEAD CONFIG — nothing in this plugin reads it. `validateConfig` still
   * accepts it and the host entry still threads it into the `BridgeManager`
   * constructor, but boot no longer probes (`bootstrapCatalogs` is
   * intentionally empty) and `agent/catalog` is pure memory, so there is no
   * automatic spawn left for it to switch off. Catalogs fill only from a
   * gesture: the agent's own `session/new` / `session/load`, the settings
   * card's `agent/probe-models` button, or an on-disk cache. Kept only so
   * that removing it can be a separate cross-file change (impl.ts, bridge.ts
   * and the host entry all touch it today).
   */
  probeModelsOnBoot?: boolean
  /**
   * Budget for one agent startup step (`initialize`, `session/new`, and the
   * `session/load` of a resume). An agent that does not answer within this
   * window is killed and the request fails with `agent_timeout` instead of
   * hanging forever. Default 60000 ms.
   */
  startupTimeoutMs?: number
  /**
   * How long a permission ask may sit unanswered before the deadline fires.
   *
   * ONE window for both places an ask can live — the conversation's approval
   * card and the settings panel's ledger. They ask the same question ("is
   * anyone there?"), so they get the same answer; two windows only made the
   * settings card look like two unrelated knobs.
   *
   * `0` means 不等待 — the ask is settled the moment it arrives, without asking
   * anyone. That rung belongs to the `auto` MODE: it answers the ask, so the
   * agent continues. Under `abort` the same zero would refuse every ask on
   * arrival (the agent stops at every gate), so `abort` never runs it — the
   * host normalizes it to the shortest real wait. Never expiring is the `wait`
   * MODE's business, so the two never overlap. Anything else is the wait
   * before the deadline fires. Default 300000 ms (5 minutes).
   *
   * When it fires, {@link AcpPluginConfig.permissionTimeoutMode} decides what
   * happens.
   *
   * Editable from the settings page (`ui/approval-deadlines-set`), which
   * persists an override in the plugin's own state file and applies it to the
   * running bridges without restarting anything; the value here is the
   * deployment baseline that override falls back to. See {@link AcpApprovalDeadlines}.
   */
  permissionTimeoutMs?: number
  /**
   * How long an ACP form elicitation ask (`elicitation/create`) may sit
   * unanswered before timing out. On expiry the host settles the request as
   * `cancel`, broadcasts `elicitation/resolved` and one `agent/notice`, and
   * releases the waiting agent turn.
   *
   * Default 300000 ms (5 minutes). An INDEPENDENT window: it does not follow
   * {@link AcpPluginConfig.permissionTimeoutMs}, and the settings page does
   * not rewrite it. `0` disables the elicitation deadline.
   */
  elicitationTimeoutMs?: number
  /**
   * How long a chat process may sit idle before it is released (parked, then
   * resumed by the next message). In MILLISECONDS; default 1800000 (30 min).
   *
   * This is the HOST DEFAULT: an agent that names its own
   * {@link AcpAgentDef.idleTimeoutMs} keeps its own. Editable from the
   * settings page (「进程管理」 → `ui/idle-release-set`), which persists an
   * override in the plugin's own state file and applies it to the running
   * bridges without restarting anything; the value here is the deployment
   * baseline that override falls back to. See {@link AcpIdleRelease}.
   */
  idleTimeoutMs?: number
  /**
   * LEGACY: the old conversation-route window, kept so an existing
   * `cordis.patch.yml` still says what it meant. Folded into
   * {@link AcpPluginConfig.permissionTimeoutMs} when that key is absent, and
   * ignored when it is present.
   */
  nativeApprovalTimeoutMs?: number
  /**
   * LEGACY: the old ledger-route window, kept for the same reason as
   * {@link AcpPluginConfig.nativeApprovalTimeoutMs}.
   */
  permissionFallbackTimeoutMs?: number
  /**
   * What an expired approval deadline DOES. `wait` (default) never expires
   * at all; `abort` answers `cancelled`; `auto` answers with the option the
   * agent's own kinds imply and lets the agent continue.
   *
   * The default is `wait`: a permission ask is a question FOR A HUMAN, and
   * refusing it because the human looked away is worse than waiting — the
   * ask stays visible, so nobody is left wondering. `abort` and `auto` are
   * opt-in for deployments that would rather have a bounded turn.
   *
   * `auto` is unattended operation — the plugin may approve something no human
   * looked at — so it is opt-in and the outcome is announced. `wait` is the
   * "hang visibly until I come back" mode: the ask stays pending and the turn
   * stays open.
   *
   * Editable from the settings page, like {@link nativeApprovalTimeoutMs}.
   */
  permissionTimeoutMode?: PermissionTimeoutMode
  /**
   * After `session/cancel`, how long to wait for the agent to settle the turn
   * before the host force-finalizes it. An agent that ignores the cancel
   * notification must not wedge the session in `running` forever.
   * Default 15000 ms; `0` disables the fallback.
   */
  cancelFallbackMs?: number
  /**
   * How long to wait before resending a prompt the agent answered with
   * `cancelled` although no cancel was requested for that turn. Some agents
   * (observed on codebuddy 2.161.4) clean up cancel state asynchronously, and
   * a prompt landing inside that cleanup window is answered with `cancelled`
   * without generating a turn — the user's message is silently swallowed.
   * The delay must outlast the agent's cleanup window. Default 600 ms.
   */
  staleCancelRetryDelayMs?: number
  /**
   * How many times a stale-cancelled prompt is resent before the host gives
   * up and reports the `cancelled` stop as-is. Default 2.
   */
  staleCancelMaxRetries?: number
  /**
   * Inactivity watchdog for a turn the agent owes an answer: how long the turn
   * may stay SILENT before the host finalizes it as stalled.
   *
   * The clock is `LiveSession.lastAgentActivityAt`, refreshed by ANY
   * `session/update`, at every turn start, at each segment start (the host
   * handing the turn back after a card), and when a permission ask arrives or
   * is resolved. The watchdog only READS it while the turn is watched: an OPEN
   * agent segment (always true on the `/acp`-RPC path, which has no driver
   * stream) and no pending approval. The host-card execution phase and an
   * unanswered ask are exempt by that gate, not because the clock is frozen —
   * they legitimately move it too.
   *
   * Firing finalizes the TURN only (an `agent/notice` plus the usual turn
   * end); it does NOT kill the agent process. The wedged `session/prompt` is
   * abandoned, and the next message reclaims the session: parked with
   * `releaseAll` and resumed with `session/load`, or reset outright when the
   * agent declares no `loadSession` (the context is gone and the user is
   * told).
   *
   * Default 600000 ms (10 minutes); `0` disables the WHOLE watchdog, the tool
   * window included.
   */
  turnStallMs?: number
  /**
   * The longer silence window applied while ANY ACP tool call is still active
   * by `toolCallId` — parallel calls are tracked as a set, so the window lasts
   * until the LAST of them finishes. The agent is working on its own clock in
   * there, so the plain turn window would call a healthy long-running tool
   * stalled.
   *
   * Default 1800000 ms (30 minutes); `0` falls back to
   * {@link AcpPluginConfig.turnStallMs}. It matches
   * `TOOL_OUTPUT_WAIT_MS = 30 * 60 * 1000` in `presets/acp/acp-guard.mjs`, so
   * the two halves of one turn agree on how long a tool may take.
   */
  turnStallToolMs?: number
  /**
   * How often the watchdog scans for silent turns, in milliseconds. A tuning /
   * test knob only: NO settings-page control exists for it — and none for the
   * two windows above either; the whole watchdog is configured in the patch
   * file. Default 30000 ms.
   */
  turnStallTickMs?: number
  /**
   * Total switch for the Antigravity transcript late-output path (see
   * docs/plan/archive/antigravity-late-output.md).
   *
   * Default ON, and only an AUTOMATICALLY recognised `agy acp` session arms a
   * watch: the agent id is user-editable, so recognition reads the launch
   * command line. The transcript format is private to Antigravity, so a
   * deployment that does not trust it sets this to `false` and the whole path
   * is off. Not editable from the settings page: a deployment key.
   */
  agyLateOutput?: boolean
  /**
   * Idle window of the Antigravity transcript watch: how long it may see no new
   * transcript step before standing down. Every new step extends it, so a long
   * background run is not cut off mid-work. `0` disables the whole mechanism.
   * A deployment key (no settings-page control). Default 1800000 ms (30 min).
   */
  agyLateOutputMaxMs?: number
  /**
   * Absolute hard ceiling on the Antigravity transcript watch, from arm time;
   * activity never extends it. `0` = no ceiling. A deployment key. Default 0.
   */
  agyLateOutputCeilingMs?: number
  /**
   * The `acp_delegate` deployment baseline (see {@link AcpDelegateConfig}).
   * Two layers: this baseline plus the settings-page override persisted in
   * `agents.json`; both hot-apply without a restart. `guidance` defaults to
   * `off` — the tool is not registered until a deployment or the settings
   * page opts in.
   */
  delegate?: AcpDelegateConfig
}
