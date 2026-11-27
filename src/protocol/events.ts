/**
 * Host → browser events: the folded `AcpEvent` frames carried by `/api/acp/stream` (SSE).
 *
 * Part of the protocol contract; the barrel is `src/protocol.ts` and every
 * existing `../protocol.ts` import keeps resolving through it. Pure types,
 * constants and pure helpers only — no side effects, no Node APIs, no ACP SDK
 * runtime values (type-only SDK imports are erased at build time).
 */

import type { SessionUpdate } from '@agentclientprotocol/sdk'
import type { SubagentRecord } from '../protocol-subagent.ts'
import type { ElicitationFieldView } from './elicitation.ts'
import type { PermissionTimeoutMode, QuestionTimeoutMode } from './ui.ts'
import type { SaveGateStatus } from './save-gate.ts'
import type { AcpReleaseCause, AgentProcessState, AgentView, SessionView } from './views.ts'

// ---- Host → browser events (`/api/acp/stream`, SSE) ----

/**
 * What one `session/request_permission` ask actually IS.
 *
 * `approval` (default) is the protocol's own meaning: may this operation run.
 * `question` is Antigravity's use of the same method for its own fixed-choice
 * questions (`toolCallId` prefix `interaction_`). The distinction is the
 * plugin's reading of the wire, not a protocol field — see
 * docs/plan/agy-question-asks.md.
 */
