/**
 * Config validation: `validateConfig` and `validateAgentDef`. Every value the plugin persists is rebuilt here, so the cases pin the accept / reject line for each field (constraints 7 and 32).
 *
 * Part of the `tests/impl.spec.ts` mirror: one file per `src/impl/` cluster,
 * same describe titles and case counts as before the split.
 */

import { describe, expect, it } from 'vitest'
import {
  AcpError,
  validateAgentDef,
  validateApprovalDeadlines,
  validateConfig,
  validateDelegateConfig,
  validateDelegateGuidance,
  validateDelegateMs,
  validateDelegateSettings,
} from '../../src/impl.ts'
import { DELEGATE_GUIDANCE } from '../../src/protocol.ts'

describe('validateConfig', () => {
  it('applies defaults', () => {
    const config = validateConfig({ agents: [{ id: 'a', command: 'run-a' }] })
    expect(config.agents[0]).toMatchObject({ id: 'a', title: 'a', args: [], env: {}, allowedCwdRoots: [] })
    expect(config.transcriptMaxEntries).toBe(600)
  })
  it('derives allowedCwdRoots from cwd', () => {
    const config = validateConfig({ agents: [{ id: 'a', command: 'run-a', cwd: '/work/x' }] })
    expect(config.agents[0].allowedCwdRoots).toEqual(['/work/x'])
  })
  it('rejects bad ids, duplicates, relative cwd, secret-shaped env values are allowed but must be strings', () => {
    expect(() => validateConfig({ agents: [{ id: 'A B', command: 'x' }] })).toThrow(AcpError)
    expect(() => validateConfig({ agents: [{ id: 'a', command: 'x' }, { id: 'a', command: 'y' }] })).toThrow(/duplicate/)
    expect(() => validateConfig({ agents: [{ id: 'a', command: 'x', cwd: 'rel/path' }] })).toThrow(/absolute/)
    expect(() => validateConfig({ agents: [{ id: 'a', command: 'x', env: { K: 3 } }] })).toThrow(/env/)
    expect(() => validateConfig({ agents: 'nope' })).toThrow(/array/)
    expect(() => validateConfig({ agents: [], transcriptMaxEntries: 1 })).toThrow(/transcriptMaxEntries/)
  })
  it('defaults probeModelsOnBoot to true and rejects non-boolean values', () => {
    expect(validateConfig({ agents: [] }).probeModelsOnBoot).toBe(true)
    expect(validateConfig({ agents: [], probeModelsOnBoot: false }).probeModelsOnBoot).toBe(false)
    expect(() => validateConfig({ agents: [], probeModelsOnBoot: 'yes' })).toThrow(/probeModelsOnBoot/)
  })
  it('defaults and bounds the reliability timeouts', () => {
    const config = validateConfig({ agents: [] })
    expect(config.startupTimeoutMs).toBe(60_000)
    expect(config.permissionTimeoutMs).toBe(300_000)
    expect(config.cancelFallbackMs).toBe(15_000)
    expect(config.staleCancelRetryDelayMs).toBe(600)
    expect(config.staleCancelMaxRetries).toBe(2)
    expect(() => validateConfig({ agents: [], startupTimeoutMs: 500 })).toThrow(/startupTimeoutMs/)
    expect(() => validateConfig({ agents: [], permissionTimeoutMs: -1 })).toThrow(/permissionTimeoutMs/)
    expect(() => validateConfig({ agents: [], cancelFallbackMs: 601_000 })).toThrow(/cancelFallbackMs/)
    expect(() => validateConfig({ agents: [], staleCancelRetryDelayMs: 60_001 })).toThrow(/staleCancelRetryDelayMs/)
    expect(() => validateConfig({ agents: [], staleCancelMaxRetries: 6 })).toThrow(/staleCancelMaxRetries/)
    expect(validateConfig({ agents: [], permissionTimeoutMs: 60_000, cancelFallbackMs: 0 }).cancelFallbackMs).toBe(0)
    expect(validateConfig({ agents: [], staleCancelRetryDelayMs: 0, staleCancelMaxRetries: 0 }).staleCancelMaxRetries).toBe(0)
  })
  it('defaults and bounds the inactivity watchdog windows', () => {
    // Two silence windows (no tool in flight / tool in flight) plus the scan
    // interval. All three are diagnostic knobs, not UI controls: `0` means
    // "off" or "fall back", never "expire immediately".
    const config = validateConfig({ agents: [] })
    expect(config.turnStallMs).toBe(600_000)
    expect(config.turnStallToolMs).toBe(1_800_000)
    expect(config.turnStallTickMs).toBe(30_000)

    expect(validateConfig({ agents: [], turnStallMs: 0, turnStallToolMs: 0, turnStallTickMs: 1 }))
      .toMatchObject({ turnStallMs: 0, turnStallToolMs: 0, turnStallTickMs: 1 })

    // Out of range / non-integers are refused loudly at boot.
    expect(() => validateConfig({ agents: [], turnStallMs: -1 })).toThrow(/turnStallMs/)
    expect(() => validateConfig({ agents: [], turnStallMs: 1.5 })).toThrow(/turnStallMs/)
    expect(() => validateConfig({ agents: [], turnStallMs: 86_400_001 })).toThrow(/turnStallMs/)
    expect(() => validateConfig({ agents: [], turnStallToolMs: -1 })).toThrow(/turnStallToolMs/)
    expect(() => validateConfig({ agents: [], turnStallToolMs: 1.5 })).toThrow(/turnStallToolMs/)
    expect(() => validateConfig({ agents: [], turnStallToolMs: 86_400_001 })).toThrow(/turnStallToolMs/)
    expect(() => validateConfig({ agents: [], turnStallTickMs: 0 })).toThrow(/turnStallTickMs/)
    expect(() => validateConfig({ agents: [], turnStallTickMs: 1.5 })).toThrow(/turnStallTickMs/)
    expect(() => validateConfig({ agents: [], turnStallTickMs: 60_001 })).toThrow(/turnStallTickMs/)
  })
  it('exposes ONE approval window and the expiry mode as config knobs', () => {
    // ONE window for both places an ask can wait (the conversation's approval
    // card and the settings panel's ledger): they ask the same question, so
    // they get the same answer. Two windows only made the settings card look
    // like two unrelated knobs.
    const config = validateConfig({ agents: [] })
    expect(config.permissionTimeoutMs).toBe(300_000)

    // 0 = 一直等: no deadline at all.
    expect(validateConfig({ agents: [], permissionTimeoutMs: 0 }).permissionTimeoutMs).toBe(0)
    expect(validateConfig({ agents: [], permissionTimeoutMs: 1_800_000 }).permissionTimeoutMs).toBe(1_800_000)

    expect(() => validateConfig({ agents: [], permissionTimeoutMs: -1 })).toThrow(/permissionTimeoutMs/)
    expect(() => validateConfig({ agents: [], permissionTimeoutMs: 1.5 })).toThrow(/permissionTimeoutMs/)
    expect(() => validateConfig({ agents: [], permissionTimeoutMs: 86_400_001 })).toThrow(/permissionTimeoutMs/)
  })
  it('folds the two legacy windows into the single one', () => {
    // An existing `cordis.patch.yml` named `nativeApprovalTimeoutMs` /
    // `permissionFallbackTimeoutMs`. They are folded in rather than dropped, so
    // an old file keeps meaning what it meant instead of silently reverting to
    // the default.
    expect(validateConfig({ agents: [], nativeApprovalTimeoutMs: 60_000 }).permissionTimeoutMs).toBe(60_000)
    expect(validateConfig({ agents: [], permissionFallbackTimeoutMs: 120_000 }).permissionTimeoutMs).toBe(120_000)
    // The new key wins when both are present.
    expect(validateConfig({
      agents: [],
      permissionTimeoutMs: 30_000,
      nativeApprovalTimeoutMs: 60_000,
    }).permissionTimeoutMs).toBe(30_000)
    // The legacy keys are resolved away, not carried into the running config.
    const resolved = validateConfig({ agents: [], nativeApprovalTimeoutMs: 60_000 })
    expect('nativeApprovalTimeoutMs' in resolved).toBe(false)
    expect('permissionFallbackTimeoutMs' in resolved).toBe(false)
  })
  it('carries a legacy zero over as the wait mode, never as 不等待', () => {
    // A legacy window of 0 meant "this window never fires". Today 0 means
    // 不等待 (settle on arrival), so a legacy zero would silently turn "wait
    // forever" into "answer immediately" — the one way this migration could
    // hurt an unattended deployment. The only way to say "never expires" now
    // is the `wait` mode, so that is what it carries over as.
    const legacy = validateConfig({ agents: [], nativeApprovalTimeoutMs: 0 })
    expect(legacy.permissionTimeoutMode).toBe('wait')
    expect(legacy.permissionTimeoutMs).toBe(300_000)
    // The same holds for the other legacy key, and for an explicit mode: the
    // old meaning of a zero window was "never", whatever the mode said.
    expect(validateConfig({ agents: [], permissionFallbackTimeoutMs: 0 }).permissionTimeoutMode).toBe('wait')
    expect(validateConfig({
      agents: [],
      nativeApprovalTimeoutMs: 0,
      permissionTimeoutMode: 'auto',
    }).permissionTimeoutMode).toBe('wait')
    // The NEW key's zero is the new meaning, and it is not second-guessed.
    expect(validateConfig({ agents: [], permissionTimeoutMs: 0 })).toMatchObject({
      permissionTimeoutMs: 0,
      permissionTimeoutMode: 'wait',
    })
  })

  it('keeps 不等待 to the auto mode: under 超时中止 it floors to a real wait', () => {
    // 不等待 means "settle the ask the moment it arrives". Under 自动推进 that
    // is harmless — the ask is ANSWERED, so the agent continues. Under 超时中止
    // it would be refused on arrival, and the agent would stop at every gate
    // it meets: not a timeout, a wall. So the mode does not offer that rung,
    // and a zero reaching it floors to the shortest real wait.
    expect(validateConfig({ agents: [], permissionTimeoutMs: 0, permissionTimeoutMode: 'auto' })).toMatchObject({
      permissionTimeoutMs: 0,
      permissionTimeoutMode: 'auto',
    })
    expect(validateConfig({ agents: [], permissionTimeoutMs: 0, permissionTimeoutMode: 'abort' })).toMatchObject({
      permissionTimeoutMs: 30_000,
      permissionTimeoutMode: 'abort',
    })
    // A real window is untouched in every mode.
    expect(validateConfig({ agents: [], permissionTimeoutMs: 60_000, permissionTimeoutMode: 'abort' }).permissionTimeoutMs).toBe(60_000)
  })

  it('defaults the expiry mode to wait, and takes only the three modes', () => {
    // `wait` is the default on purpose: a permission ask is a question FOR A
    // HUMAN, so the safe default is to keep waiting rather than to refuse (or
    // worse, approve) on their behalf. `abort` / `auto` are opt-in.
    expect(validateConfig({ agents: [] }).permissionTimeoutMode).toBe('wait')
    expect(validateConfig({ agents: [], permissionTimeoutMode: 'abort' }).permissionTimeoutMode).toBe('abort')
    expect(validateConfig({ agents: [], permissionTimeoutMode: 'auto' }).permissionTimeoutMode).toBe('auto')
    expect(validateConfig({ agents: [], permissionTimeoutMode: 'wait' }).permissionTimeoutMode).toBe('wait')
    // Anything outside the three is a typo, not a new mode.
    expect(() => validateConfig({ agents: [], permissionTimeoutMode: 'maybe' })).toThrow(/permissionTimeoutMode/)
    expect(() => validateConfig({ agents: [], permissionTimeoutMode: true })).toThrow(/permissionTimeoutMode/)
  })

  it('gates the settings-page deadline write through the same range as the config file', () => {
    // The card and `cordis.patch.yml` are two doors onto the same knob, so they
    // must share one gate: a window the UI can save has to survive the next
    // boot's re-validation, or the setting would silently revert.
    expect(validateApprovalDeadlines({ permissionTimeoutMs: 60_000 })).toEqual({ permissionTimeoutMs: 60_000 })
    expect(validateApprovalDeadlines({})).toEqual({})
    expect(validateApprovalDeadlines({ permissionTimeoutMs: 0 })).toEqual({ permissionTimeoutMs: 0 })
    // `reset` is not a deadline and must not land in the persisted override.
    expect(validateApprovalDeadlines({ reset: true })).toEqual({})
    // The legacy keys are gone from the write path: an old browser half must
    // not be able to smuggle a second window back in.
    expect(validateApprovalDeadlines({ nativeApprovalTimeoutMs: 60_000 })).toEqual({})
    for (const bad of [-1, 1.5, 86_400_001, '60000', null]) {
      expect(() => validateApprovalDeadlines({ permissionTimeoutMs: bad })).toThrow(/permissionTimeoutMs/)
    }
    expect(() => validateApprovalDeadlines(null)).toThrow(/approval deadlines must be an object/)
  })
  it('keeps idleTimeoutMs optional per agent and bounds it when present', () => {
    // Absent means "host default": a config stored before this field existed
    // must keep validating, or `loadPersistedAgents` would drop the agent.
    const bare = validateConfig({ agents: [{ id: 'a', command: 'x' }] })
    expect(bare.agents[0]?.idleTimeoutMs).toBeUndefined()
    expect(validateConfig({ agents: [{ id: 'a', command: 'x', idleTimeoutMs: 0 }] }).agents[0]?.idleTimeoutMs).toBe(0)
    expect(validateConfig({ agents: [{ id: 'a', command: 'x', idleTimeoutMs: 600_000 }] }).agents[0]?.idleTimeoutMs).toBe(600_000)
    // A sub-second window would thrash spawn/release; 0 is the documented "off".
    expect(() => validateConfig({ agents: [{ id: 'a', command: 'x', idleTimeoutMs: 999 }] })).toThrow(/idleTimeoutMs/)
    expect(() => validateConfig({ agents: [{ id: 'a', command: 'x', idleTimeoutMs: -1 }] })).toThrow(/idleTimeoutMs/)
    expect(() => validateConfig({ agents: [{ id: 'a', command: 'x', idleTimeoutMs: 1.5 }] })).toThrow(/idleTimeoutMs/)
    expect(() => validateConfig({ agents: [{ id: 'a', command: 'x', idleTimeoutMs: 86_400_001 }] })).toThrow(/idleTimeoutMs/)
  })
})

