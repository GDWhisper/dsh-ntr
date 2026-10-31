# 浏览器半区：座位、芯片与视图

本文是 [AGENTS.md](../AGENTS.md) 的展开层，覆盖 `src/client/` 的接线纪律。
浏览器半区**严禁**引入 Node 内置模块或 `@agentclientprotocol/sdk`，通信只走 RPC / SSE。

## 1. 模型底座：占座与闸门

NTR 底座（`conversation.input.model`，`AcpSessionControls`）**只作首轮前启动 / 切换 agent 的入口**：下拉里只有智能体列表（`menuFor('agent')` 只返回 `agentSection`），模型 / 思考等级 / agent 模式各有自己的控件。菜单只有一个标题「选择你的 Agent」。

- **位置**：底座占的是原生模型底座那个 `single` cell——composer bar 行尾（`.trailing` 组，`margin-left: auto`）、提交键左边。原生 occupant 是宿主 `client-ui-model-selection` 的 `ModelSelect`（列 DSH 全量 provider，点一下写全局默认模型），所以 NTR 会话里必须由我们接管。
- **一个 cell、一个 occupant**。cluster 内顺序固定 `高级 → model → thought → agent`：首轮前 agent 底座是右端锚点（它也是 `:last-child`，CSS `flex: none`，长模型名或额外 chip 只能挤压它左边的内容，**严禁**把 agent 底座排在前面——实测会被挤到看不见）；首轮锁定、底座退场后，`thought`（没有时 `model`）成为右端锚点。高级底座始终紧贴模型左侧。
- **隔离靠闸门，不靠组件自隐**：`src/client/index.tsx` 的 `syncAcpMode` 只在舞台会话跑 ACP preset 时创建 claim，切走即 `release()`。非 NTR 会话里这条 entry 根本不存在。舞台会话取宿主当前选择（`uiSession.adapter.current` 的 key）优先，列表 `retainedBy.mainView` 只是没有 scope adapter 时的兜底——多视图残留两行时按第一个行会判错会话。
- **claim 机制**（`src/client/model-seat.tsx` · `createModelSeatClaim`）：
  - cell 归属由客户端 runner 的页面级递减计数器决定（非 chain 槽位的声明优先级被改写，最后一个注册者赢）。`@hytime/dsh-thinking-effort` 也往这个 cell 注 slider，且排在我们之后注册。
  - claim 必须用 `entriesOfSlot` 核实 head 是不是自己，不是就再注册一次（有界 `MAX_SEAT_CLAIMS`、如实报「被谁占着 / 放弃」），触发来自 gate 评估与 `slots/changed`。
  - 注册经 `ctx.slots.inject`（裸 `register` 对未声明 slot 会 throw，而 gate 跑在每次 store 变更上）。
  - **严禁**带回 undercut rank 算术、退注册重注册、`abdicate` 恢复 / `seatBroken`。也**不要**把「组件里 `return null` 就是隔离」当结论——那是修过的真实缺陷。
  - 旧的 `AcpModelSeat` / `AcpModelSeatShadow` / `shouldShadowModelSeat` / `ensureSeatWins` / `seatBroken` 均已删除，不要带回来。详见 [retired.md](./retired.md)。

## 2. 底座退场与挂牌

首轮**开始**时（ACP 会话 materialize、`chat/agent-locked` 广播）锁定 agent，agent chip 从 cluster 消失，粉碎 → 挂牌动效同时开始。锁定语义见 [architecture.md §7](./architecture.md)。

- 判定走 `lockedAgentOf`（宿主 `lockedAgentId` → 活/挂起 ACP 会话）与 `agentBaseHidden`，不拿插件默认 agent 兜底，也不查 roster。首轮之前底座一直在，用户可以先选好再改。
- **空 roster 也保留底座**：`agents` 为空且宿主已经答过 `agents/list`（`ui.agentsLoaded`）时，底座照常渲染成「选择 Agent」（tooltip 改说「前往 NTR 设置添加」，不再承诺一个菜单给不出的选择），菜单里第一行是不可点的「还没有配置 NTR agent」，第二行是动作「打开 NTR 设置」（`OPEN_SETTINGS_ITEM`）。动作打开插件自己的 NTR 设置对话框（`settings-dialog.tsx` · `AcpSettingsDialog`，挂在根级 `shell.overlay`），里面挂的是与设置外壳同一个 `AcpSettingsSection`。宿主设置外壳**没有**从对话面编程打开的接缝：`settings.launcher` 是 account 菜单占用的 single 座，`openSection` 只发给 `settings.onboarding`，所以不要假装能驱动外壳模态。`agentsLoaded` 之前（宿主尚未回答）底座不渲染——那时的 `agents: []` 表示「还没读到」，不是「没配置」。→ 见 §8。
- 退场后当前 agent 由 `conversation.input.overlay` 的挂牌 `AcpComposerAgentTag` 显示（`NTR · <agent>`，样式 `.ntr-acp-tag`）：骑在 composer 卡片上边缘，一半在卡片外、一半压在上边框（overlay anchor `top: 0` + `translateY(-50%)`）。
- 挂牌**只读**（`AcpChip` 无 `onClick` 时渲染静态 `span`、无 caret），换 agent 只能新建会话。
- 挂牌自带闸门 `agentTagVisible`：显式 `acpMode === false` 压过残留 `chatSessions`，`undefined` 才回落到锁本身。
- **存活光晕**：挂牌判定 `agentTagAlive(bound, lockedTo)`——会话视图存在、未 released、且属于被挂牌的 agent——为真时按设置页「对话外观 → 挂牌光晕」的选择展示：`breath`（蓝色呼吸光晕，慢速 5.2s / 正常 3.2s / 快速 1.2s，经挂牌 span 上的 `--ntr-halo-period` 变量下发，映射在 `TAG_HALO_PERIODS` / `agentTagHaloPresentation`）或 `steady`（恒定光，无动画）。reduced-motion 下都退化为静态光。偏好持久化在 `agents.json` 的 `tagHalo` 键，经 `ui/tag-halo` / `ui/tag-halo-set` 读写；store 写入先行（乐观），失败回退。耦合不变量：`session/released` / `session/closed` 事件必须同步翻转 / 删除 store 的 `chatSessions` 行（composer 自己的清单），`session/reset`（resume）必须把同一行翻回 live（`withSessionReleased`）——否则挂牌对着已释放进程一直呼吸、释放横幅对着已恢复的进程赖着不走；没有别的路径会替 composer 重读这份清单。
- **动效**：底座立即播放 460ms 粉碎（`.ntr-acp-shatter` + `AcpShatterParts` 的 `out` 沙粒），随后挂牌以 540ms 凝聚（`.ntr-acp-tag.is-forming` + `in` 沙粒）。
  - 两半在**不同的 slot**（`conversation.input.model` / `conversation.input.overlay`），所以共读 `agent-lock-anim.ts` 的同一相位钟，**严禁**各自计时。
  - **不在轮次结束时播**：事件就是开始信号。首轮无输出被回滚（`chat/agent-unlocked`）时底座直接回来，不播反向动效。
  - 只在本页经历过的锁定上播放：`AcpStore.agentLockReveal` 在 `chat/agent-locked` 帧到达时（或非首次 `session/chat-list` 回答首次报出 `lockedAgentId` 的兜底路径）递增。打开一条早已锁定的会话不播。`chatUnlocked` 集合挡住「回滚前发出、回滚后才落地」的读，防止把锁复活。
  - 重试成功会得到新的 reveal serial，`agent-lock-anim.ts` 用 epoch 让旧 ceremony 的定时器失效。`agentLockPhaseOf` 对「有新 reveal 但动画尚未启动」直接返回 `shatter`，避免中间一帧「两处都没有」。`prefers-reduced-motion` 下整段跳过。
