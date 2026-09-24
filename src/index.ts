/**
 * dsh-ntr host entry: mounts the `/acp` Connection RPC channel and the
 * `/api/acp/stream` SSE route, owns every spawned ACP child, and tears all of
 * them down with the plugin fiber. Named exports only (a default export would
 * hide the loader metadata — see harness postmortem 0001).
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-client-connection'
import { ACP_PRESET_ID, AcpLlmAdapter, BridgeManager } from './bridge.ts'
import { EventHub, dispatchRpc, dshSessionPolicyOf, lastNativeRoute, sessionAgentPreset, sessionAgentPresetFromLog, validateConfig } from './impl.ts'
import type { AcpEvent } from './protocol.ts'
import type { ApprovalOutcome } from './bridge.ts'
import type { AccessModeSessionLike, ModelRouteSelection, RosterPresetRow, RouteBearingSessionLike } from './impl.ts'

export const name = 'dsh-ntr'
// `approval` / `agents` are deliberately NOT listed here: they are optional
// collaborators probed structurally below. A hard dependency would make the
// whole plugin fail to load on a deployment without them (see the LLM service
// probe, which follows the same shape).
export const inject = ['webServer', 'connection']

/** Structural view of the host approval service (`@deepseek-ai/dsh-user-approval`). */
interface ApprovalServiceLike {
  request(req: { agent: unknown; toolName: string; reason?: string; signal?: AbortSignal }): Promise<ApprovalOutcome>
  /** Deployment-wide default policy, read only when the session log carries no override. */
  config?: { policy?: string }
}

/** Structural view of the host agent registry (`ctx.agents`), keyed by chat session id. */
interface AgentsServiceLike {
  get(sessionId: string): unknown | undefined
}

/** Structural view of the host sandbox policy service (`@deepseek-ai/dsh-sandbox-policy`). */
interface SandboxPolicyLike {
  resolve(request: { session?: unknown }): { mode?: unknown; workspaceRoot?: unknown }
}

