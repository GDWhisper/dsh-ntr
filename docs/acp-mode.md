# NTR 模式：把会话交给另一个 agent

> **先读这个**：本插件的本质是**借 DSH 的界面壳，与 ACP agent 对话**。DSH 提供的只有显示层（会话身份、消息列表、输入框、侧栏），它的模型调用逻辑我们不参与。一次对话的归属：推理、工具执行、文件读写、权限决策全部属于**对端 ACP agent**（独立进程，完全自治）；模型选择、思考等级、权限档都是 **agent 自己的概念**，不是 DSH 的模型目录。
>
> 本文早年的版本里，ACP agent 是作为 provider `acp` 接进 DSH 模型选择器的。那个方向已被放弃——它要求 ACP 会话先写一条合法模型路由才能发消息，于是写路由污染全局默认模型、被 GUI 目录门禁拒、原生模型座位还要遮蔽。§4 与 §5 里仍保留着那些机制的记载，**标注为「历史做法」的段落就是它**，读的时候知道那是走过的弯路，不是现行设计。
>
> 完整的约束与废弃判定见 [AGENTS.md](../AGENTS.md) 的「本插件是什么」一节，那里是权威。

## 1. 问题：原生上下文确实被转发给了对端 agent

DSH 组装一次请求时，消息顺序**不是**"历史 + 最后一条用户消息"：

1. `dsh-agent-loop` 的 `preStep` 返回 `[...claimed, context]`——运行时上下文快照排在用户消息之后；
2. `dsh-agent-instructions` 的 pre-step 监听器源码注释写明设计意图：*"Fold the context right after the claimed batch, so the direct prompt precedes it and the driver-appended runtime context follows it."*

于是"最后一条 user 角色消息"通常是注入的上下文，而不是人说的话。真实会话日志（`~/.dsh/sessions/--home-pax-coding-OmniTerm-dev--/session-de40ee69…`）里的一轮：

| seq | source | 内容 |
| --- | --- | --- |
| 15 | `user` | `你好` |
| 16 | `agent-instructions` | AGENTS.md 工作区指令摘要 |
| 17 | `plugin/@deepseek-ai/dsh-system-prompt`（`form: snapshot`） | `Current runtime context… Current DSH file policy: …` |
| 18 | `skill-catalog` | `<available_skills>…` |

修复前的 `BridgeManager.streamPrompt` 取 `userMessages[userMessages.length - 1]` → 转发给 ACP agent 的是**技能目录**。

同类漏网第二条：`GenerateOptions.purpose`（`session-title` / `compaction`）。标题生成复用**同一会话的已记录 route**（实测 `session/title-llm-request` 的 `route = { provider: 'acp', … }`，且请求带 `sessionId: request.session.id`），所以它会进入同一个 adapter；不看 `purpose` 就会把"给这个会话起个标题"当成一轮真实 prompt 送进同一个 ACP 会话（或撞 `turn_in_flight`）。

**修复（宿主侧，`src/impl.ts` 的 `selectForwardPrompt` + `src/bridge.ts` 的 `streamPrompt`）**：

- 只转发 `source.kind` 为 `'user'`（或没有 source 的手工请求）的消息，且取最后一条——注入的 `plugin` / `agent-instructions` / `skill-catalog` / `tool` 一律跳过；
- 一个只有注入消息的"唤醒轮"（goal / subagent / skill 注入）不发任何 ACP 轮次，直接以 `stop` 结束；
- `purpose !== undefined` 的辅助请求直接失败（`unsupported_purpose`），标题服务回落到文本兜底，compaction 本就是尽力而为。

## 2. NTR 模式 = 一个 agent preset（不是新控件）

DSH 的"模式"就是 **agent preset**：一条 `@deepseek-ai/dsh-agent-preset` 声明（`- id: preset-<id>` + `config.{id,name,description,order,plugins}`；随部署的 `standard` / `ptc` / `minimal` / `cordis` 是 `@deepseek-ai/dsh-web-app` 的 `presets/*.patch.yml`）；UI 上是新会话页的模式 chip（`conversation.hero.agentPreset`）。它只能在**空白会话**上选/切（已产出内容的会话由网关返回 `agent-preset-locked`）。

