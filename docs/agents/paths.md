# 跨平台路径

本文是 [AGENTS.md](../../AGENTS.md) 的展开层。`src/impl.ts` 不能 import `node:path`，这些原语必须手写；realpath 语义靠注入。

## 规则

- **绝对路径判定只能用 `isAbsolutePath`**：接受 POSIX `/…`、盘符 `C:\…` / `C:/…`、UNC `\\host\share…` 与 `//host/share…`，按字符串头判定风格。
- **`\\?\…` / `//?/…` 扩展长度形式不算绝对路径**（`isExtendedLength`）。配置校验当场报「absolute」而不是存下一个永远解析不出的 cwd；`canonicalizeFsPath` 也先于相对拼接分支显式拒绝它。
- **拒绝文案要诚实**：`\\?\…` 与缺 share 的 UNC 头（`\\host`，`segmentize` 返 `undefined`）是「这个层判不了的形式」，必须说 `acp: fs path is a form this layer cannot resolve`，**不是**「does not exist」——文件可能好端端地在。真正不存在的路径照旧报 does not exist。
- **containment 一律走 `isUnderPath`**：
  - win32 风格的双方做 `\`→`/` 分隔符与大小写折叠后再比；POSIX 保持字节精确。
  - 非绝对 root 一律不含；`/` 根只含 POSIX 形式的绝对路径。
  - **风格判定必须认两种分隔符写法**：`\host\share` 与 `//host/share` 都是 win32 风格。`foldSeparators` 把每个盘上 UNC 结果折成 `//` 形式；只认反斜杠等于在规范化之后丢掉大小写折叠（`//SRV/SHARE/x` 会被判为不在 `\\srv\share` 内）。`segmentize` 也一直把 `//host/share` 当 UNC，两处必须一致。
- **`canonicalizeFsPath`**：
  - 段级拼装基于 `segmentize` / `collapseSegments` / `joinWithin`；相对请求只在 session cwd 是 win32 风格时折叠 `\`。
  - 请求就是根自身时返回根的绝对写法（`/`、`C:/`），而不是去尾斜杠后的 `''` / `C:`。
  - `resolveSessionCwd` / `canonicalizeFsPath` 的 realpath 结果经 `foldSeparators` 以 `/` 形式返回。
- **浏览器半区**的表单校验必须用 `isAbsolutePathLike`（`src/client/acp-ui.tsx`），它是宿主 `isAbsolutePath` 的手拷贝；`tests/acp-view.spec.ts` 用同一批样本对两边做等价断言（同 `splitAcpModelId` 纪律）。

## 原因

插件最初只在 POSIX 上开发。Windows 上 `validateAgentDef` 会拒绝一切 `C:\…` 路径，`loadPersistedAgents` 随之把持久化 agent 静默丢光（`defaultAgent()` 变 `undefined`），聊天会话的 cwd 解析也全线 `bad_cwd` / `cwd_denied`——桌面版整条链不可用。

## 代码索引

- `src/impl.ts` · `isAbsolutePath` / `isExtendedLength` / `isUnderPath` / `isWin32Style` / `segmentize` / `collapseSegments` / `joinWithin` / `foldSeparators` / `canonicalizeFsPath` / `resolveSessionCwd`
- `src/client/acp-ui.tsx` · `isAbsolutePathLike`
- 测试：`tests/impl.spec.ts` 的 "cross-platform paths (Windows)" 套件（UNC 大小写 realpath fixture、根自身请求、`\\?\` 校阶拒绝）；`tests/acp-view.spec.ts` 的两侧等价样本集
