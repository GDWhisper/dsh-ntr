/**
 * Hot registration of the delegation tools (docs/plan/acp-delegate-native-subagent.md §5).
 *
 * TWO tools share ONE registration lifecycle:
 *
 * - `acp_delegate` — one self-contained task per call to a configured ACP agent;
 * - `acp_release`  — the main agent's on-demand idle release (never interrupts
 *   work; see `release-tool.ts`). It exists because the idle timer's window is
 *   tuned for unattended cleanup, while a caller that just finished a batch
 *   wants the memory back immediately.
 *
 * `sync()` reconciles both against the live guidance rung, budget, roster digest
 * AND subagent-seam presence: `off` removes both (a clean request header), the
 * other rungs register the register-ready definitions, and any
 * `(guidance, timeoutMs, shell, roster)` change re-registers — guidance bakes
 * into the description the host ships in `schemas()`, and the roster bakes into
 * `agent`'s parameter description (each agent's user-written description and
 * delegation defaults, see `delegateRosterText`). The window stays in the
 * signature so a tuning change still reconciles, while the host budget is the
 * fixed 24h backstop and the silence window is read live per run. The session
 * permission policy is always auto and is read live by the core, so it never
 * participates in the signature.
 *
 * SHELL SELECTION (plan §5): when the host offers the `ctx.subagents` seam the
 * delegate tool registers the NATIVE async shell (immediate activation receipt,
 * the answer arrives as the host's settlement notification); without it the
 * LEGACY synchronous shell (folded full text) registers instead. The seam is
 * re-probed on every sync, so a guidance hot-reload re-judges it, and a
 * late-arriving subagents service re-syncs through the inject seam. The release
 * tool is shell-independent.
 *
 * The `when` predicate excludes NTR sessions (`agentPreset === 'acp'`) from
 * BOTH declaration and dispatch: zero pollution of the ACP request header.
 *
 * DEGRADATION (old host whose `tools.register` returns no disposer): that
 * registration is permanent — the tool stays in the request header until the
 * host restarts — and the wrapped `acp_delegate` execute answers `off` from the
 * LIVE config with a disabled receipt in the registered shell's shape. The
 * switch still works; the header line does not disappear. `toolAvailable` reports
 * host capability (the tools service answers the probe and the last register did
 * not fail), never the guidance rung: `off` on a capable host stays true so
 * the card never claims a missing service the host actually has.
 *
 * DI discipline: no manager import; the ctx face is a minimal probe-friendly
 * interface (the `reserveVirtualTool` precedent in presets/acp/acp-guard.mjs).
 */
import type { DelegateGuidance } from '../protocol.ts'
import { delegateRosterDigest } from '../impl.ts'
import type { DelegateAgentDoc } from '../impl.ts'
import { ACP_PRESET_ID } from './state-paths.ts'
import { acpDelegateToolDefinition, type AcpDelegateActivationExecute, type AcpDelegateExecute, type AcpDelegateService } from './delegate-service.ts'
import { acpDelegateActivationExecute, type DelegateSubagentsLike } from './delegate-provider.ts'
import { acpReleaseToolDefinition, type AcpReleaseHost } from './release-tool.ts'
import type { AcpDelegateForceMask } from './delegate-force-mask.ts'

/** The minimal ctx face this registration needs (fake-friendly). */
export interface DelegateRegistrationCtx {
  get(name: string): unknown
  inject?(names: string[], callback: (injected: DelegateRegistrationCtx) => void): unknown
  effect?(fn: () => unknown): unknown
}

