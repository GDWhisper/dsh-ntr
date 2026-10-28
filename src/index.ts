/**
 * dsh-ntr host entry: mounts the `/acp` Connection RPC channel and the
 * `/api/acp/stream` SSE route, owns every spawned ACP child, and tears all of
 * them down with the plugin fiber. Named exports only (a default export would
 * hide the loader metadata — see harness postmortem 0001).
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { ConnectionRpcHandler, HostConnectionHandle } from '@deepseek-ai/dsh-client-connection'
import { ACP_PRESET_ID, AcpLlmAdapter, BridgeManager } from './bridge.ts'
import { EventHub, dispatchRpc, permissionReplayFrames, sessionAgentPreset, sessionAgentPresetFromLog, validateConfig } from './impl.ts'
import type { AcpEvent, ApprovalDeadlineKey } from './protocol.ts'
import type { RosterPresetRow, SessionLogLike } from './impl.ts'

export const name = 'dsh-ntr'
// Deliberately minimal: every other host service is probed structurally
// (`ctx.get` + a late `ctx.inject`) so a deployment without one still loads
// this plugin. ACP permission asks are answered through this plugin's own
// ledger, so the host approval service is not a collaborator at all.
export const inject = ['webServer', 'connection']

/** Structural view of the host sandbox policy service (`@deepseek-ai/dsh-sandbox-policy`). */
interface SandboxPolicyLike {
  resolve(request: { session?: unknown }): { mode?: unknown; workspaceRoot?: unknown }
}
/**
 * The Connection service's private, owner-explicit channel registration. It is
 * not on the public `HostConnectionHandle` surface (only `rpc.handle` is), but
 * `rpc.handle` is unusable from an external plugin on the 0.1.7-rc.x runtime —
 * see the registration comment in `apply`. Absent on hypothetical runtimes
 * without it: fall back to `rpc.handle` there.
 */
interface ChannelRegisteringConnection extends HostConnectionHandle {
  register?(owner: Context, channel: string, handler: ConnectionRpcHandler): () => Promise<void>
}

/** Structural view of the host session store (`@deepseek-ai/dsh-session`'s `ctx.sessions`). */
interface SessionsLike {
  get(sessionId: string): SessionLogLike | undefined
}

/**
 * Structural view of the host session persistence service
 * (`@deepseek-ai/dsh-session-persistence`'s `ctx.sessionPersistence`). A COLD
 * session — one whose last turn predates this process — is not in
 * `ctx.sessions` (that store is live sessions only), so the only honest fact
 * source for its preset is the stored log. Read-only: a `read` handle never
 * takes ownership and races nothing.
 */
interface PersistenceLike {
  open(id: string, access: 'read' | 'write', options?: { signal?: AbortSignal }): Promise<SessionHandleLike>
}

/** Structural view of an open `SessionHandle`. */
interface SessionHandleLike {
  readonly header: { agentPreset?: unknown }
  read(offset?: number, length?: number, options?: { signal?: AbortSignal }): Promise<{ events: readonly unknown[] }>
  close(): Promise<void> | void
}

/** How many stored events the cold-read folds before giving up on scanning. */
const COLD_READ_MAX_EVENTS = 4096



