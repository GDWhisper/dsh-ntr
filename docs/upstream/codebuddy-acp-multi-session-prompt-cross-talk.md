# CodeBuddy ACP 多会话缺陷：新建会话的首条 prompt 被投进旧会话并以 `end_turn` 零输出返回

> 报告对象：CodeBuddy `2.179.2`（Windows x64，ACP over stdio）
> 复现时间：2026-11-03 23:15:01（Asia/Shanghai，UTC+8；对应 UTC 15:15:01）
> 报告日期：2026-11-04
> 严重程度：高。对同时使用多条 ACP 会话的客户端为阻塞性缺陷。
> 结论：CodeBuddy 把 ACP 连接绑定到单一 `currentSession`。当客户端为另一条会话发送 `session/prompt` 时，prompt 被旧会话的 prompt iterator 接走；同时新建会话会取消旧会话的后台任务。

本文沿用原始证据的称呼：

- **会话 A**：DSH 会话 `session-5cd9fdde-79dc-431b-89b7-69700e9cc95c`，对应 CodeBuddy 会话 `01a1a1fa-5953-7304-9f74-599893aa9a43`。这是新建会话，首条 prompt 零输出。
- **会话 B**：DSH 会话 `session-f6732e5e-3b56-4bad-8286-9cd96467ad25`，对应 CodeBuddy 会话 `01a1a15e-e3fd-756f-aa14-00d7ca74700d`。这是已有会话，后台任务被取消。

---

## 1. 环境

| 项目 | 值 | 来源 |
|---|---|---|
| CodeBuddy 版本 | `2.179.2` | `@tencent-ai/codebuddy-code` 的 `package.json`；CodeBuddy 日志 `extVersion=2.179.2` |
| CodeBuddy 构建 | `d301c6e6d87cc41187685cb8445abbd5a4ede46b` | CodeBuddy 日志 `report` 字段 |
| ACP 传输 | stdio | CodeBuddy 日志 `connectionId: stdio-main` |
| 操作系统 | Windows `10.0.26300`，x64 | CodeBuddy 日志 `osVersion` / `arch` |
| 宿主 | 自研 ACP 客户端 `dsh-ntr 0.3.6`（DeepSeek Harness 插件） | 宿主仓库 `m:\Coding\dsh-ntr`；DSH 请求头 `provider: "acp"` |
| 工作区 | `g:\ComfyUI-aki\ComfyUI-aki-v3.2` | CodeBuddy 日志首行；DSH 会话 `workingDirectory` |
| 时区 | `Asia/Shanghai`（UTC+8） | 本机时区；CodeBuddy 日志为本地时间，DSH 会话日志为 UTC |

说明：

1. CodeBuddy 会话 ID 与 DSH 会话 ID 是两套 ID。两者的映射见“4.1 会话 ID 映射”。
2. CodeBuddy 日志路径为 `C:\Users\vacio\.codebuddy\logs\2026-11-03\ComfyUI-aki-v3.2__131b22df16669c81ab4202ff132be65c.log`。这是 CodeBuddy 默认写入的 Info 级日志。

---

## 2. 最小复现

### 2.1 前置条件

1. 只启动一个 CodeBuddy 进程，使用 `codebuddy --acp` 走 stdio。
2. 所有会话使用同一个工作区。
3. 宿主可以在一条连接上连续创建多条 ACP 会话。这是 ACP `SessionId` 定义支持的正常用法。

### 2.2 最短步骤

1. `initialize`，然后调用 `session/new`，得到**会话 B**（旧会话）的 `sessionId`。
2. 在会话 B 上发送一条会启动后台任务（subagent 或长命令）的 prompt，并让该后台任务保持运行中。
3. 不关闭会话 B，直接调用 `session/new`，得到**会话 A**（新会话）的 `sessionId`。
4. 立即调用 `session/prompt`，`sessionId` 必须精确等于会话 A 的 ID，prompt 内容用最简单的文本（例如“只回复 OK”）。
5. 观察 `session/prompt` 响应和 CodeBuddy 日志。

### 2.3 判定条件

出现以下任意两条，即可判定复现：

