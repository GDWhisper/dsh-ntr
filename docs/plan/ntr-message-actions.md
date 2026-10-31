# NTR 会话内的消息动作接管：隐藏宿主三图标 + 自绘分支入口

**状态**：已实现（分支 `feat/ntr-message-actions`，待审核合并）。**适用范围**：`dsh-ntr` 浏览器半区 + 宿主桥接层。
**一句话**：NTR（ACP preset）会话里，把宿主的「好的回答 / 有问题的回答 / 在新对话中分支」三个图标藏掉，换成插件自己的分支按钮（同一图标、同一尺寸），由插件掌握可用性；点下去走「宿主分叉 DSH 会话 → 插件分叉 ACP 会话」两级链路，得到一条 agent 真正记得上文的子会话。

> 本文是**可独立接手**的方案：读完 §1 就能知道为什么，读完 §3/§4 就能直接改，§8 是验收口径。任何新会话的 agent 都不需要回看历史对话。

---

## 1. 目标与非目标

### 目标

1. NTR 会话的助手消息尾部**只保留**：复制、时间、usage，以及插件自己的分支按钮。宿主的点赞 / 点踩 / 分支三个按钮在 NTR 会话内不可见。
2. 自绘入口**视觉与宿主一致**（同一个图标组件、同一套尺寸与颜色 token、同样的 hover 揭示、同样的 tooltip 位置）。
3. 分支是否可用**由插件判定**，六态明确（§3 D4），禁用时置灰并给一行理由，**不隐藏入口**。
4. 点击成功后得到一个**真分叉**：子 DSH 会话的历史被复制，子 ACP 会话是 agent 自己 fork 出来的（agent 记得上文），不是「客户端贴背景」。
5. 对非 NTR 会话**零影响**：样式作用域不命中、按钮不渲染。

### 非目标

- 不改宿主任何 JSX / 组件（不覆盖 `conversation.chat.node` 的 `turn-tail`，不克隆 `MessageIconActions`，不碰 `turnTail` / `assistant-actions` 两个子槽的声明）。
- 不做「不支持原生分叉时的降级分叉」（把 transcript 拼进首轮 prompt）。那会废掉 provider 前缀缓存，且还原不了 agent 内部状态；既不真，也不省。
- 不在本方案里改宿主的反馈（feedback）数据面：只是不显示入口，**不删已有反馈记录**。

---

## 2. 关键事实（全部经读码/实机核对，改动前不必重查）

### 2.1 三个图标从哪来

| 图标 | 来源 | 证据 |
|---|---|---|
| 好的回答 / 有问题的回答 | `@deepseek-ai/dsh-client-ui-message-feedback` 注册进 `conversation.chat.assistant-actions`（`kind: 'list'`，`order: 10`），由宿主 `MessageIconActions` 作为 `extraActions` 渲染 | `dsh-client-ui-message-feedback/lib/client.js` 的 `ctx.slots.inject("conversation.chat.assistant-actions", …)`；文案键 `action.like` / `action.dislike`，激活态 `action.likeActive` / `action.dislikeActive` = 「取消标记」/“Remove rating” |
| 在新对话中分支 | **硬编码**在 `dsh-client-ui-chat` 的 `MessageIconActions` 里（没有插槽） | `MessageIconActions` 的 `onBranch !== void 0 && <Tooltip label={t("message.branch")}><button aria-label={t("message.branch")} …/>` |

三枚都是 `<button>`，class 是 CSS Module 哈希（`.xzv4MW_action`），**不能当稳定选择器**。

### 2.2 唯一稳定的 DOM 锚点

**实施修正（实测当前 `dsh-client-ui-chat` 构建）**：本文初稿写的 `data-clock` 属性**不存在**；真实锚点是 `TurnTailNodeView` 根 div 的 **`[data-turn-tail]`**（同时携带 `data-actions-reveal="always"|"hover"`，用户消息行不在其中）。以下按实测写。

