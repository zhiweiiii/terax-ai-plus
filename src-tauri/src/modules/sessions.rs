//! Past agent conversations for a directory, so one can be picked and resumed.
//!
//! Both agents ship a picker of their own (`claude --resume`, `codex resume`),
//! but both are interactive TUIs: driving one to harvest a list would mean
//! spawning a process and scraping a screen. They read files to build that
//! list, so this reads the same files.
//!
//! - `claude` - `~/.claude/projects/<escaped cwd>/<session>.jsonl`. The
//!   directory already scopes the list to one cwd.
//! - `codex` - `~/.codex/sessions/<y>/<m>/<d>/rollout-*.jsonl`. Laid out by
//!   date rather than by directory, so the cwd comes out of each file.
//!
//! Nothing here parses a whole transcript. Rollouts reach 90 MB and a listing
//! only needs a title and a timestamp, both of which live near the top, so each
//! file is read up to `HEAD_BYTES` and no further.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use serde::Serialize;
use serde_json::Value;

/// Enough to reach Claude's `ai-title`, which trails the first exchange rather
/// than heading the file. Codex puts everything needed on line one.
const HEAD_BYTES: usize = 192 * 1024;
/// A listing is for picking up recent work, not for browsing an archive.
const MAX_PER_AGENT: usize = 40;
const TITLE_MAX_CHARS: usize = 80;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    /// `claude` or `codex`. Decides which resume command the UI offers.
    pub agent: &'static str,
    /// What the agent's own resume takes.
    pub id: String,
    /// Best available description: the agent's own title, else the opening ask.
    pub title: String,
    /// Last write, unix seconds. What the list is ordered by.
    pub updated_at: i64,
}

fn modified_secs(path: &Path) -> i64 {
    path.metadata()
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// Read at most the first `HEAD_BYTES`, dropping a trailing partial line so the
/// caller only ever sees whole records.
fn read_head(path: &Path) -> Option<String> {
    use std::io::Read;
    let mut file = fs::File::open(path).ok()?;
    let mut buf = vec![0u8; HEAD_BYTES];
    let mut filled = 0usize;
    while filled < buf.len() {
        match file.read(&mut buf[filled..]) {
            Ok(0) => break,
            Ok(n) => filled += n,
            Err(_) => break,
        }
    }
    buf.truncate(filled);
    let text = String::from_utf8_lossy(&buf).into_owned();
    match text.rfind('\n') {
        Some(end) => Some(text[..end].to_string()),
        None => Some(text),
    }
}

fn tidy(text: &str) -> String {
    let flat = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if flat.chars().count() <= TITLE_MAX_CHARS {
        return flat;
    }
    let cut: String = flat.chars().take(TITLE_MAX_CHARS).collect();
    format!("{cut}...")
}

/// Whether a "user" message is something the user actually typed.
///
/// Both agents open a session by injecting context as a user turn: Codex sends
/// `<environment_context>`, Claude Code sends slash-command wrappers and
/// reminders, and either may lead with the project's instructions file. They are
/// all XML-ish or a markdown heading, and neither is what the conversation was
/// about, so titling a session with one is worse than saying nothing.
fn is_boilerplate(text: &str) -> bool {
    let head = text.trim_start();
    head.starts_with('<')
        || head.starts_with("Caveat:")
        || head.starts_with("# AGENTS.md")
        || head.starts_with("# CLAUDE.md")
}

/// Text out of a message body that is either a plain string or the block array
/// an agent uses once a turn carries attachments.
fn message_text(content: &Value) -> Option<String> {
    if let Some(text) = content.as_str() {
        return Some(text.to_string());
    }
    let joined = content
        .as_array()?
        .iter()
        .filter_map(|part| {
            part.get("text")
                .and_then(Value::as_str)
                .or_else(|| part.as_str())
        })
        .collect::<Vec<_>>()
        .join(" ");
    (!joined.trim().is_empty()).then_some(joined)
}

fn claude_sessions(cwd: &str) -> Vec<Session> {
    let Some(dir) = crate::modules::transcript::claude_project_dir(cwd) else {
        return Vec::new();
    };
    let Ok(entries) = fs::read_dir(&dir) else {
        return Vec::new();
    };
    let mut files: Vec<(i64, PathBuf)> = entries
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| path.extension().and_then(|e| e.to_str()) == Some("jsonl"))
        .map(|path| (modified_secs(&path), path))
        .collect();
    files.sort_by(|a, b| b.0.cmp(&a.0));
    files.truncate(MAX_PER_AGENT);

    files
        .into_iter()
        .filter_map(|(updated_at, path)| {
            let id = path.file_stem()?.to_string_lossy().into_owned();
            let head = read_head(&path)?;
            let mut title = None;
            let mut first_ask = None;
            for line in head.lines() {
                let Ok(value) = serde_json::from_str::<Value>(line) else {
                    continue;
                };
                match value.get("type").and_then(Value::as_str) {
                    Some("ai-title") => {
                        title = value
                            .get("aiTitle")
                            .and_then(Value::as_str)
                            .map(tidy)
                            .filter(|t| !t.is_empty());
                        // The agent's own title beats anything derived.
                        break;
                    }
                    Some("user") if first_ask.is_none() => {
                        first_ask = value
                            .pointer("/message/content")
                            .and_then(message_text)
                            .filter(|text| !is_boilerplate(text))
                            .map(|text| tidy(&text));
                    }
                    _ => {}
                }
            }
            Some(Session {
                agent: "claude",
                title: title
                    .or(first_ask)
                    .unwrap_or_else(|| "(无标题会话)".to_string()),
                id,
                updated_at,
            })
        })
        .collect()
}

