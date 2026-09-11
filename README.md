# dsh-ntr

DeepSeek Harness (DSH) Web 插件：把浏览器变成一个 **ACP（Agent Client Protocol）客户端**。

宿主侧按服务端配置拉起任意 ACP agent 子进程（stdio JSON-RPC v1），事件经 SSE 推送到网页；浏览器可开启多会话、流式交互消息/思考过程/工具调用/计划、人工审批权限请求、切换 mode 与配置选项（如模型切换）。

## 功能特性

- **多 Agent 进程管理**：支持按需启动、停用已配置的 ACP 代理子进程。
- **多会话与流式渲染**：支持多会话隔离，流式展示用户消息、Agent 回复、思考过程、工具执行与任务计划。
- **人工审批闭环**：当 Agent 触发敏感工具调用时，在前端弹出权限审批卡片，由人类决定放行或拒绝。
- **无感断线重连**：每会话内置环形事件缓存池（Transcript），断流重连后自动按序补齐缺失消息。
- **无侵入 UI 挂载**：通过 Cordis UI Slots 机制无缝挂载至左侧栏底部按钮、右侧抽屉面板及系统设置页。

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
    transcriptMaxEntries: 600
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
