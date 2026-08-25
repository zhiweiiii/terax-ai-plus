# 已知问题与架构债

本文记录已知的代码问题、架构债和风险。它是 `TERAX.md` 的对照面：`TERAX.md` 描述架构**应该**怎么运作，本文记录现实在哪里偏离、哪里有风险、哪里可以安心忽略。

严重度分三档：**高**（可见的 bug 或安全面）、**中**（潜伏的 bug、无用功或功能缺口）、**低**（观感、死代码或命名漂移）。

状态分三种：**已修**（解决了）、**已接受**（有意为之，登记在案）、**未决**（仍然存在）。

## 待办与本轮变更（2026-08-19 / 20）

第 1 到 12 条已完成并**经使用者实测通过**（2026-08-20），未发现明显问题。逐条记在下面，留作后续改动的背景。

四个后续项是从这批里长出来的：第 14 条来自第 8 条（终端右键），第 16、17 条来自第 6 条（diff 视图），第 21 条是第 7 条（文件树过滤）的真正根因 - 那一条当时按功能验收算过，但底下的偏好 store 从来没初始化过，所以它并没有真的生效。

### 已完成并验证

**1 + 5 + 3　"思考中"的来源，以及消息不实时**

这三条是同一个问题，一起解决。定下来的分工：

| | 负责 |
|---|---|
| transcript | 已定稿的对话：谁说了什么、思考内容、调用了哪些工具 |
| 屏幕 | 正在进行的这一轮：此刻是否在动、正在打出来的文字 |
| 页面自己 | 刚发出去的消息，发出那一刻就显示 |

根因是 **Claude Code 在一条消息完成时才写 JSONL，不是边流边写**，所以读文件这条路天然做不到比"一轮"更实时。三处改动（都在 `src/web/main.ts`）：

- `paintThinking` 在 transcript 没说"有轮次在跑"时**回落到屏幕的 spinner**，而不是直接不显示：这就是普通对话执行时"思考中"能出现的原因（第 3 条）。
- 轮次进行中时渲染屏幕上 transcript 还没收录的内容（`unsettledBlocks`），按文本包含关系去重，避免两边都画同一句。
- 发出去的消息由页面自己扣住（`awaitingTranscript`），直到 transcript 真的收录了它。原先复用屏幕路径的 `pending`，而那个是**程序把消息画到屏幕上**就丢弃：比 transcript 收录早一拍，于是气泡会闪一下消失再回来。

Rust 侧（`transcript/claude.rs`）改的是轮次是否结束的判定：一条 assistant 记录**不等于**一轮结束，Claude 每次模型往返都写一条，所以"看到 assistant 就清掉进行中"会让指示器出现一秒就没。改成数**发出去的工具调用 vs 收回来的结果**，两者持平才算结束。

**2　移动端 Tab / Shift+Tab / 空回车**

Tab 和回车按钮本来就有。缺的是 **Shift+Tab**（`CSI Z`），两个 agent 都用它切换模式，手机上原本没有任何途径能发出去。另外空输入的回车不再被 `submit()` 拦掉：**空回车不是空消息**，它用来接受默认值、确认提示、翻页。

**4　状态栏移到底部**　从顶栏挪进 composer，紧贴按键行上方。

**6　git diff 视图：添加到 agent + 折叠开关**

- 「添加到 Claude Code」按钮，拼 `repoRoot` + 仓库相对路径，复用文件树右键菜单用的同一个 `handleAttachFileToAgent`。
- 「完整文件 / 仅变动」开关，切换 `unifiedMergeView` 的 `collapseUnchanged`，存为偏好项 `diffCollapseUnchanged`（默认开），所以切文件不会重置。
- 未做：设置窗口里没有对应控件；二进制/大文件的 patch 回退视图里不显示折叠按钮（那个视图本来就只有变动）。

**7　文件树过滤按钮**

工具栏加了「过滤」菜单，两个独立开关：隐藏 git 忽略的文件（新偏好 `hideGitIgnored`）、显示隐藏文件（复用已有的 `showHidden`，原先只能从设置窗口改）。忽略目录连带整棵子树：直接复用了已有的继承结果 `parentIgnored || entry.gitignored`。树没有全部显示时按钮会高亮，否则"文件不见了"看起来像文件真的不见了。

**8　终端右键：不弹菜单**

原先弹的是 webview 的默认菜单：`src/` 里根本没有任何地方监听 `contextmenu`。现在在终端宿主上吞掉它，并按惯例分支：**有选中就复制并清除选中，没选中就粘贴**。只挂在终端面板上，文件树、标签页、编辑器各自的右键菜单不受影响。

**9　"在文件夹中打开"失效**

两个独立缺陷叠在一起：

- 路径是正斜杠的（`D:/project/foo`），而 Windows 上这最终走 `explorer.exe /select,<path>`，给正斜杠它什么都不做。现在按平台转成原生分隔符。
- 错误被吞进 `console.error`，没有任何提示。现在会弹 toast。

排除过的：**不是权限问题**，`opener:default` 本身就授予了 `allow-reveal-item-in-dir`。

**10　第一次点终端不聚焦**

两个原因，都修了：

- `focusPane` 只改 React state，**从不调 `term.focus()`**。所以点一个"已经是活动 leaf"的终端时什么都没发生，DOM 焦点留在刚才那个按钮上。现在每次 mousedown 都取 DOM 焦点，不再只在活动 leaf 改变时才取。
- Radix 浮层关闭时会把焦点还给触发元素，晚一拍，正好把终端刚拿到的焦点抢走。新增 `usePointerDismiss`：**只在由指针关闭时**取消这次归还，键盘（Esc）路径保持原样：那种情况下焦点回到触发元素才是对的。挂在 `context-menu` 和 `dropdown-menu` 两个共享基础组件上，不是散在各调用点。

**11　任务栏图标 + 打包**

