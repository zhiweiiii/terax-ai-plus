//! Codex writes a JSONL rollout for each session below `~/.codex/sessions`.

use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde_json::Value;

use super::{
    clip_output, merge_assistant_steps, push_part, same_dir, Message, Part, Transcript, Working,
};

const SEARCH_MAX_AGE_SECS: u64 = 24 * 60 * 60;
const REFRESH_SESSION_PATH: Duration = Duration::from_secs(2);

struct CachedSession {
    file: PathBuf,
    checked_at: Instant,
}

pub fn read(cwd: &str) -> Option<Transcript> {
    let file = newest_session(cwd)?;
    let session_id = session_id(&file)?;
    parse(&file, session_id)
}

pub fn changed_at(cwd: &str) -> Option<i64> {
    let file = newest_session(cwd)?;
    let modified = file.metadata().ok()?.modified().ok()?;
    Some(
        modified
            .duration_since(std::time::UNIX_EPOCH)
            .ok()?
            .as_millis() as i64,
    )
}

fn sessions_root() -> Option<PathBuf> {
    let root = dirs::home_dir()?.join(".codex").join("sessions");
    root.is_dir().then_some(root)
}

fn session_cache() -> &'static Mutex<HashMap<String, CachedSession>> {
    static CACHE: OnceLock<Mutex<HashMap<String, CachedSession>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn newest_session(cwd: &str) -> Option<PathBuf> {
    if let Some(file) = session_cache().lock().ok().and_then(|cache| {
        cache.get(cwd).and_then(|cached| {
            (cached.checked_at.elapsed() < REFRESH_SESSION_PATH && cached.file.is_file())
                .then(|| cached.file.clone())
        })
    }) {
        return Some(file);
    }
    let root = sessions_root()?;
    let now = std::time::SystemTime::now();
    let mut best: Option<(std::time::SystemTime, PathBuf)> = None;
    visit_rollouts(&root, &mut |file, modified| {
        if now
            .duration_since(modified)
            .map(|age| age.as_secs() > SEARCH_MAX_AGE_SECS)
            .unwrap_or(false)
            || !session_cwd(file).is_some_and(|found| same_dir(&found, cwd))
        {
            return;
        }
        if best.as_ref().is_none_or(|(at, _)| modified > *at) {
            best = Some((modified, file.to_path_buf()));
        }
    });
    let file = best.map(|(_, file)| file)?;
    if let Ok(mut cache) = session_cache().lock() {
        cache.insert(
            cwd.to_string(),
            CachedSession {
                file: file.clone(),
                checked_at: Instant::now(),
            },
        );
    }
    Some(file)
}

fn visit_rollouts(dir: &Path, visit: &mut impl FnMut(&Path, std::time::SystemTime)) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            visit_rollouts(&path, visit);
            continue;
        }
        if !path
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.starts_with("rollout-") && name.ends_with(".jsonl"))
        {
            continue;
        }
        let Ok(modified) = entry.metadata().and_then(|metadata| metadata.modified()) else {
            continue;
        };
        visit(&path, modified);
    }
}

fn session_cwd(file: &Path) -> Option<String> {
    let reader = BufReader::new(fs::File::open(file).ok()?);
    for line in reader.lines().take(8).flatten() {
        let value = serde_json::from_str::<Value>(&line).ok()?;
        if value.get("type").and_then(Value::as_str) != Some("session_meta") {
            continue;
        }
        return value
            .get("payload")
            .and_then(|payload| payload.get("cwd"))
            .and_then(Value::as_str)
            .map(str::to_string);
    }
    None
}

fn session_id(file: &Path) -> Option<String> {
    let reader = BufReader::new(fs::File::open(file).ok()?);
    for line in reader.lines().take(8).flatten() {
        let value = serde_json::from_str::<Value>(&line).ok()?;
        if value.get("type").and_then(Value::as_str) != Some("session_meta") {
            continue;
        }
        if let Some(id) = value
            .get("payload")
            .and_then(|payload| payload.get("session_id").or_else(|| payload.get("id")))
            .and_then(Value::as_str)
        {
            return Some(id.to_string());
        }
    }
    file.file_stem()
        .and_then(|name| name.to_str())
        .map(str::to_string)
}

fn parse(file: &Path, session_id: String) -> Option<Transcript> {
    let text = fs::read_to_string(file).ok()?;
    parse_text(&text, session_id)
}

fn parse_text(text: &str, session_id: String) -> Option<Transcript> {
    let mut steps = Vec::new();
    let mut pending_tools: HashMap<String, (usize, usize)> = HashMap::new();
    let mut revision = 0;
    let mut working = None;

    for line in text.lines() {
        let Ok(value) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        revision = revision.max(timestamp(&value));
        match value.get("type").and_then(Value::as_str) {
            Some("response_item") => response_item(
                value.get("payload").unwrap_or(&Value::Null),
                timestamp(&value),
                &mut steps,
                &mut pending_tools,
            ),
            Some("event_msg") => match value
                .get("payload")
                .and_then(|payload| payload.get("type"))
                .and_then(Value::as_str)
            {
                Some("task_started") => {
                    working = value
                        .get("payload")
                        .and_then(|payload| payload.get("started_at"))
                        .and_then(Value::as_i64)
                        .map(|seconds| Working {
                            since: seconds.saturating_mul(1000),
                        });
                }
                Some("task_complete") | Some("turn_aborted") => working = None,
                _ => {}
            },
            _ => {}
        }
    }

    if steps.is_empty() {
        return None;
    }

    Some(Transcript {
        source: "codex",
        session_id,
        title: None,
        mode: None,
        model: None,
        messages: merge_assistant_steps(steps),
        working,
        revision,
    })
}

