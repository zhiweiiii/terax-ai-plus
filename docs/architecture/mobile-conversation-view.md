# Mobile conversation view

The phone does not render a terminal. It renders a **conversation**: what you
sent, and what came back, as bubbles that wrap at the phone's width.

Source of truth: `src/web/conversation.ts` (the parse), `src/web/main.ts`
(shell, WebSocket, rendering), `src/web/style.css`. The transport underneath is
unchanged — see [Web terminal bridge](web-terminal-bridge.md).

## Why not a terminal

The page used to be an xterm.js terminal rendering at exactly the PTY grid.
That grid is the desktop's, commonly 138–192 columns, and a phone viewport is
around 335 CSS px. Measured on a real session (192×28 PTY, 335×590 viewport):

| | value |
|---|---|
| rendered grid | 1408 × 653 px |
| scale to fit width | 0.238 |
| effective font size | 14 × 0.238 ≈ **3.3 px** |
| screen height used | 155 / 590 ≈ **26 %** |

Three properties were wanted at once: a readable font, no horizontal panning,
and a byte stream that still parses correctly. A terminal view can have any two.
Scaling to fit gives an unreadable font; not scaling forces panning; re-wrapping
to the phone width breaks `\r` redraws and absolute cursor moves.

A conversation view escapes the trilemma because it never displays a grid. The
grid becomes an internal parsing detail, and the text that comes out of it
carries no column count, so it can be re-wrapped at any width at a normal size.

## The parser is a headless xterm

`Conversation` owns a `Terminal` that is **never `open()`ed**. Without a DOM
element xterm skips its renderer entirely and only maintains the buffer — which
is exactly what is read back out.

It is sized to the PTY's real grid (`setGrid`, driven by the server's `attached`
and `resized` messages), because that is the only width at which the stream's
wrapping and cursor moves come out right. That size never reaches the screen.

Using xterm rather than a hand-rolled ANSI parser is deliberate: it is the only
thing in the codebase that already gets wrapping, `\r` in-place redraws,
absolute cursor addressing and the alternate screen right.

## Two sources, one thread

### Normal buffer — a shell

Lines scroll past the cursor. Everything above the cursor row is settled and is
collected; the cursor's own row is left alone because it may be a half-written
prompt or progress line. A row xterm marks `isWrapped` is a continuation broken
at the PTY's column count, not by the program, so it is joined back onto the row
above — that is what makes re-wrapping at phone width correct rather than
double-wrapped.

### Alternate screen — a full-screen program

`claude`, `opencode`, `vim`, `htop`. Nothing scrolls past a cursor: one screen
is repainted in place. So successive frames are compared to work out **how far
the screen scrolled** (`detectScroll`), and the rows that fell off the top are
collected the same way as shell output. Rows still on screen are parsed into
blocks and rendered below the history, so between them they cover the
conversation exactly once, with no line shown twice.

`detectScroll` takes the smallest shift `k` at which ≥ 70 % of the old frame
lines up with the new one, requiring at least 3 matching non-blank rows so that
mostly-blank screens do not match at every shift. A program with a pinned footer
still matches, because the scrolling region is the bulk of the screen and a few
unmatched footer rows cannot outvote it.

This is deliberately generic: it knows nothing about any particular program's
layout, so it does not break when one changes its box drawing.

## Reading a screen as bubbles

`toBlocks` turns screen rows into blocks. It relies only on things true of every
full-screen TUI: the frame is drawn with box characters and is not content,
blank rows separate one thing from the next, and `>` / `❯` introduce something
the user said.

- **Frame stripping** (`stripChrome`) removes box drawing, block elements,
  geometric shapes and braille. `⏺` / `●` are deliberately *not* in that set:
  they carry meaning and are kept as bullets.
