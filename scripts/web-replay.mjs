// Replay a web-capture.jsonl through the same Conversation parser the phone
// page uses, and dump what the phone would have rendered.
//
//   node scripts/web-replay.mjs <capture.jsonl> [--raw] [--blocks]
//
// The capture is driven exactly like src/web/main.ts does: setGrid/setAltScreen
// on "attached", writeBacklog for the first output frame, write() for the
// rest, setGrid on "resized". Event gaps are replayed with real timing capped
// at 150ms so a long capture does not take minutes.
//
// Output: the final turns (sent/output/note), the live screen blocks, pending
// sends, status label, and parse stats. --blocks prints the live blocks too.

import { readFileSync } from "node:fs";

const file = process.argv[2];
const wantBlocks = process.argv.includes("--blocks");

// conversation.ts calls window.setTimeout; give it one in Node.
globalThis.window = globalThis;

const { Conversation } = await import("./convo-bundle/conversation.mjs");
const events = readFileSync(file, "utf8")
  .trim()
  .split("\n")
  .map((l) => JSON.parse(l));

const conv = new Conversation(() => {});
let attached = false;
let backlog = false;
let frames = 0;
// Cap long event gaps at 1s: enough for the 700ms idle close to fire (so
// output blocks split like they do live) while a long capture still replays
// in reasonable time.
const MAX_EVENT_WAIT = 1000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let prevT = 0;
let lastSig = "";
let lastAgents = "";
for (const ev of events) {
  if (prevT > 0) {
    await sleep(Math.min(Math.max(ev.t - prevT, 0), MAX_EVENT_WAIT));
  }
  prevT = ev.t;
  if (ev.type === "typed") {
    // The page records a send the moment it goes out (conv.noteSent); echo
    // matching and pending rely on it, so the replay must do the same.
    conv.noteSent(ev.text);
    continue;
  }
  if (process.argv.includes("--trace")) {
    const sig = conv.liveBlocks.map((b) => `${b.role}:${b.lines.join(" ")}`).join("|");
    const asig = conv.agents.join(";");
    if (sig !== lastSig || asig !== lastAgents) {
      lastSig = sig;
      lastAgents = asig;
      console.log(`\n>>> t=${ev.t}ms live blocks (${conv.liveBlocks.length}):`);
      for (const b of conv.liveBlocks) console.log(`  [${b.role}] ${b.lines.join("\n      ")}`);
      if (conv.agents.length) console.log(`  [agents] ${conv.agents.join(" | ")}`);
      if (conv.status) console.log(`  [status] ${conv.status}`);
    }
  }
  if (ev.type === "text") {
    const m = ev.payload;
    if (m.type === "attached") {
      conv.setGrid(m.cols ?? 120, m.rows ?? 40);
      conv.setAltScreen(m.alt === true);
      attached = true;
      backlog = true;
    } else if (m.type === "resized") {
      conv.setGrid(m.cols, m.rows);
    }
    continue;
  }
  if (ev.type === "out") {
    if (!attached) continue;
    const bytes = Uint8Array.from(Buffer.from(ev.data, "base64"));
    frames++;
    if (backlog) {
      backlog = false;
      await conv.writeBacklog(bytes);
    } else {
      conv.write(bytes);
    }
  }
  const screenAt = Number(process.argv.find((a) => a.startsWith("--screen-at="))?.split("=")[1]);
  if (screenAt && ev.t >= screenAt) {
    console.log(`\n=== raw live screen at t=${ev.t}ms (${conv.liveScreen?.length ?? 0} rows) ===`);
    conv.liveScreen?.forEach((row, i) => console.log(`${String(i).padStart(2)}| ${row}`));
    process.exit(0);
  }
}

// Let the 60ms flush + 700ms idle close settle.
await sleep(900);

console.log(`\n=== stats: frames=${conv.stats.frames} scrolls=${conv.stats.scrolls} ===`);
console.log(`status: ${conv.status ?? "(none)"}`);
if (conv.agents.length) console.log(`agents: ${JSON.stringify(conv.agents)}`);
if (conv.pending.length) console.log(`pending: ${JSON.stringify(conv.pending)}`);

console.log(`\n=== ${conv.turns.length} turns ===`);
for (const t of conv.turns) {
  if (t.kind === "sent") console.log(`[你] ${t.text}`);
  else if (t.kind === "note") console.log(`[注] ${t.text}`);
  else
    console.log(
      `[AI${t.open ? "…" : ""}] ${t.lines.join("\n")}`.slice(0, 900),
    );
}

if (wantBlocks && conv.liveBlocks.length) {
  console.log(`\n=== ${conv.liveBlocks.length} live blocks (still on screen) ===`);
  for (const b of conv.liveBlocks) {
    console.log(`[${b.role}] ${b.lines.join("\n")}`);
  }
}
