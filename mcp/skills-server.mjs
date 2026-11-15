/**
 * dsh-skills — the read-only, zero-dependency MCP server dsh-ntr hands to ACP
 * agents (see docs/plan/dsh-skills-mcp.md §8).
 *
 * WHAT IT IS: one stdio process exposing exactly two tools — `skills_list`
 * (enumerate the DSH skills on this machine) and `skill_read` (read one skill's
 * `SKILL.md` or a file inside that skill's directory). There is no write, edit,
 * delete or execution surface, no MCP SDK, no YAML library, and no third-party
 * dependency at all: Node builtins only, so `process.execPath` can always launch
 * it without an install step.
 *
 * LAZY MEANS FILE SYSTEM WORK, NOT THE PROCESS: `initialize`,
 * `notifications/initialized`, `ping` and the static `tools/list` never touch
 * the skills root — the first `skills_list` enumerates it, and `skill_read`
 * resolves only its own target. There is no watcher, no timer and no persistent
 * skill cache; every call re-reads the current disk, so added/removed skills and
 * edited text show up on the next call. What this server CANNOT promise is when
 * the agent starts or reaps the process: the agent is the MCP client and owns
 * that lifecycle (AGENTS/protocol.md).
 *
 * TRANSPORT: newline-delimited JSON-RPC 2.0 over stdio. stdout carries exactly
 * one JSON-RPC message per line and nothing else; every diagnostic goes to
 * stderr. stdin EOF ends the process.
 *
 * MODULE SHAPE: every security- and parsing-relevant primitive (containment,
 * absolute-path judgement, frontmatter extraction, bounded reads, the skill-name
 * predicate) is exported so tests can drive it directly; the stdio loop starts
 * only when this file IS the entry point (`import.meta.url` and `process.argv[1]`
 * realpath to the same file), never on import.
 *
 * PATH JUDGEMENT IS A HAND COPY: this server cannot import `src/impl/paths.ts`
 * (it must run from an installed package with no build step), so `isAbsolutePath`
 * and `isUnderPath` below mirror the host primitives character for character
 * (constraint 24). `tests/skills-server.spec.ts` asserts the two implementations
 * answer identically on a shared input set — that equivalence test is what keeps
 * the copy honest, so do not "improve" either side alone.
 */

