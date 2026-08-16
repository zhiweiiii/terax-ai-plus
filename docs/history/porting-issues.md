# 移植工作问题清单（10-Agent 批次）

> 基于 A-E + Opt-1~4 共 9 个 agent 的工作记录汇总。状态：🔴阻塞 / 🟡待处理 / 🟢已完成
>
> 最近更新：质量审计（2026-08-14）— Agent A 已全部落地，契约核对完成，见「最终验收清单」。

## 阻塞项

### 1. 🟢 Rust 共享层（Agent A）已全部落地
- ~~现象：A 两轮任务均返回空结果，`src-tauri/src/modules/git/` 无任何新命令。~~
- 现状：`src/modules/ai/lib/native.ts` 已包含全部 34 个新命令（契约勘误：原记录"31 个"，实际枚举 34 个，已全部落地）；`src-tauri/src/modules/git/commands.rs` 共 55 个 git 命令与之一一对应（含 `git_push_advanced` 的 `remote?: string`）。
- 残余：桥接层收口尚未执行（见 #5）。

## 编译速度慢

### 2. 🟢 `rebased/` 目录已排除
- `.gitignore` 已加 `rebased/`；`vitest.config.ts` 的 `test.exclude` 已加 `rebased/**`；`biome.json` 已加 `!rebased/**`（files.ignore）。三处全部就位。
- 后续清理：`rebased/` 目录（约 900MB 第三方源码快照）与全部测试代码、`vitest.config.ts` 均已删除。

### 3. 🟢 Cargo 编译慢 + dev 实例锁定 exe
- Cargo.toml profile 已确认优化到位（dev: incremental=true / split-debuginfo=unpacked / codegen-units=16；dev.package opt-level=2）。
- 主二进制统一命名为 `terax-prod`（dev/release 同名）；运行中的实例会锁定 exe（os error 5），需先关闭再编译。

## 待验证/待处理

### 4. 🟢 C 与 Opt-3 并行修改 `RepoBranchSelector.tsx` 已确认无丢失
- 审计确认：`BranchActionsMenu`（分支操作菜单，L458）与 `WorktreeManagerDialog`（Worktrees 入口，L717）均在 `RepoBranchSelector.tsx` 中完好共存。

### 5. 🟡 桥接层收口（唯一待执行代码项）
- `branchOps.ts`（7 个函数）与 `git-history/lib/nativeGit.ts`（勘误：15 个方法，非 14）改为直接调 native；移除 `nativeGit.ts:69` 的 `as unknown as`。
- 收口时须一并修复 #13 的 `gitDiffWithRef` payload key 不一致，并统一两处类型 null 联合（`GitCreateBranchOptions.startPoint`、`GitTagCreateOptions.message`：nativeGit 本地类型缺 `| null`）。
- `branchOps.test.ts` 的断言随收口更新（当前断言编码了错误契约 `ref` key，见 #13）。

### 6. 🟢 Opt-1 遗留已解决
- Pull 拆分管方案在案（原按钮=ff-only + 下箭头=策略菜单）；`PushDialog`/`PullStrategyDialog` 选项文案全英文（Merge/Rebase/Squash…），与面板英文风格一致。
- `SourceControlPanel` 的旧 `pushAll` prop 已移除，App 侧同步（传 `pushAllAdvanced`/`buildPushPlan`），无残留。

### 7. 🟡 Worktree `onOpenPath` 未接线
- 审计确认：`WorktreeManagerDialog` 已实现 `onOpenPath?: (path) => void` 条件渲染按钮（L194-199），但 `RepoBranchSelector` 渲染时不传该 prop（L717-731），"在终端打开"按钮仍不显示。依赖 App 层 `cdInNewTab`。

### 8. 🟢 D 的建议：`gitPushAdvanced` 增加 `remote?: string`
- 已并入 A 契约并落地：`GitPushOptions.remote?: string | null`（native.ts L218）+ Rust `git_push_advanced` 一致。

### 9. 🟢 设置页 `SettingsTab` 深链 `"version-control"` 三方一致
- `openSettingsWindow.ts` SettingsTab 含 `"version-control"`；`SettingsApp.tsx` TABS 注册（L47-51）+ VALID_TABS（L79-88）一致；深链 URL/事件处理复用同一 VALID_TABS，行为与其他 tab 一致。

## 测试与完善

