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
   - The password is compared as a SHA-1 digest, not a plaintext constant; the
     digest and the `WEB_TOKEN` are XOR-obfuscated in source and decoded at
     runtime, so neither appears in `strings` on the binary.
   - Still open: the obfuscation is not encryption (anyone who can run the
     code can recover the values), the password is a hard-coded constant, and
     `WEB_TOKEN` never rotates — a stolen cookie stays valid for a week. A
     per-process random token plus environment/OS-credential configuration
     would close this for real.
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

## Web bridge pass (2026-08-17)

43. The web server now reports health to the desktop: `web::web_status`
    returns `{ running, connections, failed_logins }` from the same atomics
    the accept loop and auth path maintain, and `WebStatusBadge` in the
    status bar renders it (polled every 2 s). The badge also surfaces the
    failed-password counter so a brute-force attempt is visible on the
    desktop, not just throttled server-side. — **accepted**.
44. The bind ports moved from 17001/17002 to `34269` (dev) / `34268`
    (release) and every doc/script reference was updated in the same pass.
    The `RUNNING` flag is set only after a successful bind, so the status
    bar's green dot means the accept loop is actually listening. — **fixed**.
45. The login page title was changed to "请输入密码" (was "Terax Terminal") so
    the phone page reads as a password prompt rather than an app name. —
    **fixed**.
46. The web access password was rotated and its handling hardened. The
    plaintext is stored nowhere: only the SHA-1 digest exists (as `ENCODED`
    bytes in `expected_digest()`), and both the digest and the `WEB_TOKEN`
    cookie value are XOR-obfuscated in source and decoded at runtime via
    `deobfuscate()` (`web/mod.rs`), so neither shows up in `strings` on the
    binary. The debug script takes the password from `TERAX_WEB_PASSWORD`
    (or `argv[3]`) instead of hardcoding it. — **fixed**.
47. ~~**Explorer had a redundant search button**~~ — **fixed**: the search box
    is always visible below the toolbar, so the header's search button was
    removed. In its place a **locate** button (crosshair icon) reveals and
    selects the active file: it expands every ancestor directory from the
    root down to the file's parent, clears the auto-sync guard so the loaded
    row is selected and scrolled into view, and is disabled when no file tab
    is active. (`explorer/FileExplorer.tsx`.)

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

43. ~~**Phone fit mode broke either TUI layout or plain-output wrapping**~~ —
    **fixed**
    Locking the terminal to the PTY grid (needed for TUI cursor
    positioning) clipped long plain-shell lines at the phone width; free
    fitting wrapped them but broke opencode's layout. The page then switched
    fit mode by xterm's active buffer: the **normal buffer** free-fitted
    (long lines wrap), the **alternate buffer** locked cols to the PTY grid.
    That was wrong for the normal buffer too — see #48.
    (`src/web/main.ts`.)
48. ~~**Phone still garbled after the buffer-based fit rework**~~ — **fixed**
    Root cause: the byte stream is laid out against the desktop's grid, and
    free-fitting the normal buffer to the phone width re-wrapped lines that
    the app had already wrapped at the desktop width. `\r` in-place redraws
    (progress bars, spinners, prompts) then returned to the middle of the
    logical line and absolute cursor sequences landed on the wrong cells. Two
    compounding bugs: (1) the server sent the history replay **before** the
    `attached` size, so the phone parsed desktop-grid history bytes at its
    free-fitted width; (2) `fitToPty` set `rows` from the fit value instead
    of the PTY's. Fix: the phone renders at exactly the PTY grid in **both**
    buffers (`applyFitMode` always locks when cols/rows are known), the
    server sends `attached` (with cols/rows) **before** the history replay,
    and `fitToPty` keeps at least the PTY's own rows. Wide grids overflow the
    container horizontally (scroll); tall grids overflow vertically. (`web/
    main.ts`; `web/mod.rs` attach path.)
