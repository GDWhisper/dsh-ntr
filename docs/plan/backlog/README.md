# 暂缓方案索引

被评估过、但**没有落地**的方案放在这里：有证据、有验收口径，等一个「做不做、做哪条」的决定。

与 [docs/todo.md](../../todo.md) 的分工：待办清单只留**决定要做**的未落地项，每条一句话指向细节；本目录承载**还没决定**的设计全文。一条路线定了（做或不做），状态改到最终结论，并同步待办清单与 [docs/README.md](../../README.md)。

| 文件 | 主题 | 状态 |
|---|---|---|
| [orphan-agent-reaping.md](./orphan-agent-reaping.md) | 宿主被强杀后残留的 ACP agent 进程：绕开 `.cmd` 壳（A）/ supervisor 包装（B）/ 重启接管（C，暂缓） | 未决策 |
| [codebuddy-single-process-http-acp.md](./codebuddy-single-process-http-acp.md) | CodeBuddy 单进程 + 多条 HTTP ACP 连接（A2）：用 streamable-http 承载多会话，内存换复杂度 | 未决策 |
| [agent-scoped-session-lookup.md](./agent-scoped-session-lookup.md) | 会话查找按 agent 过滤：`find` / `tryLocate` / `locateOrResume` 只按 `sessionId` 遍历，A1 放大进程数后的防御性收紧 | 未决策 |
| [a1-close-during-resume.md](./a1-close-during-resume.md) | A1 恢复在途时关闭会话：`closeSession` 在 `session/load` 窗口内找不到 holder，返回 `unknown_session` | 未决策 |

状态取值只有三个：**未决策**（还没人拍板）、**待验证**（有意向，先做实验）、**已否决**（结论是不做，保留记录免得下次重新论证）。
