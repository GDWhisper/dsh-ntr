# `acp_delegate`：把 NTR 里配置的 ACP agent 变成原生模型的子代理

> 状态：**阶段 1 已实现并提交**（`7fdb029`）。本文保留方案推导；定稿与方案的三处偏离见修订行，完整进展 / 偏离补遗 / 已知限制 / 门禁事实见 §11。
> 修订：已吸收独立审查（运行时语义 / 宿主契约 / 设置基础设施三路 39 项核查 + 原生委派工具形态 8 项核查）结论，§2/§3/§4/§5/§6/§7/§8 按证据重写；引导做成四档滑块（关闭 / 开启 / 引导增强 / 强制模式，兼注册开关，合并原 enabled），强制档经 per-agent `tools.restrict` 遮原生委派工具；拍板见 §10 记录 5–10。定稿三偏离（实现按此，正文推导不改）：① 零污染——注册 `when`（`excludesNtr`，`agentPreset !== 'acp'`）把 `acp_delegate` 从 NTR 会话的声明与派发双排除，NTR 请求头根本不含此工具（§4.1「进请求头但到不了对端」是旧说法）；② `preferOnce`——非 A1 委派 auto 档 `allow_once` 优先（`pickAutoOption` 第二参），防 `allow_always` 共用进程跨会话泄漏，A1 与主会话优先级不变（§4.2）；③ 颜色 token 定稿真名——宿主只有 `state-warn-*` / `state-error-*` 族，enhanced 用 `state-warn-primary` / `state-warn-tertiary`，force 用 `state-error-primary` / `interactive-bg-hover-danger`（§5.2 的旧 token 拼写不存在，只落 fallback）。
> 前置阅读：[AGENTS/architecture.md](../../AGENTS/architecture.md) §1（归属模型）、§5（preset 外壳）；
> [AGENTS/subagent-adapters.md](../../AGENTS/subagent-adapters.md)（现有「子代理」只是**观察** ACP agent 自己的子代理）。

## §1 目标与非目标

**目标**：NTR 主会话（`preset-acp`）能力**一字不改**；另外给 **DSH 原生模型**（非 ACP 会话）一个工具，让它把一件自成一体的任务交给 `agents.json` 里某个 ACP agent，在自己的进程里跑完，再把结论拿回来。四个键（引导档、权限、时限、返回上限）都在设置页新增的「子代理」页里改，**热生效**，不用重启宿主（§5.2 / §5.3）。引导档兼作注册开关：`off` = 不注册工具。

**非目标（本阶段）**：

- 不改 `preset-acp`：不挂 `tool-*` 行，不加 delegation/workflow 行。
- 不让原生模型直接操作用户的 ACP 对话（不注入、不打断、不转发）。
- 不做「后台 detached 委派」：工具返回前子代理必须落地，`execute` 是同步长跑。
- 不做 per-child 多轮对话：一次委派 = 一个新 ACP 会话 + 一条 `session/prompt` + 收尾关闭。
- 不在宿主子代理面板里造第二条事实源（见 §4.3）。
- 不暴露给 ACP 会话内的对端 agent（那条路上根本没有宿主模型）。
- 不改主会话的任何审批设置：委派权限走**会话级**策略接缝，bridge 级字段一个字节不碰（§4.2）。
- 强制档只遮模型可见的原生委派工具（`subagent` / `subagent_fork` / `workflow`），不碰 `ctx.subagents` 服务运行时，也不碰已有子代理的控制面（观测 / 续聊保留，§5.4）。

## §2 三个候选入口，为什么选工具

| 入口 | 形态 | 判定 |
|---|---|---|
| **A. 宿主工具**（推荐） | 插件向 `ctx.tools` 注册一个 `acp_delegate` 定义 | 原生模型在**它自己的工具清单**里看到它；一次调用一次委派；不碰 preset、不碰路由、不碰模型目录。缺点见 §4.1 的可见性说明 |
| B. 绑到某 ACP agent 的「子 DSH 会话」 | 每个委派建一个 DSH 会话，复用宿主的 subagent 机制 | `ctx.subagents`（`SubagentRuntime.startActivation` / `registerProvider`）**是公开服务**——官方 `dsh-subagent-spawn-in-process` 就是 `inject: ['subagents']` 的插件，API 插件侧可达。但造一个子会话要 provider + reserved childId + `ChildComposition`，且让 ACP agent 充当子会话的模型会**复活已退役的 provider=acp 轴**（约束 8/22、[retired.md](../../AGENTS/retired.md)）。成本与架构倒退远高于收益。**放弃** |
| C. 把 ACP agent 塞进 DSH 模型目录，让 delegation 行选它 | `listModels('acp')` 非空 + delegation preset 识别 | 直接撞约束 8 与「不要把 ACP 当成 LLM provider」，并且会把 ACP 模型泄漏进全局模型目录。**放弃** |

结论：**A**。它在宿主里的定位就是「给模型加一个能力」，不改变任何既有归属。

## §3 工具契约

**形状已按宿主核实**：`tools.register` 收的是**已编译的 JSON Schema**（`defineTool` 才收字段表，且其 `output.schema` 是 ValueSchemaSpec DSL——object 必须显式 `additionalProperties`、`required` 不是 DSL 关键字——与本方案输出形状不兼容，还要新增 `@deepseek-ai/dsh-tools` 依赖）。本方案走 **register-ready** 形状：纯 JSON Schema + `output.render`（register 强制要求 render，缺了抛 TypeError），零新依赖，[acp-guard.mjs](../../presets/acp/acp-guard.mjs) 的 `virtualToolDefinition` 是已验证 precedent。

```ts
{
  name: 'acp_delegate',
  description: '把一件自成一体的任务交给一个已配置的外部 ACP agent，在它自己的进程里执行，'
             + '并返回它最后给出的答复。适合需要另一套工具/另一套上下文的独立子任务；'
             + '返回的是被动汇报，不是可继续对话的子会话。',
  parameters: {
    type: 'object',
    properties: {
      task:  { type: 'string', description: '完整任务描述（子代理看不到本会话上下文）' },
      agent: { type: 'string', description: '已配置的 agent id；省略 = 插件默认 agent' },
      cwd:   { type: 'string', description: '工作目录，必须在该 agent 已配置的 allowedCwdRoots 内；省略 = 该 agent 的默认工作区' },
    },
    required: ['task'],
  },
  output: {
    schema: {
      type: 'object',
      properties: {
        text: { type: 'string' }, agent: { type: 'string' },
        stopReason: { type: 'string' }, error: { type: 'string' },
      },
      required: ['text'],
    },
    render: (_args, value) => [{ type: 'text', text: String(value?.text ?? '') }],
  },
  timeoutMs: <delegate.timeoutMs + 30000>,   // 协作式预算，不是硬超时（见下）
  async execute(args, exec) { … },
}
```

**引导档（`delegate.guidance`，默认 `off`）**：工具描述是模型可见的正式契约字段（宿主 `schemas()` 只下发 name/description/parameters，已核实），引导直接写进 description，无需提示词注入。四档语义（UI 标签：关闭 / 开启 / 引导增强 / 强制模式）：

- `off`（关闭）：**不注册工具**——请求头干净，原生模型看不到这个能力。引导滑块兼作注册开关，不再有独立 `enabled` 键（同一真相不双写，约束 17）。
- `on`（开启）：注册，**基础描述**（上面那段），不追加引导句。
- `enhanced`（引导增强）：注册，基础描述后追加「需要派发子代理时，必须使用本工具，优先于任何原生子代理/委派工具。」——**软约束**，模型仍可能选原生工具（原生三工具的描述是收益型论证、无排他句，已核实；MUST 句与之竞争）。设置页黄字说明（§5.2）。
- `force`（强制模式）：注册（描述同 enhanced）+ **真遮原生委派工具**——经 per-agent `tools.restrict({deny})` 把 `subagent` / `subagent_fork` / `workflow` 从该 agent 的可见集移除（机制与名单见 §5.4）。硬约束；设置页红字警告（§5.2）。

描述与预算一样烘焙进注册定义，热改走重注册（§5.3）。

**返回值**（`text` 里是给模型看的整段汇报）：

```text
<子代理最后答复；空则写「(the agent returned no text)」>

— acp_delegate · <agentId> · <stopReason 或 error> · 拒绝 N 个审批 / 自动代答 M 个（有才写）
```

`execute` 内一律 `throw new Error('acp_delegate: …')`：宿主把异常归一成 `isError` 结果给模型，不崩进程。

