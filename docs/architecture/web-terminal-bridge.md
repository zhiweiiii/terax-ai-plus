# Web 终端桥接

本文是 `TERAX.md` 的展开。与 `TERAX.md` 冲突时以 `TERAX.md` 为准。

内嵌在桌面应用里的一个 HTTP + WebSocket 服务，把同一批 PTY 会话暴露给手机浏览器。它是一个纯浏览器体验，不是 Tauri webview。

## 端口与进程

- 开发版绑 `34269`，打包版绑 `34268`，由 `cfg!(debug_assertions)` 选择，所以两者可以并存。
- 主二进制在两种 profile 下都叫 `terax-prod`（Cargo `[[bin]]`），热部署和打包脚本都引用这个名字。
- 服务跑在自己的 accept 线程上，从不阻塞 Tauri IPC。绑定失败只记一条警告，桌面应用照常工作。

## 手机页面

`web.html` + `src/web/main.ts` + `src/web/style.css` 通过独立的 vite 配置（`vite.web.config.ts`）构建成**一个自包含的 HTML 文件**：

1. `scripts/build-web.mjs` 跑 `vite build --config vite.web.config.ts`（输出到 `dist-web/`），再把 JS 和 CSS 内联成单个 HTML，写到 `src-tauri/web.html`。
2. Rust 侧用 `include_str!` 嵌入它，在 `GET /` 时返回。

桌面构建流程（热部署与打包脚本）会先跑 `build-web.mjs` 再编译 Rust，所以嵌入的页面始终是新的。

`热部署.ps1` 启动前会先腾出开发端口：**1420**（vite 开发服务器，`strictPort: true`，残留进程会让启动直接失败）、**1421**（vite HMR）和 **34269**。它**刻意不碰 34268**，也会跳过被 `target/release/terax-prod.exe` 占用的端口，所以重启开发环境不会杀掉正在运行的打包版。

页面是**对话视图**而不是终端，见 [手机端对话视图](mobile-conversation-view.md)。它一次连接一个桌面命令行。xterm.js 仍是依赖，但只当作无头 ANSI 解析器，不加载任何渲染器。

底部的输入区把文本加 `\r` 发给连接着的 PTY：shell、agent、REPL，另一端是什么都一样，并配一排软键盘没有的按键：Ctrl+C / Ctrl+D / Esc / Tab / Shift+Tab / 上下 / 回车。**空输入的回车也会发出去**：空回车不是空消息，它用来接受默认值、确认提示、翻页。

☰ 按钮打开**窗口切换器**：一个扁平可滚动的列表，每个分组（空间）的标签是一行，它的终端紧跟在下面，没有嵌套切换。点击某项即连接该终端；桌面还没打开过的终端显示为"未打开"，点它会通过服务端的 `opening` 流程把标签页热起来。

## 认证

访问由密码登录把关，凭据的存储方式见 [安全模型](security-model.md) 的"访问凭据"一节。要点：

- `GET /` 在访问者没有 `terax_web` cookie 时返回密码登录页。
- `POST /auth`（密码在请求体里，绝不放查询串）用 Argon2id 校验，限速：连续 5 次失败锁定 5 秒。
- 成功后设置 cookie：HttpOnly、SameSite=Lax、`Max-Age=604800`。
- WebSocket 升级会拒绝（403）没有有效 cookie 的客户端。并发连接上限 8。
- 密码校验只在 Rust 里发生，页面 bundle 里没有任何凭据。
- **服务绑定 `0.0.0.0`**：网络上能到达的任何人都能看到登录页。不是可信局域网就要放在防火墙或 VPN 之后。

## 桌面状态指示

状态栏右下角通过 `web_status` 命令显示服务健康度（`src/modules/statusbar/WebStatusBadge.tsx`，每 2 秒轮询）：监听中显示绿点，路由图标带实时连接数，钥匙图标带连续登录失败次数。命令读的就是服务维护的那几个原子量。

## WebSocket 协议（`/ws`）

### 客户端 -> 服务端

首个文本帧：

- `{"attach": <leafId>}` - 按 leaf id 连接某个桌面终端（不是 pty id，服务端负责解析映射）。**手机不发网格尺寸**：它不渲染终端，没有自己的尺寸诉求，强加一个只会缩放共享 PTY、让桌面屏幕在一个为它排版的程序下重排。可选的 `cols`/`rows` 仍然接受，留给真的会渲染网格的客户端。
- `{"list": true}` - 请求会话列表。

之后：

