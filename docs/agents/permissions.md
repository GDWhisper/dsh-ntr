# 权限：agent 自治，宿主只接住

本文是 [AGENTS.md](../../AGENTS.md) 的展开层。核心：**agent 报什么就问什么，宿主不预先裁决**。

## 1. 映射

ACP `session/request_permission` 原样映射：选项列表 / allow-deny / tool call 详情都按 ACP 协议接住并回包。每一问都必须交给人——原生审批链在时进对话 composer，否则进设置页 ledger。插件没有任何本地代答开关（`permission: allow` / `reject` 与 `agent/set-permission` 已删除）：agent 自己决定要不要问，宿主不替它回答。

已删除、不要带回：`decidePermission` / `authorizeWrite` / `dshSessionPolicyOf` / `sandboxDenialMarker` / `wireAccessMode` / `setSessionPolicyResolver` / `DshSessionPolicy`。DSH 的 Access mode / sandboxPolicy 不参与 ACP 裁决。

**fs 围栏只有一道**：`AgentBridge.handleFsWrite` → `guardFsPath` → `resolveFsPath(session.cwd, [...allowedCwdRoots, session.cwd], …)`。越界即拒，错误文案由 `resolveFsPath` 产出。没有 escalation、没有一次性许可、没有方言 marker——DSH 的沙箱管不到 agent 自己的进程，第二道门只是幻觉。测试：`tests/bridge.spec.ts` 的 "fences fs/write_text_file by the workspace, and nothing else"。

**不向 agent 叙述边界**：每轮转发给 ACP 的 prompt 必须严格等于用户文本（`promptText`），严禁拼任何边界/策略句子。曾有一版 `policyNotice` 前缀，已按要求彻底移除，不要以「agent 不知道边界」为由重加。

## 2. 原生审批路由

**路由条件**：桥已拿到 requester 且会话有 `dshSessionId`（经 `AcpLlmAdapter` 起的聊天会话）时，必须调用宿主 `ctx.approval.request({ agent, toolName, signal })`，让审批出现在对话 composer 里。`dshSessionId` 只允许在 `BridgeManager.getOrCreateDshSession` 的两条分支（新建、released 后 resume）写入。

**降级**：两条路径都必须回落到 `PermissionLedger` + `permission/request` 广播，严禁让异常冒泡到 agent 的 turn。`askNativeApproval` 用原因区分（`LedgerFallbackReason`）：

| 原因 | 含义 | 期限 |
|---|---|---|
| `no-requester` | 无 approval 服务、`ctx.agents.get` 取不到、requester 抛错 | 设计内 ledger 路径；按 `permissionTimeoutMs` |
| `no-chat-session` | `/acp` RPC 会话，没有聊天 turn 可挂审计对 | 同上 |
| `unavailable` | 服务在、这一次失败 | 同上 |

`native-timeout` **已删除**：超时的 routed ask 不再改走 ledger（见 §2.1）。

## 2.1 超时是就地收场，不是转移

一问到点只有三种结局，**没有第四种**：

| 模式 | 到点行为 |
|---|---|
| `wait`（默认） | 不设期限，永远等下去 |
| `abort` | 拒绝这一问（`cancelled`） |
| `auto` | 按 agent 声明的 option **kind 优先级**代答，agent 继续执行 |

三档与 OmniTerm dev 的 `acp_perm_timeout_mode` 同名同义。**默认是 `wait`**：权限询问是**问人的**问题，
默认就该等人——卡片全程可见，没人会被丢下一个「它去哪了」的疑问。`abort` / `auto` 是想要有界回合
的部署**主动选**的档。

