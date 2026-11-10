# 源码拆分后续计划（P9.8 / P10）

本文件承接 `src/bridge.ts` 巨型文件拆分任务的剩余部分。新会话先读 [AGENTS.md](../../AGENTS.md)、[AGENTS/architecture.md](../../AGENTS/architecture.md)、[AGENTS/protocol.md](../../AGENTS/protocol.md)，再读本文件。

## 1. 状态快照

基线提交：`6d5c10d`（`refactor(acp): extract agents.json persistence from BridgeManager`）。工作树应为干净。

- `src/bridge.ts` 已是 24 行纯桶文件，公共导出面 **48 个名称**，不得增减。
- 宿主实现全部在 `src/bridge/` 下。当前规模（行数只作体量参考，不作代码位置引用）：

| 行数 | 文件 | 职责 |
|---|---|---|
| 2600 | `turn-stream.ts` | `TurnStreamController`、`LiveSession`、段 / ambient / 后台持有 |
| 2471 | `manager.ts` | 剩余门面：桥注册表、看门狗、RPC 面、会话启动 / resume |
| 2130 | `agent-bridge.ts` | `AgentBridge`：单 agent 进程与会话 |
| 841 | `chat-choice-service.ts` | 会话选择、路由、ACP mode 缓存 |
| 663 | `subagent-service.ts` | 子代理记录、后台报告 |
| 626 | `catalog-service.ts` | 模型目录、探测、fork 能力位、命令缓存 |
| 561 | `settings-service.ts` | 设置、审批期限、空闲释放、preset / 更新 |
| 471 | `agent-admin-service.ts` | agent 保存 / 删除 / 测试、保存门禁 |
| 468 | `session-registry-service.ts` | DSH 会话注册表、绑定、锁、transcript 投影 |
| 356 | `persistence-service.ts` | `agents.json` 读取、组装、严格 / 非严格写盘 |
| 其余 | `shape/process/state-paths/registries/types/identity/...` | 纯函数与常量 |

- 测试：25 个文件、1234 个用例；`tests/bridge.spec.ts` 约 11.5k 行、34 个顶层 `describe`。
- 已完成阶段与提交：

| 阶段 | 内容 | 提交 |
|---|---|---|
| P1–P8 | `bridge.ts` 拆成 14 个模块，桶文件保留 48 个导出 | `8a01192` |
| P9.0 | 派发纯函数 → `dispatch-shape.ts` | `554b0e5` |
| P9.1 | 模型目录 → `catalog-service.ts` | `9f8ed63` |
| P9.2 | 子代理 / 后台报告 → `subagent-service.ts`；`describeError` → `errors.ts` | `b7612e6` |
| P9.3 | 设置与调优 → `settings-service.ts` | `3f11621` |
| P9.4 | 选择与路由 → `chat-choice-service.ts` | `c6831e6` |
| P9.5 | agent 管理与保存门禁 → `agent-admin-service.ts` | `3e0cf18` |
| P9.6 | 会话注册表 → `session-registry-service.ts` | `dcd489c` |
| P9.7 | `agents.json` 持久化 → `persistence-service.ts` | `6d5c10d` |

## 2. 不变约束

1. 公共导出面固定 48 个名称。任何阶段先核对 `src/bridge.ts` 的再导出集合。
2. 只改 `src/`、`tests/` 与 `AGENTS/`；禁止改 `lib/`。
3. 相对导入必须带 `.ts` / `.tsx` 后缀（[AGENTS.md](../../AGENTS.md) 约束 6）。
4. 单向依赖：服务不得运行时导入 `../bridge.ts` 或 `./manager.ts`；只允许 `import type` 且必须注释说明。
5. 每个阶段单独提交，提交前 `npm run prepack`；提交信息用 `refactor(acp):`。
6. 动了 `AGENTS/` 描述的代码，同提交更新对应文档（符号归属路径）。
7. 每个阶段完成后，派独立上下文的子代理审核；审核必须跑 tsc、全量测试与构建，并逐方法比对 HEAD。

## 3. P9.8：拆 `manager.ts` 剩余门面

`manager.ts` 仍含四个簇。建议按下面顺序拆，每个子步一次提交、一次审核。

### P9.8a 桥注册表与生命周期

- 新文件：`src/bridge/bridge-registry-service.ts`。
- 字段：`bridges`、`bridgeScopes`、`stoppingAgents`、`noticedBridgeFailures`。
- 方法：`bridgeFor`、`bridgesOf`、`bridge`、`sessionIdsOf`、`keyOfBridge`、`bridgeOwning`、`bridgeForSession`、`pruneBridge`、`find`、`tryLocate`、`locateOrResume`、`connectionLost`、`aggregateView`、`publishAgentStatus`、`agentViews`、`noticeBridgeFailure`、`stopAgent`、`shutdownAll`。
- 保留在 manager：`makeBridge`（它把大量回调接进 `AgentBridge`，先不动）。
- Host 预计：`makeBridge`、`hub`、`currentTuning`、`persistAgents`、`registry`（会话）、`subagents`。
- 风险：`bridgeFor` 的 `agent_stopping` 拒绝、`stoppingAgents` 计数、`pruneBridge` 的 `isDiscardable` 判定必须逐字保留。

### P9.8b turn 看门狗与 turnStream 注册

