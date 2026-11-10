/**
 * `agents.json` persistence: where the state file lives, how it is read back
 * (tolerantly, one row at a time) and how it is written (strictly, when a user
 * is waiting on the answer).
 *
 * The file is the meeting point of several clusters — the agent roster, the
 * settings half, the per-conversation picks, the chat sessions and the
 * external-worker records — but none of them belongs here: this service owns
 * the FILE, and every cluster hands its persisted shape in and takes its rows
 * back through {@link PersistenceHost}. That is also why the service never
 * imports the bridge module or the manager itself.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  AcpError,
  Transcript,
  splitAdapterModelId,
  validateAgentDef,
} from '../impl.ts'
import type { EventHub } from '../impl.ts'
import type {
  AcpAgentDef,
  AcpConversationChoice,
  SubagentRecord,
} from '../protocol.ts'
import type { PersistedChatSession } from './types.ts'
import type { PersistedSettings } from './settings-service.ts'
import type { LiveSession } from './turn-stream.ts'
import {
  isPersistedBurst,
  isPersistedModes,
  isPersistedUsage,
} from './shape.ts'
import { describeError } from './errors.ts'
import {
  legacyFallback,
  pluginStateDir,
  rewriteLegacyWorkspaceRoots,
  stateDirExplicit,
} from './state-paths.ts'
import { quoteLegacyCommand } from './process.ts'

/**
 * What the persistence service needs from the bridge manager, injected.
 *
 * The four `*Persisted` readers and their four `apply*` writers are the
 * payload's halves; the roster is passed BY REFERENCE (read + upsert) exactly
 * like the session registry passes its pick map, because the loader rewrites
 * the same `defsMap` the manager routes with.
 */
export interface PersistenceHost {
  /** The host event stream a persist failure is reported on. */
  readonly hub: EventHub
  /** The agent roster itself: the loader upserts, the writer serializes it. */
  defs(): Map<string, AcpAgentDef>
  /** The settings half of the payload (see `SettingsService.persistedSettings`). */
  settingsPersisted(): PersistedSettings
  /** Re-validate and adopt the settings half read from disk. */
  applyPersistedSettings(parsed: Record<string, unknown>): void
  /** The `conversations` half of the payload, or undefined when nothing was ever picked. */
  conversationsPersisted(): Record<string, AcpConversationChoice> | undefined
  /** Adopt the picks read from disk and put each back on the request path. */
  applyPersistedConversations(choices: ReadonlyMap<string, AcpConversationChoice>): void
  /** The `chatSessions` half of the payload (see `SessionRegistryService.persistedRows`). */
  chatSessionsPersisted(): PersistedChatSession[]
  /**
   * Index the recorded sessions as parked and park each on its OWN
   * conversation's holder (A1: one holder per conversation, so the first
   * message after a restart reaches the process that can `session/load` it,
   * not the agent-wide slot).
   */
  applyPersistedChatSessions(sessions: readonly LiveSession[]): void
  /** The `subagents` half of the payload (see `SubagentService.persistedRecords`). */
  subagentsPersisted(): Record<string, SubagentRecord[]>
  /** Adopt the worker records read from disk, dropping orphan conversations. */
  applyPersistedSubagents(raw: unknown): void
}

export class PersistenceService {
  /** Last persist failure already reported, so a hot retry loop cannot spam the log. */
  private lastPersistFailure?: string

  constructor(
    private readonly host: PersistenceHost,
    /** An injected state file path; absent means the plugin's own state dir. */
    private readonly configStoragePath: string | undefined,
    /** Buffer size a restored session's transcript gets. */
    private readonly transcriptMax: number,
  ) {}

