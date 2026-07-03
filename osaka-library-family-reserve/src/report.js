import fs from "node:fs";
import path from "node:path";
import { ROOT, ensureDir, todayStr } from "./config.js";

/** 実行結果を reports/YYYY-MM-DD.md に出力する */
export function writeReport({ dryRun, sections, pendingSeries }) {
  const date = todayStr();
  ensureDir(path.join(ROOT, "reports"));
  const file = path.join(ROOT, "reports", `${date}.md`);

  const lines = [];
  lines.push(`# 図書館予約レポート ${date}${dryRun ? "（ドライラン）" : ""}`, "");

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
