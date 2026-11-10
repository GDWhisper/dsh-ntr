# Antigravity 后台结果补发（transcript 方案）

本文件是 [docs/todo.md](../todo.md) 里「Antigravity 后台结果不推送」的实施方案。先读 [AGENTS.md](../../AGENTS.md)、[AGENTS/protocol.md](../../AGENTS/protocol.md) 的 §6.2 / §6.3，再读本文件。

本版已按对抗审核结论修订（6 条阻塞 + 12 条建议），设计细节以本文件为准。

## 1. 背景与判断

**现象**：Antigravity 在 `end_turn` 之后才完成的工作（定时任务、子代理唤醒、慢命令）不会推进聊天。用户在聊天框里看不到答案；用户发出下一条消息的瞬间，旧答案和新消息一起出现。

**根因（已实测，不在插件）**：`agy acp` 1.5.3 在没有 `session/prompt` 在飞时，不发送 `session/update`。后台回合的输出只写进本地 transcript；下一次 prompt 到达时，服务端先把积压帧（`tool_call_update` → 思考 → 旧答案文本）一次发出，再发新 prompt 的 `user_message_chunk`。

证据：

- `session-5207e7af-4e9d-4aea-aad2-f5b94333062a`：第 2 轮 01:56:20 收口；agy brain 在 01:56:23 生成完整答案；用户 02:12:57 发「分析得如何」，插件 0.1 秒后就记录到该答案，agy brain 没有新的模型步骤。
- 独立探针 `/tmp/agy-flush.mjs`：prompt 响应后空闲 20 秒，ACP 连接零帧；下一条 prompt 到达时，旧答案在 0 毫秒内到齐。
- claudian 的 [Antigravity AGENTS.md](/home/pax/coding/research/claudian/src/providers/antigravity/AGENTS.md) 也写明：`end_turn` 之后完成的工作「never streams; it lands only in the transcript」，它靠读 transcript 重建历史。

**结论**：插件收不到实时帧，不能靠 `session/update` 唤醒。可行的补发路径只有一条：**读 agy 自己的 transcript 文件，把晚到的 `PLANNER_RESPONSE` 当作后台报告投递进聊天**。

## 2. 目标与非目标

目标：

1. agy 会话在回合结束后产生后台答案时，聊天框在无人发消息的情况下出现该答案。
2. 用户下一条消息到达时，agy 回放的同一段旧文本不重复显示。
3. 不伪造 `session/prompt`、不改写用户输入、不新增收口路径。

非目标：

- 不覆盖非 agy agent；不解析 agy 的内部子代理语义；不把 transcript 写进 `agents.json`。
- 不影响 `/acp` RPC 面（没有 DSH 聊天身份，跳过）。
- 不解决 agy 服务端不推送的根因。根治要 agy 自己发 `session/update` 或宣告后台回合。
- 不在 NTR 转录视图造合成条目（见 §11.3）。

## 3. 事实与约束

**路径事实（本机实测）**：

- store root = `<gemini-dir>/<app-data-dir>`，默认 `~/.gemini/antigravity-cli`（Windows 用 `USERPROFILE`）。
- `agy acp --help` 有 `--gemini-dir` / `--gemini_dir`（默认 `.gemini`）与 `--app-data-dir` / `--app_data_dir`（默认 `antigravity-cli`）。
- 相对路径按 **home** 解析：`agy acp --gemini-dir .gemini-probe --app-data-dir probe-cli` 在 `$HOME` 下建出 `.gemini-probe/probe-cli`，与进程 cwd 无关。
- 转录文件：`<storeRoot>/brain/<sessionId>/.system_generated/logs/transcript_full.jsonl`，缺失时 `transcript.jsonl`。
- **`<sessionId>` 就是 ACP `session/new` 的返回值**：`AgentBridge.createSession` 把响应写进 `LiveSession.acpSessionId`，本机 `agents.json` 的 `chatSessions` 里 `session-5207e7af…` 的 `acpSessionId` 是 `b495405e-9837-4162-a450-f945e9a999ac`，该目录正好是 `~/.gemini/antigravity-cli/brain/b495405e-…`。

**行格式（本机实测）**：

