# OmniTerm ACP 层对照与未吸收清单

对照来源：`G:\Codes\ot\OmniTerm-dev.dev`（Rust + `agent-client-protocol` crate，ACP 层在 `src/acp`，约 8600 行）。首次对照 2026-10-11；2026-10-17 再拉 dev 到 `6a13ecb8` 复核并吸收第 4 条。产品形态与本插件同构：借一个界面壳，经 stdio ACP 驱动外部 agent 进程。本文记录三件事：对照结论、**已吸收**的改动、**尚未吸收**的候选项（按价值排序，含 OmniTerm 侧的文件与符号，供未来认领时定位），以及**明确不吸收**的项（附理由，防止未来误判为遗漏）。

OmniTerm 侧的关键文件：`src/acp/client.rs`（ACP 客户端与广播总线）、`src/acp/turn_accumulator.rs`（后端权威的 turn 折叠与记账）、`src/acp/agent_proc.rs` / `supervisor.rs` / `reaper.rs`（进程生命周期）、`src/acp/permission.rs`（审批）、`src/acp/chat_persistence.rs` / `usage.rs` / `config_prefs.rs`（持久化）、`src/ws/acp.rs`（WS 重连对账）。该仓的注释纪律很好：大量实测事故以注释形式钉在符号旁边，认领候选项时值得把对应注释读一遍。

## 对照结论

主干能力两边重合：stdio JSON-RPC 桥、启动超时杀进程、cancel 兜底强制定稿、`session/load` 崩溃恢复、空闲回收、审批 UI、模型/配置目录、turn 折叠渲染。**Windows 上本插件更完整**：OmniTerm 的 ACP 层明确标注「POSIX-only; ACP 暂不支持 Windows」——没有 `.cmd` shim、没有进程树击杀、没有 cwd 修复；本插件的 `cmd.exe /d /s /c` + `taskkill /t /f` 组合（约束 26）是领先方。OmniTerm 更强的地方在其前端重连协议与后端持久化（它后端持有流式事实源），这些与本插件的架构归属不同，见「明确不吸收」。

## 已吸收（前三条 2026-10-11 同日落地，见约束 12 / 23；第 4 条 2026-10-17）

1. **取消兜底的 turn 世代守卫 + `settled` 闸门解开**。OmniTerm 的 `spawn_cancel_turn_fallback` 用 `prompt_generation` 守卫兜底定时器——定时器触发时 running 的可能已经是取消之后新发起的 turn。本插件落点：`armCancelFallback` 捕获 `session.turnSeq`，世代前进即放手；强制定稿同时解开 `settledResolve`（否则适配器路径的下一轮 prompt 卡 `unsettled`）。
2. **粘滞取消吞消息的检测重发**。OmniTerm 实测 codebuddy 2.161.4：处理 `session/cancel` 时异步清理状态，落在清理窗口内的下一条 prompt 被秒回 `cancelled`（复用旧 requestId、不生成 turn），用户消息无痕丢失；判据是「本世代是否发起过 cancel」而非延时。本插件落点：`runPrompt` 的 `cancelRequestedAtTurn` 对比 + `staleCancelRetryDelayMs`（默认 600ms）有界重发。
3. **正常结束却零可见产出的显式报出**。OmniTerm 实测 pi-acp 把 provider 403 折叠成合法 `end_turn`，聊天流只剩空气泡；它按「协议说成功但一个可见帧都没有」判定异常终态（`update_is_visible_output`）。本插件落点：`streamPrompt` 的 `sawVisibleBlock` 记账 + 空产出告警文本块。
4. **对话前就能选好 agent 的模型 / 思考等级，并把选择持久化**（2026-10-17 吸收，OmniTerm 侧 `src/acp/config_prefs.rs` + `attach_config_prefs` / `restore_config_prefs`）。OmniTerm 的记录分两层：agent 级偏好（新建/恢复会话的默认值）与会话级覆盖（本会话用户主动 set 过的值），restore 时合并、逐项用 agent 当前的 `configOptions` 校验，过期项跳过而不是报错。
   - **移植动机**：本插件的模型/思考等级原本只写进**活会话**（`alignSessionConfig`），而活会话要等第一条消息才存在 —— 于是「对话前选模型」根本无法表达，重启后选择也全丢（`chatAgentIntent` 只有内存）。这不是缺个界面，是缺一个**选择属于会话而非进程**的记录。
   - **本插件落点**：`AcpConversationChoice`（`src/protocol.ts`）记录 `agentId` + `modelId` + `effort`，持久化在 `~/.dsh/dsh-ntr/agents.json` 的 `conversations` 键下（`loadPersistedChoices` / `persistAgents`）。`setChatSessionModel` / `setChatSessionEffort` 先记 pick 再对活会话对齐；`applyChatChoice` 在 `createSession` / `getOrCreateDshSession` 的 resume 分支把 pick 应用到**刚物化**的会话上——`session/new` 回的是 agent 自己的默认值，不补这一步「选了 A 却跑了 B」。
   - **与 OmniTerm 的差异（有意）**：不做 agent 级偏好层。agent 级默认已经由 `agent/catalog` 的 `reasoning.defaultEffort` 与 agent 自己的 `currentValue` 表达，再加一层会变成「用户没选过、却以为选过」的第三种事实源。会话级记录 + agent 自报默认足够。
   - **校验语义沿用**：`alignSessionConfig` 本来就只在 `choices` 里含有该值时才下发（`choices.length === 0` 时放行，即 agent 未提供列表不阻断），过期 pick 降级为告警而非失败轮次。

