# 宿主接线

本文是 [AGENTS.md](../AGENTS.md) 的展开层，覆盖与 DSH 宿主平面的接线点：`/acp` 通道、agent preset 声明、可选服务探测、模型层 abstain、宿主升级排查（§5，**宿主升级后先读这一节**）。

## 1. `/acp` 通道注册

`ctx.connection.rpc.handle('/acp', …)` 在 0.1.7-rc.x 桌面 composition 上**必然失败**。

- `.rpc` getter 经 Cordis traceable shadow 把路由 owner 绑回 Connection 服务自己的 ctx（composition 里 `inject` 只有 `credentials` / `webRuntime`）。
- effect 回调里的 `owner.webServer` 服务查找从那里重新扎根，跨 isolate 围栏即抛 `cannot get property "webServer" without inject`。
- 宿主半区整条 entry 不激活，所有 `POST /acp/*` 落到 frontend-static 的 GET-only fallback（**HTTP 405**）。浏览器端表现为 `transport failure for /acp/<endpoint>: HTTP 405`。

**正确做法**：走私有的 `register(owner, channel, handler)`（类型上不在 `HostConnectionHandle` 公开面，用 `ChannelRegisteringConnection` 结构类型 + typeof 探测），并**显式传插件自己的 ctx**（它声明了 `webServer`）。

- `register` 缺失时回落 `rpc.handle`（老 cordis 无围栏，两条路等价）。
- `register` 存在但**调用抛错**时同样回落（视同缺失）。
- 返回值不是 effect 需要的 disposer 时，**保留这次注册**并交一个空 disposer（此时再调 `rpc.handle` 会重复注册同一前缀）。
- 信封协议、鉴权围栏、404 / 415 语义仍全部由 Connection 自己的路由实现，不得手写 webServer 裸路由复制协议。

诊断路径：`transport failure … HTTP 405` ⇒ frontend-static fallback ⇒ `/acp` prefix 路由未注册 ⇒ 宿主日志 `dsh-ntr: cannot get property "webServer" without inject`。

## 2. agent preset 声明

NTR 模式的存在形式只有一种：本包 `package.json` 的 `dsh.bundle.patch` 列出的 patch 里那条 `preset-<id>` 声明（当前为 `presets/acp/acp.patch.yml` 的 `preset-acp` 行），内容为 `name: '@deepseek-ai/dsh-agent-preset'` + `config.{id,name,description,order,plugins}`。

- **载体**：**严禁**再往 `$DSH_HOME/.agent-presets/<id>/` 复制 `preset.yml` / `agent.cordis.yml` 或任何别的文件。那个目录没有任何读取方，复制进去既不进 roster，也不证明模式可用。**严禁**新增「安装 / 修复 preset」的配置项或按钮。
- **解析基准**：`config.plugins` 的插件名按**声明者 Loader 的解析基准**（profile 目录）解析。相对路径（`./acp-guard.mjs`）会落到 profile 目录里不存在的文件上，导致整条声明激活失败、模式从选择器消失。随包的本地插件只能经**包名子路径**引用（`dsh-ntr/acp-guard` ← `package.json` `exports` 映射到 `presets/acp/acp-guard.mjs`）。`patch.insert` 顶层与 group 行才会被 app-boot 的 `anchorInsertedPluginNames` 改写成 patch 文件旁的绝对路径。
- **状态**：面板读**宿主 roster**（`ctx.agentPresets.list()` 的 `preset-acp` 行，`acpPresetStatusFromRoster` 折叠，激活失败时原样显示 `broken`）；服务缺席时 `preset/status` 答 `null` 让面板整块隐藏。`preset/install` 已随旧机制删除——`preset/status` 只读，且**严禁**在插件自己的 `apply()` 里调 `list()`（registry 审计要等 Host 树 settle，会等在自己身上）。

历史：0.1.7-rc.1 起 preset 改为 bundle patch 声明，旧的目录 roster 被移除。这次升级曾让 NTR 模式的 chip 直接消失，因为插件还在往旧目录复制文件、并按目录存在与否报告「已安装」。见 [acp-mode.md §2](../docs/acp-mode.md)。

## 3. 可选宿主服务的探测

