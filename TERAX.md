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
- `transcript::*`：编码 agent 究竟说了什么，读自 agent 自己的记录而不是从屏幕上解析。Claude Code 读 `~/.claude/projects/<转义cwd>/<session>.jsonl`，opencode 读 `~/.local/share/opencode/opencode.db`（SQLite，只读）。归一成同一结构后经 web 桥接推给手机。`rusqlite`（bundled）只为这一件事存在。详见 `docs/architecture/web-terminal-bridge.md`。
- `shell::shell_run_command`：一次性子 shell 执行（worktree 功能用），与 PTY 会话无关，不是用户的交互终端。Windows 上走 PowerShell（`-NoProfile -Command`）。
- `workspace::*`：`workspace_authorize` / `workspace_current_dir`（启动与 git 的 cwd 授权表），外加 WSL 桥（`wsl_list_distros`、`wsl_default_distro`、`wsl_home`）。
- `lsp::*`：语言服务器进程宿主。一根笨的 JSON-RPC 管道：Content-Length 分帧与进程生命周期在 Rust（`lsp/framing.rs`），协议智能在前端。启动 cwd 经授权表把关；服务器跑在自己的进程组里并整组杀掉，Windows 子进程带 `proc::job::ProcessJob`。`RunEvent::Exit` 时全部杀掉。
- `secret::secret_protect` / `secret_unprotect`：Windows DPAPI 加解密，IPC 上走 base64。agent 环境变量里的 token 靠它落盘，明文不进设置文件。
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
- **Agent transcript**：附着的会话里跑着编码 agent 时，服务端推 `{type:"transcript"}`，内容读自 agent 自己的记录。手机据此渲染对话，屏幕解析只保留一件 transcript 不可能知道的事：**程序此刻在等你选什么**。三道闸门让空闲会话零开销：必须真有 agent 在跑（`Session::web_agent`，由 OSC 检测喂）、文件指纹必须变过、revision 必须变过。700ms 轮询而不是监听，因为 opencode 的提交落在 WAL 里，没有文件系统事件能描述它。
- **标签同步**：`App.tsx` 的 `useWebTerminalSync` 把每个桌面终端标签同步给 Rust（`web_sync_tabs`），所以手机能列出全部命令行而不只是有活 PTY 的。手机连一个还没起 pty 的标签时，服务端发 `terax:web-activate`，前端激活该标签，手机收到 `opening` 后重试。

### PTY shell 集成

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

