# 状态与持久化

本文是 [AGENTS.md](../../AGENTS.md) 的展开层。运行时唯一落盘点是 `~/.dsh/dsh-ntr/`。

## 1. 落盘位置

`pluginStateDir()`（`~/.dsh/dsh-ntr`）下只有三样东西：

- `agents.json` —— agent 注册表 + 默认 agent + 每会话选择
- `model-catalog.json` —— 模型目录 + agent 最近一次声明的斜杠命令
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
- 默认启动命令预设存在两份手拷贝：`AGENT_PRESETS`（`src/bridge.ts`）与 `DEFAULT_KNOWN_PRESETS`（`src/client/store.ts`），改其一必须同步另一处（无类型系统强制）。

## 3. 会话选择持久化

一个 DSH 聊天会话对它的 ACP agent 做的全部选择（`agentId` + `modelId` + `effort` + `mode` + `extraConfigs`）记在 `AcpConversationChoice`（`src/protocol.ts`），由 `BridgeManager.chatAgentIntent` 持有并持久化到 `agents.json` 的 `conversations` 键（`persistAgents` / `loadPersistedChoices`）。

- **严禁**只存内存 Map 或只写进 `LiveSession`：活会话在第一条消息之前根本不存在，而「对话前选模型」正是要在这个窗口里表达。
- **应用时机**：`applyChatChoice` 必须在 `createSession`（首轮建会话）与 `getOrCreateDshSession` 的 resume 分支各调一次。`session/new` 与 `session/load` 回的都是 agent 自己的默认值，不补这一步就是「选了 A 却跑 B」，且只从第二条消息才生效。同样两条路径还必须调 `lockChatAgent`，锁与 pick 在同一条记录里（见 [architecture.md §7](./architecture.md)）。
- **失效 model 必须拦截，严禁回落**：发送前 `staleModelChoice` 用会话**最新** `configOptions` 校验（agent 发布了**非空** choices 却不含该值即命中；没有选择器 / choices 为空时无从校验，保留原有 best-effort）；命中就以 `model_unavailable` 失败，**不发送 prompt**，并保留 pick——芯片与 picker 继续指着用户选的值，用户改选后才能继续。首轮零输出照常回滚锁。`applyChatChoice` 对失效 model 只跳过应用、**不删 pick、不镜像成别的模型**；活会话上的 `setChatSessionModel` 直接拒绝失效值（不写记录）。失效 **effort** 仍按旧策略：经 `dropStalePick` → `patchChatChoice` 从记录删除并广播一次 `agent/notice`（它不决定用哪个模型）。`exposedModels` 里的失效值保留（模型回来时仍算已选）。
- **请求路径**：`syncConversationRoute` 把 pick 的 **model 半**写进 `routeBindingRegistry().conversations`（`modelId ?? agentId`），否则 guard 的改写只拿到裸 agent id，对话前选的变体会被静默丢掉。该函数**只增不减**：没有 pick 的会话保留 turn 路径 pin 的「实际服务过它的 agent」，删掉会让回放默认 provider。
- **切 agent 清空派生选择**（仅锁定之前）：首轮前 `bindChatAgent` 在 agentId 变化时丢掉 `modelId` / `effort` / `mode` / `extraConfigs`——它们是上一个 agent 的词汇（变体来自它的 catalog、等级来自它的 `thought_level`、模式 id 来自它的 `session/set_mode` 列表、额外项来自它的 configOptions），带过去就是让新 agent 收到它从没提供过的值。同一 agent 重复绑定则保留。
- 全部经 `patchChatChoice` 这一个入口写，**严禁在某个 setter 里手抄字段清单**——`mode` 正是这样漏掉的：四个控件三个持久化，唯独它每次重启回到 agent 初始模式。
- **读取面**：`session/chat-list` 回 `choice`，`AcpStore.chatChoice` 落状态；`describeRoute` 活会话优先、pick 兜底。composer 的 model / 思考 chip 不能以 `bound !== undefined` 为渲染条件（那是「对话前无法选择」的直接成因），改为 `routed`（活会话 **或** pick **或** `chatBoundAgent`）再加各轴自己的条件。高级底座的当前值读 `advancedOptions(catalog, choice)`：`choice.extraConfigs` 覆盖 `catalog.extras[].currentValue`，且只在该 choice 属于 catalog 的 agent 时生效。
- **不移植 agent 级偏好层**：agent 级默认已由 `agent/catalog` 的 `reasoning.defaultEffort` 与自报 `currentValue` 表达，再加一层会造出「用户没选过却以为选过」的第三种事实源。