- 动作行容器的作用域锚点是 `[data-turn-tail]`（`TurnTailNodeView` 根 div；`MessageIconActions` 渲染在它内部，用户消息行的 `MessageIconActions` 不带 `onBranch`/`extraActions`，本就不含目标按钮）。
- 每个按钮带**本地化 `aria-label`**，这就是可定位的稳定面：
  - 分支：`在新对话中分支` / `Branch into a new conversation`（已从宿主 lib 的词典实测确认）
  - 赞：`好的回答` / `Good response`，已选时 `取消标记` / `Remove rating`
  - 踩：`有问题的回答` / `Bad response`，已选时同上
- 复制按钮的 `aria-label` 是 `复制` / `Copy`，**必须在选择器里精确避开**（它和上面几枚同级同 class）。

### 2.3 宿主按钮的视觉数值（照抄用，别自创）

**实施修正**：以下取自宿主编译后 CSS 实测（初稿的 `border-radius: var(--dsw-radius-sm)` 有误，实际是 `28px`）。

`.action`（宿主 class 是 CSS Module 哈希）：`width/height = calc(28px + var(--dsh-content-font-delta, 0px))`、`padding: 6px`、`border-radius: 28px`、`color: var(--dsw-alias-label-tertiary)`、`background: none`、`border: none`、`display: inline-flex`、`justify/align: center`；内部 `svg` 为 `calc(15px + var(--dsh-content-font-delta, 0px))` 方；hover 走 `var(--dsw-alias-interactive-bg-hover)` + `var(--dsw-alias-label-secondary)`；`[data-unavailable]` 置灰（opacity .4、hover 还原）。
动作行：`height` 同上、`gap: 8px`、`display: flex`；助手尾部默认 `opacity: 0`，由 `data-actions-reveal`（`always` / `hover`）控制揭示。

### 2.4 图标组件可以直接拿

宿主前端模块表里注册了 `@deepseek-ai/dsh-client-ui-primitives`，导出分支图标与 `Tooltip`。**实施修正（两次）**：分支按钮的图标导出名在宿主世代间移动——较新的 npm 包导出 `IconBranchOutline16`，用户实机的桌面 0.2.1-rc.2 只有 `IconBranchOutlineRegular` / `…Medium`（宿主自己的分支按钮在 rc.2 用的就是 `…Regular`）。所以实现不做硬 import，而是 `branchIconOf` 依 `…16 → …Regular → …Medium` 逐个回退，全部缺失时按钮照常渲染、只是没有 28px 图形——缺名时 `<undefined />` 会抛「Element type is invalid」、被槽位错误边界吞成整条目消失（实机踩过）。插件当前 `package.json` 的 `dsh.client.inject` 已新增它；`tsdown.config.mjs` 的 `EXTERNAL` 也已加（图标与宿主同源）。

### 2.5 宿主侧的分叉与打开会话

浏览器服务侧（`dsh-client-ui-chat` 的 `forkAt`）：

```
ctx.sessions.fork({ sessionId, atSeq, increaseTitle: true, onCreated })
  .then((childId) => ctx.uiWorkspace.openSession(childId))
```

宿主已经负责：切点吸附到 turn 边界、日志前缀复制、`parentSession` 写入、标题递增 `(1)`、工作区归属。**插件不重写这套**（唯一 P0 事实：插件没有创建 DSH 会话的能力）。

### 2.6 ACP 侧的分叉

- 方法 `session/fork`（`AGENT_METHODS.session_fork`，SDK 方法名 `unstable_forkSession`），能力位 `agentCapabilities.sessionCapabilities.fork`，**UNSTABLE / @experimental**。
- 请求：`{ sessionId, cwd, additionalDirectories?, mcpServers? }` —— **没有切点参数**，只能从 agent 当前末端分叉。
- 响应：`{ sessionId, modes?, configOptions? }` —— 这就是「第四个建会话点」的依据。
- 实机：`opencode` 宣告并实现了它；`codebuddy` 的 initialize **没有** `sessionCapabilities` 字段（ACP 面无 handler），只能走禁用态。

### 2.7 插件现状（决定改动落点）

