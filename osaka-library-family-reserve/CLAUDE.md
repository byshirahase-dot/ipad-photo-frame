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

## iPhoneからの単発予約（「この本を◯◯で予約して」対応）

ユーザーが「『◯◯』を長女で予約して」のように頼んだら、このコマンドを実行する：

```bash
./run.sh --account=chojo --title="本のタイトル"          # 実行前に --dry-run を付けて確認してもよい
./run.sh --account=mom --title="タイトル" --author="著者名"   # 著者は任意（検索精度の参考）
```

- アカウント: mom=母 / chojo=長女 / chonan=長男 / jinan=次男
- 進度・キュー・週次計画には一切影響しない。成功時のみ台帳に記録（二重予約防止）、
  失敗（所蔵なし等）は台帳に残さないのでタイトルを直して再依頼できる
- 実行後、成功/失敗と受取館（阿倍野）をユーザーに報告する。タイトルが曖昧な場合は
  検索結果の候補（logs/のスクショや出力）を見て確認してから確定する

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

- **刻み実行モード（2026-07-04追加・Cowork対応）**: Cowork のサンドボックスは1コマンド約45秒で
  強制終了されるため、`./run.sh --tick` で「1回=1小ステップ」の刻み実行ができる。
  進捗は state/_job.json、ログインCookieは state/_session_*.json（どちらもGit管理外）。
  TICK:DONE が出るまで繰り返し呼ぶ。フェーズ順: 全冊検索→ログイン＋予約一覧照合→全冊予約。
  **重要なサイト仕様**: トップページ（WOpacSmtMnuTopAction.do）を開くとセッションのログイン状態が
  リセットされる。予約フェーズは検索時に保存した書誌詳細URLへ直行することでログインを維持する。
  ヘッダの統計バー（#stat-resv）はログイン後の画面フロー内でのみ描画される。
  二重予約ガード: 予約実行前にサイトの予約状況一覧と照合し、既に予約済みの本は完了扱いにする

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
- 2026-07-04: 母「藍を継ぐ海」は中断された実行の中で予約成功していた（サイトで待ち確認済み・
  台帳/推薦済み/キュー消し込みすべて正常）。**母アカウントは自身の既存予約が多く（待ち14件）、
  上限15のため今週は残り枠1**。スクリプトが自動で見送り処理・レポートする
- 2026-07-05: **運用ホームを Claude Code スケジュール実行に変更**（ユーザー決定。Cowork は
  45秒制限による tick間隔の開きでログインセッションが切れ、予約フェーズが安定しなかった。
  Claude Code 環境は時間制限がなく、1ブラウザセッションで完結するためこの問題が構造的に無い）。
  毎週土曜7時(JST)に新規セッションが起動し SCHEDULE_PROMPT.md の手順を実行する。
  実行はアカウントごとに `./run.sh --account=xxx` ×4（レポートは reports/.cache 経由で自動統合）。
  認証情報は環境変数 OML_* から run.sh が .env を自動生成する
- 2026-07-05: リトルバンパイアの巻タイトルをOPAC実表記（「リトルバンパイア 1 リュディガーと
  アントン」巻数前後スペース）に修正。全13巻のサブタイトルも確定。**シリーズファイルの巻タイトルは
  OPAC表記に合わせること**（数字を詰めると検索ヒットしない）
- 補足: index.js の本番実行では、一時的エラー（例外・中断）はカーソルを進めない。カーソルが進むのは
  台帳に記録した本（予約成功・所蔵なし・予約不可）だけなので、Coworkレポートが懸念した
  「失敗した本のスキップ」は Claude Code 実行では起きない（tickのsession-lost-giveupが3回失敗で
  failed記録していたのが原因。運用移行により解消）
- [ ] Claude Code スケジュール登録 → 週次運用開始

### 2026-07-05 セッション2（Claude Code スケジュール実行・初の全量本番）

- 認証情報が環境変数未登録・.env 無しで起動 → ユーザーからチャットで受領し .env 生成（**コミット禁止**）。
  **恒久対応として OML_CARD_*/OML_PASS_* の8つを Claude Code 環境変数に登録すること**（毎回コンテナ再作成で .env は消える）。
- **予約フローを「全冊カート投入→一括確定」に再設計（ユーザー提案）**。旧「1冊ずつカート投入→確定」は
  2冊目で `WOpacSmtYoyCartBackAction.do` に飛び中断していた。`opac.addToCart()`＝カート投入（各冊）、
  `opac.reserveCartContents()`＝カート一括確定（最後1回）。`opac.emptyCart()` で残留候補を掃除してから投入。
- **成立判定の教訓**: ヘッダの予約中カウント（#stat-resv .value）は null/不安定で増分判定は誤る。
  予約直後にサイト内で予約一覧を開くと**トップ遷移でログアウト**し空になる。→ 予約枠は予約状況一覧の
  有効件数から算出（`Math.max(一覧件数, ヘッダ値)`で保守的に）。枠内バッチは明示的失敗文言が無ければ成立とみなす。
  **成立の最終確認は新規ログインの `scripts/verify-reservations.mjs`（read-only）で行う**（新規追加）。
