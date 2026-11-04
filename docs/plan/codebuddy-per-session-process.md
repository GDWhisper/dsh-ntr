# 方案 A1：CodeBuddy 每 DSH 会话一个 ACP 子进程

**状态**：**已实现，尚未提交；待真机验证与独立复核结论**（代码与测试已落盘，文档以此为准）。**适用范围**：只对 agent id `codebuddy` 生效；其他 agent 保持「每 agent 一进程」。
**一句话**：把 CodeBuddy 的进程粒度从 agent 下沉到 DSH 会话：每条 DSH 会话独占一个 `AgentBridge`（子进程 + stdio 连接），进程内只开一个 ACP 会话；用复合键与 scope 路由替换 `bridges.get(agentId)` 的单例假设。

> 写作约定：代码位置只用「文件 + 符号名」，不写行号。本文不是 `AGENTS/` 文档，但索引登记进 [docs/README.md](../README.md)。根 [AGENTS.md](../../AGENTS.md) 当前 150 行，已在硬上限；实施时只能改写既有约束，不能净增行。

---

## 1. 结论

1. **推荐结构**：保留单一 `BridgeManager.bridges` Map，把键从 `agentId` 改成「agentId + `BridgeScope`」的复合键；新增 `BridgeScope` 与 `bridgeScopes` 注册表。不新增二级 Map。
2. **推荐 fork 处理**：对 `codebuddy` **硬禁用 fork 能力位**（F2）。当前 CodeBuddy 的 `initialize` 不声明 `sessionCapabilities`，分支按钮本来就是禁用态；硬禁用是为将来它声明 fork 时兜底。
3. **不改的东西**：`agents.json` / `model-catalog.json` 结构、`chatSessions` 持久化字段、`AgentView` 形状、`/acp` 信封、权限管线、`AcpSaveGate`、模型目录与命令缓存、其他 agent 的拓扑。

---

## 2. 现状与证据

### 2.1 单例假设在哪

- `BridgeManager.bridges` 是 `Map<agentId, AgentBridge>`；`BridgeManager.bridge(agentId)` 对每个 agent 返回同一个实例。
- `AgentBridge` 自己用 `sessions: Map<sessionId, LiveSession>` 记录同一连接上的多个会话；所以插件侧本来支持多会话，缺的是**连接级隔离**。
- 四个建会话点都落在同一个 bridge：`AgentBridge.createSession`、`AgentBridge.resumeSession`、`AgentBridge.probeConfigOptions`、`AgentBridge.forkSession`。
- `AgentBridge.runPrompt` 已按 `session.acpSessionId` 发 `session/prompt`，协议层没有错；错在 CodeBuddy 连接内的 `currentSession` 路由。

### 2.2 CodeBuddy 的连接级单会话

上游实测记录见 [codebuddy-acp-multi-session-prompt-cross-talk.md](../upstream/codebuddy-acp-multi-session-prompt-cross-talk.md)：

- 一条 stdio 连接只保留一个 `currentSession`；`session/new` 或 `session/load` 会替换它，并停掉旧会话的 Bridge 与后台任务。
- `session/prompt` 到达后落到 `currentSession`，不是按 `sessionId` 查表；两个 DSH 会话并发时会拿到对方的回答。
- 其余 ACP 实现（opencode、claude-code、gemini-cli、SDK 示例）都按 `sessionId` 查表；CodeBuddy 是例外。
- CodeBuddy 进程把工作区在进程启动时固定；`session/new` 的 cwd 到达太晚。每会话一进程顺带解决这个问题。
- CodeBuddy 的 `session/fork` 在同一连接上创建第二个会话；一进程一会话无法隔离 fork。
- 外部已验证：`~/.codebuddy` 没有全局单实例锁；`sessions\<pid>.json`、`tasks\<会话UUID>\`、`traces\<pid>\`、`projects\<工作区>\<sessionId>.jsonl`、`file-history\<会话UUID>\`、`shell-snapshots\<时间戳+随机串>` 都按 PID 或会话隔离；CLI 允许多进程。
- 唯一必须规避的缺陷：ACP 模式绑定固定端口 `127.0.0.1:6156` 会 `EADDRINUSE`。创建子进程时必须清空 `SERVER__PORT` / `SERVER__HOST`，且不传 `--port`。
- 成本：每进程 RSS 约 300 MB，冷启动到可用约 2 秒。

A2 方案（[codebuddy-single-process-http-acp.md](./backlog/codebuddy-single-process-http-acp.md)）也把 A1 记作 stdio 下唯一可行的并发拓扑；A1 落地后 A2 仍是省内存的后续路线，不是替代品。

---

## 3. 数据结构（Q1）

### 3.1 复合键与 scope

```ts
type BridgeScope =
  | { kind: 'agent' }                                  // 非 A1 agent：每 agent 一进程
  | { kind: 'chat'; dshSessionId: string }             // A1：一条 DSH 会话一进程
  | { kind: 'ephemeral'; token: string }               // A1：/acp 临时会话或匿名桶
  | { kind: 'probe' }                                  // A1：目录 / 测试探测进程