- 每行一个 step，字段：`step_index`、`type`、`status`、`created_at`、`content`、`thinking`、`tool_calls`、`input_tokens`、`cache_read_tokens`。
- 晚到答案的形状：`type: "PLANNER_RESPONSE"`、`status: "DONE"`、`content` 非空。
- `created_at` 是 **UTC ISO 字符串，秒精度**（`"2026-11-10T01:56:23Z"`）。
- `SYSTEM_MESSAGE`（`sender != system`）是子代理/任务报告，不是最终答案。本方案只投递 `PLANNER_RESPONSE`。

约束：

- transcript 是 agy 的私有格式，无公开契约。读取必须只读、限界、失败即静默放弃。
- 约束 23 只允许两种强制定稿。本机制**不收口 turn、不杀进程、不改 `running`**，只投递一条报告：它是**投递家族的新来源**（帧驱动之外新增文件轮询），不是第三种看门狗，也不属于 ambient 家族。
- 约束 16：不得向 agent 发送非用户文本。本机制不发送任何 prompt。
- 约束 29：不静默丢弃。投递失败留 `agent/notice`，正文仍留在 transcript。
- 约束 24：路径判定走 `isAbsolutePath`（`src/impl.ts`），不写 `startsWith('/')`。

## 4. 数据流

```
turn/end (chat 面, agy 会话, outcome.kind === 'stop', 非 ambient)
   └─ manager.armLateOutputWatch(session, closedAt)
         └─ AgyLateOutputService.arm: baseline(offset) + poll 1s + deadline
               └─ poll: 读 transcript 新增行
                     ├─ 会话忙 (running || promptInFlight) → disarm，不投递
                     ├─ 发现 step_index > baseline 的 PLANNER_RESPONSE，且
                     │  created_at 秒 >= closedAt 秒，且文本不等于本轮已显示文本
                     │        └─ 静默 1.5s（每条新 step 续期）
                     └─ quiet 到点 → deliverLateReport
                           └─ 截断 BACKGROUND_REPORT_MAX → followup(背景报告唤醒)
                                 └─ AcpLlmAdapter.streamPrompt 的 backgroundReportOf 分支
                                       ├─ 本地 yield 报告（不发 session/prompt）
                                       └─ 提交 session.lateEcho（去重证据）

用户下一条消息
   └─ agy 先冲积压：tool_call_update → 思考 → 旧答案 → user_message_chunk
         ├─ echo guard 按 lateEcho.text 前缀吞掉旧答案
         └─ 新答案照常折叠
```

## 5. 设计

### 5.1 识别与路径（新文件 `src/bridge/agy-transcript.ts`）

纯函数 + 只读小模块，不依赖 `AgentBridge`：

- `isAntigravityAgent(def: AcpAgentDef): boolean`
  - `basename(def.command)` 去掉 `.exe` / `.cmd` / `.bat` 后等于 `agy`；
  - `def.args` 含 `acp`。
  - 不看 `def.id`：用户可以重命名。
- `agyStoreRoot(def: AcpAgentDef, env = process.env, platform = process.platform): string | null`
  - `home = platform === 'win32' ? env.USERPROFILE || os.homedir() : env.HOME || os.homedir()`；空 → `null`。
  - 从 `def.args` 读 `--gemini-dir` / `--gemini_dir`（默认 `.gemini`）与 `--app-data-dir` / `--app_data_dir`（默认 `antigravity-cli`）。两种写法都要认：`--flag=value` 与 `--flag value`。
  - `base = isAbsolutePath(geminiDir) ? geminiDir : join(home, geminiDir)`；`root = isAbsolutePath(appDataDir) ? appDataDir : join(base, appDataDir)`。
  - 解析结果规范化后返回；相对路径按 home 解析（§3 实测），不按 `def.cwd`。
- `agyTranscriptPaths(storeRoot, acpSessionId): string[]`
  - `acpSessionId` 必须匹配 `/^[\w-]+$/`，否则返回 `[]`；
  - 返回 `[transcript_full.jsonl, transcript.jsonl]`，调用方取第一个可读的。
- `parseTranscriptStep(line): TranscriptStep | undefined`
  - JSON 解析失败返回 `undefined`；`step_index` 非有限数字的也返回 `undefined`。
