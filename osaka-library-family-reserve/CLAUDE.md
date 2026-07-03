# osaka-library-family-reserve

大阪市立図書館の家族4アカウント（母1＋子3）で、毎週4冊ずつ本を自動予約するシステム。
毎週の運用は Claude Cowork のスケジュールタスクから実行する（SCHEDULE_PROMPT.md 参照）。

## 進め方のルール（ユーザー指示）

- 進めるか否かの確認をできるだけ少なくし、自律的に進める
- 自らテストを行いエラーを修正する。ただし**本物の予約操作のテストは行わない**。
  必ず `--dry-run` で検証し、**初回の本番予約はユーザーの確認を取ってから1冊だけ**行う
- API消費を抑える：毎週の実行はスクリプトのみで完結。**このプロジェクトのスクリプトはLLMを呼ばない**
  （選書・シリーズ調査などLLMが必要な仕事は Cowork 側の Claude が行う）
- 進捗をこの CLAUDE.md に記録し、セッションが切れても続けられるようにする
- サイトへのアクセスは間隔を空けて丁寧に（デフォルト5秒、accounts.json の requestIntervalMs）

## 構成

```
accounts.json            アカウント設定（mode/受取館/週冊数/開始進度）※秘密情報は含まない
.env                     カード番号・パスワード（Git管理外。.env.example を参照）
data/kumon_list.csv      公文すいせん図書 650冊（level,order,title,author）★未生成・要作成
data/kumon_list.sample.csv  テスト用サンプル
data/series_hints.json   「第1巻タイトル → シリーズ名」対応表
data/series/{名前}.json  シリーズ全巻リスト（Cowork の Claude が Web検索で作成）
data/mom/queue.json      母の選書キュー（Cowork の Claude が毎週作成）
data/mom/history.csv     母の読了・評価履歴（npm run rate で追記）
state/{account}/reserved.json  予約・失敗の台帳（二重予約防止）
state/{account}/progress.json  公文リスト上の現在位置
state/{account}/queue.json     シリーズ展開の持ち越しキュー
reports/YYYY-MM-DD.md    実行レポート
logs/YYYY-MM-DD/         スクリーンショットとHTML（失敗解析用）
src/                     実装（config/state/kumon/series/opac/report/index/rate）
run.sh                   1コマンド実行（依存セットアップ込み）
```

## コマンド

```bash
./run.sh --all --dry-run          # 全アカウント ドライラン（予約直前まで）
./run.sh --account=chojo --dry-run
./run.sh --all                    # 本番予約
./run.sh --all --plan-only        # サイトに一切アクセスせず選書計画だけ出す
npm run reserve                   # = run.sh --all
npm run reserve -- --account=mom --dry-run
npm run rate                      # 母の読了本の評価を対話入力 → history.csv
npm test                          # ロジックの単体テスト
```

アカウントID: `mom`（母/おすすめ）, `chojo`（長女/公文E〜）, `chonan`（長男/公文A-11〜）, `jinan`（次男/公文3A〜）
受取館: 全員 阿倍野図書館

## 重要な設計判断

- **シリーズ判定済み（2026-07-03）**: 全650冊を確認し、55シリーズの巻順ファイル（data/series/）と
  77トリガーの検知表を作成済み。巻数ポリシー: 7巻以下は全巻／8巻以上は最初の5巻／途中巻がリスト
  掲載でも第1巻から。巻順に自信がない21シリーズはファイル未作成（実行時に「シリーズ展開待ち」として
  レポートされ、Cowork の Claude が Web 検索で作成する）
- **シリーズ展開**: スクリプトはWeb検索しない。`data/series_hints.json` で第1巻を検知し、
  `data/series/{名前}.json` があれば全巻を巻順にキューへ挿入。無ければレポートに
  「シリーズ展開待ち」と出し、Cowork の Claude がWeb検索でファイルを作る（次週から展開される）
- **母の選書**: Cowork の Claude が `data/mom/queue.json` を書く。空ならスキップし「選書待ち」と報告
- **状態変更は本番実行のみ**: dry-run / plan-only では reserved.json・progress.json・queue.json・
  _expanded.json を一切書き換えない
