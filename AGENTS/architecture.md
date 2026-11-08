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
2. **会话绑定走插件自己的映射**（§3）：不写全局默认模型，消息仍走宿主 driver；guard 在唤醒前用 `agent.model.select()` 把绑定记成会话的模型选择（老宿主才用 `agent/request` waterfall）。
3. **permission 原样映射**：agent 报什么就问什么，宿主不预先裁决，也没有本地代答开关（[permissions.md](./permissions.md)）。
4. **消息展示在主聊天平面、逐步切分交错如原生**（§2.2）：完整参数 / diff 卡仍在 NTR 视图 tab（[ui.md §5](./ui.md)）；续跑段续读同一个仍在飞的 `session/prompt`，绝不新发 prompt。
5. **NTR 会话跑 ACP preset 外壳**：不带工具、不带项目指令、不带 compaction；`agent/pre-step` 只放用户来源的内容（§5）。
6. **首轮开始即锁定 agent**：底座粉碎成 composer 上边缘的只读挂牌 `NTR · <agent>`；首轮零可见输出则回滚解锁（§7）。
7. **NTR 会话的 `/` 属于 agent**：菜单只列 agent 自己声明的命令，Enter 不被宿主认领（[ui.md §6](./ui.md)）。
8. **MCP 服务器由 agent 自己拉起**：agent 自带的 MCP 照旧生效，`AcpAgentDef.mcpServers` 只是额外追加；MCP 工具不在宿主 `ctx.tools` 里，也不经 `tools/execute` 虚拟工具那条路——与「NTR preset 不挂工具行」不矛盾（§5 末段、[state.md §2](./state.md)）。

### 1.2 CodeBuddy 的 A1 进程模型（现行实现）

`PER_SESSION_AGENT_IDS` 目前只含 `codebuddy`（`isPerSessionAgent(agentId)`）。其余 agent 仍是**一条连接、一个进程**：每个 scope 都折叠到裸 `agentId`，语义与 A1 之前一致。

**复合键**：`BridgeManager.bridges` 的键由 `bridgeKey(agentId, scope)` 生成——非 A1 返回裸 `agentId`；A1 返回 `agentId + '\u0000' + <kind>[:<token>]`。`BridgeScope` 四态：

| scope | 何时创建 | 谁回收 |
|---|---|---|
| `agent` | 非 A1 的唯一进程 | `stopAgent` |
| `chat` | 每条 DSH 聊天会话（`getOrCreateDshSession`，键含 `dshSessionId`） | `closeSession` / 首轮失败回滚 / `prepareStalledSession` 的善后 |
| `ephemeral` | `/acp` 的 `startSession`（键含 `randomUUID()` token）与匿名回合（token 固定 `anonymous`） | `closeSession`；`streamPrompt` 结算后的 `.finally` |
| `probe` | `probeAgentModels` 的目录探测 | 探测 `try/finally` 立即回收 |

`bridgeScopes` 是 `bridges` 键集合的伴生状态，**仅供测试与诊断**：生产代码 1 处声明、1 处写入、4 处删除，没有任何消费者；唯一读取方是 `tests/bridge.spec.ts` 的 3 处断言（`agent/delete` 与 `stopAgent` 用例比对 `bridgeScopes.size` 与 `bridges.size`）。运行时判定作用域的唯一权威是 `bridges` 的复合键与 `bridgeKey`。清理时应删字段并把那 3 处断言改为只看 `bridges` 键（或提供测试可见的派生 getter），**不要**为消除死代码在业务逻辑里接读取。

**启动清洗（只对 A1）**：`perSessionLaunchArgs` 删除 `--port <值>` 与 `--port=<值>`；`perSessionLaunchEnv` 按大写键名删除 `SERVER__PORT` / `SERVER__HOST`。原因是 CodeBuddy 的 ACP 模式会去绑 `127.0.0.1:6156`，每会话一个进程时必然 `EADDRINUSE`；stdio 传输不需要监听端口。

