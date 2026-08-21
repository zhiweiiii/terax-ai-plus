# CLI 控制面

本文是 `TERAX.md` 的展开。与 `TERAX.md` 冲突时以 `TERAX.md` 为准。

## 当前的对外面貌

Terax 随包带一个小的 Rust 客户端，内部叫 `terax-cli`。在原生终端面板里它以 `terax` 命令暴露：

```text
terax <file> [--line <n>] [--no-focus] [--json]
terax open <file> [--line <n>] [--no-focus] [--json]
terax ping [--json]
terax capabilities [--json]
terax identify [--json]
```

前提是应用已经在运行。在某个 Terax 面板里发起的命令，目标就是那个面板所属的空间，**即使 UI 焦点在别的空间或标签页上**。没有面板上下文的外部客户端则退回到当前的 UI 上下文。

## 组成部分

- `src-tauri/crates/terax-control-protocol` - 应用与 CLI 共用的请求、响应、错误、描述符与方法类型，依赖极少。
- `src-tauri/crates/terax-cli` - 独立的控制台客户端。刻意不用 Clap、Tokio、reqwest 和 Tauri。
- `src-tauri/src/modules/control.rs` - 端点发现、认证、消息上限、并发上限、超时、路径规范化与请求路由。
- `src/modules/control/` - 把调用方面板映射到标签页和空间，然后执行那一小组纯 UI 动作。
- `scripts/build-cli.mjs` - 构建 Tauri `externalBin` 打包器所需的、带目标三元组后缀的辅助程序。

`ping`、`capabilities`、认证和文件校验由 Rust 直接处理。必须改动 React 状态的动作则发给主 webview，经 `control_respond` 完成。这样系统层校验留在 Rust，又不用在 React 之外再复制一份标签页模型。

## 传输与认证

应用绑定一个临时的回环 TCP 端口，并把发现描述符写到用户缓存目录下的 `terax/control.json`。描述符里有协议版本、地址、进程 id、应用版本，以及一个随机的 256 位令牌。

安全性质：

- 监听只绑 `127.0.0.1`。
- Unix 下控制目录是 `0700`，描述符以 `0600` 原子替换；Windows 沿用当前用户的配置文件 ACL。
- 每个请求都带令牌，不匹配时以**常数时间比较**拒绝。
- 消息是换行分隔的 JSON，上限 64 KiB。
- 请求 id 有长度上限，且限制为可安全写日志的 ASCII。
- 连接数和待处理的 UI 请求各上限 32，读、写、UI 响应都有超时。
- CLI 会先确认缓存描述符指向的 Terax 进程还活着，才发送令牌。
- 文件路径先规范化，且必须指向**已授权工作区内的普通文件**，才会打开编辑器。
- 描述符只在仍属于正在退出的那个进程时才删除，这样旧实例不会删掉新实例的端点。

令牌连同 `TERAX_PANE_ID` 一起注入 Terax 启动的原生 shell。**子级编码 agent 会有意继承调用方上下文**，因此它们拥有与启动它们的终端相同的本地 UI 控制能力。令牌绝不能写日志，也绝不能出现在命令输出里。

## PTY 里如何找到这个命令

应用启动时会为当前进程创建一份用户私有的 `bin/terax` 副本（主程序叫 `terax-prod`，所以 `terax` 这个名字空着给辅助程序），并把该目录前置到 PTY 的 `PATH`。

PowerShell 集成里另外还定义了一个交互式的 `terax` 函数来执行 `$TERAX_CLI`。真正的 PATH 项仍然必需，因为非交互的子 shell 不一定继承 shell 函数。

已退出进程留下的启动器目录，会在下次控制服务启动时清理；活着的进程 id 无论目录多旧都保留。

## 打包与体积

`tauri.conf.json` 声明 `binaries/terax-cli` 为外部二进制。Tauri 会挑选带当前目标三元组后缀的文件，与应用一起签名或打包。`scripts/build-cli.mjs` 为宿主三元组构建这个辅助程序。

release profile 使用单 codegen unit、fat LTO、体积优化、panic=abort 和 strip。**改动依赖之后一定要实测产物大小**。

## 当前限制

- WSL 面板还拿不到控制凭据和 CLI 启动器。Windows 路径转换和 WSL 网络要一起做才有意义。
- Terax 还没有为外部终端安装全局 `terax` 命令。随包的辅助程序和缓存描述符已经为将来的安装步骤准备好了。
- CLI 还不能拉起未启动的 Terax。
- 拆分、标签、agent、读屏、输入这些命令还不在协议版本 1 里。

这些限制被明确写出来，是为了让不支持的路径**以"不可用"失败**，而不是悄悄作用到错误的面板上、或者为一个根本连不上的命令暴露凭据。

## 扩展协议

1. 在 `terax-control-protocol` 里加方法常量和带类型的参数。
2. 在 Rust 里校验认证、协议版本、边界值和面向系统的输入。
3. 不需要 React 状态的方法在 Rust 里处理完；只有必须动 UI 的才路由到前端。
4. 先解析明确的调用方面板，再退回到当前 UI 状态。
5. 返回结构化错误，保持 `--json` 输出稳定。
6. 补上协议、解析、路由、平台和体积几方面的检查。

## 另见

- [`TERAX.md`](../../TERAX.md) - 架构事实来源
- [双进程模型](two-process-model.md) - Tauri IPC 边界
- [PTY shell 集成](pty-shell-integration.md) - 环境注入与 shell 启动
- [安全模型](security-model.md) - 工作区与密钥边界
