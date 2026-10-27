# 权限：agent 自治，宿主只接住

本文是 [AGENTS.md](../../AGENTS.md) 的展开层。核心：**agent 报什么就问什么，宿主不预先裁决**。

## 1. 映射

ACP `session/request_permission` 原样映射：选项列表 / allow-deny / tool call 详情都按 ACP 协议接住并回包。每一问都必须交给人——原生审批链在时进对话 composer，否则进设置页 ledger。插件没有任何本地代答开关（`permission: allow` / `reject` 与 `agent/set-permission` 已删除）：agent 自己决定要不要问，宿主不替它回答。

已删除、不要带回：`decidePermission` / `authorizeWrite` / `dshSessionPolicyOf` / `sandboxDenialMarker` / `wireAccessMode` / `setSessionPolicyResolver` / `DshSessionPolicy`。DSH 的 Access mode / sandboxPolicy 不参与 ACP 裁决。

**fs 围栏只有一道**：`AgentBridge.handleFsWrite` → `guardFsPath` → `resolveFsPath(session.cwd, [...allowedCwdRoots, session.cwd], …)`。越界即拒，错误文案由 `resolveFsPath` 产出。没有 escalation、没有一次性许可、没有方言 marker——DSH 的沙箱管不到 agent 自己的进程，第二道门只是幻觉。测试：`tests/bridge.spec.ts` 的 "fences fs/write_text_file by the workspace, and nothing else"。

**不向 agent 叙述边界**：每轮转发给 ACP 的 prompt 必须严格等于用户文本（`promptText`），严禁拼任何边界/策略句子。曾有一版 `policyNotice` 前缀，已按要求彻底移除，不要以「agent 不知道边界」为由重加。

## 2. 原生审批路由

**路由条件**：桥已拿到 requester 且会话有 `dshSessionId`（经 `AcpLlmAdapter` 起的聊天会话）时，必须调用宿主 `ctx.approval.request({ agent, toolName, signal })`，让审批出现在对话 composer 里。`dshSessionId` 只允许在 `BridgeManager.getOrCreateDshSession` 的两条分支（新建、released 后 resume）写入。

**降级**：三条路径都必须回落到 `PermissionLedger` + `permission/request` 广播，严禁让异常冒泡到 agent 的 turn。`askNativeApproval` 用原因区分（`LedgerFallbackReason`）：

| 原因 | 含义 | 超时行为 |
|---|---|---|
| `no-requester` | 无 approval 服务、`ctx.agents.get` 取不到、requester 抛错 | 设计内 ledger 路径；`permissionTimeoutMs` 默认 `0` 时无限等待 |
| `no-chat-session` | `/acp` RPC 会话，没有聊天 turn 可挂审计对 | 同上 |
| `unavailable` | 服务在、这一次失败 | 降级路径：改走 `permissionFallbackTimeoutMs`（默认 300_000 = 5 分钟），到时代答 `cancelled`；填 `0` 关闭 |
| `native-timeout` | 宿主**收了问题却不答**（answerer 不在浏览器 scope、对话未挂载、remote 事件没送达） | 同上；另外路由本身有 `nativeApprovalTimeoutMs`（默认 120_000），到点撤回后才会走到这里 |

- **两个期限都是配置项**（`AcpPluginConfig`，`cordis.patch.yml` 里注释了默认值）：`nativeApprovalTimeoutMs`
  （撤回窗口，默认 120_000）与 `permissionFallbackTimeoutMs`（降级询问的代答窗口，默认 300_000）。
  `0` = 对应期限永不触发（恢复加期限之前的行为）；`permissionTimeoutMs > 0` 时它对所有路径一视同仁、
  覆盖这两个值。OmniTerm dev 把同一对窗口做成 `acp_perm_timeout_secs`（30 秒步进、上限 1 小时、
  原子量热更新）+ `acp_perm_timeout_mode` 三档；本插件只取两档——`0` 即 OmniTerm 的 `wait`，
  现行行为即 `abort`，`auto`（代答）与「每一问都必须交给人」冲突，不设。热更新未做：配置在
  `apply()` 时读一次，改配置要重启插件进程。

