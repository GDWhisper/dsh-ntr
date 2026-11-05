/**
 * The rate-limit refusal's HOST-SIDE wiring, over a real child process.
 *
 * `agentRefusalDetail`'s parsing is pinned in tests/impl.spec.ts (pure, no
 * subprocess). What lives here is everything AROUND it, none of which a unit
 * test can see: a quota refusal settling the turn as an error with
 * `errorKind: 'quota'`, the session record the composer's dock card reads, the
 * clear on the next answer that is not rate-limited, the clear at a lifecycle
 * boundary, and the two branches a refusal must OUTRANK (the ambient wait and
 * the detached-worker hold — a refused turn has no answer coming, so waiting
 * for either would hang the turn for minutes).
 *
 * The `/acp` plane shares the record, so both entry points are driven: the chat
 * adapter (`streamPrompt`) and the RPC (`BridgeManager.prompt`). The mock's
 * markers are documented in tests/mock-agent.mjs ("QUOTA" / "REFUSED").
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { AcpLlmAdapter, BridgeManager } from '../src/bridge.ts'
import { dispatchRpc, EventHub } from '../src/impl.ts'
import type { AcpAgentDef, AcpEvent, SessionView, StreamChunk } from '../src/protocol.ts'

const MOCK = fileURLToPath(new URL('./mock-agent.mjs', import.meta.url))

const def: AcpAgentDef = {
  id: 'mock',
  title: 'Mock',
  command: process.execPath,
  args: [MOCK],
  env: {},
  cwd: tmpdir(),
  allowedCwdRoots: [tmpdir()],
}

/** One isolated manager: own hub, own event log, own state directory. */
interface Harness {
  manager: BridgeManager
  hub: EventHub
  events: AcpEvent[]
  dispose: () => Promise<void>
}

function harness(): Harness {
  const root = mkdtempSync(join(tmpdir(), 'dsh-ntr-quota-'))
  const hub = new EventHub()
  const events: AcpEvent[] = []
  hub.subscribe(event => { events.push(event) })
  // A private state directory (never the developer's real one) and no boot
  // probe: nothing here reads the model catalog.
  const manager = new BridgeManager(
    [def],
    hub,
    500,
    join(root, 'agents.json'),
    join(root, 'model-catalog.json'),
    false,
  )
  return {
    manager,
    hub,
    events,
    dispose: async () => {
      await manager.shutdownAll()
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    },
  }
}

/**
 * Wait for a frame, optionally only among the ones logged after `since` (so a
 * frame from an earlier phase of the same test cannot answer a later wait).
 */
