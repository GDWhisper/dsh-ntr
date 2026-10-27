# 浏览器半区：座位、芯片与视图

本文是 [AGENTS.md](../../AGENTS.md) 的展开层，覆盖 `src/client/` 的接线纪律。
浏览器半区**严禁**引入 Node 内置模块或 `@agentclientprotocol/sdk`，通信只走 RPC / SSE。

## 1. 模型底座：占座与闸门

NTR 底座（`conversation.input.model`，`AcpSessionControls`）**只作首轮前启动 / 切换 agent 的入口**：下拉里只有智能体列表（`menuFor('agent')` 只返回 `agentSection`），模型 / 思考等级 / agent 模式各有自己的控件。菜单只有一个标题「选择你的 Agent」。

- **位置**：底座占的是原生模型底座那个 `single` cell——composer bar 行尾（`.trailing` 组，`margin-left: auto`）、提交键左边。原生 occupant 是宿主 `client-ui-model-selection` 的 `ModelSelect`（列 DSH 全量 provider，点一下写全局默认模型），所以 NTR 会话里必须由我们接管。
- **一个 cell、一个 occupant**。cluster 内顺序固定 `高级 → model → thought → agent`：首轮前 agent 底座是右端锚点（它也是 `:last-child`，CSS `flex: none`，长模型名或额外 chip 只能挤压它左边的内容，**严禁**把 agent 底座排在前面——实测会被挤到看不见）；首轮锁定、底座退场后，`thought`（没有时 `model`）成为右端锚点。高级底座始终紧贴模型左侧。
- **隔离靠闸门，不靠组件自隐**：`src/client/index.tsx` 的 `syncAcpMode` 只在舞台会话跑 ACP preset 时创建 claim，切走即 `release()`。非 NTR 会话里这条 entry 根本不存在。
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
- **存活光晕**：挂牌判定 `agentTagAlive(bound, lockedTo)`——会话视图存在、未 released、且属于被挂牌的 agent——为真时按设置页「对话外观 → 挂牌光晕」的选择展示：`breath`（蓝色呼吸光晕，慢速 5.2s / 正常 3.2s / 快速 1.2s，经挂牌 span 上的 `--ntr-halo-period` 变量下发，映射在 `TAG_HALO_PERIODS` / `agentTagHaloPresentation`）或 `steady`（恒定光，无动画）。reduced-motion 下都退化为静态光。偏好持久化在 `agents.json` 的 `tagHalo` 键，经 `ui/tag-halo` / `ui/tag-halo-set` 读写；store 写入先行（乐观），失败回退。耦合不变量：`session/released` / `session/closed` 事件必须同步翻转 / 删除 store 的 `chatSessions` 行（composer 自己的清单），否则挂牌对着已释放进程一直呼吸；没有别的路径会替 composer 重读这份清单。
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
| 当前在哪个模型 / 思考等级 | `bound?.modelId ?? pick?.modelId`；`bound?.reasoningEffort ?? pick?.effort`；没选过时回落 `catalog.currentModel` 与 `catalog.reasoning.defaultEffort` | `setChatSessionModel` / `setChatSessionEffort` |
| agent 的额外 config options | `agent/catalog` 的 `extras`（model / thought_level / mode 之外的 select 与 boolean，含未知 category） | `setChatSessionConfig`（`session/chat-config-set`），落 `AcpConversationChoice.extraConfigs`（select 存字符串，boolean 存真布尔） |

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
- **自带 ACP 闸门**（`ui.acpMode[dshSessionId]` 或活会话存在）：它在 `conversation.input.left`，不在 `syncAcpMode` 的 claim 生命周期里，而 `agentId` 会回落到插件默认 `defaultAgent`，不闸就是普通会话凭空多一个 ACP 控件。
- `setChatSessionMode` 对没有活会话的会话只记录 pick、不 spawn（与 `setChatSessionModel` 一致），`applyChatChoice` 在建 / 恢复会话时再应用。
- 该 series 的公开 `.d.ts` 里 slot 条目**不含 `owner` 字段**（`OwnerOf` 解析为 `object`），所以组件里声明结构类型（`ComposerModeProps`），注册处 `as unknown as SlotComponent<any>`；新增 client 模块依赖要加进 package.json 的 `dsh.client.inject`。

## 5. NTR 视图 tab

真工具卡只能在 `conversation.view` 的 NTR tab（`src/client/acp-view.tsx`）里画。

