/**
 * Pure presentation parser for `dsh_ntr__acp_tool_call` cards rendered inside
 * the host Chat timeline (`tool.call.toolview`).
 *
 * Browser-safe only — zero React, DOM, or Node imports. Mirrors the wire
 * envelope emitted by `acpToolArgsJson` (`src/impl/content.ts`) while staying
 * backwards-compatible with legacy `{ description, input }` records and plain
 * non-JSON strings.
 */

/**
 * Hand-copied from `ACP_TOOL_CALL_NAME` in `src/impl/content.ts` (the browser
 * bundle must never import `src/impl.ts` or Node modules).
 */
export const ACP_TOOL_CALL_NAME = 'dsh_ntr__acp_tool_call'

export type AcpToolCategory =
  | 'execute'
  | 'read'
  | 'edit'
  | 'delete'
  | 'move'
  | 'search'
  | 'fetch'
  | 'think'
  | 'switch_mode'
  | 'subagent'
  | 'plan'
  | 'other'

export type AcpToolState = 'preparing' | 'running' | 'ok' | 'error' | 'stopped'

export interface AcpToolLocation {
  path: string
  line?: number
}

export interface AcpToolDiff {
  path: string
  oldText: string | null
  newText: string
}

/** Structural subset of DSH `ToolArgs` (`PartialArguments`). */
export interface AcpToolArgsView {
  has?(key: string): boolean
  complete?(key: string): boolean
  text?(key: string): string | undefined
  value?(key: string): unknown
}

export interface AcpLiveToolCall {
  readonly title?: string
  readonly kind?: string
  readonly tool?: string
  readonly locations?: readonly AcpToolLocation[]
  readonly rawInput?: unknown
  readonly outputText?: string
  readonly diffs?: readonly AcpToolDiff[]
}

export interface AcpToolPresentationInput {
  phase: 'preparing' | 'start' | 'result'
  argsRaw?: string | null
  args?: AcpToolArgsView
  resultContent?: readonly unknown[]
  isError?: boolean
  error?: { name?: string; code?: string; reason?: string }
  meta?: unknown
  live?: AcpLiveToolCall
  cwd?: string
  home?: string
}

export interface AcpToolPresentation {
  category: AcpToolCategory
  iconKey: AcpToolCategory
  title: { zh: string; en: string }
  summary: string
  state: AcpToolState
  toolName?: string
  kind?: string
  filePath?: string
  filePathLine?: number
  inputText?: string
  inputIsCommand: boolean
  outputText?: string
  errorSummary?: string
  diffs?: readonly AcpToolDiff[]
}

const KNOWN_KINDS: ReadonlySet<AcpToolCategory> = new Set([
  'execute',
  'read',
  'edit',
  'delete',
  'move',
  'search',
  'fetch',
  'think',
  'switch_mode',
])

const TOOL_CATEGORY_MAP: Readonly<Record<string, AcpToolCategory>> = {
  bash: 'execute',
  sh: 'execute',
  shell: 'execute',
  exec_command: 'execute',
  read: 'read',
  view_file: 'read',
  read_file: 'read',
  edit: 'edit',
  write: 'edit',
  apply_patch: 'edit',
  str_replace_editor: 'edit',
  grep: 'search',
  glob: 'search',
  ripgrep: 'search',
  find_by_name: 'search',
  web_search: 'fetch',
  webfetch: 'fetch',
  web_fetch: 'fetch',
  task: 'subagent',
  agent: 'subagent',
  todowrite: 'plan',
  todo_write: 'plan',
}

const CATEGORY_TITLES: Readonly<Record<AcpToolCategory, { zh: string; en: string }>> = {
  execute: { zh: '运行命令', en: 'Execute' },
  read: { zh: '读取', en: 'Read' },
  edit: { zh: '编辑', en: 'Edit' },
  delete: { zh: '删除', en: 'Delete' },
  move: { zh: '移动', en: 'Move' },
  search: { zh: '搜索', en: 'Search' },
  fetch: { zh: '获取', en: 'Fetch' },
  think: { zh: '思考', en: 'Think' },
  switch_mode: { zh: '切换模式', en: 'Switch mode' },
  subagent: { zh: '子智能体', en: 'Subagent' },
  plan: { zh: '更新计划', en: 'Plan' },
  other: { zh: '工具调用', en: 'Tool call' },
}

