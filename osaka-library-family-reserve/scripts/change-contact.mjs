// 既存予約の連絡方法を「メール」に一括変更する（予約状況一覧の各 selren セレクト → 予約内容更新）。
// 使い方:
//   node scripts/change-contact.mjs chojo chonan jinan            # 現状の連絡方法を表示するだけ（変更しない）
//   node scripts/change-contact.mjs --apply chojo chonan jinan    # メールに変更して再確認
// 母(mom)は対象外運用（ユーザーが手動変更済み）。呼び出し側で mom を渡さないこと。
//
// 【状態 2026-07-05】読み取り（--apply なし）は動作。--apply の更新は未完成:
//   予約内容更新（yoykSyusei → WOpacSmtUsrRsvSyuseiAction.do への POST）が、トップ経由・直接URL・
//   #stat-resv クリックのいずれの経路でも「ログイン認証」ページへリダイレクトされ、変更が反映されない
//   （セッション/トークンの問題と推測。予約自体は無変更で無害）。
//   次の一手候補: ログイン後にマイ図書館メニュー（#openmenu2→予約状況確認）を辿る認証済み経路で一覧へ入り、
//   postSeq などの hidden トークンが有効な状態で LBForm を submit する。あるいは連絡方法は今後の新規予約
//   （コード修正済み＝メール）に任せ、既存分はマイページで手動変更する。
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

const argv = process.argv.slice(2);
const apply = argv.includes("--apply");
const ids = argv.filter((a) => !a.startsWith("--"));
const TARGET = "メール";

// 予約状況一覧を開いて、各予約の連絡方法（selren セレクトの選択値）を返す
async function readContacts(page) {
  return await page.evaluate(() => {
    const out = [];
    document.querySelectorAll('select[id^="selren"]').forEach((sel) => {
      const id = sel.id.replace("selren", "");
      const cur = sel.options[sel.selectedIndex]?.textContent?.trim() ?? "";
      // 同じ行のタイトル
      const item = sel.closest(".layer-item");
      const title = item?.querySelector(".title")?.textContent?.trim().replace(/\s+/g, " ") ?? "";
      out.push({ id, current: cur, title });
    });
    return out;
  });
}

async function gotoRsvList(opac) {
  // ログイン直後の認証済みページから #stat-resv（予約状況）を直接クリックして一覧へ。
  // トップページ経由（ログイン状態リセット）や直接URL（セッショントークン欠落で更新POSTが
  // ログイン画面に飛ぶ）を避け、予約内容更新まで同一セッションで通す。
  const bar = opac.page.locator("#stat-resv");
  if (await bar.isVisible({ timeout: 6000 }).catch(() => false)) {
    await opac.politeWait();
    await bar.click();
    await opac.page.waitForLoadState("domcontentloaded").catch(() => {});
    await opac.page.waitForTimeout(700);
  } else {
    await opac.politeWait();
    await opac.page.goto(`${opac.baseUrl}/WOpacSmtUsrRsvListAction.do`, { waitUntil: "domcontentloaded" });
    await opac.page.waitForTimeout(600);
  }
  await opac.shot("rsv-list");
}

for (const id of ids) {
  const acc = cfg.accounts[id];
  if (id === "mom") {
    console.log("mom はスキップ（手動変更済みのため対象外）");
    continue;
  }
  const opac = new Opac({
    baseUrl: cfg.opac.baseUrl,
    intervalMs: cfg.opac.requestIntervalMs,
    logDir: path.join(root, "logs", "_contact", id),
    dryRun: false,
  });
  try {
    await opac.start();
    await opac.login(env[acc.envCard], env[acc.envPass]);
    await gotoRsvList(opac);
    await opac.shot("before");
    const before = await readContacts(opac.page);
    console.log(`\n==== ${id} (${acc.name}) 予約 ${before.length} 件 ====`);
    for (const b of before) console.log(`  [${b.current}] ${b.title}`);

    if (!apply) {
      await opac.logout();
      await opac.close();
      continue;
    }

    const need = before.filter((b) => b.current !== TARGET);
    if (!need.length) {
      console.log("  → すべて既にメール。変更不要。");
      await opac.logout();
      await opac.close();
      continue;
    }
    // 各 selren をメールに設定し、onchange(dropChange) を発火させる
    const changed = await opac.page.evaluate((target) => {
      const done = [];
      document.querySelectorAll('select[id^="selren"]').forEach((sel) => {
        const opt = Array.from(sel.options).find((o) => (o.textContent || "").trim() === target);
        if (!opt) return;
        if (sel.value === opt.value) return;
        sel.value = opt.value;
        sel.dispatchEvent(new Event("change", { bubbles: true }));
        done.push(sel.id);
      });
      return done;
    }, TARGET);
    console.log(`  変更対象 ${changed.length} 件のセレクトをメールに設定`);
    await opac.page.waitForTimeout(500);
    // 「予約内容更新」ボタンで確定
    const btn = opac.page.locator('input[value="予約内容更新"], input[onclick*="yoykSyusei"]').first();
    await opac.politeWait();
    await btn.click().catch((e) => console.log("  更新ボタンclick例外:", e.message));
    // 確認ダイアログ（ページ内モーダル）が出れば はい/OK
    const ok = opac.page
      .locator('button:has-text("はい"), input[value*="はい"], button:has-text("OK"), input[value*="確定"]')
      .first();
    if (await ok.isVisible({ timeout: 2500 }).catch(() => false)) {
      await ok.click().catch(() => {});
    }
    await opac.page.waitForLoadState("domcontentloaded").catch(() => {});
    await opac.page.waitForTimeout(1200);
    await opac.shot("after");

    // 再確認（一覧を開き直して読む）
    await gotoRsvList(opac);
    const after = await readContacts(opac.page);
    const still = after.filter((a) => a.current !== TARGET);
    console.log(`  変更後: メール ${after.filter((a) => a.current === TARGET).length}/${after.length} 件`);
    if (still.length) {
      console.log("  ⚠ まだメールでない予約:");
      for (const s of still) console.log(`    [${s.current}] ${s.title}`);
    } else {
      console.log("  ✅ 全件メールに変更完了");
    }
    await opac.logout();
  } catch (e) {
    console.log(`${id}: ERROR ${e.message}`);
  } finally {
    await opac.close();
  }
}
