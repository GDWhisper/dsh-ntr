# 待办清单

本文件是本仓**唯一**的待办清单，由 [AGENTS.md](../AGENTS.md) 索引。

## 规则

- **只留未落地项**。用户确认完结的待办直接从本文件删除，不留下「已落地」条目——结论写进 [AGENTS.md](../AGENTS.md) 的对应约束（或 [docs/acp-convergence.md](./acp-convergence.md) 的批次表），去向不在这里重复。
- 每条写清四件事：用户报告了什么、现状在哪个文件的哪个符号、已知障碍（避免下次从零查）、验收时看什么。
- 落地前，**现行代码与 AGENTS.md 才是权威**；本文件里任何冲突描述都是「打算改」，不是「已经改了」。禁止照着本文件写新代码。
- 引用代码位置一律用「文件 + 符号名」，不用行号（行号随 diff 漂移）。

## 待办

- **宿主被强杀后残留的 ACP agent 进程** — 报告：宿主被 `taskkill /F /PID` 强杀后，插件拉起的 agent 仍在跑（91 s 轮询仍在、约 235 s 仍活、约 240 MB RSS，`cmd.exe` 壳与 `node.exe` 都留着）；`child.stdin.end()` 与关闭输出管道都不能让它退出。现状：`src/bridge.ts` · `spawnAndConnect` / `windowsShimLaunch`（经 `cmd.exe /d /s /c` 拉起 `.cmd` 生成壳）/ `disposeChild` / `killProcessTree` / `reapLiveChildren`，优雅退出与 `process.once('exit')` 钩子只能在宿主还跑得起退出钩子时生效。障碍：libuv 的 `KILL_ON_JOB_CLOSE` job 带 `SILENT_BREAKAWAY_OK`，壳起的 `node.exe` 会脱离 job；codebuddy 2.179.0 的 `startOrphanWatchdog` 只对 brokered session 生效，且靠 `process.ppid` 判断，Windows 上永不触发；绕开壳的可行性尚未实测。验收：宿主 `taskkill /F`（不带 `/T`）后 90 s 内 agent 进程消失，优雅关闭 4 s 总预算、stderr 行归属、POSIX 组杀均不退化。方案与证据见 [docs/plan/backlog/orphan-agent-reaping.md](./plan/backlog/orphan-agent-reaping.md)。