- **予約枠**: ログイン後に予約中冊数を取得し、上限（accounts.json: reserveLimit=15）を超える分は
  予約せずレポートに記載

## 進捗ログ

### 2026-07-03 セッション1（Claude Code cloud / ブランチ claude/osaka-library-reserve-pxkjes）

- [x] 要件確認：受取館=全員阿倍野、進度=長女E-1/長男A-11/次男3A-1、認証情報はチャットで受領予定
- [x] プロジェクト骨格・全ソースコード実装（src/ 一式、run.sh、テスト6件パス）
- [x] --plan-only モードのスモークテスト成功（サンプルリストで4冊×3人の計画とレポート生成を確認）
- [x] **data/kumon_list.csv 生成完了**（2026-07-03）：ユーザーが2026年度版公式PDFをアップロード。
  `scripts/parse-suisen-pdf.mjs`（pdftotext -tsv の座標＋フォント高でタイトル/著者/出版社を分離、
  複数列に現れるy座標を行グリッドとして折返しタイトルを結合）で650冊を抽出。
  全13レベル×50冊、各レベルの先頭・末尾をPDFと照合済み。series_hints.json も実タイトル表記に更新。
  実リストでの --plan-only 確認済み: 長女=E1〜4（注文の多い料理店〜）、長男=A11〜14（11ぴきのねこ〜）、
  次男=3A1〜4（はらぺこあおむし〜）
- [x] **OPACセレクタ検証完了（2026-07-03 実サイトでドライラン成功）**。判明した実構造:
  - スマホ版UI（Smt系）。トップ `WOpacSmtMnuTopAction.do`、検索欄 `#SearchKWInputSearch`＋`#schButtonSearch`
  - ログイン: `#openmenu2`でマイ図書館メニュー→`a#usr-lgin`→`#usrcardnumber`/`#password`→`input[value*="ログイン"]`
  - 検索は全項目→絞込みフォーム（`#searchkind_add`=書名, `#search_add`, `submitNarrow()`）→
    `#AssistSortSelect`で出版年昇順に並べ替え（雑誌・大型絵本などの新しい特殊版を後ろへ）
  - 結果行 `a.layer-doc`（`.title`/`.writer`）。予約中冊数はヘッダ `#stat-resv .value`
  - 詳細ページ「※この書誌は予約できません。」（大型絵本等）は次候補へフォールバック（rankResults上位3件）
  - 予約ボタンは「予約カート」系。**カート以降（受取館選択→確認→決定）は本番1冊テストで最終検証**
  - ドライランは予約カート投入前で停止する設計（口座状態を一切変えない）
  - Claude Codeクラウドのプロキシ環境ではChromiumのTLSが弾かれるため、page.route で
    Node側fetchに中継する対策を実装済み（HTTPS_PROXY があるときのみ有効化）
- [x] .env 作成済み（2026-07-03 ユーザーから4アカウント分を受領。**コンテナ内のみ・コミット禁止**。
  コンテナが再作成されると消えるため、恒久対応として Claude Code 環境設定の環境変数に
  OML_CARD_* / OML_PASS_* の8つを登録するのが望ましい）
- [ ] 初回ドライラン → ユーザー確認 → 本番1冊テスト → 週次運用開始
  （ネットワークポリシー変更待ち。2026-07-03 時点で oml.city.osaka.lg.jp は 403 のまま）

### 次のセッションでやること

1. `.env` を作成（ユーザーから届いた認証情報で。**絶対にコミットしない**）
2. ネットワークが使える環境（ローカルMac / ネットワーク許可済みCowork/Claude Code環境）で:
   - `npm run fetch-kumon` で公式PDFを取得し、Claude が読んで `data/kumon_list.csv`（650行）を生成
   - `./run.sh --all --dry-run` を実行し、logs/ を見ながら src/opac.js のセレクタを調整
3. ドライラン結果をユーザーに見せて承認を得る → 本番は1冊だけで動作確認 → 全量運用
