import { describe, expect, it } from 'vitest'
import { AcpDelegateRegistration, type DelegateRegistrationCtx } from '../src/bridge/delegate-registration.ts'
import type { AcpDelegateService } from '../src/bridge/delegate-service.ts'
import type { AcpReleaseHost } from '../src/bridge/release-tool.ts'
import { fakeMask } from './delegate-harness.ts'

interface RegisteredRow {
  definition: {
    name: string
    description: string
    parameters?: Record<string, unknown>
    execute: (args: unknown) => Promise<unknown>
  }
  options?: { when?: (ctx: { agent?: unknown }) => boolean }
}

/** A tools service that records one entry per registration and disposes by identity. */
function fakeTools() {
  const registered: RegisteredRow[] = []
  const tools = {
    get: (name: string) => registered.find(row => row.definition.name === name)?.definition,
    register: (definition: RegisteredRow['definition'], options?: RegisteredRow['options']) => {
      registered.push({ definition, options })
      return () => {
        const index = registered.findIndex(row => row.definition === definition)
        if (index >= 0) registered.splice(index, 1)
      }
    },
  }
  return { registered, tools }
}

const DEFAULT_ROSTER = () => [{ id: 'codebuddy', title: 'CodeBuddy', description: '通用编码' }]

function makeRegistration(opts: {
  guidance: 'on' | 'off'
  roster?: () => readonly { id: string; title: string; description?: string; effort?: string }[]
  /** `null` = wire no release seam (old host entry / fake). */
  release?: AcpReleaseHost | null
}) {
  const { registered, tools } = fakeTools()
  const ctx: DelegateRegistrationCtx = {
    get: name => (name === 'tools' ? tools : undefined),
    inject: () => undefined,
  }
  const releaseCalls: Array<string | undefined> = []
  const releaseHost: AcpReleaseHost = opts.release === null
    ? { agents: () => [], release: async () => ({ released: [], skipped: [] }) }
    : opts.release ?? {
      agents: () => [{ id: 'codebuddy', title: 'CodeBuddy' }, { id: 'qoder', title: 'Qoder' }],
      release: async (agentId) => {
        releaseCalls.push(agentId)
        if (agentId === 'qoder') return { released: [], skipped: [{ agentId: 'qoder', reason: 'busy' }] }
        if (agentId === 'codebuddy') return { released: [{ agentId: 'codebuddy', sessions: 1 }], skipped: [] }
        // Omitted agent = every agent: one released, one skipped.
        return { released: [{ agentId: 'codebuddy', sessions: 1 }], skipped: [{ agentId: 'qoder', reason: 'busy' }] }
      },
    }
  const registration = new AcpDelegateRegistration({
    ctx,
    service: { execute: async () => ({ text: '', agent: '' }) } as unknown as AcpDelegateService,
    config: () => ({ guidance: opts.guidance, timeoutMs: 60_000 }),
    forceMask: fakeMask(),
    roster: opts.roster ?? DEFAULT_ROSTER,
    ...(opts.release === null ? {} : { release: releaseHost }),
  })
  return { registration, registered, releaseCalls }
}

