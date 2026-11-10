# 待办清单

本文件是本仓**唯一**的待办清单，由 [AGENTS.md](../AGENTS.md) 索引。

## 规则

- **只留未落地项**。用户确认完结的待办直接从本文件删除，不留下「已落地」条目——结论写进 [AGENTS.md](../AGENTS.md) 的对应约束（或 [docs/acp-convergence.md](./acp-convergence.md) 的批次表），去向不在这里重复。
- 每条写清四件事：用户报告了什么、现状在哪个文件的哪个符号、已知障碍（避免下次从零查）、验收时看什么。
- 落地前，**现行代码与 AGENTS.md 才是权威**；本文件里任何冲突描述都是「打算改」，不是「已经改了」。禁止照着本文件写新代码。
- 引用代码位置一律用「文件 + 符号名」，不用行号（行号随 diff 漂移）。

## 待办

- **源码拆分收尾（P9.8 / P10）** — 报告：`src/bridge.ts` 与 `tests/bridge.spec.ts` 是巨型文件，要求逐阶段拆分；源码已完成 P1–P9.7，剩余桥运行时与测试拆分。现状：`src/bridge/manager.ts` 仍持有 `makeBridge` / `bridgeFor` / `reapStalledTurns` / `getOrCreateDshSession` 等；`tests/bridge.spec.ts` 约 11.5k 行、34 个顶层 describe、300 个用例。障碍：剩余簇与 prompt / resume 主流程交叉最深，注入回调可能超过 10 个；测试顶层 `manager` 与 mock agent 跨 describe 共享。验收：`manager.ts` 降到约 1500 行或仅剩门面；测试按主题拆分且用例数不变；公共导出面 48 个名称不变；`npm run prepack` 全绿。方案与分步见 [docs/plan/bridge-split.md](./plan/bridge-split.md)。

- **自制子智能体展示** — 报告：头部「11 个子智能体」下拉里每行只有灰点 +「外部任务」，分不出运行中 / 成功 / 失败，也不能点进详情；那 11 行是长会话累计派出数，只有 1 行在跑，UI 没把两者分开。现状（已在该分支实现，待最终验收）：`src/client/subagent-activity.tsx` · `createSubagentCatalogClaim` / `SubagentCatalogOccupant` 按 ACP 分流；ACP 会话渲染 `src/client/subagent-panel.tsx` · `OwnSubagentCatalog`（宿主 `subagentCatalog` projection 骨架 + 插件六态 `SubagentRecord` 按 `childId` 左连接）与只读详情 `SubagentDetailDialog`（`shell.overlay`）；生命周期记录由 `src/bridge/subagent-service.ts` · `SubagentService.syncDispatchRecord` / `terminalizeSessionDispatches` / `noteSubagentRecords` / `subagentsFor` / `subagentsDetail` 维护，落 `agents.json` 的 `subagents` 键；浏览器侧 `src/client/store.ts` · `UiState.subagents` / `subagentDetails` / `loadSubagentDetail`。障碍：宿主对 external 行写死「不可完成、不可导航」（`dsh-client-ui-subagent/lib/client.js`），且 external 行没有子会话，`subagentTiming` 恒空；宿主持久的只有目录成员，状态必须插件自己落。验收：六态可辨、点行进详情、刷新 / 重启后终态仍在、没有永久「运行中」、非 ACP 会话仍是原生 trigger、`npm run prepack` 全绿。方案与证据见 [docs/plan/subagent-panel.md](./plan/subagent-panel.md)。
- **宿主被强杀后残留的 ACP agent 进程** — 报告：宿主被 `taskkill /F /PID` 强杀后，插件拉起的 agent 仍在跑（91 s 轮询仍在、约 235 s 仍活、约 240 MB RSS，`cmd.exe` 壳与 `node.exe` 都留着）；`child.stdin.end()` 与关闭输出管道都不能让它退出。现状：`src/bridge/agent-bridge.ts` · `spawnAndConnect` / `disposeChild`；`src/bridge/process.ts` · `windowsShimLaunch`（经 `cmd.exe /d /s /c` 拉起 `.cmd` 生成壳）/ `killProcessTree` / `reapLiveChildren`，优雅退出与 `process.once('exit')` 钩子只能在宿主还跑得起退出钩子时生效。障碍：libuv 的 `KILL_ON_JOB_CLOSE` job 带 `SILENT_BREAKAWAY_OK`，壳起的 `node.exe` 会脱离 job；codebuddy 2.179.0 的 `startOrphanWatchdog` 只对 brokered session 生效，且靠 `process.ppid` 判断，Windows 上永不触发；绕开壳的可行性尚未实测。验收：宿主 `taskkill /F`（不带 `/T`）后 90 s 内 agent 进程消失，优雅关闭 4 s 总预算、stderr 行归属、POSIX 组杀均不退化。方案与证据见 [docs/plan/backlog/orphan-agent-reaping.md](./plan/backlog/orphan-agent-reaping.md)。
