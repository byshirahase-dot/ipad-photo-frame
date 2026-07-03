import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadKumonList, flatten, planWeek } from "../src/kumon.js";
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