`bundle.targets` 从 `"all"` 改成 `["nsis"]`。MSI 把图标解压到 `C:\Windows\Installer\{每次都变的 ProductCode}\ProductIcon` 再让快捷方式引用它，重装删掉旧目录，固定项的图标就指空了。NSIS 的 `CreateShortcut` 不带图标参数，图标取自 exe 本身，不会掉。

`installMode` 改成 `perMachine`（`D:\Program Files` 是全机器位置）。**默认目录不需要自定义模板**：NSIS 的 `.onInit` 会调 `RestorePreviousInstallLocation`，安装时也写 `InstallLocation`，所以第一次装选一次目录，以后就记住了。把 `D:` 硬编码进发给别人的安装包是错的。

顺带修了一个现成的 bug：`installer-hooks.nsh` 里「Open in Terax」右键菜单指向 `$INSTDIR	erax.exe`，而实际文件是 `terax-prod.exe`：**这几个菜单项一直是坏的**。同时把注册表写入从 `HKCU` 改成 `SHCTX`，跟随安装模式（perMachine 下是 HKLM），否则提权安装写的是提权账户的 hive。

**换装步骤**：先卸载现在的 MSI 版，再用 `.exe` 装并选 `D:\Program Files\Terax`，然后重新固定一次任务栏。

**12　编译产物**

`src-tauri/target` **40 GB → 2.9 GB**。构成是 debug 37.5 GB（deps 23.1 / incremental 10.4 / build 2.1）、release 2.7 GB：93% 在 debug。

清掉了 `target/debug`（纯产物，可再生）。堵源头的改动在 `[profile.dev]`：`debug = "line-tables-only"`，依赖包 `debug = false`。**全量 debuginfo 才是 23 GB deps 的成因**；line tables 保留 backtrace 里的文件和行号，体积只有一小部分。`incremental` 保持开启：它是编辑-重建循环快的原因，而且是随时可删的缓存。

> 下次 `热部署` 会慢几分钟（debug 依赖要重编一次），之后恢复正常。

### 已实现，待实测

下面这批代码已经落地，但**还没有在运行中的应用里跑过**。重启热部署后逐条实测才能移进"已完成并验证"。

**13　文档精简与中文化** - 已完成。`TERAX.md`、`README.md`、`ROADMAP.md`、`docs/README.md`、七份架构文档、本文全部改为中文并按"与架构文档重复"精简。`docs/history/` 下三份移植文档合并成一份 `git-移植档案.md`：留决策和坑，扔掉按 agent 分的状态表和进度清单。**代码注释按用户决定保持英文**，这是明确接受的中英混排。

**14　终端右键粘贴粘两次** - **本条记载的修法是错的，已被第 24 条取代。** 当时加的 `RIGHT_CLICK_PASTE_GAP_MS = 250` 间隔护栏基于"同一个动作被触发了两遍"这个错误假设，实际两次粘贴来自两个不同的程序，该护栏从未生效，现已删除。真正的根因和修法见第 24 条。

**16　diff 里「完整文件」按钮点了没反应** - 已修。根因和第 21 条同一个（偏好 store 从不初始化），另外给 `<CodeMirror>` 加了 `key={collapseUnchanged ? "folded" : "full"}`：`unifiedMergeView` 的折叠状态是初始化时算好的 StateField，reconfigure 不会重建它，必须强制重挂。

**17　diff 里「添加到 agent」发送选中内容** - 已修。`GitDiffPaneHandle` 加了 `getSelection()`，`captureActiveSelection` 补上 `git-diff` / `git-commit-file` 分支。`sendSelectionToClaude` 本来就有这两个 kind 的分支，缺的只是取选中内容那一半。表头那个「添加到 Claude Code」按钮保留，作为"整份文件给 agent"的入口。

**18　Claude Code 参数面板** - 已实现（`statusbar/AgentEnvButton.tsx`）。写进当前 pane，保留历史配置一键套用。四个安全点都处理了：面板明说改完要重启 agent 才生效；**令牌用 Windows DPAPI 加密后落盘**（`secret::secret_protect` / `secret_unprotect`，`windows-sys` 补 `Win32_Security_Cryptography` feature），base_url 和 model 走普通设置；`$env:` 赋值排除出命令历史；历史列表里令牌遮成 `sk-...bda`。

**19　手机端气泡按 Markdown 渲染** - 已实现（`src/web/markdown.ts`）。只对 transcript 那一路生效，屏幕那一路不做（TUI 已经自己把 Markdown 渲染成 ANSI 了）。**自己建 DOM 节点，全程 `textContent`，没有任何 `innerHTML`**，也没有引第三方库。覆盖围栏代码块、行内代码、加粗、标题、有序/无序列表，不认识的语法原样当文字。代码块放在自己的 `overflow-x: auto` 容器里。

**20　手机端能上下翻历史** - 已修。把"用户已经往上翻了"变成**显式状态**，只在手势中改变，不再靠渲染时量滚动位置推断（`replaceChildren` 会让高度塌陷、`scrollTop` 被钳小，下一次测量就误判成贴底）。脱离底部时出现「回到最新」按钮。三处故意的吸底保留：发送消息后、回答菜单后、软键盘改变视口后。

**21　文件树「过滤」按钮不生效** - 已修，根因是 `usePreferencesStore.getState().init()` 只写在 `useSpacesBoot` 的 `if (spaces.length === 0)` 分支里，也就是**只有首次运行才执行**。任何用过一次的安装，主窗口偏好 store 从此停在默认值，而 `init` 同时也是注册变更监听的地方。修法是把它提到分支外。**影响面远不止这两条**：主窗口约 36 处读这个 store 都被钉在默认值上。修好之后这些设置会真正开始生效（回滚行数、字体、光标样式、git 装饰等），界面可能和之前不一样，那是正确行为。

