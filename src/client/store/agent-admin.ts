/**
 * The roster's write path, lifted out of `AcpStore` (split plan P3b): detect,
 * save, test, delete, stop and the plugin-private default agent. Every one of
 * them is a settings-page gesture that ends in an `agent/*` RPC followed by a
 * `resync`, so the roster, the settings cards and the seat surfaces all follow
 * one answer.
 *
 * A save has two failure families and they must not be confused: the host's own
 * gate answer (`confirmationRequired` / `deferred` / `cancelled`) is a normal
 * result the form renders, while a thrown error becomes a page-top banner with
 * the gestures that can still settle it. The rows, their retry payloads and the
 * "a later success retires the older failure" rule all live in
 * {@link SaveBannersService}; this service only decides WHAT happened.
 *
 * The service never imports the facade: the RPC face, the snapshot, the label
 * resolver and the roster refreshes arrive through {@link AgentAdminHost}, and
 * the banner store is a sibling service handed in directly (one-way at
 * runtime: agent-admin → save-banners; a banner retry reaches the save path
 * only through the host's `retryAgentSave`).
 */

import type { AgentSaveMode, AgentSavePayload, AgentSaveResult, AgentTestResult, DetectedAgentInfo } from '../../protocol.ts'
import { DEFAULT_KNOWN_PRESETS } from './presets.ts'
import type { UiState } from './state.ts'
import type { SaveBannersService } from './save-banners.ts'

/** What the agent-admin service needs from the store, injected. */
export interface AgentAdminHost {
  /** The `/acp` RPC face (the store's own `call`, code-preserving errors included). */
  call<T>(endpoint: string, payload?: unknown): Promise<T>
  /** Commit one snapshot patch and notify listeners — the store's single writer. */
  mutate(patch: Partial<UiState>): void
  /** The current snapshot (reads only). */
  state(): UiState
  /** The store's locale-bound label resolver (a stable reference across renders). */
  label(zh: string, en: string): string
  /** Surface an action failure in the settings page's notice line. */
  flashError(error: unknown): void
  /** Re-read the roster and every settings-card snapshot after a write landed. */
  resync(): Promise<void>
  /** Ask the host for one agent's model catalog (the save path refreshes it). */
  probeModels(agentId: string, model?: string): Promise<void>
  /** Drop one agent's cached seat catalog (its model surface just changed). */
  invalidateSeatCatalog(agentId: string): void
}

export class AgentAdminService {
  /** Counts behind the last successful explicit re-detect, so a locale switch can re-render its summary. */
  private detectCounts: { total: number; installed: number } | undefined

  constructor(private readonly host: AgentAdminHost, private readonly banners: SaveBannersService) {}

  async detectAgents(): Promise<void> {
    this.host.mutate({ detecting: true })
    try {
      const result = await this.host.call<{ agents: DetectedAgentInfo[] }>('agents/detect')
      const agents = result.agents.length > 0 ? result.agents : [...DEFAULT_KNOWN_PRESETS]
      const installed = agents.filter(agent => agent.detected).length
      this.detectCounts = { total: agents.length, installed }
      this.host.mutate({
        detectedAgents: agents,
        detecting: false,
        detectSummary: this.detectSummaryOf(agents.length, installed),
      })
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      const notice = msg.includes('unknown endpoint agents/detect')
        ? this.host.label('宿主服务运行着旧版本代码，请在终端重启 dsh web 服务以激活主机检测功能。', 'Host running older version. Please restart dsh web to enable agent detection.')
        : msg
      this.detectCounts = undefined
      this.host.mutate({
        detecting: false,
        notice,
        detectedAgents: this.host.state().detectedAgents.length > 0 ? this.host.state().detectedAgents : [...DEFAULT_KNOWN_PRESETS],
        // A failed re-detect must not keep showing the previous run's success line.
        detectSummary: undefined,
      })
    }
  }

  /**
   * The last explicit re-detect's summary line, rebuilt in the current language
   * (`undefined` → that click never succeeded, or its summary was cleared).
   */
  detectSummary(): string | undefined {
    const counts = this.detectCounts
    return counts === undefined ? undefined : this.detectSummaryOf(counts.total, counts.installed)
  }

  private detectSummaryOf(total: number, installed: number): string {
    return this.host.label(
      `已检测 ${String(total)} 个预设：${String(installed)} 个已安装，其余可从「添加智能体」启用。`,
      `Detected ${String(total)} presets: ${String(installed)} installed, enable the rest via "Add agent".`,
    )
  }

