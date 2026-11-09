# 状态与持久化

本文是 [AGENTS.md](../AGENTS.md) 的展开层。运行时唯一落盘点是 `~/.dsh/dsh-ntr/`。

## 1. 落盘位置

`pluginStateDir()`（`~/.dsh/dsh-ntr`）下只有三样东西：

- `agents.json` —— agent 注册表 + 默认 agent + 每会话选择 + 每聊天会话的会话记录（`chatSessions`，见 §3.1）+ 外部子代理生命周期记录（`subagents`，`dshSessionId → SubagentRecord[]`：只在状态迁移落盘、每会话 200 条上限、加载时按 `chatSessions` / `conversations` prune 孤儿键、显式关闭 / force reset 立即删键，见 [protocol.md §6.3](./protocol.md)）+ 插件私有偏好（`tagHalo`，经 `ui/tag-halo` RPC 读写；`sessionTitlePrefix`，经 `ui/session-title-prefix-set` 读写，是设置页「对话外观」挑的标题前缀开关（默认开），见 [architecture.md §2.1](./architecture.md)；`approvalDeadlines`，经 `ui/approval-deadlines-set` 读写，见 [permissions.md §2.4](./permissions.md)；`idleRelease`，经 `ui/idle-release-set` 读写，是设置页「进程管理」挑的空闲释放窗口，见 [protocol.md §5](./protocol.md)）
- `model-catalog.json` —— 模型目录 + agent 最近一次声明的斜杠命令 + agent 的 fork 能力位（最后已知，见 §3.2）
- `workspaces/` —— 默认执行工作区

**严禁**再往 `~/.dsh` 根丢 `acp-*.json` 或 `acp-workspaces/`，也严禁把新文件塞在那个根上。`~/.dsh` 里是宿主的 `sessions/`、`storages/`、`skills/`、`profiles/`、凭据；插件文件混在里面会被用户和 AI 当成宿主配置去读、改、删。命名沿用宿主「按拥有者开子目录」的约定（`~/.dsh/skills/<owner>`、`~/.dsh/dsh-runtimes/<owner>`）。

**重定向**：位置一律经 `pluginStateDir()` 解析，`DSH_NTR_STATE_DIR` 可覆盖。派生的老路径必须从它反推（`legacyStatePaths` 用 `dirname(pluginStateDir())`），不能重新拼 `~/.dsh`——否则一次带覆盖的测试运行会去读写（并迁移）真实的用户家目录。测试里设置了 `DSH_NTR_STATE_DIR` 的，`getStoragePath` / `getCatalogStoragePath` 的 runner 守卫必须放行（守卫是保护真实家目录，不是禁用持久化）。

**迁移**：`migrateLegacyState` 启动时把老位置搬进新目录，只搬本插件自己创建的那三个东西；目标已存在则不动（用户在新位置改过的状态不被陈旧文件覆盖）；失败也留得下老文件可读（`legacyFallback`）。工作区目录用 rename 而非 copy。

**迁移必须成对**：搬目录与改写 agent 里记录的绝对路径是一件事。`cwd` / `allowedCwdRoots` 原样存盘，而 `resolveSessionCwd` 对不存在的 cwd 直接 `bad_cwd`——只搬目录不改写，每个已保存 agent 下次启动就失败。`rewriteLegacyWorkspaceRoots` 负责改写，且**必须回写磁盘**（`loadPersistedAgents` 改了就要 `persistAgents()`），否则纠错只活在内存，磁盘上仍是死路径。

## 2. agent 注册表与校验

- 宿主端在 `validateAgentDef`（`src/impl.ts`）严格校验 `command` / `id` / `args` / `permission` 等字段，并自动施加安全工作区限制（`allowedCwdRoots`）；`saveAgent` 持久化前同样施加，严禁绕过。
- 默认工作区必须取 `defaultAgentWorkspace()`（`~/.dsh/dsh-ntr/workspaces`）并去重 roots。**严禁**把 `process.cwd()` 塞进 `allowedCwdRoots`——宿主启动目录可能是 `$HOME`，等于放开整个家目录。
- `def.cwd` 只是**兜底**（`/acp` RPC 会话 + 宿主未上报工作区的聊天会话）；聊天会话实际 cwd 取 DSH 会话自己的工作区（见 [architecture.md §4](./architecture.md)）。
- `validateAgentDef` **重建返回对象**，新字段不纳入会被静默剥离；`loadPersistedAgents` 每次启动会用它重校验旧配置，所以 agent 级新字段必须 optional。`validateConfig` 只负责编排 agents 数组。
- 默认启动命令预设存在两份手拷贝：`AGENT_PRESETS`（`src/bridge/state-paths.ts`）与 `DEFAULT_KNOWN_PRESETS`（`src/client/store.ts`），改其一必须同步另一处（无类型系统强制）。
- `mcpServers`（agent 级，可选）是**插件自己的归一形状**（`AcpMcpServerDef`）：每条必带 `name` 与 `transport`（`stdio` / `http` / `sse`），stdio 带 `command`（可选 `args` / `env`），http/sse 带 `url`（可选 `headers`）。它**不是** ACP 线格式：线格式的 stdio 变体**没有** `type` 字段（手写线格式的条目会被 agent 静默丢弃 —— 实测），所以归一形状给每条一个显式判别符，线格式的转换集中在 `src/bridge/mcp.ts` 的 `toAcpMcpServers`。`acp` 传输（agent 经 `mcp/message` 回调客户端）在校验期拒绝：稳定版 ACP SDK 的客户端侧没有这个方法，也没有 agent 声明 `mcpCapabilities.acp`。
- **`mcpServers` 只校验、不改形状**（`validateMcpServers` 原样返回用户写的条目）。设置页把它当 JSON 文本持有，并拿「将要送出的」与「已存的」比：宿主若替它补默认值（`args: []` / `env: {}`）或重排字段，那张卡就会永远判脏、每次保存都重启 agent。同理，条目里的 `name` 不得重名（它决定 agent 侧工具命名空间 `mcp__<name>__<tool>`）。
- **宿主侧 MCP 不经这条路**。宿主自己的 MCP 桥（`@deepseek-ai/dsh-mcp-client`）把工具注册进 `ctx.tools`，那是宿主模型面的工具，与 agent 进程内的 MCP 无关；插件既读不到那批服务器的配置（宿主不暴露可读服务），也无法把宿主 MCP 暴露给 agent（见 [architecture.md §5](./architecture.md)）。`mcpServers` 只是**额外**追加：agent 自己配置的 MCP 服务器照旧由 agent 读自己的配置文件。

### 2.1 运行时进程归属（A1）

| 结构 | 键 | 归属 | 不变量 |
|---|---|---|---|
| `BridgeManager.bridges` | `bridgeKey(agentId, scope)` | 进程 | 非 A1 = 裸 `agentId`（一个 agent 一个进程）；A1 = `agentId\0<kind>[:token]`（一个 DSH 会话 / 一个 `/acp` token / 一次探测一个进程）。同一个键只有一个 `AgentBridge`。 |
| `BridgeManager.bridgeScopes` | 同一个复合键 | 进程 | 键 → `BridgeScope` 的伴生状态，**只用测试与诊断**：生产代码 1 处声明、1 处写入、4 处删除，没有消费者；唯一读取方是 `tests/bridge.spec.ts` 的 3 处断言（`agent/delete` 与 `stopAgent` 比对 `bridgeScopes.size` 与 `bridges.size`）。判定作用域的唯一权威是 `bridges` 的复合键与 `bridgeKey`。 |
| `BridgeManager.stoppingAgents` | `agentId` | agent | 停止中的重入计数。>0 时 `bridgeFor` 拒绝新建、已存在 holder 拒绝外借（`agent_stopping`）；归零后才允许下一条消息新建进程。**消息不排队**。 |
| `BridgeManager.noticedBridgeFailures` | `AgentBridge` 对象 | 进程 | 启动失败通知的去重表（值为文本）。同一 holder 同一失败文本只发一次 `agent/notice`；holder 被回收后条目随 WeakMap 消失。 |
| `AgentBridge.pendingPrompts` | ACP 会话 id | 进程 | 未结算的 `session/prompt`，**按会话 id 计数**（同一会话可重入）。请求发出前加一、响应或失败 `.finally` 减一，归零删键。两套读数：`hasActiveWork()` 默认严格计数含已 `closed` 会话，`pendingPromptsOnServableSessions()` 只数仍存在于 `sessions` / `released` 的 id，供空闲释放。 |
| `BridgeManager.dshSessionMap` | `${dshSessionId ?? 'ephemeral'}:${agentId}` | 会话 | DSH 会话 → `LiveSession` 的插件地址。键含 agent（同一 DSH 会话换 agent 时不让旧记录冒充新绑定）；匿名 `/acp` 回合用 `ephemeral` 前缀。 |
| `BridgeManager.turnStreams` | `dshSessionId` | 会话 | 在飞分段流的控制器。清理按会话 id / `sessionIdsOf` 选中的集合，不做 agent 级连带清除。 |