**超时是协作式的**（宿主 `dsh-tool-call-timeout-policy` 已核实）：到点把派生 signal abort，**等 execute settle 之后**才把结果替换成 `TOOL_TIMEOUT`——工具不 observe `exec.signal`、不 settle，宿主就一直等。所以 `execute` 必须监听 `exec.signal` 并及时收口（§4 步骤 6）；内部时限从 prompt 发出起算，先于宿主预算（+30s 宽限）触发，cancel + close 有界（`session/close` 5s race），能在宽限内 settle。宿主对 `timeoutMs` 只校验正有限数（上限约 24.8 天），3630000 接受。

**cwd 是硬围栏**：RPC `createSession` 不传 `extraRoots`，`resolveSessionCwd` 按 `allowedCwdRoots` 校验——越界 `cwd_denied`、非绝对/不存在 `bad_cwd`、定义无 cwd `no_cwd`。原生会话的工作区通常**不在** agent 的 roots 里：模型传了会报错，错误文案带 agent id，用户需在 agent 卡把该目录加进 roots。**不为模型请求放宽围栏**（聊天会话的 extraRoots 是人选的工作区，委派 cwd 是模型选的，两者授权来源不同）。

**为什么只需要三个参数**：权限策略、超时、输出上限、引导档都是部署级设置（§5），不该由模型自己给自己授权。

## §4 运行语义

新建 `src/bridge/delegate-service.ts` · `AcpDelegateService`，依赖注入（**不 import manager**，与 `subagent-service.ts` 同纪律，已核实该文件 880 行零 manager import）：

```ts
interface AcpDelegateHost {
  hub: EventHub   // subscribe(sink) → 退订函数；事件名是 AcpEvent 联合的 type 字面量，无常量表
  agents(): readonly { id: string; title: string }[]   // AgentView.title 必填
  defaultAgent(): string | undefined
  startSession(agentId, cwd): Promise<{ sessionId: string }>
  setPermissionPolicy(sessionId, policy: { mode: 'auto' | 'abort' | 'wait'; windowMs: number }): void  // 新接缝
  prompt(sessionId, text): Promise<{ turnId: string }>
  cancel(sessionId): Promise<void>
  closeSession(sessionId): Promise<void>   // RPC 层对已删除 id 抛 unknown_session，服务层吞
  respondPermission(requestId, optionId): void   // optionId undefined = cancelled
  transcript(sessionId, afterSeq): { session: unknown; entries: Array<{ seq: number; update: unknown }> }  // 仅兜底
}
```

`BridgeManager` 已逐个具备除 `setPermissionPolicy` 外的成员（`agentViews` / `defaultAgent` / `startSession` / `prompt` / `cancel` / `closeSession` / `respondPermission` / `transcript`），宿主入口只做一层闭包映射；`setPermissionPolicy` 是新增薄委托（manager → rpc → `LiveSession.permissionPolicy`），不新增 RPC。

单次委派：

1. **解析 agent**：`agent` 省略 → `defaultAgent()`；否则按 id 查 `agents()`；查不到就报错并**列出已配置 id**（模型下一轮能自我纠正）。
2. `startSession(agentId, cwd)` —— 走 `/acp` 同一个 `startSession`：A1（`isPerSessionAgent`，写死集合 `['codebuddy']`）拿 `{ kind: 'ephemeral', token: randomUUID() }`，其它 agent 经 `bridgeKey` 折叠到裸 `agentId` 的唯一进程。cwd 校验见 §3。
3. **设会话权限策略**（§4.2 接缝，必须在 prompt 前）：`auto` → `{auto, 0}`；`abort` → `{abort, 30000}`；`ask` → `{wait, 0}`。
4. **订阅 hub**，按 `sessionId` 过滤五种事件：`session/update`（增量折叠）、`permission/request`（abort 就地作答）、`permission/expired` 与 `permission/resolved`（计数）、`turn/end`（终态）。
5. `prompt(sessionId, task)` → `{turnId}`；**按 sessionId 等 turn/end**——委派会话只有一轮，任何 turn/end 即终态。看门狗对无 controller 的会话走 `finalizeTurn`，广播 **`turnId: ''` 且只有 error、没有 stopReason**（`INACTIVITY_TIMEOUT` 只是 settle code，从不进 payload），按 turnId 匹配会挂死；error 进 footer。文本**从 `session/update` 增量累积**：`agent_message_chunk` 经 `chunkTextOf(update.content)` 取文本，跳过 `codebuddyMetaOf(update).parentToolCallId`（agent 自己的子代理在说话；实际键是 `codebuddy.ai/parentToolCallId`，其它 agent 命名空间未覆盖，按 per-agent 接缝纪律登记），按 seq 去重，达 `maxOutputChars` 停止追加并留截断标记。**不在 turn/end 后一次读 transcript**：环形缓冲默认 600 条，`agent_message_chunk` 无淘汰保护，长任务早期文本会被挤掉；transcript 只作兜底。
6. `finally`：超时（内部时限从 prompt 发出起算）/ `exec.signal` 中断 → 先 `cancel()` 再 `closeSession()`（吞 `unknown_session`；close 先 settlePermissions 再 `session/close`，5s race 封顶，**不补发 turn/end**）→ 解订阅。等待在超时 / 中断路径**自结算**，绝不 close 之后还等 turn/end。正常结束则直接 close → 解订阅。

### §4.1 坑一：工具可见性是「层」，不是「preset 行」

`tools.register` 按**调用方 ctx 的层**落位（宿主 `dsh-tools · ToolsService.register` 走 `layers.effect(this.ctx, …)`）：preset 里的 `acp-guard` 是 agent 作用域，插件宿主入口是**全局层**，`tools.get(name, scope)` 是「scoped 遮蔽 global」。

- 于是：宿主入口注册 = **所有 agent 的请求头里都有 `acp_delegate`**（请求头每 step 从本 scope 注册的工具组装），包括 `preset-acp` 会话。
- 判断：**无害**，隔离已逐环核实——`session/new` 只带 cwd + mcpServers（约束 32「宿主侧 MCP 不经此路」），prompt 只带 `selectForwardPrompt` 选出的用户文本；ACP 的 tool_call 名在折叠层被强制改写成保留名 `dsh_ntr__acp_tool_call`（`content.ts`），guard 只接管保留名、解析到真实宿主工具时 fail-closed。对端 agent 看不到工具清单，也指定不了 `acp_delegate` 这个名字。
- 代价：`preset-acp` 的「故意不挂工具行」注释需要补一句「全局层工具仍会出现在请求头，但到不了对端 agent」，避免下一个人误读。
- 因为 `delegate.guidance` 默认 `off`（§5.1）且可以在设置页热滑到关，**默认部署的请求头是干净的**；上面这些只在引导档非 off 时发生。
- 原生委派工具（`subagent` / `subagent_fork` / `workflow`）本身是 **preset delegation 行**挂的（standard preset 的 delegation 组；Web 面 host-plane 行已 disabled），不是全局层——NTR 请求头里本来就没有它们；force 掩码按活清单交集施加，NTR 会话自然跳过（§5.4）。
- 备选（若坚持零污染）：在**每个**原生 agent preset 里挂一行工具插件——做不到，插件不能改别人的 preset。宿主的 `tools.restrict` **要求 scoped ctx**（全局层调用直接抛错），不能全局遮工具；但经 `ctx.agents.get(id).ctx` 可以 per-agent 注册 + 遮蔽（宿主 `dsh-subagent · applyChildOverrides` 同款先例）——把 `acp_delegate` 与 force 掩码都收进 agent scope 是可行的零污染路线，代价是要跟 agent 生命周期事件逐会话挂卸，本期仍选全局注册 + 文档说明（隔离已核实）。`ToolRegistrationOptions.when`（按 step 排除声明与派发）能否读会话 preset 实现前核一次。在 `tools/execute` 里按 preset 拒绝只是执行期拒绝，请求头仍然带着，不选。

### §4.2 坑二：权限会永久挂住，且 bridge 级档位会抢占委派

子会话没有 `dshSessionId`（`startSession` 建的 `LiveSession` 不带），`permission/request` 的对话卡（`permissionsForSession` 按 `dshSessionId` 过滤）不会出现，只剩设置页镜像。于是委派必须有**自己的策略**。

**但策略不能只靠服务层代答**：mode/窗口是 **bridge 实例字段**（`handlePermissionRequest` 在询问开始时读 `this.permissionTimeoutMode` / `this.permissionTimeoutMs`），作用于该 bridge 上所有 session。非 A1 委派会话与主会话共用 bridge——主会话配 `auto + 0` 时询问到达即收场、**根本不广播 `permission/request`**，委派的 `abort` / `ask` 档直接被违反；主会话配 `auto` / `abort` 带窗口时，定时器抢在 `ask` 的人工等待之前收场。三档承诺只在 bridge 为默认 `wait` 时成立，这不够。