- 数据必须走 `session/chat-transcript`（按 **DSH 聊天会话 id** 寻址：浏览器在看到返回前并不知道 ACP 会话 id）。
- **严禁**让 LLM adapter 旁路转发工具事件；**严禁**在视图里做 prompt / cancel / spawn（它只读）。
- 流式更新靠 store 把 SSE 的 `session/update` 折进被观察的 transcript（`chatTranscripts` + `MAX_WATCHED` 上限）；**严禁**视图自己轮询。

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
- 读取一律经 `stagedSessionOf` / `rowAgentPreset`（`src/client/acp-ui.tsx`），不要再手写 `snapshot.current` / `byId[..].agentPreset`。
- **失败放开**：服务未就位 / 槽位未声明 / 注册被拒 / 当前是 addressed subagent 路由 / 座位渲染崩溃（slot 错误边界会 abdicate 该条目），都必须回到原生座位并清掉「座位已接管」标志。claim 的 `sync()` 可重跑：下一次求值（store 变更、列表通知、preset 帧、cell 变化）会再试；诊断如实报告每次失败，不假装已安装。唯一允许的失败模式是「不接管」。
- `ACP_PRESET_ID` 三处必须一致：浏览器半区、宿主 `src/bridge.ts`、声明里的 `config.id`（`presets/acp/acp.patch.yml`）。
- **可选宿主服务严禁写进 `inject`**（缺服务会让插件整体加载失败；顶层 `inject` 只有 `slots` + `connection`）。只能经 `service<T>(name)` 在调用点 `ctx.get` 惰性解析（缺服务返 `undefined`、服务后到也能拿到），解析包 try/catch（见 `faceFor`）。
- **结构类型只许写框架真的递过来的成员**：session 作用域入口能拿到 `sessionId` + `use<Name>` 选择器钩子（`useSession` / `useConversation` / `useInput` / `useWorkspaces` / `useChat` / `useProjection`）+ `inputActions` + 自己的 owner share（`conversation.input.model` 的 `locked`）。`conversation.input.left` 的 owner share 是**空对象**，严禁声明 / 读取任何别的字段——曾写 `session.sessionId` 让整条 entry 崩掉并被 abdicate；可选链泄漏进 `props.session?.running` 更阴：不炸，但重读永远不触发。需要「会话是否在跑」只能 `useSession(s => s.running)`（`AcpSessionHook`）。

## 8. 设置页

- **同一个设置页有两个入口**：宿主设置外壳里的 `settings.section`（`AcpSettingsSection`），以及对话内底座空 roster 菜单打开的 `AcpSettingsDialog`（`shell.overlay`）。两处挂的是同一个组件，配置逻辑只有一份；对话框不做第二套表单。宿主外壳的打开状态归它自己，插件无法从对话面驱动（见 §2）。
- 模型区（`ModelCatalogBlock`）**常驻渲染**，严禁挂在探测结果上：右侧「已选模型」来自 agent 配置的 `exposedModels`，左侧「全部模型」来自宿主目录缓存（`agent/cached-models`，纯内存、不 spawn，见 [state.md §4](./state.md)），所以打开卡片就能看到已配置的东西。`检测可用模型` 只是**左侧列表的刷新**（新增的加进来、下架的去出去），与搜索框同放在模型区自己的工具栏里（不在区块顶部），点击后在标题行回报「新增 N · 移除 M / 目录无变化」。空目录时左侧给引导文案（未读取 / 该 Agent 未暴露 `category: model`），而不是隐藏整块。模型行**直接展示** `description`（如 agent 给出的积分消耗 `x0.29 credits`），严禁只放进 `title` 靠 hover 才能看到；分组兜底 description 与 `group` 相同时不重复展示。空间不足时名称与 credit 优先保留，模型 id 是唯一可收缩的格子：右缘渐隐（mask）而不是硬省略号，hover 时由 `armModelIdMarquee` 实测溢出量并滚动展示全文，`title` 仍保留完整值（reduced-motion 的兜底）。「全部模型」与「已选模型」两块列表**上下堆叠**，不再左右分栏——半宽面板会把名称 / id / credit 同时挤掉。两块面板各自带收纳按钮（`▾` / `▸`，`aria-expanded`）：只隐藏列表本体、保留标题与计数，列表继续挂载以保住滚动位置。
- 每张 agent 卡保持「紧凑行 + 展开详情」两段，详情体**常挂载**、只用 `display: none` 折叠——条件渲染会重挂载表单 `useState`，丢掉用户编辑中的值。缓存读按 `active`（展开态）触发，折叠的卡片不发请求。
- 页面按 `section` 分组：页头（标题 / 描述 / 流状态）→ 模式横幅 → 已接入的智能体 → 添加智能体 → **审批时限** → 对话外观。文案里点名的控件名必须与可见标题一致：store 的 `detectSummary` 与空态提示都指向「添加智能体」，改名要三处同步（`store.ts` / `panel.tsx` / `tests/store.spec.ts`）。审批时限卡的位置在「对话外观」之上：它改变的是回合会发生什么，那张卡只装饰挂牌。
- **审批时限卡**（`ApprovalDeadlinesCard` / `DeadlineRow`）改两个降级窗口，热生效、不重启（取值三层与覆盖语义见 [permissions.md §2.3](./permissions.md)）。每行是「预设 seg + 自由秒数输入」两路：秒数字段是**草稿**，只有能解析成非负整数才提交，失焦时非法草稿回滚而不写入宿主会拒的值。卡片还必须显示宿主只在相关时才上报的两个事实：`configured[key]` 与生效值不同（配置文件被覆盖，给重置按钮）、`permissionTimeoutMs > 0`（它一视同仁，本卡调的两个数都没被读）。宿主没有这条 RPC 时整卡不渲染——不显示浏览器自己编的数。
- 工作区保存语义：单根模式（非空 `cwd`）把 `allowedCwdRoots` 收窄为 `[cwd]`；`cwd` 为空则两者都不发送（走宿主 `defaultAgentWorkspace()`）；多根模式发送编辑后的去重绝对路径。初始状态带 >1 个 root 的 agent 必须直接进多根模式，避免仅仅打开表单就收窄白名单。
- 审批卡与权限路由见 [permissions.md](./permissions.md)。

