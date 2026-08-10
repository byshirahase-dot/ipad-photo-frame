import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadKumonList, flatten, planWeek, orderPicksForCart } from "../src/kumon.js";
import { Ledger } from "../src/state.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LEVELS = ["5A", "4A", "3A", "2A", "A", "B", "C", "D", "E", "F", "G", "H", "I"];

function fakeLedger(titles = []) {
  const set = new Set(titles.map(Ledger.key));
  return {
    has: (t) => set.has(Ledger.key(t)),
    add: ({ title }) => set.add(Ledger.key(title)),
  };
}

function fakeQueue(items = []) {
  return {
    items,
    peek: () => items[0],
    shift: () => items.shift(),
    push: (...xs) => items.push(...xs),
    get length() {
      return items.length;
    },
  };
}

function fakeProgress(level, position) {
  let cur = { level, position };
  return { get: () => ({ ...cur }), set: (l, p) => (cur = { level: l, position: p }) };
}

function sampleFlat() {
  const rows = loadKumonList(path.join(ROOT, "data", "kumon_list.sample.csv"));
  return flatten(rows, LEVELS);
}

test("CSV読み込みとレベル順のフラット化", () => {
  const flat = sampleFlat();
  assert.equal(flat[0].level, "3A");
  assert.equal(flat[0].order, 1);
  assert.equal(flat[0].title, "ぐりとぐら");
  // 3A → A → E の順
  const levels = [...new Set(flat.map((r) => r.level))];
  assert.deepEqual(levels, ["3A", "A", "E"]);
});

test("進度位置から4冊選ぶ（次男: 3Aの最初から）", () => {
  const { picks, nextProgress } = planWeek({
    flat: sampleFlat(),
    progress: fakeProgress("3A", 1),
    queue: fakeQueue(),
    ledger: fakeLedger(),
    quota: 4,
    seriesResolver: null,
  });
  assert.deepEqual(
    picks.map((p) => p.title),
    ["ぐりとぐら", "はらぺこあおむし", "てぶくろ", "おおきなかぶ"]
  );
  assert.deepEqual(nextProgress, { level: "3A", position: 5 });
});

test("予約済みの本はスキップして次に進む", () => {
  const { picks } = planWeek({
    flat: sampleFlat(),
    progress: fakeProgress("3A", 1),
    queue: fakeQueue(),
    ledger: fakeLedger(["ぐりとぐら", "てぶくろ"]),
    quota: 4,
    seriesResolver: null,
  });
  assert.deepEqual(
    picks.map((p) => p.title),
    ["はらぺこあおむし", "おおきなかぶ", "三びきのやぎのがらがらどん", "ふらいぱんじいさん"]
  );
});

test("長男: Aの11冊目（エルマー）からスタート", () => {
  const { picks } = planWeek({
    flat: sampleFlat(),
    progress: fakeProgress("A", 11),
    queue: fakeQueue(),
    ledger: fakeLedger(),
    quota: 2,
    seriesResolver: null,
  });
  assert.equal(picks[0].title, "エルマーのぼうけん");
});

test("シリーズ展開: 全巻がキュー経由で巻順に消化される", () => {
  const resolver = (row) =>
    row.title === "エルマーのぼうけん"
      ? {
          name: "エルマー",
          volumes: [
            { order: 1, title: "エルマーのぼうけん" },
            { order: 2, title: "エルマーとりゅう" },
            { order: 3, title: "エルマーと16ぴきのりゅう" },
          ],
        }
      : null;
  const queue = fakeQueue();
  const { picks } = planWeek({
    flat: sampleFlat(),
    progress: fakeProgress("A", 11),
    queue,
    ledger: fakeLedger(),
    quota: 2,
    seriesResolver: resolver,
  });
  assert.deepEqual(
    picks.map((p) => p.title),
    ["エルマーのぼうけん", "エルマーとりゅう"]
  );
  // あふれた3巻目は持ち越しキューへ
  assert.equal(queue.items[0].title, "エルマーと16ぴきのりゅう");

  // 翌週はキューの持ち越し分が最優先
  const week2 = planWeek({
    flat: sampleFlat(),
    progress: fakeProgress("A", 12),
    queue,
    ledger: fakeLedger(["エルマーのぼうけん", "エルマーとりゅう"]),
    quota: 2,
    seriesResolver: null,
  });
  assert.equal(week2.picks[0].title, "エルマーと16ぴきのりゅう");
  assert.equal(week2.picks[1].title, "いやいやえん");
});

