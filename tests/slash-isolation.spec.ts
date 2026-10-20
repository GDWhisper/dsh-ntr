/**
 * Slash isolation: while a conversation runs the ACP preset, the host's `/`
 * sources must not answer for it. The wrappers are per CALL — the source
 * objects are shared by every conversation — so every hook is exercised twice,
 * once as an ACP session and once as an ordinary one.
 */

import { describe, expect, it, vi } from 'vitest'
import { commandCandidates, createSlashIsolation, slashAcpVerdict } from '../src/client/slash-isolation.ts'
import type { SlashIsolationOptions, SlashSource } from '../src/client/slash-isolation.ts'
import type { AgentCommand } from '../src/client/store.ts'

interface HostSource extends SlashSource {
  calls: string[]
}

/** The host `command` source, narrowed to what isolation touches. */
function hostSource(): HostSource {
  const calls: string[] = []
  const source: HostSource = {
    trigger: '/',
    name: 'command',
    calls,
    candidates: async () => {
      calls.push('candidates')
      return [{ name: 'model', description: 'host model picker' }]
    },
    matchEnter: async () => {
      calls.push('matchEnter')
      return 'handled'
    },
    matchSpace: () => {
      calls.push('matchSpace')
      return { claim: { name: 'model' } }
    },
    onPick: () => {
      calls.push('onPick')
      return 'handled'
    },
    warm: () => { calls.push('warm') },
    lexicon: () => {
      calls.push('lexicon')
      return ['model']
    },
  }
  return source
}

function harness(overrides: Partial<SlashIsolationOptions> = {}, source = hostSource()) {
  const diags: string[] = []
  const options: SlashIsolationOptions = {
    sources: () => [source],
    verdict: sessionId => sessionId === ACP.sessionId,
    ensureVerdict: async sessionId => sessionId === ACP.sessionId,
    commands: () => [
      { name: 'model', description: 'switch the model', input: { hint: '<name>' } },
      { name: 'compact', description: 'compress the context' },
    ],
    refresh: vi.fn(),
    onDiag: (line) => diags.push(line),
    ...overrides,
  }
  return { source, options, diags, isolation: createSlashIsolation(options) }
}

const ACP = { sessionId: 'chat-1' }
const ORDINARY = { sessionId: 'chat-2' }

describe('commandCandidates', () => {
  const commands: AgentCommand[] = [
    { name: 'model', description: 'switch the model', input: { hint: '<name>' } },
    { name: 'compact', description: 'compress the context' },
    { name: 'model', description: 'duplicate row' },
    { name: '', description: 'nameless' },
  ]

  it('keeps the agent order and maps name, description and the input hint', () => {
    expect(commandCandidates(commands, '')).toEqual([
      { name: 'model', description: 'switch the model', hint: '<name>' },
      { name: 'compact', description: 'compress the context' },
    ])
  })

  it('matches case-insensitive subsequences of the name, like the host ranker', () => {
    expect(commandCandidates(commands, 'COMP')).toEqual([{ name: 'compact', description: 'compress the context' }])
    // Subsequence, not substring: c…m…p is found in `compact`.
    expect(commandCandidates(commands, 'cmp')).toEqual([{ name: 'compact', description: 'compress the context' }])
    // Descriptions are not search keys — the host ranks names only.
    expect(commandCandidates(commands, 'context')).toEqual([])
    expect(commandCandidates(commands, 'nope')).toEqual([])
  })

  it('puts prefix hits first, then alignment score, then the agent order', () => {
    // The reported case: CodeBuddy declares these three, and `/compac` used to
    // list them in declaration order (`autocompact` first). The host's ranker
    // leads with the prefix hit, so the row the user almost certainly meant
    // comes first.
    const codebuddy: AgentCommand[] = [
      { name: 'autocompact' },
      { name: 'compact' },
      { name: '_compact' },
    ]
    const ranked = commandCandidates(codebuddy, 'compac')
    expect(ranked.map(row => row.name)).toEqual(['compact', '_compact', 'autocompact'])
    // An empty query keeps the agent's own order untouched.
    expect(commandCandidates(codebuddy, '').map(row => row.name))
      .toEqual(['autocompact', 'compact', '_compact'])
  })

  it('survives malformed rows instead of dropping the whole menu', () => {
    const malformed = [null, 'model', { name: 42 }, { name: 'ok' }] as unknown as AgentCommand[]
    expect(commandCandidates(malformed, '')).toEqual([{ name: 'ok' }])
  })
})

