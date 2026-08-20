//! Claude Code writes one JSONL per session under
//! `~/.claude/projects/<escaped cwd>/<session-uuid>.jsonl`, appended as the
//! session runs.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use serde_json::Value;

use super::{merge_assistant_steps, same_dir, Message, Transcript, Working};

/// Only look at directories touched this recently when the escaped-name guess
/// misses and we have to search. A project nobody has used today cannot be the
/// session running in front of us.
const SEARCH_MAX_AGE_SECS: u64 = 24 * 60 * 60;

pub fn read(cwd: &str) -> Option<Transcript> {
    let dir = project_dir(cwd)?;
    let file = newest_transcript(&dir)?;
    parse(&file)
}

/// Cheap change signal: when this session's transcript was last appended to.
/// A poll compares it and only re-reads the file when it moved, so watching an
/// idle agent costs a stat rather than a parse of the whole conversation.
pub fn changed_at(cwd: &str) -> Option<i64> {
    let file = newest_transcript(&project_dir(cwd)?)?;
    let modified = file.metadata().ok()?.modified().ok()?;
    Some(modified.duration_since(std::time::UNIX_EPOCH).ok()?.as_millis() as i64)
}

/// Resolved project directories, keyed by cwd. The fallback search reads a
/// line out of every recently used project, which is far too much work to
/// repeat on a poll.
fn dir_cache() -> &'static Mutex<HashMap<String, PathBuf>> {
    static CACHE: OnceLock<Mutex<HashMap<String, PathBuf>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn projects_root() -> Option<PathBuf> {
    let home = dirs::home_dir()?;
    let root = home.join(".claude").join("projects");
    root.is_dir().then_some(root)
}

/// Claude derives the directory name from the cwd by replacing everything that
/// is not alphanumeric with a dash. That is reproduced for the fast path, but
/// it is not treated as the contract: the mapping is lossy (two paths can
/// collide) and non-ASCII paths do not come out the way a naive replacement
/// predicts. When the guess does not exist, recently used directories are read
/// and matched on the `cwd` each line actually carries.
fn project_dir(cwd: &str) -> Option<PathBuf> {
    if let Some(hit) = dir_cache().lock().ok().and_then(|c| c.get(cwd).cloned()) {
        if hit.is_dir() {
            return Some(hit);
        }
    }
    let root = projects_root()?;
    let guess: String = cwd
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect();
    let direct = root.join(&guess);
    let found = if direct.is_dir() {
        direct
    } else {
        search_project_dir(&root, cwd)?
    };
    if let Ok(mut cache) = dir_cache().lock() {
        cache.insert(cwd.to_string(), found.clone());
    }
    Some(found)
}

fn search_project_dir(root: &Path, cwd: &str) -> Option<PathBuf> {
    let now = std::time::SystemTime::now();
    let mut best: Option<(std::time::SystemTime, PathBuf)> = None;
    for entry in fs::read_dir(root).ok()?.flatten() {
        let dir = entry.path();
        if !dir.is_dir() {
            continue;
        }
        let Some(file) = newest_transcript(&dir) else {
            continue;
        };
        let Ok(modified) = file.metadata().and_then(|m| m.modified()) else {
            continue;
        };
        if now
            .duration_since(modified)
            .map(|age| age.as_secs() > SEARCH_MAX_AGE_SECS)
            .unwrap_or(false)
        {
            continue;
        }
        if !transcript_cwd(&file).is_some_and(|found| same_dir(&found, cwd)) {
            continue;
        }
        if best.as_ref().is_none_or(|(at, _)| modified > *at) {
            best = Some((modified, dir));
        }
    }
    best.map(|(_, dir)| dir)
}

/// The cwd a transcript belongs to, from the first line that names one.
fn transcript_cwd(file: &Path) -> Option<String> {
    let text = fs::read_to_string(file).ok()?;
    for line in text.lines().take(64) {
        let Ok(value) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        if let Some(cwd) = value.get("cwd").and_then(Value::as_str) {
            return Some(cwd.to_string());
        }
    }
    None
}

fn newest_transcript(dir: &Path) -> Option<PathBuf> {
    let mut best: Option<(std::time::SystemTime, PathBuf)> = None;
    for entry in fs::read_dir(dir).ok()?.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
            continue;
        }
        let Ok(modified) = entry.metadata().and_then(|m| m.modified()) else {
            continue;
        };
        if best.as_ref().is_none_or(|(at, _)| modified > *at) {
            best = Some((modified, path));
        }
    }
    best.map(|(_, path)| path)
}

