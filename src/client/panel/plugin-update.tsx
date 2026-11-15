/**
 * The version badge's update companion and the in-page update card (badge copy,
 * the card's state copy, and the release-notes preview it embeds).
 */
import { ReleaseNotesSection } from '../release-notes.tsx'
import type { AcpStore } from '../store.ts'
import type { PluginUpdateState } from '../../protocol.ts'

/** The states that carry an update badge next to the version badge. */
function updateBadgeText(update: PluginUpdateState, acp: AcpStore): string | undefined {
  if (update.status === 'available') {
    return acp.label(`可更新 v${update.latest ?? update.current}`, `Update v${update.latest ?? update.current}`)
  }
  if (update.status === 'applying') return acp.label('更新中…', 'Updating…')
  if (update.status === 'applied') {
    const installed = update.installed ?? update.latest ?? update.current
    return acp.label(`已更新 v${installed}`, `Updated v${installed}`)
  }
  if (update.status === 'restart-required') {
    // Only a KNOWN disk version can be named. An interrupted install leaves
    // `installed` unset, and a badge would have to invent a version.
    if (update.installed === undefined) return undefined
    // Neutral: the disk version can be newer OR older than the running one.
    return acp.label(`待重启 v${update.installed}`, `Restart for v${update.installed}`)
  }
  return undefined
}

/**
 * The version badge's update companion. Every badge is a button, `applying`
 * included: the card is where the install's outcome is read, so the running
 * install must be able to open it too. States without anything to act on get
 * no badge at all — the version badge itself still opens the card.
 */
export function PluginUpdateBadge(props: { acp: AcpStore; update: PluginUpdateState; open: boolean; onToggle: () => void }) {
  const { acp, update, open, onToggle } = props
  const text = updateBadgeText(update, acp)
  if (text === undefined) return null
  return (
    <button
      type="button"
      className="dwa-badge dwa-badge-info dwa-update-badge"
      aria-expanded={open}
      aria-controls="ntr-plugin-update-card"
      onClick={onToggle}
    >
      {text}
    </button>
  )
}

/**
 * The update card. In-page, no dialog: the settings page already owns the one
 * action (install the exact version the host reported), and a modal on top of
 * a settings section would hide the version it is updating.
 *
 * The copy stays to one line per state (constraint 33); the host's raw error
 * (`message`) is the only long text, and it wraps on its own line so a stack
 * trace or a registry error is readable without stretching the card.
 */
export function PluginUpdateCard(props: { acp: AcpStore; update: PluginUpdateState; onClose: () => void }) {
  const { acp, update, onClose } = props
  const applying = update.status === 'applying'
  const latest = update.latest ?? update.current
  const onDisk = update.installed !== undefined && update.installed !== update.current
    ? update.installed
    : undefined
  const published = update.publishedAt !== undefined && !Number.isNaN(new Date(update.publishedAt).getTime())
    ? new Date(update.publishedAt).toLocaleDateString()
    : undefined
  const copy = update.status === 'available'
    ? acp.label('更新会卸载并重装插件，之后可能需要重启 DSH。', 'Updating uninstalls and reinstalls the plugin, and may require restarting DSH.')
    : update.status === 'applied'
      ? acp.label('已应用，刷新页面即可使用新版本。', 'Applied. Reload the page to use the new version.')
      : update.status === 'restart-required'
        ? update.installed !== undefined
          ? acp.label(
            `磁盘已是 v${update.installed}，重启 DSH 后生效（桌面 App 退出重开；命令行重启 dsh web）。`,
            `On disk v${update.installed}. Restart DSH to apply (quit and reopen the app, or restart dsh web).`,
          )
          : acp.label(
            '更新可能已完成，请刷新页面确认当前版本。',
            'The update may already be complete. Refresh the page to confirm the current version.',
          )
        : update.status === 'busy'
          ? acp.label('有进行中的对话，结束后才能更新。', 'Finish the running conversation before updating.')
          : update.status === 'failed'
            ? acp.label('更新失败。', 'Update failed.')
            : update.status === 'current'
              ? acp.label('已是最新版本。', 'Up to date.')
              : update.status === 'source-install'
                ? acp.label(
                  '源码或本地安装，无法通过 registry 更新。',
                  'Source or local install; update it through its own checkout.',
                )
                : update.status === 'managed'
                  ? acp.label('此安装由宿主管理，不能在这里更新。', 'This install is managed by the host and cannot be updated here.')
                  : undefined
  const showMessage = (update.status === 'failed' || update.status === 'busy' || update.status === 'managed')
    && update.message !== undefined
  const apply = async (): Promise<void> => {
    if (update.latest === undefined) return
    try {
      await acp.applyPluginUpdate(update.latest)
    } catch {
      // The store keeps the "disk may have changed" state and writes its own notice.
    }
  }
  return (
    <div
      id="ntr-plugin-update-card"
      className="dwa-card dwa-update-card"
      role="group"
      aria-label={acp.label('插件更新', 'Plugin update')}
    >
      <div className="dwa-update-summary">
        <span>{acp.label(`当前 v${update.current}`, `Current v${update.current}`)}</span>
        {onDisk !== undefined && <span className="dwa-hint">{acp.label(`磁盘 v${onDisk}`, `On disk v${onDisk}`)}</span>}
        {update.latest !== undefined && (
          <>
            <span aria-hidden="true">→</span>
            <span>{acp.label(`最新 v${latest}`, `Latest v${latest}`)}</span>
            {published !== undefined && <span className="dwa-hint">{published}</span>}
          </>
        )}
      </div>
      {copy !== undefined && <p className="dwa-update-copy">{copy}</p>}
      {showMessage && <div className="dwa-update-message">{update.message}</div>}
      {/* What the offered version SAYS, before the buttons that act on it. */}
      <ReleaseNotesSection acp={acp} update={update} />
      <div className="dwa-row-actions dwa-update-actions">
        {update.status === 'available' && (
          <button type="button" className="dwa-btn dwa-btn-primary" onClick={() => { void apply() }}>
            {acp.label('更新', 'Update')}
          </button>
        )}
        {applying && (
          <button type="button" className="dwa-btn dwa-btn-primary" disabled>
            {acp.label('正在更新…', 'Updating…')}
          </button>
        )}
        {update.status !== 'applying' && (
          <button type="button" className="dwa-btn" onClick={onClose}>{acp.label('关闭', 'Close')}</button>
        )}
        <button type="button" className="dwa-btn dwa-btn-quiet" disabled={applying} onClick={() => void acp.checkPluginUpdate(true)}>
          {acp.label('重新检查', 'Check again')}
        </button>
      </div>
    </div>
  )
}

/**
 * The card is drawn for every state a host can report about this install,
 * except the two where there is no install to talk about at all.
 */
export function updateCardVisible(update: PluginUpdateState | undefined, open: boolean): boolean {
  if (update === undefined || !open) return false
  return update.status !== 'unsupported' && update.status !== 'not-installed'
}