1. 日志在同一毫秒内同时出现 `prompt() called for session <A>` 与 `PromptIterator received prompt session=<B>`。两个 `sessionId` 不一致。
2. 日志出现 `skipRun=true`，随后 `prompt() completed with stopReason: end_turn`。从 `.246` 到 `.293` 只有 47 ms。
3. 会话 A 的首条用户消息 ID 出现在会话 B 的 `addHistory` 记录里。
4. 日志出现 `Task <id> ... running -> cancelled`、`Background task cancelled`、`Cleared N tasks for session <B>`。
5. 会话 B 随后调用 `TaskOutput`，返回 `error_code 19931` / `error_detail "Task not found"`。

### 2.4 日志开关

本次复现不需要额外日志开关。CodeBuddy 默认 Info 级日志已经包含全部判定行。只需保证以下 tag 不被过滤：

- `[ACP Agent]`
- `[AcpView]`
- `[AgentService]`
- `[AgentTaskManager]`
- `[SessionRunStateMachine]`

客户端侧不需要开关。`dsh-ntr` 的告警直接写入 DSH 会话事件日志。

---

## 3. 期望行为 vs 实际行为

| # | 期望行为 | 实际行为 | 证据 |
|---|---|---|---|
| 1 | `session/new` 创建会话 A 后，会话 B 仍然独立存在，可以继续运行。 | 新建 A 替换了连接级 `mainSession`，并取消 B 的后台任务。 | `Registered mainSession: id=...01a1a1fa...`；`Task ... running -> cancelled`；`Cleared 1 tasks for session ...01a1a15e...` |
| 2 | `session/prompt` 的 `sessionId=A` 决定执行会话。prompt 必须在 A 上运行。 | prompt 被旧会话 B 的 prompt iterator 接走。 | `prompt() called for session ...01a1a1fa...` 后同一毫秒出现 `PromptIterator received prompt session=...01a1a15e...` |
| 3 | A 的回合应产生 A 的 `session/update`，包括文本或工具事件。 | A 没有任何可见输出；旧会话 B 收到并排队了这条 prompt。 | DSH 会话 A 只有零输出告警；`normal re-admission: busy → forceMessageQueue \| session=...01a1a15e...` |
| 4 | `session/prompt` 应在 A 的回合结束后返回。 | 47 ms 后立即返回正常 `end_turn`，此时 A 没有运行。 | `23:15:01.246` 调用；`23:15:01.293` 返回 `end_turn` |
| 5 | A 的用户消息应进入 A 的历史。 | A 的用户消息 ID 被写入 B 的 `addHistory`。 | `[addHistory] START sessionId=...01a1a15e..., ... id: 01a1a1fa-595b-...` |
| 6 | 新建 A 不应影响 B 的后台任务。 | B 的后台任务被取消，任务表被清空。 | `Task agent-588ce473... running -> cancelled`；`Cleared 1 tasks for session ...01a1a15e...` |
| 7 | B 的 `TaskOutput` 应返回任务输出；如果任务已取消，应返回明确的取消错误。 | `TaskOutput` 返回 `Task not found`，`error_code 19931`。 | `23:15:04.961` 的 `tool.call.completed` 错误记录 |
| 8 | 不同会话可以串行执行，但事件、历史、队列、响应必须归属请求的 `sessionId`。 | 队列和执行上下文使用迭代器绑定的旧会话，日志却打印请求的新会话 ID。 | `Dispatching queued prompt for session ...01a1a1fa...` 后实际 `session=...01a1a15e...` |

补充：

1. ACP 没有强制 agent 并发执行。串行执行合法。
2. 本缺陷不是“没有并发”，而是“把 prompt 投给了非请求指定的会话”。
3. 客户端发送的 `session/prompt` 字段完整，`sessionId` 精确等于 `session/new` 返回的 A ID。客户端行为符合 ACP 规范。

---

## 4. 证据

### 4.1 会话 ID 映射

| 报告称呼 | DSH 会话 ID | CodeBuddy 会话 ID | 角色 |
|---|---|---|---|
| 会话 A | `session-5cd9fdde-79dc-431b-89b7-69700e9cc95c` | `01a1a1fa-5953-7304-9f74-599893aa9a43` | 新建，首条 prompt 零输出 |
| 会话 B | `session-f6732e5e-3b56-4bad-8286-9cd96467ad25` | `01a1a15e-e3fd-756f-aa14-00d7ca74700d` | 已有，后台任务 `agent-588ce473-9fc1-496e-b923-f9a712c06326` 被取消 |
| 子 agent 会话 | 无 | `01a1a1f9-b06e-735c-8fd0-c7e87436cc8f` | 后台任务内部的 general-purpose 会话，随任务取消 |

