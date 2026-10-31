/**
 * Test stand-in for the host's `@deepseek-ai/dsh-client-ui-primitives` (see
 * vitest.config.ts): the real module lives in the shell's runtime module
 * table, so tests bind a structural stub — the Tooltip renders its children
 * inline and the icons are empty markers, which is all the branch action's
 * tests need to observe. All three branch-icon names exist here (the real
 * host generations each carry only some — see branch-action.tsx), so the
 * default pick resolves to `IconBranchOutline16`.
 */
import type { ReactNode } from 'react'

export function IconBranchOutline16(): null {
  return null
}

export function IconBranchOutlineRegular(): null {
  return null
}

export function IconBranchOutlineMedium(): null {
  return null
}

export function Tooltip(props: { label?: unknown; side?: unknown; children: ReactNode }): ReactNode {
  return props.children
}
