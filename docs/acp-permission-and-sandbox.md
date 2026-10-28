# ACP 会话的权限对齐：DSH Access mode ↔ ACP 权限调研

> 背景：ACP agent 作为 `acp` provider 跑在 DSH 原生聊天窗口里，于是同一个会话上出现两个"权限选择"：
> DSH 原生的 Access mode（仅可查看 / 工作区内修改 / 完全权限），以及 ACP agent 自己的权限模式。
> 本文记录两边实体、现状接线错误、两种对齐方案的可行性与硬约束调研结论。

## 1. 两个旋钮的实体（已核 DSH 源码）

### 1.1 DSH 原生 Access mode = preset（sandbox + approval 两个 knob 的 bundle）

- 服务：`packages/interaction/permission-presets/src/index.ts` 的 `PermissionPresetService`（`ctx.permissionPresets`）。
  preset 表是**静态 Config**；shipped 表在 `packages/bundle/base/cordis.patch.yml`：
  `read-only(read-only+ask)`、`workspace-write(workspace-write+ask)`、`danger-full-access(danger-full-access+never)`。
- 读侧：`permissions` **session projection**（`packages/interaction/permission-presets/src/types.ts` 的 `PermissionSelect{options,currentValue}`），
  客户端 `packages/client/ui-conversation/src/client/skeleton/PermissionSelect.tsx` 只读这份 projection 渲染（`input.accessMode` aria）。
- 写侧：`/permission <preset>` 命令（`PermissionPresetService` 内注册）；写入 `permission/preset` + `sandbox/mode` + `approval/policy` 三个 session 事件。
- 纯折叠：`effectiveSandboxMode` / `setSandboxMode`（`packages/sandbox/sandbox-policy/src/session-mode.ts`）、
  `effectiveApprovalPolicy` / `setApprovalPolicy`（`packages/interaction/user-approval/src/index.ts`）。
- `sandbox/mode` 的用力点：**DSH 自己执行的操作用**（`ctx.shell` 下的 bash/pwsh 沙箱、`@deepseek-ai/dsh-fs-sandbox` 的写栅栏），
  对模型只有叙述（`SandboxPolicyService` 的 systemPrompt.context 写 `Current DSH file policy: …`），升级走 `sandbox_permissions` → `ctx.approval`（`packages/sandbox/sandbox/src/escalation.ts`）。
- `approval/policy`：`ask` → 交 answerer；**`never` → `ApprovalService.decide` 内直接返回 `rejected`**（不问任何人；`approval.config.policy` 是默认，会话内可被 `approval/policy` 事件覆盖）。

### 1.2 ACP agent 自己的权限模式

- `session/new` / `session/load` 响应的 `modes.availableModes` + `session/set_mode`（本插件 `src/bridge.ts` 的 `SessionView.modes` / `AgentBridge.setMode` 已全部接好）。
- 部分 agent 用 `configOptions` 里 `category: 'mode'` 的 select 表达同一件事（`setConfigOption`）。
- 另有一部分 agent 的"权限"根本不是 mode，而是它自己的沙箱开关（如 Codex 的 `read-only` / `workspace-write` / `danger-full-access` 同名三档）。

## 2. 现状：接线是错的，不只是"两个控件冗余"

事实（本插件代码）：

1. `BridgeManager.streamPrompt`（`src/bridge.ts`）只把**最后一条 user 文本**转成 ACP prompt。
   > **已修正（原文假设错误）**：宿主把上下文段折在用户消息**之后**（`dsh-agent-instructions` 的 pre-step 监听器源码注释、driver 追加的运行时快照），所以“最后一条 user 消息”实测就是注入内容——`Current DSH file policy: …` **确实**会被转给 ACP agent（连同 AGENTS.md 摘要与技能目录）。修复见 [acp-mode.md](./acp-mode.md) §1（`selectForwardPrompt` 按 `source.kind === 'user'` 挑消息）与 [AGENTS.md](../AGENTS.md) 约束 16。
