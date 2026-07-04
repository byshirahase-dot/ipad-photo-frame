import fs from "node:fs";
import path from "node:path";
import { ROOT, loadDotEnv, loadAccountsConfig, credentialsFor, todayStr, ensureDir } from "./config.js";
import { Ledger, Progress, Queue, readMomQueue, writeMomQueue, recordMomRecommended } from "./state.js";
import { loadKumonList, flatten, planWeek } from "./kumon.js";
import { makeSeriesResolver } from "./series.js";
import { Opac, rankResults } from "./opac.js";
import { writeReport } from "./report.js";

/**
 * 刻み実行モード（Cowork のサンドボックスなど、1コマンド約45秒制限の環境向け）。
 *   node src/tick.js [--dry-run] [--reset]
 * 1回の実行で「小さな1ステップ」だけ進めて state/_job.json に保存して終了する。
 * 最後の行に TICK:CONTINUE（続きがある）か TICK:DONE（完了）を出力するので、
 * 呼び出し側（Cowork の Claude）は TICK:DONE が出るまで繰り返し実行すればよい。
 *
 * 安全設計:
 * - ログインセッションは state/_session_{account}.json の Cookie で引き継ぐ
 * - 各アカウント最初に予約状況一覧と照合（reconcile）し、サイト上に既にある予約は
 *   二重予約しない。取消（期限切れ）予約の再キュー投入もここで行う
 * - 台帳・進度・キューは1冊処理するごとに即保存（中断しても取りこぼさない）
 */

const JOB_FILE = path.join(ROOT, "state", "_job.json");

function loadJob() {
  return fs.existsSync(JOB_FILE) ? JSON.parse(fs.readFileSync(JOB_FILE, "utf8")) : null;
}
function saveJob(job) {
  ensureDir(path.dirname(JOB_FILE));
  fs.writeFileSync(JOB_FILE, JSON.stringify(job, null, 2) + "\n");
}

function parseArgs(argv) {
  const a = { dryRun: false, reset: false, accounts: [] };
  for (const x of argv.slice(2)) {
    if (x === "--dry-run") a.dryRun = true;
    else if (x === "--reset") a.reset = true;
    else if (x.startsWith("--account=")) a.accounts.push(x.split("=")[1]);
  }
  return a;
}

/** 新しい週次ジョブを作る（サイトアクセスなし・選書計画のみ） */
function createJob(cfg, args) {
  const job = {
    date: todayStr(),
    dryRun: args.dryRun,
    phase: "run",
    pendingSeries: [],
    accounts: {},
    order: args.accounts.length ? args.accounts : Object.keys(cfg.accounts),
  };
  for (const id of job.order) {
    const account = cfg.accounts[id];
    // フェーズ順: search（全冊の候補集め・ログイン不要）→ login（ログイン＋予約一覧照合）
    // → reserve（詳細URL直行で予約。トップページを踏まないのでログインが維持される）
    const acct = { phase: "search", picks: [], requeued: [], reserveCount: null, activeKeys: [] };
    const ledger = new Ledger(id);
    if (account.mode === "kumon") {
      const flat = flatten(loadKumonList(), cfg.levelOrder);
      const progress = new Progress(id, account.startProgress);
      const queue = new Queue(id, { persist: !args.dryRun });
      const resolver = makeSeriesResolver({ pendingSeries: job.pendingSeries, persist: !args.dryRun });
      const plan = planWeek({
        flat, progress, queue, ledger,
        quota: account.weeklyQuota ?? 4,
        seriesResolver: resolver,
        seriesPerWeek: cfg.seriesPerWeek ?? 2,
      });
      acct.picks = plan.picks.map((p) => ({ ...p, status: "pending", candIdx: 0 }));
    } else {
      const { queue: momQueue } = readMomQueue();
      if (!momQueue || !momQueue.items?.length) {
        acct.phase = "done";
        acct.skippedReason = "選書待ち（data/mom/queue.json が空）";
      } else {
        acct.picks = momQueue.items
          .filter((b) => !ledger.has(b.title))
          .slice(0, account.weeklyQuota ?? 4)
          .map((b) => ({ title: b.title, author: b.author ?? "", from: "mom-queue", status: "pending", candIdx: 0 }));
        if (!acct.picks.length) {
          acct.phase = "done";
          acct.skippedReason = "予約候補なし（キューの本はすべて処理済み）";
        }
      }
    }
    if (acct.phase !== "done" && !acct.picks.length) {
      acct.phase = "done";
      acct.skippedReason = "予約候補なし（リスト消化済み or すべて予約済み）";
    }
    job.accounts[id] = acct;
  }
  return job;
}

