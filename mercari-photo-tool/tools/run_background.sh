#!/bin/bash
# ツールを裏で起動する（「メルカリ写真ツール.app」から呼ばれる。ターミナルは不要）
# 止まってしまっても10秒後に起動し直す（「自動起動をオフにする」で止めるまで続ける）
cd "$(dirname "$0")/.." || exit 1
source tools/common.sh
mkdir -p "$STATE_DIR"
[ -f "$STATE_DIR/runner.pid" ] && is_tool_pid "$(cat "$STATE_DIR/runner.pid")" && exit 0
rm -f "$STATE_DIR/stop"

# ログが大きくなりすぎないように
if [ -f "$STATE_DIR/tool.log" ] && [ "$(wc -c < "$STATE_DIR/tool.log")" -gt 5000000 ]; then
  mv "$STATE_DIR/tool.log" "$STATE_DIR/tool.old.log"
fi

export MERCARI_BACKGROUND=1
nohup bash -c '
  while [ ! -f logs/stop ]; do
    if command -v caffeinate >/dev/null 2>&1; then
      caffeinate -s .venv/bin/python app.py  # 電源アダプタ接続中は Mac がスリープしない
    else
      .venv/bin/python app.py
    fi
    [ -f logs/stop ] || sleep 10
  done' >> "$STATE_DIR/tool.log" 2>&1 &
echo $! > "$STATE_DIR/runner.pid"
