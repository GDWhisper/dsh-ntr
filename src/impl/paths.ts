/**
 * Cross-platform path primitives: absolute-path judgement, containment and canonicalization.
 *
 * Style is judged by the string head only; win32 folds separators and case, POSIX stays byte-exact. The browser mirrors `isAbsolutePath` as `isAbsolutePathLike`.
 *
 * Part of the host-half logic; the barrel is `src/impl.ts` and every existing
 * `../impl.ts` import keeps resolving through it. Pure logic only — no Node
 * APIs, no ACP SDK runtime values.
 */

import type { AcpAgentDef } from '../protocol.ts'
import { AcpError } from './errors.ts'

// ---- Workspace guard ----

/**
 * Win32 drive head: `C:\…` or `C:/…`. Extended-length (`\\?\C:\…`) paths are
 * deliberately NOT matched here — see {@link isExtendedLength}.
 */
const WIN32_DRIVE = /^[A-Za-z]:[\\/]/

/**
 * Extended-length (`\\?\…`) / verbatim (`//?/…`) head under either separator
 * spelling. {@link segmentize} does not interpret these forms, and the workspace
 * guard refuses them explicitly rather than mis-parsing a containment — so they
 * are not absolute paths this layer accepts either: config validation rejects a
 * cwd written that way instead of storing one that could never resolve.
 */
function isExtendedLength(p: string): boolean {
  return p.startsWith('\\\\?\\') || p.startsWith('//?/')
}

/**
 * Whether `p` is an absolute path on some platform this plugin runs on: POSIX
 * (`/…`), a Windows drive path (`C:\…`, `C:/…`), or a UNC path
 * (`\\host\share…`, `//host/share…`). The extended-length `\\?\…` family is
 * deliberately NOT absolute here — see {@link isExtendedLength}.
 *
 * Style is judged by the string head only, never deeper content: on POSIX both
 * `\` and `C:` are legal filename characters, so a look past the head would
 * misclassify legitimate POSIX paths.
 *
 * This is the host half of the check; the browser's form validation mirrors it
 * as `isAbsolutePathLike` (src/client/acp-ui.tsx) — keep the two in agreement
 * (tests/acp-view.spec.ts asserts equivalence on a shared sample set).
 */
export function isAbsolutePath(p: string): boolean {
  if (isExtendedLength(p)) return false
  return p.startsWith('/') || WIN32_DRIVE.test(p) || p.startsWith('\\\\')
}

/**
 * Whether `p` is written in a Windows style: a drive head (`C:…`), or a UNC head
 * under EITHER separator spelling (`\\host\share`, `//host/share`).
 *
 * The forward-slash spelling counts because {@link foldSeparators} hands every
 * disk-derived UNC path back in that form: judging style by the separator alone
 * would drop the case folding exactly where it is needed, so `\\SRV\share` and
 * `//SRV/share` would stop matching a configured `\\srv\share` ({@link segmentize}
 * already reads `//host/share` as UNC, and this keeps the two in agreement).
 */
function isWin32Style(p: string): boolean {
  return p.startsWith('\\\\') || p.startsWith('//') || /^[A-Za-z]:/.test(p)
}

/**
 * Comparison form of a path: separators folded (`\` → `/`) and case dropped for
 * win32-style paths, POSIX paths kept byte-exact (a `\` or mixed case is a
 * legitimate filename there). Trailing separators dropped.
 */
function compareForm(p: string): string {
  const win32 = isWin32Style(p)
  // A POSIX backslash is a filename character, not a separator: folding it there
  // would let `/work/a\b` pass as a child of `/work/a`.
  const folded = win32 ? p.replaceAll('\\', '/').replace(/\/+$/, '') : p.replace(/\/+$/, '')
  return win32 ? folded.toLowerCase() : folded
}

/** Fold a realpath (or any disk-derived path) into this layer's canonical spelling: `\` → `/` for win32-style paths. */
function foldSeparators(p: string): string {
  return isWin32Style(p) ? p.replaceAll('\\', '/') : p
}

/** One parsed absolute path: its immutable head (`/`, `C:`, `//host/share`) and the segments under it. */
interface SegmentedPath {
  head: string
  /** Whether the head came from a Windows-style path (drive or UNC) — the fold rule for relative tails. */
  win32: boolean
  segments: string[]
}

/**
 * Split an absolute path into head + segments, folding `\` for Windows-style
 * paths. Returns `undefined` for relative input and for forms this layer does
 * not interpret — extended-length `\\?\…` heads (an agent sending one gets an
 * explicit denial rather than a silently mis-parsed containment).
 */
