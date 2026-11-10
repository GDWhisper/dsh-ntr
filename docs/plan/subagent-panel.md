# 方案：自制子智能体展示（彻底替换宿主 trigger）

**状态**：**已决策，待实现**（三条拍板见 §1；代码未动）。**适用范围**：ACP preset 会话的浏览器半区 + 宿主桥接层；只影响 `mode: 'external'` 的目录行。
**一句话**：把 `conversation.session.header.actions` 里 `subagent-catalog` 这个 cell 在 ACP 会话中换成插件自绘面板，列表复用宿主**持久**的 `subagentCatalog` projection，终态 / 失败原因 / 明细由插件自持，做到排队 / 运行 / 成功 / 失败 / 已取消 / 未知六态可辨、可点进详情。

> 写作约定：代码位置一律用「文件 + 符号名」，不写行号。本文不是 `AGENTS/` 文档，但索引登记进 [docs/README.md](../README.md)，待办登记进 [docs/todo.md](../todo.md)。本文是**可独立接手**的方案：§1 是决策，§2 是改动前不必重查的证据，§3–§7 可直接照着改，§12 是验收口径。

---

## 1. 结论与三条拍板

1. **彻底替换**：ACP 会话里不再渲染宿主 `SubagentCatalogAction`，改渲染插件自绘面板；非 ACP 会话必须原样渲染宿主组件（[AGENTS/ui.md §7](../../AGENTS/ui.md) 的隔离铁律，约束 18）。claim 已在手，改 occupant 即可，不新增第二个头部条目。
2. **调查结论改变了数据方案**：宿主持久的是**目录成员**，不是状态。列表不必自己重建；终态自己落 `agents.json`，不新增第四个落盘文件。
3. **单独上限**：详情缓冲按 **worker** 计，不按整会话计，避免长会话把早期 worker 挤光。

**修正前一轮的一处判断**：曾提议把 `dispatches` 抬成会话级记录并由此重建列表。调查后收回一半 —— 列表直接读宿主投影，插件只补状态与明细；`dispatches` 仍是 `TurnStreamController` 的回合级容器，**不为展示去改它的生命周期**（约束 23 的 hold 逻辑碰不得）。

### 非目标

- 不做 per-worker 的取消 / 重试 / 发消息。ACP 没有 per-worker 控制面，面板**只读**，不许画假按钮。
- 不改宿主任何 JSX / 组件 / 源码，不改 `subagent/catalog` 事件格式（`version: 2` 已被宿主读取器接受）。
- 不改 `session/prompt` 的收口时机，不新增第三种按空闲计时的强制定稿（约束 23）。
- 不新增第四个运行时落盘文件（[AGENTS/state.md §1](../../AGENTS/state.md)、约束 28）。
- 不为非 CodeBuddy agent 伪造子智能体：`codebuddyMetaOf` 返回 `undefined` 时面板写「该 agent 未上报子智能体」，不写「没有子智能体」。
- 不删宿主已有的 catalog 事实：宿主日志 append-only，无删除接口，也删不掉。

---

## 2. 现状与证据（改动前不必重查）

### 2.1 用户看到的是什么

2026-11-04 的界面截图：头部 trigger `○ 11 个子智能体 ^`，下拉 11 行，每行左侧灰点、首行 `<type> · <任务描述>`、副标题一律「外部任务」；最后一行是空心转圈，其余是实心灰点。无状态文字、无耗时、无失败原因、无详情入口。底部「10 轮 21 步 · 用时 17 分 17 秒」说明这 11 行是**长会话累计派出的 worker**，不是 11 个并发在跑 —— 当前 UI 没把「累计 N」与「运行中 M」分开。

### 2.2 插件现状（决定改动落点）

| 事实 | 位置 |
|---|---|
| 宿主目录事实：一条 `subagent/catalog` 事件 = `{ version: 2, childId: 'acp:<toolCallId>', childCreatedAt: Date.now(), mode: 'external', label }`，按 childId 去重、append-only | `src/impl.ts` · `appendExternalSubagentCatalog`；`src/index.ts` · `wireSubagentCatalog` |
| 活跃态只有布尔：`subagents/update { dshSessionId, childId, running }`，`running:false` 后行回到灰点，与「成功 / 失败 / 从未上报」同形 | `src/protocol.ts` · `AcpEvent`；已退役（见 [AGENTS/retired.md](../../AGENTS/retired.md)）：`broadcastDispatchActivity` / `openDispatchActivity` / `closeDispatchActivity` / `closeAllDispatchActivity` / `activeCatalogChildIds`；`src/client/store.ts` · `UiState.activeSubagents` / `subagentFrames` |
| 浏览器只把活跃 id 塞进宿主 status map，再渲染**宿主自己的组件** | `src/client/subagent-activity.tsx` · `mergeSubagentStatuses` / `SubagentCatalogOccupant` / `createSubagentCatalogClaim`；`src/client/index.tsx` · `syncAcpMode` 的 claim 注册处 |
| 重连快照 = `session/chat-list` 行上的 `activeSubagents` | `src/bridge/session-registry-service.ts` · `chatSessions`；`src/protocol.ts` · `ChatSessionView.activeSubagents` |
| 成功/失败在桥里被主动折叠：`BackgroundDispatch.completed` 把 `completed` 与 `failed` 两种 status 合成一个布尔 | `src/bridge/types.ts` · `BackgroundDispatch.completed`；`trackBackgroundDispatch`（已不存在） |
| 身份、归属、活动时钟都在 `_meta` 与 dispatch 记录里 | `src/bridge/turn-stream.ts` · `codebuddyMetaOf`（`subagentType` / `description` / `memberName` / `parentToolCallId` / `requestId` / `isBackground` / `isSubagent`）；`src/bridge/shape.ts` · `subagentDispatchLabel`；`src/bridge/turn-stream.ts` · `noteBackgroundWorkerActivity`；`src/bridge/types.ts` · `BackgroundDispatch.{status,detached,sawWorkerUpdate}` |
| worker 的每条原始更新都在 transcript / SSE / RPC 里 | `src/bridge/agent-bridge.ts` · `handleSessionUpdate` → `session.transcript.append(params.update)` + `session/update` 广播；`src/bridge/session-registry-service.ts` · `chatTranscripts`；`src/protocol.ts` · `ChatTranscriptView.entries[].update` |

