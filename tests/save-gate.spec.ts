import { describe, expect, it, vi } from 'vitest'
import { AcpSaveGate, SaveGateAborted } from '../src/save-gate.ts'
import type { ActiveTurnView } from '../src/protocol.ts'

function host(initial: boolean, views: ActiveTurnView[] = []) {
  const state = { active: initial, views }
  return {
    state,
    hasActiveTurns: () => state.active,
    activeTurnViews: () => state.views,
  }
}

const view = (sessionId = 'acp-1'): ActiveTurnView => ({ sessionId, agentId: 'codebuddy' })

describe('AcpSaveGate', () => {
  it('runs a write immediately when no turn is active', async () => {
    const h = host(false)
    const gate = new AcpSaveGate(h)
    const operation = vi.fn(async () => 'written')
    expect(gate.canSaveNow()).toBe(true)
    await expect(gate.defer('settings:llm-pi-ai', operation)).resolves.toEqual({
      status: 'saved',
      value: 'written',
    })
    expect(operation).toHaveBeenCalledTimes(1)
  })

  it('preserves the operation rejection while idle', async () => {
    const h = host(false)
    const gate = new AcpSaveGate(h)
    await expect(gate.defer('settings:llm-pi-ai', async () => {
      throw new Error('revision conflict')
    })).resolves.toMatchObject({ status: 'failed', message: 'revision conflict' })
  })

  it('holds a write while a turn is active and flushes it when the turn ends', async () => {
    const h = host(true, [view()])
    const gate = new AcpSaveGate(h)
    const operation = vi.fn(async () => 'written')
    const pending = gate.defer('settings:llm-pi-ai', operation)
    expect(gate.status()).toMatchObject({
      canSave: false,
      activeTurns: 1,
      pending: [{ label: 'settings:llm-pi-ai' }],
    })
    expect(operation).not.toHaveBeenCalled()

    h.state.active = false
    h.state.views = []
    gate.sync()
    await expect(pending).resolves.toEqual({ status: 'saved', value: 'written' })
    expect(operation).toHaveBeenCalledTimes(1)
    expect(gate.status().pending).toEqual([])
  })

  it('forceFlush writes the held operation even while the turn is still active', async () => {
    const h = host(true, [view()])
    const gate = new AcpSaveGate(h)
    const operation = vi.fn(async () => 'forced')
    const pending = gate.defer('settings:llm-pi-ai', operation)
    await expect(gate.forceFlush()).resolves.toEqual({ saved: 1, expired: 0, failed: 0 })
    await expect(pending).resolves.toEqual({ status: 'saved', value: 'forced' })
    expect(operation).toHaveBeenCalledTimes(1)
    expect(h.state.active).toBe(true)
  })

  it('expires a held write without running it when the bounded wait ends', async () => {
    const h = host(true, [view()])
    const gate = new AcpSaveGate(h, undefined, { timeoutMs: 5 })
    const operation = vi.fn(async () => 'never')
    const pending = gate.defer('settings:llm-pi-ai', operation)
    await expect(pending).resolves.toEqual({ status: 'expired' })
    expect(operation).not.toHaveBeenCalled()
    expect(gate.status().lastOutcome).toMatchObject({ status: 'expired', label: 'settings:llm-pi-ai' })
  })

  it('waitForIdle resolves true on the idle transition and false on its own timeout', async () => {
    const h = host(true, [view()])
    const gate = new AcpSaveGate(h)
    const waiting = gate.waitForIdle(600_000)
    h.state.active = false
    h.state.views = []
    gate.sync()
    await expect(waiting).resolves.toBe(true)

    h.state.active = true
    h.state.views = [view()]
    const timed = gate.waitForIdle(5)
    // The host stays busy: the bounded wait returns false instead of hanging.
    await expect(timed).resolves.toBe(false)
  })

  it('fires onIdle immediately when the turn ended before the listener was registered', async () => {
    const h = host(false)
    const gate = new AcpSaveGate(h)
    let calls = 0
    const off = gate.onIdle(() => { calls += 1; off() })
    await Promise.resolve()
    expect(calls).toBe(1)
  })

  it('reports active session views and notifies only when the snapshot changes', () => {
    const h = host(true, [view('acp-1')])
    const seen: unknown[] = []
    const gate = new AcpSaveGate(h, status => { seen.push(status) })
    gate.sync()
    gate.sync()
    expect(seen).toHaveLength(1)
    expect(gate.status().activeSessions).toEqual([view('acp-1')])
  })

  it('records and broadcasts the outcome of an immediate idle write', async () => {
    const h = host(false)
    const seen: Array<{ lastOutcome?: unknown }> = []
    const gate = new AcpSaveGate(h, status => { seen.push(status) })
    await expect(gate.defer('settings:llm-pi-ai', async () => 'written')).resolves.toEqual({
      status: 'saved',
      value: 'written',
    })
    expect(gate.status().lastOutcome).toMatchObject({ status: 'saved', label: 'settings:llm-pi-ai' })
    expect(gate.status().lastOutcomes?.['settings:llm-pi-ai']).toMatchObject({ status: 'saved' })
    // The host frame is what the settings UI reads, so the idle path must emit it too.
    expect(seen.at(-1)?.lastOutcome).toMatchObject({ status: 'saved', label: 'settings:llm-pi-ai' })
  })

  it('records an immediate idle failure without changing the rejection shape', async () => {
    const h = host(false)
    const gate = new AcpSaveGate(h)
    await expect(gate.defer('settings:llm-pi-ai', async () => {
      throw new Error('revision conflict')
    })).resolves.toMatchObject({ status: 'failed', message: 'revision conflict' })
    expect(gate.status().lastOutcomes?.['settings:llm-pi-ai']).toMatchObject({
      status: 'failed',
      message: 'revision conflict',
    })
  })

  it('settles a subject-gone abort cancelled without recording an outcome', async () => {
    const h = host(false)
    const gate = new AcpSaveGate(h)
    await expect(gate.defer('agent-save:ghost', async () => {
      throw new SaveGateAborted('agent was deleted')
    })).resolves.toEqual({ status: 'cancelled' })
    // A delete must not surface as a failed save banner or a retryable entry.
    expect(gate.status().lastOutcomes?.['agent-save:ghost']).toBeUndefined()
    expect(gate.status().lastOutcome).toBeUndefined()
    expect(gate.retry('agent-save:ghost')).toBe(false)
  })

  it('settles an in-flight abort cancelled without an outcome while flushing', async () => {
    const h = host(true, [view()])
    const gate = new AcpSaveGate(h)
    let rejectOperation!: (error: unknown) => void
    const pending = gate.defer('agent-save:ghost', () => new Promise((_resolve, reject) => {
      rejectOperation = reject
    }))
    const flushed = gate.forceFlush()
    expect(rejectOperation).toBeTypeOf('function')
    rejectOperation(new SaveGateAborted('agent was deleted'))
    await expect(flushed).resolves.toEqual({ saved: 0, expired: 0, failed: 0, cancelled: 1 })
    await expect(pending).resolves.toEqual({ status: 'cancelled' })
    expect(gate.status().lastOutcomes?.['agent-save:ghost']).toBeUndefined()
  })

  it('cancels every queued write of one label and never runs it', async () => {
    const h = host(true, [view()])
    const gate = new AcpSaveGate(h)
    const operation = vi.fn(async () => 'never')
    const pending = gate.defer('agent-save:codebuddy', operation)
    expect(gate.cancel('agent-save:codebuddy')).toBe(1)
    await expect(pending).resolves.toEqual({ status: 'cancelled' })
    expect(operation).not.toHaveBeenCalled()
    expect(gate.status().pending).toEqual([])
    expect(gate.status().lastOutcomes?.['agent-save:codebuddy']).toMatchObject({ status: 'cancelled' })
  })

  it('lets a newer save of the same label invalidate the older queued snapshot', async () => {
    const h = host(true, [view()])
    const gate = new AcpSaveGate(h)
    const oldOperation = vi.fn(async () => 'old')
    const newOperation = vi.fn(async () => 'new')
    const older = gate.defer('agent-save:codebuddy', oldOperation)
    const newer = gate.defer('agent-save:codebuddy', newOperation)
    // Superseded is distinct from an explicit cancel: the toast can say a
    // newer save replaced this entry, and the status broadcast carries it too.
    await expect(older).resolves.toEqual({ status: 'cancelled', superseded: true })
    expect(gate.status().lastOutcomes?.['agent-save:codebuddy']).toMatchObject({
      status: 'cancelled',
      superseded: true,
    })
    h.state.active = false
    h.state.views = []
    gate.sync()
    await expect(newer).resolves.toEqual({ status: 'saved', value: 'new' })
    expect(oldOperation).not.toHaveBeenCalled()
    expect(newOperation).toHaveBeenCalledTimes(1)
  })

  it('reports a real gate in its status snapshot', () => {
    const gate = new AcpSaveGate(host(false))
    expect(gate.status()).toMatchObject({ gateAvailable: true, canSave: true })
  })

  it('forces only the writes that were queued when the pass started', async () => {
    const h = host(true, [view()])
    const gate = new AcpSaveGate(h)
    let release!: () => void
    let started!: () => void
    const startedPromise = new Promise<void>(resolve => { started = resolve })
    const first = gate.defer('agent-save:alpha', async () => {
      started()
      await new Promise<void>(resolve => { release = resolve })
      return 'alpha'
    })
    const forced = gate.forceFlush()
    await startedPromise
    // This save arrives WHILE the forced pass is running. It belongs to the
    // next turn boundary, so the pass must not absorb it.
    const lateOperation = vi.fn(async () => 'late')
    const late = gate.defer('settings:llm-pi-ai', lateOperation)
    release()
    await expect(forced).resolves.toMatchObject({ saved: 1 })
    await expect(first).resolves.toEqual({ status: 'saved', value: 'alpha' })
    expect(lateOperation).not.toHaveBeenCalled()
    expect(gate.status().pending.map(entry => entry.label)).toEqual(['settings:llm-pi-ai'])
    // The plane is still busy: the late write stays held.
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(lateOperation).not.toHaveBeenCalled()
    // End the turn and the ordinary idle flush picks it up.
    h.state.active = false
    h.state.views = []
    gate.sync()
    await expect(late).resolves.toEqual({ status: 'saved', value: 'late' })
    expect(lateOperation).toHaveBeenCalledTimes(1)
  })

  it('keeps per-label outcomes so one agent cannot erase another agent\'s result', async () => {
    const h = host(true, [view()])
    const gate = new AcpSaveGate(h)
    const first = gate.defer('agent-save:alpha', async () => 'alpha')
    h.state.active = false
    h.state.views = []
    gate.sync()
    await expect(first).resolves.toMatchObject({ status: 'saved' })
    h.state.active = true
    h.state.views = [view()]
    const second = gate.defer('agent-save:beta', async () => 'beta')
    expect(gate.status().lastOutcomes?.['agent-save:alpha']).toMatchObject({ status: 'saved' })
    expect(gate.status().lastOutcomes?.['agent-save:beta']).toBeUndefined()
    await expect(gate.forceFlush()).resolves.toMatchObject({ saved: 1 })
    expect(gate.status().lastOutcomes?.['agent-save:alpha']).toMatchObject({ status: 'saved' })
    expect(gate.status().lastOutcomes?.['agent-save:beta']).toMatchObject({ status: 'saved' })
  })

  it('queues a follow-up forced pass when a flush is already running', async () => {
    const h = host(true, [view()])
    const gate = new AcpSaveGate(h)
    let release!: () => void
    let started!: () => void
    const firstStarted = new Promise<void>(resolve => { started = resolve })
    const first = gate.defer('agent-save:alpha', async () => {
      started()
      await new Promise<void>(resolve => { release = resolve })
      return 'alpha'
    })
    // Let the gate start an ordinary idle flush, then make the plane busy again.
    h.state.active = false
    h.state.views = []
    gate.sync()
    await firstStarted
    h.state.active = true
    h.state.views = [view()]
    // The active idle flush will stop after `alpha`; a force request must not
    // reuse its promise or `beta` would be stranded.
    const second = gate.defer('agent-save:beta', async () => 'beta')
    const forced = gate.forceFlush()
    release()
    await expect(forced).resolves.toMatchObject({ saved: 1 })
    await expect(first).resolves.toMatchObject({ status: 'saved', value: 'alpha' })
    await expect(second).resolves.toMatchObject({ status: 'saved', value: 'beta' })
    expect(gate.status().pending).toEqual([])
  })

  it('retains a failed write so the retry gesture can run it again', async () => {
    const h = host(true, [view()])
    const gate = new AcpSaveGate(h, undefined, { timeoutMs: 50 })
    const operation = vi.fn(async () => 'written')
    const pending = gate.defer('agent-save:codebuddy', operation)
    await expect(pending).resolves.toEqual({ status: 'expired' })
    expect(gate.retry('agent-save:codebuddy')).toBe(true)
    expect(gate.retry('agent-save:unknown')).toBe(false)

    h.state.active = false
    h.state.views = []
    gate.sync()
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(operation).toHaveBeenCalledTimes(1)
    expect(gate.status().lastOutcomes?.['agent-save:codebuddy']).toMatchObject({ status: 'saved' })
  })

  it('settles every held write as failed when the plugin is disposed', async () => {
    const h = host(true, [view()])
    const gate = new AcpSaveGate(h)
    const operation = vi.fn(async () => 'never')
    const pending = gate.defer('settings:llm-pi-ai', operation)
    gate.dispose()
    await expect(pending).resolves.toEqual({
      status: 'failed',
      message: 'acp: save gate was disposed before the write ran',
    })
    expect(operation).not.toHaveBeenCalled()
  })
})
