/**
 * The browser's per-worker detail indexes, lifted out of `AcpStore` (split plan
 * P3b): the on-demand history read (`subagents/detail`), the LRU bound, and the
 * live-frame fold that feeds an OPEN index from the coalesced update batch.
 *
 * The live order (`detailLiveSeq`) belongs to this cluster: an index only
 * exists once its detail was opened in this page, and every later frame that
 * matches it is replayed over the history read by that mark. Nothing else in
 * the store appends entries.
 *
 * The service never imports the facade; the RPC face, the snapshot and the
 * write path arrive through {@link SubagentDetailHost}.
 */

import type { SubagentDetailResult } from '../../protocol.ts'
import { MAX_SUBAGENT_DETAIL_ENTRIES } from '../../protocol.ts'
import type { LiveSubagentDetailEntry, SubagentDetailState } from './subagent.ts'
import { MAX_SUBAGENT_DETAIL_WORKERS, boundedDetailEntry, compactDetailValue, subagentKey, subagentToolCallId } from './subagent.ts'
import type { UiState } from './state.ts'

/** What the detail service needs from the store, injected. */
export interface SubagentDetailHost {
  /** The `/acp` RPC face (the store's own `call`, code-preserving errors included). */
  call<T>(endpoint: string, payload?: unknown): Promise<T>
  /** Commit one snapshot patch and notify listeners — the store's single writer. */
  mutate(patch: Partial<UiState>): void
  /** The current snapshot (reads only). */
  state(): UiState
}

export class SubagentDetailService {
  /** Store-local order for live-captured detail entries (see {@link LiveSubagentDetailEntry.liveSeq}). */
  private liveSeq = 0

  constructor(private readonly host: SubagentDetailHost) {}

  /**
   * Ensure one worker's detail index exists and read its history on demand.
   *
   * Creates the index (which is what makes LIVE frames append to it from then
   * on), moves it to the LRU's recent end, and asks the host for the bounded
   * history predating the page (`subagents/detail`) — once for CodeBuddy, on
   * EVERY open of an agy-marked index (no wire frames after creation). Frames
   * landing during a read are replayed over its answer by their `liveSeq`, so
   * a slow read cannot erase a terminal frame the page saw. A failed read
   * leaves the live index alone and retries on the next open.
   */
  async loadSubagentDetail(dshSessionId: string, childId: string): Promise<void> {
    const key = subagentKey(dshSessionId, childId)
    const atRead = this.liveSeq
    const existing = this.host.state().subagentDetails[key]
    const touchedAt = Date.now()
    const opened: SubagentDetailState = existing === undefined
      ? { dshSessionId, childId, entries: [], loaded: false, omitted: 0, touchedAt }
      : { ...existing, touchedAt }
    // Re-insert so an equal-timestamp tie during LRU eviction keeps this one
    // (see `withSubagentDetail`).
    const openedMap = { ...this.host.state().subagentDetails }
    delete openedMap[key]
    openedMap[key] = opened
    this.host.mutate({ subagentDetails: this.withSubagentDetail(openedMap, key) })
    if (opened.loaded && !opened.entries.some(entry => entry.source === 'agy-transcript')) return
    try {
      const result = await this.host.call<SubagentDetailResult>('subagents/detail', { dshSessionId, childId })
      const current = this.host.state().subagentDetails[key]
      if (current === undefined) return
      // Frames applied while the read was in flight are newer than its answer
      // in the only sense that matters (the host may not have seen them yet),
      // so they are replayed over it. A frame the host DID see appears on both
      // sides; the payload comparison drops that copy (a bare seq is not
      // enough: a resumed segment restarts its numbering).
      const hostHistory = new Map<number, Set<string>>()
      for (const entry of result.entries) {
        const copy = hostHistory.get(entry.seq) ?? new Set<string>()
        copy.add(compactDetailValue(entry.update))
        hostHistory.set(entry.seq, copy)
      }
      const live = current.entries.filter(entry => {
        if ((entry.liveSeq ?? 0) <= atRead) return false
        return hostHistory.get(entry.seq)?.has(compactDetailValue(entry.update)) !== true
      })
      const combined = [...result.entries.map(entry => ({ ...entry })), ...live]
      const overflow = Math.max(0, combined.length - MAX_SUBAGENT_DETAIL_ENTRIES)
      this.host.mutate({
        subagentDetails: this.withSubagentDetail({
          ...this.host.state().subagentDetails,
          [key]: {
            ...current,
            entries: overflow > 0 ? combined.slice(overflow) : combined,
            loaded: true,
            omitted: current.omitted + overflow + (result.omitted ?? 0),
            touchedAt: Date.now(),
          },
        }, key),
      })
    } catch {
      // An older host (no endpoint) or a dropped read: the live index stays
      // usable, and the next open retries the one history read.
    }
  }

