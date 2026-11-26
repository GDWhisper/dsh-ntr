# 方案：Antigravity 固定选择题的识别与到期策略

**状态**：**已实施，待真机抓帧确认**（宿主与客户端已落地，typecheck / 行数门禁 / 定向 vitest 通过；`interaction_` 前缀与选项形状仍待一次已认证 agy 提问确认，见 §2.3 与 §13）。
**适用范围**：`agy acp` 在 `session/request_permission` 里发起的固定选择题（`toolCallId` 以 `interaction_` 开头）；识别与到期策略对其它 agent 一律不生效。
**一句话**：agy 的「你选哪个方案」走的是审批方法，今天被当成工具审批——`auto` 档会替用户选答案，卡片也读成「允许/拒绝」。本方案给它一个**语义分类**（`askKind`），让问题不再被代答、有自己的到期策略（默认取消，用户可显式开启「到期自动选第一项」），并把卡片改成问题形态。

> 写作约定：代码位置一律用「文件 + 符号名」，不写行号。本文不是 `AGENTS/` 文档；落地时行为契约进 `AGENTS.md` 约束 13 / 14 与 `AGENTS/permissions.md` §5。

---

## 1. 结论与拍板点

1. **不新开第二条问答通道**：仍是 `PermissionLedger` + `permission/request` 一帧 + 一处结算（约束 13）。只给这次询问加一个显式语义字段 `askKind: 'approval' | 'question'`，不把问题导入 `ElicitationLedger`。
2. **默认不代答**：问题到期只结算 `cancelled`；`pickAutoOption` 对问题**一律不参与**（它按 kind 优先级先挑 `allow_always`，对问题是错的答案）。
3. **代答是用户显式开的一档**：新增独立轴 `questionTimeoutMode: 'cancel' | 'first'`，默认 `'cancel'`。`'first'` = 到期选**第一个**可选项。
4. **「推荐选项」是近似，不是协议语义**：ACP 的 `PermissionOption` 规范字段只有 `optionId` / `name` / `kind`（外加可选 `_meta` 扩展点），规范没有定义任何推荐位，也不允许假定 `_meta` 里某个键的含义。实现按选项顺序取第一项；UI 文案写「到期自动选第一项」，**不写「推荐项」**。将来若抓到 agy 在 `_meta` 里显式标注，再升级取值链（显式标记 > 第一项）。
5. **问题用独立的等待窗口**：沿用 `elicitationTimeoutMs`（默认 `0` = 不设限），不受 `permissionTimeoutMs` 与 `permissionTimeoutMode` 影响。
6. **开关粒度**：全局一档（与 `elicitationTimeoutMs` 同级），不做 per-agent 覆盖（§10 记录为已定）。
7. **`0` = 不设限，自动选择不触发**：不静默改写用户选的 0，只在设置页同一行提示（约束 33：覆盖事实可见）。

### 非目标

- 不做「问题历史 / 重新回答」：ACP 一问一答，答案发出即结束。
- 不改工具审批的既有行为（`abort` / `auto` / `wait`、`pickAutoOption`、委派 `preferOnce` 全部原样）。
- 不把 agy 的问题改造成 `elicitation/create`：wire 上必须回 `RequestPermissionResponse{ optionId }`，不是 elicitation 的 `content`。
- 不解决「自由文本回答」：permission 通道只能回 `optionId`，若 agy 的提问需要用户自由输入，本方案只能取消或选一个给定选项（见 §9）。真正的解法要 agy 改发 `elicitation/create`。
- 不读 agy 私有 store 来推断问题文本（本方案只吃 wire；transcript 那条路是 `docs/plan/antigravity-subagent-panel.md` 的范围）。
- 不新增运行时落盘文件（约束 28）：新配置项落 `agents.json` 的 `approvalDeadlines`。

---

## 2. 现状与证据

### 2.1 今天发生什么