### 2.3 宿主状态持久性调查（本机实测，可复现）

读了三处一手材料：本机 `~/.dsh` 的真实数据、`~/.dsh/builtin-docs/` 的宿主包文档、`M:/DeepSeek Harness/resources/app.asar` 内 `dsh/node_modules/@deepseek-ai/dsh-client-ui-subagent/lib/client.js` 的编译产物。

**分层结论**：

| 层 | 宿主来源 | 持久？ | external 行 |
|---|---|---|---|
| 目录成员 `childId / label / childCreatedAt / mode` | 父会话日志事件 → `subagentCatalog` projection → `session_projcache` 持久检查点 | **持久，跨 DSH 重启** | 吃得到 |
| `running` / `completionUnread` / `pendingInteraction` | 统一 UI status map / Session 摘要；浏览器进程本地投影 | **不持久** | `dsh-client-ui-session` 明说「Subagent 目录行不会建立运行状态」 |
| `lastTurnCompleted` / `settledMs` | **每个 child 自己**的 Session 的 `subagentTiming` projection，带持久检查点 | **原生 child 持久** | external 没有子会话，父会话恒 `{descriptorSeen:false, settledMs:0}` |

**实测数据**（`session-f6732e5e-3b56-4bad-8286-9cd96467ad25`，即截图那条会话）：

- `C:/Users/vacio/.dsh/sessions/--G-ComfyUI-aki-ComfyUI-aki-v3.2--/session-f6732e5e-3b56-4bad-8286-9cd96467ad25/session.v4.jsonl.zstd` 是 **zstd 流式帧**（无 content size，须用 `stream_reader`）：解压后 623 行、**18 条 `subagent/catalog` 事件**，字段只有 `version / childId / childCreatedAt / mode / label`，**没有任何状态、完成、失败事件**。事件类型分布里 `turn/start` / `turn/end` 各 24 条，`"failed"` / `"running"` / `"lastTurnCompleted"` / `"settledMs"` 字样均为 0。
- `C:/Users/vacio/.dsh/storages/session_projcache/sessions/session-f6732e5e-3b56-4bad-8286-9cd96467ad25.json`：`rows.subagentCatalog = { ver: 6, seq: 621, val: { head: { values: [18 条] } } }`，与日志逐字一致；时间从 **2026-11-03 20:25 到 2026-11-05 18:19**，跨 2 天 24 轮 —— 截图里那 11 行至今都在盘上。同一文件 `subagentTiming = { descriptorSeen:false, settledMs:0 }`、`subagent = {}`、`agentPreset = "acp"`。
- 157 个检查点里另 **23 个** `descriptorSeen:true`（原生子会话），其中 **20 个 `lastTurnCompleted:true`、3 个 false**，都带 `settledMs`；抽样的 `subagent.identity` 是 `{ mode: 'one-shot' | 'continuable', label, seq }`。
- 宿主文档：`dsh-session-persistence/README.zh.md`（`session/event` → 写句柄 → JSONL 落盘，`flush` 是持久性屏障，**无删除或保留接口**）、`dsh-session-projection/README.zh.md`（状态从已提交事件同步折叠，`stateVersion` 变化时从持久日志重新折叠）、`dsh-session-projection-cache/README.zh.md`（「日志领先，缓存跟随」，检查点只是冷读捷径）、`dsh-subagent/README.zh.md`（`subagentCatalog` / `subagentTiming` 的语义）、`dsh-client-ui-subagent/README.zh.md`（「非完成的 inactive 结果仍合并显示」—— **宿主自己都不区分失败 / 取消 / 拒绝 / 额度耗尽**）。

**宿主源码铁证**（`dsh-client-ui-subagent/lib/client.js`）：

