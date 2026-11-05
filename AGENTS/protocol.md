# ACP 桥：进程、回合与数据兜底

本文是 [AGENTS.md](../AGENTS.md) 的展开层，覆盖宿主 ↔ agent 的 stdio 通信、进程生命周期、超时/取消、卡死收口（无活动看门狗）、恢复、空闲释放、启动命令与数据保真。
这些机制与 DSH 无关，是本插件真正的主体。

## 1. 配置与错误

- **`session/set_config_option` 响应必须反哺本地快照**：调用后从响应提取权威 `configOptions` 并广播 `session/meta`，不能只等 `config_option_update`。部分 agent（pi-acp 0.8.0）更新配置后不再推事件，不回灌 UI 会停在旧值。见 `src/bridge.ts` · `setConfigOption`。
- **boolean 配置项必须先声明能力**：`initialize` 的 `clientCapabilities.session.configOptions.boolean = {}`。不声明，agent 可以合法地不发布 `type: 'boolean'` 项（本仓曾因此只看到 select）。写回时 `session/set_config_option` 的 boolean 分支必须发 `{ type: 'boolean', value: boolean }`——请求联合按 `type` 判别，只发 value 会被当成 select 的值 id。
- **JSON-RPC `-32603 Internal error` 必须优先解析 `error.data`**：agent 的业务阻塞错误（`billing_error` / `rate_limit` / `auth_error`）放在 `data` 里，只读 `error.message` 会丢原因。见 `src/bridge.ts` · `describeError`。
- **`session/prompt` 的拒绝走 resolve，理由只在响应 `_meta` 里**：CodeBuddy 对超配额的 prompt 回 `stopReason: 'refusal'`（**不是** reject），详情是响应 `_meta["codebuddy.ai/errorMessage"]` 的一段 JSON 字符串（`{ code, message, data: { statusCode, code, category } }`）。SDK 的 prompt 响应 schema 会剥掉顶层 `errorMessage`，但 `_meta` 原样到达插件，所以 `describeError` 永远看不到它。判定走 `src/bridge.ts` · `agentRefusalDetail`（纯函数，参数是 `_meta` 本身）：`data.category === 'quota'` 或 `data.statusCode === 429` 才是限流，其余 refusal 只是普通拒绝；JSON 损坏或 `message` 为空时 message 回落原始字符串，**不许**丢文本。限流回合在 `streamPrompt` 的响应分支里**排在 hold / ambient 判定之前**结算为 `{ kind: 'error', code: 'rate_limited', errorKind: 'quota' }`（`errorKind` 随 `turn/end` 与 `TurnSettle` 的 error 变体下发），同时在 `LiveSession.quotaRefusal` 记 `{ message, at }` 并广播 `session/meta`（供 composer 的 dock 卡渲染，[ui.md §10.2](./ui.md)）；`snapshot()` 只带 `message`，`at` 时间戳不进视图。下一条非限流响应与每个生命周期边界（`clearAmbientState`：close / release / resume / forceReset）清除它。`quotaRefusal` 是**瞬态字段，严禁**写进 `chatSessions` 持久化——上一次宿主运行留下的配额对本次运行没有意义。非限流的 refusal 仍按 `{ kind: 'stop', stopReason: 'refusal' }` 收口，零输出文案说「agent 拒绝了本轮」并**附上 agent 自己给的 reason**（`TurnSettle` stop 变体的 `refusal` 字段 → `zeroOutputLine`），不要说「没有可见输出」——refusal 是唯一自带理由的 stopReason，丢掉它就是约束 29 的静默丢弃。
- **两个 prompt 面共用同一份 `quotaRefusal`**：`streamPrompt`（聊天面）与 `BridgeManager.prompt`（`/acp` 面）各自读 `agentRefusalDetail`、各自记 / 清记录并广播 `session/meta`，`/acp` 的限流 `turn/end` 带 `error` + `errorKind: 'quota'`（文案共用 `rateLimitedTurnError`）。一条 `LiveSession` 可以被两个面轮流驱动，只在一侧清除会让横幅挂到已经被推翻的答案上。**不许**把这段判定下沉成第三个共用的 settle 路径：两面的收口帧形状不同（聊天面经 `TurnStreamController.settle`，`/acp` 面自己广播），共用只会把 `hold` / `ambient` 的判定顺序也搅在一起。
- **`at` 不参与任何过期判断**：它只记录拒绝发生的时刻。agent 给的重置时间是 `message` 里的自然语言（「将在 … 重置」），宿主**严禁**去解析它当过期时钟——那等于替 agent 声明一个它没说的策略。记录的消失靠证据：下一条非限流响应，或生命周期边界（空闲释放因此给横幅一个上界）。
- **接线有集成测试**：`tests/quota-refusal.spec.ts` 用真实子进程钉住上述行为（quota 结算与记录、下一条清除并广播、生命周期边界清除、quota 排在 ambient / detached-worker hold 之前、`/acp` 共用、非 quota refusal 的原文进零输出文案），mock 侧 marker 是 `QUOTA` / `QUOTA_DRAIN` / `QUOTA_WORKER` / `REFUSED`。纯解析分支在 `tests/impl.spec.ts`。改这段接线时两类测试都必须跑。
- **fs 请求错误必须用 `new RequestError(code, message, { message })`**：`RequestError.internalError(x)` 的第一个参数是 **data** 不是 message，传字符串会让 wire 上只剩 `Internal error`。

**MCP 服务器随会话建立下发**：agent 级 `mcpServers`（见 [state.md §2](./state.md)）在四个建会话点**各发一次**，内容是同一份列表：

- `createSession`（`session/new`）
- `probeConfigOptions`（目录探测也走 `session/new`）
- resume 路径的 `session/load`
- 分叉路径的 `session/fork`（见下方「第四个建会话点」）

**四处必须是同一份列表**：实测 codebuddy 把这些服务器放进 agent **进程级**的作用域，而不是会话级 —— 同进程里先建一个带注入的会话、再建一个 `mcpServers: []` 的会话，后者会把作用域换成空的，前者的 MCP 工具随之消失（agent 日志 `serverManager.delete("injected")`）。目录探测恰恰复用同一条连接建会话，所以探测若发空列表，用户在设置页点一次「检测可用模型」就会静默剥掉正在聊的会话的 MCP 工具。

线格式由 `toAcpMcpServers` 一次性转换：**stdio 那条不带 `type`**（带了 agent 会静默丢弃），http/sse 带 `type`；`env` / `headers` 是 `[{name,value}]` 数组。

### 进程归属与错误码（A1）

`BridgeManager.bridges` 以 `bridgeKey(agentId, scope)` 为键，`scope` 有 `agent` / `chat` / `ephemeral` / `probe` 四态（见 [architecture.md §1.2](./architecture.md)）。只有 `codebuddy` 走 A1 每会话一进程；其余 agent 仍是一条连接、一个进程，所有 scope 折叠到裸 `agentId`。归属判定产生三个错误码：

- **`agent_stopping`**：`stopAgent` / `saveAgentNow` / `deleteAgent` 正在停止该 agent（`stoppingAgents > 0`）。`bridgeFor` 拒绝新建，已存在的 holder 也拒绝外借；消息**不排队**，这一轮直接失败，停止完成后下一条消息照常新建进程。设置页保存 / 删除的确认窗口里发消息会命中它。
- **`session_orphaned`**：`getOrCreateDshSession` 看到 `dshSessionMap` 里的 live 绑定，但 `bridgeOwning` 的三态（`hasSession` / `hasReleased` / 正在 `inflightResume`）都未命中——该 ACP 会话已不在任何 holder 里。先 `forgetDshSession`，再失败；**不**为孤儿记录凭空 spawn，也不回落到别的会话的进程。下一条消息重新走创建路径。
- **`fork_unsupported`**：A1 下分叉能力被强制关闭。`noteForkCapability` 对 CodeBuddy 直接写 `false`，`canForkNow` 直接返回 `false`；即使 `initialize` 宣告了 `sessionCapabilities.fork`，`adoptForkedSession` 与 `AgentBridge.forkSession` 也拒。浏览器侧分支按钮按行 `fork` 字段置灰（[ui.md §12](./ui.md)），绕过 UI 的请求零会话创建即失败。

