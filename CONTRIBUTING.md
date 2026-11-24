# 参与贡献 / Contributing

本仓库接受 PR。一句话规矩：**从你自己的 fork 开分支改，开 PR 到 `main`，标题写成 Conventional Commits。**
This repo takes pull requests. In one line: **branch off your own fork, open a PR against `main`, use a Conventional Commits title.**

## 流程 / Workflow

1. fork 本仓库，从最新 `main` 开分支。 / Fork this repo and branch off the latest `main`.
2. 改代码，本地跑通 `npm run verify`。 / Make the change and get `npm run verify` green locally.
3. 推到你的分支，开 PR，base 选 `main`。 / Push to your branch and open a PR with `main` as the base.
4. 维护者 review 后 squash 合并。 / The maintainer reviews, then squash-merges.

`main` 已开启分支保护：只能经 PR 合入、至少一个 approval，不接受直推。 / `main` is protected: PRs only, at least one approval, no direct pushes.

## 分支与 PR / Branches and PRs

- **不要在 `main` 上改。** 每个 PR 都来自自己的分支——同仓库有写权限的人也一样。 / **Don't work on `main`.** Every PR comes from its own branch — same for people with write access here.
- 分支名用 `feat/` · `fix/` · `docs/` · `chore/` 前缀加简短描述，例如 `fix/agy-late-output-delivery`。 / Prefix branch names with `feat/` · `fix/` · `docs/` · `chore/` plus a short slug, e.g. `fix/agy-late-output-delivery`.
- **一个 PR 只做一件事。** 顺手重构请单独开 PR。 / **One PR, one thing.** Drive-by refactors go in their own PR.
- PR 标题就是合并后的提交标题：Conventional Commits、英文，例如 `fix(acp): treat user_message_chunk as bookkeeping`。它会原样进入发版 CHANGELOG。 / The PR title becomes the commit subject: Conventional Commits, English, e.g. `fix(acp): …`. It lands verbatim in the release CHANGELOG.
- 提交前 rebase 到最新 `main`；PR 里不要夹带无关的合并提交。 / Rebase onto the latest `main` before pushing; no unrelated merge commits in the PR.
- 动的是新机制或大改，先开 issue 对齐再写代码。 / For a new mechanism or a large change, open an issue first.

## 必须满足 / Requirements

- `npm run verify` 全绿（行数门禁 + typecheck + tests + build），PR 里写清实跑的命令和结果。 / `npm run verify` green (size gate + typecheck + tests + build); list the commands you actually ran and their result.
- 不改 `CHANGELOG.md`：条目在发版时统一从提交区间提取。 / Don't edit `CHANGELOG.md`: entries are extracted from the commit range at release time.
- 不提交 `lib/`：构建产物，CI 自己构建。 / Don't commit `lib/`: it's build output, CI builds it.
- 改到 [AGENTS.md](./AGENTS.md) 与 `AGENTS/` 下记录的行为，同一个 PR 里更新对应文档。 / If you change behavior documented in [AGENTS.md](./AGENTS.md) or under `AGENTS/`, update that doc in the same PR.
- 新文件 ≤ 1000 行；单个文件超 500 行或净增 200 行，在 PR 里说明原因。 / New files ≤ 1000 lines; explain any file over 500 lines or a +200-line delta.
- 界面改动附截图或录屏（亮色、暗色各一张更好）。 / UI changes need a screenshot or recording (light and dark if you can).
- 提交信息里不要写 AI 署名（`Co-Authored-By: <AI>`、`Generated with …`）：`.githooks/commit-msg` 会拒绝。 / No AI attribution in commits (`Co-Authored-By: <AI>`, `Generated with …`): `.githooks/commit-msg` rejects it.

## 本地开发 / Local development

```bash
npm install
git config core.hooksPath .githooks   # 启用提交钩子 / enable the commit hooks
npm run build
npm test
```

定向用例：`npx vitest run tests/bridge.spec.ts -t "spawns, initializes"`。想看改动在界面上的效果：`dsh plugin --profile web add ./` 挂到本地 profile。 / Targeted tests: `npx vitest run <file> -t "<case>"`. To see your change in the UI: `dsh plugin --profile web add ./`.

改造前请读 [AGENTS.md](./AGENTS.md) 的硬约束一节——那 40 条每条都对应一个真实故障。 / Before changing code, read the hard-constraints section of [AGENTS.md](./AGENTS.md): each of those 40 rules maps to a real incident.

## 反馈问题 / Reporting issues

走 [issue 模板](./.github/ISSUE_TEMPLATE)，附上插件版本（`package.json` 的 `version`）、DSH 版本、agent 名称与它的启动命令。 / Use the [issue templates](./.github/ISSUE_TEMPLATE) and include the plugin version, your DSH version, the agent name, and its launch command.
