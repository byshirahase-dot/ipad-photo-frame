import fs from "node:fs";

const TSV = new URL("./suisen.tsv", import.meta.url).pathname;
const rows = fs.readFileSync(TSV, "utf8").split("\n").slice(1).filter(Boolean).map((l) => {
  const c = l.split("\t");
  return { page: +c[1], left: +c[6], top: +c[7], width: +c[8], height: +c[9], text: c[11] };
}).filter((t) => t.text && !t.text.startsWith("###"));

const books = [];

for (const page of [1, 2]) {
  const headers = rows
    .filter((t) => t.page === page && t.height > 13 && t.height < 20 && /^(5A|4A|3A|2A|[A-I])$/.test(t.text))
    .sort((a, b) => a.left - b.left)
    .map((h) => ({ level: h.text, cx: h.left + h.width / 2 }));
  console.error(`page${page} headers:`, headers.map((h) => h.level).join(","));

  const footTok = rows.find((t) => t.page === page && t.text.startsWith("■"));
  const footY = footTok ? footTok.top - 5 : Infinity;

  const bounds = headers.map((h, i) => ({
    level: h.level,
    lo: i === 0 ? 0 : (headers[i - 1].cx + h.cx) / 2,
    hi: i === headers.length - 1 ? Infinity : (h.cx + headers[i + 1].cx) / 2,
  }));
  const colOf = (t) => {
    const cx = t.left + t.width / 2;
    return bounds.findIndex((b) => cx >= b.lo && cx < b.hi);
  };

  const body = rows.filter(
    (t) =>
      t.page === page &&
      t.top < footY &&
      !/^(jp\.nakaoka|suisentosho_|DR$|©$|R$)/.test(t.text) &&
      !/^\d{4}\/\d{2}\/\d{2}$/.test(t.text) &&
      !/^\d{2}:\d{2}:\d{2}$/.test(t.text)
  );

  const titleToks = body.filter((t) => t.height >= 9.5 && t.height <= 11);

  // タイトル行クラスタ（ページ全体、y近接4pt）
  const lines = [];
  for (const t of [...titleToks].sort((a, b) => a.top - b.top)) {
    const ln = lines[lines.length - 1];
    if (ln && t.top - ln.y < 4) {
      ln.toks.push(t);
      ln.y = Math.max(ln.y, t.top);
    } else {
      lines.push({ y: t.top, toks: [t] });
    }
  }
  // 本物の「行」= 複数列にタイトルがある行。1列だけの行は折返し
  for (const ln of lines) {
    ln.cols = new Set(ln.toks.map(colOf));
    ln.primary = ln.cols.size >= 3;
  }

  for (let ci = 0; ci < bounds.length; ci++) {
    const level = bounds[ci].level;
    const colBooks = [];
    for (const ln of lines) {
      const toks = ln.toks.filter((t) => colOf(t) === ci).sort((a, b) => a.left - b.left);
      if (!toks.length) continue;
      if (ln.primary || !colBooks.length) {
        colBooks.push({ toks: [...toks], firstTop: ln.y, lastTop: ln.y });
      } else {
        const b = colBooks[colBooks.length - 1];
        b.toks.push(...toks);
        b.lastTop = ln.y;
      }
    }

    const authorToks = body.filter((t) => t.height < 8.5 && colOf(t) === ci);
    colBooks.forEach((g, i) => {
      let title = g.toks.map((t) => t.text).join(" ")
        .replace(/[●※]/g, "")
        .replace(/\bnew\b/gi, "")
        .replace(/（\s*[0-9０-９]+\s*冊\s*）/g, "")
        .replace(/\s+/g, " ")
        .trim();
      const aToks = authorToks
        .filter((t) => t.top > g.firstTop && t.top < g.lastTop + 16)
        .sort((a, b) => a.top - b.top || a.left - b.left);
      const author = aToks.map((t) => t.text).join(" ").replace(/\s+/g, " ").trim();
      books.push({ level, order: i + 1, title, author });
    });
    console.error(`page${page} ${level}: ${colBooks.length} books`);
  }
}

const esc = (s) => (/[",]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
const csv = ["level,order,title,author", ...books.map((b) => `${b.level},${b.order},${esc(b.title)},${esc(b.author)}`)].join("\n") + "\n";
fs.writeFileSync(new URL("./kumon_list.csv", import.meta.url).pathname, csv);
console.error(`total: ${books.length}`);
