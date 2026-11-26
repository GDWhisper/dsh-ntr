# Antigravity ACP 协议适配评估与现状对照

**状态**：已转入实施（主执行方案见 [antigravity-acp-parity-impl.md](../antigravity-acp-parity-impl.md)；§1.1 已通过 [agy-question-asks.md](../agy-question-asks.md) 落地，§1.2–§1.6 按首轮不回滚挂 `QuotaBanner`、`isAntigravityAgent` 默认关闭 `writeTextFile` + 显式覆盖推进）
**本仓现状**：通用 ACP 客户端 + 7 个 agy 专属补丁文件（`src/bridge/agy-*.ts`）

**一句话**：Antigravity ACP 在部分行为上不上报 wire 细节或复用现有方法承载额外语义；可落地的六项里，一项（`interaction_` 提问区分）已独立落地待抓帧，其余五项（`/compact` 能力与误报、`agy.security.warning`、`fs.writeTextFile` 开关、只读 session DB、结构化配额与失败提示）已转入主实施文档落地。

> 本文保留协议能力评估与边界记录，不写实现、不含验收代码。引用代码位置一律「文件 + 符号名」，不写行号。

---

## 1. 六项能力评估（按 ROI）

| # | 条目 | 性质 | 依赖 | 状态 / 主要未知 |
|---|---|---|---|---|
| 1 | `interaction_` 提问型 permission 不参与 auto 代答 | 行为缺陷 | 无 | **已实施（待抓帧）**，见 [agy-question-asks.md](../agy-question-asks.md) |
| 2 | 读 agy session DB（`conversations/<id>.db`） | 新证据源 | 无 | **已实施（待真机对齐）**：宿主运行时 `node:sqlite` 加载、锁与 schema 漂移 fail-open |
| 3 | 结构化失败与配额提示 | 能力增强 | 依赖 2 | **已实施（待真机验证）**：首轮配额拒绝保留会话挂 `QuotaBanner` |
| 4 | `fs.writeTextFile` 声明复核（diff vs 整文件） | 传输语义 | 无 | **已实施（待真机验证）**：默认对 `agy` 关闭，设置页「高级」可显式覆盖 |
| 5 | `agy.security.warning` 透传 | 呈现补齐 | 无 | **已实施（待真机验证）**：`_meta` 键形态与实际触发范围待抓帧 |
| 6 | `session.compaction` 能力与 `/compact` 收口误报 | 能力补齐 / 误报修复 | 无 | **已实施（待真机验证）**：声明 `session.compaction: {}` 后 agy 下发帧形状待抓帧 |

### 1.1 `interaction_` 提问型 permission 不参与 auto 代答（已实施，待抓帧）

- **问题**：agy 的原生固定选择题走 `session/request_permission`，与工具审批共用同一方法。若一律当审批处理，`auto` 档或到期超时会按 option `kind` 优先级代答。
- **本仓落地**：通过 `src/impl/permission.ts` · `AGY_QUESTION_TOOL_CALL_PREFIX` / `permissionAskKind` / `pickQuestionDefault` 与 `src/bridge/question-ask.ts` · `questionAskKindOf` 归类为 `askKind: 'question'`，使用 `elicitationTimeoutMs` 窗口与独立到期轴 `questionTimeoutMode: 'cancel' | 'first'`。
- **剩余待验证**：抓一个真实已认证 agy 会话，确认 `toolCallId` 前缀、选项 `kind` 分布与取消响应行为。

### 1.2 读 agy session DB 作为结构化证据源

- **实据（本机实测，2026-11-25）**：
  - 同 session id 并存 `brain/<id>/.system_generated/logs/transcript_full.jsonl` 与 `conversations/<id>.db`。
  - 模型开口前即失败的上游 429 错误在 JSONL 里只有 `USER_INPUT`，DB `steps` 写入 `step_type=17`（`ERROR_MESSAGE`），`error_details` 为 NULL，错误文本内嵌于 `step_payload` protobuf 字节（含 `RESOURCE_EXHAUSTED (code 429)` / `Resets in ...`）；24 个采样 DB 中 `parent_references` 全为空。
