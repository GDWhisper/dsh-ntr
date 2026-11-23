/**
 * Shared composer-dock shell, countdown clock hook, and deadline badge for
 * pending human-input cards (`PermissionDock` and `ElicitationDock`).
 */

import { useEffect, useState, type ReactNode } from 'react'
import type { PermissionTimeoutMode } from '../protocol.ts'
import {
  deadlineRemainingLabel,
  PERMISSION_DEADLINE_EXPIRED,
  type AcpStore,
} from './store.ts'

const COUNTDOWN_TICK_MS = 1000

/** Shared 1s clock driving countdown badges whenever at least one ask has a deadline. */
export function useDeadlineClock(active: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    setNow(Date.now())
    const timer = setInterval(() => { setNow(Date.now()) }, COUNTDOWN_TICK_MS)
    return () => { clearInterval(timer) }
  }, [active])
  return now
}

export function PendingDockShell(props: {
  className: string
  ariaLabel: string
  children: ReactNode
}) {
  return (
    <div
      className={`ntr-pending-dock ${props.className}`}
      role="region"
      aria-label={props.ariaLabel}
    >
      {props.children}
    </div>
  )
}

export function DeadlineBadge(props: {
  acp: AcpStore
  deadlineAt: number | undefined
  now: number
  mode: PermissionTimeoutMode
}) {
  const remaining = deadlineRemainingLabel(props.deadlineAt, props.now, props.mode)
  if (remaining === undefined) return null
  const expired = remaining === PERMISSION_DEADLINE_EXPIRED
  return (
    <span className={`ntr-permission-deadline${expired ? ' is-expired' : ''}`}>
      {expired
        ? props.acp.label('已超时', 'expired')
        : props.acp.label(`剩余 ${remaining}`, `${remaining} left`)}
    </span>
  )
}