- 新文件：`src/bridge/turn-watchdog-service.ts`。
- 字段：`turnStreams`、`stallTimer`。
- 方法：`turnStreamFor`、`rememberTurnStream`、`forgetTurnStream`、`disposeTurnStreamsOf`、`armStallTimer`、`reapStalledTurns`、`pendingPermissionViews`、`hasActiveTurns`、`activeTurnViews`、`noteSessionBurst`、`ambientTuning`、`backgroundTuning`。
- Host 预计：`bridges()`、`prepareStalledSession`、`hub`、`currentTuning`。
- 风险：`reapStalledTurns` 的世代守卫、静默阈值（`turnStallMs` / `turnStallToolMs`）与「只收口、不杀进程」语义。

### P9.8c RPC 面

- 新文件：`src/bridge/bridge-rpc-service.ts`。
- 方法：`startSession`、`prompt`、`cancel`、`closeSession`、`setMode`、`setConfigOption`、`respondPermission`、`transcript`、`sessions`。
- Host：桥注册表、`chat-choice-service`、会话启动 / resume 入口。
- 风险：`prompt` 的锁、`model_unavailable` 拦截、`turn_in_flight` 与插话 `reclaimChatPrompt` 的调用顺序。

### P9.8d 会话启动与 resume（最后做）

- 新文件（可选）：`src/bridge/session-boot-service.ts`。
- 方法：`getOrCreateDshSession`、`resumeChatSession`、`prepareStalledSession`、`reclaimChatPrompt`、`waitForSettleGate`。
- 这一簇与 `AgentBridge`、`TurnStreamController`、选择服务交叉最深。若 Host 回调超过 10 个，或出现运行时循环依赖，**停止并写回本文件**，不要强行拆。

### 停止条件

- Host 回调超过 10 个。
- 需要服务运行时导入 `manager.ts`。
- 逐方法比对发现无法保持调用顺序或失败语义。

触发任一条就回退该子步，把障碍写进本文件，再决定是否继续。

### 验收

- `manager.ts` 降到 1500 行左右，或剩余仅为 `makeBridge` 与少量门面。
- 公共导出面 48 个名称不变。
- `npm run prepack` 全绿（25 个测试文件、1234 个用例）。
- `lib/bridge/*.js` 不出现 `from '../bridge.js'` 或 `require('../bridge.js')`。

## 4. P10：拆 `tests/bridge.spec.ts`

### T1 共享 harness

- 新建 `tests/bridge/harness.ts`。
- 迁入：`MOCK`、`def`、`EventHub` / `manager` 工厂、`events`、`waitFor`、`settleTranscript`、`until`、`isAlive`、`killTestProcessTree`、`hostLoopTurn`、`normPath`、`unexpectedSubagentFrames`。
- 当前顶层 `manager` 是跨 describe 共享的；拆分后每个测试文件用工厂创建独立实例，并在文件内 `afterAll(shutdownAll)`。
- 测试内省现走 `internals.registry.*`、`gm.catalog.*` 等内部路径；harness 必须保留这些入口的类型形状。

### T2 按主题拆文件

保持 `describe` 标题与用例数不变，逐块迁移：

| 建议文件 | 覆盖的顶层 describe |
|---|---|
| `tests/bridge/permissions.spec.ts` | 全部 permission / ledger / deadline describe |
| `tests/bridge/lifecycle.spec.ts` | `idle release`、`prompt slot`、`a silent turn...`、`observed chat transcripts` |
| `tests/bridge/sessions.spec.ts` | `chat session workspace`、`conversation ↔ agent binding`、`agent lock...`、`pre-chat pick persistence`、`request-path binding`、`conversation fork adoption` |
| `tests/bridge/background.spec.ts` | `a prompt steered into a background drain`、`a turn that dispatched a detached worker`、`a detached worker settles...`、`external subagent lifecycle records`、`the ambient hard ceiling` |
| `tests/bridge/misc.spec.ts` | `agent saves behind the save gate`、`MCP servers on the wire`、`model catalog`、`reliability`、`stale cancel...`、`windows shim launch`、`host shutdown`、`image input...`、`the /acp prompt...`、`A1: codebuddy...` |
| `tests/bridge.spec.ts` | 只留 `ACP bridge over stdio (mock agent)` 首个 describe |

### T3 收尾

- 删除空壳文件与重复 helper。
- 确认用例总数不变（当前 300 个 `bridge.spec` 用例）。
- 全量 `npm run prepack`。

## 5. 已知环境抖动

`tests/skills.spec.ts` 在 Windows 并发负载下会偶发 symlink 计数失败或 5 秒超时。单独重跑该文件应 16/16 通过。不要把这种抖动当成代码失败，也不要因此跳过 typecheck 或 build；在报告里注明「单独重跑通过」即可。

## 6. 新会话启动步骤

1. 读 [AGENTS.md](../../AGENTS.md) 与 [AGENTS/architecture.md](../../AGENTS/architecture.md)、[AGENTS/protocol.md](../../AGENTS/protocol.md)。
2. 读本文件，确认 HEAD 与状态快照一致（`git log -1 --oneline`、`git status --short`）。
3. 从 P9.8a 开始：先让实现子代理分析字段与方法依赖，再决定是否满足注入回调上限。
4. 实现完成后，派独立子代理审核；审核 PASS 后再提交。
5. 每完成一个子步，更新本文件的状态快照与 `docs/todo.md` 的剩余项。
