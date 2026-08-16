//! Web terminal bridge: exposes the running PTY sessions over HTTP + WebSocket
//! on port 17000 so a phone / other machine can watch or drive the command
//! lines from a plain browser page.
//!
//!   GET /     → embedded mobile page (single-file HTML, served as-is)
//!   GET /ws   → WebSocket (ttyd-style binary protocol, extended with a
//!               session list / attach handshake for multi-terminal support)
//!
//! Wire protocol (client → server):
//!   First message (text): { "attach": <id>, "cols": N, "rows": N }
//!                         or { "list": true }          → session list only
//!   Later (binary, first byte is the command):
//!     '0' + bytes        → write input to the attached session
//!     '1' + JSON         → resize { "cols": N, "rows": N }
//!   Later (text):        { "attach": <id>, ... }        → switch session
//!
//! Wire protocol (server → client):
//!   binary '0' + bytes   → terminal output
//!   binary '1' + bytes   → window title (UTF-8)
//!   text  { "type": "sessions", "sessions": [ {id,cwd,viewers} ] }
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

use crate::modules::pty::{PtyState, Session};
use tauri::Manager;

const PORT: u16 = 17000;
const BIND_ADDR: &str = "0.0.0.0";

// The mobile page is embedded at build time by scripts/build-web.mjs.
const INDEX_HTML: &str = include_str!("../../../web.html");

const WS_GUID: &[u8] = b"258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

static SHUTDOWN: AtomicBool = AtomicBool::new(false);

