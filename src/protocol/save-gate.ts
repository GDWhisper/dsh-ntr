/**
 * The save gate: the host snapshot and RPC shapes that hold profile writes while ACP turns are owed.
 *
 * Part of the protocol contract; the barrel is `src/protocol.ts` and every
 * existing `../protocol.ts` import keeps resolving through it. Pure types,
 * constants and pure helpers only — no side effects, no Node APIs, no ACP SDK
 * runtime values (type-only SDK imports are erased at build time).
 */

import type { ActiveTurnView } from './views.ts'

/** One save waiting for every ACP turn to finish. */
export interface SaveGatePendingView {
  id: string
  /** Human label of the write being held (`settings:llm-pi-ai`, ...). */
  label: string
  queuedAt: number
  /** Epoch ms when the bounded wait expires; absent when the wait is unbounded. */
  deadlineAt?: number
}

/** Terminal result of one deferred save, for the toast and for host callers. */
export interface SaveGateOutcomeView {
  at: number
  status: 'saved' | 'expired' | 'failed' | 'cancelled'
  label: string
  /** Failure detail, present for `failed`. */
  message?: string
  /**
   * Present on `cancelled` when a NEWER save of the same label displaced this
   * queued entry (rather than the user cancelling it explicitly). The toast
   * can then say "superseded by a newer save" instead of a bare cancellation.
   */
  superseded?: boolean
}

/**
 * The plugin's answer to "may a profile write happen now?".
 *
 * This is deliberately a state snapshot, not a command: the host settings
 * service asks before writing, the browser renders the pending queue, and the
 * ACP conversation keeps running without a profile reload. `canSave` is true
 * exactly when no ACP turn is owed by an agent.
 */
export interface SaveGateStatus {
  /**
   * Whether a live {@link AcpSaveGate} produced this snapshot. `false` on an older
   * host half and after that gate is disposed: the settings form must not offer
   * queue / force affordances the snapshot cannot honour.
   */
  gateAvailable: boolean
  canSave: boolean
  activeTurns: number
  activeSessions: ActiveTurnView[]
  pending: SaveGatePendingView[]
  /** Bounded wait for one queued save, in ms; 0 means "no expiry". */
  timeoutMs: number
  lastOutcome?: SaveGateOutcomeView
  /**
   * Most recent terminal result PER LABEL. Two agents can hold saves at the
   * same time; the settings form reads its own label here so one agent's
   * settlement never clears another agent's held state.
   */
  lastOutcomes?: Record<string, SaveGateOutcomeView>
}

/** What one deferred save settled to. */
export type SaveGateOutcome =
  | { status: 'saved'; value: unknown }
  | { status: 'expired' }
  /**
   * `superseded` is set only when a newer save of the same label cancelled
   * this queued entry. An explicit `save/cancel` settles a bare `cancelled`.
   */
  | { status: 'cancelled'; superseded?: boolean }
  | {
      status: 'failed'
      message: string
      /**
       * The original refusal (for example a settings revision conflict). Host
       * callers rethrow it so the API controller's error classification is
       * unchanged; the browser only ever sees `message` via the status view.
       */
      error?: unknown
    }

/** Counts returned by an explicit "save now" gesture. */
export interface SaveGateFlushResult {
  saved: number
  expired: number
  failed: number
  /** Entries dropped because a newer save / delete cancelled them. */
  cancelled?: number
}

/** Payload of `save/cancel`: drop the held write carrying this label. */
export interface SaveGateCancelPayload {
  label: string
}

/** Count of queued writes the cancel gesture dropped. */
export interface SaveGateCancelResult {
  cancelled: number
}

/** Payload of `save/retry`: re-run the last failed/expired write of a label. */
export interface SaveGateRetryPayload {
  label: string
}

/** Whether the gate still retained an operation to re-run. */
export interface SaveGateRetryResult {
  retried: boolean
}

/** One save gate's bounded wait before it gives up and asks the user to retry. */
export const DEFAULT_SAVE_GATE_TIMEOUT_MS = 600_000