## 4. 模型目录（agent/catalog）

- **只读内存，绝不 spawn、绝不顺手起探测**。`agentCatalog` 是渲染路径，composer 每次 store 变更都调它。这里只要有一丝自发起探测的余地，「打开页面」就等于「启动 N 个 agent」，picker 会把那些进程如实报成「已连接」。`bootstrapCatalogs()` 现在是空实现（保留只为不改宿主入口的调用点）。
- 探测只允许三种**有手势**的来源：
  1. `agent/probe-models`（设置页按钮，或会话模型菜单末尾的「刷新目录」行——一次点击一个 agent；**打开菜单本身仍是纯缓存读**）；
  2. 某 agent **自己的** `session/new` / `session/load`（用户正在跟它说话，进程本来就在）；
  3. 旧 schema 的磁盘缓存——**不重探**，而是被 ② 顺带修好（`absorbCatalog` 清 `catalogStale`）。
- 客户端 `loadAgentCatalog` 的调用点必须先判定「这条会话真的指向某个 agent」（`bound` / `choice` / `chatBoundAgent`），**严禁**因为 `routeAgentId` 回落到全局 `defaultAgent` 就去读别人的目录——读就会触发探测。唯一例外是 `/` 菜单的懒读：由用户输入 `/` 触发，按 `chatAgentFor` 找到实际会服务这条会话的 agent，且 `agentCatalog` 纯内存。测试：`tests/bridge.spec.ts` 的 "NEVER spawns an agent just because a catalog was read"。
- **结构**：`base`（裸 `agentId` = agent 默认模型）+ `exposedModels` 过滤后的 `variants` + agent 自己的 `thought_level` 作为 `reasoning` + 其余 select 作为 `extras`（`CATALOG_SCHEMA = 3`；旧缓存仍可读并标记待修复）。`resolveAdapterModel` 对已知 agent 的任何输入都不得 throw（过期变体降级为裸 id 条目），仅对未配置 agent throw；`exposedModels` 过滤只作用于 `agentCatalog` 的变体展开（`base` 永不过滤），严禁影响 `resolveAdapterModel`。
- **变体按需**：未设置 / 空 = 只留 `base`。真实 agent 动辄数百个 choice，默认全暴露在无搜索的菜单里就是列表风暴。供应商 `group` 只能来自 agent 自己返回的 ACP `SessionConfigSelectGroup` 标签，严禁从名称前缀 / value 路径 / 家族词猜测（任何供应商都可能供应别家模型）。
- **热更新**：真实会话观察到新目录时（`session/new` / `session/load` 响应、`config_option_update`），`absorbCatalog` 只要内容变化就必须广播 `catalog/updated`（`agentId` + `updatedAt`）；浏览器 `applyEvent` 收到后失效该 agent 的 `seatCatalogs` 并重读 `agent/catalog`（`loadAgentCatalog` 的 dedupe 保留）。不广播，首轮前打开的会话会永远停在旧列表（omp 实测 `session/new` 报 780，磁盘 / 浏览器停在 774）。
- `session/set_config_option` 的响应**只**反哺 `session.configOptions`，**严禁**喂进 `absorbCatalog`：那里的 `currentValue` 是这条会话的选择，升格成 agent 级 `reasoning.defaultEffort` 会让下一轮把座位刚选的思考等级静默改回去。
- **DSH 自己的模型目录里没有 ACP 条目**（`AcpLlmAdapter.listModels('acp')` 返回空数组）。宿主目录构建是 per-request，一旦广告就等于对每条会话广告；`listModels` 契约本身写明目录是 advisory，空列表不影响解析、选择与流式。把 ACP 模型整体搬进 `agent/catalog` 是唯一结构性诚实的隔离。