**做法：会话级策略接缝**。`LiveSession.permissionPolicy?`（新字段），`handlePermissionRequest` 的两行读取**原地改写**为 `session.permissionPolicy?.mode ?? this.permissionTimeoutMode`（窗口同理）——auto+0 分支、`deadlineAt`、帧、定时器全部复用现有路径，不改语义。`agent-bridge.ts` 锁在基线 2209 行，原地改写**净 0**；`live-session.ts` / `bridge-rpc-service.ts` 未锁。委派期间策略只设在自己那个 `sessionId` 上，**bridge 级字段一个字节不碰**（`setApprovalDeadlines` 之类 per-bridge 设置不动），主会话审批不受影响。

| `delegate.permissionMode` | 会话策略 | 行为 | 场景 |
|---|---|---|---|
| `auto`（**已定：默认**） | `{auto, 0}` | 走 bridge 现有 auto+0 路径：到达即按 `pickAutoOption` 代答（`allow_always → allow_once → reject_once → reject_always → 首个可选项`，挑不出降级 `cancelled`），不建 ledger、不发 request 帧，只留 `agent/notice` + `permission/expired` 痕迹；服务按 `permission/expired` 的 outcome 计数，footer 写「自动代答 M 次 / 拒绝 N 次」 | 子代理要真的能改文件、跑命令；不打断发起方 |
| `abort` | `{abort, 30000}` | 帧到达，服务立即 `respondPermission(requestId, undefined)`（= cancelled），跑赢 30s 定时器；计数自己的答复，footer 写「拒绝 N 次」。已结算条目再答是 `unknown_request`，吞掉 | 只想让子代理读、不想让它动任何东西 |
| `ask` | `{wait, 0}` | 不代答，留在设置页镜像等人（`permission/respond` RPC 答同一个 ledger）；到达 `delegate.timeoutMs` 则由工具失败退出（有待答审批时看门狗不开火） | 想全程盯着（**不建议**，见下） |

**为什么默认 `auto`**：

1. **`ask` 在这里是坏的，不是严的**。子会话没有 `dshSessionId`，对话里那张审批卡永远不出现，只剩设置页镜像——发起委派的模型在对话里等，人却得切到设置页去找，找不到就一路挂到 `timeoutMs`。模型只拿到一条失败，还得重试。这不是「更谨慎」，是功能不成立。
2. **子代理的权限不该和主会话抢注意力**。委派本来就是「这件事我不看了，你办完告诉我」，中途每一条 `permission/request` 都要人点，等于把 N 次打断塞进一次本该无人值守的调用。`allow_always` 优先让一次批准覆盖整轮，剩下的请求不再回来。
3. **授权边界仍在人手里，只是换了个位置**：引导档默认 `off`（可在设置页热滑开），任务文本本身就在原生对话里可见，`permissionMode` 同在那一页可改（默认 `auto`）。约束 13/14 管的是**主会话**默认必须问人——那里一个字节都不改；委派是一次性的、模型主动发起的、作用域仅限自己那个 `sessionId` 的策略，不会放宽任何既有审批。
4. 策略是**会话级**的：接缝只读 `session.permissionPolicy`，bridge 字段不碰；非 A1 共用 bridge 也不串档（上表三档在任何 bridge 配置下都成立）。

**`allow_always` 的跨会话风险**：agent 侧对 `allow_always` 的记忆作用域是 agent 依赖的——非 A1 共用进程上可能跨会话生效，间接放宽主会话后续审批。「不放宽既有审批」只在插件侧成立。实现前按 agent 核一次作用域（A1 ephemeral 进程随 close 死亡，无泄漏）；若跨会话，非 A1 委派改 `allow_once` 优先（委派专属决定，不改主会话 auto 档的优先级），并写进 [permissions.md](../../AGENTS/permissions.md)。

要让子代理完全不动文件时把 `permissionMode` 改成 `abort`；三条路都保留，只是默认换了。

### §4.3 坑三：生命周期与事实源（为什么先不进子代理面板）

宿主的「子代理」面板读的是 `subagents/record` + 外部 catalog 行（`childId = acp:<toolCallId>`），那份事实源是为**对端 agent 自己派工**建的（CodeBuddy `_meta` / agy transcript）。我们的委派是**宿主工具调用**，宿主本来就会在原生对话里渲染这次调用及其结果；再往面板塞一行只会**双写同一件事**，且要新增一个事实源（[subagent-adapters.md](../../AGENTS/subagent-adapters.md) §4 的第三家触发器，成本不小）。

所以阶段 1：**不写 `subagents/record`、不写 catalog**。委派的可见性 = 原生对话里的那张工具卡 + 返回值。
阶段 2（可选，先看阶段 1 的实际观感再定）：若用户要「像子代理一样点开看」，再按该文档的五个动词补一个 `acp-delegate` 适配器，`childId = acp-delegate:<toolCallId>`，明细读子会话 transcript。

### §4.4 坑四（实现时必处理）：并发与共用进程

**先纠正一个前提**：`turn_in_flight` 守卫是 **per-session** 的——`BridgeRpcService.prompt` 只读目标 session 自己的 `running` / `turnSlot` / `turnController`（`session-lifecycle.ts · hasPromptSlot`），同一 bridge 上两个委派会话**不会互相拒绝**，两条 prompt 都会发给同一个 agent 进程。agent 是否支持并发会话是它自己的事，插件没有跨会话守卫。

所以 per-agentId 串行队列是**防御性**的（不赌 agent 的并发支持），不是修一个现成的错：`AcpDelegateService` 内按非 A1 的 `agentId` 各维护一条 promise 链，排队而不是报错；`agent` 不同则并行；A1 一委派一进程，天然并行。两个后果写进文档：

- 主聊天与委派共用非 A1 进程时的并发同样是 agent 依赖、无插件守卫；队列只排委派之间的序。
- 排队等待吃宿主预算（预算从 execute 起算），内部时限从 prompt 发出起算——宿主预算在排队期间到点时 `exec.signal` abort，离队并抛错，模型可重试。

### §4.5 不需要新逻辑的两处

- **空闲释放**：委派会话是 live 且有未结算 `session/prompt`，`pendingPromptsOnServableSessions`（live + released 都算）已经拦住释放（约束 19）。委派会话 released **不落盘**——`persistedRows` 跳过无 `dshSessionId` 的会话，重启后无孤儿记录。
- **卡死看门狗**：`reapStalledTurns` 覆盖无 `dshSessionId` 的会话（无 controller 时 `onAir` 恒真），静默超 `turnStallMs`（默认 600000）收口本轮，有在飞工具调用用 `turnStallToolMs`（默认 1800000），tick 30s；工具随之拿到 turn/end（error-only，§4 步骤 5 已处理）。默认 `delegate.timeoutMs`（10 分钟）与 `turnStallMs` 相等：静默且无工具调用的回合可能由看门狗先收口，有工具调用的回合工具超时先触发——两条路都收口，不需要第二种超时。看门狗只收口不杀进程，委派的 finally 照常 close。

## §5 配置与设置页

两层，和「空闲释放」「审批时限」**同一套形状**（「技能」页只是即时开关的 UI precedent——`skillsMcp` 没有部署基线，是单层）：

- **部署基线** —— `cordis.patch.yml` 的 `delegate` 键；
- **设置页** —— 写进插件自己的状态文件（`~/.dsh/dsh-ntr/agents.json` 的 `delegate` 键，见约束 28），**压过**部署基线；
- **重置** —— 回到部署基线（部署没写就回内置默认），按钮文案照 `IdleReleaseCard` 的写法：「恢复配置文件的值」/「恢复默认值」。

两者都热生效，不需要重启宿主；「部署写了什么但被压过」必须显示在**被覆盖的那个控件上**（警告色，约束 33），没被压过就不说。

### §5.1 键

```yml
delegate:
  guidance: off            # off | on | enhanced | force；off = 不注册工具（兼注册开关，§3）
  permissionMode: auto     # auto | abort | ask（见 §4.2）
  timeoutMs: 600000        # 单次委派上限 [1000, 3600000]
  maxOutputChars: 20000    # 折叠答复上限 [1000, 200000]，超出截断并留标记
```

