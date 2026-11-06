# 待办清单

本文件是本仓**唯一**的待办清单，由 [AGENTS.md](../AGENTS.md) 索引。

## 规则

- **只留未落地项**。用户确认完结的待办直接从本文件删除，不留下「已落地」条目——结论写进 [AGENTS.md](../AGENTS.md) 的对应约束（或 [docs/acp-convergence.md](./acp-convergence.md) 的批次表），去向不在这里重复。
- 每条写清四件事：用户报告了什么、现状在哪个文件的哪个符号、已知障碍（避免下次从零查）、验收时看什么。
- 落地前，**现行代码与 AGENTS.md 才是权威**；本文件里任何冲突描述都是「打算改」，不是「已经改了」。禁止照着本文件写新代码。
- 引用代码位置一律用「文件 + 符号名」，不用行号（行号随 diff 漂移）。

## 待办

- **自制子智能体展示** — 报告：头部「11 个子智能体」下拉里每行只有灰点 +「外部任务」，分不出运行中 / 成功 / 失败，也不能点进详情；那 11 行是长会话累计派出数，只有 1 行在跑，UI 没把两者分开。现状：`src/client/subagent-activity.tsx` · `createSubagentCatalogClaim` / `SubagentCatalogOccupant` / `mergeSubagentStatuses` 只把活跃 id 塞进宿主 status map；`src/bridge.ts` · `trackBackgroundDispatch` 把 `completed` 与 `failed` 折叠成同一个布尔；`src/protocol.ts` · `AcpEvent` 的 `subagents/update` 只有 `running`。障碍：宿主对 external 行写死「不可完成、不可导航」（`dsh-client-ui-subagent/lib/client.js`），且 external 行没有子会话，`subagentTiming` 恒空；宿主持久的只有目录成员，状态必须插件自己落。验收：六态可辨、点行进详情、刷新 / 重启后终态仍在、没有永久「运行中」、非 ACP 会话仍是原生 trigger、`npm run prepack` 全绿。方案与证据见 [docs/plan/subagent-panel.md](./plan/subagent-panel.md)。
- **宿主被强杀后残留的 ACP agent 进程** — 报告：宿主被 `taskkill /F /PID` 强杀后，插件拉起的 agent 仍在跑（91 s 轮询仍在、约 235 s 仍活、约 240 MB RSS，`cmd.exe` 壳与 `node.exe` 都留着）；`child.stdin.end()` 与关闭输出管道都不能让它退出。现状：`src/bridge.ts` · `spawnAndConnect` / `windowsShimLaunch`（经 `cmd.exe /d /s /c` 拉起 `.cmd` 生成壳）/ `disposeChild` / `killProcessTree` / `reapLiveChildren`，优雅退出与 `process.once('exit')` 钩子只能在宿主还跑得起退出钩子时生效。障碍：libuv 的 `KILL_ON_JOB_CLOSE` job 带 `SILENT_BREAKAWAY_OK`，壳起的 `node.exe` 会脱离 job；codebuddy 2.179.0 的 `startOrphanWatchdog` 只对 brokered session 生效，且靠 `process.ppid` 判断，Windows 上永不触发；绕开壳的可行性尚未实测。验收：宿主 `taskkill /F`（不带 `/T`）后 90 s 内 agent 进程消失，优雅关闭 4 s 总预算、stderr 行归属、POSIX 组杀均不退化。方案与证据见 [docs/plan/backlog/orphan-agent-reaping.md](./plan/backlog/orphan-agent-reaping.md)。