### 10. 🟡 新增纯函数测试（大部分已补，两处仍缺）
- 已有：`remoteHelpers.test.ts`、`branchOps.test.ts`（7 函数全覆盖 + workspace env）、`worktreeOps.test.ts`、`filters.test.ts`、`graph.test.ts`、`remoteWebUrl.test.ts`。
- 待补：push 计划生成逻辑（`useMultiRepoSourceControl` 纯函数部分）、pre-commit 检查文案。

### 11. 🟡 逻辑审查点（Review agents 重点，主会话最终验证）
- B：amendSpecific 仅单仓库；Commit&Push 与多仓库 PushDialog 协同；Reword 与 Amend 冲突场景；空 message + amend 语义。
- D：PushDialog force 灰掉逻辑、被拒重试、进度语义（复用 pulling/pulled）。
- E：破坏性操作确认、请求竞态、HEAD 高亮与搜索态共存、多仓库分支过滤缓存。
- C：受保护分支判定（当前分支名匹配）；删除当前分支禁用逻辑。

### 12. 🟢 已完成（无需重复）
- B 提交增强、C 分支管理、D 远程组件、E Log 增强、Opt-1 接线、Opt-2 设置页、Opt-3 Worktree、Opt-4 filters 补测 + Create Patch 落盘 + 分支过滤缓存 bug 修复。

## 审计新增发现（编号 13+，2026-08-14）

### 13. 🔴 `branchOps.gitDiffWithRef` payload key 不一致（运行时 bug）
- `branchOps.ts:117` 发送 `ref: ref`，Rust `git_diff_with_ref`（commands.rs:556）与 native.ts 均要求 `reference` → WorkingTreeDiffDialog 打开必失败。
- `branchOps.test.ts:155-172` 断言了错误的 `ref` key，单测无法捕获。
- 修复归入 #5 收口（改用 `native.gitDiffWithRef` 即自动消除）。

### 14. 🟡 `RepoSelector` 死导出
- `index.ts:2` 导出 `RepoSelector`，全仓库无消费方（`useRepoList` 有真实使用方，保留）。可选删除。

### 15. 🟢 死代码/调试残留核对结果
- `as unknown as`：桥接范围仅剩 `nativeGit.ts:69`（branchOps 无 cast）；其余出现处为项目既有合法用法（测试桩、terminal/ai/markdown 运行时接口宽化），不在本移植范围。
- 审计范围（source-control/git-history/App/Settings）内 `console.log`/`TODO`/`FIXME` 为零；App.tsx 的 `console.warn/error` 为错误路径日志，正常。
- Stash/Shelf/冲突解决相关残留引用：零。

## 最终验收清单

| # | 验收标准 | 状态 | 责任方 |
|---|---------|------|--------|
| 1 | `pnpm check-types` 全绿 | 🟡 待执行 | 主会话最终验证 |
| 2 | `cargo check` 通过 | 🟡 待执行（native 已落地，理论应绿） | 主会话最终验证 |
| 3 | 全量测试通过（vitest run，排除 rebased） | 🟡 待执行（source-control 34/34、git-history 96/96 此前基线） | 主会话最终验证 |
| 4 | rebased 目录排除 | 🟢 完成（.gitignore / vitest exclude / biome ignore 三处） | 已完成 |
| 5 | 桥接收口（#5） | 🟡 未执行（含 #13 修复、null 联合统一、test 断言更新） | 收口 agent / 主会话 |
| 6 | App 接线完整（index 导出 ↔ import、props ↔ 传参、SettingsTab 三方、git-history index ↔ WorkspaceSurface） | 🟢 审计逐项核对通过 | 审计（本次） |
| 7 | 文案统一（面板内无中文残留，Pull 策略全英文） | 🟢 审计核对通过 | 审计（本次） |
| 8 | 契约一致（22 项桥接核对：21 一致 / 1 不一致 = #13 gitDiffWithRef） | 🔴 1 项待修复 | 收口 agent |
| 9 | 无死代码（pushAll 旧 prop / Stash 残留 / console.log 全清） | 🟢 已达成；🟡 遗留仅 RepoSelector 死导出 + as unknown as 待收口 | 审计（本次）/ 收口 agent |
| 10 | 文档闭环（本清单刷新为当前真实状态） | 🟢 本次审计已更新 | 审计（本次） |
