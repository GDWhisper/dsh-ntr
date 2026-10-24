# ACP 桥：进程、回合与数据兜底

本文是 [AGENTS.md](../../AGENTS.md) 的展开层，覆盖宿主 ↔ agent 的 stdio 通信、进程生命周期、超时/取消、恢复、空闲释放、启动命令与数据保真。
这些机制与 DSH 无关，是本插件真正的主体。

## 1. 配置与错误

- **`session/set_config_option` 响应必须反哺本地快照**：调用后从响应提取权威 `configOptions` 并广播 `session/meta`，不能只等 `config_option_update`。部分 agent（pi-acp 0.8.0）更新配置后不再推事件，不回灌 UI 会停在旧值。见 `src/bridge.ts` · `setConfigOption`。
- **JSON-RPC `-32603 Internal error` 必须优先解析 `error.data`**：agent 的业务阻塞错误（`billing_error` / `rate_limit` / `auth_error`）放在 `data` 里，只读 `error.message` 会丢原因。见 `src/bridge.ts` · `describeError`。
- **fs 请求错误必须用 `new RequestError(code, message, { message })`**：`RequestError.internalError(x)` 的第一个参数是 **data** 不是 message，传字符串会让 wire 上只剩 `Internal error`。

## 2. 进程死亡 ≠ 会话销毁

**崩溃路径**：`connectionLost` 只能走 `AgentBridge.releaseAll`——会话标记 `released`、settled 权限、广播 `session/released`。严禁在崩溃路径删除会话记录或广播 `session/closed`。

**恢复路径**：对 released 会话的 `prompt` / `setMode` / `setConfigOption`，经 `locateOrResume` 自动 resume（respawn + `session/load`），会话记录原地复活：

- replay 更新会在 load 响应前到达，所以必须**先**重置 transcript、把会话注册回 `acpIndex` 并广播 `session/reset`（浏览器清空 blocks 与 seq 水位），**再**发 load 请求。
- resume 失败必须把记录 park 回 released map 并重新广播 `session/released`。
- `resumeSession` 以 inflight promise 去重并发调用。
- `loadSession` capability 检查必须在 `ensureReady` 之后：`releaseAll` 会清空旧 `initResult`，capability 只能来自新进程的 initialize。

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

- **范围**：`AgentBridge.releaseIfIdle` 只释放 `state === 'ready'` 且 `hasActiveWork() === false` 的 bridge。活跃 = 有进行中的 turn（含已 abort、agent 尚未结算，`running || settled`）、待答审批、mode/config 命令在途（`pendingCommands`）、`pendingProbes` / `resuming` / `starting`。**空闲的 live 会话不算活跃**：释放把它们挂起为 `released`（不是关闭），下一条消息经 `session/load` 恢复，30 分钟窗口因此对聊天进程真正生效。
- **可恢复性闸门**：agent 未声明 `loadSession` 时，有 live 会话的 bridge 不释放——无法 reload 的会话会在下一条消息时丢失上下文；这类 agent 仍等价于旧的「无 live 会话才释放」。
- **工作区搬迁不共用这条放宽**：`ensureReady` 的就地重启仍要求 `isQuiet()`（无 live 会话且无活跃工作），避免多个工作区的会话互相把进程搬来搬去。两个谓词共享 `hasActiveWork()`，「无 live 会话」只属于搬迁。
- **动作**：必须走 `releaseAll(reason)` 而不是 `stop()`——`stop` 会 `released.clear()`，毁掉尚未恢复的会话上下文。释放**静默进行，严禁广播 `agent/notice`**；`agent/notice` 只留给异常或伴随用户动作的事件（探测失败、权限超时、就地搬迁工作区）。
- **计时**：只有 `ready` 才武装定时器，窗口从 `lastActivityAt` 起算；`touch()` 会清掉已武装的定时器并按最新活动重排，因此窗口永远量到「最近一次活动」而不是更早的武装时刻。判定为「忙」时必须 `touch()` 重置窗口，否则会以 0ms 延迟自旋。
- **两档窗口**（`currentIdleTimeoutMs`）：
  - 从未登记过真实会话的 bridge（`everHostedSession === false`，探测拉起的进程，`probeConfigOptions` 刻意不登记会话）走 `DEFAULT_TUNING.probeIdleTimeoutMs`（默认 5 分钟）。`def.idleTimeoutMs`（含 `0` = 永不释放）是关于聊天进程的承诺，不管探测进程。
  - 第一个登记的会话（`createSession` / `doResumeSession`）把 bridge 翻转为 `def.idleTimeoutMs ?? DEFAULT_TUNING.idleTimeoutMs`（默认 30 分钟；`0` = 永不释放；`validateAgentDef` 只接受 0 或 [1000, 86400000] 的整数）。翻转时必须 `clearIdleTimer()` 再 `touch()` 重排。
