/**
 * The agent form's value model: what `initialForm` seeds, what `buildPayload`
 * writes, and what `payloadEquals` judges.
 *
 * The three live in ONE file on purpose (AGENTS.md 常见任务配方): a config field
 * has to be added to all three. The host only validates what it is sent —
 * `validateAgentDef` never fills a field in — so one missing from
 * `buildPayload` silently disappears on the next save, and one missing from
 * `payloadEquals` leaves the row permanently dirty, which makes every save
 * restart the agent.
 */
import { formatCommandLine, splitCommandLine } from '../acp-ui.tsx'
import type { AcpAgentDef, AcpMcpServerDef, AgentSavePayload, AgentView, DetectedAgentInfo } from '../../protocol.ts'
import { canonicalJson, exposureKey, sameStringArray, sameStringMap } from './shared.ts'

/** Everything the connection form edits, in one object (kept in the row). */
export interface AgentForm {
  agentId: string
  title: string
  /**
   * ONE command line — program first, arguments after, quoting to keep a path
   * with spaces in one piece (`splitCommandLine`). The old split into
   * `command` + `argsStr` invited the single most common misconfiguration
   * there is: pasting `codebuddy --acp` into the program box, which the host
   * then looked for as a file literally named `codebuddy --acp`.
   */
  commandLine: string
  npmPackage: string
  cwd: string
  /** Advanced: edit every allowed root, not just the single workspace dir. */
  rootsOpen: boolean
  roots: string[]
  envRows: Array<{ key: string; value: string }>
  exposed?: string[]
  /** Auto-append models the agent newly publishes to {@link exposed}. */
  autoDiscoverModels: boolean
  /**
   * The agent's default chat mode. Edited through the lightweight
   * `agent/set-default-mode` RPC, not through this form; it rides here only so
   * a full save carries the current value instead of wiping it.
   */
  defaultMode: string
  /** Raw text of the idle-release window in ms ('' = host default, '0' = never). */
  idleStr: string
  /**
   * Raw JSON text of the agent's MCP server list (the plugin's normalized
   * shape — every entry carries a `transport`). '' = no extra MCP servers.
   *
   * Kept as TEXT so a half-typed value survives editing instead of being
   * silently reshaped; it is parsed on the way out.
   */
  mcpText: string
  /**
   * Whether this agent gets the built-in `dsh-skills` MCP server (`false` =
   * opted out). NOT edited here: the agent card toggles it through the
   * lightweight RPC. It rides in the form only so a full save carries the
   * current value instead of wiping it (see `buildPayload`).
   */
  skillsMcpEnabled: boolean
}

function idleText(value: number | undefined): string {
  return value === undefined ? '' : String(value)
}

/** `''` = host default, `0` = never release, otherwise a sane millisecond window. */
export function idleValid(raw: string): boolean {
  const text = raw.trim()
  if (text === '') return true
  if (!/^\d+$/.test(text)) return false
  const value = Number(text)
  return value === 0 || (value >= 1_000 && value <= 86_400_000)
}

/**
 * Canonical comparable form of the MCP server list. Unset and empty mean the
 * same thing host-side (no extra MCP servers), so they share a key — treating
 * them as different would leave a card permanently dirty.
 *
 * The list is compared by CANONICAL JSON (object keys sorted, the servers
 * themselves sorted by name): reformatting the text — reordering keys,
 * re-indenting, listing the servers in another order — is not a change. The
 * ARGV array inside a server keeps its order, because there it is the command
 * line. The browser half needs no copy of the host's per-server validation: a
 * list the host would reject simply never matches, and the host's own error is
 * what the user sees.
 */
function mcpKey(servers: readonly AcpMcpServerDef[] | undefined): string {
  if (servers === undefined || servers.length === 0) return 'none'
  const canonical = servers
    .map(canonicalJson)
    .sort((a, b) => {
      const nameA = String((a as { name?: unknown }).name ?? '')
      const nameB = String((b as { name?: unknown }).name ?? '')
      return nameA < nameB ? -1 : nameA > nameB ? 1 : 0
    })
  return JSON.stringify(canonical)
}

