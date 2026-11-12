# 已知问题登记

> 用途：记录已确认、暂缓修复、需要单独提交的问题。每条写明现象、证据、影响范围、复现方式与建议修复方向。
> 与 `implicit-state-machines.md` 的阶段工作解耦：这里的问题不阻塞阶段推进，但必须有独立提交。

## 1. `tests/skills.spec.ts` 的符号链接用例在整仓运行时偶发失败

**状态**：已确认，未修复。观察于阶段 1（`refactor(state): stage 1 ACP verdict book`，提交 `e1638db`）。

**失败用例**：`scanSkillDirs > skips symlinked skill dirs that resolve outside their group anchor, and counts them`。

**失败断言**：`tests/skills.spec.ts:168`，`expect(result.skippedExternalSymlinks).toBe(madeOutside ? 1 : 0)`，实际收到 `0`，期望 `1`。同一用例的前一条断言 `tokens(result.skills)` 通过，说明扫描本身完成，只有外部链接的计数丢失。

**证据**：
1. 同一份代码整仓运行三次：一次全绿（1399 例），两次仅此例失败（1398 / 1399）。
2. `npx vitest run tests/skills.spec.ts` 单文件运行稳定通过。
3. 失败用例只导入 `src/impl.ts`、`src/bridge.ts`、`src/skills-scan.ts`、`src/protocol.ts`，与客户端 store 无关；阶段 1 的改动文件是 `src/client/store.ts`、`src/client/index.tsx`。
4. 同文件另一条断言 `skippedExternalSymlinks` 为 1 的用例（`tests/skills.spec.ts:188`）在同一轮整仓运行中通过。

**影响范围**：仅测试。产品代码的扫描行为未观察到异常。

**复现**：`npm test`（`vitest.config.ts` 配置 `maxForks: 1`，整仓顺序执行）。单文件运行不复现。

**原因假设**：Windows 上 `makeDirLink` 优先创建目录符号链接，权限不足时退回 junction。`src/skills-scan.ts` 的扫描循环在 `lstatSync` / `realPathOr` / `statSync` 抛错时由 `catch { continue }` 静默跳过，不计数。整仓运行时长与文件压力更大，符号链接刚创建时被安全软件或文件系统瞬时占用，触发该分支，计数为 0。

**建议修复方向**（任选其一，单独提交，信息用 `fix:` 前缀）：
1. 让 `scanSkillDirs` 区分“不是链接”与“读取链接失败”，后者计入跳过数或留下诊断字段，避免静默丢失。
2. 让测试对链接创建后的可读性做一次短重试（例如最多 3 次、每次 10ms），把瞬时占用与真实缺陷分开。
3. 在 CI 或本地固定使用 junction 路径，绕过符号链接权限差异。

不要为了让测试变绿而放宽断言到 `>= 0`，那会让真实回归失去保护。

## 2. `docs/acp-mode.md` 仍提到已删除的 `acpModeAsked`

**状态**：文档残留，未修复。观察于阶段 1。

`docs/acp-mode.md:136` 仍以 `acpModeAsked` 描述提问节流。阶段 1 已把它下沉为 store 内的独立节流表，对外暴露 `claimAcpAsk(sid, ttlMs)` 与 `releaseAcpAsk(sid)`。该文档目前与代码不一致。

修复方式：把该段改为描述 store 的提问节流表与方法名，单独提交为 `docs:`。
