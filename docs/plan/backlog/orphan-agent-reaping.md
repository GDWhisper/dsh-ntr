# 孤儿 agent 进程的回收：两条候选路线与一条暂缓路线

**日期**：2026-11-01　**状态**：未落地，待决策。**适用范围**：`src/bridge/agent-bridge.ts` / `src/bridge/process.ts` 的进程生命周期与 `src/impl.ts` 的启动命令解析；不涉及浏览器半区。

**一句话**：宿主被强杀（`SIGKILL` / `taskkill /F`）时，插件拉起的 ACP agent 会作为孤儿活下来；本文记下「为什么现在的代码兜不住」「三条候选路线各自的机制与验收口径」「同行怎么做的」，供之后决定做不做、做哪一条。

> 本文只记设计与证据，**没有任何一行代码按此改动过**。现行代码、[AGENTS.md](../../../AGENTS.md) 与 [AGENTS/protocol.md](../../../AGENTS/protocol.md) §7 才是权威；冲突时以它们为准——本文只指出该改哪一句。

---

## 1. 为什么

### 1.1 现象

宿主进程被杀掉之后，聊天窗口里的 agent 还活着：继续占内存（实测约 240 MB RSS），并继续持有它自己那份会话状态，用户看得见的只有任务管理器里多出来的 `node.exe`。这不是「会话泄漏」（会话记录随宿主消失），是纯进程泄漏，而且用户没有任何界面手段清掉它。

### 1.2 当前代码覆盖到哪一步（已核对）

| 路径 | 覆盖的退出方式 | 符号 |
|---|---|---|
| 优雅关闭 | 宿主主动停机：并发 `shutdown`，`SHUTDOWN_BUDGET_MS = 4s` 是整条预算 | `BridgeManager.shutdownAll` / `AgentBridge.shutdown` / `AgentBridge.parkSessions` / `src/bridge/process.ts` · `disposeChild` |
| 主动杀进程 | 空闲释放、崩溃、`forceReset`、启动失败、启动竞态 | `AgentBridge.killChild` / `AgentBridge.killChildAndWait` / `src/bridge/process.ts` · `disposeChild` / `killProcessTree` |
| 退出钩子 | 宿主还能执行 `process.once('exit')` 的退出（含未捕获异常、显式 `process.exit()`） | `src/bridge/process.ts` · `trackAgentChild` / `reapLiveChildren` |
| **缺口** | 宿主被 `SIGKILL` / `taskkill /F`：进程里没有代码可跑 | 无 |

`AGENTS/protocol.md` §7 末尾把这件事写成**明确的非目标**（「宿主被 SIGKILL 或断电仍可能留下孤儿进程」）。所以本文任何一条路线落地，都要在同一个提交里改写那句话——不能留着「非目标」自称覆盖。

两条最省事的直觉——「关掉管道它就会退」「agent 自己会发现」——都已被实测否掉（§2 事实 2 / 3）。剩下的只有「进程创建时就把父子绑进内核的归属」这一条路，于是才有方案 A 与 B 的分叉：**A 让 agent 自己成为 job 成员，B 让一个不掉队的中间进程负责收尸。**

---

## 2. 已证实的事实

全部经实测或读码核对，动手前不必重查。