```js
const external = entry.mode === "external";
const mode = external ? t("mode.external") : ...;                    // 「外部任务」写死
const completed = !external && entry.activity === "inactive"
  && summary?.projectionValues?.subagentTiming?.lastTurnCompleted === true;
const activity = external ? void 0 : entry.activity === "running" ? ... : completed ? ... : ...;
const secondary = [summary?.title, ..., mode, activity].filter(...);
const open = () => { if (external) return; openChild({ ... }); };    // 不可导航
// role=treeitem, tabIndex: external ? -1 : 0, aria-disabled: external || void 0
```

所以成功态不可达**不是缺实现，是宿主设计**：ACP 子级「在父级会话语料中没有本地子会话」（`dsh-subagent/README.zh.md` 已知限制）。我们要做六态是**另立事实源**，不是补齐宿主缺的功能。

**客户端投影形状**（同一文件，Implement 前按 [AGENTS/host.md §5.3](../../AGENTS/host.md) 复核）：

```js
const projections = useSessions(s => s.projectionsBySession);
const summaries  = useSessions(s => s.byId);
const statuses   = useSessionStatus(v => v);
const projected  = snapshot.values.subagentCatalog;                 // 数组
entries: (projected ?? []).map(entry => ({
  ...entry,
  activity: (statuses.get(entry.id)?.running ?? summaries[entry.id]?.running) === true
    ? "running" : "inactive"
}))
const runningCount = directChildren.filter(e => e.activity === "running").length;
```

- `projectionsBySession[parentSessionId].values.subagentCatalog` 是**数组**，客户端视图项形状为 `{ id, createdAt, mode: 'one-shot' | 'external' | 'continuable' | 'unknown', label? }`（宿主 view schema 已确认）：`id` = `childId`，`createdAt` = 派出时间。**字段名不是 `childCreatedAt`**。
- `activity` 是 UI 派生，来自 `useSessionStatus` 的 status map —— 这正是 `mergeSubagentStatuses` 现在 patch 的那条缝。
- `SubagentCatalogAction` 的 props 是 `{ sessionId, useSessions, useSessionStatus, openChild, openChildAside, refreshProjection, t }`；`tests/subagent-activity.spec.tsx` 的 fake host 已经把 `useSessions` 传进来了，自制面板可直接复用这条接缝。
- **已确认**：创建时间经 `wire.view` 透传到客户端数组，字段名是 `createdAt`。它直接作为 `startedAt`；只有它缺失时才回落插件 append 时的 `now`，不必冷读宿主日志。
- `subagentCatalog` 的检查点 `ver` 是宿主内部值；升级导致 `ver` 不匹配时检查点被丢弃并从日志重折叠，**目录成员不会丢**。

---

## 3. 数据归属与契约

### 3.1 谁拥有什么

| 字段 | 权威来源 | 落盘 | 备注 |
|---|---|---|---|
| `childId` / `label` / `mode` / 累计派出数 | 宿主 `subagentCatalog` projection（持久日志派生） | 宿主侧，插件不重复存 | 列表骨架；`dshSessionId` 由 slot 的 `sessionId` 提供 |
| `startedAt` | 宿主 view 的 `createdAt`（= 事件里的 `childCreatedAt`）；缺失时回落插件 append 的 `now` | 宿主侧，插件不重复存 | 历史行与插件记录之前的行都靠这一列，不必冷读日志 |
| `status` / `endedAt` / `lastActivityAt` / `error` / `counts` | 插件线报（`BackgroundDispatch` + 拆除路径） | **`agents.json` 的 `subagents` 键** | 经 `persistAgents` / `pluginStateDir()`，约束 28 |
| 明细（原始 `session/update`） | `session.transcript` / SSE `session/update` / `session/chat-transcript` | **不落盘** | 内存 + 浏览器 store，有界，按需拉取 |

**继续写 `subagent/catalog` 事实**，理由：append-only 删不掉；列表靠它；宿主其它面（面包屑、`@` source）可能读。**但不再 patch `useSessionStatus`** —— 宿主组件不再渲染。

### 3.2 记录形状（写进 `agents.json`，不新增第四个文件）

```ts
type SubagentStatus =
  | 'pending' | 'running' | 'completed' | 'failed' | 'cancelled' | 'unknown'

interface SubagentRecord {
  childId: string                 // 'acp:<toolCallId>'，与宿主 catalog 对齐
  dshSessionId: string
  toolCallId: string
  label: string                   // 兜底；正常从宿主 projection 读
  type?: string                   // subagentType
  status: SubagentStatus
  startedAt: number
  lastActivityAt: number
  endedAt?: number
  error?: unknown                 // tool_call_update.content 原样；字符串 / 对象 / 数组都保留（约束 29），显示层再折叠
  counts: { updates: number; toolCalls: number; textChars: number }
}
```

