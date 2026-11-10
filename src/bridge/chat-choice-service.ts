/**
 * Chat choice: one conversation's bottom-bar selection (agent + model +
 * thought level + mode + extra config values), the request-path route pin it
 * rides on, and the cached ACP-mode verdict the composer seats read.
 *
 * Lifted out of `BridgeManager` as ONE cluster for a simple reason: every
 * member is the same contract — "remember what the user last chose here, make
 * the next turn run it, and never silently run something else". `patchChatChoice`
 * is the single write path (see constraint 27 in AGENTS.md), `applyChatChoice`
 * re-applies the record on both session creation paths, and
 * `syncConversationRoute` publishes the model half onto the guard's binding.
 * Splitting them would let one axis drift again, which is exactly how `mode`
 * once reset on every restart.
 *
 * The service never imports the manager: the live sessions, the bridges, the
 * roster predicate, the catalog reads and the state-file write arrive through
 * {@link ChatChoiceHost}. The persisted pick map itself is owned by the
 * session registry (it is written with `agents.json` and read by the lock
 * helpers), so it is passed BY REFERENCE, not copied.
 */
import type { EventHub } from '../impl.ts'
import {
  AcpError,
  buildAdapterModelId,
  hasUnambiguousModelSelector,
  parseCatalogOptions,
  splitAdapterModelId,
  usableConfigOptions,
} from '../impl.ts'
import type {
  AcpAgentCatalog,
  AcpAgentDef,
  AcpConversationChoice,
  LlmModelReasoningInfo,
} from '../protocol.ts'
import type { AcpModeResolver, DisplayedChatDefaults } from './types.ts'
import { routeBindingRegistry } from './registries.ts'
import type { LiveSession } from './turn-stream.ts'
import { describeError } from './errors.ts'

/**
 * The one bridge shape this service writes through. `AgentBridge` satisfies it
 * structurally, so the service needs no import of the bridge implementation.
 */
export interface ChatChoiceBridge {
  setMode(session: LiveSession, modeId: string): Promise<void>
  setConfigOption(session: LiveSession, configId: string, value: string | boolean): Promise<void>
}

/** What the chat-choice service needs from the bridge manager, injected. */
export interface ChatChoiceHost {
  /** The host event stream every warning notice is announced on. */
  readonly hub: EventHub
  /** The configured definition, or `undefined` when the roster does not own the id. */
  defOf(agentId: string): AcpAgentDef | undefined
  /** The agent's last-known catalog (the composer's displayed defaults). */
  catalogFor(agentId: string): AcpAgentCatalog | undefined
  /** The agent's reasoning metadata (its MATERIALIZED default effort). */
  reasoningMeta(agentId: string): LlmModelReasoningInfo | undefined
  /** Every live / parked ACP session the manager holds, in map order. */
  sessions(): Iterable<LiveSession>
  /** The process holding one session (never an agent-wide guess; see A1). */
  bridgeForSession(session: LiveSession): ChatChoiceBridge
  /** The agent a conversation was last pointed at, when one is known. */
  chatAgentFor(dshSessionId: string): string | undefined
  /** The agent a conversation is locked to, when its first turn has run. */
  lockedAgentFor(dshSessionId: string): string | undefined
  /** Rewrite `agents.json` after a pick changed. */
  persistAgents(): void
}

export class ChatChoiceService {
  private acpModeResolver?: AcpModeResolver
  /** Cached `chatSessionAcpMode` answers, keyed by DSH chat session id. */
  private readonly acpModeCache = new Map<string, boolean>()
  /** In-flight cold reads behind `chatSessionAcpModeAnswer`, keyed by session id. */
  private readonly acpModeInflight = new Map<string, Promise<boolean | undefined>>()

  /**
   * @param host Manager capabilities, all callbacks (never the manager itself).
   * @param picks The persisted pick map, owned by the session registry (see
   *   the file header) — written here through `patchChatChoice`, read by the
   *   lock helpers and serialized with `agents.json` by the registry.
   */
  constructor(
    private readonly host: ChatChoiceHost,
    private readonly picks: Map<string, AcpConversationChoice>,
  ) {}

  /** Wire (or clear) the host's ACP-preset probe. */
  setAcpModeResolver(resolver?: AcpModeResolver): void {
    this.acpModeResolver = resolver
  }

