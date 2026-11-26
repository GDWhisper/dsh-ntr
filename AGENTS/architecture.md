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

**复合键**：`BridgeRegistryService.bridges`（`src/bridge/bridge-registry-service.ts`；manager 保留同名 getter 供测试内省同一 Map 实例）的键由 `bridgeKey(agentId, scope)` 生成——非 A1 返回裸 `agentId`；A1 返回 `agentId + '\u0000' + <kind>[:<token>]`。`BridgeScope` 四态：

| scope | 何时创建 | 谁回收 |
|---|---|---|
| `agent` | 非 A1 的唯一进程 | `stopAgent` |
| `chat` | 每条 DSH 聊天会话（`getOrCreateDshSession`，键含 `dshSessionId`） | `closeSession` / 首轮失败回滚 / `prepareStalledSession` 的善后 |
| `ephemeral` | `/acp` 的 `startSession`（键含 `randomUUID()` token）与匿名回合（token 固定 `anonymous`） | `closeSession`；`streamPrompt` 结算后的 `.finally` |
| `probe` | `probeAgentModels` 的目录探测 | 探测 `try/finally` 立即回收 |

`bridgeScopes` 是 `bridges` 键集合的伴生状态，**仅供测试与诊断**：生产代码 1 处声明、1 处写入、3 处删除（服务内 `pruneBridge` / `stopAgent` 两处 + manager 的 admin 停止包装一处），没有任何消费者；唯一读取方是 `tests/bridge.spec.ts` 的 3 处断言（`agent/delete` 与 `stopAgent` 用例比对 `bridgeScopes.size` 与 `bridges.size`）。运行时判定作用域的唯一权威是 `bridges` 的复合键与 `bridgeKey`。清理时应删字段并把那 3 处断言改为只看 `bridges` 键（或提供测试可见的派生 getter），**不要**为消除死代码在业务逻辑里接读取。

**启动清洗（只对 A1）**：`perSessionLaunchArgs` 删除 `--port <值>` 与 `--port=<值>`；`perSessionLaunchEnv` 按大写键名删除 `SERVER__PORT` / `SERVER__HOST`。原因是 CodeBuddy 的 ACP 模式会去绑 `127.0.0.1:6156`，每会话一个进程时必然 `EADDRINUSE`；stdio 传输不需要监听端口。

**生命周期**
- **创建**：chat 走 `bridgeForSession(session)`；同一 DSH 会话第一次发消息时创建自己的子进程。resume 路径复用同一 holder，绝不新建第二个 ACP 会话。
- **复用**：`streamPrompt` **不缓存** bridge；`initResult`、`claimTurn`、`beginTurn`、`runPrompt` 每处重新 `bridgeForSession(session)`，`onAbort` 只用 `bridgeOwning(...)` 查归属、**绝不创建进程**。
- **归属三态**：`bridgeOwning` 查 `hasSession` / `hasReleased` / `inflightResume`，只回答「谁在用」，不抛也不建。**停止窗口优先于三态**：`stopAgent` 置位的 `stoppingAgents`（`isStopping`）由获取入口检查——`getOrCreateDshSession` / `locateOrResume` / `resumeChatSession` 直接抛 `agent_stopping`，`bridgeOwning` 仍照常返回 holder（abort 监听器与归档 / 关闭路径依赖它不抛）。恢复在途时 `getOrCreateDshSession` **await 同一个 `inflightResume`** 并复用同一 `LiveSession`；三态都未命中、不在停止窗口且 `dshSessionMap` 仍有 live 绑定，才 `forgetDshSession` 并抛 `session_orphaned`。
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
- **逐步切分**（[acp-convergence.md §1.8](../docs/acp-convergence.md)）：一个 ACP turn = 多个宿主 step。段内开过卡、且下一条非 tool 事件到达时切段（`block-end` + `finish(stop)`）；宿主 loop 落定消息 → 执行卡（guard 虚拟工具从共享注册表 `toolResults` 答真实输出，未到则 `waitForToolOutput` 挂起）→ 续跑。**卡片块的静默结算**：卡片已披露参数后，agent 连续静默 `CARD_SETTLE_QUIET_MS`（500ms，`TurnStreamController.armCardSettle`）时只发该卡的 `block-end`，**不结束段**——宿主 preparing 行运行中只读参数 JSON 的 `description` 摘要（`acpToolArgsJson` 把 title 放进 `description`，见 [acp-convergence.md · 卡片参数的可见形状](../docs/acp-convergence.md)）：首帧 delta 给 announce 已知操作，迟到重述经静默结算的 `block-end` 刷新运行中的行；切段点、卡片交接时机与看门狗判据都不变。结算后快照仍保持打开：同一 callId 的迟到参数重述只折进快照、**不再发 `tool-call-delta`**（宿主视图已 seal），`argsRaw` 变化时按 `CARD_SETTLE_QUIET_MS` 节流重发 `block-end` 刷新 `preparing` 行并由段尾 `block-end` 整包收口，不会停在旧命令，也不会开第二张卡；聊天 `AcpToolRow` 同时经 `AcpStore` SSE `LiveToolCallIndex` 在 `preparing` / `start` / `result` 实时合并标题、入参、流式输出与 diff（因宿主 `BlockAssembler` 在首次 `block-end` 即锁定持久化 `argsRaw`）。续跑批次（`isAcpToolContinuation`：最后 user 消息之后全是 tool 来源）由 `TurnStreamController.startSegment()` 用 transcript 游标补读段间事件再订阅，**绝不新发 `session/prompt`**。以卡收尾的 turn 由最后一个续跑段收口（指针行），避免空气泡。
- **turn 级语义跨段成立**：`turnSeq` 世代守卫、prompt slot（agent 未确认取消前不解开 `settled` 闸门）、段间事件只记账不推进游标（下一段重放补齐），全部在 `TurnStreamController`；`session/cancel` 后的强制定稿由 `AgentBridge.armCancelFallback` 按同一 `turnSeq` 守卫。**聊天面与 `/acp` 共用一个 prompt slot**：`BridgeRpcService.prompt`（manager 同名转发）也经 `bridge.beginTurn` 占槽，聊天 `claimTurn` 与 `/acp` 的 `turn_in_flight` 检查互斥（/acp 还拒 `running` 与未 settle 的活聊天控制器），`/acp` 在飞时聊天面不得发 `session/prompt`；同一聊天会话自己的回在飞时，宿主插话按插话语义取消当前回合后再重发（`reclaimChatPrompt`，[protocol.md §6](./protocol.md)）。
- **后台 drain 的正文归属**：CodeBuddy 的 unsolicited turn 见 [protocol.md §6.2](./protocol.md)；派发 detached worker 的回合见 [protocol.md §6.3](./protocol.md)——worker 自己的 `session/update`（带 `codebuddy.ai/parentToolCallId`）只进 transcript / ACP 视图，主平面收的是父回合的正文与 drain 的最终答案。主平面的唯一入口是 `adapter.stream`：等待中的用户回合把 drain 的正文折进自己的段（后台工具只进 transcript、不开卡），纯空闲 drain 只进 ACP 视图，**严禁**绕过 stream 凭空 append。
- **重述去重**：agent 会把整条 `tool_call` 重发多遍当进度（并行调用还会交错）。`seenCalls` 按 callId 一卡；重述只刷 `recordAcpToolOutput` 的输出记录（并唤醒等待中的虚拟工具）。无卡片的通知种类（plan / mode）同理，`announcedKinds` 每种类一行、文本变了才重发。