// 键只用于查表，永远不解析；scope 另存，避免从字符串反推。
private readonly bridges = new Map<string, AgentBridge>()      // bridgeKey -> bridge
private readonly bridgeScopes = new Map<string, BridgeScope>() // bridgeKey -> scope
```

- `bridgeKey(agentId, scope)`：非 A1 agent 一律返回 `agentId`（scope 折叠）；A1 agent 返回 `agentId + '\u0000' + scope.kind`，只有 `chat` / `ephemeral` 再拼 `':' + token`，`probe` 是每个 agent 的固定单例。分隔符用 `\u0000`，避免 agent id 与 DSH id 中的 `#` / `:` 造成碰撞。
- `bridgesOf(agentId)`：遍历 `bridges` 并按 `bridge.def.id` 过滤。会话数量是量级很小的 N，O(N) 可接受。
- `bridgeFor(agentId, scope)`：解析 def → 算键 → 取或 `makeBridge(def, …, onStatus)` → 同时写 `bridges` 与 `bridgeScopes`。
- `AgentBridge` 增加一个可选尾部参数 `onStatus?: (bridge: AgentBridge) => void`；`publishStatus` 优先调用它，否则保持原有的单 bridge 广播。这样 `testAgent` 与测试里直接 `new AgentBridge(...)` 的调用全部不改。

### 3.2 遍历代码为什么继续成立

以下代码只遍历 `bridges.values()`，键语义变化对它们透明：`BridgeManager.find`、`locateOrResume`、`tryLocate`、`sessions()`、`shutdownAll`、`activeTurnViews`、`pendingPermissionViews`、`hasActiveTurns`、`settleAgentSessions`、`settlePermissions`、`applyApprovalDeadlines`、`reapStalledTurns`、`persistAgents`。

必须改的只有把「一个 agent 一个 bridge」写死的地方：`bridge()`、`agentViews()`、`connectionLost` 的 turn-stream 清理、`saveAgentNow` 的 `has` / `delete`、`deleteAgent`、`stopAgent`、`setExposedModels` 的取实例、`probeAgentModels`、`startSession`、`getOrCreateDshSession`、`loadPersistedChatSessions`、`prepareStalledSession`、`rollbackFirstTurn`，以及所有 `this.bridge(session.agentId)` 调用点。

---

## 4. 归属映射（Q2）

| 场景 | scope | 何时建立 | 何时回收 |
|---|---|---|---|
| DSH 聊天会话 | `{ kind: 'chat', dshSessionId }` | `getOrCreateDshSession` 的 `new` 分支 | 崩溃 / 空闲释放只杀进程、holder 留到下次恢复；会话真正关闭且可丢弃时由 `pruneBridge` 回收，`stopAgent` / `deleteAgent` 兜底全清 |
| `/acp` 临时会话 | `{ kind: 'ephemeral', token: randomUUID() }` | `startSession` 分配 token 后 | `closeSession` 成功关闭且无 live / released 后 `pruneBridge` |
| 无 DSH 会话 id 的匿名回合 | `{ kind: 'ephemeral', token: 'anonymous' }` | `getOrCreateDshSession` 的 `ephemeral` 分支 | 与今天 `ephemeral:<agentId>` 桶相同；`streamPrompt` 结算后的 `.finally` 回收，空闲释放兜底 |
| 目录 / 测试探测 | `{ kind: 'probe' }` | `probeAgentModels` | 探测结束即 `pruneBridge`（`try/finally`，立即回收）；非 A1 折叠到 agent 槽，prune 不删 |
| fork 子会话 | 不允许 | — | — |

- `dshSessionMap` 的键保持 `${dshSessionId ?? 'ephemeral'}:${agentId}`，不新增映射层。聊天归属由 `dshSessionId` 确定性推导；临时会话归属由 `bridgeForSession(session)` 扫描 live / released 得到。
- `bridgeForSession(session)`：先扫**该 agent** 的 bridge（`bridgeOwning`）的 `hasSession(session.sessionId)` 与 `hasReleased(session.sessionId)`；找不到时，若 `session.dshSessionId` 存在，回落到 `chat` scope；再找不到才报 `unknown_session`。恢复在途时 `getOrCreateDshSession` 单独 `await inflightResume` 并复用同一 `LiveSession`。
- 查询型调用（`alignSessionConfig`、`setChatSessionModel`、`setChatSessionConfig`、`setChatSessionMode`、`applyChatChoice`）全部走 `bridgeForSession`，禁止只用 `agentId`。
- `rollbackFirstTurn` 需要非抛错的 `bridgeOwning(session)`：首轮回滚时记录可能已被 `forgetDshSession` 删除，不能用会创建新进程的 `bridgeFor`。

---

## 5. 生命周期（Q3）

### 5.1 spawn 与复用

- 首次 `session/new` / `session/load` / `session/fork` / 探测时，由 `AgentBridge.ensureReady(spawnCwd)` 惰性 spawn；沿用 60 秒 `withStartupTimeout`。
- 同一 scope 的连续回合复用同一进程；不同 DSH 会话互不复用。
- 聊天 scope 的 `spawnCwd` 就是该 DSH 会话的工作区；`extraRoots` 与 `createSession` 的现有规则不变。

### 5.2 空闲回收

