import test from "node:test";
import assert from "node:assert/strict";
import { isCartPageTitle } from "../src/opac.js";

// 全ページ共通ヘッダの実物（logs/2026-09-12 の保存HTMLから抽出した並び）。
// カート件数バッジはどのページにも出るため、本文テキストでのカート判定は必ず誤爆する。
const COMMON_HEADER_TEXT = "マイ本棚 0 件 貸出中 7 件 予約中 5 件 カート\n （予約候補） 0 検索メニューです。";

test("旧実装の本文テキスト判定は共通ヘッダに誤爆する（回帰の記録）", () => {
  const oldGuard = /カート\s*（?予約候補/;
  // 書誌詳細でも貸出状況一覧でも、本文にはこのヘッダが必ず含まれる＝常に真になっていた
  assert.ok(oldGuard.test(COMMON_HEADER_TEXT));
});

test("タイトル判定はカート画面だけを真にする", () => {
  assert.ok(isCartPageTitle("予約カート：蔵書検索システム"));
  assert.ok(!isCartPageTitle("検索結果書誌詳細：蔵書検索システム"));
  assert.ok(!isCartPageTitle("貸出状況一覧：蔵書検索システム"));
  assert.ok(!isCartPageTitle("予約状況一覧：蔵書検索システム"));
  assert.ok(!isCartPageTitle("トップページ：蔵書検索システム"));
  assert.ok(!isCartPageTitle(""));
  assert.ok(!isCartPageTitle(null));
});

import { tilcodFromHref } from "../src/opac.js";

// 2026-09-25: 4アカウント全滅の回帰の記録。結果行の href は
//   <a class="layer-doc" href="...?urlNotFlag=1&tilcod=XXX" onclick="toDetail('XXX');return false;">
// で onclick が return false するため、**人のクリックでは href は使われない**。
// href は「外からURLで入る」用の恒久リンクで、GET で開くとサーバは hash（画面遷移トークン）が
// 空のページを返す。カート投入までは通るが確定 POST だけが hash を検証するため、
// ログイン画面が返り「セッション切れ」に見えていた。
// → href は goto するためではなく、tilcod を取り出して内部の POST 遷移 toDetail() に渡すために使う。
const ROW_HREF =
  "https://www.oml.city.osaka.lg.jp/licsxp-opac/WOpacSmtTifTilListToTifTilDetailAction.do?urlNotFlag=1&tilcod=1000012617679";

test("tilcodFromHref: 結果行の恒久リンクから書誌IDを取り出す", () => {
  assert.equal(tilcodFromHref(ROW_HREF), "1000012617679");
  // getAttribute で取った相対URLでも取れる
  assert.equal(
    tilcodFromHref("WOpacSmtTifTilListToTifTilDetailAction.do?urlNotFlag=1&tilcod=1000010584886"),
    "1000010584886",
  );
});

test("tilcodFromHref: tilcod の無いURL・空入力は null（POST遷移に切り替えられないケース）", () => {
  // toDetail() の POST 後の URL は tilcod を持たない（単一ヒット直行時にここへ来る）
  assert.equal(tilcodFromHref("https://www.oml.city.osaka.lg.jp/licsxp-opac/WOpacSmtTifTilDetailAction.do"), null);
  assert.equal(tilcodFromHref(""), null);
  assert.equal(tilcodFromHref(null), null);
  assert.equal(tilcodFromHref(undefined), null);
});

import { sameWork, rankResults } from "../src/opac.js";

