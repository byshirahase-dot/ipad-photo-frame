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
    // ログイン確立後は true。WebOTX のセッションはノードローカル（レプリケーション無し）で、
    // ログイン後に F5 の振り分けノードを変えるとセッションが切れる。よって永続化 Cookie の
    // 破棄によるノード振り直しは「未ログイン時（＝正常ノード探し）」に限定する。
    this.authenticated = false;
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
    // 遷移待ちタイムアウト（リトライを廃したので長大にする必要はない）。
    this.page.setDefaultNavigationTimeout(45000);
    // confirm/alert ダイアログは受け入れる（LICSは確認にJSダイアログを使うことがある）
    this.page.on("dialog", (d) => d.accept().catch(() => {}));
    if (proxyServer && !process.env.OML_NO_RELAY) {
      // Chromium とプロキシ終端の TLS 非互換対策:
      // リクエストを Playwright の Node 側 fetch（プロキシ・CA設定済み）で中継する
      // ※ OML_NO_RELAY=1 で無効化（中継は各リクエストをブラウザ外で再取得するため、
      //   サイトの WAF/ボット判定・JS チャレンジ・Cookie 継続を壊すことがある）
      // ★HTTP応答（408含む）は絶対にリトライしない。
      //   2026-09-07の障害でこの中継が408をリトライで押し切る実装になっており、それが
      //   図書館側F5の「送信元IP単位のレート/ソフトBAN」を恒久BANへ硬化させた（Fable検証で確認）。
      //   408は「お前は制限対象だ」というサイトの判定なので、連打は最悪手。サイトが返した応答は
      //   状態コードに関わらずそのままブラウザへ渡し、上位（index.js）が見送り/翌週リトライで受ける。
      //   再試行するのは「ネットワーク例外（接続リセット等・サーバの判定ではない）」だけ、控えめに1回。
      const netRetry = Number(process.env.OML_RELAY_NET_RETRY || 1);
      await this.page.route("**/*", async (route) => {
        const req = route.request();
        for (let attempt = 0; ; attempt++) {
          try {
            const resp = await route.fetch({ maxRedirects: 0 });
            if (process.env.OML_RELAY_DEBUG) {
              console.error(`[relay] ${req.method()} ${resp.status()} ${req.url()}`);
            }
            await route.fulfill({ response: resp }); // 408/5xxでもそのまま返す（リトライ禁止）
            return;
          } catch (e) {
            if (process.env.OML_RELAY_DEBUG) console.error(`[relay] ERR ${req.url()} : ${e.message}`);
            if (attempt < netRetry) {
              await new Promise((r) => setTimeout(r, 1500 + Math.floor(Math.random() * 1500)));
              continue;
            }
            await route.abort().catch(() => {});
            return;
          }
        }
      });
    }
  }

  /** F5 BIG-IP の永続化 Cookie(BIGipServer*) だけを削除し、他（JSESSIONID 等）は残す */
  async dropPersistenceCookie() {
    if (!this.context) return;
    const cookies = await this.context.cookies();
    const bigip = cookies.filter((c) => c.name.startsWith("BIGipServer"));
    if (bigip.length === 0) return;
    const keep = cookies.filter((c) => !c.name.startsWith("BIGipServer"));
    await this.context.clearCookies();
    if (keep.length) await this.context.addCookies(keep);
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
    // ログインは複数の画面遷移を連鎖する。どれか1つが 408（未認証時はノードを跨いでも
    // よいので中継が別ノードへ振り直す）で崩れることがあるため、フロー全体を数回リトライする。
    // 各リトライの前に永続化 Cookie を落として別ノードで最初からやり直す（＝人手の再読込相当）。
    const flowAttempts = 1; // ★ログインフローもリトライしない（失敗したら諦める。連打しない）
    let lastErr = null;
    for (let a = 1; a <= flowAttempts; a++) {
      try {
        await this._loginAttempt(card, pass);
        // 以後はノード固定（永続化Cookieを落とさない）。ノードローカルセッション維持のため。
        this.authenticated = true;
        return true;
      } catch (err) {
        lastErr = err;
        if (err.authFail) break; // 資格情報エラーはリトライしない
        if (a < flowAttempts) {
          await this.dropPersistenceCookie().catch(() => {});
          await this.page.waitForTimeout(1500);
        }
      }
    }
    await this.fail("login", lastErr);
  }

  /** ログイン1回ぶんの画面フロー（トップ→ログインリンク→フォーム→送信）。失敗時は throw。 */
  async _loginAttempt(card, pass) {
    // トップ表示→メニュー展開→ログインリンク発見 を数回リトライする。
    let loginLink = null;
    const linkAttempts = 1; // ★トップ再読込での粘りもしない（数ヶ月動いていた単発挙動へ戻す）
    for (let a = 1; a <= linkAttempts; a++) {
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
      loginLink = await this.firstVisible(
        ["a#usr-lgin", 'a:has-text("ログイン")'],
        "ログインリンク"
      ).catch(() => null);
      if (loginLink) break;
      if (a < linkAttempts) await this.page.waitForTimeout(1200);
    }
    if (!loginLink) {
      throw new Error("画面要素が見つかりません: ログインリンク（トップ再読込を繰り返しても不可）");
    }
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
      const e = new Error("ログイン失敗（カード番号またはパスワードが違う）");
      e.authFail = true;
      throw e;
    }
    await this.shot("login-ok");
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

  /**
   * 貸出中一覧のタイトル配列を取得（ログイン済み前提）。
   * 予約が「取消」表示になっていても実は受取済み（借用中）だと、取消復帰で二重予約されるため、
   * 借用中の本を判別するのに使う。予約一覧（listReservationStates）と同じUI構造で、
   * ヘッダの貸出バー #stat-lent から遷移する。取得失敗は空配列（保守的に「借用中なし」扱い）。
   */
  async listLoanTitles() {
    try {
      const bar = this.page.locator("#stat-lent");
      if (!(await bar.isVisible({ timeout: 2000 }).catch(() => false))) {
        await this.politeWait();
        await this.page.goto(`${this.baseUrl}/WOpacSmtMnuTopAction.do`, { waitUntil: "domcontentloaded" });
      }
      await this.politeWait();
      if (await bar.isVisible({ timeout: 2000 }).catch(() => false)) {
        await bar.click();
      } else {
        await this.page.evaluate(() => {
          // eslint-disable-next-line no-undef
          toUsrLend(1);
        });
      }
      await this.page.waitForLoadState("domcontentloaded").catch(() => {});
      await this.page.waitForTimeout(600);
      await this.shot("lent-list");
      const rows = this.page.locator("div.layer-item");
      const n = await rows.count();
      const out = [];
      for (let i = 0; i < n; i++) {
        const title = (await rows.nth(i).locator(".title").first().textContent().catch(() => ""))?.trim();
        if (title) out.push(title.replace(/\s+/g, " "));
      }
      return out;
    } catch {
      return [];
    }
  }

  // ---------- 検索 ----------

  /** 書名検索して結果一覧を返す: [{ index, title, author }] */
  /** 検索結果一覧の現在ページから行を読む。index は results 全体の通し番号にする */
  async #readResultRows(offset) {
    await this.page.waitForSelector("a.layer-doc", { timeout: 8000 }).catch(() => {});
    const rows = this.page.locator("a.layer-doc");
    const n = Math.min(await rows.count(), 20); // 表示件数20件に合わせる
    const out = [];
    for (let i = 0; i < n; i++) {
      const t = (await rows.nth(i).locator(".title").first().textContent().catch(() => ""))?.trim();
      const w = (await rows.nth(i).locator(".writer").first().textContent().catch(() => ""))?.trim();
      const p = (await rows.nth(i).locator(".publisher").first().textContent().catch(() => ""))?.trim();
      // getAttribute は相対パスを返し page.goto に渡せない。el.href は常に絶対URL。
      const href = (await rows.nth(i).evaluate((el) => el.href).catch(() => "")) || "";
      if (t) out.push({ index: offset + out.length, title: t, author: w, publisher: p, href });
    }
    return out;
  }

  /** 検索結果一覧の page ページ目へ送る。送れなければ false */
  async #gotoResultPage(page) {
    const ok = await this.page
      .evaluate((pg) => {
        const sels = Array.from(document.querySelectorAll("select"));
        const sel = sels.find((s) => /pagingPages/.test(s.getAttribute("onchange") || ""));
        if (!sel) return false;
        if (!Array.from(sel.options).some((o) => o.value === String(pg))) return false;
        const m = (sel.getAttribute("onchange") || "").match(/pagingPages\(\s*'([^']+)'/);
        if (!m) return false;
        // eslint-disable-next-line no-undef
        pagingPages(m[1], (pg - 1) * 20);
        return true;
      }, page)
      .catch(() => false);
    if (!ok) return false;
    await this.page.waitForLoadState("domcontentloaded").catch(() => {});
    await this.page.waitForTimeout(600);
    return true;
  }

  /** 検索結果一覧の絞込みフォームで「書名」を range 指定（0=含む / 1=で始まる）で再検索する */
  async #narrowByTitle(title, range) {
    await this.page.selectOption("#searchkind_add", "0"); // 書名
    await this.page.selectOption("#searchrange_add", range).catch(() => {});
    await this.page.locator("#search_add").fill(title);
    await this.politeWait();
    // 再検索ボタンは input の onchange で有効化されるため JS で直接実行
    await this.page.evaluate(() => {
      // eslint-disable-next-line no-undef
      submitNarrow();
    });
    await this.page.waitForLoadState("domcontentloaded").catch(() => {});
  }

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

      // 検索そのものが送信されず、トップページに留まることがある（実測 2026-09-14 chojo「にんじん」）。
      // これを「所蔵なし」と誤認すると台帳に failed として焼き付き、その本は二度と予約されない。
      // 結果一覧でも書誌詳細でもなければ null を返し、呼び出し側に「検索できなかった」と伝える。
      const pageTitle = await this.page.title().catch(() => "");
      if (!/検索結果/.test(pageTitle)) {
        await this.shot(`search-failed-${title.slice(0, 10)}`);
        return null;
      }

      if (await this.#noHits()) return [];

      // 全項目検索は雑誌などのノイズが多いので、絞込みフォームで「書名」再検索
      const narrowBox = this.page.locator("#search_add");
      if (await narrowBox.isVisible({ timeout: 3000 }).catch(() => false)) {
        // 書名を「この言葉で始まる」(searchrange_add=1) で絞る。
        // ★既定の「この言葉を含む」(=0) だと書名の途中一致まで拾い、雑誌が大量に混ざる。
        //   実測（2026-09-14 chonan）: 「ちょっとだけ」は書名AND絞込み後も151件で、
        //   1ページ目が AERA・壮快・an・an…と雑誌だけになり、目的の絵本が10件目より後ろへ落ちて
        //   「出版社の版が見つからない」として見送られていた（花いっぱいになあれ・ともだちやも同様）。
        //   前方一致なら雑誌はそもそも該当しない。続く rankResults の sameWork が
        //   「ともだちや」→「ともだちやま」のような別作品を最終的に弾く。
        await this.#narrowByTitle(title, "1");
        await this.shot(`narrow-${title.slice(0, 12)}`);
        // 前方一致で0件になる書誌（OPACの書名がシリーズ名から始まる等）は「含む」で取り直す。
        // 余分なリクエストはこのフォールバック時のみ発生する。
        if (await this.#noHits()) {
          await this.#narrowByTitle(title, "0");
          await this.shot(`narrow2-${title.slice(0, 12)}`);
          if (await this.#noHits()) return [];
        }
      }

      // 表示件数を20件に上げる（select の onchange="dispmaxnumChange(this)" が遷移する）。
      // ★10件のままだと目的の版が1ページ目に入らず取り逃す。実測（2026-09-14 chonan）:
      //   「花いっぱいになあれ」は書名前方一致で14件まで絞れていたのに、1ページ目が
      //   教材アンソロジー（2011〜2006年）で埋まり、目的の大日本図書版（古い本）が
      //   11件目以降に落ちて「出版社の版が見つからない」になっていた。
      const cntSel = this.page.locator("#AssistListSelect");
      if (await cntSel.isVisible({ timeout: 2000 }).catch(() => false)) {
        const cur = await cntSel.inputValue().catch(() => "");
        if (cur !== "20") {
          await this.politeWait();
          await Promise.all([
            this.page
              .waitForNavigation({ waitUntil: "domcontentloaded", timeout: 15000 })
              .catch(() => {}),
            this.page
              .evaluate(() => {
                const el = document.getElementById("AssistListSelect");
                el.value = "20";
                // eslint-disable-next-line no-undef
                dispmaxnumChange(el);
              })
              .catch(() => {}),
          ]);
        }
      }

      // 出版年降順に並べ替え（新しい版を優先＝古くて傷んだ本を避ける。ユーザー指定 2026-08）。
      // 版の取り違えは rankResults の出版社一致＋特殊資料除外ガードで防ぐ。
      const sortSel = this.page.locator("#AssistSortSelect");
      if (await sortSel.isVisible({ timeout: 3000 }).catch(() => false)) {
        const opts = await sortSel.locator("option").allTextContents();
        let idx = opts.findIndex((t) => /出版年/.test(t) && /逆順|降順/.test(t));
        if (idx < 0) idx = opts.findIndex((t) => /出版年順/.test(t) && !/逆順/.test(t)); // 降順が無ければ昇順
        if (idx >= 0) {
          const value = await sortSel.locator("option").nth(idx).getAttribute("value");
          await this.politeWait();
          // ★並べ替えは遷移を伴う（select の onchange="sort(this.value,'0')" が form を submit する）。
          //   以前は selectOption 後に waitForLoadState を呼ぶだけで、既にロード済みのページでは
          //   即座に解決してしまい**並べ替え前のページを読んでいた**（2026-09-14 実測: narrow と
          //   sorted の保存HTMLが完全に同一で、既定順のまま雑誌が先頭に居座っていた）。
          //   絞込みと同じく JS を直接実行し、遷移を待って受ける。
          await Promise.all([
            this.page
              .waitForNavigation({ waitUntil: "domcontentloaded", timeout: 15000 })
              .catch(() => {}),
            this.page.evaluate((v) => sort(v, "0"), value).catch(() => {}),
          ]);
          await this.shot(`sorted-${title.slice(0, 12)}`);
        }
      }

      // 結果行の描画を待つ（並べ替え直後は再読込中のことがある）
      await this.page.waitForSelector("a.layer-doc", { timeout: 8000 }).catch(() => {});
      await this.page.waitForLoadState("domcontentloaded").catch(() => {});
      // 結果行: a.layer-doc の .title がタイトル。href は書誌詳細への直接リンク（GET）
      // 1ページ目が雑誌だらけなら次ページも読む。
      // ★雑誌は出版年が空で、出版年降順では常に先頭に来る。実測（2026-09-14）:
      //   「ちょっとだけ」は書名前方一致で80件まで絞れていたのに、20件中16件が雑誌
      //   （LEON・ガルビィ・サンキュ!・PHP…）で、目的の福音館書店版（2007年）まで届かなかった。
      //   雑誌は書名索引に記事名まで入るため、書名検索でも除外できない。
      //   通常の検索（例「おおはくちょうのそら」4件）では追加のリクエストは発生しない。
      const results = [];
      const hasYear = (r) => /\d{4}\/\d{2}/.test(`${r.publisher ?? ""} ${r.author ?? ""}`);
      for (let page = 1; page <= 3; page++) {
        if (page > 1) {
          // ページ送りは select の onchange="pagingPages('<sortkey>', (this.value-1)*'20')"。
          // ソートキーはページ側の値をそのまま使う（ハードコードしない）。
          const moved = await this.#gotoResultPage(page);
          if (!moved) break;
          await this.shot(`page${page}-${title.slice(0, 10)}`);
        }
        const added = await this.#readResultRows(results.length);
        results.push(...added);
        if (added.length === 0) break;
        // 書籍らしい行（出版年あり）が十分取れたら打ち切る
        if (results.filter(hasYear).length >= 10) break;
      }
      // 検索が1件だけヒットするとOPACは結果一覧を出さず書誌詳細へ直行する（例: リトルバンパイア等、
      // 巻タイトルがユニークな多巻もの）。一覧行(layer-doc)が0でも、開いている書誌詳細が予約可能なら
      // それを単一ヒットとして返す（詳細で openResult を飛ばして直接カート投入させる）。
      if (results.length === 0) {
        const single = await this.#detailAsSingleResult(title);
        if (single) results.push(single);
      }
      return results;
    } catch (err) {
      await this.fail(`search:${title}`, err);
    }
  }

  /**
   * 検索が書誌詳細へ直行したときに、その詳細を単一ヒット {index:-1, onDetail:true, ...} として返す。
   * 版の正しさは呼び出し側 rankResults の expectedPublisher（詳細から抽出した出版社）で担保し、
   * 予約不可・特殊資料のみは addToCart 側でも弾かれる。title は検索語をそのまま採用する（OPACが
   * 既にこの語で1件に絞り込んでいるため。詳細の表示名はシリーズ名等が混ざり rankResults の
   * 部分一致を外すことがある）。判定できないときは null を返し、従来どおり「所蔵なし」で見送る（安全側）。
   */
  async #detailAsSingleResult(wantedTitle) {
    try {
      // 書誌詳細の指標: h2.title があり、かつ予約可能（inYoyCart のカートボタンがある）
      const hasTitle = await this.page
        .locator("h2.title")
        .first()
        .isVisible({ timeout: 2000 })
        .catch(() => false);
      if (!hasTitle) return null;
      const body = (await this.page.textContent("body")) || "";
      if (/この書誌は予約できません/.test(body)) return null;
      const hasCart = await this.page
        .locator('input[onclick*="inYoyCart"], input[value*="カートに入れる"], button:has-text("カートに入れる")')
        .first()
        .isVisible({ timeout: 2000 })
        .catch(() => false);
      if (!hasCart) return null;
      // 出版社は書誌詳細の出版事項（dl.form.writer dd 内の出版者リンク）から取る。
      // 取れなければ空にする（publisher 指定のある本は rankResults で除外され、安全側に倒れる）。
      let publisher = (await this.page
        .locator("dl.form.writer dd a")
        .first()
        .textContent()
        .catch(() => ""))?.trim() || "";
      if (!publisher) {
        const ddText = (await this.page.locator("dl.form.writer dd").first().textContent().catch(() => "")) || "";
        publisher = ddText.split(/[\s　]/).filter(Boolean)[0] || "";
      }
      return { index: -1, onDetail: true, title: wantedTitle, author: "", publisher, href: this.page.url() };
    } catch {
      return null;
    }
  }

  async #noHits() {
    const body = (await this.page.textContent("body")) || "";
    if (/該当\s*[0-9,]+\s*件/.test(body)) {
      return /該当\s*0\s*件/.test(body);
    }
    return /該当する資料(は|が)?(ありません|見つかりません)/.test(body);
  }

  /**
   * 検索結果の書誌詳細を、サイト自身の画面遷移（LBForm の POST）で開く。
   *
   * ★★2026-09-25 の全アカウント全滅の真因（ここを GET にしてはいけない）:
   *   結果行は
   *     <a class="layer-doc" href="...TifTilDetailAction.do?urlNotFlag=1&tilcod=XXX"
   *        onclick="javascript:toDetail('XXX');return false;">
   *   で、onclick が return false するため **href は人のクリックでは決して使われない**。
   *   実体は toDetail() ＝ LBForm を POST する内部遷移で、この POST が hidden の
   *   `hash`（画面遷移トークン）を運ぶ。サーバは POST で来た詳細ページにだけ新しい hash を
   *   発行し、href を直接 GET した場合（urlNotFlag=1＝「URLで外から入った」）は
   *   **hash が空のページ**を返す。セッション自体は生きている（ログアウトリンクも出る）ので
   *   カート投入までは通るが、最後の確定 POST（WOpacSmtYoyCartExecAction.do）だけが hash を
   *   検証するため、空だと遷移無効と見なされ**ログイン画面が返る**＝「セッション切れ」に見えた。
   *   2026-09-14 の openResult 変更（index ずれ対策の page.goto(href)）がこの回帰を入れた。
   *
   * ページ送りで index と画面上の行がずれる問題は、位置ではなく **tilcod で行を特定** して解決する。
   */
  async openResult(index, href = null) {
    await this.politeWait();
    const tilcod = tilcodFromHref(href);
    const moved = tilcod ? await this.#openDetailByTilcod(tilcod) : false;
    // POST遷移が使えなかったときだけ、従来どおり画面上の行を位置でクリックする。
    // ★遷移を試みて詳細に着けなかった場合に位置クリックすると、見当違いのページで
    //   無関係な行を開きかねない。結果一覧に留まっているときだけフォールバックする。
    if (!moved) {
      const onList = (await this.page.locator("a.layer-doc").count().catch(() => 0)) > 0;
      if (onList) {
        await this.page.locator("a.layer-doc").nth(index).click();
        await this.page.waitForLoadState("domcontentloaded").catch(() => {});
      }
    }
    await this.shot("bib-detail");
  }

  /**
   * tilcod の書誌詳細へ、サイトの内部遷移（toDetail＝LBForm の POST）で移動する。
   * 表示中の結果ページに該当行があればその行をクリックし（人の操作と完全に同じ）、
   * 無ければ（ページ送り後など）同じことを行う toDetail() を直接呼ぶ。
   * どちらも LBForm を submit するので hash が引き継がれる。
   * 返り値: 遷移できたか。
   */
  async #openDetailByTilcod(tilcod) {
    // toDetail() も各リンクの onclick も「if (submitFlg)」で守られており、同じページで一度
    // submit 済みだと submitFlg=false のまま空振りする（過去の #openCart 空振りと同じ罠）。
    const ready = await this.page
      .evaluate(() => {
        if (typeof window.toDetail !== "function" || !document.LBForm) return false;
        window.submitFlg = true;
        return true;
      })
      .catch(() => false);
    if (!ready) return false;
    const row = this.page.locator(`a.layer-doc[href*="tilcod=${tilcod}"]`).first();
    const onThisPage = (await row.count().catch(() => 0)) > 0;
    await Promise.all([
      this.page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 20000 }).catch(() => {}),
      onThisPage
        ? row.click().catch(() => {})
        : this.page
            .evaluate((t) => {
              window.toDetail(t);
            }, tilcod)
            .catch(() => {
              /* submit によるナビゲーションで context が破棄されることがある（上の待機で受ける） */
            }),
    ]);
    return await this.#onDetailPage();
  }

  /** 今いるページが書誌詳細かを <title> で判定する */
  async #onDetailPage() {
    const title = await this.page.title().catch(() => "");
    return /書誌詳細/.test(title);
  }

  /**
   * 現在ページの LBForm が持つ画面遷移トークン hash を返す（無ければ ""）。
   * 空のまま予約確定 POST を出すとサーバがログイン画面を返す（2026-09-25 の真因）ので、
   * 確定直前の検査に使う。
   */
  async #formHash() {
    return await this.page
      .evaluate(() => {
        const f = document.LBForm;
        if (!f) return "";
        const h = f.hash;
        if (!h) return "";
        return (h.length ? h[0].value : h.value) || "";
      })
      .catch(() => "");
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
  async addToCart(permalink = null) {
    try {
      // この時点ではまだ書誌詳細ページに居る（クリックでカートへ遷移する前）。詳細URLを控えておくと、
      // 後でカートから離れてしまったとき（バッチ最後の本が版スキップ等）に、この詳細を開き直して
      // カートを再確立できる（#openCart 参照。新しく開いた詳細は submitFlg=true でカートリンクが効く）。
      // ★2026-08-17: page.url() は toDetail() の POST 遷移後で tilcod を持たず goto で再現できない
      // （＝旧 #openCart 再確立が空振りしていた真因）。検索結果行 a.layer-doc の href から
      // tilcod（書誌ID）を控えておき、再確立は **GET ではなく** サイト内部の POST 遷移で行う。
      // ★2026-09-25: href を goto すると hash 空のページになり、確定 POST がログイン画面に落ちる。
      // よって URL ではなく tilcod を持ち回るのが正。URL は最後の手段としてのみ残す。
      const tilcod = tilcodFromHref(permalink);
      let detailUrl = this.page.url();
      if (permalink && tilcod) {
        try {
          detailUrl = new URL(permalink, this.page.url()).href;
        } catch {
          /* 相対URL解決に失敗したら page.url() のまま（従来動作） */
        }
      }
      const body = (await this.page.textContent("body")) || "";
      if (/この書誌は予約できません/.test(body)) {
        return { ok: false, notReservable: true, message: "予約不可の版（大型絵本・禁帯出等）" };
      }
      // 点字・デイジー・大型絵本など特殊資料のみの書誌は予約しない（次の候補へ）。
      // 例: 「こいぬがうまれるよ」は同じ福音館書店で点字付の書誌が別レコードで存在する
      const special = specialFormatOnly(body);
      if (special) {
        return { ok: false, notReservable: true, message: `特殊資料のみの版（${special}）` };
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
      // カート投入に成功した本の書誌を控える（確定フェーズでカート再確立に使う）
      if (tilcod) this.lastCartDetailTilcod = tilcod;
      if (detailUrl && /Detail|detail/.test(detailUrl)) this.lastCartDetailUrl = detailUrl;
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

  /**
   * 今表示している予約状況一覧ページから、有効な（取消・期限切れでない）予約のタイトルを摘出する。
   * ページ遷移は一切行わない（今あるDOMを読むだけ）。行が無ければ空配列。
   */
  async #titlesOnCurrentList() {
    try {
      const cancelled = /取消|期限切れ|無効/;
      const rows = this.page.locator("div.layer-item");
      const n = await rows.count();
      const out = [];
      for (let i = 0; i < n; i++) {
        const title = (await rows.nth(i).locator(".title").first().textContent().catch(() => ""))?.trim();
        if (!title) continue;
        const text = (await rows.nth(i).textContent().catch(() => "")) || "";
        const state = text.match(/予約状態\s*[:：]?\s*(\S+)/)?.[1]?.trim() ?? "";
        if (state && cancelled.test(state)) continue;
        out.push(title.replace(/\s+/g, " "));
      }
      return out;
    } catch {
      return [];
    }
  }

  /**
   * 今いるページが「予約カート」画面かを判定する。
   *
   * ★重要（2026-09-12 chojo 全滅の真因）: 「カート（予約候補） N」という表記は
   *   **全ページ共通のヘッダ**に出る。書誌詳細でも貸出状況一覧でも必ず現れるため、
   *   本文テキスト（textContent("body")）でのカート判定は**どこに居ても必ず真**になり、
   *   #openCart が一度も遷移しないまま戻っていた（受取館セレクトは本物のカート画面にしか
   *   無いので、後段が「受取館セレクトが見つかりません」で全滅した）。
   *   → カート画面だけが持つもの＝<title>予約カート／受取館セレクト（receivename）で判定する。
   */
  async #isCartPage() {
    const title = await this.page.title().catch(() => "");
    if (isCartPageTitle(title)) return true;
    // タイトル取得に失敗した場合の保険（カート画面にしか無いセレクト）
    return (
      (await this.page
        .locator('select[name="receivename"], #receiveWay')
        .count()
        .catch(() => 0)) > 0
    );
  }

  /**
   * カート（予約候補）画面へ遷移する。
   * 返り値: カート画面に到達できたか（true/false）。
   */
  async #openCart() {
    // 既にカート画面なら何もしない（ここで遷移するとカートから離れてしまう）。
    if (await this.#isCartPage()) {
      await this.shot("cart");
      return true;
    }
    // カート画面に居ない。ヘッダのカートリンク（onclick=yoycart）は、そのページの submitFlg が
    // true のときだけ遷移する。バッチ最後の本が版スキップ等でフォーム submit 済みだと
    // submitFlg=false になり、リンクが空振りして検索結果一覧に取り残される（jinan 2026-08-10 の全滅）。
    // → 直近にカート投入した本の書誌詳細を開き直す（新規ロードで submitFlg=true）と、その詳細の
    //    カートリンクは正常に効く。カートはサーバ側セッション状態なので、そこから開けば投入済みの
    //    本がすべて表示される。詳細URLが無い（emptyCart 初回等）ときは現ページから素直にクリックする。
    // ★2026-09-25: ここで href を goto してはいけない。GET で入り直した詳細は hash が空で、
    //   そこから開いたカートも hash 空になり、確定 POST がログイン画面に落ちる（全滅の真因）。
    //   取り残されるのは検索結果一覧（toDetail と有効な hash を持つ）なので、内部の POST 遷移で戻る。
    let reopened = false;
    if (this.lastCartDetailTilcod) {
      await this.politeWait();
      reopened = await this.#openDetailByTilcod(this.lastCartDetailTilcod);
    }
    if (!reopened && this.lastCartDetailUrl) {
      // 最後の手段（単一ヒット直行の本は tilcod を持てない）。GET で入り直すと hash が空になり
      // 確定は通らないが、カート内容の確認まではできる。確定前に #formHash が検出して明示的に止める。
      await this.politeWait();
      await this.page
        .goto(this.lastCartDetailUrl, { waitUntil: "domcontentloaded" })
        .catch(() => {});
    }
    const cartLink = this.page.locator('#stat-cart, #usr-cart, a[onclick*="yoycart"]').first();
    await this.politeWait();
    await Promise.all([
      this.page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 15000 }).catch(() => {}),
      cartLink.click().catch(() => {}),
    ]);
    await this.shot("cart");
    // 到達できたかを呼び出し側に返す（408対策でリトライはしない。失敗はそのまま報告する）
    return await this.#isCartPage();
  }

  /** カート内の予約候補を一括削除して空にする（残留候補の混入を防ぐ・best-effort） */
  async emptyCart() {
    try {
      if (!(await this.#openCart())) return; // カートに到達できなければ何もしない（best-effort）
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
      // カート画面へ到達できなければ確定に進まない。ここで進むと「受取館セレクトが見つかりません」
      // という原因を取り違えたメッセージで全滅する（2026-09-12 chojo）。408対策でリトライはせず、
      // 到達できなかった事実をそのまま報告して1回で止める。
      if (!(await this.#openCart())) {
        this.#assertNotLoginPage(await this.page.textContent("body"));
        await this.shot("cart-open-failed");
        return {
          ok: false,
          message: "予約カート画面へ遷移できませんでした（確定を中止・スクショ参照）",
          countBefore,
          countAfter: countBefore,
          delta: 0,
        };
      }

      const cartBody = (await this.page.textContent("body")) || "";
      this.#assertNotLoginPage(cartBody);
      if (/カートに\s*0\s*件/.test(cartBody)) {
        return { ok: false, message: "カートが0件（予約対象なし）", countBefore, countAfter: countBefore, delta: 0 };
      }

      // (1) 連絡方法（メール等）を最初に確定する。
      // 連絡方法セレクト（name="contact" id="receiveWay"）の onchange="selectyoyrak(this.value)" は
      // 「contactweb=値; action=WOpacSmtYoyPopupRecWebAction.do?webrak=1; フォームsubmit」を行い、
      // カートを再描画して戻る。この遷移でサーバ側に contactweb（メール=4）が登録される。値を直接
      // セットするだけではサーバに登録されず既定の電話に戻るため、必ず change 経由で遷移させる。
      // ※アカウントにメールアドレスが登録済みであることが前提（未登録だと既定の電話に戻る）。
      // 遷移は待って受ける（awaitしないと後続の evaluate が「context破棄」で落ちる＝過去の不具合）。
      if (contactMethod) {
        const cSel = this.page.locator('#receiveWay, select[name="contact"]').first();
        if ((await cSel.count()) > 0) {
          const cur = await cSel
            .evaluate((s) => (s.options[s.selectedIndex]?.textContent || "").trim())
            .catch(() => "");
          if (!cur.includes(contactMethod)) {
            await this.politeWait();
            await Promise.all([
              this.page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 15000 }).catch(() => {}),
              cSel.selectOption({ label: contactMethod }).catch(() => {}),
            ]);
            await this.page.waitForTimeout(800);
            // 遷移後、確実にカート画面へ戻す（戻れなければ後段の受取館解決が空振りするので中止）
            if (!(await this.#openCart())) {
              this.#assertNotLoginPage(await this.page.textContent("body"));
              await this.shot("cart-open-failed");
              return {
                ok: false,
                message: "連絡方法の設定後にカート画面へ戻れませんでした（確定を中止）",
                countBefore,
                countAfter: countBefore,
                delta: 0,
              };
            }
          }
        } else {
          await this.shot("contact-select-missing");
        }
        await this.shot("contact-set");
      }

      // (2) 受取館の option value を解決する。受取館セレクト（name="receivename"）の
      // onchange="selectloccod" も遷移を伴うため、ここでは selectOption しない（過去、これを
      // await せず後続の evaluate が「context破棄」で落ちていた）。value は最終 submit で直接セットする。
      const branchVal = await this.page.evaluate((branchName) => {
        for (const s of document.querySelectorAll("select")) {
          for (const o of s.options) {
            if ((o.textContent || "").trim().includes(branchName)) return o.value;
          }
        }
        return null;
      }, pickupBranch);
      if (!branchVal) {
        // 受取館セレクトが無い＝ログイン画面へ戻された可能性を先に確認
        this.#assertNotLoginPage(await this.page.textContent("body"));
        await this.shot("branch-not-found");
        return { ok: false, message: `受取館セレクトが見つかりません（${pickupBranch}）`, countBefore, countAfter: countBefore, delta: 0 };
      }

      // (3) 予約対象の選択と受取館を、サイトの機構どおりに hidden フィールドへ直接セットする。
      // サイト仕様（実HTML解析で判明）:
      //   - 予約対象はチェックボックス（name="list_chkbox"）の checked ではなく、hidden の
      //     list_chk_paging（カンマ区切りの資料ID）＋ schkflg='check' でサーバへ伝わる。
      //     以前は list_chkbox に checked=true と change イベントを送っていたが、実際の選択更新は
      //     onclick="list_chkClick" が list_chk_paging を書き換える仕組みで、change では発火せず、
      //     結果として schkflg が未設定のまま送られ「予約中 N→N で増加なし」になっていた（今回の不具合）。
      //   - 受取館は select(receivename) と hidden returnValue に value をセットする（returnValue が正）。
      // ここでは selectAll() 相当を JS で行い、submitFlg ガードのある exec() を介さず直接 submit する。
      const expected = await this.page.evaluate((bv) => {
        const f = document.LBForm;
        const boxes = Array.from(document.querySelectorAll('input[name="list_chkbox"][type="checkbox"]'));
        const ids = boxes.map((b) => {
          b.checked = true;
          return b.value;
        });
        if (f.list_chk_paging) f.list_chk_paging.value = ids.join(",");
        if (f.schkflg) f.schkflg.value = "check";
        if (f.allschkflg) f.allschkflg.value = "check";
        const all = document.getElementById("all_chk");
        if (all) all.checked = true;
        if (f.receivename) f.receivename.value = bv;
        if (f.returnValue) f.returnValue.value = bv;
        return ids.length;
      }, branchVal);
      this.reservedItemCount = Math.max(expected ?? 0, 1); // 期待成立冊数（後段の照合に使う）
      await this.shot("reserve-branch-set");

      // (3.5) 確定 POST の前に画面遷移トークン hash を検査する。
      // hash が空のカートから確定すると、サーバは遷移無効と見なしてログイン画面を返し、
      // 「セッション切れ」という誤解を招くエラーになる（2026-09-25 に4アカウント全滅）。
      // 空になる原因は「書誌詳細を GET の恒久リンクで開いた」こと＝こちら側の経路ミスなので、
      // セッション切れと区別できるメッセージで返し、原因が即わかるようにする。
      const cartHash = await this.#formHash();
      if (!cartHash) {
        await this.shot("cart-hash-missing");
        return {
          ok: false,
          message:
            "カート画面の遷移トークン(hash)が空のため確定を中止（書誌詳細をGETの恒久リンクで開くとこうなる。" +
            "詳細へは toDetail() のPOST遷移で入ること。2026-09-25の回帰を参照）",
          countBefore,
          countAfter: countBefore,
          delta: 0,
        };
      }

      // (4) 予約確定。「予約する」ボタンの onclick=exec() は「if(submitFlg){...}」で守られており、
      // 連絡方法の選択（selectyoyrak）でカートが再描画されると submitFlg=false のため空振りする。
      // そこでボタンに頼らず、exec() の実体（action=WOpacSmtYoyCartExecAction.do → submit）を
      // 直接実行し、その遷移を待って結果ページを受ける。
      await this.politeWait();
      await Promise.all([
        this.page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 20000 }).catch(() => {}),
        this.page
          .evaluate(() => {
            document.LBForm.action = "WOpacSmtYoyCartExecAction.do";
            document.LBForm.submit();
          })
          .catch(() => {
            /* submit によるナビゲーションで context 破棄されることがある。上の待機で受ける */
          }),
      ]);
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
          await Promise.all([
            this.page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 15000 }).catch(() => {}),
            finalBtn.click({ timeout: 8000 }).catch(() => {}),
          ]);
          await this.page.waitForTimeout(1000);
          await this.shot("reserve-done");
          done = (await this.page.textContent("body")) || "";
        }
      }

      if (/ログイン認証/.test(done)) {
        throw new Error("セッション切れ（予約確定前にログイン画面が表示された）");
      }

      // 成立判定（最重要・過去に誤判定でトラブル多発）:
      // exec 直後の返却ページは「予約カート」の再描画で、ヘッダの「予約中 N 件」は stale な値を返す
      // （実測: 実際は成立しているのに古い件数のまま）。また予約状況一覧へ遷移すると（トップ経由で）
      // ログアウトし空になる。したがって exec 直後のページでは成立を確実に判定できない。
      // → ここでは submit の実行と結果ページの文言だけを返し、成立の確定は呼び出し側が
      //   「新規ログインでの予約一覧照合」で冊単位に行う（scripts/verify-reservations.mjs と同じ確実な方法）。
      // exec 後にサイトが「予約状況一覧」へ直行することがある（実測: chonan 2026-09-12）。
      // その一覧は**そのセッションで実際に成立した予約そのもの**なので、文言（受付/完了）より強い証拠になる。
      // 新規ログインでの照合が空振りした場合（同日 chonan は一覧が本文ごと空のページで返ってきた）に
      // 使えるよう、この場でタイトルを摘出して呼び出し側へ渡す。追加のリクエストは一切発生しない。
      const onReserveList = /予約状況一覧/.test(await this.page.title().catch(() => ""));
      let resultTitles = [];
      if (onReserveList) {
        resultTitles = await this.#titlesOnCurrentList();
      }
      const textOk = /受付|完了|予約しました|予約を受け付け/.test(done) || resultTitles.length > 0;
      const hasError = /予約の?上限|これ以上予約|予約できません|受け付けられません/.test(done);
      await this.shot("reserve-verify");
      const resultPageOk = textOk && !hasError;
      const message = hasError
        ? `結果ページにエラー文言: ${done.match(/.{0,40}(上限|予約できません|受け付けられません).{0,20}/)?.[0]?.trim() ?? "上限等"}`
        : "予約申し込みを送信（成立は新規ログインの予約一覧照合で確定）";
      return {
        ok: resultPageOk,
        message,
        resultPageOk,
        hasError,
        resultTitles,
        expected: this.reservedItemCount,
      };
    } catch (err) {
      await this.fail(`reserveCart`, err);
    }
  }

  async logout() {
    this.authenticated = false;
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
 * ページタイトルが「予約カート」画面のものかを判定する（OpacClient#isCartPage の判定本体）。
 * 本文テキストで判定してはいけない: 「カート（予約候補） N」は全ページ共通ヘッダの表記で、
 * 書誌詳細・貸出状況一覧など**どのページでも一致する**（2026-09-12 chojo 全滅の真因）。
 */
export function isCartPageTitle(title) {
  return /予約カート/.test(String(title ?? ""));
}

/**
 * 検索結果行の href（...TifTilDetailAction.do?urlNotFlag=1&tilcod=1000012617679）から
 * tilcod（書誌ID）を取り出す。取れなければ null。
 *
 * この href は「外から URL で入る」ための恒久リンクであり、**GET で開いてはいけない**
 * （サーバが hash 空のページを返し、予約確定 POST がログイン画面に落ちる＝2026-09-25 の真因）。
 * tilcod だけを取り出して、サイト内部の POST 遷移 toDetail(tilcod) に渡すために使う。
 */
export function tilcodFromHref(href) {
  const m = String(href ?? "").match(/[?&]tilcod=([0-9A-Za-z]+)/);
  return m ? m[1] : null;
}

/**
 * 検索結果を予約候補順に並べる。
 * 完全一致 > 前方一致 > 部分一致。特殊版らしきもの（大型絵本・紙芝居等）は後回し。
 */
/**
 * 書誌詳細ページの本文から資料種別を調べ、所蔵が特殊資料（点字・デイジー・大型絵本・
 * 紙芝居・大活字・AV資料等）**のみ**の場合はその種別名を返す（通常の図書があれば null）。
 */
export function specialFormatOnly(bodyText) {
  const kinds = [...String(bodyText ?? "").matchAll(/資料種別\s*[:：]?\s*([^\s、]+)/g)].map((m) => m[1]);
  if (!kinds.length) return null;
  const special = /点字|デイジー|大型|紙芝居|大活字|カセット|マルチメディア|DVD|VHS|CD|布の絵本|電子/;
  if (kinds.every((k) => special.test(k))) return [...new Set(kinds)].join("・");
  return null;
}

/**
 * 求める書名と、サイト上のタイトル（検索結果・予約一覧）が「同じ作品」かを判定する。
 *
 * サイトのタイトルは副題・叢書名・版表示が後ろに付くことがあるので前方一致を許すが、
 * **続きが区切りで始まること**を必須にする。素の部分一致だと別の本を掴む:
 *   「ともだちや」→「ともだちやま」（加藤休ミ／ビリケン出版）を予約した（2026-09-12 chonan・実害）
 *   「11ぴきのねこ」→「11ぴきのねこふくろのなか」も別の本
 * 一方これは同じ作品として通したい:
 *   「11ぴきのねこ ふくろのなか」「おおはくちょうのそら 北の森の動物たちシリーズ」
 *   「ひとまねこざるときいろいぼうし 改版」「ちいさなたまねぎさん（こどものくに傑作絵本 19）」
 */
export function sameWork(siteTitle, wantedTitle) {
  const norm = (s) =>
    String(s ?? "")
      .normalize("NFKC")
      .replace(/[\s\u3000]+/g, " ")
      .trim()
      .toLowerCase();
  const a = norm(siteTitle);
  const b = norm(wantedTitle);
  if (!a || !b) return false;
  if (a === b) return true;
  // 分かち書きの有無だけの違いは同じ作品とみなす。
  // 実害（2026-09-26 chonan）: こちらの表記「11ぴきのねこふくろのなか」に対しサイトは
  // 「11ぴきのねこ ふくろのなか」。実際は予約が成立して[待ち]なのに成立照合がここで落ち、
  // 台帳に載らず「予約確定できず見送り」と誤報告された（翌週の二重予約につながる）。
  // ※空白を詰めても「ともだちや」と「ともだちやま」は一致しないので、別作品の取り違え防止は保たれる。
  const squeeze = (s) => {
    let out = "";
    const map = []; // squeeze 後の各文字が元の何文字目だったか
    for (let i = 0; i < s.length; i++) {
      if (/\s/.test(s[i])) continue;
      out += s[i];
      map.push(i);
    }
    return { out, map };
  };
  const sa = squeeze(a);
  const sb = squeeze(b);
  if (sa.out === sb.out) return true;
  // 区切り＝空白・各種括弧・コロン等。ここで切れていれば副題／叢書名／版表示とみなす。
  // 一致判定は空白を無視して行い（表記ゆれ対策）、区切りの有無は元の文字列で確かめる。
  const sep = /[ \u3000([{<:：,、。・\-–—~〜「『【〔]/;
  const extendsWith = (long, sl, ss) => {
    if (!ss.out.length || !sl.out.startsWith(ss.out)) return false;
    const nextIdx = sl.map[ss.out.length]; // 続きの最初の「空白でない文字」の元位置
    if (nextIdx === undefined) return false; // 続きが無い＝完全一致（上で処理済み）
    // 接頭辞と続きの間に空白が挟まっていれば副題／叢書名とみなす
    const gap = long.slice(sl.map[ss.out.length - 1] + 1, nextIdx);
    return /\s/.test(gap) || sep.test(long[nextIdx]);
  };
  return extendsWith(a, sa, sb) || extendsWith(b, sb, sa);
}

/** 出版社名の表記ゆれを吸収して比較する（NFKC正規化・空白除去・部分一致） */
export function publisherMatches(rowPublisher, expected) {
  const norm = (s) => String(s ?? "").normalize("NFKC").replace(/[\s　・]/g, "").toLowerCase();
  const a = norm(rowPublisher);
  const b = norm(expected);
  if (!a || !b) return false;
  return a === b || a.includes(b) || b.includes(a);
}

export function rankResults(results, wantedTitle, limit = 3, preferBunko = false, expectedPublisher = null) {
  const norm = (s) => String(s).replace(/[\s　]/g, "").toLowerCase();
  const w = norm(wantedTitle);
  const special = /大型|紙芝居|点字|デイジー|カセット|大活字|DVD|CD/;
  const isBunko = (r) => /文庫/.test(`${r.title} ${r.writer ?? ""} ${r.publisher ?? ""}`);
  // 上下巻の並び順（ユーザー指定 2026-08: 上下に分かれている時は上から予約する）。
  // 同じ作品名で複数巻がヒットしたら 上/単巻 → 中 → 下 の順に並べ、上巻を先に予約させる。
  const volOrder = (t) => {
    const s = String(t);
    if (/(?:[\s　（(]|^)(?:下|下巻)(?:[\s　）)]|$)|（下）|\(下\)/.test(s)) return 2;
    if (/(?:[\s　（(]|^)(?:中|中巻)(?:[\s　）)]|$)|（中）|\(中\)/.test(s)) return 1;
    return 0; // 上・上巻・単巻はいずれも先頭
  };
  const scored = [];
  for (const r of results) {
    const t = norm(r.title);
    let score = -1;
    if (t === w) score = 100;
    else if (t.startsWith(w)) score = 60;
    else if (t.includes(w) || w.includes(t)) score = 40;
    if (score < 0) continue;
    // 前方一致・部分一致は「区切りで続く」ものだけを同じ作品として採る。
    // norm() は空白を落とすので境界が消える＝「ともだちや」が「ともだちやま」に化ける
    // （2026-09-12 chonan で実際に別の本を予約した）。生のタイトルで境界を見直す。
    if (score < 100 && !sameWork(r.title, wantedTitle)) continue;
    if (special.test(r.title)) score -= 30;
    // 文庫版があれば優先（読みやすく新しい傾向。ユーザー指定でmom・chojoに適用）。
    // 文庫は同じ作品なので出版社が違っても取り違えの心配がない。
    if (preferBunko && isBunko(r)) score += 50;
    scored.push({ ...r, score });
  }
  // 出版社指定あり（公文リスト＝正）: 一致する候補に絞る。
  // ただし preferBunko 時は同題の文庫（＝同じ作品）も許可し、出版社指定より優先させる。
  // 一致ゼロなら空を返す（別の版を勝手に予約しない。呼び出し側が理由つきで見送る）
  if (expectedPublisher) {
    const matched = scored.filter(
      (r) => publisherMatches(r.publisher, expectedPublisher) || (preferBunko && isBunko(r))
    );
    matched.sort((a, b) => b.score - a.score || volOrder(a.title) - volOrder(b.title) || a.index - b.index);
    return matched.slice(0, limit);
  }
  scored.sort((a, b) => b.score - a.score || volOrder(a.title) - volOrder(b.title) || a.index - b.index);
  return scored.slice(0, limit);
}
