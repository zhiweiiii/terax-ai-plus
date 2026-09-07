//! OpenAI Chat Completions SSE -> Anthropic Messages SSE.
//!
//! A push state machine rather than a stream combinator: the gateway reads
//! upstream chunks on the connection thread, so the converter only has to turn
//! bytes in into bytes out.

use std::collections::{BTreeSet, HashMap};

use serde::Deserialize;
use serde_json::{json, Value};

use super::convert::{map_finish_reason, usage_to_anthropic};
use super::sse::{append_utf8, strip_field, take_block};

#[derive(Deserialize)]
struct Chunk {
    #[serde(default)]
    id: String,
    #[serde(default)]
    model: String,
    #[serde(default)]
    choices: Vec<Choice>,
    #[serde(default)]
    usage: Option<Value>,
}

#[derive(Deserialize)]
struct Choice {
    #[serde(default)]
    delta: Delta,
    #[serde(default)]
    finish_reason: Option<String>,
}

#[derive(Default, Deserialize)]
struct Delta {
    #[serde(default)]
    content: Option<String>,
    // OpenRouter and Kimi say `reasoning`, DeepSeek says `reasoning_content`.
    #[serde(default, alias = "reasoning_content")]
    reasoning: Option<String>,
    #[serde(default)]
    tool_calls: Option<Vec<ToolCallDelta>>,
}

#[derive(Deserialize)]
struct ToolCallDelta {
    #[serde(default)]
    index: usize,
    #[serde(default)]
    id: Option<String>,
    #[serde(default)]
    function: Option<FunctionDelta>,
}

#[derive(Deserialize)]
struct FunctionDelta {
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    arguments: Option<String>,
}

struct ToolBlock {
    index: u32,
    id: String,
    name: String,
    started: bool,
    pending_args: String,
    consecutive_whitespace: usize,
    aborted: bool,
}

/// Some relays get stuck emitting whitespace into a function call forever.
/// Cutting the block off keeps one bad response from running to the token
/// ceiling on the user's subscription.
const RUNAWAY_WHITESPACE: usize = 500;

#[derive(PartialEq, Eq, Clone, Copy)]
enum BlockKind {
    Text,
    Thinking,
}

impl BlockKind {
    fn start_block(self) -> Value {
        match self {
            BlockKind::Text => json!({ "type": "text", "text": "" }),
            BlockKind::Thinking => json!({ "type": "thinking", "thinking": "" }),
        }
    }

    fn delta(self, text: &str) -> Value {
        match self {
            BlockKind::Text => json!({ "type": "text_delta", "text": text }),
            BlockKind::Thinking => json!({ "type": "thinking_delta", "thinking": text }),
        }
    }
}

#[derive(Default)]
pub struct Converter {
    buffer: String,
    remainder: Vec<u8>,
    message_id: Option<String>,
    model: Option<String>,
    next_index: u32,
    sent_start: bool,
    sent_stop: bool,
    errored: bool,
    /// Anthropic allows exactly one `message_delta`. Relays that repeat
    /// `finish_reason` across chunks would otherwise make Claude Code abort.
    emitted_delta: bool,
    /// Held back until `[DONE]` so the usage it carries is the final one.
    pending_delta: Option<(Option<String>, Option<Value>)>,
    latest_usage: Option<Value>,
    open_block: Option<(BlockKind, u32)>,
    tool_blocks: HashMap<usize, ToolBlock>,
    open_tools: BTreeSet<u32>,
}

fn emit(out: &mut Vec<u8>, event: &str, value: &Value) {
    out.extend_from_slice(b"event: ");
    out.extend_from_slice(event.as_bytes());
    out.extend_from_slice(b"\ndata: ");
    out.extend_from_slice(value.to_string().as_bytes());
    out.extend_from_slice(b"\n\n");
}

impl Converter {
    pub fn new() -> Self {
        Self::default()
    }

    /// Feed upstream bytes, get client bytes back.
    pub fn push(&mut self, bytes: &[u8]) -> Vec<u8> {
        let mut out = Vec::new();
        append_utf8(&mut self.buffer, &mut self.remainder, bytes);
        while let Some(block) = take_block(&mut self.buffer) {
            for line in block.lines() {
                let Some(data) = strip_field(line, "data") else {
                    continue;
                };
                let data = data.trim();
                if data == "[DONE]" {
                    self.finish_into(&mut out);
                    continue;
                }
                if let Ok(chunk) = serde_json::from_str::<Chunk>(data) {
                    self.on_chunk(chunk, &mut out);
                }
            }
        }
        out
    }