import { closeSync, openSync, readFileSync, readdirSync, readSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import { StringDecoder } from 'node:string_decoder'
import { fileURLToPath } from 'node:url'

// ---- Fixed constants (no user configuration: docs/plan/dsh-skills-mcp.md §8) ----

export const SERVER_NAME = 'dsh-skills'

/** MCP protocol revisions this server can answer; the first entry is the newest. */
export const SUPPORTED_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05']

/** The file every skill directory must contain. */
export const SKILL_FILE = 'SKILL.md'

/**
 * One directory segment, shared by `skills_list` and `skill_read` — the two must
 * never disagree, or a skill would be listed and then unreadable (§8.2/§8.3).
 */
export const SKILL_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

export const DEFAULT_MAX_LINES = 400
export const MIN_MAX_LINES = 1
export const MAX_MAX_LINES = 2000

/** Hard ceiling for one tool result's text, truncation marker included. */
export const MAX_OUTPUT_CHARS = 120000

/** Listing caps: entries, one description, and the marker reserve of the serialized array. */
export const MAX_LISTED_SKILLS = 200
export const MAX_DESCRIPTION_CHARS = 1000
const LIST_MARKER_RESERVE = 64
const DESCRIPTION_ELLIPSIS = '…'

/**
 * How much of a `SKILL.md` the frontmatter extraction may read, in BYTES and in
 * lines — first of the two wins (see {@link readBoundedText}, which spends the
 * byte budget exactly).
 */
export const FRONTMATTER_MAX_BYTES = 64 * 1024
export const FRONTMATTER_MAX_LINES = 200

/** Bytes per `read(2)` in {@link readBoundedText}; the only over-read a limit can cause. */
const READ_CHUNK_BYTES = 64 * 1024

const PARSE_ERROR = -32700
const INVALID_REQUEST = -32600
const METHOD_NOT_FOUND = -32601
const INVALID_PARAMS = -32602
const INTERNAL_ERROR = -32603

// ---- Cross-platform path primitives (hand copy of src/impl/paths.ts) ----

/**
 * Win32 drive head: `C:\…` or `C:/…`. Extended-length (`\\?\C:\…`) is
 * deliberately NOT matched — see {@link isExtendedLength}.
 */
const WIN32_DRIVE = /^[A-Za-z]:[\\/]/

/** Extended-length (`\\?\…`) / verbatim (`//?/…`) head under either separator spelling. */
function isExtendedLength(path) {
  return path.startsWith('\\\\?\\') || path.startsWith('//?/')
}

/**
 * Whether `path` is absolute on some platform this plugin runs on: POSIX
 * (`/…`), a Windows drive path (`C:\…`, `C:/…`) or a UNC path
 * (`\\host\share…`, `//host/share…`). `\\?\…` is NOT absolute here — the host
 * layer refuses that form outright rather than mis-parsing it.
 */
export function isAbsolutePath(path) {
  if (typeof path !== 'string' || path === '') return false
  if (isExtendedLength(path)) return false
  return path.startsWith('/') || WIN32_DRIVE.test(path) || path.startsWith('\\\\')
}

/** Whether `path` is written in a Windows style: a drive head, or a UNC head under either separator spelling. */
function isWin32Style(path) {
  return path.startsWith('\\\\') || path.startsWith('//') || /^[A-Za-z]:/.test(path)
}

/**
 * Comparison form: separators folded (`\` → `/`) and case dropped for
 * win32-style paths, POSIX paths kept byte-exact (there a `\` or a mixed case is
 * a legitimate filename character). Trailing separators dropped.
 */
function compareForm(path) {
  const win32 = isWin32Style(path)
  const folded = win32 ? path.replaceAll('\\', '/').replace(/\/+$/, '') : path.replace(/\/+$/, '')
  return win32 ? folded.toLowerCase() : folded
}

/**
 * Lexical containment: does `path` equal or live under `root`?
 *
 * Never a string prefix test: `/work2` does not pass under `/work`, and neither
 * does `C:\work2` under `C:/work`. A root of `/` contains every POSIX absolute
 * path and nothing Windows-shaped; any other non-absolute root contains nothing.
 */
export function isUnderPath(path, root) {
  if (typeof path !== 'string' || typeof root !== 'string') return false
  if (!isAbsolutePath(root)) return false
  const trimmedRoot = compareForm(root)
  const trimmedPath = compareForm(path)
  if (trimmedRoot === '') return path.startsWith('/') && !isWin32Style(path)
  return trimmedPath === trimmedRoot || trimmedPath.startsWith(`${trimmedRoot}/`)
}

// ---- Skill root (same rule as pluginStateDir(), implemented independently) ----

/** `DSH_NTR_STATE_DIR` when non-empty, else `~/.dsh/dsh-ntr` — the host's `pluginStateDir()` rule. */
export function stateDirOf(env = process.env, home = homedir()) {
  const override = env.DSH_NTR_STATE_DIR
  if (typeof override === 'string' && override !== '') return override
  return join(home, '.dsh', 'dsh-ntr')
}

/**
 * The fixed skills root: `dirname(stateDir) / skills` — in a default deployment
 * the host's own `~/.dsh/skills`. There is no `skillsRoot` setting on purpose.
 */
export function skillsRoot(env = process.env, home = homedir()) {
  return join(dirname(stateDirOf(env, home)), 'skills')
}

// ---- Frontmatter (semantics aligned with src/impl/skills.ts) ----

/** Strip one PAIR of matching quotes from a frontmatter value, then trim again. */
export function stripFrontmatterQuotes(value) {
  const trimmed = value.trim()
  const paired = trimmed.length >= 2
    && ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'")))
  return paired ? trimmed.slice(1, -1).trim() : trimmed
}

const FRONTMATTER_KEY = /^([A-Za-z0-9_.-]+):\s*(.*)$/

/**
 * The top-level `description` of a `SKILL.md`, or `''`.
 *
 * Same accepted shape as the host's `parseSkillFrontmatter` — BOM tolerated, the
 * opening `---` must be the very first line, CRLF or LF, `#` comments and blank
 * lines skipped, ONE nesting level under `metadata:` (nested keys are not
 * `description`), paired quotes stripped, empty values dropped, last top-level
 * value wins. Unlike the host parser this never throws: a malformed, unclosed or
 * absent block means "no description" (`''`), and the skill is still listable —
 * one broken file must not hide a skill.
 */
export function skillDescriptionFromFrontmatter(text) {
  const withoutBom = text.startsWith('\uFEFF') ? text.slice(1) : text
  const openCrlf = withoutBom.startsWith('---\r\n')
  if (!openCrlf && !withoutBom.startsWith('---\n')) return ''
  const body = withoutBom.slice(4)
  if (/^---(?:\r?\n|$)/.test(body)) return ''
  const close = /\r?\n---(?:\r?\n|$)/.exec(body)
  if (close === null) return ''
  let description = ''
  let metadataKey
  for (const line of body.slice(0, close.index).split(/\r?\n/)) {
    const content = line.trim()
    if (content === '' || content.startsWith('#')) continue
    const indented = /^\s/.test(line)
    if (metadataKey !== undefined && indented) {
      if (content.startsWith('- ')) continue
      if (FRONTMATTER_KEY.test(content) === false) return ''
      continue
    }
    metadataKey = undefined
    const top = FRONTMATTER_KEY.exec(content)
    if (top === null) return ''
    const value = stripFrontmatterQuotes(top[2])
    if (value === '') {
      if (top[1] === 'metadata') metadataKey = 'metadata'
      continue
    }
    if (top[1] === 'description') description = value
  }
  return description
}

// ---- Bounded reads ----

function countNewlines(text) {
  let count = 0
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === 10) count += 1
  }
  return count
}

