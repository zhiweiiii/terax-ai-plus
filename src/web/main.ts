import { Conversation, type Turn } from "./conversation";
import "./style.css";

// ── WebSocket wire protocol (see src-tauri/src/modules/web/mod.rs) ──────
// client → server:
//   first text: { "attach": <id>, "cols": C, "rows": R } or { "list": true }
//   binary:     '0' + bytes        → write input
//               '1' + JSON         → resize { "cols": N, "rows": N }
// server → client:
//   binary '0' + bytes             → terminal output (history replay first)
//   text: { "type": "sessions", "sessions": [...], "spaces": [...] }
//         { "type": "attached", "id": N, "cols": C, "rows": R, "alt": bool }
//         { "type": "opening", "id": N }
//         { "type": "resized", "cols": C, "rows": R }
//         { "type": "exit", "id": N, "code": C }
//         { "type": "error", "message": "..." }
//
// One session has ONE grid, and whoever is typing owns it (SizeOwner in the
// Rust pty module). Watching never moves it: `attached` reports the grid the
// stream is actually laid out against, and the parser follows it. The attach
// message's cols/rows are only the phone's PREFERENCE: the first keystroke
// claims the session at that grid, the PTY resizes, every viewer is told via
// `resized`, and the phone parses on. The `alt` flag tells the parser which
// buffer mode to start the backlog replay in — the history ring may have
// trimmed the alt-screen enter sequence, so without it a mid-TUI backlog
// parses as a shell.

type SessionInfo = {
  id: number;
  cwd: string | null;
  title: string | null;
  active: boolean;
  live: boolean;
  space: string | null;
  cols?: number;
  rows?: number;
};

type SpaceInfo = { id: string; name: string };

type SessionsMsg = {
  type: "sessions";
  sessions: SessionInfo[];
  spaces: SpaceInfo[];
};

/** Any text message the server can push. Fields are optional because which
 *  ones are present depends on the `type` (the switch narrows by behaviour,
 *  not by a declared union). */
type ServerMsg = {
  type?: string;
  id?: number;
  code?: number;
  cols?: number;
  rows?: number;
  alt?: boolean;
  message?: string;
  sessions?: SessionInfo[];
  spaces?: SpaceInfo[];
};

/** The grid the phone wants the PTY at when IT types. Watching never imposes
 *  it — a session has one grid, and that grid belongs to whoever is typing
 *  (see SizeOwner in the Rust pty module). Sent on attach as a preference and
 *  applied by the server on the first keystroke, which claims the session. */
const FIXED_GRID = { cols: 120, rows: 40 } as const;

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
  <div id="progstatus" class="progstatus" hidden></div>
  <div id="agents" class="agents" hidden></div>
  <div id="thread" class="thread">
    <div id="empty-hint" class="empty-hint" hidden>
      <div class="empty-title">没有活动终端</div>
      <div class="empty-sub">在桌面端打开一个命令行后，这里会自动显示</div>
    </div>
    <div class="stream">
      <div id="turns" class="bubbles"></div>
      <div id="live-blocks" class="bubbles"></div>
      <div id="pending" class="bubbles"></div>
    </div>
  </div>
  <div class="composer">
    <div class="keyrow">
      <button class="key-btn" data-ctrl="3">Ctrl+C</button>
      <button class="key-btn" data-ctrl="4">Ctrl+D</button>
      <button class="key-btn" data-ctrl="27">Esc</button>
      <button class="key-btn" data-ctrl="9">Tab</button>
      <button class="key-btn" data-seq="up">↑</button>
      <button class="key-btn" data-seq="down">↓</button>
      <button class="key-btn" data-ctrl="13">↵</button>
    </div>
    <div class="inputrow">
      <textarea id="input" class="input" rows="1" placeholder="输入命令或消息…"
        autocapitalize="off" autocorrect="off" autocomplete="off" spellcheck="false"></textarea>
      <button id="btn-send" class="send-btn" title="发送">↑</button>
    </div>
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

const threadEl = $("#thread") as HTMLDivElement;
const turnsEl = $("#turns") as HTMLDivElement;
const emptyHint = $("#empty-hint") as HTMLDivElement;
const statusEl = $("#status") as HTMLSpanElement;
const sheetEl = $("#sheet") as HTMLDivElement;
const sessionListEl = $("#session-list") as HTMLUListElement;
const toastEl = $("#toast") as HTMLDivElement;
const inputEl = $("#input") as HTMLTextAreaElement;
const liveBlocksEl = $("#live-blocks") as HTMLDivElement;
const pendingEl = $("#pending") as HTMLDivElement;
const progStatusEl = $("#progstatus") as HTMLDivElement;
const agentsEl = $("#agents") as HTMLDivElement;

