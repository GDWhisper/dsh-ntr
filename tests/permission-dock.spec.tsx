// @vitest-environment jsdom
/**
 * Composer permission dock DOM tests: distinguishes fixed-choice question
 * asks (`askKind: 'question'`) from tool approvals, avoids inventing answers
 * when the host sent no `autoOptionName`, and keeps countdowns ticking under
 * default `wait` approval mode.
 */

import { createElement } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PermissionDock } from '../src/client/permission-dock.tsx'
import type { AcpStore, PendingPermission, UiState } from '../src/client/store.ts'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

function fakeStore(permissions: PendingPermission[]): {
  acp: AcpStore
  respond: ReturnType<typeof vi.fn>
} {
  const respond = vi.fn(async () => undefined)
  const snapshot = { permissions } as unknown as UiState
  const acp = {
    getSnapshot: () => snapshot,
    subscribe: () => () => undefined,
    label: (_zh: string, en: string) => en,
    respondPermission: respond,
  } as unknown as AcpStore
  return { acp, respond }
}

const OPTIONS = [
  { optionId: 'opt-1', name: 'Blue/Green', kind: 'allow_once' },
  { optionId: 'opt-2', name: 'Canary', kind: 'allow_always' },
]

describe('PermissionDock', () => {
  it('renders question morphology cleanly without tool name or guessed options', () => {
    const { acp, respond } = fakeStore([
      {
        requestId: 'req-q1',
        sessionId: 's1',
        dshSessionId: 'chat-1',
        toolCall: { toolCallId: 'interaction_1', title: 'HiddenToolName' },
        toolName: 'HiddenToolName',
        reason: 'Which rollout strategy?',
        options: OPTIONS,
        timeoutMode: 'wait',
        deadlineAt: Date.now() + 60_000,
        askKind: 'question',
        questionTimeoutMode: 'first',
        autoOptionName: 'Blue/Green',
      },
    ])

    const { container } = render(createElement(PermissionDock, { acp, sessionId: 'chat-1' }))
    expect(screen.getByText('Which rollout strategy?')).toBeTruthy()
    expect(screen.queryByText('HiddenToolName')).toBeNull()
    expect(container.querySelector('.ntr-permission-card.is-question')).toBeTruthy()
    expect(container.querySelector('.ntr-permission-actions.is-question')).toBeTruthy()
    expect(screen.getByText('On expiry, “Blue/Green” is sent for you')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Canary' }))
    expect(respond).toHaveBeenCalledWith('req-q1', 'opt-2')
  })

  it('never guesses options[0] when autoOptionName is missing and omits expiry line when unlimited', () => {
    const { acp } = fakeStore([
      {
        requestId: 'req-q2',
        sessionId: 's1',
        dshSessionId: 'chat-1',
        toolCall: { toolCallId: 'interaction_2' },
        toolName: 'Pick one',
        reason: 'Missing autoOptionName',
        options: OPTIONS,
        timeoutMode: 'wait',
        deadlineAt: Date.now() + 60_000,
        askKind: 'question',
        questionTimeoutMode: 'first',
      },
      {
        requestId: 'req-q3',
        sessionId: 's1',
        dshSessionId: 'chat-1',
        toolCall: { toolCallId: 'interaction_3' },
        toolName: 'No limit',
        reason: 'Unlimited question',
        options: OPTIONS,
        timeoutMode: 'wait',
        askKind: 'question',
        questionTimeoutMode: 'first',
      },
    ])

    render(createElement(PermissionDock, { acp, sessionId: 'chat-1' }))
    expect(screen.queryByText(/Blue\/Green.*sent for you/)).toBeNull()
    expect(screen.getAllByText('On expiry the question is cancelled — nothing is chosen for you')).toHaveLength(1)
  })

  it('ticks question countdown every second even when approval timeoutMode is `wait`', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-11-26T12:00:00Z'))
    const { acp } = fakeStore([
      {
        requestId: 'req-q-tick',
        sessionId: 's1',
        dshSessionId: 'chat-1',
        toolCall: { toolCallId: 'interaction_tick' },
        toolName: 'Tick question',
        reason: 'Will countdown move?',
        options: OPTIONS,
        timeoutMode: 'wait',
        deadlineAt: Date.now() + 10_000,
        askKind: 'question',
        questionTimeoutMode: 'cancel',
      },
    ])

    render(createElement(PermissionDock, { acp, sessionId: 'chat-1' }))
    expect(screen.getByText('10s left')).toBeTruthy()
    act(() => { vi.advanceTimersByTime(3_000) })
    expect(screen.getByText('7s left')).toBeTruthy()
  })

  it('keeps approval rendering unchanged', () => {
    const { acp } = fakeStore([
      {
        requestId: 'req-app',
        sessionId: 's1',
        dshSessionId: 'chat-1',
        toolCall: { toolCallId: 'call_1', title: 'Write file' },
        toolName: 'Write file',
        reason: 'src/app.ts',
        options: OPTIONS,
        timeoutMode: 'wait',
      },
    ])

    const { container } = render(createElement(PermissionDock, { acp, sessionId: 'chat-1' }))
    expect(screen.getByText('Write file')).toBeTruthy()
    expect(screen.getByText('src/app.ts')).toBeTruthy()
    expect(container.querySelector('.ntr-permission-card.is-question')).toBeNull()
    expect(container.querySelector('.ntr-permission-actions.is-question')).toBeNull()
  })
})
