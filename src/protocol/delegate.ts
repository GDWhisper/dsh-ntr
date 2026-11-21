/**
 * The `acp_delegate` tool's NATIVE (async) output contract
 * (docs/plan/acp-delegate-native-subagent.md §2 / §5).
 *
 * On a host with the `ctx.subagents` seam the tool activates an external
 * subagent and returns IMMEDIATELY with its name — the answer itself arrives
 * later as the host's settlement notification injected into the parent
 * session, never as this tool's result. The legacy synchronous shape
 * (`AcpDelegateResult` in bridge/delegate-service.ts: folded full text) stays
 * for old hosts without the seam; the two shells share one delegation core.
 *
 * Pure types only — browser-safe, no runtime values.
 */

/** A delegation was accepted: the child runs in the background under `name`. */
export interface AcpDelegateActivationOutput {
  kind: 'activation'
  /** The host-minted model-facing subagent name (the interrupt/discovery handle). */
  name: string
  /** The configured ACP agent id serving the delegation. */
  agent: string
}

/**
 * A delegation was refused BEFORE any child ran (validation, capacity,
 * authorization, missing provider). `error` is model-facing and names the
 * cause (e.g. ACTIVATION_LIMIT_REACHED) so the model can react instead of
 * waiting for a notification that will never come.
 */
export interface AcpDelegateErrorOutput {
  kind: 'error'
  error: string
  /** The resolved agent id, when resolution got that far. */
  agent?: string
}

/** The native shell's whole return vocabulary. */
export type AcpDelegateAsyncOutput = AcpDelegateActivationOutput | AcpDelegateErrorOutput