| 事实 | 位置 |
|---|---|
| agy 的固定选择题走 `session/request_permission`，与工具审批同一方法 | 外部实证：固定选择题以 `interaction_` 为 `toolCallId` 前缀走 `session/request_permission`；其官方交互语义为「Questions with fixed choices still need one of the offered answers, even in Full access」 |
| 公开报告（2026-11-16）记录同一形状：`interaction_<8 hex>` + `session/request_permission`；同时提到长选项被裁剪、**无法自由文本作答** | 该报告针对独立 `antigravity-acp` v1.5.0，**不是**对内置 `agy acp` 的直接验证——只能作为假设，仍需 §2.3 抓帧；自由文本限制见 §9 |
| 本仓对这类询问**零特判** | `src/bridge/agent-bridge.ts` · `handlePermissionRequest` 只读 session / toolCall / options，无前缀判断 |
| `auto` + 窗口 `0` 在请求到达时立即收场 | 同文件：`mode === 'auto' && timeoutMs === 0` → `settleExpiredAsk` |
| 到期/到达代答按 kind 优先级 | `src/impl/permission.ts` · `pickAutoOption`（`AUTO_OPTION_KIND_PRIORITY` = `allow_always` → `allow_once` → …） |
| 卡片头部是工具名，选项按原序当审批按钮 | `src/client/permission-dock.tsx` · `PermissionAskCard`（`permission.toolName` + 选项原样按钮） |
| 表单提问（`elicitation/create`）已通用，但 agy 的 `interaction_` 提问**不走**这条 | `src/bridge/elicitation-bridge.ts` · `handleBridgeElicitationRequest`；`src/impl/elicitation.ts` · `parseElicitationForm`（只认 `mode === 'form'`） |

### 2.2 后果

- `auto` 档下用户从没做过的选择被发回 agent，且优先挑 `allow_always`——不只是替用户答题，还可能顺手授予长期权限。
- `auto` + `0`（「不等待」）连卡片都不出现，用户看不到发生过什么，只有一条 notice。
- 即便用户手动答，卡片读起来像审批：看不出这是一道「选哪个方案」的问题，「Always Allow」这类措辞出现在答案选项里。

### 2.3 实施前必须抓到的真机证据

抓一个已认证的 agy 会话里**一次真实提问**的 `session/request_permission` 参数（不改代码：临时在 `handlePermissionRequest` 入口打一行结构化日志，或在既有会话日志里捞）：

1. `toolCallId` 是否**全部**带 `interaction_` 前缀（公开报告给的是 `interaction_<8 hex>` 形状），有没有第二种命名。**注意：现有公开证据全部来自独立 `antigravity-acp`，内置 `agy acp` 未经直接验证**——这一条不确认，整个识别规则不能定稿。
2. 选项的 `kind` 实际取值——若是 `allow_once` / `allow_always`，说明「永久允许」的措辞会出现在问题卡上，必须按 `askKind` 屏蔽。
3. 问题文本落在 `title` 还是 `rawInput`；是否带可用的 `_meta` 标记（决定「推荐项」能否升级为协议信号）。
4. 回 `cancelled` 之后 agy 是**继续回合**还是终止这一轮——决定 `'cancel'` 的默认窗口该不该更长、以及 notice 文案。
5. 当前 agy 版本是否已经改发 `elicitation/create`；若是，这条分支只作旧版兼容，优先级下调。（截至 2026-11-26 的公开资料没有找到切换证据：Google 文档只说支持 elicitation 的客户端会看到原生表单，未写线级方法。）
6. 问题是否**需要自由文本**（公开报告称选项被裁剪、自由文本不可用）：若 agy 的提问本就期待自由输入，permission 通道只能取消或选一个给定项。

任何一条与上述假设冲突，先改本文 §4 的判定表再动代码。

---

## 3. 契约

