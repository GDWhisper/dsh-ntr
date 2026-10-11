# dsh-ntr

DeepSeek Harness (DSH) Web 插件：把浏览器变成一个 **ACP（Agent Client Protocol）客户端**。

**本质是借 DSH 的界面壳，与 ACP agent 对话。DSH 提供的只有显示层，它的模型调用逻辑我们不参与。** 一次对话的归属：推理、工具执行、文件读写、权限决策全部属于**对端 ACP agent**（独立进程，完全自治）；会话身份、消息列表、输入框、侧栏由 DSH 提供；模型选择、思考等级、权限档都是 **agent 自己的概念**，不是 DSH 的模型目录。

宿主侧按服务端配置拉起任意 ACP agent 子进程（stdio JSON-RPC v1），事件经 SSE 推送到网页；浏览器可开启多会话、流式交互消息/思考过程/工具调用/计划、人工审批权限请求、切换 agent 自己的 mode 与配置选项。

## 功能特性

- **多 Agent 进程管理**：支持按需启动、停用已配置的 ACP 代理子进程。
- **透明连接表单（预设 + 自定义）**：设置面板每张 agent 卡片直接展示完整 ACP 连接命令（显示名 / 启动命令 / npm 包名 / 环境变量 / 权限 / 工作目录），不对用户隐藏——预设 agent 提供一键填入的官方测试默认命令，任何 agent 都可改成自定义值；「测试」按钮用当前表单值在宿主侧拉起一次性进程完成 ACP 握手（不落盘、不注册），成功显示 agent 身份与耗时、失败显示可操作错误与 stderr 尾部。启动命令是**一整行**（程序 + 参数，例如 `codebuddy --acp`）：输入框下方实时显示宿主解析出的「程序 / 参数」，含空格的路径用引号包住。
- **Windows 上的 npm agent 可直接用**：npm 全局安装的 agent 在 Windows 上是 `.cmd` 生成壳，Node 20.12+ 禁止在 `shell: false` 下启动它（抛 `EINVAL`）；插件改为经 `cmd.exe /d /s /c` 启动，并在停止/空闲释放时按进程树回收（对齐 POSIX 的进程组语义），不会残留后台 agent 进程。
- **从零新建自定义 Agent**：「从零新建自定义 Agent」入口不依赖任何预设——填 Agent ID（客户端本地校验格式与查重，宿主端二次校验）+ 连接命令即可接入任意 stdio ACP agent；保存后自动进入「已接入」区并带「自定义」徽标，检测层会把自定义条目连同 env / npmPackage 一并回显到表单。
- **npm 包自动安装**：agent 定义可携带 `npmPackage`；宿主在 PATH 中找不到 `command` 时自动执行 `npm install -g`（超时 3 分钟，包名经严格字符集校验、杜绝注入），装完再解析一次命令路径，装不上则回落为原生 spawn 报错。
- **多会话与流式渲染**：支持多会话隔离，流式展示用户消息、Agent 回复、思考过程、工具执行与任务计划。
- **审批就在对话里**：当 Agent 触发敏感工具调用时，宿主把 ACP `session/request_permission` 转发到 DSH 原生审批链（`ctx.approval`），审批卡直接在聊天 composer 里出现。宿主没有审批服务、或会话不归属某个聊天会话时自动降级回设置页权限卡（并支持 `permissionTimeoutMs` 超时自动取消，默认永久等待）。
- **权限完全归 agent，界面只负责接住**：ACP agent 完全自治，**DSH 的 Access mode / `sandboxPolicy` 不参与 ACP 会话的权限裁决**。agent 侧 `session/request_permission` 原样映射到界面上——每个 agent 的权限形态不同（选项列表 / allow-deny / 带 tool call 详情），接住它的载荷、渲染给人、把人的选择按 ACP 协议回包即可。agent 定义里那个 `permission` 字段只是**策略**（要不要问人），不是审批通道；至于审批呈现在哪里（对话 composer 还是设置页）由宿主能力决定，不写死在配置里。（早年的版本曾让 DSH 的 Access mode 替 agent 裁决，并保留一道 `fs/write_text_file` 写栅栏，现已废弃——那个 knob 本身曾是反的：`never`（"完全权限"预设）会在 answerer 之前把所有询问判成拒绝，`read-only` + `ask` 又能被一次"允许一次"写穿。）
- **无感断线重连（双向）**：浏览器↔宿主方向靠每会话环形事件缓存池（Transcript）按序补齐；宿主↔agent 方向靠 `session/load` 会话恢复——agent 进程崩溃后会话进入 released 状态（历史可读、上下文不丢），下次发消息自动 respawn 并回放会话历史（"发送即恢复"），无需人工重建会话。
- **工作区沙箱内的客户端文件能力**：实现 ACP `fs/read_text_file` / `fs/write_text_file`（含 `line`/`limit` 分页、单次 2 MiB 上限、自动创建父目录），所有路径经与 session cwd 相同的 `allowedCwdRoots` 白名单校验，越权访问直接拒绝。
- **空闲释放（只释放“没有会话”的进程，探测进程与聊天进程分档）**：设置面板的「探测模型」、保存后的后台探测、启动时的目录预热都会拉起 agent 进程，而它们**不留任何会话**——这类进程以前会一直常驻。现在空闲释放窗口分两档：**探测拉起的进程**（从未承载过真实会话，探测的 throwaway session 刻意不登记）空闲 5 分钟（`probeIdleTimeoutMs`）即释放，即使 agent 配了 `idleTimeoutMs: 0` 也不例外——那是聊天进程的常驻承诺；**承载过真实会话的进程**按每个 agent 可配的 `idleTimeoutMs`（默认 30 分钟，`0` = 永不释放）常驻。判定统一是：进程 READY 且**没有任何活动会话**（也没有进行中的探测 / 恢复 / 待答审批）时，空闲超过所属档位的时长就**静默释放**（杀掉子进程、状态回落 `stopped`，不发任何提示——这是预期生命周期，不是故障）。有活动会话的 agent **绝不**被释放，所以聊天不会因此多出冷启动；被释放的探测残留也不丢任何东西——已挂起的 released 会话记录原样保留，下次发送照旧走 `session/load` 恢复。
- **可靠性兜底**：agent 启动期请求（`initialize` / `session/new` / `session/load`）受 `startupTimeoutMs` 约束（默认 60s），挂死的 agent 会被杀掉并报可操作错误（含 stderr 尾部）；agent 无视 `session/cancel` 时经 `cancelFallbackMs`（默认 15s）强制定稿 turn——兜底带 **turn 世代守卫**，迟到结算的旧 turn 不会让定时器误杀用户新发的 turn，且强制定稿会同时解开适配器路径的 settle 闸门，会话永不卡死；一部分 agent（实测 codebuddy）异步清理取消状态，会把上一轮的取消错答给紧跟着的下一条消息（秒回 `cancelled`、消息无痕丢失）——`runPrompt` 按「本世代是否发起过取消」识别这种**粘滞取消**并自动重发（`staleCancelRetryDelayMs` / `staleCancelMaxRetries`，默认 600ms / 2 次）；agent 把上游失败折叠成合法 `end_turn` 时（实测 pi-acp），聊天平面不再只剩空气泡——零可见产出的正常结束会带一条显式告警。
- **聊天会话跑在你的工作区里**：对话里起的 ACP 会话，工作目录就是你在这个 DSH 会话里选中的工作区（sidebar 选的那个目录，即会话 header cwd）——对端 agent 的 Read / Glob / Bash 看到的就是它，`session/new` 报回的 cwd 也是它，**agent 进程本身也从那里启动**（有一类 agent 在进程启动时就定死自己的「工作区」，只改 `session/new` 的 cwd 它会照旧回答插件沙箱目录 `~/.dsh/acp-workspaces`；进程只在没有活动会话时才会被搬到该目录，有会话则保持原进程）。agent 卡片里的「工作空间目录」只对 `/acp` 直连会话与宿主未上报工作区的场合生效（面板上已注明）。agent 崩溃后的 `session/load` 恢复同样锚在该目录。
- **工作区白名单可编辑**：设置面板把工作区拆成「单根模式」（一个工作空间目录，留空则用宿主默认 `~/.dsh/acp-workspaces`）与「白名单根目录（高级）」（多根逐条增删）；单根模式保存时会把白名单显式收窄为该目录，绝不静默放宽；非绝对路径就地校验。保存前有「会停止该 Agent 进程并中断进行中的会话」的副作用提示。
- **对话内的 agent 原生模式控件**：agent 自己声明的 mode（`plan`、`acceptEdits` 之类，`session/set_mode` 枚举）会以小控件形式出现在聊天输入框工具行（`conversation.input.left`，就在 DSH 的 Access mode 旁边）——它管“agent 怎么干活”，Access mode 管“会话能碰什么”，两层各管一段；该聊天会话还没跑过 agent（或该 agent 未声明 mode）时控件自动不显示，切模式不重启进程。
- **ACP 模式（agent preset）**：随包提供一份 `acp` agent preset（[presets/acp/acp.patch.yml](file:///home/pax/coding/dsh-ntr/presets/acp/acp.patch.yml)）——它就是这个包自己的 bundle patch（`dsh.bundle.patch`），所以宿主组装 profile 时就把模式声明进 roster，没有任何安装/复制步骤（旧的 `~/.dsh/.agent-presets/<id>` 目录已不再被宿主读取）。在新会话页的模式选择里选「ACP 模式」，该会话就不会再被宿主自己的东西污染：不注入身份/部署 persona、运行上下文快照、AGENTS.md 摘要与技能目录，工具目录为空，plan mode / todo / compaction / 委派全部不挂载——模型可见的表面完全属于对端 agent。该会话的裁决完全交给 agent 自己（它的每次询问都原样出现在对话里的审批卡上），而转发给 agent 的 prompt **严格只有你说的话**，一句边界叙述都没有。
- **转发的只有人说的话**：宿主把上下文段折在用户消息**之后**（运行时快照最后），所以“取最后一条 user 消息”拿到的是注入内容。插件改为按消息来源（`source.kind === 'user'`）挑人真正输入的那条，且**不转发辅助模型调用**（会话标题、compaction 这类带 `purpose` 的请求）——它们不再花掉一轮对端 agent 的 turn，也不再把自己的提示词折进 agent 的上下文。
- **工具卡长在主聊天平面**：`BridgeManager.streamPrompt` 把 ACP 的 `tool_call` / `tool_call_update` 折成宿主 `StreamChunk` 里的 `block-start('tool-call')` + `tool-call-delta` + 带完整快照的 `block-end`。宿主 `AssistantStreamAccumulator` 自己会把它折成 `{ kind: 'tool-call', callId, name, argsRaw }`，官方 chat 包的 tool-call 渲染器画卡片——不需要注册新的 `ConversationNodeDefinition`，不需要写日志，不需要注册新 slot。工具调用不再降级成 `> 🛠️ [Tool: …]` 的思考散文。
- **ACP 会话里接管原生模型底座**：宿主 composer 无条件渲染它的原生模型选择器（`conversation.input.model` 的 `ModelSelect`），那个控件读 DSH 模型目录、点了会写**全局默认模型**。ACP 会话的模型属于对端 agent，所以插件在这个 cell 里装上 ACP 底座本身（`src/client/model-seat.tsx` 的 `createModelSeatClaim`）——一个 cell 一个 occupant，且底座落在原生底座原来的位置（composer bar 行尾、提交键左边）。这个 cell 的归属由客户端 runner 的页面级计数器决定（声明优先级被改写，最后一个注册者赢），所以 claim 还要**核实自己真的赢下了这个 cell**，被别的座位插件（如 thinking-effort 的 slider）抢走时再注册一次夺回——这是纯粹的显示层动作，不写任何模型路由。
- **对话内的 ACP 底座：第一级是选 agent**：聊天输入框**行尾**（`conversation.input.model`，即原生模型底座所在的那个座位）上的 ACP 底座，第一级选**哪个 agent** 服务这条会话；agent 自己的**模型、思考等级**由该底座的多级菜单承担。agent 列表带进程状态、模型列表是 agent 自己上报的目录（并标明它的默认模型）、思考等级来自它的 `thought_level`。**只出现在 ACP 模式的会话里**：注册由 ACP-mode 闸门驱动，非 ACP 会话里这条 entry 根本不存在，原生模型底座原样回来。

  > **历史做法**：早年的设计把 ACP agent 接成一条模型路由 `acp@<agentId>`，"在哪条路由上"读写宿主 per-session 模型目录（与原生选择器共享同一份状态），并用 `priority: -1` 遮蔽原生模型座位。该方向已放弃：写路由会顺手写 DSH 的全局默认模型（一次 ACP 选择就让所有模式的新会话从对端 agent 起步），而宿主的 `session/select-model` 在写入前要过 `modelAvailable` 门禁（GUI 选择要求 provider/model 确切出现在可用目录里）——与"ACP 模型不广告"的隔离策略直接冲突，**实测报错 `session/model-unavailable: Select an available model before sending a message.`** 两边都不可能让步。（注：宿主的 prompt 准入路径并不校验目录成员资格，所以"发消息"从来不是问题，"写路由"才是。）详见 [docs/acp-mode.md](file:///home/pax/coding/dsh-ntr/docs/acp-mode.md) §4/§5 的「历史做法」。
- **ACP 视图 tab**：对话头部的 **ACP** tab 按 agent 的原始流渲染计划清单、unified diff（行级 LCS 对齐 + `+N -M` 统计）与用量读数，并实时跟随 SSE（无需轮询）。已挂起（agent 崩过）的会话在这里标“下一条消息自动恢复”，关闭的会话不提供幽灵历史。该视图只读：它不发消息、不取消、不拉进程。工具卡则长在**主聊天平面**上——adapter 发真正的 tool-call chunk，宿主自己折成工具卡渲染（见下）。
- **无侵入 UI 挂载**：通过 Cordis UI Slots 机制挂载至系统设置页（`settings.section`）、agent 自己的模式控件（`conversation.input.left`）、ACP 底座（`conversation.input.model`，仅 ACP 模式）与其菜单浮层（`conversation.input.overlay`）、对话视图环（`conversation.view`），不接管对话界面本身。
- **ACP 模型目录（座位自己的面）**：把 ACP agent 的 `configOptions`（`category: model` / `thought_level`）折叠成 per-agent 的模型面（`agent/catalog`）——基础条目（agent 默认模型）加 `agent@模型` 变体，思考等级作为 `reasoning` 元数据；每轮请求前自动对齐会话配置，目录经探针获取并持久化到 `~/.dsh/acp-model-catalog.json`。
- **可见模型（勾选式）**：ACP 座位菜单没有搜索功能，而真实 agent 动辄几百个模型（pi 500、omp 581），所以变体是**按需勾选**的——不勾就没有 `agent@模型` 变体条目，只留该 agent 自己的基础条目，永远不会出现列表风暴。勾选带搜索框、全选/取消全选与分批展开，改动立即（防抖）经轻量 RPC 生效，无需重启 agent、不影响进行中的会话，失败就地回滚并红字提示。模型 chip 上的供应商前缀只认 agent 自己返回的 ACP 分组（如 omp acp），不做猜测式推断——跨商供应模型太常见，猜必错。

## 数据流架构

```
浏览器端 (Browser Half: lib/client.js)
  ├─ rpc.call('/acp', endpoint, payload)          一元操作（启动会话、发送 Prompt、读会话 transcript 等）
  ├─ EventSource /api/acp/stream                    事件推送流（状态、消息更新、权限请求）
  ├─ rpc.call('/acp', 'agent/catalog')              per-agent 的 ACP 模型面（底座的模型与思考等级来源）
  └─ rpc.call('/acp', 'model/get-default')          插件自己的默认 agent（新会话默认选谁）
         │
宿主端 (Host Half: lib/index.js → BridgeManager)
  ├─ ctx.connection.rpc.handle('/acp', dispatchRpc)
  ├─ ctx.connection.fetch.register('/api/acp/stream')   SSE 流服务（安全通道）
  ├─ AgentBridge × N                                   子进程代理，多会话复用
  │    └─ @agentclientprotocol/sdk                     stdio JSON-RPC 通信
  ├─ Transcript                                        会话环形事件缓冲
  ├─ PermissionLedger                                  权限审批挂起与确认账本
  └─ EventHub                                          多端事件分发总线
```

## 配置示例

在 Profile 层的 `cordis.patch.yml` 中挂载并配置 agent：

```yaml
- id: dsh-ntr
  name: dsh-ntr
  config:
    agents:
      - id: pi
        title: pi coding agent (ACP)
        # command 是「一整条启动命令行」：程序在前、参数在后，含空格的路径用引号包住。
        # 也可以写成 command: "/path with space/bin/pi-acp" --flag，等价于下面两行分开写。
        command: /path/to/bin/pi-acp
        # args: ["--acp"]
        # 省略 cwd / allowedCwdRoots 时默认使用插件自有工作区 ~/.dsh/acp-workspaces
        # （保存时自动创建；不再从 dsh 宿主进程的启动目录推导）
        cwd: /home/pax/.dsh/acp-workspaces
        allowedCwdRoots:
          - /home/pax/.dsh/acp-workspaces
        # 策略：ask 才征求人类确认；allow / reject 自动作答、不弹审批
        permission: ask
        # PATH 中找不到 command 时自动 npm install -g 的包名（可选；包名受字符集白名单约束）
        # npmPackage: pi-acp
        # 把这些模型 choice 作为 agent@模型 变体提供给对话里的 ACP 座位（按需勾选；不写或空 = 只有基础条目）
        # exposedModels: [claude-sonnet-4, gpt-5]
        # 空闲释放（毫秒）：进程 READY 且没有任何活动会话时，空闲超过该时长就释放进程
        # （0 = 永不释放；不写 = 宿主默认 1800000，即 30 分钟）
        # idleTimeoutMs: 1800000
    transcriptMaxEntries: 600
    # 模型目录自动探针（默认 true）；false 时仅支持手动「检测可用模型」按钮
    # probeModelsOnBoot: true
    # ACP 模式 preset 随本包声明（dsh.bundle.patch → presets/acp/acp.patch.yml），
    # 没有安装开关；设置页只显示宿主 roster 里的状态与诊断。
    # 可靠性兜底（默认值如下）：
    # startupTimeoutMs: 60000      # initialize / session/new / session/load 的超时
    # permissionTimeoutMs: 0       # 审批挂起超时自动取消（0 = 永久等待人工决策）
    # cancelFallbackMs: 15000      # session/cancel 后 agent 无响应的强制定稿时限（0 = 关闭）
    # staleCancelRetryDelayMs: 600 # agent 把上一轮的取消错答给下一轮消息时的重发等待
    # staleCancelMaxRetries: 2     # 上述重发的次数上限
```

## 构建与安装

```bash
# 依赖安装
npm install

# 构建产物（生成宿主端 TS 声明与浏览器端 Bundle）
npm run build

# 运行测试套件
npm test

# 挂载至 DSH Web Profile
dsh plugin --profile web add ./
```

## 文档索引

- [给 AI 编程 Agent 的操作规范与架构约束](./AGENTS.md) —— **先读它的「本插件是什么」一节**，那里说明哪些约束已废弃、哪些目标形态已落地
- [ACP 收敛方向：只借显示层](./docs/acp-convergence.md) —— **代码收敛的唯一权威依据**：三条已证实的宿主事实、目标形态、分批退役清单
- [ACP 模式：把会话交给另一个 agent](./docs/acp-mode.md) —— 设计、实测证据与硬边界（含错误方向的完整记录）
- [DSH 插件开发通用指南（从零起手）](./docs/dsh-plugin-development-guide.md)
- [DSH 官方源码参考与架构索引](./docs/README.md)
