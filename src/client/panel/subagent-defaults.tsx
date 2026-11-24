/**
 * The delegation-defaults section of the subagent card (T3). It edits ONLY the
 * `acp_delegate` tool's per-agent profile — which agent a delegation lands on
 * when the caller names none, and per-agent model / thought-level / mode
 * defaults plus the free-text description the caller reads before choosing.
 * It never touches the chat plane's own selections.
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
 * Catalog reads are the memory-only `loadCachedModels` (never spawns). The only
 * spawn is the explicit「获取目录 / 刷新目录」button (`probeModels`): a probe can
 * start an agent process, so freshness is never bought by opening the page —
 * the row shows the snapshot's age next to that button and the user decides.
 * Reads are gated on the section being visible so a hidden page pulls nothing.
 *
 * Colors follow constraint 34 through host alias tokens; literals sit only in
 * var() fallbacks. Copy is one line per control (constraint 33); override facts
 * hang on the row they override and a reset appears only on a real override.
 */
import { useEffect, useRef, useState } from 'react'
import type { AcpAgentCatalog, AcpCatalogChoice, AcpCatalogOption, AcpDelegateAgentDefaults, AcpDelegateSettings } from '../../protocol.ts'
import { DELEGATE_DESCRIPTION_MAX } from '../../protocol.ts'
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

/**
 * The copy the「默认」option wraps a row in, plus the markers the unlisted and
 * stale rows append. Held once and reused by the width budget below, so a
 * wording change cannot silently break the cap.
 */
const OPTION_COPY = {
  defaultOpen: { zh: '默认（', en: 'Default (' },
  defaultClose: { zh: '）', en: ')' },
  unlisted: { zh: '，未在列表中', en: ', not listed' },
  stale: { zh: '（已失效）', en: ' (stale)' },
} as const

/** Columns one string occupies: East Asian wide and emoji code points take two. */
export function textColumns(text: string): number {
  let columns = 0
  for (const character of text) columns += wideCharacter(character) ? 2 : 1
  return columns
}

function wideCharacter(character: string): boolean {
  const code = character.codePointAt(0) ?? 0
  return (code >= 0x1100 && code <= 0x115f) // Hangul Jamo
    || (code >= 0x2e80 && code <= 0xa4cf) // CJK radicals … Yi
    || (code >= 0xac00 && code <= 0xd7a3) // Hangul syllables
    || (code >= 0xf900 && code <= 0xfaff) // CJK compatibility ideographs
    || (code >= 0xfe30 && code <= 0xfe4f) // CJK compatibility forms
    || (code >= 0xff00 && code <= 0xff60) // Fullwidth forms
    || (code >= 0xffe0 && code <= 0xffe6)
    || (code >= 0x1f300 && code <= 0x1faff) // Emoji
}

/**
 * The widest a RENDERED option may get, in text columns — the number a native
 * `<select>` popup sizes itself to (it has no CSS cap of any kind). One agent's
 * paragraph-long mode description pushed the list past the dialog (user
 * report, 2026-11-23). 56 columns stays inside the panel's own content width.
 *
 * The popup sizes to the WIDEST option, and the「默认」row carries decoration
 * around an ordinary row, so the row budget is what remains after that.
 */
export const CHOICE_OPTION_MAX = 56

/** Widest「默认」decoration across both locales, measured from the copy above. */
const DEFAULT_WRAPPER_COLUMNS = Math.max(
  textColumns(OPTION_COPY.defaultOpen.zh) + textColumns(OPTION_COPY.defaultClose.zh),
  textColumns(OPTION_COPY.defaultOpen.en) + textColumns(OPTION_COPY.defaultClose.en),
)
/** Widest unlisted marker across both locales. */
const UNLISTED_MARK_COLUMNS = Math.max(textColumns(OPTION_COPY.unlisted.zh), textColumns(OPTION_COPY.unlisted.en))
/** Widest stale marker across both locales. */
const STALE_MARK_COLUMNS = Math.max(textColumns(OPTION_COPY.stale.zh), textColumns(OPTION_COPY.stale.en))

