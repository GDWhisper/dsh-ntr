# AGENTS.md

`dsh-ntr` 是 DeepSeek Harness (DSH) 的 ACP（Agent Client Protocol）客户端插件，提供宿主端子进程桥接与 Web 浏览器交互 UI。详细功能与背景见 [README.md](file:///home/pax/coding/dsh-ntr/README.md)。

> 代码位置引用一律用「文件 + 符号名」（可 grep 定位），不用行号——行号会随每次 diff 漂移失效。

## 关键目录与职责边界

- [`src/index.ts`](file:///home/pax/coding/dsh-ntr/src/index.ts): Cordis 插件宿主入口，负责挂载 `/acp` RPC 通道与 `/api/acp/stream` SSE 路由。
- [`src/protocol.ts`](file:///home/pax/coding/dsh-ntr/src/protocol.ts): 前后端共享契约定义（纯类型），**严禁引入任何 Node 专属库或运行时代码**（必须 browser-safe）。
- [`src/impl.ts`](file:///home/pax/coding/dsh-ntr/src/impl.ts): 纯宿主端逻辑（配置校验、环境变量脱敏、工作区防越权、Transcript 缓冲、EventHub），**严禁直接引入 Node 内置模块或 SDK**，逻辑必须由 tests/impl.spec.ts 覆盖。
- [`src/bridge.ts`](file:///home/pax/coding/dsh-ntr/src/bridge.ts): 宿主与 ACP 子进程 stdio 通信桥，依赖 `@agentclientprotocol/sdk`。
- [`src/client/`](file:///home/pax/coding/dsh-ntr/src/client): Web 浏览器端 React 扩展。**严禁引入 Node.js 内置模块（`node:*`、`child_process`、`fs`）或 `@agentclientprotocol/sdk`**，通信必须经由 RPC / SSE。其中 [`acp-ui.tsx`](file:///home/pax/coding/dsh-ntr/src/client/acp-ui.tsx) 是对话侧三块座位（composer 芯片 / picker 浮层 / ACP 视图 tab）共用的结构类型 + 样式 + 菜单壳，[`session-controls.tsx`](file:///home/pax/coding/dsh-ntr/src/client/session-controls.tsx) 与 [`acp-view.tsx`](file:///home/pax/coding/dsh-ntr/src/client/acp-view.tsx) 分别实现这两类界面。
- [`acp-workspaces/`](file:///home/pax/coding/dsh-ntr/acp-workspaces): 插件本仓的本地 ACP agent 执行工作目录（仅开发/测试用）。**运行时默认工作区是 `~/.dsh/acp-workspaces`**（`defaultAgentWorkspace`/`ensureDefaultWorkspace`），由插件在保存 agent 时按需创建；受工作区路径前缀防越权校验保护。
- [`presets/acp/`](file:///home/pax/coding/dsh-ntr/presets/acp): 随包发布的 **ACP 模式 agent preset**，以 **bundle patch 声明**形式交付（`acp.patch.yml` 的 `preset-acp` 行 + 它引用的 `acp-guard.mjs`），经 package.json 的 `dsh.bundle.patch` 随 profile 组装进入宿主 roster；`~/.dsh/.agent-presets/<id>` 目录**已死**（无人读取），见约束 21。它属于 DSH 的 agent 平面组装，**不是**本插件的运行时模块。
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
   - 规则：宿主端在 `validateAgentDef`（[src/impl.ts](file:///home/pax/coding/dsh-ntr/src/impl.ts)）对提交的 `command`、`id`、`args`、`permission` 做严格校验并自动施加安全工作区限制（`allowedCwdRoots`），`saveAgent`（[src/bridge.ts](file:///home/pax/coding/dsh-ntr/src/bridge.ts)）持久化前同样施加，严禁绕过。默认工作区必须取 `defaultAgentWorkspace()`（`~/.dsh/acp-workspaces`）并去重 roots，**严禁再把 `process.cwd()` 塞进 `allowedCwdRoots`**（宿主启动目录可能是 `$HOME`，等于放开整个家目录）。默认启动命令预设存在两份手拷贝：`AGENT_PRESETS`（src/bridge.ts）与 `DEFAULT_KNOWN_PRESETS`（src/client/store.ts），改其一必须同步另一处（无类型系统强制）。注意 `def.cwd` 只是**兜底**工作目录（`/acp` RPC 会话 + 宿主未上报工作区的聊天会话），聊天会话实际 cwd 取 DSH 会话自己的工作区，见约束 15 的「规则（工作目录）」。
   - 原因：校验与 `allowedCwdRoots` 杜绝 agent 子进程越权访问敏感目录；`process.cwd()` 兜底曾让实际配置漏出 `/home/pax`；预设不同步只表现为面板默认命令显示不一致，低频但难排查。
   - 证据：[src/impl.ts](file:///home/pax/coding/dsh-ntr/src/impl.ts) 的 `validateAgentDef`、[src/bridge.ts](file:///home/pax/coding/dsh-ntr/src/bridge.ts) 的 `saveAgent` / `AGENT_PRESETS` 与 [src/client/store.ts](file:///home/pax/coding/dsh-ntr/src/client/store.ts) 的 `DEFAULT_KNOWN_PRESETS`。

8. **ACP 模型绝不进入 DSH 的模型目录（结构性隔离）；座位自己的模型面走 `agent/catalog`，且必须纯内存应答**
   - 规则（隔离）：`AcpLlmAdapter.listModels('acp')` 必须返回空数组——`acp` 路由不得出现在任何会话的模型目录里。DSH 的目录构建是 per-request 而非 per-session（`buildModelCatalog(ctx)` 不接 session id），所以一旦广告模型，就等于对**每一条**会话广告（包括没有 ACP agent 在背后的那些）；`LlmAdapter.listModels` 的契约本身写明目录是 advisory（“an adapter may accept unlisted model ids, and consumers must not turn absence into request rejection”），路由可用性由注册判定（`routeServed` 读 `listProviders()`），因此空列表不影响 `agent@choice` 的解析、选择与流式。
   - 规则（座位面）：ACP 座位/芯片的模型面只能读 `BridgeManager.agentCatalog`（RPC `agent/catalog`）——`base`（裸 `agentId` = agent 默认模型）+ `exposedModels` 过滤后的 `variants` + agent 自己的 `thought_level` 作为 `reasoning`。该 RPC 只读内存缓存，目录未热时仅允许后台 `ensureCatalog`（严禁在座位渲染路径上 spawn）。`resolveAdapterModel` 对已知 agent 的任何输入都不得 throw（过期变体降级为裸 id 条目），仅对未配置 agent throw；`exposedModels` 过滤只允许作用于 `agentCatalog` 的变体展开（`base` 永不过滤），严禁影响 `resolveAdapterModel`。
   - 规则（变体按需）：未设置/空 = 不提供任何变体，只留 `base`——真实 agent 动辄数百个 choice，默认全暴露在无搜索的菜单里就是列表风暴。供应商 `group` 只能来自 agent 自己返回的 ACP `SessionConfigSelectGroup` 标签，严禁从名称前缀/value 路径/家族词做猜测式推断（任何供应商都可能供应别家模型）。
   - 原因：宿主平面没有 per-session 目录过滤 seam，"少列几个 provider"在宿主做不到；唯一结构性诚实的隔离就是"什么都不广告"，把 ACP 模型整体搬进插件自己的座位数据面（`agent/catalog`）。`buildModelCatalog` 是 await 的且对逐模型 `resolveModel` 异常整组连坐，所以这条路径还必须纯内存。
   - 证据：[src/bridge.ts](file:///home/pax/coding/dsh-ntr/src/bridge.ts) 的 `AcpLlmAdapter.listModels`/`agentCatalog`/`resolveAdapterModel`/`ensureCatalog`、[src/impl.ts](file:///home/pax/coding/dsh-ntr/src/impl.ts) 的 `dispatchRpc('agent/catalog')` 与 [tests/bridge.spec.ts](file:///home/pax/coding/dsh-ntr/tests/bridge.spec.ts) 的 "model catalog (isolated manager)" 套件。

9. **模型可见性筛选必须走轻量 RPC，严禁复用 `agent/save` 全量保存**
   - 规则：面板勾选 `exposedModels` 后经 `agent/set-exposed-models` 原地修改 def 并持久化（`setExposedModels`），不重启 agent 进程；`agent/save` 会停掉子进程、杀死全部活动会话，只能用于命令/参数等真正需要重建的变更。浏览器半区必须在保存后失效并重读该 agent 的座位目录缓存（`loadAgentCatalog`），否则已打开的对话仍列旧集合。
   - 原因：座位菜单没有搜索功能，筛选是高频微调操作；每次勾选都杀会话的代价不可接受。
   - 证据：[src/bridge.ts](file:///home/pax/coding/dsh-ntr/src/bridge.ts) 的 `setExposedModels`（对比 `saveAgent`）、[src/client/store.ts](file:///home/pax/coding/dsh-ntr/src/client/store.ts) 的 `loadAgentCatalog`/`invalidateSeatCatalog` 与 [src/client/panel.tsx](file:///home/pax/coding/dsh-ntr/src/client/panel.tsx) 的 `ModelCatalogBlock`。

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

13. **权限审批必须优先走宿主 `ctx.approval` 原生审批链，且必须保留降级路径**
    - 规则（路由）：ACP `session/request_permission` 在 `policy === 'ask'` 且桥已拿到 requester 且会话有 `dshSessionId`（即经 `AcpLlmAdapter` 起的聊天会话）时必须调用宿主 `ctx.approval.request({ agent, toolName, signal })`，让审批出现在对话 composer 里；`dshSessionId` 只允许在 `BridgeManager.getOrCreateDshSession` 的两条分支（新建、released 后 resume）写入。
    - 规则（降级）：`'unavailable'`（服务缺失、`ctx.agents.get` 取不到、requester 抛错/同步抛错）必须回落到既有的 `PermissionLedger` + `permission/request` 广播路径（含 `permissionTimeoutMs` 兜底），严禁让异常冒泡到 agent 的 turn；路由成功时**不启动** `permissionTimeoutMs` 定时器（人在对话里答，不能抢答），但仍要广播一条 `permission/resolved` 保持事件流对称。
    - 规则（探测）：`approval` / `agents` 两个服务**严禁**写进 [`src/index.ts`](file:///home/pax/coding/dsh-ntr/src/index.ts) 的 `export const inject`（缺服务会让插件整体加载失败），只能 `ctx.get` + `ctx.inject(['approval','agents'], …)` 后补注册；`approvalRouted` 由 `agents/list` 只读上报（缺失报 `false`，浏览器据此决定是否继续渲染设置页权限卡）。
    - 原因：审批问答必须贴着它所属的对话出现（在设置页操作对话里的审批是本插件最别扭的 UX）；而 `approval.request` 硬要求「open turn 内的审计对」，服务或会话缺失时静默吞掉审批会让 turn 永远挂住，所以降级必须可用。
    - 证据：[src/index.ts](file:///home/pax/coding/dsh-ntr/src/index.ts) 的 `wireApproval`、[src/bridge.ts](file:///home/pax/coding/dsh-ntr/src/bridge.ts) 的 `askNativeApproval`/`nativeOutcomeResponse`/`setApprovalRequester`/`approvalRouting`、[src/impl.ts](file:///home/pax/coding/dsh-ntr/src/impl.ts) 的 `dispatchRpc('agents/list')` 与 [tests/bridge.spec.ts](file:///home/pax/coding/dsh-ntr/tests/bridge.spec.ts) 的 "native approval routing (isolated manager)" 套件。

14. **审批 UI 与运行期交互归对话，设置页只能是纯配置面**
    - 规则：[`src/client/panel.tsx`](file:///home/pax/coding/dsh-ntr/src/client/panel.tsx) 在 `ui.approvalRouted === true` 时不得渲染权限审批卡（只能保留只读的待处理计数提示）；`false` 时才保留 ledger 卡片。
    - 规则：表单里的「权限策略」（`AcpAgentDef.permission`）必须在 label 与旁注里写清它是**策略**（要不要问人）、不是审批通道，且旁注要根据 `ui.approvalRouted` / `ui.accessModeRouted` 说明实际生效的是谁——两者极易被读成重复控件。
    - 规则：聊天侧的 ACP 原生 mode 控件注册在 `conversation.input.left`（`src/client/composer-mode.tsx`）。该 series 的公开 `.d.ts` 里 slot 条目**不含 `owner` 字段**（`OwnerOf` 解析为 `object`），因此必须在组件里声明结构类型（`ComposerModeProps`）并在注册处 `as unknown as SlotComponent<any>` 转型；新增 client 模块依赖时同时要加进 package.json 的 `dsh.client.inject`。
    - 规则（结构类型只许写框架真的递过来的成员）：session 作用域入口能拿到的标准套件成员就是 `sessionId` + `use<Name>` 选择器钩子（`useSession` / `useConversation` / `useInput` / `useWorkspaces` / `useChat` / `useProjection`）+ `inputActions` + 自己的 owner share（`conversation.input.model` 的 `locked`）；`conversation.input.left` 的 owner share 是**空对象**（`renderSlot('conversation.input.left', {})`），**严禁**声明/读取任何别的字段（曾经写过 `session.sessionId`，实测直接让整条 entry 崩掉并被 `abdicate`：`Cannot read properties of undefined (reading 'sessionId')`；旁路泄漏进 `props.session?.running` 的可选链更阴——不炸，但重读触发永远不触发）。需要「会话是否在跑」只能 `useSession(s => s.running)`（`AcpSessionHook`，声明在 `src/client/acp-ui.tsx`）。
    - 规则：每张 agent 卡必须保持「紧凑行 + 展开详情」两段，且详情体必须**常挂载**、只用 `display: none` 折叠——条件渲染会重挂载表单 `useState` 并丢掉用户编辑中的值。
    - 规则：工作区保存语义固定为「单根模式（非空 `cwd`）显式把 `allowedCwdRoots` 收窄为 `[cwd]`；`cwd` 为空则两者都不发送（走宿主 `defaultAgentWorkspace()`）；多根模式发送编辑后的去重绝对路径」；初始状态带 >1 个 root 的 agent 必须直接进多根模式，避免仅仅打开表单就收窄白名单。
    - 原因：对话在聊天区、审批在设置区曾让整个面板被迫同时承担配置 + 运行状态 + 运行期交互三种职责；而一次「打开就保存」曾静默覆盖手工收窄的工作区白名单；`permission: allow` 下原生审批**根本不会触发**（`handlePermissionRequest` 在此之前就短路返回），把策略误当成审批开关会得出「原生审批失效」的错误结论。
    - 证据：[src/client/panel.tsx](file:///home/pax/coding/dsh-ntr/src/client/panel.tsx) 的 `AcpSettingsSection` / `AgentRow` / `WorkspaceBlock` / `initialForm` / `buildPayload`。

15. **聊天会话的权限裁决与写盘边界必须服从 DSH Access mode，agent 级 `permission` 只兜底非聊天会话**
    - 规则（解析）：宿主入口 `src/index.ts` 必须探测 `sandboxPolicy` / `sessions` / `approval` 三个服务（**严禁**写进 `export const inject`）并注入 `BridgeManager.setSessionPolicyResolver`；每轮 prompt 前重解析快照（`session.dshPolicy`，在 `AgentBridge`/`BridgeManager` 的 `streamPrompt` 处），切换 knob 只影响下一轮。
    - 规则（工作目录）：聊天会话的 ACP `session/new` / `session/load` cwd 必须是该 DSH 会话自己的工作区（sidebar 选中的工作区 = 会话 header cwd = `sandboxPolicy.resolve` 报回的 `workspaceRoot`，经 `chatWorkspaceRoot` 取出），**严禁**用 `def.cwd`（插件沙箱目录 `~/.dsh/acp-workspaces`）当聊天会话的 cwd——否则对端 agent 的 Read/Glob/Bash 看不到用户项目，且它会如实回答「当前工作区是 ~/.dsh/acp-workspaces」。该工作区必须以 `extraRoots` 形式加入本会话的 roots 校验（`resolveSessionCwd` 第 4 参），且 **create 与 resume 两条路径都要传**（resume 漏传会让崩溃后的会话带 `cwd_denied` 永远 park 在 released）；`/acp` RPC 会话与宿主未上报工作区时保持 `def.cwd` 语义不变（`extraRoots` 为空）。
    - 规则（进程 cwd）：同一个工作区还必须作为 `spawnCwd` 传进 `AgentBridge.ensureReady`，让 agent **子进程自己的 cwd** 也落在那里（`safeSpawnCwd(def, wanted)`；`createSession` 第 3 参与 `doResumeSession` 两处都传）。原因：有一类 agent（实测 codebuddy）在**进程启动那一刻**就把 workspace 定死——它在读任何 ACP 请求之前先打印 `Workspace Path: <process cwd>`，其 file policy、给模型看的 env 块、项目态全按它来，`session/new` 的 cwd 对它们太晚；只改 session cwd 时它照旧回答「当前工作区 = ~/.dsh/acp-workspaces」。就地重启进程只允许在 `isQuiet()`（无 live session / 探测 / resume / 待答审批 / starting）时发生，且必须先广播 `agent/notice`；有 live session 的 bridge 保持原进程（不杀会话换目录），`session/new` 仍如实带上该会话自己的工作区。探测（`probeConfigOptions`）、`agent/test`、`/acp` RPC 会话背后没有 DSH 会话，仍用 `def.cwd`。
    - 规则（裁决）：快照存在时 `handlePermissionRequest` 必须走 `decidePermission`（`src/impl.ts`），`approval === 'never'` 时**严禁**把 ask 递给 `ctx.approval`（那里在 `ApprovalService.decide` 内直接返回 `rejected`）；`'allow'` / `'reject'` 本地作答且不启动 `permissionTimeoutMs`。快照缺失（`/acp` RPC、headless）时保持 agent 级 `permission` 语义不变。
    - 规则（fs）：`fs/write_text_file` 必须经 `authorizeWrite` 判定（`workspace-write` 只放行工作区根与 agent 自身 roots；越界仅在 `approval === 'ask'` 时问人且只给一次性许可；`read-only` 一律拒，错误文案带 `sandboxDenialMarker` 方言）；只有 `danger-full-access` 才允许用 `canonicalizeFsPath` 绕过 `allowedCwdRoots`。
    - 规则（**不叙述**）：每轮转发给 ACP 的 prompt **严禁**拼任何边界/策略句子，必须严格等于用户文本（`promptText`）。access mode 的作用力只有裁决（`decidePermission`）与 fs 栅栏（`authorizeWrite`）；agent 只在真的撞上拒绝文案或审批询问时才知道边界，`/acp` 会话同样读不到任何边界叙述。（曾有一版 `policyNotice` 前缀叙述，已按用户要求彻底移除——不要以“agent 不知道边界”为由重加。）
    - 原因：ACP agent 的工具跑在自己的进程里，DSH 文件沙箱对它毫无作用力，而唯一真正连上的 knob（`approval/policy`）曾是**反的**：`never`（“完全权限”预设）会在 answerer 之前把所有 ACP 权限询问判成 rejected，而 `read-only` + `ask` 又能被一次“允许一次”写穿。
    - 规则（agent 原生模式）：agent 自己的 mode 列表只经 `session/chat-list` / `session/chat-mode-set`（按 DSH 会话 id 查/设，见 `BridgeManager.chatSessions` / `setChatSessionMode`）上报与切换，**不**参与上面的权限裁决；未跑过 agent 的聊天会话返回空列表，控件自隐。
    - 证据：[src/index.ts](file:///home/pax/coding/dsh-ntr/src/index.ts) 的 `wireAccessMode`、[src/impl.ts](file:///home/pax/coding/dsh-ntr/src/impl.ts) 的 `decidePermission` / `dshSessionPolicyOf` / `sandboxDenialMarker` / `resolveSessionCwd`、[src/bridge.ts](file:///home/pax/coding/dsh-ntr/src/bridge.ts) 的 `permissionDecision` / `authorizeWrite` / `chatWorkspaceRoot` / `getOrCreateDshSession` / `doResumeSession` / `setSessionPolicyResolver` / `chatSessions`、[src/client/composer-mode.tsx](file:///home/pax/coding/dsh-ntr/src/client/composer-mode.tsx)、[tests/bridge.spec.ts](file:///home/pax/coding/dsh-ntr/tests/bridge.spec.ts) 的 "DSH access mode mapping (isolated manager)" 与 "chat session workspace (isolated manager)" 套件，以及 [docs/acp-permission-and-sandbox.md](file:///home/pax/coding/dsh-ntr/docs/acp-permission-and-sandbox.md)。

16. **转发给对端 agent 的只有人说的话；辅助模型调用一律不转发**
    - 规则（选消息）：`BridgeManager.streamPrompt` 必须用 `selectForwardPrompt`（[src/impl.ts](file:///home/pax/coding/dsh-ntr/src/impl.ts)）按 `message.source.kind === 'user'` 挑消息（无 source 的手工请求等同用户输入），**严禁**再写「最后一条 role==='user' 的消息」这类取法；只有注入消息的唤醒轮（goal/subagent/skill 注入）不发 ACP 轮次，直接以 `stop` 结束；`purpose !== undefined`（`session-title` / `compaction`）必须在 `getOrCreateDshSession` **之前**以 `unsupported_purpose` 失败。
    - 原因：宿主把上下文段折在用户消息**之后**（`dsh-agent-instructions` 的 pre-step 监听器源码注释：*"Fold the context right after the claimed batch, so the direct prompt precedes it and the driver-appended runtime context follows it"*；运行时快照由 driver 追加在最后），所以「最后一条 user 消息」实测就是 `skill-catalog` / `agent-instructions` / `@deepseek-ai/dsh-system-prompt` 快照；而标题生成复用同一会话 route 且带 `sessionId`，不看 `purpose` 会把「起个标题」当成一轮真实 prompt 送进同一个 ACP 会话。
    - 证据：[src/impl.ts](file:///home/pax/coding/dsh-ntr/src/impl.ts) 的 `selectForwardPrompt`、[src/bridge.ts](file:///home/pax/coding/dsh-ntr/src/bridge.ts) 的 `streamPrompt`、[tests/impl.spec.ts](file:///home/pax/coding/dsh-ntr/tests/impl.spec.ts) 与 [tests/bridge.spec.ts](file:///home/pax/coding/dsh-ntr/tests/bridge.spec.ts) 的注入过滤/purpose 用例、[docs/acp-mode.md](file:///home/pax/coding/dsh-ntr/docs/acp-mode.md) §1（含真实会话日志的 seq 证据）。

17. **ACP 模式是一个 agent preset；loop 不可替换，权限裁决交给 agent 自己**
    - 规则（表达）：ACP 模式必须表达为 agent preset（[presets/acp/acp.patch.yml](file:///home/pax/coding/dsh-ntr/presets/acp/acp.patch.yml) 的 `preset-acp` 声明）：`persona` 行 `complete: true` + `includeRuntimeContext: false`、**不挂**工具行 / `agent-instructions` / `tool-skill` / plan-mode / todo / compaction / 委派行，外加 `acp-guard.mjs` 的 `agent/pre-step` 兜底过滤（该行以包名 `dsh-ntr/acp-guard` 引用，见约束 21）。**严禁**试图用 preset 替换 `dsh-agent-loop`（`ctx.agents.setFactory` 只允许一个 factory，第二个抛错），也**严禁**由 preset 或宿主侧宣称能屏蔽非 ACP 模型（宿主 `buildModelCatalog` 无 per-session 过滤 seam）；模型选择面只能由浏览器半区的座位遮蔽承担，见约束 20。
    - 规则（权限）：ACP 会话的裁决必须走 `decidePermission(..., { narrateOnly: true })`：`danger-full-access` 与读类 kind 放行，其余交人类（`ask`），但 `approval === 'never'` 仍本地 `reject`（宿主没有可问的人）；`fs/write_text_file` 的 `authorizeWrite` 栅栏**保留**，且**不向 agent 叙述**任何边界（prompt 严格等于用户文本，见约束 15）。非 ACP 会话语义一字不变。
    - 规则（判定）："是否 ACP 会话"必须读会话日志的 preset（`sessionAgentPreset`，镜像 `dsh-agent-presets` 的 `resolveSessionPreset`，经 `setAcpModeResolver` 注入），**严禁**自建标记位。
    - 原因：ACP agent 是另一个进程里的另一个 agent，宿主对模型可见的一切（身份、工具 schema、项目指令、技能目录、运行上下文、plan mode、compaction）描述的都不是它；而 DSH 的文件沙箱对它没有作用力，所以「模式只管裁决 + 保留 fs 栅栏」是唯一既诚实又能挡住的组合。
    - 证据：[presets/acp/](file:///home/pax/coding/dsh-ntr/presets/acp)、[src/bridge.ts](file:///home/pax/coding/dsh-ntr/src/bridge.ts) 的 `setAcpModeResolver`、[src/impl.ts](file:///home/pax/coding/dsh-ntr/src/impl.ts) 的 `decidePermission`/`sessionAgentPreset`、[docs/acp-mode.md](file:///home/pax/coding/dsh-ntr/docs/acp-mode.md)。

18. **对话内的 ACP 面必须复用宿主事实源（模型面 / 权限投影），ACP 视图读的是 ACP transcript 而不是 native 聊天**
    - 规则（路由写入）：composer 的 ACP 芯片（`conversation.input.left`，[src/client/session-controls.tsx](file:///home/pax/coding/dsh-ntr/src/client/session-controls.tsx)）**严禁**自建 agent/model/effort 状态——"在哪条路由上"只能读 `ctx.modelDirectories.directoryFor(sessionId)`（`useDirectory`）的 `current` 并写入 `directory.select({ provider: 'acp', model: 'agentId[@choice]' , reasoningEffort? })`；而"这个 agent 有哪些模型/思考等级"只能读 `agent/catalog`（约束 8 的座位面，`AcpStore.loadAgentCatalog`）——**严禁**再从目录的 `groups` 里取 `acp` 组（那里永远没有它）；`exposedModels` 只是**可见性**过滤（不改变可用性），所以会话当前所在的变体即使不在 base/变体列表里，也必须以带「当前」的行列在列表顶部（否则 picker 会默认成“会话跑的是默认模型”）。切模型时的新 effort 取该 agent 的 `reasoning.defaultEffort`（与原生座位 `ui-model-selection` 的规矩一致），切 agent 传裸 `agentId`。会话权限档只允许经 `SessionFace.command('/permission <preset>')` 切（投影数据来自被 `dsh-permission-presets` 独占注册的 `permissions` 投影），**严禁**复制一份本地开关或试图替换原生 Access mode 控件。注意该投影的 view **只有 `{ currentValue }`**——可切换的行是进程级 `permissionPresets.catalog`（remote 服务）的，两处经 `joinPermissionSelect` 拼装后再进菜单；曾把 `options` 声明进投影类型、在 `boundarySection` 裸读 `options.length`，一次渲染 throw 让 slot 错误边界把整个 picker 条目 abdicate，表现为「座位点击毫无反应」且无任何报错（菜单模型构建也因此必须留 try/catch 兜底，错误显示在菜单内而不是让条目去死）。
    - 规则（服务解析）：`modelDirectories` / `sessions` **严禁**写进 [`src/client/index.tsx`](file:///home/pax/coding/dsh-ntr/src/client/index.tsx) 的 `inject`（缺服务会让插件整体加载失败），只能经 `service<T>(name)` 在调用点 `ctx.get` 解析；`directoryFor` 的 throw 必须 try/catch，但**严禁**把结果 memo 成永久 `undefined`：`ModelDirectoryResolver.directoryFor` 有**两种**合法失败——address subagent 会话（设计如此）与会话运行期 scope 尚未物化（真实实例实测报 `cannot get property "remote.session" without inject`，页面加载后约 0.2s，命中的正是当台会话）。前者是不渲染，后者只是「还没好」，所以 `useDirectory` 必须有界重试（`resolveDirectory` + 定时重试，拿到目录后停止）——一次性 memo 会让整页 ACP 芯片永久消失（实测确认过）。
    - 规则（codec）：`splitAcpModelId`（[src/client/acp-ui.tsx](file:///home/pax/coding/dsh-ntr/src/client/acp-ui.tsx)）是宿主 `splitAdapterModelId` 的**手拷贝**（浏览器半区不得 import 宿主平面模块，`protocol.ts` 又只能是纯类型），改其一必须同步另一处；[tests/acp-view.spec.ts](file:///home/pax/coding/dsh-ntr/tests/acp-view.spec.ts) 用同一样本集对两个实现做等价断言。
    - 规则（视图）：真工具卡只能在 `conversation.view` 的 ACP tab（[src/client/acp-view.tsx](file:///home/pax/coding/dsh-ntr/src/client/acp-view.tsx)）里画，数据必须走 `session/chat-transcript`（按 **DSH 聊天会话 id** 寻址，因为浏览器在看到 `session/chat-transcript` 返回前并不知道 ACP 会话 id）；**严禁**让 LLM adapter 去旁路转发工具调用事件，也严禁在此视图里做 prompt/cancel/spawn（它只读）。流式更新靠 store 把 SSE 的 `session/update` 折进被观察的 transcript（`chatTranscripts` + `MAX_WATCHED` 上限），**严禁**让视图自己轮询。
    - 规则（钩子身份）：`useDirectory`/`usePermissionSelect` 必须以**解析函数**（`directoryFor`/`faceFor`）而不是携带它们的对象做 useMemo 依赖——每次渲染新建的对象会让目录每帧重新解析+重新 load，形成 RPC 死循环。
    - 原因：模型选择与权限档的权威状态在宿主，芯片只是它的一层投影；而原生聊天平面的 chunk 词表只有 text/reasoning，对端 agent 的工具调用/计划/diff 在那里永远只能是一行散文，所以它们必须有一个自己的视图座位，否则「ACP 工具卡」只能是空话。
    - 证据：[src/client/session-controls.tsx](file:///home/pax/coding/dsh-ntr/src/client/session-controls.tsx) 的 `AcpSessionControls`/`AcpSessionMenu`/`menuFor`、[src/client/acp-ui.tsx](file:///home/pax/coding/dsh-ntr/src/client/acp-ui.tsx)、[src/client/acp-view.tsx](file:///home/pax/coding/dsh-ntr/src/client/acp-view.tsx) 的 `diffRows`、[src/client/store.ts](file:///home/pax/coding/dsh-ntr/src/client/store.ts) 的 `loadChatTranscript`/`chatTranscriptOf`/`foldWatched`、[src/bridge.ts](file:///home/pax/coding/dsh-ntr/src/bridge.ts) 的 `chatTranscripts`、[tests/store.spec.ts](file:///home/pax/coding/dsh-ntr/tests/store.spec.ts) 与 [tests/bridge.spec.ts](file:///home/pax/coding/dsh-ntr/tests/bridge.spec.ts) 的 "observed chat transcripts" 套件、[docs/acp-mode.md](file:///home/pax/coding/dsh-ntr/docs/acp-mode.md) §5。

19. **空闲释放只针对「没有活动会话」的进程，且必须走 released 保留路径**
    - 规则（范围）：`AgentBridge.releaseIfIdle` 只允许释放 `state === 'ready'` 且没有任何 live session、没有进行中的探测（`pendingProbes`）/恢复（`resuming`）/待答审批（`permissions`）的 bridge。**严禁**把有活动会话的 agent 也释放掉——那是把「常驻进程」问题换成每条消息一次冷启动。该判据由 `isQuiet()` 独占实现，约束 15 的「就地重启」（把进程搬到会话工作区）复用同一谓词：两处复制会漂移，而「能否丢掉这个子进程」是绝不能有两种答案的问题。
    - 规则（动作）：释放必须走 `releaseAll(reason)` 而**不是** `stop()`——`stop` 会 `released.clear()`，等于顺手毁掉早先崩溃遗留、尚未恢复的会话上下文；释放**静默进行，严禁广播 `agent/notice`**——空闲释放是预期生命周期事件，不是故障，面板状态回落「已配置」就是全部可见变化（2026-09-25 按用户要求移除 release notice）；`agent/notice` 只留给异常或伴随用户动作的事件（探测失败、权限超时、就地搬迁工作区）。
    - 规则（计时）：只有 `ready` 才武装定时器；延迟按 `lastActivityAt + currentIdleTimeoutMs` 计算，检查判定为「忙」时必须 `touch()` 重置窗口，否则会在有会话的 bridge 上以 0ms 延迟自旋。窗口分两档（`currentIdleTimeoutMs`）：**从未登记过真实会话**的 bridge（`everHostedSession === false`，即探测拉起的进程，`probeConfigOptions` 刻意不登记会话）无条件走 `DEFAULT_TUNING.probeIdleTimeoutMs`（默认 5 分钟）——`def.idleTimeoutMs`（含 `0` = 永不释放）是关于**聊天进程**的承诺，不管探测进程；第一个登记的会话（`createSession` / `doResumeSession`）把 bridge 翻转为 `def.idleTimeoutMs ?? DEFAULT_TUNING.idleTimeoutMs`（默认 30 分钟，`0` = 永不释放，`validateAgentDef` 只接受 0 或 [1000, 86400000] 的整数），翻转时必须 `clearIdleTimer()` 再 `touch()` 重排定时器（旧定时器的延迟是按旧窗口算的）。`AgentView.idleTimeoutMs` 必须继续报告**聊天窗口**语义（`idleTimeoutMs` getter，面板拿它预填表单与展示），**严禁**改成报告当前生效的探测窗口；浏览器半区的 `DEFAULT_IDLE_RELEASE_MS` 是默认值的**手拷贝**（仅作新 agent 的占位文本，改常量必须同步）。
    - 原因：模型探测（`probeConfigOptions` 刻意不登记会话）、保存后的后台探测、启动预热都会拉起不留会话的进程；「设置面板是配置面不是运行面」意味着这类探测进程只能短暂存活（5 分钟），真正承载聊天的进程才有资格谈 agent 自己的常驻策略——而释放有会话的进程代价是冷启动 + `session/load` 回放。
    - 证据：[src/bridge.ts](file:///home/pax/coding/dsh-ntr/src/bridge.ts) 的 `releaseIfIdle`/`armIdleRelease`/`touch`/`currentIdleTimeoutMs`/`everHostedSession`/`view`、[src/impl.ts](file:///home/pax/coding/dsh-ntr/src/impl.ts) 的 `validateAgentDef`、[src/client/panel.tsx](file:///home/pax/coding/dsh-ntr/src/client/panel.tsx) 的 `idleValid`/`resolvedIdleTimeoutMs`、[tests/bridge.spec.ts](file:///home/pax/coding/dsh-ntr/tests/bridge.spec.ts) 的 "idle release (isolated manager)" 套件。

20. **ACP 模式的模型选择面靠「遮蔽原生座位」实现，必须动态注册且失败一律放开**（另一半是约束 8 的"宿主不广告 ACP 模型"：两条合起来才是双向隔离——非 ACP 会话看不到 ACP 模型，ACP 会话看不到别的 provider）
    - 规则（机制）：`conversation.input.model` 是 single 槽但**按 `priority` 遮蔽**（同一 cell 上最低 priority 的活跃条目渲染；同 priority 重复注册才 throw）。遮蔽以 `priority: -1` 注册（动态插件 runner 会给它一个自己的 auto rank，这个数字是声明不是保证书）。
    - 规则（winner 竞争）：动态插件 runner（`dsh-cordis-client-runner` 的 `guardedSlots`）给每个包一个 auto rank，别的动态座位插件（如 `dsh-thinking-effort`）同样占这个 cell，实测出现过「我们的条目已注册、cell head 却是对方」。保住座位必须：注册后读渲染器 winner 视图（`ctx.slots.entriesOfSlot`），head 不是自己时**另注册一条显式更低 rank（`min(head-1, -100)`）**的条目（独立组件身份防 dedup）。**严禁**用「退了重注册」竞争——runner 的 load 收敛会把新贡献整个吞掉（实测 cell 里只剩对方）；同包 exact-priority 重复注册也会 throw。堆叠上限 4 次，stack 由 `dropSeat` 整体回收。
    - 规则（闸门）：注册必须动态——只读客户端 session list 的当前会话 `agentPreset === ACP_PRESET_ID`（`shouldShadowModelSeat`，经 `stagedSessionOf` 派生「舞台上的是谁」），切走即 dispose 让原生座位回来。**严禁**常驻注册：插件 API 无法渲染被遮蔽的那一条（`entriesOfSlot` 只在 renderer host 上），常驻等于把非 ACP 会话的原生座位永久顶掉。
    - 规则（session list 快照两代形态，结构性读取必须兼容两者）：DSH 0.1.7-rc.2 的 `ctx.sessions.list` 快照是 `{ ids, byId, phase, projectionsBySession }`——**没有 `current` 也没有 `currentAddress`**；舞台上会话 = `retainedBy.mainView > 0` 的行（`dsh-client-ui-session` 同款选法），preset 在 `byId[id].projectionValues.agentPreset`（`agent-preset/selected` 日志事件的投影折叠，值即 preset `id`），subagent 行以 `origin === 'subagent'` 标记。旧运行时才是 `{ current, currentAddress, byId[id].agentPreset }` 顶层字段。2026-09-26 曾只按旧形态读取，`snapshot.current` 在 rc.2 上恒 `undefined` → 座位永不接管（切换到 ACP 模式原生模型座位纹丝不动的直接根因）。preset/快照读取一律经 `stagedSessionOf`/`rowAgentPreset`（[src/client/acp-ui.tsx](file:///home/pax/coding/dsh-ntr/src/client/acp-ui.tsx)），不要再手写 `snapshot.current` / `byId[..].agentPreset`。
    - 规则（失败放开）：服务未就位 / 槽位未声明 / 注册被拒 / 当前是 addressed subagent 路由 / 座位自身渲染崩溃（`slots.onEntryError` 的 abdicate）都必须回到原生座位并清掉「座位已接管」标志（芯片随之回来），崩溃后本次会话不再重试（`seatBroken`）。唯一允许的失败模式是「不接管」。
    - 规则（同步）：浏览器半区的 `ACP_PRESET_ID`、宿主侧的 `ACP_PRESET_ID`（[src/bridge.ts](file:///home/pax/coding/dsh-ntr/src/bridge.ts)）与声明里的 `config.id`（[presets/acp/acp.patch.yml](file:///home/pax/coding/dsh-ntr/presets/acp/acp.patch.yml)）必须三处一致（属约束 7 的手拷贝纪律）。
    - 原因：宿主平面没有 per-session 目录过滤 seam（`buildModelCatalog` 全量遍历 `ctx.llm.listProviders()`），而 ACP preset 下非 ACP 模型在会话里既没有工具、也不是对端 agent；座位遮蔽是唯一能真正少列模型的接缝（反方向的"ACP 模型不进非 ACP 会话"由约束 8 的"不广告"承担），但它跨插件接线，任何不确定都必须选「不接管」。
    - 证据：[src/client/index.tsx](file:///home/pax/coding/dsh-ntr/src/client/index.tsx) 的 `syncModelSeat`/`ensureSeatWins`/`dropSeat`/`onEntryError`、[src/client/acp-ui.tsx](file:///home/pax/coding/dsh-ntr/src/client/acp-ui.tsx) 的 `stagedSessionOf`/`rowAgentPreset`/`shouldShadowModelSeat`/`ACP_PRESET_ID`、[src/client/session-controls.tsx](file:///home/pax/coding/dsh-ntr/src/client/session-controls.tsx) 的 `AcpModelSeat`/`menuFor('seat')`、[tests/acp-view.spec.ts](file:///home/pax/coding/dsh-ntr/tests/acp-view.spec.ts)、[docs/acp-mode.md](file:///home/pax/coding/dsh-ntr/docs/acp-mode.md) §5（runner priority 语义实测），以及桌面 asar 内 `@deepseek-ai/dsh-api-session-controller` 的 `projectList`/`buildListSnapshot` 与 `@deepseek-ai/dsh-agent-preset-registry` 的 `ctx.emit("agent-preset/selected", …)`（rc.2 快照形态第一手来源）。

21. **agent preset 只能由 bundle patch 声明；`~/.dsh/.agent-presets/` 目录已死；声明里的插件名按 profile 基准解析**
    - 规则（载体）：ACP 模式的存在形式只有一种——本包 package.json 的 `dsh.bundle.patch` 列出的 patch 里那条 `- id: preset-<id> / name: '@deepseek-ai/dsh-agent-preset' / config.{id,name,description,order,plugins}` 声明（当前为 `presets/acp/acp.patch.yml`）。**严禁**再往 `$DSH_HOME/.agent-presets/<id>/` 复制 `preset.yml` / `agent.cordis.yml`（或任何别的文件），也**严禁**新增“安装/修复 preset”的配置项或按钮：那个目录没有任何读取方，复制进去的文件既不进 roster，也不证明模式可用——曾有人按它显示"已安装"却看不到模式。
    - 规则（解析基准）：声明里 `config.plugins` 的插件名按**声明者 Loader 的解析基准**（profile 目录）解析，相对路径（`./acp-guard.mjs`）会落到 profile 目录里不存在的文件上，导致整条声明激活失败、模式从选择器消失。随包的本地插件只能经**包名子路径**引用（`dsh-ntr/acp-guard` ← package.json `exports` 映射到 `presets/acp/acp-guard.mjs`）；`patch.insert` 顶层与 group 行才会被 app-boot 的 `anchorInsertedPluginNames` 改写成 patch 文件旁的绝对路径。
    - 规则（状态）：面板读的是**宿主 roster**（`ctx.agentPresets.list()` 的 `preset-acp` 行，`acpPresetStatusFromRoster` 折叠，激活失败时原样显示 `broken`）；服务缺席时 `preset/status` 答 `null` 让面板整块隐藏。`preset/install` 已随旧机制删除——`preset/status` 只读，且**严禁**在插件自己的 `apply()` 里调 `list()`（registry 审计要等 Host 树 settle，会等在自己身上）。
    - 原因：0.1.7-rc.1 起 preset 是"bundle patch 里的声明"，旧的目录 roster 被移除；这次升级让 ACP 模式的 chip 直接消失，而插件当时还在往旧目录复制文件、并按那个目录的存在与否报告"已安装"。
    - 证据：[presets/acp/acp.patch.yml](file:///home/pax/coding/dsh-ntr/presets/acp/acp.patch.yml)、package.json 的 `dsh.bundle.patch`/`exports`、[src/impl.ts](file:///home/pax/coding/dsh-ntr/src/impl.ts) 的 `acpPresetStatusFromRoster`/`ACP_PRESET_SOURCE`、[src/index.ts](file:///home/pax/coding/dsh-ntr/src/index.ts) 的 `wirePresetRoster`、[src/bridge.ts](file:///home/pax/coding/dsh-ntr/src/bridge.ts) 的 `setPresetRosterReader`/`presetStatus`、[tests/bridge.spec.ts](file:///home/pax/coding/dsh-ntr/tests/bridge.spec.ts) 的 preset 声明套件、[docs/acp-mode.md](file:///home/pax/coding/dsh-ntr/docs/acp-mode.md) §2。

22. **部署默认模型（`agentDefaultModel`）绝不落在 ACP 路由上；插件自己的默认 agent 只存自己的状态**
    - 规则（隔离）：任何地方都**严禁**把 `acp@<agentId>` 写成部署默认模型。DSH 的 `session.selectModel` 对每次选择写两份（会话自己的路由 + 全局默认模型，后者不分会话不分模式），一次 ACP 选择会让**所有模式的新会话**从对端 agent 起步。宿主侧 `AcpDefaultModelGuard`（[src/impl.ts](file:///home/pax/coding/dsh-ntr/src/impl.ts)）负责把 `acp` 默认改回上一个原生路由，候选顺序：调用方写入前的原生路由 → 已知原生默认 → `lastNativeRoute`（live 会话里最近的原生路由）；一个候选都没有时**严禁**动原值，必须如实报 `stranded`。守卫在每轮 prompt 前（`streamPrompt`）与宿主启动时各复查一次，服务缺失即惰性。
    - 规则（默认 agent）：ACP 模式的初始路由只能来自插件自己的 `defaultAgentId`（`~/.dsh/acp-agents.json`，RPC `model/get-default` / `model/set-default`，面板 ★），**严禁**复用它代表 DSH 的默认模型；删除 agent 必须同时清空该指针。浏览器半区**每一处**写 ACP 路由必须经 `selectAcpRoute`（[src/client/acp-ui.tsx](file:///home/pax/coding/dsh-ntr/src/client/acp-ui.tsx)）——它先读该会话写入前的路由再写入、并把 `previous` 递给守卫；**严禁**直接写 `directory.select`。座位 gate 只对**还没有自己的路由选择**的会话自动路由（`sessionHasOwnSelection` 读 `modelSelection` 投影；读不到或已有选择都不动），每条会话只尝试一次。
    - 原因：宿主没有 per-session 的默认模型概念，全局那份是唯一事实源；写脏了就是 ACP agent 跨模式泄漏（对端 agent 会收到宿主的工具 schema）。而 `previous` 是守卫精确回滚的唯一依据，绕开 `selectAcpRoute` 就只能靠猜。
    - 证据：[src/impl.ts](file:///home/pax/coding/dsh-ntr/src/impl.ts) 的 `AcpDefaultModelGuard`/`lastNativeRoute`、[src/bridge.ts](file:///home/pax/coding/dsh-ntr/src/bridge.ts) 的 `setDefaultModelGuard`/`reconcileDefaultModel`/`defaultAgent`/`setDefaultAgent`/`loadPersistedAgents`、[src/index.ts](file:///home/pax/coding/dsh-ntr/src/index.ts) 的 `wireDefaultModelGuard`、[src/client/acp-ui.tsx](file:///home/pax/coding/dsh-ntr/src/client/acp-ui.tsx) 的 `selectAcpRoute`/`sessionHasOwnSelection`、[src/client/index.tsx](file:///home/pax/coding/dsh-ntr/src/client/index.tsx) 的 `ensureAcpRoute`，与 [tests/impl.spec.ts](file:///home/pax/coding/dsh-ntr/tests/impl.spec.ts) / [tests/bridge.spec.ts](file:///home/pax/coding/dsh-ntr/tests/bridge.spec.ts)（`deployment default model guard` 套件）/ [tests/store.spec.ts](file:///home/pax/coding/dsh-ntr/tests/store.spec.ts)（`ACP route writes keep the deployment default native` 套件）。

23. **一个 ACP 轮次的收尾时机属于对端 agent，宿主不得“替它收尾”**
    - 规则：`turn/end` 只在 `session/prompt` 的**响应**返回时发出（`AgentBridge` 的 turn 生命周期），**严禁**为“agent 不再吐字但仍在 running”新增任何按空闲计时强制定稿的兜底。唯一允许的强制定稿是 `session/cancel` 之后的 `armCancelFallback`（用户已叫停，见约束 12），两者语义不同，不得复用。
    - 原因：宿主无法区分“agent 正在想”与“agent 在忙自己的事”，提前发 `turn/end` 会把真实答案切在流中间（比多显示几秒 running 更坏）。实测边界（codebuddy 首轮）：它先完成自己的内部标题生成才回应 prompt，期间一个通知都不发（它自己的日志 `Timed out waiting for pending title generation … timeoutMs=5000`），首轮可视收尾因此推迟约 5s。这是**记录在案的边界，不是宿主侧的 bug**。
    - 证据：[src/bridge.ts](file:///home/pax/coding/dsh-ntr/src/bridge.ts) 的 turn 生命周期与 `armCancelFallback`、[docs/acp-mode.md](file:///home/pax/coding/dsh-ntr/docs/acp-mode.md) §5。

24. **路径判定与比较必须走跨平台原语，严禁新增 `startsWith('/')` 类 POSIX 假设**
    - 规则：绝对路径判定只能用 `isAbsolutePath`（[src/impl.ts](file:///home/pax/coding/dsh-ntr/src/impl.ts)：接受 POSIX `/…`、盘符 `C:\…`/`C:/…`、UNC `\\host\share…` 与 `//host/share…`，按字符串头判定风格；`\\?\…`/`//?/…` 扩展长度形式**不算绝对路径**（`isExtendedLength`），于是配置校验当场报 absolute 而不是存下一个永远解析不出的 cwd，`canonicalizeFsPath` 也先于相对拼接分支显式拒绝它）。containment 一律走 `isUnderPath`（win32 风格的双方做 `\`→`/` 分隔符与大小写折叠后再比，POSIX 保持字节精确，非绝对 root 一律不含，`/` 根只含 POSIX 形式的绝对路径）。**风格判定必须认两种分隔符写法**：`\host\share` 与 `//host/share` 都是 win32 风格——`foldSeparators` 把每个盘上 UNC 结果折成 `//` 形式，只认反斜杠就等于在规范化之后丢掉大小写折叠（`//SRV/SHARE/x` 会被判为不在 `\\srv\share` 内），`segmentize` 也一直把 `//host/share` 当 UNC，两处必须一致。`canonicalizeFsPath` 的段级拼装基于 `segmentize`/`collapseSegments`/`joinWithin`（相对请求只在 session cwd 是 win32 风格时折叠 `\`），请求就是根自身时返回根的绝对写法（`/`、`C:/`）而非去尾斜杠后的 `''`/`C:`；`resolveSessionCwd`/`canonicalizeFsPath` 的 realpath 结果经 `foldSeparators` 以 `/` 形式返回。浏览器半区的表单校验必须用 `isAbsolutePathLike`（[src/client/acp-ui.tsx](file:///home/pax/coding/dsh-ntr/src/client/acp-ui.tsx)），它与宿主 `isAbsolutePath` 是又一对「手拷贝 + tests/acp-view.spec.ts 样本集等价断言」（同 `splitAcpModelId` 纪律）。
    - 原因：插件最初只在 POSIX 上开发；Windows 上 `validateAgentDef` 会拒绝一切 `C:\…` 路径，`loadPersistedAgents` 随之把持久化 agent 静默丢光（`defaultAgent()` 变 undefined），聊天会话的 cwd 解析也全线 `bad_cwd`/`cwd_denied`——桌面版（Windows）整条链不可用（2026-09 修复）。`impl.ts` 不能 import node:path，这些原语必须手写，realpath 语义仍靠注入。
    - 证据：[src/impl.ts](file:///home/pax/coding/dsh-ntr/src/impl.ts) 的 `isAbsolutePath`/`isExtendedLength`/`isUnderPath`/`isWin32Style`/`segmentize`/`canonicalizeFsPath`、[src/client/acp-ui.tsx](file:///home/pax/coding/dsh-ntr/src/client/acp-ui.tsx) 的 `isAbsolutePathLike`、[tests/impl.spec.ts](file:///home/pax/coding/dsh-ntr/tests/impl.spec.ts) 的 "cross-platform paths (Windows)" 套件（含盘上大小写与配置不一致的 UNC realpath fixture、根自身请求、`\\?\` 校阶拒绝），[tests/acp-view.spec.ts](file:///home/pax/coding/dsh-ntr/tests/acp-view.spec.ts) 的两侧等价样本集。

25. **`/acp` 通道注册必须用 owner 显式的 `connection.register`；`rpc.handle` 在 0.1.7-rc.x 桌面 composition 上不可用**
    - 规则：`ctx.connection.rpc.handle('/acp', …)` 在 rc.2 运行时上必然失败——`.rpc` getter 经 Cordis traceable shadow 把路由 owner 绑回 Connection 服务**自己的 ctx**（composition 里 `inject` 只有 `credentials`/`webRuntime`），effect 回调里的 `owner.webServer` 服务查找从那里重新扎根，跨 isolate 围栏即抛 `cannot get property "webServer" without inject`，宿主半区整条 entry 不激活，所有 `POST /acp/*` 落到 frontend-static 的 GET-only fallback（**HTTP 405**），浏览器端表现为「transport failure for /acp/&lt;endpoint&gt;: HTTP 405」。注册必须走私有的 `register(owner, channel, handler)`（类型上不在 `HostConnectionHandle` 公开面，见 `ChannelRegisteringConnection` 结构类型 + typeof 探测）并**显式传插件自己的 ctx**（它声明了 `webServer`）；`register` 缺失时回落 `rpc.handle`（老 cordis 无围栏，两条路等价），`register` 存在但**调用抛错**时同样回落（视同缺失），返回值不是 effect 需要的 disposer 时**保留这次注册**并交一个空 disposer（此时再调 `rpc.handle` 会重复注册同一前缀）。信封协议、鉴权围栏、404/415 语义仍全部由 Connection 自己的路由实现，不得手写 webServer 裸路由复制协议。
    - 原因：`rpc.handle` 文档语义是「scoped to the Context reading this service」，但 shadow 实现把查找起点固定在 Connection 的构造 ctx，外部插件声明的 inject 完全不被看见（核心 gateway 插件因此只用 `intercept` + 自持 webServer 路由，从不调 `handle`）。诊断路径：`transport failure … HTTP 405` ⇒ frontend-static fallback（非 GET/HEAD 一律 405）⇒ `/acp` prefix 路由未注册 ⇒ 宿主崩溃日志里 `dsh-ntr: cannot get property "webServer" without inject`。桌面离线 bench（临时 `DSH_HOME` + asar 内 CLI `--profile <bench> --port <free>`）可完整复现并端到端验证修复（注册成功后未认证探测回 401，带 cookie 回 200 信封）。
    - 证据：[src/index.ts](file:///home/pax/coding/dsh-ntr/src/index.ts) 的 `/acp` 通道注册处与 `ChannelRegisteringConnection`、[tests/register.spec.ts](file:///home/pax/coding/dsh-ntr/tests/register.spec.ts) 的 "prefers the owner-explicit channel register"、桌面崩溃日志 `%APPDATA%/@deepseek-ai/dsh-desktop/logs/`（2026-09-25）。

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
  3. 若字段需在面板编辑：同步 protocol.ts 的 `AgentSavePayload` 与 panel.tsx 的 `initialForm`（表单初值）、`buildPayload`（保存 payload 组装）与 `payloadEquals`（脏检查）；`AgentForm` 新增字段必须三处都到。涉及默认命令预设时，遵守约束 7 的两处同步。
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
  - [`tests/acp-view.spec.ts`](file:///home/pax/coding/dsh-ntr/tests/acp-view.spec.ts)：浏览器半区纯函数（ACP 视图的 `diffRows` 行级 diff，以及 `splitAcpModelId` 与宿主 `splitAdapterModelId` 的等价性）。**该文件会 import 客户端模块**，因此新增的浏览器半区纯逻辑放这里，不要塞进 impl.spec（后者必须保持零客户端依赖）。

## 领域术语表

- **Host Half / Browser Half**：DSH 插件双端架构，分别对应 Node 宿主服务与浏览器端 UI 模块。
- **Transcript**：宿主端为每个会话维护的有界环形缓冲队列，用于重连后按序列号补齐。
- **Model Catalog**：宿主端为每个 agent 维护的 `model` / `thought_level` 配置目录（源自 ACP `configOptions`），经 `agent/catalog` 喂给对话内的 ACP 座位（`base` 条目 + `agent@choice` 变体 + `reasoning` 思考等级元数据）。DSH 自己的模型目录里**没有** ACP 条目（约束 8）。
- **exposedModels**：per-agent 的座位可见性过滤（模型 choice value 列表）。未设置（或空）= 不提供任何变体，只有 `base` 条目；设置后仅列出的变体进入座位菜单，`base` 始终可见；只影响 `agentCatalog` 的变体展开，不影响 `resolveAdapterModel`。

---

## 本文档有意未包含的内容

- 完整依赖项与具体版本列表：见 [package.json](file:///home/pax/coding/dsh-ntr/package.json)
- TypeScript 编译选项与模块解析策略：见 [tsconfig.json](file:///home/pax/coding/dsh-ntr/tsconfig.json)
- DSH 宿主机制（Cordis 生命周期、WebServer 路由、UI slots、cordis.patch.yml 语义）：实现插件侧新能力前读 [docs/dsh-plugin-development-guide.md](file:///home/pax/coding/dsh-ntr/docs/dsh-plugin-development-guide.md)；DSH 官方源码路径见 [docs/README.md](file:///home/pax/coding/dsh-ntr/docs/README.md)
- UI 交互组件 JSX 结构与 CSS 样式细节：见 [src/client/panel.tsx](file:///home/pax/coding/dsh-ntr/src/client/panel.tsx)
- ACP 协议层完整规范与消息格式：实现/调试 ACP 方法语义时查 `node_modules/@agentclientprotocol/sdk` 的类型定义与官方文档
