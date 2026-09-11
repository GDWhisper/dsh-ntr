/**
 * Pure host-side logic for dsh-ntr: config validation, workspace guard,
 * credential-scrubbed child env, capped transcript, event hub, and the RPC
 * dispatcher. No Node imports, no SDK imports — everything here is testable
 * with plain fakes.
 */

import { randomUUID } from './ids.ts'
import type {
  AcpAgentDef, AcpEvent, AcpPluginConfig, AgentView, DetectedAgentInfo, PermissionMode, PermissionOutcome, RpcResult,
} from './protocol.ts'

export { randomUUID }

/** Structured failure the RPC layer converts to `{ok:false, error}` and `apply()` surfaces at boot. */
export class AcpError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
  }
}

// ---- Config validation ----

const AGENT_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/

/** Validate a single agent definition object. */
export function validateAgentDef(entry: unknown, label = 'agent'): AcpAgentDef {
  if (typeof entry !== 'object' || entry === null) throw new AcpError('bad_config', `acp: ${label} is not an object`)
  const row = entry as Record<string, unknown>
  const id = row.id
  if (typeof id !== 'string' || !AGENT_ID_PATTERN.test(id)) {
    throw new AcpError('bad_config', `acp: ${label}.id must match ${AGENT_ID_PATTERN.source}`)
  }
  if (typeof row.command !== 'string' || row.command.trim() === '') {
    throw new AcpError('bad_config', `acp: agent "${id}" needs a non-empty command`)
  }
  const args = row.args ?? []
  if (!Array.isArray(args) || args.some(a => typeof a !== 'string')) throw new AcpError('bad_config', `acp: agent "${id}" args must be string[]`)
  const env: Record<string, string> = {}
  if (row.env !== undefined) {
    if (typeof row.env !== 'object' || row.env === null || Array.isArray(row.env)) throw new AcpError('bad_config', `acp: agent "${id}" env must be an object`)
    for (const [k, v] of Object.entries(row.env as Record<string, unknown>)) {
      if (typeof v !== 'string') throw new AcpError('bad_config', `acp: agent "${id}" env.${k} must be a string`)
      env[k] = v
    }
  }
  const permission = row.permission ?? 'ask'
  if (permission !== 'ask' && permission !== 'allow' && permission !== 'reject') {
    throw new AcpError('bad_config', `acp: agent "${id}" permission must be ask|allow|reject`)
  }
  const cwd = row.cwd
  if (cwd !== undefined && (typeof cwd !== 'string' || !cwd.startsWith('/'))) {
    throw new AcpError('bad_config', `acp: agent "${id}" cwd must be an absolute path`)
  }
  const roots = row.allowedCwdRoots ?? (typeof cwd === 'string' ? [cwd] : [])
  if (!Array.isArray(roots) || roots.some(r => typeof r !== 'string' || !r.startsWith('/'))) {
    throw new AcpError('bad_config', `acp: agent "${id}" allowedCwdRoots must be absolute paths`)
  }
  const title = typeof row.title === 'string' && row.title !== '' ? row.title : id
  return {
    id,
    title,
    command: row.command as string,
    args: args as string[],
    env,
    permission: permission as AcpAgentDef['permission'],
    cwd: cwd as string | undefined,
    allowedCwdRoots: roots as string[],
  }
}

/** Validate the raw plugin config; throws AcpError on any violation (boot fails loudly). */
export function validateConfig(raw: unknown): AcpPluginConfig {
  const value = (raw ?? {}) as Record<string, unknown>
  const agentsRaw = value.agents ?? []
  if (!Array.isArray(agentsRaw)) throw new AcpError('bad_config', 'acp: config.agents must be an array')
  const seen = new Set<string>()
  const agents: AcpAgentDef[] = agentsRaw.map((entry, index) => {
    const def = validateAgentDef(entry, `agents[${String(index)}]`)
    if (seen.has(def.id)) throw new AcpError('bad_config', `acp: duplicate agent id "${def.id}"`)
    seen.add(def.id)
    return def
  })
  const max = value.transcriptMaxEntries ?? 600
  if (typeof max !== 'number' || !Number.isInteger(max) || max < 50 || max > 100_000) {
    throw new AcpError('bad_config', 'acp: transcriptMaxEntries must be an integer in [50, 100000]')
  }
  return { agents, transcriptMaxEntries: max }
}

// ---- Workspace guard ----

/**
 * Resolve the requested session cwd against the agent's allowed roots.
 * @param def - validated agent definition.
 * @param requested - browser-supplied cwd (optional; `''`/undefined → default).
 * @param realpath - platform realpath (injected; throws if the path is unusable).
 * @returns the canonical absolute directory to hand to `session/new`.
 */
