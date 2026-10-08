# 双进程模型与 IPC 命令参考

`wsl_native_paths({paths, workspace})` 将 Windows 原生拖放/剪贴板路径转换到指定 WSL 发行版，返回同序的绝对 Linux 路径；本机直通。输入/命令/输出有界且转换运行在 blocking 池，目标固定为所属 Session，不采用当前全局环境。`fs_watch_add` 返回可空注册句柄，释放改为 `fs_watch_remove({lease})`，不再重新解析可能已经消失的目录。

Git diff 展示：后端返回原始两侧内容，前端统一 LF 后由 CodeMirror 计算字符级差异。GitDiffPane 显式配置 scanLimit 10000、timeout 200ms，避免默认低扫描额度把大文件的少量分散修改合为整段；超时仍允许粗略结果。该配置不修改源文件或 Git 暂存区。

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

- `pty_open` - 新建 PTY 会话，返回 `{ id, shellKind }`，引用类型来自实际启动的 shell
- `pty_write` - 发送输入字节（文本或控制序列）
- `pty_resize` - 调整 PTY 尺寸
- `pty_close` / `pty_close_all` - 销毁一个或全部会话
- `pty_has_foreground_process` / `pty_has_foreground_job` - 判断是否有命令在跑
- `pty_shell_name` / `pty_list_shells` - shell 探测与枚举

`pty_open` 的输出通过接到 Tauri `Channel<Response>` 的回调流出；退出码走另一个 `Channel<i32>`。

### 文件系统（`src-tauri/src/modules/fs/`）

`fs_write_file` 成功后广播 `fs:file-written`，包含 `{ path, source?, workspace }`；消费方按写入原环境读取，不按当前选择环境推测。

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


## 文件事件与剪贴板边界

剪贴板图片经 fs_save_clipboard_image 的原始 binary body 和 x-image-mime 头传输，32 MB 上限在前后端校验；写盘在 blocking 池完成，返回唯一扩展名路径，不按毫秒覆盖。fs_clipboard_file_paths 同样在 blocking 池读取 Windows CF_HDROP，限制 1024 个路径、每路径 32768 UTF-16 单元和总 1 Mi 单元。

前端 watchAdd 返回绑定添加时工作区的释放句柄，添加成功后才删除、幂等清理。原生文件事件队列和每批路径限 4096，丢失、notify 错误或 rescan 时发送 fs:changed 的 rescan 标志。文件树重列目录，编辑器重新检查 mtime，Git 更新工作树。事件总线隔离订阅异常并忽略桥销毁后的晚到回调。


## Git 范围与异步状态

仓库扫描按工作区环境和目录索引选择记忆，卸载及重新扫描作废旧回复，StrictMode 重挂载会重新扫描。次级仓库状态按环境保留，单仓库刷新与批量刷新共享请求序号，旧批次不能覆盖更新值；禁用、环境切换和卸载停止后续读取。文件事件同时刷新活动与其他匹配仓库，不以相似路径前缀混淆目录。

单仓库远程操作设置同步占用标志防止重复点击，各 await 之后重查输入上下文，切换环境后不继续执行 pull/push。状态读取同步更新仓库元信息，切换期间隐藏旧范围结果。已发出的原生命令不能在前端取消；环境变化只取消尚未发出的后续步骤。移除无法绕过 in-flight 去重的旧 watchdog，原生进程仍受超时限制。批量 Git 远程操作还在逐项审查。

批量 Git 使用绑定扫描根及环境的调用边界，在调用前与返回后核对即时环境，统一占用标志排除重复操作。旧范围进度不会显示在新工作区，计时器随范围释放。同步分叉或失败明确报告失败；完成后同时刷新活动和次级仓库。推送确认按 @{upstream}..HEAD 读取至多 200 个提交，最多取 6 个 patch；真正推送前复核分支、upstream、ahead/behind 和 HEAD，不把过期确认用于新分支。原生已开始执行的命令仍由其捕获的环境和进程超时负责，不承诺撤销已产生的修改。

文件树写入使用渲染时环境，在发出命令前检查范围及即时环境；创建/重命名返回 boolean 供输入控件决定是否保留草稿并允许重试。

资源管理器的系统打开/定位在 Windows 上保留 UNC，WSL 绝对路径转为 \\wsl.localhost\<distro>\ 路径。Git 标记将目录链接映射到 canonical 根，再匹配最深仓库；异步 canonicalize 绑定请求、挂载及环境，不使用旧环境结果。

fs_stat 和 fs_canonicalize 也通过 fs::blocking 执行路径解析、metadata 和 canonicalize，不在异步运行线程直接等待慢磁盘或 UNC。

## 另见

- [`TERAX.md`](../../TERAX.md) - 架构事实来源
- [`docs/README.md`](../README.md) - 贡献者指南索引
- [PTY shell 集成](pty-shell-integration.md) - 会话与 shell 集成的运作方式
- [安全模型](security-model.md) - 每个命令都必须遵守的边界
