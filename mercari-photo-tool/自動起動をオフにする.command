#!/bin/bash
# ============================================================
#  「裏で常に動かしておく」設定をやめる（Mac用）
#  ツールを止めて、ログイン時の自動起動もやめます。
#  また使うときは start.command をダブルクリックしてください。
# ============================================================
cd "$(dirname "$0")" || exit 1
source tools/common.sh

osascript -e "tell application \"System Events\" to delete (every login item whose name is \"$APP_NAME\")" >/dev/null 2>&1
stop_server
rm -rf "$PWD/$APP_NAME.app"
echo "✅ ツールを止めて、自動起動をオフにしました。"
echo "   また使うときは start.command をダブルクリックしてください。"
pause_and_exit 0
