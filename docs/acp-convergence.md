# ACP 收敛方向：只借显示层

本文件是 **AGENTS.md「本插件是什么」** 那节的工程展开，也是代码收敛的唯一权威依据。
代码与它不一致时，以它为准；改完它要同步改 AGENTS.md / README.md / docs/acp-mode.md。

> 引用代码位置一律用「文件 + 符号名」，不用行号。

---

## 0. 一句话

**DSH 只出显示层（会话身份 / 消息列表 / 输入框 / 侧栏），ACP agent 在它自己的进程里完全自治，插件经 ACP 协议驱动它，把它的文字与思考翻译进 DSH 的会话日志，于是主聊天平面原生渲染。** 插件不写 DSH 的模型路由、不替 agent 裁决权限，也不让 ACP 会话里出现一个点了会写全局默认模型的原生模型选择器（§2.4）。

---

## 1. 三个已证实的宿主事实

这三条是从桌面 asar 源码读出来的，不是推测。它们共同决定收敛后的形状。

### 1.1 发消息与写路由是两条独立路径（关键）

`SessionCommandController.selectModel()` 是**唯一**调用 `requireModel()` 的地方：

```
requireModel()  ← 唯一调用者 selectModel()   （asar 内两处定义、两处调用，全在 selectModel 里）
```

`selectModel` 内部做三件事，而这三件事**全部只属于「写路由」**：

1. `await this.requireModel(request)` — 目录门禁，`session/model-unavailable` 死在这里
2. `ctx.llm.resolveCallConfig(...)`
3. `ctx.agentDefaultModel.saveSelection(selected)` — 污染全局默认

而**发消息**走的是 `agents.selectForNextRequest(agent, selection)`：它把选择写进
`selectionFor(agent).current`（进程内 getter），prompt 组装时直接读。`session.append("model/selection", …)`
只是留痕，不参与准入。

> asar 自述（原文）：「Prompt admission retains the saved route **without a catalog availability gate**，
> so request execution reports missing credentials or unavailable models.」

**结论：ACP 会话从来不需要走 `selectModel`。** 这正是本轮 `session/model-unavailable` 的根因——
问题不在"目录门禁太严"，而在"我们根本没有必要去敲那道门"。

### 1.2 主聊天平面是节点注册表，不是扁平词表

主平面由 `UiConversation.events`（`ConversationEventRegistry`）驱动，每类内容一个
`ConversationNodeDefinition`：

| kind | 消费事件 | 渲染 |
|---|---|---|
| `assistant-step` | `step/start` + `assistant/live-chunk` + `assistant/message` | 文字 / 思考 |
| `tool-call` | `tool/call` + `tool/result` | 工具卡 |
| `command` | `command/run` + `command/done` | 命令卡 |

渲染器走 `conversation.chat.node` **keyed slot**（key = `ChatNodeKind`），
官方 chat 包用 `declare module` 往 `ChatNodeDataMap` 里 merge 新 kind
（见 `node_modules/@deepseek-ai/dsh-client-ui-chat/.../conversation-nodes/tool.d.ts`）。

`AssistantBlock` 的联合本身就含 `tool-call` 与 `other`。**所以主平面在结构上完全装得下工具卡。**

### 1.3 但插件不能直接 append 会话事件

我查了 asar 里全部 `session.append(...)` 调用点（L285816 起那一带，以及 L288745 / L326306 / L729181 …）：
**没有一处对插件暴露。** append 的能力都在 driver、compaction、session-controller 内部。

宿主给插件的实况通道是 **`agent/assistant-stream`**（Cordis 事件，`ctx.on` 可监听，
签名见 asar L1018266）：driver 在 `preparedCall.stream(request)` 吐出每个 chunk 时
`this.dispatch.emit("agent/assistant-stream", { frame })`。
`SessionHistoryController` 正是靠它把实时帧折成 `assistant/live-chunk`。