/** Index just past the `n`-th `\n`, or `null` when the text holds fewer than `n` lines. */
function endOfNthLine(text, n) {
  let seen = 0
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) !== 10) continue
    seen += 1
    if (seen === n) return index + 1
  }
  return null
}

/** Apply both limits to already-read text; `lineLimited`/`charLimited` say whether anything was dropped. */
function clipToLimits(text, maxLines, maxChars) {
  let body = text
  const cut = endOfNthLine(body, maxLines)
  const lineLimited = cut !== null && cut < body.length
  if (lineLimited) body = body.slice(0, cut)
  const charLimited = body.length > maxChars
  if (charLimited) body = body.slice(0, maxChars)
  return { text: body, lineLimited, charLimited }
}

/**
 * Read at most `maxLines` lines / `maxChars` characters / `maxBytes` bytes from
 * a file.
 *
 * The file is consumed through a file descriptor in {@link READ_CHUNK_BYTES}
 * chunks and the loop stops as soon as a limit is exceeded — so the read cost is
 * the limit plus at most one chunk, never the file size, and a multi-gigabyte
 * file or a single unbounded line cannot be pulled into memory. `bytesRead` is
 * reported so tests can prove that bound instead of trusting a comment.
 *
 * `maxBytes` is a BYTE budget, spent exactly: each `read(2)` is capped at what
 * is left of it, so the file is never read past it. A limit expressed in the
 * name of bytes (`FRONTMATTER_MAX_BYTES`) must use this and not `maxChars`:
 * characters are code units, so a CJK- or emoji-heavy file would have been read
 * three or four times further than the cap says.
 */
export function readBoundedText(absPath, options = {}) {
  const maxLines = options.maxLines ?? Number.MAX_SAFE_INTEGER
  const maxChars = options.maxChars ?? Number.MAX_SAFE_INTEGER
  const maxBytes = options.maxBytes ?? Number.MAX_SAFE_INTEGER
  const fd = openSync(absPath, 'r')
  const decoder = new StringDecoder('utf8')
  const buffer = Buffer.allocUnsafe(READ_CHUNK_BYTES)
  let text = ''
  let bytesRead = 0
  let newlines = 0
  let stopped = false
  let reachedEof = false
  try {
    while (bytesRead < maxBytes) {
      const read = readSync(fd, buffer, 0, Math.min(buffer.length, maxBytes - bytesRead), null)
      if (read === 0) {
        reachedEof = true
        break
      }
      bytesRead += read
      const piece = decoder.write(read === buffer.length ? buffer : buffer.subarray(0, read))
      text += piece
      newlines += countNewlines(piece)
      if (newlines > maxLines || text.length > maxChars) {
        stopped = true
        break
      }
    }
    if (!stopped) text += decoder.end()
    // A file that ends exactly ON the budget is a complete read; telling that
    // apart from a cut costs one byte, not one chunk.
    if (!reachedEof && bytesRead >= maxBytes) reachedEof = readSync(fd, buffer, 0, 1, null) === 0
  } finally {
    closeSync(fd)
  }
  // `bytesLimited` means the BYTE budget cut the file short — an EOF right at
  // the budget read everything there was and is not a truncation.
  return { ...clipToLimits(text, maxLines, maxChars), bytesRead, bytesLimited: !reachedEof && bytesRead >= maxBytes }
}

