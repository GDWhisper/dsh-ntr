/**
 * Pure host-side logic for dsh-ntr: config validation, workspace guard,
 * child env assembly, capped transcript, event hub, and the RPC dispatcher.
 * No Node imports, no SDK imports — everything here is testable with plain
 * fakes.
 */

import { randomUUID } from './ids.ts'
import type {
  AcpAgentCatalog, AcpAgentDef, AcpCatalogOption, AcpApprovalDeadlines, AcpConversationChoice, AcpEvent, AcpMcpServerDef, AcpPluginConfig, AcpPresetStatus, AcpTagHalo, AgentCatalogResult, AgentProbeModelsResult, AgentTestResult,
  AgentView, ApprovalDeadlineKey, ApprovalDeadlinePatch, ChatSessionView, ChatTranscriptView, DetectedAgentInfo, PermissionOptionView, PermissionOutcome, PermissionTimeoutMode, RpcResult,
} from './protocol.ts'
import { DEFAULT_TAG_HALO } from './protocol.ts'

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

/**
 * Rebuild the agent tag's halo preference from untrusted input. Only the two
 * enums the settings UI offers are accepted; anything else fails loudly
 * instead of silently switching the tag's look.
 */
export function validateTagHalo(value: unknown): AcpTagHalo {
  if (value === null || typeof value !== 'object') throw new AcpError('bad_payload', 'acp: tag halo must be an object')
  const { mode, speed } = value as { mode?: unknown; speed?: unknown }
  if (mode !== 'breath' && mode !== 'steady') throw new AcpError('bad_payload', 'acp: tag halo mode must be "breath" or "steady"')
  if (speed !== 'slow' && speed !== 'normal' && speed !== 'fast') throw new AcpError('bad_payload', 'acp: tag halo speed must be "slow", "normal" or "fast"')
  return { mode, speed }
}

/**
 * Ceiling shared by every approval deadline: one day. Both knobs accept `0`
 * (their meaningful "never" value) and anything up to this, so a range any
 * longer would be a mis-typed number rather than a deliberate window.
 */
export const APPROVAL_DEADLINE_MAX_MS = 86_400_000

/**
 * The shortest REAL wait: the first rung of the card's ladder (30 seconds).
 *
 * The floor for a mode that must not wait zero — see
 * {@link normalizeApprovalWindow}.
 */
export const APPROVAL_DEADLINE_MIN_WAIT_MS = 30_000

/**
 * Make a window legal for the mode it runs under.
 *
 * `0` means 不等待 — the ask is settled the moment it arrives instead of
 * waiting. That is the **auto** mode's business: `auto` answers with the
 * option the agent's own kinds imply, so the agent CONTINUES, and an
 * unattended deployment gets a sane default instead of a hang.
 *
 * Under `abort` the same zero would refuse every ask the instant it arrived:
 * the agent stops at every gate it meets, which is not a timeout, it is a
 * brick wall. So `abort` never offers 不等待, and a window of `0` reaching it
 * (a config file, a state file written by an older build, a mode switch that
 * left the window behind) normalizes to the shortest real wait.
 *
 * `wait` ignores the window entirely — it never expires.
 */
export function normalizeApprovalWindow(mode: PermissionTimeoutMode, ms: number): number {
  return mode === 'abort' && ms === 0 ? APPROVAL_DEADLINE_MIN_WAIT_MS : ms
}

/**
 * The order `auto` mode picks an option in, by the kind the agent declared:
 * the broadest grant first, then the narrow one, then the refusals, then
 * whatever the agent offered instead. See {@link pickAutoOption}.
 */
export const AUTO_OPTION_KIND_PRIORITY = ['allow_always', 'allow_once', 'reject_once', 'reject_always'] as const

/**
 * Validate ONE approval deadline, shared by every layer that accepts one.
 *
 * Three callers, one gate: `validateConfig` (the `cordis.patch.yml` baseline),
 * `validateApprovalDeadlines` (the settings-page write), and
 * `BridgeManager.loadPersistedAgents` (the persisted override, re-validated on
 * every boot because the state file is user-editable). They must agree — a
 * value the panel can save has to survive the next boot, or the setting would
 * silently revert.
 */
export function validateApprovalDeadlineMs(raw: unknown, label: string, code: 'bad_config' | 'bad_payload', hint: string): number {
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 0 || raw > APPROVAL_DEADLINE_MAX_MS) {
    throw new AcpError(code, `acp: ${label} must be an integer in [0, ${String(APPROVAL_DEADLINE_MAX_MS)}] ${hint}`)
  }
  return raw
}

/**
 * Validate a settings-page deadline write. Omitted keys are simply absent from
 * the result — the manager merges, so a card that only moved the mode must not
 * reset the number. `reset` is not a deadline and is dropped here.
 */
export function validateApprovalDeadlines(value: unknown): Partial<Record<ApprovalDeadlineKey, number>> {
  if (value === null || typeof value !== 'object') throw new AcpError('bad_payload', 'acp: approval deadlines must be an object')
  const { permissionTimeoutMs } = value as { permissionTimeoutMs?: unknown }
  const out: Partial<Record<ApprovalDeadlineKey, number>> = {}
  if (permissionTimeoutMs !== undefined) {
    out.permissionTimeoutMs = validateApprovalDeadlineMs(
      permissionTimeoutMs,
      'permissionTimeoutMs',
      'bad_payload',
      '(0 = 不等待，仅自动推进档可用)',
    )
  }
  return out
}

/**
 * Validate the mode a write asks for. Three values, and the list is the whole
 * vocabulary: an unanswered ask is either answered for you, kept waiting, or
 * refused. Anything else is a typo, not a new mode.
 */
export function validatePermissionTimeoutMode(raw: unknown, code: 'bad_config' | 'bad_payload'): PermissionTimeoutMode {
  if (raw !== 'abort' && raw !== 'auto' && raw !== 'wait') {
    throw new AcpError(code, 'acp: permissionTimeoutMode must be one of "abort", "auto", "wait"')
  }
  return raw
}

