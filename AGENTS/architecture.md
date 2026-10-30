# 架构：只借显示层

本文是 [AGENTS.md](../AGENTS.md) 的展开层，回答「谁拥有什么、一轮消息怎么走、绑定与锁定怎么成立」。
历史推导与实测日志见 [acp-convergence.md](../docs/acp-convergence.md)、[acp-mode.md](../docs/acp-mode.md)。

## 1. 归属模型

**本质是借 DSH 的界面壳，跟 ACP agent 对话。DSH 提供的只有显示层，它的模型调用逻辑我们不参与。**

| 环节 | 属于谁 |
|---|---|
| 推理、工具执行、文件读写、权限决策 | 对端 ACP agent（独立进程，完全自治） |
| 会话身份、消息列表、输入框、侧栏 | DSH（我们只借显示层） |
| 模型选择、思考等级、权限档 | agent 自己的概念，不是 DSH 的模型目录 |

一句话边界：**DSH 原生功能我们只要显示层，聊天记录展示在主聊天平面，侧栏读用户点开的路径当作 agent 的工作区。**

反面轴（禁止照做）：把 ACP 当成 DSH LLM 层的一个 provider。那根轴要求 ACP 会话先写一条 `provider=acp` 的路由才能发消息，于是写路由污染全局默认模型、被 GUI 目录门禁拒、原生模型座位必须遮蔽。约束 8/15/17/20/22 的旧形态是为这条轴（以及同期的「宿主替 agent 裁决」）打的补丁，详见 [retired.md](./retired.md)。

### 1.1 现行形态（速览）

1. **NTR 底座在 `conversation.input.model`**：只作首轮前启动 / 切换 agent 的入口，下拉只有 agent 列表；模型、思考等级、agent 自己的 mode 各有控件。底座占原生模型底座那个 cell（composer bar 行尾、提交键左边）。座位与渲染见 [ui.md §1](./ui.md)。
2. **会话绑定走插件自己的映射**（§3）：不写 DSH 模型路由，消息仍走宿主 driver，绑定由 guard 的 `agent/request` waterfall 接到请求路径上。
3. **permission 原样映射**：agent 报什么就问什么，宿主不预先裁决，也没有本地代答开关（[permissions.md](./permissions.md)）。
4. **消息展示在主聊天平面、逐步切分交错如原生**（§2.2）：完整参数 / diff 卡仍在 NTR 视图 tab（[ui.md §5](./ui.md)）；续跑段续读同一个仍在飞的 `session/prompt`，绝不新发 prompt。
5. **NTR 会话跑 ACP preset 外壳**：不带工具、不带项目指令、不带 compaction；`agent/pre-step` 只放用户来源的内容（§5）。
6. **首轮开始即锁定 agent**：底座粉碎成 composer 上边缘的只读挂牌 `NTR · <agent>`；首轮零可见输出则回滚解锁（§7）。
7. **NTR 会话的 `/` 属于 agent**：菜单只列 agent 自己声明的命令，Enter 不被宿主认领（[ui.md §6](./ui.md)）。
8. **MCP 服务器由 agent 自己拉起**：agent 自带的 MCP 照旧生效，`AcpAgentDef.mcpServers` 只是额外追加；MCP 工具不在宿主 `ctx.tools` 里，也不经 `tools/execute` 虚拟工具那条路——与「NTR preset 不挂工具行」不矛盾（§5 末段、[state.md §2](./state.md)）。

## 2. 一轮消息的路径

### 2.1 只转发人说的话

`BridgeManager.streamPrompt` 必须用 `selectForwardPrompt`（`src/impl.ts`）按 `message.source.kind === 'user'` 挑消息。没有 source 的手工请求等同用户输入。

- **严禁**用「最后一条 `role === 'user'` 的消息」：宿主把上下文段折在用户消息**之后**，最后一条 user 消息实测是 `skill-catalog` / `agent-instructions` / system-prompt 快照。
- 只有注入消息的唤醒轮（goal / subagent / skill 注入）不发 NTR 轮次，直接以 `stop` 结束。
- `purpose !== undefined`（`session-title` / `compaction`）必须在 `getOrCreateDshSession` **之前**以 `unsupported_purpose` 失败。标题生成复用同一会话 route，不看 `purpose` 会把「起个标题」当成一轮真实 prompt。

