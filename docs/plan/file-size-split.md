# 巨型文件拆分计划（第二轮：三件套 / 设置页 / 协议覆盖 / UI 面）

**状态**：**P0 / P1 / P2 / P3a 已完成，P3b 第一批（leaf 服务）已完成，P3b 其余批次与 P4–P6 未开始**。承接 [bridge-split.md](./archive/bridge-split.md)（第一轮，已完成）的纪律与模式。
**一句话**：把行数基线里**仍在增长**的存量文件按领域簇拆到 ≤1000 行并删除基线条目；功能面已封闭的文件继续锁着不动。

> 写作约定：代码位置一律用「文件 + 符号名」，不写行号。**本文不锁定任何文件的当前行数**——正式执行前代码仍会变动，行数与符号清单在每个子步开工时以 HEAD 实测重新核对；本文锁定的只有「领域簇划分、归属、顺序、停止条件」。索引登记进 [docs/README.md](../README.md)，待办登记进 [docs/todo.md](../todo.md)。

---

## 1. 拆分对象与优先级

判断依据（2026-11-11 实测，仅作优先级参考，不作执行依据）：仓库 238 个提交里 220 个在近 30 天，处于爆发期；「会不会继续增长」看**功能面是否封闭**，不看单日趋势。

| 梯队 | 文件 | 为什么还要拆 |
|---|---|---|
| P1 | `src/protocol.ts` | 纯类型契约，每个新 RPC / 字段都落这里（30 天 41 提交）；最安全，先拆它建立目录约定 |
| P2 | `src/impl.ts` + `tests/impl.spec.ts` | RPC 分发与校验，每个新功能必经（39 / 38 提交）；测试镜像随主体拆 |
| P3 | `src/client/store.ts` + `tests/store.spec.ts` | 前端状态机，体量最大、全仓最热（44 / 37 提交）；最难，放在三件套最后 |
| P4 | `src/client/panel.tsx` + `tests/panel.spec.ts` | 设置页，每加一个设置长一截（29 提交）；组件边界天然清晰 |
| P5 | `src/bridge/turn-stream.ts`、`src/bridge/agent-bridge.ts`、`tests/mock-agent.mjs` | 协议覆盖面仍在扩（约束 29：每种 update 都要有去处；agent 风味持续增加）；bridge 层刚拆完第一轮，让它先沉淀 |
| P6 | `src/client/acp-ui.tsx`、`src/client/index.tsx`、`src/client/session-controls.tsx`、`tests/acp-view.spec.ts` | UI 面仍在涨但体量较小，顺带拆，不急 |

**不拆清单**（功能面已封闭或增长已被引流，继续锁在基线里）：

- `tests/update.spec.ts`：内置更新已完整落地（约束 37），30 天仅 3 提交。
- `tests/model-seat.spec.ts`：座位 claim 机制已定稿（约束 20，竞争式遮蔽已退役）。
- `tests/bridge.spec.ts`：第一轮拆分后只剩核心生命周期用例，新测试按主题进 `tests/bridge/`，增长已被设计性引流。
- `src/bridge/manager.ts`：第一轮拆分刚收尾，新功能进服务文件、它只做接线，有望稳住。
- `src/client/subagent-panel.tsx`：已实现待验收（[subagent-panel.md](./subagent-panel.md)），只超上限一点，验收打磨后可能自愈清零。

## 2. 不变约束（每个子步都适用）