- 每个 `AgentBridge` 自己的 `armIdleRelease` / `touch` 计时；释放一条会话只影响那条会话的进程。
- `releaseAll('idle')` 只把本 bridge 的会话挂成 released；进程死掉，holder 与 released 记录保留。
- 下一条消息经同一 bridge 的 `resumeSession` → `session/load` 恢复；遵守「先 `session/reset` 再 `session/load`」。
- 若 CodeBuddy 不声明 `loadSession`，`canIdleRelease` 保持 false：该会话进程不因空闲释放，避免丢上下文。此时进程数等于「打开过的会话数」，`stopAgent` 是唯一回收手段；这是 A1 的已知限制，不引入强制定稿或静默丢上下文。
- `released` 记录随 holder 保留；聊天 holder 不因空闲释放删除，否则 `dshSessionMap` 与 `locateOrResume` 会失去归属。

### 5.3 stop / delete / save / 工作区 / 关机

- `stopAgent(agentId)`：**先**给 `stoppingAgents` 对该 agent 加一（期间 `bridgeFor` 新建与已存在 holder 外借全部以 `agent_stopping` 拒绝，消息不排队）→ 按快照收集 `bridgesOf(agentId)` 与 owned 会话 id → 删该 agent 的 `dshSessionMap` 记录 → `disposeTurnStreamsOf` → `persistAgents` → `Promise.allSettled` 调每个 `AgentBridge.stop('agent-stopped')` → 按停止前键删 `bridges` / `bridgeScopes`（删除前做 `this.bridges.get(key) === bridge` 恒等校验）→ 递减计数。语义仍是「停止并清掉可恢复记录」，不是崩溃。
- `deleteAgent(agentId)`：同样清掉全部 bridge 与 scope，再删 def、目录、命令缓存；`agent/status` 广播 stopped。
- `saveAgentNow`（原稿名 `saveAgentDirectly`）：保存先 `stopAgent(id, false)` 停掉该 agent 的**全部**会话进程（同样受 `stoppingAgents` 门禁），再删除裸 `agentId` 槽、落盘、广播 stopped、按需探测目录。保存期间进行中的回合仍由 `AcpSaveGate` 与现有取消 / 重试路径处理；停止窗口内到达的新消息直接 `agent_stopping` 失败，不排队。
- 工作区搬迁：没有单独的 `moveWorkspace` RPC；`AgentBridge.ensureReady(wantedSpawnCwd)` 在 bridge 空闲时按新 cwd 重启。A1 下每个 bridge 只承载一条会话，搬迁只影响自己的进程；保存改 cwd 时 `saveAgentNow` 停掉全部进程，下次使用按新 cwd spawn。
- `shutdownAll`：已经遍历所有值并 `Promise.allSettled`；保持「并行、每 bridge 4 秒预算」，不因 N 线性累加。

### 5.4 holder 回收

- 新增 `AgentBridge.isDiscardable()`：`isQuiet()` 且 `released` 为空。
- `pruneBridge(bridge)`：`isDiscardable()` 时删除对应键与 scope，再 fire-and-forget 停子进程；非 A1 直接返回。调用点只有 `closeSession` 会话关闭后、首轮回滚后、`streamPrompt` 的 `.finally`、`probeAgentModels` 的 `try/finally`。
- 聊天 holder 只有在「没有 live、没有 released、没有工作」时才删；有 released 记录时必须保留。**未结算 prompt 保护**：`AgentBridge.pendingPrompts` 是「会话 id → 计数」的 Map，包住 `session/prompt` 的整个 await。严格计数进入 `isQuiet()`，所以会话已关闭但响应未回时 prune 与搬迁不动它；空闲释放只看 live / released 会话的计数，已关闭的残留请求不阻止放行。

### 5.5 CodeBuddy 启动环境

- 新增纯函数 `perSessionLaunchArgs(args, agentId)`：A1 agent 过滤 `--port` 与 `--port=<值>`；`--port` 后跟的一个值一并丢弃。非 A1 agent 原样返回。
- 新增纯函数 `perSessionLaunchEnv(env, agentId)`：A1 agent 删除 `SERVER__PORT` / `SERVER__HOST`（按键名大小写不敏感过滤，兼容 Windows）。非 A1 agent 原样返回。
- `AgentBridge.spawnAndConnect` 里 `windowsShimLaunch(command, this.def.args ?? [])` 与 `childEnv(process.env, this.def.env ?? {})` 分别换成上述两个 helper 的结果。`def.env` 再显式设置这两个键也会被清掉。
- 不新增 `--single-instance` 参数；CodeBuddy 产品本身允许多进程。

---

## 6. fork（Q4）

现状：CodeBuddy 的 `initialize` 不声明 `sessionCapabilities`，`AgentBridge.forkSession` 走不到；但设计必须先写清楚「将来它声明了怎么办」。

### 6.1 三个可选处理

**F1：迁到新进程。**

1. 父 bridge 发 `session/fork`，拿到子 ACP 会话 id。
2. 在新 bridge（scope 为子 DSH 会话）上 `ensureReady` + `session/load`。
3. 父连接上的子会话 `session/close`，父会话保持。
4. 前提是 `fork` 不驱逐父会话，且子会话可被另一进程 `load`。当前证据不支持这两点；失败形态是父上下文丢失、子不可恢复。

