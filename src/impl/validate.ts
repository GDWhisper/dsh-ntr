/**
 * Config validation: plugin config, agent definitions, approval deadlines and exposed-model filters.
 *
 * Every value the plugin persists or accepts is rebuilt here, so `cordis.patch.yml`, `agents.json` and the settings page agree.
 *
 * Part of the host-half logic; the barrel is `src/impl.ts` and every existing
 * `../impl.ts` import keeps resolving through it. Pure logic only — no Node
 * APIs, no ACP SDK runtime values.
 */

import type { AcpAgentDef, AcpDelegateAgentDefaults, AcpDelegateConfig, AcpMcpServerDef, AcpPluginConfig, AcpTagHalo, ApprovalDeadlineKey, DelegateGuidance, DelegateSetPayload, DelegateSettingKey, PermissionTimeoutMode } from '../protocol.ts'
import { DEFAULT_IDLE_TIMEOUT_MS, DEFAULT_MODE_MAX, DELEGATE_DESCRIPTION_MAX, DELEGATE_TIMEOUT_MAX_MS, DELEGATE_TIMEOUT_MIN_MS, IDLE_RELEASE_MS } from '../protocol.ts'
import { splitCommandLine } from './command-line.ts'
import { AcpError } from './errors.ts'
import { isAbsolutePath } from './paths.ts'

// ---- Config validation ----

/** Agent ids never contain ':' or ' ', which delegate-label routing relies on. */
export const AGENT_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/
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
 * Validate the idle-release window the settings page writes.
 *
 * The window is expressed in MILLISECONDS on the shared ladder
 * ({@link IDLE_RELEASE_MS}), so a value the slider can produce is always a
 * value the host runs — the same one-ladder rule the approval deadline card
 * follows.
 */
export function validateIdleReleaseMs(raw: unknown, code: 'bad_config' | 'bad_payload'): number {
  if (typeof raw !== 'number' || !Number.isInteger(raw) || !IDLE_RELEASE_MS.includes(raw)) {
    throw new AcpError(code, `acp: idleTimeoutMs must be one of ${IDLE_RELEASE_MS.join(', ')}`)
  }
  return raw
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
 * Validate the delegation guidance rung a write asks for. Four values, and
 * the list is the whole vocabulary: the rung doubles as the registration
 * switch (`off` = the tool is not registered). Anything else is a typo, not a
 * new rung.
 */
export function validateDelegateGuidance(raw: unknown, code: 'bad_config' | 'bad_payload'): DelegateGuidance {
  if (raw !== 'off' && raw !== 'on' && raw !== 'enhanced' && raw !== 'force') {
    throw new AcpError(code, 'acp: delegate.guidance must be one of "off", "on", "enhanced", "force"')
  }
  return raw
}

/**
 * Validate the single-delegation silence window, shared by the settings-page write
 * ({@link validateDelegateSettings}) and the deployment baseline
 * ({@link validateDelegateConfig}). Any integer in [1000, 86400000] ms
 * (1 second to 24 hours) runs as-is — there is no ladder; the card prints the
 * exact number and the minute input writes `round(minutes * 60000)`.
 */
export function validateDelegateMs(raw: unknown, code: 'bad_config' | 'bad_payload'): number {
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < DELEGATE_TIMEOUT_MIN_MS || raw > DELEGATE_TIMEOUT_MAX_MS) {
    throw new AcpError(code, `acp: delegate.timeoutMs must be an integer in [${String(DELEGATE_TIMEOUT_MIN_MS)}, ${String(DELEGATE_TIMEOUT_MAX_MS)}]`)
  }
  return raw
}

/**
 * Validate the delegation default-agent override: a legal agent id, nothing
 * else. Shape only — whether the agent still exists is a runtime fact the
 * settings card marks, not a persistence gate.
 */
function validateDelegateDefaultAgent(raw: unknown, code: 'bad_config' | 'bad_payload', context: string): string {
  if (typeof raw !== 'string' || !AGENT_ID_PATTERN.test(raw)) {
    throw new AcpError(code, `acp: ${context} must be a legal agent id`)
  }
  return raw
}

