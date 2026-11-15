/**
 * Cross-platform path primitives: workspace containment, `resolveFsPath` fence and the Windows cases (UNC, `\\?\`, drive-relative). Must stay equivalent to the browser-side `isAbsolutePathLike` (constraint 24).
 *
 * Part of the `tests/impl.spec.ts` mirror: one file per `src/impl/` cluster,
 * same describe titles and case counts as before the split.
 */

import { describe, expect, it } from 'vitest'
import {
  canonicalizeFsPath,
  isAbsolutePath,
  isUnderPath,
  resolveFsPath,
  resolveSessionCwd,
  validateAgentDef,
} from '../../src/impl.ts'
import { agentDef } from './harness.ts'

describe('resolveSessionCwd', () => {
  const realpath = (p: string): string => (p === '/link' ? '/work/real' : p === '/escape' ? '/etc' : p)

  it('defaults to the configured cwd', () => {
    expect(resolveSessionCwd(agentDef(), undefined, realpath)).toBe('/work')
    expect(resolveSessionCwd(agentDef(), '', realpath)).toBe('/work')
  })
  it('accepts nested paths under an allowed root and canonicalizes symlinks', () => {
    expect(resolveSessionCwd(agentDef(), '/work/sub/dir', realpath)).toBe('/work/sub/dir')
    expect(resolveSessionCwd(agentDef(), '/link', realpath)).toBe('/work/real')
  })
  it('refuses paths outside the roots and non-absolute or missing ones', () => {
    expect(() => resolveSessionCwd(agentDef(), '/etc', realpath)).toThrow(/outside/)
    expect(() => resolveSessionCwd(agentDef(), 'relative', realpath)).toThrow(/absolute/)
    expect(() => resolveSessionCwd(agentDef({ cwd: undefined, allowedCwdRoots: [] }), undefined, realpath)).toThrow(/no default cwd/)
  })
  it('guards prefix confusion (/work2 must not pass under /work)', () => {
    expect(() => resolveSessionCwd(agentDef(), '/work2', realpath)).toThrow(/outside/)
  })
  it('trusts explicitly passed extra roots for this session only', () => {
    // A chat session's cwd is the workspace the user picked in the DSH
    // sidebar; it is never in the agent's own allow-list, which is why the
    // caller has to hand it over as an extra root explicitly.
    expect(() => resolveSessionCwd(agentDef(), '/elsewhere', realpath)).toThrow(/outside/)
    expect(resolveSessionCwd(agentDef(), '/elsewhere', realpath, ['/elsewhere'])).toBe('/elsewhere')
    // Trusting one directory must not widen anything else.
    expect(() => resolveSessionCwd(agentDef(), '/etc', realpath, ['/elsewhere'])).toThrow(/outside/)
    // A junk extra root (relative, non-string) is dropped, never treated as a root.
    expect(() => resolveSessionCwd(agentDef(), '/etc', realpath, ['relative', 42 as unknown as string])).toThrow(/outside/)
    // The configured roots stay in effect alongside it.
    expect(resolveSessionCwd(agentDef(), '/work/sub', realpath, ['/elsewhere'])).toBe('/work/sub')
  })
  it('lets an extra root serve as the cwd of a cwd-less agent', () => {
    const def = agentDef({ cwd: undefined, allowedCwdRoots: [] })
    expect(() => resolveSessionCwd(def, undefined, realpath)).toThrow(/no default cwd/)
    expect(resolveSessionCwd(def, '/elsewhere', realpath, ['/elsewhere'])).toBe('/elsewhere')
  })
})