成本：两段式进程迁移、失败要 all-or-nothing 回滚、需要真实 CodeBuddy 验证。不推荐。

**F2：禁用 fork 能力位（推荐）。**

- `noteForkCapability` 对 A1 agent 存 `false`，即使 `initialize` 声明了支持。
- `canForkNow(agentId)` 对 A1 agent 直接返回 `false`；`sessionRowInfo` 的分支按钮因此禁用。
- `adoptForkedSession` 与 `AgentBridge.forkSession` 在入口再拦一次，返回 `fork_unsupported`，避免宿主已经分叉后才失败。
- 代价：CodeBuddy 少一个当前本来就没有的分支能力；收益：不破坏「一条连接一条会话」的不变量。

**F3：限定父进程独占。**

- 只允许父 bridge 没有其他 live 会话时 fork，子会话留在父进程；fork 成功后立刻把父会话挂成 released，让父进程只服务子会话，父会话下一条消息换新进程恢复。
- 这保持了「一个进程只有一个活跃 currentSession」，但 fork 动作本身仍可能驱逐父会话；父会话下一次发言会变成 `session/reset` + `session/load`，UX 明显倒退。不推荐。

### 6.2 推荐

**F2。** 理由：当前 CodeBuddy 没有对外暴露 fork，禁用不损失现有能力；F1 / F3 都依赖未经验证的 `fork` 不驱逐父会话与子会话可跨进程 `load`，在上游语义稳定前不引入。将来若真要恢复，先按 F1 做真实链路验证，再把 `PER_SESSION_AGENT_IDS` 的 fork 门禁单独放开。

---

## 7. `agentViews` 与共享状态（Q5）

### 7.1 聚合规则

`agentViews()` 对每个 def 调 `aggregateView(def)`：

1. `bridgesOf(def.id)` 为空 → 用 `makeBridge(def, …).view()` 的 stopped 形状，保持现有面板行为。
2. `state` 优先级：任一 `ready` → `ready`；否则任一 `starting` → `starting`；否则任一 `error` → `error`；否则 `stopped`。
3. `base` 取第一条与聚合 state 相同的 view；`liveSessions` 取所有 view 的并集；`agentInfo` / `agentCapabilities` / `idleTimeoutMs` / `cwd` / `args` 沿用 base。
4. `stderrTail` 只在聚合 state 为 `error` 时出现，取失败 bridge 的尾部；一条会话启动失败、另一条 ready 时，聚合 state 保持 `ready`，失败通过该会话的 `session/released`、设置页日志与**一条 `agent/notice`（`level: 'error'`，文本含 `failed to start`）**体现，`noticedBridgeFailures` 去重。

`AgentBridge.publishStatus` 不再直接广播单 bridge 的 view；它通过 `onStatus` 调 `BridgeManager.publishAgentStatus(agentId)`，由后者算聚合后再发一帧 `agent/status`。帧里的 `error` 只取**聚合 state 相同且 `errorText` 有值**的子进程，避免 stopped 兄弟的旧错误污染 ready 聚合；`errorText` 由只读 getter `AgentBridge.errorText` 暴露。非 A1 agent 只有一条 bridge，聚合结果与旧帧逐字段一致。

**全崩溃 ≠ error**：`releaseAll` 只把会话挂成 released、进程状态落 `stopped`；只有**启动失败**才进 `error`。所以两条会话都崩溃时聚合 state 是 `stopped`（不是旧稿写的 `error`），`stderrTail` 不出现；启动失败且所有兄弟都不健康时才是 `error`。

### 7.2 各类共享状态

- **activeSessions / liveSessions**：`AgentView.liveSessions` 是活会话并集；`activeTurnViews()` 与 `hasActiveTurns()` 继续遍历所有 bridge，得到全部进行中回合。
- **pending**：`pendingPermissionViews()` 遍历所有 bridge 的 `PermissionLedger`；权限卡按 `dshSessionId` 过滤，天然只落在对应会话；设置页镜像继续展示全部未决项。
- **暂停 / 恢复**：空闲计时按 bridge 独立；释放 A 不影响 B。`session/released` 只广播 A 的会话；恢复只走 A 的 bridge。
- **模型目录**：`agent/catalog` 仍按 agentId 单条；所有 bridge 的 `session/new` / `config_option_update` 都写同一份目录，不产生每进程副本。`session/set_config_option` 仍按 `shapeOnly` 只更新形状，不把单会话选择写成 agent 默认。
- **命令缓存**：`absorbCommands` 仍按 agentId 单条；斜杠隔离仍只有一个来源；多条 bridge 上报同一 agent 的命令集，后到覆盖先到，与今天同一连接多会话的行为一致。
- **保存门禁**：`AcpSaveGate` / `activeTurnViews` 继续按 agentId 统计全部会话；保存会等 / 取消该 agent 的全部进行中回合，语义不变。
- **持久化**：`persistAgents` 只读 `dshSessionMap`，与 bridge 数量无关；`chatSessions` 不会因为多进程重复写入。

---

## 8. 降级（Q6）

