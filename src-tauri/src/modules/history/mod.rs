mod parse;

use parse::{
    build_index, complete_commands, demetafy, list, parse_bash, parse_fish, parse_powershell,
    parse_zsh, sort_recent, suggest, HistEntry,
};
use std::io::{Read, Seek, SeekFrom};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

struct Index {
    entries: Vec<HistEntry>,
    path_cmds: Vec<String>,
    next_order: u64,
}

#[derive(Default)]
pub struct HistoryState {
    inner: Arc<Mutex<Option<Index>>>,
}

const MAX_HISTORY_BYTES: u64 = 2 * 1024 * 1024;
const MAX_HISTORY_ENTRIES: usize = 20_000;

fn read_history(path: &std::path::Path, powershell: bool) -> std::io::Result<Vec<u8>> {
    let mut file = std::fs::File::open(path)?;
    let start = file.metadata()?.len().saturating_sub(MAX_HISTORY_BYTES);
    file.seek(SeekFrom::Start(start))?;
    let mut bytes = Vec::new();
    file.take(MAX_HISTORY_BYTES).read_to_end(&mut bytes)?;
    if start > 0 {
        if let Some(end) = bytes.iter().position(|byte| *byte == b'\n') {
            let mut consumed = end + 1;
            if powershell {
                while let Some(end) = bytes[consumed..].iter().position(|byte| *byte == b'\n') {
                    let line = &bytes[consumed..consumed + end];
                    let line = line.strip_suffix(b"\r").unwrap_or(line);
                    consumed += end + 1;
                    if !line.ends_with(b"`") {
                        break;
                    }
                }
            }
            bytes.drain(..consumed);
        } else {
            bytes.clear();
        }
    }
    Ok(bytes)
}

fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn read_histories() -> Vec<(String, i64)> {
    let mut all = Vec::new();
    let home = dirs::home_dir();

    if let Some(path) = zsh_histfile(home.as_ref()) {
        if let Ok(bytes) = read_history(&path, false) {
            let content = String::from_utf8_lossy(&demetafy(&bytes)).into_owned();
            all.extend(parse_zsh(&content));
        }
    }
    if let Some(home) = home.as_ref() {
        if let Ok(bytes) = read_history(&home.join(".bash_history"), false) {
            all.extend(parse_bash(&String::from_utf8_lossy(&bytes)));
        }
    }
    if let Some(path) = fish_histfile(home.as_ref()) {
        if let Ok(bytes) = read_history(&path, false) {
            all.extend(parse_fish(&String::from_utf8_lossy(&bytes)));
        }
    }
    if let Some(data) = dirs::data_dir() {
        let path = data.join("Microsoft/Windows/PowerShell/PSReadLine/ConsoleHost_history.txt");
        if let Ok(bytes) = read_history(&path, true) {
            all.extend(parse_powershell(&String::from_utf8_lossy(&bytes)));
        }
    }
    all
}

fn zsh_histfile(home: Option<&PathBuf>) -> Option<PathBuf> {
    if let Ok(p) = std::env::var("HISTFILE") {
        let pb = PathBuf::from(p);
        if pb.exists() {
            return Some(pb);
        }
    }
    home.map(|h| h.join(".zsh_history"))
}

fn fish_histfile(home: Option<&PathBuf>) -> Option<PathBuf> {
    if let Ok(data) = std::env::var("XDG_DATA_HOME") {
        let pb = PathBuf::from(data).join("fish/fish_history");
        if pb.exists() {
            return Some(pb);
        }
    }
    home.map(|h| h.join(".local/share/fish/fish_history"))
}

fn scan_path() -> Vec<String> {
    use std::collections::HashSet;
    let mut set: HashSet<String> = HashSet::new();
    if let Ok(path) = std::env::var("PATH") {
        for dir in std::env::split_paths(&path) {
            let Ok(rd) = std::fs::read_dir(&dir) else {
                continue;
            };
            for entry in rd.flatten() {
                if entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                    continue;
                }
                if is_executable(&entry) {
                    if let Some(name) = entry.file_name().to_str() {
                        set.insert(name.to_string());
                    }
                }
            }
        }
    }
    let mut v: Vec<String> = set.into_iter().collect();
    v.sort();
    v
}

