# CodeBuddy 单进程 + 多条 HTTP ACP 连接（A2）：暂缓方案

**日期**：2026-11-04　**状态**：未决策（当前不启动；触发条件见 §5）。**适用范围**：`src/bridge/agent-bridge.ts` 的 `AgentBridge` 与 `src/bridge/manager.ts` 的 `BridgeManager` 进程与连接拓扑；不涉及浏览器半区。

**一句话**：不按「每会话一进程」（A1）扩展，而是让一个 CodeBuddy 进程用 streamable-http 承载 N 条 ACP 连接、每条连接一个会话。它省掉每会话约 300 MB 的进程内存，代价是把 stdio 传输层换成 HTTP 传输层、连接池、token 与端口生命周期，并且隔离仍依赖 CodeBuddy 的连接级语义。

> 本文只记设计与证据，**没有任何一行代码按此改动过**。现行代码与 [AGENTS.md](../../../AGENTS.md) 才是权威；冲突时以它们为准，本文只指出该改哪一处。

## 1. 方案摘要与取舍

**三条路线**：

- **A1（每会话一进程）**：每个 ACP 会话起一个 CodeBuddy 进程，各用一条 stdio 连接。stdio 下这是唯一能做到会话并发的拓扑。
- **A2（本文主题）**：起一个 CodeBuddy 进程，`codebuddy --serve --acp --acp-transport streamable-http --port <port>`；以 N 条 HTTP ACP 连接承载 N 个会话。
- **B（上游修复）**：修掉 CodeBuddy 进程级的会话指针 / 路由缺陷，让一个进程或一条连接能正确承载多个并发会话。见 §7。本文的 B 与 [orphan-agent-reaping.md](./orphan-agent-reaping.md) 里的「方案 B：supervisor 包装」无关。

| 维度 | A1：每会话一进程 | A2：单进程 + N 条 HTTP 连接 |
|---|---|---|
| 进程数 | N 个会话 → N 个进程 | 1 个进程 |
| 内存 | 每会话约 300 MB | 一份进程基线 + N 条连接的状态开销（实际值待实测） |
| 传输 | stdio（现有 `ndJsonStream`） | HTTP + SSE（SDK 的 `createHttpStream`） |
| 并发单位 | 进程 | 连接；同一连接仍不能并发两个会话 |
| 故障域 | 单会话 | 进程死亡影响该进程上的全部会话 |
| 改动面 | 进程拓扑与回收 | 传输层、连接池、token、端口、生命周期 |
| 隔离依据 | 操作系统进程边界 | CodeBuddy 的连接级语义（不归本仓控制） |

**取舍**：A2 用「传输层复杂度 + 隔离强度下降」换进程内存。唯一明确收益是内存；并发上限从「机器能起多少进程」变成「连接上限 + 端口 + token 生命周期」。每个 `AcpAgent` 仍只有一个 `currentSession`，所以 A2 并不会把 N 个会话塞进一条连接——它仍需 N 条连接，只是共享一个进程。

## 2. 已核实的事实

| # | 事实 | 对 A2 的含义 |
|---|---|---|
| 1 | 启动形态是 `codebuddy --serve --acp --acp-transport streamable-http --port <port>` | 与新传输层绑定，现有「一整条命令行」的 `AcpAgentDef.command` 语义（约束 26）仍需保留 |
| 2 | 连接上限优先读环境变量 `CODEBUDDY_ACP_MAX_CONNECTIONS`，其次读 `settings.json` 的 `gateway.maxConnections`；代码常量默认 32，`.d.ts` 注释写默认 5 | 两处默认值不一致，需上游澄清；池大小不能写死 |
| 3 | 超限时 `issueToken(connectionId)` 返回 `undefined`，HTTP 回 503，文案 `Connection limit reached (max <N>)` | 连接池要有明确的「满员」错误，不能静默排队或换 agent |
| 4 | 每条连接一个 token，请求头 `acp-session-token`；端点是 `POST /acp/connect` 与 `GET /acp`（SSE） | token 与连接绑定；事件流走 SSE，断线检测与重连都要另做 |
| 5 | token 有效期 `gateway.tokenTtlMs` 默认 86400000，最小 60000 | 长时间存活的连接会中途过期；续期方式未知，见 §4 V5 |
| 6 | `AcpAgentManager.register(connectionId, agent)` 是一连接一个 `AcpAgent`；每个 `AcpAgent` 仍只有一个 `currentSession` | N 条连接 = N 个并发会话，但同一连接不能并发两个会话 |
| 7 | `SessionManager` 有一个进程级 `sessionSubject` 当前指针，`getRuntimeSession()` 先看它、再回退到会话表；同一会话多客户端有 `claimSessionTakeover` 与 `writer_occupied` 的独占 writer 语义 | 跨连接的会话可能被进程级指针串线；同一会话的 writer 只能有一个。这两条是 A2 的硬风险 |
| 8 | ACP stdio 模式下每个进程只有一条连接 | 要并发只能每会话一进程，所以 A1 是 stdio 下唯一可行的并发拓扑 |

