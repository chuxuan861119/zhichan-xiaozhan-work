import { z } from "zod";

export const OFFICIAL_WEBSITES = [
  {
    id: "cnipa",
    label: "国家知识产权局",
    url: "https://www.cnipa.gov.cn/",
    group: "国内业务",
  },
  {
    id: "cponline",
    label: "专利业务办理系统",
    url: "https://cponline.cnipa.gov.cn/",
    group: "国内业务",
  },
  {
    id: "patent-login",
    label: "专利业务统一身份认证",
    url: "https://tysf.cponline.cnipa.gov.cn/am/#/user/login",
    group: "国内业务",
  },
  {
    id: "preexam",
    label: "专利预审管理平台",
    url: "https://cnippc.cn/ippc-web-dzsq/",
    group: "国内业务",
  },
  {
    id: "public-service",
    label: "知识产权公共服务平台",
    url: "https://ggfw.cnipa.gov.cn/",
    group: "国内业务",
  },
  {
    id: "public-login",
    label: "公共服务统一身份认证",
    url: "https://sso.cnipa.gov.cn/am/#/login",
    group: "国内业务",
  },
  {
    id: "search",
    label: "专利检索及分析",
    url: "https://pss-system.cponline.cnipa.gov.cn/conventionalSearch",
    group: "检索与资料",
  },
  {
    id: "query",
    label: "专利审查信息查询",
    url: "https://cpquery.cponline.cnipa.gov.cn/chinesepatent/index",
    group: "检索与资料",
  },
  {
    id: "publication",
    label: "专利公布公告",
    url: "https://epub.cnipa.gov.cn/",
    group: "检索与资料",
  },
  {
    id: "forms",
    label: "专利表格下载",
    url: "https://www.cnipa.gov.cn/col/col192/index.html",
    group: "检索与资料",
  },
  {
    id: "design-search",
    label: "外观设计专利检索",
    url: "https://d.cnipa.gov.cn/micro-portal/#/login",
    group: "检索与资料",
  },
  {
    id: "industry-patents",
    label: "重点产业专利信息",
    url: "https://chinaip.cnipa.gov.cn/chinaip/index.html",
    group: "检索与资料",
  },
  {
    id: "ip-data",
    label: "知识产权数据资源",
    url: "https://ipdps.cnipa.gov.cn/#/Login",
    group: "检索与资料",
  },
  {
    id: "acpaa",
    label: "中华全国专利代理师协会",
    url: "https://www.acpaa.cn/",
    group: "行业与国际",
  },
  {
    id: "nipso",
    label: "国家知识产权战略网",
    url: "https://www.nipso.cn/",
    group: "行业与国际",
  },
  {
    id: "exam",
    label: "专利代理师资格考试",
    url: "https://ggfw-dlsks.cnipa.gov.cn/",
    group: "行业与国际",
  },
  {
    id: "wipo",
    label: "国际专利检索（WIPO）",
    url: "https://patentscope.wipo.int/search/zh/search.jsf",
    group: "行业与国际",
  },
  {
    id: "epo",
    label: "全球专利检索（EPO）",
    url: "https://worldwide.espacenet.com/",
    group: "行业与国际",
  },
  {
    id: "ipc",
    label: "国际专利分类（IPC）",
    url: "https://ipcpub.wipo.int/",
    group: "行业与国际",
  },
] as const;

export const OfficialWebsiteIdSchema = z.enum([
  ...OFFICIAL_WEBSITES.map((site) => site.id),
  "work-home",
  "work-open-source",
]);
export type OfficialWebsiteId = z.infer<typeof OfficialWebsiteIdSchema>;