1. **棘轮**：新文件 ≤1000 行硬门禁；基线只许缩不许长，**严禁新增条目或抬线**；文件降到 ≤1000 即删条目；每个子步收尾把被动到文件的锁定值**收紧到当时实测行数**（只缩不抬）。
2. **行为零变化**：纯移动 + 导入改写，不改逻辑、不改公共导出面；测试只迁移不重写，describe 标题与用例数不变。
3. **桶文件模式**（沿用第一轮）：原文件保留为纯桶，公共导出面在子步开工时盘点造册、拆完逐一核对，不得增减；服务不得运行时反向导入桶或门面，只允许 `import type` 且注释说明。
4. **模块纯度**（AGENTS.md 边界）：`protocol` 拆分产物仍是纯类型 / 纯常量 / 纯函数；`impl` 拆分产物严禁 Node 内置模块与 ACP SDK；`client` 拆分产物严禁 Node 内置模块与 SDK，通信只走 RPC / SSE。
5. 相对导入必须带 `.ts` / `.tsx` 后缀（约束 6）；`lib/` 不手改、不提交。
6. 每个子步单独提交 `refactor(acp):`，提交前 `npm run prepack` 全绿；动了 `AGENTS/` 描述的代码，同提交更新对应文档的符号归属。
7. 每个子步完成后派**独立上下文子代理审核**：跑 tsc、全量测试与构建，逐符号比对 HEAD。
8. 测试拆分沿用 `tests/bridge/` 先例：按主题进 `tests/<模块>/` 目录，共享 harness 独立成文件；`vitest.config.ts` 的 `maxForks: 1` 不动。

## 3. P0：基线补紧（小步，先做）

第一轮拆分后基线锁定值没有随收缩下调（如 `manager.ts`、`tests/bridge.spec.ts` 的锁仍远高于实测），棘轮存在「涨回旧锁不拦」的漏洞。

- 把 [file-size-baseline.json](../../scripts/file-size-baseline.json) 中**实测已低于锁定值**的条目逐一收紧到当时实测行数；已 ≤1000 的直接删条目。
- 只改 JSON，不改代码；`npm run check:size` 通过后单独提交 `chore(acp):`。
- 此后每个子步收尾都重复本动作（约束 2.1），不再单列阶段。

**执行结果**：6 条按实测收紧（`src/bridge/agent-bridge.ts` / `src/bridge/turn-stream.ts` / `src/client/index.tsx` / `src/client/session-controls.tsx` / `src/protocol.ts` / `tests/mock-agent.mjs`），其余条目实测 = 锁定值；没有文件降到 ≤1000，故未删条目（`src/protocol.ts` 的条目在 P1 收尾时删除）。

## 4. P1：`src/protocol.ts` → `src/protocol/`

纯类型最安全，先建立「目录 + 桶」约定。建议簇（开工时以导出面盘点为准）：

| 新文件 | 内容（代表符号） |
|---|---|
| `agent-def.ts` | `AcpAgentDef`、`AcpMcpTransport`、`AcpMcpServerDef`、`AcpPluginConfig` |
| `views.ts` | `AgentProcessState`、`AgentView`、`SessionView`、`ActiveTurnView`、`SessionBurst`、`AgentRefusalDetail`、`AcpReleaseCause`、`AcpPresetStatus` |
| `events.ts` | `AcpEvent` 及其组成视图（`PermissionOptionView`、`PermissionOutcome` 等） |
| `save-gate.ts` | `SaveGateStatus` / `SaveGateOutcome` / `SaveGate*Payload` / `SaveGate*Result` / `DEFAULT_SAVE_GATE_TIMEOUT_MS` |
| `chat.ts` | `ChatSessionView`、`ChatSessionForkInfo`、`ChatSession*Result`、`ChatTranscript*` |
| `rpc.ts` | `RpcResult`、各 `*Payload` / `*Result`（`SessionPromptPayload`、`AgentsListResult` 等） |
| `update.ts` | `PluginUpdateStatus`、`PluginUpdateState`、`PluginReleaseNotes`、`PLUGIN_REPO`、`pluginReleaseUrl` |
| `skills.ts` | `AgentSkillScope`、`AgentSkillEntry`、`AgentSkillsResult`、`AgentSkillsPayload` |
| `ui.ts` | `AcpTagHalo`、`DEFAULT_TAG_HALO` 等 UI 杂项 |

