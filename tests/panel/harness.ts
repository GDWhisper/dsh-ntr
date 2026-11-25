// Shared harness for the settings-panel clusters: mount the section against a
// fixture store and drive it the way a keyboard user would.
import { createElement } from 'react'
import { act, fireEvent, isInaccessible, render, screen, within } from '@testing-library/react'
import { expect } from 'vitest'
import { AcpSettingsSection } from '../../src/client/panel.tsx'
import { AcpStore, type RpcCall } from '../../src/client/store.ts'
import type { AcpAgentDef, AcpDelegateSettings, AgentProbeModelsResult, DelegateSetPayload } from '../../src/protocol.ts'
import { createPanelFixture, type PanelFixture, type PanelFixtureOptions, type PanelPermissionRequest, type PanelRpcCall } from '../panel-fixture.ts'

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

/**
 * The delegation-defaults seed: the subagent page's two controls at their own
 * defaults (guidance 开启, a 40-minute silence window that equals the baseline).
 */
export const DELEGATE_BASE: AcpDelegateSettings = {
  guidance: 'on', timeoutMs: 2_400_000, defaultTimeoutMs: 2_400_000,
  toolAvailable: true, restrictAvailable: true,
}

/** The payloads written to one endpoint. */
export function writes(calls: PanelRpcCall[], endpoint: string): unknown[] {
  return calls.filter(call => call.endpoint === endpoint).map(call => call.payload)
}

/**
 * Mount the settings section with a delegate view the wrapper keeps
 * authoritative: it applies each `ui/delegate-set` patch to its own snapshot and
 * answers with the new view, the same contract the host half honours. Two spec
 * files cover this section, so the stub lives here rather than in either one.
 *
 * The delegation cards open FOLDED (a first visit is a stack of summaries — see
 * `subagent-defaults-fold.spec.ts`, which pins that default). A spec about the
 * axes therefore opens them first with the head's own click. The subagents page
 * is mounted but hidden at this point, so that click is the gesture a user makes
 * one navigation later: it writes no RPC and the fold state is the same.
 * `keepFolded` skips the gesture for the spec that covers the flat state itself.
 */
export async function mountDefaults(
  seed: AcpDelegateSettings,
  options: {
    agents?: AcpAgentDef[]
    failWrite?: boolean
    catalogs?: Record<string, AgentProbeModelsResult | null>
    locale?: (zh: string, en: string) => string
    keepFolded?: boolean
  } = {},
): Promise<{ store: AcpStore; calls: PanelRpcCall[] }> {
  const base = createPanelFixture({ agents: options.agents, catalogs: options.catalogs })
  let current = structuredClone(seed)
  const calls: PanelRpcCall[] = []
  const rpc: RpcCall = async (channel, endpoint, payload) => {
    calls.push({ channel, endpoint, payload: structuredClone(payload) })
    if (channel === '/acp' && endpoint === 'ui/delegate') return { ok: true, value: { delegate: structuredClone(current) } }
    if (channel === '/acp' && endpoint === 'ui/delegate-set') {
      if (options.failWrite === true) return { ok: false, error: { code: 'bad_payload', message: 'no' } }
      const patch = structuredClone(payload) as DelegateSetPayload
      const next: AcpDelegateSettings = { ...current }
      if (patch.guidance !== undefined) next.guidance = patch.guidance
      if (patch.timeoutMs !== undefined) next.timeoutMs = patch.timeoutMs
      if (patch.defaultAgent !== undefined) next.defaultAgent = patch.defaultAgent
      if (patch.agentDefaults !== undefined) {
        const merged = { ...(current.agentDefaults ?? {}) }
        for (const [id, entry] of Object.entries(patch.agentDefaults)) {
          if (entry === null) delete merged[id]
          else merged[id] = entry
        }
        next.agentDefaults = merged
      }
      for (const key of patch.reset ?? []) {
        if (key === 'defaultAgent') next.defaultAgent = current.configured?.defaultAgent
        if (key === 'agentDefaults') next.agentDefaults = current.configured?.agentDefaults ?? {}
        if (key === 'guidance') next.guidance = current.configured?.guidance ?? 'off'
        if (key === 'timeoutMs') next.timeoutMs = current.configured?.timeoutMs ?? current.defaultTimeoutMs ?? next.timeoutMs
      }
      // Host view hygiene (delegateSettingsView): an empty map is NO key.
      if (next.agentDefaults !== undefined && Object.keys(next.agentDefaults).length === 0) delete next.agentDefaults
      next.resolvedDefaultAgent = next.defaultAgent ?? next.globalDefaultAgent
      current = next
      return { ok: true, value: { delegate: structuredClone(current) } }
    }
    return base.rpc(channel, endpoint, payload)
  }
  const store = new AcpStore(rpc, options.locale ?? (zh => zh))
  await store.resync()
  render(createElement(AcpSettingsSection, { acp: store }))
  if (options.keepFolded !== true) await expandAllCards()
  return { store, calls }
}

/** The head button of one agent's delegation card (the card's only button). */
function cardHead(agentId: string): HTMLElement {
  const body = document.getElementById(`dwa-delegate-defaults-${agentId}`)
  const head = body?.parentElement?.querySelector('button')
  if (head == null) throw new Error(`no delegation card for ${agentId}`)
  return head
}

/** Open one delegation card, if it is folded. */
export async function expandCard(agentId: string): Promise<void> {
  const head = cardHead(agentId)
  if (head.getAttribute('aria-expanded') === 'false') await click(head)
}

/** Open every delegation card on the page, if any is folded. */
export async function expandAllCards(): Promise<void> {
  for (const head of Array.from(document.querySelectorAll<HTMLElement>('.dwa-acc-head [aria-expanded]'))) {
    if (head.getAttribute('aria-expanded') === 'false') await click(head)
  }
}

/** The default-agent picker (its aria-label is the visible row title). */
export function defaultAgentSelect(): HTMLSelectElement {
  return screen.getByRole('combobox', { name: '默认子智能体' }) as HTMLSelectElement
}

/** One agent's axis dropdown, addressed by its aria-label. */
export function axisSelect(axis: '模型' | '思考等级' | '模式', title: string): HTMLSelectElement {
  return screen.getByRole('combobox', { name: `${axis} · ${title}` }) as HTMLSelectElement
}

export function optionValues(select: HTMLSelectElement): string[] {
  return Array.from(select.options).map(option => option.value)
}
