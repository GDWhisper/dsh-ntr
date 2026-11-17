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
  failures: string[]
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
  const failures: string[] = []
  let busy = false
  const session = {
    sessionId: 'acp-session-1',
    dshSessionId: 'dsh-watch',
    agentId: 'agy',
    acpSessionId,
    lifecycle: 'live',
    running: false,
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
      deliver: (_session, text, _thought, failure) => {
        if (failure === true) failures.push(text)
        else deliveries.push(text)
        return true
      },
    },
  })
  return {
    service,
    session,
    file,
    deliveries,
    failures,
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

  /** The measured sender=system failure report (session-a12ff72b). */
  function appendFailure(file: string, childId = 'child-9'): void {
    appendStep(file, 'SYSTEM_MESSAGE', `[Message] timestamp=${new Date().toISOString()} sender=system priority=MESSAGE_PRIORITY_HIGH content=The subagent Worker (self) with id "${childId}" encountered an error and has either stopped or failed to start execution: agent executor error: request failed: EOF`)
  }

  it('surfaces a measured failure when no answer arrives', async () => {
    const h = harness({ agyLateOutputMaxMs: 5_000, agyLateOutputQuietMs: 30 })
    h.service.arm(h.session, Date.now())
    appendFailure(h.file)
    await until(() => h.failures.length === 1)
    expect(h.failures[0]).toContain('encountered an error')
    expect(h.failures[0]).toContain('EOF')
    expect(h.deliveries).toHaveLength(0)
    expect(h.service.armedCount).toBe(0)
  })

  it('a late answer still wins over a failure report', async () => {
    const h = harness({ agyLateOutputMaxMs: 5_000, agyLateOutputQuietMs: 60 })
    h.service.arm(h.session, Date.now())
    appendFailure(h.file)
    // The answer lands inside the quiet window: it wins, no failure delivery.
    await sleep(20)
    appendStep(h.file, 'PLANNER_RESPONSE', 'recovered answer')
    await until(() => h.deliveries.length === 1)
    expect(h.deliveries[0]).toBe('recovered answer')
    expect(h.failures).toHaveLength(0)
  })

  it('surfaces a failure even when the only answer is the turn own late write', async () => {
    // The turn's own answer (already shown) is not NEW information; a failure
    // report in the same window still is, and must surface (P2-3).
    const h = harness({ agyLateOutputMaxMs: 5_000, agyLateOutputQuietMs: 30 })
    ;(h.session as unknown as { lastTurnAnswerText?: string }).lastTurnAnswerText = 'already shown'
    h.service.arm(h.session, Date.now())
    appendStep(h.file, 'PLANNER_RESPONSE', 'already shown')
    appendFailure(h.file)
    await until(() => h.failures.length === 1)
    expect(h.deliveries).toHaveLength(0)
    expect(h.service.armedCount).toBe(0)
  })

  it('the idle deadline surfaces a failure that never went quiet on its own', async () => {
    // Quiet is long; only the idle deadline settles the watch. The failure
    // payload still surfaces (settle's failure branch).
    const h = harness({ agyLateOutputMaxMs: 120, agyLateOutputQuietMs: 5_000 })
    h.service.arm(h.session, Date.now())
    appendFailure(h.file)
    await until(() => h.failures.length === 1)
    expect(h.failures[0]).toContain('encountered an error')
    expect(h.service.armedCount).toBe(0)
  })

  it('a non-failure system notice does not surface as a failure', async () => {
    const h = harness({ agyLateOutputMaxMs: 150, agyLateOutputQuietMs: 30 })
    h.service.arm(h.session, Date.now())
    appendStep(h.file, 'SYSTEM_MESSAGE', '[Message] sender=system content=ordinary progress note')
    await until(() => h.service.armedCount === 0)
    expect(h.failures).toHaveLength(0)
    expect(h.deliveries).toHaveLength(0)
  })
})