- **不转移**：早期版本在 native 窗口到点后「撤回」，再把同一问题改走 ledger。这条路已删。转移只买到一个「第二机会」，却把问题送到用户不在看的页面，几分钟后照样被取消——那既不是挂起也不是取消，是没人要的混合态。现在到点**就地收场**（`settleExpiredAsk`）。
- **`auto` 的选法**：`pickAutoOption`（`src/impl.ts`）按 kind 优先级 `allow_always → allow_once → reject_once → reject_always → 首个可选项`。ACP 的 `PermissionOption` 只有 `{optionId, name, kind, _meta?}`，**没有「默认选项」字段**，只能按 kind 挑；挑不出合法选项时降级 `abort`（不瞎猜、不永久挂起）。与 OmniTerm dev 的 `pick_auto_option` 同策略（`allow_always` 优先由用户 2026-09-21 拍板）。
- **只有一个等待窗口 `permissionTimeoutMs`**（默认 300_000，`0` = 不等待）：对话 composer 里的询问与 ledger 里的询问问的是同一个问题（「有人在吗」），所以共用一个答案。早期版本是两个窗口（`nativeApprovalTimeoutMs` / `permissionFallbackTimeoutMs`），它们把设置卡变成三个看不出关联的旋钮——用户看不出「三行是不是一套」，而且两处可以配出互相矛盾的值。**一个数字管两处**，卡片因此只剩两个控件。
- **定时器与人的答复赛跑**：native 窗口在 `requester(...)` 之前就 arm（`Promise.race([asked, deadline])`），所以**一张正常渲染出来、你只是还没点**的卡片同样会到点被拒。「宿主收了却不渲染」是这个期限**为什么存在**的理由，不是它的**触发条件**——从插件这一侧看，「人太慢」和「宿主没渲染」长得一模一样（`tests/bridge.spec.ts` 明写这句话）。写 UI 文案时别把它读成后者。
- **模式与窗口都在询问开始时读一次**（`askNativeApproval` 在 `requester(...)` 之前读 mode；ledger 路径在建条目时读）：已持定时器的询问不改口径，正在决定中的人不该被移动球门。
- **`wait` 不 arm 任何定时器**：「一直等」就是一直等，窗口配多少都一样。`wait` 是**唯一**能表达「永不到期」的档。
- **`permissionTimeoutMs: 0` = 不等待，且只属 `auto`**：请求到达即收场，**根本不问人**——native 路径不调 requester（composer 卡片只会闪一下就没了，问了也来不及答），ledger 路径不建条目、不广播 `permission/request`，两条路径都直接进 `settleExpiredAsk`。它之所以安全，正是因为 `auto` 是**代答**（按 option kind 优先级挑一个），agent 拿到答案继续走。
  **`abort` 档没有这一档**：同样的 0 在那里是**立刻拒绝**每一问，agent 在每个门口都停住——那不是超时，是墙。所以 `abort` 的时长轴从 30 秒起，任何落到 `abort` 的 0 一律抬到最短真实等待 30 秒（`normalizeApprovalWindow`：配置、状态文件、模式切换三条来路都走它）。「永不到期」由 `wait` 模式表达，不再是时长轴上的一档：同一件事两处各说一遍，用户只会怀疑自己漏配了什么。
- **旧配置里的 0 不是不等待**：旧的两个键（`nativeApprovalTimeoutMs` / `permissionFallbackTimeoutMs`）里 `0` 的旧义是「这一窗永不触发」，新义是「不等待」。旧 0 因此**迁移成 `wait` 模式 + 300_000 窗口**（`validateConfig` 的 `legacyNever`、`BridgeManager.loadPersistedAgents` 同规则）——否则一个无人值守的部署会从「一直等」静默变成「立即自动放行」。新键 `permissionTimeoutMs: 0` 则按新义执行（且只在 `auto` 档成立）。
- **到点必须留痕**：native 路径到点拒绝后没有 ledger 条目、没有聊天行，用户只会看到卡片凭空消失。因此 `settleExpiredAsk` 广播 `agent/notice` + `permission/expired`，`TurnStreamController` 把 `permission/expired` 折成对话里的一行说明（`no answer within Ns; refused` / `… answered "X" automatically, continuing`）。不等待时写 `not waited for` / `was not waited for`——「等了 0 秒」与「没等」不是一回事。
- **窗口与模式都是可设项**（`AcpPluginConfig`，`cordis.patch.yml` 里注释了默认值）：`permissionTimeoutMs`（等待时长，默认 300_000，`0` = 不等待）、`permissionTimeoutMode`（默认 `wait`）。旧的两个键**仍然被接受**，由 `validateConfig` 折叠进新键（新键在场时忽略旧键），所以老配置文件不会静默回到默认值。
- **两者都能在设置页热改**（§2.4）：`ui/approval-deadlines` 读、`ui/approval-deadlines-set` 写，覆盖值落 `agents.json` 的 `approvalDeadlines` 并压过 `cordis.patch.yml`。
- 原因必须在广播**之前**记进 `ledgerFallbacks`（`ledgerFallbackOf` 读）。`streamPrompt` 据此写聊天提示：设计内路径说「please approve in Settings」；降级路径必须说清为什么对话没展示这个问题（`unavailable` = 审批服务不可用）并带倒计时——否则「去设置页批准」读起来像一个选择，而它其实是 deadline。
- `approval` / `agents` 两个服务**严禁**写进 `src/index.ts` 的 `export const inject`（缺服务会让插件整体加载失败），只能 `ctx.get` + `ctx.inject(['approval','agents'], …)` 后补注册。
- `approvalRouted` 由 `agents/list` 只读上报（缺失报 `false`）。它是**能力上报，不是每次询问的承诺**：单条询问仍可能因 `unavailable` 或没有对话身份落到 ledger，所以浏览器**不据此隐藏**待处理卡片。

