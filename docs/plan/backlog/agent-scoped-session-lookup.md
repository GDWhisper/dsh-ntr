# 按 agent 过滤的会话归属查询：暂缓方案

**日期**：2026-11-04　**状态**：未决策（当前不改）。**适用范围**：`src/bridge/manager.ts` 的 `BridgeManager` 会话查找路径；不涉及浏览器半区。

**一句话**：`find` / `tryLocate` / `locateOrResume` 只按 `sessionId` 遍历全部 bridge。A1 把子进程数量放大到「每 DSH 会话一个」之后，这条查找不再带 agent 维度；本方案记录「要不要加 agent 过滤、加了要动什么」。

> 本文只记设计与证据，**没有任何一行代码按此改动过**。现行代码与 [AGENTS.md](../../../AGENTS.md) 才是权威。

## 1. 问题

A1 之后 `bridges` 是一个复合键 Map（`bridgeKey(agentId, scope)`），同一个 `sessionId` 理论上可以同时存在于不同 agent 的 holder 上。三个查找函数只拿 `sessionId`：

- `BridgeManager.find(sessionId)`：遍历 `bridges`，命中 `hasSession` 或 `hasReleased` 就返回。
- `BridgeManager.tryLocate(sessionId)`：同上，但只返回带活进程的 holder。
- `BridgeManager.locateOrResume(sessionId)`：先 `find`，再 `takeReleased` + `resumeSession`。

若两个 agent 产生相同 `sessionId`，Map 的迭代顺序决定谁被命中，错误的那一路会拿到另一个 agent 的会话（或对它发起 resume）。

## 2. 为什么现在不改

1. **`sessionId` 由宿主铸造，不是 agent 给的**：`createSession` 用 `randomUUID()` 生成，写入 `LiveSession.sessionId`；ACP 自己的 id 另存 `acpSessionId`。两个 agent 撞同一 `sessionId` 需要 UUID 碰撞，属密码学级别的小概率，不是设计缺口。
2. **`/acp` 契约不携带 agent 身份**：`session/prompt`、`session/cancel`、`session/set_mode` 等 RPC 的入参只有 `sessionId`。按 agent 过滤要求改 `src/protocol.ts` 契约、`src/impl.ts` 的 `dispatchRpc` 校验、`src/client/store.ts` 与所有调用点；这会把一次「防御小概率碰撞」的修补升级成跨层 API 变更。
3. **加索引是新增第二份真相**：要么维护 `Map<agentId, Map<sessionId, bridge>>`（删除、释放、重建时都要双写），要么给每次查找传 `agentId`。前者引入一致性问题，后者回到第 2 条。
4. **当前语义并非错误**：`sessionId` 全局唯一时，「按 id 找到唯一持有者」就是正确答案；`bridgeOwning(agentId, sessionId)` 已经在需要 agent 语义的路径上（孤儿判定、abort）额外过滤。查找面不过滤不构成新风险，只是少一层保险。

结论：改动面大、语义有争议，且没有可复现的故障证据。按「不要为了消除建议而引入新风险」写入 backlog，不在本轮落地。

## 3. 如果要做：最小路径与验收

**路径 A（推荐先评估）**：只在 `locateOrResume` / `find` 加「多持有者检测」，不传 agent：

- 遍历时若命中第二个 holder，立即抛 `AcpError('session_ambiguous', ...)` 并列出两个 `agentId`。
- 单持有者路径行为与今天逐字节一致；`session_orphaned` 兜底不变。

**路径 B（完整）**：`/acp` RPC 增加可选 `agentId`，`find(agentId, sessionId)` 优先按 agent 查找，缺省回落路径 A 的唯一性检查；聊天路径本来就持有 `agentId`，直接用。

**验收**：

1. 同一 `sessionId` 人为挂在两个 agent 的 holder 上：`/acp` 调用得到 `session_ambiguous`，不误路由。
2. 唯一持有者下，`session/prompt` / `resume` / `close` 行为与现有用例逐字节一致。
3. `session_orphaned` 仍在真正无主时抛出。
4. 新增 per-agent 索引时，`releaseAll` / `closeSession` / `stopAgent` / `pruneBridge` 四处删键都有测试覆盖。

## 4. 触发条件

- 出现真实的跨 agent `sessionId` 碰撞（日志里同一 id 挂到两个 agent），或上游 agent 开始自带上会复用的 session id；
- 或者某天 `/acp` 契约本来就要携带 agent 身份（顺带做）。