### 2.2 展示：逐步切分，卡片夹在两个 assistant 节点之间

- agent 的文字与思考由 `streamPrompt` 发真正的 `text` / `reasoning` block chunk，经宿主 driver 折成 `assistant/live-chunk` 与 `assistant/message`，由原生聊天平面渲染。
- 工具活动发真正的 `tool-call` 块（`acpToolCallFromUpdate` / `acpToolCallDelta`：快照 + 前缀扩展 delta，每个 callId 一个 turn 内只开一张卡）。完整参数 / diff 卡仍在 NTR 视图 tab。
- **逐步切分**（[acp-convergence.md §1.8](../docs/acp-convergence.md)）：一个 ACP turn = 多个宿主 step。段内开过卡、且下一条非 tool 事件到达时切段（`block-end` + `finish(stop)`）；宿主 loop 落定消息 → 执行卡（guard 虚拟工具从共享注册表 `toolResults` 答真实输出，未到则 `waitForToolOutput` 挂起）→ 续跑。续跑批次（`isAcpToolContinuation`：最后 user 消息之后全是 tool 来源）由 `TurnStreamController.startSegment()` 用 transcript 游标补读段间事件再订阅，**绝不新发 `session/prompt`**。以卡收尾的 turn 由最后一个续跑段收口（指针行），避免空气泡。
- **turn 级语义跨段成立**：`turnSeq` 世代守卫、prompt slot（agent 未确认取消前不解开 `settled` 闸门）、段间事件只记账不推进游标（下一段重放补齐），全部在 `TurnStreamController`；`session/cancel` 后的强制定稿由 `AgentBridge.armCancelFallback` 按同一 `turnSeq` 守卫。
- **重述去重**：agent 会把整条 `tool_call` 重发多遍当进度（并行调用还会交错）。`seenCalls` 按 callId 一卡；重述只刷 `recordAcpToolOutput` 的输出记录（并唤醒等待中的虚拟工具）。无卡片的通知种类（plan / mode）同理，`announcedKinds` 每种类一行、文本变了才重发。

### 2.3 收尾

`turn/end` 的权威来源是 `session/prompt` 的响应。强制定稿只有两条受控路径：`session/cancel` 后的 `armCancelFallback`（人已经按过取消），与 `BridgeManager.reapStalledTurns` 的无活动看门狗（会话 running 且未关闭 / 未释放、段开着——控制器须属于同一个 `LiveSession`，stale 按不存在处理、`/acp` 无控制器按开着——无待答审批，且 agent 连续静默超过 `turnStallMs`；`activeToolCalls` 非空时 `turnStallToolMs`，按 `toolCallId` 计集合，并行调用等最后一个结束）。**开火只收口 turn、不杀进程**；杀进程只发生在下一条消息的 `prepareStalledSession` 善后：有 `loadSession` 走 `releaseAll` + `session/load`，没有则 `forceReset`（`/acp` 下次 prompt 报 `session_reset`）并告知上下文已丢；暂定首轮零可见产出被收口时锁回滚、会话关闭，notice 说明这一轮已丢弃、下一条消息新建 ACP 会话（不得承诺 resume）。正常结束但零可见产出必须显式告警。完整判据见 [protocol.md §6.1](./protocol.md)。

## 3. 会话 ↔ agent 绑定

`session/chat-bind` / `session/chat-model-set` / `session/chat-effort-set` / `session/chat-mode-set` 指向「这条 DSH 会话由哪个 agent 服务」，**不写任何 DSH 模型路由**。

发消息仍走宿主 driver（进日志的唯一路径）。driver 每轮按「pending selection → 上一条请求 header → 部署默认」解析路由，三者插件都不写，所以绑定必须自己接到请求路径上，否则：新会话发到部署默认 provider，跑过的会话永远回放旧 agent。

两层机制：