- `agents.json` 新增 `subagents: Record<dshSessionId, SubagentRecord[]>`；`loadPersistedAgents` / `persistAgents` 一并校验与归一化，形状变化走可选字段，不搞迁移脚本。
- **落盘只在状态迁移**（`pending → running → completed / failed / cancelled / unknown`，含 `startedAt` / `endedAt` / `error` / `counts` 定稿）。`lastActivityAt` 每条 worker 更新都变，只留在内存并在下一次落盘时带上，**严禁**每帧调 `persistAgents`——它同步全量重写 `agents.json`，按 chunk 写会直接把主线程拖死。会话关闭 / 记录被丢弃时 prune 对应的 `subagents` 键；`loadPersistedAgents` 之后只保留在 `chatSessions` 或 `conversations` 里仍有归属的键，孤儿记录直接丢。
- 列表显示时按 `childId` 把宿主投影数组与插件记录做左连接：**宿主有、插件无** → `unknown`（插件升级前的历史行），**插件有、宿主无** → 仍显示（刚创建尚未上报 / 宿主刚 append 尚未投影 / 写入失败），标「目录待同步」。trigger 的「累计 N」也计入这部分——它是插件已经知道的派出数。绝不把 `unknown` 画成成功。
- 事件帧：新增 `subagents/record`（单条全量状态）；会话级快照走 `session/chat-list` 行上的 `subagents` 数组，**不是** SSE 首帧全局快照。`subagents/update { running:boolean }`、`UiState.activeSubagents`、`subagentFrames` 与 `ChatSessionView.activeSubagents` **一并退役**，不留第二套事实源。同步 `AGENTS/retired.md` 的幽灵清单。
- **record 广播点必须与 catalog 上报解耦**：`openDispatchActivity` / `closeDispatchActivity` 只在宿主 catalog 接受后（`catalogReported`）才跑。record 帧要在 dispatch 创建与每次状态迁移处直接发，否则未上报的 dispatch 永远到不了浏览器，「插件有、宿主无」的行也永远不出现。
- 重放去重照 `readChatSessionList` 的 `chatRowFrameSeq` / `replayChatRowFrames`：store 侧维持单调 seq，读前记 `subagentRecordSeq`，读后重放期间到达的帧；同一 `dshSessionId + childId` 按 seq 后者胜。**不要**把 `chat-list` 快照当成比在途帧更新。同一个 `dshSessionId` 可能对应多行 `ChatSessionView`，记录按 `dshSessionId + childId` 去重合并后再计数。
- 详情按需：`subagents/detail` RPC 按 `{ dshSessionId, childId }` 返回有界原始条目；**不常驻 SSE 广播**。入参校验 `acp:` 前缀与会话归属，未知 / 越界返回空而不是抛内部错误。

---

## 4. 状态机（六态，全部从已有线报派生，不猜）

| 态 | 判据 | 来源符号 |
|---|---|---|
| 排队中 | `status === 'pending'`，或首个 `tool_call` 帧没有 status（空串），且无 `sawWorkerUpdate` | `BackgroundDispatch` |
| 运行中 | `in_progress` / `detached` / `sawWorkerUpdate`；活动时钟由每条 dispatch / worker 更新续期 | `trackBackgroundDispatch` / `noteBackgroundWorkerActivity` |
| 成功 | `status === 'completed'` | `tool_call_update`，**已知 callId 一律按 id 认**（真实完成帧无 `_meta`） |
| 失败 | `status === 'failed'`；原因取该帧 `content` 原文，没有就写「agent 未给原因」 | 同上 |
| 已取消 | 用户 cancel / hold `cancelled` | `abortActiveSegment` / `settle` |
| 未知 | 无终态就收口 / 拆除，或插件升级前的历史行 | `closeAllDispatchActivity` / `releaseDispatchActivity` / `closeTurn` / `dispose` / `parkSessions` / `closeSession` / `forceReset` |

**顺序与不变量**（[AGENTS/protocol.md §6.3](../../AGENTS/protocol.md)）：

- `justCompleted` 判定必须**早于** `noteDispatchProgress`；同一帧既是 detached 信号又是 completed 时**从不点亮**，只关闭已亮的行。
- 拆 `completed = completed || failed` 为两个终态时，不得改变 `allDispatchesCompleted()` / `dispatchedDetachedWorker` / hold 进入条件 —— 那三个仍只关心「报完没有」，不关心「报得好不好」。
- 任何拆除路径都必须写一条终态帧，**绝不留下永久「运行中」**。当前 `releaseDispatchActivity` 只发 `running:false`，这是必须补的洞。
- `failed` 的原因可能为空字符串 / 对象 / 数组；按约束 29 保留形状，不许窄判定读成空。

**拆除路径 → 终态**（已终态的行不得被覆盖）：

| 路径 | 终态 |
|---|---|
| `trackBackgroundDispatch` 看到 `status === 'completed'` / `'failed'` | `completed` / `failed`；原因取该帧 `content` 原文，没有就「agent 未给原因」 |
| `closeTurn` 带 `kind: 'cancelled'`（`abortActiveSegment` / `settle` / cancel 兜底 / 看门狗）且 dispatch 无终态 | `cancelled` |
| `closeTurn` 带 `kind: 'error'` / `'stop'` 且 dispatch 无终态 | `unknown`（回合结束不是 worker 结束的证据） |
| `releaseAll`（进程死亡 / 空闲释放） | `unknown` |
| `closeSession('closed' / 'agent-stopped' / 'agent-died')` | `unknown`（关会话不是取消 worker） |
| `dispose` / `parkSessions` / `forceReset` | `unknown` |