| # | 事实 | 含义 |
|---|---|---|
| 1 | 父进程 `taskkill /F /PID <parent>`（**不带** `/T`）；插件的真实 spawn 形状是 `cmd.exe /d /s /c "codebuddy.cmd --acp"` → `node.exe`。agent 挺过 91 s 轮询，约 235 s 时仍活着，约 240 MB RSS，stderr 零输出。最后手动杀掉 | 宿主一死，agent 不会自己退 |
| 2 | 只 `child.stdin.end()`（父进程仍活着）：+62 s 仍活。关 stdin **加**两条输出管道：+30 s 仍活 | 「管道关了就会退」是错的，不能拿它当兜底 |
| 3 | codebuddy 2.179.0 有 `startOrphanWatchdog`（模块 `714234`），但 `isBrokeredSession()`（模块 `879700`）为假时直接返回；为真时它轮询 `process.ppid` 与启动快照比对，而 Windows 上该值不变 → 永不触发。插件拉起的会话根本不装 watchdog | 不能指望 agent 侧自救 |
| 4 | libuv 给每个**非** `detached` 的 spawn 建 `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` 的 job，但带 `SILENT_BREAKAWAY_OK`：`cmd.exe` 壳起的 `node.exe` 会脱离该 job。对照组——直接 spawn 的 agent 在父进程被杀后 ≤1 s 消失 | 这是方案 A 的全部依据：**归属只要接上，内核会替我们收** |
| 5 | `src/bridge/agent-bridge.ts` · `AgentBridge.spawnAndConnect` 的 spawn 选项是 `detached: process.platform !== 'win32'`；`.cmd` / `.bat` 走 `src/bridge/process.ts` · `windowsShimLaunch`（`cmd.exe /d /s /c` + `windowsVerbatimArguments`）；回收走 `killProcessTree`（`taskkill /pid /t /f`）；收尾走 `disposeChild`（同一条预算内先 `stdin.end()` + 平台 kill，再升级）；退出钩子是 `reapLiveChildren` | 改拓扑要动的位置就这几处 |
| 6 | ACP SDK 1.4.0 与传输无关（`ndJsonStream(output, input)`），并带 `experimental/http-client` / `ws-client` / `server`；其文档明确 v1 **不**跨断线重放飞行中的消息 | 方案 C 的可行性边界 |

---

## 3. 方案 A —— 绕开 `.cmd` 壳（先验证，零依赖）

### 3.1 机制假设

事实 4：job 的归属断在 `cmd.exe` 这一跳。若把 `node.exe`（或真实 exe）直接作为 `spawn` 的子进程，它就落在 libuv 建的 job 里，宿主被强杀 → job 句柄关闭 → 内核终止成员。**不需要新进程、不需要新依赖，只需要不再经过壳。**

### 3.2 怎么做

1. `src/bridge/process.ts` · `findExecutable` 命中 `.cmd` / `.bat` 时，解析 shim 的真实目标。npm 生成的 shim 结构固定为 `node "%~dp0\node_modules\<pkg>\…\<cli>.js" %*`，解析产物是「解释器 + 脚本 + 其余参数」。
2. 或者在 `AcpAgentDef` 上允许显式 `binPath` 覆盖，让用户在 shim 解析不了时手动给真身。新增字段的纪律照 [AGENTS.md](../../../AGENTS.md) 的「扩展配置字段」：`validateAgentDef` 会重建对象（新字段必须纳入且 optional），`src/client/panel.tsx` 的 `initialForm` / `buildPayload` / `payloadEquals` 三处同步。
3. 解析成功时不再调 `windowsShimLaunch`（那条路径只服务剩下的壳）。**这不违反约束 26**：约束 26 禁止的是把 `.cmd` 直接交给 `shell: false`，而不是禁止绕开壳；绕开之后交给 spawn 的是真 exe，`findExecutable` 的 `EINVAL` 问题自然不存在。
4. 解析失败（含 `npx` 这类会再起一层的壳）原样回落现有 `windowsShimLaunch`——行为不变，只是没有回收保证。

### 3.3 验收

- 复制同一实验：父进程 `taskkill /F`（不带 `/T`）后，**90 s 内** agent 必须消失（对照组是 ≤1 s，90 s 是给冷启动与轮询留的余量）。
- `npx` 系 preset（`npx -y <pkg>`）单独测一次：它多一层 node 与联网安装，不能拿主实验的结果推断。
- `npm run prepack` 全绿；`tests/bridge.spec.ts` 现有 spawn / 回收用例语义不变。

### 3.4 风险

