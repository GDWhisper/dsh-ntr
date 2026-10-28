# AGENTS.md

`dsh-ntr` 是 DeepSeek Harness (DSH) 的 ACP（Agent Client Protocol）客户端插件：宿主端子进程桥接 + 浏览器 UI。功能与背景见 [README.md](./README.md)。

> 代码位置引用一律用「文件 + 符号名」（可 grep 定位），不用行号——行号会随每次 diff 漂移失效。

## 怎么读这份文档

本文只放**心智模型、硬约束摘要、目录、命令、测试约定**。实现细节在 `docs/agents/`，按改动主题取用：

| 文档 | 什么时候读 |
|---|---|
| [architecture.md](./docs/agents/architecture.md) | 改消息走向、会话绑定、工作区、preset 外壳、agent 锁定 |
| [protocol.md](./docs/agents/protocol.md) | 改子进程、超时、取消、崩溃恢复、空闲释放、启动命令、ACP 数据折叠 |
| [ui.md](./docs/agents/ui.md) | 改 composer 座位、芯片、mode 控件、NTR 视图、斜杠菜单、设置页 |
| [permissions.md](./docs/agents/permissions.md) | 改权限映射、审批卡片（对话 dock / 设置镜像）、审批时限、权限座位 |
| [state.md](./docs/agents/state.md) | 改落盘、会话选择、模型目录 / 可见性、命令缓存 |
| [host.md](./docs/agents/host.md) | 改 `/acp` 通道、preset 声明、宿主服务探测、模型层 abstain |
| [paths.md](./docs/agents/paths.md) | 改任何路径判定 / 比较 / 规范化 |
| [retired.md](./docs/agents/retired.md) | 想知道「为什么不能回到 X」，或看到幽灵符号 |
| [release.md](./docs/release.md) | 发版：bump 版本、打 tag、npm 发布、写 GitHub release note |

历史推导与实测日志：[acp-convergence.md](./docs/acp-convergence.md)、[acp-mode.md](./docs/acp-mode.md)、[acp-permission-and-sandbox.md](./docs/acp-permission-and-sandbox.md)。待办：[todo.md](./docs/todo.md)（本仓唯一待办清单，当前为空）。

**维护规则**：新增约束先在这里写一行规则 + 一个链接，细节写进对应文档。本文不写「某年某月修过什么」——那属于细节文档或收敛记录。

## 心智模型

**本质是借 DSH 的界面壳，跟 ACP agent 对话。DSH 提供的只有显示层，它的模型调用逻辑我们不参与。**

| 环节 | 属于谁 |
|---|---|
| 推理、工具执行、文件读写、权限决策 | 对端 ACP agent（独立进程，完全自治） |
| 会话身份、消息列表、输入框、侧栏 | DSH（我们只借显示层） |
| 模型选择、思考等级、权限档 | agent 自己的概念，不是 DSH 的模型目录 |

一句话边界：**DSH 原生功能我们只要显示层，聊天记录展示在主聊天平面，侧栏读用户点开的路径当作 agent 的工作区。**

反面轴：把 ACP 当成 DSH LLM 层的一个 provider。那根轴要求 ACP 会话先写一条 `provider=acp` 路由才能发消息，于是写路由污染全局默认模型、被目录门禁拒、原生座位必须遮蔽。约束 **8 / 15 / 17 / 20 / 22** 的旧形态就是为这条轴（以及同期的「宿主替 agent 裁决」）打的补丁。现行替代写在各条摘要里，旧形态与幽灵符号见 [retired.md](./docs/agents/retired.md)。

### 现行形态（速览）