describe('acp_release registration', () => {
  it('registers BOTH tools on a capable host, with the same NTR exclusion', () => {
    const { registration, registered } = makeRegistration({ guidance: 'on' })
    registration.sync()
    expect(registered.map(row => row.definition.name)).toEqual(['acp_delegate', 'acp_release'])
    expect(registered.every(row => typeof row.options?.when === 'function')).toBe(true)
    // The release tool's safety promises are schema-level copy the model reads
    // BEFORE calling: they are pinned as sentences, not as "mentions release".
    const release = registered.find(row => row.definition.name === 'acp_release')?.definition
    expect(release?.description).toContain('No running turn is ever ended')
    expect(release?.description).toContain('resume automatically on their next message')
  })

  it('removes both tools when the guidance switch goes off', () => {
    const { registration, registered } = makeRegistration({ guidance: 'off' })
    registration.sync()
    expect(registered).toHaveLength(0)
  })

  it('keeps the legacy single-tool registration when no release seam is wired', () => {
    const { registration, registered } = makeRegistration({ guidance: 'on', release: null })
    registration.sync()
    expect(registered.map(row => row.definition.name)).toEqual(['acp_delegate'])
  })

  it('describes each configured agent in the delegate agent parameter (description + defaults)', () => {
    const { registration, registered } = makeRegistration({
      guidance: 'on',
      roster: () => [
        { id: 'codebuddy', title: 'CodeBuddy', description: '通用编码，支持子智能体' },
        { id: 'qoder', title: 'Qoder', effort: 'xhigh' },
      ],
    })
    registration.sync()
    const agent = ((registered.find(row => row.definition.name === 'acp_delegate')?.definition.parameters as {
      properties?: { agent?: { description?: string } }
    } | undefined)?.properties?.agent)
    expect(agent?.description).toContain('Pick by capability:')
    expect(agent?.description).toContain('- codebuddy (CodeBuddy): 通用编码，支持子智能体; defaults: follow the process itself')
    expect(agent?.description).toContain('- qoder (Qoder): defaults: level xhigh')
  })

  it('re-registers when only the roster text changes, so the next header carries it', () => {
    let description = '第一版'
    const { registration, registered } = makeRegistration({
      guidance: 'on',
      roster: () => [{ id: 'codebuddy', title: 'CodeBuddy', description }],
    })
    registration.sync()
    expect(registered).toHaveLength(2)
    description = '第二版'
    registration.sync()
    expect(registered).toHaveLength(2)
    const agent = ((registered.find(row => row.definition.name === 'acp_delegate')?.definition.parameters as {
      properties?: { agent?: { description?: string } }
    } | undefined)?.properties?.agent)
    expect(agent?.description).toContain('第二版')
  })

  it('reconciles at most one registration set across repeated syncs', () => {
    const { registration, registered } = makeRegistration({ guidance: 'on' })
    for (let round = 0; round < 3; round += 1) registration.sync()
    expect(registered).toHaveLength(2)
    expect(registration.registeredTools).toEqual(['acp_delegate', 'acp_release'])
  })
})

describe('acp_release execute', () => {
  it('releases every idle process when no agent is named, and reports what was skipped', async () => {
    const { registration, registered, releaseCalls } = makeRegistration({ guidance: 'on' })
    registration.sync()
    const release = registered.find(row => row.definition.name === 'acp_release')?.definition
    expect(release).toBeDefined()
    const out = await release?.execute({}) as { text: string }
    expect(releaseCalls).toEqual([undefined])
    expect(out.text).toContain('Released idle processes: codebuddy')
    expect(out.text).toContain('Not released: qoder (still has work in flight)')

    const qoder = await release?.execute({ agent: 'qoder' }) as { text: string }
    expect(releaseCalls).toEqual([undefined, 'qoder'])
    expect(qoder.text).toContain('Not released: qoder (still has work in flight)')

    expect(await release?.execute({ agent: 'ghost' }))
      .toEqual({ text: 'acp_release failed: agent "ghost" is not configured (configured: codebuddy, qoder).' })
    expect(releaseCalls).toEqual([undefined, 'qoder'])
  })

  it('reports an empty result when nothing is ready, and rejects a non-string agent', async () => {
    const release: AcpReleaseHost = {
      agents: () => [],
      release: async () => ({ released: [], skipped: [] }),
    }
    const { registration, registered } = makeRegistration({ guidance: 'on', release })
    registration.sync()
    const def = registered.find(row => row.definition.name === 'acp_release')?.definition
    expect(await def?.execute({}))
      .toEqual({ text: 'Nothing to release right now: no ready ACP process (or all of them have work in flight).' })
    expect(await def?.execute({ agent: 1 }))
      .toEqual({ text: 'acp_release failed: agent must be a non-empty string.' })
  })

  it('never throws out of the execute shell — a release failure becomes a report line', async () => {
    const release: AcpReleaseHost = {
      agents: () => [{ id: 'codebuddy', title: 'CodeBuddy' }],
      release: async () => { throw new Error('bridge exploded') },
    }
    const { registration, registered } = makeRegistration({ guidance: 'on', release })
    registration.sync()
    const def = registered.find(row => row.definition.name === 'acp_release')?.definition
    expect(await def?.execute({})).toEqual({ text: 'acp_release failed: bridge exploded' })
  })
})

