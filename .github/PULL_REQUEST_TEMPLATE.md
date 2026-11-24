> 开 PR 前请读 [CONTRIBUTING.md](../CONTRIBUTING.md)：分支命名、必须通过的检查、提交信息规范都在那里。
> Read [CONTRIBUTING.md](../CONTRIBUTING.md) before opening this PR — branch naming, required checks, and commit conventions live there.

## 摘要 / Summary

<!-- 一句话：这个 PR 做了什么。/ One sentence: what this PR does. -->

## 动机与背景 / Motivation

<!-- 现在的行为是什么、问题怎么暴露（用户可见影响）、为什么必须改。 / What happens today, how the problem shows up, and why the change is needed. -->

## 关联 issue / Related issue

<!-- 例如 Closes #123；没有就写「无」/ e.g. Closes #123; write "none" if there is none. -->

## 改动内容 / Changes

<!-- 按条目写行为变化，不要列文件清单。/ List behavior changes, not a file list. -->

-

## 验证 / Verification

<!-- 写实际跑过的命令与结果；没跑的说明原因。/ List commands you actually ran and the result; explain anything skipped. -->

- [ ] `npm run verify`（行数门禁 + typecheck + tests + build / size gate + typecheck + tests + build）
- [ ] 定向用例（`npx vitest run <file>` / targeted tests）
- [ ] 手工验证（写步骤与观察到的结果 / describe steps and observations）

## 文档 / Docs

- [ ] 改了 `AGENTS/` 所描述的行为，已在本 PR 内更新对应文档 / Updated the matching `AGENTS/` doc in this PR
- [ ] 本次改动不涉及 `AGENTS/` 记录的行为 / This change does not touch behavior documented in `AGENTS/`

## 检查清单 / Checklist

- [ ] PR 来自独立分支（`feat/` `fix/` `docs/`），base 为 `main`，已 rebase 到最新 `main`，不含无关的合并提交 / The PR comes from its own branch (`feat/` `fix/` `docs/`) based on `main`, rebased onto the latest `main`, with no unrelated merge commits
- [ ] 提交信息符合 Conventional Commits，英文正文写明动机与影响 / Commit messages follow Conventional Commits with an English body covering motivation and impact
- [ ] 未提交 `lib/` 构建产物 / No build output from `lib/` is committed
- [ ] 新文件 ≤ 1000 行；单文件超 500 行或净增 200 行已在上面说明 / New files are ≤ 1000 lines; files over 500 lines or a +200-line delta are explained above
- [ ] 未直接修改 `CHANGELOG.md`（发版时统一提取）/ `CHANGELOG.md` is untouched (entries are extracted at release time)
- [ ] 界面改动附截图或录屏 / UI changes include screenshots or a recording