- `AgentBridge` 在 turn 路径上**只拿得到字符串 `dshSessionId`**（`GenerateOptions.sessionId`），拿不到 DSH 会话对象。
- `chatSessions` 的持久化记录里**已经有** `acpSessionId`（`persistAgents` → `agents.json`），不要再造第二个字段。
- 所有 `/acp` RPC 走 `src/impl.ts` 的 `dispatchRpc` 单 `switch`；加方法不碰通道注册。
- 客户端 store 已有一份 ACP 模式判定（`src/client/index.tsx` 的 `syncAcpMode`），本方案的作用域标记就从这里下发。

---

## 3. 设计

### D1 作用域标记（只影响 NTR 会话）

在 `src/client/index.tsx` 的 `syncAcpMode`（每次 store 变更都会跑、已有 claim/release 逻辑）里维护一个**幂等**的根标记：

```
document.documentElement.toggleAttribute('data-ntr-acp', active)
```

- `active` 复用该函数已算出的事实（舞台会话是否跑 ACP preset），不新增判定。
- 只有置了该属性的页面才应用 §D2 的 CSS；非 NTR 会话（切走 / 未启用）属性不存在，宿主三图标原样。
- 卸载时（effect cleanup）移除属性。

### D2 隐藏宿主三图标（CSS，纯展示层）

```css
/* 实施版：锚点是 [data-turn-tail]（见 §2.2 修正）。分支：宿主那枚隐藏，插件自己那枚（同一 aria-label）必须放行 */
html[data-ntr-acp] [data-turn-tail] button[aria-label="在新对话中分支"]:not([data-ntr-branch]),
html[data-ntr-acp] [data-turn-tail] button[aria-label="Branch into a new conversation"]:not([data-ntr-branch]),
html[data-ntr-acp] [data-turn-tail] button[aria-label="好的回答"],
html[data-ntr-acp] [data-turn-tail] button[aria-label="有问题的回答"],
html[data-ntr-acp] [data-turn-tail] button[aria-label="取消标记"],
html[data-ntr-acp] [data-turn-tail] button[aria-label="Good response"],
html[data-ntr-acp] [data-turn-tail] button[aria-label="Bad response"],
html[data-ntr-acp] [data-turn-tail] button[aria-label="Remove rating"] {
  display: none !important;
}
```

- **实施修正（审核实测）**：宿主 `Tooltip` 是 `cloneElement` 渲染、不加包装元素——藏掉 button 就是全部工作，行内不会留下空位；初稿的第二组 `:has(> button…)` 包装规则反而会命中动作行本身（分支按钮）与 list 槽共用的 `display:contents` 锚点（反馈按钮），把整行藏掉。**已删除，只保留 8 条 button 规则**。

- 选择器只落 `[data-turn-tail]` 行内、只按 `aria-label` 精确匹配，**不会误伤复制键**；`:not([data-ntr-branch])` 是给自己那枚留的通行证（两者 aria-label 相同，否则会被自己写的规则藏掉）。
- 已知脆点：宿主改文案或加第三语言 → 规则不命中、图标重新出现（功能不坏，只是没藏住）。缓解：`index.tsx` 在标记置位且页面出现 `[data-turn-tail]` 后用 `document.querySelector` 抽查一次，缺失时 `console.warn` 一条（dev 可见，不进用户 UI）。
- 样式载体沿用现有做法（`src/client/acp-ui.tsx` 里注入 `<style>` 字符串），不新建 CSS 文件。

### D3 自绘入口

注册进宿主的 `conversation.chat.assistant-actions`（`kind: 'list'`，`order: 20`，排在 feedback 的 10 之后 = 视觉上靠右，正好是宿主原分支按钮的位置）：

```
ctx.slots.inject('conversation.chat.assistant-actions', () => ctx.slots.register({
  name: 'conversation.chat.assistant-actions',
  id: 'ntr-branch',
  order: 20,
  inject: (sessionId) => ({ acp: store, sessionId, fork: forkFace }),
}, AcpBranchAction))
```

组件 `AcpBranchAction`（新文件 `src/client/branch-action.tsx`）：