- 模型目录、命令缓存、fork 能力位、`exposedModels` 仍是 **per-agent** 状态（`agentCatalog` / `forkCaps`）：会话换了进程不换这些事实源。
- 权限询问与 transcript 是 **per-session**：`PermissionLedger` 按 ACP 会话 id、transcript 按 DSH 会话 id。
- `AgentBridge.sessions` / `AgentBridge.released` 是 **per-process**：一个 holder 只装它自己的会话。`sessionIdsOf` 把这两个集合合成该 holder 的会话 id 集合，用于 turn stream 清理与兄弟会话阻塞判定（[protocol.md §6.1](./protocol.md)）。
- 空闲释放按 holder 计时（`releaseIfIdle`）；A1 下一个 CodeBuddy 会话的进程释放不影响其他会话进程，`dshSessionMap` 也不删——下一条消息按 binding 恢复。
- **已知残余风险（空闲释放 × 已关闭会话的待答请求）**：空闲释放用放宽口径（`hasActiveWork(false)`），已从 `sessions` 删除的会话上未结算的 `session/prompt` 不钉住进程。计时到点后 `releaseAll` 杀掉子进程，该请求以拒绝收场，`streamPrompt` 的 `.finally` 再 prune。若 agent 在进程死后才回应这条已被停止的 prompt，迟到的结算变成连接错误。取消结算途中的请求仍阻止释放，所以「按停止得到 `cancelled` 而不是 `error`」不变。窗口默认 30 分钟，`idleTimeoutMs: 0` 表示永不释放。这条代价是为满足 [AGENTS.md 约束 19](../AGENTS.md)（坏 agent 不得让进程永久常驻）接受的。
- **已决策取舍（不排除关闭在途的会话）**：`closeSession` 先置 `session.closed = true`，等 `session/close` 返回后才从 `sessions` 删除。这段窗口里该会话仍被 `pendingPromptsOnServableSessions` 算作可服务，其待答请求仍阻止空闲释放。最坏只把释放推迟一个 `SESSION_CLOSE_TIMEOUT_MS`（5 秒），不影响语义与正确性。**决定不改**：排除 `closed` 会让空闲释放在关闭在途时提前杀进程，可能重新破坏「按停止得到 `cancelled` 而不是 `error`」；代价与收益不对等。

## 3. 会话选择持久化

一个 DSH 聊天会话对它的 ACP agent 做的全部选择（`agentId` + `modelId` + `effort` + `mode` + `extraConfigs`）记在 `AcpConversationChoice`（`src/protocol.ts`），由 `BridgeManager.chatAgentIntent` 持有并持久化到 `agents.json` 的 `conversations` 键（`persistAgents` / `loadPersistedChoices`）。

- **严禁**只存内存 Map 或只写进 `LiveSession`：活会话在第一条消息之前根本不存在，而「对话前选模型」正是要在这个窗口里表达。
- **应用时机**：`applyChatChoice` 必须在 `createSession`（首轮建会话）与 `getOrCreateDshSession` 的 resume 分支各调一次。`session/new` 与 `session/load` 回的都是 agent 自己的默认值，不补这一步就是「选了 A 却跑 B」，且只从第二条消息才生效。同样两条路径还必须调 `lockChatAgent`，锁与 pick 在同一条记录里（见 [architecture.md §7](./architecture.md)）。
- **失效 model 必须拦截，严禁回落**：发送前 `staleModelChoice` 用会话**最新** `configOptions` 校验（agent 发布了**非空** choices 却不含该值即命中；没有选择器 / choices 为空时无从校验，保留原有 best-effort；多个 `category:'model'` 且没有显式 `model` id 时视为选择器歧义，同样放行）；命中就以 `model_unavailable` 失败，**不发送 prompt**，并保留 pick——芯片与 picker 继续指着用户选的值，用户改选后才能继续。首轮零输出照常回滚锁。`applyChatChoice` 对失效 model 只跳过应用、**不删 pick、不镜像成别的模型**；活会话上的 `setChatSessionModel` 直接拒绝失效值（不写记录）。失效 **effort** 仍按旧策略：经 `dropStalePick` → `patchChatChoice` 从记录删除并广播一次 `agent/notice`（它不决定用哪个模型）；该通知进入设置页「运行日志」，不占顶部横幅。`exposedModels` 里的失效值保留（模型回来时仍算已选）。
- **请求路径**：`syncConversationRoute` 把 pick 的 **model 半**写进 `routeBindingRegistry().conversations`（`modelId ?? agentId`），否则 guard 的改写只拿到裸 agent id，对话前选的变体会被静默丢掉。该函数**只增不减**：没有 pick 的会话保留 turn 路径 pin 的「实际服务过它的 agent」，删掉会让回放默认 provider。
- **切 agent 清空派生选择**（仅锁定之前）：首轮前 `bindChatAgent` 在 agentId 变化时丢掉 `modelId` / `effort` / `mode` / `extraConfigs`——它们是上一个 agent 的词汇（变体来自它的 catalog、等级来自它的 `thought_level`、模式 id 来自它的 `session/set_mode` 列表、额外项来自它的 configOptions），带过去就是让新 agent 收到它从没提供过的值。同一 agent 重复绑定则保留。
- **切 model 清空 effort（无活会话可校验时）**：`thought_level` 在部分 agent 上是模型级词汇（opencode 只为带 variants 的模型发布它），上一个模型的等级不是新模型的。`setChatSessionModel` 在模型真的改变、且该会话没有活会话（只剩 released 行或什么都没有）时，经 `patchChatChoice` 把 `effort` 一并清掉并清空 `LiveSession.reasoningEffort`；客户端的乐观 `writeChoice` 按同样的意图预演（活会话保留、否则清空），最终以宿主 `session/chat-list` 回读为准；否则首个会话前芯片会一直显示上一个模型的等级。有活会话时保留 pick，由 `alignSessionConfig` 用**切换后**返回的 `configOptions` 判断：新模型没有该轴、或 choices 不含该值，就 `dropStalePick` + 一次 `agent/notice`。同一模型重复选择不算切换。
- 全部经 `patchChatChoice` 这一个入口写，**严禁在某个 setter 里手抄字段清单**——`mode` 正是这样漏掉的：四个控件三个持久化，唯独它每次重启回到 agent 初始模式。
- **读取面**：`session/chat-list` 回 `choice`，`AcpStore.chatChoice` 落状态；`describeRoute` 活会话优先、pick 兜底。composer 的 model / 思考 chip 不能以 `bound !== undefined` 为渲染条件（那是「对话前无法选择」的直接成因），改为 `routed`（活会话 **或** pick **或** `chatBoundAgent` **或** 插件默认 agent）再加各轴自己的条件。高级底座的当前值读 `advancedOptions(catalog, choice)`：`choice.extraConfigs` 覆盖 `catalog.extras[].currentValue`，且只在该 choice 属于 catalog 的 agent 时生效。
- **显示的默认值就是首轮要跑的值**：没有 pick 的会话，composer 显示 `catalog.currentModel` / `reasoning.defaultEffort` / `catalog.mode.currentValue` / `extras[].currentValue`；`session/new` 回的是 agent 自己的默认值，两者可能不同。`getOrCreateDshSession` 的 create 路径必须在 `createSession` **之前**捕获显示值（`displayedChatDefaults`），在新会话提供这些值时写成该会话的 pick（`seedChatChoiceFromCatalog`：只补缺失字段，显式 pick 永远优先；新会话不再提供的值跳过，由 `absorbCatalog` 把显示纠正为实际值），再 `applyChatChoice`。**mode 与 model / effort 同权**：`catalog.mode.currentValue` 可能是同一 agent 别的会话抬上来的值，漏掉它就会出现「下拉写着 Bypass Permissions、首轮跑 Always Ask」；`session/new` 不返回 `modes` 的 agent（opencode）按 best-effort 照发 `session/set_mode`。`streamPrompt` 记录 `session.modelId` 时也要用 pick 的 variant / 会话自报的模型，**严禁**写回裸 agent id——裸 id 会让芯片回落到 agent 级 catalog，被同一 agent 的其他会话改掉。`reasoning.defaultEffort` 只在路由模型与 `catalog.currentModel` 一致（或没有显式模型选择 / 裸 agent 路由）时才算这条会话的显示值；`seedChatChoiceFromCatalog` 用同一条件，模型切换后的首轮因此跑新模型自己的默认等级，而不是把旧目录值写成 pick。
- **不移植 agent 级偏好层**：agent 级默认已由 `agent/catalog` 的 `reasoning.defaultEffort` 与自报 `currentValue` 表达，再加一层会造出「用户没选过却以为选过」的第三种事实源。

