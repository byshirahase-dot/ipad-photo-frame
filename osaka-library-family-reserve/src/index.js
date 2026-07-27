import path from "node:path";
import { ROOT, loadDotEnv, loadAccountsConfig, credentialsFor, todayStr, ensureDir } from "./config.js";
import { Ledger, Progress, Queue, readMomQueue, writeMomQueue, recordMomRecommended } from "./state.js";
import { loadKumonList, flatten, planWeek, loadEhonnaviList } from "./kumon.js";
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
    else if (a.startsWith("--title=")) args.title = a.slice("--title=".length);
    else if (a.startsWith("--author=")) args.author = a.slice("--author=".length);
  }
  return args;
}

async function runAccount({ id, account, cfg, dryRun, planOnly, limit, adhoc, pendingSeries, logRoot }) {
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

  if (adhoc) {
    // 単発予約モード: 「この本を◯◯のアカウントで予約して」用。進度・キューには触れない
    if (ledger.has(adhoc.title)) {
      section.skippedReason = `「${adhoc.title}」は台帳に記録済み（予約済み・処理済み）です`;
      return section;
    }
    picks = [{ title: adhoc.title, author: adhoc.author ?? "", from: "adhoc" }];
  } else if (account.mode === "kumon") {
    const flat = flatten(loadKumonList(), cfg.levelOrder);
    progress = new Progress(id, account.startProgress);
    // 消化（shift）や展開（push）は計画段階で起きるが、予約が実際に成立するまで
    // ファイルへ確定させない（persist:false=メモリ内のみ）。確定は本番実行の最後に
    // batchOk（＝予約バッチ成立）を確認してから queue.save() で行う。
    // 過去、planWeek の shift が即ファイル書き込みされ、予約失敗時にキューが空になり
    // シリーズ続巻が失われる不具合があったため。
    queue = new Queue(id, { persist: false });
    const resolver = makeSeriesResolver({ pendingSeries, persist: !dryRun });
    // 絵本ナビ枠（年齢帯で絞ったリスト）。account.ehonnaviAge が無ければ枠なし
    const ehonnaviList = account.ehonnaviAge != null ? loadEhonnaviList(account.ehonnaviAge) : [];
    plan = planWeek({
      flat, progress, queue, ledger, quota,
      seriesResolver: resolver,
      seriesPerWeek: cfg.seriesPerWeek ?? 2,
      ehonnaviList,
      ehonnaviPerWeek: account.ehonnaviPerWeek ?? cfg.ehonnaviPerWeek ?? 0,
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
  // batchOk: 予約バッチが成立し、進度・キューの消化を確定してよいか。
  // 予約失敗や実行中断（例外）では false のままにし、進度・キューを一切進めない
  // （所蔵なし等で台帳に記録済みの本は ledger.has で翌週スキップされるので取りこぼさない）。
  let batchOk = false;

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

    // 取消された予約を検出し、（借りられなかった本だけを）予約対象リストに戻す。
    // サイト仕様: 取り置き期限切れ・延滞ペナルティによる無効化は「取消」と表示されて一覧に残る。
    // 利用者が手動で取り消したものは一覧から消える。
    // ★重要（2026-07-20修正）: 予約を受け取って**借りた**本も一覧では「取消」表示になり、
    //   active な予約行も残らない。旧実装はこれを「借りられなかった本」と誤判定して再予約対象に
    //   戻し、翌週「既に貸出中の書誌です。予約できません。」でカート全体を巻き添えにしていた。
    //   → 貸出中一覧（listLoanTitles）と照合し、借用中の本は borrowed（終了扱い）にして戻さない。
    const loanTitles = await opac.listLoanTitles();
    const loanKeys = loanTitles.map((t) => Ledger.key(t));
    section.requeued = [];
    section.fulfilled = [];
    for (const s of states) {
      if (!cancelledRe.test(s.state)) continue;
      const entry = ledger.findActiveReserved(s.title);
      if (!entry) continue; // 台帳に無い（このシステムの予約でない・処理済み）ものは無視
      const entryKey = Ledger.key(entry.title);
      // 同じ本の有効な予約（待ち・用意等）が一覧に残っていれば、その「取消」行は再予約済みの
      // 残骸なので無視する。版の違い（例:「ちいさなたまねぎさん こどものくに傑作絵本 19」と
      // 「〜傑作絵本」）で完全一致しないことがあるため、台帳エントリ名を軸に部分一致で判定する。
      const stillActive = activeStates.some((a) => {
        const ak = Ledger.key(a.title);
        return ak === entryKey || ak.includes(entryKey) || entryKey.includes(ak);
      });
      if (stillActive) continue;
      // 借用中（受取済み）なら予約は成就している。再予約せず終了扱いにする。
      const onLoan = loanKeys.some((lk) => lk === entryKey || lk.includes(entryKey) || entryKey.includes(lk));
      if (onLoan) {
        section.fulfilled.push({ title: entry.title });
        if (!dryRun) ledger.markBorrowed(entry);
        continue;
      }
      // 借用中でない「取消」＝取り置き期限切れ等で借りられなかった本 → 再予約対象へ戻す。
      section.requeued.push({ title: entry.title, state: s.state });
      if (!dryRun) {
        ledger.markExpired(entry, `予約${s.state}（期限切れ・延滞ペナルティ等）のため再予約対象に戻した`);
        if (account.mode === "kumon" && queue) {
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
      // 既に借りている本はカートに入れない（入れると「既に貸出中の書誌です」でカート全体が
      // 巻き添えで確定失敗する）。借用中＝予約の必要なし。台帳に借用済みとして記録して進める。
      const pk = Ledger.key(pick.title);
      const alreadyOnLoan = loanKeys.some((lk) => lk === pk || lk.includes(pk) || pk.includes(lk));
      if (alreadyOnLoan) {
        section.fulfilled.push({ title: pick.title, note: "既に借用中のためスキップ" });
        if (!dryRun && pick.from !== "adhoc" && !ledger.has(pick.title)) {
          ledger.add({ title: pick.title, author: pick.author ?? "", status: "borrowed", note: "既に貸出中のためスキップ", source: pick.from });
        }
        if (pick.advanceTo) cursor = pick.advanceTo;
        continue;
      }
      const results = await opac.searchTitle(pick.title);
      // 母（recommend）は同名なら文庫版を優先して予約する（ユーザー指定）。
      // 公文リストの本は出版社もリストと一致する版だけを予約する（ユーザー指定・リスト＝正）
      const candidates = results?.length
        ? rankResults(results, pick.title, 3, account.mode === "recommend", pick.publisher || null)
        : [];
      if (!candidates.length) {
        const pubMismatch = !!(results?.length && pick.publisher);
        const note = pubMismatch
          ? `リスト指定の出版社（${pick.publisher}）の版が見つからない（CSVの出版社表記を要確認）`
          : "所蔵なし・検索ヒットなし";
        section.failed.push({ title: pick.title, note });
        // 台帳に記録するのは真の所蔵なしのみ。
        // - adhoc の失敗は記録しない（タイトルを直して再依頼できるように）
        // - 出版社不一致は表記ゆれの可能性があるため記録せず、翌週自動リトライ
        //   （CSV側の表記を直せば解消する。毎週レポートに出るので放置されない）
        if (!dryRun && pick.from !== "adhoc" && !pubMismatch) {
          ledger.add({ title: pick.title, author: pick.author ?? "", status: "failed", note: "所蔵なし", source: pick.from });
          if (pick.advanceTo) cursor = pick.advanceTo;
        }
        continue;
      }
      // 予約不可の版（大型絵本等）は次の候補へフォールバック
      let add = null;
      for (let ci = 0; ci < candidates.length; ci++) {
        // 検索が書誌詳細へ直行した単一ヒット（onDetail）は既に詳細を開いているので openResult を飛ばす
        if (!candidates[ci].onDetail) await opac.openResult(candidates[ci].index);
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
    // カート投入対象が無ければ（全て所蔵なし等・台帳記録済み）進度は確定してよい。
    if (inCart.length === 0) batchOk = true;
    if (!dryRun && inCart.length > 0) {
      const rres = await opac.reserveCartContents({
        pickupBranch: account.pickupBranch,
        contactMethod: account.contactMethod ?? cfg.opac.contactMethod,
        countBefore: activeStates.length,
      });
      // 成立の確定（唯一の確実判定）: exec 直後のページは stale なカートで信頼できず、その場で
      // 予約一覧を開くとログアウトするため、**新規ログインし直して**予約状況一覧を取得し、投入
      // タイトルが実際に有効予約として載ったかを冊単位で照合する（verify-reservations.mjs と同じ方法）。
      let activeTitlesAfter = [];
      try {
        await opac.login(creds.card, creds.pass);
        const afterStates = await opac.listReservationStates();
        activeTitlesAfter = afterStates
          .filter((s) => s.state && !cancelledRe.test(s.state))
          .map((s) => s.title);
      } catch {
        /* 照合ログインに失敗したときのみ結果ページ文言（resultPageOk）にフォールバック */
      }
      const activeKeys = activeTitlesAfter.map((t) => Ledger.key(t));
      const isReserved = (title) => {
        if (activeTitlesAfter.length === 0) return !!rres.resultPageOk;
        const k = Ledger.key(title);
        return activeKeys.some((ak) => ak === k || ak.includes(k) || k.includes(ak));
      };
      let reservedCount = 0;
      for (const pick of inCart) {
        if (isReserved(pick.title)) {
          reservedCount += 1;
          section.reserved.push({ title: pick.title, note: "予約完了（予約一覧で確認）" });
          ledger.add({ title: pick.title, author: pick.author ?? "", status: "reserved", source: pick.from });
          if (pick.advanceTo) cursor = pick.advanceTo;
          if (account.mode === "recommend") {
            recordMomRecommended({ title: pick.title, author: pick.author ?? "" });
          }
        } else {
          // 未成立分は台帳・カーソルを動かさず翌週へ持ち越す
          section.failed.push({ title: pick.title, note: `予約確定できず見送り（${rres.message}）` });
        }
      }
      // 全冊成立したときだけ進度・キューの消化を確定する（部分成立時は進めず翌週再試行＝
      // 成立済みは台帳の ledger.has で自動スキップされるので二重予約にならない）。
      batchOk = reservedCount === inCart.length;
    }

    await opac.logout();
  } catch (err) {
    section.failed.push({ title: "(実行中断)", note: err.message });
  } finally {
    await opac.close();
  }

  // ---- 実行後の状態更新（本番のみ・予約バッチ成立時のみ確定する）----
  // batchOk でないとき（予約失敗・実行中断）は進度もキューも一切書き換えない。対象の本は
  // 翌週そのまま再試行される（台帳記録済みの所蔵なし等は ledger.has で自動スキップ）。
  if (!dryRun) {
    if (account.mode === "kumon" && !adhoc) {
      if (batchOk) {
        if (cursor) progress.set(cursor.level, cursor.position);
        // --limit は planWeek が消化した一部の pick だけを処理するため、キュー消化を確定すると
        // 未処理の pick を取りこぼす。テスト用途の --limit ではキューを確定しない（台帳で自己回復する）。
        if (!(limit > 0)) queue.save(); // シリーズ消化・展開の結果をここで初めてファイルへ確定
        section.next = cursor ?? progress.get();
      } else {
        section.next = progress.get(); // 未確定：次回は同じ位置から再開
      }
    }
    if (batchOk && account.mode === "recommend" && section.momQueue) {
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
  if (args.title && ids.length !== 1) {
    console.error("--title の単発予約は --account=xxx でアカウントを1つ指定してください");
    process.exit(1);
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
      adhoc: args.title ? { title: args.title, author: args.author } : null,
      pendingSeries,
      logRoot,
    });
    for (const b of section.reserved) console.log(`  OK ${b.title}`);
    for (const b of section.failed) console.log(`  NG ${b.title} — ${b.note}`);
    if (section.skippedReason) console.log(`  SKIP ${section.skippedReason}`);
    sections.push(section);
  }

  // 単発予約は週次レポート（reports/日付.md）を上書きしないよう別ファイルに書く
  const slug = args.title ? `adhoc-${todayStr()}` : null;
  const file = writeReport({ dryRun: args.dryRun, sections, pendingSeries, slug });
  console.log(`\nレポート: ${path.relative(process.cwd(), file)}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
