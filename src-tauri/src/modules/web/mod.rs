//! Web terminal bridge: exposes the running PTY sessions over HTTP + WebSocket
//! on port 34269 (dev) / 34268 (release) so a phone / other machine can watch
//! or drive the command lines from a plain browser page.
//!
//!   GET /     → embedded mobile page (single-file HTML, served as-is)
//!   GET /ws   → WebSocket (ttyd-style binary protocol, extended with a
//!               session list / attach handshake for multi-terminal support)
//!
//! Wire protocol (client → server):
//!   First message (text): { "attach": <id> } or { "list": true }
//!   Later (binary, first byte is the command):
//!     '0' + bytes        → write input to the attached session
//!     '1' + JSON         → resize { "cols": N, "rows": N } (kept for
//!                          completeness; the current page never sends it —
//!                          the desktop owns the PTY size)
//!   Later (text):        { "attach": <id> }        → switch session
//!
//! Wire protocol (server → client):
//!   binary '0' + bytes   → terminal output
//!   binary '1' + bytes   → window title (UTF-8)
//!   text  { "type": "sessions", "sessions": [ {id,cwd,title,active,live,space} ] }
//!   text  { "type": "attached", "id": N }
//!   text  { "type": "exit", "id": N, "code": C }
//!   text  { "type": "error", "message": "..." }
//!
//! The WebSocket implementation is minimal (RFC 6455) — handshake + framing
//! only — because the rest of the crate has no HTTP/WS framework and this is
//! the only WebSocket endpoint.

use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::Duration;

use base64::Engine;
use serde_json::{json, Value};
use sha1::{Digest, Sha1};

use crate::modules::pty::{PtyState, Session, WebMsg};
use tauri::Manager;

// Dev builds listen on 34269, packaged (release) builds on 34268 — so the two
// can run side by side without clashing, and the phone can pick the right one.
const PORT: u16 = if cfg!(debug_assertions) { 34269 } else { 34268 };
const BIND_ADDR: &str = "0.0.0.0";

// The mobile page is embedded at build time by scripts/build-web.mjs.
const INDEX_HTML: &str = include_str!("../../../web.html");

const WS_GUID: &[u8] = b"258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

// ──────────────────────────────────────────────────────────────────────────
// Obfuscated auth constants
// ──────────────────────────────────────────────────────────────────────────
// The password digest and the auth cookie token are XOR-obfuscated at compile
// time and decoded at runtime, so neither the plaintext password nor the token
// shows up in `strings` on the binary. This is obfuscation, not real security:
// anyone who can run the code can recover the values (see docs/issues.md #3).

/// Recover an obfuscated byte constant. The caller keeps it in a fixed-size
/// buffer; nothing is logged or sent to the page bundle.
fn deobfuscate(encoded: &[u8]) -> Vec<u8> {
    encoded
        .iter()
        .zip(OBFUSCATION_KEY.iter().cycle())
        .map(|(b, k)| b ^ k)
        .collect()
}

/// Key used to encode the constants below.
const OBFUSCATION_KEY: [u8; 5] = [0x53, 0x2a, 0x7c, 0x91, 0x0d];

/// Auth cookie value — a fixed string, XOR-obfuscated so the token (which is
/// independent of the password) is not readable from the binary. It is only
/// ever compared in memory, never transmitted to the page bundle; the token
/// never rotates (weakness tracked in docs/issues.md #3).
fn web_token() -> String {
    const ENCODED: [u8; 48] = [
        0x6b, 0x13, 0x4d, 0xa1, 0x69, 0x30, 0x4e, 0x4a, 0xa8, 0x38, 0x64, 0x4c,
        0x19, 0xf3, 0x68, 0x63, 0x1c, 0x1d, 0xa4, 0x35, 0x61, 0x4e, 0x18, 0xf7,
        0x3f, 0x32, 0x18, 0x4f, 0xf5, 0x6b, 0x60, 0x48, 0x19, 0xa3, 0x3e, 0x65,
        0x1d, 0x1e, 0xf4, 0x35, 0x61, 0x4b, 0x1a, 0xa4, 0x3d, 0x62, 0x19, 0x4c,
    ];
    String::from_utf8(deobfuscate(&ENCODED)).expect("web token is ascii")
}

