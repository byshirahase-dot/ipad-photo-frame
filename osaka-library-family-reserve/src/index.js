import path from "node:path";
import { ROOT, loadDotEnv, loadAccountsConfig, credentialsFor, todayStr, ensureDir } from "./config.js";
import { Ledger, Progress, Queue, readMomQueue, writeMomQueue, recordMomRecommended } from "./state.js";
import { loadKumonList, flatten, planWeek } from "./kumon.js";
import { makeSeriesResolver } from "./series.js";
import { Opac, rankResults } from "./opac.js";
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
    else if (a.startsWith("--limit=")) args.limit = Number(a.split("=")[1]);
  }
  return args;
}

async function runAccount({ id, account, cfg, dryRun, planOnly, limit, pendingSeries, logRoot }) {
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
    plan = planWeek({
      flat, progress, queue, ledger, quota,
      seriesResolver: resolver,
      seriesPerWeek: cfg.seriesPerWeek ?? 2,
    });
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

  if (limit > 0) picks = picks.slice(0, limit);

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

  // 進度カーソル: 「実際に処理し終えた本」の分だけ進める（中断時に本を取りこぼさない）
  let cursor = null;

  try {
    await opac.start();
    await opac.login(creds.card, creds.pass);

    // 予約枠の確認。
    // ヘッダの予約中カウント（#stat-resv）は画面によって取得できず null になったり
    // 実数とずれることがあるため、予約状況一覧の「有効な予約数」を主に使う。
    // 上限判定は過剰予約（＝上限超過でサイトがバッチ全体を拒否）を避けるため保守的に、
    // 一覧の有効数とヘッダ値の大きい方を採用する。
    const cancelledRe = /取消|期限切れ|無効/;
    const states = await opac.listReservationStates();
    const activeStates = states.filter((s) => s.state && !cancelledRe.test(s.state));
    const headerCount = await opac.currentReserveCount();
    const count = Math.max(activeStates.length, headerCount ?? 0);
    section.reserveCount = count;
    let available = cfg.opac.reserveLimit - count;
    if (available < 0) available = 0;

    // 取消された予約（＝借りられなかった本）を検出し、予約対象リストに戻す。
    // サイト仕様: 取り置き期限切れ・延滞ペナルティによる無効化は「取消」と表示されて一覧に残る。
    // 利用者が手動で取り消したものは一覧から消えるため、残っている「取消」は借りられなかった本。
    section.requeued = [];
    // 同じ本に有効な予約（待ち・用意等）がある場合、その「取消」行は過去の再予約済みの残骸なので無視
    const activeKeys = new Set(activeStates.map((s) => Ledger.key(s.title)));
    for (const s of states) {
      if (!cancelledRe.test(s.state)) continue;
      if (activeKeys.has(Ledger.key(s.title))) continue;
      const entry = ledger.findActiveReserved(s.title);
      if (!entry) continue; // 台帳に無い（このシステムの予約でない・処理済み）ものは無視
      section.requeued.push({ title: entry.title, state: s.state });
      if (!dryRun) {
        ledger.markExpired(entry, `予約${s.state}（期限切れ・延滞ペナルティ等）のため再予約対象に戻した`);
        if (account.mode === "kumon") {
          queue.unshift({ title: entry.title, author: entry.author ?? "", from: "requeue:予約取消" });
        } else if (section.momQueue) {
          section.momQueue.items.unshift({ title: entry.title, author: entry.author ?? "", reason: "予約取消の再予約" });
        }
      }
    }

    // 残留した予約候補が混ざらないよう、カートを空にしてから投入する
    if (!dryRun && available > 0) {
      await opac.emptyCart();
    }

    // ---- フェーズ1: 枠の分だけ書名を検索してカートに投入する ----
    // サイト仕様上、予約確定はカート内をまとめて1回で行う（1冊ずつ確定を繰り返すと中断する）。
    const inCart = []; // カート投入に成功した pick（確定対象）
    for (const pick of picks) {
      if (inCart.length >= available) {
        section.failed.push({ title: pick.title, note: "予約上限に達するため見送り" });
        continue;
      }
      const results = await opac.searchTitle(pick.title);
      // 母（recommend）は同名なら文庫版を優先して予約する（ユーザー指定）
      const candidates = results?.length
        ? rankResults(results, pick.title, 3, account.mode === "recommend")
        : [];
      if (!candidates.length) {
        section.failed.push({ title: pick.title, note: "所蔵なし・検索ヒットなし" });
        if (!dryRun) {
          ledger.add({ title: pick.title, author: pick.author ?? "", status: "failed", note: "所蔵なし", source: pick.from });
          if (pick.advanceTo) cursor = pick.advanceTo;
        }
        continue;
      }
      // 予約不可の版（大型絵本等）は次の候補へフォールバック
      let add = null;
      for (let ci = 0; ci < candidates.length; ci++) {
        await opac.openResult(candidates[ci].index);
        add = await opac.addToCart();
        if (!add || add.ok || !add.notReservable) break;
        if (ci < candidates.length - 1) await opac.backToResults();
      }
      if (add && add.ok) {
        if (add.dryRun) {
          // ドライランはカートに入れず「予約可能」を計画として記録
          section.reserved.push({ title: pick.title, note: "ドライラン" });
        } else {
          inCart.push(pick);
        }
      } else {
        section.failed.push({ title: pick.title, note: add?.message ?? "カート投入失敗" });
        if (!dryRun) {
          ledger.add({ title: pick.title, author: pick.author ?? "", status: "failed", note: add?.message ?? "カート投入失敗", source: pick.from });
          if (pick.advanceTo) cursor = pick.advanceTo;
        }
      }
    }

    // ---- フェーズ2: カート内をまとめて予約確定する ----
    if (!dryRun && inCart.length > 0) {
      const rres = await opac.reserveCartContents({
        pickupBranch: account.pickupBranch,
        contactMethod: account.contactMethod ?? cfg.opac.contactMethod,
        countBefore: count,
      });
      // 予約枠内のバッチはサイト仕様上まとめて成立する。rres.ok（明示的な失敗文言が無い）なら
      // カート投入した全冊を成立として台帳へ記録する。成立冊数の最終確認は
      // scripts/verify-reservations.mjs（新規ログインでの予約一覧照合）で別途行う。
      for (const pick of inCart) {
        if (rres.ok) {
          section.reserved.push({ title: pick.title, note: rres.message });
          ledger.add({ title: pick.title, author: pick.author ?? "", status: "reserved", source: pick.from });
          if (pick.advanceTo) cursor = pick.advanceTo;
          if (account.mode === "recommend") {
            recordMomRecommended({ title: pick.title, author: pick.author ?? "" });
          }
        } else {
          // 確定に失敗（上限到達等）した場合は台帳・カーソルを動かさず翌週へ持ち越す
          section.failed.push({ title: pick.title, note: `予約確定できず見送り（${rres.message}）` });
        }
      }
    }

    await opac.logout();
  } catch (err) {
    section.failed.push({ title: "(実行中断)", note: err.message });
  } finally {
    await opac.close();
  }

  // ---- 実行後の状態更新（本番のみ・処理し終えた本の分だけカーソルを進める）----
  if (!dryRun) {
    if (account.mode === "kumon" && cursor) {
      progress.set(cursor.level, cursor.position);
      section.next = cursor;
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
      limit: args.limit ?? 0,
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