**本仓基线**：`src/bridge.ts`（桶文件）头注释写明「一个 agent 定义一个子进程、在 stdio 连接上复用任意多个 ACP 会话」；`src/bridge/agent-bridge.ts` · `AgentBridge.spawnAndConnect` 用 `ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout))` 建唯一连接，`src/bridge/manager.ts` · `BridgeManager` 持有 bridge 表。A2 要改的正是这条唯一连接假设。

### 2.1 与本仓现有约束直接冲突的两点

1. **工作区在进程启动时定死**：`AgentBridge.ensureReady(spawnCwd)` 会为了换工作区重启进程；`AGENTS/architecture.md` 记录 codebuddy 在进程启动那一刻就把 workspace 定死，`session/new` 的 cwd 对它太晚。一个共享进程无法同时服务不同工作区的会话，除非实测证明 `session/new` 的 cwd 真的逐会话生效。
2. **MCP 列表是进程级作用域**：约束 32 要求四个建会话点传同一份 `mcpServers`，因为 agent 把它放进进程级作用域，一份空列表会顶掉活动会话的 MCP 工具。A2 的多个连接同处一个进程，这条作用域是否跨连接共享，必须实测（见 §4 V6）。

## 3. 前置条件

### 3.1 传输层：stdio 客户端改为 HTTP 客户端

- `src/bridge/agent-bridge.ts` · `AgentBridge.spawnAndConnect` 现在把进程与连接绑死。A2 需要把「进程所有者」与「一条 ACP 连接」拆成两层：进程层负责 spawn、端口、健康与 stderr；连接层负责一条 token、一条 `Stream`、一次 `initialize`。
- 传输实现用 SDK 已导出的 `@agentclientprotocol/sdk/experimental/http-client` 的 `createHttpStream`（`HttpStreamOptions` 支持 `fetch` / `headers` / `cookies` / `cookieStore`，并带 `MemoryAcpCookieStore`）。`client(...).connect(stream)` 与现有 `handleSessionUpdate` / 权限 / fs 处理器可以保留，改动集中在连接建立处。
- 每条连接的 token 进 `acp-session-token` 请求头；`POST /acp/connect` 取 token，`GET /acp` 接 SSE。
- **每个 `LiveSession` 需要自己的 `ClientConnection`**。现在 `AgentBridge` 只持有一个 `conn`，`runPrompt` / `cancel` / `setMode` / `setConfigOption` / `resumeSession` 都直接用它；要么给 `LiveSession` 加连接租约，要么改成「一个连接一个 bridge」。这是本方案最大的结构性改动。
- **连接池**：按上限（环境变量 > `settings.json` > 待澄清的默认值）分配；满员返回明确错误（对应 503 与 `Connection limit reached`），不自动降级到 A1，也不自动换 agent。
- **初始化与能力位**：每条连接都要 `initialize`；`loadSession` / `fork` 等能力位按连接缓存，不能假设同进程内一致。
- **超时**：连接、`initialize`、`session/load` 复用 `withStartupTimeout`；另加 HTTP 请求超时与 SSE 静默检测。
- **重连**：ACP v1 不重放断线期间的消息。重连要新建 stream、重新 `initialize`、确认 `loadSession`、再 `session/load`；聊天面按约束 10 **先**重置 transcript 并广播 `session/reset`，**再**发 `session/load`。