1. **NTR 底座在 `conversation.input.model`**：只作首轮前启动 / 切换 agent 的入口，下拉只有 agent 列表。模型、思考等级、agent 自己的 mode 各有控件。底座占原生模型底座那个 cell（composer bar 行尾、提交键左边）。
2. **会话绑定走插件自己的映射**：`session/chat-bind` / `chat-model-set` / `chat-effort-set` / `chat-mode-set` 指向「这条会话由哪个 agent 服务」，不写 DSH 模型路由。消息仍走宿主 driver，绑定由 guard 的 `agent/request` waterfall 接到请求路径上。
3. **permission 原样映射**：agent 报什么就问什么，宿主不预先裁决，也没有本地代答开关。
4. **消息展示在主聊天平面，逐步切分交错如原生**：一个 ACP turn 按工具活动切成多个宿主 step——段以 `tool-call` 卡收尾即 `finish`，宿主执行卡（guard 虚拟工具答真实输出）后续跑，续跑段用 transcript 游标**续读同一个仍在飞的 `session/prompt`**（绝不新发 prompt），卡片因此夹在两个 assistant 节点之间。完整参数 / diff 卡仍在 NTR 视图 tab。→ [protocol.md](./docs/agents/protocol.md) / [acp-convergence.md §1.8](./docs/acp-convergence.md)
5. **NTR 会话跑 ACP preset 外壳**：不带工具、不带项目指令、不带 compaction；`agent/pre-step` 只放用户来源的内容。
6. **首轮开始即锁定 agent**：底座粉碎成 composer 上边缘的只读挂牌 `NTR · <agent>`；首轮零可见输出则回滚解锁。
7. **NTR 会话的 `/` 属于 agent**：菜单只列 agent 自己声明的命令，Enter 不被宿主认领。
8. **MCP 服务器由 agent 自己拉起**：agent 自带的 MCP 照旧生效；`AcpAgentDef.mcpServers` 只是额外追加（插件在建会话时把清单交给 agent）。MCP 工具**不在**宿主 `ctx.tools` 里，也不经 `tools/execute` 虚拟工具那条路 —— 与「NTR preset 不挂工具行」不矛盾。→ [state.md](./docs/agents/state.md) / [architecture.md](./docs/agents/architecture.md)

细节见 [architecture.md](./docs/agents/architecture.md) 与 [ui.md](./docs/agents/ui.md)。

## 关键目录

- [`src/index.ts`](./src/index.ts)：Cordis 插件宿主入口，挂载 `/acp` RPC 通道与 `/api/acp/stream` SSE 路由。
- [`src/protocol.ts`](./src/protocol.ts)：前后端共享契约（纯类型），**严禁引入 Node 专属库或运行时代码**。
- [`src/impl.ts`](./src/impl.ts)：纯宿主端逻辑（配置校验、环境组装、路径防越权、Transcript、EventHub），**严禁引入 Node 内置模块或 SDK**，必须由 `tests/impl.spec.ts` 覆盖。
- [`src/bridge.ts`](./src/bridge.ts)：宿主与 ACP 子进程的 stdio 通信桥，依赖 `@agentclientprotocol/sdk`。
- [`src/client/`](./src/client)：浏览器 React 扩展，**严禁引入 Node 内置模块或 ACP SDK**，通信只走 RPC / SSE。`acp-ui.tsx` 是座位共用结构 / 样式 / 菜单壳；`session-controls.tsx` 与 `acp-view.tsx` 分别实现 composer 底座与 NTR 视图；`permission-dock.tsx` 实现对话内的审批卡。
- [`presets/acp/`](./presets/acp)：随包发布的 NTR agent preset（bundle patch 声明 + `acp-guard.mjs`），属于 DSH 的 agent 平面组装，不是本插件运行时模块。
- **`~/.dsh/dsh-ntr/`**：运行时唯一落盘点：`agents.json`、`model-catalog.json`、`workspaces/`（见约束 28）。
- [`acp-workspaces/`](./acp-workspaces)：本仓开发 / 测试用的执行目录；运行时默认工作区是 `~/.dsh/dsh-ntr/workspaces`。
- [`lib/`](./lib)：构建产物，禁改。
- [`docs/`](./docs)：设计与收敛文档；本文件是索引层。

## 常用命令

- 提交前全量验证：`npm run prepack`（步骤见 [package.json](./package.json) `scripts`）
- 跑单个测试文件 / 用例：`npx vitest run tests/bridge.spec.ts -t "spawns, initializes"`
- 只重建浏览器 Bundle：`npx tsdown`
- 挂载到 DSH 本地实例：`dsh plugin --profile web add ./`

## 硬约束（摘要）