- 首轮开始前已打开的 picker 必须 `closeAcpMenu`，否则会留下一个点击必然 `agent_locked` 的活控件。

## 3. 各轴的来源

`AcpSessionControls` **严禁**自建 agent/model/effort/config 状态，也**严禁**读 DSH 模型目录或写任何 DSH 模型路由。

| 轴 | 权威来源 | 写入 |
|---|---|---|
| 这条会话由哪个 agent 服务 | 插件自己的绑定：`describeRoute` / `routeAgentId`（活会话 `bound` 优先 → `chatChoice` 的 pick，且只在 `choice.agentId === agentId` 时生效 → `chatBoundAgent` 乐观读 → 插件默认 agent） | `bindChatAgent`（传裸 `agentId`） |
| 这个 agent 有哪些模型 / 思考等级 | `agent/catalog`（`AcpStore.loadAgentCatalog`，只对 `routeAgentId` 有答案的会话读，**含插件默认 agent**；宿主纯内存，不探测） | — |
| 当前在哪个模型 / 思考等级 | `bound?.modelId ?? pick?.modelId`；`bound?.reasoningEffort ?? pick?.effort`（released 行反过来：pick 优先，见下）；没选过时回落 `catalog.currentModel` 与 `catalog.reasoning.defaultEffort` | `setChatSessionModel` / `setChatSessionEffort` |
| agent 的额外 config options | `agent/catalog` 的 `extras`（model / thought_level / mode 之外的 select 与 boolean，含未知 category） | `setChatSessionConfig`（`session/chat-config-set`），落 `AcpConversationChoice.extraConfigs`（select 存字符串，boolean 存真布尔） |

- **released 会话上四轴只记录、不唤醒**（用户决策 2026-10-30）：mode / model / effort / config 对挂起的会话只写 `chatChoice`，由 `applyChatChoice` 在下一次恢复（下一条消息或横幅的「恢复进程」）时统一应用；进程只在「发消息」或「点恢复按钮」时回来。显示优先级因此分两态：**live 会话 > pick**（live 是正在跑的事实），**pick > released 行的旧值**（released 行只描述挂起前跑过什么，pick 才是恢复时会生效的东西；没有 pick 时 released 行仍兜底）——不对调，提前切换看起来就像死控件（芯片一重读就弹回旧值）。实现两处：`describeRoute`（model / effort）与 `modeInForce`（mode）。
- **默认 agent 也算 routed**：新会话没有绑定 / pick 时，`routeAgentId` 回落到插件默认 agent；它和手动选中的 agent 一样展示 model / 思考 / 高级 chip，并读取该 agent 的 catalog（纯内存）。**严禁**要求用户先手动点一次 agent 才出现这些控件。
- **显示什么就必须跑什么**：首轮前显示的 catalog 当前值在 `session/new` 前被捕获，并在新会话提供时写成这条会话的 pick（`displayedChatDefaults` / `seedChatChoiceFromCatalog`，见 [state.md §3](./state.md)）。否则就是「芯片写 B、agent 跑 A」——新会话的 agent 默认模型与缓存目录不同时必然发生。
- **严禁**回到 `directory.select` / `selectModel`。
- 没有绑定 / pick / 默认 agent 时 `routeAgentId` 返回 `undefined`，`describeRoute` 每条轴都退化成空。芯片**严禁**借 `agents[0]?.id` 填名字（审计 F5：芯片写着某个 agent，却没有任何消息会送到它）。此时 agent chip 由 `agentBaseChip` 渲染成「选择 Agent / Choose agent」入口，tooltip 明说「这条会话当前没有 NTR agent 服务；点开可选择 agent」。
- 会话权限档**插件不提供切换面**（整格占空，见 [permissions.md](./permissions.md)）。

### 3.1 模型 picker 一行一个模型

`agent/catalog` 的 `base` 是**路由**（裸 `agentId` = 「让 agent 自己选」），`currentModel` 是**模型值**（`model.currentValue`）。两者不是一回事：

- 一行一个模型值，裸路由与它的 variant 合并。
- 被勾中的那行必须写出模型名。
- `base.name` 拼成 `<agent> · <当前模型>`；`variants[].name` 只写模型名（picker 已说明是谁的模型，重复是噪音）。
- `resolveAdapterModel` 仍返回 `<agent> · <model>`——那是 DSH 侧的模型身份，与 picker 行无关。
- `exposedModels` 只是**可见性**过滤（不改变可用性）。会话当前所在的变体即使不在列表里，也必须以带「当前」的行列在列表顶部，否则 picker 会默认成「会话跑的是默认模型」。detail 必须同时写两个可能原因：「在设置 → NTR 里取消了勾选」与「已从 agent 的目录掉出」——只怪可见性会让人去找一个早就勾上的框。**被可见性过滤的模型仍可用；已从目录掉出的模型不可用**：宿主会拒绝本轮发送（`model_unavailable`）并保留选择，用户改选后才能继续，因此 detail **严禁**再写「仍然可用」或承诺回落。模型菜单末尾还有一行显式「刷新目录」动作（`REFRESH_CATALOG_ITEM`）：打开菜单不探测，点它才发 `agent/probe-models`，菜单保持打开等新列表 / 错误落地。

### 3.2 codec 手拷贝

`splitAcpModelId`（`src/client/acp-ui.tsx`）是宿主 `splitAdapterModelId` 的手拷贝（浏览器半区不得 import 宿主平面模块，`protocol.ts` 又只能是纯类型）。改其一必须同步另一处，`tests/acp-view.spec.ts` 用同一样本集做等价断言。`isAbsolutePathLike` 与宿主 `isAbsolutePath` 同理（见 [paths.md](./paths.md)）。

### 3.3 高级底座

- 只有 agent 发布了主位之外的配置项（select 且有 choices，或 boolean 开关）才渲染，位置在**模型 chip 左侧**；chip 文案 `高级 · <N>`，菜单里每个配置项一节。
- **boolean 渲染为一行复选框**：section 不带 title（行标签就是选项名），单个 item 的 `active` 是当前值、`checkbox: true` 让它按 `menuitemcheckbox` 渲染，`id` 是点击后要写入的**相反**值（`'true'` / `'false'`）。布尔项永远不进 `thought` / `model` / `mode` 槽位——那些控件是在 choices 里挑一个，空 choices 只会让控件消失（`parseCatalogOptions` 把 boolean 一律放进 `extras` 并带 `kind: 'boolean'`）。
- section id 必须带 `config:` 前缀（`config:<configId>`）：picker 把 section id 原样交给 pick 处理器，而 `agent` / `model` / `thought` 已被三条主位占用。agent 完全可以把某个额外项命名为 `model`。
- 当前值 = `choice.extraConfigs[configId]` ?? `catalog.extras[].currentValue`；`choice.agentId` 与 catalog 的 agent 不一致时**严禁**套用（那是上一个 agent 的词汇，`advancedOptions` 负责过滤）。
- 写入经 `setChatSessionConfig`：宿主先用活会话的 `configOptions`（更权威）再回落 catalog 校验值是否真由 agent 发布；boolean 额外接受复选框送来的 `'true'` / `'false'` 字符串并归一为真布尔（`extraConfigs` 里存布尔）。记录进 `extraConfigs` 后，有活会话立即 `set_config_option`，没有会话则等下一次 `applyChatChoice`。失败只广播 `agent/notice`，不失败回合。
- 首轮前没有会话也能选——这正是 extras 要进 `agent/catalog` 缓存、而不是只读 live session 的原因。

