# 状态与持久化

本文是 [AGENTS.md](../AGENTS.md) 的展开层。运行时唯一落盘点是 `~/.dsh/dsh-ntr/`。

## 1. 落盘位置

`pluginStateDir()`（`~/.dsh/dsh-ntr`）下只有三样东西：

- `agents.json` —— agent 注册表 + 默认 agent + 每会话选择 + 插件私有偏好（`tagHalo`，经 `ui/tag-halo` RPC 读写；`approvalDeadlines`，经 `ui/approval-deadlines-set` 读写，见 [permissions.md §2.4](./permissions.md)）
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
- `mcpServers`（agent 级，可选）是**插件自己的归一形状**（`AcpMcpServerDef`）：每条必带 `name` 与 `transport`（`stdio` / `http` / `sse`），stdio 带 `command`（可选 `args` / `env`），http/sse 带 `url`（可选 `headers`）。它**不是** ACP 线格式：线格式的 stdio 变体**没有** `type` 字段（手写线格式的条目会被 agent 静默丢弃 —— 实测），所以归一形状给每条一个显式判别符，线格式的转换集中在 `bridge.ts` 的 `toAcpMcpServers`。`acp` 传输（agent 经 `mcp/message` 回调客户端）在校验期拒绝：稳定版 ACP SDK 的客户端侧没有这个方法，也没有 agent 声明 `mcpCapabilities.acp`。
- **`mcpServers` 只校验、不改形状**（`validateMcpServers` 原样返回用户写的条目）。设置页把它当 JSON 文本持有，并拿「将要送出的」与「已存的」比：宿主若替它补默认值（`args: []` / `env: {}`）或重排字段，那张卡就会永远判脏、每次保存都重启 agent。同理，条目里的 `name` 不得重名（它决定 agent 侧工具命名空间 `mcp__<name>__<tool>`）。
- **宿主侧 MCP 不经这条路**。宿主自己的 MCP 桥（`@deepseek-ai/dsh-mcp-client`）把工具注册进 `ctx.tools`，那是宿主模型面的工具，与 agent 进程内的 MCP 无关；插件既读不到那批服务器的配置（宿主不暴露可读服务），也无法把宿主 MCP 暴露给 agent（见 [architecture.md §5](./architecture.md)）。`mcpServers` 只是**额外**追加：agent 自己配置的 MCP 服务器照旧由 agent 读自己的配置文件。

## 3. 会话选择持久化

一个 DSH 聊天会话对它的 ACP agent 做的全部选择（`agentId` + `modelId` + `effort` + `mode` + `extraConfigs`）记在 `AcpConversationChoice`（`src/protocol.ts`），由 `BridgeManager.chatAgentIntent` 持有并持久化到 `agents.json` 的 `conversations` 键（`persistAgents` / `loadPersistedChoices`）。