### 2.3 收尾

`turn/end` 的权威来源是 `session/prompt` 的响应。响应到达后隔一个宏任务把已进入 transcript 的尾部补折进当前段再收口（`flushScheduledClose` / `drainTail`；stale 回合不补读，final `turn/metrics` 先于 `turn/end`）；settle 后紧接的拆除（`TurnStreamController.dispose`）清掉排队的收口，不补第二帧 `turn/end`。被并入 CodeBuddy 后台 drain 的回合是**延后收口**：响应已回、正文随 drain 到达，quiet（`ambientQuietMs`）/ 硬上限（`ambientMaxMs`）只收口这一轮、不杀进程（[protocol.md §6.2](./protocol.md)）；quiet 收口把 drain 的 requestId 记进 `DrainLedger.retired` 环再停用它（`retireAmbientId` + `stopDrain`；复活 run 的迟到正文只留在 transcript），hard 上限收口保留 active 记录并刷新活动时钟、交给 `ambientStaleMs` 惰性过期，`DrainLedger.notices` 去重环两种收口都不清（仅过期时随记录清），正常 settle 也不清——同一 drain 的重复宣告保持静默，下一次被并入的 prompt 仍识别为 steered。强制定稿只有两条受控路径：`session/cancel` 后的 `armCancelFallback`（人已经按过取消），与 `TurnWatchdogService.reapStalledTurns` 的无活动看门狗（会话 running 且未关闭 / 未释放、段开着——控制器须属于同一个 `LiveSession`，stale 按不存在处理、`/acp` 无控制器按开着——无待答审批，且 agent 连续静默超过 `turnStallMs`；`activeToolCalls` 非空时 `turnStallToolMs`，按 `toolCallId` 计集合，并行调用等最后一个结束）。**开火只收口 turn、不杀进程**；杀进程只发生在下一条消息的 `prepareStalledSession` 善后：有 `loadSession` 走 `releaseAll` + `session/load`，没有则 `forceReset`（`/acp` 下次 prompt 报 `session_reset`）并告知上下文已丢；暂定首轮零可见产出被收口时锁回滚、会话关闭，notice 说明这一轮已丢弃、下一条消息新建 ACP 会话（不得承诺 resume）。正常结束但零可见产出必须显式告警。完整判据见 [protocol.md §6.1](./protocol.md)。

### 2.4 本地 `file://` Markdown 链接重写

`AcpLlmAdapter.stream` 只在对话轮次（`purpose === undefined`）把出口流包一层 `rewriteStreamFileLinks`（`src/impl/file-links.ts`），把本地 `file:///` / `file://localhost/` 链接（含 `<...>` 包裹形式）转为纯路径，原始 ACP transcript、echo guard 与辅助调用（`session-title` 等）一律不改。

