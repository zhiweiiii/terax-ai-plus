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

//

// UI model: every desktop terminal is a window in one scrollable grid —

// group name + terminal stacked together, no switching. The page shows ~5

// windows per screen and scrolls infinitely. One WebSocket per live window.

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

type Win = {
  id: number;

  cold: boolean;

  el: HTMLElement;

  termEl: HTMLElement;

  ws: WebSocket | null;

  seq: number;

  term: Terminal | null;

  fit: FitAddon | null;

  cols: number | null;

  rows: number | null;

  retries: number;
};

const $ = <T extends HTMLElement>(sel: string): T => {
  const el = document.querySelector<T>(sel);

  if (!el) throw new Error(`missing ${sel}`);

  return el;
};

const app = $("#app");

app.innerHTML = `


<div class="topbar">


<span id="title">Terax</span>


<span id="status" class="status"></span>


</div>


<div id="grid" class="grid">


<div id="empty-hint" class="empty-hint" hidden>


<div class="empty-title">没有活动终端</div>


<div class="empty-sub">在桌面端打开一个命令行后，这里会自动显示</div>


</div>


</div>


<div class="toolbar">


<button id="btn-ctrl-c" class="tool-btn" title="发送 Ctrl+C 到当前窗口 (中断)">Ctrl+C</button>


<button id="btn-ctrl-d" class="tool-btn" title="发送 Ctrl+D 到当前窗口 (EOF)">Ctrl+D</button>


<button id="btn-keyboard" class="tool-btn" title="显示/隐藏键盘">⌨</button>


</div>


<div id="toast" class="toast" hidden></div>


`;

const gridEl = $("#grid") as HTMLDivElement;

const emptyHint = $("#empty-hint") as HTMLDivElement;

const statusEl = $("#status") as HTMLSpanElement;

const toastEl = $("#toast") as HTMLDivElement;

const proto = location.protocol === "https:" ? "wss:" : "ws:";

const wsUrl = `${proto}//${location.host}/ws`;

const TERM_OPTIONS: ConstructorParameters<typeof Terminal>[0] = {
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
};

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

// ── Window management ────────────────────────────────────────────────────

const wins = new Map<number, Win>();

let activeWinId: number | null = null;

let listWs: WebSocket | null = null;

let listSeq = 0;

let listReconnectTimer: number | null = null;

let listReconnectDelay = 1000;

// Sessions currently opening (cold tap): retried until live, then the grid

// creates a real window.

function sendList(obj: unknown) {
  if (listWs && listWs.readyState === WebSocket.OPEN) {
    listWs.send(JSON.stringify(obj));
  }
}

function activeWin(): Win | null {
  return activeWinId !== null ? (wins.get(activeWinId) ?? null) : null;
}

function setActiveWin(id: number | null) {
  activeWinId = id;

  for (const [wid, w] of wins) {
    w.el.classList.toggle("active", wid === id);
  }
}

function makeWinEl(s: SessionInfo, cold: boolean): Win {
  const el = document.createElement("div");

  el.className = "win" + (cold ? " cold" : "");

  const head = document.createElement("div");

  head.className = "win-head";

  const space = document.createElement("span");

  space.className = "win-space";

  space.textContent = s.space ?? "";

  const name = document.createElement("span");

  name.className = "win-name";

  name.textContent = s.title || s.cwd || `会话 #${s.id}`;

  const badge = document.createElement("span");

  badge.className = "win-badge";

  head.append(space, name, badge);

  const termEl = document.createElement("div");

  termEl.className = "win-term";

  el.append(head, termEl);

  gridEl.appendChild(el);

  const win: Win = {
    id: s.id,

    cold,

    el,

    termEl,

    ws: null,

    seq: 0,

    term: null,

    fit: null,

    cols: null,

    rows: null,

    retries: 0,
  };

  wins.set(s.id, win);

  if (cold) {
    el.classList.add("cold");

    termEl.innerHTML = `<div class="cold-hint">未打开 · 点击激活</div>`;

    el.addEventListener("click", () => activateCold(win));

    return win;
  }

  const term = new Terminal(TERM_OPTIONS);

  const fit = new FitAddon();

  term.loadAddon(fit);

  try {
    term.loadAddon(new WebglAddon());
  } catch {
    // fall back to the DOM renderer when WebGL is unavailable.
  }

  term.open(termEl);

  win.term = term;

  win.fit = fit;

  term.onData((data) => {
    // Only the tapped window forwards keystrokes.

    if (activeWinId !== win.id) return;

    if (!win.ws || win.ws.readyState !== WebSocket.OPEN) return;

    const bytes = new TextEncoder().encode(data);

    const frame = new Uint8Array(1 + bytes.length);

    frame[0] = 0x30; // '0'

    frame.set(bytes, 1);

    win.ws.send(frame);
  });

  // Tap anywhere in the window focuses it.

  el.addEventListener("pointerdown", () => {
    setActiveWin(win.id);

    term.focus();
  });

  connectWindow(win);

  return win;
}