describe('registration failure', () => {
  it('keeps a permanent insertion instead of registering its line twice', () => {
    let calls = 0
    const rows: RegisteredRow[] = []
    const tools = {
      get: () => undefined,
      register: (definition: RegisteredRow['definition']) => {
        calls += 1
        if (calls === 2) throw new Error('no room for the release tool')
        rows.push({ definition })
      },
    }
    const ctx: DelegateRegistrationCtx = {
      get: name => (name === 'tools' ? tools : undefined),
      inject: () => undefined,
    }
    const registration = new AcpDelegateRegistration({
      ctx,
      service: { execute: async () => ({ text: '', agent: '' }) } as unknown as AcpDelegateService,
      config: () => ({ guidance: 'on', timeoutMs: 60_000 }),
      forceMask: fakeMask(),
      release: { agents: () => [], release: async () => ({ released: [], skipped: [] }) },
    })
    registration.sync()
    expect(registration.registeredTools).toEqual(['acp_delegate'])
    // Degraded: the permanent line stays, and the failed tool is not retried
    // into a second copy on the next sync.
    registration.sync()
    expect(registration.registeredTools).toEqual(['acp_delegate'])
    expect(calls).toBe(2)
  })
})

describe('registration degraded / missing-service hosts', () => {
  it('does not register either tool on a host with no tools service', () => {
    const ctx: DelegateRegistrationCtx = { get: () => undefined, inject: () => undefined }
    const registration = new AcpDelegateRegistration({
      ctx,
      service: { execute: async () => ({ text: '', agent: '' }) } as unknown as AcpDelegateService,
      config: () => ({ guidance: 'on', timeoutMs: 60_000 }),
      forceMask: fakeMask(),
      release: { agents: () => [], release: async () => ({ released: [], skipped: [] }) },
    })
    registration.sync()
    expect(registration.registeredTools).toEqual([])
    expect(registration.toolAvailable).toBe(false)
  })

  it('keeps a permanent insertion but answers off from the LIVE config in both tools', async () => {
    const rows: RegisteredRow[] = []
    const tools = {
      get: (name: string) => rows.find(row => row.definition.name === name)?.definition,
      register: (definition: RegisteredRow['definition']) => { rows.push({ definition }) },
    }
    const ctx: DelegateRegistrationCtx = {
      get: name => (name === 'tools' ? tools : undefined),
      inject: () => undefined,
    }
    let guidance: 'on' | 'off' = 'on'
    const calls: Array<string | undefined> = []
    const registration = new AcpDelegateRegistration({
      ctx,
      service: { execute: async () => ({ text: '', agent: '' }) } as unknown as AcpDelegateService,
      config: () => ({ guidance, timeoutMs: 60_000 }),
      forceMask: fakeMask(),
      release: {
        agents: () => [{ id: 'codebuddy', title: 'CodeBuddy' }],
        release: async (agentId) => {
          calls.push(agentId)
          return { released: [{ agentId: 'codebuddy', sessions: 0 }], skipped: [] }
        },
      },
    })
    registration.sync()
    expect(registration.registeredTools).toEqual(['acp_delegate', 'acp_release'])
    const release = rows.find(row => row.definition.name === 'acp_release')?.definition
    expect(await release?.execute({}))
      .toEqual({ text: 'Released idle processes: codebuddy. Related sessions resume automatically on their next message.' })
    guidance = 'off'
    registration.sync()
    // The old host cannot remove the insertion; both tools must go dark.
    expect(registration.registeredTools).toEqual(['acp_delegate', 'acp_release'])
    expect(await release?.execute({})).toEqual({ text: 'acp_release is disabled' })
    expect(await rows.find(row => row.definition.name === 'acp_delegate')?.definition.execute({ task: 'x' }))
      .toEqual({ text: 'acp_delegate is disabled', agent: '' })
    expect(calls).toEqual([undefined])
  })
})