- **路由有截止期限**（`BridgeTuning.nativeApprovalTimeoutMs`）： routed ask 的唯一答案入口就是 composer 接管，且**不广播任何帧**——宿主收了问题却不渲染，turn 就挂在一个人看不见的地方（issue #2 的实测：只剩 agent 侧心跳，会话永久挂起）。到点即**撤回**：abort 交给宿主的 signal（宿主 waterfall 用同一个 signal 赛跑答案，遂以 `cancelled` 收尾、composer 面板消失），再把同一问题改走 ledger。撤回**不是代答**——人照样能在设置页回答同一个问题；填 `0` 关闭该期限（恢复无限等待）。
- `permissionTimeoutMs > 0` 时对四条路径一视同仁。路由成功时**不启动**任何定时器（人在对话里答，不能抢答），但仍广播一条 `permission/resolved` 保持事件流对称。
- 原因必须在广播**之前**记进 `ledgerFallbacks`（`ledgerFallbackOf` 读）。`streamPrompt` 据此写聊天提示：设计内路径说「please approve in Settings」；降级路径必须说清为什么对话没展示这个问题（`unavailable` = 审批服务不可用；`native-timeout` = 问题从未到达对话）并带倒计时——否则「去设置页批准」读起来像一个选择，而它其实是 deadline。
- `approval` / `agents` 两个服务**严禁**写进 `src/index.ts` 的 `export const inject`（缺服务会让插件整体加载失败），只能 `ctx.get` + `ctx.inject(['approval','agents'], …)` 后补注册。
- `approvalRouted` 由 `agents/list` 只读上报（缺失报 `false`）。它是**能力上报，不是每次询问的承诺**：单条询问仍可能因 `unavailable` 或没有对话身份落到 ledger，所以浏览器**不据此隐藏**待处理卡片。

## 2.1 重连重放（未决询问不得只发一次）

`permission/request` **只在询问创建时广播一次**。之后才连上来的客户端（刷新页面、第二个标签页、SSE 断线重连）永远收不到它——而 ledger 询问的唯一答案入口就是设置页那张卡，于是「最需要它的客户端恰好看不到」。OmniTerm dev 用
`PermissionManager::pending_events()` + 连接时的 `PermissionsSynced` 标记帧堵住同一个洞，本插件照做：

- `AgentBridge.handlePermissionRequest` 建 ledger 条目时把 `toolCall` / `options` 一并存进条目（`PermissionLedger.create` 第三参）；没有 view 的条目不参与重放——重放一张渲染不出来的卡比不重放更坏。
- SSE 路由（`/api/acp/stream`）在 `stream/open` 之后、**订阅之后**取快照重放（`permissionReplayFrames`）：订阅后取快照，期间广播的询问会同时以实时帧和快照帧到达，客户端按 requestId 幂等折叠。
- 终帧 `permission/synced` 带**活集合**：断线期间已被解决的询问不在其中，客户端据此丢掉自己还挂着的陈旧卡片（否则 `respond` 只会换来 `unknown_request`）。
- 原生路由上的询问**不重放**：它们不广播任何帧，答案入口是客户端已经持有的 composer 接管。

测试：`tests/impl.spec.ts` 的 "replays only asks that carry a view"、`tests/store.spec.ts` 的 "re-establishes the pending asks on reconnect and prunes the stale ones"、`tests/bridge.spec.ts` 的 "lists the outstanding ledger asks for a reconnecting client"。

## 2.2 `session/cancel` 必须答复未决审批

ACP 规范的另一半：client 发 `session/cancel` 后**必须**以 `cancelled` 答复所有未决
`session/request_permission`。`AgentBridge.cancel` 因此在通知之后 `settlePermissions(session)`——
否则 agent 的工具调用会一直阻塞在一个永远不会到来的答复上，ledger 还会留着一张属于已结束回合的卡
（人再去点它只会得到 `unknown_request`）。这与 OmniTerm `AcpClient::cancel` →
`PermissionManager::cancel_all` 是同一条规则。`releaseAll` / `closeSession` 本来就 settle，
`cancel` 是漏的那一条。测试：`tests/bridge.spec.ts` 的 "answers a pending permission with
cancelled when the turn is cancelled"。

原生路由上的询问不受此影响（ledger 里没有条目）：它由 `nativeApprovalTimeoutMs` 到期撤回，
composer 面板随之消失。

## 3. 审批 UI

**ledger 卡**（`src/client/panel.tsx` · `permissionLedgerCard`）：只要 `ui.permissions` 非空就渲染可答复的卡片，**与 `ui.approvalRouted` 无关**。

