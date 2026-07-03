import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { ROOT, todayStr, ensureDir } from "./config.js";

/**
 * npm run rate — 最近予約した本への評価を対話的に入力して
 * data/mom/history.csv に追記する（Cowork の次回選書の材料になる）。
 */
const HISTORY = path.join(ROOT, "data", "mom", "history.csv");
const RECOMMENDED = path.join(ROOT, "state", "mom", "recommended.json");

function loadRecent() {
  if (!fs.existsSync(RECOMMENDED)) return [];
  const data = JSON.parse(fs.readFileSync(RECOMMENDED, "utf8"));
  const rated = new Set(loadHistoryTitles());
  return data.books.filter((b) => !rated.has(b.title)).slice(-20);
}

function loadHistoryTitles() {
  if (!fs.existsSync(HISTORY)) return [];
  return fs
    .readFileSync(HISTORY, "utf8")
    .split("\n")
    .slice(1)
    .map((l) => l.split(",")[1])
    .filter(Boolean);
}

function appendHistory({ title, author, rating, memo }) {
  ensureDir(path.dirname(HISTORY));
  if (!fs.existsSync(HISTORY)) {
    fs.writeFileSync(HISTORY, "date,title,author,rating,memo\n");
  }
  const esc = (s) => (String(s).includes(",") ? `"${s}"` : s);
  fs.appendFileSync(HISTORY, `${todayStr()},${esc(title)},${esc(author)},${rating},${esc(memo)}\n`);
}

async function main() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const recent = loadRecent();

  if (recent.length) {
    console.log("最近予約した本（未評価）:");
    recent.forEach((b, i) => console.log(`  ${i + 1}. ${b.title}${b.author ? ` / ${b.author}` : ""}`));
    console.log("番号を選ぶか、リストにない本はタイトルを直接入力してください。qで終了。\n");
  } else {
    console.log("未評価の予約履歴はありません。タイトルを直接入力してください。qで終了。\n");
  }

  for (;;) {
    const ans = (await rl.question("本（番号 or タイトル）> ")).trim();
    if (!ans || ans === "q") break;
    let title = ans;
    let author = "";
    const idx = Number(ans);
    if (Number.isInteger(idx) && idx >= 1 && idx <= recent.length) {
      title = recent[idx - 1].title;
      author = recent[idx - 1].author ?? "";
    }
    let rating = 0;
    for (;;) {
      const r = Number((await rl.question("評価 1〜5 > ")).trim());
      if (Number.isInteger(r) && r >= 1 && r <= 5) {
        rating = r;
        break;
      }
      console.log("1〜5 で入力してください。");
    }
    const memo = (await rl.question("一言メモ（省略可）> ")).trim();
    appendHistory({ title, author, rating, memo });
    console.log(`✅ 記録しました: ${title} ★${rating}\n`);
  }

  rl.close();
  console.log(`履歴: ${path.relative(process.cwd(), HISTORY)}`);
}

main();