### 3.1 会话记录持久化（`chatSessions`）

聊天绑定的会话记录持久化在 `agents.json` 的 `chatSessions` 键（`persistedChatSession`，`src/bridge/shape.ts`；`loadPersistedChatSessions`，`src/bridge/manager.ts`）。宿主重启把每条记录以 **released** 复原进 `dshSessionMap` 与**它自己的** chat holder 的 released map（`AgentBridge.parkReleased`）——A1 下每条记录一个 holder，不同会话不共享进程槽。进程死了但 agent 侧会话还在，`session/load` 照常恢复。这是「released ≠ 销毁」在进程边界上的落点（约束 10）：没有它，重启后释放横幅直接消失、下一条消息还会静默新开一条没有上下文的会话。

- **只落身份与显示镜像**（`sessionId` / `acpSessionId` / `agentId` / `dshSessionId` / `cwd` + `title` / `modelId` / `reasoningEffort` / `modes` / `usage` / `hasHistory`）。**不落 transcript 与 `configOptions`**——两者都由 agent 在 `session/load` 时回放/带回；重启后到恢复前的空缓冲由 `hasHistory` 说明「历史待回放」（[ui.md §5](./ui.md)），不写「还没有消息」。
- **写点**：`getOrCreateDshSession` 的建/恢复分支、`forgetDshSession`（closed 销毁即删盘）、以及 `AgentBridge` 的 `onSessionsDirty` 回调（`releaseAll` / `doResumeSession`——release 时 transcript 还在，`hasHistory` 正是在那里算的：`hasHistory || since(0).length > 0`）。
- **closed 不落盘**：`forgetDshSession` 删内存记录并 `persistAgents`，重启不复活（约束 10）。**agent 已删除的记录丢弃**：restore 时 `defsMap` 查无此 agent 即跳过，下次写盘自然消失。
- **容错**：逐行解析，单行损坏/字段缺失不影响其余记录。
- **`/acp` RPC 面的会话（无 `dshSessionId`）不持久化**——那是面板的临时面，重启即清。

### 3.2 分叉的子会话与 fork 能力位

「在新对话中分支」（[protocol.md §1](./protocol.md) 的第四个建会话点）在状态层的三个落点：

- **`chatSessions.acpSessionId` 仍是唯一地址真相**：`adoptForkedSession` 给子会话建的持久化记录与任何聊天会话同形，resume 靠它 `session/load`；`AcpConversationChoice` 不存会话 id（见 §3），**严禁**为分叉再造第二个会话地址字段。
- **子会话 choice = 父 choice 拷贝 + `locked: true`**，经 `patchChatChoice` 这一个入口写——分支出来的会话从出生就锁在它的 agent 上，模型 / 等级 / 模式 / 额外配置随父；**严禁**手抄字段清单（约束 27 的老坑）。
- **fork 能力位落「最后已知」**：`initialize` 的 `sessionCapabilities.fork` 经 `noteForkCapability` 记进 `forkCaps`，随 `persistCatalogs` 写进 `model-catalog.json` 的 `agents[agentId].fork`，`loadPersistedCatalogs` 读回；`canForkNow` 活进程的 `initResult` 优先、这份最后已知兜底。**严禁**读 `view().agentCapabilities`——`releaseAll` 会清空它，分支按钮会无缘无故闪成禁用。能力位过期（agent 升级）只能等下次 `initialize` 更新，UI 文案用「最后已知」口径，不承诺实时。**A1 例外**：CodeBuddy 的能力位被 `noteForkCapability` 强制写成 `false`，`canForkNow` 直接返回 `false`；即使 `initialize` 宣告了 fork，磁盘上的旧 `true` 也被覆盖，分支入口不可用（`fork_unsupported`，见 [protocol.md §1](./protocol.md)）。

## 4. 模型目录（agent/catalog）

- **只读内存，绝不 spawn、绝不顺手起探测**。`agentCatalog` 是渲染路径，composer 每次 store 变更都调它。这里只要有一丝自发起探测的余地，「打开页面」就等于「启动 N 个 agent」，picker 会把那些进程如实报成「已连接」。`bootstrapCatalogs()` 现在是空实现（保留只为不改宿主入口的调用点）。
- 探测只允许三种**有手势**的来源：
  1. `agent/probe-models`（设置页按钮，或会话模型菜单末尾的「刷新目录」行——一次点击一个 agent；**打开菜单本身仍是纯缓存读**）；
  2. 某 agent **自己的** `session/new` / `session/load`（用户正在跟它说话，进程本来就在）；
  3. 旧 schema 的磁盘缓存——**不重探**，而是被 ② 顺带修好（`absorbCatalog` 清 `catalogStale`）。