/** Structural view of the host session store (`@deepseek-ai/dsh-session`'s `ctx.sessions`). */
interface SessionsLike {
  get(sessionId: string): AccessModeSessionLike | undefined
  /** Live sessions, for the default-model guard's fallback route (optional: an older store may lack it). */
  list?(): readonly RouteBearingSessionLike[]
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
      cancelFallbackMs: resolved.cancelFallbackMs,
    },
  )
  const adapter = new AcpLlmAdapter(manager)
  // Warm the model catalog at boot (no-op under test runners or when
  // probeModelsOnBoot is disabled): background spawn per uncached agent only.
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
   * Native approval routing: answer ACP `session/request_permission` through
   * the host approval chain so the question takes over the chat composer
   * (`ApprovalPanel`) instead of the settings panel.
   *
   * `approval.request` needs the live agent object (its session carries the
   * audit pair, and the ask must land inside an open turn) and the chat
   * session id our adapter already knows. Any missing piece — service absent,
   * unknown session, a rejecting service — degrades to `'unavailable'`, which
   * sends the ask back to the ledger/panel path rather than losing it.
   */
  const wireApproval = (): void => {
    const approval = (typeof ctx.get === 'function' ? ctx.get('approval') : (ctx as unknown as { approval?: ApprovalServiceLike }).approval) as ApprovalServiceLike | undefined
    const agents = (typeof ctx.get === 'function' ? ctx.get('agents') : (ctx as unknown as { agents?: AgentsServiceLike }).agents) as AgentsServiceLike | undefined
    if (approval === undefined || agents === undefined) return
    manager.setApprovalRequester(async ({ dshSessionId, toolName, signal }) => {
      if (dshSessionId === undefined) return 'unavailable'
      const agent = agents.get(dshSessionId)
      if (agent === undefined) return 'unavailable'
      try {
        return await approval.request({ agent, toolName, ...(signal === undefined ? {} : { signal }) })
      } catch {
        // Never propagate: a failed ask must fall back, not break the turn.
        return 'unavailable'
      }
    })
  }

  /**
   * Access-mode routing: a chat-backed session's DSH access mode
   * (`sandbox/mode` + `approval/policy` — the knobs the composer's Access mode
   * control writes) governs its permission asks and its fs writes. It is
   * enforced, never narrated into the prompt.
   *
   * Why this exists: an ACP agent's tools run in its own process, where DSH's
   * file sandbox has no reach, and the one knob that did reach the agent —
   * `approval/policy` — reached it INVERTED (`never`, the "full access" preset,
   * resolves every ask to `'rejected'` inside the approval service before any
   * answerer runs, so full access denied every write). See
   * docs/acp-permission-and-sandbox.md.
   */
  const wireAccessMode = (): void => {
    const sandboxPolicy = (typeof ctx.get === 'function' ? ctx.get('sandboxPolicy') : undefined) as SandboxPolicyLike | undefined
    const sessions = (typeof ctx.get === 'function' ? ctx.get('sessions') : undefined) as SessionsLike | undefined
    const approval = (typeof ctx.get === 'function' ? ctx.get('approval') : undefined) as ApprovalServiceLike | undefined
    if (sandboxPolicy === undefined || sessions === undefined || approval === undefined) return
    manager.setSessionPolicyResolver(dshSessionId => {
      try {
        const session = sessions.get(dshSessionId)
        if (session === undefined) return undefined
        return dshSessionPolicyOf(sandboxPolicy.resolve({ session }), session, approval.config?.policy)
      } catch {
        // A lookup failure must never break a turn: no mode means the agent's
        // own `permission` field governs this session, exactly as before.
        return undefined
      }
    })
  }

  /**
   * ACP-mode resolver wiring: a session running the ACP agent preset stops
   * letting the access mode arbitrate its asks (the agent's own permission
   * mode does, answered by the human in the conversation); the mode keeps
   * narrating the boundary and the fs fence stays enforced, and the browser's
   * model-seat gate reads the same verdict over `session/chat-list`. Read from
   * the session log rather than from a marker we set ourselves, so it cannot
   * drift from the roster.
   *
   * THREE fact sources, newest-wins: the live session store (`ctx.sessions`,
   * in-memory log, always fresh) — then the persistence store, because a
   * session whose last turn predates this process is not live anywhere and
   * the model-seat gate asks exactly such cold sessions — then nothing
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

  wireApproval()
  wireAccessMode()
  if (typeof ctx.inject === 'function') {
    // Late arrival for the access-mode collaborators; kept separate from the
    // approval probe so a deployment missing one service still wires the other.
    ctx.inject(['sandboxPolicy', 'sessions'], () => {
      wireAccessMode()
    })
  }
  // The seat gate's verdict only needs the session store (live) and the
  // persistence store (cold); the access-mode knobs are NOT its dependencies.
  // A deployment without `approval` must still take the model seat over.
  wireAcpMode()
  if (typeof ctx.inject === 'function') {
    ctx.inject(['sessions'], () => {
      wireAcpMode()
    })
  }
  if (typeof ctx.inject === 'function') {
    // Late arrival: both services may still be loading when this plugin
    // applies (profile order is not ours to control).
    ctx.inject(['approval', 'agents'], () => {
      wireApproval()
    })
  }

  /**
   * Deployment-default-model guard: DSH's `session.selectModel` records a
   * selection as the session's own durable route AND as the deployment default
   * (`agentDefaultModel.saveSelection`), and that second write is global to
   * every mode. Picking an ACP agent in one conversation would therefore make
   * every NEW session — in every other mode — start on the external agent.
   * The guard puts the previous NATIVE default back; see `AcpDefaultModelGuard`
   * for the candidate order (the config editor is never asked to guess).
   *
   * `fallback` is the only candidate a default that is *already* poisoned has:
   * the freshest non-ACP route among live sessions, i.e. what this deployment
   * was actually running. An install that predates the guard is repaired on the
   * boot check below or on its next native turn/pick.
   */
  const wireDefaultModelGuard = (): void => {
    const defaultModel = (typeof ctx.get === 'function' ? ctx.get('agentDefaultModel') : undefined) as {
      currentSelection?(): ModelRouteSelection | undefined
      saveSelection?(next: ModelRouteSelection): Promise<void>
    } | undefined
    if (defaultModel === undefined || typeof defaultModel.saveSelection !== 'function') return
    const sessions = (typeof ctx.get === 'function' ? ctx.get('sessions') : undefined) as SessionsLike | undefined
    manager.setDefaultModelGuard({
      read: () => defaultModel.currentSelection?.(),
      write: next => defaultModel.saveSelection?.(next) ?? Promise.resolve(),
      ...(sessions === undefined
        ? {}
        : { fallback: () => lastNativeRoute(sessions.list?.() ?? []) }),
    })
    // A boot already carrying an ACP default is repaired here when any live
    // session supplies a native route; otherwise the first native turn/pick is
    // what heals it (every one of them re-runs this check).
    void manager.reconcileDefaultModel().catch(() => { /* inert without a guard */ })
  }

  wireDefaultModelGuard()
  if (typeof ctx.inject === 'function') {
    // Late arrival for the guard's collaborators: both services may still be
    // loading when this plugin applies (profile order is not ours to control).
    ctx.inject(['sessions'], () => { wireDefaultModelGuard() })
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
        // The route is registered so sessions can select and stream
        // `acp@<agentId>`; it deliberately advertises no models (see
        // `AcpLlmAdapter.listModels`), so there is nothing for a browser-side
        // model directory to refresh when the catalog changes — the ACP seats
        // read `agent/catalog` themselves.
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
