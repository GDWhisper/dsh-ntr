/**
 * Agent skills: flavor matching, the per-flavor directory table and frontmatter parsing.
 *
 * The pure half — the filesystem walk lives in `src/skills-scan.ts`.
 *
 * Part of the host-half logic; the barrel is `src/impl.ts` and every existing
 * `../impl.ts` import keeps resolving through it. Pure logic only — no Node
 * APIs, no ACP SDK runtime values.
 */

import { splitCommandLine } from './command-line.ts'
import { AcpError } from './errors.ts'

// ---- Agent skills (pure half; the fs walk lives in src/skills-scan.ts) ----

/**
 * Which agent flavor a command line belongs to. The flavor picks the skill
 * directory table; `generic` is the conservative fallback every unproven agent
 * lands in (`.agents/skills`), never a wrong per-flavor guess.
 */
export type SkillFlavor = 'claude' | 'opencode' | 'codex' | 'gemini' | 'kimi' | 'pi' | 'goose' | 'droid' | 'generic'

/** Command basenames that only LAUNCH the real agent (lowercased; PATHEXT-style suffixes are stripped first). */
const SKILL_LAUNCHER_NAMES = new Set(['node', 'npx', 'npm', 'pnpm', 'yarn', 'bun', 'bunx', 'cmd'])

/**
 * Flags a launcher may carry before the real agent token (`pnpm dlx`,
 * `npm exec`, `cmd /d /s /c`, npx's `-y`). Only consumed while the walk is
 * still inside the launcher preamble, so an agent genuinely named `run` after
 * its launcher is not hidden twice.
 */
const SKILL_LAUNCHER_FLAGS = new Set(['-y', 'dlx', 'exec', 'run', '/d', '/s', '/c'])

/** Windows executable suffixes that may ride the program token (`npx.cmd`, `node.exe`). */
const SKILL_PATHEXT_RE = /\.(exe|cmd|bat|com)$/i

/**
 * Per-flavor agent names, matched against the first real command token's
 * basename (or its npm package segment). `stems` additionally own a `-`-bounded
 * prefix (`pi` also matches `pi-acp` and nothing like `api-x`); every other
 * entry is an exact name. Evidence per flavor lives in the
 * {@link SKILL_DIRS_BY_FLAVOR} table and AGENTS/ui.md §6.
 */
const SKILL_FLAVOR_MATCHERS: ReadonlyArray<{
  flavor: Exclude<SkillFlavor, 'generic'>
  names: readonly string[]
  stems?: readonly string[]
}> = [
  { flavor: 'claude', names: ['claude', 'claude-code-acp', 'claude-agent-acp'] },
  { flavor: 'opencode', names: ['opencode'] },
  { flavor: 'codex', names: ['codex', 'codex-acp'] },
  { flavor: 'gemini', names: ['gemini'] },
  { flavor: 'kimi', names: ['kimi', 'kimi-cli'] },
  { flavor: 'pi', names: ['pi', 'pi-acp', 'omp'], stems: ['pi'] },
  { flavor: 'goose', names: ['goose'] },
  { flavor: 'droid', names: ['droid'] },
]

/** Last path segment of a command token, with Windows executable suffixes stripped. */
function skillTokenBasename(token: string): string {
  const base = token.replaceAll('\\', '/').split('/').at(-1) ?? ''
  return base.replace(SKILL_PATHEXT_RE, '')
}

/**
 * The basename a flavor matcher sees. A bare token is a binary name; an npm
 * spec (`@scope/pkg`, `pkg@next`) degrades to its bare package name — that is
 * what `npx -y @agentclientprotocol/claude-agent-acp` must reduce to.
 */
function skillProgramName(token: string): string {
  const base = skillTokenBasename(token)
  return base.replace(/@[a-zA-Z0-9._-]+$/, '')
}

/**
 * Which skill directory table one agent's command line should scan.
 *
 * The walk skips launcher tokens (`node`, `npx`, `pnpm dlx`, `cmd /d /s /c`, …)
 * and their flags, takes the first real token, and matches its basename (or
 * package segment for npx-style specs) against the per-flavor name sets.
 * Anything unrecognized is `generic` — the fallback table, not a guess.
 *
 * `command` is the BARE program token after `validateAgentDef` (its extra
 * command-line tokens fold into `args`), so the walk is one token plus the
 * args; a caller that passes a whole command line with no `args` is tokenized
 * the same way.
 */
