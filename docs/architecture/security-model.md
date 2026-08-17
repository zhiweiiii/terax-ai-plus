# Security model

This guide elaborates on `TERAX.md`. If anything here conflicts with `TERAX.md`, `TERAX.md` wins.

Terax runs shells, reads and writes files, and talks to git. The security model is defense-in-depth: no single guard is enough, so every boundary validates input before acting on it.

## Boundaries

The main trust boundaries are:

1. **IPC boundary** - commands registered in `src-tauri/src/lib.rs`, gated by `src-tauri/capabilities/default.json`.
2. **File-system boundary** - PTY spawn and git commands go through the workspace authorization registry.
3. **Terminal escape-sequence boundary** - OSC sequences are parsed and acted on, but never blindly trusted to mutate state.
4. **Web terminal boundary** - the embedded HTTP + WebSocket server (see `web-terminal-bridge.md`) is a remote shell surface. Access is gated by a password login (`POST /auth`, rate-limited: 5 consecutive failures → 5 s lockout, failure count surfaced in the desktop status bar) plus an auth cookie (`Max-Age=604800`) that the WebSocket upgrade also validates. The password digest and token exist only in Rust, never in the served page bundle. For anything beyond a trusted LAN, run behind a firewall or VPN because the server binds `0.0.0.0`.
   Known weaknesses tracked in `docs/issues.md` #3: the password is a hard-coded constant (its SHA-1 digest and the cookie token are XOR-obfuscated in source so `strings` cannot read them, but the obfuscation is not encryption) and the cookie token is a fixed string that never rotates.

## Workspace authorization registry

`WorkspaceRegistry` (`src-tauri/src/modules/workspace.rs:20`) tracks directories that PTY spawn and git commands are allowed to operate in.

- `workspace_authorize` adds a directory.
- `authorize_spawn_cwd` rejects a spawn cwd outside an authorized root.
- `authorize_user_spawn_cwd` registers the user's chosen cwd as a new root instead of rejecting it.
- The registry is bootstrapped with the launch directory and the user's home directory (`workspace.rs:135`).

This is the allow side of the file-system boundary. Any new feature that spawns a shell or mutates files outside the current workspace must interact with this registry.

## OSC trust gating

The terminal parses OSC sequences from the PTY byte stream:

- **OSC 7** updates the tab cwd.
- **OSC 133 A/B/C/D** marks prompt/command boundaries.
- **OSC 777** is used by the agent detector to signal coding-agent state transitions.

The agent detector (`src-tauri/src/modules/pty/agent_detect.rs`) is armed by `OSC 133;C;<cmd>` or by a self-armed marker and emits `terax:agent-signal` events. It is driven **only by OSC sequences**, never by raw output, so a repainting TUI never flaps.

## Invariants

- New file-system-touching commands must respect the workspace authorization registry.
- New plugin APIs must be added to `src-tauri/capabilities/default.json`.

## See also

- [`TERAX.md`](../../TERAX.md) - the architecture source of truth
- [`docs/README.md`](../README.md) - index of contributor guides
- [Two-process model](two-process-model.md) - IPC boundary and command catalog