/**
 * Widest row text: {@link CHOICE_OPTION_MAX} less the「默认」wrapper, so the
 * default row (and every marked row) stays inside the popup budget too.
 */
export const CHOICE_LABEL_MAX = CHOICE_OPTION_MAX - DEFAULT_WRAPPER_COLUMNS

/** Widest raw value the unlisted「默认」row may spell — marker and wrapper budgeted. */
const UNLISTED_VALUE_MAX = CHOICE_OPTION_MAX - DEFAULT_WRAPPER_COLUMNS - UNLISTED_MARK_COLUMNS

/** Widest raw value a stale kept row may spell — the stale marker budgeted. */
const STALE_VALUE_MAX = CHOICE_OPTION_MAX - STALE_MARK_COLUMNS

/**
 * Cut one label at `max` columns, preferring the last word that still fits —
 * the last space is used only when it leaves at least 14 columns of row, so
 * the tail is not thrown away for a two-word sliver. `…` marks the cut, cut
 * points stay on code-point boundaries, and rows that already fit come back
 * untouched ("name · description" rows and camelCase model names included).
 */
export function clipChoiceText(text: string, max: number = CHOICE_LABEL_MAX): string {
  if (textColumns(text) <= max) return text
  let columns = 0
  let end = 0
  for (const character of text) {
    const width = wideCharacter(character) ? 2 : 1
    // One column is reserved for the ellipsis.
    if (columns + width > max - 1) break
    columns += width
    end += character.length
  }
  let head = text.slice(0, end)
  const space = head.lastIndexOf(' ')
  if (space >= 0 && textColumns(head.slice(0, space)) >= max - 14) head = head.slice(0, space)
  return `${head.trimEnd()}…`
}

/**
 * The row text ONE catalog choice spells — the single source shared by the
 * axis dropdown's ordinary rows and the「默认」parentheses. The agent's own
 * description rides along (consumption multipliers live there), so same-name
 * variants stay distinguishable; no description → the bare name. The row is
 * capped at {@link CHOICE_LABEL_MAX} columns so a long description cannot
 * widen the native list (see {@link CHOICE_OPTION_MAX}'s note).
 */
export function choiceLabel(choice: AcpCatalogChoice): string {
  const row = choice.description === undefined ? choice.name : `${choice.name} · ${choice.description}`
  return clipChoiceText(row)
}

/**
 * The process-own default LABEL one axis's「默认」option spells out in
 * parentheses, read from the slot's `currentValue` — the same fact the whole
 * UI treats as the agent process's own current default. `undefined` = nothing
 * to name (unread catalog, missing / boolean slot, no current value), so the
 * option stays plain「默认」. The effort axis reads the SAME effective-model
 * slot as `axisChoices`. A hit spells the SAME `choiceLabel` text as that
 * choice's ordinary row (`listed: true`), so the parentheses match a row
 * verbatim. A value absent from `choices` — or a choice with an empty name —
 * falls back to the raw value with `listed: false` (the option marks it
 * 「未在列表中」, and the control's hover title explains why no description is
 * available); no alias mapping is ever guessed, and the raw fallback is capped
 * like every other row so one long id cannot widen the list either.
 */
export function resolvedAxisDefaultLabel(
  catalog: AcpAgentCatalog | undefined,
  axis: 'model' | 'effort' | 'mode',
  modelValue: string | undefined,
): { text: string; listed: boolean } | undefined {
  const slot = axis === 'effort'
    ? thoughtOptionForModel(catalog, modelValue)
    : axis === 'model' ? catalog?.model : catalog?.mode
  if (slot === undefined || slot === null || slot.kind === 'boolean') return undefined
  const value = slot.currentValue
  if (value === null || value === '') return undefined
  const choice = slot.choices.find(candidate => candidate.value === value)
  return choice !== undefined && choice.name !== ''
    ? { text: choiceLabel(choice), listed: true }
    // The marker's columns come out of the same option budget, so the「默认」
    // row cannot become the widest row and widen the popup after all.
    : { text: clipChoiceText(value, UNLISTED_VALUE_MAX), listed: false }
}