- **Footer** (`splitFooter`) walks up from the last row while rows still look
  like furniture — blank, key hints (`esc`, `ctrl+…`), opening with a rule, or
  ≥ 30 % frame characters — and stops at the first row that reads as content.
  What it drops becomes the status label, never a bubble. A rule is a *run* of
  frame characters (`╹▀▀▀▀…`); a single gutter marker (`┃`, `▣`) is decoration
  on a line that may be content, so it is not a rule. Status readouts — the
  model line (`Build · <model>`, already in `WIDGET`), a bare filesystem path
  (an input box's working directory) — are furniture, so the input box stays a
  status label instead of gluing its prompt onto the message above it. Without
  the run rule, opencode renders every user message under a `┃` gutter and the
  footer walk ate them all, hiding what the user last said as status.
- **User markers**: `>` / `❯`, except when they point at a numbered choice
  (`❯ 1. 上班`), which is the program offering options, not the user speaking.

### Echo matching is the reliable part

Marker heuristics are weak — opencode does not prefix user messages at all. But
the page knows exactly what it sent, so `markEchoes` re-labels any row matching
a recent send as the user's, whatever the program drew around it. A short
message must match exactly (looking for `1` as a substring would hit a token
count or a timing); anything ≥ 10 characters may match loosely, since these
tools wrap and decorate what you typed.

The middle band is the trap. A 4–9 character send (`claude`, `cd x`) can appear
inside the tool's own UI — a cwd path `…\opencode\claude-fresh`, `Run claude
doctor`, the model line `Opus 5 claude-fresh …`. A loose `includes` then marks
all of those as the user's messages. The rule is therefore length-tiered:
≥ 10 characters match as a substring; 4–9 must be essentially the whole row
(`painted.length ≤ sent.length + 12`); shorter matches are exact. That is what
keeps a real echo of `claude` a bubble while Claude Code's own chrome stays
output.

This is what makes the `1` / `2` / `3` test case come out as bubbles on the
right instead of being mistaken for output.

These tools also print a generated one-line title directly above the message it
summarises (`Minimal message '1'`). It is dropped on **position** — a one-row
non-user run immediately preceding a user echo inside the same block — rather
than on wording, which every tool phrases differently and changes over time.

## The tool-specific layer

One list, `WIDGET` in `conversation.ts`, and `detectProgram`. Everything else is
generic.

- The footer is split out by **position, not by text** (`splitFooter`): the
  status rule both tools draw above their status area is the anchor — the
  footer is everything from the last rule in the bottom `FOOTER_WINDOW` rows
  down. Walking up by "does this line look like furniture" alone breaks when
  Claude's subagent tab (`  ◯ Explore Search repo for README content  0s`)
  does not read as furniture, which leaks the whole status area into the
  conversation as output. A rule higher than the window is a dialog border or
  a divider, not a status rule.
- The footer's **bottom row is the tab strip** (Claude Code's running
  subagents). It is pulled out by position and exposed as `Conversation.agents`
  — rendered as an independent chip strip above the composer, never as a
  bubble. Only the draft input box (a bare path, or key hints) is excluded.
  No agent name or task text is ever matched; the same code works however
  Claude renames its agents.
- `WIDGET` drops readouts these tools scatter *around* the screen rather than
  pinning to the bottom, so the footer walk never reaches them: `+ Thought: …`,
  `Context`, `15,981 tokens`, `$0.00 spent`, `LSPs are disabled`,
  `Title generation request`, opencode's `Build · <model>` line, Claude Code's
  `Opus <n> …` model line, and the `Auto-update failed` npm-prefix warning. An
  unmatched widget degrades into a small stray bubble; it does not break the
  parse.
- `detectProgram` recognises OpenCode and Claude Code to label the moment one
  starts (`OpenCode 已启动` / `Claude Code 已启动`). Attaching mid-session means
  the splash is long gone, so the note starts generic and its name is filled in
  from a later frame. `opencode` is also a folder name in a cwd path (and
  Claude's footer shows the working directory), so the OpenCode test requires a
  bare word — the logo, the save screen, the `OpenCode Go` footer — not a bare
  substring. Claude Code is matched first (`claude code`, `welcome back`,
  `Opus <n>`), so a session running in `…\opencode\…` still names itself.
- A splash screen is suppressed rather than bubbled (`isBanner`): judged on how
  much text is on screen (< 120 letters), not on the ratio of drawing to text —
  a ratio flips either side of its threshold as soon as one long divider rule is
  drawn, which made the same screen appear and disappear. Suppression applies
  only to the program's **first frame**: an exit / save prompt drawn later under
  the same ASCII banner ("Session 项目介绍 / Continue opencode -s …") is an
  interaction the reader must see, not a logo to hide.

## Ordering

Three containers, rendered in this order, all styled identically so the reader
sees one column:

1. `#turns` — settled history, appended once and left alone.
2. `#live-blocks` — the part of the conversation still on a full-screen
   program's screen, rebuilt whenever it repaints.
3. `#pending` — sent, not yet painted by the program. Dimmed until confirmed.

`#pending` exists for ordering, not decoration. Under a shell, a sent message
goes straight into history and the output that follows lands after it. Under a
full-screen program the newest thing on screen is the program's own repaint, so
a bubble pushed into history would render **above** content older than it. It
waits in `pending` instead and is dropped as soon as the program paints the
prompt itself. Leaving the alternate screen folds anything still pending back
into history, in order.

## Backlog on attach

The server replays the session's rolling output history (`WEB_HISTORY_CAP`,
256 KiB) immediately after `attached`. That is how a freshly connected phone
picks up what the desktop's command line already had.