  /**
   * Whether ONE DSH chat session runs the ACP agent preset, asked by chat
   * session id. The browser's composer surfaces consume this: on hosts whose
   * client runtime does not carry `agentPreset` on the session-list row (their
   * preferred fact source), this is the only way to know which conversation is
   * an ACP one.
   *
   * The resolver may await a persistence read (a cold session has to be read
   * from disk), so answers are CACHED per session id and served synchronously:
   * the first ask returns `false` while the read is in flight and the caller
   * re-asks on the next tick — a one-turn delay, never a wrong verdict.
   * A cached verdict is dropped when the session's log moves (preset switch,
   * new turn), so a stale answer cannot outlive the fact it was folded from.
   */
  chatSessionAcpMode(dshSessionId: string): boolean {
    const cached = this.acpModeCache.get(dshSessionId)
    if (cached !== undefined) return cached
    const resolver = this.acpModeResolver
    if (resolver === undefined) return false
    try {
      const answered = resolver(dshSessionId)
      if (answered instanceof Promise) {
        // Prime the cache from the settled read; the synchronous asker still
        // got `false` this round (see `chatSessionAcpModeAnswer` for the
        // awaitable form the RPC serves instead).
        void answered.then(verdict => {
          if (verdict !== undefined) this.acpModeCache.set(dshSessionId, verdict === true)
        }).catch(() => { /* retry on the next ask */ })
        return false
      }
      if (answered !== undefined) this.acpModeCache.set(dshSessionId, answered === true)
      return answered === true
    } catch {
      // Never guess from a failed lookup: the browser's fallback then reads
      // "not ACP", which keeps the native seat — the allowed failure mode.
      return false
    }
  }

  /**
   * The awaitable form of `chatSessionAcpMode`, served by the `session/chat-list`
   * RPC: the first ask WAITS for the cold read instead of answering early, so
   * the browser's one-shot fallback sees the settled verdict immediately —
   * a synchronous first answer of `false` would be remembered by the gate and
   * the seat would never take over. Concurrent asks for the same session share
   * one read (in-flight dedup); a failed lookup returns `false` for that ask
   * but is NOT cached, so the next ask retries.
   */
  async chatSessionAcpModeAnswer(dshSessionId: string): Promise<boolean> {
    const cached = this.acpModeCache.get(dshSessionId)
    if (cached !== undefined) return cached
    const resolver = this.acpModeResolver
    if (resolver === undefined) return false
    let inflight = this.acpModeInflight.get(dshSessionId)
    if (inflight === undefined) {
      inflight = (async () => {
        try {
          return await resolver(dshSessionId)
        } catch {
          return undefined
        } finally {
          this.acpModeInflight.delete(dshSessionId)
        }
      })()
      this.acpModeInflight.set(dshSessionId, inflight)
    }
    const verdict = await inflight
    if (verdict !== undefined) {
      this.acpModeCache.set(dshSessionId, verdict === true)
      return verdict === true
    }
    return false
  }

  /** Drop cached ACP-mode verdicts: one session's, or all of them. */
  invalidateAcpMode(dshSessionId?: string): void {
    if (dshSessionId === undefined) {
      this.acpModeCache.clear()
      return
    }
    this.acpModeCache.delete(dshSessionId)
  }

  /**
   * The raw per-turn re-read the turn path performs (it must not serve a
   * cached verdict: a preset switch made mid-conversation lands on the next
   * prompt). Absent resolver → `undefined`, which the caller reads as "not
   * ACP". Never cached: the caller invalidates explicitly.
   */
  resolveAcpMode(dshSessionId: string): boolean | undefined | Promise<boolean | undefined> {
    return this.acpModeResolver?.(dshSessionId)
  }

  /**
   * The conversation's persisted pick (agent + model + thought level). This is
   * the record that survives a host restart and is readable BEFORE the
   * conversation has ever run a turn — the composer shows it, and the turn path
   * applies it to a freshly created or resumed session.
   */
  chatChoice(dshSessionId: string): AcpConversationChoice | undefined {
    const recorded = this.picks.get(dshSessionId)
    if (recorded === undefined) return undefined
    if (this.host.defOf(recorded.agentId) === undefined) return undefined
    return { ...recorded }
  }

  /**
   * Publish one conversation's pick onto the request-path binding.
   *
   * The guard's model selection (and its legacy `agent/request` rewrite) and
   * this class's own turn admission read
   * `routeBindingRegistry().conversations`, whose values are adapter model ids.
   * The MODEL half of the pick therefore rides there, so a turn that starts
   * with `agentId` alone does not silently drop a variant chosen up front; with
   * no model picked the binding is the bare agent id (the agent's default).
   *
   * Only ever WRITES: a conversation with no recorded pick keeps whatever the
   * turn path pinned to it (the agent that actually served its last turn), which
   * is the honest answer for a session whose intent map was never seeded.
   */
  syncConversationRoute(dshSessionId: string): void {
    const choice = this.picks.get(dshSessionId)
    if (choice === undefined || this.host.defOf(choice.agentId) === undefined) return
    routeBindingRegistry().conversations.set(dshSessionId, choice.modelId ?? choice.agentId)
  }

  /**
   * The adapter model string one chat conversation's next turn runs on — the
   * request-path binding, when it names a CONFIGURED agent. `undefined` leaves
   * the turn on whatever route the driver resolved (the allowed failure: the
   * harness default plays out).
   */
  conversationRouteModel(dshSessionId: string): string | undefined {
    const model = routeBindingRegistry().conversations.get(dshSessionId)
    if (model === undefined || model === '') return undefined
    return this.host.defOf(splitAdapterModelId(model).agentId) === undefined ? undefined : model
  }

