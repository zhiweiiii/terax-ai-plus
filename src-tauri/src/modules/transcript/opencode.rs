//! opencode keeps its sessions in SQLite at
//! `~/.local/share/opencode/opencode.db`.
//!
//! Read directly, read-only, because the alternatives do not work for a live
//! view: the running TUI opens no port (so there is nothing to attach to), and
//! `opencode export` costs a process launch per read. The database is opened
//! without ever writing to it, so a running opencode is unaffected.
//!
//! The tables are opencode's own, not an interface it promises, so everything
//! here degrades to "no transcript" rather than erroring: a schema that moves
//! under us puts the phone back on the screen view, it does not break it.

use std::path::PathBuf;

use rusqlite::{Connection, OpenFlags};
use serde_json::Value;

use super::{merge_assistant_steps, normalize_dir, Message, Transcript, Working};

fn database() -> Option<PathBuf> {
    let path = dirs::home_dir()?
        .join(".local")
        .join("share")
        .join("opencode")
        .join("opencode.db");
    path.is_file().then_some(path)
}

/// Newest mtime across the database and its write-ahead log, as a change
/// signal. Committed writes land in the WAL long before the main file is
/// checkpointed, so watching the database alone misses everything.
pub fn changed_at() -> Option<i64> {
    let db = database()?;
    let wal = db.with_extension("db-wal");
    [Some(db), wal.is_file().then_some(wal)]
        .into_iter()
        .flatten()
        .filter_map(|p| p.metadata().ok()?.modified().ok())
        .filter_map(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .max()
}

pub fn read(cwd: &str) -> Option<Transcript> {
    let path = database()?;
    let conn = Connection::open_with_flags(
        &path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_URI,
    )
    .ok()?;
    read_with(&conn, cwd)
}

fn read_with(conn: &Connection, cwd: &str) -> Option<Transcript> {
    let want = normalize_dir(cwd);
    // `directory` is stored however opencode was launched, so the match is
    // made in Rust on a normalised form rather than in SQL.
    let mut stmt = conn
        .prepare(
            "select id, title, agent, model, directory, time_updated \
             from session order by time_updated desc limit 200",
        )
        .ok()?;
    let mut rows = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, Option<String>>(1)?,
                row.get::<_, Option<String>>(2)?,
                row.get::<_, Option<String>>(3)?,
                row.get::<_, Option<String>>(4)?,
                row.get::<_, Option<i64>>(5)?,
            ))
        })
        .ok()?
        .flatten();
    let (session_id, title, agent, model, _, updated) =
        rows.find(|(_, _, _, _, dir, _)| {
            dir.as_deref().is_some_and(|d| normalize_dir(d) == want)
        })?;

    let steps = messages(conn, &session_id)?;
    if steps.is_empty() {
        return None;
    }
    let working = working_since(conn, &session_id);
    let revision = steps.iter().map(|m| m.at).max().unwrap_or(0).max(updated.unwrap_or(0));

    Some(Transcript {
        source: "opencode",
        session_id,
        title,
        // opencode calls it the agent ("build", "plan"); it is the same thing
        // Claude calls a mode - what sending a message will do.
        mode: agent,
        model: model.as_deref().and_then(model_name),
        messages: merge_assistant_steps(steps),
        working,
        revision,
    })
}

/// `model` is stored as JSON (`{"id":…,"providerID":…,"variant":…}`).
fn model_name(raw: &str) -> Option<String> {
    serde_json::from_str::<Value>(raw)
        .ok()?
        .get("id")
        .and_then(Value::as_str)
        .map(str::to_string)
}

fn messages(conn: &Connection, session_id: &str) -> Option<Vec<Message>> {
    let mut stmt = conn
        .prepare(
            "select id, time_created, data from message \
             where session_id = ?1 order by time_created, id",
        )
        .ok()?;
    let rows: Vec<(String, i64, String)> = stmt
        .query_map([session_id], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?))
        })
        .ok()?
        .flatten()
        .collect();

    let mut out = Vec::with_capacity(rows.len());
    for (id, at, data) in rows {
        let info: Value = serde_json::from_str(&data).ok()?;
        let role = match info.get("role").and_then(Value::as_str) {
            Some("user") => "user",
            Some("assistant") => "assistant",
            _ => continue,
        };
        let (text, reasoning, tools) = parts(conn, &id);
        out.push(Message {
            id,
            role,
            at,
            text,
            reasoning,
            tools,
        });
    }
    Some(out)
}

/// A message's content, split the way the reader needs it. `step-start` and
/// `step-finish` are the model round trip's own bookkeeping and carry nothing.
fn parts(conn: &Connection, message_id: &str) -> (String, Option<String>, Vec<String>) {
    let mut text: Vec<String> = Vec::new();
    let mut reasoning = None;
    let mut tools = Vec::new();

    let Ok(mut stmt) = conn.prepare(
        "select data from part where message_id = ?1 order by time_created, id",
    ) else {
        return (String::new(), None, tools);
    };
    let Ok(rows) = stmt.query_map([message_id], |row| row.get::<_, String>(0)) else {
        return (String::new(), None, tools);
    };
    for data in rows.flatten() {
        let Ok(part) = serde_json::from_str::<Value>(&data) else {
            continue;
        };
        match part.get("type").and_then(Value::as_str) {
            Some("text") => {
                if let Some(t) = part.get("text").and_then(Value::as_str) {
                    let t = t.trim();
                    if !t.is_empty() {
                        text.push(t.to_string());
                    }
                }
            }
            Some("reasoning") => {
                if let Some(t) = part.get("text").and_then(Value::as_str) {
                    let t = t.trim();
                    if !t.is_empty() {
                        reasoning = Some(t.to_string());
                    }
                }
            }
            Some("tool") => {
                if let Some(name) = part.get("tool").and_then(Value::as_str) {
                    tools.push(name.to_string());
                }
            }
            _ => {}
        }
    }
    (text.join("\n"), reasoning, tools)
}

/// When the newest assistant message has no completion time, opencode is still
/// producing it.
fn working_since(conn: &Connection, session_id: &str) -> Option<Working> {
    let mut stmt = conn
        .prepare(
            "select time_created, data from message \
             where session_id = ?1 order by time_created desc, id desc limit 1",
        )
        .ok()?;
    let (at, data): (i64, String) = stmt
        .query_row([session_id], |row| Ok((row.get(0)?, row.get(1)?)))
        .ok()?;
    let info: Value = serde_json::from_str(&data).ok()?;
    match info.get("role").and_then(Value::as_str) {
        // The user's message is in and nothing has answered it yet.
        Some("user") => Some(Working { since: at }),
        Some("assistant") => {
            let completed = info
                .get("time")
                .and_then(|t| t.get("completed"))
                .and_then(Value::as_i64);
            completed.is_none().then(|| Working {
                since: info
                    .get("time")
                    .and_then(|t| t.get("created"))
                    .and_then(Value::as_i64)
                    .unwrap_or(at),
            })
        }
        _ => None,
    }
}
