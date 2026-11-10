/**
 * Agent definition administration: adding / replacing / deleting the persisted
 * agent registry entries, plus the save gate that decides whether a save may
 * interrupt a running turn.
 *
 * Two duties share the same generation bookkeeping, which is why they live
 * together:
 * - the process-lifetime delete tombstones and the delete / save generations
 *   that let an in-flight save notice a delete or a NEWER save before it
 *   writes;
 * - the save gate lifecycle (`AcpSaveGate`), its `save/*` state machine and
 *   the strict, staged `agents.json` write a save performs.
 *
 * The registry itself (`defsMap`), the bridge table and the process teardown
 * stay in `BridgeManager`: every capability arrives through
 * {@link AgentAdminHost}, so this module never imports `manager.ts` or
 * `bridge.ts`.
 */
import {
  AcpError,
  EventHub,
  agentSaveAction,
} from '../impl.ts'
import type {
  AcpAgentDef,
  ActiveTurnView,
  AgentSaveMode,
  AgentSaveResult,
  AgentTestResult,
  AgentView,
  DetectedAgentInfo,
  SaveGateFlushResult,
  SaveGateStatus,
} from '../protocol.ts'
import { DEFAULT_SAVE_GATE_TIMEOUT_MS } from '../protocol.ts'
import type { AcpSaveGate } from '../save-gate.ts'
import { SaveGateAborted } from '../save-gate.ts'
import { AgentBridge, TEST_EXIT_GRACE_MS } from './agent-bridge.ts'
import { describeError } from './errors.ts'
import { detectHostAgents } from './process.ts'
import { ensureDefaultWorkspace } from './state-paths.ts'
import { classifyTestFailure } from './test-failure.ts'

/**
 * The manager capabilities this service leans on. Every member is a callback
 * or a getter so the service holds no reference to `BridgeManager` itself.
 *
 * Two members are deliberately composite, because the caller must never see a
 * half-applied step:
 * - {@link stopAgent} stops every live bridge AND drops the bare process slot
 *   in one guarded step (a no-op when the agent has no process);
 * - {@link removeDef} drops the definition AND every pointer into it (the
 *   persisted default, the request-path route bindings, the catalog / fork
 *   cache).
 */
export interface AgentAdminHost {
  /** The configured definition, or `undefined` when the registry does not own the id. */
  defOf(agentId: string): AcpAgentDef | undefined
  /** Every configured definition, in registry order (host-agent detection reads it). */
  defs(): AcpAgentDef[]
  /** Commit a definition into the registry (AFTER the strict file write landed). */
  replaceDef(def: AcpAgentDef): void
  /**
   * Remove the definition and every pointer into it: the settings default, the
   * route bindings that named it, and the catalog / fork-capability cache. The
   * order is fixed (definition, settings, routes, catalog) because the state
   * file is written immediately afterwards.
   */
  removeDef(agentId: string): void
  /** Whether any process slot exists for the agent (the save / delete stop guard). */
  hasBridge(agentId: string): boolean
  /**
   * Stop every live bridge of the agent and drop its bare process slot. A
   * no-op when no bridge exists, so a caller may fire it unconditionally.
   */
  stopAgent(agentId: string, persist?: boolean): Promise<void>
  /**
   * Write `agents.json`. `strict` is for a user-awaited save/delete: a failed
   * write throws `persist_failed` instead of staying silent. `staged` lands in
   * the file BEFORE the definition is committed to the registry.
   */
  persistAgents(strict?: boolean, staged?: AcpAgentDef): void
  /** The live ACP turns across every agent (the save gate's subject list). */
  activeTurnViews(): ActiveTurnView[]
  /** The pre-spawn view a save publishes: a throwaway bridge built WITHOUT the live tuning. */
  preSpawnView(def: AcpAgentDef): AgentView
  /** Announce a catalog change; `withStatus` republishes the agent status frame too. */
  publishCatalog(agentId: string, withStatus: boolean): void
  /** Probe the agent's model catalog right after a save. */
  probeAgentModels(agentId: string): Promise<unknown>
  /** The host event stream every notice and status frame is published on. */
  readonly hub: EventHub
}