49. ~~**Explorer locate button ignored git tabs**~~ — **fixed**:
    `explorerActiveFilePath` only resolved `editor`/`markdown` tabs, so files
    opened from the git change panel (git-diff / git-commit-file tabs) never
    highlighted or revealed in the tree. It now resolves those kinds the same
    way the status bar does (join `repoRoot` + repo-relative path), and
    `explorerOpenFilePaths` includes them so the tree marks them open.
    (`app/App.tsx`.)
50. ~~**Git change panel: discard targeted the active repo**~~ — **fixed**:
    `confirmPendingDiscard` ran `git restore`/`git clean` against
    `repo.repoRoot` (the active repo) even when the file belonged to a
    different repo in multi-repo workspaces — the pathspec did not match and
    the discard silently did nothing. `pendingDiscard` now carries the file's
    own `repoRoot` and `runMutation` receives it as `targetRepoRoot`.
    (`source-control/useSourceControlPanel.ts`.)
51. ~~**Git tabs invisible in the "窗口" (open files) panel**~~ — **fixed**:
    `OpenFilesPanel` filtered `ownerTabId === currentOwnerTabId`, and git
    tabs (diff / history / commit file) carry no owner, so they vanished as
    soon as a terminal was active. Git tabs now always show (repo-level, not
    command-line-scoped); `git-history` / `git-commit-file` were added to the
    filter and got icons. (`sidebar/OpenFilesPanel.tsx`.)
52. ~~**Commit / Commit&Push button lagged before showing busy**~~ — **fixed**:
    `setLocalActionBusy` ran *after* the async pre-commit checks, so the
    button stayed idle for the check round-trip (slow with hooks installed).
    The busy state now goes up on the very click; it is released if the
    targets are empty or pre-commit warnings pause the flow.
    (`source-control/useSourceControlPanel.ts` runCommit.)

## Phone grid UI (2026-08-16)

43. ~~**Window-switcher sheet: groups required nested switching**~~ — **fixed**
    The switcher sheet is now one flat, scrollable list (~5 entries tall,
    no scroll limit): each group (space) label renders as an inline header
    row with its terminals directly underneath — no nested level to switch
    through. Tapping an entry attaches to that terminal as before.
    (`src/web/main.ts` + `style.css`.)

## Mobile conversation rewrite (2026-08-18)

The phone page stopped being a terminal. Background and design:
[Mobile conversation view](architecture/mobile-conversation-view.md).

44. ~~**Phone rendered the desktop grid, so text was unreadable**~~ — **fixed**
    Measured at 192×28 PTY / 335×590 viewport: the grid was scaled 0.238 to
    fit, giving a **3.3 px** font and leaving **74 %** of the screen blank.
    Scaling to fit, panning, and re-wrapping are mutually exclusive in a
    terminal view; the page now renders no grid at all. (`src/web/`.)
45. ~~**`inAltScreen` was a dead variable**~~ — **fixed by removal**
    `applyFitMode()` never branched on it, so the documented "normal output
    wraps to phone width, TUI locks to PTY grid" behaviour was never
    implemented. Both the variable and the two contradicting comment blocks
    are gone with the rewrite.
46. ~~**`applyGridScale` counted padding as usable space**~~ — **fixed by
    removal**: it read `termWrap.clientWidth`, which includes the wrapper's
    12 px padding, so the scaled grid still overflowed slightly.
47. ~~**`scrollCursorIntoView` was dead code**~~ — **fixed by removal**: the
    element was always scaled to fit, so `scrollWidth <= clientWidth` held
    and the function early-returned every time.
48. ~~**Alt-screen scroll detection never fired**~~ — **fixed**
    `translateToString(true)` leaves trailing whitespace on cells carrying
    attributes, and a TUI pads to full width with styled blanks, so the same
    row compared unequal between frames. Measured 158 frames / 0 scrolls;
    history was being silently lost. Rows are now right-trimmed at capture.
    `conv.stats` exists to catch a recurrence. (`conversation.ts` flushAlt.)
49. ~~**Footer stripping swallowed the whole screen**~~ — **fixed**
    `dropFooter` used `raw !== text` to mean "this row had frame characters",
    but `stripChrome` also trims indentation, so every indented row counted as
    furniture and `toBlocks` returned zero blocks. Now judged on frame-character
    share, a leading rule, or key hints.