- `src/protocol.ts` 保留为桶；文件内现有 `export type { … }` 再导出块逐字保留去向。
- 风险：类型循环引用（`import type` 允许成环，但运行时常量不行）；`pluginReleaseUrl` 等纯函数随 `update.ts` 走，保持纯度。
- 验收：tsc 全绿即基本成立；导出面逐一核对；基线删条目。

**落地记录**：按导出面盘点定成 11 个文件——上表九个之外，`rpc.ts` 装不下的一半（模型目录的 `AcpAgentCatalog*` / `AgentCatalog*`）落 `catalog.ts`，LLM adapter 契约（`Llm*` / `StreamChunk` / `Generate*` / `LlmAdapterLike`）落 `llm.ts`；`AcpConversationChoice` 随 `session/chat-list` 的 `choice` 进 `chat.ts`，`PermissionTimeoutMode` 与审批时限 / 空闲释放 / 标签光晕 / 标题前缀一起进 `ui.ts`。子文件之间只有 `import type`，运行时常量零交叉，桶是唯一对外入口。

## 5. P2：`src/impl.ts` → `src/impl/` + `tests/impl.spec.ts` → `tests/impl/`

impl 几乎全是纯函数 + 小类 + 一个自由函数分发器，按领域机械拆。建议簇：

| 新文件 | 内容（代表符号） |
|---|---|
| `errors.ts` | `AcpError` |
| `validate.ts` | `validateAgentDef`、`validateConfig`、`validateMcpServers`、`normalizeExposedModels`、`validateTagHalo`、审批 / 空闲释放各 normalize / validate |
| `command-line.ts` | `tokenizeCommandLine`、`splitCommandLine`、`quoteCommandToken` |
| `paths.ts` | `isAbsolutePath`、`isUnderPath`、`resolveSessionCwd`、`canonicalizeFsPath`、`resolveFsPath` 及私有辅助（对应 [AGENTS/paths.md](../../AGENTS/paths.md)） |
| `env.ts` | `childEnv` |
| `catalog.ts` | `parseCatalogOptions`、`mergeCatalogShape`、`hasUnambiguousModelSelector`、`usableConfigOptions`、`splitAdapterModelId`、`buildAdapterModelId` 及私有辅助 |
| `content.ts` | `acpToolCall*`、`isFinalToolCallStatus`、`isAcpToolContinuation`、`acpContentRows`、`updateContentToText`、`dumpJson`、`BOOKKEEPING_UPDATES`、`describeUnhandledUpdate` |
| `image.ts` | `PromptContentBlock`、`guessImageMimeType`、`parseImageDataUrl`、`normalizeFileUrlToPath`、`detectImageMimeFromMagic`、`resolveImageAttachmentFromContext`、`resolveImageContent` 等 |
| `forward.ts` | `selectForwardPrompt`、`extractSessionTitlePlaceholder`、`SESSION_TITLE_PLACEHOLDER_MAX`（约束 16） |
| `permission.ts` | `pickAutoOption`、`permissionToolKind`、`permissionToolPaths`、`permissionRequestFrame`、`permissionReplayFrames` |
| `skills.ts` | `skillFlavorOf`、`SKILL_DIRS_BY_FLAVOR`、`parseSkillFrontmatter`、`skillMetadata`、`skillMentionToken`、`formatSkill*` |
| `session-log.ts` | `appendExternalSubagentCatalog`、`sessionAgentPreset*`、`acpPresetStatusFromRoster`、`ACP_PRESET_SOURCE` |
| `runtime.ts` | `Transcript`、`EventHub`、`PermissionLedger` |
| `dispatch.ts` | `AcpManager` 接口、`dispatchRpc`（case 清单原样保留） |

