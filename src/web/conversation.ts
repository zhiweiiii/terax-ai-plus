import { Terminal } from "@xterm/xterm";

// Turns the shared PTY's byte stream into a conversation.
//
// The phone does NOT render a terminal grid. Rendering the desktop's grid
// (commonly 138-192 columns) inside ~335 CSS px forces either a 3px font or
// horizontal panning, and both are unreadable. So the grid is never shown:
// a headless xterm parses the stream (it is the only thing that gets ANSI
// right — wrapping, \r redraws, absolute cursor moves, alt screen), and this
// module reads *logical lines* back out of its buffer. Those lines carry no
// column count of their own, so the page re-wraps them at whatever width the
// phone actually has, at a normal font size.
//
// Two cases, one output:
//
//   Normal buffer — a shell. Lines scroll past the cursor and are collected
//   as they settle.
//
//   Alternate screen — a full-screen program (claude, opencode, vim, htop).
//   Nothing scrolls past a cursor: one screen is repainted in place. The
//   content still moves upward though, so successive frames are compared to
//   work out how far the screen scrolled, and the lines that fell off the top
//   are collected the same way. That is deliberately generic — it knows
//   nothing about any particular program's layout, so it does not break when
//   one changes its box drawing.

export type Turn =
  | { kind: "sent"; id: number; at: number; text: string }
  | { kind: "output"; id: number; at: number; lines: string[]; open: boolean }
  | { kind: "note"; id: number; at: number; text: string };

/** Scrollback held by the headless parser before it is recycled. */
const PARSER_SCROLLBACK = 5000;
/** Recycle the parser once this many lines have scrolled off. Keeps the
 *  buffer indices we track small and, more importantly, correct: xterm shifts
 *  every index down once trimming starts, which would silently strand our
 *  read cursor. Emitted lines already live in `turns`, so recycling is free. */
const RECYCLE_AT = 4000;
/** Hard cap on retained output lines, so a long session cannot grow the DOM
 *  (and the phone's memory) without bound. */
const MAX_LINES = 4000;
/** Coalesce window. Output arrives in many small chunks while a command runs;
 *  flushing per chunk would emit half-written lines and thrash the DOM. */
const FLUSH_MS = 60;
/** A gap this long without output ends the current output block, so the next
 *  thing you send starts a new one. */
const TURN_IDLE_MS = 700;
/** How many recent sends are remembered for de-duplication (a TUI paints your
 *  prompt on screen, and it must not come back as output). */
const RECENT_SENDS = 12;
/** Bytes per slice when replaying the attach backlog, ~two grid rows.
 *  detectScroll needs consecutive reads to share most rows: the old fixed
 *  2048 bytes was ~15 lines of a 138-col grid, so a scrolling session lost its
 *  whole history on attach (docs/issues.md #57). */
const BACKLOG_SLICE = (cols: number) => Math.max(64, Math.min(2048, cols * 2));

export class Conversation {
  private term: Terminal;
  private readonly onChange: () => void;
  /** Absolute buffer index of the first line not yet emitted. */
  private readUpTo = 0;
  private flushTimer: number | null = null;
  private idleTimer: number | null = null;
  private nextId = 1;
  private inAlt = false;
  /** Previous alt-screen frame, for scroll detection. */
  private prevScreen: string[] = [];
  /** Text we just sent, still waiting to be recognised in the shell's echo. */
  private pendingEcho: string | null = null;
  /** Recently sent text, so a TUI repainting it is not shown twice. */
  private recentSends: string[] = [];
  /** Id of the "started" note, while its program is still unidentified. */
  private startNoteId: number | null = null;
  /** Whether the current alt-screen frame is the program's very first one.
   *  A splash can only be the first thing a program draws; any later screen
   *  that also looks sparse (an exit / save prompt with a big ASCII banner)
   *  is an interaction the user must see, not a logo to suppress. */
  private firstFrame = true;

