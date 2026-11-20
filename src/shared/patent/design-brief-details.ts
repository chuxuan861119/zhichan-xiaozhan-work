import { z } from "zod";
import type { DesignPatent, DesignPatentBrief, DesignPatentIssue } from "./design-patent.js";

const text = (max: number) => z.string().max(max).default("");
const GuiSchema = z
  .object({
    kind: z.enum(["none", "static", "dynamic"]).default("none"),
    submission: z.enum(["with-product", "gui-only"]).default("with-product"),
    scope: z
      .enum(["interface-only", "interface-and-product", "interface-part"])
      .default("interface-only"),
    use: text(2000),
    product: text(1000),
    location: text(2000),
    interaction: text(4000),
    changeProcess: text(4000),
    frames: z.array(z.string().uuid()).max(200).default([]),
  })
  .strict();
export const DesignBriefDetailsSchema = z
  .object({
    productName: z.string().max(200).nullable().default(null),
    applicationType: z.enum(["single", "similar", "set", "component"]).default("single"),
    productForm: z.enum(["solid", "flat"]).default("solid"),
    pointDescription: text(2000),
    partialRepresentation: z.enum(["unspecified", "lines", "mask", "other"]).default("unspecified"),
    partialBoundary: z.boolean().default(false),
    partialUse: text(2000),
    gui: GuiSchema.default(() => GuiSchema.parse({})),
    groups: z
      .array(
        z
          .object({
            id: z.string().uuid(),
            name: z.string().max(100),
            viewIds: z.array(z.string().uuid()).max(1000),
          })
          .strict(),
      )
      .max(100)
      .default([]),
    basicDesignId: z.string().uuid().nullable().default(null),
    assembly: z.enum(["unspecified", "unique", "variable", "none"]).default("unspecified"),
    assemblyDescription: text(4000),
  })
  .strict();