50. ~~**Splash detection flapped**~~ — **fixed**: `isBanner` used a
    drawing-to-text ratio, which crosses its threshold as soon as one long
    divider rule is drawn, so the same screen appeared and disappeared. Now
    keyed on absolute text volume (< 120 letters).
51. ~~**Single-character messages were dropped**~~ — **fixed**: the `pending`
    filter carried a `length >= 2` guard, so `1` / `2` / `3` — the exact test
    case — never rendered. Short sends now require an exact match instead.
52. ~~**History ring trimmed mid-escape-sequence**~~ — **fixed**
    `history.drain(..cut)` cut on a raw byte count, so a reconnecting phone
    replayed from inside a CSI sequence and rendered the remainder as text
    (`48;2;10;10;10m`). `trim_history` now resyncs to the next ESC, falling
    back to the next newline. (`session.rs`.)
53. ~~**Backlog was applied in one write**~~ — **fixed**: every frame a
    full-screen program had ever painted was applied to the buffer in sequence
    and only the last was read, collapsing the conversation into the current
    screen. `writeBacklog` feeds 2 KiB slices with a read between each.
54. ~~**Rendering stalled in a background tab**~~ — **fixed**:
    `requestAnimationFrame` never fires while `document.hidden`, which is the
    normal state on a phone whose screen has locked. Falls back to a timer.
55. **Backlog restored on attach is not split into bubbles** — the page has no
    record of what was sent before it connected, so `markEchoes` has nothing to
    match and the replay arrives as one output block. — **accepted**.
56. **Bubble classification is heuristic** — how a program repaints is not
    something it declares. An unrecognised status widget becomes a small stray
    bubble; an unusual repaint pattern loses history rather than corrupting it.
    `WIDGET` and `detectProgram` in `conversation.ts` are the only
    tool-specific knowledge, deliberately kept to one place. — **accepted**.
