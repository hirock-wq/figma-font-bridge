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
| `broker/script-gate.js` | `script.run` の関所（opt-in 判定。「スクリプトモード（opt-in）」参照） |
| `broker/.token` | 認証トークン（既定は起動ごとに発行・`BRIDGE_REUSE_TOKEN=1` で再利用／gitignore・600） |
| `launchd/` | 常駐用テンプレートと `install.sh`（「常駐運用」参照） |
| `broker/bridge.log` | 通信ログ |
| `plugin/manifest.json` `plugin/code.js` `plugin/ui.html` | Figma 開発者プラグイン |
| `test/script_run.test.js` | スクリプトモードのテスト（Node のみ・Figma 不要・常駐ブローカーに触れない） |

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

## 常駐運用（launchd・任意）

「ブローカー起動 → トークンをコピー → 貼る」を毎回しなくて済むようにする。初回設定後は
**対象ファイルでプラグインを開くだけで自動接続** する。

### 導入（1回だけ）

```bash
cd /path/to/figma-font-bridge
bash launchd/install.sh
```

`launchd/com.example.figma-font-bridge.plist.template` のパス（リポジトリ・`node` の絶対パス（nvm 含む）・
`~/Library/Logs`）を自動で埋めて `~/Library/LaunchAgents/com.<ユーザー名>.figma-font-bridge.plist` を作り、
手動起動中のブローカーを止めてから登録する（`RunAtLoad`＋`KeepAlive`・`ThrottleInterval` 30秒）。
ジョブ名は `BRIDGE_LABEL=...` で変更可。最後にトークンが表示される。

プラグインでトークンを1回だけ貼り、**「トークンを記憶して、次回から自動で接続する」** に
チェックして「接続」。以後はプラグインを開くと自動接続し、ブローカーが再起動しても5秒ごとに再接続する。

### トークン固定（opt-in）

常駐ジョブは `BRIDGE_REUSE_TOKEN=1`（= `node broker/server.js --reuse-token`）で起動する。
既存の正しい `broker/.token` があれば作り直さずに使うので、再起動しても記憶したトークンが無効にならない。
フラグなしの起動は従来どおり（起動ごとに新規発行）。

安全性は実質同等: 両ポートは 127.0.0.1 のみ、`.token` は 600（本人のみ読める）、記憶したトークンは
このMacの Figma 内・このプラグイン専用の `clientStorage` にだけ置かれる。違いは「再起動で失効しない」点。
**トークンを変えたいときは** `broker/.token` を消してジョブを再起動し、新しいトークンを貼り直す。

### 停止・登録解除・再起動

```bash
launchctl bootout gui/$(id -u)/com.$(id -un).figma-font-bridge    # 停止（旧書式: launchctl unload ~/Library/LaunchAgents/com.$(id -un).figma-font-bridge.plist）
bash launchd/install.sh uninstall                                 # 停止＋plist 削除
launchctl kickstart -k gui/$(id -u)/com.$(id -un).figma-font-bridge  # 再起動
```

### 常駐時のトラブルシュート

- 稼働確認: `launchctl list | grep figma-font-bridge`（1列目に PID があれば稼働中）
- ログ: `~/Library/Logs/figma-font-bridge.err.log` / `.out.log` と `broker/bridge.log`
- ログに `port 3056 is already in use`: 別のブローカー（手動起動など）が動いている → それを止める。
  launchd の再試行は最短30秒間隔なので再起動ループにはならない。ポート競合で落ちた側は `broker/.token` を上書きしない
- プラグインに「トークンが違います」: `.token` が消えた／作り直された → `cat broker/.token` を貼り直す
- 接続はできたが別のファイルに効く: 下の「つながらないとき」を参照（接続は1つだけ・最後に接続したものが勝つ）
- リポジトリを移動した／Node を入れ替えたら `bash launchd/install.sh` を再実行

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
| `script.run` | `code`, `args?`, `timeoutMs?`（既定 60000） | スクリプトの戻り値（JSON 安全化済み）— **opt-in・既定では拒否**。「スクリプトモード（opt-in）」参照 |

