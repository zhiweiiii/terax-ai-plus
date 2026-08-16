# IDEA VCS 功能移植清单

> 来源：rebased（IntelliJ IDEA Community 源码）Git/VCS 相关模块调研
> 模块：`plugins/git4idea`、`platform/vcs-log`、`platform/diff-impl`
> 目标：移植到 Terax 的版本管理模块（source-control + git-history + diff）
>
> 价值标注：★★★★★ = 强烈建议移植；★★★★ = 建议；★★★ = 可选；★★ = 锦上添花

---

## 一、Git 插件（git4idea）— 提交 / 分支 / 远程

### 1.1 提交

| 功能 | 说明 | 入口 / 实现要点 | 价值 |
|---|---|---|---|
| 提交工具窗口 | 提交信息编辑 + 变更树 + 签核(Signed-off-by) + 作者修改 | `CheckinProject` / `GitCheckinEnvironment` | ★★★★ |
| Staging Area 提交模式 | 以 index 为中心的提交 UI，可设置开关 | `GitStageContentProvider`、`GitCommitWithStagingAreaAction` | ★★★★ |
| Amend 最近提交 | 提交窗口勾选 Amend 复用最近提交 | `GitAmendCommitService` | ★★★ |
| Amend 指定提交 | 下拉选任意历史提交 amend（amend! 提交 + 自动 squash） | `GitAmendSpecificCommitSquasher` | ★★★ |
| Commit and Push | 一键提交并推送（可配是否弹 Push 对话框） | `Git.Commit.And.Push.Executor` (Ctrl+Alt+K) | ★★★★ |
| 提交前检查 | user.name 未配置 / CRLF / 大文件 / 坏文件名 / detached HEAD / rebase 进行中警告 | `GitUserNameCheckinHandlerFactory` 等 | ★★★ |
| 跳过 hooks 提交 | 提交/推送跳过 Git hooks | `GitSkipHooksCommitHandlerFactory` | ★★ |
| GPG 签名提交 | GPG key 配置、pinentry 解锁、agent 引导 | `commit/signing` 包 | ★★ |
| 提交成功后续动作 | 提交成功通知提供 Reword 等动作 | `GitCommitSuccessNotificationRewordProvider` | ★★ |

### 1.2 分支

