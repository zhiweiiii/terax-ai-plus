import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import "./style.css";

// ── WebSocket wire protocol (see src-tauri/src/modules/web/mod.rs) ──────
// client → server:
//   first text: { "attach": <id> } or { "list": true }
//   binary:     '0' + bytes        → write input
//               '1' + JSON         → resize { "cols": N, "rows": N } (unused
//                                    here: the phone never resizes the PTY)
// server → client:
//   binary '0' + bytes             → terminal output (history replay first)
//   text: { "type": "sessions", "sessions": [{id,cwd,title,active,live,space,cols,rows}] }
//         { "type": "attached", "id": N, "cols": C, "rows": R }
//         { "type": "opening", "id": N }
//         { "type": "exit", "id": N, "code": C }
//         { "type": "error", "message": "..." }

type SessionInfo = {
  id: number;
  cwd: string | null;
  title: string | null;
  active: boolean;
  live: boolean;
  space: string | null;
  /** PTY grid size (desktop-owned); present when live. */
  cols?: number;
  rows?: number;
};

type SpaceInfo = {
  id: string;
  name: string;
};

type SessionsMsg = {
  type: "sessions";
  sessions: SessionInfo[];
  /** Every group, including empty ones. */
  spaces: SpaceInfo[];
};

const $ = <T extends HTMLElement>(sel: string): T => {
  const el = document.querySelector<T>(sel);
  if (!el) throw new Error(`missing ${sel}`);
  return el;
};

const app = $("#app");

app.innerHTML = `
  <div class="topbar">
    <button id="btn-list" class="icon-btn" title="切换窗口">☰</button>
    <span id="title">Terax</span>
    <span id="status" class="status"></span>
  </div>
  <div id="terminal-wrap" class="terminal-wrap">
    <div id="empty-hint" class="empty-hint" hidden>
      <div class="empty-title">没有活动终端</div>
      <div class="empty-sub">在桌面端打开一个命令行后，这里会自动显示</div>
    </div>
  </div>
  <div class="toolbar">
    <button id="btn-ctrl-c" class="tool-btn" title="发送 Ctrl+C (中断)">Ctrl+C</button>
    <button id="btn-ctrl-d" class="tool-btn" title="发送 Ctrl+D (EOF)">Ctrl+D</button>
    <button id="btn-keyboard" class="tool-btn" title="显示/隐藏键盘">⌨</button>
  </div>
  <div id="sheet" class="sheet" hidden>
    <div class="sheet-head">
      <span>切换窗口</span>
      <button id="btn-close-sheet" class="icon-btn">✕</button>
    </div>
    <ul id="session-list" class="session-list"></ul>
  </div>
  <div id="toast" class="toast" hidden></div>
`;

const termWrap = $("#terminal-wrap") as HTMLDivElement;
const emptyHint = $("#empty-hint") as HTMLDivElement;
const statusEl = $("#status") as HTMLSpanElement;
const sheetEl = $("#sheet") as HTMLDivElement;
const sessionListEl = $("#session-list") as HTMLUListElement;
const toastEl = $("#toast") as HTMLDivElement;