export function resolveSessionCwd(def: AcpAgentDef, requested: string | undefined, realpath: (p: string) => string): string {
  const candidate = requested === undefined || requested === '' ? def.cwd : requested
  if (candidate === undefined) throw new AcpError('no_cwd', `acp: agent "${def.id}" has no default cwd; pass one`)
  if (!candidate.startsWith('/')) throw new AcpError('bad_cwd', 'acp: session cwd must be absolute')
  let canonical: string
  try {
    canonical = realpath(candidate)
  } catch {
    throw new AcpError('bad_cwd', `acp: cwd does not exist: ${candidate}`)
  }
  const roots = (def.allowedCwdRoots ?? []).length > 0 ? (def.allowedCwdRoots ?? []) : (def.cwd !== undefined ? [def.cwd] : [])
  if (roots.length === 0) throw new AcpError('no_roots', `acp: agent "${def.id}" has no allowedCwdRoots configured`)
  const inside = roots.some(root => {
    const canonicalRoot = safeRealpath(realpath, root)
    return canonical === canonicalRoot || canonical.startsWith(`${canonicalRoot.replace(/\/+$/, '')}/`)
  })
  if (!inside) throw new AcpError('cwd_denied', `acp: cwd ${canonical} is outside agent "${def.id}" allowed roots`)
  return canonical
}

function safeRealpath(realpath: (p: string) => string, p: string): string {
  try {
    return realpath(p)
  } catch {
    return p.replace(/\/+$/, '')
  }
}

// ---- Child environment ----

/**
 * Credential-scrubbed copy of the parent env, matching the harness subprocess
 * boundary: anything shaped like a secret and every ambient `DSH_*` deployment
 * fact is dropped; the agent's configured env merges back on top.
 */
export function childEnv(parent: NodeJS.ProcessEnv, extra: Record<string, string>): Record<string, string> {
  const SENSITIVE = /KEY|PASSWORD|SECRET|TOKEN/i
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(parent)) {
    if (v === undefined) continue
    if (SENSITIVE.test(k) || k.toUpperCase().startsWith('DSH_')) continue
    out[k] = v
  }
  for (const [k, v] of Object.entries(extra)) out[k] = v
  return out
}

// ---- Transcript ----

/** Bounded append-only log of raw ACP session updates with monotone seq. */
export class Transcript {
  private readonly entries: Array<{ seq: number; update: unknown }> = []
  private next = 1

  constructor(private readonly max: number) {}

  append(update: unknown): number {
    const seq = this.next++
    this.entries.push({ seq, update })
    if (this.entries.length > this.max) this.entries.splice(0, this.entries.length - this.max)
    return seq
  }

  get head(): number {
    return this.next - 1
  }

  since(afterSeq: number): Array<{ seq: number; update: unknown }> {
    return this.entries.filter(e => e.seq > afterSeq)
  }
}

// ---- Event hub ----

export class EventHub {
  private readonly sinks = new Set<(event: AcpEvent) => void>()

  subscribe(sink: (event: AcpEvent) => void): () => void {
    this.sinks.add(sink)
    return () => { this.sinks.delete(sink) }
  }

  broadcast(event: AcpEvent): void {
    for (const sink of [...this.sinks]) {
      try {
        sink(event)
      } catch {
        // A broken subscriber must never stall protocol pumping.
      }
    }
  }
}

// ---- Permission ledger ----

export interface PendingPermission {
  requestId: string
  sessionId: string
  resolve: (outcome: PermissionOutcome) => void
}

export class PermissionLedger {
  private readonly pending = new Map<string, PendingPermission>()

  create(sessionId: string, executor: (outcome: PermissionOutcome) => void): string {
    const requestId = randomUUID()
    this.pending.set(requestId, { requestId, sessionId, resolve: executor })
    return requestId
  }

  respond(requestId: string, outcome: PermissionOutcome): true {
    const entry = this.pending.get(requestId)
    if (entry === undefined) throw new AcpError('unknown_request', `acp: no pending permission ${requestId}`)
    this.pending.delete(requestId)
    entry.resolve(outcome)
    return true
  }

  settleFor(predicate: (p: { requestId: string; sessionId: string }) => boolean): string[] {
    const settled: string[] = []
    for (const [id, entry] of [...this.pending]) {
      if (!predicate(entry)) continue
      this.pending.delete(id)
      entry.resolve({ outcome: 'cancelled' })
      settled.push(id)
    }
    return settled
  }

  sessionIds(): Array<{ requestId: string; sessionId: string }> {
    return [...this.pending.values()].map(e => ({ requestId: e.requestId, sessionId: e.sessionId }))
  }
}

// ---- RPC surface ----

/** The bridge-manager face the dispatcher talks to (interface keeps dispatch pure-testable). */
export interface AcpManager {
  agentViews(): AgentView[]
  startSession(agentId: string, cwd: string | undefined): Promise<{ sessionId: string }>
  prompt(sessionId: string, text: string): Promise<{ turnId: string }>
  cancel(sessionId: string): Promise<void>
  closeSession(sessionId: string): Promise<void>
  setMode(sessionId: string, modeId: string): Promise<void>
  setConfigOption(sessionId: string, configId: string, value: string | boolean): Promise<void>
  respondPermission(requestId: string, optionId: string | undefined): void
  transcript(sessionId: string, afterSeq: number | undefined): { session: unknown; entries: Array<{ seq: number; update: unknown }> }
  sessions(): unknown[]
  stopAgent(agentId: string): Promise<void>
  getDefaultModel?(): Promise<{ provider?: string; model?: string }>
  setDefaultModel?(agentId: string): Promise<void>
  setPermission?(agentId: string, permission: PermissionMode): Promise<void>
  detectAgents?(): Promise<DetectedAgentInfo[]>
  saveAgent?(def: AcpAgentDef): Promise<void>
  deleteAgent?(agentId: string): Promise<void>
}

