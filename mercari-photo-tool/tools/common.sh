# .command ファイルから読み込む共通の処理（このファイル単体では実行しない）
VENV=".venv"
APP_NAME="メルカリ写真ツール"
STATE_DIR="logs"

pause_and_exit() {
  echo ""
  read -r -p "Enterキーを押すとこのウィンドウを閉じます" _
  exit "${1:-1}"
}

# Python 3.10〜3.13 を探す
find_python() {
  for c in python3.12 python3.11 python3.13 python3.10 python3; do
    if command -v "$c" >/dev/null 2>&1 &&
       "$c" -c 'import sys; sys.exit(0 if (3, 10) <= sys.version_info[:2] <= (3, 13) else 1)' 2>/dev/null; then
      echo "$c"
      return 0
    fi
  done
  return 1
}

# 初回は .venv を作って必要なソフトを入れる（requirements.txt が変わったときも入れ直す）
ensure_setup() {
  if [ ! -x "$VENV/bin/python" ]; then
    echo "初回セットアップ中です（数分かかります）…"
    if command -v uv >/dev/null 2>&1; then
      uv venv --seed --python 3.12 "$VENV" || return 1
    else
      local py
      py="$(find_python)"
      if [ -z "$py" ]; then
        echo ""
        echo "Python 3.10〜3.13 が見つかりませんでした。"
        echo "https://www.python.org/downloads/ から Python 3.12 をインストールしてから、もう一度試してください。"
        return 1
      fi
      "$py" -m venv "$VENV" || return 1
    fi
  fi
  local stamp="$VENV/.requirements.sha" new_sha
  new_sha="$(shasum requirements.txt | cut -d' ' -f1)"
  if [ ! -f "$stamp" ] || [ "$(cat "$stamp")" != "$new_sha" ]; then
    echo "必要なソフトをインストールしています…"
    if command -v uv >/dev/null 2>&1; then
      uv pip install --python "$VENV/bin/python" -r requirements.txt || return 1
    else
      "$VENV/bin/python" -m pip install --upgrade pip >/dev/null
      "$VENV/bin/python" -m pip install -r requirements.txt || return 1
    fi
    echo "$new_sha" > "$stamp"
  fi
}

# ツールがすでに動いているか（app.py が起動時に logs/server.pid を書く）
server_running() {
  [ -f "$STATE_DIR/server.pid" ] || return 1
  ps -p "$(cat "$STATE_DIR/server.pid")" -o command= 2>/dev/null | grep -q "app.py"
}

stop_server() {
  server_running || return 0
  local pid
  pid="$(cat "$STATE_DIR/server.pid")"
  kill "$pid" 2>/dev/null
  # 完全に終わるまで待つ（すぐ起動し直したときに同じポート番号を使えるように）
  for _ in $(seq 1 30); do
    kill -0 "$pid" 2>/dev/null || return 0
    sleep 0.5
  done
  kill -9 "$pid" 2>/dev/null
}

# iPhone で開くアドレスとQRコードを表示する
print_urls() {
  [ -f "$STATE_DIR/url.txt" ] || return 0
  local local_url lan_url host_url
  local_url="$(sed -n 1p "$STATE_DIR/url.txt")"
  lan_url="$(sed -n 2p "$STATE_DIR/url.txt")"
  host_url="$(sed -n 3p "$STATE_DIR/url.txt")"
  echo ""
  echo "  このMacで開く : $local_url"
  if [ -n "$lan_url" ]; then
    echo "  iPhoneで開く  : $lan_url  （同じWi-Fiにつないで Safari で開く）"
    [ -n "$host_url" ] && echo "  　　　　または : $host_url  （IPアドレスが変わっても使える。ホーム画面に追加するならこちら）"
    echo ""
    echo "  iPhoneのカメラでこのQRコードを読み取っても開けます:"
    "$VENV/bin/python" -c "import sys, qrcode; q = qrcode.QRCode(border=1); q.add_data(sys.argv[1]); q.print_ascii(invert=True)" "$lan_url" 2>/dev/null
  fi
}
