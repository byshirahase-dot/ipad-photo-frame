import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** .env を読み込んで process.env に反映する（依存パッケージなし） */
export function loadDotEnv(file = path.join(ROOT, ".env")) {
  if (!fs.existsSync(file)) return false;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m || line.trim().startsWith("#")) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
  return true;
}

export function loadAccountsConfig() {
  return JSON.parse(fs.readFileSync(path.join(ROOT, "accounts.json"), "utf8"));
}

export function credentialsFor(account) {
  const card = process.env[account.envCard];
  const pass = process.env[account.envPass];
  return { card, pass, missing: !card || !pass };
}

export function todayStr(d = new Date()) {
  const jst = new Date(d.getTime() + 9 * 3600 * 1000);
  return jst.toISOString().slice(0, 10);
}

export function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
  return p;
}

/**
 * 小書きの仮名を並字に揃える（ぁ→あ、ッ→ツ 等）。書名の照合用。
 * 実害（2026-10-26 jinan）: リストの「くっきーだあいすき」がOPACでは「くっきーだぁいすき」で、
 * 予約は成立していたのに照合が落ち、未成立と誤報告された。
 */
export function foldSmallKana(s) {
  const small = "ぁぃぅぇぉっゃゅょゎゕゖァィゥェォッャュョヮヵヶ";
  const large = "あいうえおつやゆよわかけアイウエオツヤユヨワカケ";
  return String(s ?? "").replace(/[ぁぃぅぇぉっゃゅょゎゕゖァィゥェォッャュョヮヵヶ]/g, (c) => large[small.indexOf(c)]);
}
