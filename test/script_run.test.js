// script.run（opt-in スクリプト実行）のテスト。Node だけで完結し、Figma も常駐ブローカーも使わない。
// 実行: node test/script_run.test.js   （全部通れば exit 0、1つでも失敗すれば exit 1）
//
// 確かめること
//   A. ブローカーの関所（broker/script-gate.js）の単体テスト
//   B. ブローカーを「空きポート＋一時フォルダ」で2台起動（既定=拒否 / --allow-script=許可）し、
//      モックプラグインをつないで HTTP 越しに確認（常駐ブローカー 3055/3056 と .token には触れない）
//      (a) 既定では script.run が 403 script_disabled
//      (b) 許可時は script.run がプラグインへ転送される（モックが echo を返す）
//      (c) 既存メソッドは許可設定に関係なく通る / 2MB 超のボディは従来どおり 413
//      (e) BRIDGE_ALLOW_SCRIPT=1 でも許可になる（/status の allow_script）
//   C. plugin/code.js を Node の vm に読み込み、スタブの figma で script.run を直接実行
//      (d) code 200KB 超 → code_too_large / 戻り値 2MB 超 → result_too_large
//      ほか: JSON 安全化・例外・構文エラー・タイムアウト・helpers・既存メソッドの回帰
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const net = require("net");
const http = require("http");
const vm = require("vm");
const { spawn } = require("child_process");

const ROOT = path.join(__dirname, "..");
const RESIDENT_PORTS = [3055, 3056];   // 常駐ブローカーのポート（テストでは絶対に使わない）

// ---------- 小さなテストランナー ----------
const results = [];
async function test(name, fn) {
  try { await fn(); results.push({ name, ok: true }); console.log("ok   - " + name); }
  catch (e) { results.push({ name, ok: false }); console.log("FAIL - " + name + "\n       " + (e && e.stack ? e.stack.split("\n").slice(0, 3).join("\n       ") : e)); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- A. 関所の単体テスト ----------
const gate = require(path.join(ROOT, "broker/script-gate.js"));

async function gateTests() {
  await test("gate: allow flag resolves from --allow-script / BRIDGE_ALLOW_SCRIPT=1 only", () => {
    assert.strictEqual(gate.resolveAllowScript([], {}), false);
    assert.strictEqual(gate.resolveAllowScript(["node", "server.js", "--allow-script"], {}), true);
    assert.strictEqual(gate.resolveAllowScript([], { BRIDGE_ALLOW_SCRIPT: "1" }), true);
    assert.strictEqual(gate.resolveAllowScript([], { BRIDGE_ALLOW_SCRIPT: "0" }), false);
    assert.strictEqual(gate.resolveAllowScript([], { BRIDGE_ALLOW_SCRIPT: "true" }), false);
  });
  await test("gate: script.run blocked with 403 unless allowed; other methods never blocked", () => {
    const b = gate.gateRpc("script.run", false);
    assert.strictEqual(b.status, 403);
    assert.deepStrictEqual(b.body, { ok: false, error: "script_disabled", message: "start the broker with --allow-script or BRIDGE_ALLOW_SCRIPT=1" });
    assert.strictEqual(gate.gateRpc("script.run", true), null);
    for (const m of ["fonts.probe", "node.get", "text.reflow", "text.setStyle", "text.setFont", "text.setCharacters", "node.export", "node.move", "node.resize", "selection.get"]) {
      assert.strictEqual(gate.gateRpc(m, false), null, m);
      assert.strictEqual(gate.gateRpc(m, true), null, m);
    }
  });
  await test("gate: broker wait time = 30s for existing methods, timeoutMs+5s (default 60s) for script.run", () => {
    assert.strictEqual(gate.rpcWaitMs("node.get", {}, 30000), 30000);
    assert.strictEqual(gate.rpcWaitMs("script.run", {}, 30000), 65000);
    assert.strictEqual(gate.rpcWaitMs("script.run", { timeoutMs: 1000 }, 30000), 30000);
    assert.strictEqual(gate.rpcWaitMs("script.run", { timeoutMs: 120000 }, 30000), 125000);
    assert.strictEqual(gate.rpcWaitMs("script.run", { timeoutMs: 1e9 }, 30000), 605000);
  });
}

// ---------- B. 実ブローカー + モックプラグイン ----------

// OS に空きポートを1つ選ばせる（常駐ポートは避ける）
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const port = srv.address().port;
      srv.close(() => (RESIDENT_PORTS.includes(port) ? freePort().then(resolve, reject) : resolve(port)));
    });
    srv.on("error", reject);
  });
}

