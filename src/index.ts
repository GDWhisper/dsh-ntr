/**
 * dsh-ntr host entry: mounts the `/acp` Connection RPC channel and the
 * `/api/acp/stream` SSE route, owns every spawned ACP child, and tears all of
 * them down with the plugin fiber. Named exports only (a default export would
 * hide the loader metadata — see harness postmortem 0001).
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-client-connection'
import { AcpLlmAdapter, BridgeManager } from './bridge.ts'
import { EventHub, dispatchRpc, validateConfig } from './impl.ts'
import type { AcpEvent } from './protocol.ts'

export const name = 'dsh-ntr'
export const inject = ['webServer', 'connection']

/** Browser-safe encoder of `AcpEvent` frames; one SSE `data:` line per event. */
function formatSse(event: AcpEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`
}

export function apply(ctx: Context, config?: unknown): void {
  const resolved = validateConfig(config)
  const hub = new EventHub()
  const manager = new BridgeManager(resolved.agents, hub, resolved.transcriptMaxEntries ?? 600)
  const adapter = new AcpLlmAdapter(manager)

  const defaultModelService = (typeof ctx.get === 'function' ? ctx.get('agentDefaultModel') : undefined) as {
    currentSelection?(): { provider: string; model: string; reasoningEffort?: string }
    saveSelection?(next: { provider: string; model: string }): Promise<void>
  } | undefined

  if (defaultModelService) {
    manager.setDefaultModelHooks(
      () => defaultModelService.currentSelection?.(),
      next => defaultModelService.saveSelection ? defaultModelService.saveSelection(next) : Promise.resolve(),
    )
  }

  interface LlmService {
    registerAdapter(providers: string[], adapter: unknown): () => void
  }

  const registerLlm = (llmHandle: LlmService): void => {
    ctx.effect(
      () => llmHandle.registerAdapter(['acp'], adapter),
      'dsh-ntr: acp llm adapter',
    )
  }

  const llmService = (typeof ctx.get === 'function' ? ctx.get('llm') : (ctx as unknown as { llm?: LlmService }).llm) as LlmService | undefined
  if (llmService && typeof llmService.registerAdapter === 'function') {
    registerLlm(llmService)
  } else if (typeof ctx.inject === 'function') {
    ctx.inject(['llm'], (innerCtx: Context) => {
      const innerLlm = (typeof innerCtx.get === 'function' ? innerCtx.get('llm') : (innerCtx as unknown as { llm?: LlmService }).llm) as LlmService | undefined
      if (innerLlm && typeof innerLlm.registerAdapter === 'function') {
        registerLlm(innerLlm)
      }
    })
  }

  ctx.effect(
    () => ctx.connection.rpc.handle('/acp', (endpoint, payload, signal) => {
      if (signal.aborted) return Promise.resolve({ ok: false, error: { code: 'aborted', message: 'acp: request aborted', details: {} } })
      return dispatchRpc(manager, endpoint, payload)
    }),
    'dsh-ntr: /acp rpc channel',
  )

  ctx.effect(
    () => ctx.connection.fetch.register({
      path: '/api/acp/stream',
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: request => {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            const encoder = new TextEncoder()
            let closed = false
            const send = (event: AcpEvent): void => {
              if (closed) return
              try {
                controller.enqueue(encoder.encode(formatSse(event)))
              } catch {
                closed = true
              }
            }
            const unsubscribe = hub.subscribe(send)
            const keepalive = setInterval(() => {
              if (closed) return
              try {
                controller.enqueue(encoder.encode(': keepalive\n\n'))
              } catch {
                closed = true
              }
            }, 25_000)
            keepalive.unref?.()
            const finish = (): void => {
              if (closed) return
              closed = true
              clearInterval(keepalive)
              unsubscribe()
              try {
                controller.close()
              } catch { /* already closed */ }
            }
            request.signal.addEventListener('abort', finish, { once: true })
            // First frame: tell the client the stream is live.
            try {
              controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'stream/open' })}\n\n`))
            } catch {
              closed = true
            }
          },
        })
        return Promise.resolve(new Response(stream, {
          status: 200,
          headers: {
            'content-type': 'text/event-stream; charset=utf-8',
            'cache-control': 'no-cache, no-transform',
            'connection': 'keep-alive',
            'x-accel-buffering': 'no',
          },
        }))
      },
    }),
    'dsh-ntr: /api/acp/stream SSE route',
  )

  ctx.effect(
    () => async () => {
      await manager.shutdownAll()
    },
    'dsh-ntr: child teardown',
  )
}