export function skillFlavorOf(command: string, args?: readonly string[]): SkillFlavor {
  const head = splitCommandLine(command)
  const tokens = args === undefined ? [head.command, ...head.args] : [command, ...(args ?? [])]
  let inLauncher = true
  let real: string | undefined
  for (const token of tokens) {
    if (inLauncher) {
      if (SKILL_LAUNCHER_NAMES.has(skillTokenBasename(token).toLowerCase())) continue
      if (SKILL_LAUNCHER_FLAGS.has(token.toLowerCase())) continue
      inLauncher = false
    }
    real = token
    break
  }
  if (real === undefined) return 'generic'
  const name = skillProgramName(real).toLowerCase()
  for (const matcher of SKILL_FLAVOR_MATCHERS) {
    if (matcher.names.includes(name)) return matcher.flavor
    if (matcher.stems?.some(stem => name === stem || name.startsWith(`${stem}-`))) return matcher.flavor
  }
  return 'generic'
}

/** The skill directory table one flavor scans. All separators are `/`; project dirs are workspace-relative, global/system carry a literal `~/` prefix. */
export interface SkillDirTable {
  projectDirs: readonly string[]
  globalDirs: readonly string[]
  systemDirs: readonly string[]
}

/**
 * Skill group dirs per flavor. Web-sourced rows (gemini/kimi/pi/goose/droid)
 * are documentation-level evidence, not runtime-verified; unproven agents stay
 * in {@link GENERIC_SKILL_DIRS} rather than guessing their layout. The claude
 * `claude-agent-acp` package segment is the plugin's own preset spelling
 * (`AGENT_PRESETS`, src/bridge.ts) — without it the shipped claude preset would
 * fall through to generic and scan nothing.
 */
export const SKILL_DIRS_BY_FLAVOR: Record<Exclude<SkillFlavor, 'generic'>, SkillDirTable> = {
  claude: { projectDirs: ['.claude/skills'], globalDirs: ['~/.claude/skills'], systemDirs: [] },
  opencode: {
    projectDirs: ['.agents/skills', '.opencode/skills', '.claude/skills'],
    globalDirs: ['~/.config/opencode/skills', '~/.claude/skills', '~/.agents/skills'],
    systemDirs: [],
  },
  codex: { projectDirs: ['.codex/skills'], globalDirs: ['~/.codex/skills'], systemDirs: ['~/.codex/skills/.system'] },
  gemini: { projectDirs: ['.gemini/skills', '.agents/skills'], globalDirs: ['~/.gemini/skills', '~/.agents/skills'], systemDirs: [] },
  kimi: {
    projectDirs: ['.kimi/skills', '.claude/skills', '.codex/skills'],
    globalDirs: ['~/.kimi/skills', '~/.claude/skills', '~/.codex/skills'],
    systemDirs: [],
  },
  pi: { projectDirs: ['.pi/skills', '.agents/skills'], globalDirs: ['~/.pi/agent/skills'], systemDirs: [] },
  goose: { projectDirs: ['.agents/skills'], globalDirs: ['~/.agents/skills'], systemDirs: [] },
  droid: { projectDirs: ['.factory/skills'], globalDirs: ['~/.factory/skills'], systemDirs: [] },
}

/**
 * The fallback table for every flavor the matcher does not know (and for
 * agents with no skill system of their own): the cross-agent convention dirs.
 * The scan stays harmless there — `use /token …` text is only a suggestion the
 * agent is free to ignore.
 */
export const GENERIC_SKILL_DIRS: SkillDirTable = {
  projectDirs: ['.agents/skills'],
  globalDirs: ['~/.agents/skills', '~/.config/agents/skills'],
  systemDirs: [],
}

/** Defensive caps for the skill scan (no body is ever read, so no content budget). */
export const SKILL_SCAN_LIMITS = {
  /** Direct children per group dir before the rest are cut (and `truncated` set). */
  maxChildrenPerDir: 2000,
  /** A SKILL.md larger than this is skipped (and `truncated` set). */
  maxSkillMdBytes: 256 * 1024,
  /** Menu rows before the rest are dropped (and `truncated` set). */
  maxSkills: 5000,
  /** How much of SKILL.md the head read may take; the frontmatter must live inside it. */
  maxSkillMdHeadBytes: 64 * 1024,
} as const