**结论：进主平面的唯一路径仍是 LLM adapter。** 由 host 调 `adapter.stream()`，
host 自己把返回的 `StreamChunk` 折成 `assistant/live-chunk` / `assistant/message`
并 append 进日志。这不是设计偏好，是结构唯一。

### 1.4 ACP agent 的工具卡进主平面 —— 真正的接缝在 StreamChunk

**原方案（作废）**：本想让插件注册一个自定义 `ConversationNodeDefinition` 把 ACP
`session/update` 折成 `tool/call` 节点。作废原因有两条，都是查证后发现的：

1. **宿主要求 "Do not append session events with a new `type`"**（宿主插件规范的
   Stability 段原文）。未知事件只有 envelope 带 `ignorable: true` 才会被读者接受，
   而 live `Session.append()` 设不了这个标记，会话会拒绝重开。所以**不能发明
   `acp/tool-call` 事件**。
2. **`session.append("tool/call")` 整个 asar 只有一处**（在 host driver 的
   tool-call scheduler 里，`appendToolCall`），插件没有第二个入口。

**真正的接缝**：宿主**已经**完整支持工具卡，只是我们的 adapter 没用。证据链：

- `StreamChunk` 字典里有 `block-start`（`blockType: 'tool-call' | 'tool-result'`）、
  `tool-call-delta`（`{ id, name?, argumentsDelta }`）、`block-end`
- `AssistantStreamAccumulator` 消费 `tool-call-delta` 时构造的正是
  `{ kind: "tool-call", callId, name, argsRaw }` —— `AssistantBlock` 的 `tool-call` kind
- `AssistantBlock` 联合含 `tool-call`；`ui-model-selection`/`ChatNodeDataMap` 里
  `tool-call: ToolChatData` 已由官方 chat 包注册渲染器

也就是说：**只要 adapter 发真正的 tool-call chunk，宿主 driver 自己会把它折成
`tool/call` 日志事件，浏览器里那个已注册的 tool-call 渲染器就会画卡片。**
不需要写新的 `ConversationNodeDefinition`，不需要写日志，不需要注册新 slot。

**当前代码的错误**：`BridgeManager.streamPrompt` 的 `session/update` 订阅里，
ACP 的 `tool_call` 被 `switchToBlock('reasoning')` 降级成
`> 🛠️ [Tool: <title>]` 的 reasoning 散文行。`tool_call_update` 同样被压成 `> …` 行。
`StreamChunk` 里那两个 kind 完全没用上。

**要做的事**：把 `tool_call` / `tool_call_update` 分支改成发 tool-call block 序列——
`block-start`（`tool-call`）→ `tool-call-delta` → `block-end`。
`callId` 用 ACP 的 `toolCallId`，`name` 用 ACP 的 `title`（或工具名），
`argumentsDelta` 用 agent 给的内容。参数型 ACP agent 若给结构化 input/arguments，
就作为 `argumentsDelta` 送。

**注意**：`block-end` 的 `block` 会经 `toAssistantBlock` **替换**整个 block，
所以最后一个 `block-end` 必须带完整内容（accumulator 的 `block-end` 分支是覆盖不是合并）。

### 1.5 展示卡的隐性代价：宿主 loop 会续跑，原话会被重发（oml「你好」会话事故，2026-10-11）

§1.4 的方案落地后，oml 项目的「你好」会话暴露了它没算到的代价。用户报告
「ACP agent 侧不断地反复接收到我发出去的话」。会话日志（`session-afd36498`，
turn 2 跑了 4 个 step）给出完整链条：

1. agent（codebuddy）在回答里发 `tool_call` / `tool_call_update`，adapter 按本节
   方案折成真正的 `tool-call` block；
2. 宿主 agent-loop 的续跑判定**只看** settled assistant message 里有没有
   `tool-call` block（`dsh-agent-loop` `step()`：`content.filter(block => block.type
   === "tool-call")`，空则 `completed`，非空则 `executeToolCalls` → 返回 null →
   下一步）。没有任何 finish-reason 闸门，BlockAssembler 的词表也只有
   `text` / `reasoning` / `tool-call` 三种，**没有「只展示」的块形态**；
