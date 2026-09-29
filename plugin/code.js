// Local Font Bridge — code.js
// 役割: UI(iframe) 経由で届く RPC を Plugin API で実行する。
//   ここは Figma デスクトップのローカル環境なので、ローカルフォント（Mizolet / New Rubrik Edge /
//   A1 Mincho など）が listAvailableFontsAsync に出て loadFontAsync も成功する（probe で実証済み）。
// 安全策:
//   - 実行できるメソッドは下の HANDLERS に列挙したものだけ
//   - 例外は script.run（任意の Plugin API コードを実行する）。これは opt-in で、
//     ブローカー側で既定拒否（--allow-script / BRIDGE_ALLOW_SCRIPT=1 のときだけ転送される）
//   - 対象は「今開いているファイルの、指定 nodeId のノード」だけ（script.run を除く）
//   - リクエストは1件ずつ直列に処理する（同時実行でドキュメントが壊れないように）
//   - 例外は投げずにエラーオブジェクトで返す（プラグインを落とさない）

figma.showUI(__html__, { width: 340, height: 330 });

// ---------- 上限値（暴走防止） ----------
const MAX_CHARS = 20000;        // setCharacters の最大文字数
const MAX_EXPORT_PX = 4096;     // 書き出し1辺の最大px
const MAX_EXPORT_BYTES = 8 * 1024 * 1024; // 書き出しBase64前のバイト上限
const MAX_SCRIPT_CODE_BYTES = 200 * 1024;         // script.run の code の上限（UTF-8 バイト）
const MAX_SCRIPT_RESULT_BYTES = 2 * 1024 * 1024;  // script.run の戻り値（JSON 化後）の上限
const SCRIPT_TIMEOUT_MS = 60000;                  // script.run のタイムアウト既定値
const MAX_SCRIPT_TIMEOUT_MS = 600000;             // timeoutMs として指定できる最大値（10分）
const MAX_RESULT_DEPTH = 100;                     // 戻り値をたどる深さの上限（無限再帰の防止）

// ---------- 共通ユーティリティ ----------

// nodeId から TEXT ノードを取得（型チェック付き）
async function getNode(nodeId, expectType) {
  if (!nodeId || typeof nodeId !== "string") throw new Error("nodeId が必要です");
  const node = await figma.getNodeByIdAsync(nodeId);
  if (!node) throw new Error("nodeId が見つかりません: " + nodeId + "（別ファイルを開いている可能性）");
  if (expectType && node.type !== expectType) {
    throw new Error("ノードの型が " + node.type + " です（期待: " + expectType + "）");
  }
  return node;
}

// テキストノードが使う全フォント（混在含む）
function fontsOf(textNode) {
  if (textNode.characters.length > 0) {
    return textNode.getRangeAllFontNames(0, textNode.characters.length);
  }
  return textNode.fontName === figma.mixed ? [] : [textNode.fontName];
}

// 編集前に必要なフォントを全部ロードする（これを忘れると Plugin API が失敗する）
async function loadFontsOf(textNode) {
  const fonts = fontsOf(textNode);
  for (const f of fonts) await figma.loadFontAsync(f);
  return fonts;
}

// 返り値に共通で入れるノード情報
function boundsOf(node) {
  return {
    id: node.id,
    name: node.name,
    x: Math.round(node.x * 100) / 100,
    y: Math.round(node.y * 100) / 100,
    width: Math.round(node.width * 100) / 100,
    height: Math.round(node.height * 100) / 100
  };
}

function serializeFont(f) {
  return f === figma.mixed ? "MIXED" : { family: f.family, style: f.style };
}
function serializeValue(v) {
  return v === figma.mixed ? "MIXED" : v;
}

// ノードを PNG に書き出して Base64 で返す（node.export と script.run の helpers.exportPng で共用）
async function exportPng(node, scaleIn) {
  if (typeof node === "string") node = await getNode(node);   // helpers から nodeId で呼ばれた場合
  if (!node || typeof node.exportAsync !== "function") throw new Error("このノードは書き出せません");
  const scale = typeof scaleIn === "number" ? scaleIn : 1;
  if (scale <= 0 || scale > 8) throw new Error("scale は 0〜8");
  const w = node.width * scale, h = node.height * scale;
  if (w > MAX_EXPORT_PX || h > MAX_EXPORT_PX) {
    throw new Error("書き出しサイズが上限(" + MAX_EXPORT_PX + "px)を超えます: " + Math.round(w) + "x" + Math.round(h));
  }
  const bytes = await node.exportAsync({ format: "PNG", constraint: { type: "SCALE", value: scale } });
  if (bytes.length > MAX_EXPORT_BYTES) throw new Error("書き出しデータが8MBを超えました");
  return {
    node: boundsOf(node), format: "PNG", scale: scale,
    bytes: bytes.length, base64: figma.base64Encode(bytes)
  };
}