  turns: Turn[] = [];
  /** The alt screen as it stands right now. History lives in `turns`; this is
   *  only what is still on screen, so the two never overlap. */
  liveScreen: string[] | null = null;
  /** The same screen, read as conversation blocks. This is what is shown; the
   *  raw lines above stay available for when the parse looks wrong. */
  liveBlocks: Block[] = [];
  /** Sent while a full-screen program is running, not yet painted by it.
   *  Rendered after the live screen so the order stays honest. */
  pending: string[] = [];
  /** The program's own status furniture (model, usage, key hints), condensed
   *  to one line. Shown as a label, never as a bubble — it is not something
   *  anyone said. */
  status: string | null = null;
  /** The tab strip pinned to the bottom of the screen — Claude Code's running
   *  subagents ("◯ Explore Search repo for README content 0s"). Identified by
   *  position (the footer's bottom row, and not an input box), never by the
   *  agent's name or task, and kept separate from the bubbles so agent
   *  activity reads as a status chip rather than as conversation. */
  agents: string[] = [];
  /** Diagnostics: how many alt-screen frames were seen, and how many of them
   *  were recognised as a scroll. A frame count that climbs while `scrolls`
   *  stays at 0 means the screen is being repainted in a way detectScroll does
   *  not recognise, and history is being lost. */
  stats = { frames: 0, scrolls: 0 };

  constructor(onChange: () => void) {
    this.onChange = onChange;
    this.term = this.makeTerm(80, 24);
  }

  private makeTerm(cols: number, rows: number): Terminal {
    // No `open()` call: this terminal is a parser, never a view. Without a
    // DOM element xterm skips its renderer entirely and only maintains the
    // buffer, which is exactly what we read.
    return new Terminal({
      cols,
      rows,
      scrollback: PARSER_SCROLLBACK,
      allowProposedApi: true,
    });
  }

  /** Parse at the PTY's real grid: the byte stream is laid out against it, so
   *  this is the only width at which wrapping and cursor moves come out right.
   *  It is a parsing detail and never reaches the screen. */
  setGrid(cols: number, rows: number) {
    if (cols < 2 || rows < 2) return;
    if (this.term.cols === cols && this.term.rows === rows) return;
    this.term.resize(cols, rows);
    // Frames of different widths are not comparable.
    this.prevScreen = [];
  }

  /** Put the headless parser into/out of the alternate screen to match the
   *  PTY's real mode. The server's history ring can trim the `1049h` enter
   *  sequence, so a backlog that starts mid-TUI would otherwise parse as a
   *  shell; forcing the mode up front makes the replay land in the right
   *  buffer. The mode is then kept in sync by the flushes themselves. */
  setAltScreen(inAlt: boolean) {
    if (this.inAlt === inAlt) return;
    this.term.write(inAlt ? "\x1b[?1049h" : "\x1b[?1049l");
  }

  write(bytes: Uint8Array) {
    this.term.write(bytes);
    this.scheduleFlush();
  }

  /** Take in the backlog the server replays when a phone attaches — what was
   *  already on the desktop's command line before anyone connected.
   *
   *  It arrives as one block of bytes, and writing it in one go would be
   *  useless for a full-screen program: every frame it ever painted would be
   *  applied to the buffer in sequence and only the last one would ever be
   *  read, so the whole conversation would collapse into the current screen.
   *  Feeding it in slices and reading between them replays the frames instead,
   *  and the same scroll detection that follows a live session reconstructs
   *  the history from them.
   *
   *  Slicing is safe at any byte: xterm carries a partial escape sequence over
   *  to the next write. */
  async writeBacklog(bytes: Uint8Array) {
    const sliceSize = BACKLOG_SLICE(this.term.cols);
    for (let at = 0; at < bytes.length; at += sliceSize) {
      const slice = bytes.subarray(at, at + sliceSize);
      await new Promise<void>((done) => this.term.write(slice, () => done()));
      this.flush();
    }
  }

  /** Record what the user just sent.
   *
   *  Where it goes depends on what is running. Under a shell it is history:
   *  the output that follows will be appended after it, in order. Under a
   *  full-screen program the newest thing on screen is the program's own
   *  repaint, so a bubble pushed into history would land ABOVE content that is
   *  older than it. It waits in `pending` instead — rendered after the live
   *  screen, and dropped as soon as the program paints the prompt itself. */
  noteSent(text: string) {
    const trimmed = text.trim();
    this.recentSends.push(trimmed);
    if (this.recentSends.length > RECENT_SENDS) this.recentSends.shift();

    if (this.inAlt) {
      this.pending.push(trimmed);
      this.onChange();
      return;
    }
    this.closeOutput();
    this.pendingEcho = trimmed;
    this.turns.push({ kind: "sent", id: this.nextId++, at: Date.now(), text });
    this.trim();
    this.onChange();
  }

  note(text: string) {
    this.turns.push({ kind: "note", id: this.nextId++, at: Date.now(), text });
    this.trim();
    this.onChange();
  }

