import path from "node:path";
import { ROOT, loadDotEnv, loadAccountsConfig, credentialsFor, todayStr, ensureDir } from "./config.js";
import { Ledger, Progress, Queue, readMomQueue, writeMomQueue, recordMomRecommended } from "./state.js";
import { loadKumonList, flatten, planWeek } from "./kumon.js";
import { makeSeriesResolver } from "./series.js";
import { Opac, pickBestResult } from "./opac.js";
import { writeReport } from "./report.js";

/**
 * メインエントリ。
 *   node src/index.js --all [--dry-run]
 *   node src/index.js --account=chojo [--dry-run]
 */
function parseArgs(argv) {
  const args = { accounts: [], dryRun: false, all: false, planOnly: false };
  for (const a of argv.slice(2)) {
    if (a === "--all") args.all = true;
    else if (a === "--dry-run") args.dryRun = true;
    else if (a === "--plan-only") { args.planOnly = true; args.dryRun = true; }
    else if (a.startsWith("--account=")) args.accounts.push(a.split("=")[1]);
  }
  return args;
}

async function runAccount({ id, account, cfg, dryRun, planOnly, pendingSeries, logRoot }) {
  const section = {
    accountId: id,
    name: account.name,
    mode: account.mode,
    reserved: [],
    failed: [],
    reserveLimit: cfg.opac.reserveLimit,
  };

  const creds = credentialsFor(account);
  if (creds.missing && !planOnly) {
    section.skippedReason = `.env に ${account.envCard} / ${account.envPass} が未設定`;
    return section;
  }

  const ledger = new Ledger(id);
  const quota = account.weeklyQuota ?? 4;

  // ---- 今週の予約候補を決める ----
  let picks = [];
  let progress = null;
  let queue = null;
  let plan = null;

  if (account.mode === "kumon") {
    const flat = flatten(loadKumonList(), cfg.levelOrder);
    progress = new Progress(id, account.startProgress);
    queue = new Queue(id, { persist: !dryRun });
    const resolver = makeSeriesResolver({ pendingSeries, persist: !dryRun });
    plan = planWeek({ flat, progress, queue, ledger, quota, seriesResolver: resolver });
    picks = plan.picks;
  } else {
    // 母: Cowork が置いた data/mom/queue.json を優先消化
    const { file, queue: momQueue } = readMomQueue();
    if (!momQueue || !momQueue.items?.length) {
      section.skippedReason = "選書待ち（data/mom/queue.json が空）";
      return section;
    }
    picks = momQueue.items
      .filter((b) => !ledger.has(b.title))
      .slice(0, quota)
      .map((b) => ({ ...b, from: "mom-queue" }));
    section.momQueueFile = file;
    section.momQueue = momQueue;
  }

  if (!picks.length) {
    section.skippedReason = "予約候補なし（リスト消化済み or すべて予約済み）";
    return section;
  }

  // --plan-only: サイトにアクセスせず計画だけ出す
  if (planOnly) {
    for (const p of picks) section.reserved.push({ title: p.title, note: `計画のみ / ${p.from}` });
    if (plan) section.next = plan.nextProgress;
    return section;
  }

  // ---- OPAC 操作 ----
  const logDir = ensureDir(path.join(logRoot, id));
  const opac = new Opac({
    baseUrl: cfg.opac.baseUrl,
    intervalMs: cfg.opac.requestIntervalMs,
    logDir,
    dryRun,
  });

  try {
    await opac.start();
    await opac.login(creds.card, creds.pass);

    // 予約枠の確認
    const count = await opac.currentReserveCount();
    section.reserveCount = count;
    let available = cfg.opac.reserveLimit - (count ?? 0);
    if (count == null) available = quota; // 取得できない場合は quota まで（レポートに注記）

    for (const pick of picks) {
      if (available <= 0) {
        section.failed.push({ title: pick.title, note: "予約上限に達するため見送り" });
        continue;
      }
      const results = await opac.searchTitle(pick.title);
      const best = results?.length ? pickBestResult(results, pick.title) : null;
      if (!best) {
        section.failed.push({ title: pick.title, note: "所蔵なし・検索ヒットなし" });
        if (!dryRun) ledger.add({ title: pick.title, author: pick.author ?? "", status: "failed", note: "所蔵なし", source: pick.from });
        continue;
      }
      await opac.openResult(best.index);
      const res = await opac.reserveCurrent({ pickupBranch: account.pickupBranch });
      if (res.ok) {
        available -= 1;
        section.reserved.push({ title: pick.title, note: res.dryRun ? "ドライラン" : res.message });
        if (!dryRun) {
          ledger.add({ title: pick.title, author: pick.author ?? "", status: "reserved", source: pick.from });
          if (account.mode === "recommend") {
            recordMomRecommended({ title: pick.title, author: pick.author ?? "" });
          }
        }
      } else {
        section.failed.push({ title: pick.title, note: res.message });
        if (!dryRun) ledger.add({ title: pick.title, author: pick.author ?? "", status: "failed", note: res.message, source: pick.from });
      }
    }

    await opac.logout();
  } catch (err) {
    section.failed.push({ title: "(実行中断)", note: err.message });
  } finally {
    await opac.close();
  }

  // ---- 実行後の状態更新（本番のみ）----
  if (!dryRun) {
    if (account.mode === "kumon" && plan) {
      progress.set(plan.nextProgress.level, plan.nextProgress.position);
      section.next = plan.nextProgress;
    }
    if (account.mode === "recommend" && section.momQueue) {
      const reservedTitles = new Set(section.reserved.map((b) => b.title));
      section.momQueue.items = section.momQueue.items.filter((b) => !reservedTitles.has(b.title));
      writeMomQueue(section.momQueueFile, section.momQueue);
    }
  } else if (account.mode === "kumon" && plan) {
    section.next = plan.nextProgress;
  }

  return section;
}

async function main() {
  loadDotEnv();
  const cfg = loadAccountsConfig();
  const args = parseArgs(process.argv);

  const ids = args.accounts.length ? args.accounts : Object.keys(cfg.accounts);
  for (const id of ids) {
    if (!cfg.accounts[id]) {
      console.error(`不明なアカウント: ${id}（accounts.json のキー: ${Object.keys(cfg.accounts).join(", ")}）`);
      process.exit(1);
    }
  }

  const logRoot = path.join(ROOT, "logs", todayStr());
  const pendingSeries = [];
  const sections = [];

  console.log(`=== 大阪市立図書館 自動予約 ${args.dryRun ? "【ドライラン】" : "【本番】"} ===`);
  for (const id of ids) {
    console.log(`\n--- ${id} (${cfg.accounts[id].name}) ---`);
    const section = await runAccount({
      id,
      account: cfg.accounts[id],
      cfg,
      dryRun: args.dryRun,
      planOnly: args.planOnly,
      pendingSeries,
      logRoot,
    });
    for (const b of section.reserved) console.log(`  OK ${b.title}`);
    for (const b of section.failed) console.log(`  NG ${b.title} — ${b.note}`);
    if (section.skippedReason) console.log(`  SKIP ${section.skippedReason}`);
    sections.push(section);
  }

  const file = writeReport({ dryRun: args.dryRun, sections, pendingSeries });
  console.log(`\nレポート: ${path.relative(process.cwd(), file)}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
