# AGENTS.md

`dsh-ntr` 是 DeepSeek Harness (DSH) 的 ACP（Agent Client Protocol）客户端插件：Node 宿主侧用 `@agentclientprotocol/sdk` 桥接独立的 agent 子进程，浏览器侧是 React bundle（`src/client/`，CJS 工厂函数）；它只借 DSH 的界面壳，不参与 DSH 的模型调用。

- **裁决条款**：本文件与 [README.md](./README.md) 冲突时以本文件为准；本文件摘要与 `AGENTS/` 细节冲突时，以细节文档 + 代码为准，并在同一次提交里修正本文件。
- **代码位置一律用「文件 + 符号名」引用**（可 grep 定位），不写行号——行号会随每次 diff 漂移失效。

## 心智模型

**本质是借 DSH 的界面壳跟 ACP agent 对话：DSH 只提供显示层，模型调用逻辑不归我们。** 推理 / 工具 / 文件读写 / 权限决策归对端 agent 进程（完全自治）；会话身份 / 消息列表 / 输入框 / 侧栏归 DSH；模型选择 / 思考等级 / 权限档是 agent 自己的概念，不是 DSH 的模型目录。
**不要把 ACP 当成 DSH LLM 层的一个 provider**：那根轴要求先写 `provider=acp` 路由才能发消息，于是写路由污染全局默认模型、被目录门禁拒、原生座位必须遮蔽；现行做法是插件只写自己的绑定，由 guard 的 `agent/request` 改写接到请求路径上。
→ 归属模型、消息走向、绑定、工作区、preset 外壳、agent 锁定：[AGENTS/architecture.md](./AGENTS/architecture.md)。

## 快速命令

- 提交前全量验证：`npm run prepack`（typecheck + `vitest run tests` + build，见 [package.json](./package.json) `scripts`）
- 单文件 / 单用例：`npx vitest run tests/bridge.spec.ts -t "spawns, initializes"`
- 只重建浏览器 Bundle：`npx tsdown`
- 挂到本地 DSH：`dsh plugin --profile web add ./`

## 硬约束（摘要）

> 38 条编号全部有效；每条是规则摘要，细节与「为什么」在箭头指向的文档。

### 构建与入口（1–6）

1. **浏览器 Bundle 必须是 CJS 工厂函数**：`tsdown.config.mjs` 保持 `format: 'cjs'`，banner/footer 用 `window.__ModuleLoader__.load({ id: 'dsh-ntr', factory: (require) => { … } })` 包裹；DSH 前端微内核靠惰性 CJS 模块表供依赖，裸 ESM 在运行时解析失败。
2. **`src/index.ts` 必须具名导出 `name` / `inject` / `apply`**：Cordis 靠具名导出提取插件元数据，`export default` 会让加载静默失效。
3. **路由必须注册完整路径**：SSE 写 `path: '/api/acp/stream'`。WebServer 注册只查重、不校验绝对路径，相对路径不报错但永远命不中，请求落入 SPA fallback、SSE 静默 404。
4. **`session/set_config_option` 响应必须反哺本地快照**：提取权威 `configOptions` 并广播 `session/meta`，不能只等事件（部分 agent 更新后不再推 `config_option_update`）。→ [protocol.md §1](./AGENTS/protocol.md)
5. **ACP 错误必须优先解析 `error.data`**：`-32603` 的 `billing_error` / `rate_limit` / `auth_error` 在 `data` 里，只读 message 会丢原因（`describeError`）。→ [protocol.md §1](./AGENTS/protocol.md)
6. **相对导入必须写 `.ts` / `.tsx` 后缀**：`rewriteRelativeImportExtensions` 只改写已带后缀的导入，无后缀在 `type: module` 的 `lib/` 产物里运行时报 `ERR_MODULE_NOT_FOUND`。

### 配置、目录与状态（7–9、21、27、28、32）