test("sameWork: 副題・叢書名・版表示が付いたサイト側タイトルは同じ作品として通す", () => {
  assert.ok(sameWork("ともだちや", "ともだちや"));
  assert.ok(sameWork("11ぴきのねこ ふくろのなか", "11ぴきのねこ ふくろのなか"));
  assert.ok(sameWork("おおはくちょうのそら 北の森の動物たちシリーズ", "おおはくちょうのそら"));
  assert.ok(sameWork("ひとまねこざるときいろいぼうし 改版", "ひとまねこざるときいろいぼうし"));
  assert.ok(sameWork("ちいさなたまねぎさん（こどものくに傑作絵本 19）", "ちいさなたまねぎさん"));
  // サイト側が副題を落として短いこともある（逆向きも同じ作品）
  assert.ok(sameWork("ひとまねこざるときいろいぼうし", "ひとまねこざるときいろいぼうし 大型絵本"));
});

test("sameWork: 区切り無しで続くタイトルは別の本として弾く", () => {
  // 2026-09-12 chonan: 「ともだちや」を探して別の本「ともだちやま」を予約してしまった
  assert.ok(!sameWork("ともだちやま", "ともだちや"));
  assert.ok(!sameWork("11ぴきのねこふくろのなか", "11ぴきのねこ"));
  assert.ok(!sameWork("", "ともだちや"));
  assert.ok(!sameWork("ともだちや", ""));
});

test("rankResults: 区切り無しで伸びた別タイトルを候補にしない", () => {
  const results = [
    { index: 0, title: "ともだちやま", writer: "加藤 休ミ／作", publisher: "ビリケン出版" },
    { index: 1, title: "ともだちや", writer: "内田 麟太郎／作", publisher: "偕成社" },
  ];
  const picked = rankResults(results, "ともだちや", 3);
  assert.deepEqual(picked.map((r) => r.title), ["ともだちや"]);
});

test("rankResults: 副題付きの版は引き続き候補に残る", () => {
  const results = [
    { index: 0, title: "ひとまねこざるときいろいぼうし 改版", writer: "H.A.レイ", publisher: "岩波書店" },
  ];
  const picked = rankResults(results, "ひとまねこざるときいろいぼうし", 3, false, "岩波書店");
  assert.equal(picked.length, 1);
});

// 2026-09-26 chonan の実害: 「11ぴきのねこふくろのなか」を予約し実際に成立（一覧で[待ち]）
// したのに、サイト表記が「11ぴきのねこ ふくろのなか」で成立照合が落ち、台帳に載らず
// 「予約確定できず見送り」と誤報告された（翌週そのまま二重予約になる）。
test("sameWork: 分かち書きの有無だけの違いは同じ作品として通す", () => {
  assert.ok(sameWork("11ぴきのねこ ふくろのなか", "11ぴきのねこふくろのなか"));
  assert.ok(sameWork("11ぴきのねこふくろのなか", "11ぴきのねこ ふくろのなか"));
  // 叢書名が続く場合も同じ
  assert.ok(sameWork("11ぴきのねこ ふくろのなか　こぐま社の絵本", "11ぴきのねこふくろのなか"));
});

test("sameWork: 空白を詰めても別作品の取り違えは防ぐ（ともだちや/ともだちやま）", () => {
  assert.ok(!sameWork("ともだちやま", "ともだちや"));
  assert.ok(!sameWork("ともだち やま", "ともだちや"));
  assert.ok(!sameWork("11ぴきのねこふくろのなか", "11ぴきのねこ"));
});

import { specialFormatOnly, isTooManyHitsPage, firstAuthorWord } from "../src/opac.js";

// 2026-11-02 jinan の実害: 「ぐりとぐら てんじつきさわるえほん」は書誌種別=点字付だが、所蔵29冊のうち
// 1冊だけ資料種別が「図書」で、「全所蔵が特殊」判定をすり抜けて予約された。
test("specialFormatOnly: 書誌種別が点字付なら、所蔵に「図書」が混ざっていても特殊資料として弾く", () => {
  const body =
    "書誌種別 点字付 著者名 中川 李枝子／さく 出版者 福音館書店 " +
    "資料種別 点字付 帯出区分 ".repeat(28) +
    "資料種別 図書 帯出区分";
  assert.equal(specialFormatOnly(body), "点字付");
  assert.equal(specialFormatOnly("書誌種別 さわる本-利用限定 資料種別 図書"), "さわる本-利用限定");
});

