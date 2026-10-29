# 权限：agent 自治，宿主只接住

本文是 [AGENTS.md](../../AGENTS.md) 的展开层。核心：**agent 报什么就问什么，宿主不预先裁决，也不替它回答**。插件只负责把每一问变成一张人能答的卡——卡片、期限与去留都握在插件自己手里。

## 1. 映射

ACP `session/request_permission` 原样映射：选项列表 / 名称 / 顺序 / allow-deny / tool call 详情都按 ACP 协议接住并回包。每一问都必须交给人：经插件自己的 `PermissionLedger` 广播成 `permission/request`，在对话 dock 或设置页镜像的可答复卡片上等人回答（无人值守部署显式选择 `auto` + `0` 时由插件按 option kind 代答，见 §2.1）。插件没有任何本地代答开关（`permission: allow` / `reject` 与 `agent/set-permission` 已删除）：agent 自己决定要不要问，宿主不替它回答。

**宿主审批链不参与**：`ctx.approval` / `ctx.agents` 不再是协作者，`wireApproval` / `askNativeApproval` / `approvalRouting` / `ledgerFallbackOf` 已删除。旧路由把问题交给一个黑箱：它可以收下 `ctx.approval.request` 却什么都不渲染，而默认 `wait` 没有期限，turn 就挂在完全不可见的地方（issue #2；实测 CodeBuddy 2.177.0 + 宿主审批提示关闭，只剩 agent 侧心跳）。插件这一侧无法区分「人答得慢」和「宿主没渲染」，所以出路只能是插件自己持有卡片与期限。旧形态、原因码与「不要重建」的纪律见 [retired.md](./retired.md)。

**宿主 approval policy 不再作用于 ACP 询问**：`ask` / `never` 只管宿主自己的工具；ACP 询问永远走插件这条管线。无人值守部署改用插件自己的 `auto` / `abort` 窗口（§2.1）。同理，DSH 会话日志里不再写 ACP 询问的 `approval/asked` / `approval/decided`，审计痕迹由插件 transcript 承载。这两个是**接受的代价**，不是缺陷；细节与理由见 [retired.md](./retired.md)。

已删除、不要带回：`decidePermission` / `authorizeWrite` / `dshSessionPolicyOf` / `sandboxDenialMarker` / `wireAccessMode` / `setSessionPolicyResolver` / `DshSessionPolicy`。DSH 的 Access mode / sandboxPolicy 不参与 ACP 裁决。

**工具名与理由由宿主派生**：`permissionToolName` 依次读 `toolCall.title` → 任意 `_meta` 键末段为 `toolName`（codebuddy 的 `_meta["codebuddy.ai/toolName"]` 就是实例）→ `kind` → `'tool call'`；`permissionAskReason` 从 `rawInput` 里挑一个具名标量（`command` / `cmd` / `path` / …），与工具名拼成一行并限长 240。两者只读 agent 自己声明的字段，不猜、不序列化整个对象。

**fs 围栏只有一道**：`AgentBridge.handleFsWrite` → `guardFsPath` → `resolveFsPath(session.cwd, [...allowedCwdRoots, session.cwd], …)`。越界即拒，错误文案由 `resolveFsPath` 产出。没有 escalation、没有一次性许可、没有方言 marker——DSH 的沙箱管不到 agent 自己的进程，第二道门只是幻觉。测试：`tests/bridge.spec.ts` 的 "fences fs/write_text_file by the workspace, and nothing else"。

**不向 agent 叙述边界**：每轮转发给 ACP 的 prompt 必须严格等于用户文本（`promptText`），严禁拼任何边界/策略句子。曾有一版 `policyNotice` 前缀，已按要求彻底移除，不要以「agent 不知道边界」为由重加。

## 2. 路由：ledger 是唯一管线

`AgentBridge.handlePermissionRequest` 对每一条询问建 `PermissionLedger` 条目（`auto` + `0` 的到达即收场除外，见 §2.1），随即用 `permissionRequestFrame` 广播一次 `permission/request`。条目同时保存 `view`（`PendingPermissionFields`），供重连重放（§2.2）；没有 view 的条目仍可被应答，只是无法重放。

