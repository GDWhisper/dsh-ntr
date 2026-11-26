/**
 * Keyed `tool.call.toolview` entry for `dsh_ntr__acp_tool_call` cards inside
 * the host Chat timeline.
 *
 * Uses `@deepseek-ai/dsh-client-ui-primitives` (`DisclosureRow`, `TextShimmer`,
 * `DiffBlock`, `Icon*`) resolved through the module namespace so older host
 * generations that omit a primitive degrade cleanly to local fallbacks instead
 * of failing the slot's error boundary.
 */

import { useCallback, useMemo, useSyncExternalStore } from 'react'
import type { ComponentType, KeyboardEvent, MouseEvent, ReactNode } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import * as primitives from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  DiffBlockLabels,
  DiffBlockProps,
  DisclosureRowProps,
  IconProps,
  TextShimmerProps,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { ensureAcpStyle } from './acp-ui.tsx'
import {
  ACP_TOOL_CALL_NAME,
  parseAcpToolPresentation,
  type AcpToolArgsView,
  type AcpToolCategory,
  type AcpToolDiff,
} from './acp-tool-presentation.ts'
import type { AcpStore } from './store.ts'

export interface AcpToolCallPreparingBlock {
  readonly phase: 'preparing'
  readonly callId: string
  readonly name: string
  readonly args: AcpToolArgsView
}

export interface AcpToolCallStartBlock {
  readonly phase: 'start'
  readonly callId: string
  readonly name: string
  readonly argsRaw: string
  readonly args: AcpToolArgsView
}

export interface AcpToolCallResultBlock {
  readonly kind: 'tool-result'
  readonly callId: string
  readonly name: string
  readonly args: AcpToolArgsView
  readonly call: { readonly name: string; readonly argsRaw: string } | null
  readonly content: readonly unknown[]
  readonly isError: boolean
  readonly error?: { readonly name: string; readonly code: string; readonly reason?: string }
  readonly meta?: unknown
}

export type AcpToolCallOwnerBlock =
  | { readonly phase: 'preparing'; readonly block: AcpToolCallPreparingBlock }
  | { readonly phase: 'start'; readonly block: AcpToolCallStartBlock }
  | { readonly phase: 'result'; readonly block: AcpToolCallResultBlock }

export type AcpToolRowProps = AcpToolCallOwnerBlock & {
  callId: string
  toolName: string
  cwd?: string
  home?: string
  openFile?: (path: string, options?: { readonly line?: number }) => void
  inspect?: () => void
  useDisclosure: () => {
    readonly expanded: boolean
    readonly setExpanded: (open: boolean) => void
    readonly toggle: () => void
  }
  acp?: AcpStore
}

const CHAT_DIFF_MAX_LINES = 9
const DIFF_LCS_LIMIT = 300

const ICON_NAME_BY_CATEGORY: Readonly<Record<AcpToolCategory, string>> = {
  execute: 'IconApiOutlineRegular',
  read: 'IconBrowseOutlineRegular',
  edit: 'IconEditOutlineRegular',
  delete: 'IconTrashOutlineRegular',
  move: 'IconFolderOpenOutlineRegular',
  search: 'IconSearchOutlineRegular',
  fetch: 'IconGlobeOutlineRegular',
  think: 'IconThinkOutlineRegular',
  switch_mode: 'IconBranchOutlineRegular',
  subagent: 'IconUsersOutlineRegular',
  plan: 'IconChecklistOutlineRegular',
  other: 'IconSparkleRegular',
}

/**
 * Resolve a primitive export safely. Note that `React.memo(...)` / `forwardRef(...)`
 * components are objects with `$$typeof`, not functions, so both are accepted.
 */
function resolvePrimitive<P>(name: string): ComponentType<P> | undefined {
  let candidate: unknown
  try {
    candidate = (primitives as unknown as Record<string, unknown>)[name]
  } catch {
    return undefined
  }
  if (typeof candidate === 'function') return candidate as ComponentType<P>
  if (typeof candidate === 'object' && candidate !== null && '$$typeof' in candidate) {
    return candidate as ComponentType<P>
  }
  return undefined
}