- 图标：`import * as primitives` + 模块顶部 `branchIconOf(primitives)` 依 `…16 → …Regular → …Medium` 回退（EXTERNAL，与宿主同源；§2.4 的宿主世代差异）；tooltip 用同包的 `Tooltip`，`side: 'bottom'`。
- 按钮必须带 `data-ntr-branch`（D2 的 CSS 靠它把自己那枚与宿主那枚区分开），`aria-label` 与宿主同文案（无障碍语义不变）。
- 样式：class `.ntr-branch-action`，数值照 §2.3（28px 方框、`border-radius: 28px`、`var(--dsw-alias-label-tertiary)`、hover 用宿主 alias、`data-unavailable` 置灰），**颜色只走 token**（约束 34）。
- 非 NTR 会话返回 `null`（同时 CSS 也不生效，双保险）。
- 顺序复原：`复制 → 反馈（已被隐藏）→ 本按钮 → usage/时间`，与宿主原布局一致。

**只在「最后一条已完成轮次」可用**（与宿主同规则）：`conversation.chat.assistant-actions` 对每个 turn 的尾部都会渲染，但 `sessions.fork` 不带 `atSeq` 时宿主取的是**最新**已完成前缀——在历史轮次上点它，会分叉出比眼前这条更晚的历史。判定用宿主自己已经写进 DOM 的事实：`closest('[data-turn-tail]')` 的 `data-actions-reveal === 'always'` 才允许（`TurnTailNodeView` 用 `isLatestTurn` 决定该值；**实施修正**：初稿写的 `endsWithResponse` 有误），**并且**宿主分支按钮自身的 `data-unavailable` 不在场（宿主还有一道更严的闸——`closing === null || 最新节点不是该轮尾节点 || 轮内有更晚节点`；读宿主按钮的这个属性，保证插件的可点集合是宿主的子集，剩下的点击切点与宿主一致——标记 `always` 的尾部就是最新已完成轮次，正是宿主回退切点落的地方）。标记缺失或宿主置灰时**按不可用处理**（fail-closed：宁可少给一次分叉，也不给一次切错点的分叉），tooltip 复用宿主的「仅可从已完成轮次的最后一条消息分支」。

### D4 状态机（插件掌握，六态）

| 状态 | 条件 | 表现 | tooltip（zh / en） |
|---|---|---|---|
| `ready` | agent 宣告 `sessionCapabilities.fork` + 会话 live + 无进行中 turn + 宿主有 `sessions.fork` | 可点 | 在新对话中分支 / Branch into a new conversation |
| `unsupported` | agent 的能力位缺失或明确为 false | 置灰、`aria-disabled`、点击无反应 | 该 agent 不支持原生分叉 / This agent cannot fork natively |
| `released` | 该会话的 ACP 会话已挂起（`chatSessions` 行为 released） | 置灰 | 会话已挂起，先发一条消息恢复再分叉 / Resume this session before branching |
| `busy` | 该会话有进行中的 turn | 置灰 | 当前轮次结束后才能分叉 / Wait for the current turn to finish |
| `notTail` | 当前消息不是最后一轮已完成轮次的尾部（§D3 的 tail 判定不成立） | 置灰 | 仅可从已完成轮次的最后一条消息分支 / Available only on the last message of a completed turn |
| `hostUnavailable` | 浏览器侧 `sessions.fork` 探测不到 | 置灰 | 当前宿主不提供分叉 / This host does not support branching |

事实来源（不新增第二真相）：

- 能力位：宿主 `initialize` 的 `agentCapabilities.sessionCapabilities.fork`，**落「最后已知」**到 `model-catalog.json`（`agent/catalog` 同族）。不能读 `view().agentCapabilities`——`releaseAll` 会清掉它，UI 会无缘无故闪成禁用。
- live / released：客户端 store 已有的 `chatSessions` 行（`session/chat-list` 与 `session/released` 帧维护）。
- 进行中 turn：store 已有的 running 标记。
- 通过 `session/chat-list` 每行追加 `fork: { supported: boolean, reason?: 'unsupported' | 'released' | 'busy' }` 下发，客户端不自己拼判定（**实施修正**：`hostUnavailable` 是客户端对 `sessions.fork` 结构探测的判定，不属于行字段；行数据缺 `fork` 字段（旧宿主半区）按 unsupported 处理）。