1. **guard 的 `agent/request` waterfall 改写**（`presets/acp/acp-guard.mjs`）
   - 把解析出的请求改写成绑定指向的 `acp/<agent>`。
   - 注册必须 `{ prepend: true }`：waterfall 外层后执行，其返回值才是 driver 看到的；harness 自己的 `installModelSelection` 先注册，只有最外层能让绑定赢。
   - 改写丢掉继承的 `reasoningEffort`：那是别的路由的 effort，agent 的思考等级走插件自己的轴，外来 effort 还会撞 adapter 校验。
   - 无绑定的会话回落插件默认 agent；连默认 agent 都没有就不改写（部署默认照旧）。
   - 绑定注册表经 `globalThis[Symbol.for('dsh-ntr.acp-binding')]` 跨模块实例共享（guard 由 Loader 独立加载，import 不共享）。`ACP_ROUTE_BINDING_KEY`（`src/bridge.ts`）与 guard 的 `BINDING_KEY` 是手拷贝，`tests/register.spec.ts` 断言两侧看到同一个注册表。
2. **adapter 自己的复查**（`BridgeManager.streamPrompt`）
   - driver 仍带来旧 agent id（旧 header 回放、guard 未挂载）时，`conversationRouteModel` 的绑定 model 串优先。
   - 材料化的默认 effort（`reasoning.defaultEffort`、`modelDefaultEffort`）不算用户选择，不得回写覆盖：catalog 缓存不随 per-session `set_config_option` 刷新，覆盖会把座位刚选的思考等级静默改回去。
3. **绑定显示**
   - `session/chat-list` 回 `boundAgentId`（宿主 `chatAgentFor`：intent + 活会话回落）。
   - 浏览器 `chatBoundAgent` 在点击成功当下乐观写入：活会话列表要等下一轮才物化新 agent 的会话，不乐观写就表现为「点击无效」。

## 4. 工作区

- **聊天会话的 cwd** 必须是该 DSH 会话自己的工作区（sidebar 选中的工作区 = 会话 header cwd = `sandboxPolicy.resolve` 报回的 `workspaceRoot`，经 `chatWorkspaceRoot` 取出）。**严禁**用 `def.cwd`（`~/.dsh/dsh-ntr/workspaces`）当聊天会话 cwd，否则 agent 的 Read/Glob/Bash 看不到用户项目。
- 该工作区必须以 `extraRoots` 加入本会话的 roots 校验（`resolveSessionCwd` 第 4 参），**create 与 resume 两条路径都要传**；resume 漏传会让崩溃后的会话带 `cwd_denied` 永远 park 在 released。
- 同一个工作区还必须作为 `spawnCwd` 传进 `AgentBridge.ensureReady`，让子进程自己的 cwd 也落在那里（`safeSpawnCwd`；`createSession` 第 3 参与 `doResumeSession` 两处都传）。有类 agent（实测 codebuddy）在进程启动那一刻就把 workspace 定死，`session/new` 的 cwd 对它太晚。
- 为搬工作区的就地重启只允许在 `isQuiet()` 时发生，且必须先广播 `agent/notice`；有 live session 的 bridge 不为搬工作区重启（卡死回收会重启进程，那是另一条路径，见 [protocol.md §6.1](./protocol.md)）。
- 探测（`probeConfigOptions`）、`agent/test`、`/acp` RPC 会话背后没有 DSH 会话，仍用 `def.cwd`。

## 5. NTR preset 外壳

NTR 模式表达为 agent preset（`presets/acp/acp.patch.yml` 的 `preset-acp` 行）：`persona` 行 `complete: true` + `includeRuntimeContext: false`，**不挂**工具行 / `agent-instructions` / `tool-skill` / plan-mode / todo / compaction / 委派行。

`acp-guard.mjs` 挂三个监听器：

- `agent/pre-step` 步进闸门：过滤注入内容；**拒绝「strip 后仍有内容、却没有用户来源」的批次**，`reject` 使 turn 以 blocked 收尾。空批次仍走原 completed 空转；无 source 的消息算用户输入。**唯一例外**：staged tool results 的每个 callId 都在共享注册表 `toolResults` 里（本行自己卡片的续跑步，§2.2 的逐步切分）——放行，adapter 会续读同一 prompt 而不是转发批次。
- `tools/execute` 虚拟工具（§2.2）：解析不到的工具名即时注册 agent 作用域虚拟工具，工具体从 `toolResults` 取真实输出，未到则挂 `waitForToolOutput`（记录 / turn settle / 30 分钟兜底解除）。真实工具与缺席的 `tools` 服务原样放行。
- `agent/request` 路由改写：见 §3。

纪律：