| 故障 | 影响范围 | 用户可见结果 |
|---|---|---|
| 可执行文件缺失 / `spawn` 报错 | 当前会话的 bridge | `ensureReady` 抛 `agent_unreachable`；该会话本轮失败；`agent/status` 若还有其他 ready bridge 仍为 ready |
| `initialize` 超时 | 当前会话的 bridge | `withStartupTimeout` 杀掉该子进程；该会话报 `agent_unreachable`；其他 bridge 不变 |
| `session/new` 失败 | 当前会话 | `createSession` 抛错，不注册会话；下一条消息重试；其他会话不变 |
| 回合中进程退出 / 连接关闭 | 当前会话的 bridge | `connectionLost` 只清理该 bridge 的 turn stream，再 `releaseAll('died')`；只广播该会话 `session/released`；该轮报错；其他会话继续 |
| 无 `loadSession` 的卡死恢复 | 当前会话 | `prepareStalledSession` 的 `forceReset` 只关该 bridge 的会话，`/acp` 报 `session_reset`；不再关闭同 agent 的其他会话 |
| 探测失败 | probe bridge | `probeAgentModels` 报错；聊天会话完全不受影响 |
| 空闲释放 | 当前会话 | 静默；`session/released` 记入设置页日志；下一条消息 `session/load` 恢复 |
| `stopAgent` / 删除 / 保存 | 该 agent 全部会话 | 显式动作；全部进程停止，记录按各自语义清理 |

隔离成立的关键改动：`BridgeManager.connectionLost` 现在的 `disposeTurnStreamsOf(controller => controller.session.agentId === bridge.def.id)` 会把**同 agent 其他会话**的 turn stream 一并拆掉；必须改成按本 bridge 的 live + released 会话 id 匹配。`prepareStalledSession` 的 turn-stream 扫描与 `hasOtherActiveWork` 也必须按本 bridge 统计，不能按 agent 统计。

---

## 9. 兼容（Q7）

- `agents.json` 的 `chatSessions` 字段不变：`dshSessionId`、`agentId`、`acpSessionId`、`cwd`、transcript、usage 等照旧。启动时 `loadPersistedChatSessions` 把每一行 `parkReleased` 到该行自己的 chat scope，而不是 agent 共享 bridge。
- 已持久化的 closed 记录继续丢弃；released 记录继续复原。宿主重启后第一次发言仍走 `resumeSession` → `session/load`。
- `model-catalog.json` 不变：按 agentId 存目录、命令缓存、fork 能力位。A1 不新增 per-bridge 字段。
- HMR / 宿主重启：旧子进程由现有 orphan reaper / `shutdownAll` 处理；新宿主只从 `chatSessions` 复原 holder，不信任任何 PID / 连接状态。
- `/acp` 临时会话不落盘，按需重建；关闭即 `pruneBridge`。
- 两个 DSH 窗口共享同一个 `~/.dsh/dsh-ntr` 仍是既有边界：本方案不解决跨窗口的同一 DSH 会话 id 冲突，只保证单宿主内一条会话一条 bridge。
- `AgentView`、`agent/status`、`session/released`、权限帧、聊天 transcript 的形状全部不变，浏览器半区无需改数据结构。

---

## 10. 测试计划（Q8）

### 10.1 新增用例（`tests/bridge.spec.ts`，def id 用 `codebuddy`）

1. **两条聊天会话并发不串话**：mock 加 `MOCK_SINGLE_SESSION=1`（`session/new` / `session/load` 驱逐其他会话，旧会话 prompt 返回 `session_superseded`）。两条 DSH 会话各自提问，断言 PID 不同、回答各自正确、transcript 不串。该用例在现状实现下必须失败。
2. **一条会话崩溃不影响另一条**：A 发 `DIE`，B 同时发普通提问；断言只有 A 收到 `session/released`，B 的回答完整、B 的 PID 不变、`agent/status` 仍为 ready。
3. **一条会话初始化失败不影响另一条**：用一个只在 A 的 spawn 失败的可控 def（或注入 `ensureReady` 失败），断言 A 报 `agent_unreachable`、B 正常 ready、B 的回合成功。
4. **空闲释放按会话独立**：两条会话，A 先空闲；断言 A 的进程消失、B 仍 ready；A 的下一条消息拉起新 PID，且先 `session/reset` 再 `session/load`；B 的 PID 与上下文不变。
5. **`stopAgent` 全停**：两条会话两个 PID；调用停止；断言两个进程都退出、`agentViews` 为 stopped、`sessions()` 为空、`dshSessionMap` 无该 agent 记录。
6. **`deleteAgent` 清理全部 bridge / scope**：删除后 `bridgesOf(agentId)` 为空、全部进程退出、存储行移除、后续 prompt 报未知 agent。
7. **`saveAgent` 全停并重建**：保存后两条会话的 PID 全部变化；下一次使用只拉起被使用的那条；旧 ACP 会话不再可用。
8. **`agentViews` 聚合**：两条 ready → ready 且 `liveSessions` 长度 2；一条崩溃 → 仍 ready；两条都**崩溃** → `stopped`（`releaseAll` 只挂起进程，不产生 `error`）；两条都**启动失败** → `error` 且带 stderr；无 bridge → stopped。单条启动失败但兄弟 ready 时另断言一条 `agent/notice`（含 `failed to start`），不重复发。
9. **fork 硬禁用**：即使 mock 的 `initialize` 声明 fork，`canForkNow('codebuddy')` 为 false，`sessionRowInfo` 的 fork 为 false，`session/chat-fork-adopt` 返回 `fork_unsupported`，且不产生第二个 ACP 会话。
10. **探测不打扰聊天**：一条聊天 ready 后跑 `probeAgentModels`；断言探测走独立 PID、聊天 PID 与 transcript 不变。
11. **启动环境净化**：纯函数单测 `perSessionLaunchArgs` / `perSessionLaunchEnv`；`['--acp','--port','6156'] → ['--acp']`、`['--port=6156'] → []`；`SERVER__PORT` / `SERVER__HOST` 无论从宿主还是 `def.env` 来都被删除；非 `codebuddy` 原样返回。
12. **`/acp` 临时会话隔离**：两次 `startSession` 得到两个 PID；取消 / 关闭一条不影响另一条；关闭后对应 bridge 被 prune。
13. **恢复已持久化的 `chatSessions`**：写入两条 released 记录后启动；断言两条 holder 都存在、`sessions()` 有两条 released；只恢复 A 时只 spawn 一个进程。
14. **目录与命令不重复**：两条会话都触发 catalog / commands 吸收；断言 `agent/catalog` 仍只有一行、命令缓存只有一条、没有 per-bridge 条目。

