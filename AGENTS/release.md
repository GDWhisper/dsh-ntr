# 发版

本文是 [AGENTS.md](../AGENTS.md) 索引的发版手册。

一条线：改代码 → 验证 → `git log vPREV..HEAD` 列出提交区间并逐笔判定 → 更新 `CHANGELOG.md` → 提交 → bump 版本 → `chore(release)` 提交 → push `main` → 打 `vX.Y.Z` tag → push tag（触发 npm 发布）→ 建 GitHub Release。

## 版本与 tag

- 语义化版本：修复 / 小改动用 patch（`0.1.5 → 0.1.6`），成组的新能力用 minor。
- **用户未主动声明版本号时，只升 patch（`Z`）**：默认在当前版本上 `X.Y.(Z+1)`，绝不替用户决定升 minor / major；确需升 `X` / `Y` 时先向用户确认，或等用户明确指定。
- tag 必须是 annotated tag，名字**严格等于** `v` + `package.json` 的 `version`；CI 会校验，不匹配直接失败。
- `package.json` 与 `package-lock.json` 必须同步（`npm version` 会一起改）。
- `lib/` 是构建产物、被 gitignore；CI 自己 build，不要提交。

## 从提交区间生成记录（强制）

`CHANGELOG.md` 与 release note 的清单来源**只能是**上一个发布 tag 到当前 HEAD 的提交区间；不能按「本次开发范围」、`git log -5` 或记忆划范围。区间里可能有别人或更早提交、尚未进入任何版本的修复，它们会随本版 tag 一起发布，就必须出现在本版记录里。

```sh
PREV=$(git describe --tags --abbrev=0 --match 'v*')   # 起草时最近的已发布 tag
git log --format='%h %s' "${PREV}"..HEAD
```

逐笔判定：

- **用户可见改动**（功能、行为、修复、提示 / 文案变化）→ 至少一条条目，链接到**引入它的那个 commit**；同一个 commit 可以对应多条条目。
- **不产生用户可见行为的提交**（只改文档 / 测试 / 重构 / 发版流程）→ 不记（约束 35）。判定标准是「用户能否感知」，不是「文件在不在 src/」。
- 同一分区（新增 / 改进 / 修复）内按**提交时间顺序**排列，旧的在前；每条链接必须是本区间内的 commit，不能链到 release commit 或区间外。
- 起草完逐条勾对：区间里每个用户可见 commit 都至少有一条条目；每条条目都能回指区间内一个 commit。

发布后才发现漏记：**不要移动已发布的 tag**（见「失败时」）；在 `main` 上补 `docs(release): ...` 修正 `CHANGELOG.md`，再用 `gh release edit` 同步 GitHub Release 正文。已发布版本号不复用；npm 包不含 `CHANGELOG`，已发布产物不受影响。

## 发布前检查

- [ ] 工作区干净（`git status --short` 无输出）
- [ ] `npm run prepack` 通过（typecheck + 全部测试 + build）
- [ ] 已用 `git log vPREV..HEAD` 逐笔核对：区间内每个用户可见提交都有条目
- [ ] `CHANGELOG.md` 已加本版一节，与 release note 同一套话、带提交号；同一分区按提交顺序排列
- [ ] 每条条目链接的 commit 都在本版区间内；内部文档 / 测试 / 重构提交没有记成用户改动
- [ ] release note 按下方「Release note 规则」写好
- [ ] 要在本机 DSH 里自测：`npm run build` 后重启 DSH（宿主半区是进程内加载的）

## 步骤

### 1. 提交代码

Conventional Commits，英文；正文写动机与影响，不写「某年某月修过什么」。

### 2. bump 版本

用户没给版本号时就按 patch 升（见上方「版本与 tag」），下面的 `0.1.6` 按实际 `Z+1` 替换：

```sh
npm version 0.1.6 --no-git-tag-version
```

`--no-git-tag-version`：tag 由我们自己打，保证它是 annotated 且落在版本提交上。

### 3. Release 提交

正文写这一版**面向用户**的改动（与 release note 同一套话）：

```sh
git add package.json package-lock.json CHANGELOG.md
git commit -m "$(cat <<'EOF'
chore(release): 0.1.6

- ...
EOF
)"
```