- 全部可选，`validateDelegateConfig`（`src/impl/validate.ts`）给默认值；未知键忽略（与现有键同风格）。
- `guidance: off`（**默认**）时**不注册**：请求头干净，原生模型看不到这个能力。`on` 注册基础描述；`enhanced` 追加 MUST 引导句（软约束）；`force` 另施加 per-agent 遮蔽（§5.4）。引导档就是注册开关本身，没有独立 `enabled` 键。
- 四个键都存在 `agents.json` 的 `delegate` 下（只存**用户真改过的**，显式覆盖语义同 `approvalDeadlines` / `idleRelease`）。
- **命名**：键族用 `delegate`——`agents.json` 已有 `subagents`（复数，worker 生命周期记录）、RPC 已有 `subagents/record`，单数 `subagent` 只差一个 s，易混（§10 记录 5）。页面标签仍叫「子代理 / Subagents」。
- **阶梯**（`src/protocol/ui.ts` 新增）：`DELEGATE_GUIDANCE = ['off', 'on', 'enhanced', 'force'] as const`（字符串阶梯，同纪律：浏览器只出四档、宿主只收四档，`validateDelegateGuidance` 非法回 `bad_payload`）；`DELEGATE_TIMEOUT_MS = [60000, 300000, 600000, 900000, 1800000, 3600000]`；`DELEGATE_OUTPUT_CHARS = [4000, 8000, 20000, 50000, 100000, 200000]`。**部署验证范围宽于阶梯是既有显式设计**（`idleRelease` precedent，仅数值键）：部署写 off-ladder 值照原值运行，设置页写入只收阶梯值（`validateDelegateMs` / `validateDelegateOutputChars`，非法回 `bad_payload`），重启读盘按阶梯过滤，卡片显示精确数字、滑块停最近档（§5.2）。

### §5.2 设置页：新「子代理」页

**导航项**：设置页顶部分类里多一个「子代理」（Subagents），与「进程管理」「审批时限」同样**按快照字段门控**——`ui.delegate` 缺席（旧宿主半区没有这个 RPC）时，整页连同导航项都不渲染（`panel.tsx` 现有写法是 `ui.idleRelease !== undefined`），绝不显示浏览器自己编的数。

**页面内容**（四行控件 + 每行自己的覆盖状态）：

| 行 | 控件 | 文案（一行，约束 33） | 取值 |
|---|---|---|---|
| 子代理委派 | 四档滑块（关闭 / 开启 / 引导增强 / 强制模式） | 关闭 = 不注册本工具；其余档位决定引导强度，下一轮对话生效。 | off / on / enhanced / force |
| 权限 | 三档互斥按钮（`dwa-seg`） | 委派期间的审批请求如何作答。 | 自动代答 / 直接拒绝 / 人工确认 |
| 单次时限 | 滑块（共享阶梯 `DELEGATE_TIMEOUT_MS`） | 超时后中止子代理并报错。 | 1 分钟 … 1 小时 |
| 返回上限 | 滑块（共享阶梯 `DELEGATE_OUTPUT_CHARS`） | 超出部分截断并留标记。 | 4 千 … 20 万字符 |

- **阶梯共享**（`src/protocol/ui.ts`）：浏览器只出阶梯上的值、宿主只收阶梯上的值——与 `IDLE_RELEASE_MS` 同一条纪律（三处强制：RPC 写入 validate、重启读盘过滤、滑块只取阶梯），滑块能出的值一定是宿主会跑的值。引导四档（`DELEGATE_GUIDANCE`）同纪律。
- **off-ladder 显示规则**（照 `IdleReleaseCard` 的写法，仅数值滑块）：部署写的值不在阶梯上时**照原值运行**，读数打印精确数字、滑块停在最近档——卡片不许谎报正在生效的数。
- **引导滑块写「实时」**：即时 RPC（不进 `agent/save` 表单），乐观更新 + 失败回滚 + 采纳宿主回值一律由 store 做（仿 `setSkillsMcp`）；写入触发 `sync()`——off 摘除工具，on/enhanced/force 重注册对账描述，force 另对账 per-agent 掩码（§5.3 / §5.4）。在飞委派不受影响。
- **按档说明**（生效值时常驻，按档警告 precedent 见审批时限 auto 档的「请谨慎选择」）：`enhanced` → 滑块下方一行 **warning 色**说明（宿主 `state-warning-primary` 前景 / `state-warning-tertiary` 底，约束 34，严禁写死黄色；覆盖事实的警告色同款）：「该档位会增强工具描述，引导大模型优先使用本工具。」`force` → 一行 **danger 色**警告（`state-danger-primary` / `state-danger-tertiary`）：「强制模式会屏蔽 DSH 的原生 subagent 能力，请谨慎开启。」`off` / `on` 无说明。遮哪些工具、保留什么进 `AGENTS/`，不进 UI（约束 33）。
- **权限三档是「委派自己的策略」**，不是主会话的审批策略：它住在新「子代理」页，由 §4.2 的会话级接缝支撑，不动 `ui/approval-deadlines` 那一套，也不给对话面板加任何开关。（约束 14 的「设置页没有权限策略开关」管的是审批管线；这里是委派自己的一个选项，两者不共享状态，谁也改不了谁。）
- 一个控件一行字（约束 33），机制解释留在代码注释与 `AGENTS/`。

**页面为什么单独一页**：和「技能」页同理——智能体页管的是一个个 agent，而这四个键是**一个部署级能力**的参数，不是某个 agent 的属性。

### §5.3 热开关：注册 / 摘除要真的动到请求头

引导档不是只读设置：`off` 决定 `acp_delegate` 在不在 `ctx.tools` 里，也就决定原生请求头里有没有这个工具定义；`force` 另决定原生委派工具在不在各 agent 的可见集里。

- 新增 `src/bridge/delegate-registration.ts` · `AcpDelegateRegistration`：`sync()` 读当前生效值——`off` → 调 disposer 摘除工具 + 撤销所有 force 掩码；`on` / `enhanced` / `force` → 需要就 `tools.register(acpDelegateToolDefinition(生效值))`（描述按档组合、预算烘焙）并把返回值（**disposer**）存下；`force` 另经 `AcpDelegateForceMask` 对账 per-agent 遮蔽（§5.4）。再 `sync()` 幂等。**`timeoutMs` / `guidance` 变更都要重新注册**——预算与描述都烘焙进定义（宿主 timeout-policy 在执行期读定义的 `timeoutMs`；描述经 `schemas()` 下发），不重注册新值进不了请求头；所以任何 delegate 写入后 `sync()` 都对账定义与掩码，不只是 guidance。
- 探针：`ctx.get('tools')` 存在且 `typeof register === 'function'`（沿用 `acp-guard.mjs · reserveVirtualTool` 的探测方式，它还要求 `typeof get === 'function'`）；服务迟到经 `ctx.inject(['tools'])` 重试（guard 同款接缝）；register 抛错（形状校验 TypeError）catch 住并报 `toolAvailable: false` + 原因。force 另探 `ctx.agents`（`list` / `get`）与 `tools.restrict` 可用性，不可用报 `restrictAvailable: false`（§5.4 降级）。**当前宿主 register 返回 disposer 已核实**（`dsh-tools · ToolsService.register` → `layers.effect`）；若旧宿主不返回 disposer：降级成「工具常驻注册 + `execute` 读活配置，off 就回一句 `acp_delegate is disabled`」——开关仍然生效，只是请求头里的那一行要等宿主重启才消失；降级必须写进代码注释与 README，不能让设置卡假装请求头已经干净。
- **HMR / 卸载无需手动防漏**：disposer 本质是调用方 ctx 的 Cordis effect，插件卸载 / 热重载自动 teardown；按仓约定把注册生命周期包进 `ctx.effect`，手调 disposer 幂等（只撤本次插入）。force 掩码的 effect 由被作用 agent ctx 的 fiber 持有，agent 卸载自动解除；插件侧另存 disposer 表供热关断（§5.4）。
- 写入路径：`ui/delegate-set` → `SettingsService` 落盘 → 回调 `registration.sync()`。**生效时机是现有会话的下一个 step（下一轮消息），无需新会话、无需重启宿主**：宿主每 step 重新 `tools.resolve` 并组装请求头（`dsh-agent-loop`），清单 diff 自动给模型补 `tool-addition` / `tool-removal` 提示（活会话补记 tool-addition 见 architecture.md §5）。**在飞的那一次委派不受影响**（宿主没有 abort-on-dispose 路径），在飞 step 用冻结的 ResolvedToolSet；force 掩码同样下一 step 生效，不掐断在飞批次。
- 页面在滑块旁只报事实：`toolAvailable: false` → 「宿主未提供工具服务，此开关暂不生效」；`restrictAvailable: false` 且 guidance=force → 「宿主未提供工具遮蔽服务，强制模式暂按引导增强生效」。`ui/delegate` 响应显式带 `toolAvailable` 与 `restrictAvailable`。

### §5.4 强制档：per-agent 遮蔽（机制已按宿主核实）

