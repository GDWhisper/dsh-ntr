/**
 * Pure host-side logic for dsh-ntr: config validation, workspace guard,
 * credential-scrubbed child env, capped transcript, event hub, and the RPC
 * dispatcher. No Node imports, no SDK imports — everything here is testable
 * with plain fakes.
 */

import { randomUUID } from './ids.ts'
import type {
  AcpAgentCatalog, AcpAgentDef, AcpEvent, AcpPluginConfig, AcpPresetStatus, AgentCatalogResult, AgentProbeModelsResult, AgentTestResult,
  AgentView, ChatSessionView, ChatTranscriptView, DetectedAgentInfo, PermissionMode, PermissionOutcome, RpcResult,
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
/**
 * npm package name (optionally `@scope/name`, optionally `@version`/`@tag`).
 * Deliberately charset-only (letters, digits, `.`, `_`, `-`, `/`, `@`): this
 * string is handed to `npm install -g` as a spawn argument, and on Windows the
 * installer runs with a shell — a charset this narrow leaves no injection
 * surface. Length 214 is npm's own hard limit.
 */
const NPM_PACKAGE_PATTERN = /^(@[a-zA-Z0-9][a-zA-Z0-9._-]*\/)?[a-zA-Z0-9][a-zA-Z0-9._-]*(@[a-zA-Z0-9][a-zA-Z0-9._-]*)?$/

/**
 * Per-value sanity bound for one `exposedModels` entry. Well above any real
 * model choice value (the longest observed in the wild is 61 chars) but still
 * small enough to refuse a hostile blob.
 */
const EXPOSED_MODEL_VALUE_MAX = 512

/**
 * Total size guard for one `exposedModels` filter.
 *
 * Deliberately a *size* bound and not an entry cap: the number of legitimate
 * values is the agent's own `category: model` choice count, which is unbounded
 * (pi publishes 500 choices, omp 581), so any fixed entry cap is a cap the
 * settings panel can exceed — it would then offer a selection the host refuses
 * with `bad_payload` (the "只显示我选的模型" / "全选" paths send every choice at
 * once). A 1 MiB list is already far beyond any catalog and is the shape a
 * caller would need to abuse the endpoint.
 */
const EXPOSED_MODELS_TOTAL_MAX = 1 << 20

/**
 * Validate and normalize one `exposedModels` filter (order preserved,
 * duplicates dropped).
 *
 * Shared by the persisted-config validator and the `agent/set-exposed-models`
 * RPC route so the two can never drift apart: a filter the panel can build must
 * be accepted by every layer that sees it — including `loadPersistedAgents`,
 * which re-validates the stored config on every boot (a mismatch there silently
 * drops the whole agent definition).
 */
export function normalizeExposedModels(raw: unknown, label: string, code: 'bad_config' | 'bad_payload'): string[] {
  if (!Array.isArray(raw)) throw new AcpError(code, `acp: ${label} must be an array of model choice values`)
  const seen = new Set<string>()
  const out: string[] = []
  let total = 0
  for (const value of raw) {
    if (typeof value !== 'string' || value === '' || value.length > EXPOSED_MODEL_VALUE_MAX) {
      throw new AcpError(code, `acp: ${label} entries must be non-empty strings of at most ${String(EXPOSED_MODEL_VALUE_MAX)} chars`)
    }
    total += value.length
    if (total > EXPOSED_MODELS_TOTAL_MAX) {
      throw new AcpError(code, `acp: ${label} is too large (over ${String(EXPOSED_MODELS_TOTAL_MAX)} chars in total)`)
    }
    if (seen.has(value)) continue
    seen.add(value)
    out.push(value)
  }
  return out
}

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
  const npmPackageRaw = row.npmPackage
  if (npmPackageRaw !== undefined && (typeof npmPackageRaw !== 'string' || npmPackageRaw.length > 214)) {
    throw new AcpError('bad_config', `acp: agent "${id}" npmPackage must be a string of at most 214 chars`)
  }
  const npmPackage = npmPackageRaw === undefined || (npmPackageRaw as string).trim() === ''
    ? undefined
    : (npmPackageRaw as string).trim()
  if (npmPackage !== undefined && !NPM_PACKAGE_PATTERN.test(npmPackage)) {
    throw new AcpError('bad_config', `acp: agent "${id}" npmPackage "${npmPackage}" is not a valid npm package name`)
  }
  const exposedModels = row.exposedModels === undefined
    ? undefined
    : normalizeExposedModels(row.exposedModels, `agent "${id}" exposedModels`, 'bad_config')
  // Per-agent idle-release window. Kept optional so a stored config from before
  // this field existed still validates (it falls back to the host default).
  const idleTimeoutMs = row.idleTimeoutMs
  if (idleTimeoutMs !== undefined && (typeof idleTimeoutMs !== 'number' || !Number.isInteger(idleTimeoutMs)
    || idleTimeoutMs > 86_400_000 || (idleTimeoutMs !== 0 && idleTimeoutMs < 1_000))) {
    throw new AcpError('bad_config', `acp: agent "${id}" idleTimeoutMs must be 0 (never release) or an integer in [1000, 86400000]`)
  }
  return {
    id,
    title,
    command: row.command as string,
    args: args as string[],
    ...(npmPackage !== undefined ? { npmPackage } : {}),
    env,
    permission: permission as AcpAgentDef['permission'],
    cwd: cwd as string | undefined,
    allowedCwdRoots: roots as string[],
    ...(exposedModels !== undefined ? { exposedModels } : {}),
    ...(idleTimeoutMs === undefined ? {} : { idleTimeoutMs: idleTimeoutMs as number }),
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
  const probeModelsOnBoot = value.probeModelsOnBoot ?? true
  if (typeof probeModelsOnBoot !== 'boolean') {
    throw new AcpError('bad_config', 'acp: probeModelsOnBoot must be a boolean')
  }
  const startupTimeoutMs = value.startupTimeoutMs ?? 60_000
  if (typeof startupTimeoutMs !== 'number' || !Number.isFinite(startupTimeoutMs) || startupTimeoutMs < 1_000 || startupTimeoutMs > 600_000) {
    throw new AcpError('bad_config', 'acp: startupTimeoutMs must be a number in [1000, 600000]')
  }
  const permissionTimeoutMs = value.permissionTimeoutMs ?? 0
  if (typeof permissionTimeoutMs !== 'number' || !Number.isInteger(permissionTimeoutMs) || permissionTimeoutMs < 0 || permissionTimeoutMs > 86_400_000) {
    throw new AcpError('bad_config', 'acp: permissionTimeoutMs must be an integer in [0, 86400000] (0 = wait forever)')
  }
  const cancelFallbackMs = value.cancelFallbackMs ?? 15_000
  if (typeof cancelFallbackMs !== 'number' || !Number.isInteger(cancelFallbackMs) || cancelFallbackMs < 0 || cancelFallbackMs > 600_000) {
    throw new AcpError('bad_config', 'acp: cancelFallbackMs must be an integer in [0, 600000] (0 = disable the fallback)')
  }
  const installAcpPreset = value.installAcpPreset ?? true
  if (typeof installAcpPreset !== 'boolean') {
    throw new AcpError('bad_config', 'acp: installAcpPreset must be a boolean')
  }
  return {
    agents,
    transcriptMaxEntries: max,
    probeModelsOnBoot,
    startupTimeoutMs,
    permissionTimeoutMs,
    cancelFallbackMs,
    installAcpPreset,
  }
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

/** Pure path join with lexical `..`/`.` collapse (impl.ts cannot import node:path). */
function joinWithin(base: string, rel: string): string {
  const stack: string[] = []
  for (const seg of `${base.replace(/\/+$/, '')}/${rel.replace(/^\/+/, '')}`.split('/')) {
    if (seg === '') continue
    if (seg === '.') continue
    if (seg === '..') stack.pop()
    else stack.push(seg)
  }
  return `/${stack.join('/')}`
}

/**
 * Canonicalize a path requested by an ACP agent (fs/read_text_file,
 * fs/write_text_file) against the session workspace — no containment check.
 *
 * Relative paths join under `sessionCwd`; the collapsed path is canonicalized
 * by realpath up to the nearest existing ancestor (collapsing symlinks and any
 * surviving `..`), with the missing tail re-attached lexically — so a fresh
 * write target with not-yet-created parent directories still validates, and a
 * symlink pointing outside the workspace resolves to its real location (where
 * the containment check then judges it).
 */
export function canonicalizeFsPath(sessionCwd: string, requested: string, realpath: (p: string) => string): string {
  if (typeof requested !== 'string' || requested === '') {
    throw new AcpError('bad_path', 'acp: fs path must be a non-empty string')
  }
  const collapsed = requested.startsWith('/') ? joinWithin('/', requested) : joinWithin(sessionCwd, requested)
  const segments = collapsed.split('/').filter(s => s !== '')
  let canonical: string | undefined
  let consumed = 0
  for (let i = segments.length; i >= 0; i--) {
    try {
      canonical = realpath(i === 0 ? '/' : `/${segments.slice(0, i).join('/')}`)
      consumed = i
      break
    } catch { /* walk up to the nearest existing ancestor */ }
  }
  if (canonical === undefined) {
    throw new AcpError('bad_path', `acp: fs path does not exist: ${requested}`)
  }
  const tail = segments.slice(consumed)
  return tail.length === 0 ? canonical : `${canonical.replace(/\/+$/, '')}/${tail.join('/')}`
}

/**
 * {@link canonicalizeFsPath} plus the allowed-root containment check: escaping
 * the roots throws (`cwd_denied`) and the caller answers the agent's request
 * with that error instead of touching the disk.
 *
 * The split from canonicalization exists because containment is conditional on
 * the resolved access mode — under DSH's `danger-full-access` the canonical path
 * is used as-is (that mode's whole promise is "no restriction"), while every
 * other mode keeps the agent's own `allowedCwdRoots` as a hard cap.
 */
export function resolveFsPath(sessionCwd: string, roots: readonly string[], requested: string, realpath: (p: string) => string): string {
  const full = canonicalizeFsPath(sessionCwd, requested, realpath)
  const inside = roots.some(root => {
    const canonicalRoot = safeRealpath(realpath, root)
    return full === canonicalRoot || full.startsWith(`${canonicalRoot.replace(/\/+$/, '')}/`)
  })
  if (!inside) throw new AcpError('cwd_denied', `acp: fs path ${full} is outside the session workspace`)
  return full
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

// ---- Model catalog (pure parsing of ACP `configOptions`) ----

/**
 * Extract the `model` and `thought_level` select options from a raw ACP
 * `configOptions` payload. Tolerant by design: unknown categories, boolean
 * options, grouped choices, missing `name`, and the legacy `id` field (pre-
 * spec agents) are all handled; anything unusable is skipped silently.
 */
export function parseCatalogOptions(configOptions: unknown): AcpAgentCatalog {
  const out: AcpAgentCatalog = {}
  if (!Array.isArray(configOptions)) return out
  for (const raw of configOptions) {
    if (typeof raw !== 'object' || raw === null) continue
    const row = raw as Record<string, unknown>
    const category = typeof row.category === 'string' ? row.category : undefined
    const slot = category === 'model' ? 'model' : category === 'thought_level' ? 'thought' : undefined
    if (slot === undefined) continue
    const configIdRaw = row.configId ?? row.id
    if (typeof configIdRaw !== 'string' && typeof configIdRaw !== 'number') continue
    const configId = String(configIdRaw)
    if (configId === '') continue
    const choices: NonNullable<AcpAgentCatalog['model']>['choices'] = []
    collectCatalogChoices(row.options, choices)
    out[slot] = {
      configId,
      name: typeof row.name === 'string' && row.name !== '' ? row.name : configId,
      currentValue: typeof row.currentValue === 'string' && row.currentValue !== '' ? row.currentValue : null,
      choices,
    }
  }
  return out
}

/** Flatten select `options` (plain values or `SessionConfigSelectGroup`s) into choices, deduped by value. */
function collectCatalogChoices(options: unknown, out: NonNullable<AcpAgentCatalog['model']>['choices']): void {
  if (!Array.isArray(options)) return
  for (const raw of options) {
    if (typeof raw !== 'object' || raw === null) continue
    const row = raw as Record<string, unknown>
    if (Array.isArray(row.options)) {
      // Grouped form: flatten the inner values, borrowing the group label as fallback description.
      for (const inner of row.options) {
        if (typeof inner !== 'object' || inner === null) continue
        pushCatalogChoice(inner as Record<string, unknown>, out, typeof row.name === 'string' ? row.name : undefined)
      }
      continue
    }
    pushCatalogChoice(row, out)
  }
}

function pushCatalogChoice(row: Record<string, unknown>, out: NonNullable<AcpAgentCatalog['model']>['choices'], groupLabel?: string): void {
  const value = row.value
  if (typeof value !== 'string' || value === '') return
  if (out.some(c => c.value === value)) return
  const description = typeof row.description === 'string' && row.description !== '' ? row.description : groupLabel
  out.push({
    value,
    name: typeof row.name === 'string' && row.name !== '' ? row.name : value,
    ...(description !== undefined ? { description } : {}),
    // The group label is kept on its own field (commonly the vendor) so the
    // settings panel can filter by it even when the choice has its own text.
    // Only real ACP `SessionConfigSelectGroup` labels land here — no guessing:
    // any vendor may serve another vendor's models, so synthesizing buckets
    // from name prefixes or value paths would misclassify.
    ...(groupLabel !== undefined ? { group: groupLabel } : {}),
  })
}

/**
 * Split an adapter model id into its agent id and optional model choice.
 * `@` is the separator because agent ids are restricted to `[a-z0-9._-]`.
 */
export function splitAdapterModelId(model: string): { agentId: string; choice?: string } {
  const at = model.indexOf('@')
  if (at <= 0) return { agentId: model }
  return { agentId: model.slice(0, at), choice: model.slice(at + 1) }
}

/** Inverse of {@link splitAdapterModelId} for variant entries. */
export function buildAdapterModelId(agentId: string, choice: string): string {
  return `${agentId}@${choice}`
}

// ---- host request → forwarded ACP prompt ----

/**
 * Outcome of picking the one message an ACP turn forwards.
 *
 * `no-user-input` is its own case, not an error: the host wakes a driver for
 * injected context too (goal/subagent/skill material), and that turn carries no
 * user intent to send anywhere.
 */
export type ForwardPromptSelection =
  | { kind: 'prompt'; text: string; id?: string }
  | { kind: 'no-user-input' }
  | { kind: 'empty' }

/**
 * Select the user's own words out of a host-built request.
 *
 * Why this exists (AGENTS.md rule 16): the host appends its context sections
 * *after* the claimed user batch — `agent-instructions` folds its digest right
 * behind the prompt, and the driver appends the runtime-context snapshot after
 * that — so "the last user-role message" is routinely an injected section, not
 * the prompt. Only the message's `source` distinguishes them: `kind: 'user'` is
 * the person, anything else (`plugin`, `skill-catalog`, `agent-instructions`,
 * `tool`, …) is harness context. An absent source means a hand-built request
 * (tests, headless callers) and counts as user input.
 *
 * @param messages - the request's ordered messages, exactly as the host built them.
 * @returns the last real user message's text, or why there is none to forward.
 */
export function selectForwardPrompt(messages: readonly {
  role: string
  content?: Array<{ type?: string; text?: string }>
  source?: { kind?: string }
  id?: string
}[]): ForwardPromptSelection {
  let sawUserRole = false
  let last: { text: string; id?: string } | undefined
  for (const message of messages) {
    if (message.role !== 'user') continue
    sawUserRole = true
    const kind = message.source?.kind
    if (kind !== undefined && kind !== 'user') continue
    const text = (message.content ?? [])
      .filter(block => block.type === 'text' && typeof block.text === 'string')
      .map(block => block.text as string)
      .join('\n')
      .trim()
    if (text === '') continue
    last = { text, ...(message.id === undefined ? {} : { id: message.id }) }
  }
  if (last !== undefined) return { kind: 'prompt', ...last }
  return sawUserRole ? { kind: 'no-user-input' } : { kind: 'empty' }
}

// ---- DSH access mode → ACP permission decision ----

/**
 * DSH's file-effect mode vocabulary, mirrored from `@deepseek-ai/dsh-sandbox`
 * (`SandboxMode`). Host-only: the browser never sees a mode, only whether the
 * routing is active (`AcpManager.accessModeRouting`).
 */
export type DshSandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access'

/**
 * DSH's approval-policy vocabulary (`@deepseek-ai/dsh-user-approval`). `never`
 * is the important one: the host's `ApprovalService` resolves every ask to
 * `'rejected'` deterministically and never reaches an answerer, so routing an
 * ACP ask through `ctx.approval` under `never` would silently deny it.
 */
export type DshApprovalPolicy = 'ask' | 'never'

/**
 * The access mode one DSH chat session runs under, resolved per turn by the
 * host entry: the session's `sandbox/mode` + `approval/policy` folds over the
 * composition defaults, plus the workspace root `workspace-write` confines
 * writes to.
 */
export interface DshSessionPolicy {
  mode: DshSandboxMode
  approval: DshApprovalPolicy
  /** Absolute root `workspace-write` may write under; absent when the host did not report one. */
  workspaceRoot?: string
}

/** What one ACP permission ask resolves to before the routing layer runs. */
export type PermissionDecision = 'ask' | 'allow' | 'reject'

/** ACP `ToolCall.kind` values that are known to take a file effect. */
const WRITE_TOOL_KINDS = new Set(['edit', 'delete', 'move'])

/** ACP `ToolCall.kind` values that provably take no file effect. */
const READ_TOOL_KINDS = new Set(['read', 'search', 'think', 'fetch', 'switch_mode'])

/** Structural read of ACP `ToolCall.kind`; anything unexpected stays `undefined` (= effect unknown). */
export function permissionToolKind(toolCall: unknown): string | undefined {
  const kind = (toolCall as { kind?: unknown } | null | undefined)?.kind
  return typeof kind === 'string' && kind !== '' ? kind : undefined
}

/** Structural read of ACP `ToolCall.locations[].path` — where an edit claims it will write. */
export function permissionToolPaths(toolCall: unknown): string[] {
  const locations = (toolCall as { locations?: unknown } | null | undefined)?.locations
  if (!Array.isArray(locations)) return []
  const out: string[] = []
  for (const entry of locations) {
    const path = (entry as { path?: unknown } | null | undefined)?.path
    if (typeof path === 'string' && path !== '') out.push(path)
  }
  return out
}

/** Lexical containment test for the mode's workspace boundary (the enforced paths are already canonical). */
export function isUnderPath(path: string, root: string): boolean {
  if (!root.startsWith('/')) return false
  const trimmed = root.replace(/\/+$/, '')
  if (trimmed === '') return path.startsWith('/')
  return path === trimmed || path.startsWith(`${trimmed}/`)
}

/** The slice of a host session log the access-mode fold reads. */
export interface AccessModeSessionLike {
  events?: readonly unknown[]
  /** Creation header; carries the agent preset the session started under. */
  header?: { agentPreset?: unknown }
}

/**
 * The agent preset a session actually runs.
 *
 * Mirrors `resolveSessionPreset` from `@deepseek-ai/dsh-agent-presets`
 * structurally (no dependency): the newest `agent-preset/selected` log event
 * wins over the creation-time header, because a blank session may be recomposed
 * and the header is by design a frozen creation fact.
 *
 * This is how the host half knows a chat session is in ACP mode: the mode IS an
 * agent preset, so reading it back from the session log is the only honest
 * source — a marker we set ourselves could drift from what the roster mounted.
 */
export function sessionAgentPreset(session: AccessModeSessionLike | undefined): string | undefined {
  const events = session?.events
  if (Array.isArray(events)) {
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index] as { type?: unknown; data?: { agentPreset?: unknown } } | undefined
      if (event?.type !== 'agent-preset/selected') continue
      const selected = event.data?.agentPreset
      return typeof selected === 'string' ? selected : undefined
    }
  }
  return sessionAgentPresetFromLog(session?.header?.agentPreset, [])
}

/**
 * Fold a preset from a RAW stored header plus already-decoded log events —
 * the cold-read path: `sessionPersistence` hands back the header verbatim and
 * `SessionHandle.read` returns raw event objects, neither of which is a host
 * `Session`, so {@link sessionAgentPreset} does not apply.
 */
export function sessionAgentPresetFromLog(headerPreset: unknown, events: readonly unknown[]): string | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index] as { type?: unknown; data?: { agentPreset?: unknown } } | undefined
    if (event?.type !== 'agent-preset/selected') continue
    const selected = event.data?.agentPreset
    return typeof selected === 'string' ? selected : undefined
  }
  return typeof headerPreset === 'string' ? headerPreset : undefined
}

