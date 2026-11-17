import { useState } from "react";
import law from "./assets/law.json";
import rules from "./assets/rules.json";

type Article = {
  document: "law" | "rules";
  article: string;
  title: string;
  reference: string;
  badges: string[];
  group: string;
};

// Curated by examination topic, not by measured citation frequency.
export const COMMON_ARTICLES: Article[] = [
  {
    document: "law",
    article: "第二十二条",
    reference: "第二款至第四款",
    title: "新颖性、创造性与实用性",
    badges: ["22.2", "22.3", "22.4"],
    group: "授权条件",
  },
  {
    document: "law",
    article: "第二十六条",
    reference: "第三款、第四款",
    title: "充分公开、支持与清楚简要",
    badges: ["26.3", "26.4"],
    group: "授权条件",
  },
  {
    document: "rules",
    article: "第二十三条",
    reference: "第二款",
    title: "必要技术特征",
    badges: ["23.2"],
    group: "授权条件",
  },
  {
    document: "law",
    article: "第三十一条",
    reference: "第一款",
    title: "单一性",
    badges: ["31.1"],
    group: "授权条件",
  },
  {
    document: "rules",
    article: "第三十九条",
    reference: "",
    title: "共同的特定技术特征",
    badges: ["39"],
    group: "授权条件",
  },
  {
    document: "law",
    article: "第二条",
    reference: "第二款、第三款",
    title: "技术方案与实用新型保护客体",
    badges: ["2.2", "2.3"],
    group: "保护客体",
  },
  {
    document: "law",
    article: "第二十五条",
    reference: "",
    title: "不授予专利权的客体",
    badges: ["25"],
    group: "保护客体",
  },
  {
    document: "law",
    article: "第五条",
    reference: "",
    title: "法律、社会公德与公共利益",
    badges: ["5"],
    group: "保护客体",
  },
  {
    document: "law",
    article: "第九条",
    reference: "",
    title: "重复授权与先申请原则",
    badges: ["9"],
    group: "保护客体",
  },
  {
    document: "rules",
    article: "第十一条",
    reference: "",
    title: "诚实信用与真实发明活动",
    badges: ["11"],
    group: "保护客体",
  },
  {
    document: "rules",
    article: "第二十条",
    reference: "",
    title: "说明书结构与撰写",
    badges: ["20"],
    group: "撰写规范",
  },
  {
    document: "rules",
    article: "第二十一条",
    reference: "",
    title: "附图编号与标记一致",
    badges: ["21"],
    group: "撰写规范",
  },
  {
    document: "rules",
    article: "第二十二条",
    reference: "",
    title: "权利要求术语、编号与附图标记",
    badges: ["22"],
    group: "撰写规范",
  },
  {
    document: "rules",
    article: "第二十四条",
    reference: "",
    title: "独立权利要求写法",
    badges: ["24"],
    group: "撰写规范",
  },
  {
    document: "rules",
    article: "第二十五条",
    reference: "",
    title: "从属引用与多项从属",
    badges: ["25"],
    group: "撰写规范",
  },
  {
    document: "rules",
    article: "第二十六条",
    reference: "",
    title: "摘要及摘要附图",
    badges: ["26"],
    group: "撰写规范",
  },
  {
    document: "law",
    article: "第三十三条",
    reference: "",
    title: "修改不得超范围",
    badges: ["33"],
    group: "修改与答复",
  },
  {
    document: "rules",
    article: "第五十七条",
    reference: "第三款",
    title: "针对通知书指出的缺陷修改",
    badges: ["57.3"],
    group: "修改与答复",
  },
  {
    document: "rules",
    article: "第五十八条",
    reference: "",
    title: "修改替换页",
    badges: ["58"],
    group: "修改与答复",
  },
  {
    document: "law",
    article: "第三十七条",
    reference: "",
    title: "审查意见答复",
    badges: ["37"],
    group: "修改与答复",
  },
  {
    document: "rules",
    article: "第五十九条",
    reference: "",
    title: "实质审查驳回情形",
    badges: ["59"],
    group: "修改与答复",
  },
];

export function articleParagraphs(document: "law" | "rules", article: string): string[] {
  const paragraphs = (document === "law" ? law : rules).paragraphs;
  const start = paragraphs.findIndex((p) => p.startsWith(`${article}　`));
  if (start < 0) throw new Error(`Missing bundled legislation article: ${document}/${article}`);
  let end = start + 1;
  while (
    end < paragraphs.length &&
    !/^第[零一二三四五六七八九十百]+[条章]/.test(paragraphs[end] ?? "")
  )
    end++;
  return paragraphs.slice(start, end);
}

export function CommonArticles({
  onOpen,
}: {
  onOpen(document: "law" | "rules", article: string): void;
}) {
  const [group, setGroup] = useState("全部");
  return (
    <section className="legislation-common" aria-label="常用法条">
      <p className="legislation-common__note">
        按发明、实用新型常见审查问题整理，非引用频率排名。具体适用以通知书、现行法及案件事实为准。旧通知书中的细则条号可能不同。
      </p>
      <nav className="legislation-common__filters" aria-label="审查问题分类">
        {["全部", ...new Set(COMMON_ARTICLES.map((item) => item.group))].map((name) => (
          <button
            type="button"
            key={name}
            aria-pressed={group === name}
            onClick={() => setGroup(name)}
          >
            {name}
          </button>
        ))}
      </nav>
      <div className="legislation-common__list">
        {COMMON_ARTICLES.filter((item) => group === "全部" || item.group === group).map((item) => {
          const citation = `${item.document === "law" ? "专利法" : "实施细则"}${item.article}`;
          return (
            <section className="legislation-common__card" key={`${item.document}-${item.article}`}>
              <h3>{item.title}</h3>
              <span className="legislation-common__citation">
                {citation}
                {item.reference}
              </span>
              <div className="legislation-common__badges">
                {item.badges.map((badge) => (
                  <span
                    className="legislation-common__badge"
                    key={badge}
                    title={`${citation}${item.reference}`}
                  >
                    {badge}
                  </span>
                ))}
              </div>
              <details className="spatial-disclosure" open>
                <summary>本条原文</summary>
                {articleParagraphs(item.document, item.article).map((text) => (
                  <p key={text}>{text}</p>
                ))}
              </details>
              <button
                type="button"
                aria-label={`查看原文：${citation}`}
                className="legislation-common__locate"
                onClick={() => onOpen(item.document, item.article)}
              >
                在法规中定位 →
              </button>
            </section>
          );
        })}
      </div>
    </section>
  );
}
