/**
 * The settings page's permission surface: the cross-session ledger mirror (asks
 * whose conversation is not open, or which have no chat identity at all) and
 * the copy that names a failed connection test's cause.
 */
import type { AcpStore, UiState } from '../store.ts'
import type { Translate } from '../acp-view.tsx'
import { ElicitationAskCard } from '../elicitation-dock.tsx'
import { useDeadlineClock } from '../pending-dock.tsx'
import type { AgentTestResult } from '../../protocol.ts'

/**
 * The settings panel's permission-ledger rule.
 *
 * Pending asks are shown in the conversation card while that conversation is
 * open; this card is the cross-session mirror for the ones it cannot show —
 * asks belonging to another conversation, and `/acp` RPC-only asks with no
 * chat identity at all. It therefore appears whenever ANY ask is pending: a
 * pending entry with no conversation card would otherwise have no answer
 * surface anywhere.
 */
export function permissionLedgerCard(ui: Pick<UiState, 'permissions'> & Partial<Pick<UiState, 'elicitations'>>): { visible: boolean } {
  return { visible: ui.permissions.length > 0 || (ui.elicitations?.length ?? 0) > 0 }
}

/**
 * What the connection test's result block renders: the host's raw error, the
 * sentence naming the user's actual mistake, and the evidence behind it.
 */
export interface AgentTestOutcome {
  ok: boolean
  /** The host's own failure text (or the success line). */
  text: string
  /** One line naming what to fix; absent when the host gave no cause. */
  hint?: string
  /** The child's stderr tail — the evidence the hint is drawn from. */
  detail: string[]
}

/**
 * Name the fix for a failed connection test.
 *
 * Every spawn failure used to arrive as ONE sentence — the SDK rejects the
 * pending `initialize` with "ACP connection closed" whatever went wrong — so
 * the two mistakes a user actually makes (the agent is not installed / the
 * launch command is wrong) were indistinguishable. The host reports WHICH one
 * happened (`AgentTestResult.failure`); this decides the sentence, because the
 * copy belongs to the browser that owns the locale.
 *
 * A pure function on purpose: the settings bundle has no DOM test of its own,
 * and this decision is exactly what the single sentence got wrong.
 */
export function agentTestHint(result: AgentTestResult, t: Translate): string | undefined {
  const failure = result.failure
  if (failure === undefined) return undefined
  const name = result.command === undefined || result.command === ''
    ? t('这个命令', 'this command')
    : t(`「${result.command}」`, `"${result.command}"`)
  switch (failure) {
    case 'not-found':
      return result.installTried === true
        ? t(
          `已自动安装，PATH 中仍找不到${name}。确认包名与 bin 名一致。`,
          `The auto-install ran and ${name} is still not on PATH. Check the package and bin names.`,
        )
        : t(
          `PATH 中找不到${name}。安装该 agent，或在「高级」填 npm 包名自动安装。`,
          `${name} is not on PATH. Install the agent, or set its npm package under Advanced.`,
        )
    case 'install-failed':
      return t(
        `npm 自动安装失败，${name}未装上。错误在下面的输出里。`,
        `The npm auto-install failed, so ${name} is missing. npm's error is below.`,
      )
    case 'timeout':
      return t(
        `${name}已启动，但未在时限内完成 ACP 握手。确认它是 ACP agent，且参数完整。`,
        `${name} started but missed the ACP handshake deadline. Confirm it is an ACP agent and the arguments are complete.`,
      )
    case 'handshake-failed':
      return t(
        `与${name}的连接在 ACP 握手前断开。确认它是 ACP agent，且命令正确。`,
        `The connection to ${name} dropped before the ACP handshake. Confirm it is an ACP agent and the command is right.`,
      )
    case 'start-failed': {
      // The OS refused to run the file: a permission fix, not an argument fix.
      const code = result.spawnError?.code
      if (code === 'EACCES' || code === 'EPERM') {
        return t(
          `没有权限执行${name}。检查文件权限，或换一个可执行路径。`,
          `${name} is not executable by this user. Check the file permissions or use another path.`,
        )
      }
      const where = result.executablePath === undefined
        ? ''
        : t(`（${result.executablePath}）`, ` (${result.executablePath})`)
      if (result.exit === undefined) {
        return t(
          `${name}找到了${where}，但进程没能起来。检查启动命令与运行环境。`,
          `${name} was found${where}, but the process did not start. Check the command and the runtime.`,
        )
      }
      const died = result.exit.code !== null
        ? t(`但立刻退出（退出码 ${String(result.exit.code)}）`, `but exited at once (code ${String(result.exit.code)})`)
        : t('但立刻退出了', 'but exited at once')
      // An exit before the handshake can be a wrong argument list OR a refused
      // login, so the sentence names BOTH instead of blaming the command alone.
      return t(
        `${name}找到了${where}，${died}。先看下面的输出：可能是参数不全、鉴权失败或配置错误。`,
        `${name} was found${where} ${died}. Read the output below: the arguments may be incomplete, or auth/config failed.`,
      )
    }
    default:
      // A kind this bundle does not know (host newer than the browser half):
      // say nothing rather than invent a fix for the wrong failure.
      return undefined
  }
}

/**
 * The ledger card. Gated on `permissionLedgerCard` — the same rule the store
 * side reads — so it appears exactly while some ask has no answer surface
 * elsewhere.
 */
export function PermissionMirrorCard(props: { acp: AcpStore; ui: UiState }) {
  const { acp, ui } = props
  const now = useDeadlineClock(ui.elicitations.some(e => e.deadlineAt !== undefined))
  if (!permissionLedgerCard(ui).visible) return null
  return (
    <div className="dwa-card dwa-card-warn" style={{ marginBottom: 16 }}>
      <div style={{ fontWeight: 600, marginBottom: 4 }}>
        {acp.label('待处理权限与提问', 'Pending Permissions & Questions')}
      </div>
      <div className="dwa-hint" style={{ marginBottom: 8 }}>
        {acp.label(
          '对话打开时在那边的卡片上回答；这里兜底显示其他会话的询问。',
          'Answer in the conversation card while that conversation is open; this list covers the asks whose conversation is not.',
        )}
      </div>
      {ui.permissions.map(permission => (
        <div key={permission.requestId} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6, flexWrap: 'wrap' }}>
          <span style={{ flex: 1, minWidth: 160 }}>
            <span style={{ fontWeight: 600 }}>{permission.toolName}</span>
            {permission.reason !== undefined && (
              <span style={{ color: 'var(--ntr-muted)' }}> · {permission.reason}</span>
            )}
          </span>
          {permission.options.map(option => (
            <button
              key={option.optionId}
              type="button"
              className="dwa-btn"
              onClick={() => { void acp.respondPermission(permission.requestId, option.optionId).catch(() => undefined) }}
            >
              {option.name}
            </button>
          ))}
          <button type="button" className="dwa-btn dwa-btn-quiet" onClick={() => { void acp.respondPermission(permission.requestId).catch(() => undefined) }}>
            {acp.label('取消', 'Cancel')}
          </button>
        </div>
      ))}
      {ui.elicitations.map(elicitation => (
        <div key={elicitation.requestId} style={{ marginTop: 8 }}>
          <ElicitationAskCard acp={acp} elicitation={elicitation} now={now} />
        </div>
      ))}
    </div>
  )
}