## 尚未吸收（按价值排序的候选项）

1. **Transcript 的字节上限（双轴淘汰 + 单帧上限）**。OmniTerm 的帧窗口同时受条数（`MAX_FRAMES` 2000）与字节（`MAX_BLOCKS_BYTES` 128KB）约束，另有单帧上限 `MAX_FRAME_BYTES`（64KB，防单帧独占预算）；正文走 `BoundedText`（head 冻结 + 尾窗 + 显式「已省略 N 字符」标记）。实测依据：codebuddy 每个 `tool_call_update` 都重发完整 `rawInput`（中位 4.5KB/帧），纯条数上限在这种帧下拦不住体积。本插件现状：`Transcript`（`src/impl.ts`）只按条数封顶（`transcriptMaxEntries` 默认 600，肥帧下约 2.7MB），且 SSE 重连 `since()` 一次全量补发。触发条件：重连补发可观测变慢、或内存曲线异常时再做；落地时双轴 + 单帧三限一起上。
2. **工作时长 / 审批等待时长记账**。OmniTerm 在 turn 折叠处同时结算 `work_ms`（= 墙钟 − 等人审批）与 `wait_ms`：未决审批用**计数器**（`wait_depth`）不用布尔（agent 可并发发多个 `session/request_permission`），全部应答才累加该段；取消时就地结清等待段（之后的收尾算工作）。本插件落点：`streamPrompt` 已有完整 turn 生命周期，等待审批的起止点在 `askNativeApproval` / ledger 应答处，ACP 视图 tab 可显示每轮耗时。纯增量功能，无正确性风险。
3. **权限超时的三档模式**。OmniTerm 的 `PermissionTimeoutMode`：`Abort`（默认；超时消息带「错过了什么」的工具/内容预览/可选项详情）、`Auto`（用 `pick_auto_option` 代答让 agent 继续；**解析不出合法选项就降级 Abort，绝不瞎猜**）、`Wait`（不动作，且跳过 prompt 卡死判定——把「等审批」误判成卡死会与用户的应答竞态）。本插件落点：`permissionTimeoutMs` 的 ledger 兜底路径（约束 13 的降级通道），原生审批路径不受影响。
4. **错误文案可操作化**。OmniTerm 把内部态翻译成用户动作：连接已释放时把库错误 "connection is no longer running" 替换成「会话进程已释放，请重新发送以自动恢复连接」。本插件落点：`AcpError` 的 `session_closed` / `agent_unreachable` 等文案，把「下一步做什么」写进消息。
5. **agent 命令的 npm 懒安装**。OmniTerm 的 `resolve_command` 解析链：PATH → `~/.omniterm/agents/node_modules/.bin/` → 按 agent 配置的 `npm_package` 自动安装到私有 prefix 后复查。本插件落点：`ensureAgentExecutable` / `AGENT_PRESETS` 附近。优先级低：本插件的用户手配完整命令行，预设只有一行命令。
6. **ACP `terminal/*` 服务端实现**。OmniTerm 的 `AcpTerminalManager` 实现全部五个终端方法（create / output / kill / release / wait_for_exit），agent 发起的后台命令在聊天里渲染成行内芯片（否则对用户不可见）。本插件未实现这些 client 方法，agent 调用会得到 method-not-found。等真有 agent 用到再做。
7. **重连对账的 subscribe-before-snapshot 变体**。OmniTerm 客户端连接时先订阅广播再取 turn 快照，快照携带 seq 水位，实时帧 `seq <= 快照` 直接丢弃——重叠窗口变成可去重的重复窗。本插件已有 `since(seq)` 补发 + `session/reset` 水位清空，语义覆盖同一问题；此条只是去重粒度更细的变体，仅当 SSE 侧观测到重复帧时参考。
8. **主动 kill 造成的 exit 事件静默**。OmniTerm 的 crash watcher 对两类 exit 静默：`JoinError::is_cancelled()` 与 `alive == false`（主动关闭——killpg 造成的 "exited with signal 9" 是预期）。本插件的 identity guard（约束 11）已覆盖「延迟 exit 误判新进程死亡」的那一半；「主动释放不得触发 connectionLost」的另一半目前由 `releaseAll` 先翻转状态再 `killChild` 的顺序隐式保证。**未来新增任何 exit 触发器时必须保持这条纪律**，必要时补一条显式断言测试。