- **严禁**只存内存 Map 或只写进 `LiveSession`：活会话在第一条消息之前根本不存在，而「对话前选模型」正是要在这个窗口里表达。
- **应用时机**：`applyChatChoice` 必须在 `createSession`（首轮建会话）与 `getOrCreateDshSession` 的 resume 分支各调一次。`session/new` 与 `session/load` 回的都是 agent 自己的默认值，不补这一步就是「选了 A 却跑 B」，且只从第二条消息才生效。同样两条路径还必须调 `lockChatAgent`，锁与 pick 在同一条记录里（见 [architecture.md §7](./architecture.md)）。
- **失效 model 必须拦截，严禁回落**：发送前 `staleModelChoice` 用会话**最新** `configOptions` 校验（agent 发布了**非空** choices 却不含该值即命中；没有选择器 / choices 为空时无从校验，保留原有 best-effort）；命中就以 `model_unavailable` 失败，**不发送 prompt**，并保留 pick——芯片与 picker 继续指着用户选的值，用户改选后才能继续。首轮零输出照常回滚锁。`applyChatChoice` 对失效 model 只跳过应用、**不删 pick、不镜像成别的模型**；活会话上的 `setChatSessionModel` 直接拒绝失效值（不写记录）。失效 **effort** 仍按旧策略：经 `dropStalePick` → `patchChatChoice` 从记录删除并广播一次 `agent/notice`（它不决定用哪个模型）；该通知进入设置页「运行日志」，不占顶部横幅。`exposedModels` 里的失效值保留（模型回来时仍算已选）。
- **请求路径**：`syncConversationRoute` 把 pick 的 **model 半**写进 `routeBindingRegistry().conversations`（`modelId ?? agentId`），否则 guard 的改写只拿到裸 agent id，对话前选的变体会被静默丢掉。该函数**只增不减**：没有 pick 的会话保留 turn 路径 pin 的「实际服务过它的 agent」，删掉会让回放默认 provider。
- **切 agent 清空派生选择**（仅锁定之前）：首轮前 `bindChatAgent` 在 agentId 变化时丢掉 `modelId` / `effort` / `mode` / `extraConfigs`——它们是上一个 agent 的词汇（变体来自它的 catalog、等级来自它的 `thought_level`、模式 id 来自它的 `session/set_mode` 列表、额外项来自它的 configOptions），带过去就是让新 agent 收到它从没提供过的值。同一 agent 重复绑定则保留。
- 全部经 `patchChatChoice` 这一个入口写，**严禁在某个 setter 里手抄字段清单**——`mode` 正是这样漏掉的：四个控件三个持久化，唯独它每次重启回到 agent 初始模式。
- **读取面**：`session/chat-list` 回 `choice`，`AcpStore.chatChoice` 落状态；`describeRoute` 活会话优先、pick 兜底。composer 的 model / 思考 chip 不能以 `bound !== undefined` 为渲染条件（那是「对话前无法选择」的直接成因），改为 `routed`（活会话 **或** pick **或** `chatBoundAgent` **或** 插件默认 agent）再加各轴自己的条件。高级底座的当前值读 `advancedOptions(catalog, choice)`：`choice.extraConfigs` 覆盖 `catalog.extras[].currentValue`，且只在该 choice 属于 catalog 的 agent 时生效。
- **显示的默认值就是首轮要跑的值**：没有 pick 的会话，composer 显示 `catalog.currentModel` / `reasoning.defaultEffort` / `extras[].currentValue`；`session/new` 回的是 agent 自己的默认值，两者可能不同。`getOrCreateDshSession` 的 create 路径必须在 `createSession` **之前**捕获显示值（`displayedChatDefaults`），在新会话提供这些值时写成该会话的 pick（`seedChatChoiceFromCatalog`：只补缺失字段，显式 pick 永远优先；新会话不再提供的值跳过，由 `absorbCatalog` 把显示纠正为实际值），再 `applyChatChoice`。`streamPrompt` 记录 `session.modelId` 时也要用 pick 的 variant / 会话自报的模型，**严禁**写回裸 agent id——裸 id 会让芯片回落到 agent 级 catalog，被同一 agent 的其他会话改掉。
- **不移植 agent 级偏好层**：agent 级默认已由 `agent/catalog` 的 `reasoning.defaultEffort` 与自报 `currentValue` 表达，再加一层会造出「用户没选过却以为选过」的第三种事实源。

## 4. 模型目录（agent/catalog）

- **只读内存，绝不 spawn、绝不顺手起探测**。`agentCatalog` 是渲染路径，composer 每次 store 变更都调它。这里只要有一丝自发起探测的余地，「打开页面」就等于「启动 N 个 agent」，picker 会把那些进程如实报成「已连接」。`bootstrapCatalogs()` 现在是空实现（保留只为不改宿主入口的调用点）。
- 探测只允许三种**有手势**的来源：
  1. `agent/probe-models`（设置页按钮，或会话模型菜单末尾的「刷新目录」行——一次点击一个 agent；**打开菜单本身仍是纯缓存读**）；
  2. 某 agent **自己的** `session/new` / `session/load`（用户正在跟它说话，进程本来就在）；
  3. 旧 schema 的磁盘缓存——**不重探**，而是被 ② 顺带修好（`absorbCatalog` 清 `catalogStale`）。