export type PermissionAskKind = 'approval' | 'question'

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
    /** Host's release-cause classification; absent on an older host half. */
    cause?: AcpReleaseCause
    /** Epoch ms when the host parked the session; absent on an older host half. */
    releasedAt?: number
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
   * One agent's definition changed outside `agent/save`: the settings panel
   * edited `exposedModels`, the auto-discovery switch was flipped, the
   * per-agent `dsh-skills` opt-out was toggled, or an observed catalog
   * contributed newly published models. The browser patches its copy of the
   * agent definition (the settings card) and re-reads `agent/catalog` (the
   * composer's seat list). An ABSENT `exposedModels` means the filter is unset
   * (default-open: every published model is offered); `[]` means the user
   * explicitly narrowed it to nothing (base row only). `skillsMcpEnabled` is
   * the RESOLVED per-agent answer (`!== false`), not the raw optional field.
   */
  | {
    type: 'agent/exposure'
    agentId: string
    /** Unset = default-open (never narrowed); `[]` = explicitly nothing listed. */
    exposedModels?: string[]
    autoDiscoverModels: boolean
    skillsMcpEnabled: boolean
    /** Resolved per-agent opt-in to unified shared/host MCP servers (`!== false`). */
    sharedMcpEnabled?: boolean
    /** New-chat default mode; absent = follow the agent's own initial mode. */
    defaultMode?: string
  }
  /**
   * One outstanding ask, broadcast ONCE when it is created and replayed as-is
   * to every freshly connected client (see `permission/synced`).
   *
   * Every ACP permission ask carries everything the conversation card needs:
   * who owns it (`dshSessionId`), what it is about (`toolCall` + the derived
   * `toolName` / `reason`), the options to render verbatim, and the deadline in
   * force. The host never answers on its own outside an expired `abort` /
   * `auto` deadline, so this frame (and its replay) is the answer entry.
   */
  | {
      type: 'permission/request'
      requestId: string
      /** ACP session id the ask belongs to. */
      sessionId: string
      /** DSH chat session id; absent for `/acp` RPC-only sessions. */
      dshSessionId?: string
      /** Raw ACP `ToolCallUpdate` the agent sent — never summarized away. */
      toolCall: unknown
      /** Host-derived human name (`permissionToolName`, `_meta` fallback included). */
      toolName: string
      /** One-line detail from the agent's declared input, when it has any. */
      reason?: string
      options: PermissionOptionView[]
      /** What an unanswered ask does when its deadline fires. */
      timeoutMode: PermissionTimeoutMode
      /** Epoch ms of the deadline; absent in `wait` mode (no deadline). */
      deadlineAt?: number
      /** Absent = `approval`: an older host never says the word. */
      askKind?: PermissionAskKind
      /** Only on a question ask: what an expired deadline does. */
      questionTimeoutMode?: QuestionTimeoutMode
      /** Only on a question ask that WILL be answered on expiry: the option the host will send. */
      autoOptionName?: string
    }
  | { type: 'permission/resolved'; requestId: string; sessionId: string; outcome: PermissionOutcome }
  /**
   * An ask whose deadline fired and was settled by the plugin itself — refused
   * (`abort`), or answered with the option the agent's own kinds imply
   * (`auto`).
   *
   * This is the conversation's record of the expiry: the card it was answering
   * is gone, so without this frame the user would see it vanish with nothing
   * said about it.
   */
  | {
      type: 'permission/expired'
      sessionId: string
      /** Absent = `approval`; a question's expiry reads differently in the chat. */
      askKind?: PermissionAskKind
      toolCall: unknown
      /** How long the ask waited before the deadline fired. */
      timeoutMs: number
      /** What the plugin answered with. */
      outcome: PermissionOutcome
      /** The picked option's label, when one was picked (`auto` mode). */
      optionName?: string
    }
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
  /**
   * One outstanding ACP form elicitation (`elicitation/create`), broadcast once
   * on creation and replayed as-is on SSE reconnect (terminated by
   * `elicitation/synced`).
   */
  | {
      type: 'elicitation/request'
      requestId: string
      sessionId: string
      dshSessionId?: string
      toolCallId?: string
      message: string
      title?: string
      description?: string
      /** Ordered form fields derived from requestedSchema. */
      fields: ElicitationFieldView[]
      /** Count of schema properties omitted for exceeding the field or name caps. */
      omittedFields?: number
      /** Count of selectable options omitted for exceeding caps or malformed shape. */
      omittedOptions?: number
      /** Epoch ms when the elicitation expires and auto-cancels; absent when unbounded. */
      deadlineAt?: number
    }
  | { type: 'elicitation/resolved'; requestId: string; sessionId: string; action: 'accept' | 'decline' | 'cancel' }
  | { type: 'elicitation/synced'; requestIds: string[] }
  | { type: 'turn/start'; sessionId: string; dshSessionId?: string; turnId: string; text: string }
  | {
      type: 'turn/metrics'
      /** ACP session id (the store keys live burst state by it). */
      sessionId: string
      /** DSH chat session id (routing/context only). */
      dshSessionId: string
      turnId: string
      /** Session aggregate INCLUDING the current turn when measurable. */
      outputTokens: number
      burstMs: number
      final: boolean
    }
  | { type: 'turn/end'; sessionId: string; turnId: string; stopReason?: string; error?: string; errorKind?: 'quota' }
  /**
   * The save gate's state changed: an ACP turn started/ended, a profile write
   * was queued, flushed, expired or failed. The browser renders the pending
   * toast from this frame; the settings page's own save promise is the host
   * half's business.
   */
  /**
   * A deferred profile HMR reconciliation settled (succeeded or superseded at
   * idle). Clears any lingering `hmr-delay` banner in the browser.
   */
  | { type: 'hmr/settled' }
  | { type: 'save/status'; status: SaveGateStatus }
  /**
   * One external worker's plugin-owned lifecycle record changed state.
   *
   * Broadcast on CREATION and on every status transition — never per worker
   * update, and deliberately NOT gated on the host catalog accepting the row:
   * an unreported dispatch ("目录待同步") must still reach the browser. The
   * terminal frame is the browser's proof the row will not stay running.
   */
  | { type: 'subagents/record'; dshSessionId: string; record: SubagentRecord }
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
  /** Optional security notice propagated from `_meta['agy.security.warning']`. */
  warning?: string
}

export type PermissionOutcome = { outcome: 'selected'; optionId: string } | { outcome: 'cancelled' }
