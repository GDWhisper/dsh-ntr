import { type ChildProcess, spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { afterAll, describe, expect, it } from 'vitest'
import { AcpLlmAdapter, AgentBridge, BridgeManager, killProcessTree, windowsShimLaunch } from '../../src/bridge.ts'
import { type AcpAgentDef, type AcpEvent, type StreamChunk } from '../../src/protocol.ts'
import { dispatchRpc, EventHub } from '../../src/impl.ts'
import { def, isAlive, MOCK, until } from './harness.ts'

describe('reliability (isolated manager, short timeouts)', () => {
  const relWorkspace = `${tmpdir()}/dsh-ntr-rel-workspace`
  mkdirSync(relWorkspace, { recursive: true })
  const relHub = new EventHub()
  const relEvents: AcpEvent[] = []
  relHub.subscribe(event => { relEvents.push(event) })
  const relManager = new BridgeManager(
    [{
      ...def,
      id: 'rel',
      cwd: `${tmpdir()}/dsh-ntr-rel-workspace`,
      allowedCwdRoots: [`${tmpdir()}/dsh-ntr-rel-workspace`],
    }],
    relHub,
    500,
    undefined,
    undefined,
    true,
    // `abort` is spelled out because the plugin's own default is `wait`
    // (never expire), and `wait` outranks `permissionTimeoutMs` — the case
    // below IS the deadline firing.
    { startupTimeoutMs: 2_500, permissionTimeoutMs: 700, cancelFallbackMs: 400, permissionTimeoutMode: 'abort' },
  )

  function relWaitFor<T extends AcpEvent['type']>(type: T, predicate: (event: Extract<AcpEvent, { type: T }>) => boolean, timeoutMs = 15_000): Promise<Extract<AcpEvent, { type: T }>> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout waiting for ${type}`)), timeoutMs)
      const unsub = relHub.subscribe(event => {
        if (event.type === type && predicate(event as Extract<AcpEvent, { type: T }>)) {
          clearTimeout(timer)
          unsub()
          resolve(event as Extract<AcpEvent, { type: T }>)
        }
      })
      const existing = relEvents.find(event => event.type === type && predicate(event as Extract<AcpEvent, { type: T }>))
      if (existing !== undefined) {
        clearTimeout(timer)
        unsub()
        resolve(existing as Extract<AcpEvent, { type: T }>)
      }
    })
  }

  afterAll(async () => {
    await relManager.shutdownAll()
  })

  it('fails a hung agent with agent_timeout instead of hanging forever', async () => {
    const hung = new BridgeManager(
      [{ ...def, id: 'hung', command: process.execPath, args: ['-e', 'process.stdin.resume()'] }],
      relHub,
      100,
      undefined,
      undefined,
      true,
      { startupTimeoutMs: 700 },
    )
    try {
      const result = await dispatchRpc(hung, 'session/start', { agentId: 'hung' })
      // Startup failures surface as agent_unreachable; the timeout detail
      // (what stalled, the budget, the stderr tail) rides in the message.
      expect(result).toMatchObject({ ok: false, error: { code: 'agent_unreachable' } })
      if (result.ok) return
      expect(result.error.message).toContain('did not answer initialize')
      // The wedged child must be torn down, not left behind.
      expect(hung.agentViews().find(a => a.id === 'hung')?.state).toBe('error')
    } finally {
      await hung.shutdownAll()
    }
  }, 15_000)

  it('keeps the error state when the child dies during the handshake', async () => {
    // A CRASH is not a teardown: the settings card auto-expands on
    // `state=error` + `stderrTail`, which is the only place the user can see why
    // the agent will not start. Regression for `releaseAll` bumping
    // `teardownEpoch`: the crash release then looked like a deliberate teardown
    // to the start's own catch, which published nothing and left the failed card
    // collapsed and unexplained.
    //
    // The child hands its stdout to a GRANDCHILD on purpose: that keeps the pipe
    // open after it dies, so its own `exit` (→ `connectionLost` →
    // `releaseAll('died')`) is guaranteed to land before the connection teardown
    // rejects the pending `initialize`. The other order never reaches
    // `releaseAll` and passed even with the bug.
    const crash = new BridgeManager(
      [{
        ...def,
        id: 'crash',
        command: process.execPath,
        args: ['-e', [
          'const { spawn } = require("node:child_process")',
          'spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: ["ignore", "inherit", "inherit"] })',
          'console.error("boom: died during initialize")',
          'setTimeout(() => process.exit(3), 100)',
        ].join('; ')],
      }],
      relHub,
      100,
      undefined,
      undefined,
      true,
      { startupTimeoutMs: 5_000 },
    )
    try {
      const result = await dispatchRpc(crash, 'session/start', { agentId: 'crash' })
      // Caller-visible contract is unchanged: every failed start is
      // `agent_unreachable`.
      expect(result).toMatchObject({ ok: false, error: { code: 'agent_unreachable' } })
      const view = crash.agentViews().find(agent => agent.id === 'crash')
      expect(view?.state).toBe('error')
      expect(view?.stderrTail?.join('\n')).toContain('boom: died during initialize')
    } finally {
      await crash.shutdownAll()
    }
  }, 20_000)

  it('serves fs read/write requests inside the sandbox and refuses escapes', async () => {
    const start = await dispatchRpc(relManager, 'session/start', { agentId: 'rel' })
    if (!start.ok) throw new Error(`start failed: ${JSON.stringify(start)}`)
    const id = (start.value as { sessionId: string }).sessionId
    const workspaceRoot = `${tmpdir()}/dsh-ntr-rel-workspace`

    const write = await dispatchRpc(relManager, 'session/prompt', { sessionId: id, text: `WRITEFILE ${workspaceRoot}/fs-test/nested/probe.txt` })
    expect(write).toMatchObject({ ok: true })
    const writeEnd = await relWaitFor('turn/end', event => event.sessionId === id && event.stopReason === 'end_turn')
    void writeEnd
    const written = readFileSync(`${workspaceRoot}/fs-test/nested/probe.txt`, 'utf8')
    expect(written).toBe('written-by-mock-agent')

    const read = await dispatchRpc(relManager, 'session/prompt', { sessionId: id, text: `READFILE ${workspaceRoot}/fs-test/nested/probe.txt` })
    expect(read).toMatchObject({ ok: true })
    await relWaitFor('turn/end', event => event.sessionId === id && event.stopReason === 'end_turn' && relEvents.filter(e => e.type === 'turn/end' && e.sessionId === id).length >= 2)
    const transcript = await dispatchRpc(relManager, 'transcript/get', { sessionId: id })
    if (!transcript.ok) throw new Error('transcript failed')
    const text = (transcript.value as { entries: Array<{ update: Record<string, unknown> }> })
      .entries
      .filter(e => e.update.sessionUpdate === 'agent_message_chunk')
      .map(e => String((e.update.content as { text?: string }).text ?? ''))
      .join('')
    expect(text).toContain('READ_OK:written-by-mock-agent')

    // Escape attempts must surface as a refusal to the agent, never contents.
    const escape = await dispatchRpc(relManager, 'session/prompt', { sessionId: id, text: 'READFILE /etc/passwd' })
    expect(escape).toMatchObject({ ok: true })
    await relWaitFor('turn/end', event => event.sessionId === id && event.stopReason === 'end_turn' && relEvents.filter(e => e.type === 'turn/end' && e.sessionId === id).length >= 3)
    const transcript2 = await dispatchRpc(relManager, 'transcript/get', { sessionId: id })
    if (!transcript2.ok) throw new Error('transcript failed')
    const escapeText = (transcript2.value as { entries: Array<{ update: Record<string, unknown> }> })
      .entries
      .filter(e => e.update.sessionUpdate === 'agent_message_chunk')
      .map(e => String((e.update.content as { text?: string }).text ?? ''))
      .join('')
    expect(escapeText).toContain('READ_FAIL:')
    expect(escapeText).toContain('outside the session workspace')
  }, 30_000)

  it('resumes a session after the agent process dies (send to recover)', async () => {
    const start = await dispatchRpc(relManager, 'session/start', { agentId: 'rel' })
    if (!start.ok) throw new Error('start failed')
    const id = (start.value as { sessionId: string }).sessionId

    await dispatchRpc(relManager, 'session/prompt', { sessionId: id, text: 'DIE now' })
    const released = await relWaitFor('session/released', event => event.sessionId === id)
    expect(released.session.released).toBe(true)

    // The released session stays visible and readable (pre-crash transcript).
    const sessions = await dispatchRpc(relManager, 'sessions/list', {})
    if (!sessions.ok) throw new Error('sessions/list failed')
    const view = (sessions.value as { sessions: Array<{ sessionId: string; released?: boolean }> }).sessions.find(s => s.sessionId === id)
    expect(view?.released).toBe(true)

    // The next prompt respawns the agent and resumes via session/load.
    await dispatchRpc(relManager, 'session/prompt', { sessionId: id, text: 'back again' })
    const end = await relWaitFor('turn/end', event => event.sessionId === id && event.stopReason === 'end_turn')
    void end

    const transcript = await dispatchRpc(relManager, 'transcript/get', { sessionId: id })
    if (!transcript.ok) throw new Error('transcript failed')
    const text = (transcript.value as { entries: Array<{ update: Record<string, unknown> }> })
      .entries
      .filter(e => e.update.sessionUpdate === 'agent_message_chunk')
      .map(e => String((e.update.content as { text?: string }).text ?? ''))
      .join('')
    expect(text).toContain('REPLAYED: earlier conversation')
    expect(text).toContain('MOCK: echo back again')

    const resumed = await dispatchRpc(relManager, 'sessions/list', {})
    if (!resumed.ok) throw new Error('sessions/list failed')
    const resumedView = (resumed.value as { sessions: Array<{ sessionId: string; released?: boolean }> }).sessions.find(s => s.sessionId === id)
    expect(resumedView?.released).toBeUndefined()
  }, 30_000)

  it('force-finalizes a turn when the agent ignores cancel, and dedups the late real end', async () => {
    const start = await dispatchRpc(relManager, 'session/start', { agentId: 'rel' })
    if (!start.ok) throw new Error('start failed')
    const id = (start.value as { sessionId: string }).sessionId

    await dispatchRpc(relManager, 'session/prompt', { sessionId: id, text: 'IGNORE_CANCEL please' })
    await new Promise(resolve => setTimeout(resolve, 100))
    await dispatchRpc(relManager, 'session/cancel', { sessionId: id })

    // The fallback timer fires first: turn is force-finalized with an error.
    const fallback = await relWaitFor('turn/end', event => event.sessionId === id && event.error !== undefined && event.error.includes('force-finalized'))
    expect(fallback.turnId).toBe('')

    // The agent eventually finishes normally; the late real turn/end follows.
    const late = await relWaitFor('turn/end', event => event.sessionId === id && event.stopReason === 'end_turn')
    expect(late.turnId).not.toBe('')

    // And a prompt is possible again (the session did not stay running).
    const again = await dispatchRpc(relManager, 'session/prompt', { sessionId: id, text: 'fresh turn' })
    expect(again).toMatchObject({ ok: true, value: { accepted: true } })
    await relWaitFor('turn/end', event => event.sessionId === id && event.stopReason === 'end_turn' && event.turnId === (again.value as { turnId: string }).turnId)
  }, 30_000)

  it('answers a pending permission with cancelled after the timeout', async () => {
    const start = await dispatchRpc(relManager, 'session/start', { agentId: 'rel' })
    if (!start.ok) throw new Error('start failed')
    const id = (start.value as { sessionId: string }).sessionId

    await dispatchRpc(relManager, 'session/prompt', { sessionId: id, text: 'PERM hold' })
    const request = await relWaitFor('permission/request', event => event.sessionId === id)
    const resolved = await relWaitFor('permission/resolved', event => event.requestId === request.requestId)
    expect(resolved.outcome).toEqual({ outcome: 'cancelled' })
    // The notice explains what happened, and the turn still settles.
    await relWaitFor('agent/notice', event => event.text.includes('timed out'))
    const end = await relWaitFor('turn/end', event => event.sessionId === id && event.stopReason === 'end_turn')
    void end
  }, 30_000)
})

describe('stale cancel and silent stops (isolated manager)', () => {
  const scWorkspace = `${tmpdir()}/dsh-ntr-sc-workspace`
  mkdirSync(scWorkspace, { recursive: true })
  const scHub = new EventHub()
  const scEvents: AcpEvent[] = []
  scHub.subscribe(event => { scEvents.push(event) })
  const scManager = new BridgeManager(
    [{
      ...def,
      id: 'sc',
      cwd: scWorkspace,
      allowedCwdRoots: [scWorkspace],
    }],
    scHub,
    500,
    undefined,
    undefined,
    true,
    // cancelFallbackMs 800ms: longer than the mock's 300ms stale-cancel window,
    // so the generation-guard case can start a successor turn before it fires.
    { startupTimeoutMs: 2_500, cancelFallbackMs: 800, staleCancelRetryDelayMs: 500, staleCancelMaxRetries: 2 },
  )

  afterAll(async () => {
    await scManager.shutdownAll()
  })

  function scWaitFor<T extends AcpEvent['type']>(type: T, predicate: (event: Extract<AcpEvent, { type: T }>) => boolean, timeoutMs = 15_000): Promise<Extract<AcpEvent, { type: T }>> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout waiting for ${type}`)), timeoutMs)
      const unsub = scHub.subscribe(event => {
        if (event.type === type && predicate(event as Extract<AcpEvent, { type: T }>)) {
          clearTimeout(timer)
          unsub()
          resolve(event as Extract<AcpEvent, { type: T }>)
        }
      })
      const existing = scEvents.find(event => event.type === type && predicate(event as Extract<AcpEvent, { type: T }>))
      if (existing !== undefined) {
        clearTimeout(timer)
        unsub()
        resolve(existing as Extract<AcpEvent, { type: T }>)
      }
    })
  }

  it('does not force-finalize a LATER turn when an old cancel fallback fires', async () => {
    const start = await dispatchRpc(scManager, 'session/start', { agentId: 'sc' })
    if (!start.ok) throw new Error('start failed')
    const id = (start.value as { sessionId: string }).sessionId

    // Turn 1 settles promptly, so the fallback armed below outlives it.
    const p1 = await dispatchRpc(scManager, 'session/prompt', { sessionId: id, text: 'hello' })
    if (!p1.ok) throw new Error('prompt failed')
    await scWaitFor('turn/end', event => event.sessionId === id && event.turnId === (p1.value as { turnId: string }).turnId && event.stopReason === 'end_turn')

    // Cancel while IDLE: arms the 800ms fallback for the (already finished)
    // current generation — exactly the timer that used to murder whatever
    // turn happened to be running when it fired.
    await dispatchRpc(scManager, 'session/cancel', { sessionId: id })
    // Out-wait the mock's 300ms stale-cancel window so turn 2 is not swallowed.
    await new Promise(resolve => setTimeout(resolve, 350))

    // Turn 2 runs far longer than the remaining fallback window (the mock
    // sleeps ~1.2s on IGNORE_CANCEL). Without the generation guard the timer
    // would force-finalize THIS turn mid-flight and broadcast a bogus error.
    const p2 = await dispatchRpc(scManager, 'session/prompt', { sessionId: id, text: 'IGNORE_CANCEL please' })
    if (!p2.ok) throw new Error('prompt failed')
    const end2 = await scWaitFor('turn/end', event => event.sessionId === id && event.turnId === (p2.value as { turnId: string }).turnId, 10_000)
    expect(end2.stopReason).toBe('end_turn')
    expect(end2.error).toBeUndefined()
    expect(scEvents.some(event =>
      event.type === 'turn/end'
      && event.sessionId === id
      && typeof event.error === 'string'
      && event.error.includes('force-finalized'),
    )).toBe(false)
  }, 30_000)

  it('resends a prompt the agent swallowed with a stale cancelled stop', async () => {
    const start = await dispatchRpc(scManager, 'session/start', { agentId: 'sc' })
    if (!start.ok) throw new Error('start failed')
    const id = (start.value as { sessionId: string }).sessionId

    // Turn 1 is cancelled properly (the mock answers it from the cancel).
    const p1 = await dispatchRpc(scManager, 'session/prompt', { sessionId: id, text: 'SLOW please' })
    if (!p1.ok) throw new Error('prompt failed')
    await new Promise(resolve => setTimeout(resolve, 150))
    await dispatchRpc(scManager, 'session/cancel', { sessionId: id })
    await scWaitFor('turn/end', event => event.sessionId === id && event.turnId === (p1.value as { turnId: string }).turnId && event.stopReason === 'cancelled')

    // Turn 2 lands inside the mock's 300ms cleanup window and is answered
    // `cancelled` without a turn — the user's message, silently swallowed.
    // The bridge must detect the stale stop (no cancel was requested for THIS
    // generation) and resend after the retry delay, out-waiting the window.
    const p2 = await dispatchRpc(scManager, 'session/prompt', { sessionId: id, text: 'fresh turn' })
    if (!p2.ok) throw new Error('prompt failed')
    const end2 = await scWaitFor('turn/end', event => event.sessionId === id && event.turnId === (p2.value as { turnId: string }).turnId, 10_000)
    // Only the resent prompt can end normally: the first attempt was swallowed.
    expect(end2.stopReason).toBe('end_turn')
  }, 30_000)

  it('does not resend a stale cancelled answer once a successor turn owns the session', async () => {
    // The swallow retry is only safe while the generation that sent the prompt
    // still owns the session. Here the cancelled answer arrives late, after a
    // successor turn began (what the cancel fallback + the user's next message
    // produce): resending would fire a second session/prompt into that turn.
    const logPath = `${scWorkspace}/stale-late-prompts-${String(process.pid)}-${String(Date.now())}.log`
    const lateHub = new EventHub()
    const lateManager = new BridgeManager([
      { ...def, id: 'late', cwd: scWorkspace, allowedCwdRoots: [scWorkspace], env: { ...def.env, MOCK_PROMPT_LOG: logPath } },
    ], lateHub, 500, undefined, undefined, true, {
      startupTimeoutMs: 3_000,
      staleCancelRetryDelayMs: 250,
      staleCancelMaxRetries: 2,
    })
    try {
      const start = await dispatchRpc(lateManager, 'session/start', { agentId: 'late' })
      if (!start.ok) throw new Error('start failed')
      const id = (start.value as { sessionId: string }).sessionId
      const located = await lateManager.locateOrResume(id)
      const turnGen = located.session.turnSeq

      const pending = located.bridge.runPrompt(located.session, 'STALE_LATE please', 'turn-stale-late', turnGen)
      // Wait for the prompt to REACH the agent (the mock answers it 450ms
      // later), then move the generation on: everything the old prompt says
      // from here belongs to a superseded turn.
      const deadline = Date.now() + 10_000
      for (;;) {
        const lines = existsSync(logPath)
          ? readFileSync(logPath, 'utf8').split('\n').filter(line => line !== '')
          : []
        if (lines.length >= 1) break
        if (Date.now() > deadline) throw new Error('the prompt never reached the agent')
        await new Promise(resolve => setTimeout(resolve, 5))
      }
      located.session.turnSeq = turnGen + 1

      // The late answer comes back as-is, not as a resent prompt.
      await expect(pending).resolves.toMatchObject({ stopReason: 'cancelled' })
      // Bounded negative wait past the retry delay: no second prompt went out.
      await new Promise(resolve => setTimeout(resolve, 400))
      const lines = readFileSync(logPath, 'utf8').split('\n').filter(line => line !== '')
      expect(lines).toEqual(['STALE_LATE please'])
    } finally {
      await lateManager.shutdownAll()
      rmSync(logPath, { force: true })
    }
  }, 30_000)

  it('does not resend a stale cancelled prompt when a second stop lands during the retry delay', async () => {
    // Two clicks on stop inside one turn's retry window: the second cancel
    // names the SAME generation, so the generation guard alone would still
    // resend a prompt the user has already stopped. The resend is only for the
    // stale-cancel swallow — a requested cancel must win.
    const logPath = `${scWorkspace}/double-cancel-prompts-${String(process.pid)}-${String(Date.now())}.log`
    const hub = new EventHub()
    const manager = new BridgeManager([
      { ...def, id: 'double-cancel', cwd: scWorkspace, allowedCwdRoots: [scWorkspace], env: { ...def.env, MOCK_PROMPT_LOG: logPath } },
    ], hub, 500, undefined, undefined, true, {
      startupTimeoutMs: 3_000,
      // The mock answers `cancelled` at once and ticks 10ms later, so the
      // second cancel lands with nearly the whole (deliberately long) delay to
      // spare. The assertions below do not depend on measuring that margin:
      // the run only returns once the delay has elapsed.
      staleCancelRetryDelayMs: 2_000,
      staleCancelMaxRetries: 2,
      cancelFallbackMs: 5_000,
    })
    try {
      const start = await dispatchRpc(manager, 'session/start', { agentId: 'double-cancel' })
      if (!start.ok) throw new Error('start failed')
      const id = (start.value as { sessionId: string }).sessionId
      const located = await manager.locateOrResume(id)
      const turnGen = located.session.turnSeq

      // The tick is bookkeeping (opens nothing), but it arrives AFTER the
      // `cancelled` response: seeing it proves the client is already in its
      // retry delay — no sleep-based guess about where the response is.
      const answered = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('the cancelled answer never landed')), 10_000)
        const unsub = hub.subscribe(event => {
          if (event.type !== 'session/update') return
          if (event.sessionId !== located.session.sessionId) return
          if (event.update.sessionUpdate !== 'usage_update') return
          clearTimeout(timer)
          unsub()
          resolve()
        })
      })
      const pending = located.bridge.runPrompt(located.session, 'STALE_TICK please', 'turn-double-cancel', turnGen)
      await answered
      await located.bridge.cancel(located.session)

      await expect(pending).resolves.toMatchObject({ stopReason: 'cancelled' })
      // `runPrompt` returns only after its retry delay elapsed (or the answer
      // was not retryable), so a buggy resend would already have reached the
      // agent and appended its line. No fixed sleep guesses at the delay.
      const lines = existsSync(logPath)
        ? readFileSync(logPath, 'utf8').split('\n').filter(line => line !== '')
        : []
      expect(lines).toEqual(['STALE_TICK please'])
    } finally {
      await manager.shutdownAll()
      rmSync(logPath, { force: true })
    }
  }, 30_000)

  it('reports a normal stop that produced no visible output', async () => {
    // The pi-acp shape: an upstream failure folded into a legal end_turn,
    // bookkeeping frames only — the user would see an empty bubble. The turn
    // must carry a visible hint instead.
    const adapter = new AcpLlmAdapter(scManager)
    const chunks: StreamChunk[] = []
    for await (const chunk of adapter.stream({
      provider: 'acp',
      model: 'sc',
      sessionId: 'dsh-sc-empty-turn',
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'EMPTY please' }] },
      ],
    })) {
      chunks.push(chunk)
    }

    const text = chunks
      .filter((c): c is Extract<StreamChunk, { type: 'text-delta' }> => c.type === 'text-delta')
      .map(c => c.text)
      .join('')
    expect(text).toContain('no visible output')
    expect(text).toContain('end_turn')
    const finish = chunks.find((c): c is Extract<StreamChunk, { type: 'finish' }> => c.type === 'finish')
    expect(finish?.reason.kind).toBe('stop')
  }, 30_000)
})

