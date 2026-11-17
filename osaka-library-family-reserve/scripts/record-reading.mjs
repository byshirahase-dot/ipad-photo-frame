// 読んだ本を読書記録フォーム（Googleフォーム「子どもの読書記録」）へ送る。図書館サイトには触れない。
// 使い方:
//   node scripts/record-reading.mjs --account=chojo --numbers=1,3 [--date=YYYY-MM-DD] [--dry-run]
//   node scripts/record-reading.mjs --account=chojo --title="題名" [--title="題名2"] [--dry-run]
// --numbers は state/_reading/checklist-latest.json の番号。--date 省略時は今日（読んだ日として記録）。
// 送信できた本は state/_reading/recorded.json に残り、次回のチェックリストから消える。
import fs from "node:fs";
import path from "node:path";
import { loadAccountsConfig, todayStr } from "../src/config.js";
import { Ledger } from "../src/state.js";
import { READING_DIR, loadLocalConfig, loadRecorded, mergeRecorded, saveRecorded, formBody } from "./lib/reading-link.mjs";

const args = process.argv.slice(2);
const opt = (name) => args.filter((x) => x.startsWith(`--${name}=`)).map((x) => x.slice(name.length + 3));
const dryRun = args.includes("--dry-run");
const force = args.includes("--force");
const account = opt("account")[0];
const date = opt("date")[0] ?? todayStr();
const cfg = loadAccountsConfig();
const local = loadLocalConfig();

if (!account || !cfg.accounts[account]) {
  console.error("ERROR: --account=chojo|chonan|jinan を指定してください");
  process.exit(1);
}
const name = local.names?.[account];
if (!name) {
  console.error(`ERROR: reading.local.json の names に ${account} がありません`);
  process.exit(1);
}
if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
  console.error("ERROR: --date は YYYY-MM-DD で指定してください");
  process.exit(1);
}

const titles = [...opt("title")];
const numbers = opt("numbers").flatMap((s) => s.split(",")).map((s) => Number(s.trim())).filter(Boolean);
if (numbers.length) {
  const file = path.join(READING_DIR, "checklist-latest.json");
  if (!fs.existsSync(file)) {
    console.error("ERROR: チェックリストがありません。先に node scripts/reading-checklist.mjs を実行してください");
    process.exit(1);
  }
  const list = JSON.parse(fs.readFileSync(file, "utf8")).accounts.find((a) => a.id === account);
  for (const n of numbers) {
    const it = list?.items.find((x) => x.no === n);
    if (!it) {
      console.error(`ERROR: ${cfg.accounts[account].name} のチェックリストに ${n} 番がありません`);
      process.exit(1);
    }
    titles.push(it.title);
  }
}
if (!titles.length) {
  console.error("ERROR: --numbers か --title を指定してください");
  process.exit(1);
}

let recorded = loadRecorded();
const url = `https://docs.google.com/forms/d/e/${local.form.id}/formResponse`;
let failed = 0;
for (const title of titles) {
  const already = (recorded[account] ?? []).some((r) => Ledger.key(r.title) === Ledger.key(title));
  if (already && !force) {
    console.log(`SKIP 記録済み: ${title}`);
    continue;
  }
  if (dryRun) {
    console.log(`DRY-RUN 送信予定: ${cfg.accounts[account].name} / ${title} / ${date}`);
    continue;
  }
  let ok = false;
  let detail = "";
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "Accept-Language": "ja" },
      body: formBody(local.form, { name, title, date }).toString(),
    });
    const text = await res.text();
    // 成功時は「回答を記録しました」の確認ページ（HTTP 200）が返る
    ok = res.status === 200 && /回答を記録しました|Your response has been recorded|ConfirmationMessage/.test(text);
    detail = `HTTP ${res.status}`;
  } catch (e) {
    detail = e.message;
  }
  if (ok) {
    recorded = mergeRecorded(recorded, { [account]: [{ title, date, via: "form" }] }, local.names ?? {});
    saveRecorded(recorded);
    console.log(`OK 記録: ${cfg.accounts[account].name} / ${title} / ${date}`);
  } else {
    failed += 1;
    console.log(`NG 送信を確認できず（再送しない・要確認）: ${title} [${detail}]`);
  }
  await new Promise((r) => setTimeout(r, 1500));
}
process.exit(failed ? 2 : 0);