### session/fork（第四个建会话点）

「在新对话中分支」的 ACP 半段：agent 把自己的内部状态拷进一条**新的** ACP 会话，子会话真的记得父会话的上文。分叉固定两段——**宿主先建 DSH 会话树**（`sessions.fork` 复制历史、标题 `(1)`、挂工作区），**插件再接管 ACP 侧**（`session/chat-fork-adopt` → `BridgeManager.adoptForkedSession` → `AgentBridge.forkSession`）；顺序不可对调，因为 ACP fork 没有切点参数，反过来先 ACP fork 再宿主 fork，第二步失败会留下无法归属的 ACP 会话。UI 侧见 [ui.md §12](./ui.md)。

- **UNSTABLE 方法与能力位**：请求经 `methods.agent.session.fork`（SDK 的 `unstable_forkSession`，UNSTABLE / @experimental），能力位是 `initialize` 的 `agentCapabilities.sessionCapabilities.fork`。请求形状 `{ sessionId, cwd, mcpServers }` —— **没有切点参数**，只能从 agent 当前末端分叉。cwd 取父会话已验证的工作区并把它自己加进 extraRoots 重新信任（`resolveSessionCwd`），**严禁**回落 agent 配置的沙箱 cwd——那不是会话所在的地方。
- **与其它三个建会话点共享的纪律**：同一份 `mcpServers`（进程级作用域，上方四处）；包 `withStartupTimeout`（与 `session/new` / `session/load` 同一超时）；在飞时计入 `pendingForks`（进 `hasActiveWork` / `hasOtherActiveWork`，空闲回收不能杀掉 fork 途中的进程）；响应的 `modes` / `configOptions` 过 `usableConfigOptions` 建 `LiveSession`，并经 `onCatalog` 反哺 agent 级目录——子会话的 composer 芯片不用等一次探测；返回 id 去重后才注册 `acpIndex` / `sessions`。
- **`adoptForkedSession` 的前置校验（每一项不过都零请求即拒）**：父会话必须 live 且非 running——`parent_not_live`（fork 一个 released 记录等于悄悄 resume 它）与 `turn_in_flight`（分叉一个父 turn 还在改变的状态）；子 DSH 会话键未被占用——`id_conflict`（已绑定即拒）；`canForkNow` 不过——`fork_unsupported`（活的 initialize 优先、`forkCaps` 最后已知兜底，见 [state.md §3.2](./state.md)；agent 没宣告过**不许问**，问了至多换来 unknown-method）。`parent_not_live` / `turn_in_flight` 两档在浏览器点击前就按行 `fork` 字段置灰挡掉，这里是硬闸。
- **返回校验**：id 非空（`fork_failed`）；id ≠ 父且不撞本连接已注册的会话（`fork_id_conflict`）——撞了拒绝注册，否则父会话的 `session/update`、审批询问会被路由进子会话。错误码全集：`parent_not_live` / `turn_in_flight` / `id_conflict` / `fork_unsupported` / `fork_failed` / `fork_id_conflict`，以及共享路径的 `agent_unreachable`（连接未开）、`agent_timeout`（`withStartupTimeout`）、`bad_cwd` / `cwd_denied` / `no_cwd`（`resolveSessionCwd`）与 `unknown_agent`（`bridge()` 查不到 agent）。
- **all-or-nothing**：任何一步失败都不写子会话的任何绑定（choice / 锁 / 索引 / 记录全不写），子会话首条消息走原 `session/new`——等价于没有分叉功能时的行为，不留下半接管的会话；失败原因经 `flashError` 进设置页横幅（约束 38）。成功才写 choice = 父 choice 拷贝 + `locked: true`（经 `patchChatChoice`，[state.md §3.2](./state.md)）、广播 `session/meta`、浏览器 `openSession` 打开子会话。

## 2. 进程死亡 ≠ 会话销毁

**崩溃路径**：`connectionLost` 只能走 `AgentBridge.releaseAll`——会话标记 `released`、settled 权限、广播 `session/released`。**已 `closed` 的会话跳过**：它的记录归 `closeSession` 删，标成 `released` 会让 `doResumeSession` 把 `closed` 翻回 `false`，复活一条正在关闭的会话。严禁在崩溃路径删除会话记录或广播 `session/closed`。

**未结算 prompt 保护**：`AgentBridge.pendingPrompts` 是「会话 id → 计数」的 Map，在 `session/prompt` 请求发出前加一、在响应或错误落地时减一，包住整个 await。两套读数刻意不同：`hasActiveWork()` 的严格计数（含已 `closed` 会话）进入 `isQuiet()`，所以 `pruneBridge` 与工作区搬迁必须等残留请求落地；空闲释放用 `hasActiveWork(false)` 的 `pendingPromptsOnServableSessions()`，只数 live / released 会话上的请求——已 `closed` 会话的永不答复不能钉死进程（约束 19）。`streamPrompt` 结算后的 `.finally` 再补一次 `pruneBridge`。没有这层，「会话关了、请求还在跑」会把唯一能答的进程杀掉，pending request 永远悬挂；没有放宽，一个坏 agent 会让进程永久常驻。

**归属三态**：`bridgeOwning` 只认 `hasSession` / `hasReleased` / `inflightResume`。恢复在途时 `getOrCreateDshSession` `await` 同一个 inflight promise 并复用同一 `LiveSession`，**不再新建第二个 ACP 会话**。三态都未命中且 `dshSessionMap` 仍有 live 绑定，才 `forgetDshSession` 并抛 `session_orphaned`（§1）。

**恢复路径**：对 released 会话的 `prompt` / `setMode` / `setConfigOption`（`/acp` RPC 面），经 `locateOrResume` 自动 resume（respawn + `session/load`），会话记录原地复活：

- replay 更新会在 load 响应前到达，所以必须**先**重置 transcript、把会话注册回 `acpIndex` 并广播 `session/reset`（浏览器清空 blocks 与 seq 水位），**再**发 load 请求。
- resume 失败必须把记录 park 回 released map 并重新广播 `session/released`。
- `resumeSession` 以 inflight promise 去重并发调用。
- `loadSession` capability 检查必须在 `ensureReady` 之后：`releaseAll` 会清空旧 `initResult`，capability 只能来自新进程的 initialize。

**聊天面的四轴写入不走这条恢复**：composer 的 `session/chat-mode-set` / `chat-model-set` / `chat-effort-set` / `chat-config-set` 对 released 会话**只记录选择、绝不唤醒进程**（用户决策 2026-10-30，与释放横幅「只在发消息或点按钮时回来」同一哲学），选择由 `applyChatChoice` 在下一次恢复（下一条消息或横幅按钮）时统一应用。`setChatSessionMode` 曾是四轴里唯一先 resume 的（「模式切换本身就是把 agent 拉回来的理由」），已收回——挂起就是挂起。显示侧 released 行必须让位给 pick（`describeRoute` / `modeInForce`），否则提前切换看起来像死控件。→ [ui.md §3](./ui.md)