- `src/impl.ts` 保留为桶。`tests/impl.spec.ts` 按同一领域映射拆进 `tests/impl/`，共享 helper 独立成 harness 文件；用例标题与数量不变。
- 风险：`paths.ts` 与浏览器手拷贝 `isAbsolutePathLike` 的等价测试必须保持绿；`dispatch.ts` 的校验顺序与错误码逐字保留；约束 5（`error.data` 优先）所在函数不丢。
- 子步建议：先纯函数簇（validate / command-line / paths / env / catalog / content / image / forward / permission / skills / session-log），再 runtime，最后 dispatch；每个簇一次提交一次审核。

**落地记录**（三个提交）：

1. **纯函数簇**：落 13 个文件——上表十二个之外，`image.ts` 一次拆超限（1058 行），再分 `attachments.ts`（附件定位：`normalizeFileUrlToPath` / `resolveImageAttachmentFromContext`，另含簇内导出 `readImageFileFromContext`）与 `image.ts`（MIME / 魔数 / data URL / `resolveImageContent`）。`PendingPermissionFields` / `PendingPermissionView` 是帧构造器的入参，随 `permission.ts` 走；`PendingPermission` 只属账本，随 `runtime.ts` 走，于是两文件之间只剩 `import type`、无反向依赖。`STABLE_SEMVER` 由 `validate.ts` 簇内导出（桶不导出），等 dispatch 迁出时随唯一使用者走。此提交桶仍是 runtime + dispatch 两段原样内联，基线条目 `src/impl.ts` 4182 → 1026；测试未动。
2. **运行时与分发**：`runtime.ts`（`Transcript` / `EventHub` / `PendingPermission` / `PermissionLedger`）与 `dispatch.ts`（`AcpManager` + `emptySaveGateStatus` / `agentSaveAction` / `dispatchRpc`）逐字搬出，case 清单、校验顺序与错误码不动；`STABLE_SEMVER` 随唯一使用者进 `dispatch.ts` 成私有常量，`validate.ts` 不再导出。桶降到 149 行、纯再导出，基线条目 `src/impl.ts` 已删（≤1000 即删）；测试未动。
3. **测试镜像**：`tests/impl.spec.ts`（3445 行）拆进 `tests/impl/` 16 个 `.spec.ts` + `harness.ts`（`agentDef` / `fakeManager` 两个 fake），按 `src/impl/` 同名簇映射，用例标题与数量逐字不变（173 / 173，文件名级差异用 vitest JSON reporter 比对确认）。1031 行的 `selectForwardPrompt` 套件按主题一分为三（`forward.spec.ts` 纯选择 3 例、`image.spec.ts` 载荷解析 21 例、`image-attachments.spec.ts` 附件存储 12 例），三处保留同一 describe 标题；`agentRefusalDetail`（导入自 `src/bridge.ts`）落 `refusal.spec.ts`。原文件已删除，基线条目 `tests/impl.spec.ts` 同提交删除；新文件最大 523 行。

## 6. P3：`src/client/store.ts` → `src/client/store/` + `tests/store.spec.ts` → `tests/store/`

全仓最热最难，分两段：

**P3a 纯函数与类型先行**（无状态，机械迁移）：

- `blocks.ts`：`Block`、`foldUpdate`、`STATE_ONLY_UPDATES`、`usageFromUpdate`、`replayChatRowFrames`、`jsonText`、`toolInputOf`、`toolDetailsOf`、`describeEvent`
- `save-gate.ts`：`composeSaveBanners`、`saveGateIsAvailable`、`saveGateAgentId`、`saveGateInterruptTargets`、`saveGateOutcomeForLabel`、`saveGateOutcomeSuperseded`、`saveGateTransitions`、`SaveBanner*` 类型
- `permission.ts`：`permissionsForSession`、`deadlineRemainingLabel`、`PERMISSION_DEADLINE_EXPIRED`
- `fork.ts`：`forkStateOf`、`ChatForkState`、`ChatForkOutcome`
- `subagent.ts`：`subagentKey`、`subagentToolCallId`、`mergeSubagentSnapshot`、`compactDetailValue`、`boundedDetailEntry`、`MAX_SUBAGENT_DETAIL_WORKERS`、`SUBAGENT_RAW_MAX`
- `presets.ts`：`DEFAULT_KNOWN_PRESETS`（与 `AGENT_PRESETS` 的手拷贝同步关系不变，约束 7）
- `state.ts`：`UiState`、`ChatRowFrame`、`ChatTranscript`、`AcpLogEntry`、`RpcCall` 等类型