- **严禁**试图用 preset 替换 `dsh-agent-loop`（`ctx.agents.setFactory` 只允许一个 factory，第二个抛错）。
- **严禁**由 preset 或宿主侧宣称能屏蔽非 ACP 模型（`buildModelCatalog` 无 per-session 过滤 seam）。
- 「是否 NTR 会话」必须读会话日志的 preset（`sessionAgentPreset`，镜像 `dsh-agent-presets` 的 `resolveSessionPreset`，经 `setAcpModeResolver` 注入），**严禁**自建标记位。

**MCP 工具不在这层**。MCP 服务器由 **agent 进程自己**拉起与管理：要么是 agent 自己配置的那批（agent 读自己的配置文件，与本插件无关），要么是 agent 定义里 `mcpServers` 声明的那批（插件在 `session/new` / `session/load` 时把清单交给 agent，见 [protocol.md §1](./protocol.md)）。两种都在 agent 进程内，既不是宿主 `ctx.tools` 的工具，也不经 `tools/execute` 虚拟工具那条路 —— 所以「NTR preset 不挂工具行」与「NTR 会话能用 MCP 工具」并不矛盾。宿主侧 MCP（`dsh-mcp-client` → `ctx.tools`）**不经此路**转发：宿主不暴露那批服务器的可读清单，agent 也够不着宿主的工具注册表。

原「权限裁决也进 preset」的实现已退役：权限原样映射，见 [permissions.md](./permissions.md)。

## 6. 默认 agent

- 插件自己的默认 agent 是**插件私有状态**：`defaultAgentId`，存在 `~/.dsh/dsh-ntr/agents.json`，RPC `default/agent` / `default/agent-set`，面板 ★。删除 agent 必须同时清空该指针。
- 它只决定「新会话默认选哪个 agent」，与 DSH 的任何模型字段无关。插件**完全不碰**宿主的模型层：不读 `modelDirectories`、不写 `selectModel`、不广告 `listModels`。
- 没有绑定、没有 pick、没有默认 agent 时，`routeAgentId` 返回 `undefined`。那是一个答案，不是待填的洞：芯片**严禁**借 `agents[0]?.id` 填一个名字，否则芯片上写着某个 agent 而没有任何消息会送到它那里。

## 7. agent 锁定

一个会话一个 agent。

- **首轮开始时**（ACP 会话 materialize、prompt 发出前）锁定并广播 `chat/agent-locked`。判定走 `lockedAgentOf`（宿主 `lockedAgentId` → 活/挂起会话的 agent），**不拿插件默认 agent 或首轮前的 pick 当判据**，**不查 roster**（agent 被删除也不解锁）。
- 锁定发生在 `getOrCreateDshSession` 的 create 路径（`lockChatAgent` 并广播），不是点选时，但它是**临时的，直到首轮产生第一个可见块**。
- 首轮无任何可见输出就结束（报错、静默失败、取消、看门狗以 `INACTIVITY_TIMEOUT` 收口）：`TurnStreamController.settle`（用户取消时还有 `abortActiveSegment`）在合成空回合告警**之前**用真实的 `sawVisibleBlock` 判定并调 `rollbackFirstTurn`——删除 `locked`、`forgetDshSession`、关闭失败会话（不关就没法解锁：活会话被当作锁）、广播 `chat/agent-unlocked`。看门狗在 `BridgeManager.reapStalledTurns` 里按同一判据换掉自己的 notice：不承诺「下一条消息恢复会话」，而是说明这一轮已丢弃、下一条消息新建 ACP 会话。
- 一旦有可见输出，`chatChoice.locked` 随会话持久化。`bindChatAgent` / `setChatSessionModel` / `setChatSessionMode` 指向别的 agent、以及 `getOrCreateDshSession` 的 turn 路径一律以 `agent_locked` 拒绝。
- 锁定在 ACP 会话关闭、进程停止、宿主重启后仍然保留。
- 浏览器侧的表现与动效见 [ui.md](./ui.md) 的「底座退场与挂牌」。

## 8. 已退役的轴

不要重新引入 provider 路由、DSH Access mode 裁决、竞争式座位遮蔽、默认模型守卫。它们为何失败、留下了哪些幽灵符号，见 [retired.md](./retired.md)。

## 代码索引

