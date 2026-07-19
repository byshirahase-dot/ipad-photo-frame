import fs from "node:fs";
import path from "node:path";
import { ROOT, ensureDir, todayStr } from "./config.js";

function stateDir(accountId) {
  return ensureDir(path.join(ROOT, "state", accountId));
}

function readJson(file, fallback) {
  if (!fs.existsSync(file)) return fallback;
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function writeJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n");
}

/** 予約・貸出・失敗の履歴。同じ本を二度予約しないための台帳 */
export class Ledger {
  constructor(accountId) {
    this.file = path.join(stateDir(accountId), "reserved.json");
    this.data = readJson(this.file, { books: [] });
  }
  /** タイトルの表記ゆれを吸収して照合するキー */
  static key(title) {
    return String(title)
      .replace(/[\s　]/g, "")
      .replace(/[（(].*?[）)]/g, "")
      .toLowerCase();
  }
  /** expired（予約無効）になった本はブロックしない＝再予約できる */
  has(title) {
    const k = Ledger.key(title);
    return this.data.books.some((b) => b.status !== "expired" && Ledger.key(b.title) === k);
  }
  /** status: "reserved" | "borrowed" | "failed" | "skipped" | "expired" */
  add({ title, author = "", status, note = "", source = "" }) {
    this.data.books.push({ title, author, status, note, source, date: todayStr() });
    writeJson(this.file, this.data);
  }
  /**
   * サイトの予約一覧のタイトル（副題やシリーズ名が付くことがある）から、
   * 予約中(reserved)の台帳エントリを探す。
   */
  findActiveReserved(siteTitle) {
    const sk = Ledger.key(siteTitle);
    return (
      this.data.books.findLast?.((b) => b.status === "reserved" && (sk === Ledger.key(b.title) || sk.includes(Ledger.key(b.title)))) ??
      [...this.data.books].reverse().find((b) => b.status === "reserved" && (sk === Ledger.key(b.title) || sk.includes(Ledger.key(b.title))))
    );
  }
  /** 予約が期限切れ・無効になった → 台帳から外して再予約可能にする */
  markExpired(entry, note = "予約期限切れ・無効（取り置き期限切れ／延滞ペナルティ等）") {
    entry.status = "expired";
    entry.note = note;
    entry.expiredDate = todayStr();
    writeJson(this.file, this.data);
  }
  /**
   * 予約が受取済み（借用中）になった → 終了扱い（borrowed）にする。
   * has() は borrowed を「済み」とみなす（再予約しない）が、findActiveReserved は
   * reserved のみ対象なので取消復帰の対象からも外れる。
   * サイト上で予約が「取消」表示でも実際は借りている本を二重予約しないための終端状態。
   */
  markBorrowed(entry, note = "受取済み・貸出中（借用済み）のため終了扱い") {
    entry.status = "borrowed";
    entry.note = note;
    entry.borrowedDate = todayStr();
    writeJson(this.file, this.data);
  }
}

/** 公文リスト上の現在位置（レベル・何冊目か） */
export class Progress {
  constructor(accountId, startProgress) {
    this.file = path.join(stateDir(accountId), "progress.json");
    this.data = readJson(this.file, { ...startProgress });
  }
  get() {
    return { ...this.data };
  }
  set(level, position) {
    this.data = { level, position };
    writeJson(this.file, this.data);
  }
}

/**
 * シリーズ展開などで挿入された「次に予約すべき本」の待ち行列。
 * persist=false（ドライラン）ではファイルに書き込まない。
 */
export class Queue {
  constructor(accountId, { persist = true } = {}) {
    this.file = path.join(stateDir(accountId), "queue.json");
    this.data = readJson(this.file, { items: [] });
    this.persist = persist;
  }
  #save() {
    if (this.persist) writeJson(this.file, this.data);
  }
  /** 現在のキュー内容を明示的にファイルへ書き出す（persist=false でも書く）。
   *  予約が実際に成立した後にだけ消化結果を確定させたいときに使う。 */
  save() {
    writeJson(this.file, this.data);
  }
  peek() {
    return this.data.items[0];
  }
  shift() {
    const it = this.data.items.shift();
    this.#save();
    return it;
  }
  push(...items) {
    this.data.items.push(...items);
    this.#save();
  }
  /** 先頭に割り込ませる（期限切れ再予約など優先度の高いもの） */
  unshift(...items) {
    this.data.items.unshift(...items);
    this.#save();
  }
  get length() {
    return this.data.items.length;
  }
}

/** 母アカウント: Cowork が置く data/mom/queue.json と推薦済み記録 */
export function readMomQueue() {
  const file = path.join(ROOT, "data", "mom", "queue.json");
  return { file, queue: readJson(file, null) };
}

export function writeMomQueue(file, queue) {
  writeJson(file, queue);
}

export function recordMomRecommended(entry) {
  const file = path.join(stateDir("mom"), "recommended.json");
  const data = readJson(file, { books: [] });
  data.books.push({ ...entry, date: todayStr() });
  writeJson(file, data);
}
