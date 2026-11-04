# A1 恢复在途时关闭会话返回 `unknown_session`

**日期**：2026-11-04　**状态**：未决策（当前不改）。**适用范围**：`src/bridge.ts` 的 `BridgeManager.closeSession` 与 `doResumeSession`；A1（`codebuddy`）的 released 会话。

**一句话**：恢复在途的会话不在 `sessions` 也不在 `released`，`closeSession` 的两个查找都看不到它，关闭请求因此失败。

> 本文只记现象、影响与候选修复，**没有任何一行代码按此改动过**。现行代码与 [AGENTS.md](../../../AGENTS.md) 才是权威。

## 1. 现象

`BridgeManager.closeSession` 先用 `tryLocate` 找 holder，再 `dropReleased`。`doResumeSession` 在 `session/load` 期间清掉 `released`，并要等响应返回后才 `sessions.set`，此期间记录只存在于 `resuming`。两个查找都看不到它，关闭请求于是抛 `unknown_session`。

## 2. 影响

窗口为 spawn + `initialize` + `session/load`，最长 60 秒。用户在这段时间点关闭，收到错误而非关闭成功；恢复随后成功，会话重新出现在列表里，等于关闭没生效。

## 3. 触发条件

A1 agent（`codebuddy`）的会话已 released；`/acp` 侧对同一会话发起 resume；同时 DSH 聊天面或 `/acp` 对同一会话发起 close。

## 4. 为何暂不修

`session/load` 没有取消原语。等待恢复完成再关，会把关闭最坏延迟抬到 60 秒，并让关闭语义依赖恢复结果；杀进程终止 load 等于把关闭做成 `forceReset`。两者都会扩大生命周期语义。

## 5. 修复路径（将来）

`closeSession` 增加 resuming 分支，登记 close intent；`doResumeSession` 在 `sessions.set` 之前检查 intent，命中就立即关闭并广播 `session/closed`，不把会话挂回。

**验收**：

1. 恢复在途时关闭，最终恰好一条 `session/closed`、没有 live session、没有新建 ACP 会话。
2. 恢复失败时关闭也要落定。

## 6. 后续启动条件

- ACP 上游提供 load 取消能力；
- 或宿主接受「关闭先返回 accepted、恢复完成后再广播 closed」的异步语义。
