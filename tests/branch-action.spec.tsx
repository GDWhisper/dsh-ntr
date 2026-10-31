// @vitest-environment jsdom
import { createElement } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AcpBranchAction, resolveHostFork } from '../src/client/branch-action.tsx'
import { AcpStore } from '../src/client/store.ts'
import type { AcpChatInjected, AcpHostForkFace } from '../src/client/acp-ui.tsx'

afterEach(cleanup)

class MockHostSessionsService {
  list = {
    getSnapshot() {
      return [{ sessionId: 'chat-1', title: 'Main conversation' }]
    },
  }

  async fork(options: { sessionId: string; increaseTitle?: boolean }) {
    // Reproduces DSH host's implementation requirement:
    // accessing `this.list.getSnapshot()`
    const snapshot = this.list.getSnapshot()
    if (!snapshot || snapshot.length === 0) throw new Error('no session in list')
    return `${options.sessionId}-child`
  }
}

function createTestStore() {
  return new AcpStore(async (_channel, endpoint, payload) => {
    if (endpoint === 'session/chat-list') {
      return {
        ok: true,
        value: {
          sessions: [{ sessionId: 'acp-1', agentId: 'pi', fork: { supported: true } }],
          acpMode: true,
        },
      }
    }
    if (endpoint === 'session/chat-fork-adopt') {
      return { ok: true, value: { done: true } }
    }
    return { ok: true, value: {} }
  }, zh => zh)
}

function renderBranchAction(options: {
  store: AcpStore
  hostFork?: () => AcpHostForkFace | undefined
  openSession?: (id: string) => void
  actionsReveal?: string
  hostUnavailable?: boolean
}) {
  const container = document.createElement('div')
  container.setAttribute('data-turn-tail', '')
  container.setAttribute('data-actions-reveal', options.actionsReveal ?? 'always')

  const hostButton = document.createElement('button')
  hostButton.setAttribute('aria-label', '在新对话中分支')
  if (options.hostUnavailable) {
    hostButton.setAttribute('data-unavailable', '')
  }
  container.appendChild(hostButton)
  document.body.appendChild(container)

  const props: AcpChatInjected & { sessionId: string } = {
    sessionId: 'chat-1',
    acp: options.store,
    faceFor: () => undefined,
    hostFork: options.hostFork,
    openSession: options.openSession,
  }

  const result = render(createElement(AcpBranchAction, props), { container })
  return { ...result, container }
}

describe('AcpBranchAction component and resolveHostFork integration', () => {
  it('successfully branches conversation when hostFork is bound via resolveHostFork', async () => {
    const store = createTestStore()
    await store.loadChatSessions('chat-1')

    const hostService = new MockHostSessionsService()
    const openSession = vi.fn()

    renderBranchAction({
      store,
      hostFork: () => resolveHostFork(hostService),
      openSession,
    })

    const ntrButton = screen.getByRole('button', { name: '在新对话中分支' })
    expect(ntrButton).toBeDefined()
    expect(ntrButton.getAttribute('data-ntr-branch')).toBe('')
    expect(ntrButton.hasAttribute('data-unavailable')).toBe(false)

    await act(async () => {
      fireEvent.click(ntrButton)
    })

    expect(openSession).toHaveBeenCalledWith('chat-1-child')
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('fails with Cannot read properties of undefined (reading getSnapshot) if fork is unbound', async () => {
    const store = createTestStore()
    await store.loadChatSessions('chat-1')

    const hostService = new MockHostSessionsService()
    const openSession = vi.fn()

    // Reproduces the exact buggy pattern that previously discarded `this` context:
    const buggyHostFork = () => {
      const fork = hostService.fork
      return typeof fork === 'function' ? { fork } : undefined
    }

    renderBranchAction({
      store,
      hostFork: buggyHostFork,
      openSession,
    })

    const ntrButton = screen.getByRole('button', { name: '在新对话中分支' })
    await act(async () => {
      fireEvent.click(ntrButton)
    })

    // openSession should NOT be called on failure
    expect(openSession).not.toHaveBeenCalled()

    // The failure line should be rendered in the document
    const alert = screen.getByRole('alert')
    expect(alert).toBeDefined()
    expect(alert.textContent).toContain("Cannot read properties of undefined (reading 'getSnapshot')")
  })

  it('renders disabled button when hostFork returns undefined (host unavailable)', async () => {
    const store = createTestStore()
    await store.loadChatSessions('chat-1')

    renderBranchAction({
      store,
      hostFork: () => undefined,
    })

    const ntrButton = screen.getByRole('button', { name: '在新对话中分支' })
    expect(ntrButton.getAttribute('aria-disabled')).toBe('true')
    expect(ntrButton.getAttribute('data-unavailable')).toBe('true')
  })

  it('renders inline failure alert when hostService.fork throws a custom error', async () => {
    const store = createTestStore()
    await store.loadChatSessions('chat-1')

    const hostService = {
      async fork() {
        throw new Error('disk full: unable to snapshot session')
      },
    }
    const openSession = vi.fn()

    renderBranchAction({
      store,
      hostFork: () => resolveHostFork(hostService),
      openSession,
    })

    const ntrButton = screen.getByRole('button', { name: '在新对话中分支' })
    await act(async () => {
      fireEvent.click(ntrButton)
    })

    expect(openSession).not.toHaveBeenCalled()
    const alert = screen.getByRole('alert')
    expect(alert).toBeDefined()
    expect(alert.textContent).toBe('disk full: unable to snapshot session')
  })

  it('renders disabled when not on the turn tail', async () => {
    const store = createTestStore()
    await store.loadChatSessions('chat-1')

    const hostService = new MockHostSessionsService()

    renderBranchAction({
      store,
      hostFork: () => resolveHostFork(hostService),
      actionsReveal: 'hover', // not 'always'
    })

    const ntrButton = screen.getByRole('button', { name: '在新对话中分支' })
    expect(ntrButton.getAttribute('aria-disabled')).toBe('true')
    expect(ntrButton.getAttribute('data-unavailable')).toBe('true')
  })
})