function request(port, token, method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : (typeof body === "string" ? body : JSON.stringify(body));
    const req = http.request({
      host: "127.0.0.1", port, method, path: urlPath,
      headers: Object.assign({ "x-bridge-token": token }, data ? { "content-type": "application/json", "content-length": Buffer.byteLength(data) } : {})
    }, (res) => {
      let buf = "";
      res.on("data", (c) => (buf += c));
      res.on("end", () => { let json = null; try { json = JSON.parse(buf); } catch {} resolve({ status: res.statusCode, json, raw: buf }); });
    });
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

const children = [];
const tempDirs = [];   // 終了時に消す一時フォルダ
// ブローカーを一時フォルダ・空きポートで起動し、モックプラグインをつなぐ
async function startBroker(label, extraArgs, extraEnv) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "fontbridge-test-"));
  tempDirs.push(stateDir);
  const wsPort = await freePort();
  let httpPort = await freePort();
  while (httpPort === wsPort) httpPort = await freePort();
  const env = Object.assign({}, process.env, {
    BRIDGE_WS_PORT: String(wsPort), BRIDGE_HTTP_PORT: String(httpPort), BRIDGE_STATE_DIR: stateDir,
    BRIDGE_ALLOW_SCRIPT: "0", BRIDGE_REUSE_TOKEN: "0"
  }, extraEnv || {});
  const broker = spawn(process.execPath, [path.join(ROOT, "broker/server.js")].concat(extraArgs || []), { env, stdio: ["ignore", "pipe", "pipe"] });
  children.push(broker);
  let out = "";
  broker.stdout.on("data", (c) => (out += c));
  broker.stderr.on("data", (c) => (out += c));
  const tokenFile = path.join(stateDir, ".token");
  // .token が書かれる＝両ポートの待ち受け完了
  for (let i = 0; i < 100 && !fs.existsSync(tokenFile); i++) await sleep(50);
  if (!fs.existsSync(tokenFile)) throw new Error(label + ": broker did not start\n" + out);
  const token = fs.readFileSync(tokenFile, "utf8").trim();
  const mock = spawn(process.execPath, [path.join(ROOT, "broker/mock-plugin.js")], { env, stdio: "ignore" });
  children.push(mock);
  for (let i = 0; i < 100; i++) {
    const s = await request(httpPort, token, "GET", "/status");
    if (s.json && s.json.plugin_connected) break;
    await sleep(50);
  }
  return { label, wsPort, httpPort, token, stateDir, logs: () => out };
}

