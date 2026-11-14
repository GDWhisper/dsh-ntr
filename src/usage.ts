/**
 * One ACP `usage_update` as a context reading, kept honest at the boundary.
 *
 * WHY THIS EXISTS: CodeBuddy reports a team member's (background subagent's)
 * credit as a `usage_update` on the LEADER session with `used: 0, size: 0` and
 * a cost — that run has no context window it could name. Storing it verbatim
 * replaced the leader's own occupancy with 0/0, so the composer ring lost its
 * sample and vanished until the next real reading arrived; a 0/0 record also
 * persisted, which kept the ring hidden across reloads. A cost-only sample is a
 * cost fact, not a context reading: this module merges that fact into the last
 * good reading instead of overwriting it.
 *
 * Pure on purpose (type-only import of the protocol shape): the bridge records
 * with it, and `src/protocol.ts` stays the only home of the wire types.
 */
import type { SessionView } from './protocol.ts'

/** The fields of one `usage_update` the merge reads; every other field is ignored. */
export interface UsageSample {
  used?: unknown
  size?: unknown
  cost?: unknown
}

/** A cost value worth keeping: a finite amount and a currency string ('' included). */
function usableCost(value: unknown): { amount: number; currency: string } | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const row = value as { amount?: unknown; currency?: unknown }
  if (typeof row.amount !== 'number' || !Number.isFinite(row.amount)) return undefined
  if (typeof row.currency !== 'string') return undefined
  return { amount: row.amount, currency: row.currency }
}

/** The readable half of a sample: a finite non-negative `used` and a finite positive `size`. */
function usableReading(sample: UsageSample): { used: number; size: number } | undefined {
  const used = sample.used
  const size = sample.size
  if (typeof used !== 'number' || !Number.isFinite(used) || used < 0) return undefined
  if (typeof size !== 'number' || !Number.isFinite(size) || size <= 0) return undefined
  return { used, size }
}

/**
 * Merge one `usage_update` into the last good reading.
 *
 * A readable sample replaces the reading; its cost replaces the old one only
 * when the frame carries a usable one. A degenerate sample — the cost-only
 * team-member tick, or any malformed frame — must not erase what the agent
 * already reported: the last good `used`/`size` survive and a cost carried by
 * the tick still lands. With no reading to keep, the sample is dropped whole:
 * a session with no context window yet has no occupancy to report, and a stored
 * 0/0 would only outlive the frame that produced it.
 *
 * `undefined` means "this session has no context reading".
 */
export function mergeUsageSample(
  previous: SessionView['usage'] | undefined,
  sample: UsageSample,
): SessionView['usage'] | undefined {
  const cost = usableCost(sample.cost)
  const reading = usableReading(sample)
  if (reading !== undefined) return { ...reading, ...(cost === undefined ? {} : { cost }) }
  if (previous === undefined) return undefined
  return cost === undefined ? previous : { ...previous, cost }
}