- **`agent/cached-models` 是同一份内存的第二个读口**（`BridgeManager.cachedAgentModels`）：返回某 agent 最后一次观测到的目录（无则 `null`），供设置页模型区常驻显示「全部模型」。它同样**绝不 spawn**，也**不在**上面三条手势清单里——只读缓存；刷新仍由 `agent/probe-models` 承担。注意探测在「答案没变」时会保留旧 `updatedAt`，所以面板的「新增 N / 移除 M」必须由点击前后两份列表对比得出，不能靠 `updatedAt` 变化。
- 客户端 `loadAgentCatalog` 的调用点必须先判定「这条会话真的指向某个 agent」：`routeAgentId` 有答案即可（活会话 / pick / `chatBoundAgent` / **插件默认 agent**）。默认回落**不是**「别人的目录」：guard 的 `agent/request` 改写就是用它，且 `agent/catalog` 纯内存、绝不 spawn。**严禁**的是借 `agents[0]` 之类的名字读一条没有 agent 会服务的会话。`/` 菜单的懒读同理，按 `chatAgentFor` 找到实际会服务这条会话的 agent。测试：`tests/bridge.spec.ts` 的 "NEVER spawns an agent just because a catalog was read"。
- **结构**：`base`（裸 `agentId` = agent 默认模型）+ `exposedModels` 过滤后的 `variants` + agent 自己的 `thought_level` 作为 `reasoning` + 其余 select / boolean 作为 `extras`（`CATALOG_SCHEMA = 3`；旧缓存仍可读并标记待修复）。boolean 带 `kind: 'boolean'`、`choices: []`，`currentValue` 编码为 `'true'` / `'false'`（catalog 全体保持字符串类型），即使它自称 `category: thought_level` 也不进 `thought` 槽——等级控件没有可选等级，进槽等于让控件消失。`resolveAdapterModel` 对已知 agent 的任何输入都不得 throw（过期变体降级为裸 id 条目），仅对未配置 agent throw；`exposedModels` 过滤只作用于 `agentCatalog` 的变体展开（`base` 永不过滤），严禁影响 `resolveAdapterModel`。
- **变体按需**：未设置 / 空 = 只留 `base`。真实 agent 动辄数百个 choice，默认全暴露在无搜索的菜单里就是列表风暴。供应商 `group` 只能来自 agent 自己返回的 ACP `SessionConfigSelectGroup` 标签，严禁从名称前缀 / value 路径 / 家族词猜测（任何供应商都可能供应别家模型）。
- **热更新**：真实会话观察到新目录时（`session/new` / `session/load` 响应、`config_option_update`），`absorbCatalog` 只要内容变化就必须广播 `catalog/updated`（`agentId` + `updatedAt`）；浏览器 `applyEvent` 收到后失效该 agent 的 `seatCatalogs` 并重读 `agent/catalog`（`loadAgentCatalog` 的 dedupe 保留）。不广播，首轮前打开的会话会永远停在旧列表（omp 实测 `session/new` 报 780，磁盘 / 浏览器停在 774）。
- `session/set_config_option` 的响应有两半，**严禁**整包喂进 `absorbCatalog`：`currentValue` 是这条会话的选择，升格成 agent 级 `reasoning.defaultEffort` 会让下一轮把座位刚选的思考等级静默改回去。但**形状**（哪些 option 存在、各有哪些 choice）必须经 `absorbCatalogShape`（纯函数 `mergeCatalogShape`）合进 agent 级目录并广播 `catalog/updated`——opencode 只给带 variants 的模型发 `thought_level`、切模型后又不推 `config_option_update`，这个响应是唯一来源，不吃形状思考等级芯片就永远不出现。合并规则：已存在槽位保留目录已知的 `currentValue`（观测 choice 列表不再提供它则退回 `null`）、新槽位一律 `null`；响应未提及的槽位 / extra 原样保留；不触发 `autoExposeNewModels`、不清 `catalogStale`（这不是 agent 级观测）。测试：`tests/impl.spec.ts` · `mergeCatalogShape`。
- **空 / 超大 `configOptions` 应答一律视为「非应答」**：`usableConfigOptions`（`src/impl.ts`，上限 `MAX_CONFIG_OPTIONS_BYTES` = 1 MiB）守卫六个入口——`session/new`、`session/load`、`session/set_config_option` 响应、`config_option_update` 通知、`absorbCatalog`、`absorbCatalogShape`。`[]` / `undefined` / 超限都不覆盖已知状态（catalog 与 `session.configOptions` 保持原样、不广播）：agent 在重置中 / provider 加载中会回空集，按「这个 agent 现在没有选项」处理会抹掉正在显示的模型列表与会话快照。测试：`tests/impl.spec.ts` · `usableConfigOptions`、`tests/bridge.spec.ts` · "EMPTY configOptions answer"。
- **DSH 自己的模型目录里没有 ACP 条目**（`AcpLlmAdapter.listModels('acp')` 返回空数组）。宿主目录构建是 per-request，一旦广告就等于对每条会话广告；`listModels` 契约本身写明目录是 advisory，空列表不影响解析、选择与流式。把 ACP 模型整体搬进 `agent/catalog` 是唯一结构性诚实的隔离。