**落地记录（P3a）**：七个簇文件按上表落成，`PendingPermission` 随 `permission.ts`（`UiState.permissions` 与 `permissionsForSession` 共用），`LiveSubagentDetailEntry` / `SubagentDetailState` 与 `subagentKey` 同簇进 `subagent.ts`，`AgentCommand` / `skillRowsKey` / `SKILL_MENU_TTL_MS` / `MAX_SKILL_KEYS` / `LOG_MAX_ENTRIES` 及 `AcpStore` 的类内私有辅助（`withSessionUsage` / `sameUsage` / `trimBlocks` / `parentToolCallIdOf` / `appendSubagentDetailEntry` / `sameModes` / `withSessionModes` / `splitModelAgentId` / `usageOfBatch` / `normalizeSaveGateStatus`）留在 `store.ts`；`withSessionReleased`（`blocks.ts`）与 `isSubagentDowngrade`（`subagent.ts`）因类与纯函数共用而簇内导出、桶不导出。`state.ts` → `blocks.ts` 是**唯一的类型环**（`ChatRowFrame` 在 `state.ts`、`replayChatRowFrames` 在 `blocks.ts`，只走 `import type`），运行时常量零交叉。`store.ts` 保留类与其余内容，文件尾把 49 个拆出符号逐一再导出，导出面与 HEAD 逐项一致；测试镜像三个（`tests/store/blocks.spec.ts` 11 例、`fork.spec.ts` 2 例、`save-gate.spec.ts` 1 例）从 `tests/store.spec.ts` 原样搬出（152 → 138 + 14，标题与用例数逐字不变），类相关用例留原文件。

**P3b `AcpStore` 类按领域拆服务**（沿用 bridge 的「服务 + Host 回调」模式，Host 预计是 `rpc` / `mutate` / `getSnapshot` / 少量跨域读写）：

| 服务 | 方法簇（代表） |
|---|---|
| `connection.ts` | `start`、`connectStream`、`resync`、`applyEvent`、`flushUpdates`、`armUpdateFlush`、`pushChatRowFrame` |
| `agent-admin.ts` | `detectAgents`、`saveAgent`、`testAgent`、`deleteAgent`、`stopAgent`、`setDefaultAgent` |
| `catalog.ts` | `loadCachedModels`、`probeModels`、`loadAgentCatalog`、`setExposedModels`、`setAutoDiscoverModels`、`invalidateSeatCatalog` |
| `chat-choice.ts` | `bindChatAgent`、`setChatSessionModel`、`setChatSessionEffort`、`setChatSessionConfig`、`writeChoice` |
| `chat-sessions.ts` | `loadChatSessions`、`readChatSessionList`、`loadChatTranscript`、`forkChatSession`、`resumeChatSession`、`setChatSessionMode`、`transcriptOf` / `chatTranscriptOf` |
| `save-banners.ts` | `saveGatePatch`、`pushSaveBanner`、`forceSaveGate`、`cancelSaveGate`、`retrySaveGate`、各 `push*Banner` / `dismissBanner` / `retryBanner` / `forceBanner` |
| `settings.ts` | `setTagHalo`、`setTitlePrefix`、`setApprovalDeadline` / `setApprovalTimeoutMode` / `resetApprovalDeadlines`、`setIdleRelease` / `resetIdleRelease` |
| `update.ts` | `checkPluginUpdate`、`applyPluginUpdate`、`loadPluginReleaseNotes` |
| `subagent-detail.ts` | `loadSubagentDetail`、`withSubagentDetail`、`foldSubagentDetailFrames` |
| `skills.ts` | `skillRowsFor`、`loadAgentSkills`、`skillInsertionFor`、`chatSessionCommands` / `agentCommands` |