7. **agent 定义必须过 `validateAgentDef` / `saveAgent`**：严格校验 command / id / args，自动施加 `allowedCwdRoots`；默认工作区取 `defaultAgentWorkspace()`，**严禁把 `process.cwd()` 塞进 roots**（宿主启动目录可能是 `$HOME`）。预设 `AGENT_PRESETS`（bridge.ts）与 `DEFAULT_KNOWN_PRESETS`（client/store.ts）是手拷贝，必须同步。→ [state.md §2](./AGENTS/state.md)
8. **【旧隔离前提已退役】ACP 模型不进 DSH 模型目录，模型面只走 `agent/catalog`**：`listModels('acp')` 返回空。`agent/catalog` 纯内存、**绝不 spawn**；探测只允许三种有手势来源（设置页按钮或模型菜单「刷新目录」/ 该 agent 自己的 session new·load / 旧缓存被顺带修好）；变体按需、`exposedModels` 只做可见性过滤、目录变化必须广播 `catalog/updated`。→ [state.md §4](./AGENTS/state.md)
9. **可见性筛选走轻量 RPC**：`agent/set-exposed-models` / `set-auto-discover-models` 原地改、不重启进程（`agent/save` 会杀全部活动会话）；自动发现只追加「相对上一份目录新增」的模型；任何变更都广播 `agent/exposure`。→ [state.md §5](./AGENTS/state.md)
21. **NTR preset 只能由 bundle patch 声明**：`package.json` 的 `dsh.bundle.patch` + `presets/acp/acp.patch.yml`。**严禁**再往 `~/.dsh/.agent-presets/` 复制文件，**严禁**新增「安装 / 修复 preset」入口；声明内插件名按 profile 基准解析，本地插件只能经包名子路径 `dsh-ntr/acp-guard` 引用；面板读宿主 roster。→ [host.md §2](./AGENTS/host.md)
27. **底部栏的选择属于「会话」且必须持久化**：`agentId` / `modelId` / `effort` / `mode` / `extraConfigs` 记在 `AcpConversationChoice`，落 `agents.json` 的 `conversations`；`applyChatChoice` 必须在 create 与 resume 两条路径调用，`syncConversationRoute` 把 model 半接到请求路径且只增不减，切 agent（锁前）清空派生选择，所有写入只经 `patchChatChoice`。agent 不再提供的 model **必须拦截本轮**（`model_unavailable`、不发送 prompt、保留选择、首轮零输出照常回滚锁），**严禁**自动换模型；失效 effort 从记录删除并广播一次 notice。→ [state.md §3](./AGENTS/state.md)
28. **一切运行时落盘只在 `~/.dsh/dsh-ntr/`**：`agents.json` / `model-catalog.json` / `workspaces/`；位置一律经 `pluginStateDir()`（`DSH_NTR_STATE_DIR` 可覆盖），派生的老路径从它反推；迁移必须同时改写 agent 里的绝对路径并回写磁盘。→ [state.md §1](./AGENTS/state.md)
32. **`AcpAgentDef.mcpServers` 走插件自己的归一形状**：每条必带 `name` 与 `transport`（`stdio` / `http` / `sse`；`acp` 传输**不支持**，客户端没有 `mcp/message`）。**三个建会话点（`createSession` / `probeConfigOptions` / resume 的 `session/load`）必须传同一份列表**——agent 把它放进**进程级**作用域，一份空列表会顶掉同连接上活动会话的 MCP 工具。线格式只在 `toAcpMcpServers` 转一次（stdio **不带 `type`**，带了 agent 静默丢弃；`env` / `headers` 是 `[{name,value}]`）；宿主只校验不改形状；宿主侧 MCP（`ctx.tools`）**不经此路**转发。→ [state.md §2](./AGENTS/state.md) / [protocol.md §1](./AGENTS/protocol.md)

### 进程与回合（10–12、19、23、26、29）