/** The description carried by a `SKILL.md` head (bounded by {@link FRONTMATTER_MAX_BYTES} BYTES / {@link FRONTMATTER_MAX_LINES} lines). */
export function readFrontmatterDescription(absPath) {
  const head = readBoundedText(absPath, { maxLines: FRONTMATTER_MAX_LINES, maxBytes: FRONTMATTER_MAX_BYTES })
  return skillDescriptionFromFrontmatter(head.text)
}

/**
 * One `skill_read` body: the first `maxLines` lines, capped at
 * {@link MAX_OUTPUT_CHARS} characters INCLUDING an explicit truncation marker.
 * A marker is never silently omitted — a truncated answer that looks complete
 * would make the agent believe it read the whole file.
 */
export function readSkillOutput(absPath, maxLines = DEFAULT_MAX_LINES) {
  const read = readBoundedText(absPath, { maxLines, maxChars: MAX_OUTPUT_CHARS })
  const reasons = []
  if (read.lineLimited) reasons.push('line limit reached')
  if (read.charLimited) reasons.push('character limit reached')
  const marker = reasons.length === 0 ? '' : `\n\n… [truncated: ${reasons.join(', ')}]`
  const budget = MAX_OUTPUT_CHARS - marker.length
  const body = read.text.length > budget ? read.text.slice(0, budget) : read.text
  return `${body}${marker}`
}

/** One description, capped at {@link MAX_DESCRIPTION_CHARS} with a visible ellipsis. */
export function capDescription(description) {
  if (description.length <= MAX_DESCRIPTION_CHARS) return description
  return `${description.slice(0, MAX_DESCRIPTION_CHARS - DESCRIPTION_ELLIPSIS.length)}${DESCRIPTION_ELLIPSIS}`
}

// ---- Tool-level errors ----

/** A failure the agent must SEE as a failed tool call (`isError: true`), not a protocol error. */
class ToolError extends Error {}