/** Browser-safe encoder of `AcpEvent` frames; one SSE `data:` line per event. */
function formatSse(event: AcpEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`
}

export function apply(ctx: Context, config?: unknown): void {
  const resolved = validateConfig(config)
  const hub = new EventHub()
  const manager = new BridgeManager(
    resolved.agents,
    hub,
    resolved.transcriptMaxEntries ?? 600,
    undefined,
    undefined,
    resolved.probeModelsOnBoot ?? true,
    {
      startupTimeoutMs: resolved.startupTimeoutMs,
      permissionTimeoutMs: resolved.permissionTimeoutMs,
      permissionTimeoutMode: resolved.permissionTimeoutMode,
      cancelFallbackMs: resolved.cancelFallbackMs,
      staleCancelRetryDelayMs: resolved.staleCancelRetryDelayMs,
      staleCancelMaxRetries: resolved.staleCancelMaxRetries,
    },
  )
  const adapter = new AcpLlmAdapter(manager)
  // The RAW patch-file deadlines, before validation filled the defaults in.
  // `validateConfig` returns a number for every knob, so the validated object
  // cannot tell "the deployment asked for 10 minutes" from "the deployment said
  // nothing and 5 minutes is the built-in default" — and the settings card has
  // to say which of the two the user is looking at (and what the reset button
  // returns to). Only the keys the file actually names are declared.
  const rawConfig = (config ?? {}) as Record<string, unknown>
  const configuredDeadlines: Partial<Record<ApprovalDeadlineKey, number>> = {}
  // The window the file actually named — the new key, or the legacy one it
  // folded into (same order `validateConfig` resolves them in, so the card's
  // baseline and the running value never disagree).
  const rawWindow = rawConfig.permissionTimeoutMs
    ?? rawConfig.nativeApprovalTimeoutMs
    ?? rawConfig.permissionFallbackTimeoutMs
  if (typeof rawWindow === 'number' && Number.isFinite(rawWindow)) {
    configuredDeadlines.permissionTimeoutMs = rawWindow
  }
  // The mode is declared the same way: only when the file actually names it.
  const configuredMode = rawConfig.permissionTimeoutMode === 'abort' || rawConfig.permissionTimeoutMode === 'auto' || rawConfig.permissionTimeoutMode === 'wait'
    ? rawConfig.permissionTimeoutMode
    : undefined
  manager.setConfiguredApprovalDeadlines(configuredDeadlines, configuredMode)
  // Boot hook kept only so this entry point's shape does not change:
  // `bootstrapCatalogs` is intentionally empty — boot never spawns an agent,
  // in any environment and for any `probeModelsOnBoot` value. Catalogs fill
  // from a gesture instead (a real session, `agent/probe-models`, or an
  // on-disk cache — see `BridgeManager.bootstrapCatalogs` / `agentCatalog`).
  manager.bootstrapCatalogs()

  /**
   * ACP 模式 preset status.
   *
   * The preset is a DECLARATION this package ships — `presets/acp/acp.patch.yml`
   * is one of our own `dsh.bundle.patch` files, so the harness composes the
   * `preset-acp` roster row with no install step. Nothing here copies files:
   * the legacy `~/.dsh/.agent-presets/<id>` directory is no longer read by the
   * harness at all, which is exactly why a copy there proves nothing.
   *
   * What the panel can still need is the roster's own verdict — the declaration
   * stays visible with a diagnostic when its activation fails — so the registry
   * service is probed (never injected: a missing service must not fail loading)
   * and read lazily. `list()` is never called during this activation: the
   * registry settles the Host tree while auditing a definition, so reading the
   * roster inside our own row would wait on ourselves.
   */
  const wirePresetRoster = (): void => {
    const roster = (typeof ctx.get === 'function' ? ctx.get('agentPresets') : undefined) as {
      list?(): Promise<readonly RosterPresetRow[]>
    } | undefined
    const list = roster?.list
    if (roster === undefined || typeof list !== 'function') return
    manager.setPresetRosterReader(() => list.call(roster))
  }

  wirePresetRoster()
  if (typeof ctx.inject === 'function') {
    // Late arrival: the registry may still be loading when this plugin applies.
    ctx.inject(['agentPresets'], () => { wirePresetRoster() })
  }

  /**
   * Workspace routing: the sidebar's selected workspace IS the chat session's
   * workspace, so the agent's session and its process both run there (see
   * `chatWorkspaceRoot` and `getOrCreateDshSession`).
   *
   * This is the ONLY host state the turn path still needs. It used to also
   * resolve the session's access mode so the host could arbitrate the agent's
   * permission asks — that mapping is retired: an ACP agent is fully
   * autonomous, its `session/request_permission` is mapped to the user
   * unchanged, and DSH's sandbox has no reach into the agent's own process
   * anyway. See docs/acp-convergence.md §2.3.
   */
  const wireWorkspace = (): void => {
    const sandboxPolicy = (typeof ctx.get === 'function' ? ctx.get('sandboxPolicy') : undefined) as SandboxPolicyLike | undefined
    const sessions = (typeof ctx.get === 'function' ? ctx.get('sessions') : undefined) as SessionsLike | undefined
    if (sandboxPolicy === undefined || sessions === undefined) return
    manager.setSessionWorkspaceResolver(dshSessionId => {
      try {
        const session = sessions.get(dshSessionId)
        if (session === undefined) return undefined
        const root = sandboxPolicy.resolve({ session })?.workspaceRoot
        return typeof root === 'string' && root !== '' ? { workspaceRoot: root } : undefined
      } catch {
        // A lookup failure must never break a turn.
        return undefined
      }
    })
  }

  /**
   * ACP-mode resolver wiring: whether a chat session runs the ACP agent preset.
   * Read from the session log rather than from a marker we set ourselves, so it
   * cannot drift from the roster.
   *
   * THREE fact sources, newest-wins: the live session store (`ctx.sessions`,
   * in-memory log, always fresh) — then the persistence store, because a
   * session whose last turn predates this process is not live anywhere and the
   * browser's surfaces ask exactly such cold sessions — then nothing
   * (`undefined`, which every consumer reads as "not ACP", the allowed
   * failure mode).
   */
  const wireAcpMode = (): void => {
    const sessions = (typeof ctx.get === 'function' ? ctx.get('sessions') : undefined) as SessionsLike | undefined
    if (sessions === undefined) return
    manager.setAcpModeResolver(dshSessionId => {
      try {
        const session = sessions.get(dshSessionId)
        // An event-less session object proves nothing: `sessions.get` hands
        // back placeholders for ids it has not hydrated (a restarted process
        // serves empty stubs for cold sessions), and folding an empty log
        // reads as the default preset — a guess, not a fact. Only a log with
        // rows may answer synchronously; anything else falls through to the
        // persisted log, which is the authoritative fold.
        if (session !== undefined && (session.events?.length ?? 0) > 0) {
          return sessionAgentPreset(session) === ACP_PRESET_ID
        }
      } catch {
        // Fall through to the cold read.
      }
      return coldAcpMode(dshSessionId)
    })
  }

  /**
   * The ACP-preset verdict for a COLD session, read from the persistence
   * store. The read handle observes the log without taking ownership (another
   * writer, live or in another process, is untouched); the header plus the
   * last `agent-preset/selected` event are the whole fold — the same
   * newest-selection-wins rule the host's own `resolveSessionPreset` applies.
   * Returns `undefined` when the service is absent, the session is unknown, or
   * anything throws: a failed lookup must never read as "definitely not ACP".
   */
  const coldAcpMode = async (dshSessionId: string): Promise<boolean | undefined> => {
    const persistence = (typeof ctx.get === 'function' ? ctx.get('sessionPersistence') : undefined) as PersistenceLike | undefined
    if (persistence === undefined || typeof persistence.open !== 'function') return undefined
    try {
      const handle = await persistence.open(dshSessionId, 'read')
      try {
        const tail = await handle.read(0, COLD_READ_MAX_EVENTS)
        return sessionAgentPresetFromLog(handle.header?.agentPreset, tail?.events ?? []) === ACP_PRESET_ID
      } finally {
        await handle.close()
      }
    } catch {
      return undefined
    }
  }

  wireWorkspace()
  if (typeof ctx.inject === 'function') {
    // Late arrival for the workspace collaborators: a deployment missing one
    // service must not fail this plugin's activation.
    ctx.inject(['sandboxPolicy', 'sessions'], () => {
      wireWorkspace()
    })
  }
  // The ACP-preset verdict only needs the session store (live) and the
  // persistence store (cold); the sandbox knobs are NOT its dependencies.
  wireAcpMode()
  if (typeof ctx.inject === 'function') {
    ctx.inject(['sessions'], () => {
      wireAcpMode()
    })
  }

  /** Registration handle: callable disposer, plus `replace` to re-announce routes. */
  interface LlmAdapterHandle {
    (): void
  }

  interface LlmService {
    registerAdapter(providers: string[], adapter: unknown): LlmAdapterHandle
  }

  const registerLlm = (llmHandle: LlmService): void => {
    ctx.effect(
      () => {
        // The route exists so the host's driver can reach this adapter at all:
        // `adapter.stream()` is the ONLY path by which anything lands in DSH's
        // session log, and the log is what the native chat plane renders from
        // (see docs/acp-convergence.md §1.2-1.3). It deliberately advertises no
        // models — nothing here is selectable in DSH's model catalog, and no
        // surface in this bundle writes a `model/selection` for it.
        const handle = llmHandle.registerAdapter(['acp'], adapter)
        return () => { handle() }
      },
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
    () => {
      const handler: ConnectionRpcHandler = (endpoint, payload, signal) => {
        if (signal.aborted) return Promise.resolve({ ok: false, error: { code: 'aborted', message: 'acp: request aborted', details: {} } })
        return dispatchRpc(manager, endpoint, payload)
      }
      const connection = ctx.connection as ChannelRegisteringConnection
      // `rpc.handle` binds the route owner through Connection's traceable shadow,
      // which re-roots service lookups at the Connection service's own scope — a
      // scope that does not inject `webServer`. On the desktop 0.1.7-rc.2
      // composition that read dies with `cannot get property "webServer" without
      // inject`, the entry fails to activate, and every /acp POST falls through
      // to the static 405 fallback. `register` takes the owning context
      // explicitly, so pass ours — it declares webServer.
      //
      // The probe is presence-only (the method is private, so there is no type to
      // check against), so treat surprises conservatively: a `register` that
      // throws counts as absent (nothing was registered → use the documented
      // path), while one that returns something other than the disposer this
      // effect needs is kept anyway (the channel works; re-registering it through
      // the fallback would register twice) with a no-op disposer.
      if (typeof connection.register === 'function') {
        try {
          const disposer = connection.register(ctx, '/acp', handler)
          return typeof disposer === 'function' ? disposer : () => Promise.resolve()
        } catch { /* an unusable `register` is no better than none */ }
      }
      return connection.rpc.handle('/acp', handler)
    },
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
            // Then re-establish the client's view of the pending permission
            // asks. Taken AFTER the subscription, so an ask broadcast in the
            // meantime arrives both live and in the snapshot — the client folds
            // both by request id — and the terminator's live set prunes anything
            // this client still holds from before a disconnect.
            for (const frame of permissionReplayFrames(manager.pendingPermissionViews())) {
              try {
                controller.enqueue(encoder.encode(formatSse(frame)))
              } catch {
                closed = true
                break
              }
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
