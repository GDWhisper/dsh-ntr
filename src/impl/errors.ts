/**
 * The host half's structured failure type.
 *
 * The RPC layer converts it to `{ok:false, error}` and `apply()` surfaces it at boot.
 *
 * Part of the host-half logic; the barrel is `src/impl.ts` and every existing
 * `../impl.ts` import keeps resolving through it. Pure logic only — no Node
 * APIs, no ACP SDK runtime values.
 */

/** Structured failure the RPC layer converts to `{ok:false, error}` and `apply()` surfaces at boot. */
export class AcpError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
  }
}
