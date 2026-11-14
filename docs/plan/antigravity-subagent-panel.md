# 方案：Antigravity 子代理进入子智能体面板（transcript 方案）

**状态**：**已实现，待真机验收**（P1–P3 已落地，任务级审核 + 整枝终审 + 修复波复审全部通过，`npm run prepack` 全绿；§12 未决项与 §13 真机验收需一个已认证的 agy 会话，由用户执行；docs/todo.md 与 docs/README.md 登记随合并进行）。
**适用范围**：ACP preset 会话里由 `agy acp` 服务的会话；桥接层新增 agy 专属识别与读取，浏览器面板尽量复用既有 `OwnSubagentCatalog`。
**一句话**：agy 的 ACP wire 不上报任何子代理生命周期（没有 CodeBuddy 那套 `_meta`），但它的私有 transcript 留了完整证据——派发结果里有子代理 `conversationId`，子代理自己的 brain transcript 有完整步骤流，报告以 `SYSTEM_MESSAGE` 写回父 transcript。照 [antigravity-late-output.md](./archive/antigravity-late-output.md) 的「只读 transcript」路子，把 agy 子代理喂进既有 `SubagentRecord` / 面板，做到六态可辨、可点进详情。

> 写作约定：代码位置一律用「文件 + 符号名」，不写行号。本文不是 `AGENTS/` 文档。本文是**可独立接手**的方案：§2 是改动前不必重查的证据，§4–§7 是设计，§12 是接手先答的未决项，§13 是验收口径。

---

## 1. 结论与拍板点

1. **根因不在面板，在数据源**：既有面板（[subagent-panel.md](./subagent-panel.md)，已实现）的两路数据——宿主 `subagent/catalog` 与插件 `subagents/record`——全由 CodeBuddy 的 `_meta` 约定驱动（`src/bridge/turn-stream.ts` · `codebuddyMetaOf`、`src/bridge/subagent-service.ts` · `trackSessionBackgroundDispatch`）。agy 一个键都不发，所以面板对 agy 永远空，按既定非目标写「该 agent 未上报子智能体」。**本方案给 agy 另立一条 transcript 事实源**，不是改面板 UI。
2. **复用 `SubagentRecord` 与面板，不另起 UI**：agy 识别产出的记录与 CodeBuddy 同形（`childId = acp:<toolCallId>`、六态、counts、落 `agents.json` 的 `subagents` 键），浏览器左连接逻辑一字不改。新增的只是「agy 怎么产生这些记录」与「agy 明细从子代理 transcript 读」。
3. **状态由子代理 transcript 驱动，不由 wire 驱动**：派发工具调用本身**立即完成**（结果是「Created the following subagent」），子代理此后在父 transcript 静默地跑。所以「运行中 / 成功 / 失败」只能读子代理 brain transcript，不能等 wire 完成帧。
4. **顺带修空闲释放**：agy 子代理目前不算活跃工作（`src/bridge/agent-bridge.ts` · `hasActiveWork` → `src/bridge/turn-stream.ts` · `hasPendingBackgroundWork` 只认 CodeBuddy `backgroundDispatches`），静默子代理跑到空闲释放（默认 25–30 分钟）会被连进程一起释放。本方案让未终态的 agy dispatch 也算活跃工作（带静默上限），否则面板会眼看子代理「运行中」却被释放成 `unknown`。

### 非目标

- 不做 per-worker 取消 / 重试 / 发消息：ACP 没有 agy 子代理控制面，面板**只读**（同 subagent-panel.md）。
- 不改 CodeBuddy 的识别 / hold / 收口逻辑（约束 23）：agy 走独立分支，`codebuddyMetaOf` 返回 `undefined` 时既有路径不变。
- 不新增第四个运行时落盘文件（约束 28）：记录仍落 `agents.json` 的 `subagents` 键；子代理 transcript 是 agy 的私有文件，**只读**。
- 不伪造 `SessionUpdate`、不往 NTR 转录视图塞合成条目（同 late-output §11.3）。
- 不解决「agy 服务端不推送」的根因：根治要 agy 自己在 wire 上报子代理生命周期。

---

## 2. 现状与证据（本机实测，改动前不必重查）

