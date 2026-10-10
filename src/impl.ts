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

// ---- Command lines (`AcpAgentDef.command` is a command LINE, not a bare program) ----

/**
 * Split a command line into tokens, the way a shell would: whitespace
 * separates, single or double quotes group.
 *
 * Inside double quotes a backslash escapes a quote (`\"`) and is otherwise
 * LITERAL — Windows paths are full of backslashes, so treating `\` as a general
 * escape would mangle `"C:\Program Files\agent.exe"`. Best-effort only: an
 * unbalanced quote swallows the rest of the line, which is the same thing a
 * shell does and is reported by the caller as a missing executable.
 */
export function tokenizeCommandLine(raw: string): string[] {
  const tokens: string[] = []
  let current = ''
  let quoted = false
  let touched = false
  let quote: '"' | "'" | undefined
  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index] as string
    if (quote !== undefined) {
      if (char === '\\' && quote === '"' && raw[index + 1] === '"') {
        current += '"'
        index += 1
        continue
      }
      if (char === quote) {
        quote = undefined
        continue
      }
      current += char
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      touched = true
      continue
    }
    if (char === ' ' || char === '\t' || char === '\n' || char === '\r') {
      // `touched` keeps an explicitly empty quoted argument (`""`) alive.
      if (touched || current !== '') tokens.push(current)
      current = ''
      touched = false
      continue
    }
    current += char
    touched = true
  }
  if (touched || current !== '') tokens.push(current)
  return tokens
}

/** First token = program, rest = arguments (see {@link tokenizeCommandLine}). */
export function splitCommandLine(raw: string): { command: string; args: string[] } {
  const tokens = tokenizeCommandLine(raw)
  return { command: tokens[0] ?? '', args: tokens.slice(1) }
}