/// SHA-1 digest of the access password, XOR-obfuscated. The plaintext password
/// is never stored anywhere; only this digest exists, decoded at runtime for
/// the constant-time comparison in `/auth`.
fn expected_digest() -> Vec<u8> {
    const ENCODED: [u8; 20] = [
        0x1c, 0x0a, 0x53, 0x33, 0xdf, 0x92, 0x31, 0x77, 0x18, 0xc1,
        0x32, 0xba, 0xab, 0x4d, 0xfc, 0xca, 0x2e, 0xc0, 0x92, 0xe0,
    ];
    deobfuscate(&ENCODED)
}

static SHUTDOWN: AtomicBool = AtomicBool::new(false);

/// True while the accept loop is actually listening (set after a successful
/// bind, cleared when the loop exits / stop() runs). Drives the desktop's
/// "remote service" indicator.
static RUNNING: AtomicBool = AtomicBool::new(false);

/// Live WebSocket connections; /ws is rejected once MAX_CONNECTIONS is hit so
/// a runaway client can't pile up unbounded threads.
static CONNECTIONS: std::sync::atomic::AtomicUsize =
    std::sync::atomic::AtomicUsize::new(0);
const MAX_CONNECTIONS: usize = 8;

/// Failed login attempts since boot (rate limit: >=5 consecutive fails = 5s
/// delay before the next attempt is even evaluated).
static FAILED_LOGINS: std::sync::atomic::AtomicUsize =
    std::sync::atomic::AtomicUsize::new(0);
/// Timestamp (Instant millis) of the last failed login, for the lockout.
static LAST_FAIL: std::sync::atomic::AtomicU64 =
    std::sync::atomic::AtomicU64::new(0);

/// Start the web terminal server on 0.0.0.0:34269 (dev) / 34268 (release).
/// Returns an error only if the port cannot be bound; the accept loop runs on
/// its own thread.
pub fn start(app: tauri::AppHandle) -> Result<(), String> {
    SHUTDOWN.store(false, Ordering::Release);
    RUNNING.store(false, Ordering::Release);
    // Make sure the page always has at least one terminal to attach to, even
    // before the desktop opens any tab.
    if let Some(state) = app.try_state::<PtyState>() {
        state.web_ensure_session(&app);
    }
    let listener = TcpListener::bind((BIND_ADDR, PORT)).map_err(|e| {
        format!("web terminal: failed to bind {BIND_ADDR}:{PORT}: {e}")
    })?;
    log::info!("web terminal server listening on http://{BIND_ADDR}:{PORT}");
    RUNNING.store(true, Ordering::Release);
    thread::Builder::new()
        .name("terax-web-accept".into())
        .spawn(move || {
            for stream in listener.incoming() {
                if SHUTDOWN.load(Ordering::Acquire) {
                    break;
                }
                match stream {
                    Ok(stream) => {
                        let app = app.clone();
                        let _ = stream.set_nodelay(true);
                        thread::Builder::new()
                            .name("terax-web-conn".into())
                            .spawn(move || handle_connection(app, stream))
                            .expect("spawn web connection thread");
                    }
                    Err(e) => {
                        log::warn!("web terminal: accept error: {e}");
                    }
                }
            }
        })
        .expect("spawn web accept thread");
    Ok(())
}

pub fn stop() {
    SHUTDOWN.store(true, Ordering::Release);
    RUNNING.store(false, Ordering::Release);
}

/// Snapshot of the web terminal server for the desktop status bar.
#[derive(serde::Serialize)]
pub struct WebStatus {
    /// Whether the accept loop is listening (bound + not stopped).
    running: bool,
    /// Live WebSocket viewer connections right now.
    connections: usize,
    /// Consecutive failed logins since boot (drives the 5s lockout).
    failed_logins: usize,
}

/// Tauri command: report the remote service's connection count and whether it
/// is up. Polled by the desktop status bar indicator.
#[tauri::command]
pub fn web_status() -> WebStatus {
    WebStatus {
        running: RUNNING.load(Ordering::Acquire),
        connections: CONNECTIONS.load(Ordering::Acquire),
        failed_logins: FAILED_LOGINS.load(Ordering::Acquire),
    }
}

// ──────────────────────────────────────────────────────────────────────────
// Minimal WebSocket (RFC 6455)
// ──────────────────────────────────────────────────────────────────────────

const OP_CONT: u8 = 0x0;
const OP_TEXT: u8 = 0x1;
const OP_BIN: u8 = 0x2;
const OP_CLOSE: u8 = 0x8;
const OP_PING: u8 = 0x9;
const OP_PONG: u8 = 0xA;