export type DesignBriefDetails = z.infer<typeof DesignBriefDetailsSchema>;
export function getDesignBriefDetails(brief: DesignPatentBrief): DesignBriefDetails {
  return DesignBriefDetailsSchema.parse(
    brief.details ?? {
      ...(brief.guiDescription.trim() ? { gui: { kind: "static" } } : {}),
      ...(brief.setDescription.trim() ? { applicationType: "set" } : {}),
    },
  );
}
export function getDesignProductName(name: string | null, brief: DesignPatentBrief) {
  return (brief.details?.productName ?? name ?? "").trim();
}
const sentence = (value: string) => {
  const s = value.trim();
  return s ? (/[。！？；]$/.test(s) ? s : s + "。") : "";
};
export function designPointSentence(design: DesignPatent): string {
  const b = design.brief,
    d = getDesignBriefDetails(b),
    gui = b.details && d.gui.kind !== "none";
  const point =
    d.pointDescription.trim() ||
    b.designPoints.map((p) => ({ shape: "形状", pattern: "图案", color: "色彩" })[p]).join("和");
  if (gui) {
    const scope = {
      "interface-only": "仅在于图形用户界面",
      "interface-and-product": "在于图形用户界面及其所应用产品",
      "interface-part": "仅在于图形用户界面中的局部",
    }[d.gui.scope];
    return sentence(
      `设计要点${scope}${point ? `；${/设计要点/.test(point) ? point : `具体在于${point}`}` : ""}`,
    );
  }
  return point ? sentence(/设计要点/.test(point) ? point : `设计要点在于${point}`) : "";
}
function assigned(design: DesignPatent) {
  return design.views.filter(
    (v) => !["unassigned", "reference", "enlarged", "section", "other"].includes(v.kind),
  );
}
/** One application may contain multiple dynamic GUIs; never join different designs. */
export function getDesignGuiSequences(d: DesignBriefDetails) {
  if (d.applicationType === "single") return [{ name: "", frames: d.gui.frames }];
  const prefix = { similar: "设计", set: "套件", component: "构件" }[d.applicationType];
  return d.groups.map((g, i) => ({
    name: `${prefix}${i + 1}`,
    frames: d.gui.frames.filter((id) => g.viewIds.includes(id)),
  }));
}
export function renderAdvancedBriefLines(design: DesignPatent): string[] {
  if (!design.brief.details) return [];
  const d = getDesignBriefDetails(design.brief),
    views = new Map(assigned(design).map((v) => [v.viewId, v.label]));
  const lines: string[] = [];
  if (design.subject === "partial-design") {
    if (d.partialRepresentation === "lines")
      lines.push("视图中的实线表示请求保护的部分，虚线表示其他部分。");
    if (d.partialBoundary)
      lines.push(
        "视图中的点划线表示请求保护部分与其他部分的分界线，该分界线不属于请求保护的内容。",
      );
    if (d.partialUse.trim()) lines.push(sentence(`请求保护的局部的用途：${d.partialUse}`));
  }
  if (d.applicationType === "similar") {
    const base = d.groups.find((g) => g.id === d.basicDesignId);
    if (base?.name.trim())
      lines.push(sentence(`本申请包含${d.groups.length}项相似外观设计，基本设计为${base.name}`));
  }
  if (d.applicationType !== "single") {
    const prefix = { similar: "设计", set: "套件", component: "构件" }[d.applicationType];
    if (d.applicationType === "set") lines.push("本申请为成套产品的外观设计。");
    if (d.applicationType === "component" && d.assembly !== "unspecified")
      lines.push(
        `本申请为组件产品的外观设计，${{ unique: "组装关系唯一", variable: "组装关系不唯一", none: "各构件之间无组装关系" }[d.assembly]}。`,
      );
    for (const [i, g] of d.groups.entries()) {
      const pictures = g.viewIds.map((id) => views.get(id)).filter(Boolean);
      if (g.name.trim())
        lines.push(
          sentence(
            `${prefix}${i + 1}为${g.name}${pictures.length ? `，对应图片为${pictures.join("、")}` : ""}`,
          ),
        );
    }
    if (d.assemblyDescription.trim() && d.applicationType === "component")
      lines.push(sentence(d.assemblyDescription));
  }
  if (d.gui.kind !== "none") {
    if (d.gui.use.trim()) lines.push(sentence(`图形用户界面的用途：${d.gui.use}`));
    if (d.gui.product.trim()) lines.push(sentence(`该图形用户界面所应用的产品：${d.gui.product}`));
    if (d.gui.submission === "gui-only")
      lines.push("本申请以不带有所应用产品的图形用户界面视图提交。");
    if (d.gui.location.trim())
      lines.push(sentence(`图形用户界面在产品中的位置：${d.gui.location}`));
    if (d.gui.interaction.trim()) lines.push(sentence(`人机交互方式：${d.gui.interaction}`));
    if (d.gui.kind === "dynamic") {
      for (const sequence of getDesignGuiSequences(d)) {
        const frames = sequence.frames.map((id) => views.get(id)).filter(Boolean);
        if (frames.length)
          lines.push(
            sentence(
              `${sequence.name ? `${sequence.name}的` : ""}动态图形用户界面的变化状态依次为：${frames.join("→")}`,
            ),
          );
      }
      if (d.gui.changeProcess.trim())
        lines.push(sentence(`动态图形用户界面的变化过程：${d.gui.changeProcess}`));
    }
  }
  return lines;
}
export function inspectAdvancedBrief(
  design: DesignPatent,
  productName?: string | null,
): DesignPatentIssue[] {
  const b = design.brief,
    d = getDesignBriefDetails(b),
    issues: DesignPatentIssue[] = [],
    explicit = !!b.details;
  const add = (code: DesignPatentIssue["code"], message: string) => {
    const existing = issues.find((issue) => issue.code === code);
    if (existing) existing.message += ` ${message}`;
    else issues.push({ code, severity: "warning", message });
  };
  if (
    b.designPoints.includes("color") &&
    (!b.colorProtectionRequested ||
      (!b.designPoints.some((p) => p !== "color") && !d.pointDescription.trim()))
  )
    add(
      "invalid-design-color",
      "设计要点包含色彩时，请核对色彩与形状或图案的结合，以及简要说明中的色彩保护声明。",
    );
  else if (
    b.colorProtectionRequested &&
    !b.designPoints.includes("color") &&
    !d.pointDescription.includes("色彩")
  )
    add("invalid-design-color", "已请求保护色彩，但设计要点未包含色彩，请核对。");
  if (explicit && d.productName !== null && !d.productName.trim())
    add("invalid-design-brief-text", "请填写外观设计产品名称，并与请求书中的产品名称保持一致。");
  if (
    design.subject === "partial-design" &&
    !(explicit && d.partialRepresentation === "lines") &&
    !b.partialDesignDescription.trim()
  )
    add(
      "missing-partial-design-description",
      "请说明局部设计请求保护的部分及表示方式；已用实线与虚线明确表示的，可选择对应表示方式。",
    );
  if (!explicit) return issues;
  if (d.applicationType === "set" && design.subject === "partial-design")
    add(
      "invalid-brief-combination",
      "成套产品外观设计不包含局部外观设计，请核对申请类型与设计范围。",
    );
  if (
    d.gui.kind !== "none" &&
    d.gui.scope === "interface-part" &&
    design.subject !== "partial-design"
  )
    add("invalid-brief-combination", "GUI 保护范围为界面中的局部，请核对是否应采用局部外观设计。");
  if (
    d.gui.kind !== "none" &&
    d.gui.submission === "gui-only" &&
    d.gui.scope === "interface-and-product"
  )
    add(
      "invalid-brief-combination",
      "仅提交界面视图时，无法表达所应用产品的外观；请核对 GUI 设计要点范围与图片提交方式。",
    );
  if (
    d.gui.kind !== "none" &&
    design.subject === "partial-design" &&
    d.gui.scope === "interface-and-product"
  )
    add(
      "invalid-brief-combination",
      "局部外观设计的 GUI 设计要点应仅在于界面或界面中的局部；当前选择了“界面及其所应用产品”，请核对设计范围和 GUI 设计要点范围。",
    );
  if (
    d.gui.kind !== "none" &&
    design.subject === "whole-product" &&
    d.gui.submission === "gui-only"
  )
    add(
      "invalid-brief-combination",
      "不带有所应用产品的界面视图应按局部外观设计方式提交；当前选择了整体产品设计，请核对设计范围或 GUI 图片提交方式。",
    );
  const available = new Set(assigned(design).map((v) => v.viewId));
  if (d.applicationType !== "single") {
    const problems: string[] = [];
    if (d.groups.length < 2) problems.push("请至少添加两项设计／产品或构件");
    if (d.applicationType === "similar" && d.groups.length > 10)
      problems.push("同一产品的相似外观设计不得超过10项");
    if (new Set(d.groups.map((g) => g.id)).size !== d.groups.length) problems.push("分组编号重复");
    if (
      d.groups.some(
        (g) => !g.name.trim() || !g.viewIds.length || g.viewIds.some((id) => !available.has(id)),
      )
    )
      problems.push("各项名称和关联图片需完整；已删除、未分配或不参与导出的图片须重新选择");
    if (d.applicationType === "similar" && !d.groups.some((g) => g.id === d.basicDesignId))
      problems.push("请选择其中一项作为基本设计");
    const base = d.groups.find((g) => g.id === d.basicDesignId);
    if (
      d.applicationType === "similar" &&
      base &&
      design.representativeViewId &&
      !base.viewIds.includes(design.representativeViewId)
    )
      problems.push("代表图应选择基本设计的图片");
    const grouped = d.groups.flatMap((g) => g.viewIds);
    if (new Set(grouped).size !== grouped.length)
      problems.push("同一图片关联了多项设计／产品或构件，请核对各组图片");
    if (d.applicationType === "component" && d.assembly === "unspecified")
      problems.push("请说明组件产品的组装关系");
    if (problems.length) add("invalid-design-group", problems.join("；") + "。");
  }
  if (d.gui.kind !== "none") {
    const problems: string[] = [];
    if (!d.gui.use.trim()) problems.push("请填写图形用户界面的具体用途");
    if (!d.gui.product.trim())
      problems.push("请填写所应用的产品；不带产品提交时请核对“电子设备”等产品表述");
    if (d.gui.scope === "interface-part" && !d.partialUse.trim())
      problems.push("请填写请求保护的 GUI 局部的用途，不能仅以整个界面的用途代替");
    if (d.gui.kind === "dynamic") {
      const name = getDesignProductName(productName ?? null, b);
      if (name && !name.includes("动态"))
        problems.push("动态图形用户界面的产品名称应包含“动态”字样，请核对申报产品名称");
      if (!d.gui.changeProcess.trim()) problems.push("请填写动态变化过程");
      if (
        d.gui.frames.length < 2 ||
        new Set(d.gui.frames).size !== d.gui.frames.length ||
        d.gui.frames.some((id) => !available.has(id))
      )
        problems.push("请按起始状态和后续变化顺序关联至少两张有效图片，不能重复或引用失效图片");
      if (d.applicationType !== "single") {
        const sequences = getDesignGuiSequences(d);
        if (
          sequences.some(
            (s) =>
              (d.applicationType === "similar" || s.frames.length > 0) &&
              s.frames.filter((id) => available.has(id)).length < 2,
          )
        )
          problems.push(
            "每项涉及动态 GUI 的设计／产品或构件须分别关联起始状态及后续变化状态；相似设计的各项均应完整",
          );
        if (d.gui.frames.some((id) => !d.groups.some((g) => g.viewIds.includes(id))))
          problems.push("部分 GUI 状态图片尚未关联到设计／产品或构件分组");
      }
      const labels = new Map(assigned(design).map((v) => [v.viewId, v.label]));
      const namingProblems: string[] = [];
      for (const sequence of getDesignGuiSequences(d)) {
        sequence.frames.forEach((id, index) => {
          const label = labels.get(id);
          if (label === undefined) return; // Stale references are reported above, never silently removed.
          const normalized = label.normalize("NFKC").replace(/\s+/gu, "");
          const number = /变化状态图(?:\(([1-9]\d*)\)|([1-9]\d*))$/u.exec(normalized);
          const valid =
            index === 0
              ? normalized.endsWith("主视图")
              : !!number && Number(number[1] ?? number[2]) === index;
          if (!valid)
            namingProblems.push(
              `${sequence.name ? `${sequence.name}：` : ""}“${label}”应核对为${index === 0 ? "起始状态的“主视图”" : `“变化状态图${index}”`}`,
            );
        });
      }
      if (namingProblems.length)
        problems.push(
          `请在第一步按各项 GUI 的变化顺序核对图片名称：${namingProblems.slice(0, 5).join("；")}${namingProblems.length > 5 ? `；另有 ${namingProblems.length - 5} 张待核对` : ""}。检查不会自动改名或重排图片`,
        );
    }
    if (problems.length) add("incomplete-gui-brief", problems.join("；") + "。");
  }
  return issues;
}