// ---------- script.run 用ユーティリティ ----------

// 決まったエラーコードで返したいときに投げる（enqueue が ok:false の返り値に変換する）
function rpcError(code, message, extra) {
  const e = new Error(message);
  e.rpcError = Object.assign({ error: code, message: message }, extra || {});
  return e;
}

// スクリプト内で起きた例外を script_error に包む（stack は長すぎないよう切る）
function scriptError(e) {
  const message = String(e && e.message ? e.message : e);
  const stack = e && typeof e.stack === "string" ? e.stack.slice(0, 4000) : null;
  return rpcError("script_error", message, { name: e && e.name ? String(e.name) : null, stack: stack });
}

// 文字列の UTF-8 バイト数を数える（プラグイン環境に TextEncoder が無い場合でも動くよう手計算）
function utf8ByteLength(str) {
  let bytes = 0;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    if (c < 0x80) bytes += 1;
    else if (c < 0x800) bytes += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < str.length) {
      const d = str.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) { bytes += 4; i++; } else bytes += 3;   // サロゲートペア=4バイト
    } else bytes += 3;
  }
  return bytes;
}

// Figma のノードらしいオブジェクトか（プロパティが getter なので JSON にすると {} になってしまう）
function looksLikeNode(v) {
  try { return typeof v.id === "string" && typeof v.type === "string" && "parent" in v && Object.keys(v).length === 0; }
  catch (e) { return false; }
}

// スクリプトの戻り値を JSON で安全に送れる形に変える
//   循環参照 → "[Circular]" / BigInt → 文字列 / undefined・関数・Symbol → 落とす（配列内は null）
//   figma.mixed → "MIXED" / ノード → {id,type,name} / Date → ISO文字列 / Error → {name,message}
//   Uint8Array 等 → 数値配列 / 深すぎる入れ子 → "[MaxDepth]" / 読めない getter → "[Unreadable]"
const SKIP = {};   // 「この値は落とす」目印
function toJsonSafe(value, ancestors) {
  ancestors = ancestors || [];
  if (typeof figma !== "undefined" && value === figma.mixed) return "MIXED";
  if (value === null) return null;
  const t = typeof value;
  if (t === "undefined" || t === "function" || t === "symbol") return SKIP;
  if (t === "bigint") return value.toString();
  if (t === "number") return Number.isFinite(value) ? value : null;
  if (t === "string" || t === "boolean") return value;
  // ここから object
  if (ancestors.indexOf(value) >= 0) return "[Circular]";
  if (ancestors.length >= MAX_RESULT_DEPTH) return "[MaxDepth]";
  if (value instanceof Date) return isNaN(value.getTime()) ? null : value.toISOString();
  if (value instanceof Error) return { name: String(value.name), message: String(value.message) };
  if (ArrayBuffer.isView(value)) return Array.from(value, (n) => (typeof n === "bigint" ? n.toString() : n));
  if (looksLikeNode(value)) return { id: value.id, type: value.type, name: value.name };
  const next = ancestors.concat([value]);
  if (Array.isArray(value)) {
    return value.map((item) => { const s = toJsonSafe(item, next); return s === SKIP ? null : s; });
  }
  if (typeof value.toJSON === "function") {
    try { return toJsonSafe(value.toJSON(), next); } catch (e) { return "[Unreadable]"; }
  }
  const out = {};
  for (const key of Object.keys(value)) {
    let v;
    try { v = value[key]; } catch (e) { out[key] = "[Unreadable]"; continue; }
    const s = toJsonSafe(v, next);
    if (s !== SKIP) out[key] = s;
  }
  return out;
}