/**
 * Windows: every npm-installed ACP agent is a generated `.cmd` shim, and Node
 * refuses to spawn one with `shell: false` (BatBadBut) — it throws EINVAL
 * before any process exists. The launch shape below is what makes `codebuddy`,
 * `pi-acp` and `omp` start at all on that platform, and the two details it
 * encodes (verbatim arguments, the outer quote pair) were measured, not
 * guessed: without either one cmd.exe reports the line as "not recognized".
 */
describe('windows shim launch', () => {
  /** The shim writes its (grand)child's pid there once node is up. */
  async function waitForPid(marker: string): Promise<number> {
    await until(() => existsSync(marker))
    const pid = Number(readFileSync(marker, 'utf-8').trim())
    expect(Number.isInteger(pid) && pid > 0).toBe(true)
    return pid
  }

  it('wraps .cmd/.bat in cmd.exe and leaves everything else alone', () => {
    // Not a shim → untouched, verbatim off.
    expect(windowsShimLaunch('codebuddy', ['--acp'])).toEqual({ command: 'codebuddy', args: ['--acp'], verbatim: false })
    expect(windowsShimLaunch(process.execPath, ['x'], 'win32')).toEqual({ command: process.execPath, args: ['x'], verbatim: false })
    // A shim, off Windows → untouched (the POSIX shim is a real script).
    expect(windowsShimLaunch('/usr/local/bin/codebuddy', [], 'linux')).toEqual({ command: '/usr/local/bin/codebuddy', args: [], verbatim: false })
    // The shim itself: run through cmd.exe, quotes preserved verbatim.
    expect(windowsShimLaunch('C:\\nvm4w\\nodejs\\codebuddy.CMD', ['--acp'], 'win32', 'cmd.exe')).toEqual({
      command: 'cmd.exe',
      args: ['/d', '/s', '/c', '"C:\\nvm4w\\nodejs\\codebuddy.CMD --acp"'],
      verbatim: true,
    })
    // A path with spaces is quoted token by token, then the line is wrapped so
    // `/s` strips the wrapping instead of the program's own quotes.
    expect(windowsShimLaunch('C:\\Program Files\\x agent.cmd', ['a b'], 'win32', 'cmd.exe')).toEqual({
      command: 'cmd.exe',
      args: ['/d', '/s', '/c', '""C:\\Program Files\\x agent.cmd" "a b""'],
      verbatim: true,
    })
  })

  it.runIf(process.platform === 'win32')('spawns a .cmd shim (path with a space) and completes initialize', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-ntr shim '))
    try {
      const shim = join(dir, 'mock agent.cmd')
      writeFileSync(shim, `@echo off\r\n"${process.execPath}" "${MOCK}" %*\r\n`)
      const shimHub = new EventHub()
      const bridge = new AgentBridge({ ...def, id: 'shim', command: shim, args: [] }, shimHub, 200, () => {})
      await bridge.ensureReady()
      expect(bridge.initResult?.agentInfo?.name).toBe('mock-acp-agent')
      await bridge.stop()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 30_000)

  it.runIf(process.platform === 'win32')('killProcessTree reaps the agent behind the cmd.exe wrapper', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-ntr tree '))
    let child: ReturnType<typeof spawn> | undefined
    let grandchild = 0
    try {
      const marker = join(dir, 'grandchild.pid')
      const script = join(dir, 'sleeper.mjs')
      writeFileSync(script, `import { writeFileSync } from 'node:fs'\nwriteFileSync(${JSON.stringify(marker)}, String(process.pid))\nsetInterval(() => { /* keep alive */ }, 1000)\n`)
      const shim = join(dir, 'sleeper.cmd')
      writeFileSync(shim, `@echo off\r\n"${process.execPath}" "${script}"\r\n`)

      const launch = windowsShimLaunch(shim, [])
      child = spawn(launch.command, launch.args, { stdio: 'ignore', windowsHide: true, windowsVerbatimArguments: true })
      const cmdPid = child.pid
      expect(cmdPid).toBeDefined()

      grandchild = await waitForPid(marker)
      expect(isAlive(grandchild)).toBe(true)

      // Killing only the direct child (what the old Windows branch did) would
      // leave this process running: `taskkill /T` must see the tree intact.
      killProcessTree(cmdPid as number)
      // `taskkill` is a de-facto async kill — it is a process of its own, and it
      // measured 1.1 s to land on an idle box, 2.2 s under process-creation
      // pressure. The deadline below is a failure bound, not a speed assertion,
      // so give the OS room instead of racing a loaded suite.
      await until(() => !isAlive(grandchild), 20_000)
      expect(isAlive(grandchild)).toBe(false)
    } finally {
      // By pid, before the tree attempt: once cmd.exe is gone `taskkill /T`
      // cannot reach the sleeper, so a failed case used to leave it running
      // forever — leaked sleepers accumulate across runs and add process
      // pressure to every later one.
      if (grandchild > 0) {
        try {
          process.kill(grandchild, 'SIGKILL')
        } catch { /* already gone */ }
      }
      if (child?.pid !== undefined) killProcessTree(child.pid)
      rmSync(dir, { recursive: true, force: true })
    }
  }, 30_000)
})