/** A protocol-layer failure: JSON-RPC error response. */
class RpcError extends Error {
  constructor(code, message) {
    super(message)
    this.code = code
  }
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

function errorCodeOf(error) {
  return error !== null && typeof error === 'object' && typeof error.code === 'string' ? error.code : ''
}

/** Diagnostics and per-skill skips go to stderr only — stdout belongs to JSON-RPC. */
export function logStderr(message) {
  try {
    process.stderr.write(`${message}\n`)
  } catch { /* stderr gone: nothing left to report to */ }
}

// ---- Argument validation ----

/** The drive-relative form (`C:foo`) that {@link isAbsolutePath} does not catch. */
const DRIVE_HEAD = /^[A-Za-z]:/

/**
 * A `file` argument reduced to a clean relative path inside the skill directory,
 * or a {@link ToolError}. Refused: empty values, NUL bytes, extended-length
 * forms, POSIX/Windows absolute paths, drive-relative paths and any `..`
 * segment; `\` is folded so a mixed-separator traversal cannot slip through.
 */
export function normalizeSkillFile(value) {
  if (value === undefined) return SKILL_FILE
  if (typeof value !== 'string' || value === '') throw new ToolError('"file" must be a non-empty relative path')
  if (value.includes('\0')) throw new ToolError('"file" must not contain a NUL byte')
  if (isExtendedLength(value)) throw new ToolError(`"file" is a form this server cannot resolve: ${value}`)
  if (isAbsolutePath(value) || DRIVE_HEAD.test(value)) throw new ToolError(`"file" must stay inside the skill directory: ${value}`)
  const segments = value.replaceAll('\\', '/').split('/')
  if (segments.includes('..')) throw new ToolError(`"file" must not traverse outside the skill directory: ${value}`)
  const cleaned = segments.filter(segment => segment !== '' && segment !== '.')
  if (cleaned.length === 0) throw new ToolError('"file" must name a file inside the skill directory')
  return cleaned.join('/')
}

/** A `maxLines` argument as an integer in `[1, 2000]`, defaulting to 400. */
export function normalizeMaxLines(value) {
  if (value === undefined) return DEFAULT_MAX_LINES
  if (typeof value !== 'number' || !Number.isInteger(value)) throw new ToolError('"maxLines" must be an integer')
  if (value < MIN_MAX_LINES || value > MAX_MAX_LINES) {
    throw new ToolError(`"maxLines" must be between ${MIN_MAX_LINES} and ${MAX_MAX_LINES}`)
  }
  return value
}

function realpathOrThrow(path, reason) {
  try {
    return realpathSync(path)
  } catch {
    throw new ToolError(reason)
  }
}

function statOrThrow(path, reason) {
  try {
    return statSync(path)
  } catch {
    throw new ToolError(reason)
  }
}

/**
 * Resolve one skill directory and its `SKILL.md`, proving both stay inside the
 * (realpath'd) skills root. Both the skill directory and the target are
 * canonicalized first, so a symlink pointing outside the root resolves outside
 * and is refused, while a legitimate in-root symlink passes (constraint §8.4.6).
 */
function resolveSkillFile(rootReal, name) {
  const dir = realpathOrThrow(join(rootReal, name), 'skill directory is not readable')
  if (dir === rootReal || !isUnderPath(dir, rootReal)) throw new ToolError('skill directory resolves outside the skills root')
  if (!statOrThrow(dir, 'skill directory is not readable').isDirectory()) throw new ToolError('skill is not a directory')
  const target = realpathOrThrow(join(dir, SKILL_FILE), `${SKILL_FILE} is missing`)
  if (!isUnderPath(target, dir) || !isUnderPath(target, rootReal)) throw new ToolError(`${SKILL_FILE} resolves outside the skills root`)
  if (!statOrThrow(target, `${SKILL_FILE} is not readable`).isFile()) throw new ToolError(`${SKILL_FILE} is not a regular file`)
  return target
}

// ---- skills_list ----

/**
 * Enumerate the DIRECT children of the skills root: a directory is a skill only
 * when its name matches {@link SKILL_NAME_PATTERN} and it holds a readable
 * `SKILL.md`. Nothing recurses, so a nested `SKILL.md` never becomes a skill.
 * Every per-entry failure is one stderr line and one skipped entry; a missing
 * root is simply an empty list, never a fatal error.
 */
export function listSkills(options = {}) {
  const warn = options.warn ?? logStderr
  const root = options.root ?? skillsRoot()
  let entries
  try {
    entries = readdirSync(root, { withFileTypes: true })
  } catch (error) {
    if (errorCodeOf(error) !== 'ENOENT') warn(`dsh-skills: cannot read skills root ${root}: ${messageOf(error)}`)
    return []
  }
  const rootReal = realpathOrWarn(root, warn)
  if (rootReal === undefined) return []
  const skills = []
  for (const entry of entries) {
    const name = entry.name
    // Only directories (or links that may resolve to one) are candidates; a
    // stray file in the root is not a broken skill and gets no diagnostic.
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
    if (!SKILL_NAME_PATTERN.test(name)) {
      warn(`dsh-skills: skipping ${name}: name does not match the skill name pattern`)
      continue
    }
    let skillPath
    let description
    try {
      skillPath = resolveSkillFile(rootReal, name)
      description = readFrontmatterDescription(skillPath)
    } catch (error) {
      warn(`dsh-skills: skipping ${name}: ${messageOf(error)}`)
      continue
    }
    skills.push({ name, description: capDescription(description), path: skillPath })
  }
  skills.sort(compareSkillNames)
  return skills
}

/** `realpathSync` with a stderr note instead of a throw — the root vanished between readdir and here. */
function realpathOrWarn(path, warn) {
  try {
    return realpathSync(path)
  } catch (error) {
    warn(`dsh-skills: cannot resolve skills root ${path}: ${messageOf(error)}`)
    return undefined
  }
}

/** Stable, locale-independent order so a listing does not jitter between calls. */
function compareSkillNames(left, right) {
  if (left.name < right.name) return -1
  return left.name > right.name ? 1 : 0
}

/**
 * The `skills_list` tool result content: a JSON array of `{name, description,
 * path}` plus, when anything was cut, a SECOND text block carrying the marker —
 * the array itself stays parseable as JSON, which a marker element could not.
 * The sum of all blocks stays within {@link MAX_OUTPUT_CHARS}.
 */
export function buildSkillsContent(entries) {
  const parts = []
  let total = 2 // the enclosing `[` and `]`
  let omitted = 0
  const limit = Math.min(entries.length, MAX_LISTED_SKILLS)
  for (let index = 0; index < limit; index += 1) {
    const piece = JSON.stringify(entries[index])
    const added = parts.length === 0 ? piece.length : piece.length + 1
    if (total + added + LIST_MARKER_RESERVE > MAX_OUTPUT_CHARS) {
      omitted = entries.length - parts.length
      break
    }
    parts.push(piece)
    total += added
  }
  if (omitted === 0 && entries.length > parts.length) omitted = entries.length - parts.length
  const content = [{ type: 'text', text: `[${parts.join(',')}]` }]
  if (omitted > 0) content.push({ type: 'text', text: `… [truncated: ${omitted} more skills omitted]` })
  return content
}

// ---- skill_read ----

/**
 * Read one file of one skill. `name` must satisfy the SAME predicate
 * `skills_list` uses, so every listed skill is readable and nothing else is.
 * The target is canonicalized and containment-checked against both the skill
 * directory and the skills root before a single byte is read.
 */
export function readSkill(options = {}) {
  const { name, file, maxLines } = options
  if (typeof name !== 'string' || !SKILL_NAME_PATTERN.test(name)) {
    throw new ToolError(`"name" must match ${SKILL_NAME_PATTERN.source}: ${String(name)}`)
  }
  const relative = normalizeSkillFile(file)
  const lines = normalizeMaxLines(maxLines)
  const rootReal = realpathOrThrow(options.root ?? skillsRoot(), 'skills root is not readable')
  const dir = realpathOrThrow(join(rootReal, name), `skill not found: ${name}`)
  if (dir === rootReal || !isUnderPath(dir, rootReal)) throw new ToolError(`skill "${name}" resolves outside the skills root`)
  if (!statOrThrow(dir, `skill not found: ${name}`).isDirectory()) throw new ToolError(`skill "${name}" is not a directory`)
  const target = realpathOrThrow(join(dir, relative), `file not found in skill "${name}": ${relative}`)
  if (!isUnderPath(target, dir) || !isUnderPath(target, rootReal)) {
    throw new ToolError(`"${relative}" resolves outside skill "${name}"`)
  }
  if (!statOrThrow(target, `file not readable: ${relative}`).isFile()) {
    throw new ToolError(`not a regular file: ${relative}`)
  }
  return readSkillOutput(target, lines)
}

// ---- MCP surface ----

/**
 * The static tool declaration. It is a constant on purpose: `tools/list` must
 * never read the skills root, and the agent needs no discovery round-trip.
 */
export const TOOLS = [
  {
    name: 'skills_list',
    description: 'List the DSH skills available on this machine: an array of { name, description, path }. Call this before skill_read.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'skill_read',
    description: 'Read one skill file (SKILL.md by default), optionally limited to the first maxLines lines.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Skill directory name, exactly as returned by skills_list.', pattern: SKILL_NAME_PATTERN.source },
        file: { type: 'string', description: 'Relative path inside the skill directory; defaults to SKILL.md.', default: SKILL_FILE },
        maxLines: {
          type: 'integer',
          description: 'Maximum number of lines to return.',
          default: DEFAULT_MAX_LINES,
          minimum: MIN_MAX_LINES,
          maximum: MAX_MAX_LINES,
        },
      },
      required: ['name'],
      additionalProperties: false,
    },
  },
]

