// Debug the phone page's window switcher with Playwright.
// Usage: node scripts/debug-phone.mjs [url]
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const corePath = require.resolve("playwright-core", {
  paths: ["D:\\project\\claude_project\\terax-ai\\node_modules\\.pnpm\\playwright-core@1.62.1\\node_modules"],
});
const { chromium } = require(corePath);

const url = process.argv[2] ?? "http://127.0.0.1:34269";

const browser = await chromium.launch();
const ctx = await browser.newContext({
  viewport: { width: 390, height: 844 },
});
const page = await ctx.newPage();

const logs = [];
page.on("console", (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on("pageerror", (e) => logs.push(`[pageerror] ${e.message}`));
page.on("websocket", (ws) => {
  ws.on("framereceived", ({ payload }) => {
    if (typeof payload !== "string") return;
    try {
      const m = JSON.parse(payload);
      if (m.type === "sessions") {
        logs.push(
          `[ws sessions] spaces=${JSON.stringify(m.spaces ?? null)} sessions=${m.sessions.length}`,
        );
      }
    } catch {}
  });
});

await page.goto(url, { waitUntil: "networkidle", timeout: 10000 }).catch((e) => {
  console.error("goto failed:", e.message);
});

// Login if the login page shows.
const hasPwd = await page.locator("#pwd").count();
if (hasPwd > 0) {
  await page.fill("#pwd", "hzwyes123");
  await page.click("button:has-text('进入')");
  await page.waitForTimeout(1200);
}

// Open the switcher sheet.
await page.waitForTimeout(800);
const hasListBtn = await page.locator("#btn-list").count();
if (hasListBtn > 0) {
  await page.click("#btn-list");
}
await page.waitForTimeout(1500);

const result = await page.evaluate(() => {
  const groups = [...document.querySelectorAll(".session-group")].map((e) =>
    e.textContent?.trim(),
  );
  const items = [...document.querySelectorAll(".session-item")].map((e) =>
    e.textContent?.trim().replace(/\s+/g, " "),
  );
  const empty = document.querySelector(".session-empty")?.textContent ?? null;
  const status = document.querySelector("#status")?.textContent ?? null;
  return { groups, items, empty, status };
});

console.log(JSON.stringify({ url, result }, null, 2));
console.log("--- console logs ---");
for (const l of logs) console.log(l);

await browser.close();