/** Quote one token for a command line — only when it needs it. Inverse of the tokenizer. */
export function quoteCommandToken(token: string): string {
  if (token !== '' && !/[\s"']/.test(token)) return token
  return `"${token.replaceAll('"', '\\"')}"`
}

/**
 * Validate a single agent definition object.
 *
 * `command` is a COMMAND LINE: the whole thing a user would type in a terminal
 * (`codebuddy --acp`) belongs in that one field, and its extra tokens are folded
 * IN FRONT of `args`. Two reasons this is the host's job and not the panel's:
 * `agent/save` / `agent/test` are callable without the panel, and
 * `loadPersistedAgents` re-validates stored defs on every boot. A def in the
 * canonical shape (bare command + args array — every preset, everything this
 * function returns) parses back to exactly itself, so the fold is idempotent.
 */
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
  const commandLine = splitCommandLine(row.command)
  if (commandLine.command === '') {
    throw new AcpError('bad_config', `acp: agent "${id}" needs a non-empty command`)
  }
  const extraArgs = row.args ?? []
  if (!Array.isArray(extraArgs) || extraArgs.some(a => typeof a !== 'string')) throw new AcpError('bad_config', `acp: agent "${id}" args must be string[]`)
  const args = [...commandLine.args, ...extraArgs]
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
  if (cwd !== undefined && (typeof cwd !== 'string' || !isAbsolutePath(cwd))) {
    throw new AcpError('bad_config', `acp: agent "${id}" cwd must be an absolute path`)
  }
  const roots = row.allowedCwdRoots ?? (typeof cwd === 'string' ? [cwd] : [])
  if (!Array.isArray(roots) || roots.some(r => typeof r !== 'string' || !isAbsolutePath(r))) {
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
    command: commandLine.command,
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
  return {
    agents,
    transcriptMaxEntries: max,
    probeModelsOnBoot,
    startupTimeoutMs,
    permissionTimeoutMs,
    cancelFallbackMs,
  }
}

// ---- Workspace guard ----

/**
 * Win32 drive head: `C:\…` or `C:/…`. Extended-length (`\\?\C:\…`) paths are
 * deliberately NOT matched here — see {@link isExtendedLength}.
 */
const WIN32_DRIVE = /^[A-Za-z]:[\\/]/

/**
 * Extended-length (`\\?\…`) / verbatim (`//?/…`) head under either separator
 * spelling. {@link segmentize} does not interpret these forms, and the workspace
 * guard refuses them explicitly rather than mis-parsing a containment — so they
 * are not absolute paths this layer accepts either: config validation rejects a
 * cwd written that way instead of storing one that could never resolve.
 */
function isExtendedLength(p: string): boolean {
  return p.startsWith('\\\\?\\') || p.startsWith('//?/')
}

/**
 * Whether `p` is an absolute path on some platform this plugin runs on: POSIX
 * (`/…`), a Windows drive path (`C:\…`, `C:/…`), or a UNC path
 * (`\\host\share…`, `//host/share…`). The extended-length `\\?\…` family is
 * deliberately NOT absolute here — see {@link isExtendedLength}.
 *
 * Style is judged by the string head only, never deeper content: on POSIX both
 * `\` and `C:` are legal filename characters, so a look past the head would
 * misclassify legitimate POSIX paths.
 *
 * This is the host half of the check; the browser's form validation mirrors it
 * as `isAbsolutePathLike` (src/client/acp-ui.tsx) — keep the two in agreement
 * (tests/acp-view.spec.ts asserts equivalence on a shared sample set).
 */
export function isAbsolutePath(p: string): boolean {
  if (isExtendedLength(p)) return false
  return p.startsWith('/') || WIN32_DRIVE.test(p) || p.startsWith('\\\\')
}

/**
 * Whether `p` is written in a Windows style: a drive head (`C:…`), or a UNC head
 * under EITHER separator spelling (`\\host\share`, `//host/share`).
 *
 * The forward-slash spelling counts because {@link foldSeparators} hands every
 * disk-derived UNC path back in that form: judging style by the separator alone
 * would drop the case folding exactly where it is needed, so `\\SRV\share` and
 * `//SRV/share` would stop matching a configured `\\srv\share` ({@link segmentize}
 * already reads `//host/share` as UNC, and this keeps the two in agreement).
 */
function isWin32Style(p: string): boolean {
  return p.startsWith('\\\\') || p.startsWith('//') || /^[A-Za-z]:/.test(p)
}

/**
 * Comparison form of a path: separators folded (`\` → `/`) and case dropped for
 * win32-style paths, POSIX paths kept byte-exact (a `\` or mixed case is a
 * legitimate filename there). Trailing separators dropped.
 */
function compareForm(p: string): string {
  const win32 = isWin32Style(p)
  // A POSIX backslash is a filename character, not a separator: folding it there
  // would let `/work/a\b` pass as a child of `/work/a`.
  const folded = win32 ? p.replaceAll('\\', '/').replace(/\/+$/, '') : p.replace(/\/+$/, '')
  return win32 ? folded.toLowerCase() : folded
}

/** Fold a realpath (or any disk-derived path) into this layer's canonical spelling: `\` → `/` for win32-style paths. */
function foldSeparators(p: string): string {
  return isWin32Style(p) ? p.replaceAll('\\', '/') : p
}

/** One parsed absolute path: its immutable head (`/`, `C:`, `//host/share`) and the segments under it. */
interface SegmentedPath {
  head: string
  /** Whether the head came from a Windows-style path (drive or UNC) — the fold rule for relative tails. */
  win32: boolean
  segments: string[]
}

/**
 * Split an absolute path into head + segments, folding `\` for Windows-style
 * paths. Returns `undefined` for relative input and for forms this layer does
 * not interpret — extended-length `\\?\…` heads (an agent sending one gets an
 * explicit denial rather than a silently mis-parsed containment).
 */
function segmentize(p: string): SegmentedPath | undefined {
  const drive = /^[A-Za-z]:/.exec(p)
  if (drive !== null) {
    return { head: drive[0], win32: true, segments: p.slice(2).replaceAll('\\', '/').split('/').filter(s => s !== '') }
  }
  if (p.startsWith('//') || p.startsWith('\\\\')) {
    if (p.startsWith('\\\\?\\') || p.startsWith('//?/')) return undefined
    const segments = p.slice(2).replaceAll('\\', '/').split('/').filter(s => s !== '')
    // A UNC path needs both the host and the share before anything under it is addressable.
    if (segments.length < 2) return undefined
    return { head: `//${segments[0]}/${segments[1]}`, win32: true, segments: segments.slice(2) }
  }
  if (p.startsWith('/')) {
    return { head: '/', win32: false, segments: p.split('/').filter(s => s !== '') }
  }
  return undefined
}

/** Lexical `.`/`..`/empty-segment collapse; `..` at a root stays at the root (containment judges the result). */
function collapseSegments(segments: string[]): string[] {
  const stack: string[] = []
  for (const seg of segments) {
    if (seg === '.' || seg === '') continue
    if (seg === '..') stack.pop()
    else stack.push(seg)
  }
  return stack
}

/** The deepest probeable root of a parsed path: `/`, `C:/`, or `//host/share/`. */
function rootForm(parsed: SegmentedPath): string {
  return parsed.head === '/' ? '/' : `${parsed.head}/`
}

/** Rebuild an absolute path from a parsed head and segments (empty segments yield the root form). */
function unsegmentize(parsed: SegmentedPath, segments: string[]): string {
  if (segments.length === 0) return rootForm(parsed)
  // The POSIX head is itself the root slash; a drive/UNC head needs the joiner.
  return parsed.head === '/' ? `/${segments.join('/')}` : `${parsed.head}/${segments.join('/')}`
}

/**
 * Pure path join with lexical `..`/`.` collapse (impl.ts cannot import node:path).
 * The base's head is preserved; a relative tail folds `\` into separators only
 * when the base is Windows-style — a POSIX base keeps `\` as a literal
 * filename character.
 */
function joinWithin(base: string, rel: string): string {
  const parsed = segmentize(base)
  if (parsed === undefined) {
    // Defensive: every caller passes a canonical absolute base.
    return `/${collapseSegments(`${base}/${rel}`.split('/')).join('/')}`
  }
  const folded = parsed.win32 ? rel.replaceAll('\\', '/') : rel
  return unsegmentize(parsed, collapseSegments([...parsed.segments, ...folded.split('/')]))
}

/**
 * Resolve the requested session cwd against the agent's allowed roots.
 * @param def - validated agent definition.
 * @param requested - browser-supplied cwd (optional; `''`/undefined → default).
 * @param realpath - platform realpath (injected; throws if the path is unusable).
 * @param extraRoots - roots trusted on top of the agent's own ones, for THIS
 *   session only. The one caller that matters is a chat session, whose cwd is
 *   the workspace the user picked in the DSH sidebar: that directory is never in
 *   the agent's configured allow-list (the plugin's own sandbox dir is), yet it
 *   is the session's declared workspace — the root the fs guard confines reads
 *   and writes to. `/acp`-RPC sessions pass none and keep `allowedCwdRoots` as
 *   a hard cap.
 * @returns the canonical absolute directory to hand to `session/new` (POSIX
 *   spelling on Windows too: `\` folded to `/`).
 */
export function resolveSessionCwd(def: AcpAgentDef, requested: string | undefined, realpath: (p: string) => string, extraRoots: readonly string[] = []): string {
  const candidate = requested === undefined || requested === '' ? def.cwd : requested
  if (candidate === undefined) throw new AcpError('no_cwd', `acp: agent "${def.id}" has no default cwd; pass one`)
  if (!isAbsolutePath(candidate)) throw new AcpError('bad_cwd', 'acp: session cwd must be absolute')
  let canonical: string
  try {
    canonical = foldSeparators(realpath(candidate))
  } catch {
    throw new AcpError('bad_cwd', `acp: cwd does not exist: ${candidate}`)
  }
  const configured = (def.allowedCwdRoots ?? []).length > 0 ? (def.allowedCwdRoots ?? []) : (def.cwd !== undefined ? [def.cwd] : [])
  const roots = [...configured, ...extraRoots.filter(root => typeof root === 'string' && isAbsolutePath(root))]
  if (roots.length === 0) throw new AcpError('no_roots', `acp: agent "${def.id}" has no allowedCwdRoots configured`)
  const inside = roots.some(root => isUnderPath(canonical, safeRealpath(realpath, root)))
  if (!inside) throw new AcpError('cwd_denied', `acp: cwd ${canonical} is outside agent "${def.id}" allowed roots`)
  return canonical
}

function safeRealpath(realpath: (p: string) => string, p: string): string {
  try {
    return realpath(p)
  } catch {
    return p
  }
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
 *
 * Windows spellings work throughout: an absolute drive/UNC request keeps its
 * own head, a relative request folds `\` when the session cwd is
 * Windows-style, and the result comes back in the folded `/`-separated form.
 */
export function canonicalizeFsPath(sessionCwd: string, requested: string, realpath: (p: string) => string): string {
  if (typeof requested !== 'string' || requested === '') {
    throw new AcpError('bad_path', 'acp: fs path must be a non-empty string')
  }
  if (isExtendedLength(requested)) {
    // Refused before the relative-join branch can swallow it as a filename: a
    // verbatim path is a form this layer cannot judge, not a path under the cwd.
    throw new AcpError('bad_path', `acp: fs path does not exist: ${requested}`)
  }
  const collapsed = isAbsolutePath(requested) ? requested : joinWithin(sessionCwd, requested)
  const parsed = segmentize(collapsed)
  if (parsed === undefined) {
    throw new AcpError('bad_path', `acp: fs path does not exist: ${requested}`)
  }
  const segments = collapseSegments(parsed.segments)
  let canonical: string | undefined
  let consumed = 0
  for (let i = segments.length; i >= 0; i--) {
    try {
      canonical = realpath(unsegmentize(parsed, segments.slice(0, i)))
      consumed = i
      break
    } catch { /* walk up to the nearest existing ancestor */ }
  }
  if (canonical === undefined) {
    throw new AcpError('bad_path', `acp: fs path does not exist: ${requested}`)
  }
  const base = foldSeparators(canonical).replace(/\/+$/, '')
  const tail = segments.slice(consumed)
  if (tail.length === 0) {
    // The strip above eats the separator that belongs to a bare root (`/` → ``,
    // `C:\` → `C:`): answer the root's own spelling instead of a value that is no
    // longer absolute.
    return base === '' || base === parsed.head ? rootForm(parsed) : base
  }
  return `${base}/${tail.join('/')}`
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
  const inside = roots.some(root => isUnderPath(full, safeRealpath(realpath, root)))
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

// ---- ACP tool-call notifications → DSH tool-call stream chunks ----

/**
 * One ACP tool call, narrowed to what the Chat plane's tool-call renderer shows.
 *
 * `callId` is the ACP `toolCallId` — it is the only identity the agent gives, and
 * the Chat renderer uses it to group a call with its updates. `name` is the
 * agent's own label (`title`, falling back to nothing at all: the renderer shows
 * the call id when a name is missing). `argsRaw` accumulates whatever the agent
 * chose to disclose — ACP has no mandatory arguments field, so an agent that
 * sends none simply produces an empty block, which is honest.
 */
export interface AcpToolCallSnapshot {
  callId: string
  name: string
  /** Accumulated argument text (ACP has no fixed vocabulary for it). */
  argsRaw: string
}

/** A delta of tool-call content, folded into the open snapshot. */
export type AcpToolCallDelta =
  | { kind: 'name'; name: string }
  | { kind: 'args'; text: string }

/**
 * Fold one ACP `tool_call` notification into a snapshot.
 *
 * `rawInput` / `arguments` are accepted when present: some agents send structured
 * input, and a tool card that cannot show its arguments is half a card. Anything
 * else is ignored — a tool call with only an id and a title is legal ACP.
 */
export function acpToolCallFromUpdate(update: Record<string, unknown>): AcpToolCallSnapshot | undefined {
  const callId = typeof update.toolCallId === 'string' ? update.toolCallId.trim() : ''
  if (callId === '') return undefined
  const name = typeof update.title === 'string' ? update.title : ''
  return { callId, name, argsRaw: acpToolCallArgsOf(update) }
}

/**
 * Fold one ACP `tool_call_update` into an open snapshot, in place.
 *
 * A `content` array is read through the same tolerant walk the ACP view uses:
 * ACP agents put text, diffs and terminal handles in there, and the Chat card
 * only has room for text — so the rest becomes a bracketed placeholder rather
 * than being dropped silently.
 */
export function acpToolCallDelta(
  snapshot: AcpToolCallSnapshot,
  update: Record<string, unknown>,
): AcpToolCallDelta[] {
  const deltas: AcpToolCallDelta[] = []
  const title = update.title
  if (typeof title === 'string' && title !== '' && title !== snapshot.name) {
    deltas.push({ kind: 'name', name: title })
    snapshot.name = title
  }
  const text = acpToolCallArgsOf(update)
  if (text !== '') {
    deltas.push({ kind: 'args', text })
    snapshot.argsRaw += text
  }
  return deltas
}

/**
 * The argument text an ACP tool-call notification carries, if any.
 *
 * Accepts the spellings seen in the wild (`rawInput` as a string, `arguments` as
 * a string or an object, and a `content` array folded to text) and refuses to
 * invent one: an agent that sends no arguments gets `''`, which renders as an
 * empty card rather than a fabricated placeholder.
 */
export function acpToolCallArgsOf(update: Record<string, unknown>): string {
  for (const key of ['rawInput', 'arguments'] as const) {
    const value = update[key]
    if (typeof value === 'string' && value !== '') return value
    if (typeof value === 'object' && value !== null) {
      try {
        return JSON.stringify(value)
      } catch {
        // A circular or otherwise unserializable value is not worth failing a
        // tool card over: show what we can.
        return String(value)
      }
    }
  }
  return updateContentToText(update.content)
}

/**
 * Fold ACP tool-call `content` into plain text, with a bracketed placeholder for
 * the kinds the Chat card cannot render. Shares its shape with the ACP view's
 * line fold so both halves read an agent's content the same way.
 */
function updateContentToText(content: unknown): string {
  if (!Array.isArray(content)) return ''
  const out: string[] = []
  for (const item of content) {
    if (typeof item !== 'object' || item === null) continue
    const row = item as Record<string, unknown>
    if (row.type === 'content') {
      const inner = row.content as Record<string, unknown> | undefined
      if (inner?.type === 'text' && typeof inner.text === 'string') out.push(inner.text)
      else if (inner?.type === 'diff') out.push(`[diff ${String(inner.path ?? '')}]`)
      else out.push(`[${String(inner?.type ?? 'content')}]`)
    } else if (row.type === 'terminal') {
      out.push(`[terminal ${String(row.terminalId ?? '')}]`)
    }
  }
  return out.join('\n')
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

// ---- The agent's own permission vocabulary ----

/**
 * The ACP agent's OWN permission field (`ask` / `allow` / `reject`), declared
 * per agent in the plugin's registry.
 *
 * This is now the ONLY knob. It used to be outranked by a DSH access mode
 * resolved per turn; that mapping is retired because an ACP agent is fully
 * autonomous and DSH's sandbox cannot reach into the agent's own process (see
 * docs/acp-convergence.md §2.3).
 */

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

/**
 * Lexical containment test: does `path` equal or live under `root`?
 *
 * Both sides go through the compare form (win32-style paths get `\` folded to
 * `/` and case dropped; POSIX stays byte-exact), so a disk-derived canonical
 * path compares against a configured root regardless of which spelling each
 * arrived in — `C:\work` and `\\host\share` contain their `c:/work/…` and
 * `//host/share/…` children, while `/work2` still does not pass under `/work`
 * anywhere. A root of `/` contains every POSIX absolute path and nothing
 * Windows-shaped; any other non-absolute root contains nothing.
 */
export function isUnderPath(path: string, root: string): boolean {
  if (!isAbsolutePath(root)) return false
  const trimmedRoot = compareForm(root)
  const trimmedPath = compareForm(path)
  // A root that strips down to nothing IS the POSIX root: it spans one
  // filesystem tree, not every drive and share this plugin can see. `path` (not
  // the trimmed form) decides, because the trim also empties a path of `/` itself.
  if (trimmedRoot === '') return path.startsWith('/') && !isWin32Style(path)
  return trimmedPath === trimmedRoot || trimmedPath.startsWith(`${trimmedRoot}/`)
}

// ---- The agent preset a session runs ----

/**
 * The slice of a host session log the preset fold reads.
 */
export interface SessionLogLike {
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
export function sessionAgentPreset(session: SessionLogLike | undefined): string | undefined {
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

/** Where the ACP-mode preset is declared inside this package. */
export const ACP_PRESET_SOURCE = 'dsh-ntr/presets/acp/acp.patch.yml'

/** One harness preset-roster row (structurally `AgentPresetRow`; no dependency). */
export interface RosterPresetRow {
  id: string
  /** Why this preset cannot compose a session; absent when it can. */
  broken?: unknown
}

/**
 * Fold the harness's preset roster into the panel's preset status.
 *
 * WHY the roster is the only honest source: the ACP mode IS an agent preset, and
 * this package only *declares* it (a `preset-<id>` row in its own bundle patch).
 * Whether that declaration reached the roster, and whether it can compose a
 * session, is the harness's state — a file we ship cannot answer it, and a
 * failed activation stays on the roster with a diagnostic rather than
 * disappearing, which is exactly the case the panel must show.
 *
 * @param rows - the roster as read from the harness, or `undefined` when the
 *   roster could not be read at all (a host without the registry service) —
 *   the caller then hides the block instead of reporting a false negative.
 * @param id - the preset id to look for (`ACP_PRESET_ID`).
 * @returns the status, or `undefined` when the roster is unreadable.
 */
export function acpPresetStatusFromRoster(rows: readonly RosterPresetRow[] | undefined, id: string): AcpPresetStatus | undefined {
  if (rows === undefined) return undefined
  const row = rows.find(candidate => candidate?.id === id)
  if (row === undefined) {
    // The roster is readable and simply has no such row: the declaration was
    // not composed (an unapplied bundle patch, or a harness generation whose
    // roster is fed from somewhere else).
    return { id, source: ACP_PRESET_SOURCE, installed: false, problem: 'the harness preset roster does not carry this declaration' }
  }
  const broken = typeof row.broken === 'string' && row.broken !== '' ? row.broken : undefined
  return broken === undefined
    ? { id, source: ACP_PRESET_SOURCE, installed: true }
    : { id, source: ACP_PRESET_SOURCE, installed: false, problem: broken }
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
  /**
   * The plugin's OWN default ACP agent (the panel's ★ gesture): which agent an
   * ACP-mode conversation should start on. Deliberately NOT a DSH model route:
   * nothing in this plugin writes the host's model selection (see
   * docs/acp-convergence.md §2.2).
   */
  defaultAgent?(): string | undefined
  /** Set (or clear, with `undefined`) the default ACP agent. */
  setDefaultAgent?(agentId: string | undefined): Promise<void>
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
   * Drop the cached ACP-mode verdict for one session (or all). The gate's
   * `session/chat-list` path calls this before answering so a preset switch is
   * never masked by a stale cached negative (see the chat-list handler).
   */
  invalidateAcpMode?(dshSessionId?: string): void
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
   * Point one DSH chat conversation at an ACP agent — the plugin's own
   * conversation↔agent mapping, never a DSH model route (see
   * `BridgeManager.bindChatAgent`).
   */
  bindChatAgent?(dshSessionId: string, agentId: string): void
  /** Switch the bound agent's model (`agentId@choice`) for one chat session. */
  setChatSessionModel?(dshSessionId: string, modelId: string): Promise<void>
  /** Switch the bound agent's reasoning effort for one chat session. */
  setChatSessionEffort?(dshSessionId: string, effort: string | undefined): Promise<void>
  /**
   * State of the ACP-mode agent preset in the harness's OWN roster. Read-only
   * report for the settings panel: the preset is a declaration this package
   * ships (a bundle patch), so there is nothing to install — but a declaration
   * whose activation failed stays on the roster with its diagnostic, and that
   * has to be visible somewhere the user can act on it.
   *
   * Answers `undefined` when the roster cannot be read at all (a host without
   * the registry service), which hides the panel block instead of guessing.
   */
  presetStatus?(): Promise<AcpPresetStatus | undefined>
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
        // The gate re-asks this on every `agent-preset/selected`; it passes
        // `refresh` to mean "the session log moved, re-resolve". A verdict
        // cached from BEFORE the switch must not be echoed, or the ACP model
        // seat never activates and the ACP model stays unselectable until a
        // prompt turn retires the cache — a chicken-and-egg (you can't run that
        // turn without the model the seat is supposed to offer). Callers that
        // DON'T pass `refresh` keep the per-session cache (repeat reads stay
        // cheap); the browser half always sets it (see AcpStore.loadChatSessions).
        if (body.refresh === true) manager.invalidateAcpMode?.(dshSessionId)
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
      case 'session/chat-bind': {
        // Point one chat conversation at an ACP agent. The plugin's own
        // conversation↔agent mapping — NOT a DSH model route (see
        // `BridgeManager.bindChatAgent`).
        const dshSessionId = str(body, 'dshSessionId', 128)
        const agentId = str(body, 'agentId', 64)
        await manager.bindChatAgent?.(dshSessionId, agentId)
        return ok({ done: true })
      }
      case 'session/chat-model-set': {
        const dshSessionId = str(body, 'dshSessionId', 128)
        const modelId = str(body, 'modelId', 128)
        await manager.setChatSessionModel?.(dshSessionId, modelId)
        return ok({ done: true })
      }
      case 'session/chat-effort-set': {
        const dshSessionId = str(body, 'dshSessionId', 128)
        await manager.setChatSessionEffort?.(dshSessionId, optionalStr(body, 'effort', 64))
        return ok({ done: true })
      }
      case 'preset/status':
        return ok({ preset: await manager.presetStatus?.() ?? null })
      case 'agent/stop':
        await manager.stopAgent(str(body, 'agentId', 64)); return ok({ done: true })
      case 'default/agent':
        // The plugin's OWN default ACP agent (the panel's ★ gesture): which
        // agent an ACP-mode conversation starts on. `undefined` when none is
        // chosen yet, or the choice points at a deleted agent.
        //
        // NOT a DSH model route. It used to be reported as `{provider: 'acp',
        // model: agentId}` under `model/get-default`, which invited readers to
        // treat it as one — and the whole provider-route axis it fed has been
        // retired (see docs/acp-convergence.md §3 batch 1). The endpoint is
        // named for what it actually is.
        return ok({ agentId: manager.defaultAgent?.() })
      case 'default/agent-set': {
        const agentId = optionalStr(body, 'agentId', 64)
        await manager.setDefaultAgent?.(agentId)
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
