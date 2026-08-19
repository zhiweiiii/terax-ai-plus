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
  check("permission menu shows the question", all.includes("Do you want to proceed?"), all);
  check("permission menu shows option 1", all.includes("1. Yes"), all);
  check("permission menu shows option 2", all.includes("2. Yes, and don't ask again"), all);
  check("permission menu shows option 3", all.includes("3. No"), all);
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
  check("option menu shows all four choices", all.includes("4. Nothing"), all);
}

// ---- opencode "how should I proceed" selector ----
{
  const rows = blank();
  rows[20] = "  How should I proceed?";
  rows[21] = "  ❯ 1. Run the command";
  rows[22] = "    2. Explain first";
  const conv = await parseScreen(rows);
  const all = conv.liveBlocks.map((b) => b.lines.join(" ")).join("\n");
  check("opencode selector shows both choices", all.includes("1. Run the command") && all.includes("2. Explain first"), all);
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
