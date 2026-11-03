/**
 * The save gate's global toast and page-top banners (`shell.overlay`).
 *
 * A profile write can be held while an ACP turn is in flight. The host
 * settings page owns the write and its own promise; this plugin cannot render
 * inside that page, so the visible explanation lives here: it states that the
 * setting is held, names the exact wait, and offers the explicit force
 * gesture.
 *
 * Terminal results are banners, not log lines: save failures, expiry, a
 * refused save, a partly completed force flush and the HMR reload delay all
 * show here. Failures persist until the user closes them (the "retry" and
 * "force" gestures re-run the retained write); a success line disappears on
 * its own after 2.5 seconds. The same reason replaces its previous row
 * instead of stacking, and closing one does not suppress the next occurrence.
 */

import { useEffect, useState } from 'react'
import { ensureAcpStyle, useUi } from './acp-ui.tsx'
import { saveGateInterruptTargets } from './store.ts'
import type { AcpStore, SaveBanner } from './store.ts'
import type { SaveGateStatus } from '../protocol.ts'

export interface SaveGuardToastProps {
  /** Injected face: the shared browser store. */
  acp: AcpStore
}

/**
 * Which held/terminal toast (if any) the legacy gate snapshot calls for.
 * Terminal failure rows are rendered from the store's banners; this helper is
 * kept for the held state and for older callers/tests. `cancelled` is silent:
 * a newer save or a delete superseded it, and the settings form explains that
 * on its own.
 */
export function saveGuardToastKind(
  status: SaveGateStatus,
  dismissedAt?: number,
): 'pending' | 'expired' | 'failed' | undefined {
  if (status.pending.length > 0) return 'pending'
  const outcome = status.lastOutcome
  if (outcome === undefined || outcome.status === 'saved' || outcome.status === 'cancelled') return undefined
  if (outcome.at === dismissedAt) return undefined
  return outcome.status
}

function bannerActionLabel(acp: AcpStore, action: SaveBanner['actions'][number]): string {
  if (action === 'retry') return acp.label('重试', 'Retry')
  if (action === 'force') return acp.label('强制保存', 'Save now')
  return acp.label('知道了', 'Dismiss')
}

