# 隐式状态机重构方案（分阶段执行手册）

> 用途：本文件是唯一执行依据。新会话或上下文压缩后的会话，先读 §0。
> 当前状态：未开始。每完成一个阶段，勾选 §9 并填写提交号。

## §0 接手协议

1. 读完本文件。不要只读当前阶段。
2. 运行 `git log --oneline -30`，查找前缀 `refactor(state):` 的提交，确定已完成阶段。
3. 运行 §1 的基线命令，确认 HEAD 干净、测试通过。
4. 从 §9 第一个未勾选项继续。不要跳过阶段，后续阶段依赖前序的派生函数。
5. 每个阶段单独提交。提交信息格式：`refactor(state): stage N <主题>`。阶段 4 的 dispose 修正额外单独提交 `fix(save-gate): ...`。
6. 阶段完成后更新 §9 的复选框与提交号，再进入下一阶段。
7. 阶段标题括号里的 S1-S5、O13 是首次扫描报告的条目编号，只用于追溯，不影响执行。

## §1 全局约束

**行为不变。** 除阶段 4 的 dispose 修正外，其余阶段只改内部表示。以下对外契约零改动：

- 协议类型名与字段名：`src/protocol.ts` 的 `SessionView`、`SaveGateStatus`、`SaveGateOutcomeView`。
- RPC 方法名：`session/chat-list`、`agent/save`、`save/flush`、`save/cancel`、`save/retry`。
- 持久化键名：`src/bridge/persistence-service.ts` 的 `PersistedChatSession`。
- store 公开方法签名：`loadChatSessions`、`noteAcpMode`、`hasAcpModeVerdict`、`invalidateAcpMode`。

**行数门禁。** `npm run check:size` 硬卡。基线共 18 个文件，完整清单见 `scripts/file-size-baseline.json`。任何阶段不得净增下列文件的行数：

| 文件 | 基线行数 |
|---|---|
| src/bridge/agent-bridge.ts | 2210 |
| src/bridge/manager.ts | 1946 |
| src/bridge/turn-stream.ts | 2659 |
| src/client/acp-ui.tsx | 1325 |
| src/client/index.tsx | 1115 |
| src/client/panel.tsx | 3414 |
| src/client/session-controls.tsx | 1136 |
| src/client/store.ts | 4387 |
| src/impl.ts | 4182 |
| src/protocol.ts | 1645 |
| tests/acp-view.spec.ts | 1645 |
| tests/bridge.spec.ts | 1186 |
| tests/impl.spec.ts | 3445 |
| tests/mock-agent.mjs | 1771 |
| tests/model-seat.spec.ts | 1314 |
| tests/panel.spec.ts | 1173 |
| tests/store.spec.ts | 4201 |
| tests/update.spec.ts | 1274 |

`src/client/subagent-panel.tsx` 当前 468 行，未入基线，只受 1000 行新文件上限约束。

对策：新类型与纯函数放新文件（新文件上限 1000 行）。旧文件只加委托、删旧字段，保持净零。

**代码风格。** 不写 `enum`。使用字符串字面量联合，与 `turn-stream.ts:536` 的 `phase: 'worker' | 'drain'` 一致。该约束没有 lint 门禁，靠评审执行。

**测试纪律。** 每阶段至少新增 1 条测试，锁定旧实现无法表达的不变量。禁止为了让测试通过而修改既有期望值。若确认旧行为是 bug，单独提交并在信息中写 `fix:`。`npm run typecheck` 只覆盖 `src`，新增测试的类型错误不会被它拦截。测试引用优先写用例名，行号只作提示。

**唯一行为例外。** 阶段 4 的 dispose 修正会改变 `SaveGateStatus.gateAvailable` 与在途条目的结局。它必须单独提交为 `fix(save-gate): ...`，并同时更新读点 `src/client/panel.tsx:1937/1957/2136` 与 `tests/save-guard-toast.spec.ts`。其余阶段不改可观察行为。

**基线命令。**

```
npm run typecheck
npx vitest run tests/store.spec.ts
npm run check:size
npm test
```

`npm test` 使用单 fork 顺序执行，耗时较长。它是每个阶段收尾的必跑项。最终阶段额外跑 `npm run prepack`（含 build）。