/** The tools service face, probed before use (register + get must exist). */
interface DelegateToolsLike {
  get(name: string): unknown
  register(definition: unknown, options?: { when?: (ctx: { agent?: unknown; modelSelection?: unknown; signal?: AbortSignal }) => boolean | Promise<boolean> }): unknown
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * The NTR exclusion: a session whose preset is `acp` never sees the tools.
 * Reads the header through optional chaining only — it must never throw,
 * whatever shape the host hands it (missing agent, primitive, null).
 */
function excludesNtr(ctx: { agent?: unknown }): boolean {
  const agent = ctx?.agent as { session?: { header?: { agentPreset?: unknown } } } | undefined
  return agent?.session?.header?.agentPreset !== ACP_PRESET_ID
}

/**
 * The ONE registration discriminator (constraint 17 / AGENTS/state.md §10):
 * `off` = not registered, `active` = every tool registered with a disposer,
 * `degraded` = at least one registration is permanent (no disposer; execute
 * intercepts `off`), `failed` = the last register threw (a later sync retries).
 * A string-literal union, never independent booleans.
 */
export type RegistrationState = 'off' | 'active' | 'degraded' | 'failed'

/** One live registration: `dispose` absent = the old host's permanent insertion. */
interface RegisteredTool {
  name: string
  dispose?: () => void
}

export class AcpDelegateRegistration {
  private entries: RegisteredTool[] = []
  private state: RegistrationState = 'off'
  private signature = ''
  private injectArmed = false
  private subagentsInjectArmed = false
  /** The shell the LAST register baked in — the degraded `off` intercept answers in its shape. */
  private native = false

  constructor(private readonly deps: {
    ctx: DelegateRegistrationCtx
    service: AcpDelegateService
    config: () => { guidance: DelegateGuidance; timeoutMs: number }
    forceMask: AcpDelegateForceMask
    notify?: (text: string) => void
    /** The optional native-seam probe; absent (or undefined) selects the legacy shell. */
    subagents?: () => DelegateSubagentsLike | undefined
    /**
     * The live roster the delegate schema describes; absent in fakes that never
     * render one (the schema then keeps the short generic `agent` line).
     */
    roster?: () => readonly DelegateAgentDoc[]
    /**
     * The on-demand release seam. Absent = `acp_release` is not registered
     * (old wiring / tests); production always passes it.
     */
    release?: AcpReleaseHost
  }) {}

  /**
   * Whether the host offers a usable tools service and the last register did
   * not fail — NOT whether the tools are currently registered. `off` on a
   * capable host stays true: the missing-service warning must never fire
   * just because the user turned the switch off.
   */
  get toolAvailable(): boolean { return this.state !== 'failed' && this.tools() !== undefined }

  /** Whether per-agent masking is usable (force degrades to enhanced if not). */
  get restrictAvailable(): boolean { return this.deps.forceMask.available }

  /** Names of the tools this registration currently holds (diagnostics / tests). */
  get registeredTools(): readonly string[] { return this.entries.map(entry => entry.name) }

  /** Idempotent reconciliation against the live config, roster and seam presence. */
  sync(): void {
    const { guidance, timeoutMs } = this.deps.config()
    if (this.state === 'degraded') {
      // Permanent registration: only the mask reconciles; the execute wrapper
      // reads the live guidance and answers `off` with the disabled receipt.
      this.reconcileMask(guidance)
      return
    }
    if (guidance === 'off') {
      this.unRegister()
      this.deps.forceMask.clear()
      return
    }
    const subagents = this.deps.subagents?.()
    const roster = this.deps.roster?.() ?? []
    const signature = `${guidance}:${String(timeoutMs)}:${subagents === undefined ? 'legacy' : 'native'}:${delegateRosterDigest(roster)}`
    if (this.state === 'off' || this.state === 'failed' || this.signature !== signature) {
      this.unRegister()
      this.register(guidance, timeoutMs, subagents, roster, signature)
    }
    this.reconcileMask(guidance)
  }

  /** Remove the tools (only this registration's insertions) and drop the mask. */
  dispose(): void {
    this.unRegister()
    this.deps.forceMask.clear()
  }

  private reconcileMask(guidance: DelegateGuidance): void {
    if (guidance === 'force') this.deps.forceMask.apply()
    else this.deps.forceMask.clear()
  }