## 4. agent mode 控件

注册在 `conversation.input.left`（`src/client/composer-mode.tsx`），调用 agent 自己的 `session/set_mode`。

- **不写可见标签**：agent 下发的 mode 名自解释（omp `Default`/`Plan`，codebuddy `Always Ask`/`Accept Edits`/…）。解释留在 `title` 与 `aria-label`（可访问性不能删）。
- **选项不依赖活会话**：先取活会话的 `modes`，没有时回落 `agent/catalog` 的 `mode`（探测来的 `category: 'mode'` select，与 `session/new` 同源）。
- **控件是否出现由「agent 发布了什么轴」决定，不能由「用户点过什么」决定**。`describeRoute` 让 `modelLabel` 只在有 pick 时才有值是真实回归：只点过思考等级的会话整块模型 chip 消失。配套：`agentCatalog` 必须同时回 `currentModel` 与 `mode`。
- **自带 ACP 闸门**（`agentModeVisible`：显式 `ui.acpMode === false` 压过残留活会话行，`undefined` 时活会话才算证据；且 `!isAcp` 时整个控件 `return null`，残留活会话的 `availableModes` **不放行**）：它在 `conversation.input.left`，不在 `syncAcpMode` 的 claim 生命周期里，而 `agentId` 会回落到插件默认 `defaultAgent`，不闸就是普通会话凭空多一个 ACP 控件。
- `setChatSessionMode` 对没有活会话**或已释放**的会话只记录 pick、不 spawn（与 `setChatSessionModel` 一致；2026-10-30 起 released 不再先 resume，见 §3「只记录、不唤醒」），`applyChatChoice` 在建 / 恢复会话时再应用。
- 该 series 的公开 `.d.ts` 里 slot 条目**不含 `owner` 字段**（`OwnerOf` 解析为 `object`），所以组件里声明结构类型（`ComposerModeProps`），注册处 `as unknown as SlotComponent<any>`；新增 client 模块依赖要加进 package.json 的 `dsh.client.inject`。

### 4.1 composer 上下文占用环（`conversation.composer.dock`）
`src/client/context-meter.tsx` 在输入框下方的底部信息栏（宿主原生 ContextMeter 所在的同一行），只报 agent `usage_update` 的 `used/size`。
- **不由插件常驻注册**：该座位是 `list` 槽，宿主会把每个条目渲染进每条会话的底行；组件里 `return null` 挡不住条目本身。它和 NTR 视图 tab 一样由 `syncAcpMode` 的 `holdAuxEntries` 只在确认 ACP 时注册，`standDown` / 卸载即释放——非 NTR 会话里这条 entry 不存在，底行只留宿主原生 ContextMeter。
- **不复用原生环**：宿主 `ContextMeter` 读 `contextPressure` / `contextBreakdown`，ACP 请求不产生这两类事件；**严禁**为点亮它把 `used` 塞进 `inputTokens`（约束 36 / issue #6）。
- **数据源、闸门与重读**：`session/chat-list` 的 `ChatSessionView.usage`，SSE `usage_update` 实时补写 `chatSessions` 与被观察 transcript；`acpMeterUsage` 先判 `acpMode !== false`（显式 false 压过残留行，与挂牌一致），再判 `chatSessionsFor`；verdict `undefined` 时只有 live 行算证据，parked 行必须等明确 `true`（切走 preset 不会关闭 ACP 会话）。无样本 / `size <= 0` 不渲染（不画假 0%），百分比夹到 100；ACP 没有 system / tools / messages 拆分，**严禁**伪造明细，精确数字进 `title`，可见文字只有百分比；环按宿主 14px viewBox / 2px stroke 与 alias token 画。`useSession(s => s.running)` 翻转时 `loadChatSessions`；首轮 `turn/start` 无当前行则补读一次（每会话一次），`resync` 也刷新当前行。

## 5. NTR 视图 tab

真工具卡只能在 `conversation.view` 的 NTR tab（`src/client/acp-view.tsx`）里画。

- **只存在于 NTR 会话**：`conversation.view` 是 `list` 槽，宿主把每个注册条目投进每条会话的页签栏，组件里 `return null` 只能清空内容、清不掉页签。所以该条目由 `syncAcpMode` 的 `holdAuxEntries` 在确认 ACP 时注册，`standDown` / 卸载即释放；非 NTR 会话里根本没有这个页签。组件仍保留显式 `acpMode === false` 的 `return null` 作为撤下前最后一帧的防守。
- 数据必须走 `session/chat-transcript`（按 **DSH 聊天会话 id** 寻址：浏览器在看到返回前并不知道 ACP 会话 id）。
- **严禁**让 LLM adapter 旁路转发工具事件；**严禁**在视图里做 prompt / cancel / spawn（它只读）。
- 流式更新靠 store 把 SSE 的 `session/update` 折进被观察的 transcript（`chatTranscripts` + `MAX_WATCHED` 上限）；**严禁**视图自己轮询。
- **空流文案分两态**（`historyAwaitsReplay`）：released 且 `hasHistory`（恢复自磁盘的记录，历史在 agent 侧等回放）说「历史将在恢复后回放显示」；否则才是「还没有消息」——对一条聊天面里还留着昨天对话的会话说「还没有消息」，正是本文件文案规则要防的自相矛盾。

**空状态有两种含义**：`chatTranscriptOf` 回 `undefined` 同时覆盖「从没被 NTR agent 服务过」与「ACP 会话记录已经没了」（`closeSession` / `forgetDshSession` 销毁记录，进程停掉就丢 bridge），而绑定与 chip 仍指着那个 agent。用一句话描述两种状态会让视图与芯片互相矛盾。

- `boundAgentOf`（活会话 → 宿主 `chatBoundAgent` → 持久 `chatChoice`）先判「这台会话有没有 agent」，`acpEmptyCopy` 再选文案。
- 有绑定时说「这个会话当前没有可显示的 ACP 会话」并提示「给它发一条消息」，hint 写 `绑定的是 · <agent>`；什么都没有时才说「这个会话还没有 NTR agent 参与」。
- hint 只在该控件真的存在时才指：`acpMode === true` 才指输入框右侧的 NTR 底座；`false` 说「这个会话不在 NTR 模式」；宿主还没答（`undefined`）就不给那一行——猜测比不说更坏。

**diff 的「新增文件」脚注**只由**旧侧**判定（`isNewFileDiff`：`oldText` 为 `null` / `''` / 与 `newText` 逐字相同）。**严禁**改用「删除行数为 0」——只加行的既有文件同样零删除，把它标成「新增文件」等于把真实编辑藏在错徽章后面（审计 F8）。

## 6. 斜杠菜单隔离

NTR 会话的 `/` 属于 agent：菜单只列 agent 自己经 `available_commands_update` 声明的命令；Enter 对 `/xxx` **不被宿主认领**（整行原样进 agent）；选中菜单项只把 `/<name> ` 插回草稿，**绝不执行**宿主命令；宿主来源的 `warm` / `lexicon` / `header` 同步停用。非 ACP 会话的斜杠行为一字不变。

