//! Anthropic Messages <-> OpenAI Chat Completions body conversion.
//!
//! Pure functions over `serde_json::Value`: no IO, no configuration, no
//! knowledge of which relay is on the other end.

use serde_json::{json, Map, Value};

/// Claude Code prefixes `system` with rotating billing metadata. Forwarding it
/// changes the prompt prefix on every request and defeats the relay's prefix
/// cache, so the leading occurrence is dropped.
const BILLING_HEADER_PREFIX: &str = "x-anthropic-billing-header:";

fn strip_billing_header(text: &str) -> &str {
    let trimmed = text.trim_start();
    if !trimmed
        .to_ascii_lowercase()
        .starts_with(BILLING_HEADER_PREFIX)
    {
        return text;
    }
    match trimmed.find('\n') {
        Some(end) => trimmed[end + 1..].trim_start_matches('\n'),
        None => "",
    }
}

/// Models that take `max_completion_tokens` instead of `max_tokens`.
fn is_o_series(model: &str) -> bool {
    let model = model.to_ascii_lowercase();
    let stem = model.rsplit('/').next().unwrap_or(&model);
    stem.starts_with("o1") || stem.starts_with("o3") || stem.starts_with("o4")
}

/// Map an Anthropic `thinking` budget onto an OpenAI `reasoning_effort` tier.
/// The thresholds mirror the tiers Claude Code itself exposes.
pub fn reasoning_effort(body: &Value) -> Option<&'static str> {
    let thinking = body.get("thinking")?;
    if thinking.get("type").and_then(Value::as_str) == Some("disabled") {
        return None;
    }
    let budget = thinking.get("budget_tokens").and_then(Value::as_u64)?;
    Some(match budget {
        0 => return None,
        1..=4096 => "low",
        4097..=16384 => "medium",
        _ => "high",
    })
}

/// Serialize deterministically so an unchanged tool call produces unchanged
/// bytes across turns, which is what keeps the relay's prefix cache warm.
fn stable_json(value: &Value) -> String {
    fn write(value: &Value, out: &mut String) {
        match value {
            Value::Object(map) => {
                let mut keys: Vec<&String> = map.keys().collect();
                keys.sort_unstable();
                out.push('{');
                for (i, key) in keys.iter().enumerate() {
                    if i > 0 {
                        out.push(',');
                    }
                    out.push_str(&Value::String((*key).clone()).to_string());
                    out.push(':');
                    write(&map[*key], out);
                }
                out.push('}');
            }
            Value::Array(items) => {
                out.push('[');
                for (i, item) in items.iter().enumerate() {
                    if i > 0 {
                        out.push(',');
                    }
                    write(item, out);
                }
                out.push(']');
            }
            other => out.push_str(&other.to_string()),
        }
    }
    let mut out = String::new();
    write(value, &mut out);
    out
}

