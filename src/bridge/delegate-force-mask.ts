/**
 * Force-rung masking of the host's native delegation tools
 * (docs/plan/acp-delegate-subagent.md §5.4).
 *
 * There is NO global deny: `tools.restrict` requires a scoped ctx, so the mask
 * goes through each live agent's OWN scope (`agent.ctx.tools.restrict`, the
 * `applyChildOverrides` precedent). The deny list is the INTERSECTION of the
 * default candidates with what that agent can actually see — an NTR session
 * has none of the three names and is skipped silently (a hard-coded list would
 * throw `unknown tool` there). Control-plane tools (`list_agents` /
 * `send_message` / `wait_agent`) are never denied: observation and follow-up
 * of existing subagents stay intact.
 *
 * Lifecycle: `agent/created` applies the same intersection rule to newcomers;
 * `agent/disposed` only clears the disposer table entry — the scoped restrict
 * unwinds automatically with the agent's ctx. `clear()` calls every stored
 * disposer (swallowing errors) and unsubscribes. When the host offers no
 * agents service or no restrict, `available` is false and `apply()` is a
 * silent no-op: force degrades to enhanced, reported via `restrictAvailable`.
 *
 * DI discipline: no manager import; everything arrives through the ctx face.
 */

/** The native delegation tools force may mask (default names; live intersection). */
export const DELEGATE_FORCE_DENY_CANDIDATES = ['subagent', 'subagent_fork', 'workflow'] as const

/** The minimal ctx face the mask needs (fake-friendly). */
export interface DelegateForceMaskCtx {
  get(name: string): unknown
  on?(event: string, listener: (payload: { agent?: unknown }) => void): unknown
}

interface MaskableAgent { id?: unknown; ctx?: { tools?: { get?: unknown; restrict?: unknown } } }

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export class AcpDelegateForceMask {
  /** Per-agent disposers; an entry also marks the agent as already masked. */
  private readonly disposers = new Map<string, () => void>()
  private unsubscribers: Array<() => void> = []
  private lifecycleBound = false

  constructor(private readonly deps: { ctx: DelegateForceMaskCtx; notify?: (text: string) => void }) {}

  /** Whether the host offers both the agents roster and scoped restrict. */
  get available(): boolean {
    return this.agents() !== undefined && this.restrictFace() !== undefined
  }

  /** Enter force: mask every live agent by intersection, follow lifecycle. */
  apply(): void {
    const agents = this.agents()
    if (agents === undefined || this.restrictFace() === undefined) return
    let list: unknown
    try { list = agents.list() } catch { return }
    if (Array.isArray(list)) for (const agent of list) this.maskAgent(agent)
    this.bindLifecycle()
  }

  /** Leave force: every stored disposer once (errors swallowed), unsubscribe. */
  clear(): void {
    for (const disposer of this.disposers.values()) {
      try { disposer() } catch { /* one broken teardown must not strand the rest */ }
    }
    this.disposers.clear()
    for (const unsubscribe of this.unsubscribers) {
      try { unsubscribe() } catch { /* idempotent unsubscribe */ }
    }
    this.unsubscribers = []
    this.lifecycleBound = false
  }

  private maskAgent(agent: unknown): void {
    if (agent === null || typeof agent !== 'object') return
    const row = agent as MaskableAgent
    const id = typeof row.id === 'string' ? row.id : undefined
    // Idempotent: an already-masked agent is never restricted twice.
    if (id === undefined || this.disposers.has(id)) return
    const tools = row.ctx?.tools
    if (tools === undefined || typeof tools.get !== 'function' || typeof tools.restrict !== 'function') return
    const get = tools.get as (name: string) => unknown
    const restrict = tools.restrict as (filter: { deny: string[] }) => unknown
    const deny: string[] = []
    for (const name of DELEGATE_FORCE_DENY_CANDIDATES) {
      let visible = false
      try { visible = get(name) !== undefined } catch { visible = false }
      if (visible) deny.push(name)
    }
    // Empty intersection (NTR): nothing to mask, skip without throwing.
    if (deny.length === 0) return
    try {
      const outcome = restrict({ deny })
      // A host without a precise disposer keeps the mask until the agent's
      // own ctx unwinds; record a no-op so apply stays idempotent.
      this.disposers.set(id, typeof outcome === 'function' ? outcome as () => void : () => {})
    } catch (error) {
      // Name drift etc.: report once and continue with the remaining agents.
      this.notify(`acp_delegate: force mask failed for agent ${id}: ${messageOf(error)}`)
    }
  }

  private bindLifecycle(): void {
    if (this.lifecycleBound) return
    const on = this.deps.ctx.on
    if (typeof on !== 'function') return
    this.lifecycleBound = true
    const created = (payload: { agent?: unknown }) => { this.maskAgent(payload?.agent) }
    const disposed = (payload: { agent?: unknown }) => {
      const agent = payload?.agent
      if (agent === null || typeof agent !== 'object') return
      const id = (agent as MaskableAgent).id
      // The scoped restrict already unwound with the agent's ctx: only the
      // table entry is ours to clear.
      if (typeof id === 'string') this.disposers.delete(id)
    }
    try {
      const offCreated = on.call(this.deps.ctx, 'agent/created', created)
      const offDisposed = on.call(this.deps.ctx, 'agent/disposed', disposed)
      if (typeof offCreated === 'function') this.unsubscribers.push(offCreated as () => void)
      if (typeof offDisposed === 'function') this.unsubscribers.push(offDisposed as () => void)
    } catch { /* a host without the event face keeps the live-agent mask */ }
  }

  private agents(): { list(): unknown; get(id: string): unknown } | undefined {
    let raw: unknown
    try { raw = this.deps.ctx.get('agents') } catch { return undefined }
    if (raw === null || typeof raw !== 'object') return undefined
    const service = raw as { list?: unknown; get?: unknown }
    if (typeof service.list !== 'function' || typeof service.get !== 'function') return undefined
    return service as { list(): unknown; get(id: string): unknown }
  }

  /** The global tools face only proves restrict EXISTS; the call itself goes
   * through each agent's scoped proxy (`agent.ctx.tools.restrict`). */
  private restrictFace(): { restrict: unknown } | undefined {
    let raw: unknown
    try { raw = this.deps.ctx.get('tools') } catch { return undefined }
    if (raw === null || typeof raw !== 'object') return undefined
    const tools = raw as { restrict?: unknown }
    if (typeof tools.restrict !== 'function') return undefined
    return { restrict: tools.restrict }
  }

  private notify(text: string): void {
    try { this.deps.notify?.(text) } catch { /* a broken sink must not fail apply */ }
  }
}