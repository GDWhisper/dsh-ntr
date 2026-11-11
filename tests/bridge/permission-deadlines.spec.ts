import { afterAll, describe, expect, it } from 'vitest'
import { AcpLlmAdapter, BridgeManager } from '../../src/bridge.ts'
import { type AcpEvent } from '../../src/protocol.ts'
import { dispatchRpc, EventHub } from '../../src/impl.ts'
import { def, hostLoopTurn, settleTranscript } from './harness.ts'

/**
 * The ONE deadline every ask carries.
 *
 * There is no second route any more: a chat-bound ask and an `/acp`-RPC ask
 * are both ledger entries, and an ask nobody answers is settled HERE — with
 * `abort` refusing it, `auto` picking the option the agent's own kinds imply,
 * or `wait` never expiring. Each expiry must leave exactly one notice and one
 * `permission/expired` frame: the card disappears, so the conversation would
 * otherwise show nothing about what happened to the question.
 */
describe('a ledger deadline settles an unanswered ask in place (isolated manager)', () => {
  const deadlineHub = new EventHub()
  const deadlineEvents: AcpEvent[] = []
  deadlineHub.subscribe(event => { deadlineEvents.push(event) })
  // A shortened window so the case runs in seconds instead of the production
  // five minutes. The mode is `abort` because this case IS about the deadline
  // firing — the plugin's own default is `wait` (never expire).
  const deadlineManager = new BridgeManager([{ ...def, id: 'deadline' }], deadlineHub, 500, undefined, undefined, true, { permissionTimeoutMs: 2_000, permissionTimeoutMode: 'abort' })
  const deadlineAdapter = new AcpLlmAdapter(deadlineManager)

  afterAll(async () => {
    await deadlineManager.shutdownAll()
  })

  function deadlineWaitFor<T extends AcpEvent['type']>(type: T, since: number, predicate: (event: Extract<AcpEvent, { type: T }>) => boolean, timeoutMs = 15_000): Promise<Extract<AcpEvent, { type: T }>> {
    const matches = (event: AcpEvent): event is Extract<AcpEvent, { type: T }> =>
      event.type === type && predicate(event as Extract<AcpEvent, { type: T }>)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout waiting for ${type}`)), timeoutMs)
      const unsub = deadlineHub.subscribe(event => {
        if (deadlineEvents.indexOf(event) >= since && matches(event)) {
          clearTimeout(timer)
          unsub()
          resolve(event)
        }
      })
      const existing = deadlineEvents.find((event, index) => index >= since && matches(event))
      if (existing !== undefined) {
        clearTimeout(timer)
        unsub()
        resolve(existing)
      }
    })
  }

  /** Drain one adapter turn, collecting the reasoning text it streamed. */
  async function deadlineTurn(sessionId: string, text: string): Promise<{ reasoning: () => string; drained: Promise<void> }> {
    const parts: string[] = []
    const drained = (async () => {
      const { chunks } = await hostLoopTurn(deadlineAdapter, {
        provider: 'acp',
        model: 'deadline',
        sessionId,
        messages: [{ role: 'user', content: [{ type: 'text', text }] }],
      })
      for (const chunk of chunks) {
        if (chunk.type === 'reasoning-delta') parts.push(chunk.text)
      }
    })()
    return { reasoning: () => parts.join(''), drained }
  }

  async function deadlineEcho(sessionId: string): Promise<string> {
    await settleTranscript(deadlineManager, sessionId)
    const transcript = await dispatchRpc(deadlineManager, 'transcript/get', { sessionId })
    if (!transcript.ok) throw new Error('transcript failed')
    return (transcript.value as { entries: Array<{ update: Record<string, unknown> }> }).entries
      .filter(e => e.update.sessionUpdate === 'agent_message_chunk')
      .map(e => String((e.update.content as { text?: string }).text ?? ''))
      .join('')
  }

  it('refuses once and leaves an expiry trace in the conversation', async () => {
    const since = deadlineEvents.length
    const { reasoning, drained } = await deadlineTurn('dsh-deadline-abort', 'PERM deadline abort')
    const request = await deadlineWaitFor('permission/request', since, () => true)

    // Nobody answers. The deadline settles the SAME ledger entry: the
    // conversation gets one expiry frame, and the ledger notice fires once.
    const expired = await deadlineWaitFor('permission/expired', since, event => event.sessionId === request.sessionId)
    expect(expired).toMatchObject({
      sessionId: request.sessionId,
      toolCall: { title: 'mock dangerous operation' },
      timeoutMs: 2_000,
      outcome: { outcome: 'cancelled' },
    })
    expect(expired).not.toHaveProperty('optionName')
    const notices = deadlineEvents.slice(since).filter((event): event is Extract<AcpEvent, { type: 'agent/notice' }> =>
      event.type === 'agent/notice' && event.text.includes('timed out after 2s'))
    expect(notices).toHaveLength(1)
    expect(notices[0]?.text).toContain('refused')

    await drained
    expect(reasoning()).toContain('no answer within 2s; refused')
    expect(await deadlineEcho(request.sessionId)).toContain('perm=cancelled')
    // The entry is gone: answering now is an error, not a second chance.
    const late = await dispatchRpc(deadlineManager, 'permission/respond', { requestId: request.requestId, optionId: 'allow1' })
    expect(late).toMatchObject({ ok: false, error: { code: 'unknown_request' } })
    expect(deadlineManager.pendingPermissionViews()).toHaveLength(0)
  }, 30_000)

  it('carries the deadline on the frame and words the chat line with it', async () => {
    const since = deadlineEvents.length
    const { reasoning, drained } = await deadlineTurn('dsh-deadline-line', 'PERM deadline line')
    const request = await deadlineWaitFor('permission/request', since, () => true)
    expect(request.timeoutMode).toBe('abort')
    expect(typeof request.deadlineAt).toBe('number')
    expect(request.deadlineAt).toBeGreaterThan(Date.now())

    // A human answers on the card; the armed deadline is cleared with it.
    await dispatchRpc(deadlineManager, 'permission/respond', { requestId: request.requestId, optionId: 'allow1' })
    await drained
    expect(reasoning()).toContain('please answer the permission card above the composer within 2s or this request is cancelled')
    expect(await deadlineEcho(request.sessionId)).toContain('perm=allow1')
  }, 30_000)

  it('answers automatically in auto mode and says which option it picked', async () => {
    const autoHub = new EventHub()
    const autoEvents: AcpEvent[] = []
    autoHub.subscribe(event => { autoEvents.push(event) })
    const autoManager = new BridgeManager([{ ...def, id: 'autodeadline' }], autoHub, 500, undefined, undefined, true, {
      permissionTimeoutMs: 600,
      permissionTimeoutMode: 'auto',
    })
    const autoAdapter = new AcpLlmAdapter(autoManager)
    const autoWaitFor = <T extends AcpEvent['type']>(type: T, predicate: (event: Extract<AcpEvent, { type: T }>) => boolean, timeoutMs = 15_000): Promise<Extract<AcpEvent, { type: T }>> => {
      const matches = (event: AcpEvent): event is Extract<AcpEvent, { type: T }> =>
        event.type === type && predicate(event as Extract<AcpEvent, { type: T }>)
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timeout waiting for ${type}`)), timeoutMs)
        const unsub = autoHub.subscribe(event => {
          if (matches(event)) {
            clearTimeout(timer)
            unsub()
            resolve(event)
          }
        })
        const existing = autoEvents.find(matches)
        if (existing !== undefined) {
          clearTimeout(timer)
          unsub()
          resolve(existing)
        }
      })
    }
    try {
      const parts: string[] = []
      const drained = (async () => {
        const { chunks } = await hostLoopTurn(autoAdapter, {
          provider: 'acp',
          model: 'autodeadline',
          sessionId: 'dsh-deadline-auto',
          messages: [{ role: 'user', content: [{ type: 'text', text: 'PERM deadline auto' }] }],
        })
        for (const chunk of chunks) {
          if (chunk.type === 'reasoning-delta') parts.push(chunk.text)
        }
      })()
      const request = await autoWaitFor('permission/request', () => true)
      expect(request.timeoutMode).toBe('auto')
      // The agent's own kinds imply allow_once first; the plugin answers with
      // it and says so, because nobody looked at the approval.
      const expired = await autoWaitFor('permission/expired', event => event.sessionId === request.sessionId)
      expect(expired).toMatchObject({
        outcome: { outcome: 'selected', optionId: 'allow1' },
        optionName: 'Allow once',
      })
      const notices = autoEvents.filter((event): event is Extract<AcpEvent, { type: 'agent/notice' }> =>
        event.type === 'agent/notice' && event.text.includes('answered "Allow once"'))
      expect(notices).toHaveLength(1)
      await drained
      expect(parts.join('')).toContain('no answer within 1s; answered "Allow once" automatically, continuing')
      const transcript = await dispatchRpc(autoManager, 'transcript/get', { sessionId: request.sessionId })
      if (!transcript.ok) throw new Error('transcript failed')
      const echo = (transcript.value as { entries: Array<{ update: Record<string, unknown> }> }).entries
        .filter(e => e.update.sessionUpdate === 'agent_message_chunk')
        .map(e => String((e.update.content as { text?: string }).text ?? ''))
        .join('')
      expect(echo).toContain('perm=allow1')
    } finally {
      await autoManager.shutdownAll()
    }
  }, 30_000)
})

