/**
 * Browser-side ACP elicitation state & form-draft helpers.
 *
 * Mirrors `src/client/store/permission.ts`: pure functions only so form
 * initialization, validation, session filtering, and SSE event folding are
 * directly unit-testable without DOM or React.
 */

import type {
  AcpEvent,
  ElicitationContentValue,
  ElicitationFieldView,
  PendingElicitationView,
} from '../../protocol.ts'
import {
  pendingForSession,
  removePendingRequest,
  syncPendingRequests,
  upsertPendingRequest,
} from './pending.ts'

export type PendingElicitation = PendingElicitationView

/** Draft values held by the browser form before submission. */
export type ElicitationDraft = Record<string, string | boolean | string[]>

/** Filter pending elicitations belonging to one DSH chat conversation. */
export function elicitationsForSession(
  elicitations: readonly PendingElicitation[],
  dshSessionId: string,
): PendingElicitation[] {
  return pendingForSession(elicitations, dshSessionId)
}

/**
 * Fold one elicitation SSE frame into the pending list. Returns `undefined`
 * when the event is not an elicitation frame.
 */
export function reduceElicitationEvent(
  current: readonly PendingElicitation[],
  event: AcpEvent,
): PendingElicitation[] | undefined {
  switch (event.type) {
    case 'elicitation/request': {
      const entry: PendingElicitation = {
        requestId: event.requestId,
        sessionId: event.sessionId,
        ...(event.dshSessionId === undefined ? {} : { dshSessionId: event.dshSessionId }),
        ...(event.toolCallId === undefined ? {} : { toolCallId: event.toolCallId }),
        message: event.message,
        ...(event.title === undefined ? {} : { title: event.title }),
        ...(event.description === undefined ? {} : { description: event.description }),
        fields: event.fields,
        ...(event.omittedFields === undefined ? {} : { omittedFields: event.omittedFields }),
        ...(event.omittedOptions === undefined ? {} : { omittedOptions: event.omittedOptions }),
        ...(event.deadlineAt === undefined ? {} : { deadlineAt: event.deadlineAt }),
      }
      return upsertPendingRequest(current, entry)
    }
    case 'elicitation/resolved':
      return removePendingRequest(current, event.requestId)
    case 'elicitation/synced':
      return syncPendingRequests(current, event.requestIds)
    default:
      return undefined
  }
}

/** Seed form inputs from each field's schema default (when declared). */
export function initialElicitationDraft(fields: readonly ElicitationFieldView[]): ElicitationDraft {
  const draft: ElicitationDraft = {}
  for (const field of fields) {
    if (field.kind === 'boolean') {
      draft[field.name] = typeof field.defaultValue === 'boolean' ? field.defaultValue : false
    } else if (field.kind === 'multi-select') {
      draft[field.name] = Array.isArray(field.defaultValue) ? [...field.defaultValue] : []
    } else if (field.kind === 'number' || field.kind === 'integer') {
      draft[field.name] = typeof field.defaultValue === 'number' ? String(field.defaultValue) : ''
    } else {
      draft[field.name] = typeof field.defaultValue === 'string' ? field.defaultValue : ''
    }
  }
  return draft
}

export type ElicitationBuildResult =
  | { ok: true; content: Record<string, ElicitationContentValue> }
  | { ok: false; error: string }

/**
 * Convert and validate a browser form draft into the wire `content` object
 * accepted by ACP `CreateElicitationResponse`.
 */
export function buildElicitationContent(
  fields: readonly ElicitationFieldView[],
  draft: ElicitationDraft,
  label: (zh: string, en: string) => string,
): ElicitationBuildResult {
  const content: Record<string, ElicitationContentValue> = {}
  for (const field of fields) {
    const raw = draft[field.name]
    if (field.kind === 'boolean') {
      content[field.name] = raw === true
      continue
    }
    if (field.kind === 'multi-select') {
      const selected = Array.isArray(raw) ? raw : []
      if (field.options !== undefined && field.options.length > 0) {
        const allowed = new Set(field.options.map(o => o.value))
        if (selected.some(v => !allowed.has(v))) {
          return { ok: false, error: label(`「${field.title}」包含无效选项`, `"${field.title}" contains an invalid option`) }
        }
      }
      if (field.required && selected.length === 0) {
        return { ok: false, error: label(`请至少选择一项：${field.title}`, `Select at least one option for "${field.title}"`) }
      }
      if (field.minItems !== undefined && selected.length < field.minItems) {
        return { ok: false, error: label(`「${field.title}」至少选择 ${String(field.minItems)} 项`, `Select at least ${String(field.minItems)} option(s) for "${field.title}"`) }
      }
      if (field.maxItems !== undefined && selected.length > field.maxItems) {
        return { ok: false, error: label(`「${field.title}」最多选择 ${String(field.maxItems)} 项`, `Select at most ${String(field.maxItems)} option(s) for "${field.title}"`) }
      }
      if (selected.length > 0 || field.required) content[field.name] = selected
      continue
    }
    if (field.kind === 'number' || field.kind === 'integer') {
      const text = typeof raw === 'string' ? raw.trim() : ''
      if (text === '') {
        if (field.required) {
          return { ok: false, error: label(`请填写必填项：${field.title}`, `Required field missing: "${field.title}"`) }
        }
        continue
      }
      const num = Number(text)
      if (!Number.isFinite(num)) {
        return { ok: false, error: label(`「${field.title}」请输入有效数字`, `"${field.title}" must be a valid number`) }
      }
      if (field.kind === 'integer' && !Number.isInteger(num)) {
        return { ok: false, error: label(`「${field.title}」请输入整数`, `"${field.title}" must be an integer`) }
      }
      if (field.minimum !== undefined && num < field.minimum) {
        return { ok: false, error: label(`「${field.title}」不能小于 ${String(field.minimum)}`, `"${field.title}" must be at least ${String(field.minimum)}`) }
      }
      if (field.maximum !== undefined && num > field.maximum) {
        return { ok: false, error: label(`「${field.title}」不能大于 ${String(field.maximum)}`, `"${field.title}" must be at most ${String(field.maximum)}`) }
      }
      content[field.name] = num
      continue
    }
    // `string` or `single-select`
    const text = typeof raw === 'string' ? raw : ''
    if (text.trim() === '') {
      if (field.required) {
        return { ok: false, error: label(
          field.kind === 'single-select' ? `请选择：${field.title}` : `请填写必填项：${field.title}`,
          field.kind === 'single-select' ? `Please choose an option for "${field.title}"` : `Required field missing: "${field.title}"`,
        ) }
      }
      continue
    }
    if (field.kind === 'single-select' && field.options !== undefined && field.options.length > 0) {
      if (!field.options.some(o => o.value === text)) {
        return { ok: false, error: label(`请选择「${field.title}」提供的有效选项`, `Choose a valid option for "${field.title}"`) }
      }
    }
    if (field.minLength !== undefined && text.length < field.minLength) {
      return { ok: false, error: label(`「${field.title}」至少需要 ${String(field.minLength)} 个字符`, `"${field.title}" must be at least ${String(field.minLength)} characters`) }
    }
    if (field.maxLength !== undefined && text.length > field.maxLength) {
      return { ok: false, error: label(`「${field.title}」最多 ${String(field.maxLength)} 个字符`, `"${field.title}" must be at most ${String(field.maxLength)} characters`) }
    }
    content[field.name] = text
  }
  return { ok: true, content }
}