10. **进程死亡 ≠ 会话销毁**：崩溃只走 `releaseAll`（未 `closed` 的标记 released、广播 `session/released`；关闭在途的归 `closeSession` 删，标成 released 会被 resume 复活），**严禁**删记录或广播 `session/closed`。released 会话的 prompt / setMode / setConfigOption（`/acp` RPC 面）与聊天面的下一条消息自动 resume：**先**重置 transcript 并广播 `session/reset`，**再**发 `session/load`。聊天面的四轴写入（chat-mode/model/effort/config-set）对 released 会话**只记录不唤醒**，选择由 `applyChatChoice` 在下次恢复时应用。会话记录持久化在 `agents.json`（`chatSessions`），宿主重启后按 released 复原、照常可恢复，closed 的不落盘——重启不丢上下文。唯一例外是 `prepareStalledSession` 在 agent 未声明 `loadSession` 时的 `forceReset`（就地关闭 + `session/closed`）——那是重置，不是崩溃。→ [protocol.md §2](./AGENTS/protocol.md)
11. **生命周期事件必须带身份校验**：`child.exit` / `child.error` / `conn.closed` 分别以 `this.child === child`、`this.conn === conn` 守卫；否则旧进程迟到的 exit 会杀掉刚 resume 的新进程。→ [protocol.md §3](./AGENTS/protocol.md)
12. **启动有超时、取消有强制定稿且必须带世代守卫**：`initialize` / `session/new` / `session/load` 经 `withStartupTimeout`（60s）；cancel 后 `armCancelFallback`（15s）强制 `turn/end`，触发时 `turnSeq` 已前进则不得动手，并解开 `settled` 闸门；粘滞取消按「本世代是否 cancel 过」判定并原样重发；fs 错误用 `new RequestError(code, message, { message })`。→ [protocol.md §4](./AGENTS/protocol.md)
19. **空闲释放只针对没有活跃工作的进程**：只释放 `ready` 且无进行中 turn / 未结算取消 / 待答审批 / 在途命令 / 探测 / `session/new` 在途 / resume / 启动的 bridge。空闲 live 会话不阻止释放——走 `releaseAll` 挂起成 released，下一条消息经 `session/load` 恢复；未声明 `loadSession` 的 agent 例外，仍要求无 live 会话；释放静默、不广播 `agent/notice`；探测 5 分钟固定、聊天窗口可配（设置页「进程管理」1-60 分钟，默认 30；per-agent 显式值优先，留空 = 跟随全局，`0` = 永不释放）；工作区就地搬迁仍要求无 live 会话。→ [protocol.md §5](./AGENTS/protocol.md)
23. **轮次何时结束由 agent 决定，强制定稿恰有两条**：`turn/end` 正常只在 `session/prompt` 响应返回时发出；受控例外只有 cancel 后的 `armCancelFallback`（约束 12）与无活动看门狗 `BridgeManager.reapStalledTurns`——会话 running 且未关闭 / 未释放、无待答审批、段开着、agent 静默超过 `turnStallMs`（有在飞 `activeToolCalls` 用更长的 `turnStallToolMs`；`turnStallMs: 0` 关掉整个看门狗）时开火，带世代守卫只收口一次并广播一条 notice。**开火只收口 turn、绝不杀进程**：杀进程只在下一条消息的 `prepareStalledSession`——同 agent 还有别的活跃工作则拒绝本轮，支持 `session/load` 走 `releaseAll` + resume，不支持则 `forceReset`（`/acp` 报 `session_reset`，上下文已丢）；首轮零可见产出则回滚锁并说明该轮已丢弃、下一条消息新建 ACP 会话。**严禁**再加第三种按空闲计时的强制定稿；正常结束却零可见产出必须发一条告警文本。→ [protocol.md §6.1](./AGENTS/protocol.md)
26. **启动命令是一整条命令行；Windows 生成壳必须经 `cmd.exe`**：`codebuddy --acp` 整条粘贴是正确用法；`.cmd` 壳严禁直接 spawn（`EINVAL`），走 `windowsShimLaunch`（`cmd.exe /d /s /c` + `windowsVerbatimArguments` + 外层引号）；回收走 `killProcessTree`。→ [protocol.md §7](./AGENTS/protocol.md)
29. **ACP 下发的数据不许静默丢弃**：每种 `session/update` kind 都要有去处；`content` / `rawInput` / `arguments` 的字符串、对象、数组都算有值；diff 同时保留结构与文本；超限只截断且留标记；无卡片的通知每种类一行、变了才重发。→ [protocol.md §8](./AGENTS/protocol.md)

### 权限（13–15）