  /**
   * The agent's own default thought level — the effort the driver MATERIALIZES
   * into a request that did not ask for one (`resolveCallWithInfo` fills
   * `reasoning.defaultEffort` in and marks it adapter-defaulted). Re-applying
   * that as a per-turn choice would revert a pick the user just made through
   * the seat, so the turn path treats it as "no effort requested".
   */
  modelDefaultEffort(agentId: string): string | undefined {
    return this.host.reasoningMeta(agentId)?.defaultEffort
  }

  /**
   * Record one field of a conversation's pick and persist it.
   *
   * Every bottom-bar control (agent, model, thought level, the agent's own mode,
   * the advanced base's extra config values) is one field of the SAME record,
   * and the setters used to spell the record
   * out by hand each time — which is exactly how `mode` ended up as the one
   * control that reset on every restart: no setter wrote it. Patch through here
   * so a new axis cannot be half-wired.
   *
   * `undefined` CLEARS the field (the "follow the agent's default" choice).
   */
  patchChatChoice(
    dshSessionId: string,
    patch: Partial<AcpConversationChoice>,
  ): void {
    const current = this.picks.get(dshSessionId)
    const agentId = patch.agentId ?? current?.agentId ?? this.host.chatAgentFor(dshSessionId)
    if (agentId === undefined) return
    // A patch that names a DIFFERENT agent starts from a clean record: the
    // other fields are the previous agent's vocabulary and must not survive.
    const base = patch.agentId !== undefined && patch.agentId !== current?.agentId ? {} : current
    const next: AcpConversationChoice = { ...base, ...patch, agentId }
    if (next.locked !== true) delete next.locked
    if (next.modelId === undefined) delete next.modelId
    if (next.effort === undefined) delete next.effort
    if (next.mode === undefined) delete next.mode
    if (next.extraConfigs === undefined || Object.keys(next.extraConfigs).length === 0) delete next.extraConfigs
    this.picks.set(dshSessionId, next)
    this.host.persistAgents()
    this.syncConversationRoute(dshSessionId)
  }

  /** Switch the bound agent's model for one chat session (`agentId@choice`). */
  async setChatSessionModel(dshSessionId: string, modelId: string): Promise<void> {
    const { agentId, choice } = splitAdapterModelId(modelId)
    const def = this.host.defOf(agentId)
    if (def === undefined) {
      throw new AcpError('unknown_agent', `acp: agent "${agentId}" is not configured`)
    }
    // A model id names its agent, so this call can also be an agent switch.
    // Once locked, only the locked agent's models are accepted.
    const lockedTo = this.host.lockedAgentFor(dshSessionId)
    if (lockedTo !== undefined && lockedTo !== agentId) {
      throw new AcpError('agent_locked', `acp: conversation is locked to agent "${lockedTo}" once its first turn has started`)
    }
    // A model the live session's agent no longer lists is refused HERE too:
    // recording it would look like a successful switch while the next send is
    // doomed to `model_unavailable`. Before a session exists there is nothing
    // authoritative to validate against — the send-time gate covers it.
    for (const session of this.host.sessions()) {
      if (session.dshSessionId !== dshSessionId || session.agentId !== agentId || session.released) continue
      const stale = choice === undefined ? undefined : this.staleModelChoice(session, choice)
      if (stale !== undefined) {
        throw new AcpError('model_unavailable', `acp: agent "${agentId}" no longer offers model "${stale}"`)
      }
    }
    // A thought level is not a property of the agent alone: opencode publishes
    // `thought_level` only for models with variants, so the previous model's
    // level is not the new model's vocabulary. A LIVE session can judge the old
    // pick against the new model's own option set (`alignSessionConfig`, which
    // drops it with a notice when the set no longer offers it). Before the first
    // session there is no such authority — the catalog still describes the model
    // the agent was last on — so the level is cleared instead of being displayed
    // as this model's own until the first message.
    const previous = this.picks.get(dshSessionId)
    const nextModelId = choice === undefined ? undefined : modelId
    const modelChanged = previous?.agentId === agentId && previous.modelId !== nextModelId
    const hasLiveSession = [...this.host.sessions()].some(session =>
      session.dshSessionId === dshSessionId && session.agentId === agentId && !session.released)
    const clearEffort = modelChanged && !hasLiveSession
    // The pick is recorded even when NO live session exists yet — that is the
    // "choose the model before the first message" case. A session that
    // materializes later reads it back (`applyChatChoice`).
    this.patchChatChoice(dshSessionId, {
      agentId,
      modelId: nextModelId,
      ...(clearEffort ? { effort: undefined } : {}),
    })
    for (const session of this.host.sessions()) {
      if (session.dshSessionId !== dshSessionId || session.agentId !== agentId) continue
      session.choice = choice
      // A row can carry a level without a recorded pick (`streamPrompt` mirrors
      // the turn's effort onto the session). Clear it on the same evidence as
      // the pick — the row's own model changed and nothing live can re-validate
      // it — or the released row keeps naming the old level.
      const rowModelChanged = session.modelId !== modelId
      session.modelId = modelId
      // The chip reads this mirror through `session/chat-list`; clearing only
      // the pick would leave a parked row naming the old level.
      if (clearEffort || (rowModelChanged && !hasLiveSession)) session.reasoningEffort = undefined
      if (session.released) continue
      const aligned = await this.alignSessionConfig(session, choice, session.reasoningEffort)
      if (aligned.effortStale) session.reasoningEffort = undefined
    }
    this.host.persistAgents()
  }