证据会话：`session-713cb81b-82c3-4625-bc99-f8ce13ca55e8`（agy，acp id `b7db1561-26a8-4649-a988-6ca5549a4bc2`，cwd `M:/Coding/dsh-ntr`）。两次派发：License Migrator（子代理 `0a3ed180-…`，跑 `npm run prepack` 约 10 分钟）、Git Committer（子代理 `837d2c23-…`，约 45 秒）。

### 2.1 wire 上没有子代理生命周期

- `agy.exe`（226 MB，字符串未压缩）grep 计数：`parentToolCallId` / `isBackground` / `subagentType` / `unsolicitedTurn` **全 0**，`invoke_subagent` 90 处。CodeBuddy 那套 `_meta` 键 agy 根本不带。
- 派发是一个普通工具调用：DSH 日志折叠成 `name: dsh_ntr__acp_tool_call`、`arguments: "Run invoke_subagent\n{…}"`。标题来自 ACP `toolCall.title`（`src/bridge/turn-stream.ts` · `permissionToolName` 先读 `title`），agy 设 `title = "Run invoke_subagent"`；`rawInput` 形如 `{ Model: "inherit", Prompt: "…", Role: "License Migrator", TypeName: "self" }`。
- 派发工具调用**立即返回**：`tool/result` 在调用后约 5 秒到达，内容是「Created the following subagent: { conversationId, logAbsoluteUri, workspaceUris }」。**这不是子代理完成**，只是「已创建」。子代理完成在 wire 上**没有任何帧**（无 prompt 在飞时 agy 不发 `session/update`，见 late-output §1）。
- `initialize` 实测（探针，认证前握手）：`agentCapabilities.loadSession = true`，`sessionCapabilities` 含 `resume / close / load / list / additionalDirectories`（**无 fork**），`_meta.antigravity = { tier: true, systemPrompt: { append: true } }`；`authMethods` 为 `oauth-personal / oauth-business / gemini-api-key / agent-platform`。**新 ACP 连接需要 `authenticate`（交互式 OAuth）**；插件不调它，靠 agy 缓存 token 自动认证。因此 wire 抓帧必须 ride 一个**已认证**的会话（实现时在用户正常会话里抓），不能由探针自行发起 OAuth。

### 2.2 私有 transcript 留了完整证据

父 transcript：`<storeRoot>/brain/<acpSessionId>/.system_generated/logs/transcript_full.jsonl`（storeRoot 默认 `~/.gemini/antigravity-cli`，`src/bridge/agy-transcript.ts` · `agyStoreRoot` / `agyTranscriptPaths` 已能解析）。每行一个 step，实测字段：`step_index` / `source`（`"SYSTEM"` 或 `"MODEL"`）/ `type` / `status`（`DONE` / `ERROR` / `RUNNING`）/ `created_at`（UTC 秒精度）/ `content` / `thinking` / `tool_calls`（`[{ name, args }]`，如 `run_command` 带 `CommandLine` / `toolSummary`）/ `input_tokens` / `output_tokens` / `cache_read_tokens`；`ERROR` 步另带 `error` 字段（原因字符串）。`type` 四类：`USER_INPUT`（用户输入）/ `PLANNER_RESPONSE`（source=MODEL，模型答复）/ `GENERIC`（source=MODEL，工具调用与结果记录）/ `SYSTEM_MESSAGE`（source=SYSTEM，系统注入：给子代理的任务、回父代理的报告）。

| 证据 | 形状 | 用途 |
|---|---|---|
| 派发结果（父 transcript `GENERIC` 步，也在 wire 的 tool 结果里） | `Created the following subagent:\n{ "conversationId": "<childId>", "logAbsoluteUri": "file:///…/brain/<childId>/.system_generated/logs/transcript.jsonl", "workspaceUris": […] }` | 拿子代理 `conversationId`；路径可由 `agyTranscriptPaths(storeRoot, childId)` 复用推出，不必解析 URI |
| 子代理报告（父 transcript `SYSTEM_MESSAGE` 步） | `[Message] timestamp=<ISO> sender=<childId> priority=MESSAGE_PRIORITY_HIGH content=<报告正文>` | 子代理完成的信号 + 报告正文；`sender` 对齐 childId |
| 子代理自己的 brain transcript | `brain/<childId>/.system_generated/logs/transcript.jsonl`，108 步（License Migrator）/ 18 步（Git Committer），含 `USER_INPUT` / `PLANNER_RESPONSE` / `GENERIC` / `SYSTEM_MESSAGE` | 运行中证据（步骤流）、明细、终态（最后一条 `PLANNER_RESPONSE` DONE） |

