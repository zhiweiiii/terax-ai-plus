# TERAX.md

Terax loads `TERAX.md` from the workspace root as agent memory (similar to AGENTS.md / CLAUDE.md). This file is also the project's living architecture doc - read it before making changes.

## Project

**Terax**: lightweight terminal-first development workspace. Tauri 2 + Rust (`portable-pty`) backend, React 19 + TypeScript + xterm.js (WebGL) client. A native PTY terminal with code editor, file explorer, source control with a git graph, web preview, and an embedded web terminal bridge that shares the same PTY sessions with a phone browser.

- Bundle id: `app.crynta.terax`
- Package manager: **pnpm**
- Platforms: **Windows only** (macOS / Linux support was removed)
- Main binary: `terax-prod` (dev and release share the name; the hot-deploy and packaging scripts reference it)
- Frontend checks: `pnpm lint`, `pnpm check-types`
- Rust checks: `cd src-tauri && cargo clippy --all-targets --locked -- -D warnings` (tests were removed)

## Quality bar

Production-grade or it does not ship. Every change is judged against all of these, not just "it works":

- **Correctness**: edge cases, failure modes, concurrent access. No "works for now".
- **Performance**: ultra-lightweight is the product. ~7-8 MB bundle, high-performance terminal. For every change ask: how much RAM it costs, whether it adds IPC round-trips or redundant requests, whether it triggers extra re-renders or wasted work, whether it pulls a heavy dependency. Unused features consume zero resources.
- **Security**: no critical security holes. Validate at every boundary (IPC, fs, network, the web terminal surface). The web terminal bridge is a remote shell: password-gated and never wide open.
- **UI/UX**: polished, professional, premium. Every state and detail considered.
- **Architecture**: new or changed logic lives in pure, dependency-light functions (functional core); tauri commands and React components stay thin (imperative shell).

Verify before claiming done:

- Frontend: `pnpm lint`, `pnpm check-types`
- Rust: `cd src-tauri && cargo clippy --all-targets --locked -- -D warnings`

## Conventions

- **Comments**: default to none, the code should explain itself. If genuinely needed, 1-2 lines on *why*, never *what*. No AI-generic filler.
- **No em-dash** anywhere: code, comments, commits, docs.
- **No emojis** anywhere.
- **Imports**: always `@/...` on the frontend, never relative across modules.
- **pnpm only**, never npm/npx/yarn.

## Architecture

### Two-process model

**Rust (`src-tauri/`)** owns all OS access. The webview never touches the FS, processes, or shells directly - everything goes through `invoke()` calls to commands registered in `src-tauri/src/lib.rs`:

- `pty::pty_*` - long-lived interactive PTY sessions (xterm + portable-pty), managed by `PtyState` (`RwLock<HashMap<id, Session>>`). Output streams via callbacks wired to a Tauri `Channel` by the frontend; the web terminal bridge subscribes to the same sessions.
- `fs::tree::*` (`fs_read_dir`, `list_subdirs`), `fs::file::*` (`fs_read_file`, `fs_write_file`, `fs_stat`, `fs_canonicalize`), `fs::mutate::*` (`fs_create_file`, `fs_create_dir`, `fs_rename`, `fs_delete`): file explorer + editor IO.
- `fs::search::*` (`fs_search`), `fs::grep::*` (`fs_grep_interactive`): fuzzy file finder + content search (powered by `ignore` + `grep-*` crates).
- `git::commands::*`: full source-control surface (`git_status`, `git_diff`, `git_diff_content`, `git_stage`, `git_unstage`, `git_discard`, `git_commit`, `git_fetch`, `git_pull_ff_only`, `git_push`, `git_log`, `git_show_commit`, `git_commit_files`, `git_commit_file_diff`, `git_panel_snapshot`, `git_resolve_repo`, `git_remote_url`). All gated through the workspace authorization registry.
- `shell::shell_run_command`: one-shot subshell exec (used by the VCS worktree feature). Distinct from PTY sessions; not the user's interactive terminal. On Windows via PowerShell (`-NoProfile -Command`).
- `workspace::*`: `workspace_authorize` / `workspace_current_dir` (the spawn/git cwd authorization registry) plus the WSL bridge (`wsl_list_distros`, `wsl_default_distro`, `wsl_home`).
- `lsp::*` (`lsp_detect`, `lsp_host_pid`, `lsp_resolve_root`, `lsp_spawn`, `lsp_send`, `lsp_kill`): language server process host. Dumb JSON-RPC pipe: Content-Length framing + process lifecycle in Rust (`lsp/framing.rs`), protocol intelligence on the frontend. Spawn cwd gated through the workspace registry. Servers run in their own process group and are group-killed; Windows children get a `proc::job::ProcessJob` (kill-on-close, shared with pty). All sessions killed on `RunEvent::Exit`.
- `open_settings_window`: separate webview window for Settings (optional `tab` arg deep-links a section).
- `web::*` (`web::start`): embedded HTTP + WebSocket server (see "Web terminal bridge" below). Serves the mobile terminal page, accepts WebSocket sessions, and syncs desktop terminal tabs to the phone.

