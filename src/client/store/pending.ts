/**
 * Shared pure helpers for client-side pending human-input requests
 * (permissions and form elicitations): per-session dock filtering and
 * idempotent SSE frame folding (`upsert`, `remove`, `synced`).
 */

export function pendingForSession<T extends { dshSessionId?: string }>(
  items: readonly T[],
  dshSessionId: string,
): T[] {
  return items.filter(item => item.dshSessionId === dshSessionId)
}

export function upsertPendingRequest<T extends { requestId: string }>(
  items: readonly T[],
  entry: T,
): T[] {
  return [...items.filter(item => item.requestId !== entry.requestId), entry]
}

export function removePendingRequest<T extends { requestId: string }>(
  items: readonly T[],
  requestId: string,
): T[] {
  return items.filter(item => item.requestId !== requestId)
}

export function syncPendingRequests<T extends { requestId: string }>(
  items: readonly T[],
  liveIds: readonly string[],
): T[] {
  const live = new Set(liveIds)
  return items.filter(item => live.has(item.requestId))
}