`src/index.ts` 的 `export const inject` **只能**列插件真正依赖的服务。以下服务严禁写进去（缺服务会让插件整体加载失败），只能 `ctx.get` + `ctx.inject([...], …)` 后补注册：

- `sandboxPolicy` / `sessions` —— 工作区根解析（`wireWorkspace` 注入 `BridgeManager.setSessionWorkspaceResolver`，解析结果只有 `{ workspaceRoot }`，不含任何 mode / approval 语义）
- `sessions.append` / `subagent/catalog` —— detached ACP worker 的外部子代理目录事实（`wireSubagentCatalog` → `appendExternalSubagentCatalog`）：只写 `mode: 'external'`，无子会话 / activity / continuation；宿主没有该事件时 `append` 抛错即静默跳过。它写进宿主 session log，不落 `~/.dsh/dsh-ntr/`。
- `agentPresets` —— preset roster（`wirePresetRoster`）
- `agents` —— idle background drain 的唤醒入口（`wireChatAgent` → `BridgeManager.setDshAgentResolver`）：`ctx.get('agents').list()` 按 `agent.session.id` 找到该聊天的 agent，调用 `agent.followup(...)` 注入一条隐藏唤醒消息；宿主没有该注册表或 `list` / `followup` 缺失时退回「drain 只进 transcript」。这是**唯一的** `agents` 调用点，与审批无关（见下方第 43 行说明）。
- 浏览器侧 `sessions` —— 经 `service<T>(name)` 在调用点惰性解析（见 [ui.md](./ui.md)）

服务缺失必须是**可用性下降**，不是加载失败；可选服务迟到时由 `ctx.inject` 补挂，不得让插件整体不激活。

**宿主审批服务不再是协作方**：权限询问全部走插件自己的 `PermissionLedger` 管线，`approval` 不再被探测或调用（`agents` 只服务于 §3 的 idle-drain 唤醒，与审批无关）；宿主的审批策略（`ask` / `never`）不再作用于 ACP 询问，`approval/asked|decided` 也不再为 ACP 询问写入（接受的取舍）。见 [permissions.md](./permissions.md)。

## 4. 不碰宿主的模型层

插件不读 `modelDirectories`、不走 `session/selectModel`、不写全局默认模型、不广告 ACP 模型。`session/chat-bind` 等 RPC 只写插件自己的映射；guard 在唤醒前用 `agent.model.select()` 把绑定记成该会话的模型选择（宿主 0.2.2+ 的 step preparation 会先固定路由），老宿主才用 `agent/request` waterfall 改写（见 [architecture.md §3](./architecture.md)）。

- `AcpLlmAdapter.listModels('acp')` 必须返回空数组；ACP 模型面走 `agent/catalog`（见 [state.md §4](./state.md)）。
- 已退役的默认模型守卫、路由强制、目录重试机制不要带回来，见 [retired.md](./retired.md)。

## 5. 宿主升级排查

**何时读**：DSH 升级后 NTR 报错或表现异常。只读这一节，按症状表定位后再翻对应文档；不要先通读 architecture。

**冒烟顺序**：`npm run prepack` 排除自身回归 → 确认宿主版本（桌面版看 `resources/app.asar` 内 `dsh/package.json`，CLI 跑 `dsh --version`）→ 新建会话选 NTR（roster 有 `acp`、composer 出现 ACP 底座）→ 选 agent 发「只回复 ok」→ 确认 NTR 面有实时数据（transcript 增量 / 审批卡）→ 再切一次模型并触发一个工具调用。

**版本分叉**：有 `agent.model.select` 的宿主（0.2.2+）在 step preparation 前固定路由，guard 用 `agent.model.select()` 写入；没有的宿主（0.2.1-）继续走 `agent/request` 改写。排查先看这一条属于哪边。

### 5.1 植入点（宿主契约面）