  private getStoragePath(): string | undefined {
    if (this.configStoragePath !== undefined) return this.configStoragePath
    if (process.env.DSH_ACP_CONFIG_FILE) return process.env.DSH_ACP_CONFIG_FILE
    // The test-runner guard exists so a suite never reads or writes the real
    // home directory. An explicitly redirected state dir (tests that exercise
    // the migration, or a relocated deployment) is already hermetic, so it is
    // allowed through instead of silently disabling persistence.
    if (!stateDirExplicit() && (process.env.VITEST !== undefined || process.env.NODE_ENV === 'test')) {
      return undefined
    }
    try {
      // A legacy registry that has not been migrated yet stays readable; the
      // next persist writes to the plugin's own state dir and retires it.
      const migrated = join(pluginStateDir(), 'agents.json')
      if (!existsSync(migrated)) {
        const legacy = legacyFallback('agents')
        if (existsSync(legacy)) return legacy
      }
      mkdirSync(pluginStateDir(), { recursive: true })
      return migrated
    } catch {
      return undefined
    }
  }

  /**
   * Read the agent registry file.
   *
   * TWO shapes on purpose: version 1 was a bare array of agent definitions,
   * while `defaultAgentId` (the panel's ★ gesture — the agent an ACP-mode
   * conversation should start on) needs a home that is not the deployment
   * default model. A legacy bare array still loads; it is rewritten in the
   * current shape on the next persist.
   */
  loadPersistedAgents(): void {
    const filePath = this.getStoragePath()
    if (!filePath || !existsSync(filePath)) return
    try {
      const content = readFileSync(filePath, 'utf-8')
      const parsed = JSON.parse(content) as unknown
      const rows = Array.isArray(parsed)
        ? parsed
        : (parsed !== null && typeof parsed === 'object' ? (parsed as { agents?: unknown }).agents : undefined)
      if (Array.isArray(rows)) {
        const defs = this.host.defs()
        let rewritten = false
        for (const item of rows) {
          try {
            // `rewriteLegacyWorkspaceRoots` folds a definition that still names
            // the pre-migration workspace into the plugin's own state dir: the
            // recorded absolute cwd is fed straight to `session/new`, and the
            // cwd resolver rejects one that does not exist.
            const validated = validateAgentDef(quoteLegacyCommand(item))
            const def = rewriteLegacyWorkspaceRoots(validated)
            if (def !== validated) rewritten = true
            defs.set(def.id, def)
          } catch {
            // Ignore invalid entry
          }
        }
        // Write the corrected paths back. Without this the correction lives
        // only in memory: the directory was already renamed, so the file on
        // disk keeps naming a cwd that no longer exists, and every boot has to
        // repair it again (and anything reading the file directly sees the
        // stale path).
        if (rewritten) this.persistAgents()
      }
      if (!Array.isArray(parsed) && parsed !== null && typeof parsed === 'object') {
        // The persisted preferences (default agent, halo, title prefix, approval
        // deadlines, idle release) are the settings service's state; it
        // re-validates them on every boot because the file is user- and
        // version-editable (see `SettingsService.loadPersistedSettings`).
        this.host.applyPersistedSettings(parsed as Record<string, unknown>)
        this.loadPersistedChoices((parsed as { conversations?: unknown }).conversations)
        this.loadPersistedChatSessions((parsed as { chatSessions?: unknown }).chatSessions)
        this.loadPersistedSubagents((parsed as { subagents?: unknown }).subagents)
      }
    } catch {
      // Storage load failure is non-fatal
    }
  }