/**
 * The session's effective approval policy: its own last `approval/policy` event
 * wins, else the service's configured default — the fold
 * `ApprovalService.effectivePolicy` performs (`overrideOf ?? config.policy`),
 * done structurally so this plugin needs no dependency on the package.
 *
 * The distinction matters because `never` is not a preference: the host resolves
 * every ask under it to `'rejected'` before any answerer runs.
 */
export function dshApprovalPolicyOf(session: AccessModeSessionLike | undefined, configuredDefault: string | undefined): DshApprovalPolicy {
  const events = session?.events
  if (Array.isArray(events)) {
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index] as { type?: unknown; data?: { policy?: unknown } } | undefined
      if (event?.type !== 'approval/policy') continue
      return event.data?.policy === 'never' ? 'never' : 'ask'
    }
  }
  return configuredDefault === 'never' ? 'never' : 'ask'
}

/**
 * Assemble one chat session's access-mode snapshot from what the host's policy
 * service resolved plus the session's own log.
 *
 * @param resolved - the host's `sandboxPolicy.resolve({session})` payload.
 * @param session - the host session (for the approval-policy override).
 * @param configuredDefault - the approval service's deployment default.
 * @returns the snapshot, or `undefined` when the host reported a mode outside
 *   the vocabulary (unexpected or newer host) — the caller then leaves the
 *   agent's own `permission` field in charge instead of guessing a boundary.
 */