## 5. 模型可见性筛选

- `exposedModels`（左全量 / 右已选）经 `agent/set-exposed-models` 原地修改 def 并持久化（`setExposedModels`），**不重启 agent 进程**。`agent/save` 会停掉子进程、杀死全部活动会话，只能用于命令 / 参数等真正需要重建的变更。
- 浏览器在保存后必须失效并重读该 agent 的座位目录缓存（`loadAgentCatalog`），否则已打开的对话仍列旧集合。
- **自动发现**（`autoDiscoverModels`，面板「自动发现新模型」开关，经 `agent/set-auto-discover-models` 轻量切换）：开启后 `absorbCatalog` 把**相对上一份已知目录新增**的模型追加进 `exposedModels` 并持久化。首次观察到的目录只是基线（不会把 500 个模型一次全选），用户主动取消勾选的模型不会被复活。
- 任何 `exposedModels` / 开关变更（含自动追加）都必须广播 `agent/exposure`；浏览器据此更新设置卡 `currentConfig` 并失效 / 重读 `seatCatalogs`。`agent/status` 不携带这两个字段，不能替代它。

## 6. 斜杠命令缓存

- 宿主 `BridgeManager.chatSessions` 必须带 `availableCommands`（**整行**，不只 name / description），这是**活会话**的权威声明。
- 同一份声明必须经 `AgentBridge.onCommands` → `BridgeManager.absorbCommands` 按 agent 缓存、随 `model-catalog.json` 持久化，并由 `agent/catalog` 的 `commands` 字段下发：**首条消息之前没有会话可问**，没有这份缓存，新 NTR 会话的 `/` 菜单就是空的。
- 活会话声明永远优先于缓存；两者都没有时菜单为空，**严禁**为菜单去 spawn 或探测。
- 浏览器 `AcpStore.chatSessionCommands` 的 `undefined` 同时覆盖「还没读」与「没有活声明」，此时按 `chatAgentFor`（活会话 → 锁定 → 宿主 / 乐观绑定 → pick → 插件默认）找到 agent，再读 `agentCommands`（必要时懒读一次纯内存的 `agent/catalog`）。**严禁**把「没有会话」当成「agent 没有命令」。
- `loadChatSessions` 返回**在飞读取的 promise**（不是立即 resolve 的空壳），这样「我没有判定，去问」的调用才真能收到答案。

## 代码索引

| 主题 | 位置 |
|---|---|
| 状态目录 | `src/bridge.ts` · `pluginStateDir` / `hostStateDir` / `stateDirExplicit` / `legacyStatePaths` / `migrateLegacyState` / `rewriteLegacyWorkspaceRoots` / `defaultAgentWorkspace` |
| 校验 | `src/impl.ts` · `validateAgentDef` / `validateConfig`；`src/bridge.ts` · `saveAgent` |
| 会话选择 | `src/bridge.ts` · `chatChoice` / `patchChatChoice` / `applyChatChoice` / `syncConversationRoute` / `loadPersistedChoices` / `persistAgents` |
| 目录 | `src/bridge.ts` · `agentCatalog` / `resolveAdapterModel` / `absorbCatalog` / `setExposedModels` / `setAutoDiscoverModels` / `autoExposeNewModels` / `broadcastExposure` |
| 斜杠缓存 | `src/bridge.ts` · `chatSessions` / `absorbCommands`；`src/client/store.ts` · `chatSessionCommands` / `loadChatSessions` |
