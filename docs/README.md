# DSH 插件开发文档

- [实现约束细节（分层，入口：architecture.md）](../AGENTS/architecture.md)
  - 由根 AGENTS.md 索引的 agent 操作手册（架构 / 协议 / 界面 / 权限 / 状态 / 宿主接线 / 路径 / 已退役方向）
- [NTR 模式：把会话交给另一个 agent](./acp-mode.md)
  - 原生上下文确实被转发的证据（`agent/pre-step` 折入顺序 + 真实会话日志）与宿主侧修复（`selectForwardPrompt`、`purpose` 拒绝）
  - NTR 模式 = agent preset（`presets/acp`）：清空宿主对模型可见的一切；loop 不可替换的硬约束
  - 不替 agent 裁决（permission 原样映射给用户，宿主不再有 `decidePermission` / `authorizeWrite` 这一层）、转发内容严格等于用户文本、fs 写只剩 `guardFsPath` 的 workspace containment；做不到的边界（宿主侧无 per-session 目录过滤缝、Access mode 控件）
  - 对话内的 NTR 面：三块芯片（agent / 模型 / 思考等级）的权威来源各自是什么、模型面为什么另走 `agent/catalog`、权限档整格占空，以及 NTR 视图 tab 如何用 `session/chat-transcript` 渲染计划、完整工具输出与 unified diff
  - 双向模型隔离：宿主侧"什么都不广告"（ACP 模型不进 DSH 目录，`/model` 弹窗也不例外）+ 浏览器侧由 `createModelSeatClaim` 接管原生座位（occupant 是 NTR 底座本体，按当前会话 preset 动态注册；注册后用 `entriesOfSlot` 核实 cell 的 head 是不是自己，被抢走就再注册一次，上限 `MAX_SEAT_CLAIMS`，到顶如实报「被谁占着」；放弃时回到原生座位）
- [方案：自制子智能体展示（彻底替换宿主 trigger，已实现待验收）](./plan/subagent-panel.md)
  - 为什么：宿主把 `mode: 'external'` 行写死为「外部任务」——`completed = !external && …`、无 activity 文案、不可点进详情；插件原先只塞一个 `running` 布尔圆点，成功 / 失败 / 耗时 / 明细全不可达。实测宿主持久的只有目录成员（日志事件 + `subagentCatalog` 检查点），运行态不持久，external 行连 `subagentTiming` 数据源都没有
  - 怎么做：claim 的 occupant 在 ACP 会话分流到自绘面板（非 ACP 原样渲染宿主组件）；列表复用宿主 `subagentCatalog` projection，终态落 `agents.json` 新增的 `subagents` 键，明细按 worker 单独限 200 条且只在内存；六态 = 排队 / 运行 / 成功 / 失败 / 已取消 / 未知，详情挂 `shell.overlay`
  - 状态：已实现待验收（彻底替换 / 宿主持久性已调查 / 同意单独上限）；证据、契约、变更清单与验收口径见文内
- [上游实测：CodeBuddy 多会话串话](./upstream/codebuddy-acp-multi-session-prompt-cross-talk.md)
  - 一条 ACP 连接只有一个 `currentSession` 的现场证据：新建会话的首条 prompt 被旧会话接走并以 `end_turn` 零输出返回，新建会话还会取消旧会话的后台任务
  - 用途：A1（每 DSH 会话一个进程）与 A2（单进程多连接）的判定依据；证据原文与复现步骤见文内
- [方案：NTR 会话内的消息动作接管](./plan/ntr-message-actions.md)
  - 为什么：NTR 会话里宿主的点赞 / 点踩 / 分支三图标要么无意义、要么分支出来 agent 记不住上文；本方案把它们在 NTR 会话内隐藏，换成插件自己的分支入口（同图标、同尺寸），可用性由插件按六态判定
  - 怎么做：`html[data-ntr-acp]` 作用域 + `aria-label` 选择器隐藏（锚点 `[data-turn-tail]`）；`conversation.chat.assistant-actions` 注册自绘按钮；点击走「宿主 `sessions.fork` → 插件 `session/fork` adopt」两段式，子会话的 ACP 上下文来自 agent 自己的 fork
  - 状态：已实现（含审核修正，见文内「实施修正」标注）；行为契约以 [AGENTS/ui.md §12](../AGENTS/ui.md) 与 [AGENTS/protocol.md §1](../AGENTS/protocol.md) 为准
- [方案：孤儿 agent 进程的回收（暂缓）](./plan/backlog/orphan-agent-reaping.md)
  - 为什么 / 怎么做：宿主被 `SIGKILL` / `taskkill /F` 时插件拉起的 agent 会活下来；现状只覆盖优雅关闭、主动杀与 `exit` 钩子。三条候选路线（绕开 `.cmd` 壳 / supervisor 包装 / 重启接管）各带验收口径与风险，状态「未决策」，索引见 [backlog](./plan/backlog/README.md)
