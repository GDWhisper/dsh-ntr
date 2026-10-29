import { AcpStore, DEFAULT_KNOWN_PRESETS, type RpcCall } from '../src/client/store.ts'
import type {
  AcpAgentDef,
  AcpApprovalDeadlines,
  AcpEvent,
  AcpPresetStatus,
  AcpTagHalo,
  AgentCatalogResult,
  AgentExposedModelsPayload,
  AgentProbeModelsResult,
  AgentSavePayload,
  AgentView,
  ApprovalDeadlinesSetPayload,
  DetectedAgentInfo,
  PermissionOutcome,
  PluginUpdateState,
  TagHaloSetPayload,
} from '../src/protocol.ts'

export type PanelPermissionRequest = Extract<AcpEvent, { type: 'permission/request' }>

export interface PanelRpcCall {
  channel: string
  endpoint: string
  payload: unknown
}

export interface PanelFixtureOptions {
  /** Empty means a loaded host with no configured agents. */
  agents?: AcpAgentDef[]
  /** Per-agent overrides; null represents a host with no cached catalog. */
  catalogs?: Record<string, AgentProbeModelsResult | null>
  defaultAgentId?: string | null
  /** null simulates an older host without the approval RPC. */
  approvalDeadlines?: AcpApprovalDeadlines | null
  preset?: AcpPresetStatus | null
  /** null simulates an older host without the version endpoint. */
  pluginVersion?: string | null
  /** null simulates an older host without the plugin-update RPCs. */
  pluginUpdate?: PluginUpdateState | null
  /** What `plugin/update-apply` answers; defaults to an installed 9.9.9. */
  pluginUpdateApplied?: PluginUpdateState
  /** Reject `plugin/update-apply` with this message (a transport/RPC failure). */
  pluginUpdateApplyError?: string
  tagHalo?: AcpTagHalo
  permissions?: PanelPermissionRequest[]
  /** Hold the first agents/list response to preview/test the loading state. */
  initialResyncGate?: Promise<void>
  locale?: (zh: string, en: string) => string
}

export interface PanelFixture {
  store: AcpStore
  rpc: RpcCall
  calls: PanelRpcCall[]
  /** Initial real AcpStore.resync, followed by any seeded permission frames. */
  ready: Promise<void>
  /** Deliver a host frame without opening an EventSource or a network socket. */
  applyEvent(event: AcpEvent): Promise<void>
}

const WORKSPACE = '/workspace/ntr-demo'
const CATALOG_TIME = Date.UTC(2026, 9, 28, 10, 30)

const DEFAULT_PLUGIN_UPDATE: PluginUpdateState = {
  status: 'current', current: '0.2.1', installed: '0.2.1', latest: '0.2.1',
}

const EXAMPLE_AGENTS: AcpAgentDef[] = [
  {
    id: 'codebuddy', title: 'CodeBuddy', command: 'codebuddy', args: ['--acp'],
    cwd: WORKSPACE, allowedCwdRoots: [WORKSPACE], exposedModels: ['deepseek-v3'],
  },
  {
    id: 'pi', title: 'pi', command: 'pi-acp', args: [],
    cwd: WORKSPACE, allowedCwdRoots: [WORKSPACE], exposedModels: ['gpt-5'],
  },
]

const EXAMPLE_CATALOGS: Record<string, AgentProbeModelsResult> = {
  codebuddy: {
    agentId: 'codebuddy', updatedAt: CATALOG_TIME,
    catalog: {
      model: {
        configId: 'model', name: 'Model', currentValue: 'deepseek-v3',
        choices: [
          { value: 'deepseek-v3', name: 'DeepSeek V3', description: 'x0.29 credits' },
          { value: 'claude-sonnet-4', name: 'Claude Sonnet 4', description: 'x1 credits' },
        ],
      },
      thought: {
        configId: 'thought_level', name: 'Thinking', currentValue: 'medium',
        choices: [{ value: 'medium', name: 'Medium' }, { value: 'high', name: 'High' }],
      },
    },
  },
  pi: {
    agentId: 'pi', updatedAt: CATALOG_TIME,
    catalog: {
      model: {
        configId: 'model', name: 'Model', currentValue: 'gpt-5',
        choices: [
          { value: 'gpt-5', name: 'GPT-5', group: 'OpenAI' },
          { value: 'claude-sonnet-4', name: 'Claude Sonnet 4', group: 'Anthropic' },
        ],
      },
    },
  },
}

