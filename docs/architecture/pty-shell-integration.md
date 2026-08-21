# PTY shell 集成

本文是 `TERAX.md` 的展开。与 `TERAX.md` 冲突时以 `TERAX.md` 为准。

## 会话模型

一个终端标签页对应一个 PTY 会话。会话存在 `PtyState`（`src-tauri/src/modules/pty/mod.rs`）里：

```rust
pub struct PtyState {
    sessions: RwLock<HashMap<u32, Arc<Session>>>,
    next_id: AtomicU32,
    web_tabs: Mutex<Vec<WebTab>>, // 向 web 桥接公布的桌面标签页
}
```

id 从 1 开始单调递增、从不复用，所以前端可以拿 `0` 当"未设置"。

`pty_open` 在阻塞线程上启动会话、插入表中并返回 id。输出和退出码通过可选回调送出（`Box<dyn Fn(Vec<u8>) + Send + Sync>`）：前端把它们接到 Tauri `Channel` 上，而内嵌的 web 服务传 `None`，改用会话自己的广播。`pty_write` 接收原始字节并用 `x-pty-id` 头标识会话，避免每次按键都做 JSON 序列化。

## reader / flusher / waiter 三个线程

`session::spawn`（`session.rs`）为每个会话起三个线程：

1. **reader** - 从 PTY master 读字节，跑 DA 过滤器和 agent 检测器，把过滤后的字节推进待发缓冲。
2. **flusher** - 合并输出并通过数据通道发给前端，同时广播给已连接的 Web 观看者（有界队列，慢速手机不会拖住 PTY），**自己不留副本**：Web 观看者的首屏取自桌面终端自己的缓冲区。见 [Web 终端桥接](web-terminal-bridge.md)。
3. **waiter** - 等子进程退出，把尾部输出冲出去，发出退出码。

待发缓冲上限 4 MiB；溢出时整个丢弃并替换成一条 SGR 复位提示，免得一条被切开的 CSI 序列把 xterm 的状态搞坏。

## Shell 启动（Windows）

`shell_init::build_command`（`shell_init.rs`）构造用来启动 shell 的 `CommandBuilder`。路径和参数取决于选中的工作区环境（本地或某个 WSL 发行版）。shell 优先级：

1. `pwsh.exe`（PowerShell 7+）
2. `powershell.exe`（Windows PowerShell 5.1）
3. `cmd.exe`（无集成）

**PATH 命中项必须是非零长度的文件**（`is_real_executable`）。微软商店的应用执行别名是一个 0 字节的重解析点，Explorer 会替你解析而 `CreateProcessW` 不会；而它在从 Explorer 继承的 PATH 里排在真正的 PowerShell 7 之前。选中它的结果是终端能打开、却完全不接受输入，且只有打包版会中招，因为从开发终端启动时 PATH 顺序相反。

PowerShell 通过这样加载 `profile.ps1`：

```text
pwsh -NoLogo -NoExit -ExecutionPolicy Bypass -File <profile.ps1>
```

profile 会在用户的 `$PROFILE` 跑完之后包住其 `prompt` 函数，让它发出 OSC 7 和 OSC 133 A/B/D。传给 ConPTY 之前 cwd 会被规范成反斜杠，因为 `CreateProcessW` 遇到正斜杠会出问题。

注入的脚本发出 **OSC 7**（cwd）与 **OSC 133 A/B/C/D**（提示符边界和退出码），这样 Terax 不用解析用户的提示符就能跟踪 cwd、识别命令边界。

## Windows 上的并发与进程生命周期

### `CONPTY_LIFECYCLE_LOCK`

`openpty + spawn_command` 及对应的关闭操作由 `session.rs` 里的一个静态互斥量串行化。并发的 ConPTY 生命周期调用会把新建的控制台搞坏，导致它的 shell 永远不输出。React 19 严格模式在开发环境下会双挂载 effect，所以首次渲染时两次启动可能相撞；这把锁让第二次等着。

### Job Object

每个 ConPTY 子进程都会被加入一个带 `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` 的 Windows Job Object（`modules/proc/job.rs`）。Job 句柄一旦释放（正常退出、panic、甚至 Terax 进程被强杀），内核就会杀掉这个 shell 的所有后代。没有它的话，`TerminateProcess` 只杀直接子进程，在 pwsh 里起的 `npm run dev` 会变成孤儿。

## 输入与转义序列处理

### DA 过滤器

PowerShell / PSReadLine 启动时会发一个光标位置查询（`ESC[6n`）并阻塞等回答。`DaFilter`（`da_filter.rs`）拦下这个查询并在 PTY 输入侧代为应答，避免 shell 卡住。

### agent 检测

reader 线程在字节流上跑 `AgentDetector`（`agent_detect.rs`）。它由 `OSC 133;C;<cmd>` 或自带的 `OSC 777` 标记触发，发出 `terax:agent-signal` 状态转换（`started`、`working`、`attention`、`finished`、`exited`）。检测**只认 OSC 序列**、从不看原始输出，所以不断重绘的 TUI 不会让状态来回跳。

会话同时记住当前运行的 agent 名字（`Session::web_agent`）。这既是"要不要去读 agent transcript"的闸门（昨天跑过 agent 的目录不该在今天的提示符上显示旧对话），也是选哪个后端去读的依据。

### 回车键

终端输入发的是 `\r`（CR），不是 `\n`（LF）。Windows 上的 PowerShell 要求 CR。

## 不变量

- 不验证"快速狂开标签页时首个标签是否稳定"，就不要移除 `CONPTY_LIFECYCLE_LOCK`。
- 在 Windows 上不要在没有替代孤儿守卫的情况下停用 Job Object。
- 传给 ConPTY 的 cwd 必须用反斜杠；到达前端的 OSC 7 cwd 则统一为正斜杠。
- PATH 上找到的 shell 必须是非零长度的可执行文件，应用执行别名要跳过。
- web 桥接共享同一个 `Arc<Session>`：广播在 flusher 里，新的消费者（手机观看者）必须走 `Session::web_subscribe`，不能自己私存一份字节流。

## 另见

- [`TERAX.md`](../../TERAX.md) - 架构事实来源
- [`docs/README.md`](../README.md) - 贡献者指南索引
- [双进程模型](two-process-model.md) - IPC 边界与命令目录
- [Web 终端桥接](web-terminal-bridge.md) - web 层如何消费这些会话
- [终端渲染器池](terminal-renderer-pool.md) - 槽位复用与 DormantRing
- [已知问题](../issues.md) - 这个子系统里已知的 bug 与债务