> 每条一行是规则，细节在链接文档。摘要与细节冲突时，以细节文档 + 代码为准，并修本文。

### 构建与入口（1–6）

1. **浏览器 Bundle 必须是 CJS 工厂函数**：`tsdown.config.ts` 保持 `format: 'cjs'`，banner/footer 用 `window.__ModuleLoader__.load({ id: 'dsh-ntr', factory: (require) => { … } })` 包裹。DSH 前端微内核靠惰性 CJS 模块表供依赖，裸 ESM 会在运行时解析失败。
2. **`src/index.ts` 必须具名导出**：`export const name` / `export const inject` / `export function apply`。Cordis 通过具名导出提取插件元数据，`export default` 会让加载静默失效。
3. **路由必须注册完整路径**：SSE 写 `path: '/api/acp/stream'`。WebServer 注册只查重不校验绝对路径，相对路径不报错但永远命不中，请求落入 SPA fallback，SSE 静默 404。
4. **`session/set_config_option` 响应必须反哺本地快照**：提取权威 `configOptions` 并广播 `session/meta`，不能只等事件。部分 agent 更新后不再推 `config_option_update`。→ [protocol.md](./docs/agents/protocol.md)
5. **ACP 错误必须优先解析 `error.data`**：`-32603` 的 `billing_error` / `rate_limit` / `auth_error` 在 `data` 里，只读 message 会丢原因。→ [protocol.md](./docs/agents/protocol.md)
6. **相对导入必须写 `.ts` / `.tsx` 后缀**：`rewriteRelativeImportExtensions` 只改写已带后缀的导入；无后缀在 `type: module` 的 `lib/` 产物里运行时 `ERR_MODULE_NOT_FOUND`。

### 配置、目录与状态（7–9、21、27、28、32）

7. **agent 定义必须过 `validateAgentDef` / `saveAgent`**：严格校验命令 / id / args，自动施加 `allowedCwdRoots`；默认工作区取 `defaultAgentWorkspace()`，**严禁把 `process.cwd()` 塞进 roots**。默认启动命令预设 `AGENT_PRESETS`（bridge.ts）与 `DEFAULT_KNOWN_PRESETS`（client/store.ts）是手拷贝，必须同步。→ [state.md](./docs/agents/state.md)
8. **【旧隔离前提已退役】ACP 模型不进 DSH 模型目录；模型面只走 `agent/catalog`**：`listModels('acp')` 返回空。`agent/catalog` **纯内存、绝不 spawn**；探测只允许三种有手势来源（设置页按钮或模型菜单「刷新目录」/ 该 agent 自己的 session new·load / 旧缓存被顺带修好）。变体按需、`exposedModels` 只做可见性过滤、目录变化必须广播 `catalog/updated`。→ [state.md](./docs/agents/state.md)
9. **可见性筛选走轻量 RPC**：`agent/set-exposed-models` / `set-auto-discover-models` 原地修改、不重启进程（`agent/save` 会杀全部活动会话）。自动发现只追加「相对上一份目录新增」的模型；任何变更都广播 `agent/exposure`。→ [state.md](./docs/agents/state.md)
21. **NTR preset 只能由 bundle patch 声明**：`package.json` 的 `dsh.bundle.patch` + `presets/acp/acp.patch.yml`。**严禁**再往 `~/.dsh/.agent-presets/` 复制文件，**严禁**新增「安装 / 修复 preset」入口。声明内插件名按 profile 基准解析，本地插件只能经包名子路径 `dsh-ntr/acp-guard` 引用。面板读宿主 roster。→ [host.md](./docs/agents/host.md)
27. **底部栏的选择属于「会话」且必须持久化**：`agentId` / `modelId` / `effort` / `mode` / `extraConfigs` 记在 `AcpConversationChoice`，落 `agents.json` 的 `conversations`。`applyChatChoice` 必须在 create 与 resume 两条路径调用；`syncConversationRoute` 把 model 半接到请求路径且只增不减；切 agent（锁前）清空派生选择；所有写入只经 `patchChatChoice`。agent 不再提供的 model **必须拦截本轮**（`model_unavailable`，不发送 prompt、保留选择、首轮零输出照常回滚锁），**严禁**自动换成另一个模型；失效 effort 从记录里删除并广播一次 notice。→ [state.md](./docs/agents/state.md)
28. **一切运行时落盘只在 `~/.dsh/dsh-ntr/`**：`agents.json` / `model-catalog.json` / `workspaces/`。位置一律经 `pluginStateDir()`（`DSH_NTR_STATE_DIR` 可覆盖），派生的老路径从它反推。迁移必须同时改写 agent 里的绝对路径并回写磁盘。→ [state.md](./docs/agents/state.md)
32. **agent 可声明额外的 MCP 服务器，但走插件自己的归一形状**：`AcpAgentDef.mcpServers` 每条必带 `name` 与 `transport`（`stdio` / `http` / `sse`；`acp` 传输**不支持**，客户端侧没有 `mcp/message`）。**三个建会话点（`createSession` / `probeConfigOptions` / resume 的 `session/load`）必须传同一份列表**——agent 把它们放进**进程级**作用域，一份空列表就会顶掉同一连接上活动会话的 MCP 工具。线格式在 `bridge.ts` 的 `toAcpMcpServers` 一次性转换（**stdio 线格式不带 `type`**，带了 agent 会静默丢弃；`env` / `headers` 是 `[{name,value}]` 数组）。宿主只校验不改形状（改形状会让设置页永远判脏）。宿主侧 MCP（`ctx.tools`）**不经此路**转发。→ [state.md](./docs/agents/state.md) / [protocol.md](./docs/agents/protocol.md)

