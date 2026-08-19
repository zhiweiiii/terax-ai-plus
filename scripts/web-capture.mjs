// Drive the phone bridge's WebSocket and record everything for replay.
// The server is the dev instance on 34269 (release: 34268).
//
//   node scripts/web-capture.mjs list
//   node scripts/web-capture.mjs drive <leafId> <scenario.json> <out.jsonl> <timeoutSec>
//   node scripts/web-capture.mjs watch <leafId> <out.jsonl> <timeoutSec>
//
// Scenario file: JSON array of { "after": ms, "type": "text to send" }.
// "after" is relative to the previous command (default 0). "type" is written
// verbatim to the PTY, so end with \r for Enter.
//
// Output JSONL:
//   {"t":ms,"type":"text","payload":{...}}   server text message (attached/sessions/resized/...)
//   {"t":ms,"type":"out","len":n,"data":"<base64>"}  binary output frame (history first)
//
// Auth cookie is decoded from the same XOR-obfuscated constant the Rust side
// embeds (web_token() in src-tauri/src/modules/web/mod.rs). The plaintext
// password is never needed.

const KEY = [0x53, 0x2a, 0x7c, 0x91, 0x0d];
const ENCODED = [
  0x6b, 0x13, 0x4d, 0xa1, 0x69, 0x30, 0x4e, 0x4a, 0xa8, 0x38, 0x64, 0x4c,
  0x19, 0xf3, 0x68, 0x63, 0x1c, 0x1d, 0xa4, 0x35, 0x61, 0x4e, 0x18, 0xf7,
  0x3f, 0x32, 0x18, 0x4f, 0xf5, 0x6b, 0x60, 0x48, 0x19, 0xa3, 0x3e, 0x65,
  0x1d, 0x1e, 0xf4, 0x35, 0x61, 0x4b, 0x1a, 0xa4, 0x3d, 0x62, 0x19, 0x4c,
];
const token = ENCODED.map((b, i) => String.fromCharCode(b ^ KEY[i % 5])).join("");

const PORT = Number(process.env.WEB_PORT ?? 34269);
const url = `ws://127.0.0.1:${PORT}/ws`;
const cmd = process.argv[2];

const ws = new WebSocket(url, { headers: { Cookie: `terax_web=${token}` } });
ws.binaryType = "arraybuffer";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();

function out(type, payload) {
  if (type === "out") {
    console.log(
      `[${Date.now() - t0}ms] out ${payload.len}B`,
    );
  } else {
    console.log(`[${Date.now() - t0}ms] text ${JSON.stringify(payload).slice(0, 140)}`);
  }
}

async function main() {
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = (e) => reject(new Error("ws error (auth failed?)"));
  });

  if (cmd === "list") {
    ws.onmessage = (ev) => {
      if (typeof ev.data === "string") {
        const m = JSON.parse(ev.data);
        if (m.type === "sessions") {
          console.log(JSON.stringify(m, null, 2));
          process.exit(0);
        }
      }
    };
    ws.send(JSON.stringify({ list: true }));
    await sleep(1500);
    process.exit(0);
  }

  const leaf = Number(process.argv[3]);
  const isDrive = cmd === "drive";
  // drive: argv[4]=scenario argv[5]=out argv[6]=timeout; watch: argv[4]=out argv[5]=timeout
  const scenarioFile = isDrive ? process.argv[4] : null;
  const outFile = isDrive ? process.argv[5] : process.argv[4];
  const timeoutSec = Number(isDrive ? process.argv[6] : process.argv[5] ?? 60);

  const fs = await import("node:fs");
  const lines = [];
  let backlog = true;
  let attached = null;

  ws.onmessage = (ev) => {
    const t = Date.now() - t0;
    if (typeof ev.data === "string") {
      let m;
      try {
        m = JSON.parse(ev.data);
      } catch {
        return;
      }
      lines.push({ t, type: "text", payload: m });
      if (m.type === "attached") {
        attached = m;
        backlog = true;
      }
      return;
    }
    const bytes = new Uint8Array(ev.data);
    if (bytes.length === 0 || bytes[0] !== 0x30) return;
      lines.push({ t, type: "out", len: bytes.length - 1, data: Buffer.from(bytes.subarray(1)).toString("base64") });
  };

  // Attach first (drive and watch both start the same way). A cold leaf has no
  // PTY yet: the server answers "opening" and the desktop spawns it; retry the
  // attach until "attached" arrives, like the phone page does.
  const started = Date.now();
  const attachSent = new Promise((resolve, reject) => {
    const attempts = (n) => {
      // No grid: the phone does not impose one, so neither does the capture.
      ws.send(JSON.stringify({ attach: leaf }));
      const timer = setInterval(() => {
        if (attached && attached.id === leaf) {
          clearInterval(timer);
          resolve();
        }
      }, 250);
      setTimeout(() => {
        clearInterval(timer);
        if (attached && attached.id === leaf) {
          resolve();
          return;
        }
        if (Date.now() - started > 45000) {
          reject(new Error(`attach to ${leaf} timed out (opening flow?)`));
          return;
        }
        attempts(n + 1);
      }, 2000);
    };
    attempts(0);
  });
  await attachSent;
  backlog = false;

  if (isDrive) {
    const scenario = JSON.parse(fs.readFileSync(scenarioFile, "utf8"));
    for (const step of scenario) {
      const wait = step.after ?? 0;
      if (wait > 0) await sleep(wait);
      const frame = Buffer.concat([Buffer.from([0x30]), Buffer.from(step.type, "utf8")]);
      ws.send(frame);
      lines.push({ t: Date.now() - t0, type: "typed", text: step.type });
      out("typed", step.type.length > 40 ? step.type.slice(0, 40) + "…" : step.type);
    }
  }

  await sleep(timeoutSec * 1000);
  ws.close();
  fs.writeFileSync(outFile, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  console.log(`\nrecorded ${lines.length} events -> ${outFile} (${fs.statSync(outFile).size} bytes)`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