/** Strip one PAIR of matching quotes from a frontmatter value, then trim again. */
function stripFrontmatterQuotes(value: string): string {
  const trimmed = value.trim()
  const paired = trimmed.length >= 2
    && ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'")))
  return paired ? trimmed.slice(1, -1).trim() : trimmed
}

/**
 * Parse a SKILL.md frontmatter block into a flat string record. No frontmatter
 * → `{}`; a malformed block THROWS — the scanner
 * catches per skill and skips it, so one broken file never hides the rest.
 *
 * Accepted shape: `---` open marker, top-level `key: value` lines
 * (`[A-Za-z0-9_.-]+` keys), `#` comments and blank lines skipped, ONE nesting
 * level under `metadata:` (nested keys flatten to `metadata.<key>`, `- ` list
 * items skipped), paired quotes stripped from values, empty values dropped,
 * `---` close marker.
 */
export function parseSkillFrontmatter(text: string): Record<string, string> {
  const withoutBom = text.startsWith('\uFEFF') ? text.slice(1) : text
  const openCrlf = withoutBom.startsWith('---\r\n')
  if (!openCrlf && !withoutBom.startsWith('---\n')) return {}
  const body = withoutBom.slice(4)
  if (/^---(?:\r?\n|$)/.test(body)) return {}
  const close = /\r?\n---(?:\r?\n|$)/.exec(body)
  if (close === null) throw new AcpError('bad_config', 'acp: skill frontmatter never closes')
  const record: Record<string, string> = {}
  let metadataKey: string | undefined
  for (const line of body.slice(0, close.index).split(/\r?\n/)) {
    const content = line.trim()
    if (content === '' || content.startsWith('#')) continue
    const indented = /^\s/.test(line)
    if (metadataKey !== undefined && indented) {
      if (content.startsWith('- ')) continue
      const nested = /^([A-Za-z0-9_.-]+):\s*(.*)$/.exec(content)
      if (nested === null) throw new AcpError('bad_config', 'acp: skill frontmatter metadata block has a malformed line')
      const value = stripFrontmatterQuotes(nested[2])
      if (value !== '') record[`${metadataKey}.${nested[1]}`] = value
      continue
    }
    metadataKey = undefined
    const top = /^([A-Za-z0-9_.-]+):\s*(.*)$/.exec(content)
    if (top === null) throw new AcpError('bad_config', 'acp: skill frontmatter has a malformed line')
    const value = stripFrontmatterQuotes(top[2])
    if (value === '') {
      // An empty value OPENS the one nesting level this parser accepts when the
      // key is `metadata`; any other empty key-value is dropped.
      if (top[1] === 'metadata') metadataKey = 'metadata'
      continue
    }
    record[top[1]] = value
  }
  return record
}

/** The display name and description of one skill: frontmatter first, directory basename as the name fallback. */
export function skillMetadata(
  frontmatter: Record<string, string>,
  dirBasename: string,
): { name: string; description?: string } {
  const name = frontmatter.name !== undefined && frontmatter.name !== '' ? frontmatter.name : dirBasename
  const description = frontmatter.description !== undefined && frontmatter.description !== '' ? frontmatter.description : undefined
  return { name, ...(description === undefined ? {} : { description }) }
}

/**
 * The whitespace-free pick token for one skill: a whitespace-free
 * frontmatter name is used directly; otherwise the last non-empty segment of
 * the skill path (its `SKILL.md` suffix stripped, case-insensitive); when even
 * that is empty, the name with whitespace runs folded to `-`. An empty result
 * means the caller skips the skill.
 */
export function skillMentionToken(name: string, relativePath: string): string {
  const trimmed = name.trim()
  if (trimmed !== '' && /^\S+$/.test(trimmed)) return trimmed
  const withoutFile = relativePath.replace(/\/skill\.md$/i, '')
  const segments = withoutFile.split('/').filter(segment => segment !== '')
  const last = segments.at(-1)?.trim() ?? ''
  if (last !== '') return last
  return trimmed.replaceAll(/\s+/g, '-')
}

/** Markdown link destination escaping backslash and close-paren, verbatim — no `<>` wrapper is added. */
export function formatSkillPathDestination(path: string): string {
  return path.replaceAll('\\', '\\\\').replaceAll(')', '\\)')
}

/** The draft text a skill pick inserts: the agent's own skill tools load the rest. */
export function formatSkillMentionPrompt(token: string, path: string): string {
  return `use /${token} [Skill Path](${formatSkillPathDestination(path)})`
}