- `AcpStore` 保留装配、订阅（`subscribe` / `getSnapshot`）、`UiState` 持有与薄委托；ACP mode 判定（`noteAcpMode` / `hasAcpModeVerdict` / `invalidateAcpMode`）与各 `note*Diag` 留门面。
- **停止条件**（沿用第一轮）：Host 回调超过 10 个、服务需要运行时导入门面、逐方法比对无法保持调用顺序或失败语义——触发即回退该子步，把障碍写回本文件。
- 风险：`mutate` 的广播合并时序、`applyEvent` 的事件顺序、保存横幅的失败常驻 / 成功合成语义（约束 38）、`writeChoice` 只增不减（约束 27）。
**落地记录（P3b 第一批）**：`settings.ts`（Host：`call` / `mutate` / `state` / `flashError`，4 个）、`update.ts`（`call` / `mutate` / `state` / `label`，4 个）、`catalog.ts`（另加 `flashError` / `resync`，6 个）、`skills.ts`（`call` / `mutate` / `state` / `chatAgentFor`，4 个）、`subagent-detail.ts`（`call` / `mutate` / `state`，3 个）五个服务落成，各自持有本来属于类的私有簿记（节流窗、in-flight 去重、`liveSeq`、目录读去重），服务一律只经 `host.mutate` 写快照、**完全不含门面导入**（连 `import type` 都不需要：`UiState` 走 `state.ts`）。`AgentCommand` / `skillRowsKey` / `SKILL_MENU_TTL_MS` / `MAX_SKILL_KEYS` 随 `skills.ts` 迁走，`store.ts` 文件尾原样再导出，外部导入面不变；`AgentSkillEntry` / `SubagentDetailState` / `PermissionTimeoutMode` 等签名类型仍从 `protocol.ts` / 子簇走。
**`agent-admin` 触发停止条件，留在门面**：`saveAgent` 的失败路径直接写保存横幅簇（`pushSaveBanner` / `bannerRetries` / `clearAgentSaveFailures` / `clearAgentSaveBanners` / `saveGatePatch`），并串 `resync`；`detectAgents` 读写 `detectCounts`，`deleteAgent` 走 `rememberDeletedAgent` + `invalidateSeatCatalog`，`testAgent` / 保存后刷新又调 `resync` / `probeModels` / `loadCachedModels`——实测 Host 回调 13+ 个，越过「>10」的线；提前拆 `save-banners` 会造出 saveAgent ↔ save-banners 的服务间递归。故本批不拆，待 `save-banners.ts` 先落地的那一批再拆 `agent-admin.ts`（届时 `saveAgent` 只经 save-banners 的 Host 面报告失败）。`connection` / `chat-choice` / `chat-sessions` / `save-banners` 四个服务同样留待后续批次。
测试镜像：`tests/store.spec.ts` 138 例 → 107 例 + `tests/store/` 下 31 例（`settings.spec.ts` 3、`catalog.spec.ts` 9、`update.spec.ts` 8、`skills.spec.ts` 7、`subagent-detail.spec.ts` 4），describe 标题与用例数逐字不变，共享 `makeStore` / `detailOf` 进 `tests/store/harness.ts`；agent-admin 用例（detect / save / delete / test / setDefaultAgent）留原文件。基线同时收紧：`src/client/store.ts` 3217 → 2676，`tests/store.spec.ts` 4001 → 3016。

- `tests/store.spec.ts` 按同领域拆；纯函数用例已随 P3a 搬进 `tests/store/`，其余（类驱动）随 P3b 的服务划分迁移。

## 7. P4：`src/client/panel.tsx` → `src/client/panel/` + `tests/panel.spec.ts` → `tests/panel/`

组件边界天然清晰，机械拆：

