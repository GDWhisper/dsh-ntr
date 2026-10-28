# ACP 收敛方向：只借显示层

本文件是 **AGENTS.md「心智模型」** 那节的工程展开，也是代码收敛的唯一权威依据。
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

> **现行状态（2026-10-24）**：本节「要做的事」重新生效——但形态升级为**逐步切分**（§1.8）：adapter 发真 `tool-call` 块，且每个工具活动段结束时**主动结束本次 stream()**，宿主落定消息、执行卡、续跑下一步，下一步继续读同一个仍在飞的 `session/prompt`。中间的历史（做成后又被 §1.7 的散文形态替换）按 §1.5–§1.7 读。

**注意**：`block-end` 的 `block` 会经 `toAssistantBlock` **替换**整个 block，
所以最后一个 `block-end` 必须带完整内容（accumulator 的 `block-end` 分支是覆盖不是合并）。

### 1.5 展示卡的隐性代价：宿主 loop 会续跑，原话会被重发（oml「你好」会话事故，2026-10-11）

> **现行状态（2026-10-24）**：本节的续跑机制**重新生效**——§1.8 的逐步切分靠的正是它（loop 看见 `tool-call` 块就续跑）。原话重发由 guard 第三职责的例外 + bridge 侧「续跑 = 续读同一 prompt」共同防止；虚拟工具（第四职责）带着可等待的 `waitForToolOutput` 一并复活。中间（2026-10-19 → 10-24）的散文形态短暂退役了这些机制。本节按历史记载读：它们记录的是「单段发完全部内容」方案的缺陷——§1.8 的切段让它不再发生。

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

**第二轮事故（2026-10-11，同日）——重复卡片与 `unknown tool` 错误堆**。上述修复
后实测（会话 `session-34788953`，turn 2 第一条消息 24 个块里 18 个 tool-call）
暴露了两个残留：

1. **重发会交错，已闭的卡挡不住重复**。codebuddy 把整条 `tool_call` 重发
   **三遍**当进度用：announce（title=`Bash`）→ 命令串 title 的重写 → 最后一次
   带**结果 content** 的重发；并行调用的重发**交错**（A,B,A,B,A,B）。「同
   callId 折为更新」只在卡片还开着时生效，B 开着时 A 的重发就开出重复卡——
   2 个真实调用变成 6 张卡，且第三遍重发的空 title/空 args 让卡片退化成
   `unknown tool ""`。修复：每 turn 一个 `seenCalls` 注册表，**每个 callId 只开
   一张卡**；已见 callId 的重述只刷新输出记录（`recordAcpToolOutput`），不再
   开卡。accumulator 对已闭合 index 的迟到 `block-end` 是**忽略**的（malformed
   stream），所以「回头替换已闭块」这条路不通，去重必须在发射侧做。
2. **`unknown tool` 错误堆有 seam 可掐**。执行记录就是卡片，执行掐不得；但
   `dsh-tools` 的 `tools/execute` waterfall 是公开扩展点（listener 不调
   `next()` 即短路，非 error 返回值仍要过 `resolveExecution`，error 形状免检
   通过）。guard 的第四职责走得更进一步：对解析不到的工具名**即时注册一个
   agent 作用域的虚拟工具**（`tools.register` 按 calling ctx 的层落位；工具体
   从共享注册表 `toolResults` 取该 callId 的真实输出——桥在折叠循环里把每条
   `tool_call`/`tool_call_update` 的 content 折成文本写入）。卡片从红色
   `Error: unknown tool "Bash"` 变成带真实输出的正常卡。`tools` 服务缺席/
   注册失败时静默放行，退回旧行为。（工具体最初调 `exec.concludeTurn()` 让
   turn 在卡片后直接完成；§1.6 的答案折叠修复把它拿掉了——loop 必须提出
   续跑步，缓冲的答案才有地方落。）

### 1.6 宿主聊天包的两条渲染规则：答案判定与消息内卡片（acp-test-2，2026-10-11）

