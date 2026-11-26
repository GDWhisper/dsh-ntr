import { describe, expect, it } from 'vitest'
import { validateDelegateSettings } from '../../src/impl.ts'
import { delegateAgentDoc, delegateAgentDocs, delegateAgentDocLine, delegateRosterDigest, delegateRosterText } from '../../src/impl/delegate-doc.ts'
import { DELEGATE_DESCRIPTION_MAX, DELEGATE_IDENTITY_MAX } from '../../src/protocol.ts'

describe('delegate roster rows (the tool schema grammar)', () => {
  it('renders id + title + identity + description + the delegation defaults in one line', () => {
    expect(delegateAgentDocLine({ id: 'codebuddy', title: 'CodeBuddy', identity: 'Code review', description: 'General coding and CLI work', model: 'hy4flash-free', effort: 'high' }))
      .toBe('- codebuddy (CodeBuddy): identity: Code review; General coding and CLI work; defaults: model hy4flash-free, level high')
  })

  it('keeps a row without an identity byte-identical to the pre-identity grammar', () => {
    // Existing entries must not change shape: the identity segment simply is
    // not there, and nothing reorders around it.
    expect(delegateAgentDocLine({ id: 'codebuddy', title: 'CodeBuddy', description: 'General coding and CLI work', model: 'hy4flash-free', effort: 'high' }))
      .toBe('- codebuddy (CodeBuddy): General coding and CLI work; defaults: model hy4flash-free, level high')
    expect(delegateAgentDocLine({ id: 'a', title: 'A', identity: 'Research' }))
      .toBe('- a (A): identity: Research; defaults: follow the process itself')
  })

  it('folds a semicolon inside the identity so the row keeps its segments', () => {
    // The row separates its segments with '; ', so a tag carrying one would
    // split its own row and make the segment count a lie.
    expect(delegateAgentDocLine({ id: 'a', title: 'A', identity: 'Review; fast' }))
      .toBe('- a (A): identity: Review, fast; defaults: follow the process itself')
    // Folded in the digest too, so a ';' → ',' edit renders and hashes alike.
    expect(delegateRosterDigest([{ id: 'a', title: 'A', identity: 'Review; fast' }]))
      .toBe(delegateRosterDigest([{ id: 'a', title: 'A', identity: 'Review, fast' }]))
  })

  it('omits the parenthetical when the title is the id, and always names the defaults', () => {
    expect(delegateAgentDocLine({ id: 'pi', title: 'pi' }))
      .toBe('- pi: defaults: follow the process itself')
    expect(delegateAgentDocLine({ id: 'pi', title: '' }))
      .toBe('- pi: defaults: follow the process itself')
  })

  it('drops trailing sentence punctuation so the joined row never doubles it', () => {
    expect(delegateAgentDocLine({ id: 'agy', title: 'AGY', description: '联网调研。' }))
      .toBe('- agy (AGY): 联网调研; defaults: follow the process itself')
    // The English endings ride the same rule: a description that already closes
    // its sentence must not grow a second one after the semicolon.
    expect(delegateAgentDocLine({ id: 'agy', title: 'AGY', description: 'Web research!' }))
      .toBe('- agy (AGY): Web research; defaults: follow the process itself')
    expect(delegateAgentDocLine({ id: 'agy', title: 'AGY', description: 'Web research?' }))
      .toBe('- agy (AGY): Web research; defaults: follow the process itself')
    // Fullwidth endings are the same rule: a user still writing Chinese must not
    // leave a stray ！ in front of the defaults clause.
    expect(delegateAgentDocLine({ id: 'agy', title: 'AGY', description: '联网调研！' }))
      .toBe('- agy (AGY): 联网调研; defaults: follow the process itself')
    expect(delegateAgentDocLine({ id: 'agy', title: 'AGY', description: '联网调研？' }))
      .toBe('- agy (AGY): 联网调研; defaults: follow the process itself')
  })

  it('folds newlines and space runs so one agent always stays one line', () => {
    expect(delegateAgentDocLine({ id: 'agy', title: 'AGY', description: '联网\n调研   与写作' }))
      .toBe('- agy (AGY): 联网 调研 与写作; defaults: follow the process itself')
  })

  it('builds a roster block in roster order, or nothing when no agent is configured', () => {
    const text = delegateRosterText([
      { id: 'a', title: 'A', description: '快' },
      { id: 'b', title: 'B', mode: 'build' },
    ])
    expect(text.split('\n')).toEqual([
      'Pick by capability:',
      '- a (A): 快; defaults: follow the process itself',
      '- b (B): defaults: mode build',
    ])
    expect(delegateRosterText([])).toBe('')
  })

  it('drops the "pick by trait" header when no row carries a description', () => {
    const text = delegateRosterText([{ id: 'a', title: 'A' }, { id: 'b', title: 'B', model: 'm' }])
    expect(text.split('\n')).toEqual([
      'Configured agents (none has a "good at" line):',
      '- a (A): defaults: follow the process itself',
      '- b (B): defaults: model m',
    ])
    // A whitespace-only description is not a ground to choose either.
    expect(delegateRosterText([{ id: 'a', title: 'A', description: '   ' }]).split('\n')[0])
      .toBe('Configured agents (none has a "good at" line):')
  })

  it('names the identity tags when no row carries a description', () => {
    // A tag is a weaker ground than prose but still a real one, so rows that
    // carry one get their own header rather than the "nothing known" one.
    const text = delegateRosterText([{ id: 'a', title: 'A', identity: 'Research' }, { id: 'b', title: 'B' }])
    expect(text.split('\n')).toEqual([
      'Configured agents (identity tags only):',
      '- a (A): identity: Research; defaults: follow the process itself',
      '- b (B): defaults: follow the process itself',
    ])
    // A whitespace-only tag is not a ground either.
    expect(delegateRosterText([{ id: 'a', title: 'A', identity: '  ' }]).split('\n')[0])
      .toBe('Configured agents (none has a "good at" line):')
  })

  it('digests every rendered field, in order, with absent axes reading as empty', () => {
    const base = delegateRosterDigest([{ id: 'a', title: 'A' }])
    expect(delegateRosterDigest([{ id: 'a', title: 'A', description: undefined }])).toBe(base)
    expect(delegateRosterDigest([{ id: 'a', title: 'A', description: 'x' }])).not.toBe(base)
    expect(delegateRosterDigest([{ id: 'b', title: 'A' }])).not.toBe(base)
    // An identity edit must reach the NEXT request header, exactly like a
    // description edit — that is what the digest is for.
    expect(delegateRosterDigest([{ id: 'a', title: 'A', identity: 'Research' }])).not.toBe(base)
    // Hashed FOLDED, like the row renders: an edit that renders the same row
    // must not churn the tool list (whitespace runs, trailing punctuation).
    expect(delegateRosterDigest([{ id: 'agy', title: 'AGY', description: '  联网  调研。' }]))
      .toBe(delegateRosterDigest([{ id: 'agy', title: 'AGY', description: '联网 调研' }]))
    // Order is part of the fact: the same rows in another order must re-register.
    const one = delegateRosterDigest([{ id: 'a', title: 'A' }, { id: 'b', title: 'B' }])
    const two = delegateRosterDigest([{ id: 'b', title: 'B' }, { id: 'a', title: 'A' }])
    expect(one).not.toBe(two)
  })

  it('narrows a settings entry into a doc row (description and axes only when present)', () => {
    expect(delegateAgentDoc('codebuddy', 'CodeBuddy', { description: '通用编码', model: 'hy4flash-free' }))
      .toEqual({ id: 'codebuddy', title: 'CodeBuddy', description: '通用编码', model: 'hy4flash-free' })
    expect(delegateAgentDoc('codebuddy', 'CodeBuddy', undefined))
      .toEqual({ id: 'codebuddy', title: 'CodeBuddy' })
  })

  it('builds every row from the live views, joining defaults by id and omitting disabled agents', () => {
    expect(delegateAgentDocs(
      [{ id: 'a', title: 'A' }, { id: 'b', title: 'B' }, { id: 'c', title: 'C' }],
      { b: { effort: 'high' }, c: { enabled: false, description: 'hidden' } },
    )).toEqual([
      { id: 'a', title: 'A' },
      { id: 'b', title: 'B', effort: 'high' },
    ])
    // The identity rides the same entry as the axes and the description.
    expect(delegateAgentDocs([{ id: 'a', title: 'A' }], { a: { identity: 'Code review', model: 'm' } }))
      .toEqual([{ id: 'a', title: 'A', identity: 'Code review', model: 'm' }])
    expect(delegateAgentDocs([{ id: 'a', title: 'A' }], undefined)).toEqual([{ id: 'a', title: 'A' }])
    expect(delegateAgentDocs([], { a: { model: 'm' } })).toEqual([])
    expect(delegateRosterDigest(delegateAgentDocs([{ id: 'a', title: 'A' }, { id: 'b', title: 'B' }], { b: { enabled: false } })))
      .not.toBe(delegateRosterDigest(delegateAgentDocs([{ id: 'a', title: 'A' }, { id: 'b', title: 'B' }], undefined)))
  })
})