// 戻り値を JSON 安全化し、サイズ上限（2MB）を確認する
function prepareScriptResult(value) {
  let safe = toJsonSafe(value);
  if (safe === SKIP) safe = null;   // 何も返さなかった（undefined）なら null
  const bytes = utf8ByteLength(JSON.stringify(safe));
  if (bytes > MAX_SCRIPT_RESULT_BYTES) {
    throw rpcError("result_too_large", "戻り値が上限(" + MAX_SCRIPT_RESULT_BYTES + " bytes)を超えました: " + bytes + " bytes",
      { bytes: bytes, limit: MAX_SCRIPT_RESULT_BYTES });
  }
  return safe;
}

// params.timeoutMs を検証する（未指定なら既定 60 秒）
function scriptTimeoutOf(p) {
  if (p.timeoutMs === undefined || p.timeoutMs === null) return SCRIPT_TIMEOUT_MS;
  if (typeof p.timeoutMs !== "number" || !Number.isFinite(p.timeoutMs) || p.timeoutMs <= 0 || p.timeoutMs > MAX_SCRIPT_TIMEOUT_MS) {
    throw new Error("timeoutMs は 1〜" + MAX_SCRIPT_TIMEOUT_MS + " の数値で指定してください");
  }
  return p.timeoutMs;
}

// スクリプトに渡す便利関数（既存の内部関数をそのまま公開）
const SCRIPT_HELPERS = Object.freeze({
  getNode: getNode,           // (nodeId, expectType?) → ノード
  loadFontsOf: loadFontsOf,   // (textNode) → 使用フォントを全ロードして配列で返す
  fontsOf: fontsOf,           // (textNode) → 使用フォントの配列（ロードはしない）
  boundsOf: boundsOf,         // (node) → {id,name,x,y,width,height}
  exportPng: exportPng        // (node か nodeId, scale?) → {node,format,scale,bytes,base64}
});

// async 関数を文字列から作るためのコンストラクタ（new Function の async 版）
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

// ---------- RPC ハンドラ ----------

