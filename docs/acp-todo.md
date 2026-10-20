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
| 1 | NTR 模式下原生输入框应透传 agent 自己的命令 | 部分被宿主命令层拦死 | 先做可见面与非冲突转发；同名透传需上游接缝或换 composer |

新会话开工时只读这一条，不要顺手改它的红线。

---

## 1. NTR 模式下原生输入框应透传 agent 自己的命令

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
- **2026-10-20 · 模型列表获取不完全**：五层判定闭合——第 5 层由 `catalog/updated` 广播修复；pi 的 env-gated 供应商由「子进程全量继承宿主环境」恢复；第 1 层是 `exposedModels` 可见性设计；第 2 层（探测只读 `session/new` 响应、不等 `config_option_update`）与第 3 层（`parseCatalogOptions` 只认 `model` / `thought_level` / `mode`，同 category 多 select 覆盖写）在 omp / codebuddy / pi 三个样本上均未出现，故未改；第 4 层（旧缓存不重探）是既有设计，由首次真实会话的 `absorbCatalog` 修复。结论见 [AGENTS.md](../AGENTS.md) 约束 8/9 与「边界与禁区」；测试见 `tests/bridge.spec.ts` 的 "announces a catalog learned from a real session" 与 `tests/store.spec.ts` 的 "drops the cached seat catalog when the host announces a new one"。桌面端 omp 复核仍建议做一次。

（一条待办完成时，把它的结论写进 AGENTS.md 的对应约束或 [docs/acp-convergence.md](./acp-convergence.md) 的批次表，然后在这里留一行去向。）