- **迟到的终态帧**：`trackBackgroundDispatch` 在 `closedTurn` 后直接返回，回合关闭后才到的 completion / failure 不会改写记录，该行保持 `unknown`。这是已知限制，不是 bug；验收只要求不永久「运行中」。

---

## 5. UI 设计

### 5.1 claim 分流（只在 ACP 会话替换）

`createSubagentCatalogClaim` 已用 `createSeatClaim` 拿下 `conversation.session.header.actions` 的 `subagent-catalog` cell，`syncAcpMode` 负责装 / 撤。改 `SubagentCatalogOccupant`：

```
ACP 会话  → <OwnSubagentCatalog />   （插件自绘）
非 ACP   → <Host />                 （原样渲染宿主组件，props 不改）
```

- **两个分支必须是不同组件类型**：React 会卸载旧组件、挂载新组件，hook 数量各自固定。严禁在同一组件里按 `acpMode` 条件调用 `useSessions`（hook 数量翻转会让槽位错误边界 abdicate，见 [AGENTS/ui.md §4.3](../../AGENTS/ui.md) 对 `useSessionStatus` 的同类踩坑）。
- 现有 `useUi(props.acp)` 在父 occupant 里无条件调用，保持不变。
- 闸门仍是 `ui.acpMode[dshSessionId] === true`；`standDown` / 卸载仍 `claim.release()`，非 ACP 会话里这条 entry 不存在（约束 18/20）。
- claim 是**页面级**的：多视图里只有舞台会话拿到 `acpMode === true`，同屏其它 ACP 面板直通宿主组件 —— 与座位 claim 的全局性是同一取舍，已知且接受。

### 5.2 fail-open（唯一允许的失败模式是「不接管」）

宿主演化后以下任一情况，`<OwnSubagentCatalog />` 必须退回渲染宿主组件，而不是画空白面板或假装列表为空：

- 宿主 entry 缺席 / slot `kind` 不是 `list` / 缺 `component` · `inject` · `locale`；
- `useSessions` prop 缺失、形状不认识，`projectionsBySession[sessionId]?.values.subagentCatalog` 不是数组；
- 投影数组里出现 `mode !== 'external'` 的行（说明这条 ACP 会话里还有宿主原生子代理，导航能力我们不能替代）→ 直通宿主组件，保住 `openChild`。

`host.inject` 的 `openChild` / `openChildAside` / `refreshProjection` 继续合并进 inject face（fail-open 分支要用），`createSubagentCatalogClaim` 的 `findHostCatalog` 校验不变。诊断照旧经 `onDiag` 如实上报，不假装已安装。

### 5.3 列表与详情

- **trigger**：`累计 N 个 · M 运行中` 分开写（修掉截图里「11 个子智能体」的歧义）；运行中才点亮图标。
- **每行**：状态徽标（六态）+ `type · 描述` + `耗时 / 最后活动 / 工具调用数`；耗时用 `endedAt ?? now - startedAt`，运行中的行按秒推进，结束后冻结。`unknown` 行明确写「历史记录，状态未知」。
- **点击整行**打开详情浮层：挂 `shell.overlay`，照 `settings-dialog.tsx` 的模块级 open state 做跨槽位开合（`AcpSettingsDialog` / `useAcpSettingsDialogOpen`）。详情内容：dispatch 的原始入参（`prompt` / `description` / `subagent_type`）、终态与失败原因原文、该 worker 的文本 / 思考 / 工具卡 / 结果流。过滤条件必须**同时**包含两类帧：`toolCallId === <dispatch id>`（dispatch 自己的 `tool_call` / 完成帧；完成帧没有 `_meta`，原始入参也在这里）与 `_meta['codebuddy.ai/parentToolCallId'] === <dispatch id>`（worker 自己的更新）。只按后者会丢掉原始入参与终态原因。
- **只读**：不做 prompt / cancel / spawn / 重试 / 停止（[AGENTS/ui.md §5](../../AGENTS/ui.md) 的 NTR 视图只读纪律同样适用于此面板）。
- 样式只走宿主 alias token（约束 34），状态色按 `state-*-tertiary` / `state-*-primary` 配对；不写 `color-scheme`，不维护 JS 主题状态。文案中英双版进 `locale/`。

### 5.4 明细的归属问题（必须单独解决）

`src/client/store.ts` · `foldUpdate` 会丢掉 `_meta`，且把相邻同类 prose 合并成一个 `Block` —— worker 正文与父回合正文会串在一起。**不要拿现有 `blocks` 当详情数据源**。两条路线：