async function brokerTests() {
  const off = await startBroker("default");
  const on = await startBroker("allow-flag", ["--allow-script"]);
  const onEnv = await startBroker("allow-env", [], { BRIDGE_ALLOW_SCRIPT: "1" });

  await test("broker: test brokers never use the resident ports 3055/3056", () => {
    for (const b of [off, on, onEnv]) {
      assert.ok(!RESIDENT_PORTS.includes(b.wsPort) && !RESIDENT_PORTS.includes(b.httpPort), JSON.stringify(b));
    }
  });

  await test("broker: /status reports allow_script and plugin_connected", async () => {
    const s0 = await request(off.httpPort, off.token, "GET", "/status");
    assert.strictEqual(s0.status, 200);
    assert.strictEqual(s0.json.allow_script, false);
    assert.strictEqual(s0.json.plugin_connected, true);
    const s1 = await request(on.httpPort, on.token, "GET", "/status");
    assert.strictEqual(s1.json.allow_script, true);
    assert.strictEqual(s1.json.plugin_connected, true);
    const s2 = await request(onEnv.httpPort, onEnv.token, "GET", "/status");
    assert.strictEqual(s2.json.allow_script, true, "BRIDGE_ALLOW_SCRIPT=1");
  });

  await test("broker: startup log states allow_script", () => {
    assert.ok(/allow_script: false/.test(off.logs()), off.logs());
    assert.ok(/allow_script: true/.test(on.logs()), on.logs());
  });

  await test("(a) broker default: script.run -> 403 script_disabled (not forwarded)", async () => {
    const r = await request(off.httpPort, off.token, "POST", "/rpc", { method: "script.run", params: { code: "return 1" } });
    assert.strictEqual(r.status, 403);
    assert.deepStrictEqual(r.json, { ok: false, error: "script_disabled", message: "start the broker with --allow-script or BRIDGE_ALLOW_SCRIPT=1" });
    const log = fs.readFileSync(path.join(off.stateDir, "bridge.log"), "utf8");
    assert.ok(!/rpc -> script\.run/.test(log), "must not be forwarded to the plugin");
  });

  await test("(a') broker default: bad token still 401 before the gate", async () => {
    const r = await request(off.httpPort, "0".repeat(32), "POST", "/rpc", { method: "script.run", params: { code: "return 1" } });
    assert.strictEqual(r.status, 401);
    assert.strictEqual(r.json.error, "bad_token");
  });

  await test("(b) broker --allow-script: script.run is forwarded to the plugin (mock echo)", async () => {
    const params = { code: "return figma.currentPage.name", args: { a: 1 }, timeoutMs: 1234 };
    for (const b of [on, onEnv]) {
      const r = await request(b.httpPort, b.token, "POST", "/rpc", { method: "script.run", params });
      assert.strictEqual(r.status, 200, b.label);
      assert.deepStrictEqual(r.json, { ok: true, method: "script.run", data: { mock: true, script: true, echo: params } }, b.label);
    }
  });

  await test("(c) existing methods pass regardless of allow_script", async () => {
    for (const b of [off, on]) {
      for (const m of ["selection.get", "fonts.probe", "node.get"]) {
        const r = await request(b.httpPort, b.token, "POST", "/rpc", { method: m, params: { nodeId: "1:2" } });
        assert.strictEqual(r.status, 200, b.label + " " + m);
        assert.deepStrictEqual(r.json, { ok: true, method: m, data: { mock: true, params: { nodeId: "1:2" } } }, b.label + " " + m);
      }
    }
  });

  await test("(c') HTTP body limit 2MB unchanged (413) on both brokers", async () => {
    const big = JSON.stringify({ method: "script.run", params: { code: "x".repeat(2 * 1024 * 1024 + 10) } });
    for (const b of [off, on]) {
      const r = await request(b.httpPort, b.token, "POST", "/rpc", big).catch((e) => ({ status: "conn-error:" + e.code }));
      // 413 が返るか、上限超過で接続が切られる（従来と同じ挙動）
      assert.ok(r.status === 413 || /^conn-error/.test(String(r.status)), b.label + " got " + r.status);
    }
  });

  await test("(c'') method_required / bad_json unchanged", async () => {
    const r1 = await request(on.httpPort, on.token, "POST", "/rpc", {});
    assert.strictEqual(r1.status, 400); assert.strictEqual(r1.json.error, "method_required");
    const r2 = await request(on.httpPort, on.token, "POST", "/rpc", "{not json");
    assert.strictEqual(r2.status, 400); assert.strictEqual(r2.json.error, "bad_json");
  });
}

// ---------- C. plugin/code.js を vm で実行 ----------

// code.js を読み込んだ仮想プラグイン環境を作る
function loadPlugin() {
  const posted = [];
  const waiters = new Map();
  const mixed = Symbol("figma.mixed");
  const text = {
    id: "1:2", name: "Title", type: "TEXT", x: 10, y: 20, width: 100, height: 30,
    characters: "hello", fontName: { family: "Inter", style: "Regular" }, parent: null,
    getRangeAllFontNames: () => [{ family: "Inter", style: "Regular" }],
    exportAsync: async () => new Uint8Array([1, 2, 3])
  };
  const loaded = [];
  const figma = {
    mixed,
    root: { name: "TestFile" },
    currentPage: { name: "Page 1", selection: [text], findAll: (fn) => [text].filter(fn) },
    showUI: () => {},
    ui: {
      onmessage: null,
      postMessage: (m) => {
        posted.push(m);
        if (m && m.type === "rpc_result" && waiters.has(m.id)) { waiters.get(m.id)(m.result); waiters.delete(m.id); }
      }
    },
    clientStorage: { getAsync: async () => null, setAsync: async () => {}, deleteAsync: async () => {} },
    getNodeByIdAsync: async (id) => (id === text.id ? text : null),
    loadFontAsync: async (f) => { loaded.push(f.family + "/" + f.style); },
    listAvailableFontsAsync: async () => [{ fontName: { family: "Inter", style: "Regular" } }],
    base64Encode: (bytes) => Buffer.from(bytes).toString("base64"),
    closePlugin: () => {}
  };
  const ctx = vm.createContext({ figma, __html__: "<html></html>", setTimeout, clearTimeout, console });
  vm.runInContext(fs.readFileSync(path.join(ROOT, "plugin/code.js"), "utf8"), ctx, { filename: "plugin/code.js" });
  let seq = 0;
  function rpc(method, params) {
    const id = "t" + (++seq);
    return new Promise((resolve) => {
      waiters.set(id, resolve);
      figma.ui.onmessage({ type: "rpc", id, method, params });
    });
  }
  return { rpc, figma, text, loaded, posted };
}