**声明只能由 bundle patch 携带，且旧的目录 roster 已死**：DSH 早先按 `$DSH_HOME/.agent-presets/<id>/{preset.yml,agent.cordis.yml}` 自动发现用户 preset，现在**任何代码都不再读那个目录**（0.1.7-rc.1 实测：整个安装树里除了 `dsh-agent-preset` 的迁移文档外没有任何读取方）。所以 dsh-ntr 自己就是 profile bundle（`dsh.bundle.patch`），NTR 模式的声明就写在它的 `presets/acp/acp.patch.yml` 里——模式 chip 因此随插件包本身出现，没有任何复制/安装步骤。旧目录里残留的副本无害（没人读），可以删。

分工是硬边界：preset 拥有 **agent 平面**（工具注册、prompt 段、plan mode、compaction、`agent-instructions` / skill 目录这类注入行），而 **host 平面**（loop 本身、各 registry、sandbox/approval、persistence、model route）preset 拿不到。**loop 不可替换**：创建 agent 只有一个 factory（`ctx.agents.setFactory`，由 `dsh-agent-loop` 注册），所以"NTR 模式"不能把 DSH 从驱动位置上摘掉。

它**能**做的是把宿主对模型可见的贡献清零，`presets/acp/acp.patch.yml` 的声明就干这个：

- `@deepseek-ai/dsh-persona` 行：`prefix`（persona 前缀段的文本，**旧名 `text` 已失效**——schema 是 `prefix: string` 必填 + `suffix?` + 两个开关，写错键会让整个 preset 在会话创建时报 `invalid config: $.prefix missing required value`；省略 `suffix` 是故意的，缺席即遮蔽部署 suffix）+ `complete: true`（压制 harness 身份段与部署 persona）+ `includeRuntimeContext: false`（不再组装运行上下文快照）；
- 不挂任何 `tool-*` 行 → 工具目录为空（对端 agent 的工具在它自己进程里）；
- 不挂 `agent-instructions` / `tool-skill` / `skill-filesystem` → 没有 AGENTS.md 摘要，也没有 `<available_skills>` 大块；
- 不挂 `plan-mode` / `tool-todo` / `tool-goal` / `compaction-basic` / `command-compact` / 委派行 → 这些原生状态机与辅助调用不再作用于该会话；
- `acp-guard.mjs` 行：三个监听器。① `agent/pre-step` 步进闸门：过滤 `agent-instructions` / `skill-catalog` / 一切 `plugin` 来源（保证后来新增的行或 host 平面的注入也不会悄悄回到模型视野），并**拒绝「strip 后仍有内容、却没有用户来源」的批次**——那是宿主 agent-loop 看见 ACP agent 的展示型工具卡后续跑出来的下一步（staged tool results），放行就会把人的原话重发给 agent（oml「你好」会话事故，见 [acp-convergence.md](acp-convergence.md) §1.5）；`reject` 让 turn 以 blocked 收尾，注入轮的空批次仍走原 completed 空转，无 source 的消息算用户输入（与 bridge 取词约定一致）。**唯一例外**是本行卡片续跑出的批次：每条 staged tool result 的 callId 都在共享注册表里（`toolResults.has`），adapter 会对它回放缓冲的答案文本而不碰 ACP agent——这是两步形状的答案回放步（见 [acp-convergence.md](acp-convergence.md) §1.6）；注册表里查不到的 callId 照旧 reject。② `tools/execute` 展示卡执行器：宿主 loop 会「执行」每张 ACP 展示卡（卡片渲染依赖执行记录，掐不得），preset 没挂工具时每张卡曾记一条 `unknown tool` 错误。此监听器对解析不到的工具名**即时注册一个 agent 作用域的虚拟工具**，工具体从共享注册表 `toolResults` 取该 callId 的真实输出回给宿主；真实输出由 `recordAcpToolOutput` 在折叠循环写入（空 content 也记录，闸门成员判定靠它）。工具体**不调 `concludeTurn()`**——宿主聊天包的答案判定拒绝任何含 tool-call 块的消息，loop 必须提出续跑步，缓冲的答案才有地方落（①的例外就是给它开的）；真实工具与 `tools` 服务缺席时静默放行（闸门兜底）。③ `agent/request` 路由改写（`{ prepend: true }`）——把 driver 解析出的请求配置改写成插件绑定指向的 `acp/<agent>`，否则从未跑过 ACP 轮次的会话发到部署默认 provider、已跑过的永远回放旧 agent（`prepend` 是因为 harness 自己的 `installModelSelection` 改写先注册，只有最外层能让绑定赢）。绑定经 `globalThis[Symbol.for('dsh-ntr.acp-binding')]` 与插件共享（guard 是 Loader 加载的独立模块实例），机制见 [acp-convergence.md](acp-convergence.md) §2.2。该行以**包名**引用（`dsh-ntr/acp-guard`，由 package.json 的 `exports` 映射到 `presets/acp/acp-guard.mjs`）：声明里的插件名是按**声明者 Loader 的解析基准**（profile 目录）解析的，`./acp-guard.mjs` 这种相对路径会落到 profile 目录里一个不存在的文件上。