/** The「默认」option's text for one resolved process default, in the active locale. */
function defaultOptionText(acp: AcpStore, label: { text: string; listed: boolean }): string {
  const { defaultOpen, defaultClose, unlisted } = OPTION_COPY
  // Clamped HERE as well, not only by `resolvedAxisDefaultLabel`: the budget
  // belongs to the rendering point, so a future caller cannot widen the popup.
  const text = label.listed
    ? clipChoiceText(label.text, CHOICE_LABEL_MAX)
    : clipChoiceText(label.text, UNLISTED_VALUE_MAX)
  const middle = label.listed ? text : `${text}${unlisted.zh}`
  const middleEn = label.listed ? text : `${text}${unlisted.en}`
  return acp.label(`${defaultOpen.zh}${middle}${defaultClose.zh}`, `${defaultOpen.en}${middleEn}${defaultClose.en}`)
}

/** The kept-row text of a value the catalog no longer offers, in the active locale. */
function staleValueText(acp: AcpStore, text: string): string {
  const { stale } = OPTION_COPY
  return acp.label(`${text}${stale.zh}`, `${text}${stale.en}`)
}

/** Canonical equality of two per-agent entries (absent axis = follow default). */
export function delegateEntriesEqual(
  a: AcpDelegateAgentDefaults | undefined,
  b: AcpDelegateAgentDefaults | undefined,
): boolean {
  return (a?.model ?? undefined) === (b?.model ?? undefined)
    && (a?.effort ?? undefined) === (b?.effort ?? undefined)
    && (a?.mode ?? undefined) === (b?.mode ?? undefined)
    && (a?.description ?? undefined) === (b?.description ?? undefined)
}

/**
 * The caller-facing description input. Local draft + commit on blur: typing
 * must not fire one RPC per keystroke, while a value that lands from another
 * tab (or a config reset) replaces the draft through the value prop.
 */
function DescriptionInput(props: { acp: AcpStore; title: string; value: string | undefined; onCommit: (raw: string) => void }) {
  const { acp, title, value, onCommit } = props
  const committed = value ?? ''
  const [draft, setDraft] = useState(committed)
  const seen = useRef(committed)
  useEffect(() => {
    if (seen.current === committed) return
    seen.current = committed
    setDraft(committed)
  }, [committed])
  const label = acp.label('描述（写给主代理看）', 'Description (shown to the caller)')
  return (
    <label className="dwa-field" style={{ marginTop: 12 }}>
      <span className="dwa-field-label">{label}</span>
      <input
        className="dwa-input"
        aria-label={`${label} · ${title}`}
        maxLength={DELEGATE_DESCRIPTION_MAX}
        placeholder={acp.label('这个 agent 擅长什么，什么时候该用它', 'What this agent is good at, and when to use it')}
        value={draft}
        onChange={event => setDraft(event.target.value)}
        onBlur={() => onCommit(draft)}
      />
    </label>
  )
}

/** The「当前：X」fact the default option names; undefined when nothing is set. */
export function resolvedDefaultAgent(delegate: AcpDelegateSettings): string | undefined {
  return delegate.resolvedDefaultAgent ?? delegate.globalDefaultAgent
}

/**
 * How old the cached catalog is, in words — the fact that makes a stale value
 * self-explanatory without spending a probe. `undefined` when the snapshot was
 * never dated (an older host file).
 */
export function catalogAge(updatedAt: number | undefined, now: number = Date.now()): { zh: string; en: string } | undefined {
  if (updatedAt === undefined || updatedAt <= 0) return undefined
  const minutes = Math.floor(Math.max(0, now - updatedAt) / 60_000)
  if (minutes < 1) return { zh: '刚刚', en: 'a moment ago' }
  if (minutes < 60) return { zh: `${minutes} 分钟前`, en: `${minutes} min ago` }
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return { zh: `${hours} 小时前`, en: `${hours} h ago` }
  const days = Math.floor(hours / 24)
  return { zh: `${days} 天前`, en: `${days} d ago` }
}