  /** Start over — a new session, or a reconnect that replays history. */
  reset() {
    const { cols, rows } = this.term;
    this.term.dispose();
    this.term = this.makeTerm(cols || 80, rows || 24);
    this.readUpTo = 0;
    this.inAlt = false;
    this.prevScreen = [];
    this.liveScreen = null;
    this.liveBlocks = [];
    this.pending = [];
    this.status = null;
    this.agents = [];
    this.pendingEcho = null;
    this.recentSends = [];
    this.startNoteId = null;
    this.firstFrame = true;
    this.turns = [];
    this.onChange();
  }

  private scheduleFlush() {
    if (this.flushTimer !== null) return;
    this.flushTimer = window.setTimeout(() => {
      this.flushTimer = null;
      this.flush();
    }, FLUSH_MS);
  }

  private flush() {
    const buf = this.term.buffer.active;
    if (buf.type === "alternate") {
      this.flushAlt();
    } else {
      this.flushNormal();
    }
    this.armIdle();
    this.onChange();
  }

  // ── Alternate screen ───────────────────────────────────────────────────

  private flushAlt() {
    const buf = this.term.buffer.active;
    const cur: string[] = [];
    for (let y = 0; y < this.term.rows; y++) {
      // Trim the right edge ourselves. xterm's own trimRight leaves padding on
      // cells that carry attributes, and a TUI pads to the full width with
      // styled blanks — so the same line comes back with different trailing
      // whitespace from frame to frame. That made every line compare unequal
      // and detectScroll never fired, silently losing the history.
      cur.push(
        (buf.getLine(buf.viewportY + y)?.translateToString(true) ?? "").replace(
          /\s+$/,
          "",
        ),
      );
    }

    if (!this.inAlt) {
      // First frame of this program. Nothing has scrolled off yet, so there
      // is no history to collect — only a screen to show.
      this.inAlt = true;
      this.closeOutput();
      // Attaching mid-session means the splash is long gone, so the program
      // often cannot be named from this first frame. Label it generically now
      // and fill the name in once a later frame gives it away.
      const program = detectProgram(cur);
      this.startNoteId = this.nextId;
      this.note(program ? `${program} 已启动` : "全屏程序已启动");
      this.prevScreen = cur;
      this.setLive(cur);
      this.firstFrame = false;
      return;
    }

    this.stats.frames++;
    const scrolled = detectScroll(this.prevScreen, cur);
    if (scrolled > 0) {
      this.stats.scrolls++;
      // Those top lines are gone from the screen for good; they are the
      // conversation's history now. They go through exactly the same parse as
      // the live screen, so a message that scrolls away stays the bubble it
      // was instead of decaying into anonymous output — and, critically, is
      // not dropped as an "echo" of something we sent.
      this.appendBlocks(
        markEchoes(toBlocks(this.prevScreen.slice(0, scrolled)), this.recentSends),
      );
    }
    this.prevScreen = cur;
    this.setLive(cur);
  }

  private setLive(screen: string[]) {
    this.liveScreen = trimTrailingBlanks(screen);
    if (this.startNoteId !== null) {
      const program = detectProgram(this.liveScreen);
      if (program) {
        const note = this.turns.find((t) => t.id === this.startNoteId);
        if (note?.kind === "note") note.text = `${program} 已启动`;
        this.startNoteId = null; // named; stop looking
      }
    }
    const { body, footer } = splitFooter(this.liveScreen);
    // The footer's bottom row is the tab strip (Claude's running subagents).
    // Pull it out by position before condensing the rest into the status
    // label, so agent activity becomes its own chip instead of a status
    // fragment — and is never mistaken for conversation.
    let strip: string | null = null;
    let statusFooter = footer;
    for (let i = footer.length - 1; i >= 0; i--) {
      if (footer[i].trim() !== "") {
        strip = footer[i];
        statusFooter = footer.slice(0, i);
        break;
      }
    }
    this.agents =
      strip !== null && !isInputBox(strip) ? [stripChrome(strip).trim()] : [];
    this.status = condenseStatus(statusFooter, this.recentSends);

    // A splash screen is a logo, not conversation, and it can only be the
    // first thing a program draws. Bubbling ASCII art would fill the thread
    // with nonsense; the "started" note already says it. Later frames are
    // interactions (an exit / save prompt under an ASCII banner is still a
    // prompt), so they are never suppressed.
    const blocks = this.firstFrame && isBanner(body) ? [] : toBlocks(body);
    this.liveBlocks = markEchoes(blocks, this.recentSends);

    // Drop anything we were holding that the program has now painted itself,
    // so a sent message is not shown twice.
    if (this.pending.length > 0) {
      const said = this.liveBlocks
        .filter((b) => b.role === "user")
        .map((b) => collapse(b.lines.join(" ")));
      this.pending = this.pending.filter((p) => {
        const want = collapse(p);
        if (want === "") return false;
        return !said.some((s) => sameMessage(s, want));
      });
    }
  }