安装：**没有安装步骤**——声明是插件包自己的 bundle patch，模式 chip 随包出现。只有「声明到了 roster 但激活失败」才需要人看：设置页那张卡读宿主 roster（`ctx.agentPresets` 的 `list()`，缺席即隐藏）并原样显示宿主的诊断。`preset/status` 只读，没有 `preset/install`：往那个没人读的旧目录里复制文件曾经让 UI 显示"已安装"而模式 chip 依然不见。

## 3. 权限：完全交给 agent，界面只负责接住并原样上报

**ACP agent 完全自治**：DSH 的 Access mode / `sandboxPolicy` **不参与** NTR 会话的权限裁决。下面是本节早年的做法，现已废弃：

> 【历史做法】`decidePermission(policy, kind, paths, { narrateOnly: true })` 曾是 NTR 模式下的裁决——`danger-full-access` 本地放行、读类 kind 放行、其余 `ask` 交人类；`approval: 'never'` 时宿主没有可问的人（`ApprovalService.decide` 在 answerer 之前就把每个 ask 判成 `'rejected'`），所以本地 `reject`。**保留 fs 写栅栏**——`fs/write_text_file` 走 `authorizeWrite`（工作区根白名单 + `allowedCwdRoots`），那曾被认为是本插件对 ACP 子进程"唯一真实的作用力"，因为 DSH 的文件沙箱对另一个进程里的工具毫无约束力。
>
> 【为什么废弃】那仍然是宿主坐在中间替 agent 判一遍，只是判得宽松些。而这个 knob 本身曾是反的：`never`（"完全权限"预设）会在 answerer 之前把所有 ACP 权限询问判成 rejected，`read-only` + `ask` 又能被一次"允许一次"写穿。既然是 NTR 会话的裁决权本就不属于宿主，正确的做法是**不裁决**：agent 报什么就问什么，人答了什么就回什么。

**现行方向**：agent 侧 `session/request_permission` 原样映射到界面上。每个 agent 的权限形态不同（有的给选项列表、有的给 allow/deny、有的带 tool call 详情），接住它的载荷、渲染给人、把人的选择按 ACP 协议回包即可，宿主不预先判 allow/reject。

**prompt 仍然严格等于用户文本**：这一条与权限怎么走无关，必须继续遵守。每轮转发给 ACP 的 prompt 严禁拼任何边界/策略句子（早期有 `policyNotice` 前缀叙述，已按用户要求彻底移除，不要以"agent 不知道边界"为由重加）。

**工作区来自侧栏，这条继续有效**：ACP `session/new` / `session/load` 的 cwd 必须是该 DSH 会话自己的工作区（sidebar 点开的路径），且同一个工作区还要作为**子进程自己的 cwd**（`safeSpawnCwd`）——有一类 agent（实测 codebuddy）在进程启动那一刻就把 workspace 定死，它在读任何 ACP 请求之前先打印 `Workspace Path: <process cwd>`，其 file policy、给模型看的 env 块、项目态全按它来，`session/new` 的 cwd 对它们太晚。

