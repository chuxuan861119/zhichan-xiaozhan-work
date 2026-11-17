import { writeFile } from "node:fs/promises";
import { JSDOM } from "jsdom";

// Maintainer-only import. Bundled text is read offline by the application.
const sources = [
  [
    "agency",
    "专利代理条例",
    "行政法规",
    "2018年修订 · 国务院令第706号",
    "2019-03-01",
    "2020/10/26/art_2422_153737.html",
  ],
  [
    "agency-management",
    "专利代理管理办法",
    "部门规章",
    "2019年 · 市场监管总局令第6号",
    "2019-05-01",
    "2020/1/10/art_526_145919.html",
  ],
  [
    "application-conduct",
    "规范申请专利行为的规定",
    "部门规章",
    "2023年 · 局令第77号",
    "2024-01-20",
    "2023/12/21/art_2422_205031.html",
  ],
  [
    "priority-review",
    "专利优先审查管理办法",
    "部门规章",
    "2026年 · 局令第85号",
    "2026-09-01",
    "2026/7/30/art_74_207457.html",
  ],
  [
    "administrative-review",
    "国家知识产权局行政复议规程",
    "部门规章",
    "2024年修订 · 局令第82号",
    "2025-02-01",
    "2025/1/2/art_99_196999.html",
  ],
  [
    "dispute-mediation",
    "专利纠纷行政裁决和调解办法",
    "部门规章",
    "2024年 · 局令第81号",
    "2025-02-01",
    "2024/12/30/art_99_196969.html",
  ],
  [
    "biological-deposit",
    "用于专利程序的生物材料保藏办法",
    "部门规章",
    "2015年 · 局令第69号",
    "2015-03-01",
    "2015/1/23/art_99_28216.html",
  ],
  [
    "license-record",
    "专利实施许可合同备案办法",
    "部门规章",
    "2011年 · 局令第62号",
    "2011-08-01",
    "2011/6/29/art_99_28224.html",
  ],
  [
    "patent-marking",
    "专利标识标注办法",
    "部门规章",
    "2012年 · 局令第63号",
    "2012-05-01",
    "2013/10/23/art_74_27596.html",
  ],
  [
    "compulsory-license",
    "专利实施强制许可办法",
    "部门规章",
    "2012年 · 局令第64号",
    "2012-05-01",
    "2015/1/9/art_99_28229.html",
  ],
  [
    "defense-patent",
    "国防专利条例",
    "行政法规",
    "2004年 · 国务院、中央军委令第418号",
    "2004-11-01",
    "2015/9/8/art_98_28198.html",
  ],
  [
    "fee-reduction",
    "专利收费减缴办法",
    "配套政策",
    "财税〔2016〕78号 · 附后续调整公告",
    "2016-09-01",
    "2023/1/13/art_2468_181412.html",
  ],
  [
    "pledge-registration",
    "专利权质押登记办法",
    "配套政策",
    "2021年 · 公告第461号",
    "2021-11-15",
    "2021/11/16/art_74_171449.html",
  ],
  [
    "electronic-application",
    "关于专利电子申请的规定",
    "部门规章",
    "2010年 · 局令第57号",
    "2010-10-01",
    "2015/1/9/art_99_28235.html",
  ],
].map(([id, title, category, version, effective, path]) => ({
  id,
  title,
  short: title,
  category,
  version,
  effective,
  source: `https://www.cnipa.gov.cn/art/${path}`,
  note: "",
}));
const fee = sources.find((x) => x.id === "fee-reduction");
fee.note =
  "原办法与后续调整公告合并收录，保留各文件原文。费减条件、年费减缴期限及开放许可等政策请结合附后的2018、2019、2024年公告查阅。";
sources.find((x) => x.id === "electronic-application").note =
  "旧条文提示：第九条中电子送达满15日推定收到的规定已被2023年修订的专利法实施细则第四条替代。电子送达以进入当事人认可的电子系统之日为送达日。原文中的旧实施细则条号应结合现行文本查阅。";

