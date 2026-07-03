import fs from "node:fs";
import path from "node:path";
import { ROOT } from "./config.js";
import { Ledger } from "./state.js";

/**
 * data/kumon_list.csv を読む。
 * 形式: level,order,title,author  （ヘッダ行あり、UTF-8）
 * 掲載順 order は各レベル内で 1〜50。
 */
export function loadKumonList(file = path.join(ROOT, "data", "kumon_list.csv")) {
  if (!fs.existsSync(file)) {
    throw new Error(`kumon_list.csv がありません: ${file}\n（npm run fetch-kumon で生成、または CLAUDE.md の手順を参照）`);
  }
  const rows = [];
  const lines = fs.readFileSync(file, "utf8").split("\n").filter((l) => l.trim());
  for (const line of lines.slice(1)) {
    // タイトルにカンマを含む場合に備え、先頭2列と末尾1列を固定で分割
    const first = line.indexOf(",");
    const second = line.indexOf(",", first + 1);
    const last = line.lastIndexOf(",");
    if (first < 0 || second < 0 || last <= second) continue;
    rows.push({
      level: line.slice(0, first).trim(),
      order: Number(line.slice(first + 1, second).trim()),
      title: line.slice(second + 1, last).trim().replace(/^"|"$/g, ""),
      author: line.slice(last + 1).trim(),
    });
  }
  return rows;
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
 * 優先順: 1) queue.json（シリーズ展開の残り） 2) リストの現在位置から順に。
 * 台帳(Ledger)にある本はスキップ。返り値の nextProgress はリスト消化後の新カーソル。
 */
export function planWeek({ flat, progress, queue, ledger, quota, seriesResolver }) {
  const picks = [];
  const skipped = [];

  // 1) 持ち越しキュー（シリーズの続巻など）
  while (picks.length < quota && queue.length > 0) {
    const item = queue.peek();
    if (ledger.has(item.title)) {
      queue.shift();
      continue;
    }
    picks.push({ ...item, from: "queue" });
    queue.shift();
  }

  // 2) 公文リスト本体
  let idx = indexOfProgress(flat, progress.get());
  if (idx < 0) idx = flat.length; // リスト終端
  while (picks.length < quota && idx < flat.length) {
    const row = flat[idx];
    idx += 1;
    if (ledger.has(row.title)) {
      skipped.push({ ...row, reason: "予約・処理済み" });
      continue;
    }
    // シリーズ第1巻なら展開し、全巻をキューに積んで先頭から消化
    const series = seriesResolver ? seriesResolver(row) : null;
    if (series && series.volumes.length > 1) {
      const rest = [];
      for (const v of series.volumes) {
        if (ledger.has(v.title)) continue;
        if (picks.length < quota) {
          picks.push({ title: v.title, author: row.author, from: `series:${series.name}` });
        } else {
          rest.push({ title: v.title, author: row.author, from: `series:${series.name}` });
        }
      }
      if (rest.length) queue.push(...rest);
      continue;
    }
    picks.push({ ...row, from: "list" });
  }

  const nextProgress = idx < flat.length
    ? { level: flat[idx].level, position: flat[idx].order }
    : { level: "END", position: 0 };

  return { picks, skipped, nextProgress };
}
