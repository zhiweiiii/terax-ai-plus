mod agent_detect;
mod da_filter;
mod session;
pub(crate) mod shell_init;

use std::collections::HashMap;
use std::io::Write;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::thread;

use tauri::ipc::{Channel, Response};
use tauri::Emitter;

use crate::modules::control::ControlState;
use crate::modules::workspace::{user_spawn_cwd_or_home, WorkspaceEnv, WorkspaceRegistry};
pub(crate) use session::{Session, SizeOwner, WebMsg};

/// Emitted when the PTY grid changed because an end claimed the session. The
/// desktop frontend must resize its xterm to match and stop auto-fitting until
/// it claims the session back, otherwise its next fit would fight the phone
/// for the grid.
pub const PTY_RESIZED_EVENT: &str = "terax:pty-resized";

/// A desktop terminal tab, synced to the web layer so the phone can list and
/// attach to every command line, not just the ones with a live PTY.
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct WebTab {
    /// Frontend leaf id; the key the frontend uses to activate a tab.
    pub leaf_id: u32,
    pub cwd: Option<String>,
    pub title: Option<String>,
    pub active: bool,
    /// Set once a pty session exists for this leaf.
    pub pty_id: Option<u32>,
    /// The group (space) this terminal belongs to.
    pub space_id: Option<String>,
}

/// A desktop group (space) synced to the web layer, so the phone's switcher
/// can show every group, including empty ones.
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct WebSpace {
    pub id: String,
    pub name: String,
}

pub struct PtyState {
    sessions: RwLock<HashMap<u32, Arc<Session>>>,
    // Starts at 1 so freshly-handed-out ids are never 0, which the frontend
    // sometimes treats as "unset". Increments monotonically; never reused.
    next_id: AtomicU32,
    /// Desktop terminal tabs advertised to the web page (leaf → metadata).
    web_tabs: Mutex<Vec<WebTab>>,
    /// All groups (spaces), including empty ones, for the phone's switcher.
    web_spaces: Mutex<Vec<(String, String)>>,
}

impl Default for PtyState {
    fn default() -> Self {
        Self {
            sessions: RwLock::new(HashMap::new()),
            next_id: AtomicU32::new(1),
            web_tabs: Mutex::new(Vec::new()),
            web_spaces: Mutex::new(Vec::new()),
        }
    }
}

impl PtyState {
    pub(super) fn take(&self, id: u32) -> Option<Arc<Session>> {
        self.sessions.write().unwrap().remove(&id)
    }

    /// Desktop terminal tabs for the web page: every command line the desktop
    /// app has, with a pty_id when the session is live.
    pub fn web_tabs(&self) -> Vec<WebTab> {
        let sessions = self.sessions.read().unwrap();
        let mut list = self.web_tabs.lock().unwrap();
        for t in list.iter_mut() {
            // A pty_id pointing at a session that is gone (exited or never
            // spawned) is stale: drop it so the page never attaches to the
            // wrong session (issue #8). The frontend syncs live ids via
            // web_sync_leaf_pty, so no cwd-based guessing is needed.
            if let Some(pid) = t.pty_id {
                if sessions.get(&pid).is_none() {
                    t.pty_id = None;
                }
            }
        }
        list.iter().cloned().collect()
    }

    /// Update the desktop tab list advertised to the web page.
    pub fn web_sync_tabs(&self, tabs: Vec<WebTab>) {
        let mut list = self.web_tabs.lock().unwrap();
        *list = tabs;
    }

    /// Update the group (space) list advertised to the web page. Includes
    /// empty groups so the phone's switcher shows every group.
    pub fn web_sync_spaces(&self, spaces: Vec<WebSpace>) {
        let mut list = self.web_spaces.lock().unwrap();
        *list = spaces.into_iter().map(|s| (s.id, s.name)).collect();
    }

    /// Groups (spaces) for the web page's switcher, in desktop order.
    pub fn web_spaces(&self) -> Vec<(String, String)> {
        self.web_spaces.lock().unwrap().clone()
    }

    /// Record that a leaf's pty session now exists under `pty_id`.
    pub fn web_sync_leaf_pty(&self, leaf_id: u32, pty_id: u32) {
        let mut list = self.web_tabs.lock().unwrap();
        if let Some(t) = list.iter_mut().find(|t| t.leaf_id == leaf_id) {
            t.pty_id = Some(pty_id);
        }
    }

