/**
 * The delegation-defaults section of the subagent card (T3). It edits ONLY the
 * `acp_delegate` tool's four-axis defaults — which agent a delegation lands on
 * when the caller names none, and per-agent model / thought-level / mode
 * defaults. It never touches the chat plane's own selections.
 *
 * Value chain per axis: explicit tool argument > this section's persisted
 * default > the agent process's own default. The view the host reports is the
 * authority; every write goes through `acp.setDelegateSettings` (immediate RPC,
 * optimistic + authoritative, revert-on-failure handled by the store).
 *
 * Stale marking is derived HERE against the catalog / roster — the host sends
 * no stale flag. A persisted value the catalog no longer offers is kept and
 * shown as a warning-colored「X（已失效）」option, never auto-cleared; a
 * default agent that left the roster is kept as「X（已删除）」. When the
 * catalog is simply unread there is no evidence of staleness, so the value is
 * kept as a plain option and a「获取目录」gesture offers to populate it.
 *
 * Catalog reads are the existing memory-only `loadCachedModels` (never spawns);
 * the only spawn is the explicit「获取目录」button (`probeModels`). Reads are
 * gated on the section being visible so a hidden page does not pull catalogs.
 *
 * Colors follow constraint 34 through host alias tokens; literals sit only in
 * var() fallbacks. Copy is one line per control (constraint 33); override facts
 * hang on the row they override and a reset appears only on a real override.
 */
import { useEffect, useRef } from 'react'
import type { AcpAgentCatalog, AcpCatalogChoice, AcpCatalogOption, AcpDelegateAgentDefaults, AcpDelegateSettings } from '../../protocol.ts'
import type { AcpStore, UiState } from '../store.ts'

/** Warn foreground for a kept-but-stale / deleted option (constraint 34). */
const WARN_FG = 'var(--dsw-alias-state-warn-primary, #b45309)'

/**
 * The thought-level option ONE model publishes, mirroring the host's
 * `CatalogService.modelReasoning` read rule on the cached `AcpAgentCatalog`:
 * `undefined` = never observed (no evidence), `null` = observed WITHOUT the
 * axis, an option = that model's own levels. With no model picked the catalog's
 * current model is the one described. Another model's levels are never borrowed.
 */
export function thoughtOptionForModel(
  catalog: AcpAgentCatalog | undefined,
  modelValue: string | undefined,
): AcpCatalogOption | null | undefined {
  if (catalog === undefined) return undefined
  const observed = modelValue !== undefined && modelValue !== ''
    ? modelValue
    : catalog.model?.currentValue ?? undefined
  if (observed === undefined) return catalog.thought ?? undefined
  const recorded = catalog.thoughtByModel
  if (recorded !== undefined && Object.prototype.hasOwnProperty.call(recorded, observed)) {
    return recorded[observed] ?? null
  }
  // A catalog written before the per-model map existed: its agent-level slot
  // describes the model it names, so that one model keeps its answer.
  if (catalog.model?.currentValue === observed) return catalog.thought ?? undefined
  return undefined
}

/**
 * The known choices for one axis. `undefined` = the catalog is UNREAD (no
 * staleness evidence: the kept value stays plain and the row offers「获取目录」);
 * `[]` = the catalog WAS read but the axis is absent, so a kept value is stale
 * (the runtime refuses an explicit model/mode and degrades a level with a note).
 * The effort axis distinguishes the same two states through the per-model
 * observation: `null` (observed without the axis) maps to `[]` here, while an
 * unobserved model stays `undefined` — no evidence, exactly like the host read.
 */
export function axisChoices(
  catalog: AcpAgentCatalog | undefined,
  axis: 'model' | 'effort' | 'mode',
  modelValue: string | undefined,
): AcpCatalogChoice[] | undefined {
  if (axis === 'effort') {
    const thought = thoughtOptionForModel(catalog, modelValue)
    if (thought === undefined) return undefined
    return thought === null ? [] : thought.choices
  }
  if (catalog === undefined) return undefined
  const slot = axis === 'model' ? catalog.model : catalog.mode
  return slot?.choices ?? []
}

/** A persisted value is stale only when a KNOWN list excludes it. */
export function isStaleValue(value: string | undefined, choices: AcpCatalogChoice[] | undefined): boolean {
  if (value === undefined || choices === undefined) return false
  return !choices.some(choice => choice.value === value)
}

/** Canonical equality of two per-agent entries (absent axis = follow default). */
export function delegateEntriesEqual(
  a: AcpDelegateAgentDefaults | undefined,
  b: AcpDelegateAgentDefaults | undefined,
): boolean {
  return (a?.model ?? undefined) === (b?.model ?? undefined)
    && (a?.effort ?? undefined) === (b?.effort ?? undefined)
    && (a?.mode ?? undefined) === (b?.mode ?? undefined)
}

/** The「当前：X」fact the default option names; undefined when nothing is set. */
export function resolvedDefaultAgent(delegate: AcpDelegateSettings): string | undefined {
  return delegate.resolvedDefaultAgent ?? delegate.globalDefaultAgent
}

