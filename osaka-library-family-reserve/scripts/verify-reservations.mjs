// 読み取り専用: 指定アカウントの実際の予約一覧をサイトから取得して表示する（予約操作はしない）
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Opac } from "../src/opac.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");

// .env 読み込み
const env = {};
for (const line of fs.readFileSync(path.join(root, ".env"), "utf8").split("\n")) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m) env[m[1]] = m[2];
}
const cfg = JSON.parse(fs.readFileSync(path.join(root, "accounts.json"), "utf8"));

const ids = process.argv.slice(2);
for (const id of ids) {
  const acc = cfg.accounts[id];
  const opac = new Opac({
    baseUrl: cfg.opac.baseUrl,
    intervalMs: cfg.opac.requestIntervalMs,
    logDir: path.join(root, "logs", "_verify", id),
    dryRun: false,
  });
  try {
    await opac.start();
    await opac.login(env[acc.envCard], env[acc.envPass]);
    const count = await opac.currentReserveCount();
    const states = await opac.listReservationStates();
    console.log(`\n==== ${id} (${acc.name}) 予約中カウント=${count} 一覧${states.length}件 ====`);
    for (const s of states) console.log(`  - [${s.state || "?"}] ${s.title}`);
    await opac.logout();
  } catch (e) {
    console.log(`${id}: ERROR ${e.message}`);
  } finally {
    await opac.close();
  }
}
