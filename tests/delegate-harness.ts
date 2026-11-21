/**
 * The shared in-memory delegate fake (docs/plan/acp-delegate-native-subagent.md
 * §7): one programmable host drives the core's every runtime branch — no child
 * process, millisecond-scale. Used by the legacy-core suite (delegate.spec.ts),
 * the provider unit suite (delegate-provider.spec.ts) and the native-shell
 * suite (delegate-native.spec.ts); the real-process integration lives in
 * tests/bridge/delegate-native.spec.ts.
 */
import { vi } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { SubagentActivation, SubagentActivationSpec, SubagentProvider, SubagentResult, SubagentRun } from '@deepseek-ai/dsh-subagent'
import type { AcpDelegateExecute, AcpDelegateHost, AcpDelegatePolicy } from '../src/bridge/delegate-service.ts'
import type { DelegateSubagentsLike } from '../src/bridge/delegate-provider.ts'
import type { DelegateRegistrationCtx } from '../src/bridge/delegate-registration.ts'
import type { AcpDelegateForceMask } from '../src/bridge/delegate-force-mask.ts'
import type { AcpEvent, AcpStartSessionOpts, DelegateGuidance } from '../src/protocol.ts'

export function chunk(text: string, meta?: Record<string, unknown>) {
  return { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text }, ...(meta === undefined ? {} : { _meta: meta }) }
}
export const tick = () => new Promise(resolve => setTimeout(resolve, 10))
export const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

export function makeHost() {
  const sinks = new Set<(event: AcpEvent) => void>()
  const emit = (event: AcpEvent) => { for (const sink of [...sinks]) sink(event) }
  const order: string[] = []
  const calls = {
    startSession: [] as Array<{ agentId: string; cwd?: string; opts?: AcpStartSessionOpts }>,
    policy: [] as Array<{ sessionId: string; policy: AcpDelegatePolicy }>,
    prompt: [] as Array<{ sessionId: string; text: string }>,
    cancel: [] as string[],
    close: [] as string[],
    respond: [] as Array<{ requestId: string; optionId?: string }>,
    transcript: [] as Array<{ sessionId: string; afterSeq?: number }>,
  }
  const config = { guidance: 'on' as DelegateGuidance, timeoutMs: 600_000 }
  const agents = [{ id: 'alpha', title: 'Alpha' }, { id: 'beta', title: 'Beta' }, { id: 'codebuddy', title: 'CodeBuddy' }]
  let defaultAgentId: string | undefined = 'alpha'
  let nextSession = 0
  const transcripts = new Map<string, Array<{ seq: number; update: unknown }>>()
  let onStart: ((agentId: string, cwd?: string, opts?: AcpStartSessionOpts) => Promise<{ sessionId: string; cwd: string }>) | undefined
  let onPrompt: ((sessionId: string, text: string) => Promise<{ turnId: string }>) | undefined
  const host: AcpDelegateHost = {
    hub: { subscribe(sink) { sinks.add(sink); return () => { sinks.delete(sink) } } },
    agents: () => agents,
    defaultAgent: () => defaultAgentId,
    delegateConfig: () => ({ ...config }),
    async startSession(agentId, cwd, opts) {
      order.push('start')
      calls.startSession.push({ agentId, ...(cwd === undefined ? {} : { cwd }), ...(opts === undefined ? {} : { opts }) })
      if (onStart !== undefined) return onStart(agentId, cwd, opts)
      const sessionId = `session-${String(++nextSession)}`
      if (!transcripts.has(sessionId)) transcripts.set(sessionId, [])
      // The real host answers with the RESOLVED cwd; the fake echoes the
      // request, falling back to the agent default the way resolveSessionCwd does.
      return { sessionId, cwd: cwd ?? '/agent-default' }
    },
    setPermissionPolicy(sessionId, policy) { order.push('policy'); calls.policy.push({ sessionId, policy }) },
    async prompt(sessionId, text) {
      order.push('prompt')
      calls.prompt.push({ sessionId, text })
      if (onPrompt !== undefined) return onPrompt(sessionId, text)
      return { turnId: `turn-${sessionId}` }
    },
    async cancel(sessionId) { order.push('cancel'); calls.cancel.push(sessionId) },
    async closeSession(sessionId) { order.push('close'); calls.close.push(sessionId) },
    transcript(sessionId, afterSeq) {
      order.push('transcript')
      calls.transcript.push({ sessionId, afterSeq })
      const entries = transcripts.get(sessionId) ?? []
      return { session: {}, entries: entries.filter(entry => entry.seq > (afterSeq ?? 0)) }
    },
  }
  return {
    host, emit, calls, order, config, transcripts,
    sinkCount: () => sinks.size,
    setDefault: (id: string | undefined) => { defaultAgentId = id },
    onStart: (fn: typeof onStart) => { onStart = fn },
    onPrompt: (fn: typeof onPrompt) => { onPrompt = fn },
  }
}
export type Fake = ReturnType<typeof makeHost>

/** The standard happy path: chunks fold incrementally, close exactly once. */
export function happyPrompt(f: Fake, answer = 'the answer') {
  f.onPrompt(async (sessionId) => {
    f.emit({ type: 'session/update', sessionId, seq: 1, update: chunk(answer) })
    f.emit({ type: 'turn/end', sessionId, turnId: 'turn-1', stopReason: 'end_turn' })
    return { turnId: 'turn-1' }
  })
}

