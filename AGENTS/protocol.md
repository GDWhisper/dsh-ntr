# ACP 桥：进程、回合与数据兜底

本文是 [AGENTS.md](../AGENTS.md) 的展开层，覆盖宿主 ↔ agent 的 stdio 通信、进程生命周期、超时/取消、卡死收口（无活动看门狗）、恢复、空闲释放、启动命令与数据保真。
这些机制与 DSH 无关，是本插件真正的主体。

## 1. 配置与错误

- **`session/set_config_option` 响应必须反哺本地快照**：调用后从响应提取权威 `configOptions` 并广播 `session/meta`，不能只等 `config_option_update`。部分 agent（pi-acp 0.8.0）更新配置后不再推事件，不回灌 UI 会停在旧值。见 `src/bridge.ts` · `setConfigOption`。
- **boolean 配置项必须先声明能力**：`initialize` 的 `clientCapabilities.session.configOptions.boolean = {}`。不声明，agent 可以合法地不发布 `type: 'boolean'` 项（本仓曾因此只看到 select）。写回时 `session/set_config_option` 的 boolean 分支必须发 `{ type: 'boolean', value: boolean }`——请求联合按 `type` 判别，只发 value 会被当成 select 的值 id。
- **JSON-RPC `-32603 Internal error` 必须优先解析 `error.data`**：agent 的业务阻塞错误（`billing_error` / `rate_limit` / `auth_error`）放在 `data` 里，只读 `error.message` 会丢原因。见 `src/bridge.ts` · `describeError`。
- **fs 请求错误必须用 `new RequestError(code, message, { message })`**：`RequestError.internalError(x)` 的第一个参数是 **data** 不是 message，传字符串会让 wire 上只剩 `Internal error`。

**MCP 服务器随会话建立下发**：agent 级 `mcpServers`（见 [state.md §2](./state.md)）在三个建会话点**各发一次**，内容是同一份列表：

- `createSession`（`session/new`）
- `probeConfigOptions`（目录探测也走 `session/new`）
- resume 路径的 `session/load`

**三处必须是同一份列表**：实测 codebuddy 把这些服务器放进 agent **进程级**的作用域，而不是会话级 —— 同进程里先建一个带注入的会话、再建一个 `mcpServers: []` 的会话，后者会把作用域换成空的，前者的 MCP 工具随之消失（agent 日志 `serverManager.delete("injected")`）。目录探测恰恰复用同一条连接建会话，所以探测若发空列表，用户在设置页点一次「检测可用模型」就会静默剥掉正在聊的会话的 MCP 工具。

线格式由 `toAcpMcpServers` 一次性转换：**stdio 那条不带 `type`**（带了 agent 会静默丢弃），http/sse 带 `type`；`env` / `headers` 是 `[{name,value}]` 数组。

## 2. 进程死亡 ≠ 会话销毁

**崩溃路径**：`connectionLost` 只能走 `AgentBridge.releaseAll`——会话标记 `released`、settled 权限、广播 `session/released`。**已 `closed` 的会话跳过**：它的记录归 `closeSession` 删，标成 `released` 会让 `doResumeSession` 把 `closed` 翻回 `false`，复活一条正在关闭的会话。严禁在崩溃路径删除会话记录或广播 `session/closed`。

**恢复路径**：对 released 会话的 `prompt` / `setMode` / `setConfigOption`（`/acp` RPC 面），经 `locateOrResume` 自动 resume（respawn + `session/load`），会话记录原地复活：

- replay 更新会在 load 响应前到达，所以必须**先**重置 transcript、把会话注册回 `acpIndex` 并广播 `session/reset`（浏览器清空 blocks 与 seq 水位），**再**发 load 请求。
- resume 失败必须把记录 park 回 released map 并重新广播 `session/released`。
- `resumeSession` 以 inflight promise 去重并发调用。
- `loadSession` capability 检查必须在 `ensureReady` 之后：`releaseAll` 会清空旧 `initResult`，capability 只能来自新进程的 initialize。