现象：ACP 回合结束后，整个回合（思考、**答案、工具卡**）折叠进「已完成，
用时 N 秒」的过程行，看起来「agent 的话全成了思考」；工具卡片永远钉在回合
底部。日志证明桥的发射无罪——settled `assistant/message` 的块数组交错正确
（reasoning / tool-call / text），正式答案就在 `text` 块里。两条规则都在 DSH 侧
（asar 内 `@deepseek-ai/dsh-client-ui-chat`）：

1. **答案判定**（`latestAnswer(turn)`）：只要最后一步消息的 blocks 含任何
   `tool-call` 块就返回 `null`。
2. **消息内卡片不渲染**（`AssistantMarkdown`）：消息体对 `tool-call` 块显式
   跳过（`case "tool-call": break`）；卡片只由宿主 loop 在消息落定**之后**
   执行的 `tool/call` 审计事件创建。

2026-10-11 当日的第一版修复是**两步形状**（`answerBuffer` +
`pendingToolAnswers` + `isAcpToolContinuation` + guard 的虚拟工具与闸门例外）。
它修好了「答案不折叠」，但留下了 §1.7 的分层。那一版（缓冲重放的两步形状）
现已废弃——§1.8 的切段不需要缓冲：答案自然落在卡后新开的消息里，最后一段
无卡即答案，`latestAnswer` 直接认中。

### 1.7 分层是真缺陷：一步回合拿不到「步与步之间」（2026-10-19；现行解法见 §1.8）

> **现行状态（2026-10-24）**：本节的诊断（分层源于「一步回合」）仍然成立，但结论「必须是内联散文」已被 §1.8 的**逐步切分**取代：段在卡后主动结束，宿主自己制造出「步与步之间」。内联散文形态（`noteToolActivity` / `acpToolActivityLine` 一族）就此退役。本节按历史记载读。

用户报告「ACP 的回合上面一整块思考、下面一整堆工具卡，而原生对话是交错的」。
三条事实，逐条查证：

1. **块顺序本来就是时间序。** `BlockAssembler`（`@deepseek-ai/dsh-llm`
   `lib/types/assembler.js`）用 `order` 数组输出，首次见到某个 index 就 push，
   `assembled()` 只有一行 `this.order.map(index => …)`，**不按类型分组**。
   agent-loop 把 `assembler.blocks()` 原样写进 `assistant/message`。所以
   「重排」不是解法——顺序从来没错。
2. **卡片不在消息体内画**（§1.6 第 2 条），而 `tool/call` 是 loop 在消息
   **落定之后**才 append 的（`dsh-agent-loop` 的 `appendToolCall`，由
   `step()` 里 `toolCalls.length === 0 ? completed : executeToolCalls` 驱动）。
   卡片因此在结构上永远排在整个 assistant 节点下面。
3. **原生回合之所以交错，靠的是「步」，不是块顺序。** 原生：step 1 思考 + 工具
   块 → 消息落定 → loop 执行 → `tool/call` 卡片 → step 2 思考 + 答案。卡片夹在
   两个 assistant 节点之间，所以看起来是交错的。ACP 回合没有这个结构：agent
   在自己的进程里跑自己的 loop，插件只发一次 `session/prompt`，思考/工具/答案
   全部在一次调用里流回来，**宿主只看到一个 step**。ACP 协议没有「内部一轮
   结束」的信号，`StreamChunk` 里也没有步边界块。

**在一个 step 内部，卡片只能置底。时间序在卡片路径上不可达。**

**当时的修复（2026-10-19，已被 §1.8 取代）**：工具活动改发内联 `text`。
`noteToolActivity` 在发生的**位置**发一行 `🛠️ **<name>** · <status> · `<input>``
（`acpToolActivityLine` / `acpToolActivityOutput` / `acpToolInputOf`，src/impl.ts）。
代价是主聊天平面没有原生工具卡——那是用展示形态换时间序。连带退役的一整片
机制（两步形状、guard 虚拟工具、续跑例外、快照 / delta 函数）随 §1.8 复活。

### 1.8 逐步切分：让宿主自己造出「步与步之间」（2026-10-24，现行）

§1.7 的根因是「插件只发一次 `session/prompt`，宿主只看到一个 step」。真正的
解法不是放弃卡片，而是**把一个 ACP turn 切成多个宿主 step**：