  // ── Normal buffer ──────────────────────────────────────────────────────

  private flushNormal() {
    const buf = this.term.buffer.active;
    if (this.inAlt) {
      // The program exited. Whatever was still on its screen never scrolled
      // off, so fold it into the history before moving on — through the same
      // parse as every other frame: furniture stripped, echoes marked. Raw-
      // appending the screen put the input box, the status line and the
      // program's echo of a sent message into the output as anonymous AI.
      this.inAlt = false;
      if (this.liveScreen && this.liveScreen.length) {
        const blocks = markEchoes(
          toBlocks(splitFooter(this.liveScreen).body),
          this.recentSends,
        );
        this.appendBlocks(blocks);
        // A message the program painted is already a "sent" block above; drop
        // it from pending so it does not fold in again below.
        const said = blocks
          .filter((b) => b.role === "user")
          .map((b) => collapse(b.lines.join(" ")));
        this.pending = this.pending.filter((p) => {
          const want = collapse(p);
          if (want === "") return false;
          return !said.some((s) => sameMessage(s, want));
        });
      }
      this.liveScreen = null;
      this.liveBlocks = [];
      this.status = null;
      this.agents = [];
      // Anything still unpainted goes back into the history, in order, now
      // that there is no live screen for it to sit after.
      for (const text of this.pending) {
        this.turns.push({
          kind: "sent",
          id: this.nextId++,
          at: Date.now(),
          text,
        });
      }
      this.pending = [];
      this.prevScreen = [];
      this.readUpTo = buf.baseY + buf.cursorY;
      this.closeOutput();
    }

    // Everything above the cursor is settled; the cursor's own line may still
    // be half-written (a prompt, a progress line), so it is left for later.
    const end = buf.baseY + buf.cursorY;
    if (end < this.readUpTo) {
      // The buffer was cleared or reset under us.
      this.readUpTo = end;
    }
    const fresh: string[] = [];
    for (let i = this.readUpTo; i < end; i++) {
      const line = buf.getLine(i);
      if (!line) continue;
      const text = line.translateToString(true);
      // A line xterm marks as wrapped is the continuation of the one above:
      // it was broken at the PTY's column count, not by the program. Join it
      // back so the phone can re-wrap at its own width.
      if (line.isWrapped && fresh.length > 0) {
        fresh[fresh.length - 1] += text;
      } else {
        fresh.push(text);
      }
    }
    this.readUpTo = end;

    if (fresh.length > 0) this.appendOutput(fresh);
    this.recycleIfNeeded();
  }

  // ── Shared ─────────────────────────────────────────────────────────────

  /** Move parsed blocks into the history, keeping their roles. */
  private appendBlocks(blocks: Block[]) {
    for (const block of blocks) {
      const text = block.lines.join("\n");
      if (text.trim() === "") continue;
      if (block.role === "user") {
        this.closeOutput();
        this.turns.push({
          kind: "sent",
          id: this.nextId++,
          at: Date.now(),
          text,
        });
        continue;
      }
      const last = this.turns[this.turns.length - 1];
      if (last?.kind === "output" && last.open) {
        last.lines.push(...block.lines);
        last.at = Date.now();
      } else {
        this.turns.push({
          kind: "output",
          id: this.nextId++,
          at: Date.now(),
          lines: [...block.lines],
          open: true,
        });
      }
    }
    this.trim();
  }

  private appendOutput(raw: string[]) {
    let lines = tidy(raw);

    // Drop the shell's echo of what we just sent, so the command does not
    // appear twice (once as your bubble, once at the top of the output).
    if (this.pendingEcho) {
      // Match loosely. A line editor (PSReadLine, zle) repaints the command as
      // it goes, so the echo can arrive wrapped, re-rendered, or printed twice
      // on one line, none of which equals what was typed. Collapsing runs of
      // whitespace and asking only whether the command appears somewhere in
      // the line catches all of those; everything up to and including that
      // line is the echo and goes.
      const want = collapse(this.pendingEcho);
      const at =
        want.length >= 2
          ? lines.findIndex((l) => collapse(l).includes(want))
          : -1;
      if (at !== -1) {
        lines = lines.slice(at + 1);
        this.pendingEcho = null;
      } else if (lines.length > 8) {
        // It was never echoed (a TUI reading raw keys, say). Stop looking.
        this.pendingEcho = null;
      }
    }

    // A full-screen program paints your prompt into its own transcript. That
    // line eventually scrolls off and would arrive here as "output", so drop
    // anything that is just a repaint of something we already showed as sent.
    if (this.recentSends.length > 0) {
      lines = lines.filter((l) => !this.isRepaintOfSend(l));
    }

    if (lines.length === 0) return;

    const last = this.turns[this.turns.length - 1];
    if (last?.kind === "output" && last.open) {
      last.lines.push(...lines);
      last.at = Date.now();
    } else {
      this.turns.push({
        kind: "output",
        id: this.nextId++,
        at: Date.now(),
        lines,
        open: true,
      });
    }
    this.trim();
  }