**帧字段**：

| 字段 | 含义 |
|---|---|
| `requestId` | ledger 条目 id；`permission/respond` 用它 |
| `sessionId` | ACP session id |
| `dshSessionId?` | DSH 聊天会话 id；仅经 `AcpLlmAdapter` 起的会话有。`/acp` RPC 会话**没有** |
| `toolCall` | agent 发来的原始 `ToolCallUpdate`，不折叠 |
| `toolName` | 宿主派生的可读名字（`permissionToolName`） |
| `reason?` | 一行说明（`permissionAskReason`），没有就不带 |
| `options` | `{ optionId, name, kind }` 原样、原序 |
| `timeoutMode` | `wait` / `abort` / `auto` |
| `deadlineAt?` | epoch ms；`wait` 下缺席 |

**答案入口**：

- **有 `dshSessionId`**：`PermissionDock`（`src/client/permission-dock.tsx`）在 `conversation.input.dock` 上只渲染 `dshSessionId === 当前会话` 的询问，这是主入口。对话里的提示行（`TurnStreamController.permissionLine`）说「please answer the permission card above the composer」。
- **无 `dshSessionId`**（`/acp` RPC 会话）：没有对话可挂，询问留在设置页的跨会话镜像；提示行说「please approve in Settings」。
- 设置页镜像同时兜底显示其他会话的询问（包括有聊天身份的），所以任何一条未决询问都至少有一个可见的答案入口。

**答复**：`permission/respond`（`optionId` 缺席 = 取消）→ `PermissionLedger.respond` → 广播 `permission/resolved`。对已结算条目再答是 `unknown_request`，不是第二次机会。

**没有宿主仲裁**：`no-requester` / `no-chat-session` / `unavailable` / `native-timeout` 不再是现行路径分类；`agents/list` 也只剩 roster，不再上报 `approvalRouted`（以及更早的 `accessModeRouted`）。历史见 [retired.md](./retired.md)。

### 2.1 超时是就地收场，不是转移

一问到点只有三种结局，**没有第四种**：

| 模式 | 到点行为 |
|---|---|
| `wait`（默认） | 不设期限，永远等下去 |
| `abort` | 拒绝这一问（`cancelled`） |
| `auto` | 按 agent 声明的 option **kind 优先级**代答，agent 继续执行 |

三档与 OmniTerm dev 的 `acp_perm_timeout_mode` 同名同义。**默认是 `wait`**：权限询问是**问人的**问题，默认就该等人——卡片全程可见，没人会被丢下一个「它去哪了」的疑问。`abort` / `auto` 是想要有界回合的部署**主动选**的档。