- 二进制 `'0' + bytes` - 写入输入。首次写入会 claim 会话（如果该客户端声明过网格）。没声明网格的客户端（手机）永远不会 claim 尺寸。
- 二进制 `'1' + JSON{"cols","rows"}` - 调整共享 PTY 尺寸。
- 文本 `{"attach": <leafId>}` - 切换会话。

### 服务端 -> 客户端

- 二进制 `'0' + bytes` - 终端输出。连接时**先发首屏**（桌面终端自己的缓冲区，序列化后的），然后才是实时数据。读取是非阻塞的：服务端以 10ms 节奏轮询完整帧，所以只看不打字的手机照样收得到输出，也不会因为闲置被断开。连续 90 秒一个字节都不发的对端（掉线、客户端崩溃）会被丢弃。
- 二进制 `'1' + bytes` - 窗口标题（UTF-8）。尚未实现。
- 文本 `{"type":"sessions","sessions":[...]}` - 每项带 `id`（leaf）、`cwd`、`title`、`active`、`live`、`space`。
- 文本 `{"type":"attached","id":N,"cols":C,"rows":R,"alt":bool,"seed":bool}` - 连接确认，带 PTY **当前**的网格（属于持有者的），让页面在任何数据到达之前先把解析器调好尺寸。`seed` 表示后面是否跟一个首屏帧；`alt` 只在**没有**首屏时才作为缓冲模式的依据：首屏自带模式（它自己会重新进入 alt 屏），在写入之前强设模式会把桌面的滚动缓冲写进错误的 buffer。
- 文本 `{"type":"transcript", ...}` - 连接着的会话的 agent 对话，读自 agent 自己的记录。见下文。
- 文本 `{"type":"resized","cols":C,"rows":R}` - 共享网格变了，每个观看者重新调整解析器尺寸。
- 文本 `{"type":"opening","id":N}` - 桌面正在启动这个标签页，页面稍后重试（最多 3 次，之后报失败）。
- 文本 `{"type":"exit","id":N,"code":C}` - 会话已退出。
- 文本 `{"type":"error","message":...}` - 包括 `output too fast, resubscribe`，观看者因跟不上被驱逐时发出（页面会重连，首屏会把它补齐）。

## 共享 PTY

桌面和 web 用同一个 `Arc<Session>`（`PtyState::web_get`）。`session.rs` 里的 flusher 线程：

1. 把每个数据块发给桌面的 Tauri Channel（既有路径）。
2. 广播给每个已连接的 Web 观看者（`Session::web_broadcast`，有界队列，慢速手机不会拖住 PTY；被驱逐的观看者会收到通知并重连）。

**Rust 侧不存储任何会话输出，没有历史环形缓冲。** 从两端来的输入写进同一个 `writer`，所以手机上敲的命令在桌面上也会回显，反之亦然。

## 首屏：观看者看到的第一屏

手机连接时看到的是**桌面终端自己的缓冲区**，现向窗口索取：

1. 服务端先订阅观看者，这样下一步期间产生的输出会排队而不是丢失。
2. 发出 `terax:web-snapshot`（`{leafId, requestId}`），最多阻塞 `SNAPSHOT_TIMEOUT`（1.5 秒）等回复。
3. 桌面（`useWebTerminalSync`）调 `snapshotLeaf(leafId)`，经 `web_snapshot_reply` 命令回传。持有渲染槽位的 leaf 走 `SerializeAddon` 实时序列化；已停靠的 leaf 用它释放时存下的快照加上此后到达的输出（`DormantRing.peek`）：正是桌面自己在面板回来时回放的那两块数据。
4. 服务端发 `attached`（`seed: true`），紧接着把快照作为一个输出帧发出。

序列化结果精确还原终端：滚动缓冲、当前屏，以及运行中全屏程序的 alt 屏（末尾用 `?1049h` 重新进入）。超时没有回复就没有首屏，手机从此刻起跟实时流（`seed: false`）。

**为什么不再自己存一份。** 以前服务端为每个会话保留一个 256 KiB 的滚动字节环。第二份输出必然和桌面显示的内容分叉：它熬过 `clear`，而且按**字节**封顶而终端按**行**封顶，所以一个空闲 shell 的环能横跨好几天。结果就是手机打开时冒出桌面早就没有的记录，然后又因为解析器自己的行数上限被从头裁掉。**桌面的缓冲区才是"这个命令行显示什么"唯一诚实的答案。**

第 1 步和第 3 步之间那几毫秒的输出可能既在首屏里又在队列里，所以繁忙会话可能在接缝处出现一小段重复。这是不让窗口替我们数字节的代价，是明确接受的。

