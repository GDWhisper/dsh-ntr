/**
 * The built-in `dsh-skills` MCP switches (settings page → 智能体).
 *
 * TWO levels, one AND: the master switch is a deployment-wide kill-switch, and
 * the per-agent row only narrows it (docs/plan/dsh-skills-mcp.md §13.1). The
 * server they gate is read-only and identical for every agent, and every
 * session-creating call hands it over the same way. The two facts a user needs
 * before flipping a switch live in the master card's info tooltip rather than
 * the row, because the settings page's copy budget is one line per control
 * (AGENTS.md rule 33).
 *
 * Both strings are fixed by docs/plan/dsh-skills-mcp.md §7.2: the tooltip must
 * NOT be rewritten into a promise that the process is lazily started or stops
 * the moment the switch flips.
 */
import { Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { AcpStore, UiState } from './store.ts'

/** The one-line card copy (fixed wording, see the plan). */
const EXPLANATION = [
  '让 agent 查阅你的 DSH 技能文档（只读）。',
  'Let agents read your DSH skill documents (read-only).',
] as const

/** The info tooltip: what it reads, and when the switch takes effect. */
const DETAIL = [
  '开启后，agent 可以查阅你的 DSH 技能文档：只读、不改文件，也不会获得 DSH 的其他能力。技能内容等 agent 用到时才读取，平时不扫描。开关只对新对话生效；旧对话里已在运行的辅助进程，不保证随关闭立刻退出。',
  'When on, agents can read your DSH skill documents: read-only, no file changes, and no other DSH abilities. Content is read only when an agent asks for it; nothing is scanned up front. The switch applies to new conversations; a helper process already running in an older one may not exit the moment you turn it off.',
] as const

/** The per-agent row's fixed copy (§13.2). */
const AGENT_COPY = [
  '向该 agent 提供 DSH 技能文档（只读）。',
  'Offer this agent the DSH skill documents (read-only).',
] as const

/** Shown BESIDE the greyed per-agent row: the AND, drawn as a sentence. */
const AGENT_MASTER_OFF = [
  '总开关已关闭，开启后此选项才生效。',
  'The master switch is off; this option takes effect once it is on.',
] as const

/**
 * The master switch, as a titled card above the agent list (§13.2).
 *
 * It sits directly above the roster it gates, so the order of the two levels
 * reads top-down: master first, per-agent rows inside each agent's card.
 */
export function SkillsMcpPreference(props: { acp: AcpStore; ui: UiState }) {
  const { acp, ui } = props
  // An UNREAD value is off, never "probably on": the host answers `false` by
  // default, and a switch the page cannot confirm must not claim it is open.
  const enabled = ui.skillsMcpEnabled === true
  return (
    <section className="dwa-section">
      <div className="dwa-section-heading">
        <div>
          <h3 className="dwa-section-title">{acp.label('技能 MCP', 'Skills MCP')}</h3>
          <p className="dwa-section-copy">{acp.label(EXPLANATION[0], EXPLANATION[1])}</p>
        </div>
      </div>
      <div className="dwa-card dwa-skills-card">
        <label className="dwa-switch">
          <input
            type="checkbox"
            checked={enabled}
            onChange={event => void acp.setSkillsMcpEnabled(event.target.checked)}
            style={{ margin: 0, accentColor: 'var(--dsw-alias-state-business-primary, #2563eb)' }}
          />
          {acp.label('DSH 技能', 'DSH skills')}
        </label>
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
    </section>
  )
}

/**
 * One agent's half of the same switch, sitting beside the MCP JSON block it
 * narrows (§13.2).
 *
 * It takes effect on the click — the value travels through the lightweight
 * `agent/set-skills-mcp` RPC, not through the form — so it is deliberately not
 * part of the save draft: nothing here is written by 「保存更改」, and a form
 * save can never write a stale value back.
 *
 * `enabled` is the host's resolved per-agent answer (`!== false`: the field is
 * only ever persisted as an explicit opt-out). With the master switch off the
 * row is greyed and disabled, with one sentence naming why.
 */
export function AgentSkillsMcpRow(props: {
  acp: AcpStore
  agentId: string
  /** The agent's own answer: offered unless it opted out. */
  enabled: boolean
  /** The deployment-wide kill-switch. */
  masterOn: boolean
}) {
  const { acp, agentId, enabled, masterOn } = props
  return (
    <div className="dwa-form-row" style={{ flexDirection: 'column', gap: 6 }}>
      <label className={`dwa-switch${masterOn ? '' : ' is-off'}`}>
        <input
          type="checkbox"
          checked={enabled}
          disabled={!masterOn}
          onChange={event => void acp.setAgentSkillsMcp(agentId, event.target.checked)}
          style={{ margin: 0, accentColor: 'var(--dsw-alias-state-business-primary, #2563eb)' }}
        />
        {acp.label(AGENT_COPY[0], AGENT_COPY[1])}
      </label>
      {!masterOn && <span className="dwa-hint">{acp.label(AGENT_MASTER_OFF[0], AGENT_MASTER_OFF[1])}</span>}
    </div>
  )
}