  /**
   * Switch the reasoning effort for one chat session.
   *
   * `agentId` names the agent that serves a conversation nobody has bound —
   * the plugin default the guard's route rewrite falls back to. The browser
   * knows it (its composer chip is built from the same route), and without it
   * `chatAgentFor` answers undefined before the first session exists, so the
   * pick would be silently dropped.
   */
  async setChatSessionEffort(dshSessionId: string, effort: string | undefined, agentId?: string): Promise<void> {
    if (agentId !== undefined) {
      if (this.host.defOf(agentId) === undefined) {
        throw new AcpError('unknown_agent', `acp: agent "${agentId}" is not configured`)
      }
      const lockedTo = this.host.lockedAgentFor(dshSessionId)
      if (lockedTo !== undefined && lockedTo !== agentId) {
        throw new AcpError('agent_locked', `acp: conversation is locked to agent "${lockedTo}" once its first turn has started`)
      }
    }
    // Recorded before any session exists (see `setChatSessionModel`); a released
    // session is skipped here and re-aligned by `applyChatChoice` on resume.
    this.patchChatChoice(dshSessionId, { ...(agentId === undefined ? {} : { agentId }), effort })
    for (const session of this.host.sessions()) {
      if (session.dshSessionId !== dshSessionId) continue
      if (agentId !== undefined && session.agentId !== agentId) continue
      session.reasoningEffort = effort
      if (session.released) continue
      const aligned = await this.alignSessionConfig(session, session.choice, effort)
      // Same rule as the model axis: a dropped level is no longer "in force".
      session.reasoningEffort = aligned.effortStale ? undefined : effort
    }
    this.host.persistAgents()
  }

  /**
   * Set one of the agent's EXTRA config options for one chat session (the
   * composer's advanced base). The value is validated against what the agent
   * actually publishes — the live session's own options first, the cached
   * catalog second — and recorded even when no session exists yet, so the pick
   * applies when the first turn materializes one (`applyChatChoice`).
   *
   * A live session is updated immediately; a failure there is warned about and
   * the pick still stands, exactly like the model/effort alignment path.
   */
  async setChatSessionConfig(dshSessionId: string, configId: string, value: string | boolean, agentId?: string): Promise<void> {
    // `agentId` is the route the composer showed — including the plugin
    // default, which `chatAgentFor` cannot report before the first session.
    const bound = agentId ?? this.host.chatAgentFor(dshSessionId)
    if (bound === undefined) {
      throw new AcpError('unknown_session', `acp: no ACP agent is bound to chat session ${dshSessionId}`)
    }
    if (this.host.defOf(bound) === undefined) {
      throw new AcpError('unknown_agent', `acp: agent "${bound}" is not configured`)
    }
    const lockedTo = this.host.lockedAgentFor(dshSessionId)
    if (lockedTo !== undefined && lockedTo !== bound) {
      throw new AcpError('agent_locked', `acp: conversation is locked to agent "${lockedTo}" once its first turn has started`)
    }
    const live = [...this.host.sessions()].find(session =>
      session.dshSessionId === dshSessionId && session.agentId === bound && !session.released)
    const observed = live === undefined
      ? undefined
      : parseCatalogOptions(live.configOptions).extras?.find(option => option.configId === configId)
    const advertised = this.host.catalogFor(bound)?.extras?.find(option => option.configId === configId)
    const option = observed ?? advertised
    if (option === undefined) {
      throw new AcpError('unknown_config', `acp: agent "${bound}" publishes no extra config option "${configId}"`)
    }
    if (option.kind === 'boolean') {
      // The browser sends 'true' / 'false' from a checkbox row; the wire and
      // the persisted pick both use the real boolean.
      const toggle = typeof value === 'boolean'
        ? value
        : value === 'true' ? true : value === 'false' ? false : undefined
      if (toggle === undefined) {
        throw new AcpError('bad_config', `acp: "${String(value)}" is not a boolean value of config option "${configId}"`)
      }
      value = toggle
    } else if (typeof value !== 'string' || !option.choices.some(choice => choice.value === value)) {
      throw new AcpError('bad_config', `acp: "${String(value)}" is not a value of config option "${configId}"`)
    }
    const current = this.picks.get(dshSessionId)
    const extraConfigs = current?.agentId === bound ? { ...current.extraConfigs } : {}
    this.patchChatChoice(dshSessionId, { agentId: bound, extraConfigs: { ...extraConfigs, [configId]: value } })
    for (const session of this.host.sessions()) {
      if (session.dshSessionId !== dshSessionId || session.agentId !== bound || session.released) continue
      try {
        await this.host.bridgeForSession(session).setConfigOption(session, configId, value)
      } catch (error) {
        this.host.hub.broadcast({
          type: 'agent/notice',
          agentId: bound,
          level: 'error',
          text: `acp: failed to set config "${configId}" to "${value}": ${describeError(error)}`,
        })
      }
    }
  }