  private isRepaintOfSend(line: string): boolean {
    const bare = collapse(stripDecoration(line));
    if (bare.length < 2) return false;
    return this.recentSends.some((s) => {
      const want = collapse(s);
      return want.length >= 2 && bare === want;
    });
  }

  private closeOutput() {
    const last = this.turns[this.turns.length - 1];
    if (last?.kind === "output") last.open = false;
    if (this.idleTimer !== null) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  /** Close the current output block once the stream goes quiet, so the next
   *  command starts its own block. */
  private armIdle() {
    if (this.idleTimer !== null) clearTimeout(this.idleTimer);
    this.idleTimer = window.setTimeout(() => {
      this.idleTimer = null;
      const last = this.turns[this.turns.length - 1];
      if (last?.kind === "output" && last.open) {
        last.open = false;
        this.onChange();
      }
    }, TURN_IDLE_MS);
  }

  /** Once enough lines have scrolled off, xterm starts trimming and every
   *  buffer index shifts. Rather than track the shift, start the parser over:
   *  the lines we care about are already in `turns`. */
  private recycleIfNeeded() {
    const buf = this.term.buffer.active;
    if (buf.baseY < RECYCLE_AT) return;
    this.term.clear(); // keeps the current screen, drops the scrollback
    const after = this.term.buffer.active;
    this.readUpTo = after.baseY + after.cursorY;
  }

  /** Keep the retained transcript bounded. */
  private trim() {
    let total = 0;
    for (const t of this.turns) {
      if (t.kind === "output") total += t.lines.length;
    }
    while (total > MAX_LINES && this.turns.length > 1) {
      const dropped = this.turns.shift();
      if (dropped?.kind === "output") total -= dropped.lines.length;
    }
  }
}

/** How many lines the screen scrolled up between two frames, or 0.
 *
 *  Finds the smallest shift at which most of the old frame lines up with the
 *  new one. A program with a fixed footer (an input box, a status line) still
 *  matches, because the scrolling region is the bulk of the screen — those few
 *  unmatched footer rows do not outvote it. */
function detectScroll(prev: string[], cur: string[]): number {
  const height = Math.min(prev.length, cur.length);
  if (height < 6) return 0;
  for (let k = 1; k <= height - 4; k++) {
    let matched = 0;
    let compared = 0;
    let matchedText = 0;
    for (let i = 0; i + k < prev.length && i < cur.length; i++) {
      compared++;
      if (prev[i + k] === cur[i]) {
        matched++;
        if (prev[i + k].trim() !== "") matchedText++;
      }
    }
    if (compared < 4) break;
    // Blank screens line up at every shift, so require real text to agree.
    if (matched / compared >= 0.7 && matchedText >= 3) return k;
  }
  return 0;
}

/** Collapse blank runs and drop leading/trailing blank lines. */
function tidy(lines: string[]): string[] {
  const out: string[] = [];
  let blanks = 0;
  for (const line of lines) {
    if (line.trim() === "") {
      blanks++;
      if (blanks > 1) continue;
      out.push("");
    } else {
      blanks = 0;
      out.push(line);
    }
  }
  while (out.length && out[0] === "") out.shift();
  while (out.length && out[out.length - 1] === "") out.pop();
  return out;
}

function trimTrailingBlanks(lines: string[]): string[] {
  const out = [...lines];
  while (out.length && out[out.length - 1].trim() === "") out.pop();
  return out;
}

/** Runs of whitespace collapsed to one space, for tolerant comparison. */
function collapse(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/** Box drawing, block elements, geometric shapes, braille — the characters a
 *  TUI uses to draw its frame rather than to say anything. `⏺`/`●` markers are
 *  deliberately NOT in here: they carry meaning and are handled as bullets. */
const CHROME = /[─-╿▀-▟■-◿⠀-⣿⬀-⭟]/g;
/** The same set, anchored: a status bar or an input box opens with a rule. A
 *  rule is a RUN of frame characters (`╹▀▀▀▀…`); a single gutter marker (`┃`,
 *  `▣`) is decoration on a line that may be content, so it is not treated as
 *  a rule. Treating single markers as rules made the footer walk eat any
 *  message opencode rendered under a `┃` gutter, hiding user input as status. */
const CHROME_LEAD = /^\s*(?:[─-╿▀-▟■-◿⠀-⣿⬀-⭟]){2,}/;
/** Key hints — the giveaway that a line is a status bar, not content. */
const HINT = /\b(esc|ctrl\+|cmd\+|alt\+|tab|shift\+)\b/i;
/** A bare filesystem path is what an input box shows for the working
 *  directory, not conversation. */
const PATH_LIKE = /^\/?[A-Za-z]:[\\/]|^\/(?:[A-Za-z0-9._-]+[\\/])+/;
/** Above this share of frame characters, a line is drawing, not saying. */
const CHROME_SHARE = 0.3;
/** Prompt markers these tools put in front of what the user said. */
const USER_MARK = /^[>❯]\s?/;
/** …and the same markers pointing at a numbered choice, which is not. */
const MENU_ITEM = /^[>❯]\s*\d+[.)]\s/;

/** A line with its frame removed. */
export function stripChrome(line: string): string {
  return line.replace(CHROME, " ").replace(/\s+$/, "").replace(/^\s+/, "");
}

/** Strip the frame a TUI draws around text, so a line can be compared with
 *  what was actually typed. */
function stripDecoration(line: string): string {
  return stripChrome(line).replace(/^[>|*\-•⏺●○\s]+/, "").trim();
}

/** A block of screen content: one bubble. */
export type Block = { role: "user" | "out"; lines: string[] };

/** Status widgets these tools scatter around the screen rather than pin to the
 *  bottom, so the footer walk never reaches them: token counters, timers,
 *  section labels. They are readouts, not conversation, and each would
 *  otherwise become its own bubble.
 *
 *  This is the one place that knows about specific tools. Everything else is
 *  generic, and an unmatched widget degrades into a small stray bubble rather
 *  than breaking the parse. */
const WIDGET = [
  /^\+?\s*Thought:?\s/i, // "+ Thought: 904ms"
  /^Context$/i,
  /^[\d,.]+\s*(tokens?|k)\b/i, // "15,981 tokens"
  /^[\d.]+%\s*$/,
  /^\$[\d.]+$/,
  /^\$[\d.]+\s+spent$/i,
  /^Title generation request$/i, // opencode, while it names the thread
  /^LSPs?\b/i, // "LSP", "LSPs are disabled"
  /^Single[- ](digit|number)\s+input$/i, // opencode's generated title for "1"
  /^(Build|Plan|Chat)\s+·\s+/i, // opencode's model line
  /^Opus\s*\d/i, // claude's model line ("Opus 5 claude-fresh 强度:high …")
  /auto-update failed/i, // claude's startup warning (npm-prefix write error)
  /^\d+\s*(files?|additions?|deletions?)$/i,
];

function isWidget(text: string): boolean {
  return WIDGET.some((re) => re.test(text));
}

/** Turn raw screen lines into conversation blocks.
 *
 *  This knows nothing about any particular program. It only does what is true
 *  of every full-screen TUI: the frame is drawn with box characters and is not
 *  content, blank lines separate one thing from the next, and a `>` marker
 *  introduces something the user said. Anything it gets wrong degrades into a
 *  slightly oddly-split bubble rather than lost text, and the raw screen stays
 *  one tap away. */
export function toBlocks(body: string[]): Block[] {
  const blocks: Block[] = [];
  let cur: Block | null = null;

  for (const raw of body) {
    const text = stripChrome(raw);
    if (text.trim() === "") {
      cur = null; // blank line ends a block
      continue;
    }
    // A `>` at the start is the one near-universal "the user said this"
    // marker across these tools.
    // `>` and `❯` introduce what the user said — but the same glyph also
    // points at menu entries ("❯ 1. 上班"), which are the program offering a
    // choice, not the user speaking. Numbered items are excluded on that
    // basis. Messages we sent ourselves are recognised later and far more
    // reliably, by matching the text (see markEchoes); this marker only
    // catches prompts typed at the desktop, which we never saw go out.
    const userMark = USER_MARK.test(text) && !MENU_ITEM.test(text);
    const clean = userMark ? text.replace(USER_MARK, "") : text;
    if (clean.trim() === "") continue;
    if (!userMark && isWidget(clean.trim())) {
      cur = null; // a readout also separates what surrounds it
      continue;
    }
    const role: Block["role"] = userMark ? "user" : "out";
    if (!cur || cur.role !== role) {
      cur = { role, lines: [] };
      blocks.push(cur);
    }
    cur.lines.push(clean);
  }
  return blocks;
}

/** A status rule: a line that is essentially a run of frame characters — the
 *  divider both tools draw above their footer. A single gutter marker is
 *  decoration, not a rule. */
function isRule(raw: string): boolean {
  const nonSpace = raw.replace(/\s/g, "").length;
  if (nonSpace < 8) return false;
  const chrome = (raw.match(CHROME) || []).length;
  return chrome / nonSpace >= 0.5;
}

/** Whether a footer row is the draft input box (a bare path or key hints)
 *  rather than the tab strip. */
function isInputBox(raw: string): boolean {
  const text = stripChrome(raw);
  if (HINT.test(text)) return true;
  if (PATH_LIKE.test(text)) return true;
  // A tilde home path is also a cwd display ("~\AppData\…\oc-scratch:master").
  if (/^~\S*[\\/]/.test(text)) return true;
  return false;
}

/** Drop the status bar / input box a TUI pins to the bottom of the screen.
 *
 *  Position-based: the footer is everything from the last status rule down —
 *  the tab strip, the input box and the status readouts all live below it.
 *  Walking up by "does this line look like furniture" alone breaks when the
 *  strip row (Claude's subagent tab: "  ◯ Explore Search repo for README
 *  content  0s") does not read as furniture, which leaks the whole status
 *  area into the conversation as output.
 *
 *  A rule only anchors the footer when it sits in the bottom of the screen;
 *  a dialog border or a divider mid-screen is content, not a status rule.
 *  Claude draws a second rule above its input strip, so the anchor is the
 *  bottom-most rule in the window. */
function splitFooter(lines: string[]): { body: string[]; footer: string[] } {
  const from = Math.max(0, lines.length - FOOTER_WINDOW);
  for (let i = lines.length - 1; i >= from; i--) {
    if (isRule(lines[i])) {
      return { body: lines.slice(0, i), footer: lines.slice(i) };
    }
  }
  // No rule drawn: fall back to the furniture walk.
  let end = lines.length;
  while (end > 0 && isFurniture(lines[end - 1])) end--;
  return { body: lines.slice(0, end), footer: lines.slice(end) };
}
/** Status bars are only a few rows tall; a rule higher than this is a dialog
 *  border or a divider inside the conversation, not the footer's top edge. */
const FOOTER_WINDOW = 12;
/** A status fragment is short; anything longer than this is a sentence that
 *  leaked in from a scrambled frame, not a status readout. */
const STATUS_PIECE_MAX = 50;

/** The footer as one short label: model, usage, whatever the program pins
 *  down there. Key hints are dropped — they are for the desktop keyboard and
 *  mean nothing on a phone. */
function condenseStatus(footer: string[], typed: string[]): string | null {
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const line of footer) {
    const text = collapse(stripChrome(line));
    if (text === "" || HINT.test(text)) continue;
    // Model / usage readouts (a WIDGET) are not status either; they would
    // otherwise pad the label with "Opus 5 claude-fresh 强度:high …".
    if (isWidget(text)) continue;
    // The input box lives down here too, and what is being typed into it is
    // not status — it is a draft message.
    if (typed.some((t) => t.length >= 2 && text.includes(collapse(t)))) continue;
    // A status bar is redrawn in pieces, so the same fragment shows up on
    // several rows; keep the first of each. Columns are separated by a run of
    // spaces as often as by a bullet, so split on both.
    for (const piece of text.split(/\s+·\s+|\s{2,}/)) {
      const key = piece.trim();
      if (key === "") continue;
      // A status fragment is short ("Opus 5", "5h已用 8%", "main"); a long
      // run is a sentence that leaked in from a scrambled mid-repaint frame,
      // not something pinned to the status bar.
      if (key.length > STATUS_PIECE_MAX) continue;
      if (seen.has(key)) continue;
      seen.add(key);
      parts.push(key);
    }
  }
  if (parts.length === 0) return null;
  const text = parts.join(" · ");
  return text.length > 110 ? `${text.slice(0, 110)}…` : text;
}