- **宿主渲染耦合点（双份真相）**：什么算可点击的本地文件链接目前分在两处——DSH 聊天 Markdown 渲染器先剥 `#...`、再 `decodeURIComponent`，满足本地路径白名单（`/^(?:[\\/]\|\.{1,2}[\\/]|[a-z]:[\\/])/i`）或 `!URL.canParse(decoded)` 才走文件侧栏；本重写器负责把 `file://` 前缀拆成宿主可认的纯路径。宿主规则改动会让本模块静默失配，修改须同步核对。
- **有界流式状态机契约**：`MarkdownFileLinkRewriter` 每步只做单字符转移，`linkBuf` 只暂存未判定的本地头，分类器保证等待在首个非歧义字符处结束（构造上最长 `](<file://localhost/C%3A/`，25 字符；`1` 字符 / 任意 2 段切分不变）；跟踪围栏代码块（含引用块 `>` 嵌套深度 `fenceQuoteDepth`，离开引用层即关闭围栏）、文首/空行后的 4 空格/Tab 缩进代码块（列表项内阈值为项内容缩进 +4，按 bullet / ordered 标记维护内容缩进栈）、跨空行自动清零的行内反引号、以及代码外反斜杠转义（被转义的分隔符不开启围栏 / span / 链接 / 列表标记）；`flush()` 原样回吐未完成的 `linkBuf`，绝不截断 `](file:///C` 一类半截前缀。本地 authority 与 Windows 盘符头判定复用 `src/impl/paths.ts` · `classifyLocalFileUrlHead`（与 `normalizeFileUrlToPath` 共用；后者先解码一次再分类，`%2F` 等编码分隔符还原后仍按盘符路径处理）。

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
   - 绑定注册表经 `globalThis[Symbol.for('dsh-ntr.acp-binding')]` 跨模块实例共享（guard 由 Loader 独立加载，import 不共享）。`ACP_ROUTE_BINDING_KEY`（`src/bridge/registries.ts`）与 guard 的 `BINDING_KEY` 是手拷贝，`tests/register.spec.ts` 断言两侧看到同一个注册表。
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
- **`acp_delegate` 委派会话继承调用会话的工作区**（2026-11-20 用户裁决）：省略 cwd 时取 `exec.agent.session.header.cwd`（与聊天 `chatWorkspaceRoot` 同源——人选的会话项目工作区），经 `startSession` opts 作为 `extraRoots` 与 `spawnCwd` 传入，先校验后 spawn；显式 cwd 按「agent roots + 会话工作区」围栏校验。拿不到会话工作区时降级 `def.cwd` + roots-only 围栏，不报错。无 opts 的 `/acp` RPC 保持旧行为。细节见 §5 委派节与 [plan §3](../docs/plan/acp-delegate-subagent.md)。

## 5. NTR preset 外壳

NTR 模式表达为 agent preset（`presets/acp/acp.patch.yml` 的 `preset-acp` 行）：`persona` 行 `complete: true` + `includeRuntimeContext: false`，**不挂**工具行 / `agent-instructions` / `tool-skill` / plan-mode / todo / compaction / 委派行。

`acp-guard.mjs` 挂四类监听器（另在挂载时预注册保留的虚拟工具名，见下）：

- `agent/pre-step` 步进闸门（`{ prepend: true }`，最外层：宿主 `installModelSelection` 在 `next()` 之后才追加 model-changed 通知，内层闸门剥不到）：**白名单保留** `user` / `tool` / 无 source 三类，其余一律按宿主注入剥掉（`agent-instructions` / `skill-catalog` / `runtime-context` / `plugin` / `model-selection` / `dsh-mnemon`，以及以后任何新种类）；显式给 `config.strippedSources` 时改为按该黑名单剥离（调试口，`[]` = 全保留），也只有这条路径还会 `reject`（剥完既无 user 也无 tool）。
- **闸门绝不拒绝续跑步**：宿主的 `turn()` 把 `preStep` 的 `reject` 记成 `turn/end blocked`，且记在 `step/start` 之前（日志里没有第二个 `step/start` 就是这条路）。issue #10 两次事故都是「漏剥一个注入种类 → 续跑步批次留下残渣 → 拒绝」。续跑步批次里**本来就没有工具结果**：`dsh-agent-loop` 只把工具自己的 `additionalContexts` stage 进 next-step inbox，而 adapter 收到的 `GenerateOptions.messages` 来自 `session.deriveMessages()`（整份 transcript）。剥完通常为空——首步空批次走宿主原 completed 空转，续跑步照常进步，由 `isAcpToolContinuation` 决定是续读同一 prompt 还是收一行指针。另注：`step()` 会无条件追加自己那份 runtime-context 投影，剥不掉它，只能决定它的位置。
- `tools/execute` 虚拟工具（§2.2）：guard 在 `apply` 挂载时先把保留名 `dsh_ntr__acp_tool_call` 预注册进 **preset 这一代的 scope**（同一代的所有 NTR 会话共用，不是 per-agent 作用域），schema 随本会话第一份请求头下发——挂载早于首次请求组装时，`unknown tool` + 下次清单 diff 的「已添加工具」这对噪音不再出现；升级 / HMR 时已经活着的会话，下一份请求头仍可能补记一次 `tool-addition`。只有挂载时 `tools` 服务未就绪或挂载注册失败，才回落到执行阶段对解析不到的工具名即时注册；execute 路径按 **schema 指纹**识别前一个模块实例留下的同一份定义，HMR 后 preset scope 上存活的注册会被复用，不会被误判成真实宿主工具而 fail-closed。**Auto 权限档仍然不可用**：宿主实验性自动审查在 schema 命中后还要调用会话模型判风险，而 NTR 请求头里的模型是外部 ACP agent；adapter 在 `purpose` 闸门之后、建 ACP 会话之前拒收既无 `purpose` 也无 `sessionId` 的匿名辅助调用（0.2.2 的 `purpose: "auto-review"` 由既有闸门拒掉），审查得不出结论，宿主拒绝每一张卡并显示错误，agent 自己的执行继续；指引是改用非 Auto 权限档。工具体从 `toolResults` 取真实输出，未到则挂 `waitForToolOutput`（真实输出落库 / agent 报终态 status（`isFinalToolCallStatus`）/ turn settle / 30 分钟兜底，四者任一解除）。**公告帧记下的空输出不算答案**，否则卡片永远只拿得到占位符（issue #10 的第 1 条观察）。真实工具与缺席的 `tools` 服务原样放行。
- `agent/inbox/inserted` / `agent/inbox/claimed` 路由选择：见 §3，宿主有 `agent.model` 时把绑定写成会话选择。
- `agent/request` 路由改写：见 §3，仅老宿主（无 `agent.model`）生效。

