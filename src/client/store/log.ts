/**
 * The runtime log's id source and patch builder, lifted out of `AcpStore`
 * (kept small so the facade stays inside its line budget).
 *
 * Pure bookkeeping: ONE monotonic id sequence per page — a service that builds
 * log rows of its own mints ids from the same source — and the patch shape for
 * one line. `patch` never mutates: the caller folds it into the single
 * `mutate` it was already making for the same event.
 */

import type { AcpLogEntry, UiState } from './state.ts'
import { LOG_MAX_ENTRIES } from './state.ts'

export class LogService {
  /** Monotonic id source for {@link AcpLogEntry}s (never reset by `clearLogs`). */
  private seq = 0

  /** Allocate one runtime-log line. */
  line(level: 'info' | 'error', text: string, agentId?: string): AcpLogEntry {
    return {
      id: ++this.seq,
      at: Date.now(),
      level,
      text,
      ...(agentId === undefined ? {} : { agentId }),
    }
  }

  /** The log patch for one line, against the current snapshot. */
  patch(state: UiState, level: 'info' | 'error', text: string, agentId?: string): Pick<UiState, 'logs' | 'logUnread'> {
    const entry = this.line(level, text, agentId)
    return {
      logs: [...state.logs, entry].slice(-LOG_MAX_ENTRIES),
      logUnread: state.logUnread + 1,
    }
  }
}