- shim 解析脆弱：引号、`%~dp0`、`%*`、`node` 是否绝对路径、`node_modules` 提升（hoisting）后路径不同。解析不出来必须**回落到壳**并如实记一行日志，不能猜。
- 可能改变 argv / env 语义：壳会把 `%*` 展开成调用方参数，我们得自己拼出等价参数；`cmd.exe` 的环境继承与直接 spawn 不同（`windowsShimLaunch` 的注释里 `cmd` 会展开 `%VAR%`）。
- 只解决 Windows。POSIX 已经是组杀 + `detached`，本来就没这个缺口。
- 对 `npx` 启动的 agent 需要另判，很可能覆盖不到。
- 与约束 26 的文档措辞需要同时调整（「必须经 `cmd.exe`」要变成「壳必须经 `cmd.exe`，真身能解析出来就直接 spawn」）。

**工作量与状态**：半天验证 + 小改。**状态：待验证**（先做这一步，成了就省掉方案 B）。

---

## 4. 方案 B —— supervisor 包装（跨平台，长期）

### 4.1 拓扑

```
host (Node, 插件)
  └─ supervisor (Node helper, Windows: detached)
       └─ cmd.exe /d /s /c "codebuddy.cmd --acp"   ← 或方案 A 的真身
            └─ node.exe (agent)
```

宿主只跟 supervisor 说 stdio；supervisor 只做三件事：转发字节、盯着父进程活没活、收尸。

### 4.2 必备契约（逐条即验收项）

1. **supervisor 在 Windows 必须 `detached`**。否则它自己也进 libuv 的 job，宿主死时内核先杀它，它就来不及收尾——这直接决定方案成不成立。POSIX 同样要 `detached` / 独立进程组。注意现有 spawn 选项是 `detached: process.platform !== 'win32'`，新拓扑必须按**角色**而非平台取值。
2. **父管道 EOF → 杀 agent 树 → 自己退出**。宿主被强杀时，它那一端的管道被内核关闭，这就是 supervisor 唯一可靠的「宿主没了」信号（比 `ppid` 轮询可靠，正是事实 3 反着的教训）。杀掉用 POSIX `kill(-pgid)`、Windows `taskkill /T /F`。
3. **收到 `SIGTERM` / `SIGINT`（优雅关闭时）→ 同样先杀树再退**。宿主主动停机不能因为多了一层包装而变成「supervisor 退了、agent 留着」。
4. **agent 先退 → 透传 code / signal 后退出**。`disposeChild` 与 `spawnAndConnect` 的 `exit` / `close` 判定读的就是这对值，改了就动到约束 11 的身份校验语义。
5. **stdio 逐字节透明（含 stderr），不做 JSON 解析，尊重背压**。上游 `child.stdin.write` 的返回值、`drain` 事件、下游读端暂停，都要原样传导；任何一侧卡住不能无限缓冲。stderr 必须原样转发，否则 `noteStderr` / `stderrTail` 的失败卡片会失去唯一有用的那一行。
6. **supervisor 记录并暴露 agent pid**。诊断（「现在活的是谁」「taskkill 该打谁」）只能靠它，不能再靠 `child.pid`。
7. **`killProcessTree` 的语义变为「打 supervisor 树」**，`disposeChild` 的预算与升级要在新拓扑下重新表述：supervisor 自己要能在预算内退，escalation 之后不能再留一层活着的包装进程（否则 `liveChildPids` 与 `reapLiveChildren` 会盯错对象）。

### 4.3 改动面