13. **审批只有一条管线：插件自己接住每一问并广播 `permission/request`**：`handlePermissionRequest` 建 `PermissionLedger` 条目（`auto` + `0` 到达即收场：不建条目、不发帧），**严禁再走宿主 `ctx.approval`，也不读宿主 approval policy**——旧路由会收下问题却不渲染，默认 `wait` 又没有期限，turn 就挂在完全不可见的地方。到点**就地收场**：`abort` 拒绝 / `auto` 按 option **kind 优先级**代答（挑不出合法选项则降级 `abort`）/ `wait`（**默认**）不设期限。
    只有一个等待窗口 `permissionTimeoutMs`（默认 300s；`0` = 不等待，**只属 `auto`**；`abort` 的 0 抬到 30s）；模式与窗口在询问开始时读一次；`ui/approval-deadlines` 热改，覆盖落 `agents.json` 的 `approvalDeadlines` 并压过 `cordis.patch.yml`。到点留痕**恰一条** `agent/notice` + `permission/expired`（再一条 `permission/resolved`）；SSE 连接按快照用同一个 `permissionRequestFrame` 重放未决项（字段逐字节一致）+ `permission/synced`；`signal` 撤回、`session/cancel`、`closeSession`（await `session/close` **之前**）都必须 `settlePermissions`。→ [permissions.md](./AGENTS/permissions.md) / [retired.md](./AGENTS/retired.md)
14. **审批 UI 归对话，设置页只做镜像与配置**：`PermissionDock` 挂 `conversation.input.dock`，按 `dshSessionId` 过滤、与 composer 卡同宽居中、选项原样原序（含 Always Allow）、单独取消键答 `cancelled`、没有全局 Enter/Esc、按到达顺序堆叠并由 CSS 限高；设置页只要 `ui.permissions` 非空就渲染可答复的跨会话镜像（没有聊天身份的询问只有这里能答），**没有权限策略开关**。
    时限卡只有两个控件——三档互斥按钮（整宽、文字不折行）+ 一根时长滑块（「不等待」只在 `auto` 档，`abort` 从 30 秒起；`wait` 不画滑块，读数「一直等待」），并有一句话把两者说成一套；覆盖事实挂被覆盖的那一行，重置按钮只有真覆盖才出现。agent mode 控件在 `conversation.input.left`，不写可见标签、选项不依赖活会话、自带 ACP 闸门；agent 卡详情常挂载，工作区保存语义固定。→ [permissions.md](./AGENTS/permissions.md) / [ui.md §10](./AGENTS/ui.md)
15. **【裁决部分已退役】工作区即侧栏路径**：聊天会话的 `session/new` / `session/load` cwd 与子进程 `spawnCwd` 都必须是 DSH 会话自己的工作区，并以 `extraRoots` 传入（create 与 resume 都要）；prompt 严格等于用户文本、不叙述任何边界；agent 的 mode 只经 `session/chat-list` / `chat-mode-set` 与 `agent/catalog` 上报；DSH Access mode 裁决整条已删除。→ [architecture.md §4](./AGENTS/architecture.md) / [retired.md](./AGENTS/retired.md)

### 转发、preset 与绑定（16–17、22）

16. **只转发人说的话**：`selectForwardPrompt` 按 `message.source.kind === 'user'` 挑消息，**严禁**「最后一条 user 消息」（注入内容折在用户消息之后）；注入唤醒轮不发 NTR 轮次；`purpose !== undefined`（标题 / compaction）在 `getOrCreateDshSession` 之前以 `unsupported_purpose` 失败。→ [architecture.md §2.1](./AGENTS/architecture.md)
17. **【裁决部分已退役】NTR 模式 = agent preset，loop 不可替换**：`persona` 不挂工具 / 项目指令 / compaction；`agent/pre-step` 拒绝「strip 后仍有内容、却没有用户来源」的批次；`agent/request` 负责绑定改写。**严禁** `ctx.agents.setFactory` 替换 loop，**严禁**声称 preset 能屏蔽非 ACP 模型；「是否 NTR」读会话日志 preset，**严禁**自建标记位。→ [architecture.md §5](./AGENTS/architecture.md) / [retired.md](./AGENTS/retired.md)
22. **【默认模型守卫已退役】插件只写自己的绑定与默认 agent**：`defaultAgentId` 是插件私有状态，删 agent 必须清空；`session/chat-*` 只写插件映射，再由 guard 改写接到请求路径；插件完全不碰 DSH 模型层（不读目录、不写 `selectModel`、不广告模型）。→ [architecture.md §3、§6](./AGENTS/architecture.md) / [retired.md](./AGENTS/retired.md)