**机制**（`src/client/slash-isolation.ts`）：宿主没有受支持的 per-session 接缝——`InputTriggerService.adjudicate` 按注册顺序轮询（`order` 只排菜单）、同 `(trigger,name)` 重复注册直接抛、来源没有 `available(session)`。所以只能**在运行时包装活的来源对象**（`inputTriggers.live.sources` 中 `trigger === '/'` 的项，当前是 `command` 与 `skill`）。

- **严禁**改写上游文件、注册第二个 `/` 来源、改 preset 行来伪装，或替换整个 `conversation.composer`。
- agent 命令清单**只由一个来源承载**（按名字优先 `command`，缺席回落第一个 `/` 来源），其余来源在 ACP 会话里返回空——否则同一份清单每组各画一遍。
- 每次调用按会话判定：舞台行自己的 `agentPreset` 优先，否则用 `session/chat-list` 的 `acpMode`；**没有证据时一律当作非 ACP（fail-open）**。
- `candidates` 每敲一键都会重取，「按需重问宿主」（`ASK_INTERVAL_MS`）与「没有任何命令时补读一次」（`REFRESH_INTERVAL_MS`）都必须节流。数据侧见 [state.md](./state.md) 的「斜杠命令缓存」。
- **失败一律放开**：服务缺失不算故障；服务在但 `live.sources` 形状不认识、或来源没有 `candidates`，就什么都不包、照旧沿用宿主行为，原因写进 `UiState.slashDiag`（ACP 视图空态渲染）与一次 `console.warn`。`dispose` 只还原自己装的包装（跨实例标记 `Symbol.for('dsh-ntr.slash-isolation')` 带 owner）；`sync` 幂等，可在 `internal/service` 与 store 变更时重跑。

## 7. 快照读取与失败放开

- **session list 快照两代形态**：DSH 0.1.7-rc.2 是 `{ ids, byId, phase, projectionsBySession }`——没有 `current` 也没有 `currentAddress`；舞台上会话 = `retainedBy.mainView > 0` 的行，preset 在 `byId[id].projectionValues.agentPreset`，subagent 行以 `origin === 'subagent'` 标记。旧运行时才是 `{ current, currentAddress, byId[id].agentPreset }`。
- 读取一律经 `stagedSessionOf(snapshot, currentSessionId)` / `rowAgentPreset`（`src/client/acp-ui.tsx`），不要再手写 `snapshot.current` / `byId[..].agentPreset`；`currentSessionId` 来自 `uiSession.adapter.current` 的 key，缺失时才回退 mainView 扫描。宿主当前选择没有对应行时**必须** stand down（可能是 subagent 地址），不许拿别的行顶替。
- **新增 ACP 槽位条目前的隔离检查**：非 NTR 会话里这个槽位必须仍由 DSH 原生条目占位；`single` / `keyed` 用 gate claim；会投影进每条会话的 `list` 槽（`conversation.view` / `conversation.composer.dock`）必须由 `syncAcpMode` 动态注册并在 standDown 释放；纯附加事务条目（权限卡 / 释放横幅 / 分支键）自门禁到本会话确有该事务且不得遮蔽原生条目；组件里的 `return null` 只作最后防线。新增这类条目时，`model-seat.spec.ts` 的 gate host 必须同时断言「ACP 时存在、标准时不存在」。
- **失败放开**：服务未就位 / 槽位未声明 / 注册被拒 / 当前是 addressed subagent 路由 / 座位渲染崩溃（slot 错误边界会 abdicate 该条目），都必须回到原生座位并清掉「座位已接管」标志。claim 的 `sync()` 可重跑：下一次求值（store 变更、列表通知、preset 帧、cell 变化）会再试；诊断如实报告每次失败，不假装已安装。唯一允许的失败模式是「不接管」。
- `ACP_PRESET_ID` 三处必须一致：浏览器半区、宿主 `src/bridge.ts`、声明里的 `config.id`（`presets/acp/acp.patch.yml`）。
- **可选宿主服务严禁写进 `inject`**（缺服务会让插件整体加载失败；顶层 `inject` 只有 `slots` + `connection`）。只能经 `service<T>(name)` 在调用点 `ctx.get` 惰性解析（缺服务返 `undefined`、服务后到也能拿到），解析包 try/catch（见 `faceFor`）。
- **结构类型只许写框架真的递过来的成员**：session 作用域入口能拿到 `sessionId` + `use<Name>` 选择器钩子（`useSession` / `useConversation` / `useInput` / `useWorkspaces` / `useChat` / `useProjection`）+ `inputActions` + 自己的 owner share（`conversation.input.model` 的 `locked`）。`conversation.input.left` 的 owner share 是**空对象**，严禁声明 / 读取任何别的字段——曾写 `session.sessionId` 让整条 entry 崩掉并被 abdicate；可选链泄漏进 `props.session?.running` 更阴：不炸，但重读永远不触发。需要「会话是否在跑」只能 `useSession(s => s.running)`（`AcpSessionHook`）。

## 8. 设置页

- **同一个设置页有两个入口**：宿主设置外壳里的 `settings.section`（`AcpSettingsSection`），以及对话内底座空 roster 菜单打开的 `AcpSettingsDialog`（`shell.overlay`）。两处挂的是同一个组件，配置逻辑只有一份；对话框不做第二套表单。宿主外壳的打开状态归它自己，插件无法从对话面驱动（见 §2）。
- 模型区（`ModelCatalogBlock`）**常驻渲染**，严禁挂在探测结果上：右侧「已选模型」来自 agent 配置的 `exposedModels`，左侧「全部模型」来自宿主目录缓存（`agent/cached-models`，纯内存、不 spawn，见 [state.md §4](./state.md)），所以打开卡片就能看到已配置的东西。`检测可用模型` 只是**左侧列表的刷新**（新增的加进来、下架的去出去），与搜索框同放在模型区自己的工具栏里（不在区块顶部），点击后在标题行回报「新增 N · 移除 M / 目录无变化」。空目录时左侧给引导文案（未读取 / 该 Agent 未暴露 `category: model`），而不是隐藏整块。模型行**直接展示** `description`（如 agent 给出的积分消耗 `x0.29 credits`），严禁只放进 `title` 靠 hover 才能看到；分组兜底 description 与 `group` 相同时不重复展示。空间不足时名称与 credit 优先保留，模型 id 是唯一可收缩的格子：右缘渐隐（mask）而不是硬省略号，hover 时由 `armModelIdMarquee` 实测溢出量并滚动展示全文，`title` 仍保留完整值（reduced-motion 的兜底）。「全部模型」与「已选模型」两块列表**上下堆叠**，不再左右分栏——半宽面板会把名称 / id / credit 同时挤掉。两块面板各自带收纳按钮（`▾` / `▸`，`aria-expanded`）：只隐藏列表本体、保留标题与计数，列表继续挂载以保住滚动位置。
- 每张 agent 卡保持「紧凑行 + 展开详情」两段，详情体**常挂载**、只用 `display: none` 折叠——条件渲染会重挂载表单 `useState`，丢掉用户编辑中的值。缓存读按 `active`（展开态）触发，折叠的卡片不发请求。
- 设置采用原生分区：页头 → 跨分区审批镜像 / **仅设置页自身动作失败的横幅** / 模式异常提示 →「智能体 / 审批时限 / 进程管理 / 对话外观 / 日志」导航 → 当前分区 → 页脚连接状态与「查看诊断」。正常模式横幅、预设来源和「重新检测与刷新」收进诊断；模式异常不允许只藏在诊断里。没有审批时限 RPC 时不显示该导航项；没有空闲释放 RPC 时同样不显示「进程管理」。智能体未读取与已确认空列表分开呈现；「添加智能体」由按钮进入，首次点击才挂载表单，保存成功返回列表。分区、行内「模型 / 连接 / 高级」切换均只隐藏内容、保留编辑状态；模型缓存只在当前可见的模型面读取，不在隐藏分区读取，更不得自动探测。文案里点名的控件名必须与可见标题一致：store 的 `detectSummary` 与空态提示都指向「添加智能体」，改名要三处同步（`store.ts` / `panel.tsx` / `tests/store.spec.ts`）。
- **运行消息进日志，动作失败进横幅**：`agent/notice` 与会话释放消息进入「日志」分区，**追加序、新条目在前、最多 200 条、仅浏览器内存（刷新清空）、未读圆点进入该分区即清零**；空闲释放（cause `idle`）不记。页顶横幅只承载用户动作（设置页动作与对话内 RPC，如检测 / 保存 / 探测 / 可见性 / 更新、权限答复 / config 写入）的失败，不再被运行消息覆盖。
  - 会话释放按宿主 `cause` 分别写日志（`workspace` info；`resume-failed` / `stalled` / `died` error；旧宿主缺 cause 按 `died`）。
  - 日志分区**条件渲染**（不挂 `hidden`）：它是无状态列表，常驻会在每条 `session/update` 时重排 200 行；进入分区才生效的 `markLogsRead` 清掉圆点。每行是本地 `HH:MM:SS`（`logClock`，不用 `toLocaleTimeString`）+ 级别徽标 + 可选 agentId + 原文。
