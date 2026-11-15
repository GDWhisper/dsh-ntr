// Shared harness for the settings-panel clusters: mount the section against a
// fixture store and drive it the way a keyboard user would.
import { createElement } from 'react'
import { act, fireEvent, isInaccessible, render, screen, within } from '@testing-library/react'
import { expect } from 'vitest'
import { AcpSettingsSection } from '../../src/client/panel.tsx'
import { createPanelFixture, type PanelFixture, type PanelFixtureOptions, type PanelPermissionRequest } from '../panel-fixture.ts'

export async function mountPanel(options: PanelFixtureOptions = {}): Promise<PanelFixture> {
  const fixture = createPanelFixture(options)
  await fixture.ready
  render(createElement(AcpSettingsSection, { acp: fixture.store }))
  return fixture
}

export async function click(element: HTMLElement): Promise<void> {
  await act(async () => { fireEvent.click(element) })
}

export async function category(name: string): Promise<void> {
  await click(within(screen.getByRole('navigation', { name: 'NTR 设置分类' })).getByRole('button', { name }))
}

export async function detail(name: string, agent = 'CodeBuddy'): Promise<void> {
  await click(within(screen.getByRole('navigation', { name: `${agent} 配置` })).getByRole('button', { name }))
}

export function textbox(name: string): HTMLInputElement {
  return screen.getByRole('textbox', { name }) as HTMLInputElement
}

export function payloads(fixture: PanelFixture, endpoint: string): unknown[] {
  return fixture.calls.filter(call => call.endpoint === endpoint).map(call => call.payload)
}

export function expectHiddenButMounted(element: HTMLElement): void {
  expect(element.isConnected).toBe(true)
  expect(isInaccessible(element)).toBe(true)
}

export function permission(overrides: Partial<PanelPermissionRequest> = {}): PanelPermissionRequest {
  return {
    type: 'permission/request', requestId: 'ask-edit', sessionId: 'acp-preview', dshSessionId: 'other-chat',
    toolCall: { toolCallId: 'edit-1', title: 'Edit project file' },
    toolName: 'Edit project file', reason: 'Update app.ts', timeoutMode: 'wait',
    options: [
      { optionId: 'once', name: 'Allow once', kind: 'allow_once' },
      { optionId: 'always', name: 'Always Allow', kind: 'allow_always' },
      { optionId: 'deny', name: 'Reject once', kind: 'reject_once' },
    ],
    ...overrides,
  }
}
