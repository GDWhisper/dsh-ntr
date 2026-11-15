/**
 * The pure save-gate readers, verbatim from `tests/store.spec.ts` (split plan
 * P3a test mirror). Only the snapshot comparison is pure; the rest of the
 * `save banners` suite drives `AcpStore` and stays in `tests/store.spec.ts`.
 */

import { describe, expect, it } from 'vitest'
import { saveGateTransitions } from '../../src/client/store/save-gate.ts'

describe('save banners', () => {
  it('compares gate snapshots by label and terminal status, not by a browser clock', () => {
    const idle = { canSave: true, activeTurns: 0, activeSessions: [], pending: [], timeoutMs: 600_000 }
    const pending = {
      ...idle,
      canSave: false,
      activeTurns: 1,
      pending: [{ id: 'save-1', label: 'agent-save:pi', queuedAt: 1 }],
    }
    const settled = {
      ...idle,
      lastOutcomes: { 'agent-save:pi': { at: 5, status: 'failed' as const, label: 'agent-save:pi', message: 'x' } },
    }
    const first = saveGateTransitions(undefined, pending)
    expect(first.addedPending).toHaveLength(1)
    expect(first.outcomes).toEqual([])
    const second = saveGateTransitions(pending, settled)
    expect(second.outcomes).toEqual([
      { label: 'agent-save:pi', outcome: settled.lastOutcomes['agent-save:pi'], wasPending: true, isPending: false },
    ])
    expect(saveGateTransitions(settled, settled).outcomes).toEqual([])
  })
})