- **审批时限卡**（`ApprovalDeadlinesCard` / `DeadlineModeBlock` / `DeadlineSliderBlock`）只有**两个控件**：超时处理方式（三档互斥按钮）+ 等待时长（一根滑块），热生效、不重启（取值三层与覆盖语义见 [permissions.md §2.4](./permissions.md)）。**只有一个等待窗口**：对话卡片里的询问与设置页镜像里的询问问的是同一个问题，所以共用一个答案——两个窗口曾把卡变成三行看不出关联的旋钮，用户还得防着两处配出互相矛盾的值。模式按钮**整宽排布**（`.dwa-seg-wide`）：右对齐的 seg 会把「一直等待 / 自动推进 / 超时中止」挤成两行字（「中/止」「自动推/进」），读起来像坏了。滑块档位是刻度（不等待 / 30 秒 / 1 分钟 / 5 分钟 / 15 分钟 / 30 分钟 / 1 小时 / 6 小时，「不等待」只在自动推进档出现，超时中止档从 30 秒起）；「一直等待」**不是一档**，它由模式表达——同一件事不在两个控件里各说一遍。配置文件写的窗口若不在档位上，**照原值运行**，卡片显示精确数字并把滑块停在最近的档位上——滑块不许谎报正在生效的数。宿主没有这条 RPC 时整卡不渲染——不显示浏览器自己编的数。
- **进程管理卡**（`IdleReleaseCard`）只有**一个控件**：空闲释放窗口（一根滑块，1 分钟起、其后每 5 分钟一档到 1 小时）。它管的是**聊天进程**的空闲释放，探测进程那 5 分钟窗口固定不变——两档窗口的语义见 [protocol.md §5](./protocol.md)。滑块档位是**共享阶梯** `IDLE_RELEASE_MS`（浏览器与宿主共用），所以滑块能出的值一定是宿主会跑的值；部署基线写的窗口若不在档位上，**照原值运行**，卡片显示精确数字并把滑块停在最近的档位上——滑块不许谎报正在生效的数。宿主没有这条 RPC 时**整块不渲染**（连同导航项）——不显示浏览器自己编的数。**重置按钮只在真被覆盖时出现**，且按钮文案说清回到哪里：部署写了窗口就写「恢复配置文件的值」，没写就写「恢复默认值」；部署写的窗口被压过时，那条「配置文件设为 X，此处设置优先」必须**看得见**（警告色），没有被压过就不说——没人主张过的胜权不该被宣称。
- **per-agent 的空闲释放是「覆盖」不是「第二份窗口」**：agent 高级页的那个输入框留空即**跟随全局**，只填自己显式要的值。**严禁**把宿主解析出的窗口回填进该 agent 的定义——回填等于把全局窗口冻结进这个 agent，全局滑块就再也到不了它。
- **两个控件必须说成一套**：卡片有一句话把时长与模式接上（「超过该时长仍未应答，将按上方所选的方式处理。」）。三行版最大的失败不是难看，是用户**猜不出三个控件是不是有关系**；现在只剩两个，且它们的关系被写了出来。
- **超时处理方式不能只写名字**：三个按钮（一直等待 / 自动推进 / 超时中止）下面必须有一行说明**当前档**的动作，且**两条说明不得说同一件事**——「自动推进」写「超过设定时间未应答，自动代替你选择一个选项让 agent 继续执行」，警告另起一条写「请确保你的 agent 值得信任，请谨慎选择」。否则「自动推进」会读成「界面自己往下滚」。这一行**只写动作**，不解释「为什么原来要转移」——那段历史写进文档，不写进 UI。
- **`wait` 档下滑块不生效**：不设期限时不能留着「等待时长」配一个永不触发的数字，此时**不画滑块**、读数写「一直等待」、说明改成「选择「一直等待」时不设超时时长。」存着的窗口不被改写（模式写只带模式），切回来时原样回来。
- **「不等待」只属自动推进**：滑块从左到右读作「等得越久越有耐心」，最左就是最不等——`0` 档的请求到达即代答，agent 继续。「超时中止」那一档**没有**这个刻度（从 30 秒起）：同样的 0 在那里是立刻拒绝每一问，agent 在每个门口都停住。「一直等待」属于模式轴（`wait`），时长轴不再重复它。
- **覆盖事实挂在被覆盖的那一行**（`.dwa-deadline-flag`，警告色，紧贴它说的那个控件）；重置按钮**只有真的覆盖了才出现**。
- **设置页文案有预算**：一个控件的说明**一行讲完**，机制解释进代码注释与 `AGENTS/`，不进 UI。同页参照是「呼吸频率 10 字 / 挂牌光晕 14 字 / 对话外观导语 15 字」——审批时限卡曾用 211 字铺满一张卡、两个旋钮埋在灰字里，压到 86 字后又回到 90 字（三行版），现在是**两个控件**：默认档 57 字，`auto` 档 95 字（多出的全是那句警告）；别把整页拉回长文。措辞取**正式陈述**（「超过设定时间未应答，自动代替你选择一个选项让 agent 继续执行」），不要口语化的拟人说法（「没人回答就替你选一个选项放行」）——后者两句话读起来像同一件事。
- 工作区保存语义：单根模式（非空 `cwd`）把 `allowedCwdRoots` 收窄为 `[cwd]`；`cwd` 为空则两者都不发送（走宿主 `defaultAgentWorkspace()`）；多根模式发送编辑后的去重绝对路径。初始状态带 >1 个 root 的 agent 必须直接进多根模式，避免仅仅打开表单就收窄白名单。
- 审批卡：对话内的主答案面是 `PermissionDock`（见 §10），本页那张「待处理权限请求」是跨会话镜像。权限语义与期限见 [permissions.md](./permissions.md)。

### 8.1 版本徽标与内置更新

