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

- **claude** 按 `<escaped cwd>` 分目录，但转义有损（两个路径可能撞车，非 ASCII 路径也不按朴素替换出来），同一目录不能视为同一项目。复用 `transcript::claude_project_dir` 定位目录后，还要逐文件核对记录中的 cwd；没有可核对 cwd 的文件不进列表。过滤发生在每个 agent 的 40 条上限之前。
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

菜单**打开时才加载**，不开零开销。异步读取结果绑定 cwd 和菜单打开代次；切换项目或重新打开菜单时，旧结果不显示，过期请求不会覆盖新列表。目录扫描结果缓存 2 秒，最多 32 个目录；头部缓存最多 512 个文件，重复打开只检查状态。文件增长但已经读满 192 KB 时复用头部，截断或同长度重写重新读取。目录归属仍逐文件校验，缓存不跳过校验。手机运行中记录绑定复用这套索引，但不把“目录最新文件”当成当前会话。

## 用量（`src-tauri/src/modules/usage.rs`）

底栏显示订阅的 5 小时窗口与周窗口用量，全局统一，不按项目分。

### Claude Code：数字不在磁盘上

这是这个功能唯一重要的事实。限额是 Anthropic 在**每次 API 响应的 HTTP 头**里返回的，Claude Code 拿到后：

- 传给 statusLine 命令（所以自定义状态栏脚本能读到 `used_percentage` 和 `resets_at`）
- **不写进 transcript，也不写进任何其他文件**

`~/.claude` 整个搜过 `used_percentage` / `resets_at` / `utilization`，命中的只有 `settings.json` 和 `statusline-command.sh`，也就是**消费它的地方**，不是存储它的地方。`.credentials.json` 只有 `subscriptionType` 和 `rateLimitTier`，没有数字。

transcript 里记的是**花掉的 token**，那是另一个量，不是"占套餐窗口的百分之多少"，不能拿来顶替。

所以只能问 Claude Code 本人：跑 `claude -p "/usage"`。

### 自动更新与缓存

底栏挂载先读取两种 CLI 的缓存，然后自动查询；面板关闭时也每 5 分钟更新一次。定时查询强制重读，手动刷新保留，打开面板使用普通查询复用 5 分钟缓存。同窗口共用在途 Promise，避免自动/手动查询或组件重新挂载时重复启动探针；每个挂载有独立请求代次，卸载释放计时器，旧缓存和旧查询不回填新状态。

**失败不进后端缓存**。前端保留上次结果和成功时间，明确标记更新失败；详情展示错误，自动查询失败不反复弹通知，手动刷新失败才提示。CLI 缺失或未登录不显示伪造的 0%。移除旧实现未经验证的“查询必然消耗额度”提示，本项目不自行保证 CLI 或服务端的计费策略。

常驻信息分 Claude/Codex 两行，格式为 `5h 73%（重置时间）- 周 36%（重置时间）`。Claude 优先整体 all models 周窗口，已识别的本地日期格式精简为月日时分，未知自然语言或其他时区保持原文，完整 CLI 文本可悬停及在详情查看。Codex 按 300/10080 分钟匹配 5h/周窗口，按本地时区显示月日时分；不把其他时长误标成 5h/周。缺失值显示 `--`。窄窗口底栏允许换行。

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

Codex CLI 提供本机 JSON-RPC app-server。Terax 在首次自动查询、每 5 分钟更新或用户刷新时启动一个短生命周期的 `codex app-server --stdio`，先发 `initialize`，再请求 `account/rateLimits/read`。结果包含短期和长期窗口的 `usedPercent`、`resetsAt`、窗口分钟数及套餐类型；面板据此显示实际窗口。

这不是对运行中 Codex TUI 的连接，也不读取或传出 `~/.codex` 的登录凭据。查询完成（或超时）后该 app-server 立刻结束；和 Claude 一样，成功结果在内存缓存 5 分钟，失败不缓存。没有已登录 Codex 或本机 CLI 不支持 app-server 时，面板原样显示错误，而不拿会话 transcript 的 token 数冒充套餐额度。

### 运行环境边界

历史菜单的异步结果同时绑定 cwd、工作区环境和打开代次，失败可重试，不把读取失败显示成空历史。当前读取器只访问 Windows 用户目录，不读取 WSL 用户目录；WSL 中保留新建对话命令，历史区明确提示使用对应 CLI 的 resume，前后端均不拿本机历史填充 WSL 项目。

目录枚举使用显式栈，扫描限制 32768 个项、8192 个 JSONL 文件、8 层，并在每个项检查 2 秒期限。超限或 IO 异常返回错误，不用部分候选列表推断唯一会话；结果和错误均缓存 2 秒。恢复文件解析核对 cwd/session ID，发现第二个候选立即拒绝绑定。Claude 项目目录的回退查找另有共享项数/时间预算。

## 相关

- [手机端对话视图](mobile-conversation-view.md) - `transcript` 模块读同一批文件的另一个用途
- [双进程模型与 IPC 命令参考](two-process-model.md) - `agent_sessions` / `claude_usage` 命令