### 3.2 端口与进程生命周期

- **端口分配**：优先接受显式 `--port`；未指定时用 `node:net` 监听 `0` 取空闲端口再关闭，然后 spawn；监听与 spawn 之间有竞态，绑定失败要重试并留日志，不能静默换端口。
- **进程所有者**：负责 spawn / 健康检查 / stdout 与 stderr 尾部 / `killProcessTree` 回收。Windows 上 `.cmd` 生成壳仍必须经 `windowsShimLaunch`（约束 26），不能直接 spawn。
- **空闲释放**：现有 `releaseIfIdle` / `armIdleRelease` 是 per-bridge 的；A2 要改成进程级引用计数：先释放空闲连接，全部连接空闲后才杀进程。约束 19 的「只释放没有活跃工作的进程」语义要原样保住。
- **崩溃语义**：连接断开 ≠ 进程死亡；进程死亡必须对该进程下**全部**连接走 `releaseAll`，会话记录标 released，不能广播 `session/closed`（约束 10）。约束 11 的身份校验从 `this.child === child` 扩展到连接租约身份。
- **停机预算**：`BridgeManager.shutdownAll` 现在按 bridge 并发、每条有 4 s 预算；共享进程后要收成一条全局预算，不能变成 N × 4 s。顺序是先关连接、再杀进程。
- **安全面**：只监听回环地址；token 不进日志、不进 `agent/notice`、不进错误正文。
- **配置形状**：`AcpAgentDef` 增传输类型（`stdio` / `streamable-http`）、端口策略、连接上限等字段；按「扩展配置字段」配方同步 `validateAgentDef`、`AgentSavePayload`、panel 的 `initialForm` / `buildPayload` / `payloadEquals` 与 `cordis.patch.yml`。`command` 仍是一整条命令行。

### 3.3 需要重建的既有语义

- `BridgeManager.reapStalledTurns` / `prepareStalledSession` 以「一个 agent 一个 bridge」为前提。共享进程后，「杀进程」会连带杀死其他会话，`prepareStalledSession` 不能用于单会话恢复；A2 只能用关连接 + 重连恢复，且必须保持约束 23「开火只收口 turn、绝不杀进程」。
- `createSession` / `probeConfigOptions` / `resumeSession` / `forkSession` 四个建会话点都要取连接租约，并继续传同一份 `mcpServers`。
- `/acp` RPC 面基本不变，但每条命令都要能从 `LiveSession` 找到它的连接。

## 4. 未知项与可执行验证方法

逐条先写假设，再写实验，最后写判据。全部用可控制的 CodeBuddy 进程实测，不引用未落地的上游结论。

### V1 跨连接的进程级 `sessionSubject` 当前指针

- **假设**：`getRuntimeSession()` 先读进程级指针，可能让连接 A 的请求解析到连接 B 的会话。
- **方法**：起一个 `--serve --acp` 进程；用 `POST /acp/connect` 建 2 条连接并各自 `initialize`；两条连接分别 `session/new`（cwd 用两个不同目录），再交替发带唯一标记的 prompt，记录每条 `session/update` 的 `sessionId` 与内容；随后做「A → B → A」的顺序重发。
- **判据**：任一条连接的更新或最终回答出现另一条会话的内容、或 `session/load` 把指针切走，即判失败。失败 = A2 暂停，等 B。

### V2 同一会话的 writer 独占

- **假设**：`claimSessionTakeover` 可能让后到的连接抢走 writer，先到的连接静默失效；或后到者得到 `writer_occupied`。
- **方法**：连接 A 建会话；连接 B 用同一 agent 会话 id 做 `session/load`（先同 cwd，再换 cwd 各一次）；观察返回是否为 `writer_occupied` / 是否发生 takeover；takeover 后继续在 A 发 prompt，并观察 A 是否还收到 `session/update`；最后断开 A 的 SSE，等 token 过期或用新连接重试 `session/load`。
- **判据**：错误码与文案可复现；A2 必须保证一个 ACP 会话同一时刻只有一个租约。若 takeover 静默抢走，需要租约围栏，否则 A2 不能上线。