describe('resolveFsPath', () => {
  /** realpath that mimics the filesystem: /ws exists (with a symlink to /etc), deeper paths must already exist. */
  const realpath = (p: string): string => {
    if (p === '/' || p === '/ws' || p === '/ws/existing' || p === '/ws/link') {
      return p === '/ws/link' ? '/etc' : p
    }
    throw new Error(`realpath: ENOENT ${p}`)
  }

  it('accepts absolute and relative paths inside the workspace', () => {
    expect(resolveFsPath('/ws', ['/ws'], '/ws/existing', realpath)).toBe('/ws/existing')
    expect(resolveFsPath('/ws', ['/ws'], 'existing', realpath)).toBe('/ws/existing')
  })
  it('canonicalizes a fresh write target through its nearest existing ancestor', () => {
    expect(resolveFsPath('/ws', ['/ws'], '/ws/a/b/c/new.txt', realpath)).toBe('/ws/a/b/c/new.txt')
    expect(resolveFsPath('/ws', ['/ws'], 'sub/./x/../new.txt', realpath)).toBe('/ws/sub/new.txt')
  })
  it('rejects escapes via .., symlinks, and out-of-root absolutes', () => {
    expect(() => resolveFsPath('/ws', ['/ws'], '/ws/../../etc/passwd', realpath)).toThrow(/outside/)
    expect(() => resolveFsPath('/ws', ['/ws'], '/ws/link/passwd', realpath)).toThrow(/outside/)
    expect(() => resolveFsPath('/ws', ['/ws'], '/etc/passwd', realpath)).toThrow(/outside/)
    expect(() => resolveFsPath('/ws', ['/other'], 'file.txt', realpath)).toThrow(/outside/)
  })
  it('guards prefix confusion and empty paths', () => {
    expect(() => resolveFsPath('/ws', ['/ws'], '/ws2/file.txt', realpath)).toThrow(/outside/)
    expect(() => resolveFsPath('/ws', ['/ws'], '', realpath)).toThrow(/non-empty/)
  })
})