/** A splash screen: a logo and a version line, and essentially nothing else.
 *
 *  Judged on how much text there is, not on the ratio of drawing to text. A
 *  ratio flips either side of its threshold as soon as one long divider rule
 *  is drawn — which is why the same screen kept appearing and disappearing —
 *  whereas "has this screen got a conversation on it yet" is a stable question:
 *  a splash has a few dozen characters of text, a conversation has hundreds. */
function isBanner(body: string[]): boolean {
  let chrome = 0;
  let letters = 0;
  for (const line of body) {
    chrome += (line.match(CHROME) || []).length;
    letters += (line.match(/[\p{L}\p{N}]/gu) || []).length;
  }
  if (letters >= BANNER_MAX_LETTERS) return false;
  return chrome > letters / 2;
}
/** Above this much text, a screen is a conversation whatever else is on it. */
const BANNER_MAX_LETTERS = 120;

/** Whether a painted line is the message we sent.
 *
 *  A short message has to match exactly: looking for "1" as a substring would
 *  hit a token count or a timing. Anything long enough to be distinctive can
 *  match loosely, since these tools wrap and decorate what you typed. */
function sameMessage(painted: string, sent: string): boolean {
  if (sent.length >= 10) return painted.includes(sent);
  if (sent.length >= 4) {
    // A short send ("claude", "cd x") can appear inside the tool's own UI: a
    // cwd path "...\opencode\claude-fresh", "Run claude doctor", a model line
    // "Opus 5 claude-fresh". Only claim the line when it is essentially the
    // message, not a mention of it.
    return painted.length <= sent.length + 12 && painted.includes(sent);
  }
  return painted === sent;
}