function removeWin(id: number) {
  const win = wins.get(id);

  if (!win) return;

  if (win.ws) {
    try {
      win.ws.close();
    } catch {}
  }

  if (win.term) {
    try {
      win.term.dispose();
    } catch {}
  }

  win.el.remove();

  wins.delete(id);

  if (activeWinId === id) setActiveWin(firstWinId());
}

function firstWinId(): number | null {
  for (const id of wins.keys()) return id;

  return null;
}

// ── Per-window WebSocket ──────────────────────────────────────────────────

function connectWindow(win: Win) {
  const mySeq = ++win.seq;

  const ws = new WebSocket(wsUrl);

  win.ws = ws;

  ws.binaryType = "arraybuffer";

  const retry = () => {
    if (win.seq !== mySeq) return;

    if (!wins.has(win.id)) return;

    win.retries++;

    if (win.retries > 3) {
      setStatus(`窗口 #${win.id} 连接失败`, "err");

      return;
    }

    window.setTimeout(() => connectWindow(win), win.retries * 800);
  };

  ws.onopen = () => {
    win.retries = 0;

    ws.send(JSON.stringify({ attach: win.id }));
  };

  ws.onmessage = (ev) => {
    if (typeof ev.data !== "string") {
      const bytes = new Uint8Array(ev.data as ArrayBuffer);

      if (bytes.length === 0) return;

      if (bytes[0] === 0x30 /* '0' */ && win.term) {
        win.term.write(bytes.subarray(1));
      }

      return;
    }

    let msg: any;

    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }

    switch (msg.type) {
      case "attached":
        win.retries = 0;

        win.cold = false;

        win.el.classList.remove("cold");

        const hint = win.termEl.querySelector(".cold-hint");

        if (hint) hint.remove();

        if (typeof msg.cols === "number" && typeof msg.rows === "number") {
          win.cols = msg.cols;

          win.rows = msg.rows;

          fitToPty(win);
        }

        win.term?.focus();

        break;

      case "opening":
        // The desktop is spawning this tab; re-list shortly so the grid

        // picks it up when it turns live.

        scheduleOpeningRetry(win.id);

        break;

      case "exit":
        toast(`会话 #${msg.id} 已退出 (${msg.code})`);

        markWinExited(win, msg.code);

        break;

      case "error":
        toast(msg.message || "错误");

        if (msg.message === "output too fast, resubscribe") {
          // Evicted for falling behind; reconnect to replay history.

          ws.close();

          retry();
        }

        break;
    }
  };

  ws.onclose = () => {
    if (win.seq !== mySeq) return;

    win.ws = null;

    if (wins.has(win.id) && !win.cold) retry();
  };

  ws.onerror = () => {
    if (win.seq !== mySeq) return;

    ws.close();
  };
}

function markWinExited(win: Win, _code: number) {
  // Keep the window visible with a notice; the next session-list refresh

  // removes it once the tab leaves the list.

  win.el.classList.add("exited");

  const hint = win.termEl.querySelector(".cold-hint");

  if (!hint) {
    const d = document.createElement("div");

    d.className = "cold-hint";

    d.textContent = "会话已退出";

    win.termEl.appendChild(d);
  }
}

// ── Grid size: render at the PTY's own cols/rows, scale the font ─────────

function fitToPty(win: Win) {
  if (!win.term || !win.fit) return;

  if (win.cols === null || win.rows === null || win.cols < 8 || win.rows < 2)
    return;

  for (let i = 0; i < 5; i++) {
    try {
      win.fit.fit();
    } catch {
      return;
    }

    if (win.term.cols === win.cols) break;

    const ratio = win.cols / win.term.cols;

    const base = win.term.options.fontSize ?? 14;

    const fs = Math.round(base * ratio * 10) / 10;

    if (fs < 4 || fs > 72) break; // floor guard

    win.term.options.fontSize = Math.max(4, fs);
  }

  win.term.resize(win.cols, Math.max(2, Math.min(win.term.rows, win.rows)));
}

// ── Session list (main connection) ────────────────────────────────────────

