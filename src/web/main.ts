import {
  type Block,
  Conversation,
  sameMessage,
  type Turn,
} from "./conversation";
import { renderMarkdown } from "./markdown";
import "./style.css";

// ── WebSocket wire protocol (see src-tauri/src/modules/web/mod.rs) ──────
// client → server:
//   first text: { "attach": <id> } or { "list": true }
//   binary:     '0' + bytes        → write input
//   text:       { "scheduleAdd": { command, delaySeconds } } → queue a command
//               { "scheduleCancel": <job id> }
//               '1' + JSON         → resize { "cols": N, "rows": N }
// server → client:
//   binary '0' + bytes             → terminal output (seed frame first)
//   text: { "type": "sessions", "sessions": [...], "spaces": [...] }
//         { "type": "attached", "id": N, "cols": C, "rows": R, "alt": bool,
//                               "seed": bool }
//         { "type": "opening", "id": N }
//         { "type": "resized", "cols": C, "rows": R }
//         { "type": "exit", "id": N, "code": C }
//         { "type": "schedules", "jobs": [...] }
//         { "type": "error", "message": "..." }
//
// One session has ONE grid, and whoever is typing owns it (SizeOwner in the
// Rust pty module). Watching never moves it: `attached` reports the grid the
// stream is actually laid out against, and the parser follows it. The phone
// sends NO cols/rows on attach: it renders no grid, so it has no size to want,
// and imposing one would resize the shared PTY and reflow the desktop's screen
// under a program laid out for it. The PTY stays at the desktop's grid, the
// phone parses at that grid, and `resized` keeps it in step when the desktop's
// own window changes.
//
// What the phone shows first is the DESKTOP TERMINAL'S OWN BUFFER, serialized
// and sent as one seed frame - the desktop is the only thing that knows what a
// command line shows, and a second copy of the output kept server-side drifted
// from it. `seed` says whether that frame is coming; `alt` is the fallback
// buffer mode for when it is not.

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

/** One turn of an agent conversation, read from the agent's OWN transcript
 *  (`~/.claude/projects/**.jsonl`, opencode's SQLite) rather than parsed off
 *  its screen. See the Rust `transcript` module. */
/** One piece of a turn, in the order the agent produced it. */
type TranscriptPart =
  | { kind: "text"; text: string }
  | {
      kind: "tool";
      name: string;
      /** What it was called on: the command, the path, the pattern. */
      subject?: string;
      /** What it printed, already clipped server-side. */
      output?: string;
      /** Lines the clip dropped. */
      elided?: number;
      failed?: boolean;
    };

type TranscriptMessage = {
  id: string;
  role: "user" | "assistant";
  at: number;
  /** The message for a user turn; the prose flattened out of `parts` for an
   *  agent one. Compared against, not rendered — `parts` is what is drawn. */
  text: string;
  reasoning?: string;
  parts: TranscriptPart[];
};

type TranscriptMsg = {
  type: "transcript";
  source: string;
  session_id: string;
  title?: string;
  mode?: string;
  model?: string;
  messages: TranscriptMessage[];
  working?: { since: number };
  revision: number;
};

/** A command queued to run later. The clock is server-side (see
 *  src-tauri/src/modules/schedule.rs): a phone that locked its screen, or a
 *  tab that was closed, cannot be the thing counting down. */
type ScheduledJob = {
  id: number;
  leaf_id: number;
  command: string;
  /** Epoch milliseconds. */
  fire_at: number;
  created_at: number;
};

type SchedulesMsg = {
  type: "schedules";
  jobs: ScheduledJob[];
};

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
  seed?: boolean;
  message?: string;
  sessions?: SessionInfo[];
  spaces?: SpaceInfo[];
};

/** The agent conversation for the attached session, when one is running.
 *
 *  While this is set it IS the conversation: the screen parse still runs, but
 *  only for the thing the transcript cannot know - what the program is asking
 *  you to pick right now. A plain shell has no transcript and the page falls
 *  back to the screen entirely. */
let transcript: TranscriptMsg | null = null;

/** What this page has sent that the transcript has not recorded yet.
 *
 *  The screen path has its own version of this (`Conversation.pending`), and
 *  it drops a message as soon as the PROGRAM paints it. Under a transcript
 *  that is too early: the agent echoes your message on its screen a beat
 *  before it writes the turn out, so the bubble disappeared and came back.
 *  Held here instead until the transcript actually has it.
 *
 *  Each entry remembers the last user message the transcript already carried
 *  when it was sent, because "the transcript has this" can only be answered
 *  against what arrived AFTER the send. See `transcriptRecorded`. */