### 10.2 现有用例调整

- `tests/mock-agent.mjs` 只增 `MOCK_SINGLE_SESSION` 分支；现有 marker 行为不变。
- 现有测试的 agent id 都是 `mock` / `target` 等非 `codebuddy`，`A1` 谓词不命中，理论上无需改断言；但「另一条会话仍在工作会阻止 reclaim」两条用例（`/acp` 与聊天面）要继续作为**非 A1 基线**保留，并新增一条 `codebuddy` 对照：另一条会话在**另一个进程**工作时，不得阻止本会话的强制定稿 / 恢复。
- `agent/status` 的单 bridge 断言继续成立；若测试直接改 `manager.bridges`，只用非 `codebuddy` 的 id，避免复合键差异。
- `panel.spec.ts` 仅在保存确认文案从「该 Agent 进程」改成「该 Agent 的全部进程」时更新快照 / 文案断言。

---

## 11. 风险与不变量（Q9）

### 11.1 必须成立的不变量

1. **同 agent 不同会话之间不得共享 `currentSession`**：每条 DSH 会话只对应一个 chat scope、一个 `AgentBridge`、一条 stdio 连接；任何 prompt / setMode / setConfig / cancel 都经 `bridgeForSession` 落到自己的进程。
2. **同一会话不得被两个进程打开**：`dshSessionMap` 的 `${dshSessionId}:${agentId}` 键保证只有一条记录；`releaseAll` 先把会话挂成 released，`session/load` 只在同一 bridge 恢复；fork 被禁用，不存在「父会话与子会话同连接」。
3. **探测不得碰聊天会话**：probe 使用独立 scope，`probeConfigOptions` 打开的会话只属于 probe bridge。
4. **一条会话的故障不得终结另一条的 turn stream**：`connectionLost` / `prepareStalledSession` / `hasOtherActiveWork` 必须按 bridge 统计。
5. **未知会话不得被 `agentId` 兜底**：所有查询型写入都走 `bridgeForSession`；`rollbackFirstTurn` 用非抛错的 `bridgeOwning`。

### 11.2 风险与缓解

| 风险 | 影响 | 缓解 |
|---|---|---|
| N 条会话 = N × 约 300 MB RSS | 内存随打开会话数增长 | A1 不设硬上限，不做静默驱逐；靠空闲释放与 `stopAgent` 回收。后续可评估软上限，但需要独立方案 |
| 每条会话首次发言约 2 秒冷启动 | 首轮延迟 | 与今天每 agent 冷启动相同；不接受预热（会常驻 N 个空进程） |
| 保存 / 删除要停 N 个进程 | 操作变慢 | `Promise.allSettled` 并行；保存门禁已等待进行中回合；文案改为「全部进程」 |
| CodeBuddy 未声明 `loadSession` | 空闲释放无法挂起，进程常驻 | `canIdleRelease` 保持 false；不强制 reset；`stopAgent` 是逃生口。**实现没有设置页日志提示**（旧稿的计划项未落地，代码只静默不释放） |
| `EADDRINUSE 6156` | 子进程启动即失败 | 清空 `SERVER__PORT` / `SERVER__HOST`、过滤 `--port`；若 stderr 仍出现 `EADDRINUSE`，按 `agent_unreachable` 报给当前会话 |
| PID 复用导致 CodeBuddy 的 `sessions\<pid>.json` 串档 | 极端情况下状态污染 | CodeBuddy 自身支持多进程，PID 文件由它管理；A1 不额外写 PID 文件。记录为残余风险 |
| 两条会话同时首次加载同一 agent 的目录 | 后到覆盖先到 | 目录 / 命令仍是 agent 级、单条；不新增 per-bridge 副本；`shapeOnly` 保持 |
| 设置页把「ready」理解成「唯一进程」 | 文案误导 | 聚合语义是「至少一条进程可用」；只在保存确认文案里说「全部进程」 |