- 询问会落进 `ui.permissions` 恰恰因为它走了 ledger（`handlePermissionRequest` 只在 ledger 路径广播 `permission/request`），所以「有待处理项」就等于「对话没有在展示它」。
- 按 `approvalRouted` 隐藏按钮会在原生路由降级成 `unavailable` 时藏掉唯一入口，询问挂到超时。
- `fellBackFromConversation`（有待处理项且 `approvalRouted`）是卡片必须多解释一句的情况：宿主能路由，这一条却没进去。测试：`tests/store.spec.ts` 的 "answers a pending permission ask even when the host reports the native chain"。

**设置页没有权限开关**：agent 卡不再提供「权限策略 / 要不要问人」。要不要问由 agent 自己的 mode 决定，问了就一定会到人面前。

**会话权限档整格占空**：NTR 模式下 `conversation.input.permission` 由 `createPermissionSeatClaim`（`src/client/model-seat.tsx`）占领并渲染 `null`（配合 safe inject `{}` 防 session scope 崩溃）。DSH 原生 Access mode 规定的是宿主对自己工具的写策略，对外部 agent 进程毫无作用且容易误导。

- 它与模型底座同享 `syncAcpMode` 闸门生命周期，共用撤退函数 `standDown`：**每一条未经确认 ACP 判定的路径都要 `release()`**（含「根本没有判定」的那些：无 session list、无舞台会话、addressed subagent 路由），不是只有「判定为否」才撤。
- 理由：这个 claim 的产物是「没有东西」。占位一旦超出理由，在普通会话里就是静默少了一个控件，屏幕上看不出它与永久占用的区别。测试：`tests/model-seat.spec.ts` 的 "re-installs after a stand-down, because standing down is not a verdict"。
- 诊断经 `UiState.permissionSeatDiag` 上报，由 NTR 视图 tab 渲染。

## 4. 闸门的三条纪律

1. **闸门不可重入**：宿主 slot 注册表在 `slots.register` 与条目 disposer 内部**同步**发 `slots/changed`（`SlotCore.markDirty` → `mutateListeners` → `SlotRegistry.onMutate` → `ctx.emit`，cordis 同步派发），store 又在自己的 `mutate` 里同步回调闸门。一次装/撤求值会从自己的调用栈里重跑自己：嵌套求值证据相同，却会因 `installed.length === 0`（外层 install 尚未 push）再注册一条，其 `slots/changed` 再重入，形成无界注册堆。`runGate` 因此带 `gateRunning` 闸，嵌套运行直接丢弃（在飞那次已判定同一证据，下一个触发会重试）。
2. **持有的判定不是永久的**：投影行沉默时（宿主行不带 `agentPreset`），`session/chat-list` 判定是唯一事实源，而它原本每会话只问一次。没有 `agent-preset/selected` 帧宣告的切换（`remote` 面缺席或运行时不转发）会把会话永久钉在 NTR 模式。现行：行沉默且持有判定时按 `ACP_MODE_VERDICT_TTL_MS`（`src/client/index.tsx`，默认 2000ms）带节流地重问，并由一个自备定时器触发；重问经 `loadChatSessions(..., { settleVerdict: true })` 显式获准覆盖 frame 权威——frame 对作曲面读取仍然永远优先（宿主日志读可能比切换慢一格），闸门自己的重问是唯一例外。
3. **帧路径随服务迟到而补挂**：`remote.$on('agent-preset/selected')` 改由 `attach()` 解析（`internal/service` 重跑），本包先于网关加载时不再整页失去这条唯一活事实源。

## 代码索引

| 主题 | 位置 |
|---|---|
| 权限请求处理 | `src/bridge.ts` · `handlePermissionRequest` |
| 原生审批 | `src/bridge.ts` · `askNativeApproval` / `nativeOutcomeResponse` / `setApprovalRequester` / `approvalRouting` / `ledgerFallbackOf`；`src/index.ts` · `wireApproval` |
| fs 围栏 | `src/bridge.ts` · `handleFsWrite` / `guardFsPath`；`src/impl.ts` · `resolveFsPath` |
| ledger UI | `src/client/panel.tsx` · `permissionLedgerCard` |
| 权限座位 | `src/client/model-seat.tsx` · `createPermissionSeatClaim` |
