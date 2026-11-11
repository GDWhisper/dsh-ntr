import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { BridgeManager, type AcpLlmAdapter } from '../../src/bridge.ts'
import { EventHub, dispatchRpc } from '../../src/impl.ts'
import type { AcpAgentDef, AcpEvent, StreamChunk } from '../../src/protocol.ts'

export const MOCK = fileURLToPath(new URL('../mock-agent.mjs', import.meta.url))

/** Separator-blind comparison: realpath answers `\` on Windows, the session cwd is folded to `/`. */
export function normPath(p: string): string {
  return p.replaceAll('\\', '/')
}

/**
 * Any `subagents/*` frame other than the plugin's record stream, since
 * `since`. The bridge used to emit a second, per-worker dot feed beside the
 * records; that feed is retired and the record stream is the only lifecycle
 * source, so any extra subagent frame kind is a regression.
 */
export function unexpectedSubagentFrames(source: readonly AcpEvent[], since: number): AcpEvent[] {
  return source.slice(since).filter(event => {
    const type = (event as { type: string }).type
    return type.startsWith('subagents/') && type !== 'subagents/record'
  })
}

export const def: AcpAgentDef = {
  id: 'mock',
  title: 'Mock',
  command: process.execPath,
  args: [MOCK],
  env: {},
  cwd: tmpdir(),
  allowedCwdRoots: [tmpdir()],
}

export function createBridgeHarness() {
  const hub = new EventHub()
  const manager = new BridgeManager([def], hub, 500)
  const events: AcpEvent[] = []
  hub.subscribe(event => { events.push(event) })

  function waitFor<T extends AcpEvent['type']>(type: T, predicate: (event: Extract<AcpEvent, { type: T }>) => boolean, timeoutMs = 15_000): Promise<Extract<AcpEvent, { type: T }>> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout waiting for ${type}`)), timeoutMs)
      const unsub = hub.subscribe(event => {
        if (event.type === type && predicate(event as Extract<AcpEvent, { type: T }>)) {
          clearTimeout(timer)
          unsub()
          resolve(event as Extract<AcpEvent, { type: T }>)
        }
      })
      // The event may already have arrived before the subscription.
      const existing = events.find(event => event.type === type && predicate(event as Extract<AcpEvent, { type: T }>))
      if (existing !== undefined) {
        clearTimeout(timer)
        unsub()
        resolve(existing as Extract<AcpEvent, { type: T }>)
      }
    })
  }

  return { hub, manager, events, waitFor }
}

/**
 * Wait until a session's transcript stops growing.
 *
 * The SDK paces the agent's output independently of the `session/prompt`
 * RESPONSE: a notification is routed into the session mailbox and handed to
 * `handleSessionUpdate` on a later microtask, so `prompt()` — and with it the
 * adapter stream — can resolve while the agent's LAST chunk is still queued.
 * Reading the transcript the instant a turn ends therefore races, and it lost
 * often enough to fail a release (CI saw the mock's echo come back as `MOCK:`
 * with the `perm=` suffix missing). Quiescence is the honest wait: two
 * consecutive reads agreeing means the fold caught up.
 *
 * Used by every `…Echo` helper below, not just the one that flaked — they all
 * read the same buffer the same way.
 */
export async function settleTranscript(manager: BridgeManager, sessionId: string, attempts = 40): Promise<void> {
  let previous = -1
  for (let i = 0; i < attempts; i++) {
    const answer = await dispatchRpc(manager, 'transcript/get', { sessionId })
    if (!answer.ok) throw new Error('transcript failed')
    const head = (answer.value as { entries: Array<{ seq: number }> }).entries.at(-1)?.seq ?? 0
    if (head === previous && head > 0) return
    previous = head
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

/** Poll a condition with a deadline: process death has no event we can await. */
export async function until(condition: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('condition never became true')
    await new Promise(resolve => setTimeout(resolve, 50))
  }
}

/** `kill(pid, 0)` is the portable liveness probe (EPERM would also mean alive). */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * End a child from a test, on every CI platform.
 *
 * The product's `killProcessTree` is deliberately Windows-only: its only
 * production callers are the `.cmd` shim teardown, where `taskkill /T /F` is
 * the point. On Linux / macOS that helper spawns a command that does not
 * exist, so a test that reuses it never kills anything. This local twin keeps
 * the Windows tree kill and uses SIGKILL elsewhere: first the process GROUP
 * (for a detached child), then the single pid when it is not a group leader.
 * Callers still confirm death with `until(() => !isAlive(pid))`.
 */
export function killTestProcessTree(pid: number): void {
  if (process.platform === 'win32') {
    const killer = spawn('taskkill', ['/pid', String(pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true })
    killer.on('error', () => { /* the liveness probe reports the failure */ })
    return
  }
  try {
    process.kill(-pid, 'SIGKILL')
    return
  } catch {
    /* not a process-group leader: fall through to the single pid */
  }
  try {
    process.kill(pid, 'SIGKILL')
  } catch {
    /* already gone */
  }
}

/**
 * Drive the adapter the way the host agent-loop does (docs/acp-convergence.md
 * §1.5/§1.7): stream one step; while its chunks carried `tool-call` blocks and
 * it finished with `stop`, stage those calls' results as tool-sourced messages
 * and stream the CONTINUATION — the real loop re-runs with no finish-reason
 * gate whenever the settled message contains a tool-call block. Returns every
 * chunk of every step, in step order.
 */
export async function hostLoopTurn(
  adapter: AcpLlmAdapter,
  request: Parameters<typeof adapter.stream>[0],
  maxSteps = 8,
  signal?: AbortSignal,
  /** Simulated card-execution gap before each continuation step opens. */
  stepDelayMs = 0,
): Promise<{ chunks: StreamChunk[]; steps: StreamChunk[][] }> {
  const steps: StreamChunk[][] = []
  let messages = request.messages ?? []
  for (let step = 0; step < maxSteps; step += 1) {
    if (step > 0 && stepDelayMs > 0) await new Promise(resolve => setTimeout(resolve, stepDelayMs))
    const chunks: StreamChunk[] = []
    for await (const chunk of adapter.stream({
      ...request,
      messages,
      ...(signal === undefined ? {} : { signal }),
    })) chunks.push(chunk)
    steps.push(chunks)
    const finish = chunks.find((c): c is Extract<StreamChunk, { type: 'finish' }> => c.type === 'finish')
    const callIds = [...new Set(chunks.filter(c => c.type === 'tool-call-delta').map(c => (c as { id: string }).id))]
    if (finish === undefined || finish.reason.kind !== 'stop' || callIds.length === 0) break
    messages = [...messages, ...callIds.map(id => ({
      role: 'tool' as const,
      source: { kind: 'tool' as const, callId: id },
      content: [{ type: 'text' as const, text: 'staged result' }],
    }))]
  }
  return { chunks: steps.flat(), steps }
}