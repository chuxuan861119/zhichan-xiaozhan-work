import { z } from "zod";
import { ADDITIONAL_LEGISLATION } from "./legislation-extra.js";

export const LegislationActionSchema = z
  .object({
    id: z.enum(["law", "rules", "guidelines", ...ADDITIONAL_LEGISLATION.map((item) => item.id)]),
    action: z.enum(["source", "save"]),
  })
  .strict();

export const LEGISLATION = [
  {
    id: "law",
    short: "专利法",
    title: "中华人民共和国专利法",
    version: "2020年修正",
    effective: "2021-06-01",
    source: "https://www.cnipa.gov.cn/art/2020/11/23/art_97_155167.html",
  },
  {
    id: "rules",
    short: "实施细则",
    title: "中华人民共和国专利法实施细则",
    version: "2023年修订",
    effective: "2024-01-20",
    source: "https://www.cnipa.gov.cn/art/2023/12/21/art_98_189197.html",
  },
  {
    id: "guidelines",
    short: "审查指南",
    title: "专利审查指南",
    version: "2023版（2025年修订）",
    effective: "2026-01-01",
    source: "https://www.cnipa.gov.cn/art/2025/11/14/art_99_202568.html",
  },
  ...ADDITIONAL_LEGISLATION,
] as const;
export type LegislationId = (typeof LEGISLATION)[number]["id"];
export const LEGISLATION_CHECKED = "2026-09-08";
