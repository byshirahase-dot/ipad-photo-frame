// メール連絡先の確認ポップアップ（WOpacSmtYoyPopupRecWebAction）の構造を調べる探索用。
// カートに1冊入れて連絡方法を「メール」に切り替え、遷移先ページのHTMLを保存する。予約はしない。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Opac, rankResults } from "../src/opac.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const env = {};
for (const line of fs.readFileSync(path.join(root, ".env"), "utf8").split("\n")) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m) env[m[1]] = m[2];
}
const cfg = JSON.parse(fs.readFileSync(path.join(root, "accounts.json"), "utf8"));
const id = process.argv[2] || "jinan";
const title = process.argv[3] || "まほうのコップ";
const acc = cfg.accounts[id];

const opac = new Opac({
  baseUrl: cfg.opac.baseUrl,
  intervalMs: cfg.opac.requestIntervalMs,
  logDir: path.join(root, "logs", "_mailpopup", id),
  dryRun: false,
});
try {
  await opac.start();
  await opac.login(env[acc.envCard], env[acc.envPass]);
  await opac.emptyCart();
  const results = await opac.searchTitle(title);
  const cands = results?.length ? rankResults(results, title) : [];
  if (!cands.length) throw new Error("検索ヒットなし: " + title);
  await opac.openResult(cands[0].index);
  const add = await opac.addToCart();
  console.log("addToCart:", JSON.stringify(add));
  // カートへ（opac の内部メソッドは private なので、直接リンクで開く）
  const cartLink = opac.page.locator('#stat-cart, #usr-cart, a[onclick*="yoycart"]').first();
  if (await cartLink.isVisible({ timeout: 3000 }).catch(() => false)) {
    await opac.politeWait();
    await cartLink.click();
    await opac.page.waitForLoadState("domcontentloaded").catch(() => {});
  }
  await opac.shot("cart-before-mail");

  // 連絡方法セレクトを「メール」に selectOption（onchange=selectyoyrak が発火し遷移するはず）
  const sel = opac.page.locator('#receiveWay, select[name="contact"]').first();
  const beforeUrl = opac.page.url();
  console.log("cart URL:", beforeUrl);
  // selectOption は change を発火する
  await opac.politeWait();
  await sel.selectOption({ label: "メール" }).catch(async (e) => {
    console.log("selectOption(label) 失敗, value=4 で再試行:", e.message);
    await sel.selectOption({ value: "4" }).catch((e2) => console.log("value も失敗:", e2.message));
  });
  await opac.page.waitForTimeout(2500);
  await opac.page.waitForLoadState("domcontentloaded").catch(() => {});
  const afterUrl = opac.page.url();
  console.log("after-select URL:", afterUrl);
  await opac.shot("after-mail-select");

  // 遷移先（ポップアップ）ページの構造ダンプ
  const info = await opac.page.evaluate(() => {
    const btns = [];
    document.querySelectorAll('input[type="button"],input[type="submit"],button,a.button').forEach((b) => {
      const v = b.value || b.textContent || "";
      const oc = b.getAttribute("onclick") || "";
      if (v.trim() || oc) btns.push({ tag: b.tagName, value: (v || "").trim().slice(0, 30), onclick: oc.slice(0, 60) });
    });
    const mail = (document.body.innerText.match(/[\w.+-]+@[\w.-]+/) || [])[0] || "(メールアドレス表示なし)";
    return { title: document.title, mail, btns: btns.slice(0, 25) };
  });
  console.log("PAGE TITLE:", info.title);
  console.log("登録メール表示:", info.mail);
  console.log("ボタン群:");
  for (const b of info.btns) console.log(`  [${b.value}] onclick=${b.onclick}`);
  await opac.logout().catch(() => {});
} catch (e) {
  console.log("ERROR:", e.message);
} finally {
  await opac.close();
}