- 本番結果（一覧で実測確認）: 母=地雷グリコ（イン・ザ・メガチャーチは既に[待ち]、パラ・スターは枠上限で持越し）、
  長女=注文の多い料理店/空気がなくなる日/ヘンダワネのタネの物語/鬼が出た、
  長男=11ぴきのねこ/あほうどり/どうぞのいす/マフィンおばさんのぱんや、
  次男=はらぺこあおむし/バスでおでかけ/どうぶつはやくちあいうえお/ちいさなたまねぎさん。全冊成立。
  ※開発中の版で長女の鬼が出た・次男のちいさなたまねぎさんを一時「見送り」誤判定 → 台帳・進度を訂正済み。
- **連絡方法＝メール（解決済み・実地検証OK）**: 全予約が既定「電話１連絡」になっていた。原因は
  連絡方法セレクト（#receiveWay / name="contact"、メール=value4）の onchange="selectyoyrak" が
  `contactweb=値; action=WOpacSmtYoyPopupRecWebAction.do?webrak=1; submit` でカートを再描画する仕様で、
  値を直接セットするだけ（change非発火）ではサーバがメールを受け付けず電話に戻っていた点。
  → 最終的な正しい実装（reserveCartContents の順序と手段が重要）:
  ① **連絡方法を最初に確定**: 連絡方法セレクトを selectOption でメールにして change を発火→ selectyoyrak が
     WOpacSmtYoyPopupRecWebAction へ遷移しカートを再描画→戻ったカートで連絡方法=メール・contactweb=4 になる
     （別ダイアログ/確認ボタンは無い）。この遷移で受取館・全選択がリセットされるので連絡方法を先に確定する。
  ② **予約候補チェックは JS で直接**: list_chkbox は絶対配置で actionable でなく Playwright の .check() が
     効かないため `b.checked=true` を直接セットする。
  ③ **予約確定はボタンに頼らず exec() 実体を直接実行**: 「予約する」ボタンの onclick=exec() は
     `if(submitFlg){…}` で守られ、①のカート再描画後は **submitFlg=false** のためボタンでは空振りする。
     そこで `checkFlag(); document.LBForm.action="WOpacSmtYoyCartExecAction.do"; document.LBForm.submit()` を
     page.evaluate で直接実行して確定する。
  ④ **成立判定は exec 結果ページ本文の「予約中 N 件」の増分**で見る（#stat-resv は null、予約一覧はトップ
     遷移でログアウト、カート残件数は成立後も残るため、いずれも不可）。※途中、緩い判定が空振りを誤って
     「OK」表示→次男まほうのコップを飛ばす誤りが起きたため、この確実判定に修正。
  実地検証: 次男「まほうのコップ」を予約→読み取りツール（change-contact.mjs 読み取りモード）で
  連絡方法=メールを確認済み。※アカウントにメール登録が前提（ユーザー確認済み：登録済み）。
  探索用 scripts/explore-mail-popup.mjs（予約せず遷移先を調べる）を追加。
  既存予約の一括変更（scripts/change-contact.mjs --apply）は更新POSTがログイン画面に飛び未完成（読み取りは可）。
- **母は同名なら文庫優先（ユーザー指定）**: `rankResults(..., preferBunko)` で文庫版に加点。母(recommend)のみ有効。
- ユーザーフィードバック反映: 『そして、バトンは渡された』(瀬尾まいこ)は既読★3 → history.csv/preferences.md に記録し
  queue から外し『ライオンのおやつ』(小川糸)に差替。
- シリーズ整備: パンどろぼうを第7巻まで追記（最新巻のOPAC表記未確認のため complete は false 継続）。

### 2026-07-06 セッション3（Claude Code スケジュール実行・chonan/jinan のみ）

- ユーザー指示で**母・長女はスキップ**、長男・次男のみ実行。
- **⚠️ 予約確定ステップが両アカウントで不成立（新規予約0冊）**。--plan-only は正常（重複なし）だが、
  本番のカート確定 submit が予約を作れない:
  - chonan: `[reserveCart] page.evaluate: Execution context was destroyed, most likely because of a navigation`
    （確定 submit で例外。再実行1回でも同一箇所で再現＝計2回失敗）。
  - jinan: 例外は出ないが「予約中 7→7 冊で増加なし（未成立）」で3冊とも見送り（わたしは正当な所蔵なし）。
  - read-only `verify-reservations.mjs chonan` で実測: 有効予約は先週の4件のまま（新規0）を確認。