### 4.2 DSH 侧记录：会话 A

来源：`C:\Users\vacio\.dsh\storages\session_projcache\sessions\session-5cd9fdde-79dc-431b-89b7-69700e9cc95c.json` 与同会话的 `session.v4.jsonl.zstd`。

| 事件 | UTC 时间 | 内容 |
|---|---|---|
| `turn/start` | `2026-11-03T15:15:01.023Z` | 回合 1 开始 |
| `request/header` | `2026-11-03T15:15:01.057Z` | `provider: "acp"`，`model: "codebuddy@hy3"`，`reasoningEffort: "max"` |
| `assistant/message` | `2026-11-03T15:15:01.296Z` | 只有插件告警，没有 agent 正文 |
| `turn/end` | `2026-11-03T15:15:01.802Z` | `reason.kind = "completed"`；从 `turn/start` 到 `turn/end` 共 779 ms |

`assistant/message` 的完整文本：

```text
[dsh-ntr] agent "codebuddy" ended the turn with no visible output (stop reason: end_turn). Some agents fold upstream failures — auth, billing, rate limits — into a normal stop; try resending, and check the agent process logs if it repeats.
```

用户 prompt 为“看得到这张图吗”。回合在 `.296Z` 收到空结果，但 `turn/end` 直到 `.802Z` 才发出，说明宿主没有收到任何可见的 agent 输出。

### 4.3 DSH 侧记录：会话 B

来源：`C:\Users\vacio\.dsh\storages\session_projcache\sessions\session-f6732e5e-3b56-4bad-8286-9cd96467ad25.json` 与同会话的 `session.v4.jsonl.zstd`。

| 事件 | UTC 时间 | 内容 |
|---|---|---|
| `turn/start` | `2026-11-03T15:13:55.015Z` | 回合 3 开始 |
| `request/header` | `2026-11-03T15:13:55.025Z` | `provider: "acp"`，`model: "codebuddy@deepseek-v4.1-flash"`，`reasoningEffort: "max"` |
| `assistant/message` | `2026-11-03T15:15:23.851Z` | 正文，后接插件“deferred”告警 |
| `turn/end` | `2026-11-03T15:15:24.360Z` | `reason.kind = "completed"` |

`assistant/message` 的完整文本：

```text
收到，按这条规则筛。同时会把 46 个镜头各写一句话描述，这样剩下没字幕也没主角的镜头也能一起分出来。
[dsh-ntr] agent "codebuddy" deferred this turn to a background task run; its output is in the ACP transcript view. Send again after the background run finishes.
```

会话 B 的回合 3 从 `15:13:55.015Z` 开始，后台任务在本地 `23:15:01.086`（UTC `15:15:01.086`）被取消。回合在 `15:15:23.851Z` 以“deferred”结束，说明该回合被后台任务拖住；该任务已在本地 `23:15:01.087` 被清空。

### 4.4 CodeBuddy 日志关键序列

来源：`C:\Users\vacio\.codebuddy\logs\2026-11-03\ComfyUI-aki-v3.2__131b22df16669c81ab4202ff132be65c.log`。下表时间均为 `Asia/Shanghai`，与 UTC 相差 8 小时。