## 2.2 重连重放（未决询问不得只发一次）

`permission/request` **只在询问创建时广播一次**。之后才连上来的客户端（刷新页面、第二个标签页、SSE 断线重连）永远收不到它——而 ledger 询问的唯一答案入口就是设置页那张卡，于是「最需要它的客户端恰好看不到」。OmniTerm dev 用
`PermissionManager::pending_events()` + 连接时的 `PermissionsSynced` 标记帧堵住同一个洞，本插件照做：

- `AgentBridge.handlePermissionRequest` 建 ledger 条目时把 `toolCall` / `options` 一并存进条目（`PermissionLedger.create` 第三参）；没有 view 的条目不参与重放——重放一张渲染不出来的卡比不重放更坏。
- SSE 路由（`/api/acp/stream`）在 `stream/open` 之后、**订阅之后**取快照重放（`permissionReplayFrames`）：订阅后取快照，期间广播的询问会同时以实时帧和快照帧到达，客户端按 requestId 幂等折叠。
- 终帧 `permission/synced` 带**活集合**：断线期间已被解决的询问不在其中，客户端据此丢掉自己还挂着的陈旧卡片（否则 `respond` 只会换来 `unknown_request`）。
- 原生路由上的询问**不重放**：它们不广播任何帧，答案入口是客户端已经持有的 composer 接管。

测试：`tests/impl.spec.ts` 的 "replays only asks that carry a view"、`tests/store.spec.ts` 的 "re-establishes the pending asks on reconnect and prunes the stale ones"、`tests/bridge.spec.ts` 的 "lists the outstanding ledger asks for a reconnecting client"。

## 2.3 `session/cancel` 必须答复未决审批

ACP 规范的另一半：client 发 `session/cancel` 后**必须**以 `cancelled` 答复所有未决
`session/request_permission`。`AgentBridge.cancel` 因此在通知之后 `settlePermissions(session)`——
否则 agent 的工具调用会一直阻塞在一个永远不会到来的答复上，ledger 还会留着一张属于已结束回合的卡
（人再去点它只会得到 `unknown_request`）。这与 OmniTerm `AcpClient::cancel` →
`PermissionManager::cancel_all` 是同一条规则。`releaseAll` / `closeSession` 本来就 settle，
`cancel` 是漏的那一条。测试：`tests/bridge.spec.ts` 的 "answers a pending permission with
cancelled when the turn is cancelled"。

原生路由上的询问不受此影响（ledger 里没有条目）：它由 native 窗口到期**就地收场**
（`settleExpiredAsk`），composer 面板随之消失。

## 2.4 设置页热改一个窗口与一档到点行为

`permissionTimeoutMs` / `permissionTimeoutMode` 在 **NTR 设置 → 审批时限** 卡片里改，不用重启插件进程，也不用杀活动会话。卡片只有**两个控件**，和 OmniTerm dev 同形：一个到点行为（三档互斥按钮）+ 一根时长滑块。

**三层取值，优先级从高到低**：

| 层 | 位置 | 说明 |
|---|---|---|
| 覆盖值 | `agents.json` 的 `approvalDeadlines` | 设置页写的值；重启后仍然有效 |
| 部署基线 | `cordis.patch.yml` 的 `config` | 宿主入口在 `apply()` 里把**原始**值交给 manager（`setConfiguredApprovalDeadlines`）——`validateConfig` 已把默认值填满，分不出「文件写了 600000」和「文件没写、300000 是内置默认」，而卡片必须能区分：前者是重置按钮的去处，后者不是 |
| 内置默认 | `DEFAULT_TUNING`（300_000 / `wait`） | 两层都没说时的值 |

- **热应用**：`BridgeManager.applyDeadlineTuning` 改写自己持有的 tuning 并逐个调
  `AgentBridge.applyApprovalDeadlines`。两个字段因此不是 `readonly`——它们每次询问时读取，
  改写对之后的询问立即生效。**已启动的定时器不重排**：正在决定中的人不该被移动球门。
