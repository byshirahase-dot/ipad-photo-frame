import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import { ensureDir } from "./config.js";

/**
 * 大阪市立図書館 蔵書検索システム (licsxp-opac / LICS-Re系) の Playwright ドライバ。
 *
 * 注意: セレクタは 2026-07 時点の LICS-Re 系 OPAC の一般的な構造に基づく。
 * 初回のドライラン（要ネットワーク）で必ず検証し、ズレがあれば本ファイルの
 * ロケータ定義だけを直せば済むよう、画面操作はすべてここに集約している。
 * 失敗時は logs/ にスクリーンショットと HTML を保存する。
 */
export class Opac {
  constructor({ baseUrl, intervalMs = 5000, logDir, dryRun = false, headless = true }) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.intervalMs = intervalMs;
    this.logDir = ensureDir(logDir);
    this.dryRun = dryRun;
    this.headless = headless;
    this.shotCount = 0;
  }

  async start() {
    const opts = { headless: this.headless };
    // クラウド環境のプリインストール Chromium を優先的に使う
    const preinstalled = process.env.OML_CHROMIUM_PATH;
    if (preinstalled && fs.existsSync(preinstalled)) opts.executablePath = preinstalled;
    // 環境が HTTPS プロキシ経由の場合（Claude Code クラウド等）はブラウザもプロキシを使う
    const proxyServer = process.env.HTTPS_PROXY || process.env.https_proxy;
    const pageOpts = { locale: "ja-JP" };
    if (proxyServer) {
      opts.proxy = { server: proxyServer };
      pageOpts.ignoreHTTPSErrors = true; // プロキシのMITM CAを許容（プロキシ利用時のみ）
    }
    this.browser = await chromium.launch(opts);
    this.page = await this.browser.newPage(pageOpts);
    this.page.setDefaultTimeout(20000);
    // confirm/alert ダイアログは受け入れる（LICSは確認にJSダイアログを使うことがある）
    this.page.on("dialog", (d) => d.accept().catch(() => {}));
    if (proxyServer) {
      // Chromium とプロキシ終端の TLS 非互換対策:
      // リクエストを Playwright の Node 側 fetch（プロキシ・CA設定済み）で中継する
      await this.page.route("**/*", async (route) => {
        try {
          const resp = await route.fetch({ maxRedirects: 0 });
          await route.fulfill({ response: resp });
        } catch {
          await route.abort().catch(() => {});
        }
      });
    }
  }

  async close() {
    await this.browser?.close();
  }

  /** サイトへの連続リクエストを避けるための待機 */
  async politeWait() {
    await new Promise((r) => setTimeout(r, this.intervalMs));
  }

  async shot(name) {
    this.shotCount += 1;
    const base = path.join(this.logDir, `${String(this.shotCount).padStart(2, "0")}-${name}`);
    try {
      await this.page.screenshot({ path: `${base}.png`, fullPage: true });
      fs.writeFileSync(`${base}.html`, await this.page.content());
    } catch {
      /* スクショ失敗は本処理を止めない */
    }
    return base;
  }

  async fail(step, err) {
    const base = await this.shot(`ERROR-${step}`);
    const e = new Error(`[${step}] ${err.message}\n証跡: ${base}.png / ${base}.html`);
    e.step = step;
    throw e;
  }

  /** 複数候補のロケータから最初に「見えている」要素を返す（候補ごとに先頭5件まで走査） */
  async firstVisible(cands, what) {
    for (const c of cands) {
      const loc = typeof c === "string" ? this.page.locator(c) : c;
      try {
        const n = Math.min(await loc.count(), 5);
        for (let i = 0; i < n; i++) {
          const el = loc.nth(i);
          if (await el.isVisible({ timeout: 1000 }).catch(() => false)) return el;
        }
      } catch {
        /* 次の候補へ */
      }
    }
    throw new Error(`画面要素が見つかりません: ${what}（サイト構造が変わった可能性）`);
  }

  // ---------- ログイン ----------

  async login(card, pass) {
    try {
      await this.politeWait();
      await this.page.goto(`${this.baseUrl}/WOpacSmtMnuTopAction.do`, {
        waitUntil: "domcontentloaded",
      });
      await this.shot("top");
      // 「マイ図書館」メニューを開いてから「ログイン」リンク（JS遷移）
      const menuBtn = this.page.locator("#openmenu2");
      if (await menuBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
        await menuBtn.click();
        await this.page.waitForTimeout(800);
      }
      const loginLink = await this.firstVisible(
        ["a#usr-lgin", 'a:has-text("ログイン")'],
        "ログインリンク"
      );
      await this.politeWait();
      await loginLink.click();
      await this.page.waitForLoadState("domcontentloaded");
      await this.shot("login-form");
      const cardInput = await this.firstVisible(
        [
          "#usrcardnumber",
          'input[name="username"]',
          'input[name*="usercd" i]',
          'form input[type="text"]',
        ],
        "カード番号入力欄"
      );
      await cardInput.fill(card);
      const passInput = await this.firstVisible(
        ["#password", 'input[type="password"]'],
        "パスワード入力欄"
      );
      await passInput.fill(pass);
      const loginBtn = await this.firstVisible(
        [
          'input[value*="ログイン"]',
          this.page.getByRole("button", { name: /ログイン/ }),
          'input[type="submit"][value*="ログイン"]',
        ],
        "ログインボタン"
      );
      await loginBtn.click();
      await this.page.waitForLoadState("domcontentloaded");
      const body = await this.page.textContent("body");
      if (/(パスワード|カード).*(誤り|正しく|一致しません)|認証に失敗/.test(body || "")) {
        throw new Error("ログイン失敗（カード番号またはパスワードが違う）");
      }
      await this.shot("login-ok");
      return true;
    } catch (err) {
      await this.fail("login", err);
    }
  }

  // ---------- 予約状況（枠の残数確認） ----------

  /** ログイン後のヘッダバー（#stat-resv）から現在の予約冊数を取得。取れない場合は null */
  async currentReserveCount() {
    try {
      const v = await this.page
        .locator("#stat-resv .value")
        .first()
        .textContent({ timeout: 5000 });
      const n = Number((v || "").trim());
      return Number.isInteger(n) ? n : null;
    } catch {
      return null; // 取得失敗は致命ではない。呼び出し側で保守的に扱う
    }
  }

  // ---------- 検索 ----------

  /** 書名検索して結果一覧を返す: [{ index, title, author }] */
  async searchTitle(title) {
    try {
      await this.politeWait();
      await this.page.goto(`${this.baseUrl}/WOpacSmtMnuTopAction.do`, {
        waitUntil: "domcontentloaded",
      });
      const box = await this.firstVisible(
        [
          "#SearchKWInputSearch",
          'input[name="kensaku_keyword"]',
          this.page.getByLabel(/書名|タイトル|キーワード/),
          'input[name*="word" i]',
          'form input[type="text"]',
        ],
        "検索キーワード入力欄"
      );
      await box.fill(title);
      const btn = await this.firstVisible(
        [
          "#schButtonSearch",
          'input[type="image"][alt="検索"]',
          this.page.getByRole("button", { name: /検索/ }),
          'input[type="submit"][value*="検索"]',
        ],
        "検索ボタン"
      );
      await btn.click();
      await this.page.waitForLoadState("domcontentloaded");
      await this.shot(`search-${title.slice(0, 12)}`);

      if (await this.#noHits()) return [];

      // 全項目検索は雑誌などのノイズが多いので、絞込みフォームで「書名」再検索
      const narrowBox = this.page.locator("#search_add");
      if (await narrowBox.isVisible({ timeout: 3000 }).catch(() => false)) {
        await this.page.selectOption("#searchkind_add", "0"); // 書名
        await narrowBox.fill(title);
        await this.politeWait();
        // 再検索ボタンは input の onchange で有効化されるため JS で直接実行
        await this.page.evaluate(() => {
          // eslint-disable-next-line no-undef
          submitNarrow();
        });
        await this.page.waitForLoadState("domcontentloaded");
        await this.shot(`narrow-${title.slice(0, 12)}`);
        if (await this.#noHits()) return [];
      }

      // 出版年昇順に並べ替え（原典が先頭に、最新の雑誌・特殊版は後ろに）
      const sortSel = this.page.locator("#AssistSortSelect");
      if (await sortSel.isVisible({ timeout: 3000 }).catch(() => false)) {
        const opts = await sortSel.locator("option").allTextContents();
        const idx = opts.findIndex((t) => /出版年順/.test(t) && !/逆順/.test(t));
        if (idx >= 0) {
          const value = await sortSel.locator("option").nth(idx).getAttribute("value");
          await this.politeWait();
          await sortSel.selectOption(value);
          await this.page.waitForLoadState("domcontentloaded");
          await this.shot(`sorted-${title.slice(0, 12)}`);
        }
      }

      // 結果行: a.layer-doc の .title がタイトル
      const rows = this.page.locator("a.layer-doc");
      const n = Math.min(await rows.count(), 10);
      const results = [];
      for (let i = 0; i < n; i++) {
        const t = (await rows.nth(i).locator(".title").first().textContent().catch(() => ""))?.trim();
        const w = (await rows.nth(i).locator(".writer").first().textContent().catch(() => ""))?.trim();
        if (t) results.push({ index: i, title: t, author: w });
      }
      return results;
    } catch (err) {
      await this.fail(`search:${title}`, err);
    }
  }

  async #noHits() {
    const body = (await this.page.textContent("body")) || "";
    if (/該当\s*[0-9,]+\s*件/.test(body)) {
      return /該当\s*0\s*件/.test(body);
    }
    return /該当する資料(は|が)?(ありません|見つかりません)/.test(body);
  }

  /** 検索結果 index 番目の詳細を開く */
  async openResult(index) {
    const rows = this.page.locator("a.layer-doc");
    await this.politeWait();
    await rows.nth(index).click();
    await this.page.waitForLoadState("domcontentloaded");
    await this.shot("bib-detail");
  }

  /** 書誌詳細から検索結果一覧へ戻る */
  async backToResults() {
    await this.politeWait();
    await this.page.goBack({ waitUntil: "domcontentloaded" });
  }

  // ---------- 予約 ----------

  /**
   * 開いている書誌詳細から予約する（大阪市立図書館 Smt 版）。
   * - 「※この書誌は予約できません。」表示の版（大型絵本・禁帯出等）は notReservable で返す
   * - dryRun 時は予約ボタンの存在確認のみで停止（カートにも入れない）
   * 返り値: { ok, dryRun?, notReservable?, message }
   */
  async reserveCurrent({ pickupBranch }) {
    try {
      const body = (await this.page.textContent("body")) || "";
      if (/この書誌は予約できません/.test(body)) {
        return { ok: false, notReservable: true, message: "予約不可の版（大型絵本・禁帯出等）" };
      }
      // 詳細ページの「カートに入れる」ボタン（inYoyCart）
      const addBtn = this.page
        .locator('input[value*="カートに入れる"], input[onclick*="inYoyCart"], button:has-text("カートに入れる")')
        .first();
      if (!(await addBtn.isVisible({ timeout: 4000 }).catch(() => false))) {
        return { ok: false, notReservable: true, message: "カートに入れるボタンが見つからない版（スクショ参照）" };
      }

      if (this.dryRun) {
        return { ok: true, dryRun: true, message: "【ドライラン】予約可能を確認（カート投入前で停止）" };
      }

      const countBefore = await this.currentReserveCount();

      // カートに入れる
      await this.politeWait();
      await addBtn.click();
      await this.page.waitForLoadState("domcontentloaded");
      await this.page.waitForTimeout(1000);
      await this.shot("cart-added");

      // カート（予約候補）画面へ
      if (!/カート\s*（?予約候補/.test((await this.page.textContent("body")) || "")) {
        const cartLink = this.page.locator('#stat-cart, #usr-cart, a[onclick*="yoycart"]').first();
        await this.politeWait();
        await cartLink.click();
        await this.page.waitForLoadState("domcontentloaded");
      }
      await this.shot("cart");

      const cartBody = (await this.page.textContent("body")) || "";
      if (/カートに\s*0\s*件/.test(cartBody)) {
        return { ok: false, message: "カート投入に失敗（カートが0件のまま）" };
      }

      // 対象を選択（全選択チェックボックス）
      const selectAll = this.page.locator('input[type="checkbox"]').first();
      if (await selectAll.isVisible({ timeout: 2000 }).catch(() => false)) {
        await selectAll.check().catch(() => {});
      }

      // 受取館の選択（阿倍野などを含む select。カレンダー切替と区別するため受取館の近傍を優先）
      const branchSelect = this.page
        .locator("select")
        .filter({ has: this.page.locator(`option:has-text("${pickupBranch}")`) })
        .first();
      if ((await branchSelect.count()) > 0) {
        const opts = branchSelect.locator("option");
        const n = await opts.count();
        for (let i = 0; i < n; i++) {
          const t = (await opts.nth(i).textContent())?.trim() ?? "";
          if (t.includes(pickupBranch)) {
            await branchSelect.selectOption({ index: i });
            break;
          }
        }
      } else {
        return { ok: false, message: `受取館セレクトが見つかりません（${pickupBranch}）` };
      }
      await this.shot("reserve-branch-set");

      // 予約する
      const reserveBtn = await this.firstVisible(
        ['input[value*="予約する"], button:has-text("予約する")', 'input[value*="予約"]'],
        "予約するボタン"
      );
      await this.politeWait();
      await reserveBtn.click();
      await this.page.waitForLoadState("domcontentloaded");
      await this.page.waitForTimeout(1000);
      await this.shot("reserve-confirm");

      // 確認画面があれば 決定/送信/はい で確定
      let done = (await this.page.textContent("body")) || "";
      if (!/受付|完了|予約しました|予約を受け付け/.test(done)) {
        const finalBtn = this.page
          .locator('input[value*="決定"], input[value*="送信"], input[value*="はい"], button:has-text("決定"), input[value*="予約する"]')
          .first();
        if (await finalBtn.isVisible({ timeout: 4000 }).catch(() => false)) {
          await this.politeWait();
          await finalBtn.click();
          await this.page.waitForLoadState("domcontentloaded");
          await this.page.waitForTimeout(1000);
          await this.shot("reserve-done");
          done = (await this.page.textContent("body")) || "";
        }
      }

      if (/受付|完了|予約しました|予約を受け付け/.test(done)) {
        return { ok: true, message: "予約完了" };
      }
      // 文言で判定できない場合は予約中カウントの増加で判定
      const countAfter = await this.currentReserveCount();
      if (countBefore != null && countAfter != null && countAfter > countBefore) {
        return { ok: true, message: `予約完了（予約中 ${countBefore}→${countAfter} 冊で確認）` };
      }
      if (/上限|できません|エラー/.test(done)) {
        return { ok: false, message: `予約失敗: ${done.match(/.{0,50}(上限|できません|エラー).{0,50}/)?.[0]?.trim() ?? "画面参照"}` };
      }
      return { ok: false, message: "予約結果を確認できませんでした（スクリーンショット参照）" };
    } catch (err) {
      await this.fail(`reserve`, err);
    }
  }

  async logout() {
    try {
      const btn = this.page.getByRole("link", { name: /ログアウト/ });
      if (await btn.first().isVisible({ timeout: 1500 })) {
        await this.politeWait();
        await btn.first().click();
      }
    } catch {
      /* ログアウト失敗は無視 */
    }
  }
}

/**
 * 検索結果を予約候補順に並べる。
 * 完全一致 > 前方一致 > 部分一致。特殊版らしきもの（大型絵本・紙芝居等）は後回し。
 */
export function rankResults(results, wantedTitle, limit = 3) {
  const norm = (s) => String(s).replace(/[\s　]/g, "").toLowerCase();
  const w = norm(wantedTitle);
  const special = /大型|紙芝居|点字|デイジー|カセット|大活字|DVD|CD/;
  const scored = [];
  for (const r of results) {
    const t = norm(r.title);
    let score = -1;
    if (t === w) score = 100;
    else if (t.startsWith(w)) score = 60;
    else if (t.includes(w) || w.includes(t)) score = 40;
    if (score < 0) continue;
    if (special.test(r.title)) score -= 30;
    scored.push({ ...r, score });
  }
  scored.sort((a, b) => b.score - a.score || a.index - b.index);
  return scored.slice(0, limit);
}
