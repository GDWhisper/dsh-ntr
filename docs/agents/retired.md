# 已退役的轴与幽灵符号

本文是 [AGENTS.md](../../AGENTS.md) 的冷存储层：记录**不要重新引入**的错误方向。完整推导、实测日志与分批退役清单见 [acp-convergence.md](../acp-convergence.md)、[acp-mode.md](../acp-mode.md)、[acp-permission-and-sandbox.md](../acp-permission-and-sandbox.md)。

## 错误轴：把 ACP 当成 DSH LLM provider

这条轴要求 ACP 会话先写一条 `provider=acp` 的路由才能发消息。由此衍生的问题：写路由污染全局默认模型、被 GUI 目录门禁拒、原生模型座位必须遮蔽、`request/header` 里记着别人的 provider。约束 8 / 15 / 17 / 20 / 22 的旧形态是为这条轴（以及同期的「宿主替 agent 裁决」）打的补丁。

**现行结论**：ACP 会话不写任何 DSH 模型路由；发消息仍走宿主 driver，由插件绑定 + guard 改写接到 `acp/<agent>`。ACP 模型面只在 `agent/catalog`，DSH 目录里没有 ACP 条目。

## 各条退役内容

### 约束 8：ACP 模型进入 DSH 目录

- **退役**：「为了让 ACP 会话能发消息，必须先进模型目录」这个前提。`listModels('acp')` 返回空是隔离手段，不是发消息的门禁。
- **仍然有效**：`agent/catalog` 作为 agent 自己的模型面；纯内存应答、探测只允许三种有手势来源；变体按需；目录热更新；`set_config_option` 不喂 `absorbCatalog`。见 [state.md §4](./state.md)。

### 约束 15：DSH Access mode 裁决

- **退役**：`decidePermission` / `authorizeWrite` / `dshSessionPolicyOf` / `sandboxDenialMarker` / `wireAccessMode` / `setSessionPolicyResolver` / `DshSessionPolicy`。宿主不再坐在中间替 agent 判一遍，`approval === 'never'` 之类的全局 knob 不参与。
- **仍然有效**：工作区即侧栏路径（session cwd + 进程 cwd，见 [architecture.md §4](./architecture.md)）；prompt 严格等于用户文本、不叙述边界；agent 自己的 mode 只经 `session/chat-list` / `session/chat-mode-set` 上报与切换。fs 只剩 `guardFsPath` 的 workspace containment。见 [permissions.md](./permissions.md)。

### agent 定义上的权限策略字段

- **退役**：`AcpAgentDef.permission`（`ask` / `allow` / `reject`）、RPC `agent/set-permission`、`AgentBridge.permissionDecision`、设置页的「权限策略 / 要不要问人」下拉。它让插件替 agent 代答（`allow` / `reject`），与「agent 报什么就问什么」矛盾；要不要问由 agent 自己的 mode 决定。
- **仍然有效**：审批按「原生 composer → 设置页 ledger」两级路由，每一问都必须到人面前。见 [permissions.md](./permissions.md)。

### 约束 17：narrateOnly 裁决

- **退役**：`decidePermission(..., { narrateOnly: true })` + 保留 `authorizeWrite` 栅栏 + 「不叙述边界」的组合。宿主仍替 agent 判一遍，只是判得宽松。
- **仍然有效**：NTR 模式是 agent preset；`agent/pre-step` 兜底过滤；「是否 NTR 会话」读会话日志 preset（`sessionAgentPreset` / `setAcpModeResolver`），严禁自建标记位。见 [architecture.md §5](./architecture.md)。

### 约束 20：竞争式座位遮蔽