| 位置 | 改动 |
|---|---|
| `src/bridge/agent-bridge.ts` · `AgentBridge.spawnAndConnect` | spawn supervisor（`process.execPath` + helper 路径），`detached` 按角色取；`child.pid` 变 supervisor 的 pid |
| `src/bridge/process.ts` · `windowsShimLaunch` | 引号 / `/d /s /c` 逻辑下沉成与 helper 共享的模块（helper 要用同一套，否则两条路径的引号行为分叉） |
| `src/bridge/process.ts` · `killProcessTree` / `disposeChild` | 打 supervisor 树；预算与升级重述（见 4.2 第 7 条） |
| `src/bridge/process.ts` · `trackAgentChild` / `reapLiveChildren` | 登记的 pid 语义变化，退出钩子要连 supervisor 一起收 |
| 新增 helper | 运行时子路径，先例是 `presets/acp/acp-guard.mjs`：`package.json` 的 `exports` 加一条映射、`files` 放行该目录（现在已含 `presets`，若另开目录要加进去） |
| [AGENTS/protocol.md](../../../AGENTS/protocol.md) §7 | 启动命令 / Windows / 宿主退出三段的措辞与预算 |
| [AGENTS.md](../../../AGENTS.md) 硬约束 26 | 视实现补一句（「壳经 `cmd.exe`」与「谁负责回收」）；若 supervisor 让「子进程」不再等于 agent 本身，还要一并检查 10 / 11 的措辞（崩溃 ≠ 销毁、`child === child` 身份校验） |
| `tests/bridge.spec.ts` | 新用例：EOF 自杀、信号自杀、agent 先退透传、stderr 行归属 |

### 4.4 验收

- 模拟宿主 `taskkill /F`（不带 `/T`）后，agent **90 s 内消失**，supervisor 也不留。
- 优雅关闭**预算不退化**：`shutdown` 仍是 4 s 总预算，不因为多一层而串行加时。
- stderr 行归属不变：同一行仍归同一个 `AgentBridge` 的 `stderrTail`，不出现重复行或半行。
- POSIX 组杀仍**只杀一次**（不能出现先 SIGTERM 组、再 SIGKILL 组导致的两轮信号风暴），且被杀的组里不误伤宿主自己。
- `npm run prepack` 全绿。

### 4.5 风险

- 多一个常驻进程：内存（每个 agent 一个 Node 实例，冷启动几十 MB）与启动延迟都要计入；空闲释放杀的是 supervisor，语义不变但观感变慢。
- 透传层是新的故障面：背压处理错会挂住 turn（表现为「agent 不说话」），stdin 写入错误要原样冒泡成 `spawn error` 语义。
- **supervisor 自身被强杀时仍有残余**：`taskkill /F` 单独打 supervisor（不是打宿主）时，它的 agent 一样成孤儿。本方案缩小的是「宿主正常 / 异常退出」这一大片，不是「任何进程都能被任意杀」的绝对保证；这条限制必须写进落地后的文档，不能宣称彻底解决。
- 与方案 A 的取舍：B 的覆盖更全（`npx` 系也管得住），代价是多一个进程与新故障面。

**状态：未决策**。A 不成立、或只覆盖一部分 agent 时再做。

---

## 5. 方案 C —— 重启接管（评估过，暂不做）

### 5.1 前提

要接管，agent 必须提供可重连端点：

- codebuddy 有 `--acp-transport streamable-http` / `--serve`（鉴权方式不明）；
- qwen 有 `serve` + `--token`；
- pi 只有 stdio。

也就是说这条路线**不可能对所有 agent 一致**，只能按 agent 分档。

### 5.2 为什么暂不做

1. ACP v1 不重放断线期间的消息（事实 6），接管之后仍要 `session/load` 补上下文——省不掉恢复路径。
2. 它不解决「关掉就该没有进程」这件事，只是把孤儿**合法化**（变成「下次可以接上」）。用户感知到的资源占用与安全隐患还在，只是换了说法。
3. 端口、鉴权、防火墙、多实例冲突，是另一整套问题。

### 5.3 结论

单独立项，且应**建在 B 之上**（先保证宿主消失时进程会死，再谈「尸体还能不能用」）。本文不展开。

---

## 6. 建议顺序

