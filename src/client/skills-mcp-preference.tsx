/**
 * The built-in `dsh-skills` MCP switches (settings page → 技能 / 智能体).
 *
 * TWO levels, one AND: the master switch is a deployment-wide kill-switch, and
 * the per-agent row only narrows it (docs/plan/dsh-skills-mcp.md §13.1). The
 * server they gate is read-only and identical for every agent, and every
 * session-creating call hands it over the same way.
 *
 * Copy discipline (AGENTS.md rule 33: one line per control): ONE shared object
 * — 「DSH 技能发现」, named once in the section title — and two switches that
 * say who they cover (「所有智能体」 / 「这个智能体」), so the pair reads as a
 * scope pair instead of two look-alike sentences. The AND is drawn, not
 * assumed: while the master is on the row keeps a standing note (what it
 * gates, and how far one agent's off reaches); while it is off the note names
 * the gate instead.
 *
 * The tooltip carries the two facts that change a decision (lazy reads, new
 * conversations only). Both strings stay clear of "starts the process on first
 * call" / "stops the moment the switch flips" (docs/plan/dsh-skills-mcp.md
 * §7.2): the mechanism is described, never promised.
 */
import { Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { AcpStore, UiState } from './store.ts'

/** The one-line card copy: what the thing is, and that it is read-only. */
const EXPLANATION = [
  '智能体可以读取你装在 DSH 里的技能说明（只读）。',
  'Agents can read the skills installed in DSH (read-only).',
] as const

/** The info tooltip: what it reads, and when the switch takes effect. */
const DETAIL = [
  '技能说明只在智能体用到时读取，平时不扫描。开关只对新建或重新加载的对话生效；旧对话保持关闭前的状态。',
  'Skill content is read only when an agent asks for it; nothing is scanned up front. Applies to new or reloaded conversations; older ones keep the state they had.',
] as const

/** The master switch's label: the scope half of the pair. */
const MASTER_LABEL = [
  '对所有智能体开放',
  'Open to all agents',
] as const

/** The per-agent row's label: the other scope half. */
const AGENT_COPY = [
  '对这个智能体开放',
  'Open to this agent',
] as const

/**
 * Shown BESIDE the per-agent row while the master is on: what the row gates
 * (the built-in service, NOT the hand-written JSON list above it), and the
 * reach of one agent's opt-out. Without it the row sits under the MCP block
 * looking like a switch for one of those servers.
 */
const AGENT_NOTE = [
  '这一项控制「DSH 技能发现」提供的技能服务，与手填的 MCP 服务器无关。关闭只影响这个智能体，其他智能体仍可读取。',
  'The DSH Skill Discovery service is separate from the MCP servers you list above. Turning it off affects this agent only; the others can still read.',
] as const

/**
 * Shown BESIDE the greyed per-agent row: the AND, drawn as a sentence.
 *
 * It names the card and the page that holds it — the master is no longer on
 * this page, so "above" would point at nothing.
 */
const AGENT_MASTER_OFF = [
  '「技能」页的「DSH 技能发现」处于关闭状态，打开后这一项才生效。',
  'The DSH Skill Discovery switch on the Skills page is off; this option applies once it is on.',
] as const

/**
 * The master switch, as a titled card on the 「技能」 page (§13.2).
 *
 * It owns a page of its own: the agents page manages agents, and this is one
 * deployment-wide capability, not an agent. The per-agent rows narrow it from
 * inside each agent's card, and the gate sentence they carry names this page.
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
          <h3 className="dwa-section-title">{acp.label('DSH 技能发现', 'DSH Skill Discovery')}</h3>
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
          {acp.label(MASTER_LABEL[0], MASTER_LABEL[1])}
        </label>
        <Tooltip label={acp.label(DETAIL[0], DETAIL[1])} side="top">
          {/* A real button, so keyboard users can focus it; the host Tooltip
              clones this child and shows the label on focus / hover. */}
          <button
            type="button"
            className="dwa-info-btn"
            aria-label={acp.label('关于 DSH 技能发现', 'About DSH Skill Discovery')}
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
 * row is greyed and disabled, and the note names the gate instead of the scope.
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
      <span className="dwa-hint">
        {masterOn
          ? acp.label(AGENT_NOTE[0], AGENT_NOTE[1])
          : acp.label(AGENT_MASTER_OFF[0], AGENT_MASTER_OFF[1])}
      </span>
    </div>
  )
}
