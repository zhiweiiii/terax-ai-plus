<div align="center">
  <img src="public/logo.png" width="144" height="144" alt="terax-ai-plus" />
  <h1>terax-ai-plus</h1>

  <p><strong>终端优先的轻量开发工作区。</strong></p>
  <p>
    <img src="https://img.shields.io/badge/platform-Windows%20%7C%20WSL-lightgrey" alt="platform" />
    <img src="https://img.shields.io/badge/license-Apache--2.0-blue" alt="license" />
  </p>
</div>

---

> **本项目基于 [crynta/terax-ai](https://github.com/crynta/terax-ai) 修改。**
> 上游以 Apache License 2.0 授权，本仓库沿用同一许可证（见 [LICENSE](LICENSE)）。
> 下文「这个分支做了什么」一节即是对原作品所做改动的说明。
> 名称与图标属于上游项目，本分支使用 `terax-ai-plus` 以示区分。

terax-ai-plus 是一个终端优先的轻量开发环境，基于 Tauri 2 + Rust 与 React 19。原生 PTY 后端配 WebGL 渲染，内置代码编辑器、文件浏览器、带 git 图的版本管理和网页预览。还有一个内嵌的 Web 桥接，把同样的终端暴露给手机浏览器，用密码保护。无遥测，无账号。

## 截图

<table>
  <tr>
    <td align="center"><img src="docs/terminal.png" alt="终端" /><br/><sub>原生 PTY 终端，WebGL 渲染</sub></td>
    <td align="center"><img src="docs/ai-workflow.png" alt="AI 工作流" /><br/><sub>终端里的编码 agent</sub></td>
  </tr>
  <tr>
    <td align="center"><img src="docs/source-control.png" alt="版本管理" /><br/><sub>版本管理与 git 图</sub></td>
    <td align="center"><img src="docs/editor.png" alt="编辑器" /><br/><sub>代码编辑器</sub></td>
  </tr>
  <tr>
    <td align="center"><img src="docs/web-preview.png" alt="网页预览" /><br/><sub>本地开发服务器的网页预览</sub></td>
    <td align="center"><img src="docs/themes.png" alt="主题" /><br/><sub>自定义主题、预设与背景图</sub></td>
  </tr>
</table>

## 这个分支做了什么

改动集中在两处：**把手机端从"看终端"变成"用 agent"**，以及**把桌面端一批半成品补完**。

### 手机端：读 agent 自己的记录，而不是解析屏幕

原本手机端是把 TUI 的屏幕当图片解析出对话。这条路能走通，但它解析的是一张画：侧边栏会被读成发言，转圈动画会被读成句子，工具改一次布局就坏一次。真实测下来，opencode 的右侧信息栏（会话名、token 数、花费、LSP 状态、cwd、分支）和对话画在同一批行上，读成文本就会互相穿插。

现在改为直接读 agent 自己写下来的记录：

| Agent | 数据源 |
|---|---|
| Claude Code | `~/.claude/projects/<转义cwd>/<session>.jsonl` |
| opencode | `~/.local/share/opencode/opencode.db`（SQLite，只读） |

两者归一成同一结构：用户/助手轮次、agent 的思考、调用的工具、模式、模型、当前轮是否在进行。谁说了什么是**被声明的**，不是猜出来的。

屏幕只保留一件 transcript 不可能知道的事：**程序此刻在等你选什么**。权限提示和选项菜单是实时 UI 状态，两个工具都不会持久化它，所以那部分仍由屏幕解析，并渲染成可点击的按钮：手机上点一下比调出键盘敲一个数字好。

配套的改动：

- **首屏内容取自桌面终端自己的缓冲区**，而不是服务端另存一份输出。另存的那份必然和桌面分叉（它熬过 `clear`，而且按字节封顶而终端按行封顶），结果就是手机上冒出桌面早就没有的历史，然后又消失。
- **手机不再强加自己的网格尺寸**。它本来就不渲染终端，之前那个 120x40 的偏好会在手机打字时把共享 PTY 缩放掉，桌面的屏幕跟着重排。
- **正在进行的那一轮从屏幕补上**。agent 是在一步结束时才写记录，所以在那之前只有屏幕上有内容。
- 气泡按 Markdown 渲染（代码块、列表、行内代码）。**自己建 DOM 节点，不引库也不用 `innerHTML`**：这个页面持有认证 cookie 并直连一个活的 PTY，把 agent 输出当 HTML 插进去就是把防线让开。
- 滚动不再被吸在底部，可以往回翻历史。

### 桌面端

- **git diff**：新增「完整文件 / 仅变动」折叠开关；选中文字可以连同文件名一起发给 agent（和编辑器里一致）。
- **文件树**：工具栏新增过滤菜单，可切换隐藏文件与 git 忽略的文件。
- **终端右键**：不再弹出 webview 的默认菜单；按终端惯例，有选中就复制，没选中就粘贴。
- **手机访问密码可以修改**了。原本是编译期常量，改不了；现在用 Argon2id 加盐存储，改密码同时轮换会话令牌，已登录的手机会被登出。
- **Claude Code 参数面板**（状态栏左侧）：把 endpoint、token、模型写进当前命令行，并记住用过的配置一键复用。token 用 Windows DPAPI 加密后才落盘。

### 修掉的一些根因

- **偏好设置从不初始化**：`init()` 只写在"首次运行、无已保存工作区"的分支里，所以任何用过一次的安装，主窗口里约 36 处设置全被钉在默认值，写进去的设置也传不回来。
- **打包版终端无法输入**：`which` 只判断"是不是文件"，而微软商店的应用执行别名正是一个 0 字节的重解析点；ConPTY 走 `CreateProcessW` 不解析它，起出来的 shell 是死的。现在要求命中项必须是非零长度的文件。
- **只发 NSIS 安装包**。MSI 把图标解压到 `C:\Windows\Installer\{每次都变的 ProductCode}\`，重装后任务栏固定项的图标就指空了。
- **编译产物从 40 GB 降到 3 GB**：全量 debuginfo 是 23 GB `deps` 的成因，dev profile 改为 `line-tables-only`、依赖 `debug = false`。

细节见 [架构文档](docs/README.md) 与 [已知问题](docs/issues.md)。

## 安装

从本仓库的 Releases 页面下载 `.exe` 安装包。

> 只提供 NSIS（`.exe`）安装包，不提供 MSI，原因见上文。首次安装时选择的目录会被记住，之后升级不会再问。

### Windows 说明

- 默认 shell 探测顺序：`pwsh.exe`（PowerShell 7+）-> `powershell.exe`（Windows PowerShell 5.1）-> `cmd.exe`。命中项必须是非零长度的可执行文件，商店的应用执行别名会被跳过。
- WSL 是一等的工作区环境，不是被包装的子进程。

## 从源码构建

**依赖**
- Rust（stable），https://rustup.rs
- Node 20+ 与 [pnpm](https://pnpm.io)
- Windows 下的 Tauri 前置依赖，https://tauri.app/start/prerequisites/

**运行**
```bash
pnpm install
pnpm tauri dev          # 开发（Web 桥接端口 34269）
pnpm tauri build        # 生产打包（Web 桥接端口 34268）
```

**检查**
```bash
pnpm lint
pnpm check-types
cd src-tauri && cargo clippy --all-targets --locked -- -D warnings
node scripts/web-synthetic-test.mjs   # 手机端解析器回归测试
```

## 技术栈

Tauri 2、Rust、`portable-pty`、React 19、TypeScript、Vite、xterm.js、CodeMirror 6、Tailwind v4、shadcn/ui、Zustand。上游之外新增：`rusqlite`（读 opencode 的会话库）、`argon2`（手机访问密码）。

## 许可证

Apache License 2.0，见 [LICENSE](LICENSE)。本项目为 [crynta/terax-ai](https://github.com/crynta/terax-ai) 的修改版本，原始版权与许可声明一并保留。
