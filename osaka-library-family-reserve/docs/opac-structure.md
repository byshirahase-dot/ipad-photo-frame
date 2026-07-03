# 大阪市立図書館 Web-OPAC 構造メモ

## 確認済みURL（WebSearch 経由、2026-07-03）

システムは `licsxp-opac`（LICS-Re 系）。ベース: `https://www.oml.city.osaka.lg.jp/licsxp-opac/`

| 画面 | URL |
|---|---|
| トップ | `WOpacSmtMnuTopAction.do` |
| かんたん検索 | `WOpacEsSchCmpdDispAction.do?moveToGamenId=esschcmpd` |
| ログイン認証 | `WOpacMnuTopInitAction.do?WebLinkFlag=1&moveToGamenId=usrrsv` |
| 利用開始申請 | `WOpacMnuTopInitAction.do?WebLinkFlag=1&moveToGamenId=aplmenu` |

## 未検証事項（初回ドライランで確認・調整する）

この開発セッションのクラウド環境はネットワーク制限があり、実ページのHTMLを取得できなかった。
`src/opac.js` のロケータは LICS-Re 系 OPAC の一般的な構造（ラベルテキスト・ボタン文言ベース＋
フォールバック）で書いてある。初回 `--dry-run` 実行時に必ず以下を確認する:

1. ログインフォームの入力欄（カード番号・パスワード）が正しく埋まるか
2. 検索結果一覧から書誌詳細リンクを正しく拾えているか（`pickBestResult` の選定含む）
3. 予約ボタン → 受取館セレクト（「阿倍野」を含む option）→ 確認 → 決定 の遷移
4. 予約中冊数の取得（`currentReserveCount`）

ズレていた場合、直すのは `src/opac.js` のロケータ候補配列だけでよい。
各ステップで logs/YYYY-MM-DD/{account}/ に連番スクリーンショットと HTML が残るので、
それを見て `firstVisible([...])` の候補を実際の name/id/文言に合わせる。

## マナー

- 各ナビゲーション前に `requestIntervalMs`（5秒）待つ
- リトライは最小限（accounts.json: maxRetries=1）
- 実行は週1回、1アカウント最大4冊ぶんの検索＋予約のみ
