/**
 * The extracted expiry path (`src/bridge/expired-ask.ts`).
 *
 * A question and an approval share the wire method but not the answer:
 * an approval is answered by option KIND (`allow_always` first), a question by
 * the agent's ORDER (`first`) or not at all (`cancel`, the default).
 *
 * Driving the module directly keeps this about the decision and the frames —
 * the spawn-level pipeline is covered by the approval suites.
 */

import { describe, expect, it } from 'vitest'
import { AgentBridge } from '../../src/bridge.ts'
import { announceExpiredAsk, expiredChatLine, permissionChatLine, settleExpiredAsk } from '../../src/bridge/expired-ask.ts'
import { questionAskKindOf } from '../../src/bridge/question-ask.ts'
import { EventHub, permissionReplayFrames } from '../../src/impl.ts'
import type { LiveSession } from '../../src/bridge/turn-stream.ts'
import type { AcpAgentDef, AcpEvent, AcpDelegatePolicy } from '../../src/protocol.ts'
import type { RequestPermissionResponse } from '@agentclientprotocol/sdk'

const OPTIONS = [
  { optionId: 'allow1', name: 'Allow once', kind: 'allow_once' },
  { optionId: 'always1', name: 'Always Allow', kind: 'allow_always' },
]

function fakeSession(): LiveSession {
  return { sessionId: 'sess-1', lastAgentActivityAt: 0 } as unknown as LiveSession
}

function capture(): { hub: EventHub; events: AcpEvent[]; host: { agentId: string; hub: EventHub } } {
  const hub = new EventHub()
  const events: AcpEvent[] = []
  hub.subscribe(event => { events.push(event) })
  return { hub, events, host: { agentId: 'agy', hub } }
}

describe('expired question asks', () => {
  it('sends the FIRST option in `first` mode and names it', () => {
    const { events, host } = capture()
    const outcome = announceExpiredAsk(host, fakeSession(), 'wait', { toolCallId: 'interaction_1', title: 'Which approach?' }, OPTIONS, 300_000, 'question', 'first')

    // `pickAutoOption` would have chosen `always1` (allow_always); a question
    // takes the agent's own order instead.
    expect(outcome).toEqual({ outcome: 'selected', optionId: 'allow1' })
    const expired = events.find((event): event is Extract<AcpEvent, { type: 'permission/expired' }> => event.type === 'permission/expired')
    expect(expired).toMatchObject({
      askKind: 'question',
      optionName: 'Allow once',
      outcome: { outcome: 'selected', optionId: 'allow1' },
    })
    const notices = events.filter((event): event is Extract<AcpEvent, { type: 'agent/notice' }> => event.type === 'agent/notice')
    expect(notices).toHaveLength(1)
    expect(notices[0]?.text).toContain('question for "Which approach?"')
    expect(notices[0]?.text).toContain('answered "Allow once"')
  })

  it('cancels in the default mode and never answers for the user', () => {
    const { events, host } = capture()
    const outcome = announceExpiredAsk(host, fakeSession(), 'wait', { toolCallId: 'interaction_2', title: 'Which approach?' }, OPTIONS, 300_000, 'question', 'cancel')

    expect(outcome).toEqual({ outcome: 'cancelled' })
    const expired = events.find((event): event is Extract<AcpEvent, { type: 'permission/expired' }> => event.type === 'permission/expired')
    expect(expired).toMatchObject({ askKind: 'question', outcome: { outcome: 'cancelled' } })
    expect(expired).not.toHaveProperty('optionName')
    const notices = events.filter((event): event is Extract<AcpEvent, { type: 'agent/notice' }> => event.type === 'agent/notice')
    expect(notices).toHaveLength(1)
    expect(notices[0]?.text).toContain('cancelled, not answered for you')
  })

  it('degrades to cancel when a question has no usable option', () => {
    const { events, host } = capture()
    const outcome = announceExpiredAsk(host, fakeSession(), 'wait', { toolCallId: 'interaction_3' }, [{ optionId: '', name: 'Broken', kind: 'allow_once' }], 1_000, 'question', 'first')
    expect(outcome).toEqual({ outcome: 'cancelled' })
    expect(events.find(event => event.type === 'permission/expired')).toMatchObject({ askKind: 'question', outcome: { outcome: 'cancelled' } })
  })

  it('settles a delegated question at once without inventing an answer', () => {
    const { events, host } = capture()
    const response = settleExpiredAsk(host, fakeSession(), 'wait', { toolCallId: 'interaction_4' }, OPTIONS, 0, 'question', 'cancel')
    expect(response).toEqual({ outcome: { outcome: 'cancelled' } })
    const notice = events.find((event): event is Extract<AcpEvent, { type: 'agent/notice' }> => event.type === 'agent/notice')
    // "was not waited for" is the arrival path's own wording, not "timed out".
    expect(notice?.text).toContain('was not waited for')
  })
})

