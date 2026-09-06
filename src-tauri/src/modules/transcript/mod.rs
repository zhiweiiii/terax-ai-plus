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

/// One piece of a turn, in the order the agent produced it.
///
/// A turn is not "some prose and some tool calls", it is prose, then the tools
/// that prose led to, then more prose. Collapsing it into two flat lists put
/// every command at the bottom of the answer, so the phone showed all the
/// writing together and all the commands together while the desktop showed
/// them interleaved.
#[derive(Serialize, Clone, Debug)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Part {
    /// Prose the agent wrote.
    Text { text: String },
    /// A tool it ran before writing the next piece, and what came back.
    ///
    /// The agent records the call and its result as structured fields linked
    /// by an id, so this is read rather than recognised: no screen scraping,
    /// no matching on how the TUI happens to draw a command today, and nothing
    /// to de-duplicate against, because it is the same record the conversation
    /// itself comes from.
    Tool {
        /// "Bash", "Read", "Edit".
        name: String,
        /// What it was called on, in one line: the command for Bash, the path
        /// for Read. This is what the desktop prints in parentheses after the
        /// tool name.
        #[serde(skip_serializing_if = "Option::is_none")]
        subject: Option<String>,
        /// What it printed, truncated - see `TOOL_OUTPUT_LINES`. None while
        /// the call is still outstanding.
        #[serde(skip_serializing_if = "Option::is_none")]
        output: Option<String>,
        /// Lines truncation dropped, so the page can say how much is missing
        /// instead of quietly showing less than there was.
        #[serde(skip_serializing_if = "is_zero")]
        elided: usize,
        /// The tool reported failure.
        #[serde(skip_serializing_if = "is_false")]
        failed: bool,
    },
}

fn is_zero(n: &usize) -> bool {
    *n == 0
}

fn is_false(b: &bool) -> bool {
    !*b
}

/// Lines of a tool's output carried to the phone, and the byte ceiling that
/// bounds a single very long line.
///
/// A transcript is mostly tool results - the biggest on this machine is 48 MB
/// of them - and the phone is showing a conversation, not an archive. Enough
/// to see what a command did, with the count of what was dropped.
const TOOL_OUTPUT_LINES: usize = 10;
const TOOL_OUTPUT_BYTES: usize = 800;

/// Trim a tool's output to something a phone can show, reporting how many
/// lines were dropped.
pub(crate) fn clip_output(text: &str) -> (String, usize) {
    let text = text.trim_end();
    if text.is_empty() {
        return (String::new(), 0);
    }
    let total = text.lines().count();
    let mut out = String::new();
    let mut kept = 0;
    for line in text.lines().take(TOOL_OUTPUT_LINES) {
        if out.len() + line.len() > TOOL_OUTPUT_BYTES && kept > 0 {
            break;
        }
        if kept > 0 {
            out.push('\n');
        }
        out.push_str(line);
        kept += 1;
    }
    out.truncate(
        out.char_indices()
            .map(|(i, c)| i + c.len_utf8())
            .take_while(|end| *end <= TOOL_OUTPUT_BYTES)
            .last()
            .unwrap_or(0),
    );
    (out, total.saturating_sub(kept))
}

/// One turn of the conversation.
///
/// Consecutive steps by the agent are merged into a single turn: both tools
/// write a row per model round trip (a tool call, its result, the next call),
/// and a reader wants the answer, not the machinery. Merging concatenates
/// `parts`, so the order within the turn survives it.
#[derive(Serialize, Clone, Debug)]
pub struct Message {
    pub id: String,
    /// "user" or "assistant".
    pub role: &'static str,
    /// Epoch milliseconds.
    pub at: i64,
    /// What was said: the message for a user turn, the prose flattened out of
    /// `parts` for an agent one. Empty for a turn that only ran tools. This is
    /// what comparisons are made against — echo matching, screen de-duplication
    /// — where the structure is not wanted.
    pub text: String,
    /// The agent's own reasoning for this turn, last block only - the earlier
    /// ones are steps toward it and reading them all back is not thinking, it
    /// is a transcript of thinking.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reasoning: Option<String>,
    /// The turn as it happened. Empty for a user turn, whose whole content is
    /// `text`.
    pub parts: Vec<Part>,
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
        for part in step.parts {
            push_part(&mut last.parts, part);
        }
        last.at = step.at;
    }
    // A turn that neither said anything nor thought anything is pure
    // machinery; its tools are already recorded on the turn it belongs to.
    out.retain(|m| {
        m.role == "user" || !m.text.is_empty() || m.reasoning.is_some() || !m.parts.is_empty()
    });
    out
}

/// Append a part, folding consecutive prose together.
///
/// Two prose blocks in a row are one run of writing, so they merge; a tool
/// call always stands on its own, where it ran. Empty prose is dropped rather
/// than rendered as a gap.
pub(crate) fn push_part(parts: &mut Vec<Part>, part: Part) {
    match part {
        Part::Text { text } if text.is_empty() => {}
        Part::Text { text } => match parts.last_mut() {
            Some(Part::Text { text: last }) => {
                last.push('\n');
                last.push_str(&text);
            }
            _ => parts.push(Part::Text { text }),
        },
        // Tool calls are never folded together: each one carries its own
        // subject and its own output, and they are shown where they ran.
        tool => parts.push(tool),
    }
}

