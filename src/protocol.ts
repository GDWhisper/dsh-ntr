/**
 * dsh-ntr shared contracts (browser-safe: types only, zero runtime code).
 *
 * Two planes:
 * - `AcpEvent`: host → browser, one JSON frame per `session/update` fold,
 *   permission round-trip, agent process status, and turn lifecycle.
 * - RPC payloads: browser → host unary calls on the `/acp` Connection channel.
 *
 * Security invariants encoded here (enforced host-side in impl.ts):
 * - A SESSION never names a program to spawn: `session/start` and the
 *   conversation↔agent binding only select a configured agent id and a cwd
 *   that must resolve inside the agent's allowed roots. Naming a program is
 *   a CONFIGURATION act instead — the browser may do it through `agent/save`
 *   / `agent/test`, both of which run the command through `validateAgentDef`
 *   (a command line, not a bare path) and both of which really spawn.
 * - Agent environment variables flow config → child process only.
 */

import type { SessionUpdate } from '@agentclientprotocol/sdk'

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
   * composer and the ACP-mode model seat). Those menus have no search, so the
   * full catalog is a list storm nobody can navigate: a real pi agent publishes
   * 500 choices, omp 581. Variants are **opt-in** — unset or empty offers none
   * of them, and only the listed choice values are added. The bare `agentId`
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
   * observation is a baseline (nothing is "new" yet). `false` is the explicit
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
   * How long a pending `session/request_permission` may sit unanswered before
   * the host answers `cancelled` on the user's behalf.
   * `0` (default) waits forever — the human decides, matching the ACP spec's
   * stance that approvals belong to a person.
   */
  permissionTimeoutMs?: number
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
}

// ---- Host → browser events (`/api/acp/stream`, SSE) ----

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

export type AcpEvent =
  | { type: 'agent/status'; agentId: string; state: AgentProcessState; error?: string; agent?: AgentView }
  | { type: 'agent/notice'; agentId: string; level: 'info' | 'error'; text: string }
  | { type: 'session/created'; sessionId: string; session: SessionView }
  | { type: 'session/meta'; sessionId: string; session: SessionView }
  | { type: 'session/closed'; sessionId: string; reason: 'closed' | 'agent-stopped' | 'agent-died' }
  | {
    /** The agent process died: the session is kept resumable, not destroyed. */
    type: 'session/released'
    sessionId: string
    session: SessionView
    reason: string
  }
  | {
    /**
     * The session was resumed through `session/load` on a fresh agent
     * process; the agent replays its history as fresh `session/update`s, so
     * the browser must drop local blocks and the seq watermark first.
     */
    type: 'session/reset'
    sessionId: string
    session: SessionView
  }
  | { type: 'session/update'; sessionId: string; seq: number; update: SessionUpdate }
  /**
   * One agent's learned surface changed on the host because a real session
   * published new `configOptions` or `availableCommands` (its `session/new` /
   * `session/load`, a `config_option_update`, or an
   * `available_commands_update`). The browser must drop its cached seat
   * catalog for that agent and re-read `agent/catalog`; without this, a
   * conversation opened before the agent's first real session keeps rendering
   * yesterday's model list (user report, 2026-10-19) — and a conversation
   * opened after it would miss the agent's slash commands until a reload.
   */
  | { type: 'catalog/updated'; agentId: string; updatedAt: number }
  /**
   * One agent's model visibility changed outside `agent/save`: the settings
   * panel edited `exposedModels`, the auto-discovery switch was flipped, or an
   * observed catalog contributed newly published models. The browser patches
   * its copy of the agent definition (the settings card) and re-reads
   * `agent/catalog` (the composer's seat list). `exposedModels: []` means the
   * same as unset — no `agentId@choice` variants.
   */
  | { type: 'agent/exposure'; agentId: string; exposedModels: string[]; autoDiscoverModels: boolean }
  | { type: 'permission/request'; requestId: string; sessionId: string; toolCall: unknown; options: PermissionOptionView[] }
  | { type: 'permission/resolved'; requestId: string; sessionId: string; outcome: PermissionOutcome }
  /**
   * Terminator of the pending-permission REPLAY a freshly connected client
   * receives (see the `/api/acp/stream` route). A `permission/request` frame is
   * broadcast once, when the ask is created — a client that connects later (page
   * reload, a second tab, a stream outage) would otherwise never learn the ask
   * exists, and the settings-panel ledger card is the only answer entry for it.
   * The replay re-sends every outstanding ask and then this frame, whose
   * `requestIds` is the authoritative live set: the client drops any pending ask
   * of its own that is not in it (one resolved while it was disconnected).
   */
  | { type: 'permission/synced'; requestIds: string[] }
  | { type: 'turn/start'; sessionId: string; turnId: string; text: string }
  | { type: 'turn/end'; sessionId: string; turnId: string; stopReason?: string; error?: string }
  /**
   * A DSH chat conversation was locked to its agent at the start of its first
   * ACP turn. Addressed by the CHAT session id (the browser may not know the
   * ACP session yet). The composer plays its base→tag hand-off on this frame;
   * a `session/chat-list` read is only the fallback (it can arrive a turn late).
   */
  | { type: 'chat/agent-locked'; dshSessionId: string; agentId: string }
  /**
   * The provisional lock of a first turn that delivered no visible output was
   * rolled back: the conversation may switch agents again, and its base must
   * return. The failed ACP session is closed with it.
   */
  | { type: 'chat/agent-unlocked'; dshSessionId: string }