**失败信号（实测，关键区分）**：`status === 'ERROR'` 的 `GENERIC` 步是**运行中的工具错误**（`error` 字段带原因，如「target content not found in the file」），**不是子代理终态失败**——子代理 `ecfb4b3b` 有 6 个 ERROR 步仍以 `PLANNER_RESPONSE` DONE 成功收尾。所以子代理终态要看**最后一条 `PLANNER_RESPONSE`**：DONE = 成功；真正的终态失败形状（最后一步 ERROR / 无 DONE 答复）尚未抓到失败案例，确认前归 `unknown`（§12.3）。

**完成信号（实测）**：子代理收尾时依次写「`Message sent to "<父conversationId>"`」的 `GENERIC` 步 + 最后一条 `PLANNER_RESPONSE` DONE（自述「已回传主代理」）；父 transcript 同时刻收到 `sender=<childId>` 的 `SYSTEM_MESSAGE`（报告正文）。三者同秒到达。**取父 transcript 的 `SYSTEM_MESSAGE(sender=childId)` 为权威完成信号**（它就是报告投递本身），子代理最后 `PLANNER_RESPONSE` DONE 作兜底；二者去重，不重复计完成。

**关键时间线事实**：子代理干活期间**父 transcript 静默**（License Migrator 那次，父 step 3→step 4 之间 10 分钟无新步），活动全在子代理自己的 brain 里。所以「盯父 transcript 续期」救不了静默子代理——必须盯子代理 transcript（这正是 late-output 问题1 选「加长窗口」而非「父活动续期」的原因，见 §6）。

### 2.3 面板与记录现状（决定改动落点）

| 事实 | 位置 |
|---|---|
| 记录形状与落盘 | `src/protocol.ts` · `SubagentRecord` / `SubagentStatus`；`src/bridge/subagent-service.ts` · `noteSubagentRecords` / `syncDispatchRecord` / `subagentsFor` / `persistedRecords` / `restore`；落 `agents.json` 的 `subagents` 键 |
| CodeBuddy 识别（agy 不走这条） | `src/bridge/subagent-service.ts` · `trackSessionBackgroundDispatch`（只认 `codebuddy.ai/toolName=Agent/Task` / `isBackground` / `parentToolCallId`） |
| 目录上报 | `src/bridge/subagent-service.ts` · `reportSubagentCatalog` → `src/index.ts` · `wireSubagentCatalog` → `src/impl.ts` · `appendExternalSubagentCatalog`（`acp:<toolCallId>` + label，`mode: external`） |
| 明细按需读（只读父 transcript） | `src/bridge/subagent-service.ts` · `subagentsDetail`（按 `toolCallId` + `_meta.parentToolCallId` 过滤 `session.transcript`）——**对 agy 只命中派发帧，没有子代理干活的内容** |
| 空闲释放活跃判定 | `src/bridge/agent-bridge.ts` · `hasActiveWork` / `hasOtherActiveWork` → `src/bridge/turn-stream.ts` · `hasPendingBackgroundWork`（只认 `backgroundDispatches` + `ambient`） |
| transcript 只读原语 | `src/bridge/agy-transcript.ts` · `AgyTranscriptTail` / `agyTranscriptPaths` / `parseTranscriptStep` / `isAntigravityAgent` / `agyStoreRoot` |
| 浏览器面板 | `src/client/subagent-panel.tsx` · `OwnSubagentCatalog` / `SubagentDetailDialog`；`src/client/store.ts` · `UiState.subagents` / `subagentDetails` / `loadSubagentDetail` |

---

## 3. 数据归属与契约

复用 subagent-panel.md §3 的归属表，agy 只补两处：

| 字段 | 权威来源 | 落盘 |
|---|---|---|
| `childId` / `label` / `mode` / 累计派出数 | 宿主 `subagentCatalog` projection（插件上报 `acp:<toolCallId>`） | 宿主侧 |
| `status` / `startedAt` / `endedAt` / `lastActivityAt` / `error` / `counts` | **agy 子代理 transcript**（轮询）+ 派发 wire 帧 | `agents.json` 的 `subagents` 键 |
| 明细 | **子代理 brain transcript**（只读，按需） | 不落盘 |

`SubagentRecord` 增一个**可选**字段（形状变化走可选字段，不搞迁移脚本，约束 28 / state.md §1）：

