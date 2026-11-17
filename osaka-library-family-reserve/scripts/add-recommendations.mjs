// 子供読書アプリのおすすめ本を、その子の予約キュー（state/{id}/queue.json）の先頭へ足す。
// 公文リスト・絵本ナビ・シリーズ巻・台帳・キューのどこにも無い本だけを足す。図書館サイトには触れない。
// 使い方:
//   node scripts/add-recommendations.mjs --file=state/_reading/reco.json [--dry-run]
//   reco.json: { "items": [ { "account": "chojo", "title": "題名", "author": "著者", "publisher": "出版社" } ] }
//   account は chojo/chonan/jinan のほか 長女/長男/次男 でもよい。
import fs from "node:fs";
import path from "node:path";
import { ROOT, loadAccountsConfig, todayStr } from "../src/config.js";
import { Ledger, Queue } from "../src/state.js";
import { loadKumonList, loadEhonnaviList } from "../src/kumon.js";
import { judgeRecommendation } from "./lib/reading-link.mjs";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const fileArg = args.find((x) => x.startsWith("--file="));
if (!fileArg) {
  console.error("ERROR: --file=... を指定してください");
  process.exit(1);
}
const cfg = loadAccountsConfig();
const input = JSON.parse(fs.readFileSync(path.resolve(ROOT, fileArg.slice(7)), "utf8"));
const idOf = (a) => (cfg.accounts[a] ? a : Object.keys(cfg.accounts).find((id) => cfg.accounts[id].name === a));

const kumonRows = loadKumonList();
const seriesDir = path.join(ROOT, "data", "series");
const seriesVolumes = [];
for (const f of fs.readdirSync(seriesDir)) {
  if (!f.endsWith(".json") || f.startsWith("_")) continue;
  const s = JSON.parse(fs.readFileSync(path.join(seriesDir, f), "utf8"));
  for (const v of s.volumes ?? []) seriesVolumes.push({ series: s.name, title: v.title });
}

const byAccount = new Map();
for (const it of input.items ?? []) {
  const id = idOf(String(it.account ?? "").trim());
  if (!id || cfg.accounts[id].mode !== "kumon") {
    console.log(`NG アカウント不明: ${it.account} / ${it.title}`);
    continue;
  }
  if (!byAccount.has(id)) byAccount.set(id, []);
  byAccount.get(id).push(it);
}

for (const [id, items] of byAccount) {
  const acc = cfg.accounts[id];
  const ledger = new Ledger(id);
  const queue = new Queue(id, { persist: false });
  const ehonnaviRows = loadEhonnaviList(acc.ehonnaviAge ?? null);
  const toAdd = [];
  for (const it of items) {
    const j = judgeRecommendation(it, {
      kumonRows, ehonnaviRows, seriesVolumes,
      ledgerBooks: ledger.data.books,
      queueItems: [...queue.data.items, ...toAdd],
    });
    if (j.action === "skip") {
      console.log(`SKIP ${acc.name}: ${it.title} — ${j.reason}`);
      continue;
    }
    toAdd.push({
      title: String(it.title).trim(),
      author: String(it.author ?? "").trim(),
      ...(it.publisher ? { publisher: String(it.publisher).trim() } : {}),
      from: `reco:子供読書アプリ(${todayStr()})`,
    });
    console.log(`${dryRun ? "DRY-RUN 追加予定" : "ADD"} ${acc.name}: ${it.title}${it.publisher ? `（${it.publisher}）` : ""}`);
  }
  if (toAdd.length && !dryRun) {
    queue.data.items.unshift(...toAdd);
    queue.save();
  }
}