| 主题 | 位置 |
|---|---|
| 消息选择 / 转发 | `src/impl.ts` · `selectForwardPrompt`；`src/bridge.ts` · `streamPrompt` |
| 工具卡快照 / delta / 输出注册 | `src/impl.ts` · `acpToolCallFromUpdate` / `acpToolCallDelta` / `acpToolCallArgsOf`；`src/bridge.ts` · `recordAcpToolOutput` / `waitForToolOutput`；详见 [protocol.md](./protocol.md) |
| 绑定 RPC | `src/impl.ts` · `dispatchRpc('session/chat-*')`；`src/bridge.ts` · `bindChatAgent` / `setChatSessionModel` / `setChatSessionEffort` / `setChatSessionMode` |
| 请求改写 | `presets/acp/acp-guard.mjs`；`src/bridge.ts` · `conversationRouteModel` |
| 工作区 | `src/index.ts` · `wireWorkspace`；`src/bridge.ts` · `chatWorkspaceRoot` / `getOrCreateDshSession` / `doResumeSession` |
| 锁定 | `src/bridge.ts` · `lockedAgentFor` / `lockChatAgent` / `rollbackFirstTurn` / `provisionalLock` |
| 默认 agent | `src/bridge.ts` · `defaultAgent` / `setDefaultAgent` |

## 目录索引

| 位置 | 是什么 |
|---|---|
| `src/index.ts` | Cordis 插件宿主入口：挂载 `/acp` RPC 通道与 `/api/acp/stream` SSE 路由，接线可选宿主服务 |
| `src/protocol.ts` | 前后端共享契约（纯类型）；严禁 Node 专属库或运行时代码 |
| `src/impl.ts` | 纯宿主端逻辑：配置校验、环境组装（`childEnv`）、路径防越权、Transcript、EventHub、目录解析 |
| `src/bridge.ts` | 宿主 ↔ ACP 子进程的 stdio 桥：进程、回合、绑定、锁、数据折叠 |
| `src/update.ts` | 内置更新：资格矩阵、registry 探测，把安装委托给宿主 `pluginManager`；不下载、不替换文件、不重启 |
| `src/client/` | 浏览器 React 扩展：`acp-ui.tsx` 座位共用结构 / 样式 / 菜单壳，`session-controls.tsx` composer 底座，`acp-view.tsx` NTR 视图，`permission-dock.tsx` 对话审批卡，`panel.tsx` 设置页，`model-seat.tsx` 座位 claim，`slash-isolation.ts` 斜杠隔离，`store.ts` 前端状态 |
| `presets/acp/` | 随包发布的 NTR agent preset（bundle patch 声明 + `acp-guard.mjs`），属于 DSH 的 agent 平面组装，不是本插件运行时模块 |
| `~/.dsh/dsh-ntr/` | 运行时唯一落盘点：`agents.json` / `model-catalog.json` / `workspaces/`（[state.md §1](./state.md)） |
| `acp-workspaces/` | 本仓开发 / 测试用的执行目录；运行时默认工作区是 `~/.dsh/dsh-ntr/workspaces` |
| `lib/` | 构建产物，禁改（`npm run build` 全量覆盖，CI 自己 build） |
| `docs/` | 历史推导与收敛记录（acp-convergence / acp-mode / acp-permission-and-sandbox）；现行文档在 `AGENTS/`，索引见 [AGENTS.md](../AGENTS.md) |
| `CHANGELOG.md` | 面向用户的版本净改动记录，只记确定性改动（[release.md](./release.md)） |

## 术语

- **Host Half / Browser Half**：DSH 插件双端架构——Node 宿主服务与浏览器 UI 模块。本仓对应 `src/index.ts` + `src/bridge.ts` 与 `src/client/`。
- **Transcript**：宿主为每个会话维护的有界环形缓冲（`transcriptMaxEntries`），用于重连后按 seq 补齐、续跑段补读段间事件。
- **Model Catalog**：`agent/catalog` 下发的 agent 自己的 `model` / `thought_level` 面（`base` + `variants` + `reasoning`）。DSH 自己的模型目录里没有 ACP 条目。
- **exposedModels**：per-agent 的座位可见性过滤。空 = 只留 `base`；只影响 `agentCatalog` 的变体展开，不影响 `resolveAdapterModel`。细节见 [state.md §5](./state.md)。