  /**
   * Apply a conversation's persisted pick to a session that just materialized —
   * created by the first turn, or resumed through `session/load` after a crash.
   *
   * This is what makes an up-front choice real rather than decorative: the
   * session/new and session/load answers come back with the AGENT's defaults,
   * which would otherwise run the first message on a model the user already
   * replaced. Best effort, exactly like the turn path's alignment: a stale
   * model is not applied (and NOT dropped — `streamPrompt` refuses to run a
   * turn on an unknown model until the user reselects), a stale thought level
   * is dropped with a notice, and the agent's own configuration is used in the
   * meantime. Never turned into a different model than the one selected.
   */
  async applyChatChoice(session: LiveSession): Promise<void> {
    const dshSessionId = session.dshSessionId
    if (dshSessionId === undefined) return
    const choice = this.picks.get(dshSessionId)
    if (choice === undefined || choice.agentId !== session.agentId) return
    const { choice: modelChoice } = splitAdapterModelId(choice.modelId ?? '')
    const aligned = await this.alignSessionConfig(session, modelChoice, choice.effort)
    // Mirror the pick onto the session so `session/chat-list` reports the
    // conversation's selection. A stale model stays mirrored on purpose: the
    // chip must keep naming what the user chose, and the next send refuses
    // with a message pointing at it.
    if (choice.modelId !== undefined) {
      session.modelId = choice.modelId
      session.choice = modelChoice
    }
    if (choice.effort !== undefined) {
      session.reasoningEffort = aligned.effortStale ? undefined : choice.effort
    }
    // The agent's own mode is the third control in the same composer bar, so it
    // follows the same contract: a mode the agent no longer declares is skipped
    // (warning, not a failed turn) — `session/new` and `session/load` both come
    // back on whatever the agent starts with.
    if (choice.mode !== undefined) {
      const offered = session.modes?.availableModes ?? []
      if (offered.length === 0 || offered.some(mode => mode.id === choice.mode)) {
        try {
          await this.host.bridgeForSession(session).setMode(session, choice.mode)
        } catch (error) {
          this.host.hub.broadcast({
            type: 'agent/notice',
            agentId: session.agentId,
            level: 'error',
            text: `acp: failed to restore mode "${choice.mode}": ${describeError(error)}`,
          })
        }
      } else {
        this.host.hub.broadcast({
          type: 'agent/notice',
          agentId: session.agentId,
          level: 'error',
          text: `acp: agent "${session.agentId}" no longer offers mode "${choice.mode}"; keeping its own`,
        })
      }
    }
    // The advanced base's picks follow the same contract: apply what the agent
    // still offers, warn and skip what it dropped, never fail the turn.
    if (choice.extraConfigs !== undefined) {
      const extras = parseCatalogOptions(session.configOptions).extras ?? []
      for (const [configId, value] of Object.entries(choice.extraConfigs)) {
        const option = extras.find(entry => entry.configId === configId)
        if (option === undefined) {
          this.host.hub.broadcast({
            type: 'agent/notice',
            agentId: session.agentId,
            level: 'error',
            text: `acp: agent "${session.agentId}" no longer offers config "${configId}"; keeping its own`,
          })
          continue
        }
        // A toggle's truth is its boolean itself; a select's is membership in
        // the choices the agent still offers.
        const usable = option.kind === 'boolean'
          ? typeof value === 'boolean'
          : typeof value === 'string' && option.choices.some(entry => entry.value === value)
        if (!usable) {
          this.host.hub.broadcast({
            type: 'agent/notice',
            agentId: session.agentId,
            level: 'error',
            text: `acp: agent "${session.agentId}" no longer offers "${String(value)}" for config "${configId}"; keeping its own`,
          })
          continue
        }
        try {
          await this.host.bridgeForSession(session).setConfigOption(session, configId, value)
        } catch (error) {
          this.host.hub.broadcast({
            type: 'agent/notice',
            agentId: session.agentId,
            level: 'error',
            text: `acp: failed to restore config "${configId}" to "${value}": ${describeError(error)}`,
          })
        }
      }
    }
  }