**记录跨宿主重启存活**：聊天会话记录持久化在 `agents.json` 的 `chatSessions`（[state.md §3.1](./state.md)），宿主退出本身也走释放语义（`AgentBridge.shutdown`，见 §7）而不是 `stop`；宿主重启后以 released 复原——`session/chat-resume` 与下一条消息照常走 `session/load`，释放横幅照常显示。没有这层，重启后的下一条消息会静默新开一条没有上下文的会话，「released ≠ 销毁」就断在进程边界上。

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
  - **重发必须仍属本回合世代**：`runPrompt` 的 `turnGen` 是本回合的 `session.turnSeq`，重发前与延时后都校验 `session.turnSeq === turnGen`；已被后继回合接管就把迟到答案原样返回、不再重发（否则会向新回合多发一条 `session/prompt`）。聊天与 `/acp` 两个调用点都传本回合世代。
  - **延时窗口里的第二次停止不许被重发吞掉**：粘滞判定与延时结束后都再查 `session.cancelRequestedAtTurn === session.turnSeq`——第二次点停止命名的仍是本世代，世代守卫拦不住它；命中就把 `cancelled` 答案原样返回、不再重发（否则用户刚停掉的 prompt 会被重新发给 agent）。

## 5. 空闲释放

- **范围**：`AgentBridge.releaseIfIdle` 只释放 `state === 'ready'` 且 `hasActiveWork(false) === false` 的 bridge。活跃 = 有进行中的 turn（含已 abort、agent 尚未结算，`running || settled`）、待答审批、mode/config 命令在途（`pendingCommands`）、`pendingProbes` / `pendingCreates` / `pendingForks`（分叉在途，§1）/ `pendingPromptsOnServableSessions()`（live 或 released 会话上未结算的 `session/prompt`，见 §2）/ `resuming` / `starting`。**空闲的 live 会话不算活跃**：释放把它们挂起为 `released`（不是关闭），下一条消息经 `session/load` 恢复，30 分钟窗口因此对聊天进程真正生效。**已从 `sessions` 删除的会话，其残留请求只在严格计数里算**——它们阻止 `pruneBridge` 与工作区搬迁，但不阻止空闲释放，否则一个永不答的 agent 会让进程永久常驻；关闭在途的记录仍留在 `sessions`，按可服务计，最多多等一个 `SESSION_CLOSE_TIMEOUT_MS`（5 秒）。
- **可恢复性闸门**：agent 未声明 `loadSession` 时，有 live 会话的 bridge 不释放——无法 reload 的会话会在下一条消息时丢失上下文；这类 agent 仍等价于旧的「无 live 会话才释放」。
- **工作区搬迁不共用这条放宽**：`ensureReady` 的就地重启仍要求 `isQuiet()`（无 live 会话且无活跃工作），避免多个工作区的会话互相把进程搬来搬去。两个谓词共享 `hasActiveWork()`，「无 live 会话」只属于搬迁。
- **动作**：必须走 `releaseAll(reason)` 而不是 `stop()`——`stop` 会 `released.clear()`，毁掉尚未恢复的会话上下文（宿主退出同理，走 `AgentBridge.shutdown`，见 §7）。释放**静默进行，严禁广播 `agent/notice`**；`agent/notice` 只留给异常或伴随用户动作的事件（探测失败、权限超时、就地搬迁工作区）。
- **子进程启动失败的通知**：单个 holder 启动失败时 `AgentView.state` 是 `error`；若同一 agent 还有健康的兄弟 holder，聚合状态仍为 `ready`，但必须补一条 `agent/notice`（`level: 'error'`，文本含 `failed to start`），否则用户只能看到一个看似正常的 agent。`noticedBridgeFailures` 按 holder + 文本去重，同一失败不重复刷屏；通知进设置页「日志」，不浮在对话上（[ui-panel.md §8](./ui-panel.md)）。
- **多进程状态聚合**：`agentViews` 对同一 agent 的全部 holder 聚合。空集返回 `makeBridge(def).view()`，不从别处借状态；state 优先级 `ready > starting > error > stopped`；`base` 取第一条与结果同 state 的 holder；`liveSessions` 取并集；`stderrTail` 只随 `error` 带出。`publishAgentStatus` 只取与聚合 state 相同且 `errorText` 有值的子进程——stopped 兄弟的旧错误不得污染 `ready` 聚合。
- **计时**：只有 `ready` 才武装定时器，窗口从 `lastActivityAt` 起算；`touch()` 会清掉已武装的定时器并按最新活动重排，因此窗口永远量到「最近一次活动」而不是更早的武装时刻。判定为「忙」时必须 `touch()` 重置窗口，否则会以 0ms 延迟自旋。
- **两档窗口**（`currentIdleTimeoutMs`）：
  - 从未登记过真实会话的 bridge（`everHostedSession === false`，探测拉起的进程，`probeConfigOptions` 刻意不登记会话）走 `DEFAULT_TUNING.probeIdleTimeoutMs`（默认 5 分钟，**固定**、不随全局设置变）。`def.idleTimeoutMs`（含 `0` = 永不释放）是关于聊天进程的承诺，不管探测进程。**A1 例外**：`probeAgentModels` 的 `probe` scope holder 在探针结束时就 `pruneBridge`（[architecture.md §1.2](./architecture.md)），5 分钟窗口只兜底未被显式回收的空 holder。
  - 第一个登记的会话（`createSession` / `doResumeSession`）把 bridge 翻转为 `def.idleTimeoutMs ?? 全局窗口`（见下）。翻转时必须 `clearIdleTimer()` 再 `touch()` 重排。
- **全局窗口 = 三层取值**（`def.idleTimeoutMs` → 设置页 → 部署基线 → 内置默认 30 分钟）：per-agent 的显式值最优先；没有它时用设置页「进程管理」的滑块值；再没有就用 `cordis.patch.yml` 的插件级 `idleTimeoutMs`；最后是 `DEFAULT_TUNING.idleTimeoutMs`（30 分钟）。**per-agent 那一层必须是「显式值或留空」，绝不能把宿主解析值回填进 agent 定义**——回填等于把全局窗口冻结进该 agent，全局滑块就再也到不了它。设置页的 pick 存在插件自己的状态文件里（与 agent 注册表同文件），**热生效**：`applyIdleRelease` 改写运行中 bridge 的默认窗口并重排定时器，用户不必杀会话。**重置目标是部署基线，不是内置常量**：`AcpIdleRelease.defaultIdleTimeoutMs` 报的是「重置回到哪个窗口」（部署写了就用部署的，否则用内置 30 分钟），`configuredIdleTimeoutMs` 只在配置文件真的写了那个键时才出现——设置卡绝不能对着一个什么都没说的文件宣称「文件要求 30 分钟」。滑动档位是共享阶梯 `IDLE_RELEASE_MS`（1 分钟，其后每 5 分钟一档到 1 小时），浏览器只出阶梯上的值，宿主只收阶梯上的值——滑块能出的值一定是宿主会跑的值。
- **展示**：`AgentView.idleTimeoutMs` 必须报告**聊天窗口**语义（`idleTimeoutMs` getter）。设置页的 per-agent 输入框只显示**该 agent 自己的显式覆盖**（空 = 跟随全局），不显示解析值。
- **与卡死收口的关系**：无活动看门狗（§6.1）开火只收口 turn、不碰进程（下一条消息的善后可能重启或重置，那是另一条路径）；`running` / `settled` 清掉后**还要等 `pendingPrompts` 归零**，`hasActiveWork()` 才会转空。空闲释放看的是放宽口径 `hasActiveWork(false)`：只等 live / released 会话上的待答请求归零，**已 `closed` 会话的残留请求不钉住进程**（§2 双口径）。两条路径互不替代——看门狗管「这一轮还能不能结束」，本节管「这个进程还要不要养着」。

## 6. 轮次收尾与分段