- **`agent/cached-models` 是同一份内存的第二个读口**（`BridgeManager.cachedAgentModels`）：返回某 agent 最后一次观测到的目录（无则 `null`），供设置页模型区常驻显示「全部模型」。它同样**绝不 spawn**，也**不在**上面三条手势清单里——只读缓存；刷新仍由 `agent/probe-models` 承担。注意探测在「答案没变」时会保留旧 `updatedAt`，所以面板的「新增 N / 移除 M」必须由点击前后两份列表对比得出，不能靠 `updatedAt` 变化。
- 客户端 `loadAgentCatalog` 的调用点必须先判定「这条会话真的指向某个 agent」：`routeAgentId` 有答案即可（活会话 / pick / `chatBoundAgent` / **插件默认 agent**）。默认回落**不是**「别人的目录」：guard 的 `agent/model.select()` 路由选择（老宿主为 `agent/request` 改写）就是用它，且 `agent/catalog` 纯内存、绝不 spawn。**严禁**的是借 `agents[0]` 之类的名字读一条没有 agent 会服务的会话。`/` 菜单的懒读同理，按 `chatAgentFor` 找到实际会服务这条会话的 agent。测试：`tests/bridge.spec.ts` 的 "NEVER spawns an agent just because a catalog was read"。
- **结构**：`base`（裸 `agentId` = agent 默认模型）+ `exposedModels` 过滤后的 `variants` + agent 自己的 `thought_level` 作为 `reasoning` + 其余 select / boolean 作为 `extras`（`CATALOG_SCHEMA = 3`；旧缓存仍可读并标记待修复）。boolean 带 `kind: 'boolean'`、`choices: []`，`currentValue` 编码为 `'true'` / `'false'`（catalog 全体保持字符串类型），即使它自称 `category: thought_level` 也不进 `thought` 槽——等级控件没有可选等级，进槽等于让控件消失。`resolveAdapterModel` 对已知 agent 的任何输入都不得 throw（过期变体降级为裸 id 条目），仅对未配置 agent throw；`exposedModels` 过滤只作用于 `agentCatalog` 的变体展开（`base` 永不过滤），严禁影响 `resolveAdapterModel`。
- **category 只是 UX 提示，身份是 `configId`**：`parseCatalogOptions` 按 id 归槽、category 兜底；`model` 槽只认 `configId === 'model'`（或 name 为 `Model`），同 category 的其它选项**永不覆盖**它，输掉竞争的定义留在 `extras`。effort 形状的 model-scoped 选项（Qoder CN 把 `reasoning_effort` 标成 `category:'model'`）在没有原生 `thought_level` 时进 `thought`，否则进 `extras`；**严禁**按「同槽后者覆盖」处理，否则模型槽会被 effort 列表顶掉，发送前报假的 `model_unavailable`（issue #8）。测试：`tests/impl.spec.ts` · "mislabels an effort option"。
- **变体按需**：未设置 / 空 = 只留 `base`。真实 agent 动辄数百个 choice，默认全暴露在无搜索的菜单里就是列表风暴。供应商 `group` 只能来自 agent 自己返回的 ACP `SessionConfigSelectGroup` 标签，严禁从名称前缀 / value 路径 / 家族词猜测（任何供应商都可能供应别家模型）。
- **热更新**：真实会话观察到新目录时（`session/new` / `session/load` 响应、`config_option_update`），`absorbCatalog` 只要内容变化就必须广播 `catalog/updated`（`agentId` + `updatedAt`）；浏览器 `applyEvent` 收到后失效该 agent 的 `seatCatalogs` 并重读 `agent/catalog`（`loadAgentCatalog` 的 dedupe 保留）。不广播，首轮前打开的会话会永远停在旧列表（omp 实测 `session/new` 报 780，磁盘 / 浏览器停在 774）。
- `session/set_config_option` 的响应有两半，**严禁**整包喂进 `absorbCatalog`：`currentValue` 是这条会话的选择，升格成 agent 级 `reasoning.defaultEffort` 会让下一轮把座位刚选的思考等级静默改回去。但**形状**（哪些 option 存在、各有哪些 choice）必须经 `absorbCatalogShape`（纯函数 `mergeCatalogShape`）合进 agent 级目录并广播 `catalog/updated`——opencode 只给带 variants 的模型发 `thought_level`、切模型后又不推 `config_option_update`，这个响应是唯一来源，不吃形状思考等级芯片就永远不出现。合并规则：已存在槽位保留目录已知的 `currentValue`（观测 choice 列表不再提供它则退回 `null`）、新槽位一律 `null`；响应未提及的槽位 / extra 原样保留；不触发 `autoExposeNewModels`、不清 `catalogStale`（这不是 agent 级观测）。测试：`tests/impl.spec.ts` · `mergeCatalogShape`。
- **空 / 超大 `configOptions` 应答一律视为「非应答」**：`usableConfigOptions`（`src/impl.ts`，上限 `MAX_CONFIG_OPTIONS_BYTES` = 1 MiB）守卫六个入口——`session/new`、`session/load`、`session/set_config_option` 响应、`config_option_update` 通知、`absorbCatalog`、`absorbCatalogShape`。`[]` / `undefined` / 超限都不覆盖已知状态（catalog 与 `session.configOptions` 保持原样、不广播）：agent 在重置中 / provider 加载中会回空集，按「这个 agent 现在没有选项」处理会抹掉正在显示的模型列表与会话快照。测试：`tests/impl.spec.ts` · `usableConfigOptions`、`tests/bridge.spec.ts` · "EMPTY configOptions answer"。
- **DSH 自己的模型目录里没有 ACP 条目**（`AcpLlmAdapter.listModels('acp')` 返回空数组）。宿主目录构建是 per-request，一旦广告就等于对每条会话广告；`listModels` 契约本身写明目录是 advisory，空列表不影响解析、选择与流式。把 ACP 模型整体搬进 `agent/catalog` 是唯一结构性诚实的隔离。

## 5. 模型可见性筛选

- `exposedModels`（左全量 / 右已选）经 `agent/set-exposed-models` 原地修改 def 并持久化（`setExposedModels`），**不重启 agent 进程**。`agent/save` 会停掉子进程、杀死全部活动会话，只能用于命令 / 参数等真正需要重建的变更。
- 浏览器在保存后必须失效并重读该 agent 的座位目录缓存（`loadAgentCatalog`），否则已打开的对话仍列旧集合。
- **自动发现**（`autoDiscoverModels`，面板「自动发现新模型」开关，**默认开启**，经 `agent/set-auto-discover-models` 轻量切换）：`absorbCatalog` 把**相对上一份已知目录新增**的模型追加进 `exposedModels` 并持久化。首次观察到的目录只是基线（不会把 500 个模型一次全选），用户主动取消勾选的模型不会被复活。模型槽 `configId` 变化视为目录纠正而非增量（修复被顶掉的模型槽时不能把整份真实目录当成「新增」自动暴露）；落盘只记录显式关闭（`autoDiscoverModels: false`）；缺省与 `true` 等价，均为开启。
- 任何 `exposedModels` / 开关变更（含自动追加）都必须广播 `agent/exposure`；浏览器据此更新设置卡 `currentConfig` 并失效 / 重读 `seatCatalogs`。`agent/status` 不携带这两个字段，不能替代它。

## 6. 斜杠命令缓存

- 宿主 `BridgeManager.chatSessions` 必须带 `availableCommands`（**整行**，不只 name / description），这是**活会话**的权威声明。
- 同一份声明必须经 `AgentBridge.onCommands` → `BridgeManager.absorbCommands` 按 agent 缓存、随 `model-catalog.json` 持久化，并由 `agent/catalog` 的 `commands` 字段下发：**首条消息之前没有会话可问**，没有这份缓存，新 NTR 会话的 `/` 菜单就是空的。
- 活会话声明永远优先于缓存；两者都没有时菜单为空，**严禁**为菜单去 spawn 或探测。
- 浏览器 `AcpStore.chatSessionCommands` 的 `undefined` 同时覆盖「还没读」与「没有活声明」，此时按 `chatAgentFor`（活会话 → 锁定 → 宿主 / 乐观绑定 → pick → 插件默认）找到 agent，再读 `agentCommands`（必要时懒读一次纯内存的 `agent/catalog`）。**严禁**把「没有会话」当成「agent 没有命令」。
- `loadChatSessions` 返回**在飞读取的 promise**（不是立即 resolve 的空壳），这样「我没有判定，去问」的调用才真能收到答案。

### 6.1 技能清单（`agent/skills`，不落盘）

- 技能清单与命令缓存的结构差异：命令只能来自**活会话的声明**、必须持久化；技能是宿主对文件系统的**纯读扫描**（按 `skillFlavorOf` 的命令行风味选目录表，`src/skills-scan.ts`），无 spawn 依赖，重启重扫即可——所以**不落盘**、不进 `model-catalog.json`、不欠 schema bump。
- 宿主 `BridgeManager.agentSkills` 只读内存 TTL 缓存（60s，agent × workspaceRoot 复合键，上限 32 条最旧驱逐），不广播 SSE 帧；浏览器过 TTL 自然重问。扫描同步跑在 `agent/skills` 的 dispatch 路径上（最坏情形会阻塞事件循环，现实量级毫秒级，注释在扫描器头部）；**严禁**为菜单 spawn / 探测的纪律照旧适用。
- 浏览器 `UiState.agentSkills` 的缓存键**含 agentId**（`skillRowsKey` = `dshSessionId\0agentId`）：`bindChatAgent` 只乐观写绑定、无失效钩子，复合键让切 agent 即失效（旧键自然失配、下次菜单轮询重取），60 秒内绝不见旧 agent 的行。「不知道当前 agent」绝不记成「确认空」——`[]` 只由带 agentId 的成功 RPC 产生；`loadAgentSkills` 在 agentId 为 undefined 时不写状态、不发 RPC（轮询零网络成本）。

## 7. 未决权限询问（仅内存）

待答的权限询问是**运行时状态，不落盘**：`agents.json` 里与权限有关的只有 `approvalDeadlines`（设置页热改的期限与模式，见 [permissions.md §2.4](./permissions.md)）。宿主半区的 `PermissionLedger` 与浏览器 `UiState.permissions` 都随进程 / 页面消失，重连靠 `permissionReplayFrames` 重放未决项，并以 `permission/synced` 的活集合收尾。

