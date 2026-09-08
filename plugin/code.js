// Local Font Bridge — code.js
// 役割: UI(iframe) 経由で届く RPC を Plugin API で実行する。
//   ここは Figma デスクトップのローカル環境なので、ローカルフォント（Mizolet / New Rubrik Edge /
//   A1 Mincho など）が listAvailableFontsAsync に出て loadFontAsync も成功する（probe で実証済み）。
// 安全策:
//   - 実行できるメソッドは下の HANDLERS に列挙したものだけ（eval は無し）
//   - 対象は「今開いているファイルの、指定 nodeId のノード」だけ
//   - リクエストは1件ずつ直列に処理する（同時実行でドキュメントが壊れないように）
//   - 例外は投げずにエラーオブジェクトで返す（プラグインを落とさない）

figma.showUI(__html__, { width: 340, height: 300 });

// ---------- 上限値（暴走防止） ----------
const MAX_CHARS = 20000;        // setCharacters の最大文字数
const MAX_EXPORT_PX = 4096;     // 書き出し1辺の最大px
const MAX_EXPORT_BYTES = 8 * 1024 * 1024; // 書き出しBase64前のバイト上限

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

  // PNG 書き出し（Base64）
  "node.export": async (p) => {
    const node = await getNode(p.nodeId);
    if (typeof node.exportAsync !== "function") throw new Error("このノードは書き出せません");
    const scale = typeof p.scale === "number" ? p.scale : 1;
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
        result = { ok: false, error: "handler_error", method: method, message: String(e && e.message ? e.message : e) };
      }
    }
    figma.ui.postMessage({ type: "rpc_result", id: id, result: result });
  });
}

figma.ui.onmessage = (msg) => {
  if (!msg || typeof msg !== "object") return;
  if (msg.type === "rpc") enqueue(msg.id, msg.method, msg.params);
  if (msg.type === "close") figma.closePlugin("ブリッジを終了しました");
};
