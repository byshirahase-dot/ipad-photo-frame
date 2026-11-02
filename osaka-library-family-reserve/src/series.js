import fs from "node:fs";
import path from "node:path";
import { ROOT, ensureDir } from "./config.js";

const SERIES_DIR = path.join(ROOT, "data", "series");
const HINTS_FILE = path.join(ROOT, "data", "series_hints.json");

/**
 * シリーズ展開の仕組み:
 * - data/series_hints.json に「第1巻タイトル → シリーズ名」の対応表を持つ
 * - data/series/{シリーズ名}.json があればそれを正とする（巻順つき全巻リスト）
 *   { "name": "ハリー・ポッター", "volumes": [{ "order": 1, "title": "..." }, ...] }
 * - series ファイルが無いシリーズは展開せず pending として報告し、
 *   Cowork 側の Claude が Web 検索でファイルを作成する（SCHEDULE_PROMPT.md 参照）。
 *   このスクリプト自体は LLM もWeb検索も呼ばない。
 */
export function loadHints() {
  if (!fs.existsSync(HINTS_FILE)) return {};
  return JSON.parse(fs.readFileSync(HINTS_FILE, "utf8"));
}

export function seriesFileFor(name) {
  return path.join(SERIES_DIR, `${name}.json`);
}

export function loadSeries(name) {
  const f = seriesFileFor(name);
  if (!fs.existsSync(f)) return null;
  const data = JSON.parse(fs.readFileSync(f, "utf8"));
  data.volumes.sort((a, b) => a.order - b.order);
  return data;
}

export function saveSeries(data) {
  ensureDir(SERIES_DIR);
  fs.writeFileSync(seriesFileFor(data.name), JSON.stringify(data, null, 2) + "\n");
}

/**
 * planWeek に渡す resolver を作る。
 * 展開済み(expanded)のシリーズは二度と展開しない。
 * series ファイル未作成のものは pendingSeries に積む（レポートで通知）。
 *
 * persist=false のときは展開の記録をメモリに留め、resolver.commit() を呼んだ時点で
 * _expanded.json へ書く。予約バッチが成立せずキュー（続巻）を保存しない回に「展開済み」だけが
 * 残ると、そのシリーズの続巻が二度と積まれなくなる（2026-11-02 jinan「パンどろぼう」で発生しかけた）。
 */
export function makeSeriesResolver({ pendingSeries, persist = true }) {
  const hints = loadHints();
  const expandedFile = path.join(SERIES_DIR, "_expanded.json");
  const readExpanded = () =>
    fs.existsSync(expandedFile) ? JSON.parse(fs.readFileSync(expandedFile, "utf8")) : { series: [] };
  const expanded = readExpanded();
  const added = [];

  const resolver = (row) => {
    const seriesName = hints[row.title];
    if (!seriesName) return null;
    if (expanded.series.includes(seriesName)) return null; // 重複展開しない
    const series = loadSeries(seriesName);
    if (!series) {
      pendingSeries.push({ firstVolume: row.title, series: seriesName });
      return null; // ファイルができるまでは単巻として扱う
    }
    expanded.series.push(seriesName);
    added.push(seriesName);
    if (persist) resolver.commit();
    return { name: seriesName, volumes: series.volumes };
  };
  /** この resolver で展開したシリーズを _expanded.json に確定する（他の実行の記録とマージ） */
  resolver.commit = () => {
    if (!added.length) return;
    const onDisk = readExpanded();
    for (const name of added) if (!onDisk.series.includes(name)) onDisk.series.push(name);
    ensureDir(SERIES_DIR);
    fs.writeFileSync(expandedFile, JSON.stringify(onDisk, null, 2) + "\n");
  };
  return resolver;
}
