use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, SyncSender};
use std::sync::{Arc, Condvar, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use portable_pty::{native_pty_system, ChildKiller, MasterPty, PtySize};
use tauri::{AppHandle, Emitter, Manager};

use super::agent_detect::{AgentDetector, Transition};
use super::da_filter::DaFilter;
use super::shell_init;
use crate::modules::workspace::WorkspaceEnv;

const AGENT_EVENT: &str = "terax:agent-signal";

// Flusher coalesces a short window after first-byte arrival so we send chunks,
// not single bytes. MAX_IDLE is only a safety net for missed signals.
const FLUSH_COALESCE: Duration = Duration::from_millis(4);
const FLUSH_MAX_IDLE: Duration = Duration::from_millis(50);
const READ_BUF: usize = 16 * 1024;
// Cap on buffered-but-not-yet-flushed bytes. On overflow we discard the
// entire pending buffer and emit an SGR-reset + notice in its place.
// Dropping a partial prefix would slice a CSI sequence in half and corrupt
// xterm's screen state. 4 MiB is ~1000 full 80x24 screens.
const MAX_PENDING: usize = 4 * 1024 * 1024;
// Hard reset (ESC c) + dim notice. Written verbatim into the stream when
// we're forced to discard backlog.
const OVERFLOW_NOTICE: &[u8] =
    b"\x1bc\x1b[2m[terax: dropped output due to backpressure]\x1b[0m\r\n";

/// Bounded queue a Web client subscribes with. SyncSender + try_send drops the
/// oldest chunk when a slow viewer can't keep up, so one laggy phone never
/// stalls the PTY pipeline.
const WEB_SUB_QUEUE: usize = 64;

/// Message sent to a Web viewer: live output bytes, or a final exit notice so
/// the page can clear its attached state instead of waiting forever.
pub enum WebMsg {
    Output(Vec<u8>),
    Exited(i32),
    /// The grid changed because the other end claimed the session; the viewer
    /// has to re-size to it or the byte stream stops parsing correctly.
    Resized(u16, u16),
}

/// Which end last claimed a session and therefore owns its PTY grid.
///
/// The grid cannot be per-viewer: the byte stream carries absolute cursor
/// moves and \r redraws laid out against one specific cols x rows, so every
/// viewer has to render at the same grid. Ownership decides whose grid that
/// is, and moves to whichever end the user is actually at.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum SizeOwner {
    Desktop,
    Web,
}

/// Minimum gap between ownership transfers. Every transfer resizes the PTY,
/// which makes full-screen TUIs repaint, so two ends taking turns must not be
/// able to ping-pong the grid.
///
/// Only a keystroke transfers ownership. Merely looking at a session does not:
/// attaching the phone, focusing the desktop window, switching tabs and window
/// resizes all just record that end's preferred grid. Making those claim was
/// what put a watched session in a loop, since the desktop refits constantly
/// and would take the grid straight back from a phone that was only watching.
const OWNER_COOLDOWN: Duration = Duration::from_secs(3);

