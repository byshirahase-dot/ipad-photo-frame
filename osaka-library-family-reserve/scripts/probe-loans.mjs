// 読み取り専用: opac.listLoanTitles() を検証する（予約操作なし）
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Opac } from "../src/opac.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const env = {};
for (const line of fs.readFileSync(path.join(root, ".env"), "utf8").split("\n")) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m) env[m[1]] = m[2];
}
const cfg = JSON.parse(fs.readFileSync(path.join(root, "accounts.json"), "utf8"));

for (const id of process.argv.slice(2)) {
  const acc = cfg.accounts[id];
  const opac = new Opac({
    baseUrl: cfg.opac.baseUrl,
    intervalMs: cfg.opac.requestIntervalMs,
    logDir: path.join(root, "logs", "_probe", id),
    dryRun: false,
  });
  try {
    await opac.start();
    await opac.login(env[acc.envCard], env[acc.envPass]);
    const loans = await opac.listLoanTitles();
    console.log(`\n==== ${id} (${acc.name}) 貸出中 ${loans.length}件 ====`);
    for (const t of loans) console.log("  -", t);
    await opac.logout().catch(() => {});
  } catch (e) {
    console.log(`${id}: ERROR ${e.message}`);
  } finally {
    await opac.close();
  }
}