纪律：

- **严禁**试图用 preset 替换 `dsh-agent-loop`（`ctx.agents.setFactory` 只允许一个 factory，第二个抛错）。
- **严禁**由 preset 或宿主侧宣称能屏蔽非 ACP 模型（`buildModelCatalog` 无 per-session 过滤 seam）。
- 「是否 NTR 会话」必须读会话日志的 preset（`sessionAgentPreset`，镜像 `dsh-agent-presets` 的 `resolveSessionPreset`，经 `setAcpModeResolver` 注入），**严禁**自建标记位。

**MCP 工具不在这层**。MCP 服务器由 **agent 进程自己**拉起与管理：要么是 agent 自己配置的那批（agent 读自己的配置文件，与本插件无关），要么是 agent 定义里 `mcpServers` 声明的那批（插件在 `session/new` / `session/load` 时把清单交给 agent，见 [protocol.md §1](./protocol.md)）。两种都在 agent 进程内，既不是宿主 `ctx.tools` 的工具，也不经 `tools/execute` 虚拟工具那条路 —— 所以「NTR preset 不挂工具行」与「NTR 会话能用 MCP 工具」并不矛盾。宿主侧 MCP（`dsh-mcp-client` → `ctx.tools`）的工具注册表仍不经此路转发给 agent；但当宿主提供 `@deepseek-ai/dsh-mcp-manager`（`ctx.mcpManager`，DSH 0.2.2+）时，插件经可选接缝只读 `ctx.mcpManager.config.servers.get()`，在用户主动开启「同步 DSH 宿主 MCP」后将已启用且不含 `${credential:...}` 模板的条目与插件全局 `sharedMcpServers` 一并经 `sessionMcpServers` 合并下发（优先级：agent 私有 > 插件全局 > 宿主同步 > 内置 `dsh-skills`）。

原「权限裁决也进 preset」的实现已退役：权限原样映射，见 [permissions.md](./permissions.md)。

**宿主工具 → agent 委派（`acp_delegate`）**：与上面「宿主 MCP 不经此路」方向不同的一条接缝——委派是插件**主动**起 ACP 会话跑任务再收答复，不是把宿主工具暴露给对端 agent。现行形态是**宿主原生子代理链的一次性外部激活（异步）**，不是子会话：有 `ctx.subagents` 接缝的宿主上工具立即返回 name、答复经宿主结算通知送达；无接缝的老宿主回落 legacy 同步壳。