  /**
   * Switch one chat-bound session's ACP mode.
   *
   * A released session is deliberately NOT resumed for it (user decision,
   * 2026-10-30 — the composer's axes are "what the next turn should use", and
   * the process comes back only when the user sends a message or hits the
   * released banner's resume button). The pick is recorded and
   * `applyChatChoice` applies it on resume, exactly like `setChatSessionModel`
   * / `setChatSessionEffort` / `setChatSessionConfig`; only a LIVE session is
   * told immediately (`session/set_mode`).
   */
  async setChatSessionMode(dshSessionId: string, modeId: string, agentId?: string): Promise<void> {
    if (agentId !== undefined) {
      const lockedTo = this.host.lockedAgentFor(dshSessionId)
      if (lockedTo !== undefined && lockedTo !== agentId) {
        throw new AcpError('agent_locked', `acp: conversation is locked to agent "${lockedTo}" once its first turn has started`)
      }
    }
    const candidates = [...this.host.sessions()].filter(session => session.dshSessionId === dshSessionId)
    const target = agentId === undefined
      ? (candidates.find(session => !session.released) ?? candidates[0])
      : candidates.find(session => session.agentId === agentId)
    // No live session yet: this is the "choose the mode before the first
    // message" case, and the pick is recorded WITHOUT spawning anything — the
    // session that materializes later reads it back (`applyChatChoice`). This
    // matches `setChatSessionModel`, which has always recorded ahead of a
    // session; refusing here was what made the mode control unusable on a
    // conversation still being set up.
    if (target === undefined) {
      const bound = agentId ?? this.host.chatAgentFor(dshSessionId)
      if (bound === undefined || this.host.defOf(bound) === undefined) {
        throw new AcpError('unknown_session', `acp: no live ACP session is bound to chat session ${dshSessionId}`)
      }
      this.patchChatChoice(dshSessionId, { agentId: bound, mode: modeId })
      return
    }
    if (target.closed) {
      throw new AcpError('unknown_session', `acp: the ACP session bound to chat session ${dshSessionId} is closed`)
    }
    // A PARKED session gets the same record-only treatment (its agent is its
    // own `agentId`, whatever the caller passed — the selection above already
    // matched it). Resuming here was the one composer axis that broke ranks
    // with the others, and it woke a process the user had explicitly parked.
    if (target.released) {
      this.patchChatChoice(dshSessionId, { agentId: target.agentId, mode: modeId })
      if (target.modes !== undefined) {
        target.modes = { ...target.modes, currentModeId: modeId }
      }
      this.host.persistAgents()
      return
    }
    const bridge = this.host.bridgeForSession(target)
    await bridge.setMode(target, modeId)
    // Persisted only AFTER the agent accepted it: a mode the agent rejected must
    // not come back on the next restore. This is the same contract the model and
    // thought level follow (user decision, 2026-10-18 — every control in the
    // bottom bar remembers its last choice, not just the thought level).
    this.patchChatChoice(dshSessionId, { agentId: target.agentId, mode: modeId })
  }

  /**
   * Bring one session's model / thought-level mirrors in line with a requested
   * pair, best effort. Shared by the setters, `applyChatChoice` and the turn
   * path so all three judge staleness the same way. Reports which half could
   * not be applied; the caller decides what to mirror.
   */
  async alignSessionConfig(
    session: LiveSession,
    modelChoice: string | undefined,
    effort: string | undefined,
  ): Promise<{ modelStale: boolean; effortStale: boolean }> {
    const wantedModel = modelChoice !== undefined && modelChoice !== '' ? modelChoice : undefined
    const wantedEffort = effort !== undefined && effort !== '' ? effort : undefined
    const result = { modelStale: false, effortStale: false }
    if (wantedModel === undefined && wantedEffort === undefined) return result
    let catalog = parseCatalogOptions(session.configOptions)
    // The session's OWN process: A1 gives one agent several children, and a
    // config write must reach the one holding this session, never the agent-wide
    // slot (which may not even be running).
    const bridge = this.host.bridgeForSession(session)
    const notice = (level: 'info' | 'error', text: string): void => {
      this.host.hub.broadcast({ type: 'agent/notice', agentId: session.agentId, level, text })
    }
    if (wantedModel !== undefined) {
      const model = catalog.model
      if (model === undefined) {
        notice('error', `acp: agent "${session.agentId}" exposes no model selector; ignoring model "${wantedModel}"`)
      } else if (model.currentValue === wantedModel) {
        // Already in force: nothing to do.
      } else if (model.choices.length > 0 && !model.choices.some(choice => choice.value === wantedModel)) {
        // Do NOT drop the pick or fall back here: the caller refuses the turn
        // (see `staleModelChoice`), so the conversation can never silently run
        // a model the user did not choose.
        result.modelStale = true
      } else {
        try {
          await bridge.setConfigOption(session, model.configId, wantedModel)
          // The answer carries the NEW model's option set (the bridge has
          // already folded it into `session.configOptions`). Whether a thought
          // level still exists is a property of THAT set — opencode publishes
          // one only for models with variants — so the effort below must be
          // judged against it, not against the model the user just left.
          catalog = parseCatalogOptions(session.configOptions)
        } catch (error) {
          notice('error', `acp: failed to switch model to "${wantedModel}": ${describeError(error)}`)
        }
      }
    }
    if (wantedEffort !== undefined) {
      const thought = catalog.thought
      if (thought === undefined) {
        // A real answer without the slot means this session's model publishes no
        // level axis at all (opencode does so only for models with variants), so
        // the pick is unappliable and must leave the record — otherwise the chip
        // keeps naming a value this model does not offer. An empty/absent option
        // set is NOT such an answer (agents answer `[]` mid-reset); that keeps
        // the pick for a later session.
        if (usableConfigOptions(session.configOptions)) {
          result.effortStale = true
          if (this.dropStalePick(session, 'effort', wantedEffort)) {
            notice('error', `acp: agent "${session.agentId}" no longer offers thought level "${wantedEffort}"; using its own current level`)
          }
        }
      } else if (thought.currentValue === wantedEffort) {
        // Already in force.
      } else if (thought.choices.length > 0 && !thought.choices.some(choice => choice.value === wantedEffort)) {
        result.effortStale = true
        if (this.dropStalePick(session, 'effort', wantedEffort)) {
          notice('error', `acp: agent "${session.agentId}" no longer offers thought level "${wantedEffort}"; using its own current level`)
        }      } else {
        try {
          await bridge.setConfigOption(session, thought.configId, wantedEffort)
        } catch (error) {
          notice('error', `acp: failed to set thought level "${wantedEffort}": ${describeError(error)}`)
        }
      }
    }
    return result
  }