/**
 * The MCP server list as the form holds it: the raw JSON text the user typed.
 *
 * Parsing happens on the way OUT (`buildPayload`), never on the way in, so a
 * half-typed value never throws inside a render. An unparseable text yields
 * `undefined`, which the form reports as invalid (`mcpInvalid`) and refuses to
 * save — better than sending a truncated list.
 */
function parseMcpServers(text: string): AcpMcpServerDef[] | undefined {
  const trimmed = text.trim()
  if (trimmed === '') return undefined
  try {
    const parsed: unknown = JSON.parse(trimmed)
    if (!Array.isArray(parsed)) return undefined
    return parsed as AcpMcpServerDef[]
  } catch {
    return undefined
  }
}

/** Whether the MCP server text parses as a list at all (the host validates the rest). */
export function mcpTextValid(text: string): boolean {
  const trimmed = text.trim()
  if (trimmed === '') return true
  try {
    return Array.isArray(JSON.parse(trimmed))
  } catch {
    return false
  }
}

export function initialForm(detected: DetectedAgentInfo, activeAgent: AgentView | undefined): AgentForm {
  const config = detected.currentConfig
  const roots = [...(activeAgent?.allowedCwdRoots ?? config?.allowedCwdRoots ?? [])]
  return {
    agentId: detected.id,
    title: activeAgent?.title ?? config?.title ?? detected.name,
    commandLine: formatCommandLine(
      activeAgent?.command ?? config?.command ?? detected.defaultCommand,
      activeAgent?.args ?? config?.args ?? detected.defaultArgs,
    ),
    npmPackage: config?.npmPackage ?? '',
    cwd: activeAgent?.cwd ?? config?.cwd ?? '',
    // An agent already carrying more than one root opens in advanced mode:
    // single-root mode narrows the allow-list to `cwd` on save, which must
    // never happen as a side effect of merely opening the form.
    rootsOpen: roots.length > 1,
    roots,
    envRows: Object.entries(config?.env ?? {}).map(([key, value]) => ({ key, value })),
    exposed: config?.exposedModels === undefined ? undefined : [...config.exposedModels],
    autoDiscoverModels: config?.autoDiscoverModels !== false,
    defaultMode: config?.defaultMode ?? '',
    // The agent's OWN override only. The host's resolved value is NOT
    // written back here: it would freeze the global window into this
    // agent's definition, and the global slider would then never reach it.
    // An empty field means "follow the global window".
    idleStr: idleText(config?.idleTimeoutMs),
    // The MCP list comes back from the host in its NORMALIZED shape (defaults
    // filled in), so re-serializing it reproduces exactly what is stored —
    // that is what keeps the card from being permanently dirty.
    mcpText: config?.mcpServers === undefined ? '' : JSON.stringify(config.mcpServers, null, 2),
    // On is the default and the only state the file does not spell out, so an
    // absent field seeds the form as on.
    skillsMcpEnabled: config?.skillsMcpEnabled !== false,
  }
}

/**
 * Equivalence test between the form payload and what is already persisted.
 * Order-insensitive on purpose: `env` is a map and `args`/`allowedCwdRoots`
 * keep their order, but a reordered allow-list is not a change worth warning
 * about; `exposedModels === undefined` is the default-open state (every
 * published model offered), which is NOT the same as an explicit `[]`
 * (nothing listed) — `buildPayload` keeps that difference.
 */