    /// Borrow a live session by id for the web layer (write / resize / subscribe).
    pub fn web_get(&self, id: u32) -> Option<Arc<Session>> {
        self.sessions.read().unwrap().get(&id).cloned()
    }

    /// Current PTY grid of a session. Reads the session's own mirror rather
    /// than the master, so every message that carries a grid (the session
    /// list, "attached", "resized") reports the same number. Asking the master
    /// separately gave the page a second source that could disagree, and it
    /// then flipped between the two on every poll.
    pub fn web_session_size(&self, s: &Arc<Session>) -> (u16, u16) {
        s.size()
    }

    /// The working directory a desktop leaf reports. Used to find the agent
    /// transcript that belongs to it.
    pub fn web_leaf_cwd(&self, leaf_id: u32) -> Option<String> {
        self.web_tabs
            .lock()
            .unwrap()
            .iter()
            .find(|t| t.leaf_id == leaf_id)
            .and_then(|t| t.cwd.clone())
    }

    /// Resolve a desktop leaf to its live pty session. When the tab has never
    /// been opened, emit an activation request to the frontend (which spawns
    /// the pty) and return None so the page can retry shortly.
    pub fn web_leaf_session(&self, leaf_id: u32, app: &tauri::AppHandle) -> Option<Arc<Session>> {
        let pty_id = self
            .web_tabs
            .lock()
            .unwrap()
            .iter()
            .find(|t| t.leaf_id == leaf_id)
            .and_then(|t| t.pty_id);
        if let Some(pty_id) = pty_id {
            return self.web_get(pty_id);
        }
        let _ = app.emit("terax:web-activate", leaf_id);
        None
    }

    /// Ensure at least one terminal session exists for the web page. Spawns a
    /// default shell (home cwd, no control env) when the session map is empty,
    /// so the phone always has something to attach to. Output goes to the
    /// session's own history + web broadcast; no Tauri Channel is involved.
    pub fn web_ensure_session(&self, app: &tauri::AppHandle) {
        if !self.sessions.read().unwrap().is_empty() {
            return;
        }
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let cwd = dirs::home_dir().map(|p| p.to_string_lossy().into_owned());
        let app = app.clone();
        let spawned = tauri::async_runtime::block_on(async {
            let session = tauri::async_runtime::spawn_blocking(move || {
                session::spawn(
                    id,
                    app,
                    80,
                    24,
                    cwd,
                    WorkspaceEnv::from_option(None),
                    false,
                    None,
                    None,
                    // The session the phone attaches to has no desktop pane to
                    // inherit a provider choice from.
                    None,
                    None,
                    None,
                )
                .map(|(s, _)| s)
            })
            .await;
            session.ok().and_then(|r| r.ok())
        });
        if let Some(session) = spawned {
            self.sessions.write().unwrap().insert(id, session);
            log::info!("web: spawned default session id={id}");
        } else {
            log::warn!("web: failed to spawn default session");
        }
    }
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn pty_open(
    app: tauri::AppHandle,
    state: tauri::State<'_, PtyState>,
    control: tauri::State<'_, ControlState>,
    registry: tauri::State<'_, WorkspaceRegistry>,
    cols: u16,
    rows: u16,
    cwd: Option<String>,
    workspace: Option<WorkspaceEnv>,
    blocks: Option<bool>,
    shell: Option<String>,
    pane_id: Option<u32>,
    gateway_provider: Option<String>,
    on_data: Channel<Response>,
    on_exit: Channel<i32>,
) -> Result<u32, String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    let blocks = blocks.unwrap_or(false);
    let cwd = user_spawn_cwd_or_home(&registry, cwd.as_deref(), &workspace);
    // A Windows helper cannot execute inside WSL without explicit path and
    // network translation. Do not inject credentials for a broken command.
    let control_env = if workspace.is_wsl() {
        None
    } else {
        pane_id.and_then(|pane_id| control.shell_env(pane_id))
    };
    let id = state.next_id.fetch_add(1, Ordering::Relaxed);
    let data_cb = Some(Box::new(move |bytes: Vec<u8>| {
        if on_data.send(Response::new(bytes)).is_err() {
            log::debug!("pty output channel closed");
        }
    }) as Box<dyn Fn(Vec<u8>) + Send + Sync>);
    let exit_cb = Some(Box::new(move |code: i32| {
        if on_exit.send(code).is_err() {
            log::debug!("pty exit channel closed");
        }
    }) as Box<dyn Fn(i32) + Send + Sync>);
    let session = tauri::async_runtime::spawn_blocking(move || {
        session::spawn(
            id,
            app,
            cols,
            rows,
            cwd,
            workspace,
            blocks,
            shell,
            control_env,
            gateway_provider,
            data_cb,
            exit_cb,
        )
        .map(|(s, _)| s)
    })
    .await
    .map_err(|e| {
        log::error!("pty_open join failed: {e}");
        e.to_string()
    })?
    .map_err(|e| {
        log::error!("pty_open failed: {e}");
        e
    })?;
    state.sessions.write().unwrap().insert(id, session);
    // Record the leaf → pty mapping so the web page can show this tab as live.
    if let Some(leaf) = pane_id {
        state.web_sync_leaf_pty(leaf, id);
    }
    // The shell can exit before this insert (instant failure, `exit` in an rc
    // file); the waiter's reap then ran with the id absent. Re-check and reap
    // so the pseudoconsole isn't stranded.
    let exited = state
        .sessions
        .read()
        .unwrap()
        .get(&id)
        .map(|s| s.exited.load(Ordering::Acquire))
        .unwrap_or(false);
    if exited {
        if let Some(s) = state.take(id) {
            thread::Builder::new()
                .name(format!("terax-pty-drop-{id}"))
                .spawn(move || session::drop_session(s))
                .expect("spawn pty drop thread");
        }
    }
    log::info!("pty opened id={id} cols={cols} rows={rows}");
    Ok(id)
}