### 进程与回合（10–12、19、23、26、29）

10. **进程死亡 ≠ 会话销毁**：崩溃只走 `releaseAll`（标记 released、广播 `session/released`），严禁删记录或广播 `session/closed`。对 released 会话的 prompt / setMode / setConfigOption 自动 resume（respawn + `session/load`）；先重置 transcript 并广播 `session/reset`，再发 load。→ [protocol.md](./docs/agents/protocol.md)
11. **生命周期事件必须带身份校验**：`child.exit` / `child.error` / `conn.closed` 三个触发器分别以 `this.child === child`、`this.conn === conn` 守卫。否则旧进程延迟的 exit 会杀掉刚 resume 的新进程。→ [protocol.md](./docs/agents/protocol.md)
12. **启动有超时、取消有强制定稿且必须带世代守卫**：`initialize` / `session/new` / `session/load` 经 `withStartupTimeout`（60s）；cancel 后 `armCancelFallback`（15s）强制 `turn/end`，触发时 `turnSeq` 已前进则不得动手，并解开 `settled` 闸门。粘滞取消（agent 秒回 `cancelled`）按「本世代是否 cancel 过」判定并原样重发。fs 错误用 `new RequestError(code, message, { message })`。→ [protocol.md](./docs/agents/protocol.md)
19. **空闲释放只针对没有活跃工作的进程**：只释放 `ready` 且无进行中 turn / 未结算取消 / 待答审批 / mode·config 命令在途 / 探测 / resume / 启动的 bridge。空闲 live 会话不阻止释放——走 `releaseAll` 挂起成 `released`，下一条消息经 `session/load` 恢复；未声明 `loadSession` 的 agent 例外，仍要求无 live 会话。释放静默、不广播 `agent/notice`。探测进程 5 分钟、聊天进程 30 分钟（`0` = 永不释放）。工作区就地搬迁仍要求无 live 会话。→ [protocol.md](./docs/agents/protocol.md)
23. **轮次何时结束由 agent 决定**：`turn/end` 只在 `session/prompt` 响应返回时发出，严禁按空闲强制定稿（cancel 兜底除外）。正常结束但零可见产出必须发一条告警文本，不让上游失败静默成空气泡。→ [protocol.md](./docs/agents/protocol.md)
26. **启动命令是一整条命令行；Windows 生成壳必须经 `cmd.exe`**：`codebuddy --acp` 整条粘贴是正确用法。`.cmd` 壳严禁直接 spawn（`EINVAL`），走 `windowsShimLaunch`（`cmd.exe /d /s /c` + `windowsVerbatimArguments` + 外层引号）；回收走 `killProcessTree`。→ [protocol.md](./docs/agents/protocol.md)
29. **ACP 下发的数据不许静默丢弃**：每种 `session/update` kind 都要有去处；`content` / `rawInput` / `arguments` 的字符串、对象、数组都算有值；diff 同时保留结构与文本；超限只截断且留标记；无卡片的通知每种类一行、变了才重发。→ [protocol.md](./docs/agents/protocol.md)

