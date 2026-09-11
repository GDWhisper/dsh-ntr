/**
 * dsh-ntr browser entry: builds the store over the Connection RPC face and
 * contributes the three public seats — sidebar footer toggle, the chat drawer
 * in `shell.overlay`, and the status section in settings.
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { AcpStore, type RpcCall } from './store.ts'
import { AcpSettingsSection } from './panel.tsx'

export const name = 'dsh-ntr-client'
export const inject = ['slots', 'connection']

/** Structural view of the browser Connection handle (official type is not merged into Context). */
interface BrowserConnection {
  rpc?: {
    call(channel: string, endpoint: string, payload: unknown, signal?: AbortSignal): Promise<
      | { ok: true; value: unknown }
      | { ok: false; error: { code: string; message: string } }
    >
  }
}

const zh = typeof navigator !== 'undefined' && /^zh\b/i.test(navigator.language)

export function apply(ctx: Context): void {
  const connection = ctx.get('connection') as BrowserConnection | undefined
  const rpc = connection?.rpc
  if (rpc === undefined) {
    throw new Error('dsh-ntr: browser connection.rpc is unavailable')
  }
  const call: RpcCall = (channel, endpoint, payload) => rpc.call(channel, endpoint, payload)
  const store = new AcpStore(call, (zhText, enText) => (zh ? zhText : enText))
  store.start()

  ctx.effect(() => ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'acp-agents',
    order: 120,
    label: () => (zh ? 'ACP 代理' : 'ACP Agents'),
    inject: () => ({ acp: store }),
  }, AcpSettingsSection)), 'dsh-ntr: settings section')
}