- `turn/end` 的权威来源是 `session/prompt` 的**响应**。`settle` 当场认领（幂等，与看门狗竞速），收口工作隔一个宏任务（`setImmediate` → `flushScheduledClose`）：`drainTail` 把**已进入 transcript** 却还没折进段的通知按序补读（停在切段事件之前；stale 回合不补读；只读已到达的通知，不无限等待），`finalizeTps` 的 final `turn/metrics` 先于 `turn/end`；续跑段若在这个窗口打开，先 flush 这次收口。**拆除当场作废这次收口**：`TurnStreamController.dispose`（关会话 / retire）清掉 `closeScheduled` / `pendingOutcome`，settle 之后紧接的拆除不会在宏任务里补发第二帧 `turn/end`；同一窗口里的用户 abort 则丢掉排队结果、就地按 cancelled 收口（`abortActiveSegment`）。强制定稿**恰有两条**受控路径：`session/cancel` 后的 `armCancelFallback`（§4，人已经按过取消）与无活动看门狗（§6.1，agent 自己彻底沉默）。**严禁**再加第三种，尤其不要拿「宿主观察到的空闲」直接收尾——宿主分不清「正在想」与「在忙自己的事」，提前收尾会把答案切在流中间。被并入后台 drain 的回合与派发 detached worker 的回合只**延后收口**（§6.2 / §6.3），不算第三条。
- 一个 turn 由**多个段**组成（逐步切分，[architecture.md §2.2](./architecture.md)）：段的 `finish(stop)` 是步边界不是轮边界；`TurnStreamController`（`src/bridge.ts`）持有跨段的游标 / `seenCalls` / 记账。续跑批次（`isAcpToolContinuation`）**绝不新发 prompt**，用 `transcript.since(cursorSeq)` 补读段间事件；段间事件只记账（`recordAcpToolOutput` 唤醒等待者），游标不动。
- **prompt slot 不等于 `running`，且 `/acp` 与聊天面共用同一个槽位**：`LiveSession.promptInFlight` 是 agent 侧并发闸（配 `settled` 闸门），`running` 只表示这一轮的显示 / 回合仍在进行；聊天面 `claimTurn` 只看前者与 `settled`，不看 `running`。`/acp` 的 `BridgeManager.prompt` 也必须经 `bridge.beginTurn` 占槽，**严禁**绕过槽位直接发 `session/prompt`：/acp 在飞时聊天 `claimTurn` 回 `busy`，聊天在飞时 `/acp` prompt 在 `running` / `promptInFlight` / 未 settle 的活 `session.turnController` 任一成立时回 `turn_in_flight`（已 settle 的控制器只是留给卡片续跑，放行；推进 `turnSeq` 会退休它）。ambient 等待**释放 prompt slot 但保持 `running`**（§6.2），下一条聊天消息照常可进（`/acp` 仍因 `running` 拒绝）；claim 失败（`busy` / `unsettled`）里**只有 `busy` 且属于本会话插话**按下一行走取消重发，其余回 `turn_in_flight`，**不得**回滚首轮锁——锁归正在 stream 的那一轮。
- **宿主插话 = 取消后重发**：宿主把插话（QueueDock Steer）作为**同一条 host turn 的下一步**送达，拒绝会让整条 host turn 失败，而 ACP 不支持向运行中的 prompt 注入消息。`streamPrompt` 只把「同一 DSH 会话的活 `TurnStreamController` 存在、`!stale`、`controller.session === session`」且 `claim.reason === 'busy'` 认作插话（`unsettled` 说明我们这一侧已经释放过槽位——用户按过停止——照旧回 `turn_in_flight`；`/acp` 在飞时没有聊天控制器，同样照旧拒绝），交 `BridgeManager.reclaimChatPrompt`。`controller.hasSettled`（响应已到、`setImmediate` 收口还没释放闸门）时**只等** `settled` 闸门、绝不取消已结束的回合；只有 `!hasSettled && promptInFlight` 才走用户取消同一条管线（`AgentBridge.cancel` + `controller.abortActiveSegment`），闸门靠 `armCancelFallback` / 看门狗解开，**禁止**为此新增定时器。等待中 `options.signal` 中止即回 `aborted`、不发新 prompt；闸门开后会话若已 `closed` / `released`（首轮零产出回滚），重新 `getOrCreateDshSession` 再 `claimTurn`。
- **取消与世代跨段成立**：任何段的 `AbortSignal` → `bridge.cancel` + `abortActiveSegment`；`turnSeq` 世代守卫让旧段迟到的回调动不了新 turn；prompt slot（`settled` 闸门）在 agent 确认取消**之前不解开**——`abortActiveSegment` 不得调 `endTurn`，否则下一个 prompt 会在 ACP 协议禁止的窗口并发发出。
- **两条强制定稿路径语义不同，不得互相复用**：`armCancelFallback` 是「已经要求取消、对方不回应」的兜底；看门狗是「没人要求取消、agent 自己不动了」的兜底。两者都必须按 `session.turnSeq` 做世代守卫（定时器武装时捕获；控制器用它创建时的 `turnSeqAtStart` 判定是否仍是本世代）、都只结束当前 turn 并解开 `settled` 闸门，且都不碰进程。
- **正常结束却零可见产出必须显式报出**：结算时 stop 非 cancelled 且本轮没发过任何可见块（`sawVisibleBlock`：text / reasoning / tool-call 的 block-start，跨段累计；usage 等记账帧不算），必须把告警文本作为 text 块发出。部分 agent 把上游失败（403 / 认证 / 计费）折叠成合法 `end_turn`（实测 pi-acp），否则用户只看到一个空气泡。这是**报告**不是收尾：turn 照常以 stop 结束，不重试不判错。
- **以卡收尾的 turn** 由最后一个续跑段收口：turn 已有可见产出时发一条指针行（「工具已执行、无文字回复」），绝不发空消息——空 assistant 消息不是宿主能诚实渲染的东西。
- 记录在案的边界：codebuddy 首轮会先做内部标题生成（约 5s 无任何通知）才回应 prompt，首轮收尾因此推迟。这是 agent 行为，不是宿主 bug。

### 6.1 无活动看门狗

§6 开头那条「不要拿宿主观察到的空闲直接收尾」排除的是**宿主自己的**空闲计时——它分不清「agent 正在想」与「agent 已经挂了」。但 agent 真挂住时，会话会永远停在 `running`：`settled` 闸门不开，下一条消息发不出去，屏幕上也看不到任何原因。`BridgeManager.reapStalledTurns` 是这条规则的受控例外之一，判据是 **agent 活动**，不是宿主空闲（另两条例外都在 ambient 家族：被并入后台 drain 的回合 §6.2、派发 detached worker 的回合 §6.3）。

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
  - 同一 bridge 上还有别的活跃工作（`AgentBridge.hasOtherActiveWork`：别的会话在跑 turn 或闸门未开、别的会话有待答审批、探测、`pendingCreates`、正在 resume / 启动，以及**别的会话**的在途命令）→ 拒绝本轮（"other conversations are still using it"）。A1 下「同一 bridge」就是**同一 CodeBuddy 会话自己的进程**，别的 CodeBuddy 会话进程不算；非 A1 则是该 agent 的唯一进程。命令按会话记在 `pendingCommands`（Map），所以卡在这条会话上的 mode / config 命令不挡它自己的 reclaim。
  - 同 bridge 另一条会话的控制器仍在 `turnStreams` 里且**未 stale** → 同样拒绝：那条会话已经 settle，`hasOtherActiveWork` 看不见它，但它的宿主可能正在执行卡片（续跑段即将到来），重启进程会把那条活轮次 park 再 resume。已 `closed` / `released` 的残留控制器不算，**别的 bridge（别的 CodeBuddy 会话进程）的也不算**——重启只杀这个 holder 的 `sessionIdsOf` 覆盖的会话。
  - 有 `loadSession` → `releaseAll` 把会话挂起成 `released`，正常获取路径（聊天 `getOrCreateDshSession` / `/acp` `locateOrResume`）经 `session/load` 恢复。
  - 没有 `loadSession` → 还要求同 bridge 上没有别的 live 会话；`AgentBridge.forceReset('agent-stopped')` 杀掉子进程并就地关闭记录、广播 `session/closed`（**不发** `session/close`，也不清 `released`），随后 `forgetDshSession`。聊天下一条消息新建会话；`/acp` prompt 抛 `AcpError('session_reset', … start a new session)`，不是 `unknown_session`。
  - `AgentBridge.closeSession` 的 `session/close` 有 `SESSION_CLOSE_TIMEOUT_MS`（5000ms）上限：卡死的 agent 不能挂住 stop / rollback。