function FallbackIcon({ category }: { category: AcpToolCategory }) {
  const path = (() => {
    switch (category) {
      case 'execute': return 'M4 5l4 3-4 3M9 11h3'
      case 'read': return 'M3 3h6l3 3v7H3zM9 3v3h3'
      case 'edit': return 'M10.5 2.5l3 3-7 7H3.5v-3z'
      case 'delete': return 'M3 4h10M6 4V2.5h4V4M5 4l.5 9h5L11 4'
      case 'move': return 'M2.5 4h4l1.5 1.5h5.5v7h-11z'
      case 'search': return 'M7 11a4 4 0 1 1 0-8 4 4 0 0 1 0 8zm3-1l3 3'
      case 'fetch': return 'M8 2a6 6 0 1 0 0 12A6 6 0 0 0 8 2zm-5.5 6h11M8 2c2 2 2 10 0 12M8 2c-2 2-2 10 0 12'
      case 'think': return 'M8 2.5a4 4 0 0 0-2 7.5V12h4v-2a4 4 0 0 0-2-7.5zM6.5 13.5h3'
      case 'switch_mode': return 'M4 5h8M10 3l2 2-2 2M12 11H4M6 9l-2 2 2 2'
      case 'subagent': return 'M6 7a2.2 2.2 0 1 0 0-4.4A2.2 2.2 0 0 0 6 7zm-3.5 6a3.5 3.5 0 0 1 7 0M11 7.5a1.8 1.8 0 1 0 0-3.6M10.5 13h3a2.5 2.5 0 0 0-2.5-2.5'
      case 'plan': return 'M3 4.5l1.5 1.5L7 3.5M9 5h4M3 8.5l1.5 1.5L7 7.5M9 9h4M3 12.5h10'
      default: return 'M8 2l1.6 4.4L14 8l-4.4 1.6L8 14l-1.6-4.4L2 8l4.4-1.6z'
    }
  })()
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={path} />
    </svg>
  )
}

function CategoryIcon({ category }: { category: AcpToolCategory }) {
  const name = ICON_NAME_BY_CATEGORY[category]
  const HostIcon = resolvePrimitive<IconProps>(name)
    ?? (category === 'switch_mode' ? resolvePrimitive<IconProps>('IconBranchOutline16') : undefined)
  if (HostIcon !== undefined) return <HostIcon size={14} />
  return <FallbackIcon category={category} />
}

function TextShimmerOrSpan(props: TextShimmerProps) {
  const HostTextShimmer = resolvePrimitive<TextShimmerProps>('TextShimmer')
  if (HostTextShimmer !== undefined) return <HostTextShimmer {...props} />
  return <span className={props.className}>{props.children}</span>
}

interface DiffLine {
  sign: '+' | '-' | ' '
  text: string
}

function splitLines(text: string | null): string[] {
  if (text === null || text === '') return []
  return text.endsWith('\n') ? text.slice(0, -1).split('\n') : text.split('\n')
}