- **provider 注册**（`src/index.ts` · `wireSubagentProvider` / `probeSubagents`）：经 `ctx.subagents.registerProvider` 注册 ACP provider（`src/bridge/delegate-provider.ts` · `AcpSubagentProvider`，name `acp` = `ACP_SUBAGENT_PROVIDER`，能力全 false = 自写冻结字面量 `NO_START_CAPABILITIES`，无 `prepareContinuable`，`inheritsParentContext: false`）。接缝结构化探针（`registerProvider` + `startActivation` 双在才认），**绝不写进顶层 inject**；注册先于工具首次 sync（否则 native 壳报 NO_PROVIDER），迟到经 `ctx.inject(['subagents'])` 重判，effect teardown 调 disposer。
- **异步 execute**（`delegate-provider.ts` · `acpDelegateActivationExecute`）：先经 `delegate-service.ts` · `resolve` 预校验（task/agent/cwd 形状、agent 解析、工作区继承计算——可预见错误拦在激活前，不产生目录行），再 `startActivation({provider:'acp', label, prompt, parent:exec.agent, signal:exec.signal, delivery:'parent', cwd})`，**立即返回** `{kind:'activation', name, agent}`，不 await receipt.result（await = 同一内容双份投递 + 父回合被占满整个子运行）。答复由宿主注入父会话的结算通知送达（user 消息，source `subagent-settled`）；一切拒绝（校验 / 容量 / 鉴权 / NO_PROVIDER）折成明示 `{kind:'error'}`（`describeActivationError` 前置 typed code），绝不 throw execute。
- **宿主单一事实源**：目录行 / 结算 / 中断归宿主——插件**不自写** `subagents/record` · `subagent/catalog`（「不双写」= 不平行双写；宿主的 external 成员行是禁用叶子：无点击穿透 / 无实时状态）。`interrupt_agent` 可终结（abort + dispose → 结算通常 aborted）、不可续聊（无 `prepareContinuable` → `send_message` 被 NOT_CONTINUABLE 拒）、`list_agents` 不列（宿主只认 continuable）。容量共享每棵子代理树 8 槽（local + external 共用），**满则拒绝不排队**（ACTIVATION_LIMIT_REACHED，错误明示模型）。
- **label 编码路由 + signal 语义**：`ResolvedSubagentStartRequest` 无自定义字段，per-call agent 选择与**显式**模型/等级/模式编码进 label：无选择 `"<agentId>: <task 首行摘要>"`（与旧格式逐字节一致），有选择 `"<agentId> ⟦m=…&e=…&o=…⟧: <summary>"`（固定 m,e,o 键序、只写现键、encodeURIComponent；`src/impl/delegate-label.ts` · `delegateLabel` / `agentIdFromDelegateLabel` / `delegateChoicesFromLabel` / `displayDelegateLabel` 纯函数族，往返/注入/畸形等价测试钉死；agentId 字符集 `validate.ts` · `AGENT_ID_PATTERN` 不含冒号/空格 → 首个 `': '` 分割无歧义，载体在前缀里、任务文本到不了，解码只认合法 id 与严格文法，畸形 fail-closed）。**配置默认不进 label**（run 时热读，改设置不影响在飞激活）。插件自绘面板经 `displayDelegateLabel` 剥载体显示（浏览器手拷贝+等价测试）；宿主自有 UI 渲染原始 label（载体可见是设计固有代价，宿主将来提供 display 接缝时迁移）。provider.start 收到的 `request.signal` 是宿主两层新建的 controller.signal（**不是 exec.signal 原对象**），发布后 exec.signal 与 run 脱钩（转发监听拆除），之后的取消只经 interrupt / dispose 到达——所以静默窗 / 24h 看门狗必须是**内置计时器**（[protocol.md §1](./protocol.md)），外部子代理可活过派生它的工具调用 / 回合。
- **核心 begin/run/settle 拆分，两壳共享**（`delegate-service.ts`）：`begin` 返回 `AcpDelegateRunHandle`（result 永不 reject + dispose 幂等），`run` 是共享运行期（建会话 / 策略 / 折叠 / prompt / 静默窗 / 有界收口），`settle` 是 run 内 first-cause-wins 闭包。native provider 经 `resultOfSettlement` / `settleDelegateRun` 把结算映射成 `SubagentResult`：**ended 取自己的结束**（`hostTerminalOf` → `hostStopReasonOf`：`refusal`→`refusal`、`max_tokens`→`max-tokens`、`cancelled`→`aborted`、`max_turn_requests`/`end_turn`→`completed`，前者另加一行诊断，因为宿主语汇没有对应项；**只有 error 没有 stopReason 的 turn/end（看门狗强制收口 / 进程死亡 / prompt 被拒）落 `error`**，否则又是同一种压平），aborted→`aborted`，timed-out / prompt-error→`error`；diagnostic **至多**由「失败细节 + 无法命名的停因」与「降级 notes + 本次委派会话的代答/拒绝审批计数」两侧组成（全空则整体省略），合并入口 `mergeDelegateDiagnostic`（总长 4096 UTF-8 字节、notes 侧预留 1024 字节；计数放预留侧，极端长的失败正文截不掉它）。**ended 绝不一律折成 `completed`**：宿主结算首句本就按 stopReason 说「declined the task」/「ran out of room」，压平等于告诉父会话相反的结论。legacy 壳（`AcpDelegateService.execute` + `legacyReport`）await 同一 result 报折叠全文，footer 带 stopReason / 代答计数，**行为不变**（描述文案两壳同步改写，属引导措辞）——注册时按接缝在场选壳（`delegate-registration.ts` · `sync`，guidance 热重载重判）。
- **父回合在子运行期间可以继续**：`delivery:'parent'` 与宿主原生委派工具走同一条路，宿主的 `notifySettlement` 按父状态投递（`dsh-subagent` 的 `sendWaking(parent, message, parent.status === 'idle' ? 'queue' : 'steer')` → `agent.steer` → 下一 step 的 inbox），忙碌的父回合把结算当插话取走、不丢——**没有机制要求派发后结束回合**。旧描述里「派发后必须结束当前回合」是插件自加限制，已删除；现在的措辞与宿主自己的委派引导同构（继续做不相交的工作、只剩等待时结束回合），并把「子代理继承调用会话工作区」写进描述，让调用方自己守文件冲突（工具卡是模型可见内容，`ToolOutputDefinition.render` 属 Native/model content）。**还要写明「它不在 `list_agents`、没有可轮询状态」**：external 叶子被宿主过滤（只列 continuable），模型不知道这件事就会去等一个指定不了的目标（真实会话里 `list_agents` 只回了根、随后 `wait_agent` 空等 4 分钟到超时）；激活回执（`render`）与描述共用同一句 `DELEGATE_NOT_POLLABLE_NOTE`（防漂移），因为那里正是调用方决定「继续干活 / 结束回合 / 等待」的时刻。
- **四轴定制与兜底**（`delegate-service.ts` · `resolve`/`run` + `src/impl/delegate-choices.ts` 纯规划器）：取值链每轴 工具显式参数 > 子智能体委派配置默认（`delegateConfig().agentDefaults[agentId]`，run 起始热读）> 不设置（进程自身默认）；agent 轴 显式 > `defaultAgent` 覆盖（仅当仍在册且未禁用）> 全局默认（未禁用）> 无可用报错（`enabled === false` 的 agent 由 `delegateAgentDocs` 从 `acp_delegate` 参数清单移除并触发热重注册；`resolveAgent` 对显式禁用项直接拒绝、绝不静默回落到已禁用的默认项、全禁用明确报错；主聊天、进行中委派与 `acp_release` 不受影响）。run 在建会话后、prompt 前以 `sessionOptions` 读**活选项**（configOptions + modes，目录从不参与拒绝），`planDelegateModeAndModel` → 按序写入（mode 经 setMode、model 经 set_config_option 响应反哺快照）→ 重读活选项 → `planDelegateEffort`。配置默认失效→静默跳过+英文单行 note；显式 agent/模型/模式失效→fatal 错误结算（附可用清单，不发 prompt）；显式等级失效→软丢弃+note（等级永不致命）；写入 RPC 抛错按运行时故障结算（不兜底）。notes 合并恰一条 `notify`（agentId=被委派 agent，干净委派零条）+ `settlement.notes`（legacy footer `notes:` 行 / native diagnostic 与 turnError 合并，notes 预留 1024 字节、长错误先截 turnError）。**兜底绝不改写持久化配置**。静默窗在 prompt 相武装，选择写入相（≤3 次 RPC）只受 24h 兜底/宿主工具预算/abort 约束（与 /acp runCommand 同语义，[protocol.md §1](./protocol.md)）。设置四键与 UI 见 [state.md §1](./state.md) / [ui-panel.md §8](./ui-panel.md)。
- **两条有意裁决**：① cwd 围栏拒绝走**结算 error**，不预拦——围栏在 `startSession` 管线（`resolveSessionCwd`），`resolve` 只预校验形状与 agent 解析；`cwd_denied` / `bad_cwd` / `no_cwd` 在 run 内 settle 成 prompt-error（目录行已写，错误随结算通知送达）。② `header.cwd` 缺席且省略 cwd 时 **native 继承宿主 `workingDirectory.ensure(parent)`**（spec.cwd 缺席 → 宿主按父 agent 工作目录解析 '.'，provider.start 收到的已是绝对路径），**legacy 回落 agent 默认**（`def.cwd`）——角落微差，如实登记。
- **工作区继承**（`delegate-service.ts` · `sessionWorkspaceOf`）：省略 cwd 继承调用 DSH 会话的工作区（`exec.agent?.session?.header?.cwd`，仅非空绝对路径接受；native 壳从 `request.parent` 的会话 header 重读同一事实；与聊天 extraRoots 同源授权——工作区是人选的，不是模型发明的根）；显式 cwd 须在该工作区或 agent roots 内，围栏 = `allowedCwdRoots` + 会话工作区这一个 extra root，校验管线不变。委派恒带 `alignSpawnCwd: true`（进程目录对齐校验后的会话目录，修复 codebuddy shell 用进程目录的问题）；带 opts 的 `startSession`（`bridge-rpc-service.ts`）先 `resolveSessionCwd` 校验再 `createSession`，被拒 cwd 不 spawn，返回 `{ sessionId, cwd }`，legacy footer 在 agent id 后带 `· cwd=<resolved>`。拿不到会话工作区 → 降级 roots-only 围栏，不报错（cwd 本身的回落两壳有别，见上条裁决②）。fs 围栏与聊天同款：extraRoots 落成 `session.cwd`，`guardFsPath` 按 roots + `session.cwd` 消费（`LiveSession` 不另存 extraRoots）。
- 注册 `when`（`src/bridge/delegate-registration.ts` · `excludesNtr`）读 `agent.session.header.agentPreset !== ACP_PRESET_ID`，把 NTR 会话从**声明与派发**双排除——NTR 请求头根本不含此工具（零污染）；对端 agent 看不到、也指定不了宿主工具。
- **`acp_release` 是按需空闲释放，不是停止**：主代理调一次即跑空闲计时器的同一套资格（`AgentBridge.idleReleaseBlocker`：有进行中工作 → `busy`；live 会话且 agent 不支持 `session/load` → `no-resume`），`releaseAll`（cause `idle`）+ 可丢弃 holder 的 prune，绝不打断回合、不杀不可恢复的会话；与 `acp_delegate` 共用 `AcpDelegateRegistration` 生命周期（guidance `off` 一并摘除；老宿主常驻注册时两工具都按活配置答 `off`）。`agent` 参数可只限一个，结果逐 agent 报释放数 / 跳过原因（`src/bridge/release-tool.ts`）。
- 五个委派模块（`delegate-service` / `delegate-provider` / `delegate-registration` / `delegate-force-mask` / `release-tool`）都不 import manager，能力经 `src/index.ts` 的闭包注入（与 `subagent-service.ts` 同纪律）；force 档的 per-agent 遮蔽名单是 `DELEGATE_FORCE_DENY_CANDIDATES`（`subagent` / `subagent_fork` / `workflow`）∩ 该 agent 活清单（`AcpDelegateForceMask`，控制面工具保留，`agent/created` / `agent/disposed` 跟随）；权限走会话级接缝（[permissions.md §2.5](./permissions.md)），四键设置见 [ui-panel.md §8](./ui-panel.md) / [state.md §1](./state.md)。worker 适配器家族（CodeBuddy / agy）是另一条路，本次零改动（[subagent-adapters.md](./subagent-adapters.md)）。