3. preset 没挂工具 → 每张卡执行即 `unknown tool`（`ToolNotFoundError`），
   错误 result 记入日志 → loop 续跑；
4. 下一步的批次只有 staged tool results（`source.kind: 'tool'`），而
   `selectForwardPrompt` 扫的是**整个请求消息列表**里最后一条 user-kind 消息——
   历史里的原话永远在 → **原话重发给 agent** → agent 再发工具卡 → 循环，直到
   用户中止。

宿主仍会执行卡片并记录 `unknown tool` 错误 result（卡片渲染依赖宿主的
`tool/call` 执行记录，插件没有 append 通道，§1.3），这个噪音掐不掉；但续跑必须掐断。
修复是 guard 的第三职责（`agent/pre-step`）：**strip 之后仍有内容、却没有任何
用户来源的批次一律 `reject`**（turn 以 blocked 收尾；strip 后为空的注入轮保持
原 completed 空转；无 source 的消息算用户输入，与 bridge 取词约定一致）。

同一次事故还暴露了 delta 语义错位：ACP 的 `tool_call_update` **整包重述**
`rawInput`，而宿主 accumulator 对 `argumentsDelta` 是**拼接**
（`previous.args.push(...)`，组装时 `args.join("")`）——把快照当增量，
卡片参数长成 `{"cmd":""}{"cmd":"cd /m/Coding/oml && git"}…` 碎片，Read 卡甚至把
整个文件内容吞进参数。修复（`acpToolCallDelta`）：只对**真字符串前缀扩展**发
后缀 delta；替换类更新只移动快照，由 `block-end` 整块替换纠正；
输入（`rawInput`/`arguments`）优先于 `content`（content 是工具输出）。
另外相邻两个工具调用必须各开一个 block——`switchToBlock` 的类型相等早退会把
第二张卡折进第一张（日志里三张卡的参数互相串味即此），`openToolCallBlock` 按
callId 显式断块；同 callId 重发的 `tool_call` 按更新折叠。

---

## 2. 目标形态

### 2.1 底座在 `conversation.input.model`

```
conversation.input.left
└── acp-mode        (order 20)  agent 自己的 mode（session/set_mode）

conversation.input.model   ← ACP 底座（ACP 模式下由闸门动态安装）
                            第一级：选 agent；其下多级菜单接 模型 / 思考等级
```

底座占的是**原生模型底座那个座位**——composer bar 行尾（`.trailing`，`margin-left: auto`）、
提交键左边那一个 cell。理由有两条，且指向同一个位置：

1. **位置**：用户报告「ACP 底座应该在原来底座的位置」。原生底座就在行尾，不在工具行左侧。
2. **隔离**：那个 cell 的 occupant 是宿主的 `ModelSelect`，它列 DSH 全量 provider，
   点一下写全局默认模型（§2.4）。ACP 会话里它必须在的正是这里。

于是「占位」和「接管」合成一件事：一个 cell、一个 occupant。底座的注册由 ACP-mode 闸门
（`src/client/index.tsx` 的 `syncAcpMode`）驱动——只在舞台会话跑 ACP preset 时创建 claim，
切走即 `release()`，**非 ACP 会话里这条 entry 根本不存在**，而不是「存在但渲染空」。
这就是隔离：不是组件自隐，是条目不注册。

> 权限档不在菜单里：agent 报什么就问什么（§2.3），没有"档"可切。约束 18 里
> 描述的 `boundarySection`（DSH Access mode 档位）已随那条轴一起删除。

### 2.2 prompt 触发：插件自己的会话映射

ACP 会话的 prompt **不经过 DSH selection**。**但进日志的唯一路径仍是 LLM adapter（§1.3）——
即 prompt 仍由宿主 driver 调 `adapter.stream()`，本节说的"不经过 selection"指的是：插件不写
selection，而 driver 每轮解析的路由（`selectionFor(agent).current`：pending selection →
上一条请求 header → 部署默认）必须被插件接到绑定上。** 2026-10-14 的实机缺陷是这一环缺失：
`session/chat-bind` 只写了 `chatAgentIntent` 而无人消费，于是从未跑过 ACP 轮次的会话发到部署
默认 provider（adapter 根本不被调用）、已跑过的永远回放旧 agent——用户看到的就是「agent 选择器
点击无效」。现行机制（两层）：