- **持久化**：写进 `agents.json`（与 `tagHalo` / `conversations` 同一个文件），每次启动重新过
  `validateApprovalDeadlines` / `validatePermissionTimeoutMode`——该文件用户可改，放一个越界值进去不能毒化期限与模式。
- **卡片必须说清两件事**，否则用户会在调一个不生效的数字：
  `configured[key]` 与生效值不同时提示「配置文件（cordis.patch.yml）里是 X，这里的值优先」并给重置按钮；
  模式的基线（`configuredMode`）同理，**挂在模式那一行**。
  **只有真的覆盖了才给重置按钮**——配置文件基线恰好等于生效值时也给一个
  「恢复配置文件的值」，那颗按钮什么都不会做（实测发现后修正）。
- **两个控件必须说成一套**：卡片写一句话把两者接上（「超过该时长仍未应答，将按上方所选的方式处理。」），
  否则用户面对两个控件只能猜它们是不是有关联——这正是三行版被骂「看不出关联」的原因。
- **卡片的文案有预算，不许解释机制**：模式一行说明写完当前档的动作就收，**不解释「为什么原来要转移」**——
  那段历史写进本文，不写进 UI。时长一行只写「等待时长」与它和模式的关系。
  `wait` 档下窗口不生效，此时**不画滑块**（读数写「一直等待」，说明改成「选择「一直等待」时不设超时时长。」），不能留着「等待时长」配一个永不触发的数字。
  措辞取**正式陈述**（「超过设定时间未应答，自动代替你选择一个选项让 agent 继续执行」），
  同一档的警告另起一条写「请确保你的 agent 值得信任，请谨慎选择」——两条说明不得说同一件事。
  文案纪律见 [ui.md §8](./ui.md)。
- **滑块的档位是刻度，不是可输入的数**：不等待 / 30 秒 / 1 分 / 5 分 / 15 分 / 30 分 / 1 小时 / 6 小时。
  「不等待」是**自动推进**那一档的刻度（它代答，agent 继续）；「超时中止」那一档的刻度从 30 秒起，没有「不等待」——
  否则每一问都在到达的瞬间被拒绝，agent 在每个门口都停住。「一直等待」**不在档位上**——它由模式表达，同一件事不在两处各说一遍。
  配置文件写的窗口若不在档位上（45 秒之类），**照原值运行**，卡片显示精确数字并把滑块停在最近的档位上——
  滑块不许谎报正在生效的数。
- 浏览器侧只乐观改生效数字，**宿主回包是权威**（写路由原样返回生效中的期限），失败即回滚。

测试：`tests/impl.spec.ts` 的 "gates the settings-page deadline write through the same range as the
config file" 与 "carries a legacy zero over as the wait mode, never as 不等待"、
`tests/register.spec.ts` 的 "carries the config file's approval deadlines into the
settings card"、`tests/bridge.spec.ts` 的 "edits an approval deadline live, persists it, and resets
to the config file"、"adopts a deadline the settings page writes while a session is live" 与
"a zero window settles the ask without asking anyone"、
`tests/acp-view.spec.ts` 的 `deadlineSliderIndex`（不等待是最左一档）、
`tests/store.spec.ts` 的 "reads the approval deadlines on resync and writes one back optimistically"。

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
| 超时收场 | `src/bridge.ts` · `settleExpiredAsk` / `TurnStreamController.expiredLine`；`src/impl.ts` · `pickAutoOption` / `AUTO_OPTION_KIND_PRIORITY` |
| 期限与模式热改 | `src/bridge.ts` · `approvalDeadlines` / `setApprovalDeadlines` / `setConfiguredApprovalDeadlines` / `applyDeadlineTuning` / `AgentBridge.applyApprovalDeadlines`；`src/impl.ts` · `validateApprovalDeadlines` / `validateApprovalDeadlineMs` / `validatePermissionTimeoutMode`；`src/index.ts` · `apply()` 的原始配置透传 |
| 期限 UI | `src/client/panel.tsx` · `ApprovalDeadlinesCard` / `DeadlineModeBlock` / `DeadlineSliderBlock` / `deadlineSliderIndex` / `modeText` / `deadlineText` / `approvalDeadlineFacts`；`src/client/store.ts` · `setApprovalDeadline` / `setApprovalTimeoutMode` / `resetApprovalDeadlines` |
| fs 围栏 | `src/bridge.ts` · `handleFsWrite` / `guardFsPath`；`src/impl.ts` · `resolveFsPath` |
| ledger UI | `src/client/panel.tsx` · `permissionLedgerCard` |
| 权限座位 | `src/client/model-seat.tsx` · `createPermissionSeatClaim` |
