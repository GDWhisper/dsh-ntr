# 架构：只借显示层

本文是 [AGENTS.md](../../AGENTS.md) 的展开层，回答「谁拥有什么、一轮消息怎么走、绑定与锁定怎么成立」。
历史推导与实测日志见 [acp-convergence.md](../acp-convergence.md)、[acp-mode.md](../acp-mode.md)。

## 1. 归属模型

**本质是借 DSH 的界面壳，跟 ACP agent 对话。DSH 提供的只有显示层，它的模型调用逻辑我们不参与。**

| 环节 | 属于谁 |
|---|---|
| 推理、工具执行、文件读写、权限决策 | 对端 ACP agent（独立进程，完全自治） |
| 会话身份、消息列表、输入框、侧栏 | DSH（我们只借显示层） |
| 模型选择、思考等级、权限档 | agent 自己的概念，不是 DSH 的模型目录 |

一句话边界：**DSH 原生功能我们只要显示层，聊天记录展示在主聊天平面，侧栏读用户点开的路径当作 agent 的工作区。**

反面轴（禁止照做）：把 ACP 当成 DSH LLM 层的一个 provider。那根轴要求 ACP 会话先写一条 `provider=acp` 的路由才能发消息，于是写路由污染全局默认模型、被 GUI 目录门禁拒、原生模型座位必须遮蔽。约束 8/15/17/20/22 的旧形态是为这条轴（以及同期的「宿主替 agent 裁决」）打的补丁，详见 [retired.md](./retired.md)。

## 2. 一轮消息的路径

### 2.1 只转发人说的话

`BridgeManager.streamPrompt` 必须用 `selectForwardPrompt`（`src/impl.ts`）按 `message.source.kind === 'user'` 挑消息。没有 source 的手工请求等同用户输入。

- **严禁**用「最后一条 `role === 'user'` 的消息」：宿主把上下文段折在用户消息**之后**，最后一条 user 消息实测是 `skill-catalog` / `agent-instructions` / system-prompt 快照。
- 只有注入消息的唤醒轮（goal / subagent / skill 注入）不发 NTR 轮次，直接以 `stop` 结束。
- `purpose !== undefined`（`session-title` / `compaction`）必须在 `getOrCreateDshSession` **之前**以 `unsupported_purpose` 失败。标题生成复用同一会话 route，不看 `purpose` 会把「起个标题」当成一轮真实 prompt。

### 2.2 展示：逐步切分，卡片夹在两个 assistant 节点之间

- agent 的文字与思考由 `streamPrompt` 发真正的 `text` / `reasoning` block chunk，经宿主 driver 折成 `assistant/live-chunk` 与 `assistant/message`，由原生聊天平面渲染。
- 工具活动发真正的 `tool-call` 块（`acpToolCallFromUpdate` / `acpToolCallDelta`：快照 + 前缀扩展 delta，每个 callId 一个 turn 内只开一张卡）。完整参数 / diff 卡仍在 NTR 视图 tab。
- **逐步切分**（[acp-convergence.md §1.8](../acp-convergence.md)）：一个 ACP turn = 多个宿主 step。段内开过卡、且下一条非 tool 事件到达时切段（`block-end` + `finish(stop)`）；宿主 loop 落定消息 → 执行卡（guard 虚拟工具从共享注册表 `toolResults` 答真实输出，未到则 `waitForToolOutput` 挂起）→ 续跑。续跑批次（`isAcpToolContinuation`：最后 user 消息之后全是 tool 来源）由 `TurnStreamController.startSegment()` 用 transcript 游标补读段间事件再订阅，**绝不新发 `session/prompt`**。以卡收尾的 turn 由最后一个续跑段收口（指针行），避免空气泡。
- **turn 级语义跨段成立**：`turnSeq` 世代守卫、prompt slot（agent 未确认取消前不解开 `settled` 闸门）、`armCancelFallback`、段间事件只记账不推进游标（下一段重放补齐），全部在 `TurnStreamController`。
- **重述去重**：agent 会把整条 `tool_call` 重发多遍当进度（并行调用还会交错）。`seenCalls` 按 callId 一卡；重述只刷 `recordAcpToolOutput` 的输出记录（并唤醒等待中的虚拟工具）。无卡片的通知种类（plan / mode）同理，`announcedKinds` 每种类一行、文本变了才重发。

### 2.3 收尾

`turn/end` 只在 `session/prompt` 响应返回时发出；唯一允许的强制定稿是 `session/cancel` 后的 `armCancelFallback`。正常结束但零可见产出必须显式告警。见 [protocol.md](./protocol.md) 的「轮次收尾」。

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
- 就地重启进程只允许在 `isQuiet()` 时发生，且必须先广播 `agent/notice`；有 live session 的 bridge 保持原进程。
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

原「权限裁决也进 preset」的实现已退役：权限原样映射，见 [permissions.md](./permissions.md)。

## 6. 默认 agent

- 插件自己的默认 agent 是**插件私有状态**：`defaultAgentId`，存在 `~/.dsh/dsh-ntr/agents.json`，RPC `default/agent` / `default/agent-set`，面板 ★。删除 agent 必须同时清空该指针。
- 它只决定「新会话默认选哪个 agent」，与 DSH 的任何模型字段无关。插件**完全不碰**宿主的模型层：不读 `modelDirectories`、不写 `selectModel`、不广告 `listModels`。
- 没有绑定、没有 pick、没有默认 agent 时，`routeAgentId` 返回 `undefined`。那是一个答案，不是待填的洞：芯片**严禁**借 `agents[0]?.id` 填一个名字，否则芯片上写着某个 agent 而没有任何消息会送到它那里。

## 7. agent 锁定

一个会话一个 agent。

- **首轮开始时**（ACP 会话 materialize、prompt 发出前）锁定并广播 `chat/agent-locked`。判定走 `lockedAgentOf`（宿主 `lockedAgentId` → 活/挂起会话的 agent），**不拿插件默认 agent 或首轮前的 pick 当判据**，**不查 roster**（agent 被删除也不解锁）。
- 锁定发生在 `getOrCreateDshSession` 的 create 路径（`lockChatAgent` 并广播），不是点选时，但它是**临时的，直到首轮产生第一个可见块**。
- 首轮无任何可见输出就结束（报错、静默失败、取消）：`finishStream` 在合成空回合警告**之前**用真实的 `sawVisibleBlock` 判定并调 `rollbackFirstTurn`——删除 `locked`、`forgetDshSession`、关闭失败会话（不关就没法解锁：活会话被当作锁）、广播 `chat/agent-unlocked`。
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
