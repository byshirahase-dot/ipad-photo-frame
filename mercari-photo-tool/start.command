#!/bin/bash
# ============================================================
#  メルカリ写真まとめて加工ツール — ダブルクリックで起動（Mac用）
#  初回だけ、必要なソフトの準備に数分かかります。
#  このウィンドウを閉じるとツールも止まります（最小化はOK）。
# ============================================================
cd "$(dirname "$0")" || exit 1
source tools/common.sh

# 自動起動（裏で動いている）ならブラウザで開くだけ
if server_running; then
  echo "ツールはすでに動いています。ブラウザで開きます。"
  url="$(sed -n 1p "$STATE_DIR/url.txt" 2>/dev/null)"
  [ -n "$url" ] && command -v open >/dev/null 2>&1 && open "$url"
  print_urls
  pause_and_exit 0
fi

echo "メルカリ写真まとめて加工ツールを起動します…"
ensure_setup || pause_and_exit 1

if command -v caffeinate >/dev/null 2>&1; then
  echo "（ツールが動いている間は、Macが自動でスリープしないようにしています。画面は暗くなってもOK）"
  caffeinate -i "$VENV/bin/python" app.py
else
  "$VENV/bin/python" app.py
fi
echo ""
echo "ツールを終了しました。"
pause_and_exit 0
