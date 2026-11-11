/**
 * Timing coverage for the Antigravity transcript watch's two clocks (the
 * activity-extended IDLE window and the absolute HARD CEILING). The service is
 * driven directly against a real temp transcript so the windows can be tiny
 * and the assertions precise; the full mock-child path lives in
 * agy-late-output.spec.ts.
 */
import { appendFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { AgyLateOutputService } from '../src/bridge/agy-late-output.ts'
import { DEFAULT_TUNING } from '../src/bridge/tuning.ts'
import type { LiveSession } from '../src/bridge/turn-stream.ts'
import type { BridgeTuning } from '../src/bridge/types.ts'
import type { AcpAgentDef } from '../src/protocol.ts'

const def: AcpAgentDef = {
  id: 'agy', title: 'Antigravity', command: 'agy', args: ['acp'],
  env: {}, cwd: tmpdir(), allowedCwdRoots: [tmpdir()],
}

async function until(condition: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('condition never became true')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

interface WatchHarness {
  service: AgyLateOutputService
  session: LiveSession
  file: string
  deliveries: string[]
  setBusy(busy: boolean): void
  cleanup(): void
}

/**
 * A service whose only agent is Antigravity, watching a real temp transcript.
 * The idle window defaults to 150 ms and the poll/quiet cadence is fast, so a
 * test can outlive the window with activity in a few hundred milliseconds.
 */
function watchHarness(overrides: Partial<BridgeTuning> = {}): WatchHarness {
  const workspace = mkdtempSync(join(tmpdir(), 'dsh-ntr-agy-watch-'))
  const acpSessionId = 'acp-watch-test'
  const dir = join(workspace, 'brain', acpSessionId, '.system_generated', 'logs')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'transcript_full.jsonl')
  // A baseline step so the file exists at arm time and the baseline index is 0.
  appendFileSync(file, `${JSON.stringify({ step_index: 0, type: 'USER_INPUT', status: 'DONE', content: 'seed' })}\n`)

  const deliveries: string[] = []
  let busy = false
  const session = {
    sessionId: 'acp-session-1',
    dshSessionId: 'dsh-watch',
    agentId: 'agy',
    acpSessionId,
    closed: false,
    released: false,
    running: false,
    promptInFlight: false,
  } as unknown as LiveSession

  const service = new AgyLateOutputService({
    isAgent: () => true,
    storeRoot: () => workspace,
    tuning: () => ({
      ...DEFAULT_TUNING,
      agyLateOutputPollMs: 10,
      agyLateOutputQuietMs: 20,
      agyLateOutputMaxMs: 150,
      agyLateOutputCeilingMs: 0,
      ...overrides,
    }),
    host: {
      defOf: () => def,
      isBusy: () => busy,
      deliver: (_session, text) => { deliveries.push(text); return true },
    },
  })
  return {
    service,
    session,
    file,
    deliveries,
    setBusy: next => { busy = next },
    cleanup: () => { service.disarm(session); rmSync(workspace, { recursive: true, force: true }) },
  }
}

let stepCounter = 0
/** Append one transcript step dated NOW (second precision, like agy). */
function appendStep(file: string, type: string, content: string): void {
  stepCounter += 1
  const line = JSON.stringify({
    step_index: stepCounter,
    type,
    status: 'DONE',
    created_at: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    content,
  })
  appendFileSync(file, `${line}\n`)
}

describe('AGY-WATCH: idle window and hard ceiling', () => {
  const cleanups: Array<() => void> = []
  afterAll(() => { for (const cleanup of cleanups.splice(0)) cleanup() })

  function harness(overrides: Partial<BridgeTuning> = {}): WatchHarness {
    const h = watchHarness(overrides)
    cleanups.push(h.cleanup)
    return h
  }

  it('stands down after the idle window when no step arrives', async () => {
    const h = harness({ agyLateOutputMaxMs: 120 })
    h.service.arm(h.session, Date.now())
    expect(h.service.armedCount).toBe(1)
    await until(() => h.service.armedCount === 0)
    expect(h.deliveries).toHaveLength(0)
  })

  it('keeps watching while non-answer steps keep arriving, then delivers', async () => {
    // The answer lands well AFTER the original 150 ms idle window; only the
    // activity extension keeps the watch alive to receive it.
    const h = harness({ agyLateOutputMaxMs: 150 })
    h.service.arm(h.session, Date.now())
    for (let i = 0; i < 6; i += 1) {
      await sleep(60)
      appendStep(h.file, 'SYSTEM_MESSAGE', `subagent progress ${i}`)
    }
    // ~360 ms elapsed: a fixed deadline would have disarmed at 150 ms.
    expect(h.service.armedCount).toBe(1)
    appendStep(h.file, 'PLANNER_RESPONSE', 'the late answer')
    await until(() => h.deliveries.length === 1)
    expect(h.deliveries[0]).toBe('the late answer')
    expect(h.service.armedCount).toBe(0)
  })

  it('cuts the watch at the hard ceiling even while activity continues', async () => {
    const h = harness({ agyLateOutputMaxMs: 5_000, agyLateOutputCeilingMs: 150 })
    h.service.arm(h.session, Date.now())
    const timer = setInterval(() => { appendStep(h.file, 'SYSTEM_MESSAGE', 'still working') }, 30)
    try {
      await until(() => h.service.armedCount === 0)
      // The ceiling, not the idle window, ended it (activity never stopped).
      expect(h.deliveries).toHaveLength(0)
    } finally {
      clearInterval(timer)
    }
  })

  it('delivers a collected answer when the hard ceiling fires', async () => {
    // Quiet is longer than the ceiling, so only the ceiling can settle it.
    const h = harness({ agyLateOutputMaxMs: 5_000, agyLateOutputQuietMs: 5_000, agyLateOutputCeilingMs: 150 })
    h.service.arm(h.session, Date.now())
    appendStep(h.file, 'PLANNER_RESPONSE', 'answer before the ceiling')
    await until(() => h.deliveries.length === 1)
    expect(h.deliveries[0]).toBe('answer before the ceiling')
    expect(h.service.armedCount).toBe(0)
  })

  it('stands down as soon as the session is busy', async () => {
    const h = harness({ agyLateOutputMaxMs: 5_000 })
    h.service.arm(h.session, Date.now())
    h.setBusy(true)
    await until(() => h.service.armedCount === 0)
    expect(h.deliveries).toHaveLength(0)
  })
})