const term = new Terminal({
  fontFamily:
    "ui-monospace, SFMono-Regular, Menlo, Consolas, 'Cascadia Mono', 'Courier New', monospace",
  fontSize: 14,
  lineHeight: 1.35,
  letterSpacing: 0,
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
// WebGL renderer: full-screen redraws from TUI apps (opencode, vim, htop)
// are far smoother than the DOM renderer on phones.
try {
  term.loadAddon(new WebglAddon());
} catch {
  // fall back to the DOM renderer when WebGL is unavailable.
}
term.open(termWrap);
// Tap anywhere on the terminal to focus it for typing.
termWrap.addEventListener("pointerdown", () => term.focus());

// ── WebSocket ────────────────────────────────────────────────────────────
const proto = location.protocol === "https:" ? "wss:" : "ws:";
const wsUrl = `${proto}//${location.host}/ws`;
let ws: WebSocket | null = null;
let attachedId: number | null = null;
let lastAttachedId: number | null = null;
let pendingAttachId: number | null = null;
let reconnectTimer: number | null = null;
let reconnectDelay = 1000;
let wsSeq = 0;
// Grid size of the shared PTY (desktop-owned). The phone renders at exactly
// this cols/rows and scales the font instead, so the byte stream's line
// structure stays intact. null = free fit (nothing attached yet).
let ptyCols: number | null = null;
let ptyRows: number | null = null;

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
          renderSessions(msg as SessionsMsg);
          if (msg.sessions.length === 0) {
            emptyHint.hidden = false;
            term.reset();
          } else {
            emptyHint.hidden = true;
          }
          // Auto-attach: a session the user tapped (pending), the session
          // open before a reconnect, else the first *live* session.
          const live = msg.sessions.filter((s: SessionInfo) => s.live);
          const target =
            pendingAttachId !== null &&
            live.some((s: SessionInfo) => s.id === pendingAttachId)
              ? pendingAttachId
              : lastAttachedId !== null &&
                  live.some((s: SessionInfo) => s.id === lastAttachedId)
                ? lastAttachedId
                : live.length > 0
                  ? live[0].id
                  : null;
          if (attachedId === null && target !== null) {
            attachTo(target);
          }
          // Track desktop-side PTY resizes for the attached session.
          if (attachedId !== null) {
            const mine = msg.sessions.find(
              (s: SessionInfo) => s.id === attachedId,
            );
            if (
              mine &&
              typeof mine.cols === "number" &&
              typeof mine.rows === "number"
            ) {
              if (mine.cols !== ptyCols || mine.rows !== ptyRows) {
                ptyCols = mine.cols;
                ptyRows = mine.rows;
                applyFitMode();
              }
            }
          }
          break;
        case "opening":
          // The desktop is spawning this terminal; refresh the session list
          // shortly and let the auto-attach logic pick it up when it's live.
          scheduleOpeningRetry(msg.id);
          break;
        case "attached":
          openingRetries = 0;
          pendingAttachId = null;
          attachedId = msg.id;
          lastAttachedId = msg.id;
          // The PTY is laid out at the desktop's cols/rows. The phone fits
          // by buffer mode: normal output wraps to the phone width; TUI apps
          // (alternate screen) lock to the PTY grid so cursor positioning
          // stays correct.
          if (typeof msg.cols === "number" && typeof msg.rows === "number") {
            ptyCols = msg.cols;
            ptyRows = msg.rows;
            applyFitMode();
          }
          emptyHint.hidden = true;
          setStatus(`会话 #${msg.id}`);
          term.focus();
          // Refresh the sheet so the active session highlight moves.
          send({ list: true });
          break;
        case "exit":
          toast(`会话 #${msg.id} 已退出 (${msg.code})`);
          if (attachedId === msg.id) {
            attachedId = null;
            lastAttachedId = null;
            ptyCols = null;
            ptyRows = null;
          }
          if (pendingAttachId === msg.id) pendingAttachId = null;
          break;
        case "error":
          toast(msg.message || "错误");
          // Evicted for falling behind: the server dropped our subscription.
          // Reconnect so the history replay catches up to the current screen.
          if (msg.message === "output too fast, resubscribe") {
            attachedId = null;
            pendingAttachId = null;
            scheduleReconnect();
          }
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
    pendingAttachId = null;
    term.reset();
    scheduleReconnect();
  };
  ws.onerror = () => {
    // A stale connection's error must not close the current one.
    if (mySeq !== wsSeq) return;
    ws?.close();
  };
}

function scheduleReconnect() {
  if (reconnectTimer !== null) return;
  reconnectTimer = window.setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, reconnectDelay);
  reconnectDelay = Math.min(reconnectDelay * 2, 15000);
}

let openingRetries = 0;
function scheduleOpeningRetry(id: number) {
  if (openingRetries >= 3) {
    openingRetries = 0;
    setStatus("无法连接该终端", "err");
    return;
  }
  openingRetries++;
  setStatus(`正在打开会话 #${id}…`, "warn");
  window.setTimeout(() => send({ list: true }), 1500);
}

// ── Session sheet: groups and terminals in one flat, scrollable list ─────
// Every group (including empty ones) renders as an inline label row with its
// terminals directly underneath — no switching level; the list scrolls.
function renderSessions(msg: SessionsMsg) {
  sessionListEl.innerHTML = "";
  const sessions = msg.sessions;
  const spaces = msg.spaces ?? [];
  if (sessions.length === 0 && spaces.length === 0) {
    const li = document.createElement("li");
    li.className = "session-empty";
    li.textContent = "没有活动会话";
    sessionListEl.appendChild(li);
    return;
  }
  // Group sessions by space id; null space lands in "其他".
  const bySpace = new Map<string, SessionInfo[]>();
  for (const s of sessions) {
    const key = s.space ?? "";
    const bucket = bySpace.get(key);
    if (bucket) bucket.push(s);
    else bySpace.set(key, [s]);
  }
  // Render groups in desktop order (from the synced group list), then any
  // groups that only exist via their sessions. Sessions carry the group
  // NAME (the desktop syncs names), so dedupe by both id and name.
  const shown = new Set<string>();
  for (const sp of spaces) {
    shown.add(sp.id);
    shown.add(sp.name);
    const list = bySpace.get(sp.id) ?? bySpace.get(sp.name) ?? [];
    appendGroupRow(sp.name || "其他", list);
  }
  for (const [key, list] of bySpace) {
    if (shown.has(key)) continue;
    appendGroupRow(key || "其他", list);
  }
}

