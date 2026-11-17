import { test } from "node:test";
import assert from "node:assert/strict";
import {
  splitOpacTitle, parseLentList, matchLedger, buildChecklist, mergeRecorded, formBody, judgeRecommendation,
} from "../scripts/lib/reading-link.mjs";

const row = (title, loan = "2026/11/01", due = "2026/11/15") => `
<span class="layer-number">1</span>
<div class="layer-item">
  <!-- 資料名/資料番号 -->
  <div class="title"><a href="x.do?para=1" onclick="toDetail(&quot;1&quot;);return false;"><strong> ${title}</strong></a></div>
  <div class="matter"><span class="value">図書</span></div>
  <div class="matter"><span class="label">貸出日：</span><span class="value">${loan}</span></div>
  <div class="matter"><span class="label">返却期日：</span><span class="value">${due}</span></div>
</div>`;

test("splitOpacTitle: 書名・著者・出版社に分ける", () => {
  const r = splitOpacTitle("扉のむこうの物語　名作の森　岡田 淳／作・絵　理論社");
  assert.equal(r.title, "扉のむこうの物語");
  assert.equal(r.author, "岡田 淳／作・絵");
  assert.equal(r.publisher, "理論社");
});

test("parseLentList: 行ごとに題名と貸出日を読む", () => {
  const html = `<html>${row("くだものだもの　幼児絵本シリーズ　石津 ちひろ／文　福音館書店", "2026/10/18")}${row("14ひきのひっこし　いわむら かずお／作　童心社")}</html>`;
  const loans = parseLentList(html);
  assert.equal(loans.length, 2);
  assert.equal(loans[0].title, "くだものだもの");
  assert.equal(loans[0].loanDate, "2026/10/18");
  assert.equal(loans[1].publisher, "童心社");
  assert.equal(loans[1].dueDate, "2026/11/15");
});

test("matchLedger: 長い書名を優先し、短い書名に誤って寄せない", () => {
  const books = [
    { title: "11ぴきのねこ", status: "borrowed" },
    { title: "11ぴきのねことへんなねこ", status: "reserved" },
    { title: "ひとまねこざる", status: "failed" },
  ];
  const loan = { raw: "11ぴきのねことへんなねこ　馬場 のぼる／著　こぐま社", ...splitOpacTitle("11ぴきのねことへんなねこ　馬場 のぼる／著　こぐま社") };
  const m = matchLedger(loan, books);
  assert.equal(m.entry.title, "11ぴきのねことへんなねこ");
  assert.equal(m.exact, true);
  const other = { raw: "ひとまねこざる　岩波の子どもの本　レイ／作　岩波書店", ...splitOpacTitle("ひとまねこざる　岩波の子どもの本　レイ／作　岩波書店") };
  assert.equal(matchLedger(other, books), null); // failed は対象外
});

test("matchLedger: 副題が全角スペースで分かれた書名も一致", () => {
  const books = [{ title: "フングリコングリ 図工室のおはなし会", status: "borrowed" }];
  const raw = "フングリコングリ　図工室のおはなし会　岡田 淳／作・絵　偕成社";
  const m = matchLedger({ raw, ...splitOpacTitle(raw) }, books);
  assert.equal(m.exact, true);
});

test("buildChecklist: 台帳にある本だけ・記録済みは除く・貸出中を先に", () => {
  const books = [
    { title: "扉のむこうの物語", author: "岡田淳", status: "borrowed" },
    { title: "空気がなくなる日", author: "岩倉政治", status: "reserved" },
    { title: "放課後の時間割", author: "岡田淳", status: "reserved" },
  ];
  const mk = (raw, loanDate) => ({ raw, ...splitOpacTitle(raw), loanDate, dueDate: "" });
  const snapshots = [
    { date: "2026-11-09", loans: [mk("放課後の時間割　岡田 淳／作　偕成社", "2026/10/18"), mk("扉のむこうの物語　名作の森　岡田 淳／作・絵　理論社", "2026/10/18")] },
    { date: "2026-11-16", loans: [mk("扉のむこうの物語　名作の森　岡田 淳／作・絵　理論社", "2026/10/18"), mk("空気がなくなる日　岩倉 政治／著　新日本出版社", "2026/11/01"), mk("じぶんで選んだ本　だれか／作　どこか社", "2026/11/01")] },
  ];
  const r = buildChecklist({ books, snapshots, recordedTitles: ["空気がなくなる日"] });
  assert.deepEqual(r.items.map((i) => [i.no, i.title, i.onLoan]), [
    [1, "扉のむこうの物語", true],
    [2, "放課後の時間割", false],
  ]);
  assert.equal(r.others, 1);
  assert.equal(r.recorded, 1);
});

test("mergeRecorded: 名前でもアカウントIDでも受け、重複は足さない", () => {
  const names = { chojo: "はな", chonan: "たろう" };
  let rec = mergeRecorded({}, { はな: ["こんとあき", "こんと あき"], chonan: [{ title: "いやいやえん", date: "2026-05-17" }] }, names);
  assert.equal(rec.chojo.length, 1);
  assert.equal(rec.chonan[0].date, "2026-05-17");
  rec = mergeRecorded(rec, { chojo: ["こんとあき"] }, names, "form");
  assert.equal(rec.chojo.length, 1);
});

test("formBody: 名前・題名・日付をフォームの項目に入れる", () => {
  const form = { entries: { name: "entry.1", title: "entry.2", date: "entry.3" } };
  const p = formBody(form, { name: "はな", title: "扉のむこうの物語", date: "2026-11-17" });
  assert.equal(p.get("entry.1"), "はな");
  assert.equal(p.get("entry.2"), "扉のむこうの物語");
  assert.equal(p.get("entry.3_year"), "2026");
  assert.equal(p.get("entry.3_month"), "11");
  assert.equal(p.get("entry.3_day"), "17");
});

test("judgeRecommendation: どのリストにも無い本だけ足す", () => {
  const ctx = {
    kumonRows: [{ level: "F", order: 3, title: "ライオンと魔女" }],
    ehonnaviRows: [{ title: "夜の小学校で" }],
    seriesVolumes: [{ series: "ナルニア国ものがたり", title: "カスピアン王子のつのぶえ" }],
    ledgerBooks: [
      { title: "にんじん", status: "reserved", date: "2026-11-09" },
      { title: "ガラスの家族", status: "expired", date: "2026-10-09" },
    ],
    queueItems: [{ title: "ハックルベリー・フィンの冒険 上" }],
  };
  assert.equal(judgeRecommendation({ title: "ライオンと魔女" }, ctx).action, "skip");
  assert.equal(judgeRecommendation({ title: "夜の小学校で" }, ctx).action, "skip");
  assert.equal(judgeRecommendation({ title: "カスピアン王子のつのぶえ" }, ctx).action, "skip");
  assert.equal(judgeRecommendation({ title: "にんじん" }, ctx).action, "skip");
  assert.equal(judgeRecommendation({ title: "ハックルベリー・フィンの冒険　上" }, ctx).action, "skip");
  assert.equal(judgeRecommendation({ title: "ガラスの家族" }, ctx).action, "add"); // expired は再予約できる
  assert.equal(judgeRecommendation({ title: "ダレン・シャン 1 奇怪なサーカス" }, ctx).action, "add");
});