- [方案：CodeBuddy 每 DSH 会话一个 ACP 子进程（A1，已提交 `ee78ac2`，待真机验证）](./plan/codebuddy-per-session-process.md)
  - 为什么：CodeBuddy 一条连接只有一个 `currentSession`，并发会话会互相顶掉、串话；stdio 下唯一可行的隔离拓扑是每会话一个进程
  - 怎么做：单 `bridges` Map 改复合键 + `BridgeScope`（chat / ephemeral / probe；`bridgeScopes` 只写不读，仅供测试与诊断）；聊天会话与 `/acp` 临时会话按会话归属，probe 结束即回收；`agentViews` 聚合成一条 agent 状态；父会话 fork 硬禁用；CodeBuddy 启动时清 `SERVER__PORT` / `SERVER__HOST` 且不传 `--port`
  - 状态：**已提交 `ee78ac2`；待真机验证**。与 [A2](./plan/backlog/codebuddy-single-process-http-acp.md) 是同一问题下的省内存后续路线
- [方案：CodeBuddy 单进程 + 多条 HTTP ACP 连接（A2，暂缓）](./plan/backlog/codebuddy-single-process-http-acp.md)
  - 为什么 / 怎么做：A2 是一个 CodeBuddy 进程用 streamable-http 承载 N 条 ACP 连接、每条连接一个会话；省掉每会话约 300 MB 进程内存，代价是传输层重写、连接池、token、端口生命周期，且隔离仍依赖上游连接语义。含跨连接指针、writer 独占、端口、token 过期等未知项的验证方法
  - 状态：未决策、当前不启动；触发条件见文内，索引见 [backlog](./plan/backlog/README.md)
- [方案：按 agent 过滤的会话归属查询（暂缓）](./plan/backlog/agent-scoped-session-lookup.md)
  - 为什么 / 怎么做：`find` / `tryLocate` / `locateOrResume` 只按 `sessionId` 遍历全部 bridge，A1 放大进程数后少了 agent 维度；方案给出「只查唯一性」与「给 RPC 加 agent 身份」两条路线、假设与验收口径
  - 状态：未决策、当前不改；判定依据与触发条件见文内，索引见 [backlog](./plan/backlog/README.md)
- [方案：A1 恢复在途时关闭会话返回 `unknown_session`（暂缓）](./plan/backlog/a1-close-during-resume.md)
  - 为什么 / 怎么做：`closeSession` 先用 `tryLocate` 再 `dropReleased`，恢复在途的记录只存在于 `resuming`，两个查找都看不到；修复路径是登记 close intent，在 `sessions.set` 之前落定，验收要求恰好一条 `session/closed`
  - 状态：未决策、当前不改；启动条件见文内，索引见 [backlog](./plan/backlog/README.md)
- [待办清单](./todo.md)
  - 本仓唯一的待办清单：只留尚未落地的项，用户确认完结即删（结论并入 AGENTS.md 对应约束，不留「已落地」历史）
  - 当前两项：自制子智能体展示（方案见 [docs/plan/subagent-panel.md](./plan/subagent-panel.md)）；宿主被强杀后残留的 ACP agent 进程（方案见 [docs/plan/backlog](./plan/backlog/README.md)）
- [发版手册](../AGENTS/release.md)
  - agent 操作文档（由根 AGENTS.md 索引）：版本与 tag 规则、发布前检查，从提交到 npm 发布与 GitHub Release 的完整命令
  - release note 与 [`CHANGELOG.md`](../CHANGELOG.md) 的写法：面向用户、只写能感知到的变化与确定性净改动，不写根因与内部机制
- [ACP 会话的权限对齐调研（DSH Access mode ↔ ACP 权限）](./acp-permission-and-sandbox.md)
  - 两个权限旋钮的实体与证据（preset / projection / sandbox / approval）
  - 现状接线错误（`never` → ACP 请求被全拒、只读档可被审批放行、沙箱对 ACP 无作用力）
  - 方案裁定：原生下拉不可替换、`conversation.input.left` 可加控件、`ctx.sandbox.confine` 硬约束的代价
- [DSH 插件开发通用指南（从零起手）](./dsh-plugin-development-guide.md)
  - 核心架构认知（Cordis 内核、Plugin / Bundle / Profile 三要素）
  - 空项目起手骨架（目录结构、package.json、tsconfig.json、cordis.patch.yml）
  - 三类插件核心实现模式（工具插件 Tool、服务/路由插件 Service/Route、前端 UI 插件 Browser Half）
  - 测试策略（三层立体测试）
  - 本地挂载与调试排查（Web / Headless）
  - 高频踩坑与防御性检查清单（10 问 10 答）
  - 一条龙发布/交付闭环命令