export interface PermissionOptionView {
  optionId: string
  name: string
  kind: string
}

export type PermissionOutcome = { outcome: 'selected'; optionId: string } | { outcome: 'cancelled' }

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
  running: boolean
  closed: boolean
  /**
   * The owning agent process died and the session awaits a `session/load`
   * resume. Resuming happens implicitly on the next prompt ("send to
   * recover") when the agent declares the `loadSession` capability.
   */
  released?: boolean
  /** Highest transcript seq included in this snapshot (for gap detection). */
  seq: number
}

// ---- Browser → host RPC (`/acp` channel; payloads below) ----

export type RpcResult<T> = {
  ok: true
  value: T
} | {
  ok: false
  /** Mirrors the host `ConnectionRpcFailure` shape (details is transport-mandated). */
  error: { code: string; message: string; details: object }
}

export interface AgentsListResult {
  agents: AgentView[]
  /**
   * True when permission asks are routed to the host approval chain and the
   * browser must stop rendering the settings-panel permission card. False (or
   * absent on an older host) keeps the degraded ledger path visible.
   */
  approvalRouted?: boolean
}
export type SessionPromptResult = { accepted: true; turnId: string }
export type TranscriptResult = { session: SessionView; entries: Array<{ seq: number; update: SessionUpdate }> }
export type SessionsListResult = { sessions: SessionView[] }

/**
 * One ACP agent session currently backing a DSH chat session, looked up by the
 * chat session id the composer already knows. This is what lets the browser
 * expose an agent's OWN mode list, model, thought level AND slash commands in
 * the conversation (the ACP-native controls), independently of DSH's model
 * selection and command catalog.
 */
export interface ChatSessionView {
  agentId: string
  /** Display name of the agent definition, when it differs from the id. */
  agentTitle?: string
  /** Host-minted session id (stable across an agent restart). */
  sessionId: string
  title?: string
  /**
   * The adapter model id this session was last aligned to
   * (`agentId` / `agentId@choice`), as recorded by the host half. Absent until
   * the first turn or an explicit switch.
   */
  modelId?: string
  /** The reasoning effort in force, when the agent reports one. */
  reasoningEffort?: string
  /** The agent's declared modes, when it has any (`session/new` / `session/load`). */
  modes?: SessionView['modes']
  /**
   * The slash commands the agent declared (`available_commands_update`). The
   * composer's `/` menu shows THESE in an ACP conversation — the host's own
   * command catalog describes commands this runtime would execute, which the
   * agent can never see.
   */
  availableCommands?: SessionView['availableCommands']
  /** The agent process died; the session awaits a `session/load` resume. */
  released?: boolean
}
export type ChatSessionsListResult = { sessions: ChatSessionView[] }

