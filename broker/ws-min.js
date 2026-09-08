// 最小限の WebSocket サーバ実装（テキストフレームのみ・依存パッケージなし）
// なぜ自作か: npm install なしで動かしたい（このMacのオフライン/権限事情を避ける）ため。
// 代替案は ws パッケージだが、依存を1つも増やさない方が運用が楽なのでこちらを採用。
const crypto = require("crypto");

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

// HTTP の Upgrade リクエストを WebSocket 接続へ昇格させる
function accept(req, socket, onMessage, onClose) {
  const key = req.headers["sec-websocket-key"];
  if (!key) { socket.destroy(); return null; }
  const accept = crypto.createHash("sha1").update(key + GUID).digest("base64");
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
    "Upgrade: websocket\r\n" +
    "Connection: Upgrade\r\n" +
    "Sec-WebSocket-Accept: " + accept + "\r\n\r\n"
  );
  socket.setNoDelay(true);

  let buf = Buffer.alloc(0);
  let fragments = [];   // 分割フレームの結合用

  socket.on("data", (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    // 取り出せるフレームがある限り処理する
    for (;;) {
      if (buf.length < 2) return;
      const fin = (buf[0] & 0x80) !== 0;
      const opcode = buf[0] & 0x0f;
      const masked = (buf[1] & 0x80) !== 0;
      let len = buf[1] & 0x7f;
      let offset = 2;
      if (len === 126) {
        if (buf.length < 4) return;
        len = buf.readUInt16BE(2); offset = 4;
      } else if (len === 127) {
        if (buf.length < 10) return;
        const big = buf.readBigUInt64BE(2);
        if (big > 16n * 1024n * 1024n) { socket.destroy(); return; } // 16MB上限
        len = Number(big); offset = 10;
      }
      let maskKey = null;
      if (masked) {
        if (buf.length < offset + 4) return;
        maskKey = buf.slice(offset, offset + 4); offset += 4;
      }
      if (buf.length < offset + len) return;
      let payload = Buffer.from(buf.slice(offset, offset + len));
      buf = buf.slice(offset + len);
      if (maskKey) for (let i = 0; i < payload.length; i++) payload[i] ^= maskKey[i & 3];

      if (opcode === 0x8) { socket.end(); if (onClose) onClose(); return; }
      if (opcode === 0x9) { send(socket, payload, 0xa); continue; }  // ping → pong
      if (opcode === 0xa) continue;                                   // pong は無視
      if (opcode === 0x0) { fragments.push(payload); }                // 継続フレーム
      else { fragments = [payload]; }
      if (fin) {
        const full = Buffer.concat(fragments);
        fragments = [];
        if (onMessage) onMessage(full.toString("utf8"));
      }
    }
  });
  socket.on("error", () => { if (onClose) onClose(); });
  socket.on("close", () => { if (onClose) onClose(); });
  return socket;
}

// テキストフレームを送る（opcode 0x1 既定）
function send(socket, data, opcode = 0x1) {
  const payload = Buffer.isBuffer(data) ? data : Buffer.from(String(data), "utf8");
  const n = payload.length;
  let head;
  if (n < 126) {
    head = Buffer.alloc(2); head[1] = n;
  } else if (n < 65536) {
    head = Buffer.alloc(4); head[1] = 126; head.writeUInt16BE(n, 2);
  } else {
    head = Buffer.alloc(10); head[1] = 127; head.writeBigUInt64BE(BigInt(n), 2);
  }
  head[0] = 0x80 | opcode;
  socket.write(Buffer.concat([head, payload]));
}

module.exports = { accept, send };