describe('validateAgentDef', () => {
  it('validates a valid agent definition and applies defaults', () => {
    const def = validateAgentDef({ id: 'pi', command: 'pi-acp' })
    expect(def).toEqual({
      id: 'pi',
      title: 'pi',
      command: 'pi-acp',
      args: [],
      env: {},
      cwd: undefined,
      allowedCwdRoots: [],
    })
    expect('exposedModels' in def).toBe(false)
  })

  it('normalizes exposedModels (dedupe) and rejects malformed filters', () => {
    expect(validateAgentDef({ id: 'pi', command: 'x', exposedModels: ['b', 'a', 'b'] }).exposedModels).toEqual(['b', 'a'])
    expect(validateAgentDef({ id: 'pi', command: 'x', exposedModels: [] }).exposedModels).toEqual([])
    expect(() => validateAgentDef({ id: 'pi', command: 'x', exposedModels: 'model-a' })).toThrow(/exposedModels/)
    expect(() => validateAgentDef({ id: 'pi', command: 'x', exposedModels: ['a', ''] })).toThrow(/exposedModels/)
    expect(() => validateAgentDef({ id: 'pi', command: 'x', exposedModels: [42] })).toThrow(/exposedModels/)
  })

  // The cap used to be 256 entries, which is below what real agents publish
  // (pi: 500 choices, omp: 581) — the panel's "only my selected models" switch
  // sends every choice at once and got `bad_payload` for a legitimate filter.
  it('accepts an exposedModels filter as large as a real catalog, and bounds it by size', () => {
    const catalog = Array.from({ length: 600 }, (_, i) => `provider/model-${String(i)}`)
    expect(validateAgentDef({ id: 'pi', command: 'x', exposedModels: catalog }).exposedModels).toEqual(catalog)
    // Config reload re-validates the stored filter: exceeding the bound would
    // silently drop the whole agent definition, so the guard is on total size.
    expect(() => validateAgentDef({ id: 'pi', command: 'x', exposedModels: Array.from({ length: 3000 }, (_, i) => `${'x'.repeat(400)}-${String(i)}`) })).toThrow(/too large/)
    expect(() => validateAgentDef({ id: 'pi', command: 'x', exposedModels: ['y'.repeat(513)] })).toThrow(/exposedModels/)
  })

  it('treats autoDiscoverModels as on by default; only the explicit opt-out is persisted', () => {
    // Default-on: `true` and absent are the same state, so neither is stored.
    expect('autoDiscoverModels' in validateAgentDef({ id: 'pi', command: 'x', autoDiscoverModels: true })).toBe(false)
    expect('autoDiscoverModels' in validateAgentDef({ id: 'pi', command: 'x' })).toBe(false)
    expect(validateAgentDef({ id: 'pi', command: 'x', autoDiscoverModels: false }).autoDiscoverModels).toBe(false)
    expect(() => validateAgentDef({ id: 'pi', command: 'x', autoDiscoverModels: 'yes' })).toThrow(/autoDiscoverModels/)
  })

  it('accepts a trimmed defaultMode and stores no empty entry', () => {
    expect(validateAgentDef({ id: 'pi', command: 'x', defaultMode: ' strict ' }).defaultMode).toBe('strict')
    expect('defaultMode' in validateAgentDef({ id: 'pi', command: 'x' })).toBe(false)
    expect('defaultMode' in validateAgentDef({ id: 'pi', command: 'x', defaultMode: '   ' })).toBe(false)
    expect(() => validateAgentDef({ id: 'pi', command: 'x', defaultMode: 7 })).toThrow(/defaultMode/)
    expect(() => validateAgentDef({ id: 'pi', command: 'x', defaultMode: 'x'.repeat(129) })).toThrow(/defaultMode/)
  })

  it('accepts, trims, and drops npmPackage; rejects invalid package names', () => {
    expect(validateAgentDef({ id: 'pi', command: 'x', npmPackage: ' @mariozechner/pi-acp ' }).npmPackage).toBe('@mariozechner/pi-acp')
    expect(validateAgentDef({ id: 'pi', command: 'x', npmPackage: 'omp@latest' }).npmPackage).toBe('omp@latest')
    expect('npmPackage' in validateAgentDef({ id: 'pi', command: 'x', npmPackage: '  ' })).toBe(false)
    expect('npmPackage' in validateAgentDef({ id: 'pi', command: 'x' })).toBe(false)
    // Shell metacharacters must never reach the installer spawn argv.
    expect(() => validateAgentDef({ id: 'pi', command: 'x', npmPackage: 'pkg; rm -rf /' })).toThrow(/npmPackage/)
    expect(() => validateAgentDef({ id: 'pi', command: 'x', npmPackage: 'pkg$(whoami)' })).toThrow(/npmPackage/)
    expect(() => validateAgentDef({ id: 'pi', command: 'x', npmPackage: 'pkg && other' })).toThrow(/npmPackage/)
    expect(() => validateAgentDef({ id: 'pi', command: 'x', npmPackage: 42 })).toThrow(/npmPackage/)
  })

  it('rejects empty command and invalid id', () => {
    expect(() => validateAgentDef({ id: 'pi', command: '' })).toThrow(AcpError)
    expect(() => validateAgentDef({ id: 'PI AGENT', command: 'pi-acp' })).toThrow(AcpError)
  })

  // The MCP server list. The plugin stores it in its OWN normalized shape
  // (every entry carries an explicit `transport`), because the ACP wire shape
  // is asymmetric: its stdio variant carries NO `type` field, so a config
  // written in the wire shape by hand is accepted by the agent and then
  // silently dropped (measured: the server never connects). The wire
  // conversion lives in bridge.ts; these cases cover the shape the HOST
  // accepts and persists.
  it('accepts MCP servers in the normalized shape and keeps them verbatim', () => {
    const servers = [
      { name: 'local', transport: 'stdio', command: '/opt/servers/local', args: ['--mcp'], env: { TOKEN: 'x' } },
      { name: 'remote', transport: 'http', url: 'https://example.test/mcp', headers: { Authorization: 'Bearer t' } },
      { name: 'events', transport: 'sse', url: 'https://example.test/sse' },
    ]
    const def = validateAgentDef({ id: 'pi', command: 'x', mcpServers: servers })
    // Verbatim: the host validates, it does not reshape. A host that filled in
    // defaults would make the settings panel report a change where there is
    // none.
    expect(def.mcpServers).toEqual(servers)
    // And it survives the REBUILD: a field not listed in validateAgentDef's
    // return is silently stripped, which would delete the whole feature.
    expect('mcpServers' in def).toBe(true)
  })

  it('treats an absent MCP list as "none" rather than storing an empty one', () => {
    expect('mcpServers' in validateAgentDef({ id: 'pi', command: 'x' })).toBe(false)
    expect(validateAgentDef({ id: 'pi', command: 'x', mcpServers: [] }).mcpServers).toEqual([])
  })

  it('rejects malformed MCP server entries', () => {
    expect(() => validateAgentDef({ id: 'pi', command: 'x', mcpServers: 'nope' })).toThrow(/mcpServers/)
    expect(() => validateAgentDef({ id: 'pi', command: 'x', mcpServers: [{ transport: 'stdio', command: 'x' }] })).toThrow(/name/)
    expect(() => validateAgentDef({ id: 'pi', command: 'x', mcpServers: [{ name: 'a', transport: 'stdio' }] })).toThrow(/command/)
    expect(() => validateAgentDef({ id: 'pi', command: 'x', mcpServers: [{ name: 'a', transport: 'http' }] })).toThrow(/url/)
    expect(() => validateAgentDef({ id: 'pi', command: 'x', mcpServers: [{ name: 'a', transport: 'sse' }] })).toThrow(/url/)
    expect(() => validateAgentDef({ id: 'pi', command: 'x', mcpServers: [{ name: 'a', transport: 'ftp', url: 'x' }] })).toThrow(/transport/)
    expect(() => validateAgentDef({ id: 'pi', command: 'x', mcpServers: [{ name: 'a', transport: 'stdio', command: 'x', args: [1] }] })).toThrow(/args/)
    expect(() => validateAgentDef({ id: 'pi', command: 'x', mcpServers: [{ name: 'a', transport: 'stdio', command: 'x', env: { K: 1 } }] })).toThrow(/env/)
    expect(() => validateAgentDef({ id: 'pi', command: 'x', mcpServers: [{ name: 'a', transport: 'http', url: 'u', headers: { K: 1 } }] })).toThrow(/headers/)
    // Two servers sharing a name would collide inside the agent, where the name
    // namespaces the tools (`mcp__<name>__<tool>`).
    expect(() => validateAgentDef({
      id: 'pi',
      command: 'x',
      mcpServers: [{ name: 'a', transport: 'stdio', command: 'x' }, { name: 'a', transport: 'stdio', command: 'y' }],
    })).toThrow(/more than one/)
  })

  it('refuses the ACP transport variant, which the client side cannot serve', () => {
    // `transport: 'acp'` means the agent calls back into this plugin over
    // `mcp/message` — a method the stable ACP SDK does not expose on the
    // client side. Accepting it would store a server the agent can never
    // reach.
    expect(() => validateAgentDef({ id: 'pi', command: 'x', mcpServers: [{ name: 'a', transport: 'acp', serverId: 's' }] })).toThrow(/not supported/)
  })

  it('bounds the MCP server list', () => {
    const many = Array.from({ length: 40 }, (_, i) => ({ name: `s${String(i)}`, transport: 'stdio', command: 'x' }))
    expect(() => validateAgentDef({ id: 'pi', command: 'x', mcpServers: many })).toThrow(/at most/)
  })
})