**聊天面的四轴写入不走这条恢复**：composer 的 `session/chat-mode-set` / `chat-model-set` / `chat-effort-set` / `chat-config-set` 对 released 会话**只记录选择、绝不唤醒进程**（用户决策 2026-10-30，与释放横幅「只在发消息或点按钮时回来」同一哲学），选择由 `applyChatChoice` 在下一次恢复（下一条消息或横幅按钮）时统一应用。`setChatSessionMode` 曾是四轴里唯一先 resume 的（「模式切换本身就是把 agent 拉回来的理由」），已收回——挂起就是挂起。显示侧 released 行必须让位给 pick（`describeRoute` / `modeInForce`），否则提前切换看起来像死控件。→ [ui.md §3](./ui.md)

**记录跨宿主重启存活**：聊天会话记录持久化在 `agents.json` 的 `chatSessions`（[state.md §3.1](./state.md)），宿主重启后以 released 复原——`session/chat-resume` 与下一条消息照常走 `session/load`，释放横幅照常显示。没有这层，重启后的下一条消息会静默新开一条没有上下文的会话，「released ≠ 销毁」就断在进程边界上。

**显式恢复（用户手势）**：对话内「进程已释放」横幅的「恢复进程」按钮走 `session/chat-resume`（`BridgeManager.resumeChatSession`，按 DSH 聊天会话 id 寻址）——与下一条消息的惰性恢复同一套动作，但**绝不能走创建路径**（横幅按钮不得为没跑过 agent 的会话凭空 spawn 会话；查无绑定回 `unknown_session`）。会话已活时幂等返回（双击 / 与下一条消息竞速都不拉起第二个进程）。恢复后必须照 `getOrCreateDshSession` 的 released 分支重放 chat side effects（`lockChatAgent` / `syncConversationRoute` / `applyChatChoice` / 清 `provisionalLock`）——`session/load` 回来的会话跑在 agent 默认值上，不重放选择就是「芯片写 B、agent 跑 A」。UI 见 [ui.md §10.1](./ui.md)。

## 3. 生命周期事件的身份校验

`child.on('exit')` / `child.on('error')` / `conn.closed.then` 三个 connectionLost 触发器必须分别以 `this.child === child`、`this.conn === conn` 身份守卫，任何新触发器同理。

原因（实测竞态）：P1 崩溃 → `conn.closed` 触发 `releaseAll` → 立刻 resume 出 P2（state=`starting`）→ P1 延迟的 exit 事件看到 `starting`，误判新进程死亡，`releaseAll` 把 P2 杀掉。state 是 bridge 级的，分不清「哪个孩子」。

## 4. 超时、取消与世代

- **启动期请求必须有超时**：`initialize` / `session/new` / `session/load` 一律经 `withStartupTimeout`（`startupTimeoutMs`，默认 60s）。SDK 的 `cancellationSignal` 是协作式的，挂死的 agent 不响应 `$/cancel_request`，唯一有效超时是 race + `killChild`。
- **取消必须有强制定稿兜底**：`session/cancel` 后经 `armCancelFallback`（`cancelFallbackMs`，默认 15s）强制发出 `turn/end`（turnId='' + error）。agent 无视 cancel 不得让会话永久停在 `running`。
- **强制定稿必须带世代守卫**：武装时捕获 `session.turnSeq`（`/acp` RPC `prompt` 与适配器 `streamPrompt` 两个 turn 起点都递增），触发时世代已前进就不得动手。否则「agent 迟到结算旧 turn、用户已发新 turn」时，定时器会误杀无辜的新 turn。
- **强制定稿必须解开 `settled` 闸门**（`settledResolve`）：只置 `running=false` 不够，适配器路径的下一轮 prompt 会卡在 `unsettled`。
- **粘滞取消吞消息必须检测重发**：部分 agent（实测 codebuddy 2.161.4）异步清理 cancel 状态，清理窗口内的下一条 prompt 被秒回 `cancelled`（复用旧 requestId、不生成 turn），用户消息静默丢失。
  - 判据是「本世代是否发起过 cancel」（`session.cancelRequestedAtTurn` 对比当前 `session.turnSeq`），**不是延时**（延时随负载漂移）。
  - 判为粘滞就等 `staleCancelRetryDelayMs`（默认 600ms，须长于清理窗口）原样重发，有界 `staleCancelMaxRetries`（默认 2）。

