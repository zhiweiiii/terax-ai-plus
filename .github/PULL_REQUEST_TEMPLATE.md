<!--
PR 标题遵循 Conventional Commits，它会成为 squash 提交的信息。
例：feat(terminal): add split panes / fix(explorer): close button alignment
标题和提交信息里不要出现 em-dash。
-->

## 改了什么
<!-- 一两句话说明这次改动。 -->

## 为什么
<!-- 你在解决什么问题。有 issue 就链上（例如 "Closes #42"）。 -->

## 怎么做的
<!-- approach 不明显时简单写几句，否则可以留空。 -->

## 怎么验证的
<!-- 只写"tsc 过了"不够，说明你实际走过哪些流程。 -->

- [ ] `pnpm lint` 干净
- [ ] `pnpm check-types` 干净
- [ ] （改了 `src-tauri/`）`cargo clippy --all-targets --locked -- -D warnings` 干净
- [ ] （改了 `src/web/`）`node scripts/web-synthetic-test.mjs` 全过
- [ ] （改了 `#[tauri::command]` 签名）在下面点出来，前端调用方要同步改
- [ ] 在 `pnpm tauri dev` 里手工试过受影响的功能
- [ ] 测过的 shell（如果相关）：<!-- pwsh / powershell / cmd / WSL -->

## 截图 / 录屏
<!-- UI 改动必须有。有前后对比更好。 -->

## 给 reviewer 的说明
<!-- 有风险的地方、想听第二意见的地方、留待后续的事情。 -->