  /**
   * Remove one persisted pick the agent no longer honours. Only the thought
   * level uses this today: a stale MODEL pick is deliberately kept and the
   * turn refused, so the user can see which selection must be replaced.
   * Returns true only when a record actually changed — that transition is the
   * news the notice reports.
   */
  private dropStalePick(session: LiveSession, field: 'model' | 'effort', value: string): boolean {
    const dshSessionId = session.dshSessionId
    if (dshSessionId === undefined) return false
    const choice = this.picks.get(dshSessionId)
    if (choice === undefined || choice.agentId !== session.agentId) return false
    const matches = field === 'model'
      ? choice.modelId === buildAdapterModelId(session.agentId, value)
      : choice.effort === value
    if (!matches) return false
    if (field === 'model') this.patchChatChoice(dshSessionId, { modelId: undefined })
    else this.patchChatChoice(dshSessionId, { effort: undefined })
    return true
  }

  /**
   * The requested model value this session's agent no longer offers, if any —
   * the gate the turn path uses to refuse before sending anything.
   *
   * Reads only the session's OWN latest `configOptions` (the same authority
   * alignment uses): a non-empty choice list without the value means the agent
   * dropped it, and applying is impossible. `undefined` means either no model
   * was requested, it is in force, or nothing authoritative is available (no
   * selector, or a selector without choices) — those keep the previous
   * best-effort behavior instead of wedging the conversation.
   *
   * Falling back to "whatever the agent runs" here is exactly the surprise this
   * gate forbids: a different model can differ in price and capability. The
   * pick is kept so the failure names a selection the user can act on.
   */
  staleModelChoice(session: LiveSession, modelChoice: string | undefined): string | undefined {
    const wanted = modelChoice !== undefined && modelChoice !== '' ? modelChoice : undefined
    if (wanted === undefined) return undefined
    // `category` is a UX hint, not identity: an agent may publish several
    // `category: 'model'` options (Qoder CN ships `reasoning_effort` that way)
    // and no explicit `model` id. In that case the selector is a guess, so a
    // "not offered" verdict would refuse a perfectly valid pick — fail open.
    if (!hasUnambiguousModelSelector(session.configOptions)) return undefined
    const model = parseCatalogOptions(session.configOptions).model
    if (model === undefined) return undefined
    if (model.currentValue === wanted) return undefined
    // A selector without a choice list is unvalidatable; applying it is the
    // existing best effort and the agent decides.
    if (model.choices.length === 0) return undefined
    return model.choices.some(choice => choice.value === wanted) ? undefined : wanted
  }

  /**
   * The agent values the composer is showing for a conversation that has not
   * picked them — the catalog's current model, thought level, mode and extra
   * config values.
   *
   * Captured BEFORE `session/new`: materializing the session absorbs its own
   * defaults into the catalog (`absorbCatalog`), which would overwrite exactly
   * the values the user saw and leave the first turn running the agent's
   * defaults instead. Reading is pure memory, same as `agentCatalog`.
   */
  displayedChatDefaults(agentId: string): DisplayedChatDefaults | undefined {
    const catalog = this.host.catalogFor(agentId)
    if (catalog === undefined) return undefined
    const out: DisplayedChatDefaults = {}
    const model = catalog.model?.currentValue
    if (model !== null && model !== undefined && model !== '') {
      out.modelId = buildAdapterModelId(agentId, model)
    }
    // Only the level the chip itself reports: `reasoningMeta` keeps
    // `defaultEffort` only when the current value is one of the agent's levels.
    const effort = this.host.reasoningMeta(agentId)?.defaultEffort
    if (effort !== undefined) out.effort = effort
    // The mode select's pre-first-message value is the catalog's last-known
    // mode (the agent's own answer from another session), and `session/new`
    // starts on whatever the agent itself defaults to. Without capturing it,
    // a conversation whose select reads "Bypass Permissions" would run its
    // first turn on "Always Ask" — the same display/run split the model and
    // thought level are seeded for.
    const mode = catalog.mode?.currentValue
    if (mode !== null && mode !== undefined && mode !== '') out.mode = mode
    const extraConfigs: Record<string, string | boolean> = {}
    for (const option of catalog.extras ?? []) {
      const value = option.currentValue
      if (option.kind === 'boolean') {
        // The catalog encodes a toggle as 'true' / 'false'; the pick stores the
        // real boolean, exactly like an explicit checkbox click.
        if (value === 'true' || value === 'false') extraConfigs[option.configId] = value === 'true'
        continue
      }
      if (value !== null && value !== undefined && value !== '') extraConfigs[option.configId] = value
    }
    if (Object.keys(extraConfigs).length > 0) out.extraConfigs = extraConfigs
    return Object.keys(out).length === 0 ? undefined : out
  }