| # | 植入点 | 依赖的宿主契约 | 我们这一侧 |
|---|---|---|---|
| 1 | bundle patch / preset | `dsh.bundle.patch`；`@deepseek-ai/dsh-agent-preset` 的 `config.{id,name,description,order,plugins}`；`persona` 的 `complete` / `includeRuntimeContext`；插件名按 profile 基准解析 | `package.json`、`presets/acp/acp.patch.yml` |
| 2 | Cordis 入口与服务 | 具名 `name` / `inject` / `apply`；`ctx.connection.register(owner, '/acp', …)`；`ctx.connection.fetch.register({ path, methods, fetch })`，path 必须是 `/api/…` 完整路径；可选服务 `ctx.get` / `ctx.inject` | `src/index.ts` |
| 3 | LLM adapter | `ctx.llm.registerAdapter(['acp'], …)`；`LlmAdapter` 的 `providerInfo` / `providerRetryPolicy` / `imageRequestPricing` / `listModels` / `resolveModel` / `prepareCall` / `stream`（前三个在注册 / 计费路径被无条件调用）；`GenerateOptions`（`sessionId` / `messages` / `model` / `purpose` / `signal`）；`StreamChunk` 词表 | `src/bridge.ts` · `AcpLlmAdapter` / `streamPrompt` |
| 4 | 路由与步进 seam | `agent.model.select/current`；`agent/inbox/inserted` / `claimed` 与 `preStep` 取路由的先后；`agent/request` waterfall（仅老宿主）；`agent/pre-step` 的 decision 形状与 waterfall 顺序；**`decision.messages` 只是本步 inbox 认领 + loop 自己的 runtime-context 投影，不是请求消息**（adapter 拿到的 `GenerateOptions.messages` 来自 `session.deriveMessages()`，即整份 transcript）；工具结果**不进** next-step inbox（loop 只 stage 工具自己的 `additionalContexts`）；`step()` 无条件追加自己那份 runtime-context 投影，闸门剥不掉它，只能决定它的位置 | `presets/acp/acp-guard.mjs` · `selectBoundRoute` / 闸门 / 改写 |
| 5 | 工具卡执行 | `tools/execute` 的 `{ name, agent, callId }`；`ctx.tools.get(name, agent)` / `register(def)`；`message.source.kind === 'tool'` 与 `callId` | `presets/acp/acp-guard.mjs` |
| 6 | 会话事实 | `agent-preset/selected` 事件；`sessions.get` 的 `events`；`sessionPersistence.open` 的 `header`（冷会话 preset）；`agentPresets.list` | `src/index.ts` · `wireAcpMode` / `wirePresetRoster`；`src/impl.ts` · `sessionAgentPreset` |
| 7 | 浏览器槽位与宿主原语 | `conversation.input.model` / `left` / `overlay` / `dock`、`conversation.view`、`conversation.composer.dock`、`conversation.chat.assistant-actions`、`shell.overlay`；projection `agentPreset`；`ctx.slots.inject` / `entriesOfSlot` / `uiSession.adapter.current`；`sessions.fork` 与 `remote.$on('agent-preset/selected')` | `src/client/` |
| 8 | 插件管理 / 更新 | `pluginManager.listBundles()` / `registries()` / `installBundle()`；packument | `src/update.ts` |
| 9 | 子代理目录投影 | `conversation.session.header.actions` 的 list 条目 id `subagent-catalog`（宿主组件 + `inject` 的 `openChild` / `openChildAside` / `refreshProjection` + `locale` / `order`）；`useSessions(s => s.projectionsBySession)` → `[sessionId].values.subagentCatalog`（数组，每行 `{ id, createdAt?, label?, mode: 'external' }`）；`useSessionStatus` 原样透传 | `src/client/subagent-activity.tsx` · `createSubagentCatalogClaim` / `SubagentCatalogOccupant`；`src/client/subagent-panel.tsx` · `readSubagentCatalogProjection` / `OwnSubagentCatalog` / `SubagentDetailDialog` |
| 10 | 持久消息来源（V4） | `dsh-session-persistence-jsonl` 的 `assertV4MessageSources`：解释性消息槽要求 `source.kind` 非空且不是 `plugin`（旧 V3 `plugin` 只在迁移时改写成 `plugin:<name>`）；`form: 'notice'` 的 `summary` 是宿主上下文行的一行摘要，缺失时界面退回 opaque 字段列表 | `src/bridge.ts` · `wakeChatWithBackgroundReport` / `BACKGROUND_REPORT_SOURCE` / `BACKGROUND_REPORT_FORM`；`presets/acp/acp-guard.mjs` · `isBackgroundWake` |

