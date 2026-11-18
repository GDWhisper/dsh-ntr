/**
 * Browser → host RPC on the `/acp` channel: session, agent-admin and transcript payloads and results.
 *
 * Part of the protocol contract; the barrel is `src/protocol.ts` and every
 * existing `../protocol.ts` import keeps resolving through it. Pure types,
 * constants and pure helpers only — no side effects, no Node APIs, no ACP SDK
 * runtime values (type-only SDK imports are erased at build time).
 */

import type { SessionUpdate } from '@agentclientprotocol/sdk'
import type { AcpAgentDef, AcpMcpServerDef } from './agent-def.ts'
import type { ActiveTurnView, AgentView, SessionView } from './views.ts'

// ---- Browser → host RPC (`/acp` channel; payloads below) ----

export type RpcResult<T> = {
  ok: true
  value: T
} | {
  ok: false
  /** Mirrors the host `ConnectionRpcFailure` shape (details is transport-mandated). */
  error: { code: string; message: string; details: object }
}

export interface AgentsListResult {
  agents: AgentView[]
}
export type SessionPromptResult = { accepted: true; turnId: string }
export type TranscriptResult = { session: SessionView; entries: Array<{ seq: number; update: SessionUpdate }> }
export type SessionsListResult = { sessions: SessionView[] }

export interface SessionStartPayload { agentId: string; cwd?: string }
export interface SessionPromptPayload { sessionId: string; text: string }
export interface SessionIdPayload { sessionId: string }
export interface PermissionRespondPayload { requestId: string; optionId?: string }
export interface SessionModeSetPayload { sessionId: string; modeId: string }
export interface SessionConfigSetPayload { sessionId: string; configId: string; value: string | boolean }
export interface TranscriptGetPayload { sessionId: string; afterSeq?: number }
export interface AgentIdPayload { agentId: string }
/**
 * The plugin's OWN default ACP agent (the panel's ★ gesture): which agent an
 * ACP-mode conversation starts on. Plugin-private state — the host never sees a
 * model route here, and nothing in this plugin writes DSH's model selection
 * (see docs/acp-convergence.md §2.2).
 */
export interface DefaultAgentSetPayload { agentId?: string }
/** `default/agent`: the plugin's own default agent id, or `undefined` when unset. */
export type DefaultAgentResult = { agentId?: string }
/** `plugin/version`: the installed host package's version, for the settings badge. */
export type PluginVersionResult = { version?: string }

/** Host-detected agent presence and tested defaults. */
export interface DetectedAgentInfo {
  id: string
  name: string
  description?: string
  detected: boolean
  executablePath?: string
  defaultCommand: string
  defaultArgs: string[]
  currentConfig?: AcpAgentDef
}

export type AgentDetectResult = { agents: DetectedAgentInfo[] }

export interface AgentSavePayload {
  id: string
  title?: string
  command: string
  args?: string[]
  npmPackage?: string
  cwd?: string
  allowedCwdRoots?: string[]
  env?: Record<string, string>
  exposedModels?: string[]
  /** Opt out of auto-discovery with `false`; absent keeps the default (on). See {@link AcpAgentDef.autoDiscoverModels}. */
  autoDiscoverModels?: boolean
  /** Absent → keep the host default (30 minutes); `0` = never release. */
  idleTimeoutMs?: number
  /** MCP servers to connect to, in the normalized shape. See {@link AcpAgentDef.mcpServers}. */
  mcpServers?: AcpMcpServerDef[]
  /**
   * The per-agent `dsh-skills` opt-out. Carried here ONLY so a full save cannot
   * wipe it: the settings form never edits it (`agent/set-skills-mcp` does),
   * but `validateAgentDef` rebuilds the definition from this payload, so an
   * omitted field would silently re-enable the built-in server. Absent = on.
   */
  skillsMcpEnabled?: boolean
  /**
   * How `agent/save` treats live turns. The host is the authority: a caller
   * that omits this gets `confirmationRequired` when the target agent is busy,
   * never an implicit interruption.
   */
  saveMode?: AgentSaveMode
}

/** The three explicit save gestures the NTR settings form can send. */
export type AgentSaveMode = 'direct' | 'defer' | 'force'

/** What `agent/save` did; `confirmationRequired` means nothing was written. */
export interface AgentSaveResult {
  done: boolean
  /** `defer` queued the save behind active turns; the form shows the saved-later state. */
  deferred?: boolean
  /**
   * The save aborted because the agent was deleted or a NEWER save superseded
   * it while it ran. That competing gesture won: this is not a failure, and
   * the caller must not draw a failure banner.
   */
  cancelled?: boolean
  /** Live turns exist and no explicit mode was supplied; the caller must ask. */
  confirmationRequired?: boolean
  /** The live turns that would be interrupted (target agent only). */
  activeSessions?: ActiveTurnView[]
}

/**
 * Why a connection test failed, as a VALUE the settings page can name a fix
 * for.
 *
 * Every spawn failure used to reach the browser as one sentence — the SDK
 * rejects the pending `initialize` with "ACP connection closed" whatever went
 * wrong — so "the agent is not installed" and "the launch command is wrong"
 * (the two mistakes a user actually makes, with different fixes) looked
 * identical. The host reports the cause as a fact; the panel writes the
 * sentence (it owns the locale).
 */
export type AgentTestFailureKind =
  /** Nothing on PATH matches the program token: the agent is not installed. */
  | 'not-found'
  /** The `npmPackage` auto-install ran and failed; nothing was ever spawned. */
  | 'install-failed'
  /** The program was spawned and died before the ACP handshake finished. */
  | 'start-failed'
  /** The program ran but never answered `initialize` inside the startup budget. */
  | 'timeout'
  /** The connection dropped before `initialize` answered, with no exit fact to explain it. */
  | 'handshake-failed'

/** Result of `agent/test`: spawn + initialize a throwaway process from form values, then tear it down. */
export interface AgentTestResult {
  ok: boolean
  /** Failure reason when `ok` is false (spawn ENOENT, install failure, initialize timeout, …). */
  error?: string
  /** Machine-readable cause of a failed test; absent when `ok` is true. */
  failure?: AgentTestFailureKind
  /** The program token the test launched (the first token of the form's command line). */
  command?: string
  /** Absolute path that token resolved to; absent means the host never found it on PATH. */
  executablePath?: string
  /**
   * The spawn's own error, when the process could not be launched at all.
   *
   * `code` is the OS reason (`ENOENT` / `EACCES` / `EINVAL`…). It separates
   * "nothing to run" from "the OS refused to run it" — two fixes the settings
   * page must not blur into "check the arguments".
   */
  spawnError?: { code?: string; message: string }
  /**
   * How the child died, when it did.
   *
   * A launch command missing its argument (`codebuddy` without `--acp`) usually
   * shows up as a fast non-zero exit, which is what tells that mistake apart
   * from an agent that is simply not installed.
   */
  exit?: { code: number | null; signal: string | null }
  /** Whether the `npmPackage` auto-install actually STARTED during this attempt. */
  installTried?: boolean
  /** The agent's `initialize` identity, when the handshake completed. */
  agentInfo?: { name?: string; title?: string; version?: string }
  /** Wall-clock cost of the whole test, including a triggered npm install. */
  durationMs: number
  /** Tail of the child's stderr (and installer output), newest last. */
  stderr: string[]
}

export interface AgentExposedModelsPayload {
  agentId: string
  /** Absent → reset to the default-open state (every published model); array (even empty) → exactly these (empty = none listed). */
  exposedModels?: string[]
}
