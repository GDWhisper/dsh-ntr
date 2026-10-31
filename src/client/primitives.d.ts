/**
 * Type shim for `@deepseek-ai/dsh-client-ui-primitives` — a HOST-provided
 * client module (resolved by the shell's lazy CJS module table at runtime, so
 * it is intentionally absent from devDependencies and listed in
 * tsdown.config.mjs's EXTERNAL + package.json `dsh.client.inject`).
 *
 * Only the members this bundle uses are declared, structurally: the host
 * package is not part of a plugin's dependency closure, and the full surface
 * would be a second copy of types this plugin cannot import anyway. The icon
 * is the exact component the host's own branch button renders
 * (`MessageIconActions`), which is what keeps the self-drawn entry visually
 * identical to the icon it replaces.
 */
declare module '@deepseek-ai/dsh-client-ui-primitives' {
  import type { ComponentType, ReactNode } from 'react'

  export const IconBranchOutline16: ComponentType<Record<string, never>>
  export const Tooltip: ComponentType<{
    label: ReactNode
    side?: 'top' | 'bottom' | 'left' | 'right'
    children: ReactNode
  }>
}