struct WsConn {
    stream: TcpStream,
    /// All bytes read but not yet consumed by the message parser. Includes
    /// anything past the HTTP head terminator (early WS frames) and every
    /// partial frame: parsing consumes only *complete* messages, so a
    /// fragmented frame is never lost and never misparsed.
    buffer: Vec<u8>,
    /// Consume cursor into `buffer`.
    consume: usize,
    /// Last time any byte was read (drives the dead-peer timeout).
    last_read_at: std::time::Instant,
}

impl WsConn {
    /// `head` is the full request head (up to and including \r\n\r\n); any
    /// bytes past the terminator were already in the receive buffer and
    /// belong to the WebSocket stream.
    fn from_handshake(mut stream: TcpStream, head: Vec<u8>) -> Result<Self, String> {
        stream
            .set_read_timeout(Some(Duration::from_secs(5)))
            .map_err(|e| e.to_string())?;
        let head_text = String::from_utf8_lossy(&head);
        let mut lines = head_text.lines();
        let request_line = lines.next().unwrap_or("");
        if !request_line.starts_with("GET ") {
            return Err("not a GET request".into());
        }
        let mut key = None;
        const KEY_PREFIX: &str = "sec-websocket-key:";
        for line in lines {
            let lower = line.to_ascii_lowercase();
            if lower.strip_prefix(KEY_PREFIX).is_some() {
                // Index the original line by the prefix length (case folding
                // does not change byte length) to grab the key value.
                key = Some(line[KEY_PREFIX.len()..].trim().to_string());
            }
        }
        let key = key.ok_or_else(|| "missing Sec-WebSocket-Key".to_string())?;

        let accept = {
            let mut hasher = Sha1::new();
            hasher.update(key.as_bytes());
            hasher.update(WS_GUID);
            base64::engine::general_purpose::STANDARD.encode(hasher.finalize())
        };
        let response = format!(
            "HTTP/1.1 101 Switching Protocols\r\n\
             Upgrade: websocket\r\n\
             Connection: Upgrade\r\n\
             Sec-WebSocket-Accept: {accept}\r\n\r\n"
        );
        stream
            .write_all(response.as_bytes())
            .map_err(|e| e.to_string())?;
        stream.flush().map_err(|e| e.to_string())?;
        // Non-blocking reads: handle_ws polls for complete messages while
        // draining session output between polls. Partial frames stay in
        // `buffer` until they are complete — a fragmented frame is never
        // lost, so quiet phones no longer get disconnected (issue #41).
        stream
            .set_nonblocking(true)
            .map_err(|e| e.to_string())?;

        let terminator = head
            .windows(4)
            .position(|w| w == b"\r\n\r\n")
            .map(|p| p + 4)
            .unwrap_or(head.len());
        let buffer = head[terminator..].to_vec();
        Ok(Self {
            stream,
            buffer,
            consume: 0,
            last_read_at: std::time::Instant::now(),
        })
    }

