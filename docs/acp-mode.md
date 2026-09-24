# ACP 模式：把会话交给另一个 agent

> 背景：本插件最初把 ACP agent 作为 provider `acp` 接进 DSH 的原生模型选择器。方向没错（那是唯一能把流式输出画进原生聊天的入口），但实现里有两处把宿主自己的东西喂给了对端 agent，而"会话由谁驱动"这件事也需要一个显式的表达。本文记录由此得出的设计、证据与硬边界。

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

## 2. ACP 模式 = 一个 agent preset（不是新控件）

DSH 的"模式"就是 **agent preset**：一条 `@deepseek-ai/dsh-agent-preset` 声明（`- id: preset-<id>` + `config.{id,name,description,order,plugins}`；随部署的 `standard` / `ptc` / `minimal` / `cordis` 是 `@deepseek-ai/dsh-web-app` 的 `presets/*.patch.yml`）；UI 上是新会话页的模式 chip（`conversation.hero.agentPreset`）。它只能在**空白会话**上选/切（已产出内容的会话由网关返回 `agent-preset-locked`）。

**声明只能由 bundle patch 携带，且旧的目录 roster 已死**：DSH 早先按 `$DSH_HOME/.agent-presets/<id>/{preset.yml,agent.cordis.yml}` 自动发现用户 preset，现在**任何代码都不再读那个目录**（0.1.7-rc.1 实测：整个安装树里除了 `dsh-agent-preset` 的迁移文档外没有任何读取方）。所以 dsh-ntr 自己就是 profile bundle（`dsh.bundle.patch`），ACP 模式的声明就写在它的 `presets/acp/acp.patch.yml` 里——模式 chip 因此随插件包本身出现，没有任何复制/安装步骤。旧目录里残留的副本无害（没人读），可以删。

分工是硬边界：preset 拥有 **agent 平面**（工具注册、prompt 段、plan mode、compaction、`agent-instructions` / skill 目录这类注入行），而 **host 平面**（loop 本身、各 registry、sandbox/approval、persistence、model route）preset 拿不到。**loop 不可替换**：创建 agent 只有一个 factory（`ctx.agents.setFactory`，由 `dsh-agent-loop` 注册），所以"ACP 模式"不能把 DSH 从驱动位置上摘掉。

它**能**做的是把宿主对模型可见的贡献清零，`presets/acp/acp.patch.yml` 的声明就干这个：

- `@deepseek-ai/dsh-persona` 行：`prefix`（persona 前缀段的文本，**旧名 `text` 已失效**——schema 是 `prefix: string` 必填 + `suffix?` + 两个开关，写错键会让整个 preset 在会话创建时报 `invalid config: $.prefix missing required value`；省略 `suffix` 是故意的，缺席即遮蔽部署 suffix）+ `complete: true`（压制 harness 身份段与部署 persona）+ `includeRuntimeContext: false`（不再组装运行上下文快照）；
- 不挂任何 `tool-*` 行 → 工具目录为空（对端 agent 的工具在它自己进程里）；
- 不挂 `agent-instructions` / `tool-skill` / `skill-filesystem` → 没有 AGENTS.md 摘要，也没有 `<available_skills>` 大块；
- 不挂 `plan-mode` / `tool-todo` / `tool-goal` / `compaction-basic` / `command-compact` / 委派行 → 这些原生状态机与辅助调用不再作用于该会话；
- `acp-guard.mjs` 行：`agent/pre-step` 兜底过滤（`agent-instructions` / `skill-catalog` / 一切 `plugin` 来源），保证后来新增的行或 host 平面的注入也不会悄悄回到模型视野。该行以**包名**引用（`dsh-ntr/acp-guard`，由 package.json 的 `exports` 映射到 `presets/acp/acp-guard.mjs`）：声明里的插件名是按**声明者 Loader 的解析基准**（profile 目录）解析的，`./acp-guard.mjs` 这种相对路径会落到 profile 目录里一个不存在的文件上。

安装：**没有安装步骤**——声明是插件包自己的 bundle patch，模式 chip 随包出现。只有「声明到了 roster 但激活失败」才需要人看：设置页那张卡读宿主 roster（`ctx.agentPresets` 的 `list()`，缺席即隐藏）并原样显示宿主的诊断。`preset/status` 只读，没有 `preset/install`：往那个没人读的旧目录里复制文件曾经让 UI 显示"已安装"而模式 chip 依然不见。

## 3. 权限：ACP 模式下 Access mode 不替 agent 裁决，agent 自己的模式说了算