## 5. 空闲释放

- **范围**：`AgentBridge.releaseIfIdle` 只释放 `state === 'ready'` 且 `hasActiveWork() === false` 的 bridge。活跃 = 有进行中的 turn（含已 abort、agent 尚未结算，`running || settled`）、待答审批、mode/config 命令在途（`pendingCommands`）、`pendingProbes` / `pendingCreates` / `resuming` / `starting`。**空闲的 live 会话不算活跃**：释放把它们挂起为 `released`（不是关闭），下一条消息经 `session/load` 恢复，30 分钟窗口因此对聊天进程真正生效。
- **可恢复性闸门**：agent 未声明 `loadSession` 时，有 live 会话的 bridge 不释放——无法 reload 的会话会在下一条消息时丢失上下文；这类 agent 仍等价于旧的「无 live 会话才释放」。
- **工作区搬迁不共用这条放宽**：`ensureReady` 的就地重启仍要求 `isQuiet()`（无 live 会话且无活跃工作），避免多个工作区的会话互相把进程搬来搬去。两个谓词共享 `hasActiveWork()`，「无 live 会话」只属于搬迁。
- **动作**：必须走 `releaseAll(reason)` 而不是 `stop()`——`stop` 会 `released.clear()`，毁掉尚未恢复的会话上下文。释放**静默进行，严禁广播 `agent/notice`**；`agent/notice` 只留给异常或伴随用户动作的事件（探测失败、权限超时、就地搬迁工作区）。
- **计时**：只有 `ready` 才武装定时器，窗口从 `lastActivityAt` 起算；`touch()` 会清掉已武装的定时器并按最新活动重排，因此窗口永远量到「最近一次活动」而不是更早的武装时刻。判定为「忙」时必须 `touch()` 重置窗口，否则会以 0ms 延迟自旋。
- **两档窗口**（`currentIdleTimeoutMs`）：
  - 从未登记过真实会话的 bridge（`everHostedSession === false`，探测拉起的进程，`probeConfigOptions` 刻意不登记会话）走 `DEFAULT_TUNING.probeIdleTimeoutMs`（默认 5 分钟）。`def.idleTimeoutMs`（含 `0` = 永不释放）是关于聊天进程的承诺，不管探测进程。
  - 第一个登记的会话（`createSession` / `doResumeSession`）把 bridge 翻转为 `def.idleTimeoutMs ?? DEFAULT_TUNING.idleTimeoutMs`（默认 30 分钟；`0` = 永不释放；`validateAgentDef` 只接受 0 或 [1000, 86400000] 的整数）。翻转时必须 `clearIdleTimer()` 再 `touch()` 重排。
- **展示**：`AgentView.idleTimeoutMs` 必须报告**聊天窗口**语义（`idleTimeoutMs` getter），面板拿它预填与展示。浏览器 `DEFAULT_IDLE_RELEASE_MS` 是默认值的手拷贝，改常量必须同步。
- **与卡死收口的关系**：无活动看门狗（§6.1）开火只收口 turn、不碰进程（下一条消息的善后可能重启或重置，那是另一条路径）；`running` / `settled` 清掉后 `hasActiveWork()` 自然转空，进程随后按本节窗口释放。两条路径互不替代——看门狗管「这一轮还能不能结束」，本节管「这个进程还要不要养着」。

## 6. 轮次收尾与分段