/// The prose out of a turn's parts, joined the way the old flat `text` was.
pub(crate) fn flatten_text(parts: &[Part]) -> String {
    let mut out = String::new();
    for part in parts {
        if let Part::Text { text } = part {
            if !out.is_empty() {
                out.push('\n');
            }
            out.push_str(text);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn step(role: &'static str, parts: Vec<Part>) -> Message {
        Message {
            id: "x".into(),
            role,
            at: 0,
            text: flatten_text(&parts),
            reasoning: None,
            parts,
        }
    }

    fn text(t: &str) -> Part {
        Part::Text { text: t.into() }
    }

    fn tool(name: &str, subject: &str) -> Part {
        Part::Tool {
            name: name.into(),
            subject: (!subject.is_empty()).then(|| subject.into()),
            output: None,
            elided: 0,
            failed: false,
        }
    }

    fn shape(parts: &[Part]) -> Vec<String> {
        parts
            .iter()
            .map(|p| match p {
                Part::Text { text } => format!("text:{text}"),
                Part::Tool { name, subject, .. } => {
                    format!("tool:{name}({})", subject.as_deref().unwrap_or(""))
                }
            })
            .collect()
    }

    #[test]
    fn push_part_folds_prose_but_never_tools() {
        let mut parts = Vec::new();
        push_part(&mut parts, text("a"));
        push_part(&mut parts, text(""));
        push_part(&mut parts, text("b"));
        push_part(&mut parts, tool("Read", "a.rs"));
        push_part(&mut parts, tool("Read", "b.rs"));
        push_part(&mut parts, text("c"));
        assert_eq!(
            shape(&parts),
            vec![
                "text:a\nb",
                "tool:Read(a.rs)",
                "tool:Read(b.rs)",
                "text:c",
            ],
            "prose merges; two Reads stay two calls, because they read different files"
        );
    }

    /// The whole point of `parts`. A turn is prose, the tools it led to, then
    /// more prose; flattening that into "all the text, then all the tools" put
    /// every command under the whole answer, so the phone grouped the writing
    /// and the commands into two lumps while the desktop interleaved them.
    #[test]
    fn merging_steps_keeps_prose_and_tools_interleaved() {
        let merged = merge_assistant_steps(vec![
            step("user", vec![]),
            step("assistant", vec![text("looking"), tool("Bash", "ls")]),
            step("assistant", vec![text("found it"), tool("Read", "a.rs")]),
            step("assistant", vec![text("done")]),
        ]);
        assert_eq!(merged.len(), 2, "one user turn and one merged agent turn");
        assert_eq!(
            shape(&merged[1].parts),
            vec![
                "text:looking",
                "tool:Bash(ls)",
                "text:found it",
                "tool:Read(a.rs)",
                "text:done",
            ]
        );
        // The flat view stays the prose only, in order: it is what echo
        // matching and screen de-duplication compare against.
        assert_eq!(merged[1].text, "looking\nfound it\ndone");
    }

    #[test]
    fn a_user_turn_ends_the_merge() {
        let merged = merge_assistant_steps(vec![
            step("assistant", vec![text("first")]),
            step("user", vec![]),
            step("assistant", vec![text("second")]),
        ]);
        assert_eq!(merged.len(), 3);
        assert_eq!(shape(&merged[0].parts), vec!["text:first"]);
        assert_eq!(shape(&merged[2].parts), vec!["text:second"]);
    }

    #[test]
    fn a_step_that_only_ran_tools_is_kept() {
        let merged = merge_assistant_steps(vec![step("assistant", vec![tool("Grep", "todo")])]);
        assert_eq!(shape(&merged[0].parts), vec!["tool:Grep(todo)"]);
        assert!(merged[0].text.is_empty());
    }

    #[test]
    fn clip_output_keeps_a_head_and_counts_the_rest() {
        let long = (1..=30)
            .map(|n| format!("line {n}"))
            .collect::<Vec<_>>()
            .join("\n");
        let (kept, elided) = clip_output(&long);
        assert_eq!(kept.lines().count(), TOOL_OUTPUT_LINES);
        assert_eq!(elided, 30 - TOOL_OUTPUT_LINES);
        assert!(kept.starts_with("line 1"));

        // Short output is carried whole, with nothing claimed to be missing.
        let (kept, elided) = clip_output("just this");
        assert_eq!(kept, "just this");
        assert_eq!(elided, 0);
    }

    #[test]
    fn clip_output_bounds_one_enormous_line() {
        let (kept, _) = clip_output(&"x".repeat(10_000));
        assert!(kept.len() <= TOOL_OUTPUT_BYTES, "got {} bytes", kept.len());
    }
}