- **边界**：通过 `src/bridge/agy-session-db.ts` 动态按需加载 `node:sqlite`，严格 `{ readOnly: true }` + `SESSION_ID_PATTERN` + `lstatSync` 非 symlink 检查 + 100ms `busy_timeout` + `MAX_ERROR_PAYLOAD_BYTES` 截断 + `finally` 关闭，全程 fail-open。

### 1.3 结构化失败与配额提示（依赖 1.2）

- **问题**：上游 429/验证/API 失败被折叠为正常 `end_turn`（甚至零输出）时，原提示只有通用 `zeroOutputLine`，缺少错误原因与重置时间。
- **边界**：经 `src/bridge/agy-failure.ts` 同时覆盖聊天面与 `/acp` RPC 面；有可见回答的正常轮次零额外 DB 读取；首轮遇到 `errorKind: 'quota'` 时保留会话不回滚 `provisionalLock` 以展示 `QuotaBanner`。

### 1.4 `fs.writeTextFile` 声明复核

- **问题**：向 agy 声明 `fs.writeTextFile: true` 会促使其改用客户端整文件覆写接口，导致工具编辑失去内置 unified diff。
- **边界**：由 `src/protocol/agent-def.ts` · `effectiveWriteTextFileEnabled` 裁决：`isAntigravityCommand` 默认 `false`（且不注册写文件 handler），其余通用 agent 默认 `true`，同时支持经 `AcpAgentDef.writeTextFileEnabled` 与设置页「高级」显式覆盖。

### 1.5 `agy.security.warning` 透传

- **问题**：长期授权选项上的 `_meta["agy.security.warning"]` 原先在构建 `PermissionOptionView` 时被忽略。
- **边界**：通过 `src/impl/permission.ts` · `permissionOptionWarning` 规范化提取（兼容字符串与 `{ title?, message? }`，限长 512 字符），在对话权限卡与设置页镜像同步渲染。

### 1.6 `session.compaction` 能力与 `/compact` 零输出收口误报

- **问题**：客户端未声明 `ClientSessionCapabilities.compaction` 时 agent 不发送 `compaction_update` / `compaction_summary_chunk`，压缩回合仅推送 `BOOKKEEPING_UPDATES` 或空内容并返回 `end_turn`，触发 `TurnStreamController.closeTurn` 的 `zeroOutputLine` 上游失败误报。
- **边界**：握手广告 `session.compaction: {}`，在 `TurnStreamController` 与 `blocks.ts` 消费压缩事件，并对无可见输出且正常结束的 `/compact` 控制命令输出压缩完成提示替代上游失败告警。

---

## 2. 不做的边界说明

1. **不做托管安装 / 自动下载**：不替用户安装、缓存或管理 `agy` 二进制版本（遵循约束 37）。
2. **不做客户端身份伪装**：固定声明 `clientInfo.name = 'dsh-ntr'`。
3. **不以私有 DB protobuf 替代 wire 主路径**：只作只读失败兜底，保持字段无契约假设与 fail-open。

---

## 3. 本仓相关符号索引

- `src/bridge/agy-transcript.ts` — `isAntigravityAgent` / `agyStoreRoot` / `agyTranscriptPaths` / `AgyTranscriptTail` / `SESSION_ID_PATTERN`
- `src/bridge/agy-session-db.ts` — `readAgyDbLastStepIndex` / `readAgyDbErrorAfter` / `classifyAgyErrorText`
- `src/bridge/agy-failure.ts` — `resolveAgyStoreContext` / `sampleAgyDbBaseline` / `resolveAgyTurnFailureFromResponse` / `resolveAgyTurnFailureFromRejection`
- `src/bridge/agy-late-output.ts` / `src/bridge/agy-echo-guard.ts` / `src/bridge/agy-subagents.ts` / `src/bridge/agy-subagent-poll.ts` / `src/bridge/agy-subagent-detail.ts`
- `src/impl/compaction.ts` — `isCompactCommand` / `formatCompactionNotification` / `compactCompletionLine`
- `src/impl/permission.ts` — `permissionOptionWarning` / `permissionAskKind` / `pickQuestionDefault` / `permissionRequestFrame`
- `src/protocol/agent-def.ts` — `isAntigravityCommand` / `effectiveWriteTextFileEnabled`
