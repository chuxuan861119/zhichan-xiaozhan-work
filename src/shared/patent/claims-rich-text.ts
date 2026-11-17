import { z } from "zod";
import {
  HardBreakNodeSchema,
  type ParagraphAttributes,
  ParagraphAttributesSchema,
  type TextMark,
  TextNodeSchema,
} from "../document/model.js";

export const ClaimsRichParagraphsSchema = z
  .array(
    z
      .object({
        attrs: ParagraphAttributesSchema,
        content: z.array(z.union([TextNodeSchema, HardBreakNodeSchema])).max(200_000),
      })
      .strict(),
  )
  .max(200_000)
  .refine(
    (paragraphs) =>
      paragraphs.reduce(
        (total, p) =>
          total +
          p.content.reduce((n, run) => n + (run.type === "text" ? run.text.length : 1), 0) +
          1,
        0,
      ) <=
      2 * 1024 * 1024,
    "转换内容超过剪贴板大小限制",
  );
export type ClaimsRichParagraph = z.infer<typeof ClaimsRichParagraphsSchema>[number];
export type DraftSpan = {
  text: string;
  marks: TextMark[];
  attrs: ParagraphAttributes;
  paragraphBreak?: boolean;
  hardBreak?: boolean;
};

export function sliceDraft(spans: DraftSpan[], start: number, end = Infinity): DraftSpan[] {
  const result: DraftSpan[] = [];
  let offset = 0;
  for (const span of spans) {
    const from = Math.max(0, start - offset);
    const to = Math.min(span.text.length, end - offset);
    if (to > from) result.push({ ...span, text: span.text.slice(from, to) });
    offset += span.text.length;
    if (offset >= end) break;
  }
  return result;
}

export function replaceDraft(
  spans: DraftSpan[],
  edits: { start: number; length: number; text: string }[],
): DraftSpan[] {
  const result: DraftSpan[] = [];
  let cursor = 0;
  let spanIndex = 0;
  let innerOffset = 0;
  const consume = (end: number, keep: boolean) => {
    while (spanIndex < spans.length && cursor < end) {
      const span = spans[spanIndex]!;
      const length = Math.min(span.text.length - innerOffset, end - cursor);
      if (keep && length > 0)
        result.push({ ...span, text: span.text.slice(innerOffset, innerOffset + length) });
      cursor += length;
      innerOffset += length;
      if (innerOffset === span.text.length) {
        spanIndex++;
        innerOffset = 0;
      }
    }
  };
  for (const edit of edits) {
    consume(edit.start, true);
    const style = spans[spanIndex] ?? spans[0];
    if (edit.text && style) result.push({ ...style, text: edit.text, paragraphBreak: false });
    consume(edit.start + edit.length, false);
  }
  consume(Infinity, true);
  return result;
}

export function draftParagraphs(spans: DraftSpan[]): ClaimsRichParagraph[] {
  const first = spans[0];
  if (!first) return [];
  const result: ClaimsRichParagraph[] = [{ attrs: { ...first.attrs }, content: [] }];
  for (const span of spans) {
    if (span.paragraphBreak) {
      result.push({ attrs: { ...span.attrs }, content: [] });
      continue;
    }
    if (span.hardBreak) {
      result[result.length - 1]!.content.push({ type: "hard-break" });
      continue;
    }
    result[result.length - 1]!.content.push({
      type: "text",
      text: span.text,
      marks: span.marks
        .filter((m) => m.type !== "reference-mark-token" && m.type !== "claim-reference-review")
        .map((m) => ({ ...m })),
    });
  }
  return result;
}

const escapeHtml = (text: string) =>
  text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
const font = (value: string) =>
  `'${Array.from(value, (c) => (/[\p{L}\p{N} -]/u.test(c) ? c : `\\${c.codePointAt(0)!.toString(16)} `)).join("")}'`;

/** Serialize only validated document styles, never renderer-provided HTML. */
export function richDraftClipboardFormats(paragraphs: ClaimsRichParagraph[]): {
  text: string;
  html: string;
} {
  const validated = ClaimsRichParagraphsSchema.parse(paragraphs);
  const text = validated
    .map((p) => p.content.map((r) => (r.type === "text" ? r.text : "\n")).join(""))
    .join("\n");
  const html = validated
    .map(({ attrs, content }) => {
      const paragraphStyle = `white-space:pre-wrap;margin:0;color:#000000;text-align:${attrs.alignment};text-indent:${attrs.paragraphIndentMm}mm;line-height:${attrs.lineSpacing};font-family:${font(attrs.defaultFontFamily)};font-size:${attrs.defaultFontSizePt}pt`;
      const body = content
        .map((run) => {
          if (run.type === "hard-break") return "<br>";
          const styles = run.marks.flatMap((mark) => {
            switch (mark.type) {
              case "bold":
                return ["font-weight:700"];
              case "italic":
                return ["font-style:italic"];
              case "underline":
                return ["text-decoration:underline"];
              case "superscript":
                return ["vertical-align:super"];
              case "subscript":
                return ["vertical-align:sub"];
              case "font-family":
                return [`font-family:${font(mark.value)}`];
              case "font-size":
                return [`font-size:${mark.valuePt}pt`];
              case "color":
                return [`color:${mark.value}`];
              case "background-color":
                return [`background-color:${mark.value}`];
              default:
                return [];
            }
          });
          let text = escapeHtml(run.text);
          if (run.marks.some((m) => m.type === "superscript")) text = `<sup>${text}</sup>`;
          if (run.marks.some((m) => m.type === "subscript")) text = `<sub>${text}</sub>`;
          return `<span style="${escapeHtml(styles.join(";"))}">${text}</span>`;
        })
        .join("");
      return `<p style="${escapeHtml(paragraphStyle)}">${body || "<br>"}</p>`;
    })
    .join("");
  return { text, html };
}