export class AgentAdminService {
  /**
   * Process-lifetime delete tombstones. `deleteAgent` records the id BEFORE it
   * awaits anything, so a save that is already running can notice the delete
   * after its own await and refuse to write the definition back. The value is
   * the delete generation: `deleteAgent` bumps it every time, and a save only
   * survives when the generation it captured still matches AND no tombstone
   * exists.
   *
   * There is deliberately no "recreate a deleted id" entry point: a same-id
   * re-import would have to remove the tombstone explicitly (and start a fresh
   * generation), which no caller does today. Clearing it on a plain save would
   * reopen exactly the resurrection race this map closes.
   */
  private readonly deletedAgentIds = new Set<string>()
  /** Delete generation per agent id; absent = never deleted in this process. */
  private readonly agentDeleteGenerations = new Map<string, number>()
  /**
   * Save generation per agent id. Every `saveAgent` call that will actually
   * write (direct / defer / force) bumps it BEFORE doing anything. An older
   * save already executing captures its generation at the start and refuses to
   * write once a newer save has bumped it: otherwise the older, slower write
   * could land last and silently replace the definition the user just saved.
   */
  private readonly agentSaveGenerations = new Map<string, number>()
  /** The host-entry save gate; absent in pure bridge tests. */
  private saveGate?: AcpSaveGate

  constructor(private readonly host: AgentAdminHost) {}

  async detectAgents(): Promise<DetectedAgentInfo[]> {
    return detectHostAgents(this.host.defs())
  }

  /**
   * True once `deleteAgent` ran for this id in this process. The tombstone
   * lives for the process lifetime (see `deletedAgentIds`), so a stale save
   * snapshot and a fresh explicit save are both refused.
   */
  isAgentDeleted(agentId: string): boolean {
    return this.deletedAgentIds.has(agentId)
  }

  private agentDeleteGeneration(agentId: string): number {
    return this.agentDeleteGenerations.get(agentId) ?? 0
  }

  private agentSaveGeneration(agentId: string): number {
    return this.agentSaveGenerations.get(agentId) ?? 0
  }

  /** Start a new save generation; returns the number this call owns. */
  private nextAgentSaveGeneration(agentId: string): number {
    const generation = this.agentSaveGeneration(agentId) + 1
    this.agentSaveGenerations.set(agentId, generation)
    return generation
  }

  /**
   * Abort a save whose captured delete/save generation no longer matches, or
   * whose id has a delete tombstone. Runs after every await in `saveAgentNow`,
   * so either a delete or a NEWER save that landed while this one was
   * executing wins over the definition it raced.
   * Throwing {@link SaveGateAborted} makes the gate settle `cancelled` (no
   * failure banner, no retryable entry) instead of `failed`.
   */
  private assertAgentSaveCurrent(agentId: string, saveGeneration: number, deleteGeneration: number): void {
    if (
      !this.isAgentDeleted(agentId)
      && this.agentDeleteGeneration(agentId) === deleteGeneration
      && this.agentSaveGeneration(agentId) === saveGeneration
    ) return
    throw new SaveGateAborted(`acp: agent "${agentId}" was deleted or superseded while its save was in flight`)
  }

  /** Record a delete BEFORE awaiting the stop, so in-flight saves can see it. */
  private tombstoneAgent(agentId: string): void {
    this.deletedAgentIds.add(agentId)
    this.agentDeleteGenerations.set(agentId, this.agentDeleteGeneration(agentId) + 1)
  }

