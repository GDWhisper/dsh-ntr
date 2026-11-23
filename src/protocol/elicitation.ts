/**
 * ACP form elicitation contracts (`elicitation/create` → browser form card →
 * `elicitation/respond`).
 *
 * Part of the protocol contract; the barrel is `src/protocol.ts` and every
 * existing `../protocol.ts` import keeps resolving through it. Pure types only.
 */

/** Allowed primitive / array values carried in an accepted elicitation form. */
export type ElicitationContentValue = string | number | boolean | string[]

/** One selectable option in a single-select or multi-select elicitation field. */
export interface ElicitationOption {
  value: string
  label: string
  description?: string
}

/** Normalized form field kind derived from ACP `ElicitationPropertySchema`. */
export type ElicitationFieldKind =
  | 'string'
  | 'number'
  | 'integer'
  | 'boolean'
  | 'single-select'
  | 'multi-select'

/** Browser-facing view of one property in an ACP elicitation `requestedSchema`. */
export interface ElicitationFieldView {
  name: string
  kind: ElicitationFieldKind
  title: string
  description?: string
  required: boolean
  options?: ElicitationOption[]
  defaultValue?: ElicitationContentValue
  minLength?: number
  maxLength?: number
  minimum?: number
  maximum?: number
  minItems?: number
  maxItems?: number
  format?: string
}

/** Everything an `elicitation/request` frame carries besides ids owned by the ledger. */
export interface PendingElicitationFields {
  /** DSH chat session id; absent for `/acp` RPC-only sessions. */
  dshSessionId?: string
  /** ACP tool call id that triggered this elicitation, when provided. */
  toolCallId?: string
  /** Agent-supplied prompt describing what input is needed. */
  message: string
  /** Optional schema-level title. */
  title?: string
  /** Optional schema-level description. */
  description?: string
  /** Ordered form fields derived from `requestedSchema.properties`. */
  fields: ElicitationFieldView[]
}

/** One outstanding elicitation ask as the browser renders and replays it. */
export interface PendingElicitationView extends PendingElicitationFields {
  requestId: string
  /** Host session id (`LiveSession.sessionId`). */
  sessionId: string
}

/** User outcome submitted back to the ACP `elicitation/create` request. */
export type ElicitationOutcome =
  | { action: 'accept'; content: Record<string, ElicitationContentValue> }
  | { action: 'decline' }
  | { action: 'cancel' }

/** RPC payload for `POST /acp/elicitation/respond`. */
export interface ElicitationRespondPayload {
  requestId: string
  action: 'accept' | 'decline' | 'cancel'
  content?: Record<string, ElicitationContentValue>
}