- `lateAnswerText(steps): string`
  - 按 `step_index` 升序取 `PLANNER_RESPONSE` 且 `status === 'DONE'` 且 `content.trim() !== ''` 的 `content`；
  - 多条用 `\n\n` 连接；没有任何一条返回 `''`。

### 5.2 增量读取（同文件 `AgyTranscriptTail`）

每个会话一个 tail 对象，**没有 `carry`**（按换行切，天然无残行）：

```ts
interface AgyTranscriptTail {
  path: string
  offset: number   // 已消费到的字节位置，恒等于最后一个 \n 之后
  lastStepIndex: number
}
```

`readNew(): TranscriptStep[]`：

1. `stat(path)`。异常、非普通文件、大小小于 `offset`（被截断/重建）→ 重置 `offset = 0`。
2. 从 `offset` 读最多 512 KiB 字节。
3. 在字节层找最后一个 `0x0A`。存在 → 只取到该字节（含），`offset += 该长度`，然后整体 `toString('utf8')`（不切多字节字符）；不存在 → 本次不产出、不推进（等下一次 tick）。
4. 兜底：若缓冲已是 1 MiB 仍无换行，丢弃到第一个换行并推进，避免永久卡住。
5. 按 `\n` 切行，逐行 `parseTranscriptStep`，跳过空行与坏行。
6. 更新 `lastStepIndex`（取最大值）。

`baseline(): void`：在 arm 时调用，`offset = stat.size`，`lastStepIndex` 取文件现有最后一行的 `step_index`（读尾部一个 64 KiB 窗口即可）。arm 之前的内容绝不重放。

### 5.3 监听生命周期（新文件 `src/bridge/agy-late-output.ts`）

`AgyLateOutputService`，由 `BridgeManager` 持有，每会话最多一条记录：

```ts
interface LateWatch {
  tail: AgyTranscriptTail
  closedAt: number
  pollTimer: Timeout
  quietTimer?: Timeout
  deadlineTimer: Timeout
  steps: TranscriptStep[]
}
```

依赖注入（构造参数）：`{ isAgent(def), storeRoot(), tuning(), host }`，`host` 提供 `sessionOf(agentId, dshSessionId)`、`isBusy(session)`、`deliver(session, text)`、`notice()`。测试替换 `isAgent` / `storeRoot`。

- `arm(session, closedAt)`：
  - 前置：`isAgent(defOf(session.agentId))`、`session.dshSessionId !== undefined`、`!session.closed && !session.released`、`session.acpSessionId` 合法、目标文件可读；
  - 全局开关 `agyLateOutput === false` 直接返回；
  - 同会话已有 watch → 先 `disarm`；
  - `baseline()` 后起 poll（`agyLateOutputPollMs`，默认 1000）与 deadline（`agyLateOutputMaxMs`，默认 600000），全部 `unref()`。
- `poll`：
  - `session.closed || session.released` → `disarm`。
  - **忙判定只用 `session.running === true || session.promptInFlight === true`**。为真 → `disarm`，不投递（下一轮会把积压折进来）。不要用 `session.turnController`：带工具卡的回合收口后控制器仍保留到续跑段结束，用它判忙会让第一次 poll 自杀。
  - `readNew()` 后筛候选：`step_index > baseline.lastStepIndex` **且** `created_at` 存在时其整秒 `>= floor(closedAt / 1000)`。时钟同机；`created_at` 秒精度决定用整秒比较。
  - 收到候选即入 `steps` 并重置 quietTimer（`agyLateOutputQuietMs`，默认 1500，可续期）；不改变 deadline。
- `quiet` 到点：`text = lateAnswerText(steps)`；
  - 空 → 继续等（后台可能只有工具帧）；
  - 与 `session.lastTurnAnswerText` 全等 → 是本轮自己刚显示的答案被迟写，丢弃并 `disarm`；
  - 否则 `deliver`，然后 `disarm`。
- `deadline` 到点：有文本且不忙就投递，否则静默 `disarm`。
- `disarm(session)`：清三个 timer，删记录；幂等。

生命周期钩子（**不要写在 `BridgeManager` 的 `releaseAll` 上：该方法在 `AgentBridge`**）：

