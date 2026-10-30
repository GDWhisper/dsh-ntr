# 已退役的轴与幽灵符号

本文是 [AGENTS.md](../AGENTS.md) 的冷存储层：记录**不要重新引入**的错误方向。完整推导、实测日志与分批退役清单见 [acp-convergence.md](../docs/acp-convergence.md)、[acp-mode.md](../docs/acp-mode.md)、[acp-permission-and-sandbox.md](../docs/acp-permission-and-sandbox.md)。

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

### 原生审批路由：把 ACP 询问交给宿主 `ctx.approval`

- **退役**：`askNativeApproval` / `nativeOutcomeResponse` / `setApprovalRequester` / `approvalRequester` / `ApprovalRequester` / `ApprovalOutcome` / `ApprovalRequestContext` / `approvalRouting` / `ledgerFallbackOf` / `ledgerFallbacks` / `LedgerFallbackReason` / `LedgerFallback`；`src/index.ts` 的 `wireApproval` 与 `ApprovalServiceLike` / `AgentsServiceLike`；`agents/list` 的 `approvalRouted` 能力旗标；浏览器 `ui.approvalRouted` / `fellBackFromConversation`。连同它的原因码 `no-requester` / `no-chat-session` / `unavailable`（这些不再是现行路径分类）。
- **为什么死**：宿主审批链是**黑箱**——它可以收下 `ctx.approval.request` 却什么都不渲染，而默认 `wait` 没有期限，于是 turn 挂在完全不可见的地方：没有卡、没有聊天行、没有期限（issue #2；实测 CodeBuddy 2.177.0 + 宿主审批提示关闭，只剩 agent 侧心跳）。插件这一侧能观测到的只有「没人回答」，而「人答得慢」与「宿主从没渲染」长得一模一样；所有降级原因码都只是在黑箱外猜它做了什么。现在每一问都建 `PermissionLedger` 条目、广播 `permission/request`（`auto` + `0` 的到达即收场除外），卡片、期限与去留都在插件自己手里。
- **不要重建**：宿主审批路由、能力旗标、原因码；也**不要**把到点的询问「转移」到 ledger 当作第二机会（见下一条）。到点必须**就地收场**：`abort` 拒绝 / `auto` 代答 / `wait` 不设期限。**仍然有效**：三档模式与一个窗口；`agent/notice` + `permission/expired` 留痕；`permission/request` 重连重放。见 [permissions.md](./permissions.md)。
- **接受的两个代价**：宿主 approval policy（`ask` / `never`）不再作用于 ACP 询问——它只管宿主自己的工具，无人值守部署改用插件 `auto` / `abort` 窗口；DSH 会话日志不再写 ACP 询问的 `approval/asked` / `approval/decided`——审计痕迹由插件 transcript 承载。两条都是有意的取舍，不是待修缺陷。见 [permissions.md §1](./permissions.md)。

### 超时把询问转移到设置页（撤回 → 改走 ledger）

- **退役**：native 窗口到点后「撤回」并把同一问题改走 `PermissionLedger` 的那套机制；原因码 `native-timeout`；`LedgerFallback.waitedMs`；设置页卡片把两个窗口说成**一条链**（第一档撤出、第二档在设置页代答）。理由：转移只买到一个「第二机会」，却把问题送到用户**不在看的页面**，几分钟后照样被取消——那既不是挂起也不是取消，是没人要的混合态。更糟的是它对**每一问**都触发（定时器在 `requester(...)` 之前就 arm，一张正常渲染出来、你只是还没点的卡片同样会被撤走）。
- **仍然有效**：超时就地收场，三档 `wait`（默认）/ `abort` / `auto`（`auto` 按 option kind 优先级代答，挑不出合法选项则降级 `abort`）；到点必须留痕（`agent/notice` + `permission/expired`，对话里有一行说明）。见 [permissions.md §2.1](./permissions.md) 与 [ui.md §8](./ui.md)。

### 两个等待窗口（对话一处、ledger 一处）

- **退役**：`nativeApprovalTimeoutMs` / `permissionFallbackTimeoutMs` 两个可设窗口，以及那个「一视同仁覆盖两者」的 `permissionTimeoutMs` 总闸；设置页卡片的三行版（到点怎么处理 + 对话里的询问 + 待处理权限请求里的询问）。理由：两处询问问的是同一个问题（「有人在吗」），分成两个数字只会让用户**看不出它们是不是一套**，还会配出互相矛盾的值（对话 5 分钟、ledger 1 小时）。总闸则让「卡片里那个数」和「真正生效的数」不是同一个数——卡片在骗人。
- **仍然有效**：**一个**窗口 `permissionTimeoutMs`（默认 300_000，`0` = 不等待）+ 一档到点行为；卡片只剩两个控件并有一句话把两者说成一套。见 [permissions.md §2.4](./permissions.md) 与 [ui.md §8](./ui.md)。
- **旧配置仍被接受**：`validateConfig` 把 `nativeApprovalTimeoutMs` / `permissionFallbackTimeoutMs` 折叠进新键（新键在场时忽略旧键），所以老的 `cordis.patch.yml` 不会静默回到默认值。

