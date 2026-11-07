# 浏览器半区：设置页、文案与主题

本文是 [ui.md](./ui.md) 的设置面，覆盖 `src/client/panel.tsx`、`SaveGuardToast`、双语文案与颜色纪律。节号沿用 ui.md 的全仓连续编号；会话面（座位、芯片、视图、消息动作）仍在 [ui.md](./ui.md)。

## 8. 设置页

- **同一个设置页有两个入口**：宿主设置外壳里的 `settings.section`（`AcpSettingsSection`），以及对话内底座空 roster 菜单打开的 `AcpSettingsDialog`（`shell.overlay`）。两处挂的是同一个组件，配置逻辑只有一份；对话框不做第二套表单。宿主外壳的打开状态归它自己，插件无法从对话面驱动（见 [ui.md §2](./ui.md)）。
- 模型区（`ModelCatalogBlock`）**常驻渲染**，严禁挂在探测结果上：右侧「已选模型」来自 agent 配置的 `exposedModels`，左侧「全部模型」来自宿主目录缓存（`agent/cached-models`，纯内存、不 spawn，见 [state.md §4](./state.md)），所以打开卡片就能看到已配置的东西。`检测可用模型` 只是**左侧列表的刷新**（新增的加进来、下架的去出去），与搜索框同放在模型区自己的工具栏里（不在区块顶部），点击后在标题行回报「新增 N · 移除 M / 目录无变化」。空目录时左侧给引导文案（未读取 / 该 Agent 未暴露 `category: model`），而不是隐藏整块。模型行**直接展示** `description`（如 agent 给出的积分消耗 `x0.29 credits`），严禁只放进 `title` 靠 hover 才能看到；分组兜底 description 与 `group` 相同时不重复展示。空间不足时名称与 credit 优先保留，模型 id 是唯一可收缩的格子：右缘渐隐（mask）而不是硬省略号，hover 时由 `armModelIdMarquee` 实测溢出量并滚动展示全文，`title` 仍保留完整值（reduced-motion 的兜底）。「全部模型」与「已选模型」两块列表**上下堆叠**，不再左右分栏——半宽面板会把名称 / id / credit 同时挤掉。两块面板各自带收纳按钮（`▾` / `▸`，`aria-expanded`）：只隐藏列表本体、保留标题与计数，列表继续挂载以保住滚动位置。
- 每张 agent 卡保持「紧凑行 + 展开详情」两段，详情体**常挂载**、只用 `display: none` 折叠——条件渲染会重挂载表单 `useState`，丢掉用户编辑中的值。缓存读按 `active`（展开态）触发，折叠的卡片不发请求。
- **连接测试的结果块**（`AgentTestOutcome`）：失败时三层——宿主原始错误（`error`，danger）、修法提示（`agentTestHint`，warn）、测试进程 stderr（标题「测试进程输出」）。提示句由宿主给的 `AgentTestFailureKind` 决定，**句子归浏览器**；未知 kind 返回 `undefined`，绝不猜一个修法。`not-found` 说安装、`install-failed` 说看 npm 输出、`start-failed` 按 `spawnError` 分流（EACCES / EPERM 说权限，其余看退出码并提示参数 / 鉴权）、`timeout` / `handshake-failed` 回到「是不是 ACP agent」。成功也带 stderr（警告常在这里）。行内已有进程级 stderr 时，结果块**必须自带标题**，否则两段无标签输出会被读成重复。
- 设置采用原生分区：页头 → 跨分区审批镜像 / **仅设置页自身动作失败的横幅** / 模式异常提示 →「智能体 / 审批时限 / 进程管理 / 对话外观 / 日志」导航 → 当前分区 → 页脚连接状态与「查看诊断」。正常模式横幅、预设来源和「重新检测与刷新」收进诊断；模式异常不允许只藏在诊断里。没有审批时限 RPC 时不显示该导航项；没有空闲释放 RPC 时同样不显示「进程管理」。智能体未读取与已确认空列表分开呈现；「添加智能体」由按钮进入，首次点击才挂载表单，保存成功返回列表。分区、行内「模型 / 连接 / 高级」切换均只隐藏内容、保留编辑状态；模型缓存只在当前可见的模型面读取，不在隐藏分区读取，更不得自动探测。文案里点名的控件名必须与可见标题一致：store 的 `detectSummary` 与空态提示都指向「添加智能体」，改名要三处同步（`store.ts` / `panel.tsx` / `tests/store.spec.ts`）。
- **运行消息进日志，页顶横幅走全局浮层**：`agent/notice` 与会话释放消息进入「日志」分区，**追加序、新条目在前、最多 200 条、仅浏览器内存（刷新清空）、未读圆点进入该分区即清零**；空闲释放（cause `idle`）不记。设置页自身动作失败留在页头 `notice`；保存横幅（`SaveGuardToast`，`shell.overlay`）是**全局页顶横幅**，固定浮层、`top: 16px`、水平居中、`max-width: min(420px, calc(100vw - 40px))`、`max-height: calc(100vh - 32px)` 且可滚动，**不嵌在设置页**，暂存条与横幅共用这个浮层。来源为保存 / 热重载终态（`save-failed` / `save-expired` / `save-rejected` / `save-partial` / `save-succeeded` + `hmr-delay`，热重载延迟**不是保存终态**），加手势反馈行（`save-cancel-failed` / `save-cancelled` / `save-retry-none` / `save-retry-failed` / `agent-deleted`）。失败行常驻到用户关闭且**不因数量丢弃**；失败超过 6 条折叠为「还有 N 条失败」并可展开，**折叠控件放在失败行之前**。成功行最多一条、2.5 秒后自动消失；**同一帧多个保存成功合成一条**，正文列出保存的 agent 名（超过 3 个只列前 3 个并写「等 N 个」），保存成功日志仍逐条带 label。同一 agent 保存成功后只清除它自己的旧失败 / 过期 / 被拒行与重试登记，不波及其他 agent。**关闭记录按 `banner.key` → `banner.at` 存 `sessionStorage`**，只对带 `persistAcrossReload` 的门禁 `failed` / `expired` 行跨刷新生效；首帧 SSE 播种用「该 label 上一份快照无终态」判定，不比较时间窗。同一 `key` 的原因**替换**上一行而不叠加，关闭后同因再次出现照常显示。错误行 `role="alert"` + `aria-live="assertive"`，成功 / 暂存行 `role="status"` + `aria-live="polite"`，都带 `aria-label`；**Escape 由页面级监听关闭最新一条**，焦点在 `input` / `textarea` 时不拦截。重试不可用时用 `save-retry-none` 成功回执替换该行，**不回落为全局强制保存**。
  - 会话释放按宿主 `cause` 分别写日志（`workspace` info；`resume-failed` / `stalled` / `died` error；旧宿主缺 cause 按 `died`）。
  - 子进程启动失败且同一 agent 还有健康进程时，聚合状态仍是 `ready`，日志补一条含 `failed to start` 的 error 行；同一失败只记一次（[protocol.md §5](./protocol.md)）。
  - 日志分区**条件渲染**（不挂 `hidden`）：它是无状态列表，常驻会在每条 `session/update` 时重排 200 行；进入分区才生效的 `markLogsRead` 清掉圆点。每行是本地 `HH:MM:SS`（`logClock`，不用 `toLocaleTimeString`）+ 级别徽标 + 可选 agentId + 原文。