### V3 `--serve --acp` 与桌面端 `--serve` 共存

- **假设**：桌面端与 CLI 的 `--serve` 可能共享端口、单例锁或状态目录。
- **方法**：先让桌面端 CodeBuddy 正常运行；再在不同端口启动 `codebuddy --serve --acp --acp-transport streamable-http --port <port>`；分别请求两者；再试同端口启动，记录退出码与 stderr；同时读 `--help` 确认 `--serve` 与 `--acp` 的叠加语义。
- **判据**：两者可同时响应即通过；若桌面端占用固定端口或单例锁，A2 必须换端口或换独立 profile，并在文档写明。

### V4 端口冲突与失败清理

- **假设**：端口被占用时进程可能静默退出或换端口，插件难以判断。
- **方法**：先用一个临时监听占住端口，再启动 CodeBuddy serve，记录退出码与 stderr；测试 `--port 0` 是否被支持并能报出实际端口；在插件侧模拟「探测端口 → spawn → 绑定失败」并验证重试与清理。
- **判据**：失败必须显式报错（`agent/notice` + 状态 error），不能静默换成别的 agent；失败后不得留进程或端口。

### V5 token 过期后的续期

- **假设**：`gateway.tokenTtlMs` 到期后连接失效，且没有就地续期端点。
- **方法**：把 `gateway.tokenTtlMs` 设为最小值 60000；保持一条连接与一个长回合，跨过到期点，记录 SSE 是否断开、请求返回码与文案；随后尝试 `POST /acp/connect` 取新 token，再用新连接 `session/load` 同一会话，观察是否受 V2 的 writer 语义阻挡。
- **判据**：明确回答「能否不丢会话续期」。若不能，token TTL 就是 A2 会话的硬寿命，连接池必须提前重建并接受 `session/load` 的上下文缺口。

### V6 进程级工作区与 MCP 作用域（附带）

- **假设**：进程启动时定死 workspace（§2.1），MCP 列表也是进程级。
- **方法**：同一进程开两条连接，分别 `session/new` 到两个不同 cwd，在各自会话里执行能暴露 cwd 的工具；再让第二条连接带不同 `mcpServers` 建会话，检查第一条会话的 MCP 工具是否被顶掉；四个建会话点各测一次。
- **判据**：若 cwd / MCP 都是进程级，A2 只适用于「同工作区、同 MCP 配置」的会话，必须在落地前写成硬限制。

### V7 连接上限的实际语义（附带）

- **方法**：用 `CODEBUDDY_ACP_MAX_CONNECTIONS=2` 起进程，开 3 条连接，核对第三条的 503 与文案；关掉一条后重试；再让一条 token 过期，观察名额是否释放。
- **判据**：上限按 token 还是按活跃 SSE 连接计数、过期是否释放名额，直接决定池大小与排队策略。

## 5. 何时应该启动这项工作

**至少满足一条触发条件，才进入设计评审**：

1. **A1 的内存成为实测问题**：并发会话数增加后，每会话约 300 MB 的进程占用造成 OOM、swap 或明显卡顿，且有测量数据。
2. **B 不可用且多进程不被接受**：上游明确不修路由缺陷，同时运行环境限制进程数（PID 上限、容器配额、企业策略），A1 不可行。
3. **需要单进程承载 10 个以上会话**：这是 A2 的规模收益区间；少于这个量级，A1 的复杂度更低。
4. **需要进程级共享热状态**：认证、MCP 连接或模型缓存只能在一个进程内共享，且上游没有跨进程方案。

**启动前必须全部满足的门槛**：