1. **段（segment）**：一次 `stream()` 调用就是一个段。文字 / 思考按到达顺序
   流式；`tool_call` / `tool_call_update` 折成真正的 `tool-call` 块
   （`acpToolCallFromUpdate` / `acpToolCallDelta`，每个 callId 一个 turn 内
   只开一张卡，重述按快照 / 前缀扩展折叠）。
2. **切段点**：段内开过卡、且下一条**非 tool 事件**（文字 / 思考 / 无卡通知 /
   权限请求）到达时，`TurnStreamController` 先 `block-end` 再发 `finish(stop)`
   ——段尾就是卡，宿主落定的消息因此以卡收尾。
3. **宿主制造步**：loop 看见 settled 消息含 `tool-call` 块 → `executeToolCalls`
   → 卡片（guard 的虚拟工具从共享注册表 `toolResults` 取**真实输出**；输出未到
   时工主体 `waitForToolOutput` 挂起，由 `recordAcpToolOutput`、turn settle 或
   30 分钟兜底解除）→ 续跑下一步（staged tool results）。
4. **续跑 = 续读**：续跑批次被 `isAcpToolContinuation` 识别，**绝不新发
   `session/prompt`**——`TurnStreamController.startSegment()` 用 transcript
   游标（`cursorSeq`）补读段间事件再订阅，答案 / 后续卡落在后面的新消息里。
   卡片因此夹在两个 assistant 节点之间，与原生多步回合一致。
5. **guard**：第三职责的唯一例外（本行自己的续跑批次放行，callId 全部在
   `toolResults` 注册表里）与第四职责（`tools/execute` 虚拟工具）一并复活。
6. **turn 级语义不变**：`turn/end` 仍只在 `session/prompt` 响应返回时发出；
   以卡收尾的 turn 由**最后一个续跑段**收口（一条「工具已执行、无更多文字」
   的指针行，避免空气泡消息）；cancel 世代（`turnSeq`）与 prompt slot
   （agent 未确认取消前不解开 `settled` 闸门）跨段成立；段间事件只记账
   （usage / 工具输出唤醒等待者），游标不动，下一段重放补齐。

**同一轮的性能改造**（用户报告：流式期间整机卡顿、时钟跳跃）。排查结论：
宿主端逐 chunk 成本是 O(1)（广播 + 每连接一次 stringify），压力主因在
浏览器端**每条 SSE chunk 一次「数组复制 + 全 state 重建 + 所有订阅组件
重渲染」**，且 NTR 视图无 memo、`t` 每渲染新建、工具块即时
`JSON.stringify`（单块上限 256KB）。修复三项：

- **微批合帧**（src/client/store.ts）：`session/update` 入 `pendingUpdates`，
  每个动画帧一次 `flushUpdates()`——一帧一折叠、一次 `mutate`；
  `usage_update` 等 `STATE_ONLY_UPDATES` 折叠返回 `false`，纯状态 tick
  不复制 blocks 数组、patch 为空时完全不通知。
- **行级 memo**（src/client/acp-view.tsx）：`BlockView` 用 `React.memo`，
  props 是块对象与 store 实例绑定的 `label`；`foldUpdate` 因此改为
  **immutable**（追加 chunk 替换尾块对象，未变行保持引用），只有变化的行
  重渲染。
- **`raw` 惰性化**：工具 / 事件块的 `raw` 从 fold 时的即时
  pretty-print 改为 lazy getter（首次读取缓存）——进度 tick 密集的
  agent 不再每 tick 付 256KB 的 stringify，NTR 视图未开时永不付费。

**delta 合帧透传（曾列的优化 4）评估结论：不做。** 切段后每段只覆盖两个
工具活动之间的短文本，段内 delta 数量天然变少；宿主端逐 chunk 成本本就是
O(1)；浏览器端已由合帧 + memo 吸收。若实测仍有 agent（`usage_update` 密集
的段）把原生平面拖卡，再在段内做 50–100ms 时间窗合并，不预先付这笔复杂度。