非宿主面：ACP 协议与 `session/update` 词表在 `@agentclientprotocol/sdk`，升级依赖时看 SDK 类型，不走本表。

### 5.2 症状 → 先查

| 症状 | 先查 | 高发原因 |
|---|---|---|
| 首轮报 `agent/request proposed … after step preparation fixed …` | 宿主 `dsh-agent-loop` 的 `preStep` / `prepareRequest`；guard 的 `fixesRouteBeforeRequest` / `selectBoundRoute` | 路由固定得更早，或选择 API / 写入时点改名 |
| NTR 模式从选择器消失 / roster 行带 `broken` 诊断 | preset 行 schema、`persona` 字段、插件名解析 | preset config 改名、包名子路径不再可解析 |
| 所有 `POST /acp/*` 返 405 | `connection.register` 探测 | 入口 / 围栏变化，回落到 `rpc.handle` 也失败 |
| 实时面全静默（transcript 不增量、审批卡 / 释放与限流横幅不出现，但 RPC 可用） | `ctx.connection.fetch.register` 的 `/api/…` 路径校验与 SSE 响应形态 | 路由表或流式响应契约变化 |
| 启动即报 adapter 无效 / NTR 完全没有服务 | `LlmAdapter` 注册期成员（`providerInfo`、`providerRetryPolicy`） | 注册期必调成员新增或改名 |
| NTR 会话被宿主模型回答（没进 ACP） | `agent.model.select` 是否存在；`inbox/inserted` / `claimed` 是否仍早于路由读取 | 选择写入没生效，路由落到部署默认 |
| 回合以 `blocked` 收尾 / 工具续跑断 | 宿主 `turn()` 里 `preStep` 的 `reject` 分支（`blocked` 记在 `step/start` **之前**：日志里没有第二个 `step/start` 就是这条路）；guard 闸门的保留白名单 | 闸门把宿主新增的注入种类当成「外来批次」拒了——0.3.8 之前是 `runtime-context`，0.3.9 之前是 `dsh-mnemon`；改成白名单后不再依赖种类清单 |
| 工具卡输出永远是 `ran inside the ACP agent process` 占位符 | `recordAcpToolOutput` 的空记录、`waitForToolOutput` 的短路条件、ACP `tool_call_update.status` 词表 | 公告帧先落一条空记录，等待被空串立刻解除；agent 从不发终态 status 时会挂到 turn settle 才解除 |
| 后台任务完成唤醒主聊天时整轮失败 `format v4 message requires a producer-owned source kind` | `dsh-session-persistence-jsonl` 的 `assertV4MessageSources`（内部 `source()` 校验）；`dsh-session-format-v3-to-v4` 的 source 转换；`BACKGROUND_REPORT_SOURCE` | V4 拒绝 `source.kind: 'plugin'`（只属于旧日志迁移），新消息必须用生产者自己的 kind（`dsh-ntr`）；`notice` 还必须带 `summary` |
| NTR 对话里出现宿主注入（项目指令 / 记忆召回 / model changed） | `agent/pre-step` decision 形状、`message.source.kind` 常量 | 闸门 fail-open；runtime-context 那一条剥不掉（`step()` 自己会追加） |
| 模型底座 / 座位 / 选择器消失或露出原生控件 | 槽位名（含 `conversation.input.overlay`）、`entriesOfSlot`、projection key | 客户端槽位或投影改名 |
| 子代理面板退回宿主 trigger / 控制台出现 `subagent catalog:` fail-open 行 | `subagentCatalog` 投影与 `useSessions` 形状；`subagent-panel.tsx` 的 `readSubagentCatalogProjection` / `subagent-activity.tsx` 的 `SubagentCatalogOccupant` | 插槽条目 / id / projection key 改名，出现非 `external` 行或行形状变化 |
| 子代理 trigger 点了没反应 / 下拉「出现」但完全看不见 | 宿主 `ConversationRoot` 的 `titleRow` / `titleCluster` 是否带 `container-type` / `mask-image` / `overflow: clip`；`subagent-panel.tsx` 的下拉是否仍 portal 到 `document.body` | 0.2.2-rc.1 的标题行建立布局包含（fixed 改锚）、标题容器带遮罩（0.2.1-rc.5 都无），留在容器内的下拉被整块抹掉；宿主自己的目录菜单同样 portal |
| 审批卡 / 释放横幅不出现 | `conversation.input.dock`、`session/update` 折叠 | dock 槽位或事件形状变化 |
| 内置更新不可用 | `pluginManager` 方法面 | 服务或方法签名变化 |
| 保留名工具卡首现 `unknown tool` +「已添加工具」成对（旧版按不同工具名刷屏；现在只剩回落路径与升级前已存活的会话可能看到） | guard 是否在挂载时把保留名预注册进 preset 这一代的 scope；宿主 pre-step 是否冻结 `ResolvedToolSet`（`ctx.tools.resolve()` 快照，新宿主）vs `tools/execute` 里实时解析（0.2.1-rc.5 无快照） | 挂载早于本会话首份请求头时 schema 已进请求头，不再有首现噪音；只有挂载时 `tools` 服务未就绪或挂载注册失败、回落到执行阶段惰性注册时才复现（首现记 `unknown tool`、下次 `buildRequest()` 清单 diff 写 `tool-addition`）；升级 / HMR 前已存在的会话下一份请求头仍可能补记一次。guard 撞真实工具仍 fail-closed（`tools.get` 命中即返错、不 `return next()`） |
| Auto 权限档下每个 ACP 工具卡都失败（红色错误），宿主日志出现 `auto-review` 的模型调用 / 辅助调用拒绝 | guard 挂载预注册是否让 schema 进了请求头；Auto 的自动审查要调会话模型判风险；adapter 的 `purpose` 闸门与匿名辅助调用拒绝 | 挂载预注册后 schema 闸门能过，但 Auto 的宿主实验性自动审查还要调用会话模型判风险，而 NTR 会话的模型是外部 ACP agent。插件不能把宿主这段内部提示转发给 agent：adapter 在 `purpose` 闸门之后、建 ACP 会话之前拒收既无 `purpose` 也无 `sessionId` 的匿名辅助调用（0.2.2 的 `purpose: "auto-review"` 由既有闸门拒成 `unsupported_purpose`），审查得不出结论，宿主拒绝每一张卡；agent 自己的执行继续。**不是插件能修好的**——指引是改用非 Auto 权限档 |