## §2 阶段 1：ACP 模式裁决（S3）

**目标。** 把 3 个裁决容器合并为一个 `Map<sessionId, AcpVerdict>`。把 `acpModeAsked` 下沉为 store 内独立的提问节流表。`readChatSessionList` 的查询改为只读；`hasAcpModeVerdict` 保持破坏性。

**现状锚点。**

- `src/client/store.ts:611` `acpMode: Record<string, boolean>`，初值在 `:1059`。
- `src/client/store.ts:1136` `acpModeLive: Set`，帧裁决锁定集。
- `src/client/store.ts:1160` `acpModeUnsettled: Set`，宿主答空标记。
- `src/client/index.tsx:499` `acpModeAsked: Map<string, number>`，提问节流。
- `src/client/store.ts:2102` 读 live 判定本次读是否可结算；`:2182-2185` 写入；`:2193-2195`、`:2201-2203` 写 unsettled；`:2452-2455` 帧锁定；`:2496-2503` 破坏性查询；`:2511-2523` 失效。
- `src/bridge/chat-choice-service.ts:75-77` 缓存与在途；`:110-125`、`:144-163`、`:172-175` 读写。

**目标模型。** 新文件 `src/client/acp-verdict.ts`：

```ts
export type AcpVerdict =
  | { kind: 'unsettled' }
  | { kind: 'host'; value: boolean }
  | { kind: 'frame'; value: boolean }
```

无条目即未知。纯函数：`settleFromHost`、`commitFrame`、`markUnsettled`、`consumeVerdict`、`peekVerdict`、`invalidateVerdict`、`projectAcpMode`。

**步骤。**

1. 新建 `src/client/acp-verdict.ts` 与 `tests/acp-verdict.spec.ts`。纯函数无 store 依赖。
2. store 内加 `private readonly acpVerdicts = new Map<string, AcpVerdict>()`。在旧的裁决写点同步写新 Map，旧字段仍是读取源。加测试断言两套表示一致。
3. 迁移读方：`hasAcpModeVerdict` 改为 `consumeVerdict`；`readChatSessionList` 的 settle 判定改读 Map；`invalidate` 改读 Map。保留旧字段写入。
4. 把 `index.tsx:499` 的 `acpModeAsked` 下沉为 store 内独立的提问节流表，暴露 `claimAcpAsk(sid, ttlMs)` 与 `releaseAcpAsk(sid)`。卸载清理接 `index.tsx:953-960`。
5. `state.acpMode` 改为由 Map 派生的投影。`UiState.acpMode` 形状不变，所有 UI 读取方零改动。
6. 删除两个 Set、index 的 Map 与全部双写。

**必须保留的语义。**

- `hasAcpModeVerdict` 是破坏性查询：读到 `unsettled` 就消费它并返回 false。
- `consumeVerdict` 只允许在 `hasAcpModeVerdict` 内调用。`readChatSessionList` 的 settle 判定必须使用非破坏性的 `peekVerdict`，否则两处会互相吃掉 `unsettled`。
- 全局 `invalidate` 只清 live 与值，不清 unsettled 与 asked。这个不对称要复刻。
- `noteAcpMode` 先提升权威、再比较值。同值帧也要锁定。
- `settle` 在 `await` 前计算。不要改成 `await` 后重算。
- 帧到达时必须 `abandonChatSessionRead`，否则迟到宿主答案会回退裁决。
- 提问节流表独立于裁决表。持有 `host`/`frame` 裁决时仍保留 `askedAt`，用于按 TTL 重问。不要把 `asked` 并入裁决联合。

**验证。**

```
npm run typecheck
npx vitest run tests/acp-verdict.spec.ts tests/store.spec.ts tests/acp-view.spec.ts
```

**验收。** `store.spec.ts:734/752/883/916/943/985` 与 `acp-view.spec.ts` 的 `reads the staged session and its preset the same way the surfaces do` 全部通过且未改期望值。新增用例覆盖 unsettled 消费与全局失效不对称。

## §3 阶段 2：面板保存暂存（S4）

