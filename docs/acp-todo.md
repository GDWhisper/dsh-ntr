# NTR 待办清单

本文件记录**用户已报告、尚未落地**的 NTR 面改动。每条都写清四件事：用户报告了什么、现状代码在哪里、已知的障碍（避免下次从零查）、以及验收时看什么。文末「已落地」只保留一行去向，详细结论在 [AGENTS.md](../AGENTS.md) 的对应约束里。

> 引用代码位置一律用「文件 + 符号名」，不用行号。

**与其它文档的关系**：

- [AGENTS.md](../AGENTS.md) 的架构约束是**现行代码的纪律**；本文件是**还没成为纪律的意向**。一条待办落地时，把它从本文件移到 AGENTS.md 的对应约束（或 [docs/acp-convergence.md](./acp-convergence.md) 的批次表），并在这里留一行"已落地 + 落在哪"，不要静默删除——和 `docs/acp-omniterm-backlog.md` 的「已吸收」同一纪律。
- 落地前，**现行代码与 AGENTS.md 的说法就是权威**。本文件里任何与它们冲突的描述，都是"打算改"，不是"已经改了"。禁止照着本文件写新代码。

**状态词**：`待办`（只有报告，没开始）／`进行中`／`已落地`（带去向）。

## 攻破顺序

| # | 待办 | 现状 | 建议 |
|---|---|---|---|
| 1 | 模型列表获取不完全 | 样本已拿到；第 5 层已修；pi 的 env 缺口已由全量环境继承修复 | codebuddy 属设计 |
| 2 | NTR 模式下原生输入框应透传 agent 自己的命令 | 部分被宿主命令层拦死 | 先做可见面与非冲突转发；同名透传需上游接缝或换 composer |

剩下的待办互不依赖。新会话开工时只读对应的一条，不要顺手改另一条的红线。

---

## 1. 模型列表获取不完全

**状态**：进行中（2026-10-20 拿到样本；第 5 层已修，其余为配置/设计判定）。**用户报告**：2026-10-19（原文只有这一句，缺"哪个 agent、少了什么"）。

它有五种完全不同的可能原因，对应五个不同的层，修错层会把"设计"当成 bug 改掉。第一步是拿到一份对照——**agent 实际报的 `configOptions`**、**设置页"检测可用模型"列出的行**、**composer 模型菜单列出的行**——然后定位缺口在哪一层。**对照已于 2026-10-20 拿到（见下表）。**

### 样本（2026-10-20，本机实测）

用真实 ACP 会话（`initialize` + `session/new`，等 8s 收后续 `config_option_update`）对照磁盘缓存：

| agent | 真实 `session/new` | 磁盘缓存 | 结论 |
|---|---|---|---|
| omp | 780 | 774（10-18） | 缓存陈旧：6 个新模型（opencode/openrouter/stepfun），无解析丢失 → 第 4+5 层 |
| codebuddy | 20 | 20 | 版本无缺口；composer 只列 3 个是因为 `exposedModels` 只勾了 3 个 → 第 1 层（设计） |
| pi | 119（旧：脱敏 env）/ 145（完整 env） | 119 | 缺的 26 个全部来自 `TOKITOKEN` / `STEPFUN` / `AMD` / `SENSENOVA` 四家 provider；旧版插件按名字剥离 `*_KEY*` 环境变量，pi 因此不报这些 provider。2026-10-20 起 `childEnv` 改为**全量继承宿主环境**（agent 自己的 `env` 按键覆盖），该缺口消失 |

结论：**omp 的用户症状正是第 5 层**——宿主缓存停在旧目录、浏览器端 `seatCatalogs` 又永不失效。pi 的 26 个模型是环境继承问题（2026-10-20 已改为全量继承宿主环境，见 [AGENTS.md](../AGENTS.md)「边界与禁区」）；codebuddy 的 3 个是 `exposedModels` 的可见性语义，不是缺数据。

### 五个可能的层（从外到内）

1. **可见性过滤（设计，先排除）**。`src/bridge.ts` 的 `agentCatalog` 只展开命中 `def.exposedModels` 的 `entry.catalog.model.choices`；`exposedModels` 未设置或为空时**一个变体都不给**，只留 `base`。这是设计，不是 bug——除非用户已经在设置页勾过。注意设置页的 `ModelCatalogBlock`（`src/client/panel.tsx`）读的是 `ui.modelCatalogs`（探测结果），**不是**按 exposure 过滤后的 `seatCatalogs`；如果**设置页复选框列表**都不全，问题不在这一层。

