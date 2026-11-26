// @vitest-environment jsdom
import { createElement } from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { permissionOptionWarning, permissionReplayFrames, permissionRequestFrame, SECURITY_WARNING_MAX_CHARS } from '../src/impl.ts'
import { PermissionDock } from '../src/client/permission-dock.tsx'
import { PermissionMirrorCard } from '../src/client/panel/permission-mirror.tsx'
import type { AcpStore, PendingPermission, UiState } from '../src/client/store.ts'

afterEach(() => {
  cleanup()
})

function fakeStore(permissions: PendingPermission[]): AcpStore {
  const snapshot = { permissions, elicitations: [] } as unknown as UiState
  return {
    getSnapshot: () => snapshot,
    subscribe: () => () => undefined,
    label: (_zh: string, en: string) => en,
    respondPermission: vi.fn(async () => undefined),
  } as unknown as AcpStore
}

describe('agy.security.warning extraction and rendering', () => {
  it('extracts string or {title, message} warnings, bounds length, and ignores absent metadata', () => {
    expect(permissionOptionWarning({ optionId: 'o1', name: 'Allow once', kind: 'allow_once' })).toBeUndefined()
    expect(permissionOptionWarning({
      optionId: 'o2',
      name: 'Allow Always',
      kind: 'allow_always',
      _meta: { 'agy.security.warning': 'Persists across future turns' },
    })).toBe('Persists across future turns')

    expect(permissionOptionWarning({
      optionId: 'o3',
      name: 'Allow for thread',
      kind: 'allow_always',
      _meta: { 'agy.security.warning': { title: 'Broad trust', message: 'Applies to every file in this workspace' } },
    })).toBe('Broad trust: Applies to every file in this workspace')

    expect(permissionOptionWarning({
      optionId: 'o4',
      name: 'Allow',
      kind: 'allow_always',
      _meta: { 'agy.security.warning': { title: 'High risk' } },
    })).toBe('High risk')

    const long = 'x'.repeat(SECURITY_WARNING_MAX_CHARS + 50)
    const bounded = permissionOptionWarning({
      optionId: 'o5',
      name: 'Allow',
      kind: 'allow_always',
      _meta: { 'agy.security.warning': { message: long } },
    })
    expect(bounded).toHaveLength(SECURITY_WARNING_MAX_CHARS)
    expect(bounded?.endsWith('…')).toBe(true)
  })

  it('preserves option warnings byte-for-byte in permissionRequestFrame and permissionReplayFrames', () => {
    const view = {
      requestId: 'req-w1',
      sessionId: 'acp-w1',
      dshSessionId: 'chat-w1',
      toolCall: { toolCallId: 'tc-1', title: 'bash' },
      toolName: 'bash',
      options: [
        { optionId: 'once', name: 'Allow once', kind: 'allow_once' },
        { optionId: 'always', name: 'Allow always', kind: 'allow_always', warning: 'Grants permanent shell access' },
      ],
      timeoutMode: 'wait' as const,
    }
    const live = permissionRequestFrame(view)
    const [replayed] = permissionReplayFrames([view])
    expect(replayed).toEqual(live)
    expect((live as { options: Array<{ warning?: string }> }).options[1]?.warning).toBe('Grants permanent shell access')
  })

  it('renders warning in PermissionDock and PermissionMirrorCard, and emits zero warning DOM when absent', () => {
    const withWarning: PendingPermission = {
      requestId: 'req-w2',
      sessionId: 'acp-w2',
      dshSessionId: 'chat-w2',
      toolCall: { toolCallId: 'tc-2', title: 'bash' },
      toolName: 'bash',
      options: [
        { optionId: 'once', name: 'Allow once', kind: 'allow_once' },
        { optionId: 'always', name: 'Allow always', kind: 'allow_always', warning: 'Permanent permission risk' },
      ],
      timeoutMode: 'wait',
    }
    const dockWith = render(createElement(PermissionDock, { acp: fakeStore([withWarning]), sessionId: 'chat-w2' }))
    expect(screen.getByText('Permanent permission risk')).toBeTruthy()
    expect(dockWith.container.querySelectorAll('.ntr-permission-warning')).toHaveLength(1)
    cleanup()

    const mirrorWith = render(createElement(PermissionMirrorCard, { acp: fakeStore([withWarning]), ui: fakeStore([withWarning]).getSnapshot() }))
    expect(screen.getByText('Permanent permission risk')).toBeTruthy()
    expect(mirrorWith.container.querySelectorAll('.ntr-permission-warning')).toHaveLength(1)
    cleanup()

    const withoutWarning: PendingPermission = {
      ...withWarning,
      options: [{ optionId: 'once', name: 'Allow once', kind: 'allow_once' }],
    }
    const dockPlain = render(createElement(PermissionDock, { acp: fakeStore([withoutWarning]), sessionId: 'chat-w2' }))
    expect(dockPlain.container.querySelector('.ntr-permission-warnings')).toBeNull()
    cleanup()

    const mirrorPlain = render(createElement(PermissionMirrorCard, { acp: fakeStore([withoutWarning]), ui: fakeStore([withoutWarning]).getSnapshot() }))
    expect(mirrorPlain.container.querySelector('.ntr-permission-warnings')).toBeNull()
  })
})