export function dshSessionPolicyOf(
  resolved: { mode?: unknown; workspaceRoot?: unknown },
  session: AccessModeSessionLike | undefined,
  configuredDefault: string | undefined,
): DshSessionPolicy | undefined {
  const mode = resolved.mode
  if (mode !== 'read-only' && mode !== 'workspace-write' && mode !== 'danger-full-access') return undefined
  const root = resolved.workspaceRoot
  return {
    mode,
    approval: dshApprovalPolicyOf(session, configuredDefault),
    ...(typeof root === 'string' && root !== '' ? { workspaceRoot: root } : {}),
  }
}

/**
 * Mirror of `@deepseek-ai/dsh-sandbox`'s `sandboxDenialMarker`: the dialect DSH
 * uses to tell a model "the sandbox blocked this, it is a policy denial, not a
 * bug". Reusing the exact spelling keeps one vocabulary for both halves.
 */
export function sandboxDenialMarker(mode: DshSandboxMode): string {
  return `[sandbox: file access denied under ${mode} mode]`
}

/**
 * Map DSH's access mode onto one ACP permission ask.
 *
 * A chat session's mode is the source of truth whenever one is available (that
 * is the entire point of the mapping — see
 * `docs/acp-permission-and-sandbox.md`), because the alternative is what this
 * replaced: a per-agent policy that made "full access" deny everything (the
 * host answers `never` asks with `'rejected'`) and "read-only" grant writes.
 *
 * The mode supplies the boundary, `approval` supplies whether a human is
 * asked at it:
 *
 * - `danger-full-access` — everything is allowed, no prompt.
 * - known read-only kinds (`read` / `search` / `think` / `fetch` /
 *   `switch_mode`) — allowed in every mode: no mode restricts reading.
 * - known write kinds — allowed outright only when the mode is
 *   `workspace-write` AND every declared location is inside the workspace root
 *   (what that mode exists to permit); otherwise a human decides (`ask`) or it
 *   is denied (`never`).
 * - effect unknown (`execute`, `other`, a missing kind) — `workspace-write`
 *   allows it (DSH lets bash run there and confines it at the kernel instead,
 *   which we cannot do to an agent's own tools), `read-only` asks or denies.
 *
 * @param policy - the session's resolved DSH access mode.
 * @param kind - ACP tool-call kind, when the agent declared one.
 * @param paths - declared write locations (see {@link permissionToolPaths}).
 * @param options - `narrateOnly` is the ACP-mode rule: the mode stays out of
 *   the arbitration entirely, so every ask the agent raises reaches the human
 *   (`ask`) instead of being auto-allowed or auto-denied by our boundary
 *   arithmetic. (The flag's name is older than this — nothing is narrated into
 *   the prompt any more; it is enforcement-only.) Under `approval: 'never'` the
 *   host cannot ask anybody —
 *   `ApprovalService.decide` resolves every ask to `'rejected'` before an
 *   answerer runs — so a quiet local `reject` stays the honest answer there.
 * @returns the decision the bridge enacts.
 */
