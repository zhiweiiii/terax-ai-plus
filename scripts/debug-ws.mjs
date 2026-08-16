// Debug the WS handshake: print raw response headers.
const key = "dGhlIHNhbXBsZSBub25jZQ==";
const net = await import("node:net");

const sock = net.connect(17000, "127.0.0.1");
sock.on("connect", () => {
  const req = [
    "GET /ws HTTP/1.1",
    "Host: 127.0.0.1:17000",
    "Upgrade: websocket",
    "Connection: Upgrade",
    `Sec-WebSocket-Key: ${key}`,
    "Sec-WebSocket-Version: 13",
    "",
    "",
  ].join("\r\n");
  sock.write(req);
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