- **门禁快照的可信度**：只有 `gateAvailable === true` 的 `save/status` 快照可信；缺失该字段的快照归一为 `false`。不可信快照的 `activeSessions` 不作为空闲证据，表单改用本地会话列表兜底（排除 released），是否弹确认仍由宿主 `agent/save` 的 `confirmationRequired` 决定。
- **取消的校验**：`save/cancel` 只认 `typeof cancelled === 'number' && cancelled > 0`；`cancelled: 0` 时回读 `save/status` 复核：只有该 label 已不在 `pending` 且终态是 `cancelled` 才算成功，否则出 `save-cancel-failed` 横幅并保留暂存。取消在飞期间用户继续编辑，面板比对最新表单签名后再发一次取消。
- **门禁终态文案**：`superseded: true` 的 `cancelled` 不显示成用户取消；同 label 重新入队会移除旧「已取消暂存」行，任何路径都移除。`agent_deleted` 单独文案，只给关闭、不保留重试 payload；客户端本地镜像已删除 id，新建表单提前禁用该 id。
- **重试三态**：只有布尔 `retried === true` 算成功，`retried === false` 才回「无待重试项」（`save-retry-none`）；运输失败、非法返回与 `unsupported` 走独立的 `save-retry-failed` 错误回执。
- **「全部立即保存」**：`pending` 条目 ≥2 或不同 label ≥2 时才出现；点击前确认，列出会被中断的 Agent 与各自活动会话数；执行走既有 `save/flush`（`forceSaveGate`），不新增 RPC；部分失败显示 `save-partial` 并列出未写入的 label。单个 Agent 的按钮文案是「立即保存（中断该 Agent）」，确认卡只列该 Agent 的会话。
- **审批时限卡**（`ApprovalDeadlinesCard` / `DeadlineModeBlock` / `DeadlineSliderBlock`）只有**两个控件**：超时处理方式（三档互斥按钮）+ 等待时长（一根滑块），热生效、不重启（取值三层与覆盖语义见 [permissions.md §2.4](./permissions.md)）。**只有一个等待窗口**：对话卡片里的询问与设置页镜像里的询问问的是同一个问题，所以共用一个答案——两个窗口曾把卡变成三行看不出关联的旋钮，用户还得防着两处配出互相矛盾的值。模式按钮**整宽排布**（`.dwa-seg-wide`）：右对齐的 seg 会把「一直等待 / 自动推进 / 超时中止」挤成两行字（「中/止」「自动推/进」），读起来像坏了。滑块档位是刻度（不等待 / 30 秒 / 1 分钟 / 5 分钟 / 15 分钟 / 30 分钟 / 1 小时 / 6 小时，「不等待」只在自动推进档出现，超时中止档从 30 秒起）；「一直等待」**不是一档**，它由模式表达——同一件事不在两个控件里各说一遍。配置文件写的窗口若不在档位上，**照原值运行**，卡片显示精确数字并把滑块停在最近的档位上——滑块不许谎报正在生效的数。宿主没有这条 RPC 时整卡不渲染——不显示浏览器自己编的数。
- **进程管理卡**（`IdleReleaseCard`）只有**一个控件**：空闲释放窗口（一根滑块，1 分钟起、其后每 5 分钟一档到 1 小时）。它管的是**聊天进程**的空闲释放，探测进程那 5 分钟窗口固定不变——两档窗口的语义见 [protocol.md §5](./protocol.md)。CodeBuddy 的每个聊天会话各有一个独立进程（A1），窗口对每个会话进程分别计时：释放一条会话的进程不影响其他会话，其他会话下一条消息仍由自己的进程服务。滑块档位是**共享阶梯** `IDLE_RELEASE_MS`（浏览器与宿主共用），所以滑块能出的值一定是宿主会跑的值；部署基线写的窗口若不在档位上，**照原值运行**，卡片显示精确数字并把滑块停在最近的档位上——滑块不许谎报正在生效的数。宿主没有这条 RPC 时**整块不渲染**（连同导航项）——不显示浏览器自己编的数。**重置按钮只在真被覆盖时出现**，且按钮文案说清回到哪里：部署写了窗口就写「恢复配置文件的值」，没写就写「恢复默认值」；部署写的窗口被压过时，那条「配置文件设为 X，此处设置优先」必须**看得见**（警告色），没有被压过就不说——没人主张过的胜权不该被宣称。
- **per-agent 的空闲释放是「覆盖」不是「第二份窗口」**：agent 高级页的那个输入框留空即**跟随全局**，只填自己显式要的值。**严禁**把宿主解析出的窗口回填进该 agent 的定义——回填等于把全局窗口冻结进这个 agent，全局滑块就再也到不了它。
- **两个控件必须说成一套**：卡片有一句话把时长与模式接上（「超过该时长仍未应答，将按上方所选的方式处理。」）。三行版最大的失败不是难看，是用户**猜不出三个控件是不是有关系**；现在只剩两个，且它们的关系被写了出来。
- **超时处理方式不能只写名字**：三个按钮（一直等待 / 自动推进 / 超时中止）下面必须有一行说明**当前档**的动作，且**两条说明不得说同一件事**——「自动推进」写「超过设定时间未应答，自动代替你选择一个选项让 agent 继续执行」，警告另起一条写「请确保你的 agent 值得信任，请谨慎选择」。否则「自动推进」会读成「界面自己往下滚」。这一行**只写动作**，不解释「为什么原来要转移」——那段历史写进文档，不写进 UI。
- **`wait` 档下滑块不生效**：不设期限时不能留着「等待时长」配一个永不触发的数字，此时**不画滑块**、读数写「一直等待」、说明改成「选择「一直等待」时不设超时时长。」存着的窗口不被改写（模式写只带模式），切回来时原样回来。
- **「不等待」只属自动推进**：滑块从左到右读作「等得越久越有耐心」，最左就是最不等——`0` 档的请求到达即代答，agent 继续。「超时中止」那一档**没有**这个刻度（从 30 秒起）：同样的 0 在那里是立刻拒绝每一问，agent 在每个门口都停住。「一直等待」属于模式轴（`wait`），时长轴不再重复它。
- **覆盖事实挂在被覆盖的那一行**（`.dwa-deadline-flag`，警告色，紧贴它说的那个控件）；重置按钮**只有真的覆盖了才出现**。
- **设置页文案有预算**：一个控件的说明**一行讲完**，机制解释进代码注释与 `AGENTS/`，不进 UI。同页参照是「呼吸频率 10 字 / 挂牌光晕 14 字 / 标题标识 15 字 / 对话外观导语 15 字」——审批时限卡曾用 211 字铺满一张卡、两个旋钮埋在灰字里，压到 86 字后又回到 90 字（三行版），现在是**两个控件**：默认档 57 字，`auto` 档 95 字（多出的全是那句警告）；别把整页拉回长文。措辞取**正式陈述**（「超过设定时间未应答，自动代替你选择一个选项让 agent 继续执行」），不要口语化的拟人说法（「没人回答就替你选一个选项放行」）——后者两句话读起来像同一件事。
- **NTR agent 保存门禁**：保存前读 `save/status`；目标 agent 有活动会话时弹「取消 / 回合结束后保存 / 立即保存并中断」三键确认，并列出受影响的会话（**排除已 released 的会话**）。无活动回合直通、不弹框。选「回合结束后保存」后，表单说明这是点击时快照，继续编辑会 `save/cancel` 并提示重新保存；**暂存态以 `save/status` 的 `pending`（按 label）为准**，`deferRequested` 只在首帧 `pending` 到达前兜底；终态只在主机 `lastOutcomes.at` 与入队时记录的 `deferOutcomeAt` 不同时结算该次暂存（主机时钟的身份比较，不混用浏览器时钟）——关闭设置面板或刷新页面后仍显示「配置已暂存」。取消必须按返回的 `cancelled` 校验，RPC 失败时**保留暂存态**并出警示横幅。旧宿主没有 `save/status` 时隐藏暂存键，用本地会话行兜底；只有取消与立即保存。行内「移除配置 / 停止当前运行实例」的确认卡显示将影响的会话数（门禁活动会话与本地未关闭会话的并集，**排除 released**）。`save-rejected` 在当前面板不可达：面板总带 `saveMode`，只有旧宿主忽略它、或外部 RPC 调用方不带 `saveMode` 而目标忙碌时才会出现。
- **Agent 删除的窄窗口**：`agent/delete` 返回 `persist_failed` 时客户端把该 id 记入本地已删除镜像并禁用新建表单里的同名 id；删除后的 id 仍可能从磁盘复活（见 §8.2）。
- 工作区保存语义：单根模式（非空 `cwd`）把 `allowedCwdRoots` 收窄为 `[cwd]`；`cwd` 为空则两者都不发送（走宿主 `defaultAgentWorkspace()`）；多根模式发送编辑后的去重绝对路径。初始状态带 >1 个 root 的 agent 必须直接进多根模式，避免仅仅打开表单就收窄白名单。
- 审批卡：对话内的主答案面是 `PermissionDock`（见 [conversation-dock.md §10](./conversation-dock.md)），本页那张「待处理权限请求」是跨会话镜像。权限语义与期限见 [permissions.md](./permissions.md)。