- `AgentBridge.releaseAll` / `closeSession` / `forceReset` 已在调用 `clearAmbientState(session)`；`doResumeSession` 也调用它。因此 **`clearAmbientState` 是唯一收口点**：给 `LiveSession` 加一个 `stopLateWatch?: () => void`，`clearAmbientState` 里调用并清空。不需要在 `BridgeManager` 里找 teardown。
- 兜底：`makeBridge` 已有的 `onSessionBackgroundTeardown` 回调里也调一次 `lateOutput.disarm(session)`（覆盖不经过 `clearAmbientState` 的路径）。

`turn-stream.ts` 的 `TurnStreamController.closeTurn` 在 `current` 分支末尾、`this.session.running = false` 之后调用：

```ts
if (ambient === undefined && outcome.kind === 'stop') this.manager.armLateOutputWatch(this.session, Date.now())
```

`ambient !== undefined` 要排除：§6.2 的 drain 收口与 §6.3 的 hold 收口都用 `{ kind: 'stop' }`，它们自己会折正文，不该再补发。

### 5.4 投递（`SubagentService.deliverLateReport`）

```ts
deliverLateReport(session: LiveSession, text: string): boolean
```

1. `session.closed || session.released` → `false`。
2. `session.running || session.promptInFlight` → `false`。
3. `wakeAgentFor(session)` 为空 → `false`（`/acp`、headless、resolver 未挂载）。
4. `trim()` 为空 → `false`。
5. 正文按 `BACKGROUND_REPORT_MAX` 截断，留截断标记（约束 29）。
6. `session.pendingLateEcho = { text: clipped, at: Date.now() }`，调用 `wakeChatWithBackgroundReport(session, agent, clipped, { onFailure })`，返回 `true`。
7. `wakeChatWithBackgroundReport` 增加可选 `onFailure`：`followup` 同步抛错或 thenable reject → 发既有 `agent/notice`（措辞标明「late output」以区别于 CodeBuddy drain）并调 `onFailure`。
8. `onFailure` **按对象身份**比对后再清 `session.pendingLateEcho`：`if (session.pendingLateEcho === record) session.pendingLateEcho = undefined`。迟到的失败回调不能清掉下一轮的新记录。

**`lateEcho` 不在这里写**：wake 可能被 `backgroundReportOf` 的 FIFO 规则判为「用户插话压过」而返回 `undefined`，此时正文一次都不显示。若 `lateEcho` 已写，下一轮 agy 冲出的旧答案会被 guard 吞掉 → 双丢。所以：

- `BridgeManager.streamPrompt` 的 `backgroundReportOf` 命中分支里，真正 `yield` 报告前提交：
  ```ts
  const late = options.sessionId === undefined ? undefined : this.registry.sessionAt(options.sessionId, agentId)
  if (late !== undefined && late.pendingLateEcho !== undefined && late.pendingLateEcho.text === text) {
    late.lateEcho = { text, at: Date.now() }
    late.pendingLateEcho = undefined
  }
  ```
- `sessionAt` 不创建会话（区别于 `getOrCreateDshSession`）。
- 被 FIFO 跳过时什么都没发生：下一轮会重复显示旧答案一次，这是可接受的失败方向（fail-open）。

不写 `consumedDrains`：那不是同一个 `requestId` 语义，硬塞会污染 CodeBuddy 的消费表。不建 `BackgroundReport` 记录：`lateEcho` 自己就是「已投递、待去重」的证据。

### 5.5 回放去重（echo guard）

落点：`TurnStreamController.foldInto` 的 `agent_message_chunk` 分支（`foldInto` 是唯一折叠入口，覆盖 `onEvent` / `startSegment` / `drainTail` 三条路径）。`agent_message_chunk` 是增量文本，无 `replace` 语义，前缀累积成立。

启用条件（全部满足）：

- `session.lateEcho !== undefined`；
- `Date.now() - session.lateEcho.at <= agyLateOutputEchoMs`（默认 600000）；
- 本轮开始晚于 `lateEcho.at`（`this.turnStartedAt > lateEcho.at`）；
- 本段既不是 ambient 也不是 background 段。

状态放控制器：`private echoBuffer?: string`。

逐 chunk 四态（纯函数，导出以便单测）：

