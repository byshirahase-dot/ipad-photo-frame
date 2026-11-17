// 読んだかチェックリストを作る（図書館サイトへのアクセスなし・予約操作なし）。
// 使い方:
//   node scripts/reading-checklist.mjs [--weeks=4] [--recorded=state/_reading/sheet.json]
// --recorded: 読書記録シートから書き写した記録済みの題名 {"<子どもの名前 or アカウントID>": ["題名", ...]}
// 出力: state/_reading/checklist-latest.{md,json}（番号は record-reading.mjs の --numbers と対応）
import fs from "node:fs";
import path from "node:path";
import { ROOT, ensureDir, loadAccountsConfig, todayStr } from "../src/config.js";
import { Ledger } from "../src/state.js";
import {
  READING_DIR, loadLocalConfig, loadLoanSnapshots, buildChecklist, formatChecklist,
  loadRecorded, mergeRecorded, saveRecorded,
} from "./lib/reading-link.mjs";

const args = process.argv.slice(2);
const opt = (name, def = null) => {
  const a = args.find((x) => x.startsWith(`--${name}=`));
  return a ? a.slice(name.length + 3) : def;
};
const weeks = Number(opt("weeks", "4"));
const cfg = loadAccountsConfig();
const local = loadLocalConfig();

let recorded = loadRecorded();
const recFile = opt("recorded");
if (recFile) {
  const input = JSON.parse(fs.readFileSync(path.resolve(ROOT, recFile), "utf8"));
  recorded = mergeRecorded(recorded, input, local.names ?? {}, "sheet");
  saveRecorded(recorded);
}

const result = { created: todayStr(), weeks, snapshotDate: "", accounts: [] };
for (const [id, acc] of Object.entries(cfg.accounts)) {
  if (acc.mode !== "kumon") continue;
  const snapshots = loadLoanSnapshots(id, { weeks });
  const ledger = new Ledger(id);
  const r = buildChecklist({
    books: ledger.data.books,
    snapshots,
    recordedTitles: (recorded[id] ?? []).map((x) => x.title),
  });
  if (r.latestDate && r.latestDate > result.snapshotDate) result.snapshotDate = r.latestDate;
  result.accounts.push({ id, label: acc.name, items: r.items, others: r.others, recorded: r.recorded });
}

const md = formatChecklist(result);
ensureDir(READING_DIR);
fs.writeFileSync(path.join(READING_DIR, "checklist-latest.json"), JSON.stringify(result, null, 2) + "\n");
fs.writeFileSync(path.join(READING_DIR, "checklist-latest.md"), md + "\n");
fs.writeFileSync(path.join(READING_DIR, `checklist-${result.snapshotDate || result.created}.json`), JSON.stringify(result, null, 2) + "\n");
console.log(md);
for (const a of result.accounts) {
  console.error(`[${a.id}] 掲載 ${a.items.length}冊 / 記録済みで除外 ${a.recorded}冊 / 自動予約以外の貸出 ${a.others}冊`);
}
