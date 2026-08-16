// Manual smoke test for the web terminal bridge (port 17000).
// Usage: node scripts/test-web.mjs [host]
// Expects a running Terax instance with a live PTY session.
const host = process.argv[2] ?? "127.0.0.1";

function main() {
  const http = new URL(`http://${host}:17000/`);
  fetch(http)
    .then((r) => {
      if (!r.ok) throw new Error(`page fetch: HTTP ${r.status}`);
      return r.text();
    })
    .then((html) => {
      console.log(`[ok] GET / -> ${html.length} bytes, has xterm: ${html.includes("xterm")}`);
    })
    .catch((e) => {
      console.error(`[fail] page: ${e}`);
      process.exitCode = 1;
    });

  const ws = new WebSocket(`ws://${host}:17000/ws`);
  const timeout = setTimeout(() => {
    console.error("[fail] ws: no sessions message within 5s");
    process.exit(1);
  }, 5000);

  ws.binaryType = "arraybuffer";
  ws.onopen = () => {
    console.log("[ok] ws connected");
    ws.send(JSON.stringify({ list: true }));
  };
  ws.onmessage = (ev) => {
    if (typeof ev.data === "string") {
      const msg = JSON.parse(ev.data);
      console.log(`[ws] text: ${JSON.stringify(msg).slice(0, 200)}`);
      if (msg.type === "sessions") {
        clearTimeout(timeout);
        if (msg.sessions.length > 0) {
          const id = msg.sessions[0].id;
          console.log(`[ok] attaching to session ${id}`);
          ws.send(JSON.stringify({ attach: id, cols: 80, rows: 24 }));
        } else {
          console.log("[warn] no sessions available (open a terminal tab first)");
        }
        setTimeout(() => ws.close(), 800);
      }
    } else {
      const bytes = new Uint8Array(ev.data);
      const kind = bytes[0] === 0x30 ? "output" : bytes[0] === 0x31 ? "title" : "?";
      console.log(`[ws] binary ${kind}: ${bytes.length - 1} bytes`);
      if (bytes[0] === 0x30) {
        const text = new TextDecoder().decode(bytes.subarray(1)).slice(0, 120);
        console.log(`[ws] output sample: ${JSON.stringify(text)}`);
      }
    }
  };
  ws.onclose = (ev) => {
    console.log(`[ok] ws closed (code ${ev.code})`);
    clearTimeout(timeout);
  };
  ws.onerror = (e) => {
    console.error(`[fail] ws error: ${e.message ?? e}`);
    process.exitCode = 1;
    clearTimeout(timeout);
  };
}

main();
