# acp_delegate 迁移宿主原生子代理链（选项 A）

状态：**已实施，待用户验收**（分支 `feat/acp-delegate-native-subagent`，用户裁决「尝试 A，不满意整支回退」；独立上下文审核 accept、必修项零，lead 独立 prepack 1793 绿）。
本文件是改造计划与验收基准；旧计划 [acp-delegate-subagent.md](./acp-delegate-subagent.md) 的阶段 2 构想（插件自绘面板补委派行）被本方案取代。

## 1. 裁决依据（宿主契约，已硬校验）

宿主 0.2.2-rc.5 的 `ctx.subagents` 是公开能力接缝（`dsh-subagent/src/index.ts` 模块注释点名预留 `-acp` provider 位）。关键契约：

- **同步拿结果 + 目录行不可兼得**：`delivery:'parent'`（目录行必要条件）下 `notifySettlement` 必然向父 inbox 注入结算消息，且注入先于 `activation.result` 解析（`manager.ts · finishDisposal`）。自定义工具 await result = 同一内容双份投递 + 父回合被占满整个子运行。**宿主唯一正路 = 原生异步形状**：立即返回 name、结束回合、结算通知唤醒父会话。
- 外部激活 = 一次性叶子：无 `prepareContinuable` → `send_message` 被 `requireLocalActivation` 拒（NOT_CONTINUABLE）；`list_agents` 过滤只认 continuable（`list-agents.ts · project`）；面板行禁用（无实时状态/点击穿透/时长）。这些是宿主设计，本方案不试图突破。
- `interrupt_agent` 对 external 有效：`controller.abort` + `dispose`，整个激活终结（结算通常 aborted）。
- 容量：每棵子代理树共享池，默认 8，local+external 共用，**满了拒绝不排队**（ACTIVATION_LIMIT_REACHED），槽在 cwd 解析后的 materialize 里 reserve。
- `waitForTreeWork` 等 external result；**result 不 settle 会挂死父回合收口与容量槽** → provider 必须保证任何路径（完成/超时/中断/dispose）result 落定。
- 鉴权：`startActivation` 要求 `ctx.agents.get(spec.parent.id) === spec.parent`（精确存活 Agent），parent 取 `exec.agent`；另需 agents 服务在场、provider 已注册。
- NO_START_CAPABILITIES 的 provider 不得传 agentOptions/outputSchema/maxDepth/agentPreset（一律 UNSUPPORTED_CAPABILITY）。

## 2. 集成形状

**自定义工具 + 直调 startActivation**（不挂 `dsh-tool-subagent` 实例：它的 schema 没有 per-call agent 选择参数，挂实例等于丢 agent 轴）。

- 插件注册 provider：name `'acp'`，仅 `start`，`capabilities` 全 false（自写冻结字面量），`inheritsParentContext:false`。注册经 `ctx.subagents.registerProvider`（effect 作用域，返回 disposer）；`ctx.get('subagents')` 可选访问，缺席走老宿主回落（§5）。
- `acp_delegate` 保留自有注册：名字、`agent/task/cwd` schema、`when=excludesNtr`、guidance 三档 + force 掩码全部不变。
- execute（异步壳，`delegate-provider.ts` · `acpDelegateActivationExecute`）：预校验走 `service.resolve()`（task/agent/cwd 形状 + agent 解析 + 工作区继承计算，可预见错误拦在激活前、不产生目录行）→ `ctx.subagents.startActivation({provider:'acp', label, prompt:[task 文本块], parent:exec.agent, signal:exec.signal, delivery:'parent', cwd})` → **立即返回** `{kind:'activation', name, agent}`。不 await result。**cwd 围栏拒绝不预拦（有意裁决）**：围栏在 `startSession` 管线（`resolveSessionCwd`），`cwd_denied` / `bad_cwd` / `no_cwd` 在 run 内走结算 error（目录行已写，见 §4）。
- provider.start：解析 label 里的 agentId → 复用现有委派核心（建会话/权限 auto{auto,0,preferOnce}/订阅 hub/prompt/折叠/静默窗/24h 兜底/transcript 兜底/closeOnce）→ 返回 `SubagentRun{id, result, dispose}`；result 在核心收口时落定。
- 结算：`SubagentResult{output:[文本块=折叠答复], stopReason, diagnostic?}`。宿主负责注入父会话（"Background subagent X finished… Its closing message:"，只取非空 text 块）。插件不再自写 footer 进 output（宿主摘要已含 stopReason/名字）；错误细节走 diagnostic（≤4096 UTF-8 字节，超限截断加 `\n[diagnostic truncated]`，不劈 UTF-8 序列）。

