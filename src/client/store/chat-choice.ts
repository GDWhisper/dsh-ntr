/**
 * The conversation's own ACP picks, lifted out of `AcpStore` (split plan P3b):
 * which agent serves one DSH chat session, plus that agent's model, reasoning
 * effort and extra config options.
 *
 * One contract shapes the cluster: `AcpConversationChoice` is the plugin's
 * record for one conversation (persisted host-side in `agents.json`), the click
 * writes it optimistically so the chips move at once, and the host records the
 * intent through its own `session/chat-*` routes. `writeChoice` is the SINGLE
 * writer — every write only ADDS to the record (plus the mirror onto the live
 * chat row), so a read that started before the click can never lose a pick it
 * did not know about.
 *
 * The service never imports the facade: `call` / `mutate` / the snapshot and
 * `flashError` arrive through {@link ChatChoiceHost}, so the broadcast and merge
 * timing of every write is exactly the store's.
 */

import type { AcpConversationChoice } from '../../protocol.ts'
import { modelOffersEffort, modelValueOf } from '../route-reasoning.ts'
import type { UiState } from './state.ts'

/** What the chat-choice service needs from the store, injected. */
export interface ChatChoiceHost {
  /** The `/acp` RPC face (the store's own `call`, code-preserving errors included). */
  call<T>(endpoint: string, payload?: unknown): Promise<T>
  /** Commit one snapshot patch and notify listeners — the store's single writer. */
  mutate(patch: Partial<UiState>): void
  /** The current snapshot (reads only). */
  state(): UiState
  /** Surface an action failure in the page notice line. */
  flashError(error: unknown): void
}

/**
 * Split `agentId@choice` into the agent half. A value with no `@` is the agent
 * itself; an empty agent half is "no agent" (a bare `@model` names nothing).
 */
function splitModelAgentId(modelId: string): string | undefined {
  const at = modelId.indexOf('@')
  const agent = at === -1 ? modelId.trim() : (at === 0 ? '' : modelId.slice(0, at).trim())
  return agent || undefined
}

export class ChatChoiceService {
  constructor(private readonly host: ChatChoiceHost) {}

  /**
   * Bind one DSH chat session to an ACP agent. This is the plugin's own
   * conversation↔agent mapping: it does NOT write a DSH model route, so it
   * cannot pollute the deployment default model and cannot be refused by the
   * GUI's catalog gate (the retired `session/model-unavailable` failure).
   *
   * The mapping is host-side and keyed by chat session id; the browser learns
   * the binding back through `session/chat-list`.
   */
  async bindChatAgent(dshSessionId: string, agentId: string): Promise<void> {
    try {
      await this.host.call('session/chat-bind', { dshSessionId, agentId })
      // Optimistic: the host recorded the intent, so the NEXT message runs the
      // picked agent — but the live-session list (`chatSessions`) cannot show
      // that until the turn materializes its session. Recording here is what
      // makes the chip and the picker's checkmark move on the click itself.
      this.host.mutate({ chatBoundAgent: { ...this.host.state().chatBoundAgent, [dshSessionId]: agentId } })
    } catch (error) {
      this.host.flashError(error)
      throw error
    }
  }

  /** Switch the bound agent's model (`agentId@choice`) for one chat session. */
  async setChatSessionModel(dshSessionId: string, modelId: string, agentId?: string): Promise<void> {
    try {
      await this.host.call('session/chat-model-set', { dshSessionId, modelId })
      // Optimistic for the same reason the binding is: the host recorded the
      // pick, and a conversation with no ACP session yet would otherwise show
      // the agent's default until its first turn created one.
      const safeAgent = (agentId && agentId.trim()) || undefined
      const targetAgent = safeAgent ?? (modelId ? splitModelAgentId(modelId) : undefined)
      // A thought level belongs to the model it was picked on. The host clears
      // one the new model does not offer (it is the authority); mirror that here
      // so the chip does not keep naming it during the round-trip. A model the
      // catalog has no record for counts as "does not offer" — the same
      // conservative answer the host gives.
      const owner = targetAgent ?? this.host.state().chatChoice[dshSessionId]?.agentId ?? this.host.state().chatBoundAgent[dshSessionId] ?? this.host.state().defaultAgent
      const sessions = this.host.state().chatSessionsFor === dshSessionId ? this.host.state().chatSessions : []
      const dropEffort = this.host.state().chatChoice[dshSessionId]?.modelId !== modelId
        && !sessions.some(s => !s.released)
        && !modelOffersEffort(this.host.state().seatCatalogs[owner ?? ''], modelValueOf(modelId), this.host.state().chatChoice[dshSessionId]?.effort)
      this.writeChoice(dshSessionId, choice => {
        const next = { ...choice, modelId }
        if (dropEffort) delete next.effort
        return next
      }, targetAgent)
      if (this.host.state().chatSessionsFor === dshSessionId) {
        let changed = false
        const chatSessions = this.host.state().chatSessions.map(s => {
          if (s.agentId !== owner) return s
          if (!dropEffort && s.modelId === modelId) return s
          if (dropEffort && s.modelId === modelId && s.reasoningEffort === undefined) return s
          changed = true
          return { ...s, modelId, ...(dropEffort ? { reasoningEffort: undefined } : {}) }
        })
        if (changed) this.host.mutate({ chatSessions })
      }
    } catch (error) {
      this.host.flashError(error)
      throw error
    }
  }

