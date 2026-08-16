import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import "./style.css";

// ── WebSocket wire protocol (see src-tauri/src/modules/web/mod.rs) ──────
// client → server:
//   first text: { "attach": <id>, "cols": N, "rows": N } or { "list": true }
//   binary:     '0' + bytes        → write input
//               '1' + JSON         → resize { "cols": N, "rows": N }
//   text:       { "attach": <id>, "cols": N, "rows": N } → switch session
// server → client:
//   binary '0' + bytes             → terminal output (history replay first)
//   binary '1' + bytes             → window title (ignored here)
//   text: { "type": "sessions", "sessions": [{id,cwd,viewers}] }
//         { "type": "attached", "id": N }
//         { "type": "exit", "id": N, "code": C }
//         { "type": "error", "message": "..." }

type SessionInfo = { id: number; cwd: string | null; viewers: number };

const $ = <T extends HTMLElement>(sel: string): T => {
  const el = document.querySelector<T>(sel);
  if (!el) throw new Error(`missing ${sel}`);
  return el;
};

const app = $("#app");

app.innerHTML = `
  <div class="topbar">
    <button id="btn-list" class="icon-btn" title="会话列表">☰</button>
    <span id="title">Terax</span>
    <span id="status" class="status"></span>
  </div>
  <div id="terminal-wrap" class="terminal-wrap"></div>
  <div id="sheet" class="sheet" hidden>
    <div class="sheet-head">
      <span>会话列表</span>
      <button id="btn-close-sheet" class="icon-btn">✕</button>
    </div>
    <ul id="session-list" class="session-list"></ul>
  </div>
  <div id="toast" class="toast" hidden></div>
`;

const termWrap = $("#terminal-wrap") as HTMLDivElement;
const statusEl = $("#status") as HTMLSpanElement;
const sheetEl = $("#sheet") as HTMLDivElement;
const sessionListEl = $("#session-list") as HTMLUListElement;
const toastEl = $("#toast") as HTMLDivElement;

const term = new Terminal({
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
  fontSize: 14,
  lineHeight: 1.2,
  cursorBlink: true,
  allowProposedApi: true,
  scrollback: 5000,
  theme: {
    background: "#0d1117",
    foreground: "#e6edf3",
    cursor: "#58a6ff",
    selectionBackground: "#264f78",
  },
});
const fit = new FitAddon();
term.loadAddon(fit);
term.open(termWrap);

// ── WebSocket ────────────────────────────────────────────────────────────
const proto = location.protocol === "https:" ? "wss:" : "ws:";
const wsUrl = `${proto}//${location.host}/ws`;
let ws: WebSocket | null = null;
let attachedId: number | null = null;
let reconnectTimer: number | null = null;
let reconnectDelay = 1000;
let wsSeq = 0;

function setStatus(text: string, tone: "ok" | "err" | "warn" = "ok") {
  statusEl.textContent = text;
  statusEl.dataset.tone = tone;
}

function toast(text: string) {
  toastEl.textContent = text;
  toastEl.hidden = false;
  window.setTimeout(() => {
    toastEl.hidden = true;
  }, 2500);
}

function send(obj: unknown) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(obj));
  }
}

function connect() {
  const mySeq = ++wsSeq;
  ws = new WebSocket(wsUrl);
  ws.binaryType = "arraybuffer";
  ws.onopen = () => {
    setStatus("已连接");
    reconnectDelay = 1000;
    send({ list: true });
  };
  ws.onmessage = (ev) => {
    if (typeof ev.data === "string") {
      let msg: any;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      switch (msg.type) {
        case "sessions":
          renderSessions(msg.sessions);
          break;
        case "attached":
          attachedId = msg.id;
          setStatus(`会话 #${msg.id}`);
          break;
        case "exit":
          toast(`会话 #${msg.id} 已退出 (${msg.code})`);
          attachedId = null;
          break;
        case "error":
          toast(msg.message || "错误");
          break;
      }
      return;
    }
    // Binary frame: first byte is the opcode ('0' = output, '1' = title).
    const bytes = new Uint8Array(ev.data as ArrayBuffer);
    if (bytes.length === 0) return;
    const op = bytes[0];
    const payload = bytes.subarray(1);
    if (op === 0x30 /* '0' */) {
      term.write(payload);
    }
  };
  ws.onclose = () => {
    if (mySeq !== wsSeq) return;
    setStatus("已断开", "err");
    attachedId = null;
    term.reset();
    scheduleReconnect();
  };
  ws.onerror = () => ws?.close();
}

function scheduleReconnect() {
  if (reconnectTimer !== null) return;
  reconnectTimer = window.setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, reconnectDelay);
  reconnectDelay = Math.min(reconnectDelay * 2, 15000);
}

// ── Session list sheet ───────────────────────────────────────────────────
function renderSessions(sessions: SessionInfo[]) {
  sessionListEl.innerHTML = "";
  if (sessions.length === 0) {
    const li = document.createElement("li");
    li.className = "session-empty";
    li.textContent = "没有活动会话";
    sessionListEl.appendChild(li);
    return;
  }
  for (const s of sessions) {
    const li = document.createElement("li");
    li.className = "session-item" + (s.id === attachedId ? " active" : "");
    const cwd = s.cwd
      ? s.cwd.split(/[\\/]/).filter(Boolean).slice(-2).join("/") || s.cwd
      : "—";
    li.innerHTML = `<span class="session-name">#${s.id} · ${escapeHtml(cwd)}</span>
      <span class="session-viewers">${s.viewers > 0 ? `${s.viewers} 观看` : ""}</span>`;
    li.addEventListener("click", () => {
      attachTo(s.id);
      closeSheet();
    });
    sessionListEl.appendChild(li);
  }
}

function attachTo(id: number) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    term.reset();
    send({ attach: id, cols: term.cols, rows: term.rows });
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
}

function openSheet() {
  sheetEl.hidden = false;
  send({ list: true });
}
function closeSheet() {
  sheetEl.hidden = true;
}

// ── Input (binary: '0' + utf8 bytes) ────────────────────────────────────
term.onData((data) => {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  const bytes = new TextEncoder().encode(data);
  const frame = new Uint8Array(1 + bytes.length);
  frame[0] = 0x30; // '0'
  frame.set(bytes, 1);
  ws.send(frame);
});

// ── Resize (binary: '1' + JSON) ─────────────────────────────────────────
function resize() {
  try {
    fit.fit();
  } catch {
    return;
  }
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  const body = JSON.stringify({ cols: term.cols, rows: term.rows });
  const bytes = new TextEncoder().encode(body);
  const frame = new Uint8Array(1 + bytes.length);
  frame[0] = 0x31; // '1'
  frame.set(bytes, 1);
  ws.send(frame);
}
window.addEventListener("resize", resize);
window.addEventListener("orientationchange", () => setTimeout(resize, 200));
new ResizeObserver(() => resize()).observe(termWrap);

// ── UI wiring ────────────────────────────────────────────────────────────
$("#btn-list").addEventListener("click", openSheet);
$("#btn-close-sheet").addEventListener("click", closeSheet);

// ── Boot ─────────────────────────────────────────────────────────────────
connect();
resize();
