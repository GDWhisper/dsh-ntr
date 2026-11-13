# 已知问题登记

> 用途：记录已确认、暂缓修复、需要单独提交的问题。每条写明现象、证据、影响范围、复现方式与建议修复方向。
> 与 `implicit-state-machines.md` 的阶段工作解耦：这里的问题不阻塞阶段推进，但必须有独立提交。

## 1. `tests/skills.spec.ts` 的符号链接用例在整仓运行时偶发失败

**状态**：已修复（提交号：待填）。观察于阶段 1（`refactor(state): stage 1 ACP verdict book`，提交 `e1638db`）。

**失败用例**：`scanSkillDirs > skips symlinked skill dirs that resolve outside their group anchor, and counts them`。

**失败断言**：`tests/skills.spec.ts:168`，`expect(result.skippedExternalSymlinks).toBe(madeOutside ? 1 : 0)`，实际收到 `0`，期望 `1`。同一用例的前一条断言 `tokens(result.skills)` 通过，说明扫描本身完成，只有外部链接的计数丢失。

**根因**（修复前整仓连续 2 次复现，临时诊断代码取证）：
1. 扫描循环对符号链接子项调用 `realpathSync(childPath)` 时抛 `ENOENT`（errno -4058）。旧 `realPathOr` 吞掉该错误，回退返回链接自身路径。
2. 回退路径字面上位于 group 锚点内，`isUnderPath` 返回 `true`，于是既不计入外部链接数，也不报错。
3. 随后 `statSync(childReal)`（旧实现第 158 行）同样抛 `ENOENT`，被 `catch { continue }` 静默跳过，`skippedExternalSymlinks` 保持 `0`。两个真实 skill 由直接目录扫描得到，因此 `tokens` 断言仍通过。
4. 取证记录：失败时 `lstatSync` 正常且 `isSymbolicLink()` 为真；`readlinkSync` 返回链接记录的目标（整仓运行下被上层文件系统映射改写）；`realpathSync.native(link)` 与 `statSync(link)` 均返回 `ENOENT`，而同一进程对 `readlink` 记录的目标调用 `realpathSync.native` 可成功。失败在该次扫描内持续存在，单纯重试无法恢复。

**修复**（`src/skills-scan.ts`）：
1. 第 125-140 行新增 `retryLinkRead`：对链接的 `realpath` / `stat` 最多重试 3 次、间隔 10ms，覆盖 Windows 上刚创建链接的瞬时不可用。
2. 第 143-154 行新增 `resolveLinkTarget`：跟随链接失败后，读取 `readlinkSync` 记录的目标并用 `realpathSync.native` 规范化，再交给 `isUnderPath` 判定包含关系；仍无法解析时返回 `undefined`。
3. 第 195-208 行：无法解析的链接计入 `skippedExternalSymlinks` 并跳过，不再静默丢弃。它与外部链接共用计数，含义是“拒绝扫描的链接”；`lstat` 失败仍静默跳过（取证显示 `lstat` 未失败，且给 2000 项目录扫描加失败重试会放大约 10 倍耗时）。

**验证**：`npx vitest run tests/skills.spec.ts` 连续 20 次全绿；`npm test` 整仓连续 2 次全绿（51 文件 / 1418 例）；`npm run typecheck` 与 `npm run check:size` 通过。

**影响范围**：仅测试曾观察到失败；产品代码的扫描在修复后对不可解析的外部链接计数更完整。

## 2. `docs/acp-mode.md` 仍提到已删除的 `acpModeAsked`

**状态**：文档残留，未修复。观察于阶段 1。

`docs/acp-mode.md:136` 仍以 `acpModeAsked` 描述提问节流。阶段 1 已把它下沉为 store 内的独立节流表，对外暴露 `claimAcpAsk(sid, ttlMs)` 与 `releaseAcpAsk(sid)`。该文档目前与代码不一致。

修复方式：把该段改为描述 store 的提问节流表与方法名，单独提交为 `docs:`。
