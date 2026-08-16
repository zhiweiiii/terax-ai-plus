// Playwright: verify the web page with WebGL renderer + toolbar + resize.
import { chromium } from "playwright";

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
const logs = [];
page.on("console", (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on("pageerror", (e) => logs.push(`[pageerror] ${e.message}`));
page.on("websocket", (ws) => {
  ws.on("framesent", (e) => logs.push(`[ws->] ${String(e.payload).slice(0, 80)}`));
  ws.on("framereceived", (e) => logs.push(`[ws<-] ${String(e.payload).slice(0, 80)}`));
});

await page.goto("http://127.0.0.1:17001/", { waitUntil: "load", timeout: 10000 });
await page.waitForTimeout(3000);

const state = await page.evaluate(() => {
  const el = document.querySelector(".xterm");
  const canvas = document.querySelector(".xterm canvas");
  return {
    hasXterm: !!el,
    hasWebglCanvas: !!canvas,
    cols: window.__xtermCols ?? null,
    status: document.getElementById("status")?.textContent,
    toolbar: !!document.querySelector(".toolbar"),
    ctrlcBtn: !!document.querySelector("#btn-ctrl-c"),
  };
});
console.log("=== STATE ===");
console.log(JSON.stringify(state, null, 2));

// Click Ctrl+C button — should send binary frame 0x30 0x03
await page.click("#btn-ctrl-c");
await page.waitForTimeout(500);

console.log("=== LOGS (last 15) ===");
for (const l of logs.slice(-15)) console.log(l);

await page.screenshot({ path: "C:/Users/11786/AppData/Local/Temp/opencode/webgl-test.png" });
await browser.close();
