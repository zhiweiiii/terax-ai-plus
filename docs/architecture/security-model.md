# 安全模型

本文是 `TERAX.md` 的展开。与 `TERAX.md` 冲突时以 `TERAX.md` 为准。

Terax 会起 shell、读写文件、调用 git。安全模型是纵深防御：没有哪一道防线单独够用，所以每个边界在动手之前都要先校验输入。

## 边界

主要的信任边界有四道：

1. **IPC 边界** - 在 `src-tauri/src/lib.rs` 注册的命令，由 `src-tauri/capabilities/default.json` 把关。
2. **文件系统边界** - PTY 启动和 git 命令都要经过工作区授权表。
3. **终端转义序列边界** - OSC 序列会被解析并据以行动，但绝不无条件信任它去改状态。
4. **Web 终端边界** - 内嵌的 HTTP + WebSocket 服务（见 [web-terminal-bridge.md](web-terminal-bridge.md)）本质上是一个远程 shell。访问由密码登录把关（`POST /auth`，限速：连续 5 次失败锁定 5 秒，失败次数会显示在桌面状态栏），外加一个认证 cookie（`Max-Age=604800`），WebSocket 升级时同样校验它。**服务绑定在 `0.0.0.0`**，所以只要不是可信局域网，就应该放在防火墙或 VPN 之后。

## 访问凭据

密码凭据存在 `%LOCALAPPDATA%/terax/web-auth.json`（`web/auth.rs`）：

- **Argon2id 加盐哈希**，存成 PHC 字符串，算法和参数跟着哈希一起走，以后换参数不用猜旧值是怎么产生的。这道门后面是一个远程 shell，无盐快哈希落在文件里正是离线爆破想要的东西。
- **会话令牌每次改密码都重新生成**。cookie 有效期是一周，令牌不轮换的话"改密码"就等于什么都没做：拿着旧 cookie 的人照样进得来。轮换令牌才让改密码有意义。
- 还没设过密码时，仍由编译期常量应答，这样升级不会把已有安装关在门外。

历史遗留（见 [已知问题](../issues.md) 的"凭据的历史遗留"）：在设置自己的密码之前，用的仍是编译期常量，它的 SHA-1 摘要和 cookie 令牌在源码里做了 XOR 混淆，`strings` 读不出来，**但混淆不是加密**，能运行代码的人就能还原。这是"设一个自己的密码"存在的原因。

## 工作区授权表

`WorkspaceRegistry`（`src-tauri/src/modules/workspace.rs`）记录允许 PTY 启动和 git 命令操作的目录。

- `workspace_authorize` 添加一个目录。
- `authorize_spawn_cwd` 拒绝授权根之外的启动目录。
- `authorize_user_spawn_cwd` 把用户主动选择的目录注册成新的根，而不是拒绝它。
- 启动目录和用户主目录会作为初始根写进去。

这是文件系统边界的"放行"一侧。任何要在当前工作区之外起 shell 或改文件的新功能，都必须和这张表打交道。

## OSC 信任门控

终端会从 PTY 字节流里解析 OSC 序列：

- **OSC 7** 更新标签页的 cwd。
- **OSC 133 A/B/C/D** 标记提示符与命令的边界。
- **OSC 777** 由 agent 检测器用来判断编码 agent 的状态转换。

agent 检测器（`src-tauri/src/modules/pty/agent_detect.rs`）由 `OSC 133;C;<cmd>` 或自带标记触发，发出 `terax:agent-signal` 事件。它**只认 OSC 序列**，从不看原始输出，所以一个不断重绘的 TUI 不会让状态来回跳。

## 不变量

- 新增会碰文件系统的命令，必须遵守工作区授权表。
- 新用到的插件 API，必须加进 `src-tauri/capabilities/default.json`。
- 凭据不进日志、不进事件负载、不进页面 bundle。

## 另见

- [`TERAX.md`](../../TERAX.md) - 架构事实来源
- [`docs/README.md`](../README.md) - 贡献者指南索引
- [双进程模型](two-process-model.md) - IPC 边界与命令目录