function ok<T>(value: T): RpcResult<T> {
  return { ok: true, value }
}

function fail(code: string, message: string): RpcResult<never> {
  return { ok: false, error: { code, message, details: {} } }
}

/** String payload field with a length bound (defensive against oversized bodies). */
function str(payload: Record<string, unknown>, key: string, maxLen: number): string {
  const value = payload[key]
  if (typeof value !== 'string') throw new AcpError('bad_payload', `acp: ${key} must be a string`)
  if (value.length > maxLen) throw new AcpError('bad_payload', `acp: ${key} exceeds ${String(maxLen)} chars`)
  return value
}

function optionalStr(payload: Record<string, unknown>, key: string, maxLen: number): string | undefined {
  const value = payload[key]
  if (value === undefined || value === '') return undefined
  if (typeof value !== 'string') throw new AcpError('bad_payload', `acp: ${key} must be a string`)
  if (value.length > maxLen) throw new AcpError('bad_payload', `acp: ${key} exceeds ${String(maxLen)} chars`)
  return value
}

/** Dispatch one decoded `/acp` channel call. Never rejects; protocol errors come back as `ok:false`. */
export async function dispatchRpc(manager: AcpManager, endpoint: string, payload: unknown): Promise<RpcResult<unknown>> {
  const body = (typeof payload === 'object' && payload !== null ? payload : {}) as Record<string, unknown>
  try {
    switch (endpoint) {
      case 'agents/list':
        return ok({ agents: manager.agentViews() })
      case 'agents/detect':
        return ok({ agents: await (manager.detectAgents?.() ?? Promise.resolve([])) })
      case 'agent/save': {
        const def = validateAgentDef(body)
        await manager.saveAgent?.(def)
        return ok({ done: true })
      }
      case 'agent/delete': {
        const agentId = str(body, 'agentId', 64)
        await manager.deleteAgent?.(agentId)
        return ok({ done: true })
      }
      case 'session/start':
        return ok(await manager.startSession(str(body, 'agentId', 64), optionalStr(body, 'cwd', 4096)))
      case 'session/prompt': {
        const { turnId } = await manager.prompt(str(body, 'sessionId', 64), str(body, 'text', 1 << 20))
        return ok({ accepted: true as const, turnId })
      }
      case 'session/cancel':
        await manager.cancel(str(body, 'sessionId', 64)); return ok({ done: true })
      case 'session/close':
        await manager.closeSession(str(body, 'sessionId', 64)); return ok({ done: true })
      case 'session/mode-set':
        await manager.setMode(str(body, 'sessionId', 64), str(body, 'modeId', 128)); return ok({ done: true })
      case 'session/config-set': {
        const value = body.value
        if (typeof value !== 'string' && typeof value !== 'boolean') throw new AcpError('bad_payload', 'acp: value must be string|boolean')
        await manager.setConfigOption(str(body, 'sessionId', 64), str(body, 'configId', 128), value)
        return ok({ done: true })
      }
      case 'permission/respond':
        return ok({ done: manager.respondPermission(str(body, 'requestId', 64), optionalStr(body, 'optionId', 128)) })
      case 'transcript/get': {
        const after = body.afterSeq
        if (after !== undefined && typeof after !== 'number') throw new AcpError('bad_payload', 'acp: afterSeq must be a number')
        return ok(manager.transcript(str(body, 'sessionId', 64), after as number | undefined))
      }
      case 'sessions/list':
        return ok({ sessions: manager.sessions() })
      case 'agent/stop':
        await manager.stopAgent(str(body, 'agentId', 64)); return ok({ done: true })
      case 'model/get-default':
        return ok(await (manager.getDefaultModel?.() ?? Promise.resolve({})))
      case 'model/set-default': {
        const agentId = str(body, 'agentId', 64)
        await manager.setDefaultModel?.(agentId)
        return ok({ done: true })
      }
      case 'agent/set-permission': {
        const agentId = str(body, 'agentId', 64)
        const permission = str(body, 'permission', 16)
        if (permission !== 'ask' && permission !== 'allow' && permission !== 'reject') {
          throw new AcpError('bad_payload', 'acp: permission must be ask|allow|reject')
        }
        await manager.setPermission?.(agentId, permission as PermissionMode)
        return ok({ done: true })
      }
      default:
        return fail('unknown_endpoint', `acp: unknown endpoint ${endpoint}`)
    }
  } catch (error) {
    if (error instanceof AcpError) return fail(error.code, error.message)
    return fail('internal', error instanceof Error ? error.message : String(error))
  }
}