### D5 点击链路（先宿主分叉，再 ACP adopt）

1. 客户端 `AcpStore.forkChatSession(dshSessionId)`：
   - `sessions.fork({ sessionId, increaseTitle: true })` → `childId`（宿主负责复制前缀、标题 `(1)`、挂工作区）。
2. 紧接着调插件 RPC **`session/chat-fork-adopt`** `{ dshSessionId: childId, parentDshSessionId }`。
3. 服务端 `BridgeManager.adoptForkedSession(childId, parentId)`：
   - 解析父会话的 `LiveSession`（必须**同一 bridge 且 live**；父 released → `parent_not_live`，客户端在点击前就用 D4 挡掉）。
   - `conn.agent.request(methods.agent.session.fork, { sessionId: parent.acpSessionId, cwd, mcpServers: toAcpMcpServers(def.mcpServers) })`（**实施修正**：不带 `additionalDirectories`——与 `session/new` / `session/load` 同形状，fs 围栏由客户端自己的 fs handler 按会话 cwd 执行），包在 `withStartupTimeout` 里，并把这次调用计入 `pendingForks`（进 `hasActiveWork`，防空闲回收杀进程）。
   - 校验返回 id：非空、≠ 父、不撞 `acpIndex` / `sessions`。撞了就拒绝（否则父会话的 `session/update`、审批询问会被路由到子会话）。
   - 用响应里的 `modes` / `configOptions` 建 `LiveSession`（`usableConfigOptions` 过滤），注册 `acpIndex` / `dshSessionMap` / `sessions`，`touch` + `clearIdleTimer`。
   - 写持久化：`chatSessions` 记录（含 `acpSessionId`）+ `patchChatChoice(childId, { agentId, locked: true, modelId, effort, mode })`；不要手抄字段（约束 27）。
   - 广播：`session/meta`；若 `configOptions` 引入新值，照 `catalog/updated` 的既有路径更新目录。
4. 客户端拿到成功 → `ctx.uiWorkspace.openSession(childId)`。
5. 子会话首条消息：`getOrCreateDshSession` 命中已绑定的 `LiveSession`，直接 `session/prompt` 走 fork 出来的 ACP 会话 —— **不会**再 `session/new`，agent 记得上文。

### D6 失败与回滚

| 失败点 | 后果 | 处理 |
|---|---|---|
| `sessions.fork` 失败/缺失 | 没有子会话 | 横幅（约束 38），无副作用 |
| ACP fork 返回错误 / 超时 | 子会话已存在但未绑定 | 横幅写清原因；**不写 locked**；子会话首条消息走原有 `session/new`（等价于今天的行为），并在 NTR 视图顶部给一条常驻说明「本会话的历史是复制的，agent 没有上文」 |
| 返回 id 与父相同 / 撞索引 | 可能串会话 | 拒绝并横幅；不注册任何索引 |
| 子会话创建后未发消息就被关闭 | agent 侧多一条空会话 | `closeSession` 时若该会话从未 prompt 且 agent 宣告 `session/close`，补发 `close`；否则如实记日志（不假装清理） |

### D7 为什么是这个顺序

ACP fork 没有切点参数（只能末端），而 DSH 的切点语义（含中间轮次）由宿主 `sessions.fork` 负责。反过来先 ACP fork 再宿主 fork，会在第二步失败时留下无法归属的 ACP 会话（要靠 `session/close` 收尸）。所以固定：**宿主先建树，插件再接管 ACP 侧**。

---

## 4. 变更清单（文件 + 符号）