// Input is the latency-critical path: raw body + id header skips JSON
// serialization of every keystroke on both sides of the IPC boundary.

/// xterm-generated protocol answers, forwarded by the app's onData handler:
/// focus reports (ESC [ I / ESC [ O) and OSC replies (ESC ] ... BEL|ST).
/// They are not input and must not claim the session (see pty_write).
fn looks_like_protocol_response(bytes: &[u8]) -> bool {
    if bytes == b"\x1b[I" || bytes == b"\x1b[O" {
        return true;
    }
    bytes.starts_with(b"\x1b]")
        && (bytes.ends_with(b"\x07") || bytes.ends_with(b"\x1b\\"))
}

#[tauri::command]
pub fn pty_write(
    state: tauri::State<PtyState>,
    request: tauri::ipc::Request,
) -> Result<(), String> {
    let id: u32 = request
        .headers()
        .get("x-pty-id")
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.parse().ok())
        .ok_or_else(|| "pty_write: missing x-pty-id header".to_string())?;
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("pty_write: expected raw body".to_string());
    };
    // Typing at the desktop is an activity claim: it takes the grid back from
    // a phone that had claimed it.
    //
    // Not every write is a keystroke: xterm forwards its own protocol answers
    // through this same command - focus reports (ESC [ I / O, the TUI enabled
    // reporting) and OSC replies (ESC ] ... BEL|ST, a palette query the TUI
    // asked for). Those must reach the PTY or the TUI hangs waiting, but they
    // must not move the grid, or a watched session ping-pongs back to the
    // desktop's size a few seconds after every phone claim.
    if !looks_like_protocol_response(bytes) {
        if let Some(session) = state.sessions.read().unwrap().get(&id) {
            if let Some((cols, rows)) = session.claim(SizeOwner::Desktop) {
                log::info!("pty {id}: desktop reclaimed grid {cols}x{rows}");
            }
        }
    }
    let session = state
        .sessions
        .read()
        .unwrap()
        .get(&id)
        .cloned()
        .ok_or_else(|| {
            log::warn!("pty_write: unknown id={id}");
            "no session".to_string()
        })?;
    // Bind to a local so the MutexGuard temporary drops before `session` —
    // see rustc note on tail-expression temporary drop order.
    let result = session
        .writer
        .lock()
        .unwrap()
        .write_all(bytes)
        .map_err(|e| {
            // EPIPE is expected if the child already exited.
            log::debug!("pty_write id={id} failed: {e}");
            e.to_string()
        });
    result
}