### 权限（13–15）

13. **审批只有一条管线：每一问都由插件自己接住并广播 `permission/request`（`auto` + `0` 到达即收场，不建条目）**：`AgentBridge.handlePermissionRequest` 为每一条询问建 `PermissionLedger` 条目并广播一次 `permission/request`（`auto` + `0` 的到达即收场除外；`requestId` / ACP `sessionId` / `dshSessionId?` / 原样 `toolCall` 与 `options`、宿主派生的 `toolName` / `reason?` / `timeoutMode` / `deadlineAt?`）；有 `dshSessionId` 的进对话 `conversation.input.dock` 上的 `PermissionDock`（按会话过滤），没有聊天身份的只留设置页镜像。**严禁再走宿主 `ctx.approval`，也不读宿主 approval policy**（`ask` / `never` 只管宿主自己的工具）：旧路由会收下问题却不渲染，默认 `wait` 又没有期限，turn 于是挂在完全不可见的地方（issue #2，旧形态见 [retired.md](./docs/agents/retired.md)）。**超时就地收场，严禁转移**：到点按 `permissionTimeoutMode`（**默认 `wait`**）结束这一问——`abort` 拒绝 / `auto` 按 option **kind 优先级**代答（挑不出合法选项则降级 `abort`）/ `wait` 不设期限。**只有 ONE 个等待窗口** `permissionTimeoutMs`（默认 300s）；**「不等待」（`0`）只属 `auto` 档**——请求到达即收场，**不建 ledger 条目、不发 `permission/request`**；`abort` 的 0 抬到最短真实等待 30s，`wait` 不看窗口。模式与窗口都在**询问开始时读一次**，已持定时器的询问不改口径。窗口与模式经 `ui/approval-deadlines` · `ui/approval-deadlines-set` 在设置页**热改**：覆盖值落 `agents.json` 的 `approvalDeadlines` 并压过 `cordis.patch.yml`，重置即回到基线。定时器到点必须留痕：**恰一条** `agent/notice` + **恰一条** `permission/expired`（对话里的收尾行）+ `permission/resolved`（`auto` + `0` 没有条目，也就没有最后这一帧，但前两条照发）。`permission/request` 只广播一次，SSE 连接时用同一个 `permissionRequestFrame` 按快照重放未决询问（字段逐字节一致，含 `dshSessionId` / `toolName` / `reason` / `timeoutMode` / `deadlineAt`）+ `permission/synced` 活集合收尾（刷新/新标签页否则永远看不到那张卡）；ACP request 的 `signal` 撤回必须结算该条目，`session/cancel` 与 `closeSession`（在 await `session/close` **之前**）必须 `settlePermissions`（ACP 规范：取消即答复未决审批 `cancelled`）。→ [permissions.md](./docs/agents/permissions.md) / [retired.md](./docs/agents/retired.md)
14. **审批 UI 归对话，设置页只做镜像与配置**：`PermissionDock` 挂在 `conversation.input.dock`，是主入口——按 `dshSessionId === 当前会话` 过滤、与 composer 卡同宽居中（槽位是整列宽，卡片套宿主 `--dsh-composer-side-clearance` / `--dsh-composer-card-max-width` 公式）；选项按 agent 原名原序渲染（含 Always Allow）、单独取消键答 `cancelled`、没有全局 Enter/Esc、有 `deadlineAt` 时显示倒计时、多条按到达顺序堆叠并由 CSS 限高滚动。设置页**仍配置时限卡，并提供可答复的跨会话镜像**：只要 `ui.permissions` 非空就渲染，不靠能力旗标（`approvalRouted` 已退役），没有聊天身份的询问只有这里能答。设置页没有权限策略开关：任何询问都必须交给人；唯一的时限卡片只有**两个控件**——「超时处理方式」（`wait` / `auto` / `abort` 三档互斥按钮，整宽排布，按钮文字不得折行）与「等待时长」（一根滑块，档位 不等待 / 30 秒 / 1 分 / 5 分 / 15 分 / 30 分 / 1 小时 / 6 小时，**「不等待」只在 `auto` 档出现**，`abort` 档从 30 秒起；`wait` 档下**不画滑块**，读数写「一直等待」）——并必须有一句话把两者说成一套（超过该时长仍未应答，将按上方所选的方式处理）。覆盖事实**挂被覆盖的那一行**，重置按钮**只有真的覆盖了才出现**。agent mode 控件在 `conversation.input.left`，不写可见标签、选项不依赖活会话、自带 ACP 闸门。agent 卡详情常挂载，工作区保存语义固定。→ [permissions.md](./docs/agents/permissions.md) / [ui.md](./docs/agents/ui.md)
15. **【裁决部分已退役】工作区即侧栏路径**：聊天会话的 `session/new` / `session/load` cwd 与子进程 `spawnCwd` 都必须是 DSH 会话自己的工作区，并以 `extraRoots` 传入（create 与 resume 都要）。prompt 严格等于用户文本，不叙述任何边界。agent 的 mode 只经 `session/chat-list` / `chat-mode-set` 与 `agent/catalog` 上报。DSH Access mode 裁决整条已删除。→ [architecture.md](./docs/agents/architecture.md) / [retired.md](./docs/agents/retired.md)