| 新文件 | 内容 |
|---|---|
| `styles.ts` | `STYLE`、`ensureStyle`（单次注入语义不变） |
| `shared.ts` | `useUi`、`stateVisual`、`streamText`、`exposureKey`、`sameStringArray` / `sameStringMap`、`canonicalJson`、`partitionAgents`、`persistedDef` |
| `form.ts` | `initialForm`、`buildPayload`、`payloadEquals`、`parseMcpServers`、`mcpTextValid`、`mcpKey`（三处同步关系不变，见 AGENTS.md 常见任务配方） |
| `agent-row.tsx` | `AgentRow`、`RowMenu`、`armModelIdMarquee` |
| `agent-details.tsx` | `AgentDetails`、`WorkspaceBlock`、`idleText` / `idleValid` / `formatStamp` |
| `model-catalog-block.tsx` | `ModelCatalogBlock` |
| `approval-deadlines-card.tsx` | `ApprovalDeadlinesCard`、`DeadlineModeBlock`、`DeadlineSliderBlock`、`approvalDeadlineFacts`、`deadlineValueFor` / `deadlineSliderIndex` / `deadlineLadder` / `deadlineText` / `modeText` |
| `idle-release-card.tsx` | `IdleReleaseCard`、`nearestIdleRung`、`idleWindowText` |
| `plugin-update.tsx` | `PluginUpdateBadge`、`PluginUpdateCard`、`updateBadgeText`、`updateCardVisible`、release notes 预览 |
| `permission-mirror.tsx` | `permissionLedgerCard` 及镜像渲染、`agentTestHint` |

- `AcpSettingsSection` 主组件与页头 notice 留 `panel.tsx`；`logClock` 等日志辅助随主组件。
- 风险：样式注入只许一次；`payloadEquals` 判脏语义决定保存是否重启 agent，逐字保留；约束 33 / 34 / 38 的文案与 token 纪律不随迁移改变。
- `tests/panel.spec.ts` 按同映射拆。

## 8. P5：协议覆盖（bridge 第二轮 + mock）

第一轮刚收尾，**执行前确认 bridge 层已沉淀**（无在途大改）。逐文件：

- **`turn-stream.ts`**：background hold 簇（`holdForBackgroundDispatch`、`startBackgroundDrain`、`armBackgroundQuiet` / `armBackgroundCeiling`、`onBackgroundQuiet` / `onBackgroundHard` / `onBackgroundGraceExpired`、`closeBackgroundHold`、`flushBackgroundHoldUpdates` 等约二十个方法）→ `background-hold.ts`；ambient 簇（`awaitAmbient`、`bufferAmbientUpdate`、`flushPendingAmbient`、`finishAmbient`、`isAmbientOwned` / `isForeignAmbientText` 等）→ `ambient-wait.ts`；TPS 三方法（`trackTps` / `pushLiveTps` / `finalizeTps`）评估并入现有 `src/tps.ts`。段生命周期（`startSegment` / `finishSegment` / `closeTurn` / `drainTail` / `foldInto`）留主体。**风险最高**：约束 23 的收口时机、世代守卫、滚动静默窗与长档切换逐字保留；`LiveSession` 接口不动。
- **`agent-bridge.ts`**：permission 簇（`handlePermissionRequest`、`announceExpiredAsk` / `settleExpiredAsk` / `settlePermissions`、`applyApprovalDeadlines`）→ `permission-handler.ts`；fs 簇（`handleFsRead` / `handleFsWrite` / `guardFsPath`）→ `fs-handler.ts`；idle 簇（`armIdleRelease` / `releaseIfIdle` / `isQuiet` / `isDiscardable` / `canIdleRelease` / `hasActiveWork` / `pendingPromptsOnServableSessions` 等）→ `idle-release.ts`。spawn / kill / session 操作留主体。**协调项**：孤儿进程回收（[backlog/orphan-agent-reaping.md](./backlog/orphan-agent-reaping.md)）若先落地，spawn / kill 簇以落地后的形态为准。风险：约束 10 / 11 / 12 / 13 的语义（身份守卫、取消定稿、审批就地收场）。
- **`tests/mock-agent.mjs`**：入口与连接装配、`session/new` / `close` / `load` / `fork` / `setMode` / `setConfigOption` 处理器留主体；env 开关块与 `mockConfigOptions` → `tests/mock-agent/env.mjs`；`session/prompt` 的 worker / drain / background 场景模拟 → `tests/mock-agent/scenarios.mjs`；fs / permission 处理器 → `tests/mock-agent/handlers.mjs`。harness 的 `MOCK` 入口路径不变；`.mjs` 相对导入同样带后缀。

