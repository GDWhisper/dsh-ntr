/**
 * Hot registration of `acp_delegate` (docs/plan/acp-delegate-subagent.md §5.3).
 *
 * `sync()` reconciles the ONE registration against the live guidance rung and
 * budget: `off` removes the tool (a clean request header), the other rungs
 * register the register-ready definition, and any `(guidance, timeoutMs)`
 * change re-registers because both bake into the definition the host ships in
 * `schemas()`. `permissionMode` / `maxOutputChars` are NOT part of the
 * signature — execute reads them live, no re-registration needed.
 *
 * The `when` predicate excludes NTR sessions (`agentPreset === 'acp'`) from
 * BOTH declaration and dispatch: zero pollution of the ACP request header.
 *
 * DEGRADATION (old host whose `tools.register` returns no disposer): the
 * registration is permanent — the tool stays in the request header until the
 * host restarts — and the wrapped execute answers `off` from the LIVE config
 * with a disabled text instead. The switch still works; the header line does
 * not disappear. `toolAvailable` reports host capability (the tools service
 * answers the probe and the last register did not fail), never the guidance
 * rung: `off` on a capable host stays true so the card never claims a missing
 * service the host actually has.
 *
 * DI discipline: no manager import; the ctx face is a minimal probe-friendly
 * interface (the `reserveVirtualTool` precedent in presets/acp/acp-guard.mjs).
 */
import type { DelegateGuidance } from '../protocol.ts'
import { ACP_PRESET_ID } from './state-paths.ts'
import { acpDelegateToolDefinition, type AcpDelegateExecute, type AcpDelegateService } from './delegate-service.ts'
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
 * The NTR exclusion: a session whose preset is `acp` never sees the tool.
 * Reads the header through optional chaining only — it must never throw,
 * whatever shape the host hands it (missing agent, primitive, null).
 */
function excludesNtr(ctx: { agent?: unknown }): boolean {
  const agent = ctx?.agent as { session?: { header?: { agentPreset?: unknown } } } | undefined
  return agent?.session?.header?.agentPreset !== ACP_PRESET_ID
}

/**
 * The ONE registration discriminator (constraint 17 / AGENTS/state.md §10):
 * `off` = not registered, `active` = registered with a disposer, `degraded` =
 * the old host's permanent registration (no disposer; execute intercepts
 * `off`), `failed` = the last register threw (a later sync retries).
 * A string-literal union, never independent booleans.
 */
export type RegistrationState = 'off' | 'active' | 'degraded' | 'failed'

export class AcpDelegateRegistration {
  private disposer: (() => void) | undefined
  private state: RegistrationState = 'off'
  private signature = ''
  private injectArmed = false

  constructor(private readonly deps: {
    ctx: DelegateRegistrationCtx
    service: AcpDelegateService
    config: () => { guidance: DelegateGuidance; timeoutMs: number }
    forceMask: AcpDelegateForceMask
    notify?: (text: string) => void
  }) {}

  /**
   * Whether the host offers a usable tools service and the last register did
   * not fail — NOT whether the tool is currently registered. `off` on a
   * capable host stays true: the missing-service warning must never fire
   * just because the user turned the switch off.
   */
  get toolAvailable(): boolean { return this.state !== 'failed' && this.tools() !== undefined }

  /** Whether per-agent masking is usable (force degrades to enhanced if not). */
  get restrictAvailable(): boolean { return this.deps.forceMask.available }

  /** Idempotent reconciliation against the live config. */
  sync(): void {
    const { guidance, timeoutMs } = this.deps.config()
    if (this.state === 'degraded') {
      // Permanent registration: only the mask reconciles; the execute wrapper
      // reads the live guidance and answers `off` with the disabled text.
      this.reconcileMask(guidance)
      return
    }
    if (guidance === 'off') {
      this.unRegister()
      this.deps.forceMask.clear()
      return
    }
    const signature = `${guidance}:${String(timeoutMs)}`
    if (this.state === 'off' || this.state === 'failed' || this.signature !== signature) {
      this.unRegister()
      this.register(guidance, timeoutMs)
    }
    this.reconcileMask(guidance)
  }

  /** Remove the tool (only this registration's insertion) and drop the mask. */
  dispose(): void {
    this.unRegister()
    this.deps.forceMask.clear()
  }

  private reconcileMask(guidance: DelegateGuidance): void {
    if (guidance === 'force') this.deps.forceMask.apply()
    else this.deps.forceMask.clear()
  }

  private register(guidance: DelegateGuidance, timeoutMs: number): void {
    const tools = this.tools()
    if (tools === undefined) {
      this.armInject()
      return
    }
    const execute: AcpDelegateExecute = async (args, exec) => {
      // Degraded old host only: the registration cannot be removed, so `off`
      // is answered here from the LIVE config. In normal mode the tool is
      // unregistered on `off` and this branch never runs.
      if (this.state === 'degraded' && this.deps.config().guidance === 'off') {
        return { text: 'acp_delegate is disabled', agent: '' }
      }
      return this.deps.service.execute(args, exec)
    }
    try {
      const definition = acpDelegateToolDefinition({ guidance, timeoutMs, execute })
      const outcome = tools.register(definition, { when: excludesNtr })
      this.signature = `${guidance}:${String(timeoutMs)}`
      if (typeof outcome === 'function') {
        this.disposer = outcome as () => void
        this.state = 'active'
      } else {
        // No disposer: keep the tool permanently registered (see the module
        // header) and let the execute wrapper intercept `off`.
        this.disposer = undefined
        this.state = 'degraded'
      }
    } catch (error) {
      this.state = 'failed'
      this.disposer = undefined
      this.notify(`acp_delegate: tool registration failed: ${messageOf(error)}`)
    }
  }

  private unRegister(): void {
    const disposer = this.disposer
    this.disposer = undefined
    if (disposer === undefined) {
      // Nothing removable: either never registered (`off`), or the degraded
      // old-host registration that stays until restart. Keep the state so the
      // execute wrapper keeps answering `off` after a dispose.
      return
    }
    try { disposer() } catch { /* the disposer is idempotent; teardown never throws */ }
    this.state = 'off'
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

  private notify(text: string): void {
    try { this.deps.notify?.(text) } catch { /* a broken sink must not fail sync */ }
  }
}