// ローカルフォントブリッジ・ブローカー
// 役割: Claude(curl) から届く HTTP リクエストを、Figma 開発者プラグインへ WebSocket で中継する。
//   Claude --HTTP:3056--> このブローカー --WS:3055--> プラグインUI --> code.js(Plugin API・ローカルフォント可)
// すべて 127.0.0.1 のみで待ち受ける（外部からは接続できない）。
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const ws = require("./ws-min");

const WS_PORT = 3055;    // プラグイン接続用
const HTTP_PORT = 3056;  // Claude 呼び出し用
const TIMEOUT_MS = 30000;

const DIR = __dirname;
const TOKEN_FILE = path.join(DIR, ".token");
const LOG_FILE = path.join(DIR, "bridge.log");

// --- トークン発行 ---
// 既定: 起動ごとに新規発行。
// 再利用モード（環境変数 BRIDGE_REUSE_TOKEN=1 か引数 --reuse-token）: 既存の .token が正しい形式なら使い回す。
//   → 常駐（launchd）で再起動してもプラグイン側に記憶したトークンが使い続けられる。
const REUSE_TOKEN = process.env.BRIDGE_REUSE_TOKEN === "1" || process.argv.includes("--reuse-token");

// 既存トークンを読む（無い・形式が違う場合は null）
function readExistingToken() {
  try {
    const t = fs.readFileSync(TOKEN_FILE, "utf8").trim();
    return /^[0-9a-f]{32}$/.test(t) ? t : null;
  } catch { return null; }
}

let TOKEN = REUSE_TOKEN ? readExistingToken() : null;
const TOKEN_REUSED = !!TOKEN;
if (!TOKEN) TOKEN = crypto.randomBytes(16).toString("hex");

// .token への書き込みは「2つのポートを両方確保できた後」に行う。
// （二重起動でポート競合した側が、稼働中ブローカーの .token を上書きしないように）
let listening = 0;
function onListening() {
  if (++listening < 2) return;
  if (!TOKEN_REUSED) fs.writeFileSync(TOKEN_FILE, TOKEN + "\n", { mode: 0o600 });
  try { fs.chmodSync(TOKEN_FILE, 0o600); } catch {}   // 権限は本人のみ（600）に揃える
  console.log("");
  console.log("=== このトークンを Figma プラグインUIの入力欄に貼ってください ===");
  console.log(TOKEN);
  console.log("（" + TOKEN_FILE + " にも保存済み）");
  console.log("");
}

function log(...args) {
  const line = "[" + new Date().toISOString() + "] " + args.join(" ");
  fs.appendFileSync(LOG_FILE, line + "\n");
  console.log(line);
}

// --- 状態 ---
let pluginSocket = null;       // 接続中のプラグイン（1つだけ）
let pluginInfo = null;         // プラグインが名乗った情報
const pending = new Map();     // リクエストID -> {resolve, timer}
let seq = 0;

function sendToPlugin(method, params) {
  return new Promise((resolve) => {
    if (!pluginSocket) {
      resolve({ ok: false, error: "plugin_not_connected", hint: "Figmaでプラグインを起動しトークンを貼ってください" });
      return;
    }
    const id = "r" + (++seq);
    const timer = setTimeout(() => {
      pending.delete(id);
      resolve({ ok: false, error: "timeout", method });
    }, TIMEOUT_MS);
    pending.set(id, { resolve, timer });
    try {
      ws.send(pluginSocket, JSON.stringify({ type: "rpc", id, method, params: params || {} }));
    } catch (e) {
      clearTimeout(timer); pending.delete(id);
      resolve({ ok: false, error: "send_failed", detail: String(e) });
    }
  });
}

// --- WebSocket サーバ（プラグイン用） ---
const wsServer = http.createServer((req, res) => {
  res.writeHead(426); res.end("upgrade required\n");
});