```ts
interface SubagentRecord {
  // …既有字段不变…
  /** agy 子代理的 brain conversationId；CodeBuddy 记录不带。明细读与状态轮询用它定位 transcript。 */
  childConversationId?: string
}
```

- `childId` 仍是 `acp:<派发 toolCallId>`（与宿主 catalog 对齐，浏览器左连接不变）；`childConversationId` 是 agy 内部 id，**只用于读 transcript**，不当 catalog 主键。
- `label` 从派发 `rawInput` 取：`Role`（如 "License Migrator"）+ `Prompt` 首行/描述，照 `src/bridge/shape.ts` · `subagentDispatchLabel` 的可靠度排序新增 agy 分支（`Role` → `TypeName` → title）。
- `type` 取 `rawInput.TypeName`（实测多为 "self"）或 `Role`；没有就留空。
- 落盘只在状态迁移（同 subagent-panel.md §3.2）：`lastActivityAt` / `counts` 每轮询只留内存，**严禁**每 tick `persistAgents`。

---

## 4. 识别与读取设计

### 4.1 派发识别（wire，回合内）

新增 agy 专属跟踪（建议独立函数 `trackAgyDispatch`，由 `SubagentService` 持有，**不塞进** `trackSessionBackgroundDispatch` 的 CodeBuddy 分支）：

- 触发：`isAntigravityAgent(def)` 为真，且 `tool_call` 的 `title` 含 `invoke_subagent`（或 `rawInput` 同时带 `Role` / `Prompt` / `TypeName`——**接手时按 §12.1 抓一次 wire 确认主键**）。
- 创建 `BackgroundDispatch`（或 agy 专属轻量记录）：`toolCallId`、`startedAt = now`、`status = 'pending'`、`catalogLabel` 从 `rawInput` 取、`detached = true`（agy 子代理一律离回合）。
- 派发结果帧（`tool_call_update` completed，content 含 `Created the following subagent`）：解析 `conversationId` 写进记录的 `childConversationId`，**此时不置 completed**（这只是「已创建」）；状态转 `running`，开始轮询子代理 transcript。
- 创建即发 `subagents/record`（不受 `catalogReported` 门禁，同 subagent-panel.md §3.2）；身份确认后上报 catalog（`reportSubagentCatalog`）。
- 历史回放不算新派发：照 CodeBuddy 的双信号（`session.loadingHistory` + agent 回放标记）跳过记账。**agy 的 `session/load` 回放形状未实测**，列入 §12.2。

### 4.2 子代理 transcript 轮询（状态 + 活动）

每个未终态 agy dispatch 起一个 `AgyTranscriptTail`（路径 `agyTranscriptPaths(storeRoot, childConversationId)`），复用 late-output 的 poll 节拍（`agyLateOutputPollMs`，默认 1s，全部 `unref`）：

- **运行中**：子代理 transcript 有新步 → `lastActivityAt = now`、`counts` 累加、状态保持 `running`。
- **成功**：子代理最后一条 `PLANNER_RESPONSE` 且 `status === 'DONE'`、`content` 非空 → `completed`、`endedAt`；或父 transcript 出现 `sender === childConversationId` 的 `SYSTEM_MESSAGE`（更早的完成信号，二者取先到）。
- **失败**：子代理 transcript 的失败信号**形状未实测**（§12.3）——候选：`status !== 'DONE'` 的终态步、含错误的 `SYSTEM_MESSAGE`。接手先抓一个失败子代理确认；确认前失败一律归 `unknown`，不猜。
- **静默上限**：子代理 transcript 静默超过 `backgroundTaskToolMs`（默认 40 分钟，复用既有键）不再阻止释放；有未闭合工具步时按 `backgroundOpenToolCeilingMs` 宽限（复用 `hasPendingBackgroundWork` 的两档逻辑）。
- 轮询停止：dispatch 终态 / 会话 closed / released / 进程死亡。子代理 transcript 文件不存在时不轮询（同 late-output：绝不拿不存在的文件建 tail）。

### 4.3 明细（子代理 transcript，按需）

`subagents/detail`（`src/bridge/subagent-service.ts` · `subagentsDetail`）对 agy 记录改读**子代理 brain transcript**：