- **不转移**：早期版本在 native 窗口到点后「撤回」，再把同一问题改走 ledger；这条连同 native 路由一起退役了。转移只买到一个「第二机会」，却把问题送到用户不在看的页面——那既不是挂起也不是取消，是没人要的混合态。现在到点**就地收场**：`announceExpiredAsk` 算出答案，`permissions.respond` 结算**同一个** ledger 条目（`settleExpiredAsk` 只用于 `auto` + `0` 的到达路径）。
- **`auto` 的选法**：`pickAutoOption`（`src/impl.ts`）按 kind 优先级 `allow_always → allow_once → reject_once → reject_always → 首个可选项`。ACP 的 `PermissionOption` 只有 `{optionId, name, kind, _meta?}`，**没有「默认选项」字段**，只能按 kind 挑；挑不出合法选项时降级 `abort`（不瞎猜、不永久挂起）。与 OmniTerm dev 的 `pick_auto_option` 同策略（`allow_always` 优先由用户 2026-09-21 拍板）。
- **只有一个等待窗口 `permissionTimeoutMs`**（默认 300_000，`0` = 不等待）：对话 dock 卡与设置页镜像问的是同一个问题（「有人在吗」），所以共用一个答案。早期版本是两个窗口（`nativeApprovalTimeoutMs` / `permissionFallbackTimeoutMs`），它们把设置卡变成三个看不出关联的旋钮——用户看不出「三行是不是一套」，而且两处可以配出互相矛盾的值。**一个数字管两处**，卡片因此只剩两个控件。
- **定时器与人的答复赛跑**：条目一建立就 arm，所以**一张正常渲染出来、你只是还没点**的卡片同样会到点被拒。期限存在的理由是**无人值守的会话不该无限挂起**，不是「宿主没渲染」的探针——从插件这一侧看，「人太慢」和「没人看」长得一模一样。写 UI 文案时别把它读成前者。
- **模式与窗口都在询问开始时读一次**：已持定时器的询问不改口径，正在决定中的人不该被移动球门。`deadlineAt` 也在同一时刻算出并进入帧、聊天行与定时器——慢读者不能把期限读长。
- **`wait` 不 arm 任何定时器**：「一直等」就是一直等，窗口配多少都一样；`wait` 下 `deadlineAt` 也不进帧。`wait` 是**唯一**能表达「永不到期」的档。
- **`permissionTimeoutMs: 0` = 不等待，且只属 `auto`**：请求到达即收场，**根本不问人**——不建 ledger 条目、不广播 `permission/request`，直接走 `settleExpiredAsk`，只留下 `agent/notice` + `permission/expired` 的痕迹。它之所以安全，正是因为 `auto` 是**代答**（按 option kind 优先级挑一个），agent 拿到答案继续走。
  **`abort` 档没有这一档**：同样的 0 在那里是**立刻拒绝**每一问，agent 在每个门口都停住——那不是超时，是墙。所以 `abort` 的时长轴从 30 秒起，任何落到 `abort` 的 0 一律抬到最短真实等待 30 秒（`normalizeApprovalWindow`：配置、状态文件、模式切换三条来路都走它）。`wait` 忽略窗口本身（0 也照等）。「永不到期」由 `wait` 模式表达，不再是时长轴上的一档：同一件事两处各说一遍，用户只会怀疑自己漏配了什么。
- **旧配置里的 0 不是不等待**：旧的两个键（`nativeApprovalTimeoutMs` / `permissionFallbackTimeoutMs`）里 `0` 的旧义是「这一窗永不触发」，新义是「不等待」。旧 0 因此**迁移成 `wait` 模式 + 300_000 窗口**（`validateConfig` 的 `legacyNever`、`BridgeManager.loadPersistedAgents` 同规则）——否则一个无人值守的部署会从「一直等」静默变成「立即自动放行」。新键 `permissionTimeoutMs: 0` 则按新义执行（且只在 `auto` 档成立）。
- **到点必须留痕**：卡片消失后，对话里不能什么都不说。`announceExpiredAsk` 广播**恰一条** `agent/notice` + **恰一条** `permission/expired`；定时器路径的 `permissions.respond` 再广播 `permission/resolved`（`auto` + `0` 没有 ledger 条目，也就没有最后这一帧，但两条留痕照发）。`TurnStreamController` 把 `permission/expired` 折成对话里的一行说明（`no answer within Ns; refused` / `… answered "X" automatically, continuing`）。不等待时写 `not waited for` / `was not waited for`——「等了 0 秒」与「没等」不是一回事。
- **窗口与模式都是可设项**（`AcpPluginConfig`，`cordis.patch.yml` 里注释了默认值）：`permissionTimeoutMs`（等待时长，默认 300_000，`0` = 不等待）、`permissionTimeoutMode`（默认 `wait`）。旧的两个键**仍然被接受**，由 `validateConfig` 折叠进新键（新键在场时忽略旧键），所以老配置文件不会静默回到默认值。
- **两者都能在设置页热改**（§2.4）：`ui/approval-deadlines` 读、`ui/approval-deadlines-set` 写，覆盖值落 `agents.json` 的 `approvalDeadlines` 并压过 `cordis.patch.yml`。

### 2.2 重连重放（未决询问不得只发一次）

`permission/request` **只在询问创建时广播一次**。之后才连上来的客户端（刷新页面、第二个标签页、SSE 断线重连）永远收不到它——而 ledger 条目（对话 dock 或设置页镜像）是它唯一的答案入口。OmniTerm dev 用 `PermissionManager::pending_events()` + 连接时的 `PermissionsSynced` 标记帧堵住同一个洞，本插件照做：