同日（2026-10-11）的操作记录仍适用：`session-34788953` 的历史日志曾因旧构建的
重复 tool-call 块被宿主 `@deepseek-ai/dsh-session-persistence-jsonl` 拒载
（`SessionFormatError: assistant/message repeats advertised tool call`）。修复：
每 id 保留**首个**块，删重复的 `tool/call` + `tool/result` 审计行，重排 seq。
现行构建不再产出重复的 tool-call 块，这类旧日志不会再出现。

---

## 2. 目标形态

### 2.1 底座在 `conversation.input.model`

```
conversation.input.left
└── acp-mode        (order 20)  agent 自己的 mode（session/set_mode）

conversation.input.model   ← NTR 底座（NTR 模式下由闸门动态安装）
                            底座菜单只有一级：选 agent
                            （模型 / 思考等级是同一 cluster 里的独立芯片，各开各的菜单）
```

底座占的是**原生模型底座那个座位**——composer bar 行尾（`.trailing`，`margin-left: auto`）、
提交键左边那一个 cell。理由有两条，且指向同一个位置：

1. **位置**：用户报告「NTR 底座应该在原来底座的位置」。原生底座就在行尾，不在工具行左侧。
2. **隔离**：那个 cell 的 occupant 是宿主的 `ModelSelect`，它列 DSH 全量 provider，
   点一下写全局默认模型（§2.4）。ACP 会话里它必须在的正是这里。

于是「占位」和「接管」合成一件事：一个 cell、一个 occupant。底座的注册由 ACP-mode 闸门
（`src/client/index.tsx` 的 `syncAcpMode`）驱动——只在舞台会话跑 ACP preset 时创建 claim，
切走即 `release()`，**非 ACP 会话里这条 entry 根本不存在**，而不是「存在但渲染空」。
这就是隔离：不是组件自隐，是条目不注册。

> 权限档不在菜单里：agent 报什么就问什么（§2.3），没有"档"可切。约束 18 里
> 描述的 `boundarySection`（DSH Access mode 档位）已随那条轴一起删除。

> **没有 agent 服务时，底座是入口而不是一个借来的名字**（2026-10-19，审计 F5）：没有绑定、
> 没有活会话、没有插件默认 agent 时 `routeAgentId` 返回 `undefined`，guard 的 `boundModelFor`
> 也没有可改写的东西——下一条消息跑部署默认 provider。芯片由 `agentBaseChip` 渲染成
> 「接入 NTR / Use NTR」，roster 没有任何行标记为当前；模型 / 思考 chip 与各轴一律退化成空。
> 旧实现以 `agents[0]?.id` 收尾，会把一个永远收不到消息的 agent 放到芯片上。

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

**降级路径与兜底语义（2026-10-19 补记）**：`ask` 优先走宿主 `ctx.approval`
（审批出现在对话 composer 里，不抢答、不设定时器）。走不到的原因由
`LedgerFallbackReason` 区分，全部回落到设置页的 `PermissionLedger`：

- `no-requester` / `no-chat-session`：**设计内**的 ledger 路径（宿主没有审批服务；
  `/acp` RPC 会话没有聊天 turn 可挂审计对）。答案入口就是设置页那张卡，
  `permissionTimeoutMs` 默认 `0` = 无限等人答。
- `unavailable`：**降级**——服务在，这一次却失败了，用户正在看的对话里不会出现这个问题。
  无限等待等于把 turn 挂在没人看得见的问题上，所以它改走
  `permissionFallbackTimeoutMs`（默认 300_000 = 5 分钟）到时代答 `cancelled`；
  填 `0` 连这条也关掉。`permissionTimeoutMs > 0` 时它对所有路径一视同仁。