2. **探测没跑过 / 探测时没报全**。目录的来源只有：`agent/probe-models`（设置页按钮）、某 agent 自己的 `session/new` / `session/load`（`absorbCatalog` 写入）、旧 schema 的磁盘缓存。`bootstrapCatalogs()` 是空实现，启动时不探。**已核实的强版本**：`AgentBridge.probeConfigOptions`（`src/bridge.ts`）只读 `session/new` 响应的 `configOptions`，**紧接着就 `session/close`**；探测会话刻意不登记，异步到达的 `config_option_update` 不会被接住。对"模型列表异步推送"的 agent，探测可能直接得到空/初始集合，而不是"窗口内只拿到初始集合"。

3. **解析丢数据**。`src/impl.ts` 的 `parseCatalogOptions` 只认 `category` 为 `model` / `thought_level` / `mode` 三种：
   - ACP 规范保留的 `category: 'model_config'` 被整块跳过；agent 若把模型相关配置放在这里，会消失；
   - `out[slot] = ...` 是**覆盖写**：同一 category 出现多个 select 时只留最后一个，前一个模型列表整块丢失；
   - `currentValue` 不是非空字符串时记 `null`（于是 `agentCatalog` 的 `currentModel` 缺席）；`collectCatalogChoices` 只接受字符串 `value`。

4. **磁盘缓存陈旧**。`CATALOG_SCHEMA` 与 `catalogStale`（`src/bridge.ts`）：旧 schema 的磁盘缓存会被当成有效目录，直到一次真实会话的 `absorbCatalog` 把它修好；启动时不重探。

5. **浏览器端 `seatCatalogs` 缓存不失效（待办原先漏掉的第五层）**。`src/client/store.ts` 的 `loadAgentCatalog` 以 agentId 为键**永久缓存**并 early-return；`invalidateSeatCatalog` 只在 `setExposedModels` / `deleteAgent` / `probeModels` 调用。宿主侧 `absorbCatalog` 更新目录后**不广播**，`session/meta` 也不清缓存。于是：会话首轮前读到空/旧目录 → 首轮中 agent 的 `session/new` 把完整目录吸收进宿主 → **composer 永远停在旧目录**，直到用户去设置页点"检测可用模型"或改一次可见性。这完全符合"列表获取不完全"的症状，而且修复不违反"不启动探测"的红线——`agent/catalog` 本身是纯内存，重新读一次即可。**已修（2026-10-20）**：`absorbCatalog` 内容变化时广播 `catalog/updated`（`agentId` + `updatedAt`），`AcpStore` 收到后 `invalidateSeatCatalog` + `loadAgentCatalog`（去重保留）。`setConfigOption` 的响应**不**进目录（会话级 `currentValue` 会污染 `defaultEffort`），只进会话快照。

### 附带核对（已确认）

`src/client/session-controls.tsx` 的 `modelSection` 读的是 `catalog.currentModel`，并把 in-force 模型以「· 当前」行列在顶部——待办原先担心的"正在用的模型不在列表里导致整块 chip 消失"在这条路径上已被覆盖。但要注意：当 agent 报 `currentValue: null` 且没有 pick / exposed variants 时，`currentModel` 缺席，**模型 chip 在首轮前根本不会出现**，不只是列表少一行。这属于第 3 层的表现。

另一处文档纠错：待办红线说"禁止让 `agent/catalog` 在渲染路径上 spawn"——现行代码已经是纯内存、绝不 spawn（`BridgeManager.agentCatalog`）；`session-controls` 里"reading can spawn a probe"的注释是旧说法，不是当前行为。

### 第一步：先拿样本（已完成 2026-10-20）

- 哪个 agent（本机有 `omp` / `codebuddy` / `pi`）。
- 设置页"检测可用模型"列出的模型数，与 `~/.dsh/dsh-ntr/model-catalog.json` 里该 agent 的 `catalog.model.choices` 数是否一致。
- composer 模型菜单列出的行（含「· 当前」行）与 `exposedModels` 是否一致。
- 点一次"检测可用模型"后列表是否补齐——**是**则指向第 5 层；**否**则继续查第 2/3 层。
- 如果 agent 支持，抓一份它自己的 `session/new` 响应 + 随后的 `config_option_update`（真实 `configOptions`）。