| 功能 | 说明 | 入口 / 实现要点 | 价值 |
|---|---|---|---|
| Branches 弹出窗 | 本地/远程/标签树形列表 + 搜索 + 按目录分组 + 最近分支 | `Git.Branches` (Ctrl+Shift+\`) / `GitBranchesTreePopupOnBackend` | ★★★★ |
| 新建分支 | 对话框含是否 checkout、是否设 tracking | `Git.CreateNewBranch` / `GitNewBranchDialog` | ★★★★ |
| Checkout 系列 | 分支/提交/标签 checkout、"checkout as new branch"、"checkout with rebase" | `GitCheckoutGroup`、`GitCheckoutWithRebaseAction` | ★★★★ |
| 重命名/删除分支 | 本地与远程分支删除 | `GitRenameBranchAction`、`GitDeleteBranchOperation` | ★★★ |
| 分支操作菜单 | 每条分支: Compare with / Diff with Local / Rebase / Merge / Update / Push / Pull(rebase|merge) / Tracked 子菜单 | `Git.Branch.Backend` 组 | ★★★★ |
| Compare Branches | 两分支对比视图（双 Log 并排） | `GitCompareBranchesUi` | ★★★ |
| Show Diff with Working Tree | 分支与工作区对比 | `Git.Ref.Diff.With.Local` | ★★★★ |
| 状态栏/工具栏分支控件 | 分支 widget + 快速操作弹出 | `GitBranchWidget`、`GitQuickActionsToolbarPopup` | ★★★ |
| 分支清理 | 查找已合并分支、清理 | `Git.Cleanup.Branches`、`GitFindMergedLocalBranches` | ★★ |
| 受保护分支 | 对受保护分支 rebase/push 警告（可同步 GitHub 规则） | `GitProtectedBranchProvider` | ★★ |
| Worktree 管理 | 工具窗口 tab：创建（新/已有分支）、打开、删除、refresh、prune | `workingTrees` 包全套 | ★★★★ |
| 多 root 支持 | 分支操作自动跨多个 Git root 执行 | `GitMultiRootBranchConfig` | ★★ |

### 1.3 远程

| 功能 | 说明 | 入口 / 实现要点 | 价值 |
|---|---|---|---|
| Fetch | 含自动 fetch 设置、并行线程 | `GitFetchSupportImpl` | ★★★ |
| Pull 对话框 | root/remote/branch 选择 + `--rebase/--ff-only/--no-ff/--squash/--no-commit/--no-verify` | `GitPullDialog`、`GitPullOption` | ★★★★ |
| Update Project | 更新方法(Merge/Rebase/Default) + fetch tags 模式 + 更新结果以提交列表展示 | `GitUpdateOptionsDialog`、`GitUpdateInfoAsLog` | ★★★ |
| Push 对话框 | 目标分支/远程选择、Define remote、Push tags(Current/All)、hook 开关 | `GitPushOptionsPanel`、`GitPushTargetPanel` | ★★★★★ |
| Force Push 引导 | 被拒时提供 force push（默认 force-with-lease） | `GitRejectedPushUpdateDialog` | ★★★★★ |
| Push Up to Commit | 从 Log 推送"直到某提交" | `Git.PushUpToCommit` | ★★★ |
| 分支级 Push/Pull | 分支弹出菜单直接 Push Branch / Pull Branch | `GitPushBranchAction`、`GitPullBranchAction` | ★★★★ |
| 远程管理 | 配置/新增远程对话框 | `Git.Configure.Remotes`、`GitDefineRemoteDialog` | ★★★ |
| Clone / Checkout from VCS | 克隆对话框（shallow、--recurse-submodules 高级项） | `Git.Clone`、`GitCheckoutProvider` | ★★★ |
| Unshallow | 补全浅克隆历史 | `Git.Unshallow` | ★★ |

### 1.4 历史 / 其他

| 功能 | 说明 | 入口 / 实现要点 | 价值 |
|---|---|---|---|
| Log 内提交编辑 + 内存交互式 rebase | Reword/Fixup/Squash/Drop/Edit，内存内执行、可回滚、可撤销 | `GitInMemoryInteractiveRebaseProcess` | ★★★★★ |
| Cherry-pick | Log 右键 cherry-pick、空提交策略、Continue/Abort | `GitCherryPicker` | ★★★★ |
| Reset / Uncommit | Soft/Mixed/Hard 对话框；Log 中软撤销 | `GitNewResetDialog`、`GitUncommitAction` | ★★★★ |
| Revert | Log 中回滚提交 | `Git.Revert.In.Log` | ★★★ |
| Tag 管理 | 创建(annotated/force)/删除/推送 tags | `GitTagDialog`、`GitPushTagsActionGroup` | ★★★ |
| .gitignore 管理 | 右键 Add to .gitignore、语法高亮/补全、info/exclude | `GitIgnoreFileActionGroup` | ★★ |
| Git Console | 命令输出控制台、日志折叠 | `GitConsoleFoldingImpl` | ★★ |
| git 可执行文件管理 | 自动探测、Windows 版本下载引导、WSL 支持 | `GitExecutableManager` | ★★ |

---

## 二、Log / Commit Graph（platform/vcs-log）

### 2.1 布局与视图

| 功能 | 说明 | 价值 |
|---|---|---|
| 三栏分屏 | 提交列表+Graph / 变更浏览器(文件树) / 详情面板，布局持久化 | ★★★ |
| 详情面板 | 作者/提交者/时间/消息/引用标签/包含分支/外部状态(CI等)，多选纵向堆叠卡片 | ★★★★ |
| 内嵌 Diff 预览 | 随提交选择联动更新 | ★★★ |
| 多 Tab | 第二个 Log Tab 带不同过滤器组合 | ★★ |

### 2.2 过滤体系（Log 核心）

| 功能 | 说明 | 价值 |
|---|---|---|
| 分支过滤 | 弹窗列出全部分支，收藏/最近分组、多值、星标 | ★★★★★ |
| 范围过滤 `A..B` | 比较两个分支/提交间提交 | ★★★★ |
| Hash 过滤 | 输入完整 hash 定位提交 | ★★★ |
| 用户过滤 | 按作者，含 "me" 快捷项 | ★★★★ |
| 日期过滤 | Last 24 hours / Last 7 days / 自定义 | ★★★★ |
| 文本过滤 | 匹配消息或 hash，正则开关 + 大小写开关 + 搜索历史记忆 (Ctrl+L) | ★★★★★ |
| 合并提交过滤 | "No Merges" 开关 | ★★★ |
| 仓库过滤 | Roots 列点击筛选 | ★★★ |
| 图选项 | 排序(拓扑/日期)、Linearize Merges、First Parent、折叠/展开线性分支与合并提交、Long Edges | ★★★ |

### 2.3 提交操作（右键菜单）

| 功能 | 说明 | 价值 |
|---|---|---|
| Copy hash | 复制提交号 | ★★★ |
| Create Patch | 导出为 patch 文件/剪贴板 | ★★★ |
| Compare Versions | 比较选中两提交 | ★★★★ |
| Diff with Local | 与工作区比较 | ★★★★ |
| Checkout / Reset / Revert / Uncommit / Reword / Fixup / Squash / Drop / Interactive Rebase / Push Up to Commit / New Branch / Create Tag | git4idea 注册进 Log 菜单 | ★★★★★ |

### 2.4 分支显示与高亮

| 功能 | 说明 | 价值 |
|---|---|---|
| 引用标签渲染 | 提交行彩色分支/标签标签，Compact/ShowTagNames/Align 选项 | ★★★ |
| 当前分支高亮 | 特殊背景色 | ★★★ |
| My Commits / 合并提交 / cherry-picked 高亮 | 类型化高亮 | ★★★ |
| Detached HEAD 警告 / WIP 标签 | 提示风险 | ★★★ |
| 提交 tooltip | 悬停显示概要 | ★★ |

---

## 三、Diff（platform/diff-impl）

### 3.1 Diff 查看器

| 功能 | 说明 | 价值 |
|---|---|---|
| Side-by-side / Unified / 3-way 文本 diff | 三种查看器 + 顶栏切换器 | ★★★★ |
| All-in-One Diff | 所有变更文件纵向合一个视图 + 视图内搜索 | ★★★ |
| 单栏 diff | 空内容 vs 新文件 | ★★ |

### 3.2 差异导航

| 功能 | 说明 | 价值 |
|---|---|---|
| 下一处/上一处差异 | F7 / Shift+F7 | ★★★★ |
| 下一个/上一个文件 | Alt+Shift+→/← | ★★★ |
| gutter 差异标记 | 增/删/改/冲突四色 + stripe 标记 | ★★★★ |
| 分隔条差异连线 | 可点击选中对应变更 | ★★ |
| 状态栏计数 | "N differences, M inactive" | ★★★ |
| 初始滚动策略 | 按上下文/首个变更/上次位置定位 | ★★ |

### 3.3 显示选项

| 功能 | 说明 | 价值 |
|---|---|---|
| 忽略策略 | None/Trim whitespaces/Ignore whitespaces/Ignore whitespaces and empty lines/Ignore formatting | ★★★★ |
| 高亮策略 | Lines / Words / Split changes / Characters / None | ★★★★ |
| 词级内联高亮 | 变更行内二级分片 | ★★★ |
| 折叠未变更区域 | 上下文 1/2/4/8 行或全折叠 | ★★★★ |
| 同步滚动 / 逐块对齐 | 联动滚动 | ★★★★ |
| 行号 / 空白显示 / 软换行 | 外观设置 | ★★ |

---

## 四、移植优先级建议（针对 Terax）

**第一阶段（★★★★★，核心体验）**
1. **Push 对话框**：目标分支/远程选择 + Push tags 模式 + force-with-lease + 被拒后"Pull / Force Push"引导
2. **提交图过滤体系**：文本过滤（正则+大小写+历史）、分支过滤、用户/日期过滤、No Merges
3. **Diff 查看器增强**：查看器切换（Side-by-side/Unified）+ 忽略/高亮策略开关 + 折叠未变更区域 + 差异导航（F7/Shift+F7）

**第二阶段（★★★★）**
4. **Log 内提交操作**：Reword / Fixup / Squash / Drop / Cherry-pick / Reset(Soft/Mixed/Hard) / Revert / Copy hash / Create Patch
5. **分支操作菜单**：Compare with / Diff with Local / Merge / Rebase / Update / Pull 策略选项

**第三阶段（★★★，可选）**
6. **Worktree 管理器**、**提交前检查**（CRLF/大文件/detached）、**Amend/Commit and Push**
