import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { JSDOM } from "jsdom";

// Maintainer-only importer. The application never fetches legislation at runtime.
const target = new URL("../src/renderer/src/legislation/assets/", import.meta.url);
await mkdir(target, { recursive: true });
const sources = [
  {
    id: "law",
    short: "专利法",
    title: "中华人民共和国专利法",
    version: "2020年修正",
    effective: "2021-06-01",
    source: "https://www.cnipa.gov.cn/art/2020/11/23/art_97_155167.html",
    lastArticle: "第八十二条",
  },
  {
    id: "rules",
    short: "实施细则",
    title: "中华人民共和国专利法实施细则",
    version: "2023年修订",
    effective: "2024-01-20",
    source: "https://www.cnipa.gov.cn/art/2023/12/21/art_98_189197.html",
    lastArticle: "第一百四十九条",
  },
];
for (const source of sources) {
  const response = await fetch(source.source);
  if (!response.ok) throw new Error(`${source.id}: HTTP ${response.status}`);
  const html = await response.text();
  const dom = new JSDOM(html);
  const article = dom.window.document.querySelector(".article-content");
  if (!article) throw new Error(`${source.id}: official article container missing`);
  const paragraphs = [...article.querySelectorAll("p")]
    .map((p) => p.textContent.trim())
    .filter(Boolean);
  if (!paragraphs.some((p) => p.startsWith(source.lastArticle)))
    throw new Error(`${source.id}: incomplete article`);
  const content = { ...source, checked: "2026-09-07", paragraphs };
  await writeFile(new URL(`${source.id}.json`, target), `${JSON.stringify(content, null, 2)}\n`);
  console.log(source.id, paragraphs.length, "paragraphs");
  dom.window.close();
}
const url = "https://www.cnipa.gov.cn/attach/0/3f6306029ff741dfad6cee9282ec6efc.pdf";
const response = await fetch(url);
if (!response.ok) throw new Error(`guide: HTTP ${response.status}`);
const bytes = Buffer.from(await response.arrayBuffer());
if (bytes.subarray(0, 5).toString() !== "%PDF-") throw new Error("guide: not a PDF");
await writeFile(new URL("guidelines-2025.pdf", target), bytes);
console.log("guide", bytes.length, "bytes", createHash("sha256").update(bytes).digest("hex"));
// This official PDF has no bookmark tree. Preserve its printed contents as a local navigation index.
const pdf = await import("pdfjs-dist/legacy/build/pdf.mjs");
const loading = pdf.getDocument({ data: Uint8Array.from(bytes) });
try {
  const doc = await loading.promise;
  let contents = "";
  for (const number of [3, 4]) {
    contents += (await (await doc.getPage(number)).getTextContent()).items
      .map((item) => item.str ?? "")
      .join(" ");
  }
  const entries = [
    ...contents.matchAll(/(第[一二三四五六七八九十]+(?:部分|章))\s+([^…]+?)\s+(\d+)\s*…+/g),
  ].map((match) => ({
    title: `${match[1]} ${match[2].replace(/\s+/g, "").trim()}`,
    page: Number(match[3]) + 4,
  }));
  if (entries.filter((item) => item.title.includes("部分")).length !== 6)
    throw new Error("guide: incomplete contents index");
  for (const entry of entries) {
    const text = (await (await doc.getPage(entry.page)).getTextContent()).items
      .map((item) => item.str ?? "")
      .join("")
      .replace(/\s+/g, "");
    if (!text.includes(entry.title.replace(/\s+/g, "")))
      throw new Error(`guide: wrong destination ${entry.title}`);
  }
  await writeFile(
    new URL("guidelines-outline.json", target),
    `${JSON.stringify(entries, null, 2)}\n`,
  );
  console.log("guide outline", entries.length, "verified destinations");
} finally {
  await loading.destroy();
}