`lineHeight.unit` は `AUTO` / `PIXELS` / `PERCENT`。

返り値は必ず `{"ok":true,"method":...,"data":{...}}` か
`{"ok":false,"error":"...","message":"..."}`。プラグイン側は例外を投げずエラーで返す（落ちない）。

---

## スクリプトモード（opt-in）

`script.run` は、Figma デスクトップのプラグイン内で任意の Plugin API コード（JavaScript）を実行する。
いわば **ローカル実行版の `use_figma`**。自分のMac上で動くので、クラウド実行の MCP の弱点を避けられる:

- **ローカルフォントが見える**（`listAvailableFontsAsync` / `loadFontAsync` に Adobe Fonts・購入フォント・OS フォントが出る）
- **メタデータ反映のラグが無い**（編集直後の読み取りに即反映。クラウド側は約1分遅れることがある）
- **全ロールバックにならない**（1行ずつその場で反映。途中で失敗しても、それまでの変更は残る）
- **ページ切替の制限が無い**（`documentAccess: "dynamic-page"` なので `await page.loadAsync()` / `figma.setCurrentPageAsync()` が使える）

**既定は OFF**。スクリプトモードを有効にして起動していないブローカーは、`script.run` を HTTP 403
`{"ok":false,"error":"script_disabled",...}` で拒否する。ほかのメソッドは設定に関係なく従来どおり動く。

### 有効化

```bash
node broker/server.js --allow-script            # 手動起動（フラグ）
BRIDGE_ALLOW_SCRIPT=1 node broker/server.js     # 手動起動（環境変数）
BRIDGE_ALLOW_SCRIPT=1 bash launchd/install.sh   # 常駐運用（plist に BRIDGE_ALLOW_SCRIPT=1 を書き込む）
bash launchd/install.sh                         # 付けずに再実行すると無効（0）に戻る
```

ブローカーは起動時に `allow_script: true|false` をログに出し、`/status` にも `"allow_script": true|false` が入る。
常駐運用ではトークンが再利用されるので、入れ直してもプラグインに記憶したトークンはそのまま使える。

### 呼び出し方

`params`: `code`（文字列・必須）、`args`（任意の JSON・省略可）、`timeoutMs`（省略可・既定 60000・最大 600000）。
`code` は `async function (figma, args, helpers) { ... }` の中身として実行される。`return` した値が `data` で返る。

```bash
T=$(cat broker/.token)

# 今のページの全 TEXT ノードの位置サイズを一括取得
curl -s -H "X-Bridge-Token: $T" -H 'content-type: application/json' \
  -d '{"method":"script.run","params":{"code":"return figma.currentPage.findAll(n => n.type === \"TEXT\").map(n => helpers.boundsOf(n))"}}' \
  http://127.0.0.1:3056/rpc

# 引数を渡す例: 1つのノードにローカルフォントを当てる
curl -s -H "X-Bridge-Token: $T" -H 'content-type: application/json' \
  -d '{"method":"script.run","params":{"args":{"id":"123:456","family":"Mizolet","style":"Regular"},"code":"const n = await helpers.getNode(args.id, \"TEXT\"); await helpers.loadFontsOf(n); await figma.loadFontAsync({family: args.family, style: args.style}); n.fontName = {family: args.family, style: args.style}; return helpers.boundsOf(n)"}}' \
  http://127.0.0.1:3056/rpc
```

長いスクリプトは JSON ボディをファイルに書いて `curl ... --data-binary @body.json` で送ると楽。

### `helpers`

| helper | 内容 |
|---|---|
| `getNode(nodeId, expectType?)` | id からノードを取得（無い・型違いは例外） |
| `loadFontsOf(textNode)` | テキストが使う全フォント（混在含む）をロードして返す |
| `fontsOf(textNode)` | テキストが使うフォント一覧（ロードはしない） |
| `boundsOf(node)` | `{id, name, x, y, width, height}`（0.01 単位に丸め） |
| `exportPng(nodeかid, scale?)` | `node.export` と同じ `{node, format, scale, bytes, base64}`（4096px / 8MB 上限） |

### 返り値とエラー

