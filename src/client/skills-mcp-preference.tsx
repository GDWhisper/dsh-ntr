/**
 * The built-in `dsh-skills` MCP switch (settings page → 智能体).
 *
 * ONE switch for the whole deployment, not per agent: the server it offers is
 * read-only and identical for every agent, and every session-creating call
 * hands it over the same way. The two facts a user needs before flipping it
 * live — what it reads, and when it takes effect — live in the info tooltip
 * rather than the row, because the settings page's copy budget is one line per
 * control (AGENTS.md rule 33).
 *
 * Both strings are fixed by docs/plan/dsh-skills-mcp.md §7.2: the tooltip must
 * NOT be rewritten into a promise that the process is lazily started or stops
 * the moment the switch flips.
 */
import { Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { AcpStore, UiState } from './store.ts'

/** The one-line row copy (fixed wording, see the plan). */
const EXPLANATION = [
  '让 agent 查阅你的 DSH 技能文档（只读）。',
  'Let agents read your DSH skill documents (read-only).',
] as const

/** The info tooltip: what it reads, and when the switch takes effect. */
const DETAIL = [
  '开启后，agent 可以查阅你的 DSH 技能文档：只读、不改文件，也不会获得 DSH 的其他能力。技能内容等 agent 用到时才读取，平时不扫描。开关只对新对话生效；旧对话里已在运行的辅助进程，不保证随关闭立刻退出。',
  'When on, agents can read your DSH skill documents: read-only, no file changes, and no other DSH abilities. Content is read only when an agent asks for it; nothing is scanned up front. The switch applies to new conversations; a helper process already running in an older one may not exit the moment you turn it off.',
] as const

export function SkillsMcpPreference(props: { acp: AcpStore; ui: UiState }) {
  const { acp, ui } = props
  // An UNREAD value is off, never "probably on": the host answers `false` by
  // default, and a switch the page cannot confirm must not claim it is open.
  const enabled = ui.skillsMcpEnabled === true
  return (
    <div className="dwa-inline-setting" style={{ marginTop: 12 }}>
      <label className="dwa-switch">
        <input
          type="checkbox"
          checked={enabled}
          onChange={event => void acp.setSkillsMcpEnabled(event.target.checked)}
          style={{ margin: 0, accentColor: 'var(--dsw-alias-state-business-primary, #2563eb)' }}
        />
        {acp.label('DSH 技能', 'DSH skills')}
      </label>
      <span className="dwa-setting-copy">{acp.label(EXPLANATION[0], EXPLANATION[1])}</span>
      <Tooltip label={acp.label(DETAIL[0], DETAIL[1])} side="top">
        {/* A real button, so keyboard users can focus it; the host Tooltip
            clones this child and shows the label on focus / hover. */}
        <button
          type="button"
          className="dwa-info-btn"
          aria-label={acp.label('关于 DSH 技能 MCP', 'About the DSH skills MCP')}
        >
          i
        </button>
      </Tooltip>
    </div>
  )
}