判定"这是不是 ACP 会话"读的是**会话日志里的 preset id**（`sessionAgentPreset`，镜像 `dsh-agent-presets` 的 `resolveSessionPreset`：最新 `agent-preset/selected` 事件优先，否则创建 header），而不是我们自己打的标记——后者可能与 roster 实际挂载的组装漂移。

## 4. 对话内的 NTR 面：选 agent 的底座 + 一个视图 tab

模式选完之后，真正的日常界面在对话里。

| 座位 | 文件 | 干什么 |
| --- | --- | --- |
| `conversation.input.model` | `src/client/session-controls.tsx` 的 `AcpSessionControls` | **NTR 底座：第一级是选 agent**；agent 自己的模型、思考等级由该底座的多级菜单承担。它占的是原生模型底座那个座位（composer bar 行尾、提交键左边），且只在 NTR 模式下由 `createModelSeatClaim` 注册 |
| `conversation.input.left` | `src/client/composer-mode.tsx` 的 `AcpComposerMode` | agent 自己的 `session/set_mode` 模式控件（与底座分开，留在工具行） |
| `conversation.input.overlay` | `src/client/session-controls.tsx` 的 `AcpSessionMenu` | 底座的下拉选择器（浮在 composer 卡片上方，与 `/` 命令菜单同一个锚点） |
| `conversation.view` | `src/client/acp-view.tsx` | **NTR tab**：对端 agent 的真实工具调用 / 计划 / unified diff / 用量 |

**消息展示在主聊天平面**：用户说的话与 agent 的回包都渲染进原生聊天流，不另起炉灶。

**agent 自己的模型面读 `agent/catalog`**：`base`（裸 `agentId` = agent 默认模型）+ `exposedModels` 过滤后的 `agent@choice` 变体 + agent 自己的 `thought_level`（作为 `reasoning`）。这份读是**纯内存**的（未热时只允许后台探针，绝不在渲染路径上 spawn），按 agent 缓存于 `AcpStore.seatCatalogs`，并在探测或勾选变动后失效重读。

### 【历史做法】那条 provider 路由与共享的模型目录

早年的设计把 ACP agent 接成一条模型路由 `acp@<agentId>`，于是"在哪条路由上"的权威状态落在宿主的 per-session 模型目录（`ctx.modelDirectories.directoryFor(sessionId)`），芯片通过 `directory.select({ provider: 'acp', model, reasoningEffort? })` 写入，与原生模型选择器共享同一份状态。切模型时新 effort 取该 agent 的 `reasoning.defaultEffort`，切 agent 传裸 `agentId`。

**这条路已被放弃**，代价记录在案：

- 写路由会顺手写 DSH 的**全局默认模型**（`session.selectModel` 每次写两份），一次 ACP 选择就让所有模式的新会话从对端 agent 起步，而那个 agent 收到的是宿主的工具 schema；
- 宿主的 `session/select-model` 在写入前要过 `modelAvailable` 门禁（GUI 选择要求 provider/model 确切出现在可用目录里，否则 `session/model-unavailable`），而约束 8 要求 `listModels('acp') 返回空数组`——**实测报错 `session/model-unavailable: Select an available model before sending a message.` 正是这条链撞上的**，两边都不可能让步；
- 宿主目录构建是 per-request 而非 per-session（`buildModelCatalog(ctx)` 不接 session id），所以"少列几个 provider"在宿主平面根本做不到，只能靠浏览器半区把原生模型座位遮蔽掉（`priority: -1` + `ensureSeatWins` 压 rank），那是一整层跨插件竞争。

**保留下来的是 `useDirectory` 的解析纪律**：`ModelDirectoryResolver.directoryFor(sessionId)` 在会话运行期 scope 尚未物化时会 throw（真实实例实测：页面加载后约 0.2s 报 `cannot get property "remote.session" without inject`，命中的正是当台会话），这与"addressed subagent 会话被设计性拒绝"是完全不同的第二种失败。所以 `resolveDirectory` 必须有界重试、拿到目录即停——一次性 memo 会让整页 NTR 芯片永久消失。