/// Start the web terminal server on 0.0.0.0:17000. Returns an error only if
/// the port cannot be bound; the accept loop runs on its own thread.
pub fn start(app: tauri::AppHandle) -> Result<(), String> {
    SHUTDOWN.store(false, Ordering::Release);
    let listener = TcpListener::bind((BIND_ADDR, PORT)).map_err(|e| {
        format!("web terminal: failed to bind {BIND_ADDR}:{PORT}: {e}")
    })?;
    log::info!("web terminal server listening on http://{BIND_ADDR}:{PORT}");
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
    /// Bytes read past the HTTP head terminator (early WS frames).
    prefetched: Vec<u8>,
    prefetch_pos: usize,
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
        for line in lines {
            let lower = line.to_ascii_lowercase();
            if let Some(v) = lower.strip_prefix("sec-websocket-key:") {
                key = Some(line[v.len()..].trim().to_string());
            }
        }
        let key = key.ok_or_else(|| "missing Sec-WebSocket-Key".to_string())?;

        let accept = {
            let mut hasher = Sha1::new();
            hasher.update(key.as_bytes());
            hasher.update(WS_GUID);
            base64::engine::general_purpose::STANDARD.encode(hasher.finalize())
        };
        log::debug!(
            "web terminal: ws handshake key={key} accept={accept}"
        );
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
        stream
            .set_read_timeout(None)
            .map_err(|e| e.to_string())?;

        let terminator = head
            .windows(4)
            .position(|w| w == b"\r\n\r\n")
            .map(|p| p + 4)
            .unwrap_or(head.len());
        let prefetched = head[terminator..].to_vec();
        Ok(Self {
            stream,
            prefetched,
            prefetch_pos: 0,
        })
    }

    fn read_exact(&mut self, buf: &mut [u8]) -> Result<(), String> {
        let mut filled = 0usize;
        // Serve from the prefetched buffer first.
        if self.prefetch_pos < self.prefetched.len() {
            let take = (self.prefetched.len() - self.prefetch_pos).min(buf.len());
            buf[..take].copy_from_slice(&self.prefetched[self.prefetch_pos..self.prefetch_pos + take]);
            self.prefetch_pos += take;
            filled = take;
            if filled == buf.len() {
                return Ok(());
            }
        }
        self.stream
            .read_exact(&mut buf[filled..])
            .map_err(|e| format!("read ws bytes: {e}"))
    }

    /// Read one message. Returns the payload and its opcode. Frames are
    /// reassembled across continuation frames (terminal output can exceed a
    /// single frame).
    fn read_message(&mut self) -> Result<(u8, Vec<u8>), String> {
        let mut result_op: Option<u8> = None;
        let mut result = Vec::new();
        loop {
            let mut hdr = [0u8; 2];
            self.read_exact(&mut hdr)
                .map_err(|e| format!("read ws frame head: {e}"))?;
            let fin = hdr[0] & 0x80 != 0;
            let opcode = hdr[0] & 0x0F;
            let masked = hdr[1] & 0x80 != 0;
            let mut len = (hdr[1] & 0x7F) as usize;
            if len == 126 {
                let mut ext = [0u8; 2];
                self.read_exact(&mut ext).map_err(|e| e.to_string())?;
                len = u16::from_be_bytes(ext) as usize;
            } else if len == 127 {
                let mut ext = [0u8; 8];
                self.read_exact(&mut ext).map_err(|e| e.to_string())?;
                len = u64::from_be_bytes(ext) as usize;
            }
            // 1 MiB cap per message (input pastes, never our own output).
            if len > 1024 * 1024 {
                return Err("ws frame too large".into());
            }
            let mut mask = [0u8; 4];
            if masked {
                self.read_exact(&mut mask).map_err(|e| e.to_string())?;
            }
            let mut payload = vec![0u8; len];
            self.read_exact(&mut payload).map_err(|e| e.to_string())?;
            if masked {
                for (i, b) in payload.iter_mut().enumerate() {
                    *b ^= mask[i % 4];
                }
            }
            match opcode {
                OP_CONT => {
                    result.extend_from_slice(&payload);
                }
                OP_TEXT | OP_BIN => {
                    result_op = Some(opcode);
                    result.extend_from_slice(&payload);
                }
                OP_CLOSE | OP_PING | OP_PONG => {
                    return Ok((opcode, payload));
                }
                _ => return Err("unknown ws opcode".into()),
            }
            if fin {
                if let Some(op) = result_op {
                    return Ok((op, result));
                }
                return Err("continuation without initial frame".into());
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
        self.stream
            .write_all(&head)
            .map_err(|e| e.to_string())?;
        if !payload.is_empty() {
            self.stream
                .write_all(payload)
                .map_err(|e| e.to_string())?;
        }
        self.stream.flush().map_err(|e| e.to_string())
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
    for line in lines {
        if line.to_ascii_lowercase().starts_with("upgrade: websocket") {
            is_upgrade = true;
            break;
        }
    }
    let path = request_line.split_whitespace().nth(1).unwrap_or("/");
    if path.starts_with("/ws") && is_upgrade {
        match WsConn::from_handshake(stream, head) {
            Ok(conn) => handle_ws(app, conn),
            Err(e) => log::debug!("web terminal: ws handshake failed: {e}"),
        }
        return;
    }
    serve_page(stream);
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
    let mut attached: Option<Arc<Session>> = None;
    let mut live_rx: Option<std::sync::mpsc::Receiver<Vec<u8>>> = None;

    // Push the session list so the page renders without a round trip.
    send_sessions(&mut conn, &state);

    loop {
        // Drain pending output first so a quiet terminal still shows echo.
        if let Some(rx) = &live_rx {
            while let Ok(chunk) = rx.try_recv() {
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
        }

        match conn.read_message() {
            Ok((OP_TEXT, payload)) => {
                let text = String::from_utf8_lossy(&payload);
                let parsed: Value = match serde_json::from_str(&text) {
                    Ok(v) => v,
                    Err(_) => {
                        let _ = send_error(&mut conn, "invalid JSON");
                        continue;
                    }
                };
                if let Some(id) = parsed.get("attach").and_then(|v| v.as_u64()) {
                    if let Some(s) = &attached {
                        s.web_unsubscribe_all();
                    }
                    attached = None;
                    live_rx = None;

                    let Some(session) = state.web_get(id as u32) else {
                        let _ = send_error(&mut conn, "session not found");
                        continue;
                    };
                    let cols = parsed.get("cols").and_then(|v| v.as_u64());
                    let rows = parsed.get("rows").and_then(|v| v.as_u64());
                    if let (Some(c), Some(r)) = (cols, rows) {
                        let _ = session
                            .master
                            .lock()
                            .unwrap()
                            .resize(portable_pty::PtySize {
                                rows: r as u16,
                                cols: c as u16,
                                pixel_width: 0,
                                pixel_height: 0,
                            });
                    }
                    let Some((history, rx)) = session.web_subscribe() else {
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
                        &json!({ "type": "attached", "id": id }).to_string(),
                    );
                    attached = Some(session);
                    live_rx = Some(rx);
                } else if parsed.get("list").and_then(|v| v.as_bool()) == Some(true) {
                    send_sessions(&mut conn, &state);
                }
            }
            Ok((OP_BIN, payload)) => {
                let Some(session) = &attached else {
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
            Ok((OP_PING, payload)) => {
                let _ = conn.send_frame(OP_PONG, &payload);
            }
            Ok((OP_PONG, _)) | Ok((OP_CONT, _)) => {}
            Ok((OP_CLOSE, _)) => break,
            Err(e) => {
                log::debug!("web terminal: ws read ended: {e}");
                break;
            }
            _ => {}
        }
    }

    if let Some(session) = attached {
        session.web_unsubscribe_all();
    }
}

fn send_sessions(conn: &mut WsConn, state: &PtyState) {
    let sessions = state.web_list();
    let msg = json!({
        "type": "sessions",
        "sessions": sessions.iter().map(|(id, cwd, viewers)| json!({
            "id": id,
            "cwd": cwd,
            "viewers": viewers,
        })).collect::<Vec<_>>(),
    });
    let _ = send_text(conn, &msg.to_string());
}

fn send_text(conn: &mut WsConn, text: &str) -> Result<(), ()> {
    conn.send_frame(OP_TEXT, text.as_bytes()).map_err(|_| ())
}

fn send_error(conn: &mut WsConn, message: &str) -> Result<(), ()> {
    send_text(conn, &json!({ "type": "error", "message": message }).to_string())
}
