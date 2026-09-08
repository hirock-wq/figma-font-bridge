// 配線検証用のモックプラグイン（Figma を起動せずにブローカーの往復をテストする）
// 使い方: node broker/server.js を起動してから  node broker/mock-plugin.js
// 本番のプラグインUIと同じ手順で auth → rpc 受信 → rpc_result 返却 を行う。
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const net = require("net");

const TOKEN = fs.readFileSync(path.join(__dirname, ".token"), "utf8").trim();
const key = crypto.randomBytes(16).toString("base64");

const socket = net.connect(3055, "127.0.0.1", () => {
  socket.write(
    "GET / HTTP/1.1\r\nHost: 127.0.0.1:3055\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
    "Sec-WebSocket-Key: " + key + "\r\nSec-WebSocket-Version: 13\r\n\r\n"
  );
});

// --- 最小 WS クライアント（送信はマスク必須） ---
function send(obj) {
  const payload = Buffer.from(JSON.stringify(obj), "utf8");
  const n = payload.length;
  let head;
  if (n < 126) { head = Buffer.alloc(2); head[1] = 0x80 | n; }
  else if (n < 65536) { head = Buffer.alloc(4); head[1] = 0x80 | 126; head.writeUInt16BE(n, 2); }
  else { head = Buffer.alloc(10); head[1] = 0x80 | 127; head.writeBigUInt64BE(BigInt(n), 2); }
  head[0] = 0x81;
  const mask = crypto.randomBytes(4);
  const masked = Buffer.from(payload);
  for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i & 3];
  socket.write(Buffer.concat([head, mask, masked]));
}

let handshakeDone = false;
let buf = Buffer.alloc(0);

socket.on("data", (chunk) => {
  buf = Buffer.concat([buf, chunk]);
  if (!handshakeDone) {
    const idx = buf.indexOf("\r\n\r\n");
    if (idx < 0) return;
    console.log("[mock] handshake:", buf.slice(0, buf.indexOf("\r\n")).toString());
    buf = buf.slice(idx + 4);
    handshakeDone = true;
    send({ type: "auth", token: TOKEN, info: { plugin: "mock" } });
  }
  // サーバ→クライアントはマスク無し
  for (;;) {
    if (buf.length < 2) return;
    let len = buf[1] & 0x7f, offset = 2;
    if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); offset = 4; }
    else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); offset = 10; }
    if (buf.length < offset + len) return;
    const text = buf.slice(offset, offset + len).toString("utf8");
    buf = buf.slice(offset + len);
    let msg; try { msg = JSON.parse(text); } catch { continue; }
    console.log("[mock] recv:", text.slice(0, 200));
    if (msg.type === "rpc") {
      // 本物の code.js の代わりにダミーの結果を返す
      send({ type: "rpc_result", id: msg.id, result: { ok: true, method: msg.method, data: { mock: true, params: msg.params } } });
    }
  }
});

socket.on("error", (e) => { console.error("[mock] error", e.message); process.exit(1); });
