/**
 * ACP-native mode control for the conversation composer
 * (`conversation.input.left` — the seat the slot contract reserves for a small
 * control beside the resident Access mode chrome).
 *
 * The two controls are deliberately different layers, which is what keeps them
 * from reading as duplicates: the host's Access mode (仅可查看 / 工作区内修改 /
 * 完全权限) decides what the session may TOUCH, while this one is the agent's own
 * `session/set_mode` vocabulary (`plan`, `acceptEdits`, …) deciding HOW it works.
 * The host supplies the data by chat session id (`session/chat-list`), so the
 * control renders nothing until an ACP agent has actually run in this
 * conversation, and nothing at all for an agent that declares no modes.
 */

import { useEffect, useState, useSyncExternalStore } from 'react'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { AcpSessionHook } from './acp-ui.tsx'
import type { AcpStore } from './store.ts'

/**
 * The props this occupant actually receives: our injected face (which carries
 * the chat session id, like every other entry in this plugin) plus the
 * framework's session standard kit, of which only `useSession` is read.
 *
 * `conversation.input.left` declares no `owner` share — the composer bar calls
 * `renderSlot('conversation.input.left', {})` — so the ONLY props that exist are
 * the standard kit (session-scope `sessionId` + the bound `use<Name>` selector
 * hooks + `useProjection`/`inputActions`) and whatever our `inject` returns. The
 * session id deliberately rides the injected face rather than the standard kit:
 * the kit's top-level `sessionId` is a newer renderer addition, while the
 * positional inject argument (`binding.key`) is the contract every version in
 * play honors. Inventing a prop here is a render crash, not a silent undefined.
 */
export interface ComposerModeProps {
  /** Injected face: the chat session id this control belongs to. */
  sessionId: string
  /** Framework-bound conversation snapshot hook (`SessionStandardProps.useSession`). */
  useSession: AcpSessionHook
  acp: AcpStore
}

function useUi(acp: AcpStore) {
  return useSyncExternalStore(cb => acp.subscribe(cb), () => acp.getSnapshot())
}

export function AcpComposerMode({ acp, sessionId, useSession }: ComposerModeProps) {
  const ui = useUi(acp)
  const dshSessionId = String(sessionId)
  // A fresh chat session has no binding until its first turn creates one, so
  // re-read whenever the running flag settles.
  const running = useSession(snapshot => snapshot.running)
  const [switching, setSwitching] = useState(false)

  useEffect(() => {
    void acp.loadChatSessions(dshSessionId)
  }, [acp, dshSessionId, running])

  const bound = ui.chatSessionsFor === dshSessionId ? ui.chatSessions : []
  // Prefer the live binding; a released one still describes the conversation.
  const target = bound.find(session => !session.released) ?? bound[0]
  // ISOLATION — this entry is NOT inside the ACP-mode gate (`syncAcpMode` holds
  // the model/permission seats, but `conversation.input.left` is registered
  // unconditionally), so it must gate itself. The `defaultAgent` fallback below
  // would otherwise put an ACP mode select into ORDINARY conversations: the
  // agent id is plugin-global, so "an agent is configured" is not the same
  // question as "this conversation is served by one". A live session is itself
  // proof; otherwise it is the same host verdict the seat gate reads.
  const isAcp = target !== undefined || ui.acpMode[dshSessionId] === true
  // The agent this conversation is set up on, live session or not. Before the
  // first message there is no session to read a mode list from, yet the user is
  // already choosing the agent — and the mode is one of the things they may
  // want to choose with it (user report, 2026-10-18: this control vanished on a
  // conversation set up ahead of its first message).
  //
  // The `defaultAgent` fallback applies ONLY inside an ACP-mode conversation.
  // Without that gate an ordinary chat would resolve an agent id it has nothing
  // to do with and read ITS catalog — and reading a catalog can spawn a probe
  // (user report, 2026-10-18: an unrelated agent showed up "已连接").
  const agentId = target?.agentId
    ?? ui.chatBoundAgent[dshSessionId]
    ?? ui.chatChoice[dshSessionId]?.agentId
    ?? (isAcp ? ui.defaultAgent : undefined)
  const catalog = agentId === undefined ? undefined : ui.seatCatalogs[agentId]
  useEffect(() => {
    // Nothing to read for a conversation that is not served by an agent, and
    // nothing to read while a live session is already answering (its
    // `session/new` modes outrank the catalog).
    if (!isAcp || agentId === undefined || target !== undefined) return
    void acp.loadAgentCatalog(agentId)
  }, [acp, agentId, isAcp, target])

  const live = target?.modes?.availableModes ?? []
  // TWO sources, one list. A live session's `session/new` answer is the
  // authority on which modes exist and which is in force; the probed catalog
  // carries the same list for the window before one exists (it is what the
  // agent published on ITS throwaway session). A live session always wins.
  const modes = live.length > 0
    ? live
    : (isAcp ? catalog?.mode?.choices ?? [] : []).map(choice => ({ id: choice.id, name: choice.name, description: choice.description }))
  if (modes.length === 0) return null
  // The mode IN FORCE comes from the live session; before one exists the only
  // claims available are the agent's own reported current mode and the pick this
  // conversation recorded (a pick outranks the agent's default, exactly like the
  // model and thought level do in `describeRoute`).
  const persisted = ui.chatChoice[dshSessionId]?.agentId === agentId
    ? ui.chatChoice[dshSessionId]?.mode
    : undefined
  const current = target?.modes?.currentModeId
    ?? persisted
    ?? catalog?.mode?.currentValue
    ?? modes[0]?.id
    ?? ''

  return (
    <label
      style={{ display: 'inline-flex', alignItems: 'center', fontSize: 12 }}
      // No visible "Agent mode" caption (user decision, 2026-10-17): the option
      // labels are the agent's own mode names (Plan / Accept edits / …), which
      // read as what they are on their own — a caption beside a single select
      // only adds a second line of chrome to a control whose value already says
      // it. The explanation stays in the tooltip for whoever goes looking.
      title={acp.label(
        `agent 模式（${agentId ?? 'agent'}）：由 agent 自己定义，与 DSH 的 Access mode 互补`,
        `agent mode (${agentId ?? 'agent'}): defined by the agent, complementary to the DSH access mode`,
      )}
    >
      <select
        aria-label={acp.label('agent 模式', 'agent mode')}
        value={current}
        disabled={switching}
        onChange={event => {
          const modeId = event.target.value
          setSwitching(true)
          void acp.setChatSessionMode(dshSessionId, modeId, agentId).finally(() => { setSwitching(false) })
        }}
        style={{
          font: 'inherit',
          fontSize: 12,
          padding: '2px 4px',
          borderRadius: 6,
          border: '1px solid var(--dsw-alias-border-l2, #d1d5db)',
          background: 'transparent',
          color: 'inherit',
          maxWidth: 180,
        }}
      >
        {modes.map(mode => (
          <option key={mode.id} value={mode.id}>{mode.name ?? mode.id}</option>
        ))}
      </select>
    </label>
  )
}
