/**
 * Timing and IO bounds for one agent process (see `AgentBridge`). Moved
 * verbatim out of `agent-bridge.ts` — which re-exports the two public
 * constants — to keep that file inside the size ratchet.
 */

export const STDERR_TAIL_LINES = 40
/** Single fs/read_text_file answer cap — agents reading huge files must page via `line`/`limit`. */
export const FS_MAX_READ_BYTES = 2 * 1024 * 1024
/** Single fs/write_text_file payload cap. */
export const FS_MAX_WRITE_BYTES = 2 * 1024 * 1024

/**
 * How long a stop waits for the agent to answer `session/close` before killing
 * the child anyway. The capability is optional and the LOCAL teardown is what
 * actually frees the session, so a wedged agent must not be able to hang a
 * stop — and with it the stall reclaim that calls it — forever.
 */
export const SESSION_CLOSE_TIMEOUT_MS = 5_000

/**
 * Fire-and-forget kill: the whole disposal budget for the non-teardown paths
 * (see `KILL_ESCALATION_GRACE_MS` for how it splits). Same 3s the old inline
 * SIGKILL timer used before escalating.
 */
export const KILL_ESCALATION_DELAY_MS = 3_000

/**
 * Budget for disposing a child whose start was invalidated by a teardown (see
 * `AgentBridge.spawnAndConnect`). Short: that child was spawned moments ago and
 * never served anything, so there is nothing to drain.
 */
export const STALE_START_KILL_BUDGET_MS = 2_000

/**
 * How long `BridgeManager.testAgent` waits for a failed start's child to report
 * its `exit` before writing the verdict (see `AgentBridge.awaitStartChildExit`).
 * A process that is already gone reports in microseconds; this only bounds the
 * pathological case, and it delays a user-visible answer, so it stays small.
 */
export const TEST_EXIT_GRACE_MS = 250

/**
 * The WHOLE host-shutdown budget for killing children, shared by every bridge
 * (bridges run concurrently, so this is the worst case for all of them, not
 * per bridge). One number, one deadline: `AgentBridge.shutdown` hands what is
 * LEFT of it to `killChildAndWait`, and `disposeChild` reserves the escalation
 * grace inside that — so the graceful wait gets at most 4s − 500ms and the
 * whole disposal, escalation included, never exceeds 4s.
 */
export const SHUTDOWN_BUDGET_MS = 4_000