```ts
// src/protocol/events.ts（或 protocol/permission.ts）
export type PermissionAskKind = 'approval' | 'question'
export type QuestionTimeoutMode = 'cancel' | 'first'

interface PendingPermissionFields {
  // …既有字段…
  /** 缺省 = 'approval'：旧宿主 / 旧客户端不写也不读，按审批渲染。 */
  askKind?: PermissionAskKind
  /** 仅 question：到期策略，缺省按 'cancel' 处理。 */
  questionTimeoutMode?: QuestionTimeoutMode
  /** 仅 question 且策略为 first：宿主解析出的那一项，卡片据此显示「到期将自动选择「X」」。 */
  autoOptionName?: string
}
```

- 两个字段都进 `src/impl/permission.ts` · `permissionRequestFrame`：live 与重连重放共用这一个构造器，否则重连后卡片会丢掉问题形态。
- `permission/expired` 帧同步加 `askKind`（与可选 `optionName`）：卡片消失后，对话里那一行要说清「到期取消」还是「到期代答」，否则两种结局读起来一样。
- `askKind` 缺省视为 `'approval'`：老宿主 / 老客户端不会因为新字段缺失而改变行为。
- 不用布尔、不用「有 title 就是问题」这类时序推断（约束 17）。

---

## 4. 宿主改造

### 4.1 分类（纯函数）

`src/impl/permission.ts` 新增：

```ts
export const AGY_QUESTION_TOOL_CALL_PREFIX = 'interaction_'
export function permissionAskKind(toolCall: unknown): PermissionAskKind
```

- 规则收在一处，主键是 `toolCallId` 前缀（§2.3 第 1 条确认后才定稿）。
- **fail-open**：读不到 id、前缀不匹配、形状异常 → `'approval'`，既有路径逐字不变。
- 只有 `isAntigravityAgent` 的 bridge 才可能命中（避免别的 agent 恰好用同名 id 时被误分类）；门禁放在 `AgentBridge`，不放在纯函数里（纯函数保持可单测、无 agent 依赖）。

### 4.2 到期取值（纯函数）

`src/impl/permission.ts` 新增：

```ts
export function pickQuestionDefault(options: readonly PermissionOptionView[]): PermissionOptionView | undefined
```

- 取**第一个 `optionId` 非空**的选项（保持 agent 原序）；没有可用项 → `undefined` → 调用方结算 `cancelled`。
- **不复用** `pickAutoOption`：kind 优先级对问题无意义（§1.2）。

### 4.3 `handlePermissionRequest`

`src/bridge/agent-bridge.ts` · `handlePermissionRequest`：

1. 在 `mode === 'auto' && timeoutMs === 0` 的早返回**之前**算 `askKind`。
2. `askKind === 'question'` 时：
   - 跳过早返回（问题永远建卡，不存在「问都来不及问」）；
   - 窗口 = `elicitationTimeoutMs`，`timeoutMode` 不参与判定；
   - `deadlineAt = elicitationTimeoutMs > 0 ? now + window : undefined`；
   - 视图带 `askKind`、`questionTimeoutMode`、以及 `'first'` 时解析出的 `autoOptionName`。
3. 到期走 `announceExpiredAsk` 的新分支（见 4.4），审批分支一字不动。**策略与窗口在询问开始时读一次**（与既有 `mode` / `timeoutMs` 同一纪律）：中途热改只影响下一次询问，已建卡片的「到期将自动选 X」不会与实际行为背离。
4. 委派会话（`session.permissionPolicy` 存在，如 `acp_delegate`）：没有人类可答——策略 `'first'` 则按同一规则代答，`'cancel'` 则**立即** `cancelled` + 一条 notice；两种都不再「等人」。

### 4.4 到期决策表

| askKind | questionTimeoutMode | 窗口 | 到期结果 |
|---|---|---|---|
| question | `cancel`（默认） | > 0 | `cancelled` + 恰一条 notice「问题到期，已取消，未替你作答」 |
| question | `first` | > 0 | `selected(第一项)` + 恰一条 notice「问题到期，已自动选择「X」」 |
| question | `first` | 0 | 不设限，永不触发（设置页同屏提示） |
| question | 任意 | > 0 | 无可用选项 / id 全空 → `cancelled` + notice |
| approval | — | — | 完全不变：`abort` / `auto`（`pickAutoOption`）/ `wait` |