/**
 * One per-agent defaults entry: an object whose optional model/effort/mode
 * values are NON-EMPTY strings, plus an optional free-text `description` (trimmed,
 * capped at {@link DELEGATE_DESCRIPTION_MAX}; an all-whitespace value is dropped
 * exactly like an absent one). Shape only — a value the agent no longer offers
 * is a stale preference that stays persisted (the runtime degrades it with a
 * note), so there is deliberately NO catalog check here. Unknown keys are
 * dropped by the rebuild, like every other door in this file.
 */
function validateDelegateDefaultsEntry(raw: unknown, code: 'bad_config' | 'bad_payload', context: string): AcpDelegateAgentDefaults {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new AcpError(code, `acp: ${context} must be an object with optional non-empty model/effort/mode strings`)
  }
  const row = raw as Record<string, unknown>
  const out: AcpDelegateAgentDefaults = {}
  if (row.enabled !== undefined) {
    if (typeof row.enabled !== 'boolean') {
      throw new AcpError(code, `acp: ${context}.enabled must be a boolean`)
    }
    // Absent = enabled: normalize `true` away so enabling leaves no residue.
    if (row.enabled === false) out.enabled = false
  }
  for (const key of ['model', 'effort', 'mode'] as const) {
    const value = row[key]
    if (value === undefined) continue
    if (typeof value !== 'string' || value === '') {
      throw new AcpError(code, `acp: ${context}.${key} must be a non-empty string`)
    }
    out[key] = value
  }
  const description = row.description
  if (description !== undefined) {
    if (typeof description !== 'string') {
      throw new AcpError(code, `acp: ${context}.description must be a string`)
    }
    const trimmed = description.trim()
    if (trimmed.length > DELEGATE_DESCRIPTION_MAX) {
      throw new AcpError(code, `acp: ${context}.description must be at most ${String(DELEGATE_DESCRIPTION_MAX)} characters`)
    }
    // Blank = "not written": the persisted file carries no empty entry, so the
    // tool schema never renders a dangling "：" with nothing behind it.
    if (trimmed !== '') out.description = trimmed
  }
  return out
}

/**
 * The per-agent defaults map: every KEY must be a legal agent id. The
 * settings-write door additionally accepts a `null` entry (delete that
 * agent's override); the deployment-baseline door does not — a config file
 * names facts, it does not issue deletions.
 */
function validateDelegateDefaultsMap(raw: unknown, code: 'bad_config' | 'bad_payload', context: string, allowNull: false): Record<string, AcpDelegateAgentDefaults>
function validateDelegateDefaultsMap(raw: unknown, code: 'bad_config' | 'bad_payload', context: string, allowNull: true): Record<string, AcpDelegateAgentDefaults | null>
function validateDelegateDefaultsMap(raw: unknown, code: 'bad_config' | 'bad_payload', context: string, allowNull: boolean): Record<string, AcpDelegateAgentDefaults | null> {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new AcpError(code, `acp: ${context} must be an object keyed by agent id`)
  }
  const out: Record<string, AcpDelegateAgentDefaults | null> = {}
  for (const [agentId, entry] of Object.entries(raw as Record<string, unknown>)) {
    if (!AGENT_ID_PATTERN.test(agentId)) {
      throw new AcpError(code, `acp: ${context} key "${agentId}" is not a legal agent id`)
    }
    if (entry === null) {
      if (!allowNull) throw new AcpError(code, `acp: ${context}["${agentId}"] must be an object (null deletion is a settings-write only)`)
      out[agentId] = null
      continue
    }
    out[agentId] = validateDelegateDefaultsEntry(entry, code, `${context}["${agentId}"]`)
  }
  return out
}

/**
 * Validate the `delegate` deployment baseline (`cordis.patch.yml`).
 *
 * Absent / null means "name nothing": the built-in defaults decide. The
 * numeric key accepts any integer in [1000, 86400000] ms — the same range the
 * settings-page write accepts. Unknown keys (including retired ones left over
 * from an older file) are silently dropped: only the keys actually named are
 * returned, so the baseline never invents a fact the file did not state.
 */