pub struct Session {
    // Field drop order is intentional. Rust drops fields top-to-bottom:
    //   1. `_job` — on Windows, closing the Job HANDLE fires
    //      KILL_ON_JOB_CLOSE, terminating the pwsh tree before the master
    //      pipe drops. Without this, ClosePseudoConsole in `master`'s Drop
    //      can block waiting for conhost to drain pending output, freezing
    //      the Tauri worker thread that triggered the close.
    //   2. `killer` — best-effort kill (redundant on Windows once Job
    //      closed, but harmless and required on Unix where there is no Job).
    //   3. `writer` — closes the input side of the master pipe.
    //   4. `master` — last; ClosePseudoConsole on Windows. By now the child
    //      is dead and conhost has nothing left to drain.
    #[cfg(windows)]
    _job: Option<crate::modules::proc::job::ProcessJob>,
    /// PID of the shell process. 0 means unknown; callers must skip checks when 0.
    pub shell_pid: u32,
    pub killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
    pub writer: Arc<Mutex<Box<dyn Write + Send>>>,
    pub master: Mutex<Box<dyn MasterPty + Send>>,
    // Set by the waiter once the child exits, so pty_open can reap a shell
    // that died before it was registered.
    pub(super) exited: Arc<AtomicBool>,
    /// Display metadata for the web page's session list.
    pub cwd: Option<String>,
    /// The coding agent running in this shell, as its own OSC markers
    /// announced it. Both the gate for reading an agent transcript - a
    /// directory that once ran one must not show that conversation over an
    /// idle prompt - and the choice of which transcript to read.
    agent: Arc<Mutex<Option<String>>>,
    /// Web viewers attached to this session (bounded queues).
    web_subs: Mutex<Vec<SyncSender<WebMsg>>>,
    /// Whether the PTY is currently on the alternate screen (opencode / claude
    /// / vim). Set by the flusher as it scans output; reported on attach so a
    /// phone can put its headless parser into the right mode before replaying
    /// the backlog — otherwise a ring that started mid-TUI parses as a shell.
    in_alt: AtomicBool,
    /// End that currently owns the grid, and when it took over.
    owner: Mutex<(SizeOwner, Instant)>,
    /// The live PTY grid, mirrored so viewers can be told without asking the
    /// master (which would need the lock the resize path already holds).
    size: Mutex<(u16, u16)>,
    /// Last grid each end asked for. A claim triggered by a keystroke has no
    /// dimensions of its own, so it restores the claimer's remembered grid.
    desktop_grid: Mutex<Option<(u16, u16)>>,
    web_grid: Mutex<Option<(u16, u16)>>,
}

impl Drop for Session {
    fn drop(&mut self) {
        // If the session Arc is dropped without an explicit pty_close (e.g.
        // frontend disconnected, window crashed, dev HMR), the reader/flusher
        // threads would otherwise stay alive forever holding the child. Kill
        // the child here so the reader hits EOF and the threads unwind.
        if let Ok(mut k) = self.killer.lock() {
            let _ = k.kill();
        }
    }
}
// Serializes ConPTY create and close: overlapping pseudoconsole lifecycle
// calls corrupt the new console so its shell never pumps output (issue #356).
#[cfg(windows)]
static CONPTY_LIFECYCLE_LOCK: Mutex<()> = Mutex::new(());

pub(super) fn drop_session(session: Arc<Session>) {
    #[cfg(windows)]
    let _guard = CONPTY_LIFECYCLE_LOCK.lock().unwrap();
    drop(session);
}

impl Session {
    /// Whether the PTY is on the alternate screen right now, so a phone can
    /// parse the replayed backlog in the right mode.
    pub fn web_in_alt(&self) -> bool {
        self.in_alt.load(Ordering::Acquire)
    }

    /// The coding agent running in this shell right now, if any.
    pub fn web_agent(&self) -> Option<String> {
        self.agent.lock().unwrap().clone()
    }

    /// Attach a Web viewer: returns the sender handle used to cancel this exact
    /// subscription, and a receiver for live chunks. Returns None if the
    /// session already exited.
    ///
    /// No backlog comes out of here. What a viewer sees first is the desktop
    /// terminal's own buffer, asked for on attach (`web::request_snapshot`):
    /// keeping a second copy of every session's output on this side made the
    /// phone open on a history the desktop no longer had.
    pub fn web_subscribe(&self) -> Option<(SyncSender<WebMsg>, mpsc::Receiver<WebMsg>)> {
        if self.exited.load(Ordering::Acquire) {
            return None;
        }
        let (tx, rx) = mpsc::sync_channel(WEB_SUB_QUEUE);
        self.web_subs.lock().unwrap().push(tx.clone());
        Some((tx, rx))
    }

    /// The live PTY grid.
    pub fn size(&self) -> (u16, u16) {
        *self.size.lock().unwrap()
    }

