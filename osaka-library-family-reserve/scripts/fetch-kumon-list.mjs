/**
 * くもんのすいせん図書一覧表（公式PDF）をダウンロードする。
 *   node scripts/fetch-kumon-list.mjs
 *
 * PDF の表は複雑なレイアウトのため、機械抽出は行わない。
 * ダウンロード後、Claude（Cowork / Claude Code セッション）が PDF を読んで
 * data/kumon_list.csv（level,order,title,author）を作成・検証する。
 * ※ このスクリプトは LLM を呼ばない。呼ぶのは対話セッション側。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PDF_URL = "https://www.kumon.ne.jp/dokusho/pdf/suisen.pdf";
const OUT = path.join(ROOT, "data", "suisen.pdf");

const res = await fetch(PDF_URL, {
  headers: { "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)" },
});
if (!res.ok) {
  console.error(`ダウンロード失敗: HTTP ${res.status} ${PDF_URL}`);
  console.error("ネットワーク制限のある環境では実行できません。ローカル(Mac)で実行してください。");
  process.exit(1);
}
fs.writeFileSync(OUT, Buffer.from(await res.arrayBuffer()));
console.log(`保存しました: ${OUT}`);
console.log("次の手順: Claude セッションでこの PDF を読み、data/kumon_list.csv を生成してください。");