type Awaiting = { text: string; afterId: string | null };
let awaitingTranscript: Awaiting[] = [];

/** Commands queued to run later, as the server last reported them. */
let schedules: ScheduledJob[] = [];

/** The grid the parser falls back to if the server ever omits one. The phone
 *  does not have a grid of its own to want: it renders no terminal, so any
 *  size it imposed would only reflow the DESKTOP's screen and lay the program
 *  out at a width nobody is looking at. It attaches without a preference and
 *  parses at whatever the desktop is at. */
const PARSE_FALLBACK_GRID = { cols: 120, rows: 40 } as const;

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
  <div id="agents" class="agents" hidden></div>
  <div id="thread" class="thread">
    <div id="empty-hint" class="empty-hint" hidden>
      <div class="empty-title">没有活动终端</div>
      <div class="empty-sub">在桌面端打开一个命令行后，这里会自动显示</div>
    </div>
    <div id="stream" class="stream">
      <div id="turns" class="bubbles"></div>
      <div id="live-blocks" class="bubbles"></div>
      <div id="pending" class="bubbles"></div>
    </div>
  </div>
  <div class="composer">
    <button id="to-bottom" class="to-bottom" hidden>回到最新 ↓</button>
    <div id="thinking" class="thinking" hidden></div>
    <div id="choices" class="choices" hidden></div>
    <div id="sched" class="sched" hidden>
      <div class="sched-form">
        <input id="sched-h" class="sched-num" type="number" min="0" max="48"
          inputmode="numeric" placeholder="0" aria-label="小时" />
        <span class="sched-unit">小时</span>
        <input id="sched-m" class="sched-num" type="number" min="0" max="59"
          inputmode="numeric" placeholder="0" aria-label="分钟" />
        <span class="sched-unit">分钟后执行</span>
        <button id="sched-go" class="sched-go" type="button">安排</button>
      </div>
      <div id="sched-list" class="sched-list"></div>
    </div>
    <div id="progstatus" class="progstatus" hidden></div>
    <div class="keyrow">
      <button class="key-btn" data-ctrl="3">Ctrl+C</button>
      <button class="key-btn" data-ctrl="4">Ctrl+D</button>
      <button class="key-btn" data-ctrl="27">Esc</button>
      <button class="key-btn" data-ctrl="9">Tab</button>
      <button class="key-btn" data-seq="shift-tab">⇧Tab</button>
      <button class="key-btn" data-seq="up">↑</button>
      <button class="key-btn" data-seq="down">↓</button>
      <button class="key-btn" data-ctrl="13">↵</button>
      <button id="btn-sched" class="key-btn" title="定时发送">⏱</button>
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
const streamEl = $("#stream") as HTMLDivElement;
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
const thinkingEl = $("#thinking") as HTMLDivElement;
const toBottomEl = $("#to-bottom") as HTMLButtonElement;
const choicesEl = $("#choices") as HTMLDivElement;
const schedEl = $("#sched") as HTMLDivElement;
const schedListEl = $("#sched-list") as HTMLDivElement;
const schedHoursEl = $("#sched-h") as HTMLInputElement;
const schedMinsEl = $("#sched-m") as HTMLInputElement;

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
  const stick = pinnedToBottom;
  if (transcript) {
    renderTranscript(transcript);
  } else {
    renderScreenTurns();
  }
  // Where the unconfirmed bubble belongs depends on what it is waiting for.
  //
  // Under a transcript it is the QUESTION and #live-blocks is the reply being
  // written to it, so it has to come first — rendered last, your own message
  // appeared underneath the answer to it.
  //
  // On the screen path it really is the newest thing: the program's repaint is
  // what is on screen, and a bubble pushed above it would sit over content
  // older than itself. So the DOM order stands there.
  streamEl.dataset.order = transcript ? "transcript" : "screen";
  paintLiveScreen();
  if (stick) scrollToBottom();
}

/** Rendered transcript turns, keyed by message id. */
const transcriptNodes = new Map<string, HTMLElement>();

/** The agent conversation, straight from the agent's own record of it.
 *
 *  Nothing here is inferred: who said what, what the agent thought, and which
 *  tools it ran are all stated. That is the whole point of reading the
 *  transcript instead of the screen. */