test("specialFormatOnly: 書誌種別が図書なら従来どおり所蔵の資料種別で判定する", () => {
  assert.equal(specialFormatOnly("書誌種別 図書 資料種別 図書"), null);
  assert.equal(specialFormatOnly("書誌種別 図書 資料種別 大型絵本 資料種別 大型絵本"), "大型絵本");
  assert.equal(specialFormatOnly("書誌種別 しかけ本 資料種別 図書"), null);
});

test("rankResults: 書名に「てんじつき」「さわるえほん」が付く版は後回し", () => {
  const results = [
    { index: 0, title: "ぐりとぐら てんじつきさわるえほん", publisher: "福音館書店" },
    { index: 1, title: "ぐりとぐら", publisher: "福音館書店" },
  ];
  assert.deepEqual(rankResults(results, "ぐりとぐら", 6, false, "福音館書店").map((r) => r.index), [1, 0]);
});

// 2026-11-02 chojo「にんじん」: 該当1000件超でトップページへ突き返されていた（3週連続の検索不成立の真因）
test("isTooManyHitsPage: 該当件数の上限超えメッセージを検出する", () => {
  assert.ok(isTooManyHitsPage('lbAlert("該当件数が1000件を超えました。検索キーを見直し下さい。", "")'));
  assert.ok(!isTooManyHitsPage("<title>トップページ：蔵書検索システム</title>"));
});

test("firstAuthorWord: リストの著者欄から原作者名だけを取り出す", () => {
  assert.equal(firstAuthorWord("ルナール 高野優・訳"), "ルナール");
  assert.equal(firstAuthorWord("なかがわりえこ おおむらゆりこ・絵"), "なかがわりえこ");
  assert.equal(firstAuthorWord("椋鳩十"), "椋鳩十");
  assert.equal(firstAuthorWord("ドロシー・マリノ"), "ドロシー・マリノ");
  assert.equal(firstAuthorWord(""), "");
});

// 2026-10-26 jinan: リスト「くっきーだあいすき」／OPAC「くっきーだぁいすき」で成立照合が落ちた
test("sameWork / rankResults: 小書きの仮名の違い（ぁ/あ）は同じ作品として通す", () => {
  assert.ok(sameWork("くっきーだぁいすき", "くっきーだあいすき"));
  assert.ok(!sameWork("ともだちやま", "ともだちや"));
  const r = rankResults([{ index: 0, title: "くっきーだぁいすき", publisher: "金の星社" }], "くっきーだあいすき", 6, false, "金の星社");
  assert.equal(r.length, 1);
});

import { parseHitCount, publisherMatches } from "../src/opac.js";

test("parseHitCount: 「該当 N 件」を読む（カンマ・無しにも対応）", () => {
  assert.equal(parseHitCount("検索結果 該当 131 件 表示件数"), 131);
  assert.equal(parseHitCount("該当 1,234 件"), 1234);
  assert.equal(parseHitCount("本文が空"), null);
});

// 2026-11-02 判明: リスト「冨山房」／OPAC「富山房」で12週連続見送っていた（まよなかのだいどころ）
test("publisherMatches: 異体字（冨/富 等）を同一視する", () => {
  assert.ok(publisherMatches("富山房", "冨山房"));
  assert.ok(publisherMatches("冨山房インターナショナル", "冨山房"));
  assert.ok(!publisherMatches("福音館書店", "冨山房"));
});

test("rankResults: OPACが「富山房」でもリスト「冨山房」の版を候補にする", () => {
  const rs = [{ index: 0, title: "まよなかのだいどころ", publisher: "富山房" }];
  assert.equal(rankResults(rs, "まよなかのだいどころ", 6, false, "冨山房").length, 1);
});