describe('cross-platform paths (Windows)', () => {
  // Mimics a Windows realpath: drive root and configured dirs exist, deeper
  // paths must already exist, and the disk answers in `\`-separated form with
  // on-disk casing (here: different from the request where it matters).
  const winRealpath = (p: string): string => {
    if (p === 'C:/' || p === 'C:\\') return 'C:\\'
    if (p === 'C:/ws' || p === 'C:\\ws') return 'C:\\WS'
    if (p === 'C:/ws/existing' || p === 'C:\\ws\\existing') return 'C:\\ws\\existing'
    if (p === 'C:/ws/link' || p === 'C:\\ws\\link') return 'C:\\etc'
    if (p === 'C:/etc/via/link') return 'C:\\etc'
    if (p === 'C:/ws/existing/../../Windows') return 'C:\\Windows'
    if (p === 'D:/other' || p === 'D:\\other') return 'D:\\other'
    if (p === '//srv/share' || p === '\\\\srv\\share' || p === '//srv/share/') return '\\\\srv\\share'
    if (p === '//srv/share/proj/file.txt') return '\\\\srv\\share\\proj\\file.txt'
    if (p === '//srv/other/') return '\\\\srv\\other'
    throw new Error(`realpath: ENOENT ${p}`)
  }

  it('validateAgentDef accepts drive, forward-slash, and UNC forms', () => {
    const def = validateAgentDef({ id: 'win', command: 'x', cwd: 'C:\\Users\\me\\proj', allowedCwdRoots: ['C:/Users/me', 'D:\\data'] })
    expect(def.cwd).toBe('C:\\Users\\me\\proj')
    expect(def.allowedCwdRoots).toEqual(['C:/Users/me', 'D:\\data'])
    expect(() => validateAgentDef({ id: 'win', command: 'x', cwd: '\\\\srv\\share' })).not.toThrow()
  })
  it('validateAgentDef rejects drive-relative and plain-relative paths', () => {
    expect(() => validateAgentDef({ id: 'win', command: 'x', cwd: 'C:Users' })).toThrow(/absolute/)
    expect(() => validateAgentDef({ id: 'win', command: 'x', cwd: 'foo\\bar' })).toThrow(/absolute/)
    expect(() => validateAgentDef({ id: 'win', command: 'x', allowedCwdRoots: ['C:/ok', 'relative'] })).toThrow(/absolute/)
  })

  it('isUnderPath folds separators and case for win32-style paths only', () => {
    expect(isUnderPath('C:/WS/sub/x.txt', 'c:\\ws')).toBe(true)
    expect(isUnderPath('C:\\work2\\x', 'C:/work')).toBe(false)
    expect(isUnderPath('C:/x', 'C:/')).toBe(true)
    // POSIX keeps case sensitivity and the old prefix guard.
    expect(isUnderPath('/WORK/x', '/work')).toBe(false)
    expect(isUnderPath('/work/x', '/work/')).toBe(true)
    expect(isUnderPath('/work2/x', '/work')).toBe(false)
    expect(isUnderPath('/anything', '/')).toBe(true)
    // A non-absolute root contains nothing.
    expect(isUnderPath('/work/x', 'relative')).toBe(false)
  })

  it('resolveSessionCwd accepts a Windows def and answers in folded /-form', () => {
    const def = agentDef({ cwd: 'C:\\ws', allowedCwdRoots: ['C:/ws'] })
    expect(resolveSessionCwd(def, undefined, winRealpath)).toBe('C:/WS')
    expect(resolveSessionCwd(def, 'C:/ws/existing', winRealpath)).toBe('C:/ws/existing')
    expect(resolveSessionCwd(def, 'C:\\ws\\existing', winRealpath)).toBe('C:/ws/existing')
    expect(() => resolveSessionCwd(def, 'C:/etc/via/link', winRealpath)).toThrow(/outside/)
  })
  it('resolveSessionCwd trusts Windows-style extra roots for the session', () => {
    const def = agentDef({ cwd: 'C:\\ws', allowedCwdRoots: ['C:/ws'] })
    expect(resolveSessionCwd(def, 'D:\\other', winRealpath, ['D:/other'])).toBe('D:/other')
    expect(() => resolveSessionCwd(def, 'C:/ws/existing/../../Windows', winRealpath)).toThrow(/outside/)
  })
  it('resolveSessionCwd still rejects relative candidates on Windows', () => {
    const def = agentDef({ cwd: 'C:\\ws', allowedCwdRoots: ['C:/ws'] })
    expect(() => resolveSessionCwd(def, 'C:relative', winRealpath)).toThrow(/absolute/)
  })

  it('resolveFsPath joins relative requests under a drive-letter workspace', () => {
    const roots = ['C:\\ws']
    // The disk answers with its own casing (C:\WS); fresh tails keep the
    // request's spelling on top of the resolved ancestor — real Windows behavior.
    expect(resolveFsPath('C:/ws', roots, 'existing', winRealpath)).toBe('C:/ws/existing')
    expect(resolveFsPath('C:/ws', roots, 'sub/./x/../new.txt', winRealpath)).toBe('C:/WS/sub/new.txt')
    expect(resolveFsPath('C:/ws', roots, 'sub\\back.txt', winRealpath)).toBe('C:/WS/sub/back.txt')
  })
  it('resolveFsPath keeps an absolute drive request in its own head', () => {
    expect(resolveFsPath('C:/ws', ['C:/ws'], 'C:\\ws\\existing', winRealpath)).toBe('C:/ws/existing')
  })
  it('resolveFsPath canonicalizes a fresh write target through the existing ancestor', () => {
    expect(resolveFsPath('C:/ws', ['C:/ws'], 'a/b/c/new.txt', winRealpath)).toBe('C:/WS/a/b/c/new.txt')
  })
  it('resolveFsPath rejects escapes, symlinks, prefix confusion, and extended-length forms', () => {
    expect(() => resolveFsPath('C:/ws', ['C:/ws'], '..\\..\\Windows\\x', winRealpath)).toThrow(/outside/)
    expect(() => resolveFsPath('C:/ws', ['C:/ws'], 'C:/ws/link/x', winRealpath)).toThrow(/outside/)
    expect(() => resolveFsPath('C:/ws', ['C:/ws'], 'C:/ws2/file.txt', winRealpath)).toThrow(/outside/)
    expect(() => resolveFsPath('C:/ws', ['C:/ws'], '\\\\srv\\share\\file.txt', winRealpath)).toThrow(/outside/)
    expect(() => canonicalizeFsPath('C:/ws', '\\\\?\\C:\\ws\\x', winRealpath)).toThrow(/cannot resolve/)
  })
  it('resolveFsPath contains a UNC workspace under its share root', () => {
    expect(resolveFsPath('//srv/share/proj', ['//srv/share'], 'file.txt', winRealpath)).toBe('//srv/share/proj/file.txt')
    expect(() => resolveFsPath('//srv/share/proj', ['\\\\srv\\share'], '//srv/other/file.txt', winRealpath)).toThrow(/outside/)
    // The disk hands back its own casing (shares are often stored upper-case) and
    // `foldSeparators` returns it as `//SRV/SHARE/…`: the containment must still
    // fold case after that normalization, or every UNC workspace denies.
    const upperRealpath = (p: string): string => {
      if (p === '//srv/share/proj/file.txt') return '\\\\SRV\\SHARE\\proj\\file.txt'
      throw new Error(`realpath: ENOENT ${p}`)
    }
    expect(resolveFsPath('//srv/share/proj', ['\\\\srv\\share'], 'file.txt', upperRealpath)).toBe('//SRV/SHARE/proj/file.txt')
  })

  it('folds UNC case under both separator spellings and keeps POSIX byte-exact', () => {
    expect(isUnderPath('\\\\SRV\\SHARE\\x', '\\\\srv\\share')).toBe(true)
    expect(isUnderPath('//SRV/SHARE/x', '\\\\srv\\share')).toBe(true)
    expect(isUnderPath('\\\\SRV\\SHARE\\x', '//srv/share')).toBe(true)
    expect(isUnderPath('//srv/other/x', '\\\\srv\\share')).toBe(false)
    // A POSIX backslash is a filename character, never a separator.
    expect(isUnderPath('/work/a\\b', '/work/a')).toBe(false)
    expect(isUnderPath('/WORK/x', '/work')).toBe(false)
  })

  it('scopes a `/` root to POSIX-form paths', () => {
    expect(isUnderPath('/anything', '/')).toBe(true)
    // One filesystem tree, not every drive and share the plugin can see.
    expect(isUnderPath('C:/x', '/')).toBe(false)
    expect(isUnderPath('\\\\srv\\share\\x', '/')).toBe(false)
  })

  it('answers a bare-root request with an absolute spelling', () => {
    const echo = (p: string): string => p
    expect(canonicalizeFsPath('/ws', '/', echo)).toBe('/')
    expect(canonicalizeFsPath('/ws', '..', echo)).toBe('/')
    expect(canonicalizeFsPath('C:/ws', 'C:\\', winRealpath)).toBe('C:/')
    expect(isUnderPath(canonicalizeFsPath('/ws', '/', echo), '/')).toBe(true)
  })

  it('rejects the extended-length form in config and in requests', () => {
    expect(isAbsolutePath('\\\\?\\C:\\ws')).toBe(false)
    expect(() => validateAgentDef({ id: 'win', command: 'x', cwd: '\\\\?\\C:\\ws' })).toThrow(/absolute/)
    expect(() => validateAgentDef({ id: 'win', command: 'x', allowedCwdRoots: ['\\\\?\\C:\\ws'] })).toThrow(/absolute/)
    expect(() => resolveFsPath('C:/ws', ['C:/ws'], '\\\\?\\C:\\ws\\x', winRealpath)).toThrow(/cannot resolve/)
    expect(() => resolveFsPath('C:/ws', ['C:/ws'], '//?/C:/ws/x', winRealpath)).toThrow(/cannot resolve/)
  })

  it('blames the unjudgeable FORM, not a missing file, when realpath says everything exists', () => {
    // A realpath that resolves ANY path: so the only reason these two forms are
    // refused is that this layer cannot address them — the error must say that,
    // not the false "does not exist".
    const allExist = (p: string): string => p
    // Extended-length / verbatim head (`\\?\…`, `//?/…`).
    expect(() => canonicalizeFsPath('C:/ws', '\\\\?\\C:\\ws\\file.txt', allExist)).toThrow(/cannot resolve/)
    expect(() => canonicalizeFsPath('C:/ws', '//?/C:/ws/file.txt', allExist)).toThrow(/cannot resolve/)
    // Share-less UNC head (`\\host`, `//host`): host but no share, so segmentize
    // returns undefined and the path is unaddressable — again not "does not exist".
    expect(() => canonicalizeFsPath('C:/ws', '\\\\host', allExist)).toThrow(/cannot resolve/)
    expect(() => canonicalizeFsPath('C:/ws', '//host', allExist)).toThrow(/cannot resolve/)
    // A genuinely absent path still reports the honest "does not exist".
    const nothing = (): string => { throw new Error('ENOENT') }
    expect(() => canonicalizeFsPath('C:/ws', 'C:\\ws\\gone.txt', nothing)).toThrow(/does not exist/)
  })

  it('folds a Windows workspace root against declared locations (the surviving containment)', () => {
    // This used to prove `decidePermission`'s arithmetic. The decision layer is
    // retired; what remains is the containment primitive the workspace fence is
    // built on, and it must keep folding separators and case the same way.
    expect(isUnderPath('C:\\proj\\a.txt', 'C:/proj')).toBe(true)
    expect(isUnderPath('D:\\proj\\a.txt', 'C:/proj')).toBe(false)
    // A path can be inside a root spelled with either separator on either side.
    expect(isUnderPath('C:/proj/sub/b.ts', 'C:\\proj')).toBe(true)
  })
})