### 8.1 版本徽标与内置更新

- **版本徽标是更新卡入口**（`.dwa-version`）：只读 `ui.pluginVersion`（`plugin/version`），宿主不答就整块不渲染——浏览器不编版本号。`ui.pluginUpdate` 存在且状态不属于 `unsupported` / `not-installed` 时，徽标渲染成 `<button>`（`versionOpensUpdate`），带 `aria-expanded` 与 `aria-controls="ntr-plugin-update-card"`，点击开合更新卡；含 `current` / `failed` / `busy` / `source-install` / `managed` 在内都能从这里打开。否则只是普通 `span`。`source-install` 额外挂 `title`「源码或本地安装，无法通过 registry 更新」。
- **更新徽标**（`PluginUpdateBadge`，文案在 `updateBadgeText`）只在这些状态出现：`available`「可更新 vX」、`applying`「更新中…」、`applied`「已更新 vX」、`restart-required`「待重启 vX」——**最后一种只有 `installed` 存在时才挂**（apply 中断时磁盘状态未知，不编版本号）。**每个徽标都是可点按钮**（`applying` 也是），带同样的 `aria-expanded` / `aria-controls`：安装中的结果只能从卡片读。`current` / `busy` / `failed` / `unsupported` / `not-installed` / `managed` / `source-install` 不挂徽标——版本徽标本身就是入口。
- **更新卡**（`PluginUpdateCard`）在页头下方**就地展开**，不用模态：设置页已经握着那一个动作，模态会盖住它正在说的版本。容器带 `id="ntr-plugin-update-card"`、`role="group"`、`aria-label`「插件更新」。`updateCardVisible` 只在 `open` 且状态不属于 `unsupported` / `not-installed` 时画（`source-install` / `managed` 也画，各自说明为什么不能在这里更新）。摘要行是「当前 vX → 最新 vY」；宿主没报 `latest` 时只有当前版本。磁盘版本与运行版本不同（装完没重启，可能更高也可能更低）时多一格「磁盘 vZ」，有合法 `publishedAt` 时在末尾附日期。
- **动作**：仅 `available` 有「更新」，送的是 host 报的那个**精确版本**（`applyPluginUpdate(update.latest)`）；`applying` 时主按钮变成禁用的「正在更新…」；「关闭」收起卡片，但 `applying` 时不画；「重新检查」始终在（`applying` 时禁用），走 `checkPluginUpdate(true)` 跳过 store 的 10 分钟节流。安装**只能**由这一下点击发起——挂载只做检查。
- **每个状态一行话**（约束 33）：`available`「更新会卸载并重装插件，之后可能需要重启 DSH。」/ `applied`「已应用，刷新页面即可使用新版本。」/ `restart-required` 分两种：`installed` 存在 → 「磁盘已是 vX，重启 DSH 后生效（桌面 App 退出重开；命令行重启 dsh web）。」；`installed` 缺失（apply 响应中断、磁盘状态未知）→ 「更新可能已完成，请刷新页面确认当前版本。」——**中性**，因为磁盘版本可能比运行版本高或低，绝不写「已更新」/ `busy`「有进行中的对话，结束后才能更新。」/ `failed`「更新失败。」/ `current`「已是最新版本。」/ `source-install`「源码或本地安装，无法通过 registry 更新。」/ `managed`「此安装由宿主管理，不能在这里更新。」。`applying` 无说明行，只有摘要与禁用按钮。宿主原始 `message` 是唯一的长文本，单独一行（`failed` / `busy` / `managed`），靠 CSS 折行，不改写、不截成半句。
- 颜色只走宿主 alias token（约束 34）：徽标是 `state-business-tertiary` 底 / `state-business-primary` 前景；卡片就是普通 `dwa-card`，失败不另造一套红色。
- 检查随设置页挂载自动触发（`AcpSettingsSection` 的 `useEffect`）；两个入口（宿主外壳 / 对话内对话框）挂同一个组件，store 的 10 分钟节流与 in-flight 去重因此只按一份算。双击「更新」被 store 的 `pluginUpdateApplying` 挡住；apply RPC 因插件被卸载而中断时，store 写 `restart-required` + notice「更新请求已中断；请刷新页面确认当前版本。」并清掉 `installed`，卡片只说「更新可能已完成，请刷新页面确认当前版本」，不编磁盘版本。`pluginUpdateGeneration` 让晚到的 check 结果无法覆盖 apply 的终态。旧宿主没有这个端点：`checkPluginUpdate` 静默吞掉 `unknown endpoint` 并回 `undefined`，面板把更新入口整块藏掉，不写 notice。

