# TERAX.md

Terax 会把工作区根目录下的 `TERAX.md` 作为 agent 记忆加载（类似 AGENTS.md / CLAUDE.md）。这份文件同时是项目的活架构文档，动手之前先读它。

## 项目

**Terax**：轻量、终端优先的开发工作区。后端 Tauri 2 + Rust（`portable-pty`），客户端 React 19 + TypeScript + xterm.js（WebGL）。一个原生 PTY 终端，外加代码编辑器、文件资源管理器、带提交图的版本管理、网页预览，以及一个把同一批 PTY 会话共享给手机浏览器的内嵌 web 桥接。

- Bundle id：`app.crynta.terax`
- 包管理器：**pnpm**
- 平台：**仅 Windows**（macOS / Linux 支持已移除）
- 主二进制：`terax-prod`（dev 与 release 同名，热部署和打包脚本都引用它）
- 前端检查：`pnpm lint`、`pnpm check-types`
- Rust 检查：`cd src-tauri && cargo clippy --all-targets --locked -- -D warnings`（测试已移除）
- 测试策略：仓库不保留自动化或端到端测试及其专用依赖；改动通过静态检查和与变更相关的手工验证确认。

## 质量线

达不到生产级就不发。每一处改动都用下面全部条目衡量，而不只是"能跑"：

- **正确性**：边界情况、失败路径、并发访问。不接受"暂时能用"。
- **性能**：极致轻量就是产品本身。约 7-8 MB 的包，高性能终端。每一处改动都要问：多花多少内存、有没有增加 IPC 往返或重复请求、会不会触发额外重渲染或无用功、是否拉进一个重依赖。没用到的功能必须零开销。
- **安全**：不留严重漏洞。每个边界都校验输入（IPC、文件系统、网络、web 终端面）。web 终端桥接本质是远程 shell，必须有密码把关，绝不敞开。
- **UI/UX**：精致、专业、有质感。每个状态和细节都要想过。
- **架构**：新增或改动的逻辑放在纯函数、少依赖的地方（函数式内核）；Tauri 命令和 React 组件保持薄（命令式外壳）。

声称做完之前先验证：前端跑 `pnpm lint` + `pnpm check-types`，Rust 跑 `cargo clippy --all-targets --locked -- -D warnings`。

## 约定

- **注释**：默认不写，代码要能自己说清楚。确实需要时写 1-2 行解释**为什么**，绝不写**是什么**。不要 AI 味的填充话。代码与注释一律英文。
- **任何地方都不用 em-dash**：代码、注释、提交信息、文档。
- **任何地方都不用 emoji。**
- **导入**：前端一律 `@/...`，跨模块绝不用相对路径。
- **只用 pnpm**，绝不 npm / npx / yarn。

## 架构

### 双进程模型

**Rust（`src-tauri/`）掌管全部系统访问。** webview 从不直接碰文件系统、进程或 shell，一切都通过 `invoke()` 调用注册在 `src-tauri/src/lib.rs` 的命令：

- `pty::pty_*` - 长生命周期的交互式 PTY 会话（xterm + portable-pty），由 `PtyState`（`RwLock<HashMap<id, Session>>`）管理。输出通过回调流向前端接好的 Tauri `Channel`；web 桥接订阅同一批会话。
- `fs::tree::*`（`fs_read_dir`、`list_subdirs`）、`fs::file::*`（`fs_read_file`、`fs_write_file`、`fs_stat`、`fs_canonicalize`）、`fs::mutate::*`（`fs_create_file`、`fs_create_dir`、`fs_rename`、`fs_delete`）：资源管理器与编辑器的 IO。
- `fs::search::*`（`fs_search`）、`fs::grep::*`（`fs_grep_interactive`）：模糊文件查找与内容搜索（基于 `ignore` + `grep-*` crate）。
- `git::commands::*`：完整的版本管理面（status / diff / stage / commit / fetch / pull / push / log / show 等），全部经工作区授权表把关。
- `transcript::*`：编码 agent 究竟说了什么，读自 agent 自己的记录而不是从屏幕上解析。Claude Code 读 `~/.claude/projects/<转义cwd>/<session>.jsonl`，Codex 读 `~/.codex/sessions/<year>/<month>/<day>/rollout-*.jsonl`，opencode 读 `~/.local/share/opencode/opencode.db`（SQLite，只读）。归一成同一结构后经 web 桥接推给手机。`rusqlite`（bundled）只为这一件事存在。详见 `docs/architecture/web-terminal-bridge.md`。
- `shell::shell_run_command`：一次性子 shell 执行（worktree 功能用），与 PTY 会话无关，不是用户的交互终端。Windows 上走 PowerShell（`-NoProfile -Command`）。
- `workspace::*`：`workspace_authorize` / `workspace_current_dir`（启动与 git 的 cwd 授权表），外加 WSL 桥（`wsl_list_distros`、`wsl_default_distro`、`wsl_home`）。
- `lsp::*`：语言服务器进程宿主。一根笨的 JSON-RPC 管道：Content-Length 分帧与进程生命周期在 Rust（`lsp/framing.rs`），协议智能在前端。启动 cwd 经授权表把关；服务器跑在自己的进程组里并整组杀掉，Windows 子进程带 `proc::job::ProcessJob`。`RunEvent::Exit` 时全部杀掉。
- `gateway::gateway_status` / `gateway_set_config`：Claude Code 的本地供应商网关，见下。
- `sessions::agent_sessions`：某个目录下 Claude Code 与 Codex 的历史会话列表，供顶栏的会话历史菜单一键恢复，见下。
- `web::*`（`web::start`、`web::stop`、`web::web_status`、`web_set_password`、`web_has_custom_password`、`web_snapshot_reply`）：内嵌 HTTP + WebSocket 服务，见下。
- `open_settings_window`：设置的独立 webview 窗口（可选 `tab` 参数深链到某一节）。

### Web 终端桥接（`src-tauri/src/modules/web/`）

内嵌在桌面应用里的 HTTP + WebSocket 服务，把同一批 PTY 会话暴露给手机。完整说明见 `docs/architecture/web-terminal-bridge.md` 与 `docs/architecture/mobile-conversation-view.md`。要点：