  /**
   * Record what the composer showed as this conversation's pick before the
   * first prompt runs.
   *
   * A conversation with no explicit pick displays the agent catalog's current
   * model / thought level / mode / extras, while the ACP session `session/new`
   * just created starts on whatever the agent itself defaults to. Without this
   * the user is shown one model and the agent runs another — the defect
   * reported as "the displayed model was not used", and the reported first
   * turn that ignored the mode select's value. Values the fresh session does
   * not offer are skipped (its `configOptions` are the authority, and the
   * catalog update that rode `session/new` will correct the display), never
   * turned into a failed first turn. Explicit picks always win: only missing
   * fields are filled.
   */
  seedChatChoiceFromCatalog(
    dshSessionId: string,
    agentId: string,
    session: LiveSession,
    displayed: DisplayedChatDefaults | undefined,
  ): void {
    if (displayed === undefined) return
    const current = this.picks.get(dshSessionId)
    if (current !== undefined && current.agentId !== agentId) return
    const options = parseCatalogOptions(session.configOptions)
    const patch: Partial<AcpConversationChoice> = { agentId }
    let changed = false
    const model = options.model
    if (current?.modelId === undefined && displayed.modelId !== undefined && model !== undefined) {
      const value = splitAdapterModelId(displayed.modelId).choice
      if (value !== undefined && (model.choices.length === 0 || model.choices.some(choice => choice.value === value))) {
        patch.modelId = displayed.modelId
        changed = true
      }
    }
    const thought = options.thought
    // `reasoning.defaultEffort` was observed on whichever model the agent was
    // last on, and the composer only shows it as THIS conversation's default
    // when the route resolves to that same model (see `describeRoute`). A model
    // picked before the first message makes the old default the previous
    // model's level: seeding it would run a value the chip never showed.
    const pickedModelValue = current?.modelId === undefined ? undefined : splitAdapterModelId(current.modelId).choice
    const displayedModelValue = displayed.modelId === undefined ? undefined : splitAdapterModelId(displayed.modelId).choice
    // A catalog that cannot name its model proves nothing about an explicitly
    // picked one; only "no model picked" (the bare route / agent's own model)
    // is safe there. Mirrors `describeRoute`.
    const effortAppliesToDisplayedModel = pickedModelValue === undefined
      || (displayedModelValue !== undefined && pickedModelValue === displayedModelValue)
    if (current?.effort === undefined && displayed.effort !== undefined && thought !== undefined
      && effortAppliesToDisplayedModel) {
      if (thought.choices.length === 0 || thought.choices.some(choice => choice.value === displayed.effort)) {
        patch.effort = displayed.effort
        changed = true
      }
    }
    // The mode is the third axis of the same contract. The select's value
    // before the first message is the catalog's last-known mode; `session/new`
    // answers with the agent's own default. Seed the displayed one when the
    // fresh session still offers it — an agent that publishes no `modes`
    // field is applied best-effort, exactly like `applyChatChoice`.
    const displayedMode = displayed.mode
    const offeredModes = session.modes?.availableModes ?? []
    if (current?.mode === undefined && displayedMode !== undefined
      && (offeredModes.length === 0 || offeredModes.some(entry => entry.id === displayedMode))) {
      patch.mode = displayedMode
      changed = true
    }
    if (displayed.extraConfigs !== undefined) {
      const extraConfigs = { ...(current?.agentId === agentId ? current.extraConfigs : undefined) }
      for (const [configId, value] of Object.entries(displayed.extraConfigs)) {
        if (extraConfigs[configId] !== undefined) continue
        const option = options.extras?.find(entry => entry.configId === configId)
        if (option === undefined) continue
        // The fresh session's own option set is the authority for BOTH forms:
        // a toggle must still be a toggle, a select must still offer the value.
        if (option.kind === 'boolean'
          ? typeof value !== 'boolean'
          : typeof value !== 'string' || (option.choices.length > 0 && !option.choices.some(choice => choice.value === value))) continue
        extraConfigs[configId] = value
        changed = true
      }
      if (Object.keys(extraConfigs).length > 0) patch.extraConfigs = extraConfigs
    }
    if (!changed) return
    this.patchChatChoice(dshSessionId, patch)
  }
}