- **版本徽标是更新卡入口**（`.dwa-version`）：只读 `ui.pluginVersion`（`plugin/version`），宿主不答就整块不渲染——浏览器不编版本号。`ui.pluginUpdate` 存在且状态不属于 `unsupported` / `not-installed` 时，徽标渲染成 `<button>`（`versionOpensUpdate`），带 `aria-expanded` 与 `aria-controls="ntr-plugin-update-card"`，点击开合更新卡；含 `current` / `failed` / `busy` / `source-install` / `managed` 在内都能从这里打开。否则只是普通 `span`。`source-install` 额外挂 `title`「源码或本地安装，无法通过 registry 更新」。
- **更新徽标**（`PluginUpdateBadge`，文案在 `updateBadgeText`）只在这些状态出现：`available`「可更新 vX」、`applying`「更新中…」、`applied`「已更新 vX」、`restart-required`「待重启 vX」——**最后一种只有 `installed` 存在时才挂**（apply 中断时磁盘状态未知，不编版本号）。**每个徽标都是可点按钮**（`applying` 也是），带同样的 `aria-expanded` / `aria-controls`：安装中的结果只能从卡片读。`current` / `busy` / `failed` / `unsupported` / `not-installed` / `managed` / `source-install` 不挂徽标——版本徽标本身就是入口。
- **更新卡**（`PluginUpdateCard`）在页头下方**就地展开**，不用模态：设置页已经握着那一个动作，模态会盖住它正在说的版本。容器带 `id="ntr-plugin-update-card"`、`role="group"`、`aria-label`「插件更新」。`updateCardVisible` 只在 `open` 且状态不属于 `unsupported` / `not-installed` 时画（`source-install` / `managed` 也画，各自说明为什么不能在这里更新）。摘要行是「当前 vX → 最新 vY」；宿主没报 `latest` 时只有当前版本。磁盘版本与运行版本不同（装完没重启，可能更高也可能更低）时多一格「磁盘 vZ」，有合法 `publishedAt` 时在末尾附日期。
- **动作**：仅 `available` 有「更新」，送的是 host 报的那个**精确版本**（`applyPluginUpdate(update.latest)`）；`applying` 时主按钮变成禁用的「正在更新…」；「关闭」收起卡片，但 `applying` 时不画；「重新检查」始终在（`applying` 时禁用），走 `checkPluginUpdate(true)` 跳过 store 的 10 分钟节流。安装**只能**由这一下点击发起——挂载只做检查。
- **每个状态一行话**（约束 33）：`available`「更新会卸载并重装插件，之后可能需要重启 DSH。」/ `applied`「已应用，刷新页面即可使用新版本。」/ `restart-required` 分两种：`installed` 存在 → 「磁盘已是 vX，重启 DSH 后生效（桌面 App 退出重开；命令行重启 dsh web）。」；`installed` 缺失（apply 响应中断、磁盘状态未知）→ 「更新可能已完成，请刷新页面确认当前版本。」——**中性**，因为磁盘版本可能比运行版本高或低，绝不写「已更新」/ `busy`「有进行中的对话，结束后才能更新。」/ `failed`「更新失败。」/ `current`「已是最新版本。」/ `source-install`「源码或本地安装，无法通过 registry 更新。」/ `managed`「此安装由宿主管理，不能在这里更新。」。`applying` 无说明行，只有摘要与禁用按钮。宿主原始 `message` 是唯一的长文本，单独一行（`failed` / `busy` / `managed`），靠 CSS 折行，不改写、不截成半句。
- 颜色只走宿主 alias token（约束 34）：徽标是 `state-business-tertiary` 底 / `state-business-primary` 前景；卡片就是普通 `dwa-card`，失败不另造一套红色。
- 检查随设置页挂载自动触发（`AcpSettingsSection` 的 `useEffect`）；两个入口（宿主外壳 / 对话内对话框）挂同一个组件，store 的 10 分钟节流与 in-flight 去重因此只按一份算。双击「更新」被 store 的 `pluginUpdateApplying` 挡住；apply RPC 因插件被卸载而中断时，store 写 `restart-required` + notice「更新请求已中断；请刷新页面确认当前版本。」并清掉 `installed`，卡片只说「更新可能已完成，请刷新页面确认当前版本」，不编磁盘版本。`pluginUpdateGeneration` 让晚到的 check 结果无法覆盖 apply 的终态。旧宿主没有这个端点：`checkPluginUpdate` 静默吞掉 `unknown endpoint` 并回 `undefined`，面板把更新入口整块藏掉，不写 notice。

## 9. 双语文案与语言切换

- 调用点一律写 `label(zh, en)` 对（`AcpStore.label`，实例绑定，可安全交给 memo 行）；运行时经宿主 `ctx.locale.resolveText({ zh, en })` 解析当前语言。`locale` 服务按 `ctx.get` 结构化读取（`LocaleFace`），缺失时回落到 `navigator.language`（`browserPrefersZh`）——不允许因此加载失败。
- 热切换：`index.tsx` 订阅 locale 服务（`internal/service` 兜底晚到），回调 `store.refreshLocale()` **重新发布快照**（`localeRev` 自增）；`useSyncExternalStore` 因此重跑渲染期 `label()`。memo 化的 transcript 行（`BlockView`）props 不变就不会重渲染，所以它必须拿到 `localeRev`。切换不改数据，只改解析结果。
- 已定型字符串不随切换回译：notice、日志条目、权限标题兜底在事件发生时解析。唯一例外是 `detectSummary`——store 记住 `detectCounts`，在 `refreshLocale` 里重建，避免旧语言的成功行留在设置页。
- 插件卡标题 / 描述不走这套：包内 `locale/en.json` / `locale/zh.json` 的 `meta.description` 由宿主 `readPluginMeta` 读取，经 `exports` 的 `./locale/*.json` 暴露。`en.json` 必须存在且与 `package.json.description` 一致（回退值），缺它整组本地化不生效。

## 10. 对话内权限卡（`conversation.input.dock`）

待答的 ACP 权限询问在对话里由 `PermissionDock`（`src/client/permission-dock.tsx`）回答，座位是 `conversation.input.dock`（宿主契约原文：composer 卡片上方的整宽条目；`kind: 'list'`、`scope: 'session'`）。槽位在 active 阶段是整列宽的 flex 容器，卡片自己套宿主 InputBar 的宽度公式——`width: calc(100% - 2 × --dsh-composer-side-clearance)`、`max-width: --dsh-composer-card-max-width`、`margin: 0 auto`——所以与输入框同宽居中对齐；宿主 queue dock 用同一套变量。**没有 ACP-mode 闸门**：帧集合本身就是闸门——这条会话没有询问就不渲染，普通会话不会凭空多一张卡。权限语义、期限与重放见 [permissions.md](./permissions.md)。