- `turn/end` 的权威来源是 `session/prompt` 的**响应**。强制定稿**恰有两条**受控路径：`session/cancel` 后的 `armCancelFallback`（§4，人已经按过取消）与无活动看门狗（§6.1，agent 自己彻底沉默）。**严禁**再加第三种，尤其不要拿「宿主观察到的空闲」直接收尾——宿主分不清「正在想」与「在忙自己的事」，提前收尾会把答案切在流中间。
- 一个 turn 由**多个段**组成（逐步切分，[architecture.md §2.2](./architecture.md)）：段的 `finish(stop)` 是步边界不是轮边界；`TurnStreamController`（`src/bridge.ts`）持有跨段的游标 / `seenCalls` / 记账。续跑批次（`isAcpToolContinuation`）**绝不新发 prompt**，用 `transcript.since(cursorSeq)` 补读段间事件；段间事件只记账（`recordAcpToolOutput` 唤醒等待者），游标不动。
- **取消与世代跨段成立**：任何段的 `AbortSignal` → `bridge.cancel` + `abortActiveSegment`；`turnSeq` 世代守卫让旧段迟到的回调动不了新 turn；prompt slot（`settled` 闸门）在 agent 确认取消**之前不解开**——`abortActiveSegment` 不得调 `endTurn`，否则下一个 prompt 会在 ACP 协议禁止的窗口并发发出。
- **两条强制定稿路径语义不同，不得互相复用**：`armCancelFallback` 是「已经要求取消、对方不回应」的兜底；看门狗是「没人要求取消、agent 自己不动了」的兜底。两者都必须按 `session.turnSeq` 做世代守卫（定时器武装时捕获；控制器用它创建时的 `turnSeqAtStart` 判定是否仍是本世代）、都只结束当前 turn 并解开 `settled` 闸门，且都不碰进程。
- **正常结束却零可见产出必须显式报出**：结算时 stop 非 cancelled 且本轮没发过任何可见块（`sawVisibleBlock`：text / reasoning / tool-call 的 block-start，跨段累计；usage 等记账帧不算），必须把告警文本作为 text 块发出。部分 agent 把上游失败（403 / 认证 / 计费）折叠成合法 `end_turn`（实测 pi-acp），否则用户只看到一个空气泡。这是**报告**不是收尾：turn 照常以 stop 结束，不重试不判错。
- **以卡收尾的 turn** 由最后一个续跑段收口：turn 已有可见产出时发一条指针行（「工具已执行、无文字回复」），绝不发空消息——空 assistant 消息不是宿主能诚实渲染的东西。
- 记录在案的边界：codebuddy 首轮会先做内部标题生成（约 5s 无任何通知）才回应 prompt，首轮收尾因此推迟。这是 agent 行为，不是宿主 bug。

### 6.1 无活动看门狗

§6 开头那条「不要拿宿主观察到的空闲直接收尾」排除的是**宿主自己的**空闲计时——它分不清「agent 正在想」与「agent 已经挂了」。但 agent 真挂住时，会话会永远停在 `running`：`settled` 闸门不开，下一条消息发不出去，屏幕上也看不到任何原因。`BridgeManager.reapStalledTurns` 是这条规则的受控例外，判据是 **agent 活动**，不是宿主空闲。

