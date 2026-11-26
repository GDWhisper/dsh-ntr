import { afterAll, describe, expect, it } from 'vitest'
import { AcpLlmAdapter, BridgeManager } from '../../src/bridge.ts'
import { TurnWatchdogService } from '../../src/bridge/turn-watchdog-service.ts'
import type { LiveSession } from '../../src/bridge/live-session.ts'
import { EventHub, dispatchRpc } from '../../src/impl.ts'
import type { AcpEvent, ChatSessionView } from '../../src/protocol.ts'
import { MIN_BURST_MS } from '../../src/tps.ts'
import { def, hostLoopTurn } from './harness.ts'

describe('burst tok/s gating (MIN_BURST_MS)', () => {
  const hub = new EventHub()
  const events: AcpEvent[] = []
  hub.subscribe(event => { events.push(event) })
  const manager = new BridgeManager([def], hub, 500)

  afterAll(async () => {
    await manager.shutdownAll()
  })

  function waitForMetric(pred: (event: Extract<AcpEvent, { type: 'turn/metrics' }>) => boolean): Promise<Extract<AcpEvent, { type: 'turn/metrics' }>> {
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const ev = events[i]
      if (ev?.type === 'turn/metrics' && pred(ev)) return Promise.resolve(ev)
    }
    return new Promise((resolve) => {
      const stop = hub.subscribe(ev => {
        if (ev.type === 'turn/metrics' && pred(ev)) {
          stop()
          resolve(ev)
        }
      })
    })
  }

  it('ignores sub-threshold micro-bursts and preserves prior session.burst across turns', async () => {
    const adapter = new AcpLlmAdapter(manager)
    const dshSessionId = 'dsh-metrics-micro-burst'

    await hostLoopTurn(adapter, {
      provider: 'acp',
      model: 'mock',
      sessionId: dshSessionId,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'FAST micro burst' }] }],
    })
    const firstFinal = await waitForMetric(e => e.final && e.dshSessionId === dshSessionId)
    expect(firstFinal.outputTokens).toBe(0)
    expect(firstFinal.burstMs).toBe(0)
    expect(events.some(e => e.type === 'turn/metrics' && e.dshSessionId === dshSessionId && !e.final)).toBe(false)

    const afterFirst = await dispatchRpc(manager, 'session/chat-list', { dshSessionId })
    if (!afterFirst.ok) throw new Error('session/chat-list failed')
    const firstRow = (afterFirst.value as { sessions: ChatSessionView[] }).sessions
      .find(session => session.sessionId === firstFinal.sessionId)
    expect(firstRow?.burst).toBeUndefined()

    await hostLoopTurn(adapter, {
      provider: 'acp',
      model: 'mock',
      sessionId: dshSessionId,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'PACED second turn' }] }],
    })
    const pacedFinal = await waitForMetric(e => e.final && e.dshSessionId === dshSessionId && e.outputTokens > 0)
    expect(pacedFinal.burstMs).toBeGreaterThanOrEqual(MIN_BURST_MS)

    const afterPaced = await dispatchRpc(manager, 'session/chat-list', { dshSessionId })
    if (!afterPaced.ok) throw new Error('session/chat-list after paced failed')
    const pacedRow = (afterPaced.value as { sessions: ChatSessionView[] }).sessions
      .find(session => session.sessionId === pacedFinal.sessionId)
    expect(pacedRow?.burst).toEqual({ outputTokens: pacedFinal.outputTokens, burstMs: pacedFinal.burstMs })

    await hostLoopTurn(adapter, {
      provider: 'acp',
      model: 'mock',
      sessionId: dshSessionId,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'FAST third turn' }] }],
    })
    const thirdFinal = await waitForMetric(e => e.final && e.dshSessionId === dshSessionId && e.turnId !== pacedFinal.turnId)
    expect({ outputTokens: thirdFinal.outputTokens, burstMs: thirdFinal.burstMs }).toEqual(pacedRow?.burst)
  }, 30_000)

  it('enforces the exact MIN_BURST_MS boundary in TurnWatchdogService.noteSessionBurst', () => {
    let persists = 0
    const watchdog = new TurnWatchdogService({
      currentTuning: () => { throw new Error('unused') },
      persistAgents: () => { persists += 1 },
      allBridges: () => [],
      noteActivity: () => {},
      onError: () => {},
    })
    const session = {} as LiveSession
    watchdog.noteSessionBurst(session, 100, MIN_BURST_MS - 1)
    expect(session.burst).toBeUndefined()
    expect(persists).toBe(0)

    watchdog.noteSessionBurst(session, 100, MIN_BURST_MS)
    expect(session.burst).toEqual({ outputTokens: 100, burstMs: MIN_BURST_MS })
    expect(persists).toBe(1)
  })
})
