# AGENTS.md

`dsh-ntr` 是 DeepSeek Harness (DSH) 的 ACP（Agent Client Protocol）客户端插件，提供宿主端子进程桥接与 Web 浏览器交互 UI。详细功能与背景见 [README.md](file:///home/pax/coding/dsh-ntr/README.md)。

> 代码位置引用一律用「文件 + 符号名」（可 grep 定位），不用行号——行号会随每次 diff 漂移失效。

## 关键目录与职责边界

- [`src/index.ts`](file:///home/pax/coding/dsh-ntr/src/index.ts): Cordis 插件宿主入口，负责挂载 `/acp` RPC 通道与 `/api/acp/stream` SSE 路由。
- [`src/protocol.ts`](file:///home/pax/coding/dsh-ntr/src/protocol.ts): 前后端共享契约定义（纯类型），**严禁引入任何 Node 专属库或运行时代码**（必须 browser-safe）。
- [`src/impl.ts`](file:///home/pax/coding/dsh-ntr/src/impl.ts): 纯宿主端逻辑（配置校验、环境变量脱敏、工作区防越权、Transcript 缓冲、EventHub），**严禁直接引入 Node 内置模块或 SDK**，逻辑必须由 tests/impl.spec.ts 覆盖。
- [`src/bridge.ts`](file:///home/pax/coding/dsh-ntr/src/bridge.ts): 宿主与 ACP 子进程 stdio 通信桥，依赖 `@agentclientprotocol/sdk`。
- [`src/client/`](file:///home/pax/coding/dsh-ntr/src/client): Web 浏览器端 React 扩展。**严禁引入 Node.js 内置模块（`node:*`、`child_process`、`fs`）或 `@agentclientprotocol/sdk`**，通信必须经由 RPC / SSE。
- [`acp-workspaces/`](file:///home/pax/coding/dsh-ntr/acp-workspaces): 默认 ACP agent 执行工作目录，受工作区路径前缀防越权校验保护。
- [`lib/`](file:///home/pax/coding/dsh-ntr/lib): 构建产物目录，由构建脚本全量生成（禁改条目见「边界与禁区」）。

## 常用命令

- 提交前全量验证：`npm run prepack`（各步骤见 [package.json](file:///home/pax/coding/dsh-ntr/package.json) scripts）
- 跑单个测试文件 / 指定用例：`npx vitest run tests/bridge.spec.ts -t "spawns, initializes"`
- 仅重建浏览器端 Bundle：`npx tsdown`
- 挂载到 DSH 本地实例：`dsh plugin --profile web add ./`
- 其余基础命令见 [package.json](file:///home/pax/coding/dsh-ntr/package.json) `scripts`。

## 架构约束与“为什么”

1. **浏览器 Bundle 必须打包为 CJS 工厂函数，严禁输出裸 ESM**
   - 规则：[tsdown.config.ts](file:///home/pax/coding/dsh-ntr/tsdown.config.ts#L26-L42) 必须保持 `format: 'cjs'`，且在 banner/footer 用 `window.__ModuleLoader__.load({ id: 'dsh-ntr', factory: (require) => { ... } })` 包裹。
   - 原因：DSH 前端微内核加载器通过惰性 CJS 模块表供给依赖。若打包为 ESM 会在运行时解析失败。
   - 证据：[tsdown.config.ts](file:///home/pax/coding/dsh-ntr/tsdown.config.ts#L26-L42) 及其头部注释（#L6-L12）。

2. **宿主入口 [`src/index.ts`](file:///home/pax/coding/dsh-ntr/src/index.ts) 必须使用具名导出，严禁 `export default`**
   - 规则：必须通过 `export const name`、`export const inject`、`export function apply` 导出。
   - 原因：Cordis 加载器通过具名导出提取插件元数据；默认导出（`export default`）会隐蔽 loader metadata 导致加载静默失效。
   - 证据：[src/index.ts](file:///home/pax/coding/dsh-ntr/src/index.ts) 文件头注释（`see harness postmortem 0001`）与 [tests/register.spec.ts](file:///home/pax/coding/dsh-ntr/tests/register.spec.ts#L23-L27)。

3. **路由注册必须使用完整路径，严禁使用相对路径**
   - 规则：注册 SSE 路由必须写全路径 `path: '/api/acp/stream'`。
   - 原因：WebServer 注册路由时只做 `(kind, path)` 查重、不校验绝对路径，相对路径注册不会报错；但请求分发按请求 pathname 匹配，相对路径永远命不中，请求落入 SPA fallback——SSE 静默 404，极难定位。
   - 证据：[src/index.ts](file:///home/pax/coding/dsh-ntr/src/index.ts) 的 SSE 路由注册、[tests/register.spec.ts](file:///home/pax/coding/dsh-ntr/tests/register.spec.ts#L33-L36)，以及运行时依赖 `@deepseek-ai/dsh-host-webserver` 的 `register`/`match` 实现（仅查重，无路径格式校验）。

4. **`session/set_config_option` 响应必须反哺本地快照，不能仅等事件通知**
   - 规则：调用 `session/set_config_option` 后必须从响应中提取权威的 `configOptions` 并广播 `session/meta`。
   - 原因：部分 ACP agent 更新配置后不再推送 `config_option_update` 事件（在 pi-acp 0.8.0 上观察到，见 `setConfigOption` 内注释），若不回灌会导致 UI 停留在旧值。
   - 证据：[src/bridge.ts](file:///home/pax/coding/dsh-ntr/src/bridge.ts) 的 `setConfigOption`。

5. **JSON-RPC `-32603 Internal error` 细节必须优先解析 `error.data`**
   - 规则：解析 ACP 错误时必须提取 `error.data` 中的信息（如 `billing_error`、`rate_limit`、`auth_error`）。
   - 原因：ACP agent 业务阻塞错误放置在 `data` 载荷中，单纯读取 `error.message` 会丢失可操作错误原因。
   - 证据：[src/bridge.ts](file:///home/pax/coding/dsh-ntr/src/bridge.ts) 的 `describeError`。

6. **源码内部文件导入必须显式书写 `.ts` / `.tsx` 扩展名**
   - 规则：相对模块导入必须书写后缀（如 `import { EventHub } from './impl.ts'`）。
   - 原因：[tsconfig.json](file:///home/pax/coding/dsh-ntr/tsconfig.json#L11-L12) 启用了 `rewriteRelativeImportExtensions`，但它只改写**已带** `.ts`/`.tsx` 后缀的相对导入；`moduleResolution: "bundler"` 下无后缀导入 tsc 并不报错，而是原样进入 `type: module` 的宿主产物（lib/），Node 运行时报 `ERR_MODULE_NOT_FOUND`。
   - 证据：[tsconfig.json](file:///home/pax/coding/dsh-ntr/tsconfig.json#L11-L12)；lib/ 产物中相对导入均带 `.js` 后缀（改写只发生在带后缀的导入上）。

7. **智能体启动命令受宿主端严格校验与工作区隔离；内置预设两处手拷贝必须同步**
   - 规则：宿主端在 `validateAgentDef`（[src/impl.ts](file:///home/pax/coding/dsh-ntr/src/impl.ts)）对提交的 `command`、`id`、`args`、`permission` 做严格校验并自动施加安全工作区限制（`allowedCwdRoots`），`saveAgent`（[src/bridge.ts](file:///home/pax/coding/dsh-ntr/src/bridge.ts)）持久化前同样施加，严禁绕过。默认启动命令预设存在两份手拷贝：`AGENT_PRESETS`（src/bridge.ts）与 `DEFAULT_KNOWN_PRESETS`（src/client/store.ts），改其一必须同步另一处（无类型系统强制）。
   - 原因：校验与 `allowedCwdRoots` 杜绝 agent 子进程越权访问敏感目录；预设不同步只表现为面板默认命令显示不一致，低频但难排查。
   - 证据：[src/impl.ts](file:///home/pax/coding/dsh-ntr/src/impl.ts) 的 `validateAgentDef`、[src/bridge.ts](file:///home/pax/coding/dsh-ntr/src/bridge.ts) 的 `saveAgent` / `AGENT_PRESETS` 与 [src/client/store.ts](file:///home/pax/coding/dsh-ntr/src/client/store.ts) 的 `DEFAULT_KNOWN_PRESETS`。

8. **模型目录（adapter `listModels`/`resolveModel`）必须纯内存应答，严禁 spawn**
   - 规则：`BridgeManager.listAdapterModels` / `resolveAdapterModel` 只读目录缓存，目录未热时仅允许后台 `ensureCatalog`。`resolveModel` 对已知 agent 的任何输入都不得 throw（过期变体降级为裸 id 条目），仅对未配置 agent throw。`exposedModels` 过滤只允许作用于 `listAdapterModels` 的变体展开（基础条目永不过滤），严禁影响 `resolveAdapterModel`。供应商 `group` 只能来自 agent 自己返回的 ACP `SessionConfigSelectGroup` 标签，严禁从名称前缀/value 路径/家族词做猜测式推断（任何供应商都可能供应别家模型）。
   - 原因：DSH 宿主 `buildModelCatalog` 是 await 的且对逐模型 `resolveModel` 异常整组连坐——spawn 或 throw 都会让聊天模型选择器里整个 `acp` 组消失。过滤若作用于 resolve，会破坏“隐藏的变体仍可继续会话”的容忍语义。
   - 证据：[src/bridge.ts](file:///home/pax/coding/dsh-ntr/src/bridge.ts) 的 `listAdapterModels`/`resolveAdapterModel`/`setExposedModels` 与 [tests/bridge.spec.ts](file:///home/pax/coding/dsh-ntr/tests/bridge.spec.ts) 的 "model catalog (isolated manager)" 套件。

9. **模型可见性筛选必须走轻量 RPC，严禁复用 `agent/save` 全量保存**
   - 规则：面板勾选 `exposedModels` 后经 `agent/set-exposed-models` 原地修改 def 并持久化（`setExposedModels`），不重启 agent 进程；`agent/save` 会停掉子进程、杀死全部活动会话，只能用于命令/参数等真正需要重建的变更。
   - 原因：原生选择器没有搜索功能，筛选是高频微调操作；每次勾选都杀会话的代价不可接受。
   - 证据：[src/bridge.ts](file:///home/pax/coding/dsh-ntr/src/bridge.ts) 的 `setExposedModels`（对比 `saveAgent`）与 [src/client/panel.tsx](file:///home/pax/coding/dsh-ntr/src/client/panel.tsx) 的 `ModelCatalogBlock`。

10. **agent 进程死亡 ≠ 会话销毁：必须走 released → 发送即恢复（`session/load`）路径**
    - 规则（崩溃路径）：`connectionLost` 只能走 `AgentBridge.releaseAll`（会话标记 `released`、settled 权限、广播 `session/released`），严禁在崩溃路径删除会话记录或广播 `session/closed`。
    - 规则（恢复路径）：对 released 会话的 `prompt` / `setMode` / `setConfigOption` 经 `locateOrResume` 自动 resume：respawn + `session/load`，会话记录**原地复活**。replay 更新会在 load 响应前到达，因此必须**先**重置 transcript、把会话注册回 `acpIndex` 并广播 `session/reset`（浏览器清空 blocks 与 seq 水位），**再**发 load 请求；resume 失败必须把记录 park 回 released map 并重新广播 `session/released`；`resumeSession` 以 inflight promise 去重并发调用；loadSession capability 检查必须放在 `ensureReady` 之后（releaseAll 会清空旧 `initResult`，capability 只能来自新进程的 initialize）。
    - 原因：README 宣称的“无感断线重连”必须同时覆盖浏览器↔宿主（Transcript 补齐）与宿主↔agent（session/load 回放）两段，否则 agent 崩一次会话上下文全丢。
    - 证据：[src/bridge.ts](file:///home/pax/coding/dsh-ntr/src/bridge.ts) 的 `releaseAll`/`resumeSession`/`locateOrResume` 与 [tests/bridge.spec.ts](file:///home/pax/coding/dsh-ntr/tests/bridge.spec.ts) 的 "reliability (isolated manager, short timeouts)" 套件。

11. **子进程生命周期事件必须携带身份校验，严禁只看 bridge 级 state**
    - 规则：`child.on('exit'/'error')` 与 `conn.closed.then` 三个 connectionLost 触发器分别以 `this.child === child`、`this.conn === conn` 身份守卫；任何新触发器同理。
    - 原因：实测竞态——P1 崩溃 → conn.closed 先触发 releaseAll → 测试/用户立刻 resume spawn P2（state='starting'）→ P1 延迟的 exit 事件看到 'starting' 误判为新进程死亡 → releaseAll 把 P2 杀掉，resume 永远失败。state 是 bridge 级的，无法区分“哪个孩子”的事件。
    - 证据：[src/bridge.ts](file:///home/pax/coding/dsh-ntr/src/bridge.ts) 的 `spawnAndConnect` 事件注册处与 [tests/bridge.spec.ts](file:///home/pax/coding/dsh-ntr/tests/bridge.spec.ts) 的 "resumes a session after the agent process dies"。

12. **启动期请求必须有超时兜底；取消必须有强制定稿兜底；fs 错误构造必须携带细节**
    - 规则：
      - `initialize` / `session/new` / `session/load` 一律经 `withStartupTimeout`（`startupTimeoutMs`，默认 60s）——SDK 的 `cancellationSignal` 是协作式的，挂死 agent 不会响应 `$/cancel_request`，唯一有效超时是 race + `killChild`。
      - `session/cancel` 后经 `armCancelFallback`（`cancelFallbackMs`，默认 15s）强制定稿 turn（`turn/end` turnId='' + error）：agent 无视 cancel 不得让会话永久卡在 `running`。
      - fs 请求错误必须用 `new RequestError(code, message, { message })` 构造——`RequestError.internalError(x)` 的第一个参数是 **data** 不是 message，传字符串会丢失细节（wire 上只剩 'Internal error'）。
    - 原因：挂死的 agent（npx 冷装、认证等待）与无视取消的 agent 都会把会话永久卡死；错误细节丢失会让 agent 与用户都无从判断失败原因。
    - 证据：[src/bridge.ts](file:///home/pax/coding/dsh-ntr/src/bridge.ts) 的 `withStartupTimeout`/`armCancelFallback` 与 [tests/bridge.spec.ts](file:///home/pax/coding/dsh-ntr/tests/bridge.spec.ts) 的 "fails a hung agent" / "force-finalizes a turn"。

## 边界与禁区

- **禁止修改 [`lib/`](file:///home/pax/coding/dsh-ntr/lib)**：任何对 `lib/` 的手动修改都会被 `npm run build` 覆盖。
- **禁止在 [`tsdown.config.ts`](file:///home/pax/coding/dsh-ntr/tsdown.config.ts) 中取消 external**：`react`、`react/jsx-runtime`、`@deepseek-ai/cordis`、`@deepseek-ai/dsh-client-ui-slots` 必须由运行时提供，打包进 bundle 会破坏 context 并导致运行时报错。
- **禁止在子进程中透传未清洗的环境变量**：必须经过 [src/impl.ts](file:///home/pax/coding/dsh-ntr/src/impl.ts) 的 `childEnv` 脱敏（敏感命名变量与 `DSH_*` 不进入子进程）。

## 常见任务配方

- **新增/修改 ACP RPC 接口**：
  1. 在 [`src/protocol.ts`](file:///home/pax/coding/dsh-ntr/src/protocol.ts) 添加契约类型定义。
  2. 在 [`src/impl.ts`](file:///home/pax/coding/dsh-ntr/src/impl.ts) 把新方法加入 `AcpManager` 接口（`dispatchRpc` 以它为参数契约，缺了直接编译失败），再在 `dispatchRpc` 补充路由分发与入参校验，并在 [`tests/impl.spec.ts`](file:///home/pax/coding/dsh-ntr/tests/impl.spec.ts) 补充单测。
  3. 在 [`src/bridge.ts`](file:///home/pax/coding/dsh-ntr/src/bridge.ts) 的 `BridgeManager` 实现底层 agent 调度（`/acp` 通道对 endpoint 透明转发，[src/index.ts](file:///home/pax/coding/dsh-ntr/src/index.ts) 通常无需改动）。
  4. 在 [`src/client/store.ts`](file:///home/pax/coding/dsh-ntr/src/client/store.ts) 的 `AcpStore` 增加对应调用方法并在 [`tests/store.spec.ts`](file:///home/pax/coding/dsh-ntr/tests/store.spec.ts) 验证状态流转。
  5. 验证：宿主半区跑 `npx vitest run tests/impl.spec.ts tests/store.spec.ts`；若动到 client 渲染，再 `npx tsdown` 验证 bundle。
- **修改 UI 视图与挂载槽位**：
  1. 在 [`src/client/panel.tsx`](file:///home/pax/coding/dsh-ntr/src/client/panel.tsx) 调整 React 组件渲染逻辑。
  2. 在 [`src/client/index.tsx`](file:///home/pax/coding/dsh-ntr/src/client/index.tsx) 通过 `ctx.slots.inject` 管理插槽注册（当前注册了 `settings.section`；其余既定槽位见该文件头注释，新增槽位照同一模式）。
  3. 执行 `npx tsdown` 验证 bundle 产物。
- **扩展配置字段（如 Agent 选项）**：
  1. 修改 [`src/protocol.ts`](file:///home/pax/coding/dsh-ntr/src/protocol.ts) 中 `AcpAgentDef` / `AcpPluginConfig`。
  2. agent 级字段的校验与归一化写在 `validateAgentDef`（[src/impl.ts](file:///home/pax/coding/dsh-ntr/src/impl.ts)）——该函数**重建返回对象**，新字段不纳入就会被静默剥离；且 `loadPersistedAgents` 会用它重校验旧持久化配置，新字段必须 optional。`validateConfig` 只负责编排 agents 数组。在 [`tests/impl.spec.ts`](file:///home/pax/coding/dsh-ntr/tests/impl.spec.ts) 补充正反用例。
  3. 若字段需在面板编辑：同步 protocol.ts 的 `AgentSavePayload` 与 panel.tsx 的 `DetectedAgentCard`（含保存 payload 组装）。涉及默认命令预设时，遵守约束 7 的两处同步。
  4. 更新 [cordis.patch.yml](file:///home/pax/coding/dsh-ntr/cordis.patch.yml)。

## 环境前置条件

- **Node.js**：`>= 22.12.0`（`package.json` `engines`；代码依赖 Web Streams API 及 Node 22+ 特性）。
- **Agent 密钥变量**：agent 子进程环境默认经 `childEnv` 脱敏、不隐式继承父进程密钥；agent 所需 Token 在 [cordis.patch.yml](file:///home/pax/coding/dsh-ntr/cordis.patch.yml) 的 `agents[].env` 中显式传递。

## 测试约定

- 测试目录位于 [`tests/`](file:///home/pax/coding/dsh-ntr/tests)，以 `.spec.ts` 命名。
- 架构分层测试职责：
  - [`tests/impl.spec.ts`](file:///home/pax/coding/dsh-ntr/tests/impl.spec.ts)：纯逻辑单元测试，无子进程拉起，秒级返回。
  - [`tests/register.spec.ts`](file:///home/pax/coding/dsh-ntr/tests/register.spec.ts)：Cordis 上下文注册测试，使用 `fakeCtx()` 模拟宿主容器。
  - [`tests/store.spec.ts`](file:///home/pax/coding/dsh-ntr/tests/store.spec.ts)：前端状态机与消息块折叠测试。
  - [`tests/bridge.spec.ts`](file:///home/pax/coding/dsh-ntr/tests/bridge.spec.ts)：集成测试，通过真实子进程执行 [`tests/mock-agent.mjs`](file:///home/pax/coding/dsh-ntr/tests/mock-agent.mjs) 校验 stdio ACP 通信全链路。

## 领域术语表

- **Host Half / Browser Half**：DSH 插件双端架构，分别对应 Node 宿主服务与浏览器端 UI 模块。
- **Transcript**：宿主端为每个会话维护的有界环形缓冲队列，用于重连后按序列号补齐。
- **Model Catalog**：宿主端为每个 agent 维护的 `model` / `thought_level` 配置目录（源自 ACP `configOptions`），驱动 DSH 原生聊天选择器的变体条目（`agent@choice`）与 `reasoning` 思考等级元数据。
- **exposedModels**：per-agent 的原生选择器可见性过滤（模型 choice value 列表）。未设置 = 全部暴露；设置后仅列出的变体进入选择器，基础条目始终可见；只影响 listModels，不影响 resolveModel。

---

## 本文档有意未包含的内容

- 完整依赖项与具体版本列表：见 [package.json](file:///home/pax/coding/dsh-ntr/package.json)
- TypeScript 编译选项与模块解析策略：见 [tsconfig.json](file:///home/pax/coding/dsh-ntr/tsconfig.json)
- DSH 宿主机制（Cordis 生命周期、WebServer 路由、UI slots、cordis.patch.yml 语义）：实现插件侧新能力前读 [docs/dsh-plugin-development-guide.md](file:///home/pax/coding/dsh-ntr/docs/dsh-plugin-development-guide.md)；DSH 官方源码路径见 [docs/README.md](file:///home/pax/coding/dsh-ntr/docs/README.md)
- UI 交互组件 JSX 结构与 CSS 样式细节：见 [src/client/panel.tsx](file:///home/pax/coding/dsh-ntr/src/client/panel.tsx)
- ACP 协议层完整规范与消息格式：实现/调试 ACP 方法语义时查 `node_modules/@agentclientprotocol/sdk` 的类型定义与官方文档
