// @vitest-environment jsdom
// The agent card's「高级」default-mode control. It is a lightweight-RPC field
// (no save gate, no restart): a known catalog gives the agent's own mode list,
// an unread catalog leaves a raw mode-id input, and a stored value the catalog
// no longer offers stays visible as a warning instead of being cleared.
import { createElement } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { AgentDefaultMode } from '../../src/client/panel/agent-default-mode.tsx'
import type { AcpAgentDef, AgentProbeModelsResult } from '../../src/protocol.ts'
import { createPanelFixture } from '../panel-fixture.ts'

afterEach(cleanup)

const MODE_CATALOG: AgentProbeModelsResult = {
  agentId: 'codebuddy',
  updatedAt: 1,
  catalog: {
    mode: {
      configId: 'mode',
      name: 'Mode',
      currentValue: 'always-ask',
      choices: [
        { value: 'always-ask', name: 'Always Ask' },
        { value: 'bypass', name: 'Bypass Permissions' },
      ],
    },
  },
}

const AGENT: AcpAgentDef = {
  id: 'codebuddy',
  title: 'CodeBuddy',
  command: 'codebuddy',
  args: ['--acp'],
  cwd: '/workspace/ntr-demo',
  allowedCwdRoots: ['/workspace/ntr-demo'],
}

async function mount(options: Parameters<typeof createPanelFixture>[0] = {}) {
  const fixture = createPanelFixture(options)
  await fixture.ready
  // The models tab owns the cache read; seed the same in-memory snapshot the
  // advanced control reads before rendering it in isolation.
  await fixture.store.loadCachedModels('codebuddy')
  render(createElement(AgentDefaultMode, { acp: fixture.store, agentId: 'codebuddy' }))
  return fixture
}

describe('the agent default-mode control', () => {
  it('offers the cached mode list and writes the pick through the lightweight RPC', async () => {
    const fixture = await mount({ catalogs: { codebuddy: MODE_CATALOG } })
    const select = await screen.findByRole('combobox', { name: '默认模式（新对话）' }) as HTMLSelectElement
    expect(select.value).toBe('')
    expect(screen.getByRole('option', { name: '跟随智能体（当前：Always Ask）' })).toBeTruthy()
    expect(screen.getByRole('option', { name: 'Bypass Permissions' })).toBeTruthy()

    await act(async () => { fireEvent.change(select, { target: { value: 'bypass' } }) })
    await waitFor(() => {
      expect(fixture.calls).toContainEqual({
        channel: '/acp',
        endpoint: 'agent/set-default-mode',
        payload: { agentId: 'codebuddy', defaultMode: 'bypass' },
      })
    })
    // The host answer is the authority; the roster copy follows it.
    await waitFor(() => {
      expect(fixture.store.getSnapshot().detectedAgents.find(info => info.id === 'codebuddy')?.currentConfig?.defaultMode).toBe('bypass')
    })
    expect((await screen.findByRole('combobox', { name: '默认模式（新对话）' }) as HTMLSelectElement).value).toBe('bypass')
  })

  it('keeps a raw mode-id input when the catalog was never read, and commits on blur', async () => {
    const fixture = await mount({ catalogs: { codebuddy: null } })
    const input = screen.getByRole('textbox', { name: '默认模式（新对话）' }) as HTMLInputElement
    expect(input.value).toBe('')
    expect(screen.getByText(/目录未读取/)).toBeTruthy()

    await act(async () => {
      fireEvent.change(input, { target: { value: 'strict' } })
      fireEvent.blur(input)
    })
    await waitFor(() => {
      expect(fixture.calls).toContainEqual({
        channel: '/acp',
        endpoint: 'agent/set-default-mode',
        payload: { agentId: 'codebuddy', defaultMode: 'strict' },
      })
    })
    await waitFor(() => {
      expect(fixture.store.getSnapshot().detectedAgents.find(info => info.id === 'codebuddy')?.currentConfig?.defaultMode).toBe('strict')
    })
  })

  it('keeps a stored value the catalog no longer offers and marks it stale', async () => {
    const fixture = await mount({
      agents: [{ ...AGENT, defaultMode: 'gone' }],
      catalogs: { codebuddy: MODE_CATALOG },
    })
    expect((await screen.findByRole('combobox', { name: '默认模式（新对话）' }) as HTMLSelectElement).value).toBe('gone')
    // The kept option stays selectable, but the row says it will be skipped.
    expect(screen.getByRole('option', { name: 'gone（已失效）' })).toBeTruthy()
    expect(screen.getByText(/该模式已不在目录中/)).toBeTruthy()
    expect(fixture.store.getSnapshot().detectedAgents.find(info => info.id === 'codebuddy')?.currentConfig?.defaultMode).toBe('gone')
  })

  it('clears the default back to the agent through an empty value', async () => {
    const fixture = await mount({ agents: [{ ...AGENT, defaultMode: 'bypass' }], catalogs: { codebuddy: MODE_CATALOG } })
    const select = await screen.findByRole('combobox', { name: '默认模式（新对话）' })
    await act(async () => {
      fireEvent.change(select, { target: { value: '' } })
    })
    await waitFor(() => {
      expect(fixture.calls).toContainEqual({
        channel: '/acp',
        endpoint: 'agent/set-default-mode',
        payload: { agentId: 'codebuddy', defaultMode: '' },
      })
    })
    await waitFor(() => {
      expect(fixture.store.getSnapshot().detectedAgents.find(info => info.id === 'codebuddy')?.currentConfig?.defaultMode).toBeUndefined()
    })
  })
})