- **注册**：`src/client/index.tsx` 经 `ctx.slots.inject` + `ctx.slots.register({ name: 'conversation.input.dock', id: 'acp-permissions', order: 10, inject })` 挂载；宿主的 queue / todo dock 用同一个座位。
- **会话身份只来自注入位参**：`inject: (sessionId) => chatFace(sessionId)`。宿主渲染器的 `runInject(entry, binding, actions)` 把 slot binding key 作为**第一个位置参数**递进来（与 `conversation.input.left` 的 mode 控件同一契约），`chatFace` 再把它放进 props 的 `sessionId`。组件只声明 `acp` + `sessionId`，**不读** owner share 的 `session` / `input` 字段：`conversation.input.left` 曾因声明 `session.sessionId` 让整条 entry 崩掉并被 abdicate，而注入位参才是各版本都遵守的契约。
- **过滤**：`permissionsForSession(ui.permissions, dshSessionId)` 只留 `dshSessionId` 相等的询问。没有对话身份的 `/acp` RPC 询问（帧里没有 `dshSessionId`）永远不进对话卡，只留在设置页镜像。
- **选项原样**：每个 `option.name` 一个按钮，顺序就是 agent 给的顺序，`Always Allow` 这类名字照写；不渲染 `kind`、不翻译、不合并。**独立的取消按钮**不选任何选项，宿主按 `cancelled` 回给 agent。**没有全局 Enter / Esc**：composer 的键盘归 composer，卡片里只有普通可聚焦按钮。提交中按钮 `disabled`；失败就地显示在卡片里（`role="alert"`），同时 store 仍写一次 notice（设置页也看得到）。
- **倒计时**：只有帧里带 `deadlineAt` 才显示（`wait` 模式没有期限）；`deadlineRemainingLabel` 每秒重算，过期显示「已超时」而不是负数——收场由宿主做，卡片不假装还剩时间。到点后卡片随 `permission/resolved` 消失，对话里的留痕来自 `permission/expired`。
- **堆叠**：多问按**到达顺序**最旧在上，列表高度上限 `min(38vh, 320px)` 内滚动——连续询问不会把 composer 推出屏幕。
- **设置页是镜像，不是替代**：`permissionLedgerCard` 只要 `ui.permissions` 非空就渲染可答复卡片（`approvalRouted` / `fellBackFromConversation` 已删除），文案是「对话打开时在那边的卡片上回答；这里兜底显示其他会话的询问。」每行写 `toolName`（有 `reason` 时附在后面），按钮同样原样。两个面回答的是同一份 `PendingPermission`，写入都走 `respondPermission`。
- 聊天里那行提示（`TurnStreamController.permissionLine`）指向真正的答案面：有 `dshSessionId` 说「对话卡片」，`/acp` 询问说「设置页」。

### 10.1 释放横幅（`acp-released-banner`，同座）

会话的 agent 进程被释放（空闲回收 / 崩溃）后，`conversation.input.dock` 的第二条目 `ReleasedBanner`（`src/client/released-banner.tsx`）在输入框上方显示一行「进程已释放」+「恢复进程」按钮。释放本身按约束 19 是静默的，而「下一条消息自动恢复」的承诺从聊天面本身无法验证——横幅把它说出来，按钮把它变成一个手势。

- **闸门是纯函数** `releasedBannerVisible`（无 DOM 可测）：显式 `acpMode === false` 压过残留行（与挂牌同优先级）；`chatSessionsFor` 必须等于本会话；行集非空且**全部** `released`——有一行活着就说明下一条消息有人接，横幅让路；空集（没跑过 agent）不画。
- **按钮**走 `session/chat-resume`（`AcpStore.resumeChatSession`），与下一条消息的惰性恢复同一套动作、绝不走创建路径（[protocol.md §2](./protocol.md)）。失败闪 notice **并** rethrow（`respondPermission` 契约），错误就地钉在按钮旁（`role="alert"`），不丢到用户可能没开的设置页。提交中按钮 `disabled`。
- **挂载自读一次** `loadChatSessions`：打开一条已挂起的会话时，没有任何别的东西会替它读这份清单（挂牌、占用环的重读都挂在别的触发器上）。
- **横幅跨 DSH 重启存活**：会话记录持久化（[state.md §3.1](./state.md)），重启后记录以 released 复原，横幅与「恢复进程」照常——否则重启就等于把「released ≠ 销毁」丢掉。重启后到恢复前 NTR 视图的空流说「历史将在恢复后回放显示」（`historyAwaitsReplay`，见 §5），不说「还没有消息」。
- 宽度复用权限卡的 InputBar 公式（`.ntr-released-banner`），样式与 `ntr-permission-card` 同族（warn 左边条）；行集的 released 翻转见 §2 耦合不变量。

## 11. 主题与颜色

主题完全归宿主：暗色 token 由 `body[data-ds-dark-theme]` 选出，原生控件（select / checkbox / 滚动条）靠宿主写在 `documentElement` 上的 `color-scheme` 继承。插件**不维护 JS 侧主题状态**，也**严禁**自己写 `color-scheme: light dark`——那会跟随系统偏好而不是宿主偏好，两者不一致时面板会和宿主断层。

- **写死颜色只允许出现在 `var()` fallback 位**：`var(--dsw-alias-state-error-primary, #dc2626)`。宿主有 token 时跟随主题，缺 token 时保持原浅色。
- **状态色按宿主配对**：`state-success|warn|business-tertiary` 作底，`state-*-primary` / `state-warn-label` 作前景；危险 hover 用 `interactive-bg-hover-danger`；diff 行用 `file-diff-added|deleted-bg`，统计数字用 `state-success|error-primary`；内联代码底用 `markdown-inline-code`；状态点用 `state-success|warn|error|idle-primary`。需要浅色文字对比时按宿主写法 `color-mix(in srgb, state-success-primary 72%, label-primary)` 派生，不为每种主题写死两份。
- **宿主没有的 token**（引用它们只会永远落 fallback）：`--dsw-alias-text-primary` / `text-secondary` → `label-primary` / `label-secondary`；`--dsw-alias-button-primary-invert` → `label-primary-foreground`；`--dsw-alias-font-mono` → `--ds-font-family-code`。新增 token 引用前先在本机 DSH 的 `dsh-client-ui-theme/lib/client.js` 里核对定义。
- `.ntr-acp-code` 的固定深色块（`#0f172a` / `#e2e8f0`）是有意的：两套主题下都可读，不参与 token 化。阴影 `rgba(0,0,0,α)` 同理可接受。

## 12. 消息动作接管（分支按钮）

NTR 会话里，宿主的点赞 / 点踩 / 分支三图标是插件的业务：agent 自己决定反馈面，而宿主的分支会分出一条 agent 不记得上文的会话。插件把三图标藏掉、在同一位置自绘分支入口（`src/client/branch-action.tsx` · `AcpBranchAction`）；分叉的两段链路见 [protocol.md §1](./protocol.md)。