**没有全局 deny**：`tools.restrict(filter: {allow?, deny?})` 要求 scoped ctx（全局层调用直接抛错：「a context-global restriction would mask every agent」），deny 只能遮该 scope 视角下 global / 祖先层的工具名（`restrictableNames`），本层自注册名豁免、未知名注册时就抛错；返回精确 disposer（`ScopedLayers.effect`），触发 `tools/change`。原生委派工具是 preset delegation 行挂的（standard preset 的 delegation 组：`subagent` / `subagent_fork` / `workflow`；Web 面 host-plane 行已 disabled，「Presets select the delegation tools visible to each Agent」），从 agent scope 看是祖先层名字、可遮；NTR preset 不挂 delegation 行，这三个名字根本不存在。

**接缝**：全局插件经 `ctx.agents.get(sessionId).ctx` 拿到 agent-scoped ctx，`agent.ctx.tools.restrict({deny})` 写入该 agent 的 scope 层（Cordis 服务代理把 `.ctx` 重绑到使用点；宿主 `dsh-subagent · applyChildOverrides` 用 `childCtx.tools.restrict(composition.toolFilter)` 是同款先例）。新增 `src/bridge/delegate-force-mask.ts` · `AcpDelegateForceMask`（DI，不 import manager）：

1. guidance 进入 force：遍历 `ctx.agents.list()` 活 agent，按各 agent 视角的 `restrictableNames` 与默认名单 `{subagent, subagent_fork, workflow}` 求**交集**——交集空（NTR 会话）跳过，非空才 `restrict({deny: 交集})`，存 per-agent disposer。名单按活清单生成，绝不硬写（硬写 NTR 会抛 unknown tool）。
2. 订阅宿主 agent 生命周期事件（确切事件名实现前按宿主版本核一次）：新活 agent 出现即按同一交集规则施加 / 跳过；agent 卸载其 effect 自动解除，disposer 表按事件清理。preset 切换随旧 agent ctx 卸载 / 新 agent 出现自然重算。
3. guidance 离开 force：调所有存下的 disposer，掩码全撤。
4. 生效时机：下一个 step 的请求头组装（在飞批次用冻结的 ResolvedToolSet，不掐断）；宿主自动给模型补一条 `tool-removal` developer 消息。

**名单取舍**：只遮 `subagent` / `subagent_fork` / `workflow` 三个派工工具（`subagent_fork` 是 `dsh-tool-subagent` 的第二实例，`workflow` 是 `dsh-tool-workflow`、引擎内部经 `ctx.subagents` 派工——不遮就留着一条绕开 `acp_delegate` 的路）。控制面（`list_agents` / `send_message` / `wait_agent`）**保留**——遮它们会连带砍掉对已有子代理的观测与续聊；deny 只影响模型可见性与执行准入，不碰 `ctx.subagents` 服务运行时。`team_task_*` 是共享任务板、不派工，不在名单；`run_code` 是保留名，deny 会抛错，不碰。

**两个已知 asymmetry，写进文档**：① `subagent` / `subagent_fork` 的系统提示段落自带可见性门控（`ctx.tools.get(...) === tool`），被遮后自动消失；**`workflow` 的段落无门控**，被遮后「Use the workflow tool ONLY when…」仍留在系统提示里（悬空指引）——本期接受（工具不在清单里，模型调不到，段落只是噪音），若宿主后续提供 section 剥离接缝再补。② 名单按默认工具名 + 活清单交集；部署改了 delegation 行的 `toolName` 配置会漏遮——实现前核一次部署名单，风险登记 §8。

**降级**：`ctx.agents` 或 `tools.restrict` 不可用（旧宿主）→ force 按 enhanced 生效（描述照写、不遮），`ui/delegate` 报 `restrictAvailable: false`，设置页如实说明（§5.3）。per-agent restrict 抛错（名单漂移等）catch 住、广播一条 `agent/notice`、继续其余 agent，不崩插件。

## §6 改动清单（预估行数）

**宿主半**

| 文件 | 改动 | 预算 |
|---|---|---|
| `src/bridge/delegate-service.ts` | **新增**：`AcpDelegateService`、`AcpDelegateHost`、`acpDelegateToolDefinition`（register-ready JSON Schema，描述按 guidance 组合）、增量折叠、per-agent 串行、权限计数 | ~420 行 |
| `src/bridge/delegate-registration.ts` | **新增**：`AcpDelegateRegistration`（`sync()` 注册 / 摘除 / 预算与描述对账 / 掩码对账、工具服务探针 + inject 迟到重试、register 抛错处理、降级） | ~160 行 |
| `src/bridge/delegate-force-mask.ts` | **新增**：`AcpDelegateForceMask`（per-agent 交集 deny、agent 生命周期跟随、disposer 表、restrict 探针与降级，§5.4） | ~130 行 |
| `src/protocol/agent-def.ts` | 新增 `AcpDelegateConfig` 类型（四键，`guidance` 字面量联合）+ `AcpPluginConfig.delegate?` | +30 行 |
| `src/protocol/ui.ts` | `AcpDelegateSettings`（`guidance` + `configured` 覆盖事实 + `toolAvailable` + `restrictAvailable`）+ `DELEGATE_GUIDANCE` 四档 + 两条共享阶梯 `DELEGATE_TIMEOUT_MS` / `DELEGATE_OUTPUT_CHARS` + 内置默认 | +62 行 |
| `src/impl/validate.ts` | `validateDelegateConfig` / `validateDelegateSettings` + `validateDelegateGuidance` + 阶梯校验函数 + 返回值加 `delegate` | +78 行 |
| `src/impl/dispatch.ts` | `ui/delegate` / `ui/delegate-set` 两个 case + `AcpManager` 可选成员 | +35 行 |
| `src/bridge/settings-service.ts` | `delegateSettings()` / `setDelegateSettings()` / `setConfiguredDelegate()` / 启动时 `applyDelegateTuning()`（仿 `idleRelease` 三条） | +115 行 |
| `src/bridge/persistence-service.ts` | `delegate` 键读写（仿 `idleRelease`） | +12 行 |
| `src/bridge/live-session.ts` | `permissionPolicy?` 字段 + 注释（**未锁**） | +5 行 |
| `src/bridge/bridge-rpc-service.ts` | `setPermissionPolicy`（查 session、写字段；**未锁**） | +8 行 |
| `src/bridge/agent-bridge.ts` | `handlePermissionRequest` 两行 mode/窗口读取**原地改写**为 `session.permissionPolicy ?? bridge 字段`。**该文件锁在基线 2209 行**，原地改写净 0，不加行 | 净 0 |
| `src/bridge/manager.ts` | 薄委托（`delegateSettings` / `setDelegateSettings` / `setConfiguredDelegate` / `setPermissionPolicy`）+ 启动序列 `applyDelegateTuning`。**该文件锁在基线 1903 行（只许缩不许长）**，这组改动必须**净增 ≤ 0**：约 6 行新代码，靠压缩同文件既有 JSDoc 腾出同样多的行（仿 [dsh-skills-mcp.md](./dsh-skills-mcp.md) 的「净增长 ≤ 0」口径） | 净 0 |
| `src/index.ts` | 构造 `AcpDelegateService` + `AcpDelegateRegistration` + `AcpDelegateForceMask`，`config.delegate` 交给 `setConfiguredDelegate`，注册生命周期包 `ctx.effect`，设置写入后 `registration.sync()`；**不动** `inject` 顶层数组 | +85 行 |
| `src/bridge.ts` | 再导出 `AcpDelegateService` / `AcpDelegateRegistration` / `AcpDelegateForceMask` / `acpDelegateToolDefinition` | +5 行 |

**浏览器半**

| 文件 | 改动 | 预算 |
|---|---|---|
| `src/client/panel/subagent-card.tsx` | **新增**：`SubagentCard`（四档引导滑块兼注册开关 + 引导增强 warning / 强制模式 danger 按档说明 + 三档权限 + 两根阶梯滑块 + off-ladder 显示 + 每行覆盖真相 / 重置） | ~250 行 |
| `src/client/panel.tsx` | 导航项 + `page === 'subagents'` 挂载（与「进程管理」同一写法，按 `ui.delegate` 门控） | +12 行 |
| `src/client/store/state.ts` | `UiState.delegate?` | +6 行 |
| `src/client/store.ts` | 启动时并行取 `ui/delegate`（缺字段 = 旧宿主半区，卡片不渲染）。**该文件剩 5 行余量（1592 / 基线 1597）**：只加 `Promise.all` 里的一行 + `mutate` 对象里的一行，超出就压缩既有行 | ≤ +5 行 |
| `src/client/store/settings.ts` | `setDelegateSettings(patch)` / `resetDelegateSetting(key)`（乐观更新 + 失败回滚 + 采纳宿主回值，仿 `setSkillsMcp`） | +65 行 |

