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

  /** 複数候補のロケータから最初に見つかったものを返す */
  async firstVisible(cands, what) {
    for (const c of cands) {
      const loc = typeof c === "string" ? this.page.locator(c) : c;
      try {
        const el = loc.first();
        if (await el.isVisible({ timeout: 1500 })) return el;
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
      // トップページの「ログイン」リンク（JS遷移）
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
          this.page.getByLabel(/図書館カード|カード番号|利用者番号/),
          'input[name*="usercd" i]',
          'input[name*="userid" i]',
          'form input[type="text"]',
          'form input[type="tel"]',
        ],
        "カード番号入力欄"
      );
      await cardInput.fill(card);
      const passInput = await this.firstVisible(
        ['input[type="password"]'],
        "パスワード入力欄"
      );
      await passInput.fill(pass);
      const loginBtn = await this.firstVisible(
        [
          this.page.getByRole("button", { name: /ログイン/ }),
          'input[type="submit"][value*="ログイン"]',
          'a:has-text("ログイン")',
          'input[type="submit"]',
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

  /** 利用状況ページから現在の予約冊数を取得する。取れない場合は null */
  async currentReserveCount() {
    try {
      await this.politeWait();
      const link = await this.firstVisible(
        [
          this.page.getByRole("link", { name: /予約中|予約状況|利用状況/ }),
          'a:has-text("予約")',
        ],
        "予約状況リンク"
      );
      await link.click();
      await this.page.waitForLoadState("domcontentloaded");
      await this.shot("reserve-status");
      const body = (await this.page.textContent("body")) || "";
      const m = body.match(/予約[^0-9]{0,10}(\d+)\s*冊/);
      if (m) return Number(m[1]);
      const rows = await this.page.locator("table tr").count();
      return rows > 1 ? rows - 1 : 0;
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

      const body = (await this.page.textContent("body")) || "";
      if (/該当する資料|見つかりません|0\s*件/.test(body) && !/\b[1-9]\d*\s*件/.test(body)) {
        return [];
      }
      // 結果一覧: 書誌詳細へのリンクを収集
      const links = this.page.locator(
        'a[href*="BibDetail"], a[href*="bibdetail" i], a[onclick*="BibDetail"], .book_title a, td a'
      );
      const n = Math.min(await links.count(), 10);
      const results = [];
      for (let i = 0; i < n; i++) {
        const text = (await links.nth(i).textContent())?.trim();
        if (text && text.length > 1) results.push({ index: i, title: text });
      }
      return results;
    } catch (err) {
      await this.fail(`search:${title}`, err);
    }
  }

  /** 検索結果 index 番目の詳細を開く */
  async openResult(index) {
    const links = this.page.locator(
      'a[href*="BibDetail"], a[href*="bibdetail" i], a[onclick*="BibDetail"], .book_title a, td a'
    );
    await this.politeWait();
    await links.nth(index).click();
    await this.page.waitForLoadState("domcontentloaded");
    await this.shot("bib-detail");
  }

  // ---------- 予約 ----------

  /**
   * 開いている書誌詳細から予約する。dryRun 時は最終確定ボタンの手前で止める。
   * 返り値: { ok, dryRun, message }
   */
  async reserveCurrent({ pickupBranch }) {
    try {
      const reserveBtn = await this.firstVisible(
        [
          this.page.getByRole("button", { name: /予約かご|予約する|予約申込/ }),
          this.page.getByRole("link", { name: /予約かご|予約する|予約申込/ }),
          'input[type="submit"][value*="予約"]',
          'a:has-text("予約")',
        ],
        "予約ボタン"
      );
      await this.politeWait();
      await reserveBtn.click();
      await this.page.waitForLoadState("domcontentloaded");
      await this.shot("reserve-form");

      // 予約かご経由の場合は「予約に進む」的なボタンをもう一段押す
      const bodyNow = (await this.page.textContent("body")) || "";
      if (/予約かご/.test(bodyNow) && !/受取/.test(bodyNow)) {
        const goBtn = await this.firstVisible(
          [
            this.page.getByRole("button", { name: /予約に進む|通常予約|予約する/ }),
            'input[type="submit"][value*="予約"]',
          ],
          "予約に進むボタン"
        );
        await this.politeWait();
        await goBtn.click();
        await this.page.waitForLoadState("domcontentloaded");
        await this.shot("reserve-form2");
      }

      // 受取館の選択
      const branchSelect = this.page.locator("select").filter({
        has: this.page.locator(`option:has-text("${pickupBranch}")`),
      });
      if ((await branchSelect.count()) > 0) {
        await branchSelect
          .first()
          .selectOption({ label: await this.#optionLabel(branchSelect.first(), pickupBranch) });
      }
      await this.shot("reserve-branch-set");

      if (this.dryRun) {
        return { ok: true, dryRun: true, message: `【ドライラン】受取館=${pickupBranch} で予約直前まで確認` };
      }

      // 確認 → 確定（LICS系は 予約 → 確認画面 → 決定 の2段が多い）
      const confirmBtn = await this.firstVisible(
        [
          this.page.getByRole("button", { name: /確認|次へ|予約/ }),
          'input[type="submit"]',
        ],
        "予約確認ボタン"
      );
      await this.politeWait();
      await confirmBtn.click();
      await this.page.waitForLoadState("domcontentloaded");
      await this.shot("reserve-confirm");

      const body2 = (await this.page.textContent("body")) || "";
      if (/受付|完了|予約しました/.test(body2)) {
        return { ok: true, message: "予約完了" };
      }
      const finalBtn = await this.firstVisible(
        [
          this.page.getByRole("button", { name: /決定|確定|送信/ }),
          'input[type="submit"][value*="決定"]',
          'input[type="submit"]',
        ],
        "予約確定ボタン"
      );
      await this.politeWait();
      await finalBtn.click();
      await this.page.waitForLoadState("domcontentloaded");
      await this.shot("reserve-done");

      const body3 = (await this.page.textContent("body")) || "";
      if (/受付|完了|予約しました/.test(body3)) {
        return { ok: true, message: "予約完了" };
      }
      if (/上限|できません|エラー/.test(body3)) {
        return { ok: false, message: `予約失敗: ${body3.match(/.{0,60}(上限|できません|エラー).{0,60}/)?.[0] ?? "画面参照"}` };
      }
      return { ok: false, message: "予約結果を確認できませんでした（スクリーンショット参照）" };
    } catch (err) {
      await this.fail(`reserve`, err);
    }
  }

  async #optionLabel(selectLoc, contains) {
    const opts = selectLoc.locator("option");
    const n = await opts.count();
    for (let i = 0; i < n; i++) {
      const t = (await opts.nth(i).textContent())?.trim();
      if (t && t.includes(contains)) return t;
    }
    return contains;
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

/** 検索結果から予約対象を選ぶ（正規化タイトルの前方一致・部分一致で最良を選択） */
export function pickBestResult(results, wantedTitle) {
  const norm = (s) => String(s).replace(/[\s　]/g, "").toLowerCase();
  const w = norm(wantedTitle);
  let best = null;
  for (const r of results) {
    const t = norm(r.title);
    if (t === w) return r;
    if ((t.includes(w) || w.includes(t)) && !best) best = r;
  }
  return best;
}