57. **Claude Code `1`/`2`/`3` exchange not verified end to end** — startup
    detection and screen parsing were confirmed; the full exchange was not.
    Backlog reconstruction was verified for a shell session only. — **partly
    fixed**: the alternate-screen part is now verified and fixed. Replaying a
    real 81 KiB OpenCode backlog through `Conversation` showed `detectScroll`
    never fired (38 frames, 0 scrolls) because `BACKLOG_SLICE` = 2048 bytes was
    ~15 full lines of a 138-column grid: consecutive reads shared no content,
    so a session that scrolled lost its whole history on attach. The slice is
    now about two grid rows (`max(64, min(2048, cols * 2))`); the same replay
    detects 27/28 scrolls and reconstructs the transcript, and a synthetic
    alt-screen session that scrolls 120 lines recovers it all. A second bug
    surfaced in the same replay: `CHROME_LEAD` treated any line opening with a
    single frame marker (`┃`, `▣`) as a rule, so the footer walk ate every
    opencode user message rendered under its gutter. Rules are now runs of
    frame characters, and the input box (a bare path) and status readouts
    (already `WIDGET` lines) are explicit furniture. — **resolved** (2026-08-19):
    the full `1`/`2`/`3` exchange was exercised against real opencode and
    Claude Code sessions driven through the phone bridge (see
    `docs/architecture/mobile-conversation-view.md` § Test tooling). Claude's
    trust dialog (`❯ 1. Yes, I trust this folder / 2. No, exit`), permission
    approval by number, continuous multi-turn conversation, tool calls, the
    exit / session-save prompt, and long backlogs all parse correctly. Three
    more bugs surfaced and were fixed along the way:
    - `sameMessage` matched a short send (`claude`) as a substring anywhere, so
      Claude's own chrome ("Run claude doctor", the cwd path
      `…\opencode\claude-fresh`, the `Opus 5 claude-fresh` model line) became
      fake user bubbles. Matching is now length-tiered (≥10 chars loose, 4–9
      must be essentially the row, shorter exact).
    - `detectProgram` matched `/opencode/i` anywhere, so a session whose cwd
      path contained `opencode` was mislabelled `OpenCode` even while Claude
      Code ran. OpenCode now requires a bare word (logo / save screen / footer)
      and Claude Code is matched first (`claude code`, `welcome back`,
      `Opus <n>`); Claude's `Opus <n> …` model line joined `WIDGET`.
    - `isBanner` suppressed any sparse screen as a splash, including opencode's
      exit / session-save prompt drawn under the same ASCII banner ("Session
      项目介绍 / Continue opencode -s …"), so the reader could not see the
      choice. Suppression now applies only to the program's first frame.
    Also verified: the alt-screen exit fold no longer raw-appends the final
    screen (it goes through the same parse, stripping furniture and marking
    echoes). A real Claude Code permission dialog was then captured end to end
    (running Claude with a workspace `defaultMode: "default"` settings file
    makes it ask): the `1. Yes / 2. Yes, and don't ask again / 3. No` menu
    renders as visible blocks and `1` approves.
  - **Claude's status / agent-mode UI leaked into the conversation, and the
    agent tab was not its own thing** — fixed (2026-08-19): the footer was
    split by "does this line look like furniture", which broke on Claude's
    subagent tab (`  ◯ Explore Search repo for README content  0s` — a chrome
    glyph plus text reads as content), leaking the whole status area into the
    output. The footer is now split by **position**: anchored on the last
    status rule in the bottom `FOOTER_WINDOW` rows (a higher rule is a dialog
    border or divider, not a status rule), and the footer's bottom row is
    extracted by position as `Conversation.agents` — Claude Code's running
    subagent strip — rendered as an independent chip strip above the composer
    (`#agents`, `style.css` `.agent-chip`). No agent name or task text is ever
    matched, so a renamed agent keeps working. The `Auto-update failed`
    npm-prefix warning is now a `WIDGET` and is dropped. The status label also
    drops model/usage readouts and any fragment longer than a status piece (a
    long run is a sentence leaked from a scrambled mid-repaint frame).
    Verified on real captures: during the run, `agents = ["Explore 查找 README
    相关内容 …"]` and `status = "manual mode on · 3 agents · main"`; on the
    real page the `#agents` chip appears while the subagent runs.

## Frontend (`src/web/main.ts`)

### Medium

19. ~~**"opening" retry only re-lists once**~~ — **fixed**
    `scheduleOpeningRetry` retries up to 3 times (1.5 s apart) before showing
    "无法连接该终端"; combined with `pendingAttachId`, the tapped session is
    always the retry target. See #4.

### Low

20. ~~**Resize path uses `ws!.send` without a readyState check**~~ — **fixed
    by design**: the phone no longer sends resize frames at all — since the
    conversation rewrite it renders no grid, so it has no width to impose.
21. `lastAttachedId`-based reconnect and the single-attach semantics are
    correct today; just note that switching sessions mid-stream is
    last-attach-wins with no queued history between. — **accepted**.

## 移动端桥接加固（2026-08-19）

本日围绕「手机正常运行 opencode / claude」做了一轮完整适配：修复质量门槛、
hot-deploy 稳定性、grid 所有权、解析器、agent 模式抽取，并建立了一套可
复用的捕获/回放/端到端测试工具链。详见
[mobile-conversation-view.md](architecture/mobile-conversation-view.md)。

### 质量门槛
- 修复 11 个 clippy 错误：`git/operations.rs` 与 `git/commands.rs` 的
  `too_many_arguments`（按仓库惯例加 `#[allow]`）、六处 `.as_ref()`、
  `manual_flatten`、`needless_borrows_for_generic_args`；
  `proc/job.rs` 的 duplicated attribute。`cargo clippy --locked -D warnings`
  全绿。
- `biome.json`：`a11y/noAutofocus` 预存错误按仓库惯例降为 warn。

### Hot-deploy 稳定性（热部署.ps1）
- 新脚本启动前**等 terax-prod.exe 解锁**（`FileShare.Delete` 探测，最多 10 s）
  并**等开发端口真正释放**（轮询，最多 10 s）——否则孤儿实例锁住 exe，
  cargo 覆盖失败（`拒绝访问 (os error 5)`）会连带把整个 `tauri dev` 和
  vite 一起带走。
- 顺带清掉了占用 34269 的孤儿旧二进制实例。

### Grid 所有权（手机端）
- `main.ts` 对齐服务端协议：`attached` 用服务端报告的**真实网格**解析，
  `resized` 只跟随不抢回，删除 `sendResize`；attach 的 cols/rows 只是偏好，
  首个按键才 claim。
- **修复 grid 乒乓**：xterm 的协议应答（OSC 4 调色板应答、`ESC[I/O` 焦点
  报告）走 `pty_write` 时被当作"桌面打字"把会话抢回桌面网格。新增
  `looks_like_protocol_response`：应答照常送达 PTY，但不再 claim。实测整场
  opencode 会话零回抢、网格稳定。

### 解析器（conversation.ts）
- **alt 退出折叠**：退出时最后一屏改为走与其它帧相同的解析（剥家具、标记
  回显），不再原样追加——之前输入框、状态行、回显会变成匿名 AI 输出。
- **`isBanner` 仅限首帧**：opencode 退出/保存提示（"Session 项目介绍 /
  Continue opencode -s …"）不再被当成启动页吞掉。
- **`sameMessage` 分层匹配**：≥10 字宽松、4–9 字必须基本等于整行、更短精确
  ——修掉发的 `claude` 把 Claude 自己的 UI（"Run claude doctor"、cwd 路径
  `…\opencode\claude-fresh`、`Opus 5 claude-fresh`）误标为用户消息的问题。
- **`detectProgram` 边界匹配 + Claude 优先**：cwd 路径含 `opencode` 不再把
  Claude Code 误判为 OpenCode。
- **WIDGET 扩充**：`Opus <n> …` 模型行、`Auto-update failed`（npm-prefix
  警告，用户要求屏蔽）——不再出现在气泡里。
- **位置法 footer + agent 抽取（按用户要求"按位置不按文字"）**：
  - footer 以底部规则线为锚（`FOOTER_WINDOW = 12` 行内最靠下的一条规则；
    更高的是对话框边框/正文分隔线）。之前按"像不像家具"自底向上走，会被
    Claude 的子代理标签（`◯ Explore Search repo …`）卡住，把整块状态区漏进
    正文。
  - footer **最底行按位置抽成 `Conversation.agents`**——Claude Code 运行中
    的子代理标签条，独立渲染成输入框上方的 chip 条（`#agents` +
    `.agent-chip`，带脉冲圆点），不进气泡、不做状态文本。不匹配任何 agent
    名字/任务文字，改名也不会失效。唯一例外是输入框（裸路径或按键提示）。
  - status 加长度护栏：状态片段很短，从过渡帧混进来的长句被丢弃。

### 测试工具链（scripts/）
- `web-capture.mjs`：驱动手机桥接 WebSocket 录制真实会话（含 cold-leaf 的
  opening 重试）；`web-replay.mjs`：把捕获按页面同款逻辑回放进
  `Conversation`（`--trace` 看逐帧 live blocks，`--screen-at` dump 原始屏）。
- `web-synthetic-test.mjs`：合成屏幕回归（1/2/3 菜单、权限框、启动页、退出
  提示、agent 位置抽取、输入框排除）——14 项全过。
- `e2e-phone.mjs`：Playwright 真实页面（cookie 免密码）——登录/列表
  （`data-leaf`）/attach/发送/气泡。

### 验证结果（真实 opencode / claude 会话）
- opencode：连续多轮对话、工具调用、退出保存提示全部正确。
- claude：启动识别、信任对话框（`❯ 1. Yes… / 2. No, exit`）、**真实 Bash
  权限对话框**（工作区 `defaultMode: "default"` 触发，`1. Yes / 2. … / 3. No`
  菜单在手机上正确渲染且 `1` 生效）、**子代理运行时 agent chip 独立显示**
  （`Explore 查找 README 相关内容 0s`）、连续对话。
- 桌面与手机同屏共用同一会话（桌面打字 + 手机旁观）保持自洽。

### 文档同步
- `TERAX.md`：grid 所有权描述更新（单会话单网格、谁打字谁拥有、协议应答
  不 claim、`resized` 广播）。
- `web-terminal-bridge.md`：`attach` 带偏好网格、`attached` 带真实网格+alt、
  `resized` 消息。
- `mobile-conversation-view.md`：位置法 footer/agent、echo 分层匹配、程序
  识别、isBanner 首帧、权限对话框、测试工具链、Verified/Not 更新。

## Phone seeded from the desktop's buffer (2026-08-19)

**The phone opened on records the desktop no longer had, then lost them
again** - fixed. The initial content came from a 256 KiB rolling byte ring kept
per session in `session.rs`, which is a second store of the output and drifted
from the terminal by construction:

- it outlived a `clear` on the desktop (the parser's `turns` are not cleared by
  a clear in the stream), so content the desktop had dropped came back;
- it was bounded in **bytes** where a terminal is bounded in **lines**, so an
  idle shell's ring spanned days of history the desktop had long scrolled past;
- replaying it meant ~1000 sliced writes with a render between each, so the old
  records visibly piled up on screen, and then `MAX_LINES` (4000) trimmed them
  off the front again as the replay continued. Hence "everything appears, then
  disappears".

The ring is gone. On attach the server subscribes the viewer, asks the window
for that leaf's terminal buffer (`terax:web-snapshot` ->
`snapshotLeaf` -> `web_snapshot_reply`), and sends it as one seed frame. A live
leaf is serialized through `SerializeAddon`, a parked one answers from its
stored snapshot plus `DormantRing.peek`. `attached` gained `seed`, and the page
no longer forces a buffer mode when a seed is coming - the serialized form
re-enters the alternate screen itself. `writeSeed` splits at that `?1049h` so
the scrollback is read out as history before the TUI screen takes over.