**生命周期**
- **创建**：chat 走 `bridgeForSession(session)`；同一 DSH 会话第一次发消息时创建自己的子进程。resume 路径复用同一 holder，绝不新建第二个 ACP 会话。
- **复用**：`streamPrompt` **不缓存** bridge；`initResult`、`claimTurn`、`beginTurn`、`runPrompt` 每处重新 `bridgeForSession(session)`，`onAbort` 只用 `bridgeOwning(...)` 查归属、**绝不创建进程**。
- **归属三态**：`bridgeOwning` 查 `hasSession` / `hasReleased` / `inflightResume`。恢复在途时 `getOrCreateDshSession` **await 同一个 `inflightResume`** 并复用同一 `LiveSession`；三态都未命中且 `dshSessionMap` 仍有 live 绑定，才 `forgetDshSession` 并抛 `session_orphaned`。
- **回收**：`pruneBridge` 先用 `isDiscardable()` 判定（holder 没有任何 live / released 会话且无活跃工作），再删 `bridges` / `bridgeScopes`，最后 fire-and-forget `bridge.stop('agent-stopped')`。调用点只有 `closeSession`、`rollbackFirstTurn`、`streamPrompt` 的 `.finally`、`probeAgentModels` 的 `try/finally`；非 A1 直接返回，不删 agent 槽。
- **首轮失败回滚**：`rollbackFirstTurn` 在 `closeSession(session, 'closed')` 落定后按 `keyOfBridge` 回收。若严格口径仍有待答请求（`hasActiveWork()`，按会话 id 计数），`pruneBridge` 拒绝删除，由 `streamPrompt` 的 `.finally` 补一次回收；空闲释放另用放宽口径 `hasActiveWork(false)`（见 [protocol.md §2](./protocol.md)）。
- **停止门禁**：`stopAgent` / `saveAgentNow` / `deleteAgent` 先把 `stoppingAgents` 对该 agent 加一；期间 `bridgeFor` 新建与已存在 holder 的外借全部以 `agent_stopping` 拒绝，**消息不排队**。停止只按停止前的快照键删 `bridges` / `bridgeScopes`，删除前做 `this.bridges.get(key) === bridge` 恒等校验；最后递减计数，下一条消息正常新建进程。
- **持久化恢复**：`loadPersistedChatSessions` 把每条 released 记录 `parkReleased` 到**它自己的** chat holder；进程重启后各会话仍各自独立。
- **探测即用即回收**：`probeAgentModels` 用 `probe` scope 拉起一次性子进程，`try/finally` 结束就 `pruneBridge`；5 分钟探测窗口只是未被显式回收时的兜底。

**隔离口径**：turn stream 清理与兄弟会话阻塞判定不再按 `agentId`，改为按 `sessionIdsOf(bridge)`——本 holder 的 live + released 会话 id 集合。A1 下别的 CodeBuddy 会话在跑不阻塞本会话，本会话的停止也不误删别的会话的流。会话 id 查找（`find` / `tryLocate` / `locateOrResume`）仍只按 `sessionId` 遍历全部 bridge、不按 agent 过滤，这是**已知取舍**，理由与启动条件见 [agent-scoped-session-lookup.md](../docs/plan/backlog/agent-scoped-session-lookup.md)。

## 2. 一轮消息的路径

### 2.1 只转发人说的话

`BridgeManager.streamPrompt` 必须用 `selectForwardPrompt`（`src/impl.ts`）按 `message.source.kind === 'user'` 挑消息。没有 source 的手工请求等同用户输入。