### 修法（按层，拿到样本后再选）

- **第 5 层（已落地 2026-10-20）**：`BridgeManager.absorbCatalog` 在目录内容真正变化时广播 `catalog/updated`（`agentId` + `updatedAt`）；`AcpStore.applyEvent` 收到后失效该 agent 的 `seatCatalogs` 并重读 `agent/catalog`。只在真实会话观察到变化时发（`session/new` / `session/load` / `config_option_update`），同内容重复发布不广播；`loadAgentCatalog` 的 dedupe 保留。测试：`tests/bridge.spec.ts` 的 "announces a catalog learned from a real session"、`tests/store.spec.ts` 的 "drops the cached seat catalog when the host announces a new one"。
- **第 3 层**：按样本决定是否支持 `model_config` / 多 select；**严禁**猜测供应商分组或按名称前缀推断。多 select 的取舍（哪个是模型轴）需要一次明确裁决。
- **第 2 层**：探测可在 `session/new` 后有界等待一次 `config_option_update` 再关闭；探测会话必须能被 bridge 接住更新（当前刻意不登记，需要设计）。这是显式探测，不违反"启动不探"的红线。
- **第 1 层**：不改。`exposedModels` 语义保持"只影响可见性，不影响可用性"。

### 红线

- 禁止把"变体按需"当成 bug 修掉（约束 8）。
- 禁止为了让列表全而重新引入启动探测（`bootstrapCatalogs` 保持空实现）。
- 禁止让 `agent/catalog` 在渲染路径上 spawn。
- 禁止把设置页复选框列表（探测结果）与 composer 座位列表（exposure 过滤后）混为一谈。

### 验收

- 拿到对照样本，缺口定位到某一层并说明依据。**已完成（见上方样本表）。**
- 修完后同一 agent 的 `configOptions` 与 UI 行一一对应（未勾的仍不列，`exposedModels` 语义不变）。
- 首次真实会话之后，composer 的模型列表能自动补齐，不需要用户点"检测"。**代码路径已通；桌面端待用户用 omp 复核。**
- 不新增任何启动期探测。
- pi 的 26 个 env-gated 模型不在本条的代码修复范围内：旧版需要显式配置密钥，2026-10-20 起 env 全量继承后自动恢复。

---

## 2. NTR 模式下原生输入框应透传 agent 自己的命令

**状态**：待办。**用户报告**：2026-10-19。

预期：进入 NTR 模式后，DSH 原生会话框里打的命令应该交给 ACP agent 执行，而不是被 DSH 侧的解释器消费掉。

### 已核实的现状（两侧分开看）

- **插件这一侧是对的**。约束 15/16 要求转发文本严格等于用户输入，`selectForwardPrompt`（`src/impl.ts`）取最后一条 user-source 消息的文本，不拼任何叙述。人在输入框里打的任何文字（含 `/xxx`）**只要能走到提交**，都会原样进 agent。
- **拦截发生在提交之前，不在插件里**。命中的是 `@deepseek-ai/dsh-client-ui-input-trigger` 的 `adjudicate`：它**按来源注册顺序**逐个轮询 `matchEnter`，第一个非 `undefined` 的结果获胜；没有来源认领才走默认 prompt sink。
- `@deepseek-ai/dsh-client-ui-commands` 注册的 `command` 来源在 `matchEnter` 里把首个 token 解析成命令：**未知名字**返回 `undefined`（落到 prompt，agent 能收到）；**已知名字**消费掉，agent 永远看不到。
- **NTR 会话里被消费的名字（已核实）**：
  - `/model`：`@deepseek-ai/dsh-client-ui-model-selection` 的客户端贡献，`available` 对所有非 subagent 会话为真；
  - `/feedback`：`@deepseek-ai/dsh-client-ui-message-feedback` 的客户端 decoration，`available: () => true`；
  - `/permission`：`@deepseek-ai/dsh-client-ui-permission-presets` 的客户端 decoration，只要权限投影存在就可用；
  - `/export`：`@deepseek-ai/dsh-session-log-export` 在 root 注册的**全局**宿主命令。
  - 宿主 `commands.list(agent)` 会合并 global + scoped；global 命令与 agent preset 无关，所以 ACP preset 管不到上述名字。