/** Re-label the blocks that are the program echoing back what we sent.
 *
 *  `>` is the only role marker that is at all common, and opencode does not
 *  use one — it renders your message as an ordinary line under a generated
 *  title. But we know exactly what we sent, so a line matching it is yours,
 *  whatever the program chose to draw around it. That is more reliable than
 *  any marker, and it is what makes a short message like "1" come out as a
 *  bubble on the right instead of being mistaken for output. */
function markEchoes(blocks: Block[], sent: string[]): Block[] {
  if (sent.length === 0) return blocks;
  const wants = sent.map(collapse).filter((s) => s !== "");
  const out: Block[] = [];
  for (const block of blocks) {
    if (block.role === "user") {
      out.push(block);
      continue;
    }
    const runs: Block[] = [];
    let run: Block | null = null;
    for (const line of block.lines) {
      const isMine = wants.some((w) => sameMessage(collapse(line), w));
      const role: Block["role"] = isMine ? "user" : "out";
      if (!run || run.role !== role) {
        run = { role, lines: [] };
        runs.push(run);
      }
      run.lines.push(line);
    }
    // These tools print a generated one-line title directly above the message
    // it summarises ("Minimal message '1'"). It is a label for something the
    // reader can already see, so drop it. Keyed on position rather than on
    // wording, which every tool phrases differently and changes over time.
    for (let i = runs.length - 1; i > 0; i--) {
      const before = runs[i - 1];
      if (runs[i].role === "user" && before.role === "out" && before.lines.length === 1) {
        runs.splice(i - 1, 1);
      }
    }
    out.push(...runs);
  }
  return out;
}