describe('delegate description and enabled validation', () => {
  it('keeps explicit enabled: false, normalizes enabled: true away, and rejects non-booleans', () => {
    expect(validateDelegateSettings({ agentDefaults: { codebuddy: { enabled: false, model: 'm' } } }))
      .toEqual({ agentDefaults: { codebuddy: { enabled: false, model: 'm' } } })
    expect(validateDelegateSettings({ agentDefaults: { codebuddy: { enabled: true, model: 'm' } } }))
      .toEqual({ agentDefaults: { codebuddy: { model: 'm' } } })
    expect(() => validateDelegateSettings({ agentDefaults: { codebuddy: { enabled: 'false' } } }))
      .toThrow(/enabled must be a boolean/)
  })
  it('keeps a trimmed description and drops an all-whitespace one', () => {
    expect(validateDelegateSettings({ agentDefaults: { codebuddy: { description: '  通用编码  ' } } }))
      .toEqual({ agentDefaults: { codebuddy: { description: '通用编码' } } })
    expect(validateDelegateSettings({ agentDefaults: { codebuddy: { description: '   ' } } }))
      .toEqual({ agentDefaults: { codebuddy: {} } })
  })

  it('rejects a description over the schema budget and a non-string value', () => {
    const long = 'x'.repeat(DELEGATE_DESCRIPTION_MAX + 1)
    expect(() => validateDelegateSettings({ agentDefaults: { codebuddy: { description: long } } }))
      .toThrow(/description must be at most/)
    expect(() => validateDelegateSettings({ agentDefaults: { codebuddy: { description: 42 } } }))
      .toThrow(/description must be a string/)
  })

  it('reports the deployment baseline as just the keys the file names', () => {
    // Shape only: the validator never checks the agent roster.
    expect(validateDelegateSettings({ agentDefaults: { 'ghost-agent': { description: 'still stored' } } }))
      .toEqual({ agentDefaults: { 'ghost-agent': { description: 'still stored' } } })
  })
})