- **推荐**：新增独立的有界原始条目索引 `UiState.subagentDetails`，只从 live `session/update` 帧按上条规则追加；页面刚重载、该 worker 缓冲为空时，打开详情走 `subagents/detail` RPC 向宿主要一次有界历史，再落进同一个索引。**不要**再在浏览器侧从 `session/chat-transcript` 全量重建——那会和 RPC 变成两套事实源，还把整份 transcript 拉进 store。索引主键是 `dshSessionId + childId`，不能只用 `childId`（不同会话的 `toolCallId` 可能重复）。不碰 `foldUpdate`，不影响 NTR 视图，也不违反约束 29。
- 备选：给 `Block` 加归属并改合并规则 —— 会动到 NTR 视图渲染，且跨 worker 合并必须拆开，回归面更大。**不选**。

---

## 6. 保留策略（单独上限，按 worker 计）

| 上限 | 值 | 语义 |
|---|---|---|
| `MAX_SUBAGENT_DETAIL_ENTRIES` | **200 条 / worker** | 原始 `session/update` 条目；超限丢最旧**并折一行截断标记**（约束 29 / 约束 8） |
| `MAX_SUBAGENT_DETAIL_WORKERS` | **64 个 / 浏览器会话** | 浏览器 `subagentDetails` 最多保留这么多 worker 的明细索引，超出按最久未打开 LRU 逐出，防长会话打开几十个详情后内存无界 |
| `MAX_SUBAGENT_RECORDS` | **200 条 / 聊天会话** | `agents.json` 的终态记录；逐出最旧的已终态记录，列表仍从宿主投影读全量，被逐出行标「未知」 |
| 单条原文 | 复用 `ACP_TOOL_RAW_MAX`（256000 字符） | 超限只截断且留标记 |

- 详情**只在内存 + 浏览器 store，不落盘**：体积大、写放大明显，且 `agents.json` 是整体重写。**DSH 重启后明细不可读**，面板明说「本次运行前的明细已不可读」，但标签 / 派出时间 / 终态 / 耗时仍在 —— 不承诺全量历史。
- 与整会话的 `transcriptMaxEntries`（600）/ 浏览器 `MAX_BLOCKS`（400）**互不占用**：这是按 worker 计的独立预算，长会话里早期 worker 不会被后来的更新挤光。
- `subagentFrames` 现有的 256 条重放日志退役后，`subagents/record` 帧沿用同一套 store 侧 seq 与「读前记 seq、读后重放在途帧」去重（照 `readChatSessionList` 的 `chatRowFrameSeq` / `replayChatRowFrames`），否则一份旧 `chat-list` 快照会盖掉刚到的终态。

---

## 7. 变更清单（文件 + 符号名）

| 文件 | 改什么 |
|---|---|
| `src/protocol.ts` | `AcpEvent` 增 `subagents/record`（单条全量状态）；`ChatSessionView` 用 `subagents` 记录数组替换 `activeSubagents`；新增 `subagents/detail` 载荷（`{ dshSessionId, childId }`）与 `SubagentRecord` / `SubagentStatus` |
| `src/impl.ts` | `dispatchRpc` 加路由与校验；`appendExternalSubagentCatalog` **不动**；记录归一化 / 上限裁剪的纯函数放这里（照 `permissionReplayFrames` 的可测试风格） |
| `src/bridge/types.ts` / `src/bridge/turn-stream.ts` / `src/bridge/session-registry-service.ts` / `src/bridge/persistence-service.ts` | `src/bridge/types.ts` · `BackgroundDispatch` 增 `terminal` / `startedAt` / `endedAt` / `lastActivityAt` / `error` / `counts`；`trackBackgroundDispatch`（已不存在）拆 completed/failed 并记原因；**在 dispatch 创建与状态迁移处发 record 帧，不受 `catalogReported` 门禁**；`closeDispatchActivity` / `closeAllDispatchActivity` / `releaseDispatchActivity`（已退役）与 `src/bridge/turn-stream.ts` · `closeTurn` / `dispose` 按 §4 的表写终态；`src/bridge/session-registry-service.ts` · `chatSessions` 带 live + released 会话的记录快照；`src/bridge/persistence-service.ts` · `persistAgents` / `loadPersistedAgents` 读写 `subagents` 键并只在状态迁移落盘、加载时 prune 孤儿键；`src/bridge/session-registry-service.ts` · `chatTranscripts` 增加按 `toolCallId` + `parentToolCallId` 过滤的按需详情读（含 released 会话的存量 buffer） |
| `src/index.ts` | 无改动（`wireSubagentCatalog` 与 SSE 路由都不动）；快照由 `session/chat-list` 行携带 |
| `src/client/store.ts` | `UiState.subagents` / `UiState.subagentDetails`（主键 `dshSessionId + childId`）；`subagents/record` 折叠、store 侧 seq 重放去重；`subagents/detail` 按需调用；明细与记录的有界逐出（worker LRU）；`activeSubagents` / `subagentFrames` 退役 |
| `src/client/subagent-activity.tsx` | `SubagentCatalogOccupant` 分流；`mergeSubagentStatuses` / `useSessionStatus` patch 退役；`findHostCatalog` / `createSubagentCatalogClaim` 的 fail-open 校验保留并扩展 |
| `src/client/subagent-panel.tsx`（新） | `OwnSubagentCatalog`（trigger + 列表）+ `SubagentDetailDialog`（`shell.overlay`）+ 状态 / 耗时 / 上限的纯函数 |
| `src/client/index.tsx` | `syncAcpMode` 的 `subagentCatalogClaim` 注册保持不变；`shell.overlay` 注册详情浮层；`chatFace` 传递不变 |
| `src/client/acp-ui.tsx` | `ensureAcpStyle` 增面板样式（alias token）；模块级详情 open state（照 `useAcpSettingsDialogOpen`） |
| `locale/*.json` | 六态文案、详情标题、截断标记、「该 agent 未上报子智能体」、「历史记录，状态未知」 |