### 时长轴上的「一直等待」档（以及 `0` = 一直等的旧义）

- **退役**：滑块最右端的「一直等待」档，以及「窗口 `0` 表示这一窗永不触发」的旧义。理由：「永不到期」是**模式**（`wait`）的事，时长轴再放一档，同一件事两处各说一遍，用户只会怀疑自己漏配了什么。旧义更要命——`0` 一旦被重新解释成「不等待」，一个无人值守的部署会从「一直等」静默变成「立即自动放行」。
- **仍然有效**：`wait` 模式是**唯一**能表达「永不到期」的档；新键 `permissionTimeoutMs: 0` 是**不等待**，且**只属 `auto`**（它代答，agent 继续）；`abort` 档**没有**这一档——同样的 0 在那里是立刻拒绝每一问，agent 在每个门口都停住，所以落到最短真实等待 30 秒（`normalizeApprovalWindow`，配置 / 状态文件 / 模式切换三条来路都走它）。滑块档位为 不等待 / 30 秒 / 1 分 / 5 分 / 15 分 / 30 分 / 1 小时 / 6 小时（`wait` 档下不画滑块），「不等待」只在自动推进档出现。旧键里的 `0` 迁移成 `wait` 模式 + 300_000 窗口（`validateConfig` 的 `legacyNever`、`BridgeManager.loadPersistedAgents` 同规则）。见 [permissions.md §2.1、§2.4](./permissions.md) 与 [ui.md §8](./ui.md)。

### agent 定义上的权限策略字段

- **退役**：`AcpAgentDef.permission`（`ask` / `allow` / `reject`）、RPC `agent/set-permission`、`AgentBridge.permissionDecision`、设置页的「权限策略 / 要不要问人」下拉。它让插件替 agent 代答（`allow` / `reject`），与「agent 报什么就问什么」矛盾；要不要问由 agent 自己的 mode 决定。
- **仍然有效**：每一问都必须到人面前——经插件自己的 `PermissionLedger`，对话 `PermissionDock` 是主入口，设置页是跨会话镜像。没有宿主仲裁，也没有本地代答开关。见 [permissions.md](./permissions.md)。

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
native-timeout  LedgerFallback.waitedMs
askNativeApproval  nativeOutcomeResponse  setApprovalRequester  approvalRequester
approvalRouting  ledgerFallbackOf  ledgerFallbacks  wireApproval
approvalRouted  fellBackFromConversation  ApprovalRequester  ApprovalOutcome
ApprovalRequestContext  LedgerFallbackReason  LedgerFallback  ApprovalServiceLike
nativeApprovalTimeoutMs  permissionFallbackTimeoutMs  DeadlineModeRow  DeadlineRow
answerBuffer  streamedAnswerLength  pendingToolAnswers  cardOutputs
acpToolCallDetailsOf  acpToolActivityLine  acpToolActivityOutput  acpToolInputOf
noteToolActivity
useDirectory  resolveDirectory  ModelDirectoryResolver  directoryFor
```

> 工具卡路径的符号（`isAcpToolContinuation` / `recordAcpToolOutput` /
> `toolResults` / `acpToolCallFromUpdate` / `acpToolCallDelta` /
> `acpToolCallArgsOf` / `registryHasToolCall` / `toolOutputFor` / guard 的
> 虚拟工具）**不在**幽灵清单里：它们在 2026-10-19 随 §1.7 的散文形态短暂
> 退役，又随 [acp-convergence.md](../docs/acp-convergence.md) §1.8 的逐步切分
> 复活（升级了可等待的 `waitForToolOutput`）。仍退役的是**缓冲重放**那一套
> （`answerBuffer` / `pendingToolAnswers` / `cardOutputs`）：切段后答案自然
> 落在卡后的新消息里，缓冲没有存在理由；散文一族
> （`acpToolActivityLine` / `noteToolActivity` …）同样不要再回来。

`tests/impl.spec.ts` 的 "the retired permission axis" 套件断言其中一部分 helper 已不存在。
