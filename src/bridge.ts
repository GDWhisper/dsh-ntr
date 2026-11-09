/**
 * ACP client bridge: one child process per configured agent definition,
 * multiplexing any number of ACP sessions over the stdio connection.
 *
 * The browser NEVER reaches this layer directly; it goes through the `/acp`
 * Connection RPC channel (authenticated) into `BridgeManager`, which is the
 * only object allowed to spawn a configured command.
 */

export { PLUGIN_VERSION, PER_SESSION_AGENT_IDS, isPerSessionAgent, bridgeKey, perSessionLaunchArgs, perSessionLaunchEnv } from './bridge/identity.ts'
export type { BridgeScope } from './bridge/identity.ts'
export type { AcpModeResolver, BridgeTuning, DshAgentLike, SessionWorkspaceResolver, StartAttempt, SubagentCatalogReporter } from './bridge/types.ts'
export { ACP_PRESET_ID, AGENT_PRESETS, defaultAgentWorkspace, ensureDefaultWorkspace, pluginStateDir, rewriteLegacyWorkspaceRoots } from './bridge/state-paths.ts'
export type { AgentPreset } from './bridge/state-paths.ts'
export { detectHostAgents, ensureAgentExecutable, findExecutable, killProcessTree, npmInstallGlobal, windowsShimLaunch } from './bridge/process.ts'
export type { ExecutableResolution, ShimLaunch } from './bridge/process.ts'
export { ACP_ROUTE_BINDING_KEY, BACKGROUND_REPORT_FORM, BACKGROUND_REPORT_LOST_TEXT, BACKGROUND_REPORT_SOURCE, backgroundReportOf, recordAcpToolOutput, releaseAllToolOutputWaiters, routeBindingRegistry, waitForToolOutput } from './bridge/registries.ts'
export type { AcpRouteBindingRegistry, BackgroundWake } from './bridge/registries.ts'
export { AsyncQueue } from './bridge/async-queue.ts'
export { permissionToolName } from './bridge/turn-stream.ts'
export { agentRefusalDetail, permissionAskReason, subagentDispatchLabel } from './bridge/shape.ts'
export { AgentBridge } from './bridge/agent-bridge.ts'
export { classifyTestFailure } from './bridge/test-failure.ts'
export { BridgeManager } from './bridge/manager.ts'
export { AcpLlmAdapter } from './bridge/adapter.ts'