Accepted: the few milliseconds between subscribing and serializing can appear
in both the seed and the live queue, so a busy session may show a small
duplicate at the join. The alternative was making the window count bytes.

**The phone imposed its own 120x40 grid** - fixed. `FIXED_GRID` was sent as an
attach preference and applied on the phone's first keystroke, which resized the
shared PTY and reflowed the desktop's screen under a program laid out for it.
The phone renders no grid, so it has no size to want: it now attaches without
cols/rows and never claims the size. The PTY stays at the desktop's.

**The screen was flattened into bubbles** - fixed. `setLive` now takes it apart
into body, working state (`thinking`), mode (`mode`), choices (`choices`) and
the agent strip, each rendered in its own place. See
[Mobile conversation view](architecture/mobile-conversation-view.md) § Four
things, not one stream. Two things surfaced building it:

- the working line is drawn right above the input box and can land on the
  footer's **bottom** row, which is the agent tab strip slot - a program that
  was merely thinking got reported as running a subagent. It is split out
  first, from either half of the screen.
- a first cut of the menu split reset its run on any non-matching row, so a key
  hint drawn under the options (`(up/down to navigate, enter to select)`)
  discarded the whole menu. It now scans upward from the input box, and guards
  against prose numbered lists with two rules: a menu marks its current row
  (`❯`/`>`), and its keys increase.

