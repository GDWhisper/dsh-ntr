/**
 * Test stand-in for the host's `@deepseek-ai/dsh-client-ui-primitives` (see
 * vitest.config.ts): the real module lives in the shell's runtime module
 * table, so tests bind a structural stub — the Tooltip renders its children
 * inline and the icon is an empty marker, which is all the branch action's
 * tests need to observe.
 */
import type { ReactNode } from 'react'

export function IconBranchOutline16(): null {
  return null
}

export function Tooltip(props: { label?: unknown; side?: unknown; children: ReactNode }): ReactNode {
  return props.children
}
