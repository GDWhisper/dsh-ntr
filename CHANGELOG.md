# Changelog

面向用户的版本改动记录，从 0.2.0 起维护。只记每一版留下的确定性净改动；被推翻、回退或只在开发过程中存在过的中间形态不记。条目与 GitHub Release 用同一套话，规则见 [AGENTS.md](./AGENTS.md) 约束 35。

## [Unreleased]

带工具调用的回合恢复正常：跑完、给出回答，工具卡显示真实输出（[#10](https://github.com/GDWhisper/dsh-ntr/issues/10)）。

### 修复

- **acp**：派了后台 worker 的回合，在 worker 卡着一个未完成的工具调用时改用更长的静默窗等它（`backgroundTaskToolMs`，默认 30 分钟），迟到的报告不再丢。([3151282](https://github.com/GDWhisper/dsh-ntr/commit/3151282))
- **acp**：带工具调用的回合跑完并给出正文回答，不再在工具卡之后立刻结束、界面只显示「已完成」。([0aac54a](https://github.com/GDWhisper/dsh-ntr/commit/0aac54a)) ([#10](https://github.com/GDWhisper/dsh-ntr/issues/10))
- **acp**：宿主的记忆召回一类上下文注入不再进入 NTR 会话的消息记录。([0aac54a](https://github.com/GDWhisper/dsh-ntr/commit/0aac54a)) ([#10](https://github.com/GDWhisper/dsh-ntr/issues/10))
- **acp**：聊天里的工具卡显示该次调用的真实输出，不再是「ran inside the ACP agent process」占位文字。([864ccb3](https://github.com/GDWhisper/dsh-ntr/commit/864ccb3)) ([#10](https://github.com/GDWhisper/dsh-ntr/issues/10))

---

### Fixed

- **acp**: a turn that dispatched a background worker waits on a longer silence window while the worker sits inside an unfinished tool call (`backgroundTaskToolMs`, 30 minutes by default), so a late report is no longer lost. ([3151282](https://github.com/GDWhisper/dsh-ntr/commit/3151282))
- **acp**: a turn that calls a tool runs to completion and answers in prose instead of ending right after the tool card with only "已完成" in the UI. ([0aac54a](https://github.com/GDWhisper/dsh-ntr/commit/0aac54a)) ([#10](https://github.com/GDWhisper/dsh-ntr/issues/10))
- **acp**: host context injections such as memory recalls no longer enter an NTR conversation's message record. ([0aac54a](https://github.com/GDWhisper/dsh-ntr/commit/0aac54a)) ([#10](https://github.com/GDWhisper/dsh-ntr/issues/10))
- **acp**: a tool card in the chat shows that call's real output instead of the "ran inside the ACP agent process" pointer. ([864ccb3](https://github.com/GDWhisper/dsh-ntr/commit/864ccb3)) ([#10](https://github.com/GDWhisper/dsh-ntr/issues/10))

## [0.3.9] - 2026-11-05

修复 DSH 0.2.2 及更新版本上 NTR 会话无法发送消息的问题。

### 修复

- **acp**：DSH 0.2.2 及更新版本上的 NTR 会话恢复正常发送消息，不再在发送时以路由错误失败。([889cc20](https://github.com/GDWhisper/dsh-ntr/commit/889cc20))

**Full Changelog**: https://github.com/GDWhisper/dsh-ntr/compare/v0.3.8...v0.3.9

---

NTR conversations send normally again on DSH 0.2.2 and newer.

### Fixed

- **acp**: NTR conversations on DSH 0.2.2 and newer send messages normally instead of failing with a route error. ([889cc20](https://github.com/GDWhisper/dsh-ntr/commit/889cc20))

**Full Changelog**: https://github.com/GDWhisper/dsh-ntr/compare/v0.3.8...v0.3.9

## [0.3.8] - 2026-11-05

### 新增

- **acp**：agent 因频率限制拒绝本轮时，输入框上方显示一行「agent 已限流」，正文用 agent 自己写的说明（含重置时间）；没有按钮，切换模型走 composer 里的模型菜单。
- **acp**：agent 以 `refusal` 拒绝本轮且没有正文时，说明里带上 agent 自己给出的理由，不再只说「没有可见输出」。

### 修复

- **acp**：guard 剥离 `runtime-context`、`agent-instructions`、`skill-catalog`、`plugin` 四类来源；只含 `runtime-context` 的唤醒轮以空批次进入，工具续跑步只把过滤后的工具消息交给 adapter，两者都不再以 `blocked` 收尾。([32b8081](https://github.com/GDWhisper/dsh-ntr/commit/32b8081))

---

### Added

- **acp**: when the agent refuses a turn because it is rate limited, one row above the input box says "agent 已限流" and repeats the agent's own message (reset time included); there is no button — switching models stays in the composer's model menu.
- **acp**: when the agent refuses a turn with no prose, the note quotes the agent's own reason instead of only saying "no visible output".

### Fixed

- **acp**: the guard strips `runtime-context`, `agent-instructions`, `skill-catalog`, and `plugin`; a `runtime-context`-only wake turn enters with an empty batch, and tool continuations pass only filtered tool messages to the adapter, so neither ends as `blocked`. ([32b8081](https://github.com/GDWhisper/dsh-ntr/commit/32b8081))

**Full Changelog**: https://github.com/GDWhisper/dsh-ntr/compare/v0.3.7...v0.3.8

## [0.3.7] - 2026-11-05

CodeBuddy 的每个聊天会话使用独立子进程，多会话并行互不影响；回合进行中保存配置不再打断对话，暂存、失败与重试都能看见。

### 新增

- **acp**：CodeBuddy 的每条聊天会话使用独立 ACP 子进程，多会话各自独立运行；目录探测使用一次性进程，探测结束立即回收。([ee78ac2](https://github.com/GDWhisper/dsh-ntr/commit/ee78ac2))
- **acp**：首轮失败并回滚的会话立即回收自己的子进程，不在后台常驻；会话关闭但 `session/prompt` 尚未结算时，回收与工作区搬迁保留进程，直到请求落地。空闲释放只等 live 或 released 会话上的待答请求，已关闭会话的残留请求不阻止进程回收。([ee78ac2](https://github.com/GDWhisper/dsh-ntr/commit/ee78ac2))
- **acp**：单个子进程启动失败、同一 agent 还有健康进程时，仍然写一条含 `failed to start` 的错误日志，同一条失败不重复提示。([ee78ac2](https://github.com/GDWhisper/dsh-ntr/commit/ee78ac2))
- **acp**：测试新增 A1 集成用例，覆盖每会话一进程、停止窗口、首轮回收、未结算 prompt 保护、空闲释放越过已关闭会话的待答请求、恢复在途归属、聚合状态、启动失败通知与 fork 禁用。([ee78ac2](https://github.com/GDWhisper/dsh-ntr/commit/ee78ac2))
- **acp**：保存 NTR agent 配置时若目标 agent 正在跑回合，可以选「回合结束后保存」或「立即保存并中断」；选择回合后保存会冻结点击时的配置，继续编辑则取消暂存并提示重新保存。
- **acp**：保存结果在页顶提示：失败、等待过期、被拒绝、强制保存只完成一部分都常驻并给出重试或强制保存；成功短暂显示后自动消失。
- **acp**：删除或停止 agent 前显示将影响的会话数。
- **acp**：多个 agent 有暂存时可「全部立即保存」；确认卡列出会被中断的 Agent 与各自会话数，部分失败会列出未写入的 agent。
- **acp**：同一帧多个 agent 保存成功只显示一条成功行，正文列出保存的 agent 名；超过 3 个时列前 3 个并注明总数。
- **acp**：删除 agent 后，它的暂存保存显示单独的「该 Agent 已被删除」行，只给关闭。

### 改进

- **acp**：停止、保存或删除 agent 时进入停止窗口；窗口内到达的消息直接失败，不排队，停止完成后下一条消息新建进程。([ee78ac2](https://github.com/GDWhisper/dsh-ntr/commit/ee78ac2))
- **acp**：恢复在途时复用同一个 ACP 会话，不新建第二个；会话归属丢失时返回 `session_orphaned`，下一条消息重新创建，不落到其他会话的进程。([ee78ac2](https://github.com/GDWhisper/dsh-ntr/commit/ee78ac2))
- **acp**：同一 agent 的多进程状态聚合成一条：任一进程可用即为可用，全部崩溃或释放为已停止；单条启动失败不会拖累健康 agent 的聚合状态。([ee78ac2](https://github.com/GDWhisper/dsh-ntr/commit/ee78ac2))
- **acp**：CodeBuddy 的 fork 能力关闭，分支入口禁用；即使对端声明支持，请求也返回 `fork_unsupported`。([ee78ac2](https://github.com/GDWhisper/dsh-ntr/commit/ee78ac2))
- **acp**：活动回合期间 HMR 替换被延迟，回合结束后自动重试，连续失败或回合长时间不结束会提示一次；插件设置保存可选择延后。DSH 设置写入本身不经本仓拦截，宿主补丁到位前不会自动排队。
- **acp**：同一 agent 连续保存时，旧的暂存不会在回合结束后覆盖新值；删除 agent 会先取消它的暂存，避免配置被写回。
- **acp**：单个 agent 的「立即保存」只处理该 agent，不再顺带写入其它 agent 的暂存；全局冲刷仍走「全部立即保存」。
- **acp**：保存与删除在无法写盘时明确失败，不再静默成功；写盘失败时内存保持旧配置。
- **acp**：只有门禁明确报告可用时才按门禁活动会话判断空闲，否则改用本地会话，避免把不完整快照当成空闲证据。
- **acp**：关闭的失败 / 过期提示刷新后不再出现；同一 agent 的新保存会清掉它旧的失败提示与「已取消暂存」行。
- **acp**：取消暂存与重试保存只在收到明确结果时算成功；被新保存取代的取消不再显示成用户取消。
- **acp**：删除或停止 agent 后，迟到的模型探测结果不再写回目录。

### 修复

- **acp**：切换超时处理方式不再改写已保存的等待时长；「不等待」在切到「超时中止」时只在运行时按 30 秒生效，切回「自动推进」或重启后仍是「不等待」。已被旧版本写成 30 秒的记录需要重新选择一次「不等待」。

---

Each CodeBuddy chat session runs in its own process, so sessions run in parallel without affecting each other; a save still does not interrupt a running conversation, and held saves, failures and retries are all visible.

### Added

- **acp**: each CodeBuddy chat session runs in its own ACP child process, and catalog probes use a one-shot process that is reclaimed as soon as the probe ends. ([ee78ac2](https://github.com/GDWhisper/dsh-ntr/commit/ee78ac2))
- **acp**: a session that fails its first turn and rolls back reclaims its child immediately instead of leaving it resident; while `session/prompt` is still unanswered, pruning and workspace moves keep the process alive until the request settles. Idle release counts only prompts on live or released sessions, so a leftover request on a closed session does not block reclaiming the process. ([ee78ac2](https://github.com/GDWhisper/dsh-ntr/commit/ee78ac2))
- **acp**: when one child fails to start while a sibling is healthy, the plugin still logs one error line containing `failed to start`, and the same failure is not reported again. ([ee78ac2](https://github.com/GDWhisper/dsh-ntr/commit/ee78ac2))
- **acp**: new A1 integration tests cover one process per session, the stopping window, first-turn rollback, unanswered prompt protection, idle release past a closed session's unanswered prompt, in-flight resume ownership, aggregate status, start-failure notices and disabled fork. ([ee78ac2](https://github.com/GDWhisper/dsh-ntr/commit/ee78ac2))
- **acp**: when the target agent has a running turn, saving its settings offers "save after turns" or "save now and interrupt"; the deferred save freezes the values at click time, and editing the form cancels it and asks for a new save.
- **acp**: save results appear at the page top: failure, expiry, refusal and a partly completed forced save stay until dismissed with a retry or force action; success hides itself shortly.
- **acp**: removing or stopping an agent now shows how many sessions it will affect.
- **acp**: when several agents have held saves, "save all now" offers one confirmation that lists the agents to interrupt and their session counts; a partial failure lists the agents that were not written.
- **acp**: successful saves for several agents in the same frame collapse into one success line that lists the saved agent names; beyond three it shows the first three plus the total.
- **acp**: after an agent is deleted, its held save shows a dedicated "this agent was deleted" line with a close action only.

### Improved

- **acp**: stopping, saving or deleting an agent opens a stopping window; messages arriving in that window fail immediately and are not queued, and the next message starts a new process after the stop completes. ([ee78ac2](https://github.com/GDWhisper/dsh-ntr/commit/ee78ac2))
- **acp**: an in-flight resume reuses the same ACP session and creates no second one; a lost session ownership returns `session_orphaned`, and the next message creates a new session and does not fall back to another session's process. ([ee78ac2](https://github.com/GDWhisper/dsh-ntr/commit/ee78ac2))
- **acp**: the status of several processes for one agent is aggregated into one view: any usable process makes the agent usable, and a fully crashed or released set reports stopped; a single start failure keeps a healthy agent's aggregate status usable. ([ee78ac2](https://github.com/GDWhisper/dsh-ntr/commit/ee78ac2))
- **acp**: fork is disabled for CodeBuddy, the branch entry is disabled, and a request returns `fork_unsupported` even if the peer advertises support. ([ee78ac2](https://github.com/GDWhisper/dsh-ntr/commit/ee78ac2))
- **acp**: HMR replacement is delayed while a turn is active and retries after it ends, with one notice when retries fail or the turn never ends; plugin setting saves can be deferred. DSH setting writes themselves are not intercepted by this plugin, so the host must patch its write chain before they queue automatically.
- **acp**: a newer save of the same agent invalidates the older held snapshot, and deleting an agent cancels its held save first, so the removed settings are not written back.
- **acp**: "save now" for a single agent only handles that agent and no longer flushes other agents' held saves; a global flush still happens through "save all now".
- **acp**: saving and deleting now fail explicitly when nothing can be written, instead of reporting success; a failed write keeps the old definition in memory.
- **acp**: idle checks trust the gate's active sessions only when the gate reports itself available; otherwise the UI falls back to local sessions and no longer treats an incomplete snapshot as evidence of idleness.
- **acp**: closed failure and expiry banners stay closed after a reload; a new save of the same agent clears its old failure line and its "staging cancelled" line.
- **acp**: cancelling a held save and retrying a save count as successful only on an explicit result; a cancellation superseded by a newer save is no longer shown as a user cancellation.
- **acp**: after an agent is deleted or stopped, late model probe results are no longer written back to the catalog.

### Fixed

- **acp**: switching the timeout action no longer rewrites the saved wait window; "no wait" runs as a 30-second floor only while "time out and abort" is active, and "auto-advance" or a restart still reports "no wait". Records an older build already rewrote to 30 seconds must be set back to "no wait" once.

**Full Changelog**: https://github.com/GDWhisper/dsh-ntr/compare/v0.3.6...v0.3.7

## [0.3.6] - 2026-11-02

子智能体清单能看出后台任务还在不在跑。

### 改进

- **acp**：子智能体清单里还在跑的后台任务会亮起运行中的圆点，任务结束或本轮收口后回到空闲；刷新页面后仍在跑的任务也照样亮着。([669aa91](https://github.com/GDWhisper/dsh-ntr/commit/669aa91))

**Full Changelog**: https://github.com/GDWhisper/dsh-ntr/compare/v0.3.5...v0.3.6

---

The subagent catalog shows whether a background worker is still running.

### Improved

- **acp**: background workers that are still running show the running dot in the subagent catalog, and go back to idle when they finish or the turn closes; a page reload keeps showing the live state. ([669aa91](https://github.com/GDWhisper/dsh-ntr/commit/669aa91))

**Full Changelog**: https://github.com/GDWhisper/dsh-ntr/compare/v0.3.5...v0.3.6

## [0.3.5] - 2026-11-01

后台任务可见、等得到结果；重启 DSH 不丢会话；新会话首轮按当前显示的模式执行。

### 新增

- **catalog**：后台派出的 agent 进入子智能体清单，条目只读。([459bc73](https://github.com/GDWhisper/dsh-ntr/commit/459bc73))

### 改进

- **chat**：后台任务持续汇报时，回合不再提前收口。([a8a6d32](https://github.com/GDWhisper/dsh-ntr/commit/a8a6d32))

### 修复

- **chat**：新会话首轮按当前显示的模式执行。([680953e](https://github.com/GDWhisper/dsh-ntr/commit/680953e))
- **acp**：关闭 DSH 后会话可恢复，退出不再拖长。([f4abd8e](https://github.com/GDWhisper/dsh-ntr/commit/f4abd8e))

**Full Changelog**: https://github.com/GDWhisper/dsh-ntr/compare/v0.3.4...v0.3.5

---

Background workers are visible and get to finish their answer; restarting DSH no longer drops conversations; a new conversation starts in the mode already displayed.

### Added

- **catalog**: detached workers show up in the subagent catalog as read-only entries. ([459bc73](https://github.com/GDWhisper/dsh-ntr/commit/459bc73))

### Improved

- **chat**: turns stay open while a background worker keeps reporting. ([a8a6d32](https://github.com/GDWhisper/dsh-ntr/commit/a8a6d32))

### Fixed

- **chat**: the first turn of a new conversation runs in the displayed mode. ([680953e](https://github.com/GDWhisper/dsh-ntr/commit/680953e))
- **acp**: conversations stay recoverable after the host exits, and shutdown is prompt. ([f4abd8e](https://github.com/GDWhisper/dsh-ntr/commit/f4abd8e))

**Full Changelog**: https://github.com/GDWhisper/dsh-ntr/compare/v0.3.4...v0.3.5

## [0.3.4] - 2026-11-01

底部的模型选择不再被思考等级顶掉；上一条还在生成时插入的消息也能正常接上，不会当场失败。

### 修复

- **模型选择不再被思考等级顶掉**：有的智能体把思考等级标成了模型分类，之前底部的模型选择会整块换成思考清单，导致每条消息都发不出去；现在模型位置只认真正的模型选项，被挤掉的选项照样能在额外配置里选到，实在分不清时照常发送而不是拦下这一轮。([3ab1b6e](https://github.com/GDWhisper/dsh-ntr/commit/3ab1b6e)) ([#8](https://github.com/GDWhisper/dsh-ntr/issues/8))
- **生成中插入的消息会被接上**：上一条回复还在生成时再发一条消息，之前这一轮直接失败、消息被丢掉；现在会先停住当前这轮，等对方收住后把这条作为下一条发出去。([97c1f0f](https://github.com/GDWhisper/dsh-ntr/commit/97c1f0f))

## [0.3.3] - 2026-11-01

CodeBuddy 的后台任务现在会把答案交回主对话，图片可以直接发给 agent，底部的生成速度也不再被工具等待拖慢。

### 新增

- **图片随消息发给 agent**：消息里带的图片会作为图片内容转发给 agent，文字与图片的顺序保持不变；agent 不支持图片输入时直接说明原因并拦下这一轮，不会把残缺的消息发出去，首轮也不会因此把会话锁死。([03a47ff](https://github.com/GDWhisper/dsh-ntr/commit/03a47ff))
- **消息可以并进后台任务**：CodeBuddy 正在跑后台任务时发来的消息会被并进那次运行，回合等后台收尾再把正文补进当前对话，不再一发出就结束、答案只剩在 NTR 视图里。([3e236df](https://github.com/GDWhisper/dsh-ntr/commit/3e236df))

### 改进

- **底部生成速度按连续输出计**：`x tok/s` 只统计连续写字的段落，工具等待与审批停顿不再把速度拖到很低；这一轮的读数随后续打开会话保留，刷新页面回来还是同一个值。([733e14a](https://github.com/GDWhisper/dsh-ntr/commit/733e14a))

### 修复

- **分支按钮恢复可用**：点分支按钮不再报错，分叉照常带上 agent 上下文。([b846fa7](https://github.com/GDWhisper/dsh-ntr/commit/b846fa7))
- **后台运行迟到的正文不再算成别的回答**：已经结束等待的后台运行如果又开口，它的话只留在 NTR 视图，不会被当成当前这一轮的回答；这一轮确实没有可见输出、又可能是被后台运行吞掉时，会说明去 NTR 视图看，而不是只说 agent 没有反应。([91704cc](https://github.com/GDWhisper/dsh-ntr/commit/91704cc))
- **交给后台 worker 的活儿也等得到答案**：CodeBuddy 把任务派给后台 worker 时，回合会一直开着直到 worker 报回结果，最终答案出现在主对话里而不是只在 NTR 视图；并行派了多个 worker 会等齐，取消或下一轮不会收进迟到的答案，真没有答案时直接说明。([81b30e8](https://github.com/GDWhisper/dsh-ntr/commit/81b30e8))

## [0.3.2] - 2026-10-31

NTR 会话现在自己接管消息动作与分支，挂起会话在界面上可见、可恢复，DSH 重启后也不丢。

### 新增

- **composer 显示上下文占用**：ACP 会话里也能看到 agent 报告的上下文占用环，不再只有原生会话有。([2f7e111](https://github.com/GDWhisper/dsh-ntr/commit/2f7e111))
- **挂起会话横幅与恢复按钮**：进程被回收后输入框上方会说明会话已挂起，点「恢复」即可唤醒，不必先发一条消息。([d39adcb](https://github.com/GDWhisper/dsh-ntr/commit/d39adcb))
- **空闲释放窗口可配置**：设置页「进程」分区用 1–60 分钟滑块决定空闲多久回收进程，保存后对运行中的进程立即生效；智能体里的同名设置改为「留空跟随全局」。([6663b84](https://github.com/GDWhisper/dsh-ntr/commit/6663b84))
- **NTR 会话接管消息动作与分支**：点赞/点踩图标不再出现在 NTR 会话里；分支按钮改为带上 agent 上下文，子会话会记住父会话的内容，失败时就地说明原因。([97bc761](https://github.com/GDWhisper/dsh-ntr/commit/97bc761))

### 改进

- **挂起会话改偏好不再唤醒进程**：模型、思考等级、mode 改完立刻显示，进程只在你发消息或点「恢复」时回来。([61b5d77](https://github.com/GDWhisper/dsh-ntr/commit/61b5d77))
- **重启 DSH 不丢挂起会话**：会话记录随插件落盘，重启后横幅、恢复按钮与下一条消息的自动恢复都还在。([bcbb9d7](https://github.com/GDWhisper/dsh-ntr/commit/bcbb9d7))

### 修复

- **恢复后模型芯片不再回跳**：在挂起会话上换过模型或思考等级，恢复生成时不会又显示成旧值。([7eefac4](https://github.com/GDWhisper/dsh-ntr/commit/7eefac4))
- **分支按钮在旧宿主上不再消失**：宿主换了图标导出名时按钮照常显示可点。([f23cf3f](https://github.com/GDWhisper/dsh-ntr/commit/f23cf3f))
- **NTR 界面不再串到普通会话**：NTR 页签与上下文占用环只在 NTR 会话里出现，普通会话回到原生界面。([7e113a8](https://github.com/GDWhisper/dsh-ntr/commit/7e113a8))

## [0.3.1] - 2026-10-29

设置页现在有一份独立的运行日志，agent 的运行消息不再占用顶部通知横幅；内置更新也能识别通过 registry 安装的插件。

### 新增

- **设置页运行日志**：agent 的运行消息（会话挂起、回合超时、长时间无响应等）集中记录在「日志」标签，新消息在前、最多保留 200 条（刷新页面后清空），未读有提示。([8933ecf](https://github.com/GDWhisper/dsh-ntr/commit/8933ecf))

### 改进

- **顶部通知只报操作失败**：横幅只保留你自己操作的失败（检测、保存、探测、更新、权限答复等），不再被 agent 的运行消息覆盖。([8933ecf](https://github.com/GDWhisper/dsh-ntr/commit/8933ecf))

### 修复

- **内置更新能识别 registry 安装**：当宿主把安装来源记成「包名@版本」时，不再误判为源码安装，更新卡可以正常检查并安装。([b5ab2cd](https://github.com/GDWhisper/dsh-ntr/commit/b5ab2cd))
- **会话挂起原因分别说明**：agent 空闲退出时不再误报「进程已退出」，工作区切换、恢复失败、卡死与崩溃在日志里各自说明。([8933ecf](https://github.com/GDWhisper/dsh-ntr/commit/8933ecf))

## [0.3.0] - 2026-10-29

插件现在能在设置页里自己更新，卡死的回合会自动结束，还多了一个 Cursor CLI 预设。

### 新增

- **内置更新**：设置页的版本徽标会检查新版本并可直接安装，按提示重启 DSH 生效。([f9095d1](https://github.com/GDWhisper/dsh-ntr/commit/f9095d1))
- **卡死的回合自动结束**：agent 长时间没有任何动静时，这一轮会自动结束并说明原因，不再让对话永远卡在「进行中」；下一条消息会自动恢复会话，agent 不支持会话恢复时会重置会话并说明上下文已丢失。([dd432c3](https://github.com/GDWhisper/dsh-ntr/commit/dd432c3))
- **Cursor CLI 预设**：装了 Cursor CLI 就能在预设列表里直接选用，新旧两种启动命令都能识别。([b844ddb](https://github.com/GDWhisper/dsh-ntr/commit/b844ddb))

### 改进

- **设置页显示插件版本**：NTR 设置标题上显示当前安装的 dsh-ntr 版本号。([dd432c3](https://github.com/GDWhisper/dsh-ntr/commit/dd432c3))
- **更新的边界说清楚**：源码或本地安装不提供升级，有对话进行中时不会安装，安装被中断时提示刷新确认版本而不是猜一个。([f9095d1](https://github.com/GDWhisper/dsh-ntr/commit/f9095d1))

## [0.2.1] - 2026-10-29

设置页拆成了一次只看一件事的分区，聊天里的 token 数字也不再自相矛盾（[#6](https://github.com/GDWhisper/dsh-ntr/issues/6)）。

### 新增

- **设置页分区导航**：「智能体」「审批时限」「对话外观」分成三个分区，一次只展开一个；连接状态收成页面底部一行，细节要手动点「查看诊断」。([4def8c9](https://github.com/GDWhisper/dsh-ntr/commit/4def8c9))
- **「添加智能体」改为按钮进入**：点按钮才展开填写页，保存成功后自动回到智能体列表。([4def8c9](https://github.com/GDWhisper/dsh-ntr/commit/4def8c9))

### 改进

- **切换分区不丢正在填的内容**：切分区、切「模型 / 连接 / 高级」都只是隐藏，填了一半的东西还在；模型列表只在当前可见时才去读取。([4def8c9](https://github.com/GDWhisper/dsh-ntr/commit/4def8c9))
- **诊断收纳噪音，异常不收纳**：预设来源、「重新检测与刷新」和模式横幅移进「查看诊断」；模式一旦出现异常仍直接显示在页面上方。([4def8c9](https://github.com/GDWhisper/dsh-ntr/commit/4def8c9))
- **「还没读取」和「确认没有」分开提示**：智能体空列表不再一律写成「未配置」。([4def8c9](https://github.com/GDWhisper/dsh-ntr/commit/4def8c9))
- **审批时限分区按可用性出现**：宿主不提供该配置时，导航里不再留一个空分区。([4def8c9](https://github.com/GDWhisper/dsh-ntr/commit/4def8c9))

### 修复

- **聊天里的 token 用量不再离谱**（[#6](https://github.com/GDWhisper/dsh-ntr/issues/6)）：回答旁边的数字改为按输出长度估算，不再把上下文占用当成请求 token，也就不会出现自相矛盾的总量和速度；没有数据来源的缓存命中率直接不显示，而不是显示 0%。上下文占用仍在 NTR 视图里看。([3848188](https://github.com/GDWhisper/dsh-ntr/commit/3848188))

## [0.2.0] - 2026-10-28

审批询问现在直接出现在对话里，每一条都会送到你面前，不会再隐形挂起（[#2](https://github.com/GDWhisper/dsh-ntr/issues/2)）。

### 新增

- **审批卡直接出现在对话里**：agent 要动敏感东西时，询问卡出现在聊天输入框上方，和输入框同宽居中；选项就是 agent 给的那些（包括「始终允许」），点哪个它就收到哪个。([78545b6](https://github.com/GDWhisper/dsh-ntr/commit/78545b6))
- **每条询问都带完整上下文**：卡片标题带工具名和参数摘要（命令、路径等），有等待期限时显示倒计时；多条询问按到达顺序堆叠。([78545b6](https://github.com/GDWhisper/dsh-ntr/commit/78545b6))

### 改进

- **设置页仍是跨会话镜像**：对话没打开时，仍可在「NTR 设置 → 待处理权限请求」里答复，两处看到的是同一批询问。([78545b6](https://github.com/GDWhisper/dsh-ntr/commit/78545b6))
- **取消或关闭会话会结算未答询问**：不再留下永远等不到的卡片。([78545b6](https://github.com/GDWhisper/dsh-ntr/commit/78545b6))

### 修复

- **审批询问不再隐形挂起**（[#2](https://github.com/GDWhisper/dsh-ntr/issues/2)）：任何询问都会在对话里出现，不会再出现「接受了却不显示、会话永久挂起」的情况。([78545b6](https://github.com/GDWhisper/dsh-ntr/commit/78545b6))
- **深色模式下界面配色跟随宿主**：状态点、徽标、diff 行、危险按钮、报错条不再出现浅色块。([7467398](https://github.com/GDWhisper/dsh-ntr/commit/7467398))
- **审批卡与输入框对齐**：不再比输入框宽出一截。([fccd95b](https://github.com/GDWhisper/dsh-ntr/commit/fccd95b))