**会话边界（Access mode）放在 NTR 芯片的菜单里**，而不是并排再放一个下拉：原生 Access mode 就在同一条工具行上，并排再摆一个只会被读成重复控件。菜单里那一栏叫「会话边界（DSH Access mode）」，数据来自 `permissions` 投影，切换走 `SessionFace.command('/permission <preset>')`（宿主自己的命令，插件不实现开关），旁注写明它规定的是宿主给我们这道闸门的边界。

**为什么工具卡必须另开一个视图 tab**：LLM adapter 的 chunk 词表只有 `text` / `reasoning`，所以对端 agent 的工具调用进入原生聊天时只能是 `> 🛠️ [Tool: …]` 这样的散文行，diff 只剩文件名。NTR tab 读的是同一份 durable transcript（经 `session/chat-transcript`，按 **DSH 聊天会话 id** 寻址——浏览器在看到返回值前并不知道 ACP 会话 id），于是：

- 工具卡按 `kind`（read / edit / execute / search / fetch / think / switch_mode …）给图标，`status` 给色调，输出折叠（默认 12 行）；
- `content: [{ type: 'diff' }]` 被 `foldUpdate` 单独抽成结构化字段（不是压成 `diff <path>` 字符串），渲染为真 unified diff：先剪公共前后缀，再对中间段做 LCS 对齐（超过 300 行退化为“全删全加”），带 `+N -M` 统计；
- 计划是一张勾选表（`✓ / ▸ / ○`），思考是折叠块，消息是左右气泡（含围栏代码与行内 code/bold）。

流式更新不需要轮询：store 把 SSE 的 `session/update` 直接折进被观察的 transcript（`chatTranscripts`，上限 `MAX_WATCHED` 条，最旧的淘汰），`session/reset`（resume 重放）会同时清空块与 seq 水位，`session/closed` 直接丢弃——**已关闭的会话不提供幽灵历史**。视图本身只读，没有任何 prompt/cancel/spawn 能力。

### 【历史做法】默认 agent（★）、路由强制与 `modelSelection`

早年这套机制围绕"必须把 ACP 会话按在一条 `acp` 路由上"展开，现已随 provider 身份一起退役。**但其中两条实测证据必须保留**——它们是本项目走错方向最完整的记录，也是未来任何"想重新接回宿主模型层"的念头的第一手劝阻材料。

**证据一：宿主没有"只写会话路由"的入口。** `session.selectModel` 对每一次选择写两份——会话自己的持久路由**和**全局默认模型（`agentDefaultModel.saveSelection`），后者不分会话、不分模式。所以任何一次 ACP 选择都会让**所有模式的新会话**从对端 agent 起步（那个 agent 收到的是宿主的工具 schema）。插件为此写了 `AcpDefaultModelGuard` 记住最后一个原生默认并在默认变成 `acp` 时改回它，候选顺序是「该会话写入前的原生路由 → 已知原生默认 → live 会话里最近的原生路由（`lastNativeRoute`）」，一个都没有时保持原值并如实报 `stranded: true`。整套舞步（`selectAcpRoute` 先读旧路由再写、`reconcileDefaultModel` 回滚全局、`settleAcpRoute` 强制、`watchRoute` 订阅模型目录纠正、`attempts` 上限、`routeNotices` 报错横幅）都在退役路径上，见 [AGENTS.md](../AGENTS.md) 约束 22。

**证据二：判定不能读 `modelSelection` 投影，因为它不携带模式。** 宿主的 wire view 是 `next = pending ?? lastUsed`，`lastUsed` 由每条 `request/header` 写入（= "这个会话跑过一轮"），投影又在页面加载时就由宿主投影块（折叠整份日志）经 `ProjectionValueStore.seed()` 种入——读 `next` 等于"永不路由任何用过的会话"（2026-09-30 修掉的第一个 bug，会话 `539c96ef`）。改用 `pending` 后仍有第二个 bug：实测会话 `940a8365`，用户在**标准模式**下 `/model` 选了 `tokitoken/mimo-v2.6-flash`（seq 6），再切到 NTR 模式（seq 7），跨模式的 `pending` 被当成"尊重用户的选择"放行，seq 14 的请求发往原生 provider，而 system prompt 已经是 ACP preset 的 217 字符无工具版本——**模式与内核脱钩**。结论：判定只看模式（会话日志里的 preset），不看任何选择投影。