## 明确不吸收（记录理由，防止未来误判为遗漏）

- **POSIX wrapper / pid 自报 / killpg / `/proc` diff 兜底**：OmniTerm ACP 层 POSIX-only，这套东西解决的是它 crate 不交 `Child` 句柄的问题；本插件在 Windows 上有自己的完整方案（约束 26），Node 直接持有 child 对象。
- **cooked 块写回收敛**：OmniTerm 后端存原始帧、前端每轮回写折叠后的块（体积差两个数量级）。本插件的聊天持久化由宿主完成（折叠后的 assistant 消息），不存在 raw 帧落库问题。
- **usage 快照落库**：OmniTerm 的 WS 广播无补发，`usage_update` 又不被 `session/load` 重放，只能 sqlite 快照。本插件的 usage 走 `session.usage` + transcript 重放，架构下该问题不存在。
- **「权限等待不进 idle 判定」**：`isQuiet()` 已把待答审批算作忙（约束 19），同型能力已存在。
- **会话配置偏好的两层恢复**（agent 级默认 + 会话覆盖 + 恢复时逐项校验）：**曾经**判断为「`streamPrompt` 每轮 `alignSessionConfig` 已闭环同型能力」——这个判断是错的，因为 `alignSessionConfig` 只能作用于**已存在**的活会话，而对话前的选择、以及重启后的选择，都需要一个先于会话存在的记录。2026-10-17 已按「会话级 pick + 建/恢复会话时应用」吸收，见上面「已吸收」第 4 条（agent 级那一层仍不吸收，理由见该条）。
- **审批横幅队列与跨端 reconcile**（`pendingPermissions` 队列 + `permissions_synced`）：审批归对话 composer（约束 13/14），单端 UI，无多端问题。
- **启动超时 = drop future 的级联清理形态**：Rust 所有权特有（超时即 drop 外层 future → abort 链 → RAII 收尾）；本插件的 `withStartupTimeout` + `killChild`（约束 12）语义等价。