**22　重写 README（中文）** - 已完成。项目名用 `terax-ai-plus`，顶部写明基于 `crynta/terax-ai` 修改并链接上游（Apache 2.0 第 4(b) 条），`LICENSE` 原样保留，指向上游仓库的徽章和链接全部改掉或去掉。应用自身仍叫 Terax（`productName`、二进制、包标识符不动），这是有意的"仓库名 / 产品名"区分。

**23　手机端密码可以重新设置** - 已实现（`web/auth.rs` + `web_set_password` / `web_has_custom_password`）。凭据从编译期常量搬到 `%LOCALAPPDATA%/terax/web-auth.json`，两件必须一起解决的事都做了：**Argon2id 加盐哈希存成 PHC 字符串**（不是把无盐 SHA-1 原样搬到磁盘上），以及**改密码轮换会话令牌**（否则 cookie 的 `Max-Age=604800` 意味着旧 cookie 还能用一周）。还没设过密码时仍由编译期常量应答，升级不会把已有安装关在门外。

**28　git 失败信息一键复制** - 已实现（`src/lib/errorToast.ts`）。`errorToast(title, detail)` 在提示框上加「复制」按钮，复制的是标题加**完整**正文，停留时间从默认 4 秒延长到 10 秒。

**为什么需要**：git 把真正的失败原因放在 stderr **末尾**，而提示框显示开头并截断。实测遇到过一次 - 推送失败时前面先打了一条 GCM 的 `a host provider override was set but no such provider ...` 警告，真正的原因被 `...` 整个吃掉，无从排查。

`source-control/` 和 `git-history/` 下 27 处 git 失败提示全部改用它。唯一保留 `toast.error` 的是 `RemoteManagerDialog` 里的"远程名不能含空格"，那是输入校验不是 git 失败，没有可复制的详情。

顺带补上三处**详情原本就到不了用户手里**的地方，这是实际的功能增量：`useMultiRepoSourceControl` 批量 fetch 的每仓库失败原因原来只 `console.warn` 前三条；同处"部分成功"分支原本不带任何原因；`SourceControlPanel` 多仓库 pull 的 `failures` 数组只被用来数个数。现在都逐行汇总进提示。

**29　Commit & Push 改为 Pull & Commit & Push** - 已实现。提交前先拉，拉干净了才提交。

加在 `runCommit` 里、**预检查之后**（警告确认对话框会带 skipChecks 重新触发，放在检查前会拉两次），提交循环之前。按 `targets` 逐仓库处理，单仓库多仓库同一条路：无 upstream 跳过、`behind === 0` 跳过、`ahead > 0 且 behind > 0` 记为分叉失败、否则 `gitFetch` + `gitPullFfOnly`。**任何一个仓库失败就整体中止，一个都不提交。**

两个刻意的决定：**只用 fast-forward** - 此刻工作区是脏的（正准备提交），在这种状态下替用户开一个 merge 太冒险，ff-only 要么干净应用要么直接拒绝，不会留下半个合并状态；**分叉时报出具体数字**（领先 N、落后 M）而不是笼统的"pull 失败"，因为这种情况需要用户自己决定 merge 还是 rebase。

按钮位置也按要求对调：原来是 `[Commit][Commit & Push]` 上排、`[Push]` 整行，现在是 `[Commit][Push]` 上排、`[Pull & Commit & Push]` 整行。

**已知情况**：远端更新的文件如果本地也改过，ff-only 会被 git 拒绝（`Your local changes would be overwritten by merge`），此时按规则不提交并报错。行为符合要求，错误来自 git 本身，配合第 28 条可以完整复制出来。

**15　编译产物太大** - 已处理，新增 `清理编译产物.ps1`。

先量了一遍：`target` 共 5.99 GB（debug 3.1、release 2.7），其中 `debug/incremental` 0.60 GB、两个 `deps` 合计 4.2 GB。**Cargo profile 早已调好**（release: `lto = "fat"`、`codegen-units = 1`、`opt-level = "s"`、`panic = "abort"`、`strip`；dev: `debug = "line-tables-only"`、依赖不带 debuginfo），正是这些把 target 从曾经的 37 GB 压到现在这个量级。所以剩下的不是配置问题，**target 是缓存不是产物**，问题只在于什么时候清、清掉的代价多大。

脚本按代价从低到高分三档：默认只删增量缓存（纯重建状态，下次构建慢一次）；`-Deep` 连 debug profile 一起删（release 保留，打包不受影响）；`-All` 走 `cargo clean`。带一个护栏：检测到 `terax-prod` 在运行就拒绝执行并说明原因 - 运行中的实例锁着 exe，删到一半会留下一个 cargo 还得自己收拾的 target。

**没有动 release 的体积。** 打包出的 exe 是 10.3 MB，profile 在尺寸方向已经拉满，再往下只能把 `opt-level` 从 `"s"` 换成 `"z"`，那是拿运行速度换体积 - 和"高性能终端"这个产品定位冲突，不该由我替用户决定。

**25　设置窗口去掉置顶，并且要秒开** - 已实现。

**置顶**：删掉 `builder.parent(&main)`。压在最上面的从来不是 `always_on_top`（全仓库没用过那个 API），而是这层父子窗口关系。现在是普通的顶层窗口。

**秒开**：改成**关闭即隐藏**（`CloseRequested` 里 `api.prevent_close()` + `hide()`），于是第二次之后每次打开都走 `get_webview_window` 那条瞬时路径，不再重建 webview、重新解析 bundle、重新启动 React。这同时**修掉了既有的第 36 条**：原来窗口关闭后句柄还在但原生窗口没了，对它 `show()` 毫无作用，settings 会一直打不开直到重启应用。

**父子关系原本还负责"跟主窗口一起关闭"**，去掉之后必须自己接管，否则隐藏着的设置窗口会让进程留在后台没有可见窗口。已在 `RunEvent::WindowEvent` 里监听 main 的 `Destroyed`，销毁设置窗口。