### 界面（18、20、30、33、34、38）

18. **对话内的 NTR 面只借显示层**：模型 / 思考等级 / 额外 config options 读 `agent/catalog`；会话由哪个 agent 服务读插件绑定 `routeAgentId`（无答案时**严禁**用 `agents[0]` 填名字）；写入只走 `bindChatAgent` / `setChatSessionModel` / `setChatSessionEffort` / `setChatSessionConfig`，**严禁** `directory.select` / `selectModel`。cluster 顺序固定 `高级 → model → thought → agent`（首轮前 agent 底座是右端锚点、不能被挤没）；picker 一行一个模型值、勾中的行必须写模型名；NTR 视图只读 `session/chat-transcript`，空状态区分「没服务过」与「ACP 会话没了」；空 roster 下底座不消失，`agentsLoaded` 之前不得把「未读取」当「未配置」。→ [ui.md](./AGENTS/ui.md)
20. **【竞争式遮蔽已退役】座位靠 claim 接管，失败一律放开**：`createModelSeatClaim` 用 `entriesOfSlot` 核实 head，不中就有界重注册（`MAX_SEAT_CLAIMS`），注册经 `ctx.slots.inject`；只读舞台会话 `agentPreset === ACP_PRESET_ID`，切走即撤；`stagedSessionOf` / `rowAgentPreset` 兼容两代快照；任何不确定都回到原生座位；`ACP_PRESET_ID` 三处同步。→ [ui.md §1](./AGENTS/ui.md) / [retired.md](./AGENTS/retired.md)
30. **NTR 会话的 `/` 属于 agent**：只列 agent 经 `available_commands_update` 声明的命令，Enter 不被宿主认领，选中只插回草稿；实现只能运行时包装活的 `/` 来源（`slash-isolation.ts`），**严禁**注册第二个来源或替换 composer；命令清单只由一个来源承载；没有证据时 fail-open；命令声明按 agent 缓存进 `model-catalog.json` 供首条消息前使用。→ [ui.md §6](./AGENTS/ui.md) / [state.md §6](./AGENTS/state.md)
33. **设置页文案有预算上限**：一个控件的说明一行讲完，机制解释进代码注释与 `AGENTS/`，不进 UI；覆盖事实**必须看得见**——`configured[key]` 挂被覆盖的那一行、用警告色、不与其它灰色小字同层；重置按钮只有真的覆盖了才出现；文案里点名的控件名必须与可见标题一致。→ [ui.md §8](./AGENTS/ui.md) / [permissions.md §2.4](./AGENTS/permissions.md)
34. **界面颜色只走宿主 alias token，写死颜色只能出现在 `var()` fallback**：主题归宿主，插件不维护 JS 主题状态，**严禁**自写 `color-scheme: light dark`；状态色按宿主配对（`state-*-tertiary` 底 / `state-*-primary` 前景、diff 行 `file-diff-*-bg`、danger hover `interactive-bg-hover-danger`）；宿主没有 `--dsw-alias-text-*` / `button-primary-invert` / `font-mono`，分别用 `label-*` / `label-primary-foreground` / `--ds-font-family-code`。→ [ui.md §11](./AGENTS/ui.md)
38. **运行消息进日志，动作失败进横幅**：`agent/notice` 与会话释放只进设置页「日志」分区（浏览器内存、追加序、最多 200 条、刷新清空、未读圆点、空闲释放不记）；页顶横幅只承载用户动作（设置页动作与对话内 RPC）的失败。→ [ui.md §8](./AGENTS/ui.md)

### 宿主接线、路径与依赖（24、25、31）

