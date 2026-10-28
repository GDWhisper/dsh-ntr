# 发版

一条线：改代码 → 验证 → 更新 `CHANGELOG.md` → 提交 → bump 版本 → `chore(release)` 提交 → push `main` → 打 `vX.Y.Z` tag → push tag（触发 npm 发布）→ 建 GitHub Release。

## 版本与 tag

- 语义化版本：修复 / 小改动用 patch（`0.1.5 → 0.1.6`），成组的新能力用 minor。
- tag 必须是 annotated tag，名字**严格等于** `v` + `package.json` 的 `version`；CI 会校验，不匹配直接失败。
- `package.json` 与 `package-lock.json` 必须同步（`npm version` 会一起改）。
- `lib/` 是构建产物、被 gitignore；CI 自己 build，不要提交。

## 发布前检查

- [ ] 工作区干净（`git status --short` 无输出）
- [ ] `npm run prepack` 通过（typecheck + 全部测试 + build）
- [ ] `CHANGELOG.md` 已加本版一节，与 release note 同一套话、带提交号
- [ ] release note 按下方「Release note 规则」写好
- [ ] 要在本机 DSH 里自测：`npm run build` 后重启 DSH（宿主半区是进程内加载的）

## 步骤

### 1. 提交代码

Conventional Commits，英文；正文写动机与影响，不写「某年某月修过什么」。

### 2. bump 版本

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
- 只写用户能感知到的变化和怎么用；**不写根因、不写内部符号 / 文件名 / 实现机制**。
- 一条一句话，末尾挂提交链接 `([abc1234](https://github.com/GDWhisper/dsh-ntr/commit/abc1234))`；有 issue 就再挂 issue 链接。
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
- npm 镜像有同步延迟；以 `npm view` 能查到新版本为准。