test("週4冊 = シリーズ2冊＋リスト2冊（シリーズ枠は週2冊まで）", () => {
  const resolver = (row) =>
    row.title === "エルマーのぼうけん"
      ? {
          name: "エルマー",
          volumes: [1, 2, 3, 4, 5, 6].map((i) => ({ order: i, title: `エルマー巻${i}` })),
        }
      : null;
  const queue = fakeQueue();
  const { picks } = planWeek({
    flat: sampleFlat(),
    progress: fakeProgress("A", 11), // エルマーのぼうけん から
    queue,
    ledger: fakeLedger(),
    quota: 4,
    seriesResolver: resolver,
    seriesPerWeek: 2,
  });
  assert.deepEqual(
    picks.map((p) => p.title),
    ["エルマー巻1", "エルマー巻2", "いやいやえん", "ももいろのきりん"]
  );
  // 残り4巻はキューへ（翌週以降、週2冊ずつ）
  assert.deepEqual(queue.items.map((q) => q.title), ["エルマー巻3", "エルマー巻4", "エルマー巻5", "エルマー巻6"]);

  // 翌週: キューから2冊＋リスト2冊
  const week2 = planWeek({
    flat: sampleFlat(),
    progress: fakeProgress("A", 12),
    queue,
    ledger: fakeLedger(["エルマー巻1", "エルマー巻2", "いやいやえん", "ももいろのきりん"]),
    quota: 4,
    seriesResolver: null,
    seriesPerWeek: 2,
  });
  assert.deepEqual(
    week2.picks.map((p) => p.title),
    ["エルマー巻3", "エルマー巻4", "ロボット・カミイ", "モモ"]
  );
});

test("出版社指定: 一致する版だけが候補になり、無ければ空（別版を予約しない）", async () => {
  const { rankResults } = await import("../src/opac.js");
  const results = [
    { index: 0, title: "注文の多い料理店", publisher: "ミキハウス", href: "a" },      // 絵本版
    { index: 1, title: "注文の多い料理店", publisher: "講談社", href: "b" },          // リスト指定版
    { index: 2, title: "注文の多い料理店 大型絵本", publisher: "講談社", href: "c" },
  ];
  const cands = rankResults(results, "注文の多い料理店", 3, false, "講談社");
  assert.deepEqual(cands.map((c) => c.index), [1, 2]); // 講談社のみ・完全一致が先
  const none = rankResults(results, "注文の多い料理店", 3, false, "岩波書店");
  assert.equal(none.length, 0);
});

test("絵本ナビ枠: 週1冊が先頭に入り、残りはくもん/シリーズで埋まる（合計quota）", () => {
  const ehonnaviList = [
    { title: "絵本ナビ本A", author: "著者A", publisher: "出版A" },
    { title: "絵本ナビ本B", author: "著者B", publisher: "出版B" },
  ];
  const { picks } = planWeek({
    flat: sampleFlat(),
    progress: fakeProgress("3A", 1),
    queue: fakeQueue(),
    ledger: fakeLedger(),
    quota: 4,
    seriesResolver: null,
    ehonnaviList,
    ehonnaviPerWeek: 1,
  });
  assert.equal(picks.length, 4);
  assert.equal(picks[0].from, "ehonnavi");
  assert.equal(picks[0].title, "絵本ナビ本A");
  // 残り3冊はくもんリスト（サンプル3Aの先頭3冊）から
  assert.equal(picks.filter((p) => p.from === "ehonnavi").length, 1);
  assert.equal(picks.filter((p) => p.from === "list").length, 3);
});