### 8.2 已知边界

- 删除写盘失败后墓碑只在进程内有效：重启前若没有一次成功写盘，旧 agent 仍可能从文件复活；RPC 已返回 `persist_failed`。
- `stopAgent` 的非严格持久化失败只发通知；磁盘可能保留旧 `chatSessions`，重启后可能恢复可 resume。
- 同一毫秒 `at` 碰撞时，首帧播种会把同 label 的新失败误判为已关闭。
- 直接保存成功后若宿主 `lastOutcomes` 仍保留旧失败、且上一份快照未持有该终态，resync 有窄窗口重新播种。
- 单个 Agent 的强制保存不再顺带救活其他临近超时的暂存，它们会留到空闲边界或超时 `expired`。
- 显式取消在全局浮层静默，只有设置表单与日志里有提示。
- 同一帧多个成功只留一条成功行；超过 3 个只点名前 3。

## 9. 双语文案与语言切换

- 调用点一律写 `label(zh, en)` 对（`AcpStore.label`，实例绑定，可安全交给 memo 行）；运行时经宿主 `ctx.locale.resolveText({ zh, en })` 解析当前语言。`locale` 服务按 `ctx.get` 结构化读取（`LocaleFace`），缺失时回落到 `navigator.language`（`browserPrefersZh`）——不允许因此加载失败。
- 热切换：`index.tsx` 订阅 locale 服务（`internal/service` 兜底晚到），回调 `store.refreshLocale()` **重新发布快照**（`localeRev` 自增）；`useSyncExternalStore` 因此重跑渲染期 `label()`。memo 化的 transcript 行（`BlockView`）props 不变就不会重渲染，所以它必须拿到 `localeRev`。切换不改数据，只改解析结果。
- 已定型字符串不随切换回译：notice、日志条目、权限标题兜底在事件发生时解析。唯一例外是 `detectSummary`——store 记住 `detectCounts`，在 `refreshLocale` 里重建，避免旧语言的成功行留在设置页。
- 插件卡标题 / 描述不走这套：包内 `locale/en.json` / `locale/zh.json` 的 `meta.description` 由宿主 `readPluginMeta` 读取，经 `exports` 的 `./locale/*.json` 暴露。`en.json` 必须存在且与 `package.json.description` 一致（回退值），缺它整组本地化不生效。