### 转发与 preset（16–17）

16. **只转发人说的话**：`selectForwardPrompt` 按 `message.source.kind === 'user'` 挑消息，严禁「最后一条 user 消息」（注入内容折在用户消息之后）。注入唤醒轮不发 NTR 轮次；`purpose !== undefined`（标题 / compaction）在 `getOrCreateDshSession` 之前以 `unsupported_purpose` 失败。→ [architecture.md](./docs/agents/architecture.md)
17. **【裁决部分已退役】NTR 模式 = agent preset，loop 不可替换**：`persona` 不挂工具 / 项目指令 / compaction；`agent/pre-step` 拒绝「strip 后仍有内容、却没有用户来源」的批次；`agent/request` 负责绑定改写。严禁 `ctx.agents.setFactory` 替换 loop，严禁声称 preset 能屏蔽非 ACP 模型。「是否 NTR」读会话日志 preset，严禁自建标记位。旧裁决形态见 [retired.md](./docs/agents/retired.md)。→ [architecture.md](./docs/agents/architecture.md)

### 绑定与默认 agent（22）

22. **【默认模型守卫已退役】插件只写自己的绑定与默认 agent**：`defaultAgentId` 是插件私有状态，删除 agent 必须清空。`session/chat-*` 只写插件映射，再由 guard 改写接到请求路径。插件完全不碰 DSH 模型层（不读目录、不写 `selectModel`、不广告模型）。旧默认模型守卫 / 路由强制 / 目录重试见 [retired.md](./docs/agents/retired.md)。→ [architecture.md](./docs/agents/architecture.md)

### 界面（18、20、30、33）

