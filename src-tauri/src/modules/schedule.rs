//! Commands queued to run later.
//!
//! The timer lives here rather than in a page, and that is the whole design.
//! A phone that scheduled something locks its screen; a browser tab that is
//! closed takes its timers with it. The desktop process is the only thing
//! still running when the moment arrives, so it is the only honest place to
//! keep the clock. Both clients do nothing but ask this module to remember
//! something and read back what it remembers.
//!
//! Jobs are held in memory only. That is not a shortcut: a job names a
//! terminal, and no terminal survives a restart of the app, so a job restored
//! into a process with no session to run it in would be a promise this module
//! could not keep.

use std::io::Write;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::{Emitter, Manager};

use super::pty::PtyState;

/// Emitted whenever the list changes, so the desktop refreshes without polling.
pub const SCHEDULE_EVENT: &str = "terax:schedules";

/// Carriage return - what pressing Enter sends to a PTY.
const ENTER: u8 = 13;

/// How long a due job keeps trying before it is given up on.
///
/// A cold terminal tab has no pty until the frontend opens one, and asking for
/// it is asynchronous (see `web_leaf_session`, which emits an activation
/// request and returns nothing this time round). Retrying across a few ticks
/// is what lets a job fire into a tab the user has not touched since launch;
/// retrying forever would leave a job for a tab that is gone queued for the
/// life of the process.
const RETRY_WINDOW: Duration = Duration::from_secs(60);

/// The longest a command may be queued for. Two days is far past the point
/// where the terminal it names still exists.
const MAX_DELAY: Duration = Duration::from_secs(48 * 60 * 60);

#[derive(Serialize, Clone, Debug)]
pub struct Job {
    pub id: u64,
    /// The desktop leaf (terminal tab) this runs in.
    ///
    /// Bound to the leaf, not to the live pty id: a session that respawns
    /// keeps its leaf, and it is the id both clients already use to name a
    /// terminal - the phone attaches by leaf, the desktop syncs tabs by leaf.
    pub leaf_id: u32,
    pub command: String,
    /// Epoch milliseconds.
    pub fire_at: i64,
    pub created_at: i64,
}

#[derive(Default)]
pub struct ScheduleState {
    jobs: Mutex<Vec<Job>>,
    next_id: AtomicU64,
    /// Bumped on every change. A poller compares this instead of diffing the
    /// list, so an unchanged queue costs one atomic read.
    revision: AtomicU64,
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

impl ScheduleState {
    pub fn revision(&self) -> u64 {
        self.revision.load(Ordering::Relaxed)
    }

    pub fn list(&self) -> Vec<Job> {
        let mut jobs = self.jobs.lock().unwrap().clone();
        jobs.sort_by_key(|j| j.fire_at);
        jobs
    }

    pub fn add(&self, leaf_id: u32, command: String, delay: Duration) -> Result<Job, String> {
        let command = command.trim().to_string();
        if command.is_empty() {
            return Err("empty command".into());
        }
        if delay > MAX_DELAY {
            return Err("delay too long".into());
        }
        let now = now_ms();
        let job = Job {
            id: self.next_id.fetch_add(1, Ordering::Relaxed) + 1,
            leaf_id,
            command,
            fire_at: now + delay.as_millis() as i64,
            created_at: now,
        };
        self.jobs.lock().unwrap().push(job.clone());
        self.revision.fetch_add(1, Ordering::Relaxed);
        Ok(job)
    }

    pub fn cancel(&self, id: u64) -> bool {
        let mut jobs = self.jobs.lock().unwrap();
        let before = jobs.len();
        jobs.retain(|j| j.id != id);
        let removed = jobs.len() != before;
        drop(jobs);
        if removed {
            self.revision.fetch_add(1, Ordering::Relaxed);
        }
        removed
    }

    /// Drop every job for a terminal that has gone away.
    pub fn forget_leaf(&self, leaf_id: u32) {
        let mut jobs = self.jobs.lock().unwrap();
        let before = jobs.len();
        jobs.retain(|j| j.leaf_id != leaf_id);
        let removed = jobs.len() != before;
        drop(jobs);
        if removed {
            self.revision.fetch_add(1, Ordering::Relaxed);
        }
    }

    /// Jobs whose moment has come, without removing them: a job is only taken
    /// off the queue once it has actually been written to a terminal, or once
    /// it has spent its retry window failing to find one.
    fn due(&self, now: i64) -> Vec<Job> {
        self.jobs
            .lock()
            .unwrap()
            .iter()
            .filter(|j| j.fire_at <= now)
            .cloned()
            .collect()
    }

