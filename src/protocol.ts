/**
 * dsh-ntr shared contracts (browser-safe: pure types, constants and pure
 * string helpers — no side effects, no Node APIs, no SDK runtime values).
 *
 * This file is the BARREL: it declares nothing itself and only re-exports the
 * contract clusters under `src/protocol/`, so every existing `../protocol.ts`
 * import keeps resolving unchanged.
 *
 * Two planes:
 * - `AcpEvent`: host → browser, one JSON frame per `session/update` fold,
 *   permission round-trip, agent process status, and turn lifecycle.
 * - RPC payloads: browser → host unary calls on the `/acp` Connection channel.
 *
 * Security invariants encoded here (enforced host-side in impl.ts):
 * - A SESSION never names a program to spawn: `session/start` and the
 *   conversation↔agent binding only select a configured agent id and a cwd
 *   that must resolve inside the agent's allowed roots. Naming a program is
 *   a CONFIGURATION act instead — the browser may do it through `agent/save`
 *   / `agent/test`, both of which run the command through `validateAgentDef`
 *   (a command line, not a bare path) and both of which really spawn.
 * - Agent environment variables flow config → child process only.
 */

export type {
  AcpAgentDef,
  AcpDelegateConfig,
  AcpMcpServerDef,
  AcpMcpTransport,
  AcpPluginConfig,
} from './protocol/agent-def.ts'

export type {
  AcpPresetStatus,
  AcpReleaseCause,
  ActiveTurnView,
  AgentProcessState,
  AgentRefusalDetail,
  AgentView,
  SessionBurst,
  SessionView,
} from './protocol/views.ts'

export type {
  SaveGateCancelPayload,
  SaveGateCancelResult,
  SaveGateFlushResult,
  SaveGateOutcome,
  SaveGateOutcomeView,
  SaveGatePendingView,
  SaveGateRetryPayload,
  SaveGateRetryResult,
  SaveGateStatus,
} from './protocol/save-gate.ts'

export { DEFAULT_SAVE_GATE_TIMEOUT_MS } from './protocol/save-gate.ts'

// ---- External subagent lifecycle (the plugin's own record) ----

export type {
  SubagentDetailEntry,
  SubagentDetailPayload,
  SubagentDetailResult,
  SubagentRecord,
  SubagentStatus,
} from './protocol-subagent.ts'
export { MAX_SUBAGENT_DETAIL_ENTRIES, MAX_SUBAGENT_RECORDS } from './protocol-subagent.ts'

export type {
  AgentSkillEntry,
  AgentSkillScope,
  AgentSkillsPayload,
  AgentSkillsResult,
} from './protocol/skills.ts'

export type {
  AcpEvent,
  PermissionOptionView,
  PermissionOutcome,
} from './protocol/events.ts'

export type {
  AgentDetectResult,
  AgentExposedModelsPayload,
  AgentIdPayload,
  AgentSaveMode,
  AgentSavePayload,
  AgentSaveResult,
  AgentTestFailureKind,
  AgentTestResult,
  AgentsListResult,
  DefaultAgentResult,
  DefaultAgentSetPayload,
  DetectedAgentInfo,
  PermissionRespondPayload,
  PluginVersionResult,
  RpcResult,
  SessionConfigSetPayload,
  SessionIdPayload,
  SessionModeSetPayload,
  SessionPromptPayload,
  SessionPromptResult,
  SessionStartPayload,
  SessionsListResult,
  TranscriptGetPayload,
  TranscriptResult,
} from './protocol/rpc.ts'

export type {
  AcpConversationChoice,
  ChatBindPayload,
  ChatConfigSetPayload,
  ChatEffortSetPayload,
  ChatForkAdoptPayload,
  ChatForkAdoptResult,
  ChatModelSetPayload,
  ChatSessionForkInfo,
  ChatSessionListResult,
  ChatSessionView,
  ChatSessionsListResult,
  ChatTranscriptPayload,
  ChatTranscriptResult,
  ChatTranscriptView,
} from './protocol/chat.ts'

export type {
  PluginReleaseNotes,
  PluginUpdateState,
  PluginUpdateStatus,
} from './protocol/update.ts'

export { PLUGIN_REPO, pluginReleaseUrl } from './protocol/update.ts'

export type {
  AcpApprovalDeadlines,
  AcpDelegatePolicy,
  AcpDelegateSettings,
  AcpIdleRelease,
  AcpStartSessionOpts,
  AcpTagHalo,
  ApprovalDeadlineKey,
  ApprovalDeadlinePatch,
  ApprovalDeadlinesResult,
  ApprovalDeadlinesSetPayload,
  DelegateGuidance,
  DelegatePermissionMode,
  DelegateResult,
  DelegateSetPayload,
  DelegateSettingKey,
  IdleReleaseResult,
  IdleReleaseSetPayload,
  PermissionTimeoutMode,
  SessionTitlePrefixResult,
  SessionTitlePrefixSetPayload,
  SkillsMcpResult,
  SkillsMcpSetPayload,
  TagHaloResult,
  TagHaloSetPayload,
} from './protocol/ui.ts'

export {
  DEFAULT_DELEGATE_GUIDANCE,
  DEFAULT_DELEGATE_OUTPUT_CHARS,
  DEFAULT_DELEGATE_PERMISSION_MODE,
  DEFAULT_DELEGATE_TIMEOUT_MS,
  DEFAULT_IDLE_TIMEOUT_MS,
  DEFAULT_SESSION_TITLE_PREFIX,
  DEFAULT_TAG_HALO,
  DELEGATE_GUIDANCE,
  DELEGATE_OUTPUT_CHARS,
  DELEGATE_TIMEOUT_MS,
  IDLE_RELEASE_MS,
  SESSION_TITLE_PREFIX,
} from './protocol/ui.ts'

export type {
  AcpAgentCatalog,
  AcpCatalogChoice,
  AcpCatalogOption,
  AgentCatalogExtraOption,
  AgentCatalogResult,
  AgentProbeModelsResult,
} from './protocol/catalog.ts'

export { effectiveExposedModels } from './protocol/catalog.ts'

export type {
  GenerateMessage,
  GenerateMessageSource,
  GenerateOptions,
  LlmAdapterLike,
  LlmModelInfo,
  LlmModelReasoningInfo,
  LlmProviderInfo,
  LlmReasoningEffortInfo,
  LlmResolvedModelInfo,
  PreparedAdapterCall,
  StreamChunk,
} from './protocol/llm.ts'