    /// Try to parse one complete message out of the buffer. Returns
    /// `Ok(Some(...))` on a full message (consuming its bytes), `Ok(None)`
    /// when more bytes are needed (nothing is consumed), `Err` on protocol
    /// violations. Partial frames are never discarded.
    fn try_parse_message(&mut self) -> Result<Option<(u8, Vec<u8>)>, String> {
        let buf = self.buffer.as_slice();
        let mut pos = self.consume;
        let mut result_op: Option<u8> = None;
        let mut result = Vec::new();
        let mut total = 0usize;
        loop {
            if buf.len() - pos < 2 {
                return Ok(None);
            }
            let fin = buf[pos] & 0x80 != 0;
            let opcode = buf[pos] & 0x0F;
            let masked = buf[pos + 1] & 0x80 != 0;
            let mut len = (buf[pos + 1] & 0x7F) as usize;
            pos += 2;
            if len == 126 {
                if buf.len() - pos < 2 {
                    return Ok(None);
                }
                len = u16::from_be_bytes([buf[pos], buf[pos + 1]]) as usize;
                pos += 2;
            } else if len == 127 {
                if buf.len() - pos < 8 {
                    return Ok(None);
                }
                let mut ext = [0u8; 8];
                ext.copy_from_slice(&buf[pos..pos + 8]);
                len = u64::from_be_bytes(ext) as usize;
                pos += 8;
            }
            // Control frames must be small per RFC 6455; data frames capped
            // per-frame, and the reassembled message capped as a whole so
            // unlimited continuation frames cannot grow memory without bound.
            if opcode >= OP_CLOSE && len > 125 {
                return Err("ws control frame too large".into());
            }
            if len > 1024 * 1024 {
                return Err("ws frame too large".into());
            }
            if result_op.is_some() && total + len > 1024 * 1024 {
                return Err("ws message too large".into());
            }
            let mut mask = [0u8; 4];
            if masked {
                if buf.len() - pos < 4 {
                    return Ok(None);
                }
                mask.copy_from_slice(&buf[pos..pos + 4]);
                pos += 4;
            } else if opcode < OP_CLOSE {
                // RFC 6455: client frames MUST be masked. A browser always
                // masks; an unmasked data frame means a hand-rolled client.
                // Strict per spec, so malformed peers fail fast instead of
                // being interpreted leniently (issue #16).
                return Err("ws client frame not masked".into());
            }
            if buf.len() - pos < len {
                return Ok(None);
            }
            let mut payload = buf[pos..pos + len].to_vec();
            pos += len;
            if masked {
                for (i, b) in payload.iter_mut().enumerate() {
                    *b ^= mask[i % 4];
                }
            }
            match opcode {
                OP_CONT => {
                    total += len;
                    result.extend_from_slice(&payload);
                }
                OP_TEXT | OP_BIN => {
                    result_op = Some(opcode);
                    total += len;
                    result.extend_from_slice(&payload);
                }
                OP_CLOSE | OP_PING | OP_PONG => {
                    self.consume = pos;
                    return Ok(Some((opcode, payload)));
                }
                _ => return Err("unknown ws opcode".into()),
            }
            if fin {
                if let Some(op) = result_op {
                    self.consume = pos;
                    return Ok(Some((op, result)));
                }
                return Err("continuation without initial frame".into());
            }
        }
    }

    /// Read one message, blocking up to the read loop's poll cadence.
    /// Returns `Ok(Some(msg))`, or `Ok(None)` when no complete message is
    /// available yet (the caller drains output and polls again). Protocol
    /// and I/O failures surface as `Err`.
    fn read_message(&mut self) -> Result<Option<(u8, Vec<u8>)>, String> {
        loop {
            if let Some(msg) = self.try_parse_message()? {
                return Ok(Some(msg));
            }
            // Compact consumed bytes so the buffer can't grow without bound.
            if self.consume > 0 {
                self.buffer.drain(..self.consume);
                self.consume = 0;
            }
            if self.buffer.len() > 4 * 1024 * 1024 {
                // Only reachable with many interleaved partial frames; cap it
                // so a misbehaving client cannot balloon memory.
                return Err("ws buffer overflow".into());
            }
            let mut chunk = [0u8; 8192];
            match self.stream.read(&mut chunk) {
                Ok(0) => return Err("read ws bytes: eof".into()),
                Ok(n) => {
                    self.buffer.extend_from_slice(&chunk[..n]);
                    self.last_read_at = std::time::Instant::now();
                }
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    return Ok(None);
                }
                Err(e) => return Err(format!("read ws bytes: {e}")),
            }
        }
    }

    /// Send a single-frame message. Server frames are never masked.
    fn send_frame(&mut self, opcode: u8, payload: &[u8]) -> Result<(), String> {
        let mut head = Vec::with_capacity(10);
        head.push(0x80 | opcode);
        let len = payload.len();
        if len < 126 {
            head.push(len as u8);
        } else if len <= 0xFFFF {
            head.push(126);
            head.extend_from_slice(&(len as u16).to_be_bytes());
        } else {
            head.push(127);
            head.extend_from_slice(&(len as u64).to_be_bytes());
        }
        self.write_all_blocking(&head)?;
        if !payload.is_empty() {
            self.write_all_blocking(payload)?;
        }
        self.stream.flush().map_err(|e| e.to_string())
    }

    /// `write_all` on a non-blocking socket returns WouldBlock mid-write and
    /// loses the partial write; poll instead so big frames (history replay)
    /// still go out. A peer that never reads eventually errors out.
    fn write_all_blocking(&mut self, mut data: &[u8]) -> Result<(), String> {
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        while !data.is_empty() {
            if std::time::Instant::now() > deadline {
                return Err("write ws bytes: timeout".into());
            }
            match self.stream.write(data) {
                Ok(0) => return Err("write ws bytes: eof".into()),
                Ok(n) => data = &data[n..],
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    thread::sleep(Duration::from_millis(5));
                }
                Err(e) => return Err(format!("write ws bytes: {e}")),
            }
        }
        Ok(())
    }
}