function segmentize(p: string): SegmentedPath | undefined {
  const drive = /^[A-Za-z]:/.exec(p)
  if (drive !== null) {
    return { head: drive[0], win32: true, segments: p.slice(2).replaceAll('\\', '/').split('/').filter(s => s !== '') }
  }
  if (p.startsWith('//') || p.startsWith('\\\\')) {
    if (p.startsWith('\\\\?\\') || p.startsWith('//?/')) return undefined
    const segments = p.slice(2).replaceAll('\\', '/').split('/').filter(s => s !== '')
    // A UNC path needs both the host and the share before anything under it is addressable.
    if (segments.length < 2) return undefined
    return { head: `//${segments[0]}/${segments[1]}`, win32: true, segments: segments.slice(2) }
  }
  if (p.startsWith('/')) {
    return { head: '/', win32: false, segments: p.split('/').filter(s => s !== '') }
  }
  return undefined
}

/** Lexical `.`/`..`/empty-segment collapse; `..` at a root stays at the root (containment judges the result). */
function collapseSegments(segments: string[]): string[] {
  const stack: string[] = []
  for (const seg of segments) {
    if (seg === '.' || seg === '') continue
    if (seg === '..') stack.pop()
    else stack.push(seg)
  }
  return stack
}

/** The deepest probeable root of a parsed path: `/`, `C:/`, or `//host/share/`. */
function rootForm(parsed: SegmentedPath): string {
  return parsed.head === '/' ? '/' : `${parsed.head}/`
}

/** Rebuild an absolute path from a parsed head and segments (empty segments yield the root form). */
function unsegmentize(parsed: SegmentedPath, segments: string[]): string {
  if (segments.length === 0) return rootForm(parsed)
  // The POSIX head is itself the root slash; a drive/UNC head needs the joiner.
  return parsed.head === '/' ? `/${segments.join('/')}` : `${parsed.head}/${segments.join('/')}`
}

/**
 * Pure path join with lexical `..`/`.` collapse (impl.ts cannot import node:path).
 * The base's head is preserved; a relative tail folds `\` into separators only
 * when the base is Windows-style — a POSIX base keeps `\` as a literal
 * filename character.
 */
function joinWithin(base: string, rel: string): string {
  const parsed = segmentize(base)
  if (parsed === undefined) {
    // Defensive: every caller passes a canonical absolute base.
    return `/${collapseSegments(`${base}/${rel}`.split('/')).join('/')}`
  }
  const folded = parsed.win32 ? rel.replaceAll('\\', '/') : rel
  return unsegmentize(parsed, collapseSegments([...parsed.segments, ...folded.split('/')]))
}

/**
 * Resolve the requested session cwd against the agent's allowed roots.
 * @param def - validated agent definition.
 * @param requested - browser-supplied cwd (optional; `''`/undefined → default).
 * @param realpath - platform realpath (injected; throws if the path is unusable).
 * @param extraRoots - roots trusted on top of the agent's own ones, for THIS
 *   session only. The one caller that matters is a chat session, whose cwd is
 *   the workspace the user picked in the DSH sidebar: that directory is never in
 *   the agent's configured allow-list (the plugin's own sandbox dir is), yet it
 *   is the session's declared workspace — the root the fs guard confines reads
 *   and writes to. `/acp`-RPC sessions pass none and keep `allowedCwdRoots` as
 *   a hard cap.
 * @returns the canonical absolute directory to hand to `session/new` (POSIX
 *   spelling on Windows too: `\` folded to `/`).
 */
export function resolveSessionCwd(def: AcpAgentDef, requested: string | undefined, realpath: (p: string) => string, extraRoots: readonly string[] = []): string {
  const candidate = requested === undefined || requested === '' ? def.cwd : requested
  if (candidate === undefined) throw new AcpError('no_cwd', `acp: agent "${def.id}" has no default cwd; pass one`)
  if (!isAbsolutePath(candidate)) throw new AcpError('bad_cwd', 'acp: session cwd must be absolute')
  let canonical: string
  try {
    canonical = foldSeparators(realpath(candidate))
  } catch {
    throw new AcpError('bad_cwd', `acp: cwd does not exist: ${candidate}`)
  }
  const configured = (def.allowedCwdRoots ?? []).length > 0 ? (def.allowedCwdRoots ?? []) : (def.cwd !== undefined ? [def.cwd] : [])
  const roots = [...configured, ...extraRoots.filter(root => typeof root === 'string' && isAbsolutePath(root))]
  if (roots.length === 0) throw new AcpError('no_roots', `acp: agent "${def.id}" has no allowedCwdRoots configured`)
  const inside = roots.some(root => isUnderPath(canonical, safeRealpath(realpath, root)))
  if (!inside) throw new AcpError('cwd_denied', `acp: cwd ${canonical} is outside agent "${def.id}" allowed roots`)
  return canonical
}

function safeRealpath(realpath: (p: string) => string, p: string): string {
  try {
    return realpath(p)
  } catch {
    return p
  }
}

