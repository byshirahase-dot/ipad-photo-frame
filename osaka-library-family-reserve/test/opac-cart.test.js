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