**测试与文档**

| 文件 | 改动 | 预算 |
|---|---|---|
| `tests/delegate.spec.ts` | **新增**：见 §7 | ~340 行 |
| `tests/bridge/delegate-settings.spec.ts` | **新增**：覆盖 / 基线 / 重置 / 落盘 / 热注册 / 预算与描述对账 / 迟到服务 / restrict 降级 | ~140 行 |
| `tests/bridge/delegate-force.spec.ts` | **新增**：per-agent 交集 deny、NTR 跳过、新 agent 跟随、离开 force 全撤、在飞批次不掐断、名单漂移 notice（§5.4） | ~110 行 |
| `tests/bridge/delegate-permission.spec.ts` | **新增**：会话级接缝——主 bridge auto+0 / abort 不抢占委派三档 | ~90 行 |
| `tests/impl/dispatch.spec.ts` | 两个新 case（仿 `ui/idle-release` 那组） | +30 行 |
| `tests/panel/subagent-card.spec.ts` | **新增**（按 `tests/panel/` 簇镜像约定）：引导滑块乐观更新 / 回滚、引导增强黄字 / 强制模式红字渲染、三档权限、off-ladder 显示、覆盖 / 重置 | ~110 行 |
| `tests/store/settings.spec.ts` | delegate 写入乐观更新 / 回滚（precedent 在此与 `tests/skills-mcp-store.spec.ts`，**不在** `editing.spec.ts`——那里的空闲释放用例是 per-agent 表字段） | +30 行 |
| `AGENTS.md` | 新增 1 条硬约束（一次性委派不是子会话；会话级权限接缝三档默认 auto；delegate 四键两层热生效；引导档兼注册开关，on 基础描述、enhanced 增强描述（黄字），force 经 per-agent `tools.restrict` 遮 subagent/subagent_fork/workflow（红字）、restrict 不可用降级 enhanced 并如实上报；timeoutMs/guidance 变更重注册；增量折叠；不双写子代理面板）。**文件恰好 150 行触顶**：同提交外置等量旧内容到 `AGENTS/` 并登记索引（纪律 2），净增 ≤ 0 | 净 0 |
| `AGENTS/architecture.md` | §5 补一段「宿主工具→agent 委派」与既有 MCP 边界（「宿主 MCP 不经此路」）方向不同 | +10 行 |
| `AGENTS/ui-panel.md` | 设置页登记表补一行：新「子代理」页与四个控件（引导四档滑块 + 引导增强 warning / 强制模式 danger 按档说明 + 阶梯、off-ladder 与覆盖规则） | +16 行 |
| `AGENTS/protocol.md` | `ui/delegate` / `ui/delegate-set` 两层取值说明 | +10 行 |
| `AGENTS/state.md` | `agents.json` 的 `delegate` 键与启动顺序 `applyDelegateTuning` | +2 行 |
| `AGENTS/permissions.md` | **新增登记**（文档纪律 3：动了它描述的代码）：会话级策略接缝、委派三档映射、计数来源、`allow_always` 跨会话风险与 per-agent 核查结论 | +18 行 |
| `presets/acp/acp.patch.yml` | 注释补一句全局层工具会进请求头、但到不了对端 agent | +3 行 |
| `cordis.patch.yml` | `delegate` 四个键的注释与默认值（guidance 四档） | +20 行 |
| `README.md` / `README.en.md` | 一句能力说明 + 设置页指向 + 本文链接 | +2 行 ×2 |

**行数门禁**（`npm run check:size`，基线 [file-size-baseline.json](../../scripts/file-size-baseline.json)）：

- 新文件（`delegate-service.ts` / `delegate-registration.ts` / `delegate-force-mask.ts` / `subagent-card.tsx` / 各 spec）都远低于 1000 行。
- **三个已锁文件不许长**：`src/bridge/manager.ts`（基线 1903，现 1903）净增 0（JSDoc 压缩）；`src/bridge/agent-bridge.ts`（基线 2209，现 2209）净增 0（两行原地改写）；`src/client/store.ts`（基线 1597，现 1592）只能用掉剩下的 5 行余量。其余被改文件未进基线，最大的是 `src/impl/dispatch.ts`（768 → 约 803）与 `src/bridge/settings-service.ts`（679 → 约 794），仍在 1000 以内。
- 收尾按禁区条款报告行数与增长原因。

## §7 验证计划

1. `npx vitest run tests/delegate.spec.ts`（新增用例）：
   - 正常一次委派：建会话 → 设策略 → prompt 文本 == task → turn/end（按 sessionId）→ 增量折叠文本 → `closeSession` 被调用一次；
   - `permissionMode: 'auto'`：策略 `{auto, 0}`，bridge 代答，服务按 `permission/expired` 计数；`'abort'`：帧到达即 `respondPermission(requestId, undefined)`；`'ask'`：策略 `{wait, 0}`，不代答；
   - 未知 agent id：报错且**没有**建会话，错误文案含已配置 id；
   - 超时：不广播 turn/end → 工具抛错且 `cancel` + `closeSession` 都被调用，等待自结算（close 不补发 turn/end）；
   - `exec.signal` abort：离队 / 中断、cancel + close、及时 settle；
   - 看门狗收口：`turnId: ''` + error-only 的 turn/end → footer 带 error，不挂死；
   - 长文本：>600 条 update 的回合，早期 `agent_message_chunk` 不丢（增量累积）；`parentToolCallId` chunk 被跳过；超 `maxOutputChars` 截断留标记；
   - 并发：同非 A1 agent 第二个委派排队（不报错），不同 agent 并行；排队期间宿主预算到点 → signal 离队；
   - `cwd` 越界：`cwd_denied` 原样传回模型；
   - `agent` 省略 → 用 `defaultAgent()`；无默认且有多个 → 报错要求指定；
   - 工具定义形状：register-ready JSON Schema（`parameters.required == ['task']`）、`output.render` 存在、`name === 'acp_delegate'`、`execute` 返回 `text` 带尾注；
   - 引导四档：`off` → 不注册（`tools.get` 缺席）；`on` → 基础描述（无引导句）；`enhanced` → 含「必须使用本工具」句；`force` → 描述同 enhanced 且掩码施加；档位切换 → 重注册。
2. `tests/bridge/delegate-settings.spec.ts`（新增）：
   - 设置页写入后 `delegateSettings()` 报新值，而 `configured` 仍报部署基线；
   - 重置回到部署基线（部署写了就回部署值，没写就回内置默认）；
   - 落盘重建后仍生效（仿 `tests/bridge/idle-release.spec.ts` 的 restart 用例）；
   - `setDelegateSettings({ guidance })` 真的触发 `sync()`：off → disposer 被调一次，on/enhanced/force → `register` 被调一次，重复同名调用幂等；
   - `timeoutMs` / `guidance` 变更 → 重新注册（新预算 / 新描述进定义）+ force 掩码对账；
   - tools 服务迟到 → `ctx.inject(['tools'])` 补注册；register 抛错 → `toolAvailable: false`；restrict 不可用 → force 降级 enhanced + `restrictAvailable: false`。
3. `tests/bridge/delegate-force.spec.ts`（新增）：
   - 活 agent 交集 deny：standard 视角三名字全遮；NTR agent 交集空跳过、不抛错；
   - 新活 agent 出现自动施加；agent 卸载 disposer 表清理；preset 切换自然重算；
   - 离开 force 全撤（disposer 逐个调用）；在飞批次不掐断（下一 step 生效）；
   - 名单漂移 restrict 抛错 → `agent/notice` + 继续其余 agent。
4. `tests/bridge/delegate-permission.spec.ts`（新增）：
   - 主 bridge 配 `auto + 0`：主会话询问到达即代答；委派会话 `abort` 档仍拒绝、`ask` 档仍等人（会话策略不被 bridge 抢占）；
   - 主 bridge 配 `abort` 带窗口：委派 `ask` 档的人工等待不被定时器收口；
   - 委派策略不写 bridge 字段：主会话审批档位前后一致。