/**
 * The `session/chat-list` answer: the backing ACP sessions, plus whether that
 * DSH chat session runs the ACP agent preset (host-read from the session log).
 * The composer surfaces fall back to the latter when the client runtime's
 * session rows carry no `agentPreset` — on such hosts it is the only fact
 * source they have.
 */
export interface ChatSessionListResult extends ChatSessionsListResult {
  acpMode?: boolean
  /**
   * The agent this conversation is LOCKED to, once its first ACP turn has run.
   *
   * The composer's agent base retires at that point and the composer-edge tag
   * shows this agent; the tag is display-only because a different agent would
   * have none of the conversation's context. The lock is persisted with the
   * conversation record, so it outlives the ACP session (and a host restart),
   * and it is reported even when the agent is no longer in the roster — the
   * conversation still belongs to it.
   */
  lockedAgentId?: string
  /**
   * The conversation's persisted pick (agent + model + thought level), when one
   * exists. This is what the composer reads BEFORE the conversation has an ACP
   * session, so a model chosen up front shows up as the current one instead of
   * appearing to have been forgotten.
   */
  choice?: AcpConversationChoice
}

/**
 * One ACP session's folded transcript, addressed by its DSH chat session.
 *
 * This is the data behind the conversation's ACP view tab. The native chat
 * plane renders what the LLM adapter emits, so the agent's prose and thinking
 * ride there — but a fuller card (a tool call with its arguments, a plan, a
 * unified diff) has no chunk vocabulary in the adapter's output, so it is
 * rendered here instead. This is how the browser reaches it without knowing an
 * ACP session id up front. See docs/acp-convergence.md §1.2.
 */
export interface ChatTranscriptView {
  session: SessionView
  /**
   * Raw ACP `session/update` payloads in seq order (the fold happens
   * client-side). `unknown` is deliberate, matching `TranscriptResult`: the
   * host's buffer is transport-agnostic and must not import the SDK.
   */
  entries: Array<{ seq: number; update: unknown }>
}
export type ChatTranscriptResult = { views: ChatTranscriptView[] }
export interface ChatTranscriptPayload { dshSessionId: string; afterSeq?: number }

export interface SessionStartPayload { agentId: string; cwd?: string }
export interface SessionPromptPayload { sessionId: string; text: string }
export interface SessionIdPayload { sessionId: string }
export interface PermissionRespondPayload { requestId: string; optionId?: string }
export interface SessionModeSetPayload { sessionId: string; modeId: string }
export interface SessionConfigSetPayload { sessionId: string; configId: string; value: string | boolean }
export interface TranscriptGetPayload { sessionId: string; afterSeq?: number }
export interface AgentIdPayload { agentId: string }
/**
 * The plugin's OWN default ACP agent (the panel's ★ gesture): which agent an
 * ACP-mode conversation starts on. Plugin-private state — the host never sees a
 * model route here, and nothing in this plugin writes DSH's model selection
 * (see docs/acp-convergence.md §2.2).
 */
export interface DefaultAgentSetPayload { agentId?: string }
/** `default/agent`: the plugin's own default agent id, or `undefined` when unset. */
export type DefaultAgentResult = { agentId?: string }

/**
 * How the composer-edge agent tag shows liveness (the blue halo). `breath`
 * pulses the halo at the speed below; `steady` shows a constant glow.
 * Plugin-private display preference, persisted with the agent registry.
 */
export interface AcpTagHalo {
  mode: 'breath' | 'steady'
  speed: 'slow' | 'normal' | 'fast'
}
/** Default when nothing was ever saved: the breathing halo at normal speed. */
export const DEFAULT_TAG_HALO: AcpTagHalo = { mode: 'breath', speed: 'normal' }
/** `ui/tag-halo`: read the halo preference. */
export type TagHaloResult = { halo: AcpTagHalo }
/** `ui/tag-halo-set`: write the halo preference. */
export interface TagHaloSetPayload { halo: AcpTagHalo }

