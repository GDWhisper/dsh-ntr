/**
 * Type shim for `@deepseek-ai/dsh-client-ui-primitives` — a HOST-provided
 * client module (resolved by the shell's lazy CJS module table at runtime, so
 * it is intentionally absent from devDependencies and listed in
 * tsdown.config.mjs's EXTERNAL + package.json `dsh.client.inject`).
 *
 * Only the members this bundle uses are declared, structurally: the host
 * package is not part of a plugin's dependency closure, and the full surface
 * would be a second copy of types this plugin cannot import anyway. Older
 * hosts may omit newer exports, so consumers resolve optional members via the
 * module namespace with safe runtime fallbacks (`branch-action.tsx`,
 * `acp-tool-view.tsx`).
 */
declare module '@deepseek-ai/dsh-client-ui-primitives' {
  import type { ComponentType, ReactNode } from 'react'

  export interface IconProps {
    size?: number
    className?: string
  }

  export interface DiffHunk {
    path: string
    oldText: string | null
    newText: string
  }

  export interface CodeToolbarLabels {
    codeLabel: string
    wrapLabel: string
    unwrapLabel: string
  }

  export interface DiffBlockLabels extends CodeToolbarLabels {
    copy: string
    copied: string
    collapseAria: string
    expandAria: (count: number) => string
    collapse: string
    expand: (count: number) => string
  }

  export interface DiffBlockProps {
    diffs: readonly DiffHunk[]
    labels: DiffBlockLabels
    maxLines?: number
    className?: string
  }

  export interface DisclosureRowProps {
    icon: ReactNode
    title: ReactNode
    open: boolean
    expandable: boolean
    onToggle: () => void
    running?: boolean
    expandOnRowClick?: boolean
    previewChevron?: boolean
    keepContentWhenOpen?: boolean
    collapsedContent?: ReactNode
    headerAccessory?: ReactNode
    children?: ReactNode
    className?: string
    rowClassName?: string
    contentClassName?: string
    contentLayoutClassName?: string
    leadingClassName?: string
    chevronClassName?: string
    titleClassName?: string
  }

  export interface TextShimmerProps {
    children: ReactNode
    active?: boolean
    className?: string
    contentClassName?: string
  }

  export const IconBranchOutline16: ComponentType<IconProps> | undefined
  export const IconBranchOutlineRegular: ComponentType<IconProps> | undefined
  export const IconBranchOutlineMedium: ComponentType<IconProps> | undefined
  export const IconApiOutlineRegular: ComponentType<IconProps> | undefined
  export const IconBrowseOutlineRegular: ComponentType<IconProps> | undefined
  export const IconEditOutlineRegular: ComponentType<IconProps> | undefined
  export const IconTrashOutlineRegular: ComponentType<IconProps> | undefined
  export const IconFolderOpenOutlineRegular: ComponentType<IconProps> | undefined
  export const IconSearchOutlineRegular: ComponentType<IconProps> | undefined
  export const IconGlobeOutlineRegular: ComponentType<IconProps> | undefined
  export const IconThinkOutlineRegular: ComponentType<IconProps> | undefined
  export const IconUsersOutlineRegular: ComponentType<IconProps> | undefined
  export const IconChecklistOutlineRegular: ComponentType<IconProps> | undefined
  export const IconSparkleRegular: ComponentType<IconProps> | undefined
  export const IconInspectOutlineRegular: ComponentType<IconProps> | undefined

  export const DisclosureRow: ComponentType<DisclosureRowProps> | undefined
  export const TextShimmer: ComponentType<TextShimmerProps> | undefined
  export const DiffBlock: ComponentType<DiffBlockProps> | undefined

  export const Tooltip: ComponentType<{
    label: ReactNode
    side?: 'top' | 'bottom' | 'left' | 'right'
    children: ReactNode
  }>
}