/**
 * Canonicalize a path requested by an ACP agent (fs/read_text_file,
 * fs/write_text_file) against the session workspace — no containment check.
 *
 * Relative paths join under `sessionCwd`; the collapsed path is canonicalized
 * by realpath up to the nearest existing ancestor (collapsing symlinks and any
 * surviving `..`), with the missing tail re-attached lexically — so a fresh
 * write target with not-yet-created parent directories still validates, and a
 * symlink pointing outside the workspace resolves to its real location (where
 * the containment check then judges it).
 *
 * Windows spellings work throughout: an absolute drive/UNC request keeps its
 * own head, a relative request folds `\` when the session cwd is
 * Windows-style, and the result comes back in the folded `/`-separated form.
 */
export function canonicalizeFsPath(sessionCwd: string, requested: string, realpath: (p: string) => string): string {
  if (typeof requested !== 'string' || requested === '') {
    throw new AcpError('bad_path', 'acp: fs path must be a non-empty string')
  }
  if (isExtendedLength(requested)) {
    // Refused before the relative-join branch can swallow it as a filename: a
    // verbatim path is a form this layer cannot judge, not a path under the cwd.
    // Say so — "does not exist" is a lie when the file is right there.
    throw new AcpError('bad_path', `acp: fs path is a form this layer cannot resolve: ${requested}`)
  }
  const collapsed = isAbsolutePath(requested) ? requested : joinWithin(sessionCwd, requested)
  const parsed = segmentize(collapsed)
  if (parsed === undefined) {
    // segmentize returns undefined for a form it does not interpret — chiefly a
    // UNC head missing its share (`\\host`). Not "does not exist": the target may
    // resolve fine; this layer just cannot address it.
    throw new AcpError('bad_path', `acp: fs path is a form this layer cannot resolve: ${requested}`)
  }
  const segments = collapseSegments(parsed.segments)
  let canonical: string | undefined
  let consumed = 0
  for (let i = segments.length; i >= 0; i--) {
    try {
      canonical = realpath(unsegmentize(parsed, segments.slice(0, i)))
      consumed = i
      break
    } catch { /* walk up to the nearest existing ancestor */ }
  }
  if (canonical === undefined) {
    throw new AcpError('bad_path', `acp: fs path does not exist: ${requested}`)
  }
  const base = foldSeparators(canonical).replace(/\/+$/, '')
  const tail = segments.slice(consumed)
  if (tail.length === 0) {
    // The strip above eats the separator that belongs to a bare root (`/` → ``,
    // `C:\` → `C:`): answer the root's own spelling instead of a value that is no
    // longer absolute.
    return base === '' || base === parsed.head ? rootForm(parsed) : base
  }
  return `${base}/${tail.join('/')}`
}

/**
 * {@link canonicalizeFsPath} plus the allowed-root containment check: a path
 * outside the given `roots` throws (`cwd_denied`) and the caller answers the
 * agent's request with that error instead of touching the disk.
 *
 * The containment is UNCONDITIONAL — there is deliberately no access-mode layer
 * here. The one caller (`guardFsPath` in src/bridge.ts) always passes the
 * agent's own `allowedCwdRoots` plus the session cwd as a hard cap; a DSH
 * access mode such as `danger-full-access` never reaches this path and never
 * lifts the cap.
 */
export function resolveFsPath(sessionCwd: string, roots: readonly string[], requested: string, realpath: (p: string) => string): string {
  const full = canonicalizeFsPath(sessionCwd, requested, realpath)
  const inside = roots.some(root => isUnderPath(full, safeRealpath(realpath, root)))
  if (!inside) throw new AcpError('cwd_denied', `acp: fs path ${full} is outside the session workspace`)
  return full
}

/**
 * Lexical containment test: does `path` equal or live under `root`?
 *
 * Both sides go through the compare form (win32-style paths get `\` folded to
 * `/` and case dropped; POSIX stays byte-exact), so a disk-derived canonical
 * path compares against a configured root regardless of which spelling each
 * arrived in — `C:\work` and `\\host\share` contain their `c:/work/…` and
 * `//host/share/…` children, while `/work2` still does not pass under `/work`
 * anywhere. A root of `/` contains every POSIX absolute path and nothing
 * Windows-shaped; any other non-absolute root contains nothing.
 */
export function isUnderPath(path: string, root: string): boolean {
  if (!isAbsolutePath(root)) return false
  const trimmedRoot = compareForm(root)
  const trimmedPath = compareForm(path)
  // A root that strips down to nothing IS the POSIX root: it spans one
  // filesystem tree, not every drive and share this plugin can see. `path` (not
  // the trimmed form) decides, because the trim also empties a path of `/` itself.
  if (trimmedRoot === '') return path.startsWith('/') && !isWin32Style(path)
  return trimmedPath === trimmedRoot || trimmedPath.startsWith(`${trimmedRoot}/`)
}
