/**
 * Pending ACP elicitation form asks (`elicitation/create`) for the staged DSH
 * conversation, rendered as composer-width cards above the composer
 * (`conversation.input.dock`).
 *
 * Mirrors `PermissionDock`: self-gated on the pending frame set for this
 * `dshSessionId` (renders nothing for non-NTR conversations or when idle),
 * keeps arrival order, and never hijacks global Enter/Escape shortcuts.
 */

import { useState } from 'react'
import type { ElicitationFieldView, ElicitationOutcome } from '../protocol.ts'
import { ensureAcpStyle, useUi } from './acp-ui.tsx'
import { DeadlineBadge, PendingDockShell, useDeadlineClock } from './pending-dock.tsx'
import {
  buildElicitationContent,
  elicitationsForSession,
  initialElicitationDraft,
  type AcpStore,
  type ElicitationDraft,
  type PendingElicitation,
} from './store.ts'

export interface ElicitationDockProps {
  acp: AcpStore
  sessionId: string
}

export function ElicitationDock({ acp, sessionId }: ElicitationDockProps) {
  ensureAcpStyle()
  const ui = useUi(acp)
  const pending = elicitationsForSession(ui.elicitations, String(sessionId))
  const now = useDeadlineClock(pending.some(item => item.deadlineAt !== undefined))
  if (pending.length === 0) return null
  return (
    <PendingDockShell
      className="ntr-elicit-dock"
      ariaLabel={acp.label('待回答的智能体提问', 'Pending agent questions')}
    >
      {pending.map(item => (
        <ElicitationAskCard key={item.requestId} acp={acp} elicitation={item} now={now} />
      ))}
    </PendingDockShell>
  )
}

export function ElicitationAskCard(props: { acp: AcpStore; elicitation: PendingElicitation; now?: number }) {
  const { acp, elicitation, now } = props
  const ownNow = useDeadlineClock(now === undefined && elicitation.deadlineAt !== undefined)
  const effectiveNow = now ?? ownNow
  const [draft, setDraft] = useState<ElicitationDraft>(() => initialElicitationDraft(elicitation.fields))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()

  const submit = (outcome: ElicitationOutcome): void => {
    if (busy) return
    setBusy(true)
    setError(undefined)
    void acp.respondElicitation(elicitation.requestId, outcome)
      .catch((failure: unknown) => {
        setError(failure instanceof Error ? failure.message : String(failure))
      })
      .finally(() => { setBusy(false) })
  }

  const onAccept = (): void => {
    const built = buildElicitationContent(elicitation.fields, draft, (zh, en) => acp.label(zh, en))
    if (!built.ok) {
      setError(built.error)
      return
    }
    submit({ action: 'accept', content: built.content })
  }

  const setField = (name: string, value: string | boolean | string[]): void => {
    setError(undefined)
    setDraft(prev => ({ ...prev, [name]: value }))
  }

  const headline = elicitation.title ?? (elicitation.message !== '' ? elicitation.message : acp.label('智能体需要你的输入', 'Agent requested your input'))
  const subtitle = elicitation.title !== undefined && elicitation.message !== '' && elicitation.message !== elicitation.title
    ? elicitation.message
    : elicitation.description

  return (
    <div className="ntr-elicit-card">
      <div className="ntr-elicit-head">
        <div className="ntr-elicit-head-row">
          <div className="ntr-elicit-title">{headline}</div>
          <DeadlineBadge acp={acp} deadlineAt={elicitation.deadlineAt} now={effectiveNow} mode="abort" />
        </div>
        {subtitle !== undefined && <div className="ntr-elicit-desc">{subtitle}</div>}
      </div>
      {elicitation.fields.length > 0 && (
        <div className="ntr-elicit-fields">
          {elicitation.fields.map(field => (
            <ElicitationFieldRow
              key={field.name}
              field={field}
              value={draft[field.name]}
              disabled={busy}
              onChange={value => { setField(field.name, value) }}
            />
          ))}
        </div>
      )}
      <div className="ntr-elicit-actions">
        <button type="button" className="ntr-elicit-submit" disabled={busy} onClick={onAccept}>
          {acp.label('提交', 'Submit')}
        </button>
        <button type="button" className="ntr-elicit-secondary" disabled={busy} onClick={() => { submit({ action: 'decline' }) }}>
          {acp.label('跳过', 'Decline')}
        </button>
        <button type="button" className="ntr-elicit-secondary" disabled={busy} onClick={() => { submit({ action: 'cancel' }) }}>
          {acp.label('取消', 'Cancel')}
        </button>
      </div>
      {error !== undefined && (
        <div className="ntr-permission-error" role="alert">{error}</div>
      )}
    </div>
  )
}

