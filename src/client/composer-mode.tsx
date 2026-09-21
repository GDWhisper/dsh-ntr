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
  const modes = target?.modes?.availableModes ?? []
  if (target === undefined || modes.length === 0) return null
  const current = target.modes?.currentModeId ?? modes[0]?.id ?? ''

  return (
    <label
      style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12 }}
      title={acp.label(
        `ACP agent 模式（${target.agentId}）：由 agent 自己定义，与 DSH 的 Access mode 互补`,
        `ACP agent mode (${target.agentId}): defined by the agent, complementary to the DSH access mode`,
      )}
    >
      <span aria-hidden style={{ opacity: 0.7 }}>{acp.label('Agent 模式', 'Agent mode')}</span>
      <select
        value={current}
        disabled={switching}
        onChange={event => {
          const modeId = event.target.value
          setSwitching(true)
          void acp.setChatSessionMode(dshSessionId, modeId, target.agentId).finally(() => { setSwitching(false) })
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
