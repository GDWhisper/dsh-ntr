import { describe, expect, it } from 'vitest'
import { validateDelegateSettings } from '../../src/impl.ts'
import { delegateAgentDoc, delegateAgentDocs, delegateAgentDocLine, delegateRosterDigest, delegateRosterText } from '../../src/impl/delegate-doc.ts'
import { DELEGATE_DESCRIPTION_MAX } from '../../src/protocol.ts'

describe('delegate roster rows (the tool schema grammar)', () => {
  it('renders id + title + description + the delegation defaults in one line', () => {
    expect(delegateAgentDocLine({ id: 'codebuddy', title: 'CodeBuddy', description: '通用编码与命令行', model: 'hy4flash-free', effort: 'high' }))
      .toBe('- codebuddy（CodeBuddy）：通用编码与命令行；委派默认：模型 hy4flash-free、等级 high')
  })

  it('omits the parenthetical when the title is the id, and always names the defaults', () => {
    expect(delegateAgentDocLine({ id: 'pi', title: 'pi' }))
      .toBe('- pi：委派默认：跟随进程自身')
    expect(delegateAgentDocLine({ id: 'pi', title: '' }))
      .toBe('- pi：委派默认：跟随进程自身')
  })

  it('drops trailing sentence punctuation so the joined row never doubles it', () => {
    expect(delegateAgentDocLine({ id: 'agy', title: 'AGY', description: '联网调研。' }))
      .toBe('- agy（AGY）：联网调研；委派默认：跟随进程自身')
  })

  it('folds newlines and space runs so one agent always stays one line', () => {
    expect(delegateAgentDocLine({ id: 'agy', title: 'AGY', description: '联网\n调研   与写作' }))
      .toBe('- agy（AGY）：联网 调研 与写作；委派默认：跟随进程自身')
  })

  it('builds a roster block in roster order, or nothing when no agent is configured', () => {
    const text = delegateRosterText([
      { id: 'a', title: 'A', description: '快' },
      { id: 'b', title: 'B', mode: 'build' },
    ])
    expect(text.split('\n')).toEqual([
      '可按特性挑选：',
      '- a（A）：快；委派默认：跟随进程自身',
      '- b（B）：委派默认：模式 build',
    ])
    expect(delegateRosterText([])).toBe('')
  })

  it('digests every rendered field, in order, with absent axes reading as empty', () => {
    const base = delegateRosterDigest([{ id: 'a', title: 'A' }])
    expect(delegateRosterDigest([{ id: 'a', title: 'A', description: undefined }])).toBe(base)
    expect(delegateRosterDigest([{ id: 'a', title: 'A', description: 'x' }])).not.toBe(base)
    expect(delegateRosterDigest([{ id: 'b', title: 'A' }])).not.toBe(base)
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

  it('builds every row from the live views, joining defaults by id', () => {
    expect(delegateAgentDocs(
      [{ id: 'a', title: 'A' }, { id: 'b', title: 'B' }],
      { b: { effort: 'high' } },
    )).toEqual([
      { id: 'a', title: 'A' },
      { id: 'b', title: 'B', effort: 'high' },
    ])
    expect(delegateAgentDocs([{ id: 'a', title: 'A' }], undefined)).toEqual([{ id: 'a', title: 'A' }])
    expect(delegateAgentDocs([], { a: { model: 'm' } })).toEqual([])
  })
})

describe('delegate description validation', () => {
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