## Agent transcript

编码 agent 说了什么，读自 agent 自己写下来的地方，而不是从屏幕上解析（`src-tauri/src/modules/transcript/`）：

| Agent | 数据源 |
|---|---|
| Claude Code | `~/.claude/projects/<转义cwd>/<session>.jsonl` |
| opencode | `~/.local/share/opencode/opencode.db`（SQLite，只读） |

两者归一成同一结构：带 `reasoning` 和 `tools` 的用户/助手轮次，加上会话的 `mode`、`model`，以及当前轮是否还在进行。**agent 的连续步骤会合并成一轮**：两个工具都是每次模型往返写一行，而读的人要的是答案不是机械过程。

三道闸门让空闲会话不产生开销：

1. **必须真有 agent 在跑。** PTY 自己的 OSC 检测（`pty::agent_detect`）记录启动了哪个 agent，会话通过 `Session::web_agent` 报出来。没有的话什么都不读：昨天跑过 agent 的目录，不该在今天的 shell 提示符上显示那段对话。
2. **文件指纹。** `transcript::fingerprint` 是对最新 transcript 文件（以及 opencode 的数据库和它的 WAL）做一次 stat。没变就不读。
3. **revision。** 只有最新时间戳变过的 transcript 才会被发送。

**700 毫秒轮询而不是监听**，因为其中一个后端是 SQLite，它的提交落在 WAL 里，没有任何文件系统事件能有意义地描述这件事。

**为什么直接读 opencode 的数据库。** 它运行中的 TUI 不监听任何端口，所以没有可连接的对象；`opencode export` 每次读取要起一个进程。数据库以只读方式打开、从不写入，运行中的 opencode 不受影响。它是 opencode 自己的存储、不是它承诺的接口，所以这里每条失败路径都降级成"没有 transcript"、让手机退回屏幕视图：表结构在我们脚下变了，不能把页面搞坏。

transcript 唯一不可能知道的，是程序**此刻**在等你选什么：待处理的权限提示是实时 UI 状态，两个工具都不持久化它。那部分留给屏幕解析。

## 网格所有权

一个会话只有一个网格，**谁在打字谁拥有它**（`SizeOwner`、`claim`、`request_grid`，带 3 秒 `OWNER_COOLDOWN`）。手机不声明网格，所以永远不会 claim：PTY 保持桌面的尺寸，程序按桌面正在显示的屏幕排版，从手机打字也不会让它重排。

桌面只在**真实按键**时收回所有权：xterm 的协议应答（焦点上报 `ESC[I/O`、对 TUI 调色板查询的 OSC 4 回复）虽然会转发给 PTY，但刻意不触发 claim，否则一个被旁观的会话会在每次 claim 之后在两端尺寸之间来回跳（`looks_like_protocol_response`）。

字节流是按**持有者的网格**排版的（应用按那个宽度折行、用 `\r` 原地重绘、用绝对光标序列定位单元格），所以只能在那个网格下解析。手机因此**按 PTY 当前的 `cols`/`rows` 解析**（`attached` 带着它，`resized` 跟踪每次变化），但**完全不渲染网格**：它把逻辑行提取出来，按手机自己的宽度重新折行。服务端在首屏**之前**发送 `attached` 的尺寸，先把解析器调好：用错误的宽度写入桌面缓冲区会让每一条折行都错位。

每个连接用自己的 `SyncSender` 订阅，断开时精确移除该订阅；跟不上的观看者会被驱逐并被告知重新订阅。

## 标签同步

`App.tsx` 里的 `useWebTerminalSync`：

- 标签列表变化时，通过 `web_sync_tabs` 把每个终端标签页（leaf id、cwd、标题、是否活动、pty id、空间名）同步给 Rust。
- 监听 `terax:web-activate`：手机连到一个没有活 pty 的标签页时，服务端发出该事件，前端激活那个标签（走正常的 `pty_open` 流程起 pty）。
- 监听 `terax:web-snapshot`：交回该 leaf 的终端缓冲区，用作首屏。
- `pty_open` 通过 `web_sync_leaf_pty` 记录 leaf 到 pty 的映射，之后的连接请求可以直接解析。

手机的会话列表按空间名分组。

## 另见

- [手机端对话视图](mobile-conversation-view.md) - 字节流和 transcript 如何变成气泡
- [PTY shell 集成](pty-shell-integration.md) - 被共享的这些会话本身
- [安全模型](security-model.md) - 认证边界与凭据存储
