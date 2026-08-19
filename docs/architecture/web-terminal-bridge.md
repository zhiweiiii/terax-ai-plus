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

- `{"attach": <leafId>, "cols": C, "rows": R}` - attach to a desktop terminal
  by its leaf id (not the pty id; the server resolves the mapping). `cols` /
  `rows` are the phone's *preference*, recorded as its grid and applied when
  it starts typing (see the grid-ownership note below); watching alone never
  moves the PTY.
- `{"list": true}` - request the session list.

Later messages:

- Binary `'0' + bytes` - write input to the attached session. The first
  write claims the session and applies the phone's preferred grid.
- Binary `'1' + JSON{"cols","rows"}` - resize the shared PTY.
- Text `{"attach": <leafId>}` - switch sessions.

### Server -> client

- Binary `'0' + bytes` - terminal output. On attach, the recent history
  (up to 256 KiB) is replayed first, then live chunks. Reads are
  non-blocking: the server polls for complete frames on a 10 ms cadence
  while draining output, so a phone that only watches still receives live
  output and is never disconnected for idling. Peers that send no bytes at
  all for 90 s (dead network, crashed client) are dropped.
- Binary `'1' + bytes` - window title (UTF-8). Not implemented yet.
- Text `{"type":"sessions","sessions":[...]}` - each entry carries
  `id` (leaf), `cwd`, `title`, `active`, `live`, `space`.
- Text `{"type":"attached","id":N,"cols":C,"rows":R,"alt":bool}` - attach
  confirmed, carrying the PTY's *current* grid (the owner's, not necessarily
  the phone's preference) and whether the alternate screen is active, so the
  page parses the coming history replay at the right size and buffer mode.
- Text `{"type":"resized","cols":C,"rows":R}` - the shared grid changed (a
  claim or a resize); every viewer re-sizes its parser.
- Text `{"type":"opening","id":N}` - the desktop is spawning this tab; the
  page should re-list shortly (up to 3 retries, then it reports failure).
- Text `{"type":"exit","id":N,"code":C}` - the session exited; the page
  clears its attached state.
- Text `{"type":"error","message":...}` - includes `output too fast,
  resubscribe`, sent when the viewer was evicted for falling behind (the
  page reconnects, and history replay catches it up).

## Sharing the PTY

Desktop and web use the same `Arc<Session>` (`PtyState::web_get`). The
flusher thread in `session.rs`:

1. Sends every chunk to the desktop's Tauri Channel (existing path).
2. Appends it to a rolling history ring (`WEB_HISTORY_CAP` = 256 KiB).
3. Broadcasts it to every attached Web viewer
   (`Session::web_broadcast`, bounded queues so a slow phone never stalls
   the PTY; an evicted viewer is told and reconnects).

Input from either end writes to the same `writer`, so commands typed on the
phone echo on the desktop and vice versa.

One session has one grid, and **whoever is typing owns it** (`SizeOwner`,
`claim`, `request_grid` in the pty module, with a 3 s `OWNER_COOLDOWN`).
Attaching records the phone's preferred grid but watching alone never moves
the PTY; the phone's first keystroke claims the session and applies that grid,
repainting the TUI. The desktop reclaims only on real keystrokes — xterm's
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
`attached` size **before** the history replay so the parser is sized first;
replaying bytes at the wrong width garbles every wrapped line.

The history ring is trimmed by `trim_history`, which drops the requested byte
count and then keeps dropping to the next ESC (falling back to the next
newline). Trimming on a raw byte count alone lands inside a CSI sequence, and a
reconnecting viewer that starts there renders the remainder as literal text —
that is how a phone came to show `48;2;10;10;10m` instead of a conversation.

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