**文档同步（同一提交内）**：[AGENTS/ui.md §4.3](../../AGENTS/ui.md) 整节改写；[AGENTS/protocol.md §6.3](../../AGENTS/protocol.md) 改「目录行的活跃态」段；[AGENTS/host.md §5.1](../../AGENTS/host.md) 把 `projection subagentCatalog` / `useSessions` 加进植入点表，§5.2 补一行症状；[AGENTS/state.md §1](../../AGENTS/state.md) 在 `agents.json` 那行补 `subagents` 键；[AGENTS/retired.md](../../AGENTS/retired.md) 追 `mergeSubagentStatuses` / `activeSubagents` / `subagents/update`；发版时补 [CHANGELOG.md](../../CHANGELOG.md)。根 AGENTS.md 已在 150 行硬上限 —— 如需新增硬约束，先等量外置，不净增行。

---

## 8. 测试计划

- `tests/subagent-activity.spec.tsx`：ACP 分支渲染自绘、非 ACP 直通宿主组件、投影形状不认识时 fail-open、`useSessions` 缺席、claim 的装 / 撤；fake host 已传 `useSessions`（`renderShadow`），补 `projectionsBySession` 的样本数组。
- `tests/store.spec.ts`：`subagents/record` 折叠、`chat-list` 快照与在途帧按 seq 重放去重、上限逐出留截断标记、页面重载后按需走 `subagents/detail` 拉详情、明细 worker LRU、六态显示文案。
- `tests/bridge.spec.ts`：completed / failed / cancelled / unknown 四种终态各发一帧；同一帧 detached + completed 不点亮；**未上报 catalog 的 dispatch 也发 record 帧**；每条拆除路径都不留 `running`；`agents.json` 只在状态迁移落盘（活动更新不写盘）、往返与历史行标 `unknown`、孤儿 `subagents` 键在加载时被 prune；回合关闭后迟到的完成帧不改写记录；hold 进入条件不因拆终态而改变。
- `tests/mock-agent.mjs`：当前没有 `status: 'failed'` 的 dispatch 变体，新增 `DISPATCHFAILED`（完成帧不带 `_meta`，按 callId 认），再补一条带 `content` 失败原文的用例；补一条首个 `tool_call` 帧不带 status 的 dispatch，覆盖 `pending` 默认态。
- `tests/impl.spec.ts`：`subagents/detail` 的载荷校验（`acp:` 前缀、会话归属）、记录 schema 归一化与上限裁剪。
- `tests/acp-view.spec.ts`：浏览器半区纯函数（状态标签、耗时格式、上限裁剪、截断标记、`unknown` 文案、详情过滤同时命中 `toolCallId` 与 `parentToolCallId`）。
- 提交前全量：`npm run prepack`。

---

## 9. 风险与不变量

1. **hook 数量**：§5.1 的分流必须是两个组件类型；条件调 `useSessions` 会让槽位错误边界吞掉整条 entry。
2. **不碰回合生命周期**：新帧只做展示；`allDispatchesCompleted` / `dispatchedDetachedWorker` / `holdForBackgroundDispatch` 的语义一字不改（约束 23）。
3. **不静默丢数据**：失败原因的形状（字符串 / 对象 / 数组）、详情超限截断标记、每种 `session/update` kind 的去处，全部按约束 29 处理。
4. **失败放开**：宿主形状不匹配就退回宿主组件；诊断如实报告每次失败；组件里 `return null` 不算隔离。
5. **落盘位置**：只经 `pluginStateDir()`，不新增第四个文件，不往 `~/.dsh` 根丢东西（约束 28）。
6. **非 CodeBuddy agent**：`codebuddyMetaOf` 返回 `undefined` 时面板写「该 agent 未上报子智能体」，不假装空清单。
7. **宿主升级**：`subagentCatalog` 的 `wire.view` 数组形状、`stateVersion`、检查点 `ver` 都可能变；按 [AGENTS/host.md §5](../../AGENTS/host.md) 冒烟并补 §5.2 症状行。检查点 `ver` 不匹配时宿主会从日志重折叠，**目录成员本身不会丢**。
8. **多视图**：claim 页面级，只有舞台会话替换；同屏其它 ACP 面板仍显示宿主 trigger，视觉不一致是已知取舍，不新增 per-session 钩子去修。
9. **历史一致性**：插件升级前的 catalog 行没有插件记录 → `unknown`，不许回填成 `completed`。
10. **写放大**：`agents.json` 是同步全量重写；record 只在状态迁移落盘，`lastActivityAt` 只留内存。任何「每条更新都 persist」的实现都是错的。
11. **广播点**：record 帧不得挂在 `catalogReported` 门禁后面；未上报 catalog 的 dispatch 必须能被面板看到（「目录待同步」）。
12. **详情归属**：过滤必须同时命中 dispatch 自己的 `toolCallId` 帧与 worker 的 `parentToolCallId` 帧；索引主键必须带 `dshSessionId`，不能只用 `childId`。
13. **记录生命周期**：`subagents` 键随会话关闭 / agent 删除 / 加载时 prune，否则 `agents.json` 会一直变胖。
14. **快照竞态**：`chat-list` 快照与在途 `subagents/record` 帧按 store 侧 seq 去重，后者胜；旧快照不得覆盖新终态。

