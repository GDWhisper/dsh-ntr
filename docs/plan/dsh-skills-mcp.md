# DSH 技能只读 MCP 实施计划

- 状态：待实施
- 来源 Issue：[GDWhisper/dsh-ntr#14](https://github.com/GDWhisper/dsh-ntr/issues/14)
- 实施范围：内置零依赖、只读、stdio MCP server `dsh-skills`，只提供 `skills_list` 与 `skill_read`。
- 决策优先级：本文记录最终方案。Issue 中「默认开启」「可配置 `skillsRoot`」等早期提案不采用。

## 0. 新会话接手协议

实施者不需要本会话上下文。开始写代码前完成以下检查：

1. 在仓库根目录运行 `git status --short`，记录已有修改与未跟踪文件。保留这些改动，不覆盖、不回滚、不提交他人工作。
2. 阅读 `scripts/file-size-baseline.json`，确认本次会触碰的存量超限文件及其锁定行数。
3. 遵守根目录 `AGENTS.md`。代码位置统一使用「文件 + 符号名」，不依赖会漂移的行号。
4. 新文件不得超过 1000 行。存量超限文件只能缩短，不能增加行数，不能新增基线条目或抬高基线。
5. 本次计划文档任务不修改代码、测试、配置、`AGENTS/`、`CHANGELOG.md` 或 `lib/`，不提交。后续实施也应先确认用户要求的提交边界。
6. 实施完成时同步更新 `AGENTS/state.md`、`AGENTS/protocol.md`、`AGENTS/ui-panel.md`，不修改 `CHANGELOG.md`，不手改或提交 `lib/`。

## 1. 目标与最终行为

1. 包内新增零第三方依赖的 Node stdio MCP server，名称为 `dsh-skills`。
2. server 只暴露两个工具：
   - `skills_list`：列出可用 DSH 技能及其描述和规范路径。
   - `skill_read`：读取指定技能的 `SKILL.md` 或技能目录内的指定附加文件。
3. 功能默认关闭。用户只能在设置页「智能体」页主动开启。
4. 开关旁提供信息图标。图标使用宿主 `Tooltip`，说明进程、扫描和生效边界。
5. 只通过 ACP `mcpServers` 连接配置向 agent 提供 server。不生成或修改 CodeBuddy 等其他 agent 的原生 MCP 配置。
6. 不默认把技能正文注入提示词。agent 自行决定何时列出和读取技能。
7. 默认关闭时，所有建会话请求都不得声明 `dsh-skills`。
8. 开启后只影响后续建会话、恢复、探测和分叉请求。既有会话不被重写，既有 MCP 进程不保证被关闭。

## 2. 非目标

本期明确不做以下事项：

- 不增加 `skillsRoot` 配置，不允许自定义技能根。
- 不增加新 agent 的默认 `mcpServers` 模板。
- 不实现通用 DSH 宿主工具桥，不把 `ctx.tools` 或宿主工具调用转发给 agent。
- 不提供文件写入、编辑、删除或技能执行能力。
- 不增加 watcher、持久缓存、定时刷新或后台索引。
- 不逐 agent 适配原生 MCP 配置，也不增加逐 agent 的本功能开关。
- 不承诺 agent 到首次 `tools/call` 才启动 MCP 进程。
- 不承诺开关关闭会终止 agent 已经启动的 MCP 进程。

## 3. 进程模型与「懒加载」的准确含义

### 3.1 ACP 与 MCP 的职责边界

- dsh-ntr 是 ACP client，只在 `session/new`、`session/load`、`session/fork` 等请求中传递 MCP 连接配置。
- 对端 agent 是 MCP client。agent 决定是否启动、何时启动、如何保持及如何回收 `dsh-skills` 子进程。
- dsh-ntr 不直接管理这个 MCP 子进程的生命周期，也不提供跨 agent 的进程控制抽象。
- ACP 连接配置无法便携地表达「首次 `tools/call` 才启动进程」。不同 agent 可以在建会话时立即启动并保持进程。
- 因此，开启功能后可能存在随 ACP 会话常驻的 Node 进程。关闭开关不等于回收已经存在的进程。

### 3.2 懒加载只约束文件系统工作

本方案中的懒加载只有以下含义：

- `initialize`、`initialized`、`ping` 和静态 `tools/list` 不扫描技能根，不读取技能目录或技能文件。
- 第一次 `skills_list` 才枚举技能根并读取必要的有界元数据。
- `skill_read` 只解析并读取本次目标，不预先扫描整个技能树，也不要求先调用 `skills_list`。
- 不建立持久技能缓存，不启动 watcher，不创建定时器。
- 后续调用重新读取当前文件系统，因此能观察技能新增、删除和内容变化。

不得把上述行为描述成「首次调用前零进程」「首次调用前零内存」或「真正按需启动进程」。懒加载只减少技能文件系统读取，不决定 agent 的进程策略。

## 4. 技能根与内置 server 定义

### 4.1 固定技能根

技能根固定为：

```text
dirname(pluginStateDir()) / skills
```

其中 `pluginStateDir` 是 `src/bridge/state-paths.ts` 的现有函数。默认部署中它对应宿主技能目录 `~/.dsh/skills`；测试或迁移场景仍遵循 `DSH_NTR_STATE_DIR` 的重定向语义。

`mcp/skills-server.mjs` 是无构建步骤的独立 Node 入口。它必须用相同的规则推导根目录：

- `DSH_NTR_STATE_DIR` 非空时，以其为插件状态目录。
- 否则使用默认插件状态目录。
- 技能根始终是该状态目录的父目录下的 `skills`。
- 不读取新的 `skillsRoot` 配置。

### 4.2 内置连接配置

在 `src/bridge/mcp.ts` 新增 `dshSkillsMcpServer`：

- 返回插件归一化的 `AcpMcpServerDef`，`transport` 为 `stdio`，`name` 固定为 `dsh-skills`。
- `command` 使用 `process.execPath`，不依赖 PATH 中的 `node`。
- server 路径以 `import.meta.url` 定位，经 `fileURLToPath` 转为绝对文件路径，再放入 `args`。
- 路径应同时适用于源码测试和构建后的 `lib/bridge/mcp.js`，最终指向包根目录的 `mcp/skills-server.mjs`。
- 需要重定向测试状态目录时，通过该 server 的 `env` 传递当前 `pluginStateDir()`，避免 MCP 进程读到另一个技能根。
- 不写文件，不安装 server，不修改任何 agent 原生配置。

`src/bridge/mcp.ts` 的 `toAcpMcpServers` 继续作为唯一的线格式转换点。stdio server 最终不得带 `type: 'stdio'`；`env` 仍转换为 `[{ name, value }]`。

## 5. 运行时合并与四个建会话入口

### 5.1 合并器

在 `src/bridge/mcp.ts` 新增 `sessionMcpServers`，作为唯一运行时合并器：

1. 输入为当前 agent 的 `AcpAgentDef.mcpServers`、当前生效的 `skillsMcpEnabled`，以及定位内置 server 所需的当前环境。
2. 开关关闭时，只返回用户配置，不声明内置 server。
3. 开关开启且用户没有同名 `name: 'dsh-skills'` 时，追加内置 server。
4. 用户已有同名 server 时，用户配置优先，跳过内置项，不覆盖、不合并两份同名定义。
5. 返回新数组，不原地修改输入数组、server 对象或 `AcpAgentDef`。
6. 内置项只存在于本次请求的运行时列表，绝不写回 `AcpAgentDef.mcpServers`，也不因持久化而进入 `agents.json` 的 agent 定义。
7. 合并结果继续经 `toAcpMcpServers` 转为 ACP 线格式，不在四个入口各自拼线格式。

### 5.2 四个入口必须使用同一当前配置

修改 `src/bridge/agent-bridge.ts` 的以下符号：

- `openSession`
- `probeConfigOptions`
- `doResumeSession`
- `forkSession`

每个入口都必须在发出请求时读取同一份当前共享 tuning，并调用同一个 `sessionMcpServers`。不得在 bridge 构造时把开关或合并结果固化，也不得只在部分入口注入。

四个入口最终分别用于：

- 新建 ACP 会话的 `session/new`。
- 配置探测创建的临时 `session/new`。
- released 会话恢复的 `session/load`。
- 会话分叉的 `session/fork`。

这是进程级 MCP 作用域的一致性要求。探测或分叉不能传一份不同的列表，尤其不能用空列表顶掉同连接活动会话已有的 MCP 工具。

### 5.3 热应用边界

- 开关写入成功后，只更新 manager 持有的共享 tuning，使后续四个入口看到新值。
- 不调用 `agent/save`，不重启 agent，不中断活动 turn。
- 不向既有会话补发 MCP 配置，不尝试关闭既有 `dsh-skills` 进程。
- 「热应用」仅指后续建会话请求立即使用新开关，不指既有会话原地获得或失去工具。

## 6. 配置、持久化与 RPC 配置流

### 6.1 配置键与状态

配置键固定为 `skillsMcpEnabled`：

- 类型为 boolean，默认 `false`。
- 持久化在 `agents.json` 的全局设置段，不放进单个 agent 定义。
- 启动时缺省、非 boolean 或无法合法恢复的值一律按 `false`。
- `ui/skills-mcp-set` 的非法 RPC 输入不能被当成 `false` 写入；它必须请求失败且不落盘。
- 运行时通过共享 `BridgeTuning.skillsMcpEnabled` 读取，`DEFAULT_TUNING` 提供 `false`。

### 6.2 严格落盘后再更新运行状态

在 `src/bridge/settings-service.ts` 扩展 `SettingsService`、`PersistedSettings` 和 `SettingsHost`：

- 提供当前值读取与 `setSkillsMcpEnabled` 写入入口。
- `loadPersistedSettings` 负责恢复 boolean，缺省或非法值恢复为 `false`。
- `persistedSettings` 负责输出 `skillsMcpEnabled`。
- 写入使用严格持久化路径，经 manager 到 `PersistenceService.persistAgents` 的 strict 模式。
- 严格落盘成功后，才把新值写入共享 tuning。
- 若无可用状态路径或写盘失败，抛出 `persist_failed`，恢复写入前的设置与运行状态，不得静默成功。
- 失败后不得留下「磁盘是旧值、共享 tuning 是新值」的拆分状态。

在 `src/bridge/persistence-service.ts` 的 `PersistenceService.persistAgents` 序列化中加入该全局键，保持现有严格写入错误语义。`PersistenceService.loadPersistedAgents` 继续通过设置服务恢复，不在 persistence 层另建一份运行状态。

在 `src/bridge/manager.ts` 的 `BridgeManager` 中：

- 暴露 getter 与 setter 给 RPC 层。
- 启动加载持久设置后，把有效值应用到共享 tuning。
- setter 严格等待落盘，再完成运行时更新。
- 不调用 agent 保存和重启路径。

### 6.3 RPC 契约

在 `src/protocol.ts` 增加纯类型契约，在 `src/impl.ts` 增加 `AcpManager` 方法声明、`dispatchRpc` 路由与输入校验：

- `ui/skills-mcp`：读取当前值，返回 `{ skillsMcpEnabled: boolean }`。
- `ui/skills-mcp-set`：接收 `{ skillsMcpEnabled: boolean }`，严格保存并热应用，成功响应返回服务端当前值。
- 非 boolean、缺失字段或非法 body 返回 `bad_payload`，不写盘、不改运行状态。
- 写盘失败返回现有 `persist_failed` 错误语义，浏览器据失败回滚。

在 `src/client/store.ts` 中：

- 初始加载调用 `ui/skills-mcp`，未读取前不把「未知」当成用户已开启。
- 开关可先乐观更新；请求失败必须恢复之前的浏览器值。
- 成功后采用服务端返回值，避免浏览器与宿主状态分叉。
- 失败进入设置页页头错误 notice。
- 这是普通设置保存，不进入 `acpSaveGate`，不触发 agent 保存横幅或保存浮层。

## 7. 设置页 UI

### 7.1 组件与位置

- 新增 `src/client/skills-mcp-preference.tsx`，承载开关、说明和信息图标。
- 在 `src/client/panel.tsx` 的「智能体」页挂载，不放入对话面，不新增逐 agent 控件。
- 开关只调用 store 的设置方法，不直接改 agent 定义，不调用 `agent/save`。
- 保存失败由设置页页头显示，不使用 agent 保存浮层。

### 7.2 文案

控件说明固定为：

> 让 agent 通过只读 MCP 列出并读取 DSH 技能。

开关旁信息图标的 tooltip 固定为：

> 仅读取 DSH 技能目录，不桥接宿主工具。首次调用前不扫描技能；agent 仍可能随会话启动并保留 MCP 进程，开关仅影响后续建会话。

文案不得改写成「首次调用才启动进程」「首次调用前零内存」或「关闭后立即停止 MCP」。

### 7.3 宿主 UI 约束

- 使用 `@deepseek-ai/dsh-client-ui-primitives` 的宿主 `Tooltip`。
- 信息图标必须是可聚焦的 `button`，有明确的 `aria-label`，键盘用户能触发或聚焦查看提示。
- 不用只有鼠标 hover 才能访问的纯装饰图标。
- 颜色只使用宿主 alias token；写死颜色只能作为 `var()` fallback。
- 不新增插件自有主题状态，不写 `color-scheme`。

## 8. MCP server 协议与工具契约

### 8.1 文件与传输

新增 `mcp/skills-server.mjs`：

- 只使用 Node 内置模块，不引入 MCP SDK、YAML 库或其他第三方依赖。
- 使用换行分隔的 JSON-RPC 2.0 over stdio。
- stdout 只输出单行 JSON-RPC 消息。禁止 banner、调试文本和多行日志进入 stdout。
- 日志与单技能诊断只写 stderr。
- stdin EOF 时退出进程，不保持无意义的事件循环。
- 不启动 watcher、定时器或持久缓存。

实现以下 MCP 方法：

- `initialize`：返回 server 信息与 tools 能力，不读取技能目录。
- `initialized`：按 notification 处理，不响应，不读取技能目录。
- `ping`：返回空成功结果，不读取技能目录。
- `tools/list`：返回静态工具描述与 JSON Schema，不读取技能目录。
- `tools/call`：只分发 `skills_list` 与 `skill_read`。

未知工具、非法参数和协议错误必须有明确错误结果；不能静默返回成功或空内容。notification 不错误地发送响应。

### 8.2 `tools/list` 静态声明

`skills_list` 无参数，返回技能清单。

`skill_read` 声明以下参数：

- `name`：必填字符串，技能目录名。
- `file`：可选字符串，技能目录内的相对文件路径；缺省为 `SKILL.md`。
- `maxLines`：可选整数，默认 400，最大 2000，最小 1。

`maxLines` 超出合法范围或不是整数时返回参数错误。任何缺省、非法或绕过 schema 的调用都不能触发无界读取。

### 8.3 `skills_list`

1. 只枚举技能根的直接子目录，不递归遍历整棵树。
2. 只有直接子目录中存在可合法读取的 `SKILL.md` 时，才把该项视为技能。
3. 返回 `[{ name, description, path }]`：
   - `name` 是用于 `skill_read` 的直接子目录名。
   - `description` 从 `SKILL.md` 顶部元数据中提取；没有合法描述时返回空字符串。
   - `path` 是该 `SKILL.md` 经 `realpath` 得到的规范绝对路径。
4. 元数据读取也必须有界，不能为了描述无界读取整个文件。
5. 技能根不存在时返回空数组，不把它当成服务器致命错误。
6. 单个目录、元数据或文件损坏时，跳过该项并写 stderr，不能拖垮整个清单。
7. 对条目数、单条描述长度和清单序列化后的总输出分别设置固定上限。建议初始常量为 200 条、1000 字符、120000 字符，集中在 server 顶部，不新增用户配置。
8. 任一上限生效时都要有可识别的截断标记；清单总输出包含标记后仍不得超过其上限。
9. 返回顺序按 `name` 稳定排序，避免同一文件系统状态下清单抖动。
10. 每次调用重新枚举，因此新增、删除和描述变化能在下一次调用反映。

### 8.4 `skill_read`

1. `name` 必须匹配 `^[a-z0-9][a-z0-9-]{0,63}$`，再进入路径解析。
2. `file` 缺省时读取该技能的 `SKILL.md`；提供时只读取技能目录内的该相对目标。
3. 禁止 POSIX 或 Windows 绝对路径、盘符路径、UNC 路径、空字节、`..` 穿越和解析后越界。
4. 对技能根、技能目录和最终目标分别做 `realpath`，再做跨平台 containment 校验。
5. containment 必须覆盖 Windows 分隔符与大小写语义，以及 POSIX 字节精确语义；不能只用字符串 `startsWith`。
6. 拒绝解析到技能根外的 symlink。技能目录或目标为外部 symlink 时不得读取。
7. 最终目标必须是普通文件。目录、设备、socket、FIFO 等非普通文件一律拒绝。
8. 只读取目标文件，不扫描其他技能，不为了读取正文建立全量索引。
9. 使用有界分块读取。达到 `maxLines` 或输出字符上限后停止，不先无界读入整个文件再截断。
10. 输出最多 120000 字符，包括截断标记。内容因行数或字符数被截断时必须明确标记。
11. 每次调用读取当前磁盘内容，不使用持久正文缓存，因此内容变化在下一次调用可见。

### 8.5 错误与输出形状

- `skills_list` 的文本内容使用结构化 JSON 数组，字段固定为 `name`、`description`、`path`。
- `skill_read` 的文本内容为目标正文，截断时附明确标记。
- MCP tool result 使用标准 `content` 数组；工具执行失败用明确错误结果，协议错误使用 JSON-RPC 错误。
- 所有 stdout 帧都必须能被逐行独立解析为一条 JSON-RPC 消息。

## 9. 修改点清单

实施时按以下落点修改，不另起平行配置或会话路径：

- `mcp/skills-server.mjs`：新增零依赖只读 stdio MCP server 与全部文件安全边界。
- `src/bridge/mcp.ts`：新增 `dshSkillsMcpServer`、`sessionMcpServers`；复用 `toAcpMcpServers`。
- `src/bridge/agent-bridge.ts`：修改 `openSession`、`probeConfigOptions`、`doResumeSession`、`forkSession`，统一读取当前 tuning 和合并 MCP 列表。
- `src/bridge/types.ts`：扩展 `BridgeTuning.skillsMcpEnabled`。
- `src/bridge/tuning.ts`：在 `DEFAULT_TUNING` 中默认 `skillsMcpEnabled: false`。
- `src/bridge/settings-service.ts`：扩展 `PersistedSettings`、`SettingsHost`、`SettingsService` 的读取、恢复、严格写入、失败回滚与热应用。
- `src/bridge/persistence-service.ts`：在 `PersistenceService.persistAgents` 写入全局键，沿用 strict 错误语义。
- `src/bridge/manager.ts`：在 `BridgeManager` 连接设置服务、共享 tuning、启动恢复与 RPC 读写方法。
- `src/protocol.ts`：新增 `ui/skills-mcp` 与 `ui/skills-mcp-set` 的纯类型契约。
- `src/impl.ts`：扩展 `AcpManager` 和 `dispatchRpc`，校验 payload，返回当前值或错误。
- `src/client/store.ts`：增加初始读取、开关写入、成功同步、失败回滚与页头错误。
- `src/client/skills-mcp-preference.tsx`：新增设置组件。
- `src/client/panel.tsx`：在「智能体」页挂载设置组件。
- `package.json`：在 `files` 中加入 `mcp`，确保发布包包含 server。
- 测试：新增 server 独立 stdio 测试、合并器纯测试，并扩展现有 RPC、store、panel 与 bridge 集成测试。
- `AGENTS/state.md`：记录配置持久化、同名优先、运行时不回写和四入口一致性。
- `AGENTS/protocol.md`：记录 ACP/MCP 进程职责、准确懒加载语义和 stdio 行为。
- `AGENTS/ui-panel.md`：记录设置入口、文案、tooltip 与普通设置保存语义。

不修改 `CHANGELOG.md`，不手改 `lib/`，不增加新的 agent 原生配置适配层。

## 10. 实施顺序

按以下顺序完成，每一步先通过对应测试再进入下一步：

1. **server 与独立 stdio 测试**
   - 新增 `mcp/skills-server.mjs`。
   - 先完成协议循环、静态工具声明、路径安全和有界读取。
   - 用真实 Node 子进程验证 stdio，不依赖 agent。
2. **合并器纯测试**
   - 实现 `dshSkillsMcpServer` 与 `sessionMcpServers`。
   - 验证开关、同名优先、输入不变和 ACP stdio 线格式。
3. **四个入口**
   - 把 `openSession`、`probeConfigOptions`、`doResumeSession`、`forkSession` 切到同一当前配置和同一合并器。
   - 用 mock agent 记录四次请求的 `mcpServers`。
4. **配置与 UI**
   - 接入 tuning、持久化、严格 RPC、store 回滚和设置页组件。
   - 验证保存失败不进入 agent 保存流程。
5. **相关 Vitest**
   - 运行本次新增测试及直接受影响的现有测试。
   - 不因局部改动无目的扩大到无关测试或外部服务。
6. **完整仓库验证**
   - 运行 `npm run prepack`，覆盖行数门禁、typecheck、仓库测试与 build。
7. **发布包验证**
   - 检查 npm pack 文件清单，确认 `mcp/skills-server.mjs` 被包含，且运行路径不依赖未发布的源码文件。
8. **真实 agent 验证**
   - 至少使用真实 CodeBuddy 和另一种 ACP agent。
   - 验证工具可见、清单与读取可用、默认关闭、进程由 agent 启动和回收、开关只影响后续建会话。

## 11. 测试矩阵与验收标准

### 11.1 默认、恢复与配置失败

- 全新状态默认 `false`，四个入口都没有 `dsh-skills` 声明。
- 开启后严格写入 `agents.json`，重启宿主后恢复 `true`。
- 持久化为 `false` 时重启仍为 `false`。
- 持久值缺省、为字符串、数字、对象或其他非法形状时恢复为 `false`。
- `ui/skills-mcp-set` 非 boolean 或缺字段返回 `bad_payload`，磁盘和运行值均不变。
- 无状态路径或写盘失败返回 `persist_failed`，宿主设置、共享 tuning 和浏览器开关全部回到旧值。
- 写盘失败在设置页页头显示错误，不显示成功，不进入 `acpSaveGate`，不出现 agent 保存浮层。
- 成功切换不调用 `agent/save`，不重启 agent，不中断活动会话。

### 11.2 协议初始化与零目录读取

- 独立 stdio 客户端完成 `initialize`、`initialized`、`ping` 和 `tools/list`。
- 上述方法均不读取技能根或技能文件；用文件系统观测或等效测试证明，而不是只检查返回文本。
- `tools/list` 只有 `skills_list` 与 `skill_read`，schema 包含 `name`、`file`、`maxLines` 及默认值和上限。
- 每条 stdout 输出都是单行 JSON-RPC；日志只出现在 stderr。
- stdin EOF 后进程退出，无 watcher 或定时器使其常驻。

### 11.3 `skills_list` 与实时变化

- 缺根返回空清单。
- 只列技能根直接子目录中的 `SKILL.md`，不递归把更深层目录当成新技能。
- 返回名称、描述和 `SKILL.md` 规范路径，顺序稳定。
- 单个损坏目录、损坏元数据或不可读技能不会拖垮其他条目。
- 条目数、描述长度和总输出分别达到上限时有界并带截断标记。
- 第一次 `skills_list` 才发生技能目录扫描。
- 新增、删除技能或修改描述后，不重启 server，下一次 `skills_list` 能观察变化。

### 11.4 `skill_read` 与有界读取

- 默认读取 `SKILL.md`，默认最多 400 行。
- `maxLines` 合法值生效；2000 为上限，非法值返回参数错误。
- 指定 `file` 可读取技能目录内合法附加文件。
- 行数截断与字符截断都有明确标记。
- 输出含标记最多 120000 字符。
- 用超大文件和超长单行证明实现不会先无界读取整个文件。
- 修改目标文件后，不重启 server，下一次 `skill_read` 返回新内容。
- 读取一个技能不会扫描或读取其他技能正文。

### 11.5 路径安全与 Windows

至少覆盖以下攻击和边界：

- `name` 中的绝对路径、点段、斜杠、反斜杠、空字节和非法字符。
- `file` 中的 `..`、POSIX 绝对路径、Windows 盘符路径、UNC 路径和混合分隔符。
- 技能目录 symlink 指向根外时拒绝。
- `SKILL.md` 或附加文件 symlink 指向根外时拒绝。
- 根内合法 symlink 按 realpath containment 判定，不因「存在 symlink」本身误伤合法目标。
- 目标是目录或其他非普通文件时拒绝。
- Windows 上验证大小写与分隔符语义，POSIX 上验证字节精确 containment。
- 不能仅凭字符串前缀通过位于兄弟目录的相似前缀路径。

### 11.6 合并与四入口一致性

- 开关关闭时只返回用户 `mcpServers`。
- 开关开启时追加内置 `dsh-skills`。
- 用户已有同名 server 时保留用户项，不追加内置项。
- 合并后原 `AcpAgentDef.mcpServers` 数组和对象逐层保持不变，内置项不写回持久定义。
- 内置项使用 `process.execPath`，args 指向随包发布且实际存在的 `mcp/skills-server.mjs`。
- 经 `toAcpMcpServers` 后，stdio 项没有 `type`，env 为 `[{ name, value }]`。
- `openSession`、`probeConfigOptions`、`doResumeSession`、`forkSession` 在同一开关状态下得到完全一致的 MCP 列表。
- 开关改变后，后续四个入口立即使用新值；既有活动会话不被重写，agent 不重启。
- 关闭后不保证既有 MCP 进程退出，测试不得把这种不保证误写成回收承诺。

### 11.7 真实进程与真实 agent

- 独立 stdio 测试证明 server 可由 `process.execPath` 启动，并在 stdin EOF 后退出。
- 真实 CodeBuddy 默认关闭时看不到内置 server；主动开启后的新会话能看到并调用两个工具。
- 真实 CodeBuddy 能列出技能、读取正文，并在文件变化后的下一次调用看到新内容。
- 另一种 ACP agent 完成同样的新建会话与工具调用验证。
- 观察并记录 agent 实际启动和回收 MCP 进程的行为，不用单一 agent 的行为推导所有 agent。
- 验证 resume、probe 和 fork 不会用不同列表破坏进程级 MCP 工具集合。
- 切换开关本身不调用 `agent/save`，不强制回收既有 MCP 进程。

### 11.8 仓库与发布验收

- 相关 Vitest 全部通过。
- `npm run prepack` 全部通过，包括行数门禁、typecheck、测试和 build。
- `scripts/file-size-baseline.json` 不新增条目、不抬线；存量文件不增长。
- npm 包文件清单包含 `mcp/skills-server.mjs`，安装包内 server 定位不依赖仓库外路径。
- 文档、tooltip 和最终说明都不包含「首次工具调用才启动进程」「首次调用前零内存」等错误承诺。
- 实施提交不包含 `CHANGELOG.md` 或 `lib/` 的手工改动。

## 12. 完成定义

只有同时满足以下条件才可标记完成：

1. 两个工具在真实 CodeBuddy 和另一种 ACP agent 中可用，且默认关闭。
2. 设置页可主动开关，持久化、严格失败回滚、tooltip 和页头错误均符合本文。
3. 四个 ACP 入口共享当前配置和同一合并器，用户同名 server 优先，agent 定义不被改写。
4. server 在初始化与静态工具清单阶段不读技能目录，读写行为有界，无 watcher、缓存和定时器。
5. 路径穿越、绝对路径、外部 symlink 和非普通文件均被拒绝，Windows 与 POSIX 语义均有测试。
6. 所有相关测试、`npm run prepack`、npm 包含检查和真实 agent 验证通过。
7. 三份 `AGENTS/` 文档与代码同次更新，行数门禁未被放宽。
8. 最终交付如实说明 agent 掌握 MCP 进程生命周期，开关只影响后续建会话，不宣称便携的进程级按需启动。
