import type { InspectionRuleProvenance } from "./types.js";

export const OFFICIAL_SOURCES = {
  implementingRegulations2023: {
    basisLabel: "中华人民共和国专利法实施细则（2023年修订）",
    basisUrl: "https://www.cnipa.gov.cn/art/2023/12/21/art_98_189197.html",
    effectiveFrom: null,
  },
  examinationGuidelines2023: {
    basisLabel: "专利审查指南（2023）",
    basisUrl:
      "https://www.cnipa.gov.cn/module/download/downfile.jsp?classid=0&filename=5753f257e6a04b6f8e305eb6d34ba452.pdf&showname=%E4%B8%93%E5%88%A9%E5%AE%A1%E6%9F%A5%E6%8C%87%E5%8D%97.pdf",
    effectiveFrom: null,
  },
  order84: {
    basisLabel: "国家知识产权局令第八十四号",
    basisUrl: "https://www.cnipa.gov.cn/art/2025/11/13/art_99_202568.html",
    effectiveFrom: "2026-01-01",
  },
} as const;

export const OFFICIAL_RULE = (
  source: (typeof OFFICIAL_SOURCES)[keyof typeof OFFICIAL_SOURCES],
  reference: string,
): InspectionRuleProvenance => ({
  authority: "official",
  basisLabel: source.basisLabel,
  reference,
  basisUrl: source.basisUrl,
  effectiveFrom: source.effectiveFrom,
});

export const PRODUCT_POLICY = {
  exactObjectName: {
    authority: "product-policy",
    basisLabel: "知产小栈Work：具体对象名称严格一致策略",
    reference: null,
    basisUrl: null,
    effectiveFrom: "2026-08-15",
  },
  claimPunctuation: {
    authority: "product-policy",
    basisLabel: "知产小栈Work：权利要求分段句末策略",
    reference: null,
    basisUrl: null,
    effectiveFrom: "2026-08-15",
  },
  exportSafety: {
    authority: "product-policy",
    basisLabel: "知产小栈Work：导出安全策略",
    reference: null,
    basisUrl: null,
    effectiveFrom: "2026-08-15",
  },
} as const satisfies Record<string, InspectionRuleProvenance>;

export const HEURISTIC_RULE: InspectionRuleProvenance = {
  authority: "heuristic",
  basisLabel: "软件启发式候选",
  reference: null,
  basisUrl: null,
  effectiveFrom: null,
};