- V1、V2 通过，或有确定性的租约围栏与错误处理；任一失败即不做 A2。
- V3、V4、V5 的行为已知，且端口、重连、token 生命周期都有明确策略。
- V6 的限制已写进文档与设置页，用户能看懂「哪些会话不能共享进程」。
- 隔离强度下降被明确接受，不能对外宣称「与 A1 等价」。

**不构成触发条件**：会话数少、内存压力未出现、B 仍有修复可能。这三种情况下应先等 A1 的实测数据或 B 的结论。

## 6. 当前不做的理由

1. **改动面在传输层，风险高于 A1**：A2 要同时改 `AgentBridge.spawnAndConnect` 的连接建立、会话到连接的映射、进程生命周期、停机预算与错误路径；A1 主要改进程拓扑与回收，协议与传输不动。
2. **新增网络面**：本地端口、token、SSE 断线、防火墙与端口冲突，都是 A1 没有的故障源。
3. **隔离不能根治**：A2 的并发隔离依赖 `AcpAgentManager.register(connectionId, agent)` 与每条连接一个 `currentSession`，而进程级 `sessionSubject` 与 writer 独占仍是上游语义。本仓只能绕，不能保证跨连接不串线。
4. **收益未证实**：每会话约 300 MB 需要实测；一个进程的内存会随会话增长，不能简单按「进程数 × 300 MB」估算。
5. **当前没有触发条件**：A1 尚未成为瓶颈，B 也还没被排除。此时做 A2 是为一个可能被上游修掉的缺陷增加长期复杂度。

## 7. 与 B（上游修复）的关系

- **B 修好之后，A2 的 N 条连接前提可能消失**：如果一条连接（或一个进程）能正确承载多个并发会话，就不需要用「N 条连接」绕进程级指针；A2 可退化成「单进程 + 单 HTTP 连接」，甚至不需要。
- **A1 也会简化**：并发不再依赖每会话一进程，A1 只在需要强故障隔离时保留；进程数与内存压力同时下降。
- **B 只修一半时仍有限制**：若 B 只修 `sessionSubject` / 路由，不修进程级 workspace 与 MCP 作用域，单进程仍只能服务同工作区、同 MCP 配置的会话。
- **顺序**：先确认 B 的状态，再决定 A2。A2 是对上游缺陷的客户端绕行，不应在 B 可修时先做。

## 8. 决策记录与交接

| 日期 | 路线 | 结论 | 依据 |
|---|---|---|---|
| 2026-11-04 | A1 | 待实测 | 内存收益与进程数上限取决于真实会话规模 |
| 2026-11-04 | A2 | 未决策，当前不启动 | 见 §6；等 §5 的触发条件 |
| 2026-11-04 | B | 待上游确认 | 修好则 A2 与 A1 都可简化 |

**若启动，落地时必须同步**：

| 文档 | 改什么 |
|---|---|
| [AGENTS/protocol.md](../../../AGENTS/protocol.md) §7 | 启动命令、传输、端口、token、重连与停机语义 |
| [AGENTS.md](../../../AGENTS.md) 约束 10 / 11 / 19 / 23 / 26 / 32 | 进程死亡与连接断开的区分、身份校验、空闲释放、杀进程边界、启动命令、MCP 作用域 |
| [AGENTS/architecture.md](../../../AGENTS/architecture.md) §4 | 工作区与 `spawnCwd` 的单进程限制 |
| [docs/todo.md](../../todo.md) 与 [backlog README](./README.md) | 状态与待办去向 |

**接手阅读顺序**：本文 → [AGENTS/protocol.md](../../../AGENTS/protocol.md) §7 → `src/bridge/agent-bridge.ts` 的 `AgentBridge` / `spawnAndConnect` → `src/bridge/turn-stream.ts` 的 `LiveSession` → `src/bridge/manager.ts` 的 `BridgeManager` → `node_modules/@agentclientprotocol/sdk/dist/http-stream.d.ts` 的 `createHttpStream` / `HttpStreamOptions` → 上游的 `AcpAgentManager` / `SessionManager`。

**命令**：本节只列验证入口，具体命令按本机 CodeBuddy 的 `--help` 与端口配置填写；不要照抄未经实测的输出。
