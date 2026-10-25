#!/bin/bash
# ============================================================
#  メルカリ写真まとめて加工ツール — ダブルクリックで起動（Mac用）
#  初回だけ、必要なソフトの準備に数分かかります。
# ============================================================
cd "$(dirname "$0")" || exit 1
VENV=".venv"

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

echo "メルカリ写真まとめて加工ツールを起動します…"

if [ ! -x "$VENV/bin/python" ]; then
  echo "初回セットアップ中です（数分かかります）…"
  if command -v uv >/dev/null 2>&1; then
    uv venv --seed --python 3.12 "$VENV" || pause_and_exit 1
  else
    PY="$(find_python)"
    if [ -z "$PY" ]; then
      echo ""
      echo "Python 3.10〜3.13 が見つかりませんでした。"
      echo "https://www.python.org/downloads/ から Python 3.12 をインストールしてから、"
      echo "もう一度 start.command をダブルクリックしてください。"
      pause_and_exit 1
    fi
    "$PY" -m venv "$VENV" || pause_and_exit 1
  fi
fi

# 必要なソフト（requirements.txt が変わったときだけインストール）
STAMP="$VENV/.requirements.sha"
NEW_SHA="$(shasum requirements.txt | cut -d' ' -f1)"
if [ ! -f "$STAMP" ] || [ "$(cat "$STAMP")" != "$NEW_SHA" ]; then
  echo "必要なソフトをインストールしています…"
  if command -v uv >/dev/null 2>&1; then
    uv pip install --python "$VENV/bin/python" -r requirements.txt || pause_and_exit 1
  else
    "$VENV/bin/python" -m pip install --upgrade pip >/dev/null
    "$VENV/bin/python" -m pip install -r requirements.txt || pause_and_exit 1
  fi
  echo "$NEW_SHA" > "$STAMP"
fi

"$VENV/bin/python" app.py
echo ""
echo "ツールを終了しました。"
pause_and_exit 0