- **活动时钟**：`LiveSession.lastAgentActivityAt` 由每一条 `session/update` 刷新，turn 起点、每段起点、审批询问到达与结算也各刷一次。`LiveSession.activeToolCalls` 是**按 `toolCallId` 计的集合**（不是布尔标记）：`pending` / `in_progress` 加入，`completed` / `failed` 删除，没有 `status` 的新 `tool_call` 也算在飞；`tool_call_update` 不带 `status` 时集合不变。非空 = 长工具窗口，且并行调用各结各的，长窗口持续到**最后一个**在飞调用结束。
- **开火条件**（全部成立）：
  1. `session.running` 且未 `closed` / `released`；
  2. 该会话没有待答审批（`bridge.permissions.hasPendingFor`，与 `permissionTimeoutMode` 无关：问人不是在卡住，`auto` / `abort` 的期限由审批自己的定时器管）；
  3. 这一轮的段是**开着**的（`TurnStreamController.hasOpenSegment`）——宿主执行卡片时没有开着的段，agent 在这段时间不说话是合法的；
  4. 最近一次 agent 活动距今超过窗口：`turnStallMs`（默认 600000 / 10 分钟）；`activeToolCalls` 非空时改用 `turnStallToolMs`（默认 1800000 / 30 分钟，与 guard 的 `TOOL_OUTPUT_WAIT_MS` 对齐——工具跑得久是 agent 还在干活）。
- **控制器从哪来**：聊天轮按 chat id 索引（`BridgeManager.turnStreams`，续跑段靠它找回同一条 prompt），同时挂在 `LiveSession.turnController`；EPHEMERAL 轮（`GenerateOptions.sessionId` 未定义、没有聊天身份的适配器调用）没有 chat id，只有挂载点——只认索引会把它的段当成 `/acp` 轮，收口了会话状态却没关驱动的段队列（关队列的是 `TurnStreamController.settle`）。索引命中只在 `controller.session === session` 时才算数：并发的首轮可能把另一条 `LiveSession` 映射在同一个 chat id 下。
- **stale 控制器按不存在处理**：控制器的 `stale`（已 dispose，或 `turnSeq` 已前进）为真时不得拿它的 `hasOpenSegment` 当判据——同一聊天上一条更新的 `/acp` prompt 推进了 `turnSeq` 后，旧控制器的段早已关闭，照它判断会让这一轮永远不被看见。没有活控制器（`/acp` RPC 轮次，或只有 stale 控制器）时「开着」按真处理，收口走 `AgentBridge.finalizeTurn`。
- **扫描与开关**：`turnStallTickMs`（默认 30000）扫一次，没有 running 会话时定时器自动撤掉。三个键都是 `BridgeTuning` / `AcpPluginConfig` 字段，**只在配置文件里**（没有设置页控件）。`turnStallMs: 0` 关闭**整个**看门狗——工具窗口不能把它重新打开；`turnStallToolMs: 0` 回落 `turnStallMs`。
- **开火动作**：尽力发一次 `session/cancel`（**不 await**：对方可能正是不响应任何请求才卡住）；记 `LiveSession.orphanPromptTurnSeq = session.turnSeq`；带世代守卫**只收口一次**——有活控制器走 `TurnStreamController.settle({ kind: 'error', code: 'INACTIVITY_TIMEOUT' })`（段队列关闭、`settled` 闸门解开，暂定首轮锁按既有语义结算），否则走 `AgentBridge.finalizeTurn`（`turnId: ''` + error，与 cancel 兜底同形）；广播一条 `agent/notice`，措辞按「下一轮还能不能续上」分三支：**暂定首轮且零可见块**（`provisionalLock` 为真、`sawVisibleBlock` 为假——`settle` 会因此回滚锁并关闭会话）说「这是会话的首轮、什么都没交付，已丢弃，下一条消息会新建 ACP 会话」，**不得**承诺 resume；其余按 `loadSession` 分述——**支持**时说「下一条消息会重启 agent 并恢复会话」，**不支持**时说「下一条消息会重置 ACP 会话，该 agent 不支持会话恢复」；三支都带一句「同一 agent 上还有别的会话在用，下一次发送可能被拒到那一轮结束」。**开火本身不杀进程**——同一进程里可能还挂着别的会话，收口只把宿主这一面从「永远 running」里救出来。
- **强制收口帧只发一次，迟到的真答案按路径分述**：`settle` 幂等，`finalizeTurn` 对 `closed` 会话直接放弃、只在 `running` 或闸门仍挂着时动手。聊天路径迟到的**真**响应仍按 `settle` 的 `current`（`turnSeq === turnSeqAtStart`）判定：世代已前进就只关自己的段与 `endTurn`，不广播、不置 `running`、不放全局 waiter；仍是本世代则 `clearOrphanPrompt`，不再补第二帧，也不需要 reload。`/acp` 路径没有控制器：看门狗帧之后、reclaim 之前，迟到的真响应只要 `turnSeq` 未前进就照常广播它自己的 `turn/end`（带 `turnId` 与 stopReason）；一旦 reclaim 记下 `reclaimedTurnSeq`，该世代迟到的 then / catch 一律丢弃（见下一条）；被**外部拆除**（空闲释放 / `stop` / 关会话）抢先结束的会话同样不补帧——`prompt` 的迟到 catch 看到 `session.released || session.closed` 直接放手，因为那次拆除已经替这一轮收过场（释放发了 `turn/end`，关闭发 `session/closed`）。
- **善后（`prepareStalledSession`）**：下一条消息发出前处理（聊天在 `getOrCreateDshSession` 之前，`/acp` 在 `locateOrResume` 之后）：
  - 已 `closed` 的会话（`session/close` 在途）无物可收，直接放行——记录归 `closeSession` 删，标成 released 会被 resume 复活；已 `released` 的会话也放行，交给正常获取路径 resume。
  - 同一 agent 上还有别的活跃工作（`AgentBridge.hasOtherActiveWork`：别的会话在跑 turn 或闸门未开、别的会话有待答审批、探测、`pendingCreates`、正在 resume / 启动，以及**别的会话**的在途命令）→ 拒绝本轮（"other conversations are still using it"）。命令按会话记在 `pendingCommands`（Map），所以卡在这条会话上的 mode / config 命令不挡它自己的 reclaim。
  - 同 agent 另一条会话的控制器仍在 `turnStreams` 里且**未 stale** → 同样拒绝：那条会话已经 settle，`hasOtherActiveWork` 看不见它，但它的宿主可能正在执行卡片（续跑段即将到来），重启进程会把那条活轮次 park 再 resume。已 `closed` / `released` 的残留控制器不算，别的 agent 的也不算——重启只杀这个 agent 的子进程。
  - 有 `loadSession` → `releaseAll` 把会话挂起成 `released`，正常获取路径（聊天 `getOrCreateDshSession` / `/acp` `locateOrResume`）经 `session/load` 恢复。
  - 没有 `loadSession` → 还要求同 bridge 上没有别的 live 会话；`AgentBridge.forceReset('agent-stopped')` 杀掉子进程并就地关闭记录、广播 `session/closed`（**不发** `session/close`，也不清 `released`），随后 `forgetDshSession`。聊天下一条消息新建会话；`/acp` prompt 抛 `AcpError('session_reset', … start a new session)`，不是 `unknown_session`。
  - `AgentBridge.closeSession` 的 `session/close` 有 `SESSION_CLOSE_TIMEOUT_MS`（5000ms）上限：卡死的 agent 不能挂住 stop / rollback。