**目标。** 把暂存相关的 2 个布尔、1 个签名与 1 个时间戳收敛成一个 `SaveStage`。`saveGateAvailable` 与 `saveConfirm` 保留。

**现状锚点。** `src/client/panel.tsx`：`deferRequested:1721`、`heldSignature:1727`、`sawPending:1729`、`deferOutcomeAt:1731`、`saveGateAvailable:1738`、`saveConfirm:1739`、派生 `saveDeferred:1803`。写入点 `1831-1837`、`1862-1866`、`1887-1891`、`1908-1910`。终局效应 `1814-1872`。

**目标模型。**

```ts
type SaveStage =
  | { kind: 'idle' }
  | { kind: 'confirming'; payload: AgentSavePayload }
  | { kind: 'saving'; payload: AgentSavePayload }
  | { kind: 'held'; signature: string; sawQueue: boolean; outcomeBaseline?: number }
```

`AgentSavePayload` 是 `src/protocol.ts:1204` 的既有类型，不要另造 `SavePayload`。`held.outcomeBaseline` 承接旧的 `deferOutcomeAt`。它记录入队时看到的终局时间戳，不是持有时长。`held.sawQueue` 承接 `sawPending`。两者都不可省略，否则旧终局会被误判为新终局。

`saveGateAvailable` 与 `saveConfirm` 保留独立状态。它们描述弹窗与能力，不属于暂存阶段。

**步骤。**

1. 新增 `saveStage` 与上述类型。原 setter 处双写。`saveDeferred` 改由 `stage.kind === 'held'` 派生。
2. 渲染读点 `2133-2136`、`2593`、`2625` 改读 `saveStage`。旧字段仍写。
3. 终局与编辑取消效应 `1814-1872` 改为按 stage 分派。删除 `sawPending`、`deferOutcomeAt` 读取。
4. `performSave`、`handleSave` 只写新阶段。删除 4 个 `useState`。

**必须保留的语义。**

- `1804` 的签名来自 `buildPayload` 字面量顺序。不要调整字段顺序。
- 队列帧处理必须先于终局判断。旧代码顺序是 1815 先于 1823。
- 终局判断规则：非 pending、非 superseded、且（见过队列 或 `at` 与基线不同）。
- 确认弹窗必须先关再等待结果。否则弹窗闪烁，取消会误回 idle。
- 旧 `saveDeferred` 等于 `deferRequested || savePending`，只表示暂存。`confirming` 与 `saving` 不是暂存，不得计入。
- 卸载后不 setState 的现状依赖 React 空操作。改造不得引入定时器。

**验证。**

```
npm run typecheck
npx vitest run tests/panel.spec.ts tests/save-guard-toast.spec.ts
```

**验收。** `panel.spec.ts:76/96/158/175/210/301/322/346/439` 全部通过。新增用例覆盖“终局与队列帧同 tick”和“编辑取消在途补发”。

## §4 阶段 3：HMR 延迟重载（S5）

**目标。** 用单一 `phase` 表示延迟重载事务。

**现状锚点。** `src/hmr-guard.ts:144-151` 八个字段。核心链：`wrapped:253-278`、`ensureIdleListener:196-208`、`scheduleRetry:215-251`、`settle:176-184`、`giveUp:187-193`、disposer `314-330`。

**目标模型。**

```ts
type Phase = 'idle' | 'deferred' | 'retrying' | 'givenUp' | 'closed'
```

`attempts`、`offline`、`lastArgs` 保留为阶段附属数据。删除 `pending` 与 `notified`，改为派生判断。

**步骤。**

1. 加 `let phase: Phase = 'idle'`。首次 defer 置 `deferred`；idle 回调置 `retrying` 并在原位置复位 `attempts=0`（不要把这个复位移进 `scheduleRetry`，否则失败退避会无限重来）；`giveUp` 置 `givenUp`；`settle` 置 `idle`；disposer 置 `closed`。
2. 两个定时器收进 `clearTimers()`。`arm` 条件改读 `phase`。断言：`phase` 为 `idle` 或 `closed` 时，不得持有 `retryTimer` 或 `deadlineTimer`。
3. 删除 `pending`、`notified`，改由 `phase` 判断。`notified` 的复位点就是 `deferred -> retrying` 的迁移。
4. 补测试：截止时间不随第二次 defer 重挂；giveUp 后 idle 监听仍在；dispose 清 `lastArgs`。

