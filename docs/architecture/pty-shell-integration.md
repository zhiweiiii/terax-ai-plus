# PTY shell 集成

## 桌面输入等待与顺序（2026-10-08）

pty_write 原先是同步 Tauri 命令，等待 ConPTY writer 或慢读程序时可能占用界面线程。现在复制有界 raw 输入后将尺寸 claim 和 write_all 移到 blocking 池，注册表锁只用于获取 Session，不跨等待持有。单次原生输入限 4 MiB，已退出和锁异常明确失败。

异步写入不能靠后台线程抢 mutex 决定输入顺序，因此前端每个 PtySession 串行提交，最多一条写 IPC 在途；所有等待输入共限 4 MiB 与 2048 条，失败不阻断后续独立写入。关闭或退出后排队输入不再 invoke，队列随完成释放容量。raw bytes 和 PTY ID header 保持不变，不将不同协议帧合并，也不修改光标或 IME。exit 回调即使抛错也释放 channel handler。

实际 bridge 模块隔离验证两条输入顺序、失败恢复、单条/总字节和条数限制、容量回收、关闭取消及异常 exit 清理，通过。原生 clippy/fmt 通过；没有以真实 Windows Codex/Claude 运行验证替代记录，也不将此项描述为所有光标/卡顿问题唯一根因。

## 原生附件进入 WSL