1. **先做 A 的验证**（半天，零依赖）。用事实 4 的对照组实验复现一次，再把 `findExecutable` 的 shim 解析接上去；成了就省掉 B 的大半工作。
2. **A 不成立、或只覆盖部分 agent → 做 B**。B 与 A 不互斥：B 的 helper 完全可以先调用 A 的解析逻辑，解析不出来再退回 `cmd.exe` 壳——那是最全的组合。
3. C 单独排队，排在 B 之后。

---

## 7. 同行实现（证据）

两条独立实现都停在同一处，说明这不是本仓独有的疏忽，而是「跨平台进程归属」本身的难点。

**Lody**（TS，Electron + CLI daemon）

- `packages/shared/src/node/process.ts` · `acquireProcess`：Windows **不** `detached`、POSIX 起独立进程组。
- `windowsTree` 用 `taskkill /PID /T`；其注释直言「父进程先退的孙进程只有 Job Object 兜得住，本树不声称能」——与本文事实 4 同一条结论。
- supervisor 只包 CLI worker（`registerLocalSupervisorControl` 的 IPC 断连自杀）；agent 恢复一律走 `session/load`；**无 Job Object**。

**OmniTerm**（Rust / Axum）

- `src/acp/agent_proc.rs` · `kill_agent_process_group`：POSIX `kill(-pid)`；Windows 只 WARN 且把 `agent_pid` 置 `None`，优雅退出靠 crate 的 `ChildGuard::drop`。
- `src/acp/client.rs` · `spawn_with_session`。
- **无 Job Object、无接管**；其设计稿把 Windows ACP 回收列为「缺失」，并写了「首期可接受 spawn 后立即 Assign，毫秒级孙进程再上 `CREATE_SUSPENDED`」——那句话正是方案 A 的 Windows 版加强形（先 Assign 再放行，代价是要 `CREATE_SUSPENDED` 这类原生调用）。

---

## 8. 落地后要同步的文档

| 文档 | 改什么 |
|---|---|
| [AGENTS/protocol.md](../../../AGENTS/protocol.md) §7 | 把「不做 job object / PID 文件……这是明确的非目标」换成实际结论；补 supervisor 的角色与预算（若做 B） |
| [AGENTS.md](../../../AGENTS.md) 约束 26 | 必要时一句（回收责任落在谁身上；壳与真身两条 spawn 路径） |
| [docs/todo.md](../../todo.md) | 删除对应条目（规则：只留未落地项） |
| [docs/README.md](../../README.md) | 更新 backlog 的状态；`docs/plan/backlog/README.md` 里本文件的状态从「未决策 / 待验证」改成最终结论 |
| `CHANGELOG.md` | 若用户可感知（宿主被杀后不再留进程），按约束 35 写一条净改动 |

---

## 9. 接手须知

**阅读顺序**：本文 → [AGENTS/protocol.md](../../../AGENTS/protocol.md) §7（启动命令、Windows、宿主退出、进程级兜底）→ `src/bridge/agent-bridge.ts` 的 `AgentBridge.spawnAndConnect` → `src/bridge/process.ts` 的 `windowsShimLaunch` → `killProcessTree` / `disposeChild` / `reapLiveChildren`。

**命令**：`npm run prepack`（提交前全量）；`npx vitest run tests/bridge.spec.ts -t "spawns, initializes"`。

**禁止**：

- 把「关掉 stdin / 管道」当成回收手段（事实 2 已否）。
- 在宿主里注册 `SIGINT` / `SIGTERM` 处理器（会改宿主自身的信号处置，`reapLiveChildren` 的注释已说明）。
- 靠 `process.ppid` 轮询判断宿主死没死（事实 3 已否）。
- 未做验证就在文档里宣称「已解决孤儿进程」。

---

## 10. 决策记录（待填）

| 日期 | 路线 | 结论 | 依据 |
|---|---|---|---|
| — | A | 待验证 | 先复现事实 4 的对照组实验 |
| — | B | 未决策 | 取决于 A 的覆盖率 |
| — | C | 暂不做 | 见 §5.2，且应建在 B 之上 |
