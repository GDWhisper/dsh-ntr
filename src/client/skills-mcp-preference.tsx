/**
 * The built-in `dsh-skills` MCP switches (settings page → 技能).
 *
 * TWO levels, one AND: the master switch is a deployment-wide kill-switch, and
 * the per-agent rows under it only narrow it (docs/plan/dsh-skills-mcp.md §13.1).
 * The server they gate is read-only and identical for every agent, and every
 * session-creating call hands it over the same way.
 *
 * BOTH levels live on the 技能 page, and only there: the 智能体 page manages
 * agents, and an agent's card no longer carries this switch (the user asked for
 * one place to manage it). The rows therefore sit directly under the master
 * card, always read next to the gate they are narrowed by.
 *
 * A row is never greyed and never disabled: the per-agent answer is a plain
 * setting, and the host resolves it (`!== false`) whatever the master says. To
 * keep the AND legible without a standing sentence (constraint 33: one line per
 * control), a row pops ONE red warning the moment the user touches it while the
 * master is already off, and forgets it as soon as the master comes back on — so
 * flipping the master never warns on its own, in either direction. The warning
 * holds a fixed-width slot and hides with `visibility`, so appearing must not
 * reflow the list, and while hidden it stays out of the tab order and the
 * accessibility tree.
 *
 * The tooltip carries the two facts that change a decision (lazy reads, new
 * conversations only). Both strings stay clear of "starts the process on first
 * call" / "stops the moment the switch flips" (docs/plan/dsh-skills-mcp.md
 * §7.2): the mechanism is described, never promised.
 */
import { useEffect, useId, useState } from 'react'
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
 * The warning a row pops when the user touches it while the master is off.
 *
 * One sentence, same role the old standing note had: it says the AND, without
 * living on the row all the time. It names the switch, not a page — the rows
 * now sit under it, so "above" would be redundant.
 */
const MASTER_OFF_WARNING = [
  '总开关目前处于关闭状态，开启后生效。',
  'The master switch is off; this takes effect once you turn it on.',
] as const

/**
 * The master switch, as a titled card on the 「技能」 page (§13.2), with the
 * per-agent opt-outs listed under it.
 *
 * It owns a page of its own: the agents page manages agents, and this is one
 * deployment-wide capability, not an agent. The rows narrow it from below, so
 * the list is the card's own continuation — no heading, no add entry, no empty
 * state (an empty roster is the 智能体 page's business, not this page's).
 */
export function SkillsMcpPreference(props: {
  acp: AcpStore
  ui: UiState
  /** Already-added agents, in the order the 智能体 page lists them. */
  agents: readonly { id: string; name: string; enabled: boolean }[]
}) {
  const { acp, ui, agents } = props
  // An UNREAD value is off, never "probably on": the host answers `false` by
  // default, and a switch the page cannot confirm must not claim it is open.
  const masterOn = ui.skillsMcpEnabled === true
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
            checked={masterOn}
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
      {agents.length > 0 && (
        <div className="dwa-skills-agents">
          {agents.map(agent => (
            <AgentSkillsMcpRow
              key={agent.id}
              acp={acp}
              agentId={agent.id}
              name={agent.name}
              enabled={agent.enabled}
              masterOn={masterOn}
            />
          ))}
        </div>
      )}
    </section>
  )
}

/**
 * One agent's half of the same switch, under the master card it narrows.
 *
 * It takes effect on the click — the value travels through the lightweight
 * `agent/set-skills-mcp` RPC, not through the form — so it is deliberately not
 * part of any save draft: nothing here is written by 「保存更改」, and a form
 * save can never write a stale value back. Optimism and rollback belong to the
 * store; this component only reports the click.
 *
 * `enabled` is the host's resolved per-agent answer (`!== false`: the field is
 * only ever persisted as an explicit opt-out). The checkbox stays clickable
 * with the master off; the warning is what draws the AND, and only ever in
 * response to a click on THIS row made while the master is already off.
 */
export function AgentSkillsMcpRow(props: {
  acp: AcpStore
  agentId: string
  /** The agent's name, as the 智能体 page spells it. */
  name: string
  /** The agent's own answer: offered unless it opted out. */
  enabled: boolean
  /** The deployment-wide kill-switch. */
  masterOn: boolean
}) {
  const { acp, agentId, name, enabled, masterOn } = props
  // The row's name and its switch label together are the input's accessible
  // name: a bare list has no surrounding agent card to say which agent a row
  // belongs to, so every checkbox would otherwise read 「对这个智能体开放」.
  const nameId = useId()
  const copyId = useId()
  // One pop per row, and only ever armed by a click the master was ALREADY off
  // for. A click made while the master is on is an ordinary setting change, so
  // it must not arm anything — otherwise flipping the master off would warn on
  // its own. The effect then forgets the pop the moment the master comes back
  // on, so a later flip off starts silent too.
  const [touched, setTouched] = useState(false)
  useEffect(() => {
    if (masterOn) setTouched(false)
  }, [masterOn])
  const warning = touched && !masterOn
  const warningText = acp.label(MASTER_OFF_WARNING[0], MASTER_OFF_WARNING[1])
  return (
    <div className="dwa-preference-row">
      <span className="dwa-preference-label" id={nameId}>{name}</span>
      <span className="dwa-skills-row-control">
        <label className="dwa-switch">
          <input
            type="checkbox"
            checked={enabled}
            aria-labelledby={`${nameId} ${copyId}`}
            onChange={event => {
              if (!masterOn) setTouched(true)
              void acp.setAgentSkillsMcp(agentId, event.target.checked)
            }}
            style={{ margin: 0, accentColor: 'var(--dsw-alias-state-business-primary, #2563eb)' }}
          />
          <span id={copyId}>{acp.label(AGENT_COPY[0], AGENT_COPY[1])}</span>
        </label>
        {/* Always mounted: the slot keeps its width so the row never reflows,
            and `visibility` (not `display`) keeps it out of the tab order and
            the accessibility tree until it warns. A real button, so the host
            Tooltip is reachable by keyboard when it does. */}
        <Tooltip label={warningText} side="top">
          <button
            type="button"
            className="dwa-skills-warn"
            style={{ visibility: warning ? 'visible' : 'hidden' }}
            aria-label={warningText}
          >
            !
          </button>
        </Tooltip>
      </span>
    </div>
  )
}
