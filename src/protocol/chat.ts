/**
 * Chat-session surface: the ACP session backing a DSH conversation, its transcript, and the conversation's own picks.
 *
 * Part of the protocol contract; the barrel is `src/protocol.ts` and every
 * existing `../protocol.ts` import keeps resolving through it. Pure types,
 * constants and pure helpers only — no side effects, no Node APIs, no ACP SDK
 * runtime values (type-only SDK imports are erased at build time).
 */

import type { SubagentRecord } from '../protocol-subagent.ts'
import type { SessionView } from './views.ts'

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
  /**
   * Context occupancy the agent last reported (`usage_update`): prompt-side
   * used/size, not request tokens. Absent until the agent reports one; the
   * browser live-patches this row from the update frames (see AGENTS/ui.md).
   */
  usage?: SessionView['usage']
  /** Measurable burst aggregate over this session's turns; absent until measured. */
  burst?: SessionView['burst']
  /** The agent process died; the session awaits a `session/load` resume. */
  released?: boolean
  /** The agent is running a turn on this session right now. */
  running?: boolean
  /**
   * The plugin's own lifecycle records for this conversation's external
   * workers (status / failure reason / timings / counts). Terminal states are
   * persisted, so a reload or a host restart still answers them where the
   * transcript detail is gone. Attached to every row of the same conversation;
   * the browser de-duplicates by `dshSessionId + childId`. Live transitions
   * arrive as `subagents/record` frames.
   */
  subagents?: SubagentRecord[]
  /**
   * Whether this session's ACP agent can be forked (`session/fork`) into a
   * child conversation, as the host computed it. The browser does not derive
   * this itself — the capability is host knowledge (the agent's
   * `initialize`), and the row is the one place it is delivered.
   * `supported: false` carries the reason; no reason on `false` means the
   * host half predates the field (treat as unsupported).
   */
  fork?: ChatSessionForkInfo
}
/**
 * The host's per-row verdict on forking one chat session's ACP session
 * (`ChatSessionView.fork`). Computed from the agent's LAST KNOWN
 * `sessionCapabilities.fork` (persisted with the model catalog) plus the
 * session's own state — the browser never reads capability bits itself.
 */
export interface ChatSessionForkInfo {
  supported: boolean
  /** Why {@link supported} is false: the agent cannot fork, or the session cannot be forked right now. */
  reason?: 'unsupported' | 'released' | 'busy'
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

/**
 * `session/chat-fork-adopt`: bind the DSH chat session a host `sessions.fork`
 * just created to the SAME agent process, through the agent's own
 * `session/fork` of the parent conversation's ACP session — the second half of
 * the two-stage branch (host builds the DSH tree first, the plugin then adopts
 * the ACP side; see the NTR message-actions plan, §D5/D7).
 *
 * On success the child conversation's next message reaches an agent that
 * actually remembers the parent context. On failure NOTHING is bound: the
 * child stays an ordinary copied-history conversation and its first message
 * starts a fresh `session/new` (today's behavior).
 */
export interface ChatForkAdoptPayload { dshSessionId: string; parentDshSessionId: string }
/** `session/chat-fork-adopt` success: the adopted ACP session's ids. */
export type ChatForkAdoptResult = { sessionId: string; acpSessionId: string }

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
