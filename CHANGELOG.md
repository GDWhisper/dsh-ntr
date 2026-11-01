# Changelog

面向用户的版本改动记录，从 0.2.0 起维护。只记每一版留下的确定性净改动；被推翻、回退或只在开发过程中存在过的中间形态不记。条目与 GitHub Release 用同一套话，规则见 [AGENTS.md](./AGENTS.md) 约束 35。

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
