# Web terminal bridge

The desktop app embeds a small HTTP + WebSocket server that exposes the same
PTY sessions to a phone or another machine over plain HTTP, no Tauri runtime
required on the client. The mobile page is a single-file xterm.js app served
by the same port.

Source of truth: `src-tauri/src/modules/web/mod.rs` (server), `src/web/`
(mobile page), `src/app/hooks/useWebTerminalSync.ts` (desktop tab sync).

## Ports and process

- Dev builds bind `17001`; packaged (release) builds bind `17002`. Selected
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

The page renders every desktop terminal as a **window in one scrollable
grid** — the group (space) name sits in each window's header, so there is no
session switching at all: the list scrolls infinitely, with roughly five
windows per screen. Each live window owns its own WebSocket connection and
xterm.js instance (WebGL renderer); the connection cap therefore allows
several windows per viewer. A window for a tab the desktop hasn't opened yet
shows a "tap to activate" placeholder; tapping warms the tab through the
list connection and the placeholder upgrades to a real terminal when the tab
turns live. Tapping a window makes it the input target (highlighted border);
the toolbar's Ctrl+C / Ctrl+D buttons (binary input frames, since mobile
keyboards have no control keys) act on that window. The phone never resizes
the shared PTY, so the desktop layout is never disturbed.

## Authentication

The web terminal is a remote shell: it must not be wide open.

- Password is a server-side constant, compared as a SHA-1 digest
  (constant-time) in `web/mod.rs`.
- `GET /` without a valid `terax_web` cookie returns a minimal login page.
- The login page POSTs the password to `/auth` (POST only — no credentials in
  URLs); on success the server replies with
  `Set-Cookie: terax_web=<token>; Max-Age=604800` and the browser is
  redirected to `/`.
- `GET /ws` checks the cookie and returns 403 without it.
- Login is rate-limited: 5+ consecutive failures impose a 5 s lockout.
- The password digest and token live only in Rust; the page bundle contains
  neither.

## WebSocket protocol

Endpoint: `/ws`. The server implements a minimal RFC 6455 server (handshake
+ frame codec, no external WS dependency). Server frames are never masked;
client data frames must be masked per spec. Messages are capped at 1 MiB
(frames and reassembled continuations); control frames at 125 bytes.
Concurrent connections are capped at 24 (503 beyond that) — a phone in grid
mode holds one connection per visible window plus one list connection. The
server PINGs every 30 s to keep half-open connections honest.

### Client -> server

First message is a text frame:

- `{"attach": <leafId>}` - attach to a desktop terminal by its leaf id (not
  the pty id; the server resolves the mapping). No resize is sent: the
  desktop owns the canonical PTY size.
- `{"list": true}` - request the session list.

Later messages:

- Binary `'0' + bytes` - write input to the attached session.
- Binary `'1' + JSON{"cols","rows"}` - resize the shared PTY (kept for
  protocol completeness; the current page never sends it).
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
- Text `{"type":"attached","id":N,"cols":C,"rows":R}` - attach confirmed,
  including the PTY's current grid size (desktop-owned) so the page renders
  at the same cols/rows and TUI apps don't wrap wrong.
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
phone echo on the desktop and vice versa. PTY size is **desktop-owned**: the
desktop resizes the shared PTY; the phone never sends a resize frame. The
phone instead renders at the **same grid** as the PTY — `attached` carries
the current `cols`/`rows`, and the session list refreshes them every 5 s —
and scales the font to fit the phone width. TUI apps (opencode, vim, htop)
therefore lay out identically on both ends instead of wrapping at the
wrong column. The trade-off is small text on narrow phones; a 120-column
desktop PTY squeezes into ~40 phone columns at a correspondingly small font
size. Each web connection subscribes with its own
`SyncSender`; disconnect removes exactly that subscription, never the whole
table.

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
  token is a fixed server constant and the password is a hard-coded constant
  (compared via its SHA-1 digest): acceptable for a LAN tool, but anyone with
  the binary can extract the password. The page bundle contains neither.
- Login is POST-only and rate-limited (5 consecutive failures → 5 s lockout).
- The server binds `0.0.0.0`, so anything reachable on the network can see
  the login page. Put the app behind a firewall / VPN for anything beyond a
  trusted LAN.
- WebSocket upgrade is rejected (403) without a valid cookie; the page itself
  only loads after login. Concurrent connections are capped at 8.