/** One axis dropdown: 「默认」 + known choices + the kept persisted value. */
function AxisSelect(props: {
  acp: AcpStore
  title: string
  axis: 'model' | 'effort' | 'mode'
  value: string | undefined
  choices: AcpCatalogChoice[] | undefined
  /** Resolved process-own default label; undefined keeps the option plain「默认」. */
  defaultLabel?: { text: string; listed: boolean }
  onChange: (value: string | undefined) => void
}) {
  const { acp, title, axis, value, choices, defaultLabel, onChange } = props
  const axisName = axis === 'model' ? acp.label('模型', 'Model')
    : axis === 'effort' ? acp.label('思考等级', 'Thought level')
      : acp.label('模式', 'Mode')
  const stale = isStaleValue(value, choices)
  // A persisted value the known list omits stays selectable; an unread catalog
  // keeps it plain (no staleness evidence yet).
  const kept = value !== undefined && !(choices ?? []).some(choice => choice.value === value)
  // An agent can report a current value it never lists (CodeBuddy reports
  // `hy4free` while offering `hy4flash-free`), so there is no description for
  // it. The marker says that in plain words; the hover title explains why
  // without spending one of the row's copy lines (constraint 33).
  const unlistedHint = defaultLabel === undefined || defaultLabel.listed
    ? undefined
    : acp.label(
      `${defaultLabel.text} 是智能体报告的当前值，但它自己的列表里没有这一项，所以没有说明可显示。`,
      `${defaultLabel.text} is what the agent reports as current, but the agent's own list does not include it, so no description is available.`,
    )
  return (
    <label className="dwa-field" title={unlistedHint}>
      <span className="dwa-field-label">{axisName}</span>
      <select
        className="dwa-select"
        aria-label={`${axisName} · ${title}`}
        value={value ?? ''}
        onChange={event => onChange(event.target.value === '' ? undefined : event.target.value)}
      >
        <option value="">
          {defaultLabel === undefined ? acp.label('默认', 'Default') : defaultOptionText(acp, defaultLabel)}
        </option>
        {(choices ?? []).map(choice => (
          // The agent's own description rides along (consumption multipliers live
          // there) — the same fact the chat model menu shows as the row detail.
          <option key={choice.value} value={choice.value}>
            {choiceLabel(choice)}
          </option>
        ))}
        {kept && (
          <option value={value} style={stale ? { color: WARN_FG } : undefined}>
            {stale ? staleValueText(acp, clipChoiceText(value, STALE_VALUE_MAX)) : clipChoiceText(value)}
          </option>
        )}
      </select>
    </label>
  )
}

/** A chosen axis's own NAME, for the summary pills: a pill is a fact, not a
 *  menu row, so it never carries the description's consumption multiplier. */
function axisValueName(choices: AcpCatalogChoice[] | undefined, value: string): string {
  const hit = choices?.find(choice => choice.value === value)
  return hit === undefined || hit.name === '' ? value : hit.name
}

/**
 * One configured agent's delegation profile, as a foldable card.
 *
 * The head is the summary line: the agent's name, plus what this profile
 * actually changes about it — the axes it sets and whether it outranks the
 * config file. That is the fact the old layout could not show without reading
 * four controls and comparing them with「默认」, and it is why the head exists
 * at all. The body is the form: the three axes as one row of three equal
 * columns (the old `flex: 1 1 150px` wrapped them into a lopsided 2+1), the
 * description, and one footer that holds the catalog's age, its refresh
 * gesture and the config-file reset.
 *
 * Folding is display-toggled, never unmounted: the description keeps a local
 * draft that is committed on blur, and folding mid-edit must not lose it.
 */
