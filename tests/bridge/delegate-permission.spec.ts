/**
 * The delegation-only session permission policy (plan §4.2 / §7.4): a shared
 * bridge's approval knobs must not preempt a delegate session's own rung, and
 * writing the policy must never touch the bridge-level fields. Drives
 * `handlePermissionRequest` directly (the permissions.spec.ts seam precedent):
 * the mock agent only offers allow_once/reject_once, and preferOnce needs an
 * ask that offers allow_always beside allow_once.
 */
import { describe, expect, it } from 'vitest'
import { AgentBridge } from '../../src/bridge.ts'
import { BridgeRpcService, type BridgeRpcHost } from '../../src/bridge/bridge-rpc-service.ts'
import { AcpError, EventHub } from '../../src/impl.ts'
import type { AcpEvent, PermissionTimeoutMode } from '../../src/protocol.ts'
import { def } from './harness.ts'

type SeamSession = {
  sessionId: string
  acpSessionId: string
  lifecycle: string
  permissionPolicy?: { mode: PermissionTimeoutMode; windowMs: number; preferOnce?: boolean }
}
type PolicySeam = {
  acpIndex: Map<string, SeamSession>
  permissionTimeoutMode: PermissionTimeoutMode
  permissionTimeoutMs: number
  handlePermissionRequest(acpSessionId: string, toolCall: unknown, options: Array<{ optionId: string; name: string; kind: string }>): Promise<{ outcome: { outcome: string; optionId?: string } }>
}

/** One bridge, two sessions on it: the main conversation and a delegate. */
function makeSeam(mode: PermissionTimeoutMode, windowMs: number) {
  const hub = new EventHub()
  const events: AcpEvent[] = []
  hub.subscribe(event => { events.push(event) })
  const bridge = new AgentBridge({ ...def, id: 'deleg' }, hub, 500, () => {}, undefined, undefined, { permissionTimeoutMode: mode, permissionTimeoutMs: windowMs })
  const seam = bridge as unknown as PolicySeam
  const main: SeamSession = { sessionId: 'host-main', acpSessionId: 'acp-main', lifecycle: 'live' }
  const delegate: SeamSession = { sessionId: 'host-deleg', acpSessionId: 'acp-deleg', lifecycle: 'live' }
  seam.acpIndex.set('acp-main', main)
  seam.acpIndex.set('acp-deleg', delegate)
  // The real write path: rpc service → tryLocate → LiveSession.permissionPolicy.
  const rpc = new BridgeRpcService({ bridgeRegistry: { tryLocate: (id: string) => id === delegate.sessionId ? { bridge, session: delegate } : undefined } } as unknown as BridgeRpcHost)
  return { bridge, seam, events, delegate, rpc }
}

const bothKinds = [
  { optionId: 'always1', name: 'Always allow', kind: 'allow_always' },
  { optionId: 'once1', name: 'Allow once', kind: 'allow_once' },
]
const requestOf = (events: AcpEvent[], sessionId: string): Extract<AcpEvent, { type: 'permission/request' }> | undefined =>
  events.find((e): e is Extract<AcpEvent, { type: 'permission/request' }> => e.type === 'permission/request' && e.sessionId === sessionId)