function renderTranscript(t: TranscriptMsg) {
  if (nodes.size > 0) {
    for (const node of nodes.values()) node.remove();
    nodes.clear();
  }
  const live = new Set<string>();
  // Placed in transcript order, not in the order the ids were first seen.
  // Appending new nodes only was fine while messages could nothing but arrive
  // at the end; anything else (a turn dropped and coming back, an id reused,
  // rows read in a different order) put a message in the wrong place and left
  // it there for the rest of the session.
  let prev: HTMLElement | null = null;
  for (const message of t.messages) {
    live.add(message.id);
    let node = transcriptNodes.get(message.id);
    if (!node) {
      node = document.createElement("div");
      transcriptNodes.set(message.id, node);
    }
    paintTranscriptMessage(node, message);
    const target: ChildNode | null = prev
      ? prev.nextSibling
      : turnsEl.firstChild;
    if (node !== target) turnsEl.insertBefore(node, target);
    prev = node;
  }
  for (const [id, node] of transcriptNodes) {
    if (live.has(id)) continue;
    node.remove();
    transcriptNodes.delete(id);
  }
}

/** Prose the agent wrote, as Markdown.
 *
 *  The screen path is left alone: what it carries is Markdown the TUI already
 *  drew. */
function proseNode(text: string): HTMLElement {
  const body = document.createElement("div");
  body.className = "turn-text";
  renderMarkdown(body, text);
  return body;
}

/** One tool call, where it ran: what was invoked and what it printed.
 *
 *  Both halves come from the agent's own record — the call and its result are
 *  separate entries linked by an id — so nothing here is recognised off a
 *  screen or matched by text. */
function toolNode(part: Extract<TranscriptPart, { kind: "tool" }>): HTMLElement {
  const box = document.createElement("div");
  box.className = part.failed ? "tool failed" : "tool";

  const head = document.createElement("div");
  head.className = "tool-head";
  const name = document.createElement("span");
  name.className = "tool-name";
  name.textContent = part.name;
  head.appendChild(name);
  if (part.subject) {
    const subject = document.createElement("span");
    subject.className = "tool-subject";
    subject.textContent = part.subject;
    head.appendChild(subject);
  }
  box.appendChild(head);

  if (part.output) {
    const out = document.createElement("pre");
    out.className = "tool-out";
    out.textContent = part.output;
    box.appendChild(out);
  }
  // Say what is missing rather than quietly showing less than there was.
  if (part.elided) {
    const more = document.createElement("div");
    more.className = "tool-more";
    more.textContent = `+${part.elided} 行`;
    box.appendChild(more);
  }
  return box;
}

function paintTranscriptMessage(node: HTMLElement, m: TranscriptMessage) {
  const parts = m.parts ?? [];
  const shape = parts
    .map((p) =>
      p.kind === "text"
        ? `t${p.text.length}`
        : `x${p.name}:${p.subject ?? ""}:${p.output?.length ?? -1}`,
    )
    .join("|");
  const sig = `${m.role}:${m.text.length}:${m.reasoning?.length ?? 0}:${shape}`;
  if (painted.get(node) === sig) return;
  painted.set(node, sig);
  // `transcript` marks prose the agent WROTE, as opposed to output a
  // program PAINTED. They are different kinds of text and get different
  // typography: one is a message, the other is a terminal.
  node.className =
    m.role === "user" ? "turn sent" : "turn output transcript";
  node.replaceChildren();

  // A turn is prose, the tools that prose led to, then more prose. Drawing all
  // of the text and then all of the chips was the same turn in the wrong
  // order: every command sat under the whole answer instead of where it ran,
  // so the phone showed the writing in one lump and the commands in another
  // while the desktop showed them interleaved.
  //
  // A user turn carries no parts — its whole content is `text` — and the
  // fallback also covers a transcript from a server that predates `parts`.
  if (parts.length > 0) {
    for (const part of parts) {
      node.appendChild(
        part.kind === "text" ? proseNode(part.text) : toolNode(part),
      );
    }
  } else if (m.text) {
    node.appendChild(proseNode(m.text));
  }
  // What the agent worked through before answering. Set apart rather than
  // hidden: it is the most useful thing on the screen when an answer looks
  // wrong, and the most skippable when it does not.
  if (m.reasoning) {
    const think = document.createElement("details");
    think.className = "turn-think";
    const summary = document.createElement("summary");
    summary.textContent = "思考过程";
    const text = document.createElement("div");
    renderMarkdown(text, m.reasoning);
    think.append(summary, text);
    node.appendChild(think);
  }
}