## 5. 已知边界（做不到的事）

### 【历史做法】NTR 模型的结构性隔离与座位遮蔽

以下整段属于"ACP 作为 provider 接进 DSH 模型层"的年代。里面的机制描述仍然准确，但它们是**为一条已被放弃的轴服务的**，读的时候按历史记载读，别照着改。

**⚠️ 遮蔽的那套代码已删，但遮蔽本身以另一种形式回来了**（2026-10-05，见 [acp-convergence.md](acp-convergence.md) §2.4）。删代码时写下的是「原生座位不再由本插件注册」——那句话只描述了**插件停止做的事**，没回答**用户还会看到什么**。而 occupant 是宿主的（`client-ui-model-selection` 的 `ModelSelect`），宿主 composer bar 无条件渲染它，于是遮蔽删掉后原生 `ModelSelect` 原样回来了：它列 DSH 全量 provider，而且点得动，点了就写全局默认模型。**收敛消除的是「NTR 会话*必须*写路由才能发消息」，没有消除「UI 上还有一个能写路由的入口」。**

现行实现是 `src/client/model-seat.tsx` 的 `createModelSeatClaim`（条件仍是 NTR 模式判定，注册经 `ctx.slots.inject`），而它往这个 cell 里装的是 **NTR 底座本体**（`occupant: () => AcpSessionControls`），不是渲染 `null` 的影子——2026-10-14 用户报的两个缺陷（底座位置不对、底座在任何模式下都显示）就是同一根因：底座原来注册在 `conversation.input.left`（工具行最左），而真正带 ACP-mode 闸门的 claim 占的是另一个 cell 且只渲染空白。现在「底座的位置」和「底座的隔离」合成一件事：闸门持有 claim 时装底座，释放即收回。**关键修正（2026-10-07）**：声明优先级赢不了这个 cell——客户端 runner 的 `guardedSlots` 会把非 chain 槽位的 `priority` 改写成它自己的页面级递减计数器（`allocatePriority: () => --nextPriority`），所以赢家是**最后一个注册者**；而 `@hytime/dsh-thinking-effort` 把它的模型/思考强度 slider 注进同一个 cell 且排在我们之后注册，于是 `priority: -1` 的 occupant 只是「已注册」，cell 里仍是对方。claim 因此要**核实**（`entriesOfSlot` 读这个 cell 的 head，比自己的组件身份）并在被抢走后**再注册一次**（有界 `MAX_SEAT_CLAIMS`，到顶如实报「被谁占着」），触发来自 gate 评估与 `slots/changed`；`spec()` 用来区分「composer bar 还没挂」（`inject` 对未声明槽位是静默等待）与「别人占着」。**下面几条描述的旧机制——undercut rank 算术、rank 压栈、abdicate 恢复、`seatBroken`——依然不要带回来**（undercut 本来就无效，其余保护的是一个被渲染出来的座位）。这个教训本身值得记：**退役一条链时要区分「这根轴的要求」和「这根轴顺带提供的防护」**，**写完「就这样遮蔽」之后要在真运行时核实它真的赢了**，以及**「组件里 return null」不是隔离，闸门不注册才是**（2026-10-14）。

