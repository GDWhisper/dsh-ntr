/**
 * Pure host-side logic for dsh-ntr: config validation, workspace guard,
 * child env assembly, agent-skill flavor matching and frontmatter parsing,
 * capped transcript, event hub, and the RPC dispatcher. No Node imports, no
 * SDK imports — everything here is testable with plain fakes.
 *
 * This file is the BARREL only: it declares nothing and re-exports the clusters
 * under `src/impl/`, so every existing `../impl.ts` import keeps resolving
 * unchanged.
 */

import { randomUUID } from './ids.ts'

export { randomUUID }

export { AcpError } from './impl/errors.ts'

// ---- Config validation ----

export {
  APPROVAL_DEADLINE_MAX_MS,
  APPROVAL_DEADLINE_MIN_WAIT_MS,
  normalizeApprovalWindow,
  normalizeExposedModels,
  validateAgentDef,
  validateApprovalDeadlineMs,
  validateApprovalDeadlines,
  validateConfig,
  validateDelegateConfig,
  validateDelegateGuidance,
  validateDelegateMs,
  validateDelegateSettings,
  validateIdleReleaseMs,
  validateMcpServers,
  validatePermissionTimeoutMode,
  validateTagHalo,
} from './impl/validate.ts'

// ---- Command lines ----

export { quoteCommandToken, splitCommandLine, tokenizeCommandLine } from './impl/command-line.ts'

// ---- Workspace guard ----

export { canonicalizeFsPath, isAbsolutePath, isUnderPath, resolveFsPath, resolveSessionCwd } from './impl/paths.ts'

// ---- Child environment ----

export { childEnv } from './impl/env.ts'

// ---- Model catalog ----

export {
  MAX_CONFIG_OPTIONS_BYTES,
  buildAdapterModelId,
  hasUnambiguousModelSelector,
  mergeCatalogShape,
  parseCatalogOptions,
  splitAdapterModelId,
  usableConfigOptions,
} from './impl/catalog.ts'

// ---- ACP tool-call notifications ----

export type { AcpContentRow, AcpDiffPayload, AcpToolCallDelta, AcpToolCallSnapshot } from './impl/content.ts'
export {
  ACP_TOOL_CALL_NAME,
  BOOKKEEPING_UPDATES,
  USER_ECHO_UPDATES,
  acpContentRows,
  acpToolCallArgsOf,
  acpToolCallDelta,
  acpToolCallFromUpdate,
  describeUnhandledUpdate,
  dumpJson,
  formatAcpDiff,
  isAcpToolContinuation,
  isFinalToolCallStatus,
  updateContentToText,
} from './impl/content.ts'

// ---- Prompt images and the forwarded prompt ----

export type { PromptContentBlock, PromptImageContent, PromptTextContent } from './impl/image.ts'
export {
  detectImageMimeFromMagic,
  guessImageMimeType,
  isLocalFilePath,
  parseImageDataUrl,
  resolveImageContent,
} from './impl/image.ts'
export { normalizeFileUrlToPath, resolveImageAttachmentFromContext } from './impl/attachments.ts'

export type { ForwardPromptSelection } from './impl/forward.ts'
export { SESSION_TITLE_PLACEHOLDER_MAX, extractSessionTitlePlaceholder, selectForwardPrompt } from './impl/forward.ts'

// ---- Permission vocabulary ----

export type { PendingPermissionFields, PendingPermissionView } from './impl/permission.ts'
export {
  AUTO_OPTION_KIND_PRIORITY,
  DELEGATE_AUTO_KIND_PRIORITY,
  permissionReplayFrames,
  permissionRequestFrame,
  permissionToolKind,
  permissionToolPaths,
  pickAutoOption,
} from './impl/permission.ts'

// ---- Agent skills (pure half) ----

export type { SkillDirTable, SkillFlavor } from './impl/skills.ts'
export {
  GENERIC_SKILL_DIRS,
  SKILL_DIRS_BY_FLAVOR,
  SKILL_SCAN_LIMITS,
  formatSkillMentionPrompt,
  formatSkillPathDestination,
  parseSkillFrontmatter,
  skillFlavorOf,
  skillMentionToken,
  skillMetadata,
} from './impl/skills.ts'

// ---- The agent preset a session runs ----

export type { RosterPresetRow, SessionCatalogLike, SessionLogLike } from './impl/session-log.ts'
export {
  ACP_PRESET_SOURCE,
  acpPresetStatusFromRoster,
  appendExternalSubagentCatalog,
  sessionAgentPreset,
  sessionAgentPresetFromLog,
} from './impl/session-log.ts'

// ---- Worker lifecycle records (pure half; persistence lives in `src/bridge/`) ----

export {
  ACP_TOOL_RAW_MAX,
  boundSubagentDetailEntry,
  capSubagentRecords,
  normalizeSubagentRecord,
  normalizeSubagentRecordMap,
  subagentToolCallId,
} from './subagent-records.ts'

// ---- Runtime: transcript, event hub, permission ledger ----

export type { PendingPermission } from './impl/runtime.ts'
export { EventHub, PermissionLedger, Transcript } from './impl/runtime.ts'

// ---- RPC surface ----

export type { AcpManager } from './impl/dispatch.ts'
export { agentSaveAction, dispatchRpc, emptySaveGateStatus } from './impl/dispatch.ts'
