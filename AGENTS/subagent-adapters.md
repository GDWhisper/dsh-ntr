# 子代理适配：per-agent 事实源与共享接缝

**何时读**：给新 agent 接子代理事实源时；或要判断 per-agent 专属代码还能进哪些共享文件。
**状态**：接缝登记 + 抽取触发器。N=2（CodeBuddy / agy）时**不建注册表**（YAGNI）；本文是第三家接入时的抽缝依据。

## 1. 两种事实源，一份面板契约

面板契约共享：`SubagentRecord` 六态（`childId = acp:<toolCallId>`）、catalog external 行、明细条目、`agents.json` 的 `subagents` 键。事实源按 agent 分：

- **CodeBuddy**：wire `_meta`（`codebuddy.ai/toolName` / `isBackground` / `parentToolCallId`）驱动识别 / hold / 收口——**回合耦合**（约束 23 的 dispatches / ambient 家族就在 `turn-stream.ts`）。
- **agy**：wire 无任何生命周期帧，私有 brain transcript 是事实源——**纯观察**（detached，永不 hold 回合）。

两者不对称：统一接口**不得**把 CodeBuddy 的回合语义拖进观察型适配器。行为契约见 [protocol.md §6.3 / §6.4](./protocol.md)、落盘见 [state.md §1](./state.md)、明细 UI 见 [ui.md §4.3](./ui.md)。

## 2. 现行纪律（保持）

- **专属逻辑进专属模块**：`agy-subagents.ts` · `AgySubagentTracker`、`agy-subagent-poll.ts` · `AgySubagentPollService`、`agy-subagent-detail.ts` · `readAgyChildDetail`、`subagent-detail-agy.tsx` · `AgyStepStream`；agy 读取原语集中在 `agy-transcript.ts`。
- **闭包 / deps 注入组合**：适配器模块绝不反向 import manager；共享代码只经具名门到达适配器。
- **三层门**：`manager.ts` · `isAgentFor`（回落 `isAntigravityAgent`）路由帧；`LiveSession.agyDispatches` 懒创建、非 agy 会话无此 map；浏览器明细门禁认 `source` 标记。CodeBuddy 路径在 `codebuddyMetaOf` 为 undefined 时逐字不变。

## 3. 接缝登记（第三家会再加一条 inline 代码的位置）

| # | 共享文件 · 符号 | 现行 per-agent 形状 | 收敛方向 |
|---|---|---|---|
| 1 | `live-session.ts` · `LiveSession.agyDispatches?` | 每家 agent 一个可选 map | 单一 `subagentFacts` 状态，按适配器键控 |
| 2 | `turn-stream.ts` · `hasPendingBackgroundWork` | 每家 map 一段 inline 分支（判定谓词已共享：`dispatchWithinWindows` / `silenceWindowsOf`） | 注册表遍历；谓词保持共享 |
| 3 | `subagent-service.ts` · `trackAgyDispatch` / `subagentsDetail`；`manager.ts` · `isAgentFor` 路由 | 每家一个方法 + 一段分支 + 一个门 | 适配器接口：recognize / detail |
| 4 | `shape.ts` · `subagentDispatchLabel` / `agyDispatchInputOf` | 每家 label / 身份分支 | 适配器 label / identity |
| 5 | 浏览器：`store.ts` · `loadSubagentDetail` 门禁（`'agy-transcript'` 字面量）、`protocol-subagent.ts` · `SubagentDetailEntry.source` union、`subagent-detail.tsx` · `isAgy` 分流 | 每家的字面量 + union 成员 + 分支 | 通用「明细可刷新」能力位；步骤视图按适配器分 |

记录往返接缝（`dispatch-shape.ts` · `dispatchRecord`、`src/subagent-records.ts` · `normalizeSubagentRecord`）携带 per-agent 可选字段（`childConversationId`）：新字段必须可选、不搞迁移（约束 28）。拆除终态走共享的 `terminalizeSessionDispatches`（两个 map 批量），新适配器必须被它覆盖——绝不永久 running。

## 4. 抽取触发器

**第三家 agent 家族接入时**，抽「子代理事实源」接口，五个动词：recognize（wire→记录）、observe（生命周期→状态 / 活动）、activeWork（空闲释放贡献）、detail（按需读）、label（身份）。共享文件只留注册表遍历，接缝 1–5 按上表收敛。

**N=2 不抽**：过早抽象，且接口被迫横跨 CodeBuddy 的回合耦合语义（约束 23），风险换不来现收益。等待的代价是第三家付一次小重构——专属模块已隔离、接缝少且具名，成本低。

相关：[docs/plan/implicit-state-machines.md](../docs/plan/implicit-state-machines.md) 系统治理「每加一家多一个可选字段」的隐式状态积累（接缝 1 可并轨）；[docs/plan/antigravity-subagent-panel.md](../docs/plan/antigravity-subagent-panel.md) 是 agy 事实源的设计与证据。