fn response_item(
    item: &Value,
    at: i64,
    steps: &mut Vec<Message>,
    pending_tools: &mut HashMap<String, (usize, usize)>,
) {
    match item.get("type").and_then(Value::as_str) {
        Some("message") => match item.get("role").and_then(Value::as_str) {
            Some("user") => push_message(steps, "user", item, at),
            Some("assistant") => push_message(steps, "assistant", item, at),
            _ => {}
        },
        Some("reasoning") => {
            let Some(reasoning) = item.get("summary").and_then(value_text) else {
                return;
            };
            let reasoning = reasoning.trim();
            if reasoning.is_empty() {
                return;
            }
            steps.push(Message {
                id: item_id(item, steps.len()),
                role: "assistant",
                at,
                text: String::new(),
                reasoning: Some(reasoning.to_string()),
                parts: Vec::new(),
            });
        }
        Some("function_call") | Some("custom_tool_call") => {
            let Some(name) = item.get("name").and_then(Value::as_str) else {
                return;
            };
            let subject = item
                .get("arguments")
                .or_else(|| item.get("input"))
                .and_then(value_text)
                .and_then(subject);
            let step = steps.len();
            steps.push(Message {
                id: item_id(item, step),
                role: "assistant",
                at,
                text: String::new(),
                reasoning: None,
                parts: vec![Part::Tool {
                    name: name.to_string(),
                    subject,
                    output: None,
                    elided: 0,
                    failed: false,
                }],
            });
            if let Some(call_id) = item
                .get("call_id")
                .or_else(|| item.get("id"))
                .and_then(Value::as_str)
            {
                pending_tools.insert(call_id.to_string(), (step, 0));
            }
        }
        Some("function_call_output") | Some("custom_tool_call_output") => {
            let Some(call_id) = item.get("call_id").and_then(Value::as_str) else {
                return;
            };
            let Some(&(step, part)) = pending_tools.get(call_id) else {
                return;
            };
            let Some(Part::Tool {
                output,
                elided,
                failed,
                ..
            }) = steps
                .get_mut(step)
                .and_then(|message| message.parts.get_mut(part))
            else {
                return;
            };
            let text = item.get("output").and_then(value_text).unwrap_or_default();
            let (clipped, elided_now) = clip_output(&text);
            *output = Some(clipped);
            *elided = elided_now;
            *failed = item
                .get("is_error")
                .and_then(Value::as_bool)
                .unwrap_or(false);
        }
        _ => {}
    }
}

fn push_message(steps: &mut Vec<Message>, role: &'static str, item: &Value, at: i64) {
    let text = item
        .get("content")
        .and_then(message_text)
        .unwrap_or_default();
    if text.is_empty() {
        return;
    }
    let mut parts = Vec::new();
    if role == "assistant" {
        push_part(&mut parts, Part::Text { text: text.clone() });
    }
    steps.push(Message {
        id: item_id(item, steps.len()),
        role,
        at,
        text,
        reasoning: None,
        parts,
    });
}

fn item_id(item: &Value, index: usize) -> String {
    item.get("id")
        .and_then(Value::as_str)
        .map(str::to_string)
        .unwrap_or_else(|| format!("entry-{index}"))
}

fn message_text(content: &Value) -> Option<String> {
    let items = content.as_array()?;
    let text = items
        .iter()
        .filter(|part| {
            matches!(
                part.get("type").and_then(Value::as_str),
                Some("input_text") | Some("output_text") | Some("text")
            )
        })
        .filter_map(|part| part.get("text").and_then(Value::as_str))
        .collect::<Vec<_>>()
        .join("\n");
    (!text.trim().is_empty()).then(|| text.trim().to_string())
}

fn value_text(value: &Value) -> Option<String> {
    match value {
        Value::String(text) => Some(text.clone()),
        Value::Array(items) => {
            let text = items
                .iter()
                .filter_map(|item| {
                    item.get("text")
                        .or_else(|| item.get("output"))
                        .and_then(Value::as_str)
                })
                .collect::<Vec<_>>()
                .join("\n");
            (!text.is_empty()).then_some(text)
        }
        Value::Object(_) => value
            .get("text")
            .or_else(|| value.get("output"))
            .and_then(Value::as_str)
            .map(str::to_string),
        _ => None,
    }
}

fn subject(text: String) -> Option<String> {
    let flat = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if flat.is_empty() {
        return None;
    }
    const MAX: usize = 140;
    if flat.chars().count() <= MAX {
        return Some(flat);
    }
    Some(flat.chars().take(MAX).collect::<String>() + "…")
}

fn timestamp(value: &Value) -> i64 {
    value
        .get("timestamp")
        .and_then(Value::as_str)
        .and_then(parse_iso8601_ms)
        .unwrap_or(0)
}

fn parse_iso8601_ms(text: &str) -> Option<i64> {
    if text.len() < 19 {
        return None;
    }
    let number = |from: usize, to: usize| text.get(from..to)?.parse::<i64>().ok();
    let year = number(0, 4)?;
    let month = number(5, 7)?;
    let day = number(8, 10)?;
    let hour = number(11, 13)?;
    let minute = number(14, 16)?;
    let second = number(17, 19)?;
    let millis = text
        .get(20..23)
        .and_then(|value| value.parse::<i64>().ok())
        .unwrap_or(0);
    let year = if month <= 2 { year - 1 } else { year };
    let era = if year >= 0 { year } else { year - 399 } / 400;
    let year_of_era = year - era * 400;
    let month_index = (month + 9) % 12;
    let day_of_year = (153 * month_index + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    let days = era * 146_097 + day_of_era - 719_468;
    Some(((days * 24 + hour) * 60 + minute) * 60_000 + second * 1000 + millis)
}