- **严禁**用「最后一条 `role === 'user'` 的消息」：宿主把上下文段折在用户消息**之后**，最后一条 user 消息实测是 `skill-catalog` / `agent-instructions` / system-prompt 快照。
- 只有注入消息的唤醒轮（goal / subagent / skill 注入）不发 NTR 轮次，直接以 `stop` 结束。
- `purpose !== undefined` 必须在 `getOrCreateDshSession` **之前**就地处理，绝不把辅助调用送进 ACP 会话（标题生成复用同一会话 route，不看 `purpose` 会把「起个标题」当成一轮真实 prompt）。分流：`session-title` 的提示词自带人类消息 JSON 数组（宿主 `dsh-session-title-llm`），`extractSessionTitlePlaceholder`（`src/impl.ts`）取首条折回占位标题（不发轮次、不 spawn；截 `SESSION_TITLE_PLACEHOLDER_MAX` 码点；设置开关 `ui/session-title-prefix` 默认开，开启时加 `SESSION_TITLE_PREFIX` 前缀并预留其码点，只影响下一次生成、宿主已接受的标题事件不改写；解析失败回落拒绝——宿主自己的文本兜底在部分版本如 2.0.22-next 不生效，issue #11 报备）；`compaction` 与未知 purpose 仍以 `unsupported_purpose` 失败。

### 2.2 展示：逐步切分，卡片夹在两个 assistant 节点之间

- agent 的文字与思考由 `streamPrompt` 发真正的 `text` / `reasoning` block chunk，经宿主 driver 折成 `assistant/live-chunk` 与 `assistant/message`，由原生聊天平面渲染。
- 工具活动发真正的 `tool-call` 块（`acpToolCallFromUpdate` / `acpToolCallDelta`：快照 + 前缀扩展 delta，每个 callId 一个 turn 内只开一张卡）。完整参数 / diff 卡仍在 NTR 视图 tab。
- **逐步切分**（[acp-convergence.md §1.8](../docs/acp-convergence.md)）：一个 ACP turn = 多个宿主 step。段内开过卡、且下一条非 tool 事件到达时切段（`block-end` + `finish(stop)`）；宿主 loop 落定消息 → 执行卡（guard 虚拟工具从共享注册表 `toolResults` 答真实输出，未到则 `waitForToolOutput` 挂起）→ 续跑。续跑批次（`isAcpToolContinuation`：最后 user 消息之后全是 tool 来源）由 `TurnStreamController.startSegment()` 用 transcript 游标补读段间事件再订阅，**绝不新发 `session/prompt`**。以卡收尾的 turn 由最后一个续跑段收口（指针行），避免空气泡。
- **turn 级语义跨段成立**：`turnSeq` 世代守卫、prompt slot（agent 未确认取消前不解开 `settled` 闸门）、段间事件只记账不推进游标（下一段重放补齐），全部在 `TurnStreamController`；`session/cancel` 后的强制定稿由 `AgentBridge.armCancelFallback` 按同一 `turnSeq` 守卫。**聊天面与 `/acp` 共用一个 prompt slot**：`BridgeManager.prompt` 也经 `bridge.beginTurn` 占槽，聊天 `claimTurn` 与 `/acp` 的 `turn_in_flight` 检查互斥（/acp 还拒 `running` 与未 settle 的活聊天控制器），`/acp` 在飞时聊天面不得发 `session/prompt`；同一聊天会话自己的回在飞时，宿主插话按插话语义取消当前回合后再重发（`reclaimChatPrompt`，[protocol.md §6](./protocol.md)）。
- **后台 drain 的正文归属**：CodeBuddy 的 unsolicited turn 见 [protocol.md §6.2](./protocol.md)；派发 detached worker 的回合见 [protocol.md §6.3](./protocol.md)——worker 自己的 `session/update`（带 `codebuddy.ai/parentToolCallId`）只进 transcript / ACP 视图，主平面收的是父回合的正文与 drain 的最终答案。主平面的唯一入口是 `adapter.stream`：等待中的用户回合把 drain 的正文折进自己的段（后台工具只进 transcript、不开卡），纯空闲 drain 只进 ACP 视图，**严禁**绕过 stream 凭空 append。
- **重述去重**：agent 会把整条 `tool_call` 重发多遍当进度（并行调用还会交错）。`seenCalls` 按 callId 一卡；重述只刷 `recordAcpToolOutput` 的输出记录（并唤醒等待中的虚拟工具）。无卡片的通知种类（plan / mode）同理，`announcedKinds` 每种类一行、文本变了才重发。