/** The force-mask fake: apply/clear spies with a usable availability probe. */
export function fakeMask() {
  return { apply: vi.fn(), clear: vi.fn(), available: true } as unknown as AcpDelegateForceMask & { apply: ReturnType<typeof vi.fn>; clear: ReturnType<typeof vi.fn> }
}

/**
 * The fake `ctx.subagents` service, shaped by the host contract
 * (docs/plan/acp-delegate-native-subagent.md §1/§4): a fresh controller signal
 * per activation (NOT exec.signal), an absolute cwd, a receipt result distinct
 * from the provider run result, capacity refusal without queueing, and
 * NO_PROVIDER when nothing is registered. `hangResult` publishes receipts
 * whose result NEVER settles (proving the tool does not await it); `failWith`
 * throws a typed host refusal.
 */
export function fakeSubagentsService(opts: { failWith?: unknown; hangResult?: boolean; capacity?: number } = {}) {
  const specs: SubagentActivationSpec[] = []
  const providers = new Map<string, SubagentProvider>()
  const receipts: SubagentActivation[] = []
  let counter = 0
  let active = 0
  const service: DelegateSubagentsLike = {
    registerProvider(provider: SubagentProvider) {
      providers.set(provider.name, provider)
      return () => { providers.delete(provider.name) }
    },
    async startActivation(spec: SubagentActivationSpec): Promise<SubagentActivation> {
      specs.push(spec)
      if (opts.failWith !== undefined) throw opts.failWith
      if (active >= (opts.capacity ?? 8)) {
        throw Object.assign(new Error('subagent capacity reached'), { code: 'ACTIVATION_LIMIT_REACHED' })
      }
      counter += 1
      let released = false
      const release = (): void => { if (!released) { released = true; active -= 1 } }
      const childId = `child-${String(counter)}` as unknown as SessionId
      const name = `agent-${String(counter)}`
      if (opts.hangResult === true) {
        // A published receipt whose result never settles: the tool must have
        // returned the name long before — no provider run is needed here.
        active += 1
        const receipt: SubagentActivation = {
          childId,
          name,
          result: new Promise<SubagentResult>(() => {}),
          dispose: async () => { release() },
        }
        receipts.push(receipt)
        return receipt
      }
      const provider = providers.get(spec.provider)
      if (provider === undefined || typeof provider.start !== 'function') {
        throw Object.assign(new Error(`no subagent provider registered for "${spec.provider}"`), { code: 'NO_PROVIDER' })
      }
      active += 1
      const controller = new AbortController()
      const run: SubagentRun = await provider.start({
        ...spec,
        cwd: spec.cwd ?? '/parent-default',
        signal: controller.signal,
      } as never)
      const result = run.result.then(value => value, (): SubagentResult => ({ output: [], stopReason: 'error' }))
      void result.then(release, release)
      const receipt: SubagentActivation = {
        childId,
        name,
        result,
        dispose: async () => { controller.abort(); await run.dispose(); release() },
      }
      receipts.push(receipt)
      return receipt
    },
  }
  return { service, specs, receipts }
}

/** The tools-service ctx fake: disposer / no-disposer / throwing register. */
export function fakeToolsCtx(mode: 'disposer' | 'none' | 'throw' = 'disposer') {
  const registered: Array<{ definition: { name: string; description: string; timeoutMs: number; execute: AcpDelegateExecute; output?: { schema: Record<string, unknown>; render: (args: unknown, value: unknown) => Array<{ type: 'text'; text: string }> } }; options?: { when?: (ctx: { agent?: unknown }) => boolean } }> = []
  let disposerCalls = 0
  let injectCallback: (() => void) | undefined
  const injectCallbacks = new Map<string, () => void>()
  let tools: unknown
  let liveMode = mode
  const install = () => {
    tools = {
      get: (name: string) => registered.find(row => row.definition.name === name)?.definition,
      register: (definition: { name: string; description: string; timeoutMs: number; execute: AcpDelegateExecute }, options?: { when?: (ctx: { agent?: unknown }) => boolean }) => {
        if (liveMode === 'throw') throw new TypeError('output.render is required')
        registered.push({ definition, options })
        if (liveMode === 'none') return undefined
        return () => {
          disposerCalls += 1
          const index = registered.findIndex(row => row.definition === definition)
          if (index >= 0) registered.splice(index, 1)
        }
      },
    }
  }
  const ctx: DelegateRegistrationCtx = {
    get: (name: string) => (name === 'tools' ? tools : undefined),
    inject: (names: string[], callback: () => void) => {
      if (names.includes('tools')) injectCallback = callback
      for (const name of names) injectCallbacks.set(name, callback)
    },
  }
  return {
    ctx, registered, install,
    setMode: (next: 'disposer' | 'none' | 'throw') => { liveMode = next },
    disposerCalls: () => disposerCalls,
    fireInject: () => { injectCallback?.() },
    fireNamedInject: (name: string) => { injectCallbacks.get(name)?.() },
    injectArmed: () => injectCallback !== undefined,
    namedInjectArmed: (name: string) => injectCallbacks.has(name),
  }
}