- 有 `childConversationId` → 读 `agyTranscriptPaths(storeRoot, childConversationId)`，返回有界步骤（`MAX_SUBAGENT_DETAIL_ENTRIES`，单步超 `ACP_TOOL_RAW_MAX` 截断留标记，约束 29）。
- 无 `childConversationId`（派发结果还没到 / 历史行）→ 回落既有父 transcript 过滤（至少能看派发入参与结果）。
- 明细**不落盘**（同 subagent-panel.md §6）：DSH 重启后若子代理 transcript 仍在盘上，agy 明细**反而可读**（这是 agy 相对 CodeBuddy 的优势——CodeBuddy 明细只在内存）；但插件不承诺，按「能读就读、读不到明说」处理。
- 浏览器侧 `loadSubagentDetail` 不变（仍走 `subagents/detail` RPC）；返回条目形状尽量与既有 `SubagentDetailEntry` 对齐，必要时加一个 `source: 'agy-transcript'` 标记让 UI 知道这是步骤流而非 `session/update`。

---

## 5. 状态机（六态，全部从证据派生，不猜）

| 态 | agy 判据 |
|---|---|
| 排队中 `pending` | 派发 `tool_call` 已到、结果（`conversationId`）未到 |
| 运行中 `running` | 拿到 `conversationId`，子代理 transcript 在长步 / 父 transcript 还没收到该 child 的 `SYSTEM_MESSAGE` |
| 成功 `completed` | 子代理最后 `PLANNER_RESPONSE` DONE，或父 transcript 收到 `sender=childId` 的 `SYSTEM_MESSAGE` |
| 失败 `failed` | 子代理 transcript 的失败信号（§12.3 确认前归 `unknown`） |
| 已取消 `cancelled` | 用户 cancel 回合（agy 子代理可能仍在跑，插件无法控制；记录标 cancelled，面板只读） |
| 未知 `unknown` | 进程拆除 / 空闲释放 / 升级前历史行 / 失败信号未确认 |

不变量（同 subagent-panel.md §4）：任何拆除路径写一条终态，**绝不永久「运行中」**；已终态不被迟到帧覆盖；`unknown` 不画成成功。拆除路径 → 终态表沿用 subagent-panel.md §4（`releaseAll` / `closeSession` / `forceReset` / `dispose` → `unknown`；cancel → `cancelled`）。

---

## 6. 与 late-output / 空闲释放的关系

- **共享原语**：`AgyTranscriptTail` / `agyTranscriptPaths` / `parseTranscriptStep` / `agyStoreRoot` / `isAntigravityAgent` 全部复用，不另写读取器。
- **late-output 问题1 已落地**（本次会话）：watch 改为「空闲窗 `agyLateOutputMaxMs`（默认 30 分钟，任何父 transcript 新步续期）+ 硬上限 `agyLateOutputCeilingMs`（默认 0）」，两键已暴露部署配置。**它盯的是父 transcript**，对静默子代理靠加长窗口熬过去。
- **本方案的升级机会（可选，不在首期）**：有了子代理 transcript 轮询后，late-output watch 可改成「父 OR 任一子代理 transcript 有新步就续期」——这才是对静默子代理真正活动驱动的版本（问题1 当时因范围暂缓的「选项 B」）。届时 `agyLateOutputMaxMs` 可回调短一些。列为后续 synergy，首期不做。
- **空闲释放**：`hasPendingBackgroundWork` 增 agy 分支——未终态 agy dispatch 且子代理 transcript 在静默上限内 → 算活跃工作。否则静默子代理跑到空闲释放被连进程释放，面板眼看 `running` 变 `unknown`，late-output 也救不回（进程没了）。这是 §1.4 的顺带修复，**首期必做**（否则面板状态不可信）。

---

## 7. UI（尽量零改动）

- 列表 / 六态 / 耗时 / trigger「累计 N · M 运行中」：复用 `OwnSubagentCatalog`，agy 记录与 CodeBuddy 同形，左连接不变。
- 详情浮层：复用 `SubagentDetailDialog`；agy 明细是步骤流（`PLANNER_RESPONSE` / `SYSTEM_MESSAGE` / 工具步），渲染按 `source: 'agy-transcript'` 走一个只读步骤视图（文本 / 思考 / 工具卡），不与父回合正文串。
- 「该 agent 未上报子智能体」文案：agy 会话**不再显示**（本方案让 agy 上报）；其它非 CodeBuddy/非 agy agent 仍显示。
- 样式只走宿主 alias token（约束 34），文案中英双版进 `locale/`。

