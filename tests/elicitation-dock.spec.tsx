// @vitest-environment jsdom
/**
 * Composer elicitation dock DOM tests: renders pending form questions only for
 * the matching DSH conversation, validates required fields inline, and submits
 * accept / decline / cancel responses through `AcpStore.respondElicitation`.
 */

import { createElement } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ElicitationDock } from '../src/client/elicitation-dock.tsx'
import type { AcpStore, PendingElicitation, UiState } from '../src/client/store.ts'

afterEach(cleanup)

function fakeStore(elicitations: PendingElicitation[]): {
  acp: AcpStore
  respond: ReturnType<typeof vi.fn>
} {
  const respond = vi.fn(async () => undefined)
  const snapshot = { elicitations } as unknown as UiState
  const acp = {
    getSnapshot: () => snapshot,
    subscribe: () => () => undefined,
    label: (_zh: string, en: string) => en,
    respondElicitation: respond,
  } as unknown as AcpStore
  return { acp, respond }
}

describe('ElicitationDock', () => {
  it('renders nothing when no elicitation matches the session', () => {
    const { acp } = fakeStore([
      { requestId: 'r1', sessionId: 's1', dshSessionId: 'other-chat', message: 'Q', fields: [] },
    ])
    const { container } = render(createElement(ElicitationDock, { acp, sessionId: 'chat-1' }))
    expect(container.firstChild).toBeNull()
  })

  it('renders form fields, validates required fields, and submits selected answers', () => {
    const { acp, respond } = fakeStore([
      {
        requestId: 'req-42',
        sessionId: 's1',
        dshSessionId: 'chat-1',
        message: 'Confirm deployment options',
        fields: [
          {
            name: 'strategy',
            kind: 'single-select',
            title: 'Deploy Strategy',
            required: true,
            options: [
              { value: 'blue', label: 'Blue/Green', description: 'Zero downtime' },
              { value: 'rolling', label: 'Rolling' },
            ],
          },
          {
            name: 'checks',
            kind: 'multi-select',
            title: 'Checks',
            required: false,
            options: [
              { value: 'lint', label: 'Lint' },
              { value: 'test', label: 'Unit Tests' },
            ],
          },
          {
            name: 'notify',
            kind: 'boolean',
            title: 'Send Notification',
            required: false,
          },
          {
            name: 'tag',
            kind: 'string',
            title: 'Release Tag',
            required: false,
          },
        ],
      },
    ])

    render(createElement(ElicitationDock, { acp, sessionId: 'chat-1' }))
    expect(screen.getByText('Confirm deployment options')).toBeTruthy()

    // Submitting before selecting required field shows inline error and does not call RPC.
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }))
    expect(screen.getByRole('alert')).toBeTruthy()
    expect(respond).not.toHaveBeenCalled()

    // Select single-select, multi-select, boolean, and string fields.
    fireEvent.click(screen.getByRole('radio', { name: /Blue\/Green/ }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'Lint' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'Unit Tests' }))
    fireEvent.click(screen.getByLabelText('Send Notification'))
    fireEvent.change(screen.getByLabelText('Release Tag'), { target: { value: 'v1.2.3' } })

    fireEvent.click(screen.getByRole('button', { name: 'Submit' }))
    expect(respond).toHaveBeenCalledWith('req-42', {
      action: 'accept',
      content: {
        strategy: 'blue',
        checks: ['lint', 'test'],
        notify: true,
        tag: 'v1.2.3',
      },
    })
  })

  it('surfaces fields and options omitted at the schema caps', () => {
    const { acp } = fakeStore([
      {
        requestId: 'req-cap',
        sessionId: 's1',
        dshSessionId: 'chat-1',
        message: 'Too much schema',
        fields: [],
        omittedFields: 3,
        omittedOptions: 5,
      },
    ])
    render(createElement(ElicitationDock, { acp, sessionId: 'chat-1' }))
    expect(screen.getByText('Content over the cap was omitted: 3 field(s), 5 option(s)')).toBeTruthy()
  })

  it('renders deadline countdown and sends both decline and cancel actions', async () => {
    const { acp, respond } = fakeStore([
      {
        requestId: 'req-7',
        sessionId: 's1',
        dshSessionId: 'chat-1',
        message: 'Optional input',
        fields: [],
        deadlineAt: Date.now() + 65_000,
      },
    ])
    render(createElement(ElicitationDock, { acp, sessionId: 'chat-1' }))
    expect(screen.getByText(/left/)).toBeTruthy()

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Decline' }))
    })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    })
    expect(respond).toHaveBeenNthCalledWith(1, 'req-7', { action: 'decline' })
    expect(respond).toHaveBeenNthCalledWith(2, 'req-7', { action: 'cancel' })
  })
})