- **退役**：`AcpModelSeat` / `AcpSeatProps` / `menuFor('seat')` / `seatOwns` / `syncModelSeat` / `dropSeat` / `ensureSeatWins` / `seatIsOus` / `seatBroken` / `seatRegistered` / `shouldShadowModelSeat` / `setAcpSeatActive` / `useAcpSeatActive` / `AcpModelSeatShadow` / `MODEL_SEAT_SHADOW_PRIORITY`（后两个随「遮蔽改接管」删除，`MODEL_SEAT_SHADOW_PRIORITY` 更名为 `MODEL_SEAT_PRIORITY`）。
- 不要带回：undercut rank 算术、退注册重注册、abdicate 恢复 / `seatBroken`。
- 也不要把「渲染 `null` 就够了」或「组件里 `return null` 就是隔离」当结论——两次都是修过的真实缺陷。
- **仍然有效**：`createModelSeatClaim` 装的是 NTR 底座本体；`entriesOfSlot` 核实 + 有界重取；动态注册、切走即撤；`stagedSessionOf` / `rowAgentPreset` 的两代快照读法；`ACP_PRESET_ID` 三处同步；失败一律不接管。见 [ui.md](./ui.md)。

### 约束 22：默认模型守卫与路由强制

- **退役**：`AcpDefaultModelGuard` / `reconcileDefaultModel` / `lastNativeRoute` / `settleAcpRoute` / `watchRoute` / `routeAttempts` / `routeNotices` / `acpRouteTarget` / `selectAcpRoute` / `setDefaultModelGuard` / `wireDefaultModelGuard`；RPC `model/get-default` / `model/set-default` / `model/reconcile-default`。
- **仍然有效**：`defaultAgentId`（插件私有状态）；`session/chat-bind` / `chat-model-set` / `chat-effort-set` / `chat-mode-set`；删除 agent 清空默认指针；严禁 `directory.select` / `selectModel`。见 [architecture.md §3、§6](./architecture.md) 与 [state.md §3](./state.md)。

## 为什么不读 `modelSelection`

宿主 wire view 是 `next = pending ?? lastUsed`：`lastUsed` 由每条 `request/header` 写入（「这个会话跑过一轮」），投影又在页面加载时由宿主投影块经 `ProjectionValueStore.seed()` 种入——读 `next` 等于「永不路由任何用过的会话」。而 `pending` 虽然是真实的用户选择，**但不携带模式**：实测会话 `940a8365` 在标准模式下 `/model` 选了 `tokimi/mimo-v2.6-flash`，再切到 NTR 模式，跨模式的 `pending` 被旧逻辑放行，`request/header` 发往原生 provider，而 system prompt 已是 ACP preset 的无工具版本——**模式与内核脱钩**。这是本项目走错方向最完整的一份记录，不要重走。

## 幽灵符号清单（看到它们出现在新代码里就是回归）

```
AcpModelSeat  AcpModelSeatShadow  AcpSeatProps  menuFor('seat')
shouldShadowModelSeat  ensureSeatWins  seatBroken  dropSeat
MODEL_SEAT_SHADOW_PRIORITY
AcpDefaultModelGuard  reconcileDefaultModel  settleAcpRoute  watchRoute
selectAcpRoute  setDefaultModelGuard  wireDefaultModelGuard
decidePermission  authorizeWrite  dshSessionPolicyOf  sandboxDenialMarker
wireAccessMode  setSessionPolicyResolver  DshSessionPolicy
PermissionMode  permissionDecision  agent/set-permission  def.permission
answerBuffer  streamedAnswerLength  pendingToolAnswers  cardOutputs
acpToolCallDetailsOf  acpToolActivityLine  acpToolActivityOutput  acpToolInputOf
noteToolActivity
useDirectory  resolveDirectory  ModelDirectoryResolver  directoryFor
```

> 工具卡路径的符号（`isAcpToolContinuation` / `recordAcpToolOutput` /
> `toolResults` / `acpToolCallFromUpdate` / `acpToolCallDelta` /
> `acpToolCallArgsOf` / `registryHasToolCall` / `toolOutputFor` / guard 的
> 虚拟工具）**不在**幽灵清单里：它们在 2026-10-19 随 §1.7 的散文形态短暂
> 退役，又随 [acp-convergence.md](../acp-convergence.md) §1.8 的逐步切分
> 复活（升级了可等待的 `waitForToolOutput`）。仍退役的是**缓冲重放**那一套
> （`answerBuffer` / `pendingToolAnswers` / `cardOutputs`）：切段后答案自然
> 落在卡后的新消息里，缓冲没有存在理由；散文一族
> （`acpToolActivityLine` / `noteToolActivity` …）同样不要再回来。

`tests/impl.spec.ts` 的 "the retired permission axis" 套件断言其中一部分 helper 已不存在。
