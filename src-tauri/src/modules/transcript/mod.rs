//! What a coding agent actually said, read from where it writes it down.
//!
//! The phone used to reconstruct an agent conversation by parsing the TUI's
//! screen. That works, but it is a parse of a picture: a side panel reads as
//! speech, a spinner reads as a sentence, and every layout change is a bug.
//! Both agents we support already persist the conversation in a structured
//! form, so the conversation is read from there and the screen is left to do
//! the one thing only it knows: what the program is asking you to pick right
//! now (see `docs/architecture/mobile-conversation-view.md`).
//!
//! Two backends, one shape:
//!
//! - `claude` - `~/.claude/projects/<escaped cwd>/<session>.jsonl`, appended
//!   as the session runs. No dependency, trivially re-read.
//! - `opencode` - `~/.local/share/opencode/opencode.db`, SQLite. Its TUI opens
//!   no port and `opencode export` costs a process per read, so the database
//!   is read directly, read-only.

mod claude;
mod opencode;

use serde::Serialize;

/// One turn of the conversation.
///
/// Consecutive steps by the agent are merged into a single turn: both tools
/// write a row per model round trip (a tool call, its result, the next call),
/// and a reader wants the answer, not the machinery.
#[derive(Serialize, Clone, Debug)]
pub struct Message {
    pub id: String,
    /// "user" or "assistant".
    pub role: &'static str,
    /// Epoch milliseconds.
    pub at: i64,
    /// What was said. Empty for a turn that only ran tools.
    pub text: String,
    /// The agent's own reasoning for this turn, last block only - the earlier
    /// ones are steps toward it and reading them all back is not thinking, it
    /// is a transcript of thinking.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reasoning: Option<String>,
    /// Tools this turn invoked, in order.
    pub tools: Vec<String>,
}

/// The agent is still producing an answer.
#[derive(Serialize, Clone, Debug)]
pub struct Working {
    /// Epoch milliseconds the current turn started, so the page can count up
    /// on its own rather than being told the elapsed time on every poll.
    pub since: i64,
}

#[derive(Serialize, Clone, Debug)]
pub struct Transcript {
    /// "claude" or "opencode".
    pub source: &'static str,
    pub session_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    /// The mode the session is in - what sending a message will DO.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mode: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    pub messages: Vec<Message>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub working: Option<Working>,
    /// Newest timestamp in the transcript. A poller compares this instead of
    /// diffing the whole conversation.
    pub revision: i64,
}

/// Read the newest agent session for a working directory.
///
/// `agent` is what the PTY's own detection saw start (`pty::agent_detect`);
/// when it is not known both backends are tried and the more recently updated
/// one wins, because a directory can have been used by either.
pub fn read(cwd: &str, agent: Option<&str>) -> Option<Transcript> {
    match agent {
        Some("claude") => claude::read(cwd),
        Some("opencode") => opencode::read(cwd),
        _ => {
            let a = claude::read(cwd);
            let b = opencode::read(cwd);
            match (a, b) {
                (Some(a), Some(b)) => Some(if a.revision >= b.revision { a } else { b }),
                (a, b) => a.or(b),
            }
        }
    }
}

/// Cheap change signal across both backends: the newest moment either of them
/// wrote anything for this directory. A poller compares this and only calls
/// `read` when it moved, so watching an idle agent costs a couple of stats.
///
/// opencode's half is not per-directory - its whole database is one file - so
/// activity in another project also invalidates. That costs one extra read,
/// which then finds an unchanged `revision` and sends nothing.
pub fn fingerprint(cwd: &str) -> Option<i64> {
    claude::changed_at(cwd)
        .into_iter()
        .chain(opencode::changed_at())
        .max()
}

/// Windows paths reach us with either separator depending on who wrote them
/// (the PTY reports backslashes, opencode stores forward slashes), and drive
/// letters differ in case. Compared in a normal form so a directory matches
/// itself.
pub(crate) fn same_dir(a: &str, b: &str) -> bool {
    normalize_dir(a) == normalize_dir(b)
}

pub(crate) fn normalize_dir(path: &str) -> String {
    let mut out = path.replace('\\', "/").to_lowercase();
    while out.len() > 1 && out.ends_with('/') {
        out.pop();
    }
    out
}

/// Merge the agent's consecutive steps into one turn.
///
/// Shared by both backends: they disagree about everything except that a turn
/// is "one user message, then whatever the agent did until it asked again".
pub(crate) fn merge_assistant_steps(steps: Vec<Message>) -> Vec<Message> {
    let mut out: Vec<Message> = Vec::with_capacity(steps.len());
    for step in steps {
        let Some(last) = out.last_mut() else {
            out.push(step);
            continue;
        };
        if last.role != "assistant" || step.role != "assistant" {
            out.push(step);
            continue;
        }
        if !step.text.is_empty() {
            if !last.text.is_empty() {
                last.text.push('\n');
            }
            last.text.push_str(&step.text);
        }
        // Last reasoning wins: the earlier blocks are the steps that led to it.
        if step.reasoning.is_some() {
            last.reasoning = step.reasoning;
        }
        last.tools.extend(step.tools);
        last.at = step.at;
    }
    // A turn that neither said anything nor thought anything is pure
    // machinery; its tools are already recorded on the turn it belongs to.
    out.retain(|m| {
        m.role == "user" || !m.text.is_empty() || m.reasoning.is_some() || !m.tools.is_empty()
    });
    out
}