  async saveAgent(def: AcpAgentDef, mode: AgentSaveMode = 'direct'): Promise<AgentSaveResult> {
    // A deleted id never comes back through this entry point. Re-creating one
    // would need an explicit "recreate" gesture that clears the tombstone; no
    // such caller exists today, and a plain save must not reopen the race.
    if (this.isAgentDeleted(def.id)) {
      throw new AcpError('agent_deleted', `acp: agent "${def.id}" was deleted and cannot be saved again`)
    }
    // The host is the single authority for this save: callers that bypass the
    // panel (RPC, scripts) must not interrupt a turn implicitly. Only the two
    // explicit gestures (`defer` / `force`) change that outcome.
    //
    // Order matters: the target's active turns decide whether a force flush is
    // even relevant. Forcing a save on an IDLE agent must not drain unrelated
    // agents' queued writes.
    const label = `agent-save:${def.id}`
    const activeSessions = this.host.activeTurnViews().filter(view => view.agentId === def.id)
    const action = agentSaveAction(activeSessions, mode)
    if (activeSessions.length > 0 && mode === 'force') {
      // This call owns the definition from here on. The bump happens BEFORE
      // the cancel: an older save already executing must see it and abort at
      // its next await rather than land after the new definition.
      const saveGeneration = this.nextAgentSaveGeneration(def.id)
      // ONLY this agent's held snapshot is dropped. The user authorised the
      // interruption from THIS agent's dialog, so the gesture may not spend
      // that authorisation on other agents: their queued writes stay behind
      // the gate and run at the next idle boundary. The global gesture is
      // the separate `save/flush` -> `saveGateFlush()` entry, which still
      // force-flushes every label.
      this.saveGate?.cancel(label)
      return this.saveAgentDirectly(def, saveGeneration)
    }
    if (activeSessions.length > 0) {
      if (action === 'defer' && this.saveGate !== undefined) {
        // The gate supersedes an older queued save of the same label: the old
        // entry would write values this save has already replaced. The
        // generation this entry owns is captured NOW, so a still-executing
        // older save cannot win after this one is queued.
        const saveGeneration = this.nextAgentSaveGeneration(def.id)
        void this.saveGate.defer(label, () => this.saveAgentNow(def, saveGeneration)).then(outcome => {
          if (outcome.status === 'failed') {
            this.host.hub.broadcast({
              type: 'agent/notice',
              agentId: def.id,
              level: 'error',
              text: `acp: deferred agent save failed: ${outcome.message}`,
            })
          } else if (outcome.status === 'expired') {
            this.host.hub.broadcast({
              type: 'agent/notice',
              agentId: def.id,
              level: 'error',
              text: 'acp: deferred agent save expired; save it again',
            })
          }
          // `cancelled` is a silent terminal state: a newer save superseded
          // this entry, or the agent was deleted.
        }, error => {
          this.host.hub.broadcast({
            type: 'agent/notice',
            agentId: def.id,
            level: 'error',
            text: `acp: deferred agent save failed: ${describeError(error)}`,
          })
        })
        return { done: true, deferred: true }
      }
      // A confirm-only gesture never supersedes a running save: no newer
      // definition exists yet. The user's next explicit save does that.
      return { done: false, confirmationRequired: true, activeSessions }
    }
    // Idle target: this save is the current version, so a stale queued entry
    // for the same agent must not flush later and overwrite it. Bump the
    // generation BEFORE the write so an older in-flight save aborts at its
    // next await instead of landing after this definition.
    const saveGeneration = this.nextAgentSaveGeneration(def.id)
    this.saveGate?.cancel(label)
    return this.saveAgentDirectly(def, saveGeneration)
  }

  /**
   * A direct save has no gate entry to settle, so a subject-gone abort becomes
   * a benign `cancelled` RESULT. Rethrowing it here would turn a delete the
   * user just performed into a failed RPC and a failure banner. The deferred
   * path deliberately keeps `saveAgentNow` unwrapped: the gate needs the thrown
   * marker to settle the queued entry `cancelled` without recording an outcome.
   */
  private async saveAgentDirectly(def: AcpAgentDef, saveGeneration: number): Promise<AgentSaveResult> {
    try {
      return await this.saveAgentNow(def, saveGeneration)
    } catch (error) {
      if (error instanceof SaveGateAborted) return { done: true, cancelled: true }
      throw error
    }
  }

