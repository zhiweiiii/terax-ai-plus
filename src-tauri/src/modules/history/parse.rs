// Pure parsing + ranking for shell history. No I/O here so the formats stay
// unit-tested. zsh metafies bytes >= 0x80 in its histfile (Meta 0x83 followed
// by byte ^ 0x20); callers demetafy raw bytes before handing us a string.

#[derive(Debug, Clone, PartialEq)]
pub struct HistEntry {
    pub cmd: String,
    pub count: u32,
    pub last: i64,
}

const META: u8 = 0x83;

pub fn demetafy(bytes: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == META && i + 1 < bytes.len() {
            out.push(bytes[i + 1] ^ 0x20);
            i += 2;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    out
}

// zsh writes a multi-line command as physical lines joined by a trailing
// backslash; an even count of trailing backslashes is a literal, not a join.
fn join_continuations(content: &str) -> Vec<String> {
    let mut lines = Vec::new();
    let mut cur = String::new();
    for line in content.split('\n') {
        let line = line.strip_suffix('\r').unwrap_or(line);
        let trailing = line.bytes().rev().take_while(|&b| b == b'\\').count();
        if trailing % 2 == 1 {
            cur.push_str(&line[..line.len() - 1]);
            cur.push('\n');
        } else {
            cur.push_str(line);
            lines.push(std::mem::take(&mut cur));
        }
    }
    if !cur.is_empty() {
        lines.push(cur);
    }
    lines
}

fn push_cmd(out: &mut Vec<(String, i64)>, cmd: &str, ts: i64) {
    let c = cmd.trim();
    if !c.is_empty() {
        out.push((c.to_string(), ts));
    }
}

pub fn parse_zsh(content: &str) -> Vec<(String, i64)> {
    let mut out = Vec::new();
    for line in join_continuations(content) {
        let line = line.trim_end_matches('\n');
        if line.is_empty() {
            continue;
        }
        if let Some(rest) = line.strip_prefix(": ") {
            if let Some(semi) = rest.find(';') {
                let ts = rest[..semi]
                    .split(':')
                    .next()
                    .and_then(|s| s.trim().parse::<i64>().ok())
                    .unwrap_or(0);
                push_cmd(&mut out, &rest[semi + 1..], ts);
                continue;
            }
        }
        push_cmd(&mut out, line, 0);
    }
    out
}

pub fn parse_bash(content: &str) -> Vec<(String, i64)> {
    let mut out = Vec::new();
    let mut ts = 0i64;
    for line in content.split('\n') {
        let line = line.strip_suffix('\r').unwrap_or(line);
        if line.is_empty() {
            continue;
        }
        if let Some(num) = line.strip_prefix('#') {
            if let Ok(t) = num.trim().parse::<i64>() {
                ts = t;
                continue;
            }
        }
        push_cmd(&mut out, line, ts);
        ts = 0;
    }
    out
}

fn unescape_fish(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars();
    while let Some(c) = chars.next() {
        if c == '\\' {
            match chars.next() {
                Some('n') => out.push('\n'),
                Some('\\') => out.push('\\'),
                Some(other) => out.push(other),
                None => out.push('\\'),
            }
        } else {
            out.push(c);
        }
    }
    out
}

pub fn parse_fish(content: &str) -> Vec<(String, i64)> {
    let mut out = Vec::new();
    let mut pending: Option<String> = None;
    for line in content.split('\n') {
        if let Some(cmd) = line.strip_prefix("- cmd: ") {
            if let Some(p) = pending.take() {
                push_cmd(&mut out, &p, 0);
            }
            pending = Some(unescape_fish(cmd));
        } else if let Some(when) = line.trim().strip_prefix("when: ") {
            if let Some(cmd) = pending.take() {
                let ts = when.trim().parse::<i64>().unwrap_or(0);
                push_cmd(&mut out, &cmd, ts);
            }
        }
    }
    if let Some(p) = pending.take() {
        push_cmd(&mut out, &p, 0);
    }
    out
}

pub fn build_index(entries: Vec<(String, i64)>) -> Vec<HistEntry> {
    use std::collections::HashMap;
    let mut map: HashMap<String, HistEntry> = HashMap::new();
    for (cmd, ts) in entries {
        let e = map.entry(cmd.clone()).or_insert(HistEntry {
            cmd,
            count: 0,
            last: 0,
        });
        e.count += 1;
        if ts > e.last {
            e.last = ts;
        }
    }
    let mut v: Vec<HistEntry> = map.into_values().collect();
    sort_recent(&mut v);
    v
}

pub fn sort_recent(v: &mut [HistEntry]) {
    v.sort_by(|a, b| b.last.cmp(&a.last).then(b.count.cmp(&a.count)));
}

// fish-style autosuggestion: the most recent full command that extends `line`.
pub fn suggest(index: &[HistEntry], line: &str) -> Option<String> {
    if line.is_empty() {
        return None;
    }
    index
        .iter()
        .filter(|e| e.cmd.len() > line.len() && e.cmd.starts_with(line))
        .max_by(|a, b| a.last.cmp(&b.last).then(a.count.cmp(&b.count)))
        .map(|e| e.cmd.clone())
}

// Command-name list for the current token: history first-words (by frequency)
// first, then PATH executables (alphabetical), deduped.
pub fn complete_commands(
    index: &[HistEntry],
    path_cmds: &[String],
    prefix: &str,
    limit: usize,
) -> Vec<String> {
    use std::collections::{HashMap, HashSet};
    let mut freq: HashMap<&str, u32> = HashMap::new();
    for e in index {
        let w = e.cmd.split_whitespace().next().unwrap_or("");
        if !w.is_empty() && w.starts_with(prefix) {
            *freq.entry(w).or_insert(0) += e.count;
        }
    }
    let mut hist_words: Vec<(&str, u32)> = freq.into_iter().collect();
    hist_words.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(b.0)));

    let mut seen: HashSet<String> = HashSet::new();
    let mut out: Vec<String> = Vec::new();
    for (w, _) in hist_words {
        if seen.insert(w.to_string()) {
            out.push(w.to_string());
            if out.len() >= limit {
                return out;
            }
        }
    }
    let mut paths: Vec<&String> = path_cmds.iter().filter(|c| c.starts_with(prefix)).collect();
    paths.sort();
    for c in paths {
        if seen.insert(c.clone()) {
            out.push(c.clone());
            if out.len() >= limit {
                break;
            }
        }
    }
    out
}

// Recency-ranked, deduped commands for the Ctrl-R style popover. Substring,
// case-insensitive; `index` is already most-recent-first.
pub fn list(index: &[HistEntry], query: &str, limit: usize) -> Vec<String> {
    let q = query.trim().to_lowercase();
    let mut out = Vec::new();
    for e in index {
        if q.is_empty() || e.cmd.to_lowercase().contains(&q) {
            out.push(e.cmd.clone());
            if out.len() >= limit {
                break;
            }
        }
    }
    out
}