### 5.3 读宿主源码

桌面版解包 `<安装目录>/resources/app.asar`（`npx @electron/asar extract <asar> <dir>`）后，先 `grep` 符号再读函数：

| 文件 | 看什么 |
|---|---|
| `dsh/node_modules/@deepseek-ai/dsh-agent-loop/lib/index.js` | `preStep`、`prepareRequest`、inbox 事件的发出顺序 |
| `dsh/node_modules/@deepseek-ai/dsh-agent/lib/index.js` | `AgentModel`、`modelSelectionProjectionDefinition`、`installModelSelection` |
| `dsh/node_modules/@deepseek-ai/dsh-api-session-controller/lib/index.js` | `composeAgent`（安装顺序）、`prompt`、`selectModel` |
| `dsh/node_modules/@deepseek-ai/dsh-llm/lib/index.js` | `LlmAdapter` 契约、`GenerateOptions` |
| `dsh-client-ui-*` / `lib/client.js` | 槽位名与 projection face |

常用 grep：`agent.model.select`、`agent/request proposed`、`agent/inbox/inserted`、`installModelSelection`、`registerAdapter(`、`conversation.input.model`。

### 5.4 维护

每次因宿主升级做兼容修复，在 §5.2 补一行「症状 → 先查 → 原因」，把新依赖的符号加进 §5.1；根因推导写 `docs/acp-convergence.md`，不进本文。

## 代码索引

| 主题 | 位置 |
|---|---|
| 通道 | `src/index.ts` · `/acp` 注册处 / `ChannelRegisteringConnection` |
| 服务探测 | `src/index.ts` · `wireWorkspace` / `wirePresetRoster` |
| preset | `presets/acp/acp.patch.yml`；`package.json` · `dsh.bundle.patch` / `exports`；`src/impl.ts` · `acpPresetStatusFromRoster` / `ACP_PRESET_SOURCE`；`src/bridge.ts` · `setPresetRosterReader` / `presetStatus` |
| 模型层 abstain | `src/bridge.ts` · `AcpLlmAdapter.listModels` |