## 5. 模型可见性筛选

- `exposedModels`（左全量 / 右已选）经 `agent/set-exposed-models` 原地修改 def 并持久化（`setExposedModels`），**不重启 agent 进程**。`agent/save` 会停掉子进程、杀死全部活动会话，只能用于命令 / 参数等真正需要重建的变更。
- 浏览器在保存后必须失效并重读该 agent 的座位目录缓存（`loadAgentCatalog`），否则已打开的对话仍列旧集合。
- **自动发现**（`autoDiscoverModels`，面板「自动发现新模型」开关，**默认开启**，经 `agent/set-auto-discover-models` 轻量切换）：`absorbCatalog` 把**相对上一份已知目录新增**的模型追加进 `exposedModels` 并持久化。首次观察到的目录只是基线（不会把 500 个模型一次全选），用户主动取消勾选的模型不会被复活。落盘只记录显式关闭（`autoDiscoverModels: false`）；缺省与 `true` 等价，均为开启。
- 任何 `exposedModels` / 开关变更（含自动追加）都必须广播 `agent/exposure`；浏览器据此更新设置卡 `currentConfig` 并失效 / 重读 `seatCatalogs`。`agent/status` 不携带这两个字段，不能替代它。

## 6. 斜杠命令缓存

- 宿主 `BridgeManager.chatSessions` 必须带 `availableCommands`（**整行**，不只 name / description），这是**活会话**的权威声明。
- 同一份声明必须经 `AgentBridge.onCommands` → `BridgeManager.absorbCommands` 按 agent 缓存、随 `model-catalog.json` 持久化，并由 `agent/catalog` 的 `commands` 字段下发：**首条消息之前没有会话可问**，没有这份缓存，新 NTR 会话的 `/` 菜单就是空的。
- 活会话声明永远优先于缓存；两者都没有时菜单为空，**严禁**为菜单去 spawn 或探测。
- 浏览器 `AcpStore.chatSessionCommands` 的 `undefined` 同时覆盖「还没读」与「没有活声明」，此时按 `chatAgentFor`（活会话 → 锁定 → 宿主 / 乐观绑定 → pick → 插件默认）找到 agent，再读 `agentCommands`（必要时懒读一次纯内存的 `agent/catalog`）。**严禁**把「没有会话」当成「agent 没有命令」。
- `loadChatSessions` 返回**在飞读取的 promise**（不是立即 resolve 的空壳），这样「我没有判定，去问」的调用才真能收到答案。

## 7. 未决权限询问（仅内存）

待答的权限询问是**运行时状态，不落盘**：`agents.json` 里与权限有关的只有 `approvalDeadlines`（设置页热改的期限与模式，见 [permissions.md §2.4](./permissions.md)）。宿主半区的 `PermissionLedger` 与浏览器 `UiState.permissions` 都随进程 / 页面消失，重连靠 `permissionReplayFrames` 重放未决项，并以 `permission/synced` 的活集合收尾。

- **帧字段**（实时广播与重放共用 `permissionRequestFrame`，字段逐项一致）：`requestId`、`sessionId`（ACP 会话 id）、`dshSessionId?`（`/acp` RPC 会话没有）、`toolCall`（原样保留）、`toolName`（宿主经 `permissionToolName` 派生，含 `_meta` 里 `toolName` 的兜底）、`reason?`（`permissionAskReason` 的一行摘要）、`options`（原样，含顺序与 `kind`）、`timeoutMode`（`wait` / `abort` / `auto`）、`deadlineAt?`（epoch ms；`wait` 模式没有期限时缺席）。重放帧缺一项，靠它过滤 / 显示的对话卡就会在重连后静默丢询问。
- `session/cancel`、`session/close`（先 settle 未决询问，再发 `session/close` 请求）、`releaseAll` 都会答复未决询问，卡片不会跨回合残留。
- `approvalRouted` 已删除（`agents/list` 不再上报）：设置页镜像卡片只看 `ui.permissions` 是否非空，见 [ui.md §10](./ui.md)。