const FILE_CATEGORIES: ReadonlySet<AcpToolCategory> = new Set(['read', 'edit', 'delete', 'move'])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function firstLine(text: string): string {
  const nl = text.indexOf('\n')
  return (nl === -1 ? text : text.slice(0, nl)).replace(/\r$/, '')
}

function isWindowsStylePath(value: string): boolean {
  return /^[A-Za-z]:[/\\]/.test(value) || value.startsWith('\\\\')
}

/**
 * Strip `cwd` from a workspace-rooted path for display. Tolerates mixed `/` and `\`
 * separators on Windows workspaces.
 */
export function relativizeToCwd(text: string, cwd?: string): string {
  if (cwd === undefined || cwd === '') return text
  const root = cwd.replace(/[/\\]+$/, '')
  if (root === '') return text
  if (text.startsWith(`${root}/`) || text.startsWith(`${root}\\`)) {
    return text.slice(root.length + 1)
  }
  const normText = text.replace(/\\/g, '/')
  const normRoot = root.replace(/\\/g, '/')
  if (normText.startsWith(`${normRoot}/`)) {
    return text.slice(root.length + 1)
  }
  return text
}

/** Abbreviate a POSIX home directory prefix to `~` (no-op on Windows paths). */
export function abbreviateHomePath(path: string, home?: string): string {
  if (home === undefined || home === '') return path
  if (isWindowsStylePath(path) || isWindowsStylePath(home)) return path
  const root = home.replace(/\/+$/, '')
  if (root === '' || root === '/') return path
  if (path.replace(/\/+$/, '') === root) return '~'
  if (path.startsWith(`${root}/`)) return `~${path.slice(root.length)}`
  return path
}

function formatDisplayPath(path: string, cwd?: string, home?: string): string {
  return abbreviateHomePath(relativizeToCwd(path, cwd), home)
}

/** Classify an ACP tool call by `kind` first, then exact `tool` name lookup. */
export function classifyAcpTool(kind?: string, tool?: string): AcpToolCategory {
  const normKind = kind?.trim().toLowerCase()
  if (normKind !== undefined && normKind !== '' && normKind !== 'other' && KNOWN_KINDS.has(normKind as AcpToolCategory)) {
    return normKind as AcpToolCategory
  }
  const normTool = tool?.trim().toLowerCase()
  if (normTool !== undefined && normTool !== '' && Object.hasOwn(TOOL_CATEGORY_MAP, normTool)) {
    return TOOL_CATEGORY_MAP[normTool] as AcpToolCategory
  }
  return 'other'
}

export function parseLocations(raw: unknown): AcpToolLocation[] {
  if (!Array.isArray(raw)) return []
  const out: AcpToolLocation[] = []
  for (const item of raw) {
    if (!isRecord(item)) continue
    if (typeof item.path !== 'string' || item.path.trim() === '') continue
    const line = typeof item.line === 'number' && Number.isInteger(item.line) && item.line >= 1
      ? item.line
      : undefined
    out.push(line === undefined ? { path: item.path } : { path: item.path, line })
  }
  return out
}

interface ParsedEnvelope {
  description?: string
  kind?: string
  tool?: string
  locations: AcpToolLocation[]
  hasInput: boolean
  rawInput: unknown
  rawFallbackInput?: string
}

function readCompleteString(args: AcpToolArgsView, key: string): string | undefined {
  if (args.complete !== undefined && !args.complete(key)) return undefined
  const val = args.text?.(key)?.trim()
  return val !== undefined && val !== '' ? val : undefined
}

