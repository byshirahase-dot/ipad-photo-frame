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
  77トリガーの検知表を作成済み。**シリーズは全巻を巻順に読む（ユーザー指定）**。ただし週4冊の枠の
  うちシリーズ枠は2冊まで（accounts.json: seriesPerWeek）、残り2冊はリストを進める。
  45シリーズは最終巻まで確定済み、10シリーズは判明分のみ（complete:false。Cowork が週次で
  Web 検索して最終巻まで追記する）。巻順不明の21シリーズはファイル未作成（「シリーズ展開待ち」
  としてレポートされ Cowork が作成）
- **シリーズ展開**: スクリプトはWeb検索しない。`data/series_hints.json` で第1巻を検知し、
  `data/series/{名前}.json` があれば全巻を巻順にキューへ挿入。無ければレポートに
  「シリーズ展開待ち」と出し、Cowork の Claude がWeb検索でファイルを作る（次週から展開される）
- **母の選書**: Cowork の Claude が `data/mom/preferences.md` の選書ポリシー
  （直木賞・芥川賞・本屋大賞・山本周五郎賞・日本ミステリー文学大賞の受賞作・候補作＋
  その作家の他作品がベース。2026-07-03 ユーザー指定）に従い `data/mom/queue.json` を書く。
  空ならスキップし「選書待ち」と報告。ユーザーのチャット発言（既読申告・感想・要望）は
  Cowork が history.csv と preferences.md の要望メモに反映する（対応表は preferences.md 参照）
- **状態変更は本番実行のみ**: dry-run / plan-only では reserved.json・progress.json・queue.json・
  _expanded.json を一切書き換えない
- **予約枠**: ログイン後に予約中冊数を取得し、上限（accounts.json: reserveLimit=15）を超える分は
  予約せずレポートに記載
- **取消予約の自動復帰（2026-07-03追加）**: 毎回ログイン後に予約状況一覧を確認し、
  予約状態「取消」（取り置き期限切れ・延滞ペナルティによる無効化。**ユーザー確認済み：これらは
  「取消」表示で一覧に残る。手動取消は一覧から消える**）の本は台帳エントリを expired にして
  再予約対象へ戻す（公文=キュー先頭に割込み、母=queue.json先頭へ）。
  安全ガード: ①同じ本に有効な予約（待ち等）がある場合の取消行は再予約済みの残骸として無視
  ②台帳に reserved エントリが無い本（このシステム外の予約）は無視。
  既知の制約: 母は queue.json が空の週はログインしないため、取消検出も次の選書週まで持ち越し

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
- [x] 初回ドライラン成功（2026-07-03、全アカウント）
- [x] **本番1冊テスト成功（2026-07-03）**: 次男「にんじんさんがあかいわけ」受取館=阿倍野で予約完了。
  ※当初の対象（はらぺこあおむし）でなく3A-5が予約されたのは進度カーソルのバグ（失敗実行でも
  4冊分進んでいた）。「処理し終えた本の分だけ進める」方式に修正済み。進度は3A-1に手動補正済みで、
  にんじんさんは台帳(reserved.json)にあるため二重予約されない
- 連絡方法は現状サイトのデフォルト（電話1連絡）。変更したい場合は opac.js の連絡方法選択を追加する
- [ ] Cowork スケジュールタスク登録（SCHEDULE_PROMPT.md 参照）→ 週次運用開始

### 次のセッションでやること

1. `.env` を作成（ユーザーから届いた認証情報で。**絶対にコミットしない**）
2. ネットワークが使える環境（ローカルMac / ネットワーク許可済みCowork/Claude Code環境）で:
   - `npm run fetch-kumon` で公式PDFを取得し、Claude が読んで `data/kumon_list.csv`（650行）を生成
   - `./run.sh --all --dry-run` を実行し、logs/ を見ながら src/opac.js のセレクタを調整
3. ドライラン結果をユーザーに見せて承認を得る → 本番は1冊だけで動作確認 → 全量運用
