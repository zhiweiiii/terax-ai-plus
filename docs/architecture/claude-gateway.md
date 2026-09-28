# Claude Code 本地网关

本文是 `TERAX.md` 的展开。与 `TERAX.md` 冲突时以 `TERAX.md` 为准。

回环上的一个 Anthropic Messages 端点（`src-tauri/src/modules/gateway/`），让 Claude Code 用上只卖 OpenAI 格式接口的中转站。

## 要解决的问题

Claude Code 只会说 Anthropic Messages API，而多数中转站只提供 OpenAI Chat Completions。以 OpenCode Go 为例，它的 Zen 网关有两个端点：

- `https://opencode.ai/zen/go` 是 Anthropic 兼容的
- `https://opencode.ai/zen/go/v1` 是 OpenAI Chat Completions

看起来直接把 `ANTHROPIC_BASE_URL` 指向前者就完了，但订阅里的 Chat 组模型（GLM、DeepSeek、Kimi、MiMo）走那条路依赖服务端自己做格式转换，而这件事没有任何文档承诺。本地转换正是这个网关存在的理由。

```
Claude Code
  │  POST /p/<providerId>/v1/messages   (Anthropic Messages)
  ↓
本地网关 127.0.0.1
  │  转换
  ↓
中转站 (OpenAI Chat Completions 或 Anthropic)
```

## 端口与生命周期

- 开发版绑 `34267`，打包版绑 `34266`（`cfg!(debug_assertions)`），与 Web 桥接的 34268/34269 错开，四者可并存。
- accept 循环一个线程，每条连接再一个线程，和 Web 桥接同一套阻塞模型。

**默认不启动。** 开应用不路由任何东西、不 bind 任何端口。唯一会开端口的地方是 `shell_env()`，也就是某个真要用它的 shell 正在 spawn 的那一刻；`gateway_set_config` 只存配置，不起监听。tokio runtime 与 reqwest client 同样是 `OnceLock`，第一次真正转发时才创建。不用这个功能的安装，这些东西一个都不存在。

## 只绑回环

**绑 `127.0.0.1`，绝不 `0.0.0.0`。** 它转发的是用户付费的凭据，LAN 监听等于把订阅交给网内任何人。这条与 Web 桥接刻意相反：那个要给手机访问，所以绑 `0.0.0.0` 并用 Argon2id 密码把关；这个没有任何理由离开本机。

入站另有网关令牌校验（`x-api-key` 或 Bearer 都收），令牌存在 `%LOCALAPPDATA%/terax/gateway-token`，跨重启不变。不变是必须的：它变了，所有已配置好的命令行会在下次请求时静默失效。

## 按命令行隔离

供应商 id 钉在 URL 路径里（`/p/<id>/v1/messages`），不是取全局选择。

`$env:` 本来就只作用于一个 shell，但如果网关按全局"当前供应商"路由，在终端 B 切一下就会把终端 A 里**已经在跑**的 Claude Code 悄悄改道，env 的隔离就是假的。路径是唯一能预设进 Claude Code 请求的部分（它只会在 `ANTHROPIC_BASE_URL` 后面接 `/v1/messages`），所以 id 走这里。

前端按 leafId 记住每个命令行钉住的是谁（`src/modules/terminal/lib/gatewayPins.ts`）。leafId 由只增不复用的计数器发放，所以映射不会张冠李戴。没有前缀的请求才回落到全局选择，留给手工配置的端点。

钉住的供应商被删掉时返回 **503**，绝不静默改用当前选中的那个去花钱。

pin **刻意不持久化、也刻意不从"当前供应商"继承**：继承意味着开个应用就悄悄起监听、并把每个新 shell 指向一个付费端点。代价是每次开应用要重新选一次，这是明确接受的取舍。

## 环境变量在 spawn 时注入

不往终端里敲命令。链路是：

```
点击切换
  ↓ setGatewayPin(leafId, providerId)
  ↓ respawnSession(leafId)              关掉旧 pty，开新的
  ↓ openPty(..., leafId, gatewayPin(leafId))
  ↓ pty_open(gatewayProvider)
  ↓ session::spawn → shell_init::build_command → apply_common → apply_gateway
  ↓
CommandBuilder:
    ANTHROPIC_BASE_URL   = http://127.0.0.1:34267/p/<providerId>
    ANTHROPIC_AUTH_TOKEN = <网关令牌>
    env_remove ANTHROPIC_MODEL
    env_remove ANTHROPIC_API_KEY
```

在 prompt 上敲赋值语句会落进终端正文和 PSReadLine 历史，而且对**已经在跑**的 Claude Code 无效（进程只在启动时读一次环境）。spawn 时注入两个问题都没有。

两个 `env_remove` 和赋值一样重要：

- `ANTHROPIC_MODEL` 留着会把所有档位钉死在一个模型上，按角色路由就废了。
- `ANTHROPIC_API_KEY` 会以 `x-api-key` 发出，而网关读它的优先级高于 Bearer。用户 profile 里残留一个，就会盖过这里设的令牌，把每个请求变成一个莫名其妙的 401。

**WSL 终端直接跳过**：WSL 里的 `127.0.0.1` 到不了 Windows 的回环监听，路由它等于发一个永远连不上的 URL。