18. **对话内的 NTR 面只借显示层**：模型 / 思考等级 / 额外 config options 读 `agent/catalog`；哪条会话由哪个 agent 服务读插件绑定（`routeAgentId`，无答案时**严禁**用 `agents[0]` 填名字）；写入只走 `bindChatAgent` / `setChatSessionModel` / `setChatSessionEffort` / `setChatSessionConfig`，严禁 `directory.select` / `selectModel`。cluster 顺序固定为 `高级 → model → thought → agent`：首轮前 agent 底座是右端锚点（不能被挤没），额外选项收进模型左侧的「高级」底座；首轮锁定、底座退场后，model / thought 成为右端锚点。模型 picker 一行一个模型值，勾中的行必须写模型名。NTR 视图只读 `session/chat-transcript`。空状态要区分「没服务过」与「ACP 会话没了」。空 roster（宿主已答 `agents/list`）下底座**不消失**，菜单给「打开 NTR 设置」动作；`agentsLoaded` 之前不得把「未读取」当「未配置」。审批询问的 `PermissionDock` 卡也属于对话面（`conversation.input.dock`，按当前会话过滤），设置页只是跨会话镜像；`agents/list` 不再上报任何审批能力旗标。→ [ui.md](./docs/agents/ui.md) / [permissions.md](./docs/agents/permissions.md)
20. **【竞争式遮蔽已退役】座位靠 claim 接管，失败一律放开**：`createModelSeatClaim` 用 `entriesOfSlot` 核实 head，不中就有界重注册（`MAX_SEAT_CLAIMS`），注册经 `ctx.slots.inject`。只读舞台会话 `agentPreset === ACP_PRESET_ID`，切走即撤；`stagedSessionOf` / `rowAgentPreset` 兼容两代快照；服务 / 槽位 / 注册 / 渲染任何不确定都回到原生座位。`ACP_PRESET_ID` 三处同步。旧竞争式遮蔽见 [retired.md](./docs/agents/retired.md)。→ [ui.md](./docs/agents/ui.md)
30. **NTR 会话的 `/` 属于 agent**：只列 agent 经 `available_commands_update` 声明的命令，Enter 不被宿主认领，选中只插回草稿。实现只能运行时包装活的 `/` 来源（`slash-isolation.ts`），严禁注册第二个来源或替换 composer；命令清单只由一个来源承载；没有证据时 fail-open。命令声明还要按 agent 缓存进 `model-catalog.json`，供首条消息前使用。→ [ui.md](./docs/agents/ui.md) / [state.md](./docs/agents/state.md)
33. **设置页文案有预算上限**：一个控件的说明**一行讲完**，机制解释进代码注释与 `docs/agents/`，不进 UI。同页参照是「呼吸频率 10 字 / 挂牌光晕 14 字 / 对话外观导语 15 字」；审批时限卡从 211 字压到 86 字是基准线，现为**两个控件**（默认档 55 字）。覆盖事实**必须看得见**——`configured[key]` 挂**被覆盖的那一行**，用警告色，不与其它灰色小字同层；重置按钮**只有真的覆盖了才出现**。文案里**点名控件名**必须与可见标题一致（改名要同步）。→ [ui.md](./docs/agents/ui.md) / [permissions.md](./docs/agents/permissions.md)

### 路径（24）