#[cfg(unix)]
fn is_executable(entry: &std::fs::DirEntry) -> bool {
    use std::os::unix::fs::PermissionsExt;
    entry
        .metadata()
        .map(|m| m.permissions().mode() & 0o111 != 0)
        .unwrap_or(false)
}

#[cfg(windows)]
fn is_executable(entry: &std::fs::DirEntry) -> bool {
    match entry.file_name().to_str() {
        Some(name) => {
            let lower = name.to_ascii_lowercase();
            [".exe", ".cmd", ".bat", ".com", ".ps1"]
                .iter()
                .any(|e| lower.ends_with(e))
        }
        None => false,
    }
}

fn ensure(inner: &Mutex<Option<Index>>) -> std::sync::MutexGuard<'_, Option<Index>> {
    let mut guard = inner.lock().unwrap();
    if guard.is_none() {
        let mut entries = build_index(read_histories());
        let next_order = entries
            .iter()
            .map(|entry| entry.order)
            .max()
            .unwrap_or(0)
            .saturating_add(1);
        entries.truncate(MAX_HISTORY_ENTRIES);
        *guard = Some(Index {
            entries,
            path_cmds: scan_path(),
            next_order,
        });
    }
    guard
}

#[tauri::command]
pub async fn history_suggest(
    state: tauri::State<'_, HistoryState>,
    line: String,
) -> Result<Option<String>, String> {
    let inner = state.inner.clone();
    crate::modules::fs::blocking(move || {
        let guard = ensure(&inner);
        Ok(guard
            .as_ref()
            .and_then(|index| suggest(&index.entries, &line)))
    })
    .await
}

#[tauri::command]
pub async fn history_commands(
    state: tauri::State<'_, HistoryState>,
    prefix: String,
    limit: Option<usize>,
) -> Result<Vec<String>, String> {
    let inner = state.inner.clone();
    crate::modules::fs::blocking(move || {
        let guard = ensure(&inner);
        Ok(match guard.as_ref() {
            Some(idx) => complete_commands(
                &idx.entries,
                &idx.path_cmds,
                &prefix,
                limit.unwrap_or(50).min(1000),
            ),
            None => Vec::new(),
        })
    })
    .await
}

#[tauri::command]
pub async fn history_list(
    state: tauri::State<'_, HistoryState>,
    query: String,
    limit: Option<usize>,
) -> Result<Vec<String>, String> {
    let inner = state.inner.clone();
    crate::modules::fs::blocking(move || {
        let guard = ensure(&inner);
        Ok(match guard.as_ref() {
            Some(idx) => list(&idx.entries, &query, limit.unwrap_or(200).min(1000)),
            None => Vec::new(),
        })
    })
    .await
}

// Called on every accepted command so in-memory history stays hot without a
// re-read. Only ever fed prompt-mode commands, never raw running-mode input,
// so passwords typed into a running command never enter history.
#[tauri::command]
pub async fn history_record(
    state: tauri::State<'_, HistoryState>,
    command: String,
) -> Result<(), String> {
    if command.len() > 64 * 1024 {
        return Err("history command too long".into());
    }
    let inner = state.inner.clone();
    crate::modules::fs::blocking(move || {
        let cmd = command.trim();
        if cmd.is_empty() {
            return Ok(());
        }
        let mut guard = ensure(&inner);
        if let Some(idx) = guard.as_mut() {
            let n = now();
            let order = idx.next_order;
            idx.next_order = idx.next_order.saturating_add(1);
            match idx.entries.iter_mut().find(|e| e.cmd == cmd) {
                Some(e) => {
                    e.count = e.count.saturating_add(1);
                    e.last = n;
                    e.order = order;
                }
                None => idx.entries.push(HistEntry {
                    cmd: cmd.to_string(),
                    count: 1,
                    last: n,
                    order,
                }),
            }
            sort_recent(&mut idx.entries);
            idx.entries.truncate(MAX_HISTORY_ENTRIES);
        }
        Ok(())
    })
    .await
}