function waitFor<T extends AcpEvent['type']>(
  h: Harness,
  type: T,
  predicate: (event: Extract<AcpEvent, { type: T }>) => boolean,
  timeoutMs = 15_000,
  since = 0,
): Promise<Extract<AcpEvent, { type: T }>> {
  type Frame = Extract<AcpEvent, { type: T }>
  return new Promise<Frame>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${type}`)), timeoutMs)
    const done = (frame: Frame): void => { clearTimeout(timer); resolve(frame) }
    const existing = h.events.slice(since).find((event): event is Frame =>
      event.type === type && predicate(event as Frame))
    if (existing !== undefined) {
      done(existing)
      return
    }
    const unsub = h.hub.subscribe(event => {
      if (event.type === type && predicate(event as Frame)) {
        unsub()
        done(event as Frame)
      }
    })
  })
}

/** Drive one chat turn through the adapter, the way the host agent loop does. */
async function chatTurn(h: Harness, dshSessionId: string, text: string): Promise<StreamChunk[]> {
  const adapter = new AcpLlmAdapter(h.manager)
  const chunks: StreamChunk[] = []
  for await (const chunk of adapter.stream({
    provider: 'acp',
    model: 'mock',
    sessionId: dshSessionId,
    messages: [{ role: 'user', content: [{ type: 'text', text }] }],
  })) chunks.push(chunk)
  return chunks
}

function proseOf(chunks: StreamChunk[]): string {
  return chunks
    .filter((chunk): chunk is Extract<StreamChunk, { type: 'text-delta' }> => chunk.type === 'text-delta')
    .map(chunk => chunk.text)
    .join('')
}

/** The refusal record as the dock card sees it (the `SessionView` shape). */
function refusalsOf(h: Harness, since = 0): Array<SessionView['quotaRefusal']> {
  return h.events
    .slice(since)
    .filter(event => event.type === 'session/meta')
    .map(event => (event.session as SessionView).quotaRefusal)
}

describe('a rate-limited prompt response (quota refusal wiring)', () => {
  it('settles the chat turn as a rate-limit error and records the refusal for the dock card', async () => {
    const h = harness()
    try {
      // A first ordinary turn: the conversation's agent lock stops being
      // provisional, so the refusal below is a mid-conversation one (a FIRST
      // turn that delivers nothing rolls its lock back and closes the session
      // by design — see AGENTS/protocol.md §6).
      await chatTurn(h, 'dsh-quota-chat', 'hello')

      const mark = h.events.length
      const chunks = await chatTurn(h, 'dsh-quota-chat', 'QUOTA please')
      const finish = chunks.find((chunk): chunk is Extract<StreamChunk, { type: 'finish' }> => chunk.type === 'finish')
      expect(finish?.reason).toMatchObject({
        kind: 'error',
        failure: { code: 'rate_limited' },
      })
      // The agent's own words are the message: they carry the reset time.
      const failure = (finish as Extract<StreamChunk, { type: 'finish' }>).reason as
        { kind: 'error'; failure: { message: string; code: string } }
      expect(failure.failure.message).toContain('is rate limited')
      expect(failure.failure.message).toContain('429 您使用量已超出频率限制')

      // ...and the record the composer's dock card renders, published on
      // `session/meta` BEFORE the turn ends.
      const meta = await waitFor(h, 'session/meta', event =>
        (event.session as SessionView).quotaRefusal !== undefined, 15_000, mark)
      expect(meta.session.quotaRefusal?.message).toContain('您也可以切换其他模型继续使用')
      const end = await waitFor(h, 'turn/end', event => event.errorKind === 'quota', 15_000, mark)
      expect(end.error).toContain('is rate limited')
      // `at` is host-side bookkeeping: the view carries the words only.
      expect(Object.keys(meta.session.quotaRefusal ?? {})).toEqual(['message'])
    } finally {
      await h.dispose()
    }
  }, 30_000)

  it('clears the record on the next answer that is not rate-limited', async () => {
    const h = harness()
    try {
      await chatTurn(h, 'dsh-quota-clear', 'hello')
      await chatTurn(h, 'dsh-quota-clear', 'QUOTA please')
      const mark = h.events.length
      expect(refusalsOf(h, mark).length).toBe(0)

      await chatTurn(h, 'dsh-quota-clear', 'hello again')
      // The adapter stream ends at the first tool-card boundary, before the
      // prompt response settles and the clear is broadcast; waiting for the
      // ordinary turn/end puts the read after that frame, not on a sleep.
      await waitFor(h, 'turn/end', event => event.stopReason === 'end_turn', 15_000, mark)
      // The clear is a BROADCAST, not just a field reset: without it the
      // browser keeps a row it was never told changed.
      const after = refusalsOf(h, mark)
      expect(after.length).toBeGreaterThan(0)
      expect(after.every(refusal => refusal === undefined)).toBe(true)
    } finally {
      await h.dispose()
    }
  }, 30_000)

  it('clears the record at a lifecycle boundary (the agent process died)', async () => {
    const h = harness()
    try {
      await chatTurn(h, 'dsh-quota-die', 'hello')
      await chatTurn(h, 'dsh-quota-die', 'QUOTA please')
      expect(refusalsOf(h).some(refusal => refusal !== undefined)).toBe(true)

      // The crash parks the session (releaseAll) and re-publishes it: the
      // parked record must not carry the old process's quota.
      try {
        await chatTurn(h, 'dsh-quota-die', 'DIE')
      } catch {
        /* the dead connection rejects the prompt; that is the point */
      }
      const released = await waitFor(h, 'session/released', () => true)
      expect((released.session as SessionView).quotaRefusal).toBeUndefined()
    } finally {
      await h.dispose()
    }
  }, 30_000)

  it('outranks the ambient wait: a drain that never speaks cannot hold the turn', async () => {
    const h = harness()
    try {
      await chatTurn(h, 'dsh-quota-drain', 'hello')
      await chatTurn(h, 'dsh-quota-drain', 'QUOTA_DRAIN please')
      // The ambient quiet window is 10s by default; a refusal ranked BELOW the
      // ambient branch would not end this turn inside it.
      const end = await waitFor(h, 'turn/end', event => event.errorKind === 'quota', 5_000)
      expect(end.error).toContain('is rate limited')
    } finally {
      await h.dispose()
    }
  }, 30_000)

  it('outranks the detached-worker hold: a worker that never reports cannot hold the turn', async () => {
    const h = harness()
    try {
      await chatTurn(h, 'dsh-quota-worker', 'hello')
      await chatTurn(h, 'dsh-quota-worker', 'QUOTA_WORKER please')
      // The worker window is minutes by default; the same 5s bound applies.
      const end = await waitFor(h, 'turn/end', event => event.errorKind === 'quota', 5_000)
      expect(end.error).toContain('is rate limited')
    } finally {
      await h.dispose()
    }
  }, 30_000)

  it('quotes the agent’s own reason when the refusal is NOT a quota', async () => {
    const h = harness()
    try {
      await chatTurn(h, 'dsh-quota-plain', 'hello')
      const chunks = await chatTurn(h, 'dsh-quota-plain', 'REFUSED please')
      // An ordinary stop (no errorKind, no record) — but the reason the agent
      // sent must reach the user rather than be dropped (constraint 29). The
      // driver's finish reason carries no stop reason (the `turn/end` frame is
      // where the host loop would read one), so `kind: 'stop'` is the shape.
      expect(chunks.find(chunk => chunk.type === 'finish'))
        .toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
      const prose = proseOf(chunks)
      expect(prose).toContain('refused this turn')
      expect(prose).toContain('content policy: the requested action is not allowed')
      expect(refusalsOf(h).every(refusal => refusal === undefined)).toBe(true)
    } finally {
      await h.dispose()
    }
  }, 30_000)
})

describe('the /acp prompt plane shares the refusal record', () => {
  it('records the refusal, tags the turn/end frame, and clears it on the next answer', async () => {
    const h = harness()
    try {
      const started = await dispatchRpc(h.manager, 'session/start', { agentId: 'mock' })
      expect(started.ok).toBe(true)
      if (!started.ok) return
      const sessionId = (started.value as { sessionId: string }).sessionId

      const mark = h.events.length
      await dispatchRpc(h.manager, 'session/prompt', { sessionId, text: 'QUOTA please' })
      const end = await waitFor(h, 'turn/end', event => event.errorKind === 'quota', 15_000, mark)
      expect(end.error).toContain('is rate limited')
      const meta = await waitFor(h, 'session/meta', event =>
        (event.session as SessionView).quotaRefusal !== undefined, 15_000, mark)
      expect(meta.session.quotaRefusal?.message).toContain('429')

      // The SAME session driven from the other plane: an ordinary answer must
      // clear the record, or the banner outlives the answer that disproved it.
      const clearMark = h.events.length
      await dispatchRpc(h.manager, 'session/prompt', { sessionId, text: 'hello again' })
      await waitFor(h, 'turn/end', event => event.stopReason === 'end_turn', 15_000, clearMark)
      const after = refusalsOf(h, clearMark)
      expect(after.length).toBeGreaterThan(0)
      expect(after.every(refusal => refusal === undefined)).toBe(true)
    } finally {
      await h.dispose()
    }
  }, 30_000)
})
