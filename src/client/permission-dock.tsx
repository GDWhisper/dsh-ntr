/**
 * Pending ACP permission asks for the staged DSH conversation, rendered as
 * composer-width entries above the composer card (`conversation.input.dock`).
 * The slot itself spans the conversation column; the dock mirrors the host's
 * InputBar width formula so the cards line up with the input box.
 *
 * The host broadcasts every ask as `permission/request`, carrying the DSH chat
 * session id when the ask belongs to a conversation. This dock is the primary
 * answer surface: it renders exactly the asks whose `dshSessionId` is the
 * conversation it was mounted for, and nothing otherwise. There is no
 * ACP-mode gate — the frame set itself is the gate, so an ordinary
 * conversation shows this card if and only if it actually has an ask.
 *
 * The ask's description and options are the agent's own: buttons appear in the
 * agent's order with the agent's names (including "Always Allow"), and
 * `kind` is not rendered. A separate cancel button answers with no option,
 * which the host forwards as `cancelled`. No Enter/Escape handlers: the
 * composer owns its keyboard, and these are ordinary focusable buttons.
 *
 * Multiple asks stack in ARRIVAL order, oldest first: the question ignored
 * longest stays at the top. The list is capped in height by CSS and scrolls.
 * Asks without a chat identity never appear here — they stay in the
 * settings-panel ledger, the cross-session mirror.
 */

import { useState } from 'react'
import { ensureAcpStyle, useUi } from './acp-ui.tsx'
import { DeadlineBadge, PendingDockShell, useDeadlineClock } from './pending-dock.tsx'
import { permissionsForSession } from './store.ts'
import type { AcpStore, PendingPermission } from './store.ts'
import type { PermissionOptionView } from '../protocol.ts'

export interface PermissionDockProps {
  /** Injected face: the store plus the chat session id this dock belongs to. */
  acp: AcpStore
  sessionId: string
}

export function questionExpiryLabel(acp: AcpStore, permission: PendingPermission): string | undefined {
  if (permission.askKind !== 'question' || permission.deadlineAt === undefined) return undefined
  if (permission.questionTimeoutMode === 'first' && permission.autoOptionName !== undefined && permission.autoOptionName !== '') {
    return acp.label(
      `到期将自动选择「${permission.autoOptionName}」`,
      `On expiry, “${permission.autoOptionName}” is sent for you`,
    )
  }
  return acp.label('到期将取消，不会替你作答', 'On expiry the question is cancelled — nothing is chosen for you')
}

export function PermissionOptionWarnings({ options }: { options: readonly PermissionOptionView[] }) {
  const warned = options.filter(option => option.warning !== undefined && option.warning !== '')
  if (warned.length === 0) return null
  return (
    <div className="ntr-permission-warnings">
      {warned.map(option => (
        <div key={option.optionId} className="ntr-permission-warning">
          <span className="ntr-permission-warning-option">{option.name}: </span>
          <span>{option.warning}</span>
        </div>
      ))}
    </div>
  )
}

export function PermissionDock({ acp, sessionId }: PermissionDockProps) {
  ensureAcpStyle()
  const ui = useUi(acp)
  const dshSessionId = String(sessionId)
  const pending = permissionsForSession(ui.permissions, dshSessionId)
  const counting = pending.some(ask => (ask.askKind === 'question' || ask.timeoutMode !== 'wait') && ask.deadlineAt !== undefined)
  const now = useDeadlineClock(counting)
  if (pending.length === 0) return null
  return (
    <PendingDockShell
      className="ntr-permission-dock"
      ariaLabel={acp.label('待处理的权限请求', 'Pending permission requests')}
    >
      {pending.map(permission => (
        <PermissionAskCard key={permission.requestId} acp={acp} permission={permission} now={now} />
      ))}
    </PendingDockShell>
  )
}

function PermissionAskCard(props: { acp: AcpStore; permission: PendingPermission; now: number }) {
  const { acp, permission, now } = props
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  // A question is not an approval: same wire method, different meaning. Its
  // text IS the ask, its options are answers, and its expiry is its own axis.
  const question = permission.askKind === 'question'
  const title = question ? (permission.reason ?? permission.toolName) : permission.toolName
  // A question's deadline comes from the form-question window, not the approval
  // mode, so the badge must not hide behind `wait` (an approval in `wait` mode
  // carries no deadline at all, which is why that check exists).
  const badgeMode = question ? 'auto' : permission.timeoutMode
  const expiry = questionExpiryLabel(acp, permission)
  const respond = (optionId?: string): void => {
    if (busy) return
    setBusy(true)
    setError(undefined)
    void acp.respondPermission(permission.requestId, optionId)
      // `respondPermission` reports to the store's notice too, but that notice
      // lives on the settings page; this card pins the failure where the user
      // is looking.
      .catch((failure: unknown) => {
        setError(failure instanceof Error ? failure.message : String(failure))
      })
      .finally(() => { setBusy(false) })
  }
  return (
    <div className={`ntr-permission-card${question ? ' is-question' : ''}`}>
      <div className="ntr-permission-head">
        <span className="ntr-permission-tool">{title}</span>
        {!question && permission.reason !== undefined && (
          <span className="ntr-permission-reason" title={permission.reason}>{permission.reason}</span>
        )}
        <DeadlineBadge acp={acp} deadlineAt={permission.deadlineAt} now={now} mode={badgeMode} />
      </div>
      <div className={`ntr-permission-actions${question ? ' is-question' : ''}`}>
        {permission.options.map(option => (
          <button
            key={option.optionId}
            type="button"
            className="ntr-permission-option"
            disabled={busy}
            title={option.warning === undefined ? option.name : `${option.name}\n${option.warning}`}
            onClick={() => { respond(option.optionId) }}
          >
            {option.name}
          </button>
        ))}
        <button
          type="button"
          className="ntr-permission-cancel"
          disabled={busy}
          title={question
            ? acp.label('取消这次提问（不选择任何选项）', 'Cancel this question without choosing an option')
            : acp.label('取消这次询问（不选择任何选项）', 'Cancel this ask without choosing an option')}
          onClick={() => { respond() }}
        >
          {acp.label('取消', 'Cancel')}
        </button>
      </div>
      <PermissionOptionWarnings options={permission.options} />
      {expiry !== undefined && (
        <div className="ntr-permission-expiry">{expiry}</div>
      )}
      {error !== undefined && (
        <div className="ntr-permission-error" role="alert">{error}</div>
      )}
    </div>
  )
}