- **旧 turn 只以看门狗那一帧结束（reclaim 之后）**：reclaim 记 `LiveSession.reclaimedTurnSeq`；它关闭连接导致的旧 `session/prompt` 迟到 then / catch 对该世代被丢弃，所以看门狗的 `turn/end` 是唯一的旧轮次结束帧。cancel 兜底**不**记这个标记，它迟到的真 `end_turn` 照常广播（既有测试）。两个 turn 起点（`streamPrompt` / `/acp` `prompt`）与 resume 都会清掉这个标记，只有同一世代才抑制。
- **防御性补丁**：`openSettleGate` 清掉 `settled` / `settledResolve` 并解开闸门，`releaseAll` / `doResumeSession` / `finalizeTurn` 都经它；`releaseAll` 跳过已 `closed` 的会话（§2）并清空 `activeToolCalls`，`doResumeSession` 同样清空 `activeToolCalls`、另清 `orphanPromptTurnSeq` / `reclaimedTurnSeq` 并重置 `lastAgentActivityAt`，避免孤儿标记跨进程存活。

### 6.2 被并入后台 drain 的回合（CodeBuddy unsolicited turn）

CodeBuddy 会自己起「后台 drain」：`session_info_update` 的 `_meta["codebuddy.ai/unsolicitedTurn"] = { requestId, reason: "background_drain" }` 宣告一次客户端从未 prompt 的回合，此后该运行的每条更新都带 `_meta["codebuddy.ai/requestId"]`（`codebuddyMetaOf` 只按形状读取，别的 agent 解析为 `undefined`，既有路径不受影响）。drain 运行期间用户发来的 prompt 会被并进去：`session/prompt` 约十几毫秒就回 `end_turn`，响应 `_meta` 里**没有** `codebuddy.ai/conversationRequestId`，真正的正文随后以 drain 的 requestId 到达。这不是静默空回合——按响应收口就会把答案切掉。同一族里还有「派发 detached worker 的回合」（§6.3）：连 drain 都还没起，prompt 响应就先到了。

- **识别与等待**：响应返回后，若会话有**未过期**的 `ambient`、stopReason 非 `cancelled`、响应无 `conversationRequestId`、且本轮自己还没产出正文或思考（`hasAgentProse`），走 `TurnStreamController.awaitAmbient`：`endTurn()` 释放 agent 侧 prompt slot，但**不 settle**——`running` 保持 true、段不关、不发 `turn/end`。`ambientStaleMs`（默认 300s）内没有活动的 `ambient` 在响应到达时惰性清掉：先按 `retireAmbientId` 把 id 记进 `retiredAmbients`（带时间戳），再清记录与去重集，该响应按普通回合结算——旧 drain id 不会被 `adoptTurnRequestId` 采纳。
- **drain 的结束是它的沉默**：任何 `session/update` 都重置 quiet 时钟（`ambientQuietMs` 默认 10s；实测 drain tick 间隔 1.0–1.4s，低于它会在答案存在前收口），另有 `ambientMaxMs`（默认 120s）硬上限；到点都只经 `closeTurn` 收口一次。硬上限只发一行「其余输出在 ACP transcript 视图」并直接收口（`announceDeferral: false`，不再叠发 deferred 行）；quiet 收口且本轮没有可见正文（text）才发 deferred 说明（`finishAmbient`），而不是零输出告警。首轮 ambient **不滚锁**（drain 的产出仍在 transcript，滚锁会连它一起关掉），锁就此转正。
- **后台工具不开卡**：`SegmentState.ambient`（以及 drain-owned 的 `tool_call`）只 `recordAcpToolOutput` + 进 transcript，**不开 `tool-call` 块**——开了宿主 loop 就会为一个正文还没开始的回合执行工具、提议续跑；ambient 等待中打开的续跑段继承同样的抑制。
- **主平面入口唯一**：等待中的用户回合把 drain 正文折进自己的段；**纯空闲 drain**（没有等待回合）只进 transcript / ACP 视图——主平面的唯一入口是 `adapter.stream`，插件不能凭空 append。
- **request-id 分流**：本轮自己的 `turnRequestId` 与 drain 的 id 不同时，drain 正文不得混进用户回答（`isForeignAmbientText` → 只记录、游标前进、不折段）。响应到达前无从判定的 drain-owned 更新先缓冲（`pendingAmbientUpdates`，200 条 / 64 KiB 上限，超限丢最旧、transcript 仍有全量，但 flush 前先折一行截断标记，不让回合从半句话开始）；steered 时按序 flush 进 ambient 段，普通回合（响应带 `conversationRequestId` → `adoptTurnRequestId`）丢弃。id 未知前 fail-open，不切分——已退役的 drain id 例外（见下条）；但 `awaitingAmbient.requestId` 命中的更新**一律不算 foreign**（当前等待拥有它，复活后的正文必须进回合）。
- **生命周期与通知**：`ambient` 与 `retiredAmbients` 随 close（含 `stop`）/ release / resume / `forceReset` 经 `clearAmbientState` 清除；**本轮 ambient 收口**（`finishAmbient` → `closeTurn` 的 ambient 分支，`AmbientWait.hard` 映射成 `keepAmbient`）分两种：**quiet 收口**先把 drain 的 requestId 记进 `LiveSession.retiredAmbients` 再清 `session.ambient`（沉默只表示我们不再等，不表示 run 已结束）；**hard 上限收口**保留记录并刷新 `lastActivityAt`——上限恰证明 drain 还在跑，下一次被并入的 prompt 仍应识别为 steered，记录交给 `ambientStaleMs`（300s）惰性过期。**retired id 在复活前仍归 drain**：`noteTurnRequestId` 不采纳它，`isForeignAmbientText` 与 `isAmbientOwned`（正文、`sawAgentProse`、工具卡抑制）一律按 ambient-owned 处理——未复活 run 的迟到正文只留在 transcript，不得混进下一回合；**但同一 drain 的任何更新或重公告（`unsolicitedTurn`）到达即 `reviveAmbientId`**：移出列表、重建/刷新 `session.ambient`（活动时钟刷新，`ambientNotices` 不重发），它又活了，下一次被并入的 prompt 按 steered 收到正文。记录是 `{ requestId, retiredAt }` 的有界列表（`RETIRED_AMBIENT_MAX` 32，重复退役移到末尾并刷新时间、超限逐出最旧）；`adoptTurnRequestId` 同样拒绝 retired id。响应到达时已无 ambient、但 `ambientQuietMs * 2`（下限 1s）内退役过（`hasRecentRetiredAmbient`）：不等待、正常收口，零输出告警改用 deferral 文案（“may have been folded into a background run; its output is in the ACP transcript view”，`noteRecentRetiredDrain` / `zeroOutputLine`），不归咎 agent、不提示重发。`ambientNotices` 两种收口都**不清**（同一 run 的重复宣告必须保持静默），只在 `ambientStaleMs` 过期时随记录一起清；去重集有上限 `AMBIENT_NOTICE_MAX`（64），逐出最旧。**正常 settle 与用户 abort 不清**——drain 可以活过被并入的那一轮，提前清会让下一次 steered 等待落空。同一 requestId 只发一次 `agent/notice`（`ambientNotices` 去重）。
- **与约束 23 的关系**：quiet / hard 只收口**已经 `awaitingAmbient`** 的那一轮，不杀进程、不新增通用看门狗；它和 cancel 兜底、无活动看门狗并列，但不是第三种「按宿主空闲计时」的强制定稿。外部收场走同一条 `closeTurn`：cancel 兜底 / 看门狗经 `finalizeTurn` → `forceFinalize`，ambient 等待中的用户 abort 走 `settle({ kind: 'cancelled' })`——都清掉 ambient 时钟与排队中的尾部补读，只发一帧；release / close 由各自的拆除路径收场，不在这一轮补帧。