`scripts/web-synthetic-test.mjs` covers all of it (36 assertions), including a
prose list that must stay prose, a prose list sitting above a real menu, and
two seed shapes (a quiet shell, and scrollback plus a running program).

Two more bugs surfaced driving the real bridge with `scripts/e2e-phone.mjs`
against a live instance:

- **A parked pane seeded as empty.** `serializeLeaf` only matched a slot by
  `currentLeafId`, but parking a pane leaves its content in that slot under
  `retainedLeafId` *and* clears the session's stored snapshot (binding writes
  the stored copy back into the slot and drops it). So a hidden tab had its
  buffer in the one place the lookup did not check. It now matches a retained
  slot too, and `snapshotLeaf` chains slot -> stored snapshot -> dormant ring
  rather than stopping at the first hit.
- **A quiet command line rendered as a blank page.** `flushNormal` stops above
  the cursor row on purpose (it may be a half-written prompt), and a shell
  sitting at its prompt is nothing but that row. Correct for live output,
  wrong for a seed: at seed time the row is exactly what the desktop shows.
  `writeSeed` now emits it once and moves the read cursor past it, so the live
  stream does not repeat it.

Verified live: seeding a parked leaf and the active leaf both return the
desktop's real buffer; the phone typing no longer moves the PTY grid (a session
stayed at the desktop's 138x44 where it used to be forced to 120x40); the full
`e2e-phone.mjs` round trip (attach, seed rendered, send, echo) passes.