前端那两个 `setTimeout(showWindow, 50)` / `500` 换成双层 `requestAnimationFrame`：等浏览器把 React 产出的那一帧真正提交之后再显示，既去掉了固定等待，也保证窗口出现时是有内容的而不是一个透明矩形。（第二个 500ms 的定时器本身就说明第一次经常不成功。）

**26　关于页面里的链接指向上游** - 已实现。`REPO_URL` 改为 `github.com/zhiweiiii/terax-ai`；原来的 `terax.app` 是上游站点、本分支没有对应站点，那一行换成「上游项目」并链到 `crynta/terax-ai`，既不再谎报又保留了 Apache 2.0 要求的出处。`Bundle ID` 显示的 `app.crynta.terax` 按既定决策不动。

**27　opencode 里不要拦截 Ctrl+T / Ctrl+P 等快捷键** - 已实现。

`useGlobalShortcuts` 现成的 `isDisabled(id, e)` 就是扩展点，返回 true 即不 `preventDefault`，按键自然落到终端，派发逻辑一行没动。

放行条件按待办里写的三条约束收紧：**键必须在显式清单里**（`AGENT_OWNED_SHORTCUTS`：`commandPalette.open`、`commandPalette.content`、`tab.new`、`tab.newBlock`，即 Ctrl+P / Ctrl+Shift+P / Ctrl+T / Ctrl+Shift+T）；**焦点必须在终端内**（`closest(".xterm")`）；**那个 pane 必须此刻真的跑着 agent**（`useAgentActivityStore`，由 OSC 检测驱动，**不是**按"是不是 alt 屏"判断 - `less` 也在 alt 屏但它不需要这些键）。

新增偏好 `agentKeyPassthrough`（默认开）并在设置页「编码 agent」分节暴露，描述里把四个键逐一列出。这一条是待办明确要求的：不可见的话，"我的 Ctrl+T 为什么有时候不灵"会变成一个无法自查的问题。

### 未决

（暂无。第 15、25、26、27 条已实现，移入上一节待实测。）

## Web 终端桥接（`src-tauri/src/modules/web/`）

### 未决与已接受

- **凭据的历史遗留**（原 #3，高）- 在用户设置自己的密码之前，仍由编译期常量应答：SHA-1 摘要和 cookie 令牌在源码里做了 XOR 混淆，`strings` 读不出来，**但混淆不是加密**，能运行代码的人就能还原。第 23 条实现的"设一个自己的密码"是这件事真正的解法，但默认路径仍是旧的。- **已接受**（有迁移路径）。
- `web_ensure_session` 的兜底会话在前端启动时几乎立刻被 `pty_close_all` 杀掉，"手机永远有个终端"这个保证只在启动窗口期内成立。- **已接受**：兜底会话没有 leaf id（手机本来也连不上），下次 web 连接时会重建，它的作用只是让页面不空。
- `web_broadcast_exit` 排空订阅表时，队列满的观看者收不到退出通知，走的是"输出太快"的驱逐路径。同一次退出的两个观看者会被告知不同的故事。- **已接受**：它会重连并发现会话已经没了。
- `b'1'` 的 resize 命令服务端仍保留（协议完整性），但它和"桌面拥有 PTY 尺寸"是矛盾的：任何发它的客户端都能扰乱桌面布局。当前页面从不发它。- **已接受**，已在 `web-terminal-bridge.md` 记录。
- leaf 的 pty_id 过期时 `web_leaf_session` 返回 `None` 而不发 `terax:web-activate`；页面重试，下一次 `web_tabs` 会清掉过期 id，多一次往返就自愈。- **已接受**。

### 已修（记录）

- **输出只在客户端发帧时才排空**：`handle_ws` 现在每 10ms 轮询都排空会话输出队列，与客户端输入无关，外加 30 秒服务端 PING。只看不打字的手机也能持续收到输出。
- **`web_unsubscribe_all` 会踢掉同一会话的其它观看者**：`web_subscribe` 返回该连接专属的 `SyncSender`，断开和切会话只移除这一个。
- **`opening` 流程死锁自动连接**：页面点击时清掉 `attachedId`，记 `pendingAttachId` 让自动连接指向**被点的**会话，最多重试 3 次。
- **退出从不通知 web**：waiter 在回收会话前广播 `WebMsg::Exited(code)`，页面清状态并提示。
- **续帧重组没有总长上限**：重组后的消息封顶 1 MiB，超过 125 字节的控制帧拒绝。
- **没有连接上限、没有心跳**：并发 WS 连接上限 8（超限返回 503），每 30 秒 PING。
- **`web_leaf_session` 可能解析到过期 pty id**：`web_tabs` 会清掉会话已消失的 `pty_id`，基于 cwd 的猜测式兜底整个删掉。
- **RFC 6455 实现过于宽松**：拒绝未掩码的客户端数据帧和超长控制帧。
- **waiter 的尾部输出到不了 web 观看者**：尾部现在也广播给订阅者。
- **`/auth` 的 POST body 假设一次读完**：改为解析 `Content-Length` 并显式读完剩余字节（封顶 256）。
- **前端 `onerror` 会关掉刚建立的连接**：加了 `mySeq === wsSeq` 判断。
- **端口从 17001/17002 改为 34269（dev）/ 34268（release）**，`RUNNING` 只在成功绑定后置位，状态栏绿点意味着 accept 循环真的在监听。
- **状态徽标**：`web_status` 返回 `{running, connections, failed_logins}`，失败登录数暴露在桌面上，暴力尝试是可见的而不只是被服务端限速。

## PTY 会话（`session.rs` / `mod.rs`）

### 未决与已接受