describe('slashAcpVerdict', () => {
  it('trusts the staged row when it names a preset', () => {
    const snapshot = { current: 'chat-1', byId: { 'chat-1': { agentPreset: 'acp' } } }
    expect(slashAcpVerdict(snapshot, 'chat-1', () => false)).toBe(true)
    expect(slashAcpVerdict({ ...snapshot, byId: { 'chat-1': { agentPreset: 'standard' } } }, 'chat-1', () => true)).toBe(false)
  })

  it('falls back to the host verdict while the row is silent, and answers undefined without one', () => {
    const snapshot = { current: 'chat-1', byId: { 'chat-1': {} } }
    expect(slashAcpVerdict(snapshot, 'chat-1', () => true)).toBe(true)
    expect(slashAcpVerdict(snapshot, 'chat-1', () => undefined)).toBeUndefined()
    // A session that is not the staged one can only be answered by its verdict.
    expect(slashAcpVerdict(snapshot, 'chat-9', id => (id === 'chat-9' ? false : true))).toBe(false)
  })
})

describe('createSlashIsolation', () => {
  it('serves the agent commands and never lets the host claim Enter in ACP mode', async () => {
    const { source, options, isolation } = harness()
    isolation.sync()

    expect(await source.candidates!(ACP, { query: '' })).toEqual([
      { name: 'model', description: 'switch the model', hint: '<name>' },
      { name: 'compact', description: 'compress the context' },
    ])
    expect(await source.candidates!(ACP, { query: 'MOD' })).toEqual([
      { name: 'model', description: 'switch the model', hint: '<name>' },
    ])
    expect(await source.matchEnter!(ACP, '/model', new AbortController().signal, { attachments: 0 })).toBeUndefined()
    expect(source.matchSpace!(ACP, '/model')).toBeUndefined()
    expect(source.onPick!({ candidate: { name: 'model' }, session: ACP })).toEqual({ text: '/model ' })
    source.warm!(ACP)
    expect(source.lexicon!(ACP)).toBeUndefined()

    // The host side was never consulted — not even its candidates.
    expect(source.calls).toEqual([])
    expect(options.refresh).not.toHaveBeenCalled()
  })

  it('serves the commands from ONE menu group, whichever order the sources registered in', async () => {
    // Both host sources bind `/` (the command catalog and the skill catalog).
    // Returning the agent list from each would draw it twice, so the command
    // group carries it and every other group is silenced.
    const skill: HostSource = {
      trigger: '/',
      name: 'skill',
      calls: [],
      candidates: async () => {
        skill.calls.push('candidates')
        return [{ name: 'dsh-skill' }]
      },
      onPick: () => 'handled',
    }
    const command = hostSource()
    const { isolation } = harness({ sources: () => [skill, command] })
    isolation.sync()

    expect(await command.candidates!(ACP, { query: '' })).toHaveLength(2)
    expect(await skill.candidates!(ACP, { query: '' })).toEqual([])
    expect(skill.calls).toEqual([])
    expect(command.calls).toEqual([])
    // An ordinary conversation still gets BOTH host groups.
    expect(await skill.candidates!(ORDINARY, { query: '' })).toEqual([{ name: 'dsh-skill' }])
  })

  it('awaits a command source that has to read the cache first', async () => {
    const { source, isolation } = harness({
      commands: async () => {
        await Promise.resolve()
        return [{ name: 'deferred', description: 'arrives later' }]
      },
    })
    isolation.sync()
    expect(await source.candidates!(ACP, { query: '' })).toEqual([{ name: 'deferred', description: 'arrives later' }])
  })

  it('hides argument-taking commands inside running text, like the host menu does', async () => {
    const { source, isolation } = harness()
    isolation.sync()
    expect(await source.candidates!(ACP, { query: '', position: 'inline' })).toEqual([
      { name: 'compact', description: 'compress the context' },
    ])
  })

  it('leaves ordinary conversations exactly as the host registered them', async () => {
    const { source, isolation } = harness({ verdict: () => false })
    isolation.sync()

    expect(await source.candidates!(ORDINARY, { query: '' })).toEqual([{ name: 'model', description: 'host model picker' }])
    expect(await source.matchEnter!(ORDINARY, '/model', new AbortController().signal, { attachments: 0 })).toBe('handled')
    expect(source.matchSpace!(ORDINARY, '/model')).toEqual({ claim: { name: 'model' } })
    expect(source.onPick!({ candidate: { name: 'model' }, session: ORDINARY })).toBe('handled')
    source.warm!(ORDINARY)
    expect(source.lexicon!(ORDINARY)).toEqual(['model'])
    expect(source.calls).toEqual(['candidates', 'matchEnter', 'matchSpace', 'onPick', 'warm', 'lexicon'])
  })

  it('asks the host once when no verdict is held, then shows nothing until an answer arrives', async () => {
    let answer: boolean | undefined
    const refresh = vi.fn()
    const ensureVerdict = vi.fn(async () => {
      answer = true
      return answer
    })
    const { source, isolation } = harness({ verdict: () => answer, ensureVerdict, refresh, commands: () => undefined })
    isolation.sync()

    // No verdict yet, no commands yet: the ask goes out and the menu stays
    // empty — it never falls back to the host catalog in the meantime.
    expect(await source.candidates!(ACP, { query: '' })).toEqual([])
    expect(ensureVerdict).toHaveBeenCalledTimes(1)
    expect(refresh).toHaveBeenCalledWith('chat-1')

    // The verdict is held now, so no second ask — but commands are still
    // unknown, so the read is kicked again.
    await source.candidates!(ACP, { query: 'm' })
    expect(ensureVerdict).toHaveBeenCalledTimes(1)
  })

  it('throttles the host ask so ordinary typing cannot turn into RPC traffic', async () => {
    const ensureVerdict = vi.fn(async () => undefined)
    const { source, isolation } = harness({ verdict: () => undefined, ensureVerdict })
    isolation.sync()

    await source.candidates!(ACP, { query: '' })
    await source.candidates!(ACP, { query: 'm' })
    await source.candidates!(ACP, { query: 'mo' })
    expect(ensureVerdict).toHaveBeenCalledTimes(1)
  })

  it('does not add a hook the source never implemented', async () => {
    const bare: HostSource = { trigger: '/', name: 'skill', calls: [], candidates: async () => [] }
    const { isolation } = harness({}, bare)
    isolation.sync()

    expect(bare.matchEnter).toBeUndefined()
    expect(bare.matchSpace).toBeUndefined()
    expect(bare.warm).toBeUndefined()
  })

  it('leaves non-slash sources alone', async () => {
    const reference: HostSource = {
      trigger: '@',
      name: 'reference',
      calls: [],
      candidates: async () => {
        reference.calls.push('candidates')
        return [{ name: 'file' }]
      },
    }
    const { isolation } = harness({ sources: () => [reference] })
    isolation.sync()
    expect(await reference.candidates!(ACP, { query: '' })).toEqual([{ name: 'file' }])
    expect(reference.calls).toEqual(['candidates'])
  })

  it('wraps once across repeated syncs, and restores the host on dispose', async () => {
    const { source, isolation } = harness({ verdict: () => false })
    const candidates = source.candidates
    const matchEnter = source.matchEnter
    isolation.sync()
    isolation.sync()

    expect(await source.matchEnter!(ORDINARY, '/model', new AbortController().signal, { attachments: 0 })).toBe('handled')
    expect(source.calls).toEqual(['matchEnter'])

    isolation.dispose()
    expect(source.candidates).toBe(candidates)
    expect(source.matchEnter).toBe(matchEnter)
    expect(source.matchSpace).toBeDefined()
    // Disposing twice is a no-op, not a crash.
    isolation.dispose()
  })

  it('replaces a wrapper left by a previous instance (a plugin reload keeps the live sources)', async () => {
    const source = hostSource()
    const first = harness({ verdict: () => false }, source)
    first.isolation.sync()
    expect(await source.matchEnter!(ORDINARY, '/model', new AbortController().signal, { attachments: 0 })).toBe('handled')

    const second = harness({ verdict: () => true }, source)
    second.isolation.sync()
    // The second instance's verdict is the one that answers now.
    expect(await source.matchEnter!(ORDINARY, '/model', new AbortController().signal, { attachments: 0 })).toBeUndefined()

    // The first instance no longer owns the properties: its dispose must not
    // resurrect the host's hooks under the second instance.
    first.isolation.dispose()
    expect(await source.matchEnter!(ORDINARY, '/model', new AbortController().signal, { attachments: 0 })).toBeUndefined()
    second.isolation.dispose()
    expect(await source.matchEnter!(ORDINARY, '/model', new AbortController().signal, { attachments: 0 })).toBe('handled')
  })

  it('fails open when the registry is missing, and reports it once', () => {
    const diags: string[] = []
    const isolation = createSlashIsolation({
      sources: () => { throw new Error('no service') },
      verdict: () => undefined,
      ensureVerdict: async () => undefined,
      commands: () => undefined,
      refresh: () => {},
      onDiag: line => diags.push(line),
    })
    expect(() => isolation.sync()).not.toThrow()
    isolation.sync()
    expect(diags).toEqual(['the slash registry is unavailable; host slash commands stay in charge'])
  })

  it('fails open on an unrecognized source shape, and still wraps the healthy one', async () => {
    const broken = { trigger: '/', name: 'weird', candidates: undefined } as unknown as HostSource
    const source = hostSource()
    const { isolation, diags } = harness({ sources: () => [broken, source] })
    isolation.sync()
    expect(diags).toContain('slash source "weird" has no candidates hook; left alone')
    expect(await source.candidates!(ACP, { query: '' })).toHaveLength(2)
  })

  it('reports idle again once the seam is in force after a failure', () => {
    let registry: SlashSource[] | undefined
    const diags: string[] = []
    const isolation = createSlashIsolation({
      sources: () => registry,
      verdict: () => true,
      ensureVerdict: async () => true,
      commands: () => [],
      refresh: () => {},
      onDiag: line => diags.push(line),
    })
    isolation.sync()
    registry = [hostSource()]
    isolation.sync()
    expect(diags).toEqual([
      'the slash registry is unavailable; host slash commands stay in charge',
      'idle',
    ])
  })
})