/// Anthropic request -> OpenAI Chat Completions request.
pub fn request_to_openai(body: &Value) -> Value {
    let mut result = Map::new();
    let model = body.get("model").and_then(Value::as_str).unwrap_or("");
    if !model.is_empty() {
        result.insert("model".into(), json!(model));
    }

    let mut messages = Vec::new();
    if let Some(system) = body.get("system") {
        if let Some(text) = system_text(system) {
            messages.push(json!({ "role": "system", "content": text }));
        }
    }
    if let Some(turns) = body.get("messages").and_then(Value::as_array) {
        for turn in turns {
            let role = turn.get("role").and_then(Value::as_str).unwrap_or("user");
            push_openai_messages(role, turn.get("content"), &mut messages);
        }
    }
    result.insert("messages".into(), Value::Array(messages));

    if let Some(v) = body.get("max_tokens") {
        let key = if is_o_series(model) {
            "max_completion_tokens"
        } else {
            "max_tokens"
        };
        result.insert(key.into(), v.clone());
    }
    for (from, to) in [
        ("temperature", "temperature"),
        ("top_p", "top_p"),
        ("stop_sequences", "stop"),
        ("stream", "stream"),
    ] {
        if let Some(v) = body.get(from) {
            result.insert(to.into(), v.clone());
        }
    }
    if let Some(effort) = reasoning_effort(body) {
        result.insert("reasoning_effort".into(), json!(effort));
    }

    if let Some(tools) = body.get("tools").and_then(Value::as_array) {
        let converted: Vec<Value> = tools
            .iter()
            .filter(|tool| tool.get("name").and_then(Value::as_str).is_some())
            .map(|tool| {
                json!({
                    "type": "function",
                    "function": {
                        "name": tool.get("name").and_then(Value::as_str).unwrap_or(""),
                        "description": tool.get("description").cloned().unwrap_or(Value::Null),
                        "parameters": clean_schema(
                            tool.get("input_schema").cloned().unwrap_or_else(|| json!({})),
                            true,
                        ),
                    }
                })
            })
            .collect();
        if !converted.is_empty() {
            result.insert("tools".into(), Value::Array(converted));
        }
    }
    if let Some(choice) = body.get("tool_choice") {
        result.insert("tool_choice".into(), tool_choice_to_openai(choice));
    }

    let mut result = Value::Object(result);
    // Compatible relays omit usage from the stream unless it is asked for, and
    // without it every streamed request records zero tokens.
    if result.get("stream").and_then(Value::as_bool) == Some(true) {
        match result.get_mut("stream_options").and_then(Value::as_object_mut) {
            Some(options) => {
                options.insert("include_usage".into(), json!(true));
            }
            None => result["stream_options"] = json!({ "include_usage": true }),
        }
    }
    result
}

/// Flatten Anthropic's `system` (string or block array) into one system message.
/// Joining rather than emitting one message per block keeps the byte layout
/// stable across turns.
fn system_text(system: &Value) -> Option<String> {
    if let Some(text) = system.as_str() {
        let text = strip_billing_header(text);
        return (!text.is_empty()).then(|| text.to_string());
    }
    let blocks = system.as_array()?;
    let parts: Vec<&str> = blocks
        .iter()
        .filter_map(|block| block.get("text").and_then(Value::as_str))
        .map(strip_billing_header)
        .filter(|text| !text.is_empty())
        .collect();
    (!parts.is_empty()).then(|| parts.join("\n"))
}

/// One Anthropic turn can become several OpenAI messages, because tool results
/// have to leave the turn as their own `tool` role messages.
fn push_openai_messages(role: &str, content: Option<&Value>, out: &mut Vec<Value>) {
    let Some(content) = content else {
        out.push(json!({ "role": role, "content": Value::Null }));
        return;
    };
    if let Some(text) = content.as_str() {
        out.push(json!({ "role": role, "content": text }));
        return;
    }
    let Some(blocks) = content.as_array() else {
        out.push(json!({ "role": role, "content": content.clone() }));
        return;
    };

    let mut parts = Vec::new();
    let mut tool_calls = Vec::new();
    for block in blocks {
        match block.get("type").and_then(Value::as_str).unwrap_or("") {
            "text" => {
                if let Some(text) = block.get("text").and_then(Value::as_str) {
                    parts.push(json!({ "type": "text", "text": text }));
                }
            }
            "image" => {
                if let Some(part) = image_to_openai(block) {
                    parts.push(part);
                }
            }
            "tool_use" => tool_calls.push(json!({
                "id": block.get("id").and_then(Value::as_str).unwrap_or(""),
                "type": "function",
                "function": {
                    "name": block.get("name").and_then(Value::as_str).unwrap_or(""),
                    "arguments": stable_json(block.get("input").unwrap_or(&json!({}))),
                }
            })),
            "tool_result" => out.push(json!({
                "role": "tool",
                "tool_call_id": block
                    .get("tool_use_id")
                    .and_then(Value::as_str)
                    .unwrap_or(""),
                "content": tool_result_text(block.get("content")),
            })),
            _ => {}
        }
    }

    if parts.is_empty() && tool_calls.is_empty() {
        return;
    }
    let mut message = Map::new();
    message.insert("role".into(), json!(role));
    let single_text = (parts.len() == 1)
        .then(|| parts[0].get("text").cloned())
        .flatten();
    message.insert(
        "content".into(),
        match (parts.is_empty(), single_text) {
            (true, _) => Value::Null,
            (false, Some(text)) => text,
            (false, None) => Value::Array(parts),
        },
    );
    if !tool_calls.is_empty() {
        message.insert("tool_calls".into(), Value::Array(tool_calls));
    }
    out.push(Value::Object(message));
}