- `pty_has_foreground_process` 和 `pty_has_foreground_job` 在 Windows 上是同一套实现（数所有子进程）。"前台"在 Windows 上没有意义，所以任何带后台子进程的隐藏 leaf 都会被当成忙碌、槽位一直停靠。是功能缺口不是崩溃。- **未决**。
- 锁顺序不一致：`web_tabs()` 是 sessions 读锁 -> web_tabs 锁，`web_leaf_session` 是反过来。今天不会死锁（读锁共享），但只要有一处变成写锁就脆了。- **未决**。
- `pty_write` 和 web 输入路径用 `let _ =` 吞掉写错误：shell 已经退出时，在手机上打字完全没有反馈。- **未决**。
- `web::start` 在启动路径上 `block_on` 地起兜底会话，会短暂阻塞主线程。- **未决**。
- Windows 退出竞态可能丢尾部输出：waiter 轮询 reader 的期限从 50ms 提到 2 秒，但轮询终究不是真正的 join，病态负载下尾部仍可能丢。- **已接受的残余**。

### 已修（记录）

- **慢订阅者被静默永久丢弃**：`web_broadcast` 在有界队列满时驱逐订阅者，并告知 `output too fast, resubscribe`，页面重连后由首屏补齐。
- **256 KiB 历史环整个删除**，见下面"手机首屏改用桌面缓冲区"。

## 手机端对话视图

### 未决与已接受

- **气泡分类是启发式的**：程序怎么重绘不是它声明的东西。认不出来的状态部件会变成一个零散的小气泡，异常的重绘模式会丢历史而不是搞坏内容。`conversation.ts` 里的 `WIDGET` 和 `detectProgram` 是唯一的工具相关知识，刻意集中在一处。- **已接受**。
- **连接时恢复的首屏不拆气泡**：页面不知道自己连上之前发过什么，`markEchoes` 无从匹配，所以首屏作为一整块输出到达。- **已接受**。
- **手机屏比 PTY 矮时，alt 屏 TUI 的底部看不见**（alt 屏没有滚动缓冲）。- **已接受**。
- `MarkdownPreviewPane` 读文件没有大小上限（编辑器封顶 50 MB），巨大的 markdown 会整个进预览 DOM。- **未决**。
- `tauri.conf.json` 的 `assetProtocol.scope: ["**"]` 允许 `asset://localhost` 读取进程能读的任何文件。确认没有代码路径依赖任意 asset 访问后应该收紧。- **未决**。
- 设置窗口：`get_webview_window("settings")` 在窗口关闭后仍返回句柄，对已关闭的原生窗口调 `show()` 不会重建它，所以关掉之后再开设置可能没反应。需要验证并在关闭时销毁重建。- **未决**。
- `useWindowTitle` 每次渲染都重算标题字符串（没有 memo），`setTitle` IPC 在每次 App 渲染时都发。无害但浪费。- **已接受**。
- `respawnSession` 调 `s.pty?.close()` 不 await，慢的 IPC 关闭会让旧 pty 的 `onExit` 落在新会话起来之后。`close()` 里已释放 channel 处理函数，窗口很小，后果是一条多余的"shell 已退出"提示。- **已接受**。
- `WindowControls` 的 effect 在异步注册于卸载之后完成时，可能泄漏一个 `onResized` 监听（没有 disposed 标志）。- **已接受**。

### 已修（记录，按主题）

**手机曾经渲染桌面网格，字太小到不可读。** 实测 192×28 的 PTY 配 335×590 的视口：网格被缩放到 0.238，字号剩 **3.3px**，74% 的屏幕是空的。缩放到适宽、左右拖动、按手机宽度重排，这三件事在终端视图里互斥。现在页面**完全不渲染网格**。相关的死代码（`inAltScreen`、`applyGridScale`、`scrollCursorIntoView`）随重写一起删除。

**alt 屏滚动检测从来没触发过。** `translateToString(true)` 会在带属性的单元格上留下尾随空白，而 TUI 会用带样式的空白填满整行，所以同一行在相邻两帧之间比较结果不等。实测 158 帧 0 次滚动，历史在静默丢失。现在捕获时右侧裁空白，`conv.stats` 用来发现复发。

**footer 切分吞掉整屏。** `dropFooter` 用 `raw !== text` 判断"这行有框线字符"，但 `stripChrome` 同时也裁缩进，于是每一行有缩进的行都算装饰，`toBlocks` 返回零个块。改为按框线字符占比、前导横线、或按键提示判断。

**后来 footer 改成按位置切分而不是按文字。** 按"像不像装饰"自底向上走会被 Claude 的子代理标签（`◯ Explore Search repo …`，框线字符加文字，读起来像内容）卡住，把整块状态区漏进正文。现在以底部的状态横线为锚，footer 的**最底行按位置抽成 `Conversation.agents`**，渲染成输入区上方独立的 chip 条。**从不匹配任何 agent 名字或任务文字**，改名照样能用。

**「横线」必须是一串框线字符。** 单个栏位标记（`┃`、`▣`）是可能承载内容的那行上的装饰。没有这条规则，opencode 把每条用户消息都画在 `┃` 栏位下面，footer 会把它们全吃掉。

**回显匹配按长度分层。** 发出去的 `claude` 被当子串匹配，把 Claude 自己的界面文字（`Run claude doctor`、cwd 路径 `…\opencode\claude-fresh`、`Opus 5 claude-fresh` 模型行）全标成了用户消息。现在 ≥10 字符可作子串，4 到 9 个字符必须基本就是整行，更短的必须完全相等。

**`detectProgram` 要按词边界匹配，且 Claude 优先。** cwd 路径里含 `opencode` 会把正在跑的 Claude Code 误判成 OpenCode。

**`isBanner` 只对首帧生效。** 它按稀疏度抑制启动画面，把 opencode 画在同一张 ASCII banner 下的退出/保存提示也吞掉了，用户看不到选择。

**回放要切片喂。** 全屏程序画过的每一帧一次性写进缓冲区、只读最后一帧，会把整段对话塌成当前屏。`writeBacklog` 改成按约两行网格宽度切片（`max(64, min(2048, cols * 2))`），片间读取；2048 字节在 138 列网格上约等于 15 行，相邻两次读取毫无共同内容，`detectScroll` 一次都不触发。

