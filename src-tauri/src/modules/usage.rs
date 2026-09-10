//! What Claude Code says is left of the subscription's limits.
//!
//! The numbers are not on disk. They arrive in API response headers and Claude
//! Code keeps them in memory, surfacing them through `/usage` and through the
//! JSON it pipes to a statusLine command. Nothing under `~/.claude` holds them:
//! the transcripts record tokens spent, which is a different quantity from
//! percent of a plan window consumed.
//!
//! So this asks Claude Code, by running `claude -p "/usage"`.
//!
//! Two consequences shape everything here. Asking costs a request against the
//! very limit being reported, so a poll would be self defeating and the result
//! is cached with a floor on how often it can be refetched. And the answer is
//! prose meant for a human, not JSON, so parsing is best effort and the raw
//! text is always kept: when Claude Code rewords something, the panel still has
//! the authoritative answer to show.

use std::process::Stdio;
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use shared_child::SharedChild;

use crate::modules::workspace::WorkspaceEnv;

/// How long a fetched answer stands before another `claude -p` is allowed.
/// Limits move slowly and every check spends one request.
const MIN_REFETCH: Duration = Duration::from_secs(600);
const TIMEOUT: Duration = Duration::from_secs(60);
const MAX_OUTPUT_BYTES: usize = 64 * 1024;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageWindow {
    /// `session` for the rolling 5 hour window, or the parenthetical from a
    /// weekly line such as `all models` / `Opus`.
    pub label: String,
    pub percent: Option<u32>,
    /// When the window rolls over, exactly as Claude Code worded it.
    pub resets: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Usage {
    /// The rolling 5 hour window.
    pub session: Option<UsageWindow>,
    /// Weekly windows. A plan can report more than one, such as an overall
    /// figure plus a separate Opus allowance.
    pub weeks: Vec<UsageWindow>,
    /// Everything Claude Code printed, so the panel can show what was not
    /// parsed rather than pretend it does not exist.
    pub raw: String,
    /// Unix seconds this answer was fetched.
    pub fetched_at: i64,
    /// Set when the fetch itself failed. `raw` then holds whatever came out.
    pub error: Option<String>,
}

fn now_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn cache() -> &'static Mutex<Option<(Usage, Instant)>> {
    static CACHE: std::sync::OnceLock<Mutex<Option<(Usage, Instant)>>> = std::sync::OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(None))
}

/// Read a percentage out of `... 73% used ...`.
fn percent_before_used(text: &str) -> Option<u32> {
    let cut = text.find("% used")?;
    let digits: String = text[..cut]
        .chars()
        .rev()
        .take_while(char::is_ascii_digit)
        .collect();
    digits.chars().rev().collect::<String>().parse().ok()
}

/// Read the reset phrase out of `... resets Sep 7, 4:30pm (Asia/Shanghai)`.
fn resets_after(text: &str) -> Option<String> {
    let start = text.find("resets ")? + "resets ".len();
    let value = text[start..].trim();
    (!value.is_empty()).then(|| value.to_string())
}

/// Pull `all models` out of `Current week (all models): ...`.
fn parenthetical(text: &str) -> Option<String> {
    let open = text.find('(')?;
    let close = text[open..].find(')')? + open;
    let value = text[open + 1..close].trim();
    (!value.is_empty()).then(|| value.to_string())
}

/// Best effort read of the `/usage` output.
///
/// Only the two shapes that carry a limit are matched, and anything else is
/// left to `raw`. Matching loosely on the leading words rather than the whole
/// line means a reworded suffix does not lose the number.
pub fn parse(raw: &str) -> (Option<UsageWindow>, Vec<UsageWindow>) {
    let mut session = None;
    let mut weeks = Vec::new();
    for line in raw.lines() {
        let line = line.trim();
        let lower = line.to_ascii_lowercase();
        if lower.starts_with("current session") {
            session = Some(UsageWindow {
                label: "session".to_string(),
                percent: percent_before_used(line),
                resets: resets_after(line),
            });
        } else if lower.starts_with("current week") {
            weeks.push(UsageWindow {
                label: parenthetical(line).unwrap_or_else(|| "week".to_string()),
                percent: percent_before_used(line),
                resets: resets_after(line),
            });
        }
    }
    (session, weeks)
}

