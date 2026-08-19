// Synthetic-screen regression test for the Conversation parser: feeds
// constructed alt-screen frames (claude permission menus, option lists,
// opencode selectors) through the same parser the phone uses and asserts the
// menu lines survive as visible content instead of being swallowed.
//
//   node scripts/web-synthetic-test.mjs

import assert from "node:assert";

globalThis.window = globalThis;
const { Conversation } = await import("./convo-bundle/conversation.mjs");

const COLS = 120;
const ROWS = 40;

function screenFrame(rows) {
  // Full repaint of the alt buffer: cursor home, clear, draw rows, cursor back.
  let out = "\x1b[?1049h\x1b[2J\x1b[H";
  for (const row of rows) {
    out += row.padEnd(COLS);
    out += "\r\n";
  }
  out += "\x1b[" + ROWS + ";1H";
  return out;
}

function wait(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function blank() {
  return Array.from({ length: ROWS }, () => " ".repeat(COLS));
}

async function parseScreen(rows, { grid = { cols: COLS, rows: ROWS } } = {}) {
  const conv = new Conversation(() => {});
  conv.setGrid(grid.cols, grid.rows);
  await conv.writeBacklog(new TextEncoder().encode(screenFrame(rows)));
  await wait(900);
  return conv;
}

function linesOf(conv) {
  return conv.liveBlocks.map((b) => `${b.role}|${b.lines.join(" ")}`).join("\n");
}

let failures = 0;
function check(name, cond, detail) {
  if (cond) {
    console.log(`ok - ${name}`);
  } else {
    failures++;
    console.log(`FAIL - ${name}\n${detail ?? ""}`);
  }
}

// ---- claude permission dialog (renders in the input area) ----
{
  const rows = blank();
  rows[5] = "  ┌──────────────────────────────────────────────────────────┐";
  rows[6] = "  │ Claude Code                                                │";
  rows[7] = "  └──────────────────────────────────────────────────────────┘";
  rows[30] = "  Do you want to proceed?";
  rows[31] = "  ❯ 1. Yes";
  rows[32] = "    2. Yes, and don't ask again for this session";
  rows[33] = "    3. No";
  rows[34] = "  (up/down to navigate, enter to select)";
  const conv = await parseScreen(rows);
  const all = conv.liveBlocks.map((b) => b.lines.join(" ")).join("\n");
  const keys = conv.choices.map((c) => c.key).join(",");
  const labels = conv.choices.map((c) => c.label).join(" | ");
  check("permission menu shows the question", all.includes("Do you want to proceed?"), all);
  check("permission menu offers 3 choices", keys === "1,2,3", keys);
  check("permission menu marks the selected row", conv.choices[0]?.selected === true, labels);
  check("permission menu keeps option labels", labels.includes("Yes, and don't ask again"), labels);
  // The options are buttons now, so they must NOT also be bubbles.
  check("permission options are not bubbles too", !all.includes("3. No"), all);
}

// ---- claude option selector with a numbered list ----
{
  const rows = blank();
  rows[8] = "  What would you like to do?";
  rows[9] = "  ❯ 1. Fix the failing test";
  rows[10] = "    2. Refactor the module";
  rows[11] = "    3. Explain the code";
  rows[12] = "    4. Nothing";
  const conv = await parseScreen(rows);
  const all = conv.liveBlocks.map((b) => b.lines.join(" ")).join("\n");
  check("option menu shows question", all.includes("What would you like to do?"), all);
  check(
    "option menu offers all four choices",
    conv.choices.map((c) => c.key).join(",") === "1,2,3,4",
    JSON.stringify(conv.choices),
  );
  check(
    "option menu keeps the last label",
    conv.choices.at(-1)?.label === "Nothing",
    JSON.stringify(conv.choices),
  );
}

// ---- opencode "how should I proceed" selector ----
{
  const rows = blank();
  rows[20] = "  How should I proceed?";
  rows[21] = "  ❯ 1. Run the command";
  rows[22] = "    2. Explain first";
  const conv = await parseScreen(rows);
  const all = conv.liveBlocks.map((b) => b.lines.join(" ")).join("\n");
  check("opencode selector shows the question", all.includes("How should I proceed?"), all);
  check(
    "opencode selector offers both choices",
    conv.choices.map((c) => c.label).join("|") === "Run the command|Explain first",
    JSON.stringify(conv.choices),
  );
}

// ---- a numbered list in prose is NOT a menu ----
{
  const rows = blank();
  rows[20] = "  I can see three options here:";
  rows[21] = "  1. Rewrite the parser";
  rows[22] = "  2. Patch the caller";
  rows[23] = "  3. Leave it alone";
  rows[24] = "  Let me know which you prefer.";
  const conv = await parseScreen(rows);
  const all = conv.liveBlocks.map((b) => b.lines.join(" ")).join("\n");
  check("prose list is not turned into buttons", conv.choices.length === 0, JSON.stringify(conv.choices));
  check("prose list stays in the conversation", all.includes("2. Patch the caller"), all);
}

// ---- prose list above a real menu: only the menu becomes buttons ----
{
  const rows = blank();
  rows[18] = "  Options I considered:";
  rows[19] = "  1. Rewrite it";
  rows[20] = "  2. Patch it";
  rows[30] = "  Proceed?";
  rows[31] = "  ❯ 1. Yes";
  rows[32] = "    2. No";
  const conv = await parseScreen(rows);
  const all = conv.liveBlocks.map((b) => b.lines.join(" ")).join("\n");
  check(
    "only the bottom menu becomes buttons",
    conv.choices.map((c) => c.label).join("|") === "Yes|No",
    JSON.stringify(conv.choices),
  );
  check("prose list above it survives", all.includes("1. Rewrite it"), all);
}

// ---- working indicator: what it is doing, and for how long ----
{
  const rows = blank();
  rows[20] = "  ⏺ Reading the source now";
  rows[30] = "  ✻ Thinking… (12s · ↑ 1.2k tokens · esc to interrupt)";
  const conv = await parseScreen(rows);
  const all = conv.liveBlocks.map((b) => b.lines.join(" ")).join("\n");
  check("working line is read as a state", conv.thinking?.label === "Thinking", JSON.stringify(conv.thinking));
  check("working line carries elapsed seconds", conv.thinking?.seconds === 12, JSON.stringify(conv.thinking));
  check("working line is not a bubble", !all.includes("Thinking"), all);
  check("output above it survives", all.includes("Reading the source now"), all);
}

// ---- an unfamiliar verb still reads as working (Claude cycles through many) ----
{
  const rows = blank();
  rows[30] = "  ✽ Herding bytes… (1m 5s · esc to interrupt)";
  const conv = await parseScreen(rows);
  check("unknown verb still reads as working", conv.thinking?.label === "Herding bytes", JSON.stringify(conv.thinking));
  check("minutes and seconds are added up", conv.thinking?.seconds === 65, JSON.stringify(conv.thinking));
}

// ---- mode is pulled out of the footer ----
{
  const rows = blank();
  rows[30] = "  Working on it";
  rows[34] = "  ────────────────────";
  rows[35] = "  Opus 5 terax";
  rows[36] = "  auto-accept edits on · main";
  const conv = await parseScreen(rows);
  check("claude mode is extracted", conv.mode === "auto-accept edits on", JSON.stringify({ mode: conv.mode, status: conv.status }));
}

// ---- opencode puts the mode first on its model line ----
{
  const rows = blank();
  rows[30] = "  Working on it";
  rows[34] = "  ────────────────────";
  rows[35] = "  Build · claude-opus-5";
  const conv = await parseScreen(rows);
  check("opencode mode is extracted", conv.mode === "Build", JSON.stringify({ mode: conv.mode, status: conv.status }));
}

// ---- seed: a serialized desktop buffer, shell only ----
{
  // What SerializeAddon hands back for a quiet command line: settled lines,
  // then the prompt on the cursor row.
  const seed =
    "npm run build\r\n" +
    "built in 3.2s\r\n" +
    "PS D:\\work> ";
  const conv = new Conversation(() => {});
  conv.setGrid(COLS, ROWS);
  await conv.writeSeed(new TextEncoder().encode(seed));
  await wait(900);
  const text = conv.turns
    .filter((t) => t.kind === "output")
    .map((t) => t.lines.join("\n"))
    .join("\n");
  check("seed keeps the settled scrollback", text.includes("built in 3.2s"), text);
  check("seed shows the prompt the desktop is sitting on", text.includes("work>"), text);
}

// ---- seed: scrollback plus a running full-screen program ----
{
  const screen = blank();
  screen[2] = "  > summarise the readme";
  screen[4] = "  I read README.md and here is the summary.";
  screen[30] = "  ✻ Thinking… (7s · esc to interrupt)";
  screen[34] = "  ────────────────────";
  screen[35] = "  auto-accept edits on · main";
  const seed =
    "cd project\r\n" +
    "PS D:\\work> claude\r\n" +
    screenFrame(screen);
  const conv = new Conversation(() => {});
  conv.setGrid(COLS, ROWS);
  await conv.writeSeed(new TextEncoder().encode(seed));
  await wait(900);
  const history = conv.turns
    .filter((t) => t.kind === "output")
    .map((t) => t.lines.join("\n"))
    .join("\n");
  const live = conv.liveBlocks.map((b) => `${b.role}|${b.lines.join(" ")}`).join("\n");
  check("seed keeps the shell scrollback above the program", history.includes("cd project"), history);
  check("seed renders the program screen", live.includes("here is the summary"), live);
  check("seed reads the user message on that screen", live.includes("user|summarise the readme"), live);
  check("seed picks up the working state", conv.thinking?.seconds === 7, JSON.stringify(conv.thinking));
  check("seed picks up the mode", conv.mode === "auto-accept edits on", String(conv.mode));
}

// ---- claude's real permission dialog: a diff, ruled off, above the menu ----
{
  // Captured from a live Claude Code session (Write approval). The dashed
  // rules around the diff are the trap: the footer walk used to anchor on the
  // lower one and swallow the whole prompt.
  const rows = blank();
  rows[25] = "❯ 创建一个 hello.txt 文件";
  rows[27] = "● Write(hello.txt)";
  rows[29] = "─".repeat(100);
  rows[30] = " Create file";
  rows[31] = " hello.txt";
  rows[32] = "╌".repeat(100);
  rows[33] = "  1 hi";
  rows[34] = "╌".repeat(100);
  rows[35] = " Do you want to create hello.txt?";
  rows[36] = " ❯ 1. Yes";
  rows[37] = "   2. Yes, and switch to accept edits for this session (shift+tab)";
  rows[38] = "   3. No";
  rows[40] = " Esc to cancel · Tab to amend";
  const conv = await parseScreen(rows);
  const keys = conv.choices.map((c) => c.key).join(",");
  const all = conv.liveBlocks.map((b) => b.lines.join(" ")).join("\n");
  check("permission dialog under a diff offers 3 choices", keys === "1,2,3", keys);
  check(
    "the selected option is the first",
    conv.choices[0]?.selected === true && conv.choices[0]?.label === "Yes",
    JSON.stringify(conv.choices),
  );
  check(
    "the long option keeps its label",
    (conv.choices[1]?.label ?? "").includes("accept edits"),
    JSON.stringify(conv.choices),
  );
  check("the question is still shown", all.includes("Do you want to create hello.txt?"), all);
  check("the options are not bubbles too", !all.includes("3. No"), all);
  // Under an agent transcript only this part of the screen is rendered, so it
  // has to carry the question AND what the question is about.
  const prompt = conv.promptBlocks.map((b) => b.lines.join(" ")).join("\n");
  check("the prompt context carries the question", prompt.includes("Do you want to create hello.txt?"), prompt);
  check("the prompt context carries the diff", prompt.includes("hi"), prompt);
  check("the prompt context stops at the dialog", !prompt.includes("Welcome back"), prompt);
}

// ---- a menu must NOT be mistaken for a startup splash ----
{
  // Sparse screen (few letters + a box) drawn LATER (second frame): this is
  // the exit/save prompt case, not the logo.
  const rows = blank();
  rows[10] = "  █▀▀▀█ █▀▀▀█ █▀▀▀█";
  rows[11] = "  ▀▀▀▀▀ ▀▀▀▀▀ ▀▀▀▀▀";
  rows[34] = "  Session  Quick hello";
  rows[35] = "  Continue  opencode -s ses_abc";
  const conv = await parseScreen(rows);
  const all = conv.liveBlocks.map((b) => b.lines.join(" ")).join("\n");
  check("exit prompt survives banner check", all.includes("Continue") && all.includes("Session"), all);
}

// ---- a startup splash (first frame) IS suppressed ----
{
  // Live startup paints the splash through write(), one frame at a time; the
  // backlog path (writeBacklog) is for attaching mid-session, where the first
  // frame is already real conversation.
  const rows = blank();
  rows[12] = "  █▀▀▀█ █▀▀▀█ █▀▀▀█";
  rows[13] = "  ▀▀▀▀▀ ▀▀▀▀▀ ▀▀▀▀▀";
  rows[30] = "  version 0.1.0";
  const conv = new Conversation(() => {});
  conv.setGrid(COLS, ROWS);
  conv.write(new TextEncoder().encode(screenFrame(rows)));
  await wait(900);
  const all = conv.liveBlocks.map((b) => b.lines.join(" ")).join("\n");
  check("startup splash suppressed", conv.liveBlocks.length === 0, all);
  check("startup splash leaves a note", conv.turns.some((t) => t.kind === "note"), JSON.stringify(conv.turns));
}

// ---- position-based footer: running agent tab becomes a chip ----
{
  const rows = blank();
  rows[30] = "  Do you want to proceed?";
  rows[31] = "  ◯ 1. Yes";
  rows[32] = "    2. Yes, and don't ask again";
  rows[33] = "    3. No";
  rows[34] = "  ─────────────────────────────────────────────────────────────";
  rows[35] = "  Opus 5 oc-scratch  强度:high  5h已用 8%";
  rows[36] = "  ◯ manual mode on · ◯ 3 agents";
  rows[37] = "  main";
  rows[38] = "  ◯ Explore  Search repo for README content  0s";
  const conv = await parseScreen(rows);
  const chips = conv.agents.join(" | ");
  check("running agent extracted as a chip", chips.includes("Explore"), chips);
  check("mode line stays out of the bubbles",
    !conv.liveBlocks.some((b) => b.lines.join(" ").includes("manual mode")),
    JSON.stringify(conv.liveBlocks));
  check("status keeps the mode + branch",
    conv.status?.includes("manual mode") && conv.status?.includes("main"),
    conv.status ?? "");
}

// ---- the input box at the bottom is NOT an agent chip ----
{
  const rows = blank();
  rows[30] = "  Ask anything...";
  rows[31] = "  ╹▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀";
  rows[32] = "  ~\\AppData\\Local\\Temp\\opencode\\oc-scratch:master  1.18.18  ctrl+p commands";
  const conv = await parseScreen(rows);
  check("opencode input box is not an agent chip", conv.agents.length === 0, conv.agents.join(" | "));
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