1. **guard 的 `agent/request` waterfall 改写**（`presets/acp/acp-guard.mjs`，`{ prepend: true }`）：
   driver 解析出请求配置后，guard 把它改写成绑定指向的 `acp/<agent>`（无绑定的会话回落插件默认
   agent；改写丢掉继承 effort）。注册必须 prepend——`installModelSelection` 的改写（fresh 会话
   回放部署默认）先注册，waterfall 外层后执行且其返回值才生效，只有最外层能让绑定赢。binding 经
   `globalThis[Symbol.for('dsh-ntr.acp-binding')]` 跨模块实例共享（guard 是 Loader 加载的独立
   实例）；`dsh-ntr` 在 bind / model-set / 会话物化 / 默认 agent / 删除 agent 五处写入。
2. **adapter 自己的复查**（`BridgeManager.streamPrompt`）：driver 仍带来旧 agent id 时（旧
   header 回放、guard 未挂载的降级态），绑定 model 串优先。材料化的默认 effort 不算用户选择，
   不回写（否则座位刚选的思考等级被 catalog 缓存的陈旧默认静默改回）。

**不写任何 `provider: 'acp'` 路由**（无 `selectModel`、无 `saveSelection`、无全局默认污染）；
路由的"写"只发生在 driver 每轮的请求配置上，由 guard 改写、随请求 header 留痕。于是：
- 没有 `selectModel` → 没有 `model-unavailable`
- 没有 `saveSelection` → 全局默认模型不被污染 → `AcpDefaultModelGuard` 无事可做
- agent 之间切换 = 改绑定 → 下一条消息生效（`getOrCreateDshSession` 按 `dsh:agentId` 分会话，
  上下文各自保留）

### 2.3 permission 原样映射

`session/request_permission` 到达时，宿主**不裁决**：把 ACP 的
`options` / `toolCall` 详情 / allow-deny 原样送到界面，用户点什么就回什么给 agent。
宿主不再有 `decidePermission` / `authorizeWrite` 这一层。

### 2.4 原生模型座位：遮蔽是显示层要求，与路由无关

**这一节是补记**。批次 2 退役遮蔽机制时，文档写的是「原生座位**不再由本插件注册**」——
这句话字面成立（我们确实不再注册 occupant），但它只描述了**我们停止做的事**，没有回答
**用户还会看到什么**。结果是遮蔽删掉之后，原生 `ModelSelect` 原样回来了。

从桌面 asar 读到的宿主注册表原文（`packages/client/ui-conversation/src/client/contract/slots.ts`）：

```
key:          "conversation.input.model"
kind:         "single"      scope: "session"
declaredBy:   an entry in 'conversation.composer.bar' (client-ui-conversation)
occupants:    ["client-ui-model-selection ModelSelect"]
replaceRisk:  "shadows-shipped-ui"
```

关键事实：

1. ** occupant 是宿主的，从来不是我们的。** `client-ui-model-selection` 经
   `ctx.inject(['slots','modelDirectories'], …)` 注册 `ModelSelect`，读 DSH 模型目录、
   经 `session.selectModel` 提交。我们从来没拥有过这个 cell，只是曾经用 `priority: -1` 压住它。
2. **宿主 composer bar 无条件渲染它**：`renderSlot("conversation.input.model", { locked: modelSeatLocked })`，
   `modelSeatLocked = removed || inert || !live`——与是不是 ACP 会话无关。
3. **`ModelSelect` 以默认 priority（0）注册**，而 `single` cell 渲染 priority 最低的活跃条目。
   所以任何负 priority 的 occupant 都赢得这个 cell。