- `AgentBridge.handlePermissionRequest` 建 ledger 条目时把**完整的 `PendingPermissionFields`**（`dshSessionId` / `toolCall` / `toolName` / `reason` / `options` / `timeoutMode` / `deadlineAt`）存进条目（`PermissionLedger.create` 第三参）；没有 view 的条目不参与重放——重放一张渲染不出来的卡比不重放更坏。
- SSE 路由（`/api/acp/stream`）在 `stream/open` 之后、**订阅之后**取快照重放（`permissionReplayFrames` → `permissionRequestFrame`）：订阅后取快照，期间广播的询问会同时以实时帧和快照帧到达，客户端按 requestId 幂等折叠。
- **重放帧与实时帧逐字节一致**：`permissionRequestFrame` 是唯一 builder。`dshSessionId` 尤其不能丢——对话 dock 按它过滤，丢了这个字段，重连的客户端会**静默看不到**那张卡；`toolName` / `deadlineAt` 同理。
- 终帧 `permission/synced` 带**活集合**：断线期间已被解决的询问不在其中，客户端据此丢掉自己还挂着的陈旧卡片（否则 `respond` 只会换来 `unknown_request`）。
- 所有携带 view 的未决询问都走同一条重放路径（不再有「原生路由不广播、不重放」的例外）。

测试：`tests/impl.spec.ts` 的 "replays only asks that carry a view, as their original request frame"、`tests/store.spec.ts` 的 "re-establishes the pending asks on reconnect and prunes the stale ones"、`tests/bridge.spec.ts` 的 "replays a pending ask with exactly the live frame fields"。

### 2.3 取消、撤回与关闭顺序

- **`session/cancel` 必须答复未决审批**：ACP 规范要求 client 发 `session/cancel` 后以 `cancelled` 答复所有未决 `session/request_permission`。`AgentBridge.cancel` 因此在通知之后 `settlePermissions(session)`——否则 agent 的工具调用会一直阻塞在一个永远不会到来的答复上，ledger 还会留着一张属于已结束回合的卡（人再去点它只会得到 `unknown_request`）。这与 OmniTerm `AcpClient::cancel` → `PermissionManager::cancel_all` 是同一条规则。`releaseAll` / `closeSession` 本来就 settle，`cancel` 是漏的那一条。测试：`tests/bridge.spec.ts` 的 "answers a pending permission with cancelled when the turn is cancelled"。
- **ACP 请求的 `signal` 撤回**：`handlePermissionRequest` 监听请求自带的 `signal`（agent 撤回询问，或连接断开）。abort 时 `permissions.respond(requestId, { outcome: 'cancelled' })`，走正常的 `permission/resolved` 广播并把 listener 摘掉；答复之后再 abort 是 no-op，不会二次结算。测试：`tests/bridge.spec.ts` 的 "settles a signal-aborted ask as cancelled and drops its card" 与 "removes the abort listener once the ask is answered"。
- **关闭先 settle，再等 `session/close`**：`closeSession` 在 await `session/close` **之前**调用 `settlePermissions`——agent 可能正阻塞在一个未答询问上，先答复它，关闭才不会被它无限期拖住。`session/close` 本身也不无限等：请求与 `SESSION_CLOSE_TIMEOUT_MS`（5s）race，输掉就把它留在原地，本地拆除照常完成——卡死的 agent 不能靠拖住关闭让 stop 或看门狗回收挂住。测试：`tests/bridge.spec.ts` 的 "settles outstanding asks before waiting for session/close"。

### 2.4 设置页热改一个窗口与一档到点行为

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
  那段历史写进 [retired.md](./retired.md)，不写进 UI。时长一行只写「等待时长」与它和模式的关系。
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

**对话 dock 卡**（`src/client/permission-dock.tsx` · `PermissionDock`；注册在 `src/client/index.tsx` 的 `conversation.input.dock`）：主入口，session-scoped，排在 composer 卡上方。槽位本身是整列宽，卡片套宿主 InputBar 的宽度公式（`--dsh-composer-side-clearance` + `--dsh-composer-card-max-width`），与输入框同宽居中。

