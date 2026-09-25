# dsh-ntr

DeepSeek Harness (DSH) Web 插件：把浏览器变成一个 **ACP（Agent Client Protocol）客户端**。

宿主侧按服务端配置拉起任意 ACP agent 子进程（stdio JSON-RPC v1），事件经 SSE 推送到网页；浏览器可开启多会话、流式交互消息/思考过程/工具调用/计划、人工审批权限请求、切换 mode 与配置选项（如模型切换）。

## 功能特性

- **多 Agent 进程管理**：支持按需启动、停用已配置的 ACP 代理子进程。
- **透明连接表单（预设 + 自定义）**：设置面板每张 agent 卡片直接展示完整 ACP 连接命令（显示名 / 命令 / 参数 / npm 包名 / 环境变量 / 权限 / 工作目录），不对用户隐藏——预设 agent 提供一键填入的官方测试默认命令，任何 agent 都可改成自定义值；「测试」按钮用当前表单值在宿主侧拉起一次性进程完成 ACP 握手（不落盘、不注册），成功显示 agent 身份与耗时、失败显示可操作错误与 stderr 尾部。
- **从零新建自定义 Agent**：「从零新建自定义 Agent」入口不依赖任何预设——填 Agent ID（客户端本地校验格式与查重，宿主端二次校验）+ 连接命令即可接入任意 stdio ACP agent；保存后自动进入「已接入」区并带「自定义」徽标，检测层会把自定义条目连同 env / npmPackage 一并回显到表单。
- **npm 包自动安装**：agent 定义可携带 `npmPackage`；宿主在 PATH 中找不到 `command` 时自动执行 `npm install -g`（超时 3 分钟，包名经严格字符集校验、杜绝注入），装完再解析一次命令路径，装不上则回落为原生 spawn 报错。
- **多会话与流式渲染**：支持多会话隔离，流式展示用户消息、Agent 回复、思考过程、工具执行与任务计划。
- **审批就在对话里**：当 Agent 触发敏感工具调用时，宿主把 ACP `session/request_permission` 转发到 DSH 原生审批链（`ctx.approval`），审批卡直接在聊天 composer 里出现（拒绝 / 允许一次），不需要切到设置页。宿主没有审批服务、或会话不归属某个聊天会话时自动降级回设置页权限卡（并支持 `permissionTimeoutMs` 超时自动取消，默认永久等待）。
- **权限策略 ≠ 审批通道**（两者容易混淆）：agent 定义里的 `permission` 是**策略**——`ask` 才把每一次请求交给人，`allow` / `reject` 由插件直接自动作答，**永远不会**弹出任何审批；至于 `ask` 的审批呈现在哪里（对话 composer 还是设置页）由宿主能力决定，不写死在配置里。
- **聊天会话以 DSH 的 Access mode 为准**：只要宿主提供 `sandboxPolicy` / `sessions` / `approval` 服务，聊天里跑起来的 ACP 会话就按你当前选的那一档（仅可查看 / 工作区内修改 / 完全权限）执行——「完全权限」直接放行（不再被 `approval: never` 反判成拒绝），「仅可查看」写类请求一律拒（`approval: ask` 时问一次人，只给一次性许可），「工作区内修改」按工作区根判断、越界才问人；同时在 `fs/write_text_file` 上做同样的边界检查（越权拒绝文案带 `[sandbox: file access denied under <mode> mode]`）。`/acp` RPC 与 headless 会话没有聊天绑定，仍以 agent 定义里的 `permission` 为准，面板会如实说明当前是哪一种生效。
- **无感断线重连（双向）**：浏览器↔宿主方向靠每会话环形事件缓存池（Transcript）按序补齐；宿主↔agent 方向靠 `session/load` 会话恢复——agent 进程崩溃后会话进入 released 状态（历史可读、上下文不丢），下次发消息自动 respawn 并回放会话历史（"发送即恢复"），无需人工重建会话。
- **工作区沙箱内的客户端文件能力**：实现 ACP `fs/read_text_file` / `fs/write_text_file`（含 `line`/`limit` 分页、单次 2 MiB 上限、自动创建父目录），所有路径经与 session cwd 相同的 `allowedCwdRoots` 白名单校验，越权访问直接拒绝。
- **空闲释放（只释放“没有会话”的进程，探测进程与聊天进程分档）**：设置面板的「探测模型」、保存后的后台探测、启动时的目录预热都会拉起 agent 进程，而它们**不留任何会话**——这类进程以前会一直常驻。现在空闲释放窗口分两档：**探测拉起的进程**（从未承载过真实会话，探测的 throwaway session 刻意不登记）空闲 5 分钟（`probeIdleTimeoutMs`）即释放，即使 agent 配了 `idleTimeoutMs: 0` 也不例外——那是聊天进程的常驻承诺；**承载过真实会话的进程**按每个 agent 可配的 `idleTimeoutMs`（默认 30 分钟，`0` = 永不释放）常驻。判定统一是：进程 READY 且**没有任何活动会话**（也没有进行中的探测 / 恢复 / 待答审批）时，空闲超过所属档位的时长就**静默释放**（杀掉子进程、状态回落 `stopped`，不发任何提示——这是预期生命周期，不是故障）。有活动会话的 agent **绝不**被释放，所以聊天不会因此多出冷启动；被释放的探测残留也不丢任何东西——已挂起的 released 会话记录原样保留，下次发送照旧走 `session/load` 恢复。
- **可靠性兜底**：agent 启动期请求（`initialize` / `session/new` / `session/load`）受 `startupTimeoutMs` 约束（默认 60s），挂死的 agent 会被杀掉并报可操作错误（含 stderr 尾部）；agent 无视 `session/cancel` 时经 `cancelFallbackMs`（默认 15s）强制定稿 turn，会话永不卡死。
- **聊天会话跑在你的工作区里**：对话里起的 ACP 会话，工作目录就是你在这个 DSH 会话里选中的工作区（sidebar 选的那个目录，即会话 header cwd）——对端 agent 的 Read / Glob / Bash 看到的就是它，`session/new` 报回的 cwd 也是它，**agent 进程本身也从那里启动**（有一类 agent 在进程启动时就定死自己的「工作区」，只改 `session/new` 的 cwd 它会照旧回答插件沙箱目录 `~/.dsh/acp-workspaces`；进程只在没有活动会话时才会被搬到该目录，有会话则保持原进程）。agent 卡片里的「工作空间目录」只对 `/acp` 直连会话与宿主未上报工作区的场合生效（面板上已注明）。agent 崩溃后的 `session/load` 恢复同样锚在该目录。
- **工作区白名单可编辑**：设置面板把工作区拆成「单根模式」（一个工作空间目录，留空则用宿主默认 `~/.dsh/acp-workspaces`）与「白名单根目录（高级）」（多根逐条增删）；单根模式保存时会把白名单显式收窄为该目录，绝不静默放宽；非绝对路径就地校验。保存前有「会停止该 Agent 进程并中断进行中的会话」的副作用提示。
- **对话内的 agent 原生模式控件**：agent 自己声明的 mode（`plan`、`acceptEdits` 之类，`session/set_mode` 枚举）会以小控件形式出现在聊天输入框工具行（`conversation.input.left`，就在 DSH 的 Access mode 旁边）——它管“agent 怎么干活”，Access mode 管“会话能碰什么”，两层各管一段；该聊天会话还没跑过 agent（或该 agent 未声明 mode）时控件自动不显示，切模式不重启进程。
- **ACP 模式（agent preset）**：随包提供一份 `acp` agent preset（[presets/acp/acp.patch.yml](file:///home/pax/coding/dsh-ntr/presets/acp/acp.patch.yml)）——它就是这个包自己的 bundle patch（`dsh.bundle.patch`），所以宿主组装 profile 时就把模式声明进 roster，没有任何安装/复制步骤（旧的 `~/.dsh/.agent-presets/<id>` 目录已不再被宿主读取）。在新会话页的模式选择里选「ACP 模式」，该会话就不会再被宿主自己的东西污染：不注入身份/部署 persona、运行上下文快照、AGENTS.md 摘要与技能目录，工具目录为空，plan mode / todo / compaction / 委派全部不挂载——模型可见的表面完全属于对端 agent。该会话的 Access mode 不再替 agent 裁决（`fs/write_text_file` 栅栏仍然生效），实际裁决交给 agent 自己的权限模式，它的每次询问都原样出现在对话里的审批卡上；而转发给 agent 的 prompt **严格只有你说的话**，一句边界叙述都没有。
- **转发的只有人说的话**：宿主把上下文段折在用户消息**之后**（运行时快照最后），所以“取最后一条 user 消息”拿到的是注入内容。插件改为按消息来源（`source.kind === 'user'`）挑人真正输入的那条，且**不转发辅助模型调用**（会话标题、compaction 这类带 `purpose` 的请求）——它们不再花掉一轮对端 agent 的 turn，也不再把自己的提示词折进 agent 的上下文。
- **聊天窗内的 ACP 路由控件**：会话路由到 `acp`（或曾跑过 ACP agent）时，聊天输入框工具行会出现 `ACP · <agent>` / 模型 / 思考等级三块芯片，点开即选——agent 列表带进程状态、模型列表是 agent 自己上报的目录（并标明它的默认模型）、思考等级来自它的 `thought_level`。"在哪条路由上"读写的是宿主 **per-session 模型目录**（与原生选择器同一份状态），而"这个 agent 有哪些模型"读的是插件自己的 `agent/catalog`；切模型时新思考等级取该 agent 的默认值（与原生座位同样的规矩）。普通会话不渲染任何 ACP 芯片。
- **会话边界就在 ACP 芯片里**：芯片菜单第二栏是「会话边界（DSH Access mode）」（仅可查看 / 工作区内修改 / 完全权限），数据取自宿主 `permissions` 投影，切换走宿主的 `/permission <preset>` 命令。它不重复摆一个下拉（原生 Access mode 就在同一条工具行上），而是在 ACP 的语境里告诉你在这一档下 agent 的写盘与询问会怎样被闸门挡住。
- **ACP 模型不进非 ACP 会话（结构性隔离）**：DSH 的模型目录是**按请求**而非按会话构建的（`buildModelCatalog(ctx)` 不接 session id），所以一个 provider 只要广告模型，就等于对**每一条**会话广告——包括根本没有 ACP agent 在背后的那些。插件因此让 `acp` 路由**一个模型都不广告**（`LlmAdapter.listModels` 的契约本身写明目录是 advisory：未列出的 id 照样解析与流式，路由可用性由注册判定），ACP 模型只活在插件自己的对话座位里（`agent/catalog`：base + 按需暴露的变体 + agent 自己的思考等级）。非 ACP 会话的模型选择器里从此没有任何 ACP 条目，`/model` 弹窗也不例外。
- **ACP 模式下模型选择器只剩 ACP**：原生模型座位虽是 single 槽，却**可按 priority 遮蔽**，插件就在更低的一档上注册自己的 ACP 座位——但只在**当前会话跑 ACP preset 时**挂上（判定取自客户端会话列表的 `agentPreset`，切走会话立即 dispose 让原生座位回来）。座位一个菜单里放下 agent、它的模型、思考等级与会话边界四个轴，同时左侧三块芯片在 ACP 模式会话里自动收起（两套同样的控件并排只会被读成重复控件）。宿主侧没有 per-session 目录过滤缝（目录是全 provider 全量构建），所以遮蔽只发生在浏览器半区；**任何一环读不到就保持原生座位**（不接管是唯一允许的失败模式），座位自身渲染崩溃也会自动交还。`/model` 命令弹窗不是槽位、遮蔽不到，所以座位会以告警色提示“跑的是 ACP 预设但不是 ACP agent”，菜单里的 agent 一节就是一键切回。
- **默认 Agent 不进全局默认模型（跨模式隔离）**：agent 卡上的 ★「设为默认 Agent」是**插件自己的**默认 agent（存在 `~/.dsh/acp-agents.json`，与 agent 定义同处），新的 ACP 模式会话若还没有自己的路由选择就直接由它服务。之所以不写成 DSH 的默认模型：`session.selectModel` 会把每一次选择**同时**记到全局默认模型上（不分会话、不分模式），一次 ACP 选择就会让所有模式的**新会话**从对端 agent 起步。所以插件在宿主侧挂了守卫（`AcpDefaultModelGuard`）：默认模型一旦是 `acp` 路由就改回上一个原生路由（候选依次为：该会话写入前的原生路由 → 已知原生默认 → 本部署 live 会话里最近的原生路由；一个候选都没有时不动、并在 RPC 里如实报 `stranded`），每轮对话前与浏览器每次写入 ACP 路由后都会复查。于是切换模式时，agent / 模型 / 思考等级不会跟着跑到别的模式去。
- **ACP 视图 tab（真工具卡）**：原生聊天的输出词表只有正文与思考（工具调用只能是一行散文），所以对话头部多了一个 **ACP** 视图 tab：按 agent 的原始流渲染真工具卡（按 kind 给图标、按 status 给色调、输出可展开）、计划清单、**unified diff**（行级 LCS 对齐 + `+N -M` 统计）与用量读数，并实时跟随 SSE（无需轮询）。已挂起（agent 崩过）的会话在这里标“下一条消息自动恢复”，关闭的会话不提供幽灵历史。该视图只读：它不发消息、不取消、不拉进程。
- **无侵入 UI 挂载**：通过 Cordis UI Slots 机制挂载至系统设置页（`settings.section`）、聊天工具行（`conversation.input.left`）与其菜单浮层（`conversation.input.overlay`）、对话视图环（`conversation.view`），不接管对话界面本身。
- **ACP 模型目录（座位自己的面）**：把 ACP agent 的 `configOptions`（`category: model` / `thought_level`）折叠成 per-agent 的模型面（`agent/catalog`）——基础条目（agent 默认模型）加 `agent@模型` 变体，思考等级作为 `reasoning` 元数据；每轮请求前自动对齐会话配置，目录经探针获取并持久化到 `~/.dsh/acp-model-catalog.json`。
- **可见模型（勾选式）**：ACP 座位菜单没有搜索功能，而真实 agent 动辄几百个模型（pi 500、omp 581），所以变体是**按需勾选**的——不勾就没有 `agent@模型` 变体条目，只留该 agent 自己的基础条目，永远不会出现列表风暴。勾选带搜索框、全选/取消全选与分批展开，改动立即（防抖）经轻量 RPC 生效，无需重启 agent、不影响进行中的会话，失败就地回滚并红字提示。模型 chip 上的供应商前缀只认 agent 自己返回的 ACP 分组（如 omp acp），不做猜测式推断——跨商供应模型太常见，猜必错。

## 数据流架构

```
浏览器端 (Browser Half: lib/client.js)
  ├─ rpc.call('/acp', endpoint, payload)          一元操作（启动会话、发送 Prompt、读会话 transcript 等）
  ├─ EventSource /api/acp/stream                    事件推送流（状态、消息更新、权限请求）
  ├─ ctx.modelDirectories.directoryFor(sessionId)   宿主 per-session 模型目录（路由读写，与原生选择器共享状态）
  └─ rpc.call('/acp', 'agent/catalog')              per-agent 的 ACP 模型面（座位/芯片的模型与思考等级来源）
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
        command: /path/to/bin/pi-acp
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

- [给 AI 编程 Agent 的操作规范与架构约束](./AGENTS.md)
- [DSH 插件开发通用指南（从零起手）](./docs/dsh-plugin-development-guide.md)
- [DSH 官方源码参考与架构索引](./docs/README.md)
- [ACP 模式：把会话交给另一个 agent](./docs/acp-mode.md)（预设组装、转发规则与证据、权限裁决、做不到的边界）
