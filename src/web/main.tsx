import "@xterm/xterm/css/xterm.css";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Terminal } from "@xterm/xterm";

// ── Protocol (mirrors src-tauri/src/modules/web/mod.rs) ────────────────
// client → server:
//   first text message: { attach: id, cols, rows } | { list: true }
//   binary: '0' + bytes = input, '1' + json = resize
// server → client:
//   binary '0' + bytes = output
//   text: sessions / attached / exit / error

type SessionInfo = { id: number; cwd: string | null; viewers: number };
type SessionsMsg = { type: "sessions"; sessions: SessionInfo[] };
type AttachedMsg = { type: "attached"; id: number };
type ExitMsg = { type: "exit"; id: number; code: number };
type ErrorMsg = { type: "error"; message: string };

const THEME = {
  foreground: "#e6edf3",
  background: "#0b0e14",
  cursor: "#f0f6fc",
  selectionBackground: "#264f78",
  black: "#1c2128",
  red: "#ff7b72",
  green: "#3fb950",
  yellow: "#d29922",
  blue: "#58a6ff",
  magenta: "#bc8cff",
  cyan: "#39c5cf",
  white: "#b1bac4",
  brightBlack: "#6e7681",
  brightRed: "#ffa198",
  brightGreen: "#56d364",
  brightYellow: "#e3b341",
  brightBlue: "#79c0ff",
  brightMagenta: "#d2a8ff",
  brightCyan: "#56d4dd",
  brightWhite: "#f0f6fc",
};

function wsUrl(): string {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${location.host}/ws`;
}

class WebTerm {
  private term: Terminal;
  private fit = new FitAddon();
  private socket: WebSocket | null = null;
  private attachedId: number | null = null;
  private textEncoder = new TextEncoder();
  private reconnectTimer: number | null = null;

  constructor(
    private host: HTMLElement,
    private sessionList: HTMLElement,
    private statusEl: HTMLElement,
  ) {
    this.term = new Terminal({
      fontSize: 14,
      fontFamily:
        '"JetBrains Mono","Cascadia Code",Consolas,monospace',
      cursorBlink: true,
      scrollback: 5000,
      theme: THEME,
      allowProposedApi: true,
    });
    this.term.loadAddon(this.fit);
    this.term.loadAddon(new WebLinksAddon());
    this.term.open(host);
    this.fit.fit();
    this.term.focus();

    this.term.onData((data) => this.sendInput(data));
    this.term.onBinary((data) => this.sendInput(data));
    this.term.onResize(({ cols, rows }) => {
      if (this.attachedId !== null && this.socket?.readyState === WebSocket.OPEN) {
        const payload = new Uint8Array(1 + 1 + JSON.stringify({ cols, rows }).length);
        payload[0] = 0x31;
        payload.set(new TextEncoder().encode(JSON.stringify({ cols, rows })), 1);
        this.socket.send(payload);
      }
    });
    window.addEventListener("resize", () => this.fit.fit());
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) this.fit.fit();
    });
  }

  connect() {
    if (this.socket && this.socket.readyState <= WebSocket.OPEN) return;
    this.setStatus("连接中…");
    const socket = new WebSocket(wsUrl());
    this.socket = socket;
    socket.binaryType = "arraybuffer";

    socket.onopen = () => {
      this.setStatus("已连接");
      // Request the session list on open.
      socket.send(JSON.stringify({ list: true }));
    };
    socket.onmessage = (ev) => this.onMessage(ev.data);
    socket.onclose = () => {
      this.setStatus("已断开，重连中…");
      this.scheduleReconnect();
    };
    socket.onerror = () => socket.close();
  }

  private scheduleReconnect() {
    if (this.reconnectTimer !== null) return;
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, 1500);
  }

  private setStatus(text: string) {
    this.statusEl.textContent = text;
  }

  private onMessage(raw: unknown) {
    if (typeof raw === "string") {
      let msg: SessionsMsg | AttachedMsg | ExitMsg | ErrorMsg;
      try {
        msg = JSON.parse(raw);
      } catch {
        return;
      }
      switch (msg.type) {
        case "sessions":
          this.renderSessions(msg.sessions);
          break;
        case "attached":
          this.attachedId = msg.id;
          this.term.focus();
          break;
        case "exit":
          this.setStatus(`会话已退出 (code ${msg.code})`);
          this.attachedId = null;
          break;
        case "error":
          this.setStatus(`错误: ${msg.message}`);
          break;
      }
      return;
    }
    // Binary: '0' + output
    const bytes = new Uint8Array(raw as ArrayBuffer);
    if (bytes.length === 0) return;
    if (bytes[0] === 0x30) {
      this.term.write(bytes.subarray(1));
    }
  }

  private renderSessions(sessions: SessionInfo[]) {
    this.sessionList.innerHTML = "";
    if (sessions.length === 0) {
      const empty = document.createElement("div");
      empty.className = "session-empty";
      empty.textContent = "没有活动的命令行";
      this.sessionList.appendChild(empty);
      return;
    }
    for (const s of sessions) {
      const row = document.createElement("button");
      row.className = "session-row";
      row.type = "button";
      const title = document.createElement("div");
      title.className = "session-title";
      title.textContent = s.cwd ? s.cwd.split(/[\\/]/).filter(Boolean).pop() || s.cwd : `Terminal #${s.id}`;
      const sub = document.createElement("div");
      sub.className = "session-sub";
      sub.textContent = `${s.cwd ?? ""}${s.viewers > 0 ? ` · ${s.viewers} 人观看` : ""}`;
      row.appendChild(title);
      row.appendChild(sub);
      row.addEventListener("click", () => this.attach(s.id));
      this.sessionList.appendChild(row);
    }
  }

  private attach(id: number) {
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    const cols = this.term.cols;
    const rows = this.term.rows;
    this.term.reset();
    this.socket.send(JSON.stringify({ attach: id, cols, rows }));
  }

  private sendInput(data: string | Uint8Array) {
    if (this.attachedId === null) return;
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    if (typeof data === "string") {
      const encoded = this.textEncoder.encode(data);
      const payload = new Uint8Array(encoded.length + 1);
      payload[0] = 0x30;
      payload.set(encoded, 1);
      this.socket.send(payload);
    } else {
      const payload = new Uint8Array(data.length + 1);
      payload[0] = 0x30;
      payload.set(data, 1);
      this.socket.send(payload);
    }
  }
}