const HANDLERS = {
  // 環境診断: 利用可能フォント数と、関心のあるファミリの有無
  "fonts.probe": async (p) => {
    const available = await figma.listAvailableFontsAsync();
    const families = Array.from(new Set(available.map((f) => f.fontName.family)));
    const pattern = p && p.match ? new RegExp(p.match, "i")
      : /mizolet|rubrik|a1|mincho|明朝|hiragino|ヒラギノ|游|yu gothic/i;
    const matched = available
      .filter((f) => pattern.test(f.fontName.family))
      .map((f) => f.fontName.family + " / " + f.fontName.style);
    return {
      total_fonts: available.length,
      total_families: families.length,
      matched_count: matched.length,
      matched: matched.slice(0, 300),
      file_name: figma.root.name,
      page_name: figma.currentPage.name
    };
  },

  // ノードの現在状態を読む（テキストなら書体情報も）
  "node.get": async (p) => {
    const node = await getNode(p.nodeId);
    const out = Object.assign({ type: node.type }, boundsOf(node));
    if (node.type === "TEXT") {
      out.characters = node.characters;
      out.char_count = node.characters.length;
      out.fontName = serializeFont(node.fontName);
      out.fonts = fontsOf(node).map((f) => ({ family: f.family, style: f.style }));
      out.fontSize = serializeValue(node.fontSize);
      out.lineHeight = serializeValue(node.lineHeight);
      out.letterSpacing = serializeValue(node.letterSpacing);
      out.textAutoResize = node.textAutoResize;
      out.textAlignHorizontal = node.textAlignHorizontal;
    }
    return out;
  },

  // 幅を決めて折り返しを確定させる（高さは自動）
  "text.reflow": async (p) => {
    const node = await getNode(p.nodeId, "TEXT");
    const before = boundsOf(node);
    await loadFontsOf(node);
    const mode = p.autoResize || "HEIGHT";
    if (!["HEIGHT", "NONE", "WIDTH_AND_HEIGHT", "TRUNCATE"].includes(mode)) {
      throw new Error("autoResize の値が不正です: " + mode);
    }
    // 幅を指定するときは、まず自動幅を切ってからリサイズする
    if (typeof p.width === "number") {
      if (p.width <= 0 || p.width > 100000) throw new Error("width が範囲外です");
      node.textAutoResize = mode === "WIDTH_AND_HEIGHT" ? "HEIGHT" : mode;
      node.resize(p.width, node.height);
    }
    node.textAutoResize = mode;
    return { before: before, after: boundsOf(node), textAutoResize: node.textAutoResize };
  },

  // 文字サイズ・行送りを変える
  "text.setStyle": async (p) => {
    const node = await getNode(p.nodeId, "TEXT");
    const before = boundsOf(node);
    await loadFontsOf(node);
    if (typeof p.fontSize === "number") {
      if (p.fontSize < 1 || p.fontSize > 2000) throw new Error("fontSize が範囲外です（1〜2000）");
      node.fontSize = p.fontSize;
    }
    if (p.lineHeight) {
      const lh = p.lineHeight;
      if (lh.unit === "AUTO") node.lineHeight = { unit: "AUTO" };
      else if (lh.unit === "PIXELS" || lh.unit === "PERCENT") {
        if (typeof lh.value !== "number") throw new Error("lineHeight.value が必要です");
        node.lineHeight = { value: lh.value, unit: lh.unit };
      } else throw new Error("lineHeight.unit は AUTO / PIXELS / PERCENT のいずれか");
    }
    if (typeof p.letterSpacing === "object" && p.letterSpacing) {
      node.letterSpacing = { value: p.letterSpacing.value, unit: p.letterSpacing.unit || "PERCENT" };
    }
    return {
      before: before, after: boundsOf(node),
      fontSize: serializeValue(node.fontSize), lineHeight: serializeValue(node.lineHeight)
    };
  },

  // 本物のフォントへ差し替える（仮置きフォントからの復帰用）
  "text.setFont": async (p) => {
    const node = await getNode(p.nodeId, "TEXT");
    if (!p.family || !p.style) throw new Error("family と style が必要です");
    const target = { family: p.family, style: p.style };
    const before = boundsOf(node);
    const beforeFonts = fontsOf(node).map((f) => f.family + " / " + f.style);
    await loadFontsOf(node);          // 既存フォントもロードしてから触る
    await figma.loadFontAsync(target); // ここで失敗すればフォントが無いということ
    node.fontName = target;
    return {
      before: before, after: boundsOf(node),
      before_fonts: beforeFonts,
      after_font: serializeFont(node.fontName),
      warning: beforeFonts.length > 1 ? "元が混在スタイルだったため全文が単一フォントに統一されました" : null
    };
  },

  // 本文を丸ごと差し替える
  "text.setCharacters": async (p) => {
    const node = await getNode(p.nodeId, "TEXT");
    if (typeof p.characters !== "string") throw new Error("characters（文字列）が必要です");
    if (p.characters.length > MAX_CHARS) throw new Error("文字数が上限(" + MAX_CHARS + ")を超えています");
    const before = boundsOf(node);
    const fonts = await loadFontsOf(node);
    node.characters = p.characters;
    return {
      before: before, after: boundsOf(node), char_count: node.characters.length,
      warning: fonts.length > 1 ? "元が混在スタイルだったため、置換後は先頭スタイルに寄る可能性があります" : null
    };
  },

  // PNG 書き出し（Base64）。中身は exportPng（script.run の helpers と共通）
  "node.export": async (p) => {
    const node = await getNode(p.nodeId);
    return exportPng(node, p.scale);
  },

  // 位置を動かす（テキスト以外にも使える）
  "node.move": async (p) => {
    const node = await getNode(p.nodeId);
    if (typeof p.x !== "number" || typeof p.y !== "number") throw new Error("x と y が必要です");
    node.x = p.x; node.y = p.y;
    return boundsOf(node);
  },

  // サイズを変える
  "node.resize": async (p) => {
    const node = await getNode(p.nodeId);
    if (typeof p.w !== "number" || typeof p.h !== "number") throw new Error("w と h が必要です");
    if (p.w <= 0 || p.h <= 0 || p.w > 100000 || p.h > 100000) throw new Error("w/h が範囲外です");
    if (node.type === "TEXT") {
      await loadFontsOf(node);
      if (node.textAutoResize !== "NONE") node.textAutoResize = "NONE";
    }
    node.resize(p.w, p.h);
    return boundsOf(node);
  },

  // 現在の選択を返す（nodeId を知るための入口）
  "selection.get": async () => {
    return {
      file_name: figma.root.name,
      page_name: figma.currentPage.name,
      selection: figma.currentPage.selection.map((n) => Object.assign({ type: n.type }, boundsOf(n)))
    };
  },

  // 任意の Plugin API コードを実行する（opt-in。ブローカーが既定で拒否するので、許可したときだけ届く）
  //   params: { code: 関数本文の文字列, args?: 任意の値, timeoutMs?: 既定 60000 }
  //   code は async function (figma, args, helpers) { ...code... } として実行され、return した値が data になる
  "script.run": async (p) => {
    if (typeof p.code !== "string" || p.code.trim() === "") throw new Error("code（文字列）が必要です");
    const codeBytes = utf8ByteLength(p.code);
    if (codeBytes > MAX_SCRIPT_CODE_BYTES) {
      throw rpcError("code_too_large", "code が上限(" + MAX_SCRIPT_CODE_BYTES + " bytes)を超えています: " + codeBytes + " bytes",
        { bytes: codeBytes, limit: MAX_SCRIPT_CODE_BYTES });
    }
    const timeoutMs = scriptTimeoutOf(p);

    // 文字列から関数を作る（構文エラーはここで script_error になる）
    let fn;
    try { fn = new AsyncFunction("figma", "args", "helpers", p.code); }
    catch (e) { throw scriptError(e); }

    // 実行とタイムアウトを競争させる（時間切れでもスクリプト自体は止められないので、結果を待たずに返す）
    let timer = null;
    const timeout = new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(rpcError("script_timeout", "スクリプトが " + timeoutMs + "ms 以内に終わりませんでした",
        { timeoutMs: timeoutMs })), timeoutMs);
    });
    let value;
    try {
      value = await Promise.race([Promise.resolve().then(() => fn(figma, p.args, SCRIPT_HELPERS)), timeout]);
    } catch (e) {
      throw e && e.rpcError ? e : scriptError(e);
    } finally {
      clearTimeout(timer);
    }
    return prepareScriptResult(value);
  }
};

