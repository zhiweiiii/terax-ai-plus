# Roadmap

Terax direction, what's shipped, what's coming, and what's deliberately out of scope.

This file is updated as direction evolves. For day-to-day work, see [GitHub Issues](https://github.com/crynta/terax-ai/issues) and the Projects board.

## What Terax is

Terax is a fast, lightweight, terminal-first development workspace. It pairs a native PTY backend with a modern UI: multi-tab terminals, an integrated code editor, a file explorer, source control with a git graph, web preview, and an embedded web terminal bridge that shares the same PTY sessions with a phone browser. About 7-8 MB on disk. No telemetry.

The product is opinionated: terminal-first, lightweight always, Windows-only (including WSL), security by default.

## What Terax is not

- Not an IDE clone. Terax selectively integrates high-value editor capabilities such as LSP, formatting, source control, and previews without adopting the heavyweight runtime and always-on background services of a traditional IDE.
- Not a browser. Web preview exists for local dev servers and lightweight doc viewing only.
- Not a general workspace. Tools and formats that pull the product away from the terminal-first surface are out of scope.

## Themes

The themes below frame every scope decision.

1. **Lightweight always.** 7-8 MB binary. Every dependency justified. Per-tab memory budget enforced.
2. **Terminal-first.** xterm.js correctness, PTY fidelity, TUI app compatibility are non-negotiable.
3. **Windows-first.** Windows + WSL are the only supported targets; macOS/Linux branches were removed.
4. **Security by default.** Workspace path guards, OSC trust, IPC allowlist, and a password-gated web terminal bridge.
5. **Phone reachability.** The desktop PTY is reachable from a phone browser through the embedded web bridge (same sessions, content-synced).

## Shipped

- Multi-tab WebGL terminal with background streaming, split panes, blocks mode, inline search, agent detection.
- Code editor: CodeMirror 6, vim mode, format-on-save, opt-in LSP, rendered markdown preview.
- Source control: stage/unstage, commit + push, branch operations, remote management, commit graph.
- File explorer with persistent name + content search.
- Workspaces (spaces) with per-space tab persistence, Local / WSL environments.
- Web terminal bridge: phone browser access to every desktop command line, grouped by space, password-gated, with Ctrl+C / Ctrl+D controls.
- Web terminal bridge hardening: output draining independent of client input, precise subscriber removal, session exit notification, POST-only rate-limited auth, connection cap + heartbeat, stale pty-id cleanup (issues #1-8 in `docs/issues.md`).

## In progress / next

- Repository hygiene: reconcile remaining stale docs with the code, remove last dead exports (`editor/lib/extensions.ts`, `languageResolver.ts`, `worktreeOps.ts`, local `IS_MAC`).

## Out of scope (removed)

- AI agent panel: the BYOK/local-model agent system, composer, custom agents, and plan mode were removed from the codebase. Only the terminal-side coding-agent detection (OSC 133/777) remains.
- macOS and Linux builds: source branches and platform-specific code were removed.
- Automated test suite: tests, test config, and test dependencies were removed; verification is manual (see `CONTRIBUTING.md`).