/**
 * The option an expired deadline answers with in `auto` mode.
 *
 * The pick is by the option's KIND, because that is what the agent declared
 * about the choice it is offering: `allow_always` first (one grant covers the
 * rest of the run), then `allow_once` (the smaller grant), then the reject
 * kinds (refuse but let the agent continue), and finally the first option
 * whatever it is — an agent may offer only a custom kind, and refusing to
 * answer at all would hang the turn.
 *
 * `undefined` means NO option could be read (no options, or none with a usable
 * id). The caller then degrades to `abort`: guessing an option is worse than
 * refusing, and hanging is worse than either. OmniTerm dev picks the same way
 * (`pick_auto_option`, `src/acp/permission.rs`).
 */
export function pickAutoOption(options: readonly PermissionOptionView[]): PermissionOptionView | undefined {
  const usable = (option: PermissionOptionView): PermissionOptionView | undefined =>
    option.optionId === '' ? undefined : option
  for (const kind of AUTO_OPTION_KIND_PRIORITY) {
    const hit = options.find(option => option.kind === kind)
    const picked = hit === undefined ? undefined : usable(hit)
    if (picked !== undefined) return picked
  }
  return options.length === 0 ? undefined : usable(options[0] as PermissionOptionView)
}

/**
 * Bound on the number of MCP servers one agent may declare. An MCP server is
 * a process (stdio) or a remote endpoint the agent connects to at session
 * setup, so this list is small in practice; the cap refuses a file-sized list
 * rather than a hostile one.
 */
const MCP_SERVERS_MAX = 32

/**
 * Bound on one MCP server's `name`. The name namespaces the agent's tools as
 * `mcp__<name>__<tool>`, so it has to stay short enough for a tool name.
 */
const MCP_SERVER_NAME_MAX = 64

/**
 * Validate one agent's `mcpServers` list (the plugin's normalized shape, NOT
 * the ACP wire shape).
 *
 * THE ENTRIES ARE RETURNED AS THE USER WROTE THEM — not rebuilt, not
 * defaulted. That is deliberate: the settings panel holds this list as JSON
 * text, and it compares what it would send against what the host stored. A
 * host that reshaped the entries (filling `args: []`, reordering the keys)
 * would make the panel report a change where there is none, and the card
 * would never come clean. So this function VALIDATES and leaves the shape
 * alone; the ACP wire conversion (src/bridge.ts) supplies the defaults the
 * protocol wants.
 *
 * The ACP-transport variant is rejected rather than ignored: it needs the
 * client side of `mcp/message`, which is not in the ACP SDK's stable surface,
 * and no agent advertises `mcpCapabilities.acp`. Accepting it would produce a
 * server the agent can never reach.
 */
export function validateMcpServers(raw: unknown, label: string, code: 'bad_config' | 'bad_payload'): AcpMcpServerDef[] {
  if (!Array.isArray(raw)) throw new AcpError(code, `acp: ${label} must be an array of MCP servers`)
  if (raw.length > MCP_SERVERS_MAX) {
    throw new AcpError(code, `acp: ${label} may hold at most ${String(MCP_SERVERS_MAX)} MCP servers`)
  }
  const seen = new Set<string>()
  const out: AcpMcpServerDef[] = []
  for (const [index, entry] of raw.entries()) {
    const at = `${label}[${String(index)}]`
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new AcpError(code, `acp: ${at} must be an object`)
    }
    const row = entry as Record<string, unknown>
    const name = row.name
    if (typeof name !== 'string' || name.trim() === '' || name.length > MCP_SERVER_NAME_MAX) {
      throw new AcpError(code, `acp: ${at}.name must be a non-empty string of at most ${String(MCP_SERVER_NAME_MAX)} chars`)
    }
    if (seen.has(name)) {
      // The name namespaces the agent's tools (`mcp__<name>__<tool>`), so two
      // servers sharing one would collide inside the agent.
      throw new AcpError(code, `acp: ${at}.name "${name}" is used by more than one MCP server`)
    }
    seen.add(name)
    const transport = row.transport
    if (transport === 'acp') {
      throw new AcpError(code, `acp: ${at}.transport "acp" is not supported (the agent would have to call back into this plugin over mcp/message)`)
    }
    if (transport === 'stdio') {
      const command = row.command
      if (typeof command !== 'string' || command.trim() === '') {
        throw new AcpError(code, `acp: ${at}.command must be a non-empty string for a stdio MCP server`)
      }
      if (row.args !== undefined && (!Array.isArray(row.args) || row.args.some(a => typeof a !== 'string'))) {
        throw new AcpError(code, `acp: ${at}.args must be an array of strings`)
      }
      stringMap(row.env, `${at}.env`, code)
      out.push(entry as AcpMcpServerDef)
      continue
    }
    if (transport === 'http' || transport === 'sse') {
      const url = row.url
      if (typeof url !== 'string' || url.trim() === '') {
        throw new AcpError(code, `acp: ${at}.url must be a non-empty string for a ${transport} MCP server`)
      }
      stringMap(row.headers, `${at}.headers`, code)
      out.push(entry as AcpMcpServerDef)
      continue
    }
    throw new AcpError(code, `acp: ${at}.transport must be "stdio", "http" or "sse"`)
  }
  return out
}