### 2.3 收尾

`turn/end` 的权威来源是 `session/prompt` 的响应。响应到达后隔一个宏任务把已进入 transcript 的尾部补折进当前段再收口（`flushScheduledClose` / `drainTail`；stale 回合不补读，final `turn/metrics` 先于 `turn/end`）；settle 后紧接的拆除（`TurnStreamController.dispose`）清掉排队的收口，不补第二帧 `turn/end`。被并入 CodeBuddy 后台 drain 的回合是**延后收口**：响应已回、正文随 drain 到达，quiet（`ambientQuietMs`）/ 硬上限（`ambientMaxMs`）只收口这一轮、不杀进程（[protocol.md §6.2](./protocol.md)）；quiet 收口把 drain 的 requestId 记进 `retiredAmbients` 再清 `session.ambient`（复活 run 的迟到正文只留在 transcript），hard 上限收口保留记录并刷新活动时钟、交给 `ambientStaleMs` 惰性过期，`ambientNotices` 两种收口都不清（仅过期时随记录清），正常 settle 也不清——同一 drain 的重复宣告保持静默，下一次被并入的 prompt 仍识别为 steered。强制定稿只有两条受控路径：`session/cancel` 后的 `armCancelFallback`（人已经按过取消），与 `BridgeManager.reapStalledTurns` 的无活动看门狗（会话 running 且未关闭 / 未释放、段开着——控制器须属于同一个 `LiveSession`，stale 按不存在处理、`/acp` 无控制器按开着——无待答审批，且 agent 连续静默超过 `turnStallMs`；`activeToolCalls` 非空时 `turnStallToolMs`，按 `toolCallId` 计集合，并行调用等最后一个结束）。**开火只收口 turn、不杀进程**；杀进程只发生在下一条消息的 `prepareStalledSession` 善后：有 `loadSession` 走 `releaseAll` + `session/load`，没有则 `forceReset`（`/acp` 下次 prompt 报 `session_reset`）并告知上下文已丢；暂定首轮零可见产出被收口时锁回滚、会话关闭，notice 说明这一轮已丢弃、下一条消息新建 ACP 会话（不得承诺 resume）。正常结束但零可见产出必须显式告警。完整判据见 [protocol.md §6.1](./protocol.md)。

## 3. 会话 ↔ agent 绑定

`session/chat-bind` / `session/chat-model-set` / `session/chat-effort-set` / `session/chat-mode-set` 指向「这条 DSH 会话由哪个 agent 服务」，**不写全局默认模型，也不经 `session/selectModel`**。

发消息仍走宿主 driver（进日志的唯一路径）。driver 每个 step 按「pending selection → 上一条请求 header → 部署默认」解析路由，所以绑定必须自己接到请求路径上，否则：新会话发到部署默认 provider，跑过的会话永远回放旧 agent。

**0.2.2 起路由在 step preparation 前固定**：`preStep` 先取 `agent.model.current()`，之后 `agent/request` 只许改非路由控制项，改 provider/model/effort 直接判该轮失败。因此 guard 必须在那次读取之前把绑定写成会话的模型选择：

