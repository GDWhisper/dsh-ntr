/**
 * One agent row: the compact summary (status, model count, badges), the
 * overflow menu with its inline confirms, and the body that hands off to the
 * catalog and connection editors.
 *
 * Every save gesture lives here — the row owns the form state, the save-gate
 * read, and the queue / defer bookkeeping — because a save stops the child and
 * kills its live sessions, so the warning and the gesture have to be one
 * surface.
 */
import { useEffect, useRef, useState } from 'react'
import { formatCommandLine, isAbsolutePathLike, splitCommandLine } from '../acp-ui.tsx'
import { AGENT_ID_PATTERN } from '../agent-id.ts'
import {
  DEFAULT_KNOWN_PRESETS,
  saveGateIsAvailable,
  saveGateOutcomeForLabel,
  saveGateOutcomeSuperseded,
} from '../store.ts'
import type { AcpStore } from '../store.ts'
import type { ActiveTurnView, AgentSaveMode, AgentSavePayload, AgentView, DetectedAgentInfo } from '../../protocol.ts'
import { AgentDetails } from './agent-details.tsx'
import type { AgentForm } from './form.ts'
import { buildPayload, idleValid, initialForm, mcpTextValid, payloadEquals } from './form.ts'
import { ModelCatalogBlock } from './model-catalog-block.tsx'
import type { AgentTestOutcome } from './permission-mirror.tsx'
import { agentTestHint } from './permission-mirror.tsx'
import { exposureKey, persistedDef, stateVisual, useUi } from './shared.ts'

/** Preset ids (drives the「自定义」badge); mirrors AGENT_PRESETS via store copies. */
const PRESET_IDS = new Set(DEFAULT_KNOWN_PRESETS.map(preset => preset.id))

/**
 * One agent row's save gesture. `held` is the only staged stage: the queue lists
 * `agent-save:<id>` and the write waits behind active turns. `confirming` and
 * `saving` describe one attempt, never a staged one; the dialog stays in `saveConfirm`.
 */
type SaveStage =
  | { kind: 'idle' }
  | { kind: 'confirming'; payload: AgentSavePayload }
  | { kind: 'saving'; payload: AgentSavePayload }
  | { kind: 'held'; signature: string; sawQueue: boolean; outcomeBaseline?: number }