    /// Record the grid an end would like, without claiming ownership. Lets a
    /// watching viewer keep its preference ready for the moment it does claim.
    pub fn note_grid(&self, who: SizeOwner, cols: u16, rows: u16) {
        if cols < 2 || rows < 2 {
            return;
        }
        let slot = match who {
            SizeOwner::Desktop => &self.desktop_grid,
            SizeOwner::Web => &self.web_grid,
        };
        *slot.lock().unwrap() = Some((cols, rows));
    }

    /// Ask for a grid on behalf of one end.
    ///
    /// Only the owner can move the live grid; anyone else just records what it
    /// would like, ready for the moment it does take over. This is the path
    /// every non-keystroke trigger uses: attaching, window focus, tab switches
    /// and container refits.
    pub fn request_grid(&self, who: SizeOwner, cols: u16, rows: u16) -> Option<(u16, u16)> {
        self.note_grid(who, cols, rows);
        if self.owner.lock().unwrap().0 != who {
            return None;
        }
        self.apply_grid(cols, rows)
    }

    /// Take ownership on a keystroke and switch to that end's recorded grid.
    ///
    /// Returns the new grid only when the PTY was actually resized, so callers
    /// broadcast exactly once per real change. Returns None when that end
    /// already owned the session at that size, when the cooldown has not
    /// elapsed, or when it never recorded a grid.
    pub fn claim(&self, who: SizeOwner) -> Option<(u16, u16)> {
        let slot = match who {
            SizeOwner::Desktop => &self.desktop_grid,
            SizeOwner::Web => &self.web_grid,
        };
        let (cols, rows) = (*slot.lock().unwrap())?;
        {
            let mut owner = self.owner.lock().unwrap();
            if owner.0 != who {
                if owner.1.elapsed() < OWNER_COOLDOWN {
                    return None;
                }
                *owner = (who, Instant::now());
            }
        }
        self.apply_grid(cols, rows)
    }

    /// The phone attaches at its own fixed grid and takes the PTY grid for it.
    /// Deliberate and one-shot (a page load), so it bypasses the ownership
    /// cooldown; the desktop reclaims on its next keystroke.
    pub fn web_take_grid(&self, cols: u16, rows: u16) -> Option<(u16, u16)> {
        if cols < 2 || rows < 2 {
            return None;
        }
        *self.web_grid.lock().unwrap() = Some((cols, rows));
        {
            let mut owner = self.owner.lock().unwrap();
            *owner = (SizeOwner::Web, Instant::now());
        }
        self.apply_grid(cols, rows)
    }

    /// Force a SIGWINCH without changing the session's grid.
    ///
    /// Linux only signals when the winsize ioctl actually changes, so this
    /// bumps a row and puts it straight back. It deliberately skips the size
    /// mirror, the ownership bookkeeping and the viewer broadcast: the grid
    /// ends exactly where it started, and telling attached phones about the
    /// transient made them re-grid twice on every renderer-slot rebind, which
    /// is constant while a full-screen TUI is running.
    pub fn kick_grid(&self, cols: u16, rows: u16) {
        if cols < 2 || rows < 2 || self.exited.load(Ordering::Acquire) {
            return;
        }
        let Ok(master) = self.master.lock() else {
            return;
        };
        let at = |r: u16| PtySize {
            rows: r,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        };
        let _ = master.resize(at(rows.saturating_add(1)));
        let _ = master.resize(at(rows));
    }

    /// Resize the PTY and tell every attached viewer. Returns None when the
    /// grid was already the live one, so callers broadcast only real changes.
    fn apply_grid(&self, cols: u16, rows: u16) -> Option<(u16, u16)> {
        if cols < 2 || rows < 2 || self.exited.load(Ordering::Acquire) {
            return None;
        }
        let mut size = self.size.lock().unwrap();
        if *size == (cols, rows) {
            return None;
        }
        self.master
            .lock()
            .unwrap()
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .ok()?;
        *size = (cols, rows);
        drop(size);
        self.web_subs
            .lock()
            .unwrap()
            .retain(|s| s.try_send(WebMsg::Resized(cols, rows)).is_ok());
        Some((cols, rows))
    }

