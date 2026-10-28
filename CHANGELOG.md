# Changelog

面向用户的版本改动记录，从 0.2.0 起维护。只记每一版留下的确定性净改动；被推翻、回退或只在开发过程中存在过的中间形态不记。条目与 GitHub Release 用同一套话，规则见 [AGENTS.md](./AGENTS.md) 约束 35。

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