/// A `tool` role message can only carry text, so structured results are
/// serialized rather than dropped.
fn tool_result_text(content: Option<&Value>) -> String {
    match content {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Array(blocks)) => {
            let parts: Vec<&str> = blocks
                .iter()
                .filter(|block| block.get("type").and_then(Value::as_str) == Some("text"))
                .filter_map(|block| block.get("text").and_then(Value::as_str))
                .collect();
            if parts.is_empty() {
                stable_json(&Value::Array(blocks.clone()))
            } else {
                parts.join("\n")
            }
        }
        Some(value) => stable_json(value),
        None => String::new(),
    }
}

fn image_to_openai(block: &Value) -> Option<Value> {
    let source = block.get("source")?;
    let url = match source.get("type").and_then(Value::as_str) {
        Some("base64") => format!(
            "data:{};base64,{}",
            source
                .get("media_type")
                .and_then(Value::as_str)
                .unwrap_or("image/png"),
            source.get("data").and_then(Value::as_str)?
        ),
        Some("url") => source.get("url").and_then(Value::as_str)?.to_string(),
        _ => return None,
    };
    Some(json!({ "type": "image_url", "image_url": { "url": url } }))
}

fn tool_choice_to_openai(choice: &Value) -> Value {
    match choice {
        // Anthropic spells "at least one tool" as `any`; OpenAI calls it
        // `required` and rejects `any`.
        Value::String(name) if name == "any" => json!("required"),
        Value::String(_) => choice.clone(),
        Value::Object(obj) => match obj.get("type").and_then(Value::as_str) {
            Some("any") => json!("required"),
            Some("auto") => json!("auto"),
            Some("none") => json!("none"),
            Some("tool") => json!({
                "type": "function",
                "function": { "name": obj.get("name").and_then(Value::as_str).unwrap_or("") }
            }),
            _ => choice.clone(),
        },
        _ => choice.clone(),
    }
}

/// Strict relays reject a tool schema whose root omits `type`, and reject
/// `format: uri` on string properties.
fn clean_schema(mut schema: Value, is_root: bool) -> Value {
    let Some(obj) = schema.as_object_mut() else {
        return schema;
    };
    if is_root && !obj.contains_key("type") {
        obj.insert("type".into(), json!("object"));
        obj.entry("properties").or_insert_with(|| json!({}));
    }
    if obj.get("format").and_then(Value::as_str) == Some("uri") {
        obj.remove("format");
    }
    if let Some(properties) = obj.get_mut("properties").and_then(Value::as_object_mut) {
        for value in properties.values_mut() {
            *value = clean_schema(value.take(), false);
        }
    }
    if let Some(items) = obj.get_mut("items") {
        *items = clean_schema(items.take(), false);
    }
    schema
}