戻り値は JSON で安全に送れる形に変換される: 循環参照 → `"[Circular]"`、BigInt → 文字列、
`undefined`・関数・Symbol は落とす（配列内は `null`）、`figma.mixed` → `"MIXED"`、
ノードをそのまま返すと `{id, type, name}`、`Date` → ISO 文字列、型付き配列 → 数値配列。
何も返さなければ `data: null`。

| error | 条件 |
|---|---|
| `script_disabled`（HTTP 403・ブローカーが返す） | スクリプトモードが OFF |
| `script_error`（`message` / `name` / `stack`） | スクリプトが例外を投げた・構文エラー |
| `script_timeout`（`timeoutMs`） | `timeoutMs` 以内に終わらなかった |
| `code_too_large`（`bytes` / `limit`） | `code` が 200KB（UTF-8）超 |
| `result_too_large`（`bytes` / `limit`） | 戻り値の JSON が 2MB 超 |
| `handler_error` | `code` が無い・`timeoutMs` が不正 |

いずれの場合もプラグインは落ちない。

### 制限

- タイムアウト: 既定 60 秒・最大 10 分。時間切れでも応答は返るが、**スクリプト自体は止められない**
  （裏で動き続けることがあり、それまでの変更は残る）
- サイズ: `code` 200KB・戻り値 2MB・HTTP ボディ 2MB（従来どおり）
- リクエストは引き続き1件ずつ直列処理（スクリプトが終わるかタイムアウトするまで、ほかの呼び出しは待つ）
- ブローカーは `script.run` だけ `timeoutMs + 5秒` まで待つ（既存メソッドは従来の 30 秒）

### セキュリティ

スクリプトモードは Figma セッション内での **任意コード実行**。開いているファイルを何でも読み書きでき、
ブローカーを呼べる相手にはその力が渡る。

- 既定 OFF。有効にするのは自分専用のMacだけ。**共用PC・公開PCでは有効にしない**
- 127.0.0.1 限定のバインドと毎リクエストのトークン検証は従来どおり。ただしスクリプトモードを有効にしたMacでは
  `broker/.token` をパスワードと同じ扱いにする
- 使わせるのは信頼できる呼び出し元（自分のエージェント・スクリプト）だけ。信頼できない文字列を `code` に流し込まない
- 無効に戻すには、フラグなしでブローカーを再起動するか `bash launchd/install.sh` を再実行する

---

## セキュリティ

- WS(3055) / HTTP(3056) はどちらも **127.0.0.1 のみ**にバインド。外部からは接続不可
- 起動ごとにランダムトークンを発行（常駐運用では再利用）。WS も HTTP も同じトークンを検証する
- プラグインが実行できるのは `code.js` の `HANDLERS` に列挙したメソッドだけ（`eval` は無い。例外は opt-in の `script.run` で、ブローカーを `--allow-script` / `BRIDGE_ALLOW_SCRIPT=1` で起動しない限り拒否される）
- 対象は **今開いているファイルの、指定した nodeId のノードのみ**。全体走査や削除の手段は持たせていない
- リクエストは1件ずつ直列処理。文字数（20,000）・書き出しサイズ（4096px / 8MB）・HTTPボディ（2MB）に上限
- トークンは「記憶する」にチェックしたときだけ `clientStorage` に保存（既定 OFF・外すと削除）

## つながらないとき

- **既定ではトークンは起動ごとに変わる**（常駐運用では変わらない）。ブローカーを再起動したら、古いトークンでは認証に失敗する → `cat broker/.token` で最新を表示してコピーし直す
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

スクリプトモードのテスト（Node のみ。空きポートと一時フォルダで専用ブローカーを起動するので、
常駐ブローカー・3055/3056・`broker/.token` には触れない）:

```bash
node test/script_run.test.js   # exit 0 なら全件合格
```

## 既知の制約

- Figma のプラグインパネルを閉じると切断される（「記憶する」ON なら開き直すと自動接続／OFF なら「接続」を押し直す）
- `text.setCharacters` は全文置換。元が混在スタイルだと先頭スタイルに寄る（警告を返す）
- ブローカーに接続できるプラグインは同時に1つ（後から接続したものが有効になる）