/** One `Record<string,string>` field of an MCP server (env / headers). */
function stringMap(value: unknown, label: string, code: 'bad_config' | 'bad_payload'): void {
  if (value === undefined) return
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new AcpError(code, `acp: ${label} must be an object`)
  }
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry !== 'string') throw new AcpError(code, `acp: ${label}.${key} must be a string`)
  }
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
 * `loadPersistedAgents` re-validates stored defs on every boot.
 *
 * The fold is idempotent ONLY for a whitespace-free command. When the command
 * carries whitespace (a quoted Windows path such as `C:\Program Files\a.exe`),
 * the returned `command` is the BARE path — spawn needs it unquoted
 * (`findExecutable` runs `existsSync` on it, `windowsShimLaunch` re-quotes for
 * cmd.exe; both in src/bridge.ts) — so re-validating that bare command splits it
 * at the space instead of round-tripping. `loadPersistedAgents` closes the gap
 * with `quoteLegacyCommand` (src/bridge.ts): it re-quotes the command token
 * before the re-validate, and only when the path exists on disk. Do not "fix"
 * this by quoting `command` here — that breaks the spawn above.
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
  // Optional boolean, ON by default. Only the explicit opt-out is stored:
  // `true` and absent are the same "on" state, so the persisted file does not
  // carry noise.
  const autoDiscoverModels = row.autoDiscoverModels
  if (autoDiscoverModels !== undefined && typeof autoDiscoverModels !== 'boolean') {
    throw new AcpError('bad_config', `acp: agent "${id}" autoDiscoverModels must be a boolean`)
  }
  // Per-agent idle-release window. Kept optional so a stored config from before
  // this field existed still validates (it falls back to the host default).
  const idleTimeoutMs = row.idleTimeoutMs
  if (idleTimeoutMs !== undefined && (typeof idleTimeoutMs !== 'number' || !Number.isInteger(idleTimeoutMs)
    || idleTimeoutMs > 86_400_000 || (idleTimeoutMs !== 0 && idleTimeoutMs < 1_000))) {
    throw new AcpError('bad_config', `acp: agent "${id}" idleTimeoutMs must be 0 (never release) or an integer in [1000, 86400000]`)
  }
  // MCP servers the agent should connect to. Optional, so a stored config from
  // before this field existed still validates (the agent then connects only to
  // the servers IT configures for itself).
  const mcpServers = row.mcpServers === undefined
    ? undefined
    : validateMcpServers(row.mcpServers, `agent "${id}" mcpServers`, 'bad_config')
  return {
    id,
    title,
    command: commandLine.command,
    args: args as string[],
    ...(npmPackage !== undefined ? { npmPackage } : {}),
    env,
    cwd: cwd as string | undefined,
    allowedCwdRoots: roots as string[],
    ...(exposedModels !== undefined ? { exposedModels } : {}),
    ...(autoDiscoverModels === false ? { autoDiscoverModels: false } : {}),
    ...(idleTimeoutMs === undefined ? {} : { idleTimeoutMs: idleTimeoutMs as number }),
    ...(mcpServers === undefined ? {} : { mcpServers }),
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
  // ONE wait window for both routes. The two legacy keys are folded in when
  // the new one is absent, so an existing `cordis.patch.yml` keeps meaning what
  // it meant instead of silently falling back to the default.
  const legacyWindow = value.nativeApprovalTimeoutMs ?? value.permissionFallbackTimeoutMs
  // A legacy window of 0 meant "this window never fires". The only way to say
  // that now is the `wait` MODE (0 is 不等待 today), so a legacy zero carries
  // over as the mode — otherwise an unattended deployment would silently turn
  // "wait forever" into "answer immediately".
  const legacyNever = legacyWindow === 0
  const permissionTimeoutMs = validateApprovalDeadlineMs(
    legacyNever ? 300_000 : (value.permissionTimeoutMs ?? legacyWindow ?? 300_000),
    'permissionTimeoutMs',
    'bad_config',
    '(0 = 不等待，仅自动推进档可用)',
  )
  // What an expired deadline DOES. Same validator as the settings-page write,
  // so a mode the panel can offer is a mode the next boot accepts.
  const permissionTimeoutMode = legacyNever
    ? 'wait'
    : validatePermissionTimeoutMode(value.permissionTimeoutMode ?? 'wait', 'bad_config')
  // 不等待 belongs to `auto` (it answers, so the agent continues). Under
  // `abort` a zero window would refuse every ask on arrival — the agent stops
  // at every gate — so it becomes the shortest real wait.
  const effectivePermissionTimeoutMs = normalizeApprovalWindow(permissionTimeoutMode, permissionTimeoutMs)
  const cancelFallbackMs = value.cancelFallbackMs ?? 15_000
  if (typeof cancelFallbackMs !== 'number' || !Number.isInteger(cancelFallbackMs) || cancelFallbackMs < 0 || cancelFallbackMs > 600_000) {
    throw new AcpError('bad_config', 'acp: cancelFallbackMs must be an integer in [0, 600000] (0 = disable the fallback)')
  }
  const staleCancelRetryDelayMs = value.staleCancelRetryDelayMs ?? 600
  if (typeof staleCancelRetryDelayMs !== 'number' || !Number.isInteger(staleCancelRetryDelayMs) || staleCancelRetryDelayMs < 0 || staleCancelRetryDelayMs > 60_000) {
    throw new AcpError('bad_config', 'acp: staleCancelRetryDelayMs must be an integer in [0, 60000] (0 = resend immediately)')
  }
  const staleCancelMaxRetries = value.staleCancelMaxRetries ?? 2
  if (typeof staleCancelMaxRetries !== 'number' || !Number.isInteger(staleCancelMaxRetries) || staleCancelMaxRetries < 0 || staleCancelMaxRetries > 5) {
    throw new AcpError('bad_config', 'acp: staleCancelMaxRetries must be an integer in [0, 5]')
  }
  return {
    agents,
    transcriptMaxEntries: max,
    probeModelsOnBoot,
    startupTimeoutMs,
    permissionTimeoutMs: effectivePermissionTimeoutMs,
    permissionTimeoutMode,
    cancelFallbackMs,
    staleCancelRetryDelayMs,
    staleCancelMaxRetries,
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
    // Say so — "does not exist" is a lie when the file is right there.
    throw new AcpError('bad_path', `acp: fs path is a form this layer cannot resolve: ${requested}`)
  }
  const collapsed = isAbsolutePath(requested) ? requested : joinWithin(sessionCwd, requested)
  const parsed = segmentize(collapsed)
  if (parsed === undefined) {
    // segmentize returns undefined for a form it does not interpret — chiefly a
    // UNC head missing its share (`\\host`). Not "does not exist": the target may
    // resolve fine; this layer just cannot address it.
    throw new AcpError('bad_path', `acp: fs path is a form this layer cannot resolve: ${requested}`)
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
 * {@link canonicalizeFsPath} plus the allowed-root containment check: a path
 * outside the given `roots` throws (`cwd_denied`) and the caller answers the
 * agent's request with that error instead of touching the disk.
 *
 * The containment is UNCONDITIONAL — there is deliberately no access-mode layer
 * here. The one caller (`guardFsPath` in src/bridge.ts) always passes the
 * agent's own `allowedCwdRoots` plus the session cwd as a hard cap; a DSH
 * access mode such as `danger-full-access` never reaches this path and never
 * lifts the cap.
 */
export function resolveFsPath(sessionCwd: string, roots: readonly string[], requested: string, realpath: (p: string) => string): string {
  const full = canonicalizeFsPath(sessionCwd, requested, realpath)
  const inside = roots.some(root => isUnderPath(full, safeRealpath(realpath, root)))
  if (!inside) throw new AcpError('cwd_denied', `acp: fs path ${full} is outside the session workspace`)
  return full
}

// ---- Child environment ----

/**
 * The agent is a peer process, not a DSH sub-agent: it inherits the host
 * environment exactly as a native tool would, and the agent's configured env
 * wins per key on top.
 */
export function childEnv(parent: NodeJS.ProcessEnv, extra: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(parent)) {
    if (v === undefined) continue
    out[k] = v
  }
  for (const [k, v] of Object.entries(extra)) out[k] = v
  return out
}

// ---- Model catalog (pure parsing of ACP `configOptions`) ----

/**
 * Extract select options from a raw ACP `configOptions` payload.
 *
 * `model`, `thought_level` and `mode` get dedicated slots. Every OTHER select
 * with at least one choice lands in `extras` (deduped by `configId`, last
 * definition wins) — that is what the composer's advanced base lists and sets.
 * Tolerant by design: unknown categories, boolean options, grouped choices,
 * missing `name`, and the legacy `id` field (pre-spec agents) are all handled;
 * anything unusable is skipped silently.
 */
export function parseCatalogOptions(configOptions: unknown): AcpAgentCatalog {
  const out: AcpAgentCatalog = {}
  if (!Array.isArray(configOptions)) return out
  const extras = new Map<string, AcpCatalogOption>()
  for (const raw of configOptions) {
    if (typeof raw !== 'object' || raw === null) continue
    const row = raw as Record<string, unknown>
    const category = typeof row.category === 'string' ? row.category : undefined
    const slot = category === 'model'
      ? 'model'
      : category === 'thought_level'
        ? 'thought'
        : category === 'mode'
          ? 'mode'
          : undefined
    const configIdRaw = row.configId ?? row.id
    if (typeof configIdRaw !== 'string' && typeof configIdRaw !== 'number') continue
    const configId = String(configIdRaw)
    if (configId === '') continue
    const choices: NonNullable<AcpAgentCatalog['model']>['choices'] = []
    collectCatalogChoices(row.options, choices)
    // A boolean toggle has no `options` at all; its current value is a JSON
    // boolean. It is encoded as 'true' / 'false' so the catalog stays
    // string-typed for every existing reader, and carries `kind` so the
    // composer renders a checkbox instead of a select.
    const booleanKind = row.type === 'boolean'
      || (typeof row.currentValue === 'boolean' && choices.length === 0)
    const option: AcpCatalogOption = {
      configId,
      name: typeof row.name === 'string' && row.name !== '' ? row.name : configId,
      ...(booleanKind ? { kind: 'boolean' as const } : {}),
      currentValue: booleanKind
        ? row.currentValue === true || row.currentValue === 'true'
          ? 'true'
          : row.currentValue === false || row.currentValue === 'false' ? 'false' : null
        : typeof row.currentValue === 'string' && row.currentValue !== '' ? row.currentValue : null,
      choices,
    }
    // A toggle is never a model / thought / mode SELECT: those controls pick
    // among choices. It belongs to the advanced base, where it is a checkbox.
    if (slot !== undefined && !booleanKind) {
      out[slot] = option
      continue
    }
    // Choice-less options have nothing to pick; they would render an empty
    // section in the advanced menu, so they stay out of the catalog entirely —
    // except a boolean, whose whole point is that it has no choices.
    if (choices.length > 0 || booleanKind) extras.set(configId, option)
  }
  if (extras.size > 0) out.extras = [...extras.values()]
  return out
}

/**
 * Fold one per-session option answer's SHAPE into an agent-level catalog.
 *
 * `session/set_config_option` answers are often the ONLY place an agent
 * publishes how its option set changes with the model — opencode offers
 * `thought_level` (`effort`) just for models with variants and never
 * re-notifies after a client-driven set — and the composer's thought chip is
 * driven by the agent-level catalog. What is agent knowledge there is the
 * SHAPE (which slots exist, which choices they offer); `currentValue` is not:
 * in a per-session answer it is that session's pick, and promoting it would
 * turn one conversation's choice into `reasoning.defaultEffort` for every
 * other one. A merged slot therefore keeps the catalog's known current value
 * while the observed choices still offer it, and `null` ("the agent's own
 * default") otherwise. Slots the answer does not mention are left alone — a
 * different model may still offer them.
 */
export function mergeCatalogShape(existing: AcpAgentCatalog | undefined, observed: AcpAgentCatalog): AcpAgentCatalog {
  const out: AcpAgentCatalog = {}
  const merge = (prev: AcpCatalogOption | undefined, next: AcpCatalogOption): AcpCatalogOption => {
    const kept = prev?.currentValue ?? null
    return {
      configId: next.configId,
      name: next.name,
      ...(next.kind === 'boolean' ? { kind: 'boolean' as const } : {}),
      // A boolean has no choices to test `kept` against; it keeps the
      // catalog's known default like any other slot (the answer's value is
      // still one session's truth, not the agent's).
      currentValue: kept !== null && (next.choices.length === 0 || next.choices.some(choice => choice.value === kept)) ? kept : null,
      choices: next.choices,
    }
  }
  for (const slot of ['model', 'thought', 'mode'] as const) {
    const prev = existing?.[slot]
    const next = observed[slot]
    if (next === undefined) {
      if (prev !== undefined) out[slot] = prev
      continue
    }
    out[slot] = merge(prev, next)
  }
  // Extras merge by configId: observed entries refresh their shape, entries
  // only the earlier answer knew survive (another model may still offer them).
  const extras = new Map<string, AcpCatalogOption>()
  for (const option of existing?.extras ?? []) extras.set(option.configId, option)
  for (const option of observed.extras ?? []) extras.set(option.configId, merge(extras.get(option.configId), option))
  if (extras.size > 0) out.extras = [...extras.values()]
  return out
}

/**
 * Size ceiling for one `configOptions` answer to be believed. Normal answers
 * are a few KB (a 500-model catalog is well under this); beyond it the agent is
 * misbehaving and absorbing/persisting it would turn every notification into
 * an unbounded write.
 */
export const MAX_CONFIG_OPTIONS_BYTES = 1 << 20

/**
 * Whether a `configOptions` answer may overwrite known state.
 *
 * An EMPTY (or absent) answer is a non-answer: observed agents return
 * `configOptions: []` in intermediate states, and treating that as "this agent
 * now has no options" would wipe a perfectly good catalog and session
 * snapshot for a state that passes (the rule OmniTerm settles on for the same
 * observation — empty sets never overwrite the last known state). Oversized
 * answers are dropped for the same reason: see {@link MAX_CONFIG_OPTIONS_BYTES}.
 */
export function usableConfigOptions(configOptions: unknown): configOptions is unknown[] {
  if (!Array.isArray(configOptions) || configOptions.length === 0) return false
  return JSON.stringify(configOptions).length <= MAX_CONFIG_OPTIONS_BYTES
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
 * Tool activity as REAL `tool-call` blocks, one driver step per tool activity.
 *
 * The ordering problem (docs/acp-convergence.md §1.7) is solved by SEGMENTING
 * the turn, not by prose: the adapter ends its stream when a tool-bearing
 * segment has a card and the next non-tool event arrives, the host settles the
 * assistant message, executes the card (the guard's virtual tool answers with
 * the agent's real output from the shared registry), and its agent loop then
 * proposes the continuation step — whose stream() call resumes reading the SAME
 * in-flight `session/prompt` from the transcript cursor. Cards therefore sit
 * between two assistant messages, exactly like a native multi-step turn.
 */

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
 * The argument text an ACP tool-call notification carries, if any.
 *
 * Accepts the spellings seen in the wild (`rawInput` / `arguments` as a string,
 * an object, or an ARRAY of inputs) and refuses to invent one: an agent that
 * sends no arguments gets `''`, which renders as an empty card rather than a
 * fabricated placeholder.
 */
export function acpToolCallArgsOf(update: Record<string, unknown>): string {
  for (const key of ['rawInput', 'arguments'] as const) {
    const value = update[key]
    if (typeof value === 'string') {
      if (value !== '') return value
      continue
    }
    if (Array.isArray(value)) {
      if (value.length > 0) return jsonOf(value)
      continue
    }
    if (typeof value === 'object' && value !== null) return jsonOf(value)
  }
  return ''
}

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
 * ACP updates carry FULL replacement snapshots (`rawInput` restated in whole on
 * every change), while the host's accumulator CONCATENATES `argumentsDelta` —
 * so the deltas produced here are the extension suffix only, and the snapshot
 * itself always moves to the latest known text (the closing `block-end` frame
 * replaces the block wholesale, which is what makes a non-extension update
 * land correctly in the settled card).
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
  const input = acpToolCallArgsOf(update)
  if (input !== '') {
    const suffix = extensionSuffixOf(snapshot.argsRaw, input)
    if (suffix !== '') deltas.push({ kind: 'args', text: suffix })
    snapshot.argsRaw = input
  } else if (snapshot.argsRaw === '') {
    const text = updateContentToText(update.content)
    if (text !== '') {
      deltas.push({ kind: 'args', text })
      snapshot.argsRaw = text
    }
  }
  return deltas
}

/**
 * The part of `next` that extends `previous` — the only thing a concatenating
 * delta consumer can express. A replacement (the agent rewrote its input) has
 * no honest delta; the caller updates the snapshot regardless and lets the
 * closing snapshot tell the truth.
 */
function extensionSuffixOf(previous: string, next: string): string {
  if (previous === '') return next
  return next.startsWith(previous) ? next.slice(previous.length) : ''
}

/**
 * Whether this request is the CONTINUATION step of a turn whose previous step
 * settled with tool-call blocks — which is exactly what the ACP agent's display
 * cards are. The host agent-loop starts a next step whenever the settled
 * assistant message contains `tool-call` blocks, feeding it the staged tool
 * results: the request's message list then has `tool`-sourced messages AFTER
 * the last user-sourced one. A fresh prompt never does (the person's new words
 * are the last message); history from earlier turns sits before the new user
 * text, so it cannot trip this.
 *
 * The adapter answers such a step by resuming the SAME in-flight ACP prompt
 * from the transcript cursor instead of sending a new one (see
 * `BridgeManager.streamPrompt` and docs/acp-convergence.md §1.7).
 */
export function isAcpToolContinuation(messages: readonly {
  source?: { kind?: string }
}[]): boolean {
  let lastTool = -1
  for (let i = 0; i < messages.length; i += 1) {
    if (messages[i]?.source?.kind === 'tool') lastTool = i
  }
  if (lastTool < 0) return false
  for (let i = lastTool + 1; i < messages.length; i += 1) {
    const kind = messages[i]?.source?.kind
    // A source-less message counts as user input — the same convention
    // `selectForwardPrompt` uses for hand-built requests.
    if (kind === undefined || kind === 'user') return false
  }
  return true
}

/** One structured edit as plain text: its path, then `-`/`+` lines with three lines of context. */
export interface AcpDiffPayload {
  path: string
  oldText: string | null
  newText: string
}

/** One folded piece of a tool call's `content`. */
export type AcpContentRow =
  | { kind: 'text'; text: string }
  /** Structured edits are kept apart: flattening them to `diff <path>` throws away the review. */
  | { kind: 'diff'; diff: AcpDiffPayload }
  /** A kind we cannot render. `json` carries the whole item, so nothing the agent sent is lost. */
  | { kind: 'other'; label: string; json: string }

/**
 * Fold one ACP tool-call content item, preserving everything.
 *
 * The caller decides how to render a `text` / `diff` / `other` row; the one rule
 * here is that no shape may vanish. ACP agents in the wild send kinds beyond the
 * spec's `content` / `diff` / `terminal` (observations, images, links, custom
 * rows), and an item we do not understand is still something the agent said —
 * it rides along as `other` with its full JSON rather than disappearing.
 */
export function acpContentRows(content: unknown): AcpContentRow[] {
  if (!Array.isArray(content)) return []
  const out: AcpContentRow[] = []
  for (const item of content) {
    if (typeof item !== 'object' || item === null) {
      if (typeof item === 'string' && item !== '') out.push({ kind: 'text', text: item })
      continue
    }
    const row = item as Record<string, unknown>
    const type = typeof row.type === 'string' ? row.type : ''
    if (type === 'content') {
      const inner = row.content as Record<string, unknown> | undefined
      if (typeof inner === 'string') {
        out.push({ kind: 'text', text: inner })
      } else if (inner?.type === 'text' && typeof inner.text === 'string') {
        out.push({ kind: 'text', text: inner.text })
      } else if (inner?.type === 'diff') {
        const path = typeof inner.path === 'string' ? inner.path : ''
        out.push({
          kind: 'diff',
          diff: { path, oldText: typeof inner.oldText === 'string' ? inner.oldText : null, newText: typeof inner.newText === 'string' ? inner.newText : '' },
        })
      } else {
        out.push({ kind: 'other', label: String(inner?.type ?? 'content'), json: jsonOf(item) })
      }
      continue
    }
    if (type === 'diff' && typeof row.path === 'string' && typeof row.newText === 'string') {
      out.push({ kind: 'diff', diff: { path: row.path, oldText: typeof row.oldText === 'string' ? row.oldText : null, newText: row.newText } })
      continue
    }
    out.push({ kind: 'other', label: type === '' ? 'content' : type, json: jsonOf(item) })
  }
  return out
}

/**
 * The plain text of one tool payload: text as-is, diffs as a per-file header
 * plus its removed/added lines (`-`/`+`), other kinds as their full JSON. This
 * replaces the old `[diff path]` / `[terminal id]` placeholders — those names
 * the block and drop everything else the agent said.
 *
 * It doubles as what the guard's virtual tools answer the host loop with, so
 * both the card and the executed result read the same thing.
 */
export function updateContentToText(content: unknown): string {
  return acpContentRows(content).map(row => {
    if (row.kind === 'text') return row.text
    if (row.kind === 'diff') return formatAcpDiff(row.diff)
    return `${row.label} ${row.json}`
  }).join('\n')
}

/** One structured edit as readable text: `path`, then `-`/`+` lines plus unchanged context. */
export function formatAcpDiff(diff: AcpDiffPayload): string {
  const oldLines = splitLines(diff.oldText)
  const newLines = splitLines(diff.newText)
  let head = 0
  while (head < oldLines.length && head < newLines.length && oldLines[head] === newLines[head]) head++
  let tail = 0
  while (
    tail < oldLines.length - head
    && tail < newLines.length - head
    && oldLines[oldLines.length - 1 - tail] === newLines[newLines.length - 1 - tail]
  ) tail++
  const lines: string[] = [diff.path]
  for (let i = Math.max(0, head - 3); i < head; i++) lines.push(`  ${oldLines[i] ?? ''}`)
  for (let i = head; i < oldLines.length - tail; i++) lines.push(`- ${oldLines[i] ?? ''}`)
  for (let i = head; i < newLines.length - tail; i++) lines.push(`+ ${newLines[i] ?? ''}`)
  for (let i = oldLines.length - tail; i < oldLines.length; i++) lines.push(`  ${oldLines[i] ?? ''}`)
  return lines.join('\n')
}

function splitLines(text: string | null): string[] {
  if (text === null || text === '') return []
  return text.endsWith('\n') ? text.slice(0, -1).split('\n') : text.split('\n')
}

/** JSON text of a value; a non-serializable value falls back to its string form rather than throwing. */
function jsonOf(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

/** Cap on one tool call's raw notification. Large enough for big `content` arrays; the cut is marked. */
export const ACP_TOOL_RAW_MAX = 256_000

/** Pretty-printed JSON of an agent message, truncated only at {@link ACP_TOOL_RAW_MAX}. */
export function dumpJson(value: unknown): string {
  let text: string
  try {
    text = JSON.stringify(value, null, 2) ?? String(value)
  } catch {
    text = String(value)
  }
  return text.length > ACP_TOOL_RAW_MAX
    ? `${text.slice(0, ACP_TOOL_RAW_MAX)}\n… [truncated ${String(text.length - ACP_TOOL_RAW_MAX)} chars]`
    : text
}

// ---- host request → forwarded ACP prompt ----

/** Notification kinds that are routine state, not content: they update the session view and nothing else. */
export const BOOKKEEPING_UPDATES: ReadonlySet<string> = new Set([
  'current_mode_update',
  'config_option_update',
  'available_commands_update',
  'session_info_update',
  'usage_update',
])

/**
 * Human-readable text of an ACP notification this build has no card of its own
 * for. The text is what the native chat stream shows and what the guard answers
 * the host loop's execution of that card with, so it must carry the payload —
 * a plan's entries, an unknown kind's whole JSON — rather than only a name.
 *
 * The routine bookkeeping kinds (`current_mode_update`, `available_commands_update`,
 * and the rest of `BOOKKEEPING_UPDATES`) never reach this function on the live
 * path: `streamPrompt` drops them before it announces a kind inline — it is the
 * only caller. The two branches below that name them are a defensive fallback
 * for a direct caller, NOT a live route into the chat stream.
 */
export function describeUnhandledUpdate(kind: string, update: Record<string, unknown>): string {
  const label = kind === '' ? 'session update' : kind
  if (kind === 'plan') {
    const entries = Array.isArray(update.entries) ? update.entries : []
    if (entries.length === 0) return `${label}: (empty plan)`
    return entries.map(entry => {
      const row = (typeof entry === 'object' && entry !== null ? entry : {}) as Record<string, unknown>
      const status = typeof row.status === 'string' ? row.status : 'pending'
      const priority = typeof row.priority === 'string' ? ` [${row.priority}]` : ''
      return `[${status}]${priority} ${String(row.content ?? '')}`
    }).join('\n')
  }
  if (kind === 'current_mode_update' && typeof update.currentModeId === 'string') return `${label}: ${update.currentModeId}`
  if (kind === 'available_commands_update') {
    const commands = Array.isArray(update.availableCommands) ? update.availableCommands : []
    return commands.map(command => {
      const row = (typeof command === 'object' && command !== null ? command : {}) as Record<string, unknown>
      const name = typeof row.name === 'string' ? row.name : ''
      const description = typeof row.description === 'string' && row.description !== '' ? ` — ${row.description}` : ''
      return `${name}${description}`
    }).join('\n')
  }
  return `${label}\n${dumpJson(update)}`
}

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
  /**
   * The ask as the browser was shown it, kept for the REPLAY a reconnecting
   * client receives (see `permissionReplayFrames`). Absent on entries created
   * without a view — those still answer, they just cannot be re-shown.
   */
  view?: { toolCall: unknown; options: PermissionOptionView[] }
}

/** One outstanding ask as a reconnecting client must be re-shown it. */
export interface PendingPermissionView {
  requestId: string
  sessionId: string
  toolCall: unknown
  options: PermissionOptionView[]
}

export class PermissionLedger {
  private readonly pending = new Map<string, PendingPermission>()

  create(sessionId: string, executor: (outcome: PermissionOutcome) => void, view?: PendingPermission['view']): string {
    const requestId = randomUUID()
    this.pending.set(requestId, { requestId, sessionId, resolve: executor, ...(view === undefined ? {} : { view }) })
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

  /**
   * Outstanding asks WITH the view the browser was shown, for the reconnect
   * replay. Entries created without a view are skipped: replaying a frame the
   * client cannot render (no title, no options) would show an unanswerable
   * card, which is worse than showing nothing.
   */
  pendingViews(): PendingPermissionView[] {
    const views: PendingPermissionView[] = []
    for (const entry of this.pending.values()) {
      if (entry.view === undefined) continue
      views.push({
        requestId: entry.requestId,
        sessionId: entry.sessionId,
        toolCall: entry.view.toolCall,
        options: entry.view.options,
      })
    }
    return views
  }
}

/**
 * Frames that re-establish a freshly connected client's view of the pending
 * permission asks: every outstanding ask re-sent as its original
 * `permission/request`, then one `permission/synced` carrying the live id set.
 *
 * Why a replay at all: a `permission/request` is broadcast ONCE, when the ask is
 * created. A client that connects later — page reload, second tab, stream
 * outage — never receives it, and for a ledger ask (the `/acp` RPC path, or a
 * native route that degraded) that card is the ONLY answer entry, so the ask is
 * invisible to exactly the client that needs it. OmniTerm closes the same hole
 * with `PermissionManager::pending_events()` + a `PermissionsSynced` marker on
 * every WS connect.
 *
 * Why the terminator is mandatory: the replay is a snapshot, so an ask resolved
 * while this client was disconnected is not in it. Without the live set the
 * client would keep a stale card forever — the ask is gone host-side and
 * `respond` would answer `unknown_request`.
 */
export function permissionReplayFrames(pending: readonly PendingPermissionView[]): AcpEvent[] {
  const requests: AcpEvent[] = pending.map(p => ({
    type: 'permission/request' as const,
    requestId: p.requestId,
    sessionId: p.sessionId,
    toolCall: p.toolCall,
    options: p.options,
  }))
  return [...requests, { type: 'permission/synced', requestIds: pending.map(p => p.requestId) }]
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
  /** The agent tag's halo preference (composer display, plugin-private). */
  tagHalo?(): AcpTagHalo
  /** Write the halo preference (persisted with the agent registry). */
  setTagHalo?(halo: AcpTagHalo): Promise<void>
  /**
   * The approval deadline in force, with the facts that explain an override
   * (the `cordis.patch.yml` baseline it outranks). `undefined` on a host half
   * from before the card existed, which hides the settings card instead of
   * guessing a value.
   */
  approvalDeadlines?(): AcpApprovalDeadlines | undefined
  /**
   * Write the approval deadline, or the mode (omitted keys keep their value),
   * or drop the persisted override with `reset` so the config-file baseline
   * applies again. Applies to the running bridges without a restart.
   */
  setApprovalDeadlines?(patch: ApprovalDeadlinePatch, reset?: boolean): Promise<void>
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
  /** Toggle auto-discovery of newly published models. Must not restart the agent. */
  setAutoDiscoverModels?(agentId: string, autoDiscoverModels: boolean): Promise<void>
  probeAgentModels?(agentId: string): Promise<AgentProbeModelsResult>
  /**
   * The ACP model surface for one agent (the seats' data source): base entry,
   * the `exposedModels` variants, and the agent's own reasoning efforts.
   * Memory-only — never spawns and never probes: an agent without a cached
   * catalog is reported with `probed: false` and whatever (possibly empty)
   * content memory holds, NOT probed on read. A catalog is filled only by
   * `agent/probe-models` (the settings-card button) and by the agent's own
   * `session/new` / `session/load` — reading the seat must never start a
   * process, or opening the page would launch every configured agent.
   */
  agentCatalog(agentId: string): AgentCatalogResult
  /**
   * The last catalog observed for one agent, or `undefined` when it has never
   * published one. Memory-only (hydrated from disk at boot), never spawns.
   *
   * This is the settings panel's mount read: it fills the model panes with the
   * already-configured selection and the last known model list, so a cache hit
   * is visible without clicking 「检测可用模型」. That button only REFRESHES the
   * cache (newly published models appear, withdrawn ones drop out).
   */
  cachedAgentModels?(agentId: string): AgentProbeModelsResult | undefined
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
  /**
   * The ACP agent one DSH chat conversation is pointed at — the recorded intent
   * when there is one, else the agent an existing ACP session for that
   * conversation is already served by. The composer's chip and picker read this
   * so a switch shows BEFORE the next turn materializes it.
   */
  chatAgentFor?(dshSessionId: string): string | undefined
  /**
   * The agent one DSH chat conversation is LOCKED to after its first ACP turn,
   * if any. Read-only report for `session/chat-list`: the composer hides its
   * agent picker and shows the locked agent instead. Unlike `chatAgentFor`,
   * this deliberately ignores the roster — a deleted agent still owns the
   * conversation's context.
   */
  lockedAgentFor?(dshSessionId: string): string | undefined
  /**
   * The conversation's whole persisted pick — agent, model, thought level —
   * readable BEFORE the conversation has an ACP session. This is what makes a
   * conversation set up ahead of its first message report that set-up instead
   * of the agent's defaults.
   */
  chatChoice?(dshSessionId: string): AcpConversationChoice | undefined
  /** Switch the bound agent's model (`agentId@choice`) for one chat session. */
  setChatSessionModel?(dshSessionId: string, modelId: string): Promise<void>
  /** Switch the reasoning effort for one chat session (agentId names the default-agent case). */
  setChatSessionEffort?(dshSessionId: string, effort: string | undefined, agentId?: string): Promise<void>
  /** Set one of the agent's EXTRA config options for one chat session. */
  setChatSessionConfig?(dshSessionId: string, configId: string, value: string | boolean, agentId?: string): Promise<void>
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
        const lockedAgentId = manager.lockedAgentFor?.(dshSessionId)
        return ok({
          sessions: manager.chatSessions?.(dshSessionId) ?? [],
          // The plugin's own binding for this conversation — who serves its
          // NEXT message. The composer's chip and picker read it so a switch
          // is visible before the next turn materializes a session for the
          // new agent (the live-session list below lags one message by design).
          boundAgentId: manager.chatAgentFor?.(dshSessionId),
          // Set once the first ACP turn has run: the conversation is locked to
          // this agent and the composer offers no picker any more. Reported
          // even when the agent is no longer in the roster (its context still
          // belongs to this conversation).
          ...(lockedAgentId === undefined ? {} : { lockedAgentId }),
          // The rest of the persisted pick (model + thought level). Read
          // BEFORE any ACP session exists, which is what lets the composer show
          // a conversation set up ahead of its first message as it really is.
          choice: manager.chatChoice?.(dshSessionId),
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
        await manager.setChatSessionEffort?.(dshSessionId, optionalStr(body, 'effort', 64), optionalStr(body, 'agentId', 64))
        return ok({ done: true })
      }
      case 'session/chat-config-set': {
        const dshSessionId = str(body, 'dshSessionId', 128)
        const configId = str(body, 'configId', 128)
        const value = body.value
        if (typeof value === 'boolean') {
          await manager.setChatSessionConfig?.(dshSessionId, configId, value, optionalStr(body, 'agentId', 64))
          return ok({ done: true })
        }
        await manager.setChatSessionConfig?.(dshSessionId, configId, str(body, 'value', 512), optionalStr(body, 'agentId', 64))
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
      case 'ui/tag-halo':
        // Absent on a host half from before the setting existed: the browser
        // falls back to its own default instead of failing the read.
        return ok({ halo: manager.tagHalo?.() ?? DEFAULT_TAG_HALO })
      case 'ui/tag-halo-set': {
        await manager.setTagHalo?.(validateTagHalo(body.halo))
        return ok({ done: true })
      }
      case 'ui/approval-deadlines':
        // Absent on a host half from before the card existed: the browser then
        // renders nothing rather than a number it cannot trust.
        return ok({ deadlines: manager.approvalDeadlines?.() })
      case 'ui/approval-deadlines-set': {
        const patch: ApprovalDeadlinePatch = {
          ...validateApprovalDeadlines({ permissionTimeoutMs: body.permissionTimeoutMs }),
          ...(body.mode === undefined ? {} : { mode: validatePermissionTimeoutMode(body.mode, 'bad_payload') }),
        }
        await manager.setApprovalDeadlines?.(patch, body.reset === true)
        return ok({ deadlines: manager.approvalDeadlines?.() })
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
      case 'agent/set-auto-discover-models': {
        const agentId = str(body, 'agentId', 64)
        const autoDiscoverModels = body.autoDiscoverModels
        if (typeof autoDiscoverModels !== 'boolean') {
          return fail('bad_payload', 'acp: autoDiscoverModels must be a boolean')
        }
        await manager.setAutoDiscoverModels?.(agentId, autoDiscoverModels)
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
      case 'agent/cached-models': {
        // Persistent-cache read for the settings panel. `null` (not an error)
        // when the host has no cached catalog for this agent yet: the panel
        // renders its empty state, and the probe button is how it gets filled.
        const agentId = str(body, 'agentId', 64)
        return ok(manager.cachedAgentModels?.(agentId) ?? null)
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