// ── Rendering ────────────────────────────────────────────────────────────
// Turns are re-rendered on a rAF so a burst of output costs one DOM pass.
let renderQueued = false;
const conv = new Conversation(() => {
  if (renderQueued) return;
  renderQueued = true;
  // requestAnimationFrame never fires while the page is hidden, and phones
  // background a tab the moment the screen locks or the user switches apps.
  // Falling back to a timer keeps the thread built as output arrives, so
  // coming back shows a finished page instead of a frame of catch-up.
  const run = () => {
    renderQueued = false;
    render();
  };
  if (document.hidden) window.setTimeout(run, 120);
  else requestAnimationFrame(run);
});

// Diagnostics handle. The parse is heuristic — how a program repaints is not
// something it declares — so leave a way to inspect what it decided.
(window as unknown as { conv: Conversation }).conv = conv;

/** Rendered turn nodes, keyed by turn id, so a growing output block is
 *  updated in place instead of rebuilding the whole thread on every chunk. */
const nodes = new Map<number, HTMLElement>();

function render() {
  const stick = isNearBottom();
  const live = new Set<number>();

  for (const turn of conv.turns) {
    live.add(turn.id);
    let node = nodes.get(turn.id);
    if (!node) {
      node = document.createElement("div");
      nodes.set(turn.id, node);
      turnsEl.appendChild(node);
    }
    paint(node, turn);
  }
  for (const [id, node] of nodes) {
    if (live.has(id)) continue;
    node.remove();
    nodes.delete(id);
  }
  paintLiveScreen();
  if (stick) scrollToBottom();
}

/** The part of the conversation still on a full-screen program's screen.
 *
 *  These are the same bubbles as the history above, in the same column: there
 *  is no separate "screen" view, because a screen is not something the reader
 *  should have to think about. The split is purely mechanical — history is
 *  appended once and left alone, this part is rebuilt whenever the program
 *  repaints — and between them they cover the conversation exactly once. */
function paintLiveScreen() {
  const blocks = conv.liveBlocks;
  const sig = blocks.map((b) => `${b.role}:${b.lines.join("\n")}`).join(" ");
  if (liveBlocksEl.dataset.sig !== sig) {
    liveBlocksEl.dataset.sig = sig;
    liveBlocksEl.replaceChildren(
      ...blocks.map((b) => {
        const node = document.createElement("div");
        node.className = b.role === "user" ? "turn sent" : "turn output";
        node.textContent = b.lines.join("\n");
        return node;
      }),
    );
  }

  // Sent, but the program has not painted it yet. Rendered last, because it is
  // the newest thing in the conversation.
  const psig = conv.pending.join(" ");
  if (pendingEl.dataset.sig !== psig) {
    pendingEl.dataset.sig = psig;
    pendingEl.replaceChildren(
      ...conv.pending.map((text) => {
        const node = document.createElement("div");
        node.className = "turn sent unconfirmed";
        node.textContent = text;
        return node;
      }),
    );
  }

  // The program's status furniture, as a label rather than a bubble.
  const status = conv.status;
  if (status) {
    if (progStatusEl.textContent !== status) progStatusEl.textContent = status;
    progStatusEl.hidden = false;
  } else {
    progStatusEl.hidden = true;
  }

  // The tab strip (Claude Code's running subagents), kept independent of the
  // bubbles: a chip row above the composer, not a conversation block.
  const agents = conv.agents;
  const asig = agents.join("\n");
  if (agentsEl.dataset.sig !== asig) {
    agentsEl.dataset.sig = asig;
    if (agents.length === 0) {
      agentsEl.hidden = true;
      agentsEl.replaceChildren();
    } else {
      agentsEl.hidden = false;
      agentsEl.replaceChildren(
        ...agents.map((text) => {
          const node = document.createElement("span");
          node.className = "agent-chip";
          node.textContent = text;
          return node;
        }),
      );
    }
  }
}

/** Signature of what a node currently shows, so unchanged turns are skipped. */
const painted = new WeakMap<HTMLElement, string>();