- **NTR 会话里不存在的名字**：`/plan`、`/goal`、`/compact` 等由 agent-plane 插件提供；ACP preset 只挂 persona + acp-guard（`presets/acp/acp.patch.yml`），web profile 也把 base 里的这些行禁用。这些名字如果 agent 也有，反而能透传。
- **`availableCommands` 数据已经在**：`SessionView.availableCommands` 由 `available_commands_update` 折叠而来；`src/client/store.ts` 的 `describeEvent` 会把它画成一张事件卡（原始更新可读），但**没有可操作的命令菜单**。待办原先说"界面上没有任何地方用它"基本成立，措辞上应改为"没有可操作面"。

### 接缝核对（预分析纠错）

- **preset 行不是缝**：被拦的是客户端全局贡献和 root 宿主命令，不是 agent-plane 插件；改 ACP preset 的 `plugins` 列表移除不了它们。
- **`inputTriggers` 没有 per-session availability**：`InputTriggerSource`（`@deepseek-ai/dsh-client-ui-input-trigger` 的类型）只有 `trigger` / `name` / `order` / `candidates` / `matchEnter` / …，没有 `available(session)`；`order` 只影响菜单排序，**裁决严格按注册顺序**。`command` 来源在启动时注册，我们的动态 bundle 晚于它，无法抢在它前面。
- **不能 shadow**：`registerSource` 对同 `(trigger, name)` 重复直接抛；`commandUi.register` 对同名贡献也抛；没有公开的"注销/禁用别的插件贡献"的 API。
- **唯一干净的兜底是 `conversation.composer` chain 替换整个输入框**，代价是重做附件、队列、草稿、快捷键等宿主能力，不建议为这一个问题付。

### 要做的

1. **先做可见面**：把 `availableCommands` 在 NTR 视图（或 composer 的 `/` 菜单）里列出来，标出"DSH 保留、不会送到 agent"的名字（至少 `/model`、`/permission`、`/feedback`、`/export`）。用户至少不再盲打。
2. **非冲突命令的转发**（可选但推荐）：注册我们自己的 `/` 来源，列出 ACP 命令；对内置来源不认领的名字，我们认领并把**原始整行**经同一条会话发送路径发出去。**严禁**改写文本或补叙述。
3. **同名冲突**：在当前客户端 API 下没有支持接缝。若必须透传，只有两条路——换 `conversation.composer`（成本高），或向上游要"per-session source 可用性 / source 优先级 / 贡献禁用"的 API。不要用 preset 行或"转发时补一条消息"伪装解决。
4. 约束 15/16 的红线不变：转发文本严格等于用户输入；`purpose !== undefined`（`session-title` / `compaction`）仍须在 `getOrCreateDshSession` 之前以 `unsupported_purpose` 失败。

### 验收（拆开写）

- **非冲突** agent 命令：在 NTR 会话里输入，agent 收到并执行；普通会话行为一字不变。
- **保留字**：`/model`、`/permission`、`/feedback`、`/export` 在 UI 里有明确标注；不静默吞掉用户的期待。同名透传若未实现，验收不得写成"agent 收到并执行"。
- `availableCommands` 有可见面（列表/菜单），数据来自 agent 的 `available_commands_update`，不是 DSH 自己的命令目录。
- `tests/impl.spec.ts` 的注入过滤 / purpose 用例保持绿；新增的 `/` 来源必须有 ACP 闸门，普通会话不出现。

### 不要做

- 不要用 preset 行试图移除客户端全局命令或 root 宿主命令。
- 不要给转发文本补"边界说明"或任何前缀。
- 不要在没有 composer 替换/上游接缝的情况下宣称已支持同名透传。

---

## 已落地

- **2026-10-20 · agent 底座选定后隐藏**：首轮开始时隐藏并锁定 agent（首轮无可见输出则回滚），当前 agent 由输入框上边缘的只读挂牌显示。结论见 [AGENTS.md](../AGENTS.md)「本插件是什么」第 1 点 + 约束 18「规则（agent 底座的退场与锁定）」；测试见 `tests/bridge.spec.ts` 的 "agent lock at the start of the first turn" 与 `tests/acp-view.spec.ts` 的 "the agent-lock hand-off clock"。

（一条待办完成时，把它的结论写进 AGENTS.md 的对应约束或 [docs/acp-convergence.md](./acp-convergence.md) 的批次表，然后在这里留一行去向。）