/**
 * Host shutdown must leave no agent CHILD alive, and must not destroy the
 * conversations it parks: both are one path now (`BridgeManager.shutdownAll` →
 * `AgentBridge.shutdown`). The old path called `stop` per bridge, which asked
 * every session's agent to `session/close` (up to 5s EACH, before the child was
 * even signalled) and then cleared the released records — a host restart
 * destroyed every live conversation and could take N × 5s to exit.
 */
describe('host shutdown (isolated managers)', () => {
  /** The manager's bridge for one agent. `bridges` is private; the test needs it. */
  function bridgeOf(mgr: BridgeManager, agentId: string): AgentBridge {
    return (mgr as unknown as { bridges: Map<string, AgentBridge> }).bridges.get(agentId) as AgentBridge
  }

  /** The spawned child. `child` is private; the test needs its identity. */
  function childPidOf(bridge: AgentBridge): number | undefined {
    return (bridge as unknown as { child?: { pid?: number } }).child?.pid
  }

  /**
   * The child HANDLE, whose `exitCode` / `signalCode` can only be set by the OS
   * taking the process away. That is a stronger death fact than
   * `kill(pid, 0)`: a pid can be reused, and a terminated process can still
   * answer a query while a handle to it is open.
   */
  function childHandleOf(bridge: AgentBridge): ChildProcess | undefined {
    return (bridge as unknown as { child?: ChildProcess }).child
  }

  /** A process that never speaks ACP: the startup handshake stays pending. */
  const silentDef: AcpAgentDef = {
    ...def,
    id: 'silent',
    args: ['-e', 'setInterval(() => { /* keep alive */ }, 1000)'],
  }

  it('reaps the agent child and keeps the conversation resumable', async () => {
    const shutdownHub = new EventHub()
    const shutdownEvents: AcpEvent[] = []
    shutdownHub.subscribe(event => { shutdownEvents.push(event) })
    // A REAL state file: "still resumable after the host comes back" is a claim
    // about disk, so the restarted manager below has to read what this one wrote
    // (`VITEST` would otherwise make `persistAgents` a no-op).
    const stateDir = mkdtempSync(join(tmpdir(), 'acp-shutdown-'))
    const storage = join(stateDir, 'agents.json')
    const mgr = new BridgeManager([{ ...def, id: 'shutdown' }], shutdownHub, 500, storage)
    let pid = 0
    let sessionId = ''
    try {
      const session = await mgr.getOrCreateDshSession('dsh-shutdown-1', 'shutdown')
      sessionId = session.sessionId
      // PIDTAG: the mock appends the pid of the process that served the turn.
      await mgr.prompt(session.sessionId, 'hello PIDTAG')
      await until(() => {
        const { entries } = mgr.transcript(session.sessionId, undefined)
        const text = (entries as Array<{ update: Record<string, unknown> }>)
          .map(entry => String((entry.update.content as { text?: string } | undefined)?.text ?? ''))
          .join('')
        const found = /PID:(\d+)/.exec(text)
        if (found !== null) pid = Number(found[1])
        return pid > 0
      })
      expect(isAlive(pid)).toBe(true)
      const handle = childHandleOf(bridgeOf(mgr, 'shutdown')) as ChildProcess
      expect(handle.pid).toBe(pid)

      await mgr.shutdownAll()

      // The kill is AWAITED, and this is asserted WITHOUT a poll: the process is
      // gone the instant shutdown resolves. A poll would also pass for the old
      // fire-and-forget `killChild()` (the mock dies on SIGTERM anyway), which is
      // the regression this guards. The handle's `exitCode` / `signalCode` only
      // change when the OS took the process away; `kill(pid, 0)` is the same
      // fact through the pid.
      expect(handle.exitCode !== null || handle.signalCode !== null).toBe(true)
      expect(isAlive(pid)).toBe(false)
      // ...and the conversation was RELEASED, not closed: the record survives
      // and the next message (or a restarted host) can `session/load` it.
      expect(mgr.sessions()).toEqual([expect.objectContaining({ sessionId, released: true })])
      expect(shutdownEvents.some(event => event.type === 'session/closed' && event.sessionId === sessionId)).toBe(false)
      expect(shutdownEvents.some(event => event.type === 'session/released'
        && event.sessionId === sessionId && event.cause === 'shutdown')).toBe(true)
    } finally {
      await mgr.shutdownAll()
    }

    // A persist AFTER the shutdown must not erase what the shutdown saved:
    // `persistAgents` writes `dshSessionMap`, so clearing that map on the way
    // out is exactly how the parked records would vanish from disk. A late call
    // is normal traffic — any RPC that records a composer choice writes again.
    mgr.bindChatAgent('dsh-shutdown-late', 'shutdown')
    const onDisk = JSON.parse(readFileSync(storage, 'utf-8')) as {
      chatSessions?: Array<{ dshSessionId?: string; releaseCause?: string; releaseReason?: string; releasedAt?: number }>
    }
    expect(onDisk.chatSessions?.map(row => row.dshSessionId)).toEqual(['dsh-shutdown-1'])
    expect(onDisk.chatSessions?.[0]).toMatchObject({
      dshSessionId: 'dsh-shutdown-1',
      releaseCause: 'shutdown',
      releaseReason: 'the host is shutting down',
      releasedAt: expect.any(Number),
    })

    // A fresh manager over the same file IS the restarted host: the record must
    // come back parked (released → the next message resumes it), never closed.
    const restarted = new BridgeManager([{ ...def, id: 'shutdown' }], shutdownHub, 500, storage)
    try {
      expect(restarted.chatSessions('dsh-shutdown-1')).toMatchObject([
        {
          sessionId,
          agentId: 'shutdown',
          released: true,
          releaseCause: 'shutdown',
          releaseReason: 'the host is shutting down',
          releasedAt: expect.any(Number),
        },
      ])
      // Successful resume clears release observability from both live views and disk.
      await restarted.resumeChatSession('dsh-shutdown-1')
      const liveRow = restarted.chatSessions('dsh-shutdown-1')[0]
      expect(liveRow?.released).toBeUndefined()
      expect(liveRow?.releaseCause).toBeUndefined()
      expect(liveRow?.releaseReason).toBeUndefined()
      expect(liveRow?.releasedAt).toBeUndefined()
      const afterResume = JSON.parse(readFileSync(storage, 'utf-8')) as {
        chatSessions?: Array<{ dshSessionId?: string; releaseCause?: string; releaseReason?: string; releasedAt?: number }>
      }
      expect(afterResume.chatSessions?.[0]?.releaseCause).toBeUndefined()
      expect(afterResume.chatSessions?.[0]?.releaseReason).toBeUndefined()
      expect(afterResume.chatSessions?.[0]?.releasedAt).toBeUndefined()
    } finally {
      await restarted.shutdownAll()
      rmSync(stateDir, { recursive: true, force: true })
    }
  }, 30_000)

  it('leaves no live child when the host shuts down during startup', async () => {
    const silentHub = new EventHub()
    const bridge = new AgentBridge(silentDef, silentHub, 200, () => { /* no session to settle */ })
    // Never awaited yet: `initialize` is still outstanding, so the child is
    // alive and `state` is `starting` when the shutdown lands.
    const started = bridge.ensureReady()
    // Attach the rejection handler NOW: the killed handshake rejects long
    // before this test is done with the pid, and a late handler reads as an
    // unhandled rejection to the runner.
    const settled = started.catch(() => { /* the teardown owns the outcome */ })
    await until(() => childHandleOf(bridge) !== undefined)
    const child = childHandleOf(bridge) as ChildProcess
    const pid = child.pid as number
    expect(isAlive(pid)).toBe(true)

    // Windows `taskkill /T /F` is a separate process: under a loaded full-suite
    // run it can need more than one second to land. The assertion below is that
    // the kill is AWAITED, not that it fits a one-second budget (the production
    // default is 4s), so give the OS room instead of racing the suite's load.
    await bridge.shutdown(3_000)

    // The awaited kill must have reported the process gone BEFORE shutdown
    // resolved (the handle's exit is the OS fact; see `childHandleOf`), and this
    // is asserted without a poll on purpose: a poll would also pass for the old
    // fire-and-forget `killChild()`.
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true)
    expect(isAlive(pid)).toBe(false)
    // The abandoned start must not paint a live status over the stopped bridge.
    expect(bridge.state).toBe('stopped')
    expect(bridge.initResult).toBeUndefined()
    // The handshake fails when its child dies; a stale start must not surface
    // as an unhandled rejection or flip the state.
    await settled
    expect(bridge.state).toBe('stopped')
    // The SIGKILL / `taskkill` escalation itself is NOT covered anywhere in this
    // block: the mock exits on the first signal, and a signal-ignoring child
    // would mean a new fixture shared with tests that must not change.
  }, 30_000)

  it('never spawns after a stop that lands while the executable is resolving', async () => {
    const racedHub = new EventHub()
    const bridge = new AgentBridge({ ...silentDef, id: 'raced' }, racedHub, 200, () => { /* no session */ })
    // `ensureReady` yields at `ensureAgentExecutable` before it spawns, so this
    // stop lands inside that window — the one a global npm install can hold for
    // minutes.
    const started = bridge.ensureReady()
    await bridge.stop()

    // The start resolves without a child and without flipping state: the
    // teardown epoch refuses to create the process at all.
    await expect(started).resolves.toBeUndefined()
    expect(childPidOf(bridge)).toBeUndefined()
    expect(bridge.state).toBe('stopped')
  }, 15_000)
})