function nextAccountId(job) {
  return job.order.find((id) => job.accounts[id].phase !== "done");
}

function key(s) {
  return Ledger.key(s);
}

/** 1冊ぶんの後処理（台帳・進度・母キュー）を即時反映する */
function settlePick({ job, id, account, pick, status, note }) {
  pick.status = status; // "done" | "failed"
  pick.note = note;
  if (job.dryRun) return;
  const ledger = new Ledger(id);
  ledger.add({
    title: pick.title,
    author: pick.author ?? "",
    status: status === "done" ? "reserved" : "failed",
    note,
    source: pick.from,
  });
  if (account.mode === "kumon" && pick.advanceTo) {
    new Progress(id, account.startProgress).set(pick.advanceTo.level, pick.advanceTo.position);
  }
  if (account.mode === "recommend" && status === "done") {
    recordMomRecommended({ title: pick.title, author: pick.author ?? "" });
    const { file, queue: momQueue } = readMomQueue();
    if (momQueue?.items) {
      momQueue.items = momQueue.items.filter((b) => key(b.title) !== key(pick.title));
      writeMomQueue(file, momQueue);
    }
  }
}

function finishJob(job, cfg) {
  const sections = job.order.map((id) => {
    const acct = job.accounts[id];
    const account = cfg.accounts[id];
    return {
      accountId: id,
      name: account.name,
      mode: account.mode,
      skippedReason: acct.skippedReason,
      reserveCount: acct.reserveCount,
      reserveLimit: cfg.opac.reserveLimit,
      requeued: acct.requeued,
      reserved: acct.picks.filter((p) => p.status === "done").map((p) => ({ title: p.title, note: p.note })),
      failed: acct.picks.filter((p) => p.status === "failed").map((p) => ({ title: p.title, note: p.note })),
      next: account.mode === "kumon" ? new Progress(id, account.startProgress).get() : undefined,
    };
  });
  const file = writeReport({ dryRun: job.dryRun, sections, pendingSeries: job.pendingSeries });
  job.phase = "done";
  saveJob(job);
  console.log(`レポート: ${path.relative(process.cwd(), file)}`);
  for (const s of sections) {
    console.log(`--- ${s.name} ---`);
    for (const b of s.reserved) console.log(`  OK ${b.title}`);
    for (const b of s.failed) console.log(`  NG ${b.title} — ${b.note}`);
    if (s.skippedReason) console.log(`  SKIP ${s.skippedReason}`);
  }
  console.log("TICK:DONE");
}