export function SaveGuardToast({ acp }: SaveGuardToastProps) {
  ensureAcpStyle()
  const ui = useUi(acp)
  const status = ui.saveGate
  const pending = status.pending
  const [busy, setBusy] = useState(false)
  const [confirmAll, setConfirmAll] = useState(false)
  const [showAllFailures, setShowAllFailures] = useState(false)

  // "Save everything" is an explicit, all-or-nothing gesture. One held write is
  // never flushed through the global path: that single agent's save belongs to
  // its own settings card. Two or more held rows are what this entry is for.
  const heldLabelCount = new Set(pending.map(entry => entry.label)).size
  const showFlushAll = pending.length >= 2 || heldLabelCount >= 2
  const interruptTargets = saveGateInterruptTargets(status, ui.agents, ui.detectedAgents, ui.sessions)
  useEffect(() => {
    if (!showFlushAll) setConfirmAll(false)
  }, [showFlushAll])

  // Success banners are the only auto-dismissing rows; failures wait for the user.
  // The timer is bound to the row that scheduled it: a newer row with the same
  // key must survive when the old timer fires.
  const autoKeys = ui.saveBanners
    .filter(banner => banner.autoDismissMs !== undefined)
    .map(banner => `${banner.key}:${String(banner.at)}`)
    .join('|')
  useEffect(() => {
    const timers = ui.saveBanners
      .filter(banner => banner.autoDismissMs !== undefined)
      .map(banner => setTimeout(() => {
        acp.dismissBanner(banner.key, banner.at)
      }, banner.autoDismissMs))
    return () => { for (const timer of timers) clearTimeout(timer) }
  }, [autoKeys, acp])

  // Escape works wherever focus is, not only inside a banner. Inputs and
  // textareas keep their key: consuming Escape there would fight the host's
  // own editors, and a focused control is already a deliberate gesture.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      const target = event.target
      if (target instanceof HTMLElement) {
        if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) return
      }
      const banners = acp.getSnapshot().saveBanners
      const latest = banners.length === 0 ? undefined : banners[banners.length - 1]
      if (latest === undefined) return
      event.preventDefault()
      acp.dismissBanner(latest.key, latest.at)
    }
    document.addEventListener('keydown', onKeyDown)
    return () => { document.removeEventListener('keydown', onKeyDown) }
  }, [acp])

  const flushAll = (): void => {
    if (busy) return
    setBusy(true)
    void acp.forceSaveGate()
      .catch(() => { /* the store pushed a visible retry-failed row; pending stays */ })
      .finally(() => { setBusy(false); setConfirmAll(false) })
  }

  const runAction = (banner: SaveBanner, action: SaveBanner['actions'][number]): void => {
    if (action === 'dismiss') {
      acp.dismissBanner(banner.key)
      return
    }
    if (action === 'retry') {
      void acp.retryBanner(banner.key).catch(() => { /* the store reports its own banner */ })
      return
    }
    void acp.forceBanner(banner.key).catch(() => { /* the store reports its own banner */ })
  }

  const banners = ui.saveBanners
  if (pending.length === 0 && banners.length === 0) return null

  // Failure rows are never dropped by count. Six fit without covering the
  // page; the rest fold behind one explicit "more" control.
  const failures = banners.filter(banner => banner.level === 'error')
  const successes = banners.filter(banner => banner.level !== 'error')
  const visibleFailures = showAllFailures ? failures : failures.slice(-6)
  const hiddenFailures = failures.length - visibleFailures.length

  const bannerRow = (banner: SaveBanner) => {
    const error = banner.level === 'error'
    return (
      <div
        key={banner.key}
        className={`ntr-save-guard-toast${error ? ' is-error' : ''}`}
        style={{ pointerEvents: 'auto' }}
        role={error ? 'alert' : 'status'}
        aria-live={error ? 'assertive' : 'polite'}
        aria-label={banner.title}
      >
        <div className="ntr-save-guard-title">{banner.title}</div>
        <div className="ntr-save-guard-body">{banner.body}</div>
        <div className="ntr-save-guard-actions">
          {banner.actions.map(action => (
            <button
              key={action}
              type="button"
              className={`ntr-acp-more${action === 'dismiss' ? '' : ' is-primary'}`}
              onClick={() => { runAction(banner, action) }}
            >
              {bannerActionLabel(acp, action)}
            </button>
          ))}
        </div>
      </div>
    )
  }

  return (
    <div
      className="ntr-save-guard-stack"
      style={{
        position: 'fixed',
        top: 16,
        left: '50%',
        transform: 'translateX(-50%)',
        zIndex: 1001,
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        pointerEvents: 'none',
        maxWidth: 'min(420px, calc(100vw - 40px))',
        maxHeight: 'calc(100vh - 32px)',
        overflowY: 'auto',
      }}
    >
      {pending.length > 0 && (
        <div
          className="ntr-save-guard-toast"
          style={{ pointerEvents: 'auto' }}
          role="status"
          aria-live="polite"
          aria-label={acp.label('配置保存状态', 'Setting save status')}
        >
          <div className="ntr-save-guard-title">
            {acp.label(
              `配置已暂存${pending.length > 1 ? `（${String(pending.length)} 项）` : ''}`,
              `Setting held${pending.length > 1 ? ` (${String(pending.length)})` : ''}`,
            )}
          </div>
          <div className="ntr-save-guard-body">
            {acp.label(
              '本轮对话还在进行，配置已暂存，回合结束后自动保存。',
              'A turn is still running. The setting is held and will be saved when the turn ends.',
            )}
          </div>
          {showFlushAll && (confirmAll ? (
            <div
              className="ntr-save-guard-confirm"
              role="alertdialog"
              aria-label={acp.label('全部立即保存确认', 'Save all confirmation')}
            >
              <div className="ntr-save-guard-body">
                {acp.label(
                  '会写入全部暂存，并中断这些 Agent 正在进行的回合。',
                  'Every held setting will be written, and these agents’ running turns will be interrupted.',
                )}
              </div>
              <div className="ntr-save-guard-confirm-agents">
                {interruptTargets.length === 0
                  ? acp.label('当前没有正在进行的回合。', 'No turns are running right now.')
                  : interruptTargets
                      .map(target => acp.label(
                        `${target.name}（${String(target.sessions)} 个会话）`,
                        `${target.name} (${String(target.sessions)} session(s))`,
                      ))
                      .join(acp.label('、', ', '))}
              </div>
              <div className="ntr-save-guard-actions">
                <button
                  type="button"
                  className="ntr-acp-more"
                  disabled={busy}
                  onClick={() => { setConfirmAll(false) }}
                >
                  {acp.label('取消', 'Cancel')}
                </button>
                <button
                  type="button"
                  className="ntr-acp-more is-primary"
                  disabled={busy}
                  onClick={flushAll}
                >
                  {busy ? acp.label('正在保存…', 'Saving…') : acp.label('全部立即保存', 'Save all now')}
                </button>
              </div>
            </div>
          ) : (
            <div className="ntr-save-guard-actions">
              <button
                type="button"
                className="ntr-acp-more is-primary"
                disabled={busy}
                title={acp.label(
                  '写入全部暂存，并中断正在运行的回合',
                  'Write every held setting and interrupt the running turns',
                )}
                onClick={() => { setConfirmAll(true) }}
              >
                {acp.label('全部立即保存', 'Save all now')}
              </button>
            </div>
          ))}
        </div>
      )}
      {successes.map(bannerRow)}
      {/* Fold controls stay ABOVE the rows: a long expanded stack must not
          push its own "collapse" control out of the visible viewport. */}
      {hiddenFailures > 0 && (
        <button
          type="button"
          className="ntr-save-guard-fold"
          onClick={() => { setShowAllFailures(true) }}
        >
          {acp.label(`还有 ${String(hiddenFailures)} 条失败`, `${String(hiddenFailures)} more failure(s)`)}
        </button>
      )}
      {showAllFailures && failures.length > 6 && (
        <button
          type="button"
          className="ntr-save-guard-fold"
          onClick={() => { setShowAllFailures(false) }}
        >
          {acp.label('收起', 'Collapse')}
        </button>
      )}
      {visibleFailures.map(bannerRow)}
    </div>
  )
}
