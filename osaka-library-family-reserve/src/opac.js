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
  constructor({ baseUrl, intervalMs = 5000, logDir, dryRun = false, headless = true, storageStatePath = null }) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.intervalMs = intervalMs;
    this.logDir = ensureDir(logDir);
    this.dryRun = dryRun;
    this.headless = headless;
    this.storageStatePath = storageStatePath;
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
    // storageStatePath があれば前回のログインセッション（Cookie）を引き継ぐ
    if (this.storageStatePath && fs.existsSync(this.storageStatePath)) {
      pageOpts.storageState = this.storageStatePath;
    }
    this.context = await this.browser.newContext(pageOpts);
    this.page = await this.context.newPage();
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
    try {
      if (this.storageStatePath && this.context) {
        await this.context.storageState({ path: this.storageStatePath });
      }
    } catch {
      /* セッション保存失敗は無視 */
    }
    await this.browser?.close();
  }

  /** トップページを開いてログイン済みか判定する（Cookieセッション引き継ぎ確認用） */
  async isLoggedIn() {
    await this.politeWait();
    await this.page.goto(`${this.baseUrl}/WOpacSmtMnuTopAction.do`, { waitUntil: "domcontentloaded" });
    // ログイン中はメニューのリンクが「ログアウト」になる（バーは画面によって非表示のため使わない）
    const html = await this.page.content().catch(() => "");
    return html.includes("ログアウト");
  }

  /** サイトへの連続リクエストを避けるための待機 */
  async politeWait() {
    await new Promise((r) => setTimeout(r, this.intervalMs));
  }

  async shot(name, { fullPage = false } = {}) {
    this.shotCount += 1;
    const base = path.join(this.logDir, `${String(this.shotCount).padStart(2, "0")}-${name}`);
    try {
      await this.page.screenshot({ path: `${base}.png`, fullPage });
      fs.writeFileSync(`${base}.html`, await this.page.content());
    } catch {
      /* スクショ失敗は本処理を止めない */
    }
    return base;
  }

  async fail(step, err) {
    const base = await this.shot(`ERROR-${step}`, { fullPage: true });
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
      await this.page.waitForLoadState("domcontentloaded").catch(() => {});
      // ログインフォームの描画を待つ（出なければ一度だけクリックし直す）
      const formReady = await this.page
        .waitForSelector("#usrcardnumber, input[type='password']", { timeout: 8000 })
        .catch(() => null);
      if (!formReady) {
        // メニューを開き直してからもう一度だけクリック
        await this.page.locator("#openmenu2").click().catch(() => {});
        await this.page.waitForTimeout(600);
        await this.politeWait();
        await loginLink.click().catch(() => {});
        await this.page.waitForSelector("#usrcardnumber, input[type='password']", { timeout: 8000 }).catch(() => {});
      }
      await this.shot("login-form");
      const cardInput = await this.firstVisible(
        [
          "#usrcardnumber",
          'input[name="username"]',
          'input[name*="usercd" i]',
          // 注意: 汎用の input[type=text] は検索ボックスを誤爆するため入れない
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
      await this.page.waitForLoadState("domcontentloaded").catch(() => {});
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

  /**
   * 予約状況一覧から各予約の {title, state} を取得（ログイン済み前提）。
   * state の例: 待ち / 取消 / 期限切れ / 用意できています 等
   */
  async listReservationStates() {
    try {
      // ヘッダバーが無い画面（起動直後など）ならトップページへ
      const bar = this.page.locator("#stat-resv");
      if (!(await bar.isVisible({ timeout: 2000 }).catch(() => false))) {
        await this.politeWait();
        await this.page.goto(`${this.baseUrl}/WOpacSmtMnuTopAction.do`, { waitUntil: "domcontentloaded" });
      }
      await this.politeWait();
      // バーが非表示の画面では JS 関数で直接遷移する
      if (await bar.isVisible({ timeout: 2000 }).catch(() => false)) {
        await bar.click();
      } else {
        await this.page.evaluate(() => {
          // eslint-disable-next-line no-undef
          toUsrRsv(1);
        });
      }
      await this.page.waitForLoadState("domcontentloaded").catch(() => {});
      await this.page.waitForTimeout(600);
      await this.shot("rsv-list");
      // 予約状況一覧の行は div.layer-item 単位（有効予約はリンクで包まれないため a.layer-doc は使えない）
      const rows = this.page.locator("div.layer-item");
      const n = await rows.count();
      const out = [];
      for (let i = 0; i < n; i++) {
        const title = (await rows.nth(i).locator(".title").first().textContent().catch(() => ""))?.trim();
        const text = (await rows.nth(i).textContent().catch(() => "")) || "";
        const m = text.match(/予約状態\s*[:：]?\s*(\S+)/);
        if (title) out.push({ title: title.replace(/\s+/g, " "), state: m ? m[1].trim() : "" });
      }
      return out;
    } catch {
      return []; // 取得失敗は致命ではない（次回の実行で再チェック）
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
      await this.page.waitForLoadState("domcontentloaded").catch(() => {});
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
        await this.page.waitForLoadState("domcontentloaded").catch(() => {});
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
          await this.page.waitForLoadState("domcontentloaded").catch(() => {});
          await this.shot(`sorted-${title.slice(0, 12)}`);
        }
      }

      // 結果行の描画を待つ（並べ替え直後は再読込中のことがある）
      await this.page.waitForSelector("a.layer-doc", { timeout: 8000 }).catch(() => {});
      await this.page.waitForLoadState("domcontentloaded").catch(() => {});
      // 結果行: a.layer-doc の .title がタイトル。href は書誌詳細への直接リンク（GET）
      const rows = this.page.locator("a.layer-doc");
      const n = Math.min(await rows.count(), 10);
      const results = [];
      for (let i = 0; i < n; i++) {
        const t = (await rows.nth(i).locator(".title").first().textContent().catch(() => ""))?.trim();
        const w = (await rows.nth(i).locator(".writer").first().textContent().catch(() => ""))?.trim();
        const href = (await rows.nth(i).getAttribute("href").catch(() => "")) || "";
        if (t) results.push({ index: i, title: t, author: w, href });
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
    await this.page.waitForLoadState("domcontentloaded").catch(() => {});
    await this.shot("bib-detail");
  }

  /** 書誌詳細から検索結果一覧へ戻る */
  async backToResults() {
    await this.politeWait();
    await this.page.goBack({ waitUntil: "domcontentloaded" });
  }

  // ---------- 予約 ----------

  /**
   * 開いている書誌詳細をカートに入れる（予約はまだ確定しない）。
   * - 「※この書誌は予約できません。」表示の版（大型絵本・禁帯出等）は notReservable で返す
   * - dryRun 時は予約ボタンの存在確認のみで停止（カートにも入れない）
   * 返り値: { ok, dryRun?, notReservable?, message }
   *
   * サイト仕様: カート（予約候補）は複数冊ためられ、予約確定（reserveCartContents）は
   * カート内をまとめて1回で行う。1冊ずつ「カート投入→予約確定」を繰り返すと2冊目以降で
   * WOpacSmtYoyCartBackAction.do に飛んで確定ボタンが見つからず中断するため、
   * 「全冊カート投入 → 最後に1回だけ確定」という二段構えにしている。
   */
  async addToCart() {
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
      await this.politeWait();
      await addBtn.click();
      await this.page.waitForLoadState("domcontentloaded").catch(() => {});
      await this.page.waitForTimeout(1000);
      await this.shot("cart-added");
      const after = (await this.page.textContent("body")) || "";
      this.#assertNotLoginPage(after);
      // 「カートに入れる」ボタンがまだ有効なままなら投入に失敗している可能性
      return { ok: true, message: "カート投入" };
    } catch (err) {
      await this.fail(`addToCart`, err);
    }
  }

  /**
   * 開いている書誌詳細から単冊で予約する（刻み実行モードの後方互換）。
   * カート投入 → そのままカート内を確定、の順で1冊分だけ行う。
   */
  async reserveCurrent({ pickupBranch, contactMethod }) {
    const add = await this.addToCart();
    if (!add || !add.ok || add.dryRun) return add;
    const countBefore = await this.currentReserveCount();
    return await this.reserveCartContents({ pickupBranch, contactMethod, countBefore });
  }

  /**
   * 書誌詳細URLへ直接遷移して単冊で予約する（刻み実行モード用）。
   * 返り値は reserveCurrent と同じ。
   */
  async reserveAtUrl(url, { pickupBranch, contactMethod }) {
    try {
      await this.politeWait();
      await this.page.goto(url, { waitUntil: "domcontentloaded" });
      await this.shot("bib-detail");
    } catch (err) {
      await this.fail(`reserveAtUrl`, err);
    }
    return await this.reserveCurrent({ pickupBranch, contactMethod });
  }

  /** ログイン画面へ転落していたらセッション切れとして専用エラーを投げる */
  #assertNotLoginPage(body) {
    if (/ログイン認証/.test(body || "")) {
      throw new Error("セッション切れ（予約フローの途中でログイン画面が表示された）");
    }
  }

  /** カート（予約候補）画面へ遷移する */
  async #openCart() {
    if (!/カート\s*（?予約候補/.test((await this.page.textContent("body")) || "")) {
      const cartLink = this.page.locator('#stat-cart, #usr-cart, a[onclick*="yoycart"]').first();
      await this.politeWait();
      await cartLink.click();
      await this.page.waitForLoadState("domcontentloaded").catch(() => {});
    }
    await this.shot("cart");
  }

  /** カート内の予約候補を一括削除して空にする（残留候補の混入を防ぐ・best-effort） */
  async emptyCart() {
    try {
      await this.#openCart();
      const body = (await this.page.textContent("body")) || "";
      this.#assertNotLoginPage(body);
      if (/カートに\s*0\s*件/.test(body)) return;
      const delAll = this.page
        .locator('input[value*="一括削除"], input[onclick*="delAll"], button:has-text("一括削除")')
        .first();
      if (!(await delAll.isVisible({ timeout: 2000 }).catch(() => false))) return;
      await this.politeWait();
      await delAll.click().catch(() => {});
      // ページ内モーダルの確認（はい/OK/削除）が出れば押す
      const okBtn = this.page
        .locator('button:has-text("はい"), input[value*="はい"], button:has-text("OK"), input[value*="削除"]')
        .first();
      if (await okBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
        await okBtn.click().catch(() => {});
      }
      await this.page.waitForLoadState("domcontentloaded").catch(() => {});
      await this.page.waitForTimeout(800);
      await this.shot("cart-emptied");
    } catch {
      // クリア失敗は致命的でない（後段の確定で件数増分により実態を判定する）
    }
  }

  /**
   * カート（予約候補）内をまとめて予約確定する。カート内の全候補が対象。
   * countBefore を渡すと、確定後の予約中冊数の増分で成否・成立冊数を判定できる。
   * 返り値: { ok, message, countBefore, countAfter, delta }
   */
  async reserveCartContents({ pickupBranch, contactMethod, countBefore = null }) {
    try {
      if (countBefore == null) countBefore = await this.currentReserveCount();
      await this.#openCart();

      const cartBody = (await this.page.textContent("body")) || "";
      this.#assertNotLoginPage(cartBody);
      if (/カートに\s*0\s*件/.test(cartBody)) {
        return { ok: false, message: "カートが0件（予約対象なし）", countBefore, countAfter: countBefore, delta: 0 };
      }

      // 連絡方法（メール等）を最初に確定する。
      // 連絡方法セレクト（name="contact" id="receiveWay"）の onchange="selectyoyrak(this.value)" は
      // 「contactweb=値; action=WOpacSmtYoyPopupRecWebAction.do?webrak=1; フォームsubmit」を行い、
      // カートを再描画して戻る（別ダイアログや確認ボタンは無い。実測で戻り後に連絡方法=メール・
      // contactweb=4 を確認）。この遷移でカートが再読込され全選択・受取館選択がリセットされるため、
      // 連絡方法を最初に確定してから全選択・受取館・予約実行を行う。
      // ※アカウントにメールアドレスが登録済みであることが前提（未登録だと既定の電話に戻る）。
      if (contactMethod) {
        const cSel = this.page.locator('#receiveWay, select[name="contact"]').first();
        if ((await cSel.count()) > 0) {
          const cur = await cSel
            .evaluate((s) => (s.options[s.selectedIndex]?.textContent || "").trim())
            .catch(() => "");
          if (!cur.includes(contactMethod)) {
            await this.politeWait();
            // selectOption は change を発火し、selectyoyrak によるカート再描画（遷移）を起こす
            await cSel.selectOption({ label: contactMethod }).catch(() => {});
            await this.page.waitForLoadState("domcontentloaded").catch(() => {});
            await this.page.waitForTimeout(1500);
            await this.#openCart(); // 遷移後、確実にカート画面へ戻す
          }
        } else {
          await this.shot("contact-select-missing");
        }
        await this.shot("contact-set");
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
        // 受取館セレクトが無い＝ログイン画面へ戻された可能性を先に確認
        this.#assertNotLoginPage(await this.page.textContent("body"));
        return { ok: false, message: `受取館セレクトが見つかりません（${pickupBranch}）`, countBefore, countAfter: countBefore, delta: 0 };
      }
      await this.page.waitForTimeout(500);
      await this.shot("reserve-branch-set");

      // 予約する（exec()＝カート内をまとめて予約確定）
      const reserveBtn = await this.firstVisible(
        ['input[value*="予約する"], button:has-text("予約する")', 'input[value*="予約"]'],
        "予約するボタン"
      );
      await this.politeWait();
      await reserveBtn.click();
      await this.page.waitForLoadState("domcontentloaded").catch(() => {});
      await this.page.waitForTimeout(1000);
      await this.shot("reserve-confirm");

      // 確認画面があれば 決定/送信/はい/申込 で確定（exec の「予約する」は再クリックしない）
      let done = (await this.page.textContent("body")) || "";
      if (!/受付|完了|予約しました|予約を受け付け/.test(done)) {
        const finalBtn = this.page
          .locator('input[value*="決定"], input[value*="送信"], input[value*="はい"], input[value*="申込"], button:has-text("決定"), button:has-text("申込")')
          .first();
        if (await finalBtn.isVisible({ timeout: 4000 }).catch(() => false)) {
          await this.politeWait();
          // 確定ボタンのクリックは遷移中タイムアウトで全体を中断させない（増分判定にフォールバック）
          await finalBtn.click({ timeout: 8000 }).catch(() => {});
          await this.page.waitForLoadState("domcontentloaded").catch(() => {});
          await this.page.waitForTimeout(1000);
          await this.shot("reserve-done");
          done = (await this.page.textContent("body")) || "";
        }
      }

      if (/ログイン認証/.test(done)) {
        throw new Error("セッション切れ（予約確定前にログイン画面が表示された）");
      }

      // 成立判定について:
      // - ヘッダの予約中カウント（#stat-resv）は画面により取得できず null になり不安定。
      // - 予約直後に予約状況一覧を開こうとすると、#stat-resv が無い画面ではトップページへ
      //   遷移し、トップページはログイン状態をリセットするため一覧が空になり誤判定する
      //   （CLAUDE.md「トップページを開くとログイン状態がリセットされる」）。
      // そこで、予約枠内（＝事前に available で冊数制限済み）のバッチは必ず成立するという
      // サイト挙動に基づき、明示的な失敗文言が無ければ成立とみなす。成立冊数の最終確認は
      // 別途 scripts/verify-reservations.mjs（新規ログインでの一覧照合）で行う。
      const countAfter = await this.currentReserveCount();
      const delta = countBefore != null && countAfter != null ? countAfter - countBefore : null;
      const textOk = /受付|完了|予約しました|予約を受け付け/.test(done);
      const hasError = /予約の?上限|これ以上予約|予約できません|受け付けられません|エラーが/.test(done);
      if (hasError && !textOk && !(delta != null && delta > 0)) {
        const m = done.match(/.{0,50}(上限|予約できません|受け付けられません|エラー).{0,50}/)?.[0]?.trim() ?? "画面参照";
        return { ok: false, message: `予約失敗: ${m}`, countBefore, countAfter, delta };
      }
      return { ok: true, message: "予約完了", countBefore, countAfter, delta };
    } catch (err) {
      await this.fail(`reserveCart`, err);
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
export function rankResults(results, wantedTitle, limit = 3, preferBunko = false) {
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
    // 母は同名書籍で文庫版があれば文庫を優先（単行本の完全一致より上に来るよう加点）
    if (preferBunko && /文庫/.test(`${r.title} ${r.writer ?? ""}`)) score += 50;
    scored.push({ ...r, score });
  }
  scored.sort((a, b) => b.score - a.score || a.index - b.index);
  return scored.slice(0, limit);
}