5. `tests/impl/dispatch.spec.ts` 两个新 case：`ui/delegate` 旧宿主回 `undefined`；`ui/delegate-set` 逐字段校验（非法 `guidance` 值 / 非法 `permissionMode` / 非阶梯值 / 越界数字 → `bad_payload`）。
6. `npm run typecheck`（配置类型扩展会牵动 `AcpPluginConfig` 的全部消费点）。
7. `npm run check:size`。
8. 手测（不在 CI）：
   - 设置页「子代理」页：不写 `cordis.patch.yml` 时也同样可见、滑块在关闭；滑到开启后**现有**原生会话下一轮请求头里出现 `acp_delegate`（不重启宿主、不新建会话），滑到关闭后下一轮又没了；引导增强描述更新、黄字说明可见；强制模式红字警告常驻、原生会话请求头里 `subagent` / `subagent_fork` / `workflow` 下一 step 消失、NTR 会话不受影响；改权限档 / 时限 / 上限一个不重启（时限改后新调用用新预算）。
   - `dsh --profile headless "用 acp_delegate 让 <agentId> 统计仓库里 TODO 的条数"` —— 确认原生模型能选到工具、子进程真起了、答复落回对话。
   - 共用 bridge 场景：主会话配 auto+0，委派 abort 档跑一次——确认拒绝生效、主会话审批不变。
   - 再跑一遍 NTR 会话，确认主链路零变化（含 force 档下）。

## §8 风险与回滚

| 风险 | 影响 | 处置 |
|---|---|---|
| 工具 schema 形状 | 注册成功但参数校验失败 | **已消除**：§3 用 register-ready JSON Schema，按宿主 register 校验核实（output.render 必填、parameters 已编译）；defineTool 路径放弃（DSL 不兼容 + 新依赖） |
| 旧宿主 `tools.register` 不返回 disposer | 关掉开关，请求头那一行要等重启才消失 | 当前宿主已核实返回 disposer；旧宿主降级执行期拦截，**代码注释与 README 写明**（§5.3） |
| 原生模型滥用（把本该自己做的小事丢出去） | 多花一次进程启动 + token；引导档越高越放大（force 遮掉原生选项） | description 明确「自成一体的任务」；引导默认 off；设置页滑块一键滑到关闭（§5.3 热摘除） |
| 引导增强是软约束 | 模型仍可能选原生子代理工具 | 描述 MUST 措辞与原生收益型论证竞争；要硬保证滑到强制模式（§5.4） |
| force 名单漂移 / 悬空指引 | 部署改 `toolName` 会漏遮；workflow 系统提示段落无门控，被遮后悬空 | 名单按默认名 + 活清单交集，实现前核部署名单；悬空段落本期接受（工具不在清单、调不到），后续有 section 剥离接缝再补（§5.4） |
| force 的 per-agent 挂载遗漏 | 新活 agent 没遮上 | 进入 force 全量遍历 + 生命周期事件跟随；事件名实现前核实；restrict 抛错 notice + 继续（§5.4） |
| 子代理长期无答复 | 工具挂到 timeoutMs | 内部时限（prompt 起算）先触发 → cancel → close（5s race 封顶）→ throw；看门狗双保险；execute 必须 observe `exec.signal` 并 settle——协作式超时不杀 promise，不 settle 宿主一直等 |
| 共用 bridge 权限抢占 | 主会话 auto+0 / abort 违反委派三档 | 会话级策略接缝（§4.2），两行原地改写、净 0；bridge 字段不碰 |
| 环形缓冲丢文本 | 长任务答复残缺 | hub `session/update` 增量累积（§4 步骤 5），transcript 仅兜底 |
| agent 侧并发不支持 | 共用进程两条 prompt 互相干扰 | per-agentId 串行队列（防御性，§4.4）；主聊天与委派的并发 agent 依赖，写进文档 |
| cwd 越界 | 模型传原生工作区被拒 | `cwd_denied` 文案带 agent id；description 写明 roots 白名单；不放宽围栏（§3） |
| `allow_always` 跨会话 | 非 A1 共用进程间接放宽主会话审批 | 实现前 per-agent 核作用域；必要时非 A1 改 `allow_once` 优先；写进 permissions.md（§4.2） |
| 排队吃预算 | 后一个委派在队列里超时 | 内部时限 prompt 起算；宿主预算到点 signal 离队抛错，模型可重试（§4.4） |
| 错误地共享/关闭主会话 | 主链路回归 | scope 恒为 `ephemeral`（A1）/ 裸 agent key（非 A1），只关自己那一个 `sessionId`；RPC close 对已删除 id 抛 `unknown_session`，服务层吞；close 不补发 turn/end，等待自结算 |
| 回滚 | — | 删新增模块 + 注册那一段 + 配置键即可；接缝两行可原地还原；force 掩码随 disposer 全撤；既有文件只有 additive 改动 |

## §9 分阶段

- **阶段 1（本方案）**：`acp_delegate` 工具 + 会话级权限接缝三档 + 串行 + 增量折叠 + 截断 + 引导四档（force 经 per-agent restrict 遮原生委派工具）+ 设置页「子代理」页（四键、两层取值、热注册）+ 文档。
- **阶段 2（可选，待看阶段 1 观感）**：子代理面板行（外部 catalog + `subagents/record` 六态），`childId = acp-delegate:<toolCallId>`，明细读子会话 transcript。
- **阶段 3（可选）**：把 `acp_delegate` 的会话做成可续（同一 `agent` + 同一 `cwd` 复用），让模型能对子代理追问；前提是宿主工具契约能表达「句柄」。

## §10 拍板记录

1. ~~**权限默认档**~~ → **已定：`auto`**。理由见 §4.2：子会话没有 `dshSessionId`，对话里的审批卡不出现，`ask` 实际是挂到超时；频繁索取权限打断发起方，违背「委派 = 交给它办完」。`abort` / `ask` 保留为可选档。三档由**会话级策略接缝**支撑（记录 6），在任何 bridge 配置下成立；auto 走 bridge 现有 auto+0 路径，计数听 `permission/expired`。
2. ~~**注册默认**~~ → **已定：`guidance: off`**。默认不注册，任何部署的请求头零变化（连 `preset-acp` 那份也不多一行）；要用的在设置页「子代理」滑到开启及以上，或在 `cordis.patch.yml` 写 `delegate.guidance: on`（两者同一套两层取值）。
3. ~~**是否要阶段 2 的面板行**~~ → **已定：本阶段不做**。先把阶段 1 做出来看原生效果：委派只在原生对话的 `acp_delegate` 工具卡上可见（task / agent / 返回文本），子代理面板不动。看完实际观感再决定要不要补一行 `acp-delegate:<toolCallId>`；那份成本已在 §4.3 / §9 写好，随时可以接着做。
4. ~~**要不要做前端**~~ → **已定：做，且四个键全在设置页**（§5.2）。新增「子代理」页：引导四档滑块（兼注册开关）/ 权限三档 / 单次时限 / 返回上限，两层取值（部署基线 + 设置页覆盖）+ 重置，全部热生效；`guidance: off` 摘除工具，其余档注册；`timeoutMs` / `guidance` 变更触发重注册与 force 掩码对账（§5.3）。生效时机 = 现有会话下一 step，无需新会话（宿主每 step 重组请求头 + 清单 diff 提示）；滑块行文案写明「下一轮对话生效」。
5. **键族命名 `delegate`**（审查后新增）：`agents.json` 已有 `subagents`（复数，worker 记录）、RPC 已有 `subagents/record`，单数 `subagent` 易混。配置键 / RPC / 类型 / 阶梯常量统一 `delegate` 前缀；页面标签仍「子代理 / Subagents」。
6. **权限走会话级接缝**（审查后新增）：`LiveSession.permissionPolicy?`，`handlePermissionRequest` 两行读取原地改写为 `session ?? bridge`（agent-bridge.ts 净 0）。委派三档映射 `{auto, 0}` / `{abort, 30000}` / `{wait, 0}`；bridge 字段不碰，主会话审批一字不改。否定「只靠服务层代答」：bridge auto+0 不发帧，服务层拦不到。
7. **工具契约走 register-ready JSON Schema**（审查后新增）：零新依赖，acp-guard precedent 已验证。否定 defineTool 路径：output DSL 不兼容（object 需显式 additionalProperties、无 required 关键字）且要加 `@deepseek-ai/dsh-tools` 依赖。
8. **答复折叠走 hub 增量累积**（审查后新增）：环形缓冲默认 600 条会淘汰 `agent_message_chunk`，turn/end 后一次读 transcript 丢早期文本。订阅 `session/update` 累积、seq 去重；turn/end 按 sessionId 匹配（看门狗 `turnId` 可能为 `''`、error-only）。
9. **引导四档滑块，合并注册开关**（用户增补，三轮迭代）：UI 标签 **关闭 / 开启 / 引导增强 / 强制模式**，内部值 `off | on | enhanced | force`。`off` = 不注册工具（原 `enabled` 键取消，同一真相不双写，约束 17）；`on` = 注册基础描述；`enhanced` = 追加 MUST 句「需要派发子代理时，必须使用本工具，优先于任何原生子代理/委派工具」（软约束），滑到该档出**黄字**「该档位会增强工具描述，引导大模型优先使用本工具。」（warning token，约束 34）；`force` = 增强描述 + 真遮原生工具（记录 10），出**红字**「强制模式会屏蔽 DSH 的原生 subagent 能力，请谨慎开启。」（danger token）。按档说明生效值时常驻，precedent 见审批时限 auto 档警告。工具描述是模型可见契约字段（`schemas()` 下发 name/description/parameters，已核实），无需提示词注入。
10. **强制档经 per-agent `tools.restrict`**（宿主核实后定）：没有全局 deny（restrict 要求 scoped ctx，全局调用抛错）；经 `ctx.agents.get(id).ctx.tools.restrict({deny})` 逐 agent 施加（`applyChildOverrides` 先例），名单 = 默认 `{subagent, subagent_fork, workflow}` ∩ 该 agent `restrictableNames`（NTR 交集空自然跳过），生命周期事件跟随，离开 force 全撤。控制面工具保留（观测/续聊不砍）；deny 不碰服务运行时。workflow 系统提示段落无门控、被遮后悬空——本期接受并登记。restrict 不可用降级 enhanced + `restrictAvailable: false` 如实上报。

