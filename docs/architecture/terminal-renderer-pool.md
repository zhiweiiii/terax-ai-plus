# 终端渲染器池

本文是 `TERAX.md` 的展开。与 `TERAX.md` 冲突时以 `TERAX.md` 为准。

## 为什么要有池

终端标签页切走之后仍然保持挂载、只是隐藏，这样 PTY 和开发服务器能在后台继续输出。但如果活的 xterm + WebGL 渲染器实例数量不设上限，内存会兜不住，所以 Terax 复用渲染槽位。

池在 `src/modules/terminal/lib/rendererPool.ts`。

## 槽位生命周期

- `POOL_MAX_SIZE` 是 5。每个槽位拥有一个 xterm `Terminal`、`FitAddon`、`SerializeAddon`，以及可选的 `WebglAddon`。
- 槽位按需创建，绑定时分配给某个 leaf。
- `releaseSlot` 把槽位从 leaf 上解绑。leaf 空闲的话，槽位会被停靠（`display:none`），xterm 停止渲染但继续解析 PTY 字节。
- 空闲槽位过了宽限期可能被回收，以控制池的大小。

## 停靠与释放的区别

leaf 被隐藏时：

1. `parkLeafSlot` 把宿主设成 `display:none`。渲染暂停，但活的缓冲区继续收字节。
2. leaf 如果**忙**（有前台命令、有 agent 信号、在 alt 屏 TUI 里、或块模式 shell 正在运行），槽位无限期保持停靠。
3. leaf 如果**空闲**，`HIDDEN_RELEASE_DELAY_MS` 之后调 `releaseSlot`：清掉 `currentLeafId`、置上 `retainedLeafId`，缓冲区仍然是活的。

leaf 重新可见时，`acquireSlot` 按顺序找：

1. 已经绑在这个 leaf 上的槽位。
2. 为这个 leaf 保留着的槽位（`retainedLeafId === leafId`）：快速路径，不需要回放快照。
3. 干净的空闲槽位。
4. 池已满时，淘汰得分最低的槽位。淘汰前会先用 `SerializeAddon` 把被保留的缓冲区序列化成快照，再抢走槽位。

## DormantRing

`src/modules/terminal/lib/dormantRing.ts` 为**完全没有槽位**的 leaf（被抢走的，或者从没绑过的）缓冲 PTY 字节。上限 1 MiB，溢出时丢最老的块。排空时从下一个换行边界开始，而不是重置终端，这样一条被截断的转义序列不会从中间被回放出来。

`peek()` 是不消耗的读取：Web 桥接给手机做首屏时要读这些字节，而桌面在面板回来时还得再渲染同样的字节。

## "命令执行中绝不序列化"这条不变量

这是池里最重要的一条规则。**正在执行命令的 leaf 绝不能被序列化。** 把 TUI 的增量重绘回放到一张过期快照上，正是当初把 Claude Code 界面搞乱的原因。

代码上靠两件事保证：淘汰前检查 `isLeafBusy`；以及只要 `commandRunning`、`isAgentActivePty` 或 alt 屏为真，槽位就保持停靠而不释放。

## 快速路径与快照回放

如果这个 leaf 还有保留着的槽位，`bindSlot` 会跳过 `term.clear()` / `term.reset()`，直接把 DormantRing 排进活的缓冲区，省掉重新渲染一大张快照。

如果只剩快照，`bindSlot` 清空终端、调整尺寸、写入快照，再排空 ring。对 alt 屏 TUI 则跳过快照，改为发一个 SIGWINCH，让 TUI 自己从头重绘：它的输出是增量的光标定位指令，叠在旧快照上没有意义。

## WebGL 生命周期

WebGL addon 在槽位可见时创建，停靠一段时间后回收。休眠唤醒或 GPU 重置导致上下文丢失时，addon 能自行恢复。

## 不变量

- 池不能无限增长，上限是 `POOL_MAX_SIZE`。
- 正在执行命令或处于 alt 屏的 leaf，绝不序列化、绝不淘汰。
- 隐藏但忙碌的 leaf，保留活的网格并停靠（`display:none`）。
- 隐藏且空闲的 leaf 释放槽位，但缓冲区继续解析字节。
- DormantRing 只为完全没有槽位的 leaf 缓冲。

## 另见

- [`TERAX.md`](../../TERAX.md) - 架构事实来源
- [`docs/README.md`](../README.md) - 贡献者指南索引
- [PTY shell 集成](pty-shell-integration.md) - 会话、OSC 序列与 ConPTY