`decidePermission(policy, kind, paths, { narrateOnly: true })` 是 ACP 模式下的裁决：

- `danger-full-access` → 本地放行（用户已选择完全权限，再问是噪音）；
- 读类 kind（`read` / `search` / `think` / `fetch` / `switch_mode`）→ 放行；
- 其余（写类与效果未知的调用）→ `ask`，即把 agent 自己的这次询问原样交给人类（composer 审批卡）。宿主不再用边界算术替 agent 决定"这次要不要问人"；
- 例外：`approval: 'never'` 时宿主**没有**可问的人（`ApprovalService.decide` 在 answerer 之前就把每个 ask 判成 `'rejected'`），所以本地 `reject` 才是诚实的答案。

**保留 fs 写栅栏**：`fs/write_text_file` 仍走 `authorizeWrite`（工作区根白名单 + `allowedCwdRoots`），这是本插件对 ACP 子进程**唯一真实的作用力**——DSH 的文件沙箱对另一个进程里的工具没有约束力。

**不叙述边界**：转发给 agent 的 prompt 严格等于用户文本，一句边界/策略句子都不拼（早期版本有 `policyNotice` 前缀，已移除）。agent 只在真的撞上东西时才知道边界：写回被拒会读到 `acp: fs write refused: [sandbox: file access denied under <mode> mode] …`，需要许可时会看到审批卡。好处是 agent 的上下文里再没有任何宿主词汇，代价是越界尝试会在撞墙前发生一次。

判定"这是不是 ACP 会话"读的是**会话日志里的 preset id**（`sessionAgentPreset`，镜像 `dsh-agent-presets` 的 `resolveSessionPreset`：最新 `agent-preset/selected` 事件优先，否则创建 header），而不是我们自己打的标记——后者可能与 roster 实际挂载的组装漂移。

## 4. 对话内的 ACP 面：三块芯片 + 一个视图 tab

模式选完之后，真正的日常界面在对话里。三块座位，全部是「宿主事实源的投影」，不是第二套状态：

| 座位 | 文件 | 干什么 |
| --- | --- | --- |
| `conversation.input.left` | `src/client/session-controls.tsx` 的 `AcpSessionControls` | `ACP · <agent>` / 模型 / 思考等级 三块芯片（只有该会话路由到 `acp` 或曾跑过 ACP agent 时才渲染） |
| `conversation.input.overlay` | 同文件的 `AcpSessionMenu` | 芯片的下拉选择器（浮在 composer 卡片上方，与 `/` 命令菜单同一个锚点） |
| `conversation.input.model` | 同文件的 `AcpModelSeat` | **只有 ACP 模式会话**：`priority: -1` 遮蔽原生模型座位，一个菜单里放下 agent / 它的模型 / 思考等级 / 会话边界 |
| `conversation.view` | `src/client/acp-view.tsx` | **ACP tab**：对端 agent 的真实工具调用 / 计划 / unified diff / 用量 |

**为什么是投影而不是新状态**：一个 ACP agent 在 DSH 里就是一条模型路由 `acp@<agentId>`，而“在哪条路由上”的权威状态在宿主的 per-session 模型目录（`ctx.modelDirectories.directoryFor(sessionId)`）。芯片通过 `directory.select({ provider: 'acp', model, reasoningEffort? })` 写入，所以它和原生模型选择器**共享同一份状态**：在哪边改，另一边立刻就是那个值；不存在“两处显示不一致”。切模型时新 effort 取该 agent 的 `reasoning.defaultEffort`（与原生座位完全同行），切 agent 传裸 `agentId`（= 该 agent 的默认模型）。

**目录的解析要重试，不能 memo 失败**：`ModelDirectoryResolver.directoryFor(sessionId)` 在会话运行期 scope 尚未物化时会 throw（真实实例实测：页面加载后约 0.2s 报 `cannot get property "remote.session" without inject`，命中的正是当台会话），这是与“addressed subagent 会话被设计性拒绝”完全不同的第二种失败。所以 `useDirectory` 经 `resolveDirectory` 有界重试，拿到目录即停——一次性 memo 会让整页 ACP 芯片永久消失。