/** The requested revision when supported, otherwise the newest one this server speaks. */
export function negotiateProtocolVersion(requested) {
  return SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : SUPPORTED_PROTOCOL_VERSIONS[0]
}

/** This package's version, read lazily from the shipped manifest (a stale literal would lie). */
function serverVersion() {
  try {
    const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
    return typeof manifest.version === 'string' && manifest.version !== '' ? manifest.version : '0.0.0'
  } catch {
    return '0.0.0'
  }
}

/** One tool result for a failed call: the agent must SEE the failure, never an empty success. */
function toolFailure(reason) {
  return { content: [{ type: 'text', text: reason }], isError: true }
}

function listToolResult(warn) {
  return { content: buildSkillsContent(listSkills({ warn })) }
}

function readToolResult(args) {
  try {
    return { content: [{ type: 'text', text: readSkill(args) }] }
  } catch (error) {
    return toolFailure(messageOf(error))
  }
}

/**
 * `tools/call` dispatch. A bad CALL SHAPE (no `name`, non-object `arguments`) is
 * a protocol error (-32602); a bad TOOL ARGUMENT, an unknown tool, a refused
 * target or a read failure is a failed tool result with `isError: true`.
 */
function callTool(params, warn) {
  if (params === null || typeof params !== 'object' || Array.isArray(params)) {
    throw new RpcError(INVALID_PARAMS, 'tools/call expects an object params')
  }
  const name = params.name
  if (typeof name !== 'string' || name === '') throw new RpcError(INVALID_PARAMS, 'tools/call requires a string "name"')
  const args = params.arguments
  if (args !== undefined && (args === null || typeof args !== 'object' || Array.isArray(args))) {
    throw new RpcError(INVALID_PARAMS, 'tools/call "arguments" must be an object')
  }
  const toolArgs = args ?? {}
  if (name === 'skills_list') return listToolResult(warn)
  if (name === 'skill_read') return readToolResult(toolArgs)
  return toolFailure(`unknown tool: ${name}`)
}