- **宿主侧不能按会话过滤目录**：目录构建（`buildModelCatalog(ctx)`）是全量遍历 `ctx.llm.listProviders()`，且**不接 session id**，没有 per-session 过滤 seam。所以"在宿主目录里少列几个 provider"做不到——当年的应对是让 ACP 模型压根不进那份目录。
- **结构性隔离 = 什么都不广告**：`AcpLlmAdapter.listModels('acp')` 返回空数组。目录是按**请求**而非按会话构建的，一个 provider 只要广告模型就等于对每一条会话广告（包括没有 ACP agent 在背后的）。`LlmAdapter.listModels` 的契约写明目录是 **advisory**（"an adapter may accept unlisted model ids, and consumers must not turn absence into request rejection"），路由可用性由**注册**判定（`routeServed` 读 `listProviders()`）。
- **另一半靠座位遮蔽（浏览器侧）**：`conversation.input.model` 虽是 single 槽，却**按 `priority` 遮蔽**（同一 cell 上最低 priority 的活跃条目渲染，同 priority 重复注册才 throw）。于是 `AcpModelSeat` 以 `priority: -1` 顶掉 `ui-model-selection` 的原生 `ModelSelect`，而注册是**动态的**：只有当客户端 session list 的当前会话 `agentPreset === 'acp'` 时才挂上，切走即 dispose 让原生回来（判定见 `shouldShadowModelSeat`）。
- **遮蔽的失败模式必须是"不接管"**：任何一环读不到（`sessions` 服务未就位、没有 `modelDirectories`、槽位未声明、注册被拒、当前是 addressed subagent 路由）都保持原生座位；座位自己的渲染崩了，靠 `slots.onEntryError` 的 abdicate 把座位与会话芯片一起交还，并且本次页面生命周期内不再重试（`seatBroken`）。
- **动态插件运行时会改写 priority，遮蔽要靠「显式压 rank」保住**（实测 `dsh-cordis-client-runner` 的 `guardedSlots`）：动态包传给 `slots.register` 的 `priority` 若撞上它的自动分配（每包一个 auto rank，实测为 `-1`），语义会被静默改写；而别的动态座位插件（如 `dsh-thinking-effort` 的模型 slider）同样占这个 cell，实测出现过「我们的条目已注册、cell head 却是对方」的僵局。两条实测纪律：**（1）退了重注册没用**——runner 的 load 收敛会把同 rank 的新贡献整个吞掉（复现：cell 里只剩对方一条）；**（2）exact-priority 重复注册会 throw**。所以 `ensureSeatWins` 在注册后读渲染器自己的 winner 视图（`entriesOfSlot`），发现 head 不是自己时**另注册一条显式更低 rank（`min(head-1, -100)`）**的条目（独立组件身份，防 dedup 合并），一次压过即赢；上限 4 次，stack 由 `dropSeat` 在 gate 退场时整体回收。
- **遮蔽的闸门有两个事实源，行缺失时回落宿主上报**：主事实源是客户端 session list 的会话行（`projectionValues.agentPreset`，由 `agent-preset/selected` 帧折叠而来），而这个字段是较新的客户端运行时才有的。行没有携带 preset 时，闸门回落到本插件宿主半区的只读上报：`session/chat-list` 响应里的 `acpMode`，浏览器半区对每条会话只问一次（`acpModeAsked` 防止无上报的宿主把每次 store 变动变成新 RPC），`agent-preset/selected` 帧会作废缓存并重问。
- **宿主上报自己是三级事实源，冷会话必须落盘冷读**（实测教训：`ctx.sessions.get()` 对**冷会话**（上一轮属于上一个宿主进程）返回的是**事件为空的占位 stub**，空日志折叠出默认 preset `standard`——一次同步的「拿到了会话」其实是「拿到了空会话还信了它」）。所以 `setAcpModeResolver`（`src/index.ts` 的 `wireAcpMode`）的裁决顺序是：① 活会话且**日志有行**（`session.events.length > 0`）→ `sessionAgentPreset` 同步作答；② 否则 `sessionPersistence.open(id, 'read')` 只读打开持久化日志，`sessionAgentPresetFromLog` 折叠 header + 尾部 `agent-preset/selected`；③ 服务缺失/读失败 → `undefined`（读作不接管，绝不把查不到当「确定不是」）。RPC 应答走 `chatSessionAcpModeAnswer`（bridge.ts）：**await** 冷读落地后一次性给出权威判定 + in-flight 去重 + per-session 缓存。
- **`session/model-unavailable` 是这条路线的终点**：宿主的 `session/select-model` 在写入前要过 `modelAvailable`，它要求 provider/model 确切出现在可用目录里；而隔离策略要求 `listModels('acp')` 返空。两边都不可能让步，于是 `acp@<agent>` 路由必然被拒——**实测报错 `session/model-unavailable: Select an available model before sending a message.` 就是它**。（注：宿主的 prompt 准入路径并不校验目录成员资格，所以"发消息"从来不是问题，"写路由"才是。）