async function pluginTests() {
  const P = loadPlugin();
  const run = (code, extra) => P.rpc("script.run", Object.assign({ code }, extra || {}));

  await test("plugin: script.run returns value; receives figma / args / helpers", async () => {
    const r = await run("return { page: figma.currentPage.name, args, helpers: Object.keys(helpers).sort() }", { args: { n: 3 } });
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.strictEqual(r.method, "script.run");
    // vm の別 realm で作られた値なので JSON 経由で比較する
    assert.deepStrictEqual(JSON.parse(JSON.stringify(r.data)), {
      page: "Page 1", args: { n: 3 },
      helpers: ["boundsOf", "exportPng", "fontsOf", "getNode", "loadFontsOf"]
    });
  });

  await test("plugin: example from README (all TEXT bounds) works with helpers", async () => {
    const r = await run('return figma.currentPage.findAll(n => n.type === "TEXT").map(n => helpers.boundsOf(n))');
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.deepStrictEqual(JSON.parse(JSON.stringify(r.data)), [{ id: "1:2", name: "Title", x: 10, y: 20, width: 100, height: 30 }]);
  });

  await test("plugin: helpers.getNode / loadFontsOf / exportPng reuse existing internals", async () => {
    const r = await run('const n = await helpers.getNode("1:2", "TEXT"); const f = await helpers.loadFontsOf(n); const png = await helpers.exportPng(n, 2); const png2 = await helpers.exportPng("1:2"); return { f, b64: png.base64, scale: png.scale, s2: png2.scale }');
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.deepStrictEqual(JSON.parse(JSON.stringify(r.data)), { f: [{ family: "Inter", style: "Regular" }], b64: "AQID", scale: 2, s2: 1 });
    assert.ok(P.loaded.includes("Inter/Regular"));
  });

  await test("plugin: result is JSON-safe (circular / BigInt / undefined / function / mixed / node / typed array)", async () => {
    const r = await run([
      "const a = { name: 'a' }; a.self = a;",
      "const shared = { v: 1 };",
      "const node = Object.create({ id: '9:9', type: 'FRAME', name: 'F', parent: null });",
      "return { a, big: 10n, u: undefined, fn() {}, arr: [1, undefined, () => 1, 2n], mixed: figma.mixed,",
      "  node, bytes: new Uint8Array([7, 8]), twice: [shared, shared], nan: NaN, date: new Date(0), err: new TypeError('boom') }"
    ].join("\n"));
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.deepStrictEqual(JSON.parse(JSON.stringify(r.data)), {
      a: { name: "a", self: "[Circular]" }, big: "10", arr: [1, null, null, "2"], mixed: "MIXED",
      node: { id: "9:9", type: "FRAME", name: "F" }, bytes: [7, 8], twice: [{ v: 1 }, { v: 1 }], nan: null,
      date: "1970-01-01T00:00:00.000Z", err: { name: "TypeError", message: "boom" }
    });
  });

  await test("plugin: undefined return -> data null", async () => {
    const r = await run("const x = 1;");
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.data, null);
  });

  await test("plugin: thrown error -> ok:false script_error with message and stack", async () => {
    const r = await run("throw new RangeError('bad thing')");
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.error, "script_error");
    assert.strictEqual(r.method, "script.run");
    assert.strictEqual(r.message, "bad thing");
    assert.strictEqual(r.name, "RangeError");
    assert.ok(typeof r.stack === "string" && r.stack.length > 0);
  });

  await test("plugin: syntax error -> script_error (plugin keeps running)", async () => {
    const r = await run("return (");
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.error, "script_error");
    assert.strictEqual(r.name, "SyntaxError");
    const r2 = await run("return 42");
    assert.strictEqual(r2.ok, true); assert.strictEqual(r2.data, 42);
  });

  await test("plugin: timeout -> script_timeout, queue continues", async () => {
    const t0 = Date.now();
    const r = await run("await new Promise(() => {})", { timeoutMs: 150 });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.error, "script_timeout");
    assert.strictEqual(r.timeoutMs, 150);
    assert.ok(Date.now() - t0 < 2000);
    const r2 = await P.rpc("selection.get", {});
    assert.strictEqual(r2.ok, true);
  });

  await test("plugin: invalid timeoutMs -> handler_error", async () => {
    for (const t of [0, -1, "10", 600001, Infinity]) {
      const r = await run("return 1", { timeoutMs: t });
      assert.strictEqual(r.ok, false, String(t));
      assert.strictEqual(r.error, "handler_error", String(t));
    }
    const ok = await run("return 1", { timeoutMs: 600000 });
    assert.strictEqual(ok.ok, true);
  });

  await test("(d) plugin: code over 200KB -> code_too_large (exactly 200KB is accepted)", async () => {
    const limit = 200 * 1024;
    const exact = "//" + "x".repeat(limit - 2 - "\nreturn 1".length) + "\nreturn 1";
    assert.strictEqual(Buffer.byteLength(exact), limit);
    const r0 = await run(exact);
    assert.strictEqual(r0.ok, true, JSON.stringify(r0).slice(0, 200));
    const over = exact + " ";
    const r1 = await run(over);
    assert.strictEqual(r1.ok, false);
    assert.strictEqual(r1.error, "code_too_large");
    assert.strictEqual(r1.limit, limit);
    assert.strictEqual(r1.bytes, limit + 1);
    // マルチバイト文字は UTF-8 バイトで数える（3バイト × 70,000 = 210,000 > 204,800）
    const r2 = await run("//" + "あ".repeat(70000) + "\nreturn 1");
    assert.strictEqual(r2.error, "code_too_large");
  });

  await test("(d) plugin: result over 2MB -> result_too_large", async () => {
    const r = await run("return 'x'.repeat(2 * 1024 * 1024)");   // JSON では前後の引用符で +2 バイト
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.error, "result_too_large");
    assert.strictEqual(r.limit, 2 * 1024 * 1024);
    assert.strictEqual(r.bytes, 2 * 1024 * 1024 + 2);
    const ok = await run("return 'x'.repeat(2 * 1024 * 1024 - 2)");
    assert.strictEqual(ok.ok, true);
  });

  await test("plugin: missing code -> handler_error", async () => {
    const r = await P.rpc("script.run", {});
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.error, "handler_error");
  });

  await test("plugin regression: existing methods unchanged (node.get / node.export / unknown_method)", async () => {
    const g = await P.rpc("node.get", { nodeId: "1:2" });
    assert.strictEqual(g.ok, true);
    assert.strictEqual(g.data.characters, "hello");
    const e = await P.rpc("node.export", { nodeId: "1:2" });
    assert.deepStrictEqual(JSON.parse(JSON.stringify(e)), {
      ok: true, method: "node.export",
      data: { node: { id: "1:2", name: "Title", x: 10, y: 20, width: 100, height: 30 }, format: "PNG", scale: 1, bytes: 3, base64: "AQID" }
    });
    const bad = await P.rpc("node.export", { nodeId: "1:2", scale: 9 });
    assert.deepStrictEqual(JSON.parse(JSON.stringify(bad)), { ok: false, error: "handler_error", method: "node.export", message: "scale は 0〜8" });
    const missing = await P.rpc("node.get", { nodeId: "0:0" });
    assert.strictEqual(missing.error, "handler_error");
    const u = await P.rpc("nope.nothing", {});
    assert.strictEqual(u.error, "unknown_method");
    assert.ok(u.available.includes("script.run") && u.available.includes("node.export"));
  });
}

// ---------- 実行 ----------
(async () => {
  try {
    await gateTests();
    await brokerTests();
    await pluginTests();
  } catch (e) {
    results.push({ name: "setup", ok: false });
    console.log("FAIL - setup\n       " + (e && e.stack ? e.stack : e));
  } finally {
    for (const c of children) { try { c.kill("SIGTERM"); } catch {} }
    await sleep(100);
    for (const d of tempDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
  }
  const failed = results.filter((r) => !r.ok).length;
  console.log("\n" + (results.length - failed) + "/" + results.length + " passed");
  process.exit(failed ? 1 : 0);
})();