24. **路径判定与比较必须走跨平台原语**：绝对路径用 `isAbsolutePath`（盘符 / UNC / `//host/share`；`\\?\` 不算，报「cannot resolve」而非「does not exist」）；containment 用 `isUnderPath`（win32 折叠分隔符与大小写，POSIX 字节精确）；浏览器用 `isAbsolutePathLike` 手拷贝并做等价测试；**严禁**新增 `startsWith('/')` 类假设。→ [paths.md](./AGENTS/paths.md)
25. **`/acp` 必须用 owner 显式的 `connection.register`**：`rpc.handle` 在 0.1.7-rc.x 桌面 composition 上抛 `cannot get property "webServer" without inject`，导致所有 `POST /acp/*` 变 HTTP 405；`register` 缺失或抛错才回落 `rpc.handle`；信封协议与鉴权仍由 Connection 实现。→ [host.md §1](./AGENTS/host.md)
31. **ACP SDK 的 `zod` peer 必须是直接依赖**：SDK 入口加载时就会 `import` `zod`，而宿主 profile 的 pnpm 可能设 `autoInstallPeers: false`；`zod` 必须留在 `dependencies`，范围与 SDK 的 peer 一致（`^3.25.0 || ^4.0.0`）。→ [README.md](./README.md)

### 发版、用量与内置更新（35、36、37）

35. **CHANGELOG 只记确定性的净改动**：每次发版在 [`CHANGELOG.md`](./CHANGELOG.md) 顶部加一节，内容与 GitHub release note 同一套话、都带提交号；只写这一版留下的**最终用户可见行为**——被推翻、回退或只在开发过程中存在过的中间形态一律不记。→ [release.md](./AGENTS/release.md)
36. **`usage_update` 是上下文占用，不是请求 token**：`used` / `size` 只写 `session.usage`（ACP 视图与 composer 占用环的 `used/size`，实时落点见 [ui.md §4.1](./AGENTS/ui.md)）；原生聊天流的 `usage` 块只能是按段估算的输出 token（正文 + 思考字符 ÷4，`inputTokens: 0`），**严禁**把 `size` / `used` 映射成 input/output（宿主的原生 ContextMeter 也不吃这条数据）；缓存命中率无数据源，工具参数不计入估算。→ [protocol.md §8](./AGENTS/protocol.md)
37. **内置更新只转述宿主的安装，绝不自己下载 / 替换 / 重启**：`plugin/update-check` 与 `plugin/update-apply`（只收精确且高于运行版本的 `x.y.z`）都回 `PluginUpdateState`，实现是 `src/update.ts` 的 `UpdateService`；数据源只有 `ctx.get('pluginManager')` 的 `listBundles()` / `registries()` 与直接 GET packument；安装与回滚只调 `installBundle('dsh-ntr@<version>', { enabled: true, registry? })`（HMR 下按宿主原生更新语义先 `removeBundle` 再重试，失败先 remove 再回滚）——**不是自替换**：文件操作全由 pluginManager 完成，且必须由人点击触发。
    资格**正向判定 registry spec**：按最后一个 `@` 拆开、只判 spec 半边；裸 `x.y.z` / 范围 / `*`·`x` / dist-tag 才可更新，含 `:` / `/` / `\` 或以 `.` 开头一律 `source-install` 永不升级；无 pluginManager / 缺方法 / 旧宿主不报 `source` → `unsupported`；`readOnlyReason` 或 `removable === false` → `managed`；磁盘版本经 `compareVersions` ≠ 运行版本 → `restart-required`（不冒充 latest）。
    check **不因对话在跑而 `busy`**（只有 apply 查 `BridgeManager.hasActiveTurns`）；`applied` / `restart-required` 为成功，`overridden` / `cancelled` / 带 error / 未知 `application` 一律 `failed`，错误正文优先 `error.diagnostic`；检查随设置页自动（10 分钟节流 + in-flight 去重），**安装必须人手点击**；**严禁**把 `pluginManager` 写进顶层 `inject`。→ [state.md §8](./AGENTS/state.md) / [ui.md §8.1](./AGENTS/ui.md)

## 边界与禁区

- **禁止修改 [`lib/`](./lib)**：构建产物，`npm run build` 全量覆盖，CI 自己 build，不提交。
- **禁止在 [`tsdown.config.mjs`](./tsdown.config.mjs) 取消 external**：`react`、`react/jsx-runtime`、`@deepseek-ai/cordis`、`@deepseek-ai/dsh-client-ui-slots` 必须由运行时提供，打包进去会破坏 context。
- **子进程环境按「同级 agent」处理**：默认继承完整宿主环境，再由 agent 自己的 `env` 按键覆盖（`src/impl.ts` · `childEnv`）。**严禁**重新引入隐式凭据过滤——依赖环境变量认证的 agent（如 pi 的自定义供应商）会静默丢掉整个供应商；将来要最小权限必须做成显式 per-agent 开关。
- **模块纯度**：`src/protocol.ts` 是纯类型契约，**严禁**引入 Node 专属库或运行时代码；`src/impl.ts` **严禁** Node 内置模块与 SDK，必须由 `tests/impl.spec.ts` 覆盖；`src/client/` **严禁** Node 内置模块或 ACP SDK，通信只走 RPC / SSE。

## 常见任务配方

- **新增 / 修改 ACP RPC**：`src/protocol.ts` 加契约 → `src/impl.ts` 加进 `AcpManager` 并在 `dispatchRpc` 路由 + 校验 → `src/bridge.ts` 实现调度 → `src/client/store.ts` 加调用并测状态流转。验证：`npx vitest run tests/impl.spec.ts tests/store.spec.ts`。
- **改 UI 与挂载槽位**：`panel.tsx` / `session-controls.tsx` / `acp-view.tsx` / `permission-dock.tsx` 改组件 → `src/client/index.tsx` 经 `ctx.slots.inject` 管理注册（槽位清单见文件头注释）→ `npx tsdown` 验证 bundle。
- **扩展配置字段**：`AcpAgentDef` / `AcpPluginConfig`（protocol.ts）→ `validateAgentDef`（会重建对象，新字段必须纳入且 optional）→ `AgentSavePayload` + panel 的 `initialForm` / `buildPayload` / `payloadEquals` 三处同步 → `cordis.patch.yml`。**宿主只校验不改形状**，否则设置页永远判脏、每次保存都重启 agent。

## 测试约定

测试在 [`tests/`](./tests)，`.spec.ts` 命名；其余按模块就近（`panel.spec.ts` 设置页、`update.spec.ts` 更新服务），浏览器侧纯逻辑一律放 `acp-view.spec.ts`，不要塞进 `impl.spec.ts`。

- `impl.spec.ts`：纯逻辑单测，无子进程，秒级返回。
- `register.spec.ts`：Cordis 上下文注册，用 `fakeCtx()` 模拟宿主。
- `store.spec.ts`：前端状态机与消息块折叠。
- `bridge.spec.ts`：集成测试，用真实子进程跑 `tests/mock-agent.mjs` 验证 stdio ACP 全链路。
- `acp-view.spec.ts`：浏览器半区纯函数（diff / 空状态 / codec / 路径等价 / 审批期限事实）。
- `session-controls.spec.ts`：composer 芯片与菜单**说了什么**（`agentBaseChip` / `describeRoute` / `menuFor`）。
- `model-seat.spec.ts`：座位 claim 的装 / 撤 / 重取。
- `slash-isolation.spec.ts`：斜杠来源包装与 fail-open。

## 环境前置条件

- **Node.js** `>= 22.12.0`（`package.json` `engines`；依赖 Web Streams API 与 Node 22+ 特性）；**Agent 密钥变量**默认继承完整宿主环境，agent 自己配置的 `env` 按键覆盖（见边界与禁区）。

## 按需文档索引（`AGENTS/`）

| 文档 | 何时读取 | 何时维护 |
|---|---|---|
| [architecture.md](./AGENTS/architecture.md) | 改消息走向、会话绑定、工作区、preset 外壳、agent 锁定、默认 agent，或要目录 / 术语索引 | 动了 `src/bridge.ts` 的 `streamPrompt` / 绑定 / 锁定、`presets/acp/acp-guard.mjs`、或新增顶层源文件 |
| [protocol.md](./AGENTS/protocol.md) | 改子进程、超时、取消、卡死收口（无活动看门狗）、崩溃恢复、空闲释放、启动命令、ACP 数据折叠 | 动 `AgentBridge` / `BridgeManager` / `TurnStreamController` 的生命周期、超时或 `session/update` 折叠逻辑 |
| [ui.md](./AGENTS/ui.md) | 改 composer 座位 / 芯片 / 挂牌、mode 控件、NTR 视图、斜杠菜单、设置页、主题色 | 动 `src/client/` 的槽位注册、菜单内容、可见文案或 CSS token |
| [permissions.md](./AGENTS/permissions.md) | 改权限映射、审批卡片（对话 dock / 设置镜像）、审批时限、权限座位、fs 围栏 | 动 `handlePermissionRequest` / `PermissionLedger` / 期限配置 / `PermissionDock` |
| [state.md](./AGENTS/state.md) | 改落盘、会话选择持久化、模型目录 / 可见性、命令缓存、内置更新 | 动 `agents.json` 结构、`agent/catalog`、`absorbCommands` 或 `UpdateService` |
| [host.md](./AGENTS/host.md) | 改 `/acp` 通道注册、preset 声明、可选宿主服务探测、模型层 abstain | 动 `src/index.ts` 的注入 / `register`、`presets/acp/acp.patch.yml` 或 `package.json` 的 `dsh` 字段 |
| [paths.md](./AGENTS/paths.md) | 改任何路径判定 / 比较 / 规范化，或 Windows 上遇到 `bad_cwd` / `cwd_denied` | 动 `isAbsolutePath` / `isUnderPath` / `canonicalizeFsPath` 或浏览器 `isAbsolutePathLike` |
| [retired.md](./AGENTS/retired.md) | 想恢复某个旧机制、看到幽灵符号，或不确定某符号是否已删 | 又退役一条轴时，把旧符号追加进幽灵清单 |
| [release.md](./AGENTS/release.md) | 发版：更新 CHANGELOG、bump 版本、打 tag、npm 发布、写 GitHub release note | 发布流程、版本规则或 CHANGELOG 口径变化 |

历史推导与实测日志：[acp-convergence.md](./docs/acp-convergence.md)、[acp-mode.md](./docs/acp-mode.md)、[acp-permission-and-sandbox.md](./docs/acp-permission-and-sandbox.md)。待办：[docs/todo.md](./docs/todo.md)（本仓唯一待办清单）。宿主机制见 [dsh-plugin-development-guide.md](./docs/dsh-plugin-development-guide.md)；依赖版本看 `package.json`，TS 选项看 `tsconfig.json`，ACP 规范查 `node_modules/@agentclientprotocol/sdk` 的类型定义。文档不记「某年某月修过什么」——版本净改动进 `CHANGELOG.md`（约束 35），推导进上述收敛记录；JSX / CSS 细节直接看实现文件。

## Git 提交

Conventional Commits，英文，正文写动机与影响：`feat(acp):` / `fix(update):` / `chore(release):` / `docs(release):`；改本文件或 `AGENTS/` 下任何文档的提交统一用 `docs(agents):` 前缀；`lib/` 是构建产物，不提交。

## 文档维护纪律

1. **先过筛，再落笔。** 只有"不知道就会写出错误代码"的信息准进本文件；其余一律写进 `AGENTS/` 并在上方索引登记触发条件。
2. **先改写，后新增。** 要加的东西先在现有条目里找落点：能改写的就改写，能替代的就删旧加新，确认是全新约束才新增。因事故或复盘新增的硬性规则不受此限，但加完必须在同一次改动里把等量旧内容外置到 `AGENTS/`。单次会话净增超过 10 行，收尾时逐条说明它为什么必须常驻本文件。本文件超过 150 行立刻外置，不许放宽上限。
3. **改代码就同提交改文档。** 动了 `AGENTS/` 里某份文档所描述的代码，同一个提交里更新那份文档；上方索引的"何时维护"列写什么就做什么。
4. **会话收尾必须报告。** 本次会话改过本文件或 `AGENTS/` 下任何文档，收尾时报告四件事：改了哪几份、行数变化、是否触发拆分阈值（单篇 >200 行 / 同主题 ≥3 篇 / 索引条目 >12 条）、孤儿文档与失效索引是否已清理。没改就不用报。
5. **见到垃圾当场修。** 不在任何索引中的 `AGENTS/` 文档、索引里指向不存在路径的条目，当场修掉，不许记成待办。
6. **不许删本段来省行数。** 本段同样适用上面五条；绕过它，就是把这份文件的下一次膨胀留给下一个会话。