describe('delegate config validation', () => {
  /** Assert a validator rejects with the given AcpError code (the config door vs the payload door). */
  function expectCode(fn: () => unknown, code: 'bad_config' | 'bad_payload'): void {
    let error: unknown
    try { fn() } catch (caught) { error = caught }
    expect(error).toBeInstanceOf(AcpError)
    expect((error as AcpError).code).toBe(code)
  }

  it('defaults an absent deployment baseline to {}', () => {
    expect(validateDelegateConfig(undefined)).toEqual({})
    expect(validateDelegateConfig(null)).toEqual({})
    expect(validateDelegateConfig({})).toEqual({})
    // The plugin config carries the same empty baseline when the file names nothing.
    expect(validateConfig({ agents: [] }).delegate).toEqual({})
  })

  it('accepts only the four guidance rungs', () => {
    for (const rung of DELEGATE_GUIDANCE) {
      expect(validateDelegateGuidance(rung, 'bad_config')).toBe(rung)
      expect(validateDelegateGuidance(rung, 'bad_payload')).toBe(rung)
    }
    for (const bad of ['ON', 'enabled', '', 1, null, undefined]) {
      expectCode(() => validateDelegateGuidance(bad, 'bad_config'), 'bad_config')
      expectCode(() => validateDelegateGuidance(bad, 'bad_payload'), 'bad_payload')
      expect(() => validateDelegateGuidance(bad, 'bad_payload')).toThrow(/"off", "on", "enhanced", "force"/)
    }
    expect(validateDelegateConfig({ guidance: 'force' })).toEqual({ guidance: 'force' })
    expectCode(() => validateDelegateConfig({ guidance: 'maybe' }), 'bad_config')
    expect(validateConfig({ agents: [], delegate: { guidance: 'enhanced' } }).delegate).toEqual({ guidance: 'enhanced' })
  })

  it('silently drops the retired permission key from a persisted baseline', () => {
    // The retired delegation permission key, spelled dynamically so the ghost
    // symbol does not reappear literally in source (see AGENTS/retired.md).
    const retired = ['permission', 'Mode'].join('')
    // An old file that named the retired key validates clean: the rebuild only
    // recognizes the known keys, so the retired one is dropped, not rejected.
    expect(validateDelegateConfig({ [retired]: 'ask' })).toEqual({})
    expect(validateDelegateConfig({ guidance: 'on', [retired]: 'auto' })).toEqual({ guidance: 'on' })
    expect(validateConfig({ agents: [], delegate: { [retired]: 'ask' } }).delegate).toEqual({})
    // The settings write drops it too (unknown keys never reach the manager).
    expect(validateDelegateSettings({ [retired]: 'ask' })).toEqual({})
  })

  it('holds the deployment window to [1000, 86400000], off-grid included', () => {
    // Off-grid but in range: the deployment value runs as-is.
    expect(validateDelegateConfig({ timeoutMs: 123_456 })).toEqual({ timeoutMs: 123_456 })
    // The range edges are inclusive (1 second … 24 hours).
    expect(validateDelegateConfig({ timeoutMs: 1_000 })).toEqual({ timeoutMs: 1_000 })
    expect(validateDelegateConfig({ timeoutMs: 86_400_000 })).toEqual({ timeoutMs: 86_400_000 })
    // Out of range / non-integers fail loudly at boot.
    for (const bad of [999, 86_400_001, -1, 1.5, '600000', null]) {
      expectCode(() => validateDelegateConfig({ timeoutMs: bad }), 'bad_config')
    }
    expectCode(() => validateDelegateConfig('nope'), 'bad_config')
  })

  it('accepts the same [1000, 86400000] range on the settings-page write', () => {
    // The minute input writes round(minutes*60000); any in-range integer passes,
    // off-grid included (there is no ladder anymore).
    expect(validateDelegateMs(123_456, 'bad_payload')).toBe(123_456)
    expect(validateDelegateMs(1_000, 'bad_payload')).toBe(1_000)
    expect(validateDelegateMs(86_400_000, 'bad_payload')).toBe(86_400_000)
    expect(validateDelegateSettings({ timeoutMs: 5_400_000 })).toEqual({ timeoutMs: 5_400_000 })
    expect(validateDelegateSettings({ timeoutMs: 123_456 })).toEqual({ timeoutMs: 123_456 })
    for (const bad of [999, 86_400_001, 0, -1, 1.5, '600000', null]) {
      expectCode(() => validateDelegateMs(bad, 'bad_payload'), 'bad_payload')
      expectCode(() => validateDelegateSettings({ timeoutMs: bad }), 'bad_payload')
    }
  })

  it('validates reset: the two keys, deduped, never both written and reset', () => {
    expect(validateDelegateSettings({ reset: ['guidance', 'timeoutMs'] })).toEqual({ reset: ['guidance', 'timeoutMs'] })
    expect(validateDelegateSettings({ reset: ['guidance', 'guidance'] })).toEqual({ reset: ['guidance'] })
    expect(validateDelegateSettings({ reset: [] })).toEqual({ reset: [] })
    // A reset alongside a DIFFERENT key's write is legal.
    expect(validateDelegateSettings({ guidance: 'on', reset: ['timeoutMs'] })).toEqual({ guidance: 'on', reset: ['timeoutMs'] })
    for (const bad of [['bogus'], ['guidance', 1], [null], 'guidance', true, {}]) {
      expectCode(() => validateDelegateSettings({ reset: bad }), 'bad_payload')
    }
    // The retired permission key is no longer part of the reset vocabulary.
    expectCode(() => validateDelegateSettings({ reset: [['permission', 'Mode'].join('')] }), 'bad_payload')
    // The same key cannot be both written and reset in one call.
    expectCode(() => validateDelegateSettings({ guidance: 'on', reset: ['guidance'] }), 'bad_payload')
    expectCode(() => validateDelegateSettings({ timeoutMs: 600_000, reset: ['timeoutMs'] }), 'bad_payload')
  })

  it('ignores unknown keys and returns only the keys present', () => {
    expect(validateDelegateConfig({ guidance: 'on', bogus: 1 })).toEqual({ guidance: 'on' })
    expect(validateDelegateSettings({ guidance: 'on', bogusKey: 5 })).toEqual({ guidance: 'on' })
    expect(validateDelegateSettings({})).toEqual({})
    expectCode(() => validateDelegateSettings(null), 'bad_payload')
    expectCode(() => validateDelegateSettings('nope'), 'bad_payload')
    // The config door carries the validated baseline through validateConfig.
    expect(validateConfig({ agents: [], delegate: { guidance: 'on', timeoutMs: 123_456, bogus: true } }).delegate)
      .toEqual({ guidance: 'on', timeoutMs: 123_456 })
    expectCode(() => validateConfig({ agents: [], delegate: { guidance: 'maybe' } }), 'bad_config')
  })

  it('validates defaultAgent as a legal agent id on both doors', () => {
    expect(validateDelegateConfig({ defaultAgent: 'codebuddy' })).toEqual({ defaultAgent: 'codebuddy' })
    expect(validateDelegateSettings({ defaultAgent: 'a1.b-c_d' })).toEqual({ defaultAgent: 'a1.b-c_d' })
    expect(validateConfig({ agents: [], delegate: { defaultAgent: 'pi' } }).delegate).toEqual({ defaultAgent: 'pi' })
    // Empty string, illegal charset, overlong, non-strings: refused loudly.
    for (const bad of ['', 'Bad Id', 'has:colon', '-lead', 'a'.repeat(65), 42, null, true]) {
      expectCode(() => validateDelegateConfig({ defaultAgent: bad }), 'bad_config')
      expectCode(() => validateDelegateSettings({ defaultAgent: bad }), 'bad_payload')
    }
  })

  it('accepts per-agent defaults records keyed by legal agent ids (shape only)', () => {
    const defaults = { pi: { model: 'gpt-5', effort: 'high', mode: 'ask' }, omp: { model: 'ghost-model' } }
    expect(validateDelegateConfig({ agentDefaults: defaults })).toEqual({ agentDefaults: defaults })
    expect(validateDelegateSettings({ agentDefaults: defaults })).toEqual({ agentDefaults: defaults })
    expect(validateDelegateConfig({ agentDefaults: {} })).toEqual({ agentDefaults: {} })
    expect(validateDelegateSettings({ agentDefaults: {} })).toEqual({ agentDefaults: {} })
    // An entry with no keys is a valid all-default override (it shadows the baseline).
    expect(validateDelegateConfig({ agentDefaults: { pi: {} } })).toEqual({ agentDefaults: { pi: {} } })
    expect(validateDelegateSettings({ agentDefaults: { pi: {} } })).toEqual({ agentDefaults: { pi: {} } })
    // Stale values are NOT catalog-checked: persistence keeps them, the runtime marks them.
    expect(validateDelegateConfig({ agentDefaults: { pi: { model: 'no-such-model', effort: 'ultra', mode: 'ghost' } } }).agentDefaults)
      .toEqual({ pi: { model: 'no-such-model', effort: 'ultra', mode: 'ghost' } })
    // The rebuild keeps only the three known keys, like every other door here.
    expect(validateDelegateConfig({ agentDefaults: { pi: { model: 'x', bogus: 1 } } })).toEqual({ agentDefaults: { pi: { model: 'x' } } })
    expect(validateDelegateSettings({ agentDefaults: { pi: { mode: 'ask', bogus: 1 } } })).toEqual({ agentDefaults: { pi: { mode: 'ask' } } })
  })

  it('rejects malformed per-agent defaults records on both doors', () => {
    for (const bad of ['nope', 42, null, []]) {
      expectCode(() => validateDelegateConfig({ agentDefaults: bad }), 'bad_config')
      expectCode(() => validateDelegateSettings({ agentDefaults: bad }), 'bad_payload')
    }
    // Illegal keys are refused, not dropped.
    for (const key of ['Bad Id', 'has:colon', '', '-lead', 'a'.repeat(65)]) {
      expectCode(() => validateDelegateConfig({ agentDefaults: { [key]: {} } }), 'bad_config')
      expectCode(() => validateDelegateSettings({ agentDefaults: { [key]: {} } }), 'bad_payload')
    }
    // Illegal entries: empty strings, non-strings, non-objects.
    for (const entry of [{ model: '' }, { effort: '' }, { mode: '' }, { model: 42 }, { effort: null }, 'x', 42, []]) {
      expectCode(() => validateDelegateConfig({ agentDefaults: { pi: entry } }), 'bad_config')
      expectCode(() => validateDelegateSettings({ agentDefaults: { pi: entry } }), 'bad_payload')
    }
    // null deletion is a settings-write only; the baseline names facts.
    expectCode(() => validateDelegateConfig({ agentDefaults: { pi: null } }), 'bad_config')
  })

  it('accepts null deletion and {} shadow entries on the settings write', () => {
    expect(validateDelegateSettings({ agentDefaults: { pi: null } })).toEqual({ agentDefaults: { pi: null } })
    expect(validateDelegateSettings({ agentDefaults: { pi: {}, omp: null, x: { mode: 'ask' } } }))
      .toEqual({ agentDefaults: { pi: {}, omp: null, x: { mode: 'ask' } } })
  })

  it('extends reset to the new keys, with the same write/reset exclusivity', () => {
    expect(validateDelegateSettings({ reset: ['defaultAgent', 'agentDefaults'] })).toEqual({ reset: ['defaultAgent', 'agentDefaults'] })
    expect(validateDelegateSettings({ reset: ['guidance', 'timeoutMs', 'defaultAgent', 'agentDefaults', 'defaultAgent'] }))
      .toEqual({ reset: ['guidance', 'timeoutMs', 'defaultAgent', 'agentDefaults'] })
    // A reset alongside a DIFFERENT key's write is legal.
    expect(validateDelegateSettings({ defaultAgent: 'pi', reset: ['agentDefaults'] })).toEqual({ defaultAgent: 'pi', reset: ['agentDefaults'] })
    expect(validateDelegateSettings({ agentDefaults: { pi: null }, reset: ['defaultAgent'] })).toEqual({ agentDefaults: { pi: null }, reset: ['defaultAgent'] })
    // The same key cannot be both written and reset in one call.
    expectCode(() => validateDelegateSettings({ defaultAgent: 'pi', reset: ['defaultAgent'] }), 'bad_payload')
    expectCode(() => validateDelegateSettings({ agentDefaults: { pi: {} }, reset: ['agentDefaults'] }), 'bad_payload')
  })
})