function ElicitationFieldRow(props: {
  field: ElicitationFieldView
  value: string | boolean | string[] | undefined
  disabled: boolean
  onChange: (value: string | boolean | string[]) => void
}) {
  const { field, value, disabled, onChange } = props

  if (field.kind === 'boolean') {
    const checked = value === true
    return (
      <label className="ntr-elicit-field ntr-elicit-checkbox-row">
        <input
          type="checkbox"
          checked={checked}
          disabled={disabled}
          onChange={e => { onChange(e.target.checked) }}
        />
        <span className="ntr-elicit-field-label">
          {field.title}
          {field.required && <span className="ntr-elicit-required">*</span>}
        </span>
        {field.description !== undefined && <span className="ntr-elicit-field-desc">{field.description}</span>}
      </label>
    )
  }

  if (field.kind === 'single-select' && field.options !== undefined && field.options.length > 0) {
    const selected = typeof value === 'string' ? value : ''
    return (
      <div className="ntr-elicit-field" role="radiogroup" aria-label={field.title}>
        <div className="ntr-elicit-field-label">
          {field.title}
          {field.required && <span className="ntr-elicit-required">*</span>}
        </div>
        {field.description !== undefined && <div className="ntr-elicit-field-desc">{field.description}</div>}
        <div className="ntr-elicit-options">
          {field.options.map(option => {
            const active = selected === option.value
            return (
              <button
                key={option.value}
                type="button"
                role="radio"
                aria-checked={active}
                disabled={disabled}
                className={`ntr-elicit-option${active ? ' is-selected' : ''}`}
                onClick={() => { onChange(option.value) }}
              >
                <span className="ntr-elicit-option-label">{option.label}</span>
                {option.description !== undefined && (
                  <span className="ntr-elicit-option-desc">{option.description}</span>
                )}
              </button>
            )
          })}
        </div>
      </div>
    )
  }

  if (field.kind === 'multi-select' && field.options !== undefined && field.options.length > 0) {
    const selected = Array.isArray(value) ? value : []
    const toggle = (optionValue: string): void => {
      const next = selected.includes(optionValue)
        ? selected.filter(v => v !== optionValue)
        : [...selected, optionValue]
      onChange(next)
    }
    return (
      <div className="ntr-elicit-field" role="group" aria-label={field.title}>
        <div className="ntr-elicit-field-label">
          {field.title}
          {field.required && <span className="ntr-elicit-required">*</span>}
        </div>
        {field.description !== undefined && <div className="ntr-elicit-field-desc">{field.description}</div>}
        <div className="ntr-elicit-options">
          {field.options.map(option => {
            const active = selected.includes(option.value)
            return (
              <button
                key={option.value}
                type="button"
                role="checkbox"
                aria-checked={active}
                disabled={disabled}
                className={`ntr-elicit-option${active ? ' is-selected' : ''}`}
                onClick={() => { toggle(option.value) }}
              >
                <span className="ntr-elicit-option-label">{option.label}</span>
                {option.description !== undefined && (
                  <span className="ntr-elicit-option-desc">{option.description}</span>
                )}
              </button>
            )
          })}
        </div>
      </div>
    )
  }

  const inputType = field.kind === 'number' || field.kind === 'integer'
    ? 'number'
    : field.format === 'email'
      ? 'email'
      : field.format === 'uri'
        ? 'url'
        : field.format === 'date'
          ? 'date'
          : 'text'

  return (
    <label className="ntr-elicit-field">
      <span className="ntr-elicit-field-label">
        {field.title}
        {field.required && <span className="ntr-elicit-required">*</span>}
      </span>
      {field.description !== undefined && <span className="ntr-elicit-field-desc">{field.description}</span>}
      <input
        type={inputType}
        className="ntr-elicit-input"
        value={typeof value === 'string' ? value : ''}
        disabled={disabled}
        step={field.kind === 'integer' ? 1 : field.kind === 'number' ? 'any' : undefined}
        min={field.minimum}
        max={field.maximum}
        minLength={field.minLength}
        maxLength={field.maxLength}
        onChange={e => { onChange(e.target.value) }}
      />
    </label>
  )
}