  /**
   * Read the per-conversation picks back. Tolerant on purpose, one row at a
   * time: a single corrupt entry must not cost the user every other
   * conversation's set-up. Entries are kept even when the named agent is not
   * configured on this boot — `chatChoice` filters those out, so a temporarily
   * missing agent does not erase the choice it was made for.
   */
  private loadPersistedChoices(raw: unknown): void {
    if (raw === null || typeof raw !== 'object') return
    const choices = new Map<string, AcpConversationChoice>()
    for (const [dshSessionId, row] of Object.entries(raw as Record<string, unknown>)) {
      if (dshSessionId === '' || row === null || typeof row !== 'object') continue
      const { agentId, locked, modelId, effort, mode, extraConfigs } = row as {
        agentId?: unknown; locked?: unknown; modelId?: unknown; effort?: unknown; mode?: unknown; extraConfigs?: unknown
      }
      if (typeof agentId !== 'string' || agentId === '') continue
      const configs = extraConfigs !== null && typeof extraConfigs === 'object' && !Array.isArray(extraConfigs)
        ? Object.fromEntries(Object.entries(extraConfigs as Record<string, unknown>)
          .filter(([, value]) => typeof value === 'boolean' || (typeof value === 'string' && value !== ''))) as Record<string, string | boolean>
        : {}
      choices.set(dshSessionId, {
        agentId,
        ...(locked === true ? { locked: true } : {}),
        ...(typeof modelId === 'string' && modelId !== '' ? { modelId } : {}),
        ...(typeof effort === 'string' && effort !== '' ? { effort } : {}),
        ...(typeof mode === 'string' && mode !== '' ? { mode } : {}),
        ...(Object.keys(configs).length === 0 ? {} : { extraConfigs: configs }),
      })
    }
    // The host puts every restored record back on the REQUEST path, not just in
    // its pick map: the guard's rewrite and `conversationRouteModel` read the
    // route registry, which starts empty on a fresh process. Without this a
    // host restart would send a bound (and possibly locked) conversation to the
    // deployment default until its next turn re-pinned it.
    this.host.applyPersistedConversations(choices)
  }

  /**
   * Write the agent registry.
   *
   * `strict` is for a save whose success the user is waiting on: a failed write
   * must reach the save gate as a rejection instead of a silent "saved". All
   * other call sites keep the old best-effort behavior, but the failure is no
   * longer invisible — it lands in the settings log as one notice per distinct
   * error (a burst of session writes can retry the same broken path).
   */
  persistAgents(strict = false, staged?: AcpAgentDef): void {
    const filePath = this.getStoragePath()
    if (!filePath) {
      // A strict save has nowhere to write. Silent success here would tell the
      // user the definition survived when the next boot would not load it.
      if (strict) throw new AcpError('persist_failed', 'acp: failed to persist agent state: no writable state path')
      return
    }
    try {
      // The chat-bound session records themselves: a host restart kills the
      // processes but not the agent-side sessions, so restoring these as
      // PARKED keeps a conversation resumable (`session/load`) instead of
      // its next message silently starting a context-less new one.
      const chatSessions = this.host.chatSessionsPersisted()
      const conversations = this.host.conversationsPersisted()
      const subagentRecords = this.host.subagentsPersisted()
      // A save passes its candidate here so the file can land BEFORE the roster
      // commits it. Every other caller writes the committed registry.
      const agents = [...this.host.defs().values()]
      if (staged !== undefined) {
        const index = agents.findIndex(agent => agent.id === staged.id)
        if (index >= 0) agents[index] = staged
        else agents.push(staged)
      }
      // The settings half of the file (default agent, halo, title prefix,
      // approval deadlines, idle release), in its persisted key order.
      const persistedSettings = this.host.settingsPersisted()
      const payload = {
        version: 2,
        ...(persistedSettings.defaultAgentId === undefined ? {} : { defaultAgentId: persistedSettings.defaultAgentId }),
        tagHalo: persistedSettings.tagHalo,
        sessionTitlePrefix: persistedSettings.sessionTitlePrefix,
        agents,
        // The settings page's approval deadlines. Absent while none was ever
        // written, so a fresh deployment's state file stays exactly as it was.
        ...(persistedSettings.approvalDeadlines === undefined
          ? {}
          : { approvalDeadlines: persistedSettings.approvalDeadlines }),
        // The settings page's idle-release pick. Absent while none was
        // ever written, so a fresh deployment's state file stays as it was.
        ...(persistedSettings.idleRelease === undefined
          ? {}
          : { idleRelease: persistedSettings.idleRelease }),
        // The per-conversation picks: agent + model + thought level + mode +
        // extra config values chosen in the composer, including for
        // conversations with no live session yet.
        ...(conversations === undefined ? {} : { conversations }),
        // The plugin's own external-worker lifecycle records (status / failure
        // reason / timings). Absent while none was ever recorded, so a fresh
        // deployment's state file stays exactly as it was.
        ...(Object.keys(subagentRecords).length === 0
          ? {}
          : { subagents: subagentRecords }),
        ...(chatSessions.length === 0 ? {} : { chatSessions }),
      }
      writeFileSync(filePath, JSON.stringify(payload, null, 2), 'utf-8')
      this.lastPersistFailure = undefined
    } catch (error) {
      const message = describeError(error)
      if (strict) throw new AcpError('persist_failed', `acp: failed to persist agent state: ${message}`)
      if (this.lastPersistFailure === message) return
      this.lastPersistFailure = message
      this.host.hub.broadcast({
        type: 'agent/notice',
        agentId: 'dsh-ntr',
        level: 'error',
        text: `acp: failed to persist agent state: ${message}`,
      })
    }
  }

