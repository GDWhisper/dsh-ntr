/**
 * The `/acp` dispatcher: endpoint routing, payload validation before the manager call, and ACP errors normalized into `{ok:false, error}` with `error.data` read first (constraint 5).
 *
 * Part of the `tests/impl.spec.ts` mirror: one file per `src/impl/` cluster,
 * same describe titles and case counts as before the split.
 */

import { describe, expect, it } from 'vitest'
import {
  AcpError,
  dispatchRpc,
  agentSaveAction,
} from '../../src/impl.ts'
import type { AcpManager } from '../../src/impl.ts'
import type { AcpAgentDef, AcpDelegateSettings, AgentProbeModelsResult, DelegateSetPayload } from '../../src/protocol.ts'
import { fakeManager } from './harness.ts'

describe('dispatchRpc', () => {
  it('routes endpoints and normalizes errors into the Connection result shape', async () => {
    const manager = fakeManager()
    // `agents/list` is the roster alone: the retired approval/access-mode axes
    // have no reporting field left.
    await expect(dispatchRpc(manager, 'agents/list', {})).resolves.toEqual({
      ok: true,
      value: { agents: [] },
    })
    expect(manager.calls).toContainEqual(['agents', undefined])
    // Optional chat-session mode surface: a manager without it reports none.
    await expect(dispatchRpc(manager, 'session/chat-list', { dshSessionId: 'chat-1' })).resolves.toEqual({ ok: true, value: { sessions: [], acpMode: false } })
    // The seat gate's fallback fact source: read-only, memory-only, and false
    // when the manager lacks the method (an older host half) or the resolver.
    const acpModeOn = { ...manager, chatSessionAcpMode: (dshSessionId: string) => dshSessionId === 'chat-1' }
    await expect(dispatchRpc(acpModeOn, 'session/chat-list', { dshSessionId: 'chat-1' })).resolves.toEqual({ ok: true, value: { sessions: [], acpMode: true } })
    await expect(dispatchRpc(acpModeOn, 'session/chat-list', { dshSessionId: 'chat-2' })).resolves.toEqual({ ok: true, value: { sessions: [], acpMode: false } })
    // The one-way agent lock: reported alongside the binding, and absent (not a
    // false field) on a manager from before the lock existed.
    const locked = { ...manager, lockedAgentFor: (dshSessionId: string) => (dshSessionId === 'chat-1' ? 'pi' : undefined) }
    await expect(dispatchRpc(locked, 'session/chat-list', { dshSessionId: 'chat-1' }))
      .resolves.toMatchObject({ ok: true, value: { lockedAgentId: 'pi' } })
    await expect(dispatchRpc(manager, 'session/chat-list', { dshSessionId: 'chat-1' }))
      .resolves.toEqual({ ok: true, value: { sessions: [], acpMode: false } })
    await expect(dispatchRpc(manager, 'session/chat-mode-set', { dshSessionId: 'chat-1', modeId: 'strict' })).resolves.toEqual({ ok: true, value: { done: true } })
    // The released banner's explicit resume, addressed by the chat session id
    // like every other conversation surface.
    await expect(dispatchRpc(manager, 'session/chat-resume', { dshSessionId: 'chat-1' })).resolves.toEqual({ ok: true, value: { done: true } })
    expect(manager.calls).toContainEqual(['resumeChatSession', 'chat-1'])
    await expect(dispatchRpc(manager, 'session/chat-resume', {})).resolves.toMatchObject({ ok: false, error: { code: 'bad_payload' } })
    await expect(dispatchRpc(manager, 'session/chat-list', {})).resolves.toMatchObject({ ok: false, error: { code: 'bad_payload' } })
    // The ACP view's data source: addressed by the CHAT session id, because
    // the browser has no ACP session id before the first turn.
    await expect(dispatchRpc(manager, 'session/chat-transcript', { dshSessionId: 'chat-1' })).resolves.toEqual({ ok: true, value: { views: [] } })
    expect(manager.calls).toContainEqual(['chatTranscripts', { dshSessionId: 'chat-1', afterSeq: undefined }])
    await expect(dispatchRpc(manager, 'session/chat-transcript', { dshSessionId: 'chat-1', afterSeq: 7 })).resolves.toEqual({ ok: true, value: { views: [] } })
    expect(manager.calls).toContainEqual(['chatTranscripts', { dshSessionId: 'chat-1', afterSeq: 7 }])
    await expect(dispatchRpc(manager, 'session/chat-transcript', {})).resolves.toMatchObject({ ok: false, error: { code: 'bad_payload' } })
    await expect(dispatchRpc(manager, 'session/chat-transcript', { dshSessionId: 'chat-1', afterSeq: 'x' })).resolves.toMatchObject({ ok: false, error: { code: 'bad_payload' } })
    // A host half without the method answers an empty list rather than failing.
    await expect(dispatchRpc({ ...manager, chatTranscripts: undefined }, 'session/chat-transcript', { dshSessionId: 'chat-1' })).resolves.toEqual({ ok: true, value: { views: [] } })
    // Preset surface: a host half with no roster reader reports `null` instead
    // of failing, so the panel's status poll still answers (and hides the block).
    await expect(dispatchRpc(manager, 'preset/status', {})).resolves.toEqual({ ok: true, value: { preset: null } })
    const withPreset = {
      ...manager,
      presetStatus: async () => ({
        id: 'acp',
        source: 'dsh-ntr/presets/acp/acp.patch.yml',
        installed: false,
        problem: 'the harness preset roster does not carry this declaration',
      }),
    }
    await expect(dispatchRpc(withPreset, 'preset/status', {})).resolves.toEqual({
      ok: true,
      value: {
        preset: {
          id: 'acp',
          source: 'dsh-ntr/presets/acp/acp.patch.yml',
          installed: false,
          problem: 'the harness preset roster does not carry this declaration',
        },
      },
    })
    await expect(dispatchRpc(manager, 'agents/detect', {})).resolves.toEqual({ ok: true, value: { agents: [] } })
    expect(manager.calls).toContainEqual(['detect', undefined])
    // Version badge source: present on this half, silent (not failing) on a
    // manager that predates the endpoint.
    await expect(dispatchRpc({ ...manager, pluginVersion: () => '1.2.3' }, 'plugin/version', {}))
      .resolves.toEqual({ ok: true, value: { version: '1.2.3' } })
    await expect(dispatchRpc({ ...manager, pluginVersion: undefined }, 'plugin/version', {}))
      .resolves.toEqual({ ok: true, value: { version: undefined } })
    // Save gate: status/flush/wait-idle route to the manager; an older half
    // answers the idle status (or `unsupported` for the gestures) instead of
    // failing the browser.
    const gateStatus = {
      gateAvailable: true,
      canSave: false,
      activeTurns: 1,
      activeSessions: [{ sessionId: 'S', agentId: 'demo' }],
      pending: [{ id: 'save-1', label: 'settings:llm-pi-ai', queuedAt: 1, deadlineAt: 2 }],
      timeoutMs: 600_000,
    }
    const withGate = {
      ...manager,
      saveGateStatus: () => gateStatus,
      saveGateFlush: async () => ({ saved: 1, expired: 0, failed: 0 }),
      saveGateWaitIdle: async (timeoutMs?: number) => {
        manager.calls.push(['waitIdle', timeoutMs])
        return true
      },
    }
    await expect(dispatchRpc(withGate, 'save/status', {})).resolves.toEqual({ ok: true, value: { status: gateStatus } })
    await expect(dispatchRpc(manager, 'save/status', {})).resolves.toMatchObject({
      ok: true,
      // The fallback snapshot is NOT gate-backed: the browser must be able to
      // tell it cannot queue / force anything on this host half.
      value: { status: { gateAvailable: false, canSave: true, activeTurns: 0, pending: [] } },
    })
    await expect(dispatchRpc(withGate, 'save/flush', {})).resolves.toEqual({
      ok: true,
      value: { saved: 1, expired: 0, failed: 0 },
    })
    await expect(dispatchRpc(manager, 'save/flush', {})).resolves.toMatchObject({ ok: false, error: { code: 'unsupported' } })
    const withCancel = {
      ...manager,
      saveGateCancel: (label: string) => {
        manager.calls.push(['saveCancel', label])
        return 2
      },
    }
    await expect(dispatchRpc(withCancel, 'save/cancel', { label: 'agent-save:pi' }))
      .resolves.toEqual({ ok: true, value: { cancelled: 2 } })
    expect(manager.calls).toContainEqual(['saveCancel', 'agent-save:pi'])
    await expect(dispatchRpc(manager, 'save/cancel', { label: 'agent-save:pi' }))
      .resolves.toMatchObject({ ok: false, error: { code: 'unsupported' } })
    const withRetry = {
      ...manager,
      saveGateRetry: (label: string) => {
        manager.calls.push(['saveRetry', label])
        return true
      },
    }
    await expect(dispatchRpc(withRetry, 'save/retry', { label: 'agent-save:pi' }))
      .resolves.toEqual({ ok: true, value: { retried: true } })
    expect(manager.calls).toContainEqual(['saveRetry', 'agent-save:pi'])
    await expect(dispatchRpc(manager, 'save/retry', { label: 'agent-save:pi' }))
      .resolves.toMatchObject({ ok: false, error: { code: 'unsupported' } })
    await expect(dispatchRpc(withGate, 'save/wait-idle', { timeoutMs: 50 })).resolves.toEqual({ ok: true, value: { idle: true } })
    expect(manager.calls).toContainEqual(['waitIdle', 50])
    await expect(dispatchRpc(withGate, 'save/wait-idle', { timeoutMs: -1 })).resolves.toMatchObject({ ok: false, error: { code: 'bad_payload' } })
    await expect(dispatchRpc(manager, 'save/wait-idle', {})).resolves.toMatchObject({ ok: false, error: { code: 'unsupported' } })
    // Built-in update: check/apply delegate to the manager; an older host half
    // answers `unsupported` instead of failing, and a malformed version never
    // reaches the manager.
    const withUpdate = {
      ...manager,
      pluginUpdateCheck: async () => {
        manager.calls.push(['updateCheck', undefined])
        return { status: 'current' as const, current: '1.2.3' }
      },
      pluginUpdateApply: async (version: string) => {
        manager.calls.push(['updateApply', version])
        return { status: 'applied' as const, current: '1.2.3', installed: version }
      },
      pluginReleaseNotes: async (version: string, refresh?: boolean) => {
        manager.calls.push(['releaseNotes', version, refresh])
        return { version, url: `https://example.test/releases/tag/v${version}`, source: 'github' as const, body: 'notes' }
      },
    }
    await expect(dispatchRpc(withUpdate, 'plugin/update-check', {}))
      .resolves.toEqual({ ok: true, value: { status: 'current', current: '1.2.3' } })
    expect(manager.calls).toContainEqual(['updateCheck', undefined])
    await expect(dispatchRpc(withUpdate, 'plugin/update-apply', { version: '1.3.0' }))
      .resolves.toEqual({ ok: true, value: { status: 'applied', current: '1.2.3', installed: '1.3.0' } })
    expect(manager.calls).toContainEqual(['updateApply', '1.3.0'])
    await expect(dispatchRpc(withUpdate, 'plugin/update-apply', { version: '1.3' }))
      .resolves.toMatchObject({ ok: false, error: { code: 'bad_payload' } })
    // Release notes are a read: the same version syntax, nothing installed.
    await expect(dispatchRpc(withUpdate, 'plugin/release-notes', { version: '1.3.0' }))
      .resolves.toEqual({
        ok: true,
        value: { version: '1.3.0', url: 'https://example.test/releases/tag/v1.3.0', source: 'github', body: 'notes' },
      })
    expect(manager.calls).toContainEqual(['releaseNotes', '1.3.0', undefined])
    // The card's retry must reach the network: `refresh` passes straight through.
    await expect(dispatchRpc(withUpdate, 'plugin/release-notes', { version: '1.3.0', refresh: true }))
      .resolves.toMatchObject({ ok: true, value: { version: '1.3.0', source: 'github' } })
    expect(manager.calls).toContainEqual(['releaseNotes', '1.3.0', true])
    await expect(dispatchRpc(withUpdate, 'plugin/release-notes', { version: '1.3.0', refresh: 'yes' }))
      .resolves.toMatchObject({ ok: false, error: { code: 'bad_payload' } })
    await expect(dispatchRpc(withUpdate, 'plugin/release-notes', { version: '1.3' }))
      .resolves.toMatchObject({ ok: false, error: { code: 'bad_payload' } })
    await expect(dispatchRpc(manager, 'plugin/update-check', {}))
      .resolves.toEqual({ ok: true, value: { status: 'unsupported', current: '' } })
    await expect(dispatchRpc(manager, 'plugin/update-apply', { version: '1.3.0' }))
      .resolves.toEqual({ ok: true, value: { status: 'unsupported', current: '' } })
    // An older host half still answers a link it can derive without a network.
    await expect(dispatchRpc(manager, 'plugin/release-notes', { version: '1.3.0' }))
      .resolves.toEqual({
        ok: true,
        value: {
          version: '1.3.0',
          url: 'https://github.com/GDWhisper/dsh-ntr/releases/tag/v1.3.0',
          source: 'none',
        },
      })
    await expect(dispatchRpc(manager, 'agent/save', { id: 'pi', command: 'pi-acp' })).resolves.toEqual({ ok: true, value: { done: true } })
    expect(manager.calls).toContainEqual(['save', expect.objectContaining({ id: 'pi', command: 'pi-acp' })])
    const withSaveMode = {
      ...manager,
      saveAgent: async (def: AcpAgentDef, mode?: 'direct' | 'defer' | 'force') => {
        manager.calls.push(['saveMode', def.id, mode])
        return mode === 'defer' ? { done: true, deferred: true } : { done: true }
      },
    }
    await expect(dispatchRpc(withSaveMode, 'agent/save', { id: 'pi', command: 'pi-acp', saveMode: 'defer' }))
      .resolves.toEqual({ ok: true, value: { done: true, deferred: true } })
    expect(manager.calls).toContainEqual(['saveMode', 'pi', 'defer'])
    await expect(dispatchRpc(manager, 'agent/save', { id: 'pi', command: 'pi-acp', saveMode: 'bogus' }))
      .resolves.toMatchObject({ ok: false, error: { code: 'bad_payload' } })
    // A legacy caller that sends no gesture must NOT receive `ok` when the host
    // refused the save: the explicit failure signal is the whole point.
    const busyManager = {
      ...manager,
      saveAgent: async (busyDef: AcpAgentDef, mode?: 'direct' | 'defer' | 'force') => {
        manager.calls.push(['busySave', busyDef.id, mode])
        return {
          done: false,
          confirmationRequired: true,
          activeSessions: [{ sessionId: 'S', agentId: busyDef.id }],
        }
      },
    }
    await expect(dispatchRpc(busyManager, 'agent/save', { id: 'pi', command: 'pi-acp' }))
      .resolves.toMatchObject({ ok: false, error: { code: 'confirmation_required' } })
    expect(manager.calls).toContainEqual(['busySave', 'pi', undefined])
    // The new panel always sends a mode, so its answer shape is unchanged.
    await expect(dispatchRpc(busyManager, 'agent/save', { id: 'pi', command: 'pi-acp', saveMode: 'direct' }))
      .resolves.toEqual({
        ok: true,
        value: {
          done: false,
          confirmationRequired: true,
          activeSessions: [{ sessionId: 'S', agentId: 'pi' }],
        },
      })
    const noSave = { ...manager, saveAgent: undefined }
    await expect(dispatchRpc(noSave, 'agent/save', { id: 'pi', command: 'pi-acp' }))
      .resolves.toMatchObject({ ok: false, error: { code: 'unsupported' } })
    expect(agentSaveAction([], 'direct')).toBe('save')
    expect(agentSaveAction([{ sessionId: 'S', agentId: 'pi' }], 'direct')).toBe('confirm')
    expect(agentSaveAction([{ sessionId: 'S', agentId: 'pi' }], 'defer')).toBe('defer')
    expect(agentSaveAction([{ sessionId: 'S', agentId: 'pi' }], 'force')).toBe('save')
    expect(manager.calls).toContainEqual(['save', expect.objectContaining({ id: 'pi', command: 'pi-acp' })])
    await expect(dispatchRpc(manager, 'agent/test', { id: 'pi', command: 'pi-acp', npmPackage: 'pi-acp' })).resolves.toEqual({ ok: true, value: { ok: true, durationMs: 5, stderr: [] } })
    expect(manager.calls).toContainEqual(['test', expect.objectContaining({ id: 'pi', command: 'pi-acp', npmPackage: 'pi-acp' })])
    await expect(dispatchRpc(manager, 'agent/test', { id: 'pi', command: 'pi-acp', npmPackage: 'bad name' })).resolves.toMatchObject({ ok: false, error: { code: 'bad_config' } })
    await expect(dispatchRpc(manager, 'agent/test', { id: 'pi' })).resolves.toMatchObject({ ok: false, error: { code: 'bad_config' } })
    const bareTest = { ...manager, testAgent: undefined }
    await expect(dispatchRpc(bareTest, 'agent/test', { id: 'pi', command: 'pi-acp' })).resolves.toMatchObject({ ok: false, error: { code: 'unsupported' } })
    await expect(dispatchRpc(manager, 'agent/delete', { agentId: 'pi' })).resolves.toEqual({ ok: true, value: { done: true } })
    expect(manager.calls).toContainEqual(['delete', 'pi'])
    await expect(dispatchRpc(manager, 'session/start', { agentId: 'a' })).resolves.toEqual({ ok: true, value: { sessionId: 'S' } })
    await expect(dispatchRpc(manager, 'nope', {})).resolves.toMatchObject({ ok: false, error: { code: 'unknown_endpoint' } })
    await expect(dispatchRpc(manager, 'session/prompt', { sessionId: 'S' })).resolves.toMatchObject({
      ok: false,
      error: { code: 'bad_payload', details: {} },
    })
    await expect(dispatchRpc(manager, 'session/prompt', { sessionId: 'S', text: 3 })).resolves.toMatchObject({ ok: false })
    await expect(dispatchRpc(manager, 'session/prompt', { sessionId: 'S', prompt: [] })).resolves.toMatchObject({ ok: false, error: { code: 'bad_payload' } })
    await expect(dispatchRpc(manager, 'session/prompt', { sessionId: 'S', prompt: [{ type: 'unknown' }] })).resolves.toMatchObject({ ok: false, error: { code: 'bad_payload' } })
    await expect(dispatchRpc(manager, 'session/prompt', { sessionId: 'S', prompt: [{ type: 'image', data: 'abc' }] })).resolves.toMatchObject({ ok: false, error: { code: 'bad_payload' } })
    await expect(dispatchRpc(manager, 'session/prompt', { sessionId: 'S', prompt: [{ type: 'image', data: 'abc', mimeType: 'text/plain' }] })).resolves.toMatchObject({ ok: false, error: { code: 'bad_payload' } })
    await expect(dispatchRpc(manager, 'session/prompt', { sessionId: 'S', prompt: [{ type: 'image', data: 'abc', mimeType: 'image/png', uri: 123 }] })).resolves.toMatchObject({ ok: false, error: { code: 'bad_payload' } })
    await expect(dispatchRpc(manager, 'session/prompt', { sessionId: 'S', prompt: [{ type: 'text', text: 'hi' }, { type: 'image', data: 'abc', mimeType: 'image/png' }] })).resolves.toMatchObject({ ok: true, value: { accepted: true, turnId: 'T' } })
    await expect(dispatchRpc(manager, 'session/config-set', { sessionId: 'S', configId: 'm', value: 42 })).resolves.toMatchObject({ ok: false, error: { code: 'bad_payload' } })
    // The plugin's OWN default ACP agent (the panel's ★ gesture) — a
    // plugin-private id, never a DSH model route.
    await expect(dispatchRpc(manager, 'default/agent', {})).resolves.toEqual({ ok: true, value: { agentId: 'mock' } })
    await expect(dispatchRpc(manager, 'default/agent-set', { agentId: 'custom' })).resolves.toEqual({ ok: true, value: { done: true } })
    expect(manager.calls).toContainEqual(['setDefaultAgent', 'custom'])
    // A host half with no default agent answers `undefined` → the panel shows no ★.
    await expect(dispatchRpc({ ...manager, defaultAgent: undefined }, 'default/agent', {})).resolves.toEqual({ ok: true, value: { agentId: undefined } })
    // Clearing the default is legal and is the only way to remove a star.
    await expect(dispatchRpc(manager, 'default/agent-set', {})).resolves.toEqual({ ok: true, value: { done: true } })
    expect(manager.calls).toContainEqual(['setDefaultAgent', undefined])
    // The tag halo preference: read falls back to the default on an older host
    // half; writes are validated (only the settings card's enums pass).
    await expect(dispatchRpc(manager, 'ui/tag-halo', {})).resolves.toEqual({ ok: true, value: { halo: { mode: 'breath', speed: 'slow' } } })
    await expect(dispatchRpc({ ...manager, tagHalo: undefined }, 'ui/tag-halo', {})).resolves.toEqual({ ok: true, value: { halo: { mode: 'breath', speed: 'normal' } } })
    await expect(dispatchRpc(manager, 'ui/tag-halo-set', { halo: { mode: 'steady', speed: 'fast' } })).resolves.toEqual({ ok: true, value: { done: true } })
    expect(manager.calls).toContainEqual(['setTagHalo', { mode: 'steady', speed: 'fast' }])
    await expect(dispatchRpc(manager, 'ui/tag-halo-set', { halo: { mode: 'blink', speed: 'fast' } })).resolves.toMatchObject({ ok: false, error: { code: 'bad_payload' } })
    await expect(dispatchRpc(manager, 'ui/tag-halo-set', { halo: { mode: 'breath', speed: 'ludicrous' } })).resolves.toMatchObject({ ok: false, error: { code: 'bad_payload' } })
    await expect(dispatchRpc(manager, 'ui/tag-halo-set', {})).resolves.toMatchObject({ ok: false, error: { code: 'bad_payload' } })
    // The session-title prefix toggle: read falls back to the default (on) on
    // an older host half; only a boolean passes the write gate.
    await expect(dispatchRpc(manager, 'ui/session-title-prefix', {})).resolves.toEqual({ ok: true, value: { titlePrefix: true } })
    await expect(dispatchRpc({ ...manager, sessionTitlePrefix: undefined }, 'ui/session-title-prefix', {})).resolves.toEqual({ ok: true, value: { titlePrefix: true } })
    await expect(dispatchRpc(manager, 'ui/session-title-prefix-set', { titlePrefix: true })).resolves.toEqual({ ok: true, value: { titlePrefix: true } })
    expect(manager.calls).toContainEqual(['setSessionTitlePrefix', true])
    await expect(dispatchRpc({ ...manager, sessionTitlePrefix: () => false }, 'ui/session-title-prefix-set', { titlePrefix: false })).resolves.toEqual({ ok: true, value: { titlePrefix: false } })
    await expect(dispatchRpc(manager, 'ui/session-title-prefix-set', {})).resolves.toMatchObject({ ok: false, error: { code: 'bad_payload' } })
    await expect(dispatchRpc(manager, 'ui/session-title-prefix-set', { titlePrefix: 'yes' })).resolves.toMatchObject({ ok: false, error: { code: 'bad_payload' } })
    // The approval deadlines: read is `undefined` on an older host half (which
    // hides the card), and a write is validated before it reaches the manager —
    // the same range the config file is held to, so a value the card can send is
    // a value the next boot accepts.
    await expect(dispatchRpc(manager, 'ui/approval-deadlines', {})).resolves.toEqual({
      ok: true,
      value: { deadlines: { permissionTimeoutMs: 300_000, mode: 'abort' } },
    })
    await expect(dispatchRpc({ ...manager, approvalDeadlines: undefined }, 'ui/approval-deadlines', {})).resolves.toEqual({
      ok: true,
      value: { deadlines: undefined },
    })
    await expect(dispatchRpc(manager, 'ui/approval-deadlines-set', { permissionTimeoutMs: 60_000 })).resolves.toEqual({
      ok: true,
      value: { deadlines: { permissionTimeoutMs: 300_000, mode: 'abort' } },
    })
    // Only the touched key travels: the manager merges, so a card that edited
    // the window must not reset the mode.
    expect(manager.calls).toContainEqual(['setApprovalDeadlines', { permissionTimeoutMs: 60_000 }, false])
    // The mode travels through the same route, and only the three values pass.
    await expect(dispatchRpc(manager, 'ui/approval-deadlines-set', { mode: 'auto' })).resolves.toMatchObject({ ok: true })
    expect(manager.calls).toContainEqual(['setApprovalDeadlines', { mode: 'auto' }, false])
    for (const bad of ['maybe', '', 1, null]) {
      await expect(dispatchRpc(manager, 'ui/approval-deadlines-set', { mode: bad }))
        .resolves.toMatchObject({ ok: false, error: { code: 'bad_payload' } })
    }
    await expect(dispatchRpc(manager, 'ui/approval-deadlines-set', { reset: true })).resolves.toMatchObject({ ok: true })
    expect(manager.calls).toContainEqual(['setApprovalDeadlines', {}, true])
    for (const bad of [-1, 1.5, 86_400_001, '60000']) {
      await expect(dispatchRpc(manager, 'ui/approval-deadlines-set', { permissionTimeoutMs: bad }))
        .resolves.toMatchObject({ ok: false, error: { code: 'bad_payload' } })
    }
    // `0` is the meaningful value (一直等), not a rejection.
    await expect(dispatchRpc(manager, 'ui/approval-deadlines-set', { permissionTimeoutMs: 0 }))
      .resolves.toMatchObject({ ok: true })
    expect(manager.calls).toContainEqual(['setApprovalDeadlines', { permissionTimeoutMs: 0 }, false])
    await expect(dispatchRpc(manager, 'ui/approval-deadlines-set', { elicitationTimeoutMs: 300_000 })).resolves.toMatchObject({ ok: true })
    expect(manager.calls).toContainEqual(['setApprovalDeadlines', { elicitationTimeoutMs: 300_000 }, false])
    // Form questions keep zero as the meaningful "no deadline" value.
    await expect(dispatchRpc(manager, 'ui/approval-deadlines-set', { elicitationTimeoutMs: 0 })).resolves.toMatchObject({ ok: true })
    expect(manager.calls).toContainEqual(['setApprovalDeadlines', { elicitationTimeoutMs: 0 }, false])
    // Question expiry mode travels through the same route and accepts only `cancel` / `first`.
    await expect(dispatchRpc(manager, 'ui/approval-deadlines-set', { questionTimeoutMode: 'first' })).resolves.toMatchObject({ ok: true })
    expect(manager.calls).toContainEqual(['setApprovalDeadlines', { questionTimeoutMode: 'first' }, false])
    await expect(dispatchRpc(manager, 'ui/approval-deadlines-set', { questionTimeoutMode: 'cancel' })).resolves.toMatchObject({ ok: true })
    expect(manager.calls).toContainEqual(['setApprovalDeadlines', { questionTimeoutMode: 'cancel' }, false])
    for (const bad of ['auto', '', 1, null]) {
      await expect(dispatchRpc(manager, 'ui/approval-deadlines-set', { questionTimeoutMode: bad }))
        .resolves.toMatchObject({ ok: false, error: { code: 'bad_payload' } })
    }
    // An unknown key is dropped rather than persisted into state, and the two
    // legacy windows can no longer be smuggled back in.
    await expect(dispatchRpc(manager, 'ui/approval-deadlines-set', { bogusKey: 5 })).resolves.toMatchObject({ ok: true })
    expect(manager.calls).toContainEqual(['setApprovalDeadlines', {}, false])
    await expect(dispatchRpc(manager, 'ui/approval-deadlines-set', { nativeApprovalTimeoutMs: 60_000 })).resolves.toMatchObject({ ok: true })
    expect(manager.calls).toContainEqual(['setApprovalDeadlines', {}, false])
    // The idle-release window: read is `undefined` on an older host half (which
    // hides the tab), and a write is validated against the shared ladder —
    // only a rung the slider offers is a window the host runs.
    await expect(dispatchRpc(manager, 'ui/idle-release', {})).resolves.toEqual({
      ok: true,
      value: { idleRelease: { idleTimeoutMs: 1_800_000, defaultIdleTimeoutMs: 1_800_000 } },
    })
    await expect(dispatchRpc({ ...manager, idleRelease: undefined }, 'ui/idle-release', {})).resolves.toEqual({
      ok: true,
      value: { idleRelease: undefined },
    })
    await expect(dispatchRpc(manager, 'ui/idle-release-set', { idleTimeoutMs: 300_000 })).resolves.toMatchObject({ ok: true })
    expect(manager.calls).toContainEqual(['setIdleRelease', 300_000, false])
    await expect(dispatchRpc(manager, 'ui/idle-release-set', { reset: true })).resolves.toMatchObject({ ok: true })
    expect(manager.calls).toContainEqual(['setIdleRelease', undefined, true])
    for (const bad of [0, -1, 1.5, 86_400_001, '60000', 90_000]) {
      await expect(dispatchRpc(manager, 'ui/idle-release-set', { idleTimeoutMs: bad }))
        .resolves.toMatchObject({ ok: false, error: { code: 'bad_payload' } })
    }
    // The conversation↔agent mapping: the plugin's own binding, never a model route.
    await expect(dispatchRpc(manager, 'session/chat-bind', { dshSessionId: 'chat-1', agentId: 'pi' })).resolves.toEqual({ ok: true, value: { done: true } })
    expect(manager.calls).toContainEqual(['bindChatAgent', 'chat-1', 'pi'])
    await expect(dispatchRpc(manager, 'session/chat-model-set', { dshSessionId: 'chat-1', modelId: 'pi@a' })).resolves.toEqual({ ok: true, value: { done: true } })
    expect(manager.calls).toContainEqual(['setChatSessionModel', 'chat-1', 'pi@a'])
    await expect(dispatchRpc(manager, 'session/chat-effort-set', { dshSessionId: 'chat-1', effort: 'high' })).resolves.toEqual({ ok: true, value: { done: true } })
    expect(manager.calls).toContainEqual(['setChatSessionEffort', 'chat-1', 'high'])
    // Absent effort clears it (follow the agent's own default).
    await expect(dispatchRpc(manager, 'session/chat-effort-set', { dshSessionId: 'chat-1' })).resolves.toEqual({ ok: true, value: { done: true } })
    expect(manager.calls).toContainEqual(['setChatSessionEffort', 'chat-1', undefined])
    await expect(dispatchRpc(manager, 'session/chat-bind', { dshSessionId: 'chat-1' })).resolves.toMatchObject({ ok: false, error: { code: 'bad_payload' } })
    await expect(dispatchRpc(manager, 'agent/probe-models', { agentId: 'pi' })).resolves.toMatchObject({
      ok: true,
      value: { agentId: 'pi', catalog: { model: { configId: 'model' } } },
    })
    expect(manager.calls).toContainEqual(['probe', 'pi'])
    await expect(dispatchRpc(manager, 'agent/probe-models', {})).resolves.toMatchObject({ ok: false, error: { code: 'bad_payload' } })
    const bare = { ...manager, probeAgentModels: undefined }
    await expect(dispatchRpc(bare, 'agent/probe-models', { agentId: 'pi' })).resolves.toMatchObject({ ok: false, error: { code: 'unsupported' } })
    // The settings panel's mount read: the host's persisted catalog, no probe.
    await expect(dispatchRpc(manager, 'agent/cached-models', { agentId: 'pi' })).resolves.toMatchObject({
      ok: true,
      value: { agentId: 'pi', updatedAt: 2 },
    })
    expect(manager.calls).toContainEqual(['cachedModels', 'pi'])
    await expect(dispatchRpc(manager, 'agent/cached-models', {})).resolves.toMatchObject({ ok: false, error: { code: 'bad_payload' } })
    // An older host half without the read answers `null` rather than failing:
    // the panel then shows its empty state and the button still works.
    await expect(dispatchRpc({ ...manager, cachedAgentModels: undefined }, 'agent/cached-models', { agentId: 'pi' }))
      .resolves.toEqual({ ok: true, value: null })
    // `agent/catalog` is the seats' model list — the ONLY place ACP models are
    // offered, since the `acp` route advertises nothing in DSH's own catalog.
    await expect(dispatchRpc(manager, 'agent/catalog', { agentId: 'pi' })).resolves.toMatchObject({
      ok: true,
      value: { agentId: 'pi', base: { id: 'pi' }, variants: [{ id: 'pi@a' }], probed: true },
    })
    expect(manager.calls).toContainEqual(['catalog', 'pi'])
    await expect(dispatchRpc(manager, 'agent/catalog', {})).resolves.toMatchObject({ ok: false, error: { code: 'bad_payload' } })
    await expect(dispatchRpc(manager, 'agent/set-exposed-models', { agentId: 'pi', exposedModels: ['a', 'b'] })).resolves.toEqual({ ok: true, value: { done: true } })
    expect(manager.calls).toContainEqual(['setExposedModels', { id: 'pi', exposed: ['a', 'b'] }])
    await expect(dispatchRpc(manager, 'agent/set-exposed-models', { agentId: 'pi' })).resolves.toEqual({ ok: true, value: { done: true } })
    expect(manager.calls).toContainEqual(['setExposedModels', { id: 'pi', exposed: undefined }])
    await expect(dispatchRpc(manager, 'agent/set-exposed-models', { agentId: 'pi', exposedModels: ['ok', ''] })).resolves.toMatchObject({ ok: false, error: { code: 'bad_payload' } })
    await expect(dispatchRpc(manager, 'agent/set-exposed-models', { agentId: 'pi', exposedModels: 'a' })).resolves.toMatchObject({ ok: false, error: { code: 'bad_payload' } })
    await expect(dispatchRpc(manager, 'agent/set-exposed-models', {})).resolves.toMatchObject({ ok: false, error: { code: 'bad_payload' } })
    // A whole real catalog must go through in one call (see the config-side case).
    const catalog = Array.from({ length: 581 }, (_, i) => `provider/model-${String(i)}`)
    await expect(dispatchRpc(manager, 'agent/set-exposed-models', { agentId: 'omp', exposedModels: catalog })).resolves.toEqual({ ok: true, value: { done: true } })
    expect(manager.calls).toContainEqual(['setExposedModels', { id: 'omp', exposed: catalog }])
    // Auto-discovery is a per-agent switch on the same lightweight surface —
    // never `agent/save`, which would restart the process.
    await expect(dispatchRpc(manager, 'agent/set-auto-discover-models', { agentId: 'pi', autoDiscoverModels: true })).resolves.toEqual({ ok: true, value: { done: true } })
    expect(manager.calls).toContainEqual(['setAutoDiscoverModels', { id: 'pi', autoDiscoverModels: true }])
    await expect(dispatchRpc(manager, 'agent/set-auto-discover-models', { agentId: 'pi', autoDiscoverModels: 'yes' })).resolves.toMatchObject({ ok: false, error: { code: 'bad_payload' } })
    await expect(dispatchRpc(manager, 'agent/set-auto-discover-models', { agentId: 'pi' })).resolves.toMatchObject({ ok: false, error: { code: 'bad_payload' } })
    await expect(dispatchRpc(manager, 'agent/set-auto-discover-models', { autoDiscoverModels: true })).resolves.toMatchObject({ ok: false, error: { code: 'bad_payload' } })
    // The default chat mode is a per-agent preference on the same lightweight
    // surface; an empty string is the explicit "follow the agent" answer.
    await expect(dispatchRpc(manager, 'agent/set-default-mode', { agentId: 'pi', defaultMode: 'strict' })).resolves.toEqual({ ok: true, value: { done: true } })
    expect(manager.calls).toContainEqual(['setDefaultMode', 'pi', 'strict'])
    await expect(dispatchRpc(manager, 'agent/set-default-mode', { agentId: 'pi', defaultMode: '' })).resolves.toEqual({ ok: true, value: { done: true } })
    expect(manager.calls).toContainEqual(['setDefaultMode', 'pi', undefined])
    await expect(dispatchRpc(manager, 'agent/set-default-mode', { agentId: 'pi', defaultMode: 7 })).resolves.toMatchObject({ ok: false, error: { code: 'bad_payload' } })
    await expect(dispatchRpc(manager, 'agent/set-default-mode', { agentId: 'pi', defaultMode: 'x'.repeat(129) })).resolves.toMatchObject({ ok: false, error: { code: 'bad_payload' } })
    await expect(dispatchRpc(manager, 'agent/set-default-mode', { defaultMode: 'strict' })).resolves.toMatchObject({ ok: false, error: { code: 'bad_payload' } })
  })

  it('routes session/chat-fork-adopt to the manager and normalizes a bad payload', async () => {
    // The second half of a branched conversation: the browser names the DSH
    // child the host fork built and the parent to fork from — the manager owns
    // everything past this shape check.
    const manager = fakeManager()
    await expect(dispatchRpc(manager, 'session/chat-fork-adopt', { dshSessionId: 'child-1', parentDshSessionId: 'parent-1' }))
      .resolves.toEqual({ ok: true, value: { sessionId: 'S-child', acpSessionId: 'acp-child' } })
    expect(manager.calls).toContainEqual(['adoptForkedSession', { childDshSessionId: 'child-1', parentDshSessionId: 'parent-1' }])

    // Both ids are mandatory strings within the same bound every conversation
    // endpoint carries: absent, non-string, or over-length is one shape
    // failure, and none of them reaches the manager.
    const badPayloads: Array<Record<string, unknown>> = [
      {},
      { dshSessionId: 'child-1' },
      { parentDshSessionId: 'parent-1' },
      { dshSessionId: 7, parentDshSessionId: 'parent-1' },
      { dshSessionId: 'child-1', parentDshSessionId: null },
      { dshSessionId: 'x'.repeat(129), parentDshSessionId: 'parent-1' },
      { dshSessionId: 'child-1', parentDshSessionId: 'y'.repeat(129) },
    ]
    for (const payload of badPayloads) {
      await expect(dispatchRpc(manager, 'session/chat-fork-adopt', payload))
        .resolves.toMatchObject({ ok: false, error: { code: 'bad_payload' } })
    }
    expect(manager.calls.filter(([kind]) => kind === 'adoptForkedSession')).toHaveLength(1)

    // An older host half without the endpoint answers ok rather than failing —
    // the adopt is an optional surface, like the other chat-session ones.
    await expect(dispatchRpc({ ...manager, adoptForkedSession: undefined }, 'session/chat-fork-adopt', { dshSessionId: 'child-1', parentDshSessionId: 'parent-1' }))
      .resolves.toEqual({ ok: true, value: { done: true } })
  })

  it('invokes agent/probe-models as a manager method so the receiver (`this`) survives', async () => {
    const receiver = fakeManager() as AcpManager & { marker: string }
    receiver.marker = 'host'
    Object.assign(receiver, {
      // A `this`-reading method like the real BridgeManager.probeAgentModels
      // (which dereferences this.bridge); an arrow fake would hide the bug.
      probeAgentModels(this: { marker: string }, agentId: string): Promise<AgentProbeModelsResult> {
        if (this?.marker !== 'host') throw new AcpError('internal', 'probe lost its manager receiver')
        return Promise.resolve({ agentId, catalog: {}, updatedAt: 1 })
      },
    })
    await expect(dispatchRpc(receiver, 'agent/probe-models', { agentId: 'pi' })).resolves.toEqual({
      ok: true,
      value: { agentId: 'pi', catalog: {}, updatedAt: 1 },
    })
  })

  it('rejects oversized text payloads with a protocol error, not a crash', async () => {
    const manager = fakeManager()
    const huge = 'x'.repeat((1 << 20) + 1)
    const result = await dispatchRpc(manager, 'session/prompt', { sessionId: 'S', text: huge })
    expect(result.ok).toBe(false)
  })

  it('routes ui/delegate: undefined on a host half without the card', async () => {
    const manager = fakeManager()
    // Absent on a host half from before the card existed: the browser hides
    // the tab rather than showing a number it invented.
    await expect(dispatchRpc(manager, 'ui/delegate', {})).resolves.toEqual({ ok: true, value: { delegate: undefined } })
    const settings: AcpDelegateSettings = {
      guidance: 'on',
      timeoutMs: 600_000,
      defaultTimeoutMs: 2_400_000,
      configured: { guidance: 'off' },
      toolAvailable: true,
      restrictAvailable: true,
    }
    await expect(dispatchRpc({ ...manager, delegateSettings: () => settings }, 'ui/delegate', {}))
      .resolves.toEqual({ ok: true, value: { delegate: settings } })
  })

  it('routes ui/delegate-set: validates every field, writes, then re-reads', async () => {
    const manager = fakeManager()
    const settings: AcpDelegateSettings = {
      guidance: 'enhanced',
      timeoutMs: 600_000,
      defaultTimeoutMs: 2_400_000,
      toolAvailable: true,
      restrictAvailable: true,
    }
    const withDelegate = {
      ...manager,
      delegateSettings: () => settings,
      setDelegateSettings: async (patch: DelegateSetPayload) => { manager.calls.push(['setDelegateSettings', patch]) },
    }
    // A legal write reaches the manager, and the answer is the RE-READ snapshot
    // (the same write-then-read shape as ui/approval-deadlines-set).
    await expect(dispatchRpc(withDelegate, 'ui/delegate-set', { guidance: 'enhanced', timeoutMs: 300_000 }))
      .resolves.toEqual({ ok: true, value: { delegate: settings } })
    expect(manager.calls).toContainEqual(['setDelegateSettings', { guidance: 'enhanced', timeoutMs: 300_000 }])
    // Only the touched keys travel; reset travels as the key list.
    await expect(dispatchRpc(withDelegate, 'ui/delegate-set', { reset: ['guidance', 'timeoutMs'] })).resolves.toMatchObject({ ok: true })
    expect(manager.calls).toContainEqual(['setDelegateSettings', { reset: ['guidance', 'timeoutMs'] }])
    // An unknown key is dropped rather than persisted into state.
    await expect(dispatchRpc(withDelegate, 'ui/delegate-set', { bogusKey: 5 })).resolves.toMatchObject({ ok: true })
    expect(manager.calls).toContainEqual(['setDelegateSettings', {}])
    // Field-by-field validation: nothing illegal reaches the manager.
    for (const bad of ['maybe', 'ON', 1, null]) {
      await expect(dispatchRpc(withDelegate, 'ui/delegate-set', { guidance: bad }))
        .resolves.toMatchObject({ ok: false, error: { code: 'bad_payload' } })
    }
    // The retired permission key is no longer part of the reset vocabulary.
    const retired = ['permission', 'Mode'].join('')
    await expect(dispatchRpc(withDelegate, 'ui/delegate-set', { reset: [retired] }))
      .resolves.toMatchObject({ ok: false, error: { code: 'bad_payload' } })
    // Out-of-range / non-integer numbers are refused (the range is [1000, 86400000]).
    for (const bad of [999, 86_400_001, 0, -1, 1.5, '600000']) {
      await expect(dispatchRpc(withDelegate, 'ui/delegate-set', { timeoutMs: bad }))
        .resolves.toMatchObject({ ok: false, error: { code: 'bad_payload' } })
    }
    for (const bad of ['guidance', true, ['bogus'], ['guidance', 1]]) {
      await expect(dispatchRpc(withDelegate, 'ui/delegate-set', { reset: bad }))
        .resolves.toMatchObject({ ok: false, error: { code: 'bad_payload' } })
    }
    // The same key cannot be both written and reset in one call.
    await expect(dispatchRpc(withDelegate, 'ui/delegate-set', { guidance: 'on', reset: ['guidance'] }))
      .resolves.toMatchObject({ ok: false, error: { code: 'bad_payload' } })
    expect(manager.calls.filter(([kind]) => kind === 'setDelegateSettings')).toHaveLength(3)
    // A host half without the writer still validates and answers the re-read
    // (undefined here): the optional member is a no-op, never a crash.
    await expect(dispatchRpc(manager, 'ui/delegate-set', { guidance: 'on' }))
      .resolves.toEqual({ ok: true, value: { delegate: undefined } })
    await expect(dispatchRpc(manager, 'ui/delegate-set', { guidance: 'maybe' }))
      .resolves.toMatchObject({ ok: false, error: { code: 'bad_payload' } })
  })
})