## 一次请求

```
route_of()        剥出 /p/<id>，确认是 messages 端点
  ↓
校验网关令牌      不对就 401
  ↓
provider_by_id()  按 URL 里的 id 取，不看全局 current
  ↓
upstream_model()  claude-sonnet-4-5-20250929 → 按 opus/sonnet/haiku 归档 → glm-5.2
  ↓
session_of()      从 metadata.user_id 挖会话 id（转换前，OpenAI body 没有 metadata）
  ↓
convert::request_to_openai()   仅当 provider 是 openai_chat
  ↓
upstream::send()  reqwest
  ↓
失败？ → 把上游的错误信息挖出来，包成 Anthropic error，原样返回状态码
  ↓ 成功
stream:true ?
  ├─ 是 → 边收边转：stream::Converter.push(chunk) → 立刻写 socket
  └─ 否 → 读完 → convert::response_to_anthropic() → JSON
```

`block_on` 在连接线程上驱动 future，所以里面阻塞地写 socket 只卡自己这条连接，不卡 runtime 的 worker。

## 按角色路由模型

Claude Code 发的是 `claude-sonnet-4-5-20250929` 这类带日期的全名，按 opus / sonnet / haiku 关键词归档，映射到中转站的真实模型。所以切换时**清掉** `ANTHROPIC_MODEL` 而不是设置它。

`[1m]` 是客户端侧的 1M 上下文声明，上游会拒收，路由前剥掉。

## 转换层

`convert.rs` / `stream.rs` / `sse.rs` 是纯函数，不认识 Provider、不碰 IO。

SSE 走**推送式状态机**而不是 Stream 组合子，因为连接线程本来就是同步读写的：`Converter::push(bytes) -> Vec<u8>`，喂上游字节、拿客户端字节。跨 chunk 被切成两半的多字节字符由 `sse::append_utf8` 兜住。

协议上的硬约束：

- **Anthropic 每条消息流只允许一个 `message_delta`**，而部分中转站会连发多个带 `finish_reason` 的 chunk，重复发会让 Claude Code 直接断开连接。转换器只认第一个，并把它压到 `[DONE]` 才发出，这样 usage 是最终值。
- 上游报错时只发 `error` 事件、**不补成功收尾**，绝不把失败伪装成正常完成。
- 请求体里 `stream_options.include_usage` 必须补上，否则兼容上游在流式下不返回 usage，每个流式请求都会记成零 token。
- 工具调用参数用固定的键序列化，让同一次调用跨轮产生相同字节，以免打掉中转站的前缀缓存。

## 依赖：零增量

`tauri-plugin-updater` 已经把 **reqwest（含 `stream` feature）、rustls、hyper、tokio 的 net** 拉进依赖树，网关只是把已经链接进来的东西声明出来。实测打包体积只比上一版大 **549 字节**，而网关本体约 2100 行 Rust。

服务端沿用 Web 桥接同款的阻塞 accept 循环加一线程一连接，不引入 axum。

### reqwest 的两个 panic 坑

两个都会在**第一次转发时**炸，都已处理：

1. **没有 crypto provider。** 更新插件选的是 `rustls-no-provider`，reqwest 在这种编译配置下找不到 provider 会直接 `panic!("No provider set")`。插件自己会装 ring provider，但那是**惰性**的，只在检查更新时才发生，可能晚于第一次转发，也可能永远不发生。所以 `upstream.rs` 自己装。
2. **`RequestBuilder::send()` 在被调用时就注册超时定时器**，必须在 runtime 上下文里调用，不能作为 `block_on` 的实参在外面求值。同理 client 的构造也要在 runtime 里（连接器构建时就向 reactor 注册解析器和定时器）。

## 供应商的怪癖按 host 判

不按格式判，因为这是那个服务自己的要求，不是协议的一部分。

- **OpenCode Zen 的 Go 计划缺 `x-opencode-session` 会直接 400**（"cannot be routed efficiently"），它靠这个把一轮对话固定在同一后端。会话 id 从 Claude Code 的 `metadata.user_id`（形如 `..._session_<uuid>`）里挖，取不到时回落到一个**进程内固定值**：每次请求换一个新的会正好毁掉这个头存在的意义。

## 连通性测试

切换供应商前会发一个真实的最小请求走完整链路，不通就不切换，并把上游的原话报出来（可选中、可一键复制，因为里面常带要拿去找服务商对账的 request id）。

只做可达性探测是不够的：它分不清"配置正确"和"key 填错了 / 端点路径不对 / 模型不在套餐里"，而后者才是用户真正在问的。

探针发 `max_tokens: 16` 而**不是 1**：有中转站校验 `max_tokens > 2`，用 1 会把一个好的供应商测成坏的。

## 刻意不做的

没有故障转移、没有熔断器、没有用量统计入库。这些是 cc-switch 的产品范围，在这里只会让功能比它该有的复杂得多。

## 相关

- [安全模型](security-model.md) - 回环绑定与令牌在整体信任边界里的位置
- [PTY shell 集成](pty-shell-integration.md) - `apply_common` 与环境注入发生在哪
- [双进程模型与 IPC 命令参考](two-process-model.md) - `gateway_*` 命令
