# PTY shell integration

This guide elaborates on `TERAX.md`. If anything here conflicts with `TERAX.md`, `TERAX.md` wins.

## Session model

A terminal tab maps to one PTY session. Sessions live in `PtyState` (`src-tauri/src/modules/pty/mod.rs`):

```rust
pub struct PtyState {
    sessions: RwLock<HashMap<u32, Arc<Session>>>,
    next_id: AtomicU32,
    web_tabs: Mutex<Vec<WebTab>>, // desktop tabs advertised to the web bridge
}
```

IDs start at 1 and monotonically increase; they are never reused so the frontend can treat `0` as unset.

`pty_open` spawns a session on a blocking thread, inserts it into the map, and returns the id. Output and exit codes are delivered through optional callbacks (`Box<dyn Fn(Vec<u8>) + Send + Sync>`): the frontend wires them to Tauri `Channel`s, while the embedded web server passes `None` and relies on the session's own history + broadcast. `pty_write` accepts raw bytes with an `x-pty-id` header to avoid JSON serialization on every keystroke.

## Reader / flusher / waiter threads

`session::spawn` (`session.rs`) starts three threads per session:

1. **Reader** - reads bytes from the PTY master, runs the DA filter and agent detector, and pushes filtered bytes into a pending buffer.
2. **Flusher** - coalesces output and sends it to the frontend over the data channel. It also appends each chunk to a rolling history ring (`WEB_HISTORY_CAP`, 256 KiB) and broadcasts it to any attached Web viewers (bounded queues so a slow phone never stalls the PTY). See [Web terminal bridge](web-terminal-bridge.md).
3. **Waiter** - waits for the child process to exit, flushes the tail, and emits the exit code.

The pending buffer is capped at 4 MiB; on overflow it is discarded and replaced with an SGR-reset notice so xterm state is not corrupted by a sliced CSI sequence.

## Shell bootstrapping (Windows)

`shell_init::build_command` (`shell_init.rs`) builds the `CommandBuilder` used to spawn the shell. The path and arguments depend on the selected workspace environment (Local or a WSL distro). The shell priority is:

1. `pwsh.exe` (PowerShell 7+)
2. `powershell.exe` (Windows PowerShell 5.1)
3. `cmd.exe` (no integration)

PowerShell loads `profile.ps1` via:

```text
pwsh -NoLogo -NoExit -ExecutionPolicy Bypass -File <profile.ps1>
```

The profile wraps the user's existing `prompt` function to emit OSC 7 + OSC 133 A/B/D after `$PROFILE` runs. The cwd is normalized to backslashes before being passed to ConPTY because `CreateProcessW` misbehaves with forward slashes.

The injected scripts emit **OSC 7** (cwd) and **OSC 133 A/B/C/D** (prompt boundaries and exit code) so Terax can track cwd and detect command boundaries without parsing the user's prompt.

## Concurrency and process lifetime on Windows

### `CONPTY_LIFECYCLE_LOCK`

`openpty + spawn_command` and the corresponding close are serialized by a static mutex in `session.rs`. Concurrent ConPTY lifecycle calls corrupt the new console so its shell never pumps output. React 19 strict mode double-mounts effects in dev, so two spawns can race on first render; this lock makes the second one wait.

### Job Object

Each ConPTY child is assigned to a Windows Job Object with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` (`modules/proc/job.rs`). When the Job HANDLE drops - clean shutdown, panic, or even a killed Terax process - the kernel kills every descendant of the shell. Without this, `TerminateProcess` only kills the immediate child and `npm run dev` started inside pwsh would be orphaned.

## Input and escape-sequence handling

### DA filter

PowerShell / PSReadLine sends a cursor-position query (`ESC[6n`) at startup and blocks until it gets an answer. The `DaFilter` (`da_filter.rs`) intercepts that query and replies on the PTY input so the shell does not hang.

### Agent detection

The reader thread runs an `AgentDetector` (`agent_detect.rs`) over the byte stream. It is armed by `OSC 133;C;<cmd>` or by a self-armed `OSC 777` marker and emits `terax:agent-signal` transitions (`started`, `working`, `attention`, `finished`, `exited`). Detection is driven only by OSC sequences, never by raw output, so a repainting TUI never flaps.

### Enter key

Terminal input sends `\r` (CR), not `\n` (LF). PowerShell on Windows requires CR.

## Invariants

- Do not remove `CONPTY_LIFECYCLE_LOCK` without verifying first-tab stability under fast tab spam.
- Do not disable the Job Object without a replacement orphan guard on Windows.
- cwd passed to ConPTY must use backslashes; OSC 7 cwd arriving at the frontend is forward-slash canonical.
- The web bridge shares the same `Arc<Session>`: output history and broadcast live in the flusher, so new consumers (phone viewers) must go through `Session::web_subscribe`, never a private copy of the byte stream.

## See also

- [`TERAX.md`](../../TERAX.md) - the architecture source of truth
- [`docs/README.md`](../README.md) - index of contributor guides
- [Two-process model](two-process-model.md) - IPC boundary and command catalog
- [Web terminal bridge](web-terminal-bridge.md) - how the web layer consumes these sessions
- [Terminal renderer pool](terminal-renderer-pool.md) - slot pooling and the DormantRing
- [Known issues](../issues.md) - known bugs and debt in this subsystem
