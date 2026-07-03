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
for a in "$@"; do
  case "$a" in
    --all) ARGS+=("--all"); HAS_TARGET=1 ;;
    --account=*) ARGS+=("$a"); HAS_TARGET=1 ;;
    --dry-run) ARGS+=("--dry-run") ;;
    --plan-only) ARGS+=("--plan-only") ;;
    --limit=*) ARGS+=("$a") ;;
    *) echo "不明なオプション: $a" >&2; exit 1 ;;
  esac
done
# 対象指定がなければ --all
[ "$HAS_TARGET" = 1 ] || ARGS+=("--all")

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
if [ ! -f .env ] && [[ " ${ARGS[*]} " != *" --plan-only "* ]]; then
  log "ERROR: .env がありません。.env.example をコピーして記入してください。"
  exit 1
fi

# ---- 5. 実行 ----
log "予約処理を開始: ${ARGS[*]}"
node src/index.js "${ARGS[@]}"