// ---------- 直列キュー ----------
// 同時に複数のリクエストを処理しないよう、Promise チェーンで1件ずつ流す
let queue = Promise.resolve();

function enqueue(id, method, params) {
  queue = queue.then(async () => {
    let result;
    const handler = HANDLERS[method];
    if (!handler) {
      result = { ok: false, error: "unknown_method", method: method, available: Object.keys(HANDLERS) };
    } else {
      try {
        const data = await handler(params || {});
        result = { ok: true, method: method, data: data };
      } catch (e) {
        if (e && e.rpcError) {
          // 決まったエラーコード付きの失敗（script.run の script_error / script_timeout / *_too_large など）
          result = Object.assign({ ok: false, method: method }, e.rpcError);
        } else {
          result = { ok: false, error: "handler_error", method: method, message: String(e && e.message ? e.message : e) };
        }
      }
    }
    figma.ui.postMessage({ type: "rpc_result", id: id, result: result });
  });
}

figma.ui.onmessage = (msg) => {
  if (!msg || typeof msg !== "object") return;
  if (msg.type === "rpc") enqueue(msg.id, msg.method, msg.params);
  if (msg.type === "close") figma.closePlugin("ブリッジを終了しました");
  if (msg.type === "settings_load") loadSettings();
  if (msg.type === "settings_save") saveSettings(msg.remember, msg.token);
};

// ---------- トークンの記憶（opt-in） ----------
// 「トークンを記憶する」が ON のときだけ figma.clientStorage（このMacのFigma内・このプラグイン専用）に保存する。
// OFF にしたら保存済みのトークンは消す。
const STORAGE_KEY = "bridge_token";

// 保存済みトークンを UI に渡す（無ければ null）
async function loadSettings() {
  let token = null;
  try { token = await figma.clientStorage.getAsync(STORAGE_KEY); } catch (e) {}
  const valid = typeof token === "string" && /^[0-9a-f]{32}$/.test(token);
  figma.ui.postMessage({ type: "settings", remember: valid, token: valid ? token : null });
}

// 記憶する/しないを反映する
async function saveSettings(remember, token) {
  try {
    if (remember && typeof token === "string" && /^[0-9a-f]{32}$/.test(token)) {
      await figma.clientStorage.setAsync(STORAGE_KEY, token);
    } else {
      await figma.clientStorage.deleteAsync(STORAGE_KEY);
    }
  } catch (e) {}
}