## 8. 内置更新

更新是设置页版本徽标旁的一条链路，但**安装不是插件做的**：插件只问宿主「装的是什么」、问 registry「发布了什么」，再把安装**原样委托**给宿主 `pluginManager`。它从不下载包、不替换文件、不重启自己，也不拼 profile 路径（`src/update.ts` 的模块头就是这条边界）。HMR 下的「先卸再装」是宿主自己的更新语义（见下文 apply），不是自替换。

- **端点**：`plugin/update-check`（`{}`）与 `plugin/update-apply`（`{ version }`，经 `str(body, 'version', 64)` 后必须匹配 `/^\d+\.\d+\.\d+$/`，否则 `bad_payload`）都回 `PluginUpdateState`（`src/protocol.ts`）。状态机固定为 `unsupported` / `not-installed` / `source-install` / `managed` / `current` / `available` / `applying` / `busy` / `applied` / `restart-required` / `failed`；`current` 是**运行中**（内存里）的版本，`installed` 是磁盘版本，`latest` 是 registry 报出的稳定版目标，`registries` 是实际按顺序问过的 base（见下文「registry 链」）。
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
- **apply 委托与映射**：解包宿主的 `{ ok, value }` 信封后，`application === 'applied'` → `applied`，`'restart-required'` → `restart-required`（`installed` 取结果里的 `version`，缺失回落请求版本）；`overridden` / `cancelled` / 带 `error` / 缺失或未知 `application` → `failed`（如实说「manager 没给结果 / 给了不认识的状态」）。错误正文读 `error.diagnostic`，缺失才回落 `message`（RPC 信封的 `message` 只作兼容）。**失败绝不把目标版本写进 `installed`**：普通失败沿用资格阶段读到的磁盘版本（等于 `current`），回滚成功才显式写 `installed: current`，回滚失败则不带 `installed`。安装命中 registry 时经 `lastTarget` 透传给本次 `installBundle`（版本一致时）；**回滚不传 registry**，走宿主默认链（目标版本可能来自 fallback / 镜像）。check 在选版完成后会再查一次 `applying`：若安装已在 fetch 期间开始，晚到的结果返回 `applying`，不把 `available` 交给客户端。
- **HMR 下的 apply**：宿主在 HMR 持有时拒绝覆盖已安装 bundle（`already-installed`）。apply 因此按宿主原生更新语义执行：先 `installBundle`；遇 `already-installed` 且宿主有 `removeBundle` → `removeBundle('dsh-ntr')`（会卸载当前插件）→ 重试 `installBundle`。卸载结果必须是 `error` 缺失且 `application` 为 `applied` / `restart-required` / undefined，`cancelled` / `overridden` / `failed` 一律 `failed`。重试再失败时**先再 `removeBundle`（目标可能已落盘）**，再 `installBundle('dsh-ntr@'+current, { enabled: true })` 回滚（不带 registry）；回滚失败时消息说明「rollback also failed」且不带 `installed`。这不是自替换：所有文件操作都由宿主 pluginManager 完成，用户手动点击触发，`removeBundle` 只是宿主更新流程里卸载活模块的那一步——apply 的 RPC 因此可能在安装中被打断，客户端按下一条处理。
- **忙保护**：`isBusy` 接 `BridgeManager.hasActiveTurns`（有在飞的分段 turn 流，或任一 bridge 有活跃 turn）。**只有 apply 查忙**：安装可能要宿主重启，不能在别人回合中间做；有回合在跑时 check 照常查 registry。
- **源码安装**：`link:` / `file:` / `git+` / `workspace:` / 相对路径等是本地挂载、git 检出或本地包，registry 里的版本对它没有意义。状态固定 `source-install`、**永不升级**；UI 的版本徽标 `title` 与卡片只说「源码或本地安装，无法通过 registry 更新」，不假定用户用的是 git（`file:` / tarball 同样成立）。这是 per-bundle 的 `source` 事实，不按渠道猜。
- **客户端**：`checkPluginUpdate` 在 store 里做 10 分钟节流（`PLUGIN_UPDATE_TTL_MS`）与共享 in-flight promise（两个设置入口同 tick 挂载也只打一次）；`force` 只绕过 TTL，不绕过 in-flight。旧宿主没有端点时 `unknown endpoint` 被静默吞掉、返回 `undefined`，更新入口整块隐藏且不写 notice。`applyPluginUpdate` 用 `pluginUpdateApplying` 做重入保护（双击只装一次），先乐观写 `applying`；apply RPC 若因插件被卸载而中断，客户端把结果映射成 `restart-required`、**清掉 `installed`（磁盘状态未知）**、保留 `latest`、写一次 notice「更新请求已中断；请刷新页面确认当前版本。」，并重置节流时间戳让下一次 check 真正去问宿主。`pluginUpdateGeneration` 在 apply 开始时自增，晚到的 check 结果代次不符即丢弃——安装成功不会被旧 check 改回 `available`。
- **已知限制**：check 直接 GET packument，**不读 profile 的 `.npmrc` 认证 / 代理**；带凭据的 registry URL 会被 `registryPlan` 跳过（不把 token 交给 fetch，也不发给浏览器），私有 registry 需要认证时可能表现为不可达，`failed.message` 列出问过的 base（URL 已脱敏）。将来 DSH 若提供 `updateBundle` / `listVersions`，优先改用宿主接口而不是继续自建 registry 读取。
- **渠道与重启**：资格与安装都**按能力判断**，不按渠道：web 与桌面 DSH 的宿主半区同源，能不能更新只看 `ctx.get('pluginManager')`；插件不读渠道标记、不为 web / 桌面分支，装进哪个 profile 由 manager 决定，插件不拼路径、不认 profile 名。桌面 App 管理的 profile **不要**对它跑 `dsh plugin`（那份 profile 归 App 自己管）；两条渠道的安装都走这个进程内服务。重启**不能自动**：`applied` 让用户刷新页面，`restart-required` 让用户重启 DSH（桌面 App 退出重开 / 命令行重启 `dsh web`），插件既不重启宿主也不自替换。