/** One row per agent: compact when collapsed, the full form when expanded. */
export function AgentRow({
  detected,
  activeAgent,
  acp,
  isDefault,
  synthesized,
  active,
  newCustom = false,
  onCreated,
}: {
  detected: DetectedAgentInfo
  activeAgent?: AgentView
  acp: AcpStore
  isDefault: boolean
  synthesized: boolean
  active: boolean
  /** From-scratch creation: the id is editable and no preset defaults exist. */
  newCustom?: boolean
  /** Fired after a creation-card save succeeds (the list re-derives its selection). */
  onCreated?: () => void
}) {
  const ui = useUi(acp)
  const configured = activeAgent !== undefined || detected.currentConfig !== undefined
  // A configured agent starts collapsed; a creation card opens straight away
  // (nothing to summarise yet).
  const [expanded, setExpanded] = useState(!configured)
  const [detailPage, setDetailPage] = useState<'models' | 'connection' | 'advanced'>(configured ? 'models' : 'connection')
  const [form, setForm] = useState<AgentForm>(() => initialForm(detected, activeAgent))
  const [savedSuccess, setSavedSuccess] = useState(false)
  /**
   * The save gesture. `held` is the only staged stage: the queue lists
   * `agent-save:<id>`, so a remount or refresh still shows it. `signature`
   * freezes the payload it will write; `sawQueue` records that the queue listed
   * this label, and `outcomeBaseline` the terminal outcome seen at queue time.
   */
  const [saveStage, setSaveStage] = useState<SaveStage>({ kind: 'idle' })
  const saving = saveStage.kind === 'saving'
  /** One line of edit/cancel feedback; a failed cancel is a page banner. */
  const [saveNotice, setSaveNotice] = useState<string>()
  // Every save re-reads the gate before it shows the dialog, so this starting
  // value only bridges a transient status-read failure: it keeps the queue
  // gesture available until a snapshot positively says the gate is absent.
  // A snapshot without `gateAvailable` flips this to `false` in `handleSave`.
  const [saveGateAvailable, setSaveGateAvailable] = useState(true)
  const [saveConfirm, setSaveConfirm] = useState<ActiveTurnView[] | undefined>(undefined)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<AgentTestOutcome | undefined>(undefined)
  const patch = (next: Partial<AgentForm>): void => setForm(prev => ({ ...prev, ...next }))

  const serverExposureKey = exposureKey(detected.currentConfig?.exposedModels)
  useEffect(() => {
    const server = detected.currentConfig?.exposedModels
    setForm(prev => ({ ...prev, exposed: server === undefined ? undefined : [...server] }))
    // Re-sync the editor only when the persisted filter actually changes, so
    // background resyncs never clobber in-progress checkbox edits.
  }, [serverExposureKey])

  const serverAutoDiscover = detected.currentConfig?.autoDiscoverModels !== false
  useEffect(() => {
    // The switch saves itself through the lightweight RPC, so the host is the
    // truth; this keeps the form (and therefore a later full save) in step.
    setForm(prev => ({ ...prev, autoDiscoverModels: serverAutoDiscover }))
  }, [serverAutoDiscover])

  const serverSkillsMcp = detected.currentConfig?.skillsMcpEnabled !== false
  useEffect(() => {
    // Same deal for the per-agent `dsh-skills` checkbox: it is edited through
    // the lightweight RPC, never through this form. Following the host answer
    // is what stops a later full save from writing the value from before the
    // click (the payload carries the field so a save cannot enable it either).
    setForm(prev => ({ ...prev, skillsMcpEnabled: serverSkillsMcp }))
  }, [serverSkillsMcp])

  const serverDefaultMode = detected.currentConfig?.defaultMode ?? ''
  useEffect(() => {
    // The default mode is another lightweight-RPC field: carry the host answer
    // in the form so a later full save preserves it rather than clearing it.
    setForm(prev => (prev.defaultMode === serverDefaultMode ? prev : { ...prev, defaultMode: serverDefaultMode }))
  }, [serverDefaultMode])

  const trimmedId = form.agentId.trim()
  const idValid = !newCustom || AGENT_ID_PATTERN.test(trimmedId)
  const idTaken = newCustom && trimmedId !== '' && ui.agents.some(a => a.id === trimmedId)
  // A tombstone is per host run: the deleted id cannot come back until a
  // restart, so warn before a doomed save is attempted.
  const idDeleted = newCustom && trimmedId !== '' && ui.deletedAgentIds.includes(trimmedId)
  const cwdInvalid = form.cwd.trim() !== '' && !isAbsolutePathLike(form.cwd.trim())
  const rootValues = form.roots.map(root => root.trim()).filter(root => root !== '')
  const rootsInvalid = form.rootsOpen && (rootValues.length === 0 || rootValues.some(root => !isAbsolutePathLike(root)))
  const idleInvalid = !idleValid(form.idleStr)
  const mcpInvalid = !mcpTextValid(form.mcpText)
  const formIncomplete = splitCommandLine(form.commandLine).command === '' || !idValid || idTaken || idDeleted || cwdInvalid || rootsInvalid || idleInvalid || mcpInvalid

  const payload = buildPayload(form, detected, newCustom)
  const current = persistedDef(detected, activeAgent)
  const clearingIdleOverride = payload.idleTimeoutMs === undefined && detected.currentConfig?.idleTimeoutMs !== undefined
  const dirty = current !== undefined && (!payloadEquals(payload, current) || clearingIdleOverride)
  // A save stops the child and kills every live session (see BridgeManager.saveAgent).
  const showSaveWarning = dirty && activeAgent !== undefined && activeAgent.state !== 'stopped'

  /**
   * Active turns for THIS agent. A trusted gate is the authority; an older host
   * has no gate, so only the browser's own session rows can answer. Never read
   * an untrusted snapshot's empty `activeSessions` as proof of idle.
   */
  const activeSessionsForSave = (trustGate = true): ActiveTurnView[] => {
    if (trustGate) {
      const fromGate = ui.saveGate.activeSessions.filter(view => view.agentId === payload.id)
      if (fromGate.length > 0) return fromGate
    }
    // The host also counts a session whose agent has not settled its prompt
    // (`settled`). An older host half never sends that field, so this fallback
    // can still under-report that brief window — it is the known limitation.
    return ui.sessions
      .filter(session => session.agentId === payload.id && session.released !== true && (session.running || session.settled === true))
      .map(session => ({ sessionId: session.sessionId, agentId: session.agentId }))
  }

  const saveLabel = `agent-save:${payload.id}`
  const labelOutcome = saveGateOutcomeForLabel(ui.saveGate, saveLabel)
  const savePending = ui.saveGate.pending.some(entry => entry.label === saveLabel)
  const payloadSignature = JSON.stringify(payload)
  if (saveStage.kind === 'idle' && savePending) {
    // A queue entry with no local answer (a remount, or another surface's
    // write) becomes this row's held attempt with the form signature frozen.
    // The update makes `idle` false on the re-render, so this cannot loop.
    setSaveStage({ kind: 'held', signature: payloadSignature, sawQueue: true })
  }
  // Held while this label is queued, or while the local defer answer is still
  // waiting for its first queue frame. No browser clock is compared with the
  // host's: the queue plus a terminal outcome for this label decide settlement.
  const saveDeferred = saveStage.kind === 'held'
  const cancelInFlight = useRef(false)
  const latestPayloadSignature = useRef(payloadSignature)
  latestPayloadSignature.current = payloadSignature

  useEffect(() => {
    if (savePending) {
      // The queue is back: a "cancelled, save again" line would now contradict
      // the held state shown in the same composer.
      if (saveNotice !== undefined) setSaveNotice(undefined)
      if (saveStage.kind === 'held' && !saveStage.sawQueue) setSaveStage({ ...saveStage, sawQueue: true })
      return
    }
    if (saveStage.kind !== 'held') return
    if (labelOutcome === undefined) return
    // A superseded row belongs to a newer save, not to this held attempt.
    if (saveGateOutcomeSuperseded(labelOutcome)) return
    // A terminal outcome that predates this defer cannot settle it. Identity
    // (not ordering) is enough: the outcome's `at` names the host's settlement,
    // and it is only "new" when it differs from the one captured at defer time.
    const outcomeIsNew = saveStage.outcomeBaseline === undefined || labelOutcome.at !== saveStage.outcomeBaseline
    if (!saveStage.sawQueue && !outcomeIsNew) return
    setSaveStage({ kind: 'idle' })
    if (labelOutcome.status === 'cancelled') {
      setSaveNotice(acp.label('已取消暂存，请重新保存。', 'The held setting was cancelled. Please save again.'))
    }
  }, [savePending, saveStage, labelOutcome, saveNotice, acp])

  useEffect(() => {
    if (saveStage.kind !== 'held') return
    // The user kept editing: the held snapshot would write stale values, so
    // drop it explicitly and tell the user to save again. Checking the queue
    // keeps this working after a remount, where the exact payload is gone.
    if (payloadSignature === saveStage.signature) return
    if (cancelInFlight.current) return
    cancelInFlight.current = true
    const signatureAtStart = payloadSignature
    void (async () => {
      try {
        let cancelled = await acp.cancelSaveGate(saveLabel)
        // An edit can land while the cancel request is in flight. The effect
        // above skipped it, so compare the LATEST signature here and send one
        // follow-up cancellation; otherwise the last edit would never be
        // applied to the queue.
        if (latestPayloadSignature.current !== signatureAtStart) {
          cancelled = await acp.cancelSaveGate(saveLabel)
        }
        // A failed cancel keeps the held state; the store already raised the
        // "cancel did not take effect" banner with its retry gesture.
        if (!cancelled) return
        setSaveStage({ kind: 'idle' })
        setSaveNotice(acp.label('已取消暂存，请重新保存。', 'The held setting was cancelled. Please save again.'))
        void acp.readSaveGate().catch(() => { /* the status frame remains authoritative */ })
      } finally {
        cancelInFlight.current = false
      }
    })()
  }, [payloadSignature, saveStage, saveLabel, acp])

  const handleUseDefault = (): void => patch({ commandLine: formatCommandLine(detected.defaultCommand, detected.defaultArgs) })

  /**
   * The actual save, after the user's gesture is known. The host re-checks the
   * gate, so a turn that started between the pre-check and this call still
   * returns `confirmationRequired` instead of interrupting.
   */
  const performSave = async (mode: AgentSaveMode): Promise<void> => {
    // An older host has no gate to queue behind: offering "save after turns"
    // there would silently interrupt them when it ignores `saveMode`.
    if (mode === 'defer' && !saveGateAvailable) return
    setSavedSuccess(false)
    setSaveStage({ kind: 'saving', payload })
    setSaveNotice(undefined)
    setSaveConfirm(undefined)
    try {
      const result = await acp.saveAgent(payload, mode)
      // The agent was deleted while this save ran; the host aborted without
      // writing. That is not a success and not a staged settlement.
      if (result.cancelled === true) {
        setSaveStage({ kind: 'idle' })
        return
      }
      if (result.confirmationRequired) {
        const fromHost = result.activeSessions ?? []
        const active = fromHost.length > 0 ? fromHost : activeSessionsForSave(saveGateAvailable)
        setSaveConfirm(active)
        setSaveStage({ kind: 'confirming', payload })
        return
      }
      if (result.deferred) {
        // Freeze the signature this deferred save will write. Editing the form
        // afterwards cancels it (see the effect above). The gate read brings the
        // queue in immediately; the pending state itself survives a remount.
        setSaveStage({ kind: 'held', signature: payloadSignature, sawQueue: false, outcomeBaseline: labelOutcome?.at })
        void acp.readSaveGate().catch(() => { /* the status frame remains authoritative */ })
        return
      }
      // A save from the creation card resets the list's selection: the agent
      // now lives in the configured list, and keeping the same card mounted
      // would render it twice. Configured rows pass no `onCreated`, so this is
      // a no-op for them.
      setSaveStage({ kind: 'idle' })
      onCreated?.()
      if (newCustom) return
      setSavedSuccess(true)
      setTimeout(() => setSavedSuccess(false), 2000)
    } catch {
      // Error handled by store
      setSaveStage({ kind: 'idle' })
    }
  }

  const handleSave = async (): Promise<void> => {
    if (saving) return
    // Ask the host before opening the form's own confirmation. If the status
    // endpoint is unavailable (older host), the host's `agent/save` guard is
    // still the authority and will answer `confirmationRequired`.
    try {
      const status = await acp.readSaveGate()
      const available = saveGateIsAvailable(status)
      setSaveGateAvailable(available)
      // Only a live gate snapshot is an authority. `false` also covers a
      // disposed gate. On an older/non-wired host its empty `activeSessions`
      // proves nothing: use the browser's own live session rows, and if those
      // are empty still send the direct save — the host's `agent/save` guard
      // answers `confirmationRequired` and the dialog opens from that answer.
      const active = available
        ? status.activeSessions.filter(view => view.agentId === payload.id)
        : activeSessionsForSave(false)
      if (active.length > 0) {
        setSaveConfirm(active)
        // A dialog must not overwrite a staged write, or the next edit stops cancelling it.
        if (saveStage.kind !== 'held') setSaveStage({ kind: 'confirming', payload })
        return
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const code = (error as { code?: string }).code
      // Only a host without the endpoint loses the queue gesture. A transient
      // read failure keeps it: the next attempt may succeed, and the host's
      // agent/save guard is still the final authority.
      const unsupported = code === 'unsupported' || message.includes('unknown endpoint save/status')
      if (unsupported) setSaveGateAvailable(false)
      if (!unsupported) {
        setSaveNotice(acp.label(
          '读取保存状态失败，请稍后重试。',
          'Could not read the save status. Please try again later.',
        ))
      }
      const active = activeSessionsForSave(!unsupported && saveGateAvailable)
      if (active.length > 0) {
        setSaveConfirm(active)
        if (saveStage.kind !== 'held') setSaveStage({ kind: 'confirming', payload })
        return
      }
      if (!unsupported) return
    }
    await performSave('direct')
  }

  const handleTest = async (): Promise<void> => {
    setTesting(true)
    setTestResult(undefined)
    try {
      const result = await acp.testAgent(payload)
      setTestResult(result.ok
        ? {
          ok: true,
          text: acp.label('连接成功', 'Connected') + (result.agentInfo?.name !== undefined ? ` · ${result.agentInfo.name}` : '')
            + (result.agentInfo?.version !== undefined ? ` v${result.agentInfo.version}` : '')
            + ` · ${String(result.durationMs)}ms`,
          // A successful start can still write warnings to stderr; the host
          // returns them, so show them instead of dropping half the evidence.
          detail: result.stderr,
        }
        : {
          ok: false,
          text: result.error ?? acp.label('未知错误', 'Unknown error'),
          // The hint is what turns the one SDK sentence into the user's actual
          // mistake; `stderr` is the evidence behind it (constraint 29: output
          // is truncated only with a marker, never silently).
          hint: agentTestHint(result, acp.label),
          detail: result.stderr,
        })
    } catch (error) {
      setTestResult({ ok: false, text: error instanceof Error ? error.message : String(error), detail: [] })
    } finally {
      setTesting(false)
    }
  }

  const state = activeAgent !== undefined ? stateVisual(activeAgent.state, acp) : undefined
  // Sessions a delete or stop would interrupt. The gate's active-turn views
  // cover turns the session list may not have hydrated yet; the list covers
  // live sessions between turns.
  const affectedSessionIds = new Set<string>()
  for (const view of ui.saveGate.activeSessions) {
    if (view.agentId === detected.id) affectedSessionIds.add(view.sessionId)
  }
  for (const session of ui.sessions) {
    // A released session waits for `session/load`; it has no live turn to
    // interrupt, so it must not inflate the destructive-action count.
    if (session.agentId === detected.id && !session.closed && session.released !== true) {
      affectedSessionIds.add(session.sessionId)
    }
  }
  const affectedSessions = affectedSessionIds.size
  const displayName = newCustom
    ? acp.label('新建自定义 Agent', 'New Custom Agent')
    : (activeAgent?.title ?? detected.currentConfig?.title ?? detected.name)
  const stderr = activeAgent?.state === 'error' ? (activeAgent.stderrTail ?? []) : []
  const errorSummary = stderr.length > 0 ? stderr[stderr.length - 1] : undefined
  const selectedModelCount = form.exposed?.length ?? 0
  const isPreset = PRESET_IDS.has(detected.id)
  // An error row opens itself so the stderr tail is never behind a click.
  const open = expanded || (activeAgent?.state === 'error' && configured)

  return (
    <div className={`dwa-agent-card${open ? ' is-open' : ''}`}>
      <div className="dwa-agent-row">
        <span className="dwa-agent-avatar" aria-hidden>{displayName.slice(0, 2).toUpperCase()}</span>
        <div className="dwa-agent-summary">
          <div className="dwa-agent-titleline">
            <span className="dwa-agent-name" title={detected.executablePath ?? detected.description}>{displayName}</span>
            {isDefault && <span className="dwa-badge dwa-badge-info">{acp.label('默认', 'Default')}</span>}
            {!isPreset && !newCustom && <span className="dwa-badge">{acp.label('自定义', 'Custom')}</span>}
          </div>
          <div className="dwa-agent-meta">
            {state !== undefined && (
              <span title={state.title ?? activeAgent?.state} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <span className="dwa-dot" style={{ background: state.color }} />
                {state.text}
              </span>
            )}
            {configured && (
              <>
                {state !== undefined && <span className="dwa-agent-meta-separator">·</span>}
                <span>{acp.label(`${String(selectedModelCount)} 个已选模型`, `${String(selectedModelCount)} selected models`)}</span>
              </>
            )}
            {!synthesized && !newCustom && !detected.detected && (
              <span style={{ color: 'var(--ntr-warn)' }} title={detected.description}>
                · {acp.label('未在 PATH 中检测到', 'Not in PATH')}
              </span>
            )}
          </div>
          {errorSummary !== undefined && (
            <div className="dwa-error dwa-mono" style={{ marginTop: 6, wordBreak: 'break-all' }}>{errorSummary}</div>
          )}
        </div>
        <div className="dwa-row-actions">
          {configured && (
            <button type="button" className="dwa-btn dwa-btn-quiet" aria-expanded={open} aria-label={acp.label(`${open ? '收起' : '管理'} ${displayName}`, `${open ? 'Collapse' : 'Manage'} ${displayName}`)} onClick={() => setExpanded(value => !value)}>
              {open ? acp.label('收起', 'Collapse') : acp.label('管理', 'Manage')}
            </button>
          )}
          {activeAgent?.state === 'error' && (
            <button className="dwa-btn" disabled={testing} onClick={() => void handleTest()}>
              {testing ? acp.label('测试中...', 'Testing...') : acp.label('测试', 'Test')}
            </button>
          )}
          {configured && (
            <RowMenu
              acp={acp}
              canStop={activeAgent !== undefined && activeAgent.state !== 'stopped'}
              sessionCount={affectedSessions}
              onStop={() => void acp.stopAgent(detected.id)}
              // The store already surfaced the failure as a notice; swallowing it
              // here only prevents an unhandled rejection.
              onRemove={async () => { await acp.deleteAgent(detected.id).catch(() => { /* notice shown by the store */ }) }}
            />
          )}
        </div>
      </div>

      {/* display-toggled (not conditionally mounted) so an in-progress edit
          survives collapsing the row. */}
      <div className="dwa-agent-body" style={open ? undefined : { display: 'none' }}>
        {stderr.length > 0 && <pre className="dwa-stderr">{stderr.join('\n')}</pre>}
        <nav className="dwa-tabs dwa-detail-tabs" aria-label={acp.label(`${displayName} 配置`, `${displayName} settings`)}>
          {configured && <button type="button" aria-pressed={detailPage === 'models'} onClick={() => setDetailPage('models')}>{acp.label('模型', 'Models')}</button>}
          <button type="button" aria-pressed={detailPage === 'connection'} onClick={() => setDetailPage('connection')}>{acp.label('连接', 'Connection')}</button>
          <button type="button" aria-pressed={detailPage === 'advanced'} onClick={() => setDetailPage('advanced')}>{acp.label('高级', 'Advanced')}</button>
        </nav>
        {configured && (
          <section className="dwa-subsection" hidden={detailPage !== 'models'}>
            <ModelCatalogBlock
              agentId={detected.id}
              detected={detected}
              acp={acp}
              active={active && open && detailPage === 'models'}
              exposed={form.exposed}
              onExposedChange={exposed => patch({ exposed })}
              autoDiscover={form.autoDiscoverModels}
              onAutoDiscoverChange={autoDiscoverModels => patch({ autoDiscoverModels })}
              isDefault={isDefault}
            />
          </section>
        )}
        <section className="dwa-subsection" hidden={detailPage === 'models'}>
          <AgentDetails
            acp={acp}
            advancedOpen={detailPage === 'advanced'}
            dirty={dirty}
            detected={detected}
            form={form}
            patch={patch}
            isConfigured={configured}
            newCustom={newCustom}
            formIncomplete={formIncomplete}
            idValid={idValid}
            idTaken={idTaken}
            idDeleted={idDeleted}
            cwdInvalid={cwdInvalid}
            rootsInvalid={rootsInvalid}
            idleInvalid={idleInvalid}
            mcpInvalid={mcpInvalid}
            saving={saving}
            savedSuccess={savedSuccess}
            saveDeferred={saveDeferred}
            saveNotice={saveNotice}
            saveConfirm={saveConfirm}
            canDefer={saveGateAvailable}
            onSaveCancel={() => {
              setSaveConfirm(undefined)
              setSaveStage(prev => (prev.kind === 'confirming' ? { kind: 'idle' } : prev))
            }}
            onSaveDefer={() => void performSave('defer')}
            onSaveForce={() => void performSave('force')}
            testing={testing}
            testResult={testResult}
            showSaveWarning={showSaveWarning}
            onUseDefault={handleUseDefault}
            onSave={() => void handleSave()}
            onTest={() => void handleTest()}
          />
        </section>
      </div>
    </div>
  )
}

/** Row overflow menu: the dangerous actions, plus an inline confirm for each. */
function RowMenu({
  acp,
  canStop,
  sessionCount,
  onStop,
  onRemove,
}: {
  acp: AcpStore
  canStop: boolean
  /** Sessions a stop or delete would interrupt; shown before confirming. */
  sessionCount: number
  onStop: () => void
  onRemove: () => Promise<void>
}) {
  const [open, setOpen] = useState(false)
  const [confirming, setConfirming] = useState<'stop' | 'remove' | undefined>(undefined)
  const wrap = useRef<HTMLDivElement | null>(null)

  const affected = (): string => acp.label(
    `将影响 ${String(sessionCount)} 个会话。`,
    `${String(sessionCount)} session(s) will be affected.`,
  )

  useEffect(() => {
    if (!open) return
    const onDown = (event: MouseEvent): void => {
      if (wrap.current !== null && event.target instanceof Node && wrap.current.contains(event.target)) return
      setOpen(false)
      setConfirming(undefined)
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      setOpen(false)
      setConfirming(undefined)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const close = (): void => {
    setOpen(false)
    setConfirming(undefined)
  }

  return (
    <div className="dwa-menu-wrap" ref={wrap}>
      <button
        type="button"
        className="dwa-btn"
        aria-haspopup="menu"
        aria-expanded={open}
        title={acp.label('更多操作', 'More actions')}
        onClick={() => {
          setOpen(value => !value)
          setConfirming(undefined)
        }}
      >
        ⋯
      </button>
      {open && (
        <div className="dwa-menu" role="menu">
          {confirming !== undefined ? (
            <div className="dwa-menu-confirm">
              <span className="dwa-hint" style={{ color: 'var(--ntr-warn)' }}>{affected()}</span>
              <button
                type="button"
                className="dwa-btn dwa-btn-danger"
                onClick={() => {
                  close()
                  if (confirming === 'stop') onStop()
                  else void onRemove()
                }}
              >
                {confirming === 'stop'
                  ? acp.label('确认停止？', 'Confirm stop?')
                  : acp.label('确认移除？', 'Confirm remove?')}
              </button>
              <button type="button" className="dwa-btn" onClick={() => setConfirming(undefined)}>
                {acp.label('取消', 'Cancel')}
              </button>
            </div>
          ) : (
            <>
              {canStop && (
                <button
                  type="button"
                  role="menuitem"
                  className="dwa-menu-item"
                  onClick={() => {
                    // Stopping closes live sessions, so a busy agent asks first.
                    // A silent process stops in one click.
                    if (sessionCount > 0) {
                      setConfirming('stop')
                      return
                    }
                    close()
                    onStop()
                  }}
                >
                  {acp.label('停止当前运行实例', 'Stop Running Process')}
                </button>
              )}
              <button
                type="button"
                role="menuitem"
                className="dwa-btn dwa-menu-item dwa-menu-item-danger"
                onClick={() => setConfirming('remove')}
              >
                {acp.label('移除配置', 'Remove')}
              </button>
            </>
          )}
        </div>
      )}
    </div>
  )
}
