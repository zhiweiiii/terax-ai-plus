//! SSE framing helpers for the upstream reader.

/// Strip an SSE field prefix, tolerating the optional space after the colon.
pub fn strip_field<'a>(line: &'a str, field: &str) -> Option<&'a str> {
    let rest = line.strip_prefix(field)?.strip_prefix(':')?;
    Some(rest.strip_prefix(' ').unwrap_or(rest))
}

/// Take one complete event block off the front of the buffer. Returns `None`
/// while the terminator has not arrived yet, which is the normal state halfway
/// through a chunk.
pub fn take_block(buffer: &mut String) -> Option<String> {
    let mut best: Option<(usize, usize)> = None;
    for (delimiter, len) in [("\r\n\r\n", 4usize), ("\n\n", 2usize)] {
        if let Some(pos) = buffer.find(delimiter) {
            if best.is_none_or(|(best_pos, _)| pos < best_pos) {
                best = Some((pos, len));
            }
        }
    }
    let (pos, len) = best?;
    let block = buffer[..pos].to_string();
    buffer.drain(..pos + len);
    Some(block)
}

/// Append raw bytes to a UTF-8 buffer, holding back a multi-byte character that
/// a chunk boundary cut in half. Without this a split character decodes to a
/// replacement char and corrupts the JSON payload it sits in.
pub fn append_utf8(buffer: &mut String, remainder: &mut Vec<u8>, bytes: &[u8]) {
    let combined: Option<Vec<u8>> = if remainder.is_empty() {
        None
    } else if remainder.len() > MAX_UTF8_REMAINDER {
        // Cannot happen on well-formed input: flush lossily and resynchronize.
        buffer.push_str(&String::from_utf8_lossy(remainder));
        remainder.clear();
        None
    } else {
        let mut combined = std::mem::take(remainder);
        combined.extend_from_slice(bytes);
        Some(combined)
    };
    let input: &[u8] = combined.as_deref().unwrap_or(bytes);

    let mut pos = 0;
    loop {
        match std::str::from_utf8(&input[pos..]) {
            Ok(text) => {
                buffer.push_str(text);
                return;
            }
            Err(e) => {
                let valid_up_to = pos + e.valid_up_to();
                buffer.push_str(&String::from_utf8_lossy(&input[pos..valid_up_to]));
                match e.error_len() {
                    Some(invalid_len) => {
                        buffer.push('\u{FFFD}');
                        pos = valid_up_to + invalid_len;
                    }
                    None => {
                        *remainder = input[valid_up_to..].to_vec();
                        return;
                    }
                }
            }
        }
    }
}

/// The longest incomplete UTF-8 sequence is a 4-byte character missing its last
/// byte.
const MAX_UTF8_REMAINDER: usize = 3;