/**
 * `session/chat-bind`: point one DSH chat conversation at an ACP agent. The
 * plugin's own conversation↔agent mapping — deliberately NOT a DSH model
 * selection, which is what polluting the deployment default and getting
 * refused by the GUI's catalog gate both came from.
 */
export interface ChatBindPayload { dshSessionId: string; agentId: string }
/** `session/chat-model-set`: switch the bound agent's model (`agentId@choice`). */
export interface ChatModelSetPayload { dshSessionId: string; modelId: string }
/** `session/chat-effort-set`: switch (or clear, by omitting) the agent's effort; `agentId` names the agent a not-yet-bound conversation is served by (the plugin default). */
export interface ChatEffortSetPayload { dshSessionId: string; effort?: string; agentId?: string }
/** `session/chat-config-set`: set one of the agent's extra config options. */
export interface ChatConfigSetPayload { dshSessionId: string; configId: string; value: string | boolean; agentId?: string }

/** Host-detected agent presence and tested defaults. */
export interface DetectedAgentInfo {
  id: string
  name: string
  description?: string
  detected: boolean
  executablePath?: string
  defaultCommand: string
  defaultArgs: string[]
  currentConfig?: AcpAgentDef
}

export type AgentDetectResult = { agents: DetectedAgentInfo[] }

export interface AgentSavePayload {
  id: string
  title?: string
  command: string
  args?: string[]
  npmPackage?: string
  cwd?: string
  allowedCwdRoots?: string[]
  env?: Record<string, string>
  exposedModels?: string[]
  /** Opt out of auto-discovery with `false`; absent keeps the default (on). See {@link AcpAgentDef.autoDiscoverModels}. */
  autoDiscoverModels?: boolean
  /** Absent → keep the host default (30 minutes); `0` = never release. */
  idleTimeoutMs?: number
}

/** Result of `agent/test`: spawn + initialize a throwaway process from form values, then tear it down. */
export interface AgentTestResult {
  ok: boolean
  /** Failure reason when `ok` is false (spawn ENOENT, install failure, initialize timeout, …). */
  error?: string
  /** The agent's `initialize` identity, when the handshake completed. */
  agentInfo?: { name?: string; title?: string; version?: string }
  /** Wall-clock cost of the whole test, including a triggered npm install. */
  durationMs: number
  /** Tail of the child's stderr (and installer output), newest last. */
  stderr: string[]
}

export interface AgentExposedModelsPayload {
  agentId: string
  /** Absent → clear the filter (expose no variants); array (even empty) → expose exactly these. */
  exposedModels?: string[]
}

// ---- Model catalog (host-side cache of ACP `configOptions`) ----

/** One selectable value of a `model` / `thought_level` config option. */
export interface AcpCatalogChoice {
  value: string
  name: string
  description?: string
  /**
   * Label of the `SessionConfigSelectGroup` this choice arrived under
   * (commonly the vendor); absent when the agent ships a flat option list.
   * Deliberately never guessed from name/value — vendors cross-list models,
   * so only the agent's own grouping is trustworthy.
   */
  group?: string
}

/** A parsed `category: model | thought_level` select option for one agent. */
export interface AcpCatalogOption {
  configId: string
  name: string
  /**
   * `'boolean'` for an on/off toggle: `currentValue` is the string `'true'` /
   * `'false'` (the catalog stays string-typed so every existing reader keeps
   * working) and `choices` is empty. Absent means the ordinary select.
   */
  kind?: 'boolean'
  /** Currently selected value at parse time (may be absent from `choices`). */
  currentValue: string | null
  choices: AcpCatalogChoice[]
}