**后台标签页里渲染会停。** `requestAnimationFrame` 在 `document.hidden` 时不触发，而手机锁屏就是这个状态。退回定时器。

**单字符消息被丢掉。** `pending` 过滤器带 `length >= 2` 守卫，`1` / `2` / `3` 这个恰好是测试用例的输入从来没渲染出来。短消息改为要求精确匹配。

**alt 屏退出时最后一屏原样追加。** 输入框、状态行和回显的消息变成了匿名的 AI 输出。现在走与其它帧相同的解析。

**手机曾经强加自己的 120x40 网格。** `FIXED_GRID` 作为 attach 偏好在首个按键时应用，把共享 PTY 调了尺寸，让桌面的屏幕在一个为它排版的程序下重排。手机不渲染网格所以没有尺寸诉求：现在 attach 不带 cols/rows，永不 claim。

**网格乒乓。** 桌面每隔约 5 秒会写终端调色板（对 TUI 调色板查询的 OSC 4 回复，加上 `ESC[I` 焦点上报，由 xterm 的 `onData` 转发），每一次这样的写入都经 `pty_write` 把会话抢回桌面网格，于是被旁观的会话在每次 claim 之后都在两端尺寸之间来回跳。`looks_like_protocol_response` 让这些应答照常送达 PTY 但不再 claim。

**一屏被压平成气泡。** `setLive` 现在把它拆成正文、进行状态、模式、选项和 agent 条，各自渲染到各自的位置。拆的过程中浮现两件事：进行状态画在输入框正上方、可能落在 footer 最底行（也就是 agent 条的位置），一个只是在思考的程序因此被报成"正在跑子代理"，所以它必须**最先**取出；菜单切分的第一版在任何不匹配的行上重置计数，于是画在选项下面的按键提示（`(up/down to navigate, enter to select)`）会把整个菜单丢掉。

**菜单扫描不能依赖 footer 切分。** Claude 把要写的 diff 画在两条虚线之间，`splitFooter` 锚定了下面那条，于是问题和三个选项全被算成 footer，`choices` 空着而 agent 一直在等。现在 `findChoices` 先在整屏上扫描，footer 之后只允许从菜单下方开始。**菜单是屏幕上唯一 transcript 不可能知道的东西，所以它绝不能是解析其余部分出错时最先坏掉的那个。**

**对话框会把整屏一起拖进来。** transcript 之下屏幕本来不渲染，只在菜单待处理时渲染。渲染全部 `liveBlocks` 会把 Claude 的欢迎横幅摆在问题上方。对话框自己的上下文现在是有界的（`promptBlocks`：菜单及其上方 12 行），显示的是问题、文件和 diff。**看不到要写什么就批准"创建 hello.txt"，那是猜，不是决定。**

## 手机首屏改用桌面缓冲区（2026-08-19）

**手机打开时冒出桌面早就没有的记录，然后又都消失了。** 首屏内容来自 `session.rs` 里每会话一个的 256 KiB 滚动字节环，那是输出的第二份存储，从构造上就必然和终端分叉：

- 它熬过桌面的 `clear`（流里的 clear 不会清掉解析器的 `turns`），所以桌面已经丢掉的内容又回来了；
- 它按**字节**封顶而终端按**行**封顶，所以一个空闲 shell 的环能横跨好几天；
- 回放它意味着约 1000 次切片写入、每次之间渲染一遍，于是旧记录肉眼可见地堆上屏幕，然后 `MAX_LINES`（4000）又在回放继续时把它们从头裁掉。所以是"全都出现，然后全都消失"。

环删掉了。连接时服务端先订阅观看者，再向窗口索取该 leaf 的终端缓冲区（`terax:web-snapshot` -> `snapshotLeaf` -> `web_snapshot_reply`），作为一个首屏帧发出。活槽位走 `SerializeAddon` 序列化，停靠的 leaf 用存下的快照加 `DormantRing.peek`。`attached` 加了 `seed` 字段，有首屏时页面不再强设缓冲模式（序列化的形式自己会重新进入 alt 屏），`writeSeed` 在那个 `?1049h` 处切一刀，让滚动缓冲先被读成历史。

**已接受**：订阅和序列化之间那几毫秒的输出可能既在首屏里又在队列里，繁忙会话可能在接缝处出现一小段重复。替代方案是让窗口替我们数字节。

驱动真实桥接时又浮现两个 bug：

- **停靠的面板首屏是空的。** `serializeLeaf` 只按 `currentLeafId` 匹配槽位，但停靠一个面板会把它的内容留在槽位里挂在 `retainedLeafId` 下，**同时**清掉会话存下的快照（绑定时会把存的那份写回槽位再丢弃）。于是隐藏标签的缓冲区恰好在查找唯一没检查的地方。现在也匹配保留的槽位，`snapshotLeaf` 依次尝试槽位 -> 存下的快照 -> DormantRing。
- **安静的命令行渲染成一张白页。** `flushNormal` 刻意停在光标行上方（那行可能是写了一半的提示符），而一个停在提示符的 shell 全部内容就是那一行。这对实时输出是对的，对首屏是错的。`writeSeed` 现在把它发一次并推过读游标。

## agent 对话改从 agent 自己的记录读（2026-08-19）

手机曾经靠解析 TUI 的屏幕来重建 agent 对话。驱动真实 opencode 会话暴露了这条路的代价：它画一个**右侧信息栏**（会话名、token 数、花费、LSP 状态、cwd、分支），和对话在同一批行上，当成文本读就会互相穿插 - `1% used` 粘在句子前面、裸 cwd 路径变成独立气泡、时间戳混进输入的回显里。几何式的侧栏切分能修好那一屏，但这类 bug 不会有尽头：转圈行不认出来就是句子，模式的位置随状态栏布局变，agent 的思考和它的回答无法区分。

