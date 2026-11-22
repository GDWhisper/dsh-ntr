# 四轴委派定制：四项登记后续

**日期**：2026-11-22　**状态**：未决策（四项各自）。**适用范围**：`acp_delegate` 四轴定制（agent/模型/思考等级/模式，提交 `1fe1998` 落地）的登记债。同批两项小修已落地、不在本文：客户端 agent id 手拷贝收敛（`6596cd2`）、diagnostic 留痕预算（`cfb0376`）。

**一句话**：四轴定制交付时审核登记了四项「现在不做、将来要拍板」的后续——载体在宿主 UI 可见（D）、两个服务文件逼近千行上限（E）、选择写入相无超时（F）、三篇细节文档超 200 行（G）。本文记下每项的现状符号、已知障碍、候选路线与验收口径，供之后决定做不做、做哪条。

> 本文只记设计与证据，**没有任何一行代码按此改动过**。现行代码、[AGENTS.md](../../../AGENTS.md) 约束 40 与 [AGENTS/architecture.md](../../../AGENTS/architecture.md) §5 / [AGENTS/protocol.md](../../../AGENTS/protocol.md) §1 才是权威；冲突时以它们为准。

---

## 1. D — label 载体在宿主自有 UI 可见

**报告**：宿主目录行 / 结算通知渲染原始 label，含选择载体 `⟦m=…&e=…&o=…⟧`；插件只在自绘面板剥显（`displayDelegateLabel`），宿主面用户看到的是带编码的标题。

**现状**：`src/impl/delegate-label.ts` · `delegateLabel` / `displayDelegateLabel`（载体文法与剥显）；`src/client/subagent-panel.tsx` 手拷贝剥显（等价测试钉在 `tests/panel/subagent-defaults.spec.ts`）；宿主渲染在 `@deepseek-ai/dsh-subagent` 的 external 行（display-only，插件不可控）。已登记在 architecture.md §5「载体可见是设计固有代价」。

**障碍**：`ResolvedSubagentStartRequest` 无 display / displayName 字段，label 即显示名——插件侧无法单独修，改编码只会换一种丑法。

**候选路线**：
- A（治本）：向宿主提需求 / 等宿主提供 label 与 display 双字段接缝；届时插件只改 `delegateLabel` 调用点（spec 传 display，载体留在 label），剥显手拷贝可退役。
- B（缓解）：载体缩短 / 可读化——不解决可见性，只降低噪声，不建议单独做。
- C：接受现状（已登记，零成本）。

**验收（若 A）**：宿主目录行显示干净摘要；载体往返 / 注入 / 畸形等价测试原样绿；`npm run prepack` 全绿。

**状态**：未决策（外部依赖，触发条件 = 宿主提供 display 接缝）。

---

## 2. E — delegate-service / settings-service 簇拆分

**报告**：`src/bridge/delegate-service.ts`（829 行）与 `src/bridge/settings-service.ts`（879 行）逼近 1000 行硬上限，下次增补大概率触顶。

**现状**：delegate-service 含工具定义 + `resolve` + `begin`/`run` + 结算 + 四轴写入管线；settings-service 含审批时限 / 空闲释放 / 技能 / 委派等多设置簇。两者均**未**被基线锁定（<1000），门禁当前通过。

**障碍**：现在拆是纯搅动（无功能驱动）；拆法应由下次增补的簇形状定。先例：`tests/bridge/delegate-choice-writes.spec.ts` 因棘轮从 `delegate.spec.ts` 拆出；方法论沿用 [docs/plan/file-size-split.md](../file-size-split.md)（纯函数先行、leaf 服务、Host 回调上限、停止条件）。

**候选路线**：触顶时按簇拆——delegate-service 的工具定义 / 选择写入管线 / 结算各自可独立成文件；settings-service 按设置域拆（委派簇已含四键逻辑，可整体迁出）。

**触发条件**：任一文件的新增将使其 >1000 行，或出现天然独立的新簇。

**验收**：`npm run check:size` 过；导出面不变（桶再导出）；`npm run prepack` 全绿；不新增基线条目。

**状态**：未决策（触发式，与巨型文件拆分第二轮同方法论）。

---

## 3. F — 选择写入相的超时

**报告**：run 的选择写入相（≤3 次 RPC：setMode / setConfigOption）没有静默窗覆盖；写入挂死只受 native 24h 绝对兜底 / legacy 宿主工具预算 / 用户 abort 约束。

**现状**：`src/bridge/delegate-service.ts` · `run`（写入块在 startSession 之后、prompt 之前）；静默窗 `touchSilence` 在 prompt 相才武装。与 `/acp` `runCommand` 无超时语义一致——这是交付时的**刻意选择**，已登记在 protocol.md §1「刻意不加第二窗」。

**障碍**：改它 = 超出已定案设计的行为变更，需要一个小共识（不是纯实现）。

**候选路线**：
- A：写入包 `withStartupTimeout`（60s，与 initialize / session/new / session/load 同档）——挂死写入 → prompt-error 结算，会话关闭。
- B：维持现状（与 /acp 一致，24h 兜底）。
- C：独立写入相预算键（部署可调）——最灵活，多一个配置面。

**验收（若 A）**：fake-host 挂死写入用例在 60s 内结算 prompt-error；既有写入序（mode→model→effort）与反哺用例原样绿；protocol.md §1 边界句同提交改写。

**状态**：未决策（需共识：A / B / C 选一条）。

---

## 4. G — 三篇超 200 行细节文档的拆分与索引预算

**报告**：`AGENTS/protocol.md`（261 行）/ `AGENTS/state.md`（216 行）/ `AGENTS/architecture.md`（215 行）超文档纪律 #4 的单篇 200 行报告阈值；AGENTS.md 索引 11 条，距 12 条上限只剩 1 格——三篇都拆必然超预算。

**现状**：阈值是**收尾报告触发器**，不是硬门禁（`check:size` 不查文档）；三篇均为存量已超，四轴定制各 +0~1 行。索引现状：ui.md 与 conversation-dock.md 已共享一条。

**障碍**：拆分新增索引条目 → 超 12 条上限；必须先规划索引合并（如把 paths / retired / release 等小篇归并索引行，或按域重组）。

**候选路线**：
- A：protocol.md §6 的 CodeBuddy / agy worker 细节迁往 subagent-adapters.md 或新篇，索引合并腾格后再拆 state / architecture。
- B：接受现状（阈值只要求报告，已履行；零成本）。

**验收（若 A）**：单篇 ≤200 行；索引 ≤12 条；无孤儿文档 / 失效链接；AGENTS.md 150 行上限不动。

**状态**：未决策（文档治理专项，低紧迫）。

---

## 5. 落地后要同步的文档

| 项 | 文档 |
|---|---|
| D | architecture.md §5 载体段（删「固有代价」句，写实际接缝）；ui.md §3.2（剥显手拷贝退役时） |
| E | file-size-split.md 进度；AGENTS.md 索引「何时维护」列若新增源文件 |
| F | protocol.md §1 写入相边界句；architecture.md §5 四轴条对应句 |
| G | AGENTS.md 索引表 + 文档纪律 #4 收尾报告 |

每项落地时按 backlog README 规则：状态改最终结论，同步 docs/todo.md（若转入）与 docs/README.md。

## 6. 决策记录（待填）

| 日期 | 项 | 结论 | 依据 |
|---|---|---|---|
| — | D | 未决策 | 等宿主 display 接缝 |
| — | E | 未决策 | 触顶时按簇拆 |
| — | F | 未决策 | 需 A/B/C 共识 |
| — | G | 未决策 | 索引预算先行 |