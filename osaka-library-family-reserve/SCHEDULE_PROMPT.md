# Cowork スケジュールタスク登録用プロンプト

以下をそのまま Cowork の週次スケジュールタスク（例: 毎週土曜 朝7時）のプロンプトに貼り付ける。

---

大阪市立図書館の家族週次予約を実行してください。リポジトリ: byshirahase-dot/ipad-photo-frame の
ブランチ `claude/osaka-library-reserve-pxkjes` 内 `osaka-library-family-reserve/` フォルダ。
（専用リポジトリに移した場合はそちらを使う）

手順:

1. **準備**: リポジトリを最新化し、`osaka-library-family-reserve/` に移動。
   `.env` が無ければ環境変数（OML_CARD_MOM 等8つ）から生成する。CLAUDE.md を読んで前回までの状況を把握する。

2. **母の選書**: `data/mom/history.csv`（評価履歴）と `state/mom/recommended.json`（推薦済み）を読み、
   評価の高かった本の傾向（著者・ジャンル）から今週の4冊を Web 検索で選書する。
   大阪市立図書館に所蔵がありそうな一般的な書籍を選び、`data/mom/queue.json` に書く:
   `{ "items": [ { "title": "書名", "author": "著者", "reason": "選んだ理由" } ] }`
   推薦済み・履歴にある本は選ばない。

3. **シリーズファイルの整備**: 次の2つを行う。
   a) 前回レポート（reports/ の最新）に「シリーズ展開待ち」があれば、Web 検索で全巻の正式タイトルと
      巻順を調べ `data/series/{シリーズ名}.json` を作成する:
      `{ "name": "...", "totalVolumes": N, "complete": true, "volumes": [ { "order": 1, "title": "..." }, ... ] }`
   b) `data/series/*.json` のうち `"complete": false` のファイルを1〜2件ずつ Web 検索で最終巻まで
      追記し、`complete` を true にする（巻順は刊行順。リスト掲載巻が途中巻でも第1巻から並べる）。
   **予約ペースの方針**: シリーズは全巻を巻順に読むが、週4冊の枠のうちシリーズは2冊まで。
   残り2冊はリストの次の本を進める（スクリプトが自動で行うので、ファイルには全巻入れてよい）。

4. **ドライラン**: `./run.sh --all --dry-run` を実行し、予約予定リストに異常がないか確認する
   （同じ本の重複、明らかな検索ミスなど）。異常があれば本番を実行せず報告のみ。

5. **本番実行**: 問題なければ `./run.sh --all` を実行する。

6. **記録と報告**:
   - 変更されたファイル（state/, reports/, data/）をコミットしてプッシュする。
     コミットメッセージ例: `weekly reserve 2026-07-05`。**.env は絶対にコミットしない。**
   - `reports/YYYY-MM-DD.md` の内容を要約してユーザーに報告する:
     アカウント別の予約成功／失敗／スキップ理由、シリーズ展開待ちの有無、次回の開始位置。
   - 失敗が多い場合は logs/ のスクリーンショットを確認し、サイト構造変更が疑われる場合は
     その旨を報告する（勝手に大規模修正しない）。

制約:
- 予約操作はスクリプト（run.sh）だけが行う。あなた（Claude）がブラウザで図書館サイトを直接操作しない。
- サイトへのアクセスは丁寧に。スクリプトの再実行は1回まで。
- 予約上限超過・所蔵なしはスクリプトが自動処理する。レポートに従って報告だけすればよい。

---

## 補足（初回登録時の設定）

- 実行環境に Node.js 22+ と Playwright 用ブラウザが必要（run.sh が自動セットアップする）
- 環境変数またはVM内 `.env` に8つの認証情報を設定:
  OML_CARD_MOM / OML_PASS_MOM / OML_CARD_CHOJO / OML_PASS_CHOJO /
  OML_CARD_CHONAN / OML_PASS_CHONAN / OML_CARD_JINAN / OML_PASS_JINAN
- ネットワークポリシーで `www.oml.city.osaka.lg.jp` への接続を許可すること