Not verified: a real `claude` / `opencode` session end to end through the phone
since the rework - the alt-screen seed, working state, mode and menu are
covered by synthetic screens only.

## Agent conversation read from the agent, not the screen (2026-08-19)

The phone reconstructed an agent conversation by parsing the TUI's screen.
Driving a real opencode session through the bridge showed what that costs: it
draws a **right-hand panel** (session name, token count, cost, LSP state, cwd,
branch) on the same rows as the conversation, so read as text it interleaved -
`1% used` glued to the front of a sentence, a bare cwd path as its own bubble,
a timestamp landing inside the echo of what was typed. A geometric side-column
cut fixed that particular screen, but the class of bug does not end: a spinner
is a sentence unless recognised as a spinner, the mode moves with the status
bar's layout, and reasoning is indistinguishable from an answer.

Both tools already write the conversation down. It is now read from there
(`src-tauri/src/modules/transcript/`): Claude Code from its per-session JSONL,
opencode from its SQLite database (read-only; its TUI opens no port and
`opencode export` costs a process per read, so there was no other live source).
`rusqlite` (bundled) was added for that and nothing else. Both are normalised
into one shape and pushed as a `transcript` WebSocket message; the page renders
it as the conversation and stops reading the screen for anything but the menu
the program is waiting on, which no transcript records because it is live UI
state.

Verified end to end against real sessions driven through the phone page:
opencode reports `mode=build`, `model=deepseek-v4-flash`, the user's message,
the reply, and the reasoning behind it; Claude Code reports `mode=auto` and its
turns. In both, the live screen blocks render empty - the screen is no longer
being read as conversation.