Windows 文件拖入和剪贴板截图路径先按目标 Session 保存的环境转换，仅 WSL 的 Windows 原生路径调用 `wsl_native_paths`，本机和已经是 Linux 路径时零额外 IPC。依据 [Microsoft WSL 路径转换说明](https://learn.microsoft.com/en-us/windows/dev-environment/wsl-interop)，使用发行版内的 `wslpath -a -u`，不硬编码可配置的 automount 根目录。Windows 路径是固定 sh 脚本的位置参数，不拼进源码，转换后仍按实际 shell/agent 引用。

同发行版 wsl$/wsl.localhost UNC 直接还原 Linux 路径，其他发行版明确拒绝。单批最多 128 个路径和 24000 个 UTF-16 单元，拒绝控制字符；子进程复用隐藏窗口、Windows Job、30 秒期限和 64 KiB 输出限制，文件 IO/进程等待在 blocking 池。完成时检查同一 Session/PTY，重启或关闭的旧结果不粘贴。纯路径计划与前端 Session 边界已隔离验证，实际 WSL 子进程未执行。

Codex TUI 由 xterm 原生渲染和定位输入法。曾经的自定义输入锚点改写 xterm 私有接口，在用户环境出现输入卡顿和画面延迟刷新，现已移除。输出回调不额外计算输入光标位置，也不通过定时强制重绘正文。

本文是 `TERAX.md` 的展开。与 `TERAX.md` 冲突时以 `TERAX.md` 为准。

## 会话模型

OSC 中的 agent 命令识别只检查执行位置，普通参数里出现 codex/claude 不会误标；兼容带引号的 Windows 路径、常见 CLI 扩展名、包装命令和复合命令。恢复 ID 沿用同一词法切分与会话列表的 UUID 校验，不从一整段引号参数里推测 resume。它是保守的启动提示，不执行或完整解释任意 shell 脚本。

PTY 缺少有效 Job 时启动失败并清理，不保留无树级回收保护的 shell。reader/flusher/waiter 线程启动失败会终止进程并唤醒输出线程；PowerShell prompt 在集成函数执行前保存原始成功状态。

ConPTY 的 master 用所有权包装串行关闭，最后引用即使在手机或输出线程释放也必须取得创建/关闭锁。关闭终端或 shell 退出时主动终止 Windows Job，避免其他 Arc 引用延迟回收后代。只有输出线程发送正文，退出等待它排空后才发送通知。初始化脚本使用独立临时文件原子替换，多进程启动不共享临时文件名。

WSL 探测子进程有 30 秒期限和每路 64 KiB 输出上限，失败与超时清理 Windows 启动器。运行状态读取 `--running --quiet`，不解析本地化的状态词。原生 macOS/Linux 初始化已删除，WSL 内 Bash/Zsh/Fish 和 Windows Git Bash 仍保留。

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

blocks 终端只在主缓冲区消费 OSC 133 来切换底部 shell 输入栏。全屏 TUI 在 alternate screen 内也可能发出同类序列，但它们不代表 PowerShell 的提示符边界；`BlockDecorations` 会忽略它们。inline TUI 也可能发出伪 prompt 标记，因此 prompt 不会立即移交焦点，而是经 `pty_has_foreground_job` 确认前台任务已经退出，并核对检查开始时的命令代次；每个新的 C 标记都作废旧检查，即使模式已经是 running。这样 Codex 等持续重绘的 TUI 不会在运行中让底部输入栏与终端 textarea 争抢焦点，IME 候选窗也不会在两处跳动。

shell 提示符的独立输入栏通过 `disableStdin` 接管光标；前台命令运行时把焦点交给 xterm。Codex 的可见光标、隐藏 textarea 和 IME composition view 均由 xterm 自身维护，Terax 不修改其私有接口。终端历史使用 xterm 的 slider，alternate buffer 隐藏外层历史滑块。

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

PowerShell 的 C 标记增加内部 `terax-start=<epoch-ms>;` 前缀，时间在命令启动前捕获，避免 reader 稍后处理时新 rollout 已经创建。前端剥掉该前缀，不显示在命令标题中。恢复命令同时提取 UUID；PTY 记录 agent 名字、恢复 ID、启动时间和固定文件，查找文件不持有 reader 使用的 agent 锁。

会话同时记住当前运行的 agent 名字（`Session::web_agent`）。这既是"要不要去读 agent transcript"的闸门（昨天跑过 agent 的目录不该在今天的提示符上显示旧对话），也是选哪个后端去读的依据。

### 回车键

终端输入发的是 `\r`（CR），不是 `\n`（LF）。Windows 上的 PowerShell 要求 CR。

## 不变量

Fish 初始化在未启用或重复加载时只返回当前脚本，不退出整个 shell；调用用户 prompt 前才恢复上一命令状态，避免函数存在性检查把失败状态改成成功。

- 不验证"快速狂开标签页时首个标签是否稳定"，就不要移除 `CONPTY_LIFECYCLE_LOCK`。
- 在 Windows 上不要在没有替代孤儿守卫的情况下停用 Job Object。
- 传给 ConPTY 的 cwd 必须用反斜杠；到达前端的 OSC 7 cwd 则统一为正斜杠。
- PATH 上找到的 shell 必须是非零长度的可执行文件，应用执行别名要跳过。
- web 桥接共享同一个 `Arc<Session>`：广播在 flusher 里，新的消费者（手机观看者）必须走 `Session::web_subscribe`，不能自己私存一份字节流。


## 输入栏粘贴

RendererPool 的 pasteIntoLeaf 在终端禁用 stdin 时由 SlotAdapter.pasteLeafInput 路由到 Session。shell 输入栏登记 leaf 的粘贴回调，用公开 CodeMirror replaceSelection 更新草稿；没有挂载输入栏时保存到所属 leaf 的草稿，不发给 PTY。运行态继续用 xterm 原生 bracketed paste。退出、销毁或输入归属不为 shell 的会话拒绝走输入栏。提交结果为 boolean，拒绝时保留草稿。

每个 Session 保存终端所属空间的 WorkspaceEnv 副本，由 TerminalStack 经面板树传递，不能在异步启动或重启时再读取全局当前环境。缺失空间归属的标签不启动；切换空间不改变已有后台 shell 的运行环境。

终端及 block 搜索由 searchBufferLine 将匹配位置映射到公开 xterm 单元格列与宽度，不能使用 UTF-16 下标作为列。中文宽字符、组合字符、代理对与小写展开共享同一映射，仅在实际命中的行创建列索引。


输入栏的草稿随编辑同步写入所属 leaf，切换时重置撤销历史；历史弹层和行内建议按请求代次拒绝关闭、编辑或销毁后的旧响应。启动和退出回调按 Session 身份与启动代次隔离，避免旧 shell 干扰新 shell。重启返回实际成功状态，启动期间不重复启动；调用方不能将拒绝或启动失败显示为切换成功。

## 实际 shell 与路径输入

shell_init::build_command 同时返回命令和引用类型，Session 保存 shell_kind；pty_open 的结果为 `{ id, shellKind }`，不额外探测或按全局 shell 设置猜测。类型区分 PowerShell、POSIX、fish、cmd 和未知；WSL 根据实际登录 shell 判断。前端在异步剪贴板读取完成后才按目标 Session 引用路径，拖放也走同一路径；agent 提示词路径不使用 shell 引号规则。

quoteForShell 拒绝控制字符。PowerShell 以单引号引用并加倍 ASCII/弯单引号，避免 `$()`、变量及弯引号重新参与语法；POSIX 和 fish 分别处理单引号与反斜杠。cmd 的 `%`/`!`/双引号没有采用不可靠替换，而是拒绝并提示使用 PowerShell。未知/未启动 shell 不自动输入路径。目录切换使用 shell 专用字面路径命令，新终端通过启动 cwd 设置目录，不使用计时器补发命令。

后台一次性本机命令只接受 PowerShell，缺失时明确失败；WSL 使用 sh，调用方绑定 WorkspaceEnv 并按该语法引用。交互 cmd 终端仍然支持。Windows 原生路径进入 WSL 的文件系统转换独立于引用，需要另行验证，不能仅凭引号正确认为路径可访问。

## 另见

- [`TERAX.md`](../../TERAX.md) - 架构事实来源
- [`docs/README.md`](../README.md) - 贡献者指南索引
- [双进程模型](two-process-model.md) - IPC 边界与命令目录
- [Web 终端桥接](web-terminal-bridge.md) - web 层如何消费这些会话
- [终端渲染器池](terminal-renderer-pool.md) - 槽位复用与 DormantRing
- [已知问题](../issues.md) - 这个子系统里已知的 bug 与债务
