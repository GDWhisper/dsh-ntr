# DSH 插件开发文档

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