```ts
function applyEchoGuard(late: string, buffer: string, chunk: string):
  | { kind: 'hold'; buffer: string }                  // 仍是严格前缀
  | { kind: 'swallow'; buffer: string }               // 恰好相等
  | { kind: 'release'; buffer: string; emit: string } // 旧答案在新内容前面
  | { kind: 'mismatch'; buffer: string; emit: string }// 失配，全量输出
```

1. `next = buffer + chunk`。`late.startsWith(next)` 且 `next.length < late.length` → `hold`。
2. `next === late` → `swallow`，清 `lateEcho` 与 guard。
3. `next.startsWith(late)` 且 `next.length > late.length` → `release`，`emit = next.slice(late.length)`，清两者。
4. 其他 → `mismatch`，`emit = next`，清 guard 与 `lateEcho`（fail-open：宁可重复，不能吞新答案）。

收口兜底：`closeTurn` 时若 `echoBuffer` 非空且仍在 `hold`：

- `outcome.kind === 'stop'` → 把缓冲区作为正文折出去（重复优于丢弃），再清状态；
- `cancelled` / `error` → 直接丢弃并清状态。

`agent_thought_chunk` 不拦（思考默认折叠，重复一次无碍）。guard 只作用于文本形状的 content：非文本 content 被 `chunkTextOf` 兜底成 JSON 字符串，判断时跳过（失配即 fail-open）。

### 5.6 工具卡重放（P3，同批）

agy 冲积压时还会重发上一轮的 `tool_call_update`（真实会话里是 `Run schedule` 的完成帧），插件会再开一张同名卡。规则：

- `LiveSession.knownToolCalls?: Set<string>`：**已完成回合**见过的 `toolCallId`，只对 agy 会话创建；上限 512，超出按插入序淘汰。
- `LiveSession.turnToolCalls?: Set<string>`：本回合见过的 id。`closeTurn` 的 `current` 分支把 `turnToolCalls` 并入 `knownToolCalls` 后清空。
- `AgentBridge.handleSessionUpdate` 的工具分支：`replayed = session.knownToolCalls?.has(id) === true`；`replayed` 时**跳过 `activeToolCalls` 记账**（否则重放的 `in_progress` / 无 status 帧会把该 id 永久留下，把卡死窗口从 `turnStallMs` 抬到 `turnStallToolMs`）。随后无论是否重放，都把 id 记入 `turnToolCalls`。
- `foldInto` 的工具分支开头，紧挨既有的 `parentToolCallId` 早退再加一条：`knownToolCalls?.has(id)` → `noteToolRecord(update)` 后 `return true`，不开卡、不发起续跑。集合只在 agy 会话上存在，其它 agent 行为不变。
- `doResumeSession` / `forceReset` 清空两个集合。

接受并写明：重放帧仍进 `session/transcript`，所以 **NTR 转录视图里旧卡与旧答案仍会出现一次**；聊天面不重复。

### 5.7 清理与持久化

- `session.lateEcho` / `pendingLateEcho` / `knownToolCalls` / `turnToolCalls` / `stopLateWatch` 都是瞬态：不落 `agents.json`，不广播 `session/meta`。
- `clearAmbientState(session)` 清 `lateEcho` / `pendingLateEcho` / `turnToolCalls` / `knownToolCalls`，并调用 `stopLateWatch`。
- `lateEcho` 过期由 guard 惰性判，另在 `arm` 时清一次。
- 进程释放后 transcript 不会再长（写者是进程），watch 必须随 release 停掉。

## 6. 代码落点