- **帧字段**（实时广播与重放共用 `permissionRequestFrame`，字段逐项一致）：`requestId`、`sessionId`（ACP 会话 id）、`dshSessionId?`（`/acp` RPC 会话没有）、`toolCall`（原样保留）、`toolName`（宿主经 `permissionToolName` 派生，含 `_meta` 里 `toolName` 的兜底）、`reason?`（`permissionAskReason` 的一行摘要）、`options`（原样，含顺序与 `kind`）、`timeoutMode`（`wait` / `abort` / `auto`）、`deadlineAt?`（epoch ms；`wait` 模式没有期限时缺席）。重放帧缺一项，靠它过滤 / 显示的对话卡就会在重连后静默丢询问。
- `session/cancel`、`session/close`（先 settle 未决询问，再发 `session/close` 请求）、`releaseAll` 都会答复未决询问，卡片不会跨回合残留。
- `approvalRouted` 已删除（`agents/list` 不再上报）：设置页镜像卡片只看 `ui.permissions` 是否非空，见 [conversation-dock.md §10](./conversation-dock.md)。

## 8. 内置更新

更新是设置页版本徽标旁的一条链路，但**安装不是插件做的**：插件只问宿主「装的是什么」、问 registry「发布了什么」，再把安装**原样委托**给宿主 `pluginManager`。它从不下载包、不替换文件、不重启自己，也不拼 profile 路径（`src/update.ts` 的模块头就是这条边界）。HMR 下的「先卸再装」是宿主自己的更新语义（见下文 apply），不是自替换。

- **端点**：`plugin/update-check`（`{}`）与 `plugin/update-apply`（`{ version }`，经 `str(body, 'version', 64)` 后必须匹配 `/^\d+\.\d+\.\d+$/`，否则 `bad_payload`）都回 `PluginUpdateState`（`src/protocol.ts`）；只读的 `plugin/release-notes`（`{ version, refresh? }`，同样校验，`refresh` 只跳缓存读取）回 `PluginReleaseNotes`（`version` / 发布页 `url` / 原始双语 `body?` / 来源 `source` / `truncated?` / `message?`），不安装、不参与 check。状态机固定为 `unsupported` / `not-installed` / `source-install` / `managed` / `current` / `available` / `applying` / `busy` / `applied` / `restart-required` / `failed`；`current` 是**运行中**（内存里）的版本，`installed` 是磁盘版本，`latest` 是 registry 报出的稳定版目标，`registries` 是实际按顺序问过的 base（见下文「registry 链」）。
- **不抛异常**：服务侧把错误折成状态（`failed` + `message`；`message` 是英文技术信息，本地化归 UI）而不是 throw；唯一例外是格式不合法的版本——那是调用方 bug，抛 `bad_payload`。
- **接线**：`src/index.ts` 在宿主入口 `manager.setUpdateService(new UpdateService({ … }))`；`resolveManager` 每次调用重探 `ctx.get('pluginManager')`，**不写进顶层 `inject`**——没有这个服务的旧宿主仍要能加载，此时 `BridgeManager.pluginUpdateCheck` 回 `unsupported`。纯 bridge 测试不接线，同样回 `unsupported`，不发明数据源。
- **顺序**：check 是 `applying` 重入 → 资格矩阵 → registry 链，**不做忙判断**（读 registry 不花 ACP 工作，回合进行中也要能答「外面有什么版本」）；apply 是版本格式 → 拒绝不高于运行版本 → `applying` 重入 → 资格矩阵 → 忙判断 → `installBundle`。资格失败**优先于**忙：源码安装不会被说成「有对话在跑」。

**资格矩阵**（`bundleEligibility`，check / apply 共用；bundle 不存在或 `installed !== true` 都算 `not-installed`）：

| 条件 | 结果 |
|---|---|
| 无 `pluginManager`，或缺 `listBundles` / `registries` / `installBundle` 任一 | `unsupported` |
| bundle 不存在或 `installed !== true` | `not-installed` |
| bundle 不报 `source`（旧宿主） | `unsupported`（不猜渠道） |
| `source` 不是 registry spec（`isRegistrySpec`） | `source-install` |
| `readOnlyReason` 非空 | `managed`（`message` 用宿主原话） |
| `removable === false` | `managed`（宿主标记不可移除，remove 必然失败） |
| `bundle.error` 存在 | `failed`（code + `diagnostic`，缺失回落 `message`） |
| 磁盘 `version` 与运行版本经 `compareVersions` 不等 | `restart-required`（装完没重启；更高或更低都算；只带 `installed`，**不冒充 `latest`**） |

