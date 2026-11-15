/**
 * Shared `AcpStore` fakes for the class-driven store tests (split plan P3b).
 *
 * The store suites that moved into `tests/store/` all drive the real facade
 * through a recording RPC face; the worker-detail cases also need the same
 * keyed snapshot lookup. Both live here so a case reads the same in whichever
 * file it sits.
 */

import { AcpStore, subagentKey } from '../../src/client/store.ts'
import type { SubagentDetailState } from '../../src/client/store.ts'

/** One host answer the fake RPC face produces (the `/acp` envelope). */
export type StoreRpcAnswer = { ok: boolean; value?: unknown; error?: { code: string; message: string } }
/** The scripted host answer for one endpoint; the default answers `{}`. */
export type StoreRpc = (endpoint: string, payload: unknown) => Promise<StoreRpcAnswer>

export interface StoreHarness {
  store: AcpStore
  calls: Array<{ endpoint: string; payload: unknown }>
  apply(event: unknown): Promise<void>
}

/** Build an `AcpStore` over a recording RPC face (and an `applyEvent` that bypasses the SSE stream). */
export function makeStore(rpc: StoreRpc = async () => ({ ok: true, value: {} })): StoreHarness {
  const calls: Array<{ endpoint: string; payload: unknown }> = []
  const store = new AcpStore(async (_channel, endpoint, payload) => {
    calls.push({ endpoint, payload })
    return rpc(endpoint, payload) as never
  }, (zh) => zh)
  const apply = (event: unknown): Promise<void> =>
    (store as unknown as { applyEvent(event: unknown): Promise<void> }).applyEvent(event)
  return { store, calls, apply }
}

/** One worker's detail index as the panel reads it (keyed by conversation + child id). */
export function detailOf(store: AcpStore, childId: string, dshSessionId = 'chat-1'): SubagentDetailState | undefined {
  return store.getSnapshot().subagentDetails[subagentKey(dshSessionId, childId)]
}