| # | 本地时间 | 关键行原文（节选） | 说明 |
|---|---|---|---|
| 1 | `23:15:01.086` | `[AgentTaskManager] Task agent-588ce473-9fc1-496e-b923-f9a712c06326 (unnamed) status changed: running -> cancelled` | 新建会话开始时，旧会话 B 的后台任务被取消 |
| 2 | `23:15:01.086` | `[waitFor] Registered mainSession: id=01a1a1fa-5953-7304-9f74-599893aa9a43, meta={"cwd":"g:\\ComfyUI-aki\\ComfyUI-aki-v3.2"}` | 新会话 A 成为连接级 `mainSession` |
| 3 | `23:15:01.087` | `[AgentTaskManager] Background task cancelled: agent-588ce473-9fc1-496e-b923-f9a712c06326` | 后台任务取消落定 |
| 4 | `23:15:01.087` | `[AgentTaskManager] Cleared 1 tasks for session 01a1a15e-e3fd-756f-aa14-00d7ca74700d` | 清空旧会话 B 的任务表 |
| 5 | `23:15:01.136` | `[SessionRunStateMachine] transition \| sessionId=01a1a15e-e3fd-756f-aa14-00d7ca74700d \| event=RUN_ACCEPTED \| from=preparing \| to=pending` | 旧会话 B 进入 pending |
| 6 | `23:15:01.138` | `[addHistory] START sessionId=01a1a15e-e3fd-756f-aa14-00d7ca74700d, storeId=undefined, types=[message], input=[{type: message, id: 01a1a1fa-595b-7df3-81c7-2d2a7bb36c50}]` | **新会话 A 的用户消息 ID 被写入旧会话 B 的历史** |
| 7 | `23:15:01.143` | `[AcpView] Processing session request: type=new, sessionId=01a1a1fa-5953-7304-9f74-599893aa9a43` | 处理 `session/new`，目标是新会话 A |
| 8 | `23:15:01.143` | `[ACP Agent] setSession called for session 01a1a1fa-5953-7304-9f74-599893aa9a43` | 连接绑定被改为新会话 A |
| 9 | `23:15:01.143` | `[AcpView] Render loop already active for connection stdio-main, skipping duplicate` | **没有为新会话建立独立 render loop / iterator** |
| 10 | `23:15:01.246` | `[ACP Agent] prompt() called for session 01a1a1fa-5953-7304-9f74-599893aa9a43` | 请求指定的会话是新会话 A |
| 11 | `23:15:01.246` | `[AcpView][PromptIterator] received prompt session=01a1a15e-e3fd-756f-aa14-00d7ca74700d route=dispatchQueued runState=pending queueLen=0 hasWaiter=false` | **同一毫秒，iterator 收到的是旧会话 B** |
| 12 | `23:15:01.246` | `[AcpView] Dispatching queued prompt for session 01a1a1fa-5953-7304-9f74-599893aa9a43 (agent in conversation)` | 日志打印请求 ID，但实际上下文仍是旧会话 B |
| 13 | `23:15:01.250` | `[AgentService] normal re-admission: busy → forceMessageQueue \| session=01a1a15e-e3fd-756f-aa14-00d7ca74700d status=pending` | prompt 被排队到旧会话 B |
| 14 | `23:15:01.293` | `[AgentService] skipRun=true for agent=cli, runState=pending, queueLen=1, isCompressing=undefined` | 跳过本轮执行 |
| 15 | `23:15:01.293` | `[ACP Agent] prompt() completed with stopReason: end_turn` | 47 ms 内返回正常 `end_turn` |
| 16 | `23:15:04.961` | `{"tool_kind":"local","tool_name":"TaskOutput","error_detail":"Task not found",...,"conversation_id":"01a1a15e-e3fd-756f-aa14-00d7ca74700d",...,"error_code":"19931",...}` | 旧会话 B 的 `TaskOutput` 找不到已被取消的任务 |

### 4.5 核心证据：同一毫秒的 `sessionId` 不一致

```text
23:15:01.246  [ACP Agent] prompt() called for session 01a1a1fa-5953-7304-9f74-599893aa9a43
23:15:01.246  [AcpView][PromptIterator] received prompt session=01a1a15e-e3fd-756f-aa14-00d7ca74700d route=dispatchQueued
```

1. 第一条是客户端请求的目标会话，即新会话 A。
2. 第二条是实际接收 prompt 的迭代器会话，即旧会话 B。
3. 两者在同一毫秒出现，证明 prompt 没有进入请求指定的会话。
4. 第 6 行进一步证明新会话 A 的用户消息 ID 被写入旧会话 B 的历史。
5. 第 9 行证明 `session/new` 只改了连接级 `currentSession`，没有为 A 建立独立 iterator / queue。

### 4.6 代码证据

以下符号来自 CodeBuddy `2.179.2` 的 ACP 实现。变量名按语义整理，不是逐字源码。

#### 4.6.1 连接级单会话绑定

`dist-server/types/node/acp/acp-protocol.d.ts` 的注释原文：

```ts
/**
 * Get the current bound session id for this connection.
 * Returns undefined before setSession() binds the connection to a session.
 */
getCurrentSessionId(): string | undefined;

/**
 * Get the live Session instance currently bound to this connection.
 * Unlike SessionManager.get(), this never reloads a second instance from persistence.
 */
getCurrentSession(): Session | undefined;

/**
 * Set the session instance
 * Called by AcpView after session is created/loaded via /agent endpoint
 * This resolves the sessionDeferred that newSession/loadSession is waiting on
 * @param session - The session instance
 */
setSession(session: Session): void;
```