#[tauri::command]
pub fn pty_resize(
    state: tauri::State<PtyState>,
    id: u32,
    cols: u16,
    rows: u16,
) -> Result<(u16, u16), String> {
    let session = state
        .sessions
        .read()
        .unwrap()
        .get(&id)
        .cloned()
        .ok_or_else(|| {
            log::warn!("pty_resize: unknown id={id}");
            "no session".to_string()
        })?;
    // Every desktop fit funnels through here: window resize, window focus,
    // switching to the tab, app start. None of those transfer ownership, or a
    // desktop sitting idle would keep snatching the grid back from a phone
    // that is only being watched. It applies when the desktop already owns the
    // session, and is remembered otherwise.
    session.request_grid(SizeOwner::Desktop, cols, rows);
    // Report the grid that actually applies. A phone that claimed the session
    // inside the cooldown keeps its own, and the desktop has to render at it
    // rather than at what it just asked for.
    Ok(session.size())
}

/// Make a TUI repaint without moving the grid. See Session::kick_grid; this is
/// deliberately NOT pty_resize, so a repaint nudge never reaches the phone as a
/// grid change.
#[tauri::command]
pub fn pty_kick(
    state: tauri::State<PtyState>,
    id: u32,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let Some(session) = state.web_get(id) else {
        return Ok(());
    };
    session.kick_grid(cols, rows);
    Ok(())
}

#[tauri::command]
pub fn pty_close(state: tauri::State<PtyState>, id: u32) -> Result<(), String> {
    let session = state.sessions.write().unwrap().remove(&id);
    if let Some(s) = session {
        if let Err(e) = s.killer.lock().unwrap().kill() {
            // Non-fatal: the child may already have exited on its own (e.g. the
            // user ran `exit`). Log so this isn't invisible during debugging.
            log::debug!("pty_close: kill id={id} returned {e}");
        }
        log::info!("pty closed id={id}");
        // Detached: on Windows `ClosePseudoConsole` can block until conhost
        // drains, which would freeze this Tauri worker thread and stall IPC.
        thread::Builder::new()
            .name(format!("terax-pty-drop-{id}"))
            .spawn(move || {
                let t0 = std::time::Instant::now();
                session::drop_session(s);
                log::info!(
                    "pty session id={id} dropped in {}ms",
                    t0.elapsed().as_millis()
                );
            })
            .expect("spawn pty drop thread");
    } else {
        log::debug!("pty_close: unknown id={id}");
    }
    Ok(())
}

#[tauri::command]
pub fn pty_has_foreground_process(state: tauri::State<PtyState>, id: u32) -> Result<bool, String> {
    let sessions = state.sessions.read().unwrap();
    let session = sessions.get(&id).ok_or_else(|| {
        log::warn!("pty_has_foreground_process: unknown session id={id}");
        "no session".to_string()
    })?;
    let shell_pid = session.shell_pid;
    if shell_pid == 0 {
        return Ok(false);
    }
    Ok(shell_has_children(shell_pid))
}

// Foreground-only check for the renderer hibernation path: true while a job
// owns the tty (tcgetpgrp != shell pgid). Stricter and cheaper than
// pty_has_foreground_process, which counts background children too.
#[tauri::command]
pub fn pty_has_foreground_job(state: tauri::State<PtyState>, id: u32) -> Result<bool, String> {
    let sessions = state.sessions.read().unwrap();
    let session = sessions.get(&id).ok_or_else(|| {
        log::warn!("pty_has_foreground_job: unknown session id={id}");
        "no session".to_string()
    })?;
    let shell_pid = session.shell_pid;
    if shell_pid == 0 {
        return Ok(false);
    }
    #[cfg(unix)]
    {
        let leader = session.master.lock().unwrap().process_group_leader();
        Ok(matches!(leader, Some(pid) if pid > 0 && pid as u32 != shell_pid))
    }
    #[cfg(windows)]
    {
        Ok(shell_has_children(shell_pid))
    }
}

