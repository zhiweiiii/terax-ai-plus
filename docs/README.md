# Terax contributor documentation

This directory holds long-form contributor and maintainer guides. `TERAX.md` at the repo root is the living architecture doc and the source of truth; these guides elaborate on specific areas without duplicating it.

If a guide conflicts with `TERAX.md`, `TERAX.md` wins.

## Documentation policy

**Every change must be recorded in the docs before it is considered done.** All of the following go into the appropriate guide (and `TERAX.md` when it changes the architecture):

- New features and behavior changes
- Bug fixes and the reasoning behind them
- Known anomalies, accepted trade-offs, and architectural debt
- Security notes, ports, auth, and other operational details

`docs/issues.md` is the audit log for bugs/risks/debt (numbered scan entries + the "Documentation drift" section); architecture guides capture how things are supposed to work. When you fix or add something, update both so a later maintainer can reconstruct what changed and why. If it's not in the docs, it didn't happen.

## Getting started

- [TERAX.md](../TERAX.md) - the architecture source of truth; read this first
- [CONTRIBUTING.md](../CONTRIBUTING.md) - how to contribute, quality bar, project layout

## Architecture guides

- [Two-process model and IPC command reference](architecture/two-process-model.md) - Rust owns all OS access; the webview talks through `invoke()`. Command catalog and how to add a new command.
- [PTY shell integration](architecture/pty-shell-integration.md) - PTY sessions, shell init scripts, OSC 7 / 133, ConPTY, CONPTY_LIFECYCLE_LOCK, Job Object, WSL.
- [Web terminal bridge](architecture/web-terminal-bridge.md) - embedded HTTP + WebSocket server that shares desktop PTY sessions with a phone browser; auth, protocol, build pipeline.
- [Security model](architecture/security-model.md) - workspace authorization, IPC allowlist, OSC trust, and the web terminal auth boundary.
- [Terminal renderer pool](architecture/terminal-renderer-pool.md) - slot pooling, the DormantRing, and the never-serialize-mid-command invariant.
- [CLI control plane](architecture/cli-control.md) - bundled CLI, authenticated local protocol, caller targeting, packaging, and current platform limits.
- [Known issues and architectural debt](issues.md) - documented bugs, risks, dead code, and docs drift.

## Porting history (archived)

- [history/](history/README.md) - archived migration records (`porting-issues.md`, `移植进度.md`) from the Git/IDEA VCS porting batch. Historical only; they reference removed code and are kept for context.