async function main() {
  loadDotEnv();
  const cfg = loadAccountsConfig();
  const args = parseArgs(process.argv);

  // 実行中ジョブ（同日・未完了）は再開、それ以外は新規作成
  let job = loadJob();
  const stale = args.reset || !job || job.phase === "done" || job.date !== todayStr();
  if (stale) {
    job = createJob(cfg, args);
    saveJob(job);
    const total = job.order.reduce((n, id) => n + job.accounts[id].picks.length, 0);
    console.log(`週次ジョブ作成: ${job.order.join(", ")} / 計 ${total} 冊 ${job.dryRun ? "【ドライラン】" : "【本番】"}`);
    console.log("TICK:CONTINUE plan-created");
    return;
  }

  const id = nextAccountId(job);
  if (!id) return finishJob(job, cfg);

  const acct = job.accounts[id];
  const account = cfg.accounts[id];
  const creds = credentialsFor(account);
  if (creds.missing) {
    acct.phase = "done";
    acct.skippedReason = `.env に ${account.envCard} / ${account.envPass} が未設定`;
    saveJob(job);
    console.log(`TICK:CONTINUE skip-${id}`);
    return;
  }

  const opac = new Opac({
    baseUrl: cfg.opac.baseUrl,
    intervalMs: 2500, // 刻み実行は1tickあたりのアクセス数が少ないため、45秒制限内に収める方を優先

    logDir: path.join(ROOT, "logs", job.date, id),
    dryRun: job.dryRun,
    storageStatePath: path.join(ROOT, "state", `_session_${id}.json`),
  });

  try {
    await opac.start();

    if (acct.phase === "search") {
      // フェーズ1: 検索（ログイン不要。トップページ経由でよい）
      const pick = acct.picks.find((p) => p.status === "pending");
      if (!pick) {
        acct.phase = "login";
        saveJob(job);
        console.log(`TICK:CONTINUE ${id}-search-phase-done`);
        return;
      }
      const results = await opac.searchTitle(pick.title);
      const cands = results?.length ? rankResults(results, pick.title) : [];
      if (!cands.length) {
        settlePick({ job, id, account, pick, status: "failed", note: "所蔵なし・検索ヒットなし" });
      } else {
        pick.candidates = cands.map((c) => ({ title: c.title, href: c.href }));
        pick.status = "searched";
      }
      saveJob(job);
      console.log(`TICK:CONTINUE ${id}-searched「${pick.title}」(${pick.candidates?.length ?? 0}候補)`);
      return;
    }

    if (acct.phase === "login") {
      // フェーズ2: ログイン＋予約状況一覧の照合（予約一覧はログイン直後の画面フローからのみ開ける）
      await opac.login(creds.card, creds.pass);
      const states = await opac.listReservationStates();
      const cancelledRe = /取消|期限切れ|無効/;
      acct.activeKeys = states.filter((s) => s.state && !cancelledRe.test(s.state)).map((s) => key(s.title));
      acct.reserveCount = states.filter((s) => s.state && !cancelledRe.test(s.state)).length;
      const ledger = new Ledger(id);
      for (const s of states) {
        if (!cancelledRe.test(s.state)) continue;
        if (acct.activeKeys.includes(key(s.title))) continue;
        const entry = ledger.findActiveReserved(s.title);
        if (!entry) continue;
        acct.requeued.push({ title: entry.title, state: s.state });
        if (!job.dryRun) {
          ledger.markExpired(entry, `予約${s.state}のため再予約対象に戻した`);
          if (account.mode === "kumon") {
            new Queue(id).unshift({ title: entry.title, author: entry.author ?? "", from: "requeue:予約取消" });
          } else {
            const { file, queue: momQueue } = readMomQueue();
            if (momQueue?.items) {
              momQueue.items.unshift({ title: entry.title, author: entry.author ?? "", reason: "予約取消の再予約" });
              writeMomQueue(file, momQueue);
            }
          }
        }
      }
      acct.phase = "reserve";
      acct.loginAt = Date.now();
      saveJob(job);
      console.log(`TICK:CONTINUE ${id}-login-reconcile-ok (予約中${acct.reserveCount}件)`);
      return;
    }

    // フェーズ3: reserve — 検索済みの1冊を予約する（トップページを踏まない）
    const pick = acct.picks.find((p) => p.status === "searched");
    if (!pick) {
      acct.phase = "done";
      saveJob(job);
      console.log(`TICK:CONTINUE ${id}-account-done`);
      return;
    }

    // ログインが古い場合は先回りして再ログイン（サーバー側セッションタイムアウト対策）
    if (!job.dryRun && (!acct.loginAt || Date.now() - acct.loginAt > 8 * 60 * 1000)) {
      acct.phase = "login";
      saveJob(job);
      console.log(`TICK:CONTINUE ${id}-session-refresh`);
      return;
    }

    // 予約枠チェック
    const available = cfg.opac.reserveLimit - (acct.reserveCount ?? 0);
    if (available <= 0) {
      pick.status = "failed";
      pick.note = "予約上限に達するため見送り";
      saveJob(job);
      console.log(`TICK:CONTINUE ${id}-limit`);
      return;
    }

    // 候補の詳細ページへ直接行って予約
    // 中断後の再開時: サイト上に既にあるならそれで完了扱い（二重予約防止）
    if (acct.activeKeys.some((k) => k === key(pick.title) || k.includes(key(pick.title)))) {
      settlePick({ job, id, account, pick, status: "done", note: "サイト上で予約済みを確認" });
      saveJob(job);
      console.log(`TICK:CONTINUE ${id}-already-reserved「${pick.title}」`);
      return;
    }
    let res = null;
    while (pick.candIdx < (pick.candidates?.length ?? 0)) {
      const cand = pick.candidates[pick.candIdx];
      const url = cand.href.startsWith("http") ? cand.href : `${cfg.opac.baseUrl}/${cand.href.replace(/^\//, "")}`;
      try {
        res = await opac.reserveAtUrl(url, {
          pickupBranch: account.pickupBranch,
          contactMethod: account.contactMethod ?? cfg.opac.contactMethod,
        });
      } catch (err) {
        if (/セッション切れ|ログイン認証/.test(err.message)) {
          // 予約フロー中にログイン画面へ戻された → 次のtickで再ログイン＋照合してからやり直す
          pick.sessionRetries = (pick.sessionRetries ?? 0) + 1;
          if (pick.sessionRetries >= 3) {
            settlePick({ job, id, account, pick, status: "failed", note: "セッション切れが繰り返し発生（logs/のスクショ要確認）" });
            saveJob(job);
            console.log(`TICK:CONTINUE ${id}-session-lost-giveup「${pick.title}」`);
            return;
          }
          acct.phase = "login";
          saveJob(job);
          console.log(`TICK:CONTINUE ${id}-session-lost-relogin「${pick.title}」(${pick.sessionRetries}回目)`);
          return;
        }
        throw err;
      }
      if (res.notReservable) {
        pick.candIdx += 1;
        saveJob(job);
        if (pick.candIdx < pick.candidates.length) {
          console.log(`TICK:CONTINUE ${id}-try-next-candidate「${pick.title}」`);
          return; // 次の候補は次のtickで（時間切れ防止）
        }
        break;
      }
      break;
    }
    if (!res || res.notReservable) {
      settlePick({ job, id, account, pick, status: "failed", note: res?.message ?? "予約可能な版が見つからない" });
    } else if (res.ok) {
      settlePick({ job, id, account, pick, status: "done", note: res.dryRun ? "ドライラン（予約可能を確認）" : res.message });
      if (!res.dryRun) {
        acct.reserveCount = (acct.reserveCount ?? 0) + 1;
        acct.activeKeys.push(key(pick.title));
        acct.loginAt = Date.now(); // 予約成功＝サーバー側セッションも更新されている
      }
    } else {
      settlePick({ job, id, account, pick, status: "failed", note: res.message });
    }
    saveJob(job);
    console.log(`TICK:CONTINUE ${id}-${pick.status}「${pick.title}」${pick.note ? `(${pick.note})` : ""}`);
  } catch (err) {
    console.error(`tickエラー: ${err.message}`);
    // reserve中のエラーはセッション切れの可能性が高いので再ログイン＋照合からやり直す。
    // （照合で予約済みが判明した本は二重予約せず完了扱いになる）
    if (acct.phase === "reserve") acct.phase = "login";
    saveJob(job);
    console.log(`TICK:CONTINUE ${id}-error-retry(phase=${acct.phase})`);
  } finally {
    await opac.close();
  }
}

// 直接実行されたときだけ動かす（import時の副作用防止）
import { pathToFileURL } from "node:url";
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(e);
    console.log("TICK:CONTINUE fatal-retry");
    process.exit(1);
  });
}
