#!/bin/bash
# figma-font-bridge ブローカーを launchd に常駐登録するスクリプト
# 使い方:  bash launchd/install.sh            … 登録（再実行すると入れ直し）
#          bash launchd/install.sh uninstall  … 停止して登録解除
# 環境変数 BRIDGE_LABEL でジョブ名を変えられる（既定: com.<ユーザー名>.figma-font-bridge）
set -euo pipefail

# リポジトリの場所（このスクリプトの1つ上）
REPO="$(cd "$(dirname "$0")/.." && pwd)"
LABEL="${BRIDGE_LABEL:-com.$(id -un).figma-font-bridge}"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG_DIR="$HOME/Library/Logs"
DOMAIN="gui/$(id -u)"

# 既存ジョブを止める（無ければ何もしない）
launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true

if [ "${1:-}" = "uninstall" ]; then
  rm -f "$PLIST"
  echo "停止・登録解除しました: $LABEL"
  exit 0
fi

# node の実体パス（nvm 等でも絶対パスにする）
NODE="$(command -v node || true)"
if [ -z "$NODE" ]; then echo "node が見つかりません。Node.js を入れてから再実行してください" >&2; exit 1; fi
NODE="$(cd "$(dirname "$NODE")" && pwd -P)/$(basename "$NODE")"

# 手動起動中のブローカーがあれば止める（ポート競合を避ける）
pkill -f "$REPO/broker/server.js" 2>/dev/null || true
pkill -f "node broker/server.js" 2>/dev/null || true
sleep 1

# テンプレートのパスを置き換えて plist を作る
mkdir -p "$HOME/Library/LaunchAgents" "$LOG_DIR"
esc() { printf '%s' "$1" | sed -e 's/[&|\\]/\\&/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'; }
sed -e "s|__LABEL__|$(esc "$LABEL")|g" \
    -e "s|__NODE__|$(esc "$NODE")|g" \
    -e "s|__REPO__|$(esc "$REPO")|g" \
    -e "s|__LOG_DIR__|$(esc "$LOG_DIR")|g" \
    "$REPO/launchd/com.example.figma-font-bridge.plist.template" > "$PLIST"
plutil -lint "$PLIST" >/dev/null

launchctl bootstrap "$DOMAIN" "$PLIST"
sleep 2
echo "登録しました: $LABEL"
echo "  plist : $PLIST"
echo "  log   : $LOG_DIR/figma-font-bridge.*.log / $REPO/broker/bridge.log"
echo "  token : $(cat "$REPO/broker/.token")"
echo "このトークンをプラグインに貼り「トークンを記憶して…」を ON にすれば、次回から自動接続します"