于是 ACP 会话里那个座位是**双重错位**：它列的是 DSH 全量 provider（与 `agent/catalog` 无关，
在上面选什么都不会影响对端 agent），而且**它点得动**——点了就写
`agentDefaultModel.saveSelection()`，污染全局默认模型，正是 §2.2 判定「不存在了」的那个问题。

**收敛消除的是「ACP 会话*必须*写路由才能发消息」，没有消除「UI 上还有一个能写路由的入口」。**

**做法（2026-10-07 修正，2026-10-14 再修正）**：`src/client/model-seat.tsx` 的 claim 依然按
`stagedIsAcpMode` 条件注册，但**「渲染空白」不是全部机制——它还得赢下这个 cell**，
而第一版对「怎么赢」的假设是错的。第二次修正把它从「遮蔽」改成「接管」：
闸门往这个 cell 里装的不是渲染 `null` 的 shadow，而是 **ACP 底座本身**
（`createModelSeatClaim({ slots, occupant: () => AcpSessionControls })`）。

**实测事实（桌面 0.1.7-rc.x）**：非 chain 槽位的注册优先级由**客户端 runner 改写**，我们声明多少都不算数。
`@deepseek-ai/dsh-cordis-client-runner` 的 `guardedSlots`：

```
const spec = slots.spec(slot);
let priority = options.priority;
if (spec === undefined || spec.kind !== "chain") {
  priority = env.allocatePriority();   // allocatePriority: () => --this.nextPriority
  options.priority = priority;
}
```

即：**每个动态包的每次注册都拿一个页面级递减的 rank，最后一个注册者赢**（`single` cell 渲染最低 rank）。
于是 `priority: -1` 既不保护我们，也不保护对手——第三方座位插件
`@hytime/dsh-thinking-effort` 0.3.7 正把它的模型/思考强度 slider 注册进**同一个 cell**
（它声明 `priority: -10`，同样被改写），又因为它在 bundle 顺序里排在我们之后，
**它赢**。用户看到的就是「ACP 模式下底座没有换掉」。

**改了什么**：`createModelSeatClaim`（`src/client/model-seat.tsx`）把 cell 当成**要核实的占位**：
① 注册一个 occupant（ACP 底座）；② 用渲染器自己的 winner 视图 `entriesOfSlot`（renderer 的
outlet 读的就是它）核对这个 cell 的 head 是不是我们自己的组件身份；③ 不是就**再注册一次**
（新的注册 = 新的最低 rank = 赢），最多 `MAX_SEAT_CLAIMS` 次，到顶就如实报「被谁占着、放弃」。
触发来自两条：gate 的每次评估，以及 `ctx.on('slots/changed', …)`（只认
`conversation.input.model` 这个 key）——所以在 ACP 会话里被抢走即被夺回，证据驱动，不轮询。
`spec()` 用来区分「composer bar 还没挂」与「cell 被别人占着」：`inject` 对未声明的 slot 是**静默等待**，
不区分这两种情况就会对着一个还没挂的座位空转。

**仍然没有带回来的东西**：`onEntryError` abdicate 恢复、`seatBroken`（会话内不再重试）、
退注册后重注册的 rank 压栈。旧 `ensureSeatWins` 的 undercut 算术也没有回来——它**本来就没在起作用**
（rank 被改写），起作用的是「发现不是自己就再注册一次」，这一条以有界、可报告的形式保留。
注册经 `ctx.slots.inject('conversation.input.model', …)` 而不是裸 `register`：
`register` 对未声明的 slot 会 throw，而这个 gate 跑在每次 store 变更上，远早于也远晚于
宿主 composer bar 的加载。`inject` 返回的 disposer 同时覆盖「等待」与「注册」，
声明坍缩（composer bar 卸载）时自动释放并在重新声明时重新注册——遮蔽会自愈。

---

## 3. 退役清单（按批次）

### 批次 1：路由轴（error axis 的核心）