### 4. 推送主分支

```sh
git push origin main
```

### 5. 打 tag 并推送（这一步触发发布）

```sh
git tag -a v0.1.6 -m "v0.1.6"
git push origin v0.1.6
```

### 6. 看 workflow

```sh
gh run list --workflow=publish-npm.yml --limit 3
gh run watch <run-id> --exit-status
```

### 7. 确认 npm

```sh
npm view dsh-ntr@0.1.6 version dist-tags --json
```

`dist-tags.latest` 应指向新版本（workflow 会在 registry 可见后自动 pin）。

### 8. 建 GitHub Release

workflow 的权限是 `contents: read`，**不会**自动建 Release，需要手动：

```sh
gh release create v0.1.6 --title "v0.1.6" --notes "$(cat <<'EOF'
<一句话总结这一版的主线>

## 新增

- ...

## 修复

- ...
EOF
)"
```

## Release note 规则（面向用户）

- 标题只写 `vX.Y.Z`，**不加主题后缀**；正文第一行放一句话总结这一版的主线。
- 清单来自 `git log vPREV..HEAD`（见上方「从提交区间生成记录」）；**严禁**只按本次功能范围或凭记忆写，区间内每一笔用户可见改动都必须有条目。
- 只写用户能感知到的变化和怎么用；**不写根因、不写内部符号 / 文件名 / 实现机制**。
- 一条一句话，末尾挂**引入它的**提交链接 `([abc1234](https://github.com/GDWhisper/dsh-ntr/commit/abc1234))`；有 issue 就再挂 issue 链接。同一 commit 对应多条条目时可以重复挂同一个链接。
- 同一分区按提交时间顺序排列，旧的在前。
- 分区只留用得上的：`## 新增` / `## 改进` / `## 修复`。
- **只记确定性的改动**：写这一版留下的最终行为；被推翻、回退或只在开发过程中存在过的中间形态不写。`CHANGELOG.md` 与 release note 使用同一套话。
- `CHANGELOG.md` 每节标题用 `## [X.Y.Z] - YYYY-MM-DD`，新版本加在最上方。
- 示例（0.2.0）：

```markdown
审批询问现在直接出现在对话里，每一条都会送到你面前，不会再隐形挂起（[#2](https://github.com/GDWhisper/dsh-ntr/issues/2)）。

## 新增

- **审批卡直接出现在对话里**：agent 要动敏感东西时，询问卡出现在聊天输入框上方，和输入框同宽居中；选项就是 agent 给的那些（包括「始终允许」），点哪个它就收到哪个。([78545b6](https://github.com/GDWhisper/dsh-ntr/commit/78545b6))

## 修复

- **审批卡与输入框对齐**：不再比输入框宽出一截。([fccd95b](https://github.com/GDWhisper/dsh-ntr/commit/fccd95b))
```

## Workflow 做了什么

`.github/workflows/publish-npm.yml`，push `v*` tag 触发：

1. `npm ci` → `npm run prepack`（typecheck + tests + build）
2. 校验 `tag == v` + `package.json` version
3. `npm publish --access public --provenance`
4. 等 registry 可见后 `npm dist-tag add … latest`
5. 请求 npmmirror 同步

也支持手动 `workflow_dispatch`：**必须勾 `dry_run`**，它只做 rehearsal；不勾会用当前 `main` 的版本号真的发布。

## 失败时

- **publish 之前失败**（typecheck / test / build / tag 校验）：修好后删 tag 重打：
  ```sh
  git push origin :v0.1.6
  git tag -d v0.1.6
  ```
- **已经 publish 之后失败**（pin latest / mirror sync）：**不要复用这个版本号**，发一个新的 patch 版本；或手动补 `npm dist-tag add dsh-ntr@0.1.6 latest`。
- **发布后才发现 CHANGELOG / release note 漏记**：不要移动或重打已发布的 tag，也不要复用版本号。在 `main` 上补 `docs(release): ...` 修正 `CHANGELOG.md`，再用 `gh release edit vX.Y.Z --notes ...` 更新 GitHub Release 正文；npm 包不含 `CHANGELOG`，已发布产物不受影响。
- npm 镜像有同步延迟；以 `npm view` 能查到新版本为准。