## §11 实现进展与限制（阶段 1 定稿）

> 本节记录阶段 1 落地结果，供阶段 2/3 与后续维护接手。代码位置用「文件 + 符号名」引用（不写行号）。

### §11.1 提交与验证

- 提交 `7fdb029` `feat(acp): add acp_delegate tool to delegate tasks to configured ACP agents`（43 文件，+3746/-67，10 新文件）。前缀按仓库惯例：feature 为主、AGENTS/ 文档随提交（纪律 3）用 `feat(acp):`；纯文档提交才 `docs(agents):`（历史先例 `09e17ed` / `fe0d4de` 均 feat 且触及 AGENTS.md）。
- `npm run prepack` 四门禁全绿：check:size、typecheck、vitest（105 文件 1721 通过 | 2 既有 skip）、build（CJS 工厂 696kB）。
- 独立双轴审核（Standards + Spec，独立上下文并行）：Standards 无硬违规；Spec 忠实实现、无 scope creep、无实现错误。
- 审核必修项已修并附**变异验证**：收口状态收敛单一 `DelegateSettle` 联合、注册状态收敛 `RegistrationState` 联合（约束 17 / state.md §10）；`AcpDelegatePolicy` 单一权威定义；README 补旧宿主降级说明。变异互换 timed-out/aborted 分支 → 2 例红 → 还原绿；降级拦截条件变异 → 1 例红 → 还原绿。

### §11.2 落地清单

- **委派核心**：`src/bridge/delegate-service.ts`（`AcpDelegateService` / `AcpDelegateHost` / `acpDelegateToolDefinition` / `DelegateSettle`）、`delegate-registration.ts`（`AcpDelegateRegistration` / `RegistrationState` / `excludesNtr`）、`delegate-force-mask.ts`（`AcpDelegateForceMask` / `DELEGATE_FORCE_DENY_CANDIDATES`）。
- **会话级权限接缝**：`live-session.ts · permissionPolicy` + `bridge-rpc-service.ts · setPermissionPolicy` + `agent-bridge.ts · handlePermissionRequest`（两行原地改写）/ `announceExpiredAsk`（preferOnce 透传）+ `impl/permission.ts · pickAutoOption`（第二参）/ `DELEGATE_AUTO_KIND_PRIORITY`。
- **设置层与接线**：`settings-service.ts`（delegateSettings / setDelegateSettings / setConfiguredDelegate / applyDelegateTuning）+ `persistence-service.ts`（delegate 键）+ `manager.ts`（delegate face 薄委托）+ `index.ts`（构造三模块 + `ctx.effect`）。
- **契约层**：`protocol/ui.ts`（delegate 类型 / 阶梯 / 默认 + `AcpDelegatePolicy`）、`protocol/agent-def.ts`（`AcpDelegateConfig` + `AcpPluginConfig.delegate`）、`impl/validate.ts`（validateDelegate*）、`impl/dispatch.ts`（ui/delegate / ui/delegate-set）。
- **浏览器半**：`client/panel/subagent-card.tsx`（`SubagentCard`）+ `panel.tsx` 导航门控 + `store/state.ts · UiState.delegate` + `store.ts` facade/resync + `store/settings.ts`（setDelegateSettings / resetDelegateSetting / writeDelegate）。
- **测试**：`tests/delegate.spec.ts`（33）、`tests/bridge/delegate-force.spec.ts`（6）、`delegate-permission.spec.ts`（5）、`delegate-settings.spec.ts`（7）、`tests/panel/subagent-card.spec.ts`（13）、`tests/store/settings.spec.ts`（+2）、`tests/impl/{validate,dispatch,permission}.spec.ts` 追加。
- **文档**：AGENTS.md 约束 40（权限组 13–15、40）+ AGENTS/{architecture,permissions,protocol,state,ui-panel}.md + cordis.patch.yml + presets/acp/acp.patch.yml + README 双语。

### §11.3 定稿偏离补遗（修订行三处之外）

- **transcript 兜底读移到 close 之前**：`bridge-rpc-service.ts · closeSession` 删记录、transcript 对已删 id 抛 `unknown_session`，close 后读兜底必死（§4 步骤 6 旧顺序修正为 正常结束 → 兜底 → close → 解订阅）。
- **`permission/resolved` 不订阅计数**：到期路径 expired 与 resolved 同发（约束 13），数 resolved 会双计；abort 档数 request 到达（= 自己的答复）；ask 档人工作答不进 footer（§3 尾注未要求）。permissions.md §2.5 登记理由。
- **收口 / 注册状态单一字面量联合**（约束 17）：`DelegateSettle = 'pending' | 'ended' | 'timed-out' | 'aborted' | 'prompt-error'`（`settle` 首写生效，队列 promise / 定时器 / 监听器等排程句柄不压单值，state.md §10 例外）；`RegistrationState = 'off' | 'active' | 'degraded'`（`toolAvailable = state !== 'off'`，degraded 仍 true）。
- **`AcpDelegatePolicy` 唯一权威定义**落 `protocol/ui.ts`，live-session / rpc / manager / delegate-service 四处 import（消除 Data Clump，单一真相）。

### §11.4 已知限制

- **旧宿主降级模式的设置卡旗标缺口**：register 无 disposer 时常驻注册，`toolAvailable` 恒 true，guidance=off 卡片仍显示「关闭 = 不注册本工具」静态文案、无降级旗标——与 §5.3「不能让设置卡假装请求头已经干净」有张力。根因是 §5.3 的 UI 契约只有 toolAvailable / restrictAvailable 两旗标、无降级位（**方案内部缺口**）。当前按契约办事 + README 写明「请求头那一行等宿主重启才消失」；阶段 2 可考虑补一个降级旗标。
- **workflow 系统提示段落悬空**：force 遮 workflow 后其「Use the workflow tool ONLY when…」段落无门控仍残留（§5.4 接受）；subagent / subagent_fork 段落有门控自动消失。宿主若提供 section 剥离接缝再补。
- **force 名单漂移**：deny 名单 = 默认 `{subagent, subagent_fork, workflow}` ∩ 活清单（`tools.get` 可见性近似 restrictableNames）；部署经 `toolName` 改名会漏遮（§8 风险）；scope-local 漂移走 restrict 抛错 → notice → 继续其余 agent。
- **permissions.md 越 200 行**：188 → 205（新增 §2.5），触发单篇 >200 拆分阈值；delegate 同主题触及 5 份 AGENTS/ + AGENTS.md（≥3 篇阈值）。拆分留待后续维护，本任务未扩范围。

### §11.5 行数与门禁事实

- 锁定文件合规：manager.ts **1897**≤1903（净 -6，压缩 6 处 JSDoc）、agent-bridge.ts **2208**≤2209（净 0）、store.ts **1597**=1597（净 +5 触顶，零余量）。AGENTS.md **150**=150（净 0，约束 14 折行合并腾行）。
- 新文件均 ≤1000：delegate-service 404 / delegate-registration 193 / delegate-force-mask 149 / subagent-card 303 / tests/delegate.spec 617。
- 超 500 行存量：settings-service 809 / dispatch 791 / index 704 / validate 645。

### §11.6 后续

- 阶段 2（子代理面板行）/ 阶段 3（可续委派）按 §9 待看阶段 1 观感再定，**未实现**。
- 候选维护项（非本阶段范围）：permissions.md 拆分（>200）、降级旗标（§11.4）、workflow 悬空段落剥离接缝。