| 符号 | 位置 | 处置 |
|---|---|---|
| `AcpDefaultModelGuard` | `src/impl.ts` | 删 |
| `reconcileDefaultModel` / `DefaultModelReconcileOutcome` | `src/impl.ts` / `src/bridge.ts` | 删 |
| `lastNativeRoute` / `RouteBearingSessionLike` | `src/impl.ts` | 删 |
| `wireDefaultModelGuard` | `src/index.ts` | 删 |
| `settleAcpRoute` / `watchRoute` / `routeAttempts` / `routeSettled` / `MAX_ROUTE_ATTEMPTS` | `src/client/index.tsx` | 删 |
| `acpRouteTarget` / `selectAcpRoute` / `AcpRouteSelection` | `src/client/acp-ui.tsx` | 删 |
| `noteRouteNotice` / `UiState.routeNotices` | `src/client/store.ts` | 删 |
| `model/reconcile-default` | `src/impl.ts` dispatchRpc | 删 |
| `store.reconcileDefaultModel` | `src/client/store.ts` | 删 |
| `routeNotice` 横幅 | `src/client/acp-view.tsx` | 删 |

**验证**：删完后 `grep -r "AcpDefaultModelGuard\|settleAcpRoute\|selectAcpRoute" src/ tests/` 应为空。

### 批次 2：座位遮蔽

| 符号 | 位置 | 处置 |
|---|---|---|
| `syncModelSeat` / `dropSeat` / `ensureSeatWins` / `seatIsOurs` / `seatBroken` / `seatRegistered` | `src/client/index.tsx` | 删 |
| `onEntryError` 处理器 | `src/client/index.tsx` | 删（保留 console.warn 会删掉整段） |
| `AcpModelSeat` / `AcpSeatProps` | `src/client/session-controls.tsx` | 删 |
| `shouldShadowModelSeat` / `setAcpSeatActive` / `useAcpSeatActive` | `src/client/acp-ui.tsx` | 删 |
| `menuFor('seat')` 分支 | `src/client/session-controls.tsx` | 删 |
| `seatOwns` 逻辑 | `src/client/session-controls.tsx` | 删 |

**保留**：`stagedSessionOf` / `rowAgentPreset` / `ACP_PRESET_ID` / `acpModeFromPresetEvent`
——底座要用它们判定「当前会话是不是 ACP 会话」。

**⚠️ 本批删过头了，后已补回**（见 §2.4）。遮蔽的**存在理由**随路由轴一起消失，这一点没错；
但遮蔽同时是这个 cell 上**唯一**能挡住「原生 `ModelSelect` 点一下就写全局默认模型」的手段，
删掉它并没有消掉那个伤害，只是消掉了防护。承接实现是 `src/client/model-seat.tsx`
的 `createModelSeatClaim`——只保留「`stagedIsAcpMode` 条件 + `entriesOfSlot` 核实 + 有界重取」，而 occupant 是 ACP 底座本体（见 §2.1 的第二次修正），
旧机制那套 winner 竞争 / abdicate 恢复全部不带回来。教训：
**退役一条链时要区分「这根轴的要求」和「这根轴顺带提供的防护」。**

### 批次 3：RPC 与状态清理

| 符号 | 位置 | 处置 |
|---|---|---|
| `model/get-default` / `model/set-default` / `model/reconcile-default` | `src/impl.ts` dispatchRpc | **删掉**，换成 `default/agent` / `default/agent-set` |
| `store.setDefaultAgent` | `src/client/store.ts` | 改调新端点，payload 从 `{agentId}` 改为可省略 |
| `resync()` 里的默认解析 | `src/client/store.ts` | 从 `provider === 'acp'` 解包改为直接取 `agentId` |

**新增的三个绑定 RPC**（这是「插件自己的会话映射」的落点）：

| 端点 | 宿主符号 | 作用 |
|---|---|---|
| `session/chat-bind` | `BridgeManager.bindChatAgent` | 把一条 DSH 聊天会话指向某个 agent（写入 `chatAgentIntent` + 请求路径绑定注册表，**不碰模型路由**） |
| `session/chat-model-set` | `BridgeManager.setChatSessionModel` | 切绑定 agent 的模型（`agentId@choice`） |
| `session/chat-effort-set` | `BridgeManager.setChatSessionEffort` | 切绑定 agent 的思考等级 |

