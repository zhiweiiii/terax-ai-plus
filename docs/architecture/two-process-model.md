# 双进程模型与 IPC 命令参考

本文是 `TERAX.md` 的展开。与 `TERAX.md` 冲突时以 `TERAX.md` 为准。

## 这条分界线

Terax 是两个进程：Rust 后端（`src-tauri/`）和 webview 前端（`src/`）。

- **Rust 掌管所有系统访问**：PTY、文件系统、git、启动 shell、网络、密钥、工作区授权。
- **webview 绝不直接碰文件系统、进程或 shell**。每一次宿主操作都经由 `invoke()` 调用 `src-tauri/src/lib.rs` 里注册的命令。

这条边界是安全模型的根。不可信输入（终端转义序列、文件内容、AI 工具返回值）在 Rust 里或在范围明确的前端代码里被解析和校验，**绝不由渲染进程直接执行**。

## 新增一个 IPC 命令

1. 在对应的 `src-tauri/src/modules/<领域>/` 模块里写 `#[tauri::command]` 异步函数。
2. 在 `src-tauri/src/lib.rs` 的 `tauri::generate_handler![...]` 块里注册它。
3. 如果这个命令用到 Tauri 插件 API（窗口、剪贴板、对话框等），把插件权限加进 `src-tauri/capabilities/default.json`。
4. 在对应的 `src/modules/<领域>/lib/` 目录里加一个带类型的前端封装，通过 `invoke()` 调用。
5. 如果命令会碰文件系统、网络或 shell，必须走既有的关卡（拒绝名单、工作区授权表、SSRF 防护、AI 工具审批）。

自定义命令**不需要**在 `default.json` 里逐条列出，capability 覆盖整个窗口；插件权限则必须列。

## 命令目录

按模块分组，名字是前端看到的 Rust 函数名。

### PTY（`src-tauri/src/modules/pty/`）

长生命周期的交互式终端会话。

- `pty_open` - 新建 PTY 会话
- `pty_write` - 发送输入字节（文本或控制序列）
- `pty_resize` - 调整 PTY 尺寸
- `pty_close` / `pty_close_all` - 销毁一个或全部会话
- `pty_has_foreground_process` / `pty_has_foreground_job` - 判断是否有命令在跑
- `pty_shell_name` / `pty_list_shells` - shell 探测与枚举

`pty_open` 的输出通过接到 Tauri `Channel<Response>` 的回调流出；退出码走另一个 `Channel<i32>`。

### 文件系统（`src-tauri/src/modules/fs/`）

**目录树**：`list_subdirs`、`fs_read_dir`

**文件**：`fs_read_file`、`fs_write_file`、`fs_stat`、`fs_canonicalize`

**改动**：`fs_create_file` / `fs_create_dir`、`fs_rename` / `fs_delete` / `fs_copy`

**监听**：`fs_watch_add` / `fs_watch_remove`

**搜索**：`fs_search`（按文件名模糊查找）、`fs_grep_interactive`（按内容交互搜索）

### Git（`src-tauri/src/modules/git/`）

所有 git 命令都经过工作区授权表把关。

- `git_resolve_repo` / `git_panel_snapshot`
- `git_status`
- `git_diff` / `git_diff_content`
- `git_stage` / `git_unstage` / `git_discard`
- `git_commit`
- `git_fetch` / `git_pull_ff_only` / `git_push`
- `git_log` / `git_show_commit` / `git_commit_files` / `git_commit_file_diff`
- `git_remote_url`
- `git_list_branches` / `git_checkout_branch`

### Shell（`src-tauri/src/modules/shell/`）

- `shell_run_command` - 一次性子 shell 执行（worktree 功能在用），**不是**用户的交互式终端

### 工作区（`src-tauri/src/modules/workspace.rs`）

- `workspace_authorize` / `workspace_current_dir` - 启动与 git 的 cwd 授权表
- `wsl_list_distros` / `wsl_default_distro` / `wsl_home` - WSL 桥接

### 历史（`src-tauri/src/modules/history/`）

- `history_suggest` / `history_commands` / `history_record` / `history_list` - shell 历史集成

### 密钥（`src-tauri/src/modules/secret.rs`）

- `secret_protect` / `secret_unprotect` - 用 Windows DPAPI 加解密一小段密钥，使其可以放进普通配置文件。密文绑定当前用户账户。

### 设置窗口

- `get_launch_dir` - CLI 启动目录，首次读取后清空
- `open_settings_window` - 打开独立的设置 webview（可选 `tab` 深链）

### Web 终端桥接（`src-tauri/src/modules/web/`）

- `web_sync_tabs` - 前端同步所有桌面终端标签页（leaf id、cwd、标题、是否活动、pty id、空间），这样手机能列出全部命令行
- `web_sync_leaf_pty` - 标签页的 pty 起来之后记录 leaf 到 pty 的映射
- `web_activate_leaf` - 手机连到了一个还没有活 pty 的标签页，请求前端激活它
- `web_snapshot_reply` - 桌面把某个终端的缓冲区快照交回来，用作手机的首屏
- `web_set_password` / `web_has_custom_password` - 手机访问密码

这些支撑内嵌的 HTTP + WebSocket 服务。传输、认证与协议见 [Web 终端桥接](web-terminal-bridge.md)。

### CLI 控制面

- `control_frontend_ready` - 标记恢复后的主界面已就绪，可以接受路由过来的 CLI 动作
- `control_respond` - 完成一个待处理的、面向 UI 的 CLI 请求

本地协议与打包模型见 [CLI 控制面](cli-control.md)。

## 不变量

- webview 除了上面这些命令，不得启动进程或读取文件。
- 新命令必须在 `lib.rs` 注册，并在边界上设防（工作区授权、IPC 白名单）。
- 用到插件 API 的命令，必须把插件权限加进 `src-tauri/capabilities/default.json`。

## 另见

- [`TERAX.md`](../../TERAX.md) - 架构事实来源
- [`docs/README.md`](../README.md) - 贡献者指南索引
- [PTY shell 集成](pty-shell-integration.md) - 会话与 shell 集成的运作方式
- [安全模型](security-model.md) - 每个命令都必须遵守的边界