- `native-timeout`：**另一种降级**（2026-10-27 补记，issue #2）——宿主**收了问题却不答**。
  routed ask 的唯一入口就是 composer 接管且不广播任何帧，所以宿主不渲染（answerer 不在
  浏览器 scope、对话未挂载、remote 事件没送达）时，turn 挂在完全不可见的地方：没有卡、
  没有聊天行、没有期限（实测 CodeBuddy 2.177.0 + 宿主审批提示关闭，只剩 agent 侧心跳）。
  路由因此自带 `nativeApprovalTimeoutMs`（默认 300_000，与 `permissionFallbackTimeoutMs` 同一个窗口）：到点**撤回**——abort 交给宿主的
  signal（宿主 waterfall 用同一 signal 赛跑答案，遂以 `cancelled` 收尾、composer 面板消失），
  再把同一问题改走 ledger。撤回不是代答：人照样能在设置页回答同一个问题。填 `0` 关闭。
  > **已退役（2026-10-28）**：上面的「撤回 + 改走 ledger」不再是现行机制——超时**就地收场**，
  > 不转移（`abort` 拒绝 / `auto` 代答 / `wait` 不设期限），`native-timeout` 这个原因码已从代码里删除。
  > 现行模型见 [permissions.md §2.1](./agents/permissions.md)。

原因在广播前记进 `ledgerFallbacks`，`streamPrompt` 据此写聊天里那行提示：
设计内路径照旧「please approve in Settings」，降级路径要说清为什么对话没展示这个问题
（`unavailable` = 审批服务不可用；`native-timeout` = 对话内 N 秒无应答）并带上倒计时——
措辞只陈述**可观事实**，不猜原因：人答得慢与宿主从没渲染过问题，在桥这一侧长得一模一样。
面板侧 (`permissionLedgerCard`)：**只要 `ui.permissions` 非空就渲染
可答复的卡片**，与 `approvalRouted` 无关——那个旗标只说宿主有审批链，不说这一条
询问进了对话；有待处理项就等于对话没在展示它。

**重连重放（2026-10-27 补记，对齐 OmniTerm dev）**：`permission/request` 只广播一次，
之后连上来的客户端（刷新 / 新标签页 / SSE 重连）永远收不到它，而 ledger 卡正是它唯一的
答案入口。SSE 路由因此在 `stream/open` 之后重放全部未决询问（`permissionReplayFrames`，
快照在订阅**之后**取，实时帧与快照帧按 requestId 幂等折叠），并以 `permission/synced`
的活集合收尾——断线期间已解决的询问必须被客户端丢掉。原生路由上的询问不重放（不广播、
答案入口是客户端已持有的 composer 接管）。OmniTerm 的对应机制是
`PermissionManager::pending_events()` + WS 连接时的 `PermissionsSynced` 标记帧。

OmniTerm 的 reaper 另有一套三档策略（`abort` 取消并回收 / `auto` 代答 / `wait` 一直等，
默认 30 分钟）。本插件**当时只取其中两档**：`abort` ≈ 现行撤回 + 倒计时，`wait` ≈ 两个期限都填
`0`。`auto`（代替用户选 allow）与「宿主不替 agent 回答、每一问都必须交给人」的硬约束冲突，
不移植。
> **已更新（2026-10-28）**：三档**全部取用**，与 OmniTerm dev 的 `acp_perm_timeout_mode`
> 同名同义（`wait` 默认 = 不自动拒绝 / `abort` 拒绝 / `auto` 按 option kind 优先级代答）。
> 此前不移植 `auto`，是因为当时唯一的到点行为是「撤回 + 转移」，代答无处安放；现在超时
> 就地收场，`auto` 是**用户显式选的档**，不是宿主替 agent 决定。
> 插件自己的默认档是 `wait`（权限询问是问人的问题，默认就该等人）。
> 见 [permissions.md §2.1](./agents/permissions.md)。

