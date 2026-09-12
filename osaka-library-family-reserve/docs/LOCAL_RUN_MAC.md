# Mac ローカル実行ガイド（自宅の日本IPで動かす）

2026-09 に判明：**Claude Code クラウド版の出口IP（米 Anthropic レンジ）が大阪市立図書館の
F5エッジに遮断されており、クラウドからは予約できない**（HTTP 408。4日置いても解除されず、
別IP `.128`/`.131` いずれも遮断＝レンジ単位）。**根本解決は「日本の家庭IPから実行する」**。

Mac + 自宅Wi‑Fi（日本のIP）で以下を行う。**必ず自宅回線で**（VPN/テザリングの海外出口や
モバイル回線のCGNAT等は避ける。図書館サイトが普段のChromeで開けている回線ならOK）。

## 0. 前提
- Mac（Apple Silicon / Intel どちらも可）
- ふだん使っている自宅のWi‑Fi（＝Chromeで図書館にログインできている回線）

## 1. リポジトリ取得
```bash
# 初回
git clone https://github.com/byshirahase-dot/ipad-photo-frame.git
cd ipad-photo-frame
git checkout claude/osaka-library-reserve-pxkjes
cd osaka-library-family-reserve

# 2回目以降（最新の state を引き継ぐ）
# cd .../ipad-photo-frame && git checkout claude/osaka-library-reserve-pxkjes && git pull
# cd osaka-library-family-reserve
```

## 2. 認証情報（.env）を作る
```bash
cp .env.example .env
# .env をエディタで開き、4アカウントの図書館カード番号とパスワードを記入
#   OML_CARD_MOM / OML_PASS_MOM ... OML_CARD_JINAN / OML_PASS_JINAN
```
- 中身は家族の図書館カード番号＋パスワード（クラウド環境変数に入れていたのと同じ値）。
- **`.env` は `.gitignore` 済み。絶対にコミットしない。**

## 3. まず dry-run で「自宅IPでログインできるか」だけ確認（予約はしない）
```bash
./run.sh --account=jinan --dry-run
```
- 初回は Node.js（未導入なら Homebrew で自動）と Playwright Chromium を自動インストール（数分）。
- `--dry-run` は **ログイン＋検索まで行い、カート投入の直前で停止**（口座は一切変えない）。
- **ここでログインが通れば、IP起因だったことが確定＝本番もいけます。**
  408 や「ログイン画面要素が見つかりません」で止まる場合は連打せず、回線を確認して時間をおく。

## 4. 本番予約
```bash
./run.sh --account=jinan          # まず次男だけ（前回0冊だった分）
# 通ったら他も
./run.sh --account=chonan
./run.sh --account=chojo
./run.sh --account=mom
# もしくは一括
./run.sh --all
```
- ローカルは**プロキシ無し＝ブラウザが自宅の日本IPで直接アクセス**（クラウドの中継/408リトライは動かない）。
- **408 が出たら連打しない**（1回で諦めて時間をおく）。408リトライがBANを硬化させた前科あり。

## 5. 結果確認
```bash
cat reports/$(date +%Y-%m-%d).md   # アカウント別の成功/失敗
git diff --stat state/             # 予約で進んだ進度・台帳
```

## 6. state をチームで共有するなら（任意）
クラウドの週次と状態を一本化したい場合のみ、実行後に state をコミット＆プッシュ：
```bash
git add state/ reports/ data/     # ※ .env は含めない
git commit -m "local reserve $(date +%Y-%m-%d)"
git push origin claude/osaka-library-reserve-pxkjes
```

## 注意：クラウドの週次スケジュールについて
- 現状の週次スケジュール実行は**クラウド（遮断IP）で動く**ため、このままでは毎回 0冊になる。
- ローカル運用へ移すなら、**クラウドの週次タスクは停止**するか、役割を分ける（選書はどこ／
  予約はローカル）などを決める必要がある。← 運用方針は要検討。
- 単発予約（iPhoneからの「◯◯を◯◯で予約して」等）も、このMac実行に読み替えれば同じコマンドで可能：
  `./run.sh --account=chojo --title="本のタイトル"`