- **端口**：dev 绑 `34269`，release 绑 `34268`（`cfg!(debug_assertions)`），两者可并存。
- **页面**：`GET /` 返回构建期内嵌的单文件手机页。它是**对话视图，不是终端**：桌面 138-192 列的网格塞进约 335px 视口，要么 3px 字号要么左右拖动，所以干脆不渲染网格。一个无头 xterm（从不 `open()`，不加载渲染器）按 PTY 网格解析字节流，逻辑行读回来后按手机宽度重新折行成气泡。`scripts/build-web.mjs` 跑独立的 vite 构建并把结果内联进 `src-tauri/web.html`，由 Rust `include_str!` 嵌入；桌面构建脚本会自动先跑它。
- **认证**：没有 `terax_web` cookie 时 `GET /` 返回密码登录页；`POST /auth`（密码在请求体，绝不放查询串）用 **Argon2id** 校验，限速（连续 5 次失败锁定 5 秒），成功后下发 `Max-Age=604800` 的 cookie。WebSocket 升级同样校验，未认证返回 403。凭据存在 `%LOCALAPPDATA%/terax/web-auth.json`，**改密码会轮换会话令牌**，否则旧 cookie 照样能进。页面 bundle 里没有任何凭据。
- **状态指示**：状态栏右下角通过 `web_status` 显示监听状态、实时连接数、连续登录失败数（每 2 秒轮询同一批原子量）。
- **共享 PTY**：web 观看者订阅与桌面相同的 `Arc<Session>`，两端输入输出一致。**Rust 侧不存储任何会话输出**：手机连上时看到的首屏是**桌面终端自己的缓冲区**，经 `terax:web-snapshot` / `web_snapshot_reply` 现向窗口索取。以前那个 256 KiB 历史环已删除，第二份副本必然和桌面显示的内容分叉。
- **一个会话一个网格，谁在打字谁拥有它**（`SizeOwner` / `claim` / `request_grid`）。手机不声明网格所以永不 claim，从手机打字不会让桌面屏幕重排。桌面只在真实按键时收回所有权，xterm 的协议应答（焦点上报、OSC 4 回复）刻意不 claim。
- **手机发送键是提交，不是换行**：输入区通过带请求编号的 WebSocket JSON `submit` 指令提交整段文本，服务端对正在运行的 Codex 使用明确的 bracketed paste 边界，再发送回车，避开 Codex 把快速输入加回车识别为多行粘贴的时序窗口；其他终端保持普通文本加回车。空输入只发回车。非空消息等待 `writeAck` 后才清空；失败、断线和超时保留内容，相同消息重试复用编号，服务端在同一 PTY 内缓存最近 128 个提交结果。
- **Agent transcript**：附着的会话里跑着编码 agent 时，服务端推 `{type:"transcript"}`，内容读自 agent 自己的记录。手机据此渲染对话，屏幕解析只保留一件 transcript 不可能知道的事：**程序此刻在等你选什么**。三道闸门让空闲会话零开销：必须真有 agent 在跑（`Session::web_agent`，由 OSC 检测喂）、绑定文件的状态必须变过、revision 必须变过。Claude/Codex 的恢复命令优先按会话 ID 固定文件，新会话只绑定启动后唯一候选且逐文件核对 cwd，多候选时不猜，退回屏幕视图。JSONL 以偏移量增量解析，每种读取器缓存 8 个文件、最多保留最近 600 个原始步骤，多个手机连接复用解析结果；revision 使用读取代次，工具结果不依赖时间戳去重。700ms 轮询而不是监听，因为 opencode 的提交落在 WAL 里，没有文件系统事件能描述它。
- **标签同步**：`App.tsx` 的 `useWebTerminalSync` 把每个桌面终端标签同步给 Rust（`web_sync_tabs`），所以手机能列出全部命令行而不只是有活 PTY 的。手机连一个还没起 pty 的标签时，服务端发 `terax:web-activate`，前端激活该标签，手机收到 `opening` 后重试。
- **手机布局与更新**：主缓冲区中的 Codex 与全屏缓冲区中的 Claude Code 都解析实时菜单、状态和正在输出的正文；桥接在附着时及运行程序变化时声明 `agent`。消息按完整内容比较并就地更新 DOM，保留思考/工具展开和内部滚动；用户消息原样显示，助手 Markdown 使用已有依赖链中的 mdast/GFM 解析后安全构造 DOM，不执行 HTML、不加载远程图片。输入区面板可独立滚动，应用跟随 visual viewport 的尺寸和偏移，发送按钮提交、键盘回车换行、Ctrl/Cmd+Enter 提交。工具预览最多 40 行/4096 字节，可展开和复制，超限明确说明；定时任务等待保存确认后才清空草稿。

### Claude 网关（`src-tauri/src/modules/gateway/`）

回环上的一个 Anthropic Messages 端点，让 Claude Code 用上只卖 OpenAI 格式接口的中转站。完整说明见 `docs/architecture/claude-gateway.md`。Claude Code 只会说 Anthropic Messages，而多数中转站（含 OpenCode Zen 的 `/zen/go/v1`）只提供 OpenAI Chat Completions，网关把请求转出去、把响应连同 SSE 转回来，于是换供应商变成菜单里点一下。要点：

- **端口**：dev 绑 `34267`，release 绑 `34266`，与 web 桥接的 34268/34269 错开，两者可并存。
- **只绑 `127.0.0.1`，绝不 `0.0.0.0`**。它转发的是用户付费的凭据，LAN 监听等于把订阅交给网内任何人。入站还要校验网关令牌（`x-api-key` 或 Bearer 都收），令牌存在 `%LOCALAPPDATA%/terax/gateway-token`，跨重启不变，否则每次重启都会悄悄弄坏所有已配置的命令行。
- **按命令行隔离**：供应商 id 钉在 URL 路径里（`/p/<id>/v1/messages`），不是取全局选择。`$env:` 本来就只作用于一个 shell，但如果网关按全局 `current` 路由，在终端 B 切一下就会把终端 A 里**已经在跑**的 Claude Code 悄悄改道，env 的隔离就是假的。前端按 leafId 记住每个命令行钉住的是谁（leafId 由只增不复用的计数器发放，所以映射不会张冠李戴）。没有前缀的请求才回落到全局选择，留给手工配置的端点。钉住的供应商被删掉时返回 503，绝不静默改用当前选中的那个去花钱。
- **默认不启动**：开应用不路由任何东西、不 bind 任何端口。端口只在 `shell_env` 里开，也就是某个真要用它的 shell 正在 spawn 的时候；`gateway_set_config` 只存配置，不起监听。pin 是刻意不持久化、也刻意不从"当前供应商"继承的：继承意味着开个应用就悄悄起监听、并把每个新 shell 指向一个付费端点。tokio runtime 与 reqwest client 同样是 `OnceLock`，第一次真正转发时才创建。
- **不新增依赖**：`tauri-plugin-updater` 已经把 reqwest（含 `stream` feature）、rustls、hyper、tokio 的 net 拉进依赖树，网关只是声明已经链接进来的东西。服务端沿用 web 桥接同款的阻塞 accept 循环加一线程一连接，不引入 axum。
- **reqwest 有两个会 panic 的坑**，都已处理：它编译时不带 crypto provider（更新插件选了 `rustls-no-provider`），而插件只在检查更新时才惰性安装，所以 `upstream.rs` 自己装 ring provider；另外 `RequestBuilder::send()` 在**被调用时**就注册超时定时器，必须在 runtime 上下文里调用，不能作为 `block_on` 的实参在外面求值。
- **转换层是纯函数**（`convert.rs` / `stream.rs` / `sse.rs`），不认识 Provider、不碰 IO，可直接单测。SSE 走推送式状态机而不是 Stream 组合子，因为连接线程本来就是同步读写。跨 chunk 被切成两半的多字节字符由 `sse::append_utf8` 兜住。
- **按角色路由模型**：Claude Code 发的是 `claude-sonnet-4-5-20250929` 这类带日期的全名，按 opus / sonnet / haiku 关键词归档映射到中转站真实模型，所以切换时**清掉** `ANTHROPIC_MODEL` 而不是设置它，否则所有档位会被钉死在同一个模型上。`[1m]` 是客户端侧的上下文声明，上游会拒收，路由前剥掉。
- **协议上的硬约束**：Anthropic 每条消息流只允许一个 `message_delta`，而部分中转站会连发多个带 `finish_reason` 的 chunk，重复发会让 Claude Code 直接断开。转换器只认第一个，并把它压到 `[DONE]` 才发出，这样 usage 是最终值。上游报错时只发 `error` 事件、不补成功收尾，绝不把失败伪装成正常完成。
- **供应商的怪癖按 host 判**：OpenCode Zen 的 Go 计划缺 `x-opencode-session` 会直接 400（"cannot be routed efficiently"），它靠这个把一轮对话固定在同一后端。会话 id 从 Claude Code 的 `metadata.user_id`（形如 `..._session_<uuid>`）里挖，取不到时回落到一个进程内固定值，每次请求换一个新的会正好毁掉这个头存在的意义。另外测试探针发 `max_tokens: 16` 而不是 1，有中转站校验 `max_tokens > 2`，用 1 会把好的供应商测成坏的。
- **配置由前端持有**：`claudeGateway` 存在 tauri-plugin-store 里，`gateway_set_config` 把同一份推给 Rust，Rust 侧只有这一处状态。