**两个期限可在设置页热改（2026-10-27 补记）**：`cordis.patch.yml` 仍是部署基线，但
`nativeApprovalTimeoutMs` / `permissionFallbackTimeoutMs` 也能在「NTR 设置 → 审批时限」里改
（`ui/approval-deadlines` / `ui/approval-deadlines-set`），覆盖值落 `agents.json` 的
`approvalDeadlines` 并压过配置文件，改完对**之后的询问**立即生效、不重启也不杀会话。这正是
OmniTerm reaper 控件相对本插件原先形态多出来的那一部分：那边是模式下拉 + 30 秒步进滑块，
经一个原子量热更新；这边当时只做两个窗口（`auto` 档不移植），预设 seg + 自由秒数两路输入，
热应用只改 `AgentBridge` 的两个字段（**已启动的定时器不重排**，正在决定中的人不该被移动球门）。
`permissionTimeoutMs` 保持只能改配置文件——它是「一视同仁」的总闸，不该有两个入口。
三层取值优先级与卡片必须显示的两个事实见 [permissions.md §2.4](./agents/permissions.md)。
> **已更新（2026-10-28）**：卡片现在多一档「到点怎么处理」（`abort` / `auto` / `wait`），
> 一起热改，见 [permissions.md §2.4](./agents/permissions.md)。
>
> **已更新（2026-10-28，第二个窗口退役）**：两个窗口合并成**一个**
> `permissionTimeoutMs`（默认 300_000，`0` = 一直等），设置页卡片因此只剩两个控件
> （一档到点行为 + 一根时长滑块）。对话 composer 里的询问与 ledger 里的询问问的是
> 同一个问题，共用一个答案；两个窗口曾把卡变成三行看不出关联的旋钮。「一视同仁」的
> `permissionTimeoutMs` 总闸随之消失——它让「卡片里那个数」和「真正生效的数」不是同一个数。
> 旧的两个键仍被 `validateConfig` 接受并折叠进新键，老配置不会静默回到默认值。
> 见 [permissions.md §2.4](./agents/permissions.md) 与 [retired.md](./agents/retired.md)。

> **已更新（2026-10-28，「不等待」入轴）**：上一条里「`0` = 一直等」的说法**已作废**——
> 新键 `permissionTimeoutMs: 0` 是**不等待**：请求到达即按「超时处理方式」那一档收场，
> 根本不问人（native 不调 requester、ledger 不建条目也不广播 `permission/request`）。
> 「永不到期」改由 `wait` 模式**唯一**表达，时长滑块上的「一直等待」档随之删除——
> 同一件事不在两个控件里各说一遍。旧两个键里的 `0` 旧义是「这一窗永不触发」，
> 因此迁移成 `wait` 模式 + 默认窗口，绝不迁成「不等待」（否则无人值守的部署会从
> 「一直等」静默变成「立即自动放行」）。见 [permissions.md §2.1、§2.4](./agents/permissions.md)
> 与 [retired.md](./agents/retired.md)。
>
> **再更新（同日）**：「不等待」**只属自动推进**——它代答，agent 继续，所以安全；
> 配「超时中止」则是立刻拒绝每一问，agent 在每个门口都停住（那不是超时，是墙）。
> 因此「超时中止」那一档的时长轴没有这一档，从 30 秒起；任何落到它的 0 一律抬到
> 30 秒。见 [permissions.md §2.1、§2.4](./agents/permissions.md)。

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
闸门往这个 cell 里装的不是渲染 `null` 的 shadow，而是 **NTR 底座本身**
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
**它赢**。用户看到的就是「NTR 模式下底座没有换掉」。

**改了什么**：`createModelSeatClaim`（`src/client/model-seat.tsx`）把 cell 当成**要核实的占位**：
① 注册一个 occupant（NTR 底座）；② 用渲染器自己的 winner 视图 `entriesOfSlot`（renderer 的
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
的 `createModelSeatClaim`——只保留「`stagedIsAcpMode` 条件 + `entriesOfSlot` 核实 + 有界重取」，而 occupant 是 NTR 底座本体（见 §2.1 的第二次修正），
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

### 批次 5：主平面工具卡（**已上线后因 §1.7 退回**）

见 §1.4 、§1.5 、§1.6：接缝确实存在（宿主支持 `tool-call` 块），
而且我们真的发了。但一个 ACP 回合只是宿主的一步，卡片只能置底
（§1.7），所以现行构建改发内联 `text`：时间顺序保留，主平面没有原生卡片。
这一批的“完成”是真实的（接缝找到了、代码上线过），只是它换来的东西不值得。

---

## 3.5 收敛进度（2026-10-05）