两个工具本来就把对话写下来了。现在从那里读（`src-tauri/src/modules/transcript/`）：Claude Code 读它每会话一份的 JSONL，opencode 读它的 SQLite 数据库（只读；它运行中的 TUI 不监听任何端口，`opencode export` 每次读取要起一个进程，所以没有别的活数据源）。`rusqlite`（bundled）只为这件事引入。两者归一成同一结构，作为 `transcript` WebSocket 消息推出去；页面据此渲染对话，屏幕只留给一件 transcript 不记录的东西：**程序此刻在等你选什么**，那是实时 UI 状态。

**闸门**（让空闲会话零开销）：必须真有 agent 在跑（`Session::web_agent`，由既有的 OSC 检测喂 - 昨天跑过 agent 的目录不该在今天的提示符上显示那段对话）、文件指纹必须变过、revision 必须变过。

**实测验证**：opencode 报出 `mode=build`、`model=deepseek-v4-flash`、用户消息、回复和背后的思考；Claude Code 报出 `mode=auto` 和它的轮次。两者的实时屏幕块都渲染为空 - 屏幕不再被当作对话来读。真实的 Claude Code 权限对话框端到端验证过两次：三个按钮带正确的键和标签、选项 1 标为选中、问题和 diff 在旁边，点按钮真的答复了 Claude（`hello.txt` 和 `world.txt` 以正确内容落盘）。

**顺带修的**：transcript 的 cwd 原本在 attach 时捕获后不再重读，于是之后 `cd` 过的 shell 一直显示上一个目录的对话。现在每次轮询都查一次。

## 打包版把商店别名当成 shell 启动了（2026-08-19）

**打包版里每个终端都能打开、然后完全不接受输入。** 开发版没事，这就是全部线索。

`which_in_path` 接受任何满足 `is_file()` 的 PATH 命中项。微软商店的**应用执行别名**满足它：那是一个 0 字节的重解析点，Explorer 会替你解析。ConPTY 经 `CreateProcessW` 启动，它不解析，于是子进程起来就是坏的。

只有打包版中招，是因为别名在 `%LOCALAPPDATA%\Microsoft\WindowsApps`，而在从 Explorer 继承的 PATH 里这个目录排在 `C:\Program Files\PowerShell\7` **前面**；从开发 shell 启动时顺序相反，`cargo run` 永远够不到别名。在出问题的机器上实测：

```
C:\WINDOWS\System32\WindowsPowerShell\v1.0\          （这里没有 pwsh.exe）
C:\Users\<user>\AppData\Local\Microsoft\WindowsApps  <- 0 字节，赢的是它
C:\Program Files\PowerShell\7\                        <- 301368 字节，真的那个
```

不是任何近期改动引起的：商店版 PowerShell 7.6.5 是两天前装的，别名就是那时上 PATH 的。

修法是 `is_real_executable`：PATH 命中项只有在它是**非零长度的文件**时才算数。**长度是诚实的判据** - 真正的可执行文件永远不是 0 字节，而且它覆盖任何别名，不只是那一个文件夹里的。三处都应用了：PATH 搜索、用户配置的 shell 覆盖、shell 选择器。在真实打包二进制里验证过，现在启动的是 `C:\Program Files\PowerShell\7\pwsh.exe`。

**同一台机器上还有第二个独立成因**，值得知道是因为它从外面看一模一样：`pwsh.exe` 在 `HKCU\Software\Microsoft\Windows NT\CurrentVersion\AppCompatFlags\Layers` 下被标了 `~ RUNASADMIN`（文件属性里的"以管理员身份运行此程序"）。非提权进程启动它会拿到 `CreateProcessW ... (os error 740)`，ERROR_ELEVATION_REQUIRED，面板根本打不开。在修掉别名之前这一条是被掩盖的：解析器选中了 0 字节别名，它"启动成功"然后坐死在那里，提权问题从未浮现。

Terax 在启动失败时不会退到另一个 shell：一个存在但起不来的 shell 会终止这次尝试。**目前是有意的** - 按用户的决定，这台机器上以管理员身份启动 Terax，那本来也是想要的（替代方案是静默退到 `cmd.exe`，然后疑惑提示符为什么不对）。如果在一台不允许提权的机器上出现，值得重新考虑。

## 移动端桥接加固的工具链（2026-08-19）

为"手机上正常跑 opencode / claude"建立的一套可复用工具，留在 `scripts/` 下：

- `web-capture.mjs` - 驱动手机桥接 WebSocket 录制真实会话（含 cold-leaf 的 opening 重试）。
- `web-replay.mjs` - 把捕获按页面同款逻辑回放进 `Conversation`（`--trace` 看逐帧 live blocks，`--screen-at` dump 原始屏）。
- `web-synthetic-test.mjs` - 合成屏幕回归：1/2/3 菜单、权限框、启动页、退出提示、agent 位置抽取、输入框排除、必须保持是正文的散文编号列表、散文列表压在真菜单上方、两种首屏形态（安静的 shell，以及滚动缓冲加运行中的程序）。
- `e2e-phone.mjs` - Playwright 驱动真实页面（cookie 免密码）：登录、列表、attach、发送、气泡。

**热部署稳定性**（`热部署.ps1`）：启动前**等 `terax-prod.exe` 解锁**（`FileShare.Delete` 探测，最多 10 秒）并**等开发端口真正释放**（轮询，最多 10 秒）。否则孤儿实例锁住 exe，cargo 覆盖失败（`拒绝访问 (os error 5)`）会连带把整个 `tauri dev` 和 vite 一起带走。它**刻意不碰 34268**，也会跳过被 `target/release/terax-prod.exe` 占用的端口，所以重启开发环境不会杀掉正在运行的打包版。

## 其它已修（记录）