`announceExpiredAsk` 增 `askKind` 入参：问题分支只发一条 notice + 一条 `permission/expired`（带 `askKind`、`optionName?`），绝不出现第二条；审批分支的文案与字段保持原样。

---

## 5. 界面

### 5.1 对话卡片

`src/client/permission-dock.tsx` · `PermissionAskCard` 按 `askKind` 分两种渲染（共用 `PendingDockShell` / `DeadlineBadge` / `useDeadlineClock`）：

- **问题态**：标题用问题原文（`permission.reason` 或 `toolCall.title`，宿主已整理）；选项做**单列选择**（原序、原文案），点击即答；保留单独的取消键；不显示工具名、不出现「Always / 永久允许」这类审批措辞。
- **到期提示行**：`cancel` → 「到期将取消，不会替你作答」；`first` → 「到期将自动选择「X」」（X 用宿主给的 `autoOptionName`，不让浏览器自己推）。
- 审批态零改动。

### 5.2 设置页

`src/client/panel/approval-deadlines-card.tsx` · `ApprovalDeadlinesCard` 的「表单提问时限」子栏目下加两个小档（复用整宽分段按钮样式）：

- 档位：**到期取消**（默认）/ **自动选第一项**。
- 同一行给一句说明（约束 33 的文案预算）：`0 = 不设限，自动选择不会触发` 只在窗口为 0 且策略为 `first` 时出现，警告色。
- `approvalDeadlineFacts` 的返回值加一项 `questionModeBaseline`（配置文件的策略与本机不同才有值），与现有 `baseline` / `elicitationBaseline` / `modeBaseline` 同形；被 `cordis.patch.yml` 覆盖时按既有「覆盖事实可见」规则挂到对应行（约束 33）。

### 5.3 跨会话镜像

`src/client/panel/permission-mirror.tsx` · `PermissionMirrorCard` 同步问题形态（同样的标题/选项/到期提示），没有聊天身份的询问只有这里能答。

---

## 6. 配置与落盘

- **存储**：`agents.json` 的 `approvalDeadlines.questionTimeoutMode`（`'cancel'` 不落盘，缺省即 `'cancel'`；`'first'` 才写，保持状态文件干净）。
- **校验**：新增 `validateQuestionTimeoutMode(raw, code)`（`'cancel' | 'first'`），与 `validatePermissionTimeoutMode` 同形；`validateApprovalDeadlines` 只管数字，模式按现有做法在调用处单独校验。
- **写入**：`ui/approval-deadlines-set` 的 patch 收下新键 → `SettingsService.setApprovalDeadlines` 合并 → `applyDeadlineTuning` → `AgentBridge.applyApprovalDeadlines`。热生效，不重启、不杀会话（约束 9）。
- **启动复核**：`SettingsService.loadPersistedSettings` 里 `approvalDeadlines` 那段目前整块 `try/catch` 后清空 override。新增键必须**逐键宽松**校验：未知值只丢这一个键，不能把用户已设的窗口一起抹掉（这是本次最容易踩的坑）。
- **重置**：`reset` 清空 override 时一并回到 `'cancel'`；设置页的重置按钮只在真的覆盖了才出现（约束 33）。
- **`0` 语义**：`elicitationTimeoutMs: 0` 保持「不设限」，不与新开关联动、不静默改写（§1.7）。

---

## 7. 文档同步（与实现同一次提交）