24. **路径判定与比较必须走跨平台原语**：绝对路径用 `isAbsolutePath`（含盘符 / UNC / `//host/share`；`\\?\` 不算，报「cannot resolve」而非「does not exist」）；containment 用 `isUnderPath`（win32 折叠分隔符与大小写，POSIX 字节精确）。浏览器用 `isAbsolutePathLike` 手拷贝并做等价测试。严禁新增 `startsWith('/')` 类假设。→ [paths.md](./docs/agents/paths.md)

### 宿主接线（25）

25. **`/acp` 必须用 owner 显式的 `connection.register`**：`rpc.handle` 在 0.1.7-rc.x 桌面 composition 上抛 `cannot get property "webServer" without inject`，导致所有 `POST /acp/*` 变 HTTP 405。`register` 缺失或抛错才回落 `rpc.handle`；信封协议与鉴权仍由 Connection 实现。→ [host.md](./docs/agents/host.md)

### 依赖（31）

31. **ACP SDK 的 `zod` peer 必须是直接依赖**：SDK 入口加载时就会 `import` `zod`，而宿主 profile 的 pnpm 可能设 `autoInstallPeers: false`；只靠 peer 自动安装会在官方安装里缺包。`zod` 必须留在 `dependencies`，范围与 SDK 的 peer 一致（`^3.25.0 || ^4.0.0`）。→ [README.md](./README.md#安装)

## 边界与禁区

- **禁止修改 [`lib/`](./lib)**：会被 `npm run build` 全量覆盖。
- **禁止在 [`tsdown.config.ts`](./tsdown.config.ts) 取消 external**：`react`、`react/jsx-runtime`、`@deepseek-ai/cordis`、`@deepseek-ai/dsh-client-ui-slots` 必须由运行时提供，打包进去会破坏 context。
- **子进程环境按「同级 agent」处理**：默认继承完整宿主环境，再由 agent 自己的 `env` 按键覆盖（`src/impl.ts` · `childEnv`）。严禁重新引入隐式凭据过滤——依赖环境变量认证的 agent（如 pi 的自定义供应商）会静默丢掉整个供应商。将来若要最小权限，必须做成显式 per-agent 开关。

## 常见任务配方

- **新增 / 修改 ACP RPC**：`src/protocol.ts` 加契约 → `src/impl.ts` 加进 `AcpManager` 并在 `dispatchRpc` 路由 + 校验 → `src/bridge.ts` 实现调度 → `src/client/store.ts` 加调用并测状态流转。验证：`npx vitest run tests/impl.spec.ts tests/store.spec.ts`。
- **改 UI 与挂载槽位**：`panel.tsx` / `session-controls.tsx` / `acp-view.tsx` / `permission-dock.tsx` 调整组件 → `src/client/index.tsx` 经 `ctx.slots.inject` 管理注册（当前注册 `settings.section` 等，槽位清单见文件头注释）→ `npx tsdown` 验证 bundle。
- **扩展配置字段**：`AcpAgentDef` / `AcpPluginConfig`（protocol.ts）→ `validateAgentDef`（会重建对象，新字段必须纳入且 optional）→ `AgentSavePayload` + panel 的 `initialForm` / `buildPayload` / `payloadEquals` 三处同步 → `cordis.patch.yml`。**宿主只校验不改形状**：改了形状（补默认值、重排字段）会让设置页拿「将要送出的」与「已存的」比不上，那张卡永远判脏、每次保存都重启 agent（`mcpServers` 就是这条纪律的实例，见约束 32）。

## 环境前置条件

- **Node.js** `>= 22.12.0`（`package.json` `engines`；依赖 Web Streams API 与 Node 22+ 特性）。
- **Agent 密钥变量**：子进程默认继承完整宿主环境，agent 自己配置的 `env` 按键覆盖。

## 测试约定

测试在 [`tests/`](./tests)，以 `.spec.ts` 命名。按职责分文件：

- `impl.spec.ts`：纯逻辑单测，无子进程，秒级返回。
- `register.spec.ts`：Cordis 上下文注册，用 `fakeCtx()` 模拟宿主。
- `store.spec.ts`：前端状态机与消息块折叠。
- `bridge.spec.ts`：集成测试，用真实子进程跑 `tests/mock-agent.mjs` 验证 stdio ACP 全链路。
- `acp-view.spec.ts`：浏览器半区纯函数（diff / 空状态 / codec / 路径等价 / 审批期限事实）。会 import 客户端模块，浏览器侧纯逻辑放这里，不要塞进 impl.spec。
- `session-controls.spec.ts`：composer 芯片与菜单**说了什么**（`agentBaseChip` / `describeRoute` / `menuFor`）。
- `model-seat.spec.ts`：座位 claim 的装 / 撤 / 重取。
- `slash-isolation.spec.ts`：斜杠来源包装与 fail-open。

## 术语

- **Host Half / Browser Half**：DSH 插件双端架构，Node 宿主服务与浏览器 UI 模块。
- **Transcript**：宿主为每个会话维护的有界环形缓冲，用于重连后按 seq 补齐。
- **Model Catalog**：`agent/catalog` 下发的 agent 自己的 `model` / `thought_level` 面（`base` + `variants` + `reasoning`）。DSH 自己的模型目录里没有 ACP 条目。
- **exposedModels**：per-agent 的座位可见性过滤。空 = 只留 `base`；只影响 `agentCatalog` 的变体展开，不影响 `resolveAdapterModel`。

---

## 本文档有意未包含

- 依赖与版本：见 [package.json](./package.json)。
- TS 编译选项：见 [tsconfig.json](./tsconfig.json)。
- DSH 宿主机制（Cordis 生命周期、WebServer 路由、UI slots、patch 语义）：见 [dsh-plugin-development-guide.md](./docs/dsh-plugin-development-guide.md)。
- JSX 结构与 CSS 细节：见 [`src/client/panel.tsx`](./src/client/panel.tsx) 等实现文件。
- ACP 协议规范：查 `node_modules/@agentclientprotocol/sdk` 类型定义与官方文档。