function paint(node: HTMLElement, turn: Turn) {
  const sig =
    turn.kind === "sent" || turn.kind === "note"
      ? `${turn.kind}:${turn.text}`
      : `output:${turn.lines.length}:${turn.lines[turn.lines.length - 1] ?? ""}:${turn.open}`;
  if (painted.get(node) === sig) return;
  painted.set(node, sig);

  if (turn.kind === "sent") {
    node.className = "turn sent";
    node.textContent = turn.text;
    return;
  }
  if (turn.kind === "note") {
    node.className = "turn note";
    node.textContent = turn.text;
    return;
  }
  node.className = `turn output${turn.open ? " live" : ""}`;
  node.textContent = turn.lines.join("\n");
}

function isNearBottom(): boolean {
  return (
    threadEl.scrollHeight - threadEl.scrollTop - threadEl.clientHeight < 120
  );
}
function scrollToBottom() {
  threadEl.scrollTop = threadEl.scrollHeight;
}

// ── Soft keyboard ────────────────────────────────────────────────────────
// iOS keeps the layout viewport at full height and shrinks only the visual
// viewport, so the composer ends up behind the keyboard. Pin the app to the
// visual viewport instead.
const viewport = window.visualViewport;
if (viewport) {
  let lastHeight = 0;
  const applyViewport = () => {
    if ((viewport.scale ?? 1) > 1.01) return;
    const height = Math.round(viewport.height);
    if (Math.abs(height - lastHeight) < 2) return;
    lastHeight = height;
    app.style.height = `${height}px`;
    if (isNearBottom()) scrollToBottom();
  };
  viewport.addEventListener("resize", applyViewport);
  applyViewport();
}

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
/** True between "attached" and the backlog frame the server sends after it. */
let backlogPending = false;

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
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
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
      let msg: unknown;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      handleText(msg);
      return;
    }
    const bytes = new Uint8Array(ev.data as ArrayBuffer);
    if (bytes.length === 0) return;
    if (bytes[0] !== 0x30 /* '0' */) return;
    const payload = bytes.subarray(1);
    // The first output frame after attaching is the backlog: everything the
    // desktop's command line already had. It needs replaying frame by frame,
    // not applying in one go — see Conversation.writeBacklog.
    if (backlogPending) {
      backlogPending = false;
      void conv.writeBacklog(payload);
      return;
    }
    conv.write(payload);
  };
  ws.onclose = () => {
    if (mySeq !== wsSeq) return;
    setStatus("已断开", "err");
    attachedId = null;
    pendingAttachId = null;
    scheduleReconnect();
  };
  ws.onerror = () => {
    if (mySeq !== wsSeq) return;
    ws?.close();
  };
}

