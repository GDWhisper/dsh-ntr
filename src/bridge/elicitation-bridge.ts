/**
 * Bridge-side handler for ACP `elicitation/create` requests.
 *
 * Kept out of `agent-bridge.ts` so the bridge file stays within the file-size
 * ratchet while giving elicitation asks the exact same lifecycle guarantees as
 * permission asks: live SSE broadcast, reconnect replay via `ElicitationLedger`,
 * bounded deadline expiry (`elicitationTimeoutMs`, settling as `cancel` + one
 * `agent/notice`), stall-watchdog exemption, `AbortSignal` cleanup, and
 * session-close settlement.
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
  readonly agentId: string
  readonly elicitationTimeoutMs: number
  readonly hub: EventHub
  readonly elicitations: ElicitationLedger
  sessionByAcpId(acpSessionId: string): LiveSession | undefined
  touch(): void
}

function noticeLabel(title: string | undefined, message: string): string {
  const raw = title ?? (message !== '' ? message : 'form')
  return raw.length > 80 ? `${raw.slice(0, 79)}…` : raw
}

export async function handleBridgeElicitationRequest(
  host: ElicitationBridgeHost,
  params: CreateElicitationRequest,
  signal?: AbortSignal,
): Promise<CreateElicitationResponse> {
  const form = parseElicitationForm(params)
  if (form === undefined) return { action: 'cancel' }
  const session = host.sessionByAcpId(form.acpSessionId)
  if (session === undefined || lifecycleOf(session) === 'closed') return { action: 'cancel' }

  // An elicitation ask is the agent speaking, not silence.
  session.lastAgentActivityAt = Date.now()
  const timeoutMs = host.elicitationTimeoutMs
  const deadlineAt = timeoutMs > 0 ? Date.now() + timeoutMs : undefined
  const view = {
    ...(session.dshSessionId === undefined ? {} : { dshSessionId: session.dshSessionId }),
    ...(form.toolCallId === undefined ? {} : { toolCallId: form.toolCallId }),
    message: form.message,
    ...(form.title === undefined ? {} : { title: form.title }),
    ...(form.description === undefined ? {} : { description: form.description }),
    fields: form.fields,
    ...(form.omittedFields === undefined ? {} : { omittedFields: form.omittedFields }),
    ...(form.omittedOptions === undefined ? {} : { omittedOptions: form.omittedOptions }),
    ...(deadlineAt === undefined ? {} : { deadlineAt }),
  }

  return new Promise<CreateElicitationResponse>(resolve => {
    let timer: ReturnType<typeof setTimeout> | undefined
    let detachSignal: (() => void) | undefined
    const requestId = host.elicitations.create(session.sessionId, (outcome: ElicitationOutcome) => {
      clearTimeout(timer)
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

    if (deadlineAt !== undefined) {
      const label = noticeLabel(form.title, form.message)
      timer = setTimeout(() => {
        if (!host.elicitations.has(requestId)) return
        host.hub.broadcast({
          type: 'agent/notice',
          agentId: host.agentId,
          level: 'info',
          text: `acp: elicitation request "${label}" timed out after ${String(Math.round(timeoutMs / 1000))}s; cancelled`,
        })
        host.elicitations.respond(requestId, { action: 'cancel' })
      }, Math.max(0, deadlineAt - Date.now()))
      timer.unref?.()
    }

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