**但“这个 agent 有哪些模型”不来自那份目录**：那目录是 DSH 自己的全局 provider 目录，而 `acp` 路由在里面**一个模型也不广告**（理由见 §5 的第一条）。座位与芯片的模型面读的是插件自己的 `agent/catalog`：`base`（裸 `agentId` = agent 默认模型）+ `exposedModels` 过滤后的 `agent@choice` 变体 + agent 自己的 `thought_level`（作为 `reasoning`）。这份读是**纯内存**的（未热时只允许后台探针，绝不在渲染路径上 spawn），按 agent 缓存于 `AcpStore.seatCatalogs`，并在探测或勾选变动后失效重读。

**会话边界（Access mode）放在 ACP 芯片的菜单里**，而不是并排再放一个下拉：原生 Access mode 就在同一条工具行上，并排再摆一个只会被读成重复控件。菜单里那一栏叫「会话边界（DSH Access mode）」，数据来自 `permissions` 投影，切换走 `SessionFace.command('/permission <preset>')`（宿主自己的命令，插件不实现开关），旁注写明它规定的是宿主给我们这道闸门的边界。

**为什么工具卡必须另开一个视图 tab**：LLM adapter 的 chunk 词表只有 `text` / `reasoning`，所以对端 agent 的工具调用进入原生聊天时只能是 `> 🛠️ [Tool: …]` 这样的散文行，diff 只剩文件名。ACP tab 读的是同一份 durable transcript（经 `session/chat-transcript`，按 **DSH 聊天会话 id** 寻址——浏览器在看到返回值前并不知道 ACP 会话 id），于是：

- 工具卡按 `kind`（read / edit / execute / search / fetch / think / switch_mode …）给图标，`status` 给色调，输出折叠（默认 12 行）；
- `content: [{ type: 'diff' }]` 被 `foldUpdate` 单独抽成结构化字段（不是压成 `diff <path>` 字符串），渲染为真 unified diff：先剪公共前后缀，再对中间段做 LCS 对齐（超过 300 行退化为“全删全加”），带 `+N -M` 统计；
- 计划是一张勾选表（`✓ / ▸ / ○`），思考是折叠块，消息是左右气泡（含围栏代码与行内 code/bold）。

流式更新不需要轮询：store 把 SSE 的 `session/update` 直接折进被观察的 transcript（`chatTranscripts`，上限 `MAX_WATCHED` 条，最旧的淘汰），`session/reset`（resume 重放）会同时清空块与 seq 水位，`session/closed` 直接丢弃——**已关闭的会话不提供幽灵历史**。视图本身只读，没有任何 prompt/cancel/spawn 能力；它唯一的动词是空态里的「由 X 接管」，那是一次与芯片等价的 `directory.select` 写入。

**默认 Agent（★）与三次路由写入**：ACP 模式会话需要一个初始路由，而这个路由**不能**是 DSH 的全局默认模型（见 §5 的第一条），所以插件自己存一个默认 agent（`~/.dsh/acp-agents.json` 的 `defaultAgentId`，RPC `model/get-default` / `model/set-default`，设置页 agent 卡的 ★ 按钮；删除该 agent 时指针一并清空，读作“没有默认 agent”）。三处写入 ACP 路由的地方（芯片菜单、ACP tab 的「由 X 接管」、座位 gate 对新会话的自动路由）全部经 `selectAcpRoute`：**先读**该会话写入前的路由，写入，再把它交给宿主的守卫（`model/reconcile-default`）——守卫需要“之前是什么”才能精确回滚，而不是靠猜。gate 只对**还没有自己的路由选择**的会话自动路由（读 `modelSelection` 投影的 `lastUsed`/`next`；投影读不到就不动，用户自己选过的路由也不动），且每条会话只尝试一次（`routeSettled`），写失败就交给座位菜单。

## 5. 已知边界（做不到的事）

