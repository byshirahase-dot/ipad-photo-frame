#!/bin/bash
# ============================================================
#  ツールを「裏で常に動かしておく」設定にする（Mac用）
#  ・今すぐ裏で起動し、次からは Mac にログインすると自動で起動します
#  ・ターミナルを開いておく必要はありません（このウィンドウは閉じてOK）
#  ・電源アダプタにつないでいる間は Mac がスリープしません
#  ・やめるときは「自動起動をオフにする.command」をダブルクリック
# ============================================================
cd "$(dirname "$0")" || exit 1
source tools/common.sh
APP="$PWD/$APP_NAME.app"

ensure_setup || pause_and_exit 1
chmod +x tools/run_background.sh

# 1. 裏で起動するための小さなアプリを作る
#   （最初に起動したとき「“書類”フォルダへのアクセス」を聞かれたら「OK」を押してください）
rm -rf "$APP"
if ! osacompile -o "$APP" \
    -e 'on run' \
    -e 'set appPath to POSIX path of (path to me)' \
    -e 'do shell script "cd " & quoted form of appPath & "/.. && ./tools/run_background.sh > /dev/null 2>&1 &"' \
    -e 'end run'; then
  echo "起動用アプリを作れませんでした。"
  pause_and_exit 1
fi

# 2. ログインしたときに自動で開くようにする（「System Events の制御」を聞かれたら「OK」）
osascript -e "tell application \"System Events\" to delete (every login item whose name is \"$APP_NAME\")" >/dev/null 2>&1
if osascript -e "tell application \"System Events\" to make login item at end with properties {path:\"$APP\", hidden:true}" >/dev/null; then
  echo "✅ Mac にログインしたら自動で起動するように設定しました。"
else
  echo "⚠ ログイン時の自動起動を設定できませんでした。手動で設定する場合:"
  echo "   システム設定 → 一般 → ログイン項目 →「＋」→ このフォルダの「$APP_NAME.app」を選ぶ"
fi

# 3. 今すぐ裏で起動する（ターミナルで動いているツールがあれば止めて切り替える）
stop_server
open "$APP"
echo "ツールを裏で起動しています…"
for _ in $(seq 1 90); do
  server_running && [ -f "$STATE_DIR/url.txt" ] && break
  sleep 1
done

if server_running; then
  echo "✅ ツールが裏で動いています。このウィンドウは閉じて大丈夫です。"
  print_urls
else
  echo ""
  echo "⚠ ツールが起動しませんでした。"
  echo "  「“書類”フォルダへのアクセス」の確認が出ていたら「OK」を押して、"
  echo "  もう一度このファイルをダブルクリックしてください。"
  echo "  記録: $PWD/$STATE_DIR/tool.log"
fi
pause_and_exit 0