- **OSC 52 可以从命令输出里写剪贴板**：剪贴板处理函数接受任何输出里的 OSC 52，包括正在运行的命令（SSH、`cat` 一个攻击者的文件）。现在它读共享的 `ShellIntegrationState`，在 `inCommand` 期间拒绝。
- **Markdown 预览里的相对链接会把应用导航走**：`MarkdownLink` 拦了外部 URL 却让相对链接（`./foo.md`、`#section`）执行默认浏览器导航，整个离开 SPA。现在一律 preventDefault，外部 scheme 交给系统浏览器，相对链接按 markdown 文件所在目录解析。
- **同一个 markdown 文件会开成两个标签**：`planMarkdownTabOpen` 只对已有的 `markdown` 标签去重，已在裸编辑器里打开的文件会再开一个渲染标签。现在也会找到裸 `editor` 标签并把它翻成渲染态（除非有未保存改动）。
- **设置窗口的 tab 值在 URL 里没校验**：`open_settings_window` 现在白名单化六个已知分区。
- **资源管理器的定位按钮忽略 git 标签**：`explorerActiveFilePath` 只解析 `editor` / `markdown`，从 git 变更面板打开的文件（git-diff / git-commit-file）从来不会在树里高亮或展开。现在按状态栏同样的方式解析（拼 `repoRoot` + 仓库相对路径）。
- **git 变更面板的丢弃打到了活动仓库上**：多仓库工作区里，文件属于另一个仓库时 pathspec 匹配不上，丢弃静默无效。`pendingDiscard` 现在带着文件自己的 `repoRoot`。
- **git 标签在「窗口」面板里看不见**：`OpenFilesPanel` 按 `ownerTabId` 过滤，而 git 标签没有归属，所以只要有终端处于活动状态它们就消失。git 标签现在恒显示（仓库级，不按命令行划分）。
- **提交 / 提交并推送按钮要等一会儿才显示忙碌**：`setLocalActionBusy` 跑在异步预检查**之后**，装了 hook 时那一趟往返很慢。忙状态现在在点击的当下就置上。
- **手机窗口切换器要嵌套切换**：改成一个扁平可滚动的列表，每个空间的标签是一行，它的终端紧跟在下面。
- **手机页无限重连**：根因是阻塞 `read_exact` 上的 200ms 读超时。`read_exact` 在帧中途遇到 WouldBlock 会丢掉已经读到的字节，于是分片的帧永久丢失、解析器失同步；更糟的是 `read_message` 把超时包装成 `"read ws frame head: timed out"` 而 `handle_ws` 匹配裸字符串 `"timed out"`，匹配永远不成立，于是每一个安静时段（200ms 没有客户端输入）都掉进 `break` 丢连接。现在 socket 是非阻塞的，`WsConn` 把读到的字节累积在缓冲里，解析器只在**完整消息**可用时才消费；循环每 10ms 轮询，只有连续 90 秒零字节才丢弃对端。

## 死代码与过期导出

| 位置 | 是什么 | 状态 |
|---|---|---|
| `session.rs` | `Session::web_viewer_count` | 已删 |
| `web/mod.rs` | `handle_ws` 里够不到的 `OP_CONT` 分支 | 已删 |
| `lib/platform.ts` | `IS_MAC`、`IS_LINUX` | 已删 |
| `src/web/main.tsx` | `main.ts` 的重复副本 | 已删 |
| `rendererPool.ts` | 第二个本地 `IS_MAC` 常量（恒为 `false`） | 未决 |
| `editor/lib/extensions.ts` | `readOnlyCompartment`，无引用 | 未决 |
| `editor/lib/languageResolver.ts` | `preloadLanguages()`，无调用方 | 未决 |
| `source-control/worktreeOps.ts` | `gitWorktreePrune()`，无调用方 | 未决 |

`knip` 报告这些前端依赖未使用：`@fontsource/jetbrains-mono`、`@radix-ui/react-use-controllable-state`、`@tauri-apps/plugin-clipboard-manager`、`use-stick-to-bottom`、`zod`。删之前逐个确认，有些可能在 Rust 侧或构建步骤里用到。

## 仓库卫生

- `terax-awei.exe`、`flake.nix` / `nix/` / Linux 与 macOS CI 任务 - 已删除，workflow 现在只有 Windows。
- `bash.exe.stackdump` **仍然被跟踪**（本文早先记为"已删除"，是错的）。它是 Git Bash 的崩溃转储，在这台机器上会被反复重新生成，所以每次都出现在 `git status` 里。应该 `git rm --cached` 并加进 `.gitignore`。- **未决**。
- `docs/history/` 下的三份移植文档已合并成 `git-移植档案.md`，引用已删除代码的部分去掉了。
- `热部署.ps1` 把 `pnpm tauri dev` 作为后台进程启动（隐藏窗口，日志到 `dev.log`，PID 在 `.terax-dev.pid`，已 gitignore），脚本立即返回。重跑会先杀掉记录在案的进程树（`taskkill /T`），`-Stop` 只停不启。
- `.github/workflows/` 在砍掉多平台之后只剩 Windows，动发布工具链之前重新确认。

## 文档漂移

- 七份架构文档、`TERAX.md`、`README.md`、`ROADMAP.md`、`docs/README.md` 和本文已全部改为中文并按"与架构文档重复"精简（第 13 条）。**代码注释保持英文**，这是明确接受的中英混排。
- 架构文档里过期的行号和已删除的命令名（`fs_list_files`、`fs_grep`、`fs_glob`；实际是 `fs_search`、`fs_grep_interactive`）已随重写清掉。文档里不再钉行号。
- `web-terminal-bridge.md` 曾承诺服务端从不发送的二进制标题帧，现在明确标注"尚未实现"。

## 另见

- [`TERAX.md`](../TERAX.md) - 架构事实来源
- [`docs/README.md`](README.md) - 贡献者指南索引
- [Web 终端桥接](architecture/web-terminal-bridge.md) - 本文审计的传输、认证与协议