async function officialText(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${url}`);
  const dom = new JSDOM(await response.text());
  try {
    const article = dom.window.document.querySelector(".article-content, #zoom, .TRS_Editor");
    if (!article) throw new Error(`Missing article: ${url}`);
    for (const br of article.querySelectorAll("br")) br.replaceWith("\n");
    let paragraphs = [...article.querySelectorAll("p")]
      .flatMap((p) => p.textContent.split(/\n+/))
      .map((p) => p.trim())
      .filter(Boolean);
    if (!paragraphs.length)
      paragraphs = article.textContent
        .split(/\n+/)
        .map((p) => p.trim())
        .filter(Boolean);
    if (!paragraphs.some((p) => /^第一条\s/.test(p))) {
      const pdf = [...article.querySelectorAll("a")].find((a) => /\.pdf/i.test(a.href));
      if (pdf) {
        const pdfUrl = new URL(pdf.getAttribute("href"), url).href;
        const result = await fetch(pdfUrl);
        if (!result.ok) throw new Error(`PDF HTTP ${result.status}`);
        const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
        const task = getDocument({ data: new Uint8Array(await result.arrayBuffer()) });
        try {
          const document = await task.promise;
          const lines = [];
          for (let page = 1; page <= document.numPages; page++) {
            const content = await (await document.getPage(page)).getTextContent();
            let line = "";
            for (const item of content.items) {
              if (!("str" in item)) continue;
              line += item.str;
              if (item.hasEOL) {
                lines.push(line.trim());
                line = "";
              }
            }
            if (line.trim()) lines.push(line.trim());
          }
          paragraphs = [];
          for (const line of lines.filter(
            (x) =>
              x &&
              !/^[-—－\s]*\d+[-—－\s]*$/.test(x) &&
              !/^(国家知识产权局规章|国家知识产权局发布)$/.test(x),
          )) {
            if (
              /^第[一二三四五六七八九十百]+[条章节]|^[（(][一二三四五六七八九十]+[）)]/.test(
                line,
              ) ||
              !paragraphs.length
            )
              paragraphs.push(line);
            else paragraphs[paragraphs.length - 1] += line;
          }
        } finally {
          await task.destroy();
        }
      }
    }
    return paragraphs.filter((p) => !p.startsWith("相关链接："));
  } finally {
    dom.window.close();
  }
}

const articleCounts = [32, 58, 13, 24, 44, 85, 20, 22, 10, 43, 36, 12, 22, 12];
const chineseNumber = (n) =>
  n < 10
    ? "一二三四五六七八九"[n - 1]
    : `${n < 20 ? "" : "一二三四五六七八九"[Math.floor(n / 10) - 1]}十${n % 10 ? "一二三四五六七八九"[(n % 10) - 1] : ""}`;
const results = await Promise.allSettled(
  sources.map(async (source, index) => {
    const paragraphs = await officialText(source.source);
    const articles = paragraphs.filter((p) => /^第[一二三四五六七八九十百]+条/.test(p));
    if (
      articles.length !== articleCounts[index] ||
      articles.some((p, i) => !p.startsWith(`第${chineseNumber(i + 1)}条`))
    )
      throw new Error(`${source.id}: incomplete body (${articles.length} articles)`);
    console.log(source.id, articles.length, articles.at(-1).slice(0, 180));
    return { ...source, checked: "2026-09-08", paragraphs };
  }),
);
for (const result of results) if (result.status === "rejected") console.error(result.reason);
if (results.some((r) => r.status === "rejected"))
  throw new Error("Import incomplete; no bundle written");
const documents = results.map((r) => r.value);
for (const [title, url] of [
  [
    "关于停征和调整部分专利收费的公告",
    "https://www.cnipa.gov.cn/art/2018/6/15/art_527_147400.html",
  ],
  [
    "关于调整专利收费减缴条件和商标注册收费标准的公告",
    "https://www.cnipa.gov.cn/art/2019/6/28/art_2073_143013.html",
  ],
  [
    "国家知识产权局关于调整部分专利收费标准和减缴政策的公告（第594号）",
    "https://www.cnipa.gov.cn/art/2024/8/6/art_74_194102.html",
  ],
]) {
  const paragraphs = await officialText(url);
  if (paragraphs.join("").length < 300) throw new Error(`Incomplete fee supplement: ${url}`);
  documents
    .find((x) => x.id === "fee-reduction")
    .paragraphs.push(title, `官方来源：${url}`, ...paragraphs);
}
await writeFile(
  new URL("../src/renderer/src/legislation/assets/additional.json", import.meta.url),
  `${JSON.stringify(documents, null, 2)}\n`,
);
await writeFile(
  new URL("../src/shared/legislation-extra.ts", import.meta.url),
  `// Official source metadata; regenerated by scripts/vendor-additional-legislation.mjs.\nexport const ADDITIONAL_LEGISLATION = ${JSON.stringify(sources, null, 2)} as const;\n`,
);
