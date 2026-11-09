import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'
import { accessSync, constants, existsSync, realpathSync } from 'node:fs'

import { AcpError, quoteCommandToken } from '../impl.ts'
import type { AcpAgentDef, DetectedAgentInfo } from '../protocol.ts'
import { AGENT_PRESETS } from './state-paths.ts'

export function findExecutable(command: string): string | undefined {
  if (command.includes('/') || command.includes('\\')) {
    if (existsSync(command)) {
      try {
        accessSync(command, constants.X_OK)
        return realpathSync(command)
      } catch {
        return undefined
      }
    }
    return undefined
  }

  const envPath = process.env.PATH ?? ''
  const dirs = envPath.split(delimiter).filter(Boolean)
  const extraDirs = [
    join(homedir(), '.pi', 'agent', 'bin'),
    join(homedir(), '.bun', 'bin'),
    join(homedir(), '.local', 'bin'),
  ]
  const allDirs = [...new Set([...dirs, ...extraDirs])]

  const extensions = process.platform === 'win32'
    ? (process.env.PATHEXT ? process.env.PATHEXT.split(';') : ['.exe', '.cmd', '.bat'])
    : ['']

  for (const dir of allDirs) {
    for (const ext of extensions) {
      const candidate = join(dir, `${command}${ext}`)
      if (existsSync(candidate)) {
        try {
          accessSync(candidate, constants.X_OK)
          return realpathSync(candidate)
        } catch {
          // Continue searching
        }
      }
    }
  }
  return undefined
}

/** Budget for one `npm install -g` triggered by `npmPackage` (cold installs are slow). */
const NPM_INSTALL_TIMEOUT_MS = 180_000

/** A generated Windows shim: what every npm-installed agent resolves to (`codebuddy.CMD`). */
const WINDOWS_SHIM_PATTERN = /\.(?:cmd|bat)$/i