| 批次 | 状态 | 证据 |
|---|---|---|
| 1 路由轴 | ✅ 完成 | `grep` 零残留；`tests/register.spec.ts` 的 "never touches the host model layer at all" |
| 2 座位遮蔽 | ✅ 完成（2026-10-07 修正为 claim；2026-10-14 改为接管） | `tests/model-seat.spec.ts` 16 例断言底座的条件、生命周期与夺回 |
| 3 RPC 清理 | ✅ 完成 | `default/agent` 等新端点在 bundle 中；`tests/store.spec.ts` 的 "the conversation↔agent binding" |
| 批次 4 权限裁决链 | ✅ 完成 | `tests/impl.spec.ts` 的 "the retired permission axis" 断言 helper 已不存在 |
| 5 主平面工具卡 | ✅ 上线后因 §1.7 退回（接缝找到并上线，但它交换掉了时间顺序） | `streamPrompt` 现发内联 `text`；`tests/bridge.spec.ts` 的 "implements LlmAdapter" 断言无 `tool-call-delta` 且 `toolAt < answerAt` |
| 6 原生模型座位接管 | ✅ 完成，**2026-10-07 / 2026-10-14 两次修正**（见 §2.4） | `createModelSeatClaim` 把 NTR 底座装进该 cell 并核实夺回；`tests/model-seat.spec.ts` 16 例（含"后来注册的对手抢走 cell 后夺回"、有界放弃、释放栈）|

**测试基线**：312 passed（2026-10-19）。模型座位套件 16 例，其中 claim 部分对着一个**按 runner 真实规则**
实现替身注册表（声明优先级被丢弃、页面级递减 rank、最后注册者赢）跑，而不是对着我们自己写的数字跑。

**验收标准的实际数字**：`tsc --noEmit` 干净；`lib/client.js` 213.91 kB（gzip 55.80 kB）。

**桌面临场验收（2026-10-07）**：临时 `DSH_HOME` + 桌面 asar 内 CLI 起一个只装
`dsh-ntr` + `@hytime/dsh-thinking-effort` 的 web profile（`--port 0`，独立 junction 的 profile node_modules），
一个会话切到 NTR 模式：

| 观察 | 结果 |
|---|---|
| Standard 模式：`[data-slot="conversation.input.model"]` | 被对手占着（`[data-seat-root]`，"DeepSeek-V41-Flash ・ High"）——对照证明对手真的在这个 cell 里 |
| 切到 NTR 模式 | 同一 cell 里是 NTR 底座"NTR · Oh My Pi"（2026-10-07 时为**空**，见 §2.1 的第二次修正）|
| NTR 模式下整页 reload（两侧同时冷启动注册） | 仍然是底座——这正是用户报的那个顺序（对手后注册）|
| 切回 Standard | 对手的 slider 立刻回来（claim 已释放，没有残留条目）|

**2026-10-14 用户报的两个缺陷**（同一根因）：①「NTR 底座位置不对」——底座注册在
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
- **不把原生模型 seat 改成第二个 ACP 模型入口**——`conversation.input.model` 的 NTR 底座已经承担选 agent，
  同一个 cell 里再放一个模型面只会把「agent 的模型」和「DSH 的模型」混成一个东西。注意这个 cell 现在是**接管**（occupant 是 NTR 底座本体 `AcpSessionControls`），不是渲染空白——「遮蔽是渲染空白，不是替代」是 2026-10-14 第二次修正前的旧结论，现行形状见 §2.4
- **不把 rank 算术当手段**：cell 的归属由 runner 的页面级计数器决定（最后一个注册者赢），
  声明多少都不算数。所以只有一件事值得做——**核实 head 是不是自己，不是就再注册一次**（有界、可报告）。
  旧的 undercut 算术、退注册重注册、`onEntryError` abdicate 恢复、`seatBroken` 都不带回来：
  它们保护的是一个被渲染出来的座位，而这里注册失败的唯一后果是「回到遮蔽之前」，可见即可查。
- **不把 claim 做成轮询**：触发只来自 gate 评估与 `slots/changed`（该 cell 的 key），并且只在
  观察到「head 不是我们」时才注册——没有扰动就没有动作。