### Claude Code 与 Codex 用量（`src-tauri/src/modules/usage.rs`）

底栏显示订阅的 5 小时窗口与周窗口用量。完整说明见 `docs/architecture/agent-sessions-and-usage.md`。数据靠跑 `claude -p "/usage"` 拿，因为**它不在磁盘上**：限额是 API 响应头带回来的，Claude Code 只把它转给 statusLine 命令，`~/.claude` 下没有任何文件存它。transcript 里记的是花掉的 token，那是另一个量，不是"占套餐窗口的百分之多少"。要点：

- 底栏挂载后先读缓存并自动查询，面板关闭也每 5 分钟更新一次，手动刷新保留；成功结果缓存 5 分钟（`MIN_REFETCH`）。自动定时查询强制重读，避免缓存使更新延迟到下一轮。同窗口在途查询合并，卸载释放计时器并拒绝旧回复。
- **失败不进缓存**。前端保留上次结果及成功时间，并标记更新失败；自动失败不弹 toast，详情可查看错误，手动失败提示。
- **输出是给人看的自然语言，不是 JSON**。解析只认 `Current session` / `Current week` 两个行首，宽松地抠 `N% used` 和 `resets ...`，其余一律不猜；完整原文始终保留在 `raw` 里，Claude Code 改文案时面板还能把权威答案原样显示出来。
- 命令写成 `claude -p "/usage"`，`/usage` 必须带引号：Git Bash 会把裸的 `/usage` 当路径翻译成 `D:\program\Git\usage`，这个坑会让人误以为该功能不存在。
- Codex 则启动一次短生命周期的本机 `codex app-server --stdio`，初始化后请求 `account/rateLimits/read`，读取它返回的短期/长期窗口、重置时间和套餐类型；不读 `~/.codex` 的凭据，也不连接或干预正在运行的 Codex TUI。它与 Claude 同步每 5 分钟更新，成功结果缓存 5 分钟。
- 常驻信息按 Claude/Codex 两行显示 `5h 用量（重置时间）- 周用量（重置时间）`。Codex 按实际窗口时长匹配 300/10080 分钟，未知时长不冒充 5h/周；时间戳转换为本地月日时分。Claude 周用量优先 all models，识别到本地时区的日期格式时精简为月日时分，未知格式或其他时区保留原文；悬停与详情保留完整 CLI 文本。未知数据使用 `--`，不显示伪造的 0%；窄窗口底栏可换行。

### 会话历史（`src-tauri/src/modules/sessions.rs`）

定时消息由 `schedule.rs` 管理，底栏 `ScheduleButton` 支持终端、Codex 后台、Claude Code 后台三种模式和多个单次/每日任务。后台模式不用 PTY 或用户工作目录，经 stdin 调用本机 CLI，限制并发、超时和输出大小。任务由 `schedule/storage.rs` 原子保存到 app-local-data 的 `schedules.json`（开发版隔离），后台任务重启恢复；终端任务重启后暂停等待重新绑定。中断且结果未知的请求不自动重发，存储异常暂停调度。详见 `docs/architecture/scheduled-messages.md`。

完整说明见 `docs/architecture/agent-sessions-and-usage.md`。顶栏右侧的菜单顶部可直接新开 Claude Code 或 Codex；其下把当前目录下两者的历史会话合并为一个列表，按最后活动时间倒序，点一条就把 `claude --resume <id>` / `codex resume <id>` 送进当前命令行执行。要点：

- **读文件，不驱动它们自己的 picker**。两个 agent 都自带 resume 选择器，但都是交互式 TUI，要拿列表就得起进程加抓屏；它们的列表本身也是读文件来的，所以直接读同样的文件。
- **绝不整文件解析**。codex 的 rollout 实测有 **91 MB**，而列表只要标题和时间：codex 的第一行 `session_meta` 就带 `session_id` / `cwd` / 时间戳，Claude 的 `ai-title` 落在 19k~60k 字节处，所以每个文件只读 `HEAD_BYTES`（192 KB）且丢掉末尾半行。
- **目录归属两边不一样**。Claude 按 `<escaped cwd>` 分目录，但转义有损，目录内可能混有不同 cwd 的会话，必须逐文件核对记录中的 cwd（同时复用 `transcript::claude_project_dir` 定位目录）；Codex 按**日期**分目录，cwd 从每个文件的首行读出来再比。
- **标题要过滤注入的前言**。两边都用一条 user 消息注入上下文（codex 是 `<environment_context>`，Claude 是 slash 命令包装与 reminder），还可能以 `# AGENTS.md` 开头。判据是"以 `<` 开头或是这两个标题"，用它们当标题比不给标题更糟。user 的 content 可能是字符串也可能是块数组（带附件时），两种都要认。
- 历史目录扫描缓存 2 秒（最多 32 个目录），头部缓存最多 512 个文件，文件状态变化才刷新；菜单**打开时才加载**，不开就零开销；异步结果必须和当前 cwd、打开代次一致，切换项目不能显示旧列表。
- 历史菜单还绑定工作区环境。当前读取器只访问 Windows 用户记录，WSL 不回退到本机历史，明确提示 CLI resume；新建对话仍可在 WSL 使用。窗口状态查询按请求代次应用，卸载后晚到的监听注册立即释放，窗口操作错误被观察。