  /**
   * Save one agent definition. `mode` is the user's explicit gesture:
   * `direct` is the no-turn path, `defer` queues behind turns, `force` flushes
   * the gate and interrupts. The host returns `confirmationRequired` when a
   * turn exists and no explicit mode was supplied; the caller must ask.
   */
  async saveAgent(payload: AgentSavePayload, mode: AgentSaveMode = 'direct'): Promise<AgentSaveResult> {
    try {
      const result = await this.host.call<AgentSaveResult>('agent/save', { ...payload, saveMode: mode })
      // A delete won the race: the host aborted silently and wrote nothing.
      // Re-reading the roster or probing the id would chase an agent that no
      // longer exists (and a probe could resurrect its model surface).
      if (result.cancelled === true) return result
      if (result.confirmationRequired || result.deferred) return result
      // This write landed: earlier "not written" receipts for the same agent
      // would now contradict the fresh success. Other agents' rows stay.
      this.banners.clearAgentSaveFailures(payload.id)
      await this.host.resync()
      // The host probes the catalog right after a save; pull the fresh result
      // so the agent card fills in without a second click.
      void this.host.probeModels(payload.id)
      return result
    } catch (error) {
      const code = (error as { code?: string }).code
      if (code === 'agent_deleted') {
        // The id is gone for this host run. Offer no retry/force gesture: both
        // would recreate exactly what the user removed, and the host will keep
        // refusing it until a restart.
        this.rememberDeletedAgent(payload.id)
        const key = `save-failed:${payload.id}`
        this.banners.forgetBannerRetry(key)
        const text = this.host.label(
          '该 Agent 已被删除，本次保存已取消。',
          'This agent was deleted, so this save was cancelled.',
        )
        this.banners.pushSaveBanner({
          key,
          source: 'save-failed',
          level: 'error',
          title: this.host.label('保存已取消', 'Save cancelled'),
          body: text,
          at: Date.now(),
          actions: ['dismiss'],
          label: `agent-save:${payload.id}`,
        })
        this.host.mutate({ notice: text })
        throw error
      }
      const key = code === 'confirmation_required' ? `save-rejected:${payload.id}` : `save-failed:${payload.id}`
      const label = `agent-save:${payload.id}`
      const body = code === 'confirmation_required'
        ? this.host.label(
            '目标 Agent 还有进行中的会话，本轮保存被拒绝。请选择「回合结束后保存」或「立即保存（中断该 Agent）」。',
            'The target agent still has running turns, so the save was refused. Choose "save after turns" or "save now (interrupt this agent)".',
          )
        : this.host.label(
            `配置未写入：${error instanceof Error ? error.message : String(error)}`,
            `The setting was not written: ${error instanceof Error ? error.message : String(error)}`,
          )
      this.banners.setBannerRetry(key, { kind: 'payload', payload })
      this.banners.pushSaveBanner({
        key,
        source: code === 'confirmation_required' ? 'save-rejected' : 'save-failed',
        level: 'error',
        title: code === 'confirmation_required'
          ? this.host.label('保存被拒绝', 'Save refused')
          : this.host.label('保存失败', 'Save failed'),
        body,
        at: Date.now(),
        actions: ['retry', 'force', 'dismiss'],
        label,
      })
      this.host.flashError(error)
      throw error
    }
  }

  /**
   * Dry-run the connection form: the host spawns a throwaway process from
   * these exact values, handshakes, and tears it down. A reachable-but-broken
   * agent arrives as `{ ok: false }`, not a thrown error; only transport or
   * validation failures reject.
   */
  async testAgent(payload: AgentSavePayload): Promise<AgentTestResult> {
    try {
      return await this.host.call<AgentTestResult>('agent/test', payload)
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      const notice = msg.includes('unknown endpoint agent/test')
        ? this.host.label('宿主服务运行着旧版本代码，请在终端重启 dsh web 服务以启用连接测试功能。', 'Host running older version. Please restart dsh web to enable connection testing.')
        : msg
      this.host.mutate({ notice })
      throw error
    }
  }

  async deleteAgent(agentId: string): Promise<void> {
    try {
      await this.host.call('agent/delete', { agentId })
      this.rememberDeletedAgent(agentId)
      await this.host.resync()
      // A retained retry payload would rebuild the agent just deleted. Drop the
      // rows (and their retry entries) after the resync too, so a late status
      // snapshot cannot put them back.
      this.banners.clearAgentSaveBanners(agentId)
      // Nothing should keep offering a deleted agent's models (a conversation
      // that was routed to it falls back to its roster entry).
      this.host.invalidateSeatCatalog(agentId)
    } catch (error) {
      this.host.flashError(error)
      throw error
    }
  }

  async stopAgent(agentId: string): Promise<void> {
    try {
      await this.host.call('agent/stop', { agentId })
      await this.host.resync()
    } catch (error) {
      this.host.flashError(error)
    }
  }

  /**
   * Set the plugin's OWN default ACP agent (the panel's ★ gesture): which agent
   * an ACP-mode conversation starts on. Plugin-private state — the host keeps it
   * in its own agent registry file, and nothing here touches DSH's model
   * selection (see docs/acp-convergence.md §2.2).
   */
  async setDefaultAgent(agentId: string | undefined): Promise<void> {
    try {
      await this.host.call('default/agent-set', { ...(agentId === undefined ? {} : { agentId }) })
      this.host.mutate({ defaultAgent: agentId })
    } catch (error) {
      this.host.flashError(error)
    }
  }