### 仍然有效的边界

- **不能替换原生 Access mode 下拉**：它不是 slot（由 `ui-conversation` 的 InputBar 直接渲染 `PermissionSelect`），数据来自被 `dsh-permission-presets` 独占注册的 `permissions` 投影。可以读、可以用 `/permission <preset>` 切，不能改它的项。
- **原生聊天里曾经只有文字——现已不再是缺口**：批次 5 之后，`BridgeManager.streamPrompt` 直接把 ACP 的 `tool_call` / `tool_call_update` 折成真正的 `block-start('tool-call')` + `tool-call-delta` + 完整快照 `block-end`，宿主 `AssistantStreamAccumulator` 自己会折成 `{ kind:'tool-call', callId, name, argsRaw }`，官方 chat 包的 tool-call 渲染器画卡片。NTR tab 保留下来承担**计划 / 折叠明细**这类 Card 之外的内容，不再是工具卡的唯一去处。（host 侧 chunk 词表一直是够的，缺的只是我们没用。）
- **模式只能在空白会话选**：想中途切换到 NTR 模式（preset）需要新建会话。历史上下文不会追送（只转发人说的话），所以中途接管是"从这里开始由它接手"。
- **芯片不出现于普通会话**：从没跑过 NTR agent 的会话不渲染任何 NTR 芯片（工具行保持干净）。
- **一个 NTR 轮次的"结束"由对端 agent 决定，宿主不替它收尾**：`turn/end` 只在 `session/prompt` 的**响应**返回时发出，不在最后一个 chunk 到达时——所以"已经不再吐字了但仍显示正在输出"这段时间属于 agent 自己的内部节奏。实测（codebuddy，首轮）：它要先完成自己的标题生成才回应 prompt，期间一个通知都不发（它自己的日志：`Timed out waiting for pending title generation … timeoutMs=5000`），于是首轮的可视收尾被推迟约 5s。这是**记录在案的边界，不是待修 bug**：宿主无法区分"agent 正在想"与"agent 在磨蹭"，任何强制定稿（提前发 `turn/end`）都会把真实答案切在流中间；能提前给出响应的只有 agent 自己。唯一已有的强制定稿兜底是 `session/cancel` 之后的 `cancelFallbackMs`（见 `armCancelFallback`）——那是用户已经叫停的场合，与这里的语义完全不同，不得复用。兜底定时器带 **turn 世代守卫**（`session.turnSeq`）：agent 迟到结算了旧 turn、用户已发新 turn 时，定时器不得误杀新 turn，且强制定稿要同时解开 `settled` 闸门，否则适配器路径的下一轮 prompt 卡在 `unsettled`。
- **粘滞取消吞消息**：一部分 agent（实测 codebuddy 2.161.4）异步清理 cancel 状态，落在清理窗口内的**下一条** prompt 被秒回 `cancelled`（复用旧 requestId、不生成 turn），用户消息无痕消失。`runPrompt` 的判据是「本世代是否发起过 cancel」（`cancelRequestedAtTurn` 对比 `turnSeq`），不是延时；判为粘滞就等 `staleCancelRetryDelayMs`（默认 600ms，须长于 agent 清理窗口）原样重发，有界 `staleCancelMaxRetries`（默认 2）。取材自 OmniTerm 的同型事故（`src/acp/client.rs` 的 `STALE_CANCEL_RETRY_DELAY_MS`）。
- **正常结束却零可见产出必须显式报出**：一部分 agent 把上游失败（provider 403、认证、计费）折叠成合法 `end_turn`（实测 pi-acp），聊天平面只剩一个空气泡。`streamPrompt` 结算时按 `sawVisibleBlock`（text / reasoning / tool-call 的 block-start，usage 等记账帧不算）记账，零可见块就把告警文本作为 text 块发出——这是**报告**不是收尾，turn 照常以 stop 结束。
- **codec 是手拷贝**：`splitAcpModelId`（浏览器）与 `splitAdapterModelId`（宿主）必须同步，由 `tests/acp-view.spec.ts` 的等价断言看住。
