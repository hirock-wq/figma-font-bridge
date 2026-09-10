# figma-font-bridge — ローカルフォントブリッジ

> English: [README.md](README.md)

Figma MCP（`use_figma`）はリモート実行のため、このMacにインストールされたローカルフォント
（Adobe Fonts・購入フォント・OS付属フォント）が見えない。
一方、**Figmaデスクトップの開発者プラグインの中ではローカルフォントが完全に見える**
（診断プラグインで実測: 11,095件・`loadFontAsync` 成功）。

このツールは、その差を埋める「橋」。Claude（このMac上のシェル）から HTTP を叩くと、
ローカルブローカー経由で Figma プラグインにテキスト操作を依頼できる。

```
Claude(Bash/curl) --HTTP 127.0.0.1:3056--> ブローカー --WS 127.0.0.1:3055--> プラグインUI --postMessage--> code.js(Plugin API・フォント可)
```

## 構成

| パス | 役割 |
|---|---|
| `broker/server.js` | ブローカー本体（Node.js・依存パッケージなし） |
| `broker/ws-min.js` | 最小 WebSocket サーバ実装（`ws` パッケージを入れずに済ませるため） |
| `broker/mock-plugin.js` | Figma を起動せず配線だけ検証するモック |
| `broker/.token` | 起動ごとに発行されるトークン（gitignore・600） |
| `broker/bridge.log` | 通信ログ |
| `plugin/manifest.json` `plugin/code.js` `plugin/ui.html` | Figma 開発者プラグイン |

---

## 初回セットアップ（ユーザー操作）

### ① ブローカーを起動（このMacのターミナル）

```bash
cd /path/to/figma-font-bridge  # このリポジトリを置いた場所
node broker/server.js
```

起動すると **トークン（32桁）** が画面に表示される（`broker/.token` にも保存される）。
このターミナルは開いたままにする。

### ② Figma にプラグインを取り込む（初回だけ）

Figmaデスクトップアプリ（日本語UI）で:

1. メニュー（左上のFigmaロゴ）→ **プラグイン** → **開発** → **マニフェストからプラグインをインポート…**
2. このリポジトリの `plugin/manifest.json` を選ぶ
3. これで「Local Font Bridge」が開発版プラグイン一覧に入る

### ③ 対象ファイルを開いてプラグインを起動

作業したい Figma ファイルを開いた状態で
メニュー → **プラグイン** → **開発** → **Local Font Bridge**

### ④ トークンを貼って「接続」

プラグインUIの入力欄に①のトークンを貼り、**接続** を押す。
緑のドット＋「接続済み（待機中）」になれば準備完了。

> プラグインパネルを閉じるとブリッジも切れる。作業中は開いたままにする。

---

## Claude 側からの呼び出し（curl）

```bash
cd /path/to/figma-font-bridge  # このリポジトリを置いた場所
T=$(cat broker/.token)

# 接続確認
curl -s -H "X-Bridge-Token: $T" http://127.0.0.1:3056/status

# フォント環境の診断
curl -s -H "X-Bridge-Token: $T" -H 'content-type: application/json' \
  -d '{"method":"fonts.probe"}' http://127.0.0.1:3056/rpc

# Figmaで選択中のノードの nodeId を知る
curl -s -H "X-Bridge-Token: $T" -H 'content-type: application/json' \
  -d '{"method":"selection.get"}' http://127.0.0.1:3056/rpc

# 幅768で折り返しを確定（高さは自動）
curl -s -H "X-Bridge-Token: $T" -H 'content-type: application/json' \
  -d '{"method":"text.reflow","params":{"nodeId":"123:456","width":768,"autoResize":"HEIGHT"}}' \
  http://127.0.0.1:3056/rpc

# 仮置きフォント → 本物のフォントへ差し替え
curl -s -H "X-Bridge-Token: $T" -H 'content-type: application/json' \
  -d '{"method":"text.setFont","params":{"nodeId":"123:456","family":"Mizolet","style":"Regular"}}' \
  http://127.0.0.1:3056/rpc
```

### メソッド一覧

| method | params | 返り値 |
|---|---|---|
| `fonts.probe` | `match?`（正規表現文字列） | 利用可能フォント数・一致したファミリ一覧・ファイル名 |
| `selection.get` | — | 選択中ノードの id / type / 位置サイズ |
| `node.get` | `nodeId` | 型・位置サイズ、TEXTなら characters / fontName(s) / fontSize / lineHeight / textAutoResize |
| `text.reflow` | `nodeId`, `width?`, `autoResize`（`HEIGHT`\|`NONE`\|`WIDTH_AND_HEIGHT`\|`TRUNCATE`） | before / after の bounds |
| `text.setStyle` | `nodeId`, `fontSize?`, `lineHeight?{value,unit}`, `letterSpacing?` | before / after の bounds と適用値 |
| `text.setFont` | `nodeId`, `family`, `style` | before / after、混在スタイルだった場合の警告 |
| `text.setCharacters` | `nodeId`, `characters` | before / after、混在スタイルの警告 |
| `node.export` | `nodeId`, `scale?`(既定1) | PNG の Base64（4096px/辺・8MB上限） |
| `node.move` | `nodeId`, `x`, `y` | bounds |
| `node.resize` | `nodeId`, `w`, `h` | bounds |

`lineHeight.unit` は `AUTO` / `PIXELS` / `PERCENT`。

返り値は必ず `{"ok":true,"method":...,"data":{...}}` か
`{"ok":false,"error":"...","message":"..."}`。プラグイン側は例外を投げずエラーで返す（落ちない）。

---

## セキュリティ

- WS(3055) / HTTP(3056) はどちらも **127.0.0.1 のみ**にバインド。外部からは接続不可
- 起動ごとにランダムトークンを発行。WS も HTTP も同じトークンを検証する
- プラグインが実行できるのは `code.js` の `HANDLERS` に列挙したメソッドだけ（`eval` は無い）
- 対象は **今開いているファイルの、指定した nodeId のノードのみ**。全体走査や削除の手段は持たせていない
- リクエストは1件ずつ直列処理。文字数（20,000）・書き出しサイズ（4096px / 8MB）・HTTPボディ（2MB）に上限
- トークンは `clientStorage` に保存しない（起動ごとに手貼り）

## つながらないとき

- **トークンは起動ごとに変わる**。ブローカーを再起動したら、古いトークンでは認証に失敗する → `cat broker/.token` で最新を表示してコピーし直す
- プラグインパネルを一度閉じたら、開き直してから最新トークンを貼る（閉じた時点でWS接続は切れている）
- 状態確認: `curl -s -H "X-Bridge-Token: $(cat broker/.token)" http://127.0.0.1:3056/status` — `plugin_connected: true` なら準備完了

## 停止方法

1. Figma のプラグインパネルを閉じる（またはUIの「切断」）
2. ターミナルで `Ctrl+C`（`broker/.token` は次回起動時に上書きされる）

## 配線テスト（Figmaなしで確認したいとき）

```bash
node broker/server.js          # 別ターミナルで起動しておく
node broker/mock-plugin.js     # ダミーのプラグインとして接続
# 上の curl 例が {"ok":true,...,"data":{"mock":true,...}} を返せば配線は正常
```

## 既知の制約

- Figma のプラグインパネルを閉じると切断される（自動再接続はしない／UIの「接続」を押し直す）
- `text.setCharacters` は全文置換。元が混在スタイルだと先頭スタイルに寄る（警告を返す）
- ブローカーに接続できるプラグインは同時に1つ（後から接続したものが有効になる）
