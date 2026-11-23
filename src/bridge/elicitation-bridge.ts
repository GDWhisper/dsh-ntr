/**
 * Bridge-side handler for ACP `elicitation/create` requests.
 *
 * Kept out of `agent-bridge.ts` so the bridge file stays within the file-size
 * ratchet while giving elicitation asks the exact same lifecycle guarantees as
 * permission asks: live SSE broadcast, reconnect replay via `ElicitationLedger`,
 * stall-watchdog exemption, `AbortSignal` cleanup, and session-close settlement.
 */

import type { CreateElicitationRequest, CreateElicitationResponse } from '@agentclientprotocol/sdk'
import {
  elicitationRequestFrame,
  parseElicitationForm,
  type ElicitationLedger,
  type EventHub,
} from '../impl.ts'
import type { ElicitationOutcome } from '../protocol.ts'
import { lifecycleOf } from './session-lifecycle.ts'
import type { LiveSession } from './turn-stream.ts'

export interface ElicitationBridgeHost {
  readonly hub: EventHub
  readonly elicitations: ElicitationLedger
  sessionByAcpId(acpSessionId: string): LiveSession | undefined
  touch(): void
}

export async function handleBridgeElicitationRequest(
  host: ElicitationBridgeHost,
  params: CreateElicitationRequest,
  signal?: AbortSignal,
): Promise<CreateElicitationResponse> {
  const form = parseElicitationForm(params)
  if (form === undefined) return { action: 'decline' }
  const session = host.sessionByAcpId(form.acpSessionId)
  if (session === undefined || lifecycleOf(session) === 'closed') return { action: 'cancel' }

  // An elicitation ask is the agent speaking, not silence.
  session.lastAgentActivityAt = Date.now()
  const view = {
    ...(session.dshSessionId === undefined ? {} : { dshSessionId: session.dshSessionId }),
    ...(form.toolCallId === undefined ? {} : { toolCallId: form.toolCallId }),
    message: form.message,
    ...(form.title === undefined ? {} : { title: form.title }),
    ...(form.description === undefined ? {} : { description: form.description }),
    fields: form.fields,
  }

  return new Promise<CreateElicitationResponse>(resolve => {
    let detachSignal: (() => void) | undefined
    const requestId = host.elicitations.create(session.sessionId, (outcome: ElicitationOutcome) => {
      detachSignal?.()
      host.touch()
      session.lastAgentActivityAt = Date.now()
      host.hub.broadcast({
        type: 'elicitation/resolved',
        requestId,
        sessionId: session.sessionId,
        action: outcome.action,
      })
      resolve(outcome.action === 'accept'
        ? { action: 'accept', content: outcome.content }
        : { action: outcome.action })
    }, view)

    host.hub.broadcast(elicitationRequestFrame({ requestId, sessionId: session.sessionId, ...view }))

    if (signal !== undefined) {
      const onAbort = (): void => {
        if (!host.elicitations.has(requestId)) return
        host.elicitations.respond(requestId, { action: 'cancel' })
      }
      if (signal.aborted) {
        onAbort()
        return
      }
      signal.addEventListener('abort', onAbort, { once: true })
      detachSignal = () => { signal.removeEventListener('abort', onAbort) }
    }
  })
}