- **旧 turn 只以看门狗那一帧结束（reclaim 之后）**：reclaim 记 `LiveSession.reclaimedTurnSeq`；它关闭连接导致的旧 `session/prompt` 迟到 then / catch 对该世代被丢弃，所以看门狗的 `turn/end` 是唯一的旧轮次结束帧。cancel 兜底**不**记这个标记，它迟到的真 `end_turn` 照常广播（既有测试）。两个 turn 起点（`streamPrompt` / `/acp` `prompt`）与 resume 都会清掉这个标记，只有同一世代才抑制。
- **防御性补丁**：`openSettleGate` 清掉 `settled` / `settledResolve` 并解开闸门，`releaseAll` / `doResumeSession` / `finalizeTurn` 都经它；`releaseAll` 跳过已 `closed` 的会话（§2）并清空 `activeToolCalls`，`doResumeSession` 同样清空 `activeToolCalls`、另清 `orphanPromptTurnSeq` / `reclaimedTurnSeq` 并重置 `lastAgentActivityAt`，避免孤儿标记跨进程存活。

## 7. 启动命令与 Windows

**语义**：`AcpAgentDef.command` 是**一整条命令行**，不是裸程序名。`codebuddy --acp` 整条粘进设置页唯一的「启动命令」框是正确用法。