  /**
   * Restore chat session records from disk as PARKED sessions.
   *
   * Every process died with the host, so nothing comes back live — but the
   * agent-side sessions did not. Restoring each record as `released` is what
   * makes the released banner, its resume button and the "next message
   * resumes it" promise survive a restart (the alternative is the next
   * message quietly starting a NEW, context-less session — constraint 10's
   * "released ≠ destroyed" lost at the process boundary). Tolerant, one row
   * at a time: a single corrupt entry must not cost every other conversation
   * its context. Records whose agent is no longer configured are dropped —
   * there is nothing to resume ON, and the next write omits them.
   */
  private loadPersistedChatSessions(raw: unknown): void {
    if (!Array.isArray(raw)) return
    const defs = this.host.defs()
    const sessions: LiveSession[] = []
    for (const row of raw) {
      if (row === null || typeof row !== 'object') continue
      const record = row as Record<string, unknown>
      const { sessionId, acpSessionId, agentId, dshSessionId, cwd } = record
      if (typeof sessionId !== 'string' || sessionId === '') continue
      if (typeof acpSessionId !== 'string' || acpSessionId === '') continue
      if (typeof agentId !== 'string' || agentId === '') continue
      if (typeof dshSessionId !== 'string' || dshSessionId === '') continue
      if (typeof cwd !== 'string') continue
      if (!defs.has(agentId)) continue
      const { title, modelId, reasoningEffort, modes, usage, burst, hasHistory } = record as {
        title?: unknown; modelId?: unknown; reasoningEffort?: unknown; modes?: unknown; usage?: unknown; burst?: unknown; hasHistory?: unknown
      }
      sessions.push({
        sessionId,
        acpSessionId,
        agentId,
        dshSessionId,
        cwd,
        ...(typeof title === 'string' && title !== '' ? { title } : {}),
        ...(typeof modelId === 'string' && modelId !== ''
          ? { modelId, ...(splitAdapterModelId(modelId).choice === undefined ? {} : { choice: splitAdapterModelId(modelId).choice }) }
          : {}),
        ...(typeof reasoningEffort === 'string' && reasoningEffort !== '' ? { reasoningEffort } : {}),
        ...(isPersistedModes(modes) ? { modes } : {}),
        ...(isPersistedUsage(usage) ? { usage } : {}),
        ...(isPersistedBurst(burst) ? { burst } : {}),
        ...(hasHistory === true ? { hasHistory: true } : {}),
        running: false,
        turnSeq: 0,
        closed: false,
        released: true,
        lastAgentActivityAt: Date.now(),
        activeToolCalls: new Set<string>(),
        transcript: new Transcript(this.transcriptMax),
      })
    }
    this.host.applyPersistedChatSessions(sessions)
  }

  /**
   * Read the persisted external-worker records back.
   *
   * Orphan keys are dropped AT LOAD, not on every write: only a conversation
   * that still has a `chatSessions` row or a persisted `conversations` entry
   * can own records. Everything else names a conversation the file no longer
   * describes (deleted, or written before a pruning close), and keeping it
   * would only make `agents.json` grow. Shutdown relies on the map staying
   * populated, which is why the prune lives here and not in `persistAgents`.
   *
   * A restored row that never reached a terminal state reads `unknown`: the
   * host restart killed every process, so nothing can still be running
   * (constraint: no row stays `running` forever).
   */
  private loadPersistedSubagents(raw: unknown): void {
    this.host.applyPersistedSubagents(raw)
  }
}