function renderScreenTurns() {
  if (transcriptNodes.size > 0) {
    for (const node of transcriptNodes.values()) node.remove();
    transcriptNodes.clear();
  }
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
}

/** The part of the conversation still on a full-screen program's screen.
 *
 *  These are the same bubbles as the history above, in the same column: there
 *  is no separate "screen" view, because a screen is not something the reader
 *  should have to think about. The split is purely mechanical — history is
 *  appended once and left alone, this part is rebuilt whenever the program
 *  repaints — and between them they cover the conversation exactly once. */
function paintLiveScreen() {
  // Under a transcript the screen is not the conversation and must not be
  // rendered as one - it would repeat what the transcript already says. Two
  // exceptions, both of them things the transcript cannot know yet:
  //
  //   a pending menu - what it is asking ("create this file", and the diff
  //   that goes in it) exists only on the screen;
  //
  //   a turn in flight - the agent writes a step out when the step ENDS, so
  //   until then the transcript has nothing and the reply is only on screen.
  //   Showing it there is the difference between watching an answer arrive
  //   and staring at a spinner until it is finished.
  const blocks = !transcript
    ? conv.liveBlocks
    : conv.choices.length > 0
      ? conv.promptBlocks
      : isTurnInFlight()
        ? unsettledBlocks(transcript)
        : [];
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

  // Sent, but not yet accounted for by whichever source owns the conversation.
  // Rendered last, because it is the newest thing in it.
  const pending = transcript
    ? awaitingTranscript.map((a) => a.text)
    : conv.pending;
  const psig = pending.join(" ");
  if (pendingEl.dataset.sig !== psig) {
    pendingEl.dataset.sig = psig;
    pendingEl.replaceChildren(
      ...pending.map((text) => {
        const node = document.createElement("div");
        node.className = "turn sent unconfirmed";
        node.textContent = text;
        return node;
      }),
    );
  }

  // The program's status furniture, as a label rather than a bubble. The mode
  // leads it: of everything pinned to a status bar, the mode is the one piece
  // that changes what sending a message DOES, so it reads first and is styled
  // apart from the rest.
  // The transcript states the mode and the model; the screen only ever
  // guessed at them from a status bar it had to find first.
  // The transcript states these; the screen only ever guessed them off a
  // status bar it had to find first, so its half is what needs holding.
  const mode = transcript?.mode ?? held("mode", conv.mode);
  const status = transcript
    ? (transcript.model ?? null)
    : held("status", conv.status);
  const label = mode && status ? `${mode} · ${status}` : (mode ?? status);
  if (label) {
    if (progStatusEl.dataset.sig !== label) {
      progStatusEl.dataset.sig = label;
      progStatusEl.replaceChildren();
      if (mode) {
        const chip = document.createElement("span");
        chip.className = "mode-chip";
        chip.textContent = mode;
        progStatusEl.appendChild(chip);
      }
      if (status) {
        const rest = document.createElement("span");
        rest.className = "status-rest";
        rest.textContent = status;
        progStatusEl.appendChild(rest);
      }
    }
    progStatusEl.hidden = false;
  } else {
    progStatusEl.hidden = true;
    progStatusEl.dataset.sig = "";
  }

  paintThinking();
  paintChoices();

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

/** How long a value read off the screen survives a frame that failed to
 *  observe it.
 *
 *  The spinner and the status bar are parsed out of whatever frame happened to
 *  be captured, and a frame caught mid-repaint simply does not contain them.
 *  Treating that as "it stopped" hid the indicator for one frame and showed it
 *  again on the next, which is a flicker, and because both sit in the composer
 *  it shifted the whole thread each time. These are states that hold until
 *  something contradicts them, not measurements taken per frame. */
const SCREEN_STATE_GRACE_MS = 2000;

const lastSeen = new Map<string, { value: string; at: number }>();

/** Carry the last observed value through a short gap in observation. */
function held(key: string, value: string | null): string | null {
  if (value !== null) {
    lastSeen.set(key, { value, at: Date.now() });
    return value;
  }
  const previous = lastSeen.get(key);
  if (previous && Date.now() - previous.at < SCREEN_STATE_GRACE_MS) {
    return previous.value;
  }
  lastSeen.delete(key);
  return null;
}

/** Drop a held value now, for the moments something does contradict it. */
function forgetHeld(key: string) {
  lastSeen.delete(key);
}

/** What the program is doing right now, and for how long.
 *
 *  Kept out of the bubbles on purpose: "thinking for 12s" is a state that is
 *  true until it is not, and pushing each repaint of it into the conversation
 *  would bury the conversation in its own progress bar. */
function paintThinking() {
  // Two sources, and the order matters. The transcript knows when the turn
  // STARTED, so the page can count up on its own instead of being told an
  // elapsed time on every poll - but it only learns of a turn when the agent
  // writes a step out, which is a beat late. The screen's own spinner is live.
  // So: prefer the transcript when it says a turn is open, and fall back to
  // the screen the rest of the time INCLUDING under a transcript, which is
  // what makes "thinking" appear during an ordinary reply.
  const working = transcript?.working;
  let t: typeof conv.thinking;
  if (working) {
    // The transcript knows when the turn started, so this counts up on its own
    // and never needs holding.
    forgetHeld("thinking");
    t = {
      label: "思考中",
      seconds: Math.max(0, Math.round((Date.now() - working.since) / 1000)),
    };
  } else {
    // The screen's spinner, held across the frames that miss it.
    const seen = conv.thinking;
    const carried = held(
      "thinking",
      seen ? `${seen.label}:${seen.seconds ?? ""}` : null,
    );
    if (carried === null) {
      t = null;
    } else {
      const cut = carried.lastIndexOf(":");
      const seconds = carried.slice(cut + 1);
      t = {
        label: carried.slice(0, cut),
        seconds: seconds === "" ? null : Number(seconds),
      };
    }
  }
  if (!t) {
    thinkingEl.hidden = true;
    thinkingEl.dataset.sig = "";
    return;
  }
  const sig = `${t.label}:${t.seconds ?? ""}`;
  if (thinkingEl.dataset.sig !== sig) {
    thinkingEl.dataset.sig = sig;
    thinkingEl.textContent =
      t.seconds === null ? t.label : `${t.label} · ${formatElapsed(t.seconds)}`;
  }
  thinkingEl.hidden = false;
}

function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}秒`;
  const m = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest === 0 ? `${m}分` : `${m}分${rest}秒`;
}

/** A numbered menu the program is offering, as buttons.
 *
 *  The program is waiting on a single keystroke, so a tap sends exactly that
 *  digit - the same thing the desktop keyboard would send. The options are not
 *  also rendered as bubbles: the question above them still is, and showing the
 *  answers twice reads as the program having said everything twice. */
function paintChoices() {
  const choices = conv.choices;
  const sig = choices.map((c) => `${c.key}:${c.label}:${c.selected}`).join("|");
  if (choicesEl.dataset.sig === sig) {
    choicesEl.hidden = choices.length === 0;
    return;
  }
  choicesEl.dataset.sig = sig;
  if (choices.length === 0) {
    choicesEl.hidden = true;
    choicesEl.replaceChildren();
    return;
  }
  choicesEl.hidden = false;
  choicesEl.replaceChildren(
    ...choices.map((c) => {
      const btn = document.createElement("button");
      btn.className = c.selected ? "choice-btn selected" : "choice-btn";
      btn.type = "button";
      const key = document.createElement("span");
      key.className = "choice-key";
      key.textContent = c.key;
      const text = document.createElement("span");
      text.className = "choice-label";
      text.textContent = c.label;
      if (c.detail) {
        // "选项 A" on its own is not a choice anyone can make; the program
        // printed a description under it and that is the half that decides.
        const detail = document.createElement("span");
        detail.className = "choice-detail";
        detail.textContent = c.detail;
        text.appendChild(detail);
      }
      btn.append(key, text);
      btn.addEventListener("click", () => {
        // The menu is answered with the digit alone; these tools act on the
        // keypress and do not wait for Enter.
        if (!writePty(c.key)) return;
        conv.noteSent(c.key);
        followToBottom();
      });
      return btn;
    }),
  );
}

/** How long until a queued command runs, for the list. */
function untilText(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const sec = total % 60;
  if (h > 0) return `${h}小时${m}分后`;
  if (m > 0) return `${m}分${sec}秒后`;
  return `${sec}秒后`;
}

function paintSchedules() {
  const now = Date.now();
  schedListEl.replaceChildren(
    ...schedules.map((job) => {
      const row = document.createElement("div");
      row.className = "sched-item";

      const when = document.createElement("span");
      when.className = "sched-when";
      when.textContent = untilText(job.fire_at - now);
      row.appendChild(when);

      const cmd = document.createElement("span");
      cmd.className = "sched-cmd";
      cmd.textContent = job.command;
      row.appendChild(cmd);

      const drop = document.createElement("button");
      drop.type = "button";
      drop.className = "sched-drop";
      drop.textContent = "✕";
      drop.setAttribute("aria-label", "取消");
      drop.addEventListener("click", () => send({ scheduleCancel: job.id }));
      row.appendChild(drop);
      return row;
    }),
  );
  if (schedules.length === 0) {
    const empty = document.createElement("div");
    empty.className = "sched-empty";
    empty.textContent = "没有排队的命令";
    schedListEl.appendChild(empty);
  }
}

/** Tick the countdowns while the panel is open, and only then: a timer
 *  running behind a closed panel is exactly the cost this page avoids. */
let schedTimer = 0;
function setSchedOpen(open: boolean) {
  schedEl.hidden = !open;
  if (open) {
    paintSchedules();
    if (!schedTimer) schedTimer = window.setInterval(paintSchedules, 1000);
    followToBottom();
  } else if (schedTimer) {
    window.clearInterval(schedTimer);
    schedTimer = 0;
  }
}

/** The last user message the transcript currently carries, or null. */
function lastUserId(t: TranscriptMsg | null): string | null {
  if (!t) return null;
  for (let i = t.messages.length - 1; i >= 0; i--) {
    if (t.messages[i].role === "user") return t.messages[i].id;
  }
  return null;
}

/** Whether the transcript has recorded this send.
 *
 *  Two rules, and both exist because the bubble disappearing is worse than it
 *  lingering: the message must have been recorded AFTER the send, and it must
 *  match the way an echo matches.
 *
 *  Scanning the whole tail for a substring answered a different question -
 *  "has the user ever said something containing this" - and anything said
 *  twice ("1", "继续", "ok", or any text inside an earlier message) matched a
 *  turn that predated the send. The entry was dropped, the transcript never
 *  actually gained the new message, and the bubble was simply never drawn. */
function transcriptRecorded(t: TranscriptMsg, a: Awaiting): boolean {
  const want = collapse(a.text);
  if (want === "") return true;
  // An anchor the transcript no longer carries (a switched session, a
  // compaction) cannot bound the scan, so fall back to scanning all of it
  // rather than holding the bubble forever.
  const anchored =
    a.afterId !== null && t.messages.some((m) => m.id === a.afterId);
  let after = !anchored;
  for (const m of t.messages) {
    if (!after) {
      if (m.id === a.afterId) after = true;
      continue;
    }
    if (m.role === "user" && sameMessage(collapse(m.text), want)) return true;
  }
  return false;
}

/** Whether the agent is mid-turn, by any account.
 *
 *  `awaitingTranscript` counts too: a message this page sent that the
 *  transcript has not recorded is a turn about to happen, and the screen is
 *  the only place its reply exists yet. Without it the reply blinked out
 *  every time the spinner missed a frame. */
function isTurnInFlight(): boolean {
  return (
    transcript?.working != null ||
    conv.thinking !== null ||
    awaitingTranscript.length > 0
  );
}

/** How many transcript turns to check a screen block against. The overlap is
 *  always at the end of the conversation; scanning all of it would cost more
 *  the longer the session ran, for nothing. */
const SETTLED_LOOKBACK = 3;

/** Shortest screen block that may be dropped as "the transcript already has
 *  it". Below this, containment is coincidence rather than evidence. */
const SETTLED_MIN_MATCH = 8;

/** Screen blocks the transcript has not recorded yet.
 *
 *  The two overlap for a moment: the agent finishes a step, the screen still
 *  shows it, and the poll that will put it in the transcript has not run. Both
 *  rendering it would say everything twice, so anything the transcript already
 *  has is dropped here and the rest is shown as the turn in flight. */
function unsettledBlocks(t: TranscriptMsg): Block[] {
  // Cut at the newest user block on screen and keep only what follows it: the
  // reply being written right now. Everything above it belongs to an earlier
  // exchange the transcript already owns.
  //
  // This has to be positional. Deciding by text alone left pieces of the
  // previous answer behind, because the screen version of it is not the
  // transcript version: the TUI wraps it to the grid and draws bullets, so a
  // substring test against the raw Markdown misses. Those leftovers then
  // rendered into #live-blocks, which sits BELOW #turns, and the previous
  // answer reappeared underneath the question just asked.
  const blocks = conv.liveBlocks;
  let start = 0;
  for (let i = blocks.length - 1; i >= 0; i--) {
    if (blocks[i].role === "user") {
      start = i + 1;
      break;
    }
  }
  // The text test stays as a second gate: the step may have landed in the
  // transcript between the screen painting it and this render.
  const settled = t.messages
    .slice(-SETTLED_LOOKBACK)
    .map((m) => collapse(m.text))
    .filter((text) => text !== "");
  return blocks.slice(start).filter((b) => {
    const text = collapse(b.lines.join(" "));
    if (text === "") return false;
    // Only one direction is safe. A settled turn CONTAINING this block means
    // the transcript already says everything the block does, so the block is
    // a repeat. The reverse - the block containing a settled turn - means the
    // screen has MORE than the transcript, which is precisely the reply still
    // being written, and dropping it deleted the answer as it arrived: any
    // short earlier turn ("好的", "1") is a substring of almost everything.
    //
    // The length floor guards what is left: a two-character block is inside
    // half the conversation by coincidence, and showing it twice for a moment
    // costs far less than losing it.
    if (text.length < SETTLED_MIN_MATCH) return true;
    return !settled.some((s) => s.includes(text));
  });
}

/** Runs of whitespace collapsed, for tolerant comparison. */
function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
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

/** Advance the working indicator between transcript polls.
 *
 *  The transcript reports when the turn started, not how long it has run, so
 *  the count-up happens here. Stopped as soon as nothing is running: a timer
 *  ticking behind an idle session is exactly the kind of cost this page is
 *  supposed not to have. */
let workingTimer = 0;
function startWorkingTicker() {
  if (workingTimer) return;
  workingTimer = window.setInterval(() => {
    if (!transcript?.working) {
      window.clearInterval(workingTimer);
      workingTimer = 0;
      return;
    }
    paintThinking();
  }, 1000);
}

function isNearBottom(): boolean {
  return (
    threadEl.scrollHeight - threadEl.scrollTop - threadEl.clientHeight < 120
  );
}
function scrollToBottom() {
  threadEl.scrollTop = threadEl.scrollHeight;
}

/** Whether new output should pull the view down with it.
 *
 *  Deciding this by measuring the scroll position at render time does not
 *  work: the thread is rebuilt as output arrives, and while a container's
 *  children are being replaced its height collapses and the browser clamps
 *  `scrollTop`. The next measurement then reads as "at the bottom" however far
 *  up the reader had scrolled, and the view yanks itself back down.
 *
 *  So it is decided by the reader instead, and only ever changed inside a
 *  gesture: scroll away and it unpins, scroll back to the bottom and it pins
 *  again. Layout churn cannot move it because churn is not a gesture. */
let pinnedToBottom = true;
/** Open while a gesture is in flight, so only measurements taken during one
 *  count. */
let gestureUntil = 0;
const GESTURE_WINDOW_MS = 500;

function noteScrollGesture() {
  gestureUntil = Date.now() + GESTURE_WINDOW_MS;
}

threadEl.addEventListener("wheel", noteScrollGesture, { passive: true });
threadEl.addEventListener("touchmove", noteScrollGesture, { passive: true });
threadEl.addEventListener(
  "scroll",
  () => {
    if (Date.now() > gestureUntil) return;
    setPinned(isNearBottom());
  },
  { passive: true },
);

function setPinned(next: boolean) {
  if (pinnedToBottom === next) return;
  pinnedToBottom = next;
  toBottomEl.hidden = next;
}

/** Pin and jump, for the moments that are always meant to land at the bottom:
 *  sending a message, answering a menu, the keyboard changing the viewport. */
function followToBottom() {
  setPinned(true);
  scrollToBottom();
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
    if (pinnedToBottom) scrollToBottom();
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
/** True between "attached" and the seed frame the server sends after it. */
let seedPending = false;

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
    // The first output frame after attaching is the seed: the desktop
    // terminal's own buffer, serialized. See Conversation.writeSeed.
    if (seedPending) {
      seedPending = false;
      void conv.writeSeed(payload);
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
      // the seed, and any other grid makes the TUI layout parse wrong.
      conv.setGrid(
        typeof msg.cols === "number" ? msg.cols : PARSE_FALLBACK_GRID.cols,
        typeof msg.rows === "number" ? msg.rows : PARSE_FALLBACK_GRID.rows,
      );
      // A seed carries its own buffer mode (it re-enters the alternate screen
      // itself), so forcing one here would land the desktop's scrollback in
      // the wrong buffer. `alt` is only for the case where no seed came back
      // and the phone has nothing but the live stream to go on.
      seedPending = msg.seed === true;
      if (!seedPending) conv.setAltScreen(msg.alt === true);
      emptyHint.hidden = true;
      setStatus(`会话 #${msg.id}`);
      send({ list: true });
      break;
    case "transcript": {
      const next = raw as TranscriptMsg;
      if (!Array.isArray(next.messages)) break;
      transcript = next;
      awaitingTranscript = awaitingTranscript.filter(
        (a) => !transcriptRecorded(next, a),
      );
      render();
      // A running turn's elapsed time has to advance between polls.
      startWorkingTicker();
      break;
    }
    case "schedules": {
      const next = (raw as SchedulesMsg).jobs;
      if (!Array.isArray(next)) break;
      schedules = next;
      if (schedEl.hidden === false) paintSchedules();
      break;
    }
    case "resized":
      // The grid changed because one end claimed the session. Every viewer
      // parses at the same grid (the byte stream is laid out against it), so
      // follow the owner. The phone never fights for a grid of its own.
      if (typeof msg.cols === "number" && typeof msg.rows === "number") {
        conv.setGrid(msg.cols, msg.rows);
      }
      break;
    case "exit":
      // The agent went with the shell; its transcript is no longer what this
      // session shows.
      if (attachedId === msg.id) transcript = null;
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
  seedPending = false;
  transcript = null;
  awaitingTranscript = [];
  // The server seeds from a different terminal's buffer: start the
  // conversation over rather than splicing it onto the old one.
  conv.reset();
  attachedId = null;
  // No grid preference: the PTY stays exactly as the desktop has it, so the
  // program is laid out at the screen the desktop is showing and typing from
  // the phone never reflows it. Omitting cols/rows is what tells the server
  // this viewer will not claim the size.
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
  // An empty Enter is not an empty message. It accepts a default, confirms
  // a prompt, steps past a pager. Send the newline on its own and record
  // nothing - there is nothing anyone said.
  if (text.trim() === "") {
    writePty("\r");
    followToBottom();
    return;
  }
  // Whatever is on the other end — a shell, an agent, a REPL — the phone
  // sends the same thing a keyboard would: the text, then Enter.
  if (!writePty(`${text}\r`)) return;
  conv.noteSent(text);
  // The transcript will not know about this until the agent writes the turn
  // out, so the page holds it in the meantime — anchored to where the
  // transcript stood now, so only a turn recorded after this one can retire it.
  if (transcript)
    awaitingTranscript.push({ text, afterId: lastUserId(transcript) });
  inputEl.value = "";
  autoGrow();
  followToBottom();
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