export function decidePermission(
  policy: DshSessionPolicy,
  kind: string | undefined,
  paths: readonly string[] = [],
  options: { narrateOnly?: boolean } = {},
): PermissionDecision {
  if (policy.mode === 'danger-full-access') return 'allow'
  if (kind !== undefined && READ_TOOL_KINDS.has(kind)) return 'allow'
  if (options.narrateOnly === true) return policy.approval === 'ask' ? 'ask' : 'reject'
  if (kind !== undefined && WRITE_TOOL_KINDS.has(kind)) {
    const root = policy.workspaceRoot
    if (policy.mode === 'workspace-write' && root !== undefined && paths.length > 0 && paths.every(p => isUnderPath(p, root))) {
      return 'allow'
    }
    return policy.approval === 'ask' ? 'ask' : 'reject'
  }
  // Effect unknown: only the read-only mode has a boundary strict enough that
  // running it unexamined would break the mode's promise.
  if (policy.mode === 'read-only') return policy.approval === 'ask' ? 'ask' : 'reject'
  return 'allow'
}

// The session's access mode is deliberately **not** narrated into the prompt we
// forward: the agent sees the user's own words and nothing else. The mode is
// enforced (see {@link decidePermission} and the bridge's `authorizeWrite`), and
// it is enforced as a fence rather than announced as a boundary — an agent that
// never reaches the fence never needed the sentence.

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

  has(requestId: string): boolean {
    return this.pending.has(requestId)
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
  /**
   * Spawn a throwaway process from raw form values (never persisted, never
   * registered), run the ACP handshake, tear it down, and report the outcome.
   * May trigger the def's npm auto-install.
   */
  testAgent?(def: AcpAgentDef): Promise<AgentTestResult>
  /** Update which probed model choices the ACP seats offer; `undefined` clears the filter. Must not restart the agent. */
  setExposedModels?(agentId: string, exposedModels: readonly string[] | undefined): Promise<void>
  probeAgentModels?(agentId: string): Promise<AgentProbeModelsResult>
  /**
   * The ACP model surface for one agent (the seats' data source): base entry,
   * the `exposedModels` variants, and the agent's own reasoning efforts.
   * Memory-only — never spawns; an agent without a cached catalog gets a
   * background probe so the next read is complete.
   */
  agentCatalog(agentId: string): AgentCatalogResult
  /**
   * True when ACP permission asks are routed to the host's native approval
   * service (answered in the chat composer) instead of the settings-panel
   * ledger. Read-only capability report for `agents/list`.
   */
  approvalRouting?(): boolean
  /**
   * True when permission asks and filesystem writes for chat-backed sessions
   * follow the host's DSH access mode (`sandbox/mode` + `approval/policy`)
   * instead of the agent's own `permission` field. Read-only capability report
   * for `agents/list`; the panel tells the user which knob actually governs a
   * given session with it.
   */
  accessModeRouting?(): boolean
  /**
   * ACP agent sessions backing one DSH chat session (looked up by chat session
   * id), so the composer can offer the agent's OWN mode list. Empty when no
   * agent has run in that chat yet.
   */
  chatSessions?(dshSessionId: string): ChatSessionView[]
  /**
   * Whether ONE DSH chat session runs the ACP agent preset (asked by chat
   * session id). Read-only report for `session/chat-list`; the browser's
   * model-seat gate falls back to it when the client session list does not
   * carry `agentPreset` on its rows.
   */
  chatSessionAcpMode?(dshSessionId: string): boolean
  /**
   * Awaitable verdict for `session/chat-list`: waits out the cold read behind
   * the synchronous probe, so the browser's one-shot fallback sees the settled
   * answer on the FIRST response instead of a premature `false`.
   */
  chatSessionAcpModeAnswer?(dshSessionId: string): Promise<boolean>
  /**
   * Every ACP session transcript belonging to one DSH chat session, so the
   * conversation can render the agent's real stream (tool calls, plans,
   * diffs) in its own view tab. Read-only: never spawns, never resumes.
   */
  chatTranscripts?(dshSessionId: string, afterSeq?: number): ChatTranscriptView[]
  /**
   * Switch one chat-bound ACP session's mode (`session/set_mode`). `agentId`
   * disambiguates when more than one agent has run in the same chat session;
   * without it the live (non-released) session is picked.
   */
  setChatSessionMode?(dshSessionId: string, modeId: string, agentId?: string): Promise<void>
  /**
   * Read-only install state of the ACP-mode agent preset. Its own RPC rather
   * than an `agents/list` field: it is host filesystem state, not agent runtime
   * state, and the panel refreshes it independently.
   */
  presetStatus?(): AcpPresetStatus
  /**
   * (Re)install the ACP-mode preset from the bundled copy into the user preset
   * root. Non-destructive: existing files are never overwritten.
   */
  presetInstall?(): AcpPresetStatus
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
        // `approvalRouted` is a capability report, not a command: the browser
        // uses it to decide whether the settings panel still owns approvals.
        return ok({
          agents: manager.agentViews(),
          approvalRouted: manager.approvalRouting?.() ?? false,
          accessModeRouted: manager.accessModeRouting?.() ?? false,
        })
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
      case 'agent/test': {
        if (manager.testAgent === undefined) {
          return fail('unsupported', 'acp: agent/test is not available')
        }
        // Invoked as a method to keep the manager receiver (see probe-models).
        return ok(await manager.testAgent(validateAgentDef(body)))
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
      case 'session/chat-list': {
        // Validate before the optional call: `manager.chatSessions?.(str(...))`
        // would short-circuit the arguments away on a manager without the
        // method, silently skipping the payload check.
        const dshSessionId = str(body, 'dshSessionId', 128)
        return ok({
          sessions: manager.chatSessions?.(dshSessionId) ?? [],
          // Read-only memory answer, same authority as `setAcpModeResolver`'s
          // session-log read: the seat gate's fallback fact source on hosts
          // whose session rows carry no `agentPreset`. Awaited: a cold read
          // must not be answered with a premature `false`.
          acpMode: manager.chatSessionAcpModeAnswer !== undefined
            ? await manager.chatSessionAcpModeAnswer(dshSessionId)
            : manager.chatSessionAcpMode?.(dshSessionId) === true,
        })
      }
      case 'session/chat-transcript': {
        const dshSessionId = str(body, 'dshSessionId', 128)
        const after = body.afterSeq
        if (after !== undefined && typeof after !== 'number') throw new AcpError('bad_payload', 'acp: afterSeq must be a number')
        return ok({ views: manager.chatTranscripts?.(dshSessionId, after as number | undefined) ?? [] })
      }
      case 'session/chat-mode-set': {
        const dshSessionId = str(body, 'dshSessionId', 128)
        const modeId = str(body, 'modeId', 128)
        await manager.setChatSessionMode?.(dshSessionId, modeId, optionalStr(body, 'agentId', 64))
        return ok({ done: true })
      }
      case 'preset/status':
        return ok({ preset: manager.presetStatus?.() ?? null })
      case 'preset/install':
        return ok({ preset: manager.presetInstall?.() ?? null })
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
      case 'agent/set-exposed-models': {
        const agentId = str(body, 'agentId', 64)
        const raw = body.exposedModels
        if (raw === undefined) {
          await manager.setExposedModels?.(agentId, undefined)
          return ok({ done: true })
        }
        // Same normalizer as the config validator: the panel's "only my selected
        // models" mode sends every probed choice in one call, so the route must
        // accept exactly what the catalog can produce (constraint 8's sibling —
        // saving a filter must never be the thing that breaks).
        await manager.setExposedModels?.(agentId, normalizeExposedModels(raw, 'exposedModels', 'bad_payload'))
        return ok({ done: true })
      }
      case 'agent/probe-models': {
        if (manager.probeAgentModels === undefined) {
          return fail('unsupported', 'acp: agent/probe-models is not available')
        }
        // Must invoke as a method: extracting the function would drop the
        // manager receiver (`this`) and crash the real BridgeManager.
        return ok(await manager.probeAgentModels(str(body, 'agentId', 64)))
      }
      case 'agent/catalog':
        // The seats' model list. Read-only and memory-only on purpose: the
        // conversation asks for it on every mount, so it must never spawn (a
        // probe only ever runs in the background behind it).
        return ok(manager.agentCatalog(str(body, 'agentId', 64)))
      default:
        return fail('unknown_endpoint', `acp: unknown endpoint ${endpoint}`)
    }
  } catch (error) {
    if (error instanceof AcpError) return fail(error.code, error.message)
    return fail('internal', error instanceof Error ? error.message : String(error))
  }
}