  /** Switch the bound agent's reasoning effort for one chat session. */
  async setChatSessionEffort(dshSessionId: string, effort: string | undefined, agentId?: string): Promise<void> {
    try {
      await this.host.call('session/chat-effort-set', {
        dshSessionId,
        ...(effort === undefined ? {} : { effort }),
        ...(agentId === undefined ? {} : { agentId }),
      })
      const targetAgent = (agentId && agentId.trim()) || undefined
      this.writeChoice(dshSessionId, choice => {
        const { effort: _dropped, ...rest } = choice
        return effort === undefined ? rest : { ...rest, effort }
      }, targetAgent)
      if (this.host.state().chatSessionsFor === dshSessionId) {
        const owner = targetAgent ?? this.host.state().chatChoice[dshSessionId]?.agentId ?? this.host.state().chatBoundAgent[dshSessionId] ?? this.host.state().defaultAgent
        let changed = false
        const chatSessions = this.host.state().chatSessions.map(s => {
          if (s.agentId !== owner || s.reasoningEffort === effort) return s
          changed = true
          return { ...s, reasoningEffort: effort }
        })
        if (changed) this.host.mutate({ chatSessions })
      }
    } catch (error) {
      this.host.flashError(error)
      throw error
    }
  }

  /** Set one of the bound agent's EXTRA config options for one chat session. */
  async setChatSessionConfig(dshSessionId: string, configId: string, value: string | boolean, agentId?: string): Promise<void> {
    try {
      await this.host.call('session/chat-config-set', {
        dshSessionId,
        configId,
        value,
        ...(agentId === undefined ? {} : { agentId }),
      })
      this.writeChoice(dshSessionId, choice => ({
        ...choice,
        extraConfigs: { ...choice.extraConfigs, [configId]: value },
      }), agentId)
    } catch (error) {
      this.host.flashError(error)
      throw error
    }
  }

  /**
   * Patch one conversation's optimistic pick. The agent half is required by the
   * record (a model or thought level belongs to an agent). Its owner is the
   * route the picker used, else the recorded pick, the optimistic binding, or
   * the plugin default — that last one really serves a never-bound conversation
   * (the guard routes to it), so waiting for `session/chat-list` would leave the
   * chip behind the click. Only a conversation with none of those is left alone.
   *
   * Public because the agent-mode switch (`ChatSessionsService`) records its
   * pick through the same single writer.
   */
  writeChoice(dshSessionId: string, update: (choice: AcpConversationChoice) => AcpConversationChoice, agentId?: string): void {
    const state = this.host.state()
    const current = state.chatChoice[dshSessionId]
    // The plugin default is a real route (the host applies it to a conversation
    // nobody bound), so an optimistic pick in a fresh conversation belongs to
    // it — without this the host recorded the pick but the chip waited for the
    // next `session/chat-list`.
    const owner = agentId ?? current?.agentId ?? state.chatBoundAgent[dshSessionId] ?? state.defaultAgent
    if (owner === undefined) return
    const next = update({ ...current, agentId: owner })
    this.host.mutate({ chatChoice: { ...state.chatChoice, [dshSessionId]: { ...next, agentId: owner } } })
  }
}