- **registry spec 是正向判定**：宿主 `listBundles()` 的 `source` 对 registry 依赖是 pluginManager 的 `dependencySpec` 拼出的 `<包名>@<spec>`（`dsh-ntr@0.3.0` / `dsh-ntr@^1.0.0` / `dsh-ntr@latest`），所以 `isRegistrySpec` 先拒绝空串、`.` 开头、含 `:` / `/` / `\` 的整串来源，再按**最后一个 `@`** 拆成包名与 spec（包名须非空且合法，spec 为空即拒绝），只对 spec 半边判定：`*` / `x`、dist-tag（latest / next / beta / alpha / rc / stable）与版本范围（可带 `v` 前缀、`^` / `~` / `>=` / `<=` / `>` / `<` / `=`；首段数字，最多三段，后两段可为 `x` / `*`；可选预发布 / build 后缀）。link: / file: / git+ / git@github.com: / github: / workspace: / https tarball / 相对路径都因形状被排除，**不维护黑名单**——将来出现新的 source scheme 默认不可更新。
- **registry 链**：`registryPlan` 把 `registries()` 的 `registry` → `resolved` → `fallbackRegistries` 排成真正要问的列表，**只留 http(s)**（去尾斜杠、去空、去重），**跳过带 username/password 的 URL**（本模块不读 `.npmrc`，也不把凭据发给 fetch）。隐私规则：私有的 `resolved` 不会因为存在 fallback 链就被 widen（只有 npm 公网或本身就在 fallback 里才追加）。每个 base 直接 `GET <base>/dsh-ntr`（`accept: application/json`，8s `AbortSignal.timeout`），**不 spawn npm**。某个 base 连不上（非 2xx / 超时 / 解析失败）就换下一个；**某个 base 只报运行版或更旧时也换下一个**——镜像滞后不能掩盖后面的更新；首个报出高于 `current` 的版本即 `available`。返回的 `registries` 一律经 `displayRegistry` 脱敏（去 userinfo）；失败 message 同样脱敏。整条链都没有更新时报 `current`（`latest` 取链上最高稳定版）；一个 base 都没答上才 `failed`（无 registry 配置 / 全部不可达）。
- **选版**：`pickUpdateTarget` 优先 `dist-tags.latest`（仅接受稳定且未被 `deprecated` 的版本、且高于 `current`）；否则取 `versions` 里最高且未 `deprecated` 的稳定版；都旧于 `current` 时仍回稳定且未弃用的 `latest`，供 UI 说「已是最新」。预发布版本永不提供安装；`publishedAt` 取 packument 的 `time[version]`。
- **缓存**：每个 base 成功的 packument 答案缓存 10 分钟（`CACHE_TTL_MS`）——设置页每次挂载都会问一次，没有缓存就是每次开页面都打 registry。apply **成功**（`applied` / `restart-required`）清空缓存与 `lastTarget`，下一次 check 看到刚装上的版本；失败不清，缓存仍是最近一次成功的 packument，重试安装不必再打 registry。卡片「重新检查」绕过的是**浏览器侧**节流，宿主侧缓存仍按 base 生效。
- **发布说明**（`plugin/release-notes`，只读预览）：数据源链是 GitHub Releases API（`api.github.com/repos/<repo>/releases/tags/v<version>`，带 `user-agent`）→ jsDelivr tag 版 `CHANGELOG.md`（`parseChangelogSection` 按 `## [x.y.z]` 切到下一个 `##` 之前，也接受无括号的 `## x.y.z`，`###` 子节属于本节），两源都失败只回 `pluginReleaseUrl(version)` 推导的发布页（`source: 'none'` + 英文 `message`，不带凭据）；正文保持原始双语（中文 → 单独一行 `---` → 英文），**语言由浏览器按 `---` 切**，宿主不猜；CRLF 归一 + trim，超过 20000 字符截断（不切半代理对）并带 `truncated`；成功缓存 10 分钟、`none` 只缓存 1 分钟（`this.now()`），可选的 `refresh: true`（卡片的「重试」）**跳过缓存读取**但仍写入新结果——否则 60 秒内的重试只会读回同一个失败；**永不 throw**；浏览器在 RPC 失败（旧宿主 unknown endpoint / 传输失败）时 catch 成推导 URL，manager 缺方法或未接 updateService 时 impl / bridge 同样回 `source: 'none'` + 推导 URL；**在卡片展开时按需拉取**——check 不碰 GitHub，`apply()` 成功也不清发布说明缓存（按版本内容不变）。
- **apply 委托与映射**：解包宿主的 `{ ok, value }` 信封后，`application === 'applied'` → `applied`，`'restart-required'` → `restart-required`（`installed` 取结果里的 `version`，缺失回落请求版本）；`overridden` / `cancelled` / 带 `error` / 缺失或未知 `application` → `failed`（如实说「manager 没给结果 / 给了不认识的状态」）。错误正文读 `error.diagnostic`，缺失才回落 `message`（RPC 信封的 `message` 只作兼容）。**失败绝不把目标版本写进 `installed`**：普通失败沿用资格阶段读到的磁盘版本（等于 `current`），回滚成功才显式写 `installed: current`，回滚失败则不带 `installed`。安装命中 registry 时经 `lastTarget` 透传给本次 `installBundle`（版本一致时）；**回滚不传 registry**，走宿主默认链（目标版本可能来自 fallback / 镜像）。check 在选版完成后会再查一次 `applying`：若安装已在 fetch 期间开始，晚到的结果返回 `applying`，不把 `available` 交给客户端。
- **HMR 下的 apply**：宿主在 HMR 持有时拒绝覆盖已安装 bundle（`already-installed`）。apply 因此按宿主原生更新语义执行：先 `installBundle`；遇 `already-installed` 且宿主有 `removeBundle` → `removeBundle('dsh-ntr')`（会卸载当前插件）→ 重试 `installBundle`。卸载结果必须是 `error` 缺失且 `application` 为 `applied` / `restart-required` / undefined，`cancelled` / `overridden` / `failed` 一律 `failed`。重试再失败时**先再 `removeBundle`（目标可能已落盘）**，再 `installBundle('dsh-ntr@'+current, { enabled: true })` 回滚（不带 registry）；回滚失败时消息说明「rollback also failed」且不带 `installed`。这不是自替换：所有文件操作都由宿主 pluginManager 完成，用户手动点击触发，`removeBundle` 只是宿主更新流程里卸载活模块的那一步——apply 的 RPC 因此可能在安装中被打断，客户端按下一条处理。
- **忙保护**：`isBusy` 接 `BridgeManager.hasActiveTurns`（有在飞的分段 turn 流，或任一 bridge 有活跃 turn）。**只有 apply 查忙**：安装可能要宿主重启，不能在别人回合中间做；有回合在跑时 check 照常查 registry。
- **源码安装**：`link:` / `file:` / `git+` / `workspace:` / 相对路径等是本地挂载、git 检出或本地包，registry 里的版本对它没有意义。状态固定 `source-install`、**永不升级**；UI 的版本徽标 `title` 与卡片只说「源码或本地安装，无法通过 registry 更新」，不假定用户用的是 git（`file:` / tarball 同样成立）。这是 per-bundle 的 `source` 事实，不按渠道猜。
- **客户端**：`checkPluginUpdate` 在 store 里做 10 分钟节流（`PLUGIN_UPDATE_TTL_MS`）与共享 in-flight promise（两个设置入口同 tick 挂载也只打一次）；`force` 只绕过 TTL，不绕过 in-flight。旧宿主没有端点时 `unknown endpoint` 被静默吞掉、返回 `undefined`，更新入口整块隐藏且不写 notice。`applyPluginUpdate` 用 `pluginUpdateApplying` 做重入保护（双击只装一次），先乐观写 `applying`；apply RPC 若因插件被卸载而中断，客户端把结果映射成 `restart-required`、**清掉 `installed`（磁盘状态未知）**、保留 `latest`、写一次 notice「更新请求已中断；请刷新页面确认当前版本。」，并重置节流时间戳让下一次 check 真正去问宿主。`pluginUpdateGeneration` 在 apply 开始时自增，晚到的 check 结果代次不符即丢弃——安装成功不会被旧 check 改回 `available`。
- **已知限制**：check 直接 GET packument，**不读 profile 的 `.npmrc` 认证 / 代理**；带凭据的 registry URL 会被 `registryPlan` 跳过（不把 token 交给 fetch，也不发给浏览器），私有 registry 需要认证时可能表现为不可达，`failed.message` 列出问过的 base（URL 已脱敏）。将来 DSH 若提供 `updateBundle` / `listVersions`，优先改用宿主接口而不是继续自建 registry 读取。
- **渠道与重启**：资格与安装都**按能力判断**，不按渠道：web 与桌面 DSH 的宿主半区同源，能不能更新只看 `ctx.get('pluginManager')`；插件不读渠道标记、不为 web / 桌面分支，装进哪个 profile 由 manager 决定，插件不拼路径、不认 profile 名。桌面 App 管理的 profile **不要**对它跑 `dsh plugin`（那份 profile 归 App 自己管）；两条渠道的安装都走这个进程内服务。重启**不能自动**：`applied` 让用户刷新页面，`restart-required` 让用户重启 DSH（桌面 App 退出重开 / 命令行重启 `dsh web`），插件既不重启宿主也不自替换。

## 9. 保存门禁（`acpSaveGate`）

回合进行中保存 DSH 设置会改写 profile 的 `cordis.patch.yml`；`dsh-hmr` 在配置变化时比较已加载模块，可能停掉并替换 `dsh-ntr`，插件的 disposer 随即 `shutdownAll()`，在飞回合以 `SESSION_CLOSED` 收口（见 [protocol.md §2](./protocol.md)）。写入链在宿主侧：设置 UI → `dsh-api-settings-controller` → `ctx.settings` 的 `SettingsForms.write` → `ctx.configEditor.edit` → `writeFileAtomic` + reconcile；`dsh-hmr` 的 `reconcileProfile` 负责模块替换。**插件不能拦截文件写入本身**，只能在宿主写入前提供判据。