1. **guard 的 `agent.model.select()`**（`presets/acp/acp-guard.mjs`）——现行宿主
   - `selectBoundRoute` 在 `agent/inbox/inserted`（唤醒驱动的同步 splice）与 `agent/inbox/claimed`（`preStep` 内部、取选择之前最后一刻，兼收上一次进程遗留的排队输入）里执行 `agent.model.select({ provider: 'acp', model })`，model 来自注册表绑定，无绑定回落插件默认 agent。**不要**挂 `agent/created`：首轮前切走 preset 会把 `acp/...` 选择留在普通会话上。
   - 直写 agent 的 selection 投影，不碰全局默认模型、不读模型目录、不做目录门禁；宿主随后把这次选择连同请求写进日志，重启后作为 `lastUsed` 继续生效。
   - `model-selection` 来源的「model changed」通知属于宿主路由话术，在 `agent/pre-step` 里剥掉（若宿主把它接在本行外层之后追加，bridge 的两条过滤也会忽略它），不转发给 ACP agent。
   - `agent/request` 在这些宿主上**不改 provider/model**，但把 `reasoningEffort` 对齐到 `agent.model.current()`（宿主正是拿它与捕获的选择比较）：插件自己的选择从不带 effort，内层监听器塞进来的会被剥掉；无绑定的部署默认选择若带 effort 则保留。
2. **guard 的 `agent/request` 改写**——仅老宿主（无 `agent.model`）
   - 老宿主不在 preStep 固定路由，才把解析出的请求改写成绑定指向的 `acp/<agent>`。
   - 注册 `{ prepend: true }`：waterfall 外层后执行，其返回值才是 driver 看到的；harness 自己的 `installModelSelection` 先注册，只有最外层能让绑定赢。
   - 改写丢掉继承的 `reasoningEffort`：那是别的路由的 effort，agent 的思考等级走插件自己的轴，外来 effort 还会撞 adapter 校验。
   - 无绑定的会话回落插件默认 agent；连默认 agent 都没有就不改写（部署默认照旧）。
   - 绑定注册表经 `globalThis[Symbol.for('dsh-ntr.acp-binding')]` 跨模块实例共享（guard 由 Loader 独立加载，import 不共享）。`ACP_ROUTE_BINDING_KEY`（`src/bridge.ts`）与 guard 的 `BINDING_KEY` 是手拷贝，`tests/register.spec.ts` 断言两侧看到同一个注册表。
3. **adapter 自己的复查**（`BridgeManager.streamPrompt`）
   - driver 仍带来旧 agent id（旧 header 回放、guard 未挂载）时，`conversationRouteModel` 的绑定 model 串优先。
   - 材料化的默认 effort（`reasoning.defaultEffort`、`modelDefaultEffort`）不算用户选择，不得回写覆盖：catalog 缓存不随 per-session `set_config_option` 刷新，覆盖会把座位刚选的思考等级静默改回去。
4. **绑定显示**
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

`acp-guard.mjs` 挂四类监听器：

- `agent/pre-step` 步进闸门（`{ prepend: true }`，最外层：宿主 `installModelSelection` 在 `next()` 之后才追加 model-changed 通知，内层闸门剥不到）：**白名单保留** `user` / `tool` / 无 source 三类，其余一律按宿主注入剥掉（`agent-instructions` / `skill-catalog` / `runtime-context` / `plugin` / `model-selection` / `dsh-mnemon`，以及以后任何新种类）；显式给 `config.strippedSources` 时改为按该黑名单剥离（调试口，`[]` = 全保留），也只有这条路径还会 `reject`（剥完既无 user 也无 tool）。
- **闸门绝不拒绝续跑步**：宿主的 `turn()` 把 `preStep` 的 `reject` 记成 `turn/end blocked`，且记在 `step/start` 之前（日志里没有第二个 `step/start` 就是这条路）。issue #10 两次事故都是「漏剥一个注入种类 → 续跑步批次留下残渣 → 拒绝」。续跑步批次里**本来就没有工具结果**：`dsh-agent-loop` 只把工具自己的 `additionalContexts` stage 进 next-step inbox，而 adapter 收到的 `GenerateOptions.messages` 来自 `session.deriveMessages()`（整份 transcript）。剥完通常为空——首步空批次走宿主原 completed 空转，续跑步照常进步，由 `isAcpToolContinuation` 决定是续读同一 prompt 还是收一行指针。另注：`step()` 会无条件追加自己那份 runtime-context 投影，剥不掉它，只能决定它的位置。
- `tools/execute` 虚拟工具（§2.2）：解析不到的工具名即时注册 agent 作用域虚拟工具，工具体从 `toolResults` 取真实输出，未到则挂 `waitForToolOutput`（真实输出落库 / agent 报终态 status（`isFinalToolCallStatus`）/ turn settle / 30 分钟兜底，四者任一解除）。**公告帧记下的空输出不算答案**，否则卡片永远只拿得到占位符（issue #10 的第 1 条观察）。真实工具与缺席的 `tools` 服务原样放行。
- `agent/inbox/inserted` / `agent/inbox/claimed` 路由选择：见 §3，宿主有 `agent.model` 时把绑定写成会话选择。
- `agent/request` 路由改写：见 §3，仅老宿主（无 `agent.model`）生效。

