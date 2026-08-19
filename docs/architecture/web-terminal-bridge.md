# Web terminal bridge

The desktop app embeds a small HTTP + WebSocket server that exposes the same
PTY sessions to a phone or another machine over plain HTTP, no Tauri runtime
required on the client. The mobile page is a single-file xterm.js app served
by the same port.

Source of truth: `src-tauri/src/modules/web/mod.rs` (server), `src/web/`
(mobile page), `src/app/hooks/useWebTerminalSync.ts` (desktop tab sync).

## Ports and process

- Dev builds bind `34269`; packaged (release) builds bind `34268`. Selected
  with `cfg!(debug_assertions)` so the two can run side by side.
- The main binary is named `terax-prod` in both profiles (Cargo `[[bin]]`);
  the hot-deploy and packaging scripts reference it.
- The server runs on its own accept thread and never blocks Tauri IPC. A bind
  failure only logs a warning and the desktop app keeps working.

## Mobile page

`web.html` + `src/web/main.ts` + `src/web/style.css` build through a dedicated
vite config (`vite.web.config.ts`) into a single self-contained HTML file:

1. `scripts/build-web.mjs` runs `vite build --config vite.web.config.ts`
   (output: `dist-web/`), then inlines the JS and CSS into one HTML file and
   writes it to `src-tauri/web.html`.
2. The Rust server embeds it with `include_str!("../../../web.html")` and
   serves it for `GET /`.

The desktop build flow (hot-deploy and packaging scripts) runs
`build-web.mjs` before compiling Rust, so the embedded page is always fresh.

`热部署.ps1` frees the dev ports before starting: **1420** (vite dev server —
`strictPort: true`, so an orphaned server makes startup fail outright with
"Port 1420 is already in use"), **1421** (vite HMR) and **34269** (this
server). It deliberately does **not** touch **34268**, and skips any port held
by `target/release/terax-prod.exe`, so a running packaged app is never killed
by a dev restart. The orphan is usually a bare `node` process, which the
script's existing "kill `terax-prod` under `target/debug`" step cannot reach.

The page is a **conversation view**, not a terminal — see
[Mobile conversation view](mobile-conversation-view.md) for how the PTY byte
stream is turned into bubbles. It attaches to one desktop command line at a
time. xterm.js is still a dependency, but only as a headless ANSI parser; no
renderer (WebGL or DOM) is loaded.

The composer at the bottom sends text plus `\r` to the attached PTY — a shell,
an agent, a REPL, whatever is on the other end — with a key row for Ctrl+C /
Ctrl+D / Esc / Tab / arrows / Enter, which soft keyboards lack.

The ☰ button opens the **window switcher**:
a flat, scrollable list (~5 entries tall, scrolls without limit) in which
each group (space) label is an inline row and its terminals follow directly
underneath — no nested switching, just one scrollable list. Tapping an entry
attaches to that terminal; a terminal the desktop hasn't opened yet shows as
"未打开" and tapping it warms the tab through the server's `opening` flow.
The phone never resizes the shared PTY, so the desktop layout is never
disturbed by being watched.

## Authentication

The web terminal is a remote shell: it must not be wide open.

- Password is a server-side constant, compared as a SHA-1 digest
  (constant-time) in `web/mod.rs`.
- `GET /` without a valid `terax_web` cookie returns a minimal login page
  (title "请输入密码").
- The login page POSTs the password to `/auth` (POST only — no credentials in
  URLs); on success the server replies with
  `Set-Cookie: terax_web=<token>; Max-Age=604800` and the browser is
  redirected to `/`.
- `GET /ws` checks the cookie and returns 403 without it.
- Login is rate-limited: 5+ consecutive failures impose a 5 s lockout.
- The password digest and token live only in Rust; the page bundle contains
  neither.

## Desktop status indicator

The desktop status bar's bottom-right corner shows the remote service's health
(`src/modules/statusbar/WebStatusBadge.tsx`, polling the `web_status` command
every 2 s):

- Green dot: the accept loop is listening (bound + not stopped).
- Red dot: the server is not running (failed to bind or stopped).
- Router icon + number: live WebSocket viewer connections right now.
- Amber key icon + number: consecutive failed password logins since boot
  (drives the 5 s lockout). Hovering the badge shows the details.

`web_status` is a thin read-only Tauri command in `web/mod.rs` returning
`{ running, connections, failed_logins }` from the same atomics the server
maintains (`RUNNING`, `CONNECTIONS`, `FAILED_LOGINS`).

## WebSocket protocol

Endpoint: `/ws`. The server implements a minimal RFC 6455 server (handshake
+ frame codec, no external WS dependency). Server frames are never masked;
client data frames must be masked per spec. Messages are capped at 1 MiB
(frames and reassembled continuations); control frames at 125 bytes.
Concurrent connections are capped at 8 (503 beyond that). The server PINGs
every 30 s to keep half-open connections honest.

### Client -> server

First message is a text frame:

- `{"attach": <leafId>}` - attach to a desktop terminal by its leaf id (not
  the pty id; the server resolves the mapping). The phone sends **no** grid:
  it renders no terminal, so it has no size to want, and imposing one would
  resize the shared PTY and reflow the desktop's screen under a program laid
  out for it. Optional `cols` / `rows` are still accepted for a client that
  does render a grid; they are recorded as that client's preference and
  applied when it starts typing (see the grid-ownership note below).
- `{"list": true}` - request the session list.

Later messages:

- Binary `'0' + bytes` - write input to the attached session. The first write
  claims the session, applying the client's preferred grid if it stated one.
  A client that stated none (the phone) never claims the size.
- Binary `'1' + JSON{"cols","rows"}` - resize the shared PTY.
- Text `{"attach": <leafId>}` - switch sessions.

### Server -> client

- Binary `'0' + bytes` - terminal output. On attach, the **seed** is sent
  first (the desktop terminal's own buffer, serialized), then live chunks.
  See "Seeding a viewer" below. Reads are
  non-blocking: the server polls for complete frames on a 10 ms cadence
  while draining output, so a phone that only watches still receives live
  output and is never disconnected for idling. Peers that send no bytes at
  all for 90 s (dead network, crashed client) are dropped.
- Binary `'1' + bytes` - window title (UTF-8). Not implemented yet.
- Text `{"type":"sessions","sessions":[...]}` - each entry carries
  `id` (leaf), `cwd`, `title`, `active`, `live`, `space`.
- Text `{"type":"attached","id":N,"cols":C,"rows":R,"alt":bool,"seed":bool}` -
  attach confirmed, carrying the PTY's *current* grid (the owner's) so the page
  sizes its parser before anything arrives. `seed` says whether a seed frame
  follows. `alt` is the buffer mode to assume **only when it does not**: a seed
  carries its own mode (it re-enters the alternate screen itself), so forcing
  one before writing it would land the desktop's scrollback in the wrong
  buffer.
- Text `{"type":"transcript", ...}` - the agent conversation for the attached
  session, read from the agent's own record. Carries `source`
  ("claude"/"opencode"), `session_id`, `mode`, `model`, `messages[]` (role,
  text, `reasoning`, `tools`), `working` (when a turn is still running) and
  `revision`. Sent only while an agent is actually running, and only when it
  changed. See "Agent transcript" below.
- Text `{"type":"resized","cols":C,"rows":R}` - the shared grid changed (a
  claim or a resize); every viewer re-sizes its parser.
- Text `{"type":"opening","id":N}` - the desktop is spawning this tab; the
  page should re-list shortly (up to 3 retries, then it reports failure).
- Text `{"type":"exit","id":N,"code":C}` - the session exited; the page
  clears its attached state.
- Text `{"type":"error","message":...}` - includes `output too fast,
  resubscribe`, sent when the viewer was evicted for falling behind (the
  page reconnects, and the seed catches it up).

## Sharing the PTY

Desktop and web use the same `Arc<Session>` (`PtyState::web_get`). The
flusher thread in `session.rs`:

1. Sends every chunk to the desktop's Tauri Channel (existing path).
2. Broadcasts it to every attached Web viewer
   (`Session::web_broadcast`, bounded queues so a slow phone never stalls
   the PTY; an evicted viewer is told and reconnects).

Nothing on the Rust side stores session output. There is no history ring.

Input from either end writes to the same `writer`, so commands typed on the
phone echo on the desktop and vice versa.

## Seeding a viewer

What a phone shows when it attaches is **the desktop terminal's own buffer**,
fetched from the window on demand:

1. The server subscribes the viewer first, so output produced during the next
   step is queued rather than lost.
2. It emits `terax:web-snapshot` (`{leafId, requestId}`) and blocks up to
   `SNAPSHOT_TIMEOUT` (1.5 s) on the reply.
3. The desktop (`useWebTerminalSync`) calls `snapshotLeaf(leafId)` and answers
   through the `web_snapshot_reply` command. A leaf holding a renderer slot is
   serialized live (`serializeLeaf` -> `SerializeAddon`); a parked one answers
   from the snapshot taken when its slot was released plus the output that has
   arrived since (`DormantRing.peek`), which is the same two pieces the desktop
   itself replays when the pane comes back.
4. The server sends `attached` with `seed: true`, then the snapshot as one
   output frame.

The serialized form reproduces the terminal exactly: scrollback, current
screen, and, when a full-screen program is running, its alternate screen
re-entered with `?1049h` at the end. No reply within the timeout means no seed;
the phone simply follows the live stream from there (`seed: false`).

This replaced a 256 KiB rolling byte ring the server used to keep per session.
A second copy of the output inevitably drifts from what the desktop shows: it
outlived a `clear`, and it was bounded in *bytes* where a terminal is bounded
in *lines*, so an idle shell's ring spanned days. The phone opened on records
the desktop no longer had, and then lost them again as the parser's own line
cap trimmed from the front. The desktop's buffer is the only honest answer to
"what does this command line show".