结论：

1. 一条 ACP 连接只保存一个 `currentSession`。
2. `session/new` 与 `session/load` 会调用 `setSession`；`AcpAgent.prompt` 在发现 `currentSession` 不是请求会话时也会调用。三次调用改的是同一个连接级字段。
3. 旧会话的 prompt iterator 不会被新会话替换。

#### 4.6.2 prompt 入口：按 `sessionId` 取会话，但随后改连接绑定

等价片段：

```ts
// AcpAgent.prompt(request)
const session = await this.getRuntimeSession(request.sessionId); // 这一层按 id 取会话，正确
if (this.currentSession !== session) this.setSession(session);   // 把连接绑到本次请求的会话
```

问题不在入口查表，而在后续执行路径继续使用连接级绑定，而不是把 `session` 作为参数贯穿管线。

#### 4.6.3 prompt iterator：闭包绑定旧会话

等价片段：

```ts
// AcpView.createPromptIterator(agent, initialSession)
const activeSession = () => agent.getCurrentSession() ?? initialSession;

// prompt handler
log(`PromptIterator received prompt session=${initialSession.id} ...`);
dispatchQueuedPrompt(request, initialSession, acpView);
```

要点：

1. `initialSession` 是迭代器创建时绑定的旧会话。
2. handler 的日志和实际分发都使用 `initialSession`，不是 `request.sessionId`。
3. 因此日志出现“`prompt() called for B`，iterator 收到 A”。

#### 4.6.4 队列分发：日志打印请求 ID，执行使用旧会话

等价片段：

```ts
// AcpView.dispatchQueuedPrompt(request, session, acpView)
log(`Dispatching queued prompt for session ${request.sessionId} ...`); // 只打印请求 id
await prepareSensitiveUserPrompt(request, session, ...);              // 实际用旧会话
runDefault(..., { context: session });                                // 执行上下文仍是旧会话
```

要点：

1. 日志具有误导性：打印的是 `request.sessionId`，执行的是传入的 `session`。
2. 只要 handler 传入旧会话，后续所有模型调用、历史写入、事件归属都会落到旧会话。

#### 4.6.5 主循环：发现 `currentSession` 变化就停旧 Bridge

等价片段：

```ts
// AcpView 主循环
const next = agent.getCurrentSession();
if (next && next.id !== iteratorSession.id) {
  log(`Session switched from ${iteratorSession.id} to ${next.id}`);
  teamBridge.stop(iteratorSession);
  iteratorSession = next;
}
```

说明：

1. 本次事故日志中没有出现 `Session switched from`。prompt 在切换判定之前已经被旧 iterator 接走。
2. 该分支仍是潜在风险：它把“连接级 `currentSession` 变化”当成显式会话切换，会停掉旧会话的 Bridge。
3. 修复时应只在客户端显式 `session/load`、`session/close` 或明确切换请求时停旧 Bridge，不要因为新建另一个会话而停。

#### 4.6.6 新建会话取消旧会话后台任务

日志证据：

```text
23:15:01.086  Task agent-588ce473-9fc1-496e-b923-f9a712c06326 (unnamed) status changed: running -> cancelled
23:15:01.087  Background task cancelled: agent-588ce473-9fc1-496e-b923-f9a712c06326
23:15:01.087  Cleared 1 tasks for session 01a1a15e-e3fd-756f-aa14-00d7ca74700d
```

结论：

1. `session/new` 的新会话注册路径替换了 `mainSession`，并清掉了旧 `mainSession` 的任务。
2. ACP 的 `session/new` 不是 `session/close`，不应影响其他会话的任务。
3. 如果 CodeBuddy 需要一个“main session”承载定时任务或后台任务，应把它做成按 `sessionId` 分表的注册表，而不是进程级单例。

### 4.7 ACP 规范依据

来源：`@agentclientprotocol/sdk` 的 `schema.json` 与 `types.gen.d.ts`。

1. `PromptRequest.sessionId` 注释：

```text
The ID of the session to send this user message to
```

2. `PromptRequest` 在 schema 中是对象，`sessionId` 与 `prompt` 是必填字段：