## 11. 主题与颜色

主题完全归宿主：暗色 token 由 `body[data-ds-dark-theme]` 选出，原生控件（select / checkbox / 滚动条）靠宿主写在 `documentElement` 上的 `color-scheme` 继承。插件**不维护 JS 侧主题状态**，也**严禁**自己写 `color-scheme: light dark`——那会跟随系统偏好而不是宿主偏好，两者不一致时面板会和宿主断层。

- **写死颜色只允许出现在 `var()` fallback 位**：`var(--dsw-alias-state-error-primary, #dc2626)`。宿主有 token 时跟随主题，缺 token 时保持原浅色。
- **状态色按宿主配对**：`state-success|warn|business-tertiary` 作底，`state-*-primary` / `state-warn-label` 作前景；危险 hover 用 `interactive-bg-hover-danger`；diff 行用 `file-diff-added|deleted-bg`，统计数字用 `state-success|error-primary`；内联代码底用 `markdown-inline-code`；状态点用 `state-success|warn|error|idle-primary`。需要浅色文字对比时按宿主写法 `color-mix(in srgb, state-success-primary 72%, label-primary)` 派生，不为每种主题写死两份。
- **宿主没有的 token**（引用它们只会永远落 fallback）：`--dsw-alias-text-primary` / `text-secondary` → `label-primary` / `label-secondary`；`--dsw-alias-button-primary-invert` → `label-primary-foreground`；`--dsw-alias-font-mono` → `--ds-font-family-code`。新增 token 引用前先在本机 DSH 的 `dsh-client-ui-theme/lib/client.js` 里核对定义。
- `.ntr-acp-code` 的固定深色块（`#0f172a` / `#e2e8f0`）是有意的：两套主题下都可读，不参与 token 化。阴影 `rgba(0,0,0,α)` 同理可接受。

