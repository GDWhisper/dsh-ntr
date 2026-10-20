# DSH 插件开发文档

- [NTR 模式：把会话交给另一个 agent](./acp-mode.md)
  - 原生上下文确实被转发的证据（`agent/pre-step` 折入顺序 + 真实会话日志）与宿主侧修复（`selectForwardPrompt`、`purpose` 拒绝）
  - NTR 模式 = agent preset（`presets/acp`）：清空宿主对模型可见的一切；loop 不可替换的硬约束
  - 不替 agent 裁决（permission 原样映射给用户，宿主不再有 `decidePermission` / `authorizeWrite` 这一层）、转发内容严格等于用户文本、fs 写只剩 `guardFsPath` 的 workspace containment；做不到的边界（宿主侧无 per-session 目录过滤缝、Access mode 控件）
  - 对话内的 NTR 面：三块芯片（agent / 模型 / 思考等级）的权威来源各自是什么、模型面为什么另走 `agent/catalog`、权限档整格占空，以及 NTR 视图 tab 如何用 `session/chat-transcript` 渲染计划、完整工具输出与 unified diff
  - 双向模型隔离：宿主侧"什么都不广告"（ACP 模型不进 DSH 目录，`/model` 弹窗也不例外）+ 浏览器侧由 `createModelSeatClaim` 接管原生座位（occupant 是 NTR 底座本体，按当前会话 preset 动态注册；注册后用 `entriesOfSlot` 核实 cell 的 head 是不是自己，被抢走就再注册一次，上限 `MAX_SEAT_CLAIMS`，到顶如实报「被谁占着」；放弃时回到原生座位）
- [NTR 待办清单](./acp-todo.md)
  - 用户已报告、尚未落地的 NTR 面意向：模型列表获取不完全（含浏览器端目录缓存一层）、NTR 模式下原生输入框透传 agent 自己的命令（同名命令会被客户端命令层消费）
  - agent 底座首轮开始时隐藏并锁定、改由输入框上边缘挂牌显示（首轮无可见输出则回滚）已落地，去向见文末
  - 每条附已核实事实、预分析纠错、实施步骤与验收标准；落地后结论并回 AGENTS.md，本文件留下落点去向
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