- **根本原因の疑い**: 2026-07-05 に作り直した確定フロー（selectyoyrak 遷移 →
  `WOpacSmtYoyCartExecAction.do` を page.evaluate で直接 submit）が実地では予約を作れていない。
  「連絡方法=メール」対応の実地検証が未了だった箇所。サイト仕様変更 or コードのリグレッションが疑わしい。
  **運用ルールに従いコード修正はせず報告のみ**。証跡: `logs/2026-07-06/chonan/*-ERROR-reserveCart.html`（カート画面）。
- **失敗時の state 破損に注意（今回巻き戻し済み）**: 確定失敗にもかかわらず chonan/queue.json が空に
  ドレインされ、jinan/progress が 3A-8→3A-11 へ誤進行、jinan/reserved に わたし(所蔵なし) が追記されていた。
  実サーバ状態＝コミット済み state と一致（新規予約0）なので `git checkout -- state/` で全て巻き戻した。
  → **確定フロー修正時、失敗パスで queue/progress/reserved を進めてしまうバグも併せて要修正**。

### 2026-07-06 セッション3-続き（不具合の調査・修正・実地検証まで完了）

**上記の「予約確定が不成立」は原因を特定して修正・実地検証済み。実は予約は部分的に成立していた（検出バグ）。**

- **真因は2つ**（実HTML `logs/2026-07-06/chonan/30-ERROR-reserveCart.html` の解析で判明）:
  1. **受取館セレクト（name="receivename"）の onchange="selectloccod" が遷移を伴い、それを await して
     いなかった** → 直後の `page.evaluate` が「Execution context destroyed」で落ちていた（chonan の例外）。
  2. **予約対象は hidden `list_chk_paging`（カンマ区切り資料ID）＋ `schkflg='check'` でサーバへ伝わる**。
     旧コードは `list_chkbox` に checked=true と **change** を送っていたが、実際の選択更新は
     onclick="list_chkClick" が list_chk_paging を書き換える仕組みで change では発火せず不十分だった。
- **さらに成立判定（検出）が誤り**: exec 直後の返却ページは「予約カート」の再描画で、ヘッダの
  「予約中 N 件」は **stale**（実際は成立しても古い件数）。その場で予約一覧を開くとトップ経由で
  **ログアウト**して空になる。→ 旧コードは「N→N 増加なし」で **成立しているのに未成立と誤判定**していた。
  jinan の 7/6 pre-fix 実行は実は きつね/こいぬ/わたしのワンピース を予約できていた（誤って未成立と報告）。
- **修正（src/opac.js `reserveCartContents`）**: ①連絡方法（selectyoyrak）と exec の submit を
  `Promise.all([waitForNavigation, ...])` で確実に待つ。②受取館は selectOption せず、最終 submit の
  evaluate で `receivename`/`returnValue` に value を直接セット。③選択は `list_chk_paging`＝全資料ID、
  `schkflg/allschkflg='check'` を直接セット（selectAll 相当）。④成立判定は exec 直後ページに頼らず、
  **呼び出し側（index.js）が新規ログインし直して予約一覧を取得し、投入タイトルが載ったか冊単位で照合**する
  （verify-reservations.mjs と同じ確実な方法）。
- **state 破損の修正（src/index.js・state.js）**: Queue を `persist:false`（計画中はメモリのみ）にし、
  **予約バッチ成立（batchOk）を確認してから `queue.save()` で消化を確定**。進度・キュー・母queueも
  batchOk のときだけ書き換える（失敗・中断時は一切進めず翌週再試行。成立済みは ledger.has で二重予約回避）。
  ※ `--limit` はテスト専用（planWeek が消化した一部だけ処理するためキュー消化を確定しない）。
- **実地検証OK（本番）**: jinan「ぼくとおとうさん」「ぼくとおかあさん」、chonan「11ぴきのねことぶた」を
  予約→ verify-reservations で [待ち] を確認。検出も進度・キュー確定も正しく動作。
- **state を実サイトに整合済み**: 7/6 に実際は成立していた jinan きつね/こいぬ/わたしのワンピース＋
  検証で予約した ぼくとおとうさん/ぼくとおかあさん を台帳へ記録し progress=3A-14。chonan は とぶた を記録、
  queue=[ふくろのなか, へんなねこ, どろんこ]。両アカウントとも台帳＝サイト一致（chonan 5件 / jinan 12件）。

### 次のセッションでやること（優先度順）

1. `git pull` で本ブランチを最新化（各 progress/reserved/queue を引き継ぐ）。認証は環境変数から。
2. 通常の週次運用（SCHEDULE_PROMPT.md 手順0〜7）。予約確定・検出は修正・実地検証済みなので通常どおり
   `./run.sh --account=xxx` を4アカウント実行してよい（--limit は付けない）。
3. 今回スキップした**母・長女**は次回通常実行に含める（母の queue.json は前回の4冊が入ったまま）。
4. （保留）連絡方法=メールは reserveCartContents で毎回設定している。既存の電話予約を一括変更する機能の
   要否はユーザー確認待ち。
