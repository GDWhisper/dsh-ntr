# Changelog

面向用户的版本改动记录，从 0.2.0 起维护。只记每一版留下的确定性净改动；被推翻、回退或只在开发过程中存在过的中间形态不记。条目与 GitHub Release 用同一套话，规则见 [AGENTS.md](./AGENTS.md) 约束 35。

## [0.3.1] - 2026-10-29

设置页现在有一份独立的运行日志，agent 的运行消息不再占用顶部通知横幅。

### 新增

- **设置页运行日志**：agent 的运行消息（会话挂起、回合超时、长时间无响应等）集中记录在「日志」标签，新消息在前、最多保留 200 条（刷新页面后清空），未读有提示。([8933ecf](https://github.com/GDWhisper/dsh-ntr/commit/8933ecf))

### 改进

- **顶部通知只报操作失败**：横幅只保留你自己操作的失败（检测、保存、探测、更新、权限答复等），不再被 agent 的运行消息覆盖。([8933ecf](https://github.com/GDWhisper/dsh-ntr/commit/8933ecf))

### 修复

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