/**
 * A deadline adopted from the settings page.
 *
 * The whole point of the settings card over a config-file edit: the window
 * changes WITHOUT restarting the bridge, which would cost the user every
 * running session. Pass the new number to a live bridge, then run a turn — an
 * ask raised after the write must follow it, and the frame / notice / chat
 * line must all say the same thing.
 */
describe('a rewritten deadline reaches the next ask (isolated manager)', () => {
  it('adopts a deadline the settings page writes while a session is live', async () => {
    const hotHub = new EventHub()
    const hotEvents: AcpEvent[] = []
    hotHub.subscribe(event => { hotEvents.push(event) })
    const hotManager = new BridgeManager([{ ...def, id: 'hot' }], hotHub, 500, undefined, undefined, true, {
      permissionTimeoutMs: 600_000,
      // The write below shortens the window; the MODE is what makes an expiry
      // do something, and the plugin's default (`wait`) never expires.
      permissionTimeoutMode: 'abort',
    })
    const hotWaitFor = <T extends AcpEvent['type']>(type: T, since: number, predicate: (event: Extract<AcpEvent, { type: T }>) => boolean, timeoutMs = 15_000): Promise<Extract<AcpEvent, { type: T }>> => {
      const matches = (event: AcpEvent): event is Extract<AcpEvent, { type: T }> =>
        event.type === type && predicate(event as Extract<AcpEvent, { type: T }>)
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timeout waiting for ${type}`)), timeoutMs)
        const unsub = hotHub.subscribe(event => {
          if (hotEvents.indexOf(event) >= since && matches(event)) {
            clearTimeout(timer)
            unsub()
            resolve(event)
          }
        })
        const existing = hotEvents.find((event, index) => index >= since && matches(event))
        if (existing !== undefined) {
          clearTimeout(timer)
          unsub()
          resolve(existing)
        }
      })
    }
    try {
      // The settings write, on a manager that has never run a turn.
      await hotManager.setApprovalDeadlines({ permissionTimeoutMs: 600 })
      const since = hotEvents.length
      const parts: string[] = []
      const drained = (async () => {
        const { chunks } = await hostLoopTurn(new AcpLlmAdapter(hotManager), {
          provider: 'acp',
          model: 'hot',
          sessionId: 'dsh-hot-deadline',
          messages: [{ role: 'user', content: [{ type: 'text', text: 'PERM hot deadline' }] }],
        })
        for (const chunk of chunks) {
          if (chunk.type === 'reasoning-delta') parts.push(chunk.text)
        }
      })()
      const request = await hotWaitFor('permission/request', since, () => true)
      // The frame describes the NEW 600ms window, not the 600s one the
      // bridge was built with.
      expect(request.timeoutMode).toBe('abort')
      expect(request.deadlineAt! - Date.now()).toBeLessThan(2_000)
      // Settled on that window, with one notice and one expiry frame.
      const expired = await hotWaitFor('permission/expired', since, () => true)
      expect(expired).toMatchObject({ timeoutMs: 600, outcome: { outcome: 'cancelled' } })
      const notice = await hotWaitFor('agent/notice', since, event => event.text.includes('timed out after 1s'), 5_000)
      expect(notice.text).toContain('refused')
      await drained
      expect(parts.join('')).toContain('please answer the permission card above the composer within 1s or this request is cancelled')
      expect(parts.join('')).toContain('no answer within 1s; refused')
    } finally {
      await hotManager.shutdownAll()
    }
  }, 30_000)
})

/**
 * The zero window: 不等待 — the ask is settled the moment it arrives.
 *
 * A window of `0` does not mean "waited for zero seconds"; it means nobody is
 * going to be asked at all, so the ledger never creates an entry and never
 * broadcasts a card (there would be nothing to answer).
 *
 * This rung belongs to the **auto** mode: it ANSWERS the ask with the option
 * the agent's own kinds imply, so the agent continues. Under `abort` the same
 * zero would REFUSE every ask on arrival — the agent stops at every gate it
 * meets, which is not a timeout but a wall — so `abort` never offers it and
 * floors to the shortest real wait. `wait` keeps its own meaning (it never
 * expires), so a zero window under it still waits for the human.
 */
describe('a zero window settles the ask without asking anyone (isolated manager)', () => {
  interface ZeroCase {
    events: AcpEvent[]
    /** How many `permission/request` frames were broadcast. */
    requested: number
    /** Asks still waiting for an answer on the ledger. */
    pending: number
    /** The window actually in force. */
    effectiveWindow: number
    reasoning: string
    echo: string
  }

  /**
   * Run one PERM turn on a manager whose window is `0`. Any ask that DOES
   * reach the ledger is answered the way the browser's card would, so a
   * floored window (abort / wait) cannot hang the turn.
   */
  async function zeroCase(id: string, mode: 'auto' | 'abort' | 'wait'): Promise<ZeroCase> {
    const caseHub = new EventHub()
    const caseEvents: AcpEvent[] = []
    caseHub.subscribe(event => { caseEvents.push(event) })
    const caseManager = new BridgeManager([{ ...def, id }], caseHub, 500, undefined, undefined, false, {
      permissionTimeoutMs: 0,
      permissionTimeoutMode: mode,
    })
    const answers = caseHub.subscribe(event => {
      if (event.type !== 'permission/request') return
      void dispatchRpc(caseManager, 'permission/respond', { requestId: event.requestId, optionId: 'allow1' })
    })
    const adapter = new AcpLlmAdapter(caseManager)
    const parts: string[] = []
    const sessionKey = `dsh-zero-${id}`
    const prompt = `PERM zero ${id}`
    try {
      const { chunks } = await hostLoopTurn(adapter, {
        provider: 'acp',
        model: id,
        sessionId: sessionKey,
        messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
      })
      for (const chunk of chunks) {
        if (chunk.type === 'reasoning-delta') parts.push(chunk.text)
      }
      // The transcript is addressed by the ACP session id, which the turn
      // announced — not by the chat session key the adapter was given.
      const turn = caseEvents.find(e => e.type === 'turn/start' && e.text === prompt)
      if (turn?.sessionId === undefined) throw new Error('no turn started')
      await settleTranscript(caseManager, turn.sessionId)
      const transcript = await dispatchRpc(caseManager, 'transcript/get', { sessionId: turn.sessionId })
      if (!transcript.ok) throw new Error('transcript failed')
      const echo = (transcript.value as { entries: Array<{ update: Record<string, unknown> }> }).entries
        .filter(e => e.update.sessionUpdate === 'agent_message_chunk')
        .map(e => String((e.update.content as { text?: string }).text ?? ''))
        .join('')
      return {
        events: caseEvents,
        requested: caseEvents.filter(e => e.type === 'permission/request').length,
        pending: caseManager.pendingPermissionViews().length,
        effectiveWindow: caseManager.approvalDeadlines().permissionTimeoutMs,
        reasoning: parts.join(''),
        echo,
      }
    } finally {
      answers()
      await caseManager.shutdownAll()
    }
  }

  it('auto: answers on the spot, with no card at all', async () => {
    const result = await zeroCase('zeroauto', 'auto')
    // No card was broadcast, and no ledger entry was left waiting: the ask was
    // answered before it could reach a page.
    expect(result.requested).toBe(0)
    expect(result.pending).toBe(0)
    // The window in force IS 不等待.
    expect(result.effectiveWindow).toBe(0)
    // The agent still got an answer — the option its own kinds imply.
    expect(result.echo).toContain('perm=allow1')
    // And the conversation says so. "not waited for" is not "waited 0 seconds":
    // the two say different things to the human reading the transcript.
    expect(result.reasoning).toContain('not waited for; answered "Allow once" automatically, continuing')
    const notices = result.events.filter((event): event is Extract<AcpEvent, { type: 'agent/notice' }> => event.type === 'agent/notice')
    expect(notices).toHaveLength(1)
    expect(notices[0]?.text).toContain('was not waited for; answered "Allow once"')
  }, 30_000)

  it('abort: never settles on arrival — the floored window still asks the human', async () => {
    const result = await zeroCase('zeroabort', 'abort')
    // 不等待 is the auto mode's rung. Under 超时中止 a zero window would
    // refuse every ask the instant it arrived: the agent stops at every gate
    // it meets. So the window floors to the shortest REAL wait.
    expect(result.effectiveWindow).toBe(30_000)
    // Which means the ask DID reach the ledger — the question was not answered
    // behind the human's back.
    expect(result.requested).toBe(1)
    expect(result.echo).toContain('perm=allow1')
    // Nothing settled it on arrival: no expiry, no notice.
    expect(result.events.filter(e => e.type === 'permission/expired')).toHaveLength(0)
    expect(result.events.filter(e => e.type === 'agent/notice')).toHaveLength(0)
  }, 30_000)

  it('wait: keeps waiting, because the mode owns "never expires"', async () => {
    const result = await zeroCase('zerowait', 'wait')
    // `wait` says the ask never expires. The window is the OTHER axis, and the
    // mode outranks it — a wait-mode ask still reaches the human.
    expect(result.requested).toBe(1)
    expect(result.echo).toContain('perm=allow1')
    // Nothing settled it behind the human's back.
    expect(result.events.filter(e => e.type === 'permission/expired')).toHaveLength(0)
    expect(result.events.filter(e => e.type === 'agent/notice')).toHaveLength(0)
  }, 30_000)
})

/**
 * The `wait` mode keeps an ask pending.
 *
 * `wait` means "never expire": the ask stays on the ledger, visibly, until a
 * human answers it or the session is cancelled — no notice, no automatic
 * answer, and no deadline clause in the chat line.
 */
describe('the wait mode keeps an ask pending (isolated manager)', () => {
  it('never settles on its own and carries no deadline clause', async () => {
    const waitHub = new EventHub()
    const waitEvents: AcpEvent[] = []
    waitHub.subscribe(event => { waitEvents.push(event) })
    const waitManager = new BridgeManager([{ ...def, id: 'wait' }], waitHub, 500, undefined, undefined, true, {
      permissionTimeoutMs: 150,
      permissionTimeoutMode: 'wait',
    })
    const waitAdapter = new AcpLlmAdapter(waitManager)
    try {
      const since = waitEvents.length
      const parts: string[] = []
      const waitDrained = hostLoopTurn(waitAdapter, {
        provider: 'acp',
        model: 'wait',
        sessionId: 'dsh-plain-wait',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'PERM plain wait' }] }],
      })
      const request = await new Promise<Extract<AcpEvent, { type: 'permission/request' }>>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('timeout waiting for permission/request')), 15_000)
        const unsub = waitHub.subscribe(event => {
          if (waitEvents.indexOf(event) >= since && event.type === 'permission/request') {
            clearTimeout(timer)
            unsub()
            resolve(event)
          }
        })
      })

      // Well past the window: no notice, no auto-answer, and the ledger entry
      // is still there waiting for the human.
      await new Promise(resolve => setTimeout(resolve, 600))
      expect(waitEvents.slice(since).filter(e => e.type === 'agent/notice')).toHaveLength(0)
      expect(waitManager.pendingPermissionViews()).toHaveLength(1)
      const responded = await dispatchRpc(waitManager, 'permission/respond', { requestId: request.requestId, optionId: 'allow1' })
      expect(responded.ok).toBe(true)
      const { chunks } = await waitDrained
      for (const chunk of chunks) {
        if (chunk.type === 'reasoning-delta') parts.push(chunk.text)
      }
      // No deadline clause: nothing is going to happen on its own.
      expect(parts.join('')).toContain('please answer the permission card above the composer')
      expect(parts.join('')).not.toContain('within')
    } finally {
      await waitManager.shutdownAll()
    }
  }, 30_000)
})