- **宿主侧仍然不能按会话过滤目录**：目录构建（`buildModelCatalog(ctx)`）是全量遍历 `ctx.llm.listProviders()`，且**不接 session id**（只用来找 agent 的是它的调用方），没有 per-session 过滤 seam。所以“在宿主目录里少列几个 provider”做不到——但“不必过滤”却可以：**ACP 模型压根不进那份目录**，详见下条。
- **ACP 模型的结构性隔离 = 什么都不广告**：`AcpLlmAdapter.listModels('acp')` 返回空数组。目录是按**请求**而非按会话构建的，一个 provider 只要广告模型就等于对每一条会话广告（包括没有 ACP agent 在背后的）；而 `LlmAdapter.listModels` 的契约本身写明目录是 **advisory**——“an adapter may accept unlisted model ids, and consumers must not turn absence into request rejection”——路由可用性由**注册**判定（`routeServed` 读 `listProviders()`），所以 `acp@agent` 与 `acp@agent@choice` 照样解析、选择、流式，只是永远不出现在任何会话的模型选择器或 `/model` 弹窗里。ACP 模型于是只存在于本插件自己的座位（`agent/catalog`），这才是双向隔离：非 ACP 会话看不到 ACP 模型，ACP 会话看不到别的 provider。
- **另一半靠座位遮蔽（浏览器侧）**：`conversation.input.model` 虽是 single 槽，却**按 `priority` 遮蔽**（同一 cell 上最低 priority 的活跃条目渲染，同 priority 重复注册才 throw）。于是 `AcpModelSeat` 以 `priority: -1` 顶掉 `ui-model-selection` 的原生 `ModelSelect`，而注册是**动态的**：只有当客户端 session list 的当前会话 `agentPreset === 'acp'` 时才挂上，切走即 dispose 让原生回来（判定见 `shouldShadowModelSeat`）。ACP 预设会话里剩下的那几个非 ACP 模型没有工具、也不是在说话，这一档遮蔽就是挡它们的。
- **遮蔽的失败模式必须是“不接管”**：任何一环读不到（`sessions` 服务未就位、没有 `modelDirectories`、槽位未声明、注册被拒、当前是 addressed subagent 路由）都保持原生座位；座位自己的渲染崩了，靠 `slots.onEntryError` 的 abdicate 把座位与会话芯片一起交还，并且本次页面生命周期内不再重试（`seatBroken`）。同一个 gate 顺带把左侧三块芯片在 ACP 模式会话里收起——两套同样的控件并排只会被读成重复。
- **动态插件运行时会改写 priority，遮蔽要靠「显式压 rank」保住**（实测 `dsh-cordis-client-runner` 的 `guardedSlots`）：动态包传给 `slots.register` 的 `priority` 若撞上它的自动分配（每包一个 auto rank，实测为 `-1`），语义会被静默改写；而别的动态座位插件（如 `dsh-thinking-effort` 的模型 slider）同样占这个 cell，实测出现过「我们的条目已注册、cell head 却是对方」的僵局。两条实测纪律：**（1）退了重注册没用**——runner 的 load 收敛会把同 rank 的新贡献整个吞掉（复现：cell 里只剩对方一条）；**（2）exact-priority 重复注册会 throw**（`already has a registration at priority -1 (registered by dsh-ntr-client)`）。所以 `ensureSeatWins` 在注册后读渲染器自己的 winner 视图（`entriesOfSlot`），发现 head 不是自己时**另注册一条显式更低 rank（`min(head-1, -100)`）**的条目（独立组件身份，防 dedup 合并），一次压过即赢；上限 4 次，stack 由 `dropSeat` 在 gate 退场时整体回收。
- **遮蔽的闸门有两个事实源，行缺失时回落宿主上报**：主事实源是客户端 session list 的会话行（`byId[current].agentPreset`，由 `agent-preset/selected` 帧折叠而来），而这个字段是较新的客户端运行时才有的——实测 DSH 0.1.5-rc.2 的 `api-session-controller` 里**根本没有**它（48 条会话行逐条为 `undefined`）。行没有携带 preset 时，闸门回落到本插件宿主半区的只读上报：`session/chat-list` 响应里的 `acpMode`，浏览器半区对每条会话只问一次（`acpModeAsked` 防止无上报的宿主把每次 store 变动变成新 RPC），`agent-preset/selected` 帧会作废缓存并重问；宿主上报为假时仍读作“不接管”，失败模式不变。
- **宿主上报自己是三级事实源，冷会话必须落盘冷读**（实测教训：`ctx.sessions.get()` 对**冷会话**（上一轮属于上一个宿主进程）返回的是**事件为空的占位 stub**，空日志折叠出默认 preset `standard`——一次同步的「拿到了会话」其实是「拿到了空会话还信了它」，把真 ACP 会话判成 standard 并缓存，冷读路径永远不执行）。所以 `setAcpModeResolver`（`src/index.ts` 的 `wireAcpMode`）的裁决顺序是：① 活会话且**日志有行**（`session.events.length > 0`）→ `sessionAgentPreset` 同步作答；② 否则 `sessionPersistence.open(id, 'read')` 只读打开持久化日志，`sessionAgentPresetFromLog` 折叠 header + 尾部 `agent-preset/selected`（read handle 不抢所有权，上限 `COLD_READ_MAX_EVENTS`）；③ 服务缺失/读失败 → `undefined`（读作不接管，绝不把查不到当「确定不是」）。RPC 应答走 `chatSessionAcpModeAnswer`（bridge.ts）：**await** 冷读落地后一次性给出权威判定 + in-flight 去重 + per-session 缓存——第一版同步应答在冷读 in-flight 时回了 `false`，浏览器 one-shot 回落把 false 记住，座位永不接管（实测复现过）；缓存在每轮 prompt 前作废（`invalidateAcpMode`，日志可能动了），resolver 抖动不能翻转已确认的事实。
- **`/model` 命令弹窗遮蔽不了**：它是 `ui-model-selection` 的命令贡献，不是槽位，所以仍能切走路由。座位因此会以告警色提示“跑的是 ACP 预设但这模型不是 ACP agent”，菜单里的 agent 一节就是一键切回。
- **不能替换原生 Access mode 下拉**：它不是 slot（由 `ui-conversation` 的 InputBar 直接渲染 `PermissionSelect`），数据来自被 `dsh-permission-presets` 独占注册的 `permissions` 投影。可以读、可以用 `/permission <preset>` 切，不能改它的项。
- **原生聊天里永远只有文字**：这不再是缺口而是分工——ACP tab 承载工具卡/计划/diff，原生聊天承载对话本身。想让工具卡长在对话流里，需要 LLM adapter 的 chunk 词表扩到 `tool-call`（那是 DSH 侧改动）。
- **模式只能在空白会话选**：想中途切换到 ACP 模式（preset）需要新建会话；但**路由**可以随时切：在任意会话选 `acp@<agent>`（芯片或原生选择器），从下一条消息开始由 ACP agent 服务。历史上下文不会追送（只转发人说的话），所以中途接管是“从这里开始由它接手”。
- **芯片不出现于普通会话**：从没路由到 ACP 的会话不渲染任何 ACP 芯片（工具行保持干净）；入口是 ACP tab 空态里的「由 X 接管」。
- **部署默认模型绝不落在 ACP 路由上**：DSH 的 `session.selectModel` 对每一次选择写两份——会话自己的持久路由**和**全局默认模型（`agentDefaultModel.saveSelection`），后者不分会话、不分模式。所以任何一次 ACP 选择都会让**所有模式的新会话**从对端 agent 起步（对端 agent 收到的是宿主的工具 schema，正是本设计要挡住的事）。守卫 `AcpDefaultModelGuard` 记住最后一个**原生**默认并在默认变成 `acp` 时改回它：候选顺序是「该会话写入前的原生路由（浏览器 `selectAcpRoute` 递过来的 `previous`）→ 已知原生默认 → 本部署 live 会话里最近的原生路由（`lastNativeRoute`，即这个部署实际在跑的东西）」，一个都没有时**保持原值**并入实报 `stranded: true`（错的值比陈旧的值更坏），下一次原生选择会同时治好它并教会守卫。守卫在每轮 prompt 前与宿主启动时各复查一次，服务缺失（没有 `agentDefaultModel`）就是纯惰性——没有服务也就不存在这份全局写入。守卫自己的单测在 `tests/impl.spec.ts` 的 `AcpDefaultModelGuard` / `lastNativeRoute` 套件，接线在 `tests/bridge.spec.ts` 的 `deployment default model guard` 套件。
- **一个 ACP 轮次的“结束”由对端 agent 决定，宿主不替它收尾**：`turn/end` 只在 `session/prompt` 的**响应**返回时发出，不在最后一个 chunk 到达时——所以“已经不再吐字了但仍显示正在输出”这段时间属于 agent 自己的内部节奏。实测（codebuddy，首轮）：它要先完成自己的标题生成才回应 prompt，期间一个通知都不发（它自己的日志：`Timed out waiting for pending title generation … timeoutMs=5000`），于是首轮的可视收尾被推迟约 5s。这是**记录在案的边界，不是待修 bug**：宿主无法区分“agent 正在想”与“agent 在磨蹭”，任何强制定稿（提前发 `turn/end`）都会把真实答案切在流中间；能提前给出响应的只有 agent 自己。唯一已有的强制定稿兜底是 `session/cancel` 之后的 `cancelFallbackMs`（见 `armCancelFallback`）——那是用户已经叫停的场合，与这里的语义完全不同，不得复用。
- **codec 是手拷贝**：`splitAcpModelId`（浏览器）与 `splitAdapterModelId`（宿主）必须同步，由 `tests/acp-view.spec.ts` 的等价断言看住。