test("絵本ナビ: 予約済み(台帳)の本はスキップして次の絵本ナビ本を選ぶ", () => {
  const ehonnaviList = [
    { title: "絵本ナビ本A", publisher: "出版A" },
    { title: "絵本ナビ本B", publisher: "出版B" },
  ];
  const { picks } = planWeek({
    flat: sampleFlat(),
    progress: fakeProgress("3A", 1),
    queue: fakeQueue(),
    ledger: fakeLedger(["絵本ナビ本A"]),
    quota: 4,
    seriesResolver: null,
    ehonnaviList,
    ehonnaviPerWeek: 1,
  });
  assert.equal(picks[0].title, "絵本ナビ本B");
});

test("特殊資料のみの書誌を検出（点字付のみ→スキップ、図書あり→予約可）", async () => {
  const { specialFormatOnly } = await import("../src/opac.js");
  assert.equal(specialFormatOnly("所蔵館 中央 資料種別 点字付 帯出区分 禁帯出"), "点字付");
  assert.equal(specialFormatOnly("資料種別 大型絵本 ... 資料種別 大型絵本"), "大型絵本");
  assert.equal(specialFormatOnly("資料種別 図書 ... 資料種別 点字付"), null); // 混在は通常版があるのでOK
  assert.equal(specialFormatOnly("資料種別 図書"), null);
  assert.equal(specialFormatOnly("資料種別の記載なし"), null);
});

test("advanceTo: 各pickは自分の次のリスト位置を指す（中断時の取りこぼし防止）", () => {
  const { picks } = planWeek({
    flat: sampleFlat(),
    progress: fakeProgress("3A", 1),
    queue: fakeQueue(),
    ledger: fakeLedger(),
    quota: 3,
    seriesResolver: null,
  });
  assert.deepEqual(picks[0].advanceTo, { level: "3A", position: 2 });
  assert.deepEqual(picks[1].advanceTo, { level: "3A", position: 3 });
  assert.deepEqual(picks[2].advanceTo, { level: "3A", position: 4 });
});

test("タイトル正規化: 空白や括弧の違いを同一視", () => {
  const led = fakeLedger(["ハリー・ポッターと賢者の石"]);
  assert.ok(led.has("ハリー・ポッターと賢者の石（上）"));
  assert.ok(led.has("ハリー・ポッターと賢者の石 "));
});

