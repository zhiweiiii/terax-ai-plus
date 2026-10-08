# 1.0 发布前审查

## 1.0.0 正式发布准备

发布完成于 2026-10-08 12:16（Asia/Shanghai）：[Terax 1.0.0](https://github.com/zhiweiiii/terax-ai-plus/releases/tag/v1.0.0)，tag 指向 `d8b3ae0`。GitHub 状态为非草稿、非预发布且为 latest，安装包上传大小与服务端 SHA256 一致，公开下载再次核对 SHA256 通过。发布文档后续补记不移动正式 tag。

本机 `pnpm tauri build` 成功，NSIS 安装包 5124384 字节，程序 FileVersion/ProductVersion 均为 1.0.0，SHA256 为 `ca375ca4e242492ab9eaf676285f035db18c96799911d453c19780808b7e31f1`。发布前 lint、类型、Rust fmt/clippy、结构 Knip、生产 audit 与体积检查通过。README 按用户要求重写为 Claude Code/Codex 开发导向，并增加 Windows 终端区域实图和当前手机页面截图；手机内容为模拟协议的公开演示，不是真实模型会话。旧上游 macOS/已移除功能截图不再用于首页介绍，未删除历史图片资产。

用户在代码提交推送后确认测试没有问题，并授权发布正式 1.0。此确认是用户验收结论，不将此前未由审查者运行的真实设备场景补记为审查者已测。四份版本清单及三个 Rust workspace 包统一为 1.0.0，构建使用现有 tag 模式固定版本，避免本地增号成 1.0.1。发布 Windows x64 NSIS 安装包，沿用手动下载安装渠道，不生成未配置签名的自动更新产物。安装包成功后核对版本、大小与 SHA256，再发布非草稿、非预发布的 GitHub Release；实际结果以 GitHub 为准。

## 当前结论（2026-10-08 10:58，Asia/Shanghai）

代码侧审查与修复收尾完成。覆盖表共 467 个条目，442 个现存文件全文分析、25 个全文分析后删除；依赖锁按差异与安全公告检查，生成产物不作为手写源码逐行阅读。最新源码清单没有漏项，覆盖表行数和删除路径再次核对通过。下面保留的分批进度描述是当时记录，以本节为当前状态。

最终两轮是在源码修复完成后分别重跑的全仓工程检查与关键行为回归，不表示逐行阅读两次，也不代替真实设备验收。第一轮完成于 10:56，第二轮完成于 10:58；两轮之间没有业务源码修改。

| 复核项 | 第一轮 | 第二轮 |
|---|---|---|
| pnpm lint / check-types | 通过，lint 无错误或警告 | 通过，lint 无错误或警告 |
| cargo fmt / clippy --all-targets --locked -D warnings | 通过 | 通过 |
| Knip files/dependencies/unlisted/unresolved | 通过 | 通过 |
| 生产依赖 audit，临时指定官方 registry | 无已知漏洞 | 无已知漏洞 |
| 7 个 Node / 4 个 PowerShell 脚本语法 | 通过 | 通过 |
| 手机构建 / 桌面构建 / size-limit | 通过 | 通过 |
| 主窗口 / 设置窗口 eager 导入图 | 通过 | 通过 |
| 实际组件与独立 Edge 行为复核 | 通过 | 通过 |
| 清理/热部署脚本真实函数，变更操作 mock | 通过 | 通过 |
| 覆盖表 / 四份版本清单 / diff --check | 通过 | 通过 |

两轮实际组件回归覆盖新文件路径/IME/重复提交/失败重试/重开 ABA、背景 URL 与事件/动画回收、远程管理的查询和写入范围、命令面板主题预览清理。真实 Edge 联合 React/Streamdown 验证 Markdown 内容、表格、相对/裸/父目录链接及危险协议拦截；真实 CodeMirror 验证定位面板、颜色控件/alpha/只读和 Markdown checkbox。临时验证不在仓库保留，独立浏览器已经退出。其他专项行为的验证范围见下方各批记录，没有将 mock IPC 写成真实 CLI 验收。

两个构建的产物名称及生成 CSS 一致。手机内嵌页 472033 字节；主窗口 eager JS 为 364.94 kB gzip，全部客户端 JS 为 1.27 MB gzip，分别低于 540 kB / 1.5 MB 预算。这是产物体积，不是运行内存。设置入口未 eager 引入被监控的重型 JS 依赖。Knip 唯一提示为可移除生成 UI ignore，保留现有原语保护约定；这不是未使用文件报错。第一轮 Knip 参数引用和临时 fixture 的 PowerShell 5 编码调用错误已用正确引号及 PowerShell 7 重跑通过，未改业务源码。

### 发布前仍须实机验收

- Windows 实际 Codex/Claude 高输出、长时间输入/删除/IME、切换标签、滚动、重启与进程退出。现保持原生 xterm，不承诺历史光标/停刷问题已经在用户环境消失。
- 真实 WSL 发行版的启动、路径/附件与文件监听；本轮没有启动用户 WSL。
- iOS Safari 与实际手机键盘、网络断连重试和长对话；已有手机尺寸 Edge 验证不能替代这些设备。
- 原生安装/升级/覆盖安装、签名更新与实际 CLI 后台定时任务；未调用付费模型、未改用户任务或凭据。

接受的边界仍保留：跨窗口设置读改写不是事务，外部 Git/文件进程不受应用门闩控制，mtime 检查不是严格事务锁，复杂差异预算耗尽可退化，手机超限会明确断连重新同步。详见架构和 issues。不能因两轮检查通过宣称没有任何 bug。

未提交、推送、打包或发布，版本保持 0.9.7。1.0 正式发布尚需上述实机验收与发布操作，本节仅登记代码审查的完成状态。

## 2026-10-08 继续复核

最后生产依赖审计发现新发布的 KaTeX 低风险通告，官方来源及风险条件已核对，见 security-model.md。升级 Streamdown 2.7.0 消除原 Mermaid/KaTeX 依赖链，不做不兼容的单项 override；frozen-lockfile 安装及生产 audit 通过，无关开发工具保持原锁定版本。实际 Edge 联合项目 Markdown 适配验证基础内容、表格、安全 HTML 和围栏，通过；修复 harden 重写相对链接及 Tailwind 只扫描转发入口，新增 previewPlugins.ts 全文审查。修改后重新进行最终两轮，未发布或打包。

补充 exports/types 报告复核，不机械删除仍在文件内使用的内核函数。确认旧 SidebarRail 和 shortcutLabel 无调用后整文件删除，另清理旧远程展示及重置/焦点/头像/服务器查找/SHIFT_KEY 死逻辑。覆盖表保留删除记录，最新类型/lint/结构 Knip 已通过，清理后还需重新构建及最终两轮，不声称旧构建涵盖刚删除的源码。

补充仓库外脚本隔离验证，直接读取 PowerShell AST 中的真实函数，全部终止/删除调用 mock。清理目录边界、祖先 junction 拒绝、PID 路径/启动时间匹配、终止失败保留记录、端口未知进程拒绝通过，未执行真实清理/打包/开发实例终止。命令面板实际组件验证延迟预览、过滤移除、外部关闭、确认主题和卸载清理通过。WSL home 和 Web 密码 IPC 改 blocking，PTY 初始化复用同步内核，最新 Rust clippy/fmt 通过。覆盖表 466 行已同步最新源码行数，第一轮全文已完成，最终两轮继续。

实际 Edge/CodeMirror 编辑器控件暴露颜色插件构造异常：editable 业务字段覆盖基类只读 getter。改名 canEdit 后色块/选色/alpha/只读验证通过；定位列表唯一 ID、键盘/IME/空列表关闭及 Markdown checkbox 权限也通过，独立浏览器已退出。背景图片真实逻辑验证 URL/动画帧/定时器/事件回收及晚到 Blob 忽略，通过。比较分支/远程管理实际组件联合真实查询与操作 hook 验证范围、错误重试、去重和关闭重开，通过。当前 Iconify 659 个图标、1 个别名均有直接父图标，无多层别名故障。fs_stat/fs_canonicalize 移入 blocking 池，Rust clippy/fmt 通过。最终全量两轮仍未登记完成。

修复 useLspExtension 首次渲染返回旧文档扩展的问题，真实 hook 验证路径切换、effect 前晚到回复、服务器重启、禁用、卸载与句柄释放通过。新建文件验证发现关闭重开同目录的 ABA 身份复用，改为不复用的对象范围；实际组件验证路径边界、IME、重复提交、失败重试、关闭重开和成功反馈通过，补充输入名称与错误 alert。外部格式化模块使用模拟 IPC 和真实引用函数验证命令/环境/失败边界，真实 CodeMirror State 验证最小编辑和光标映射通过。安装对话框与真实 preset 验证无 macOS 命令、手动入口及重复检测通过。未操作用户文件或安装程序，剩余行为复核与最终全量两轮继续。

发现同步 PTY 写命令的界面阻塞风险，改异步 blocking 写入，同时前端串行 raw IPC 并限制 4 MiB/2048 条等待输入。实际模块验证顺序、失败恢复、关闭/退出、字节/条数预算和容量回收通过，Rust clippy 通过；未启动真实 Codex/Claude，也未宣称所有卡顿唯一根因。修改后全量最终两轮尚未完成。

新增 Git 对话框复核：新建/重命名/删除分支和 clone 的实际组件配合真实共享操作 hook，验证重复确认、范围切换/重开、失败保留和重试，通过。修复丢弃/改写提交说明弹窗内缺失错误反馈，实际 JSX 片段及确认动作验证通过。TypeScript、lint 与 diff --check 通过。剩余功能行为与最终全量两轮继续，不登记为全部验收完成。

补充实际分组组件、语言服务提示及真实 preset 验证，通过；删除 macOS 专用安装命令并保留文档/手动安装入口。设置控件命名，独立单值 SettingSlider 直接命名 Thumb，无引用旧生成 Slider 删除。真实 Edge + React/Radix 验证滑块名称与方向键调值，通过；不在仓库保留测试文件。桌面构建、size-limit 及结构 Knip 通过，最新新增改动继续检查，最终两轮尚未完成。

复核全部 41 条检查警告，修复查询函数切换竞态、目录树键盘范围和 Windows 打开标记匹配，删除无调用方的旧空间概览命令。实际 hook/处理函数验证通过，必要的重读/DOM 测量/作用域依赖保留并说明原因。全仓 lint 无错误和警告，TypeScript 通过；分组焦点和其余交互继续检查，仍未登记最终全量两轮完成，未提交或打包。

## 2026-10-06 当前进度

补齐 Web 网格无损转换、手机解析等待队列和首屏预算。实际 Rust 函数与前端模块隔离验证通过，TypeScript、Rust clippy 和手机构建通过，lint 无错误、41 条警告。文件事件前端同环境 reload/rescan、不同发行版隔离与 Windows 别名验证通过。仍在功能回归，不将这些局部结果记录为最终两轮完成。

继续修复目录通知的 WSL/链接别名与环境归属、注册/事件字节限额、自定义 LSP preset 重复检测。实际 Rust 纯映射与 clippy 通过，前端环境隔离及其他行为继续复核；未完成最终两轮验收。

自启重复切换/旧状态、显式跨空间文件 owner 已补充实际 hook 复核通过；首屏 JS 约 365 KB gzip、全部客户端 JS 约 1.26 MB，size-limit 通过。继续修复 WSL 原生附件路径，实际 adapter 及仓库外 Rust 计划验证通过，原生进程仅 mock，最终两轮尚未完成。

本次新增验证：同步查询异常不遗留 loading、历史文件失败缓存条数/字节上限、标签实际拖动处理和卸载、非 agent 图标零订阅、块元信息变化及耗时单位进位均通过。持续修复中，最终两轮尚未登记完成。

继续发现历史文本筛选入口未接通、正则潜在界面阻塞及文件列表失败缓存不受限。已修复并用实际 Edge/构建 Worker 验证匹配、CSP、复杂表达式期间页面响应；hook 取消/超时验证通过。文件缓存并发及字节边界、通用查询同步异常仍在补验证。两轮最终验收未完成，不将本次构建通过当作完成声明。

本次继续修复目录监听注册句柄/阻塞 IO、网关按实例启停、手机首屏快照写入次序与字符资源边界、偏好写入顺序及格式化规则丢失、设置入口不必要终端依赖和跨空间显式文件 owner。前端真实函数/组件与仓库外 Rust 临时端口隔离验证通过，Rust clippy 通过；实际产物和其他剩余行为正在复核，尚未开始登记最终两轮完成。

覆盖表所有待审长文件已全文阅读并分析，包含提交面板、标签状态与标签条、旧空间概览、块覆盖层/CSS/水印和剩余设置节。全文阅读完成不等于功能验收完成；仍在处理审查发现的边界问题与行为复核，最终两轮全量验收尚未完成。

批量推送失败分类、保护分支旧 HEAD、预览失败不直接推送、提交检查失败阻止提交、提交/暂存/丢弃共同同步门闩、多仓库同名文件、改写说明保留暂存区已修复。真实 hook 与组件隔离验证和仓库外 Git 提交树/暂存区验证通过，Rust clippy 通过。无界面入口的 Amend 状态及 native 管道、branchOps 转发和旧 SpaceSwitcher/SpaceAvatar/InlineRename 已删除。

标签变更先在同步引用上计算计划，React 只接收结果，分屏 ID 与终端释放不在可延迟或重复的 React 更新器中执行。真实 hook 隔离验证分屏 ID、关闭仅释放一次、剩余面板目录、批量打开、Windows 别名去重、即时 owner、Markdown 改名和跨空间历史隔离通过。旧空间概览专用的无人调用移动/重排入口一并删除。终端覆盖层、设置保存与手机密码新增边界仍在验证，不能登记为最终验收。

未提交、打包或发布，版本保持 0.9.7；没有启动用户终端、修改用户 Git 仓库、设置或任务，没有调用真实模型。新增验证不保存为仓库测试用例。

开始时间：2026-10-02 15:40:59（Asia/Shanghai）。审查基线：`bf32fb9`。

本批收尾：2026-10-02 16:51:27。中途完成用户要求的基线提交，15:47:01 恢复后持续审查超过一小时。本批结果不是全量审查完成声明。

用户要求至少一小时分析、逐行检查、修复确认的问题，并在修改后复核两次。这里记录实际完成范围，不将编译通过或扫描命中等同于逐行审查。源码初始清单包含 427 个文件，约 8 万余非空行，包含生成 UI 原语；依赖、字体和生成的手机 bundle 不作为手写源码审查。

## 已逐行阅读的文件（第一轮）

2026-10-03 继续审查：已完成剩余生成 UI 控件的逐行阅读。入口导入图和全仓引用确认 14 个独立 UI 文件没有使用者，整文件删除并在覆盖表保留删除记录，保留原语不手改。预览搜索的实际 MutationObserver/CSS Highlights 在无头 Edge 中验证变动合并、无 DOM 观察循环及清理取消，通过。全量第一轮及两轮最终复核仍未完成。

- `src-tauri/src/modules/fs/file.rs`
- `src-tauri/src/modules/fs/mutate.rs`
- `src-tauri/src/modules/fs/mod.rs`
- `src-tauri/src/modules/web/auth.rs`
- `src-tauri/src/modules/web/mod.rs`
- `src-tauri/src/modules/schedule.rs`
- `src-tauri/src/modules/schedule/storage.rs`
- `src-tauri/src/modules/schedule/background.rs`
- `src/modules/editor/lib/useDocument.ts`
- `src/modules/editor/lib/externalFormat.ts`
- `src/modules/editor/useEditorFileSync.ts`
- `src/modules/events/index.ts`

- `src-tauri/src/modules/shell/mod.rs`
- `src-tauri/src/modules/proc/job.rs`
- `src-tauri/src/modules/proc/mod.rs`
- `src-tauri/src/modules/lsp/session.rs`
- `src-tauri/src/modules/lsp/framing.rs`
- `src-tauri/src/modules/lsp/mod.rs`
- `src-tauri/src/modules/fs/watch.rs`
- `src-tauri/src/modules/fs/clipboard.rs`
- `src-tauri/src/modules/usage.rs`
- `src-tauri/src/modules/git/process.rs`
- `src/modules/lsp/lib/sessionManager.ts`
- `src/modules/lsp/lib/transport.ts`
- `src/modules/lsp/lib/uri.ts`
- `scripts/tauri.mjs`
- `scripts/packageVersion.mjs`
- `scripts/build-web.mjs`
- `scripts/build-cli.mjs`
- `.github/workflows/ci.yml`

`EditorPane.tsx`、`rendererPool.ts` 已检查主要路径，部分长文件输出截断，未登记为全文完成。workspace、PTY session 与 LSP client 仅检查部分路径。其余模块未登记为逐行完成。

## 已修复

- 新建文件使用先检查再覆盖写，存在同名文件竞态。
- 文件复制允许把目录复制进自己，且递归跟随目录链接，可能无限递归。
- 文件读取只在读前限制大小，正在增长的文件可绕过上限。
- 文档 dirty ref 延后同步，异步重载可覆盖新输入；保存、切换路径与读取的旧结果需要代次隔离。
- 认证凭据损坏被视作未设置，从而回退默认凭据；凭据写入非原子。
- 登录 body 分段读取丢弃已收到的前缀；已连接 WebSocket 不检查密码轮换。
- HTTP 未认证连接无限创建线程；WS 分片遇到控制帧时丢失尚未完成的消息。

另修复 shell/Git 超时后后代持有管道、Git 大输入阻塞、LSP 部分启动与关闭清理、原子保存权限及 mtime 检查、CI 未安装手机依赖、版本标签构建自动增号和打包指纹不完整。删除共享默认凭据；生产依赖安全修复只更新 Mermaid、DOMPurify 及必要传递依赖。

## 隔离运行验证

临时用例位于系统 Temp，未向仓库增加测试或测试依赖，不使用用户凭据或正在运行的终端。

- WebSocket 在每一个 TCP 切分位置重组文本，在分片间插入心跳；拒绝非法帧、掩码、UTF-8 与孤立续帧。LSP 在每个切分位置读取消息并拒绝超大头部。
- 直接加载真实 auth 模块，损坏凭据拒绝认证，密码前后空白保留，重设轮换令牌。
- 真实 Windows Job Object 终止 PowerShell 后代后，父进程和输出管道及时退出。
- 浏览器加载真实 useDocument hook：晚到重载不覆盖输入，两次保存顺序正确，撤销到原始内容仍实际保存，切换路径忽略旧读取，stat 失败保留 dirty。

## 验证状态

两轮 lint、TypeScript、Rust clippy、桌面构建和手机构建通过。lint 有 88 条现有警告，无错误。Knip 结构检查通过。最终锁文件通过 frozen install，生产依赖审计无已知漏洞；仅安全依赖发生版本变化，其余 importers 与基线一致。

第二轮重新验证协议切分、全新凭据、Windows 进程树和真实文档 hook，并核对 `expectedMtime` 随保存队列更新。原子保存冲突保持原文件，成功替换后无临时文件遗留。匹配版本标签不增号，错误标签拒绝构建。两轮复核针对已修改范围，不代表 427 个文件完成两遍逐行检查。

实际 Windows 交互式 CLI 和 iOS Safari 验收尚未完成。未发布、未打包，版本保持 0.9.5。

## 仍需继续审查

完成 main.ts 手机入口全文阅读，修复会话与连接代次、冷面板打开重试、重连重新附着和非法空 JSON。手机尺寸 Edge 运行真实生成页面并模拟服务端，验证同名空间、指定冷面板、旧 attached/exit、发送确认、旧连接关闭及重连，无页面异常。新增公开 xterm 单元格搜索映射，真实 xterm/Edge 验证 Unicode 定位。还需审查 conversation、样式与其他未覆盖模块，不能登记为手机全面完成。

补齐项目删除的未保存/运行进程确认、最后空间保护、旧检查取消、项目名称输入法与重复提交、关闭时面板变化保护，以及 Markdown 路径事件。当前终端真实模块隔离验证启动先退出、队列超限、尺寸乱序、检查中保护、写入/关闭失败；真实 Edge/CodeMirror 验证失败提交不清草稿。TypeScript 与 Rust clippy 通过，lint 82 条警告、无错误。本批仍在继续，不是最终两轮复核。

2026-10-03 继续全文检查 App、工作区 store/serialize/boot/persistence、关闭与环境切换 hook、手机标签同步和 GroupSwitcher。修复关闭前保存、空空间与失败重试、非法恢复结构、第一次启动 WSL 环境、切换代次与二次 dirty 检查、启动文件事件排队、预览快捷键标签 ID；手机按空间 ID 隔离同名项目、逐面板目录和活动标记、精确激活，原生 Session 提供实时映射。真实模块仓库外验证通过；TypeScript、手机构建通过。此段不是最终两轮全量验收，仍继续审查剩余代码。

2026-10-03 继续全文检查 CLI 协议/客户端、控制面、Git 操作/解析/命令及进程层、应用入口、原生配置、WSL shell 脚本、前端控制桥、公共库与设置模块。设置类型与通知统一校验，修复加载期间丢更新和监听失败泄漏；真实模块隔离验证通过。真实 Edge 验证缺失字体的检测误报及回退修复。新增 Git 内容截断、逻辑链接路径和远程选项前缀修复，仍需完成相应运行复核及全量剩余文件。

期间检测到其他操作将清单版本更新为 0.9.6，保留该变动。本次审查没有执行安装包构建、提交或发布；历史 0.9.5 验证记录指当时状态。全量审查仍未完成。

继续全文检查 terminal 的 useTerminalSession、rendererPool、OSC、PTY bridge、模式机、blockDecorations、ShellInput、拖放、字体、剪贴板和缓冲库。已验证真实模块启动代次竞态和真实 Edge/xterm 的池保护，五个忙碌网格在容量压力下全部保留、WebGL 实测五个。Git 临时仓库运行验证 blob 超限拒绝、真实 Windows 文件链接逻辑路径不变及不读取外部目标，补齐已修改 Git 版本检查。

第三批新增全文审查：PTY mod、shell_init、agent_detect、da_filter、PowerShell profile，LSP env/rss，fs tree/search/grep，history mod/parse，sessions，transcript 五个文件与 gateway 六个文件。第一轮覆盖以逐文件表为准。修复进程清理、订阅/退出顺序、无作用平台逻辑、搜索漏文件、同步历史阻塞、时间及工具关联、网关异常输入和缓存上限；已分别补充架构和 issues。

仓库外验证加载真实订阅方法、master 包装和 flusher 逻辑，覆盖最后 Arc 的锁保护及已取出输出和最终通知的顺序。真实捕获模块验证超时和输出上限。真实网关配置与 SSE 模块验证多进程令牌竞态、损坏令牌、Unicode 模型名、每个字节切分、推理别名、中断返回错误；真实 HTTP 解析覆盖每个 TCP 切分、长度、认证前大 body 与稀疏工具索引。真实会话和历史模块验证时区、小数秒、用户空白、工具 ID 对应、PowerShell 多行和排序。没有修改用户凭据、运行会话或发起付费请求。

逐文件清单见 `release-1.0-coverage.md`，包含运行脚本和根目录构建配置，取代初始粗略文件数。第三批已完成 workspace.rs 与 PTY session.rs 的全文阅读，修复订阅身份、慢连接断开和退出输出顺序；当前仍在持续审查，不是全量完成声明。

全量源码尚未逐行覆盖。用量查询的异常进程回收与 LSP 在启动期间关闭的竞态已确认并补齐清理。调度任务失败落盘与启动期间服务器请求处理已经在第二批继续复核并修复。终端输入及手机实际运行不能只靠静态检查结论验收。

继续检查终端挂载链路及批量 Git，修复 Session 未绑定所属空间环境造成的异步启动/重启混用环境。终端真实模块隔离验证通过。批量 Git 加入调用前后即时环境检查、串行占用与旧进度隔离，预览使用有界 upstream 范围，执行前拒绝过期分支与 HEAD；隔离验证等待 fetch 中切换、重复调用、锁释放及旧计划不推送。全文阅读 FileExplorer、InlineInput、TreeRow、contextActions，修复空目录切换 Hook 顺序、保存失败后无法重试、IME 提交及延迟重选输入。文件树写操作范围检查和此批输入修改继续运行复核，未登记为最终全量验收。

本批 InlineInput 的真实组件逻辑隔离验证覆盖失败可重试、Enter/blur 去重、IME 和延迟选区；路径转换及 Git 标记真实 hook 验证 UNC、WSL、相对路径边界、链接根标记和旧环境回复拒绝。TypeScript、桌面构建通过，lint 71 条警告、无错误。后续 contextActions/useGitStatus 修改仍在静态复核；全量覆盖及最终两轮检查尚未完成。

继续全文检查 useAsyncQuery/useContentSearch/useCommandHistory、ExplorerSearch 及根目录静态分析/体积/依赖配置和诊断脚本。搜索范围切换、旧回复与卸载 retry 隔离验证通过。原生拖放以本地 Tauri PhysicalPosition 类型为依据修正 DPR，内部拖动保留逻辑坐标，仍需缩放布局实际复核。

重新全文检查 OpenCode SQLite 读取器，新增字节/行/部件上限、共享 Arc 缓存、只读一致快照和 WAL 完整指纹。仓库外临时数据库运行真实读取器及共享文本函数：801 条消息只显示最新 600 条，空白保留，未变时共用同一 Arc，只有 part 内容更新仍产生新 revision，超大 JSON 拒绝，全部通过。Rust clippy 通过。删除 web-capture.mjs 与 verify-web.mjs，两者均可从 Git 历史恢复，没有删除用户录制数据。手机构建、TypeScript 通过；完整 Knip 报告仍有 105 个多余导出和 58 个类型导出，需逐项核实，不将该报告视为全部死代码。未开始最终全量两轮复核。

OpenCode 真实临时 SQLite 验证已完成，源码之外的外部数据入口仅替换数据库位置；600 条有界结果、用户空白、缓存复用、WAL 内容变化 revision 与超大 JSON 拒绝全部通过。图分析改为 TypeScript AST，移除过期测试声明，主/设置入口实际运行通过。结构 Knip（files/dependencies/unlisted/unresolved）通过，完整导出清理仍待逐项分析。体积预算检查通过，启动 358.58 kB、全部客户端 1.24 MB gzip；非运行内存测量。仍需覆盖剩余文件及最终两轮复核。

继续全文阅读 sidebar 的 index/types/SidebarRail/OpenFilesPanel/useSidebarPanel，header 的 Header/SessionHistoryMenu，WindowControls、AboutSection、UpdaterDialog/useUpdater。侧栏宽度初始化/有限值/退出 debounce、窗口异步监听与乱序验证通过；历史环境隔离和失败重试已改，运行复核继续进行。更新器尚有异步/句柄/重复请求及 Windows 自动退出绕过未保存保护的问题待修，拖放 shell 引号也仍待按实际 shell 修复。不能把本批全文阅读登记为全部功能完成。

更新器已补齐并发占用、挂载代次、Update 句柄释放、localStorage 异常与安全整数版本。签名安装分开下载和安装，主窗口安装前等待工作区保存并拒绝 dirty/前台任务；设置窗口交给主窗口重新检查并确认。隔离真实 hook 验证通过，无真实下载、安装或重启。最新版额外交接/提示改动已复核，关闭保护真实 hook 及全量两轮验收仍继续。

## 第二批审查

2026-10-06 继续全文分析 GitHistoryPane、ClaudeProviderButton/ClaudeUsageButton、标签切换/菜单/barrel、InlineRename/SpaceAvatar、keymap、编辑器 chromeTheme/cmThemes/languageDefinitions、桌面样式和 Vite/TypeScript 配置。实际历史主面板、供应商、用量与标签切换组件隔离验证通过；真实 Edge 验证颜色探针通过，类型检查及桌面构建通过，lint 无错误、52 条警告。未打包/提交/发布，剩余全文分析和最终全量两轮仍继续。

继续全文读取文件/目录图标表、Git 历史 filters/graph/remoteWebUrl、GraphRail、HistoryFilters、FileHistoryDialog、CommitContextMenu 和历史 Stack/Lazy/barrel。修复图标原型碰撞及平方级初始化、SSH/GitLab 链接、轨道溢出、筛选项及异步范围、历史弹窗关闭和 Git 操作重复/失败确认丢失。实际关联、链接、图分页及真实组件隔离验证通过，TypeScript 通过。WSL 刷新、Web 状态失败与诊断名称补齐并验证。剩余源码全文审查及最终全量两轮仍未完成。

子目录下拉与实际 useAsyncQuery 联合隔离验证通过：目录变化乱序返回不回填、环境切换立即隐藏旧结果、请求携带固定 WSL 环境、卸载拒绝完成；原生按钮可以键盘触发。版本查询增加卸载保护，未知版本使用 ASCII 占位。仍属于第一轮修复，不是最终全量两轮。

全文阅读 CwdBreadcrumb/pathUtils、tabLabel/useWorkspaceCwd/useWindowTitle 及 StatusBar。修复目录继承跨空间/环境、活动 pane 目录优先、UNC 根与 home 边界、子目录旧结果和键盘触发器。真实路径及目录 hook 验证通过；子目录异步控件继续复核。窗口标题使用 ASCII 分隔符并观察失败。剩余全文审查及最终两轮继续，未提交或打包。

全文阅读 shortcuts 注册表、全局 hook、标签与范围 helper/barrel 及 ShortcutsSection，修复工作区分组遗漏、无效编辑器覆盖、IME 捕获、录制重复与不可键盘操作。真实注册表及 Recorder 隔离验证通过。实际无头 Edge 验证主/设置入口顶层可运行、iframe 内拒绝启动。仍未完成全量第一轮与最终两轮。

全文阅读 PreviewAddressBar/Pane/Stack/index，新增共用 previewUrl 校验，限制协议、长度、凭据及内部 origin，并在两个应用入口拒绝 frame 内启动。端口探测有取消和请求代次，输入法不导航。实际组件隔离验证乱序请求、编辑草稿、超时反馈、卸载取消与 URL 边界通过；无真实网络探测。主题链路后续修改的 TypeScript、Rust clippy、结构 Knip、桌面及手机构建通过，lint 63 条警告无错误。剩余源码与最终全量两轮复核仍继续。

继续全文阅读命令面板及所有主题模块、主题预设、主/设置入口和 ThemesSection。修复损坏 MRU、IME 确认、预览清理、隐藏窗口显示、主题加载竞态、订阅清理、主题文件环境及重开覆盖、背景数据库中止和对象 URL 生命周期。真实组件隔离验证字段代次、乱序回复、空间 ABA 切换、WSL 保存环境、订阅释放、安全主题 ID 和已有文件保留；真实无头 Edge 验证 IndexedDB Blob 保存/读取/删除。静态检查继续，全量剩余文件和最终两轮未完成。

继续全文检查 AI Elements 的 4 个文件及 find-box/input/kbd/label/separator/progress/collapsible/spinner/checkbox/radio-group/scroll-area/alert/badge/button/button-group/card/hover-card/resizable 原语，不修改生成实现。业务适配修复 IME 搜索、旧匹配索引、完整代码语言和高亮旧文本；适配隔离验证通过，预览异步 DOM 观察继续浏览器复核。进度 ARIA 在调用处补齐。剩余源码和最终全量两轮检查继续。

复核历史目录及 transcript IO 预算：目录扫描改为显式有界枚举且超限拒绝，候选多于一个立即回退；Claude 回退目录查找共享预算。JSONL 按字节/时间分批、保留偏移，超大单条拒绝而非无限跳过。仓库外真实 Rust 函数验证 8193 个文件、深层目录、50 MiB 记录、未完成行、时间批次、拒绝与替换复位通过。Rust clippy/fmt、结构 Knip 通过。当前并未完成剩余源码全文审查，也没有开始最终全量两轮验证。

继续全文分析 worktreeOps、WorktreeDialog、WorktreeManagerDialog 和 BranchConfirmDialog，修复环境/代次/并发门闩、旧删除确认与分支刷新清草稿问题。真实组件隔离运行通过，没有调用真实 Git 写操作。PTY 启动回传实际 shell 类型，拖放/剪贴板路径引用绑定 Session，真实 PowerShell/Bash 字面解析通过，包括弯单引号；删除新终端延迟 cd。Rust clippy/fmt 和 TypeScript 通过。仍需 WSL 原生路径转换、实际 fish/cmd/merge 控件、剩余文件及最终全量两轮复核。

继续全文检查 GitDiffPane/Stack/Lazy/diffCache 与 Markdown 模块全部文件。修复差异旧请求回填、缓存键及预算、环境绑定、暂存回滚覆盖工作区风险和回滚前磁盘核验；真实缓存/回滚函数隔离验证通过。Markdown 使用共享文档读取，搜索替换为不改 DOM 的公开 Range/CSS Highlights，真实 Edge 验证通过；文件链接与跨发行版重命名/删除回调隔离验证通过。选区按钮浏览器验证已经通过。最新 TypeScript 通过，lint 无错误、70 条警告；新文件/格式化/实际 merge 控件交互及剩余全文审查继续，未开始最终全量两轮复核。

继续全文检查 EditorStack/EditorStackLazy/EditorPane、编辑器 index、diagnosticsReporter/diagnosticsStore/eol/indent/languageResolver/extensions/useApplyEditorFontSize/useEditorThemeExt/themes/vim/NewEditorDialog/colorSwatches/markdownExtras。编辑器跨空间读写及 watcher/formatter 绑定环境；重命名保留草稿、跨环境及不一致基线不隐式覆盖。真实 useDocument、Vim wq/x 和语言缓存隔离验证通过。打包/清理/热部署脚本、Cargo/capability、issue/审查配置全文检查并修复；只运行脚本语法检查，未执行打包或清理。保留外部清单版本 0.9.7；新文件/格式化/选区浏览器验证和全量剩余文件继续，不是最终两轮检查。

重新逐行检查 `schedule.rs`、`schedule/storage.rs`、`schedule/background.rs`、LSP `transport.ts` 与 `sessionManager.ts`；新增检查 `runtimeStore.ts`、`useLspExtension.ts`、`ScheduleButton.tsx`。检查 PTY session 提交方法和 LSP client 初始化/关闭路径，不将这两个长文件登记为本批全文完成。

修复定时任务结果缺失、过期重新绑定的激活窗口和旧执行快照竞态；复用 Session 提交方法，删除重复写入和未使用常量。LSP 修复启动前应答丢失、非法配置请求异常、启动容量竞态、禁用后继续启动、旧退出事件影响新实例、初始化失败误报运行及关闭中容量回收通知。

隔离浏览器执行真实 LSP 模块逻辑，外部 IPC/CLI 仅作模拟。8 个根目录并发只允许 4 个启动，关闭中的实例占容量，释放后通知重新获取；禁用后晚到结果清理，旧实例退出不影响新实例，初始化失败清理。真实 transport 验证启动前应答排队、非法 items 返回错误、关闭后丢弃消息与请求。

仓库外 Rust 验证提取真实 ScheduleState 和 Storage::save：终端失败结果实际写盘，每日任务推进，过期任务重新绑定取得新窗口，旧结果不覆盖重绑，目标只读时新增/取消/重绑均回滚并暂停调度。没有调用真实模型，没有修改用户任务存储。

定时面板使用真实 React 组件、模拟外部 IPC 和 UI 原语验证：旧列表回复不覆盖新事件，保存期间编辑的新草稿保留，等待保存时重复 Enter 不会创建第二个任务。

第二批两轮 lint、TypeScript、Rust clippy 通过；桌面与手机构建通过，lint 仍为 88 条警告、无错误。两轮检查仅覆盖本批修改范围。未打包、未提交、未发布，版本不变；没有把真实 Windows CLI 或 iOS Safari 记录为已验收。

继续全文阅读手机 conversation、dom、clipboard、markdown、style.css。修复解析完成刷新、一行正文误删、状态列拆分、发送空白和过载等待；删除旧回放接口。真实模块及 Edge/xterm 验证通过，窄屏/横屏/压缩高度无页面横向溢出，尚非最终复核。复制、离线状态和复杂 Markdown 的新增边界继续验证。

继续全文审查 fs/clipboard、fs/watch、fs/mod、workspace/env、events/index、explorer/useFileTree/watch/useExplorerDnd/useExplorerFileDrop 及 source-control/useSourceControlContext。修复 shell 粘贴归属、二进制图片保存与唯一名称、目录请求代次、同步展开、失败草稿、监听句柄和文件事件限流/重扫描。仓库外 32 次真实并发图片保存通过；真实 Session、目录 hook 和监听模块交错验证通过。Rust clippy、TypeScript 和事件溢出验证仍在本批复核，不记为最终两轮完成。

继续全文阅读 Git repositoryTarget、remoteHelpers、useMultiRepoSourceControl、useRepoList、useRepoStatuses、useSourceControl。修复扫描/次级状态的环境隔离与取消、StrictMode 重新读取、单仓库远程操作重复调用及 await 后继续旧操作、旧仓库可见状态和元信息。真实 hook 隔离验证通过，不发起用户仓库或远程写入。批量远程操作仍有范围/并发/状态处理待修，不能登记为功能完成。新增手机 protocol 类型和纯校验，非法数组项验证通过；最终两轮验收未开始。

2026-10-06 继续全文检查 LSP 剩余模块、设置入口与 LSP 组件，及分支菜单、确认/创建/重命名/删除/比较/差异、仓库定位、clone 和 source-control barrel。修复检测竞态与错误缓存、跨项目提示、格式化旧快照和无效编辑、隐藏编辑器跳转、安装失败重试重复配置、重复分支提交及旧仓库回填。真实检测、格式化、自定义服务器组件和 Git 操作 hook 隔离验证通过；类型检查通过，lint 52 条警告无错误。差异对话框和其他本批路径仍需行为复核，剩余长文件全文分析与最终两轮尚未完成，未提交/打包/发布。