function parseEnvelope(argsRaw?: string | null, args?: AcpToolArgsView): ParsedEnvelope {
  if (typeof argsRaw === 'string' && argsRaw !== '') {
    try {
      const parsed: unknown = JSON.parse(argsRaw)
      if (isRecord(parsed)) {
        const hasEnvelopeKey =
          'description' in parsed ||
          'kind' in parsed ||
          'tool' in parsed ||
          'locations' in parsed ||
          'input' in parsed
        const description = typeof parsed.description === 'string' && parsed.description !== ''
          ? parsed.description
          : undefined
        const kind = typeof parsed.kind === 'string' && parsed.kind.trim() !== ''
          ? parsed.kind.trim()
          : undefined
        const tool = typeof parsed.tool === 'string' && parsed.tool.trim() !== ''
          ? parsed.tool.trim()
          : undefined
        const locations = parseLocations(parsed.locations)
        const hasInput = hasEnvelopeKey ? ('input' in parsed && parsed.input !== undefined) : true
        const rawInput = hasEnvelopeKey ? parsed.input : parsed
        return { description, kind, tool, locations, hasInput, rawInput }
      }
      return { locations: [], hasInput: true, rawInput: parsed }
    } catch {
      return { locations: [], hasInput: false, rawInput: undefined, rawFallbackInput: argsRaw }
    }
  }

  if (args === undefined) {
    return { locations: [], hasInput: false, rawInput: undefined }
  }

  const rawDesc = args.text?.('description')
  const description = rawDesc !== undefined && rawDesc !== '' ? rawDesc : undefined
  const kind = readCompleteString(args, 'kind')
  const tool = readCompleteString(args, 'tool')
  const rawLocs = args.complete === undefined || args.complete('locations')
    ? args.value?.('locations')
    : undefined
  const locations = parseLocations(rawLocs)
  let hasInput = false
  let rawInput: unknown
  if (args.has?.('input')) {
    const complete = args.complete === undefined || args.complete('input')
    const strVal = args.text?.('input')
    if (strVal !== undefined) {
      if (strVal !== '') {
        hasInput = true
        rawInput = strVal
      }
    } else if (complete) {
      const objVal = args.value?.('input')
      if (objVal !== undefined) {
        hasInput = true
        rawInput = objVal
      }
    }
  }
  return { description, kind, tool, locations, hasInput, rawInput }
}

function pickStringField(obj: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const val = obj[key]
    if (typeof val === 'string' && val.trim() !== '') return val
  }
  return undefined
}

function extractFileTarget(locations: readonly AcpToolLocation[], rawInput: unknown): { filePath?: string; filePathLine?: number } {
  if (locations.length > 0) {
    const first = locations[0] as AcpToolLocation
    return { filePath: first.path, ...(first.line !== undefined ? { filePathLine: first.line } : {}) }
  }
  if (!isRecord(rawInput)) return {}
  const picked = pickStringField(rawInput, ['path', 'file_path'])
  if (picked === undefined) return {}
  const filePath = firstLine(picked)
  const rawLine = rawInput.line ?? rawInput.offset
  const filePathLine = typeof rawLine === 'number' && Number.isInteger(rawLine) && rawLine >= 1
    ? rawLine
    : undefined
  return { filePath, ...(filePathLine !== undefined ? { filePathLine } : {}) }
}

function deriveInputText(category: AcpToolCategory, env: ParsedEnvelope): string | undefined {
  if (!env.hasInput) {
    return env.rawFallbackInput !== undefined && env.rawFallbackInput !== ''
      ? env.rawFallbackInput
      : undefined
  }
  const { rawInput } = env
  if (typeof rawInput === 'string') return rawInput === '' ? undefined : rawInput
  if (isRecord(rawInput)) {
    if (category === 'execute') {
      const cmd = pickStringField(rawInput, ['command', 'cmd'])
      if (cmd !== undefined) return cmd
    }
    return JSON.stringify(rawInput, null, 2)
  }
  if (rawInput !== undefined) return JSON.stringify(rawInput, null, 2)
  return undefined
}