```json
"required": ["sessionId", "prompt"]
```

3. `NewSessionResponse.sessionId` 注释：

```text
Unique identifier for the created session.

Used in all subsequent requests for this conversation.
```

4. `SessionId` 类型注释：

```text
A unique identifier for a conversation session between a client and agent.

Sessions maintain their own context, conversation history, and state,
allowing multiple independent interactions with the same agent.
```

结论：

1. `session/prompt` 的 `sessionId` 不是提示信息，而是执行目标。
2. `session/new` 返回的 ID 要用于该会话的所有后续请求。
3. ACP 允许串行执行，不允许把 prompt 投给非请求指定的会话。
4. 本缺陷违反“会话各自维护上下文、历史与状态”的语义。

### 4.8 对照实现：按 `sessionId` 路由是通行做法

| 实现 | 会话存储与路由 | 结果 |
|---|---|---|
| opencode `2.2.5` | `acp/sessions.ts` 使用 `Map<string, Entry>`；`require(sessionID)` 查表，缺失即报错；`acp/turn.ts` 的 `prompt` 首行执行 `sessions.require(params.sessionId)`；并发闸门只针对同一 `sessionId`；`translate.ts` 按 `sessionID` 过滤事件 | 本机实测两次 `session/new` 各自返回不同 ID 且并存；伪造 ID 的 `session/prompt` 返回 `-32602 session not found` |
| `claude-code-acp` | `startTurn` 读取 `this.sessions[params.sessionId]`；缺失抛 `RequestError.sessionNotFound` | 不存在连接级单会话绑定 |
| `gemini-cli` | `AcpSessionManager` 持有 `Map<string, Session>`；`AcpRpcDispatcher.prompt` 调 `getSession(params.sessionId)` | 按请求 ID 取会话 |
| ACP SDK 官方示例 | `dist/examples/agent.js` 使用 `this.sessions = new Map()`，按 `params.sessionId` 取值 | 同一 agent 支持多条独立会话 |

版本说明：

1. `opencode 2.2.5` 的版本号在本机安装目录 `D:\nvm4w\nodejs\node_modules\@opencode\cli\package.json` 确认。
2. 其余对照实现为公开源码核对；本报告未在本机重新运行它们。
3. 对照结果说明：按 `sessionId` 路由是多会话 ACP agent 的通行做法，本缺陷不是 ACP 协议限制。

---

## 5. 影响

1. **多会话客户端阻塞**：任何在一条 ACP 连接上使用两条以上会话的客户端都会遇到。新建会话后首条 prompt 可能直接零输出。
2. **静默错误**：客户端收到正常的 `end_turn`，没有任何错误码。宿主只能显示“zero visible output”告警，无法区分“agent 没说话”与“prompt 发错了会话”。
3. **跨会话历史污染**：新会话的用户消息被写入旧会话历史。后续模型调用会看到不属于该会话的内容，可能造成上下文串线或数据泄露。
4. **后台任务丢失**：新建会话会取消旧会话的后台任务，正在进行的 subagent / 长命令被中断，工作成果丢失。
5. **后续工具失败**：旧会话继续调用 `TaskOutput` 时得到 `Task not found`（`error_code 19931`），把根因掩盖成工具错误。
6. **单会话回归不易发现**：只用一个会话的测试不会触发。必须使用“两条会话 + 一条有后台任务”的组合才能复现。
7. **同类路径风险**：`session/load`、`unstable_resumeSession` 与 prompt 入口共用 `setSession`。同一根因可能影响恢复和加载路径。本次日志只复现了 `session/new`，其余路径为代码推断。

---

## 6. 建议修法（函数层）

### 6.1 必须修（P0）

