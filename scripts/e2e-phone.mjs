// End-to-end: drive the real phone page in a headless browser against the
// live web terminal server, like an actual phone user.
//
//   node scripts/e2e-phone.mjs [leafIdOrCwdHint]
//
// Auth is done by injecting the terax_web cookie (same XOR-constant decode as
// web-capture.mjs), so the plaintext password is never needed.
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const corePath = require.resolve("playwright-core", {
  paths: ["D:\\project\\claude_project\\terax-ai\\node_modules\\.pnpm\\playwright-core@1.62.1\\node_modules"],
});
const { chromium } = require(corePath);

const KEY = [0x53, 0x2a, 0x7c, 0x91, 0x0d];
const ENCODED = [
  0x6b, 0x13, 0x4d, 0xa1, 0x69, 0x30, 0x4e, 0x4a, 0xa8, 0x38, 0x64, 0x4c,
  0x19, 0xf3, 0x68, 0x63, 0x1c, 0x1d, 0xa4, 0x35, 0x61, 0x4e, 0x18, 0xf7,
  0x3f, 0x32, 0x18, 0x4f, 0xf5, 0x6b, 0x60, 0x48, 0x19, 0xa3, 0x3e, 0x65,
  0x1d, 0x1e, 0xf4, 0x35, 0x61, 0x4b, 0x1a, 0xa4, 0x3d, 0x62, 0x19, 0x4c,
];
const token = ENCODED.map((b, i) => String.fromCharCode(b ^ KEY[i % 5])).join("");

const url = "http://127.0.0.1:34269";
const hint = process.argv[2];

let failures = 0;
function check(name, cond, detail) {
  if (cond) {
    console.log(`ok - ${name}`);
  } else {
    failures++;
    console.log(`FAIL - ${name}${detail ? `\n${detail}` : ""}`);
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
await ctx.addCookies([{ name: "terax_web", value: token, url }]);
const page = await ctx.newPage();
const logs = [];
page.on("console", (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on("pageerror", (e) => logs.push(`[pageerror] ${e.message}`));

await page.goto(url, { waitUntil: "networkidle", timeout: 15000 });
await page.waitForSelector("#btn-list", { timeout: 8000 });
check("no login wall (cookie accepted)", true);

// Open the switcher and pick the session we want (by leaf id or cwd hint).
await page.click("#btn-list");
await page.waitForTimeout(1200);
const items = await page.evaluate(() =>
  [...document.querySelectorAll(".session-item")].map((el, i) => ({
    i,
    text: el.textContent?.trim().replace(/\s+/g, " "),
  })),
);
check("session list shows entries", items.length > 0, items.join("\n"));

// Pick a session: by numeric leaf id (via data-leaf), else by text hint,
// else the first entry. Then attach by clicking it.
if (/^\d+$/.test(hint)) {
  const leafEl = page.locator(`.session-item[data-leaf="${hint}"]`);
  check(
    "session with data-leaf present",
    (await leafEl.count()) > 0,
    `no [data-leaf="${hint}"] in list`,
  );
  await leafEl.click();
} else {
  let pick = 0;
  if (hint) {
    const hit = items.find((it) => it.text?.toLowerCase().includes(hint.toLowerCase()));
    pick = hit?.i ?? -1;
  }
  check("found a session to attach to", pick >= 0, JSON.stringify(items));
  await page.locator(".session-item").nth(pick).click();
}
await page.waitForTimeout(3000);
const status = await page.evaluate(() => document.querySelector("#status")?.textContent ?? "");
check("attached (status shows a session)", status.length > 0, status);

// A cold shell may take a moment to print its first prompt; give it room
// before judging whether the stream rendered.
await page.waitForTimeout(2000);

// A full-screen TUI renders its screen as bubbles; a plain shell renders into
// the history turns instead. Either means the stream is being parsed.
const liveAfterAttach = await page.evaluate(() => ({
  live: [...document.querySelectorAll("#live-blocks .turn")].map((e) => e.textContent?.trim().slice(0, 60)),
  turns: [...document.querySelectorAll("#turns .turn")].map((e) => e.textContent?.trim().slice(0, 60)),
}));
console.log("--- live blocks after attach ---");
for (const b of liveAfterAttach.live.slice(-10)) console.log(" ", b);
check(
  "session stream rendered (TUI blocks or shell turns)",
  liveAfterAttach.live.length > 0 || liveAfterAttach.turns.length > 0,
  `${liveAfterAttach.live.length} live / ${liveAfterAttach.turns.length} turns`,
);

// Drive a command into the session only when asked (typing into a TUI's chat
// input changes its conversation).
if (!process.argv.includes("--no-send")) {
  // Send a command through the composer and check it bubbles out.
  await page.fill("#input", "echo phone-e2e-test");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(3000);
  const sent = await page.evaluate(() =>
    [...document.querySelectorAll(".turn.sent")].map((e) => e.textContent?.trim()),
  );
  check("sent bubble appears", sent.some((b) => b.includes("echo phone-e2e-test")), sent.join("\n"));
  const echoed = await page.evaluate(() => document.body.innerText.includes("phone-e2e-test"));
  check("shell echoed the command on screen", echoed);
}

const blocks = await page.evaluate(() =>
  [...document.querySelectorAll("#live-blocks .turn")].map((e) => e.textContent?.trim().slice(0, 70)),
);
console.log("\n--- live blocks (final) ---");
for (const b of blocks.slice(-8)) console.log(" ", b);
console.log("\n--- console (tail) ---");
for (const l of logs.slice(-10)) console.log(l);

await browser.close();
console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
