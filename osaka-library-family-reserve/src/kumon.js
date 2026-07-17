import fs from "node:fs";
import path from "node:path";
import { ROOT } from "./config.js";
import { Ledger } from "./state.js";

/** ダブルクォート対応の簡易CSV行パーサ */
function parseCsvLine(line) {
  const out = [];
  let cur = "";
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQ) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } else inQ = false;
      } else cur += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ",") { out.push(cur); cur = ""; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

/**
 * data/kumon_list.csv を読む。
 * 形式: level,order,title,author,publisher  （ヘッダ行あり、UTF-8）
 * 掲載順 order は各レベル内で 1〜50。publisher は予約する版の特定に使う（リスト＝正）。
 */
export function loadKumonList(file = path.join(ROOT, "data", "kumon_list.csv")) {
  if (!fs.existsSync(file)) {
    throw new Error(`kumon_list.csv がありません: ${file}\n（npm run fetch-kumon で生成、または CLAUDE.md の手順を参照）`);
  }
  const rows = [];
  const lines = fs.readFileSync(file, "utf8").split("\n").filter((l) => l.trim());
  for (const line of lines.slice(1)) {
    const c = parseCsvLine(line.replace(/\r$/, ""));
    if (c.length < 4) continue;
    rows.push({
      level: c[0].trim(),
      order: Number(c[1].trim()),
      title: c[2].trim(),
      author: (c[3] ?? "").trim(),
      publisher: (c[4] ?? "").trim(),
    });
  }
  return rows;
}

/**
 * data/ehonnavi_list.csv を読む。形式: age,order,title,author,publisher（ヘッダあり）。
 * age は年齢帯（"0"〜"6"、"小学" 等の文字列）。ageBand を渡すと該当帯だけを order 順で返す。
 * ファイルが無ければ空配列（＝絵本ナビ枠なしで通常運用）。
 */
export function loadEhonnaviList(ageBand = null, file = path.join(ROOT, "data", "ehonnavi_list.csv")) {
  if (!fs.existsSync(file)) return [];
  const rows = [];
  const lines = fs.readFileSync(file, "utf8").split("\n").filter((l) => l.trim());
  for (const line of lines.slice(1)) {
    const c = parseCsvLine(line.replace(/\r$/, ""));
    if (c.length < 3) continue;
    rows.push({
      age: c[0].trim(),
      order: Number(c[1].trim()) || 0,
      title: c[2].trim(),
      author: (c[3] ?? "").trim(),
      publisher: (c[4] ?? "").trim(),
    });
  }
  const filtered = ageBand == null ? rows : rows.filter((r) => r.age === String(ageBand));
  return filtered.sort((a, b) => a.order - b.order);
}

/** リストをレベル順・掲載順に一次元化し、(level, position) から線形に辿れるようにする */
export function flatten(rows, levelOrder) {
  const sorted = [...rows].sort((a, b) => {
    const la = levelOrder.indexOf(a.level);
    const lb = levelOrder.indexOf(b.level);
    return la !== lb ? la - lb : a.order - b.order;
  });
  return sorted;
}

export function indexOfProgress(flat, { level, position }) {
  return flat.findIndex((r) => r.level === level && r.order === position);
}

/**
 * 今週予約する候補を quota 冊ぶん組み立てる。
 * シリーズは全巻を巻順に読むが、週あたり seriesPerWeek 冊（デフォルト2）まで。
 * 残りの枠はリストの現在位置から埋める（同じシリーズばかりにならないように）。
 * 台帳(Ledger)にある本はスキップ。返り値の nextProgress はリスト消化後の新カーソル。
 */
export function planWeek({
  flat, progress, queue, ledger, quota, seriesResolver, seriesPerWeek = 2,
  ehonnaviList = [], ehonnaviPerWeek = 0,
}) {
  const picks = [];
  const skipped = [];
  const seriesQuota = Math.min(seriesPerWeek, quota);
  let seriesTaken = 0;

  // 0) 絵本ナビ枠（週 ehonnaviPerWeek 冊まで。年齢帯で絞ったリストを先頭から、台帳にない本を取る）
  //    絵本ナビは進度カーソルを持たない: 予約/処理済みは台帳(ledger)で自動的にスキップされるため、
  //    毎週「まだ手をつけていない次の本」が自然に選ばれる。くもんと重複する本も台帳で二重予約を防ぐ。
  let ehonnaviTaken = 0;
  for (const b of ehonnaviList) {
    if (ehonnaviTaken >= ehonnaviPerWeek || picks.length >= quota) break;
    if (ledger.has(b.title)) continue;
    picks.push({ title: b.title, author: b.author ?? "", publisher: b.publisher ?? "", from: "ehonnavi" });
    ehonnaviTaken += 1;
  }

  // 1) 持ち越しキュー（シリーズの続巻）からシリーズ枠ぶんだけ
  while (seriesTaken < seriesQuota && queue.length > 0) {
    const item = queue.peek();
    if (ledger.has(item.title)) {
      queue.shift();
      continue;
    }
    picks.push({ ...item, from: item.from ?? "queue" });
    queue.shift();
    seriesTaken += 1;
  }

  // 2) 公文リスト本体（シリーズ第1巻を見つけたら残りのシリーズ枠を使い、超過分はキューへ）
  let idx = indexOfProgress(flat, progress.get());
  if (idx < 0) idx = flat.length; // リスト終端
  while (picks.length < quota && idx < flat.length) {
    const row = flat[idx];
    idx += 1;
    // この本を処理し終えたときにカーソルを進める先（＝リスト上の次の本）
    const advanceTo = idx < flat.length
      ? { level: flat[idx].level, position: flat[idx].order }
      : { level: "END", position: 0 };
    if (ledger.has(row.title)) {
      skipped.push({ ...row, reason: "予約・処理済み" });
      continue;
    }
    const series = seriesResolver ? seriesResolver(row) : null;
    if (series && series.volumes.length > 1) {
      const rest = [];
      for (const v of series.volumes) {
        if (ledger.has(v.title)) continue;
        if (seriesTaken < seriesQuota && picks.length < quota) {
          picks.push({ title: v.title, author: row.author, publisher: row.publisher, from: `series:${series.name}`, advanceTo });
          seriesTaken += 1;
        } else {
          rest.push({ title: v.title, author: row.author, publisher: row.publisher, from: `series:${series.name}` });
        }
      }
      if (rest.length) queue.push(...rest);
      continue;
    }
    picks.push({ ...row, from: "list", advanceTo });
  }

  // 3) リストが尽きた場合はキューから補充（シリーズ枠の制限を超えてよい）
  while (picks.length < quota && queue.length > 0) {
    const item = queue.peek();
    if (ledger.has(item.title)) {
      queue.shift();
      continue;
    }
    picks.push({ ...item, from: item.from ?? "queue" });
    queue.shift();
  }

  const nextProgress = idx < flat.length
    ? { level: flat[idx].level, position: flat[idx].order }
    : { level: "END", position: 0 };

  return { picks, skipped, nextProgress };
}