$("#btn-sched").addEventListener("click", () => setSchedOpen(schedEl.hidden !== false));
$("#sched-go").addEventListener("click", () => {
  const command = inputEl.value.trim();
  if (command === "") {
    toast("先输入要执行的命令");
    inputEl.focus();
    return;
  }
  const hours = Number(schedHoursEl.value) || 0;
  const minutes = Number(schedMinsEl.value) || 0;
  const delaySeconds = hours * 3600 + minutes * 60;
  if (delaySeconds <= 0) {
    toast("请填写多久之后执行");
    return;
  }
  send({ scheduleAdd: { command, delaySeconds } });
  // Cleared the way sending clears it: the command has left the composer, and
  // leaving it there invites sending it twice.
  inputEl.value = "";
  autoGrow();
  toast(`已排队：${untilText(delaySeconds * 1000)}`);
});

toBottomEl.addEventListener("click", followToBottom);
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
    } else if (seq === "shift-tab") {
      // CSI Z, "cursor backward tabulation". Both agents use it to cycle
      // modes, which a phone cannot reach any other way.
      writePty("\x1b[Z");
    }
  });
}

// Keep the session list fresh: the desktop opens and closes terminals
// without the phone being told.
window.setInterval(() => send({ list: true }), 5000);

// ── Boot ─────────────────────────────────────────────────────────────────
connect();
