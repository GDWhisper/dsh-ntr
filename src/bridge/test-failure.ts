import type { AgentTestFailureKind } from '../protocol.ts'
import type { StartAttempt } from './types.ts'

/**
 * Name one failed `agent/test` from the attempt's own facts.
 *
 * The timeout is read first: it is the only fact that proves the process RAN,
 * and a spawn error arriving after the teardown is stale noise about a child
 * nobody was waiting for any more. The rest follows the order of the events:
 * spawn → resolution → exit → a connection that dropped with no fact at all.
 */
export function classifyTestFailure(attempt: StartAttempt | undefined): AgentTestFailureKind {
  if (attempt === undefined) return 'handshake-failed'
  if (attempt.timedOut) return 'timeout'
  // The spawn's own error is the second-strongest fact: `spawn` RETURNS a
  // handle even when the program does not exist (the ENOENT arrives as an
  // event), so `spawned` can be true here and this must be read before it.
  if (attempt.spawnError !== undefined) {
    // ENOENT means "install it" only when nothing was ever resolved. A path WAS
    // found and then failed to launch, so the fix is not a reinstall.
    return attempt.spawnError.code === 'ENOENT' && attempt.executablePath === undefined
      ? 'not-found'
      : 'start-failed'
  }
  if (!attempt.spawned) {
    // Nothing was spawned and there is no spawn error: the failure happened
    // while RESOLVING the command, i.e. inside the npm auto-install.
    return attempt.installTried ? 'install-failed' : 'not-found'
  }
  if (attempt.exit !== undefined) return 'start-failed'
  return 'handshake-failed'
}