---

## 10. 实施顺序（别一次性大改）

1. **数据层**：`SubagentRecord` 契约 + 帧 + 桥的终态写入（§4 的路径表）+ `agents.json` 状态迁移落盘 + `chat-list` 快照 / 在途帧重放。此时**不动 UI**，仍走宿主 trigger；用 `tests/bridge.spec.ts` / `tests/store.spec.ts` 验证四种终态与重放。
2. **在 NTR 视图页签里验证状态机**：`src/client/acp-view.tsx` 增一个只读分区显示六态与耗时，零槽位风险；真机（CodeBuddy multitask）跑一轮确认 completed / failed 判据，以及详情过滤能否同时命中 dispatch 帧与 worker 帧。
3. **替换头部 trigger**：§5 的 occupant 分流 + 详情浮层；最后才退役 `mergeSubagentStatuses` / `activeSubagents` / `subagents/update` 并同步 `AGENTS/retired.md`。
4. 按 [AGENTS/host.md §5](../../AGENTS/host.md) 跑宿主升级冒烟，`npm run prepack`，挂本地 DSH 真机验收 §12。

---

## 11. 未决项（接手时先答，别猜）

1. **投影数组里出现原生子代理行时的兜底**：§5.2 暂定「一律直通宿主组件」。若产品要求「原生行与 external 行同屏」，需要重新设计导航，另开方案，不在本方案里塞。
2. **明细是否落盘**：当前决定**不落**（体积与写放大）。若用户要求跨重启看明细，必须另定有界文件与预算，并同步 `AGENTS/state.md §1`。
3. **HMR 过渡**：host 与 client 是同一 bundle，`subagents/update` 退役不留兼容层；若实测 HMR 期间旧页面出现空白，靠 §5.2 的 fail-open 兜，不恢复第二套事实源。

---

## 12. 验收标准

- [ ] ACP 会话头部只有**一个**子智能体入口，是插件自绘的；非 ACP 会话是宿主原生 trigger，视觉与升级前一致。
- [ ] trigger 把「累计派出 N」与「当前 M 运行中」分开写；同一会话跨多轮累积的行不会越刷越少。
- [ ] 六态可辨：派发即 `pending`（含首帧无 status 的空串）→ worker 更新即 `running` → `completed` / `failed` 分别显示；失败行展示 agent 原文原因（没有就写「agent 未给原因」）；用户取消显示 `cancelled`；进程拆除 / 升级前历史行显示 `unknown`，**没有任何行永久停在「运行中」**。
- [ ] 尚未上报 host catalog 的 dispatch 也出现在列表里，标「目录待同步」，不被 `catalogReported` 门禁吞掉。
- [ ] 点击任一行打开详情：原始入参、终态、失败原因、该 worker 的文本 / 思考 / 工具卡 / 结果流（dispatch 帧与 worker 帧都命中），且不与父回合正文串在一起。
- [ ] 详情超 200 条 / worker 时丢最旧并留截断标记；终态超 200 条 / 会话时逐出最旧已终态记录，列表仍全量、被逐出行标「未知」；浏览器明细索引不超过 64 个 worker（LRU）。
- [ ] `agents.json` 只在状态迁移时写；worker 活动更新不触发落盘；孤儿 `subagents` 键在加载 / 会话关闭时被 prune。
- [ ] 刷新页面 / 重连：列表、终态、耗时从 `chat-list` 快照恢复，在途帧按 seq 去重不覆盖新终态；DSH 重启后标签 / 派出时间 / 终态仍在，明细明说不可读。
- [ ] 宿主 entry 缺失 / 投影形状不认识 / 出现原生行时，自动退回宿主组件并在诊断里如实说明；普通会话根本看不到插件面板。
- [ ] `npm run prepack` 全绿；bridge 集成用例覆盖四种终态与所有拆除路径；§6 的三处 hold 语义一字未变。
- [ ] `AGENTS/ui.md §4.3` / `AGENTS/protocol.md §6.3` / `AGENTS/host.md §5.1` / `AGENTS/state.md §1` / `AGENTS/retired.md` / `docs/README.md` 同步更新；发版补 `CHANGELOG.md`。
