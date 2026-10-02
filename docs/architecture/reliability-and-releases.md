# 可靠性与发布

本文展开 TERAX.md，覆盖 2026-09-30 的可靠性整理。不修改 Codex 的默认启动参数或 TUI 显示方式。

## 终端输入归属与诊断

`terminalInputOwner` 只返回 shell 提示符输入栏、xterm 或无输入。正常退出禁用输入，异常退出保留 xterm 的回车重启入口。运行中的 TUI 不由输出回调反复移动焦点。

`syncLeafInput` 统一同步公开 `disableStdin` 与 textarea 的 disabled 状态；仅在需要且 textarea 确实持有焦点时 blur。槽位创建仍有初始设置，绑定后按会话策略同步。启动、重启和退出同样遵循策略。

blocks 的 prompt 经过前台任务检查，检查绑定 `promptEpoch`。新命令 C 标记、重启、退出使旧代次失效；晚到的“没有前台任务”不能覆盖新命令。xterm 光标和 composition view 保持原生，不使用私有补丁或定时强制刷新。

主窗口开发者控制台可调用：

```js
window.__teraxTerminalDiagnostics.enable()
window.__teraxTerminalDiagnostics.snapshot()
window.__teraxTerminalDiagnostics.disable()
```

默认关闭，无定时器、落盘或输出正文采集。开启后最多记录 256 个事件：PTY 字节数、公开光标坐标、render 行范围、尺寸、可见性、焦点、composition start/end。snapshot 同时返回已有资源统计，disable 清空记录。该入口供可打开开发者工具的环境使用，不是用户界面遥测开关。

排障看同一 leaf 的 output、parsed、render 是否连续，以及 mode/focus 是否意外切换，用来区分数据停止、解析停止和绘制停止，不能替代 Windows IME/Codex 真机复核。

## 会话绑定与缓存

PowerShell 在命令启动前发出带时间的内部 C 标记，恢复命令 UUID 一并记录。Claude/Codex 文件必须核对 cwd，Claude 的有损目录名不是身份凭据。

明确恢复 ID 按 ID 找文件。新会话只选择启动后创建的唯一匹配文件，固定到本次 agent 退出。读取结束再次核对运行代次，IO 期间换 agent 不推送旧快照。多个候选、没有 cwd、交互式 picker 恢复旧文件而命令中无 ID，继续使用屏幕视图，不按最新 mtime 猜测。唯一新文件仍是保守发现机制，不是 CLI 提供的进程身份接口。

历史目录索引最多 32 项，扫描有效期 2 秒；头部缓存最多 512 项，每次读最多 192 KB。菜单不开不扫描，绑定成功后不再扫描历史目录。

每种 JSONL 读取器共享最多 8 个文件缓存，以文件偏移增量读取。状态未变直接返回缓存 Arc。未结束的行和分段 UTF-8 不提前消费；长度缩短、创建时间变化、同长度重写重置解析。针对追加日志，不检测保持文件状态不变的任意原地篡改。

最多保留最近 600 个原始消息步骤，再合并助手轮次；旧工具索引随裁剪调整。单条记录上限约 16 MiB，超大记录跳过；工具结果仍裁剪至 10 行/800 字节。缓存限制按文件数/步骤数，不是严格总字节内存限额。首次加载仍扫描文件，以后只读新增内容。

JSONL revision 是进程内单调代次，不是时间戳，同时间工具结果也推送。发送身份包括 agent、session ID、revision；退出或来源不可读发送 transcriptClear。opencode 保留 SQLite/WAL 指纹路径。

Claude 用户记录兼容带或不带 origin 的格式；工具结果、isMeta、压缩摘要不当作用户发言。

## 手机提交确认

非空输入使用 `{submit:{id,text,leafId}}`，校验请求编号、64 KB 上限及附着目标，writer flush 后返回 writeAck。Codex 使用 bracketed paste 再回车，其他程序普通文本再回车。

确认只表示写入 PTY，不表示 agent 已读取、接受或执行成功。确认前禁用发送按钮，仍可编辑输入；成功只清空仍等于已发送内容且仍在同一终端的草稿。

失败、断线或 15 秒超时保留内容，不自动重发。未确认内容在同一终端重试复用编号，同一 PTY 缓存最近 128 个结果，失败也缓存以避免部分写入后重复执行。不保证跨 PTY 重启、浏览器刷新或缓存淘汰的 exactly-once。结果未知先检查终端，避免改内容重发造成重复。空回车及控制键仍走原始输入。

## 本仓库更新渠道

默认构建不生成 updater artifacts。公开 GitHub API 查询 `zhiweiiii/terax-ai-plus` 最近 20 条 release，排除 draft/prerelease、非三段版本和安装包版本不符的记录，按数值版本排序。`build-v0.9.5` 与 `v0.9.5` 都可识别，只提示比当前版本新的 Windows NSIS 包。

手动模式打开固定仓库 release 页面，用户下载 exe 覆盖安装。API 限流和网络失败在设置的关于页面显示错误，不伪装成已是最新版。

Release 工作流默认生成 draft，需维护者正式发布。只构建 Windows NSIS，不再请求 MSI 或上游 SignPath。

签名更新需在自己的 GitHub 仓库同时配置：

- Secret `TAURI_SIGNING_PRIVATE_KEY`。
- Variable `TERAX_UPDATER_PUBLIC_KEY`。
- 有密码时配置 Secret `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`。

只配置其中一项直接失败，两项都未配置则手动发布。完整配置后生成 runner 临时 Tauri overlay，启用 updater artifacts，并传入 `VITE_TERAX_SIGNED_UPDATES=true`。端点是本仓库 latest.json，不使用上游公钥。签名接口报错时退回手动版本检查，绝不自动安装未验证产物。

本地签名构建同样需自己的公钥 overlay、私钥和前端环境变量；只设置私钥不能启用自动更新。手动版迁移需先手动安装签名版。当前环境没有配置私钥并实际验证签名发布路径。

## 清理与验证范围

删除确认无调用的直接依赖、notification 原生插件/权限、Linux clipboard capability、旧分块和非 Windows 包配置。字体仍由 CSS 使用，Tauri CLI 由脚本动态调用，LSP shim 被 Vite alias 引用，不能按误报删除。

`pnpm knip --include 'files,dependencies,unlisted,unresolved'` 做结构检查。默认完整 Knip 仍报告现有公共 barrel/内部帮助函数 exports/types，不等同于业务实现无人使用。包装脚本禁用 raw transfer，避免 Windows 本机大 ArrayBuffer 分配失败。

仓库不保留测试用例。通过 lint、TypeScript、Rust clippy、前端构建及临时运行模拟验证；模拟覆盖竞态和缓存边界，不能宣称已经证明真实设备光标稳定。