  /**
   * Toggle one agent's `dsh-skills` opt-out (the agent card's checkbox).
   *
   * The card writes through the lightweight `agent/set-skills-mcp` RPC, NEVER
   * `agent/save` — a save stops the child and kills its live sessions, while
   * this flips a field the agent's live bridges read on their next request.
   * Optimistic like every other settings write: the checkbox follows the click,
   * a refused (strict) persist restores the previous answer and flashes the
   * page notice.
   *
   * A success re-reads the roster, like the other lightweight writes: the host
   * stores the opt-out as "key absent", and its answer — not the optimistic
   * guess — is what the checkbox and any later save keep.
   */
  async setAgentSkillsMcp(agentId: string, skillsMcpEnabled: boolean): Promise<void> {
    const previous = this.skillsMcpOf(agentId)
    this.writeSkillsMcp(agentId, skillsMcpEnabled)
    try {
      await this.host.call('agent/set-skills-mcp', { agentId, skillsMcpEnabled })
      await this.host.resync()
    } catch (error) {
      this.writeSkillsMcp(agentId, previous)
      const msg = error instanceof Error ? error.message : String(error)
      this.host.flashError(msg.includes('unknown endpoint agent/set-skills-mcp')
        ? new Error(this.host.label('宿主服务运行着旧版本代码，请在终端重启 dsh web 服务以启用技能开关。', 'Host running older version. Please restart dsh web to enable the skills switch.'))
        : error)
    }
  }

  /**
   * Set (or clear) one agent's default chat mode. Same lightweight contract as
   * `setAgentSkillsMcp`: optimistic roster patch, host RPC, authoritative
   * resync; a refused (strict) persist restores the previous value and flashes
   * the page notice.
   */
  async setAgentDefaultMode(agentId: string, defaultMode?: string): Promise<void> {
    const previous = this.defaultModeOf(agentId)
    this.writeDefaultMode(agentId, defaultMode)
    try {
      // An empty string is the explicit "follow the agent" answer; the host
      // treats it as a clear (`optionalStr` returns undefined).
      await this.host.call('agent/set-default-mode', { agentId, defaultMode: defaultMode ?? '' })
      await this.host.resync()
    } catch (error) {
      this.writeDefaultMode(agentId, previous)
      const msg = error instanceof Error ? error.message : String(error)
      this.host.flashError(msg.includes('unknown endpoint agent/set-default-mode')
        ? new Error(this.host.label('宿主服务运行着旧版本代码，请在终端重启 dsh web 服务以启用默认模式。', 'Host running older version. Please restart dsh web to enable the default mode.'))
        : error)
    }
  }

  /** One agent's raw default mode from the roster copy. */
  private defaultModeOf(agentId: string): string | undefined {
    return this.host.state().detectedAgents.find(info => info.id === agentId)?.currentConfig?.defaultMode
  }

  /** Patch the roster copy of one agent's default mode (absent = follow the agent). */
  private writeDefaultMode(agentId: string, defaultMode: string | undefined): void {
    this.host.mutate({
      detectedAgents: this.host.state().detectedAgents.map(info => {
        if (info.id !== agentId || info.currentConfig === undefined) return info
        const currentConfig = { ...info.currentConfig }
        if (defaultMode === undefined || defaultMode === '') delete currentConfig.defaultMode
        else currentConfig.defaultMode = defaultMode
        return { ...info, currentConfig }
      }),
    })
  }

  /** One agent's per-agent `dsh-skills` answer as the roster copy holds it (`!== false` = offered). */
  private skillsMcpOf(agentId: string): boolean {
    const info = this.host.state().detectedAgents.find(entry => entry.id === agentId)
    return info?.currentConfig?.skillsMcpEnabled !== false
  }

  /** Patch the roster copy of one agent's flag, in the host's own shape (`true` clears the key). */
  private writeSkillsMcp(agentId: string, skillsMcpEnabled: boolean): void {
    this.host.mutate({
      detectedAgents: this.host.state().detectedAgents.map(info =>
        info.id === agentId && info.currentConfig !== undefined
          ? {
              ...info,
              currentConfig: {
                ...info.currentConfig,
                ...(skillsMcpEnabled ? { skillsMcpEnabled: undefined } : { skillsMcpEnabled: false }),
              },
            }
          : info),
    })
  }

  /** Record an id the host deleted during this run (session-only tombstone). */
  private rememberDeletedAgent(agentId: string): void {
    if (agentId === '' || this.host.state().deletedAgentIds.includes(agentId)) return
    this.host.mutate({ deletedAgentIds: [...this.host.state().deletedAgentIds, agentId] })
  }
}