## 6. 默认 agent

- 插件自己的默认 agent 是**插件私有状态**：`defaultAgentId`，存在 `~/.dsh/dsh-ntr/agents.json`，RPC `default/agent` / `default/agent-set`，面板 ★。删除 agent 必须同时清空该指针。
- 它只决定「新会话默认选哪个 agent」，与 DSH 的全局默认模型无关。插件**不碰**宿主的模型目录与默认模型：不读 `modelDirectories`、不走 `session/selectModel`、不写 `agentDefaultModel`、不广告 `listModels`；唯一的模型层写入是 guard 用 `agent.model.select()` 记会话路由。
- 没有绑定、没有 pick、没有默认 agent 时，`routeAgentId` 返回 `undefined`。那是一个答案，不是待填的洞：芯片**严禁**借 `agents[0]?.id` 填一个名字，否则芯片上写着某个 agent 而没有任何消息会送到它那里。

## 7. agent 锁定

一个会话一个 agent。

- **首轮开始时**（ACP 会话 materialize、prompt 发出前）锁定并广播 `chat/agent-locked`。判定走 `lockedAgentOf`（宿主 `lockedAgentId` → 活/挂起会话的 agent），**不拿插件默认 agent 或首轮前的 pick 当判据**，**不查 roster**（agent 被删除也不解锁）。
- 锁定发生在 `getOrCreateDshSession` 的 create 路径（`lockChatAgent` 并广播），不是点选时，但它是**临时的，直到首轮产生第一个可见块**。
- 首轮无任何可见输出就结束（报错、静默失败、取消、看门狗以 `INACTIVITY_TIMEOUT` 收口）：`TurnStreamController.settle`（用户取消时还有 `abortActiveSegment`）在合成空回合告警**之前**用真实的 `sawVisibleBlock` 判定并调 `rollbackFirstTurn`——删除 `locked`、`forgetDshSession`、关闭失败会话（不关就没法解锁：活会话被当作锁）、广播 `chat/agent-unlocked`。看门狗在 `TurnWatchdogService.reapStalledTurns` 里按同一判据换掉自己的 notice：不承诺「下一条消息恢复会话」，而是说明这一轮已丢弃、下一条消息新建 ACP 会话。**例外**是 ambient 家族的延后收口（被并入后台 drain 的回合 §6.2、派发 detached worker 的回合 §6.3）：延后收口不是失败，产出仍在 transcript，锁转正、不滚（[protocol.md §6.2 / §6.3](./protocol.md)）。
- 一旦有可见输出，`chatChoice.locked` 随会话持久化。`bindChatAgent` / `setChatSessionModel` / `setChatSessionMode` 指向别的 agent、以及 `getOrCreateDshSession` 的 turn 路径一律以 `agent_locked` 拒绝。
- 锁定在 ACP 会话关闭、进程停止、宿主重启后仍然保留。
- 浏览器侧的表现与动效见 [ui.md](./ui.md) 的「底座退场与挂牌」。