- `AGENTS.md` 约束 13：现在写「表单提问到期恒取消」——补第三族：**表单提问**仍恒取消；**问题型 permission** 受 `questionTimeoutMode` 约束，默认取消、可显式开启自动选第一项。
- `AGENTS.md` 约束 14：对话卡片的两种形态（审批 / 问题）与设置页镜像。
- `AGENTS/permissions.md` §5：新增「问题型 permission」小节，含决策表与 `0` 语义。
- `AGENTS/ui-panel.md` §8：审批时限卡新增的两个小档、覆盖可见性、`0` 提示。
- `AGENTS/conversation-dock.md` §10：问题卡形态与到期提示行。
- `cordis.patch.yml`：`approvalDeadlines` 注释补新键（只注释，不写默认值）。
- `CHANGELOG.md` 不动（约束 35）。

---

## 8. 测试与验收

单测 / 桥接（`tests/impl/permission.spec.ts`、`tests/bridge/`）：

1. `permissionAskKind`：命中前缀 → `question`；空 id / 非字符串 / 其它前缀 → `approval`；非 agy bridge 永不为 `question`。
2. `pickQuestionDefault`：取第一个可用项；全空 → `undefined`；**不**按 kind 排序。
3. `auto` + `0` + 问题：仍建卡、不 `selected`、不调用 `pickAutoOption`。
4. `first` 到期：只 `selected` 第一项，notice 恰一条且点名；`permission/expired` 带 `askKind` + `optionName`。
5. `cancel` 到期：不 `selected`，notice 恰一条。
6. 窗口 0 + `first`：永不触发。
7. 委派会话：`cancel` 立即 `cancelled`；`first` 按规则代答。
8. 审批回归：非 `interaction_` 的 `abort` / `auto` / `wait` 与 `preferOnce` 逐字不变。
9. 重连重放：问题询问经 `permissionReplayFrames` 重放后与 live 帧逐字节一致（含新字段）。

设置（`tests/impl/dispatch.spec.ts`、`tests/bridge/chat-picks-deadlines.spec.ts`）：

10. `ui/approval-deadlines-set` 收 `questionTimeoutMode`；非法值 `bad_payload`。
11. 落盘只写 `'first'`；`reset` 回到 `'cancel'`。
12. 启动复核：坏值只丢该键、窗口仍在；合法值重启后仍生效。
13. 热改推给活动 bridge（`applyApprovalDeadlines`）。

界面（`tests/panel/`、`tests/elicitation-dock.spec.tsx` 同层的 dock 用例）：

14. 问题态渲染：标题、单列选项、取消键、到期提示行文案；不出现工具名。
15. 审批态快照不变。

验收口径：`npm run verify` 全绿；真机上 agy 提一个问题 → `auto` 档不再自动作答；开 `first` 后到期自动选第一项并在对话里点名；关回 `cancel` 后到期取消并留痕。

---

## 9. 风险与回退

| 风险 | 处理 |
|---|---|
| 前缀判定误伤真实工具审批（把审批当问题，`auto` 不再代答 → 无人值守的回合停住） | fail-open 到审批；只对 agy bridge 生效；§2.3 第 1 条确认后再定稿 |
| 「自动选第一项」等于替用户做了决定 | 默认关；notice 点名选了什么；用户可下一条消息纠正 |
| agy 复用 `allow_always` 语义做选项，第一项可能读作「永久允许」 | 问题态卡片不渲染 kind 措辞；§2.3 第 2 条确认后若确有该 kind，在宿主侧记录一条 notice 提示语义 |
| `cancelled` 会终止 agy 整轮 | §2.3 第 4 条确认后，把默认窗口调长并在卡片上说明「取消会结束本轮」 |
| 启动复核整块 catch 清空 override | §6：逐键宽松校验 + 用例 11 |
| 委派会话里 `cancel` 立即取消，可能让一个本来要提问的委派任务直接失败 | 先按默认执行并留 notice；若真机上委派任务频繁因提问而失败，再单独讨论「委派默认 `first`」——那会改变本方案的默认，必须重新拍板 |
| 旧宿主 / 旧客户端不认新字段 | `askKind` 缺省 = `approval`；`questionTimeoutMode` 缺省 = `cancel`；帧字段全部可选 |
| 提问需要自由文本，而 permission 通道只能回 `optionId` | 本方案不解决：卡片只提供给定选项与取消；若真机确认存在自由文本需求，另立方案（推动 agy 发 `elicitation/create`，本仓已有 form 通道） |

