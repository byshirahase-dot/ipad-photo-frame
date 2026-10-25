# CLAUDE.md — mercari-photo-tool

## プロジェクト概要
メルカリ出品写真の加工（背景のイブル化・影除去・明るさ補正・文字入れ）を、写真を入れてボタンを押すだけでまとめて処理できるローカルツール。

### 要件
- ローカルで動くブラウザUI（Gradio）。複数枚の写真をドラッグ&ドロップで投入
- 処理内容（それぞれオン/オフ切替可）
  1. 背景の差し替え：rembg（ローカルAI）で商品だけ切り抜き、背景をイブル画像に置き換える（元の背景の余計な物や影も消す）
     - 背景画像は `backgrounds/` に入れたものを使う。複数あればUIで選べる。白背景も選択肢に残す
     - 背景画像からランダムな位置・わずかな回転で切り出し、毎回同じ見た目にならないようにする
     - 商品の下に柔らかい接地影（濃さ調整可）
     - 背景の明るさ・色味を商品側に合わせてなじませる
  2. 明るさ・ホワイトバランスの自動補正（控えめに）
  3. 商品を中央にして正方形（1080×1080）。商品の大きさ（画面に占める割合）は調整可
  4. 文字入れ：プリセット（裁断済み/未使用/新品/美品/サイズ130 等）をチェックボックスで選択＋自由入力。帯付きで角に配置。「1枚目だけ」か「全部」を選べる
  5. 文字のプリセット・位置・色は設定ファイル（`config.yaml`）で編集できる
- 処理前後をプレビューで並べて比較。切り抜き失敗の写真は背景差し替えなしで出し直せる
- 出力は日付付きフォルダ（`output/YYYY-MM-DD/`）。元画像・背景画像は上書き・削除しない
- 同じWi-Fi内の iPhone Safari からも使える（手順は README）
- ダブルクリック1つで起動（`start.command`）
- 有料APIは使わず、すべてローカル処理。文字は日本語フォント（ヒラギノ等）

## 進め方のルール（ユーザー指示）
- 作業フォルダ: `~/Documents/claude-projects/mercari-photo-tool`
  - ※初回の作業はクラウドセッションで行ったため、GitHub リポジトリ `byshirahase-dot/ipad-photo-frame` のブランチ `claude/stoic-euler-fmmpgx` 内の `mercari-photo-tool/` に作成・push 済み。Mac への取り込み手順は README「1-2」
- 進めるか否かの確認をできるだけ少なくし、自律的に進める（auto モード: `--enable-auto-mode`）
- 自らテストを行いエラーを修正する
- できるだけ API 消費（トークン）が少ない方法を選ぶ（必要なファイルだけ読む・まとめて編集する）
- 進捗を定期的にこの `CLAUDE.md` に記録し、セッションが予期せず終了しても続けられるようにする
- iPhone からも操作できるように Remote Control を On にする（Mac のこのフォルダで `claude remote-control` を実行するか、Claude デスクトップアプリから。iPhone の Claude アプリに表示される）
- これらの指示を `CLAUDE.md` に記載しておく（＝このファイル）

## 構成
```
app.py                     Gradio 画面。run_batch（まとめて処理）/ 出し直し / 前後比較 / 写真に保存一覧 / 文字の追加削除 / https
photo_tool/config.py       config.yaml 読み込み（既定値とマージ）
photo_tool/pipeline.py     1枚の処理: 読込(HEIC対応, 最大2400px) → 補正 → 切り抜き → 配置 → 背景+影 → 文字
photo_tool/segment.py      rembg 切り抜き。離れた小物の除去、縁の色にじみ除去、失敗判定（面積・端・バラバラ・境目のあいまいさ）
photo_tool/background.py   背景のランダム切り出し(回転・反転)、明るさそろえ、なじませ(明るさ/色かぶり)、接地影、合成
photo_tool/enhance.py      ホワイトバランス(白っぽい部分の色かぶり, ±12%上限) と 明るさ(上限1.35倍+中間調ガンマ)
photo_tool/layout.py       中央寄せ・正方形化、背景なし時の余白（ぼかし or 白）
photo_tool/text_overlay.py 帯付き文字。ヒラギノ角ゴ W6 → Linux/Windows フォントの順で探す
tests/                     pytest（slow マーカー = AIモデルを使うテスト）。samples.py で合成テスト画像
tools/make_sample_background.py  見本のイブル風背景を生成
```