## 9. 双语文案与语言切换

- 调用点一律写 `label(zh, en)` 对（`AcpStore.label`，实例绑定，可安全交给 memo 行）；运行时经宿主 `ctx.locale.resolveText({ zh, en })` 解析当前语言。`locale` 服务按 `ctx.get` 结构化读取（`LocaleFace`），缺失时回落到 `navigator.language`（`browserPrefersZh`）——不允许因此加载失败。
- 热切换：`index.tsx` 订阅 locale 服务（`internal/service` 兜底晚到），回调 `store.refreshLocale()` **重新发布快照**（`localeRev` 自增）；`useSyncExternalStore` 因此重跑渲染期 `label()`。memo 化的 transcript 行（`BlockView`）props 不变就不会重渲染，所以它必须拿到 `localeRev`。切换不改数据，只改解析结果。
- 已定型字符串不随切换回译：notice、权限标题兜底在事件发生时解析。唯一例外是 `detectSummary`——store 记住 `detectCounts`，在 `refreshLocale` 里重建，避免旧语言的成功行留在设置页。
- 插件卡标题 / 描述不走这套：包内 `locale/en.json` / `locale/zh.json` 的 `meta.description` 由宿主 `readPluginMeta` 读取，经 `exports` 的 `./locale/*.json` 暴露。`en.json` 必须存在且与 `package.json.description` 一致（回退值），缺它整组本地化不生效。

## 代码索引

| 主题 | 位置 |
|---|---|
| 底座 / 菜单 | `src/client/session-controls.tsx` · `AcpSessionControls` / `AcpSessionMenu` / `menuFor` / `describeRoute` / `routeAgentId` / `agentBaseChip` / `advancedOptions` |
| 座位 | `src/client/model-seat.tsx` · `createModelSeatClaim` / `createPermissionSeatClaim`；`src/client/index.tsx` · `syncAcpMode` |
| 锁定 UI | `src/client/session-controls.tsx` · `lockedAgentOf` / `agentBaseHidden` / `agentTagVisible` / `agentTagAlive` / `agentTagHaloPresentation` / `AcpComposerAgentTag`；`src/client/agent-lock-anim.ts` |
| 视图 | `src/client/acp-view.tsx` · `boundAgentOf` / `acpEmptyCopy` / `diffRows` / `isNewFileDiff` |
| 斜杠 | `src/client/slash-isolation.ts` · `createSlashIsolation` / `slashAcpVerdict` / `commandCandidates` |
| 文案 | `src/client/index.tsx` · `label` / `LocaleFace` / `browserPrefersZh`；`src/client/store.ts` · `refreshLocale` / `detectSummaryOf`；`locale/*.json` |
| 设置页 | `src/client/panel.tsx` · `AcpSettingsSection` / `AgentRow` / `WorkspaceBlock` / `initialForm` / `buildPayload` / `ApprovalDeadlinesCard` |
| 设置对话框 | `src/client/settings-dialog.tsx` · `AcpSettingsDialog`；`src/client/acp-ui.tsx` · `openAcpSettingsDialog` / `closeAcpSettingsDialog` / `useAcpSettingsDialogOpen` |