function callMethod(method, params, warn) {
  switch (method) {
    case 'initialize': {
      const requested = params !== null && typeof params === 'object' ? params.protocolVersion : undefined
      return {
        protocolVersion: negotiateProtocolVersion(requested),
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: serverVersion() },
      }
    }
    case 'ping':
      return {}
    case 'tools/list':
      return { tools: TOOLS }
    case 'tools/call':
      return callTool(params, warn)
    default:
      throw new RpcError(METHOD_NOT_FOUND, `Method not found: ${method}`)
  }
}

function errorFrame(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } }
}

/**
 * One decoded JSON-RPC message → one response frame, or `undefined` when nothing
 * may be written. Notifications (any method under `notifications/`, or a message
 * with no `id`) NEVER produce a frame — not even on failure.
 */
export function handleMessage(message, warn = logStderr) {
  if (message === null || typeof message !== 'object' || Array.isArray(message) || typeof message.method !== 'string') {
    if (message !== null && typeof message === 'object' && Object.hasOwn(message, 'id')) {
      return errorFrame(message.id, INVALID_REQUEST, 'Invalid Request')
    }
    return undefined
  }
  if (message.method.startsWith('notifications/')) return undefined
  const isRequest = Object.hasOwn(message, 'id')
  try {
    const result = callMethod(message.method, message.params, warn)
    return isRequest ? { jsonrpc: '2.0', id: message.id, result } : undefined
  } catch (error) {
    if (!isRequest) {
      warn(`dsh-skills: ${message.method} failed: ${messageOf(error)}`)
      return undefined
    }
    const code = error instanceof RpcError ? error.code : INTERNAL_ERROR
    return errorFrame(message.id, code, messageOf(error))
  }
}

/** One raw stdin line → one response frame (`undefined` when the line must stay unanswered). */
export function handleLine(line, warn = logStderr) {
  let message
  try {
    message = JSON.parse(line)
  } catch {
    return errorFrame(null, PARSE_ERROR, 'Parse error')
  }
  return handleMessage(message, warn)
}

/**
 * The stdio loop: newline-delimited JSON-RPC in, single-line JSON-RPC out, EOF
 * exits. No watcher, no timer, no cache — an idle server holds nothing but its
 * stdin subscription.
 */
export function startServer(input = process.stdin, output = process.stdout, warn = logStderr) {
  const reader = createInterface({ input, crlfDelay: Infinity })
  reader.on('line', line => {
    if (line.trim() === '') return
    const frame = handleLine(line, warn)
    if (frame !== undefined) output.write(`${JSON.stringify(frame)}\n`)
  })
  reader.on('close', () => process.exit(0))
}

/** Whether this module IS the entry point (realpath-compared, so symlinked launches still match). */
function invokedDirectly() {
  const entry = process.argv[1]
  if (typeof entry !== 'string' || entry === '') return false
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
}

if (invokedDirectly()) startServer()