| 文件 | 符号 | 改动 |
|---|---|---|
| `src/client/index.tsx` | `syncAcpMode` | 维护 `html[data-ntr-acp]` 标记（幂等 + cleanup）；注册 `conversation.chat.assistant-actions` 新条目 |
| `src/client/branch-action.tsx` | 新文件 · `AcpBranchAction` | 按钮、六态、tooltip、点击链路 |
| `src/client/acp-ui.tsx` | 样式字符串 | 追加 `.ntr-branch-action` 与 D2 隐藏规则 |
| `src/client/store.ts` | `forkChatSession` / `forkStateOf` | 调 `sessions.fork` + `session/chat-fork-adopt` + `openSession`；读 `session/chat-list` 的 `fork` 字段 |
| `src/protocol.ts` | `ChatForkAdoptPayload`、`AcpChatSessionRow.fork` | 新 RPC 载荷；目录行能力位 |
| `src/impl.ts` | `dispatchRpc` / `AcpManager` | 加 `session/chat-fork-adopt` case（`str` 校验两条 id）与可选方法签名 |
| `src/bridge.ts` | `BridgeManager.adoptForkedSession`、`AgentBridge.forkSession`、`persistAgents`/`loadPersistedChoices` | ACP fork（§D5.3）、第四建会话点的全部纪律、`pendingForks` 计数、最后已知能力落盘 |
| `package.json` | `dsh.client.inject` | 加 `@deepseek-ai/dsh-client-ui-primitives` |
| `tsdown.config.mjs` | `EXTERNAL` | 同上，保持图标与宿主同源 |

**明确不改**：宿主 `MessageIconActions` / `TurnTailNodeView` 的任何东西；`conversation.chat.node` 的 keyed 覆盖；`AcpConversationChoice` 的 `acpSessionId`（已由 `chatSessions` 承担）。

---

## 5. 测试

- `tests/bridge.spec.ts`
  1. adopt 成功：断言发出 `session/fork` 且 **`mcpServers` 与 `session/new` 同一份**、返回 id 被注册、`chatSessions` + `chatChoice.locked` 写入、`session/meta` 广播。
  2. 父会话 released → `parent_not_live`，**零请求**。
  3. agent 宣告不支持 → `unsupported`，**零请求**（不能先打再说）。
  4. 返回 id 等于父 id / 已存在 → `id_conflict`，不注册。
  5. fork 请求超时 → `withStartupTimeout` 生效、`pendingForks` 归零。
- `tests/impl.spec.ts`：`dispatchRpc` 新 case 的路由与 `bad_payload` 归一。
- `tests/store.spec.ts`：六态映射（ready / unsupported / released / busy / notTail / host 缺失）。
- `tests/acp-view.spec.ts`「NTR message-actions stylesheet」：断言 D2 的 8 条按钮选择器都在样式里、**没有** `:has(> button…)` 规则、`.ntr-branch-action` 全套样式存在（宿主改文案时这条会先失败，提醒同步）。
- 手工验收：见 §8。

---

## 6. 文档同步（同一提交内完成）

- `AGENTS.md`：新增一条硬约束（接在 38 之后）——「NTR 会话的消息动作归插件：宿主三图标只经 `html[data-ntr-acp]` + `aria-label` 选择器隐藏，**严禁**覆盖宿主 node 渲染；自绘入口只管状态；分叉固定「宿主 fork → ACP adopt」两段，失败进横幅」。
- `AGENTS/protocol.md` §1：`session/fork` 是**第四个建会话点**（同一份 `mcpServers`、`withStartupTimeout`、`pendingForks`、`modes`/`configOptions` 反哺、id 去重校验）。
- `AGENTS/state.md` §3：能力位落「最后已知」（`model-catalog.json`），`chatSessions.acpSessionId` 是唯一地址真相。
- `AGENTS/ui.md`：新增「消息动作接管」小节（作用域标记、aria 选择器的脆点、样式数值来源）。
- `CHANGELOG.md`：面向用户写净变化（NTR 会话里反馈/分支图标由插件接管；分支现在会带上下文）。
- `docs/todo.md`：落地前保留条目指向本文；落地后删除条目。

---

## 7. 风险与未决

