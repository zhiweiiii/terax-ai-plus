// Debug the WS handshake: print raw response headers.
// Usage: node scripts/debug-ws.mjs [port] [cookie]
//   port   - dev 17001 (default), release 17002
//   cookie - optional raw Cookie header value; without it the server
//            returns 403 (auth required).
const key = "dGhlIHNhbXBsZSBub25jZQ==";
const net = await import("node:net");

const port = Number(process.argv[2] ?? 17001);
const cookie = process.argv[3] ?? "";
const sock = net.connect(port, "127.0.0.1");
sock.on("connect", () => {
  const lines = [
    `GET /ws HTTP/1.1`,
    `Host: 127.0.0.1:${port}`,
    "Upgrade: websocket",
    "Connection: Upgrade",
    `Sec-WebSocket-Key: ${key}`,
    "Sec-WebSocket-Version: 13",
  ];
  if (cookie) lines.push(`Cookie: ${cookie}`);
  lines.push("", "");
  sock.write(lines.join("\r\n"));
});
let data = "";
sock.on("data", (chunk) => {
  data += chunk.toString("latin1");
  if (data.includes("\r\n\r\n")) {
    console.log("RESPONSE HEADERS:\n" + data.split("\r\n\r\n")[0]);
    sock.destroy();
    process.exit(0);
  }
});
sock.on("error", (e) => {
  console.error("socket error:", e.message);
  process.exit(1);
});
setTimeout(() => {
  console.error("timeout");
  process.exit(1);
}, 5000);