    /// Close the message when upstream ended without sending `[DONE]`.
    pub fn finish(&mut self) -> Vec<u8> {
        let mut out = Vec::new();
        if !self.errored {
            self.finish_into(&mut out);
        }
        out
    }

    /// Report a transport failure to the client. Suppresses the success tail so
    /// a broken stream is never presented as a completed one.
    pub fn error(&mut self, message: &str) -> Vec<u8> {
        let mut out = Vec::new();
        self.errored = true;
        emit(
            &mut out,
            "error",
            &json!({
                "type": "error",
                "error": { "type": "api_error", "message": message }
            }),
        );
        out
    }

    fn finish_into(&mut self, out: &mut Vec<u8>) {
        if self.sent_stop {
            return;
        }
        if let Some((stop_reason, usage)) = self.pending_delta.take() {
            emit(
                out,
                "message_delta",
                &json!({
                    "type": "message_delta",
                    "delta": { "stop_reason": stop_reason, "stop_sequence": Value::Null },
                    "usage": usage.unwrap_or_else(|| json!({ "input_tokens": 0, "output_tokens": 0 })),
                }),
            );
        } else if !self.sent_start {
            // Upstream closed without producing anything usable.
            return;
        }
        emit(out, "message_stop", &json!({ "type": "message_stop" }));
        self.sent_stop = true;
    }

    fn on_chunk(&mut self, chunk: Chunk, out: &mut Vec<u8>) {
        if self.message_id.is_none() && !chunk.id.is_empty() {
            self.message_id = Some(chunk.id);
        }
        if self.model.is_none() && !chunk.model.is_empty() {
            self.model = Some(chunk.model);
        }

        let chunk_usage = chunk.usage.as_ref().map(|u| usage_to_anthropic(Some(u)));
        if let Some(usage) = &chunk_usage {
            self.latest_usage = Some(usage.clone());
            if let Some((_, pending)) = self.pending_delta.as_mut() {
                *pending = Some(usage.clone());
            }
        }

        let Some(choice) = chunk.choices.into_iter().next() else {
            return;
        };

        if !self.sent_start {
            emit(
                out,
                "message_start",
                &json!({
                    "type": "message_start",
                    "message": {
                        "id": self.message_id.clone().unwrap_or_default(),
                        "type": "message",
                        "role": "assistant",
                        "model": self.model.clone().unwrap_or_default(),
                        "content": [],
                        "stop_reason": Value::Null,
                        "stop_sequence": Value::Null,
                        "usage": chunk_usage
                            .clone()
                            .unwrap_or_else(|| json!({ "input_tokens": 0, "output_tokens": 0 })),
                    }
                }),
            );
            self.sent_start = true;
        }

        if let Some(reasoning) = choice.delta.reasoning.as_deref() {
            if !reasoning.is_empty() {
                self.write_block(BlockKind::Thinking, reasoning, out);
            }
        }
        if let Some(content) = choice.delta.content.as_deref() {
            if !content.is_empty() {
                self.write_block(BlockKind::Text, content, out);
            }
        }
        if let Some(tool_calls) = choice.delta.tool_calls {
            if !tool_calls.is_empty() {
                self.close_open_block(out);
                for call in tool_calls {
                    self.write_tool_call(call, out);
                }
            }
        }

        if let Some(finish_reason) = choice.finish_reason.as_deref() {
            let usage = chunk_usage.or_else(|| self.latest_usage.clone());
            if self.emitted_delta {
                // A later chunk may carry the usage the first one lacked.
                if let (Some((_, pending)), Some(usage)) = (self.pending_delta.as_mut(), usage) {
                    *pending = Some(usage);
                }
                return;
            }
            self.emitted_delta = true;
            self.close_open_block(out);
            self.start_late_tool_blocks(out);
            self.close_tool_blocks(out);
            self.pending_delta =
                Some((Some(map_finish_reason(finish_reason).to_string()), usage));
        }
    }

    fn write_block(&mut self, kind: BlockKind, text: &str, out: &mut Vec<u8>) {
        if self.open_block.map(|(k, _)| k) != Some(kind) {
            self.close_open_block(out);
            let index = self.take_index();
            emit(
                out,
                "content_block_start",
                &json!({
                    "type": "content_block_start",
                    "index": index,
                    "content_block": kind.start_block(),
                }),
            );
            self.open_block = Some((kind, index));
        }
        let Some((_, index)) = self.open_block else {
            return;
        };
        emit(
            out,
            "content_block_delta",
            &json!({
                "type": "content_block_delta",
                "index": index,
                "delta": kind.delta(text),
            }),
        );
    }