- **作用域标记归 `syncAcpMode` 维护**：`src/client/index.tsx` 的 `setScopeMarker` 幂等 `toggleAttribute('data-ntr-acp')`，每一条 `standDown` 与 gate 卸载清理都会摘掉——证据不再作答时宿主图标原样回来。行的 preset 判定经 `store.noteAcpMode` 折叠进 store（取代旧的「gate 只读不写」：舞台行的 `agentPreset` 与 `agent-preset/selected` 帧两个方向都折叠）；自绘按钮的闸门读折叠后的 `acpMode`，与 CSS 作用域是同一份事实，两个判定源不得分叉。
- **隐藏是纯 CSS，锚点是 `[data-turn-tail]`**（宿主 `TurnTailNodeView` 根 div 的标记；当前宿主构建没有 `data-clock` 可依赖）。按本地化 `aria-label` 精确匹配，**只有 8 条 button 规则**：宿主 `Tooltip` 是 `cloneElement` 渲染、不加包装元素，藏掉 button 就是全部工作，行内不留空位；**严禁**加 `:has(> button…)` 规则——它会命中动作行本身（分支按钮）与 list 槽共用的 `display:contents` 锚点（反馈按钮），把整行藏掉（测试钉住了这条禁令）。`:not([data-ntr-branch])` 是自绘按钮的通行证——它与宿主分支按钮同 aria-label，否则会被自己的规则藏掉。复制键因精确匹配天然不受伤。**严禁**覆盖 `conversation.chat.node` 渲染来达成隐藏——那会连带失去 `turnTail` / `assistant-actions` 两个子槽。
- **aria 选择器的脆点**：宿主改文案或加第三语言 → 规则不命中、图标复活（功能不坏，只是没藏住，用户仍能分叉）。缓解两道：`probeHostActionLabels` 在标记亮起且 turn tail 真的上屏后每页抽查一次（tail 未上屏不烧掉抽查），缺失 `console.warn` 一条（dev 可见，不进用户 UI）；测试断言注入的 CSS 字符串，宿主改文案时先红。
- **自绘入口注册 `conversation.chat.assistant-actions`**（list、session scope、`order: 20`——排在 feedback 条目的 10 之后，即宿主原分支按钮的位置）；对每个会话注册、组件内部按折叠后的 acpMode 闸门（非 ACP 渲染 `null`，双保险）。图标取宿主分支按钮的同款（`branch-action.tsx` 的 `branchIconOf`：`IconBranchOutline16 → …Regular → …Medium` 逐个回退）与 `Tooltip`，都来自宿主前端模块表里的 `@deepseek-ai/dsh-client-ui-primitives`（`primitives.d.ts` 只结构化声明用到的成员）；该包是宿主提供的运行时模块，**严禁**打进 bundle——图标必须与宿主同源（约束 1 的 CJS 模块表纪律）。**严禁**对单个图标名做硬 import：导出名在宿主世代间移动过（桌面 0.2.1-rc.2 只有 `…Regular`/`…Medium`，没有 `…16`），硬 import 编译成普通属性读取、缺名即 `undefined`，`<undefined />` 渲染时抛「Element type is invalid」，槽位错误边界把整个条目吞掉——按钮无声消失（测试钉住回退次序）。
- **`.ntr-branch-action` 的数值逐值拷贝宿主 `.xzv4MW_action`**：`28px + font-delta` 方框、`padding: 6px`、`border-radius: 28px`、`label-tertiary`、hover `interactive-bg-hover` / `label-secondary`、`data-unavailable` 置灰（opacity 0.4）；自创数值就是第二套视觉。颜色只走 `var()` token（约束 34）。
- **六态 `forkStateOf`（`store.ts` 纯函数），每个输入都是别人拥有的事实**：行 `fork` 字段（`session/chat-list` 下发，宿主判定、浏览器**不拼**；`supported: false` 带 `reason: 'unsupported' | 'released' | 'busy'`，无 reason 的旧行按不支持）；SSE 的实时 running（行数据的 `running` 只在 chat-list 重读时刷新，会答成上一轮）；宿主 `[data-turn-tail]` 的 `data-actions-reveal === "always"`（= 最新已完成轮次；`TurnTailNodeView` 用 `isLatestTurn` 决定）**且宿主分支按钮自己的 `data-unavailable` 不在场**（宿主还有更严的闸——尾节点不是 transcript 最后一项、或轮内有更晚节点时宿主自己置灰；读宿主按钮的这个属性保证插件的可点集合是宿主的子集，剩下的点击切点与宿主一致）。任一缺失按不可用——**fail-closed**：宁可少给一次分叉，不给一次切错点的分叉；`sessions.fork` 的结构探测（缺失 `hostUnavailable`，按钮可见但置灰）。优先级：宿主服务缺失 > 能力位 > 会话自身状态（released 先于 busy）> tail 判定 > ready。
- **点击链路固定两段，全 or 无**：`store.forkChatSession` 先调宿主 `sessions.fork`（结构解析、每次点击重取 face——渲染与点击之间消失的服务在横幅里报错，不在组件里 throw），拿到 childId 再调 `session/chat-fork-adopt`；两段都成功才 `uiWorkspace.openSession(childId)`。任何一段失败：`store.forkChatSession` 返回 `{ failure }` 一行可操作的原因（同时 `flashError` 进设置页横幅，约束 38），组件把它钉在按钮旁的行内（`.ntr-branch-error`，`role="alert"`——用户在对话里，不能只留在设置页），**什么都不打开**——未接管的子会话是一条复制历史的普通会话，不是用户要去看的。`sessions.fork` 与 `uiWorkspace` 都是可选宿主服务，按 §7 的规矩经 `service<T>` 惰性解析，**严禁**写进 `inject`。
- **作用域标记是页面级**：`html[data-ntr-acp]` 置位后，同屏所有 `[data-turn-tail]` 都应用隐藏规则——多视图布局里同屏的非 NTR 会话会一起丢三个图标。与模型座位 claim 的全局性同一取舍（座位 claim 也按「舞台会话」全页生效），已知且接受；宿主给出 per-session 钩子前没有更精确的作用域。

## 代码索引

| 主题 | 位置 |
|---|---|
| 底座 / 菜单 | `src/client/session-controls.tsx` · `AcpSessionControls` / `AcpSessionMenu` / `menuFor` / `describeRoute` / `routeAgentId` / `agentBaseChip` / `advancedOptions` |
| 座位 | `src/client/model-seat.tsx` · `createModelSeatClaim` / `createPermissionSeatClaim`；`src/client/index.tsx` · `syncAcpMode` |
| 锁定 UI | `src/client/session-controls.tsx` · `lockedAgentOf` / `agentBaseHidden` / `agentTagVisible` / `agentTagAlive` / `agentTagHaloPresentation` / `AcpComposerAgentTag`；`src/client/agent-lock-anim.ts` |
| 视图 | `src/client/acp-view.tsx` · `boundAgentOf` / `acpEmptyCopy` / `diffRows` / `isNewFileDiff` / `historyAwaitsReplay`；`src/client/context-meter.tsx` · `AcpContextMeter` / `acpMeterUsage` / `contextOccupancy` / `compactTokenCount`；`src/client/index.tsx` · `acp-context-meter` 注册处 |
| 权限卡 | `src/client/permission-dock.tsx` · `PermissionDock` / `PermissionAskCard`；`src/client/store.ts` · `permissionsForSession` / `deadlineRemainingLabel`；`src/client/index.tsx` · `acp-permissions` 注册处 |
| 释放横幅 | `src/client/released-banner.tsx` · `ReleasedBanner` / `releasedBannerVisible`；`src/client/store.ts` · `resumeChatSession` / `withSessionReleased`；`src/client/index.tsx` · `acp-released-banner` 注册处 |
| 消息动作 | `src/client/branch-action.tsx` · `AcpBranchAction`；`src/client/store.ts` · `forkStateOf` / `forkChatSession`；`src/client/index.tsx` · `setScopeMarker` / `probeHostActionLabels` / `ntr-branch` 注册处；`src/client/acp-ui.tsx` · 隐藏规则与 `.ntr-branch-action` 样式（见 §12） |
| 斜杠 | `src/client/slash-isolation.ts` · `createSlashIsolation` / `slashAcpVerdict` / `commandCandidates` |
| 文案 | `src/client/index.tsx` · `label` / `LocaleFace` / `browserPrefersZh`；`src/client/store.ts` · `refreshLocale` / `detectSummaryOf`；`locale/*.json` |
| 设置页 | `src/client/panel.tsx` · `AcpSettingsSection` / `AgentRow` / `WorkspaceBlock` / `initialForm` / `buildPayload` / `ApprovalDeadlinesCard` / `approvalDeadlineFacts` / `permissionLedgerCard`；`PluginUpdateBadge` / `PluginUpdateCard` / `updateBadgeText` / `updateCardVisible` |
| 设置对话框 | `src/client/settings-dialog.tsx` · `AcpSettingsDialog`；`src/client/acp-ui.tsx` · `openAcpSettingsDialog` / `closeAcpSettingsDialog` / `useAcpSettingsDialogOpen` |