---

## 8. 变更清单（文件 + 符号名）

| 文件 | 改什么 |
|---|---|
| `src/protocol.ts` | `SubagentRecord` 增可选 `childConversationId`；`SubagentDetailEntry` 视需要增 `source` 标记 |
| `src/bridge/agy-transcript.ts` | 增「从派发结果解析 `conversationId`」与「子代理终态/失败信号判定」纯函数（只读、限界、fail-open） |
| `src/bridge/subagent-service.ts` | 新增 `trackAgyDispatch`（wire 识别）+ 子代理 transcript 轮询（状态/活动/counts）+ `subagentsDetail` 的 agy 分支；复用 `noteSubagentRecords` / `reportSubagentCatalog` / `terminalizeSessionDispatches` |
| `src/bridge/shape.ts` | `subagentDispatchLabel` / 身份判定增 agy 分支（`Role` / `TypeName` / `Prompt`） |
| `src/bridge/turn-stream.ts` | `hasPendingBackgroundWork` 增 agy dispatch 活跃分支（静默上限两档复用） |
| `src/bridge/agent-bridge.ts` | `handleSessionUpdate` 把 agy 派发帧路由给 `trackAgyDispatch`（与 CodeBuddy 分支并列，互不影响） |
| `src/bridge/types.ts` | agy dispatch 记录形状（若不复用 `BackgroundDispatch`）；轮询 tuning 键（复用 `backgroundTaskToolMs` / `backgroundOpenToolCeilingMs`，必要时加 agy 专属 poll 键） |
| `src/client/subagent-panel.tsx` / `store.ts` | 明细 `source: 'agy-transcript'` 的只读步骤视图；其余尽量不动 |
| `locale/*.json` | agy 明细标题、步骤视图文案、「失败信号未确认→未知」 |

**文档同步（同一提交内）**：[AGENTS/protocol.md](../../AGENTS/protocol.md) §6.3 补 agy 识别段、§6.4 补与子代理轮询的关系；[AGENTS/state.md](../../AGENTS/state.md) §1 的 `subagents` 键补 `childConversationId`；[AGENTS/ui.md](../../AGENTS/ui.md) 面板段补 agy 明细来源；根 AGENTS.md 在 150 行硬上限，不净增。发版补 [CHANGELOG.md](../../CHANGELOG.md)（约束 35）。

---

## 9. 测试计划

- `tests/agy-transcript.spec.ts`：派发结果 `conversationId` 解析、子代理终态判定、失败信号（确认后）、坏行 fail-open。
- `tests/mock-agent-agy.mjs`：新增「派发子代理」剧本——派发工具调用 + 结果（含 `conversationId`）+ 子代理 brain transcript 步骤流 + 父 transcript `SYSTEM_MESSAGE` 报告；覆盖运行中→成功、失败、静默超时、历史回放。
- `tests/bridge.spec.ts`（或 `tests/bridge/` 就近）：agy 派发即发 record 帧（不受 catalog 门禁）；六态迁移；每条拆除路径不留 `running`；`agents.json` 只在状态迁移落盘；空闲释放把未终态 agy dispatch 算活跃（静默上限内不释放、超限释放标 unknown）；明细读子代理 transcript。
- `tests/store.spec.ts` / `tests/acp-view.spec.ts`：agy 明细步骤视图纯函数、`source` 标记渲染、上限截断。
- 提交前全量 `npm run prepack`。

---

## 10. 风险与不变量

1. **私有格式无契约**：agy transcript / 派发结果形状随版本可能变；解析一律 fail-open，失败归 `unknown`，不抛异常、不猜（同 late-output §10）。
2. **不碰 CodeBuddy 与回合生命周期**：agy 独立分支；`codebuddyMetaOf` 返回 `undefined` 时既有路径一字不改；hold / 收口语义不动（约束 23）。
3. **轮询预算**：每未终态子代理一个 tail，1s poll，全部 `unref`；终态 / 拆除即停；并发子代理数有界（`MAX_SUBAGENT_RECORDS`）。
4. **不静默丢数据**：失败原因形状、明细截断标记、每种步骤的去处按约束 29。
5. **落盘位置**：只经 `pluginStateDir()`，不新增第四个文件（约束 28）。
6. **写放大**：record 只在状态迁移落盘，`lastActivityAt` / counts 只留内存。
7. **空闲释放联动**：agy dispatch 算活跃工作必须带静默上限，否则永不释放（活锁）；上限复用既有两档键。
8. **只读**：不画假按钮（取消/重试），agy 子代理无控制面。
9. **历史一致性**：升级前 agy 会话没有记录 → 面板按宿主 catalog（若有）标 `unknown`，不回填 completed。