**`defaultAgentId`（插件私有状态）保留**：它决定「新会话默认选哪个 agent」，
只是不再与 DSH 任何模型字段发生关系。

### 批次 4：权限裁决链退役

| 符号 | 位置 | 处置 |
|---|---|---|
| `wireAccessMode` | `src/index.ts` | 删，替换为 `wireWorkspace` |
| `decidePermission` / `dshSessionPolicyOf` / `sandboxDenialMarker` / `DshSandboxMode` / `DshApprovalPolicy` / `DshSessionPolicy` | `src/impl.ts` | 删 |
| `authorizeWrite` | `src/bridge.ts` | 删 |
| `SessionPolicyResolver` / `setSessionPolicyResolver` / `sessionPolicyResolver` | `src/bridge.ts` | 替换为 `SessionWorkspaceResolver` / `setSessionWorkspaceResolver` / `sessionWorkspaceResolver` |
| `boundarySection` / `usePermissionSelect` / `joinPermissionSelect` / `permissionCatalogFor` / `AcpPermissionCatalog` / `AcpPermissionSelect` | client | 删 |
| `accessModeRouted` | `src/client/store.ts` / `panel.tsx` | 删 |

**保留**：`ctx.approval` 原生审批链（约束 13 的 `askNativeApproval` 降级路径）——
那正是「permission 原样映射」要用的通道。

**保留**：`resolveSessionCwd` / `chatWorkspaceRoot` / `ensureReady` 的 `spawnCwd`
——侧栏路径即 agent 工作区，这是用户明确要的。

**保留**：`handleFsWrite` 的 `guardFsPath` workspace containment——
那是 ACP 文件协议本来就要求的边界，不是策略层。`DshSessionPolicy` 消失后它退化成
只吃 `session.cwd` + `allowedCwdRoots`（原来还有一个 `unrestricted` 分支）。

**`impl.ts` 里随之删除的**：`AccessModeSessionLike` 改名 `SessionLogLike`（它现在只服务
preset fold，不再有 access-mode 语义）。

### 批次 5：主平面工具卡（**进行中**）

见 §1.4。**不需要写 `ConversationNodeDefinition`，不需要 append 事件**——
把 `BridgeManager.streamPrompt` 里被降级成 reasoning 散文的
`tool_call` / `tool_call_update` 分支改成发真正的 tool-call chunk 序列即可，
宿主与官方 chat 包已注册好渲染器。

---

## 3.5 收敛进度（2026-10-05）

| 批次 | 状态 | 证据 |
|---|---|---|
| 1 路由轴 | ✅ 完成 | `grep` 零残留；`tests/register.spec.ts` 的 "never touches the host model layer at all" |
| 2 座位遮蔽 | ✅ 完成（2026-10-07 修正为 claim；2026-10-14 改为接管） | `tests/model-seat.spec.ts` 16 例断言底座的条件、生命周期与夺回 |
| 3 RPC 清理 | ✅ 完成 | `default/agent` 等新端点在 bundle 中；`tests/store.spec.ts` 的 "the conversation↔agent binding" |
| 批次 4 权限裁决链 | ✅ 完成 | `tests/impl.spec.ts` 的 "the retired permission axis" 断言 helper 已不存在 |
| 5 主平面工具卡 | ✅ 完成 | `streamPrompt` 改发 `tool-call` block 序列；`tests/bridge.spec.ts` 的 "implements LlmAdapter" 断言 reasoning 里**不再有** `mock tool` |
| 6 原生模型座位接管 | ✅ 完成，**2026-10-07 / 2026-10-14 两次修正**（见 §2.4） | `createModelSeatClaim` 把 ACP 底座装进该 cell 并核实夺回；`tests/model-seat.spec.ts` 16 例（含"后来注册的对手抢走 cell 后夺回"、有界放弃、释放栈）|