- 解析只走 `validateAgentDef` → `splitCommandLine`（`src/impl.ts`）：引号感知，首 token 为程序，其余**前置**并入 `args`。
- `validateAgentDef` 返回的 `command` 是**裸路径**（spawn 要的就是不带引号的它）。折叠的幂等只对**不含空白**的 command 成立；`C:\Program Files\a.exe` 被原样重校验时会在空格处再切一刀。
- `loadPersistedAgents` 每次启动重校验，靠 `quoteLegacyCommand` 补差：先把 command token 重新引号化再重校验，且只在该路径盘上存在时这么做。**严禁**给持久化的 `command` 加引号来「修」它——会弄坏两条 spawn 路径。
- **严禁**回到「命令 / 参数」两框语义：`command: 'codebuddy --acp'` 曾被当成文件名，spawn ENOENT → SDK 报 `ACP connection closed`，与真实原因毫不像。
- 浏览器半区手拷贝（`src/client/acp-ui.tsx`）必须同语义，由 `tests/acp-view.spec.ts` 样本集守等价。

**Windows**：

- `findExecutable` 命中的 npm 生成壳（`codebuddy.CMD` / `pi-acp` / `omp` / `npx`）**严禁**直接 `spawn(..., { shell: false })`（Node ≥ 20.12 抛 `EINVAL`），必须经 `windowsShimLaunch` → `cmd.exe /d /s /c "<line>"` + `windowsVerbatimArguments: true` + 外层引号对（缺任一项 cmd 报「不是内部或外部命令」）。
- spawn 一律 `windowsHide: true`。
- 回收走 `killProcessTree(pid)`（`taskkill /t /f`，与 POSIX 杀进程组对齐），且必须在进程树完整时执行。

## 8. 数据保真

用户要求：ACP agent 发什么就兜住什么。截断与占位的损失不是「少看几行」，而是 agent 说了、我们当作它没说。

- **通知层**：`session/update` 的每一种 kind 都必须有去处。
  - `agent_message_chunk` → `text`；`agent_thought_chunk` → `reasoning`；`tool_call` / `tool_call_update` → 真正的 `tool-call` 块（快照 + 前缀扩展 delta，重述按 callId 折进已开的卡）。
  - 其余 kind 在原生聊天流落成一行 `describeUnhandledUpdate` 文本（每种类一行、文本变了才重发）。**严禁** `default: 丢弃`。
  - 两张例外表分工不同：原生流对 `BOOKKEEPING_UPDATES`（`current_mode_update` / `config_option_update` / `available_commands_update` / `session_info_update` / `usage_update`）一个字都不发；ACP 视图只对 `STATE_ONLY_UPDATES`（`config_option_update` / `usage_update` / `session_info_update`）不落 block，其余（含 `current_mode_update` / `available_commands_update` / `plan`）落成带 `raw` 原文的 `event` block。
  - **`usage_update` 是上下文占用，不是请求 token**：`used` / `size` 只写 `session.usage`（ACP 视图与 composer 占用环的 `used/size`）。宿主 `session/chat-list` 的会话行也带 `usage`；浏览器在同一批 `session/update` 折叠里把它落到 `chatSessions` 与被观察 transcript，**严禁**只更新其中一处。原生聊天流的 `usage` 块是插件按段生成的**输出估算**——正文 + 思考的 UTF-16 单元数 ÷ 4，`inputTokens` 恒 `0`（issue #6）。**严禁**把 `size` / `used` 映射成 input/output：那会造出「17 步 × 1M」的总量和失真的 tok/s。`inputTokens: 0` 让宿主的缓存命中率自然不显示，而不是显示假 `0%`。工具参数不计入估算——部分 agent 每次重报整段 `rawInput`，会把瞬时字符记成输出。