---

## 12. 实施顺序

1. **只改结构，不改行为**：加 `BridgeScope` / `bridgeScopes` / `bridgeKey` / `bridgesOf` / `bridgeFor`；`bridge()` 保留为 `bridgeFor(agentId, { kind: 'agent' })` 的薄包装；非 A1 agent 键仍是 `agentId`。跑现有 `tests/bridge.spec.ts`，零回归。
2. **改调用点**：`bridgeForSession` 接管 `streamPrompt`、`alignSessionConfig`、四轴写入、`prepareStalledSession`、`reclaimChatPrompt`、`rollbackFirstTurn`；修 `connectionLost` 的 turn-stream 作用域。
3. **接管生命周期**：`getOrCreateDshSession` / `loadPersistedChatSessions` / `startSession` / `probeAgentModels` / `stopAgent` / `deleteAgent` / `saveAgentDirectly` / `pruneBridge`。
4. **打开 A1 谓词**：`PER_SESSION_AGENT_IDS = new Set(['codebuddy'])`；加 `perSessionLaunchArgs` / `perSessionLaunchEnv`；加 `onStatus` 与 `publishAgentStatus` / `aggregateView`。
5. **fork 门禁**：`noteForkCapability`、`canForkNow`、`adoptForkedSession`、`AgentBridge.forkSession` 四道闸。
6. **测试与文档**：补 §10 用例；同提交更新 `AGENTS/architecture.md`、`AGENTS/protocol.md`、`AGENTS/state.md`；如改文案再动 `AGENTS/ui-panel.md`；`CHANGELOG.md` 只在发版时写。

每步都可独立验证：第 1 步验证非 A1 行为完全不变；第 2 步验证单会话；第 3 步验证多会话与恢复；第 4 步验证 CodeBuddy 并发；第 5 步验证分支按钮禁用。

---

## 13. 改动文件与符号清单

### `src/bridge.ts`

**新增**

- `type BridgeScope`、`PER_SESSION_AGENT_IDS`、`isPerSessionAgent(agentId)`。
- `BridgeManager.bridgeScopes`（只写不读，供测试与诊断）、`stoppingAgents`、`noticedBridgeFailures`、`bridgeKey`、`bridgeFor`、`bridgesOf`、`bridgeForSession`、`bridgeOwning`（非抛错）、`pruneBridge`、`publishAgentStatus`、`aggregateView`。
- `perSessionLaunchArgs(args, agentId)`、`perSessionLaunchEnv(env, agentId)`（纯函数，便于单测）。
- `AgentBridge.isDiscardable()`、`AgentBridge.errorText`（只读 getter）、`AgentBridge.onStatus`（构造尾参）、`AgentBridge.publishStatus` 的委托分支、`AgentBridge.pendingPrompts`（`session/prompt` 未结算计数）。

**改写**

- `BridgeManager.bridges` 的键语义与注释。
- `BridgeManager.bridge` → `bridgeFor`（全部调用点）。
- `BridgeManager.agentViews` → `aggregateView`。
- `BridgeManager.connectionLost` → 按 `sessionIdsOf(bridge)`（live + released 会话 id）清理 turn stream。
- `BridgeManager.saveAgentNow`（`has` / `delete`）、`stopAgent`（全部 bridge + 停止门禁）、`deleteAgent`（全部 bridge）、`setExposedModels`（聚合广播）。
- `BridgeManager.probeAgentModels`、`startSession`、`getOrCreateDshSession`（含 `session_orphaned` 与 `inflightResume` 复用）、`loadPersistedChatSessions`（每条 parked 到自己的 chat holder）。
- `BridgeManager.alignSessionConfig`、`setChatSessionModel`、`setChatSessionConfig`、`setChatSessionMode`、`applyChatChoice`。
- `BridgeManager.prepareStalledSession`（bridge 级 `hasOtherActiveWork`、turn-stream 扫描、`forceReset` 范围）、`reclaimChatPrompt`、`streamPrompt`（不缓存 bridge，每处重解析，结算后 `.finally` 补 prune）、`rollbackFirstTurn`。
- `BridgeManager.noteForkCapability`、`BridgeManager.canForkNow`、`BridgeManager.adoptForkedSession`、`AgentBridge.forkSession`。
- `AgentBridge.spawnAndConnect` 的 launch args / env 构造。

**不改**

- `AgentBridge.openSession` / `resumeSession` / `runPrompt` 的 ACP 请求形状。
- `AgentBridge.view` 的字段。
- `BridgeManager.find` / `locateOrResume` / `tryLocate` / `sessions` / `shutdownAll` / `activeTurnViews` / `pendingPermissionViews` / `hasActiveTurns` / `persistAgents`。其中前三个仍只按 `sessionId` 遍历全部 bridge、不按 agent 过滤，是**已知取舍**（[backlog](./backlog/agent-scoped-session-lookup.md)）。
- `PermissionLedger`、`AcpSaveGate`、`hmr-guard`、模型目录 / 命令缓存、`chatTranscripts`。

### `src/protocol.ts`