// ── UI scaffolding (vanilla DOM, phone-first) ─────────────────────────
function buildUI(): void {
  const root = document.getElementById("root")!;
  root.innerHTML = `
    <div class="app">
      <header class="topbar">
        <button id="btn-sessions" class="icon-btn" aria-label="会话列表">☰</button>
        <span id="status" class="status">连接中…</span>
        <span class="spacer"></span>
      </header>
      <div id="terminal-host" class="terminal-host"></div>
      <div id="drawer" class="drawer" hidden>
        <div class="drawer-head">
          <span>命令行会话</span>
          <button id="btn-close-drawer" class="icon-btn" aria-label="关闭">✕</button>
        </div>
        <div id="session-list" class="session-list"></div>
      </div>
      <div id="backdrop" class="backdrop" hidden></div>
    </div>`;

  const host = document.getElementById("terminal-host")!;
  const sessionList = document.getElementById("session-list")!;
  const statusEl = document.getElementById("status")!;
  const app = new WebTerm(host, sessionList, statusEl);

  const drawer = document.getElementById("drawer")!;
  const backdrop = document.getElementById("backdrop")!;
  const openDrawer = () => {
    drawer.hidden = false;
    backdrop.hidden = false;
  };
  const closeDrawer = () => {
    drawer.hidden = true;
    backdrop.hidden = true;
  };
  document.getElementById("btn-sessions")!.addEventListener("click", openDrawer);
  document.getElementById("btn-close-drawer")!.addEventListener("click", closeDrawer);
  backdrop.addEventListener("click", closeDrawer);

  app.connect();
}

// Inject styles (kept out of the xterm import so the page stays single-file).
const style = document.createElement("style");
style.textContent = `
  .app { display: flex; flex-direction: column; height: 100%; }
  .topbar {
    display: flex; align-items: center; gap: 8px;
    padding: 8px 12px; padding-top: max(8px, env(safe-area-inset-top));
    background: #0e1116; border-bottom: 1px solid #1f2630;
    -webkit-user-select: none; user-select: none;
  }
  .status { font-size: 12px; color: #8b949e; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .spacer { flex: 1; }
  .icon-btn {
    background: transparent; border: none; color: #8b949e;
    font-size: 18px; width: 36px; height: 36px; border-radius: 8px;
    display: flex; align-items: center; justify-content: center;
  }
  .icon-btn:active { background: #21262d; color: #e6edf3; }
  .terminal-host { flex: 1; min-height: 0; padding: 4px 0; }
  .terminal-host .xterm { height: 100%; padding: 0 8px; }
  .drawer {
    position: fixed; top: 0; left: 0; bottom: 0; width: min(85vw, 320px);
    background: #0e1116; z-index: 20; display: flex; flex-direction: column;
    box-shadow: 4px 0 24px rgba(0,0,0,.5);
  }
  .drawer[hidden] { display: none; }
  .drawer-head {
    display: flex; align-items: center; justify-content: space-between;
    padding: 16px 16px 8px; font-size: 13px; font-weight: 600; color: #e6edf3;
    padding-top: max(16px, env(safe-area-inset-top));
  }
  .session-list { flex: 1; overflow-y: auto; padding: 8px; }
  .session-row {
    display: block; width: 100%; text-align: left;
    background: transparent; border: none; border-radius: 10px;
    padding: 10px 12px; margin-bottom: 4px; cursor: pointer;
  }
  .session-row:active { background: #21262d; }
  .session-title { font-size: 14px; color: #e6edf3; font-weight: 500; }
  .session-sub { font-size: 11px; color: #6e7681; margin-top: 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .session-empty { padding: 16px; font-size: 13px; color: #6e7681; text-align: center; }
  .backdrop {
    position: fixed; inset: 0; background: rgba(0,0,0,.4); z-index: 10;
  }
  .backdrop[hidden] { display: none; }
`;
document.head.appendChild(style);

buildUI();