// ──────────────────────────────────────────────────────────────────────────
// Connection handling
// ──────────────────────────────────────────────────────────────────────────

fn handle_connection(app: tauri::AppHandle, mut stream: TcpStream) {
    stream
        .set_read_timeout(Some(Duration::from_secs(5)))
        .ok();
    // Read the complete request head (up to \r\n\r\n). Any bytes past the
    // terminator belong to the WebSocket stream and are kept in `head`.
    let mut head = Vec::with_capacity(2048);
    let mut buf = [0u8; 2048];
    let mut header_end = None;
    loop {
        match stream.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
                head.extend_from_slice(&buf[..n]);
                if let Some(pos) = head.windows(4).position(|w| w == b"\r\n\r\n") {
                    header_end = Some(pos + 4);
                    break;
                }
                if head.len() > 16 * 1024 {
                    break;
                }
            }
            Err(_) => break,
        }
    }
    let Some(header_end) = header_end else {
        return;
    };
    let head_text = String::from_utf8_lossy(&head[..header_end]);
    let mut lines = head_text.lines();
    let request_line = lines.next().unwrap_or("");
    let mut is_upgrade = false;
    let mut cookie: Option<String> = None;
    for line in lines {
        let lower = line.to_ascii_lowercase();
        if lower.starts_with("upgrade: websocket") {
            is_upgrade = true;
        } else if lower.starts_with("cookie:") {
            cookie = Some(line[line.find(':').unwrap_or(6) + 1..].trim().to_string());
        }
    }
    let authenticated = cookie
        .as_deref()
        .map(|c| c.split(';').any(|part| part.trim() == format!("terax_web={}", web_token())))
        .unwrap_or(false);
    let path = request_line.split_whitespace().nth(1).unwrap_or("/");

    // Login endpoint: verify the password, then set the auth cookie.
    if path == "/auth" {
        // POST only — GET would put the password in URLs and access logs.
        let mut is_post = false;
        let mut content_length = 0usize;
        for line in head_text.lines() {
            let upper = line.to_ascii_uppercase();
            if upper.starts_with("POST ") {
                is_post = true;
            } else if upper.starts_with("CONTENT-LENGTH:") {
                content_length = line
                    .split_once(':')
                    .and_then(|(_, v)| v.trim().parse::<usize>().ok())
                    .unwrap_or(0);
            }
        }
        let pwd: String = if is_post {
            // The body may not have arrived in the same read as the head
            // (TCP fragmentation): read the remaining Content-Length bytes.
            let have = head.len().saturating_sub(header_end);
            let need = content_length.saturating_sub(have);
            if need > 0 && need <= 256 {
                let mut rest = vec![0u8; need];
                let _ = stream.read_exact(&mut rest);
                String::from_utf8_lossy(&rest).trim().to_string()
            } else if content_length <= 256 && have >= content_length {
                String::from_utf8_lossy(&head[header_end..header_end + content_length])
                    .trim()
                    .to_string()
            } else {
                String::new()
            }
        } else {
            String::new()
        };

        // Brute-force lockout: 5+ consecutive failures impose a 5s delay.
        if FAILED_LOGINS.load(Ordering::Acquire) >= 5 {
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0);
            let last = LAST_FAIL.load(Ordering::Acquire);
            if now.saturating_sub(last) < 5000 {
                let body = "<html><body><p>too many attempts, try again later</p></body></html>";
                let response = format!(
                    "HTTP/1.1 429 Too Many Requests\r\nContent-Type: text/html; charset=utf-8\r\n\
                     Content-Length: {}\r\nConnection: close\r\n\r\n",
                    body.len()
                );
                let _ = stream.write_all(response.as_bytes());
                let _ = stream.write_all(body.as_bytes());
                let _ = stream.flush();
                return;
            }
            FAILED_LOGINS.store(0, Ordering::Release);
        }

        // Constant-time comparison of the password digest.
        let digest = {
            let mut hasher = Sha1::new();
            hasher.update(pwd.as_bytes());
            hasher.finalize()
        };
        let ok = digest[..] == expected_digest()[..];
        if ok {
            FAILED_LOGINS.store(0, Ordering::Release);
            let body =
                "<html><body><p>OK</p><script>location.href='/'</script></body></html>";
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\n\
                 Set-Cookie: terax_web={}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800\r\n\
                 Content-Length: {}\r\nConnection: close\r\n\r\n",
                web_token(),
                body.len()
            );
            let _ = stream.write_all(response.as_bytes());
            let _ = stream.write_all(body.as_bytes());
            let _ = stream.flush();
        } else {
            FAILED_LOGINS.fetch_add(1, Ordering::AcqRel);
            LAST_FAIL.store(
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_millis() as u64)
                    .unwrap_or(0),
                Ordering::Release,
            );
            let body = "<html><body><p>wrong password</p><script>history.back()</script></body></html>";
            let response = format!(
                "HTTP/1.1 401 Unauthorized\r\nContent-Type: text/html; charset=utf-8\r\n\
                 Content-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            );
            let _ = stream.write_all(response.as_bytes());
            let _ = stream.write_all(body.as_bytes());
            let _ = stream.flush();
        }
        return;
    }

    // WebSocket upgrade requires a valid auth cookie.
    if path.starts_with("/ws") && is_upgrade {
        if !authenticated {
            let body = "unauthorized";
            let response = format!(
                "HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain\r\n\
                 Content-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            );
            let _ = stream.write_all(response.as_bytes());
            let _ = stream.write_all(body.as_bytes());
            let _ = stream.flush();
            return;
        }
        // Cap concurrent connections so a runaway client cannot pile up
        // threads. A rejected client simply sees a failed upgrade.
        let prev = CONNECTIONS.fetch_add(1, Ordering::AcqRel);
        if prev >= MAX_CONNECTIONS {
            CONNECTIONS.fetch_sub(1, Ordering::AcqRel);
            let body = "busy: too many connections";
            let response = format!(
                "HTTP/1.1 503 Service Unavailable\r\nContent-Type: text/plain\r\n\
                 Content-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            );
            let _ = stream.write_all(response.as_bytes());
            let _ = stream.write_all(body.as_bytes());
            let _ = stream.flush();
            return;
        }
        struct ConnGuard;
        impl Drop for ConnGuard {
            fn drop(&mut self) {
                CONNECTIONS.fetch_sub(1, Ordering::AcqRel);
            }
        }
        let _guard = ConnGuard;
        match WsConn::from_handshake(stream, head) {
            Ok(conn) => handle_ws(app, conn),
            Err(e) => log::debug!("web terminal: ws handshake failed: {e}"),
        }
        return;
    }

    // Everything else (including /): serve the terminal page when
    // authenticated, otherwise the login page.
    if authenticated {
        serve_page(stream);
    } else {
        serve_login(stream);
    }
}

fn serve_login(mut stream: TcpStream) {
    let body = r#"<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Terax Terminal</title>
<style>
  body { margin:0; height:100vh; display:flex; align-items:center; justify-content:center;
         background:#0d1117; color:#e6edf3; font-family:system-ui,sans-serif; }
  .card { width:min(320px,88vw); background:#161b22; border:1px solid #21262d;
          border-radius:14px; padding:28px 24px; text-align:center; }
  h1 { font-size:17px; margin:0 0 20px; }
  input { width:100%; box-sizing:border-box; padding:12px; font-size:16px;
          border:1px solid #21262d; border-radius:10px; background:#0d1117; color:#e6edf3;
          outline:none; }
  input:focus { border-color:#58a6ff; }
  button { width:100%; margin-top:14px; padding:12px; font-size:16px; border:none;
           border-radius:10px; background:#1f6feb; color:#fff; cursor:pointer; }
  .err { color:#f85149; font-size:13px; margin-top:10px; min-height:18px; }
</style>
</head>
<body>
  <div class="card">
    <h1>请输入密码</h1>
    <input id="pwd" type="password" placeholder="访问密码" autofocus />
    <button onclick="login()">进入</button>
    <div class="err" id="err"></div>
  </div>
  <script>
    async function login() {
      const v = document.getElementById('pwd').value.trim();
      if (!v) return;
      const res = await fetch('/auth', { method: 'POST', body: v, credentials: 'same-origin' });
      if (res.ok) { location.href = '/'; }
      else if (res.status === 429) { document.getElementById('err').textContent = '尝试过多，请稍后再试'; }
      else { document.getElementById('err').textContent = '密码错误'; }
    }
    document.getElementById('pwd').addEventListener('keydown', (e) => { if (e.key === 'Enter') login(); });
  </script>
</body>
</html>"#;
    let response = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\n\
         Cache-Control: no-store\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    );
    let _ = stream.write_all(response.as_bytes());
    let _ = stream.write_all(body.as_bytes());
    let _ = stream.flush();
}

fn serve_page(mut stream: TcpStream) {
    let body = INDEX_HTML;
    let response = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\n\
         Cache-Control: no-store\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    );
    let _ = stream.write_all(response.as_bytes());
    let _ = stream.write_all(body.as_bytes());
    let _ = stream.flush();
}

/// Per-connection WS loop: one client watches one session at a time.
fn handle_ws(app: tauri::AppHandle, mut conn: WsConn) {
    let state = app.state::<PtyState>();
    // The leaf id this connection is attached to (for exit notices), plus the
    // (session, subscriber sender, live receiver) triple.
    let mut attached_id: Option<u32> = None;
    let mut attached: Option<(
        Arc<Session>,
        std::sync::mpsc::SyncSender<WebMsg>,
        std::sync::mpsc::Receiver<WebMsg>,
    )> = None;
    let mut last_ping = std::time::Instant::now();

    // Push the session list so the page renders without a round trip.
    send_sessions(&mut conn, &state);

    loop {
        // Drain pending output on every iteration, whether or not the client
        // has sent anything: a phone that only watches still receives live
        // output instead of freezing when its input queue is quiet.
        if let Some((session, tx, rx)) = &attached {
            loop {
                match rx.try_recv() {
                    Ok(WebMsg::Output(chunk)) => {
                        if chunk.is_empty() {
                            continue;
                        }
                        let mut frame = Vec::with_capacity(chunk.len() + 1);
                        frame.push(b'0');
                        frame.extend_from_slice(&chunk);
                        if conn.send_frame(OP_BIN, &frame).is_err() {
                            break;
                        }
                    }
                    Ok(WebMsg::Exited(code)) => {
                        // Session ended: tell the page, then drop this
                        // subscription so the stale viewer table stays clean.
                        let _ = send_text(
                            &mut conn,
                            &json!({ "type": "exit", "id": attached_id, "code": code })
                                .to_string(),
                        );
                        session.web_unsubscribe(tx);
                        attached_id = None;
                        attached = None;
                        break;
                    }
                    Err(std::sync::mpsc::TryRecvError::Disconnected) => {
                        // Evicted for falling behind (queue overflow): tell the
                        // page so it can surface the condition instead of
                        // silently losing output.
                        let _ = send_error(&mut conn, "output too fast, resubscribe");
                        attached_id = None;
                        attached = None;
                        break;
                    }
                    Err(std::sync::mpsc::TryRecvError::Empty) => break,
                }
            }
        }

        // Server heartbeat: keep half-open connections honest and let NAT
        // keep the mapping alive on phones that sleep.
        if last_ping.elapsed() >= Duration::from_secs(30) {
            last_ping = std::time::Instant::now();
            if conn.send_frame(OP_PING, b"terax").is_err() {
                break;
            }
        }

        // A peer that goes 90s without a single byte (PONG included) is dead
        // or off the network: stop pinning a thread and a connection slot.
        if conn.last_read_at.elapsed() > Duration::from_secs(90) {
            log::debug!("web terminal: peer idle 90s, dropping connection");
            break;
        }

        match conn.read_message() {
            Ok(None) => {
                // No complete frame yet: yield briefly so the loop can keep
                // draining session output, then poll again. A quiet phone is
                // never disconnected for idling (issue #41).
                thread::sleep(Duration::from_millis(10));
            }
            Ok(Some((OP_TEXT, payload))) => {
                let text = String::from_utf8_lossy(&payload);
                let parsed: Value = match serde_json::from_str(&text) {
                    Ok(v) => v,
                    Err(_) => {
                        let _ = send_error(&mut conn, "invalid JSON");
                        continue;
                    }
                };
                if let Some(id) = parsed.get("attach").and_then(|v| v.as_u64()) {
                    let leaf_id = id as u32;
                    // Detach the previous subscription precisely, so other
                    // viewers of the same session are never affected.
                    if let Some((session, tx, _)) = attached.take() {
                        session.web_unsubscribe(&tx);
                    }
                    attached_id = None;

                    // The phone attaches by leaf id (the desktop tab's leaf).
                    // If that tab has no live pty yet, ask the desktop to open
                    // it and report "opening" so the page can retry shortly.
                    let session = state.web_leaf_session(leaf_id, &app);
                    let Some(session) = session else {
                        let _ = send_text(
                            &mut conn,
                            &json!({ "type": "opening", "id": id }).to_string(),
                        );
                        continue;
                    };
                    // Attach does NOT resize the shared PTY. The desktop owns
                    // the canonical size; the phone renders at its own fit
                    // dimensions, so the two views stay independent.
                    let Some((history, tx, rx)) = session.web_subscribe() else {
                        let _ = send_error(&mut conn, "session already exited");
                        continue;
                    };
                    if !history.is_empty() {
                        let mut frame = Vec::with_capacity(history.len() + 1);
                        frame.push(b'0');
                        frame.extend_from_slice(&history);
                        if conn.send_frame(OP_BIN, &frame).is_err() {
                            break;
                        }
                    }
                    let _ = send_text(
                        &mut conn,
                        &json!({
                            "type": "attached",
                            "id": id,
                            "cols": state.web_session_size(&session).0,
                            "rows": state.web_session_size(&session).1,
                        })
                        .to_string(),
                    );
                    attached_id = Some(leaf_id);
                    attached = Some((session, tx, rx));
                } else if parsed.get("list").and_then(|v| v.as_bool()) == Some(true) {
                    send_sessions(&mut conn, &state);
                }
            }
            Ok(Some((OP_BIN, payload))) => {
                let Some(session) = attached.as_ref().map(|(s, _, _)| s) else {
                    continue;
                };
                if payload.is_empty() {
                    continue;
                }
                let cmd = payload[0];
                let data = &payload[1..];
                match cmd {
                    b'0' => {
                        let mut w = session.writer.lock().unwrap();
                        let _ = w.write_all(data);
                        let _ = w.flush();
                    }
                    b'1' => {
                        if let Ok(v) = serde_json::from_slice::<Value>(data) {
                            if let (Some(c), Some(r)) = (
                                v.get("cols").and_then(|x| x.as_u64()),
                                v.get("rows").and_then(|x| x.as_u64()),
                            ) {
                                let _ = session.master.lock().unwrap().resize(
                                    portable_pty::PtySize {
                                        rows: r as u16,
                                        cols: c as u16,
                                        pixel_width: 0,
                                        pixel_height: 0,
                                    },
                                );
                            }
                        }
                    }
                    _ => {}
                }
            }
            Ok(Some((OP_PING, payload))) => {
                let _ = conn.send_frame(OP_PONG, &payload);
            }
            Ok(Some((OP_PONG, _))) => {}
            Ok(Some((OP_CLOSE, _))) => break,
            Err(e) => {
                log::debug!("web terminal: ws read ended: {e}");
                break;
            }
            _ => {}
        }
    }

    // Detach this connection's subscription precisely, never the whole table.
    if let Some((session, tx, _)) = attached {
        session.web_unsubscribe(&tx);
    }
}

fn send_sessions(conn: &mut WsConn, state: &PtyState) {
    let tabs = state.web_tabs();
    let spaces = state.web_spaces();
    let msg = json!({
        "type": "sessions",
        "sessions": tabs.iter().map(|t| json!({
            "id": t.leaf_id,
            "cwd": t.cwd,
            "title": t.title,
            "active": t.active,
            "live": t.pty_id.is_some(),
            "space": t.space_id,
            "cols": t.pty_id.and_then(|id| state.web_get(id)).map(|s| state.web_session_size(&s).0),
            "rows": t.pty_id.and_then(|id| state.web_get(id)).map(|s| state.web_session_size(&s).1),
        })).collect::<Vec<_>>(),
        // Every group, including empty ones, so the switcher can show all.
        "spaces": spaces.iter().map(|(id, name)| json!({ "id": id, "name": name })).collect::<Vec<_>>(),
    });
    let _ = send_text(conn, &msg.to_string());
}

fn send_text(conn: &mut WsConn, text: &str) -> Result<(), ()> {
    conn.send_frame(OP_TEXT, text.as_bytes()).map_err(|_| ())
}

fn send_error(conn: &mut WsConn, message: &str) -> Result<(), ()> {
    send_text(conn, &json!({ "type": "error", "message": message }).to_string())
}