function computeDiffLines(oldText: string | null, newText: string): DiffLine[] {
  const oldLines = splitLines(oldText)
  const newLines = splitLines(newText)
  const rows: DiffLine[] = []
  let start = 0
  while (start < oldLines.length && start < newLines.length && oldLines[start] === newLines[start]) start++
  let tail = 0
  while (
    tail < oldLines.length - start
    && tail < newLines.length - start
    && oldLines[oldLines.length - 1 - tail] === newLines[newLines.length - 1 - tail]
  ) tail++
  for (let i = 0; i < start; i++) rows.push({ sign: ' ', text: oldLines[i] as string })
  const oldMid = oldLines.slice(start, oldLines.length - tail)
  const newMid = newLines.slice(start, newLines.length - tail)
  if (oldMid.length > DIFF_LCS_LIMIT || newMid.length > DIFF_LCS_LIMIT) {
    for (const text of oldMid) rows.push({ sign: '-', text })
    for (const text of newMid) rows.push({ sign: '+', text })
  } else {
    const r = oldMid.length
    const c = newMid.length
    const dp: number[][] = Array.from({ length: r + 1 }, () => new Array<number>(c + 1).fill(0))
    for (let i = r - 1; i >= 0; i--) {
      for (let j = c - 1; j >= 0; j--) {
        const row = dp[i] as number[]
        const below = dp[i + 1] as number[]
        row[j] = oldMid[i] === newMid[j]
          ? (below[j + 1] as number) + 1
          : Math.max(below[j] as number, row[j + 1] as number)
      }
    }
    let i = 0
    let j = 0
    while (i < r && j < c) {
      if (oldMid[i] === newMid[j]) {
        rows.push({ sign: ' ', text: oldMid[i] as string })
        i++
        j++
      } else if (((dp[i + 1] as number[])[j] as number) >= ((dp[i] as number[])[j + 1] as number)) {
        rows.push({ sign: '-', text: oldMid[i] as string })
        i++
      } else {
        rows.push({ sign: '+', text: newMid[j] as string })
        j++
      }
    }
    while (i < r) rows.push({ sign: '-', text: oldMid[i++] as string })
    while (j < c) rows.push({ sign: '+', text: newMid[j++] as string })
  }
  for (let i = tail; i > 0; i--) rows.push({ sign: ' ', text: oldLines[oldLines.length - i] as string })
  return rows
}

function FallbackDiffView({ diffs }: { diffs: readonly AcpToolDiff[] }) {
  return (
    <div className="ntr-tool-diff-list">
      {diffs.map((diff, idx) => {
        const lines = computeDiffLines(diff.oldText, diff.newText)
        const added = lines.filter(l => l.sign === '+').length
        const removed = lines.filter(l => l.sign === '-').length
        return (
          <div key={`${diff.path}#${String(idx)}`} className="ntr-tool-diff">
            <div className="ntr-tool-diff-head">
              <span className="ntr-tool-diff-path">{diff.path}</span>
              <span className="ntr-tool-diff-stats">
                <span className="is-add">+{added}</span>{' '}
                <span className="is-del">-{removed}</span>
              </span>
            </div>
            <div className="ntr-tool-diff-body">
              {lines.map((row, lineIdx) => (
                <div key={lineIdx} className={`ntr-tool-diff-row is-${row.sign === '+' ? 'add' : row.sign === '-' ? 'del' : 'ctx'}`}>
                  <span className="ntr-tool-diff-sign">{row.sign}</span>
                  <span className="ntr-tool-diff-text">{row.text}</span>
                </div>
              ))}
            </div>
          </div>
        )
      })}
    </div>
  )
}

function FallbackDisclosureRow({
  icon,
  title,
  open,
  expandable,
  onToggle,
  collapsedContent,
  children,
}: DisclosureRowProps) {
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (!expandable || (event.key !== 'Enter' && event.key !== ' ')) return
    event.preventDefault()
    onToggle()
  }
  return (
    <div className="ntr-tool-disclosure" data-open={open || undefined}>
      <div
        className="ntr-tool-row"
        data-expandable={expandable || undefined}
        role={expandable ? 'button' : undefined}
        tabIndex={expandable ? 0 : undefined}
        aria-expanded={expandable ? open : undefined}
        onClick={expandable ? onToggle : undefined}
        onKeyDown={expandable ? onKeyDown : undefined}
      >
        <span className="ntr-tool-leading">{icon}</span>
        <span className="ntr-tool-title">{title}</span>
        {collapsedContent}
      </div>
      {open && children}
    </div>
  )
}

const noopSubscribe = (): (() => void) => () => {}
const zeroSnapshot = (): number => 0

function defaultPrefersZh(): boolean {
  if (typeof document !== 'undefined' && document.documentElement.lang !== '') {
    return /^zh\b/i.test(document.documentElement.lang)
  }
  if (typeof navigator !== 'undefined') return /^zh\b/i.test(navigator.language)
  return false
}

/**
 * Renders one ACP tool call inside the host's native Chat timeline using the
 * real tool category, summary, file link, diff card, and input/output blocks.
 */