/** Which tool just took over the screen, if we recognise it. Used only to
 *  label the moment it started — everything after that is read generically. */
export function detectProgram(screen: string[]): string | null {
  const text = screen.join("\n");
  if (/claude code|anthropic|welcome back|opus\s*\d/i.test(text))
    return "Claude Code";
  // "opencode" is also a folder name in a cwd path (and Claude's footer shows
  // the working directory), so only a bare word - the logo, the save screen,
  // the "OpenCode Go" footer - names the program.
  if (/(?:^|[^\w\\/])opencode(?![\w\\/-])/i.test(text)) return "OpenCode";
  return null;
}

/** Whether a line is the program drawing rather than the program talking. */
function isFurniture(raw: string): boolean {
  const text = stripChrome(raw);
  if (text.trim() === "") return true;
  if (HINT.test(text)) return true;
  // Note this tests the RAW line, not the stripped one: stripChrome also trims
  // indentation, so comparing the two would call every indented line furniture
  // and swallow the whole screen.
  if (CHROME_LEAD.test(raw)) return true;
  // An input box shows the working directory; a status bar pins the model /
  // usage readouts. Both are furniture, but they must not pull a `┃`-guttered
  // message above them into the status label with them.
  if (PATH_LIKE.test(text)) return true;
  if (isWidget(text)) return true;
  const nonSpace = raw.replace(/\s/g, "").length;
  if (nonSpace === 0) return true;
  const chrome = (raw.match(CHROME) || []).length;
  return chrome / nonSpace >= CHROME_SHARE;
}
