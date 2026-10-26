# dsh-ntr

[English](./README.en.md) | 简体中文

在 [DSH（DeepSeek Harness）](https://github.com/deepseek-ai/deepseek-harness) 的网页/桌面端里，用你习惯的界面，直接和任意一个 **ACP agent**（CodeBuddy、Pi、Oh My Pi、Claude Code、OpenCode、Qoder 等）对话。

**DSH 提供界面，agent 提供能力。** 会话列表、输入框、侧栏、消息展示全部来自 DSH；推理、工具执行、文件读写、权限判断全部由你自己配置的那个 agent 完成，它跑在独立进程里，完全自治。这个插件只做一件事：把两边接通，并把 agent 的输出原样画到 DSH 的界面上。

> 模型选择、思考等级、工作模式都是 **agent 自己的概念**，不是 DSH 的模型目录。插件不替你换模型，也不会把 agent 的选择写进 DSH 的全局设置。

---

## NTR 是什么

**NTR = Negotiated Target Routing（协商式目标路由）**。

一句话：你的宿主 Agent 作为 ACP 客户端，和目标 Agent 协商能力与权限，把这一轮任务交给它执行。

---

## 安装

本插件是一个 DSH **bundle**：`package.json` 的 `dsh.bundle.patch` 声明了随包分发的两层补丁——插件本体的 `cordis.patch.yml`，与 NTR 模式 preset 的 `presets/acp/acp.patch.yml`。用 `dsh plugin` 安装后，包会加入 profile 的 `dsh.profile.bundles`，补丁层**自动生效**，无需手动编辑任何配置文件。

### 方式一：从 npm registry 安装

```bash
dsh plugin --profile web add dsh-ntr@latest
```

升级重跑同一条命令即可。

> `add` 时**务必带 `@latest`**：不带的话包管理器会一直复用首次写入的版本号，之后连 `update` 也升不上去。

### 方式二：经 [dsh-market](https://github.com/dsh-market/dsh-market) 插件市场安装

先装市场本体：

```bash
dsh plugin --profile web add dshmarket
```

重启 `dsh web`，打开**插件**页：dsh 0.2.1 起市场是「已安装」旁边的**插件市场**标签页；更早的版本在**设置 → 插件市场**。搜索 `dsh-ntr`，确认来源后一键安装，装完刷新页面即可使用；之后的更新检查与升级也在市场里完成。官方 DSH 桌面 App 自带这个市场，直接在 App 的**插件**页里搜索安装即可。

> 市场的插件清单来自 [awesome-dsh-plugin](https://awesome-dsh-plugin.com) 精选目录，每天自动刷新。若搜索结果里暂时没有 `dsh-ntr`，用方式一从 npm 安装，不影响使用。

### 方式三：从源码安装

需要 Node.js ≥ 22.12.0。

```bash
git clone https://github.com/GDWhisper/dsh-ntr.git
cd dsh-ntr
npm install        # 安装构建依赖（typescript 等）
npm run build      # 编译宿主 TS 与浏览器 Bundle 到 lib/（构建产物不入库，此步必须执行）
dsh plugin --profile web add ./
```

之后升级：`git pull` → `npm run build` → 重启 `dsh web`。`add .` 以 `link:` 方式安装，重建后重启即生效，不需要重新 add。

> 从源码安装切到 npm / 市场版前，先在插件管理器里卸载旧版，并删掉 profile 里的 `node_modules/dsh-ntr`。pnpm 的 hoisted 布局会把 `link:` 目标里的 `node_modules` 留在包目录内，旧依赖会遮蔽新装的 SDK，典型报错见「常见问题」里的 `EPERM ... zod`。

> `dsh plugin` 是 pnpm 转发器，`--profile <name>` 必填；`add .` 会把当前目录以 `link:` 方式装进 profile。官方桌面 App 的 profile 由它自己的插件管理器掌管，不要对着它的 profile 跑命令行。

---

## 上手

### 你需要什么

1. 一个已经装好的 DSH（Web 或桌面版）。
2. 至少一个 ACP agent 的命令行程序。插件内置了几个常见预设，也可以填任何支持 stdio 的 ACP agent。

### 三步接入

1. 打开 **设置 → NTR**。
2. 在「Agent 列表」里选一个预设一键填入，或点「从零新建自定义 Agent」手填启动命令。
3. 点「测试」。成功会显示 agent 的名字和握手耗时；失败会显示可操作的错误和 stderr 尾部。

保存后，这个 agent 就出现在输入框行尾的 NTR 底座里。

### 开始对话

1. 新建一个会话，在模式选择里选「**NTR 模式**」。
2. 在输入框行尾的 NTR 底座里选一个 agent。
3. 直接说话。

agent 的回复和思考显示在主聊天区。工具活动按发生顺序插在它们中间：一行 `🛠️ **工具名** · 参数`，输出跟一个代码块。想看完整的工具输出、计划和 diff，切到对话头部的 **NTR** 标签页。

---

## 你会用到的界面

### NTR 底座（输入框行尾）

点一下，选哪个 agent 服务这条会话。这个菜单里只有 agent 列表——一个控件一件事。agent 自己的模型和思考等级是同一行里各自独立的芯片，各开各的菜单；如果 agent 还发布了额外配置项（温度、供应商开关等），模型芯片左边会多一个「高级」底座，点开逐项设置。首轮之前 agent 底座固定在行尾最右侧；锁定后它退场，模型和思考等级接管右端。那些清单由 agent 自己上报，不是你熟悉的 DSH 模型列表。

底座只出现在 **NTR 模式**的会话里。普通会话里看到的是 DSH 原生的模型选择器。

**一个会话一个 agent。** 首条消息发出前，底座一直在，你可以先选好、也可以反悔改选。首轮**开始**时会话就**锁定**在这个 agent 上：底座粉碎，名字变成**输入框卡片上边缘的小挂牌**（`NTR · <agent>`，骑在顶边上），挂牌只显示、不能点击——换 agent 请新建会话。模型、思考等级和「高级」芯片留在原位，它们属于同一个 agent，不涉及上下文迁移。如果首轮还没产生任何可见输出就失败/取消，锁定会自动回滚，底座回来，可以直接重选。

### `/` 命令属于 agent

在 NTR 会话里输入 `/`，弹出的是 **agent 自己的命令清单**——它通过 ACP 声明的那些（例如 `compact`、`session`、`model`），不是 DSH 的命令。选中一项只是把命令名填进输入框；回车后整行原样发给 agent，由它执行。清单在**第一条消息之前**就能用：宿主记住了这个 agent 上次会话声明的命令（从没跑过的 agent 要等第一轮之后才有）。

DSH 自己的 `/model`、`/permission`、`/export` 等在这一模式下**不会**被宿主截走：同名命令也交给 agent，宿主命令菜单与技能补全不会出现。普通会话的斜杠行为完全不变。

### 审批与 agent 自己的权限模式

agent 要动敏感的东西时会问你。审批卡直接出现在聊天输入框里，你点允许或拒绝，它照着做。

每个 agent 问法不一样：有的给一组选项，有的只给允许/拒绝，有的会附上它要执行的具体命令。插件把这些原样呈现给你，不预先替你决定。

**权限模式由 agent 自己定义。** 每个 agent 在输入框工具行给出它自己的模式清单（例如 `Always Ask`、`Accept Edits`、`Plan`、`Bypass Permissions`），选项文字就是 agent 下发的原文。你切换模式，agent 就按新模式决定什么时候来问你。插件不另设一套权限档，也不替你翻译这些模式名。

> **注意**：DSH 自己的「访问模式」（只读 / 工作区写入 / 完全权限）管不到外部 agent。那个 agent 在自己的进程里，DSH 的文件沙箱对它没有作用力。真正生效的是 agent 自己的权限模式，以及它向你发起的那些审批。

### NTR 标签页

对话头部的 **NTR** 标签页显示 agent 的原始流：

- 计划和待办清单
- 每次工具调用的名称、状态、输出（默认折叠，点开看全部）
- 代码改动的 unified diff，带 `+N -M` 行数统计
- 用量读数

这个标签页是只读的：它不发消息、不取消任务、不启动进程。实时跟随，不需要手动刷新。

**主聊天区和 NTR 标签页的分工**：人和 agent 的对话在主聊天区，工具活动也按时间顺序内联在那里；NTR 标签页放主聊天区装不下的东西——计划、完整输出、diff、用量。

### 设置 → NTR

- **已接入的 NTR 智能体**：每个 agent 一行，标着进程状态。点开「展开配置与模型」看全部细节。
- **`★ 默认`**：新建 NTR 会话默认用哪个 agent。
- **每张 agent 卡片**：显示名、启动命令、npm 包名、环境变量、工作目录，全部直接摆在你面前，没有藏起来的默认值。
- **启动命令是一整行**：程序加参数，例如 `codebuddy --acp`。含空格的路径用引号包住。输入框下方会实时显示插件解析出的「程序 / 参数」。
- **测试按钮**：用当前表单里的值拉起一个一次性进程做握手，不保存、不注册。适合在改配置前先验证。
- **工作区目录**：agent 在哪个目录里干活。
- **对话中可见的模型**：agent 能报几百个模型时，这里挑你想在模型芯片菜单里看到的。没勾的仍然可用，只是不列出来。

### 你的工作区

在对话里起的 NTR 会话，工作目录就是你在这个 DSH 会话里选中的那个目录（侧栏点的那个）。对端 agent 的读文件、搜索、执行命令都在那里，它自己的进程也从那里启动。

有一类 agent 在进程启动那一刻就把工作区定死了，只改会话参数它不听。插件在它没有活动会话时会把它搬到新目录；有会话在进行时就保持原进程，不打断你的对话。

---

## 常见问题

**会被平台风控吗？会封号吗？是反代吗？**

不会，也不是反代。dsh-ntr 与 agent 之间的通信走 ACP——这是 agent 官方支持的协议入口。插件只负责启动你本地的 agent 进程并和它对话，全程不接触平台 API、不转发任何请求。模型调用由 agent 自己完成，跟你在终端里直接用它没有区别。在 NTR 提供的能力范围内合理使用，是官方允许的做法，不会因此封号。

**为什么选完 agent 之后，输入框里没看到 DSH 的模型选择器？**

那是设计如此。NTR 会话里，模型是 agent 自己的概念，所以那个位置换成了 NTR 底座。切回普通模式的会话，原生选择器就回来了。

**为什么首轮开始后，输入框行尾不显示 agent 名字了？**

一个会话一个 agent。首轮之前底座留着让你改选；首轮一开始，会话就锁在这个 agent 上，名字变成挂在输入框卡片上边缘的 `NTR · <agent>` 只读小挂牌。换 agent 会丢掉它这边的上下文，所以确认锁定后只能新建会话。模型、思考等级和高级配置芯片不受影响。首轮没有任何可见输出就失败/取消时，锁定会回滚，底座回来。

**锁定后想换 agent 怎么办？**

新建一个会话重新选。已锁定的会话不会接受 `session/chat-bind` 的改绑（宿主返回 `agent_locked`），这是刻意的：新 agent 没有这段对话的上下文，假装切换只会得到一段失忆的对话。首轮没有产生任何可见输出就失败的情况例外：锁定会自动回滚，可以直接重选。

**顶部看不到 NTR 标签页？**

每条会话都有这个标签页。这条会话还没绑过 agent 时，它是空的，会提示你去选一个。先在模式选择里选「NTR 模式」，再在 NTR 底座里选一个 agent。

**agent 卡住不动了？**

可以放心点停止。插件会取消这一轮，并在 agent 不理会取消时强制收尾，会话不会永久卡住。如果 agent 进程崩了，下次发消息会自动把它拉起来并回放上下文，历史不丢。

**agent 只回了一个空气泡？**

一部分 agent 会把上游失败（认证、计费、配额）当成「正常结束」。插件检测到这种情况时会补一条告警，不让失败静默。

**agent 没反应，也没报错？**

看设置页的测试按钮。它会在宿主侧跑一次完整的握手，把真正的错误（包括 stderr 尾部）显示出来。

**模型列表太长或太短？**

模型芯片的菜单没有搜索框，所以模型是**按需勾选**的。去设置页那张卡片里勾你想看的。不勾就没有那些条目，避免几百个模型刷屏。

**为什么 NTR 标签页里没有我发的消息？**

那个标签页只显示 agent 的原始流（它的计划、完整工具输出、diff、用量）。你和它的对话在主聊天区，工具活动按发生顺序内联在对话里。

**为什么输入框里多了一个下拉，里面的选项我没见过？**

那是 agent 自己的权限模式，选项文字由它下发。每个 agent 的叫法不一样，插件照原样列出。它管的是 agent 什么时候来问你，与 DSH 的「访问模式」无关。

**导入了 agent，但它的权限模式和别的 agent 不一样？**

正常。模式清单由每个 agent 自己声明（`session/set_mode` 下发），插件照原样列出，不统一翻译、也不补默认值。想改叫法要在 agent 自己的配置里改。

**从源码安装切到 npm / 市场版后，启用时报 `EPERM ... zod`？**

这是旧依赖残留，不是插件缺文件：错误路径里会出现 `node_modules/dsh-ntr/node_modules/.pnpm/...`。源码安装用 `link:` 指向你的仓库；pnpm 的 hoisted 布局在切到 registry 版时会把包目录换成真实文件，但会留下链接目标里的 `node_modules`。这份旧树（旧版 `@agentclientprotocol/sdk` 及其失效的 `zod` 软链）会遮蔽新装的依赖，DSH 导入时 stat 到坏链就报 `EPERM`。处理：在插件管理器里卸载 `dsh-ntr`，删除 `~/.dsh/profiles/<profile>/node_modules/dsh-ntr`（或只删它下面的 `node_modules`），再重装并重启。桌面 App 的 profile 请直接在 App 的插件页卸载/重装，不要用命令行。

---

## 它能做什么（能力清单）

- **任意 ACP agent**：内置常见预设，也可以接入任何支持 stdio 的 ACP agent。自定义 agent 带「自定义」徽标。
- **多会话隔离**：多个会话可以同时跟不同 agent 对话，各自独立。
- **流式展示**：用户消息、agent 回复、思考过程、工具执行、任务计划都是流式的。
- **工具活动内联**：工具调用按发生顺序插进主聊天区，思考和回答分列它两侧，不分层。
- **真实权限**：agent 的权限模式原样列出，它的每次权限询问也原样呈现，你答什么它收到什么。
- **斜杠命令归 agent**：NTR 会话里 `/` 弹出的是 agent 自己声明的命令；DSH 的同名命令不会截走你的输入。
- **断线重连**：浏览器刷新或断网后，历史按序补齐。agent 进程崩了，下次发消息自动恢复。
- **空闲释放**：没有活动的 agent 进程会在空闲一段时候后自动退出，不占内存。有会话的进程不会被释放。
- **Windows 可用**：npm 全局安装的 agent 在 Windows 上也能正常启动和回收，不会残留后台进程。

---

## 配置参考（开发者）

以上是用户部分。以下写给要改这个插件、或要手工写配置文件的人。

### 最小配置

在 Profile 层的 `cordis.patch.yml` 里挂载。省略 `cwd` / `allowedCwdRoots` 时用插件自有工作区 `~/.dsh/dsh-ntr/workspaces`（保存时自动创建）；`command` 是**一整条命令行**，含空格的路径用引号包住。

```yaml
- id: dsh-ntr
  name: dsh-ntr
  config:
    agents:
      - id: pi
        title: pi coding agent (ACP)
        command: /path/to/bin/pi-acp     # 例如 "codebuddy --acp"
        cwd: ~/.dsh/dsh-ntr/workspaces
        allowedCwdRoots: [~/.dsh/dsh-ntr/workspaces]
```

可选的 agent 字段：`npmPackage`（PATH 里找不到时自动 `npm install -g`）、`exposedModels`（NTR 座位菜单列哪些变体）、`idleTimeoutMs`（聊天进程的空闲释放窗口，`0` = 永不释放，默认 30 分钟）。插件级还有 `transcriptMaxEntries`（会话事件缓冲上限，默认 600）与 `probeModelsOnBoot`（保留字段，启动时已不再为每个 agent 探测，见 `bootstrapCatalogs` 的注释）。可靠性超时与重试的默认值（`startupTimeoutMs`、`cancelFallbackMs`、`staleCancelRetryDelayMs`、`staleCancelMaxRetries`、`permissionTimeoutMs` 与 `permissionFallbackTimeoutMs`）见 [AGENTS.md](./AGENTS.md) 约束 12 与 13；设置页能改的都在设置页改。

### 构建与安装

```bash
npm install          # 依赖
npm run build        # 宿主 TS 声明 + 浏览器 Bundle
npm test             # 测试套件
dsh plugin --profile web add ./   # 挂载到 Web Profile
```

### 实现要点

以下每条都对应一处真实故障，改代码前先读对应文档。浏览器半区经 `/acp` RPC 与 `/api/acp/stream` SSE 和宿主半区通信；宿主半区每会话一个 `AgentBridge`，经 stdio JSON-RPC 驱动 agent 子进程。

代码位置：`src/index.ts`（插件入口）· `src/protocol.ts`（共享类型）· `src/impl.ts`（纯宿主逻辑）· `src/bridge.ts`（子进程通信桥）· `src/client/`（React 扩展）· `presets/acp/`（NTR 模式声明）· `~/.dsh/dsh-ntr/`（运行时落盘）。

- **DSH 只出显示层**：插件不写 DSH 的模型路由，不接管宿主的模型目录，也不让 ACP 模型出现在 DSH 原生选择器里。
- **工作区即侧栏路径**：侧栏点开的目录必须成为 `session/new` 的 cwd **和** agent 子进程自己的 cwd。有一条 agent（codebuddy）在进程启动那一刻就定死工作区。
- **NTR 模式 = agent preset**：由 `presets/acp/acp.patch.yml` 随包声明，不挂工具、不注入项目指令、不做 compaction，让模型可见的表面完全属于对端 agent。
- **转发严格等于用户文本**：按 `source.kind === 'user'` 挑消息，不转发标题生成、compaction 这类辅助调用，也不拼任何边界叙述。
- **逐步切分 = 原生交错的工具卡**：一个 ACP turn 按工具活动切成多个宿主 step——段以 `tool-call` 卡收尾即结束本次 stream，宿主落定消息、执行卡（真实输出经 guard 虚拟工具应答）、续跑下一步；续跑段续读同一个仍在飞的 `session/prompt`，绝不新发 prompt。卡片因此夹在两个 assistant 节点之间，与原生多步对话一致。
- **绑定必须接到请求路径上**：guard 的 `agent/request` waterfall（`prepend: true`）把请求改写成绑定指向的 `acp/<agent>`，adapter 再做一次复查。
- **权限模式与审批是两层，都以 agent 为准**：`composer-mode.tsx` 的控件只渲染 agent 经 `session/set_mode` 下发的 `availableModes`，不写可见标签、不翻译选项名；`session/request_permission` 原样映射给用户。插件没有自己的权限开关：agent 问了就一定到人面前。早先那套由宿主替 agent 裁定的端口语义（`decidePermission`、fs 写栅栏）已删除，见 `docs/acp-convergence.md` §2.3。
- **跨平台路径**：`impl.ts` 不能 import `node:path`，绝对路径判定与 containment 全部手写，Windows 与 UNC 有专门用例。

### 文档索引

- [AGENTS.md](./AGENTS.md) —— **先读「本插件是什么」一节**：哪些约束已废弃、哪些目标形态已落地
- [NTR 模式：把会话交给另一个 agent](./docs/acp-mode.md) —— 设计、实测证据与硬边界
- [ACP 收敛方向：只借显示层](./docs/acp-convergence.md) —— **代码收敛的唯一权威依据**
- [DSH 插件开发通用指南](./docs/dsh-plugin-development-guide.md)
- [DSH 官方源码参考与架构索引](./docs/README.md)