---

## 本机 DSH 源码索引 (`/home/pax/coding/research/deepseek-harness`)

本机检出的 DeepSeek Harness 官方源码库位于 [`/home/pax/coding/research/deepseek-harness`](file:///home/pax/coding/research/deepseek-harness)，在开发插件、对照契约或排查机制时可查阅以下核心路径：

### 1. CLI 与启动器 (CLI & Startup Bundles)
- [`apps/cli/`](file:///home/pax/coding/research/deepseek-harness/apps/cli) - DSH CLI 主入口，包含 `dsh web`、`dsh plugin`、`--dump-config` 及 Profile 目录管理逻辑。
- [`packages/bundle/web-app/`](file:///home/pax/coding/research/deepseek-harness/packages/bundle/web-app) - 官方原版 Web 启动器 Bundle（含 `startup.ts` 与 `cordis.patch.yml`）。
- [`packages/bundle/base/`](file:///home/pax/coding/research/deepseek-harness/packages/bundle/base) - 核心基础 Profile 配置定义。
- [`packages/bundle/headless/`](file:///home/pax/coding/research/deepseek-harness/packages/bundle/headless) - 无头任务（一次性任务）Profile 配置定义。

### 2. 工具系统 (Tools Runtime & Pipeline)
- [`packages/core/tools/`](file:///home/pax/coding/research/deepseek-harness/packages/core/tools) - 工具系统核心实现，提供 `ToolRegistry` (ToolRuntime)、`defineTool` 契约定义与 Schema 校验。
- [`docs/tool-execution-pipeline.zh.md`](file:///home/pax/coding/research/deepseek-harness/docs/tool-execution-pipeline.zh.md) - 工具执行管道详解。
- [`docs/tool-catalog.zh.md`](file:///home/pax/coding/research/deepseek-harness/docs/tool-catalog.zh.md) - 官方工具目录与 DSL 规范。

### 3. Web 服务与静态宿主 (Host & WebServer)
- [`packages/host/webserver/`](file:///home/pax/coding/research/deepseek-harness/packages/host/webserver) - Web 服务提供者，管理 HTTP 路由（`register`、`registerUpgrade`、路由 Map）与 `tapIndex`。
- [`packages/host/frontend-static/`](file:///home/pax/coding/research/deepseek-harness/packages/host/frontend-static) - 前端静态资源服务与 `registerFallback` 入口。
- [`packages/credentials/`](file:///home/pax/coding/research/deepseek-harness/packages/credentials) - 凭据存储与管理服务。

### 4. 浏览器端 UI 与前端插件机制 (Client & Browser Half)
- [`packages/client/modules/`](file:///home/pax/coding/research/deepseek-harness/packages/client/modules) - `ClientModuleRegistry`，负责前端插件扫描、`window.__DSH_BOOT__` 引导数据组装。
- [`packages/client/connection/`](file:///home/pax/coding/research/deepseek-harness/packages/client/connection) - 客户端与后端通信、`browser-auth.ts` 签名认证、`isLoopback` 回环计算逻辑。
- [`packages/client/ui-settings/`](file:///home/pax/coding/research/deepseek-harness/packages/client/ui-settings) - 设置面板插件，定义 `settings.section` slot 贡献点。
- [`packages/client/ui-primitives/`](file:///home/pax/coding/research/deepseek-harness/packages/client/ui-primitives) - 官方 UI 原语组件（含官方字标、图标等）。

### 5. Cordis 内核与配置层引擎 (Kernel & Loader)
- [`vendor/loader/`](file:///home/pax/coding/research/deepseek-harness/vendor/loader) & [`vendor/include/`](file:///home/pax/coding/research/deepseek-harness/vendor/include) - Cordis 插件加载器与 `cordis.patch.yml` 叠加重写引擎。
- [`docs/cordis-primer.zh.md`](file:///home/pax/coding/research/deepseek-harness/docs/cordis-primer.zh.md) - Cordis 架构入门。

### 6. 官方文档与子系统手册
- [`docs/user/develop/basic/`](file:///home/pax/coding/research/deepseek-harness/docs/user/develop/basic) - 官方插件与工具开发基础教程。
- [`docs/architecture.zh.md`](file:///home/pax/coding/research/deepseek-harness/docs/architecture.zh.md) - 整体系统架构白皮书。
- [`docs/subsystems/`](file:///home/pax/coding/research/deepseek-harness/docs/subsystems) - 各子系统架构与能力契约手册。
