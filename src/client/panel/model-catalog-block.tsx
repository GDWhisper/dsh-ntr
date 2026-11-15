/**
 * The model / thought-level catalog card: a two-pane transfer list (every known
 * model ↔ the selection offered in the conversation) plus the per-agent
 * auto-discovery policy.
 */
import { useEffect, useRef, useState } from 'react'
import type { AcpStore } from '../store.ts'
import type { AcpCatalogChoice, DetectedAgentInfo } from '../../protocol.ts'
import { useUi } from './shared.ts'

/** How long a chip edit is coalesced before the lightweight exposure RPC fires. */
const EXPOSURE_SAVE_DEBOUNCE_MS = 400

/** `MM-DD HH:mm`, local time — compact enough for the catalog's status line. */
function formatStamp(ms: number): string {
  const date = new Date(ms)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/**
 * Measure the id cell on row hover so its CSS marquee can reach the end of the
 * text. The id is the only cell that yields width, and the panel is resizable,
 * so the overflow is re-read on every entry rather than cached. The animation
 * itself lives in CSS and only runs while the row is hovered; `title` on the
 * row stays the fallback for reduced-motion users.
 */
function armModelIdMarquee(row: HTMLElement): void {
  const view = row.querySelector<HTMLElement>('.dwa-model-row-value')
  const text = view?.querySelector<HTMLElement>('.dwa-model-row-value-text')
  if (view === null || view === undefined || text === null || text === undefined) return
  const fade = Number.parseFloat(getComputedStyle(view).paddingRight) || 0
  const shift = Math.max(0, text.offsetWidth - (view.clientWidth - fade))
  row.style.setProperty('--dwa-id-shift', `${String(-shift)}px`)
  row.style.setProperty('--dwa-id-duration', `${String(Math.min(4, Math.max(1.2, shift / 30)))}s`)
}

/**
 * Model / thought-level catalog display plus the native-selector visibility
 * filter, as a two-pane transfer list: every known model on the left, the
 * selection that reaches the NTR surfaces on the right. Variants are still
 * opt-in — an empty selection is a legitimate state (base entry only) — and
 * edits save themselves (debounced), so there is no apply button and no second
 * dirty state to lose track of.
 *
 * The panes are ALWAYS shown, never gated on a probe: the right side comes from
 * the agent definition (`exposedModels`) and the left from the host's persisted
 * catalog cache, so opening the card shows what is already configured instead
 * of an empty box that costs one click per visit. 「检测可用模型」 therefore
 * sits with the list and acts as a REFRESH of the left pane only — models the
 * agent newly publishes appear, models it stopped advertising drop out.
 *
 * The auto-discovery switch is a per-agent POLICY, not a one-shot action: it
 * appends models the agent NEWLY publishes to the selection (see
 * `AcpAgentDef.autoDiscoverModels`). It saves itself through the lightweight
 * RPC, so flipping it never restarts the agent process.
 */
export function ModelCatalogBlock({
  agentId,
  detected,
  acp,
  active,
  exposed,
  onExposedChange,
  autoDiscover,
  onAutoDiscoverChange,
  isDefault,
}: {
  agentId: string
  detected: DetectedAgentInfo
  acp: AcpStore
  /** The card's body is visible; the display read waits for the first expand. */
  active: boolean
  exposed: string[] | undefined
  onExposedChange: (next: string[] | undefined) => void
  autoDiscover: boolean
  onAutoDiscoverChange: (next: boolean) => void
  isDefault: boolean
}) {
  const ui = useUi(acp)
  const [saveError, setSaveError] = useState<string | undefined>(undefined)
  const [search, setSearch] = useState('')
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const pending = useRef<string[] | undefined>(undefined)
  const hasPending = useRef(false)
  // In-flight auto-discovery toggle. A ref, not state: the switch saves
  // silently, and a "saving" render here made the row wrap and snap back
  // (user report, 2026-10-21). The guard only prevents double-submits.
  const autoDiscoverBusy = useRef(false)
  // Latest host-confirmed filter: the rollback target when a save fails.
  const serverValue = useRef(exposed)
  serverValue.current = detected.currentConfig?.exposedModels

  const probing = ui.probingModels[agentId] === true
  const probeError = ui.probeErrors[agentId]
  const result = ui.modelCatalogs[agentId]
  const modelChoices = result?.catalog.model?.choices ?? []
  /** Result of the last click on 「检测可用模型」 (what the refresh changed). */
  const [detectNote, setDetectNote] = useState<string | undefined>(undefined)
  // Each list folds on its own so a long selection can be parked while the
  // other pane keeps the full column. The list stays mounted (display-toggled)
  // to keep its scroll position.
  const [allCollapsed, setAllCollapsed] = useState(false)
  const [selectedCollapsed, setSelectedCollapsed] = useState(false)

  // Display read, not a probe: the host answers from its persisted catalog
  // cache, so the panes already list the known models the first time the card
  // opens. Gated on `active` because every configured agent's body stays
  // mounted (display-toggled) and a collapsed card has nothing to show.
  useEffect(() => {
    if (!active) return
    void acp.loadCachedModels(agentId)
  }, [active, agentId])

  useEffect(() => () => {
    if (timer.current === undefined) return
    clearTimeout(timer.current)
    // Flush a pending edit instead of dropping it with the unmount (the
    // panel can be closed mid-debounce); the host keeps the last word.
    if (!hasPending.current) return
    hasPending.current = false
    void acp.setExposedModels(agentId, pending.current).catch(() => { /* host keeps its value */ })
  }, [])

  const rollback = (error: unknown): void => {
    onExposedChange(serverValue.current === undefined ? undefined : [...serverValue.current])
    setSaveError(error instanceof Error ? error.message : String(error))
  }

  /** Persist a filter now (mode switch); a failure restores the editor. */
  const commit = async (next: string[] | undefined): Promise<void> => {
    setSaveError(undefined)
    try {
      await acp.setExposedModels(agentId, next)
      onExposedChange(next)
    } catch (error) {
      rollback(error)
    }
  }

  /** Persist selection edits after a short idle — several clicks coalesce into one call. */
  const queueExposure = (next: string[]): void => {
    pending.current = next
    hasPending.current = true
    if (timer.current !== undefined) clearTimeout(timer.current)
    timer.current = setTimeout(() => {
      if (!hasPending.current) return
      hasPending.current = false
      void commit(pending.current)
    }, EXPOSURE_SAVE_DEBOUNCE_MS)
  }

  const toggleAutoDiscover = async (next: boolean): Promise<void> => {
    if (autoDiscoverBusy.current) return
    autoDiscoverBusy.current = true
    onAutoDiscoverChange(next)
    setSaveError(undefined)
    try {
      await acp.setAutoDiscoverModels(agentId, next)
    } catch (error) {
      onAutoDiscoverChange(!next)
      setSaveError(error instanceof Error ? error.message : String(error))
    } finally {
      autoDiscoverBusy.current = false
    }
  }

  const query = search.trim().toLowerCase()
  const visibleChoices = query === ''
    ? modelChoices
    : modelChoices.filter(choice =>
      choice.name.toLowerCase().includes(query) || choice.value.toLowerCase().includes(query))

  // Unset means "nothing selected", not "everything": an unset filter and an
  // empty one are the same host-side state (base entry only).
  const basis = exposed ?? []
  const selected = new Set(basis)
  // Right pane = selection in catalog order, then any selected value the last
  // probe no longer lists (still saved and still usable — hiding it would make
  // the two panes quietly disagree about what is configured).
  const selectedChoices: AcpCatalogChoice[] = []
  for (const choice of modelChoices) if (selected.has(choice.value)) selectedChoices.push(choice)
  const listed = new Set(selectedChoices.map(choice => choice.value))
  for (const value of basis) if (!listed.has(value)) selectedChoices.push({ value, name: value })
  const selectedInCatalog = basis.filter(value => modelChoices.some(choice => choice.value === value)).length

  const apply = (next: string[]): void => {
    onExposedChange(next)
    queueExposure(next)
  }

  const toggleChoice = (value: string): void => {
    apply(selected.has(value) ? basis.filter(v => v !== value) : [...basis, value])
  }

  /** Add every model matching the current search that is not selected yet. */
  const addVisible = (): void => {
    const added = visibleChoices.map(choice => choice.value).filter(value => !selected.has(value))
    if (added.length === 0) return
    apply([...basis, ...added])
  }

  const clearAll = (): void => {
    if (basis.length === 0) return
    apply([])
  }

  /**
   * Refresh the left pane from the agent: re-probe, then report what moved.
   * The note is what makes the button legible — a refresh that changes nothing
   * looks identical to a dead button otherwise (the catalog `updatedAt` does
   * not even move, since the host keeps the entry when the answer is equal).
   */
  const detect = async (): Promise<void> => {
    const before = new Set(modelChoices.map(choice => choice.value))
    setDetectNote(undefined)
    await acp.probeModels(agentId)
    const state = acp.getSnapshot()
    if (state.probeErrors[agentId] !== undefined) return
    const after = state.modelCatalogs[agentId]?.catalog.model?.choices ?? []
    const afterValues = new Set(after.map(choice => choice.value))
    const added = after.filter(choice => !before.has(choice.value)).length
    const removed = [...before].filter(value => !afterValues.has(value)).length
    setDetectNote(added === 0 && removed === 0
      ? acp.label('目录无变化', 'Catalog unchanged')
      : acp.label(
        `新增 ${String(added)} · 移除 ${String(removed)}`,
        `${String(added)} added · ${String(removed)} removed`,
      ))
  }

  const selectionBadge = modelChoices.length > 0
    ? acp.label(
      `已选 ${String(selectedInCatalog)}/${String(modelChoices.length)}`,
      `Selected ${String(selectedInCatalog)}/${String(modelChoices.length)}`,
    )
    : acp.label(`已选 ${String(basis.length)}`, `Selected ${String(basis.length)}`)

  // Freshness of the cached list (a probe that finds nothing new keeps the old
  // stamp by design — see `detect`), superseded by the click's own outcome.
  const catalogStatus = detectNote ?? (
    result !== undefined && result.updatedAt > 0
      ? acp.label(`目录更新于 ${formatStamp(result.updatedAt)}`, `Catalog from ${formatStamp(result.updatedAt)}`)
      : undefined
  )

  const leftEmptyCopy = visibleChoices.length > 0
    ? undefined
    : modelChoices.length > 0
      ? acp.label('无匹配模型', 'No matching models')
      : result === undefined
        ? acp.label('尚未读取模型目录，点「检测可用模型」从 Agent 读取。', 'No catalog yet — click "Detect available models" to read it from the agent.')
        : acp.label('该 Agent 未暴露模型选择器（category: model）。', 'This agent exposes no model selector (category: model).')

  return (
    <div>
      {!isDefault && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <button className="dwa-btn" onClick={() => void acp.setDefaultAgent(agentId)}>
            {acp.label('设为默认智能体', 'Set as default agent')}
          </button>
        </div>
      )}
      {isDefault && (
        // This default belongs to the plugin, not the deployment model route.
        <div className="dwa-hint" style={{ marginTop: 8 }}>
          {acp.label(
            '当前为默认智能体：新的 NTR 会话由它服务，不影响其他模式的默认模型。',
            "This is the default agent for new NTR sessions; other modes' default models are untouched.",
          )}
        </div>
      )}

      <div className="dwa-inline-setting" style={{ marginTop: 12 }}>
        <label
          className="dwa-switch"
          title={acp.label(
            'Agent 新发布的模型会自动加入右侧已选列表；首次检测到的目录只作为基线，不会一次性全选。',
            'Models the agent newly publishes are added to the selected list; the first observed catalog is only a baseline and is not selected wholesale.',
          )}
        >
          <input
            type="checkbox"
            checked={autoDiscover}
            onChange={e => void toggleAutoDiscover(e.target.checked)}
            style={{ margin: 0, accentColor: 'var(--dsw-alias-state-business-primary, #2563eb)' }}
          />
          {acp.label('自动发现新模型', 'Auto-discover new models')}
        </label>
        <span className="dwa-setting-copy">
          {acp.label('新增模型自动加入已选列表，现有勾选不受影响。', 'New models join the selected list automatically; existing picks are untouched.')}
        </span>
      </div>
      {saveError !== undefined && <div className="dwa-error" style={{ marginTop: 4 }}>{saveError}</div>}
      {probeError !== undefined && (
        <div className="dwa-error" style={{ marginTop: 8, wordBreak: 'break-word' }}>
          ⚠ {acp.label('模型检测失败：', 'Model detection failed: ')}{probeError}
        </div>
      )}

      {/* Always rendered, never gated on a probe: the selection is known from
          the agent definition and the left list from the host's persisted
          catalog cache. A card that only fills in after a click makes the
          configured state invisible on every visit. */}
      <div className="dwa-model-section">
        <div className="dwa-model-toolbar">
          <span className="dwa-form-label">
            {acp.label('对话中可见的模型', 'Models offered in the conversation')}
            <span
              className="dwa-hint"
              style={{ marginLeft: 6, fontWeight: 400 }}
              title={acp.label(
                'NTR 模式下的对话只列出这里勾选的模型；未勾选的仍可用——正在生效的那个也会以「· 当前」列出来，其余不列出。',
                'The NTR surfaces only list what is checked here; unchecked models still work, and the one currently in force is still listed with a "· current" row — the rest are not offered.',
              )}
            >
              {acp.label('仅影响菜单可见性', 'Menu visibility only')}
            </span>
          </span>
          <span className="dwa-badge dwa-badge-info">{selectionBadge}</span>
          {/* Freshness of the list stays on the header line, right-aligned; the
              controls below it wrap as one unit. */}
          {catalogStatus !== undefined && <span className="dwa-hint dwa-model-status">{catalogStatus}</span>}
          <div className="dwa-model-toolbar-actions">
            {/* Sits with the list it acts on: a refresh of the LEFT pane only.
                Detection is not what reveals the models — the cache read above
                already does — so keeping it at the top made it read as the
                price of seeing anything at all. */}
            <button
              type="button"
              className="dwa-btn dwa-btn-secondary"
              disabled={probing}
              onClick={() => void detect()}
              title={acp.label(
                '重新读取 Agent 的模型目录：新增的加入左侧，已下架的从左侧移除；已选列表不受影响。',
                'Re-read the agent catalog: newly published models join the left list, withdrawn ones drop out. The selection is untouched.',
              )}
            >
              {probing ? acp.label('模型检测中...', 'Probing models...') : acp.label('检测可用模型', 'Detect available models')}
            </button>
            {/* The filter lives above BOTH panes, not inside the left one: a
                search field between the pane head and its list made that pane
                structurally taller, so the two could never share one height. */}
            <input
              className="dwa-input dwa-model-search"
              aria-label={acp.label('搜索模型', 'Search models')}
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder={acp.label('搜索模型…', 'Search models…')}
            />
          </div>
        </div>

        <div className="dwa-model-transfer">
          <div className={`dwa-model-pane${allCollapsed ? ' is-collapsed' : ''}`}>
            <div className="dwa-model-pane-head">
              <span>{acp.label('全部模型', 'All models')}</span>
              {result !== undefined && <span className="dwa-badge">{modelChoices.length}</span>}
              <button
                type="button"
                className="dwa-btn dwa-btn-secondary"
                disabled={visibleChoices.length === 0}
                onClick={addVisible}
                title={acp.label('把当前搜索范围内的模型全部加入右侧', 'Add every model matching the current search')}
              >
                {acp.label('全部加入', 'Add all')}
              </button>
              <button
                type="button"
                className="dwa-caret-btn"
                aria-expanded={!allCollapsed}
                onClick={() => setAllCollapsed(value => !value)}
                title={allCollapsed ? acp.label('展开全部模型', 'Expand all models') : acp.label('收起全部模型', 'Collapse all models')}
              >
                <span className="dwa-caret" aria-hidden>{allCollapsed ? '▸' : '▾'}</span>
              </button>
            </div>
            <div className="dwa-model-list">
              {visibleChoices.map(choice => {
                const checked = selected.has(choice.value)
                // group 前缀仅来自 agent 返回的 SessionConfigSelectGroup（见 impl.ts
                // pushCatalogChoice）；供应商可见性兜底靠原样展示 value，严禁从
                // value 路径截取供应商段做标签（约束 8）。
                const title = choice.description === undefined
                  ? choice.value
                  : `${choice.value}\n${choice.description}`
                return (
                  <button
                    type="button"
                    key={choice.value}
                    className={`dwa-model-row${checked ? ' is-on' : ''}`}
                    title={title}
                    onClick={() => toggleChoice(choice.value)}
                    onPointerEnter={event => { armModelIdMarquee(event.currentTarget) }}
                  >
                    <span className="dwa-model-row-mark">{checked ? '✓' : '+'}</span>
                    <span className="dwa-model-row-name">
                      {choice.group !== undefined && <span style={{ opacity: 0.7 }}>{choice.group} · </span>}
                      {choice.name}
                    </span>
                    {choice.value !== choice.name && (
                      <span className="dwa-model-row-value">
                        <span className="dwa-model-row-value-text">{choice.value}</span>
                      </span>
                    )}
                    {/* Credit / capability notes belong on the row itself: the
                        list exists to compare models, and a hover-only price
                        cannot be scanned. Grouped choices reuse the group label
                        as their fallback description — that one is already
                        printed before the name. */}
                    {choice.description !== undefined && choice.description !== choice.group && (
                      <span className="dwa-model-row-desc">{choice.description}</span>
                    )}
                  </button>
                )
              })}
              {leftEmptyCopy !== undefined && <span className="dwa-hint dwa-model-empty">{leftEmptyCopy}</span>}
            </div>
          </div>

          <div className={`dwa-model-pane${selectedCollapsed ? ' is-collapsed' : ''}`}>
            <div className="dwa-model-pane-head">
              <span>{acp.label('已选模型', 'Selected models')}</span>
              <span className="dwa-badge dwa-badge-info">{basis.length}</span>
              <button
                type="button"
                className="dwa-btn dwa-btn-secondary"
                disabled={basis.length === 0}
                onClick={clearAll}
              >
                {acp.label('清空', 'Clear')}
              </button>
              <button
                type="button"
                className="dwa-caret-btn"
                aria-expanded={!selectedCollapsed}
                onClick={() => setSelectedCollapsed(value => !value)}
                title={selectedCollapsed ? acp.label('展开已选模型', 'Expand selected models') : acp.label('收起已选模型', 'Collapse selected models')}
              >
                <span className="dwa-caret" aria-hidden>{selectedCollapsed ? '▸' : '▾'}</span>
              </button>
            </div>
            <div className="dwa-model-list">
              {selectedChoices.length === 0 && (
                <span className="dwa-hint dwa-model-empty">
                  {acp.label('尚未选择模型，从「全部模型」中加入。', 'No models selected. Add from All models.')}
                </span>
              )}
              {selectedChoices.map(choice => (
                <button
                  type="button"
                  key={choice.value}
                  className="dwa-model-row is-on"
                  title={choice.description === undefined ? choice.value : `${choice.value}\n${choice.description}`}
                  onClick={() => toggleChoice(choice.value)}
                  onPointerEnter={event => { armModelIdMarquee(event.currentTarget) }}
                >
                  <span className="dwa-model-row-name">
                    {choice.group !== undefined && <span style={{ opacity: 0.7 }}>{choice.group} · </span>}
                    {choice.name}
                  </span>
                  {choice.value !== choice.name && (
                    <span className="dwa-model-row-value">
                      <span className="dwa-model-row-value-text">{choice.value}</span>
                    </span>
                  )}
                  {choice.description !== undefined && choice.description !== choice.group && (
                    <span className="dwa-model-row-desc">{choice.description}</span>
                  )}
                  <span className="dwa-model-row-remove" aria-hidden="true">×</span>
                </button>
              ))}
            </div>
          </div>
        </div>

        {result?.catalog.thought !== undefined && (
          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', alignItems: 'center' }}>
            <span className="dwa-form-label">{acp.label('思考等级', 'Thought Levels')}</span>
            {result.catalog.thought.choices.map(choice => (
              <span key={choice.value} className="dwa-badge" title={choice.description}>
                {choice.name}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