纪律：

- **严禁**试图用 preset 替换 `dsh-agent-loop`（`ctx.agents.setFactory` 只允许一个 factory，第二个抛错）。
- **严禁**由 preset 或宿主侧宣称能屏蔽非 ACP 模型（`buildModelCatalog` 无 per-session 过滤 seam）。
- 「是否 NTR 会话」必须读会话日志的 preset（`sessionAgentPreset`，镜像 `dsh-agent-presets` 的 `resolveSessionPreset`，经 `setAcpModeResolver` 注入），**严禁**自建标记位。

**MCP 工具不在这层**。MCP 服务器由 **agent 进程自己**拉起与管理：要么是 agent 自己配置的那批（agent 读自己的配置文件，与本插件无关），要么是 agent 定义里 `mcpServers` 声明的那批（插件在 `session/new` / `session/load` 时把清单交给 agent，见 [protocol.md §1](./protocol.md)）。两种都在 agent 进程内，既不是宿主 `ctx.tools` 的工具，也不经 `tools/execute` 虚拟工具那条路 —— 所以「NTR preset 不挂工具行」与「NTR 会话能用 MCP 工具」并不矛盾。宿主侧 MCP（`dsh-mcp-client` → `ctx.tools`）**不经此路**转发：宿主不暴露那批服务器的可读清单，agent 也够不着宿主的工具注册表。

原「权限裁决也进 preset」的实现已退役：权限原样映射，见 [permissions.md](./permissions.md)。

## 6. 默认 agent

- 插件自己的默认 agent 是**插件私有状态**：`defaultAgentId`，存在 `~/.dsh/dsh-ntr/agents.json`，RPC `default/agent` / `default/agent-set`，面板 ★。删除 agent 必须同时清空该指针。
- 它只决定「新会话默认选哪个 agent」，与 DSH 的全局默认模型无关。插件**不碰**宿主的模型目录与默认模型：不读 `modelDirectories`、不走 `session/selectModel`、不写 `agentDefaultModel`、不广告 `listModels`；唯一的模型层写入是 guard 用 `agent.model.select()` 记会话路由。
- 没有绑定、没有 pick、没有默认 agent 时，`routeAgentId` 返回 `undefined`。那是一个答案，不是待填的洞：芯片**严禁**借 `agents[0]?.id` 填一个名字，否则芯片上写着某个 agent 而没有任何消息会送到它那里。

## 7. agent 锁定

一个会话一个 agent。