**必须保留的语义。**

- 延迟期间新调用覆盖 `lastArgs`，重试时读取最新参数。
- 截止时间只绑定首轮 defer。giveUp 后阶段保持 `givenUp`，待办仍未完成，第二轮等待没有新截止。
- `giveUp` 只报一次。`notified` 的职责并入 `phase`。
- `scheduleRetry` 的入口条件必须允许 `givenUp` 继续重试。只有 `idle` 与 `closed` 才提前返回。

**验证。**

```
npm run typecheck
npx vitest run tests/hmr-guard.spec.ts
npm run check:size
```

**验收。** `hmr-guard.spec.ts` 全部 16 例通过。新增 3 例覆盖上述边界。

## §5 阶段 4：SaveGate 执行阶段（O13）

**目标。** 把 5 个执行布尔收敛为阶段与排程集合。保留 `queue` 与两个 Promise 句柄。

**现状锚点。** `src/save-gate.ts`：`queue:101`、`flushing:109`、`forceTail:111`、`flushScheduled:112`、`resyncScheduled:114`、`disposed:115`。无回合的立即执行分支在 `187-192`；入队与超时在 `194-211`；其余写点 `444-445`、`310-316`、`425-429`、`285-288`、`321`。

**目标模型。**

```ts
type GatePhase = 'idle' | 'flushing' | 'disposed'
type Schedule = 'flush' | 'resync'
// scheduled: Set<Schedule>。两个排程相互独立，可同时存在。
```

`flushing` 与 `forceTail` 保留为 Promise 句柄，改名为 `activeFlush` 与 `followUp`。它们不是布尔，不要塞进 phase。

**步骤。**

1. 加 `phase` 与 `scheduled`，在旧写点同步写。`status()` 不输出新字段。
2. `flushScheduled`、`resyncScheduled` 改读 `scheduled.has('flush')` 与 `scheduled.has('resync')`。两者可同时为真，不得改成单值联合。保持宏任务排程不变。
3. `flushing`、`forceTail` 改名并迁移全部读点。
4. 删除 `disposed` 布尔，8 个读点改判 `phase === 'disposed'`。
5. 附带行为修正，单独提交：`status()` 在 dispose 后返回 `gateAvailable: false`；已出队条目在 dispose 后不再回报 saved。各补 1 条测试。

**必须保留的语义。**

- 排程必须是宏任务。改微任务会让 `turn/end` 时控制器未退役。
- `flushScheduled` 与 `resyncScheduled` 由不同路径独立设置，可同时为真。单值排程会丢一次刷新或一次复检。
- `notify` 对 status 全量序列化。内部阶段字段不得进入 `SaveGateStatus`。
- dispose 只结算队列，不二次结算已出队条目。行为修正要显式定义在途条目结局。

**验证。**

```
npm run typecheck
npx vitest run tests/save-gate.spec.ts tests/store.spec.ts
npm run check:size
```

**验收。** `save-gate.spec.ts:68/166/178/205/238/256/302` 全部通过。新增用例覆盖 dispose 与在途写入。

## §6 阶段 5：桥侧会话生命周期（S1）

**目标。** 把生命周期布尔收敛为 `lifecycle` 枚举与 `turnSlot` 值对象。保留三者正交语义。

**现状锚点。**

- 字段：`src/bridge/live-session.ts:41/57/58/60/113-119/174`。
- 边界：`agent-bridge.ts:1512-1537` park，`:1638-1648` close，`:1728-1737` forceReset，`:1418-1429` resume，`:479-491` beginTurn，`:505-511` openSettleGate。
- 回合：`manager.ts:1716/1750`，`bridge-rpc-service.ts:108/152/181`，`turn-stream.ts:1780/1870-1871/1923`。
- 读取：`agent-bridge.ts:465/438-460/563/609/643`，`shape.ts:185-188`，`session-registry-service.ts:223-224`。

**目标模型。** 新文件 `src/bridge/session-lifecycle.ts`：