无结构变化。`AgentView`、`chatSessions`、`AgentSavePayload`、`AcpAgentDef` 字段不变；不新增 `perSession` 配置项（A1 是上游缺陷的临时适配，按 agent id 判定，不暴露给用户）。

### `src/client/panel.tsx`

仅保存确认文案：把「该 Agent 进程」改成「该 Agent 的全部进程」。其余 UI 不改。

### `tests/mock-agent.mjs`

新增 `MOCK_SINGLE_SESSION=1`：`session/new` / `session/load` 记录新会话并驱逐其他会话；被驱逐会话的 prompt 返回 `session_superseded`。现有 marker 不变。

### `tests/bridge.spec.ts`

新增 §10 用例；保留现有非 A1 基线。

### 文档

- 本文件；[docs/README.md](../README.md) 索引。
- 实施时同提交：`AGENTS/architecture.md`（拓扑与 scope）、`AGENTS/protocol.md`（§3 连接丢失 / §5 空闲释放 / §6.1 卡死恢复）、`AGENTS/state.md`（归属与恢复）、`AGENTS/ui-panel.md`（保存文案）、`CHANGELOG.md`（发版）。

---

## 14. 验收标准

1. 两条 CodeBuddy DSH 会话可同时进行，PID 不同，回答不串话。
2. 一条会话的崩溃 / 初始化失败 / 卡死恢复不终结另一条的 turn stream 与上下文。
3. `stopAgent` 停止该 agent 的全部进程；`deleteAgent` 清空全部 bridge / scope；`saveAgent` 全停后按需重建。
4. 空闲释放与恢复按会话独立，恢复前有 `session/reset`，上下文按 `chatSessions` 复原。
5. 任何 CodeBuddy 子进程的启动参数不含 `--port`，环境不含 `SERVER__PORT` / `SERVER__HOST`。
6. `codebuddy` 的分支按钮为禁用态，`session/chat-fork-adopt` 返回 `fork_unsupported`。
7. `npm run prepack` 通过；现有非 A1 用例零回归。

## 15. 实现落地差异（以代码为准）

以下几处与设计稿写法不同，已经按实现改动；再次阅读时不要再按旧稿理解：

- **探测 holder 立即回收**：`probeAgentModels` 用 `probe` scope + `try/finally`，探测结束马上 `pruneBridge`；旧稿「holder 留到 stopAgent」不成立。5 分钟探测窗口只兜底未被显式回收的空 holder。
- **`stopAgent` 顺序**：先开停止门禁 → 快照 → 删 `dshSessionMap` → 清 turn stream → `persistAgents` → 等全部 `stop` → 恒等校验后删键 → 关闸。旧稿「最后 persist」不成立。
- **全崩溃 = `stopped`**：`releaseAll` 只挂起会话、进程状态落 `stopped`；`error` 只代表**启动失败**。因此两条会话都崩溃时聚合是 `stopped`，不是 `error`。
- **启动失败通知**：单条启动失败且兄弟健康时，聚合仍 `ready`，另发一条 `agent/notice`（`level: 'error'`，含 `failed to start`），`noticedBridgeFailures` 去重。
- **`streamPrompt` 不缓存 bridge**：`initResult` / `claimTurn` / `beginTurn` / `runPrompt` 每处 `bridgeForSession(session)` 重解析；`onAbort` 只 `bridgeOwning`。`pendingPrompts` 按 ACP 会话 id 计数、包住 `session/prompt` 的整个 await，防止 prune 在请求未答时误删。它有两套读数：`hasActiveWork()` 默认严格计数（`pruneBridge` 与工作区搬迁用），`pendingPromptsOnServableSessions()` 只数 live / released 会话（空闲释放用）。已从 `sessions` 删除的会话上永不答复的请求因此不钉住进程；关闭在途（记录仍留在 `sessions`）仍算可服务，最多拖住 5 秒；代价是进程死后迟到的结算变成连接错误（见 [AGENTS/state.md §2.1](../../AGENTS/state.md)）。新增用例 `A1: a silent first turn that never answers still lets the idle clock release its child` 覆盖这条放宽。
- **`bridgeScopes` 只写不读**：它是 `bridges` 键集合的伴生状态，仅供测试与诊断（生产代码 1 处声明、1 处写入、4 处删除，无消费者；唯一读取方是 `tests/bridge.spec.ts` 的 3 处断言）。运行时判定作用域的唯一权威是 `bridges` 的复合键与 `bridgeKey`。清理时删字段并把断言改为只看 `bridges` 键，不为消除死代码在业务逻辑里接读取。
- **新增 `session_orphaned`**：`dshSessionMap` 还有 live 绑定、但 holder 三态都未命中时，先 `forgetDshSession` 再失败；不为孤儿记录 spawn。
- **测试规模**（设计稿列 14 条 A1 用例）：A1 分组覆盖停止门禁、首轮失败回收、恢复在途归属、持久化恢复、启动失败通知、聚合 stopped、一次性探测、启动参数 / 环境清洗、空闲释放越过已关闭会话的待答请求等；全部在 `tests/bridge.spec.ts` 的 `A1: codebuddy runs one agent process per conversation` 分组，用 `tests/mock-agent.mjs` 的 `MOCK_SINGLE_SESSION` 占位模拟上游串话。具体条数以实现方最终统计为准。
