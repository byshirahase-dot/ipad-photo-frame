import fs from "node:fs";
import path from "node:path";
import { ROOT, ensureDir, todayStr } from "./config.js";

/**
 * 実行結果を reports/YYYY-MM-DD.md に出力する。
 * アカウント別に分割実行しても1つのレポートにまとまるよう、同日のセクションは
 * キャッシュ（reports/.cache-日付.json）にマージしてから全体を再生成する。
 *
 * slug を渡すと reports/{slug}.md に書く（単発予約は "adhoc-日付" を渡し、
 * 週次レポート reports/日付.md を上書きしないようにする）。
 */
export function writeReport({ dryRun, sections, pendingSeries, slug = null }) {
  const date = todayStr();
  ensureDir(path.join(ROOT, "reports"));
  const name = slug || date;
  const file = path.join(ROOT, "reports", `${name}.md`);

  const cacheFile = path.join(ROOT, "reports", `.cache-${name}.json`);
  const cache = fs.existsSync(cacheFile)
    ? JSON.parse(fs.readFileSync(cacheFile, "utf8"))
    : { sections: {}, pendingSeries: [] };
  for (const s of sections) cache.sections[s.accountId] = s;
  for (const p of pendingSeries ?? []) {
    if (!cache.pendingSeries.some((q) => q.series === p.series)) cache.pendingSeries.push(p);
  }
  fs.writeFileSync(cacheFile, JSON.stringify(cache, null, 2) + "\n");
  sections = Object.values(cache.sections);
  pendingSeries = cache.pendingSeries;

  const lines = [];
  const heading = slug ? `図書館 単発予約レポート ${date}` : `図書館予約レポート ${date}`;
  lines.push(`# ${heading}${dryRun ? "（ドライラン）" : ""}`, "");

  for (const s of sections) {
    lines.push(`## ${s.name}（${s.accountId} / ${s.mode}）`, "");
    if (s.skippedReason) {
      lines.push(`- ⏸ スキップ: ${s.skippedReason}`, "");
      continue;
    }
    if (s.reserveCount != null) {
      lines.push(`- 現在の予約冊数: ${s.reserveCount} / 上限 ${s.reserveLimit}`);
    }
    lines.push("");
    if (s.requeued?.length) {
      lines.push("### 予約が無効になっていた本（再予約リストに戻しました）");
      for (const b of s.requeued) lines.push(`- 🔁 ${b.title}（予約状態: ${b.state}${dryRun ? "／ドライランのため未処理" : ""}）`);
      lines.push("");
    }
    if (s.reserved.length) {
      lines.push(`### ${dryRun ? "予約予定" : "予約成功"}`);
      for (const b of s.reserved) lines.push(`- ✅ ${b.title}${b.note ? `（${b.note}）` : ""}`);
      lines.push("");
    }
    if (s.failed.length) {
      lines.push("### 失敗・所蔵なし");
      for (const b of s.failed) lines.push(`- ❌ ${b.title} — ${b.note}`);
      lines.push("");
    }
    if (s.next) {
      lines.push(`### 次回`, `- 次回の開始位置: ${s.next.level} レベル ${s.next.position} 冊目`, "");
    }
  }

  if (pendingSeries?.length) {
    lines.push("## 🔎 シリーズ展開待ち（Cowork の Claude が作成する）", "");
    for (const p of pendingSeries) {
      lines.push(`- 「${p.firstVolume}」 → data/series/${p.series}.json を作成してください`);
    }
    lines.push("");
  }

  fs.writeFileSync(file, lines.join("\n"));
  return file;
}