function connectList() {
  const mySeq = ++listSeq;

  listWs = new WebSocket(wsUrl);

  listWs.binaryType = "arraybuffer";

  listWs.onopen = () => {
    setStatus("已连接");

    listReconnectDelay = 1000;

    sendList({ list: true });
  };

  listWs.onmessage = (ev) => {
    if (typeof ev.data !== "string") return; // list connection never attaches

    let msg: any;

    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }

    switch (msg.type) {
      case "sessions":
        syncGrid(msg.sessions);

        break;

      case "opening":
        scheduleOpeningRetry(msg.id);

        break;

      case "attached":
        // This connection attached only to warm up a cold tab; the grid

        // window (its own connection) takes over once the tab is live.

        sendList({ list: true });

        break;

      case "exit":

      case "error":
        break;
    }
  };

  listWs.onclose = () => {
    if (mySeq !== listSeq) return;

    setStatus("已断开", "err");

    scheduleListReconnect();
  };

  listWs.onerror = () => {
    if (mySeq !== listSeq) return;

    listWs?.close();
  };
}

function scheduleListReconnect() {
  if (listReconnectTimer !== null) return;

  listReconnectTimer = window.setTimeout(() => {
    listReconnectTimer = null;

    connectList();
  }, listReconnectDelay);

  listReconnectDelay = Math.min(listReconnectDelay * 2, 15000);
}

// Grid = one window per session, stacked in list order (space grouping shows

// in each window's header). Windows are created/removed as the list changes.

function syncGrid(sessions: SessionInfo[]) {
  if (sessions.length === 0) {
    emptyHint.hidden = false;
  } else {
    emptyHint.hidden = true;
  }

  const seen = new Set<number>();

  for (const s of sessions) {
    seen.add(s.id);

    const existing = wins.get(s.id);

    if (existing) {
      // Live now (was cold placeholder): upgrade to a real window.

      if (existing.cold && s.live) {
        existing.cold = false;

        existing.el.classList.remove("cold");

        existing.termEl.innerHTML = "";

        const term = new Terminal(TERM_OPTIONS);

        const fit = new FitAddon();

        term.loadAddon(fit);

        try {
          term.loadAddon(new WebglAddon());
        } catch {}

        term.open(existing.termEl);

        existing.term = term;

        existing.fit = fit;

        term.onData((data) => {
          if (activeWinId !== existing.id) return;

          if (!existing.ws || existing.ws.readyState !== WebSocket.OPEN) return;

          const bytes = new TextEncoder().encode(data);

          const frame = new Uint8Array(1 + bytes.length);

          frame[0] = 0x30;

          frame.set(bytes, 1);

          existing.ws.send(frame);
        });

        existing.el.addEventListener("pointerdown", () => {
          setActiveWin(existing.id);

          term.focus();
        });

        connectWindow(existing);
      }

      // Track desktop-side PTY resizes.

      if (
        existing.term &&
        typeof s.cols === "number" &&
        typeof s.rows === "number"
      ) {
        if (s.cols !== existing.cols || s.rows !== existing.rows) {
          existing.cols = s.cols;

          existing.rows = s.rows;

          fitToPty(existing);
        }
      }

      continue;
    }

    // New entry: live → real window, cold → placeholder.

    makeWinEl(s, !s.live);
  }

  // Drop windows whose session left the list (closed on the desktop).

  for (const [id] of wins) {
    if (!seen.has(id)) removeWin(id);
  }

  if (activeWinId === null || !wins.has(activeWinId)) {
    const active = sessions.find((s) => s.active) ?? sessions[0];

    if (active) setActiveWin(active.id);
  }
}

// ── Cold tab activation ───────────────────────────────────────────────────

function activateCold(win: Win) {
  setActiveWin(win.id);

  setStatus(`正在打开会话 #${win.id}…`, "warn");

  // Attach on the list connection: the server asks the desktop to spawn the

  // tab and replies "opening". When it turns live, syncGrid upgrades the

  // placeholder into a real window.

  sendList({ attach: win.id });
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

  window.setTimeout(() => sendList({ list: true }), 1500);
}

// ── Toolbar ──────────────────────────────────────────────────────────────

function sendControl(code: number) {
  const win = activeWin();

  if (!win?.ws || win.ws.readyState !== WebSocket.OPEN) return;

  const frame = new Uint8Array(2);

  frame[0] = 0x30; // '0' = input

  frame[1] = code;

  win.ws.send(frame);
}

$("#btn-ctrl-c").addEventListener("click", () => sendControl(0x03));

$("#btn-ctrl-d").addEventListener("click", () => sendControl(0x04));

$("#btn-keyboard").addEventListener("click", () => activeWin()?.term?.focus());

// ── Boot ─────────────────────────────────────────────────────────────────

connectList();

// Desktop resizes its PTY (and the TUI repaints) without the phone being

// told; poll the session list every 5 s to pick up the new grid sizes.

window.setInterval(() => {
  sendList({ list: true });
}, 5000);