## 8. 已退役的轴

不要重新引入 provider 路由、DSH Access mode 裁决、竞争式座位遮蔽、默认模型守卫。它们为何失败、留下了哪些幽灵符号，见 [retired.md](./retired.md)。

## 代码索引

| 主题 | 位置 |
|---|---|
| 消息选择 / 转发 | `src/impl.ts` · `selectForwardPrompt`；`src/bridge/manager.ts` · `streamPrompt` |
| 本地 `file://` 链接重写 | `src/impl.ts` · `rewriteStreamFileLinks` / `normalizeMarkdownFileLinks` / `MarkdownFileLinkRewriter` / `classifyLocalFileUrlHead`；`src/bridge/adapter.ts` · `AcpLlmAdapter.stream` |
| 工具卡快照 / delta / 输出注册 | `src/impl.ts` · `acpToolCallFromUpdate` / `acpToolCallDelta` / `acpToolCallArgsOf` / `isFinalToolCallStatus`；`src/bridge/registries.ts` · `recordAcpToolOutput` / `waitForToolOutput`；详见 [protocol.md](./protocol.md) |
| 绑定 RPC | `src/impl.ts` · `dispatchRpc('session/chat-*')`；`src/bridge/session-registry-service.ts` · `bindChatAgent`；`src/bridge/chat-choice-service.ts` · `setChatSessionModel` / `setChatSessionEffort` / `setChatSessionMode` |
| 路由选择 / 老宿主请求改写 | `presets/acp/acp-guard.mjs` · `selectBoundRoute` / `agent/request`；`src/bridge/chat-choice-service.ts` · `conversationRouteModel` |
| 工作区 | `src/index.ts` · `wireWorkspace`；`src/bridge/state-paths.ts` · `chatWorkspaceRoot`；`src/bridge/session-boot-service.ts` · `SessionBootService.getOrCreateDshSession`（manager 同名转发）；`src/bridge/agent-bridge.ts` · `doResumeSession`；委派继承：`src/bridge/delegate-service.ts` · `sessionWorkspaceOf`、`src/bridge/bridge-rpc-service.ts` · `startSession`（opts 路径） |
| 锁定 | `src/bridge/session-registry-service.ts` · `lockedAgentFor` / `lockChatAgent` / `rollbackFirstTurn`；`src/bridge/live-session.ts` · `provisionalLock` |
| 桥注册表 / 生命周期 | `src/bridge/bridge-registry-service.ts` · `bridgeFor` / `pruneBridge` / `stopAgent` / `shutdownAll`（manager 保留同名转发与 `bridges` / `bridgeScopes` getter） |
| 会话启动 / resume | `src/bridge/session-boot-service.ts` · `SessionBootService`（`getOrCreateDshSession` / `resumeChatSession` / `prepareStalledSession` / `reclaimChatPrompt`，manager 保留同名转发；`waitForSettleGate` 仅服务内部使用） |
| 默认 agent | `src/bridge/manager.ts` · `defaultAgent` / `setDefaultAgent` |

## 目录索引