- 插件把 `AcpSaveGate`（`src/save-gate.ts`）以 `ctx.provide('acpSaveGate', gate)` 暴露给宿主；`ctx.provide` 缺失的旧运行时只保留 RPC/SSE 面。
- 门禁能力：`canSaveNow()`、`defer(label, operation, { timeoutMs })`、`cancel(label)`、`retry(label)`、`waitForIdle(ms)`、`onIdle(listener)`、`forceFlush()`、`status()`。无活动回合时 `defer` 直接执行，**行为与未接门禁时完全一致**；有活动回合时排队，默认 10 分钟到期（`DEFAULT_SAVE_GATE_TIMEOUT_MS`，`0` = 无限等待），到期**不写入**、置 `expired` 并要求重试。**按 label 分代**：`defer` 与 `cancel` 都推进 `labelVersions[label]`，队列项带入队时的世代，执行前世代不符就结为 `cancelled`、绝不运行——同 label 的新保存因此天然作废旧快照，旧值不会在新值之后被写回。`cancel(label)` 还清掉该 label 的 retryable；`retry(label)` 只重跑最近一次未成功的操作。`status()` 来自真实门禁时带 `gateAvailable: true`（`saveGateStatus`）；宿主 `.dsh` 的兜底与 `emptySaveGateStatus()` 回 `gateAvailable: false`，浏览器只认 `true` 为可信、缺字段归一为 false。`status()` 带 `lastOutcomes`（每 label 一条终态：`saved` / `expired` / `failed` / `cancelled`）与兼容用的 `lastOutcome`；`SaveGateOutcome` 的 `cancelled` 在同 label 新 `defer` 取代旧队列项时带 `superseded: true`，显式 `save/cancel` 不带；`SaveGateOutcomeView` 只在该情形回写 `superseded: true`。`forceFlush()` 只处理调用开始时快照里的队列项（`forcedSnapshot`），运行期间新入队的 `defer` 保留到下一次边界；遇到另一轮 flush 在飞时排一次后续强制 pass（并发强制调用者共享它）。队列只在内存，崩溃/强退会丢；要抗崩溃必须由宿主在 defer 前写 journal，或改为「立即写盘、只延迟 HMR 替换」。
- RPC：`save/status`、`save/flush`（强制保存）、`save/cancel`（`{ label }` → `{ cancelled }`）、`save/retry`（`{ label }` → `{ retried }`）、`save/wait-idle`；SSE 帧：`save/status`。旧宿主半区缺哪个端点就回 `unsupported`，`save/status` 回空闲快照。浏览器 `SaveGuardToast`（`shell.overlay`）分两层：`pending.length > 0` 时显示「配置已暂存」并提供【强制保存】，无待存项时不渲染；`SaveBanner` 是 store 里的横幅**数据类型**（`src/client/store.ts`），由 `SaveGuardToast` 渲染成**全局页顶横幅**——固定浮层、`top: 16px`、水平居中、最大宽度沿用 `min(420px, calc(100vw - 40px))`，**不嵌在设置页**。来源为保存 / 热重载终态（`save-failed` / `save-expired` / `save-rejected` / `save-partial` / `save-succeeded` + `hmr-delay`，热重载延迟**不属于保存终态**）；手势反馈行是 `save-cancel-failed`（取消未生效）、`save-cancelled`（用户取消成功）、`save-retry-none`（无待重试项）、`save-retry-failed`（重试运输 / 非法返回 / `unsupported`）与 `agent-deleted`（删除取消），同样走这个浮层。同一帧多个保存成功合成一条成功行并列出保存的 agent 名（超过 3 个只列前 3 个并写「等 N 个」），保存成功日志仍逐条带 label；同一 agent 保存成功后只清除它自己的旧失败 / 过期 / 被拒行与重试登记，不波及其他 agent。失败行常驻到用户关闭且**不因数量丢弃**，成功行最多一条、2.5 秒后自动消失；失败超过 6 条折叠为「还有 N 条失败」并可展开。同一 `key` 的原因**替换**上一行而不叠加，关闭后同因再次出现照常显示。错误行 `role="alert"` + `aria-live="assertive"`，其余 `role="status"` + `aria-live="polite"`，都带 `aria-label`；Escape 走**页面级监听**关闭最新一条，焦点在 `input` / `textarea` 时不拦截。刷新后 `resync` 与首帧 SSE 播种都按「该 label 上一份快照无终态」判定，不比较时间窗；关闭记录按 `banner.key` → `banner.at` 存 `sessionStorage`，只对带 `persistAcrossReload` 的门禁 `failed` / `expired` 行跨刷新生效。重试不可用时用 `save-retry-none` 成功回执替换该行，**不回落为全局强制保存**。门禁终态 `cancelled` 只写日志、不进横幅；`superseded: true` 的不当作人工取消，同 label 重新入队会移除旧 `save-cancelled` 行（任何路径都移除）；`agent_deleted` 另发一条只带关闭的失败行，不保留重试 payload。用户主动取消成功另发一条 `save-cancelled` 回执，只有设置表单与日志提示，全局浮层静默。
- **HMR 运行时防护（Q）**：`src/hmr-guard.ts` 的 `installHmrReconcileGuard` 在加载时包装 `hmr.reconcileProfile`（`ctx.inject(['hmr'])` 处理晚到服务）。有活动回合时立即返回合法的空 reconcile（`{ warnings: [], pending: [] }`），不进入模块比较；回合结束后用退避定时器 + `hmr.runExclusive(() => original.apply(hmr, args))` 重试，参数原样透传。重试有界（默认 3 次，间隔从 `retryDelayMs` 起翻倍）：失败后主动排下一次；超过上限发一条通知并留到下一个回合边界。**恰两条通知**：重试耗尽、以及回合超过 `giveUpMs`（默认 10 分钟）仍未结束；每条等待只报一次，下一次回合边界重新计数。实例上的 `HMR_RECONCILE_GUARD_MARKER` 记录当前所有者（每次安装一个 token），重复安装幂等；卸载只在自己仍是当前包装时恢复原方法，外来包装接替后清理属于自己的标记；原型方法经 `delete` 恢复自有属性形状，原本有自有属性则按原描述符 `defineProperty`。安装失败返回 `installed: false` 的句柄，`src/index.ts` 只在真正安装时记录 disposer，后续注入可重试。服务缺失 / `reconcileProfile` 缺失 / `runExclusive` 缺失 / 不可写 / 非可扩展时安全降级并 `logger.warn`，不影响 HMR 原行为。宿主升级若改了方法名或 `refresh` 不再调用实例方法，防护静默失效，HMR 不坏。**已知限制**：页顶「热重载被延迟」横幅只有【知道了】，**没有重试动作**——HMR 服务不在插件 RPC 面里，用户不能手动触发 reconcile，真正重试只发生在下一个回合边界。
- **NTR 自身设置保存防护**：NTR 设置写 `~/.dsh/dsh-ntr/agents.json`（`saveAgentNow` → `persistAgents`），并停掉该 agent 的 ACP 子进程、杀死其活动会话；**不写 profile patch，也不触发 HMR**。统一入口是宿主 `BridgeManager.saveAgent(def, mode)`，label 固定 `agent-save:<id>`：目标是该 agent 的活动会话时，`direct`（或未给 mode）返回 `{ done:false, confirmationRequired:true, activeSessions }`，不写盘；`defer` 走 `AcpSaveGate.defer(label, …)` 排队并立即返回 `deferred`；`force` 只取消目标 `agent-save:<id>` 的暂存并直接写盘，不冲刷其他 label——全局冲刷只有 `saveGateFlush()` / `save/flush` 一个入口，`forceFlush()` 的唯一调用者就是它。`activeTurnViews()` 把 `running` 或 `settled` 的会话都算忙碌，**已 released 的会话不算**：`SessionView.settled` 表示可见回合已结束、agent 尚未结清 `session/prompt`，`snapshot` 只在为真时下发；**旧宿主半区从不发该字段**，浏览器用本地 `ui.sessions` 兜底会少报这个短窗口（已知限制）。单个 Agent 的强制保存不再顺带救活其他临近超时的暂存，它们会留到空闲边界或超时 `expired`（已知限制）。**同 label 新保存让旧队列项失效**（入队世代 + 执行前校验，结为 `cancelled`）；`deleteAgent` 先留**进程级墓碑**（`deletedAgentIds` / `agentDeleteGenerations`）并 `cancel(label)`，再停进程——墓碑存在时 `saveAgent` 以 `agent_deleted` 拒绝，执行中被删除中止的保存记 `cancelled`、**不生成横幅**，否则删除后回合结束会把旧定义写回盘、agent 复活。`deleteAgent` 末尾改严格落盘：失败以 `persist_failed` 返回，墓碑与内存删除不回滚。`probeAgentModels` / `absorbCatalog` / `absorbCatalogShape` 都先判 `defsMap` 与 `isAgentDeleted`：删除后的 id 不再探测，迟到结果不写内存、不广播 `catalog/updated`。每个 agent 有保存世代：`nextAgentSaveGeneration(id)` 在新保存时推进，`saveAgentNow` 在每个 await 后与写盘前调 `assertAgentSaveCurrent`，不符抛 `SaveGateAborted`，门禁按 `cancelled` 收尾、不写盘、不广播 `agent/status`。`persistAgents(true, resolvedDef)` 先把候选写进文件，`defsMap.set` 只在写成功后执行；写盘失败内存保持旧定义，**不静默吞掉**，无可用持久化路径时严格保存抛 `persist_failed`。`stopAgent(agentId, persist = true)` 删除内存会话记录后按 `persist` 持久化 `chatSessions`；`saveAgentNow` 与 `deleteAgent` 传 `false`，避免与其后的严格写盘竞争。旧调用方不带 `saveMode` 且目标忙碌时，`dispatchRpc` 回 `confirmation_required` **失败**（`ok:false`），被拒绝不能伪装成成功；新面板总带 `saveMode`，所以 `save-rejected` 在当前面板不可达——只有旧宿主忽略 `saveMode`、或外部 RPC 调用方不带它而目标忙碌时才会出现。面板在保存前用 `save/status` 预检，弹「取消 / 回合结束后保存 / 立即保存并中断」，无活动回合直通、不弹框。选「回合结束后保存」时用 `heldSignature` 冻结点击时的 payload 快照；**暂存态以门禁 `pending`（按 label）为准**，`deferRequested` 只在首帧 `pending` 到达前兜底；终态只在 `lastOutcomes` 的 `at` 与入队时记录的 `deferOutcomeAt` 不同时结算该次暂存（主机时钟的身份比较，不混用浏览器时钟）——关闭设置面板或刷新后仍显示「配置已暂存」；在它落盘前继续改表单会 `save/cancel` 该 label，取消只认 `typeof cancelled === 'number' && cancelled > 0`；`cancelled: 0` 时回读 `save/status` 复核，RPC 失败时**保留暂存态**并出警示横幅；取消在飞期间继续编辑会比对最新签名后再发一次取消。删除与停止的确认卡显示受影响会话数（门禁 `activeSessions` 与本地未关闭会话的并集，**排除 released**）。旧宿主没有 `save/status` 时，面板用本地 `ui.sessions` 的 `running` / `settled` 行兜底，并隐藏「回合结束后保存」（旧宿主会忽略 `saveMode`，不能假装能排队）；只有取消与立即保存。若宿主有门禁但 `save/status` 临时失败，面板保留「回合结束后保存」、用本地会话行兜底确认并提示重试；外部调用方仍由 `agent/save` 的 `confirmationRequired` 兜底，不能静默中断回合。
- **已知边界**：删除写盘失败后墓碑只在进程内有效；重启前若没有一次成功写盘，旧 agent 仍可能从文件复活，但 RPC 已返回 `persist_failed`。`stopAgent` 的非严格持久化失败只发通知，磁盘可能保留旧 `chatSessions`，重启后可能恢复可 resume。
- 宿主接入点（可选，不在本仓改文件）：`dsh-settings` 的 `SettingsForms.write` 在 `canSaveNow() === false` 时 `await gate.defer(...)`，失败时重抛 `outcome.error` 以保留 `settings/conflict` 分类；`dsh-hmr` 的 `reconcileProfile` 在 ACP 回合活动时 `await gate.waitForIdle()`，超时则用 `onIdle` 重试。Q 已覆盖当前设置保存路径；这两处宿主改动是更耐久的替代/补强，而不是 Q 的前提。