| 函数 / 位置 | 现状 | 建议 |
|---|---|---|
| `AcpAgent.setSession` / `getCurrentSession` / `getCurrentSessionId` | 一条连接只有单字段 `currentSession` | 改为 `Map<SessionId, Session>`。`currentSession` 只保留为 UI 焦点或默认值，不参与执行路由。`getCurrentSessionId` 不能作为唯一执行依据。 |
| `AcpAgent.prompt` | 入口按 `request.sessionId` 取 runtime session，但随后 `setSession` 改连接绑定 | 把取到的 `Session` 作为参数传给 `AcpView`。不要用连接级字段决定执行会话。 |
| `AcpView.createPromptIterator` | 每个连接一个 iterator，闭包捕获 `initialSession` | 每个 `sessionId` 一个 iterator / 队列；或在 handler 内执行 `agent.getRuntimeSession(request.sessionId)`，缺失时返回 `-32602 session not found`。 |
| `AcpView.dispatchQueuedPrompt` | 日志打印 `request.sessionId`，实际传入 iterator 的旧 `session` | 入口按 `request.sessionId` 解析会话；断言 `session.id === request.sessionId`；后续所有参数使用该会话。不要使用闭包里的 `el`。 |
| `runDefault` 调用点 | 使用 `context: session`，其中 `session` 是旧 iterator 会话 | 改为 `context: requestedSession`。所有模型调用、历史写入、事件过滤、`session/update` 归属都必须使用请求会话。 |
| `AcpView` 主循环 | 发现 `getCurrentSession()` 变化就 `teamBridge.stop(old)` | 只在显式 `session/load`、`session/close` 或客户端明确切换时停旧 Bridge。或者把 Bridge 按 `sessionId` 分表，允许多条会话并存。 |
| `session/new` 处理链（`SessionMiddleware` / `newSession`） | 注册新 `mainSession` 时取消旧会话任务 | 只为被关闭或替换的会话清理任务。新建另一个会话不得取消旧会话的后台任务。`mainSession` 从进程级单例改为按 `sessionId` 的注册表。 |
| 队列与 `SessionRunStateMachine` | `forceMessageQueue` / `skipRun` 基于旧会话状态 | 队列、run state、busy 标记按 `sessionId` 分区。`skipRun` 不得把未进入请求会话的 prompt 以正常 `end_turn` 返回。 |

### 6.2 队列与 `skipRun` 的语义

1. 如果 CodeBuddy 选择串行执行，应把 prompt 排入**请求会话**的队列，等该会话的回合结束后再返回 `PromptResponse`。
2. 如果确实无法接收（例如已达到并发上限），应返回 ACP 错误，而不是正常 `end_turn`。
3. `end_turn` 的语义是“该会话的回合正常结束”。本次 prompt 根本没有在该会话执行，不能返回 `end_turn`。
4. 建议在 `dispatchQueuedPrompt` 入口加硬断言：

```ts
if (session.id !== request.sessionId) {
  throw new RequestError(-32602, `session not found: ${request.sessionId}`, {
    message: `prompt routed to ${session.id}, expected ${request.sessionId}`,
  });
}
```

### 6.3 日志不变量

当前日志有两套 ID：

1. `prompt() called for session <requested>`
2. `PromptIterator received prompt session=<binding>`

建议把两者并排打印，并在不相等时输出 Warning：

```text
[ACP Agent] prompt route check: requested=<B> binding=<A> match=false
```

这样上游可以在不读代码的情况下定位同类问题。

### 6.4 回归测试建议

1. 两条会话 A / B，B 有运行中的后台任务，A 发送首条 prompt。断言 A 产生至少一条 `session/update`，响应不是立即 `end_turn`。
2. 两条会话 A / B 同时发送 prompt。断言串行执行可以接受，但事件、历史、响应全部归属正确的 `sessionId`。
3. 新建 A 时 B 有后台任务。断言 B 的任务状态仍为 `running`，随后可以正常完成。
4. 新建 C 时 A / B 都有活动回合。断言 C 的创建不影响 A / B。
5. 伪造不存在的 `sessionId` 发送 `session/prompt`。断言返回 `-32602 session not found`，不得回落到 `currentSession`。
6. 单会话回归。断言原有后台任务 drain、`TaskOutput`、取消与恢复行为不变。

---

## 7. 如何自证修好

### 7.1 复现用例验收

- [ ] 会话 B 有运行中的后台任务时，新建会话 A 并发送首条 prompt。
- [ ] A 的 `session/prompt` 响应不是 47 ms 内的立即 `end_turn`。
- [ ] A 至少收到一条包含正文或工具的 `session/update`。
- [ ] A 的历史包含 A 的用户消息。
- [ ] B 的历史不包含 A 的用户消息 ID。
- [ ] B 的后台任务没有被 `running -> cancelled`。
- [ ] B 的 `TaskOutput` 能返回结果；如果任务已结束，返回明确的取消错误，不是 `Task not found`。

### 7.2 日志验收