export function AcpToolRow(props: AcpToolRowProps) {
  ensureAcpStyle()
  const { phase, block, cwd, home, openFile, inspect, useDisclosure, acp } = props
  useSyncExternalStore(
    acp ? (cb => acp.subscribe(cb)) : noopSubscribe,
    acp ? (() => acp.getSnapshot().localeRev) : zeroSnapshot,
  )
  const tr = useCallback(
    (zh: string, en: string): string => (acp ? acp.label(zh, en) : defaultPrefersZh() ? zh : en),
    [acp],
  )
  const { expanded, toggle } = useDisclosure()

  const model = useMemo(() => {
    if (phase === 'preparing') {
      return parseAcpToolPresentation({
        phase,
        argsRaw: undefined,
        args: block.args,
        cwd,
        home,
      })
    }
    if (phase === 'start') {
      return parseAcpToolPresentation({
        phase,
        argsRaw: block.argsRaw,
        args: block.args,
        cwd,
        home,
      })
    }
    return parseAcpToolPresentation({
      phase,
      argsRaw: block.call?.argsRaw ?? '',
      args: block.args,
      resultContent: block.content,
      isError: block.isError,
      error: block.error,
      meta: block.meta,
      cwd,
      home,
    })
  }, [phase, block, cwd, home])

  const hasDiffs = model.diffs !== undefined && model.diffs.length > 0
  const hasIo = model.inputText !== undefined || model.outputText !== undefined
  const expandable = model.state !== 'preparing' && (hasIo || hasDiffs)
  const open = expanded && expandable
  const running = model.state === 'preparing' || model.state === 'running'
  const titleText = tr(model.title.zh, model.title.en)

  const summaryText = model.state === 'error'
    ? (model.errorSummary ?? model.summary)
    : model.state === 'stopped'
      ? (model.summary !== '' ? model.summary : tr('已停止', 'Stopped'))
      : model.summary

  const statusText = model.state === 'preparing'
    ? tr('正在准备调用', 'Preparing tool call')
    : model.state === 'running'
      ? tr('运行中', 'Running')
      : model.state === 'error'
        ? tr('失败', 'Failed')
        : model.state === 'stopped'
          ? tr('已停止', 'Stopped')
          : null

  const canOpenFile = model.state === 'ok' && model.filePath !== undefined && openFile !== undefined
  const handleOpenFile = useCallback((event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation()
    if (model.filePath === undefined || openFile === undefined) return
    if (model.filePathLine === undefined) openFile(model.filePath)
    else openFile(model.filePath, { line: model.filePathLine })
  }, [model.filePath, model.filePathLine, openFile])

  const stopLinkKeyDown = useCallback((event: KeyboardEvent<HTMLElement>) => {
    if (event.key === 'Enter' || event.key === ' ') event.stopPropagation()
  }, [])

  const diffLabels = useMemo<DiffBlockLabels>(() => ({
    codeLabel: tr('代码', 'Code'),
    wrapLabel: tr('自动换行', 'Wrap'),
    unwrapLabel: tr('取消换行', 'Unwrap'),
    copy: tr('复制', 'Copy'),
    copied: tr('已复制', 'Copied'),
    collapseAria: tr('收起差异', 'Collapse diff'),
    expandAria: count => tr(`展开剩余 ${count} 行`, `Expand ${count} more lines`),
    collapse: tr('收起', 'Collapse'),
    expand: count => tr(`展开其余 ${count} 行`, `Show ${count} more lines`),
  }), [tr])

  const collapsedContent = useMemo<ReactNode>(() => (
    summaryText !== '' ? (
      <>
        <span className="ntr-tool-sep" data-shimmer-decoration aria-hidden />
        {canOpenFile ? (
          <button
            type="button"
            className="ntr-tool-file-link"
            onClick={handleOpenFile}
            onKeyDown={stopLinkKeyDown}
          >
            <TextShimmerOrSpan>{summaryText}</TextShimmerOrSpan>
          </button>
        ) : (
          <span
            className={`ntr-tool-summary${model.state === 'error' ? ' is-error' : model.state === 'stopped' ? ' is-stopped' : ''}`}
          >
            <TextShimmerOrSpan>{summaryText}</TextShimmerOrSpan>
          </span>
        )}
      </>
    ) : null
  ), [summaryText, canOpenFile, handleOpenFile, stopLinkKeyDown, model.state])

  const HostDisclosureRow = resolvePrimitive<DisclosureRowProps>('DisclosureRow')
  const RowComponent = HostDisclosureRow ?? FallbackDisclosureRow
  const HostDiffBlock = resolvePrimitive<DiffBlockProps>('DiffBlock')
  const InspectIcon = resolvePrimitive<IconProps>('IconInspectOutlineRegular')

  return (
    <div
      className="ntr-tool-root"
      data-category={model.category}
      data-tool={model.toolName ?? props.toolName}
      data-state={model.state}
    >
      {statusText !== null && <span className="ntr-tool-visually-hidden">{statusText}</span>}
      <RowComponent
        rowClassName="ntr-tool-row"
        leadingClassName="ntr-tool-leading"
        titleClassName="ntr-tool-title"
        icon={<CategoryIcon category={model.iconKey} />}
        title={titleText}
        running={running}
        open={open}
        expandable={expandable}
        expandOnRowClick
        keepContentWhenOpen
        onToggle={toggle}
        collapsedContent={collapsedContent}
      >
        {open && (
          <div className="ntr-tool-body-wrap">
            {hasDiffs && model.diffs !== undefined && (
              HostDiffBlock !== undefined
                ? <HostDiffBlock diffs={model.diffs} labels={diffLabels} maxLines={CHAT_DIFF_MAX_LINES} className="ntr-tool-diff-body" />
                : <FallbackDiffView diffs={model.diffs} />
            )}
            {hasIo && (
              <div className="ntr-tool-io-card">
                {model.inputText !== undefined && (
                  <div className="ntr-tool-io-section">
                    <span className="ntr-tool-io-label">{tr('输入', 'IN')}</span>
                    <span
                      className={`ntr-tool-io-text${model.inputIsCommand ? ' is-command' : ''}`}
                      data-command={model.inputIsCommand || undefined}
                    >
                      {model.inputText}
                    </span>
                  </div>
                )}
                {model.inputText !== undefined && model.outputText !== undefined && (
                  <span className="ntr-tool-io-divider" aria-hidden />
                )}
                {model.outputText !== undefined && (
                  <div className="ntr-tool-io-section">
                    <span className="ntr-tool-io-label">{tr('输出', 'OUT')}</span>
                    <span className="ntr-tool-io-text" data-error={model.state === 'error' || undefined}>
                      {model.outputText}
                    </span>
                  </div>
                )}
              </div>
            )}
            {inspect !== undefined && (
              <button type="button" className="ntr-tool-inspect" onClick={inspect}>
                {InspectIcon !== undefined && <InspectIcon size={12} />}
                {tr('查看', 'Inspect')}
              </button>
            )}
          </div>
        )}
      </RowComponent>
    </div>
  )
}

/**
 * Register `AcpToolRow` into the host's keyed `tool.call.toolview` slot for
 * `dsh_ntr__acp_tool_call`. Safely no-ops on older hosts that do not expose
 * `tool.call.toolview`.
 */
export function installAcpToolView(ctx: Context, store: AcpStore): () => void {
  try {
    const slots = (ctx as unknown as {
      slots?: {
        inject?: (slot: string, factory: () => () => void) => () => void
        register?: (meta: Record<string, unknown>, component: unknown) => () => void
      }
    }).slots
    if (typeof slots?.inject !== 'function' || typeof slots.register !== 'function') return () => {}
    const register = slots.register.bind(slots)
    return slots.inject('tool.call.toolview', () => {
      try {
        return register({
          name: 'tool.call.toolview',
          key: ACP_TOOL_CALL_NAME,
          inject: () => ({ acp: store }),
        }, AcpToolRow)
      } catch {
        return () => {}
      }
    })
  } catch {
    return () => {}
  }
}