It is fed in through `writeBacklog`, in slices of about two grid rows (up to
2 KiB) with a read between each. Writing it in one go would be useless for a
full-screen program: every frame it ever painted would be applied to the
buffer in sequence and only the last would be read, collapsing the whole
conversation into the current screen. Slicing replays the frames, and the same
scroll detection that follows a live session reconstructs the history from
them. Slicing is safe at any byte — xterm carries a partial escape sequence
over to the next write.

The slice size is the trap that used to break this. `detectScroll` needs two
consecutive reads to share most rows; if one slice scrolls more than about a
third of the screen, the content below the fold is entirely new and no shift
matches. The original fixed 2048 bytes was ~15 full lines of a 138-column
grid, so a session that scrolled (a long conversation, a big diff) lost its
whole history on attach: replayed on a real 81 KiB OpenCode backlog it
produced 38 frames and 0 scrolls. The slice is now `max(64, min(2048,
cols * 2))` — about two grid rows per slice — which keeps consecutive reads
well above the 70 % overlap threshold at any PTY size. The same replay now
detects 27/28 scrolls and reconstructs the full transcript.

## Input

The composer sends text plus `\r` to the attached PTY, whatever is on the other
end — a shell, an agent, a REPL. The key row supplies Ctrl+C / Ctrl+D / Esc /
Tab / arrows / Enter, which soft keyboards do not have.

The phone renders no grid, so it has no width of its own to impose, but it does
not sit passively at the desktop's size: a session has one grid and whoever is
typing owns it (see the shared-PTY note in `TERAX.md`). Attaching states the
phone's preferred grid; watching never moves the PTY, but the **first keystroke
claims the session** and the server applies that grid, then repaints the TUI.
The parser follows whatever grid the owner is using, via the `resized` message.

Leaving the alternate screen folds the program's final screen into the history
through the same parse as any frame — furniture stripped, echoes marked — rather
than appending it raw, which used to leak the input box, the status line and
echoed messages into the output as anonymous AI.

### Permission dialogs and numbered choices

A bottom-docked permission / option dialog (Claude's "Do you want to proceed? /
`1. Yes` / `2. Yes, and don't ask again for …` / `3. No`) renders as ordinary
output blocks — the numbered menu is visible and the `1`/`2`/`3` keys work.
The footer split never touches it: a dialog box border is a rule above the
`FOOTER_WINDOW`, so it is content, not a status rule. Verified live against a
real Claude Code Bash-permission prompt for a subagent.

## Test tooling

Three scripts exercise the parser and the real page against a live dev
instance (no password needed — the auth cookie is decoded from the same
XOR-obfuscated constant the Rust side embeds):