function handleText(raw: unknown) {
  const msg = raw as ServerMsg;
  switch (msg.type) {
    case "sessions": {
      renderSessions(msg as SessionsMsg);
      const sessions = (msg as SessionsMsg).sessions;
      emptyHint.hidden = sessions.length !== 0;
      const live = sessions.filter((s) => s.live);
      const target =
        pendingAttachId !== null && live.some((s) => s.id === pendingAttachId)
          ? pendingAttachId
          : lastAttachedId !== null && live.some((s) => s.id === lastAttachedId)
            ? lastAttachedId
            : live.length > 0
              ? live[0].id
              : null;
      if (attachedId === null && target !== null) attachTo(target);
      break;
    }
    case "opening":
      if (typeof msg.id === "number") scheduleOpeningRetry(msg.id);
      break;
    case "attached":
      openingRetries = 0;
      pendingAttachId = null;
      if (typeof msg.id !== "number") break;
      attachedId = msg.id;
      lastAttachedId = msg.id;
      // Parse at the grid the stream is actually laid out against (the
      // owner's), not the phone's preference: the server reports it before
      // the backlog replay, and any other grid makes the TUI layout parse
      // wrong. `alt` forces the right buffer mode for that replay.
      conv.setGrid(
        typeof msg.cols === "number" ? msg.cols : FIXED_GRID.cols,
        typeof msg.rows === "number" ? msg.rows : FIXED_GRID.rows,
      );
      conv.setAltScreen(msg.alt === true);
      emptyHint.hidden = true;
      setStatus(`会话 #${msg.id}`);
      // The server replays the session's backlog immediately after this.
      backlogPending = true;
      send({ list: true });
      break;
    case "resized":
      // The grid changed because one end claimed the session. Every viewer
      // parses at the same grid (the byte stream is laid out against it), so
      // follow the owner instead of fighting for FIXED_GRID.
      if (typeof msg.cols === "number" && typeof msg.rows === "number") {
        conv.setGrid(msg.cols, msg.rows);
      }
      break;
    case "exit":
      toast(`会话 #${msg.id} 已退出 (${msg.code})`);
      conv.note(`会话 #${msg.id} 已退出 (${msg.code})`);
      if (attachedId === msg.id) {
        attachedId = null;
        lastAttachedId = null;
      }
      if (pendingAttachId === msg.id) pendingAttachId = null;
      break;
    case "error":
      toast(msg.message || "错误");
      if (msg.message === "output too fast, resubscribe") {
        attachedId = null;
        pendingAttachId = null;
        scheduleReconnect();
      }
      break;
  }
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

// ── Session sheet ────────────────────────────────────────────────────────
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
  const bySpace = new Map<string, SessionInfo[]>();
  for (const s of sessions) {
    const key = s.space ?? "";
    const bucket = bySpace.get(key);
    if (bucket) bucket.push(s);
    else bySpace.set(key, [s]);
  }
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
    li.dataset.leaf = String(s.id);
    const label = s.title || s.cwd || `会话 #${s.id}`;
    const cwd = s.cwd
      ? s.cwd.split(/[\\/]/).filter(Boolean).slice(-2).join("/") || s.cwd
      : "";
    li.innerHTML = `<span class="session-name">${escapeHtml(label)}${
      cwd ? ` · ${escapeHtml(cwd)}` : ""
    }</span>
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
    send({ list: true });
    return;
  }
  pendingAttachId = id;
  backlogPending = false;
  // The server replays this session's history, which is a different stream:
  // start the conversation over rather than splicing it onto the old one.
  conv.reset();
  attachedId = null;
  // State the phone's preferred grid. Watching does not move the shared PTY
  // (a session has one grid and it belongs to whoever is typing); the server
  // records this as the phone's preference and applies it on the first
  // keystroke, which claims the session.
  send({ attach: id, cols: FIXED_GRID.cols, rows: FIXED_GRID.rows });
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

// ── Input ────────────────────────────────────────────────────────────────
/** Write raw bytes to the attached PTY (binary '0' + payload). */
function writePty(data: string) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return false;
  if (attachedId === null) {
    toast("没有已连接的终端");
    return false;
  }
  const bytes = new TextEncoder().encode(data);
  const frame = new Uint8Array(1 + bytes.length);
  frame[0] = 0x30; // '0'
  frame.set(bytes, 1);
  ws.send(frame);
  return true;
}

function submit() {
  const text = inputEl.value;
  if (text.trim() === "") return;
  // Whatever is on the other end — a shell, an agent, a REPL — the phone
  // sends the same thing a keyboard would: the text, then Enter.
  if (!writePty(`${text}\r`)) return;
  conv.noteSent(text);
  inputEl.value = "";
  autoGrow();
  scrollToBottom();
}

/** Grow the composer with its content, up to a few lines. */
function autoGrow() {
  inputEl.style.height = "auto";
  inputEl.style.height = `${Math.min(inputEl.scrollHeight, 120)}px`;
}

inputEl.addEventListener("input", autoGrow);
inputEl.addEventListener("keydown", (e) => {
  // Enter sends; Shift+Enter makes a new line. On phones the soft keyboard's
  // return key reports as Enter without a modifier, which is what we want.
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    submit();
  }
});

$("#btn-send").addEventListener("click", submit);
$("#btn-list").addEventListener("click", openSheet);
$("#btn-close-sheet").addEventListener("click", closeSheet);

// Control keys: the things a shell needs that a soft keyboard has no key for.
for (const btn of document.querySelectorAll<HTMLButtonElement>(".key-btn")) {
  btn.addEventListener("click", () => {
    const ctrl = btn.dataset.ctrl;
    const seq = btn.dataset.seq;
    if (ctrl) {
      writePty(String.fromCharCode(Number(ctrl)));
    } else if (seq === "up") {
      writePty("\x1b[A");
    } else if (seq === "down") {
      writePty("\x1b[B");
    }
  });
}

// Keep the session list fresh: the desktop opens and closes terminals
// without the phone being told.
window.setInterval(() => send({ list: true }), 5000);

// ── Boot ─────────────────────────────────────────────────────────────────
connect();
