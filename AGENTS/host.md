# 宿主接线

本文是 [AGENTS.md](../AGENTS.md) 的展开层，覆盖与 DSH 宿主平面的接线点：`/acp` 通道、agent preset 声明、可选服务探测。

## 1. `/acp` 通道注册

`ctx.connection.rpc.handle('/acp', …)` 在 0.1.7-rc.x 桌面 composition 上**必然失败**。

- `.rpc` getter 经 Cordis traceable shadow 把路由 owner 绑回 Connection 服务自己的 ctx（composition 里 `inject` 只有 `credentials` / `webRuntime`）。
- effect 回调里的 `owner.webServer` 服务查找从那里重新扎根，跨 isolate 围栏即抛 `cannot get property "webServer" without inject`。
- 宿主半区整条 entry 不激活，所有 `POST /acp/*` 落到 frontend-static 的 GET-only fallback（**HTTP 405**）。浏览器端表现为 `transport failure for /acp/<endpoint>: HTTP 405`。

**正确做法**：走私有的 `register(owner, channel, handler)`（类型上不在 `HostConnectionHandle` 公开面，用 `ChannelRegisteringConnection` 结构类型 + typeof 探测），并**显式传插件自己的 ctx**（它声明了 `webServer`）。

- `register` 缺失时回落 `rpc.handle`（老 cordis 无围栏，两条路等价）。
- `register` 存在但**调用抛错**时同样回落（视同缺失）。
- 返回值不是 effect 需要的 disposer 时，**保留这次注册**并交一个空 disposer（此时再调 `rpc.handle` 会重复注册同一前缀）。
- 信封协议、鉴权围栏、404 / 415 语义仍全部由 Connection 自己的路由实现，不得手写 webServer 裸路由复制协议。

诊断路径：`transport failure … HTTP 405` ⇒ frontend-static fallback ⇒ `/acp` prefix 路由未注册 ⇒ 宿主日志 `dsh-ntr: cannot get property "webServer" without inject`。

## 2. agent preset 声明

NTR 模式的存在形式只有一种：本包 `package.json` 的 `dsh.bundle.patch` 列出的 patch 里那条 `preset-<id>` 声明（当前为 `presets/acp/acp.patch.yml` 的 `preset-acp` 行），内容为 `name: '@deepseek-ai/dsh-agent-preset'` + `config.{id,name,description,order,plugins}`。

- **载体**：**严禁**再往 `$DSH_HOME/.agent-presets/<id>/` 复制 `preset.yml` / `agent.cordis.yml` 或任何别的文件。那个目录没有任何读取方，复制进去既不进 roster，也不证明模式可用。**严禁**新增「安装 / 修复 preset」的配置项或按钮。
- **解析基准**：`config.plugins` 的插件名按**声明者 Loader 的解析基准**（profile 目录）解析。相对路径（`./acp-guard.mjs`）会落到 profile 目录里不存在的文件上，导致整条声明激活失败、模式从选择器消失。随包的本地插件只能经**包名子路径**引用（`dsh-ntr/acp-guard` ← `package.json` `exports` 映射到 `presets/acp/acp-guard.mjs`）。`patch.insert` 顶层与 group 行才会被 app-boot 的 `anchorInsertedPluginNames` 改写成 patch 文件旁的绝对路径。
- **状态**：面板读**宿主 roster**（`ctx.agentPresets.list()` 的 `preset-acp` 行，`acpPresetStatusFromRoster` 折叠，激活失败时原样显示 `broken`）；服务缺席时 `preset/status` 答 `null` 让面板整块隐藏。`preset/install` 已随旧机制删除——`preset/status` 只读，且**严禁**在插件自己的 `apply()` 里调 `list()`（registry 审计要等 Host 树 settle，会等在自己身上）。

历史：0.1.7-rc.1 起 preset 改为 bundle patch 声明，旧的目录 roster 被移除。这次升级曾让 NTR 模式的 chip 直接消失，因为插件还在往旧目录复制文件、并按目录存在与否报告「已安装」。见 [acp-mode.md §2](../docs/acp-mode.md)。

## 3. 可选宿主服务的探测

`src/index.ts` 的 `export const inject` **只能**列插件真正依赖的服务。以下服务严禁写进去（缺服务会让插件整体加载失败），只能 `ctx.get` + `ctx.inject([...], …)` 后补注册：

- `sandboxPolicy` / `sessions` —— 工作区根解析（`wireWorkspace` 注入 `BridgeManager.setSessionWorkspaceResolver`，解析结果只有 `{ workspaceRoot }`，不含任何 mode / approval 语义）
- `agentPresets` —— preset roster（`wirePresetRoster`）
- 浏览器侧 `sessions` —— 经 `service<T>(name)` 在调用点惰性解析（见 [ui.md](./ui.md)）

服务缺失必须是**可用性下降**，不是加载失败；可选服务迟到时由 `ctx.inject` 补挂，不得让插件整体不激活。

**宿主审批服务不再是协作方**：权限询问全部走插件自己的 `PermissionLedger` 管线，`approval` / `agents` 不再被探测或调用；宿主的审批策略（`ask` / `never`）不再作用于 ACP 询问，`approval/asked|decided` 也不再为 ACP 询问写入（接受的取舍）。见 [permissions.md](./permissions.md)。

## 4. 不碰宿主的模型层

插件完全不读 `modelDirectories`、不写 `selectModel`、不广告 ACP 模型。`session/chat-bind` 等 RPC 只写插件自己的映射，再由 guard 的 `agent/request` waterfall 接到请求路径上（见 [architecture.md §3](./architecture.md)）。

- `AcpLlmAdapter.listModels('acp')` 必须返回空数组；ACP 模型面走 `agent/catalog`（见 [state.md §4](./state.md)）。
- 已退役的默认模型守卫、路由强制、目录重试机制不要带回来，见 [retired.md](./retired.md)。

## 代码索引

| 主题 | 位置 |
|---|---|
| 通道 | `src/index.ts` · `/acp` 注册处 / `ChannelRegisteringConnection` |
| 服务探测 | `src/index.ts` · `wireWorkspace` / `wirePresetRoster` |
| preset | `presets/acp/acp.patch.yml`；`package.json` · `dsh.bundle.patch` / `exports`；`src/impl.ts` · `acpPresetStatusFromRoster` / `ACP_PRESET_SOURCE`；`src/bridge.ts` · `setPresetRosterReader` / `presetStatus` |
| 模型层 abstain | `src/bridge.ts` · `AcpLlmAdapter.listModels` |