function AgentDefaultsRow(props: {
  acp: AcpStore
  ui: UiState
  delegate: AcpDelegateSettings
  agentId: string
  title: string
  /** Folded or open — owned by the section so「全部收起」can drive every row. */
  open: boolean
  onToggle: () => void
}) {
  const { acp, ui, delegate, agentId, title, open, onToggle } = props
  const catalog = ui.modelCatalogs[agentId]?.catalog
  const age = catalogAge(ui.modelCatalogs[agentId]?.updatedAt)
  const entry = delegate.agentDefaults?.[agentId]
  const configuredEntry = delegate.configured?.agentDefaults?.[agentId]
  const probing = ui.probingModels[agentId] === true
  const probeError = ui.probeErrors[agentId]
  const catalogMissing = ui.modelCatalogs[agentId] === undefined
  const bodyId = `dwa-delegate-defaults-${agentId}`

  // Write one axis by replacing the whole entry (the ui/delegate-set contract):
  // keep the other axes as they are, set or drop this one. A no-op writes nothing.
  const writeAxis = (axis: 'model' | 'effort' | 'mode', value: string | undefined): void => {
    const next: AcpDelegateAgentDefaults = { ...entry }
    if (value === undefined) delete next[axis]
    else next[axis] = value
    if (delegateEntriesEqual(next, entry)) return
    void acp.setDelegateSettings({ agentDefaults: { [agentId]: next } })
  }
  // The description rides in the SAME entry (one per-agent profile): blank
  // deletes it so the schema renders no dangling separator.
  const writeDescription = (raw: string): void => {
    const next: AcpDelegateAgentDefaults = { ...entry }
    const trimmed = raw.trim()
    if (trimmed === '') delete next.description
    else next.description = trimmed
    if (delegateEntriesEqual(next, entry)) return
    void acp.setDelegateSettings({ agentDefaults: { [agentId]: next } })
  }

  // Override fact + reset only when the config file names an entry that the
  // running value outranks (constraint 33). Reset deletes the override entry.
  const overridden = configuredEntry !== undefined && !delegateEntriesEqual(configuredEntry, entry)
  // The override fact is ONE line: a 300-character description would blow the
  // row apart, so it is clipped like every other long value in the card.
  const configuredDescription = configuredEntry?.description
  const shownDescription = configuredDescription === undefined || configuredDescription.length <= 24
    ? configuredDescription
    : `${configuredDescription.slice(0, 24)}…`
  const configuredText = configuredEntry === undefined ? '' : [
    configuredEntry.model === undefined ? undefined : acp.label(`模型 ${configuredEntry.model}`, `model ${configuredEntry.model}`),
    configuredEntry.effort === undefined ? undefined : acp.label(`等级 ${configuredEntry.effort}`, `effort ${configuredEntry.effort}`),
    configuredEntry.mode === undefined ? undefined : acp.label(`模式 ${configuredEntry.mode}`, `mode ${configuredEntry.mode}`),
    shownDescription === undefined ? undefined : acp.label(`描述「${shownDescription}」`, `description "${shownDescription}"`),
  ].filter(part => part !== undefined).join(' · ')

  // What this profile sets, and nothing else: an axis left on「默认」follows
  // the agent process, so naming it would be noise on every row.
  const setAxes = [
    entry?.model === undefined ? undefined : acp.label(`模型 ${axisValueName(axisChoices(catalog, 'model', entry.model), entry.model)}`, `Model ${axisValueName(axisChoices(catalog, 'model', entry.model), entry.model)}`),
    entry?.effort === undefined ? undefined : acp.label(`等级 ${axisValueName(axisChoices(catalog, 'effort', entry.model), entry.effort)}`, `Level ${axisValueName(axisChoices(catalog, 'effort', entry.model), entry.effort)}`),
    entry?.mode === undefined ? undefined : acp.label(`模式 ${axisValueName(axisChoices(catalog, 'mode', entry.model), entry.mode)}`, `Mode ${axisValueName(axisChoices(catalog, 'mode', entry.model), entry.mode)}`),
  ].filter((text): text is string => text !== undefined)

  return (
    <div className="dwa-preference-block">
      <button
        type="button"
        className="dwa-acc-head"
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={onToggle}
      >
        <span className="dwa-agent-avatar dwa-acc-avatar" aria-hidden>{title.slice(0, 2).toUpperCase()}</span>
        <span className="dwa-acc-titles">
          <span className="dwa-acc-name">{title}</span>
          <span className="dwa-acc-pills">
            {setAxes.length === 0
              ? <span className="dwa-sum-pill">{acp.label('全部跟随进程默认', 'All follow the process')}</span>
              : setAxes.map(text => <span key={text} className="dwa-sum-pill is-set">{text}</span>)}
            {entry?.description !== undefined && (
              <span className="dwa-sum-pill">{acp.label('已填描述', 'Description set')}</span>
            )}
            {overridden && <span className="dwa-sum-pill is-warn">{acp.label('覆盖配置文件', 'Overrides config')}</span>}
          </span>
        </span>
        <span className="dwa-caret" aria-hidden>{open ? '▴' : '▾'}</span>
      </button>

      <div className="dwa-acc-body" id={bodyId} hidden={!open}>
        <div className="dwa-axis-grid">
          <AxisSelect acp={acp} title={title} axis="model" value={entry?.model} choices={axisChoices(catalog, 'model', entry?.model)} defaultLabel={resolvedAxisDefaultLabel(catalog, 'model', entry?.model)} onChange={value => writeAxis('model', value)} />
          <AxisSelect acp={acp} title={title} axis="effort" value={entry?.effort} choices={axisChoices(catalog, 'effort', entry?.model)} defaultLabel={resolvedAxisDefaultLabel(catalog, 'effort', entry?.model)} onChange={value => writeAxis('effort', value)} />
          <AxisSelect acp={acp} title={title} axis="mode" value={entry?.mode} choices={axisChoices(catalog, 'mode', entry?.model)} defaultLabel={resolvedAxisDefaultLabel(catalog, 'mode', entry?.model)} onChange={value => writeAxis('mode', value)} />
        </div>
        {entry?.model === undefined && (
          <div className="dwa-preference-copy" style={{ marginTop: 8 }}>
            {acp.label('等级作用于运行时实际模型，不支持会自动丢弃。', 'The level applies to the runtime model; unsupported values are dropped.')}
          </div>
        )}
        <DescriptionInput acp={acp} title={title} value={entry?.description} onCommit={writeDescription} />
        <div className="dwa-preference-copy">
          {acp.label('描述会写进 acp_delegate 的 agent 选项说明，主代理据此挑选。', 'Shown in acp_delegate\'s agent parameter description so the caller can pick.')}
        </div>
        {overridden && (
          <div className="dwa-deadline-flag">
            ⚠ {acp.label(`配置文件要求：${configuredText || '全部默认'}`, `The config file asks for: ${configuredText || 'all defaults'}.`)}
          </div>
        )}
        {/* One footer for the card's slow, low-frequency actions: the catalog's
            age next to the gesture that refreshes it, and the reset that only
            exists when something really outranks the config file. */}
        <div className="dwa-acc-foot">
          <div className="dwa-acc-meta">
            {/* While a probe is in flight the button beside it already says so;
                the age would be a second claim about a snapshot being replaced. */}
            {!probing && age !== undefined && (
              <span>{acp.label(`目录更新于 ${age.zh}`, `Catalog read ${age.en}`)}</span>
            )}
            {probeError !== undefined && (
              <span className="dwa-error" style={{ wordBreak: 'break-word' }}>⚠ {probeError}</span>
            )}
          </div>
          <div className="dwa-row-actions">
            <button type="button" className="dwa-btn dwa-btn-secondary" disabled={probing} onClick={() => void acp.probeModels(agentId)}>
              {probing
                ? (catalogMissing ? acp.label('正在获取目录…', 'Fetching catalog…') : acp.label('正在刷新目录…', 'Refreshing catalog…'))
                : (catalogMissing ? acp.label('获取目录', 'Fetch catalog') : acp.label('刷新目录', 'Refresh catalog'))}
            </button>
            {overridden && (
              <button type="button" className="dwa-btn dwa-btn-quiet" onClick={() => void acp.setDelegateSettings({ agentDefaults: { [agentId]: null } })}>
                {acp.label('恢复配置文件的值', 'Use config file value')}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

/**
 * The delegation-defaults section: a default-agent picker, then one foldable
 * card per configured agent. Mounted inside SubagentCard; returns nothing on a
 * host half that reports no delegate view (the card already gates, this is
 * defensive).
 *
 * The two levels are SIBLINGS, not a card inside a card: the picker is one card
 * and each agent's profile is its own, because a fold is a boundary and nesting
 * two surfaces would put two borders around one boundary. The section label
 * carries the one rule shared by all of them (「默认」follows the agent
 * process), so no card has to repeat it.
 */
export function SubagentDefaults(props: { acp: AcpStore; ui: UiState }) {
  const { acp, ui } = props
  const delegate = ui.delegate
  const rootRef = useRef<HTMLDivElement | null>(null)
  const requested = useRef<Set<string>>(new Set())
  // Re-check visibility every render: the page wrapper toggles `hidden` without
  // remounting, and a hidden section must not pull catalogs (constraint 8).
  // `loadCachedModels` is memory-only and deduped, so the guard keeps it cheap.
  // Freshness stays the user's call: a probe can start an agent process, so the
  // page only reads the snapshot, shows its age beside「刷新目录」, and lets the
  // user decide when to spend the spawn.
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
  const current = delegate.defaultAgent
  const configuredDefault = delegate.configured?.defaultAgent
  if (roster.length === 0 && current === undefined && configuredDefault === undefined) return null

  const rosterIds = new Set(roster.map(agent => agent.id))
  const deleted = current !== undefined && !rosterIds.has(current)
  const resolved = resolvedDefaultAgent(delegate)
  const defaultOptionLabel = resolved === undefined
    ? acp.label('默认（未设置）', 'Default (not set)')
    : acp.label(`默认（当前：${resolved}）`, `Default (now: ${resolved})`)
  const defaultOverridden = configuredDefault !== undefined && configuredDefault !== current

  // Fold state lives here so one control can drive every card. Expanded by
  // default: a first visit must show every control rather than a stack of
  // summaries with the form hidden behind a click.
  const [collapsed, setCollapsed] = useState<readonly string[]>([])
  const isCollapsed = (id: string): boolean => collapsed.includes(id)
  const toggleAgent = (id: string): void => {
    setCollapsed(current => current.includes(id) ? current.filter(other => other !== id) : [...current, id])
  }
  const allFolded = roster.length > 0 && roster.every(agent => isCollapsed(agent.id))

  return (
    <div ref={rootRef} style={{ marginTop: 28 }}>
      <div className="dwa-section-heading">
        <div>
          <h4 className="dwa-section-title dwa-subsection-title">{acp.label('委派默认', 'Delegation defaults')}</h4>
          <p className="dwa-section-copy">
            {acp.label(
              '只影响 acp_delegate 委派；「默认」跟随智能体进程自身。',
              'Affects acp_delegate delegations only; "Default" follows the agent process itself.',
            )}
          </p>
        </div>
        {roster.length > 1 && (
          <button
            type="button"
            className="dwa-btn dwa-btn-quiet"
            onClick={() => setCollapsed(allFolded ? [] : roster.map(agent => agent.id))}
          >
            {allFolded
              ? acp.label('全部展开', 'Expand all')
              : acp.label('全部收起', 'Collapse all')}
          </button>
        )}
      </div>

      <div className="dwa-preferences">
        <div className="dwa-preference-block">
          <div className="dwa-row-split">
            <div className="dwa-row-main">
              <div className="dwa-preference-label">{acp.label('默认智能体', 'Default agent')}</div>
              <div className="dwa-preference-copy">
                {acp.label('委派未指明智能体时使用；「默认」跟随「设为默认智能体」的选择。', 'Used when a delegation names no agent; "Default" follows "Set as default agent".')}
              </div>
            </div>
            <div className="dwa-row-side dwa-row-side-select">
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
      </div>

      {/* One card per agent, as siblings of the picker above — not rows inside
          it: each one's fold is its own boundary, and a nested card would put
          two surfaces inside each other. */}
      <div className="dwa-default-list">
        {roster.map(agent => (
          <AgentDefaultsRow
            key={agent.id}
            acp={acp}
            ui={ui}
            delegate={delegate}
            agentId={agent.id}
            title={agent.title}
            open={!isCollapsed(agent.id)}
            onToggle={() => toggleAgent(agent.id)}
          />
        ))}
      </div>
    </div>
  )
}