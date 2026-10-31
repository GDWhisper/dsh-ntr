/**
 * Type shim for `@deepseek-ai/dsh-client-ui-primitives` — a HOST-provided
 * client module (resolved by the shell's lazy CJS module table at runtime, so
 * it is intentionally absent from devDependencies and listed in
 * tsdown.config.mjs's EXTERNAL + package.json `dsh.client.inject`).
 *
 * Only the members this bundle uses are declared, structurally: the host
 * package is not part of a plugin's dependency closure, and the full surface
 * would be a second copy of types this plugin cannot import anyway. The
 * branch icons are the candidates the host's own branch button renders
 * (`MessageIconActions`) across shipped host generations — desktop 0.2.1-rc.2
 * exports `IconBranchOutlineRegular` (and `…Medium`) but NOT `…16`, while
 * newer packages export `…16` — which is why `branch-action.tsx` picks the
 * first present one instead of hard-importing a single name.
 */
declare module '@deepseek-ai/dsh-client-ui-primitives' {
  import type { ComponentType, ReactNode } from 'react'

  export const IconBranchOutline16: ComponentType<Record<string, never>> | undefined
  export const IconBranchOutlineRegular: ComponentType<Record<string, never>> | undefined
  export const IconBranchOutlineMedium: ComponentType<Record<string, never>> | undefined
  export const Tooltip: ComponentType<{
    label: ReactNode
    side?: 'top' | 'bottom' | 'left' | 'right'
    children: ReactNode
  }>
}
