# AGENTS.md

`dsh-ntr` 是 DeepSeek Harness (DSH) 的 ACP（Agent Client Protocol）客户端插件，提供宿主端子进程桥接与 Web 浏览器交互 UI。详细功能与背景见 [README.md](file:///home/pax/coding/dsh-ntr/README.md)。

## 关键目录与职责边界

- [`src/index.ts`](file:///home/pax/coding/dsh-ntr/src/index.ts): Cordis 插件宿主入口，负责挂载 `/acp` RPC 通道与 `/api/acp/stream` SSE 路由。
- [`src/protocol.ts`](file:///home/pax/coding/dsh-ntr/src/protocol.ts): 前后端共享契约定义（纯类型），**严禁引入任何 Node 专属库或运行时代码**（必须 browser-safe）。
- [`src/impl.ts`](file:///home/pax/coding/dsh-ntr/src/impl.ts): 纯宿主端逻辑（配置校验、环境变量脱敏、工作区防越权、Transcript 缓冲、EventHub），**严禁直接引入 Node 内置模块或 SDK**，保证无副作用且完全由单元测试覆盖。
- [`src/bridge.ts`](file:///home/pax/coding/dsh-ntr/src/bridge.ts): 宿主与 ACP 子进程 stdio 通信桥，依赖 `@agentclientprotocol/sdk`。
- [`src/client/`](file:///home/pax/coding/dsh-ntr/src/client): Web 浏览器端 React 扩展。**严禁引入 Node.js 内置模块（`node:*`、`child_process`、`fs`）或 `@agentclientprotocol/sdk`**，通信必须经由 RPC / SSE。
- [`acp-workspaces/`](file:///home/pax/coding/dsh-ntr/acp-workspaces): 默认 ACP agent 执行工作目录，受工作区路径前缀防越权校验保护。
- [`lib/`](file:///home/pax/coding/dsh-ntr/lib): 构建产物目录，**严禁手动修改**（由构建脚本全量生成）。

## 常用命令

- 提交前全量验证：`npm run prepack`（串行运行 `tsc --noEmit && vitest run tests && tsc -p tsconfig.json && tsdown`）
- 跑单个测试文件：`npx vitest run tests/bridge.spec.ts`
- 跑单个指定用例：`npx vitest run -t "spawns, initializes"`
- 仅构建浏览器端 Bundle：`npx tsdown`
- 挂载插件到 DSH 本地实例：`dsh plugin --profile web add ./`
- 其余基础命令见 [package.json](file:///home/pax/coding/dsh-ntr/package.json) `scripts`。

## 架构约束与“为什么”

1. **浏览器 Bundle 必须打包为 CJS 工厂函数，严禁输出裸 ESM**
   - 规则：[tsdown.config.ts](file:///home/pax/coding/dsh-ntr/tsdown.config.ts#L26-L42) 必须保持 `format: 'cjs'`，且在 banner/footer 用 `window.__ModuleLoader__.load({ id: 'dsh-ntr', factory: (require) => { ... } })` 包裹。
   - 原因：DSH 前端微内核加载器通过惰性 CJS 模块表供给依赖。若打包为 ESM 会在运行时解析失败。
   - 证据：[tsdown.config.ts](file:///home/pax/coding/dsh-ntr/tsdown.config.ts#L6-L12)。

2. **宿主入口 [`src/index.ts`](file:///home/pax/coding/dsh-ntr/src/index.ts) 必须使用具名导出，严禁 `export default`**
   - 规则：必须通过 `export const name`、`export const inject`、`export function apply` 导出。
   - 原因：Cordis 加载器通过具名导出提取插件元数据；默认导出（`export default`）会隐蔽 loader metadata 导致加载静默失效。
   - 证据：[src/index.ts](file:///home/pax/coding/dsh-ntr/src/index.ts#L4-L5) 注释说明（`see harness postmortem 0001`）与 [tests/register.spec.ts](file:///home/pax/coding/dsh-ntr/tests/register.spec.ts#L23-L27)。

3. **路由注册必须使用完整路径，严禁使用相对路径**
   - 规则：注册 SSE 路由必须写全路径 `path: '/api/acp/stream'`。
   - 原因：WebServer 在启动注册阶段即校验路径前缀，传非绝对路径会导致宿主进程崩溃。
   - 证据：[src/index.ts](file:///home/pax/coding/dsh-ntr/src/index.ts#L38) 与 [tests/register.spec.ts](file:///home/pax/coding/dsh-ntr/tests/register.spec.ts#L33-L36)。

4. **`session/set_config_option` 响应必须反哺本地快照，不能仅等事件通知**
   - 规则：调用 `session/set_config_option` 后必须从响应中提取权威的 `configOptions` 并广播 `session/meta`。
   - 原因：部分 ACP agent（如 `pi-acp@0.8.0`）更新配置后不再推送 `config_option_update` 事件，若不回灌会导致 UI 停留在旧值。
   - 证据：[src/bridge.ts](file:///home/pax/coding/dsh-ntr/src/bridge.ts#L427-L440)。

5. **JSON-RPC `-32603 Internal error` 细节必须优先解析 `error.data`**
   - 规则：解析 ACP 错误时必须提取 `error.data` 中的信息（如 `billing_error`、`rate_limit`、`auth_error`）。
   - 原因：ACP agent 业务阻塞错误放置在 `data` 载荷中，单纯读取 `error.message` 会丢失可操作错误原因。
   - 证据：[`describeError`](file:///home/pax/coding/dsh-ntr/src/bridge.ts#L552-L567)。

6. **源码内部文件导入必须显式书写 `.ts` / `.tsx` 扩展名**
   - 规则：相对模块导入必须书写后缀（如 `import { EventHub } from './impl.ts'`）。
   - 原因：[tsconfig.json](file:///home/pax/coding/dsh-ntr/tsconfig.json#L11-L12) 启用了 `allowImportingTsExtensions` 与 `rewriteRelativeImportExtensions`。不带扩展名会导致 `tsc` 报错。
   - 证据：[tsconfig.json](file:///home/pax/coding/dsh-ntr/tsconfig.json#L11-L12)。

7. **智能体启动命令与工作区受宿主端严格校验与隔离管理**
   - 规则：设置面板支持检测主机已安装智能体（如 `pi`），展示测试过的默认启动命令（如 `pi-acp`）并允许用户定制。宿主端在 `impl.ts` 中对提交的 `command`、`id`、`args`、`permission` 进行严格模式校验，自动施加安全工作区限制（`allowedCwdRoots`），并持久化到宿主端配置。
   - 原因：保证用户可以便捷检测和自定义本地智能体的同时，杜绝越权访问敏感文件目录。
   - 证据：[src/impl.ts](file:///home/pax/coding/dsh-ntr/src/impl.ts#L25-L65) 与 [src/bridge.ts](file:///home/pax/coding/dsh-ntr/src/bridge.ts#L450-L510)。

## 边界与禁区

- **禁止修改 [`lib/`](file:///home/pax/coding/dsh-ntr/lib)**：任何对 `lib/` 的手动修改都会被 `npm run build` 覆盖。
- **禁止在 [`src/client/`](file:///home/pax/coding/dsh-ntr/src/client) 引入 Node 依赖**：浏览器端模块必须与 Node.js 运行时完全解耦。
- **禁止在 [`tsdown.config.ts`](file:///home/pax/coding/dsh-ntr/tsdown.config.ts) 中取消 external**：`react`、`react/jsx-runtime`、`@deepseek-ai/cordis`、`@deepseek-ai/dsh-client-ui-slots` 必须由运行时提供，打包进 bundle 会破坏 context 并导致运行时报错。
- **禁止在子进程中透传未清洗的环境变量**：必须经过 [`scrubChildEnv`](file:///home/pax/coding/dsh-ntr/src/impl.ts#L43-L52) 屏蔽敏感 Token 与凭据。

## 常见任务配方

- **新增/修改 ACP RPC 接口**：
  1. 在 [`src/protocol.ts`](file:///home/pax/coding/dsh-ntr/src/protocol.ts) 添加契约类型定义。
  2. 在 [`src/impl.ts`](file:///home/pax/coding/dsh-ntr/src/impl.ts) 的 [`dispatchRpc`](file:///home/pax/coding/dsh-ntr/src/impl.ts#L225) 补充路由分发与入参校验，并在 [`tests/impl.spec.ts`](file:///home/pax/coding/dsh-ntr/tests/impl.spec.ts) 补充单测。
  3. 在 [`src/bridge.ts`](file:///home/pax/coding/dsh-ntr/src/bridge.ts) 的 [`BridgeManager`](file:///home/pax/coding/dsh-ntr/src/bridge.ts#L22) 实现底层 agent 调度。
  4. 在 [`src/client/store.ts`](file:///home/pax/coding/dsh-ntr/src/client/store.ts) 的 [`AcpStore`](file:///home/pax/coding/dsh-ntr/src/client/store.ts#L71) 增加对应调用方法并在 [`tests/store.spec.ts`](file:///home/pax/coding/dsh-ntr/tests/store.spec.ts) 验证状态流转。
- **修改 UI 视图与挂载槽位**：
  1. 在 [`src/client/panel.tsx`](file:///home/pax/coding/dsh-ntr/src/client/panel.tsx) 调整 React 组件渲染逻辑。
  2. 在 [`src/client/index.tsx`](file:///home/pax/coding/dsh-ntr/src/client/index.tsx) 通过 `ctx.slots.inject` 管理插槽注册（`sidebar.footer.action`、`shell.overlay`、`settings.section`）。
  3. 执行 `npx tsdown` 验证 bundle 产物。
- **扩展配置字段（如 Agent 选项）**：
  1. 修改 [`src/protocol.ts`](file:///home/pax/coding/dsh-ntr/src/protocol.ts) 中 [`AcpAgentDef`](file:///home/pax/coding/dsh-ntr/src/protocol.ts#L18) / [`AcpPluginConfig`](file:///home/pax/coding/dsh-ntr/src/protocol.ts#L29)。
  2. 在 [`src/impl.ts`](file:///home/pax/coding/dsh-ntr/src/impl.ts) 的 [`validateConfig`](file:///home/pax/coding/dsh-ntr/src/impl.ts#L61) 补充 Schema 检验，并在 [`tests/impl.spec.ts`](file:///home/pax/coding/dsh-ntr/tests/impl.spec.ts) 补充正反用例。
  3. 更新 [cordis.patch.yml](file:///home/pax/coding/dsh-ntr/cordis.patch.yml)。

## 环境前置条件

- **Node.js**：`>= 22.12.0`（代码依赖 Web Streams API 及 Node 22+ 特性）。
- **环境变量**：
  - `NODE_ENV`：用于区分打包环境（见 [tsdown.config.ts](file:///home/pax/coding/dsh-ntr/tsdown.config.ts#L35)）。
  - Agent 密钥变量：若 agent 子进程需要特定 Token，在 [cordis.patch.yml](file:///home/pax/coding/dsh-ntr/cordis.patch.yml) 的 `agents[].env` 中显式传递，宿主子进程默认不隐式继承父进程密钥。

## 测试约定

- 测试目录位于 [`tests/`](file:///home/pax/coding/dsh-ntr/tests)，以 `.spec.ts` 命名。
- 架构分层测试职责：
  - [`tests/impl.spec.ts`](file:///home/pax/coding/dsh-ntr/tests/impl.spec.ts)：纯逻辑单元测试，无子进程拉起，秒级返回。
  - [`tests/register.spec.ts`](file:///home/pax/coding/dsh-ntr/tests/register.spec.ts)：Cordis 上下文注册测试，使用 `fakeCtx()` 模拟宿主容器。
  - [`tests/store.spec.ts`](file:///home/pax/coding/dsh-ntr/tests/store.spec.ts)：前端状态机与消息块折叠测试。
  - [`tests/bridge.spec.ts`](file:///home/pax/coding/dsh-ntr/tests/bridge.spec.ts)：集成测试，通过真实子进程执行 [`tests/mock-agent.mjs`](file:///home/pax/coding/dsh-ntr/tests/mock-agent.mjs) 校验 stdio ACP 通信全链路。
- 调试单用例：`npx vitest run tests/<file>.spec.ts -t "<name>"`。

## 领域术语表

- **ACP (Agent Client Protocol)**：基于 stdio JSON-RPC 的智能体交互协议。
- **Host Half / Browser Half**：DSH 插件双端架构，分别对应 Node 宿主服务与浏览器端 UI 模块。
- **Cordis**：微内核服务容器，支持依赖注入与生命周期钩子管理。
- **Transcript**：宿主端为每个会话维护的有界环形缓冲队列（默认 600 条），用于重连后按序列号补齐。
- **PermissionLedger**：用于挂起 `session/request_permission` 并等待前端人工审批的状态账本。

---

## 本文档有意未包含的内容

- 完整依赖项与具体版本列表：见 [package.json](file:///home/pax/coding/dsh-ntr/package.json)
- TypeScript 详细编译器编译选项：见 [tsconfig.json](file:///home/pax/coding/dsh-ntr/tsconfig.json)
- DSH 官方开发基础指引与全系统架构说明：见 [docs/dsh-plugin-development-guide.md](file:///home/pax/coding/dsh-ntr/docs/dsh-plugin-development-guide.md) 与 [docs/README.md](file:///home/pax/coding/dsh-ntr/docs/README.md)
- UI 交互组件 JSX 结构与 CSS 样式细节：见 [src/client/panel.tsx](file:///home/pax/coding/dsh-ntr/src/client/panel.tsx)
- ACP 协议层完整规范与消息格式：见 `@agentclientprotocol/sdk` 官方文档