### PTY shell 集成

Codex 交互界面直接由 xterm 渲染。不要劫持 xterm 的光标可见状态、textarea 定位或输入法组合元素；之前的私有接口适配在用户环境出现输入卡顿和画面延迟刷新。终端仍通过 PTY 原样转发 Codex 的转义序列与键盘输入。`inputPolicy.ts` 统一决定 shell 输入栏、终端或无输入三种归属；前台任务异步检查绑定命令代次，新命令会作废旧结果。可选诊断默认关闭，只记录输出字节数、公开光标坐标、渲染、尺寸、焦点与输入法事件，最多 256 项，不记录正文或输入内容。详见 `docs/architecture/reliability-and-releases.md`。

PTY shell 通过注入的初始化脚本启动，细节见 `docs/architecture/pty-shell-integration.md`。

- **Windows**（`profile.ps1`）：以 `pwsh -NoLogo -NoExit -ExecutionPolicy Bypass -File <path>` 传入。它在用户的 `$PROFILE` 跑完之后包住其 `prompt` 函数，让它发出 OSC 7 + OSC 133 A/B/D。shell 优先级 `pwsh.exe`（PS 7+）-> `powershell.exe`（PS 5.1）-> `cmd.exe`（无集成）。
- **PATH 命中项必须是非零长度的文件**（`is_real_executable`）。微软商店的应用执行别名是 0 字节重解析点，Explorer 会替你解析而 `CreateProcessW` 不会，而它在从 Explorer 继承的 PATH 里排在真正的 PowerShell 7 前面。打包版因此启动了它，每个终端打开即死。
- cwd 传给 ConPTY 之前必须规范成反斜杠（`CreateProcessW` 遇正斜杠会出问题）。
- ConPTY 要求 `session.rs` 里的 `CONPTY_LIFECYCLE_LOCK` 包住 `openpty + spawn_command`。并发启动会让其中一个 PTY 的输出管道停摆。**不验证"快速狂开标签页时首个标签是否稳定"就不要移除这把锁。**
- 每个 ConPTY 子进程都进一个带 `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` 的 Job Object（`modules/proc/job.rs`）。Job 句柄一落地（正常退出、panic、甚至 Terax 被强杀），内核就会杀掉这个 shell 的全部后代。没有它 Windows 会把整棵子进程树变孤儿，因为 `TerminateProcess` 只杀直接子进程。
- 编码 agent 检测在 Rust 侧（`pty/agent_detect.rs`）跑在 reader 的字节过滤器上，发出 `terax:agent-signal` 状态转换，**只由 OSC 序列驱动**（绝不看原始输出，所以不断重绘的 TUI 不会让状态来回跳），没有 agent 时零开销。前端 store 在 `terminal/lib/agentActivity.ts`，`App.tsx` 的 `findClaudeLeaf` 据此把"发送到 Claude Code"路由到正在跑 agent 的面板。

### 前端（`src/`）

单窗口 React 应用，路径别名 `@/*` -> `src/*`。标签是一个带 tag 的联合类型（`kind`：`terminal` | `editor` | `preview` | `markdown` | `git-diff` | `git-history` | `git-commit-file`），切换时**不卸载**，而是靠 `invisible pointer-events-none` 隐藏，这样 PTY 和开发服务器在后台继续输出。

`App.tsx` 只负责把各模块接起来，保持它是协调者。新功能放进对应的 `modules/<area>/`。

### 模块布局（`src/modules/`）

每个模块自包含，通过 `index.ts` 导出一层薄 barrel，自己的 hook 放在 `lib/` 下。