```ts
type SessionLifecycle = 'live' | 'parked' | 'closed'
interface TurnSlot { promise: Promise<void>; resolve: () => void; turnSeq: number }
```

`lifecycle` 是显式字段，逐步成为唯一真相。双写期由 `released` Map 成员资格与 `closed` 布尔校验它。第 5 步后 `closed` 删除，`parkSessions` 改判 `lifecycle === 'closed'`。`running` 不进入 lifecycle，保留为存储字段，本阶段不派生化。`turnSlot` 携带 `turnSeq`，用于闸门世代校验。

**步骤。**

1. 新建 `session-lifecycle.ts`。导出 `lifecycleOf`、`hasPromptSlot`、`isSettling`、`assertLifecycle`。只在边界调用，不改行为。
2. 加 `lifecycle` 字段，在 5 个边界双写。双写期用 Map 成员资格与 `closed` 校验它，不一致时断言失败。
3. 迁移读方到派生函数：`claimTurn`（`agent-bridge.ts:438-460`）、`hasActiveWork`（`:563`）、`hasOtherActiveWork`（`:609`）、`hasActiveTurn`（`:643`）、`shape.ts:185-188`、`turn-watchdog-service.ts:125/228`、`archive-release-service.ts:50-52/74-76`、`client/store.ts:424/2700`。协议字段继续输出旧名。
4. 引入 `turnSlot`，与 `promptInFlight`、`settled`、`settledResolve` 双写。`beginTurn` 与 `openSettleGate` 改为按 `turnSeq` 比对后再清。补测试：旧回合不得清掉新回合的闸门。
5. 删除 `promptInFlight`、`settled`、`settledResolve` 与 `closed` 布尔。`lifecycle` 成为唯一真相，`SessionView.closed/released` 由它派生；`running` 保留为存储字段，本阶段不派生化。

**必须保留的语义。**

- `running`、`promptInFlight`、`settled` 正交。注释 `live-session.ts:42-56` 是规范。
- `running` 当前不是派生量。显式写点至少 9 处：`bridge-rpc-service.ts:108/152/181`、`manager.ts:1737`、`turn-stream.ts:1813/1903`、`agent-bridge.ts:1361/1424/1529`。本阶段保留存储字段。后续若要派生化，先列出全部写点与派生映射，并补等价测试。
- `parkSessions` 必须跳过 `lifecycle === 'closed'`，否则 resume 会复活已销毁会话。
- `turnSeq` 只增不减。resume 不清它。
- `released` 布尔与 Map 双写共 8 处。改造后 `lifecycle` 是唯一真相，`released` Map 只负责保存已停放记录。
- `closeSession` 只清 `promptInFlight`，不清 `settled`。不要假设闸门已开。
- `snapshot` 不输出 `promptInFlight` 与 `turnController`。新增字段不要误加。

**验证。**

```
npm run typecheck
npx vitest run tests/bridge/turn-stream.spec.ts tests/bridge/reliability.spec.ts tests/bridge/idle-release.spec.ts tests/bridge.spec.ts
npm run check:size
```

**验收。** 上述文件与 `tests/bridge.spec.ts` 的相关用例全部通过。新增用例覆盖 close 与 resume 并发、旧回合闸门。

## §7 阶段 6：背景 drain 身份（S2）

**目标。** 每个 requestId 一条 `DrainRecord`，替代 4 个集合的交叉判定。

**现状锚点。**

- `src/bridge/live-session.ts:187/192/211/318`。
- `src/bridge/turn-stream.ts:158-177` retire，`:258-265` revive，`:277-295` clear，`:650` folded。
- 消费：`src/bridge/subagent-service.ts:118/511`。
- 宣告：`src/bridge/agent-bridge.ts:2077-2125`。

**目标模型。**

```ts
interface DrainRecord {
  requestId: string
  active: boolean
  startedAt: number
  lastActivityAt: number
  sawOutput: boolean
  noticeSent: boolean
  retiredAt?: number
  consumed: boolean
}
```

存于 `Map<string, DrainRecord>`。另保留三个有序 id 数组复刻容量：retired 32、consumed 64、notice 64。

**步骤。**