  /** The original save body: stop this agent's process, persist, then probe. */
  private async saveAgentNow(def: AcpAgentDef, saveGeneration: number): Promise<AgentSaveResult> {
    // Captured before the first await. A delete bumps the generation and adds
    // the tombstone, and a newer save bumps the save generation, so each check
    // below sees that specific competing gesture.
    const deleteGeneration = this.agentDeleteGeneration(def.id)
    this.assertAgentSaveCurrent(def.id, saveGeneration, deleteGeneration)
    const defaultWorkspace = ensureDefaultWorkspace()
    const resolvedCwd = def.cwd ?? defaultWorkspace
    // Deduplicated on purpose: the panel pre-fills the same path in several
    // fields, and the old fallback also appended `process.cwd()`, which handed
    // the agent the whole launch directory as an allowed root.
    const resolvedRoots = (def.allowedCwdRoots && def.allowedCwdRoots.length > 0)
      ? [...new Set(def.allowedCwdRoots)]
      : [...new Set([resolvedCwd, defaultWorkspace])]

    const resolvedDef: AcpAgentDef = {
      ...def,
      cwd: resolvedCwd,
      allowedCwdRoots: resolvedRoots,
    }

    // The save performs its own strict registry write below, so the stop must
    // not race it with a second best-effort one (`persist: false`). Only an
    // agent that still holds a process slot is stopped: an idle save must not
    // wait on a teardown microtask that never had anything to tear down.
    if (this.host.hasBridge(resolvedDef.id)) {
      await this.host.stopAgent(resolvedDef.id, false)
      // First await cleared: the user may have deleted this agent, or a newer
      // save may have started, while the process was stopping. Abort before
      // touching the registry or the file.
      this.assertAgentSaveCurrent(resolvedDef.id, saveGeneration, deleteGeneration)
    }

    // Second gate immediately before the two writes that make the save
    // observable: either a tombstone or a newer save recorded during any
    // earlier callback wins here.
    this.assertAgentSaveCurrent(resolvedDef.id, saveGeneration, deleteGeneration)
    // Strict + STAGED: the file lands first. `defsMap` only commits after a
    // successful write, so a failed disk write cannot leave memory naming a
    // definition the registry file does not have.
    this.host.persistAgents(true, resolvedDef)
    this.host.replaceDef(resolvedDef)
    this.host.hub.broadcast({
      type: 'agent/status',
      agentId: resolvedDef.id,
      state: 'stopped',
      agent: this.host.preSpawnView(resolvedDef),
    })
    // A save is user-initiated: probe the model catalog immediately so the ACP
    // seats fill in; a failing startup surfaces as a notice.
    void this.host.probeAgentModels(resolvedDef.id).catch((error: unknown) => {
      this.host.hub.broadcast({
        type: 'agent/notice',
        agentId: resolvedDef.id,
        level: 'error',
        text: `acp: model probe failed: ${describeError(error)}`,
      })
    })
    return { done: true }
  }

  /**
   * Lightweight model-visibility update: mutates the def in place (the live
   * bridge shares the same object, so nothing needs restarting), persists, and
   * republishes status. `undefined` clears the filter, which — being the same
   * as `[]` — leaves only the agent's base entry in the ACP seats.
   */
  async setExposedModels(agentId: string, exposedModels: readonly string[] | undefined): Promise<void> {
    const def = this.host.defOf(agentId)
    if (def === undefined) throw new AcpError('unknown_agent', `acp: agent "${agentId}" is not configured`)
    if (exposedModels === undefined) delete def.exposedModels
    else def.exposedModels = [...exposedModels]
    this.host.persistAgents()
    // The aggregate is the agent's state; the view rides along only when a
    // holder exists, exactly as this frame always did (no `error` field here).
    this.host.publishCatalog(agentId, true)
  }

  /**
   * Toggle auto-discovery of newly published models. Lightweight like
   * `setExposedModels`: the def is mutated in place (live bridges share the
   * object) and persisted; no process is restarted, and the current selection
   * is left exactly as it is. On is the default, so only the opt-out
   * (`false`) is written to the file.
   */
  async setAutoDiscoverModels(agentId: string, autoDiscoverModels: boolean): Promise<void> {
    const def = this.host.defOf(agentId)
    if (def === undefined) throw new AcpError('unknown_agent', `acp: agent "${agentId}" is not configured`)
    if (autoDiscoverModels) delete def.autoDiscoverModels
    else def.autoDiscoverModels = false
    this.host.persistAgents()
    this.host.publishCatalog(agentId, false)
  }

  async deleteAgent(agentId: string): Promise<void> {
    // Tombstone FIRST, before any await: a save that is already past its
    // generation check must see the delete when it resumes, and every later
    // save of this id is refused outright.
    this.tombstoneAgent(agentId)
    // Drop the agent's held save BEFORE stopping it: stopping ends its turns,
    // and a deferred snapshot flushing afterwards would write the definition
    // straight back into `agents.json` (the deleted agent would come back).
    this.saveGate?.cancel(`agent-save:${agentId}`)
    if (this.host.hasBridge(agentId)) {
      // This method performs its own strict registry write below.
      await this.host.stopAgent(agentId, false)
    }
    // Definition AND every pointer into it: the persisted default, the route
    // bindings and the catalog / fork cache, in that order.
    this.host.removeDef(agentId)
    // Strict: the delete must not report success when the registry still names
    // the agent. The tombstone and the in-memory deletion stay in place even
    // when this throws, so nothing resurrects it inside this process; the RPC
    // failure tells the user the file needs another attempt.
    this.host.persistAgents(true)
    this.host.hub.broadcast({
      type: 'agent/status',
      agentId,
      state: 'stopped',
    })
  }