2. ACP 的 `tool_call` / `tool_call_update` 在 `streamPrompt` 里变成了内联散文（`🛠️ **<name>** · `<input>`，工具输出跑进一个代码块），插在思考与答案之间的位置上 → DSH 不执行它们 →
   **DSH 文件沙箱对 ACP agent 的内部 bash / 编辑没有任何作用力**。
   > **已修正（原文前半句两度改写，结论始终成立）**：中间曾把工具活动升级成真的 `tool-call` block 序列，又短暂退回内联散文（一步回合放不下「步与步之间」），现行（2026-10-24）是**逐步切分**（[acp-convergence.md](./acp-convergence.md) §1.8）：段在卡后主动结束，宿主执行卡、续跑下一步，续读同一个在飞的 `session/prompt`。这不改变本节结论：DSH 的文件沙箱仍然管不到 agent 自己进程里的 bash / 编辑——宿主执行的卡片是展示面（虚拟工具体答的是 agent 已产出并记录在案的输出），与 agent 进程内的工具是两件事。「不替 agent 裁决」的现行结论见同文 §2.3。
3. 唯一真正连上的旋钮是 approval（`AgentBridge.askNativeApproval` → `ctx.approval.request`）。于是三档实际行为：
   - 工作区内修改（ask）：ACP 权限询问 → composer 审批卡 ✅
   - 仅可查看（ask）：用户点「允许一次」就能写 ❌（违背只读语义）
   - 完全权限（**never**）：所有 ACP 权限请求被**确定性 reject** ❌（与标签完全相反）

   > **【已退役，2026-10-28】上面这条宿主审批路由已删除，这几行按历史记载读。** 现行只有插件自己的 `PermissionLedger`：`AgentBridge.handlePermissionRequest` 把每一问广播成 `permission/request`，卡片在对话 `PermissionDock`（`conversation.input.dock`）与设置页镜像上等人回答，到点就地收场（`wait` 不设期限 / `abort` 拒绝 / `auto` 按 option kind 代答）；`askNativeApproval`、`approvalRouted`、`ctx.approval.request` 与 native 超时转移都已不存在，宿主 approval policy（`ask` / `never`）也不再作用于 ACP 询问。现行管线见 [agents/permissions.md](./agents/permissions.md)。

4. 真正对 ACP 有力的仍是我们自己的 `AcpAgentDef.permission`（`AgentBridge.handlePermissionRequest` 短路）与 `allowedCwdRoots`（`fs/read_text_file` / `fs/write_text_file` 白名单）。
   > **【已退役，2026-10-28 复核】`AcpAgentDef.permission` 已不存在**（字段与 `AgentBridge.permissionDecision` 在 2026-10-24 逐步切分那次改动中一起删除，[retired.md](./agents/retired.md) 已收录），`handlePermissionRequest` 也不再按它短路——这一条按历史记载读。现行只有插件自己的 `PermissionLedger` 一条管线（见上一条注记与 [agents/permissions.md](./agents/permissions.md)）；**仍然有效的是 fs 围栏**：`AgentBridge.handleFsWrite` 的 `allowedCwdRoots` 白名单不变。

## 3. 方案 2（把 ACP 自己的权限塞进原生选择器）可行性裁定

- **替换原生下拉：不可行，不要做。** `permissions` 是 `dsh-permission-presets` **独占注册**的 projection key（`sessionProjections.register({ key: 'permissions', … })`），
  options 来自静态 preset 表；第三方插件既不能往该 key 塞 options，也不能按会话覆盖。客户端 `PermissionSelect` 只认这份 projection。
  要改只能改部署级 config patch（全局生效），且 preset 只能携带 `sandbox` / `approval` 两个 knob，装不下 ACP 的 `modeId`。
- **另加控件：可行，且有官方座位。** `conversation.input.left` 的契约原文是"住在 access mode / plan / attach 旁边的常驻小控件，
  **只并排、不替换**"（`packages/client/ui-conversation/src/client/contract/slots.ts` 的 SlotMap 注释）。owner share 是
  `InputZone{session: ConversationSnapshot; input: InputState}`（scope `session`，每次渲染给新快照）。
  数据侧我们已有 `session.modes` + `setMode`，只需补一条按 DSH 会话 id 查/设 mode 的 RPC。

## 4. 方案 1（原生 Access mode 驱动 ACP）设计

> **【已退役，2026-10-14 / 约束 15】整节作废，按历史记载读，不要照着实现。** 按用户意图——**ACP agent 完全自治，DSH 的 Access mode / sandboxPolicy 不参与裁决**——宿主不再坐在中间替 agent 判一遍。当时的代码：`AgentBridge.permissionDecision` 只读 agent 自己的 `def.permission`（`ask` 走约束 13 的原生审批链，`allow` / `reject` 本地作答）；`AgentBridge.handleFsWrite` 只剩 `guardFsPath` 的 workspace containment（`resolveFsPath` 的 roots 校验**无条件**生效，`danger-full-access` 之类的 access mode 到不了这条路径，也放宽不了它）；`decidePermission` / `authorizeWrite` / `dshSessionPolicyOf` / `wireAccessMode` 全部已删。**【2026-10-28 补记】审批侧比这段记载更早退场**：`permissionDecision` / `def.permission` 与原生审批链一样不存在，每一问只经 `PermissionLedger` → `permission/request` → 对话 `PermissionDock`（现行模型见 [agents/permissions.md](./agents/permissions.md)）。本节唯一仍然有效的是下面「同一个 `workspaceRoot` 也是聊天会话的 ACP 工作目录」那一段（约束 15 的「工作目录」「进程 cwd」两条）。
>
> 「二者互补」这个说法同样作废：让 ACP 模式控件出现的闸门会把原生 Access mode 整格占空，两个控件**从不同屏**。

分层原则：**原生 Access mode 管"边界 + 要不要问人"，ACP 自己的 mode 管"agent 用什么方式干活"**。二者互补，不是二选一。

宿主侧每次 turn 开头（`streamPrompt` 已拿到 `dshSessionId`）解析快照：

| 来源 | 读法 |
| --- | --- |
| sandbox 模式 + workspaceRoot | `ctx.sandboxPolicy.resolve({ session })`（`packages/sandbox/sandbox-policy/src/index.ts`，其实现是 `session?.header.cwd ?? config.workspaceRoot`——即**会话自己在 sidebar 选中的工作区**） |
| approval policy | 会话事件里最后一条 `approval/policy` → `data.policy`；无则 `ctx.approval.config.policy` |
| 会话本身 | `ctx.sessions` 按 id 取（`session.events`） |

编译成 per-session 判定，替换 `def.permission`（无快照时回落到 def，保持 `/acp` RPC 会话行为不变）：

- `approval: never` → **不再把请求递给 `ctx.approval`**（那里必然 rejected）；本地裁决：`danger-full-access` 放行、其余按 mode 判。
- `approval: ask` → 当时沿用 composer 审批路由（约束 13 的旧形态，已随该路由退役）。
- `sandbox: read-only` → 写类请求直接拒（`toolCall.kind ∈ {edit, delete, move}`；`execute` 视作未知 → 按 approval 处理），
  对齐 DSH 的 "cannot modify files in the standing mode"；fs handler 的写同样拒。
- `sandbox: workspace-write` → 路径落在 workspaceRoot / 我们的 roots 内放行，域外走审批（ask）/ 拒绝（never）（即 DSH 的 escalation 语义）。
- `sandbox: danger-full-access` → 放行 + roots 检查放宽。

同一个 `workspaceRoot` 也是聊天会话的 **ACP 工作目录**（`session/new` / `session/load` 的 cwd，见 `BridgeManager.getOrCreateDshSession` 的 `chatWorkspaceRoot`）：
用户选的是「会话在哪个目录里」，对端 agent 的 Read/Glob/Bash 必须看到同一个目录，否则它会如实回答当前工作区是插件沙箱目录（`~/.dsh/dsh-ntr/workspaces`）。
该目录以 `extraRoots` 形式加进该会话的 roots 校验（`resolveSessionCwd` 第 4 参），create 与 resume 两条路径都传；`/acp` RPC 会话没有 DSH 会话，仍用 agent 自己的 `cwd`。
同一个工作区还必须作为 `spawnCwd` 传进 `AgentBridge.ensureReady`，让 **agent 子进程自己的 cwd** 也落在那里（`safeSpawnCwd`）：
有的 agent（实测 codebuddy）在进程启动那一刻就打印 `Workspace Path: <process cwd>` 并据此定死自己的 workspace（项目态、file policy、给模型看的 env 块），
`session/new` 的 cwd 对它们太晚，只改 session cwd 时它会照旧回答 `~/.dsh/dsh-ntr/workspaces`。搬迁只发生在 bridge **空闲**（无 live session / 探测 / resume / 待答审批）时就地重启，
且先广播 `agent/notice`；有会话的进程不杀（`session/new` 仍如实带上各会话自己的工作区）。
- ~~叙述兜底：把 policy 句子拼进转发给 ACP 的 prompt 前缀~~ —— **已放弃**（用户裁定：没必要）。
  转发内容严格等于用户文本；access mode 只以裁决（`decidePermission`）与 fs 栅栏（`authorizeWrite`）的形式生效，
  不再有任何句子去影响"agent 自己怎么干"。见 [acp-mode.md](./acp-mode.md) §3。

## 5. 硬约束调研：真沙箱能不能套在 ACP 子进程上

**能，seam 是现成的**（DSH 就是用它跑 bash / fs 的）：

- `ctx.sandbox.confine(argv, { mode, workspaceRoot, sessionId })` → `ConfinedArgv{argv, enforcement, denialSignatures, runnerFailureRules}`
  （`packages/sandbox/sandbox/src/index.ts` 的 `SandboxProvider`）。调用方 spawn 返回的 argv；无法约束时 **fail closed** 抛 `SandboxUnavailableError`（`SANDBOX_UNAVAILABLE`），不允许静默放行。
- Linux 后端链 bwrap → Landlock（`packages/sandbox/sandbox-local/src/index.ts` 的选择与探测），profile 见 `profiles.ts`：
  - bwrap：`--ro-bind / /` + `--unshare-pid` + workspace-write 时 `--bind <workspaceRoot>`、`--tmpfs /tmp`。
  - Landlock：`readOnly: ['/']`，`readWrite: ['/dev/null']`（workspace-write 再加 `/tmp` + workspaceRoot）。
- 可写根只有 **workspaceRoot + /tmp +（macOS）os.tmpdir()**（`packages/sandbox/sandbox/src/roots.ts` 的 `writableRoots`，与 `ctx.fs` 的写栅栏同源）。
- **网络与进程可见性不在该词汇表内** → LLM API 调用不受影响。
- 本机事实：`unprivileged_userns_clone=1`、`max_user_namespaces=52090`、`/usr/bin/bwrap` 存在；
  但 `@deepseek-ai/node-addon-landlock-run` 在用户 profile 里是**断链**（`~/.dsh/profiles/node_modules/@deepseek-ai/` 下的符号链接目标不存在）→ 实际只有 bwrap 这一级。
  注意：我在受限 shell 里直接跑 bwrap 会失败（`setting up uid map: Permission denied`，`CapEff=0`），这是**我的执行环境**而非用户会话的能力缺失，别据此下结论。

**接入点与代价**

1. `AgentBridge.spawnAndConnect` 里的 `spawn(command, args)` 用 `confine()` 包一层即可（`sessionId` 传 DSH 会话 id）。
2. 但 `writableRoots` 只给 workspace + /tmp → **agent 自己的状态目录（`~/.codex`、`~/.claude`、npm 缓存）不可写**，
   `read-only` 更是零可写根。多数 agent 启动就要写状态/日志，会直接崩。
   现实路子：把状态目录搬进会话 workspace（各 agent 的环境变量，如 `CODEX_HOME` / `CLAUDE_CONFIG_DIR`），或用 per-agent 显式配置声明；
   不能凭空扩展 `SandboxPolicy`（该类型没有 extra-roots 字段）。
3. `ensureAgentExecutable` 的 `npm install -g` 冷装需要写全局目录，与任何 confined 模式都不兼容 → 需要"先装好再约束"或显式 `danger-full-access`。
4. `enforcement` 可能是 `partial`（Windows ACL 后端即如此）→ 必须在 UI/日志里如实上报，不能宣称绝对边界。
5. 结论：这是让「仅可查看」名副其实的**唯一**路子，但属于独立立项（per-agent 兼容矩阵 + 状态目录迁移 + 失败语义 UI），不适合与方案 1/2 同批。

## 6. 落地顺序（本仓）

> 状态更新（2026-10-14 / 2026-10-18 两次修订）：第 1 项**已退役**——方案 1 语义随约束 15 一起作废，宿主不再替 agent 裁决（见 §4 顶部的退役说明）。第 2 项已落地（`conversation.input.left` 的 ACP mode 控件 + `session/set_mode` RPC），并且它现在**不与原生 Access mode 同屏**：NTR 会话里后者被 `createPermissionSeatClaim` 整格占空。第 3、4 项仍未做。

1. **方案 1 语义**（宿主侧，正确性修复）：per-session 快照 → 判定替换 `def.permission`；`never` 不再递 `ctx.approval`；fs 写栅栏按 mode 生效。（原文还包括 policy 叙述注入 prompt 前缀，已放弃。）
2. **方案 2b 控件**：`conversation.input.left` 注册 ACP mode 选择器 + `session/set_mode` RPC（按 DSH 会话 id 定位）。
3. **可选**：per-agent 的 preset → modeId 映射（只认显式配置，不猜）。
4. **独立立项**：ACP 子进程沙箱化（§5）。

验证：`npx tsc --noEmit`、`npm test`、`npx tsdown`；新增用例落在 `tests/impl.spec.ts`（纯判定）与 `tests/bridge.spec.ts`（三档映射 + 降级）。
