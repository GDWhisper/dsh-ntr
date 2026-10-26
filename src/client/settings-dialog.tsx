/**
 * The NTR settings dialog, opened from the agent base's empty-roster menu.
 *
 * WHY A DIALOG OF OUR OWN: the host settings shell owns its open state and
 * exposes no programmatic way in. The sidebar seat that receives `openSettings`
 * (`settings.launcher`) is a single-occupant slot already held by the account
 * menu, and `openSection` is only handed to `settings.onboarding` registrants —
 * so a conversation surface cannot drive the shell's modal. This dialog mounts
 * the SAME `AcpSettingsSection` the shell mounts, on the frame's overlay layer
 * (`shell.overlay`): one settings surface, two entrances, no duplicated
 * configuration logic.
 *
 * The trigger (composer model seat) and this dialog (root overlay) live in
 * unrelated slot trees, so the open state is the module-level store in
 * `acp-ui.tsx` (`openAcpSettingsDialog`).
 */

import { useEffect } from 'react'
import { AcpSettingsSection } from './panel.tsx'
import {
  closeAcpSettingsDialog,
  ensureAcpStyle,
  useAcpSettingsDialogOpen,
} from './acp-ui.tsx'
import type { AcpStore } from './store.ts'

/** The root overlay entry's inject face. */
export interface AcpSettingsDialogProps {
  acp: AcpStore
}

/** Frame-wide NTR settings surface; renders nothing while closed. */
export function AcpSettingsDialog(props: AcpSettingsDialogProps) {
  ensureAcpStyle()
  const { acp } = props
  const open = useAcpSettingsDialogOpen()
  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      closeAcpSettingsDialog()
    }
    document.addEventListener('keydown', onKey, true)
    return () => { document.removeEventListener('keydown', onKey, true) }
  }, [open])
  if (!open) return null
  const title = acp.label('NTR 设置', 'NTR settings')
  return (
    <div className="ntr-acp-dialog-layer">
      <div className="ntr-acp-dialog-mask" aria-hidden onClick={closeAcpSettingsDialog} />
      <div className="ntr-acp-dialog" role="dialog" aria-modal="true" aria-label={title}>
        <div className="ntr-acp-dialog-head">
          <span className="ntr-acp-dialog-title">{title}</span>
          <button
            type="button"
            className="ntr-acp-dialog-close"
            title={acp.label('关闭', 'Close')}
            aria-label={acp.label('关闭 NTR 设置', 'Close NTR settings')}
            autoFocus
            onClick={closeAcpSettingsDialog}
          >
            ✕
          </button>
        </div>
        <div className="ntr-acp-dialog-body">
          <AcpSettingsSection acp={acp} />
        </div>
      </div>
    </div>
  )
}