- **terminal/** - `TerminalStack` 通过 `useTerminalSession` + `pty-bridge` 为每个标签维持一个挂载的 xterm。`osc-handlers.ts` 解析 OSC 7（含 Windows 盘符规范化：`/C:/Users/foo` -> `C:/Users/foo`）与 OSC 133 标记。blocks 终端只在主缓冲区把 OSC 133 当作 shell 边界，alt-screen 内的序列属于全屏 TUI，不能让底部输入栏切换焦点或可编辑状态；即使 inline TUI 发出伪 prompt 标记，也要等 PTY 确认前台任务退出才移交输入焦点。shell 提示符的独立输入栏通过 `disableStdin` 接管光标，运行中把焦点交给 xterm；Codex 的光标和输入法定位均交由 xterm 原生处理。终端历史用 xterm `xterm-scrollable-element` 的右侧 slider 拖动，不依赖会被 WebView 隐藏的浏览器原生滚动条，也绝不另存或镜像一份滚动状态；alternate buffer 没有终端历史，因此隐藏 slider，避免 Claude Code 的内层全屏界面占满整屏。xterm 调色板由中央主题引擎驱动，不用本地表。渲染槽位是池化的（`rendererPool.ts`，普通预算与 WebGL 上限 5，容量压力下保留必要忙碌网格）：隐藏但有前台任务的 leaf 保持活网格停靠、渲染暂停；隐藏且空闲的 leaf 释放槽位，缓冲区保留、被别人抢走时才惰性序列化。`DormantRing`（1 MiB）只为完全没有槽位的 leaf 缓冲。**正在执行命令的 leaf 绝不序列化**：把 TUI 的增量重绘回放到过期快照上，正是当初把 Claude Code 界面搞乱的原因。
- **editor/** - CodeMirror 6（`EditorStack` 与 `TerminalStack` 对称）。缓冲区活在 LF 空间，保存时还原原始 EOL（`lib/eol.ts` 多数投票检测）；缩进单位按文件检测（`lib/indent.ts`）。保存时用 `fs_read_file` / `fs_write_file` 返回的磁盘 mtime 做冲突检查（不一致时弹警告并要求显式覆盖，绝不静默 last-writer-wins）。超过 10 MB 的文件提供"仍然打开"（硬上限 50 MB），超过 4 MB 关掉语法高亮与 LSP。保存时格式化的实现在 `lib/externalFormat.ts`。编辑器字号单独存为 `editorFontSize`，不影响 `terminalFontSize`。
- **explorer/** - 文件树，Material / Catppuccin 图标，键盘导航，行内重命名，右键操作。`basename` 认反斜杠。常驻搜索栏同时匹配**文件名**（模糊，`fs_search`）与**文件内容**（`fs_grep_interactive`）。两者都是模糊的：内容搜索把查询按空白拆成词，要求**每个词都出现在同一行里**（纯子串、不计顺序），而不是把整个查询当一个字面串，后者的效果是打个空格就什么都搜不到。**实现上刻意不用正则**：把词用 `.*?` 串成一个正则表达的是同一个意思，但会让 searcher 失去快路径：单个字面量能用 memchr 大步跳过文件，带空隙的模式则要让自动机逐字节爬完。所以只把**最长的那个词**当字面量交给 searcher 去筛候选行（最长 = 最稀有 = 跳得最多），其余词在活下来的少数行上用 `contains` 校验。大小写沿用 smart case，全小写查询即不区分大小写。两条搜索的 walk 都带 `hidden` + `git_ignore`，所以结果不会冒出隐藏文件或被 git 忽略的文件。工具栏的过滤按钮可开关"隐藏文件"与"git 忽略的文件"。定位按钮会展开当前文件的各级父目录并选中它，也能解析 git-diff / git-commit-file 标签（拼 `repoRoot` + 路径）。
- **preview/** - 自动探测的开发服务器预览标签（状态栏发现 localhost URL 时提示打开）。
- **tabs/** - `useTabs` 是标签列表与活动 id 的事实来源。`useWorkspaceCwd` 推导资源管理器根目录、新标签继承的 cwd，以及文件/版本侧栏和底部窗口栏跟随的当前终端项目。文件、Git 和预览标签通过 `ownerTabId` 归属项目，按空间和项目隔离。旧的固定 10 个文件上限已移除，窗口数量由底部实际宽度决定；归属信息在序列化和标签移动后保留，关掉终端会让它的文件变成未归属。
- **header/** - 顶栏与行内搜索。`WindowControls` 在 `USE_CUSTOM_WINDOW_CONTROLS` 为真时渲染（Windows 上恒真）。`headerRight` 插槽在窗口控件之前，目前放 `SessionHistoryMenu`（会话历史，见上）。
- **statusbar/** - 底部左侧改为 `WindowBar`，首项固定返回当前项目，后续窗口按打开顺序排列。`ResizeObserver` 测量可用宽度，满时自动关闭本项目中最早打开的干净窗口；未保存、活动和最新窗口保留，保护项放不下时允许横向滚动。关闭前重查当前空间、项目、活动状态和 dirty，不处理其他项目或过期测量。右侧保留 web 状态、Claude/Codex 用量、定时消息、版本及设置和供应商面板。供应商徽标只显示当前命令行的配置，删除的供应商显示告警。
- **shortcuts/** - 快捷键注册表（`shortcuts.ts`）+ `useGlobalShortcuts`。处理函数在 `App.tsx` 里按 id 传入。平台修饰键用 `metaKey || ctrlKey`。
- **settings/** - 设置 store（`store.ts`，基于 `tauri-plugin-store`）、偏好 hook、设置窗口打开器。**`usePreferencesStore.init()` 必须在每次启动时都跑**，不能只在首次创建空间时跑，否则几十项主窗口设置会被钉死在默认值、且没有变更监听。
- **sidebar/** - 文件/版本两个可折叠侧面板，原窗口面板移至底栏并删除旧入口。旧的 open-files 偏好回退到文件面板。宽度只在用户调整时保存，关闭前保留尚未落盘的最新宽度。
- **source-control/** - git 状态 / 暂存 / 提交面板与 diff 流程。丢弃改动跑在文件自己的仓库根上（多仓库安全）；提交忙状态在预检查之前置上，按钮点击即有反应。
- 仓库菜单 HEAD 使用最新 Git 状态推导，不沿用发现扫描快照，干净仓库也更新分支/detached；checkout 成功后按仓库请求身份重新读取分支列表，旧回复不能回填或清除新 loading。
- 分支操作后的状态摘要 refresh 使用 force，发起新代次，不合并切换前在途快照；默认刷新仍合并。
- **git-history/** - 提交图轨道、引用、单提交文件 diff。
- **lsp/** - 可选的语言服务器支持，不启用时零开销。`sessionManager.ts` 按 (server, workspace root) 索引会话，对打开的文档引用计数，闲置 3 分钟杀掉，崩溃退避。资源不变量：**没有根标记就不起会话**，每个 server 硬上限 4 个会话。客户端是懒加载的 `codemirror-languageserver` 子类。WSL 工作区暂不支持。
- **markdown/** - Markdown 预览渲染器（支撑 `markdown` 标签）。
- **workspace/** - 工作区环境切换（Local + WSL 发行版）。
- **theme/** - 自研主题引擎（不用 `next-themes`）。`ThemeProvider` + `applyTheme` 写 CSS 变量；内置预设在 `themes/`，可各自声明配套的 `editorTheme`。用户主题走 `customThemes.ts` + `validateTheme.ts`，可选背景图走 `bgImageStore.ts` + `SurfaceLayer`。
- **updater/** - 默认检查 `zhiweiiii/terax-ai-plus` 的已发布 NSIS 版本并打开手动下载页。只有构建时启用本仓库自己的签名配置才使用 `tauri-plugin-updater`，签名端点不可用时退回手动检查。检查与安装排除重复调用，Update 句柄按挂载代次回收。签名安装分开下载和安装，下载结束后由主窗口检查未保存文件/运行中的终端并等待工作区保存；设置窗口只请求主窗口安装确认，不能绕过保护。
- **command-palette/** - 命令面板。
- **spaces/** - 分组由 `useSpaces` 管理，每个命令行标签是一个项目。`GroupSwitcher` 的分组下有二级项目列表，可选择、重命名及关闭，显示运行中的 agent；顶部只常驻当前分组正在运行 agent 的项目，等待输入也保留，退出后收回二级列表。拖动位置从可见项目映射回完整标签，避免隐藏文件影响排序。环境选择器移至顶部分组旁。详见 `docs/architecture/workspace-navigation.md`。

### UI 约定

GitDiffPane 的差异计算使用显式 `scanLimit: 10000` 和 `timeout: 200`，避免默认低额度把大型文件的稀疏修改合为整段；两侧仍先归一化为 LF，超时保留粗略比较兜底。

- **shadcn/ui** 已配置（`components.json`，图标库 **hugeicons**）。`src/components/ui/` 里的原语**不要手改**，升级请重跑 `pnpm dlx shadcn add`。
- **AI Elements**（Vercel）在 `src/components/ai-elements/`，同样是重新生成而不是手工打补丁（目前只剩 `markdown-code` 被 Markdown 预览用）。
- **Tailwind v4** - 没有 `tailwind.config.*`，配置在 `src/styles/globals.css` 的 `@theme` 里。用 `@/lib/utils` 的 `cn()`。
- 可调整布局用 `react-resizable-panels`。
- 路径导入一律 `@/...`，跨模块绝不相对路径。
- 跨平台路径：凡是可能来自 OSC 7、资源管理器或操作系统的路径，用 `.split(/[\\/]/)` 而不是 `.split("/")` 拆分隔符。
- **前端的规范路径形式是正斜杠。** `homeDir()` 在 Windows 上返回反斜杠，要在边界处转换（`App.tsx` 的 `setHome`）。OSC 7 到达时已经是正斜杠。规范字符串相等能让 `useFileTree` 在 `tab.cwd` 首次到达时不清空树、不闪烁。

### 窗口样式

Windows：`tauri.windows.conf.json` 里 `decorations: false` + `transparent: true`，由 React 渲染自定义 `WindowControls`。

### Tauri capabilities

`src-tauri/capabilities/desktop.json` 是 webview 可用插件 API 的白名单。新增插件通常要三步：

1. `Cargo.toml` 加依赖
2. `lib.rs` 的 `run()` 里加 `.plugin(...)`
3. `desktop.json` 里加 capability 条目

### 跨平台约定

- HOME / 缓存目录用 `dirs` crate（`dirs::home_dir()`、`dirs::cache_dir()`），绝不直接读 `$HOME` / `%USERPROFILE%`。
- shell 初始化的 Windows 分支在 `pty::shell_init::windows`。
- 终端输入的回车发 `\r`（CR）不是 `\n`（LF），Windows 上的 PowerShell 要求 CR。

### 打包配置

1.0.0 正式发布由用户确认测试通过后授权，清单与 workspace 包统一版本，使用 tag 模式固定正式版本。默认仍为 Windows x64 NSIS 手动下载渠道，不在没有本仓库签名配置时上传自动更新产物。

默认 `pnpm tauri build` 生成手动安装 NSIS 包，不要求签名密钥；`tauri.manual-release.json` 保留为旧命令兼容配置。发布工作流手动触发时使用 `build-v<version>`，`v*` 标签也可触发。默认不生成自动更新产物，不能继续使用上游的公钥或 SignPath 账户。

- `bundle.targets` 是 `["nsis"]`，**只出 exe 安装包**。MSI 会把任务栏图标指向 `C:\Windows\Installer\{ProductCode}\ProductIcon`，而 ProductCode 每次构建都变，覆盖安装后固定在任务栏的图标就没了。
- NSIS 用 `perMachine` 模式（装到 `Program Files` 需要这个）。**默认目录不硬编码**：NSIS 的 `.onInit` 会调 `RestorePreviousInstallLocation`，安装时也写 `InstallLocation`，所以第一次选好目录以后就记住了。
- 一律从 `pnpm tauri build` 打包。`scripts/tauri.mjs` 通过当前 Node 直接启动本地安装的 Tauri CLI，避免 Windows 上启动 `pnpm.cmd` 的兼容性错误；它会对受打包影响的源码和配置生成指纹。相对上一次**成功打包**有变动时，先把 `package.json`、`Cargo.toml`、`Cargo.lock` 与 `tauri.conf.json` 的 patch 版本同步加一，失败则恢复这四份清单。状态文件 `.terax-package-state.json` 仅供本机判断，已忽略。状态栏右下角显示最终由 Tauri 提供的版本号。
- `installer-hooks.nsh` 注册文件夹 / 文件夹背景 / 驱动器的"Open in Terax"右键菜单。
- 签名发布需同时配置仓库变量 `TERAX_UPDATER_PUBLIC_KEY`、secret `TAURI_SIGNING_PRIVATE_KEY`，密码 secret 可选；工作流生成临时配置，启用 updater artifacts 和 `VITE_TERAX_SIGNED_UPDATES=true`，只上传 NSIS 与对应 updater 产物，发布仍为 draft，需维护者确认发布。

### 已知坑

- **React 19 严格模式**在开发环境下双挂载 `useEffect`，首次渲染时终端会启动两次，第一个 PTY 几乎立刻被清理。`SPAWN_LOCK` 串行化了这件事，开发日志里看到 `pty opened id=1` 紧接着 `pty closed id=1` 属正常。
- **Windows PowerShell 进程生命周期**：`portable-pty` 的 `killer.kill()` 只杀直接子进程。在 pwsh 里起的 `npm run dev` 之类的后代会活下来，靠 Job Object 兜底。**没有替代方案就不要停用 Job。**
- **标签 `cwd` 的存储形式**来自 OSC 7，是正斜杠（`parseOsc7` 已把 `/C:` 剥成 `C:`）。任何消费 `tab.cwd` 并把它传给 Rust 文件系统命令的地方，在 Windows 上必须规范分隔符或同时接受两种形式。`pty::shell_init` 的 `apply_common` 替 PTY 启动处理了，其他调用点得自己来。
- **`clear` 之后不要假设任何一侧还留着历史。** 终端按行封顶，字节缓冲按字节封顶，两者必然分叉。

## 1.0 审查补充（2026-10-02）

- 手机按空间 ID 分组及逐面板目录同步，激活同时选择空间和面板；PTY 映射由原生 Session 的 leaf ID 推导，忽略前端旧快照。工作区恢复校验结构和有界面板树，损坏数据暂停持久化并保留原始记录；写入串行化，关闭前等待磁盘保存，失败保留窗口。环境切换绑定请求代次并在清理前重查 dirty，启动期间打开文件事件排队。

- 设置磁盘加载与本地/跨窗口通知经过 settings/validation.ts；初始化先订阅后加载并保留期间更新，失败回收监听且允许重试。字体检测结合通用字体宽度基线，不以 fonts.check 单独判断安装情况。

- CLI 控制面关闭时回收待回复请求；前端回复使用独立请求代次，超时重试不受旧回复影响。端点描述符写入和按所有权删除共用 Windows 独占锁，读取有大小上限，连接读取有总期限。
- 命令历史的 IO 和 PATH 扫描在后台执行，默认读取 PowerShell PSReadLine 历史；读取字节、索引条目和查询数量有上限。会话记录时间统一使用 chrono，用户文本空白保留，工具结果按调用 ID 消费。
- 网关令牌原子创建并在存储异常时拒绝启动，连接、请求期限和响应缓存有上限，异常 JSON 不会触发线程 panic。上游禁止重定向，SSE 中断返回错误而非成功结束。

- PTY 的 master 最终析构取得 ConPTY 生命周期锁，关闭主动终止 Job；输出排空后才通知退出。手机订阅使用 ID，连接不持有发送器，慢队列驱逐能够真正断开。Web 启动不再额外创建无桌面 leaf 的孤立 shell。
- WSL 探测有超时和输出限制，运行状态不依赖系统语言。已删除原生 Unix shell 初始化和 Windows 无作用的 AppImage/LSP 环境覆盖，保留 WSL 与 Git Bash 集成。

- Web 访问必须先在桌面设置个人密码，已移除共享默认凭据；损坏凭据拒绝认证。保存使用原子替换，改密码同时撤销现有 WebSocket。连接并发上限 8，登录 body 和 WebSocket 分片按协议完整读取。
- 编辑器读写绑定文件代次，保存串行化，异步读取不能覆盖新输入。后端写入时再核对可选 `expectedMtime`，保留只读属性和文件链接；mtime 检查不是针对外部进程的严格事务锁。
- shell、Git 和 LSP 通过 Windows Job Object 回收子进程树，先终止后等待管道结束，避免后代持有管道导致超时不返回。
- 定时终端发送复用 Session 提交路径，结果持久化，过期重新绑定重置激活窗口。执行与完成都核对触发身份，不让旧扫描结果影响新绑定。
- LSP 的 preset 代次隔离禁用与重启；容量包含启动和关闭阶段。退出事件核对 transport 身份，启动前应答暂存至 session ID 可用，初始化失败清理并退避。
- 打包指纹覆盖原生配置、图标、手机构建配置和二进制资源，不包含生成的手机 HTML。版本标签构建严格匹配清单版本，不自动增号；普通本地打包仍保持成功打包之间的增号行为。
- 实际审查范围与未完成验收见 `docs/release-1.0-audit.md`，不能将构建通过视作全量逐行验收。

- 2026-10-08 代码侧审查收尾：覆盖 467 个条目，最终两轮全仓工程检查与关键隔离回归通过；真实 Windows CLI、WSL、iOS 和安装更新仍须发布前验收。版本未增号，未提交或发布，以审查记录顶部为当前结论。


- 文件监听使用绑定原环境的释放句柄，目录请求按根/环境/请求代次拒绝旧结果。事件队列和每批路径各限 4096，溢出显式 rescan，所有消费者重读。剪贴板图片用 binary IPC 和唯一文件名在 blocking 池保存，前后端限 32 MB；shell 提示符粘贴进入独立输入栏，TUI 保持 xterm 原生粘贴。

- 终端 Session 固定所属空间的环境副本，延迟启动、失败重试和重启不读取其他空间当前环境。Git 批量操作按扫描根/环境检查每次调用，排除重复操作并拒绝过期推送确认；手机 protocol.ts 校验嵌套事件，非法数组项不进入渲染。文件树创建/重命名向输入控件返回成功与否，失败可重试，IME 确认不提交。

- OpenCode SQLite 对话读取限制最近 600 条、单行 JSON 2 MiB、总 16 MiB 和 20000 部件，最多 8 个只读快照缓存，数据库/WAL 完整指纹驱动读取代次。搜索请求绑定项目及环境，原生拖放按物理像素换算，旧范围不继续读写。旧共享认证录制脚本及无人调用且误报成功的 verify-web 脚本已删除。

编辑器读写、目录监听和外部格式化绑定所属空间环境，旧路径/环境回调在 effect 前拒绝，卸载后不保存。重命名保留未保存草稿并核对新磁盘基线，不一致要求覆盖确认。保存/格式化串行，Vim 写后关闭等待成功；语言扩展加载去重且不缓存无限未知文件名。

Markdown 预览复用有环境和代次保护的文档读取，文件写入/变更后重新校验。搜索使用公开 Range/CSS Highlights，不拆改 React 管理的文本节点。Git 差异缓存限 6 项和 8 MiB 文本估算，失效后旧请求不回填；暂存与历史差异只读，工作区块回滚先核对磁盘正文，再带 mtime 写入。文件重命名/删除通知携带操作环境，只更新同环境标签。

pty_open 返回 `{ id, shellKind }`，引用规则基于实际启动 shell，不按当前设置或平台推测。路径控制字符拒绝，PowerShell 同时转义普通及弯单引号；agent 路径不作为 shell 表达式。一次性本机命令要求 PowerShell，不静默改用 cmd 执行另一种语法。Worktree 命令绑定环境，对话框用请求代次和同步门闩拒绝旧结果、旧删除确认和重复提交。

## 延伸阅读

文件变化按监听注册的原路径映射并携带所属环境，WSL UNC 还原 Linux 路径、junction 原路径保持，编辑器/目录树/Git 忽略其他环境事件。WSL 根键保留大小写，原生 Windows 键规范大小写；注册别名及每批事件路径有 8 MiB 限额，溢出按环境 rescan。LSP 自定义 preset 按配置记忆，避免无关重渲染重复检测。

Windows 原生拖放/剪贴板附件进入 WSL 命令行前，使用 Session 固定的发行版批量 wslpath 转换，再按实际 shell/agent 引用；本机及已有 Linux 路径不额外 IPC。路径作为位置参数，不插入 shell 源码，跨发行版 UNC 拒绝，旧 PTY 转换结果拒绝。转换子进程继续使用隐藏窗口、Job、超时及输出上限。

只有普通终端图标订阅 agent 活动，文件/预览/历史/私密图标不因该状态重绘。块耗时格式化正确处理秒/分钟进位，拖动捕获和文字选择样式在取消及卸载释放。

历史搜索入口接通当前已加载提交，复杂正则只在按需 Worker 执行，超时终止；筛选及高亮共用其结果，旧查询不会回填，普通文本不启动 Worker。提交文件列表最多四个并发读取、16 项及 8 MiB 估算缓存，过大的单项明确报错；异步查询同步抛错也进入现有失败反馈。

目录监听以不复用的注册句柄释放，不依赖目录仍存在或链接仍指向原路径；规范化与 watch/unwatch 在 blocking 池执行，注册数量和输入大小有上限。网关每次启动拥有独立停止标记及线程句柄，停止等待监听释放后才允许重启，应用退出显式停止。

手机快照两段同步排入 xterm 队列，实时输出不能插入其间；网格总单元格限制 262144，屏幕对话历史额外限制 4 Mi 字符，未匹配发送限制 64 条及 2 Mi 字符。设置写入在单窗口串行，语言格式化规则按最新存储值修改，失败不阻断后续保存；设置入口不经包含终端编辑功能的主题导出层。

Web 网格参数先无损转换再使用统一 PTY 校验，不接受整数截断后的尺寸。手机解析等待队列限 8 MiB，超限关闭连接重新同步，不丢掉部分 ANSI 后继续解析。手机快照按公开 serialize scrollback 参数缩小历史并限 2 Mi 字符，原生回复限 8 MiB；过大屏幕不提供 seed，退回实时流。桌面自身的缓冲恢复和滚动历史策略不受这些手机预算影响。

查询函数和 debounce 参数纳入同步请求身份，切换实现时旧回复在 effect 前失效；同作用域搜索仍保留上一批结果。目录树只处理自身/文件行的无修饰导航键，不抢工具栏、输入法或全局快捷键，Windows 打开状态按路径身份匹配。旧空间概览命令及未传入的可选上下文已删除，现有 GroupSwitcher 保留。必要的 DOM 测量/显式重读/作用域失效依赖注明理由，不为消除检查警告删除其行为。

语言服务安装元信息允许只有文档链接，不再给 Windows 展示 brew/xcode-select；已安装的服务器和自定义配置仍可检测启用。设置开关/选择器命名，单值 SettingSlider 直接命名 Radix Thumb，不把 label 放在无焦点的 Root 上；未修改生成原语，无调用方的原 Slider 整文件删除。

丢弃改动及改写提交说明失败在当前确认框内显示 alert，不只在被遮挡的底栏反馈；打开新确认先清除旧错误，已有写入或旧范围不能再打开确认。新建/重命名/删除分支及 clone 的真实组件隔离复核重复确认、旧结果、失败保留与重试。

桌面 pty_write 为异步命令，ConPTY 写入/尺寸 claim 在 blocking 池，不在界面线程等待 writer。每个前端 PtySession 串行发送原始输入，最多一条写 IPC 在途，积压限 4 MiB/2048 条，超限明确失败；关闭/退出拒绝剩余输入，失败不阻断后续独立写入。协议应答仍原样传输且不 claim，不增加光标/输入法或定时刷新适配。

标签同步计算状态计划，React 只接收结果，分屏 ID 和资源释放不在 React 更新器内产生副作用；owner 核对同空间，关闭最后面板解绑文件，Markdown 改名更新路径。Windows 路径大小写/分隔符统一，Linux 保留大小写，历史文件标签不跨空间复用。无调用方的旧 SpaceSwitcher 及专用组件和 tab 入口已删除。设置保存错误可见，自启及手机密码提交去重并拒绝旧读取。

提交面板按环境、上下文、仓库和分支隔离，同步门闩覆盖本面板写入与预览。预检查失败阻止提交，预览失败不直接推送，拉取仅快进；多仓库选择和打开路径包含所属仓库。改写说明核对 HEAD 并用 amend --only 保持提交内容及暂存区，仍不提供外部 Git 进程事务锁。无入口的 Amend 状态和 IPC 已删除。

批量推送分别报告全部失败及可强制重试的拒绝，不因认证/网络错误缺失而误关闭确认；单仓库重试保留其他失败。目标固定为 tracking remote，已删除无效选择及 branchOps 转发层。仓库分支菜单按环境隔离，共用写入门闩，执行前重查当前分支，旧保护确认拒绝。

LSP 检测按请求身份去重和回填，失败不伪装为 PATH 缺失；语言提示按路径代次和项目根匹配。格式化及跳转验证文档/插件身份，可见性变化不抢焦点。自定义配置失败重试复用 ID，设置写入单窗口串行。分支对话框固定工作区并排除重复提交，关闭重开作废旧完成；差异及分支比较使用有范围保护的查询，仓库定位卸载后不打开页面。

语言扩展返回值绑定路径、语言、ready、启用服务器及运行代次，范围改变首次渲染就隐藏旧扩展；effect 前晚到的句柄立即释放，不在清理中写入新范围状态。新建文件输入明确命名，失败在 alert 中反馈，关闭重开拒绝旧成功回调。

颜色 Widget 不覆盖 CodeMirror 基类只读 editable，使用独立 canEdit 标志并在写入前重查文档和权限；定位列表与只读 Markdown 在真实浏览器复核。fs_stat/fs_canonicalize 的磁盘访问也放入 blocking 池。

WSL home 的 IPC 探测和手机密码的 Argon2/保存不阻塞界面线程，在 blocking 池执行；已有 PTY 后台初始化复用同步 home 内核，不嵌套启动第二次探测。

引用核对后删除旧 SidebarRail、非响应式 shortcutLabel、旧远程状态展示 helper、无人调用的重置/焦点/颜色/服务器查找 helper；现用侧栏、快捷键 hook、远程操作和已保存空间颜色校验仍保留。仅未被其他文件导入但在本文件调用的导出，不当作死逻辑删除。

Streamdown 升至 2.7.0，移除其已不用的 Mermaid/KaTeX 依赖链；项目代码围栏继续使用现有 Lezer 渲染，不新增图表插件。Tailwind 扫描整个 dist JS 分块。项目 Markdown 保留默认 raw/sanitize，不使用会把相对文件链接重写为网站根路径的 harden；实际打开仍由 MarkdownLink 验证并交给项目文件回调。

供应商切换检查前台任务并保留当前目录，失败恢复 pin，探针和变更排除并发，明确提示请求与重启成本；卸载后的请求不重启终端。用量初始化缓存按代次应用，不覆盖新查询。历史分页重试、图缓存模式及刷新代次各自校验；快捷键菜单显示实际绑定，快速切换状态同步更新。主题颜色探针固定节点后只读，旧折叠/输入区展开样式及终端 macOS 死分支已删除。

图标关联采用无原型线性字典并统一名称大小写，特殊文件名不读取对象原型。Git 历史的分支/文件请求绑定仓库与环境，提交确认有并发门闩、失败保留及旧范围保护；SSH 和多层 GitLab 分组链接正确解析，提交图不绘制到正文。WSL 刷新去重，Web 状态读取失败不等同于服务停止。

网页预览只接受经过统一解析的 HTTP/HTTPS 地址，拒绝内部应用页面、凭据及控制字符；恢复记录和外部打开共用校验。主/设置入口拒绝 iframe 内启动，防止第二次清理 PTY。端口探测取消旧请求，地址栏忽略 IME 确认，超时明确反馈。

主题与命令面板的存储边界校验损坏记录，主题加载按字段和请求代次拒绝旧回复。主题文件使用本地 Windows 环境，文件写入事件携带实际环境，重新编辑不覆盖已有文件。设置窗口不等待隐藏状态的 rAF 才显示。背景图片按 ID 隔离并释放 URL，IndexedDB 中止/阻塞明确失败并关闭晚到连接。第一轮全文审查已完成，最终复核状态见发布前覆盖表和审查记录，真实设备验收单独列出。

长文贡献者指南在 `docs/` 下。这些指南是对 `TERAX.md` 的展开，冲突时以 `TERAX.md` 为准。

> **文档政策**：每一次改动（新功能、bug 修复、异常、有意接受的取舍、安全或运维细节）都必须在完成之前记进文档。`docs/issues.md` 是审计日志，架构指南描述东西是怎么运作的。完整政策见 `docs/README.md`。

- `docs/README.md` - 贡献者指南索引
- `docs/architecture/two-process-model.md` - IPC 边界与命令参考
- `docs/architecture/pty-shell-integration.md` - PTY、shell 初始化、OSC、ConPTY、Job Object
- `docs/architecture/web-terminal-bridge.md` - 内嵌 HTTP + WebSocket 服务与 agent transcript
- `docs/architecture/mobile-conversation-view.md` - 手机渲染的是对话不是终端
- `docs/architecture/security-model.md` - 安全模型与各道边界
- `docs/architecture/terminal-renderer-pool.md` - 渲染器池与 DormantRing 不变量
- `docs/architecture/cli-control.md` - 随包 CLI 与本地控制面
- `docs/architecture/reliability-and-releases.md` - 输入归属、诊断、增量缓存、发送确认和更新签名配置
- `docs/issues.md` - 已知问题、架构债与风险