## コマンド
- 起動: `./start.command`（初回は .venv 作成と pip install。uv があれば uv を使用）または `.venv/bin/python app.py`
- テスト: `.venv/bin/python -m pytest -q`（モデル不要のものだけ: `-m "not slow"`）
- UI確認: Playwright（Node）で http://127.0.0.1:7860 を操作してスクリーンショット
- 注意: サーバー停止に `pkill -f "python app.py"` を使うと、そのコマンド自身のシェルも巻き込んで終了することがある

## 技術メモ
- Gradio 6 系: `theme` / `css` は `launch()` に渡す。`gr.Image(buttons=[...])`。外部フォントを読まないよう theme の font/font_mono はシステムフォント指定
- rembg 2.0.8x: モデルは `~/.rembg/models/` に保存。既定モデル `isnet-general-use`（約180MB）。起動時に別スレッドで warmup
- `post_process_mask` は縁が硬くなるので使わず、独自にクリーンアップ
- 出し直しは同じ出力ファイルを上書き（このツールの出力のみ）。新規保存は同名があれば `_2`, `_3`
- 空きポート探索は SO_REUSEADDR 付き（終了直後の 7860 も再利用できる）

## 進捗ログ
- 2026-10-25（クラウドセッション）
  - [x] 全機能を実装（背景差し替え・接地影・なじませ・補正・正方形・文字入れ・出し直し・ZIP・iPhone用QR）
  - [x] pytest 17件すべて成功（AIモデル使用テスト含む）
  - [x] Playwright でデスクトップ / iPhone 幅の操作テスト成功（処理 → 前後比較 → 背景なしで出し直し → 今の設定で出し直し）
  - [x] start.command を Linux 上で初回セットアップから起動まで確認（Mac 実機は未確認）
  - [x] README（Mac 導入・起動・iPhone 手順・設定・トラブル対応）
  - [x] ユーザー提供のイブル写真2枚（グレー系・白い布が暗めに写っている）を `backgrounds/ibul_gray_1.jpg`, `ibul_gray_2.jpg` として追加。見本 `sample_ibul_pink.jpg` は削除
  - [x] 背景の明るさそろえ（normalize_brightness: 白点合わせ＋ガンマで中間の明るさを目標値に。UIスライダー「背景の明るさ」既定0.78）を追加
  - [x] 柄が細かすぎたので切り出し範囲を 0.55〜0.9 → 0.4〜0.65 に変更。なじませの明るさ補正幅を 0.75〜1.1 に拡大
  - [x] ユーザー要望で「柄は細かめ・背景はもう少し明るく」: 切り出し範囲 0.6〜0.85、背景の明るさ既定 0.85 に変更
  - [x] ZIP ダウンロードを廃止し「③ iPhoneの写真に保存」（長押し保存用の画像一覧 gr.HTML）を追加。https 時は Web Share API で「まとめて写真に保存」ボタン（http では非表示：secure context が必要なため）
  - [x] `server.https: true` で自己署名証明書（openssl, `.cert/`、IP が変わったら再作成）を使って https 起動。コンテナ内で https 経由の処理まで確認
  - [x] HEIC 読み込みをテストで確認（pillow-heif で HEIC を作成 → 処理、画面からのアップロードも確認）
  - [x] 「よく使う文字を追加・削除」を画面に追加（config.yaml の text.presets だけを書き換え、コメントは保持）。追加時は自動チェック＋「文字を入れる」をオン
  - [x] 文字帯の色をくすみブルー `#6E87A0` に変更（候補 #8296AB / #6E87A0 / #5A7491 を比較して決定）
- 未確認・次にやること
  - [ ] iPhone 実機で長押し保存・https モードの「まとめて写真に保存」（共有メニュー）を確認
  - [ ] Mac 実機で start.command のダブルクリック起動・ヒラギノフォント・iPhone からの接続を確認
  - [ ] 実際の商品写真で仕上がりを確認し、影の濃さ・背景の明るさ・なじませ・補正の既定値を調整（イブル背景は合成テスト画像で確認済み）
  - [ ] （必要なら）切り抜きが苦手な商品で `birefnet-general-lite` を比較