## 代码索引

| 主题 | 位置 |
|---|---|
| 状态目录 | `src/bridge/state-paths.ts` · `pluginStateDir` / `hostStateDir` / `stateDirExplicit` / `legacyStatePaths` / `migrateLegacyState` / `rewriteLegacyWorkspaceRoots` / `defaultAgentWorkspace` |
| 校验 | `src/impl.ts` · `validateAgentDef` / `validateConfig` / `validateMcpServers`；`src/bridge/manager.ts` · `saveAgent` |
| 会话选择 | `src/bridge/manager.ts` · `chatChoice` / `patchChatChoice` / `applyChatChoice` / `syncConversationRoute` / `loadPersistedChoices` / `persistAgents` |
| 目录 | `src/bridge/manager.ts` · `agentCatalog` / `resolveAdapterModel` / `absorbCatalog` / `absorbCatalogShape` / `setExposedModels` / `setAutoDiscoverModels` / `autoExposeNewModels` / `broadcastExposure`；`src/impl.ts` · `parseCatalogOptions` / `mergeCatalogShape` / `usableConfigOptions` |
| 分叉 | `src/bridge/manager.ts` · `adoptForkedSession`；`src/bridge/agent-bridge.ts` · `forkSession`；`src/bridge/manager.ts` · `noteForkCapability` / `canForkNow` / `forkCaps`；`src/client/store.ts` · `forkChatSession` / `forkStateOf`（子会话绑定与能力位见 §3.2） |
| 未决询问 | `src/bridge/agent-bridge.ts` · `handlePermissionRequest`；`src/impl.ts` · `PermissionLedger` / `permissionRequestFrame` / `permissionReplayFrames`；`src/client/store.ts` · `permissionsForSession` |
| 斜杠缓存 | `src/bridge/manager.ts` · `chatSessions` / `absorbCommands`；`src/client/store.ts` · `chatSessionCommands` / `loadChatSessions` |
| 技能清单（§6.1） | `src/bridge/manager.ts` · `agentSkills`；`src/skills-scan.ts` · `scanSkillDirs`；`src/impl.ts` · `skillFlavorOf` / `SKILL_DIRS_BY_FLAVOR` / `GENERIC_SKILL_DIRS` / `SKILL_SCAN_LIMITS` / `parseSkillFrontmatter` / `skillMetadata` / `skillMentionToken` / `formatSkillPathDestination` / `formatSkillMentionPrompt`；`src/impl.ts` · `dispatchRpc`（`agent/skills` 分支）；`src/client/store.ts` · `agentSkills` 状态 / `skillRowsFor` / `loadAgentSkills` / `skillInsertionFor` / `skillRowsKey` / `SKILL_MENU_TTL_MS` |
| 内置更新 | `src/update.ts` · `UpdateService` / `check` / `apply` / `releaseNotes` / `parseChangelogSection` / `bundleEligibility` / `isRegistrySpec` / `registryPlan` / `pickUpdateTarget` / `compareVersions`；`src/index.ts` · `setUpdateService`；`src/bridge/manager.ts` · `pluginUpdateCheck` / `pluginUpdateApply` / `pluginReleaseNotes` / `hasActiveTurns`；`src/bridge/identity.ts` · `PLUGIN_VERSION`；`src/impl.ts` · `dispatchRpc`（`plugin/update-*` / `plugin/release-notes` 分支）；`src/client/store.ts` · `checkPluginUpdate` / `applyPluginUpdate` / `loadPluginReleaseNotes` / `prefersZh`；`src/client/panel.tsx` · `PluginUpdateBadge` / `PluginUpdateCard` / `updateBadgeText` / `updateCardVisible`；`src/client/release-notes.tsx` · `ReleaseNotesSection` / `pickReleaseLanguage` / `releaseNoteVersion`；`src/protocol.ts` · `PLUGIN_REPO` / `pluginReleaseUrl` / `PluginReleaseNotes` |
| 保存门禁 | `src/save-gate.ts` · `AcpSaveGate` / `canSaveNow` / `defer` / `cancel` / `retry` / `waitForIdle` / `forceFlush` / `labelVersions` / `labelOutcomes`；`src/index.ts` · `saveGate` / `ctx.provide('acpSaveGate')`；`src/bridge/manager.ts` · `activeTurnViews` / `saveGateStatus` / `saveGateFlush` / `saveGateCancel` / `saveGateRetry` / `saveGateWaitIdle`；`src/impl.ts` · `dispatchRpc`（`save/*` 分支）/ `emptySaveGateStatus`；`src/client/store.ts` · `forceSaveGate` / `cancelSaveGate` / `retrySaveGate` / `pushSaveBanner` / `dismissBanner` / `retryBanner` / `forceBanner` / `reportFlushResult` / `saveGateInterruptTargets` / `save/status` 折叠；`src/client/save-guard-toast.tsx` · `SaveGuardToast` / `saveGuardToastKind` |
| HMR 防护 | `src/hmr-guard.ts` · `installHmrReconcileGuard` / `HMR_RECONCILE_GUARD_MARKER` / `EMPTY_RECONCILIATION` / `isHmrReconcileHost`；`src/index.ts` · `installHmrGuard` / `ctx.inject(['hmr'])`；`src/client/store.ts` · `pushSaveBanner`（`hmr-delay` 横幅） |
| NTR 保存防护 | `src/bridge/manager.ts` · `saveAgent` / `saveAgentNow` / `deleteAgent` / `stopAgent` / `activeTurnViews` / `nextAgentSaveGeneration` / `assertAgentSaveCurrent` / `probeAgentModels` / `isAgentDeleted`；`src/impl.ts` · `agentSaveAction` / `dispatchRpc`（`agent/save`）；`src/client/store.ts` · `readSaveGate` / `saveAgent`；`src/client/panel.tsx` · `AgentRow.performSave` / `AgentDetails` 保存确认卡 / `RowMenu` 受影响会话数 |