/** cmd.exe metacharacters that force quoting; inside a quoted run they are literal. */
const CMD_QUOTE_TRIGGER = /[\s"&|<>^()]/

/** Quote one command-line token for `cmd.exe`. */
function quoteForCmd(token: string): string {
  if (token !== '' && !CMD_QUOTE_TRIGGER.test(token)) return token
  return `"${token.replaceAll('"', '\\"')}"`
}

export interface ShimLaunch {
  command: string
  args: string[]
  /** The caller must pass `windowsVerbatimArguments: true` (see below). */
  verbatim: boolean
}

/**
 * Turn a resolved executable + argv into a spawnable launch.
 *
 * WHY: on Windows every npm-installed ACP agent is a generated `.cmd` shim
 * (`codebuddy`, `pi-acp`, `omp`, `npx` — `findExecutable` finds them through
 * PATHEXT), and Node ≥ 20.12 refuses to spawn a `.cmd`/`.bat` with `shell:false`
 * (the BatBadBut fix): it throws `EINVAL` before the process exists. The shim is
 * therefore handed to `cmd.exe`, which is what CreateProcess used to do for us.
 *
 * The two non-obvious details, both measured on Windows:
 *  - `windowsVerbatimArguments` — otherwise libuv re-quotes our argument with
 *    MSVCRT rules, turning the embedded quotes into `\"`, which cmd.exe does not
 *    treat as an escape; the whole line then fails as "not recognized".
 *  - the outer quote pair — `/s` strips the first and last quote of the `/c`
 *    string, so the line must be wrapped for the quoted program path to survive.
 *
 * `cmd` expands `%VAR%` even inside quotes; that is the one thing this cannot
 * neutralize (a literal `%` in a shim path or argument is not a real case).
 */
export function windowsShimLaunch(
  command: string,
  args: readonly string[],
  platform: NodeJS.Platform = process.platform,
  comspec: string = process.env.ComSpec ?? process.env.COMSPEC ?? 'cmd.exe',
): ShimLaunch {
  if (platform !== 'win32' || !WINDOWS_SHIM_PATTERN.test(command)) {
    return { command, args: [...args], verbatim: false }
  }
  const line = [command, ...args].map(quoteForCmd).join(' ')
  return { command: comspec, args: ['/d', '/s', '/c', `"${line}"`], verbatim: true }
}

/**
 * Kill a Windows process tree — the counterpart of the POSIX process-GROUP kill
 * the bridge does elsewhere (see `AgentBridge.killChild`).
 *
 * It must run while the tree is intact: a `.cmd` shim is launched through
 * `cmd.exe`, so killing the direct child first re-parents the agent and
 * `taskkill /T` can no longer reach it (measured: the agent survived `stop()`).
 * Best effort — `taskkill` is absent from no Windows this runs on, and a
 * failure here only means the OS reclaims the process later.
 */
export function killProcessTree(pid: number): ChildProcess | undefined {
  try {
    const killer = spawn('taskkill', ['/pid', String(pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true })
    killer.on('error', () => { /* nothing else to try; the OS reaps it eventually */ })
    // Handed back so a caller that wants to wait can; the existing
    // fire-and-forget callers simply ignore it.
    return killer
  } catch {
    return undefined
  }
}

/** Every agent child this host started and has not seen exit yet, by pid. */
const liveChildPids = new Set<number>()
/** Whether the process-exit reaper is already installed (installed once). */
let exitReaperArmed = false

/** Remember a freshly spawned agent child for the last-resort reaper. */
export function trackAgentChild(child: ChildProcess): void {
  const pid = child.pid
  if (pid === undefined) return
  liveChildPids.add(pid)
  // Both events: `exit` is the process fact, `close` is it plus its stdio being
  // closed. Whichever comes first forgets the pid.
  const forget = (): void => { liveChildPids.delete(pid) }
  child.once('exit', forget)
  child.once('close', forget)
  if (exitReaperArmed) return
  exitReaperArmed = true
  process.once('exit', reapLiveChildren)
}

/**
 * Last resort for a host that leaves without a graceful teardown: an unhandled
 * crash that still runs `exit`, an explicit `process.exit()`, or a disposer the
 * host never awaited. Only SYNC calls are legal here — the `exit` event cannot
 * wait for a promise — hence `spawnSync` and a bare `process.kill`.
 *
 * Deliberately NOT a `SIGINT` / `SIGTERM` handler: registering one flips the
 * host's own default disposition (killing the default "exit on Ctrl-C", or
 * double-handling the host's shutdown and hanging it). A host that handles the
 * signal itself still reaches `exit`; one that is SIGKILLed can run nothing at
 * all (see AGENTS/protocol.md §7 for that limit).
 */
function reapLiveChildren(): void {
  for (const pid of liveChildPids) {
    try {
      if (process.platform === 'win32') {
        spawnSync('taskkill', ['/pid', String(pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true })
      } else {
        // The child was spawned `detached`, so it leads its own process group:
        // -pid reaches everything it started (same reasoning as the graceful
        // POSIX kill).
        process.kill(-pid, 'SIGKILL')
      }
    } catch { /* already gone, or no permission left to try */ }
  }
  liveChildPids.clear()
}

/**
 * The second — and last — slice after the escalation kill (`SIGKILL` on POSIX,
 * a second `taskkill /T /F` on Windows). Deliberately short: past this point
 * the child is the OS's problem (plus the exit reaper, see `reapLiveChildren`).
 *
 * `disposeChild` RESERVES this inside the budget it is handed, so every caller's
 * number means the WHOLE disposal — graceful wait plus escalation wait — and
 * never just the first one.
 */
const KILL_ESCALATION_GRACE_MS = 500

/**
 * End the child's stdin, dispatch the platform kill, and wait until the process
 * is gone — bounded, and never rejecting.
 *
 * The escalation is deliberately platform-shaped: POSIX gets a process-GROUP
 * `SIGKILL` (an agent that ignores SIGTERM is exactly what a second signal is
 * for), Windows a second `taskkill /T /F` (the first may never have run at all:
 * a failed spawn of `taskkill` is swallowed by `killProcessTree`).
 */
export async function disposeChild(child: ChildProcess, budgetMs: number): Promise<void> {
  // ONE deadline for the whole disposal: the escalation wait comes out of the
  // same budget, so `budgetMs` can never turn into "grace period + grace
  // period" (see `KILL_ESCALATION_GRACE_MS`).
  const deadline = Date.now() + Math.max(0, budgetMs)
  try {
    child.stdin?.end()
  } catch { /* already gone */ }
  const pid = child.pid
  if (pid === undefined) return
  // A child that already exited may have had its pid reused: signalling it
  // would reach an unrelated process (group). Nothing left to kill.
  if (child.exitCode !== null || child.signalCode !== null) return
  const windows = process.platform === 'win32'
  if (windows) {
    // Parity with the POSIX branch, which kills the whole process GROUP: on
    // Windows "the group" is the process tree, and it has to be killed while
    // the tree is intact — killing the direct child first (a `cmd.exe` shim
    // wrapper, see `windowsShimLaunch`) re-parents the agent out of
    // `taskkill /T`'s reach. `stdin.end()` above is the graceful half.
    killProcessTree(pid)
  } else {
    try {
      process.kill(-pid, 'SIGTERM')
    } catch {
      child.kill('SIGTERM')
    }
  }
  // Everything except the escalation slice: the second wait is only there to
  // confirm a SIGKILL / taskkill landed, and it must fit inside the same budget.
  if (await waitForChildExit(child, Math.max(0, budgetMs - KILL_ESCALATION_GRACE_MS))) return
  if (windows) {
    killProcessTree(pid)
  } else {
    try {
      process.kill(-pid, 'SIGKILL')
    } catch { /* already gone */ }
  }
  // Whatever is left of the deadline, never a fresh grace period.
  await waitForChildExit(child, Math.max(0, deadline - Date.now()))
}

/** Resolve true once the child is gone, false when the budget runs out first. */
export function waitForChildExit(child: ChildProcess, budgetMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true)
  return new Promise<boolean>((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const settle = (gone: boolean): void => {
      if (timer !== undefined) clearTimeout(timer)
      child.off('exit', onGone)
      child.off('close', onGone)
      resolve(gone)
    }
    const onGone = (): void => { settle(true) }
    timer = setTimeout(() => { settle(false) }, budgetMs)
    // The host may exit while this waits; an armed timer must not hold it open.
    timer.unref?.()
    child.once('exit', onGone)
    child.once('close', onGone)
  })
}

/**
 * Globally install an agent's npm package. The package name reaches the
 * installer as a spawn argv item; on Windows the installer needs a shell,
 * which is exactly why `validateAgentDef` restricts `npmPackage` to a
 * charset with no shell metacharacters.
 */
export function npmInstallGlobal(pkg: string, onLog: (line: string) => void = () => {}): Promise<void> {
  return new Promise((resolveInstall, rejectInstall) => {
    let settled = false
    onLog(`[dsh-ntr] "${pkg}" not found on PATH — running: npm install -g ${pkg}`)
    const child = spawn('npm', ['install', '-g', '--no-fund', '--no-audit', pkg], {
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
    })
    const output: string[] = []
    const collect = (chunk: unknown) => {
      for (const line of String(chunk).split('\n')) {
        if (line.trim() === '') continue
        output.push(line)
        if (output.length > 40) output.splice(0, output.length - 40)
      }
    }
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', collect)
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', collect)
    const timer = setTimeout(() => {
      child.kill()
      settle(new AcpError('agent_unreachable', `acp: npm install -g ${pkg} timed out after ${NPM_INSTALL_TIMEOUT_MS}ms; output: ${output.slice(-5).join(' | ')}`))
    }, NPM_INSTALL_TIMEOUT_MS)
    timer.unref?.()
    child.on('error', error => {
      settle(new AcpError('agent_unreachable', `acp: npm install -g ${pkg} failed to run: ${error.message}`))
    })
    child.on('exit', (code, signal) => {
      if (code === 0) {
        onLog(`[dsh-ntr] npm install -g ${pkg} finished`)
        settle(undefined)
        return
      }
      for (const line of output.slice(-5)) onLog(line)
      settle(new AcpError('agent_unreachable', `acp: npm install -g ${pkg} exited code=${String(code)} signal=${String(signal)}; output: ${output.slice(-5).join(' | ')}`))
    })

    function settle(error: AcpError | undefined): void {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error === undefined) resolveInstall()
      else rejectInstall(error)
    }
  })
}

export interface ExecutableResolution {
  command: string
  /** True when the npm auto-install ran during this resolution. */
  installed: boolean
}

/**
 * Resolve the spawn command for an agent def: PATH lookup first, then — when
 * the command is missing and the def carries `npmPackage` — a global install
 * and a second lookup. When nothing resolves the original command comes back
 * untouched so the spawn itself fails with the familiar ENOENT.
 */
export async function ensureAgentExecutable(
  def: Pick<AcpAgentDef, 'command' | 'npmPackage'>,
  install: (pkg: string, onLog: (line: string) => void) => Promise<void> = (pkg, onLog) => npmInstallGlobal(pkg, onLog),
  onLog: (line: string) => void = () => {},
  /**
   * Called when the auto-install is about to run — the only point that proves
   * an install was TRIED. A configured `npmPackage` alone does not (see
   * `StartAttempt.installTried`), and a throw below would otherwise leave no
   * trace of the attempt.
   */
  onInstallStart: () => void = () => {},
): Promise<ExecutableResolution> {
  const found = findExecutable(def.command)
  if (found !== undefined) return { command: found, installed: false }
  if (def.npmPackage === undefined || def.npmPackage === '') return { command: def.command, installed: false }
  onInstallStart()
  await install(def.npmPackage, onLog)
  const retry = findExecutable(def.command)
  if (retry === undefined) {
    onLog(`[dsh-ntr] ${def.npmPackage} installed but "${def.command}" is still not resolvable on PATH`)
  }
  return { command: retry ?? def.command, installed: true }
}

export function detectHostAgents(configuredDefs: readonly AcpAgentDef[]): DetectedAgentInfo[] {
  const presetEntries = AGENT_PRESETS.map(preset => {
    let detectedPath: string | undefined
    for (const exe of preset.executables) {
      const found = findExecutable(exe)
      if (found !== undefined) {
        detectedPath = found
        break
      }
    }
    const current = configuredDefs.find(d => d.id === preset.id)
    return {
      id: preset.id,
      name: preset.name,
      description: preset.description,
      detected: detectedPath !== undefined,
      executablePath: detectedPath,
      defaultCommand: preset.defaultCommand,
      defaultArgs: [...preset.defaultArgs],
      currentConfig: current,
    }
  })
  // Configured agents outside the preset table (custom ids created in the
  // panel) surface as their own detect entries so the browser can edit their
  // full connection form — env / npmPackage / title exist only on
  // `currentConfig`, which the synthesized client-side fallback lacks.
  const presetIds = new Set(presetEntries.map(entry => entry.id))
  const customEntries = configuredDefs
    .filter(def => !presetIds.has(def.id))
    .map(def => {
      const executablePath = findExecutable(def.command)
      return {
        id: def.id,
        name: def.title ?? def.id,
        description: `Custom ACP agent (command: ${def.command})`,
        detected: executablePath !== undefined,
        executablePath,
        defaultCommand: def.command,
        defaultArgs: [...(def.args ?? [])],
        currentConfig: def,
      }
    })
  return [...presetEntries, ...customEntries]
}

/**
 * Rescue a def persisted before `command` became a command LINE (AGENTS.md
 * constraint 26): `command` used to be the whole program string, and an
 * absolute Windows path may legitimately contain spaces
 * (`C:\Program Files\nodejs\node.exe`). Re-validating would now split that on
 * the first space and silently point the agent at `C:\Program`, so the row is
 * quoted first — but ONLY when the untouched string really is a file on disk,
 * which is the one case where the split would be wrong.
 */
export function quoteLegacyCommand(item: unknown): unknown {
  if (typeof item !== 'object' || item === null) return item
  const row = item as Record<string, unknown>
  const command = row.command
  if (typeof command !== 'string') return item
  const trimmed = command.trim()
  if (!/\s/.test(trimmed) || !existsSync(trimmed)) return item
  return { ...row, command: quoteCommandToken(trimmed) }
}