  private register(
    guidance: DelegateGuidance,
    timeoutMs: number,
    subagents: DelegateSubagentsLike | undefined,
    roster: readonly DelegateAgentDoc[],
    signature: string,
  ): void {
    const tools = this.tools()
    if (tools === undefined) {
      this.armInject()
      return
    }
    this.native = subagents !== undefined
    // A late-arriving subagents service must re-judge the shell even when the
    // guidance and window never change.
    if (subagents === undefined) this.armSubagentsInject()
    const activation = this.native
      ? acpDelegateActivationExecute({ service: this.deps.service, subagents: subagents as DelegateSubagentsLike })
      : undefined
    const execute: AcpDelegateExecute | AcpDelegateActivationExecute = activation !== undefined
      ? async (args, exec) => {
        // Degraded host only: the registration cannot be removed, so `off` is
        // answered here from the LIVE config in the registered shell's shape.
        if (this.state === 'degraded' && this.deps.config().guidance === 'off') {
          return { kind: 'error', error: 'acp_delegate is disabled' }
        }
        return activation(args, exec)
      }
      : async (args, exec) => {
        if (this.state === 'degraded' && this.deps.config().guidance === 'off') {
          return { text: 'acp_delegate is disabled', agent: '' }
        }
        return this.deps.service.execute(args, exec)
      }
    const definitions: Array<{ name: string; execute: unknown }> = [
      acpDelegateToolDefinition({ guidance, execute, mode: this.native ? 'native' : 'legacy', roster }),
    ]
    const release = this.deps.release
    if (release !== undefined) {
      const definition = acpReleaseToolDefinition(release)
      definitions.push({
        ...definition,
        // Same degraded rule as `acp_delegate`: a permanent insertion cannot be
        // disposed, so it answers `off` from the LIVE config instead.
        execute: async (args: unknown) => (this.state === 'degraded' && this.deps.config().guidance === 'off'
          ? { text: 'acp_release is disabled' }
          : definition.execute(args)),
      })
    }
    const entries: RegisteredTool[] = []
    try {
      for (const definition of definitions) {
        const outcome = tools.register(definition, { when: excludesNtr })
        entries.push(typeof outcome === 'function'
          ? { name: definition.name, dispose: outcome as () => void }
          : { name: definition.name })
      }
    } catch (error) {
      // Release whatever landed BEFORE the throwing call (a later sync retries),
      // but KEEP a permanent insertion: it cannot be removed, and registering it
      // again on the retry would duplicate the header line.
      for (const entry of entries) {
        if (entry.dispose === undefined) continue
        try { entry.dispose() } catch { /* idempotent disposer */ }
      }
      this.entries = entries.filter(entry => entry.dispose === undefined)
      this.state = this.entries.length > 0 ? 'degraded' : 'failed'
      this.signature = ''
      this.notify(`acp_delegate: tool registration failed: ${messageOf(error)}`)
      return
    }
    this.entries = entries
    this.signature = signature
    this.state = entries.every(entry => entry.dispose !== undefined) ? 'active' : 'degraded'
  }

  private unRegister(): void {
    const entries = this.entries
    this.entries = []
    let permanent = false
    for (const entry of entries) {
      if (entry.dispose === undefined) {
        // No disposer: the old host's permanent insertion stays until restart.
        permanent = true
        continue
      }
      try { entry.dispose() } catch { /* the disposer is idempotent; teardown never throws */ }
    }
    this.state = permanent ? 'degraded' : 'off'
    this.signature = ''
  }

  /** Probe the tools service the way `reserveVirtualTool` does. */
  private tools(): DelegateToolsLike | undefined {
    let raw: unknown
    try { raw = this.deps.ctx.get('tools') } catch { return undefined }
    if (raw === null || typeof raw !== 'object') return undefined
    const tools = raw as Partial<DelegateToolsLike>
    if (typeof tools.get !== 'function' || typeof tools.register !== 'function') return undefined
    return tools as DelegateToolsLike
  }

  /** Late-arriving tools service: retry sync once the inject seam fires. */
  private armInject(): void {
    if (this.injectArmed) return
    const inject = this.deps.ctx.inject
    if (typeof inject !== 'function') return
    this.injectArmed = true
    try {
      inject.call(this.deps.ctx, ['tools'], () => { this.sync() })
    } catch {
      this.injectArmed = false
    }
  }

  /** Late-arriving subagents seam: re-judge the shell once it loads. */
  private armSubagentsInject(): void {
    if (this.subagentsInjectArmed) return
    const inject = this.deps.ctx.inject
    if (typeof inject !== 'function') return
    this.subagentsInjectArmed = true
    try {
      inject.call(this.deps.ctx, ['subagents'], () => { this.sync() })
    } catch {
      this.subagentsInjectArmed = false
    }
  }

  private notify(text: string): void {
    try { this.deps.notify?.(text) } catch { /* a broken sink must not fail sync */ }
  }
}