    fn remove(&self, id: u64) {
        self.cancel(id);
    }
}

/// Write a job's command into its terminal, as if it had been typed there.
fn deliver(app: &tauri::AppHandle, job: &Job) -> Result<(), String> {
    let state = app.state::<PtyState>();
    // Resolving a leaf that has never been opened emits an activation request
    // and returns nothing; the next tick finds the pty the frontend spawned.
    let session = state
        .web_leaf_session(job.leaf_id, app)
        .ok_or_else(|| "terminal not open yet".to_string())?;
    let mut writer = session
        .writer
        .lock()
        .map_err(|_| "writer poisoned".to_string())?;
    writer
        .write_all(job.command.as_bytes())
        .map_err(|e| e.to_string())?;
    writer.write_all(&[ENTER]).map_err(|e| e.to_string())?;
    writer.flush().map_err(|e| e.to_string())?;
    Ok(())
}

/// Start the one-second tick that fires due jobs.
///
/// Deliberately its own thread rather than work folded into an existing loop:
/// the web connection loop is what forwards terminal output, and anything
/// blocking in there stalls the stream for every viewer.
pub fn start(app: tauri::AppHandle) {
    std::thread::spawn(move || {
        loop {
            std::thread::sleep(Duration::from_secs(1));
            let state = app.state::<ScheduleState>();
            let now = now_ms();
            let due = state.due(now);
            if due.is_empty() {
                continue;
            }
            let mut changed = false;
            for job in due {
                match deliver(&app, &job) {
                    Ok(()) => {
                        log::info!(
                            "schedule: ran job {} on leaf {}: {}",
                            job.id,
                            job.leaf_id,
                            job.command
                        );
                        state.remove(job.id);
                        changed = true;
                    }
                    Err(reason) => {
                        let waited = Duration::from_millis((now - job.fire_at).max(0) as u64);
                        if waited > RETRY_WINDOW {
                            log::warn!(
                                "schedule: giving up on job {} for leaf {} ({reason})",
                                job.id,
                                job.leaf_id
                            );
                            state.remove(job.id);
                            changed = true;
                        }
                    }
                }
            }
            if changed {
                let _ = app.emit(SCHEDULE_EVENT, state.list());
            }
        }
    });
}

#[tauri::command]
pub fn schedule_add(
    state: tauri::State<ScheduleState>,
    app: tauri::AppHandle,
    leaf_id: u32,
    command: String,
    delay_seconds: u64,
) -> Result<Job, String> {
    let job = state.add(leaf_id, command, Duration::from_secs(delay_seconds))?;
    let _ = app.emit(SCHEDULE_EVENT, state.list());
    Ok(job)
}

#[tauri::command]
pub fn schedule_list(state: tauri::State<ScheduleState>) -> Vec<Job> {
    state.list()
}

#[tauri::command]
pub fn schedule_cancel(
    state: tauri::State<ScheduleState>,
    app: tauri::AppHandle,
    id: u64,
) -> bool {
    let removed = state.cancel(id);
    if removed {
        let _ = app.emit(SCHEDULE_EVENT, state.list());
    }
    removed
}

#[cfg(test)]
mod tests {
    use super::*;

    fn state() -> ScheduleState {
        ScheduleState::default()
    }

    #[test]
    fn a_job_is_queued_and_listed_by_when_it_fires() {
        let s = state();
        s.add(1, "late".into(), Duration::from_secs(600)).unwrap();
        s.add(1, "soon".into(), Duration::from_secs(60)).unwrap();
        let jobs = s.list();
        assert_eq!(jobs.len(), 2);
        assert_eq!(jobs[0].command, "soon", "the next one to run leads");
        assert!(jobs[0].fire_at < jobs[1].fire_at);
    }

    #[test]
    fn ids_are_unique_and_cancelling_takes_only_that_job() {
        let s = state();
        let a = s.add(1, "a".into(), Duration::from_secs(60)).unwrap();
        let b = s.add(1, "b".into(), Duration::from_secs(60)).unwrap();
        assert_ne!(a.id, b.id);
        assert!(s.cancel(a.id));
        assert!(!s.cancel(a.id), "cancelling twice is not a second removal");
        let left = s.list();
        assert_eq!(left.len(), 1);
        assert_eq!(left[0].id, b.id);
    }

    #[test]
    fn an_empty_command_is_refused() {
        let s = state();
        assert!(s.add(1, "   ".into(), Duration::from_secs(60)).is_err());
        assert!(s.list().is_empty());
    }

    #[test]
    fn a_delay_past_the_ceiling_is_refused() {
        let s = state();
        assert!(s.add(1, "x".into(), MAX_DELAY + Duration::from_secs(1)).is_err());
    }

    /// Only jobs whose moment has passed come back, and `due` leaves them on
    /// the queue: a job is removed once it has actually reached a terminal, so
    /// a cold tab gets retried instead of silently dropped.
    #[test]
    fn due_returns_only_ripe_jobs_and_does_not_consume_them() {
        let s = state();
        s.add(1, "now".into(), Duration::from_secs(0)).unwrap();
        s.add(1, "later".into(), Duration::from_secs(3600)).unwrap();
        let now = now_ms();
        let due = s.due(now);
        assert_eq!(due.len(), 1);
        assert_eq!(due[0].command, "now");
        assert_eq!(s.list().len(), 2, "due must not remove anything");
        assert_eq!(s.due(now).len(), 1, "so a retry still finds it");
    }

    #[test]
    fn a_closed_terminal_takes_its_jobs_with_it() {
        let s = state();
        s.add(1, "keep".into(), Duration::from_secs(60)).unwrap();
        s.add(2, "drop".into(), Duration::from_secs(60)).unwrap();
        s.forget_leaf(2);
        let left = s.list();
        assert_eq!(left.len(), 1);
        assert_eq!(left[0].command, "keep");
    }

    #[test]
    fn the_revision_moves_on_every_change_and_only_then() {
        let s = state();
        let start = s.revision();
        let job = s.add(1, "x".into(), Duration::from_secs(60)).unwrap();
        assert!(s.revision() > start);
        let after_add = s.revision();
        assert!(s.add(1, "".into(), Duration::from_secs(60)).is_err());
        assert_eq!(s.revision(), after_add, "a refused add is not a change");
        s.cancel(job.id);
        assert!(s.revision() > after_add);
        let after_cancel = s.revision();
        s.cancel(job.id);
        assert_eq!(s.revision(), after_cancel, "cancelling nothing is not a change");
    }
}
