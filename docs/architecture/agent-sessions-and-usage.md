# Agent 会话历史与用量

本文是 `TERAX.md` 的展开。与 `TERAX.md` 冲突时以 `TERAX.md` 为准。

两个都是"把 agent 已经知道的事情拿出来给用户看"，但取法相反：会话历史**读 agent 写下的文件**，用量**问 agent 本人**。这个差别不是风格问题，是数据在哪决定的。

## 会话历史（`src-tauri/src/modules/sessions.rs`）

顶栏右侧菜单顶部有“新对话 Claude Code”和“新对话 Codex”，会在当前命令行分别执行 `claude` / `codex`。历史区把**当前目录**下 Claude Code 与 Codex 的会话合并到同一个列表，按最后活动时间倒序；点一条会通过终端的标准提交入口执行 `claude --resume <id>` / `codex resume <id>`，而不是仅插入到块输入编辑器里。

### 为什么不驱动它们自己的 picker

两个 agent 都自带 resume 选择器（`claude --resume`、`codex resume`），但都是交互式 TUI：要拿列表就得起进程加抓屏。而它们的列表本身也是读文件来的，所以直接读同样的文件。

### 绝不整文件解析

codex 的 rollout 实测有 **91 MB**，claude 那边全部 transcript 合计 **428 MB**。而列表只要标题和时间：

- **codex** 的第一行 `session_meta` 就带 `session_id` / `cwd` / 时间戳，够了。
- **claude** 的 `ai-title`（agent 自己生成的标题）落在 19k~60k 字节处，不在开头。

所以每个文件只读 `HEAD_BYTES`（192 KB）并**丢掉末尾半行**，保证调用方只看到完整记录。刚开始的活跃会话可能还没有 `ai-title`，回落到首条真实用户输入。

### 目录归属两边不一样

- **claude** 按 `<escaped cwd>` 分目录，目录本身就完成了过滤。转义是有损的（两个路径可能撞车，非 ASCII 路径也不按朴素替换出来），所以复用 `transcript::claude_project_dir` 的兜底搜索，**不要重写这套规则**。
- **codex** 按**日期**分目录（`~/.codex/sessions/<y>/<m>/<d>/`），cwd 只能从每个文件的首行读出来再比。日期目录说的是会话何时**开始**，不是何时最后被碰过，所以排序按 mtime。

### 标题要过滤注入的前言

两边都会用一条 user 消息注入上下文。第一版跑真实数据出来是这样：

```
dc19df84 | <command-message>statusline</command-message> <command-name>
01a08ac8 | # AGENTS.md instructions for D:\project\...
```

codex 注入 `<environment_context>`，Claude Code 注入 slash 命令包装与 reminder，两边都可能以项目的指令文件开头。判据是"以 `<` 开头，或以 `# AGENTS.md` / `# CLAUDE.md` 开头"：用它们当标题比不给标题更糟。

user 的 `content` **可能是字符串也可能是块数组**（带附件时），两种都要认；只认字符串会让一部分会话显示成无标题。

头部 192 KB 内确实没有任何非样板用户消息的会话，显示"无标题会话"是诚实结果，不是 bug。

### 开销

菜单**打开时才加载**，不开零开销。一次加载是一个目录遍历加每个会话一次有界读，几百 KB 量级，与 transcript 长到多大无关。

## 用量（`src-tauri/src/modules/usage.rs`）

底栏显示订阅的 5 小时窗口与周窗口用量，全局统一，不按项目分。

### Claude Code：数字不在磁盘上

这是这个功能唯一重要的事实。限额是 Anthropic 在**每次 API 响应的 HTTP 头**里返回的，Claude Code 拿到后：

- 传给 statusLine 命令（所以自定义状态栏脚本能读到 `used_percentage` 和 `resets_at`）
- **不写进 transcript，也不写进任何其他文件**

`~/.claude` 整个搜过 `used_percentage` / `resets_at` / `utilization`，命中的只有 `settings.json` 和 `statusline-command.sh`，也就是**消费它的地方**，不是存储它的地方。`.credentials.json` 只有 `subscriptionType` 和 `rateLimitTier`，没有数字。

transcript 里记的是**花掉的 token**，那是另一个量，不是"占套餐窗口的百分之多少"，不能拿来顶替。

所以只能问 Claude Code 本人：跑 `claude -p "/usage"`。

### 由此而来的两条约束

**绝不轮询。** 查一次用量本身就要消耗一次请求，轮询等于用查询把额度烧掉。后端缓存 10 分钟（`MIN_REFETCH`），打开面板只是读缓存，只有点刷新才真的重查。首屏走 `claude_usage_cached`，不触发任何子进程。

**失败不进缓存**，否则一次网络抖动会让面板顶着同一条错误十分钟。

### 输出是给人看的，不是 JSON

```
Current session: 73% used · resets Sep 7, 4:30pm (Asia/Shanghai)
Current week (all models): 36% used · resets Sep 13, 6am (Asia/Shanghai)
```

解析只认 `Current session` / `Current week` 两个行首，宽松地抠 `N% used` 和 `resets ...`，其余一律不猜。周窗口用数组而不是单值：有些套餐会同时报 `(all models)` 和 `(Opus)` 两条。

**完整原文始终保留在 `raw` 里**，Claude Code 改文案时面板还能把权威答案原样显示出来，顺带展示它报的 "Last 24h · N requests" 这类信息。

### 命令里的引号不能省

```
claude -p "/usage"
```

`/usage` 必须带引号：Git Bash 会把裸的 `/usage` 当路径翻译成 `D:\program\Git\usage`，然后 Claude Code 会回答"这个路径不在允许的工作目录里"。第一次测就踩了这个，差点得出"这个命令拿不到数据"的错误结论。

### 复用

子进程走 `shell::build_oneshot_command`，所以超时、输出上限、隐藏控制台窗口这些与仓库现有的一次性命令执行是同一套。

### Codex：通过本机 app-server 查询

Codex CLI 提供本机 JSON-RPC app-server。Terax 只在用户打开 Codex 用量面板或点刷新时启动一个短生命周期的 `codex app-server --stdio`，先发 `initialize`，再请求 `account/rateLimits/read`。结果包含短期和长期窗口的 `usedPercent`、`resetsAt`、窗口分钟数及套餐类型；面板据此显示 5 小时和周窗口。

这不是对运行中 Codex TUI 的连接，也不读取或传出 `~/.codex` 的登录凭据。查询完成（或超时）后该 app-server 立刻结束；和 Claude 一样，成功结果在内存缓存 10 分钟、不轮询，失败不缓存。没有已登录 Codex 或本机 CLI 不支持 app-server 时，面板原样显示错误，而不拿会话 transcript 的 token 数冒充套餐额度。

## 相关

- [手机端对话视图](mobile-conversation-view.md) - `transcript` 模块读同一批文件的另一个用途
- [双进程模型与 IPC 命令参考](two-process-model.md) - `agent_sessions` / `claude_usage` 命令
