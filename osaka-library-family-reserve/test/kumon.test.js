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

// --- rankResults: 上下巻は上から予約する（ユーザー指定 2026-08） ---
// 同じ作品名で複数巻がヒットしたら、スコアが同点でも 上/単巻 → 中 → 下 の順に並べ、
// 上巻を先に予約させる（下巻だけ届いた「ハックルベリー・フィンの冒険」への対処）。
test("rankResults: 上下巻は 上→中→下 の順に並ぶ（同点時のタイブレーク）", async () => {
  const { rankResults } = await import("../src/opac.js");
  // OPAC が下巻を先に返しても、上巻が先頭に来る
  const results = [
    { index: 0, title: "ハックルベリー・フィンの冒険 下", publisher: "岩波書店", href: "d" },
    { index: 1, title: "ハックルベリー・フィンの冒険 上", publisher: "岩波書店", href: "u" },
  ];
  const ranked = rankResults(results, "ハックルベリー・フィンの冒険", 3, false, "岩波書店");
  assert.deepEqual(ranked.map((r) => r.title), [
    "ハックルベリー・フィンの冒険 上",
    "ハックルベリー・フィンの冒険 下",
  ]);
  // 括弧書き（上）（下）・中巻を含む3巻でも順序が保たれる
  const three = [
    { index: 0, title: "作品名（下）", publisher: "X社", href: "d" },
    { index: 1, title: "作品名（中）", publisher: "X社", href: "m" },
    { index: 2, title: "作品名（上）", publisher: "X社", href: "u" },
  ];
  const r3 = rankResults(three, "作品名", 3, false, null);
  assert.deepEqual(r3.map((r) => r.title), ["作品名（上）", "作品名（中）", "作品名（下）"]);
});

// --- orderPicksForCart: カート投入順の最適化（2026-08-09 / 2026-08-17 判定軸を publisher へ） ---
// 版スキップしやすい本＝publisher 指定のある本（list/ehonnavi/series/版指定の再予約）を先に、
// 版ガードが無く確実にカートへ入る本＝publisher 指定の無い本（取消復帰など）を後に処理し、
// 最後の操作が addToCart（カート画面に留まる）になるようにする。安定ソートで群内順は保つ。
test("orderPicksForCart: 版スキップしやすい出所を先頭へ・再予約本を末尾へ（jinan 2026-08-17 の再現）", () => {
  // jinan 08-17 の実際の picks 相当。全冊 publisher を持つ（パンダ銭湯は絵本ナビ枠＝出版社:絵本館）ため、
  // 旧「publisher の有無」判定では並べ替えが起きず、末尾の版スキップ本（まよなかのだいどころ）が
  // 確定フェーズを巻き添えにして全滅していた。出所（from）で判定するのが正しい。
  const picks = [
    { title: "パンダ銭湯", from: "ehonnavi", publisher: "絵本館" },        // 版スキップしうる（先頭側）
    { title: "ちいさなたまねぎさん", from: "再予約リクエスト", publisher: "金の星社" }, // 確実に入る（末尾側）
    { title: "あおくんときいろちゃん", from: "再予約リクエスト", publisher: "至光社" }, // 確実に入る（末尾側）
    { title: "まよなかのだいどころ", from: "list", publisher: "冨山房" },   // 版スキップの主因（先頭側）
  ];
  const ordered = orderPicksForCart(picks);
  // 末尾は再予約本（以前予約できた版が存在＝確実にカートへ入る）＝最後の操作が addToCart になる
  const last = ordered[ordered.length - 1];
  assert.equal(last.from, "再予約リクエスト");
  // 版スキップの主因（list 本）は末尾ではない
  assert.notEqual(last.title, "まよなかのだいどころ");
  // list / ehonnavi は先頭側に集まる
  assert.deepEqual(ordered.slice(0, 2).map((p) => p.from).sort(), ["ehonnavi", "list"]);
});

test("orderPicksForCart is a stable partition (群内の順序は保つ)", () => {
  const picks = [
    { title: "A", from: "list" },
    { title: "B", from: "requeue:x" },
    { title: "C", from: "series:S" },
    { title: "D", from: "再予約リクエスト" },
    { title: "E", from: "ehonnavi" },
  ];
  const ordered = orderPicksForCart(picks).map((p) => p.title).join("");
  // 版スキップしやすい出所（A=list, C=series, E=ehonnavi）を元順で、続けて再予約系（B,D）を元順で
  assert.equal(ordered, "ACEBD");
});

test("orderPicksForCart: 全て版スキップ系／全て再予約系でも壊れない", () => {
  const allProne = [{ title: "A", from: "list" }, { title: "B", from: "series:S" }];
  assert.deepEqual(orderPicksForCart(allProne).map((p) => p.title), ["A", "B"]);
  const noneProne = [{ title: "A", from: "requeue:1" }, { title: "B", from: "再予約リクエスト" }];
  assert.deepEqual(orderPicksForCart(noneProne).map((p) => p.title), ["A", "B"]);
  // from が無い pick は再予約系（末尾側）扱いで落とさない
  const noFrom = [{ title: "A", from: "list" }, { title: "B" }];
  assert.deepEqual(orderPicksForCart(noFrom).map((p) => p.title), ["A", "B"]);
});