/// OpenAI Chat Completions response -> Anthropic Messages response.
pub fn response_to_anthropic(body: &Value) -> Option<Value> {
    let choice = body.get("choices")?.as_array()?.first()?;
    let message = choice.get("message")?;

    let mut content = Vec::new();
    // DeepSeek and its lookalikes carry chain of thought here.
    if let Some(reasoning) = message
        .get("reasoning_content")
        .or_else(|| message.get("reasoning"))
        .and_then(Value::as_str)
    {
        if !reasoning.is_empty() {
            content.push(json!({ "type": "thinking", "thinking": reasoning }));
        }
    }
    match message.get("content") {
        Some(Value::String(text)) if !text.is_empty() => {
            content.push(json!({ "type": "text", "text": text }));
        }
        Some(Value::Array(parts)) => {
            for part in parts {
                let key = match part.get("type").and_then(Value::as_str) {
                    Some("text" | "output_text") => "text",
                    Some("refusal") => "refusal",
                    _ => continue,
                };
                if let Some(text) = part.get(key).and_then(Value::as_str) {
                    if !text.is_empty() {
                        content.push(json!({ "type": "text", "text": text }));
                    }
                }
            }
        }
        _ => {}
    }
    if let Some(refusal) = message.get("refusal").and_then(Value::as_str) {
        if !refusal.is_empty() {
            content.push(json!({ "type": "text", "text": refusal }));
        }
    }

    let mut has_tool_use = false;
    if let Some(tool_calls) = message.get("tool_calls").and_then(Value::as_array) {
        for call in tool_calls {
            has_tool_use = true;
            let function = call.get("function");
            let arguments = function
                .and_then(|f| f.get("arguments"))
                .and_then(Value::as_str)
                .unwrap_or("{}");
            content.push(json!({
                "type": "tool_use",
                "id": call.get("id").and_then(Value::as_str).unwrap_or(""),
                "name": function
                    .and_then(|f| f.get("name"))
                    .and_then(Value::as_str)
                    .unwrap_or(""),
                "input": serde_json::from_str::<Value>(arguments).unwrap_or_else(|_| json!({})),
            }));
        }
    }

    let stop_reason = choice
        .get("finish_reason")
        .and_then(Value::as_str)
        .map(map_finish_reason)
        .or(has_tool_use.then_some("tool_use"));

    Some(json!({
        "id": body.get("id").and_then(Value::as_str).unwrap_or(""),
        "type": "message",
        "role": "assistant",
        "content": content,
        "model": body.get("model").and_then(Value::as_str).unwrap_or(""),
        "stop_reason": stop_reason,
        "stop_sequence": Value::Null,
        "usage": usage_to_anthropic(body.get("usage")),
    }))
}

pub fn map_finish_reason(reason: &str) -> &'static str {
    match reason {
        "length" => "max_tokens",
        "tool_calls" | "function_call" => "tool_use",
        _ => "end_turn",
    }
}

/// OpenAI counts cache hits inside `prompt_tokens`; Anthropic reports the three
/// buckets as disjoint. Subtracting keeps `input + cache_read + cache_creation`
/// equal to what the relay billed.
pub fn usage_to_anthropic(usage: Option<&Value>) -> Value {
    let Some(usage) = usage else {
        return json!({ "input_tokens": 0, "output_tokens": 0 });
    };
    let cache_read = usage
        .get("cache_read_input_tokens")
        .and_then(Value::as_u64)
        .or_else(|| {
            usage
                .pointer("/prompt_tokens_details/cached_tokens")
                .and_then(Value::as_u64)
        })
        .unwrap_or(0);
    let cache_creation = usage
        .get("cache_creation_input_tokens")
        .and_then(Value::as_u64)
        .or_else(|| {
            usage
                .pointer("/prompt_tokens_details/cache_write_tokens")
                .and_then(Value::as_u64)
        })
        .unwrap_or(0);
    let input = usage
        .get("prompt_tokens")
        .and_then(Value::as_u64)
        .unwrap_or(0)
        .saturating_sub(cache_read)
        .saturating_sub(cache_creation);

    let mut out = json!({
        "input_tokens": input,
        "output_tokens": usage.get("completion_tokens").and_then(Value::as_u64).unwrap_or(0),
    });
    if cache_read > 0 {
        out["cache_read_input_tokens"] = json!(cache_read);
    }
    if cache_creation > 0 {
        out["cache_creation_input_tokens"] = json!(cache_creation);
    }
    out
}