### Web terminal bridge (`src-tauri/src/modules/web/`)

A self-contained HTTP + WebSocket server embedded in the desktop app exposes the same PTY sessions to a phone / another machine. It is a plain-browser experience, not a Tauri webview.

- **Ports**: dev builds listen on `17001`, packaged (release) builds on `17002` (`cfg!(debug_assertions)`).
- **Page**: `GET /` serves a single-file mobile page (xterm.js + WebGL renderer) embedded at build time. `scripts/build-web.mjs` runs a dedicated vite build (`vite.web.config.ts`) and inlines the result into `src-tauri/web.html`, which is `include_str!`'d by the Rust server. The desktop build (hot-deploy and packaging scripts) runs it automatically before compiling.
- **Auth**: `GET /` returns a password login page when the visitor has no `terax_web` cookie; `POST /auth` (password in the body, never a query string) validates against a server-side SHA-1 digest with constant-time compare, is rate-limited (5 consecutive failures → 5 s lockout), and sets the cookie with `Max-Age=604800`. The WebSocket upgrade rejects unauthenticated clients with 403. The password digest lives only in Rust, never in the page bundle.
- **WebSocket protocol** (`/ws`): client sends `{"attach":<leafId>}` (no resize — the desktop owns the PTY size) or `{"list":true}` as the first text frame; input is binary `'0'+bytes`, resize is binary `'1'+JSON{cols,rows}` (kept for protocol completeness, the current page never sends it). Server pushes binary `'0'+bytes` (terminal output, history replay first; non-blocking reads poll for complete frames on a 10 ms cadence so watch-only phones keep receiving and are never dropped for idling), `'1'+bytes` (title), and text `{type:"sessions"|"attached"|"exit"|"error"|"opening"}`. Framing is a minimal RFC 6455 implementation (handshake + frame codec) because the crate has no HTTP/WS framework; messages are capped at 1 MiB, concurrent connections at 8, the server PINGs every 30 s, and a peer silent for 90 s is dropped.
- **Shared PTY**: Web viewers subscribe to the same `Arc<Session>` as the desktop (`Session::web_subscribe`), so input and output are identical on both ends. The flusher thread keeps a rolling output history (`WEB_HISTORY_CAP` = 256 KiB) for late viewers and broadcasts every chunk to attached Web clients. **The desktop owns the canonical PTY size** — the phone only fits its local xterm, so attaching never disturbs the desktop layout; TUI apps lay out for the desktop size (on a narrow phone screen they may render imperfectly, accepted trade-off). Each connection subscribes with its own `SyncSender` and disconnect removes exactly that subscription; a viewer that falls behind is evicted and told to resubscribe.
- **Tab sync**: the frontend (`useWebTerminalSync` in `App.tsx`) syncs every desktop terminal tab (`web_sync_tabs`) so the phone lists all command lines, not just ones with a live PTY. When the phone attaches to a tab with no pty yet, the server emits `terax:web-activate`; the frontend activates that tab (spawning the pty) and the phone retries via the `opening` message. `pty_open` records the leaf to pty mapping (`web_sync_leaf_pty`).

### PTY shell integration

PTY shells are bootstrapped via an injected init script:

- **Windows** (`profile.ps1`) - passed via `pwsh -NoLogo -NoExit -ExecutionPolicy Bypass -File <path>`. Wraps the user's existing `prompt` function (after their `$PROFILE` runs) to emit OSC 7 + OSC 133 A/B/D. Shell priority: `pwsh.exe` (PS 7+) -> `powershell.exe` (PS 5.1) -> `cmd.exe` (no integration). cwd is normalized to backslashes before being passed to ConPTY (`CreateProcessW` misbehaves with forward-slash cwd).

ConPTY on Windows requires `CONPTY_LIFECYCLE_LOCK` (Mutex) around `openpty + spawn_command` in `session.rs`. Concurrent spawns leave one of the resulting PTYs with a stalled output pipe. Don't remove the lock without verifying first-tab stability under fast tab spam.

Each ConPTY child is also assigned to a per-session **Job Object** with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` (`modules/proc/job.rs`). When the Job HANDLE drops - clean shutdown, panic, or even SIGKILL'd Terax process - the kernel kills every descendant of the shell (e.g. `npm run dev` spawned from inside pwsh). Without this Windows orphans the entire process subtree because `TerminateProcess` only kills the immediate child.

Terminal coding-agent detection lives Rust-side (`pty/agent_detect.rs`) on the PTY reader's byte filter, emitting `terax:agent-signal` transitions (`started`/`working`/`attention`/`finished`/`exited`) driven only by OSC sequences (never raw output, so a repainting TUI never flaps) - zero cost when no agent runs. Frontend store in `terminal/lib/agentActivity.ts`; `App.tsx`'s `findClaudeLeaf` uses it to route "Send to Claude Code" (explorer context menu `onAttachToAgent`, selection shortcut `selection.sendToAgent`) to the pane running the agent.

### Frontend (`src/`)

Single-window React app. Path alias `@/*` -> `src/*`. Tabs are a tagged union (`kind`: `terminal` | `editor` | `preview` | `markdown` | `git-diff` | `git-history` | `git-commit-file`) and **not** unmounted on switch - they're hidden via `invisible pointer-events-none` so PTYs and dev servers keep streaming in the background.

`App.tsx` wires modules together - keep it a coordinator. New features go inside the appropriate `modules/<area>/`.

### Module layout (`src/modules/`)

Each module is self-contained, exports a thin barrel via `index.ts`, and owns its hooks under `lib/`.

- **terminal/** - `TerminalStack` keeps one mounted xterm per tab via `useTerminalSession` + `pty-bridge`. `osc-handlers.ts` parses OSC 7 (with Windows drive-letter normalization: `/C:/Users/foo` -> `C:/Users/foo`) and OSC 133 markers. The xterm color palette is driven by the central theme engine (`modules/theme`), not a local table. Renderer slots are pooled (`rendererPool.ts`, max 5): a hidden leaf with a foreground job (OSC 133 C..D, agent signal, or `pty_has_foreground_job`) keeps its live grid parked with rendering paused via `display:none`; an idle hidden leaf releases its slot but the buffer is retained and serialized lazily only when another leaf steals it. The `DormantRing` (1 MiB, no terminal reset on overflow) buffers bytes only for leaves whose slot was stolen or never bound. Never serialize a leaf that is mid-command: replaying incremental TUI repaints over a snapshot is what used to wipe Claude Code.
- **editor/** - CodeMirror 6 stack (`EditorStack` mirrors `TerminalStack`). `extensions.ts` configures language modes; supports vim mode. Buffers live in LF space and the original EOL (`lib/eol.ts`, majority-vote detection) is restored on save; indent unit/tab size are detected per file (`lib/indent.ts`). Saves are conflict-checked against the disk mtime returned by `fs_read_file`/`fs_write_file` (mismatch -> warning toast with explicit Overwrite, never silent last-writer-wins). Files over 10 MB offer "Open anyway" (hard cap 50 MB, `force` arg); above 4 MB syntax highlighting and LSP stay off. Format-on-save formatters live in `lib/externalFormat.ts` (`FORMATTERS` registry: biome, prettier, ruff, rustfmt, gofmt, clang-format, shfmt, zig fmt, plus a custom `{file}` command template); `resolveFormatter` applies per-language overrides (`editorFormatterByLang`) over the global default. Editor font size is stored separately as `editorFontSize` and does not affect `terminalFontSize`.
- **explorer/** - file tree with Material/Catppuccin icons (`iconResolver.ts`), keyboard nav, inline rename, context actions. Backslash-aware `basename`. The persistent search bar (`ExplorerSearch`) matches **both file names** (fuzzy, via `fs_search`) and **file contents** (via `fs_grep_interactive`, same backend as Ctrl+Shift+P), showing matching lines with line numbers.
- **preview/** - auto-detected dev-server preview tab (status-bar pill suggests opening when a localhost URL is detected).
- **tabs/** - `useTabs` is the source of truth for tab list + active id. `useWorkspaceCwd` derives the explorer root, inherited cwd for new tabs, and the current terminal tab that the file/version/window side panels follow. `basename` splits on both `/` and `\`.
  - **File tabs belong to a command line**: each editor/markdown tab carries an `ownerTabId` pointing at the terminal tab it was opened from. `capEditorTabs` caps file tabs **per owner** (`MAX_EDITOR_TABS_PER_SPACE` = 10 per terminal tab, oldest evicted first, dirty / just-opened / active kept). Ownerless tabs fall back to a per-space bucket. The owner survives serialization (stored as a positional reference) and tab moves; closing a terminal detaches its files (they become "Unattached").
- **header/** - top bar + inline search (`SearchInline` greps the workspace root via `fs_grep_interactive` with a results dropdown; `openContentHit` opens the file at line). `WindowControls` rendered when `USE_CUSTOM_WINDOW_CONTROLS` is true (always on Windows).
- **statusbar/** - bottom bar, `CwdBreadcrumb` (handles Windows drive letters and home `~` segments via `pathUtils.segmentsFromCwd`).
- **shortcuts/** - keymap registry (`shortcuts.ts`) + `useGlobalShortcuts`. Handlers live in `App.tsx` and are passed in by id (`tab.new`, `search.focus`, ...). `metaKey || ctrlKey` for the platform modifier (Ctrl on Windows).
- **settings/** - settings store (`store.ts` via `tauri-plugin-store`), preferences hook, settings window opener.
- **sidebar/** - activity bar + collapsible side panels (explorer, source control, open files). The open-files panel (`OpenFilesPanel`) groups files **by their owning command line** and follows the current terminal tab, so switching command lines switches the file list.
- **source-control/** - git status / stage / commit panel and diff workflow.
- **git-history/** - commit graph rail, refs, per-commit file diffs.
- **lsp/** - opt-in language server support, zero cost until enabled. Statusbar pill offers Enable (binary found) or Install (with copyable command) per language; activation persists as `lspActivation` in the settings store. `sessionManager.ts` keys sessions by (server, workspace root), refcounts open docs, idle-kills after 3 min, and crash-backoffs. Resource invariants: **no root marker -> no session**, hard cap of 4 sessions per server. Client is `codemirror-languageserver` behind a lazy import, subclassed (`lib/client.ts`) to add didClose/didSave/shutdown, references, and the publishDiagnostics capability. `vscode-languageserver-protocol` is aliased to a small shim in vite.config.ts. WSL workspaces excluded for now.
- **markdown/** - markdown preview renderer (backs the `markdown` tab kind).
- **workspace/** - workspace environment switching (Local + WSL distros).
- **theme/** - custom theme engine (no `next-themes`). `ThemeProvider` + `applyTheme` write CSS variables; built-in presets in `themes/`, each optionally declaring an `editorTheme` pairing. User themes via `customThemes.ts` + `validateTheme.ts`, optional background image via `bgImageStore.ts` + `SurfaceLayer`.
- **updater/** - auto-updater UI built on `tauri-plugin-updater`.
- **command-palette/** - modal command palette (`CommandPalette.tsx`, `commands.ts`) for actions and navigation.
- **spaces/** - workspace spaces/projects (name, root, env, color, per-space tab persistence) via `useSpaces` and `GroupSwitcher`.

### UI conventions

- **shadcn/ui** is configured (`components.json`, icon lib **hugeicons**). Primitives in `src/components/ui/` - don't hand-edit; re-run `pnpm dlx shadcn add` to upgrade.
- **AI Elements** (Vercel) live in `src/components/ai-elements/` from the `@ai-elements` registry in `components.json` (only `markdown-code` is still used, by the markdown preview). Same rule: regenerate, don't hand-patch.
- **Tailwind v4** - no `tailwind.config.*`, config is in `src/App.css` via `@theme`. Use `cn()` from `@/lib/utils`.
- Resizable layout: `react-resizable-panels`.
- Path imports: always `@/...`, never relative across modules.
- Cross-platform paths: anywhere a path may originate from OSC 7, the explorer, or the OS, normalize separators with `.split(/[\\/]/)` rather than `.split("/")`.
- Canonical path form on the frontend is **forward-slash**. `homeDir()` returns backslashes on Windows; convert at the boundary (App.tsx setHome). OSC 7 already arrives as forward-slash. Equal canonical strings keep `useFileTree` from wiping its tree and flashing the explorer when `tab.cwd` first arrives.

### Window styling

- Windows: `decorations: false` + `transparent: true` from `tauri.windows.conf.json`. React renders custom `WindowControls`.

### Tauri capabilities

`src-tauri/capabilities/default.json` is the allowlist for plugin APIs available to the webview. New plugins (dialog, autostart, updater, window-state, store, opener, os, log are wired in `lib.rs`) typically need:
1. `Cargo.toml` dependency
2. `.plugin(...)` call in `lib.rs` `run()`
3. capability entry in `default.json`

### Cross-platform conventions

- HOME / cache dirs: use the `dirs` crate (`dirs::home_dir()`, `dirs::cache_dir()`), never raw `$HOME` / `%USERPROFILE%`.
- Shell init: Windows arm in `pty::shell_init::windows`.
- Terminal input: send `\r` (CR) for Enter, not `\n` (LF) - PowerShell on Windows requires CR.

### Bundle config

- `bundle.targets: "all"` plus Windows sections in `tauri.conf.json`: NSIS installer in `currentUser` mode (no admin required), WebView2 via `embedBootstrapper` (offline install).
- Auto-updater configured with a public minisign key; release artifacts at `https://github.com/crynta/terax-ai/releases/latest/download/latest.json`.

### Known gotchas

- **React 19 strict mode** double-mounts `useEffect` in dev -> terminals spawn twice on first render. The first PTY is cleaned up almost immediately. The `SPAWN_LOCK` mutex serializes this; don't be alarmed by `pty opened id=1` followed by `pty closed id=1` in dev logs.
- **Windows PowerShell process lifecycle**: `killer.kill()` from `portable-pty` only kills the immediate child. Descendants (e.g. `npm run dev` started inside pwsh) survive unless something else takes them down. The Job Object in `pty/job.rs` handles this for the Terax-process-death case; an explicit `pty_close` from JS also kills only the immediate child + relies on the Job to take the rest. Don't disable the Job without a replacement.
- **Tab `cwd` storage**: comes from OSC 7 with forward slashes (after `parseOsc7` strips `/C:` -> `C:`). Anything that consumes `tab.cwd` and passes it to a Rust fs command on Windows must normalize separators or accept both forms - `apply_common` in `pty::shell_init` handles this for PTY spawn; other call sites must do their own.

## Further reading

Long-form contributor guides live under `docs/`. These guides elaborate on `TERAX.md`; if anything conflicts, `TERAX.md` wins.

- `docs/README.md` - index of contributor guides
- `docs/architecture/two-process-model.md` - IPC boundary and command reference
- `docs/architecture/pty-shell-integration.md` - PTY, shell init scripts, OSC, ConPTY, Job Object
- `docs/architecture/web-terminal-bridge.md` - embedded HTTP + WebSocket server sharing PTY sessions with a phone browser
- `docs/architecture/security-model.md` - consolidated security model and boundaries
- `docs/architecture/terminal-renderer-pool.md` - renderer pool and DormantRing invariants
- `docs/architecture/cli-control.md` - bundled CLI and authenticated local control plane
- `docs/issues.md` - known code issues, architectural debt, and risks
