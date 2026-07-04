#!/usr/bin/env bash
# 大阪市立図書館 家族4アカウント自動予約 実行スクリプト
# 使い方:
#   ./run.sh --all [--dry-run]
#   ./run.sh --account=chojo [--dry-run]
# Cowork のサンドボックスVM (Linux) と macOS の両方で動く。
set -euo pipefail
cd "$(dirname "$0")"

ARGS=()
HAS_TARGET=0
TICK=0
for a in "$@"; do
  case "$a" in
    --all) ARGS+=("--all"); HAS_TARGET=1 ;;
    --account=*) ARGS+=("$a"); HAS_TARGET=1 ;;
    --dry-run) ARGS+=("--dry-run") ;;
    --plan-only) ARGS+=("--plan-only") ;;
    --limit=*) ARGS+=("$a") ;;
    --tick) TICK=1 ;;
    --reset) ARGS+=("--reset") ;;
    *) echo "不明なオプション: $a" >&2; exit 1 ;;
  esac
done
# 対象指定がなければ --all（tickモードでは不要）
if [ "$TICK" = 0 ] && [ "$HAS_TARGET" = 0 ]; then ARGS+=("--all"); fi

log() { echo "[run.sh] $*"; }

# ---- 1. Node.js の確認 ----
if ! command -v node >/dev/null 2>&1; then
  log "Node.js が見つかりません。インストールを試みます..."
  if command -v brew >/dev/null 2>&1; then
    brew install node
  elif command -v apt-get >/dev/null 2>&1; then
    sudo_cmd=""; [ "$(id -u)" != 0 ] && sudo_cmd="sudo"
    curl -fsSL https://deb.nodesource.com/setup_22.x | $sudo_cmd bash -
    $sudo_cmd apt-get install -y nodejs
  else
    log "Node.js を手動でインストールしてください: https://nodejs.org"; exit 1
  fi
fi
log "Node: $(node --version)"

# ---- 2. npm 依存 (playwright) ----
if [ ! -d node_modules/playwright ]; then
  log "npm install を実行します..."
  npm install --no-fund --no-audit
fi

# ---- 3. Chromium バイナリ ----
# プリインストール済みブラウザがあればそれを使う（Claude Code クラウド環境など）
if [ -z "${OML_CHROMIUM_PATH:-}" ] && [ -x /opt/pw-browsers/chromium ]; then
  export OML_CHROMIUM_PATH=/opt/pw-browsers/chromium
fi
if [ -z "${OML_CHROMIUM_PATH:-}" ] && [ -z "${PLAYWRIGHT_BROWSERS_PATH:-}" ]; then
  if ! node -e "require('playwright').chromium.executablePath()" >/dev/null 2>&1 \
     || [ ! -e "$(node -e "console.log(require('playwright').chromium.executablePath())" 2>/dev/null)" ]; then
    log "Playwright Chromium をインストールします..."
    npx playwright install chromium
  fi
fi

# ---- 4. .env の確認（--plan-only はサイトアクセスなしなので不要）----
# 環境変数に認証情報があれば .env を自動生成する（Claude Code環境のスケジュール実行用）
if [ ! -f .env ] && [ -n "${OML_CARD_MOM:-}" ]; then
  log ".env を環境変数から自動生成します"
  {
    for v in OML_CARD_MOM OML_PASS_MOM OML_CARD_CHOJO OML_PASS_CHOJO \
             OML_CARD_CHONAN OML_PASS_CHONAN OML_CARD_JINAN OML_PASS_JINAN; do
      eval "echo \"$v=\${$v:-}\""
    done
  } > .env
  chmod 600 .env
fi
if [ ! -f .env ] && [[ " ${ARGS[*]} " != *" --plan-only "* ]]; then
  log "ERROR: .env がありません。.env.example をコピーして記入するか、OML_* 環境変数を設定してください。"
  exit 1
fi

# ---- 5. 実行 ----
if [ "$TICK" = 1 ]; then
  # 刻み実行モード: 1回で小さな1ステップだけ進めて終了（約45秒制限の環境向け）
  # TICK:DONE が出るまで繰り返し呼び出すこと
  log "刻み実行: ${ARGS[*]}"
  node src/tick.js "${ARGS[@]}"
else
  log "予約処理を開始: ${ARGS[*]}"
  node src/index.js "${ARGS[@]}"
fi