- **过滤**：`permissionsForSession(ui.permissions, dshSessionId)` 只留 `dshSessionId` 等于当前会话的询问。它没有 ACP 模式闸门——帧集合本身就是闸门：普通对话只有在真的有待答询问时才出现这张卡。
- **选项原样**：按钮按 agent 的 `name` 与顺序渲染，`kind` 不显示（「Always Allow」也照原名出现）。另有一个**取消**键，不带 `optionId`；宿主把它转成 `cancelled`。
- **键盘**：没有全局 Enter/Esc 处理器；这些是普通的可聚焦按钮，composer 拥有键盘。
- **倒计时**：`deadlineRemainingLabel`（`src/client/store.ts`）每秒 tick，显示 `12s` / `1m 30s` 这类读数；`wait` 或没有 `deadlineAt` 时不显示；过了期限显示「已超时」而不是负数（期限已经被宿主兑现，倒数会谎称它还在）。
- **失败就地显示**：`respondPermission` 会写 store notice 并 rethrow；dock 在卡内用 `role="alert"` 显示错误，不把失败留在用户没打开的设置页。设置页侧吞掉 rethrow（notice 已经写了）。
- **堆叠**：多条询问按**到达顺序、最旧在上**堆叠；容器由 CSS 限高（`min(38vh, 320px)`）并滚动，一串询问不会把 composer 顶出屏幕。
- **无聊天身份**：永不进入 dock；它们只出现在设置页镜像。

**设置页镜像**（`src/client/panel.tsx` · `permissionLedgerCard`）：只要 `ui.permissions` 非空就渲染可答复的跨会话列表，提示语说明「对话打开时在那边的卡片上回答；这里兜底显示其他会话的询问」。它不再是唯一入口，也不是降级路径——`approvalRouted` / `fellBackFromConversation` 已删除，`agents/list` 不再带审批能力旗标。

**设置页没有权限开关**：agent 卡不再提供「权限策略 / 要不要问人」。要不要问由 agent 自己的 mode 决定，问了就一定会到人面前（显式选择 `auto` + `0` 的部署除外，它按 §2.1 代答）。

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
| 权限请求处理 | `src/bridge.ts` · `handlePermissionRequest` / `permissionToolName` / `permissionAskReason` |
| 对话审批卡 | `src/client/permission-dock.tsx` · `PermissionDock`；`src/client/index.tsx` · `conversation.input.dock` 注册；`src/client/store.ts` · `permissionsForSession` / `deadlineRemainingLabel` |
| 重连重放 | `src/impl.ts` · `permissionRequestFrame` / `permissionReplayFrames` / `PermissionLedger.pendingViews`；`src/index.ts` · `/api/acp/stream` |
| 超时收场 | `src/bridge.ts` · `announceExpiredAsk` / `settleExpiredAsk` / `TurnStreamController.expiredLine` / `permissionLine`；`src/impl.ts` · `pickAutoOption` / `AUTO_OPTION_KIND_PRIORITY` |
| 期限与模式热改 | `src/bridge.ts` · `approvalDeadlines` / `setApprovalDeadlines` / `setConfiguredApprovalDeadlines` / `applyDeadlineTuning` / `AgentBridge.applyApprovalDeadlines`；`src/impl.ts` · `validateApprovalDeadlines` / `validateApprovalDeadlineMs` / `validatePermissionTimeoutMode`；`src/index.ts` · `apply()` 的原始配置透传 |
| 期限 UI | `src/client/panel.tsx` · `ApprovalDeadlinesCard` / `DeadlineModeBlock` / `DeadlineSliderBlock` / `deadlineSliderIndex` / `modeText` / `deadlineText` / `approvalDeadlineFacts`；`src/client/store.ts` · `setApprovalDeadline` / `setApprovalTimeoutMode` / `resetApprovalDeadlines` |
| fs 围栏 | `src/bridge.ts` · `handleFsWrite` / `guardFsPath`；`src/impl.ts` · `resolveFsPath` |
| 设置页镜像 | `src/client/panel.tsx` · `permissionLedgerCard` |
| 权限座位 | `src/client/model-seat.tsx` · `createPermissionSeatClaim` |
