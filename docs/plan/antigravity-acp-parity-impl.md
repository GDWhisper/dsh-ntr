# 方案：Antigravity ACP 适配补齐实施（compaction / 安全警告 / diff 能力 / session DB / 配额失败）

**状态**：**已实施（`npm run verify` 全绿，待已认证 `agy` 真机抓帧验收）**（从 [backlog/antigravity-acp-parity.md](./backlog/antigravity-acp-parity.md) 转正；已拍板全部设计边界）
**来源对照**：[backlog/antigravity-acp-parity.md](./backlog/antigravity-acp-parity.md)（其中 §1.1 `interaction_` 固定选择题已通过 [agy-question-asks.md](./agy-question-asks.md) 落地，本文覆盖其余五项：§1.6、§1.5、§1.4、§1.2、§1.3）
**非侵入红线**：全程不修改 `agy` 原生二进制、store 结构与客户端代码；全部能力增强仅在插件宿主桥接与浏览器呈现层完成，失败 fail-open。

> 写作约定：代码位置一律用「文件 + 符号名」，不写行号。改动须严格遵守 `scripts/file-size-baseline.json` 行数棘轮——`src/bridge/agent-bridge.ts`、`src/bridge/manager.ts`、`src/bridge/turn-stream.ts`、`src/client/store.ts`、`tests/bridge.spec.ts` 等锁定文件不净增超基线，新逻辑与新测试拆进独立小模块与独立测试文件。

---

## 1. 已拍板裁决

1. **纳入范围与顺序**：按低风险、零依赖到有依赖分五个阶段推进：
   - **Stage 1（§1.6）**：`session.compaction` 能力广告、`compaction_update` / `compaction_summary_chunk` 消费与 `/compact` 零输出收口误报修复。
   - **Stage 2（§1.5）**：`option._meta["agy.security.warning"]` 透传到 `PermissionOptionView`，并在对话权限卡与设置页镜像渲染。
   - **Stage 3（§1.4）**：`fs.writeTextFile` 对 `isAntigravityAgent` 默认置 `false`（恢复内置编辑与 unified diff），同时在 `AcpAgentDef.writeTextFileEnabled` 与设置页「高级」提供显式覆盖开关。
   - **Stage 4（§1.2）**：只读 SQLite 证据源 `src/bridge/agy-session-db.ts`（`node:sqlite` + `SESSION_ID_PATTERN` + `lstat` 非 symlink 检查 + 短 `busy_timeout` + fail-open）。
   - **Stage 5（§1.3，依赖 Stage 4）**：基于 `step_type=17` 的结构化失败与配额提示，覆盖聊天面与 `/acp` RPC 面。
2. **首轮配额拒绝 vs `rollbackFirstTurn`**：首轮对话遇到 `errorKind === 'quota'` 且无可见输出时，**保留会话不回滚**（结算 `provisionalLock = false` 但不调用 `rollbackFirstTurn`），使 `QuotaBanner` 能够立即在会话视图挂起并展示配额原因与重置时间。
3. **`fs.writeTextFile` 控制策略**：由纯函数 `effectiveWriteTextFileEnabled(def)` 统一裁决——`def.writeTextFileEnabled !== undefined` 时严格按显式布尔覆盖；未设置时对 `isAntigravityAgent(def)` 返回 `false`，对其余通用 agent 返回 `true`。

---

## 2. 分阶段设计

### Stage 1：Compaction 能力与 `/compact` 零输出修复（§1.6）

1. **握手能力声明**（`src/bridge/agent-bridge.ts` · `AgentBridge.spawnAndConnect`）：
   - `initialize` 的 `clientCapabilities.session` 补充 `compaction: {}`（保留既有 `configOptions: { boolean: {} }`）。
2. **纯函数归并**（新增 `src/impl/compaction.ts`，经 `src/impl.ts` 导出）：
   - `isCompactCommand(promptText)`：识别用户主动发送的 `/compact` 控制命令（按修剪后的首行匹配 `/^\/compact(?:\s|$)/i`，不误伤正常自然语言提问）。
   - `formatCompactionNotification(update, statuses)`：解析 `compaction_update`（`compactionId` / `status` / `summary` / `error`）与 `compaction_summary_chunk`（`compactionId` / `content`），对同 `compactionId + status` 进度帧去重并格式化完成/摘要/失败文本。
   - `compactCompletionLine(agentId, stopReason?)`：当 `/compact` 正常结束且 agent 未下发任何可见更新时输出简洁完成提示。
3. **流控制器**（`src/bridge/turn-stream.ts` · `TurnStreamController`）：
   - 构造参数接入可选 `compactPrompt?: boolean`（由 `src/bridge/manager.ts` · `streamPrompt` 传入 `isCompactCommand(promptText)`）。
   - `foldInto` 显式分支处理 `compaction_update` 与 `compaction_summary_chunk`（走 `emitProse`，点亮 `sawVisibleBlock`，并跳过 `describeUnhandledUpdate` 原始 JSON 倾倒）。
   - `zeroOutputLine` 中：若非 `refusal` 且非 `recentRetiredDrain`，在 `compactPrompt === true` 时改用 `compactCompletionLine` 替代「upstream failures」告警文案。