describe('expired approval asks (regression)', () => {
  it('keeps the kind-priority answer and the approval frame shape', () => {
    const { events, host } = capture()
    const outcome = announceExpiredAsk(host, fakeSession(), 'auto', { toolCallId: 'call_1', title: 'mock dangerous operation' }, OPTIONS, 2_000, 'approval', 'cancel')

    expect(outcome).toEqual({ outcome: 'selected', optionId: 'always1' })
    const expired = events.find((event): event is Extract<AcpEvent, { type: 'permission/expired' }> => event.type === 'permission/expired')
    expect(expired).toMatchObject({ optionName: 'Always Allow' })
    // No question fields on an approval frame: the old shape, byte for byte.
    expect(expired).not.toHaveProperty('askKind')
    const notice = events.find((event): event is Extract<AcpEvent, { type: 'agent/notice' }> => event.type === 'agent/notice')
    expect(notice?.text).toContain('permission request for "mock dangerous operation"')
    expect(notice?.text).toContain('answered "Always Allow"')
  })

  it('refuses in `abort` with the original wording', () => {
    const { events, host } = capture()
    const outcome = announceExpiredAsk(host, fakeSession(), 'abort', { toolCallId: 'call_2' }, OPTIONS, 2_000, 'approval', 'cancel')
    expect(outcome).toEqual({ outcome: 'cancelled' })
    const notice = events.find((event): event is Extract<AcpEvent, { type: 'agent/notice' }> => event.type === 'agent/notice')
    expect(notice?.text).toContain('timed out after 2s; refused')
  })
})

describe('questionAskKindOf gate and chat prose lines', () => {
  const agyDef: AcpAgentDef = { id: 'agy', command: 'agy', args: ['acp'] }
  const otherDef: AcpAgentDef = { id: 'cb', command: 'codebuddy', args: ['--acp'] }

  it('recognizes `interaction_` only on Antigravity bridges', () => {
    expect(questionAskKindOf(agyDef, { toolCallId: 'interaction_1234abcd' })).toBe('question')
    expect(questionAskKindOf(agyDef, { toolCallId: 'call_1' })).toBe('approval')
    expect(questionAskKindOf(otherDef, { toolCallId: 'interaction_1234abcd' })).toBe('approval')
  })

  it('formats question request and expiry lines apart from approvals', () => {
    const req = permissionChatLine({
      type: 'permission/request',
      requestId: 'r1',
      sessionId: 's1',
      dshSessionId: 'chat-1',
      toolCall: { toolCallId: 'interaction_1', title: 'Which approach?' },
      toolName: 'Which approach?',
      reason: 'Choose deployment mode',
      options: OPTIONS,
      timeoutMode: 'wait',
      deadlineAt: Date.now() + 10_000,
      askKind: 'question',
      questionTimeoutMode: 'first',
      autoOptionName: 'Allow once',
    })
    expect(req).toContain('❓ [Question: Choose deployment mode]')
    expect(req).toContain('"Allow once" is sent automatically')

    const exp = expiredChatLine({
      toolCall: { toolCallId: 'interaction_1', title: 'Which approach?' },
      timeoutMs: 10_000,
      outcome: { outcome: 'cancelled' },
      askKind: 'question',
    })
    expect(exp).toContain('❓ [Question: Which approach?]')
    expect(exp).toContain('cancelled, not answered for you')

    const approvalExp = expiredChatLine({
      toolCall: { toolCallId: 'call_1', title: 'Edit file' },
      timeoutMs: 10_000,
      outcome: { outcome: 'cancelled' },
    })
    expect(approvalExp).toContain('🔐 [Permission Required: Edit file]')
    expect(approvalExp).toContain('; refused')
  })
})