回退：删除 `askKind` 分支即回到今天的纯审批行为；配置键留在 `agents.json` 也不会被旧版本读取（`validateApprovalDeadlines` 会丢弃未知键）。

---

## 10. 已定的决策与遗留

已定（本方案按此实施）：

- 开关粒度：全局一档，不做 per-agent 覆盖。
- 窗口 0：保持「不设限」，自动选择不触发，只做同屏提示；不在保存时改写用户的值。
- 取值：第一项；不叫「推荐项」；等 `_meta` 证据再升级。
- 通道：留在 `PermissionLedger`，不导入 `ElicitationLedger`。

遗留（§2.3）：六条真机证据；未拿到前不写宿主代码，只允许先做抓帧用的临时日志（提交前删除）。外部公开证据已核对：`PermissionOption` 无推荐语义（可选 `_meta` 不算）、`interaction_` 形状只在独立 `antigravity-acp` 上被报告、未发现改用 `elicitation/create` 的证据——所以内置 `agy acp` 的抓帧仍是唯一可信来源。

---

## 11. 变更清单

| 主题 | 文件 + 符号 |
|---|---|
| 分类与取值 | `src/impl/permission.ts` · `permissionAskKind` / `pickQuestionDefault` / `AGY_QUESTION_TOOL_CALL_PREFIX` |
| 协议 | `src/protocol/events.ts` · `PermissionAskKind` / `QuestionTimeoutMode` / `PendingPermissionFields.askKind` / `.questionTimeoutMode` / `.autoOptionName` / `permission/expired.askKind`；`src/protocol/ui.ts` · `AcpApprovalDeadlines.questionTimeoutMode` / `ApprovalDeadlinePatch.questionTimeoutMode`；`src/protocol.ts` 桶导出 |
| 浏览器类型 | `src/client/store/permission.ts` · `PendingPermission` 新增同名字段（`askKind` / `questionTimeoutMode` / `autoOptionName`）；`src/client/store.ts` 桶导出 |
| 帧 | `src/impl/permission.ts` · `permissionRequestFrame`（透传新字段，live 与重放同源） |
| 桥接 | `src/bridge/agent-bridge.ts` · `handlePermissionRequest` / `applyApprovalDeadlines` / `expiredAskHost`；`src/bridge/expired-ask.ts` · `announceExpiredAsk` / `settleExpiredAsk`；`src/bridge/question-ask.ts` · `questionAskKindOf` |
| 配置 | `src/impl/validate.ts` · `validateQuestionTimeoutMode`；`src/bridge/settings-service.ts` · `setApprovalDeadlines` / `applyDeadlineTuning` / `loadPersistedSettings` / `approvalDeadlines`；`src/impl/dispatch.ts` · `ui/approval-deadlines-set` |
| 设置页 | `src/client/panel/approval-deadlines-card.tsx` · `ApprovalDeadlinesCard` / `approvalDeadlineFacts` / `QuestionExpiryBlock`；`src/client/store/settings.ts` · `setApprovalDeadline` / `setApprovalTimeoutMode` 同层新增 `setQuestionTimeoutMode` |
| 对话卡 | `src/client/permission-dock.tsx` · `PermissionAskCard`；`src/client/panel/permission-mirror.tsx` · `PermissionMirrorCard` |
| 文档 | `AGENTS.md` 约束 13 / 14；`AGENTS/permissions.md` §5 / §5.1；`AGENTS/ui-panel.md` §8；`AGENTS/conversation-dock.md` §10.0.2 |
| 用例 | `tests/impl/permission.spec.ts`（`permissionAskKind` / `pickQuestionDefault`）；`tests/bridge/expired-ask.spec.ts`（问题 `first` / `cancel` / 无可用选项 / 委派即结算 + 审批回归） |