4. **浏览器 transcript 视图**（`src/client/store/blocks.ts` · `foldUpdate`）：
   - 新增 `case 'compaction_update'` 与 `case 'compaction_summary_chunk'`：按 `compactionId` 就地聚合同一压缩条目的状态、流式摘要 chunk 与最终摘要/失败文本为紧凑 `event` 块。

### Stage 2：`agy.security.warning` 透传（§1.5）

1. **协议扩展**（`src/protocol/events.ts` · `PermissionOptionView`）：新增可选字段 `warning?: string`。
2. **纯提取函数**（`src/impl/permission.ts` · `permissionOptionWarning`）：从 `option._meta['agy.security.warning']` 提取字符串或 `{ title?, message? }`，限长 512 字符并带 `…` 截断标记，在 `AgentBridge.handlePermissionRequest` 中写入并通过 `permissionRequestFrame` 发出（SSE 重放逐字节一致）。
3. **UI 渲染**：`PermissionAskCard`（`src/client/permission-dock.tsx`）与 `PermissionMirrorCard`（`src/client/panel/permission-mirror.tsx`）共用 `PermissionOptionWarnings` 渲染警告，无警告时零 DOM 输出。

### Stage 3：`fs.writeTextFile` 对 `isAntigravityAgent` 默认关闭与显式覆盖（§1.4）

1. **共享纯判定**（`src/protocol/agent-def.ts` · `isAntigravityCommand` / `effectiveWriteTextFileEnabled`，`src/bridge/agy-transcript.ts` · `isAntigravityAgent` 复用）：未显式设置 `writeTextFileEnabled` 时，`agy acp` 默认 `false`，其余 agent 默认 `true`。
2. **配置与校验**：`AcpAgentDef.writeTextFileEnabled`、`AgentSavePayload.writeTextFileEnabled`、`validateAgentDef` 与设置页「高级」三态选择器（`default / enabled / disabled`）明确展示当前默认裁决结果（constraint 33）。
3. **桥接能力**（`src/bridge/agent-bridge.ts` · `spawnAndConnect`）：`initialize` 的 `clientCapabilities.fs.writeTextFile` 传入解析后的布尔值，且仅当为 `true` 时注册 `methods.client.fs.writeTextFile` handler。

### Stage 4：只读 `agy-session-db.ts`（§1.2）

1. **新模块**（`src/bridge/agy-session-db.ts`）：
   - 复用 `SESSION_ID_PATTERN` 校验与 `lstatSync` 非 symlink 检查，定位 `<storeRoot>/conversations/<acpSessionId>.db`。
   - 惰性加载 `node:sqlite`，使用 `{ readOnly: true, timeout: 100 }`（并设置 `PRAGMA busy_timeout = 100`），限定 `substr(..., 1, 16384)`，全部操作在 `finally` 关闭，失败 strict fail-open。
   - 导出 `readAgyDbLastStepIndex`、`readAgyDbErrorAfter` 与纯分类器 `classifyAgyErrorText`（覆盖 `quota` / `validation` / `thinking_signature` / `api_error`）。

### Stage 5：结构化失败与配额提示（§1.3，依赖 Stage 4）

1. **共享仲裁模块**（`src/bridge/agy-failure.ts`）：导出 `resolveAgyStoreContext`、`sampleAgyDbBaseline`、`resolveAgyTurnFailureFromResponse`、`resolveAgyTurnFailureFromRejection`，供 `BridgeManager.streamPrompt` 与 `BridgeRpcService.sendPrompt` 对称调用。
2. **首轮不回滚边界**（`src/bridge/turn-stream.ts` · `TurnStreamController.closeTurn`）：对 `outcome.kind === 'error' && outcome.errorKind === 'quota'` 跳过 `rollbackFirstTurn`，保留聊天会话行并挂出 `QuotaBanner`。
3. **零额外 DB 读约定**：正常产出可见回复的非错误轮次跳过 DB 误差步读取；仅在无输出、拒答或拒绝抛错时读取 `idx > baseline` 的 `step_type = 17` 错误步。

---

## 3. 涉及文件清单

- **新增模块**：`src/impl/compaction.ts`、`src/bridge/agy-session-db.ts`、`src/bridge/agy-failure.ts`
- **新增测试**：`tests/impl/compaction.spec.ts`、`tests/bridge/compaction-turn.spec.ts`、`tests/permission-warning.spec.tsx`、`tests/bridge/agy-write-capability.spec.ts`、`tests/bridge/agy-session-db.spec.ts`、`tests/bridge/agy-failure.spec.ts`
- **最小接线文件**：`src/protocol/{agent-def,events,rpc}.ts`、`src/protocol.ts`、`src/impl/{permission,validate}.ts`、`src/impl.ts`、`src/bridge/{agent-bridge,agy-transcript,bridge-rpc-service,manager,shape,turn-stream}.ts`、`src/client/{acp-ui,permission-dock}.tsx`、`src/client/panel/{agent-details,form,permission-mirror}.*`、`src/client/store/{blocks,permission}.ts`

---

## 4. 验收清单

1. **全量验证**：`npm run verify`（行数门禁 + typecheck + vitest + build）全绿。
2. **真机补充验收（已有已认证 `agy` 环境时）**：用同一会话顺次验证真实 `/compact` 线帧、`interaction_` 提问载荷、关闭 `writeTextFile` 后的内置 diff、`_meta["agy.security.warning"]` 与触发 429 配额提示。