### 6.3 派发 detached worker 的回合（CodeBuddy multitask）

coordinator 用 `Agent` 工具派发 detached worker、说「已派…」，随后**正常结束自己这轮**（实测：响应在 30s，worker 报告与最终答案在 113–130s 才随后台 drain 到达）。按响应收口，主聊天就只剩「已派…」，答案只存在于 ACP transcript——这正是本状态要修的 bug。它是 §6.2 同一族的受控例外，不是第三种看门狗。**本状态只在聊天面成立**：`/acp` prompt 没有聊天气泡，延后收口影响的只是聊天面的回合。

- **识别**（只看 CodeBuddy 形状，别的 agent 解析为 `undefined`，既有路径不变）：`dispatches: Map<toolCallId, BackgroundDispatch>` 支持**多个并行 dispatch**。新建只认 `tool_call` 的 `_meta["codebuddy.ai/toolName"]` 为 `Agent` / `Task`；**已知 callId 的 completed / failed 一律按 id 认**——真实完成帧**完全没有 `_meta`**，靠 meta 会永远等不到。`detached` 由结构信号置位：同一调用重发时带 `_meta["codebuddy.ai/isBackground"] = true`（同时有 `isSubagent` / `subagentType`），或任何带 `_meta["codebuddy.ai/parentToolCallId"]` 的更新。后者属于 **worker 自己的一轮**：正文与卡片一律不进主平面（`foldInto` 吞掉、`noteTurnRequestId` 不采纳它的 requestId，共享 tool-output 注册表与 transcript 照收），对**所有**回合成立。不匹配英文文案。
- **宿主子代理目录（display-only）**：拿到 detached 证据（`isBackground` 重发或 worker 的 `parentToolCallId`）且 `LiveSession.dshSessionId` 存在时，经 `BridgeManager.setSubagentCatalogReporter` 把 `acp:<toolCallId>` + label 交给宿主；`src/index.ts` 的 `wireSubagentCatalog` 调 `appendExternalSubagentCatalog`，用 `Session.append('subagent/catalog', { version: 2, mode: 'external', … })` 记一条外部执行事实。label 的来源按可靠度排序：`_meta` 的 `codebuddy.ai/subagentType` / `description` / `memberName`（首帧为 repl display 省略 `rawInput`，身份往往只在 result 帧的 `_meta` 里），再是 `rawInput.subagent_type` + `description` / `name`（都没有才用 prompt），最后才是 title。只有 `parentToolCallId` 证据而身份还没到时**先不报**（否则目录里只有一行无意义的「Agent」），等该 call 的身份帧；若到 dispatch 完成仍无身份，才用当时的 label 兜底上报。同一 callId 只记一次。external 条目没有子会话 / activity / timing，宿主 UI 显示为「外部任务」且不可导航，`list_agents` 也省略它；宿主没有 `sessions.append` 或该事件时静默跳过，绝不影响回合。
- **目录行的活跃态（仅内存、仅 ongoing）**：目录事实本身不携带 activity，宿主的 external 行只会画灰点，所以插件另发一条活状态流。`TurnStreamController.broadcastDispatchActivity` 广播 `subagents/update`：目录事实已被接受且该 call 未完成时置 `running: true`（`openDispatchActivity`，紧随 `catalogReported = true`）；该 call 报 completed / failed（`closeDispatchActivity`，早于 `noteDispatchProgress`）、回合收口与 `dispose`（`closeAllDispatchActivity`）、以及桥的拆除路径（`parkSessions` / `closeSession` / `forceReset` 调 `releaseDispatchActivity`）置 `running: false`。从未被目录接受的行不发 false（`activity` 标记挡住）；同一帧既是 detached 信号又是 completed 时**从不点亮**（先置 `completed` 再报告，只会关闭已亮的行）。重连快照是 `session/chat-list` 行上的 `ChatSessionView.activeSubagents`（`activeCatalogChildIds`）。浏览器侧见 [ui.md §4.3](./ui.md)：宿主对 external 行**仍然**没有持久 activity / timing，被点亮的只有内存里的 ongoing 圆点，绿点「已完成」不可达。
- **何时进入**（`streamPrompt` 响应处理，排在 ambient 判定**之前**，且必须在 `adoptTurnRequestId` 之前决定——否则会清掉要折的 drain 缓冲）：`dispatches.size > 0 && some(d => !d.completed || (d.detached && d.sawWorkerUpdate))`、stopReason 非 `cancelled`、会话未 released / closed → 走 `holdForBackgroundDispatch(stopReason, conversationRequestId ?? requestId)`。同步的 `Agent` / `Task` 调用（响应前已完成、无 `isBackground`、无 worker 更新）**不 hold**。`endTurn()` 释放 prompt slot，`running` 与驱动段保持开着，段标 background（hold 期间所有工具不开卡，含 drain 的 TaskOutput）。
- **两段式等待**：worker 段是**滚动静默窗口**，分两档——默认短档 `backgroundTaskMaxMs`（默认 600000）；worker 自己那轮的最后状态是**未闭合 tool call**（`parentToolCallId` 更新里 `tool_call` / `tool_call_update` 未报 completed / failed）时换长档 `backgroundTaskToolMs`（默认 1800000，`0` = 回落短档）——卡在一个长命令里不出 update 的 worker 是活着，不是死了。每条该 dispatch 的更新或 worker 的 `parentToolCallId` 更新都按当前档位把窗口推到 now+窗口，活跃几十分钟的任务不会被总时长截断，只有真静默才收口；另有可选的整段 hold 绝对上限 `backgroundTaskCeilingMs`（默认 `0` = 不限，只用于持续输出但不结束的僵尸）。**只有全部已知 dispatch 都 completed / failed 才转 drain 段**，中途的 `unsolicitedTurn` 宣告只记下 id（进 `acceptedIds`）并继续折正文，不武装 quiet。drain 段用 `ambientQuietMs`（每条更新重置）与 `ambientMaxMs`。hold 保留**一组**可接受的 drain id：响应的 `conversationRequestId ?? requestId` 加上每个宣告的 id；`isForeignAmbientText` 在 hold 期间只放行这一组，其余一律背景噪声（worker 更新永远 foreign）。hold 开始时只采纳**本轮开始后**才宣告的 `session.ambient`（比较 `startedAt` 与控制器构造时刻），宣告 id 与响应 id 不要求相等。**不读 `agentPhase` idle，也不等 `session_end`**：前者在两个阶段之间都会翻 idle，后者被 SDK schema 丢弃、根本到不了插件。
- **响应前的 drain 文本**：响应判为 hold 时不走 `adoptTurnRequestId`，`pendingAmbientUpdates` 里属于 `acceptedIds` 的更新在 hold 拿到驱动段时按序折进去（parked 的等 `startSegment` 接上），其余丢弃（transcript 仍有全量）。
- **收口一次与 id 归属**：`closeTurn({ kind: 'stop', stopReason }, { line, keepAmbient, requestId })`。**deferral 行只看 hold 自己的答案文字计数**（`answerChars`，只计 hold 开始后的 `agent_message_chunk`，父回合的「已派…」不计）——没有 drain 答案文字就发 `finishAmbient` 同一条 deferral 文案，不发零输出告警。quiet 收口 retire **全部** accepted id 并清掉指向它们的 `session.ambient`；硬上限 / parked grace 收口保留**恰好一条**记录（`session.ambient`，没有就用 hold 的主 drain id 新建，`lastActivityAt` 刷新、`sawOutput` 取 `answerChars > 0`），其余 accepted id 全部 retire：任何 accepted id 不得既无主又未退役。首轮锁按 ambient 语义转正、不回滚。
- **parked hold**：响应落在两个 step 之间时 park `pendingBackgroundHold`，等下一个 `startSegment` 接上；`backgroundParkedGraceMs`（默认 30000）内没有 step 才收口。parked 期间**不武装 drain quiet**（grace 自己管），活动更新照记。没有驱动段可写时 deferral 文案改发 `agent/notice`（设置页日志），不塞进没人读的 `pendingProse`。
- **取消与拆除**：hold 中的用户 cancel（`abortActiveSegment`）清时钟、只 settle 一次 `cancelled`、retire 全部 accepted id；`settle` / `forceFinalize` / `dispose`（后继回合、关会话、释放）同样清时钟并 retire，后继回合不会把这条 hold 的 drain / worker 正文折进自己的回答。

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