### 上下文传递（per-call agent 选择）

`ResolvedSubagentStartRequest` 无自定义字段。agentId 经 **label 编码**传递：`label = "<agentId>: <task 首行摘要>"`。agentId 字符集 `/^[a-z0-9][a-z0-9._-]{0,63}$/`（validate.ts · AGENT_ID_PATTERN）不含冒号/空格 → 首个 `': '` 分割无歧义。编码/解码是 `src/impl/` 纯函数对（delegateLabel / agentIdFromDelegateLabel），等价测试钉死格式。cwd 走 spec.cwd（宿主按父 Agent 工作目录解析成绝对，provider.start 收到的已是绝对路径）；timeoutMs/permission 等在 start 时读当前配置，无需 per-call 传递。

### signal 语义（R1，接线必须遵守）

provider.start 收到的 request.signal **不是 exec.signal 原对象**，是宿主两层新建的 controller.signal（trackStartup 合成 + materializeTracked 新建）。**发布后 exec.signal 与 run 脱钩**（转发监听在 start 落定后拆除）；之后的取消只经 interrupt/dispose/drainDescendants abort 该 controller。推论：
- provider 的静默窗/24h 看门狗必须是**内置计时器**，不能指望 exec.signal 事后送达。
- provider 监听 request.signal 的 abort 来响应 interrupt/dispose；外部子代理可活过派生它的工具调用/回合（异步语义的根基）。
- label 路由是唯一可靠关联手段（signal 对象身份不保留，WeakMap 方案不可行）。

## 3. 行为变化（用户验收点）

| 面 | 旧 | 新 |
|---|---|---|
| 工具返回 | 同步阻塞，返回折叠全文 | 立即返回 name，回合结束 |
| 答复送达 | 工具结果 | 宿主结算通知（user 消息，source `subagent-settled`）|
| 原生面板 | 无行（刻意不双写）| external 成员行（禁用叶子：不可点开/无实时状态）|
| 中断 | 无原生入口 | `interrupt_agent` 可终结（一次性，不可续聊）|
| list_agents | 不列 | 仍不列（宿主设计）|
| 容量 | 插件自有排队 | 共享每根 8 槽，满则拒绝（错误明示模型）|
| 工具卡 | 全文答复 | 已委派提示（name + agent）|

不变：agent/task/cwd 参数、默认 agent、工作区继承与校验、guidance off/on/enhanced/force、force 掩码、when excludesNtr、权限恒 auto、静默窗 timeoutMs（默认 40min）+ 24h 绝对兜底、hub 折叠（seq 去重/跳 parentToolCallId/完整累加）、A1 并行/非 A1 按 agent 排队。

## 4. 结算与生命周期契约（provider 必须满足）

- result **发布后永不 reject**（基础设施故障除外）；outcome 映射：ended→completed、aborted（signal/dispose/interrupt）→aborted、timed-out→error+diagnostic、prompt-error→error+diagnostic。
- dispose 幂等：cancel ACP 回合 → close 会话 → 保证 result 落定（aborted）。与正常收口的 closeOnce 协调，settle 恰一次。
- 响应 request.signal：abort → 取消剩余工作 → settle aborted。
- 静默窗在**两壳共享的核心 run**（`touchSilence`）；24h 绝对兜底是 **native-only**：`begin` 的可选 `absoluteBudgetMs` 内置计时器（legacy 壳省略、仍用宿主工具预算）。到点 cancel + settle error。**任何路径不得让 result 悬空**（防 waitForTreeWork 挂死）。**缓冲 cause 优先**：run 安装 settle 之前到达的外部 cause（dispose / 绝对到期）先缓冲、bind 时按序 drain；排队期间 24h 到期时缓冲的 timed-out 压过 queue-abort，settle 成 timed-out 而非 aborted。
- **childId 自铸**：SessionId 是纯编译期 brand（无运行时格式校验），`randomUUID() as SessionId` 即可；宿主查唯一性（resident/agents/sessions 三表），撞了抛 DUPLICATE_CHILD 并 dispose。
- **provider.start 抛错 = 干净失败**（R4）：目录行在 materialize 成功后才写，start 抛错时行不存在、容量槽自动释放、无 resident 条目。行写入后的失败走 dispose/finishDisposal，**行是持久创建事实，任何失败路径都不删行**。
- receipt（startActivation 返回）：`{childId, name, result, dispose}`；其 result 是宿主新建 promise（先注入结算、后解析），**与 provider 的 run.result 不是同一个**；工具只取 name，不 await receipt.result。
- execute 侧经 `resolve()` 预校验，把可预见错误拦在 startActivation 之前（错误 UX）；label 无合法 agent id / 空 prompt / agent 已删等 **start 抛错** = 干净失败（无行、槽释放）。**cwd 围栏 / spawn 失败不是干净失败**：它们在 handle 发布之后发生，走结算 error（行是持久创建事实，任何失败路径不删行）——有意裁决，见 §2。