fn codex_rollouts(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            codex_rollouts(&path, out);
        } else if path.extension().and_then(|e| e.to_str()) == Some("jsonl") {
            out.push(path);
        }
    }
}

fn codex_sessions(cwd: &str) -> Vec<Session> {
    let Some(home) = dirs::home_dir() else {
        return Vec::new();
    };
    let root = home.join(".codex").join("sessions");
    if !root.is_dir() {
        return Vec::new();
    }
    let mut files = Vec::new();
    codex_rollouts(&root, &mut files);
    let mut dated: Vec<(i64, PathBuf)> = files
        .into_iter()
        .map(|path| (modified_secs(&path), path))
        .collect();
    // Date folders say when a session started, not when it was last touched, so
    // order by mtime and only then stop looking.
    dated.sort_by(|a, b| b.0.cmp(&a.0));

    let mut sessions = Vec::new();
    for (updated_at, path) in dated {
        if sessions.len() >= MAX_PER_AGENT {
            break;
        }
        let Some(head) = read_head(&path) else {
            continue;
        };
        let mut lines = head.lines();
        // Line one is `session_meta`, carrying the id and the directory. A file
        // that does not start with it is not a rollout this build understands.
        let Some(meta) = lines
            .next()
            .and_then(|line| serde_json::from_str::<Value>(line).ok())
            .filter(|value| value.get("type").and_then(Value::as_str) == Some("session_meta"))
        else {
            continue;
        };
        let payload = meta.get("payload").unwrap_or(&meta);
        let Some(session_cwd) = payload.get("cwd").and_then(Value::as_str) else {
            continue;
        };
        if !crate::modules::transcript::same_dir(session_cwd, cwd) {
            continue;
        }
        let Some(id) = payload
            .get("session_id")
            .or_else(|| payload.get("id"))
            .and_then(Value::as_str)
        else {
            continue;
        };
        let title = lines
            .find_map(codex_user_text)
            .map(|text| tidy(&text))
            .filter(|text| !text.is_empty())
            .unwrap_or_else(|| "(无标题会话)".to_string());
        sessions.push(Session {
            agent: "codex",
            id: id.to_string(),
            title,
            updated_at,
        });
    }
    sessions
}

/// The first thing the user actually asked, out of a rollout line.
fn codex_user_text(line: &str) -> Option<String> {
    let value = serde_json::from_str::<Value>(line).ok()?;
    let payload = value.get("payload").unwrap_or(&value);
    if payload.get("role").and_then(Value::as_str) != Some("user") {
        return None;
    }
    message_text(payload.get("content")?).filter(|text| !is_boilerplate(text))
}

/// Tauri command: both agents' past sessions for one directory, newest first.
///
/// Async so the reads stay off the main thread. Each file costs one bounded
/// head read, so the whole listing is a few hundred KB however large the
/// transcripts have grown.
#[tauri::command]
pub async fn agent_sessions(cwd: String) -> Vec<Session> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut all = claude_sessions(&cwd);
        all.extend(codex_sessions(&cwd));
        all.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
        all
    })
    .await
    .unwrap_or_default()
}