    fn write_tool_call(&mut self, call: ToolCallDelta, out: &mut Vec<u8>) {
        let next_index = self.next_index;
        let block = self.tool_blocks.entry(call.index).or_insert_with(|| {
            ToolBlock {
                index: next_index,
                id: String::new(),
                name: String::new(),
                started: false,
                pending_args: String::new(),
                consecutive_whitespace: 0,
                aborted: false,
            }
        });
        if block.index == next_index {
            self.next_index += 1;
        }
        if block.aborted {
            return;
        }

        if let Some(id) = call.id {
            block.id = id;
        }
        let mut arguments = None;
        if let Some(function) = call.function {
            if let Some(name) = function.name {
                block.name = name;
            }
            arguments = function.arguments;
        }

        let start = !block.started && !block.id.is_empty() && !block.name.is_empty();
        if start {
            block.started = true;
        }
        let flushed = (start && !block.pending_args.is_empty())
            .then(|| std::mem::take(&mut block.pending_args));

        let immediate = match arguments {
            Some(args) => {
                for ch in args.chars() {
                    if ch.is_whitespace() {
                        block.consecutive_whitespace += 1;
                    } else {
                        block.consecutive_whitespace = 0;
                    }
                }
                if block.consecutive_whitespace >= RUNAWAY_WHITESPACE {
                    block.aborted = true;
                    None
                } else if block.started {
                    Some(args)
                } else {
                    block.pending_args.push_str(&args);
                    None
                }
            }
            None => None,
        };

        let index = block.index;
        let id = block.id.clone();
        let name = block.name.clone();
        if start {
            emit(
                out,
                "content_block_start",
                &json!({
                    "type": "content_block_start",
                    "index": index,
                    "content_block": { "type": "tool_use", "id": id, "name": name, "input": {} },
                }),
            );
            self.open_tools.insert(index);
        }
        for args in [flushed, immediate].into_iter().flatten() {
            emit(
                out,
                "content_block_delta",
                &json!({
                    "type": "content_block_delta",
                    "index": index,
                    "delta": { "type": "input_json_delta", "partial_json": args },
                }),
            );
        }
    }

    /// Open any tool block that accumulated arguments before its id or name
    /// arrived. Dropping it would silently lose the call.
    fn start_late_tool_blocks(&mut self, out: &mut Vec<u8>) {
        let mut late: Vec<(u32, String, String, String)> = Vec::new();
        for (key, block) in self.tool_blocks.iter_mut() {
            if block.started || block.aborted {
                continue;
            }
            if block.pending_args.is_empty() && block.id.is_empty() && block.name.is_empty() {
                continue;
            }
            block.started = true;
            let id = if block.id.is_empty() {
                format!("tool_call_{key}")
            } else {
                block.id.clone()
            };
            let name = if block.name.is_empty() {
                "unknown_tool".to_string()
            } else {
                block.name.clone()
            };
            late.push((block.index, id, name, std::mem::take(&mut block.pending_args)));
        }
        late.sort_unstable_by_key(|(index, _, _, _)| *index);
        for (index, id, name, pending) in late {
            emit(
                out,
                "content_block_start",
                &json!({
                    "type": "content_block_start",
                    "index": index,
                    "content_block": { "type": "tool_use", "id": id, "name": name, "input": {} },
                }),
            );
            self.open_tools.insert(index);
            if !pending.is_empty() {
                emit(
                    out,
                    "content_block_delta",
                    &json!({
                        "type": "content_block_delta",
                        "index": index,
                        "delta": { "type": "input_json_delta", "partial_json": pending },
                    }),
                );
            }
        }
    }

    fn close_open_block(&mut self, out: &mut Vec<u8>) {
        if let Some((_, index)) = self.open_block.take() {
            emit(
                out,
                "content_block_stop",
                &json!({ "type": "content_block_stop", "index": index }),
            );
        }
    }

    fn close_tool_blocks(&mut self, out: &mut Vec<u8>) {
        for index in std::mem::take(&mut self.open_tools) {
            emit(
                out,
                "content_block_stop",
                &json!({ "type": "content_block_stop", "index": index }),
            );
        }
    }

    fn take_index(&mut self) -> u32 {
        let index = self.next_index;
        self.next_index += 1;
        index
    }
}