export function createPanelFixture(options: PanelFixtureOptions = {}): PanelFixture {
  const definitions = new Map(structuredClone(options.agents ?? EXAMPLE_AGENTS).map(def => [def.id, def]))
  const catalogs = structuredClone({ ...EXAMPLE_CATALOGS, ...options.catalogs })
  const calls: PanelRpcCall[] = []
  const pending = new Map<string, PanelPermissionRequest>()
  const states = new Map<string, AgentView['state']>()
  let firstAgentRead = true
  let defaultAgentId = options.defaultAgentId === null ? undefined : options.defaultAgentId ?? 'codebuddy'
  let halo = structuredClone<AcpTagHalo>(options.tagHalo ?? { mode: 'breath', speed: 'normal' })
  const preset = options.preset === null ? null : structuredClone<AcpPresetStatus>(options.preset ?? {
    id: 'acp', source: 'dsh-ntr/presets/acp/acp.patch.yml', installed: true,
  })
  const initialDeadlines = structuredClone<AcpApprovalDeadlines>(options.approvalDeadlines ?? { mode: 'wait', permissionTimeoutMs: 300_000 })
  let deadlineMode = initialDeadlines.mode
  let deadlineWindow = initialDeadlines.permissionTimeoutMs
  let pluginUpdate = options.pluginUpdate === null
    ? null
    : structuredClone<PluginUpdateState>(options.pluginUpdate ?? DEFAULT_PLUGIN_UPDATE)

  function definition(agentId: string): AcpAgentDef {
    const def = definitions.get(agentId)
    if (def === undefined) throw new Error(`Unknown fixture agent: ${agentId}`)
    return def
  }

  function agentView(def: AcpAgentDef): AgentView {
    return {
      id: def.id, title: def.title ?? def.id, command: def.command, args: def.args ?? [],
      cwd: def.cwd ?? WORKSPACE, allowedCwdRoots: def.allowedCwdRoots ?? [def.cwd ?? WORKSPACE],
      state: states.get(def.id) ?? 'stopped', liveSessions: [], idleTimeoutMs: def.idleTimeoutMs ?? 1_800_000,
    }
  }

  function detectedAgents(): DetectedAgentInfo[] {
    const presets = DEFAULT_KNOWN_PRESETS.map(info => ({
      ...info, detected: definitions.has(info.id), currentConfig: definitions.get(info.id),
    }))
    const custom = [...definitions.values()].filter(def => !presets.some(info => info.id === def.id))
    return [...presets, ...custom.map(def => ({
      id: def.id, name: def.title ?? def.id, detected: true,
      defaultCommand: def.command, defaultArgs: def.args ?? [], currentConfig: def,
    }))]
  }

  function agentCatalog(agentId: string): AgentCatalogResult {
    const def = definition(agentId)
    const result = catalogs[agentId]
    const choices = result?.catalog.model?.choices ?? []
    const currentModel = choices.find(choice => choice.value === result?.catalog.model?.currentValue)
    const title = def.title ?? def.id
    return {
      agentId, title,
      base: { id: agentId, name: currentModel === undefined ? title : `${title} · ${currentModel.name}` },
      variants: choices.filter(choice => def.exposedModels?.includes(choice.value)).map(choice => ({
        id: `${agentId}@${encodeURIComponent(choice.value)}`, name: choice.name, description: choice.description,
      })),
      currentModel, probed: result != null, updatedAt: result?.updatedAt,
    }
  }

  function approvalDeadlines(): AcpApprovalDeadlines {
    return {
      ...initialDeadlines, mode: deadlineMode,
      // Match the host's effective abort floor without losing the stored window.
      permissionTimeoutMs: deadlineMode === 'abort' && deadlineWindow === 0 ? 30_000 : deadlineWindow,
    }
  }

  const applyEvent = async (event: AcpEvent): Promise<void> => {
    if (event.type === 'permission/request') pending.set(event.requestId, structuredClone(event))
    if (event.type === 'permission/resolved') pending.delete(event.requestId)
    if (event.type === 'permission/synced') {
      for (const id of pending.keys()) if (!event.requestIds.includes(id)) pending.delete(id)
    }
    if (event.type === 'agent/status') states.set(event.agentId, event.state)
    if (event.type === 'agent/exposure') {
      const def = definition(event.agentId)
      def.exposedModels = [...event.exposedModels]
      def.autoDiscoverModels = event.autoDiscoverModels
    }
    // Exercise the private SSE reducer without opening a real transport.
    await (store as unknown as { applyEvent(event: AcpEvent): Promise<void> }).applyEvent(structuredClone(event))
  }

  const rpc: RpcCall = async (channel, endpoint, payload) => {
    calls.push({ channel, endpoint, payload: structuredClone(payload) })
    const ok = (value: unknown): Awaited<ReturnType<RpcCall>> => ({ ok: true, value: structuredClone(value) })
    const unsupported = (): Awaited<ReturnType<RpcCall>> => ({
      ok: false, error: { code: 'unsupported', message: `unknown endpoint ${endpoint}` },
    })
    if (channel !== '/acp') return unsupported()
    try {
      switch (endpoint) {
        case 'agents/list':
          if (firstAgentRead) {
            firstAgentRead = false
            await options.initialResyncGate
          }
          return ok({ agents: [...definitions.values()].map(agentView) })
        case 'agents/detect': return ok({ agents: detectedAgents() })
        case 'sessions/list': return ok({ sessions: [] })
        case 'preset/status': return ok({ preset })
        case 'plugin/version':
          return options.pluginVersion === null ? unsupported() : ok({ version: options.pluginVersion ?? '0.2.1' })
        case 'plugin/update-check':
          return pluginUpdate === null ? unsupported() : ok(pluginUpdate)
        case 'plugin/update-apply': {
          if (pluginUpdate === null) return unsupported()
          if (options.pluginUpdateApplyError !== undefined) {
            return { ok: false, error: { code: 'fixture_error', message: options.pluginUpdateApplyError } }
          }
          pluginUpdate = structuredClone<PluginUpdateState>(options.pluginUpdateApplied ?? {
            status: 'restart-required', current: '0.2.1', installed: '9.9.9', latest: '9.9.9',
          })
          return ok(pluginUpdate)
        }
        case 'default/agent':
          return ok({ agentId: defaultAgentId !== undefined && definitions.has(defaultAgentId) ? defaultAgentId : undefined })
        case 'default/agent-set': {
          const { agentId } = payload as { agentId?: string }
          if (agentId !== undefined) definition(agentId)
          defaultAgentId = agentId
          return ok({ done: true })
        }
        case 'agent/save': {
          const def = structuredClone(payload as AgentSavePayload)
          definitions.set(def.id, { ...def, cwd: def.cwd ?? WORKSPACE, allowedCwdRoots: def.allowedCwdRoots ?? [def.cwd ?? WORKSPACE] })
          states.set(def.id, 'stopped')
          return ok({ done: true })
        }
        case 'agent/delete': {
          const { agentId } = payload as { agentId: string }
          definitions.delete(agentId)
          if (defaultAgentId === agentId) defaultAgentId = undefined
          return ok({ done: true })
        }
        case 'agent/stop': {
          const { agentId } = payload as { agentId: string }
          definition(agentId)
          states.set(agentId, 'stopped')
          return ok({ done: true })
        }
        case 'agent/test':
          return ok({ ok: true, durationMs: 12, stderr: [], agentInfo: { name: (payload as AgentSavePayload).title ?? 'Preview agent' } })
        case 'agent/cached-models':
          return ok(catalogs[(payload as { agentId: string }).agentId] ?? null)
        case 'agent/probe-models': {
          // Simulated result only: even explicit refresh/save never starts an agent.
          const { agentId } = payload as { agentId: string }
          definition(agentId)
          catalogs[agentId] ??= { agentId, catalog: {}, updatedAt: CATALOG_TIME }
          return ok(catalogs[agentId])
        }
        case 'agent/catalog': return ok(agentCatalog((payload as { agentId: string }).agentId))
        case 'agent/set-exposed-models': {
          const { agentId, exposedModels } = payload as AgentExposedModelsPayload
          const def = definition(agentId)
          if (exposedModels === undefined || exposedModels.length === 0) delete def.exposedModels
          else def.exposedModels = [...exposedModels]
          return ok({ done: true })
        }
        case 'agent/set-auto-discover-models': {
          const { agentId, autoDiscoverModels } = payload as { agentId: string; autoDiscoverModels: boolean }
          const def = definition(agentId)
          if (autoDiscoverModels) delete def.autoDiscoverModels
          else def.autoDiscoverModels = false
          return ok({ done: true })
        }
        case 'ui/tag-halo': return ok({ halo })
        case 'ui/tag-halo-set':
          halo = structuredClone((payload as TagHaloSetPayload).halo)
          return ok({ done: true })
        case 'ui/approval-deadlines':
          return options.approvalDeadlines === null ? unsupported() : ok({ deadlines: approvalDeadlines() })
        case 'ui/approval-deadlines-set': {
          if (options.approvalDeadlines === null) return unsupported()
          const patch = payload as ApprovalDeadlinesSetPayload
          if (patch.reset === true) {
            deadlineMode = initialDeadlines.configuredMode ?? 'wait'
            deadlineWindow = initialDeadlines.configured?.permissionTimeoutMs ?? 300_000
          } else {
            deadlineMode = patch.mode ?? deadlineMode
            deadlineWindow = patch.permissionTimeoutMs ?? deadlineWindow
          }
          return ok({ deadlines: approvalDeadlines() })
        }
        case 'permission/respond': {
          const { requestId, optionId } = payload as { requestId: string; optionId?: string }
          const ask = pending.get(requestId)
          if (ask === undefined) return ok({ done: false })
          if (optionId !== undefined && !ask.options.some(option => option.optionId === optionId)) {
            throw new Error(`Unknown fixture permission option: ${optionId}`)
          }
          const outcome: PermissionOutcome = optionId === undefined ? { outcome: 'cancelled' } : { outcome: 'selected', optionId }
          await applyEvent({ type: 'permission/resolved', requestId, sessionId: ask.sessionId, outcome })
          return ok({ done: true })
        }
        default: return unsupported()
      }
    } catch (error) {
      return { ok: false, error: { code: 'fixture_error', message: error instanceof Error ? error.message : String(error) } }
    }
  }

  const store = new AcpStore(rpc, options.locale ?? (zh => zh))
  const ready = store.resync().then(async () => {
    for (const permission of options.permissions ?? []) await applyEvent(permission)
  })
  return { store, rpc, calls, ready, applyEvent }
}