/** One axis dropdown: 「默认」 + known choices + the kept persisted value. */
function AxisSelect(props: {
  acp: AcpStore
  title: string
  axis: 'model' | 'effort' | 'mode'
  value: string | undefined
  choices: AcpCatalogChoice[] | undefined
  onChange: (value: string | undefined) => void
}) {
  const { acp, title, axis, value, choices, onChange } = props
  const axisName = axis === 'model' ? acp.label('模型', 'Model')
    : axis === 'effort' ? acp.label('思考等级', 'Thought level')
      : acp.label('模式', 'Mode')
  const stale = isStaleValue(value, choices)
  // A persisted value the known list omits stays selectable; an unread catalog
  // keeps it plain (no staleness evidence yet).
  const kept = value !== undefined && !(choices ?? []).some(choice => choice.value === value)
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: '1 1 150px', minWidth: 150 }}>
      <span className="dwa-form-label">{axisName}</span>
      <select
        className="dwa-select"
        aria-label={`${axisName} · ${title}`}
        value={value ?? ''}
        onChange={event => onChange(event.target.value === '' ? undefined : event.target.value)}
      >
        <option value="">{acp.label('默认', 'Default')}</option>
        {(choices ?? []).map(choice => (
          <option key={choice.value} value={choice.value}>{choice.name}</option>
        ))}
        {kept && (
          <option value={value} style={stale ? { color: WARN_FG } : undefined}>
            {stale ? acp.label(`${value}（已失效）`, `${value} (stale)`) : value}
          </option>
        )}
      </select>
    </label>
  )
}

/** One configured agent's row of three axis defaults. */
function AgentDefaultsRow(props: { acp: AcpStore; ui: UiState; delegate: AcpDelegateSettings; agentId: string; title: string }) {
  const { acp, ui, delegate, agentId, title } = props
  const catalog = ui.modelCatalogs[agentId]?.catalog
  const entry = delegate.agentDefaults?.[agentId]
  const configuredEntry = delegate.configured?.agentDefaults?.[agentId]
  const probing = ui.probingModels[agentId] === true
  const probeError = ui.probeErrors[agentId]
  const catalogMissing = ui.modelCatalogs[agentId] === undefined

  // Write one axis by replacing the whole entry (the ui/delegate-set contract):
  // keep the other axes as they are, set or drop this one. A no-op writes nothing.
  const writeAxis = (axis: 'model' | 'effort' | 'mode', value: string | undefined): void => {
    const next: AcpDelegateAgentDefaults = { ...entry }
    if (value === undefined) delete next[axis]
    else next[axis] = value
    if (delegateEntriesEqual(next, entry)) return
    void acp.setDelegateSettings({ agentDefaults: { [agentId]: next } })
  }

  // Override fact + reset only when the config file names an entry that the
  // running value outranks (constraint 33). Reset deletes the override entry.
  const overridden = configuredEntry !== undefined && !delegateEntriesEqual(configuredEntry, entry)
  const configuredText = configuredEntry === undefined ? '' : [
    configuredEntry.model === undefined ? undefined : acp.label(`模型 ${configuredEntry.model}`, `model ${configuredEntry.model}`),
    configuredEntry.effort === undefined ? undefined : acp.label(`等级 ${configuredEntry.effort}`, `effort ${configuredEntry.effort}`),
    configuredEntry.mode === undefined ? undefined : acp.label(`模式 ${configuredEntry.mode}`, `mode ${configuredEntry.mode}`),
  ].filter(part => part !== undefined).join(' · ')

  return (
    <div className="dwa-preference-block">
      <div className="dwa-preference-label">{title}</div>
      <div className="dwa-preference-copy">
        {acp.label('委派该智能体时的默认选择；「默认」跟随智能体进程自身。', 'Defaults when delegating to this agent; "Default" follows the agent process itself.')}
      </div>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginTop: 8 }}>
        <AxisSelect acp={acp} title={title} axis="model" value={entry?.model} choices={axisChoices(catalog, 'model', entry?.model)} onChange={value => writeAxis('model', value)} />
        <AxisSelect acp={acp} title={title} axis="effort" value={entry?.effort} choices={axisChoices(catalog, 'effort', entry?.model)} onChange={value => writeAxis('effort', value)} />
        <AxisSelect acp={acp} title={title} axis="mode" value={entry?.mode} choices={axisChoices(catalog, 'mode', entry?.model)} onChange={value => writeAxis('mode', value)} />
      </div>
      {entry?.model === undefined && (
        <div className="dwa-preference-copy">
          {acp.label('等级作用于运行时实际模型，不支持会自动丢弃。', 'The level applies to the runtime model; unsupported values are dropped.')}
        </div>
      )}
      {catalogMissing && (
        <div style={{ marginTop: 8, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <button type="button" className="dwa-btn dwa-btn-secondary" disabled={probing} onClick={() => void acp.probeModels(agentId)}>
            {probing ? acp.label('正在获取目录…', 'Fetching catalog…') : acp.label('获取目录', 'Fetch catalog')}
          </button>
          {probeError !== undefined && (
            <span className="dwa-error" style={{ wordBreak: 'break-word' }}>⚠ {probeError}</span>
          )}
        </div>
      )}
      {overridden && (
        <div className="dwa-deadline-flag">
          ⚠ {acp.label(`配置文件要求：${configuredText || '全部默认'}`, `The config file asks for: ${configuredText || 'all defaults'}.`)}
        </div>
      )}
      {overridden && (
        <div className="dwa-deadline-reset">
          <button type="button" className="dwa-btn dwa-btn-secondary" onClick={() => void acp.setDelegateSettings({ agentDefaults: { [agentId]: null } })}>
            {acp.label('恢复配置文件的值', 'Use config file value')}
          </button>
        </div>
      )}
    </div>
  )
}