function deriveSummary(
  category: AcpToolCategory,
  env: ParsedEnvelope,
  filePath: string | undefined,
  cwd: string | undefined,
  home: string | undefined,
): string {
  const isFileOp = FILE_CATEGORIES.has(category)
  if (env.description !== undefined) {
    const line = firstLine(env.description)
    if (!isFileOp) return line
    if (filePath !== undefined && line.includes(filePath)) {
      return line.replace(filePath, formatDisplayPath(filePath, cwd, home))
    }
    return formatDisplayPath(line, cwd, home)
  }
  if (filePath !== undefined) return formatDisplayPath(filePath, cwd, home)
  if (isRecord(env.rawInput)) {
    if (category === 'execute') {
      const cmd = pickStringField(env.rawInput, ['command', 'cmd'])
      if (cmd !== undefined) return firstLine(cmd)
    }
    if (category === 'search') {
      const queries = env.rawInput.queries
      if (Array.isArray(queries)) {
        const list = queries.filter((q): q is string => typeof q === 'string' && q.trim() !== '')
        if (list.length > 0) return list.map(firstLine).join(', ')
      }
      const query = pickStringField(env.rawInput, ['pattern', 'query', 'path'])
      if (query !== undefined) return firstLine(query)
    }
    if (category === 'fetch') {
      const target = pickStringField(env.rawInput, ['url', 'query'])
      if (target !== undefined) return firstLine(target)
    }
    if (category === 'subagent') {
      const desc = pickStringField(env.rawInput, ['description', 'prompt', 'task'])
      if (desc !== undefined) return firstLine(desc)
    }
    for (const val of Object.values(env.rawInput)) {
      if (typeof val === 'string' && val.trim() !== '') {
        const line = firstLine(val)
        return isFileOp ? formatDisplayPath(line, cwd, home) : line
      }
    }
  }
  if (typeof env.rawInput === 'string' && env.rawInput !== '') {
    const line = firstLine(env.rawInput)
    return isFileOp ? formatDisplayPath(line, cwd, home) : line
  }
  if (env.rawFallbackInput !== undefined && env.rawFallbackInput !== '') {
    return firstLine(env.rawFallbackInput)
  }
  return ''
}

function parseDiffsFromList(raw: unknown): AcpToolDiff[] {
  if (!Array.isArray(raw)) return []
  const diffs: AcpToolDiff[] = []
  for (const item of raw) {
    if (!isRecord(item)) continue
    const candidate = item.type === 'content' && isRecord(item.content) ? item.content : item
    if (typeof candidate.path !== 'string' || candidate.path === '') continue
    if (typeof candidate.newText !== 'string') continue
    const oldText = typeof candidate.oldText === 'string' ? candidate.oldText : null
    if ('type' in candidate && candidate.type !== 'diff') continue
    diffs.push({ path: candidate.path, oldText, newText: candidate.newText })
  }
  return diffs
}

function extractDiffs(meta: unknown, resultContent?: readonly unknown[]): AcpToolDiff[] | undefined {
  if (isRecord(meta)) {
    const metaDiffs = parseDiffsFromList(meta.diffs)
    if (metaDiffs.length > 0) return metaDiffs
  }
  if (Array.isArray(resultContent)) {
    const contentDiffs = parseDiffsFromList(
      resultContent.filter(item => isRecord(item) && (item.type === 'diff' || (item.type === 'content' && isRecord(item.content) && item.content.type === 'diff'))),
    )
    if (contentDiffs.length > 0) return contentDiffs
  }
  return undefined
}