function appendGroupRow(name: string, list: SessionInfo[]) {
  // Group label: rendered inline as a header row, not a switch target.
  const head = document.createElement("li");
  head.className = "session-group";
  head.textContent = name;
  sessionListEl.appendChild(head);
  if (list.length === 0) {
    const li = document.createElement("li");
    li.className = "session-empty";
    li.textContent = "暂无终端";
    sessionListEl.appendChild(li);
    return;
  }
  for (const s of list) {
    const li = document.createElement("li");
    li.className = "session-item" + (s.id === attachedId ? " active" : "");
    const label = s.title || s.cwd || `会话 #${s.id}`;
    const cwd = s.cwd
      ? s.cwd.split(/[\\/]/).filter(Boolean).slice(-2).join("/") || s.cwd
      : "";
    li.innerHTML = `<span class="session-name">${escapeHtml(label)}${cwd ? ` · ${escapeHtml(cwd)}` : ""}</span>
      <span class="session-viewers">${s.active ? "当前" : s.live ? "" : "未打开"}</span>`;
    li.addEventListener("click", () => {
      attachTo(s.id);
      closeSheet();
    });
    sessionListEl.appendChild(li);
  }
}

function attachTo(id: number) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  if (attachedId === id && lastAttachedId === id) {
    // Already attached to this session; just refresh the list highlight.
    send({ list: true });
    return;
  }
  pendingAttachId = id;
  term.reset();
  attachedId = null; // clear so auto-attach can retake on reconnect
  // Attach without a resize: the shared PTY keeps the desktop's size, so
  // the phone never disturbs the desktop layout. The phone renders at its
  // own fit dimensions; TUI apps may not lay out perfectly on a narrow
  // screen, but the two views stay independent.
  send({ attach: id });
}

function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
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

// ── Resize: fit locally ONLY. The shared PTY keeps the desktop's size; the
// ── phone never sends a resize frame so the desktop layout is never touched.
//
// Two rendering modes, chosen by which xterm buffer is active:
//   - normal buffer (plain shell output): FREE FIT to the phone width, so
//     long lines wrap and everything is readable.
//   - alternate buffer (TUI apps: opencode, vim, htop): LOCK cols to the
//     PTY's own grid — the byte stream is laid out for that grid, wrapping
//     anywhere else breaks cursor positioning. The right side (opencode's
//     side panel) is clipped off screen, leaving the main UI readable.
let inAltScreen = false;

function applyFitMode() {
  if (inAltScreen && ptyCols !== null && ptyRows !== null) {
    fitToPty();
  } else {
    try {
      fit.fit();
    } catch {
      return;
    }
  }
}

function fitToPty() {
  if (ptyCols === null || ptyRows === null || ptyCols < 8) {
    return;
  }
  // Keep the readable font size. Lock cols to the PTY grid so the byte
  // stream's line structure stays intact, and let the container clip the
  // right side: opencode's side panel sits at the far right and is pushed
  // off screen, leaving the main UI readable at normal size. Rows use the
  // fit value (fills the container).
  try {
    fit.fit();
  } catch {
    return;
  }
  term.resize(ptyCols, Math.max(2, term.rows));
}

function resize() {
  applyFitMode();
}
window.addEventListener("resize", resize);
window.addEventListener("orientationchange", () => setTimeout(resize, 300));
new ResizeObserver(() => resize()).observe(termWrap);

// Switch fit mode when an app enters/leaves the alternate screen.
term.buffer.onBufferChange((buf) => {
  const next = buf.type === "alternate";
  if (next === inAltScreen) return;
  inAltScreen = next;
  // The buffer switch replaces the grid; refit in the new mode. Deferred so
  // xterm settles its buffer before we resize.
  window.setTimeout(() => {
    applyFitMode();
  }, 0);
});

// Desktop resizes its PTY (and the TUI repaints) without the phone being
// told; poll the session list every 5 s to pick up the new grid size.
window.setInterval(() => {
  send({ list: true });
}, 5000);

// ── UI wiring ────────────────────────────────────────────────────────────
$("#btn-list").addEventListener("click", openSheet);
$("#btn-close-sheet").addEventListener("click", closeSheet);
$("#btn-ctrl-c").addEventListener("click", () => sendControl(0x03));
$("#btn-ctrl-d").addEventListener("click", () => sendControl(0x04));
$("#btn-keyboard").addEventListener("click", () => term.focus());

// Send a control byte to the attached session (Ctrl+C = 0x03 etc).
function sendControl(code: number) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  const frame = new Uint8Array(2);
  frame[0] = 0x30; // '0' = input
  frame[1] = code;
  ws.send(frame);
}

// ── Boot ─────────────────────────────────────────────────────────────────
connect();
resize();