export function validateDelegateConfig(raw: unknown): AcpDelegateConfig {
  if (raw === null || raw === undefined) return {}
  if (typeof raw !== 'object') throw new AcpError('bad_config', 'acp: delegate must be an object')
  const row = raw as Record<string, unknown>
  const out: AcpDelegateConfig = {}
  if (row.guidance !== undefined) out.guidance = validateDelegateGuidance(row.guidance, 'bad_config')
  if (row.timeoutMs !== undefined) out.timeoutMs = validateDelegateMs(row.timeoutMs, 'bad_config')
  if (row.defaultAgent !== undefined) out.defaultAgent = validateDelegateDefaultAgent(row.defaultAgent, 'bad_config', 'delegate.defaultAgent')
  if (row.agentDefaults !== undefined) out.agentDefaults = validateDelegateDefaultsMap(row.agentDefaults, 'bad_config', 'delegate.agentDefaults', false)
  return out
}

/**
 * Validate a settings-page delegation write. Omitted keys are simply absent
 * from the result — the manager merges, so a card that only moved the guidance
 * must not reset the window. `timeoutMs` accepts any integer in
 * [1000, 86400000]. `defaultAgent` is a legal agent id; `agentDefaults` merges
 * per-agent entries where `null` deletes the entry and `{}` is a valid
 * all-default override. `reset` names the keys whose persisted override is
 * dropped; a key cannot be both written and reset in one call.
 */
