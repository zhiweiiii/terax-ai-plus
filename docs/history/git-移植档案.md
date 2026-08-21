# Git 版本管理移植档案

Terax 的版本管理功能来自 2026 年 8 月对 IntelliJ IDEA Community 源码（`plugins/git4idea`、`platform/vcs-log`、`platform/diff-impl`）的一次调研与移植。

本文是那批工作的**留存记录**：保留当时做出的设计决策、踩过的坑、以及有意接受的取舍。当时按 agent 分工的进度表、验收清单已经删除，它们描述的是过程而不是结论。

**这不是当前架构文档。** 以 `TERAX.md`、`docs/architecture/`、`docs/issues.md` 为准。

## 落地形态

Rust 侧在 `src-tauri/src/modules/git/` 提供全部 git 命令（提交、分支、远程、日志、diff、worktree），全部经工作区授权表把关。前端 `src/modules/source-control/`（面板与对话框）与 `src/modules/git-history/`（提交图）消费它们，`src/lib/native.ts` 是唯一的绑定层。

## 保留下来的设计决策

**checkout 远程分支不落到 detached HEAD。** `git checkout origin/x` 会进入分离头指针状态，而用户在 UI 里点一个远程分支想要的是"在这条分支上工作"。所以 `operations.rs` 的 `checkout_branch` 先判断这是不是远程跟踪引用：已存在同名本地分支且用户没改名，就直切本地；否则 `checkout -b <local> --track <remote>`。本地名可由调用方覆盖。

**同名的远程分支不过滤掉，改为打标记。** 早期实现里 `list_branches` 把"已有同名本地分支"的远程分支从列表中删掉，于是列表会随本地状态忽隐忽现。现在两组恒定存在，远程项带 `has_local` 标记，UI 据此决定点击行为。

**文件历史走 `git log --follow`**，否则重命名之前的提交全部看不到。代价是重命名那一次提交的旧路径 diff 可能为空，接受。

**桥接层只做委托。** `branchOps.ts` 是薄薄一层转发到 `native.ts`，不再自己拼 payload。当初两边各拼一次的直接后果是 `gitDiffWithRef` 发的 key 是 `ref` 而 Rust 要的是 `reference`，对话框一打开必失败；而单测断言的是错误的那个 key，于是测试全绿、功能全坏。**跨 IPC 的参数名只允许有一处定义。**

## 有意砍掉的功能

- **GPG 签名提交 / 跳过 hooks**：使用场景太少，UI、偏好项、设置页全部移除。Rust 命令保留，未接线。
- **Pull 策略对话框**：只保留 merge 与 fast-forward，`PullStrategyDialog` 删除。
- **提交图右键菜单里的 reword / fixup / squash / drop / create patch / push-up-to**：交互复杂度与使用频率不成比例。

## 已知取舍（仍然成立）

- 多仓库 Pull 是顺序遍历加一条聚合 toast，没有逐仓库进度列表。
- 文件历史对话框固定取 50 条，不分页。
- 分支选择器弹层固定 `h-80`，窗口高度低于 380px 时可能溢出。
- 二级菜单在滚动时锚点不跟随（Radix 不监听滚动），hover 场景下可接受。

## 踩过的坑

- **把第三方源码快照放在项目根下**（当时约 900MB 的 `rebased/`）会让 vite 启动挂起：ready 之后 HTTP 不响应，窗口因为前端 `show()` 没执行而始终不显示。`watch.ignored` 不够，依赖优化器仍会全量扫描。结论是这类目录不能待在项目根里。
- **运行中的实例会锁定 exe**（os error 5），编译前必须先关掉。dev 和 release 同名 `terax-prod`，所以两者互相锁。

## 还没移植的（备选清单）

从 IDEA 那边调研出来、评估为有价值但至今没做的：

- **Diff 查看器增强**：Side-by-side / Unified 切换、忽略空白策略、词级内联高亮、差异导航（下一处/上一处）。
- **提交图过滤体系的剩余部分**：过滤历史记录、用户维度的持久化。
- **Staging Area 提交模式**：以 index 为中心的提交 UI。
- **分支清理**：找出已合并的本地分支并批量删除。
- **Unshallow**：补全浅克隆的历史。
