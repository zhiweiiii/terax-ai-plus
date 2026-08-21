# 贡献者文档

这个目录放长篇的贡献者与维护者指南。仓库根目录的 `TERAX.md` 是活的架构文档、也是事实来源；这些指南在不重复它的前提下展开具体领域。

指南与 `TERAX.md` 冲突时，以 `TERAX.md` 为准。

## 文档规定

**任何改动，写进文档之后才算完成。** 下面这些都要落进对应的指南（改动了架构的还要落进 `TERAX.md`）：

- 新功能与行为变化
- Bug 修复，以及为什么这么修
- 已知异常、明确接受的取舍、架构债
- 安全相关、端口、认证等运维细节

`docs/issues.md` 是 bug / 风险 / 债务的审计记录，架构指南写"本来应该怎么运作"。修好或加上一样东西时两边都更新，让后来的维护者能重建出改了什么、为什么改。**没写进文档的，就当没发生过。**

## 从这里开始

- [TERAX.md](../TERAX.md) - 架构事实来源，先读这个
- [CONTRIBUTING.md](../CONTRIBUTING.md) - 如何贡献、质量标准、项目布局

## 架构指南

- [双进程模型与 IPC 命令参考](architecture/two-process-model.md) - Rust 掌管所有系统访问，webview 通过 `invoke()` 沟通。命令目录，以及如何新增一个命令。
- [PTY shell 集成](architecture/pty-shell-integration.md) - PTY 会话、shell 初始化脚本、OSC 7 / 133、ConPTY、`CONPTY_LIFECYCLE_LOCK`、Job Object、WSL。
- [Web 终端桥接](architecture/web-terminal-bridge.md) - 内嵌的 HTTP + WebSocket 服务，把桌面 PTY 会话共享给手机浏览器；认证、协议、构建流程，以及 agent transcript。
- [手机端对话视图](architecture/mobile-conversation-view.md) - 手机渲染的是对话而不是终端：对话来自 agent 自己的记录，屏幕只负责它不可能知道的部分（正在等你选什么）。
- [安全模型](architecture/security-model.md) - 工作区授权、IPC 白名单、OSC 信任边界，以及 Web 终端的认证边界。
- [终端渲染器池](architecture/terminal-renderer-pool.md) - 槽位复用、DormantRing，以及"命令执行中绝不序列化"这条不变量。
- [CLI 控制面](architecture/cli-control.md) - 随包分发的 CLI、带认证的本地协议、调用方定位、打包，以及当前的平台限制。
- [已知问题与架构债](issues.md) - 记录在案的 bug、风险、死代码与文档漂移。

## 移植历史（归档）

- [Git 版本管理移植档案](history/git-移植档案.md) - 版本管理功能来自 IDEA 的那批移植：留下的设计决策、有意接受的取舍、踩过的坑，以及还没做的备选清单。