  /**
   * Spawn a throwaway agent process from raw form values and run the ACP
   * handshake against it. The bridge is never registered in `defsMap` /
   * `bridges` and broadcasts on a private hub with no sinks, so a test cannot
   * touch persisted config, real sessions, or the browser event stream. The
   * process is torn down in every outcome.
   */
  async testAgent(def: AcpAgentDef): Promise<AgentTestResult> {
    const bridge = new AgentBridge(def, new EventHub(), 50, () => {})
    const startedAt = Date.now()
    try {
      await bridge.ensureReady()
      const info = bridge.initResult?.agentInfo
      return {
        ok: true,
        ...(info
          ? { agentInfo: { name: info.name, title: info.title ?? undefined, version: info.version } }
          : {}),
        durationMs: Date.now() - startedAt,
        stderr: [...bridge.stderrTail],
      }
    } catch (error) {
      // The child's exit may still be in flight when the handshake failure is
      // reported (see `awaitStartChildExit`): give it a bounded moment so the
      // verdict can carry the exit code.
      await bridge.awaitStartChildExit(TEST_EXIT_GRACE_MS)
      // The failure is reported as FACTS, not only as the SDK's sentence: every
      // spawn failure rejects the pending `initialize` with the same
      // "ACP connection closed", which cannot tell "the agent is not installed"
      // from "the launch command is wrong". The browser writes the sentence from
      // `failure`; `error` stays for the raw text.
      const attempt = bridge.startAttempt
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        failure: classifyTestFailure(attempt),
        ...(attempt === undefined
          ? {}
          : {
            command: attempt.command,
            ...(attempt.executablePath === undefined ? {} : { executablePath: attempt.executablePath }),
            installTried: attempt.installTried,
            ...(attempt.spawnError === undefined ? {} : { spawnError: attempt.spawnError }),
            ...(attempt.exit === undefined ? {} : { exit: attempt.exit }),
          }),
        durationMs: Date.now() - startedAt,
        stderr: [...bridge.stderrTail],
      }
    } finally {
      await bridge.stop().catch(() => { /* already torn down by the failure path */ })
    }
  }

  /**
   * Wire the profile-save gate (host entry only). The gate is exposed as the
   * `acpSaveGate` Cordis service so `dsh-settings` / `dsh-hmr` can ask before
   * they write or replace the plugin; absent in pure bridge tests, where the
   * RPC surface answers "always save now".
   */
  setSaveGate(gate?: AcpSaveGate): void {
    this.saveGate = gate
  }

  /** Current gate state; the RPC/SSE surface and the settings page read it. */
  saveGateStatus(): SaveGateStatus {
    return this.saveGate?.status() ?? {
      // No gate wired: this is the same synthetic idle snapshot
      // `emptySaveGateStatus` answers, and it must not claim gate availability.
      gateAvailable: false,
      canSave: true,
      activeTurns: 0,
      activeSessions: [],
      pending: [],
      timeoutMs: DEFAULT_SAVE_GATE_TIMEOUT_MS,
    }
  }

  /**
   * Global explicit "强制保存": execute EVERY queued write now.
   *
   * This is the only caller of {@link AcpSaveGate.forceFlush}. A per-agent
   * `agent/save` with `mode: 'force'` deliberately does NOT come here: that
   * gesture was approved from one agent's dialog and may only drop that
   * agent's own held write.
   */
  async saveGateFlush(): Promise<SaveGateFlushResult> {
    return this.saveGate?.forceFlush() ?? { saved: 0, expired: 0, failed: 0 }
  }

  /** Cancel one label's held write (the settings form's "I kept editing" path). */
  saveGateCancel(label: string): number {
    return this.saveGate?.cancel(label) ?? 0
  }

  /** Re-run a failed/expired held write (the failure banner's retry gesture). */
  saveGateRetry(label: string): boolean {
    return this.saveGate?.retry(label) ?? false
  }

  /** Host query: wait bounded for the ACP plane to become idle. */
  async saveGateWaitIdle(timeoutMs?: number): Promise<boolean> {
    return this.saveGate?.waitForIdle(timeoutMs) ?? true
  }
}
