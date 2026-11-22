import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import type { SessionUpdate } from '@agentclientprotocol/sdk'
import { BridgeManager } from '../../src/bridge.ts'
import { EventHub, Transcript } from '../../src/impl.ts'
import type { StreamChunk } from '../../src/protocol.ts'
import { TurnStreamController } from '../../src/bridge/turn-stream.ts'
import type { LiveSession } from '../../src/bridge/live-session.ts'
import { createDrainLedger, startDrain } from '../../src/bridge/drain-record.ts'
import { def } from './harness.ts'

/**
 * The replay cursor must never jump over an unconsumed frame of the turn's own.
 *
 * Production race (instrumented): the turn's own text parks between segments
 * (its card's boundary cut the segment), then a background-drain frame arrives
 * while the turn's own request id is still unknown. The withhold branch used to
 * advance the cursor unconditionally, so the next segment replayed nothing: the
 * parked echo never reached the chat plane and the settled continuation step
 * blamed the agent for "no text reply". The transcript kept every frame — only
 * the chat face lost the text. The mirror hazard: with the cursor held back, a
 * replay that only asks `isForeignAmbientText` fail-opens on the drain's frame
 * (the turn id is unknown) and folds the drain's prose into the answer.
 *
 * These cases drive the REAL controller through its own hub subscription with
 * crafted `session/update` frames — the same append-then-broadcast seam
 * `AgentBridge.handleSessionUpdate` uses — so the interleaving is deterministic:
 * no subprocess, no CPU-load dependence.
 */
describe('the turn replay cursor and the ambient-owned split (isolated controller)', () => {
  function replayRig() {
    const hub = new EventHub()
    const manager = new BridgeManager(
      [{ ...def, id: 'replay' }],
      hub,
      500,
      `${tmpdir()}/acp-turn-replay-${Date.now()}-${Math.random().toString(36).slice(2)}.json`,
      undefined,
      false,
    )
    const session: LiveSession = {
      sessionId: 'replay-host',
      agentId: 'replay',
      acpSessionId: 'replay-acp',
      cwd: tmpdir(),
      dshSessionId: 'dsh-turn-replay',
      running: true,
      turnSeq: 1,
      lifecycle: 'live',
      lastAgentActivityAt: Date.now(),
      activeToolCalls: new Set<string>(),
      transcript: new Transcript(1_000),
      // An ACTIVE background drain: `isAmbientOwned` answers true for amb-1.
      drains: startDrain(createDrainLedger(), 'amb-1', 1, 1, true),
    }
    const controller = new TurnStreamController(manager, hub, session, 'turn-replay-1', () => {}, () => {})
    session.turnController = controller
    // The bridge's seam: append to the transcript, then broadcast the frame —
    // the controller's hub subscription runs `onEvent` on it.
    const feed = (update: Record<string, unknown>): number => {
      const seq = session.transcript.append(update)
      hub.broadcast({ type: 'session/update', sessionId: session.sessionId, seq, update: update as SessionUpdate })
      return seq
    }
    const textOf = (chunks: StreamChunk[]): string =>
      chunks
        .filter((chunk): chunk is Extract<StreamChunk, { type: 'text-delta' }> => chunk.type === 'text-delta')
        .map(chunk => chunk.text)
        .join('')
    const teardown = async () => {
      controller.dispose()
      await manager.shutdownAll()
    }
    return { manager, session, controller, feed, textOf, teardown }
  }

  /** The turn's own prose: no CodeBuddy request id (the mock agent's shape). */
  const ownText = (text: string): Record<string, unknown> =>
    ({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } })
  /** The active drain's prose: `isAmbientOwned` true, never the turn's own id. */
  const drainText = (text: string): Record<string, unknown> =>
    ({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text }, _meta: { 'codebuddy.ai/requestId': 'amb-1' } })

  it('replays the parked own echo past a withheld drain frame: no lost text, no mixed answer, no false warning', async () => {
    const rig = replayRig()
    try {
      const { controller, feed, textOf } = rig
      // Step 1 opens and the turn's own card folds into it.
      const first = controller.startSegment()
      feed({ sessionUpdate: 'tool_call', toolCallId: 'card-1', title: 'Run command', status: 'in_progress', rawInput: { command: 'echo hi' } })
      expect(first.hasCard).toBe(true)
      // The turn's own text CUTS the card-bearing segment: it parks for the
      // next one (the cursor stays behind it). A usage tick parks the same way.
      feed(ownText('MOCK: echo parked reply'))
      feed({ sessionUpdate: 'usage_update', used: 10, size: 100 })
      expect(controller.hasOpenSegment).toBe(false)
      // The active drain speaks while the turn's own request id is unknown:
      // withheld — and the cursor must NOT jump over the parked echo.
      feed(drainText('DRAIN-AMB1-TEXT'))
      // The response lands (a normal stop); the continuation step opens after.
      controller.settle({ kind: 'stop', stopReason: 'end_turn' })
      const second = controller.startSegment()
      const chunks: StreamChunk[] = []
      for await (const chunk of second.queue) chunks.push(chunk)
      const text = textOf(chunks)
      // The parked echo reaches the new segment...
      expect(text).toContain('MOCK: echo parked reply')
      // ...the drain's text does NOT fold into the chat face...
      expect(text).not.toContain('DRAIN-AMB1-TEXT')
      // ...and the settled step does not blame the agent for silence.
      expect(text).not.toContain('executed its tool call(s) but sent no text reply')
      // Nothing was dropped: the transcript still holds the drain's frame.
      expect(rig.session.transcript.since(0).some(entry => JSON.stringify(entry.update).includes('DRAIN-AMB1-TEXT'))).toBe(true)
    } finally {
      await rig.teardown()
    }
  })

  it('keeps the deferred tail read from folding an ambient-owned frame while the turn id is unknown', async () => {
    const rig = replayRig()
    try {
      const { controller, session, textOf } = rig
      const seg = controller.startSegment()
      // The response lands while the segment is still on air; its closing work
      // (the tail read) waits one macrotask.
      controller.settle({ kind: 'stop', stopReason: 'end_turn' })
      // The tail the response raced past reaches the transcript before that
      // read (the same direct-append seam the stale-tail case uses): the turn's
      // own echo, then the active drain's frame.
      session.transcript.append(ownText('MOCK: tail echo'))
      session.transcript.append(drainText('DRAIN-TAIL-TEXT'))
      await new Promise(resolve => setImmediate(resolve))
      const chunks: StreamChunk[] = []
      for await (const chunk of seg.queue) chunks.push(chunk)
      const text = textOf(chunks)
      expect(text).toContain('MOCK: tail echo')
      expect(text).not.toContain('DRAIN-TAIL-TEXT')
      expect(session.transcript.since(0).some(entry => JSON.stringify(entry.update).includes('DRAIN-TAIL-TEXT'))).toBe(true)
    } finally {
      await rig.teardown()
    }
  })
})