/**
 * One agent's default chat mode, under the card's「高级」tab.
 *
 * This is a NEW-conversation default, not a pick: the conversation's recorded
 * mode always wins, and the value only fills the gap before a conversation has
 * chosen one. It is written through the lightweight `agent/set-default-mode`
 * RPC (in-place, strictly persisted, no process restart) so changing it is
 * never a reason to kill live turns.
 *
 * Candidates come from the models tab's already-loaded in-memory snapshot.
 * This control never pulls the cache and never probes: with no snapshot it
 * stays a raw mode-id input (a probe can start an agent process). A stored
 * value the catalog no longer lists is kept and marked; the runtime skips it
 * with one notice and the field is never rewritten.
 */
import { useEffect, useRef, useState } from 'react'
import { DEFAULT_MODE_MAX } from '../../protocol.ts'
import type { AcpStore } from '../store.ts'
import { useUi } from './shared.ts'

const WARN_FG = 'var(--dsw-alias-state-warn-primary, #b45309)'

export function AgentDefaultMode(props: { acp: AcpStore; agentId: string }) {
  const { acp, agentId } = props
  const ui = useUi(acp)
  const catalog = ui.modelCatalogs[agentId]?.catalog
  const catalogUnread = ui.modelCatalogs[agentId] === undefined
  const choices = catalog?.mode?.choices ?? []
  const current = catalog?.mode?.currentValue
  const currentChoice = choices.find(choice => choice.value === current)
  const value = ui.detectedAgents.find(info => info.id === agentId)?.currentConfig?.defaultMode ?? ''
  const stale = value !== '' && choices.length > 0 && !choices.some(choice => choice.value === value)
  const [draft, setDraft] = useState(value)
  const seen = useRef(value)

  useEffect(() => {
    // A value that lands from the host (this write, another tab, a reset)
    // replaces the draft; while the user is typing the host value is unchanged,
    // so this is a no-op.
    if (seen.current === value) return
    seen.current = value
    setDraft(value)
  }, [value])

  // Candidates are the already-loaded in-memory snapshot only. The models tab
  // owns the cache read (a hidden section must not pull one), and this control
  // must never start a probe. No snapshot yet = the raw mode-id input below.
  const write = (next: string | undefined): void => {
    const normalized = next?.trim() ?? ''
    if (normalized === value) return
    seen.current = normalized
    setDraft(normalized)
    void acp.setAgentDefaultMode(agentId, normalized === '' ? undefined : normalized)
  }

  const label = acp.label('默认模式（新对话）', 'Default Mode (new conversations)')
  const follow = current !== undefined && current !== ''
    ? acp.label(
      `跟随智能体（当前：${currentChoice?.name ?? current}）`,
      `Follow the agent (now: ${currentChoice?.name ?? current})`,
    )
    : acp.label('跟随智能体自身默认', "Follow the agent's own default")

  return (
    <div className="dwa-form-row">
      <div className="dwa-form-col">
        <label className="dwa-form-label">{label}</label>
        {choices.length > 0 ? (
          <select
            className="dwa-select"
            aria-label={label}
            value={value}
            onChange={event => write(event.target.value)}
          >
            <option value="">{follow}</option>
            {choices.map(choice => (
              <option key={choice.value} value={choice.value}>{choice.name === '' ? choice.value : choice.name}</option>
            ))}
            {stale && (
              <option value={value} style={{ color: WARN_FG }}>
                {acp.label(`${value}（已失效）`, `${value} (stale)`)}
              </option>
            )}
          </select>
        ) : (
          <input
            className="dwa-input dwa-input-mono"
            aria-label={label}
            value={draft}
            maxLength={DEFAULT_MODE_MAX}
            placeholder={follow}
            onChange={event => setDraft(event.target.value)}
            onBlur={() => write(draft)}
            onKeyDown={event => {
              if (event.key !== 'Enter') return
              event.preventDefault()
              write(draft)
            }}
          />
        )}
        <span className={stale ? 'dwa-error' : 'dwa-hint'}>
          {stale
            ? acp.label(
              '该模式已不在目录中；新对话会跳过它并使用智能体自身默认。',
              'The catalog no longer offers this mode; new conversations skip it and keep the agent\'s own default.',
            )
            : choices.length > 0
              ? acp.label(
                '留空 = 跟随智能体自身默认；只影响新对话的首轮，已有会话保留自己的选择。',
                "Blank = follow the agent's own default; only a new conversation's first turn, existing ones keep their pick.",
              )
              : catalogUnread
                ? acp.label(
                  '目录未读取，可直接填 mode id；留空 = 跟随智能体自身默认。',
                  "Catalog unread — type the mode id; blank follows the agent's own default.",
                )
                : acp.label(
                  '智能体没有发布模式清单，可直接填 mode id；留空 = 跟随智能体自身默认。',
                  "The agent publishes no mode list — type the mode id; blank follows the agent's own default.",
                )}
        </span>
      </div>
    </div>
  )
}
