# dsh-ntr

DeepSeek Harness (DSH) Web 插件：把浏览器变成一个 **ACP（Agent Client Protocol）客户端**。

宿主侧按服务端配置拉起任意 ACP agent 子进程（stdio JSON-RPC v1），事件经 SSE 推送到网页；浏览器可开启多会话、流式交互消息/思考过程/工具调用/计划、人工审批权限请求、切换 mode 与配置选项（如模型切换）。

## 功能特性

- **多 Agent 进程管理**：支持按需启动、停用已配置的 ACP 代理子进程。
- **多会话与流式渲染**：支持多会话隔离，流式展示用户消息、Agent 回复、思考过程、工具执行与任务计划。
- **人工审批闭环**：当 Agent 触发敏感工具调用时，在前端弹出权限审批卡片，由人类决定放行或拒绝；审批挂起可配置超时自动取消（`permissionTimeoutMs`，默认永久等待）。
- **无感断线重连（双向）**：浏览器↔宿主方向靠每会话环形事件缓存池（Transcript）按序补齐；宿主↔agent 方向靠 `session/load` 会话恢复——agent 进程崩溃后会话进入 released 状态（历史可读、上下文不丢），下次发消息自动 respawn 并回放会话历史（"发送即恢复"），无需人工重建会话。
- **工作区沙箱内的客户端文件能力**：实现 ACP `fs/read_text_file` / `fs/write_text_file`（含 `line`/`limit` 分页、单次 2 MiB 上限、自动创建父目录），所有路径经与 session cwd 相同的 `allowedCwdRoots` 白名单校验，越权访问直接拒绝。
- **可靠性兜底**：agent 启动期请求（`initialize` / `session/new` / `session/load`）受 `startupTimeoutMs` 约束（默认 60s），挂死的 agent 会被杀掉并报可操作错误（含 stderr 尾部）；agent 无视 `session/cancel` 时经 `cancelFallbackMs`（默认 15s）强制定稿 turn，会话永不卡死。
- **无侵入 UI 挂载**：通过 Cordis UI Slots 机制无缝挂载至左侧栏底部按钮、右侧抽屉面板及系统设置页。
- **原生聊天模型目录**：把 ACP agent 的 `configOptions`（`category: model` / `thought_level`）映射为 DSH 原生模型选择器条目——每个 agent 一个基础条目加 `agent@模型` 变体，思考等级作为 `reasoning` 元数据原生呈现；每轮请求前自动对齐会话配置，目录经探针获取并持久化到 `~/.dsh/acp-model-catalog.json`。
- **原生选择器可见性筛选**：原生模型选择器没有搜索功能，模型一多就会刷屏。设置面板的模型目录支持勾选哪些模型暴露到原生选择器（`exposedModels`），带搜索框、供应商（ACP 分组）下拉、全选/仅保留可见等批量操作；保存走轻量 RPC 即时生效，无需重启 agent、不影响进行中的会话。供应商下拉只认 agent 自己返回的 ACP 分组（如 omp acp），不做猜测式推断——跨商供应模型太常见，猜必错。

## 数据流架构

```
浏览器端 (Browser Half: lib/client.js)
  ├─ rpc.call('/acp', endpoint, payload)          一元操作（启动会话、发送 Prompt 等）
  └─ EventSource /api/acp/stream                    事件推送流（状态、消息更新、权限请求）
         │
宿主端 (Host Half: lib/index.js → BridgeManager)
  ├─ ctx.connection.rpc.handle('/acp', dispatchRpc)
  ├─ ctx.connection.fetch.register('/api/acp/stream')   SSE 流服务（安全通道）
  ├─ AgentBridge × N                                   子进程代理，多会话复用
  │    └─ @agentclientprotocol/sdk                     stdio JSON-RPC 通信
  ├─ Transcript                                        会话环形事件缓冲
  ├─ PermissionLedger                                  权限审批挂起与确认账本
  └─ EventHub                                          多端事件分发总线
```

## 配置示例

在 Profile 层的 `cordis.patch.yml` 中挂载并配置 agent：

```yaml
- id: dsh-ntr
  name: dsh-ntr
  config:
    agents:
      - id: pi
        title: pi coding agent (ACP)
        command: /path/to/bin/pi-acp
        cwd: /home/pax/coding/dsh-ntr/acp-workspaces
        allowedCwdRoots:
          - /home/pax/coding/dsh-ntr/acp-workspaces
        permission: ask
        # 仅把这些模型 choice 暴露到原生聊天选择器（缺省 = 全部暴露；基础条目始终可见）
        # exposedModels: [claude-sonnet-4, gpt-5]
    transcriptMaxEntries: 600
    # 模型目录自动探针（默认 true）；false 时仅支持手动「检测可用模型」按钮
    # probeModelsOnBoot: true
    # 可靠性兜底（默认值如下）：
    # startupTimeoutMs: 60000      # initialize / session/new / session/load 的超时
    # permissionTimeoutMs: 0       # 审批挂起超时自动取消（0 = 永久等待人工决策）
    # cancelFallbackMs: 15000      # session/cancel 后 agent 无响应的强制定稿时限（0 = 关闭）
```

## 构建与安装

```bash
# 依赖安装
npm install

# 构建产物（生成宿主端 TS 声明与浏览器端 Bundle）
npm run build

# 运行测试套件
npm test

# 挂载至 DSH Web Profile
dsh plugin --profile web add ./
```

## 文档索引

- [给 AI 编程 Agent 的操作规范与架构约束](./AGENTS.md)
- [DSH 插件开发通用指南（从零起手）](./docs/dsh-plugin-development-guide.md)
- [DSH 官方源码参考与架构索引](./docs/README.md)