| 位置 | 是什么 |
|---|---|
| `src/index.ts` | Cordis 插件宿主入口：挂载 `/acp` RPC 通道与 `/api/acp/stream` SSE 路由，接线可选宿主服务 |
| `src/protocol.ts` | 前后端共享契约的桶：只有再导出，不含声明；契约本体按簇在 `src/protocol/`（`agent-def` / `views` / `events` / `save-gate` / `chat` / `rpc` / `catalog` / `llm` / `update` / `skills` / `ui`），纯类型与常量，严禁 Node 专属库或运行时代码 |
| `src/protocol-subagent.ts` | 子代理记录与详情的契约半区（`SubagentRecord` / `SubagentDetailEntry` / `SubagentDetailPayload` / 上限常量）：纯类型与常量，由 `protocol.ts` 重导出 |
| `src/subagent-records.ts` | 子代理记录的归一与封顶（`normalizeSubagentRecord` / `capSubagentRecords` / `subagentToolCallId` / `boundSubagentDetailEntry`）：纯函数，由 `impl.ts` 重导出 |
| `src/usage.ts` | `usage_update` 样本 → 上下文读数（`mergeUsageSample`）：可读样本替换读数，`size <= 0` 的成本帧（CodeBuddy 后台 team member）只并 `cost`、保留上次 `used/size`；纯函数，宿主 `AgentBridge` 与测试共用 |
| `src/impl.ts` | 纯宿主端逻辑的桶：只有再导出，逻辑本体按簇在 `src/impl/`（`errors` / `validate` / `command-line` / `paths` / `env` / `catalog` / `content` / `image` + `attachments` + `file-links` / `forward` / `permission` / `skills` / `session-log` / `runtime` 运行时持有者 / `dispatch` RPC 分发）。文档里的 `src/impl.ts · 符号` 一律指「经桶定位」，本体在对应簇：`dispatchRpc` / `AcpManager` → `dispatch.ts`，`Transcript` / `EventHub` / `PermissionLedger` → `runtime.ts`，其余按名字找簇 |
| `src/bridge/` | 宿主 ↔ ACP 子进程的 stdio 桥：进程、回合、绑定、锁、数据折叠 |
| `src/skills-scan.ts` | 宿主侧 skill 目录扫描：按 agent 风味（`skillFlavorOf`，`src/impl.ts`）扫 project/global/system 三层目录并解析 SKILL.md，喂给 `agent/skills` RPC（`src/bridge/skills-service.ts` · `SkillsService.agentSkills`，内存 TTL 缓存）；只读文件系统，不 spawn、不落盘 |
| `src/update.ts` | 内置更新：资格矩阵、registry 探测，把安装委托给宿主 `pluginManager`；不下载、不替换文件、不重启 |
| `src/client/` | 浏览器 React 扩展：`acp-ui.tsx` 座位共用结构 / 样式 / 菜单壳，`session-controls.tsx` composer 底座，`acp-view.tsx` NTR 视图，`permission-dock.tsx` 对话审批卡，`panel.tsx` 设置页（组件簇在 `panel/`：入口 `AcpSettingsSection` + 各卡片），`model-seat.tsx` 座位 claim，`slash-isolation.ts` 斜杠隔离，`store.ts` 前端状态 |
| `presets/acp/` | 随包发布的 NTR agent preset（bundle patch 声明 + `acp-guard.mjs`），属于 DSH 的 agent 平面组装，不是本插件运行时模块 |
| `~/.dsh/dsh-ntr/` | 运行时唯一落盘点：`agents.json` / `model-catalog.json` / `workspaces/`（[state.md §1](./state.md)） |
| `acp-workspaces/` | 本仓开发 / 测试用的执行目录；运行时默认工作区是 `~/.dsh/dsh-ntr/workspaces` |
| `lib/` | 构建产物，禁改（`npm run build` 全量覆盖，CI 自己 build） |
| `docs/` | 历史推导与收敛记录（acp-convergence / acp-mode / acp-permission-and-sandbox）；现行文档在 `AGENTS/`，索引见 [AGENTS.md](../AGENTS.md) |
| `CHANGELOG.md` | 面向用户的版本净改动记录，只记确定性改动（[release.md](./release.md)） |

## 术语

- **Host Half / Browser Half**：DSH 插件双端架构——Node 宿主服务与浏览器 UI 模块。本仓对应 `src/index.ts` + `src/bridge/` 与 `src/client/`。
- **Transcript**：宿主为每个会话维护的有界环形缓冲（`transcriptMaxEntries`），用于重连后按 seq 补齐、续跑段补读段间事件。连续同类纯状态 tick（`usage_update`、无 title 的 `session_info_update`、`config_option_update`）就地替换末条：seq 前进、数组不增长、保留最新值；`since()` 的 seq 空洞是正常的，实时 SSE 仍逐帧广播（细节见 [protocol.md §8](./protocol.md)）。
- **Model Catalog**：`agent/catalog` 下发的 agent 自己的 `model` / `thought_level` 面（`base` + `variants` + `reasoning` + per-model 的 `reasoningByModel`）。DSH 自己的模型目录里没有 ACP 条目。
- **exposedModels**：per-agent 的座位可见性过滤。缺省 = 全部上报模型可用（默认开放）；显式 `[]` = 只留 `base`；只影响 `agentCatalog` 的变体展开，不影响 `resolveAdapterModel`。规则集中在纯函数 `effectiveExposedModels`（`src/protocol/catalog.ts`），host 与设置卡共用。细节见 [state.md §5](./state.md)。