The few milliseconds between step 1 and step 3 can appear both in the seed and
in the queue, so a busy session may show a small duplicate at the join. That is
the accepted cost of not making the window count bytes for us.

## Agent transcript

What a coding agent said is read from where the agent writes it down, not
parsed off its screen (`src-tauri/src/modules/transcript/`):

| Agent | Source |
|---|---|
| Claude Code | `~/.claude/projects/<escaped cwd>/<session>.jsonl` |
| opencode | `~/.local/share/opencode/opencode.db` (SQLite, read-only) |

Both are normalised into one shape: user/assistant turns with the agent's
`reasoning` and the `tools` it ran, plus the session's `mode`, `model` and
whether a turn is still in flight. Consecutive agent steps are merged into one
turn - both tools write a row per model round trip, and a reader wants the
answer rather than the machinery.

Three gates keep an idle session free:

1. **A running agent.** The PTY's own OSC detection (`pty::agent_detect`)
   records which agent started, and the session reports it (`Session::web_agent`).
   Without one nothing is read: a directory that ran an agent yesterday must
   not show that conversation over today's shell prompt.
2. **A filesystem mark.** `transcript::fingerprint` is a stat of the newest
   transcript file (and of opencode's database plus its write-ahead log).
   Unchanged means no read.
3. **A revision.** Only a transcript whose newest timestamp moved is sent.

Polled every 700 ms rather than watched, because one backend is a SQLite
database whose commits land in a write-ahead log that no filesystem event
describes usefully.

**Why opencode's database directly.** Its running TUI opens no port, so there
is nothing to attach to, and `opencode export` costs a process launch per read.
The database is opened read-only and never written, so a running opencode is
unaffected. It is opencode's own storage rather than an interface it promises,
so every failure path here degrades to "no transcript" and puts the phone back
on the screen view; a schema that moves under us must not break the page.

The one thing the transcript cannot know is what the program is asking you to
pick *right now* - a pending permission prompt is live UI state that neither
tool persists. That stays with the screen parse. See
[Mobile conversation view](mobile-conversation-view.md).

## Grid ownership

One session has one grid, and **whoever is typing owns it** (`SizeOwner`,
`claim`, `request_grid` in the pty module, with a 3 s `OWNER_COOLDOWN`).
The phone states no grid, so it never claims one: the PTY stays exactly as the
desktop has it, the program is laid out at the screen the desktop is showing,
and typing from the phone does not reflow it. The desktop reclaims only on real
keystrokes - xterm's
protocol answers (focus reports `ESC[I/O`, OSC 4 palette replies to the TUI's
palette query) are forwarded to the PTY but deliberately skip the claim
(`looks_like_protocol_response` in `pty_write`), so a watched session no longer
ping-pongs between the two ends' sizes after every claim. The byte stream is
laid out against the *owner's* grid — apps wrap long lines at that width, do
`\r` in-place redraws (progress bars, spinners, prompts), and address cells
with absolute cursor sequences — so it can only be parsed at that grid. The
phone therefore *parses* at exactly the PTY's current `cols`/`rows` (`attached`
carries them, and `resized` follows every change) but does not *render* a grid
at all: it extracts logical lines and re-wraps them at the phone's width. See
[Mobile conversation view](mobile-conversation-view.md). The server sends the
`attached` size **before** the seed so the parser is sized first; writing the
desktop's buffer at the wrong width garbles every wrapped line.

Each web connection subscribes with its own `SyncSender`; disconnect removes
exactly that subscription, never the whole table.

## Tab sync (all desktop terminals visible on the phone)

`useWebTerminalSync` in `App.tsx`:

- Syncs every terminal tab (leaf id, cwd, title, active, pty id, space name)
  to Rust via `web_sync_tabs` whenever the tab list changes.
- Listens for `terax:web-activate`; when the phone attaches to a tab with no
  live pty, the server emits this event and the frontend activates that tab
  (which spawns the pty through the normal `pty_open` flow).
- `pty_open` records leaf -> pty via `web_sync_leaf_pty`, so later attach
  requests resolve directly.

The phone's session list groups tabs by space name.

## Security notes

- Auth cookie `terax_web` is HttpOnly, SameSite=Lax, `Max-Age=604800`. The
  token and the password's SHA-1 digest are XOR-obfuscated in source and
  decoded at runtime, so neither appears in `strings` on the binary. The
  password itself is a hard-coded constant (only its digest is stored): the
  obfuscation is not encryption and the token never rotates, so this is
  acceptable for a LAN tool but not a real secret. The page bundle contains
  neither.
- Login is POST-only and rate-limited (5 consecutive failures → 5 s lockout).
- The server binds `0.0.0.0`, so anything reachable on the network can see
  the login page. Put the app behind a firewall / VPN for anything beyond a
  trusted LAN.
- WebSocket upgrade is rejected (403) without a valid cookie; the page itself
  only loads after login. Concurrent connections are capped at 8.
