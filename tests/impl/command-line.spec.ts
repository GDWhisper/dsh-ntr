/**
 * Command-line tokenizing and quoting: a whole command line is the program plus args, quotes preserved (constraint 26).
 *
 * Part of the `tests/impl.spec.ts` mirror: one file per `src/impl/` cluster,
 * same describe titles and case counts as before the split.
 */

import { describe, expect, it } from 'vitest'
import {
  AcpError,
  splitCommandLine,
  quoteCommandToken,
  tokenizeCommandLine,
  validateAgentDef,
} from '../../src/impl.ts'

describe('command lines', () => {
  it('splits a pasted command line into program + arguments', () => {
    expect(splitCommandLine('codebuddy --acp')).toEqual({ command: 'codebuddy', args: ['--acp'] })
    expect(splitCommandLine('  omp   acp  ')).toEqual({ command: 'omp', args: ['acp'] })
    expect(splitCommandLine('pi-acp')).toEqual({ command: 'pi-acp', args: [] })
    expect(splitCommandLine('npx -y @tencent-ai/codebuddy-code --acp')).toEqual({
      command: 'npx',
      args: ['-y', '@tencent-ai/codebuddy-code', '--acp'],
    })
  })

  it('keeps a quoted path in one piece, and a backslash is not an escape', () => {
    expect(splitCommandLine('"C:\\Program Files\\nodejs\\node.exe" --acp'))
      .toEqual({ command: 'C:\\Program Files\\nodejs\\node.exe', args: ['--acp'] })
    expect(splitCommandLine("'my agent' --flag value")).toEqual({ command: 'my agent', args: ['--flag', 'value'] })
    expect(splitCommandLine('cmd /c "a b"')).toEqual({ command: 'cmd', args: ['/c', 'a b'] })
    // `\"` is the one escape the tokenizer honors (Windows paths are otherwise
    // nothing but backslashes, so a general escape would mangle them).
    expect(splitCommandLine('say "\\"hi\\""')).toEqual({ command: 'say', args: ['"hi"'] })
  })

  it('answers an empty command for blank and quote-only input', () => {
    expect(splitCommandLine('')).toEqual({ command: '', args: [] })
    expect(splitCommandLine('   ')).toEqual({ command: '', args: [] })
    expect(splitCommandLine('""')).toEqual({ command: '', args: [] })
    expect(tokenizeCommandLine('a "" b')).toEqual(['a', '', 'b'])
  })

  it('quotes tokens only when they need it, and round-trips', () => {
    expect(quoteCommandToken('plain')).toBe('plain')
    expect(quoteCommandToken('has space')).toBe('"has space"')
    expect(quoteCommandToken('')).toBe('""')
    for (const token of ['plain', 'has space', 'C:\\Program Files\\x.exe', 'say "hi"', "it's"]) {
      expect(splitCommandLine(quoteCommandToken(token)).command).toBe(token)
    }
  })

  it('folds the command line\'s trailing tokens in front of the explicit args', () => {
    const def = validateAgentDef({ id: 'codebuddy', command: 'codebuddy --acp' })
    expect(def.command).toBe('codebuddy')
    expect(def.args).toEqual(['--acp'])
    // Idempotent: re-validating what this function returned (every boot does)
    // must not move anything around.
    expect(validateAgentDef(def)).toMatchObject({ command: 'codebuddy', args: ['--acp'] })
    // The canonical shape — bare command + args, what every preset stores — is
    // untouched, and an explicit args list keeps its own order after the parsed
    // ones.
    expect(validateAgentDef({ id: 'omp', command: 'omp', args: ['acp'] })).toMatchObject({ command: 'omp', args: ['acp'] })
    expect(validateAgentDef({ id: 'x', command: 'cmd /c foo', args: ['--tail'] }).args).toEqual(['/c', 'foo', '--tail'])
    // Quoting survives: the stored command is the bare path, not the quotes.
    expect(validateAgentDef({ id: 'x', command: '"C:\\Program Files\\x.exe" --acp' }))
      .toMatchObject({ command: 'C:\\Program Files\\x.exe', args: ['--acp'] })
    expect(() => validateAgentDef({ id: 'x', command: '"' })).toThrow(AcpError)
  })

  it('does NOT round-trip a whitespace command through a bare re-validate (quoting restores it)', () => {
    // The returned `command` is the BARE path (spawn needs it unquoted). A bare
    // command with a space is not re-parseable: splitCommandLine splits it again,
    // so the fold's idempotence holds only for whitespace-free commands.
    const def = validateAgentDef({ id: 'x', command: '"C:\\Program Files\\x.exe" --acp' })
    expect(def).toMatchObject({ command: 'C:\\Program Files\\x.exe', args: ['--acp'] })
    expect(validateAgentDef(def)).toMatchObject({ command: 'C:\\Program', args: ['Files\\x.exe', '--acp'] })
    // What `loadPersistedAgents` does before re-validating (quoteLegacyCommand,
    // when the path exists): re-quote the command token and it round-trips.
    const requoted = validateAgentDef({ ...def, command: quoteCommandToken(def.command) })
    expect(requoted).toMatchObject({ command: 'C:\\Program Files\\x.exe', args: ['--acp'] })
  })
})