| 文件 | 改动 |
|---|---|
| `src/bridge/agy-transcript.ts`（新） | `isAntigravityAgent` / `agyStoreRoot` / `agyTranscriptPaths` / `parseTranscriptStep` / `lateAnswerText` / `AgyTranscriptTail` |
| `src/bridge/agy-late-output.ts`（新） | `AgyLateOutputService`：arm / poll / quiet / deadline / disarm |
| `src/bridge/turn-stream.ts` | `LiveSession.lateEcho` / `pendingLateEcho` / `lastTurnAnswerText` / `knownToolCalls` / `turnToolCalls` / `stopLateWatch`；`closeTurn` 末尾 arm + 集合轮转 + guard flush；`foldInto` 的 guard 与重放早退；`applyEchoGuard` 纯函数；`clearAmbientState` |
| `src/bridge/subagent-service.ts` | `deliverLateReport`；`wakeChatWithBackgroundReport` 增加 `onFailure` |
| `src/bridge/agent-bridge.ts` | `handleSessionUpdate` 的 `replayed` 判定与 `activeToolCalls` 跳过、`turnToolCalls` 记账 |
| `src/bridge/manager.ts` | 构造 `AgyLateOutputService`、`armLateOutputWatch`、`makeBridge` 里接 `disarm`、`streamPrompt` 的 wake 分支提交 `lateEcho`、创建 agy 会话时初始化集合 |
| `src/bridge/types.ts` + `src/bridge/tuning.ts` | `BridgeTuning.agyLateOutput` / `agyLateOutputPollMs` / `agyLateOutputQuietMs` / `agyLateOutputMaxMs` / `agyLateOutputEchoMs` + 默认值 |
| `src/bridge/identity.ts` 或 `src/bridge.ts` | 新模块的导出（测试与 manager 使用） |
| `tests/agy-transcript.spec.ts`（新） | 路径、tail、文本提取、`applyEchoGuard` 四态 |
| `tests/bridge.spec.ts` + `tests/mock-agent.mjs` | 端到端补发与去重 |

不需要改 `src/impl.ts`（没有新 RPC）、`src/protocol.ts`（没有新 wire 类型）、`src/client/`（不新增 UI）。

`makeBridge` 不需要「传 `def`」：`AgentBridge` 与 `defsMap` 早就持有它。

## 7. 阶段与提交

每个阶段一次提交，提交前 `npm run prepack`。

| 阶段 | 内容 | 验收 |
|---|---|---|
| P1 | `agy-transcript.ts` + `tests/agy-transcript.spec.ts` | 路径与解析用例全绿；不接任何行为 |
| P2 | `AgyLateOutputService` + `deliverLateReport` + `closeTurn` 接线 + tuning | 空闲晚到答案触发一次 wake；忙碌时不触发；释放后停止 |
| P3 | echo guard + 工具卡重放 | 下一轮不重复旧答案、不重复旧卡；失配不吞新答案 |
| P4 | 文档（`AGENTS/protocol.md` §6.4 + 代码索引）+ 真机验证 | `session-5207e7af` 同形场景真机复测 |

提交前缀：`feat(acp):`（P2 / P3）、`test(acp):` 可并入、`docs(agents):`（P4）。

## 8. 测试

### 单元（`tests/agy-transcript.spec.ts`，新文件）

`impl.spec.ts` 只覆盖纯 `src/impl.ts`，本模块读文件系统，不进该文件。

- `agyStoreRoot`：POSIX / win32 的 HOME 规则；默认值；`--gemini-dir` / `--gemini_dir` 的 `=` 与空格两种写法；绝对 `--app-data-dir`；缺 HOME；空值。
- `AgyTranscriptTail`：半行等下一次 tick；文件截断重置；坏行跳过；512 KiB 分片；多字节字符不被切开；1 MiB 无换行兜底。
- `lateAnswerText`：单条、多条、`status !== DONE`、空 `content`、只有 `thinking`。
- `applyEchoGuard`：整段命中、分 chunk 命中、失配 flush、旧+新同块只输出新段、严格前缀保持、空 chunk。

### 集成（`tests/bridge.spec.ts` + `tests/mock-agent.mjs`）

新增 mock 标记 `AGY_LATE`。mock 自己在 `session/new` 记住自己的 id，在 prompt 响应后 1 秒往 `<MOCK_AGY_STORE>/brain/<id>/.system_generated/logs/transcript_full.jsonl` 追加一条 `PLANNER_RESPONSE`，不发任何 `session/update`，进程继续存活。测试只注入 store root 与 `isAgent: () => true`。

断言：

- `followup` 收到一条 `source.kind === 'dsh-ntr'`、`form === 'notice'`、`report` 含答案的唤醒；
- `MOCK_PROMPT_LOG` 只有一条（没有第二个 prompt）；
- 下一条 prompt 回放同一段旧文本时，聊天 assistant 文本只出现一次；
- 回放期间用户回合仍在跑 → 不 wake，且下一轮只折一次；
- 带工具卡的回合（`seenCalls.size > 0`，控制器未 dispose）仍能投递（覆盖 B1）；
- wake 被用户插话压过（`backgroundReportOf` 返回 `undefined`）时不写 `lateEcho`，旧答案照常显示；
- 回合在 echo 严格前缀中途结束 → 文本不丢；
- 文件缺失 / 非法 id / 进程释放 → 无 wake、无异常、无 notice 洪水；
- `closeSession` 后 watch 停止（mock 继续追加也不触发）。