- **terminal/** - `TerminalStack` 通过 `useTerminalSession` + `pty-bridge` 为每个标签维持一个挂载的 xterm。`osc-handlers.ts` 解析 OSC 7（含 Windows 盘符规范化：`/C:/Users/foo` -> `C:/Users/foo`）与 OSC 133 标记。xterm 调色板由中央主题引擎驱动，不用本地表。渲染槽位是池化的（`rendererPool.ts`，上限 5）：隐藏但有前台任务的 leaf 保持活网格停靠、渲染暂停；隐藏且空闲的 leaf 释放槽位，缓冲区保留、被别人抢走时才惰性序列化。`DormantRing`（1 MiB）只为完全没有槽位的 leaf 缓冲。**正在执行命令的 leaf 绝不序列化**：把 TUI 的增量重绘回放到过期快照上，正是当初把 Claude Code 界面搞乱的原因。
- **editor/** - CodeMirror 6（`EditorStack` 与 `TerminalStack` 对称）。缓冲区活在 LF 空间，保存时还原原始 EOL（`lib/eol.ts` 多数投票检测）；缩进单位按文件检测（`lib/indent.ts`）。保存时用 `fs_read_file` / `fs_write_file` 返回的磁盘 mtime 做冲突检查（不一致时弹警告并要求显式覆盖，绝不静默 last-writer-wins）。超过 10 MB 的文件提供"仍然打开"（硬上限 50 MB），超过 4 MB 关掉语法高亮与 LSP。保存时格式化的实现在 `lib/externalFormat.ts`。编辑器字号单独存为 `editorFontSize`，不影响 `terminalFontSize`。
- **explorer/** - 文件树，Material / Catppuccin 图标，键盘导航，行内重命名，右键操作。`basename` 认反斜杠。常驻搜索栏同时匹配**文件名**（模糊，`fs_search`）与**文件内容**（`fs_grep_interactive`）。工具栏的过滤按钮可开关"隐藏文件"与"git 忽略的文件"。定位按钮会展开当前文件的各级父目录并选中它，也能解析 git-diff / git-commit-file 标签（拼 `repoRoot` + 路径）。
- **preview/** - 自动探测的开发服务器预览标签（状态栏发现 localhost URL 时提示打开）。
- **tabs/** - `useTabs` 是标签列表与活动 id 的事实来源。`useWorkspaceCwd` 推导资源管理器根目录、新标签继承的 cwd，以及文件/版本/窗口三个侧栏跟随的当前终端标签。**文件标签归属某个命令行**：每个 editor / markdown 标签带 `ownerTabId` 指向它被打开时所在的终端标签，`capEditorTabs` **按归属**限流（每个终端标签 10 个，最老先驱逐，脏的/刚打开的/活动的保留）。归属信息在序列化和标签移动后仍然保留；关掉终端会让它的文件变成"未归属"。
- **header/** - 顶栏与行内搜索。`WindowControls` 在 `USE_CUSTOM_WINDOW_CONTROLS` 为真时渲染（Windows 上恒真）。
- **statusbar/** - 底栏、`CwdBreadcrumb`（处理盘符与 `~`）、web 服务状态徽标、Claude Code 环境变量面板（临时写入 `$env:`，token 经 DPAPI 加密后存偏好）。
- **shortcuts/** - 快捷键注册表（`shortcuts.ts`）+ `useGlobalShortcuts`。处理函数在 `App.tsx` 里按 id 传入。平台修饰键用 `metaKey || ctrlKey`。
- **settings/** - 设置 store（`store.ts`，基于 `tauri-plugin-store`）、偏好 hook、设置窗口打开器。**`usePreferencesStore.init()` 必须在每次启动时都跑**，不能只在首次创建空间时跑，否则几十项主窗口设置会被钉死在默认值、且没有变更监听。
- **sidebar/** - 活动栏与可折叠侧面板。打开的文件面板**按归属命令行分组**并跟随当前终端标签。git 标签（diff / history / commit-file）是仓库级的，与当前命令行无关，恒显示。
- **source-control/** - git 状态 / 暂存 / 提交面板与 diff 流程。丢弃改动跑在文件自己的仓库根上（多仓库安全）；提交忙状态在预检查之前置上，按钮点击即有反应。
- **git-history/** - 提交图轨道、引用、单提交文件 diff。
- **lsp/** - 可选的语言服务器支持，不启用时零开销。`sessionManager.ts` 按 (server, workspace root) 索引会话，对打开的文档引用计数，闲置 3 分钟杀掉，崩溃退避。资源不变量：**没有根标记就不起会话**，每个 server 硬上限 4 个会话。客户端是懒加载的 `codemirror-languageserver` 子类。WSL 工作区暂不支持。
- **markdown/** - Markdown 预览渲染器（支撑 `markdown` 标签）。
- **workspace/** - 工作区环境切换（Local + WSL 发行版）。
- **theme/** - 自研主题引擎（不用 `next-themes`）。`ThemeProvider` + `applyTheme` 写 CSS 变量；内置预设在 `themes/`，可各自声明配套的 `editorTheme`。用户主题走 `customThemes.ts` + `validateTheme.ts`，可选背景图走 `bgImageStore.ts` + `SurfaceLayer`。
- **updater/** - 基于 `tauri-plugin-updater` 的自动更新 UI。
- **command-palette/** - 命令面板。
- **spaces/** - 工作区空间/项目（名称、根目录、环境、颜色、按空间持久化标签），走 `useSpaces` 与 `GroupSwitcher`。

### UI 约定

- **shadcn/ui** 已配置（`components.json`，图标库 **hugeicons**）。`src/components/ui/` 里的原语**不要手改**，升级请重跑 `pnpm dlx shadcn add`。
- **AI Elements**（Vercel）在 `src/components/ai-elements/`，同样是重新生成而不是手工打补丁（目前只剩 `markdown-code` 被 Markdown 预览用）。
- **Tailwind v4** - 没有 `tailwind.config.*`，配置在 `src/App.css` 的 `@theme` 里。用 `@/lib/utils` 的 `cn()`。
- 可调整布局用 `react-resizable-panels`。
- 路径导入一律 `@/...`，跨模块绝不相对路径。
- 跨平台路径：凡是可能来自 OSC 7、资源管理器或操作系统的路径，用 `.split(/[\\/]/)` 而不是 `.split("/")` 拆分隔符。
- **前端的规范路径形式是正斜杠。** `homeDir()` 在 Windows 上返回反斜杠，要在边界处转换（`App.tsx` 的 `setHome`）。OSC 7 到达时已经是正斜杠。规范字符串相等能让 `useFileTree` 在 `tab.cwd` 首次到达时不清空树、不闪烁。

### 窗口样式

Windows：`tauri.windows.conf.json` 里 `decorations: false` + `transparent: true`，由 React 渲染自定义 `WindowControls`。

### Tauri capabilities

`src-tauri/capabilities/default.json` 是 webview 可用插件 API 的白名单。新增插件通常要三步：

1. `Cargo.toml` 加依赖
2. `lib.rs` 的 `run()` 里加 `.plugin(...)`
3. `default.json` 里加 capability 条目

### 跨平台约定

- HOME / 缓存目录用 `dirs` crate（`dirs::home_dir()`、`dirs::cache_dir()`），绝不直接读 `$HOME` / `%USERPROFILE%`。
- shell 初始化的 Windows 分支在 `pty::shell_init::windows`。
- 终端输入的回车发 `\r`（CR）不是 `\n`（LF），Windows 上的 PowerShell 要求 CR。

### 打包配置

- `bundle.targets` 是 `["nsis"]`，**只出 exe 安装包**。MSI 会把任务栏图标指向 `C:\Windows\Installer\{ProductCode}\ProductIcon`，而 ProductCode 每次构建都变，覆盖安装后固定在任务栏的图标就没了。
- NSIS 用 `perMachine` 模式（装到 `Program Files` 需要这个）。**默认目录不硬编码**：NSIS 的 `.onInit` 会调 `RestorePreviousInstallLocation`，安装时也写 `InstallLocation`，所以第一次选好目录以后就记住了。
- `installer-hooks.nsh` 注册文件夹 / 文件夹背景 / 驱动器的"Open in Terax"右键菜单。
- 自动更新用公开的 minisign 公钥，产物在 GitHub releases。

### 已知坑

- **React 19 严格模式**在开发环境下双挂载 `useEffect`，首次渲染时终端会启动两次，第一个 PTY 几乎立刻被清理。`SPAWN_LOCK` 串行化了这件事，开发日志里看到 `pty opened id=1` 紧接着 `pty closed id=1` 属正常。
- **Windows PowerShell 进程生命周期**：`portable-pty` 的 `killer.kill()` 只杀直接子进程。在 pwsh 里起的 `npm run dev` 之类的后代会活下来，靠 Job Object 兜底。**没有替代方案就不要停用 Job。**
- **标签 `cwd` 的存储形式**来自 OSC 7，是正斜杠（`parseOsc7` 已把 `/C:` 剥成 `C:`）。任何消费 `tab.cwd` 并把它传给 Rust 文件系统命令的地方，在 Windows 上必须规范分隔符或同时接受两种形式。`pty::shell_init` 的 `apply_common` 替 PTY 启动处理了，其他调用点得自己来。
- **`clear` 之后不要假设任何一侧还留着历史。** 终端按行封顶，字节缓冲按字节封顶，两者必然分叉。

## 延伸阅读

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
- `docs/issues.md` - 已知问题、架构债与风险