wsServer.on("upgrade", (req, socket) => {
  let authed = false;
  const sock = ws.accept(req, socket, (text) => {
    let msg;
    try { msg = JSON.parse(text); } catch { return; }

    // 最初のメッセージは必ず認証
    if (!authed) {
      if (msg.type === "auth" && msg.token === TOKEN) {
        authed = true;
        pluginSocket = sock;
        pluginInfo = msg.info || null;
        ws.send(sock, JSON.stringify({ type: "auth_ok" }));
        log("plugin connected", JSON.stringify(pluginInfo));
      } else {
        ws.send(sock, JSON.stringify({ type: "auth_failed" }));
        log("auth failed");
        socket.end();
      }
      return;
    }

    // プラグインからの RPC レスポンス
    if (msg.type === "rpc_result" && pending.has(msg.id)) {
      const p = pending.get(msg.id);
      clearTimeout(p.timer); pending.delete(msg.id);
      p.resolve(msg.result);
    }
  }, () => {
    if (pluginSocket === sock) { pluginSocket = null; pluginInfo = null; log("plugin disconnected"); }
  });
});

// ポートが既に使われている場合（別のブローカーが起動中など）は、分かりやすく記録して終了する
function onListenError(port) {
  return (err) => {
    if (err.code === "EADDRINUSE") {
      log("ERROR: port " + port + " is already in use (another broker running?). Exiting. / ポート " + port + " は使用中です（ブローカーの二重起動？）。終了します");
    } else {
      log("ERROR: listen on " + port + " failed: " + err);
    }
    process.exit(1);
  };
}
wsServer.on("error", onListenError(WS_PORT));

wsServer.listen(WS_PORT, "localhost", () => { log("WS  listening ws://127.0.0.1:" + WS_PORT); onListening(); });

// --- HTTP サーバ（Claude 用） ---
const httpServer = http.createServer((req, res) => {
  const reply = (code, obj) => {
    const body = JSON.stringify(obj);
    res.writeHead(code, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(body) });
    res.end(body);
  };

  // トークン検証（Authorization: Bearer <token> か X-Bridge-Token）
  const given = (req.headers["x-bridge-token"] || (req.headers["authorization"] || "").replace(/^Bearer\s+/i, "")).trim();
  if (given !== TOKEN) { reply(401, { ok: false, error: "bad_token" }); return; }

  if (req.method === "GET" && req.url.startsWith("/status")) {
    reply(200, { ok: true, plugin_connected: !!pluginSocket, plugin: pluginInfo, pending: pending.size });
    return;
  }

  if (req.method === "POST" && req.url.startsWith("/rpc")) {
    let body = "";
    let tooBig = false;
    req.on("data", (c) => {
      body += c;
      if (body.length > 2 * 1024 * 1024) { tooBig = true; req.destroy(); }   // 2MB上限
    });
    req.on("end", async () => {
      if (tooBig) { reply(413, { ok: false, error: "payload_too_large" }); return; }
      let parsed;
      try { parsed = JSON.parse(body || "{}"); } catch { reply(400, { ok: false, error: "bad_json" }); return; }
      if (!parsed.method) { reply(400, { ok: false, error: "method_required" }); return; }
      log("rpc ->", parsed.method, JSON.stringify(parsed.params || {}).slice(0, 300));
      const result = await sendToPlugin(parsed.method, parsed.params);
      log("rpc <-", parsed.method, JSON.stringify(result).slice(0, 300));
      reply(200, result);
    });
    return;
  }

  reply(404, { ok: false, error: "not_found" });
});

httpServer.on("error", onListenError(HTTP_PORT));

httpServer.listen(HTTP_PORT, "127.0.0.1", () => {
  log("HTTP listening http://127.0.0.1:" + HTTP_PORT + (TOKEN_REUSED ? " (token reused)" : " (new token)"));
  onListening();
});

process.on("SIGINT", () => { log("shutdown"); process.exit(0); });
// launchd の停止（bootout/unload）は SIGTERM で届く
process.on("SIGTERM", () => { log("shutdown (SIGTERM)"); process.exit(0); });
