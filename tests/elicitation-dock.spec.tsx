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

  it('pages through fields, validates each step, and preserves every answer', () => {
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
    expect(screen.getByText('Question 1 of 4')).toBeTruthy()
    expect(screen.queryByText('Release Tag')).toBeNull()

    // Each page validates its own required answer before advancing.
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    expect(screen.getByRole('alert')).toBeTruthy()
    expect(respond).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('radio', { name: /Blue\/Green/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'Lint' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'Unit Tests' }))
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    fireEvent.click(screen.getByLabelText('Send Notification'))
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    fireEvent.change(screen.getByLabelText('Release Tag'), { target: { value: 'v1.2.3' } })

    // Going back keeps earlier answers without resubmitting partial content.
    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    expect(screen.getByLabelText('Send Notification')).toHaveProperty('checked', true)
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    expect(screen.getByLabelText('Release Tag')).toHaveProperty('value', 'v1.2.3')
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

  it('keeps decline and cancel available on an intermediate page', async () => {
    const { acp, respond } = fakeStore([
      {
        requestId: 'req-paged',
        sessionId: 's1',
        dshSessionId: 'chat-1',
        message: 'Two questions',
        fields: [
          { name: 'first', kind: 'string', title: 'First', required: false },
          { name: 'second', kind: 'string', title: 'Second', required: false },
        ],
      },
    ])
    render(createElement(ElicitationDock, { acp, sessionId: 'chat-1' }))
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Decline' })) })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Cancel' })) })
    expect(respond).toHaveBeenNthCalledWith(1, 'req-paged', { action: 'decline' })
    expect(respond).toHaveBeenNthCalledWith(2, 'req-paged', { action: 'cancel' })
  })

  it('keeps two cards on independent pages and submits them separately', () => {
    const twoFields = (prefix: string) => [
      { name: `${prefix}-first`, kind: 'string' as const, title: `${prefix} first`, required: false },
      { name: `${prefix}-second`, kind: 'string' as const, title: `${prefix} second`, required: false },
    ]
    const { acp, respond } = fakeStore([
      { requestId: 'req-a', sessionId: 's1', dshSessionId: 'chat-1', message: 'Card A', fields: twoFields('a') },
      { requestId: 'req-b', sessionId: 's1', dshSessionId: 'chat-1', message: 'Card B', fields: twoFields('b') },
    ])
    render(createElement(ElicitationDock, { acp, sessionId: 'chat-1' }))
    fireEvent.change(screen.getByLabelText('a first'), { target: { value: 'answer a1' } })
    fireEvent.click(screen.getAllByRole('button', { name: 'Next' })[0]!)
    fireEvent.change(screen.getByLabelText('a second'), { target: { value: 'answer a2' } })
    expect(screen.getByText('Question 1 of 2')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }))
    expect(respond).toHaveBeenCalledWith('req-a', { action: 'accept', content: { 'a-first': 'answer a1', 'a-second': 'answer a2' } })
    expect(screen.getByText('a second')).toBeTruthy()
    expect(screen.getByLabelText('b first')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    fireEvent.click(screen.getAllByRole('button', { name: 'Submit' })[1]!)
    expect(respond).toHaveBeenLastCalledWith('req-b', { action: 'accept', content: {} })
  })

  it('disables a card while submitting and preserves its page after failure', async () => {
    let settle!: (answer: unknown) => void
    let attempts = 0
    const respond = vi.fn(() => new Promise((_resolve, reject) => {
      attempts += 1
      settle = attempts === 1 ? () => { reject(new Error('network down')) } : () => { _resolve(undefined) }
    }))
    const request: PendingElicitation = {
      requestId: 'req-retry', sessionId: 's1', dshSessionId: 'chat-1', message: 'Retry',
      fields: [
        { name: 'first', kind: 'string', title: 'First', required: false },
        { name: 'second', kind: 'string', title: 'Second', required: false },
      ],
    }
    const snapshot = { elicitations: [request] } as unknown as UiState
    const acp = {
      getSnapshot: () => snapshot, subscribe: () => () => undefined,
      label: (_zh: string, en: string) => en, respondElicitation: respond,
    } as unknown as AcpStore
    render(createElement(ElicitationDock, { acp, sessionId: 'chat-1' }))
    fireEvent.change(screen.getByLabelText('First'), { target: { value: 'kept' } })
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }))
    expect(screen.getByRole('button', { name: 'Submit' })).toHaveProperty('disabled', true)
    await act(async () => { settle(undefined) })
    expect(respond).toHaveBeenCalledTimes(1)
    expect(screen.getByText('network down')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    expect(screen.getByLabelText('First')).toHaveProperty('value', 'kept')
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Submit' })) })
    expect(respond).toHaveBeenCalledTimes(2)
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

  it('keeps a select question and its trailing *_other custom field on one unpaged card', () => {
    const { acp, respond } = fakeStore([
      {
        requestId: 'req-agy-1',
        sessionId: 's1',
        dshSessionId: 'chat-1',
        message: 'The agent has a question.',
        fields: [
          {
            name: 'q1',
            kind: 'single-select',
            title: 'Which option?',
            required: false,
            options: [
              { value: '1', label: 'Option A' },
              { value: '2', label: 'Option B' },
            ],
          },
          {
            name: 'q1_other',
            kind: 'string',
            title: 'Other',
            description: 'Optional free-form answer to: Which option?',
            required: false,
          },
        ],
      },
    ])

    render(createElement(ElicitationDock, { acp, sessionId: 'chat-1' }))
    expect(screen.queryByText(/Question 1 of/)).toBeNull()
    expect(screen.queryByRole('button', { name: 'Next' })).toBeNull()
    expect(screen.getByRole('radio', { name: 'Option A' })).toBeTruthy()
    fireEvent.change(screen.getByLabelText(/Other/), { target: { value: 'custom reply' } })
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }))
    expect(respond).toHaveBeenCalledWith('req-agy-1', { action: 'accept', content: { q1_other: 'custom reply' } })
  })

  it('pages two choice+other questions into 2 logical steps instead of 4', () => {
    const { acp, respond } = fakeStore([
      {
        requestId: 'req-agy-2',
        sessionId: 's1',
        dshSessionId: 'chat-1',
        message: 'The agent has questions.',
        fields: [
          {
            name: 'q1',
            kind: 'single-select',
            title: 'First question',
            required: false,
            options: [{ value: '1', label: 'First A' }],
          },
          { name: 'q1_other', kind: 'string', title: 'Other', required: false },
          {
            name: 'q2',
            kind: 'single-select',
            title: 'Second question',
            required: false,
            options: [{ value: '1', label: 'Second A' }],
          },
          { name: 'q2_other', kind: 'string', title: 'Other', required: false },
        ],
      },
    ])

    render(createElement(ElicitationDock, { acp, sessionId: 'chat-1' }))
    expect(screen.getByText('Question 1 of 2')).toBeTruthy()
    expect(screen.getByLabelText('Other')).toBeTruthy()
    fireEvent.click(screen.getByRole('radio', { name: 'First A' }))
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    expect(screen.getByText('Question 2 of 2')).toBeTruthy()
    fireEvent.change(screen.getByLabelText('Other'), { target: { value: 'custom 2' } })
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }))
    expect(respond).toHaveBeenCalledWith('req-agy-2', {
      action: 'accept',
      content: { q1: '1', q2_other: 'custom 2' },
    })
  })
})