## 代码索引

| 主题 | 位置 |
|---|---|
| 保存门禁横幅 | `src/client/save-guard-toast.tsx` · `SaveGuardToast` / `saveGuardToastKind`；`src/client/store.ts` · `SaveBanner` / `pushSaveBanner` / `dismissBanner` / `retryBanner` / `forceBanner` / `reportFlushResult` / `saveGateInterruptTargets`；`src/client/index.tsx` · `acp-save-guard-toast` 注册处 |
| 文案 | `src/client/index.tsx` · `label` / `LocaleFace` / `browserPrefersZh`；`src/client/store.ts` · `refreshLocale` / `detectSummaryOf`；`locale/*.json` |
| 设置页 | `src/client/panel.tsx` · `AcpSettingsSection` / `AgentRow` / `WorkspaceBlock` / `initialForm` / `buildPayload` / `ApprovalDeadlinesCard` / `approvalDeadlineFacts` / `permissionLedgerCard` / `agentTestHint` / `AgentTestOutcome`；`PluginUpdateBadge` / `PluginUpdateCard` / `updateBadgeText` / `updateCardVisible` |
| 设置对话框 | `src/client/settings-dialog.tsx` · `AcpSettingsDialog`；`src/client/acp-ui.tsx` · `openAcpSettingsDialog` / `closeAcpSettingsDialog` / `useAcpSettingsDialogOpen` |
