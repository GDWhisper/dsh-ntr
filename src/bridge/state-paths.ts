import { existsSync, mkdirSync, realpathSync, renameSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import type { AcpAgentDef } from '../protocol.ts'
import { isUnderPath } from '../impl.ts'
import type { SessionWorkspaceResolver } from './types.ts'

/**
 * The DSH chat session's OWN workspace, when one is resolvable: the directory
 * the user selected in the DSH sidebar, which the host reports back as the
 * session policy's `workspaceRoot` (it is the session header cwd). This is what
 * a chat session's ACP cwd must be, so it deliberately outranks the agent's
 * configured `cwd` — that field is the plugin's own sandbox directory, not the
 * place the conversation lives.
 *
 * Never throws: a broken/absent resolver, an unknown session (an `/acp`-RPC
 * session) or a host that reports no root all read as `undefined`, and the
 * caller falls back to the agent's configured cwd.
 */
export function chatWorkspaceRoot(resolver: SessionWorkspaceResolver | undefined, dshSessionId: string | undefined): string | undefined {
  if (resolver === undefined || dshSessionId === undefined) return undefined
  try {
    const root = resolver(dshSessionId)?.workspaceRoot
    return root === undefined || root === '' ? undefined : root
  } catch {
    return undefined
  }
}

/** Canonical spelling of a configured root, or the spelling as-is when it does not exist yet. */
function canonical(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

/**
 * Where the agent process itself starts.
 *
 * `wanted` (a chat session's DSH workspace, see `ensureReady`) wins over the
 * agent's configured `cwd`: some agents derive their ENTIRE notion of "the
 * project" from the directory they were started in — their file fences, the
 * environment block they show the model, their per-project state — so a process
 * started in the plugin's sandbox answers "my workspace is
 * ~/.dsh/dsh-ntr/workspaces" no matter what `session/new` said (observed on
 * codebuddy). `def.cwd` remains the answer for everything that has no DSH
 * session behind it (probes, `/acp`-RPC sessions, the settings-page test).
 */
export function safeSpawnCwd(def: AcpAgentDef, wanted?: string): string {
  const configured = def.cwd ?? ensureDefaultWorkspace()
  for (const candidate of wanted === undefined ? [configured] : [wanted, configured]) {
    try {
      if (statSync(candidate).isDirectory()) return realpathSync(candidate)
    } catch { /* not usable — try the next candidate */ }
  }
  return homedir()
}

/**
 * This plugin's OWN state directory, `~/.dsh/dsh-ntr`.
 *
 * Everything this plugin persists belongs in here — the agent registry, the
 * probed model catalog, and the default ACP execution workspaces. `~/.dsh` is
 * the HOST's shared root: it holds the host's own `sessions/`, `storages/`,
 * `skills/`, `profiles/`, credentials and so on. Dropping a plugin's files
 * loose in there makes them indistinguishable from the host's state, and two
 * unrelated `acp-*.json` names at that level read as host config to anyone
 * (user or agent) looking at the directory. One owner, one subdirectory —
 * same convention `~/.dsh/skills/<owner>` and `~/.dsh/dsh-runtimes/<owner>`
 * already follow.
 *
 * `DSH_NTR_STATE_DIR` overrides the location (tests, and power users with a
 * relocated state root).
 */
export function pluginStateDir(home: string = homedir()): string {
  const override = process.env.DSH_NTR_STATE_DIR
  if (override !== undefined && override !== '') return override
  return join(home, '.dsh', 'dsh-ntr')
}

/**
 * The host's own shared `~/.dsh` root — the parent of this plugin's directory.
 *
 * Derived from {@link pluginStateDir} instead of recomputing `~/.dsh` from
 * `home`, on purpose: when a caller redirects the plugin's directory (tests,
 * a relocated state root), the legacy lookup must stay INSIDE that redirect.
 * Recomputing `~/.dsh` would make an overridden run read — and MIGRATE — the
 * real home directory.
 */
function hostStateDir(home: string = homedir()): string {
  return dirname(pluginStateDir(home))
}

/** True when the plugin's state dir was redirected (tests, relocated state). */
export function stateDirExplicit(): boolean {
  const override = process.env.DSH_NTR_STATE_DIR
  return override !== undefined && override !== ''
}

/**
 * Pre-`~/.dsh/dsh-ntr` locations, kept only to MIGRATE them.
 *
 * These files used to live loose in the host's `~/.dsh` root. They are moved
 * into the plugin's own directory on first boot (see {@link migrateLegacyState})
 * and never written again — the constants stay so the migration keeps working
 * for an installation that has not started the new build yet.
 */
function legacyStatePaths(home: string = homedir()): {
  readonly dir: string
  readonly agentsFile: string
  readonly catalogFile: string
  readonly workspaces: string
} {
  const dir = hostStateDir(home)
  return {
    dir,
    agentsFile: join(dir, 'acp-agents.json'),
    catalogFile: join(dir, 'acp-model-catalog.json'),
    workspaces: join(dir, 'acp-workspaces'),
  }
}

/**
 * Move the state this plugin used to scatter across the host's `~/.dsh` root
 * into {@link pluginStateDir}.
 *
 * Idempotent and one-way: a target that already exists is left alone, so a
 * user who edits the new location never has it overwritten by a stale legacy
 * file. Only files this plugin itself created are touched — nothing else in
 * `~/.dsh` is read, moved or deleted.
 *
 * The workspace DIRECTORY is renamed rather than copied, and an agent's own
 * `cwd` / `allowedCwdRoots` are rewritten afterwards by
 * {@link rewriteLegacyWorkspaceRoots}, because those recorded absolute paths
 * would otherwise point at a directory that no longer exists (the session cwd
 * resolver rejects a missing cwd outright).
 */
export function migrateLegacyState(home: string = homedir()): void {
  const legacy = legacyStatePaths(home)
  const target = pluginStateDir(home)
  try {
    const moves: Array<[string, string]> = [
      [legacy.agentsFile, join(target, 'agents.json')],
      [legacy.catalogFile, join(target, 'model-catalog.json')],
      [legacy.workspaces, join(target, 'workspaces')],
    ]
    for (const [from, to] of moves) {
      if (!existsSync(from) || existsSync(to)) continue
      mkdirSync(target, { recursive: true })
      renameSync(from, to)
    }
  } catch {
    // Best effort: a failed move leaves the legacy location readable, and the
    // readers below fall back to it, so no state is lost either way.
  }
}

/**
 * Legacy location of one plugin state file, consulted only when the new
 * location has nothing. Keeps a half-migrated installation (or a move that
 * failed because a file was momentarily locked) fully functional.
 */
export function legacyFallback(name: 'agents' | 'catalog', home: string = homedir()): string {
  const legacy = legacyStatePaths(home)
  return name === 'agents' ? legacy.agentsFile : legacy.catalogFile
}

/**
 * Rewrite an agent definition's recorded workspace paths onto
 * {@link pluginStateDir} after the migration.
 *
 * `cwd` and `allowedCwdRoots` are absolute, user-visible paths stored verbatim,
 * and `resolveSessionCwd` REJECTS a cwd that does not exist — so moving the
 * directory without rewriting the agents that point into it breaks every saved
 * agent. Returns the definition unchanged when it never named the old root.
 */
export function rewriteLegacyWorkspaceRoots(def: AcpAgentDef, home: string = homedir()): AcpAgentDef {
  const from = legacyStatePaths(home).workspaces
  const to = defaultAgentWorkspace(home)
  const swap = (path: string | undefined): string | undefined => {
    if (path === undefined) return undefined
    if (!isUnderPath(path, from)) return path
    return to + path.slice(from.length)
  }
  const cwd = swap(def.cwd)
  const roots = def.allowedCwdRoots?.map(root => swap(root) ?? root)
  const cwdChanged = cwd !== def.cwd
  const rootsChanged = roots !== undefined && roots.some((root, index) => root !== def.allowedCwdRoots?.[index])
  if (!cwdChanged && !rootsChanged) return def
  return { ...def, ...(cwd === undefined ? {} : { cwd }), ...(roots === undefined ? {} : { allowedCwdRoots: roots }) }
}

/**
 * Plugin-owned default execution workspace, anchored to the plugin state dir
 * (`~/.dsh/dsh-ntr/workspaces`).
 *
 * It deliberately does NOT derive from `process.cwd()`: that is wherever the
 * DSH host happened to be launched from, so the "default workspace" used to
 * move around per launch — and, via the `allowedCwdRoots` fallback, it could
 * widen an agent's sandbox to the entire launch directory (in practice `$HOME`
 * when `dsh web` is started from the home dir).
 */
export function defaultAgentWorkspace(home: string = homedir()): string {
  return join(pluginStateDir(home), 'workspaces')
}

// ---- ACP-mode agent preset ----

/**
 * Preset id of the ACP-mode composition.
 *
 * THREE places must agree on it (no type system spans them): the declaration's
 * `config.id` in `presets/acp/acp.patch.yml` (the bundle patch the roster row
 * comes from), the browser half's `ACP_PRESET_ID` (`src/client/acp-ui.tsx`), and
 * this constant, which the host's session-log readers compare against.
 */
export const ACP_PRESET_ID = 'acp'

/** Same as {@link defaultAgentWorkspace}, best-effort creating it on disk. */
export function ensureDefaultWorkspace(home: string = homedir()): string {
  const dir = defaultAgentWorkspace(home)
  try {
    mkdirSync(dir, { recursive: true })
  } catch { /* best effort: a missing dir is reported when a session starts */ }
  return dir
}

export interface AgentPreset {
  id: string
  name: string
  description: string
  executables: string[]
  defaultCommand: string
  defaultArgs: string[]
}

export const AGENT_PRESETS: AgentPreset[] = [
  {
    id: 'pi',
    name: 'Pi Coding Agent',
    description: 'Automata / Pi Coding Agent with native ACP bridge support',
    executables: ['pi-acp', 'pi'],
    defaultCommand: 'pi-acp',
    defaultArgs: [],
  },
  {
    id: 'omp',
    name: 'Oh My Pi',
    description: 'Oh My Pi (pi-based coding agent) — run as `omp acp` over stdio',
    executables: ['omp'],
    defaultCommand: 'omp',
    defaultArgs: ['acp'],
  },
  {
    id: 'codebuddy',
    name: 'CodeBuddy Code',
    description: 'Tencent CodeBuddy Code — run as `codebuddy --acp` over stdio',
    executables: ['codebuddy', 'cbc'],
    defaultCommand: 'codebuddy',
    defaultArgs: ['--acp'],
  },
  {
    id: 'claude',
    name: 'Claude Code',
    description: 'Claude Agent SDK adapter — run as `npx -y @agentclientprotocol/claude-agent-acp` over stdio',
    executables: ['npx'],
    defaultCommand: 'npx',
    defaultArgs: ['-y', '@agentclientprotocol/claude-agent-acp'],
  },
  {
    id: 'codex',
    name: 'Codex',
    description: 'OpenAI Codex adapter — run as `npx -y @agentclientprotocol/codex-acp` over stdio',
    executables: ['npx'],
    defaultCommand: 'npx',
    defaultArgs: ['-y', '@agentclientprotocol/codex-acp'],
  },
  {
    id: 'gemini',
    name: 'Gemini CLI',
    description: 'Google Gemini CLI — run as `gemini --experimental-acp` over stdio',
    executables: ['gemini'],
    defaultCommand: 'gemini',
    defaultArgs: ['--experimental-acp'],
  },
  {
    id: 'opencode',
    name: 'OpenCode',
    description: 'OpenCode — run as `opencode acp` over stdio',
    executables: ['opencode'],
    defaultCommand: 'opencode',
    defaultArgs: ['acp'],
  },
  {
    id: 'cursor',
    name: 'Cursor CLI',
    description: 'Cursor CLI — run as `agent acp` over stdio (legacy alias `cursor-agent acp`)',
    executables: ['agent', 'cursor-agent'],
    defaultCommand: 'agent',
    defaultArgs: ['acp'],
  },
  {
    id: 'qwen',
    name: 'Qwen Code',
    description: 'Qwen Code — run as `qwen --experimental-acp` over stdio',
    executables: ['qwen'],
    defaultCommand: 'qwen',
    defaultArgs: ['--experimental-acp'],
  },
  {
    id: 'kiro',
    name: 'Kiro',
    description: 'Kiro CLI — run as `kiro-cli acp` over stdio',
    executables: ['kiro-cli'],
    defaultCommand: 'kiro-cli',
    defaultArgs: ['acp'],
  },
  {
    id: 'qoder',
    name: 'Qoder',
    description: 'Qoder CLI — run as `qodercli --acp` over stdio',
    executables: ['qodercli'],
    defaultCommand: 'qodercli',
    defaultArgs: ['--acp'],
  },
  {
    id: 'qoder-cn',
    name: 'Qoder CN',
    description: 'Qoder CLI (China) — run as `qoderclicn --acp` over stdio',
    executables: ['qoderclicn'],
    defaultCommand: 'qoderclicn',
    defaultArgs: ['--acp'],
  },
  {
    id: 'agy',
    name: 'Antigravity CLI',
    description: 'Antigravity — run as `agy acp` over stdio',
    executables: ['agy'],
    defaultCommand: 'agy',
    defaultArgs: ['acp'],
  },
]