**宿主退出**（`BridgeManager.shutdownAll` → `AgentBridge.shutdown`）走**释放**语义，与「用户停这个 agent」（`stopAgent` → `stop`：逐会话 `session/close` 后 `released.clear()`，即销毁）不是一回事：`parkSessions` 把 live 会话标成 released（保留记录、广播 `session/released` + `cause: 'shutdown'`、**不**发 `session/closed`），落盘后子进程才死，重启后照常 `session/load`（约束 10）。跳过 per-session RPC 也是预算的第一层收敛：N 个会话不再串行 N × `SESSION_CLOSE_TIMEOUT_MS`；bridge 并发，`shutdown(SHUTDOWN_BUDGET_MS = 4s)` 是**整条预算**（含升级尾巴）：首个等待最多 `4s − 500ms`，升级后只等剩余时间，`killChildAndWait` 到点必 resolve。`shutdownAll` 用 `Promise.allSettled`（一个 bridge 失败不影响其余、不向 disposer 抛），且**不**在结束后清 `dshSessionMap`——迟到的 `persistAgents` 会把它写成 `chatSessions: []`，正好抹掉刚存下的记录。

- **杀是真等到的**：`disposeChild` 先 `stdin.end()` + 平台 kill（win32 `taskkill /t /f`、POSIX 组 `SIGTERM`），等 `exit` / `close` 到「预算 − `KILL_ESCALATION_GRACE_MS`」；POSIX 再发组 `SIGKILL`、win32 再发一次 `taskkill`，只再等到同一个 deadline（那 500ms 是被**预留**的一段，不是额外加时）。非停机路径（空闲释放 / 崩溃 / `forceReset` / 启动失败）仍走 fire-and-forget 的 `killChild()`，其整条预算为 `KILL_ESCALATION_DELAY_MS = 3s`——CRASH ≠ DESTROY（约束 10）。
- **启动竞速**：`AgentBridge.teardownEpoch` 只由**主动** teardown（`stop` / `shutdown` / `forceReset`）递增；`spawnAndConnect` 在每次 await 后（`ensureAgentExecutable` 之后、`initialize` 之后）校验，过期就把刚 spawn 的子进程用可等待的 kill 收掉、清掉 `conn`，不翻 `ready`。`killChild` / `releaseAll` **不**递增——它们也是启动自身失败的路径（`withStartupTimeout`、子进程在握手期间死掉会经 `connectionLost` → `releaseAll('died')`），那次失败必须照常发 `state: error` + `stderrTail`（设置页失败卡片靠这对字段展开）；`ensureReady` 的成功分支另行校验 `state === 'starting'`，因此崩溃释放之后迟到的握手结果也翻不回 `ready`。
- **进程级兜底**：模块级 `process.once('exit')` + live pid 集合（spawn 加入，`exit` / `close` 移除），处理器里同步 `SIGKILL` / `spawnSync taskkill`。只覆盖「宿主还能跑 `exit` 的退出」；**不注册 `SIGINT` / `SIGTERM`**（会改宿主自身的信号处置、可能重复处理宿主停机），也不做 job object / PID 文件——**宿主被 SIGKILL 或断电仍可能留下孤儿进程，这是明确的非目标**。

## 8. 数据保真

用户要求：ACP agent 发什么就兜住什么。截断与占位的损失不是「少看几行」，而是 agent 说了、我们当作它没说。

- **通知层**：`session/update` 的每一种 kind 都必须有去处。
  - `agent_message_chunk` → `text`；`agent_thought_chunk` → `reasoning`；`tool_call` / `tool_call_update` → 真正的 `tool-call` 块（快照 + 前缀扩展 delta，重述按 callId 折进已开的卡）。
  - 其余 kind 在原生聊天流落成一行 `describeUnhandledUpdate` 文本（每种类一行、文本变了才重发）。**严禁** `default: 丢弃`。
  - 两张例外表分工不同：原生流对 `BOOKKEEPING_UPDATES`（`current_mode_update` / `config_option_update` / `available_commands_update` / `session_info_update` / `usage_update`）一个字都不发；ACP 视图只对 `STATE_ONLY_UPDATES`（`config_option_update` / `usage_update` / `session_info_update`）不落 block，其余（含 `current_mode_update` / `available_commands_update` / `plan`）落成带 `raw` 原文的 `event` block。
  - **`usage_update` 是上下文占用，不是请求 token**：`used` / `size` 只写 `session.usage`（ACP 视图与 composer 占用环的 `used/size`）。宿主 `session/chat-list` 的会话行也带 `usage`；浏览器在同一批 `session/update` 折叠里把它落到 `chatSessions` 与被观察 transcript，**严禁**只更新其中一处。原生聊天流的 `usage` 块是插件按段生成的**输出估算**——正文 + 思考的 UTF-16 单元数 ÷ 4，`inputTokens` 恒 `0`（issue #6）。**严禁**把 `size` / `used` 映射成 input/output：那会造出「17 步 × 1M」的总量和失真的 tok/s。`inputTokens: 0` 让宿主的缓存命中率自然不显示，而不是显示假 `0%`。工具参数不计入估算——部分 agent 每次重报整段 `rawInput`，会把瞬时字符记成输出。
  - **burst tok/s 是插件独立读数**：`src/tps.ts` · `TurnTpsTracker` 只累计非空 `agent_message_chunk` / `agent_thought_chunk` 的字符（÷4 估 token），分母只算相邻 prose 间隔 ≤1s 的 burst；`tool_call` / `tool_call_update`、`permission/request` / `permission/expired` 与 turn 边界强制断开。`TurnStreamController` 用独立 `tpsSeq` 只在 live 路径喂 tracker（`startSegment` replay 不喂，避免续跑重复计数），运行中每 ≥1s 广播 `turn/metrics`（`final: false`），settle 时先经 `noteSessionBurst` 把 measurable 部分并入 `session.burst` 并落盘，再广播 `final: true`，之后才是 `turn/end`。`session.burst`（`SessionBurst`）随 `chatSessions` 持久化并由 `session/chat-list` 下发；浏览器 `burstStats` 按 ACP session 键。无 `dshSessionId` 的 `/acp` 会话不统计。**严禁**把该值写回宿主 `usage` 或作为第二处 tok/s 显示。→ [ui.md §4.2](./ui.md)