/**
 * The per-category catalog derived from one agent's `configOptions`.
 *
 * `mode` is the agent's own permission/working mode published as a
 * `category: 'mode'` select. It duplicates the `modes` field of `session/new`
 * on the agents observed so far (omp, codebuddy), but it is the only copy a
 * conversation can read BEFORE it has a live session — which is exactly the
 * window in which the composer must still show the control (user report,
 * 2026-10-18: the mode select vanished on a conversation set up ahead of its
 * first message).
 *
 * `extras` are the agent's REMAINING select options (temperature, vendor
 * switches, `model_config` entries, anything unknown). They have no dedicated
 * control in the composer, so they ride the "advanced" base to the left of the
 * model chip. Keeping them here — rather than in the browser's raw
 * `configOptions` — is what lets a conversation with no live session show and
 * set them.
 */
export interface AcpAgentCatalog {
  model?: AcpCatalogOption
  thought?: AcpCatalogOption
  mode?: AcpCatalogOption
  extras?: AcpCatalogOption[]
}

/**
 * Everything one DSH chat conversation has chosen for its ACP agent — the
 * plugin's own per-conversation record, persisted with the agent registry.
 *
 * Every field is a PICK, not a live-session fact: a conversation can be set up
 * before it has ever run a turn (that is the whole point — choosing the agent,
 * model and thought level BEFORE the first message rather than discovering you
 * cannot). Nothing here is a DSH model route (see the module header): these
 * values are applied to the agent's `session/new` / `session/set_config_option`
 * on the next turn, and re-applied when a session is recreated or resumed.
 */
export interface AcpConversationChoice {
  /** The ACP agent serving this conversation. */
  agentId: string
  /**
   * Whether this conversation has LOCKED its agent: its first ACP turn has
   * STARTED. From then on the agent cannot be switched — a different agent has
   * none of the context — so the composer hides its picker and the host
   * refuses `session/chat-bind` to another agent (`agent_locked`). The lock is
   * provisional until that turn produces a visible block: a first turn that
   * delivers nothing is rolled back and the conversation is free again. Once
   * delivered, the lock is permanent; start a new conversation to use another
   * agent.
   */
  locked?: boolean
  /**
   * The agent's model as an adapter model id (`agentId` = the agent's default,
   * `agentId@choice` = an explicit variant). Absent means "the agent's default".
   */
  modelId?: string
  /** The agent's own `thought_level` value. Absent means "the agent's default". */
  effort?: string
  /**
   * The agent's own working mode (`session/set_mode`: `plan` / `acceptEdits` /
   * …). Absent means "whatever the agent starts on".
   *
   * This is the agent's vocabulary for HOW it works, distinct from the model and
   * the thought level, but it sits in the same composer bar — so it belongs to
   * the same "remember what the user last chose here" contract rather than being
   * the one control that resets every time the process restarts.
   */
  mode?: string
  /**
   * The agent's extra `configOptions`, by `configId` (the "advanced" base).
   * Absent means "none chosen"; individual keys absent mean "the agent's own
   * current value". These are the same values `session/set_config_option`
   * accepts, persisted per conversation so a pick survives a restart and is
   * re-applied when its ACP session is recreated or resumed.
   */
  extraConfigs?: Record<string, string | boolean>
}

/** Result of `agent/probe-models`: the freshly probed (or cached) catalog. */
export interface AgentProbeModelsResult {
  agentId: string
  catalog: AcpAgentCatalog
  updatedAt: number
}

/** One of the agent's extra select options, shaped for the composer's advanced menu. */
export interface AgentCatalogExtraOption {
  configId: string
  /** The agent's own option name (falls back to the config id host-side). */
  name: string
  /**
   * `'boolean'` for an on/off toggle (`currentValue` is `'true'` / `'false'`,
   * `choices` is empty and the composer renders a checkbox row). Absent means
   * the ordinary select. Kept optional so cached catalogs written before
   * toggles existed still read.
   */
  kind?: 'boolean'
  /** The value the agent reports as current, when it reports one. */
  currentValue?: string
  choices: Array<{ id: string; name: string; description?: string }>
}