Gating, so an idle session stays free: an agent must actually be running
(`Session::web_agent`, fed by the existing OSC detection - a directory that ran
one yesterday must not show that conversation over today's prompt), a
filesystem mark must have moved, and the revision must have changed.

### The permission dialog, driven for real

Exercised against a live Claude Code session with a workspace
`permissions.defaultMode: "default"`, which makes it ask before writing. One
bug fell out immediately, and it is the same shape as everything else the
screen parse got wrong:

**A pending dialog vanished into the status bar.** Claude draws the diff it is
asking about between two dashed rules (`╌╌╌`), and `splitFooter` anchors on the
last rule in the bottom of the screen. It picked the lower diff rule, so the
question and all three options counted as footer and `choices` came back empty
while the agent sat blocked. The menu scan no longer depends on the footer
split at all: `findChoices` runs over the whole screen first, and the footer is
then only allowed to start BELOW the menu it found. That is the right order
anyway - the menu is the one thing on screen the transcript cannot know, so it
must not be the thing that breaks when the rest of the parse does.

**The dialog dragged the whole screen in with it.** Under a transcript the
screen is not rendered, except while a menu is pending. Rendering all of
`liveBlocks` then put Claude's welcome banner above the question. The dialog's
own context is now bounded (`promptBlocks`: the rows between the menu and 12
above it), so what shows is the question, the file, and the diff - approving
"create hello.txt" without seeing what goes in it is a guess, not a decision.

Verified live, twice: three buttons with the right keys and labels (including
the long "Yes, and switch to accept edits…"), option 1 marked selected, the
question and diff beside them, and tapping the button actually answered Claude
- `hello.txt` and `world.txt` were created on disk with the right contents.
Covered by a synthetic screen built from the captured dialog, so the
diff-rule trap cannot come back.

Also fixed while testing: the transcript's cwd was captured at attach and never
re-read, so a shell that cd'd afterwards kept showing the previous directory's
conversation. It is looked up per poll now.

## Packaged build spawned a Store alias as the shell (2026-08-19)

**Every terminal in the packaged build opened and then accepted no input.**
The dev build was fine, which is the whole clue.

`which_in_path` accepted any PATH hit that satisfied `is_file()`. A Microsoft
Store **app execution alias** satisfies it: it is a zero-length reparse point
that Explorer resolves on your behalf. ConPTY spawns through `CreateProcessW`,
which does not resolve it, so the child came up broken - a terminal that opens
and takes nothing.

Why only the packaged build: the alias lives in
`%LOCALAPPDATA%\\Microsoft\\WindowsApps`, and in the PATH a process
inherits from Explorer that directory sits **ahead** of
`C:\\Program Files\\PowerShell\\7`. Launched from a dev shell the order is the
other way round, so `cargo run` never reached the alias. Measured on the
affected machine:

```
C:\WINDOWS\System32\WindowsPowerShell\v1.0\          (no pwsh.exe here)
C:\Users\<user>\AppData\Local\Microsoft\WindowsApps  <- 0 bytes, was winning
C:\Program Files\PowerShell\7\                        <- 301368 bytes, the real one
```

Not caused by any recent change: the Store PowerShell 7.6.5 was installed two
days earlier, and that is when the alias appeared on PATH.

Fixed with `is_real_executable`: a PATH hit counts only when it is a file of
non-zero length. Length is the honest test - a real executable is never zero
bytes, and it covers any alias rather than just the ones in that one folder.
Applied to the PATH search, to a user-configured shell override, and to the
shell picker, so none of the three can hand back something that opens a dead
terminal. Verified in the actual packaged binary: it now spawns
`C:\Program Files\PowerShell\7\pwsh.exe`.

**A second, separate cause on the same machine**, worth knowing because it
looks identical from the outside. `pwsh.exe` was flagged
`~ RUNASADMIN` under `HKCU\Software\Microsoft\Windows NT\CurrentVersion\AppCompatFlags\Layers`
("always run as administrator" in the file's properties). A non-elevated
process spawning it gets `CreateProcessW ... (os error 740)`,
ERROR_ELEVATION_REQUIRED, and the pane fails to open at all. Before the alias
fix this was hidden: the resolver picked the zero-byte alias instead, which
"spawned" and then sat dead, so the elevation problem never surfaced.

Terax does not fall back to another shell when a spawn fails - a shell that is
present but unspawnable ends the attempt. Deliberate for now: on this machine
the owner runs Terax elevated, which is what they want anyway (the alternative
is silently dropping to `cmd.exe` and wondering why the prompt looks wrong).
Worth revisiting if it turns up on a machine where elevation is not an option.

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
- `热部署.ps1` launches `pnpm tauri dev` as a background process (hidden
  window, logs to `dev.log`, PID in `.terax-dev.pid`, gitignored), so the
  script returns immediately. Re-running it kills the recorded process tree
  first (taskkill /T), `-Stop` only stops. The exe-path and port-based
  cleanup stays as a fallback for orphaned instances. — **fixed**.
- `热部署.ps1` could still fail to rebuild: an orphaned dev instance
  (`src-tauri/target/debug/terax-prod.exe`) whose exe-path kill missed it kept
  the binary locked, and `cargo run` died with `failed to remove ... 拒绝访问
  (os error 5)`, taking the whole `tauri dev` (and vite) down. The restart now
  waits for the debug exe to be unlocked (`FileShare.Delete` probe, up to 10 s)
  and for the dev ports to actually free up (poll, up to 10 s) before launching,
  so a stale holder cannot break the next build. — **fixed** (2026-08-19).
- Grid ping-pong: the phone's first keystroke claims the session and resizes
  the PTY to its grid; ~5 s later the desktop always wrote the terminal's
  palette (an OSC 4 answer to the TUI's palette query, plus `ESC[I` focus
  reports, forwarded by xterm's `onData`), and every such write went through
  `pty_write`, which claimed the session back at the desktop grid — so a
  watched session flip-flopped between the two sizes after every claim.
  `pty_write` now skips the claim for xterm's protocol answers
  (`looks_like_protocol_response`: focus reports and OSC replies), which still
  reach the PTY but no longer move the grid. — **fixed** (2026-08-19).

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