测试接缝：`BridgeManager` 构造尾部加一个可选参数 `lateOutput?: { isAgent(def: AcpAgentDef): boolean; storeRoot(): string | undefined }`。生产不传，走 §5.1 默认规则。不要用 `process.env.HOME` 全局改写。

### 真机（手工）

两个 prompt 复刻探针：第一条让 agy `schedule` 8 秒；不发第二条，等聊天框自动出现后台答案；再发一条，确认旧答案不重复。

## 9. 文档

- `AGENTS/protocol.md`：新增 §6.4「Antigravity transcript 补发」，并加「代码索引」表一行。写清：只读、只投递、不收口、不杀进程、不回写 prompt、失败即静默、NTR 视图仍会重复一次。该文件已 223 行、超过单篇 200 行阈值，§6.4 要写成压缩式段落而不是纯追加，并在收尾报告里说明阈值触发。
- `AGENTS/state.md`：**不改**。其维护触发是 `agents.json` 结构，transcript 属外部只读文件，不是它的落点。
- `AGENTS.md`：**不净增**。该文件正好 150 行（硬上限），本条不新增约束编号。
- `docs/todo.md`：本文件落地后删除对应条目。
- `CHANGELOG.md`：按约束 35，发版时统一写，不在实现提交里改。

## 10. 风险与回退

| 风险 | 处理 |
|---|---|
| agy 改 transcript 格式 | 解析失败即静默；watch 到 deadline 自动停；不抛异常 |
| 唤醒成功但 flush 被误吞 | 只有完全命中且前缀连续才吞；任何失配立即 fail-open；投递失败清 `pendingLateEcho` |
| 投递与用户发消息竞态 | 投递前只查 `running` / `promptInFlight`；wake 被 FIFO 跳过时不写 `lateEcho` |
| 本轮答案迟写被当成晚到答案 | 候选文本与本轮已显示正文全等即丢弃 |
| 读取隐私 | 只读；只取 `PLANNER_RESPONSE.content`；不落盘；不进 notice 正文 |
| 多会话定时器开销 | 每会话最多 1s poll，全部 `unref`；deadline 10 分钟；`agyLateOutput: false` 一键关；`agyLateOutputMaxMs: 0` 关整个机制 |
| Windows 路径 | `USERPROFILE`；`isAbsolutePath` 判定；失败返回 null |
| 网络盘 / 权限错误 | `stat` / `read` 异常一律 fail-open |
| 宿主把 `source` 整体剥掉 | 仓库内不可防（与既有后台报告同一条残余下界），wake 会退化成普通用户消息 |

回退：删掉 `closeTurn` 的 arm 调用即可回到今天的行为，其它代码都是惰性的。

## 11. 已裁定问题

1. **默认开还是默认关**：**默认开**，只对自动识别的 agy。前提已满足：`<acpSessionId>` 就是 ACP `session/new` id（§3 实测）。保留 `BridgeTuning.agyLateOutput` 总开关供不信任私有格式的部署一键关；设置页开关后续再加。
2. **是否补发 `SYSTEM_MESSAGE` 报告**：**不做**。子代理报告已有子代理面板与 `subagents/record`，再投一遍要新增一条去重轴，且 `SYSTEM_MESSAGE` 在 transcript 里没有稳定的父回合归属信息。
3. **NTR 转录视图合成条目**：**不做，明确不伪造 `SessionUpdate`**。首版接受「聊天面有、NTR 视图要等下一次 flush 才出现」的差异，并在 §6.4 写明。
4. **`--gemini-dir` 解析基准**：**按 home 解析**（§3 已实测 `agy acp` 的行为），不按 `def.cwd`。
5. **echo guard 是否也拦思考**：**不拦**。用同一套前缀匹配去吞 reasoning，会在「新思考恰好以旧思考开头」时吃掉真实内容。