---

## 12. 审核记录（2026-11-26）

**外部事实核对**（子代理 web 研究；本会话只有 web 研究代理可用，代码审核由主代理完成）：

1. `PermissionOption` 的规范字段是 `optionId` / `name` / `kind` + 可选 `_meta`；`kind` 四值确认；规范未定义任何推荐语义，也不允许假定 `_meta` 键的含义。→ §1.4 已按此改写（原稿写「只有三个字段」不准确）。
2. `elicitation/create` 同样没有推荐答案语义，但 form schema **可以带 `default`**（客户端应预填）——与本题无关，但反向确认了「推荐」只能来自选项顺序。
3. `interaction_` + `session/request_permission` 有公开 ACP 适配实证与 2026-11-16 报告支持，但报告针对独立 `antigravity-acp` v1.5.0，**不是内置 `agy acp`**。→ §2.3 第 1 条已加注：抓帧仍是唯一可信来源。
4. 未发现内置 agy 改用 `elicitation/create` 的证据（Google 文档只描述客户端体验，未写线级方法）。

**仓库内复核（主代理，已改回文中）**：

- 方法名：`SettingsService.loadPersistedSettings`（原稿误写 `readPersistedSettings`）。
- `PendingPermission` 在 `src/client/store/permission.ts`；`setApprovalDeadline` / `setApprovalTimeoutMode` 在 `src/client/store/settings.ts`（原稿写成 `store.ts`）。
- `approvalDeadlineFacts` 现有返回 `baseline` / `elicitationBaseline` / `modeBaseline` / `overridden`；新增项按同形命名 `questionModeBaseline`。
- `permission/expired` 需同步 `askKind`，否则「到期取消」与「到期代答」在对话里读起来一样。
- 策略与窗口在询问开始时读一次（与既有 `mode` / `timeoutMs` 同一纪律），热改只影响下一次询问。
- 委派会话立即取消可能让一个本来要提问的委派任务失败：已列为风险，并明确不在本方案里改默认。
- 自由文本回答、per-agent 覆盖、把问题导入 elicitation 通道：均明确不做或另案（见非目标 / §1.1 / §1.6）。

**结论**：方案可进入抓帧阶段；§2.3 六条证据到位前不写宿主代码。

---

## 13. 实施记录（2026-11-26）

按 §1 落地，全部改动未提交：

- 分类与取值：`permissionAskKind`（前缀 `interaction_`）/ `pickQuestionDefault`（第一个 `optionId` 非空项），门禁 `questionAskKindOf` 只认 `isAntigravityAgent`，读不到 id 即 `approval`（fail-open）。
- 到期：抽到 `src/bridge/expired-ask.ts`（过行数门禁），问题与审批共用一处结算；问题在 `cancel` 下 `cancelled` + 恰一条 notice，`first` 下发送第一项并点名；`0` 窗口不建 deadline。
- 设置：`questionTimeoutMode` 落 `agents.json` 的 `approvalDeadlines`，启动逐键宽松校验（坏键丢弃、不整块清空）；`ui/approval-deadlines-set` 接受并校验新键；**未**加 `cordis.patch.yml` 基线（内置 `cancel` 即基线）。
- 卡片：`PermissionDock` 问题形态（标题提问原文、单列、到期提示行）；设置卡 `QuestionExpiryBlock` 两档 + 窗口 0 警告；镜像卡同形态。
- 未做：spawn 级端到端问题用例（mock 需真 `agy` 启动形状才能过门禁，成本高于价值）；真机抓帧。

验证：`npx tsc --noEmit`、`node scripts/check-file-size.mjs`、定向 vitest（permission / expired-ask / permissions / permission-deadlines / panel permissions / acp-view / dispatch / chat-picks-deadlines）全绿；`npm run verify` 见提交前最后一轮。
