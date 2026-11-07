# 对话内 dock：权限卡与横幅

本文是 [AGENTS.md](../AGENTS.md) 的展开层，覆盖 `conversation.input.dock` 的三个事务条目（权限卡 / 释放横幅 / 限流横幅），自 [ui.md](./ui.md) §10 家族拆出，节号沿用全仓连续编号。座位、芯片、视图、消息动作仍在 [ui.md](./ui.md)；设置页与保存横幅见 [ui-panel.md](./ui-panel.md)。
三条都是纯附加条目：帧集合 / 行集本身就是闸门，本会话没有该事务就不渲染，普通会话不会凭空多一张卡；注册与隔离检查的总规矩见 [ui.md §7](./ui.md)。

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
- **行集不许倒退**：`src/client/store.ts` 的 `readChatSessionList` 在读发出前记下 `chatRowFrameSeq`，读回后用 `replayChatRowFrames` 重放在途期间到达的 `session/released` / `session/reset` / `session/created` / `session/closed` 帧。一份恢复前的旧快照否则会盖掉 `session/reset` 的翻转，横幅就挂在一个已经有 live 进程的回合上。重放只改读回行集里已有的行，不追加别的会话的行（新建行由下一次读带回）。`turn/start`、`session/chat-resume`、`resync` 走 `loadChatSessions(..., { force: true })`：复用 `abandonChatSessionRead` 丢掉在途旧读，每轮向宿主拿一次真实行集；并发读者仍由 in-flight 去重合成一次读。
- **按钮**走 `session/chat-resume`（`AcpStore.resumeChatSession`），与下一条消息的惰性恢复同一套动作、绝不走创建路径（[protocol.md §2](./protocol.md)）。失败闪 notice **并** rethrow（`respondPermission` 契约），错误就地钉在按钮旁（`role="alert"`），不丢到用户可能没开的设置页。提交中按钮 `disabled`。
- **挂载自读一次** `loadChatSessions`：打开一条已挂起的会话时，没有任何别的东西会替它读这份清单（挂牌、占用环的重读都挂在别的触发器上）。
- **横幅跨 DSH 重启存活**：会话记录持久化（[state.md §3.1](./state.md)），重启后记录以 released 复原，横幅与「恢复进程」照常——否则重启就等于把「released ≠ 销毁」丢掉。重启后到恢复前 NTR 视图的空流说「历史将在恢复后回放显示」（`historyAwaitsReplay`，见 [ui.md §5](./ui.md)），不说「还没有消息」。
- 宽度复用权限卡的 InputBar 公式（`.ntr-released-banner`），样式与 `ntr-permission-card` 同族（warn 左边条）；行集的 released 翻转见 [ui.md §2](./ui.md) 耦合不变量。
- **A1 下每条 CodeBuddy 会话独立进程**：崩溃或空闲释放只把这一条会话的行集变成 `released`，兄弟会话的进程照常活着，横幅不因兄弟会话而提前消失，也不因兄弟会话崩溃而误挂；「恢复进程」只重启本会话的进程。
- **停止窗口内的消息直接失败**：设置页保存 / 删除 / 停止该 agent 期间到达的聊天消息以 `agent_stopping` 失败，不排队；停止完成后下一条消息正常新建进程（[protocol.md §1](./protocol.md)）。

### 10.2 限流横幅（`acp-quota-banner`，同座）

agent 因配额拒绝本轮时，`conversation.input.dock` 的第三条目 `QuotaBanner`（`src/client/quota-banner.tsx`）在输入框上方显示一行「agent 已限流」+ agent 自己的原文。

- **为什么必须有这一行**：CodeBuddy 对超配额的 `session/prompt` 走 **resolve**（`stopReason: "refusal"`），原因只在响应 `_meta["codebuddy.ai/errorMessage"]` 里，错误路径与 `describeError` 都看不到它。于是回合干净结束、没有报错面、没有 notice——用户的消息看起来被接受了然后被无视。这一行把原因钉在用户正在看的地方。
- **闸门是纯函数** `quotaRefusalMessage`（无 DOM 可测）：显式 `acpMode === false` 压过残留行；`chatSessionsFor` 必须等于本会话；然后**逐条扫过本会话所有活 `ChatSessionView` 行**（parked 行归释放横幅，且宿主在释放边界清掉 refusal），按该行的 `sessionId` 找**活且未关闭**的 `SessionView` 并读 `quotaRefusal.message`。`SessionView` 不带 DSH 会话 id，活 chat 行是唯一的桥——兄弟会话的 refusal 因此天然漏不进来。**严禁**只取第一条活行：宿主允许两条 LiveSession 短暂共用一个 chat id（并发首轮，见 `session.turnController` 处注释），落在第二条行上的限流必须也看得见。字段缺失（旧宿主半区）一律不渲染。
- **正文是 agent 原文，逐字**：重置时间在里面，是用户唯一需要的事实；**严禁**改写、截断或总结。**没有按钮**：模型 picker 就在 composer 里，切不切模型是用户的决定，卡片不替他做。
- **瞬态**：宿主在下一条非限流响应与每个生命周期边界（close / release / resume / forceReset）清掉它并广播 `session/meta`，横幅随之消失；它**绝不**落进 `agents.json` 的 `chatSessions`。注册 `order: 30`（权限卡 10、释放横幅 20 之后），**无条件注册 + 组件自门禁**，与权限卡同 pattern——**不要**改挂 `syncAcpMode` 的 `holdAuxEntries`（那是 `list` 投影槽的规矩，见 [ui.md §7](./ui.md)）。
- 宽度复用 InputBar 公式（`.ntr-quota-banner`），配色走仓库既有的 `state-error-tertiary` 底 / `state-error-primary` 前景（与 `panel.tsx` 的日志错误行同一对，`var()` 里带 fallback）。`src/` 与 `node_modules/@deepseek-ai/` 里都 grep 不到 `state-danger-*`，宿主 bundle 本身也只引用 `state-error-primary`——所以「宿主有 danger 档」这一条我核实不了，写成约定而非事实；宿主真新增 danger 档 token 时再改（约束 34）。

## 代码索引

| 主题 | 位置 |
|---|---|
| 权限卡 | `src/client/permission-dock.tsx` · `PermissionDock` / `PermissionAskCard`；`src/client/store.ts` · `permissionsForSession` / `deadlineRemainingLabel`；`src/client/index.tsx` · `acp-permissions` 注册处 |
| 释放横幅 | `src/client/released-banner.tsx` · `ReleasedBanner` / `releasedBannerVisible`；`src/client/store.ts` · `resumeChatSession` / `withSessionReleased`；`src/client/index.tsx` · `acp-released-banner` 注册处 |
| 限流横幅 | `src/client/quota-banner.tsx` · `QuotaBanner` / `quotaRefusalMessage`；`src/client/index.tsx` · `acp-quota-banner` 注册处；`src/bridge.ts` · `agentRefusalDetail` / `snapshot` 的 `quotaRefusal` |