- **形状层**：块的 `content` 可以是字符串、对象或数组；`rawInput` / `arguments` 可以是字符串、对象或**数组**。这些都算「有值」，空字符串 / `null` / 空数组才算「没有」。**严禁**用 `content?.type === 'text'` 一类窄判定把别的形状读成空。
- **字段层**：ACP 视图的工具卡把 `kind` / `status` / `locations` / `terminalId` / `meta` 进 `details`，整个通知原文进 `raw`（`dumpJson`，只在 `ACP_TOOL_RAW_MAX` 截断且带标记）。`available_commands` 条目整条保留（`...c` 展开）。
- **diff**：同时保留结构化 diff（ACP 视图 `DiffView`）与文本（路径 + `-`/`+` 行，`formatAcpDiff`）。**严禁**退回 `[diff path]` 占位；未知 content kind 保留整条 JSON（`acpContentRows` 的 `other`）。这份文本也是虚拟工具答给宿主执行记录的输出，不能是占位符。**公告帧记下的空输出不是答案**：agent 先公告 `tool_call`（无 content）、后重述带输出，所以 `recordAcpToolOutput` 的空记录只在 agent 报了终态 status（`isFinalToolCallStatus`：非 `pending` / `in_progress`）时才算完成，`waitForToolOutput` 也只在那时或真有输出时解除等待——否则卡片永远拿占位符（issue #10）。
- **预算**：`ACP_TOOL_RAW_MAX` / `RAW_MAX`（256,000 字符）、`transcriptMaxEntries`（默认 600）、浏览器 `MAX_BLOCKS`（400）是有界容器，不是丢数据的理由；超限必须留截断标记，回合内暂存的后台更新缓冲（`pendingAmbientUpdates`，§6.2）被顶掉时也同样先折一行截断标记再 flush。**Transcript 自身只合并连续同类纯状态 tick**（`usage_update`、无 title 的 `session_info_update`、`config_option_update`）：就地替换末条，seq 前进、数组不增长、保留最新值；内容类一条不丢，`since()` 的 seq 空洞是允许的，实时 SSE 仍逐帧广播。**严禁**给 stderr 行、npm 安装输出这类诊断文本加「取前 N 字符」——那正是激活失败时唯一有用的一行。
- **通知身份**：没有卡片的种类（plan / mode / 未来新增）在原生流里每种类只发一行，文本变了才重发（`announcedKinds`）；ACP 视图按 kind 折叠（`store.ts` · `foldUpdate` 对 `plan` 就地更新）。

## 代码索引

| 主题 | 位置 |
|---|---|
| 桥与进程 | `src/bridge.ts` · `spawnAndConnect` / `teardownEpoch` / `killChild` / `killChildAndWait` / `disposeChild` / `killProcessTree` / `reapLiveChildren` / `windowsShimLaunch`；宿主退出 `BridgeManager.shutdownAll` / `AgentBridge.shutdown` / `parkSessions` |
| 恢复 | `src/bridge.ts` · `connectionLost` / `releaseAll` / `resumeSession` / `locateOrResume` |
| 超时与取消 | `src/bridge.ts` · `withStartupTimeout` / `armCancelFallback` / `runPrompt` |
| 卡死收口 | `src/bridge.ts` · `BridgeManager.reapStalledTurns` / `prepareStalledSession`；`LiveSession.turnController` / `activeToolCalls` / `orphanPromptTurnSeq` / `reclaimedTurnSeq`；`TurnStreamController.stale` / `hasOpenSegment` / `settle`（`INACTIVITY_TIMEOUT`）；`AgentBridge.finalizeTurn` / `forceReset`（§6.1） |
| 后台 drain | `src/bridge.ts` · `AgentBridge.handleSessionUpdate` / `codebuddyMetaOf` / `LiveSession.ambient` / `ambientNotices` / `retiredAmbients` / `retireAmbientId` / `isRetiredAmbientId` / `clearAmbientState`；`TurnStreamController.awaitAmbient` / `finishAmbient` / `closeTurn` / `adoptTurnRequestId` / `isForeignAmbientText` / `isAmbientOwned` / `pendingAmbientUpdates`；`BridgeManager.ambientTuning`（§6.2） |
| detached worker | `src/bridge.ts` · `codebuddyMetaOf`（`toolName` / `parentToolCallId` / `isBackground`）/ `CodebuddyMeta`；`TurnStreamController.dispatches` / `dispatchedDetachedWorker` / `holdForBackgroundDispatch` / `pendingBackgroundHold` / `startBackgroundDrain` / `closeBackgroundHold` / `trackBackgroundDispatch` / `trackWorkerToolCall` / `workerToolCalls` / `backgroundSilenceMs` / `flushBackgroundHoldUpdates` / `releaseBackgroundHoldIds` / `backgroundDeferralLine`；`BridgeManager.backgroundTuning`；`BridgeTuning.backgroundTaskMaxMs` / `backgroundTaskToolMs` / `backgroundTaskCeilingMs` / `backgroundParkedGraceMs`（§6.3） |
| 回合收口 | `src/bridge.ts` · `TurnStreamController.settle` / `flushScheduledClose` / `drainTail` / `closeTurn` / `finalizeTps` / `dispose` / `abortActiveSegment`（§6） |
| 空闲 | `src/bridge.ts` · `releaseIfIdle` / `armIdleRelease` / `touch` / `currentIdleTimeoutMs` / `everHostedSession` |
| 收尾与分段 | `src/bridge.ts` · `streamPrompt` / `TurnStreamController` / `sawVisibleBlock` / `isAcpToolContinuation`（分段续读与收尾见 [architecture.md §2.2](./architecture.md)）；限流拒绝 `agentRefusalDetail` / `rateLimitedTurnError` / `LiveSession.quotaRefusal` / `zeroOutputLine`（§1） |
| 数据折叠 | `src/impl.ts` · `acpContentRows` / `formatAcpDiff` / `dumpJson` / `describeUnhandledUpdate` / `acpToolCallFromUpdate` / `acpToolCallDelta` / `Transcript` / `coalescibleStateKind` |
| tok/s 聚合 | `src/tps.ts` · `TurnTpsTracker`；`src/bridge.ts` · `TurnStreamController.trackTps` / `finalizeTps` / `BridgeManager.noteSessionBurst`；`src/protocol.ts` · `turn/metrics` / `SessionBurst`；`src/client/activity-pill.tsx` · `createActivityPillClaim` |
| 启动命令 | `src/impl.ts` · `validateAgentDef` / `splitCommandLine`；`src/bridge.ts` · `quoteLegacyCommand` |
| MCP 下发 | `src/bridge.ts` · `toAcpMcpServers`（线格式转换）；`src/impl.ts` · `validateMcpServers`（配置校验）；面板三处同步见 `src/client/panel.tsx` · `initialForm` / `buildPayload` / `payloadEquals` |
| 会话分叉 | `src/bridge.ts` · `AgentBridge.forkSession` / `BridgeManager.adoptForkedSession` / `pendingForks` / `noteForkCapability` / `canForkNow` / `forkCaps`；`src/impl.ts` · `dispatchRpc`（`session/chat-fork-adopt` 分支）；`src/client/store.ts` · `forkChatSession` / `forkStateOf` |