describe('delegate identity validation', () => {
  it('keeps a trimmed identity and drops an all-whitespace one', () => {
    expect(validateDelegateSettings({ agentDefaults: { codebuddy: { identity: '  Code review  ' } } }))
      .toEqual({ agentDefaults: { codebuddy: { identity: 'Code review' } } })
    expect(validateDelegateSettings({ agentDefaults: { codebuddy: { identity: '   ' } } }))
      .toEqual({ agentDefaults: { codebuddy: {} } })
  })

  it('rejects an identity over the tag budget and a non-string value', () => {
    const long = 'x'.repeat(DELEGATE_IDENTITY_MAX + 1)
    expect(() => validateDelegateSettings({ agentDefaults: { codebuddy: { identity: long } } }))
      .toThrow(/identity must be at most/)
    expect(() => validateDelegateSettings({ agentDefaults: { codebuddy: { identity: 42 } } }))
      .toThrow(/identity must be a string/)
  })

  it('keeps the identity beside the axes and the description in one entry', () => {
    // Shape only: a tag naming no preset is still a valid tag (presets are a
    // UI affordance, not a vocabulary the host enforces).
    expect(validateDelegateSettings({ agentDefaults: { codebuddy: { identity: '运维值守', model: 'm', description: 'd' } } }))
      .toEqual({ agentDefaults: { codebuddy: { identity: '运维值守', model: 'm', description: 'd' } } })
  })
})