export function payloadEquals(payload: AgentSavePayload, current: AcpAgentDef): boolean {
  if (payload.command !== current.command) return false
  if ((payload.title ?? payload.id) !== (current.title ?? current.id)) return false
  if (!sameStringArray(payload.args ?? [], current.args ?? [])) return false
  if ((payload.npmPackage ?? '') !== (current.npmPackage ?? '')) return false
  if ((payload.cwd ?? '') !== (current.cwd ?? '')) return false
  if (!sameStringArray(payload.allowedCwdRoots ?? [], current.allowedCwdRoots ?? [])) return false
  if (!sameStringMap(payload.env ?? {}, current.env ?? {})) return false
  if (exposureKey(payload.exposedModels) !== exposureKey(current.exposedModels)) return false
  if (mcpKey(payload.mcpServers) !== mcpKey(current.mcpServers)) return false
  if ((payload.defaultMode ?? '') !== (current.defaultMode ?? '')) return false
  if ((payload.autoDiscoverModels !== false) !== (current.autoDiscoverModels !== false)) return false
  // Compared as an effective boolean: absent and `true` are both "on", so a
  // card that never touched the per-agent switch is not dirty.
  if ((payload.skillsMcpEnabled !== false) !== (current.skillsMcpEnabled !== false)) return false
  // The per-agent OVERRIDE, compared as stored: an absent field on both sides
  // means "follow the global window" and is not a change; a field on one
  // side only means the user is adding or dropping an override.
  if (payload.idleTimeoutMs !== current.idleTimeoutMs) return false
  return true
}

/**
 * Assemble the save/test payload.
 *
 * Workspace rules (P0-1): a non-empty single-root `cwd` also pins
 * `allowedCwdRoots` to exactly that path — an explicit narrowing, so saving
 * from the panel can never silently widen the sandbox. An empty `cwd` sends
 * neither field and the host falls back to `~/.dsh/dsh-ntr/workspaces`. Advanced
 * mode sends the edited roots as-is (deduplicated).
 */

export function buildPayload(form: AgentForm, detected: DetectedAgentInfo, newCustom: boolean): AgentSavePayload {
  const env: Record<string, string> = {}
  for (const row of form.envRows) {
    const key = row.key.trim()
    if (key === '') continue
    env[key] = row.value
  }
  const cwd = form.cwd.trim()
  const idleRaw = form.idleStr.trim()
  // The field is a command line; the host validates it the same way, so what
  // the preview under the input shows is what will actually be spawned.
  const parsed = splitCommandLine(form.commandLine)
  // An unparseable MCP text yields `undefined` here and `mcpInvalid` in the
  // form, which disables saving — so this never throws inside a render.
  const mcpServers = parseMcpServers(form.mcpText)
  const payload: AgentSavePayload = {
    id: newCustom ? form.agentId.trim() : detected.id,
    ...(form.title.trim() === '' ? {} : { title: form.title.trim() }),
    command: parsed.command,
    args: parsed.args,
    ...(form.npmPackage.trim() === '' ? {} : { npmPackage: form.npmPackage.trim() }),
    env,
    ...(form.exposed === undefined ? {} : { exposedModels: form.exposed }),
    // Auto-discovery is ON by default: only an unchecked switch records the
    // opt-out, otherwise a full save would silently re-enable it.
    ...(form.autoDiscoverModels ? {} : { autoDiscoverModels: false }),
    // `''` sends nothing: the host then applies its own default.
    ...(idleRaw === '' || !idleValid(idleRaw) ? {} : { idleTimeoutMs: Number(idleRaw) }),
    // The MCP list is OPTIONAL: absent = the agent connects only to the
    // servers it configures for itself.
    ...(mcpServers === undefined ? {} : { mcpServers }),
    // Carried so a full save cannot clear the value the RPC wrote.
    ...(form.defaultMode.trim() === '' ? {} : { defaultMode: form.defaultMode.trim() }),
    // Carried so a full save cannot silently re-enable the built-in server:
    // the host rebuilds the definition from this payload. On is the default,
    // so only the opt-out is sent (and only that is persisted).
    ...(form.skillsMcpEnabled ? {} : { skillsMcpEnabled: false }),
  }
  if (form.rootsOpen) {
    if (cwd !== '') payload.cwd = cwd
    const roots = [...new Set(form.roots.map(root => root.trim()).filter(root => root !== ''))]
    if (roots.length > 0) payload.allowedCwdRoots = roots
    return payload
  }
  if (cwd !== '') {
    payload.cwd = cwd
    payload.allowedCwdRoots = [cwd]
  }
  return payload
}
