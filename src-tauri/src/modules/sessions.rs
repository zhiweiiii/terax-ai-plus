use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const HEAD_BYTES: u64 = 192 * 1024;
const MAX_PER_AGENT: usize = 40;
const SCAN_INTERVAL: Duration = Duration::from_secs(2);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    pub agent: &'static str,
    pub id: String,
    pub title: String,
    pub updated_at: i64,
}
#[derive(Clone)]
struct Header {
    cwd: String,
    id: String,
    title: String,
}
struct CachedHeader {
    length: u64,
    modified: Option<SystemTime>,
    created: Option<SystemTime>,
    header: Option<Header>,
    used: Instant,
}
struct CachedDirectory {
    paths: Vec<PathBuf>,
    checked: Instant,
}

fn header_cache() -> &'static Mutex<HashMap<PathBuf, CachedHeader>> {
    static CACHE: OnceLock<Mutex<HashMap<PathBuf, CachedHeader>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}
fn session_root(cwd: &str, agent: &str) -> Option<PathBuf> {
    match agent {
        "claude" => crate::modules::transcript::claude_project_dir(cwd),
        "codex" => Some(dirs::home_dir()?.join(".codex").join("sessions")),
        _ => None,
    }
}
fn session_paths(cwd: &str, agent: &str) -> Vec<PathBuf> {
    static CACHE: OnceLock<Mutex<HashMap<PathBuf, CachedDirectory>>> = OnceLock::new();
    let Some(root) = session_root(cwd, agent) else {
        return Vec::new();
    };
    let mut cache = match CACHE.get_or_init(|| Mutex::new(HashMap::new())).lock() {
        Ok(cache) => cache,
        Err(_) => return Vec::new(),
    };
    if let Some(hit) = cache
        .get(&root)
        .filter(|hit| hit.checked.elapsed() < SCAN_INTERVAL)
    {
        return hit.paths.clone();
    }
    let mut paths = Vec::new();
    collect_paths(&root, agent == "codex", &mut paths);
    if cache.len() >= 32 && !cache.contains_key(&root) {
        if let Some(oldest) = cache
            .iter()
            .min_by_key(|(_, entry)| entry.checked)
            .map(|(path, _)| path.clone())
        {
            cache.remove(&oldest);
        }
    }
    cache.insert(
        root,
        CachedDirectory {
            paths: paths.clone(),
            checked: Instant::now(),
        },
    );
    paths
}
fn collect_paths(dir: &Path, recursive: bool, out: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let Ok(kind) = entry.file_type() else {
            continue;
        };
        let path = entry.path();
        if recursive && kind.is_dir() {
            collect_paths(&path, true, out);
        } else if kind.is_file() && path.extension().is_some_and(|ext| ext == "jsonl") {
            out.push(path);
        }
    }
}
fn valid_id(id: &str) -> bool {
    id.len() == 36
        && id.chars().enumerate().all(|(i, c)| {
            if [8, 13, 18, 23].contains(&i) {
                c == '-'
            } else {
                c.is_ascii_hexdigit()
            }
        })
}
fn message_text(content: &Value) -> Option<String> {
    if let Some(text) = content.as_str() {
        return Some(text.to_string());
    }
    Some(
        content
            .as_array()?
            .iter()
            .filter_map(|part| {
                part.get("text")
                    .and_then(Value::as_str)
                    .or_else(|| part.as_str())
            })
            .collect::<Vec<_>>()
            .join(" "),
    )
}
fn title_text(text: &str) -> String {
    text.split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(80)
        .collect()
}
fn boilerplate(text: &str) -> bool {
    let text = text.trim_start();
    text.starts_with('<')
        || text.starts_with("Caveat:")
        || text.starts_with("# AGENTS.md")
        || text.starts_with("# CLAUDE.md")
}
fn parse_header(path: &Path, agent: &str) -> Option<Header> {
    let mut bytes = Vec::new();
    fs::File::open(path)
        .ok()?
        .take(HEAD_BYTES)
        .read_to_end(&mut bytes)
        .ok()?;
    let end = bytes.iter().rposition(|b| *b == b'\n')?;
    let text = std::str::from_utf8(&bytes[..end]).ok()?;
    let mut cwd = None;
    let mut id = if agent == "claude" {
        path.file_stem()?.to_str().map(str::to_owned)
    } else {
        None
    };
    let mut title = None;
    let mut first_ask = None;
    for line in text.lines() {
        let Ok(value) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        let payload = value.get("payload").unwrap_or(&value);
        if cwd.is_none() {
            cwd = payload
                .get("cwd")
                .and_then(Value::as_str)
                .map(str::to_owned);
        }
        if agent == "codex" && value.get("type").and_then(Value::as_str) == Some("session_meta") {
            id = payload
                .get("session_id")
                .or_else(|| payload.get("id"))
                .and_then(Value::as_str)
                .map(str::to_owned);
        }
        if agent == "claude" && value.get("type").and_then(Value::as_str) == Some("ai-title") {
            title = value
                .get("aiTitle")
                .and_then(Value::as_str)
                .map(title_text)
                .filter(|s| !s.is_empty());
        }
        if first_ask.is_none() {
            let content =
                if agent == "claude" && value.get("type").and_then(Value::as_str) == Some("user") {
                    value
                        .get("message")
                        .and_then(|message| message.get("content"))
                } else if agent == "codex"
                    && payload.get("role").and_then(Value::as_str) == Some("user")
                {
                    payload.get("content")
                } else {
                    None
                };
            first_ask = content
                .and_then(message_text)
                .filter(|s| !s.trim().is_empty() && !boilerplate(s))
                .map(|s| title_text(&s));
        }
        if cwd.is_some()
            && id.is_some()
            && (title.is_some() || (agent == "codex" && first_ask.is_some()))
        {
            break;
        }
    }
    let id = id.filter(|id| valid_id(id))?;
    Some(Header {
        cwd: cwd?,
        id,
        title: title
            .or(first_ask)
            .unwrap_or_else(|| "(无标题会话)".to_string()),
    })
}
fn session_header(path: &Path, agent: &str, metadata: &fs::Metadata) -> Option<Header> {
    let modified = metadata.modified().ok();
    let created = metadata.created().ok();
    if let Ok(mut cache) = header_cache().lock() {
        if let Some(hit) = cache.get_mut(path).filter(|hit| {
            hit.created == created
                && ((hit.length == metadata.len() && hit.modified == modified)
                    || (hit.header.is_some()
                        && hit.length >= HEAD_BYTES
                        && metadata.len() > hit.length))
        }) {
            hit.used = Instant::now();
            hit.length = metadata.len();
            hit.modified = modified;
            return hit.header.clone();
        }
    }
    let header = parse_header(path, agent);
    if let Ok(mut cache) = header_cache().lock() {
        if cache.len() >= 512 && !cache.contains_key(path) {
            if let Some(oldest) = cache
                .iter()
                .min_by_key(|(_, entry)| entry.used)
                .map(|(path, _)| path.clone())
            {
                cache.remove(&oldest);
            }
        }
        cache.insert(
            path.to_path_buf(),
            CachedHeader {
                length: metadata.len(),
                modified,
                created,
                header: header.clone(),
                used: Instant::now(),
            },
        );
    }
    header
}
fn list_sessions(cwd: &str, agent: &'static str) -> Vec<Session> {
    let mut files: Vec<_> = session_paths(cwd, agent)
        .into_iter()
        .filter_map(|path| {
            let metadata = fs::metadata(&path).ok()?;
            let modified = metadata
                .modified()
                .ok()?
                .duration_since(UNIX_EPOCH)
                .ok()?
                .as_secs() as i64;
            Some((modified, path, metadata))
        })
        .collect();
    files.sort_by_key(|(modified, _, _)| std::cmp::Reverse(*modified));
    files
        .into_iter()
        .filter_map(|(updated_at, path, metadata)| {
            let header = session_header(&path, agent, &metadata)?;
            crate::modules::transcript::same_dir(&header.cwd, cwd).then_some(Session {
                agent,
                id: header.id,
                title: header.title,
                updated_at,
            })
        })
        .take(MAX_PER_AGENT)
        .collect()
}
pub(crate) fn resolve_session_file(
    cwd: &str,
    agent: &str,
    id: Option<&str>,
    started_at: SystemTime,
) -> Option<PathBuf> {
    let mut candidates = Vec::new();
    for path in session_paths(cwd, agent) {
        if id.is_some_and(|id| {
            !path
                .file_name()
                .is_some_and(|name| name.to_string_lossy().contains(id))
        }) {
            continue;
        }
        let Ok(metadata) = fs::metadata(&path) else {
            continue;
        };
        if id.is_none()
            && !metadata
                .created()
                .is_ok_and(|created| created >= started_at)
        {
            continue;
        }
        let Some(header) = session_header(&path, agent, &metadata) else {
            continue;
        };
        if !crate::modules::transcript::same_dir(&header.cwd, cwd)
            || id.is_some_and(|id| header.id != id)
        {
            continue;
        }
        candidates.push(path);
    }
    (candidates.len() == 1).then(|| candidates.remove(0))
}
#[tauri::command]
pub async fn agent_sessions(cwd: String) -> Vec<Session> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut all = list_sessions(&cwd, "claude");
        all.extend(list_sessions(&cwd, "codex"));
        all.sort_by_key(|session| std::cmp::Reverse(session.updated_at));
        all
    })
    .await
    .unwrap_or_default()
}