## 5. 老宿主回落

`ctx.get('subagents')` 缺席（旧宿主无接缝）→ 保留现有同步 execute 路径（legacy 壳），工具描述用同步措辞。注册时按接缝在场选壳；guidance 热重载重注册时重判。两壳共享委派核心，只是外层映射不同（legacy：await result → 折叠文本工具结果；native：startActivation → name）。

## 6. 模块与依赖

- **依赖实际落地（与原计划「npm 自动 peer」预期的偏差）**：仓新增 `.npmrc` 设 `legacy-peer-deps=true`——两代 DSH 类型包共存（0.1.5-rc.x client/host 家族 + 0.2.2-rc.5 subagent 家族），exact-pin 的 peer 树互相冲突（如 dsh-brand 0.1.5-rc.2 vs 0.2.2-rc.5），插件对它们零运行时 value import，peer 解析可安全忽略（与宿主 profile 的 pnpm `autoInstallPeers=false` 同姿态）。**npm 自动 peer 安装在 legacy-peer-deps 下失效**，故直接引用的类型包全部显式补 devDep：`@deepseek-ai/dsh-subagent` / `dsh-llm` / `dsh-session` / `dsh-agent` 精确锁 `0.2.2-rc.5`（与运行宿主同版），`@deepseek-ai/cordis` 由 `4.0.2` bump 到 `4.1.0`，另补 `@testing-library/dom`（`@testing-library/react` 的 peer，同样不自动装）。
- 宿主侧**只 type-only import**（沿用 index.ts 现有模式：cordis/webserver/connection 全是 type import，运行时全走 ctx）。零运行时 value import → 不赌宿主 loader 模块表。
- `NO_START_CAPABILITIES` 自写冻结字面量（4 布尔）；diagnostic 截断语义手拷贝为 `src/impl/delegate-label.ts` · `truncateDelegateDiagnostic` 纯函数 + 等价测试（钉 0.2.2-rc.5 语义，防漂移）。never-reject 契约由自有结算 wrapper（`delegate-provider.ts` · `settleDelegateRun`）实现 + 测试。
- ContentBlock 文本块形状 `{type:'text', text:string}`（无 readonly 修饰）；SubagentResult.output 是 `readonly ContentBlock[]`。
- 浏览器半区**不动**：external 行由宿主原生组件渲染（delegate 激活活在非 NTR 会话，不触发 ACP-only claim）；设置页 delegate 两键不变。
- 宿主升级时同步 bump 四个类型包并复核 peer（类型墙同步流程见 [AGENTS/host.md §5](../../AGENTS/host.md)）。

## 7. 文件簇与行数预算