- **形状层**：块的 `content` 可以是字符串、对象或数组；`rawInput` / `arguments` 可以是字符串、对象或**数组**。这些都算「有值」，空字符串 / `null` / 空数组才算「没有」。**严禁**用 `content?.type === 'text'` 一类窄判定把别的形状读成空。
- **字段层**：ACP 视图的工具卡把 `kind` / `status` / `locations` / `terminalId` / `meta` 进 `details`，整个通知原文进 `raw`（`dumpJson`，只在 `ACP_TOOL_RAW_MAX` 截断且带标记）。`available_commands` 条目整条保留（`...c` 展开）。
- **diff**：同时保留结构化 diff（ACP 视图 `DiffView`）与文本（路径 + `-`/`+` 行，`formatAcpDiff`）。**严禁**退回 `[diff path]` 占位；未知 content kind 保留整条 JSON（`acpContentRows` 的 `other`）。这份文本也是虚拟工具答给宿主执行记录的输出，不能是占位符。
- **预算**：`ACP_TOOL_RAW_MAX` / `RAW_MAX`（256,000 字符）、`transcriptMaxEntries`（默认 600）、浏览器 `MAX_BLOCKS`（400）是有界容器，不是丢数据的理由；超限必须留截断标记。**严禁**给 stderr 行、npm 安装输出这类诊断文本加「取前 N 字符」——那正是激活失败时唯一有用的一行。
- **通知身份**：没有卡片的种类（plan / mode / 未来新增）在原生流里每种类只发一行，文本变了才重发（`announcedKinds`）；ACP 视图按 kind 折叠（`store.ts` · `foldUpdate` 对 `plan` 就地更新）。

## 代码索引

| 主题 | 位置 |
|---|---|
| 桥与进程 | `src/bridge.ts` · `spawnAndConnect` / `killChild` / `killProcessTree` / `windowsShimLaunch` |
| 恢复 | `src/bridge.ts` · `connectionLost` / `releaseAll` / `resumeSession` / `locateOrResume` |
| 超时与取消 | `src/bridge.ts` · `withStartupTimeout` / `armCancelFallback` / `runPrompt` |
| 卡死收口 | `src/bridge.ts` · `BridgeManager.reapStalledTurns` / `prepareStalledSession`；`LiveSession.turnController` / `activeToolCalls` / `orphanPromptTurnSeq` / `reclaimedTurnSeq`；`TurnStreamController.stale` / `hasOpenSegment` / `settle`（`INACTIVITY_TIMEOUT`）；`AgentBridge.finalizeTurn` / `forceReset`（§6.1） |
| 空闲 | `src/bridge.ts` · `releaseIfIdle` / `armIdleRelease` / `touch` / `currentIdleTimeoutMs` / `everHostedSession` |
| 收尾与分段 | `src/bridge.ts` · `streamPrompt` / `TurnStreamController` / `sawVisibleBlock` / `isAcpToolContinuation`（分段续读与收尾见 [architecture.md §2.2](./architecture.md)） |
| 数据折叠 | `src/impl.ts` · `acpContentRows` / `formatAcpDiff` / `dumpJson` / `describeUnhandledUpdate` / `acpToolCallFromUpdate` / `acpToolCallDelta` |
| 启动命令 | `src/impl.ts` · `validateAgentDef` / `splitCommandLine`；`src/bridge.ts` · `quoteLegacyCommand` |
| MCP 下发 | `src/bridge.ts` · `toAcpMcpServers`（线格式转换）；`src/impl.ts` · `validateMcpServers`（配置校验）；面板三处同步见 `src/client/panel.tsx` · `initialForm` / `buildPayload` / `payloadEquals` |