/**
 * Result of `agent/catalog`: the ACP model surface for ONE agent.
 *
 * THIS IS THE ONLY PLACE ACP MODELS EXIST. DSH builds its provider/model
 * catalog per *request*, not per session — `buildModelCatalog(ctx)` takes no
 * session id, so every session's model directory is that same global list. A
 * provider that advertises models therefore advertises them to every
 * conversation, including the ones where the external agent has no tool
 * registration, no runtime context and is not the model talking at all. The
 * `acp` route consequently advertises nothing (`LlmAdapter.listModels` is
 * advisory — exact ids still resolve and stream), and the plugin's own seats
 * read this per-agent view instead. There is no per-session seam on the host
 * to filter the global catalog with, so "advertise nothing" is the only
 * structurally honest isolation.
 *
 * Read-only and memory-only: it never spawns and never starts a probe, not
 * even for an agent with no cached catalog — that case is reported honestly
 * (`probed: false`, `base` entry only). A catalog fills only from a gesture:
 * the agent's own `session/new` / `session/load`, the settings card's
 * `agent/probe-models` button, or an on-disk cache. (Boot-time probing used
 * to exist and no longer does — see `BridgeManager.bootstrapCatalogs`.)
 */
export interface AgentCatalogResult {
  agentId: string
  /** Agent display name (`title` ?? id). */
  title: string
  /**
   * The bare-`agentId` entry: the route that means "let the agent choose its own
   * model". Its `name` spells out the model that route CURRENTLY resolves to
   * (`<agent> · <model>`) — the bare route is not a model, so naming it after the
   * agent alone left the checked row in the picker saying nothing about which
   * model was in force.
   */
  base: { id: string; name: string; description?: string }
  /** The `agentId@choice` variants this agent exposes (`exposedModels` applied). */
  variants: Array<{ id: string; name: string; description?: string }>
  /**
   * Reasoning efforts from the agent's own `thought_level` option, when it
   * advertises one. Agent-wide by construction (a thought level is not a
   * property of one model), which is why it rides here and not on `variants`.
   */
  reasoning?: LlmModelReasoningInfo
  /**
   * The model the agent itself reports as selected (`model.currentValue`).
   *
   * This is what the model chip shows for a conversation that has not picked
   * anything yet: without it the chip has no label and therefore does not
   * render at all, so an agent the user simply has not tuned yet looks like an
   * agent with no model axis (user report, 2026-10-18). Its absence is
   * meaningful — an agent that publishes no `category: 'model'` select has no
   * model axis, and the chip stays away.
   *
   * NOTE the difference from `base`: `base` is a ROUTE (bare `agentId`), this is
   * a MODEL VALUE (a choice id). The picker needs both — one to name the route,
   * one to mark the row the conversation is actually on.
   */
  currentModel?: { value: string; name: string; description?: string }
  /**
   * The agent's own MODE options (`category: 'mode'`, e.g. codebuddy's
   * `Always Ask` … `Bypass Permissions`).
   *
   * The live composer select reads the `modes` field of `session/new` /
   * `session/load`; this copy exists for the window before one exists. It is
   * the same list on every agent observed so far (omp, codebuddy), and it is
   * the only source a conversation set up ahead of its first message has.
   */
  mode?: {
    /** The agent's current mode id, when it reports one. */
    currentValue?: string
    choices: Array<{ id: string; name: string; description?: string }>
  }
  /**
   * The agent's remaining select options — everything that is not the model,
   * the thought level, or the mode. Empty/absent means the composer shows no
   * advanced base.
   */
  extras?: AgentCatalogExtraOption[]
  /**
   * The slash commands this agent declared in its most recent session
   * (`available_commands_update`), cached per agent.
   *
   * A live session reports its own list through `session/chat-list`, and that
   * one always wins. This copy exists for the window BEFORE a conversation has
   * an ACP session: typing `/` in a fresh NTR conversation must list the
   * agent's commands, the way the native menu lists DSH's — waiting for the
   * first message to discover them is what makes the menu look empty.
   */
  commands?: SessionView['availableCommands']
  /** When those commands were last observed. */
  commandsUpdatedAt?: number
  /** A probe has produced a catalog for this agent (`false` → base entry only). */
  probed: boolean
  /** When the cached catalog was last refreshed. */
  updatedAt?: number
}