- `scripts/web-capture.mjs` — drive the WebSocket: `list`, or `drive <leaf>
  <scenario.json> <out.jsonl> <timeout>` that attaches (with `opening` retry
  for cold leaves), types scenario steps, and records every text message and
  output frame (with timestamps and the user's sends) to a JSONL.
- `scripts/web-replay.mjs` — replay a capture through the exact `Conversation`
  the page uses (bundled by `scripts/convo-test.config.mjs`), driving
  setGrid/setAltScreen/writeBacklog like `main.ts`. `--trace` prints live
  blocks as they change; useful for watching a transient permission menu.
- `scripts/web-synthetic-test.mjs` — feed constructed alt-screen frames (claude
  permission dialogs, `1/2/3` option lists, an exit prompt, a startup splash)
  through the parser and assert they render the way they should. This is the
  regression net for the menu/banner/echo rules.
- `scripts/e2e-phone.mjs` — Playwright against the real page: cookie auth,
  session list (items carry `data-leaf`), attach, and either TUI bubbles or a
  sent-message round trip.

The real sessions were captured by driving the actual `opencode` and `claude`
CLIs through the bridge, then replayed to check every case the parser must
survive: continuous multi-turn conversation, tool calls, the exit / session-
save prompt, Claude Code's trust dialog, permission approval by number, long
backlogs, and shared desktop+phone use at the same time.

## Bounds

- Parser scrollback 5000 rows; the parser is recycled (`term.clear()`) once
  4000 rows have scrolled off. Past that point xterm starts trimming and every
  buffer index shifts, which would silently strand the read cursor. Rows already
  emitted live in `turns`, so recycling costs nothing.
- Retained transcript capped at 4000 rows (`MAX_LINES`), oldest turns dropped.
- Output is coalesced on a 60 ms timer; a block closes after 700 ms of quiet so
  the next thing sent starts its own.
- Rendering is queued on `requestAnimationFrame`, falling back to a timer when
  `document.hidden` — rAF never fires in a background tab, and phones background
  one the moment the screen locks.

## Diagnostics

`window.conv` is the live `Conversation`. `conv.stats` counts alternate-screen
frames and how many were recognised as scrolls; frames climbing while `scrolls`
stays at 0 means the screen is being repainted in a way `detectScroll` does not
recognise, and history is being lost. That counter is what caught the
trailing-whitespace bug (158 frames, 0 scrolls).

## Verified and not

Verified against real sessions: opencode continuous conversation (user bubbles,
tool calls, replies, exit / save prompt that survives the splash filter);
Claude Code startup detection, welcome screen, trust dialog (`❯ 1. Yes, I
trust this folder / 2. No, exit`), permission approval by number, and
continuous multi-turn conversation; shell send/receive with echo stripping;
startup notes for both tools; backlog reconstruction across a page reload
(shell session); backlog reconstruction for an alternate-screen session — a
synthetic session that scrolls 120 lines now recovers the full transcript as
history, and a real 81 KiB OpenCode backlog replayed through `Conversation`
reconstructs the shell portion that preceded the agent and keeps the user's
last message as a bubble instead of folding it into the status label; the
grid-ownership handshake (the first keystroke moves the grid, and xterm's
protocol answers — focus reports, OSC 4 palette replies — no longer steal it
back); and a desktop user typing in the same session while the phone watched,
with both ends staying coherent. End-to-end Playwright passes against the real
page for both a shell session and a live opencode TUI.

Not verified: a real Claude Code *permission dialog* rendering live on the
phone — this machine's Claude is configured `permissions.defaultMode: "auto"`,
so it never asks. The approval flow works, and the rendering path for a
bottom-docked numbered menu is covered by the synthetic tests instead.
— **updated (2026-08-19)**: running Claude with a workspace `defaultMode:
"default"` settings file does make it ask, and the real Bash-permission prompt
for a subagent (with the `1. Yes / 2. Yes, and don't ask again / 3. No` menu)
was captured end to end on the phone page — the menu renders as visible blocks
and `1` approves. Also verified live: Claude Code's running subagent tab
(`Explore 查找 README 相关内容  0s`) is extracted by position into the
independent `#agents` chip strip above the composer.

Known gap: backlog restored on attach arrives as one output block and is **not**
split into user/assistant bubbles. The page has no record of what was sent
before it connected, so `markEchoes` has nothing to match against.