export function validateDelegateSettings(raw: unknown): DelegateSetPayload {
  if (raw === null || typeof raw !== 'object') throw new AcpError('bad_payload', 'acp: delegate settings must be an object')
  const row = raw as Record<string, unknown>
  const out: DelegateSetPayload = {}
  if (row.guidance !== undefined) out.guidance = validateDelegateGuidance(row.guidance, 'bad_payload')
  if (row.timeoutMs !== undefined) out.timeoutMs = validateDelegateMs(row.timeoutMs, 'bad_payload')
  if (row.defaultAgent !== undefined) out.defaultAgent = validateDelegateDefaultAgent(row.defaultAgent, 'bad_payload', 'delegate.defaultAgent')
  if (row.agentDefaults !== undefined) out.agentDefaults = validateDelegateDefaultsMap(row.agentDefaults, 'bad_payload', 'delegate.agentDefaults', true)
  if (row.reset !== undefined) {
    if (!Array.isArray(row.reset)) throw new AcpError('bad_payload', 'acp: delegate reset must be an array of setting keys')
    const reset: DelegateSettingKey[] = []
    for (const key of row.reset as unknown[]) {
      if (key !== 'guidance' && key !== 'timeoutMs' && key !== 'defaultAgent' && key !== 'agentDefaults') {
        throw new AcpError('bad_payload', 'acp: delegate reset entries must be one of "guidance", "timeoutMs", "defaultAgent", "agentDefaults"')
      }
      if (reset.includes(key)) continue
      if (out[key] !== undefined) {
        throw new AcpError('bad_payload', `acp: delegate key "${key}" cannot be both written and reset in one call`)
      }
      reset.push(key)
    }
    out.reset = reset
  }
  return out
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
  // Default chat mode: optional, agent-defined id. Blank means "not written"
  // (the file stores no empty entry), so a config that clears it needs no
  // sentinel. Shape only — the live session is the authority that decides
  // whether the agent still offers it.
  const defaultModeRaw = row.defaultMode
  if (defaultModeRaw !== undefined && typeof defaultModeRaw !== 'string') {
    throw new AcpError('bad_config', `acp: agent "${id}" defaultMode must be a string`)
  }
  const defaultMode = typeof defaultModeRaw === 'string' && defaultModeRaw.trim() !== ''
    ? defaultModeRaw.trim()
    : undefined
  if (defaultMode !== undefined && defaultMode.length > DEFAULT_MODE_MAX) {
    throw new AcpError('bad_config', `acp: agent "${id}" defaultMode must be at most ${String(DEFAULT_MODE_MAX)} chars`)
  }
  // The per-agent `dsh-skills` opt-out: optional boolean, ON by default. Like
  // `autoDiscoverModels`, only the explicit opt-out is stored — `true` and
  // absent are the same state, so the file does not carry noise. A present
  // non-boolean is a config error, never a silent "on".
  const skillsMcpEnabled = row.skillsMcpEnabled
  if (skillsMcpEnabled !== undefined && typeof skillsMcpEnabled !== 'boolean') {
    throw new AcpError('bad_config', `acp: agent "${id}" skillsMcpEnabled must be a boolean`)
  }
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
    ...(defaultMode === undefined ? {} : { defaultMode }),
    ...(skillsMcpEnabled === false ? { skillsMcpEnabled: false } : {}),
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
  // The chat-process idle-release window (the settings page edits it).
  // Same shape as the per-agent field: 0 = never release, otherwise an
  // integer number of milliseconds.
  const idleTimeoutMs = value.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS
  if (typeof idleTimeoutMs !== 'number' || !Number.isInteger(idleTimeoutMs)
    || idleTimeoutMs > 86_400_000 || (idleTimeoutMs !== 0 && idleTimeoutMs < 1_000)) {
    throw new AcpError('bad_config', 'acp: idleTimeoutMs must be 0 (never release) or an integer in [1000, 86400000]')
  }
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
  // Stall-recovery windows (inactivity watchdog). Two lengths on purpose: a
  // silent turn with the floor is a stuck agent, but a turn waiting on a TOOL
  // call is a working agent, and the tool half may take as long as the guard's
  // own tool-output wait. `0` means "off" / "fall back", never "expire now".
  const turnStallMs = value.turnStallMs ?? 600_000
  if (typeof turnStallMs !== 'number' || !Number.isInteger(turnStallMs) || turnStallMs < 0 || turnStallMs > 86_400_000) {
    throw new AcpError('bad_config', 'acp: turnStallMs must be an integer in [0, 86400000] (0 = disable the watchdog)')
  }
  const turnStallToolMs = value.turnStallToolMs ?? 1_800_000
  if (typeof turnStallToolMs !== 'number' || !Number.isInteger(turnStallToolMs) || turnStallToolMs < 0 || turnStallToolMs > 86_400_000) {
    throw new AcpError('bad_config', 'acp: turnStallToolMs must be an integer in [0, 86400000] (0 = fall back to turnStallMs)')
  }
  const turnStallTickMs = value.turnStallTickMs ?? 30_000
  if (typeof turnStallTickMs !== 'number' || !Number.isInteger(turnStallTickMs) || turnStallTickMs < 1 || turnStallTickMs > 60_000) {
    throw new AcpError('bad_config', 'acp: turnStallTickMs must be an integer in [1, 60000]')
  }
  // The Antigravity transcript path's deployment switch: absent means "use the
  // tuning default" (on), and only an explicit boolean is accepted. Kept out
  // of the returned object when absent so the host entry never overrides the
  // default with `undefined`.
  const agyLateOutput = value.agyLateOutput
  if (agyLateOutput !== undefined && typeof agyLateOutput !== 'boolean') {
    throw new AcpError('bad_config', 'acp: agyLateOutput must be a boolean')
  }
  // The transcript watch's two windows: absent keeps the tuning default. The
  // idle window's `0` disables the mechanism; the ceiling's `0` means "none".
  const agyLateOutputMaxMs = value.agyLateOutputMaxMs
  if (agyLateOutputMaxMs !== undefined
    && (typeof agyLateOutputMaxMs !== 'number' || !Number.isInteger(agyLateOutputMaxMs)
      || agyLateOutputMaxMs < 0 || agyLateOutputMaxMs > 86_400_000)) {
    throw new AcpError('bad_config', 'acp: agyLateOutputMaxMs must be an integer in [0, 86400000] (0 = disable the watch)')
  }
  const agyLateOutputCeilingMs = value.agyLateOutputCeilingMs
  if (agyLateOutputCeilingMs !== undefined
    && (typeof agyLateOutputCeilingMs !== 'number' || !Number.isInteger(agyLateOutputCeilingMs)
      || agyLateOutputCeilingMs < 0 || agyLateOutputCeilingMs > 86_400_000)) {
    throw new AcpError('bad_config', 'acp: agyLateOutputCeilingMs must be an integer in [0, 86400000] (0 = no ceiling)')
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
    turnStallMs,
    turnStallToolMs,
    turnStallTickMs,
    idleTimeoutMs,
    delegate: validateDelegateConfig(value.delegate),
    ...(agyLateOutput === undefined ? {} : { agyLateOutput }),
    ...(agyLateOutputMaxMs === undefined ? {} : { agyLateOutputMaxMs }),
    ...(agyLateOutputCeilingMs === undefined ? {} : { agyLateOutputCeilingMs }),
  }
}