describe('a delegate session policy outranks the bridge knobs (plan §4.2)', () => {
  it('bridge auto+0 answers the main ask on arrival; a delegate abort rung still reaches the ledger', async () => {
    const { bridge, seam, events, rpc } = makeSeam('auto', 0)
    // Main session: arrival-settled, no card, no ledger entry (constraint 13).
    await expect(seam.handlePermissionRequest('acp-main', { title: 'Bash' }, bothKinds))
      .resolves.toEqual({ outcome: { outcome: 'selected', optionId: 'always1' } })
    expect(requestOf(events, 'host-main')).toBeUndefined()
    expect(events.filter(e => e.type === 'permission/expired' && e.sessionId === 'host-main')).toHaveLength(1)
    // Delegate {abort, 30000}: the frame ARRIVES and the service can answer cancelled.
    rpc.setPermissionPolicy('host-deleg', { mode: 'abort', windowMs: 30_000 })
    const asked = seam.handlePermissionRequest('acp-deleg', { title: 'Bash' }, bothKinds)
    const frame = requestOf(events, 'host-deleg')
    expect(frame).toMatchObject({ timeoutMode: 'abort' })
    expect(typeof frame!.deadlineAt).toBe('number')
    bridge.permissions.respond(frame!.requestId, { outcome: 'cancelled' })
    await expect(asked).resolves.toEqual({ outcome: { outcome: 'cancelled' } })
  })

  it('bridge auto+0 does not preempt a delegate wait rung', async () => {
    const { bridge, seam, events, rpc } = makeSeam('auto', 0)
    rpc.setPermissionPolicy('host-deleg', { mode: 'wait', windowMs: 0 })
    const asked = seam.handlePermissionRequest('acp-deleg', { title: 'Bash' }, bothKinds)
    const frame = requestOf(events, 'host-deleg')
    expect(frame).toMatchObject({ timeoutMode: 'wait' })
    expect(frame).not.toHaveProperty('deadlineAt')
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(bridge.permissions.has(frame!.requestId)).toBe(true) // still waiting for a human
    bridge.permissions.respond(frame!.requestId, { outcome: 'selected', optionId: 'once1' })
    await expect(asked).resolves.toEqual({ outcome: { outcome: 'selected', optionId: 'once1' } })
  })

  it('a bridge abort window does not time out a delegate wait rung', async () => {
    const { bridge, seam, events, rpc } = makeSeam('abort', 150)
    rpc.setPermissionPolicy('host-deleg', { mode: 'wait', windowMs: 0 })
    const asked = seam.handlePermissionRequest('acp-deleg', { title: 'Bash' }, bothKinds)
    const frame = requestOf(events, 'host-deleg')
    // The bridge's own timer IS armed — the main ask expires on it…
    await expect(seam.handlePermissionRequest('acp-main', { title: 'Bash' }, bothKinds))
      .resolves.toEqual({ outcome: { outcome: 'cancelled' } })
    // …but it never touches the delegate's human wait.
    expect(bridge.permissions.has(frame!.requestId)).toBe(true)
    expect(events.filter(e => e.type === 'permission/expired' && e.sessionId === 'host-deleg')).toHaveLength(0)
    bridge.permissions.respond(frame!.requestId, { outcome: 'selected', optionId: 'once1' })
    await expect(asked).resolves.toEqual({ outcome: { outcome: 'selected', optionId: 'once1' } })
  })

  it('writing a delegate policy never touches the bridge-level knobs', () => {
    const { seam, delegate, rpc } = makeSeam('auto', 0)
    const before = { mode: seam.permissionTimeoutMode, ms: seam.permissionTimeoutMs }
    rpc.setPermissionPolicy('host-deleg', { mode: 'wait', windowMs: 0 })
    rpc.setPermissionPolicy('host-deleg', { mode: 'auto', windowMs: 0, preferOnce: true })
    expect(delegate.permissionPolicy).toEqual({ mode: 'auto', windowMs: 0, preferOnce: true })
    expect({ mode: seam.permissionTimeoutMode, ms: seam.permissionTimeoutMs }).toEqual(before)
    // Unknown id answers with the same error closeSession uses.
    let code = ''
    try { rpc.setPermissionPolicy('host-gone', { mode: 'wait', windowMs: 0 }) } catch (error) { code = (error as AcpError).code }
    expect(code).toBe('unknown_session')
  })

  it('preferOnce answers the delegate with allow_once; the main auto+0 keeps allow_always', async () => {
    const { seam, events, rpc } = makeSeam('auto', 0)
    rpc.setPermissionPolicy('host-deleg', { mode: 'auto', windowMs: 0, preferOnce: true })
    await expect(seam.handlePermissionRequest('acp-deleg', { title: 'Bash' }, bothKinds))
      .resolves.toEqual({ outcome: { outcome: 'selected', optionId: 'once1' } })
    await expect(seam.handlePermissionRequest('acp-main', { title: 'Bash' }, bothKinds))
      .resolves.toEqual({ outcome: { outcome: 'selected', optionId: 'always1' } })
    // Both settled on arrival: no card for either, one expiry trace each.
    expect(events.filter(e => e.type === 'permission/request')).toHaveLength(0)
    expect(events.filter(e => e.type === 'permission/expired')).toHaveLength(2)
  })
})