describe('AgentBridge.handlePermissionRequest for questions', () => {
  const agyDef: AcpAgentDef = { id: 'agy', command: 'agy', args: ['acp'] }

  function bridgeWithSession(tuning: {
    permissionTimeoutMode?: 'abort' | 'auto' | 'wait'
    permissionTimeoutMs?: number
    elicitationTimeoutMs?: number
    questionTimeoutMode?: 'cancel' | 'first'
    permissionPolicy?: AcpDelegatePolicy
  }) {
    const { hub, events } = capture()
    const bridge = new AgentBridge(agyDef, hub, 500, () => {}, undefined, undefined, tuning)
    const session = {
      sessionId: 'sess-q',
      agentId: 'agy',
      acpSessionId: 'acp-q',
      cwd: 'M:/Coding/dsh-ntr',
      running: true,
      lifecycle: 'live',
      dshSessionId: tuning.permissionPolicy === undefined ? 'chat-q' : undefined,
      lastAgentActivityAt: 0,
      permissionPolicy: tuning.permissionPolicy,
    } as unknown as LiveSession
    ;(bridge as unknown as { acpIndex: Map<string, LiveSession> }).acpIndex.set('acp-q', session)
    const ask = (toolCall: unknown) =>
      (bridge as unknown as {
        handlePermissionRequest: (id: string, tc: unknown, opts: typeof OPTIONS) => Promise<RequestPermissionResponse>
      }).handlePermissionRequest('acp-q', toolCall, OPTIONS)
    return { bridge, hub, events, ask }
  }

  it('never skips card creation under approval `auto` + 0 and matches replay frames byte-for-byte', async () => {
    const { bridge, events, ask } = bridgeWithSession({
      permissionTimeoutMode: 'auto',
      permissionTimeoutMs: 0,
      elicitationTimeoutMs: 60_000,
      questionTimeoutMode: 'first',
    })
    const pending = ask({ toolCallId: 'interaction_deadbeef', title: 'Pick one' })
    const live = events.find((e): e is Extract<AcpEvent, { type: 'permission/request' }> => e.type === 'permission/request')
    expect(live).toBeDefined()
    expect(live).toMatchObject({
      askKind: 'question',
      questionTimeoutMode: 'first',
      autoOptionName: 'Allow once',
    })
    expect(live?.deadlineAt).toBeTypeOf('number')

    const replayed = permissionReplayFrames(bridge.permissions.pendingViews())
    expect(replayed).toHaveLength(2)
    expect(replayed[0]).toEqual(live)
    expect(replayed[1]).toMatchObject({ type: 'permission/synced', requestIds: [live!.requestId] })

    expect(bridge.permissions.respond(live!.requestId, { outcome: 'selected', optionId: 'always1' })).toBe(true)
    await expect(pending).resolves.toEqual({ outcome: { outcome: 'selected', optionId: 'always1' } })
  })

  it('fires the `first` expiry timer on a real ask and ignores zero-window expiry', async () => {
    const fast = bridgeWithSession({
      permissionTimeoutMode: 'wait',
      elicitationTimeoutMs: 25,
      questionTimeoutMode: 'first',
    })
    await expect(fast.ask({ toolCallId: 'interaction_timer1', title: 'Pick one' })).resolves.toEqual({
      outcome: { outcome: 'selected', optionId: 'allow1' },
    })
    expect(fast.events.find(e => e.type === 'permission/expired')).toMatchObject({
      askKind: 'question',
      optionName: 'Allow once',
      outcome: { outcome: 'selected', optionId: 'allow1' },
    })

    const unlimited = bridgeWithSession({
      permissionTimeoutMode: 'auto',
      permissionTimeoutMs: 10,
      elicitationTimeoutMs: 0,
      questionTimeoutMode: 'first',
    })
    const pending = unlimited.ask({ toolCallId: 'interaction_nolimit', title: 'Wait forever' })
    await new Promise(resolve => setTimeout(resolve, 40))
    const live = unlimited.events.find((e): e is Extract<AcpEvent, { type: 'permission/request' }> => e.type === 'permission/request')
    expect(live?.deadlineAt).toBeUndefined()
    expect(live).not.toHaveProperty('questionTimeoutMode')
    expect(live).not.toHaveProperty('autoOptionName')
    expect(unlimited.events.some(e => e.type === 'permission/expired')).toBe(false)
    unlimited.bridge.permissions.respond(live!.requestId, { outcome: 'cancelled' })
    await expect(pending).resolves.toEqual({ outcome: { outcome: 'cancelled' } })
  })

  it('settles delegated sessions immediately under both `cancel` and `first`', async () => {
    const cancelDelegated = bridgeWithSession({
      elicitationTimeoutMs: 0,
      questionTimeoutMode: 'cancel',
      permissionPolicy: { mode: 'auto', windowMs: 0, preferOnce: true },
    })
    await expect(cancelDelegated.ask({ toolCallId: 'interaction_del_c', title: 'Delegated' })).resolves.toEqual({
      outcome: { outcome: 'cancelled' },
    })
    expect(cancelDelegated.events.some(e => e.type === 'permission/request')).toBe(false)

    const firstDelegated = bridgeWithSession({
      elicitationTimeoutMs: 0,
      questionTimeoutMode: 'first',
      permissionPolicy: { mode: 'auto', windowMs: 0, preferOnce: true },
    })
    await expect(firstDelegated.ask({ toolCallId: 'interaction_del_f', title: 'Delegated' })).resolves.toEqual({
      outcome: { outcome: 'selected', optionId: 'allow1' },
    })
    expect(firstDelegated.events.some(e => e.type === 'permission/request')).toBe(false)
    expect(firstDelegated.events.find(e => e.type === 'permission/expired')).toMatchObject({
      askKind: 'question',
      optionName: 'Allow once',
      outcome: { outcome: 'selected', optionId: 'allow1' },
    })
  })
})