---

## 11. 实施顺序（别一次性大改）

1. **P1 识别 + 记录**：wire 认 `invoke_subagent`、解析 `conversationId`、产 `SubagentRecord`（pending→running）、catalog 上报、落盘。先不轮询子代理 transcript（状态停在 running），用 mock 验证记录与帧。
2. **P2 子代理轮询 + 终态**：transcript 轮询、成功/失败/静默判定、空闲释放联动。真机跑一次 License Migrator 同形场景验证六态。
3. **P3 明细**：`subagents/detail` 的 agy 分支 + 浏览器步骤视图。
4. **P4 文档 + 真机验收**：AGENTS/ 同步、`npm run prepack`、挂本地 DSH 验收 §13。
5. **后续 synergy（可选）**：late-output watch 升级为父+子活动续期（§6）。

---

## 12. 未决项（已坐实 vs 待抓帧）

transcript 侧已用本机 brain transcript 坐实（§2.2）；wire 侧两项需在**一个已认证的会话**里抓原始 `session/update` 帧（实现时做，**不自行发起 OAuth**）。

1. **派发识别主键** — 部分坐实：`title = "Run invoke_subagent"`、`rawInput = { Model, Prompt, Role, TypeName }` 已由 DSH 日志确认；`_meta` 是否带任何键**待抓帧**。识别用 `title` / `rawInput`，不依赖 `_meta`，不阻塞设计。
2. **agy `session/load` 回放形状** — **待抓帧**（`loadSession = true` 已确认）。是否重发历史派发、带什么标记未实测；历史回放跳过记账照 CodeBuddy 双信号（`loadingHistory` + agent 标记）设计，抓到后定标记。
3. **子代理失败信号** — 已坐实区分：`ERROR` 步是**运行中工具错误**（带 `error` 字段），非终态失败（`ecfb4b3b` 6 个 ERROR 仍 DONE 收尾）；终态看**最后一条 `PLANNER_RESPONSE`**。真正的终态失败案例尚未抓到，确认前失败归 `unknown`。
4. **完成信号取舍** — 已坐实：取父 transcript `SYSTEM_MESSAGE(sender=childId)` 为**权威完成信号**，子代理最后 `PLANNER_RESPONSE` DONE 作兜底；二者同秒到达，按 childId 去重，不重复计完成。
5. **明细步骤视图** — 已坐实形状：步骤流（`tool_calls[{name,args}]` / `thinking` / `content` / `source` / `status`）与 `session/update` 差异大，**另开只读步骤视图**（`source: 'agy-transcript'`），不复用 `SubagentDetailEntry` 的帧渲染。
6. **是否首期就做空闲释放联动** — 决策项：建议首期必做（§1.4）；若产品接受「静默子代理可能被释放」，可降级为后续，但面板状态会不可信。

---

## 13. 验收标准

- [ ] agy 会话派发子代理后，面板出现该行：派发即 `pending` → 拿到 `conversationId` 转 `running` → 子代理完成转 `completed`；失败可辨（信号确认后）；拆除 / 释放标 `unknown`，**没有永久「运行中」**。
- [ ] trigger「累计 N · M 运行中」正确；长会话累积行不越刷越少。
- [ ] 点行进详情：能看到子代理自己的文本 / 思考 / 工具步 / 报告（读子代理 transcript），不与父回合正文串。
- [ ] 静默子代理在静默上限内不被空闲释放；超限释放标 `unknown`；late-output 仍能补发最终答案。
- [ ] `agents.json` 只在状态迁移写；孤儿 `subagents` 键加载 / 关会话时 prune；`childConversationId` 往返不丢。
- [ ] 非 agy / 非 CodeBuddy agent 仍显示「该 agent 未上报子智能体」；CodeBuddy 行为一字未变；非 ACP 会话仍是原生 trigger。
- [ ] `npm run prepack` 全绿；AGENTS/protocol.md / state.md / ui.md 同步；发版补 CHANGELOG。