- **展示**：`AgentView.idleTimeoutMs` 必须报告**聊天窗口**语义（`idleTimeoutMs` getter），面板拿它预填与展示。浏览器 `DEFAULT_IDLE_RELEASE_MS` 是默认值的手拷贝，改常量必须同步。

## 6. 轮次收尾与分段

- `turn/end` 只在 `session/prompt` 的**响应**返回时发出。**严禁**为「agent 不再吐字但仍在 running」新增按空闲计时的强制定稿——宿主分不清「正在想」与「在忙自己的事」，提前收尾会把答案切在流中间。
- 一个 turn 由**多个段**组成（逐步切分，[architecture.md §2.2](./architecture.md)）：段的 `finish(stop)` 是步边界不是轮边界；`TurnStreamController`（`src/bridge.ts`）持有跨段的游标 / `seenCalls` / 记账。续跑批次（`isAcpToolContinuation`）**绝不新发 prompt**，用 `transcript.since(cursorSeq)` 补读段间事件；段间事件只记账（usage / `recordAcpToolOutput` 唤醒等待者），游标不动。
- **取消与世代跨段成立**：任何段的 `AbortSignal` → `bridge.cancel` + `abortActiveSegment`；`turnSeq` 世代守卫让旧段迟到的回调动不了新 turn；prompt slot（`settled` 闸门）在 agent 确认取消**之前不解开**——`abortActiveSegment` 不得调 `endTurn`，否则下一个 prompt 会在 ACP 协议禁止的窗口并发发出。
- 唯一允许的强制定稿是 `session/cancel` 后的 `armCancelFallback`，两者语义不同，不得复用。
- **正常结束却零可见产出必须显式报出**：结算时 stop 非 cancelled 且本轮没发过任何可见块（`sawVisibleBlock`：text / reasoning / tool-call 的 block-start，跨段累计；usage 等记账帧不算），必须把告警文本作为 text 块发出。部分 agent 把上游失败（403 / 认证 / 计费）折叠成合法 `end_turn`（实测 pi-acp），否则用户只看到一个空气泡。这是**报告**不是收尾：turn 照常以 stop 结束，不重试不判错。
- **以卡收尾的 turn** 由最后一个续跑段收口：turn 已有可见产出时发一条指针行（「工具已执行、无文字回复」），绝不发空消息——空 assistant 消息不是宿主能诚实渲染的东西。
- 记录在案的边界：codebuddy 首轮会先做内部标题生成（约 5s 无任何通知）才回应 prompt，首轮收尾因此推迟。这是 agent 行为，不是宿主 bug。

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
| 空闲 | `src/bridge.ts` · `releaseIfIdle` / `armIdleRelease` / `touch` / `currentIdleTimeoutMs` / `everHostedSession` |
| 收尾与分段 | `src/bridge.ts` · `streamPrompt` / `TurnStreamController` / `sawVisibleBlock` / `isAcpToolContinuation`（分段续读与收尾见 [architecture.md §2.2](./architecture.md)） |
| 数据折叠 | `src/impl.ts` · `acpContentRows` / `formatAcpDiff` / `dumpJson` / `describeUnhandledUpdate` / `acpToolCallFromUpdate` / `acpToolCallDelta` |
| 启动命令 | `src/impl.ts` · `validateAgentDef` / `splitCommandLine`；`src/bridge.ts` · `quoteLegacyCommand` |