- [ ] `prompt() called for session <A>` 后，下一行是 `PromptIterator received prompt session=<A>`。
- [ ] 不再出现同一毫秒内 `<A>` 与 `<B>` 交替。
- [ ] `addHistory` 的 `sessionId` 与消息来源会话一致。
- [ ] `Cleared N tasks for session <X>` 只在关闭或替换 `<X>` 时出现。
- [ ] 新增的 route check 日志中 `match=true`。

### 7.3 并发与会话隔离验收

- [ ] 两条会话同时发 prompt：两条都能完成，输出归属正确。
- [ ] 新建第三条会话：前两条的后台任务与回合不受影响。
- [ ] 不存在的 `sessionId` 返回 `-32602 session not found`。
- [ ] `session/load` / `unstable_resumeSession` 与其他活动会话并存时，不取消其他会话的任务。
- [ ] 单会话原有功能回归通过：后台任务 drain、取消、恢复、`TaskOutput` 均正常。

### 7.4 客户端侧验收

- [ ] `dsh-ntr` 不再收到 `ended the turn with no visible output (stop reason: end_turn)`。
- [ ] 会话 B 的后台任务正常完成，不再收到 `deferred this turn to a background task run`。
- [ ] ACP 视图能看到 A 的正文和工具卡片。
- [ ] 会话切换时不再出现旧会话 Bridge 被无条件停止。

---

## 8. 可直接粘贴到反馈表单的纯文本简版

```text
CodeBuddy 2.179.2（Windows，ACP stdio）多会话缺陷。B 的后台任务未结束时新建 A，再发 sessionId=A 的首条 prompt：23:15:01.246 显示 prompt() called for session A，随后 PromptIterator received prompt session=B；23:15:01.293 以 skipRun=true 返回 end_turn，A 零输出。新建 A 取消 B 后台任务，B 随后 TaskOutput 报 19931。期望：A 正常产出，B 不受影响。实际：A 的用户消息被写入 B 的 addHistory。请让 createPromptIterator、dispatchQueuedPrompt 按 request.sessionId 取会话；session/new 不要取消其他会话的后台任务。
```

---

## 附录：证据来源

| 证据 | 文件 / 对象 | 用途 |
|---|---|---|
| CodeBuddy 版本与系统 | `D:\nvm\v24.18.0\node_modules\@tencent-ai\codebuddy-code\package.json`；CodeBuddy 日志 `report` 字段 | 确认 `2.179.2`、commit、Windows x64 |
| CodeBuddy 关键日志 | `C:\Users\vacio\.codebuddy\logs\2026-11-03\ComfyUI-aki-v3.2__131b22df16669c81ab4202ff132be65c.log` | 会话创建、prompt 路由、任务取消、`TaskOutput` 错误 |
| DSH 会话 A 投影 | `C:\Users\vacio\.dsh\storages\session_projcache\sessions\session-5cd9fdde-79dc-431b-89b7-69700e9cc95c.json` | 零输出告警、请求头、时间戳 |
| DSH 会话 A 事件 | 同目录 `session.v4.jsonl.zstd` | `turn/start`、`assistant/message`、`turn/end`、779 ms |
| DSH 会话 B 投影 | `C:\Users\vacio\.dsh\storages\session_projcache\sessions\session-f6732e5e-3b56-4bad-8286-9cd96467ad25.json` | deferred 告警、请求头、时间戳 |
| DSH 会话 B 事件 | 同目录 `session.v4.jsonl.zstd` | `turn/start`、`assistant/message`、`turn/end` |
| ACP 规范 | `m:\Coding\dsh-ntr\node_modules\@agentclientprotocol\sdk\schema\schema.json`；`dist/schema/types.gen.d.ts` | `PromptRequest.sessionId`、`NewSessionResponse.sessionId`、`SessionId` 注释与必填字段 |
| CodeBuddy ACP 类型 | `D:\nvm\v24.18.0\node_modules\@tencent-ai\codebuddy-code\dist-server\types\node\acp\acp-protocol.d.ts` | `setSession` / `getCurrentSession` / `getCurrentSessionId` 的连接级绑定注释 |
| opencode 版本 | `D:\nvm4w\nodejs\node_modules\@opencode\cli\package.json` | 确认对照实现 `2.2.5` |

报告中未包含任何 issue 链接、工单号或上游承诺。所有时间戳均来自上述日志与 DSH 会话事件，未做推测性改写。