test("期限切れ予約は台帳から外れて再予約可能になる", async () => {
  const fs = await import("node:fs");
  const dir = path.join(ROOT, "state", "_test_ledger");
  fs.rmSync(dir, { recursive: true, force: true });
  try {
    const led = new Ledger("_test_ledger");
    led.add({ title: "にんじんさんがあかいわけ", author: "松谷みよ子", status: "reserved" });
    assert.ok(led.has("にんじんさんがあかいわけ"));

    // サイト側の表記は副題つき（「あかちゃんのむかしむかし」シリーズ名が付く）でも見つかる
    const entry = led.findActiveReserved("にんじんさんがあかいわけ あかちゃんのむかしむかし");
    assert.ok(entry);
    led.markExpired(entry);

    // 台帳ブロックが解除され、再予約対象になる
    assert.ok(!led.has("にんじんさんがあかいわけ"));
    // 再予約したら新エントリとして再びブロックされる
    led.add({ title: "にんじんさんがあかいわけ", status: "reserved" });
    assert.ok(led.has("にんじんさんがあかいわけ"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("借用済み(borrowed)は終端: 再予約もされず、取消復帰の対象にもならない", async () => {
  const fs = await import("node:fs");
  const dir = path.join(ROOT, "state", "_test_borrowed");
  fs.rmSync(dir, { recursive: true, force: true });
  try {
    const led = new Ledger("_test_borrowed");
    led.add({ title: "マフィンおばさんのぱんや", author: "竹林亜紀", status: "reserved" });
    // 受取して借用中になった → borrowed（終了扱い）にする
    const entry = led.findActiveReserved("マフィンおばさんのぱんや こどものとも");
    assert.ok(entry);
    led.markBorrowed(entry);
    // has() は「済み」とみなす＝再予約しない（expired と違ってブロックが解除されない）
    assert.ok(led.has("マフィンおばさんのぱんや"));
    // findActiveReserved は reserved のみ対象＝borrowed は取消復帰で拾われない
    assert.strictEqual(led.findActiveReserved("マフィンおばさんのぱんや こどものとも"), undefined);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- rankResults: 書誌詳細への直行(単一ヒット)フラグの通過を保証する ---
// searchTitle が index:-1, onDetail:true の合成結果を返したとき、rankResults がそのフラグと
// index を保持して返すこと（index.js が openResult を飛ばす判定に使う）を確認する。
test("rankResults preserves onDetail single-hit flag and index", async () => {
  const { rankResults } = await import("../src/opac.js");
  const single = [{ index: -1, onDetail: true, title: "リトルバンパイア 1 リュディガーとアントン", author: "", publisher: "くもん出版", href: "http://x/detail" }];
  // 出版社一致（くもん出版）→ 採用され、フラグ・index が保持される
  const ok = rankResults(single, "リトルバンパイア 1 リュディガーとアントン", 3, false, "くもん出版");
  assert.equal(ok.length, 1);
  assert.equal(ok[0].onDetail, true);
  assert.equal(ok[0].index, -1);
  // 出版社不一致（別の版）→ 除外され安全側に倒れる（誤った版を予約しない）
  const ng = rankResults(single, "リトルバンパイア 1 リュディガーとアントン", 3, false, "岩波書店");
  assert.equal(ng.length, 0);
});

// --- orderPicksForCart: カート投入順の最適化（2026-08-09） ---
// 版スキップしやすい本（list/ehonnavi/series）を先に、確実にカートへ入る取消復帰本（requeue）を
// 後に処理し、最後の操作が addToCart（カート画面に留まる）になるようにする。安定ソートで群内順は保つ。
test("orderPicksForCart moves requeue picks to the end (jinan 2026-08-10 の再現)", () => {
  // jinan 08-10 の実際の picks 相当: 先頭に requeue、末尾に版ガードの公文リスト本
  const picks = [
    { title: "パンダ銭湯", from: "requeue:予約取消" },
    { title: "14ひきのあさごはん", from: "requeue:予約取消" },
    { title: "14ひきのひっこし", from: "requeue:予約取消" },
    { title: "まよなかのだいどころ", from: "list", publisher: "冨山房" },
  ];
  const ordered = orderPicksForCart(picks);
  // 版ガードで見送りになりうる list 本が先頭に来る
  assert.equal(ordered[0].title, "まよなかのだいどころ");
  // 確実にカートへ入る requeue 本が末尾（＝最後の操作が addToCart になる）
  assert.equal(ordered[ordered.length - 1].from.startsWith("requeue"), true);
});

test("orderPicksForCart is a stable partition (群内の順序は保つ)", () => {
  const picks = [
    { title: "A", from: "list" },
    { title: "B", from: "requeue:x" },
    { title: "C", from: "series:S" },
    { title: "D", from: "requeue:y" },
    { title: "E", from: "ehonnavi" },
  ];
  const ordered = orderPicksForCart(picks).map((p) => p.title).join("");
  // 非requeue（A,C,E）を元順で、続けて requeue（B,D）を元順で
  assert.equal(ordered, "ACEBD");
});

test("orderPicksForCart: 全て requeue でも全て非requeue でも壊れない", () => {
  const allReq = [{ title: "A", from: "requeue:1" }, { title: "B", from: "requeue:2" }];
  assert.deepEqual(orderPicksForCart(allReq).map((p) => p.title), ["A", "B"]);
  const noReq = [{ title: "A", from: "list" }, { title: "B", from: "series:S" }];
  assert.deepEqual(orderPicksForCart(noReq).map((p) => p.title), ["A", "B"]);
  // from が無い pick も落とさない（非requeue 扱い）
  const noFrom = [{ title: "A" }, { title: "B", from: "requeue:1" }];
  assert.deepEqual(orderPicksForCart(noFrom).map((p) => p.title), ["A", "B"]);
});