## 9. P6：UI 面（顺带拆，不急）

- **`acp-ui.tsx`**：手拷贝纯函数（`splitAcpModelId` / `buildAcpModelId` / `isAbsolutePathLike` / `tokenizeCommandLine` / `splitCommandLine` / `quoteCommandToken` / `formatCommandLine`）→ `hand-copy.ts`（等价测试保持绿，约束 24）；preset 判定（`rowAgentPreset` / `stagedSessionOf` / `stagedIsAcpMode` / `acpModeFromPresetEvent`）→ `preset.ts`；菜单状态与 `AcpMenu` / `placeMenu` → `menu.tsx`；`AcpChip` / `AcpShatterParts` → `chip.tsx`；设置 / 子代理详情对话框状态 → `dialogs.ts`；`STYLE` / `ensureAcpStyle` → `styles.ts`。
- **`index.tsx`**：入口 `apply` 保留；槽位注册按域分组迁移（settings / shell.overlay / input.dock / assistant-actions 各为一组），座位 claim 编排（`syncAcpMode` 与 `createModelSeatClaim` 接线）单独成模块。**风险**：`slots/changed` 同步重入与 claim 装撤时序的注释语义逐字保留（约束 18 / 20）。
- **`session-controls.tsx`**：纯函数（`agentBaseChip` / `describeRoute` / `menuFor` / `advancedOptions` / `agentTag*` / `lockedAgentOf` 等）→ `controls-model.ts`；组件（`AcpComposerAgentTag` / `AcpSessionControls` / `AcpSessionMenu`）留主体或按组件再分。
- **`tests/acp-view.spec.ts`**：按被测符号的新归属迁移——组件 / 模块专属用例就近（测试约定），浏览器共享纯逻辑留 `acp-view.spec.ts`；describe 标题与用例数不变。

## 10. 通用验收（每个子步）

1. `npm run prepack` 全绿（行数门禁 + typecheck + 全量测试 + build）；用例总数与标题不变。
2. 桶导出面与开工盘点逐一核对，无增减；`lib/` 产物无循环 `require` / 反向导入桶。
3. 基线：被拆文件 ≤1000 删条目，否则锁定值收紧到实测；无新增条目。
4. 独立子代理审核 PASS（tsc + 测试 + 构建 + 逐符号比对 HEAD）。
5. `AGENTS/` 对应文档的符号归属同提交更新；本文件状态快照随子步更新。

## 11. 新会话启动步骤

1. 读 [AGENTS.md](../../AGENTS.md) 与本文 §1–§2；按当前阶段补读对应 `AGENTS/` 细节文档（P1/P2 → protocol.md / state.md，P3/P4 → ui.md / ui-panel.md / state.md，P5 → protocol.md / permissions.md，P6 → ui.md）。
2. `git log -1 --oneline`、`git status --short` 确认工作树干净；从 HEAD 重新盘点当前阶段的符号清单与行数（本文不锁行数）。
3. 未做 P0 先做 P0；然后按 P1 → P6 顺序，每个子步：实现 → prepack → 独立子代理审核 → 提交 → 更新本文件与 [docs/todo.md](../todo.md)。
4. 触发停止条件就回退该子步、把障碍写回本文件，不强行拆。