  /**
   * Append the frames of one batch that belong to an OPEN worker detail index
   * (see {@link UiState.subagentDetails}). Both filters are required: the
   * dispatch's own frames (`toolCallId` — raw input and the terminal frame
   * live there) and the worker's frames
   * (`_meta["codebuddy.ai/parentToolCallId"]`). Scoped by the ACP session's
   * owning conversation, never by `childId` alone.
   *
   * Returns the next map, or `undefined` when nothing matched.
   */
  foldSubagentDetailFrames(
    owner: string,
    items: ReadonlyArray<{ seq: number; update: unknown }>,
    currentMap: Record<string, SubagentDetailState>,
  ): Record<string, SubagentDetailState> | undefined {
    const keys = Object.keys(currentMap)
    if (keys.length === 0) return undefined
    let out: Record<string, SubagentDetailState> | undefined
    for (const item of items) {
      const update = item.update as Record<string, unknown>
      if (update === null || typeof update !== 'object') continue
      const own = typeof update.toolCallId === 'string' && update.toolCallId !== '' ? update.toolCallId : undefined
      const parent = parentToolCallIdOf(update)
      if (own === undefined && parent === undefined) continue
      for (const key of keys) {
        const detail = (out ?? currentMap)[key]
        if (detail === undefined || detail.dshSessionId !== owner) continue
        const toolCallId = subagentToolCallId(detail.childId)
        if (toolCallId === '') continue
        if (toolCallId !== own && toolCallId !== parent) continue
        if (out === undefined) out = { ...currentMap }
        out[key] = appendSubagentDetailEntry(detail, boundedDetailEntry(item.seq, item.update, ++this.liveSeq))
      }
    }
    return out
  }

  /**
   * Apply the {@link MAX_SUBAGENT_DETAIL_WORKERS} LRU. `protect` is never
   * evicted (the worker just opened); among the rest the oldest `touchedAt`
   * goes first.
   */
  private withSubagentDetail(
    map: Record<string, SubagentDetailState>,
    protect?: string,
  ): Record<string, SubagentDetailState> {
    const keys = Object.keys(map)
    if (keys.length <= MAX_SUBAGENT_DETAIL_WORKERS) return map
    const removable = keys
      .filter(key => key !== protect)
      .sort((a, b) => (map[a]?.touchedAt ?? 0) - (map[b]?.touchedAt ?? 0))
    const next = { ...map }
    let excess = keys.length - MAX_SUBAGENT_DETAIL_WORKERS
    for (const key of removable) {
      if (excess <= 0) break
      delete next[key]
      excess -= 1
    }
    return next
  }
}

/** The CodeBuddy worker attribution a live update carries (`parentToolCallId`), if any. */
function parentToolCallIdOf(update: Record<string, unknown>): string | undefined {
  const meta = update._meta
  if (meta === null || typeof meta !== 'object') return undefined
  const value = (meta as Record<string, unknown>)['codebuddy.ai/parentToolCallId']
  return typeof value === 'string' && value !== '' ? value : undefined
}

/** Append one entry to a worker's index, dropping the oldest past the per-worker cap. */
function appendSubagentDetailEntry(
  state: SubagentDetailState,
  entry: LiveSubagentDetailEntry,
): SubagentDetailState {
  const entries = [...state.entries, entry]
  const overflow = entries.length - MAX_SUBAGENT_DETAIL_ENTRIES
  return {
    ...state,
    entries: overflow > 0 ? entries.slice(overflow) : entries,
    // The marker the panel renders: `omitted > 0` means the index does not
    // start at the worker's first frame.
    omitted: state.omitted + Math.max(0, overflow),
  }
}