    /// Remove one specific subscriber (not the whole table, so other viewers
    /// of the same session are never affected).
    pub fn web_unsubscribe(&self, tx: &SyncSender<WebMsg>) {
        self.web_subs.lock().unwrap().retain(|s| !std::ptr::eq(s, tx));
    }

    /// Fan out one output chunk to every attached Web viewer. A viewer whose
    /// queue is full is evicted (its handle_ws sees the channel disconnect and
    /// notifies the page), so a slow phone is told instead of silently
    /// missing output, and one laggy viewer can't accumulate unbounded state.
    fn web_broadcast(&self, chunk: &[u8]) {
        let mut subs = self.web_subs.lock().unwrap();
        subs.retain(|s| s.try_send(WebMsg::Output(chunk.to_vec())).is_ok());
    }

    /// Tell every Web viewer that this session exited (final message). The
    /// page clears its attached state; the caller detaches the WS table
    /// afterwards via handle_ws.
    fn web_broadcast_exit(&self, code: i32) {
        let mut subs = self.web_subs.lock().unwrap();
        for s in subs.drain(..) {
            let _ = s.try_send(WebMsg::Exited(code));
        }
    }
}

struct ChildKillGuard {
    killer: Option<Box<dyn ChildKiller + Send + Sync>>,
}

impl ChildKillGuard {
    fn new(killer: Box<dyn ChildKiller + Send + Sync>) -> Self {
        Self { killer: Some(killer) }
    }

    fn disarm(&mut self) {
        self.killer = None;
    }
}

impl Drop for ChildKillGuard {
    fn drop(&mut self) {
        if let Some(mut k) = self.killer.take() {
            let _ = k.kill();
        }
    }
}