fn drain<R: std::io::Read>(reader: &mut R) -> Vec<u8> {
    let mut out = Vec::new();
    let mut buf = [0u8; 8192];
    while let Ok(read) = reader.read(&mut buf) {
        if read == 0 {
            break;
        }
        if out.len() < MAX_OUTPUT_BYTES {
            let take = (MAX_OUTPUT_BYTES - out.len()).min(read);
            out.extend_from_slice(&buf[..take]);
        }
    }
    out
}

fn fetch() -> Usage {
    // Quoted so the shell hands `/usage` over as one argument. Git Bash would
    // otherwise translate a leading slash into a Windows path, which is exactly
    // how this gets mistaken for a missing feature.
    let command = "claude -p \"/usage\"";
    let mut cmd = match crate::modules::shell::build_oneshot_command(
        command,
        &WorkspaceEnv::Local,
        None,
    ) {
        Ok(cmd) => cmd,
        Err(message) => {
            return Usage {
                fetched_at: now_secs(),
                error: Some(message),
                ..Usage::default()
            }
        }
    };
    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    crate::modules::proc::hide_console(&mut cmd);

    let child = match SharedChild::spawn(&mut cmd) {
        Ok(child) => Arc::new(child),
        Err(e) => {
            return Usage {
                fetched_at: now_secs(),
                error: Some(format!("无法启动 claude：{e}")),
                ..Usage::default()
            }
        }
    };
    let stdout = child.take_stdout();
    let stderr = child.take_stderr();
    let out_handle = thread::spawn(move || stdout.map(|mut p| drain(&mut p)).unwrap_or_default());
    let err_handle = thread::spawn(move || stderr.map(|mut p| drain(&mut p)).unwrap_or_default());

    let (tx, rx) = mpsc::channel();
    let waiter = Arc::clone(&child);
    thread::spawn(move || {
        let _ = tx.send(waiter.wait());
    });
    let timed_out = match rx.recv_timeout(TIMEOUT) {
        Ok(_) => false,
        Err(_) => {
            let _ = child.kill();
            let _ = child.wait();
            true
        }
    };

    let raw = String::from_utf8_lossy(&out_handle.join().unwrap_or_default()).into_owned();
    let stderr = String::from_utf8_lossy(&err_handle.join().unwrap_or_default()).into_owned();
    let (session, weeks) = parse(&raw);
    let error = if timed_out {
        Some("查询超时".to_string())
    } else if session.is_none() && weeks.is_empty() {
        // Nothing recognizable came back. Prefer the tool's own complaint.
        Some(match stderr.trim() {
            "" => "未能从 claude 的输出中解析出用量".to_string(),
            message => message.chars().take(300).collect(),
        })
    } else {
        None
    };
    Usage {
        session,
        weeks,
        raw: if raw.trim().is_empty() { stderr } else { raw },
        fetched_at: now_secs(),
        error,
    }
}

/// Tauri command: the subscription's current limit usage.
///
/// `force` bypasses the refetch floor for an explicit refresh. Without it a
/// cached answer younger than `MIN_REFETCH` is returned untouched, because
/// every fetch spends a request against the limit it reports.
#[tauri::command]
pub async fn claude_usage(force: Option<bool>) -> Usage {
    let force = force.unwrap_or(false);
    if !force {
        if let Some((usage, at)) = cache().lock().expect("usage cache").as_ref() {
            if at.elapsed() < MIN_REFETCH {
                return usage.clone();
            }
        }
    }
    let usage = tauri::async_runtime::spawn_blocking(fetch)
        .await
        .unwrap_or_else(|e| Usage {
            fetched_at: now_secs(),
            error: Some(format!("查询任务失败：{e}")),
            ..Usage::default()
        });
    // A failure is not worth caching: the next open should try again rather
    // than show the same error for ten minutes.
    if usage.error.is_none() {
        *cache().lock().expect("usage cache") = Some((usage.clone(), Instant::now()));
    }
    usage
}

/// The cached answer without ever spawning anything, for first paint.
#[tauri::command]
pub fn claude_usage_cached() -> Option<Usage> {
    cache()
        .lock()
        .expect("usage cache")
        .as_ref()
        .map(|(usage, _)| usage.clone())
}