// pgrep -P exits 0 when shell_pid has at least one child, 1 when none.
#[cfg(unix)]
fn shell_has_children(shell_pid: u32) -> bool {
    std::process::Command::new("pgrep")
        .args(["-P", &shell_pid.to_string()])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

#[cfg(windows)]
fn shell_has_children(shell_pid: u32) -> bool {
    use std::mem::{size_of, zeroed};
    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32First, Process32Next, PROCESSENTRY32,
        TH32CS_SNAPPROCESS,
    };
    unsafe {
        let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snapshot == INVALID_HANDLE_VALUE {
            return false;
        }
        let mut entry: PROCESSENTRY32 = zeroed();
        entry.dwSize = size_of::<PROCESSENTRY32>() as u32;
        let mut found = false;
        if Process32First(snapshot, &mut entry) != 0 {
            loop {
                if entry.th32ParentProcessID == shell_pid {
                    found = true;
                    break;
                }
                if Process32Next(snapshot, &mut entry) == 0 {
                    break;
                }
            }
        }
        CloseHandle(snapshot);
        found
    }
}

// A fresh webview load orphans the previous frontend's sessions in this still
// running process; reap them on boot before any new tab spawns.
#[tauri::command]
pub fn pty_close_all(state: tauri::State<PtyState>) -> Result<usize, String> {
    let drained: Vec<(u32, Arc<Session>)> = {
        let mut sessions = state.sessions.write().unwrap();
        sessions.drain().collect()
    };
    let count = drained.len();
    for (id, s) in drained {
        if let Err(e) = s.killer.lock().unwrap().kill() {
            log::debug!("pty_close_all: kill id={id} returned {e}");
        }
        thread::Builder::new()
            .name(format!("terax-pty-drop-{id}"))
            .spawn(move || session::drop_session(s))
            .expect("spawn pty drop thread");
    }
    if count > 0 {
        log::info!("pty_close_all: reaped {count} orphaned session(s)");
    }
    Ok(count)
}

#[tauri::command]
pub fn pty_shell_name() -> String {
    shell_init::detect_shell_name()
}

#[tauri::command]
pub fn pty_list_shells() -> Vec<shell_init::ShellInfo> {
    shell_init::list_shells()
}

/// Frontend syncs its terminal tabs here so the web page can list them all.
///
/// This is also where a closed terminal is noticed: the frontend sends the
/// tabs it still has, so any queued command naming one that is gone is dropped
/// rather than waiting for a terminal that will never come back.
#[tauri::command]
pub fn web_sync_tabs(
    state: tauri::State<PtyState>,
    schedule: tauri::State<crate::modules::schedule::ScheduleState>,
    app: tauri::AppHandle,
    tabs: Vec<WebTab>,
) {
    let live: std::collections::HashSet<u32> = tabs.iter().map(|t| t.leaf_id).collect();
    state.web_sync_tabs(tabs);
    let before = schedule.revision();
    for leaf in schedule
        .list()
        .iter()
        .map(|j| j.leaf_id)
        .filter(|leaf| !live.contains(leaf))
        .collect::<std::collections::HashSet<_>>()
    {
        schedule.forget_leaf(leaf);
    }
    if schedule.revision() != before {
        let _ = app.emit(
            crate::modules::schedule::SCHEDULE_EVENT,
            schedule.list(),
        );
    }
}

/// Frontend syncs its groups (spaces) here — including empty ones — so the
/// phone's switcher lists every group, not only those with terminals.
#[tauri::command]
pub fn web_sync_spaces(state: tauri::State<PtyState>, spaces: Vec<WebSpace>) {
    state.web_sync_spaces(spaces);
}

/// Frontend tells us a leaf's pty session id once it has been opened.
#[tauri::command]
pub fn web_sync_leaf_pty(state: tauri::State<PtyState>, leaf_id: u32, pty_id: u32) {
    state.web_sync_leaf_pty(leaf_id, pty_id);
}

/// The web page wants to attach to a desktop tab that has no live pty yet.
/// Ask the frontend to activate that tab, which opens the pty.
#[tauri::command]
pub fn web_activate_leaf(app: tauri::AppHandle, leaf_id: u32) {
    let _ = app.emit("terax:web-activate", leaf_id);
}