## 代码索引

| 主题 | 位置 |
|---|---|
| 状态目录 | `src/bridge.ts` · `pluginStateDir` / `hostStateDir` / `stateDirExplicit` / `legacyStatePaths` / `migrateLegacyState` / `rewriteLegacyWorkspaceRoots` / `defaultAgentWorkspace` |
| 校验 | `src/impl.ts` · `validateAgentDef` / `validateConfig` / `validateMcpServers`；`src/bridge.ts` · `saveAgent` |
| 会话选择 | `src/bridge.ts` · `chatChoice` / `patchChatChoice` / `applyChatChoice` / `syncConversationRoute` / `loadPersistedChoices` / `persistAgents` |
| 目录 | `src/bridge.ts` · `agentCatalog` / `resolveAdapterModel` / `absorbCatalog` / `absorbCatalogShape` / `setExposedModels` / `setAutoDiscoverModels` / `autoExposeNewModels` / `broadcastExposure`；`src/impl.ts` · `parseCatalogOptions` / `mergeCatalogShape` / `usableConfigOptions` |
| 未决询问 | `src/bridge.ts` · `handlePermissionRequest`；`src/impl.ts` · `PermissionLedger` / `permissionRequestFrame` / `permissionReplayFrames`；`src/client/store.ts` · `permissionsForSession` |
| 斜杠缓存 | `src/bridge.ts` · `chatSessions` / `absorbCommands`；`src/client/store.ts` · `chatSessionCommands` / `loadChatSessions` |
| 内置更新 | `src/update.ts` · `UpdateService` / `check` / `apply` / `bundleEligibility` / `isRegistrySpec` / `registryPlan` / `pickUpdateTarget` / `compareVersions`；`src/index.ts` · `setUpdateService`；`src/bridge.ts` · `pluginUpdateCheck` / `pluginUpdateApply` / `hasActiveTurns` / `PLUGIN_VERSION`；`src/impl.ts` · `dispatchRpc`（`plugin/update-*` 分支）；`src/client/store.ts` · `checkPluginUpdate` / `applyPluginUpdate`；`src/client/panel.tsx` · `PluginUpdateBadge` / `PluginUpdateCard` / `updateBadgeText` / `updateCardVisible` |