- 新 `src/bridge/delegate-provider.ts`（provider + 结算 wrapper + 看门狗接线）≤1000 行。
- `src/bridge/delegate-service.ts`：核心拆 begin/run/settle（begin 返回 run 句柄 + result promise），legacy 壳保留；棘轮锁线只缩不涨。
- 新 `src/impl/delegate-label.ts`（label 编码/解码 + diagnostic 截断纯函数）+ `src/impl.ts` 桶再导出。
- `src/protocol/`：工具输出异步形状契约（kind:'activation'|'error'）+ 桶再导出。
- `src/index.ts`：provider 注册（可选接缝）+ 工具注册选壳。
- `package.json` devDep + `.npmrc`；测试实际落点：`tests/delegate.spec.ts`（legacy 核心改异步）、`tests/delegate-harness.ts`（共享 in-memory fake）、`tests/delegate-provider.spec.ts`（provider 单元）、`tests/delegate-native.spec.ts`（native 壳 + 注册对账）、`tests/bridge/delegate-native.spec.ts`（真实子进程集成）、`tests/impl/delegate-label.spec.ts`（label / 截断等价）；老宿主回落用例在 delegate-native / delegate.spec。
- 单文件 >500 行或会话净增 >200 行 → 收尾报告行数与原因。

## 8. 文档修订（同提交）

- AGENTS.md 约束 40 **重写**（不追加）：异步原生激活、宿主单一事实源（目录/结算/中断归宿主，插件不自写 record/catalog——「不双写」精神保留为「不平行双写」）、老宿主回落。净增 >10 行需逐条说明；总行数 ≤150。（此项由主智能体定稿）
- AGENTS/architecture.md §5（acp_delegate 段）、AGENTS/protocol.md（结算/生命周期落点）、AGENTS/state.md（delegate 键不变声明）、AGENTS/subagent-adapters.md（澄清 delegate 不属 worker 适配器家族）、AGENTS/host.md（ctx.subagents 接缝依赖 + 版本）。
- 旧计划 §10.3/§11 指向本文件；docs/todo.md 相关条更新。
- CHANGELOG 不动（约束 35）。

## 9. 验收

1. `npm run prepack` 全过（行数门禁 + typecheck + vitest + build）。
2. 独立上下文审核 worker 按本文件逐项核查，结构化报告；必修项修正附变异验证。
3. 集成测试（mock-agent）覆盖：异步返回 name、结算落定、interrupt→aborted、静默窗→error、dispose 幂等、容量拒绝明示、老宿主同步回落。
4. 只暂存本任务文件，Conventional Commits 提交到分支。

## 10. 回退

整支回退：`git switch main`（分支未合并，main 不受影响）；或 `git revert` 分支提交。用户不满意即回退另议。

## 11. 风险与技术债（用户有权知悉）

- label 编码路由：显示字段兼任路由载体 → 纯函数对 + 等价测试钉死，格式变更必须同改两处。
- 手拷贝截断语义：宿主升级可能漂移 → 等价测试 + devDep 版本钉住；升级宿主时复核。
- 容量挤占：长跑委派占共享 8 槽，可能挤掉原生子代理名额 → 拒绝错误明示模型；静默窗保证最终释放。
- 异步语义变化：同步折叠答复退役 → 本分支核心验收点。**定稿偏离**：原写的「模型必须结束回合等通知」已作废——宿主 `notifySettlement` 对忙碌父回合按 `steer` 投递，派发后可以继续做不相交的工作，见 [AGENTS/architecture.md §5](../../AGENTS/architecture.md)。
- 面板行仍是禁用叶子：实时状态/点击穿透要宿主改（选项 C），本方案不承诺。
- 类型 devDep 墙：dsh-subagent/dsh-llm/dsh-session/dsh-agent 四个类型包锁 0.2.2-rc.5 + cordis 4.1.0，`.npmrc` legacy-peer-deps 忽略两代 peer 冲突；宿主升级时需同步 bump 并复核 peer（typecheck 会报断链，流程见 [AGENTS/host.md §5](../../AGENTS/host.md)）。
- **接缝被宿主 HMR 替换 → NO_PROVIDER（本分支暂缓重注册）**：`wireSubagentProvider` 以 `providerDisposer !== undefined` 为已注册标志；宿主 HMR 替换 `subagents` 服务后，旧注册随旧服务消失，但插件 fiber 未拆除、标志不重置，`ctx.inject(['subagents'])` 的重判被标志挡住 → 新服务无 provider，`startActivation` 报 `NO_PROVIDER`。**明示错误、无悬空、失败安全**（工具折成 `{kind:'error'}`，模型读得到原因）；重载插件即恢复。重注册（探测服务身份变化后重置标志）留待后续分支。