**测试基线**：224 passed（2026-10-14）。模型座位套件 16 例，其中 claim 部分对着一个**按 runner 真实规则**
实现替身注册表（声明优先级被丢弃、页面级递减 rank、最后注册者赢）跑，而不是对着我们自己写的数字跑。

**验收标准的实际数字**：`tsc --noEmit` 干净；`lib/client.js` 181.30 kB（gzip 46.25 kB）。

**桌面临场验收（2026-10-07）**：临时 `DSH_HOME` + 桌面 asar 内 CLI 起一个只装
`dsh-ntr` + `@hytime/dsh-thinking-effort` 的 web profile（`--port 0`，独立 junction 的 profile node_modules），
一个会话切到 ACP 模式：

| 观察 | 结果 |
|---|---|
| Standard 模式：`[data-slot="conversation.input.model"]` | 被对手占着（`[data-seat-root]`，"DeepSeek-V41-Flash ・ High"）——对照证明对手真的在这个 cell 里 |
| 切到 ACP 模式 | 同一 cell 里是 ACP 底座"ACP · Oh My Pi"（2026-10-07 时为**空**，见 §2.1 的第二次修正）|
| ACP 模式下整页 reload（两侧同时冷启动注册） | 仍然是底座——这正是用户报的那个顺序（对手后注册）|
| 切回 Standard | 对手的 slider 立刻回来（claim 已释放，没有残留条目）|

**2026-10-14 用户报的两个缺陷**（同一根因）：①「ACP 底座位置不对」——底座注册在
`conversation.input.left`（工具行最左的 list 槽位），而原生底座在行尾的
`conversation.input.model`；②「底座没有隔离，任何模式下都显示」——`AcpSessionControls`
只在「无绑定且无 agent」时返回 null，只要配过任意 agent，芯片在任何模式下都渲染。
修法是把两件事合成一件：底座改由 ACP-mode 闸门装进 `conversation.input.model`
（§2.1），`conversation.input.left` 里那条无闸门的 `acp-cluster` 注册删除。
`AcpComposerMode`（agent 自己的 mode）按用户明确指示**留在 `conversation.input.left`**。

---

## 4. 每批的验收

1. `npm run typecheck` 干净
2. `npm test` 全绿
3. `grep` 确认该批退役符号在 `src/` 与 `tests/` 中零残留
4. 更新 AGENTS.md 对应约束的状态标注（已从【已废弃】推进到「已删除」）

---

## 5. 明确不作的事

- **不给 `AcpLlmAdapter.listModels` 加广告**让它过目录门禁——那是把错误轴修得更舒服
- **不改宿主**——`modelAvailable` 是宿主自己的 advisory 契约问题，不是我们的 bug
- **不重加 `policyNotice`**——prompt 必须严格等于用户文本
- **不删 AGENTS.md 里那些【已废弃】约束的「证据」段**——失败方向的第一手记录比假装它没发生过更有价值
- **不把原生模型 seat 改成第二个 ACP 模型入口**——`conversation.input.left` 的底座已经承担选 agent，
  同一个 cell 里再放一个模型面只会把「agent 的模型」和「DSH 的模型」混成一个东西。遮蔽是渲染空白，不是替代
- **不把 rank 算术当手段**：cell 的归属由 runner 的页面级计数器决定（最后一个注册者赢），
  声明多少都不算数。所以只有一件事值得做——**核实 head 是不是自己，不是就再注册一次**（有界、可报告）。
  旧的 undercut 算术、退注册重注册、`onEntryError` abdicate 恢复、`seatBroken` 都不带回来：
  它们保护的是一个被渲染出来的座位，而这里注册失败的唯一后果是「回到遮蔽之前」，可见即可查。
- **不把 claim 做成轮询**：触发只来自 gate 评估与 `slots/changed`（该 cell 的 key），并且只在
  观察到「head 不是我们」时才注册——没有扰动就没有动作。
