#!/bin/bash
# ツールを裏で起動する（「メルカリ写真ツール.app」から呼ばれる。ターミナルは不要）
cd "$(dirname "$0")/.." || exit 1
source tools/common.sh
mkdir -p "$STATE_DIR"
server_running && exit 0

# ログが大きくなりすぎないように
if [ -f "$STATE_DIR/tool.log" ] && [ "$(wc -c < "$STATE_DIR/tool.log")" -gt 5000000 ]; then
  mv "$STATE_DIR/tool.log" "$STATE_DIR/tool.old.log"
fi

export MERCARI_BACKGROUND=1
if command -v caffeinate >/dev/null 2>&1; then
  # 電源アダプタにつないでいる間は、Macがスリープしないようにする（バッテリーのときは普段どおり）
  nohup caffeinate -s "$VENV/bin/python" app.py >> "$STATE_DIR/tool.log" 2>&1 &
else
  nohup "$VENV/bin/python" app.py >> "$STATE_DIR/tool.log" 2>&1 &
fi