1. **`sessions.fork` 能否从插件浏览器半区调用**：**已按代码确认**——客户端会话服务（`dsh-api-session-controller/lib/client.js`）定义了 `async fork(opts)`，`dsh-client-ui-workspace` 也导出 `openSession(sessionId)`；宿主 chat 自己的 `forkAt` 就是这两个调用。插件的 `StructuralServices` 只是**没有声明**它们，仍要按结构探测 + `try/catch` 使用（缺了走 `hostUnavailable`，按钮可见但置灰）。
2. **`aria-label` 是本地化字符串**：宿主加语言或改文案即失效（图标重新出现）。已用「启动抽查 + 测试断言 CSS 字符串」兜底；根治要宿主给 `data-*` 钩子。
3. **能力位可能过期**：agent 升级后能力变化，只有下次 `initialize` 才更新。UI 文案用「最后已知」口径，不承诺实时。
4. **父会话必须与子会话同进程**：父 released 时禁用（D4 `released`），不做「自动唤醒再 fork」——那会广播 `session/reset`，可见副作用太大。
5. **反馈数据仍可被别处写入**：本方案只是不显示入口；已有点赞记录仍在宿主的 feedback 存储里，不做清理（属于宿主数据）。
6. **双入口风险已消除**：NTR 会话里宿主的三个按钮都被隐藏，插件按钮是唯一入口；若 CSS 失效，宿主按钮会复活——这是可接受的降级（用户仍能分叉，只是得到今天的行为）。
7. **tail 判定依赖宿主 DOM 标记**（`[data-turn-tail]` + `data-actions-reveal="always"`）。宿主改这两个属性 → 我们的按钮一律不可用（fail-closed），不会切错分叉点，但会变成「永远灰」。缓解：手工验收 §8.3 覆盖；若宿主变更，改为向宿主提一个 `messageId → 是否尾部` 的查询接口。

---

## 8. 验收标准

1. 打开一条 NTR 会话：助手消息尾部只剩复制、时间、usage 与插件分支按钮；点赞/点踩/宿主分支**不可见**；复制仍可用；hover 揭示节奏与改造前一致；历史轮次上的插件按钮为灰（`notTail`），只有最后一条已完成轮次可点。
2. 打开一条普通 DSH 会话：三个宿主图标**原样存在**，插件按钮不出现。
3. 支持 fork 的 agent（如 opencode）：点插件按钮 → 出现新会话（标题 `(1)`）→ 在子会话问「我刚才说了什么」，agent 能答出父会话内容；宿主会话列表里父会话未受影响。
4. 不支持的 agent（如 codebuddy）：按钮置灰，tooltip 为「该 agent 不支持原生分叉」，点击无反应；子会话不会因误点而被创建。
5. 会话已挂起时按钮置灰，tooltip 为「会话已挂起，先发一条消息恢复再分叉」。
6. 注入失败（伪造 fork 返回错误）：子会话不写 `locked`、首条消息照常走 `session/new`、横幅出现一次且文案可操作。
7. `npm run prepack` 全绿（typecheck + vitest + build）。

---

## 9. 接手须知

**阅读顺序**：本文 → `AGENTS.md` 硬约束（1–6 构建入口、27/28 状态、32 建会话点、38 横幅）→ `AGENTS/ui.md` §1/§2（座位与闸门）→ `src/client/index.tsx` 的 `syncAcpMode` → `src/bridge.ts` 的 `getOrCreateDshSession` / `createSession` → `tests/bridge.spec.ts` 的隔离 manager 用例。

**命令**：`npm run prepack`（提交前全量）；`npx vitest run tests/bridge.spec.ts -t "spawns, initializes"`；只重建浏览器包 `npx tsdown`。

**禁止**：

- 改宿主 DOM 结构或覆盖 `conversation.chat.node`（会连带失去 `turnTail` / `assistant-actions` 两个子槽的绑定）。
- 在 `AcpConversationChoice` 里再存一份 ACP 会话 id（`chatSessions` 已有）。
- 绕过 `patchChatChoice` 写选择字段。
- 把「不支持原生分叉」实现成「客户端拼背景」——那不是分叉。
- 只在 `view()` 上读能力位（`releaseAll` 会清空，界面会无故闪烁）。
