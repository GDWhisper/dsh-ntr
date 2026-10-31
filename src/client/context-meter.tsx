/**
 * Composer context-occupancy ring at `conversation.composer.dock` — the bottom
 * info row below the input card, where the host also renders its ContextMeter.
 *
 * WHY A PLUGIN-OWNED RING: the host's meter reads its `contextPressure`
 * projection, folded from DSH provider-usage samples plus a route capacity. An
 * ACP conversation produces neither — the agent owns the request and the host
 * never sees its prompt — so the native meter renders nothing there. This ring
 * reports the agent's OWN `usage_update` used/size instead: occupancy only. ACP
 * declares no system/tools/messages split, so no breakdown is invented.
 *
 * Registered for every conversation and gating itself: it renders only for an
 * ACP conversation whose session row carries usage. The row comes from
 * `session/chat-list`; the store live-patches it from the coalesced
 * `usage_update` frames (see `AcpStore.flushUpdates`).
 */

import { useEffect } from 'react'
// Type-only: pulls the ui-conversation SlotMap merge into this program.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { ensureAcpStyle, useUi } from './acp-ui.tsx'
import type { AcpSessionHook } from './acp-ui.tsx'
import type { AcpStore, UiState } from './store.ts'
import type { SessionView } from '../protocol.ts'

/** Props of the composer entry (injected face + the frame's standard kit). */
export interface AcpContextMeterProps {
  /** Injected face: the chat session id this entry belongs to. */
  sessionId: string
  /** Framework-bound conversation snapshot hook (`SessionStandardProps.useSession`). */
  useSession: AcpSessionHook
  acp: AcpStore
}

export interface ContextOccupancy {
  /** Rounded occupancy percentage, clamped to 0..100. */
  percent: number
  used: number
  size: number
}

/**
 * The sample this conversation's ring should show, or `undefined` when the
 * entry must render nothing. An explicit `acpMode === false` outranks a stale
 * `chatSessions` row: the conversation's preset left NTR while its ACP session
 * was still alive, and the ring must leave with it (same precedence as the
 * agent tag's `agentTagVisible`). While the verdict is unknown, a LIVE row is
 * proof; a PARKED one is not — it can outlive the preset switch, and the ring
 * must not appear on an ordinary conversation during the answer window.
 */
export function acpMeterUsage(
  ui: Pick<UiState, 'acpMode' | 'chatSessions' | 'chatSessionsFor'>,
  dshSessionId: string,
): SessionView['usage'] | undefined {
  if (ui.acpMode[dshSessionId] === false) return undefined
  if (ui.chatSessionsFor !== dshSessionId) return undefined
  const live = ui.chatSessions.find(row => !row.released)
  // A PARKED row alone is not proof this conversation is still in NTR mode:
  // switching off the preset leaves the ACP session record alive, and while the
  // host has not answered (`undefined`) the ring must not appear on an
  // ordinary conversation. A live row is proof; a parked one needs the
  // affirmative verdict.
  if (live === undefined && ui.acpMode[dshSessionId] !== true) return undefined
  return (live ?? ui.chatSessions[0])?.usage
}

/**
 * Bounded display occupancy from one agent sample. `undefined` (no meter) for
 * an absent / malformed / zero-capacity sample rather than a made-up 0%.
 */
export function contextOccupancy(usage: SessionView['usage'] | undefined): ContextOccupancy | undefined {
  if (usage === undefined) return undefined
  const { used, size } = usage
  if (!Number.isFinite(used) || !Number.isFinite(size) || used < 0 || size <= 0) return undefined
  return { percent: Math.min(100, Math.round(used / size * 100)), used, size }
}

/** Compact token count for the tooltip, in the host meter's K/M shape. */
export function compactTokenCount(value: number): string {
  if (value < 1e3) return String(Math.round(value))
  const thousands = value / 1e3
  if (value < 1e6) {
    return `${thousands >= 100 ? String(Math.round(thousands)) : String(Math.round(thousands * 10) / 10)}K`
  }
  const millions = value / 1e6
  return `${millions >= 100 ? String(Math.round(millions)) : String(Math.round(millions * 10) / 10)}M`
}

/** Ring geometry matches the host ContextMeter: 14px viewBox, 2px stroke. */
const RADIUS = 5.5
const CIRCUMFERENCE = 2 * Math.PI * RADIUS

export function AcpContextMeter({ acp, sessionId, useSession }: AcpContextMeterProps) {
  ensureAcpStyle()
  const ui = useUi(acp)
  const dshSessionId = String(sessionId)
  // A fresh conversation gets its ACP session binding during its first turn,
  // and no SSE frame announces that; the running flip is the re-read trigger
  // every composer entry shares.
  const running = useSession(snapshot => snapshot.running)
  useEffect(() => {
    void acp.loadChatSessions(dshSessionId)
  }, [acp, dshSessionId, running])

  const context = contextOccupancy(acpMeterUsage(ui, dshSessionId))
  if (context === undefined) return null

  const title = acp.label(
    `上下文已用 ${String(context.percent)}% · ${compactTokenCount(context.used)} / ${compactTokenCount(context.size)}`,
    `${String(context.percent)}% of context used · ${compactTokenCount(context.used)} / ${compactTokenCount(context.size)}`,
  )
  return (
    <span className="ntr-acp-meter" role="img" aria-label={title} title={title}>
      <svg viewBox="0 0 14 14" width="14" height="14" aria-hidden="true">
        <circle className="ntr-acp-meter-track" cx="7" cy="7" r={RADIUS} />
        <circle
          className="ntr-acp-meter-fill"
          cx="7"
          cy="7"
          r={RADIUS}
          strokeDasharray={`${String(CIRCUMFERENCE * context.percent / 100)} ${String(CIRCUMFERENCE)}`}
          transform="rotate(-90 7 7)"
        />
      </svg>
      <span className="ntr-acp-meter-percent">{context.percent}%</span>
    </span>
  )
}