#[allow(clippy::too_many_arguments)]
pub fn spawn(
    id: u32,
    app: AppHandle,
    cols: u16,
    rows: u16,
    cwd: Option<String>,
    workspace: WorkspaceEnv,
    blocks: bool,
    shell: Option<String>,
    control: Option<crate::modules::control::ShellControlEnv>,
    gateway_provider: Option<String>,
    on_data: Option<Box<dyn Fn(Vec<u8>) + Send + Sync>>,
    on_exit: Option<Box<dyn Fn(i32) + Send + Sync>>,
) -> Result<(Arc<Session>, PtySize), String> {
    let on_data = on_data.map(Arc::new);
    let on_exit = on_exit.map(Arc::new);
    #[cfg(windows)]
    let _spawn_guard = CONPTY_LIFECYCLE_LOCK.lock().unwrap();

    let pty_system = native_pty_system();
    let size = PtySize {
        rows,
        cols,
        pixel_width: 0,
        pixel_height: 0,
    };
    let pair = pty_system.openpty(size).map_err(|e| e.to_string())?;

    let cmd =
        shell_init::build_command(cwd.clone(), workspace, blocks, shell, control, gateway_provider)?;
    let mut child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    drop(pair.slave);

    // Kill the child if any of the pipe setup below fails so the spawned shell
    // can't outlive an aborted pty_open.
    let mut guard = ChildKillGuard::new(child.clone_killer());
    let killer = child.clone_killer();
    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer: Arc<Mutex<Box<dyn Write + Send>>> = Arc::new(Mutex::new(
        pair.master.take_writer().map_err(|e| e.to_string())?,
    ));
    guard.disarm();

    let shell_pid = child.process_id().unwrap_or(0);

    #[cfg(windows)]
    let job = match child.process_id() {
        Some(pid) => match crate::modules::proc::job::ProcessJob::create_for(pid) {
            Ok(j) => Some(j),
            Err(e) => {
                log::warn!("pty job-object setup failed for pid={pid}: {e}");
                None
            }
        },
        None => None,
    };

    let exited = Arc::new(AtomicBool::new(false));
    // Shared rather than read off the session: the reader thread that learns
    // the agent's name is spawned after this value is built.
    let agent_name: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));

    let session = Arc::new(Session {
        #[cfg(windows)]
        _job: job,
        shell_pid,
        killer: Mutex::new(killer),
        writer: writer.clone(),
        master: Mutex::new(pair.master),
        exited: exited.clone(),
        cwd,
        agent: agent_name.clone(),
        web_subs: Mutex::new(Vec::new()),
        in_alt: AtomicBool::new(false),
        owner: Mutex::new((SizeOwner::Desktop, Instant::now())),
        size: Mutex::new((cols, rows)),
        desktop_grid: Mutex::new(Some((cols, rows))),
        web_grid: Mutex::new(None),
    });

    let pending: Arc<(Mutex<Vec<u8>>, Condvar)> = Arc::new((
        Mutex::new(Vec::with_capacity(READ_BUF)),
        Condvar::new(),
    ));
    let done = Arc::new(AtomicBool::new(false));
    let spawn_at = Instant::now();

    let first_byte = Arc::new(AtomicBool::new(false));

    let pending_r = pending.clone();
    let writer_for_da = writer.clone();
    let app_reader = app.clone();
    let agent_name_r = agent_name.clone();
    let first_byte_r = first_byte;
    let reader_thread = thread::Builder::new()
        .name("terax-pty-reader".into())
        .spawn(move || {
            let mut buf = [0u8; READ_BUF];
            let mut filtered: Vec<u8> = Vec::with_capacity(READ_BUF);
            let mut da_filter = DaFilter::new();
            let mut agent_detect = AgentDetector::new();
            let mut dropped_bytes: u64 = 0;
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        if !first_byte_r.load(Ordering::Relaxed) {
                            first_byte_r.store(true, Ordering::Release);
                            log::debug!("pty first byte after {}ms", spawn_at.elapsed().as_millis());
                        }
                        agent_detect.process(&buf[..n], |t| {
                            match &t {
                                Transition::Started { agent } => {
                                    *agent_name_r.lock().unwrap() = Some(agent.clone());
                                }
                                Transition::Exited => {
                                    *agent_name_r.lock().unwrap() = None;
                                }
                                _ => {}
                            }
                            let _ = app_reader.emit(AGENT_EVENT, t.into_signal(id));
                        });
                        filtered.clear();
                        da_filter.process(&buf[..n], &mut filtered, |reply| {
                            if let Ok(mut w) = writer_for_da.lock() {
                                let _ = w.write_all(reply);
                            }
                        });
                        if filtered.is_empty() {
                            continue;
                        }
                        let (lock, cv) = &*pending_r;
                        let mut g = lock.lock().unwrap();
                        if g.len() + filtered.len() > MAX_PENDING {
                            dropped_bytes += g.len() as u64;
                            g.clear();
                            g.extend_from_slice(OVERFLOW_NOTICE);
                        }
                        g.extend_from_slice(&filtered);
                        cv.notify_one();
                    }
                    Err(e) => {
                        log::debug!("pty reader ended: {e}");
                        break;
                    }
                }
            }
            agent_detect.finish(|t| {
                let _ = app_reader.emit(AGENT_EVENT, t.into_signal(id));
            });
            pending_r.1.notify_one();
            if dropped_bytes > 0 {
                log::warn!("pty backpressure: dropped {dropped_bytes} bytes (cap {MAX_PENDING})");
            }
        })
        .expect("spawn pty reader thread");

    let on_data_ref = on_data.clone();
    let pending_f = pending.clone();
    let done_f = done.clone();
    let session_f = session.clone();
    // Alternate-screen enter/leave (opencode / claude / vim). Tracked so a
    // phone can parse the backlog in the right buffer mode.
    const ENTER_ALT: &[u8] = b"\x1b[?1049h";
    const LEAVE_ALT: &[u8] = b"\x1b[?1049l";
    thread::Builder::new()
        .name("terax-pty-flusher".into())
        .spawn(move || {
            let (lock, cv) = &*pending_f;
            // Tail of the previous chunk, so a mode-switch sequence split
            // across chunk boundaries is still detected.
            let mut mode_carry: Vec<u8> = Vec::new();
            loop {
                {
                    let mut g = lock.lock().unwrap();
                    while g.is_empty() {
                        if done_f.load(Ordering::Acquire) {
                            return;
                        }
                        let (next, _) = cv.wait_timeout(g, FLUSH_MAX_IDLE).unwrap();
                        g = next;
                    }
                }
                // Coalesce a short window so a burst flushes as one chunk.
                thread::sleep(FLUSH_COALESCE);
                let chunk = std::mem::take(&mut *lock.lock().unwrap());
                if chunk.is_empty() {
                    continue;
                }
                // Track alternate-screen mode transitions in this chunk. Both
                // patterns are scanned left to right, so the last transition
                // in the window wins.
                let mut mode: Option<bool> = None;
                {
                    let mut window: Vec<u8> =
                        Vec::with_capacity(mode_carry.len() + chunk.len());
                    window.extend_from_slice(&mode_carry);
                    window.extend_from_slice(&chunk);
                    for w in window.windows(ENTER_ALT.len()) {
                        if w == ENTER_ALT {
                            mode = Some(true);
                        } else if w == LEAVE_ALT {
                            mode = Some(false);
                        }
                    }
                }
                if let Some(m) = mode {
                    session_f.in_alt.store(m, Ordering::Release);
                }
                mode_carry =
                    chunk[chunk.len().saturating_sub(ENTER_ALT.len() - 1)..].to_vec();
                if let Some(cb) = &on_data_ref {
                    cb(chunk.clone());
                }
                // Fan the chunk out to currently attached Web viewers.
                session_f.web_broadcast(&chunk);
            }
        })
        .expect("spawn pty flusher thread");

    let on_data_exit = on_data;
    let on_exit_cb = on_exit;
    let pending_e = pending;
    let done_e = done;
    let app_waiter = app;
    let exited_w = exited;
    let session_exit_f = session.clone();
    thread::Builder::new()
        .name("terax-pty-waiter".into())
        .spawn(move || {
            let code = match child.wait() {
                Ok(status) => status.exit_code() as i32,
                Err(e) => {
                    log::warn!("pty child wait failed: {e}");
                    -1
                }
            };
            exited_w.store(true, Ordering::Release);
            // Wait for the reader to hit EOF before taking a final snapshot of
            // `pending`, so the last line of output never races the Exit event.
            // On Windows the reader cannot be joined (it is not the thread that
            // owns the master handle), so poll it with a generous deadline
            // instead of a fixed short sleep (issue #10).
            #[cfg(windows)]
            {
                let deadline = Instant::now() + Duration::from_millis(2000);
                while Instant::now() < deadline && !reader_thread.is_finished() {
                    thread::sleep(Duration::from_millis(5));
                }
            }
            #[cfg(not(windows))]
            if let Err(e) = reader_thread.join() {
                log::error!("pty reader thread panicked: {e:?}");
            }
            let (lock, cv) = &*pending_e;
            let tail = std::mem::take(&mut *lock.lock().unwrap());
            if !tail.is_empty() {
                // The tail is the last output before exit. Both the desktop
                // channel and attached Web viewers get it, so a phone attached
                // at exit time sees the final lines (issue #5).
                session_exit_f.web_broadcast(&tail);
                if let Some(cb) = &on_data_exit {
                    cb(tail);
                }
            }
            done_e.store(true, Ordering::Release);
            cv.notify_all();
            // Final word to attached Web viewers before the session is reaped:
            // they clear their attached state immediately instead of waiting
            // for a reconnect.
            session_exit_f.web_broadcast_exit(code);
            if let Some(cb) = &on_exit_cb {
                cb(code);
            }
            if let Some(state) = app_waiter.try_state::<super::PtyState>() {
                if let Some(s) = state.take(id) {
                    drop_session(s);
                }
            }
        })
        .expect("spawn pty waiter thread");

    Ok((session, size))
}