// ---- LLM Streaming & Adapter types (shared with DSH core LLM service) ----

export interface LlmModelInfo {
  provider: string
  id: string
  name: string
  description?: string
  inputModalities?: readonly string[]
}

/** One reasoning effort advertised by a model (mirrors DSH `LlmReasoningEffortInfo`). */
export interface LlmReasoningEffortInfo {
  id: string
  name: string
  description?: string
}

/** Reasoning metadata (mirrors DSH `LlmModelReasoningInfo`): `defaultEffort` must be one of `efforts`. */
export interface LlmModelReasoningInfo {
  efforts: readonly LlmReasoningEffortInfo[]
  defaultEffort?: string
}

export interface LlmResolvedModelInfo extends LlmModelInfo {
  context?: { contextWindow: number }
  defaultMaxTokens?: number
  reasoning?: LlmModelReasoningInfo
}

export interface LlmProviderInfo {
  id: string
  name: string
}

export type StreamChunk =
  | { type: 'block-start'; index: number; blockType: 'text' | 'reasoning' | 'tool-call' | 'tool-result' }
  | { type: 'text-delta'; index: number; text: string }
  | { type: 'reasoning-delta'; index: number; text: string }
  | { type: 'tool-call-delta'; index: number; id: string; name?: string; argumentsDelta: string }
  | { type: 'block-end'; index: number; block: unknown }
  | { type: 'usage'; usage: { inputTokens: number; outputTokens: number } }
  | {
    type: 'finish'
    reason:
      | { kind: 'stop' }
      | { kind: 'aborted'; failure?: { message: string; code: string } }
      | { kind: 'error'; failure?: { message: string; code: string } }
  }

/**
 * Provenance of one message in a host-built request. The host tags every
 * message, and the tag is the only way to tell the user's own words apart from
 * the context sections the harness injects around them (`agent-instructions`,
 * `skill-catalog`, the `@deepseek-ai/dsh-system-prompt` runtime snapshot, tool
 * results) — see AGENTS.md rule 16.
 */
export interface GenerateMessageSource {
  kind?: string
  plugin?: string
  form?: string
  [k: string]: unknown
}

export interface GenerateMessage {
  role: 'system' | 'user' | 'assistant'
  content: Array<{ type: string; text?: string; [k: string]: unknown }>
  /** Host provenance; absent sources are treated as real user input (hand-built callers). */
  source?: GenerateMessageSource
  /** Stable identity of the durable message, when the host built the request from a session log. */
  id?: string
}

export interface GenerateOptions {
  provider: string
  model: string
  /** Adapter-owned reasoning effort selected for this exact model. */
  reasoningEffort?: string
  messages: GenerateMessage[]
  system?: string
  signal?: AbortSignal
  sessionId?: string
  /**
   * Auxiliary (non-conversation) call classification, e.g. `session-title` or
   * `compaction`. Ordinary turns leave it unset; an ACP bridge must never turn
   * one of these into a remote agent turn.
   */
  purpose?: string
}

export interface PreparedAdapterCall {
  readonly model: LlmResolvedModelInfo
  stream(options: GenerateOptions): AsyncIterable<StreamChunk>
}

export interface LlmAdapterLike {
  providerInfo?(provider: string): LlmProviderInfo
  providerRetryPolicy?(provider: string): unknown
  imageRequestPricing?(provider: string, model: string): unknown
  listModels?(provider: string): Promise<readonly LlmModelInfo[]>
  resolveModel?(provider: string, model: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo>
  prepareCall?(provider: string, model: string, signal?: AbortSignal): Promise<PreparedAdapterCall>
  stream(options: GenerateOptions): AsyncIterable<StreamChunk>
}