fn parse(file: &Path) -> Option<Transcript> {
    let text = fs::read_to_string(file).ok()?;
    let session_id = file.file_stem()?.to_string_lossy().into_owned();

    let mut mode: Option<String> = None;
    let mut permission: Option<String> = None;
    let mut steps: Vec<Message> = Vec::new();
    let mut revision = 0i64;
    // When the current turn started, and whether it is still running.
    //
    // "An assistant entry arrived" is NOT the end of a turn: Claude writes one
    // per model round trip, so a turn that calls three tools writes four of
    // them. Treating the first as the end made the working indicator vanish a
    // second after it appeared, for the whole of a long turn.
    //
    // What actually says "still going" is a tool call with no result yet. Tool
    // results come back as user entries (the ones not typed by a person), so
    // counting calls out and results in tracks the turn exactly.
    let mut turn_started: Option<i64> = None;
    let mut turn_open = false;
    let mut pending_tools: i32 = 0;

    for line in text.lines() {
        let Ok(value) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        match value.get("type").and_then(Value::as_str) {
            Some("mode") => {
                mode = value
                    .get("mode")
                    .and_then(Value::as_str)
                    .map(str::to_string);
            }
            Some("permission-mode") => {
                permission = value
                    .get("permissionMode")
                    .and_then(Value::as_str)
                    .map(str::to_string);
            }
            Some("user") => {
                // Tool results are recorded as user messages too. Only what a
                // person typed is part of the conversation, and the transcript
                // says which is which.
                if value.get("origin").and_then(|o| o.get("kind")).and_then(Value::as_str)
                    != Some("human")
                {
                    pending_tools = (pending_tools - count_blocks(&value, "tool_result")).max(0);
                    continue;
                }
                let at = timestamp(&value);
                revision = revision.max(at);
                turn_started = Some(at);
                turn_open = true;
                steps.push(Message {
                    id: entry_id(&value, steps.len()),
                    role: "user",
                    at,
                    text: user_text(&value),
                    reasoning: None,
                    tools: Vec::new(),
                });
            }
            Some("assistant") => {
                let at = timestamp(&value);
                revision = revision.max(at);
                let (text, reasoning, tools) = assistant_blocks(&value);
                pending_tools += tools.len() as i32;
                // Still going while a call it just made has not come back.
                turn_open = pending_tools > 0;
                steps.push(Message {
                    id: entry_id(&value, steps.len()),
                    role: "assistant",
                    at,
                    text,
                    reasoning,
                    tools,
                });
            }
            _ => {}
        }
    }

    if steps.is_empty() {
        return None;
    }

    Some(Transcript {
        source: "claude",
        session_id,
        title: None,
        // Claude states the permission mode and the conversation mode
        // separately; the permission mode is the one that changes what
        // sending a message does, so it leads.
        mode: permission.or(mode),
        model: None,
        messages: merge_assistant_steps(steps),
        working: turn_open
            .then(|| turn_started.map(|since| Working { since }))
            .flatten(),
        revision,
    })
}

/// How many content blocks of a kind an entry carries.
fn count_blocks(value: &Value, kind: &str) -> i32 {
    value
        .get("message")
        .and_then(|m| m.get("content"))
        .and_then(Value::as_array)
        .map(|blocks| {
            blocks
                .iter()
                .filter(|b| b.get("type").and_then(Value::as_str) == Some(kind))
                .count() as i32
        })
        .unwrap_or(0)
}

fn entry_id(value: &Value, index: usize) -> String {
    value
        .get("uuid")
        .and_then(Value::as_str)
        .map(str::to_string)
        .unwrap_or_else(|| format!("entry-{index}"))
}

/// Timestamps are ISO-8601 with milliseconds. Parsed by hand rather than
/// pulling in a date crate for one field: only the epoch value is wanted, and
/// the format is fixed by the writer.
fn timestamp(value: &Value) -> i64 {
    value
        .get("timestamp")
        .and_then(Value::as_str)
        .and_then(parse_iso8601_ms)
        .unwrap_or(0)
}

fn parse_iso8601_ms(text: &str) -> Option<i64> {
    let bytes = text.as_bytes();
    if bytes.len() < 19 {
        return None;
    }
    let num = |from: usize, to: usize| text.get(from..to)?.parse::<i64>().ok();
    let year = num(0, 4)?;
    let month = num(5, 7)?;
    let day = num(8, 10)?;
    let hour = num(11, 13)?;
    let minute = num(14, 16)?;
    let second = num(17, 19)?;
    let millis = text
        .get(20..23)
        .and_then(|m| m.parse::<i64>().ok())
        .unwrap_or(0);
    let days = days_from_civil(year, month, day);
    Some(((days * 24 + hour) * 60 + minute) * 60_000 + second * 1000 + millis)
}

/// Days since the Unix epoch (Howard Hinnant's civil-from-days, inverted).
fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let y = if month <= 2 { year - 1 } else { year };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (month + 9) % 12;
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

fn user_text(value: &Value) -> String {
    let Some(content) = value.get("message").and_then(|m| m.get("content")) else {
        return String::new();
    };
    if let Some(text) = content.as_str() {
        return text.trim().to_string();
    }
    let Some(blocks) = content.as_array() else {
        return String::new();
    };
    blocks
        .iter()
        .filter(|b| b.get("type").and_then(Value::as_str) == Some("text"))
        .filter_map(|b| b.get("text").and_then(Value::as_str))
        .collect::<Vec<_>>()
        .join("\n")
        .trim()
        .to_string()
}

fn assistant_blocks(value: &Value) -> (String, Option<String>, Vec<String>) {
    let mut text = Vec::new();
    let mut reasoning = None;
    let mut tools = Vec::new();
    let Some(blocks) = value
        .get("message")
        .and_then(|m| m.get("content"))
        .and_then(Value::as_array)
    else {
        return (String::new(), None, tools);
    };
    for block in blocks {
        match block.get("type").and_then(Value::as_str) {
            Some("text") => {
                if let Some(t) = block.get("text").and_then(Value::as_str) {
                    let t = t.trim();
                    if !t.is_empty() {
                        text.push(t.to_string());
                    }
                }
            }
            Some("thinking") => {
                if let Some(t) = block.get("thinking").and_then(Value::as_str) {
                    let t = t.trim();
                    if !t.is_empty() {
                        reasoning = Some(t.to_string());
                    }
                }
            }
            Some("tool_use") => {
                if let Some(name) = block.get("name").and_then(Value::as_str) {
                    tools.push(name.to_string());
                }
            }
            _ => {}
        }
    }
    (text.join("\n"), reasoning, tools)
}