/**
 * The delegation-defaults section: a default-agent picker plus one row per
 * configured agent. Mounted inside SubagentCard; returns nothing on a host half
 * that reports no delegate view (the card already gates, this is defensive).
 */
export function SubagentDefaults(props: { acp: AcpStore; ui: UiState }) {
  const { acp, ui } = props
  const delegate = ui.delegate
  const rootRef = useRef<HTMLDivElement | null>(null)
  const requested = useRef<Set<string>>(new Set())
  // Re-check visibility every render: the page wrapper toggles `hidden` without
  // remounting, and a hidden section must not pull catalogs (constraint 8).
  // `loadCachedModels` is memory-only and deduped, so the guard keeps it cheap.
  useEffect(() => {
    if (delegate === undefined) return
    if (rootRef.current === null || rootRef.current.closest('[hidden]') !== null) return
    for (const agent of ui.agents) {
      if (requested.current.has(agent.id)) continue
      requested.current.add(agent.id)
      void acp.loadCachedModels(agent.id)
    }
  })
  if (delegate === undefined) return null

  const roster = ui.agents
  const rosterIds = new Set(roster.map(agent => agent.id))
  const current = delegate.defaultAgent
  const deleted = current !== undefined && !rosterIds.has(current)
  const resolved = resolvedDefaultAgent(delegate)
  const defaultOptionLabel = resolved === undefined
    ? acp.label('默认（未设置）', 'Default (not set)')
    : acp.label(`默认（当前：${resolved}）`, `Default (now: ${resolved})`)
  const configuredDefault = delegate.configured?.defaultAgent
  const defaultOverridden = configuredDefault !== undefined && configuredDefault !== current

  return (
    <div ref={rootRef} style={{ marginTop: 20 }}>
      <div className="dwa-section-heading">
        <div>
          <h4 className="dwa-section-title">{acp.label('委派默认', 'Delegation defaults')}</h4>
          <p className="dwa-section-copy">
            {acp.label('只影响 acp_delegate 委派，不改变聊天中的选择。', 'Affects acp_delegate delegations only, never the chat selections.')}
          </p>
        </div>
      </div>
      <div className="dwa-preferences">
        <div className="dwa-preference-block">
          <div className="dwa-preference-label">{acp.label('默认智能体', 'Default agent')}</div>
          <div className="dwa-preference-copy">
            {acp.label('委派未指明智能体时使用；「默认」跟随「设为默认智能体」的选择。', 'Used when a delegation names no agent; "Default" follows "Set as default agent".')}
          </div>
          <div style={{ marginTop: 8, maxWidth: 360 }}>
            <select
              className="dwa-select"
              aria-label={acp.label('默认智能体', 'Default agent')}
              value={current ?? ''}
              onChange={event => {
                const value = event.target.value
                if (value === '') void acp.resetDelegateSetting('defaultAgent')
                else void acp.setDelegateSettings({ defaultAgent: value })
              }}
            >
              <option value="">{defaultOptionLabel}</option>
              {roster.map(agent => (
                <option key={agent.id} value={agent.id}>{agent.title}</option>
              ))}
              {deleted && (
                <option value={current} style={{ color: WARN_FG }}>
                  {acp.label(`${current}（已删除）`, `${current} (deleted)`)}
                </option>
              )}
            </select>
          </div>
          {defaultOverridden && (
            <div className="dwa-deadline-flag">
              ⚠ {acp.label(`配置文件要求：${configuredDefault}`, `The config file asks for ${configuredDefault}.`)}
            </div>
          )}
          {defaultOverridden && (
            <div className="dwa-deadline-reset">
              <button type="button" className="dwa-btn dwa-btn-secondary" onClick={() => void acp.resetDelegateSetting('defaultAgent')}>
                {acp.label('恢复配置文件的值', 'Use config file value')}
              </button>
            </div>
          )}
        </div>
        {roster.map(agent => (
          <AgentDefaultsRow key={agent.id} acp={acp} ui={ui} delegate={delegate} agentId={agent.id} title={agent.title} />
        ))}
      </div>
    </div>
  )
}