function extractOutputText(
  resultContent: readonly unknown[] | undefined,
  error?: { name?: string; code?: string; reason?: string },
): string | undefined {
  const parts: string[] = []
  if (Array.isArray(resultContent)) {
    for (const item of resultContent) {
      if (typeof item === 'string') {
        if (item !== '') parts.push(item)
        continue
      }
      if (!isRecord(item)) continue
      if (item.type === 'text' && typeof item.text === 'string') {
        parts.push(item.text)
      } else if (item.type === 'diff') {
        continue
      } else {
        parts.push(JSON.stringify(item, null, 2))
      }
    }
  }
  if (parts.length === 0 && error !== undefined) {
    const label = [error.name, error.code].filter((s): s is string => typeof s === 'string' && s !== '').join(': ')
    if (label !== '') parts.push(label)
  }
  const joined = parts.join('\n')
  return joined === '' ? undefined : joined
}

/**
 * Parse raw call arguments, streaming `ToolArgs`, and settled result payload into
 * a unified presentation model for `AcpToolRow`.
 */
export function parseAcpToolPresentation(input: AcpToolPresentationInput): AcpToolPresentation {
  const baseEnv = parseEnvelope(input.argsRaw, input.args)
  const live = input.live
  // Host BlockAssembler freezes `block.call.argsRaw` on the first `block-end`
  // (at 500ms `settleOpenCard`), so late `tool_call_update` title/input/diffs
  // stay available via live SSE enrichment even after `phase === 'result'`.
  // Result `outputText`, `isError`, and `error` remain authoritative on `result`.
  const env: ParsedEnvelope = live === undefined ? baseEnv : {
    description: live.title !== undefined && live.title !== '' ? live.title : baseEnv.description,
    kind: live.kind !== undefined && live.kind !== '' ? live.kind : baseEnv.kind,
    tool: live.tool !== undefined && live.tool !== '' ? live.tool : baseEnv.tool,
    locations: live.locations !== undefined && live.locations.length > 0 ? [...live.locations] : baseEnv.locations,
    hasInput: live.rawInput !== undefined ? true : baseEnv.hasInput,
    rawInput: live.rawInput !== undefined ? live.rawInput : baseEnv.rawInput,
    ...(baseEnv.rawFallbackInput === undefined ? {} : { rawFallbackInput: baseEnv.rawFallbackInput }),
  }
  const category = classifyAcpTool(env.kind, env.tool)
  const title = category === 'other' && env.tool !== undefined
    ? { zh: env.tool, en: env.tool }
    : CATEGORY_TITLES[category]

  const state: AcpToolState = input.phase === 'preparing'
    ? 'preparing'
    : input.phase === 'start'
      ? 'running'
      : input.error?.code === 'interrupted'
        ? 'stopped'
        : input.isError
          ? 'error'
          : 'ok'

  const { filePath, filePathLine } = category === 'fetch'
    ? {}
    : extractFileTarget(env.locations, env.rawInput)

  const summary = deriveSummary(category, env, filePath, input.cwd, input.home)
  const inputText = deriveInputText(category, env)
  const liveDiffs = live?.diffs !== undefined && live.diffs.length > 0 ? live.diffs : undefined
  const diffs = input.phase === 'result'
    ? (extractDiffs(input.meta, input.resultContent) ?? liveDiffs)
    : liveDiffs
  const outputText = input.phase === 'result'
    ? extractOutputText(input.resultContent, input.error)
    : live?.outputText !== undefined && live.outputText !== ''
      ? live.outputText
      : undefined
  const errorSummary = state === 'error' && outputText !== undefined ? firstLine(outputText) : undefined

  return {
    category,
    iconKey: category,
    title,
    summary,
    state,
    ...(env.tool !== undefined ? { toolName: env.tool } : {}),
    ...(env.kind !== undefined ? { kind: env.kind } : {}),
    ...(filePath !== undefined ? { filePath } : {}),
    ...(filePathLine !== undefined ? { filePathLine } : {}),
    ...(inputText !== undefined ? { inputText } : {}),
    inputIsCommand: category === 'execute',
    ...(outputText !== undefined ? { outputText } : {}),
    ...(errorSummary !== undefined ? { errorSummary } : {}),
    ...(diffs !== undefined ? { diffs } : {}),
  }
}