- **首轮开始时**（ACP 会话 materialize、prompt 发出前）锁定并广播 `chat/agent-locked`。判定走 `lockedAgentOf`（宿主 `lockedAgentId` → 活/挂起会话的 agent），**不拿插件默认 agent 或首轮前的 pick 当判据**，**不查 roster**（agent 被删除也不解锁）。
- 锁定发生在 `getOrCreateDshSession` 的 create 路径（`lockChatAgent` 并广播），不是点选时，但它是**临时的，直到首轮产生第一个可见块**。
- 首轮无任何可见输出就结束（报错、静默失败、取消、看门狗以 `INACTIVITY_TIMEOUT` 收口）：`TurnStreamController.settle`（用户取消时还有 `abortActiveSegment`）在合成空回合告警**之前**用真实的 `sawVisibleBlock` 判定并调 `rollbackFirstTurn`——删除 `locked`、`forgetDshSession`、关闭失败会话（不关就没法解锁：活会话被当作锁）、广播 `chat/agent-unlocked`。看门狗在 `BridgeManager.reapStalledTurns` 里按同一判据换掉自己的 notice：不承诺「下一条消息恢复会话」，而是说明这一轮已丢弃、下一条消息新建 ACP 会话。**例外**是 ambient 家族的延后收口（被并入后台 drain 的回合 §6.2、派发 detached worker 的回合 §6.3）：延后收口不是失败，产出仍在 transcript，锁转正、不滚（[protocol.md §6.2 / §6.3](./protocol.md)）。
- 一旦有可见输出，`chatChoice.locked` 随会话持久化。`bindChatAgent` / `setChatSessionModel` / `setChatSessionMode` 指向别的 agent、以及 `getOrCreateDshSession` 的 turn 路径一律以 `agent_locked` 拒绝。
- 锁定在 ACP 会话关闭、进程停止、宿主重启后仍然保留。
- 浏览器侧的表现与动效见 [ui.md](./ui.md) 的「底座退场与挂牌」。

## 8. 已退役的轴

不要重新引入 provider 路由、DSH Access mode 裁决、竞争式座位遮蔽、默认模型守卫。它们为何失败、留下了哪些幽灵符号，见 [retired.md](./retired.md)。

## 代码索引

| 主题 | 位置 |
|---|---|
| 消息选择 / 转发 | `src/impl.ts` · `selectForwardPrompt`；`src/bridge.ts` · `streamPrompt` |
| 工具卡快照 / delta / 输出注册 | `src/impl.ts` · `acpToolCallFromUpdate` / `acpToolCallDelta` / `acpToolCallArgsOf` / `isFinalToolCallStatus`；`src/bridge.ts` · `recordAcpToolOutput` / `waitForToolOutput`；详见 [protocol.md](./protocol.md) |
| 绑定 RPC | `src/impl.ts` · `dispatchRpc('session/chat-*')`；`src/bridge.ts` · `bindChatAgent` / `setChatSessionModel` / `setChatSessionEffort` / `setChatSessionMode` |
| 路由选择 / 老宿主请求改写 | `presets/acp/acp-guard.mjs` · `selectBoundRoute` / `agent/request`；`src/bridge.ts` · `conversationRouteModel` |
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
| `src/skills-scan.ts` | 宿主侧 skill 目录扫描：按 agent 风味（`skillFlavorOf`，`src/impl.ts`）扫 project/global/system 三层目录并解析 SKILL.md，喂给 `agent/skills` RPC（`BridgeManager.agentSkills`，内存 TTL 缓存）；只读文件系统，不 spawn、不落盘 |
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
- **Transcript**：宿主为每个会话维护的有界环形缓冲（`transcriptMaxEntries`），用于重连后按 seq 补齐、续跑段补读段间事件。连续同类纯状态 tick（`usage_update`、无 title 的 `session_info_update`、`config_option_update`）就地替换末条：seq 前进、数组不增长、保留最新值；`since()` 的 seq 空洞是正常的，实时 SSE 仍逐帧广播（细节见 [protocol.md §8](./protocol.md)）。
- **Model Catalog**：`agent/catalog` 下发的 agent 自己的 `model` / `thought_level` 面（`base` + `variants` + `reasoning`）。DSH 自己的模型目录里没有 ACP 条目。
- **exposedModels**：per-agent 的座位可见性过滤。空 = 只留 `base`；只影响 `agentCatalog` 的变体展开，不影响 `resolveAdapterModel`。细节见 [state.md §5](./state.md)。

