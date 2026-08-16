# Known issues and architectural debt

This guide records known code issues, architectural debt, and risks. It is the
companion to `TERAX.md`: `TERAX.md` describes how the architecture is supposed
to work; this file tracks where reality diverges, what is risky, and what is
safe to ignore.

Severity is **high** (visible bug or security surface), **medium** (latent bug,
wasted work, or gap), **low** (cosmetic, dead code, or naming drift).

Status: **fixed** (resolved), **accepted** (deliberate, tracked), **open**
(still outstanding).

## Web terminal bridge (`src-tauri/src/modules/web/`)

### High

1. ~~**Output drains only when the client sends frames**~~ — **fixed**
   `handle_ws` drains the session's output queue on every 10 ms poll cycle,
   independent of client input, plus a 30 s server PING keeps the connection
   honest. A phone that only watches now receives live output continuously.
   (See #41 for the non-blocking read rework that made polling safe.)
   (`web/mod.rs` handle_ws loop.)
2. ~~**`web_unsubscribe_all` kicks every other viewer of the same session**~~ —
   **fixed**
   `Session::web_subscribe` returns the exact `SyncSender` used by a
   connection; disconnects and session switches remove only that sender via
   `Session::web_unsubscribe`, so other viewers of the same session are never
   affected. (`web/mod.rs` attach/exit paths; `session.rs`.)
3. **Auth is weak for a remote shell on `0.0.0.0`** — partially fixed
   - `POST /auth` instead of GET (no more password in URLs/logs).
   - Login rate limit: 5+ consecutive failures lock out for 5 s.
   - Cookie now has `Max-Age=604800`.
   - The password is compared as a SHA-1 digest (constant-time), not as a
     plaintext constant.
   - Still open: the password itself is a hard-coded constant (extractable via
     `strings`), and `WEB_TOKEN` is a fixed string that never rotates — a
     stolen cookie stays valid for a week. A per-process random token plus
     environment/OS-credential configuration would close this for real.
4. ~~**"opening" flow deadlocks the auto-attach**~~ — **fixed**
   The frontend clears `attachedId`/`lastAttachedId` when it taps a session,
   records a `pendingAttachId` so the auto-attach targets the *tapped* session
   (not the first live one), and retries up to 3 times via
   `scheduleOpeningRetry` before surfacing an error. (`web/main.ts`.)
   The server keeps the old subscription until the new one succeeds.

### Medium

5. ~~**Exit is never sent to the web**~~ — **fixed**
   The waiter now broadcasts `WebMsg::Exited(code)` to every attached viewer
   before reaping the session; `handle_ws` forwards it as
   `{ "type": "exit", "id", "code" }` and unsubscribes that viewer. The page
   clears its attached state and shows a toast. (`session.rs` waiter,
   `web/mod.rs` drain loop, `web/main.ts` exit branch.)
6. ~~**Continuation-frame reassembly has no total-length cap**~~ — **fixed**
   The reassembled message is capped at 1 MiB (`total` tracked across frames),
   and oversized control frames (>125 bytes) are rejected.
7. ~~**No connection limit, no server heartbeat**~~ — **fixed**
   Concurrent WS connections are capped at 8 (`MAX_CONNECTIONS`, atomic
   counter + RAII guard); over-limit upgrades get `503`. The server sends a
   PING every 30 s, and the short read timeout lets the loop detect dead
   peers instead of pinning threads.
8. ~~**`web_leaf_session` can resolve to a stale pty id**~~ — **fixed**
   `web_tabs` now clears any `pty_id` whose session is gone from the map, and
   the cwd-based fallback guess was removed entirely: stale ids no longer
   attach the phone to the wrong shell, and an exited tab correctly falls
   into the "opening" branch only when it is genuinely cold. (`pty/mod.rs`.)

### Low

9. `web_ensure_session`'s fallback session is killed almost immediately by
   `pty_close_all` on frontend boot (`pty/mod.rs:124-157` + `web/main.ts`):
   the "phone always has a terminal" guarantee only exists in the startup
   window. — **accepted**: the fallback session has no leaf id (the phone
   cannot attach to it anyway), and it is re-spawned on the next web connect;
   it exists to keep the page non-empty, not as a real session.
10. ~~**RFC 6455 implementation is lenient**~~ — **fixed**
    Unmasked client data frames are now rejected, as are >125-byte control
    frames. Control frames may still be unmasked (permitted).
11. ~~**Head comment mentions a `viewers` field**~~ — **fixed**
    `web/mod.rs` header now documents `{id,cwd,title,active,live,space}`.

## PTY session (`session.rs` / `mod.rs`)

### Medium

12. ~~**Slow subscribers are dropped silently, forever**~~ — **fixed**
    `web_broadcast` evicts a subscriber whose bounded queue fills, and the
    evicted `handle_ws` sends `{ "type": "error", "message": "output too fast,
    resubscribe" }`; the page reconnects, and the history replay catches the
    viewer up to the current screen. (Related to #1.)
13. ~~**Windows exit race can lose the tail**~~ — **fixed**
    The waiter now polls the reader with a 2 s deadline (up from 50 ms)
    before taking the pending tail, so a slow reader is far less likely to
    race the exit callback. — **accepted residual**: polling is still not a
    true join; under pathological load the tail can still be lost.

### Low

14. `history` is not a true ring buffer: a chunk larger than the 256 KiB cap
    (chunks can reach the 4 MiB `MAX_PENDING`) makes the history exceed its
    nominal cap, and a single huge history frame is unfriendly to phone
    memory. Functionally correct today. — **accepted**.
15. `pty_has_foreground_process` and `pty_has_foreground_job` share the same
    Windows implementation (count all children). "Foreground" is meaningless
    on Windows, so a hidden leaf with any background child is treated as busy
    and keeps its renderer slot parked. A functional gap, not a crash. —
    **open**.
16. Lock order differs between `web_tabs()` (sessions read -> web_tabs lock)
    and `web_leaf_session` (web_tabs lock -> sessions read). Not a deadlock
    today (read locks share), but fragile if any read becomes a write. —
    **open**.
17. `pty_write` and the web input path swallow write errors with `let _ =`: on
    an exited shell, typing on the phone gives no feedback at all. — **open**.
18. `web::start` runs `block_on` on the startup path while spawning the
    fallback session, briefly blocking the main thread on a shell spawn. —
    **open**.

## Line-by-line scan (2026-08-16)

23. ~~**Waiter tail never reached Web viewers**~~ — **fixed**
    The waiter's final pending-tail flush only fed the desktop channel
    (`cb(tail)`), so the last lines before exit were missing on the phone.
    Now the tail is written to the history ring, broadcast to Web
    subscribers, and only then handed to the desktop callback.
24. ~~**`/auth` POST body assumed to arrive in one read**~~ — **fixed**
    The password was parsed from whatever bytes followed the header terminator
    in a single recv; TCP fragmentation could split the body and fail login.
    `Content-Length` is now parsed and the remaining body bytes are read
    explicitly (capped at 256).
25. ~~**Frontend `onerror` could close a fresh connection**~~ — **fixed**
    `ws.onerror` closed the current `ws` without checking `mySeq === wsSeq`, so
    a stale connection's error event could kill the newest connection.
26. ~~**Stale comments**~~ — **fixed**
    `web/mod.rs` header and `web/main.ts` protocol comments still described
    `{attach, cols, rows}` and port 17000; `WEB_TOKEN`'s doc claimed the
    plaintext password is "not recoverable" although the token string embeds
    it. All corrected.
27. `web_broadcast_exit` drains the subscriber table; a viewer whose queue is
    full misses the exit notice and instead sees the "output too fast"
    eviction path. Acceptable (it reconnects and learns the session is gone),
    but the two viewers of the same exit can be told different stories. —
    **accepted**.
28. The `b'1'` resize command remains server-side for protocol completeness
    but contradicts "the desktop owns the PTY size": any client that sends it
    can still disturb the desktop layout. The current page never sends it. —
    **accepted** (documented in `web-terminal-bridge.md`).
29. `web_leaf_session` returns `None` without emitting `terax:web-activate`
    when the leaf's pty_id is stale (session already gone); the page retries
    and the next `web_tabs` call clears the stale id, so it self-heals with
    one extra round trip. — **accepted**.
30. ~~`Err(e) if e == "timed out"` matches the read-timeout by string
    equality~~ — **fixed**: the read-timeout mechanism was removed entirely by
    the non-blocking buffer rework in #41; `read_message` now returns
    `Ok(None)` instead of a string-matched error.

## Window / markdown / terminal scan (2026-08-16)

31. ~~**OSC 52 could write the clipboard from command output**~~ — **fixed**
    The clipboard handler accepted OSC 52 from any output, including a
    running command (SSH, `cat` of an attacker file). It now takes the shared
    `ShellIntegrationState` and refuses while `inCommand`; blocks mode
    mirrors the flag via `applyBlockMode`. (`osc-handlers.ts`, `useTerminalSession.ts`.)
32. ~~**Rendered markdown relative links navigated the app away**~~ — **fixed**
    `MarkdownLink` intercepted external URLs but let relative links
    (`./foo.md`, `#section`) perform a default browser navigation, leaving
    the SPA entirely. It now prevents default for everything, opens external
    schemes in the system browser, and resolves relative links against the
    markdown file's directory via a new `onOpenPath` prop chain
    (`App.tsx` → `WorkspaceSurface` → `MarkdownStack` → `MarkdownPreviewPane`).
33. ~~**Same markdown file could open as two tabs**~~ — **fixed**
    `planMarkdownTabOpen` only deduped against existing `markdown` tabs, so a
    file already open in the raw editor spawned a second rendered tab. It now
    also finds the raw `editor` tab and flips it to rendered (unless it has
    unsaved changes, which stay in the editor).
34. ~~**Settings window tab value unvalidated in the URL**~~ — **fixed**
    `open_settings_window` whitelists the six known settings tabs before
    putting the value in `settings.html?tab=…`; unknown values fall back to
    the plain settings page.
35. `tauri.conf.json` `assetProtocol.scope: ["**"]` allows `asset://localhost`
    to read any file the process can. Verify no code path relies on arbitrary
    asset access; if none, tighten the scope. — **open**.
36. `settings` window: `get_webview_window("settings")` returns a handle even
    after the window was closed; `show()` on a closed native window does not
    recreate it, so opening settings a second time after closing may do
    nothing until the app restarts. Verify and destroy/rebuild on close. —
    **open**.
37. `useWindowTitle` recomputes a fresh string every render (no memoization);
    `setTitle` IPC fires on every App render rather than only when the title
    changes. Harmless but wasteful. — **accepted**.
38. `respawnSession` calls `s.pty?.close()` without awaiting; a slow IPC close
    can let the old pty's `onExit` land after the new session is up. The
    channel handlers are released in `close()`, so the window is small and
    the damage is a spurious "shell exited" notice. — **accepted**.
39. `WindowControls` effect may leak one `onResized` listener if the async
    registration resolves after unmount (no disposed flag). — **accepted**.
40. `MarkdownPreviewPane` reads the file without a size cap (the editor caps
    at 50 MB); a huge markdown file loads fully into the preview DOM. —
    **open**.

## Web reconnect loop (2026-08-16)

41. ~~**Phone page reconnects forever (connect/disconnect loop)**~~ — **fixed**
    Root cause was the 200 ms read timeout on a blocking `read_exact`:
    - `std::io::Read::read_exact` drops the bytes already read when it hits
      WouldBlock mid-frame, so a fragmented frame was permanently lost and
      the parser went out of sync.
    - Worse, `read_message` wrapped the timeout as `"read ws frame head:
      timed out"` while `handle_ws` matched the bare string `"timed out"` —
      the match never fired, so every quiet period (200 ms without client
      input) fell through to `break` and dropped the connection. The phone
      reconnected, idled 200 ms, got dropped again: an infinite loop.
    Fix: the socket is now non-blocking and `WsConn` accumulates all read
    bytes in a buffer that the parser only consumes when a *complete*
    message is available (partial frames are never lost). The loop polls
    every 10 ms, drains session output each pass, and drops a peer only
    after 90 s with zero bytes (PONGs keep it alive). Writes use a
    WouldBlock-tolerant loop so big frames (history replay) still flush.
    (`web/mod.rs` WsConn + handle_ws.)

42. ~~**Phone rendering of TUI apps (opencode) wraps wrong / misplaces fixed
    lines**~~ — **fixed**
    The phone `fit` its xterm to the phone width (~40 cols) while the shared
    PTY lays output out at the desktop grid (120 cols): long lines wrapped at
    the wrong column and alt-screen TUIs drew at misaligned cursor positions.
    The phone now renders at the **PTY's own grid**: `attached` carries the
    PTY `cols`/`rows` (`PtyState::web_session_size`, read from
    `MasterPty::get_size`), the session list refreshes them on a 5 s poll,
    and `fitToPty` scales the font size until `term.cols` matches instead of
    shrinking the grid. `term.rows` is capped at the PTY rows so a short
    phone screen shows the top of the TUI. Trade-off: a 120-col desktop PTY
    renders at a small font on narrow phones. (`web/main.ts`; `web/mod.rs`;
    `pty/mod.rs`.)
    Residual: when the phone screen is *shorter* than the PTY, the bottom of
    the TUI is off-screen (no scrollback in alt-screen). — **accepted**.

## Phone grid UI (2026-08-16)

43. ~~**Group switching UX**~~ — **fixed by redesign**
    The session-list sheet with attach/switch semantics is gone. The page now
    renders every desktop terminal as a window in one scrollable grid: the
    space (group) name is a header inside each window, ~5 windows fit per
    screen, and the list scrolls infinitely. Each live window has its own
    WebSocket + xterm; cold tabs show a tap-to-activate placeholder that
    warms the tab via the list connection. Tapping a window sets it as the
    input target; the toolbar acts on it. (`src/web/main.ts` + `style.css`;
    `web/mod.rs` MAX_CONNECTIONS 8 → 24.)
    Residual: each window's history replay is capped by the server ring
    (256 KiB), so long-running windows show only recent output when the page
    loads. — **accepted**.

## Frontend (`src/web/main.ts`)

### Medium

19. ~~**"opening" retry only re-lists once**~~ — **fixed**
    `scheduleOpeningRetry` retries up to 3 times (1.5 s apart) before showing
    "无法连接该终端"; combined with `pendingAttachId`, the tapped session is
    always the retry target. See #4.

### Low

20. ~~**Resize path uses `ws!.send` without a readyState check**~~ — **fixed
    by design**: the phone no longer sends resize frames at all (local `fit`
    only), so the throwing code path no longer exists.
21. `lastAttachedId`-based reconnect and the single-attach semantics are
    correct today; just note that switching sessions mid-stream is
    last-attach-wins with no queued history between. — **accepted**.

## Dead code and stale exports

| Location | What | Status |
|---|---|---|
| `session.rs` | `Session::web_viewer_count` | removed |
| `session.rs` | `Session::web_unsubscribe` | now used (see #2) |
| `web/mod.rs` | unreachable `OP_CONT` branch in `handle_ws` | removed |
| `lib/platform.ts` | `IS_MAC`, `IS_LINUX` | removed |
| `rendererPool.ts:1043` | a second local `IS_MAC` constant | open |
| `editor/lib/extensions.ts:11` | `readOnlyCompartment` - no references | open |
| `editor/lib/languageResolver.ts:89` | `preloadLanguages()` - no callers | open |
| `source-control/worktreeOps.ts:47` | `gitWorktreePrune()` - no callers | open |
| `src/web/main.tsx` | superseded duplicate of `main.ts` | removed |

`knip` reports these `package.json` deps as unused (frontend): `@fontsource/
jetbrains-mono`, `@radix-ui/react-use-controllable-state`,
`@tauri-apps/plugin-clipboard-manager`, `use-stick-to-bottom`, `zod` (verify
each before removing; some may be used in Rust or in a build step).

## Repository hygiene

- ~~`terax-awei.exe` committed to repo root~~ — removed
- ~~`bash.exe.stackdump` crash dump~~ — removed
- ~~`flake.nix`, `nix/`, Linux/macOS CI jobs~~ — removed; workflows are
  Windows-only now.
- `docs/porting-issues.md` and `docs/移植进度.md` reference deleted code
  (`src/modules/ai/`, `vitest.config.ts`, `rebased/`). They are historical
  migration records; keep them as history or delete them. — **accepted**.

## Documentation drift

- `docs/architecture/pty-shell-integration.md` and
  `docs/architecture/two-process-model.md` carry stale line numbers and a few
  removed command names (`fs_list_files`, `fs_grep`, `fs_glob`; the actual
  commands are `fs_search`, `fs_grep_interactive`). Functions exist; line
  numbers drift. — **open**.
- ~~`docs/architecture/pty-shell-integration.md` calls the ConPTY mutex
  `SPAWN_LOCK`~~ — corrected to `CONPTY_LIFECYCLE_LOCK` (`session.rs:87`).
- ~~`docs/architecture/web-terminal-bridge.md` promises `{type:"exit"}` and a
  binary title frame the server never sends~~ — the server now sends
  `{type:"exit"}` (see #5); the title frame remains unimplemented and the doc
  is being updated.
- `.github/workflows/` is Windows-only after the cut; re-verify before
  touching release tooling.

## See also

- [`TERAX.md`](../TERAX.md) - the architecture source of truth
- [`docs/README.md`](../README.md) - index of contributor guides
- [Web terminal bridge](architecture/web-terminal-bridge.md) - the transport,
  auth, and protocol this file audits
