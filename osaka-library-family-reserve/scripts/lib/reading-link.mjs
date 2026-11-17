// 子供読書アプリ（読書記録）と図書館自動予約をつなぐ共通ロジック。
// 図書館サイトにはアクセスしない。毎週の予約実行が logs/ に保存する「貸出状況一覧」を読むだけ。
// LLM も呼ばない（CLAUDE.md「進め方のルール」）。
import fs from "node:fs";
import path from "node:path";
import { ROOT, ensureDir } from "../../src/config.js";
import { Ledger } from "../../src/state.js";

export const READING_DIR = path.join(ROOT, "state", "_reading");
export const LOCAL_CONFIG = path.join(ROOT, "reading.local.json");
export const RECORDED_FILE = path.join(READING_DIR, "recorded.json");

/** フォームID・子どもの名前・ドライブのIDは Git 管理外の reading.local.json に置く */
export function loadLocalConfig(file = LOCAL_CONFIG) {
  if (!fs.existsSync(file)) {
    throw new Error("reading.local.json がありません（reading.local.example.json をコピーして記入）");
  }
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function decodeEntities(s) {
  return s
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}
function textOf(htmlPart) {
  return decodeEntities(htmlPart.replace(/<!--[\s\S]*?-->/g, "").replace(/<[^>]+>/g, " "))
    .replace(/[ \t\r\n]+/g, " ") // 全角スペース（区切り）は残す
    .trim();
}

/**
 * 貸出状況一覧の資料名「書名　叢書名　著者／作　出版社」（全角スペース区切り）を分解する。
 * 先頭＝書名、末尾＝出版社、「／」を含む最後の区切り＝著者。
 */
export function splitOpacTitle(raw) {
  const segments = String(raw).split("　").map((s) => s.trim()).filter(Boolean);
  if (segments.length <= 1) return { title: String(raw).trim(), author: "", publisher: "", segments: [String(raw).trim()] };
  const publisher = segments[segments.length - 1];
  const author = [...segments.slice(0, -1)].reverse().find((s) => s.includes("／")) ?? "";
  return { title: segments[0], author, publisher, segments };
}

/** 貸出状況一覧のHTML（logs/日付/アカウント/NN-lent-list.html）から貸出中の本を読む */
export function parseLentList(html) {
  const chunks = String(html).split(/<div class="layer-item"[^>]*>/).slice(1);
  const out = [];
  for (const c of chunks) {
    const m = c.match(/<div class="title"[^>]*>([\s\S]*?)<\/div>/);
    if (!m) continue;
    const raw = textOf(m[1]);
    if (!raw) continue;
    const text = textOf(c);
    const loanDate = (text.match(/貸出日[：:]\s*(\d{4}\/\d{1,2}\/\d{1,2})/) ?? [])[1] ?? "";
    const dueDate = (text.match(/返却期日[：:]\s*(\d{4}\/\d{1,2}\/\d{1,2})/) ?? [])[1] ?? "";
    out.push({ raw, ...splitOpacTitle(raw), loanDate, dueDate });
  }
  return out;
}

/**
 * 直近 weeks 週ぶんの貸出状況一覧（実行日ごとに1つ）を古い順に返す。
 * 同じ日に複数保存されていれば、読めた冊数が最も多いものを使う（途中で切れたHTML対策）。
 */
export function loadLoanSnapshots(accountId, { weeks = 4, logsDir = path.join(ROOT, "logs") } = {}) {
  if (!fs.existsSync(logsDir)) return [];
  const dates = fs.readdirSync(logsDir).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
  const snaps = [];
  for (const date of dates) {
    const dir = path.join(logsDir, date, accountId);
    if (!fs.existsSync(dir)) continue;
    const files = fs.readdirSync(dir).filter((f) => /lent-list\.html$/.test(f)).sort();
    let best = null;
    for (const f of files) {
      const loans = parseLentList(fs.readFileSync(path.join(dir, f), "utf8"));
      if (!best || loans.length > best.loans.length) best = { date, file: path.join(dir, f), loans };
    }
    if (best) snaps.push(best);
  }
  if (!snaps.length) return [];
  const latest = snaps[snaps.length - 1].date;
  const cutoff = new Date(new Date(`${latest}T00:00:00Z`).getTime() - weeks * 7 * 86400000)
    .toISOString()
    .slice(0, 10);
  return snaps.filter((s) => s.date > cutoff);
}

/**
 * 貸出中の本が自動予約の台帳（state/{id}/reserved.json）のどの本かを探す。
 * exact: 資料名の先頭n区切りをつないだものが台帳の書名と一致。
 * それ以外は「資料名が台帳の書名で始まる」ゆるい一致（4文字以上）。いちばん長い書名を採る。
 */
export function matchLedger(loan, books) {
  const segs = loan.segments ?? [loan.raw];
  const prefixes = segs.map((_, i) => Ledger.key(segs.slice(0, i + 1).join("")));
  const rawKey = Ledger.key(loan.raw);
  let best = null;
  for (const b of books) {
    if (b.status === "failed" || b.status === "skipped") continue;
    const k = Ledger.key(b.title);
    if (!k) continue;
    const exact = prefixes.includes(k);
    const loose = !exact && k.length >= 4 && rawKey.startsWith(k);
    if (!exact && !loose) continue;
    const score = (exact ? 1000 : 0) + k.length;
    if (!best || score >= best.score) best = { entry: b, exact, score };
  }
  return best;
}

/**
 * 1人ぶんのチェックリストを作る。
 * 対象＝直近の貸出状況一覧に載っていた本のうち、自動予約の台帳にあり、読書記録にまだ無い本。
 * 今借りている本を先に、貸出日の古い順で番号を振る。
 */
export function buildChecklist({ books, snapshots, recordedTitles = [] }) {
  const latestDate = snapshots.length ? snapshots[snapshots.length - 1].date : null;
  const seen = new Map();
  for (const s of snapshots) {
    for (const loan of s.loans) seen.set(Ledger.key(loan.raw), { loan, lastSeen: s.date });
  }
  const recKeys = new Set(recordedTitles.map((t) => Ledger.key(t)).filter(Boolean));
  const items = [];
  let others = 0;
  let recorded = 0;
  for (const { loan, lastSeen } of seen.values()) {
    const m = matchLedger(loan, books);
    if (!m) {
      others += 1;
      continue;
    }
    const title = m.exact ? m.entry.title : loan.title;
    const segs = loan.segments ?? [loan.raw];
    const keys = [Ledger.key(title), ...segs.map((_, i) => Ledger.key(segs.slice(0, i + 1).join("")))];
    if (keys.some((k) => recKeys.has(k))) {
      recorded += 1;
      continue;
    }
    items.push({
      title,
      author: m.entry.author || loan.author,
      publisher: loan.publisher,
      opacTitle: loan.raw,
      loanDate: loan.loanDate,
      onLoan: lastSeen === latestDate,
      lastSeen,
    });
  }
  items.sort(
    (a, b) =>
      Number(b.onLoan) - Number(a.onLoan) ||
      String(a.loanDate).localeCompare(String(b.loanDate)) ||
      a.title.localeCompare(b.title, "ja"),
  );
  items.forEach((it, i) => {
    it.no = i + 1;
  });
  return { latestDate, items, others, recorded };
}

export function formatChecklist(result) {
  const lines = [`# 読んだかチェック（貸出状況 ${result.snapshotDate} 時点）`, ""];
  lines.push("読んだ本の番号を教えてください（例: 長女 1,3 読んだ）。読書記録に入れます。", "");
  for (const acc of result.accounts) {
    lines.push(`## ${acc.label}`);
    if (!acc.items.length) lines.push("- 該当なし");
    for (const it of acc.items) {
      const who = it.author ? `（${it.author}）` : "";
      const st = it.onLoan ? `貸出中・${it.loanDate}〜` : `返却済み・${it.lastSeen}まで貸出`;
      lines.push(`${it.no}. ${it.title}${who} — ${st}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

// ---------- 読書記録（記録済みの題名） ----------

/** { chojo: [{title,date,via}] } を読む */
export function loadRecorded(file = RECORDED_FILE) {
  if (!fs.existsSync(file)) return {};
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

/**
 * 記録済みの題名を足して保存する。input のキーはアカウントID（chojo）でも
 * 子どもの名前（reading.local.json の names の値）でもよい。値は題名の配列か {title,date} の配列。
 */
export function mergeRecorded(current, input, names = {}, via = "sheet") {
  const idOf = (key) => (names[key] ? key : Object.keys(names).find((id) => names[id] === key) ?? key);
  const out = { ...current };
  for (const [key, list] of Object.entries(input ?? {})) {
    const id = idOf(key);
    out[id] = [...(out[id] ?? [])];
    for (const raw of list ?? []) {
      const rec = typeof raw === "string" ? { title: raw } : raw;
      if (!rec?.title) continue;
      const k = Ledger.key(rec.title);
      if (out[id].some((r) => Ledger.key(r.title) === k)) continue;
      out[id].push({ title: rec.title, date: rec.date ?? "", via: rec.via ?? via });
    }
  }
  return out;
}

export function saveRecorded(data, file = RECORDED_FILE) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n");
}

// ---------- 読書記録フォーム ----------

/** Googleフォーム「子どもの読書記録」へ送る本文（名前・本のタイトル・日付） */
export function formBody(form, { name, title, date }) {
  const [y, m, d] = String(date).split("-").map(Number);
  const p = new URLSearchParams();
  p.set(form.entries.name, name);
  p.set(form.entries.title, title);
  p.set(`${form.entries.date}_year`, String(y));
  p.set(`${form.entries.date}_month`, String(m));
  p.set(`${form.entries.date}_day`, String(d));
  return p;
}

// ---------- おすすめ本の追加 ----------

/**
 * 子供読書アプリのおすすめ本を、その子の予約キューへ足すかどうか判定する。
 * 公文リスト・絵本ナビ（その子の年齢帯）・シリーズ巻・台帳・キューのどこかにあれば足さない。
 */
export function judgeRecommendation(item, { kumonRows, ehonnaviRows, seriesVolumes, ledgerBooks, queueItems }) {
  const k = Ledger.key(item.title);
  if (!k) return { action: "skip", reason: "題名が空" };
  const same = (t) => Ledger.key(t) === k;
  const kr = kumonRows.find((r) => same(r.title));
  if (kr) return { action: "skip", reason: `公文リストにあり（${kr.level}-${kr.order}）` };
  if (ehonnaviRows.some((r) => same(r.title))) return { action: "skip", reason: "絵本ナビリストにあり" };
  const sv = seriesVolumes.find((v) => same(v.title));
  if (sv) return { action: "skip", reason: `シリーズ「${sv.series}」の巻として登録あり` };
  const active = [...ledgerBooks].reverse().find((b) => b.status !== "expired" && same(b.title));
  if (active) {
    const label = { reserved: "予約済み", borrowed: "借りた本", failed: "以前に所蔵なしで失敗", skipped: "予約しない指定" }[active.status] ?? active.status;
    return { action: "skip", reason: `台帳にあり（${label}・${active.date}）` };
  }
  if (queueItems.some((q) => same(q.title))) return { action: "skip", reason: "すでにキューにあり" };
  return { action: "add" };
}