1. 加 Map 与 `DrainRecord`。旧写点双写。断言：`active` 的记录至多一条。
2. 只读切换：`isRetiredAmbientId`、`hasRecentRetiredAmbient`、`subagent-service` 两处 consumed 检查、ambient 读取改走 Map。
3. 写切换：宣告、复活、五路退休、边界清空全部写 Map。
4. 删除 4 个旧结构。用三个有序数组保持淘汰顺序与上限完全一致。Map 条目仅在 `active === false` 且三个数组都不含该 id 时删除。
5. 加护栏测试：snapshot 与持久化都不含 drain 字段。

**必须保留的语义。**

- 复活不检查 consumed。复活后仍被 consumed 静音，这是有意的第四态。
- 五路退休的 consume 判定各不相同：quiet 按 folded、hard 与 ceiling 不 consume、hold 按 `answerChars>0`、idle 完整交付 consume、切段不 consume。
- 重退休必须刷新 `retiredAt` 并移到数组末尾。`hasRecentRetiredAmbient` 依赖这个时间窗。顺序错会重复回答同一次 drain。
- replay 帧不得复活。`agent-bridge.ts:2067/2077/2087/2116` 与 `subagent-service.ts:107` 的门必须保留。
- `clearAmbientState` 清不到控制器字段。改造时不要让 session 级 Map 与控制器级 `foldedDrainIds` 混为一体。

**验证。**

```
npm run typecheck
npx vitest run tests/bridge/background-drain.spec.ts tests/bridge/worker-settles.spec.ts tests/bridge/detached-worker.spec.ts tests/bridge/idle-release.spec.ts tests/quota-refusal.spec.ts
npm run check:size
```

**验收。** 上述文件全部通过。新增用例覆盖容量溢出、复活静音、控制器字段不串。

## §8 字段映射总表

| 旧表示 | 新表示 | 阶段 |
|---|---|---|
| acpMode + acpModeLive + acpModeUnsettled | `Map<sid, AcpVerdict>` + 派生 Record | 1 |
| acpModeAsked | store 内独立提问节流 Map | 1 |
| deferRequested + heldSignature + sawPending + deferOutcomeAt | `SaveStage` | 2 |
| pending + notified + 2 timers + lastArgs | `Phase` + `attempts/offline/lastArgs` | 3 |
| flushing + forceTail + flushScheduled + resyncScheduled + disposed | `GatePhase` + `Set<Schedule>` + 2 Promise | 4 |
| promptInFlight + settled + closed + released | `lifecycle` + `turnSlot` + Map 成员资格（`running` 不入 lifecycle，保留为存储字段） | 5 |
| ambient + ambientNotices + retiredAmbients + consumedDrains | `Map<requestId, DrainRecord>` + 3 个有序数组 | 6 |

## §9 进度表

- [x] 阶段 1 ACP 模式裁决　提交：e1638db
- [x] 阶段 2 面板保存暂存　提交：d5978b7
- [x] 阶段 3 HMR 延迟重载　提交：32d91ae
- [ ] 阶段 4 SaveGate 执行阶段　提交：______（重构）、______（fix）
- [ ] 阶段 5 桥侧会话生命周期　提交：______
- [ ] 阶段 6 背景 drain 身份　提交：______
- [ ] 收尾：`npm run prepack` 通过，更新本文件状态为「已完成」

## §10 回滚与止损

1. 每阶段至少一个提交，`git revert <sha>` 即可回滚。阶段 4 的重构与 `fix(save-gate)` 必须分成两个提交。禁止跨阶段合并提交。
2. 双写阶段出现回归，先 revert，再定位。不要靠修改旧字段默认值掩盖问题。
3. 行数门禁失败时，优先把新逻辑抽到新文件，不要删除既有注释或测试。
4. 任一阶段连续两次回归，停止该阶段，写失败记录到本节，换下一个阶段。不要带着失败继续。

## §11 非目标

- 不合并 `running`、`promptInFlight`、`settled` 的语义。它们刻意正交。
- 不改 ACP 模式与 NTR 的业务判定。
- 不改协议字段名与持久化格式。
- 不做性能优化、UI 改版、日志改造。
- 不重构本方案未列出的其余候选状态点。
